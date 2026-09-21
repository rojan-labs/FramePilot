# Smart Mask — licences (hand reviewed; BR0.5, extended in BR3.12)

Licence texts copied verbatim from the upstream repositories **at the pinned revisions** that
BR0 exported and measured. This file is **hand reviewed**, not generated: it carries a
training-data finding no metadata can express. `tools/generate_sbom.py --check` verifies it
against the real environment instead of overwriting it (every shipped distribution with its
licence, every model file, the shipped ffmpeg licence, and this open finding). Weights are never
committed.

| Model | Pinned source | Weights file (sha256) | Licence | Verified |
| --- | --- | --- | --- | --- |
| SAM 2.1 Hiera-Large | github.com/facebookresearch/sam2 @ `2b90b9f5ceec907a1c18123530e92e794ad901a4` | `sam2.1_hiera_large.pt`, 898083611 B, `2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318` (dl.fbaipublicfiles.com/segment_anything_2/092824/) | Apache-2.0 (code and checkpoints, per upstream README) | Licence text: yes |
| BiRefNet_HR-matting | huggingface.co/ZhengPeng7/BiRefNet_HR-matting @ `5d6b6f8adcb5b417c871b1d84ceaae9871355b7f`; code licence from github.com/ZhengPeng7/BiRefNet @ `ebcc0bc8ec7fe919cec829f2dea656b3078acddc` | `model.safetensors`, 444473596 B, `a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55` (matches the HF LFS oid) | MIT (HF card metadata `license: mit`; GitHub `LICENSE`) | Licence text: yes. **Training-data statement: NOT verified — see below** |

## Shipped model files (derived by `tools/export_onnx.py`; digests in `pack/models.lock.toml`)

| File | Derived from | Licence |
| --- | --- | --- |
| `sam21l_image_encoder.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_decoder_multi_n1.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_decoder_points.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_decoder_mask.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_memory_attention.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_memory_encoder.fp32.onnx` | SAM 2.1 Hiera-L | Apache-2.0 |
| `sam21l_constants.npz` | SAM 2.1 Hiera-L | Apache-2.0 |
| `birefnet_hr_matting_768.fp16s.onnx` | BiRefNet_HR-matting | MIT (training-data terms open) |
| `birefnet_hr_matting_1024.fp16s.onnx` | BiRefNet_HR-matting | MIT (training-data terms open) |
| `birefnet_hr_matting_2048.fp16s.onnx` | BiRefNet_HR-matting | MIT (training-data terms open) |

Apache-2.0 §4(b): the SAM graphs are modified forms of the Work (real-valued RoPE, static
padded memory, per-prompt heads; see `spike/sam_modules.py`). The pack carries this notice and
states those changes.

## Shipped Python distributions (the `cv` extra, resolved by `uv.lock`)

Reviewed 2026-09-17 against the installed wheels' own metadata.

| Component | Version | License |
| --- | --- | --- |
| `flatbuffers` | 25.12.19 | Apache-2.0 |
| `numpy` | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| `onnxruntime` | 1.30.0 | MIT |
| `opencv-contrib-python-headless` | 5.0.0.93 | Apache-2.0 |
| `pillow` | 12.3.0 | MIT-CMU |
| `protobuf` | 7.36.1 | BSD-3-Clause |

OpenCV's wheel redistributes FFmpeg (LGPL-2.1-or-later) and other natives listed in its own
`LICENSE-3RD-PARTY.txt`; `--check` verifies the notice still lists them. The pack never decodes
through OpenCV's FFmpeg (`cv2.VideoCapture` has no pts or edit-list semantics).

## The Fast engine's native helper (`bin/fp-vision-matte`, macOS only)

One Swift source file of this project (`native/vision-matte/main.swift`, proprietary like the
worker), compiled by the pack build and linked only against Apple system frameworks (Vision,
Core Image, Core Video, Accelerate, Foundation). It ships **no model and no third-party code**:
the segmentation it returns comes from the operating system's Vision framework, used under the
macOS SDK terms like any other system API. Nothing to attribute, nothing to add to the SBOM
beyond the binary itself (ADR 0182).

