# Build a RELOCATABLE Capability Pack artifact for win32-x64.
#
# THIS IS THE WINDOWS COUNTERPART OF scripts/build-capability-pack.sh. Read that script's
# header first: same manifest, same models.lock.toml, same staged contract
# (payload / finalize / all), same "prove it, don't assert it" relocated health check, same
# size cap and content-digest rules. This file exists because the POSIX script cannot run
# on Windows (`uv venv --relocatable`'s console-script layout, path separators, `cc`,
# `codesign`, `zip -X`, `chmod` and symlink handling are all POSIX-specific), NOT because
# the pack's distribution contract is different on this platform.
#
# WRITTEN, NOT PROVEN. This script was authored by direct translation of the bash script's
# invariants and reviewed for syntax; it has never run on a Windows machine. The workflow
# job that would run it (`.github/workflows/capability-pack-release.yml`, `build-windows-x64`)
# is wired and gated exactly like the macOS job, so the first real `windows-latest` run is
# the proof this script does not yet have. Treat every claim below as "should" until then.
#
# WHY NO CUSTOM NATIVE LAUNCHER (unlike macOS): `scripts/pack-launcher/launcher.c` exists
# because a macOS shell script's codesign signature lives in extended attributes, which a
# ZIP install drops. A Windows Authenticode signature is embedded in the PE file itself
# (the certificate table), so it survives a ZIP round-trip with no help. uv's Windows
# console-script entrypoint is already a real PE launcher (distlib's `t64.exe` stub with the
# script data appended), so signing it directly with `signtool` is sufficient — no
# replacement step is needed here, and none is attempted.
#
# WHAT THIS DELIBERATELY DOES NOT DO: sign with Authenticode or publish. Those need a
# certificate and a distribution decision; see capability-pack-release.yml's
# `build-windows-x64` job, gated on WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD exactly as the
# macOS job is gated on MAC_CERT_P12 / CSC_NAME.
#
# Usage: pwsh scripts/build-capability-pack.ps1 <pack> [outdir] [-Stage all|payload|finalize]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('tracking-lite', 'subject-intelligence', 'visual-embed', 'visual-describe')]
    [string]$Pack,

    [Parameter(Position = 1)]
    [string]$OutDir,

    [ValidateSet('all', 'payload', 'finalize')]
    [string]$Stage = 'all'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkerDir = Join-Path $RepoRoot "workers/$Pack"
$Manifest = Join-Path $WorkerDir 'pack/manifest.toml'
$ModelsLock = Join-Path $WorkerDir 'pack/models.lock.toml'
if (-not (Test-Path $Manifest)) {
    throw "No pack manifest at $Manifest"
}

if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist/capability-packs' }
$BuildDir = Join-Path $OutDir $Pack
$Payload = Join-Path $BuildDir 'payload'

$Os = 'win32'
$Arch = 'x64'

# The manifest is the authority for identity; never restate these in the script (same
# rule as the POSIX script). Read with tomllib rather than line-oriented regex, because
# `entrypoint` appears once per `[[platforms]]` table and only the win32 row's value is
# ours — a plain "first match wins" regex (what the POSIX script uses, correctly, because
# darwin is always listed first there) would silently pick the DARWIN entrypoint here.
# Written to a temp file rather than piped through `python3 -c`, because a PowerShell
# here-string with nested quoting is a poor place to hold a multi-line Python program.
$parserPath = Join-Path ([System.IO.Path]::GetTempPath()) 'framepilot-pack-manifest-reader.py'
@'
import json
import sys
import tomllib

manifest_path, models_lock_path = sys.argv[1], sys.argv[2]
doc = tomllib.load(open(manifest_path, "rb"))
pack = doc["pack"]
win32 = next(p for p in doc["platforms"] if p["os"] == "win32")
print(json.dumps({
    "id": pack["id"],
    "version": pack["version"],
    "pythonVersion": doc["runtime"]["python_version"],
    "capabilities": pack["capabilities"],
    "maxUnpackedMib": doc.get("artifact", {}).get("max_unpacked_mib"),
    "entrypoint": win32["entrypoint"],
}))
'@ | Set-Content -Path $parserPath -Encoding utf8

$manifestInfo = (& python3 $parserPath $Manifest $ModelsLock | ConvertFrom-Json)
Remove-Item -Force $parserPath -ErrorAction SilentlyContinue

