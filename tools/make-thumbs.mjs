// models/*.glb それぞれの立ち姿を models/thumbs/*.webp に焼く。
// + ボタンの一覧は文字より絵のほうが速いので、名前ではなく本人の姿で選ばせる。
// 背景は透過。パネルが白でも黒でも同じものが使える。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'models'), OUT = path.join(DIR, 'thumbs');
const NM = path.join(ROOT, 'test', 'node_modules');
// 人は**上半身のアップ**（全身だと + の一覧で小さくて誰か分からない — 寺村さんの指摘）、
// 車は斜め前からの横長。canvas は大きいほうで取って、撮るときにビューポートを切る
const W = 200, H = 200, CW = 200, CH = 140;
fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.glb')).sort();
const html = `<canvas id=c width=${W} height=${H}></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const r = new THREE.WebGLRenderer({canvas:document.getElementById('c'), antialias:true, alpha:true, preserveDrawingBuffer:true});
r.setClearAlpha(0);
const loader = new GLTFLoader();
window.__shoot = async (file, car) => {
  const w = car ? ${CW} : ${W}, h = car ? ${CH} : ${H};
  const cv = document.getElementById('c'); cv.width = w; cv.height = h;
  r.setSize(w, h, false);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1.2, 2.4, 3); sc.add(dl);
  const o = (await loader.loadAsync('/m/' + file)).scene;
  sc.add(o);
  const b = new THREE.Box3().setFromObject(o), c = new THREE.Vector3(); b.getCenter(c);
  const cam = new THREE.PerspectiveCamera(car ? 26 : 24, w/h, 0.05, 50);
  // 車は斜め前から。真横だとどれも同じ影絵になって選べない
  // 人はモデルが身長 1 m に揃っているので、頭から腰までを決め打ちで切り取れる
  const eye = b.max.y * 0.90;
  if (car) cam.position.set(1.05, c.y * 2.4, 2.0); else cam.position.set(0.08, eye, 1.00);
  cam.lookAt(0, car ? c.y * 0.9 : eye, 0);
  r.render(sc, cam);
  return cv.toDataURL('image/webp', 0.82);
};
window.__ready = true;
</script>`;
const server = http.createServer((q,s)=>{
  if (q.url === '/') { s.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return s.end(html); }
  if (q.url.startsWith('/m/')) { const p = path.join(DIR, decodeURIComponent(q.url.slice(3)));
    if (fs.existsSync(p)) { s.writeHead(200,{'content-type':'model/gltf-binary'}); return s.end(fs.readFileSync(p)); } }
  const f = path.join(NM, q.url.replace(/^\/three\//,'three/'));
  if (fs.existsSync(f)) { s.writeHead(200,{'content-type':'text/javascript'}); return s.end(fs.readFileSync(f)); }
  s.writeHead(404); s.end();
}).listen(8773);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({viewport:{width:W, height:H}})).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8773/');
await p.waitForFunction(() => window.__ready, null, {timeout:60000});
for (const f of files){
  const url = await p.evaluate(n => window.__shoot(n, n.startsWith('car-')), f);
  const out = path.join(OUT, f.replace(/\.glb$/, '.webp'));
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${f} -> ${path.basename(out)} ${(fs.statSync(out).size/1024).toFixed(1)} KB`);
}
await b.close(); server.close(); process.exit(0);
