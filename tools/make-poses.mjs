// docs/pose-check/src/*.fbx から models/poses.json と、ポーズ選択用のサムネイルを作る。
//
// FBX を実行時に読ませないための道具。書き出すのは関節のワールド位置だけで、
// 回転は入れない。骨の長さもリグの初期姿勢も関係なくなるので、この 1 ファイルを
// 11 体すべてで共通に使える（回転を焼くと体ごとに別ファイルが要る）。
//
// 向き合わせの本体は index.html の applyPose() にもある。片方を直したら
// もう片方も直すこと。ここはサムネイルを焼くためだけに持っている。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'pose-check', 'src');
const MODELS = path.join(ROOT, 'models'), THUMBS = path.join(MODELS, 'thumbs');
const NM = path.join(ROOT, 'test', 'node_modules');
const THUMB_MODEL = 'us-casual-man.glb';       // サムネイルはこの 1 体で撮る
const TW = 200, TH = 200;

// ファイル名 -> 出す名前と並び順。ここに無いものは無視する
const NAMES = {
  'Male Standing Pose':        {id:'stand-1',  label:'立つ'},
  'Male Standing Pose (1)':    {id:'stand-2',  label:'立つ 2'},
  'Male Standing Pose (2)':    {id:'stand-3',  label:'立つ 3'},
  'Female Standing Pose':      {id:'stand-4',  label:'立つ 4'},
  'Female Standing Pose (1)':  {id:'stand-5',  label:'立つ 5'},
  'Male Locomotion Pose':      {id:'walk',     label:'歩く'},
  'Male Sitting Pose':         {id:'sit-chair',label:'椅子'},
  'Male Sitting Pose (1)':     {id:'sit-floor',label:'床に座る'},
  'Male Laying Pose':          {id:'lie-up',   label:'仰向け'},
  'Female Laying Pose':        {id:'lie-down', label:'うつ伏せ'},
  'Female Dance Pose':         {id:'dance',    label:'ダンス'},
};
const ORDER = ['stand-1','stand-2','stand-3','stand-4','stand-5','walk','sit-chair','sit-floor','lie-up','lie-down','dance'];

