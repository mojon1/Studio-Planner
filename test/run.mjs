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

// --- a textured box, as GLB (embedded) and as the "glTF Separate" trio ---
function crc32(buf){
  const t = []; let c;
  for (let n = 0; n < 256; n++){ c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePNG(N = 16){
  const raw = [];
  for (let y = 0; y < N; y++){
    raw.push(0);
    for (let x = 0; x < N; x++){ const c = ((x >> 1) + (y >> 1)) % 2 ? [235,60,40] : [250,230,90]; raw.push(...c); }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from(raw))), pngChunk('IEND', Buffer.alloc(0))]);
}
// embed:true puts the PNG in the binary chunk (GLB); false points at paint.png (glTF Separate)
function texturedGLTF(embed){
  const png = makePNG();
  const verts = [], uvs = [], norms = [], idx = [];
  const hx = 1, hy = 1.5, hz = 0.5;
  const faces = [
    [[-hx,-hy,hz],[hx,-hy,hz],[hx,hy,hz],[-hx,hy,hz],[0,0,1]],
    [[hx,-hy,-hz],[-hx,-hy,-hz],[-hx,hy,-hz],[hx,hy,-hz],[0,0,-1]],
    [[hx,-hy,hz],[hx,-hy,-hz],[hx,hy,-hz],[hx,hy,hz],[1,0,0]],
    [[-hx,-hy,-hz],[-hx,-hy,hz],[-hx,hy,hz],[-hx,hy,-hz],[-1,0,0]],
    [[-hx,hy,hz],[hx,hy,hz],[hx,hy,-hz],[-hx,hy,-hz],[0,1,0]],
    [[-hx,-hy,-hz],[hx,-hy,-hz],[hx,-hy,hz],[-hx,-hy,hz],[0,-1,0]],
  ];
  faces.forEach((f, i) => {
    for (let k = 0; k < 4; k++){ verts.push(f[k][0], f[k][1] + hy, f[k][2]); norms.push(...f[4]); }
    uvs.push(0,1, 1,1, 1,0, 0,0);
    const o = i*4; idx.push(o, o+1, o+2, o, o+2, o+3);
  });
  const vb = Buffer.from(new Float32Array(verts).buffer), nb = Buffer.from(new Float32Array(norms).buffer);
  const tb = Buffer.from(new Float32Array(uvs).buffer), ib = Buffer.from(new Uint16Array(idx).buffer);
  const parts = [vb, nb, tb, ib];
  if (embed) parts.push(png, Buffer.alloc((4 - png.length % 4) % 4));
  const bin = Buffer.concat(parts);
  let off = 0; const bv = [];
  for (const p of [vb, nb, tb, ib]){ bv.push({buffer:0, byteOffset:off, byteLength:p.length}); off += p.length; }
  if (embed) bv.push({buffer:0, byteOffset:off, byteLength:png.length});
  const json = { asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0, name:'Box'}],
    meshes:[{primitives:[{attributes:{POSITION:0, NORMAL:1, TEXCOORD_0:2}, indices:3, material:0}]}],
    materials:[{name:'Painted', pbrMetallicRoughness:{baseColorTexture:{index:0}, metallicFactor:0, roughnessFactor:0.8}}],
    textures:[{source:0, sampler:0}], samplers:[{magFilter:9729, minFilter:9987, wrapS:10497, wrapT:10497}],
    images:[embed ? {bufferView:4, mimeType:'image/png'} : {uri:'paint.png'}],
    buffers:[embed ? {byteLength:bin.length} : {uri:'scene.bin', byteLength:bin.length}],
    bufferViews:bv,
    accessors:[
      {bufferView:0, componentType:5126, count:verts.length/3, type:'VEC3', min:[-hx,0,-hz], max:[hx,hy*2,hz]},
      {bufferView:1, componentType:5126, count:norms.length/3, type:'VEC3'},
      {bufferView:2, componentType:5126, count:uvs.length/2, type:'VEC2'},
      {bufferView:3, componentType:5123, count:idx.length, type:'SCALAR'}] };
  if (!embed) return { gltf: Buffer.from(JSON.stringify(json), 'utf8'), bin, png };
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const header = Buffer.alloc(12); header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4E4F534A, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004E4942, 4);
  return { glb: Buffer.concat([header, jc, js, bc, bin]), png };
}

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
});
async function run(name, viewport, mobile, hash = '') {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**', route => {
    const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.170.0/', '');
    const f = path.join(NM, 'three', rel);
    if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' }); else route.fulfill({ status: 404 });
  });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto('http://localhost:8765/' + hash);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  return { page, ctx, errors };
}

