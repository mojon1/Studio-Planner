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
// 3DGS の PLY を手で組む。8 個のガウシアンを 2 m の立方体の角に置くだけ。
// scale_* は対数、opacity はロジット、rot_0 が w。テストに 10 MB の実データは要らない
function makeSplatPLY(){
  const props = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex 8\n` +
    props.map(p => `property float ${p}`).join('\n') + `\nend_header\n`;
  const body = Buffer.alloc(8 * props.length * 4);
  let o = 0;
  for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-1, 1]){
    for (const v of [x, y, z, 1.0, 1.0, 1.0, 4.0, Math.log(0.05), Math.log(0.05), Math.log(0.05), 1, 0, 0, 0])
      { body.writeFloatLE(v, o); o += 4; }
  }
  return Buffer.concat([Buffer.from(head, 'ascii'), body]);
}
// 鏡に映ったことを読み取れるように、色付きで大きめのガウシアンを 4x4x4 個
function makeColourSplatPLY(){
  const props = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex 64\n` +
    props.map(p => `property float ${p}`).join('\n') + `\nend_header\n`;
  const body = Buffer.alloc(64 * props.length * 4);
  let o = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++){
    for (const v of [-1.5 + i, 0.2 + j*0.7, -1.5 + k, i/3*2 - 0.5, j/3*2 - 0.5, k/3*2 - 0.5,
                     4.0, Math.log(0.22), Math.log(0.22), Math.log(0.22), 1, 0, 0, 0])
      { body.writeFloatLE(v, o); o += 4; }
  }
  return Buffer.concat([Buffer.from(head, 'ascii'), body]);
}
const encodeState = st => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(st)))
  .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

const MIME = {'.html':'text/html; charset=utf-8', '.glb':'model/gltf-binary', '.json':'application/json',
  '.webmanifest':'application/manifest+json', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.task':'application/octet-stream', '.wasm':'application/wasm', '.jpg':'image/jpeg'};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0].split('#')[0];   // ?eng のような検索文字列は落とす
  const p = path.join(ROOT, u === '/' ? 'index.html' : u);
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
async function open(name, viewport, mobile = false, hash = '', extra = {}){
  // Service Worker はページの route を素通りして本物の CDN を取りに行くので、
  // three をローカルへ差し替えているこの一連の確認では止めておく。
  // オフラインそのものは最後のブロックで別に確かめる。
  // ヘッドレスの Chromium は en-US なので、何もしないと英語表示のテストになってしまう。既定は日本語のブラウザ
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: 'block', locale: 'ja-JP', ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // MediaPipe の CPU 推定は「INFO: Created TensorFlow Lite XNNPACK delegate」を console.error で出す。案内であって不具合ではない
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource|XNNPACK delegate/.test(m.text())) errors.push(m.text()); });
  await page.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.180.0/', '');
    const f = path.join(NM, 'three', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }); else route.fulfill({ status: 404 });
  });
  // 3DGS の Spark も、本物の CDN ではなく手元のものを配る
  await page.route('https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.1.0/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.1.0/', '');
    const f = path.join(NM, '@sparkjsdev/spark', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }); else route.fulfill({ status: 404 });
  });
  // 写真ポーズの MediaPipe も手元のものを配る（wasm は 12 MB）
  await page.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/', '').split('?')[0];
    const f = path.join(NM, '@mediapipe/tasks-vision', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'text/javascript' }); else route.fulfill({ status: 404 });
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
  for (const m of ['asia-casual-man','asia-casual-woman','af-casual-man','us-casual-woman']) await t.addPerson(m);
  for (const k of ['car','chair','table','box','mirror','chroma']) await t.add(`[data-add="${k}"]`);
  const rows = await t.page.$$eval('#items .itemrow > button.name', b => b.map(x => x.textContent.trim()));
  ok('all presets placed', rows.length === 13, `${rows.length} rows`);
  // 定規とグリッドは起動時にオンで、ボタンもオレンジ（以前はビューの同期で on が外れてグレーだった）
  const iconOn = await t.page.evaluate(() => ['ruler', 'gridbtn'].map(id => document.getElementById(id).classList.contains('on')));
  ok('ruler and grid buttons show as on at startup', iconOn.every(Boolean), iconOn.join(','));
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(200);
  const iconOn2 = await t.page.evaluate(() => ['ruler', 'gridbtn'].map(id => document.getElementById(id).classList.contains('on')));
  ok('and stay on after switching the view', iconOn2.every(Boolean), iconOn2.join(','));
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(200);
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
  // 寸法表示はスタジオ以外は既定オフなので、ここでは全部入れて見る
  await t.page.evaluate(() => { const sp = window.__sp; for (const it of sp.state().items) it.dim = true; sp.render(); });
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
  const link = await t.page.evaluate(() => location.href);
  // 辺ごとの寸法は、ラベルが押し合わない素の場面で見る（上の場面は 7 個ぶん詰めてある）
  {
    const solo = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:10,d:8,h:4.5,cove:{back:true,left:true,right:true}},
      activeCam:'c1', items:[{id:'w1',type:'mirror',x:0,z:0,rot:0,kind:'floor',w:3,h:2,dim:true},
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
  // 新しく作る道は無いが、配ってしまった古い m=v のリンクは今までどおり開く
  ok('an old m=v link still opens read-only', await t.page.$eval('#panel', e => getComputedStyle(e).display === 'none'));
  ok('viewer run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 7. 書き出したファイルの渡し方（3 経路）------------------------------------------
// **配置だけのプロジェクトファイル（.json）は外した**（中身が共有リンクと同じだった）。
// saveFile() の 3 段構えは画像でも同じ道を通るので、そちらで見る
{
  const t = await open('savefile', { width: 1280, height: 800 });
  await t.add('[data-add="chroma"]');
  await t.tab('cut');
  await t.page.fill('#m-cut', 'C-3');
  await t.page.waitForTimeout(200);
  await t.tab('share');
  await t.page.click('#makepdf'); await t.page.waitForTimeout(2500);   // 案件名は用紙の画面にある
  await t.page.fill('#m-project', '青山スタジオ 下見');
  await t.page.waitForTimeout(300);
  await t.page.click('#paperclose'); await t.page.waitForTimeout(300);

  ok('the project file is gone from the panel',
     !(await t.page.$('#savefile')) && !(await t.page.$('#loadfile')) && !(await t.page.$('#projfile')));

  // デスクトップの Chrome: OS の「名前を付けて保存」を開く
  await t.page.evaluate(() => {
    window.__picked = null; window.__written = null;
    window.showSaveFilePicker = async opts => {
      window.__picked = {name: opts.suggestedName, types: opts.types};
      return { createWritable: async () => ({
        write: async b => { window.__written = b?.size ?? 0; },
        close: async () => {},
      }) };
    };
  });
  await t.page.click('#png'); await t.page.waitForTimeout(1500);
  await t.page.click('#shotdl'); await t.page.waitForTimeout(500);
  const picked = await t.page.evaluate(() => ({p: window.__picked, w: window.__written}));
  ok('saving opens the save dialog rather than downloading',
     !!picked.p && picked.p.name.includes('青山スタジオ') && picked.p.name.includes('C-3')
     && /\d{4}-\d{2}-\d{2}/.test(picked.p.name) && picked.p.name.endsWith('.png'), picked.p?.name);
  ok('and the file itself really goes through it', picked.w > 1000, String(picked.w));

  // 閉じただけなら何もしない（AbortError）
  await t.page.evaluate(() => {
    window.showSaveFilePicker = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };
  });
  await t.page.click('#shotdl');
  await t.page.waitForTimeout(300);
  ok('closing the dialog saves nothing', !await t.page.$eval('#namedlg', e => e.classList.contains('on')));

  // ダイアログの無い場所（枠の中など）は、自前で名前を訊いてから渡す
  await t.page.evaluate(() => { delete window.showSaveFilePicker; });
  await t.page.click('#shotdl');
  await t.page.waitForTimeout(300);
  ok('without a save dialog the app asks for the name', await t.page.$eval('#namedlg', e => e.classList.contains('on')));
  const suggested = await t.page.inputValue('#namein');
  await t.page.fill('#namein', '下見メモ');
  const dl = await Promise.all([t.page.waitForEvent('download'), t.page.click('#nameok')]).then(r => r[0]);
  ok('the typed name is used, with the extension kept', dl.suggestedFilename() === '下見メモ.png',
     `${dl.suggestedFilename()} (suggested ${suggested})`);
  await t.page.click('#shotclose');

  ok('save dialog run clean', t.errors.length === 0, t.errors.join(' | '));
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
  // ポーズは向きの下、寸法表示だけがその下（寸法表示はどのオブジェクトでも最後。寺村さんの指示）
  ok('the pose list sits under the direction slider, with only 寸法表示 below it',
     await t.page.$eval('#selbody', el => {
       const kids = [...el.children];
       const poses = kids.findIndex(k => k.classList.contains('poses'));
       const h2 = kids.map((k, i) => k.tagName === 'H2' ? i : -1).filter(i => i >= 0), last = h2[h2.length - 1];
       return poses > 0 && kids[poses - 1].textContent.includes('ポーズ')
           && last === poses + 1 && kids[last].textContent.trim() === '寸法表示';
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
  // 数は書かない（増えるものなので）。一覧そのものと突き合わせる。
  // 出るのは**カジュアルだけ** — スーツは置いたあとパネルで着替える
  const roster = await t.page.evaluate(() => window.__sp.people().filter(m => m.wear === 'casual').map(m => m.id));
  ok('every casual model is offered as a thumbnail', cast.join(',') === roster.join(','), cast.join(', '));
  ok('and the suits are not in the picker',
     !cast.some(id => id.includes('business')), cast.join(', '));
  const thumbs = await t.page.$$eval('#people img', imgs => imgs.map(i => i.naturalWidth));
  ok('the thumbnails actually load',
     thumbs.length === roster.length && thumbs.every(w => w === 200), thumbs.join(','));
  await t.page.click('#people button[data-model="af-casual-woman"]');
  await t.page.waitForTimeout(2500);
  const placed = await t.page.evaluate(() => {
    const it = window.__sp.state().items.at(-1);
    return {model: it.model, kind: it.kind, height: it.height};
  });
  ok('the placed person carries that model', placed.model === 'af-casual-woman' && placed.kind === 'woman',
     JSON.stringify(placed));
  ok('and the height that goes with her', Math.abs(placed.height - 1.58) < 0.001, String(placed.height));
  const herH = await t.page.evaluate(() => {
    const sp = window.__sp, g = sp.group(sp.state().items.at(-1).id);
    const b = new sp.THREE.Box3().setFromObject(g);
    return +(b.max.y - b.min.y).toFixed(3);
  });
  ok('and she is drawn at that height', Math.abs(herH - 1.58) < 0.02, `${herH} m`);
  // 服装はパネルで着替える。地域も種別も変わらない
  await t.page.click('#items .itemrow.on > button.name').catch(() => {});
  await t.page.waitForTimeout(300);
  const wearBtns = await t.page.$$eval('[data-set="model"]', b => b.map(x => [x.dataset.val, x.textContent.trim(), x.className]));
  ok('the panel offers the same person in a suit',
     wearBtns.map(w => w[0]).join(',') === 'af-casual-woman,af-business-woman'
     && wearBtns.map(w => w[1]).join(',') === 'カジュアル,スーツ'
     && wearBtns[0][2].includes('on'), JSON.stringify(wearBtns));
  // 服装はポーズの上
  const orderH = await t.page.$$eval('#selbody h2', n => n.map(x => x.textContent.trim()));
  ok('and it sits above the poses',
     orderH.indexOf('服装') >= 0 && orderH.indexOf('服装') < orderH.indexOf('ポーズ'), orderH.join(' / '));
  await t.page.click('[data-set="model"][data-val="af-business-woman"]');
  await t.page.waitForTimeout(2500);
  const dressed = await t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.model && i.model.startsWith('af-'));
    const b = new sp.THREE.Box3().setFromObject(sp.group(it.id));
    return {model: it.model, kind: it.kind, height: it.height, tall: +(b.max.y - b.min.y).toFixed(3)};
  });
  ok('changing clothes keeps who they are and how tall',
     dressed.model === 'af-business-woman' && dressed.kind === 'woman'
     && Math.abs(dressed.height - 1.58) < 0.001 && Math.abs(dressed.tall - 1.58) < 0.02, JSON.stringify(dressed));
  // 子どもも同じ道で置ける（種別と既定の身長は + で決まる）
  await t.page.click('#addfab'); await t.page.waitForTimeout(300);
  await t.page.click('#people button[data-model="asia-casual-girl"]');
  await t.page.waitForTimeout(2500);
  const kid = await t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.at(-1);
    const b = new sp.THREE.Box3().setFromObject(sp.group(it.id));
    return {model: it.model, kind: it.kind, height: it.height, tall: +(b.max.y - b.min.y).toFixed(3), floor: +b.min.y.toFixed(3)};
  });
  ok('a child can be placed too, at a child height',
     kid.model === 'asia-casual-girl' && kid.kind === 'girl'
     && Math.abs(kid.height - 1.18) < 0.001 && Math.abs(kid.tall - 1.18) < 0.02 && Math.abs(kid.floor) < 0.02,
     JSON.stringify(kid));
  // 子どもはスーツを持っていないので、着替えは出さない
  await t.page.click('#items .itemrow.on > button.name').catch(() => {});
  await t.page.waitForTimeout(300);
  ok('a child is offered no change of clothes', (await t.page.$$('[data-set="model"]')).length === 0);
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
    return i ? {id:i.id, type:i.type, x:i.x, z:i.z, w:i.w, h:i.h, drape:i.drape, locked:!!i.locked} : null; }, type);
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
  // つまみは角にある。手前の角を横に引くと幅が変わり、垂らしはそのまま
  const e1 = await world(c0.x + c0.w / 2, c0.z + c0.drape), e2 = await world(c0.x + c0.w / 2 + 1.2, c0.z + c0.drape);
  await P.mouse.move(e1.x, e1.y); await P.mouse.down(); await P.mouse.move(e2.x, e2.y, { steps: 8 }); await P.mouse.up();
  await P.waitForTimeout(400);
  const c1 = await one('chroma');
  ok('dragging a corner widens the backdrop', c1.w > c0.w + 1, `${c0.w} -> ${c1.w}`);
  ok('and the far edge stays put', Math.abs((c1.x - c1.w / 2) - (c0.x - c0.w / 2)) < 0.06);
  ok('and the drape is untouched by a sideways drag', Math.abs(c1.drape - c0.drape) < 0.15, `${c0.drape} -> ${c1.drape}`);
  const corners = await P.evaluate(() => window.__sp.handles().children.filter(k => k.isMesh).length);
  ok('the backdrop has four corner handles', corners === 4, String(corners));

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
     (await P.$$eval('#viewbtns button[data-view]', b => b.map(x => x.textContent))).join('/') === '上面/側面/正面/3D/ファインダー',
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
  // 「見るだけ」の切り替えは外した。クラウドで 1 つの配置を共有する仕組みでは
  // ないので、鍵にも約束にもならなかった（寺村さんの指摘）
  ok('there is no view-only switch any more', (await t.page.$$('[data-qrmode]')).length === 0);
  // リンクの中身が本当にその配置か
  const t2 = await open('qr-open', { width: 1000, height: 700 }, false, url.slice(url.indexOf('#')));
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
  const CDN = 'https://cdn.jsdelivr.net/npm/three@0.180.0/';
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
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto('http://localhost:8766/');
  await page.waitForTimeout(1800);
  ok('the service worker takes over', await page.evaluate(() =>
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false)));
  ok('the manifest is served', await page.evaluate(async () => (await fetch('manifest.webmanifest')).status) === 200);
  // 「オフラインに保存」ボタンは外した。一度使ったものが runtime キャッシュに
  // 残っていること（＝置いた人物のモデルが圏外でも出ること）を見る
  await page.click('#addfab'); await page.click('#people button[data-model="asia-casual-man"]');
  await page.waitForTimeout(2500);
  ok('the person model was fetched at least once', await page.evaluate(() => {
    const it = window.__sp.state().items.find(i => i.type === 'person');
    let skinned = 0; window.__sp.group(it.id).traverse(n => { if (n.isSkinnedMesh) skinned++; });
    return skinned > 0;
  }));
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
  // 「モダン」は間違って入れたもの。消したので、古いリンクはセダンで置かれる
  ok('and the mistaken モダン is gone', !(await t.page.$('[data-set="kind"][data-val="modern"]')));
  await t.page.click('[data-set="kind"][data-val="suv"]');
  await t.page.waitForTimeout(2000);
  const two = await t.page.evaluate(() => { const sp = window.__sp, it = sp.state().items.find(i => i.type === 'car');
    const b = new sp.THREE.Box3().setFromObject(sp.group(it.id));
    return {kind: it.kind, w: it.w, d: it.d, h: it.h,
            size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map(v => +v.toFixed(3))}; });
  ok('picking a model brings that car\u2019s real size',
     two.kind === 'suv' && two.w === 1.85 && two.d === 4.7 && two.h === 1.7, JSON.stringify(two));
  ok('and the SUV is drawn at those dimensions',
     two.size[0] === 1.85 && two.size[1] === 1.7 && two.size[2] === 4.7, JSON.stringify(two.size));
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
    const c = document.querySelector('#gl'), g = c.getContext('webgl2') || c.getContext('webgl');
    const px = new Uint8Array(4);
    g.readPixels(Math.round(c.width/2), Math.round(c.height/2), 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
    return [...px];
  });
  ok('a camera inside the car sees the green screen, not the inside of a shell',
     mid[1] > 70 && mid[1] > mid[0] * 1.6 && mid[1] > mid[2] * 1.6, `rgb ${mid.slice(0,3).join(',')}`);
  await t3.page.screenshot({ path: `${OUT}/in-car.png` });
  // 説明文は外した（押せば分かることを、押す前に読ませない）
  await t3.page.click('#items .itemrow[data-kind="car"] > button.name'); await t3.page.waitForTimeout(300);
  ok('and the panel does not lecture about it',
     !(await t3.page.textContent('#selbody')).includes('ガラスになっていません'));

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
  const box = await t.page.locator('#gl').boundingBox();
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
    const c = document.querySelector('#gl');
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
  // 見出しは付けない。ボタンの名前がそのまま見出しなので、同じことを 2 回言うだけになる
  ok('the share tab carries no headings at all',
     (await t.page.$$('[data-sec="share"] h2')).length === 0);
  const btns = await t.page.$$eval('[data-sec="share"] .btn', n => n.map(x => x.textContent.trim()));
  ok('every button says what it does on its own (and the project file is gone)',
     btns.join('/') === '共有リンク/共有QRコード/PDF資料作成/画像書き出し/3Dデータ書き出し（GLB）/HTML書き出し',
     btns.join('/'));
  // どれか 1 つが既定の道具ではないので、オレンジ（primary）は付けない
  ok('and none of them is painted as the one to press',
     (await t.page.$$('[data-sec="share"] .btn.primary')).length === 0);
  // 見るだけは共有タブからも QR からも外した（新しく作る道はもう無い）
  ok('the view-only button is gone', !(await t.page.$('#copyview')));
  // URL の欄はクリップボードが塞がれているときだけ出る
  ok('the URL box stays out of the way', await t.page.evaluate(() => document.getElementById('linkbox').hidden));
  // リンクと QR のすぐ下で、実体が乗らないことを言う
  const shareHint = await t.page.$eval('[data-sec="share"] .hint', e => e.textContent.trim());
  ok('the link says the 3D data does not ride along', shareHint === '※外部3Dデータは含まれません。', shareHint);
  // 説明はこの 2 行だけ。PDF の下の「押したあとの画面で選べます」は、押せば分かるので外した
  const hints = await t.page.$$eval('[data-sec="share"] .hint', n => n.map(x => x.textContent.trim()));
  ok('and the share tab carries no other blurb',
     hints.join('|') === '※外部3Dデータは含まれません。|外部3Dデータと人物・車のモデルをすべて含めたHTMLファイルとして書き出します。オフライン環境のPCで開く事が可能です。',
     hints.join('|'));
  // ＋ の取り込みは、名前と 3 行だけ
  await t.page.click('#addfab'); await t.page.waitForTimeout(300);
  ok('the import button is called 外部3Dデータ', (await t.page.textContent('#pick')).trim() === '外部3Dデータ');
  const imp = (await t.page.$eval('#addpop .popbody .hint', e => e.textContent)).replace(/\s+/g, '');
  ok('and its blurb is three short lines',
     imp === '対応3Dデータ（GLB/glTF/FBX）120MB以下対応3DGS（.spz/.ply）240MB以下URL共有時には外部3Dデータは含まれません。', imp);
  await t.page.click('#addclose'); await t.page.waitForTimeout(200);
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
  const box = await m.page.locator('#gl').boundingBox();
  await m.page.evaluate(([x, y]) => {
    const c = document.querySelector('#gl');
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

// --- 23. home-screen app: keep clear of the notch and the home bar -----------------
{
  // iPhone にホーム画面から入れると viewport-fit=cover で画面いっぱいに広がり、
  // 上のボタンがノッチの下に潜る。ブラウザで開いたときは 0 のままであること。
  // Chromium に本物のノッチは無いので、変数を差し込んで配線だけ見る。
  const t = await open('safearea', { width: 390, height: 844 }, true);
  await t.page.waitForTimeout(600);
  const vars = await t.page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ['--sat','--sar','--sab','--sal'].map(v => cs.getPropertyValue(v).trim()).join('/');
  });
  ok('a plain browser keeps every inset at zero', vars === '0px/0px/0px/0px', vars);
  const box = () => t.page.evaluate(() => Object.fromEntries(
    ['viewbtns','gear','addfab','pipbtn','undobtn'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, {t:Math.round(r.top), b:Math.round(r.bottom), l:Math.round(r.left)}];
    })));
  const before = await box();
  await t.page.addStyleTag({ content: ':root{--sat:59px;--sab:34px;--sal:0px;--sar:0px}' });
  await t.page.waitForTimeout(300);
  const after = await box();
  ok('the view buttons drop below the notch', after.viewbtns.t - before.viewbtns.t === 59,
     `${before.viewbtns.t} -> ${after.viewbtns.t}`);
  const up = k => before[k].b - after[k].b;
  ok('and the corner buttons lift off the home bar',
     up('gear') === 34 && up('addfab') === 34 && up('pipbtn') === 34 && up('undobtn') === 34,
     JSON.stringify({gear:up('gear'), addfab:up('addfab'), pipbtn:up('pipbtn'), undobtn:up('undobtn')}));
  await t.page.screenshot({ path: `${OUT}/safearea.png` });
  // パネルを開くと下の辺はパネルが受け持つので、ボタンは二重に上がらない
  await t.page.click('#gear'); await t.page.waitForTimeout(400);
  const panelOpen = await t.page.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect();
    return {b: Math.round(r.bottom), h: innerHeight}; });
  ok('with the panel out, its background still reaches the edge', panelOpen.b === panelOpen.h,
     JSON.stringify(panelOpen));
  ok('safe-area run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 24. the camera can be grabbed between the tripod legs ------------------------
{
  const scene = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:10,d:8,h:4.5,cove:{back:true,left:true,right:true}},
    activeCam:'c1', items:[{id:'c1',type:'camera',x:0,z:2,y:1.3,rot:180,pitch:-6,roll:0,sensor:'ff',focal:35,aspect:'16:9'}]};
  const t = await open('camhit', { width: 1200, height: 820 }, false, '#s=' + encodeState(scene));
  await t.page.waitForTimeout(1200);
  for (const v of ['plan','pers','side','front']){
    await t.page.click(`[data-view="${v}"]`); await t.page.waitForTimeout(400);
    const r = await t.page.evaluate(() => {
      const sp = window.__sp; sp.select(null);
      const it = sp.state().items[0], g = sp.group(it.id);
      const cam = sp.camera(), box = document.querySelector('#gl').getBoundingClientRect();
      // 脚 2 本のあいだ（三角錐の面の真ん中あたり）を狙う。軸の上だと、
      // 上面と正面では 1 本目の脚がちょうど重なって「隙間」にならない。
      // 三脚は spread = max(0.14, y*0.34)、脚の集まる高さ top = max(0.10, y-0.12)、
      // 足は a = i/3*2π + π に置いてある（buildCamera と同じ）
      const spread = Math.max(0.14, it.y*0.34), top = Math.max(0.10, it.y - 0.12);
      const a2 = Math.PI + Math.PI/3, rr = spread*0.3;           // 足 0 と 1 のあいだ
      // 脚はグループのローカル座標に置いてあり、グループ全体が向き（rot）ぶん
      // 回っている。世界座標で角度を作ると、回った先で脚と重なる
      g.updateMatrixWorld(true);
      const p = g.localToWorld(new sp.THREE.Vector3(Math.sin(a2)*rr, top*0.25, Math.cos(a2)*rr)).project(cam);
      const x = (p.x + 1)/2 * box.width, y = (1 - p.y)/2 * box.height;
      const withCone = sp.pick(x, y)?.id || null;
      const cones = []; g.traverse(n => { if (n.isMesh && n.geometry.type === 'ConeGeometry' && n.material.opacity === 0) cones.push(n); });
      for (const c of cones) c.userData.noHit = true;
      const without = sp.pick(x, y)?.id || null;
      for (const c of cones) c.userData.noHit = false;
      return {withCone, without, cones: cones.length, invisible: cones.every(c => c.material.opacity === 0)};
    });
    ok(`${v}: the gap between the legs selects the camera`, r.withCone === 'c1' && r.cones === 1, JSON.stringify(r));
    ok(`${v}: and it was the added volume that did it`, r.without === null, JSON.stringify(r));
    ok(`${v}: the volume itself stays invisible`, r.invisible);
  }
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(400);
  await t.page.screenshot({ path: `${OUT}/camhit.png` });
  ok('camera hit run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 25. a location scan (3D gaussian splatting) -----------------------------------
{
  const t = await open('scan', { width: 1300, height: 860 });
  const ply = `${OUT}/scan.ply`; fs.writeFileSync(ply, makeSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.waitForTimeout(2500);
  const it = await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'splat'));
  ok('a .ply scan comes in as a location', it.type === 'splat' && !!it.key, JSON.stringify(it));
  ok('and it is measured at its real size', Math.abs(it.w - 2) < 0.4 && Math.abs(it.h - 2) < 0.4,
     `${it.w} x ${it.d} x ${it.h} m`);
  ok('it sits at the origin, not nudged aside', it.x === 0 && it.z === 0);
  ok('the list calls it 3DGS',
     (await t.page.textContent('#items .itemrow[data-kind="splat"] > button.name')).includes('3DGS'));

  // 現場ぜんぶを覆うので、クリックでは拾わない（中の人やカメラが選べなくなる）
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(600);
  const overIt = await t.page.evaluate(() => {
    const sp = window.__sp; sp.select(null);
    const s = sp.state().items.find(i => i.type === 'splat');
    const box = document.querySelector('#gl').getBoundingClientRect();
    const p = new sp.THREE.Vector3(s.x, (s.h || 2) * 0.5, s.z).project(sp.camera());
    return sp.pick((p.x + 1)/2 * box.width, (1 - p.y)/2 * box.height)?.id || null;
  });
  ok('clicking the scan does not select it', overIt === null, String(overIt));

  // スタジオを消せる。消す前のグリッドの広さを控えておく
  const gridSize = () => t.page.evaluate(() => {
    const sp = window.__sp; let g = null;
    sp.scene.traverse(n => { if (n.userData.grid) g = n; });
    if (!g) return null;
    let vis = g.visible, p = g.parent;
    while (p){ vis = vis && p.visible; p = p.parent; }
    const b = new sp.THREE.Box3().setFromObject(g);
    return {vis, x:+b.max.x.toFixed(1), z:+b.max.z.toFixed(1)};
  });
  const roomGrid = await gridSize();
  await t.page.click('#items .itemrow[data-kind="studio"] .ico.eye'); await t.page.waitForTimeout(500);
  ok('the studio can be switched off for a location',
     await t.page.evaluate(() => window.__sp.state().studio.hidden === true));
  // スタジオを消してもグリッドは残る。3DGS だけで使うとき、床の目盛りが無いと
  // 大きさの見当が付かない（以前はグリッドが studioGroup の中に居たので一緒に消えた）
  const grid = await gridSize();
  ok('the grid stays after the studio is switched off', !!grid && grid.vis, JSON.stringify(grid));
  // 部屋（10 x 8）が消えたので、スキャン（2 m 角）に合わせて引き直される
  ok('and it shrinks to the scan it is left with', !!grid && grid.x < roomGrid.x && grid.z < roomGrid.z,
     `${roomGrid.x}x${roomGrid.z} -> ${grid.x}x${grid.z}`);

  // 目のマークで消したら、視点を動かさなくてもその場で消える
  await t.page.click('#items .itemrow[data-kind="splat"] .ico.eye'); await t.page.waitForTimeout(1800);
  const gone = await t.page.evaluate(() => {
    const sp = window.__sp; let n = 0;
    sp.scene.traverse(o => { if (o.constructor?.name === 'SplatMesh' || o.type === 'SplatMesh') n++; });
    return {drawn: sp.spark()?.activeSplats ?? -1, inScene: n};
  });
  ok('the eye empties the scan without waiting for the view to move', gone.drawn === 0, JSON.stringify(gone));
  await t.page.click('#items .itemrow[data-kind="splat"] .ico.eye'); await t.page.waitForTimeout(1800);
  ok('and bringing it back fills it again',
     (await t.page.evaluate(() => window.__sp.spark()?.activeSplats ?? 0)) > 0);
  await t.page.click('#items .itemrow[data-kind="studio"] .ico.eye'); await t.page.waitForTimeout(500);
  await t.page.screenshot({ path: `${OUT}/scan.png` });

  // 共有リンクには置き方だけ。実体（10 MB 級）は原理的に載らない
  const link = await t.page.evaluate(() => location.href);
  ok('the link stays small', link.length < 1200, `${link.length} chars`);
  const t2 = await open('scan-shared', { width: 1100, height: 760 }, false, link.slice(link.indexOf('#')));
  await t2.page.waitForTimeout(1500);
  const there = await t2.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'splat'));
  ok('the other device gets the placement', !!there && there.key === it.key);
  await t2.page.click('#items .itemrow[data-kind="splat"] > button.name'); await t2.page.waitForTimeout(400);
  ok('and is told the scan itself is not there',
     (await t2.page.textContent('#selbody')).includes('この端末にありません'),
     (await t2.page.textContent('#selbody')).slice(0, 60));
  ok('scan run clean', t.errors.length === 0 && t2.errors.length === 0, [...t.errors, ...t2.errors].join(' | '));
  await t2.ctx.close(); await t.ctx.close();
}

