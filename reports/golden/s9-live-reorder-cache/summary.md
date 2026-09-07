# Golden run — s9-live-reorder-cache

2026-09-07T03:38:29.334Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

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
| tokens / accepted edit | 58478 |
| tier-priced cost / accepted edit (not billed) | $0.022 |
| model calls / turn p50 · p95 | 3 · 3 |
| tool calls / turn p50 · p95 | 2 · 2 |
| first progress p50 · p95 | 3.6s · 5.2s |
| done p50 · p95 | 12.5s · 14.2s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 3 | 1.00 | 100% | 100% | 100% | 3 | 65812 | $0.02 | 12.8s |
| reorder-swap-first-two | reorder | 3 | 1.00 | 100% | 100% | 100% | 3 | 72322 | $0.02 | 12.5s |
