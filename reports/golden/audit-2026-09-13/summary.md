# Golden run — audit-2026-09-13

2026-09-13T10:12:12.693Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

4 case(s), 4 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 100% |
| target resolution | 100% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 100% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 4 |
| frames seen / accepted edit | 0.00 |
| footage-surface calls / run | 0.00 |
| grade/transition numbers with no measured basis | 0% of 1 |
| tokens / accepted edit | 86990 |
| tier-priced cost / accepted edit (not billed) | $0.000 |
| model calls / turn p50 · p95 | 3 · 10 |
| tool calls / turn p50 · p95 | 2 · 11 |
| first progress p50 · p95 | 2.8s · 11.7s |
| done p50 · p95 | 12.7s · 67.0s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1 | 1.00 | 100% | 100% | 100% | 3 | 28145 | $0.00 | 67.0s |
| trim-first-clip-10s | trim | 1 | 1.00 | 100% | 100% | 100% | 2 | 26765 | $0.00 | 6.6s |
| captions-plain | captions | 1 | 1.00 | 100% | 100% | 100% | 10 | 274646 | $0.00 | 63.6s |
| match-color-to-first-clip | color | 1 | 1.00 | 100% | 100% | 100% | 3 | 18402 | $0.00 | 12.7s |
