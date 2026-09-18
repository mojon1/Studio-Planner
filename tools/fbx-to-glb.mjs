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
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
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
  const info = {bones:0, uv:true, maps:[], verts:[0, 0]};
  o.traverse(n => {
    if (n.isBone) info.bones++;
    if (!n.isMesh) return;
    if (!n.geometry.attributes.uv) info.uv = false;
    // FBX の頂点は三角形ごとにばらけている（index 無し）。同じ頂点をまとめて index を付けると
    // 3〜6 倍小さくなる（Mixamo 経由の asia-casual-man は 15 万頂点 8.6 MB → まとめて 1/4）。
    // 位置・法線・UV・骨の重みが全部同じものだけを 1 つにするので、見た目は変わらない
    info.verts[0] += n.geometry.attributes.position.count;
    if (!n.geometry.index) n.geometry = mergeVertices(n.geometry);
    info.verts[1] += n.geometry.attributes.position.count;
    n.material = [].concat(n.material).map(m => {
      const s = new THREE.MeshStandardMaterial({name:m.name, map:m.map || null,
        color:0xffffff, metalness:0, roughness:0.9, side:m.side});
      if (m.map){ m.map.colorSpace = THREE.SRGBColorSpace; info.maps.push([m.map.image?.width, m.map.image?.height]); }
      m.dispose();
      return s;
    });
    if (n.material.length === 1) n.material = n.material[0];
  });
  // Mixamo（と一部の書き出し元）は Z 上・cm・正面が -Y で出てくる。Tripo と同じ
  // 「Y 上・身長 1 m・正面 +Z・足が y=0」に揃える。骨と皮の関係はそのままなので、
  // 頂点には触らず、いちばん外の group に回転と縮尺を持たせる。
  // 上方向は外形のいちばん長い軸（T ポーズでも腕の幅より背のほうが高い）。
  // 正面は骨から出す（左右の脚の向き × 腰→背骨の向き）。骨が無ければそのまま
  o.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(o), sz0 = new THREE.Vector3(); box0.getSize(sz0);
  const wrap = new THREE.Group(); wrap.name = 'root'; wrap.add(o);
  if (sz0.z > sz0.y && sz0.z > sz0.x){ wrap.rotation.x = -Math.PI / 2; info.fixed = 'z-up'; }
  wrap.updateMatrixWorld(true);
  const bone = {}; o.traverse(n => { if (n.isBone) bone[n.name.replace(/^.*?(?=(Hips|Spine|LeftUpLeg|RightUpLeg)$)/, '')] = n; });
  if (bone.Hips && bone.Spine && bone.LeftUpLeg && bone.RightUpLeg){
    const wp = n => n.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3().crossVectors(wp(bone.LeftUpLeg).sub(wp(bone.RightUpLeg)), wp(bone.Spine).sub(wp(bone.Hips)));
    if (fwd.z < 0){ wrap.rotateY(Math.PI); info.fixed = (info.fixed || '') + ' turned'; }
    wrap.updateMatrixWorld(true);
  }
  const box1 = new THREE.Box3().setFromObject(wrap), sz1 = new THREE.Vector3(); box1.getSize(sz1);
  if (Math.abs(sz1.y - 1) > 0.01 && sz1.y > 0){ wrap.scale.setScalar(1 / sz1.y); info.fixed = (info.fixed || '') + ' scaled 1/' + sz1.y.toFixed(2); }   // この中はテンプレート文字列なのでバッククォートは使えない
  wrap.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(wrap);
  wrap.position.set(-(box2.min.x + box2.max.x) / 2, -box2.min.y, -(box2.min.z + box2.max.z) / 2);
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap), sz = new THREE.Vector3(); box.getSize(sz);
  info.size = [+sz.x.toFixed(3), +sz.y.toFixed(3), +sz.z.toFixed(3)];
  info.min = [+box.min.x.toFixed(3), +box.min.y.toFixed(3), +box.min.z.toFixed(3)];
  const buf = await new GLTFExporter().parseAsync(wrap, {binary:true});
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
console.log(`bones ${info.bones}  uv ${info.uv}  texture ${info.maps.map(m => m.join('x')).join(', ') || 'なし'}  verts ${info.verts[0]} -> ${info.verts[1]}`);
console.log(`size ${info.size.join(' x ')} m  min ${info.min.join(', ')}${info.fixed ? '  (fixed: ' + info.fixed.trim() + ')' : ''}`);
if (Math.abs(info.size[1] - 1) > 0.01) console.log('!! 身長が 1 m ではない。人物モデルは 1 m に揃えること');
if (Math.abs(info.min[1]) > 0.005) console.log('!! 足が y=0 に載っていない');
if (!info.uv || !info.bones) console.log('!! UV か骨が無い。このままでは人物モデルに使えない');
console.log(`-> ${dst} ${(fs.statSync(dst).size/1024/1024).toFixed(2)} MB   このあと shrink-glb.mjs を通すこと`);
process.exit(0);
