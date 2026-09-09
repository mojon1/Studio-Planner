// ホーム画面に置いたときのアイコンを焼く。絵柄は index.html の favicon と同じ。
// node tools/make-icons.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
const ROOT = '/home/user/Osmo360_AdobePlugin/studio3d';

// r=角丸、pad=余白（マスカブルは端を切られるので中身を小さくする）
const svg = (r, pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${r}" fill="#1d2027"/>
  <g transform="translate(256 256) scale(${(512 - pad * 2) / 512}) translate(-256 -256)">
    <path d="M56 344h400M136 344V168h240v176" stroke="#e29a44" stroke-width="34" fill="none"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="256" cy="256" r="42" fill="#e29a44"/>
  </g>
</svg>`;

const jobs = [
  ['icon-192.png', 192, svg(112, 0)],
  ['icon-512.png', 512, svg(112, 0)],
  ['icon-maskable.png', 512, svg(0, 96)]     // 全面塗り + 内側に寄せる
];

const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
for (const [name, size, body] of jobs){
  const ctx = await b.newContext({ viewport: {width: size, height: size}, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${body}`);
  fs.writeFileSync(`${ROOT}/${name}`, await p.screenshot({ omitBackground: true }));
  await ctx.close();
  console.log(name, size + 'px');
}
await b.close();
