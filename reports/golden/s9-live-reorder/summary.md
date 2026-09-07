# Golden run — s9-live-reorder

2026-09-06T21:12:17.878Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

2 case(s), 6 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 83% |
| target resolution | 50% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 33% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 2 |
| tokens / accepted edit | 387363 |
| tier-priced cost / accepted edit (not billed) | $0.499 |
| model calls / turn p50 · p95 | 5 · 11 |
| tool calls / turn p50 · p95 | 6 · 12 |
| first progress p50 · p95 | 3.4s · 4.3s |
| done p50 · p95 | 48.8s · 107.1s |
| failure quality | 1 failure(s): 1 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 0.80 | 67% | 0% | 100% | 9 | 186746 | $0.22 | 64.9s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 100% | 67% | 100% | 5 | 105821 | $0.13 | 48.8s |
