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
const encodeState = st => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(st)))
  .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0].split('#')[0]);
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'});
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
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, acceptDownloads: true });
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
  const tab = async n => { await page.click(`[data-tab="${n}"]`); await page.waitForTimeout(150); };
  return { name, ctx, page, errors, add, tab };
}

// --- 1. desktop: place things, drive the manipulator, check the sensor panel ----------
{
  const t = await open('desktop', { width: 1500, height: 950 });
  for (const p of ['0','1','2','3']) await t.add(`[data-person="${p}"]`);
  for (const k of ['car','chair','table','box','mirror','chroma']) await t.add(`[data-add="${k}"]`);
  const rows = await t.page.$$eval('#items .itemrow > button:first-child', b => b.map(x => x.textContent.trim()));
  ok('all presets placed', rows.length === 13, `${rows.length} rows`);
  ok('人 labelled by body and age', rows.some(r => r.startsWith('男の子')) && rows.some(r => r.startsWith('女性')));

  // a second camera becomes the active one
  await t.add('[data-add="camera"]');
  const camRows = await t.page.$$eval('#items .itemrow[data-kind="camera"] small', n => n.map(x => x.textContent));
  ok('two cameras, one marked active', camRows.length === 2 && camRows.filter(x => x.includes('表示中')).length === 1, camRows.join(' | '));

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
  await t.page.click('#items .itemrow:nth-child(2) > button:first-child');
  await t.page.waitForTimeout(300);
  const before = await t.page.inputValue('[data-range="rot"]');
  const c = await t.page.$eval('#view', e => { const r = e.getBoundingClientRect(); return {x:r.x + r.width/2, y:r.y + r.height/2}; });
  await t.page.mouse.move(c.x + 62, c.y); await t.page.mouse.down();
  await t.page.mouse.move(c.x + 40, c.y - 45, {steps:6}); await t.page.mouse.move(c.x, c.y - 62, {steps:6}); await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  ok('ring drag turns the item', (await t.page.inputValue('[data-range="rot"]')) !== before, `${before} -> ${await t.page.inputValue('[data-range="rot"]')}`);
  await t.page.click('#pipbtn');

  // typing an exact number into a slider readout
  await t.page.click('#items .itemrow[data-kind="table"] > button:first-child');
  await t.page.waitForTimeout(250);
  await t.page.click('[data-edit="w"]');
  await t.page.fill('input.vedit', '2.4');
  await t.page.press('input.vedit', 'Enter');
  await t.page.waitForTimeout(300);
  ok('typed number reaches the slider', (await t.page.inputValue('[data-range="w"]')) === '2.4', await t.page.inputValue('[data-range="w"]'));

  // the drawing names a reflector by its long and short side, a backdrop by w x d
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(600);
  const drawn = await t.page.$$eval('#labels span', n => n.map(x => x.textContent));
  ok('reflector labelled long/short side', drawn.some(x => x.includes('長辺') && x.includes('短辺')), drawn.join(' | '));
  ok('backdrop labelled width and depth', drawn.some(x => x.includes('幅') && x.includes('奥行')), drawn.filter(x => x.includes('幅')).join(' | '));
  const boxes = await t.page.$$eval('#labels span', n => n.map(e => { const r = e.getBoundingClientRect(); return {l:r.left, r:r.right, t:r.top, b:r.bottom}; }));
  let overlap = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i+1; j < boxes.length; j++){
    const a = boxes[i], b = boxes[j];
    if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlap++;
  }
  ok('no two dimension labels overlap', overlap === 0, `${overlap} overlapping pairs of ${boxes.length}`);

  // the distance line belongs to the object now, and only appears when switched on
  await t.page.click('#items .itemrow[data-kind="person"] > button:first-child');
  await t.page.waitForTimeout(250);
  ok('objects carry a カメラまで switch', await t.page.$('[data-dim="dimCam"]') !== null);
  ok('cameras no longer carry 被写体まで', await t.page.$('[data-dim="dimSubject"]') === null);
  await t.page.click('[data-view="plan"]'); await t.page.waitForTimeout(500);
  await t.page.click('[data-dim="dimCam"]'); await t.page.waitForTimeout(400);
  await t.page.click('#items .itemrow[data-kind="box"] > button:first-child'); await t.page.waitForTimeout(500);
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
  const sub = await t.page.$$eval('#items .itemrow[data-kind="model"] small', n => n.map(x => x.textContent));
  ok('GLB imported at its true size', sub[0] === '2×1×3 m', sub.join(' | '));
  ok('height field matches', (await t.page.inputValue('[data-num="targetH"]')) === '3.00');
  ok('FBX loader resolves through the importmap',
     (await t.page.evaluate(() => import('three/addons/loaders/FBXLoader.js').then(m => typeof m.FBXLoader).catch(e => 'ERR ' + e.message))) === 'function');
  ok('import run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();

  const shared = {meta:{project:'',cut:'',memo:''}, studio:{w:8,d:6,h:4,cove:{back:true,left:false,right:false}}, activeCam:'c1', items:[
    {id:'c1',type:'camera',x:0,z:2.4,y:1.3,rot:180,pitch:-6,sensor:'ff',focal:35,aspect:'16:9'},
    {id:'m1',type:'model',x:0,z:0,rot:0,key:'missing',name:'set.glb',scale:1,upFix:false,w:2,d:1,h:3}]};
  const g = await open('shared', { width: 1280, height: 800 }, false, '#s=' + encodeState(shared));
  const row = await g.page.$$eval('#items .itemrow[data-kind="model"] small', n => n.map(x => x.textContent));
  ok('a model this device lacks shows as a box', row[0]?.startsWith('箱'), row.join(' | '));
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
  await t.tab('share');
  await t.page.fill('#m-project', 'コスモ石油 CM 30秒');
  await t.page.fill('#m-cut', 'C-12');
  await t.page.fill('#m-memo', '演者は白ホリ手前 2m。\nレフ板は下手から。');
  for (const o of ['landscape','portrait']){
    await t.tab('share');
    await t.page.click(`[data-orient="${o}"]`);
    await t.page.click('#makepdf');
    await t.page.waitForTimeout(2500);
    const panels = await t.page.$$eval('#paper .pv img', n => n.length);
    const labels = await t.page.$$eval('#paper .pv .lb', n => n.length);
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
      const pane = await t.page.$('#paper .pv[data-pane="plan"]');
      const b = await pane.boundingBox();
      await t.page.mouse.move(b.x + b.width/2, b.y + b.height/2);
      await t.page.mouse.down();
      await t.page.mouse.move(b.x + b.width/2 + 40, b.y + b.height/2 + 25, {steps:6});
      await t.page.mouse.up();
      await t.page.waitForTimeout(200);
      const moved = await t.page.$eval('#paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('a panel can be dragged to reframe it', /translate\(-?[1-9]/.test(moved), moved);
      await t.page.mouse.wheel(0, -200); await t.page.waitForTimeout(200);
      const zoomed = await t.page.$eval('#paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('the wheel zooms a panel', !/scale\(1\.000\)/.test(zoomed), zoomed);
      await t.page.click('#framereset'); await t.page.waitForTimeout(200);
      const back = await t.page.$eval('#paper .pv[data-pane="plan"] .pvin', e => e.style.transform);
      ok('reset puts every panel back', /translate\(0%,\s*0%\)\s*scale\(1\)/.test(back), back);

      // the finder must stay exactly what the camera sees, so it takes no reframing
      const fb = await (await t.page.$('#paper .pv[data-pane="cam"]')).boundingBox();
      await t.page.mouse.move(fb.x + fb.width/2, fb.y + fb.height/2);
      await t.page.mouse.down();
      await t.page.mouse.move(fb.x + fb.width/2 + 45, fb.y + fb.height/2 + 30, {steps:6});
      await t.page.mouse.up();
      await t.page.mouse.wheel(0, -200);
      await t.page.waitForTimeout(200);
      const fin = await t.page.$eval('#paper .pv[data-pane="cam"] .pvin', e => e.style.transform);
      ok('the finder cannot be reframed', /translate\(0%,\s*0%\)\s*scale\(1\)/.test(fin), fin);
    }
    await t.page.click('#paperclose');
  }
  const head = await t.page.$eval('#paper .ph', e => e.innerText.replace(/\n/g, ' | '));
  ok('header carries project, cut and stamp', head.includes('コスモ石油') && head.includes('C-12') && /\d{4}\/\d{2}\/\d{2}/.test(head), head);
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
  await t.tab('share');
  await t.page.fill('#m-project', '青山スタジオ 下見');
  await t.page.fill('#m-cut', 'C-3');
  await t.page.waitForTimeout(200);
  const before = await t.page.$$eval('#items .itemrow', n => n.length);

  const dl = await Promise.all([t.page.waitForEvent('download'), t.page.click('#savefile')]).then(r => r[0]);
  const name = dl.suggestedFilename();
  const file = path.join(OUT, 'project.studio.json');
  await dl.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('save names the file from the project and cut',
     name.includes('青山スタジオ') && name.includes('C-3') && /\d{4}-\d{2}-\d{2}/.test(name) && name.endsWith('.studio.json'), name);
  ok('the file holds the whole scene', saved.items.length === before - 1 && saved.meta.cut === 'C-3', `${saved.items.length} items`);

  // wipe it, then read the file back
  t.page.once('dialog', d => d.accept());
  await t.page.click('#reset');
  await t.page.waitForTimeout(300);
  ok('reset empties the list', await t.page.$$eval('#items .itemrow', n => n.length) === 1);

  await t.page.setInputFiles('#projfile', file);
  await t.page.waitForTimeout(600);
  const after = await t.page.$$eval('#items .itemrow', n => n.length);
  ok('load brings every object back', after === before, `${after} rows, was ${before}`);
  ok('load brings the meta back', await t.page.inputValue('#m-cut') === 'C-3');

  await t.page.setInputFiles('#projfile', path.join(HERE, 'package.json'));
  await t.page.waitForTimeout(400);
  ok('a file that is not a scene is refused, not applied',
     (await t.page.textContent('#toast')).includes('読めません') && await t.page.$$eval('#items .itemrow', n => n.length) === after);
  ok('project file run clean', t.errors.length === 0, t.errors.join(' | '));
  await t.ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
