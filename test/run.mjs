// Headless check for Studio Planner. Serves the app, drives it, and asserts the
// things that have actually broken before: JS errors, share-link round trips,
// imported model dimensions, sensor conversions, and the printed sheet.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');                 // the app itself
const NM = path.join(HERE, 'node_modules');         // three.js, served in place of the CDN
const OUT = path.join(HERE, 'out');                 // screenshots land here
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (label, cond, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };

// a 2 x 1 x 3 m box, hand-built so the importer has something with known dimensions
function makeGLB(){
  const verts = new Float32Array([-1,0,-0.5, 1,0,-0.5, 1,3,-0.5, -1,3,-0.5, -1,0,0.5, 1,0,0.5, 1,3,0.5, -1,3,0.5]);
  const idx = new Uint32Array([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,3,7, 0,7,4, 1,5,6, 1,6,2, 3,2,6, 3,6,7, 0,4,5, 0,5,1]);
  const vb = Buffer.from(verts.buffer), ib = Buffer.from(idx.buffer), bin = Buffer.concat([vb, ib]);
  const json = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0}, indices:1}]}], buffers:[{byteLength:bin.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:vb.length,target:34962},{buffer:0,byteOffset:vb.length,byteLength:ib.length,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-1,0,-0.5],max:[1,3,0.5]},{bufferView:1,componentType:5125,count:36,type:'SCALAR'}] };
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const header = Buffer.alloc(12); header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4E4F534A, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([header, jc, js, bc, bin]);
}
// 同じ箱を 2 つのマテリアルで塗り分けたもの。片方の名前に glass を入れてある。
// 書き出し側が alphaMode を立てていなくても、名前だけで窓として扱えることを見る。
function makeGlassGLB(){
  const verts = new Float32Array([-1,0,-0.5, 1,0,-0.5, 1,3,-0.5, -1,3,-0.5, -1,0,0.5, 1,0,0.5, 1,3,0.5, -1,3,0.5]);
  const body = new Uint32Array([0,1,2, 0,2,3, 4,6,5, 4,7,6, 0,3,7, 0,7,4, 1,5,6, 1,6,2]);
  const glass = new Uint32Array([3,2,6, 3,6,7, 0,4,5, 0,5,1]);
  const vb = Buffer.from(verts.buffer), ib = Buffer.from(body.buffer), gb = Buffer.from(glass.buffer);
  const bin = Buffer.concat([vb, ib, gb]);
  const json = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    materials:[{name:'body_paint'}, {name:'Car_Glass', pbrMetallicRoughness:{baseColorFactor:[0.1,0.13,0.16,1]}}],
    meshes:[{primitives:[{attributes:{POSITION:0}, indices:1, material:0}, {attributes:{POSITION:0}, indices:2, material:1}]}],
    buffers:[{byteLength:bin.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:vb.length,target:34962},
                 {buffer:0,byteOffset:vb.length,byteLength:ib.length,target:34963},
                 {buffer:0,byteOffset:vb.length+ib.length,byteLength:gb.length,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-1,0,-0.5],max:[1,3,0.5]},
               {bufferView:1,componentType:5125,count:body.length,type:'SCALAR'},
               {bufferView:2,componentType:5125,count:glass.length,type:'SCALAR'}] };
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const header = Buffer.alloc(12); header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4E4F534A, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([header, jc, js, bc, bin]);
}
const encodeState = st => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(st)))
  .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

const MIME = {'.html':'text/html; charset=utf-8', '.glb':'model/gltf-binary', '.json':'application/json',
  '.webmanifest':'application/manifest+json', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0].split('#')[0]);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'text/javascript'});
  res.end(fs.readFileSync(p));
}).listen(8765);

// PW_CHROME lets a sandboxed CI point at a preinstalled browser; normally Playwright finds its own
const browser = await chromium.launch({
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  // without a UTF-8 locale Chromium throws away non-ASCII download names and calls
  // every file "download", which looks exactly like a bug in the app
  env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' },
});
async function open(name, viewport, mobile = false, hash = ''){
  // Service Worker はページの route を素通りして本物の CDN を取りに行くので、
  // three をローカルへ差し替えているこの一連の確認では止めておく。
  // オフラインそのものは最後のブロックで別に確かめる。
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.170.0/', '');
    const f = path.join(NM, 'three', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }); else route.fulfill({ status: 404 });
  });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://localhost:8765/' + hash);
  await page.waitForTimeout(1500);
  const add = async sel => { await page.click('#addfab'); await page.click(sel); await page.waitForTimeout(350); };
  const addPerson = async id => { await page.click('#addfab'); await page.click(`#people button[data-model="${id}"]`); await page.waitForTimeout(500); };
  const tab = async n => { await page.click(`[data-tab="${n}"]`); await page.waitForTimeout(150); };
  return { name, ctx, page, errors, add, addPerson, tab };
}

// --- 1. desktop: place things, drive the manipulator, check the sensor panel ----------
{
  const t = await open('desktop', { width: 1500, height: 950 });
  for (const m of ['asia-casual-man','asia-casual-woman','af-business-man','us-casual-woman']) await t.addPerson(m);
  for (const k of ['car','chair','table','box','mirror','chroma']) await t.add(`[data-add="${k}"]`);
  const rows = await t.page.$$eval('#items .itemrow > button.name', b => b.map(x => x.textContent.trim()));
  ok('all presets placed', rows.length === 13, `${rows.length} rows`);
  ok('人 labelled by kind', rows.some(r => r.startsWith('男性')) && rows.some(r => r.startsWith('女性')));

  // a second camera becomes the active one
  await t.add('[data-add="camera"]');
  const camState = await t.page.evaluate(() => { const st = window.__sp.state();
    return {n: st.items.filter(i => i.type === 'camera').length, active: st.activeCam}; });
  ok('two cameras, one marked active', camState.n === 2 && !!camState.active, JSON.stringify(camState));

  // sensor: pick 手動, type a width, save it under a name
  await t.page.click('[data-set="sensor"][data-val="custom"]');
  await t.page.fill('[data-num="sensorW"]', '24.9');
  await t.page.press('[data-num="sensorW"]', 'Enter');
  await t.page.waitForTimeout(250);
  await t.page.fill('[data-sensorname]', 'うちのV-RAPTOR');
  await t.page.click('[data-sensorsave]');
  await t.page.waitForTimeout(250);
  const info = await t.page.textContent('#info');
  ok('saved sensor name shows in the readout', info.includes('うちのV-RAPTOR'), info.split('\n')[1]);
  await t.page.click('[data-set="sensor"][data-val="s35"]');
  await t.page.waitForTimeout(250);
  const lenses = await t.page.$$eval('[data-set="focal"]', b => b.map(x => x.textContent).join(' '));
  ok('スーパー35 offers cine primes', lenses.includes('18mm') && lenses.includes('32mm'), lenses);
  ok('35mm equivalent computed', (await t.page.textContent('#info')).includes('換算'), (await t.page.textContent('#info')).split('\n')[1]);

  // rotate ring: grab a person and drag the ring half a turn
  await t.page.click('[data-view="plan"]');
  await t.page.click('#pipbtn');                                   // the window would sit over the ring
  await t.page.click('#items .itemrow:nth-child(2) > button.name');
  await t.page.waitForTimeout(300);
  const before = await t.page.inputValue('[data-range="rot"]');
  // リングは世界座標で置かれている。画面のどこに来ているかを投影して求める
  const ring = await t.page.evaluate(() => {
    const sp = window.__sp, g = sp.gizmo, cam = sp.camera(), V = sp.THREE.Vector3;
    const r = document.getElementById('view').getBoundingClientRect();
    const toS = p => { const q = p.clone().project(cam); return {x: r.x + (q.x+1)/2*r.width, y: r.y + (1-q.y)/2*r.height}; };
    const c = new V().setFromMatrixPosition(g.matrixWorld);
    return {c: toS(c), e: toS(new V(1,0,0).applyMatrix4(g.matrixWorld)), far: toS(new V(2.2,0,0).applyMatrix4(g.matrixWorld))};
  });
  const rad = Math.hypot(ring.e.x - ring.c.x, ring.e.y - ring.c.y);
  await t.page.mouse.move(ring.e.x, ring.e.y); await t.page.mouse.down();
  await t.page.mouse.move(ring.c.x + rad*0.7, ring.c.y - rad*0.7, {steps:6});
  await t.page.mouse.move(ring.c.x, ring.c.y - rad, {steps:6}); await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  ok('ring drag turns the item', (await t.page.inputValue('[data-range="rot"]')) !== before, `${before} -> ${await t.page.inputValue('[data-range="rot"]')}`);

  // リングのはるか外は、もう回転にならない（以前は半径の 1.5 倍まで拾っていた）
  const rotOf = () => t.page.evaluate(() => {
    const it = window.__sp.state().items.find(i => i.type === 'person');
    return {rot: it.rot, x: +it.x.toFixed(3), z: +it.z.toFixed(3)};
  });
  const spun = await rotOf();
  await t.page.mouse.move(ring.far.x, ring.far.y); await t.page.mouse.down();
  await t.page.mouse.move(ring.far.x + 30, ring.far.y - 40, {steps:5}); await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  const after = await rotOf();
  ok('far outside the ring neither turns nor moves it',
     after.rot === spun.rot && after.x === spun.x && after.z === spun.z,
     `${JSON.stringify(spun)} -> ${JSON.stringify(after)}`);
  await t.page.click('#pipbtn');

  // typing an exact number into a slider readout
  await t.page.click('#items .itemrow[data-kind="table"] > button.name');
  await t.page.waitForTimeout(250);
  await t.page.click('[data-edit="w"]');
  await t.page.fill('input.vedit', '2.4');
  await t.page.press('input.vedit', 'Enter');
  await t.page.waitForTimeout(300);
  ok('typed number reaches the slider', (await t.page.inputValue('[data-range="w"]')) === '2.4', await t.page.inputValue('[data-range="w"]'));

  // the drawing names a reflector by its long and short side, a backdrop by w x d
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(600);
  const drawn = await t.page.$$eval('#labels span', n => n.map(x => x.textContent));
  ok('so does the backdrop', drawn.some(x => /布幅/.test(x)), drawn.filter(x => x.includes('幅')).join(' | '));
  const boxes = await t.page.$$eval('#labels span', n => n.map(e => { const r = e.getBoundingClientRect(); return {l:r.left, r:r.right, t:r.top, b:r.bottom}; }));
  let overlap = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i+1; j < boxes.length; j++){
    const a = boxes[i], b = boxes[j];
    if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlap++;
  }
  ok('no two dimension labels overlap', overlap === 0, `${overlap} overlapping pairs of ${boxes.length}`);

  // the distance line belongs to the object now, and only appears when switched on
  await t.page.click('#items .itemrow[data-kind="person"] > button.name');
  await t.page.waitForTimeout(250);
  ok('objects carry a カメラまで switch', await t.page.$('[data-dim="dimCam"]') !== null);
  ok('cameras no longer carry 被写体まで', await t.page.$('[data-dim="dimSubject"]') === null);
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(500);
  await t.page.click('[data-dim="dimCam"]'); await t.page.waitForTimeout(400);
  await t.page.click('#items .itemrow[data-kind="box"] > button.name'); await t.page.waitForTimeout(500);
  const lines = (await t.page.$$eval('#labels span', n => n.map(x => x.textContent))).filter(x => x.includes('まで'));
  // the switched-on person keeps its line; the box only has one because it is selected
  ok('a switched-on object keeps its line', lines.some(x => x.startsWith('男性まで')), lines.join(' | '));
  ok('only switched-on and selected objects are measured',
     lines.filter(x => !x.includes('壁まで')).length === 2, lines.join(' | '));

  // views and the wall rules
  for (const v of ['side','pers','cam','plan']){ await t.page.click(`[data-view="${v}"]`); await t.page.waitForTimeout(450); }
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(500);
  await t.page.screenshot({ path: `${OUT}/desktop-pers.png` });
  await t.page.click('[data-view="side"]'); await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: `${OUT}/desktop-side.png` });

  await t.tab('share');
  const link = await t.page.inputValue('#linkbox');
  // 辺ごとの寸法は、ラベルが押し合わない素の場面で見る（上の場面は 7 個ぶん詰めてある）
  {
    const solo = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:10,d:8,h:4.5,cove:{back:true,left:true,right:true}},
      activeCam:'c1', items:[{id:'w1',type:'mirror',x:0,z:0,rot:0,kind:'floor',w:3,h:2},
        {id:'c1',type:'camera',x:0,z:3,y:1.3,rot:180,pitch:-6,roll:0,sensor:'ff',focal:35,aspect:'16:9'}]};
    const so = await open('mirror-dims', { width: 1200, height: 800 }, false, '#s=' + encodeState(solo));
    await so.page.click('[data-view="plan"]'); await so.page.waitForTimeout(700);
    const md = await so.page.$$eval('#labels span', n => n.map(x => x.textContent));
    ok('the reflector names each edge on its own',
       md.some(x => /床鏡幅/.test(x)) && md.some(x => /床鏡奥行/.test(x)), md.join(' | '));
    await so.ctx.close();
  }
  ok('share link built', link.includes('#s='), `${link.length} chars`);
  ok('desktop run clean', t.errors.length === 0, t.errors.join(' | '));
  global.__link = link;
  await t.ctx.close();
}