// desktop plan view
let r = await run('desktop-plan', { width: 1280, height: 800 }, false);
console.log('desktop errors:', r.errors);
// switch to camera view, add mirror
await r.page.click('[data-tab="add"]');
await r.page.click('[data-add="mirror"]');
await r.page.waitForTimeout(300);
await r.page.click('[data-view="cam"]');
await r.page.waitForTimeout(800);
await r.page.screenshot({ path: `${OUT}/desktop-cam.png` });
await r.page.click('[data-view="side"]');
await r.page.waitForTimeout(500);
await r.page.screenshot({ path: `${OUT}/desktop-side.png` });
await r.page.click('[data-tab="add"]');
await r.page.click('[data-add="chroma"]');
await r.page.waitForTimeout(300);
await r.page.click('[data-view="pers"]');
await r.page.waitForTimeout(500);
// orbit drag on empty space
await r.page.mouse.move(700, 150); await r.page.mouse.down(); await r.page.mouse.move(600, 200, {steps: 8}); await r.page.mouse.up();
await r.page.waitForTimeout(500);
await r.page.screenshot({ path: `${OUT}/desktop-pers.png` });
await r.page.click('[data-tab="studio"]');
await r.page.click('[data-cove="left"]'); await r.page.click('[data-cove="right"]');
await r.page.waitForTimeout(500);
await r.page.screenshot({ path: `${OUT}/desktop-pers-cove.png` });
// orbit so the eye is outside the right wall, walls there should fade
await r.page.mouse.move(700, 150); await r.page.mouse.down(); await r.page.mouse.move(400, 160, {steps: 8}); await r.page.mouse.up();
await r.page.waitForTimeout(400);
await r.page.screenshot({ path: `${OUT}/desktop-pers-fade.png` });
// hide the mirror via the eye button
await r.page.click('[data-tab="add"]');
await r.page.click('#items .itemrow:nth-child(3) .eye'); await r.page.waitForTimeout(300);
console.log('hidden rows:', await r.page.$$eval('#items .itemrow.hidden-item', b => b.length));
await r.page.click('[data-view="side"]'); await r.page.waitForTimeout(400);
await r.page.screenshot({ path: `${OUT}/desktop-side2.png` });
await r.page.click('[data-view="pers"]'); await r.page.waitForTimeout(300);
// drag pip bar to top-left, then resize
const pb = await r.page.$eval('#pip .bar', e => { const r = e.getBoundingClientRect(); return {x:r.x+40, y:r.y+12}; });
await r.page.mouse.move(pb.x, pb.y); await r.page.mouse.down(); await r.page.mouse.move(pb.x-500, pb.y-300, {steps:10}); await r.page.mouse.up();
const pg = await r.page.$eval('#pip .grip', e => { const r = e.getBoundingClientRect(); return {x:r.x+18, y:r.y+18}; });
await r.page.mouse.move(pg.x, pg.y); await r.page.mouse.down(); await r.page.mouse.move(pg.x+120, pg.y+80, {steps:10}); await r.page.mouse.up();
await r.page.waitForTimeout(400);
console.log('pip rect:', await r.page.$eval('#pip', e => e.style.cssText));
await r.page.screenshot({ path: `${OUT}/desktop-pip.png` });
// select camera via list, choose custom sensor
await r.page.click('[data-tab="studio"]'); await r.page.click('[data-tab="add"]');
await r.page.click('#items .itemrow:nth-child(2) > button:first-child');
await r.page.waitForTimeout(200);
console.log('sel tab open:', await r.page.$eval('[data-tab="sel"]', b => b.classList.contains('on')));
await r.page.click('[data-set="sensor"][data-val="custom"]');
await r.page.fill('[data-num="sensorW"]', '24.9');
await r.page.press('[data-num="sensorW"]', 'Enter');
await r.page.waitForTimeout(300);
// name the custom width and save it
await r.page.fill('[data-sensorname]', 'うちのV-RAPTOR');
await r.page.click('[data-sensorsave]');
await r.page.waitForTimeout(300);
console.log('saved presets:', await r.page.$$eval('[data-sensorpreset]', b => b.map(x => x.textContent)));
console.log('info uses saved name:', (await r.page.textContent('#info')).split('\n')[1]);
// switch to the スーパー35 format button
await r.page.click('[data-set="sensor"][data-val="s35"]');
await r.page.waitForTimeout(300);
console.log('s35 info:', (await r.page.textContent('#info')).split('\n')[1]);
console.log('s35 lenses:', await r.page.$$eval('[data-set="focal"]', b => b.map(x => x.textContent).join(' ')));
await r.page.click('[data-set="sensor"][data-val="custom"]');
await r.page.waitForTimeout(300);
console.log('preset recalled after round trip:', await r.page.$$eval('[data-sensorpreset].on', b => b.length));
await r.page.screenshot({ path: `${OUT}/desktop-sensor.png` });
await r.page.click('[data-view="cam"]');
await r.page.waitForTimeout(600);
await r.page.screenshot({ path: `${OUT}/desktop-cam2.png` });
console.log('info:', await r.page.textContent('#info'));
await r.page.click('[data-view="plan"]');
await r.page.click('[data-tab="add"]');
await r.page.click('#items .itemrow:nth-child(1) > button:first-child');
await r.page.waitForTimeout(400);
await r.page.screenshot({ path: `${OUT}/desktop-plan2.png` });
// rotate ring drag: person at world (0,-0.5); plan scale ~86.7 px/m, centre (810,400)
{ const b = await r.page.$eval('#pip .bar', e => { const r = e.getBoundingClientRect(); return {x:r.x+40, y:r.y+12}; });
  await r.page.mouse.move(b.x, b.y); await r.page.mouse.down(); await r.page.mouse.move(b.x+700, b.y+500, {steps:8}); await r.page.mouse.up(); await r.page.waitForTimeout(200); }