// --- 26. cropping a location -------------------------------------------------------
{
  const t = await open('crop', { width: 1300, height: 860 });
  const ply = `${OUT}/scan.ply`; fs.writeFileSync(ply, makeSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.waitForTimeout(2500);
  await t.page.click('#items .itemrow[data-kind="splat"] > button.name'); await t.page.waitForTimeout(400);
  const panel0 = await t.page.textContent('#selbody');
  ok('a 3DGS offers 切り取り', panel0.includes('切り取り'));
  // 3DGS は現場そのもの。寸法を書いても図面にならないので、表示も設定も出さない
  ok('and carries no dimension switches', !panel0.includes('寸法表示'), panel0.slice(0, 80));
  // 向きは高さ調整の上。置き方を決める順に並べる
  const order = await t.page.$$eval('#selbody label.f span:first-child', n => n.map(x => x.textContent));
  ok('向き comes above 高さ調整',
     order.indexOf('向き') >= 0 && order.indexOf('向き') < order.indexOf('高さ調整'), order.join('/'));
  await t.page.click('#selbody [data-set="cropOn"]'); await t.page.waitForTimeout(900);
  const on = await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'splat').crop);
  ok('switching it on starts at the scan\'s own size', on && Math.abs(on.x1 - on.x0 - 2) < 0.4 && on.y0 === 0,
     JSON.stringify(on));
  // 6 面のつまみが出て、絵の中の箱も出る
  const gizmo = await t.page.evaluate(() => {
    const hg = window.__sp.handles();
    return { handles: hg.children.filter(k => k.isMesh).length, frame: hg.children.filter(k => k.isLineSegments).length };
  });
  ok('six handles and the frame are drawn', gizmo.handles === 6 && gizmo.frame === 1, JSON.stringify(gizmo));
  // つまみが 6 個あるのだから、数字も 6 個ある
  const cropRanges = await t.page.$$eval('#selbody [data-range^="crop."]', n => n.map(x => x.dataset.range));
  ok('and all six edges have a slider too', cropRanges.length === 6 &&
     ['crop.x0','crop.x1','crop.y0','crop.y1','crop.z0','crop.z1'].every(k => cropRanges.includes(k)),
     cropRanges.join(','));
  // 左右も追い越せない（追い越すと箱が裏返って全部消える）
  const clamped = await t.page.evaluate(() => {
    const sp = window.__sp, s = sp.state().items.find(i => i.type === 'splat');
    sp.setProp(s, 'crop.x1', -9); return sp.cropBox(s);
  });
  ok('the near edge cannot overtake the far one', clamped.x1 > clamped.x0, JSON.stringify(clamped));
  // 上端を下げると、上面の寸法もその範囲になる
  await t.page.evaluate(() => {
    const sp = window.__sp, s = sp.state().items.find(i => i.type === 'splat');
    sp.setProp(s, 'crop.y1', 1.2);
    s.crop = {...s.crop, x0: -0.5, x1: 0.5}; sp.refreshCrop(s);
  });
  await t.page.waitForTimeout(600);
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(1200);
  const lab = await t.page.$$eval('#labels span', n => n.map(x => x.textContent).join(' | '));
  ok('the plan writes no size for a 3DGS', !/3DGS/.test(lab), lab.slice(0, 160));
  // 消したのは見た目だけ。データには触っていない
  const link = await t.page.evaluate(() => location.hash);
  ok('the crop rides along in the link, and it stays small', link.length < 700, `${link.length} chars`);
  await t.page.click('#selbody [data-set="cropOn"][data-val=""]'); await t.page.waitForTimeout(700);
  ok('全体表示 puts it back',
     (await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'splat').crop)) == null);
  ok('crop run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 27. まとめて書き出す: one file that opens with no network at all ----------------
{
  const t = await open('bundle', { width: 1200, height: 820 });
  await t.addPerson('asia-casual-man');
  const ply = `${OUT}/scan.ply`; fs.writeFileSync(ply, makeSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.waitForTimeout(2500);
  await t.page.evaluate(() => {
    const sp = window.__sp, s = sp.state().items.find(i => i.type === 'splat');
    sp.select(s.id); sp.setProp(s, 'cropOn', '1'); sp.setProp(s, 'crop.y1', 1.4);
  });
  await t.tab('share');
  await t.page.evaluate(() => { delete window.showSaveFilePicker; });     // OS のダイアログは headless では出せない
  await t.page.click('#bundlebtn');
  await t.page.waitForSelector('#namedlg.on', { timeout: 300000 });
  const dl = await Promise.all([t.page.waitForEvent('download'), t.page.click('#nameok')]).then(r => r[0]);
  const file = `${OUT}/bundle.html`;
  await dl.saveAs(file);
  const mb = fs.statSync(file).size / 1024 / 1024;
  ok('it writes one html file with everything in it', mb > 3, `${mb.toFixed(1)} MB`);
  ok('and says so', /まとめました/.test(await t.page.textContent('#bundlestat')), await t.page.textContent('#bundlestat'));
  await t.ctx.close();

  // ---- ダブルクリック相当。通信は 1 本も出さない ----
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [], outbound = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // MediaPipe の CPU 推定は「INFO: Created TensorFlow Lite XNNPACK delegate」を console.error で出す。案内であって不具合ではない
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource|XNNPACK delegate/.test(m.text())) errors.push(m.text()); });
  page.on('request', r => { if (/^https?:/.test(r.url())) outbound.push(r.url()); });
  await page.goto('file://' + file);
  await page.waitForTimeout(9000);
  const got = await page.evaluate(() => {
    const sp = window.__sp; if (!sp) return null;
    const st = sp.state();
    const person = st.items.find(i => i.type === 'person'), splat = st.items.find(i => i.type === 'splat');
    let skinned = 0; if (person) sp.group(person.id).traverse(n => { if (n.isSkinnedMesh) skinned++; });
    const names = []; if (splat) sp.group(splat.id).traverse(n => names.push(n.constructor.name));
    return { items: st.items.length, skinned, names, crop: splat?.crop || null, bundled: !!window.__SPBUNDLE };
  });
  ok('the file opens from file:// on its own', !!got && got.bundled, JSON.stringify(got));
  ok('with no network at all', outbound.length === 0, outbound.join(' '));
  ok('the person model comes out of the file', got.skinned > 0, JSON.stringify(got.names));
  ok('the scan too, cropped as it was left', got.names.some(n => /SplatMesh/.test(n)) && got.crop?.y1 === 1.4,
     JSON.stringify({names: got.names, crop: got.crop}));
  // **置いていないものも中に入っている。** 圏外のスタジオで開いて、そこから人を
  // 足したり車を置いたりできないと「続きをやる」にならない
  const stock = await page.evaluate(() => {
    const f = window.__SPBUNDLE.files, sp = window.__sp;
    const people = sp.people().map(m => `models/${m.id}.glb`);
    return {people: people.filter(p => f[p]).length, all: people.length,
            cars: Object.keys(f).filter(k => /^models\/car-.*\.glb$/.test(k)).length};
  });
  ok('every person and car is in the file, not just the ones on the floor',
     stock.people === stock.all && stock.cars >= 2, JSON.stringify(stock));
  await page.click('#addfab'); await page.waitForTimeout(800);
  await page.click('#people button[data-model="af-casual-man"]');
  await page.waitForTimeout(3500);
  const added = await page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.at(-1);
    let skinned = 0; sp.group(it.id).traverse(n => { if (n.isSkinnedMesh) skinned++; });
    return {model: it.model, skinned};
  });
  ok('so a person who was never placed can still be added, offline',
     added.model === 'af-casual-man' && added.skinned > 0, JSON.stringify(added));
  // スーツは `+` に出ないので、着替えでしか出番が来ない。それも入っている
  await page.click('#items .itemrow.on > button.name').catch(() => {});
  await page.waitForTimeout(400);
  await page.click('[data-set="model"][data-val="af-business-man"]');
  await page.waitForTimeout(3500);
  const dressed = await page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.model && i.model.startsWith('af-'));
    let skinned = 0; sp.group(it.id).traverse(n => { if (n.isSkinnedMesh) skinned++; });
    return {model: it.model, skinned};
  });
  ok('and a suit that was never on screen can still be worn',
     dressed.model === 'af-business-man' && dressed.skinned > 0, JSON.stringify(dressed));
  // **共有リンクは Web で開ける URL にする。** file:// のパスを配っても誰も開けない
  const link = await page.evaluate(async () => {
    document.getElementById('linkbox').hidden = false;
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('linkbox').value;
  });
  ok('and the share link points at the web, not at this file', /^https?:\/\//.test(link), link.slice(0, 60));
  fs.writeFileSync(path.join(OUT, 'bundle-file.png'), await page.screenshot());
  ok('bundle run clean', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --- 28. 3DGS が鏡に映る ------------------------------------------------------------
// スキャンだけは「重いうえ、並べ替えが別視点で狂う」を理由に鏡から外していた。
// 並べ替えは本体のカメラのぶんを使い回す（autoUpdate を切る）ことで入れてある
{
  const t = await open('splat-mirror', { width: 1200, height: 800 });
  const ply = `${OUT}/scan-colour.ply`; fs.writeFileSync(ply, makeColourSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.waitForTimeout(2500);
  await t.add('[data-add="mirror"]');
  // 左手に立て鏡を構え、スキャンをその正面に置く
  await t.page.evaluate(() => {
    const sp = window.__sp, st = sp.state();
    const m = st.items.find(i => i.type === 'mirror'); m.x = -4.4; m.z = 0.5;
    sp.setProp(m, 'kind', 'wall'); sp.setProp(m, 'h', 3.5); sp.setProp(m, 'rot', 90); sp.setProp(m, 'w', 6);
    const s = st.items.find(i => i.type === 'splat'); s.x = 0.5; s.z = 0.5; sp.setProp(s, 'lift', 0);
    sp.select(null);
  });
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(3500);
  // 鏡の面のまん中あたりを読む。スキャンを消したときと比べて、そこが変わっていれば映っている
  const readMirror = () => t.page.evaluate(() => {
    const sp = window.__sp, m = sp.state().items.find(i => i.type === 'mirror');
    const cv0 = document.querySelector('#gl'), box = cv0.getBoundingClientRect();
    const p = new sp.THREE.Vector3(m.x, m.h * 0.5, m.z).project(sp.camera());
    const cv = document.createElement('canvas'); cv.width = box.width; cv.height = box.height;
    const cx = cv.getContext('2d'); cx.drawImage(cv0, 0, 0, box.width, box.height);
    const x = Math.round((p.x + 1)/2 * box.width), y = Math.round((1 - p.y)/2 * box.height);
    return [...cx.getImageData(x - 40, y - 40, 80, 80).data];
  });
  const withScan = await readMirror();
  await t.page.screenshot({ path: `${OUT}/splat-mirror.png` });
  await t.page.click('#items .itemrow[data-kind="splat"] .ico.eye'); await t.page.waitForTimeout(2500);
  const without = await readMirror();
  let moved = 0;
  for (let i = 0; i < withScan.length; i += 4) if (Math.abs(withScan[i] - without[i]) > 10) moved++;
  ok('the scan turns up in the mirror', moved > 400, `${moved} of ${withScan.length / 4} px changed`);
  ok('splat mirror run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 28b. 3DGS ＋ カメラ小窓：並べ替えが 2 つのカメラで取り合いにならない -------------
// 小窓は本体と同じ 1 フレームの中でもう一度描かれる。Spark は「前に並べたカメラから
// 動いたか」で並べ直すかを決めるので、視点が 2 つ交互に来ると**どちらの回も必ず
// 「動いた」になり、並べ替えが終わらない**。終わるたびに onDirty で次のフレームが
// 呼ばれるため描画も止まらず、絵は 2 つの並び順のあいだで揺れ続ける（寺村さんの
// 「小窓を出すと 3DGS がちらつく」）。**手を離せば止まる**ことで見る。
{
  const t = await open('splat-pip', { width: 1200, height: 800 });
  const ply = `${OUT}/scan-pip.ply`; fs.writeFileSync(ply, makeColourSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.evaluate(() => window.__sp.select(null));
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(4000);
  // 小窓が出ていること自体が前提。出ていなければこのテストは何も見ていない
  ok('the camera window is up while a scan is on stage',
     await t.page.evaluate(() => !document.getElementById('pip').hidden));
  // 何も触らずに 2 秒あけて 2 回数える。落ち着いていれば描画は 1 枚も増えない
  const frames = () => t.page.evaluate(() => window.__sp.renderer.info.render.frame);
  await t.page.waitForTimeout(2500);
  const a = await frames(); await t.page.waitForTimeout(2000); const b = await frames();
  ok('the sort settles instead of the two cameras fighting over it', b - a <= 4, `${b - a} draws in 2 s`);
  ok('and nothing is left mid-sort', await t.page.evaluate(() => {
    const s = window.__sp.spark(); return !s || !(s.sorting || s.sortDirty);
  }));
  // 並べ替えたのが**どちらのカメラか**を直に見る。Spark は最後に並べた視点を
  // sortedCenter に控えているので、それが本体のビューのカメラと一致していれば
  // 小窓に取られていない（ファインダーは床の高さに立っていて、パースの視点とは
  // まるで違う場所に居る）
  const sorter = () => t.page.evaluate(() => {
    const sp = window.__sp, s = sp.spark();
    const eye = sp.camera().getWorldPosition(new sp.THREE.Vector3());
    return { d: s.sortedCenter.distanceTo(eye), eye: eye.toArray().map(v => +v.toFixed(2)) };
  });
  const s1 = await sorter();
  ok('and it is the main view that did the sorting, not the little window',
     s1.d < 0.01, `${s1.d.toFixed(3)} m from the eye at ${s1.eye}`);
  // 切りっぱなしにしないこと。戻し忘れると、本体を回しても並べ替えが走らなくなる
  ok('the main view keeps the right to re-sort',
     await t.page.evaluate(() => window.__sp.spark()?.autoUpdate === true));
  await t.page.mouse.move(350, 420); await t.page.mouse.down();
  await t.page.mouse.move(470, 450, { steps: 6 }); await t.page.mouse.up();
  await t.page.waitForTimeout(2500);
  const s2 = await sorter();
  ok('moving the eye sorts again, for the new viewpoint',
     s2.d < 0.01 && s2.eye.join() !== s1.eye.join(), `${s1.eye} -> ${s2.eye}`);
  const c = await frames(); await t.page.waitForTimeout(1500);
  ok('and it comes to rest again once the hand is off',
     (await frames()) - c <= 4, `${(await frames()) - c} draws in 1.5 s`);
  await t.page.screenshot({ path: `${OUT}/splat-pip.png` });
  ok('splat pip run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 28c. 大きな 3DGS：動かせる範囲と、1/100〜100 倍の拡大縮小 ---------------------
// 街並みのスキャンを持ち込むと、部屋の寸法で決めた範囲では何も置けない
// （寺村さんの指摘）。**大きいものを入れるまでは今までどおり**で、入れたら
// 移動範囲・画面・グリッド・カメラの far がそちらへ広がる、という形にしてある
{
  const t = await open('big-scan', { width: 1200, height: 800 });
  // --- まだ何も入れていないうち。ここが変わっていたら普段の仕事が壊れている ---
  const before = await t.page.evaluate(() => {
    const sp = window.__sp, st = sp.state();
    return { limit: sp.limit(), world: sp.world(), studio: [st.studio.w, st.studio.d],
             grid: sp.grid() };
  });
  ok('with nothing big in the scene the world is still just the room',
     before.world.reach === 0 && before.world.size === 0, JSON.stringify(before.world));
  ok('so objects still stop at the walls, exactly as before',
     Math.abs(before.limit[0] - (before.studio[0]/2 - 0.2)) < 1e-9 &&
     Math.abs(before.limit[1] - (before.studio[1]/2 - 0.2)) < 1e-9, JSON.stringify(before.limit));
  ok('and the grid is still drawn every metre', before.grid[2] === 1, JSON.stringify(before.grid));
  // --- 街並みを想定して、2 m のスキャンを 100 倍にする ---
  const ply = `${OUT}/scan-big.ply`; fs.writeFileSync(ply, makeColourSplatPLY());
  await t.page.click('#addfab');
  await t.page.setInputFiles('#file', ply);
  await t.page.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 });
  await t.page.click('#items .itemrow[data-kind="splat"] > button.name'); await t.page.waitForTimeout(400);
  // 拡大縮小は対数のつまみ。つまみ自身は 0〜1000 の整数で、真ん中がちょうど 1 倍
  const sc = await t.page.$('[data-range="scale"]');
  const attrs = await sc.evaluate(n => [n.dataset.log, n.min, n.max]);
  ok('the scale slider runs from 1/100 to 100', attrs[0] === '0.01:100', attrs.join(' '));
  const setScale = async pos => {
    await t.page.$eval('[data-range="scale"]', (n, v) => {
      n.value = String(v);
      n.dispatchEvent(new Event('input', {bubbles:true}));
      n.dispatchEvent(new Event('change', {bubbles:true}));
    }, pos);
    await t.page.waitForTimeout(300);
    return t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'splat').scale);
  };
  ok('its middle is exactly 1x, so the everyday value is not squashed into a corner',
     (await setScale(500)) === 1);
  ok('one end is 1/100', (await setScale(0)) === 0.01);
  ok('the other is 100x', (await setScale(1000)) === 100);
  // --- 100 倍にしたあと。世界はそこまで広がっている ---
  const after = await t.page.evaluate(() => {
    const sp = window.__sp;
    return { limit: sp.limit(), world: sp.world(), grid: sp.grid() };
  });
  ok('the world now reaches out to the scan', after.world.size > 90, JSON.stringify(after.world));
  ok('and objects can be moved that far out', after.limit[0] > 90, JSON.stringify(after.limit));
  // 実際に setPos を通す。クランプはここにしか無いので、ここが効いていなければ嘘になる
  const moved = await t.page.evaluate(() => {
    const sp = window.__sp, cam = sp.state().items.find(i => i.type === 'camera');
    sp.setPos(cam, 90, -90); return [cam.x, cam.z];
  });
  ok('a camera really goes 90 m down the street', moved[0] === 90 && moved[1] === -90, JSON.stringify(moved));
  // グリッドは 1 m では引かない。**引くと線が数千本になり、絵としても意味を失う**
  ok('the grid steps up instead of drawing thousands of 1 m lines',
     after.grid[2] > 1 && after.grid[0] >= 90, JSON.stringify(after.grid));
  ok('and the readout says what the spacing is now',
     (await t.page.textContent('#info')).includes(`グリッド ${after.grid[2]} m`),
     await t.page.textContent('#info'));
  // 上面図がスキャンごと入る大きさになっていること（部屋の寸法のままだと画面外）
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(600);
  const frame = await t.page.evaluate(() => { const c = window.__sp.camera(); return [c.right - c.left, c.far]; });
  ok('the plan view frames the whole scan, not just the room', frame[0] > 180, `${frame[0].toFixed(0)} m across`);
  ok('and nothing is clipped away by a far plane left at the studio size', frame[1] > 200, String(frame[1]));
  await t.page.screenshot({ path: `${OUT}/big-scan.png` });
  ok('big scan run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 28d. コロフォン ----------------------------------------------------------------
{
  const t = await open('colophon', { width: 1200, height: 800 });
  await t.tab('share');
  const col = await t.page.$eval('.colophon', n => ({ text: n.textContent, href: n.querySelector('a')?.href }));
  ok('the colophon carries the site under the copyright',
     col.href === 'https://www.taichi-teramura.com/', col.href);
  ok('and the copyright is still there', col.text.includes('© 2026 Taichi Teramura'), col.text);
  ok('colophon run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 29. 書き出しボタンの名前、取り込みの上限、iPhone のファイル選び ------------------
{
  // 上限は「現場のスキャンが入らない」と言われて倍にしたもの。下げると元に戻るので、
  // 数字そのものと、画面に出す文言が一致していることを見る（片方だけ直すのが怖い）
  const appSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const caps = [...appSrc.matchAll(/f\.size > (\d+)\*1024\*1024\)\{ toast\(`\$\{f\.name\} は大きすぎます（(\d+)MB まで）/g)]
    .map(m => [+m[1], +m[2]]);
  ok('a 3D model may be 120 MB and a 3DGS scan 240 MB',
     caps.map(c => c[0]).join('/') === '120/240', JSON.stringify(caps));
  ok('and each cap says the number it actually enforces',
     caps.length === 2 && caps.every(([n, said]) => n === said), JSON.stringify(caps));

  const t = await open('naming', { width: 1200, height: 820 });
  await t.tab('share');
  ok('the one-file export is called HTML書き出し',
     (await t.page.textContent('#bundlebtn')).trim() === 'HTML書き出し',
     await t.page.textContent('#bundlebtn'));
  // PC では accept を残す。読める形式だけが並んで、選ぶのが速い
  ok('a desktop browser keeps the accept list',
     (await t.page.getAttribute('#file', 'accept') || '').includes('.spz'));
  ok('naming run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}
{
  // iOS のファイル App は、accept に知らない拡張子が並ぶと中身をまとめてグレーアウトする。
  // .spz / .ply / .glb / .fbx はどれも UTI を持たないので、iPhone では accept ごと外す
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.180.0/', '');
    const f = path.join(NM, 'three', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }); else route.fulfill({ status: 404 });
  });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://localhost:8765/');
  await page.waitForTimeout(1500);
  ok('an iPhone is given no accept list, so .spz and .ply can be picked',
     (await page.getAttribute('#file', 'accept')) === null,
     String(await page.getAttribute('#file', 'accept')));
  ok('iphone picker run clean', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// --- 30. ＋ で置いても、パネルの開き／畳みは置く前のまま --------------------------
// 携帯は畳んであるのが既定。＋ で置くたびに設定パネルがせり上がると図が半分になり、
// 続けて置きたいだけの人には邪魔でしかない（寺村さんの指摘）
{
  const t = await open('addfold', { width: 390, height: 844 }, true);
  const folded = () => t.page.evaluate(() => document.body.classList.contains('folded'));
  ok('a phone starts with the panel folded away', await folded() === true);
  await t.add('[data-add="box"]');
  ok('and placing something leaves it folded', await folded() === true);
  // 置いたものは選ばれている。開けばその設定が出る、は今までどおり
  const picked = await t.page.evaluate(() => {
    const sp = window.__sp, id = sp.sel();
    return {id, type: sp.state().items.find(i => i.id === id)?.type,
            tab: document.querySelector('#tabs button.on')?.dataset.tab};
  });
  ok('the new object is still the selected one', picked.type === 'box', JSON.stringify(picked));
  ok('and the list tab is the one waiting behind the gear', picked.tab === 'list', picked.tab);
  // 歯車で開けば開く。開いたまま足しても閉じない
  await t.page.click('#gear'); await t.page.waitForTimeout(250);
  ok('the gear still opens it', await folded() === false);
  ok('and the settings for it are there', (await t.page.textContent('#selbody')).includes('幅'));
  await t.add('[data-add="chair"]');
  ok('placing another one leaves it open', await folded() === false);
  ok('add-fold run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 31. 指だけの端末：長押しでメニュー、画面は文字選択にならない -------------------
// スマホで長押し／感圧タッチをすると画面じゅうが「文字選択」に化けていた。
// 一覧の行も、iOS Safari は contextmenu を投げないのでメニューが出ず選択になっていた
{
  const t = await open('touchmenu', { width: 390, height: 844 }, true);
  const css = await t.page.evaluate(() => [...document.querySelectorAll('style')].map(s => s.textContent).join(''));
  const how = await t.page.evaluate(() => {
    const g = el => getComputedStyle(el);
    return {body: g(document.body).userSelect, input: g(document.getElementById('linkbox')).userSelect};
  });
  ok('the page itself cannot be text-selected', how.body === 'none', JSON.stringify(how));
  ok('but the text fields still can be', how.input === 'text', how.input);
  // -webkit-touch-callout は WebKit だけのものなので、Chromium では配線だけ見る
  ok('and iOS is told to skip the callout and the force-touch preview',
     /body\{[^}]*-webkit-touch-callout:\s*none/.test(css));

  await t.page.click('#gear'); await t.page.waitForTimeout(250);      // 携帯は畳んで始まる
  const rowSel = '#items .itemrow[data-id] > button.name';
  const row = t.page.locator(rowSel).first();
  const box = await row.boundingBox();
  const at = {clientX: Math.round(box.x + box.width/2), clientY: Math.round(box.y + box.height/2), bubbles: true};
  const menu = () => t.page.evaluate(() => {
    const c = document.getElementById('ctx');
    return {open: !c.hidden, items: [...c.querySelectorAll('button')].map(b => b.textContent),
            guard: getComputedStyle(c).pointerEvents};
  });
  await row.dispatchEvent('pointerdown', {pointerType:'touch', ...at});
  await t.page.waitForTimeout(750);
  let m = await menu();
  ok('a long press on an object row opens the right-click menu',
     m.open && m.items.join('/') === '名前を変更/ロック/複製/削除', JSON.stringify(m));
  // 指の真下に出るので、離した瞬間の click で 1 行目が押されないようにしてある
  ok('and the finger that opened it cannot fall through onto it', m.guard === 'none', m.guard);
  await t.page.waitForTimeout(450);
  ok('it takes taps a moment later',
     (await t.page.evaluate(() => getComputedStyle(document.getElementById('ctx')).pointerEvents)) !== 'none');
  await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(150);

  // マウスには効かせない（右クリックがある）
  await row.dispatchEvent('pointerdown', {pointerType:'mouse', ...at});
  await t.page.waitForTimeout(700);
  ok('a mouse press does not open it', (await menu()).open === false);

  // 指を滑らせたら、それはスクロールか並べ替え
  await row.dispatchEvent('pointerdown', {pointerType:'touch', ...at});
  await row.dispatchEvent('pointermove', {pointerType:'touch', ...at, clientY: at.clientY + 40});
  await t.page.waitForTimeout(700);
  ok('sliding the finger cancels it', (await menu()).open === false);

  // カットの一覧も同じ
  await t.tab('cut');
  await t.page.click('#dupcut'); await t.page.waitForTimeout(400);
  const crow = t.page.locator('#cuts .itemrow > button.name').first();
  const cbox = await crow.boundingBox();
  await crow.dispatchEvent('pointerdown', {pointerType:'touch',
    clientX: Math.round(cbox.x + cbox.width/2), clientY: Math.round(cbox.y + cbox.height/2), bubbles: true});
  await t.page.waitForTimeout(750);
  m = await menu();
  ok('a long press on a cut row opens the cut menu',
     m.open && m.items.join('/') === '名前を変更/複製/削除', JSON.stringify(m));
  await t.page.keyboard.press('Escape');
  await t.page.screenshot({ path: `${OUT}/touchmenu.png` });
  ok('touch menu run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 32. 3D データ書き出し（GLB） --------------------------------------------------
// C4D などで続きをやるための出口。**FBX も書いていたが、C4D が中身を読めなかった**
// ので外した（寺村さんが Blender と C4D の両方で確かめた）。GLB はどちらでも開く。
{
  const t = await open('glb', { width: 1100, height: 800 });
  await t.addPerson('asia-casual-woman');
  await t.add('[data-add="box"]');
  await t.page.evaluate(() => {
    const sp = window.__sp, c = sp.state().items.find(i => i.type === 'camera');
    Object.assign(c, {x:1.2, y:1.5, z:3.0, rot:160, pitch:-8, roll:0});
    sp.setProp(c, 'focal', 35);
  });
  // ファインダーに切り替えてから読む（sp.camera() は今見ているビューのカメラ）
  await t.page.click('[data-view="cam"]'); await t.page.waitForTimeout(700);
  const want = await t.page.evaluate(() => {
    const sp = window.__sp, d = new sp.THREE.Vector3();
    sp.camera().getWorldDirection(d);
    return {dir:[+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)], fov:+sp.camera().fov.toFixed(2)};
  });
  fs.writeFileSync(`${OUT}/glb-reader.html`, `<script type="importmap">{"imports":{"three":"/test/node_modules/three/build/three.module.js","three/addons/":"/test/node_modules/three/examples/jsm/"}}<` + `/script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
window.__read = async () => {
  const g = await new GLTFLoader().loadAsync('/test/out/scene.glb');
  g.scene.updateMatrixWorld(true);
  let meshes = 0, textured = 0, skinned = 0; const names = [];
  g.scene.traverse(n => { if (!n.isMesh) return; meshes++; names.push(n.name);
    if (n.isSkinnedMesh) skinned++;
    const m = [].concat(n.material)[0]; if (m && m.map) textured++; });
  const cams = g.cameras.map(c => { const w = new THREE.Vector3(), d = new THREE.Vector3();
    c.getWorldPosition(w); c.getWorldDirection(d);
    return {name:c.name, pos:[+w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2)],
            dir:[+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)], fov:+c.fov.toFixed(2)}; });
  const b = new THREE.Box3().setFromObject(g.scene), sz = new THREE.Vector3(); b.getSize(sz);
  return {meshes, textured, skinned, names, cams, size:[+sz.x.toFixed(2), +sz.z.toFixed(2)]};
};
window.__ready = true;
<` + `/script>`);
  // 書き出しは「現場に無いもの」を一時的に消して撮る。**終わったら元どおりに
  // 戻っていること** — 戻し忘れると、書き出したあと図面から寸法や記号が消える
  const out = await t.page.evaluate(async () => {
    const shown = () => { const a = []; window.__sp.scene.traverse(n => { if (n.visible) a.push(n.uuid); }); return a.join(','); };
    const before = shown();
    const o = await window.__sp.glb();
    return {same: before === shown(), meshes:o.meshes, cameras:o.cameras, bytes:Array.from(new Uint8Array(o.buf))};
  });
  fs.writeFileSync(`${OUT}/scene.glb`, Buffer.from(out.bytes));
  ok('the GLB is one file with everything in it', out.bytes.length > 100000, `${(out.bytes.length/1024/1024).toFixed(2)} MB`);
  ok('and the screen is left exactly as it was', out.same);
  // ファイルの中の名前をそのまま読む（three のローダーは空白を _ に均すので、
  // 向こうのツリーに出る名前は JSON から確かめる）
  const raw = (() => {
    const b = fs.readFileSync(`${OUT}/scene.glb`);
    return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
  })();
  const nodeNames = raw.nodes.map(n => n.name).filter(Boolean);
  ok('every object carries a name a person can read, not "Node" or "Mesh"',
     !nodeNames.some(n => /^(Node|Mesh|Object)\d*$/.test(n)) && nodeNames.includes('スタジオ 床')
     && nodeNames.includes('スタジオ 天井'), nodeNames.slice(0, 8).join(' | '));
  ok('and the same name is never used twice for the studio',
     new Set(nodeNames.filter(n => n.startsWith('スタジオ'))).size
       === nodeNames.filter(n => n.startsWith('スタジオ')).length,
     nodeNames.filter(n => n.startsWith('スタジオ')).join(' | '));
  // 三脚は位置の目印として残し、カメラ本体とレンズは出さない（向こうに本物が立つ）
  ok('the tripod goes in, the camera body does not',
     nodeNames.some(n => n.startsWith('カメラ 三脚'))
     && raw.nodes.filter(n => n.camera !== undefined).length === 1, nodeNames.filter(n => n.includes('カメラ')).join(' | '));
  const gr = await open('glb-read', { width: 600, height: 400 });
  await gr.page.goto('http://localhost:8765/test/out/glb-reader.html');
  await gr.page.waitForFunction(() => window.__ready, null, {timeout:30000});
  const gb = await gr.page.evaluate(() => window.__read());
  ok('a loader reads it back with the textures inside',
     gb.meshes > 10 && gb.textured >= 1 && gb.skinned >= 1,
     JSON.stringify({meshes:gb.meshes, textured:gb.textured, skinned:gb.skinned}));
  // glTF はメートル
  ok('in metres', Math.abs(gb.size[0] - 10) < 0.05 && Math.abs(gb.size[1] - 8) < 0.05, gb.size.join(' x '));
  // **glTF のカメラは -Z 前方**なので、読み返した向きはアプリと同じになる
  ok('and the camera points exactly where the app points it', gb.cams.length === 1
     && Math.abs(gb.cams[0].dir[0] - want.dir[0]) < 0.02
     && Math.abs(gb.cams[0].dir[1] - want.dir[1]) < 0.02
     && Math.abs(gb.cams[0].dir[2] - want.dir[2]) < 0.02,
     `app ${want.dir.join(',')} -> file ${gb.cams[0]?.dir.join(',')}`);
  ok('at the same angle of view', Math.abs(gb.cams[0].fov - want.fov) < 0.1, `${want.fov} -> ${gb.cams[0]?.fov}`);
  ok('with the camera where it stands (metres)',
     Math.abs(gb.cams[0].pos[0] - 1.2) < 0.02 && Math.abs(gb.cams[0].pos[1] - 1.5) < 0.02
     && Math.abs(gb.cams[0].pos[2] - 3.0) < 0.02, JSON.stringify(gb.cams[0]?.pos));
  // 隠したものは現場に無いので入らない（目のマークで消す）
  await t.tab('list');
  await t.page.click('#items .itemrow[data-kind="box"] .eye');
  await t.page.waitForTimeout(500);
  const fewer = await t.page.evaluate(async () => (await window.__sp.glb()).meshes);
  ok('what is switched off does not go into the file', fewer < out.meshes, `${out.meshes} -> ${fewer}`);
  // ボタンから押しても、名前を付けて保存の道を通る
  await t.tab('share');
  await t.page.evaluate(() => { window.__saved = null;
    window.showSaveFilePicker = async o => { window.__saved = o.suggestedName; throw Object.assign(new Error('x'), {name:'AbortError'}); }; });
  await t.page.click('#glb'); await t.page.waitForTimeout(3000);
  ok('the button offers it as a .glb to save', /\.glb$/.test(await t.page.evaluate(() => window.__saved) || ''));
  ok('glb run clean', t.errors.length === 0 && gr.errors.length === 0, t.errors.concat(gr.errors).join(' | '));
  await gr.ctx.close(); await t.ctx.close();
}


// --- 33. ライト -----------------------------------------------------------------
const LIGHT_TILT_MAX = 90;                     // index.html と同じ値
// **照明のシミュレータではない。** 明るさは計算していないので、見るのは
// 「幾何がそのとおりに three のライトへ写っているか」と「図面が図面のままか」
{
  const t = await open('lights', { width: 1240, height: 820 });
  // ＋ のボタンは 1 つだけ（型は設定パネルで変える。寺村さんの指示）
  await t.page.click('#addfab'); await t.page.waitForTimeout(400);
  const btns = await t.page.$$eval('#gearlist button', b => b.map(x => x.dataset.add));
  ok('the add panel offers exactly one light button', btns.filter(k => k === 'light').length === 1, btns.join(','));
  await t.page.click('[data-add="light"]'); await t.page.waitForTimeout(500);
  const it0 = await t.page.evaluate(() => window.__sp.state().items.find(i => i.type === 'light'));
  ok('and it drops a spot on a stand', it0.kind === 'spot' && it0.mount === 'stand', JSON.stringify(it0));

  await t.page.click('#items .itemrow[data-kind="light"] > button.name'); await t.page.waitForTimeout(400);
  const panel = await t.page.textContent('#selbody');
  ok('the panel offers all five fixtures',
     ['スポット','LEDパネル','ソフトボックス','チューブ','中華提灯'].every(n => panel.includes(n)), panel.slice(0, 200));
  ok('and the three ways of carrying it',
     ['スタンド','ブーム','吊り'].every(n => panel.includes(n)));
  ok('it says plainly that this is not a simulation',
     panel.includes('ライトは簡易表示です') && panel.includes('set.a.light 3D'),
     panel.slice(panel.indexOf('ライトは簡易'), panel.indexOf('ライトは簡易') + 90));
  ok('and that the strength has no unit', panel.includes('強さは相対の目盛りです'));

  const lamp = () => t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.type === 'light');
    const e = sp.lights().get(it.id), l = e.lights[0];
    const aim = e.target ? e.target.position.clone().sub(l.position).normalize() : null;
    return { uuid: l.uuid, form: e.form, n: e.lights.length, omni: e.form !== 'cone',
             on: l.visible, i: l.intensity, shadow: !!l.castShadow,
             deg: l.angle ? +(l.angle * 2 * 180 / Math.PI).toFixed(1) : null, pen: l.penumbra,
             dist: +l.distance.toFixed(2), col: '#' + l.color.getHexString(),
             pos: l.position.toArray().map(v => +v.toFixed(2)),
             aim: aim ? aim.toArray().map(v => +v.toFixed(2)) : null };
  });
  const set = async (k, v) => { await t.page.evaluate(([k, v]) => {
    const sp = window.__sp; sp.setProp(sp.state().items.find(i => i.type === 'light'), k, v);
  }, [k, v]); await t.page.waitForTimeout(250); };

  // 型を変えると広がりとボケがその器材の既定に入れ替わり、three のライトまで届く
  await set('kind', 'soft');
  const soft = await lamp();
  ok('picking the softbox widens the beam and softens the edge',
     soft.deg === 118 && soft.pen === 1, JSON.stringify(soft));
  // **ソフトボックスは絞れる器材ではない。** 広がりとボケのつまみを出すと嘘になる
  const softPanel = await t.page.textContent('#selbody');
  ok('and a softbox is not offered a focus knob it does not have',
     !softPanel.includes('広がり') && !softPanel.includes('ボケ'), softPanel.slice(0, 140));
  await set('kind', 'spot');
  const spot = await lamp();
  ok('and going back to the spot narrows it again', spot.deg === 28 && spot.pen === 0.25, JSON.stringify(spot));
  // **作り直していないこと。** つまみを動かすたびに作り直すと、シャドウマップが
  // 毎回作り直しになり、本数が変わるたび全マテリアルのシェーダまで組み直される
  ok('the three light itself is never rebuilt, only re-valued', spot.uuid === soft.uuid);

  // チルト。ライトは真上から当てたいので ±90（カメラの ±45 とは別）
  await set('rot', 0); await set('pitch', -90);
  const down = await lamp();
  ok('a light can be pointed straight down', down.aim[1] < -0.98, JSON.stringify(down.aim));
  await set('pitch', -30);
  const angled = await lamp();
  ok('and the aim follows the dial exactly',
     Math.abs(angled.aim[1] + 0.5) < 0.02 && Math.abs(angled.aim[2] - Math.cos(Math.PI/6)) < 0.02,
     JSON.stringify(angled.aim));
  // 弧はカメラの ±45 に対してライトは ±90。作り直せるようにしてあるので、
  // 実際にどれだけ開いているかをジオメトリから読む
  // **チューブは線光源。コーンで出すとただのスポットになる**（寺村さんの指摘）
  for (const [kind, label] of [['tube','チューブ'], ['lantern','中華提灯']]){
    await set('kind', kind);
    const l = await lamp();
    ok(`a ${kind} lights all round instead of in a cone`, l.omni && l.deg === null, JSON.stringify(l));
    // **チューブは棒に沿って何点かに散らす。** 1 点だとどの向きから見ても
    // ただの点光源にしか見えなかった（寺村さんの指摘）
    if (kind === 'tube'){
      const line = await t.page.evaluate(() => {
        const sp = window.__sp, it = sp.state().items.find(i => i.type === 'light');
        const ps = sp.lights().get(it.id).lights.map(l => l.position.clone());
        const span = Math.max(...ps.map(a => Math.max(...ps.map(b => a.distanceTo(b)))));
        return { n: ps.length, span: +span.toFixed(2) };
      });
      ok('a tube is a line of emitters, not one point', line.n >= 3 && line.span > 0.7, JSON.stringify(line));
    }
    const pn = await t.page.textContent('#selbody');
    ok(`and offers no tilt, spread or softness for it`,
       !pn.includes('チルト') && !pn.includes('広がり') && !pn.includes('ボケ'), pn.slice(0, 160));
    if (kind === 'lantern') ok('a round lantern is not even offered a direction', !pn.includes('向き'));
    else ok('a tube still turns, because the bar itself has a direction', pn.includes('向き'));
  }
  // LED パネルも絞れない
  await set('kind', 'panel');
  const panelTxt = await t.page.textContent('#selbody');
  ok('an LED panel tilts but cannot be focused',
     panelTxt.includes('チルト') && !panelTxt.includes('広がり') && !panelTxt.includes('ボケ'), panelTxt.slice(0, 160));
  await set('kind', 'spot');
  const spotTxt = await t.page.textContent('#selbody');
  ok('only the spot gets the focus knobs', spotTxt.includes('広がり') && spotTxt.includes('ボケ'));

  // **器材の筐体は影を落とさない。** 光源は発光面に居るので、筐体が castShadow を
  // 持つと自分の光を自分で遮り、ソフトボックスが真っ黒な影を落としていた
  await set('kind', 'soft');
  const casts = await t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.type === 'light');
    const head = [], rig = [];
    sp.group(it.id).traverse(n => {
      if (!n.isMesh || n.userData.plan) return;
      // 頭は y が高いところに固まっている。支柱と脚は下から立ち上がる
      (n.getWorldPosition(new sp.THREE.Vector3()).y > it.y - 0.55 ? head : rig).push(!!n.castShadow);
    });
    const e = sp.lights().get(it.id), l = e.lights[0];
    const aim = e.target.position.clone().sub(l.position).normalize();
    const from = l.position.clone().sub(new sp.THREE.Vector3(it.x, it.y, it.z));
    return { head, rig, emit: +from.length().toFixed(2), fwd: +from.normalize().dot(aim).toFixed(2) };
  });
  ok('the fixture housing casts no shadow of its own light',
     casts.head.length > 0 && casts.head.every(v => !v), JSON.stringify(casts.head));
  ok('but the stand still does, which is the shadow that matters',
     casts.rig.some(v => v), JSON.stringify(casts.rig));
  ok('and the light sits out at the diffuser, not inside the box',
     casts.emit > 0.3 && casts.fwd > 0.99, JSON.stringify(casts));
  await set('kind', 'spot');

  const arc = await t.page.evaluate(() => {
    const sp = window.__sp, g = sp.tilt(); let a = null;
    g.traverse(n => { if (n.geometry?.type === 'TorusGeometry' && n.geometry.parameters.arc) a = +(n.geometry.parameters.arc*180/Math.PI).toFixed(0); });
    const it = sp.state().items.find(i => i.type === 'light');
    return { a, dy: +(g.position.y - it.y).toFixed(2) };
  });
  ok('the tilt arc opens right up for a light, where a camera only gets ±45',
     arc.a === LIGHT_TILT_MAX * 2, `${arc.a}° of swing`);
  ok('and it sits on the head of the light', Math.abs(arc.dy) < 0.01, String(arc.dy));
  // 小窓はフレームの最後に「カメラ＝絵」として描かれるので、描き終わったあとの
  // visible は小窓のぶんになる。画面に本当に出ているかは小窓を閉じてから見る
  await t.page.click('#pipbtn'); await t.page.waitForTimeout(500);
  ok('the tilt arc is offered for a light, not just a camera',
     await t.page.evaluate(() => window.__sp.tilt().visible));
  await t.page.click('#pipbtn'); await t.page.waitForTimeout(300);

  // 強さは相対。届く範囲はそこから出す
  await set('power', 10);
  const strong = await lamp();
  await set('power', 1);
  const weak = await lamp();
  ok('turning it up reaches further and hits harder',
     strong.dist > weak.dist && strong.i > weak.i, `${weak.dist}m/${weak.i} -> ${strong.dist}m/${strong.i}`);
  await set('power', 5);
  await set('color', '#bcd8ff');
  ok('the gel reaches the light', (await lamp()).col === '#bcd8ff');

  // 図面は図面のまま。**上面図に光を乗せると床が染まって寸法も線も読めない**。
  // 1 フレームの最後に描かれるのは小窓（＝カメラ＝絵）なので、描き終わったあとの
  // intensity や visible を読んでも、その view のものではない。**絵そのものを見る**
  await t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.type === 'light');
    it.x = 0; it.z = 0.6; it.rot = 0; it.pitch = -68; it.y = 2.6; it.power = 9; it.spread = 60;
    sp.setProp(it, 'color', '#ff5a2a');           // 床に出れば一目で分かる色
  });
  // **ゼラを替えて床の色が動くかで見る。** 出し入れで比べると、一緒に消える
  // 記号のくさびまで数えてしまう（くさびは固定の黄色なので、色を替えても動かない）
  const gelPix = async (view, prep) => {
    await t.page.click(`[data-view="${view}"]`); await t.page.waitForTimeout(500);
    if (prep) { await prep(); await t.page.waitForTimeout(500); }
    // どこに当たるかを狙って撮るより、**画面ぜんぶの平均**を見るほうが素直。
    // ゼラを替えて平均が動けば光が乗っている、動かなければ乗っていない
    const grab = () => t.page.evaluate(() => {
      const cv = document.querySelector('#gl'), b = cv.getBoundingClientRect();
      const c = document.createElement('canvas'); c.width = Math.round(b.width/4); c.height = Math.round(b.height/4);
      const x = c.getContext('2d'); x.drawImage(cv, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let r = 0, g = 0, bl = 0; for (let i = 0; i < d.length; i += 4){ r += d[i]; g += d[i+1]; bl += d[i+2]; }
      const n = d.length/4;
      return [r/n, g/n, bl/n].map(v => +v.toFixed(1));
    });
    const gel = async c => { await t.page.evaluate(col => {
      const sp = window.__sp; sp.setProp(sp.state().items.find(i => i.type === 'light'), 'color', col);
    }, c); await t.page.waitForTimeout(700); return grab(); };
    const warm = await gel('#ff5a2a'), cool = await gel('#2a6aff');
    return { warm, cool, d: Math.max(...warm.map((v, i) => Math.abs(v - cool[i]))) };
  };
  // 光の当たっているところを画面いっぱいに寄せる。引いたままだと、当たっている
  // 面積が小さすぎて画面の平均がほとんど動かない
  const persPix = await gelPix('pers', () => t.page.evaluate(() => {
    const sp = window.__sp, o = sp.orbit;
    o.theta = 0.1; o.phi = 0.75; o.radius = 3.4; o.target.set(0, 0.2, 1.65);
    sp.render();
  }));
  ok('the perspective is a picture: the gel really lands on the floor',
     persPix.d > 3, `${persPix.warm} vs ${persPix.cool}`);
  const planPix = await gelPix('plan');
  ok('the top view stays a drawing: no light is laid over it',
     planPix.d < 0.3, `${planPix.warm} vs ${planPix.cool}`);
  // 図面のほうは記号で向きを言う。どの view で何が出るかは状態から引く
  const symbol = await t.page.evaluate(() => {
    const sp = window.__sp, it = sp.state().items.find(i => i.type === 'light');
    const seen = {}; sp.group(it.id).traverse(n => { if (n.userData.planOnly) seen.n = (seen.n || 0) + 1; });
    return seen.n || 0;
  });
  ok('and it carries a beam symbol for the plan to show instead', symbol > 0, String(symbol));

  // 目のマークで消したら光も消える
  await t.page.click('#items .itemrow[data-kind="light"] .ico.eye'); await t.page.waitForTimeout(500);
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(400);
  ok('switching it off puts the light out', (await lamp()).i === 0);
  await t.page.click('#items .itemrow[data-kind="light"] .ico.eye'); await t.page.waitForTimeout(500);

  // 影は 4 灯まで。1 灯につきシーンをもう 1 度描くので、際限なく増やさない
  await t.page.evaluate(() => {
    const sp = window.__sp;
    for (let i = 0; i < 5; i++) sp.addItem('light');
    const lit = sp.state().items.filter(i => i.type === 'light');
    sp.setProp(lit[lit.length - 1], 'kind', 'lantern');
    sp.rebuild(); sp.render();
  });
  await t.page.click('[data-view="pers"]'); await t.page.waitForTimeout(900);
  const cast = await t.page.evaluate(() => {
    const sp = window.__sp;
    return [...sp.lights().values()].map(e => ({ omni: e.form !== 'cone', shadow: !!e.lights[0].castShadow }));
  });
  ok('six lights, but only four of them cast a shadow',
     cast.filter(c => c.shadow).length === 4, JSON.stringify(cast));
  ok('and the all-round one never does (its shadow would cost six passes)',
     cast.filter(c => c.omni).every(c => !c.shadow));

  // 共有リンクに全部乗る
  const before = await t.page.evaluate(() => window.__sp.state().items.filter(i => i.type === 'light'));
  const hash = await t.page.evaluate(() => location.hash);
  const t2 = await open('lights-link', { width: 900, height: 700 }, false, hash);
  const after = await t2.page.evaluate(() => window.__sp.state().items.filter(i => i.type === 'light'));
  ok('every light comes back through the share link', after.length === before.length, `${before.length} -> ${after.length}`);
  ok('with its fixture, mount, spread, softness, strength, tilt and gel intact',
     ['kind','mount','spread','soft','power','pitch','color'].every(k => after[0][k] === before[0][k]),
     JSON.stringify([before[0], after[0]]));
  await t2.ctx.close();

  // 古いリンクは y と rot しか持っていない。スポット・スタンド・水平で開けばよい
  const old = await t.page.evaluate(() => {
    const sp = window.__sp, st = sp.state();
    st.items = [{id:'L1', type:'light', x:0, z:1, rot:90, y:2}];
    sp.rebuild(); sp.render();
    const e = sp.lights().get('L1'), it = st.items[0];
    return { kind: sp.lightType(it).kind, deg: +(e.lights[0].angle*2*180/Math.PI).toFixed(0), has: !!e };
  });
  ok('a light from an old link still opens, as a spot', old.has && old.kind === 'spot' && old.deg === 28, JSON.stringify(old));

  // 置いたライトは GLB に入る（C4D で位置と向きがそのまま立つ）。
  // アプリ自身の地明かりは現場の道具ではないので入らない
  const glb = await t.page.evaluate(async () => {
    const sp = window.__sp;
    sp.state().items = [{id:'L1', type:'light', x:1, z:1, rot:45, y:2.4, pitch:-30, kind:'spot',
                         mount:'stand', spread:30, soft:0.3, power:6, color:'#ffc489'}];
    sp.rebuild();
    const { buf } = await sp.glb();
    const b = new Uint8Array(buf), len = new DataView(b.buffer).getUint32(12, true);
    const j = JSON.parse(new TextDecoder().decode(b.slice(20, 20 + len)));
    const L = j.extensions?.KHR_lights_punctual?.lights || [];
    return { n: L.length, types: L.map(l => l.type), ext: (j.extensionsUsed||[]).includes('KHR_lights_punctual') };
  });
  ok('the light goes into the exported GLB, so C4D gets it where it stands',
     glb.ext && glb.n === 1 && glb.types[0] === 'spot', JSON.stringify(glb));

  // 消したら three のライトも消える（シャドウマップを抱えたまま残らない）
  await t.page.evaluate(() => { const sp = window.__sp; sp.state().items = []; sp.rebuild(); });
  await t.page.waitForTimeout(300);
  const left = await t.page.evaluate(() => ({ size: window.__sp.lights().size,
    items: window.__sp.state().items.length, keys: [...window.__sp.lights().keys()] }));
  ok('deleting the item takes its light away too', left.size === 0, JSON.stringify(left));

  ok('lights run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 34. 写真ポーズ指定 --------------------------------------------------------
// MediaPipe をブラウザの中で動かして、写真の人の姿勢を 23 関節に写す。
// 写真はアプリ自身が描いた人物（座る・立つ）を使う。本物の写真を持ち込まなくても、
// 「膝が曲がっているか」で検出とポーズ写しが通っているかを見られる
{
  const t = await open('photopose', { width: 900, height: 900 });
  const p = t.page;
  await p.click('#items .itemrow[data-kind="person"] > button.name'); await p.waitForTimeout(300);
  await p.waitForFunction(() => !!window.__sp.poses() && !!document.querySelector('#selbody [data-photo]'), null, { timeout: 15000 });
  const btn = await p.$eval('#selbody .poses', el => {
    const last = el.lastElementChild;
    return { last: last?.dataset.photo !== undefined, label: last?.textContent.trim(), svg: !!last?.querySelector('svg.cam'), n: el.children.length };
  });
  ok('the pose list ends with the camera button 写真ポーズ指定', btn.last && btn.label === '写真ポーズ指定' && btn.svg && btn.n === 9, JSON.stringify(btn));
  const inp = await p.$eval('#photofile', i => ({ accept: i.getAttribute('accept'), hidden: i.hidden }));
  ok('the photo input takes image/* (a MIME, so iOS shows the camera and the library)', inp.accept === 'image/*' && inp.hidden, JSON.stringify(inp));

  // 人物をファインダーいっぱいに描いて、それを写真として読ませる
  const shoot = async (posture) => {
    await p.evaluate((posture) => {
      const sp = window.__sp, st = sp.state();
      // 斜め 40 度から撮る。真正面だと太ももがカメラを向いて、写真の上に膝の曲がりが出ない
      const it = st.items.find(i => i.type === 'person'); it.rot = 0; sp.setProp(it, 'rot', 40); sp.setProp(it, 'posture', posture);
      const cam = st.items.find(i => i.type === 'camera'); cam.x = 0; cam.z = 3.2; cam.y = 1.0; cam.pitch = 0; sp.setProp(cam, 'focal', 35);
      document.querySelector('[data-view="cam"]').click();
    }, posture);
    await p.waitForFunction(() => { const sp = window.__sp; const it = sp.state().items.find(i => i.type === 'person'); let s = false; sp.group(it.id)?.traverse(n => { if (n.isSkinnedMesh) s = true; }); return s; }, null, { timeout: 20000 });
    await p.waitForTimeout(1200);
    const b64 = (await p.locator('#gl').screenshot()).toString('base64');
    return p.evaluate(async (b64) => {
      const sp = window.__sp, it = sp.state().items.find(i => i.type === 'person');
      const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
      const okv = await sp.photoPose(it, new File([blob], 'p.png', { type: 'image/png' }));
      const J = sp.poses().joints, g = n => it.photo?.[J.indexOf(n)];
      const knee = s => { const h = g(s + 'UpLeg'), k = g(s + 'Leg'), a = g(s + 'Foot');
        const u = [h[0]-k[0], h[1]-k[1], h[2]-k[2]], w = [a[0]-k[0], a[1]-k[1], a[2]-k[2]];
        return Math.acos((u[0]*w[0]+u[1]*w[1]+u[2]*w[2]) / (Math.hypot(...u) * Math.hypot(...w))) * 180 / Math.PI; };
      return { ok: okv, posture: it.posture, n: it.photo?.length, kneeL: knee('Left'), kneeR: knee('Right'),
               fin: it.photo?.every(q => q.length === 3 && q.every(Number.isFinite)) };
    }, b64);
  };
  const sit = await shoot('sit-chair');
  ok('a rendered sitting figure is detected and comes back as 23 joints plus the face direction', sit.ok && sit.posture === 'photo' && sit.n === 24 && sit.fin, JSON.stringify(sit));
  ok('and its knees are bent', sit.kneeL < 130 && sit.kneeR < 130, `${sit.kneeL?.toFixed(0)} / ${sit.kneeR?.toFixed(0)} deg`);
  const stand = await shoot('stand-2');
  ok('a standing figure comes back with straighter knees', stand.ok && stand.kneeL > 135 && stand.kneeR > 135, `${stand.kneeL?.toFixed(0)} / ${stand.kneeR?.toFixed(0)} deg`);
  await p.waitForTimeout(400);
  const ui = await p.$eval('#selbody', el => ({ on: el.querySelector('[data-photo]')?.classList.contains('on'), hint: el.textContent.includes('写真の奥行きは推定です') }));
  ok('the camera button lights up and the depth caveat shows', ui.on && ui.hint, JSON.stringify(ui));

  // 共有リンクに 23 点が乗って、相手の画面でも同じポーズになる
  await p.waitForTimeout(500);
  const hash = await p.evaluate(() => location.hash);
  const t2 = await open('photopose-link', { width: 900, height: 900 }, false, hash);
  const back = await t2.page.evaluate(() => { const it = window.__sp.state().items.find(i => i.type === 'person'); return { posture: it.posture, n: it.photo?.length }; });
  ok('the photo pose survives the share link', back.posture === 'photo' && back.n === 24, JSON.stringify(back));
  await t2.ctx.close();
  // 座標の無い photo は素の姿勢に戻す
  const broken = await t.page.evaluate(async () => {
    const st = JSON.parse(JSON.stringify(window.__sp.state())); st.cuts = undefined;
    const it = st.items.find(i => i.type === 'person'); it.posture = 'photo'; it.photo = [[1, 2]];
    const bytes = new TextEncoder().encode(JSON.stringify(st));
    let b = ''; for (const x of bytes) b += String.fromCharCode(x);
    return '#s=j' + btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
  const t3 = await open('photopose-broken', { width: 900, height: 900 }, false, broken);
  const fixed = await t3.page.evaluate(() => { const it = window.__sp.state().items.find(i => i.type === 'person'); return { posture: it.posture, photo: it.photo }; });
  ok('a link whose photo pose lost its coordinates falls back to the rest pose', fixed.posture === null && fixed.photo === undefined, JSON.stringify(fixed));
  ok('broken link opens clean', t3.errors.length === 0, t3.errors.join(' | '));
  await t3.ctx.close();
  // 別のポーズを選んだら写真の座標は捨てる（リンクを重くしない）
  await p.click('#selbody [data-pose="sit-chair"]'); await p.waitForTimeout(400);
  const after = await p.evaluate(() => { const it = window.__sp.state().items.find(i => i.type === 'person'); return { posture: it.posture, photo: it.photo }; });
  ok('picking a preset pose drops the photo coordinates', after.posture === 'sit-chair' && after.photo === undefined, JSON.stringify(after));
  ok('photo pose runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 35. 環境光 --------------------------------------------------------------
// 0〜100 の 1 本のつまみ。ライトを置くと自動で 25、無ければ 50。手で動かした値は
// ライトの有無が切り替わるまで残る。0 で真っ暗（絵だけ。図面は平らなまま）
{
  const t = await open('ambient', { width: 1100, height: 800 });
  const p = t.page;
  await p.click('#items .itemrow[data-kind="studio"] > button.name'); await p.waitForTimeout(300);
  const v0 = await p.$eval('#samb', i => +i.value);
  ok('the studio panel has the ambient slider at 50 with no lights', v0 === 50, String(v0));
  await p.evaluate(() => window.__sp.addItem('light')); await p.waitForTimeout(400);
  ok('placing a light drops it to 25 by itself', await p.evaluate(() => window.__sp.ambient()) === 25);
  await p.evaluate(() => { window.__sp.setAmbient(10); document.querySelector('[data-view="pers"]').click(); window.__sp.render(); }); await p.waitForTimeout(400);
  const dim = await p.evaluate(() => ({ a: window.__sp.ambient(), hemi: window.__sp.hemi.intensity, sun: window.__sp.sun.intensity }));
  ok('a manual 10 dims the picture below the lit level', dim.a === 10 && dim.hemi < 0.42 && dim.hemi > 0 && dim.sun < 0.30, JSON.stringify(dim));
  await p.evaluate(() => window.__sp.addItem('light')); await p.waitForTimeout(400);
  ok('a second light does not touch the manual value', await p.evaluate(() => window.__sp.ambient()) === 10);
  await p.evaluate(() => { window.__sp.setAmbient(0); window.__sp.render(); }); await p.waitForTimeout(400);
  const dark = await p.evaluate(() => ({ hemi: window.__sp.hemi.intensity, sun: window.__sp.sun.intensity }));
  ok('0 is pitch dark in the picture', dark.hemi === 0 && dark.sun === 0, JSON.stringify(dark));
  // 図面は平らなまま（小窓を閉じてから上面を描く。小窓が最後に描くと絵の値が残る）
  await p.click('#pipbtn'); await p.evaluate(() => { document.querySelector('[data-view="plan"]').click(); window.__sp.render(); }); await p.waitForTimeout(400);
  const plan = await p.evaluate(() => ({ hemi: window.__sp.hemi.intensity, sun: window.__sp.sun.intensity }));
  ok('the plan view keeps its flat light regardless', plan.hemi === 1.1 && plan.sun === 1.4, JSON.stringify(plan));
  // ライトを全部消したら自動（50）に戻る。手で入れた 0 は捨てる
  await p.evaluate(() => { const sp = window.__sp; sp.state().items = sp.state().items.filter(i => i.type !== 'light'); sp.rebuild(); });
  ok('removing every light returns to the automatic 50', await p.evaluate(() => window.__sp.ambient()) === 50);
  // 共有リンクに乗る
  await p.evaluate(() => window.__sp.setAmbient(33)); await p.click('#items .itemrow[data-kind="studio"] > button.name'); await p.waitForTimeout(300);
  await p.$eval('#samb', i => { i.value = 33; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); }); await p.waitForTimeout(600);
  const hash = await p.evaluate(() => location.hash);
  const t2 = await open('ambient-link', { width: 1100, height: 800 }, false, hash);
  ok('the ambient level survives the share link', await t2.page.evaluate(() => window.__sp.ambient()) === 33);
  await t2.ctx.close();
  ok('ambient runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 36. 人物の足元の円は選んだときだけ ------------------------------------------
{
  const t = await open('footdisc', { width: 1100, height: 800 });
  const p = t.page;
  const disc = () => p.evaluate(() => { const sp = window.__sp; const it = sp.state().items.find(i => i.type === 'person');
    let v = null; sp.group(it.id).traverse(n => { if (n.userData.selOnly) v = n.visible; }); return v; });
  // 小窓は最後に描く（cam）ので、読む前に閉じておく
  await p.click('#pipbtn');
  await p.evaluate(() => { window.__sp.select(null); document.querySelector('[data-view="pers"]').click(); window.__sp.render(); }); await p.waitForTimeout(300);
  ok('the foot disc stays hidden while the person is not selected', await disc() === false, String(await disc()));
  await p.evaluate(() => { const sp = window.__sp; sp.select(sp.state().items.find(i => i.type === 'person').id); sp.render(); }); await p.waitForTimeout(300);
  ok('and shows once the person is selected', await disc() === true, String(await disc()));
  await p.evaluate(() => { document.querySelector('[data-view="cam"]').click(); window.__sp.render(); }); await p.waitForTimeout(300);
  ok('never in the finder', await disc() === false, String(await disc()));
  ok('foot disc runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 37. 英語表示 ---------------------------------------------------------------
// 設定は無い。?eng（または ?lang=en）で英語、無ければブラウザの言語で決まる。
// 画面に出た文字を辞書で差し替える方式なので、「日本語が 1 つも残っていない」を
// パネル・一覧・追加の一覧・カット・共有・用紙のバーで見る
{
  const JP = /[぀-ヿ一-鿿：、。（）「」・〜]/;
  const jpIn = (p, sel) => p.evaluate(({ sel, JP }) => {
    const re = new RegExp(JP), out = [];
    for (const root of document.querySelectorAll(sel)){
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = w.currentNode; n; n = w.nextNode()){
        if (n.nodeType === 3){ if (re.test(n.nodeValue)) out.push(n.nodeValue.trim()); }
        else for (const a of ['title', 'aria-label', 'placeholder']){ const v = n.getAttribute(a); if (v && re.test(v)) out.push(a + '=' + v); }
      }
    }
    return out;
  }, { sel, JP: JP.source });
  const t = await open('english', { width: 1500, height: 950 }, false, '?eng');
  const p = t.page;
  ok('?eng switches the page to English', await p.evaluate(() => document.documentElement.lang) === 'en');
  const tabs = await p.$$eval('#tabs button', b => b.map(x => x.textContent.trim()));
  ok('tabs are English', tabs.join('|') === 'Objects|Shots|Save / Share', tabs.join('|'));
  const views = await p.$$eval('#viewbtns [data-view]', b => b.map(x => x.textContent.trim()));
  ok('view buttons are English', views.join('|') === 'Top|Side|Front|3D|Finder', views.join('|'));
  const rows = await p.$$eval('#items .itemrow > button.name', b => b.map(x => x.textContent.trim()));
  ok('list rows are English (Studio / Man 1 / Camera)', rows.join('|') === 'Studio|Man 1|Camera', rows.join('|'));
  ok('the top-right readout is English', /^Studio 10 × 8 × H 4\.5 m/.test(await p.$eval('#info', e => e.textContent.trim())), await p.$eval('#info', e => e.textContent.trim()));
  // 人物・カメラ・ライト・背景布の設定パネルと、追加の一覧
  await p.evaluate(() => { const sp = window.__sp; sp.select(sp.state().items.find(i => i.type === 'person').id, true); }); await p.waitForTimeout(300);
  const poses = await p.$$eval('#selbody .poses button small', b => b.map(x => x.textContent.trim()));
  ok('pose names are English', poses.includes('Sit on floor') && poses.includes('Lie on back') && poses[poses.length - 1] === 'Pose from photo', poses.join('|'));
  let left = await jpIn(p, '#panel');
  ok('no Japanese left in the person panel', left.length === 0, left.slice(0, 5).join(' | '));
  await p.click('#addfab'); await p.waitForTimeout(300);
  left = await jpIn(p, '#addpop');
  ok('no Japanese left in the add list', left.length === 0, left.slice(0, 5).join(' | '));
  ok('add list title is English', await p.$eval('#addpop .pophead strong, #addpop h1, #addpop .pophead', e => e.textContent.trim()) .then(v => /Add object/.test(v)));
  await p.click('[data-add="light"]'); await p.waitForTimeout(400);
  const hint = await p.$$eval('#selbody .hint', h => h.map(x => x.textContent).join(' '));
  ok('the light panel keeps the set.a.light note, in English', /Lights are schematic.*set\.a\.light 3D/.test(hint), hint.slice(0, 120));
  for (const k of ['chroma', 'mirror', 'koma', 'car', 'chair', 'table', 'box', 'ruler', 'camera']){
    await t.add(`[data-add="${k}"]`); await p.keyboard.press('Escape');   // 定規のタップ待ちは抜ける
    left = await jpIn(p, '#panel');
    ok(`no Japanese left with ${k} selected`, left.length === 0, left.slice(0, 5).join(' | '));
  }
  await p.evaluate(() => window.__sp.select(null)); await p.waitForTimeout(200);
  left = await jpIn(p, '#panel');
  ok('no Japanese left in the studio panel', left.length === 0, left.slice(0, 5).join(' | '));
  const dims = await p.$$eval('#labels span', s => s.map(x => x.textContent.trim()));
  ok('dimension labels are English', dims.length > 0 && dims.every(d => !JP.test(d)) && dims.some(d => /^Width 10 m$/.test(d)), dims.join('|'));
  await t.tab('cut');
  ok('the shot row reads "Shot 1"', await p.$eval('#cuts .itemrow > button.name span', e => e.textContent.trim()) === 'Shot 1', await p.$eval('#cuts .itemrow > button.name', e => e.textContent.trim()));
  left = await jpIn(p, '#panel'); ok('no Japanese left in the shots tab', left.length === 0, left.slice(0, 5).join(' | '));
  await t.tab('share');
  left = await jpIn(p, '#panel'); ok('no Japanese left in the share tab', left.length === 0, left.slice(0, 5).join(' | '));
  await p.click('#qrbtn'); await p.waitForTimeout(500);
  ok('the QR dialog title is English', await p.$eval('#qrtitle', e => e.textContent.trim()) === 'QR code for Shot 1', await p.$eval('#qrtitle', e => e.textContent.trim()));
  left = await jpIn(p, '#qrdlg'); ok('no Japanese left in the QR dialog', left.length === 0, left.slice(0, 5).join(' | '));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // トーストは後から出る文字。observer が拾う
  await p.evaluate(() => window.__sp.toast('リンクをコピーしました')); await p.waitForTimeout(100);
  ok('a toast written in Japanese shows up in English', await p.$eval('#toast', e => e.textContent) === 'Link copied', await p.$eval('#toast', e => e.textContent));
  ok('tr() handles numbers and names', await p.evaluate(() => [window.__sp.tr('カメラ 2 奥壁まで 6.40 m'), window.__sp.tr('x.glb は大きすぎます（120MB まで）')].join('|')) === 'Camera 2: 6.40 m to back wall|x.glb is too large (max 120 MB)');
  // 用紙のバーと用紙そのもの
  await p.click('#makepdf'); await p.waitForTimeout(4000);
  left = await jpIn(p, '.pmbar, #papers'); ok('no Japanese left on the PDF sheet', left.length === 0, left.slice(0, 5).join(' | '));
  const paper = await p.$eval('#papers', e => e.textContent);
  ok('the sheet uses English headings', /Studio \/ Subjects/.test(paper) && /Printed /.test(paper) && /Shot 1/.test(paper));
  await p.click('#paperclose'); await p.waitForTimeout(300);
  ok('english mode runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  // ブラウザの言語で決まる。日本語のブラウザは今までどおり
  const en = await open('english-auto', { width: 1200, height: 800 }, false, '', { locale: 'en-US' });
  ok('an English browser gets English without ?eng', await en.page.$eval('[data-tab="list"]', e => e.textContent.trim()) === 'Objects');
  await en.ctx.close();
  const ja = await open('japanese-auto', { width: 1200, height: 800 }, false, '', { locale: 'ja-JP' });
  ok('a Japanese browser stays Japanese', await ja.page.$eval('[data-tab="list"]', e => e.textContent.trim()) === 'オブジェクト' && await ja.page.evaluate(() => document.documentElement.lang) === 'ja');
  await ja.page.goto('http://localhost:8765/?lang=en'); await ja.page.waitForTimeout(1200);
  ok('?lang=en forces English on a Japanese browser', await ja.page.$eval('[data-tab="list"]', e => e.textContent.trim()) === 'Objects');
  await ja.ctx.close();
}

// --- 38. 小窓はカメラの比率そのもの ---------------------------------------------
// 黒い余白で埋めずに箱のほうを縦横比に合わせる（寺村さんの指示）。9:16 なら縦長になる。
// 別ウィンドウのファインダーだけは余白を付けてよい（そちらは触っていない）
{
  const t = await open('pip-aspect', { width: 1300, height: 900 });
  const P = t.page;
  const bodyAr = async () => { const b = await P.locator('#pip .body').boundingBox(); return b.width / b.height; };
  const setAspect = async a => { await P.evaluate(a => { const sp = window.__sp; sp.setProp(sp.state().items.find(i => i.type === 'camera'), 'aspect', a); sp.render(); }, a); await P.waitForTimeout(400); };
  ok('the docked window opens at the camera aspect (16:9)', Math.abs(await bodyAr() - 16/9) < 0.012, String(await bodyAr()));
  await setAspect('9:16');
  ok('9:16 makes it a portrait box, no black bars', Math.abs(await bodyAr() - 9/16) < 0.012, String(await bodyAr()));
  const inside = await P.evaluate(() => { const r = document.getElementById('pip').getBoundingClientRect(), v = document.getElementById('view').getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom + 1 && r.right <= v.right + 1; });
  ok('and it still fits inside the view', inside);
  await setAspect('4:3');
  ok('4:3 follows too', Math.abs(await bodyAr() - 4/3) < 0.012, String(await bodyAr()));
  // つまみで引いても比率は変わらない
  const g = await P.locator('#pip .grip').boundingBox();
  const w0 = (await P.locator('#pip').boundingBox()).width;
  await P.mouse.move(g.x + g.width/2, g.y + g.height/2); await P.mouse.down();
  await P.mouse.move(g.x + g.width/2 - 60, g.y + g.height/2 - 10); await P.mouse.move(g.x + g.width/2 - 80, g.y + g.height/2 - 20); await P.mouse.up(); await P.waitForTimeout(300);
  const w1 = (await P.locator('#pip').boundingBox()).width;
  ok('resizing keeps the aspect', Math.abs(await bodyAr() - 4/3) < 0.012 && w1 < w0 - 40, `${w0} -> ${w1}, ar ${await bodyAr()}`);
  await setAspect('9:16'); await P.screenshot({ path: `${OUT}/pip-916.png` });
  ok('pip aspect runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 39. 角のつまみ（床鏡・箱・テーブル）、丸テーブル、小窓の canvas、背景布の R ------------
{
  const t = await open('corner-handles', { width: 1300, height: 900 });
  const P = t.page;
  const handles = () => P.evaluate(() => window.__sp.handles().children.filter(k => k.isMesh).map(m => m.position.toArray()));
  const item = ty => P.evaluate(ty => ({...window.__sp.state().items.find(i => i.type === ty)}), ty);
  const screenOf = i => P.evaluate(i => { const s = window.__sp; const v = s.handles().children.filter(k => k.isMesh)[i].position.clone().project(s.camera());
    const r = document.getElementById('view').getBoundingClientRect(); return {x: r.left + (v.x+1)/2*r.width, y: r.top + (1-v.y)/2*r.height}; }, i);
  const drag = async (from, dx, dy) => { await P.mouse.move(from.x, from.y); await P.mouse.down(); await P.mouse.move(from.x + dx/2, from.y + dy/2); await P.mouse.move(from.x + dx, from.y + dy); await P.mouse.up(); await P.waitForTimeout(300); };
  ok('the 3D view button is called 3D', await P.$eval('[data-view="pers"]', e => e.textContent.trim()) === '3D');
  // 床鏡は 4 角
  await t.add('[data-add="mirror"]');
  let m = await item('mirror'), hs = await handles();
  ok('the floor mirror has four corner handles', m.kind === 'floor' && hs.length === 4 && hs.every(([x, , z]) => Math.abs(Math.abs(x - m.x) - m.w/2) < 0.01 && Math.abs(Math.abs(z - m.z) - m.h/2) < 0.01), JSON.stringify({kind:m.kind, n:hs.length}));
  await P.evaluate(() => { const sp = window.__sp; sp.setProp(sp.state().items.find(i => i.type === 'mirror'), 'hidden', true); });
  // 箱: 天面の 4 角と真ん中（上面図では 4 つだけ）
  await t.add('[data-add="box"]');
  await P.evaluate(() => { const sp = window.__sp, b = sp.state().items.find(i => i.type === 'box'); sp.setProp(b, 'h', 1.2); sp.setProp(b, 'x', 2); sp.setProp(b, 'z', 0); sp.render(); }); await P.waitForTimeout(300);
  let b = await item('box'); hs = await handles();
  ok('a box has four top corners and a height handle', hs.length === 5 && hs.filter(([, y]) => Math.abs(y - 1.2) < 0.01).length === 5, JSON.stringify(hs));
  await P.click('[data-view="plan"]'); await P.waitForTimeout(300);
  ok('in the top view the height handle is left out', (await handles()).length === 4);
  await P.click('[data-view="pers"]'); await P.waitForTimeout(400);
  // 角を引くと幅と奥行が変わり、向かいの角は残る
  const farIx = await P.evaluate(() => { const s = window.__sp, hs = s.handles().children.filter(k => k.isMesh); let best = 0, bd = -1; hs.forEach((h, i) => { const d = h.position.distanceTo(s.camera().position); if (d > bd){ bd = d; best = i; } }); return best; });
  const nearIx = await P.evaluate(() => { const s = window.__sp, hs = s.handles().children.filter(k => k.isMesh); let best = 0, bd = 1e9; hs.forEach((h, i) => { if (Math.abs(h.position.x - 2) < 0.01 && Math.abs(h.position.z) < 0.01) return; const d = h.position.distanceTo(s.camera().position); if (d < bd){ bd = d; best = i; } }); return best; });
  const far0 = hs[farIx];
  await drag(await screenOf(nearIx), 70, 50);
  const b1 = await item('box'); const hs1 = await handles();
  ok('dragging a top corner changes width and depth', (b1.w !== b.w || b1.d !== b.d) && b1.h === b.h, JSON.stringify({before:[b.w, b.d], after:[b1.w, b1.d]}));
  ok('and the opposite corner stays where it was', hs1.some(([x, , z]) => Math.abs(x - far0[0]) < 0.08 && Math.abs(z - far0[2]) < 0.08), JSON.stringify({far0, hs1}));
  // 真ん中のつまみで高さ
  const hIx = await P.evaluate(() => { const s = window.__sp, hs = s.handles().children.filter(k => k.isMesh); const it = s.state().items.find(i => i.type === 'box'); return hs.findIndex(h => Math.abs(h.position.x - it.x) < 0.01 && Math.abs(h.position.z - it.z) < 0.01); });
  await drag(await screenOf(hIx), 0, -60);
  const b2 = await item('box');
  ok('the centre handle raises the box', b2.h > b1.h + 0.1 && b2.w === b1.w && b2.d === b1.d, JSON.stringify({h0:b1.h, h1:b2.h}));
  await P.evaluate(() => { const sp = window.__sp; sp.setProp(sp.state().items.find(i => i.type === 'box'), 'hidden', true); });
  // テーブル: 角／丸
  await t.add('[data-add="table"]');
  ok('the table panel offers square and round', await P.$$eval('#selbody [data-set="shape"]', b => b.map(x => x.textContent.trim()).join('/')) === '角テーブル/丸テーブル');
  await P.click('#selbody [data-set="shape"][data-val="round"]'); await P.waitForTimeout(400);
  let tb = await item('table');
  ok('round makes depth follow the diameter', tb.shape === 'round' && tb.d === tb.w, JSON.stringify({w:tb.w, d:tb.d}));
  ok('and the panel shows one diameter slider', await P.$$eval('#selbody .f span', s => s.map(x => x.textContent)).then(l => l.includes('直径') && !l.includes('奥行')));
  ok('the round table is built from a round top', await P.evaluate(() => { const s = window.__sp, it = s.state().items.find(i => i.type === 'table'); let n = 0; s.group(it.id).traverse(o => { if (o.geometry?.type === 'CylinderGeometry' && o.geometry.parameters.radiusTop > 0.6) n++; }); return n; }) === 1);
  hs = await handles();
  ok('a round table has four rim handles and a height handle', hs.length === 5, String(hs.length));
  const rimIx = await P.evaluate(() => { const s = window.__sp, hs = s.handles().children.filter(k => k.isMesh), it = s.state().items.find(i => i.type === 'table'); return hs.findIndex(h => h.position.x - it.x > 0.3); });
  await drag(await screenOf(rimIx), 60, 0);
  const tb1 = await item('table');
  ok('pulling the rim changes the diameter, depth follows', tb1.w > tb.w + 0.1 && tb1.d === tb1.w, JSON.stringify({w:tb1.w, d:tb1.d}));
  const link = await P.evaluate(() => location.hash);
  await P.goto('http://localhost:8765/' + link); await P.waitForTimeout(1200);
  ok('the shape survives the share link', (await item('table')).shape === 'round');
  // 小窓は自分の canvas に絵を持つ（ビューボタンが透けない）
  const cv = await P.evaluate(() => { const c = document.getElementById('pipcv'), b = document.querySelector('#pip .body').getBoundingClientRect(), r = window.__sp.renderer.getPixelRatio();
    const px = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
    return {w:c.width, h:c.height, bw:Math.round(b.width*r), bh:Math.round(b.height*r), alpha:px[3], sum:px[0]+px[1]+px[2], z: getComputedStyle(document.getElementById('pip')).zIndex, zb: getComputedStyle(document.getElementById('viewbtns')).zIndex}; });
  ok('the camera window draws into its own canvas', Math.abs(cv.w - cv.bw) <= 2 && Math.abs(cv.h - cv.bh) <= 2 && cv.alpha === 255 && cv.sum > 0, JSON.stringify(cv));
  ok('and that canvas sits above the view buttons', +cv.z > +cv.zb, JSON.stringify(cv));
  // 背景布の R は内側が表（法線が内向き）。外向きだと影の normalBias で自分の影に沈む
  await t.add('[data-add="chroma"]');
  const inward = await P.evaluate(() => { const s = window.__sp, it = s.state().items.find(i => i.type === 'chroma'); let r = null;
    s.group(it.id).traverse(o => { if (o.geometry?.type === 'CylinderGeometry'){ const n = o.geometry.attributes.normal, p = o.geometry.attributes.position; let dot = 0; for (let i = 0; i < n.count; i++) dot += n.getX(i)*p.getX(i) + n.getZ(i)*p.getZ(i); r = dot; } });
    return r; });
  ok('the cove faces inward', inward !== null && inward < 0, String(inward));
  ok('corner handles run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 40. 寸法表示は最下部、カメラの高さつまみ、椅子・箱に座る ----------------------------
{
  const t = await open('sit', { width: 1300, height: 900 });
  const P = t.page;
  await P.waitForFunction(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'person'); let k = false; s.group(it.id)?.traverse(n => { if (n.isSkinnedMesh) k = true; }); return k; }, null, { timeout: 20000 });
  const h2s = () => P.$$eval('#selbody h2', h => h.map(x => x.textContent.trim()));
  const person = () => P.evaluate(() => { const s = window.__sp; const p = s.state().items.find(i => i.type === 'person');
    return {posture: p.posture || null, sitting: s.isSitting(p), seatY: s.group(p.id).userData.seatY ?? null, y: +s.group(p.id).position.y.toFixed(3), stand: +s.standHeight(p).toFixed(3)}; });
  await P.evaluate(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'person').id, true); }); await P.waitForTimeout(600);
  let h = await h2s();
  ok('the person panel ends with 寸法表示 (below the poses)', h[h.length - 1] === '寸法表示' && h.indexOf('ポーズ') < h.length - 1, h.join('/'));
  ok('the camera-distance switch is called カメラ距離', (await P.$$eval('#selbody [data-dim]', b => b.map(x => x.textContent.trim()))).join('/') === '身長/カメラ距離');
  // 椅子を人の下に
  await t.add('[data-add="chair"]');
  await P.evaluate(() => { const s = window.__sp; const p = s.state().items.find(i => i.type === 'person'), c = s.state().items.find(i => i.type === 'chair'); s.setProp(c, 'x', p.x); s.setProp(c, 'z', p.z); }); await P.waitForTimeout(300);
  let q = await person();
  ok('a standing person stands on the seat', !q.sitting && q.y === 0.42 && q.stand === 0.42, JSON.stringify(q));
  await P.evaluate(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'person').id, true); }); await P.waitForTimeout(500);
  await P.click('[data-pose="sit-chair"]'); await P.waitForTimeout(900);
  q = await person();
  ok('the chair pose is recognised as sitting (thigh angle)', q.sitting === true, JSON.stringify(q));
  ok('and the seat bottom is measured below the hip', q.seatY > 0.25 && q.seatY < 0.5, String(q.seatY));
  ok('so the person snaps down until the seat bottom rests on the seat', Math.abs(q.y - (0.42 - q.seatY)) < 0.002, JSON.stringify(q));
  await P.evaluate(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'chair'), 'seatH', 0.7); }); await P.waitForTimeout(400);
  const q2 = await person();
  ok('raising the seat lifts the seated person with it', Math.abs(q2.y - (0.7 - q.seatY)) < 0.002, JSON.stringify(q2));
  await P.evaluate(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'person').id, true); }); await P.waitForTimeout(400);
  await P.click('[data-pose="sit-floor"]'); await P.waitForTimeout(900);
  q = await person();
  ok('sitting on the floor is not a hanging-legs pose: it just rests on top', !q.sitting && q.y === 0.7, JSON.stringify(q));
  await P.click('[data-pose="lie-up"]'); await P.waitForTimeout(900);
  q = await person();
  ok('nor is lying', !q.sitting && q.y === 0.7, JSON.stringify(q));
  // 写真ポーズも同じ式（椅子のポーズの関節をそのまま写真として持たせる）
  await P.evaluate(() => { const s = window.__sp; const p = s.state().items.find(i => i.type === 'person'); p.photo = s.poses().poses.find(x => x.id === 'sit-chair').p.map(r => r.slice()); s.setProp(p, 'posture', 'photo'); }); await P.waitForTimeout(900);
  q = await person();
  ok('a photo pose with hanging legs sits too', q.sitting === true && q.seatY > 0.25 && Math.abs(q.y - (0.7 - q.seatY)) < 0.002, JSON.stringify(q));
  // 椅子を外へ動かせば床に戻る
  await P.evaluate(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'chair'), 'x', 3); }); await P.waitForTimeout(400);
  q = await person();
  ok('with no seat underneath the person is back on the floor', q.y === 0 && q.stand === 0, JSON.stringify(q));
  // カメラの高さのつまみ
  await P.evaluate(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'camera').id); }); await P.waitForTimeout(300);
  h = await h2s();
  ok('the camera panel ends with 寸法表示 too', h[h.length - 1] === '寸法表示', h.join('/'));
  const cam = await P.evaluate(() => ({...window.__sp.state().items.find(i => i.type === 'camera')}));
  let hs = await P.evaluate(() => window.__sp.handles().children.filter(k => k.isMesh).map(m => m.position.toArray()));
  ok('the camera has one handle just above its head', hs.length === 1 && Math.abs(hs[0][1] - (cam.y + 0.14)) < 0.01, JSON.stringify(hs));
  const sc = await P.evaluate(() => { const s = window.__sp; const v = s.handles().children.filter(k => k.isMesh)[0].position.clone().project(s.camera()); const r = document.getElementById('view').getBoundingClientRect(); return {x: r.left + (v.x+1)/2*r.width, y: r.top + (1-v.y)/2*r.height}; });
  await P.mouse.move(sc.x, sc.y); await P.mouse.down(); await P.mouse.move(sc.x, sc.y - 40); await P.mouse.move(sc.x, sc.y - 80); await P.mouse.up(); await P.waitForTimeout(300);
  const cam2 = await P.evaluate(() => ({...window.__sp.state().items.find(i => i.type === 'camera')}));
  ok('dragging it up raises the camera', cam2.y > cam.y + 0.3 && cam2.x === cam.x && cam2.z === cam.z, `${cam.y} -> ${cam2.y}`);
  ok('and the finder follows', Math.abs(await P.evaluate(() => { document.querySelector('[data-view="cam"]').click(); return window.__sp.camera().position.y; }) - cam2.y) < 0.001);
  await P.click('[data-view="plan"]'); await P.waitForTimeout(300);
  hs = await P.evaluate(() => window.__sp.handles().children.filter(k => k.isMesh).length);
  ok('the height handle stays out of the top view', hs === 0);
  ok('sit run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 41. 画面比率の手動設定 -------------------------------------------------------
{
  const t = await open('aspect-custom', { width: 1300, height: 900 });
  const P = t.page;
  await P.evaluate(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'camera').id, true); }); await P.waitForTimeout(400);
  const labels = await P.$$eval('#selbody [data-set="aspect"]', b => b.map(x => x.textContent.trim()));
  ok('the aspect buttons end with 手動', labels[labels.length - 1] === '手動' && labels.includes('16:9'), labels.join('/'));
  ok('no number fields until 手動 is chosen', await P.$$eval('#selbody [data-num="aspectW"]', n => n.length) === 0);
  await P.click('#selbody [data-set="aspect"][data-val="custom"]'); await P.waitForTimeout(400);
  const cam = () => P.evaluate(() => { const s = window.__sp; const c = s.state().items.find(i => i.type === 'camera'); return {aspect:c.aspect, w:c.aspectW, h:c.aspectH, hfov:+(2*Math.atan(36/2/c.focal)*180/Math.PI).toFixed(2)}; });
  let c = await cam();
  ok('手動 starts from the ratio that was set (16:9)', c.aspect === 'custom' && c.w === 16 && c.h === 9, JSON.stringify(c));
  ok('and shows two number fields', await P.$$eval('#selbody [data-num="aspectW"], #selbody [data-num="aspectH"]', n => n.length) === 2);
  await P.fill('#selbody [data-num="aspectW"]', '2.39'); await P.press('#selbody [data-num="aspectW"]', 'Enter'); await P.waitForTimeout(300);
  await P.fill('#selbody [data-num="aspectH"]', '1'); await P.press('#selbody [data-num="aspectH"]', 'Enter'); await P.waitForTimeout(500);
  c = await cam();
  ok('2.39:1 is accepted', c.w === 2.39 && c.h === 1, JSON.stringify(c));
  ok('the readout says 2.39:1', /2\.39:1/.test(await P.$eval('#info', e => e.textContent)) && /2\.39:1/.test(await P.$eval('#pipinfo', e => e.textContent)));
  const body = await P.locator('#pip .body').boundingBox();
  ok('the camera window takes the custom ratio', Math.abs(body.width / body.height - 2.39) < 0.02, String(body.width / body.height));
  await P.click('[data-view="cam"]'); await P.waitForTimeout(500);
  ok('so does the finder camera', Math.abs(await P.evaluate(() => window.__sp.camera().aspect) - 2.39) < 0.001);
  const link = await P.evaluate(() => location.hash);
  await P.goto('http://localhost:8765/' + link); await P.waitForTimeout(1200);
  c = await cam();
  ok('the custom ratio survives the share link', c.aspect === 'custom' && c.w === 2.39 && c.h === 1, JSON.stringify(c));
  // 0 や負は弾く
  await P.evaluate(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'camera'), 'aspectH', '0'); });
  ok('zero is refused', (await cam()).h === 1);
  ok('aspect custom runs clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

// --- 42. 定規と、3DGS の軸・傾き・高さ ------------------------------------------------
{
  const t = await open('ruler', { width: 1300, height: 900 });
  const P = t.page, S = (fn, arg) => P.evaluate(fn, arg);
  const ruler = () => S(() => { const its = window.__sp.state().items.filter(i => i.type === 'ruler'); const it = its[its.length - 1]; return {x:it.x, z:it.z, a:it.a, b:it.b, n:its.length}; });
  const screenOf = v3 => S(v3 => { const s = window.__sp; const v = new s.THREE.Vector3(...v3).project(s.camera()); const r = document.getElementById('view').getBoundingClientRect(); return {x: r.left + (v.x+1)/2*r.width, y: r.top + (1-v.y)/2*r.height}; }, v3);
  await P.click('#addfab'); await P.waitForTimeout(300);
  ok('the ruler is offered in the gear list', (await P.$$eval('#gearlist [data-add]', b => b.map(x => x.dataset.add))).includes('ruler'));
  ok('and has a thumbnail', await P.$eval('#gearlist [data-add="ruler"] img', i => i.naturalWidth) > 0);
  await P.click('[data-add="ruler"]'); await P.waitForTimeout(400);
  ok('placing a ruler asks for the start point', /始点/.test(await P.$eval('#toast', e => e.textContent)));
  await S(() => { const s = window.__sp; s.orbit.radius = 7; s.orbit.target.set(0, 0.5, 0); s.render(); }); await P.waitForTimeout(300);
  const p1 = await screenOf([1, 0, 1]), p2 = await screenOf([-1.5, 0, -0.5]);
  await P.mouse.click(p1.x, p1.y); await P.waitForTimeout(400);
  let r = await ruler();
  ok('the first tap sets the start on the floor', Math.abs(r.x - 1) < 0.05 && Math.abs(r.z - 1) < 0.05 && r.a[1] === 0, JSON.stringify(r));
  ok('and asks for the end', /終点/.test(await P.$eval('#toast', e => e.textContent)));
  await P.mouse.click(p2.x, p2.y); await P.waitForTimeout(400);
  r = await ruler();
  const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]);
  ok('the second tap sets the end', Math.abs(r.x + r.b[0] + 1.5) < 0.06 && Math.abs(r.z + r.b[2] + 0.5) < 0.06, JSON.stringify(r));
  const L = await P.$$eval('#labels span', s => s.map(x => x.textContent));
  ok('the length is written on the view', L.some(x => new RegExp(`定規[^\\d]*${len.toFixed(2)} m`).test(x)), L.join(' | '));
  ok('the ruler shows two end handles', await S(() => window.__sp.handles().children.filter(k => k.isMesh).length) === 2);
  // 端をドラッグ
  const hb = await S(() => { const s = window.__sp; const v = s.handles().children.filter(k => k.isMesh)[1].position.clone().project(s.camera()); const rr = document.getElementById('view').getBoundingClientRect(); return {x: rr.left + (v.x+1)/2*rr.width, y: rr.top + (1-v.y)/2*rr.height}; });
  await P.mouse.move(hb.x, hb.y); await P.mouse.down(); await P.mouse.move(hb.x + 40, hb.y - 20); await P.mouse.move(hb.x + 80, hb.y - 40); await P.mouse.up(); await P.waitForTimeout(300);
  const r2 = await ruler();
  ok('dragging an end handle moves that end only', (r2.b[0] !== r.b[0] || r2.b[2] !== r.b[2]) && r2.a.join() === r.a.join() && r2.x === r.x, JSON.stringify({before:r.b, after:r2.b}));
  // 定規には向きのつまみもマニピュレータも無い（寺村さんの指示）。本体を掴んでも動かない
  ok('the ruler panel has no orientation slider', !(await P.$$eval('#selbody [data-range]', r => r.map(x => x.dataset.range))).includes('rot'));
  ok('and no manipulator', await S(() => window.__sp.gizmo.visible) === false);
  const mid = await screenOf([(r2.a[0] + r2.b[0]) / 2 + r2.x, 0.02, (r2.a[2] + r2.b[2]) / 2 + r2.z]);
  ok('the body is still pickable', (await S(([x, y]) => { const rr = document.getElementById('view').getBoundingClientRect(); return window.__sp.pick(x - rr.left, y - rr.top); }, [mid.x, mid.y]))?.id != null);
  await P.mouse.move(mid.x, mid.y); await P.mouse.down(); await P.mouse.move(mid.x + 60, mid.y + 30, {steps: 4}); await P.mouse.up(); await P.waitForTimeout(200);
  const r3 = await ruler();
  ok('but dragging the body does not move the ruler', r3.x === r2.x && r3.z === r2.z && r3.a.join() === r2.a.join() && r3.b.join() === r2.b.join(), JSON.stringify({before:r2, after:r3}));
  // 「起点をカメラにする」: a がカメラのレンズの位置に来る（定規の座標で）
  ok('the panel offers "start at camera"', await P.$$eval('#selbody [data-set="fromCam"]', b => b.length) === 1);
  await P.click('#selbody [data-set="fromCam"]'); await P.waitForTimeout(300);
  const fc = await S(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'ruler'); const ci = s.state().items.find(i => i.type === 'camera'); return {a:it.a, x:it.x, z:it.z, cam:[ci.x, ci.y, ci.z]}; });
  ok('and it puts the start on the camera lens', Math.abs(fc.a[0] + fc.x - fc.cam[0]) < 0.01 && Math.abs(fc.a[1] - fc.cam[1]) < 0.01 && Math.abs(fc.a[2] + fc.z - fc.cam[2]) < 0.01, JSON.stringify(fc));
  // 3D ビューで、視点の外側にある薄い壁の裏には吸い付かない（床に落ちる）
  await S(() => { const s = window.__sp; s.orbit.theta = Math.PI / 2; s.orbit.phi = 1.2; s.orbit.radius = 9; s.orbit.target.set(0, 0.5, 0); s.render(); }); await P.waitForTimeout(300);
  await P.click('#addfab'); await P.click('[data-add="ruler"]'); await P.waitForTimeout(300);
  const sw = await S(() => window.__sp.state().studio.w);
  const pw = await screenOf([sw / 2, 1.0, 0.3]);
  await P.mouse.click(pw.x, pw.y); await P.waitForTimeout(300);
  r = await ruler();
  ok('a tap through a faded wall lands on the floor, not on the wall\'s back', r.n === 2 && r.a[1] === 0 && r.x < sw / 2 - 0.5, JSON.stringify(r));
  await P.keyboard.press('Escape');
  await S(() => { const s = window.__sp; s.orbit.theta = 0.7; s.orbit.phi = 1.0; s.orbit.radius = 7; s.orbit.target.set(0, 0.5, 0); s.render(); }); await P.waitForTimeout(300);
  // 箱の天面をタップすると、その高さに乗る
  await t.add('[data-add="box"]');
  await S(() => { const s = window.__sp; const b = s.state().items.find(i => i.type === 'box'); s.setProp(b, 'h', 0.8); s.setProp(b, 'x', -2); s.setProp(b, 'z', 0); });
  await P.click('#addfab'); await P.click('[data-add="ruler"]'); await P.waitForTimeout(300);
  const pb = await screenOf([-2, 0.8, 0]);
  await P.mouse.click(pb.x, pb.y); await P.waitForTimeout(300);
  r = await ruler();
  ok('a tap on a box lands on its top', r.n === 3 && Math.abs(r.a[1] - 0.8) < 0.01 && Math.abs(r.x + 2) < 0.05, JSON.stringify(r));
  await P.keyboard.press('Escape');
  ok('the ruler stays out of the GLB export', await S(async () => { const s = window.__sp; const glb = (await s.glb()).buf; const j = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true)))); return !(j.nodes || []).some(n => /定規/.test(n.name || '')); }));
  const link = await S(() => location.hash);
  await P.goto('http://localhost:8765/' + link); await P.waitForTimeout(1200);
  ok('rulers survive the share link', (await ruler()).n === 3);
  // --- 3DGS: ワールド軸まわりの傾き、中心のオフセット、高さ
  const ply = `${OUT}/scan-ruler.ply`; fs.writeFileSync(ply, makeColourSplatPLY());
  await P.setInputFiles('#file', ply);
  await P.waitForFunction(() => window.__sp.state().items.some(i => i.type === 'splat'), null, { timeout: 120000 }); await P.waitForTimeout(2500);
  const sp = () => S(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'splat'); const g = s.group(it.id); let m = null; g.traverse(n => { if (n.userData.splat) m = n; });
    m.updateMatrixWorld(true); const c = m.getBoundingBox(true).getCenter(new s.THREE.Vector3()).applyMatrix4(m.matrixWorld);
    return {rot:it.rot, tiltX:it.tiltX || 0, tiltZ:it.tiltZ || 0, q:it.q || null, off:it.off || null, x:it.x, z:it.z, lift:it.lift || 0, gy:+g.position.y.toFixed(3), gpos:g.position.toArray().map(v => +v.toFixed(3)), centre:c.toArray().map(v => +v.toFixed(3)), axes:s.handles().children.filter(k => k.userData.axes).length}; });
  await S(() => { const s = window.__sp; s.select(s.state().items.find(i => i.type === 'splat').id, true); }); await P.waitForTimeout(400);
  const ranges = await P.$$eval('#selbody [data-range]', r => Object.fromEntries(r.map(x => [x.dataset.range, [+x.min, +x.max]])));
  ok('the 3DGS panel has tilt sliders and a ±50 m height', ranges.tiltX && ranges.tiltZ && ranges.lift[0] === -50 && ranges.lift[1] === 50, JSON.stringify(ranges));
  ok('and three offset sliders', ranges['off.x'] && ranges['off.y'] && ranges['off.z'], Object.keys(ranges).join(','));
  ok('under the heading 中心のオフセット', (await P.$$eval('#selbody h2', h => h.map(x => x.textContent))).includes('中心のオフセット'));
  ok('the axis is drawn while the scan is selected', (await sp()).axes === 1);
  const c0 = (await sp()).centre;
  await S(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'splat'), 'tiltX', 30); }); await P.waitForTimeout(300);
  let q = await sp();
  ok('tilting 30° about X swings the scan around the pivot', Math.abs(q.centre[2] - c0[1] * Math.sin(Math.PI/6)) < 0.01 && Math.abs(q.centre[1] - c0[1] * Math.cos(Math.PI/6)) < 0.01, JSON.stringify({c0, c:q.centre}));
  await S(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'splat'), 'rot', 90); }); await P.waitForTimeout(300);
  const q1 = await sp();
  ok('then turning 90° goes around the world Y axis, not the tilted one', Math.abs(q1.centre[0] - q.centre[2]) < 0.01 && Math.abs(q1.centre[1] - q.centre[1]) < 0.01 && Math.abs(q1.centre[2]) < 0.01, JSON.stringify(q1.centre));
  // 中心のオフセットはスキャンのほうを動かす。軸（group）と位置・高さ調整は動かない（寺村さんの指示）。
  // つまみを引いているあいだ（live）は並べ直さず、離したときの 1 回だけ
  await S(() => { const sr = window.__sp.spark(); window.__upd = 0; const o = sr.update.bind(sr); sr.update = (...a) => { window.__upd++; return o(...a); }; });
  await S(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'splat'); for (let i = 1; i <= 10; i++) s.setProp(it, 'off.x', i * 0.1, true); s.setProp(it, 'off.x', 1); s.setProp(it, 'off.y', 0.5); }); await P.waitForTimeout(300);
  const q2 = await sp();
  const moved = Math.hypot(...q2.centre.map((v, i) => v - q1.centre[i]));
  ok('moving the offset moves the scan by that much', Math.abs(moved - Math.hypot(1, 0.5)) < 0.02, JSON.stringify({before:q1.centre, after:q2.centre, moved}));
  ok('while the axis, position and lift stay put', q2.gpos.join() === q1.gpos.join() && q2.x === q1.x && q2.z === q1.z && q2.lift === q1.lift, JSON.stringify({g0:q1.gpos, g1:q2.gpos, x:q2.x, lift:q2.lift}));
  ok('and the offset is in the state', q2.off && q2.off[0] === 1 && q2.off[1] === 0.5, JSON.stringify(q2.off));
  ok('ten live slider steps re-sort the splats only twice (once per release)', await S(() => window.__upd) === 2, String(await S(() => window.__upd)));
  await S(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'splat'), 'tiltReset', '1'); }); await P.waitForTimeout(300);
  const q3 = await sp();
  ok('reset keeps only the turn', q3.q === null && q3.tiltX === 0 && q3.tiltZ === 0 && q3.rot === 90, JSON.stringify(q3));
  await S(() => { const s = window.__sp; s.setProp(s.state().items.find(i => i.type === 'splat'), 'lift', 20); });
  ok('the height goes far beyond 6 m now', (await sp()).gy === 20);
  await S(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'splat'); s.setProp(it, 'lift', 0); s.setProp(it, 'tiltZ', 20); s.setProp(it, 'cropOn', '1'); }); await P.waitForTimeout(400);
  ok('crop handles still come out on a tilted scan', await S(() => window.__sp.handles().children.filter(k => k.isMesh).length) === 6);
  const link2 = await S(() => location.hash);
  await P.goto('http://localhost:8765/' + link2); await P.waitForTimeout(1500);
  const q4 = await S(() => { const it = window.__sp.state().items.find(i => i.type === 'splat'); return {q:it.q, off:it.off, tiltZ:it.tiltZ}; });
  ok('orientation and offset survive the share link', Array.isArray(q4.q) && q4.q.length === 4 && q4.off[0] === 1 && q4.tiltZ === 20, JSON.stringify(q4));
  // 3DGS の上をタップすると、その面に定規の端が乗る（Spark の raycast）
  await P.click('#addfab'); await P.click('[data-add="ruler"]'); await P.waitForTimeout(300);
  const st = await S(() => { const s = window.__sp; const it = s.state().items.find(i => i.type === 'splat'); const g = s.group(it.id); let m = null; g.traverse(n => { if (n.userData.splat) m = n; }); m.updateMatrixWorld(true);
    const b = m.getBoundingBox(true); const p = new s.THREE.Vector3(-1.5, b.max.y, -1.5).applyMatrix4(m.matrixWorld); s.orbit.target.copy(p); s.orbit.radius = 5; s.render(); return p.toArray(); });
  await P.waitForTimeout(400);
  const ps = await screenOf(st);
  await P.mouse.click(ps.x, ps.y); await P.waitForTimeout(600);
  r = await ruler();
  ok('a tap on the scan lands on a splat, above the floor', r.a[1] > 0.05, JSON.stringify(r));
  await P.keyboard.press('Escape');
  ok('ruler run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
