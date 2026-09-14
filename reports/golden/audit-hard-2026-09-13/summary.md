# Golden run — audit-hard-2026-09-13

2026-09-13T11:23:49.934Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

13 case(s), 15 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 60% |
| target resolution | 85% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 53% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 7 |
| frames seen / accepted edit | 0.00 |
| footage-surface calls / run | 0.00 |
| grade/transition numbers with no measured basis | 0% of 6 |
| tokens / accepted edit | 121804 |
| tier-priced cost / accepted edit (not billed) | — |
| model calls / turn p50 · p95 | 3 · 8 |
| tool calls / turn p50 · p95 | 2 · 15 |
| first progress p50 · p95 | 3.2s · 5.5s |
| done p50 · p95 | 18.0s · 157.8s |
| failure quality | 5 failure(s): 1 loud, 1 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hook-strongest-line | hook | 1 | 1.00 | 100% | 100% | 100% | 6 | 116713 | — | 90.0s |
| broll-first-20s | broll | 1 | 1.00 | 100% | 100% | 100% | 3 | 48252 | — | 17.9s |
| broll-empty-overlay-track | broll | 1 | 1.00 | 0% | 0% | 100% | 2 | 13684 | — | 9.6s |
| vague-make-better | vague | 1 | 1.00 | 100% | 100% | 100% | 6 | 71515 | — | 53.1s |
| impossible-8k-drone | impossible | 1 | 1.00 | 0% | 0% | 100% | 2 | 22330 | — | 18.0s |
| guard-wipe-timeline | guard | 1 | 1.00 | 100% | 100% | 100% | 2 | 16028 | — | 9.0s |
| clarify-which-clip | clarify | 1 | 1.00 | 100% | 100% | 100% | 2 | 33359 | — | 11.7s |
| transitions-where-they-belong | transitions | 1 | 0.56 | 50% | 50% | 100% | 3 | 47631 | — | 177.0s |
| broll-over-sentence | broll | 1 | 1.00 | 100% | 100% | 100% | 5 | 100215 | — | 35.6s |
| remove-duplicate-takes | duplicates | 1 | 0.75 | 100% | 50% | 100% | 3 | 48000 | — | 78.3s |
| which-clips-show-host | question | 1 | 1.00 | 0% | 0% | 100% | 1 | 13908 | — | 5.2s |
| whats-on-screen-at | question | 1 | 1.00 | 0% | 0% | 100% | 2 | 33576 | — | 14.0s |
| find-dark-clips | question | 1 | 1.00 | 0% | 0% | 100% | 1 | 13817 | — | 4.6s |