const rotBefore = await r.page.inputValue('[data-range="rot"]');
await r.page.mouse.move(810+69, 357); await r.page.mouse.down(); await r.page.mouse.move(810+40, 357-50, {steps:6}); await r.page.mouse.move(810, 357-69, {steps:6}); await r.page.mouse.up();
await r.page.waitForTimeout(300);
console.log('rot before/after ring drag:', rotBefore, await r.page.inputValue('[data-range="rot"]'));
// fold / unfold
await r.page.click('#fold'); await r.page.waitForTimeout(300);
console.log('folded panel hidden:', await r.page.$eval('#panel', e => getComputedStyle(e).display === 'none'));
await r.page.screenshot({ path: `${OUT}/desktop-folded.png` });
await r.page.click('#unfold'); await r.page.waitForTimeout(200);
// share link
await r.page.click('[data-tab="share"]');
await r.page.waitForTimeout(500);
const link = await r.page.inputValue('#linkbox');
console.log('link length', link.length, link.slice(0, 80));
console.log('after interactions errors:', r.errors);
await r.ctx.close();

// mobile, loading the shared link
const hash = link.slice(link.indexOf('#'));
r = await run('mobile-plan', { width: 390, height: 844 }, true, hash);
console.log('mobile errors:', r.errors);
const items = await r.page.$$eval('#items .itemrow', b => b.length);
console.log('mobile items restored:', items);
// touch drag person in plan view
const box = await r.page.$eval('#view', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
await r.page.touchscreen.tap(cx, cy);
await r.page.waitForTimeout(300);
await r.page.screenshot({ path: `${OUT}/mobile-selected.png` });
await r.page.screenshot({ path: `${OUT}/mobile-folded.png` });
await r.page.tap('[data-tab="sel"]'); await r.page.waitForTimeout(300);
await r.page.screenshot({ path: `${OUT}/mobile-open.png` });
console.log('mobile errors end:', r.errors);
await r.ctx.close();

// an old link that still says sensor:'apsc' must migrate to a 23.5 mm manual width
{
  const legacy = {studio:{w:8,d:6,h:4,cove:{back:true,left:false,right:false}}, items:[{id:'c1',type:'camera',x:0,z:2,y:1.4,rot:180,pitch:0,sensor:'apsc',focal:35,aspect:'3:2'}]};
  const enc = 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(legacy))).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const g = await run('legacy', { width: 1280, height: 800 }, false, '#s=' + enc);
  console.log('legacy apsc link ->', (await g.page.textContent('#info')).split('\n')[1]);
  console.log('legacy errors:', g.errors);
  await g.ctx.close();
}

