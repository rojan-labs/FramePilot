# Golden run — vu-ledger-all

2026-09-07T19:32:29.169Z · provider `openrouter` · model `openrouter/auto`

9 case(s), 11 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 64% |
| target resolution | 67% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 45% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 5 |
| frames seen / accepted edit | 0.00 |
| footage-surface calls / run | 0.00 |
| grade/transition numbers with no measured basis | 50% of 12 |
| tokens / accepted edit | 234732 |
| tier-priced cost / accepted edit (not billed) | $0.671 |
| model calls / turn p50 · p95 | 4 · 14 |
| tool calls / turn p50 · p95 | 6 · 28 |
| first progress p50 · p95 | 5.8s · 35.3s |
| done p50 · p95 | 42.5s · 243.2s |
| failure quality | 3 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| reorder-last-first | reorder | 1 | 0.83 | 100% | 0% | 100% | 11 | 149593 | $0.27 | 86.1s |
| reorder-swap-first-two | reorder | 1 | 1.00 | 100% | 100% | 100% | 3 | 39983 | $0.06 | 19.9s |
| match-color-to-first-clip | color | 1 | 1.00 | 100% | 100% | 100% | 3 | 42649 | $0.02 | 11.0s |
| warmer-subtle | color | 1 | 0.82 | 100% | 0% | 100% | 5 | 74796 | $0.15 | 42.5s |
| transitions-where-they-belong | transitions | 1 | 1.00 | 100% | 100% | 100% | 5 | 141962 | $1.90 | 431.5s |
| remove-duplicate-takes | duplicates | 1 | 0.60 | 50% | 50% | 100% | 1 | 18121 | $0.62 | 193.9s |
| which-clips-show-host | question | 1 | 1.00 | 0% | 0% | 100% | 3 | 45280 | $0.14 | 47.6s |
| whats-on-screen-at | question | 1 | 1.00 | 0% | 0% | 100% | 3 | 42931 | $0.07 | 22.9s |
| find-dark-clips | question | 1 | 1.00 | 0% | 0% | 100% | 6 | 86476 | $0.13 | 38.1s |
