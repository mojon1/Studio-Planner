// ホーム画面とタブのアイコンを、寺村さんの元絵 tools/icon-src.png（正方形の PNG）から焼く。
//   cd test && node ../tools/make-icons.mjs
// 出すもの: favicon-32.png（タブ）、icon-180.png（iOS のホーム画面）、icon-192.png / icon-512.png（Android・PWA）、
// icon-maskable.png（Android が丸や角丸に切り抜く版。元絵を 76% に縮めて、元絵の地色で埋める）。
// 描画は Chromium（Playwright）。縮小の品質はブラウザに任せる（Node には画像ライブラリを入れていない）
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'tools', 'icon-src.png');
const src = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');
const jobs = [
  ['favicon-32.png', 32, 1], ['icon-180.png', 180, 1], ['icon-192.png', 192, 1], ['icon-512.png', 512, 1],
  ['icon-maskable.png', 512, 0.76],
];
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
const ctx = await b.newContext({ viewport: {width: 512, height: 512}, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.setContent(`<style>html,body{margin:0;background:transparent}canvas{display:block}</style><canvas id="c"></canvas>`);
await p.evaluate(async src => { const img = new Image(); img.src = src; await img.decode(); window.__img = img; }, src);
for (const [name, size, scale] of jobs){
  const url = await p.evaluate(([size, scale]) => {
    const img = window.__img, c = document.getElementById('c'); c.width = c.height = size;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const s = Math.round(size * scale), o = Math.round((size - s) / 2);
    if (scale < 1){
      // マスカブル: 中身を内側へ縮め、余白は**縮めた絵の縁の 1 px をそのまま外へ引き伸ばして**埋める。
      // 元絵の地は中心が明るいグラデーションなので、角の色で塗ると縁に四角い境目が出る
      const t = document.createElement('canvas'); t.width = t.height = s; const tg = t.getContext('2d');
      tg.imageSmoothingQuality = 'high'; tg.drawImage(img, 0, 0, s, s);
      g.drawImage(t, 0, 0, 1, s, 0, o, o, s);          g.drawImage(t, s-1, 0, 1, s, o+s, o, o, s);      // 左右
      g.drawImage(t, 0, 0, s, 1, o, 0, s, o);          g.drawImage(t, 0, s-1, s, 1, o, o+s, s, o);      // 上下
      g.drawImage(t, 0, 0, 1, 1, 0, 0, o, o);          g.drawImage(t, s-1, 0, 1, 1, o+s, 0, o, o);      // 角
      g.drawImage(t, 0, s-1, 1, 1, 0, o+s, o, o);      g.drawImage(t, s-1, s-1, 1, 1, o+s, o+s, o, o);
      g.drawImage(t, o, o);
    } else g.drawImage(img, o, o, s, s);
    return c.toDataURL('image/png');
  }, [size, scale]);
  const out = path.join(ROOT, name);
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(name, size + 'px', (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
}
await b.close();
