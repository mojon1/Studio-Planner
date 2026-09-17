// docs/pose-check/src/*.fbx から models/poses.json と、ポーズ選択用のサムネイルを作る。
//
// FBX を実行時に読ませないための道具。書き出すのは関節のワールド位置だけで、
// 回転は入れない。骨の長さもリグの初期姿勢も関係なくなるので、この 1 ファイルを
// 11 体すべてで共通に使える（回転を焼くと体ごとに別ファイルが要る）。
// v1.43.0 から手も（指の曲げ・手の向き・手のひらの法線。写真の手と同じ 11 個 × 2）。`--hands` で数字を出す。
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

// ファイル名 -> 出す名前と並び順。ここに無いものは無視する。
// stand-1 / stand-4 / walk / dance はアプリの一覧に出さない（index.html の
// POSE_HIDDEN）。データは古い共有リンクのために残してあるので、消さないこと。
const NAMES = {
  'Male Standing Pose':        {id:'stand-1',  label:'立つ'},
  'Male Standing Pose (1)':    {id:'stand-2',  label:'立つ 1'},
  'Male Standing Pose (2)':    {id:'stand-3',  label:'立つ 2'},
  'Female Standing Pose':      {id:'stand-4',  label:'立つ 4'},
  'Female Standing Pose (1)':  {id:'stand-5',  label:'立つ 3'},
  'Male Locomotion Pose':      {id:'walk',     label:'歩く'},
  'Sitting':                   {id:'sit-chair',label:'椅子'},
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
const JOINTS = ['Hips','Spine','Spine1','Spine2','Neck','Head','HeadTop_End','LeftShoulder','LeftArm','LeftForeArm','LeftHand',
  'RightShoulder','RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase',
  'RightUpLeg','RightLeg','RightFoot','RightToeBase'];
const MAP = {Hips:'Hip', Spine:'Waist', Spine1:'Spine01', Spine2:'Spine02', Neck:'NeckTwist01', Head:'Head',
  LeftShoulder:'L_Clavicle', LeftArm:'L_Upperarm', LeftForeArm:'L_Forearm', LeftHand:'L_Hand',
  RightShoulder:'R_Clavicle', RightArm:'R_Upperarm', RightForeArm:'R_Forearm', RightHand:'R_Hand',
  LeftUpLeg:'L_Thigh', LeftLeg:'L_Calf', LeftFoot:'L_Foot', LeftToeBase:'L_ToeBase',
  RightUpLeg:'R_Thigh', RightLeg:'R_Calf', RightFoot:'R_Foot', RightToeBase:'R_ToeBase'};
const CHILD_OF = {Spine:'Hips', Spine1:'Spine', Spine2:'Spine1', Neck:'Spine2', Head:'Neck', HeadTop_End:'Head',
  LeftShoulder:'Spine2', LeftArm:'LeftShoulder', LeftForeArm:'LeftArm', LeftHand:'LeftForeArm',
  RightShoulder:'Spine2', RightArm:'RightShoulder', RightForeArm:'RightArm', RightHand:'RightForeArm',
  LeftUpLeg:'Hips', LeftLeg:'LeftUpLeg', LeftFoot:'LeftLeg', LeftToeBase:'LeftFoot',
  RightUpLeg:'Hips', RightLeg:'RightUpLeg', RightFoot:'RightLeg', RightToeBase:'RightFoot'};
const PRIMARY = {Hips:'Spine', Spine2:'Neck', Head:'HeadTop_End'};
const ORDER2 = ['Hips','Spine','Spine1','Spine2','Neck','Head','LeftShoulder','LeftArm','LeftForeArm',
  'RightShoulder','RightArm','RightForeArm','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
const V = THREE.Vector3, Q = THREE.Quaternion;
const byName = (r, n) => { let f = null; r.traverse(o => { if (!f && o.name === n) f = o; }); return f; };
// 手（v1.43.0〜）。写真の手と同じ 11 個の数: 指 5 本の曲げ（0〜1）、手の向き（手首→中指の付け根）、手のひらの法線。
// 曲げは「素の姿勢からどれだけ折れたか」を、アプリが曲げ 1 で回す角の和（CURL_K。指は 72+83+54 度、親指は
// 32+43+32 度）で割ったもの。写真は検出の絶対角から出すが、こちらは FBX の数字そのものなので素との差分で出せる。
// 手のひらの側は index.html の handFrame() と同じ「指が曲がる向き」（付け根の骨のローカル X まわり）から決める
const FINGERS = ['Thumb','Index','Middle','Ring','Pinky'];
const CURL_K = {Thumb:[0.55, 0.75, 0.55], Index:[1.25, 1.45, 0.95], Middle:[1.25, 1.45, 0.95], Ring:[1.25, 1.45, 0.95], Pinky:[1.25, 1.45, 0.95]};
function readHand(root, prefix, side){
  const b = n => byName(root, prefix + side + 'Hand' + n), hand = b('');
  const wp = o => o.getWorldPosition(new V());
  if (!hand) return null;
  const P = {}; for (const f of FINGERS) for (let j = 1; j <= 4; j++){ const o = b(f + j); if (!o) return null; P[f + j] = wp(o); }
  const w = wp(hand);
  const ang = (a, b, c) => { const u = b.clone().sub(a), v = c.clone().sub(b); return u.lengthSq() > 1e-10 && v.lengthSq() > 1e-10 ? u.angleTo(v) : 0; };
  const bends = {}; for (const f of FINGERS){ const [a, b2, c, d] = [1,2,3,4].map(j => P[f + j]);
    bends[f] = f === 'Thumb' ? [ang(a, b2, c), ang(b2, c, d)] : [ang(w, a, b2), ang(a, b2, c), ang(b2, c, d)]; }
  const d = P.Middle1.clone().sub(w).normalize();
  const n = new V().crossVectors(P.Index1.clone().sub(w), P.Pinky1.clone().sub(w)).normalize();
  const ix = b('Index1'), ax = new V(1, 0, 0).applyQuaternion(ix.getWorldQuaternion(new Q())).normalize();
  const curlDir = new V().crossVectors(ax, P.Index2.clone().sub(P.Index1).normalize());
  // 折れ方からも（第二関節で指が折れる向き）。骨の軸の流儀が違うリグが来たときに気付けるよう両方返す
  let fold = 0; for (const f of ['Index','Middle','Ring','Pinky']){ const u = P[f + '2'].clone().sub(P[f + '1']).normalize(), v = P[f + '3'].clone().sub(P[f + '2']).normalize(); fold += v.sub(u).dot(n); }
  const axisSign = curlDir.dot(n) < 0 ? -1 : 1;
  return {bends, d, palm: n.clone().multiplyScalar(axisSign), axisSign, fold};
}
// 素の手と姿勢の手から 11 個の数
function handRow(rest, pose){
  if (!rest || !pose) return null;
  const r2 = v => Math.round(v * 100) / 100;
  const curls = FINGERS.map(f => { const K = CURL_K[f].slice(0, pose.bends[f].length), sum = pose.bends[f].reduce((a, v, i) => a + (v - rest.bends[f][i]), 0);
    return r2(Math.min(1, Math.max(0, sum / K.reduce((a, v) => a + v, 0)))); });
  return [...curls, ...pose.d.toArray().map(r2), ...pose.palm.toArray().map(r2)];
}

window.__read = async file => {
  const fbx = await new FBXLoader().loadAsync('/s/' + encodeURIComponent(file));
  fbx.updateMatrixWorld(true);
  const bones = []; fbx.traverse(o => { if (o.isBone) bones.push(o.name); });
  const hips = bones.find(n => /Hips$/.test(n));
  if (!hips) throw new Error('Hips が見つからない: ' + file);
  const prefix = hips.replace(/Hips$/, '');
  const grabHands = () => { fbx.updateMatrixWorld(true); return {L: readHand(fbx, prefix, 'Left'), R: readHand(fbx, prefix, 'Right')}; };
  const grab = () => {
    fbx.updateMatrixWorld(true);
    const pos = {};
    for (const j of JOINTS){ const b = byName(fbx, prefix + j); if (b) pos[j] = b.getWorldPosition(new V()); }
    const miss = JOINTS.filter(j => !pos[j]);
    if (miss.length) throw new Error('骨が足りない: ' + miss.join(','));
    // 腰を原点に、腰から首までを 1 に正規化する。向きしか使わないので大きさは本来自由だが、
    // 数字が揃っていたほうが後で読める
    const o = pos.Hips.clone(), k = 1 / Math.max(1e-6, pos.Neck.distanceTo(pos.Hips));
    return JOINTS.map(j => pos[j].clone().sub(o).multiplyScalar(k).toArray().map(v => +v.toFixed(4)));
  };
  // 読んだままの骨は T ポーズ（バインド姿勢）。姿勢そのものではなく
  // 「素の姿勢からどれだけ回ったか」を出すために、両方を持ち帰る。
  const rest = grab(), restHands = grabHands();
  // Mixamo の書き出しは姿勢が 1 フレームのアニメーションに入っている。
  // C4D 経由のものは骨に焼かれていて、その場合 pose は rest と同じになってしまう。
  const baked = !fbx.animations.length;
  if (!baked){
    const m = new THREE.AnimationMixer(fbx);
    m.clipAction(fbx.animations[0]).play();
    m.setTime(0);
  }
  const pose = grab(), poseHands = grabHands();
  const hands = ['L', 'R'].map(s => handRow(restHands[s], poseHands[s]));
  // 手のひらの側: 骨の軸から出した側と、指の折れ方から出した側が食い違えばログに出す（姿勢の手で見る）
  // 握った手（第二関節が 50 度超）は折れ方の向きが手首の方を向くので見ない
  const palmCheck = ['L', 'R'].map(s => { const h = poseHands[s]; if (!h) return 'none';
    const fist = ['Index','Middle','Ring','Pinky'].some(f => h.bends[f][1] > 50 * Math.PI / 180);
    return fist ? 'fist' : Math.abs(h.fold) < 0.05 ? 'flat' : Math.sign(h.fold) === h.axisSign ? 'ok' : 'differs'; });
  return {rest, pose, baked, hands, palmCheck, handDbg: ['L', 'R'].map(s => poseHands[s] ? {fold: +poseHands[s].fold.toFixed(3), axisSign: poseHands[s].axisSign, bends: Object.fromEntries(Object.entries(poseHands[s].bends).map(([f, a]) => [f, a.map(v => Math.round(v * 180 / Math.PI))]))} : null)};
};

// --- 向き合わせ（index.html の applyPose と同じもの。片方を直したら両方直す） ---
// 腕以外は「素の姿勢からどれだけ回ったか」で合わせる。絶対の向きで合わせると、
// 2 つのリグで骨の置き方が違うところ（足首・首）がそのままズレになる。
// 腕だけは絶対で合わせる。Mixamo は T ポーズ、Tripo は A ポーズで、素の姿勢が
// 同じ意味を持たないため、差分にすると腕が 45 度余計に下がる。
const ABSOLUTE = new Set(['LeftShoulder','LeftArm','LeftForeArm','RightShoulder','RightArm','RightForeArm']);
const frame = (up, side) => {
  const y = up.clone().normalize();
  const x = side.clone().projectOnPlane(y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, new V().crossVectors(x, y).normalize());
};
// 骨の軸まわりのねじれ（index.html の TWIST_REF と同じ）。最短の回転で合わせると
// 腕を真上へ向けるような大きな回転で袖と手のひらが裏返る。肘・膝の曲がる向きと
// 足の向きを目印にして軸まわりで回し直す
const TWIST_REF = {LeftArm:'elbow', RightArm:'elbow', LeftForeArm:'elbow', RightForeArm:'elbow',
  LeftUpLeg:'knee', RightUpLeg:'knee', LeftLeg:'foot', RightLeg:'foot'};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const twistRestRef = (m, d, footDir) =>
  TWIST_REF[m] === 'elbow' ? new V().crossVectors(d, new V(0,0,1))
  : TWIST_REF[m] === 'knee' ? new V().crossVectors(d, new V(0,0,-1))
  : TWIST_REF[m] === 'foot' ? footDir : null;
function twistTargetRef(m, src, fwd){
  const kind = TWIST_REF[m]; if (!kind) return null;
  const side = m.startsWith('Left') ? 'Left' : 'Right';
  const hinge = (a, b, c, dflt) => {
    const u = src[b].clone().sub(src[a]).normalize(), f = src[c].clone().sub(src[b]).normalize();
    const bend = new V().crossVectors(u, f), w = clamp((Math.asin(Math.min(1, bend.length())) * 180 / Math.PI - 8) / 17, 0, 1);
    return bend.normalize().multiplyScalar(w).addScaledVector(new V().crossVectors(u, dflt).normalize(), 1 - w);
  };
  if (kind === 'elbow') return hinge(side + 'Arm', side + 'ForeArm', side + 'Hand', fwd);
  if (kind === 'knee') return hinge(side + 'UpLeg', side + 'Leg', side + 'Foot', fwd.clone().negate());
  if (kind === 'foot') return src[side + 'ToeBase'].clone().sub(src[side + 'Foot']);
  return null;
}
function applyPose(root, flat, restFlat){
  const src = {}, rst = {};
  JOINTS.forEach((j, i) => { src[j] = new V().fromArray(flat[i]); if (restFlat) rst[j] = new V().fromArray(restFlat[i]); });
  const tb = {}; for (const [m, t] of Object.entries(MAP)) tb[m] = byName(root, t);
  const dir = (o, a, b) => o[b] && o[a] ? o[b].clone().sub(o[a]) : null;
  const kidOf = m => PRIMARY[m] || Object.keys(CHILD_OF).find(k => CHILD_OF[k] === m);
  const wp = o => o.getWorldPosition(new V());
  // 目標の向きは「この体の素の向きに、参照元が素から回ったぶんをかけたもの」。
  // 素の向きは親を回す前に控えておく。回した後の値を使うと親の回転を二重に数える。
  root.updateMatrixWorld(true);
  const tgtRest = {}, refLocal = {};
  for (const m of ORDER2) if (tb[m]) tgtRest[m] = new V(0,1,0).applyQuaternion(tb[m].getWorldQuaternion(new Q())).normalize();
  for (const m of ORDER2){
    const bone = tb[m], kid = tb[kidOf(m)]; if (!bone || !kid || !TWIST_REF[m]) continue;
    const side = m.startsWith('Left') ? 'Left' : 'Right', foot = tb[side + 'Foot'], toe = tb[side + 'ToeBase'];
    const ref = twistRestRef(m, wp(kid).sub(wp(bone)).normalize(), foot && toe ? wp(toe).sub(wp(foot)) : null);
    if (ref && ref.lengthSq() > 1e-8) refLocal[m] = ref.normalize().applyQuaternion(bone.getWorldQuaternion(new Q()).invert());
  }
  const fwd = new V().crossVectors(src.LeftUpLeg.clone().sub(src.RightUpLeg), src.Spine.clone().sub(src.Hips)).normalize();
  for (const m of ORDER2){
    const bone = tb[m]; if (!bone) continue;
    const kid = kidOf(m);
    const posed = dir(src, m, kid);
    if (!kid || !posed || posed.lengthSq() < 1e-9) continue;
    const curW = bone.getWorldQuaternion(new Q());
    const have = new V(0,1,0).applyQuaternion(curW).normalize();
    const restDir = restFlat ? dir(rst, m, kid) : null;
    let q;
    if (m === 'Hips' && restDir){
      // 腰は上下だけでは向きが決まらない。左右の軸も使って姿勢ごと回す。
      // 連鎖の根なので curW はまだ素の向きのまま
      const lr = o => o.LeftUpLeg.clone().sub(o.RightUpLeg);
      const R = new THREE.Matrix4().multiplyMatrices(frame(posed, lr(src)), frame(restDir, lr(rst)).transpose());
      q = new Q().setFromRotationMatrix(R).multiply(curW);
    } else {
      let want;
      if (restDir && !ABSOLUTE.has(m)){
        const R = new Q().setFromUnitVectors(restDir.clone().normalize(), posed.clone().normalize());
        want = tgtRest[m].clone().applyQuaternion(R);
      } else {
        want = posed.clone().normalize();
      }
      q = new Q().setFromUnitVectors(have, want.normalize()).multiply(curW);
      const ref = refLocal[m] && twistTargetRef(m, src, fwd);
      if (ref && ref.lengthSq() > 1e-8){
        const axis = want.clone().normalize();
        const has = refLocal[m].clone().applyQuaternion(q).projectOnPlane(axis), to = ref.projectOnPlane(axis);
        if (has.lengthSq() > 1e-8 && to.lengthSq() > 1e-8)
          q = new Q().setFromAxisAngle(axis, Math.atan2(new V().crossVectors(has, to).dot(axis), has.dot(to))).multiply(q);
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
// Box3.setFromObject は骨の変形を見ない。ポーズを付けた体の外形は
// SkinnedMesh.computeBoundingBox() を通さないと取れない（index.html の posedBox と同じ）
function posedBox(root){
  root.updateMatrixWorld(true);
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  root.traverse(n => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    let local;
    if (n.isSkinnedMesh && n.computeBoundingBox){ n.computeBoundingBox(); local = n.boundingBox; }
    if (!local){ if (!n.geometry.boundingBox) n.geometry.computeBoundingBox(); local = n.geometry.boundingBox; }
    if (local) box.union(tmp.copy(local).applyMatrix4(n.matrixWorld));
  });
  return box;
}
window.__shoot = (restFlat, flat) => {
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0xaaaaaa, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1.2, 2.4, 3); sc.add(dl);
  const o = skeletonClone(base);
  o.updateMatrixWorld(true);
  if (flat) applyPose(o, flat, restFlat);
  const bb = posedBox(o);
  o.position.y -= bb.min.y;
  sc.add(o);
  const b2 = posedBox(o);
  // 寝ている姿勢は奥行き方向に長い。縦横の大きさで寄せると小さく写るので、
  // 外接球の半径から距離を出して、どの姿勢でも同じ大きさに収める
  const c = b2.getCenter(new V());
  const rad = b2.getBoundingSphere(new THREE.Sphere()).radius;
  const fov = 26;
  const cam = new THREE.PerspectiveCamera(fov, ${TW}/${TH}, 0.05, 50);
  const dist = rad / Math.sin(fov*Math.PI/360) * 1.02;
  const dirv = new V(0.5, 0.28, 1).normalize();
  cam.position.copy(c).addScaledVector(dirv, dist);
  cam.lookAt(c.x, c.y, c.z);
  r.render(sc, cam);
  return document.getElementById('c').toDataURL('image/webp', 0.82);
};
window.JOINTS_OUT = JOINTS;
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
const out = {version:3, joints:null, rest:null, poses:[]};
const got = {}; let restRef = null;
for (const f of files){
  const key = f.replace(/\.fbx$/i, '');
  const meta = NAMES[key];
  if (!meta) { console.log(`skip  ${f}`); continue; }
  const {rest, pose, baked, hands, palmCheck, handDbg} = await p.evaluate(n => window.__read(n), f);
  if (palmCheck.some(c => c === 'differs')) console.log(`      ! ${f} の手のひらの側が、骨の軸と指の折れ方で食い違う ${palmCheck}`);
  if (!restRef) restRef = rest;
  else if (JSON.stringify(rest) !== JSON.stringify(restRef)) console.log(`      ! ${f} のバインド姿勢が他と違う`);
  if (baked) console.log(`      ! ${f} はアニメーションが無い。素の姿勢が取れないので差分にできない`);
  got[meta.id] = {id: meta.id, label: meta.label, p: pose};
  if (hands.some(Boolean)) got[meta.id].hands = hands; else console.log(`      ! ${f} に指の骨が無い。手は付けない`);
  if (process.argv.includes('--hands')) console.log('      hands', JSON.stringify(hands), JSON.stringify(handDbg));
  const url = await p.evaluate(([r, pz]) => window.__shoot(r, pz), [restRef, pose]);
  const png = path.join(THUMBS, `pose-${meta.id}.webp`);
  fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`ok    ${f}  -> ${meta.id} (${(fs.statSync(png).size/1024).toFixed(1)} KB)`);
}
// 素の姿勢のサムネイルも 1 枚
const plain = await p.evaluate(() => window.__shoot(null, null));
fs.writeFileSync(path.join(THUMBS, 'pose-none.webp'), Buffer.from(plain.split(',')[1], 'base64'));
out.joints = await p.evaluate(() => window.JOINTS_OUT);
out.rest = restRef;
out.poses = ORDER.filter(id => got[id]).map(id => got[id]);
const dst = path.join(MODELS, 'poses.json');
fs.writeFileSync(dst, JSON.stringify(out));
console.log(`\n${out.poses.length} poses -> ${path.relative(ROOT, dst)} ${(fs.statSync(dst).size/1024).toFixed(1)} KB`);
await b.close(); server.close(); process.exit(0);
