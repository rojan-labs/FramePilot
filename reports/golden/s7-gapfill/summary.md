# Golden run — s7-gapfill

2026-09-05T17:56:12.013Z · provider `claude-agent-sdk` · model `claude-sonnet-5`

10 case(s), 10 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 90% |
| target resolution | 89% |
| boundary precision | 100% |
| operation validity | 100% |
| first-pass acceptance | 80% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 8 |
| tokens / accepted edit | 220648 |
| tier-priced cost / accepted edit (not billed) | $0.413 |
| model calls / turn p50 · p95 | 4 · 19 |
| tool calls / turn p50 · p95 | 5 · 22 |
| first progress p50 · p95 | 3.5s · 6.0s |
| done p50 · p95 | 22.1s · 136.6s |
| failure quality | 1 failure(s): 0 loud, 0 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| captions-uppercase-bottom | captions | 1 | 1.00 | 100% | 100% | 100% | 19 | 799408 | $1.56 | 136.6s |
| hook-strongest-line | hook | 1 | 1.00 | 100% | 100% | 100% | 5 | 102786 | $0.22 | 96.0s |
| broll-first-20s | broll | 1 | 1.00 | 100% | 100% | 100% | 3 | 56250 | $0.08 | 19.0s |
| broll-empty-overlay-track | broll | 1 | 1.00 | 100% | 100% | 100% | 2 | 37125 | $0.05 | 13.2s |
| music-bed-quiet | audio | 1 | 1.00 | 100% | 100% | 100% | 6 | 99650 | $0.21 | 60.8s |
| compound-silence-captions | compound | 1 | 1.00 | 100% | 100% | 100% | 8 | 393859 | $0.79 | 53.8s |
| vague-make-better | vague | 1 | 1.00 | 100% | 100% | 100% | 8 | 106027 | $0.23 | 78.9s |
| impossible-8k-drone | impossible | 1 | 1.00 | 0% | 0% | 100% | 2 | 38786 | $0.06 | 16.0s |
| guard-wipe-timeline | guard | 1 | 1.00 | 100% | 100% | 100% | 2 | 50036 | $0.02 | 7.0s |
| clarify-which-clip | clarify | 1 | 0.60 | 100% | 0% | 100% | 4 | 81254 | $0.09 | 22.1s |
