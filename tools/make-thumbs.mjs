// models/*.glb それぞれの立ち姿を models/thumbs/*.webp に焼く。
// + ボタンの一覧は文字より絵のほうが速いので、名前ではなく本人の姿で選ばせる。
// 背景は透過。パネルが白でも黒でも同じものが使える。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'models'), OUT = path.join(DIR, 'thumbs');
const NM = path.join(ROOT, 'test', 'node_modules');
const W = 200, H = 300;
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
window.__shoot = async file => {
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1.2, 2.4, 3); sc.add(dl);
  const o = (await loader.loadAsync('/m/' + file)).scene;
  sc.add(o);
  const b = new THREE.Box3().setFromObject(o), c = new THREE.Vector3(); b.getCenter(c);
  const cam = new THREE.PerspectiveCamera(24, ${W}/${H}, 0.05, 50);
  cam.position.set(0.12, c.y, 2.9); cam.lookAt(0, c.y, 0);
  r.render(sc, cam);
  return document.getElementById('c').toDataURL('image/webp', 0.82);
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
  const url = await p.evaluate(n => window.__shoot(n), f);
  const out = path.join(OUT, f.replace(/\.glb$/, '.webp'));
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${f} -> ${path.basename(out)} ${(fs.statSync(out).size/1024).toFixed(1)} KB`);
}
await b.close(); server.close(); process.exit(0);