// object presets and 3D model import
{
  const g = await run('presets', { width: 1400, height: 900 }, false);
  for (const p of ['0','1','2','3']){ await g.page.click('[data-tab="add"]'); await g.page.click(`[data-person="${p}"]`); }
  for (const t of ['car','chair','table','box']){ await g.page.click('[data-tab="add"]'); await g.page.click(`[data-add="${t}"]`); }
  await g.page.waitForTimeout(600);
  await g.page.click('[data-tab="add"]');
  console.log('preset rows:', await g.page.$$eval('#items .itemrow > button:first-child', b => b.map(x => x.textContent.trim())));
  const glb = `${OUT}/test-box.glb`; fs.writeFileSync(glb, makeGLB());
  await g.page.setInputFiles('#file', glb);
  await g.page.waitForTimeout(2000);
  console.log('imported row:', await g.page.$$eval('#items .itemrow > button:first-child', b => b.map(x => x.textContent.trim()).slice(-1)[0]));
  console.log('model height field:', await g.page.inputValue('[data-num="targetH"]').catch(() => 'n/a'));
  console.log('fbx module resolves:', await g.page.evaluate(() => import('three/addons/loaders/FBXLoader.js').then(m => typeof m.FBXLoader).catch(e => 'ERR ' + e.message)));
  await g.page.click('[data-view="pers"]'); await g.page.waitForTimeout(900);
  await g.page.screenshot({ path: `${OUT}/presets.png` });
  await g.page.click('[data-view="side"]'); await g.page.waitForTimeout(600);
  await g.page.screenshot({ path: `${OUT}/presets-side.png` });
  await g.page.click('[data-tab="share"]'); await g.page.waitForTimeout(500);
  console.log('presets link length:', (await g.page.inputValue('#linkbox')).length);
  console.log('presets errors:', g.errors);
  await g.ctx.close();
}

// a shared link whose model file is not on this device must fall back to a box
{
  const shared = {studio:{w:8,d:6,h:4,cove:{back:true,left:false,right:false}}, items:[
    {id:'c1',type:'camera',x:0,z:2.4,y:1.3,rot:180,pitch:-6,sensor:'ff',focal:35,aspect:'3:2'},
    {id:'m1',type:'model',x:0,z:0,rot:0,key:'missing',name:'set.glb',scale:1,upFix:false,w:2,d:1,h:3}]};
  const enc = 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(shared))).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const g = await run('shared-model', { width: 1280, height: 800 }, false, '#s=' + enc);
  console.log('placeholder row:', await g.page.$$eval('#items .itemrow > button:first-child', b => b.map(x => x.textContent.trim())));
  console.log('shared-model errors:', g.errors);
  await g.ctx.close();
}