// --- 2. mobile: the shared link restores, and touch selects ---------------------------
{
  const hash = global.__link.slice(global.__link.indexOf('#'));
  const t = await open('mobile', { width: 390, height: 844 }, true, hash);
  const n = await t.page.$$eval('#items .itemrow', b => b.length);
  ok('link restores every row on mobile', n === 14, `${n} rows`);   // 1 studio row + 13 items
  const box = await t.page.$eval('#view', e => { const r = e.getBoundingClientRect(); return {x:r.x + r.width/2, y:r.y + r.height/2}; });
  await t.page.touchscreen.tap(box.x, box.y);
  await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: `${OUT}/mobile.png` });
  ok('mobile run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 3. model import, and the box fallback for someone without the file ---------------
{
  const t = await open('import', { width: 1400, height: 900 });
  const glb = `${OUT}/test-box.glb`; fs.writeFileSync(glb, makeGLB());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', glb);
  await t.page.waitForTimeout(2500);
  const dims = await t.page.evaluate(() => { const m = window.__sp.state().items.find(i => i.type === 'model');
    return m && [m.w, m.d, m.h].map(v => +v.toFixed(2)).join('×'); });
  ok('GLB imported at its true size', dims === '2×1×3', String(dims));
  ok('height field matches', (await t.page.inputValue('[data-num="targetH"]')) === '3.00');
  ok('FBX loader resolves through the importmap',
     (await t.page.evaluate(() => import('three/addons/loaders/FBXLoader.js').then(m => typeof m.FBXLoader).catch(e => 'ERR ' + e.message))) === 'function');
  ok('import run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  const shared = {meta:{project:'',cut:'',memo:''}, studio:{w:8,d:6,h:4,cove:{back:true,left:false,right:false}}, activeCam:'c1', items:[
    {id:'c1',type:'camera',x:0,z:2.4,y:1.3,rot:180,pitch:-6,sensor:'ff',focal:35,aspect:'16:9'},
    {id:'m1',type:'model',x:0,z:0,rot:0,key:'missing',name:'set.glb',scale:1,upFix:false,w:2,d:1,h:3}]};
  const g = await open('shared', { width: 1280, height: 800 }, false, '#s=' + encodeState(shared));
  await g.page.click('#items .itemrow[data-kind="model"] > button.name'); await g.page.waitForTimeout(300);
  const note = await g.page.textContent('#selbody');
  ok('a model this device lacks shows as a box', note.includes('実寸の箱'), note.slice(0, 40));
  ok('shared run clean', g.errors.length === 0, g.errors.join(' | '));
  await g.ctx.close();
}