$PackId = $manifestInfo.id
$Version = $manifestInfo.version
$PyVersion = $manifestInfo.pythonVersion
$MaxMib = $manifestInfo.maxUnpackedMib
$Capabilities = ($manifestInfo.capabilities | ConvertTo-Json -Compress -AsArray)
$EntrypointExe = $manifestInfo.entrypoint

$Archive = Join-Path $BuildDir "$PackId-$Version-$Os-$Arch.zip"

function Copy-Tree($From, $To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
}

function Get-PayloadBytes {
    $total = 0
    Get-ChildItem -Path $Payload -Recurse -File | ForEach-Object { $total += $_.Length }
    return $total
}

function Build-Payload {
    Write-Host "Building $PackId $Version payload for $Os-$Arch"
    if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
    New-Item -ItemType Directory -Force -Path $Payload | Out-Null

    # (1) Relocatable. On Windows uv already copies (never symlinks) the console-script
    # launcher and the interpreter into the venv, so there is no shell-wrapper analogue to
    # replace — see the header note on why no native launcher is built here.
    & uv venv --relocatable --python $PyVersion $Payload
    if ($LASTEXITCODE -ne 0) { throw 'uv venv failed' }
    Push-Location $WorkerDir
    try {
        $env:UV_PROJECT_ENVIRONMENT = $Payload
        & uv sync --extra cv --no-dev --locked
        if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }
    } finally {
        Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
        Pop-Location
    }

    # (2) Vendor the worker itself, non-editable, and strip PEP 610 provenance naming the
    # build directory — nothing imports it.
    $pythonExe = Join-Path $Payload 'Scripts/python.exe'
    & $pythonExe -m pip install --no-deps --force-reinstall --no-build-isolation $WorkerDir
    if ($LASTEXITCODE -ne 0) { throw 'vendoring the worker failed' }
    Get-ChildItem -Path $Payload -Recurse -Filter 'direct_url.json' | Remove-Item -Force

    # (3) Vendor the interpreter's own directory (python.exe, pythonXY.dll, DLLs\, Lib\)
    # rather than only the venv, then drop pyvenv.cfg. uv's Windows Python distributions
    # (python-build-standalone "install_only" layout) already ship python.exe beside its
    # DLL and the standard library in one self-contained directory named by pyvenv.cfg's
    # `home`; the venv's Scripts\python.exe is a copy of that interpreter but the DLL and
    # Lib\ it needs at runtime are NOT copied into the venv by uv venv itself, exactly the
    # gap the POSIX script's header describes for macOS/Linux.
    $pyvenvCfg = Join-Path $Payload 'pyvenv.cfg'
    $homeLine = Select-String -Path $pyvenvCfg -Pattern '^home = (.*)$' | Select-Object -First 1
    if (-not $homeLine) { throw "no 'home' line in $pyvenvCfg" }
    $pythonHome = $homeLine.Matches[0].Groups[1].Value.Trim()
    if (-not (Test-Path (Join-Path $pythonHome 'python.exe'))) {
        throw "FAIL: no interpreter directory at $pythonHome"
    }
    if (-not (Test-Path (Join-Path $pythonHome 'Lib/os.py'))) {
        throw "FAIL: no standard library at $pythonHome/Lib"
    }
    Copy-Item -Path (Join-Path $pythonHome 'python.exe') -Destination (Join-Path $Payload 'Scripts/python.exe') -Force
    Copy-Item -Path (Join-Path $pythonHome 'python3*.dll') -Destination (Join-Path $Payload 'Scripts') -Force
    if (Test-Path (Join-Path $pythonHome 'DLLs')) {
        Copy-Tree (Join-Path $pythonHome 'DLLs') (Join-Path $Payload 'Scripts/DLLs')
    }
    $stdlibExcludes = @('site-packages', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'test', '__pycache__')
    New-Item -ItemType Directory -Force -Path (Join-Path $Payload 'Lib') | Out-Null
    Get-ChildItem -Path (Join-Path $pythonHome 'Lib') -Force | Where-Object { $stdlibExcludes -notcontains $_.Name } |
        ForEach-Object { Copy-Item -Path $_.FullName -Destination (Join-Path $Payload 'Lib') -Recurse -Force }
    Remove-Item $pyvenvCfg -Force

    # (4) Strip what never runs in a worker: every console-script exe except the
    # entrypoint, uv's cache marker, bytecode caches, and test suites shipped inside wheels.
    Get-ChildItem -Path (Join-Path $Payload 'Scripts') -Filter '*.exe' |
        Where-Object { $_.Name -ne "$EntrypointExe" -and $_.Name -ne 'python.exe' } |
        Remove-Item -Force
    Remove-Item -Path (Join-Path $Payload 'CACHEDIR.TAG') -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $Payload -Recurse -Directory -Filter '__pycache__' |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
    $sitePackages = Join-Path $Payload 'Lib/site-packages'
    if (Test-Path $sitePackages) {
        Get-ChildItem -Path $sitePackages -Recurse -Directory -Filter 'tests' |
            ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
    }

    # (5) Pinned model weights, for the packs that ship them. `fetch_models.py` verifies
    # each file against `pack/models.lock.toml`.
    $fetchModels = Join-Path $WorkerDir 'tools/fetch_models.py'
    if (Test-Path $fetchModels) {
        Write-Host 'Fetching pinned model weights...'
        Push-Location $WorkerDir
        try {
            & $pythonExe -B tools/fetch_models.py
            if ($LASTEXITCODE -ne 0) { throw 'fetch_models.py failed' }
        } finally {
            Pop-Location
        }
        $modelsDir = Join-Path $Payload 'models'
        New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
        $pinnedNames = & $pythonExe -B -c @'
import sys, tomllib
lock = tomllib.load(open(sys.argv[1], "rb"))
for model in lock["model"]:
    print(model["file"])
for archive in lock.get("archive", []):
    for alias in archive.get("links", {}):
        print(alias)
'@ $ModelsLock
        foreach ($name in $pinnedNames) {
            if (-not $name) { continue }
            Copy-Item -Path (Join-Path $WorkerDir "models/$name") -Destination (Join-Path $modelsDir $name) -Force
        }
    }

    Assert-Standalone
}

