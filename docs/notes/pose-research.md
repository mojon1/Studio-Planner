# 写真ポーズ指定の品質を上げるには（調査メモ、2026-09）

寺村さんの「可能性を感じる。手が握れない、ポーズが大まか。上げる方法は？」への調査。
**まだ実装しない。** 実装するときはここを読み、判断を更新すること。今の仕組みは `people.md` の
「写真ポーズ指定」。

## いま何が足りないか（3 つに分けて考える）

| 段 | いまの中身 | 限界 |
|---|---|---|
| ① リグ（人物モデルの骨） | Tripo の自動リグ（Biped）。**指の骨が無い。** 手首から先は 1 本 | 検出をどれだけ良くしても手は握れない |
| ② 検出（写真 → 関節） | MediaPipe Pose Landmarker（full、33 点）。2D は良いが 3D の奥行きが甘いので、`fuseLandmarks()` が 2D の長さから奥行きを起こしている | 1 枚の写真から前後を当てている。カメラに向けた腕は縮む。手・指・手首の向きは取っていない |
| ③ 転写（関節 → 骨の回転） | 位置だけ持ち、`applyPose()` が骨の向きを最短回転で合わせ、ねじれは目印（`TWIST_REF`）で決め直す | 手首の回転（回内・屈曲）と指は情報が無いので素のまま |

**手を握るには ① と ② の両方が要る。** ポーズの大まかさは ② と③。

## 手を握る

### ① 指の骨を足す（14 体の再リグ）

- **Tripo の自動リグは指の関節数を指定できる**（rig の API に finger joints の設定がある。
  今の 14 体は指無しで作ってある）。同じ Tripo なので、メッシュはそのままで骨だけ足せる可能性が高い。
  手順は `tools/` に一括スクリプト → 骨名の対応表（`index.html` の Tripo 名 → Mixamo 名の表）に
  指を足す → `poses.json` は 23 関節のままでよい（指は既定の開いた形。ポーズは骨の向きしか見ない）。
- 代替は **Mixamo の自動リグ**（無料、指 3 関節ずつ、骨名はこのアプリの `POSE_ORDER` と同じ流儀）。
  ただし 2025 年 6 月から断続的に落ちていて保守されていない。今から頼るのは避けたい。
- 増える骨は片手 15 本 × 2。GLB の大きさはほぼ変わらない（骨は軽い）。

### ② 手の検出

- **MediaPipe Hand Landmarker**（同じ tasks-vision。片手 21 点、`worldLandmarks` はメートルの 3D、
  モデル 7.5 MB、Apache 2.0）。**全身写真では手が小さすぎて直接は当たらない**ので、Pose の
  手首の点のまわりを切り出してから掛ける（Holistic Landmarker はこれを中でやる。
  tasks-vision の JS に `HolisticLandmarker` がある）。
- **指の曲がりを回転にするのは Kalidokit（MIT）の `Hand` が実装済み**。21 点から各指の
  曲げを出す。握り／開きの判定は安定するが、細かい指の形は写真 1 枚では揺れる。
  打合せの縮尺では「握っている／開いている／指さし」が分かれば十分。
- 手首の向きも同時に取れる（手のひらの法線 → 前腕のねじれと手首の曲げ）。③ の
  「回内は変えない」を外せる。
- 共有リンクには **指の座標ではなく「指の曲げ 5 本 × 2 手」（0〜1）** で乗せる。40 文字ほど。
- 費用: 押した人だけ初回に +7.5 MB、1 枚あたり +0.2 秒程度（未測定）。

## ポーズの精度を上げる

### A. 今の部品のまま、写真を 2 枚にする（費用が小さく効果が大きい）

**正面と横の 2 枚から三角測量する。** 奥行きを 1 枚から当てる限界は、どのモデルに替えても
残る（「1 台のカメラの 3D は UX 用で、測定ではない」というのが業界の通説）。2 枚あれば
奥行きは推定ではなく計算になる。現場で「もう 1 枚、横から」と撮るのは自然で、モデルを
増やさないので圏外でも速さも変わらない。**まずこれ。**

### B. 2D の検出器を替える（ブラウザで動く範囲）

- **RTMPose / RTMW**（OpenMMLab、Apache 2.0）。RTMW は**全身 133 点（体 17・足 6・顔 68・手 42）
  を 1 回で**出す。ONNX が配られていて、`onnxruntime-web` でブラウザで動く（Harvard の
  MMLA が体 17 点版をブラウザで公開）。RTMW-m は数十 MB。2D の精度は MediaPipe より上で、
  手も一緒に取れる。奥行きの持ち上げ（`fuseLandmarks`）はそのまま使う。