// --- 4. links written before the format list and the meta block still open -----------
{
  const legacy = {studio:{w:8,d:6,h:4,cove:true}, items:[
    {id:'c1',type:'camera',x:0,z:2,y:1.4,rot:270,pitch:0,sensor:'apsc',focal:35,aspect:'3:2'}]};
  const t = await open('legacy', { width: 1280, height: 800 }, false, '#s=' + encodeState(legacy));
  const info = await t.page.textContent('#info');
  ok('APS-C link becomes a 23.5 mm manual width', info.includes('23.5mm'), info.split('\n')[1]);
  ok('legacy run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 5. the printed sheet -------------------------------------------------------------
{
  const t = await open('pdf', { width: 1500, height: 950 });
  await t.add('[data-add="chroma"]');
  await t.tab('cut');                                  // カット名とメモはカットタブへ移した
  await t.page.fill('#m-cut', 'C-12');
  await t.page.fill('#m-memo', '演者は白ホリ手前 2m。\nレフ板は下手から。');
  await t.tab('share');
  await t.page.click('#makepdf');                      // 用紙の項目は押したあとの画面に出る
  await t.page.waitForTimeout(2500);
  ok('the paper options moved onto the sheet',
     !!(await t.page.$('.pmbar [data-orient="landscape"]')) &&
     (await t.page.$$eval('.pmbar [data-pane]', n => n.map(x => x.dataset.pane).join(','))) === 'plan,side,front,pers,cam',
     await t.page.$$eval('.pmbar [data-pane]', n => n.map(x => x.dataset.pane).join(',')));
  await t.page.fill('#m-project', 'コスモ石油 CM 30秒');
  await t.page.waitForTimeout(300);
  for (const o of ['landscape','portrait']){
    await t.page.click(`.pmbar [data-orient="${o}"]`);
    await t.page.waitForTimeout(3000);
    const panels = await t.page.$$eval('.paper .pv img', n => n.length);
    const labels = await t.page.$$eval('.paper .pv .lb', n => n.length);
    ok(`${o}: four panels drawn`, panels === 4, `${panels} panels, ${labels} labels`);
    ok(`${o}: dimensions kept as text`, labels > 0);
    await t.page.screenshot({ path: `${OUT}/pdf-${o}.png` });
    // the real proof: let Chromium make the PDF and check the page count and size
    const buf = await t.page.pdf({ preferCSSPageSize: true, printBackground: true });
    fs.writeFileSync(`${OUT}/sheet-${o}.pdf`, buf);
    const s = buf.toString('latin1');
    const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
    const mb = (s.match(/\/MediaBox\s*\[([^\]]*)\]/) || [])[1] || '';
    const [, , wpt, hpt] = mb.trim().split(/\s+/).map(Number);
    const wmm = Math.round(wpt/72*25.4), hmm = Math.round(hpt/72*25.4);
    const want = o === 'landscape' ? [297,210] : [210,297];
    ok(`${o}: one page`, pages === 1, `${pages} pages, ${(buf.length/1024).toFixed(0)} KB`);
    ok(`${o}: A4 at the right orientation`, wmm === want[0] && hmm === want[1], `${wmm} x ${hmm} mm`);
    if (o === 'landscape'){
      const pane = await t.page.$('.paper .pv[data-pane="plan"]');
      const b = await pane.boundingBox();
      await t.page.mouse.move(b.x + b.width/2, b.y + b.height/2);
      await t.page.mouse.down();
      await t.page.mouse.move(b.x + b.width/2 + 40, b.y + b.height/2 + 25, {steps:6});
      await t.page.mouse.up();
      await t.page.waitForTimeout(200);
      const moved = await t.page.$eval('.paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('a panel can be dragged to reframe it', /translate\(-?[1-9]/.test(moved), moved);
      await t.page.mouse.wheel(0, -200); await t.page.waitForTimeout(200);
      const zoomed = await t.page.$eval('.paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('the wheel zooms a panel', !/scale\(1\.000\)/.test(zoomed), zoomed);
      await t.page.click('#framereset'); await t.page.waitForTimeout(200);
      const back = await t.page.$eval('.paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('reset puts every panel back', /translate\(0%,\s*0%\)\s*scale\(1\)/.test(back), back);

      // the finder must stay exactly what the camera sees, so it takes no reframing
      const fb = await (await t.page.$('.paper .pv[data-pane="cam"]')).boundingBox();
      await t.page.mouse.move(fb.x + fb.width/2, fb.y + fb.height/2);
      await t.page.mouse.down();
      await t.page.mouse.move(fb.x + fb.width/2 + 45, fb.y + fb.height/2 + 30, {steps:6});
      await t.page.mouse.up();
      await t.page.mouse.wheel(0, -200);
      await t.page.waitForTimeout(200);
      const fin = await t.page.$eval('.paper .pv[data-pane="cam"] .pvin', e => e.style.transform);
      ok('the finder cannot be reframed', /translate\(0%,\s*0%\)\s*scale\(1\)/.test(fin), fin);
    }
  }
  const head = await t.page.$eval('.paper .ph', e => e.innerText.replace(/\n/g, ' | '));
  ok('header carries project, cut and stamp', head.includes('コスモ石油') && head.includes('C-12') && /\d{4}\/\d{2}\/\d{2}/.test(head), head);
  // 記載内容: 正面を足して 5 枚、削って 2 枚
  await t.page.click('.pmbar [data-orient="landscape"]'); await t.page.waitForTimeout(3000);
  await t.page.click('.pmbar [data-pane="front"]'); await t.page.waitForTimeout(4000);
  const five = await t.page.$$eval('.paper .pv', n => n.map(x => x.dataset.pane).join(','));
  ok('正面 can be added to the sheet', five === 'plan,side,front,pers,cam', five);
  ok('and an odd one out runs the full width',
     (await t.page.$$eval('.paper .pv[style*="grid-column"]', n => n.map(x => x.dataset.pane).join(','))) === 'cam');
  for (const v of ['plan','side','pers']){ await t.page.click(`.pmbar [data-pane="${v}"]`); await t.page.waitForTimeout(2500); }
  const two = await t.page.$$eval('.paper .pv', n => n.map(x => x.dataset.pane).join(','));
  ok('and panels can be taken away', two === 'front,cam', two);
  ok('two panels stack instead of standing side by side',
     /repeat\(1,\s*1fr\)/.test(await t.page.$eval('.paper .pviews', e => e.style.gridTemplateColumns)),
     await t.page.$eval('.paper .pviews', e => e.style.gridTemplateColumns));
  await t.page.click('.pmbar [data-pane="front"]'); await t.page.waitForTimeout(2500);
  await t.page.click('.pmbar [data-pane="cam"]'); await t.page.waitForTimeout(600);
  ok('the last panel cannot be taken away', (await t.page.$$eval('.paper .pv', n => n.length)) === 1,
     await t.page.textContent('#toast'));
  await t.page.screenshot({ path: `${OUT}/pdf-panes.png` });
  await t.page.click('#paperclose');
  await t.page.waitForTimeout(500);
  await t.page.screenshot({ path: `${OUT}/pdf-after.png` });
  ok('pdf run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 6. viewer mode -------------------------------------------------------------------
{
  const hash = global.__link.slice(global.__link.indexOf('#'));
  const t = await open('viewer', { width: 390, height: 844 }, true, hash + '&m=v');
  ok('viewer hides the editing panel', await t.page.$eval('#panel', e => getComputedStyle(e).display === 'none'));
  ok('viewer run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 7. the project file round trip ----------------------------------------------------
{
  const t = await open('projfile', { width: 1280, height: 800 });
  await t.add('[data-add="chroma"]');
  await t.add('[data-add="mirror"]');
  await t.tab('cut');
  await t.page.fill('#m-cut', 'C-3');
  await t.page.waitForTimeout(200);
  await t.tab('share');
  await t.page.click('#makepdf'); await t.page.waitForTimeout(2500);   // 案件名は用紙の画面にある
  await t.page.fill('#m-project', '青山スタジオ 下見');
  await t.page.waitForTimeout(300);
  await t.page.click('#paperclose'); await t.page.waitForTimeout(300);
  const before = await t.page.$$eval('#items .itemrow', n => n.length);

  // desktop Chrome path: the real save dialog, stubbed so headless can watch it
  await t.page.evaluate(() => {
    window.__picked = null;
    window.showSaveFilePicker = async opts => {
      window.__picked = {name: opts.suggestedName, types: opts.types};
      return { createWritable: async () => ({
        write: async b => { window.__written = typeof b === 'string' ? b : await b.text(); },
        close: async () => {},
      }) };
    };
  });
  await t.page.click('#savefile');
  await t.page.waitForTimeout(400);
  const picked = await t.page.evaluate(() => ({p: window.__picked, w: window.__written}));
  ok('save opens the save dialog rather than downloading',
     !!picked.p && picked.p.name.includes('青山スタジオ') && picked.p.name.includes('C-3')
     && /\d{4}-\d{2}-\d{2}/.test(picked.p.name) && picked.p.name.endsWith('.json'), picked.p?.name);
  const viaPicker = JSON.parse(picked.w);
  ok('the dialog is handed the whole scene',
     viaPicker.cuts?.[0].items.length === before - 1 && viaPicker.cuts[0].name === 'C-3',
     JSON.stringify(Object.keys(viaPicker)));

  // a closed dialog leaves nothing behind
  await t.page.evaluate(() => {
    window.showSaveFilePicker = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };
  });
  await t.page.click('#savefile');
  await t.page.waitForTimeout(300);
  ok('closing the dialog saves nothing', !await t.page.$eval('#namedlg', e => e.classList.contains('on')));

  // everywhere else: the app asks for the name itself, then hands the file over
  await t.page.evaluate(() => { delete window.showSaveFilePicker; });
  await t.page.click('#savefile');
  await t.page.waitForTimeout(300);
  ok('without a save dialog the app asks for the name', await t.page.$eval('#namedlg', e => e.classList.contains('on')));
  const suggested = await t.page.inputValue('#namein');
  await t.page.fill('#namein', '下見メモ');
  const dl = await Promise.all([t.page.waitForEvent('download'), t.page.click('#nameok')]).then(r => r[0]);
  const name = dl.suggestedFilename();
  const file = path.join(OUT, 'project.json');
  await dl.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('the typed name is used, with the extension kept', name === '下見メモ.json', `${name} (suggested ${suggested})`);
  ok('the file holds the whole scene', saved.cuts[0].items.length === before - 1 && saved.cuts[0].name === 'C-3',
     `${saved.cuts[0].items.length} items in ${saved.cuts.length} cut(s)`);

  // 別のセッションで開き直す。これが「来月また開く」の実際の手順でもある
  const f = await open('projload', { width: 1280, height: 800 });
  await f.tab('share');
  await f.page.setInputFiles('#projfile', file);
  await f.page.waitForTimeout(900);
  const after = await f.page.$$eval('#items .itemrow', n => n.length);
  ok('a saved file opens in a fresh session', after === before, `${after} rows, was ${before}`);
  await f.tab('cut');
  ok('and brings the meta back', await f.page.inputValue('#m-cut') === 'C-3');
  await f.tab('share');
  await f.page.setInputFiles('#projfile', path.join(HERE, 'package.json'));
  await f.page.waitForTimeout(400);
  ok('a file that is not a scene is refused, not applied',
     (await f.page.textContent('#toast')).includes('読めません') && await f.page.$$eval('#items .itemrow', n => n.length) === after);
  ok('project load run clean', f.errors.length === 0, f.errors.join(' | '));
  await f.ctx.close();
  // the PNG dialog hands over a file the same way
  await t.page.click('#png');
  await t.page.waitForTimeout(1200);
  await t.page.click('#shotdl');
  await t.page.waitForTimeout(300);
  const pngSuggest = await t.page.inputValue('#namein');
  const png = await Promise.all([t.page.waitForEvent('download'), t.page.click('#nameok')]).then(r => r[0]);
  ok('the image dialog saves a named PNG', png.suggestedFilename().endsWith('.png') && pngSuggest.includes('青山スタジオ'), pngSuggest);
  await t.page.click('#shotclose');

  ok('project file run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 8. the built-in person model -------------------------------------------------------
{
  const t = await open('person', { width: 1280, height: 800 });
  await t.page.click('#items .itemrow > button.name >> nth=1');   // the default 男性
  await t.page.waitForTimeout(300);
  await t.page.waitForTimeout(3000);
  ok('a person carries the kind chosen at the + button',
     await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'person').kind) === 'man');
  ok('and no mannequin switch is offered', await t.page.$$eval('[data-set="look"]', b => b.length) === 0);
  await t.page.screenshot({ path: `${OUT}/person-real.png` });

  // the scan is 1 m tall in the file; the height slider still has to rule
  // Box3.setFromObject は骨の変形を見ないので、アプリが測った値（userData.top）を読む
  const measure = () => t.page.evaluate(() => {
    const sp = window.__sp, g = sp.group(sp.state().items.find(i => i.type === 'person').id);
    const b = new sp.THREE.Box3().setFromObject(g);
    return {h: +(g.userData.top ?? (b.max.y - b.min.y)).toFixed(3), minY: +b.min.y.toFixed(3)};
  });
  const box = await measure();
  ok('the model is scaled to the height that is set', Math.abs(box.h - 1.7) < 0.02, `${box.h} m tall, feet at ${box.minY}`);

  // ポーズ一覧は畳まない。畳むと在ることに気づかれなかった
  await t.page.waitForTimeout(600);
  const poses = await t.page.$$eval('[data-pose]', b => b.map(x => x.dataset.pose));
  ok('the pose list is open from the start, with the plain stance first',
     poses.length === 8 && poses[0] === 'none', poses.join(', '));
  ok('the ones taken out of the list stay out',
     !poses.some(p => ['stand-1','stand-4','walk','dance'].includes(p)), poses.join(', '));
  ok('and there is nothing left to unfold', await t.page.$$eval('.disc', b => b.length) === 0);
  ok('the pose list sits at the bottom, under the direction slider',
     await t.page.$eval('#selbody', el => {
       const kids = [...el.children];
       return kids.findIndex(k => k.classList.contains('poses')) === kids.length - 1
           && kids[kids.length - 2].textContent.includes('ポーズ');
     }));
  const poseThumbs = await t.page.$$eval('.poses img', i => i.map(x => x.naturalWidth));
  ok('the pose thumbnails load', poseThumbs.length === 8 && poseThumbs.every(w => w === 200), poseThumbs.join(','));

  await t.page.click('[data-pose="sit-chair"]');
  await t.page.waitForTimeout(700);
  const sit = await measure();
  ok('sitting lowers the figure but keeps the model',
     sit.h > 1.0 && sit.h < 1.45 && await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'person').model) !== null,
     `${sit.h} m`);
  ok('and the settings panel says which pose', (await t.page.textContent('#selbody')).includes('椅子'));
  await t.page.screenshot({ path: `${OUT}/pose-sit.png` });

  await t.page.click('[data-pose="lie-up"]');
  await t.page.waitForTimeout(700);
  const lie = await measure();
  ok('lying down is flat and still on the floor', lie.h < 0.6 && Math.abs(lie.minY) < 0.01, `${lie.h} m, minY ${lie.minY}`);

  await t.page.click('[data-pose="none"]');
  await t.page.waitForTimeout(700);
  const back = await measure();
  ok('the plain pose gives the height back', Math.abs(back.h - 1.7) < 0.02, `${back.h} m`);

  // shrinking someone used to turn them into a child and drop the model
  const setHeight = async v => {                    // through the readout, as a person would
    await t.page.click('[data-edit="height"]');
    await t.page.fill('input.vedit', v);
    await t.page.press('input.vedit', 'Enter');
    await t.page.waitForTimeout(700);
  };
  await setHeight('1.30');
  const small = await measure();
  ok('a shorter person keeps the model, and the label', Math.abs(small.h - 1.30) < 0.02, `${small.h} m`);
  ok('the list still calls them 男性',
     (await t.page.textContent('#items .itemrow >> nth=1')).includes('男性'));
  await setHeight('1.75');
  // a share link carries the choice, because the file ships with the app
  const link = await t.page.evaluate(() => location.hash);
  ok('the choice rides in the share link', link.length > 10);

  // the + panel offers the cast as pictures, and placing one puts that model in
  await t.page.click('#addfab');
  await t.page.waitForTimeout(400);
  const cast = await t.page.$$eval('#people button[data-model]', b => b.map(x => x.dataset.model));
  ok('every model is offered as a thumbnail', cast.length === 11, cast.join(', '));
  const thumbs = await t.page.$$eval('#people img', imgs => imgs.map(i => i.naturalWidth));
  ok('the thumbnails actually load', thumbs.length === 11 && thumbs.every(w => w === 200), thumbs.join(','));
  await t.page.click('#people button[data-model="af-business-woman"]');
  await t.page.waitForTimeout(2500);
  const placed = await t.page.evaluate(() => {
    const it = window.__sp.state().items.at(-1);
    return {model: it.model, kind: it.kind, height: it.height};
  });
  ok('the placed person carries that model', placed.model === 'af-business-woman' && placed.kind === 'woman',
     JSON.stringify(placed));
  ok('and the height that goes with her', Math.abs(placed.height - 1.58) < 0.001, String(placed.height));
  const herH = await t.page.evaluate(() => {
    const sp = window.__sp, g = sp.group(sp.state().items.at(-1).id);
    const b = new sp.THREE.Box3().setFromObject(g);
    return +(b.max.y - b.min.y).toFixed(3);
  });
  ok('and she is drawn at that height', Math.abs(herH - 1.58) < 0.02, `${herH} m`);
  await t.page.screenshot({ path: `${OUT}/cast.png` });

  ok('the + panel no longer offers mannequins', await t.page.$$eval('[data-person]', b => b.length) === 0);

  // 箱の上には乗れる
  await t.add('[data-add="box"]');
  const who = await t.page.evaluate(() => {
    const st = window.__sp.state(), box = st.items.at(-1), p = st.items.find(i => i.type === 'person');
    box.x = 2; box.z = 2; box.h = 0.6;
    p.x = 2; p.z = 2;                       // 箱の真上へ
    return p.id;
  });
  await t.page.click('#items .itemrow > button.name >> nth=1');   // 人に戻る
  await t.page.waitForTimeout(300);
  await setHeight('1.70');                   // 置き直させる（setProp -> rebuildItem -> restack）
  const onBox = await t.page.evaluate(id => +window.__sp.group(id).position.y.toFixed(3), who);
  ok('a person on a box stands on top of it', Math.abs(onBox - 0.6) < 0.002, String(onBox));
  await t.page.evaluate(() => { const p = window.__sp.state().items.find(i => i.type === 'person'); p.x = -2; p.z = -2; });
  await setHeight('1.71');
  const offBox = await t.page.evaluate(id => +window.__sp.group(id).position.y.toFixed(3), who);
  ok('and back on the floor when it steps off', Math.abs(offBox) < 0.002, String(offBox));
  await t.page.screenshot({ path: `${OUT}/on-box.png` });

  ok('person run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  // where the file cannot be fetched the mannequin stays and the panel says why
  const g = await open('person-404', { width: 1280, height: 800 });
  // the model is fetched at load, so the block has to be in place before the reload
  await g.page.route('**/models/*.glb', r => r.fulfill({status: 404}));
  await g.page.reload();
  await g.page.waitForTimeout(2500);
  await g.page.click('#items .itemrow > button.name >> nth=1');
  await g.page.waitForTimeout(500);
  const txt = await g.page.textContent('#selbody');
  ok('a missing model explains itself', txt.includes('サーバーから開いたとき'), txt.slice(0, 60));
  const h = await g.page.evaluate(() => {
    const sp = window.__sp, gr = sp.group(sp.state().items.find(i => i.type === 'person').id);
    const b = new sp.THREE.Box3().setFromObject(gr);
    return +(b.max.y - b.min.y).toFixed(3);
  });
  ok('and the mannequin is still standing there', Math.abs(h - 1.7) < 0.05, `${h} m`);
  ok('missing-model run clean', g.errors.length === 0, g.errors.join(' | '));
  await g.ctx.close();
}

// --- 10. hit ranges, the right-click menu, the list buttons, the edge handles ------
{
  const t = await open('handles', { width: 1300, height: 900 });
  const P = t.page;
  const world = (x, z, y = 0) => P.evaluate(([x, y, z]) => {
    const sp = window.__sp, r = document.getElementById('view').getBoundingClientRect();
    const q = new sp.THREE.Vector3(x, y, z).project(sp.camera());
    return { x: r.x + (q.x + 1) / 2 * r.width, y: r.y + (1 - q.y) / 2 * r.height };
  }, [x, y, z]);
  const selId = () => P.evaluate(() => window.__sp.sel());
  const one = type => P.evaluate(t => { const i = window.__sp.state().items.find(o => o.type === t);
    return i ? {id:i.id, type:i.type, x:i.x, z:i.z, w:i.w, h:i.h, locked:!!i.locked} : null; }, type);
  const count = type => P.evaluate(t => window.__sp.state().items.filter(o => o.type === t).length, type);
  await t.add('[data-add="box"]');
  await P.click('#viewbtns button[data-view="plan"]'); await P.waitForTimeout(400);
  await P.evaluate(() => window.__sp.select(null)); await P.waitForTimeout(200);
  const box = await one('box');            // 置かれた場所はアプリが決める

  // 1 m の箱は 1 m の箱ぶんしか選べない。輪郭線が Line.threshold の 1 m を
  // まとっていたころは、外側 1 m を押しても選ばれていた
  let q = await world(box.x + 0.2, box.z); await P.mouse.click(q.x, q.y); await P.waitForTimeout(200);
  ok('geometry selects', await selId() === box.id, String(await selId()));
  q = await world(box.x + 1.3, box.z); await P.mouse.click(q.x, q.y); await P.waitForTimeout(200);
  ok('outside the geometry selects nothing', await selId() === null, String(await selId()));
  // マニピュレータ: 内側が移動、リング上が回転、外は素通り
  q = await world(box.x + 0.2, box.z); await P.mouse.click(q.x, q.y); await P.waitForTimeout(200);
  const hit = async (x, z) => { const s = await world(x, z);
    const r = await P.evaluate(() => document.getElementById('view').getBoundingClientRect().x);
    return P.evaluate(([x, y]) => JSON.stringify(window.__sp.pick(x, y)), [s.x - r, s.y]); };
  ok('inside the ring moves', (await hit(box.x + 0.4, box.z)).includes('move'), await hit(box.x + 0.4, box.z));
  ok('the ring itself rotates', (await hit(box.x + 0.9, box.z)).includes('rotate'), await hit(box.x + 0.9, box.z));
  ok('outside the ring is empty', await hit(box.x + 1.3, box.z) === 'null', await hit(box.x + 1.3, box.z));

  // 右クリックのメニュー
  q = await world(box.x + 0.2, box.z); await P.mouse.click(q.x, q.y, { button: 'right' }); await P.waitForTimeout(300);
  const menu = await P.$$eval('#ctx button', b => b.map(x => x.textContent));
  ok('right click offers rename, lock, copy, delete', menu.join('/') === '名前を変更/ロック/複製/削除', menu.join('/'));
  await P.click('#ctx button >> nth=2'); await P.waitForTimeout(400);
  ok('copy makes a second one', await count('box') === 2);
  await P.keyboard.press('Delete'); await P.waitForTimeout(300);
  ok('and Delete takes it away again', await count('box') === 1);

  // ロック
  q = await world(box.x + 0.2, box.z); await P.mouse.click(q.x, q.y); await P.waitForTimeout(200);
  await P.click('#items .itemrow[data-kind="box"] .ico[aria-label="ロック"]'); await P.waitForTimeout(300);
  ok('the list can lock a row', (await one('box')).locked === true);
  ok('a locked object shows no manipulator', await P.evaluate(() => window.__sp.gizmo.visible) === false);
  const a = await world(box.x + 0.2, box.z), b2 = await world(box.x + 1.6, box.z);
  await P.mouse.move(a.x, a.y); await P.mouse.down(); await P.mouse.move(b2.x, b2.y, { steps: 6 }); await P.mouse.up();
  await P.waitForTimeout(300);
  ok('and does not move when dragged', (await one('box')).x === box.x, String((await one('box')).x));
  await P.click('#items .itemrow[data-kind="box"] .ico.on'); await P.waitForTimeout(300);
  ok('the same button unlocks it', (await one('box')).locked === false);
  await P.click('#items .itemrow[data-kind="box"] .ico.trash'); await P.waitForTimeout(300);
  ok('the trash button removes the row', await count('box') === 0);

  // 背景布の辺を引く
  await t.add('[data-add="chroma"]'); await P.waitForTimeout(500);
  const c0 = await one('chroma');
  const e1 = await world(c0.x + c0.w / 2, c0.z), e2 = await world(c0.x + c0.w / 2 + 1.2, c0.z);
  await P.mouse.move(e1.x, e1.y); await P.mouse.down(); await P.mouse.move(e2.x, e2.y, { steps: 8 }); await P.mouse.up();
  await P.waitForTimeout(400);
  const c1 = await one('chroma');
  ok('dragging an edge widens the backdrop', c1.w > c0.w + 1, `${c0.w} -> ${c1.w}`);
  ok('and the far edge stays put', Math.abs((c1.x - c1.w / 2) - (c0.x - c0.w / 2)) < 0.06);

  // 鏡から水面が消えている
  await t.add('[data-add="mirror"]'); await P.waitForTimeout(400);
  const kinds = await P.$$eval('#selbody [data-set="kind"]', b => b.map(x => x.textContent));
  ok('the mirror has no water any more', kinds.join('/') === '床の鏡/立て鏡', kinds.join('/'));
  ok('handles run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 11. defaults, renaming, per-edge dimensions, the camera on a box ---------------
{
  const t = await open('defaults', { width: 1300, height: 900 });
  const P = t.page;
  const st = () => P.evaluate(() => window.__sp.state());
  ok('the cyclorama starts curved on all three walls',
     JSON.stringify((await st()).studio.cove) === '{"back":true,"left":true,"right":true}',
     JSON.stringify((await st()).studio.cove));
  // 閉じたメニューが小さな棒として画面に残っていた（id 指定の display が [hidden] に勝つ）
  ok('the closed context menu takes no space',
     await P.evaluate(() => { const r = document.getElementById('ctx').getBoundingClientRect(); return !r.width && !r.height; }));
  await P.click('#items .itemrow[data-kind="camera"] > button.name'); await P.waitForTimeout(300);
  ok('the wall distance starts off',
     (await P.$$eval('#selbody [data-dim="dimWall"]', b => b.map(x => x.classList.contains('on')))) [0] === false);
  ok('the settings panel has no delete button of its own',
     await P.$$eval('#selbody [data-del]', b => b.length) === 0);
  ok('the move arrow is drawn once, not doubled',
     await P.evaluate(() => window.__sp.gizmo.children.filter(c => c.geometry.type === 'ShapeGeometry').length) === 1);

  await t.add('[data-add="chroma"]'); await P.waitForTimeout(400);
  const room = (await st()).studio, cloth = (await st()).items.find(i => i.type === 'chroma');
  ok('a backdrop lands clear of the cyclorama', cloth.z > -room.d/2 + 1, `z=${cloth.z}`);
  const kinds = await P.$$eval('#selbody [data-set="kind"]', b => b.map(x => x.textContent));
  await t.add('[data-add="mirror"]'); await P.waitForTimeout(400);
  ok('a standing mirror is not called a bounce board',
     (await P.$$eval('#selbody [data-set="kind"]', b => b.map(x => x.textContent))).join('/') === '床の鏡/立て鏡');

  // 右クリック → 名前を変更
  await P.click('#items .itemrow[data-kind="chroma"] > button.name'); await P.waitForTimeout(200);
  await P.click('#items .itemrow[data-kind="chroma"] > button.name', { button: 'right' }); await P.waitForTimeout(300);
  await P.click('#ctx button >> nth=0'); await P.waitForTimeout(300);
  ok('rename opens a field in the row', await P.$$eval('#items input.ren', n => n.length) === 1);
  await P.fill('#items input.ren', 'ホリ用 白布'); await P.press('#items input.ren', 'Enter'); await P.waitForTimeout(400);
  ok('the list takes the new name',
     (await P.$$eval('#items .itemrow > button.name', n => n.map(x => x.textContent.trim()))).some(n => n.includes('ホリ用 白布')));
  ok('and so do the dimension labels',
     (await P.$$eval('#labels span', n => n.map(x => x.textContent))).some(x => x.startsWith('ホリ用 白布幅')));

  // 幅・高さ・垂らしは辺ごとに。パースにも出る
  for (const v of ['plan', 'pers']){
    await P.click(`#viewbtns button[data-view="${v}"]`); await P.waitForTimeout(600);
    const L = await P.$$eval('#labels span', n => n.map(x => x.textContent));
    ok(`${v}: the backdrop names its width`, L.some(x => /白布幅 /.test(x)), L.join(' | '));
    if (v === 'pers') ok('pers: and its height, on the upright edge', L.some(x => /白布高 /.test(x)), L.join(' | '));
  }
  ok('defaults run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}
{
  // 箱に乗せたカメラは、その高さから見る。布は箱に乗らない
  const scene = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:8,d:6,h:4,cove:{back:true,left:true,right:true}}, activeCam:'c1', items:[
    {id:'b1',type:'box',x:0,z:2,rot:0,w:1.2,d:1.2,h:0.8,color:'#a9b0bd'},
    {id:'c1',type:'camera',x:0,z:2,y:1.3,rot:180,pitch:0,sensor:'ff',focal:35,aspect:'16:9'},
    {id:'k1',type:'chroma',x:0,z:2,rot:0,color:'#1fb24a',w:3,h:2.8,drape:1.5}]};
  const t = await open('onbox', { width: 1200, height: 800 }, false, '#s=' + encodeState(scene));
  await t.page.click('#viewbtns button[data-view="cam"]'); await t.page.waitForTimeout(700);
  ok('a camera on a box looks from up there',
     Math.abs(await t.page.evaluate(() => window.__sp.camera().position.y) - 2.1) < 0.001,
     String(await t.page.evaluate(() => window.__sp.camera().position.y)));
  ok('a backdrop stays on the floor',
     await t.page.evaluate(() => window.__sp.group('k1').position.y) === 0);
  ok('on-a-box run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 12. the camera window: dragging inside it pans and tilts, and it redraws --------
{
  const t = await open('finder', { width: 1300, height: 900 });
  const P = t.page;
  const body = await P.locator('#pip .body').boundingBox();
  const before = await P.locator('#pip').screenshot();
  await P.mouse.move(body.x + body.width/2, body.y + body.height/2);
  await P.mouse.down();
  for (let i = 1; i <= 8; i++){
    await P.mouse.move(body.x + body.width/2 + i*10, body.y + body.height/2 + i*4);
    await P.waitForTimeout(30);
  }
  await P.mouse.up(); await P.waitForTimeout(600);
  const c = await P.evaluate(() => { const i = window.__sp.state().items.find(x => x.type === 'camera'); return {rot:i.rot, pitch:i.pitch}; });
  ok('dragging the camera window pans and tilts', Math.abs(c.rot - 180) > 5 && Math.abs(c.pitch + 6) > 1, JSON.stringify(c));
  ok('and the window redraws from the new angle', !before.equals(await P.locator('#pip').screenshot()));
  // 行末コメントを足したとき、同じ行にあった shotCam.rotation.set が丸ごと消えて
  // ファインダーがパンもチルトもしなくなったことがある。角度そのものを見る
  await P.click('#viewbtns button[data-view="cam"]'); await P.waitForTimeout(600);
  const a = await P.evaluate(() => {
    const sp = window.__sp, i = sp.state().items.find(x => x.type === 'camera');
    const d = Math.abs(sp.camera().rotation.y - (i.rot * Math.PI/180 + Math.PI)) % (2*Math.PI);
    return +Math.min(d, 2*Math.PI - d).toFixed(4);
  });
  ok('the finder camera really carries that angle', a < 0.001, String(a));
  ok('finder run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 13. front view, grid switch, apple boxes, camera angles, shared poses --------
{
  const t = await open('batch', { width: 1400, height: 900 });
  const P = t.page;
  const st = () => P.evaluate(() => window.__sp.state());
  ok('five views, front among them',
     (await P.$$eval('#viewbtns button[data-view]', b => b.map(x => x.textContent))).join('/') === '上面/側面/正面/パース/ファインダー',
     (await P.$$eval('#viewbtns button[data-view]', b => b.map(x => x.textContent))).join('/'));
  await P.click('#viewbtns button[data-view="front"]'); await P.waitForTimeout(600);
  ok('the front view draws its own width and height',
     (await P.$$eval('#labels span', n => n.map(x => x.textContent))).filter(x => /幅|高さ/.test(x)).length >= 2,
     (await P.$$eval('#labels span', n => n.map(x => x.textContent))).join(' | '));
  ok('the camera window switch sits bottom right',
     await P.evaluate(() => { const r = document.getElementById('pipbtn').getBoundingClientRect();
       return r.x > innerWidth*0.8 && r.y > innerHeight*0.8; }));
  const gridOn = () => P.evaluate(() => { let v = null; window.__sp.scene.traverse(n => { if (n.userData.grid) v = n.visible; }); return v; });
  ok('the grid starts on', await gridOn() === true);
  await P.click('#gridbtn'); await P.waitForTimeout(300);
  ok('and can be switched off', await gridOn() === false);
  await P.click('#gridbtn'); await P.waitForTimeout(300);
  ok('the grid runs past the studio walls', await P.evaluate(() => {
    const sp = window.__sp; let g = null; sp.scene.traverse(n => { if (n.userData.grid) g = n; });
    g.geometry.computeBoundingBox();
    return g.geometry.boundingBox.max.x > sp.state().studio.w/2 + 2; }));
  ok('the share panel carries a version and a copyright',
     /v\d+\.\d+\.\d+/.test(await P.textContent('.colophon')) && (await P.textContent('.colophon')).includes('©'),
     await P.textContent('.colophon'));

  // 箱馬。標準寸法なので大きさは変えられない
  await t.add('[data-add="koma"]'); await P.waitForTimeout(500);
  const koma = () => P.evaluate(() => { const i = window.__sp.state().items.find(x => x.type === 'koma');
    return i && [i.kind, i.w, i.d, i.h].join('/'); });
  ok('an apple box is 450 x 300 x 150 lying flat', await koma() === 'flat/0.45/0.3/0.15', await koma());
  await P.click('#selbody [data-set="kind"][data-val="side"]'); await P.waitForTimeout(400);
  ok('on its side it stands 300', await koma() === 'side/0.45/0.15/0.3', await koma());
  await P.click('#selbody [data-set="kind"][data-val="end"]'); await P.waitForTimeout(400);
  ok('on end it stands 450', await koma() === 'end/0.3/0.15/0.45', await koma());
  ok('and no size sliders are offered', await P.$$eval('#selbody [data-range="w"]', b => b.length) === 0);
  ok('the reflector is called a mirror now',
     (await P.$$eval('#items .itemrow > button.name', n => n.map(x => x.textContent))).join('/').includes('ミラー') === false);

  // カメラ
  await P.click('#items .itemrow[data-kind="camera"] > button.name'); await P.waitForTimeout(400);
  ok('height, pan, tilt and roll lead the camera panel',
     (await P.$$eval('#selbody label.f span:first-child', n => n.map(x => x.textContent))).slice(0,4).join('/') === '高さ/パン/チルト/ロール',
     (await P.$$eval('#selbody label.f span:first-child', n => n.map(x => x.textContent))).join('/'));
  ok('the focal length slider sits above its presets', await P.evaluate(() => {
    const kids = [...document.getElementById('selbody').children];
    const slider = kids.findIndex(k => k.querySelector?.('[data-range="focal"]'));
    const presets = kids.findIndex(k => k.querySelector?.('[data-set="focal"]'));
    return slider >= 0 && presets > slider; }));
  ok('135mm is gone from the presets',
     !(await P.$$eval('#selbody [data-set="focal"]', b => b.map(x => x.textContent))).includes('135mm'),
     (await P.$$eval('#selbody [data-set="focal"]', b => b.map(x => x.textContent))).join('/'));
  await P.evaluate(() => { const c = window.__sp.state().items.find(i => i.type === 'camera'); c.roll = 20; window.__sp.select(c.id); });
  await P.click('#viewbtns button[data-view="cam"]'); await P.waitForTimeout(600);
  ok('roll turns the finder camera round its own axis',
     Math.abs(await P.evaluate(() => window.__sp.camera().rotation.z) - 20*Math.PI/180) < 0.001);

  // チルトの弧をなぞる
  await P.click('#viewbtns button[data-view="pers"]'); await P.waitForTimeout(600);
  await P.evaluate(() => { const sp = window.__sp, c = sp.state().items.find(i => i.type === 'camera');
    c.pitch = 0; c.roll = 0; const o = sp.orbit; o.theta = 1.1; o.phi = 1.15; o.radius = 4.5;
    o.target.set(c.x, 1.2, c.z); sp.select(c.id); sp.render(); });
  await P.waitForTimeout(700);
  const onArc = deg => P.evaluate(d => {
    const sp = window.__sp, r = document.getElementById('view').getBoundingClientRect(), g = sp.tilt();
    g.updateMatrixWorld(true);
    const v = new sp.THREE.Vector3(Math.cos(d*Math.PI/180)*0.55, Math.sin(d*Math.PI/180)*0.55, 0)
      .applyMatrix4(g.matrixWorld).project(sp.camera());
    return {x: r.x + (v.x+1)/2*r.width, y: r.y + (1-v.y)/2*r.height};
  }, deg);
  const a0 = await onArc(0), a1 = await onArc(30);
  await P.mouse.move(a0.x, a0.y); await P.mouse.down();
  await P.mouse.move(a1.x, a1.y, { steps: 10 }); await P.mouse.up(); await P.waitForTimeout(400);
  ok('dragging the arc tilts the camera',
     Math.abs(await P.evaluate(() => window.__sp.state().items.find(i => i.type === 'camera').pitch) - 30) <= 2,
     String(await P.evaluate(() => window.__sp.state().items.find(i => i.type === 'camera').pitch)));
  ok('batch run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}
{
  // 共有リンクを開いた直後、誰もパネルを開かなくてもポーズが乗っている
  const posed = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:8,d:6,h:4,cove:{back:true,left:true,right:true}}, activeCam:'c1', items:[
    {id:'p1',type:'person',x:0,z:0,rot:0,height:1.72,pose:'stand',kind:'man',model:'asia-casual-man',posture:'sit-chair'},
    {id:'c1',type:'camera',x:0,z:2.4,y:1.3,rot:180,pitch:-6,roll:0,sensor:'ff',focal:35,aspect:'16:9'}]};
  const t = await open('sharedpose', { width: 1200, height: 800 }, false, '#s=' + encodeState(posed));
  await t.page.waitForTimeout(1200);
  const h = await t.page.evaluate(() => {
    const sp = window.__sp, b = new sp.THREE.Box3();
    sp.group('p1').traverse(n => { if (n.isSkinnedMesh){ n.computeBoundingBox();
      b.union(n.boundingBox.clone().applyMatrix4(n.matrixWorld)); } });
    return +(b.max.y - b.min.y).toFixed(2);
  });
  ok('a shared link brings the pose with it', h > 1.0 && h < 1.5, `${h} m`);
  ok('shared-pose run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 14. stacking: apple boxes on each other, things on tables ---------------------
{
  const K = (id, x, z, kind) => { const S = {flat:[0.45,0.30,0.15], side:[0.45,0.15,0.30], end:[0.30,0.15,0.45]}[kind];
    return {id, type:'koma', x, z, rot:0, kind, w:S[0], d:S[1], h:S[2], color:'#d8c4a0'}; };
  const scene = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:6,d:5,h:3.2,cove:{back:true,left:true,right:true}}, activeCam:'c1', items:[
    K('k1', -1, 0, 'flat'), K('k2', -1, 0, 'flat'), K('k3', -1, 0, 'side'),
    {id:'t1',type:'table',x:1,z:0,rot:0,w:1.2,d:0.7,h:0.72,color:'#c8a882'},
    K('k4', 1, 0, 'flat'),
    {id:'p1',type:'person',x:1,z:0,rot:0,height:1.72,pose:'stand',kind:'man',model:'asia-casual-man',posture:null},
    {id:'k5', type:'koma', x:2.4, z:0, rot:0, kind:'flat', w:0.45, d:0.30, h:0.15, color:'#3d4148'},
    {id:'c1',type:'camera',x:0,z:2.2,y:1.4,rot:180,pitch:-8,roll:0,sensor:'ff',focal:35,aspect:'16:9'}]};
  const t = await open('stack', { width: 1200, height: 800 }, false, '#s=' + encodeState(scene));
  await t.page.waitForTimeout(1200);
  const y = id => t.page.evaluate(i => +window.__sp.group(i).position.y.toFixed(3), id);
  ok('apple boxes stack, later ones on top', await y('k1') === 0 && await y('k2') === 0.15 && await y('k3') === 0.3,
     `${await y('k1')} / ${await y('k2')} / ${await y('k3')}`);
  ok('a table carries what is put on it', await y('k4') === 0.72, String(await y('k4')));
  ok('and the person rides both', await y('p1') === 0.87, String(await y('p1')));
  ok('the old dark default becomes plywood',
     await t.page.evaluate(() => window.__sp.state().items.find(i => i.id === 'k5').color) === '#d8c4a0');
  // つまみで並べ替えると上下が入れ替わる
  const grip = await t.page.locator('#items .itemrow[data-id="k1"] .grip').boundingBox();
  const last = await t.page.locator('#items .itemrow[data-id="k3"]').boundingBox();
  await t.page.mouse.move(grip.x + 6, grip.y + grip.height/2); await t.page.mouse.down();
  await t.page.mouse.move(last.x + 6, last.y + last.height - 2, { steps: 8 }); await t.page.mouse.up();
  await t.page.waitForTimeout(500);
  ok('reordering the list restacks them',
     await y('k2') === 0 && await y('k3') === 0.15 && await y('k1') === 0.45,
     `k1=${await y('k1')} k2=${await y('k2')} k3=${await y('k3')}`);
  ok('stack run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 15. undo / redo, cuts, and the readout that gets out of the way ---------------
{
  const t = await open('cuts', { width: 1200, height: 800 });
  ok('three tabs, カット in the middle',
     (await t.page.$$eval('#tabs button', b => b.map(x => x.textContent.trim()).join('/'))) === 'オブジェクト/カット/保存・共有',
     await t.page.$$eval('#tabs button', b => b.map(x => x.textContent.trim()).join('/')));
  const nItems = () => t.page.evaluate(() => window.__sp.state().items.length);
  const before = await nItems();
  await t.add('[data-add="box"]');
  ok('undo is offered once something happened', !(await t.page.$eval('#undobtn', b => b.disabled)));
  await t.page.click('#undobtn'); await t.page.waitForTimeout(400);
  ok('undo takes the box away', await nItems() === before, `${await nItems()} vs ${before}`);
  await t.page.click('#redobtn'); await t.page.waitForTimeout(400);
  ok('redo puts it back', await nItems() === before + 1);
  await t.page.keyboard.press('Control+z'); await t.page.waitForTimeout(400);
  ok('Ctrl+Z does the same', await nItems() === before);
  await t.page.keyboard.press('Control+Shift+z'); await t.page.waitForTimeout(400);
  ok('Ctrl+Shift+Z redoes', await nItems() === before + 1);

  // カットは今の内容を写して増える。片方をいじってももう片方は動かない
  await t.tab('cut');
  ok('the cut tab offers 複製 and 新規',
     (await t.page.$$eval('[data-sec="cut"] .row button', b => b.map(x => x.textContent.trim()).join('/'))) === 'カットを複製/新規カット');
  ok('and the row keeps only the bin', (await t.page.$$eval('#cuts .itemrow button.ico', n => n.length)) === 1);
  await t.page.click('#dupcut'); await t.page.waitForTimeout(500);
  const cuts = () => t.page.evaluate(() => window.__sp.state().cuts.length);
  ok('a second cut appears', await cuts() === 2, String(await cuts()));
  ok('and it carries the same things', await nItems() === before + 1);
  await t.add('[data-add="chair"]');
  const n2 = await nItems();
  await t.tab('cut');
  await t.page.click('#cuts .itemrow[data-ix="0"] > button.name'); await t.page.waitForTimeout(500);
  ok('the first cut is untouched', await nItems() === n2 - 1, `${await nItems()} vs ${n2 - 1}`);
  await t.page.fill('#m-cut', 'C-12'); await t.page.waitForTimeout(400);
  const rowName = i => t.page.textContent(`#cuts .itemrow[data-ix="${i}"] > button.name`);
  ok('renaming shows in the cut list', (await rowName(0)).includes('C-12'), await rowName(0));
  // つまみで並べ替えると PDF の頁の順も変わる
  const g0 = await t.page.locator('#cuts .itemrow[data-ix="0"] .grip').boundingBox();
  const r1 = await t.page.locator('#cuts .itemrow[data-ix="1"]').boundingBox();
  await t.page.mouse.move(g0.x + 6, g0.y + g0.height/2); await t.page.mouse.down();
  await t.page.mouse.move(r1.x + 6, r1.y + r1.height - 2, { steps: 8 }); await t.page.mouse.up();
  await t.page.waitForTimeout(400);
  ok('cuts can be reordered', (await rowName(1)).includes('C-12'), `${await rowName(0)} | ${await rowName(1)}`);
  ok('and the one being shown stays shown',
     await t.page.$eval('#cuts .itemrow[data-ix="1"] > button.name', e => e.classList.contains('on')));
  await t.tab('share');
  // 用紙はカットごとに 1 枚。範囲も用紙の画面で選ぶ
  await t.page.click('#makepdf'); await t.page.waitForTimeout(3000);
  ok('このカットだけ prints one', await t.page.$$eval('.paper', n => n.length) === 1);
  await t.page.click('.pmbar [data-scope="all"]'); await t.page.waitForTimeout(5000);
  const sheets = await t.page.$$eval('.paper', n => n.length);
  ok('全カット prints one sheet per cut', sheets === 2, `${sheets} sheets`);
  ok('with four panels on each', await t.page.$$eval('.paper .pv img', n => n.length) === 8);
  await t.page.click('.pmbar [data-scope="one"]'); await t.page.waitForTimeout(3000);
  await t.page.click('#paperclose'); await t.page.waitForTimeout(200);

  // 共有リンクに両方のカットが乗る
  const link = await t.page.evaluate(() => location.href);
  const t2 = await open('cuts-shared', { width: 1200, height: 800 }, false, link.slice(link.indexOf('#')));
  ok('both cuts survive the link', await t2.page.evaluate(() => window.__sp.state().cuts.length) === 2);
  ok('cuts run clean', t.errors.length === 0 && t2.errors.length === 0, [...t.errors, ...t2.errors].join(' | '));
  await t2.ctx.close();

  // 縦持ちのスマホでは右上の情報表示が他の UI に重なるので、そのときは消える
  const m = await open('info-overlap', { width: 390, height: 780 }, true);
  await m.page.waitForTimeout(600);
  const hidden = await m.page.evaluate(() => {
    const i = document.getElementById('info'), v = document.getElementById('viewbtns');
    if (i.classList.contains('hide')) return true;
    const a = i.getBoundingClientRect(), b = v.getBoundingClientRect();
    return !(a.left < b.right + 6 && b.left < a.right + 6 && a.top < b.bottom + 6 && b.top < a.bottom + 6);
  });
  ok('the readout never sits on the view buttons', hidden);
  await m.ctx.close();
  await t.ctx.close();
}

// --- 16. QR: the hand-written encoder, module for module, and the dialog -----------
{
  // 自前の実装なので、参照実装（qrcode）と 1 モジュールずつ突き合わせる。
  // マスクの選び方だけは実装ごとに差が出るので、参照実装が選んだマスクに固定して比べ、
  // そのうえで自動選択の出力を jsQR で実際に読ませる。
  const ref = (await import('qrcode')).default;
  const jsQR = (await import('jsqr')).default;
  const t = await open('qr', { width: 1200, height: 800 });
  const texts = ['hello', 'https://mojon1.github.io/Studio-Planner/#s=zabc123',
    'あ'.repeat(40), 'x'.repeat(300), 'y'.repeat(900), 'w'.repeat(2000)];
  let mismatch = null;
  for (const text of texts){
    const r = ref.create([{data:text, mode:'byte'}], {errorCorrectionLevel:'L'});
    const n = r.modules.size;
    let fmt = 0;                                     // 参照実装が選んだマスクを形式情報から読む
    for (let i = 0; i < 15; i++){ const row = i < 6 ? i : i < 8 ? i + 1 : n - 15 + i;
      fmt |= (r.modules.data[row * n + 8] ? 1 : 0) << i; }
    const mask = ((fmt ^ 0x5412) >> 10) & 7;
    const mine = await t.page.evaluate(([s, k]) => window.__sp.qr(s, k), [text, mask]);
    if (!mine || mine.length !== n){ mismatch = `${text.length} 文字: 型がちがう`; break; }
    for (let y = 0; y < n && !mismatch; y++) for (let x = 0; x < n; x++)
      if (mine[y][x] !== (r.modules.data[y*n+x] ? 1 : 0)){ mismatch = `${text.length} 文字 (${y},${x})`; break; }
    if (mismatch) break;
  }
  ok('the QR encoder matches qrcode module for module', !mismatch, mismatch || '');
  ok('too long for any version returns nothing',
     await t.page.evaluate(() => window.__sp.qr('a'.repeat(3000)) === null && !!window.__sp.qr('a'.repeat(2953))));

  await t.addPerson('asia-casual-man');
  await t.tab('share');
  await t.page.click('#qrbtn'); await t.page.waitForTimeout(600);
  ok('the dialog opens', await t.page.$eval('#qrdlg', e => e.classList.contains('on')));
  const read = async () => {
    const px = await t.page.evaluate(() => { const c = document.getElementById('qrcv'), g = c.getContext('2d');
      return {w:c.width, h:c.height, d:Array.from(g.getImageData(0,0,c.width,c.height).data)}; });
    const got = jsQR(Uint8ClampedArray.from(px.d), px.w, px.h);
    return got ? got.data : null;
  };
  const url = await read();
  ok('and the code really reads back as the share link',
     !!url && url.startsWith('http://localhost:8765/#s=') && !/m=v/.test(url), String(url).slice(0, 48));
  await t.page.click('[data-qrmode="view"]'); await t.page.waitForTimeout(500);
  const vurl = await read();
  ok('見るだけ gives the viewer link', !!vurl && /&m=v$/.test(vurl), String(vurl).slice(-20));
  // リンクの中身が本当にその配置か
  const t2 = await open('qr-open', { width: 1000, height: 700 }, false, vurl.slice(vurl.indexOf('#')));
  ok('opening it restores the scene',
     await t2.page.evaluate(() => window.__sp.state().items.some(i => i.type === 'person')));
  await t.page.click('#qrclose'); await t.page.waitForTimeout(200);
  ok('and it closes', !(await t.page.$eval('#qrdlg', e => e.classList.contains('on'))));
  ok('qr run clean', t.errors.length === 0 && t2.errors.length === 0, [...t.errors, ...t2.errors].join(' | '));
  await t2.ctx.close(); await t.ctx.close();
}

// --- 17. offline: the service worker really serves the app with the network cut ----
{
  // Service Worker はページの route を通らないので、この確認だけは three も
  // 同じサーバーから配る。index.html と sw.js の CDN の宛先を差し替えて出す。
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
  const swServer = http.createServer((req, res) => {
    const u = req.url.split('?')[0].split('#')[0];
    if (u.startsWith('/vendor/three/')){
      const f = path.join(NM, 'three', u.replace('/vendor/three/', ''));
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'content-type':'text/javascript'}); res.end(fs.readFileSync(f)); return;
    }
    const p = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(p);
    if (u === '/' || u === '/index.html' || u === '/sw.js')
      body = Buffer.from(body.toString('utf8').split(CDN).join('/vendor/three/')
        .replace('<link rel="stylesheet" href="https://fonts.googleapis.com', '<link rel="none" href="#'));
    res.writeHead(200, {'content-type': MIME[path.extname(p)] || 'text/javascript', 'cache-control':'no-cache'});
    res.end(body);
  }).listen(8766);
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8766/');
  await page.waitForTimeout(1800);
  ok('the service worker takes over', await page.evaluate(() =>
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)));
  ok('the manifest is served', await page.evaluate(async () => (await fetch('manifest.webmanifest')).status) === 200);
  await page.click('#addfab'); await page.click('#people button[data-model="asia-casual-man"]');
  await page.waitForTimeout(1200);
  await page.click('[data-tab="share"]'); await page.waitForTimeout(150);
  await page.click('#offlinebtn');
  await page.waitForFunction(() => /保存しました|できません|使えません/.test(document.getElementById('offlinestat').textContent),
    null, { timeout: 180000 });
  const stat = await page.textContent('#offlinestat');
  ok('オフラインに保存 finishes', /この端末に保存しました/.test(stat), stat);
  const link = await page.evaluate(() => location.href);
  await ctx.setOffline(true);
  const off = await ctx.newPage();
  off.on('pageerror', e => errors.push('offline pageerror: ' + e.message));
  await off.goto(link).catch(e => errors.push('offline goto: ' + e.message));
  await off.waitForTimeout(3500);
  ok('the app still opens with the network cut',
     await off.evaluate(() => !!window.__sp && window.__sp.state().items.length > 0));
  ok('and the person model comes out of the cache', await off.evaluate(() => {
    const it = window.__sp.state().items.find(i => i.type === 'person');
    let skinned = 0; window.__sp.group(it.id).traverse(n => { if (n.isSkinnedMesh) skinned++; });
    return skinned > 0;
  }));
  fs.writeFileSync(path.join(OUT, 'offline.png'), await off.screenshot());
  ok('offline run clean', errors.length === 0, errors.join(' | '));
  await ctx.close(); swServer.close();
}

// --- 18. the car is a real model now, not a stack of blocks ------------------------
{
  const t = await open('car', { width: 1200, height: 800 });
  await t.add('[data-add="car"]');
  await t.page.waitForTimeout(2500);
  const car = await t.page.evaluate(() => {
    const it = window.__sp.state().items.find(i => i.type === 'car');
    const g = window.__sp.group(it.id);
    let tris = 0;
    g.traverse(n => { if (n.isMesh) tris += (n.geometry.index ? n.geometry.index.count : n.geometry.attributes.position.count) / 3; });
    const b = new window.__sp.THREE.Box3().setFromObject(g);
    return {kind: it.kind, w: it.w, d: it.d, h: it.h, tris: Math.round(tris),
      size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map(v => +v.toFixed(3)), minY: +b.min.y.toFixed(4)};
  });
  ok('a car comes in as a sedan at 1.8 x 4.7 x 1.45 m',
     car.kind === 'sedan' && car.w === 1.8 && car.d === 4.7 && car.h === 1.45, JSON.stringify(car));
  ok('and it is the scanned model, not primitives', car.tris > 5000, `${car.tris} triangles`);
  ok('drawn at exactly the dimensions on the panel',
     car.size[0] === 1.8 && car.size[1] === 1.45 && car.size[2] === 4.7 && car.minY === 0, JSON.stringify(car.size));
  await t.page.click('#items .itemrow[data-kind="car"] > button.name');
  await t.page.waitForTimeout(400);
  const thumbs = await t.page.$$eval('.cars img', n => n.map(x => x.naturalWidth));
  ok('the car models are offered as thumbnails', thumbs.length >= 2 && thumbs.every(w => w > 0), JSON.stringify(thumbs));
  ok('no block-car kinds are left', !(await t.page.$('[data-set="kind"][data-val="wagon"]')));
  await t.page.click('[data-set="kind"][data-val="modern"]');
  await t.page.waitForTimeout(2000);
  const two = await t.page.evaluate(() => { const it = window.__sp.state().items.find(i => i.type === 'car');
    return {kind: it.kind, w: it.w, d: it.d, h: it.h}; });
  ok('picking a model brings that car\u2019s real size', two.kind === 'modern' && two.d === 4.75, JSON.stringify(two));
  // 古いリンクの「ワゴン」は、実物が入るまでセダンで置く。寸法はリンクのまま
  const old = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:8,d:6,h:4,cove:{back:true,left:true,right:true}},
    activeCam:'c1', items:[{id:'v1',type:'car',x:0,z:0,rot:0,kind:'wagon',w:1.80,d:4.80,h:1.55,color:'#b9c0cc'},
      {id:'c1',type:'camera',x:0,z:2.4,y:1.3,rot:180,pitch:-6,sensor:'ff',focal:35,aspect:'16:9'}]};
  const t2 = await open('car-legacy', { width: 1000, height: 700 }, false, '#s=' + encodeState(old));
  await t2.page.waitForTimeout(2000);
  const mig = await t2.page.evaluate(() => { const it = window.__sp.state().items.find(i => i.type === 'car');
    return {kind: it.kind, d: it.d, h: it.h}; });
  // 車内からガラス越しに撮る。窓がガラスになっていないモデルは、その絵から外す
  const inCar = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:10,d:8,h:4,cove:{back:true,left:true,right:true}},
    activeCam:'c1', items:[
      {id:'v1',type:'car',x:0,z:0.6,rot:0,kind:'sedan',w:1.80,d:4.70,h:1.45},
      {id:'g1',type:'chroma',x:0,z:-2.6,rot:0,color:'#1fb24a',w:6,h:3.2,drape:1.5},
      {id:'c1',type:'camera',x:-0.38,z:1.3,y:1.15,rot:180,pitch:0,roll:0,sensor:'ff',focal:35,aspect:'16:9'}]};
  const t3 = await open('in-car', { width: 1100, height: 760 }, false, '#s=' + encodeState(inCar));
  await t3.page.waitForTimeout(3000);
  await t3.page.click('[data-view="cam"]'); await t3.page.waitForTimeout(1200);
  const mid = await t3.page.evaluate(() => {
    const c = document.querySelector('#view canvas'), g = c.getContext('webgl2') || c.getContext('webgl');
    const px = new Uint8Array(4);
    g.readPixels(Math.round(c.width/2), Math.round(c.height/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    return [...px];
  });
  ok('a camera inside the car sees the green screen, not the inside of a shell',
     mid[1] > 70 && mid[1] > mid[0] * 1.6 && mid[1] > mid[2] * 1.6, `rgb ${mid.slice(0,3).join(',')}`);
  await t3.page.screenshot({ path: `${OUT}/in-car.png` });
  await t3.page.click('#items .itemrow[data-kind="car"] > button.name'); await t3.page.waitForTimeout(300);
  ok('and the panel says why the car drops out',
     (await t3.page.textContent('#selbody')).includes('ガラスになっていません'));

  // 名前に glass の入ったマテリアルは、書き出し側が alphaMode を立てていなくても透過にする
  const gglb = `${OUT}/glass-box.glb`; fs.writeFileSync(gglb, makeGlassGLB());
  const t4 = await open('glass', { width: 1100, height: 760 });
  await t4.page.click('#addfab');
  await t4.page.setInputFiles('#file', gglb);
  await t4.page.waitForTimeout(2500);
  const mats = await t4.page.evaluate(() => {
    const m = window.__sp.state().items.find(i => i.type === 'model');
    const out = [];
    window.__sp.group(m.id).traverse(n => { if (n.isMesh)
      for (const x of (Array.isArray(n.material) ? n.material : [n.material]))
        if (x) out.push({name:x.name, t:x.transparent, o:+x.opacity.toFixed(2), dw:x.depthWrite}); });
    return out;
  });
  const glassMat = mats.find(m => /glass/i.test(m.name)), bodyMat = mats.find(m => !/glass/i.test(m.name));
  ok('a material named glass becomes see-through',
     !!glassMat && glassMat.t && glassMat.o < 0.5 && glassMat.dw === false, JSON.stringify(glassMat));
  ok('and the body next to it is left alone', !!bodyMat && !bodyMat.t, JSON.stringify(bodyMat));
  ok('glass run clean', t3.errors.length === 0 && t4.errors.length === 0, [...t3.errors, ...t4.errors].join(' | '));
  await t4.ctx.close(); await t3.ctx.close();

  ok('an old ワゴン opens as a sedan at the size it was saved with',
     mig.kind === 'sedan' && mig.d === 4.8 && mig.h === 1.55, JSON.stringify(mig));
  await t2.page.screenshot({ path: `${OUT}/car.png` });
  ok('car run clean', t.errors.length === 0 && t2.errors.length === 0, [...t.errors, ...t2.errors].join(' | '));
  await t2.ctx.close(); await t.ctx.close();
}

// --- 19. the finder: an eye, not a shutter, and a window of its own ----------------
{
  const t = await open('popout', { width: 1300, height: 850 });
  const d = await t.page.$eval('#pipbtn svg path', e => e.getAttribute('d'));
  ok('the bottom-right button is an eye, not a camera', d.startsWith('M2 12s'), d.slice(0, 12));

  const [pop] = await Promise.all([t.ctx.waitForEvent('page'), t.page.click('#pipout')]);
  await pop.waitForLoadState('domcontentloaded');
  await t.page.waitForTimeout(1500);
  ok('the finder opens in a window of its own', (await pop.title()).includes('ファインダー'), await pop.title());
  ok('and the docked one steps aside', await t.page.$eval('#pip', e => getComputedStyle(e).display) === 'none');
  const shot = await pop.evaluate(() => {
    const c = document.getElementById('c'), g = c.getContext('2d');
    const px = g.getImageData(Math.round(c.width/2), Math.round(c.height/2), 1, 1).data;
    return {w: c.width, h: c.height, lit: px[0] + px[1] + px[2]};
  });
  ok('the window really carries the picture', shot.w > 100 && shot.lit > 30, JSON.stringify(shot));
  ok('and it names the camera and the lens',
     (await pop.$eval('.bar', e => e.textContent)).includes('35mm'), await pop.$eval('.bar', e => e.textContent.trim()));

  const before = await t.page.evaluate(() => { const c = window.__sp.state().items.find(i => i.type === 'camera');
    return {rot: c.rot, pitch: c.pitch}; });
  const box = await pop.locator('#c').boundingBox();
  await pop.mouse.move(box.x + box.width/2, box.y + box.height/2); await pop.mouse.down();
  await pop.mouse.move(box.x + box.width/2 + 80, box.y + box.height/2 + 20, { steps: 8 }); await pop.mouse.up();
  await t.page.waitForTimeout(600);
  const after = await t.page.evaluate(() => { const c = window.__sp.state().items.find(i => i.type === 'camera');
    return {rot: c.rot, pitch: c.pitch}; });
  ok('dragging in that window pans and tilts', after.rot !== before.rot && after.pitch !== before.pitch,
     `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await pop.screenshot({ path: `${OUT}/popout.png` });
  await pop.close(); await t.page.waitForTimeout(600);
  ok('closing it brings the small window back', await t.page.$eval('#pip', e => getComputedStyle(e).display) === 'block');
  ok('popout run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 20. moving the view, and getting back to the middle --------------------------
{
  const t = await open('pan', { width: 1200, height: 800 });
  const box = await t.page.locator('#view canvas').boundingBox();
  const cx = box.x + box.width/2, cy = box.y + box.height/2;
  const shown = () => t.page.$eval('#recenter', e => e.classList.contains('on'));
  const cam = () => t.page.evaluate(() => { const c = window.__sp.camera();
    return [+c.position.x.toFixed(2), +c.position.z.toFixed(2)]; });
  ok('nothing to recentre at the start', !(await shown()));
  const home = await cam();
  await t.page.mouse.move(cx, cy); await t.page.mouse.down({ button: 'middle' });
  await t.page.mouse.move(cx + 160, cy + 60, { steps: 10 }); await t.page.mouse.up({ button: 'middle' });
  await t.page.waitForTimeout(400);
  const moved = await cam();
  ok('the middle button moves the perspective view', moved.join() !== home.join(), `${home} -> ${moved}`);
  ok('and the recentre button turns up', await shown());
  await t.page.screenshot({ path: `${OUT}/pan.png` });
  await t.page.click('#recenter'); await t.page.waitForTimeout(400);
  ok('it goes back to the middle', (await cam()).join() === home.join(), (await cam()).join());
  ok('and takes itself away again', !(await shown()));

  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(300);
  ok('a fresh view starts centred', !(await shown()));
  await t.page.mouse.move(cx, cy); await t.page.mouse.down({ button: 'middle' });
  await t.page.mouse.move(cx - 140, cy - 80, { steps: 10 }); await t.page.mouse.up({ button: 'middle' });
  await t.page.waitForTimeout(400);
  const plan = await cam();
  ok('the plan view moves too', plan[0] !== 0 && plan[1] !== 0, plan.join());
  ok('and offers to recentre', await shown());
  await t.page.click('#recenter'); await t.page.waitForTimeout(400);

  // 2 本指のスワイプ。ブラウザに 2 本目の指は作れないので、イベントを直に投げる
  await t.page.evaluate(([x, y]) => {
    const c = document.querySelector('#view canvas');
    const ev = (type, id, px, py) => c.dispatchEvent(new PointerEvent(type,
      {pointerId:id, pointerType:'touch', clientX:px, clientY:py, bubbles:true, isPrimary:id === 1}));
    ev('pointerdown', 1, x - 40, y); ev('pointerdown', 2, x + 40, y);
    for (let i = 1; i <= 10; i++){ ev('pointermove', 1, x - 40 + i*10, y + i*6); ev('pointermove', 2, x + 40 + i*10, y + i*6); }
    ev('pointerup', 1, x + 60, y + 60); ev('pointerup', 2, x + 140, y + 60);
  }, [cx - box.x, cy - box.y]);
  await t.page.waitForTimeout(400);
  const swiped = await cam();
  ok('two fingers move the view as well', swiped[0] !== 0 && swiped[1] !== 0, swiped.join());
  ok('pan run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 21. the panel after the tidy-up --------------------------------------------
{
  const t = await open('panel', { width: 1280, height: 860 });
  ok('the tab is called 保存・共有',
     (await t.page.$$eval('#tabs button', b => b.map(x => x.textContent.trim()).join('/'))) === 'オブジェクト/カット/保存・共有',
     await t.page.$$eval('#tabs button', b => b.map(x => x.textContent.trim()).join('/')));
  await t.tab('share');
  const secs = await t.page.$$eval('[data-sec="share"] h2', n => n.map(x => x.textContent).join('/'));
  ok('the project file sits below PDF and 画像', secs === 'リンクで共有/PDF/画像/プロジェクト/オフライン', secs);
  ok('配置をすべて消す is gone', !(await t.page.$('#reset')));
  ok('and the paper options are no longer in the panel', !(await t.page.$('[data-sec="share"] [data-orient]')));

  // 新規カットは、アプリを開いたときと同じ中身から始まる
  await t.tab('cut');
  await t.add('[data-add="box"]');
  await t.tab('cut');
  const before = await t.page.evaluate(() => window.__sp.state().items.length);
  await t.page.click('#newcut'); await t.page.waitForTimeout(900);
  const made = await t.page.evaluate(() => { const st = window.__sp.state();
    return {cuts: st.cuts.length, items: st.items.map(i => i.type).join(','), cam: !!st.activeCam}; });
  ok('新規カット starts from a clean floor', made.cuts === 2 && made.items === 'person,camera' && made.cam,
     JSON.stringify(made));
  ok('and leaves the cut it came from alone',
     await t.page.evaluate(() => window.__sp.state().cuts[0].items.length) === before, String(before));
  ok('panel run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  // 指だけの端末では、ファインダーを切り離すボタンを出さない
  const m = await open('touch', { width: 390, height: 780 }, true);
  await m.page.waitForTimeout(600);
  ok('a touch device is not offered the pop-out',
     await m.page.$eval('#pipout', e => getComputedStyle(e).display) === 'none',
     await m.page.$eval('#pipout', e => getComputedStyle(e).display));
  ok('touch run clean', m.errors.length === 0, m.errors.join(' | '));
  await m.ctx.close();
}

// --- 22. the tidy-up round: bins, pinch, angles, presets, the corner buttons -------
{
  const t = await open('polish', { width: 1300, height: 860 });
  // ゴミ箱: 消したあと、繰り上がってきた別の行が赤くならない
  for (const k of ['box','chair','table','koma']) await t.add(`[data-add="${k}"]`);
  const reds = () => t.page.$$eval('#items .itemrow .ico.trash',
    n => n.filter(x => getComputedStyle(x).color === 'rgb(168, 58, 58)').length);
  await t.page.click('#items .itemrow[data-kind="chair"] .ico.trash');
  await t.page.waitForTimeout(500);
  ok('deleting a row leaves no other bin lit up', await reds() === 0, `${await reds()} red`);

  // 左下: ＋ と設定は同じ大きさで縦並び、下が設定
  const r = await t.page.evaluate(() => Object.fromEntries(['addfab','gear','undobtn'].map(id => {
    const b = document.getElementById(id).getBoundingClientRect();
    return [id, {x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height), cy:Math.round(b.top + b.height/2)}];
  })));
  ok('＋ and the gear are the same size, stacked, gear underneath',
     r.addfab.w === r.gear.w && r.addfab.h === r.gear.h && r.addfab.x === r.gear.x && r.addfab.y < r.gear.y,
     JSON.stringify(r));
  ok('and undo sits beside them on the same line', r.undobtn.x > r.gear.x && Math.abs(r.undobtn.cy - r.gear.cy) <= 2,
     `${r.undobtn.cy} vs ${r.gear.cy}`);

  // プリセットは一回り大きく
  await t.page.click('#items .itemrow[data-kind="studio"] > button.name'); await t.page.waitForTimeout(300);
  const opts = await t.page.$$eval('#preset option', n => n.map(x => x.textContent).join(' / '));
  ok('the studio presets are a size bigger',
     /小スタジオ 6×5×3.5/.test(opts) && /中スタジオ 10×8×4.5/.test(opts) && /大スタジオ 15×12×6/.test(opts), opts);
  ok('and a new session starts at the middle one',
     JSON.stringify(await t.page.evaluate(() => window.__sp.state().studio)).startsWith('{"w":10,"d":8,"h":4.5'),
     JSON.stringify(await t.page.evaluate(() => window.__sp.state().studio)));

  // 角度は小数第 1 位まで
  await t.page.evaluate(() => { const c = window.__sp.state().items.find(i => i.type === 'camera');
    c.pitch = -6.28; c.rot = 179.62; window.__sp.render(); });
  await t.page.click('#items .itemrow[data-kind="camera"] > button.name'); await t.page.waitForTimeout(300);
  const shown = await t.page.$$eval('#selbody [data-edit]', n => n.map(x => x.textContent.trim()).join(' | '));
  ok('angles read to one decimal place', /-6\.3 °/.test(shown) && !/-6\.28/.test(shown), shown);
  await t.page.waitForTimeout(300);
  ok('and so does the readout', /チルト -6\.3°/.test(await t.page.textContent('#info')),
     (await t.page.textContent('#info')).split('\n').pop());
  ok('polish run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  // スマホ: 物の上に指を置いたままでも、2 本指でつまめば拡大縮小できる
  const m = await open('pinch', { width: 390, height: 780 }, true);
  await m.page.click('[data-view="plan"]'); await m.page.waitForTimeout(600);
  const zoom = () => m.page.evaluate(() => window.__sp.camera().zoom);
  const before = await zoom();
  const box = await m.page.locator('#view canvas').boundingBox();
  await m.page.evaluate(([x, y]) => {
    const c = document.querySelector('#view canvas');
    window.__ev = (type, id, px, py) => c.dispatchEvent(new PointerEvent(type,
      {pointerId:id, pointerType:'touch', clientX:px, clientY:py, bubbles:true, isPrimary:id === 1}));
    window.__p = [x, y];
    window.__ev('pointerdown', 1, x - 30, y);
  }, [Math.round(box.width/2), Math.round(box.height/2)]);
  await m.page.waitForTimeout(800);                 // 長押しの 550ms を跨がせる
  await m.page.evaluate(() => {
    const [x, y] = window.__p, ev = window.__ev;
    ev('pointerdown', 2, x + 30, y);
    for (let i = 1; i <= 12; i++){ ev('pointermove', 1, x - 30 - i*8, y); ev('pointermove', 2, x + 30 + i*8, y); }
    ev('pointerup', 1, x - 126, y); ev('pointerup', 2, x + 126, y);
  });
  await m.page.waitForTimeout(500);
  const after = await zoom();
  ok('two fingers zoom even after resting on something', after > before * 1.5, `${before} -> ${after}`);
  ok('and no long-press menu got in the way', await m.page.$eval('#ctx', e => e.hidden));
  ok('pinch run clean', m.errors.length === 0, m.errors.join(' | '));
  await m.ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
