# Golden run — s9-live-reorder-planfirst-fix

2026-09-07T03:53:25.341Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

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
| tokens / accepted edit | 39236 |
| tier-priced cost / accepted edit (not billed) | $0.024 |
| model calls / turn p50 · p95 | 3 · 5 |
| tool calls / turn p50 · p95 | 1 · 2 |
| first progress p50 · p95 | 5.6s · 12.0s |
| done p50 · p95 | 20.2s · 36.8s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 1.00 | 100% | 100% | 100% | 3 | 30090 | $0.02 | 20.2s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 100% | 100% | 100% | 5 | 57581 | $0.04 | 20.2s |
