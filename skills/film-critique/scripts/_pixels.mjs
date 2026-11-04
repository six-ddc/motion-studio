// check.mjs 的原生分辨率像素统计（像素法律 law.<id>.pixels、分镜断言 source: pixels），在 Node 端算。
//
// 原来的做法是把每帧 PNG 转 base64 送进分析页，createImageBitmap → drawImage（不缩放）→ getImageData 再数像素：
// 一帧 1080×1920 的 PNG 来回编码两次，且分析页是单线程。这里直接在 Node 端解 PNG（zlib + 逐行反滤波）、
// 在 worker_threads 里数，判据函数与原分析页的 A.measure 逐行对应（同一份算术，结果逐位相同——实测见仓库 docs/verified/film-critique.md §11）。
//
// 前提（截图恒满足；不满足就抛错，不静默算错）：8 位、非隔行、RGB 或 RGBA。
// 与浏览器解码等价的条件是不透明：浏览器 getImageData 走预乘 alpha，半透明像素会有舍入；截图的 alpha 恒为 255，
// 解出 alpha < 255 的像素时同样抛错。
import { inflateSync } from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/** PNG → { W, H, d: RGBA Uint8Array } */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8, W = 0, H = 0, depth = 0, ctype = 0, inter = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') { W = buf.readUInt32BE(p + 8); H = buf.readUInt32BE(p + 12); depth = buf[p + 16]; ctype = buf[p + 17]; inter = buf[p + 20]; }
    else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || inter !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error(`PNG 格式不支持（位深 ${depth}、颜色类型 ${ctype}、隔行 ${inter}）：只认 8 位非隔行 RGB/RGBA`);
  const bpp = ctype === 6 ? 4 : 3, stride = W * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const d = new Uint8Array(W * H * 4);
  let q = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[q++];
    const src = raw.subarray(q, q + stride); q += stride;
    if (f === 0) cur.set(src);
    else if (f === 1) { for (let i = 0; i < stride; i++) cur[i] = (src[i] + (i >= bpp ? cur[i - bpp] : 0)) & 255; }
    else if (f === 2) { for (let i = 0; i < stride; i++) cur[i] = (src[i] + prev[i]) & 255; }
    else if (f === 3) { for (let i = 0; i < stride; i++) cur[i] = (src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        cur[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else throw new Error(`PNG 第 ${y} 行滤波类型 ${f} 不认识`);
    const o = y * W * 4;
    if (bpp === 4) {
      d.set(cur, o);
      for (let i = 3; i < stride; i += 4) if (cur[i] !== 255) throw new Error('PNG 有半透明像素：Node 端解码与浏览器预乘 alpha 的结果不保证一致');
    } else for (let x = 0, i = 0, k = o; x < W; x++, i += 3, k += 4) { d[k] = cur[i]; d[k + 1] = cur[i + 1]; d[k + 2] = cur[i + 2]; d[k + 3] = 255; }
    prev.set(cur);
  }
  return { W, H, d };
}

/** 与原分析页 A.measure 同一判据。P = "上一帧"的 RGBA（串行时 mPrev，且 t - mPrevT ≈ step 时才给），否则 null。
 *  spec：{near:"#rrggbb", tol} 或 {r:[lo,hi], g:[lo,hi], b:[lo,hi]}；stat: count | cx | cy | motion；region:[x0,y0,x1,y1] 比例 */
export function measure({ W, H, d }, specs, P) {
  const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return specs.map((sp) => {
    const [x0, y0, x1, y1] = sp.region ?? [0, 0, 1, 1];
    const X0 = Math.floor(x0 * W), Y0 = Math.floor(y0 * H), X1 = Math.ceil(x1 * W), Y1 = Math.ceil(y1 * H);
    if (sp.stat === 'motion') {
      if (!P) return null;
      let n = 0;
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const k = (y * W + x) * 4;
        if (Math.abs(d[k] - P[k]) > 8 || Math.abs(d[k + 1] - P[k + 1]) > 8 || Math.abs(d[k + 2] - P[k + 2]) > 8) n++; }
      return n / ((X1 - X0) * (Y1 - Y0));
    }
    const near = sp.near ? hx(sp.near) : null, tol2 = (sp.tol ?? 40) ** 2;
    let n = 0, sx = 0, sy = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const k = (y * W + x) * 4, R = d[k], G = d[k + 1], B = d[k + 2];
      const hit = near ? (R - near[0]) ** 2 + (G - near[1]) ** 2 + (B - near[2]) ** 2 <= tol2
        : R >= sp.r[0] && R <= sp.r[1] && G >= sp.g[0] && G <= sp.g[1] && B >= sp.b[0] && B <= sp.b[1];
      if (hit) { n++; sx += x; sy += y; } }
    return sp.stat === 'count' ? n : !n ? null : sp.stat === 'cx' ? sx / n / W : sy / n / H;
  });
}

const asBuf = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** 一段连续帧：frames[j] 的"上一帧"是 frames[j-1]（j=0 时是 before），prevOk[j] 为假则 motion 返回 null（同串行的 prevOk）。 */
function measureRun({ frames, before, prevOk, specs }) {
  const needPrev = specs.some((s) => s.stat === 'motion');
  let P = needPrev && before && prevOk[0] ? decodePNG(asBuf(before)).d : null;
  return frames.map((png, j) => {
    const img = decodePNG(asBuf(png));
    const r = measure(img, specs, j === 0 ? P : prevOk[j] ? P : null);
    P = needPrev ? img.d : null;
    return r;
  });
}

if (!isMainThread && workerData?.filmCritiquePixels) {
  parentPort.on('message', ({ id, job }) => {
    try { parentPort.postMessage({ id, out: measureRun(job) }); } catch (e) { parentPort.postMessage({ id, err: String(e.message ?? e) }); }
  });
}

/** n 个 worker 线程。run(job) → 与 job.frames 对齐的结果数组。 */
export function pixelThreads(n) {
  const ws = Array.from({ length: Math.max(1, n) }, () => new Worker(new URL(import.meta.url), { workerData: { filmCritiquePixels: true } }));
  const idle = [...ws], queue = [], waiting = new Map();
  let nextId = 0;
  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop(), { id, job } = queue.shift();
      w.once('message', (m) => { idle.push(w); const cb = waiting.get(m.id); waiting.delete(m.id); m.err ? cb.reject(new Error(m.err)) : cb.resolve(m.out); pump(); });
      w.postMessage({ id, job });
    }
  };
  return {
    size: ws.length,
    run: (job) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); queue.push({ id, job }); pump(); }),
    close: () => Promise.all(ws.map((w) => w.terminate())),
  };
}
