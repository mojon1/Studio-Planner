// 小道具と撮影機材のサムネイルを models/thumbs/prop-*.webp に焼く。
//
// これらは GLB ではなくアプリの中で組み立てているので、**アプリ自身を開いて**
// `+` から 1 個ずつ置き、その group だけを別のレンダラで撮る。形を直したら
// 焼き直すこと（`node tools/make-prop-thumbs.mjs`）。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THUMBS = path.join(ROOT, 'models', 'thumbs');
const NM = path.join(ROOT, 'test', 'node_modules');
const S = 200;
// 置くもの（`+` の data-add）と、撮る向き。車だけモデルを取りに行くので長めに待つ
const PROPS = [
  {add:'car',    wait:3000},
  {add:'chair'}, {add:'table'}, {add:'box'}, {add:'koma'},
  {add:'camera'}, {add:'light'}, {add:'mirror'}, {add:'chroma'},
];
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json',
              '.glb':'model/gltf-binary','.webp':'image/webp','.png':'image/png','.webmanifest':'application/json'};
const server = http.createServer((q, s) => {
  const p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/^\//, '') || 'index.html');
  if (fs.existsSync(p) && fs.statSync(p).isFile()){
    s.writeHead(200, {'content-type': MIME[path.extname(p)] || 'application/octet-stream'});
    return s.end(fs.readFileSync(p));
  }
  s.writeHead(404); s.end();
}).listen(8786);

const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({viewport:{width:1100, height:760}, serviceWorkers:'block'});
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'', contentType:'text/css'}));
await p.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', route => {
  const rel = route.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.180.0/', '');
  const f = path.join(NM, 'three', rel);
  if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: 'text/javascript' });
  else route.fulfill({ status: 404 });
});
await p.goto('http://localhost:8786/');
await p.waitForTimeout(2000);
// 撮るための入れ物を 1 つだけ作っておく（アプリのレンダラは多面描画とシザーの
// 途中なので借りない）
await p.evaluate(size => {
  const THREE = window.__sp.THREE;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const r = new THREE.WebGLRenderer({canvas:cv, antialias:true, alpha:true, preserveDrawingBuffer:true});
  r.setClearAlpha(0);
  window.__shot = id => {
    const src = window.__sp.group(id);
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5); dl.position.set(1.4, 2.2, 2.4); sc.add(dl);
    const o = src.clone(true);
    const drop = [];
    o.traverse(n => {
      // 当たり判定の見えない殻（カメラの三角錐）と、向きを示す補助線は入れない。
      // 線を残すと外接球がそのぶん膨らんで、本体が豆粒になる（ライトで踏んだ）
      // userData.plan は上面図の記号（ライトの照射くさび・足元の円）。長さ 4 m の
      // くさびを残すと外接球がそれで決まり、本体が豆粒になる
      if ((n.material && n.material.opacity === 0) || n.isLine || n.isPoints || n.userData.plan) { drop.push(n); return; }
      // 鏡は Reflector（ShaderMaterial）。**別のシーンでは何も映らず真っ黒になる**ので、
      // サムネイルのあいだだけ銀色の板に差し替える
      if (n.isMesh && n.material && n.material.type === 'ShaderMaterial')
        n.material = new THREE.MeshStandardMaterial({color:0xc9d6e2, metalness:0.6, roughness:0.15});
    });
    for (const n of drop) n.parent?.remove(n);
    o.position.set(0, o.position.y, 0);
    sc.add(o);
    o.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(o);
    const c = box.getCenter(new THREE.Vector3());
    const rad = box.getBoundingSphere(new THREE.Sphere()).radius;
    const fov = 26;
    const cam = new THREE.PerspectiveCamera(fov, 1, 0.02, 100);
    const dist = rad / Math.sin(fov * Math.PI / 360) * 1.06;
    cam.position.copy(c).add(new THREE.Vector3(0.55, 0.5, 1).normalize().multiplyScalar(dist));
    cam.lookAt(c);
    r.render(sc, cam);
    return cv.toDataURL('image/webp', 0.82);
  };
}, S);

fs.mkdirSync(THUMBS, { recursive: true });
for (const {add, wait} of PROPS){
  await p.click('#addfab'); await p.waitForTimeout(250);
  await p.click(`[data-add="${add}"]`);
  await p.waitForTimeout(wait || 600);
  const url = await p.evaluate(() => window.__shot(window.__sp.state().items.at(-1).id));
  const out = path.join(THUMBS, `prop-${add}.webp`);
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${add} -> ${path.basename(out)} ${(fs.statSync(out).size/1024).toFixed(1)} KB`);
}
await b.close(); server.close(); process.exit(0);
