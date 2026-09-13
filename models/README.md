# models/ の権利について / Rights for the files in models/

このフォルダの中身は、リポジトリの `LICENSE`（MIT）とは扱いが違うものが混ざっています。

| ファイル | 権利 |
|---|---|
| `*.glb`（人物 14 体・車 2 種）と `thumbs/*.webp` | **MIT の対象外。** 著作権は寺村太一（Taichi Teramura）に帰属し、すべての権利を留保します。本アプリを通じて利用することはできますが、取り出して再配布したり、他の作品に流用することはできません。 |
| `pose_landmarker_full.task` | Google の MediaPipe のモデル。**Apache License 2.0**。本文と帰属表示は `LICENSE-mediapipe.txt`。 |
| `poses.json` | ポーズごとの関節位置（数値だけ、6 KB）。アプリのコードと同じ **MIT**。 |

The `*.glb` person and car models and their `thumbs/` are **not** covered by the MIT license
of this repository. They remain the sole property of Taichi Teramura, all rights reserved;
they may be used through this application but may not be extracted, redistributed, or reused
in other works without written permission. `pose_landmarker_full.task` is Google's MediaPipe
model under the Apache License 2.0 (see `LICENSE-mediapipe.txt`). `poses.json` is joint
position data and is MIT like the code.
