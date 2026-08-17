# Foundation real-provider eval output

`pnpm eval:agent:foundation:real` (see `.github/workflows/foundation-real-eval.yml`) writes
timestamped capture files here, plus a stable `latest.json` pointer. See
`docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md` for what this run does and does not prove.

Generated JSON files in this directory are **not** committed automatically — the workflow
uploads them as a build artifact only. If you want a specific capture checked in as evidence,
download the artifact and add the file to this directory in its own reviewed commit.
