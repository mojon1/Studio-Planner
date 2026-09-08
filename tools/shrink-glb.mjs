// Rebuild the GLB with a smaller base-colour texture. Chromium does the resampling
// because this box has no image tooling; the geometry chunks are copied untouched.
import { chromium } from 'playwright';
import fs from 'node:fs';
const [,, src, dst, sizeStr, qStr] = process.argv;
const size = +sizeStr, q = +qStr;
const d = fs.readFileSync(src);
const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
let off = 12; const chunks = [];
while (off < d.length){ const len = dv.getUint32(off, true), type = d.toString('ascii', off+4, off+8); chunks.push({type, start: off+8, len}); off += 8 + len; }
const j = JSON.parse(d.toString('utf8', chunks[0].start, chunks[0].start + chunks[0].len));
const BIN = chunks[1].start;
const imgBV = j.images[0].bufferView;
const bvBytes = j.bufferViews.map(bv => d.subarray(BIN + (bv.byteOffset||0), BIN + (bv.byteOffset||0) + bv.byteLength));

const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const p = await (await b.newContext()).newPage();
const b64 = bvBytes[imgBV].toString('base64');
const out = await p.evaluate(async ([b64, size, q]) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/jpeg;base64,' + b64; });
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, size, size);
  return {orig:[img.width, img.height], url: c.toDataURL('image/jpeg', q)};
}, [b64, size, q]);
await b.close();
const newImg = Buffer.from(out.url.split(',')[1], 'base64');
console.log(`texture ${out.orig.join('x')} ${(bvBytes[imgBV].length/1024).toFixed(0)} KB -> ${size}x${size} ${(newImg.length/1024).toFixed(0)} KB`);
bvBytes[imgBV] = newImg;

// re-lay the BIN chunk, 4-byte aligned, and rewrite every bufferView offset
const parts = []; let cur = 0;
j.bufferViews.forEach((bv, i) => {
  while (cur % 4) { parts.push(Buffer.alloc(1)); cur++; }
  bv.byteOffset = cur; bv.byteLength = bvBytes[i].length;
  parts.push(bvBytes[i]); cur += bvBytes[i].length;
});
while (cur % 4) { parts.push(Buffer.alloc(1)); cur++; }
const bin = Buffer.concat(parts);
j.buffers = [{byteLength: bin.length}];
let js = Buffer.from(JSON.stringify(j), 'utf8');
while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4E4F534A, 4);
const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004E4942, 4);
fs.writeFileSync(dst, Buffer.concat([head, jc, js, bc, bin]));
console.log(`${src} ${(d.length/1024/1024).toFixed(2)} MB -> ${dst} ${(fs.statSync(dst).size/1024/1024).toFixed(2)} MB`);
