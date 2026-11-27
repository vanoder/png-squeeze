// png-squeeze-01 entry: lossless re-encode of each /input/<id>/image.png
// screenshot, as small as we can make it in one 60 s run over 8 instances.
//
// Strategy (score = 1000 x (floor - bytes)/(floor - target) per instance):
//  1. Colour-type reductions that stay lossless and decoder-legal:
//     - <= 256 distinct RGBA colours: palette (colour type 3, with tRNS)
//     - all pixels grey and opaque: colour type 0
//     - all pixels opaque: try RGB (colour type 2) beside RGBA, keep the smaller
//  2. Best PNG filter per row: try a greedy min-sum (and min-square) choice
//     plus the five uniform schemes; deflate each, keep the smallest.
//  3. Deflate with node:zlib at level 9 over all five strategies, memLevel 9.
// Output is written with our own chunk writer producing exactly the chunk set
// the contest's decoder accepts (IHDR, PLTE, tRNS, IDAT, IEND; bit depth 8).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- PNG chunk writer (legal chunk set only) ----------
function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  d[8] = 8;             // bit depth
  d[9] = colourType;    // 0 grey, 2 RGB, 3 palette, 6 RGBA
  d[12] = 0;            // no interlace
  return d;
}
function png(chunks) {
  const head = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = head.length + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let pos = head.length;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ---------- decode the stored input PNG (any legal type, filter byte 0) ----------
function decodeStored(bytes) {
  let pos = 8;
  let width = 0, height = 0, colourType = 6, bitDepth = 8;
  const idat = [];
  let palette = null, trns = null;
  while (pos < bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0); height = d.getUint32(4);
      bitDepth = data[8]; colourType = data[9];
      if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth);
      if (data[12] !== 0) throw new Error('interlaced');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const samples = { 0: 1, 2: 3, 3: 1, 6: 4 }[colourType];
  if (!samples) throw new Error('colour type ' + colourType);
  const stride = width * samples;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(1 + y * (stride + 1), 1 + y * (stride + 1) + stride); // skip the filter byte (always 0, stored)
    const cur = rgba.subarray(y * width * 4, (y + 1) * width * 4);
    if (colourType === 6) cur.set(row);
    else if (colourType === 2) {
      for (let x = 0; x < width; x++) { cur[x*4] = row[x*3]; cur[x*4+1] = row[x*3+1]; cur[x*4+2] = row[x*3+2]; cur[x*4+3] = 255; }
    } else if (colourType === 0) {
      for (let x = 0; x < width; x++) { cur[x*4] = cur[x*4+1] = cur[x*4+2] = row[x]; cur[x*4+3] = 255; }
    } else {
      for (let x = 0; x < width; x++) {
        const pi = row[x] * 3;
        cur[x*4] = palette[pi]; cur[x*4+1] = palette[pi+1]; cur[x*4+2] = palette[pi+2];
        cur[x*4+3] = trns && row[x] < trns.length ? trns[row[x]] : 255;
      }
    }
  }
  return { rgba, width, height };
}

// ---------- filters ----------
function filterCandidates(rgba, width, height, bpp) {
  const stride = width * bpp;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    const out = [];
    for (let f = 0; f < 5; f++) {
      const fr = new Uint8Array(stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = up ? up[x] : 0;
        const c = up && x >= bpp ? up[x - bpp] : 0;
        let v;
        if (f === 0) v = row[x];
        else if (f === 1) v = row[x] - a;
        else if (f === 2) v = row[x] - b;
        else if (f === 3) v = row[x] - ((a + b) >> 1);
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = row[x] - pred;
        }
        fr[x] = v & 0xff;
      }
      out.push(fr);
    }
    rows.push(out);
  }
  return rows;
}

function applyChoices(cands, choices, stride) {
  const raw = new Uint8Array((stride + 1) * cands.length);
  let pos = 0;
  for (let y = 0; y < cands.length; y++) {
    raw[pos++] = choices[y];
    raw.set(cands[y][choices[y]], pos);
    pos += stride;
  }
  return raw;
}

