// about/img/*.jpg（LP の絵）をヘッドレスで焼く。   cd test && node ../tools/make-about-shots.mjs
// 同じ配置（人 3・車・ライト 2・背景布・カメラ）を組んで、上面・ファインダー・ライト・スマホと、+ の人物一覧の 5 枚。
// meeting / sheet / scan / pose / scanning / files の 6 枚は寺村さんが用意した実物で、この道具は触らない。
// 人物モデルは models/ から読むので HTTP で配る（file:// では動かない）。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'test', 'node_modules'), OUT = path.join(ROOT, 'about', 'img');
fs.mkdirSync(OUT, { recursive: true });
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm',
  '.glb':'model/gltf-binary','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.webmanifest':'application/json'};
const srv = http.createServer((req, res) => { let u = decodeURIComponent(req.url.split('?')[0]); if (u.endsWith('/')) u += 'index.html';
  const f = path.join(ROOT, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type': MIME[path.extname(f)] || 'application/octet-stream'}); fs.createReadStream(f).pipe(res); }).listen(8790);
const br = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const route = async p => {
  await p.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', r => { const rel = r.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.180.0/', ''); const f = path.join(NM, 'three', rel); fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }) : r.fulfill({ status: 404 }); });
  await p.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await p.route('https://static.cloudflareinsights.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
};
// 配置。ブラウザの中で走る
const compose = () => {
  const sp = window.__sp, st = sp.state();
  for (let i = st.items.length - 1; i >= 0; i--) if (st.items[i].type !== 'camera') st.items.splice(i, 1);
  const put = (type, opt, set) => { sp.addItem(type, opt); const it = st.items.at(-1); Object.assign(it, set); return it; };
  put('chroma', null, {x: 0.2, z: -2.4, w: 3.6, h: 2.8, color: '#e9e9e4'});
  put('person', {kind:'woman', model:'asia-business-woman', height:1.62}, {x: -0.8, z: 0.4, rot: 15, posture: 'stand-2'});
  put('person', {kind:'man', model:'us-casual-man', height:1.78}, {x: 0.9, z: 0.1, rot: -20, posture: 'stand-5'});
  put('chair', null, {x: 2.3, z: -0.6, rot: -35});
  put('person', {kind:'woman', model:'af-casual-woman', height:1.66}, {x: 2.3, z: -0.6, rot: -35, posture: 'sit-chair'});
  put('car', null, {x: -2.9, z: -1.2, rot: 28});
  put('light', null, {x: -3.2, z: 2.4, rot: 135, y: 2.4, pitch: -25, kind: 'spot'});
  put('light', null, {x: 3.1, z: 2.2, rot: 225, y: 2.2, pitch: -30, kind: 'soft', mount: 'boom'});
  const cam = st.items.find(i => i.type === 'camera'); Object.assign(cam, {x: 0.3, z: 3.6, y: 1.25, rot: 180, pitch: -2});
  sp.setProp(cam, 'focal', 32); sp.rebuild(); sp.select(null);
};
const loaded = () => { const sp = window.__sp; let n = 0, car = false;
  for (const it of sp.state().items){ if (it.type === 'person'){ let f = false; sp.group(it.id)?.traverse(o => { if (o.isSkinnedMesh) f = true; }); if (f) n++; }
    if (it.type === 'car') sp.group(it.id)?.traverse(o => { if (o.isMesh && o.geometry?.attributes?.position?.count > 1000) car = true; }); }
  return n >= 3 && car; };
const settle = async (p, ms = 1500) => { await p.evaluate(() => window.__sp.render()); await p.waitForTimeout(ms); await p.evaluate(() => window.__sp.render()); await p.waitForTimeout(400); };
const view = async (p, v) => { await p.click(`[data-view="${v}"]`); await settle(p); };
const clipShot = async (p, file, w, h) => {   // #gl の真ん中を w × h で切り出す
  const r = await p.$eval('#gl', e => { const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; });
  const s = Math.min(r.w / w, r.h / h), cw = w * s, ch = h * s;
  const buf = await p.screenshot({ type: 'jpeg', quality: 84, clip: { x: r.x + (r.w - cw) / 2, y: r.y + (r.h - ch) / 2, width: cw, height: ch } });
  fs.writeFileSync(path.join(OUT, file), buf); console.log(file, (buf.length / 1024).toFixed(0) + ' KB');
};

// --- PC ---
const ctx = await br.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'ja-JP' });
const p = await ctx.newPage(); await route(p);
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8790/'); await p.waitForTimeout(1500);
await p.click('#items .itemrow[data-kind="person"] > button.name'); await p.waitForTimeout(300);
await p.waitForFunction(() => !!window.__sp.poses(), null, { timeout: 15000 });
await p.evaluate(compose);
await p.waitForFunction(loaded, null, { timeout: 90000 });
await p.evaluate(() => { const sp = window.__sp; sp.rebuild(); sp.select(null); });
await view(p, 'pers'); await settle(p, 2500);
await p.addStyleTag({ content: '#addfab,#pip{visibility:hidden!important}' });   // + と小窓は絵に入れない
await view(p, 'plan'); await clipShot(p, 'plan.jpg', 1200, 800);
await view(p, 'cam'); await settle(p, 2000); await clipShot(p, 'finder.jpg', 1200, 800);
// ライトの絵: 3D で寄って、光と影が主役になる角度
await view(p, 'pers'); await p.evaluate(() => { const sp = window.__sp; sp.setAmbient(18); if (sp.orbit) { sp.orbit.theta = 0.9; sp.orbit.phi = 0.55; sp.orbit.radius = 7; } sp.render(); }); await settle(p, 2500);
await clipShot(p, 'lights.jpg', 1200, 800);
await p.evaluate(() => { const sp = window.__sp; sp.setAmbient(25); sp.render(); });
// 用紙（sheet.jpg）は寺村さんの実物のスクリーンショット。ここでは焼かない（上書きしないこと）
await ctx.close();

// --- スマホ（iPhone くらい） ---
const m = await br.newContext({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'ja-JP',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const q = await m.newPage(); await route(q);
q.on('pageerror', e => console.log('PAGEERROR', e.message));
await q.goto('http://localhost:8790/'); await q.waitForTimeout(1500);
await q.evaluate(() => { const sp = window.__sp; sp.select(sp.state().items.find(i => i.type === 'person')?.id); });
await q.waitForFunction(() => !!window.__sp.poses(), null, { timeout: 15000 }).catch(() => {});
await q.evaluate(compose);
await q.waitForFunction(loaded, null, { timeout: 90000 });
await q.evaluate(() => { const sp = window.__sp; sp.rebuild(); sp.select(null); });
await view(q, 'pers'); await settle(q, 2500);
{ const buf = await q.screenshot({ type: 'jpeg', quality: 84 }); fs.writeFileSync(path.join(OUT, 'mobile.jpg'), buf); console.log('mobile.jpg', (buf.length / 1024).toFixed(0) + ' KB'); }
await m.close();
// 人物の一覧: + を押したところ（14 体のサムネイル）。2 倍で撮る
{ const c2 = await br.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ja-JP' });
  const q = await c2.newPage(); await route(q); await q.goto('http://localhost:8790/'); await q.waitForTimeout(1500);
  await q.click('#addfab'); await q.waitForTimeout(800);
  const el = await q.$('#people'); const buf = await el.screenshot({ type: 'jpeg', quality: 86 }); fs.writeFileSync(path.join(OUT, 'people.jpg'), buf); console.log('people.jpg', (buf.length / 1024).toFixed(0) + ' KB');
  await c2.close(); }
await br.close(); srv.close();
