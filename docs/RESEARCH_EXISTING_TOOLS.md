# スタジオ撮影計画 3D Web アプリ — 既存サービス調査（2026-09-07）

寺村さんの構想（ブラウザベース、スマホ/タブレット対応、無料、スタジオサイズ入力、
演者プリセット、モデルインポート、被写体配置、カメラ/焦点距離の見え方、反射板の映り込み、
シーンの保存と共有）に対して、既存のアプリ・サービスがどこまでカバーしているかを調べた。

> 注意: コンテナからは製品公式サイト（elixxier, previspro, imagen-ai など）への直接アクセスが
> 遮断されていたため、価格・機能は検索結果と第三者レビュー記事に基づく。
> 購入前は必ず公式サイトで再確認すること。

---

## 1. 結論（先に要点）

1. **「ブラウザで動く 3D のスタジオ撮影プランナー」で無料のものは、事実上存在しない。**
   - 3D で本格的なのは全部デスクトップ（set.a.light 3D, Cine Tracer, FrameForge）か
     iOS 専用（Previs Pro）。
   - ブラウザで無料のものは 2D の俯瞰図ツール（Imagen Studio Light Diagrammer、
     Online Lighting Diagram Creator、Photography Icon）か、
     固定ポートレートの照明シミュ（zvork Virtual Lighting Studio、2012 年製）しかない。
2. **「反射板・水面の映り込みを事前確認」は、どの既存ツールにも専用機能がない。**
   Cine Tracer 2（UE5 Lumen）や set.a.light 3D はレンダリングとして反射が出るが、
   「鏡面をここに置いたら何が映るか」を設計目的にした機能は見当たらない。ここが差別化点。
3. **「共有」は URL 一本で開けるものがほとんどない。** set.a.light はコミュニティ投稿、
   Shot Designer は有料版でチーム同期、Previs Pro は PDF/動画書き出し。
   「リンクを送ればスマホで 3D シーンが開く」は、既存ツールに無い体験になる。
4. したがって、構想は既存製品とまともにぶつからない。
   **three.js（または Babylon.js）+ 静的ホスティング + 共有 URL** の構成で作る価値がある。

---

## 2. 主要製品の比較表

| 製品 | 種別 | 動作環境 | 価格（調査時点） | 3D | 焦点距離/画角 | モデル取込 | 反射確認 | 共有 |
|---|---|---|---|---|---|---|---|---|
| **set.a.light 3D V3** (elixxier) | 写真スタジオ照明シミュ | Win/Mac デスクトップ | 買い切り。Basic 約 11,000〜16,800 円 / Studio 約 21,900〜32,300 円（記事により差あり。USD 表記では $94 / $230） | ◎ 物理ベース | ◎ 実カメラ/レンズ | ○ 自前アセット取込あり | △ レンダリング上の反射のみ | △ PDF 書き出し、コミュニティ 10,000+ セットアップ |
| **Cine Tracer / Cine Tracer 2** (Matt Workman) | 映像向け撮影シミュ（UE4→UE5） | Win/Mac（Steam） | 買い切り 約 €76（購入者は CT2 無料） | ◎ Lumen GI/反射 | ◎ 実カメラ/レンズ | △ | △ リアルタイム反射はあるが設計機能ではない | △ 静止画ストーリーボード書き出し |
| **Cine Designer R2** | C4D プラグイン | Cinema 4D R17/18 | $525 | ◎ | ◎ | ◎（C4D） | C4D 側でレンダ | C4D ファイル |
| **FrameForge Previz Studio 3.6** | 映像プリビズ | Win/Mac | 有料（Core/Pro 各エディション） | ◎ 光学的に正確な 3D ブロッキング | ◎ Super8〜IMAX | ○ | × | PDF/ショットリスト。2019 年以降大型更新なし |
| **Previs Pro 3** (Ghostwheel) | ストーリーボード/プリビズ | iPad/iPhone/Mac のみ（Android・Web 無し） | 無料版あり（2D 画像に透かし、アニマティクス 1 本/プロジェクト）。有料版は $229 相当 | ◎ | ◎ | ○ | × | 画像/PDF/動画書き出し |
| **Shot Designer** (Hollywood Camera Work) | 2D フロアプラン+ショットリスト | iOS/Android/Win/Mac | 無料（保存・書き出し不可、1 シーンのみ）/ Pro €19.99 | × 2D | × | × | × | Pro でチーム同期 |
| **StudioBinder Shot List** | ショットリスト/制作管理 | ブラウザ | 無料枠あり | × | △ レンズ欄はメモのみ | × | × | ◎ 閲覧リンク・チーム招待 |
| **Studio Light Diagrammer** (Imagen AI) | 2D 照明図 | ブラウザ | 無料 | × 俯瞰 2D | × | × | × | 画像書き出し |
| **Online Lighting Diagram Creator** (QH Photography) | 2D 照明図 | ブラウザ | 無料 | × | × | × | × | ○ URL 保存 |
| **Photography Icon Lighting Diagram Tool** | 2D 照明図（Rembrandt 等プリセット） | ブラウザ | 無料 | × | × | × | × | 画像 |
| **Virtual Lighting Studio** (zvork.fr) | ポートレート照明シミュ | ブラウザ（WebGL） | 無料 | △ 固定被写体のみ | × | × | × | × |
| **Blender + LightArchitect / Lens Sim** | 汎用 3D | Win/Mac/Linux | Blender 無料、アドオン有料 | ◎ | ◎ | ◎ | ◎ Cycles で正確 | .blend |