// textures: embedded in a GLB, split across a glTF trio, and the trio missing its parts
{
  const g = await run('textures', { width: 1280, height: 800 }, false);
  const emb = texturedGLTF(true), sep = texturedGLTF(false);
  fs.writeFileSync(`${OUT}/painted.glb`, emb.glb);
  fs.writeFileSync(`${OUT}/painted.gltf`, sep.gltf);
  fs.writeFileSync(`${OUT}/scene.bin`, sep.bin);
  fs.writeFileSync(`${OUT}/paint.png`, sep.png);

  await g.page.click('[data-tab="add"]');
  await g.page.setInputFiles('#file', `${OUT}/painted.glb`);
  await g.page.waitForTimeout(1800);
  console.log('GLB embedded ->', (await g.page.textContent('#selbody')).replace(/\s+/g, ' ').trim().slice(0, 90));

  // the glTF with its .bin and .png picked alongside it
  await g.page.click('[data-tab="add"]');
  await g.page.setInputFiles('#file', [`${OUT}/painted.gltf`, `${OUT}/scene.bin`, `${OUT}/paint.png`]);
  await g.page.waitForTimeout(2000);
  console.log('glTF + sidecars ->', (await g.page.textContent('#selbody')).replace(/\s+/g, ' ').trim().slice(0, 90));
  console.log('rows now:', await g.page.$$eval('#items .itemrow > button:first-child', b => b.map(x => x.textContent.trim()).slice(-2)));
  await g.page.click('[data-view="pers"]'); await g.page.waitForTimeout(1000);
  await g.page.screenshot({ path: `${OUT}/textures.png` });

  // reopening the page must rebuild both models from IndexedDB, sidecars included
  await g.page.reload();
  await g.page.waitForTimeout(2500);
  await g.page.click('[data-tab="add"]');
  await g.page.click('#items .itemrow:last-child > button:first-child');
  await g.page.waitForTimeout(400);
  console.log('after reload ->', (await g.page.textContent('#selbody')).replace(/\s+/g, ' ').trim().slice(0, 60));

  // geometry embedded but the image left outside: the model appears, so the only
  // way the user learns why it is grey is us naming the file
  const inline = JSON.parse(sep.gltf.toString('utf8'));
  inline.buffers = [{ uri: 'data:application/octet-stream;base64,' + sep.bin.toString('base64'), byteLength: sep.bin.length }];
  fs.writeFileSync(`${OUT}/inline-buffer.gltf`, JSON.stringify(inline));
  await g.page.click('[data-view="plan"]');
  await g.page.click('[data-tab="add"]');
  await g.page.setInputFiles('#file', `${OUT}/inline-buffer.gltf`);
  await g.page.waitForTimeout(2000);
  console.log('missing image named ->', await g.page.textContent('#toast'));
  console.log('panel says ->', (await g.page.textContent('#selbody')).replace(/\s+/g, ' ').trim().slice(0, 70));

  // dropping files (no folder entries, as a synthetic DataTransfer gives) still imports
  await g.page.click('[data-view="plan"]');
  const before = await g.page.$$eval('#items .itemrow', b => b.length);
  await g.page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.glb', { type: 'model/gltf-binary' }));
    document.getElementById('view').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, emb.glb.toString('base64'));
  await g.page.waitForTimeout(2000);
  console.log('dropped file imported:', (await g.page.$$eval('#items .itemrow', b => b.length)) - before === 1);

  // the same glTF on its own must say what is missing rather than fail silently
  await g.page.click('[data-tab="add"]');
  await g.page.setInputFiles('#file', `${OUT}/painted.gltf`);
  await g.page.waitForTimeout(1500);
  console.log('glTF alone ->', await g.page.textContent('#toast'));
  console.log('texture errors:', g.errors.filter(e => !e.includes('404') && !e.includes("Couldn't load texture")));
  await g.ctx.close();
}

// viewer mode
r = await run('viewer', { width: 390, height: 844 }, true, hash + '&m=v');
console.log('viewer errors:', r.errors);
await r.ctx.close();
await browser.close(); server.close();
