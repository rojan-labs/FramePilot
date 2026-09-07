# Golden run — s9-live-reorder-planfirst

2026-09-07T03:48:24.672Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

2 case(s), 6 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 0% |
| target resolution | 100% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 0% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 0 |
| tokens / accepted edit | — |
| tier-priced cost / accepted edit (not billed) | — |
| model calls / turn p50 · p95 | 4 · 6 |
| tool calls / turn p50 · p95 | 1 · 4 |
| first progress p50 · p95 | 9.7s · 14.8s |
| done p50 · p95 | 21.9s · 35.6s |
| failure quality | 6 failure(s): 6 loud, 6 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 1.00 | 0% | 0% | 100% | 4 | 40320 | $0.03 | 19.9s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 0% | 0% | 100% | 5 | 58820 | $0.04 | 28.2s |
