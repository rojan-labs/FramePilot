#!/usr/bin/env node
/**
 * Export baseline (plan/system-mission P0.5): render the two export fixture projects through
 * the sidecar exactly as the desktop does (POST /render → poll /render/jobs/{id}), sampling
 * the sidecar's python process and its ffmpeg children (RSS, %CPU) once a second, and record
 * stage timings, output ffprobe, and the ffmpeg command line the sidecar logged.
 *
 * Usage: node scripts/mission-export-baseline.mjs [--out reports/system-mission/baseline-export.json] [--sidecar-log <path>] [--preset reels]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter(Boolean));
const BASE_URL = process.env.FRAMEPILOT_PYTHON_API_URL ?? 'http://127.0.0.1:8799';
const OUT = resolve(REPO, String(args.out ?? 'reports/system-mission/baseline-export.json'));
const LOG = args['sidecar-log'] ? resolve(String(args['sidecar-log'])) : null;
const PROJECTS = ['mission-export-30s', 'mission-export-60s'];

const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8' }); } catch { return ''; } };
function sidecarPids() {
  const lines = sh('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command=']).split('\n').filter(Boolean);
  const rows = lines.map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l); return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], cpu: +m[4], cmd: m[5] }; }).filter(Boolean);
  const python = rows.filter((r) => /framepilot(\s|$)/.test(r.cmd) && /python/.test(r.cmd));
  const uv = rows.filter((r) => /uv run framepilot serve/.test(r.cmd));
  const roots = new Set([...python, ...uv].map((r) => r.pid));
  const kids = rows.filter((r) => roots.has(r.ppid));
  const ffmpeg = rows.filter((r) => /ffmpeg|ffprobe/.test(r.cmd) && (roots.has(r.ppid) || kids.some((k) => k.pid === r.ppid)));
  return { python, ffmpeg };
}
async function post(path, body) { const r = await fetch(BASE_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.json(); }
async function get(path) { const r = await fetch(BASE_URL + path); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); }

const results = [];
for (const id of PROJECTS) {
  const t0 = Date.now();
  const logOffset = LOG ? readFileSync(LOG, 'utf8').length : 0;
  const accepted = await post('/render', { project_path: `${id}.fp.json`, ...(args.preset ? { preset: String(args.preset) } : {}) });
  const jobId = accepted.jobId ?? accepted.job_id ?? accepted.id ?? accepted.job?.id;
  const stages = [];
  const samples = [];
  let last = null;
  let job;
  for (;;) {
    job = await get(`/render/jobs/${jobId}`);
    const state = job.result?.state && job.status === 'running' ? job.result.state : job.status;
    if (state !== last) { stages.push({ state, atMs: Date.now() - t0 }); last = state; }
    const p = sidecarPids();
    samples.push({ atMs: Date.now() - t0, pythonRssMb: +(p.python.reduce((s, r) => s + r.rssKb, 0) / 1024).toFixed(1), pythonCpu: +p.python.reduce((s, r) => s + r.cpu, 0).toFixed(0), ffmpegCount: p.ffmpeg.length, ffmpegRssMb: +(p.ffmpeg.reduce((s, r) => s + r.rssKb, 0) / 1024).toFixed(1), ffmpegCpu: +p.ffmpeg.reduce((s, r) => s + r.cpu, 0).toFixed(0), progress: job.result?.progress ?? null });
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const wallMs = Date.now() - t0;
  const outputPath = job.result?.output_path ?? job.result?.outputPath ?? null;
  let probe = null;
  if (outputPath) {
    const abs = outputPath.startsWith('/') ? outputPath : join(REPO, 'tests/fixtures/mission/projects', outputPath);
    probe = sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate', '-of', 'json', abs]);
    try { probe = JSON.parse(probe); } catch { /* keep raw */ }
  }
  let ffmpegCmd = null;
  if (LOG) {
    const tail = readFileSync(LOG, 'utf8').slice(logOffset);
    const m = tail.match(/ffmpeg[^\n]*-i[^\n]*/g);
    ffmpegCmd = m ? m.slice(0, 3) : null;
  }
  const peak = (k) => Math.max(0, ...samples.map((s) => s[k]));
  results.push({ project: id, jobId, wallMs, stages, finalState: last, error: job.error ?? job.result?.error ?? null, outputPath, probe, peakPythonRssMb: peak('pythonRssMb'), peakFfmpegRssMb: peak('ffmpegRssMb'), maxFfmpegConcurrent: peak('ffmpegCount'), avgFfmpegCpu: +(samples.reduce((s, x) => s + x.ffmpegCpu, 0) / Math.max(1, samples.length)).toFixed(0), samples, ffmpegCmd, validation: job.result?.validation ?? null });
  console.log(`${id}: ${last} in ${(wallMs / 1000).toFixed(1)}s; stages ${stages.map((s) => `${s.state}@${(s.atMs / 1000).toFixed(1)}s`).join(' → ')}; peak ffmpeg RSS ${peak('ffmpegRssMb')} MB, python ${peak('pythonRssMb')} MB, ffmpeg cpu avg ${results.at(-1).avgFfmpegCpu}%`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`wrote ${OUT}`);
