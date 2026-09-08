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

// PDF sheet: fill the header fields, build the sheet, check both orientations
{
  const g = await run('pdf', { width: 1500, height: 950 }, false);
  await g.page.click('[data-tab="share"]');
  await g.page.fill('#m-project', 'コスモ石油 CM 30秒');
  await g.page.fill('#m-cut', 'C-12');
  await g.page.fill('#m-memo', '演者は白ホリ手前 2m。\nレフ板は下手から。');
  await g.page.click('#makepdf');
  await g.page.waitForTimeout(2500);
  console.log('paper shown:', await g.page.$eval('#papermodal', e => e.classList.contains('show')));
  console.log('panels:', await g.page.$$eval('#paper .pv img', n => n.length));
  console.log('labels on sheet:', await g.page.$$eval('#paper .pv .lb', n => n.length));
  console.log('page rule:', await g.page.$eval('#paper', () => [...document.styleSheets].map(x => { try { return [...x.cssRules].map(r => r.cssText).filter(t => t.startsWith('@page')).join('') } catch { return '' } }).join('')));
  console.log('sheet text:', (await g.page.$eval('#paper .ph', e => e.innerText)).replace(/\n/g, ' | '));
  await g.page.screenshot({ path: `${OUT}/pdf-landscape.png`, fullPage: false });
  await g.page.click('#paperclose');
  await g.page.click('[data-orient="portrait"]');
  await g.page.click('#makepdf');
  await g.page.waitForTimeout(2500);
  console.log('portrait class:', await g.page.$eval('#paper', e => e.className));
  await g.page.screenshot({ path: `${OUT}/pdf-portrait.png`, fullPage: false });
  // the live view must survive the off-screen capture passes
  await g.page.click('#paperclose'); await g.page.waitForTimeout(600);
  await g.page.screenshot({ path: `${OUT}/pdf-after.png` });
  // the real proof: let Chromium make the PDF and check it is exactly one page
  const openShare = async () => {
    if (!await g.page.$eval('[data-tab="share"]', b => b.classList.contains('on'))) await g.page.click('[data-tab="share"]');
    await g.page.evaluate(() => document.body.classList.remove('folded'));
  };
  for (const o of ['landscape','portrait']){
    await openShare();
    await g.page.click(`[data-orient="${o}"]`);
    await g.page.click('#makepdf');
    await g.page.waitForTimeout(2000);
    const buf = await g.page.pdf({ preferCSSPageSize: true, printBackground: true });
    const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    fs.writeFileSync(`${OUT}/sheet-${o}.pdf`, buf);
    console.log(`${o}: ${pages} page(s), ${(buf.length/1024).toFixed(0)} KB`);
    await g.page.click('#paperclose');
  }
  console.log('pdf errors:', g.errors);
  await g.ctx.close();
}

// viewer mode
r = await run('viewer', { width: 390, height: 844 }, true, hash + '&m=v');
console.log('viewer errors:', r.errors);
await r.ctx.close();
await browser.close(); server.close();