## FFmpeg: an LGPL-only binary, not PyAV

Decode and encode run through `bin/ffmpeg` and `bin/ffprobe`, built by
`tools/build_ffmpeg_lgpl.sh` from the pinned FFmpeg 7.1.1 source tarball (sha256
`733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1`) with `--disable-gpl
--disable-nonfree --disable-version3`, statically linked, enabling only FFV1, libvpx (BSD-3-Clause)
VP9, matroska/webm and the scale filter family. Licence of the shipped build: LGPL-2.1-or-later.
The worker's health check and `--check` both refuse a build configured with `--enable-gpl`,
`--enable-nonfree`, x264, x265, xvid, fdk-aac, rubberband, vid.stab or frei0r.

**Finding (BR3.12): PyAV cannot ship.** Every PyAV wheel checked (12.3.0, 13.1.0, 15.1.0, 16.0.1,
17.0.0, 18.1.0 for macOS arm64) bundles `libx264` and `libx265` dylibs (GPL-2.0-or-later) next to
its FFmpeg libraries, although FFmpeg's own `license()` string in those wheels reads "LGPL
version 3 or later". The `av` distribution is therefore absent from the pack and `--check` fails
if it appears.

**Obligations (LGPL-2.1).** FramePilot must ship this notice with the pack, offer the
corresponding FFmpeg source (the pinned tarball plus `tools/build_ffmpeg_lgpl.sh`), and keep
ffmpeg replaceable: it is a separate executable the worker runs as a subprocess, never linked
into the worker. The local development ffmpeg (Homebrew, `--enable-gpl`) is refused by the
health check and must not be registered; `scripts/dev-register-smart-mask.sh` requires an
LGPL build.

## Open finding: the DIS5K commercial-use statement was not found

02-WORKER-PACK.md says BiRefNet_HR-matting was "trained on DIS5K training data, which the authors
state is usable commercially". At the pinned revisions BR0 could not find that statement:

- `grep -i commercial` over the GitHub README (@ `ebcc0bc8`) and the HF model card (@ `5d6b6f8a`)
  finds only a note that *briaai/RMBG-2.0* weights are non-commercial.
- The HF card for BiRefNet_HR-matting says it "was trained with images in 2048x2048 for higher
  resolution image matting with transparency" and evaluates on TE-AM-2k and TE-P3M-500-NP. A
  later paragraph on the same card ("trained on DIS-TR and validated on DIS-TEs and DIS-VD") is
  the generic DIS card text.
- The GitHub model zoo lists the **general matting** training sets as: P3M-10k (except
  TE-P3M-500-NP), TR-humans, AM-2k, AIM-500, Human-2k (synthesised with BG-20k),
  **Distinctions-646** (synthesised with BG-20k), HIM2K, PPM-100. In `config.py` the `Matting`
  task's training set is "every dataset folder except the test sets". Several of those datasets
  are published under research or non-commercial terms, and Distinctions-646 is the dataset 02
  gave as the reason to reject ViTMatte.

BR0 does not change the model choice (it is decided). This row stays **licence-text verified,
training-data terms unverified** until the maintainer or counsel confirms with the author which
datasets BiRefNet_HR-matting was trained on and on what terms (added to BR0-FINDINGS as a
maintainer decision).

## Media used only for measurement (not shipped)

- Sintel, (c) Blender Foundation | durian.blender.org, CC-BY 3.0: parity clips (02:40, 07:05)
  and still backgrounds for the construction-true pilot set.
- Pilot subjects: generated by `spike/pilot_generate.py` (no third-party content).

---

## SAM 2.1 — Apache License 2.0 (facebookresearch/sam2 @ 2b90b9f5, `LICENSE`)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

`LICENSE_cctorch` (BSD-3-Clause) in the same repository covers the optional CUDA
connected-components extension, which the ONNX export does not use and the pack does not ship.

## BiRefNet — MIT License (ZhengPeng7/BiRefNet @ ebcc0bc8, `LICENSE`)

```
MIT License

Copyright (c) 2024 ZhengPeng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