### 日本国内の関連サービス
- **studio DATA BASE（POWER PAGE）の「3D ビュー」**: レンタルスタジオを 360 度写真＋立体見取り図で
  バーチャル内見できる。ロケハン代替。カメラを置いて画角を見る機能はない。
- **ClouDali（大伸社）**: ブラウザで 3D シミュレーション（B2B、機器設置例・ショールーム向け）。
- **MyBooth**: 展示会ブースの 3D シミュレーター。登録不要・無料。構造的には近いが撮影用ではない。
- BOOTH に無料の「撮影スタジオ」3D アセットあり（VRChat 向けなど）。プリセット素材の候補。

---

## 3. 各製品の所感

### set.a.light 3D（事実上の業界標準）
- 写真スタジオ向けではこれ一択。90 種以上の実在ストロボ・モディファイア、
  10,000 超のコミュニティセットアップ、俯瞰図＋カメラビュー＋機材リストの PDF 出力。
- 弱点: デスクトップ専用、有料、スマホで見られない、「共有」が PDF 止まり。
- 寺村さん構想との差: 照明の物理精度で勝負しない限り真正面から競合はしない。
  「スマホで開ける」「無料」「共有 URL」「反射板の映り込み」が全部空いている。

### Cine Tracer / Cine Tracer 2
- 映像向け。UE5 Lumen で反射・GI がリアル。ただしゲーム並みの GPU が要る。
- 「反射板を置いたら何が映るか」は結果として見えるが、水面などの意図的な鏡面設計は
  想定していない。

### Previs Pro 3（2025-09 に無料版追加）
- iPad でタッチ操作の 3D プリビズ。演者・小道具ライブラリ、AR ロケハン、AI 照明。
- iOS 専用。Android・ブラウザ版は公式に「無い」と明言。ここが構想の「ブラウザで
  スマホ/タブレット両対応」と決定的に違う。

### ブラウザ無料 2D 系（Imagen, QH, Photography Icon）
- 照明図を描いて共有する用途は十分だが、全部 2D 俯瞰。焦点距離による見え方、
  被写体の高さ、反射は扱えない。

---

## 4. 構想の要件ごとの「既存ツールの充足度」と実装方針

| 要件 | 既存で満たすもの | 提案する実装 |
|---|---|---|
| スタジオサイズ入力 | set.a.light, Previs Pro, FrameForge（有料/非ブラウザ） | 幅・奥行・高さ＋ホリゾント（R 壁）を数値入力。プリセット: 6 畳〜大型ホリゾント。 |
| 演者などモデルプリセット | set.a.light（有料）、Previs Pro（iOS） | 身長可変のマネキン（VRM か glTF）。CC0 のアバターや Mixamo 系を身長スケールで配置。ポーズ数種。 |
| 3D モデルインポート | Blender, set.a.light | glTF/GLB を標準。OBJ/FBX/STL はブラウザ内で glTF に変換（three.js ローダーで可）。寺村さんの C4D からは glTF 書き出しでそのまま。 |
| 被写体の位置調整 | 全製品 | ドラッグ移動＋数値入力。スマホは 1 本指移動・2 本指回転。スナップ（グリッド/床）。 |
| カメラ位置・焦点距離の見え方 | set.a.light, Cine Tracer, FrameForge, Previs Pro | センサーサイズ（フルサイズ/APS-C/MFT/1 型/スマホ）× 焦点距離で FOV を計算。カメラビューを小窓＋全画面切替。アスペクト枠（3:2, 16:9, 9:16, 1:1）。 |
| 反射板・水面の映り込み確認 | **該当なし**（差別化点） | 平面鏡はレンダリング上の Reflector（WebGL）/ ReflectorNode（WebGPU）で正確に出せる。水面は「平面鏡＋波の法線マップ＋フレネル」で十分。「映り込み範囲」を線で可視化（カメラから鏡面経由でどこが見えるかの錐台表示）が独自機能になる。 |
| シーン設定の保存と共有 | set.a.light（コミュニティ）、Shot Designer Pro（同期） | まず **URL ハッシュに圧縮 JSON** を載せる方式（サーバー不要・無料・共有はリンクだけ）。インポートした大きなモデルは URL に乗らないので、必要になったら Supabase 無料枠（500MB DB / 1GB ストレージ、1 週間無アクセスで停止）等を後付け。 |

---

## 5. 技術的な実現性メモ（ブラウザ 3D）

- **エンジン**: three.js が第一候補。glTF ローダー、OrbitControls/TransformControls、
  Reflector（平面鏡）、RectAreaLight（ソフトボックス相当）が標準で揃う。
  WebGPU 版（`WebGPURenderer` + TSL）も 2026 年時点で実用域だが、iOS Safari の対応状況を
  考えると WebGL2 を既定にし WebGPU は将来のオプションでよい。
