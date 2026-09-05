# Golden run — session3

2026-09-05T01:48:00.754Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

10 case(s), 37 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 78% |
| target resolution | 77% |
| boundary precision | 95% |
| operation validity | 100% |
| first-pass acceptance | 70% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 26 |
| tokens / accepted edit | 225145 |
| tier-priced cost / accepted edit (not billed) | $0.529 |
| model calls / turn p50 · p95 | 6 · 12 |
| tool calls / turn p50 · p95 | 7 · 22 |
| first progress p50 · p95 | 3.2s · 6.0s |
| done p50 · p95 | 105.8s · 1980.4s |
| failure quality | 7 failure(s): 7 loud, 1 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 3 | 1.00 | 100% | 100% | 100% | 6 | 109107 | $0.23 | 85.4s |
| podcast-highlight-60s | highlight | 3 | 1.00 | 67% | 67% | 100% | 5 | 100027 | $0.36 | 77.5s |
| remove-dead-air | silence | 3 | 1.00 | 100% | 100% | 100% | 3 | 108737 | $0.14 | 20.3s |
| beat-sync | beat | 3 | 1.00 | 100% | 100% | 100% | 7 | 163853 | $0.38 | 170.3s |
| refine-tighten | pacing | 3 | 1.00 | 100% | 67% | 100% | 6 | 126019 | $0.64 | 277.7s |
| memory-captions | memory | 3 | 1.00 | 67% | 56% | 100% | 9 | 195934 | $1.31 | 896.7s |
| trim-first-clip-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 4 | 101570 | $0.10 | 31.4s |
| trim-opening-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 4 | 86427 | $0.10 | 34.9s |
| reorder-last-first | reorder | 3 | 0.70 | 0% | 0% | 100% | 3 | 66417 | $0.09 | 1692.8s |
| reorder-swap-first-two | reorder | 1 | 1.00 | 0% | 0% | 100% | 6 | 99746 | $0.17 | 1965.1s |
