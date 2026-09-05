# Golden run — s7-clarify-fix

2026-09-05T18:00:26.212Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

2 case(s), 2 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 0% |
| target resolution | 50% |
| boundary precision | 100% |
| operation validity | — |
| first-pass acceptance | 0% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 0 |
| tokens / accepted edit | — |
| tier-priced cost / accepted edit (not billed) | — |
| model calls / turn p50 · p95 | 1 · 1 |
| tool calls / turn p50 · p95 | 1 · 1 |
| first progress p50 · p95 | 3.1s · 3.9s |
| done p50 · p95 | 7.1s · 8.0s |
| failure quality | 2 failure(s): 2 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| guard-wipe-timeline | guard | 1 | 0.43 | 0% | 0% | 100% | 1 | 28095 | $0.02 | 8.0s |
| clarify-which-clip | clarify | 1 | 1.00 | 0% | 0% | 100% | 1 | 28125 | $0.02 | 7.1s |