function Assert-Standalone {
    $needles = @($RepoRoot, "$env:USERPROFILE\.local\share\uv")
    $leaks = Get-ChildItem -Path $Payload -Recurse -File | Where-Object {
        $content = $null
        try { $content = Get-Content -Raw -ErrorAction Stop $_.FullName } catch { return $false }
        foreach ($needle in $needles) {
            if ($content -and $content.Contains($needle)) { return $true }
        }
        return $false
    }
    if ($leaks) {
        Write-Error 'FAIL: the built payload still references a build-machine path (repo or uv Python dir):'
        $leaks | ForEach-Object { Write-Error $_.FullName }
        throw 'standalone assertion failed'
    }
    if (Test-Path (Join-Path $Payload 'pyvenv.cfg')) {
        throw 'FAIL: pyvenv.cfg survived; the interpreter would resolve outside the payload.'
    }
}

function Invoke-HealthCheck {
    $proof = Join-Path $BuildDir 'relocated-proof'
    if (Test-Path $proof) { Remove-Item -Recurse -Force $proof }
    Move-Item -Path $Payload -Destination $proof
    Write-Host 'Relocation + health check against the built payload...'
    try {
        $proofPython = Join-Path $proof 'Scripts/python.exe'
        $checkScript = @'
import os, sys, encodings
root = os.path.realpath(sys.argv[1])
outside = [p for p in [sys.prefix, sys.base_prefix, encodings.__file__, *sys.path]
           if p and not os.path.realpath(p).startswith(root + os.sep) and os.path.realpath(p) != root]
if outside:
    sys.exit(f"FAIL: import roots outside the payload: {outside}")
print(f"standalone: prefix={sys.prefix} stdlib={os.path.dirname(encodings.__file__)}", file=sys.stderr)
'@
        & $proofPython -c $checkScript $proof
        if ($LASTEXITCODE -ne 0) { throw 'relocated import-root check failed' }

        $env:FRAMEPILOT_CAPABILITY_PACK_ROOT = $proof
        $env:FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK = '1'
        $env:FRAMEPILOT_CAPABILITY_PACK_NETWORK = 'disabled'
        $env:FRAMEPILOT_CAPABILITY_PACK_ID = $PackId
        $env:FRAMEPILOT_CAPABILITY_PACK_VERSION = $Version
        $env:FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST = ('0' * 64)
        $env:FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES = ($Capabilities -replace '\s', '')
        $entrypointPath = Join-Path $proof "Scripts/$EntrypointExe"
        $handshakeFile = Join-Path $BuildDir 'handshake.json'
        & $entrypointPath '--framepilot-health-check' 2> (Join-Path $BuildDir 'health-check.stderr') 1> $handshakeFile
        if ($LASTEXITCODE -ne 0) {
            Write-Error 'FAIL: the built payload does not pass its own health check:'
            Get-Content $handshakeFile, (Join-Path $BuildDir 'health-check.stderr') | Write-Error
            throw 'health check failed'
        }
        if (-not (Select-String -Path $handshakeFile -Pattern '"type":"handshake"' -Quiet)) {
            throw 'FAIL: the health check exited 0 without a handshake'
        }
        Write-Host "  handshake $((Get-Content $handshakeFile -Raw).Substring(0, [Math]::Min(160, (Get-Content $handshakeFile -Raw).Length)))..."
    } finally {
        foreach ($name in @(
            'FRAMEPILOT_CAPABILITY_PACK_ROOT', 'FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK',
            'FRAMEPILOT_CAPABILITY_PACK_NETWORK', 'FRAMEPILOT_CAPABILITY_PACK_ID',
            'FRAMEPILOT_CAPABILITY_PACK_VERSION', 'FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST',
            'FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES'
        )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
        if ((Test-Path $proof) -and -not (Test-Path $Payload)) {
            Move-Item -Path $proof -Destination $Payload
        }
    }
}

function Enforce-SizeCap {
    $script:UnpackedBytes = Get-PayloadBytes
    $script:UnpackedMib = [Math]::Ceiling($UnpackedBytes / 1048576)
    Write-Host "  unpacked  $UnpackedMib MiB ($UnpackedBytes bytes, cap $(if ($MaxMib) { $MaxMib } else { 'none' }))"
    if ($MaxMib -and $UnpackedMib -gt $MaxMib) {
        throw "FAIL: unpacked $UnpackedMib MiB exceeds the manifest's max_unpacked_mib ($MaxMib)."
    }
}

function Complete-Build {
    if (-not (Test-Path (Join-Path $Payload 'Scripts/python.exe'))) {
        throw "No built payload at $Payload; run -Stage payload first."
    }
    Assert-Standalone
    Enforce-SizeCap

    $files = Get-ChildItem -Path $Payload -Recurse -File | Sort-Object { $_.FullName.Replace($Payload, '') }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $digestLines = foreach ($file in $files) {
        $hash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLower()
        "$hash  $($file.FullName.Substring($Payload.Length + 1).Replace('\', '/'))"
    }
    $joined = [string]::Join("`n", $digestLines) + "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $artifactDigest = ([System.BitConverter]::ToString($sha256.ComputeHash($bytes)) -replace '-', '').ToLower()

    if (Test-Path $Archive) { Remove-Item -Force $Archive }
    Compress-Archive -Path (Join-Path $Payload '*') -DestinationPath $Archive -CompressionLevel Optimal

    $receipt = [ordered]@{
        packId           = $PackId
        version          = $Version
        os               = $Os
        arch             = $Arch
        entrypoint       = "Scripts/$EntrypointExe"
        capabilities     = $manifestInfo.capabilities
        archive          = (Split-Path -Leaf $Archive)
        format           = 'zip'
        contentDigest    = $artifactDigest
        unpackedBytes    = $UnpackedBytes
        unpackedMib      = $UnpackedMib
        maxUnpackedMib   = $MaxMib
        relocatable      = $true
        interpreterVendored = $true
        stdlibVendored   = $true
    }
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $BuildDir 'build-receipt.json')

    Write-Host ''
    Write-Host "  artifact  $Archive"
    Write-Host "  content   $artifactDigest"
    Write-Host "  receipt   $BuildDir/build-receipt.json"
    Write-Host ''
    Write-Host 'Signing state is NOT recorded here: the release job, which holds the credentials,'
    Write-Host "is the only place that can truthfully say whether it signed; see [platforms].signing in $Manifest."
}

switch ($Stage) {
    'payload' { Build-Payload; Invoke-HealthCheck; Enforce-SizeCap }
    'finalize' { Invoke-HealthCheck; Complete-Build }
    'all' { Build-Payload; Invoke-HealthCheck; Complete-Build }
}
