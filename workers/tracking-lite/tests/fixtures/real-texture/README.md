# Real-texture plates (MK7.5)

Three stills cut from the mission b-roll, so the real-texture tracking gates
(`tests/test_tracking_gates_real_texture.py`) measure the tracker on real camera texture on every
pack runner, not only on a machine that has the mission media.

| Plate          | Source (mission `broll/`) | At    | Crop (displayed frame)  | Stored    | What it is                               |
| -------------- | ------------------------- | ----- | ----------------------- | --------- | ---------------------------------------- |
| `hillside.jpg` | `b1-4k30-22s.mov`         | 2 s   | 2160×1215 at (0, 2500)  | 1600×900  | sunlit foliage on a slope, dense texture |
| `forest.jpg`   | `b2-4k60-9s.mov`          | 6 s   | 1280×720 at (880, 360)  | 1280×720  | a tree trunk against leaves, some blur   |
| `night.jpg`    | `b3-1080p60-15s.mov`      | 2 s   | 1080×608 at (0, 1250)   | 1080×608  | low-light road edge, pavement and bench  |

Each crop was chosen to hold **no person, face or number plate**: the b-roll's people (a
passenger in `b2`, riders and cars in `b3`, a presenter in `b4`) are outside every crop, and
`b4` is not used at all. They are the maintainer's own footage, committed at ~470 KB in total
under the same terms as the rest of this repository.

`extract.sh` regenerates them from the mission media (`MISSION_MEDIA_DIR`, default
`tests/fixtures/mission`) and rewrites `SHA256SUMS`. ffmpeg auto-rotates the portrait phone
clips, so crop coordinates are in the displayed frame. The JPEG bytes depend on the local ffmpeg
build; the tests only need the texture, not particular bytes.
