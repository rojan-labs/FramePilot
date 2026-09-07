# Golden run — s9-live-all

2026-09-07T03:36:36.339Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

21 case(s), 24 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 88% |
| target resolution | 100% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 88% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 21 |
| tokens / accepted edit | 128790 |
| tier-priced cost / accepted edit (not billed) | $0.232 |
| model calls / turn p50 · p95 | 4 · 10 |
| tool calls / turn p50 · p95 | 3 · 14 |
| first progress p50 · p95 | 3.3s · 5.9s |
| done p50 · p95 | 30.5s · 124.4s |
| failure quality | 3 failure(s): 3 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 1 | 1.00 | 100% | 100% | 100% | 4 | 71929 | $0.14 | 59.9s |
| podcast-highlight-60s | highlight | 1 | 1.00 | 100% | 100% | 100% | 7 | 136354 | $0.29 | 111.0s |
| remove-dead-air | silence | 1 | 1.00 | 100% | 100% | 100% | 4 | 70797 | $0.15 | 19.9s |
| beat-sync | beat | 1 | 0.33 | 0% | 0% | 100% | 2 | 36464 | $0.07 | 27.3s |
| refine-tighten | pacing | 1 | 1.00 | 100% | 100% | 100% | 5 | 97771 | $0.88 | 407.9s |
| memory-captions | memory | 1 | 1.00 | 100% | 100% | 100% | 6 | 130469 | $0.67 | 183.5s |
| trim-first-clip-10s | trim | 1 | 1.00 | 100% | 100% | 100% | 2 | 32491 | $0.04 | 8.1s |
| trim-opening-10s | trim | 1 | 1.00 | 100% | 100% | 100% | 2 | 33000 | $0.04 | 14.3s |
| reorder-last-first | reorder | 1 | 1.00 | 100% | 100% | 100% | 3 | 82509 | $0.05 | 12.7s |
| reorder-swap-first-two | reorder | 1 | 1.00 | 100% | 100% | 100% | 4 | 88598 | $0.10 | 30.5s |
| captions-plain | captions | 1 | 1.00 | 100% | 100% | 100% | 8 | 318156 | $0.56 | 52.0s |
| captions-uppercase-bottom | captions | 1 | 1.00 | 100% | 100% | 100% | 10 | 412821 | $0.74 | 62.0s |
| hook-strongest-line | hook | 1 | 1.00 | 100% | 100% | 100% | 4 | 57521 | $0.07 | 51.4s |
| broll-first-20s | broll | 1 | 1.00 | 100% | 100% | 100% | 3 | 44870 | $0.03 | 18.6s |
| broll-empty-overlay-track | broll | 1 | 1.00 | 100% | 100% | 100% | 2 | 24651 | $0.02 | 15.6s |
| music-bed-quiet | audio | 1 | 1.00 | 100% | 100% | 100% | 6 | 87553 | $0.10 | 53.7s |
| compound-silence-captions | compound | 1 | 1.00 | 100% | 100% | 100% | 9 | 403958 | $0.68 | 54.8s |
| vague-make-better | vague | 1 | 1.00 | 100% | 100% | 100% | 10 | 147180 | $0.21 | 124.4s |
| impossible-8k-drone | impossible | 1 | 1.00 | 0% | 0% | 100% | 1 | 1878 | $0.01 | 10.5s |
| guard-wipe-timeline | guard | 1 | 1.00 | 100% | 100% | 100% | 2 | 25063 | $0.01 | 8.4s |
| clarify-which-clip | clarify | 1 | 1.00 | 0% | 0% | 100% | 1 | 13250 | $0.01 | 6.7s |