- **カメラの焦点距離**: three.js の `PerspectiveCamera.setFocalLength()` は 35mm 換算で
  FOV を計算する。センサーサイズ別は `filmGauge` を切り替える。
- **モデル入力**: glTF/GLB が標準。OBJ/FBX ローダーも three.js にある。VRM は
  `@pixiv/three-vrm` で読める（身長・ポーズ変更が容易）。
- **反射**: 平面鏡は Reflector で追加レンダーパス 1 回。水面はノーマルマップで揺らぎを付ける。
  スマホでは解像度を落とす（Reflector の textureWidth/Height を 512 程度に）。
- **共有**: シーン JSON を deflate + base64url で `#` に載せる。1〜2 KB で収まる。
  静的ホスティング（GitHub Pages / Netlify / Cloudflare Pages）は無料。
- **スマホ操作**: PWA 化してホーム画面に置けるようにする。タッチ操作は
  pointer events で統一。iPad の Safari は WebGL2 対応済み。
- **参考にできる OSS**: openPlan3D（SvelteKit + three.js の 2D/3D 間取りエディタ）、
  threejs-lighting-generator（ライト配置 UI の参考）。

---

## 6. 差別化ポイントのまとめ

1. **ブラウザ完結・無料・スマホ/タブレット対応** — 既存 3D 系は全部デスクトップか iOS 専用。
2. **リンクを送るだけの共有** — 現場のスタッフやクライアントがアプリ無しで 3D シーンを開ける。
3. **反射板・水面の映り込み設計** — 専用機能を持つ既存ツールが無い。
4. **C4D との親和性** — glTF 往復で寺村さんの既存ワークフローに乗る。

**あえて追わない領域**: set.a.light の「実機ストロボの光量・配光の物理精度」。
ここを追うと開発量が桁で増える。まずは「配置・画角・映り込み・共有」に絞る。

---

## 7. 次の一歩（提案）

1. 要件を MVP に絞る: スタジオ箱＋マネキン＋カメラ（センサー/焦点距離/アスペクト）＋
   平面鏡＋URL 共有。ライトは「位置と向きの記号」だけで、光量計算はしない。
2. three.js で単一 HTML の試作を作り、スマホ実機（iPhone/iPad/Android）で操作感を確認。
3. 反射板の「映り込み範囲」可視化を試作して、これが本当に役立つか実機で判断。
4. 保存・共有は URL ハッシュ方式で開始。DB は必要になってから。

---

## 参考リンク

- set.a.light 3D: https://www.elixxier.com/en/set-a-light-3d/ ／ 国内レビュー: https://lightingandgadgets.com/set-a-light3d-review/ , https://omochiohagi.com/setalight3d , https://programming.awaisora.com/0bf6558a-70be-49c3-bbce-80bdef405a99/
- Cine Tracer: https://store.steampowered.com/app/904960/Cine_Tracer/ ／ Cine Tracer 2: https://store.steampowered.com/app/1774380/Cine_Tracer_2/ ／ 解説: https://www.cgchannel.com/2019/07/check-out-ue4-based-cinematography-simulator-cine-tracer/
- Cine Designer R2: https://cinematographydb.gumroad.com/l/bziNeO
- FrameForge: https://www.bhphotovideo.com/c/product/1164150-REG/frameforge_pv3pro_previz_studio_3_5_pro.html ／ 比較記事: https://mstudio.ai/insights/best-previs-software-2026
- Previs Pro 3: https://www.cgchannel.com/2025/11/storyboarding-app-previs-pro-3-adds-animatics-and-a-free-edition/ ／ Android 非対応: https://support.previspro.com/article/72-is-there-an-android-version-available
- Shot Designer: https://www.hollywoodcamerawork.com/shot-designer.html
- StudioBinder: https://www.studiobinder.com/shot-planner/
- Studio Light Diagrammer: https://imagen-ai.com/tools/studio-light-diagrammer/
- Online Lighting Diagram Creator ほか 2D ツールまとめ: https://photography.tutsplus.com/articles/5-tools-to-create-and-share-studio-lighting-diagrams--cms-23285
- Photography Icon: https://photographyicon.com/lighting-diagram-tool/
- Virtual Lighting Studio: http://www.zvork.fr/vls/
- Blender LightArchitect: https://www.blendernation.com/2018/05/11/lightarchitect-cinematography-pre-visualization-in-blender/ ／ Lens Sim: https://superhivemarket.com/products/lens-sim
- studio DATA BASE 3D ビュー: https://studio.powerpage.jp/contents/category/feature/3d-view
- MyBooth: https://mypict.net/guide/booth-design-3d-simulator/
- three.js Reflector: https://threejs.org/docs/pages/Reflector.html ／ openPlan3D: https://github.com/laanlabs/openPlan3D ／ threejs-lighting-generator: https://github.com/Tolexia/threejs-lighting-generator
- 無料 VRM アバター集: https://github.com/ToxSam/open-source-avatars
- Supabase 無料枠: https://uibakery.io/blog/supabase-pricing
