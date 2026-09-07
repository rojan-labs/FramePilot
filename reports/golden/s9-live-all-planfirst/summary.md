# Golden run — s9-live-all-planfirst

2026-09-07T04:16:39.932Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

4 case(s), 4 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 25% |
| target resolution | — |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 25% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 1 |
| tokens / accepted edit | 839655 |
| tier-priced cost / accepted edit (not billed) | $1.537 |
| model calls / turn p50 · p95 | 6 · 16 |
| tool calls / turn p50 · p95 | 4 · 17 |
| first progress p50 · p95 | 16.4s · 43.6s |
| done p50 · p95 | 110.2s · 197.4s |
| failure quality | 2 failure(s): 2 loud, 2 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1 | 1.00 | 0% | 0% | 100% | 6 | 91093 | $0.16 | 124.6s |
| podcast-highlight-60s | highlight | 1 | 1.00 | 0% | 0% | 100% | 16 | 554038 | $1.01 | 197.4s |
| remove-dead-air | silence | 1 | 1.00 | 0% | 0% | 100% | 6 | 99275 | $0.19 | 42.4s |
| beat-sync | beat | 1 | 1.00 | 100% | 100% | 100% | 6 | 95249 | $0.18 | 110.2s |
