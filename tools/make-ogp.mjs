import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import zlib from 'node:zlib';
const ROOT = '/home/user/Osmo360_AdobePlugin/studio3d', NM = ROOT + '/test/node_modules';
const enc = st => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(st))).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const state = {meta:{project:'',cut:'',memo:'',frames:{}}, studio:{w:8,d:6,h:3.6,cove:{back:true,left:true,right:true}}, activeCam:'c1', items:[
  {id:'p1',type:'person',x:-0.2,z:-0.3,rot:6,height:1.75,pose:'stand',look:'real'},
  {id:'c1',type:'camera',x:0.3,z:2.4,y:1.35,rot:182,pitch:-3,sensor:'ff',focal:50,aspect:'16:9'},
  {id:'l1',type:'light',x:-2.2,z:1.2,y:2.4,rot:150,dim:false},
  {id:'l2',type:'light',x:2.7,z:2.4,y:2.3,rot:214,dim:false},
  {id:'w1',type:'mirror',x:1.7,z:0.5,rot:0,kind:'water',w:2.6,h:2.2,dim:false},
]};
http.createServer((q,s)=>{const p=path.join(ROOT,q.url==='/'?'index.html':q.url.split('?')[0].split('#')[0]);
  if(!fs.existsSync(p)){s.writeHead(404);s.end();return;}
  s.writeHead(200,{'content-type':p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.glb')?'model/gltf-binary':'text/javascript'});
  s.end(fs.readFileSync(p));}).listen(8770);
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'], env:{...process.env, LANG:'C.UTF-8'} });
const p = await (await b.newContext({viewport:{width:1200,height:630}, deviceScaleFactor:1})).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', r => {
  const f = path.join(NM,'three', r.request().url().replace('https://cdn.jsdelivr.net/npm/three@0.180.0/',''));
  fs.existsSync(f) ? r.fulfill({body:fs.readFileSync(f),contentType:'text/javascript'}) : r.fulfill({status:404});});
await p.route('https://fonts.googleapis.com/**', r => r.fulfill({body:'',contentType:'text/css'}));
await p.goto('http://localhost:8770/#s=' + enc(state));
await p.waitForTimeout(2500);
await p.click('[data-view="pers"]');
await p.waitForTimeout(1200);
await p.click('#pipbtn');            // the camera window off, so the room is the picture
await p.click('#gear');              // fold the settings panel
await p.waitForTimeout(600);
await p.evaluate(() => {             // nudge the orbit to a friendlier angle
  const sp = window.__sp; document.getElementById('addfab').style.visibility='hidden';
  document.getElementById('gear').style.visibility='hidden';
  document.getElementById('viewbtns').style.visibility='hidden';
});
await p.mouse.move(150, 140); await p.mouse.down(); await p.mouse.move(222, 162, {steps:10}); await p.mouse.up();   // start on empty space so nothing gets picked up
await p.waitForTimeout(400); await p.mouse.wheel(0, -420);
await p.waitForTimeout(2500);
await p.locator('#view').screenshot({path: ROOT + '/ogp.png'});
await b.close(); process.exit(0);
