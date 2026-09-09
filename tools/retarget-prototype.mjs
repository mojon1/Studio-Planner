// 別リグのポーズを Tripo のリグに移せるか試す。
// 骨の名前も本数も違い、参照元の素の姿勢（T ポーズ）も手元に無いので、
// 回転をそのまま写すことはできない。代わりに「骨の向き」を合わせる:
// 親から順に、その骨から子へ向かうワールド方向が参照元と一致するように回す。
// 骨の長さもリグの初期姿勢も関係なくなるので、この 2 つが違っても通る。
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const NM = '/home/user/Osmo360_AdobePlugin/studio3d/test/node_modules';
const MODELS = '/home/user/Osmo360_AdobePlugin/studio3d/models';
const S = '/tmp/claude-0/-home-user-Osmo360-AdobePlugin/48d9bd61-b204-5f58-b94d-c3c4b5cc9328/scratchpad';
const GLB = process.argv[2] || 'asia-business-man.glb';
const OUT = process.argv[3] || `${S}/pose.png`;
const html = `<canvas id=c width=1000 height=620></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// Mixamo 系 -> Tripo。ひねり用の骨（*Twist*）は写さず、そのままにする。
const MAP = {
  Hips:'Hip', Spine:'Waist', Spine1:'Spine01', Spine2:'Spine02', Neck:'NeckTwist01', Head:'Head',
  LeftShoulder:'L_Clavicle', LeftArm:'L_Upperarm', LeftForeArm:'L_Forearm', LeftHand:'L_Hand',
  RightShoulder:'R_Clavicle', RightArm:'R_Upperarm', RightForeArm:'R_Forearm', RightHand:'R_Hand',
  LeftUpLeg:'L_Thigh', LeftLeg:'L_Calf', LeftFoot:'L_Foot', LeftToeBase:'L_ToeBase',
  RightUpLeg:'R_Thigh', RightLeg:'R_Calf', RightFoot:'R_Foot', RightToeBase:'R_ToeBase',
};
// 枝分かれする骨は、どの子で向きを決めるかを決めておく
const PRIMARY = {Hips:'Spine', Spine2:'Neck', Neck:'Head', LeftHand:null, RightHand:null, LeftToeBase:null, RightToeBase:null, Head:null};
const CHILD_OF = {Spine:'Hips', Spine1:'Spine', Spine2:'Spine1', Neck:'Spine2', Head:'Neck',
  LeftShoulder:'Spine2', LeftArm:'LeftShoulder', LeftForeArm:'LeftArm', LeftHand:'LeftForeArm',
  RightShoulder:'Spine2', RightArm:'RightShoulder', RightForeArm:'RightArm', RightHand:'RightForeArm',
  LeftUpLeg:'Hips', LeftLeg:'LeftUpLeg', LeftFoot:'LeftLeg', LeftToeBase:'LeftFoot',
  RightUpLeg:'Hips', RightLeg:'RightUpLeg', RightFoot:'RightLeg', RightToeBase:'RightFoot'};

const V = THREE.Vector3, Q = THREE.Quaternion;
const byName = (root, n) => { let f = null; root.traverse(o => { if (!f && o.name === n) f = o; }); return f; };
const wpos = o => o.getWorldPosition(new V());

function alignTo(bone, wantDir, rollFrom, rollTo){
  const parent = bone.parent;
  const curW = bone.getWorldQuaternion(new Q());
  // 骨のローカル +Y が子の方向。今どこを向いているかを出す
  const haveDir = new V(0,1,0).applyQuaternion(curW).normalize();
  let q = new Q().setFromUnitVectors(haveDir, wantDir.clone().normalize());
  let want = q.multiply(curW);
  if (rollFrom && rollTo){                              // 軸まわりのひねりも合わせる
    const axis = wantDir.clone().normalize();
    const proj = v => v.clone().projectOnPlane(axis).normalize();
    const a = proj(rollFrom.clone().applyQuaternion(want)), b = proj(rollTo);
    if (a.lengthSq() > 1e-6 && b.lengthSq() > 1e-6){
      let ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      if (a.clone().cross(b).dot(axis) < 0) ang = -ang;
      want = new Q().setFromAxisAngle(axis, ang).multiply(want);
    }
  }
  const pw = parent.getWorldQuaternion(new Q()).invert();
  bone.quaternion.copy(pw.multiply(want));
  bone.updateMatrixWorld(true);
}

const fbx = await new FBXLoader().loadAsync('/f/suwaru01.fbx');
fbx.updateMatrixWorld(true);
const src = {};
for (const m of Object.keys(MAP)){
  const b = byName(fbx, 'mocaprig_' + m);
  if (b) src[m] = wpos(b);
}
const missing = Object.keys(MAP).filter(m => !src[m]);

const gltf = await new GLTFLoader().loadAsync('/m/' + ${JSON.stringify(GLB)});
const rest = gltf.scene;
const posed = skeletonClone(rest);
posed.updateMatrixWorld(true);
const tb = {};
for (const [m, t] of Object.entries(MAP)) tb[m] = byName(posed, t);
const noTarget = Object.entries(MAP).filter(([m]) => !tb[m]).map(([m,t]) => \`\${m}->\${t}\`);

// 親から順に。子の位置は親を直した後で読む
const ORDER = ['Hips','Spine','Spine1','Spine2','Neck','Head',
  'LeftShoulder','LeftArm','LeftForeArm','RightShoulder','RightArm','RightForeArm',
  'LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
const done = [];
for (const m of ORDER){
  const bone = tb[m]; if (!bone) continue;
  const kid = PRIMARY[m] !== undefined ? PRIMARY[m] : Object.keys(CHILD_OF).find(k => CHILD_OF[k] === m);
  if (!kid || !src[m] || !src[kid]) continue;
  const want = src[kid].clone().sub(src[m]);
  if (want.lengthSq() < 1e-9) continue;
  // 腰と胸は、左右の軸も合わせないと向きが決まらない
  let rollFrom = null, rollTo = null;
  if (m === 'Hips' && src.LeftUpLeg && src.RightUpLeg){
    rollFrom = new V(1,0,0);
    rollTo = src.LeftUpLeg.clone().sub(src.RightUpLeg);
    const L = wpos(tb.LeftUpLeg).sub(wpos(tb.RightUpLeg));
    rollFrom = L.applyQuaternion(bone.getWorldQuaternion(new Q()).invert());
  }
  alignTo(bone, want, rollFrom, rollTo);
  done.push(m);
}
posed.updateMatrixWorld(true);

// 足が床に着くように落とす
const bb = new THREE.Box3().setFromObject(posed);
posed.position.y -= bb.min.y;
posed.updateMatrixWorld(true);
const bb2 = new THREE.Box3().setFromObject(posed);

// 元の姿勢と並べる
const sc = new THREE.Scene();
sc.background = new THREE.Color(0x20232a);
sc.add(new THREE.HemisphereLight(0xffffff,0x999999,1.5));
const dl = new THREE.DirectionalLight(0xffffff,1.4); dl.position.set(1.5,3,3); sc.add(dl);
rest.position.x = -0.45; posed.position.x = 0.45;
sc.add(rest, posed);
const grid = new THREE.GridHelper(3, 12, 0x556, 0x3a3f48); sc.add(grid);
const r = new THREE.WebGLRenderer({canvas:document.getElementById('c'), antialias:true});
const cam = new THREE.PerspectiveCamera(30, 1000/620, 0.05, 50);
cam.position.set(0.9, 0.75, 2.7); cam.lookAt(0, 0.55, 0);
r.render(sc, cam);
window.__out = {missing, noTarget, done, hips: src.Hips ? src.Hips.toArray().map(v => +v.toFixed(1)) : null,
  posedSize: new THREE.Vector3().subVectors(bb2.max, bb2.min).toArray().map(v => +v.toFixed(3))};
window.__done = true;
</script>`;
http.createServer((q,s)=>{
  if (q.url === '/') { s.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return s.end(html); }
  for (const [pre, dir] of [['/f/', S], ['/m/', MODELS]])
    if (q.url.startsWith(pre)) { const p = path.join(dir, decodeURIComponent(q.url.slice(3)));
      if (fs.existsSync(p)) { s.writeHead(200,{'content-type':'application/octet-stream'}); return s.end(fs.readFileSync(p)); } }
  const f = path.join(NM, q.url.replace(/^\/three\//,'three/'));
  if (fs.existsSync(f)) { s.writeHead(200,{'content-type':'text/javascript'}); return s.end(fs.readFileSync(f)); }
  s.writeHead(404); s.end();
}).listen(8776);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({viewport:{width:1000,height:620}})).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8776/');
await p.waitForFunction(() => window.__done, null, {timeout:120000});
console.log(JSON.stringify(await p.evaluate(() => window.__out), null, 1));
await p.locator('#c').screenshot({path: OUT});
await b.close(); process.exit(0);
