# Golden run — s9-live-reorder-fix1

2026-09-06T21:20:53.181Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

2 case(s), 6 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 100% |
| target resolution | 83% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 83% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 5 |
| tokens / accepted edit | 144025 |
| tier-priced cost / accepted edit (not billed) | $0.136 |
| model calls / turn p50 · p95 | 5 · 7 |
| tool calls / turn p50 · p95 | 7 · 9 |
| first progress p50 · p95 | 4.0s · 6.1s |
| done p50 · p95 | 30.2s · 45.0s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 1.00 | 100% | 67% | 100% | 5 | 118960 | $0.11 | 30.2s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 100% | 100% | 100% | 5 | 102724 | $0.10 | 31.0s |
