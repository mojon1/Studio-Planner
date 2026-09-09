// 送られてきたポーズ FBX を全部 Tripo リグに移して一枚に並べる。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const NM = '/home/user/Osmo360_AdobePlugin/studio3d/test/node_modules';
const MODELS = '/home/user/Osmo360_AdobePlugin/studio3d/models';
const S = '/tmp/claude-0/-home-user-Osmo360-AdobePlugin/48d9bd61-b204-5f58-b94d-c3c4b5cc9328/scratchpad';
const POSES = path.join(S, 'poses');
const GLB = process.argv[2] || 'us-casual-man.glb';
const OUT = process.argv[3] || `${S}/poses.png`;
const files = fs.readdirSync(POSES).filter(f => f.toLowerCase().endsWith('.fbx')).sort();
const W = 1500, H = 680;
const html = `<canvas id=c width=${W} height=${H}></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
const FILES = ${JSON.stringify(files)};
const MAP = {
  Hips:'Hip', Spine:'Waist', Spine1:'Spine01', Spine2:'Spine02', Neck:'NeckTwist01', Head:'Head',
  LeftShoulder:'L_Clavicle', LeftArm:'L_Upperarm', LeftForeArm:'L_Forearm', LeftHand:'L_Hand',
  RightShoulder:'R_Clavicle', RightArm:'R_Upperarm', RightForeArm:'R_Forearm', RightHand:'R_Hand',
  LeftUpLeg:'L_Thigh', LeftLeg:'L_Calf', LeftFoot:'L_Foot', LeftToeBase:'L_ToeBase',
  RightUpLeg:'R_Thigh', RightLeg:'R_Calf', RightFoot:'R_Foot', RightToeBase:'R_ToeBase',
};
const CHILD_OF = {Spine:'Hips', Spine1:'Spine', Spine2:'Spine1', Neck:'Spine2', Head:'Neck',
  LeftShoulder:'Spine2', LeftArm:'LeftShoulder', LeftForeArm:'LeftArm', LeftHand:'LeftForeArm',
  RightShoulder:'Spine2', RightArm:'RightShoulder', RightForeArm:'RightArm', RightHand:'RightForeArm',
  LeftUpLeg:'Hips', LeftLeg:'LeftUpLeg', LeftFoot:'LeftLeg', LeftToeBase:'LeftFoot',
  RightUpLeg:'Hips', RightLeg:'RightUpLeg', RightFoot:'RightLeg', RightToeBase:'RightFoot'};
const PRIMARY = {Hips:'Spine', Spine2:'Neck'};
const ORDER = ['Hips','Spine','Spine1','Spine2','Neck','LeftShoulder','LeftArm','LeftForeArm',
  'RightShoulder','RightArm','RightForeArm','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
const V = THREE.Vector3, Q = THREE.Quaternion;
const byName = (root, n) => { let f = null; root.traverse(o => { if (!f && o.name === n) f = o; }); return f; };
const wpos = o => o.getWorldPosition(new V());
function alignTo(bone, wantDir, rollHave, rollWant){
  const curW = bone.getWorldQuaternion(new Q());
  const haveDir = new V(0,1,0).applyQuaternion(curW).normalize();
  let want = new Q().setFromUnitVectors(haveDir, wantDir.clone().normalize()).multiply(curW);
  if (rollHave && rollWant){
    const axis = wantDir.clone().normalize();
    const proj = v => v.clone().projectOnPlane(axis).normalize();
    const a = proj(rollHave.clone().applyQuaternion(want)), b = proj(rollWant);
    if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6){
      let ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      if (a.clone().cross(b).dot(axis) < 0) ang = -ang;
      want = new Q().setFromAxisAngle(axis, ang).multiply(want);
    }
  }
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new Q()).invert().multiply(want));
  bone.updateMatrixWorld(true);
}
const gltf = await new GLTFLoader().loadAsync('/m/' + ${JSON.stringify(GLB)});
const fbxLoader = new FBXLoader();
const sc = new THREE.Scene();
sc.background = new THREE.Color(0x20232a);
sc.add(new THREE.HemisphereLight(0xffffff,0x999999,1.5));
const dl = new THREE.DirectionalLight(0xffffff,1.4); dl.position.set(1.5,3,3); sc.add(dl);
const report = [], tiles = [];
const gap = 0.62, span = (FILES.length)*gap;
for (let i = 0; i < FILES.length; i++){
  const f = FILES[i];
  let row = {file:f};
  try {
    const fbx = await fbxLoader.loadAsync('/p/' + encodeURIComponent(f));
    // Mixamo の書き出しは姿勢が 1 フレームのアニメーションに入っている。
    // 読んだままの骨はバインド姿勢なので、必ず 0 秒を適用してから位置を読む。
    if (fbx.animations.length){
      const mixer = new THREE.AnimationMixer(fbx);
      mixer.clipAction(fbx.animations[0]).play();
      mixer.setTime(0);
      row.anim = +fbx.animations[0].duration.toFixed(3);
    }
    fbx.updateMatrixWorld(true);
    const names = []; fbx.traverse(o => { if (o.isBone) names.push(o.name); });
    const hips = names.find(n => /Hips$/.test(n));
    const prefix = hips ? hips.replace(/Hips$/, '') : '';
    const src = {};
    for (const m of Object.keys(MAP)){ const b = byName(fbx, (prefix||'') + m); if (b) src[m] = wpos(b); }
    row.bones = names.length; row.prefix = prefix; row.mapped = Object.keys(src).length;
    if (row.mapped < 15) { row.skipped = 'not enough mapped bones'; report.push(row); continue; }
    const posed = skeletonClone(gltf.scene);
    posed.updateMatrixWorld(true);
    const tb = {}; for (const [m,t] of Object.entries(MAP)) tb[m] = byName(posed, t);
    for (const m of ORDER){
      const bone = tb[m]; if (!bone) continue;
      const kid = PRIMARY[m] || Object.keys(CHILD_OF).find(k => CHILD_OF[k] === m);
      if (!kid || !src[m] || !src[kid]) continue;
      const want = src[kid].clone().sub(src[m]);
      if (want.lengthSq() < 1e-9) continue;
      let rh = null, rw = null;
      if (m === 'Hips' && src.LeftUpLeg && src.RightUpLeg){
        rw = src.LeftUpLeg.clone().sub(src.RightUpLeg);
        rh = wpos(tb.LeftUpLeg).sub(wpos(tb.RightUpLeg)).applyQuaternion(bone.getWorldQuaternion(new Q()).invert());
      }
      alignTo(bone, want, rh, rw);
    }
    posed.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(posed);
    posed.position.y = -bb.min.y;
    posed.updateMatrixWorld(true);
    const bb2 = new THREE.Box3().setFromObject(posed);
    row.size = new THREE.Vector3().subVectors(bb2.max, bb2.min).toArray().map(v => +v.toFixed(3));
    tiles.push({posed, box:bb2, label:f.replace(/\.fbx$/i,'')});
    row.ok = true;
  } catch(e){ row.ok = false; row.err = String(e && e.message || e); }
  report.push(row);
}
// 一体ずつ、その姿勢に合わせて寄って撮り、1 枚に貼る
const TW = 250, TH = 340, COLS = 6;
const tile = document.createElement('canvas'); tile.width = TW; tile.height = TH;
const r = new THREE.WebGLRenderer({canvas:tile, antialias:true});
const grid = new THREE.GridHelper(6, 24, 0x556, 0x3a3f48);
const out = document.getElementById('c');
const g2 = out.getContext('2d');
g2.fillStyle = '#20232a'; g2.fillRect(0, 0, out.width, out.height);
g2.font = '600 15px sans-serif'; g2.textAlign = 'center';
for (let i = 0; i < tiles.length; i++){
  const t = tiles[i];
  const s2 = new THREE.Scene();
  s2.background = new THREE.Color(0x20232a);
  s2.add(new THREE.HemisphereLight(0xffffff,0x999999,1.5));
  const d2 = new THREE.DirectionalLight(0xffffff,1.4); d2.position.set(1.5,3,3); s2.add(d2);
  s2.add(t.posed, grid.clone());
  const c = t.box.getCenter(new THREE.Vector3()), sz = t.box.getSize(new THREE.Vector3());
  const reach = Math.max(sz.x, sz.y, sz.z * 0.6);
  const cam = new THREE.PerspectiveCamera(30, TW/TH, 0.05, 60);
  cam.position.set(c.x + reach*1.3, c.y + sz.y*0.35, c.z + reach*2.3);
  cam.lookAt(c.x, c.y, c.z);
  r.render(s2, cam);
  const col = i % COLS, row2 = Math.floor(i / COLS);
  g2.drawImage(tile, col*TW, row2*TH);
  g2.fillStyle = '#e6e9ef';
  g2.fillText(t.label, col*TW + TW/2, row2*TH + TH - 10);
}
window.__out = report; window.__done = true;
</script>`;
http.createServer((q,s)=>{
  if (q.url === '/') { s.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return s.end(html); }
  for (const [pre, dir] of [['/p/', POSES], ['/m/', MODELS]])
    if (q.url.startsWith(pre)) { const p = path.join(dir, decodeURIComponent(q.url.slice(3)));
      if (fs.existsSync(p)) { s.writeHead(200,{'content-type':'application/octet-stream'}); return s.end(fs.readFileSync(p)); } }
  const f = path.join(NM, q.url.replace(/^\/three\//,'three/'));
  if (fs.existsSync(f)) { s.writeHead(200,{'content-type':'text/javascript'}); return s.end(fs.readFileSync(f)); }
  s.writeHead(404); s.end();
}).listen(8777);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({viewport:{width:W,height:H}})).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8777/');
await p.waitForFunction(() => window.__done, null, {timeout:180000});
for (const r of await p.evaluate(() => window.__out))
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file.padEnd(30)} bones=${r.bones ?? '-'} prefix="${r.prefix ?? ''}" anim=${r.anim ?? '-'} mapped=${r.mapped ?? '-'} size=${r.size ?? r.err ?? r.skipped}`);
await p.locator('#c').screenshot({path: OUT});
await b.close(); process.exit(0);