const files = fs.readdirSync(SRC).filter(f => f.toLowerCase().endsWith('.fbx'));
const html = `<canvas id=c width=${TW} height=${TH}></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
const JOINTS = ['Hips','Spine','Spine1','Spine2','Neck','Head','LeftShoulder','LeftArm','LeftForeArm','LeftHand',
  'RightShoulder','RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase',
  'RightUpLeg','RightLeg','RightFoot','RightToeBase'];
const MAP = {Hips:'Hip', Spine:'Waist', Spine1:'Spine01', Spine2:'Spine02', Neck:'NeckTwist01', Head:'Head',
  LeftShoulder:'L_Clavicle', LeftArm:'L_Upperarm', LeftForeArm:'L_Forearm', LeftHand:'L_Hand',
  RightShoulder:'R_Clavicle', RightArm:'R_Upperarm', RightForeArm:'R_Forearm', RightHand:'R_Hand',
  LeftUpLeg:'L_Thigh', LeftLeg:'L_Calf', LeftFoot:'L_Foot', LeftToeBase:'L_ToeBase',
  RightUpLeg:'R_Thigh', RightLeg:'R_Calf', RightFoot:'R_Foot', RightToeBase:'R_ToeBase'};
const CHILD_OF = {Spine:'Hips', Spine1:'Spine', Spine2:'Spine1', Neck:'Spine2', Head:'Neck',
  LeftShoulder:'Spine2', LeftArm:'LeftShoulder', LeftForeArm:'LeftArm', LeftHand:'LeftForeArm',
  RightShoulder:'Spine2', RightArm:'RightShoulder', RightForeArm:'RightArm', RightHand:'RightForeArm',
  LeftUpLeg:'Hips', LeftLeg:'LeftUpLeg', LeftFoot:'LeftLeg', LeftToeBase:'LeftFoot',
  RightUpLeg:'Hips', RightLeg:'RightUpLeg', RightFoot:'RightLeg', RightToeBase:'RightFoot'};
const PRIMARY = {Hips:'Spine', Spine2:'Neck'};
const ORDER2 = ['Hips','Spine','Spine1','Spine2','Neck','LeftShoulder','LeftArm','LeftForeArm',
  'RightShoulder','RightArm','RightForeArm','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
const V = THREE.Vector3, Q = THREE.Quaternion;
const byName = (r, n) => { let f = null; r.traverse(o => { if (!f && o.name === n) f = o; }); return f; };

window.__read = async file => {
  const fbx = await new FBXLoader().loadAsync('/s/' + encodeURIComponent(file));
  // Mixamo の書き出しは姿勢が 1 フレームのアニメーションに入っている。
  // C4D 経由のものは骨に焼かれている。どちらでも同じ結果になるようにする。
  if (fbx.animations.length){
    const m = new THREE.AnimationMixer(fbx);
    m.clipAction(fbx.animations[0]).play();
    m.setTime(0);
  }
  fbx.updateMatrixWorld(true);
  const bones = []; fbx.traverse(o => { if (o.isBone) bones.push(o.name); });
  const hips = bones.find(n => /Hips$/.test(n));
  if (!hips) throw new Error('Hips が見つからない: ' + file);
  const prefix = hips.replace(/Hips$/, '');
  const pos = {};
  for (const j of JOINTS){ const b = byName(fbx, prefix + j); if (b) pos[j] = b.getWorldPosition(new V()); }
  const miss = JOINTS.filter(j => !pos[j]);
  if (miss.length) throw new Error('骨が足りない: ' + miss.join(','));
  // 腰を原点に、腰から首までを 1 に正規化する。向きしか使わないので大きさは本来自由だが、
  // 数字が揃っていたほうが後で読める
  const o = pos.Hips.clone(), k = 1 / Math.max(1e-6, pos.Neck.distanceTo(pos.Hips));
  return JOINTS.map(j => pos[j].clone().sub(o).multiplyScalar(k).toArray().map(v => +v.toFixed(4)));
};

// --- 向き合わせ（index.html の applyPose と同じもの） ---
function applyPose(root, flat){
  const src = {};
  JOINTS.forEach((j, i) => { src[j] = new V().fromArray(flat[i]); });
  const tb = {}; for (const [m, t] of Object.entries(MAP)) tb[m] = byName(root, t);
  for (const m of ORDER2){
    const bone = tb[m]; if (!bone) continue;
    const kid = PRIMARY[m] || Object.keys(CHILD_OF).find(k => CHILD_OF[k] === m);
    if (!kid || !src[m] || !src[kid]) continue;
    const want = src[kid].clone().sub(src[m]);
    if (want.lengthSq() < 1e-9) continue;
    const curW = bone.getWorldQuaternion(new Q());
    const have = new V(0,1,0).applyQuaternion(curW).normalize();
    let q = new Q().setFromUnitVectors(have, want.clone().normalize()).multiply(curW);
    if (m === 'Hips' && tb.LeftUpLeg && tb.RightUpLeg){        // 腰は左右の軸も合わせないと向きが決まらない
      const axis = want.clone().normalize();
      const proj = v => v.clone().projectOnPlane(axis).normalize();
      const localLR = tb.LeftUpLeg.getWorldPosition(new V()).sub(tb.RightUpLeg.getWorldPosition(new V()))
        .applyQuaternion(curW.clone().invert());
      const a = proj(localLR.clone().applyQuaternion(q)), b = proj(src.LeftUpLeg.clone().sub(src.RightUpLeg));
      if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6){
        let ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
        if (a.clone().cross(b).dot(axis) < 0) ang = -ang;
        q = new Q().setFromAxisAngle(axis, ang).multiply(q);
      }
    }
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new Q()).invert().multiply(q));
    bone.updateMatrixWorld(true);
  }
  root.updateMatrixWorld(true);
}

const base = (await new GLTFLoader().loadAsync('/m/' + ${JSON.stringify(THUMB_MODEL)})).scene;
const r = new THREE.WebGLRenderer({canvas:document.getElementById('c'), antialias:true, alpha:true, preserveDrawingBuffer:true});
r.setClearAlpha(0);
window.__shoot = flat => {
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1.2, 2.4, 3); sc.add(dl);
  const o = skeletonClone(base);
  o.updateMatrixWorld(true);
  if (flat) applyPose(o, flat);
  const bb = new THREE.Box3().setFromObject(o);
  o.position.y -= bb.min.y;
  sc.add(o);
  o.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(o);
  const c = b2.getCenter(new V()), s = b2.getSize(new V());
  const reach = Math.max(s.x, s.y, s.z) * 1.15 + 0.1;
  const cam = new THREE.PerspectiveCamera(26, ${TW}/${TH}, 0.05, 50);
  cam.position.set(c.x + reach*0.55, c.y + s.y*0.15, c.z + reach*2.5);
  cam.lookAt(c.x, c.y, c.z);
  r.render(sc, cam);
  return document.getElementById('c').toDataURL('image/webp', 0.82);
};
window.__ready = true;
</script>`;
const server = http.createServer((q,s)=>{
  if (q.url === '/') { s.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return s.end(html); }
  for (const [pre, dir] of [['/s/', SRC], ['/m/', MODELS]])
    if (q.url.startsWith(pre)) { const p = path.join(dir, decodeURIComponent(q.url.slice(3)));
      if (fs.existsSync(p)) { s.writeHead(200,{'content-type':'application/octet-stream'}); return s.end(fs.readFileSync(p)); } }
  const f = path.join(NM, q.url.replace(/^\/three\//,'three/'));
  if (fs.existsSync(f)) { s.writeHead(200,{'content-type':'text/javascript'}); return s.end(fs.readFileSync(f)); }
  s.writeHead(404); s.end();
}).listen(8778);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({viewport:{width:TW, height:TH}})).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8778/');
await p.waitForFunction(() => window.__ready, null, {timeout:60000});

fs.mkdirSync(THUMBS, { recursive: true });
const out = {version:1, joints:null, poses:[]};
const got = {};
for (const f of files){
  const key = f.replace(/\.fbx$/i, '');
  const meta = NAMES[key];
  if (!meta) { console.log(`skip  ${f}`); continue; }
  const flat = await p.evaluate(n => window.__read(n), f);
  got[meta.id] = {id: meta.id, label: meta.label, p: flat};
  const url = await p.evaluate(fl => window.__shoot(fl), flat);
  const png = path.join(THUMBS, `pose-${meta.id}.webp`);
  fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`ok    ${f}  -> ${meta.id} (${(fs.statSync(png).size/1024).toFixed(1)} KB)`);
}
// 素の姿勢のサムネイルも 1 枚
const rest = await p.evaluate(() => window.__shoot(null));
fs.writeFileSync(path.join(THUMBS, 'pose-none.webp'), Buffer.from(rest.split(',')[1], 'base64'));
out.joints = await p.evaluate(() => ['Hips','Spine','Spine1','Spine2','Neck','Head','LeftShoulder','LeftArm','LeftForeArm','LeftHand','RightShoulder','RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase','RightUpLeg','RightLeg','RightFoot','RightToeBase']);
out.poses = ORDER.filter(id => got[id]).map(id => got[id]);
const dst = path.join(MODELS, 'poses.json');
fs.writeFileSync(dst, JSON.stringify(out));
console.log(`\n${out.poses.length} poses -> ${path.relative(ROOT, dst)} ${(fs.statSync(dst).size/1024).toFixed(1)} KB`);
await b.close(); server.close(); process.exit(0);
