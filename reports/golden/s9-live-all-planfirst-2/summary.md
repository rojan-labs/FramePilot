# Golden run — s9-live-all-planfirst-2

2026-09-07T04:45:52.931Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

15 case(s), 18 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 89% |
| target resolution | 80% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 89% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 16 |
| **turns the provider never answered** | **6 — excluded from every rate above; re-run them** |
| tokens / accepted edit | 214822 |
| tier-priced cost / accepted edit (not billed) | $0.207 |
| model calls / turn p50 · p95 | 6 · 38 |
| tool calls / turn p50 · p95 | 4 · 38 |
| first progress p50 · p95 | 21.3s · 65.9s |
| done p50 · p95 | 55.5s · 289.3s |
| failure quality | 1 failure(s): 1 loud, 1 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1 | 1.00 | 100% | 100% | 100% | 11 | 195186 | $0.28 | 162.4s |
| podcast-highlight-60s | highlight | 1 | 1.00 | 100% | 100% | 100% | 12 | 211637 | $0.18 | 143.6s |
| remove-dead-air | silence | 1 | 1.00 | 100% | 100% | 100% | 6 | 99687 | $0.19 | 55.5s |
| beat-sync | beat | 1 | 1.00 | 100% | 100% | 100% | 7 | 106947 | $0.17 | 107.3s |
| refine-tighten | pacing | 1 | 1.00 | 100% | 100% | 100% | 5 | 65481 | $0.23 | 209.9s |
| memory-captions | memory | 1 | 1.00 | 100% | 100% | 100% | 16 | 417584 | $1.58 | 601.5s |
| trim-first-clip-10s | trim | 1 | 1.00 | 100% | 100% | 100% | 3 | 30003 | $0.02 | 10.6s |
| trim-opening-10s | trim | 1 | 0.78 | 0% | 0% | 100% | 6 | 80336 | $0.08 | 53.9s |
| reorder-last-first | reorder | 1 | 1.00 | 100% | 100% | 100% | 3 | 30916 | $0.02 | 20.7s |
| reorder-swap-first-two | reorder | 1 | 1.00 | 100% | 100% | 100% | 3 | 30519 | $0.02 | 15.5s |
| captions-plain | captions | 1 | 1.00 | 100% | 100% | 100% | 10 | 264669 | $0.23 | 71.0s |
| captions-uppercase-bottom | captions | 1 | 1.00 | 100% | 100% | 100% | 9 | 244730 | $0.17 | 58.1s |
| hook-strongest-line | hook | 1 | 1.00 | 100% | 100% | 100% | 10 | 179753 | $0.11 | 118.8s |
| broll-first-20s | broll | 1 | 1.00 | 100% | 100% | 100% | 5 | 66045 | $0.04 | 53.7s |
| broll-empty-overlay-track | broll | 1 | 0.60 | 0% | 0% | 100% | 2 | 7073 | $0.00 | 31.6s |