- **ViTPose**（Apache 2.0）。2D の精度は最上位（評価で 86.6% 対 MediaPipe 83.5%）。
  Transformers.js v3.1 から**ブラウザで動く**（WebGPU / WASM、q8 量子化）。ただし ViT なので
  数十〜百 MB 級。2D のみ。
- **iOS 26 で Safari が WebGPU に対応**したので、iPhone でも `onnxruntime-web` の WebGPU が
  使える。ただし **Safari のタブは 500 MB 前後でメモリを切られる**ので、モデルは 100 MB 未満に。

### C. 3D メッシュ復元（本命だが、ブラウザにはまだ載らない）

- **SAM 3D Body**（Meta、CVPR 2026 口頭）。1 枚から体・足・**手指**まで 3D で復元し、
  新しいパラメトリックモデル **MHR（Momentum Human Rig、127 関節、指まで）** を出す。精度は
  現時点の最高水準。**ただし 631M / 840M パラメータ（ViT-H / DINOv3-H+）**で、重みは 1 GB 級。
  ブラウザにも iPhone にも載らない。ライセンスは「SAM License」（商用条件を要確認）。
- **Fast SAM 3D Body**（ECCV 2026）で 10 倍速くなったが、それでも **RTX 5090 で 65 ms**。
  デスクトップ GPU の話で、端末側では動かない。
- 同じ級: NLF、PromptHMR、CameraHMR（いずれも ViT-L 以上）。手だけなら HaMeR / WiLoR
  （WiLoR の検出器は 7 MB だが復元は ViT）、Fast-HaMeR（HaMeR の 35% の大きさ）。
- **使うなら「PC 側の道具」として**: `tools/` に Python の一括変換（写真 → このアプリの
  `it.photo` の形）を置き、出た座標を共有リンクとして貼る。アプリは軽いまま、サーバーも
  要らない。寺村さんの PC（GPU）で動かす前提。現場のスマホでは A と B。

## おすすめの順番

1. **2 枚撮り（正面＋横）で奥行きを三角測量。** モデル追加なし。効果がいちばん大きい。
2. **指の骨（Tripo で再リグ）＋ Hand Landmarker（手首まわりの切り出し）。** 握り・開き・
   指さしと手首の向き。Kalidokit の式を移植。
3. **RTMW（全身 133 点）を `onnxruntime-web` で。** MediaPipe Pose を置き換え、手も同じ 1 回で。
   2 のあとなら手の検出もこれに寄せられる。
4. **SAM 3D Body は PC 側の道具として。** アプリの中には入れない（設計方針: サーバー無し・軽い）。

## 変えないこと

- **アプリの中で完結する（サーバーもアカウントも無し）。** 3D 復元の重いモデルはこれと両立しない。
- **共有リンクに乗るのは関節の座標か曲げの数字だけ。** 写真そのものは乗せない。
- **`it.photo` の形は後方互換で広げる**（列を足す。23 行でも読める、を守る）。

## 出典

- SAM 3D Body: https://ai.meta.com/research/publications/sam-3d-body-robust-full-body-human-mesh-recovery/ 、コード https://github.com/facebookresearch/sam-3d-body
- Fast SAM 3D Body: https://github.com/yangtiming/Fast-SAM-3D-Body
- MHR: https://github.com/facebookresearch/MHR
- MediaPipe Holistic / Hand Landmarker（tasks-vision）: https://developers.google.com/edge/api/mediapipe/js/tasks-vision.holisticlandmarker
- RTMPose / RTMW: https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose 、ブラウザ版 https://mmla.gse.harvard.edu/tools/rtmpose/
- ViTPose in Transformers.js: https://github.com/huggingface/transformers.js/releases/tag/3.1.0
- Kalidokit: https://github.com/yeemachine/kalidokit
- WiLoR: https://cvpr.thecvf.com/virtual/2025/poster/34788 、Fast-HaMeR: arXiv 2603.16444
- Tripo Rigging API: https://developers.tripo3d.ai/en/models/rig
- Mixamo の現状: https://app.cinevva.com/guides/free-character-animations-rigging
- WebGPU on iOS 26: https://appdevelopermagazine.com/webgpu-in-ios-26/ 、onnxruntime-web: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- 2D 検出器の比較: https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/openpose-mediapipe-rtmpose-pose-tracking
