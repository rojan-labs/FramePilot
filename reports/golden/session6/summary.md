# Golden run — session6

2026-09-05T12:06:33.412Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

5 case(s), 15 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 73% |
| target resolution | 67% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 67% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 10 |
| tokens / accepted edit | 336542 |
| tier-priced cost / accepted edit (not billed) | $0.617 |
| model calls / turn p50 · p95 | 7 · 49 |
| tool calls / turn p50 · p95 | 9 · 49 |
| first progress p50 · p95 | 3.3s · 4.8s |
| done p50 · p95 | 48.0s · 816.8s |
| failure quality | 0 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trim-first-clip-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 4 | 84285 | $0.09 | 26.8s |
| trim-opening-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 5 | 102519 | $0.12 | 35.3s |
| reorder-last-first | reorder | 3 | 0.60 | 67% | 33% | 100% | 7 | 125032 | $0.32 | 151.0s |
| reorder-swap-first-two | reorder | 3 | 0.60 | 0% | 0% | 100% | 10 | 202712 | $0.35 | 150.9s |
| captions-plain | captions | 3 | 1.00 | 100% | 100% | 100% | 8 | 346302 | $0.57 | 48.0s |
