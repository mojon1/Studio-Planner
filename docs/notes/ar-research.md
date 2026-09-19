# ロケハン用 AR（現地に人物・車を置く）の調査 — 見送り（2026-09-19）

寺村さんの発案「スマホの AR で、ロケハン時に車や人物を地面に置いてアングルを決めたい。
レンズは 35 mm 換算の焦点距離だけでよい。iPhone 優先」を調べて、**手間に見合わないので見送り**と決めた。
また持ち上がったときに同じ調べ物をしないための記録。

## 技術の現状（2026 年 9 月）

- **Android の Chrome**: WebXR の `immersive-ar` と hit-test が標準で使える。three.js で床に置ける。
  カメラ映像はページから読めない（Raw Camera Access は Chrome 107 以降で別途）。
- **iPhone / iPad の Safari**: WebXR の AR に**未対応**（iOS 26 でも。Apple の WebXR は Vision Pro の VR だけ）。
  Web でできるのは
  1. **AR Quick Look**（USDZ を `<a rel="ar">` で渡す）。図面全体を 1 つの塊で置ける。個別には動かせず、
     レンズの枠も重ねられない。three.js の `USDZExporter` は骨を持たないので、人物のポーズは頂点に焼く必要がある。
  2. **疑似 AR**（カメラ映像＋端末の傾き＋「カメラの高さ」の仮定で地面を割り出す）。立ち止まって
     アングルを探す用途なら成り立つが、歩くとずれる。地面は検出ではなく仮定。
  3. **App Clip**（Safari のリンクから数秒で起動する小さなアプリ。中は WKWebView ＋ ARKit ＋ WebXR polyfill）。
     Web 側は標準の WebXR のままで iPhone でも本物の AR になる。業者（Variant Launch・EyeJack・Onirix Clip、
     月額固定）か、自前（公開の Apache-2.0 の雛形 `wem-technology/ios-webxr`。hit-test あり、映像は Base64 渡しで重い）。
     自前は Apple Developer Program 年 $99・Mac と Xcode・親アプリの App Store 審査・ドメインの関連付けが要る。
     Clip 本体は 50 MB まで（iOS 17〜。QR 起動は 15 MB）。30 日使わないと消える。Safari からしか起動できない
     （ホーム画面の PWA や LINE の中からは不可）。
- **専用アプリ（ARKit）**: 全部できるが、Mac・Apple のアカウント・審査。Android は別物（ARCore か Unity）。
- 端末カメラの本当の画角は Web からは読めない（ARKit 経由なら投影行列で分かる）。

## 既存アプリ（競合）

| 道具 | 値段 | できること |
|---|---|---|
| Cadrage | 買い切り $19.99（iOS・Android） | カメラ×レンズの正確な枠、写真・動画、太陽の軌跡、PDF、プロジェクト管理。**AR は無い**（寺村さんの周りのカメラマンの定番） |
| Artemis Pro | 買い切り $29.99 | 同上に加え、人のシルエット（2D）をスタンドインとして重ねる。太陽の AR。**地面認識は無い** |
| Sun Surveyor | ¥1,500 | 太陽の位置。日本のロケハン記事で定番 |
| Previs Pro | 年 $119.99 | iPad の本物の AR で人物・小道具を置ける。ポーズ、実センサー |
| Magic Cinema ViewFinder | 無料（広告） | 枠の簡易シミュレーション |
| Cadrage Studio（2026-07） | 月 $19.99 / 年 $99.99 | **カメラ配置図、LiDAR の部屋スキャン**、ショットリスト。Studio Planner の本丸と重なる |

## 見送った理由と、もし再開するなら

- iPhone 優先で「地面認識の AR で個別に置く」を満たすには App Clip か専用アプリしかなく、どちらも
  Mac・Apple のアカウント・審査（または月額）が要る。Web だけでは Quick Look か疑似 AR まで。
- 再開するなら **App Clip 方式**が筋がいい（コードの 95% が Web のまま、更新に審査が要らない、Android は同じページで動く）。
  順番は「Web 側の WebXR ページ（床に置く・35 mm 換算の枠・写真）を先に作る → 殻は Mac の有無で自前か業者か」。
- 差別化は「Studio Planner の図面（ポーズ付き人物・車・ライト・カメラ）をリンク 1 本で現地に持ち出す」の一点。
  ファインダーとしては Cadrage に勝てない。
- 安い試し方: Studio Planner に「現地で見る」（Quick Look）だけ 2〜3 日で足し、現場の反応を見る。
