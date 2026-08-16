# GitHub public-repository operations

This runbook defines the GitHub-facing guardrails for the public `rojan-labs/FramePilot` repository. It keeps public-repository benefits useful without turning automation into a second product or creating merge/release traps.

## Repository automation committed in source

The repository should keep these behaviors reviewable as code:

- `CI` remains the primary correctness gate for TypeScript, Python, rendered proofs, E2E, visual regression, licensing, and desktop builds.
- `Dependency Review` rejects pull requests that introduce high-severity vulnerable dependencies.
- `CodeQL` scans JavaScript/TypeScript and Python on pull requests, pushes to `main`, and a weekly schedule using the `security-extended` query suite.
- `Dependabot` checks pnpm, uv, and GitHub Actions weekly. npm minor/patch updates are grouped; npm majors remain explicit maintainer decisions. Dependabot never auto-merges.
- `.github/copilot-instructions.md` points GitHub Copilot and Copilot code review back to the canonical `AGENTS.md` and `.agents/` rules instead of creating another instruction system.
- Issue chooser configuration routes vulnerabilities to private security advisories rather than public issues.

Automation rules:

1. Pull-request workflows receive least-privilege `GITHUB_TOKEN` permissions.
2. Fork pull requests must never receive repository secrets.
3. Checkout uses `persist-credentials: false` unless a job has a documented reason to push with Git credentials.
4. New third-party actions require a supply-chain review. Prefer GitHub-authored or verified actions and let Dependabot keep action references current.
5. No bot receives permission to merge, publish a release, modify source, close community discussions, or rotate secrets without a separate maintainer decision.
6. Release automation remains human-reviewed. Security automation may block unsafe merges, but it must not silently change product code.

## GitHub settings to enable safely

These are repository settings rather than files and should be enabled in GitHub after this PR merges:

- **Dependency graph**.
- **Dependabot alerts** and **Dependabot security updates**.
- **Private vulnerability reporting** so `SECURITY.md` and the issue chooser have a private destination.
- **Secret scanning** for the public repository.
- **Code scanning alerts** for the committed CodeQL workflow. If GitHub default setup is already enabled, choose one CodeQL setup and remove the duplicate rather than running both.
- Keep Actions' default workflow token permission at **read repository contents**. Grant writes only inside a workflow that requires them.

## Community and discoverability

Recommended public-repository surface:

- Enable **Discussions** once the maintainer is ready to moderate it. Suggested categories: `Announcements`, `Ideas`, `Q&A`, and `Show and tell`.
- Keep Issues for actionable bugs and scoped feature requests. Use Discussions for open-ended product conversation.
- Keep repository docs as the source of truth. The GitHub Wiki is currently enabled, but maintaining a second documentation tree will drift. Prefer disabling Wiki after confirming there is no content that needs migration.
- GitHub Pages is not required while the product website has its own deployment. Enable it only for a concrete documentation or demo use case.
- Add focused repository topics once positioning is stable, for example `video-editor`, `ai-video-editing`, `electron`, `typescript`, `python`, `ffmpeg`, and `local-first`. Topics are public positioning, so review them before applying.

## Approval-gated settings

The following changes improve safety or maintenance but can block normal development or releases. Do not apply them without explicit maintainer approval.

### Main branch ruleset

Recommended target: `main`.

- Require a pull request before merging.
- Require conversation resolution.
- Block force pushes and branch deletion.
- Require the existing CI checks plus Dependency Review and CodeQL after their exact check names are observed on this repository.
- Require CODEOWNERS review only if the maintainer wants every security/release-sensitive change to wait for an explicit review. On a solo-maintained repository this can create self-review friction.
- Do not require signed commits until the maintainer confirms every local, web, bot, and agent commit path is signing correctly.
- Do not require linear history until the maintainer chooses a single merge strategy.

Create bypass access only for the repository owner or an emergency-maintainer role. Keep bypass use auditable and exceptional.

### Release tag ruleset

Recommended target: `v*` tags.

Protect release tags from deletion and force-updates. This reduces supply-chain risk, but it also makes correcting a bad tag a deliberate recovery process.

### Merge behavior

Potential cleanup settings:

- Enable **Automatically delete head branches** after merge.
- Enable **Allow auto-merge** only for maintainer-approved PRs that still must satisfy required checks.
- Enable **Always suggest updating pull request branches** if the team wants contributors to rebase/update before merge.
- Consider squash-only merges for a compact public history. Changing allowed merge methods affects contributor workflow and should be explicit.

### Push protection

Enable secret-scanning push protection after the maintainer accepts that a false positive can temporarily block a push until it is reviewed or bypassed with a recorded reason.

### Release environments

A protected `release` environment with required reviewers can prevent accidental publication or update-feed deployment. It also intentionally adds a human gate to every release, so enable it only after the release workflow is ready to consume an environment safely.

## Features intentionally not added automatically

- **Stale issue/PR bots:** automatic closing often damages a young project's contributor experience and hides valid long-running work.
- **Automatic dependency merging:** dependency updates can change Electron, media, rendering, packaging, or AI-provider behavior. CI is necessary but not sufficient authority for merging them.
- **Automatic release publishing:** FramePilot installers and update feeds remain review-before-publish surfaces.
- **Broad write-token bots:** labeling or housekeeping convenience is not worth handing a third-party action write access by default.
- **Duplicate CodeQL setups:** advanced workflow and default setup should not both run unless there is a measured reason.

## Periodic maintenance

Monthly:

- Review Dependabot and code-scanning alerts.
- Review Actions dependencies and remove unused workflows.
- Check whether required status checks still match the actual workflow check names.
- Review repository topics, issue templates, and contribution docs for stale claims.
- Audit ruleset bypasses and release permissions.

Before each release:

- Resolve or explicitly accept relevant high/critical dependency and code-scanning alerts.
- Confirm release secrets are scoped only to release jobs.
- Smoke-test release artifacts using the existing release checklist before publishing the draft release.
