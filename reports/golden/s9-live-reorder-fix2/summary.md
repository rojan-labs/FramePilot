# Golden run — s9-live-reorder-fix2

2026-09-06T21:22:26.233Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

2 case(s), 6 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 100% |
| target resolution | 100% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 100% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 6 |
| tokens / accepted edit | 73362 |
| tier-priced cost / accepted edit (not billed) | $0.049 |
| model calls / turn p50 · p95 | 3 · 3 |
| tool calls / turn p50 · p95 | 2 · 2 |
| first progress p50 · p95 | 3.6s · 3.8s |
| done p50 · p95 | 11.4s · 22.6s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 1.00 | 100% | 100% | 100% | 3 | 82522 | $0.05 | 11.4s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 100% | 100% | 100% | 3 | 82465 | $0.05 | 13.1s |
