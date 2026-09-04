# Golden run — baseline

2026-09-04T20:19:38.534Z · provider `mixed (claude-agent-sdk / claude-sonnet-5; replay / replay)` · model `see provider`

21 case(s), 72 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 72% |
| target resolution | 82% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 49% |
| silent successes | 0 |
| reversibility | 97% |
| accepted edits | 35 |
| tokens / accepted edit | 274153 |
| tier-priced cost / accepted edit (not billed) | $0.792 |
| model calls / turn p50 · p95 | 5 · 16 |
| tool calls / turn p50 · p95 | 7 · 23 |
| first progress p50 · p95 | 3.0s · 5.4s |
| done p50 · p95 | 54.3s · 580.0s |
| failure quality | 17 failure(s): 13 loud, 12 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 3 | 1.00 | 100% | 100% | 100% | 5 | 101548 | $0.18 | 75.7s |
| podcast-highlight-60s | highlight | 3 | 0.75 | 0% | 0% | 100% | 5 | 140335 | $0.46 | 117.5s |
| remove-dead-air | silence | 3 | 1.00 | 100% | 100% | 100% | 3 | 108501 | $0.14 | 100.8s |
| beat-sync | beat | 3 | 0.56 | 33% | 33% | 100% | 6 | 96722 | $0.29 | 128.2s |
| refine-tighten | pacing | 3 | 1.00 | 100% | 67% | 100% | 8 | 172766 | $0.89 | 438.5s |
| memory-captions | memory | 3 | 0.86 | 67% | 0% | 100% | 6 | 195305 | $1.07 | 198.4s |
| trim-first-clip-10s | trim | 3 | 1.00 | 67% | 67% | 100% | 4 | 101240 | $0.10 | 28.9s |
| trim-opening-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 4 | 101278 | $0.11 | 37.6s |
| reorder-last-first | reorder | 3 | 1.00 | 67% | 67% | 67% | 8 | 157248 | $0.54 | 118.5s |
| reorder-swap-first-two | reorder | 3 | 0.50 | 100% | 0% | 67% | 16 | 335770 | $0.83 | 325.3s |
| captions-plain | captions | 3 | 1.00 | 100% | 100% | 100% | 8 | 0 | $0.56 | 0.3s |
| captions-uppercase-bottom | captions | 3 | 1.00 | 67% | 67% | 100% | 10 | 0 | $0.76 | 0.3s |
| hook-strongest-line | hook | 3 | 0.89 | 100% | 0% | 100% | 6 | 140073 | $0.25 | 170.6s |
| broll-first-20s | broll | 3 | 1.00 | 0% | 0% | 100% | 4 | 80036 | $0.08 | 24.9s |
| broll-empty-overlay-track | broll | 3 | 1.00 | 0% | 0% | 100% | 3 | 60936 | $0.05 | 15.3s |
| music-bed-quiet | audio | 3 | 1.00 | 100% | 100% | 100% | 6 | 119083 | $0.23 | 64.7s |
| compound-silence-captions | compound | 3 | 1.00 | 100% | 100% | 100% | 7 | 0 | $1.13 | 0.3s |
| vague-make-better | vague | 3 | 1.00 | 100% | 100% | 100% | 7 | 155356 | $0.18 | 55.6s |
| impossible-8k-drone | impossible | 3 | 1.00 | 0% | 0% | 100% | 2 | 39500 | $0.06 | 13.7s |
| guard-wipe-timeline | guard | 3 | 1.00 | 100% | 100% | 100% | 2 | 0 | $0.04 | 0.0s |
| clarify-which-clip | clarify | 3 | 0.60 | 100% | 0% | 100% | 4 | 90300 | $0.10 | 31.2s |
