// 版を上げる。コロフォン（index.html）と Service Worker の VERSION（sw.js）を同時に書き換える。
//   node tools/bump.mjs 1.34.2        両方を 1.34.2 にする（今より小さい版は拒む）
//   node tools/bump.mjs --check       両方が同じ版かだけ確かめる（テストも同じことを見ている）
// 片方だけ上げると、古い殻（SW）が居座って直したものが端末に出ない（やってはいけないこと 25）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDX = path.join(ROOT, 'index.html'), SW = path.join(ROOT, 'sw.js');
const RE_IDX = /(<p class="colophon">.*?Studio Planner v)(\d+\.\d+\.\d+)/, RE_SW = /(const VERSION = 'v)(\d+\.\d+\.\d+)(')/;
const idx = fs.readFileSync(IDX, 'utf8'), sw = fs.readFileSync(SW, 'utf8');
const cur = idx.match(RE_IDX)?.[2], swv = sw.match(RE_SW)?.[2];
if (!cur || !swv){ console.error('version not found', {cur, swv}); process.exit(2); }
const arg = process.argv[2];
if (!arg || arg === '--check'){
  console.log(`index.html ${cur}  sw.js ${swv}  ${cur === swv ? 'OK' : 'MISMATCH'}`);
  process.exit(cur === swv ? 0 : 1);
}
if (!/^\d+\.\d+\.\d+$/.test(arg)){ console.error('usage: node tools/bump.mjs X.Y.Z'); process.exit(2); }
const num = v => v.split('.').map(Number);
const gt = (a, b) => { const [x, y] = [num(a), num(b)]; for (let i = 0; i < 3; i++){ if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
if (!gt(arg, cur)){ console.error(`refusing: ${arg} is not newer than ${cur}`); process.exit(1); }
if ((idx.match(/Studio Planner v\d+\.\d+\.\d+/g) || []).length !== 1){ console.error('expected exactly one colophon version in index.html'); process.exit(2); }
fs.writeFileSync(IDX, idx.replace(RE_IDX, `$1${arg}`));
fs.writeFileSync(SW, sw.replace(RE_SW, `$1${arg}$3`));
console.log(`${cur} -> ${arg}  (index.html, sw.js)`);
