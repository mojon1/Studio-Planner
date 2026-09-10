// Studio Planner のオフライン用。現場は電波が無いことがあるので、一度開いた端末では
// 圏外でも同じものが開くようにする。
//
// 3 つだけ守っている。
//  1. index.html は必ずネットワークを先に見る（古い版が焼き付くと直しようがない）。
//  2. 人物と車のモデル（合計 12 MB ほど）は勝手に取りに行かない。共有パネルの
//     「オフラインに保存」を押した人ぶんだけ、使ったものを溜める。
//  3. 版を上げるときは VERSION を変える。古い殻のキャッシュは activate で捨てる。
const VERSION = 'v1.11.0';
const SHELL = 'sp-shell-' + VERSION;   // 起動に要るもの。版ごとに作り直す
const RUNTIME = 'sp-runtime';          // 使ったものを溜める場所。版をまたいで残す

const SHELL_FILES = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable.png',
  './models/poses.json'
];
// three 本体と、起動時に必ず読む addon。CDN が落ちていても install は止めない。
const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/objects/Reflector.js',
  'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/utils/SkeletonUtils.js'
];
const CACHEABLE_HOST = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await c.addAll(SHELL_FILES);
    await Promise.allSettled(CDN_FILES.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k.startsWith('sp-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function fromCache(req){
  return (await caches.match(req, {ignoreSearch: false})) || null;
}
async function keep(req, res){
  if (res && res.ok && res.type !== 'opaque') (await caches.open(RUNTIME)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_HOST.test(req.url)) return;   // それ以外は素通し

  // 画面そのものはネットワーク優先。圏外のときだけ控えを出す。
  if (req.mode === 'navigate'){
    e.respondWith((async () => {
      try { return await keep(req, await fetch(req)); }
      catch { return (await fromCache(req)) || (await caches.match('./index.html')) || Response.error(); }
    })());
    return;
  }
  // 残りはキャッシュ優先。無ければ取りに行って溜める。
  e.respondWith((async () => {
    const hit = await fromCache(req);
    if (hit) return hit;
    try { return await keep(req, await fetch(req)); }
    catch { return Response.error(); }
  })());
});

// ページからの「これも溜めておいて」
self.addEventListener('message', e => {
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
});
