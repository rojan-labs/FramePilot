# Golden run — s9-baseline-replay

2026-09-06T21:04:00.655Z · provider `replay` · model `replay` · **replayed from recordings (no model calls; latency not meaningful)**

11 case(s), 40 turn(s).

| metric | value |
| --- | --- |
| intent accuracy | 83% |
| target resolution | 72% |
| boundary precision | 98% |
| operation validity | 100% |
| first-pass acceptance | 80% |
| silent successes | 0 |
| reversibility | 100% |
| accepted edits | 32 |
| **turns the provider never answered** | **2 — excluded from every rate above; re-run them** |
| tokens / accepted edit | 0 |
| tier-priced cost / accepted edit (not billed) | $0.627 |
| model calls / turn p50 · p95 | 7 · 16 |
| tool calls / turn p50 · p95 | 8 · 17 |
| first progress p50 · p95 | 0.0s · 0.0s |
| done p50 · p95 | 0.0s · 0.3s |
| failure quality | 3 failure(s): 3 loud, 3 explained |

| case | category | runs | score | intent | first-pass | undo ok | calls | tokens | USD/run | wall/run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | montage | 3 | 1.00 | 100% | 100% | 100% | 7 | 0 | $0.28 | 0.0s |
| podcast-highlight-60s | highlight | 3 | 1.00 | 67% | 67% | 100% | 5 | 0 | $0.32 | 0.0s |
| remove-dead-air | silence | 3 | 1.00 | 100% | 100% | 100% | 3 | 0 | $0.13 | 0.0s |
| beat-sync | beat | 3 | 1.00 | 100% | 100% | 100% | 16 | 0 | $0.57 | 0.0s |
| refine-tighten | pacing | 3 | 1.00 | 100% | 100% | 100% | 8 | 0 | $0.74 | 0.0s |
| memory-captions | memory | 3 | 1.00 | 71% | 71% | 100% | 8 | 0 | $1.95 | 0.1s |
| trim-first-clip-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 4 | 0 | $0.09 | 0.0s |
| trim-opening-10s | trim | 3 | 1.00 | 100% | 100% | 100% | 5 | 0 | $0.12 | 0.0s |
| reorder-last-first | reorder | 3 | 0.60 | 67% | 33% | 100% | 7 | 0 | $0.32 | 0.0s |
| reorder-swap-first-two | reorder | 3 | 0.60 | 0% | 0% | 100% | 10 | 0 | $0.35 | 0.0s |
| captions-plain | captions | 3 | 1.00 | 100% | 100% | 100% | 8 | 0 | $0.57 | 0.3s |