function greedyChoices(cands, stride, square) {
  const out = [];
  for (const row of cands) {
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let s = 0;
      const r = row[f];
      for (let x = 0; x < stride; x++) {
        const v = r[x] < 128 ? r[x] : 256 - r[x];
        s += square ? v * v : v;
      }
      if (s < bestSum) { bestSum = s; best = f; }
    }
    out.push(best);
  }
  return out;
}

function smallestPng(rgba, width, height, colourType, palette, trns) {
  const bpp = colourType === 3 || colourType === 0 ? 1 : colourType === 2 ? 3 : 4;
  const stride = width * bpp;
  const cands = filterCandidates(rgba, width, height, bpp);

  const schemes = [greedyChoices(cands, stride, false), greedyChoices(cands, stride, true)];
  for (const f of [0, 1, 2, 3, 4]) schemes.push(new Array(height).fill(f));
  const seen = new Set();
  let best = null;
  for (const scheme of schemes) {
    const key = scheme.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = applyChoices(cands, scheme, stride);
    for (const strategy of [0, 1, 2, 3, 4]) {
      const z = deflateSync(raw, { chunkSize: 32 * 1024, level: 9, strategy, memLevel: 9 });
      if (!best || z.length < best.length) best = z;
    }
  }
  const chunks = [chunk('IHDR', ihdr(width, height, colourType))];
  if (palette) {
    chunks.push(chunk('PLTE', palette));
    if (trns) chunks.push(chunk('tRNS', trns));
  }
  chunks.push(chunk('IDAT', best));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return png(chunks);
}

// ---------- colour analysis & lossless reductions ----------
function analyze(rgba) {
  let distinct = 0, grey = true, opaque = true;
  const set = new Set();
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    if (!set.has(key)) { set.add(key); distinct++; counts.set(key, 1); }
    else counts.set(key, counts.get(key) + 1);
  }
  return { distinct, grey, opaque, set, counts };
}

function paletteOf(set, counts) {
  // Most frequent colour first: common pixels get small indices, which makes
  // the filtered index stream compress better than an arbitrary order.
  const entries = [...set].sort((a, b) => (counts.get(b) - counts.get(a)) || (a - b));
  const plte = new Uint8Array(entries.length * 3);
  const trns = new Uint8Array(entries.length);
  const index = new Map();
  entries.forEach((k, i) => {
    plte[i * 3] = (k >>> 24) & 0xff;
    plte[i * 3 + 1] = (k >>> 16) & 0xff;
    plte[i * 3 + 2] = (k >>> 8) & 0xff;
    trns[i] = k & 0xff;
    index.set(k, i);
  });
  return { plte, trns, index };
}

function packIndexed(rgba, width, height, pal) {
  const idx = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    idx[p] = pal.index.get((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]);
  }
  return idx;
}

// ---------- main: one 60 s budget over the whole set ----------
for (const id of readdirSync(I).sort()) {
  const bytes = readFileSync(join(I, id, 'image.png'));
  const { rgba, width, height } = decodeStored(bytes);
  const info = analyze(rgba);
  const t0 = Date.now();

  let answer;
  if (info.distinct <= 256) {
    const pal = paletteOf(info.set, info.counts);
    const idx = packIndexed(rgba, width, height, pal);
    answer = smallestPng(idx, width, height, 3, pal.plte, pal.trns);
    if (info.grey && info.opaque) {
      const grey = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) grey[p] = rgba[i];
      const g = smallestPng(grey, width, height, 0, null, null);
      if (g.length < answer.length) answer = g;
    }
  } else if (info.grey && info.opaque) {
    const grey = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) grey[p] = rgba[i];
    answer = smallestPng(grey, width, height, 0, null, null);
  } else if (info.opaque) {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) { rgb[p] = rgba[i]; rgb[p + 1] = rgba[i + 1]; rgb[p + 2] = rgba[i + 2]; }
    const a = smallestPng(rgb, width, height, 2, null, null);
    const b = smallestPng(rgba, width, height, 6, null, null);
    answer = a.length < b.length ? a : b;
  } else {
    answer = smallestPng(rgba, width, height, 6, null, null);
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), answer);
  console.error(`${id}: ${info.distinct} colours, grey=${info.grey}, opaque=${info.opaque} -> ${answer.length} bytes in ${Date.now() - t0} ms`);
}
