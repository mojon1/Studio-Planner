// FBX を GLB に変換する。Tripo から GLB で直接落とせないときの回り道。
//   node tools/fbx-to-glb.mjs 元.fbx 出力.glb
// テクスチャは FBX の隣の .fbm フォルダから拾って埋め込む（元と同じ場所に置いておく）。
// 画像は GLTFExporter が PNG にするので、このあと必ず shrink-glb.mjs を通すこと。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'test', 'node_modules');
const [,, src, dst] = process.argv;
if (!src || !dst){ console.error('usage: node tools/fbx-to-glb.mjs in.fbx out.glb'); process.exit(1); }
const SRC = path.dirname(path.resolve(src)), NAME = path.basename(src);

const html = `<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
window.__run = async (url) => {
  // **テクスチャは loadAsync では待たない。** FBX 本体が解決した時点では
  // 画像がまだ空で、そのまま GLTFExporter に渡すと
  // 「No valid image data found」で止まる。LoadingManager の onLoad まで待つ
  const manager = new THREE.LoadingManager();
  let allDone; const loaded = new Promise(r => { allDone = r; });
  manager.onLoad = () => allDone();
  const o = await new FBXLoader(manager).loadAsync(url);
  await Promise.race([loaded, new Promise(r => setTimeout(r, 60000))]);
  // FBXLoader は Phong で組む。glTF は PBR なので、色とテクスチャだけ引き継いで
  // Standard に置き換える（Tripo のモデルは陰影がテクスチャに焼いてある）
  const info = {bones:0, uv:true, maps:[]};
  o.traverse(n => {
    if (n.isBone) info.bones++;
    if (!n.isMesh) return;
    if (!n.geometry.attributes.uv) info.uv = false;
    n.material = [].concat(n.material).map(m => {
      const s = new THREE.MeshStandardMaterial({name:m.name, map:m.map || null,
        color:0xffffff, metalness:0, roughness:0.9, side:m.side});
      if (m.map){ m.map.colorSpace = THREE.SRGBColorSpace; info.maps.push([m.map.image?.width, m.map.image?.height]); }
      m.dispose();
      return s;
    });
    if (n.material.length === 1) n.material = n.material[0];
  });
  const box = new THREE.Box3().setFromObject(o), sz = new THREE.Vector3(); box.getSize(sz);
  info.size = [+sz.x.toFixed(3), +sz.y.toFixed(3), +sz.z.toFixed(3)];
  info.min = [+box.min.x.toFixed(3), +box.min.y.toFixed(3), +box.min.z.toFixed(3)];
  const buf = await new GLTFExporter().parseAsync(o, {binary:true});
  info.glb = [...new Uint8Array(buf)];
  return info;
};
window.__ready = true;
</script>`;
const MIME = {'.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png','.fbx':'application/octet-stream'};
const server = http.createServer((q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/'){ s.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return s.end(html); }
  if (u.startsWith('/src/')){
    const p = path.join(SRC, u.slice(5));
    if (fs.existsSync(p) && fs.statSync(p).isFile()){
      s.writeHead(200, {'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'});
      return s.end(fs.readFileSync(p));
    }
  }
  const f = path.join(NM, u.replace(/^\/three\//, 'three/'));
  if (fs.existsSync(f)){ s.writeHead(200, {'content-type':'text/javascript'}); return s.end(fs.readFileSync(f)); }
  s.writeHead(404); s.end();
}).listen(8784);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext()).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8784/');
await p.waitForFunction(() => window.__ready, null, {timeout:60000});
const info = await p.evaluate(u => window.__run(u), '/src/' + encodeURIComponent(NAME));
fs.writeFileSync(dst, Buffer.from(info.glb));
await b.close(); server.close();
console.log(`bones ${info.bones}  uv ${info.uv}  texture ${info.maps.map(m => m.join('x')).join(', ') || 'なし'}`);
console.log(`size ${info.size.join(' x ')} m  min ${info.min.join(', ')}`);
if (Math.abs(info.size[1] - 1) > 0.01) console.log('!! 身長が 1 m ではない。人物モデルは 1 m に揃えること');
if (Math.abs(info.min[1]) > 0.005) console.log('!! 足が y=0 に載っていない');
if (!info.uv || !info.bones) console.log('!! UV か骨が無い。このままでは人物モデルに使えない');
console.log(`-> ${dst} ${(fs.statSync(dst).size/1024/1024).toFixed(2)} MB   このあと shrink-glb.mjs を通すこと`);
process.exit(0);
