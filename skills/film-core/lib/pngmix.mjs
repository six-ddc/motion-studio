// film-core lib · 子帧平均（自适应运动模糊路径用）：把同一个输出帧的 n 张子帧 PNG 解码、逐像素整数平均，返回原始像素。
//
// 为什么不用 tmix：tmix 的窗口是固定的 frames=N，自适应路径每个输出帧的子帧数不同（1–48），
// 一条 ffmpeg 流水线表达不了。固定 sub 的路径仍走 tmix，不经过这里——没声明 MOTION 的片子输出因此一个字节都不变。
//
// 平均在 sRGB 编码值上做（与 tmix 同一个空间），取整 = floor((Σ + ⌊n/2⌋) / n)：n 张相同的图平均后逐字节等于原图，
// 所以"静止帧只截一张"与"截 n 张再平均"在这条路径上逐像素一致。
// 解码放在 worker_threads 里：截图在浏览器里并行，解码若留在主线程就会成为所有 worker 共享的串行瓶颈。
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';

// 只支持 Chromium 截图产出的那一类：8 位、RGB/RGBA、非隔行。别的格式直接报错，不猜。
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8, w = 0, h = 0, ch = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      const depth = d[8], ct = d[9], il = d[12];
      if (depth !== 8 || il !== 0 || (ct !== 2 && ct !== 6)) throw new Error(`pngmix 只支持 8 位非隔行 RGB/RGBA PNG（收到 depth=${depth} colorType=${ct} interlace=${il}）`);
      ch = ct === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, o = y * stride, up = o - stride;
    if (f === 0) out.set(raw.subarray(src, src + stride), o);
    else if (f === 1) for (let x = 0; x < stride; x++) out[o + x] = raw[src + x] + (x >= ch ? out[o + x - ch] : 0);
    else if (f === 2) for (let x = 0; x < stride; x++) out[o + x] = raw[src + x] + (y ? out[up + x] : 0);
    else if (f === 3) for (let x = 0; x < stride; x++) out[o + x] = raw[src + x] + (((x >= ch ? out[o + x - ch] : 0) + (y ? out[up + x] : 0)) >> 1);
    else if (f === 4) for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0, b = y ? out[up + x] : 0, c = x >= ch && y ? out[up + x - ch] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      out[o + x] = raw[src + x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
    else throw new Error(`PNG 行过滤器 ${f} 不合法`);
  }
  return { w, h, ch, data: out };
}

export function mixPngs(pngs) {
  const first = decodePng(pngs[0]);
  const n = pngs.length;
  if (n === 1) return first;
  const sum = new Uint32Array(first.data.length);
  for (let i = 0; i < sum.length; i++) sum[i] = first.data[i];
  for (let k = 1; k < n; k++) {
    const f = decodePng(pngs[k]);
    if (f.w !== first.w || f.h !== first.h || f.ch !== first.ch) throw new Error('同一输出帧的子帧尺寸/通道数不一致');
    const d = f.data;
    for (let i = 0; i < sum.length; i++) sum[i] += d[i];
  }
  const half = n >> 1, out = first.data;
  for (let i = 0; i < sum.length; i++) out[i] = Math.floor((sum[i] + half) / n);
  return first;
}

if (!isMainThread && parentPort) {
  parentPort.on('message', ({ id, pngs }) => {
    try {
      const r = mixPngs(pngs.map((u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength)));
      parentPort.postMessage({ id, w: r.w, h: r.h, ch: r.ch, data: r.data }, [r.data.buffer]);
    } catch (e) { parentPort.postMessage({ id, error: String(e?.stack ?? e) }); }
  });
}

// 线程池：mix(pngs) → Promise<{w,h,ch,data}>。close() 结束所有线程。
export function mixPool(size) {
  const ws = Array.from({ length: Math.max(1, size) }, () => new Worker(new URL(import.meta.url)));
  const idle = [...ws], queue = [], pending = new Map();
  let seq = 0;
  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.pop(), job = queue.shift();
      pending.set(job.id, { ...job, w });
      w.postMessage({ id: job.id, pngs: job.pngs });
    }
  };
  for (const w of ws) {
    w.on('message', (m) => {
      const job = pending.get(m.id); pending.delete(m.id); idle.push(w);
      if (m.error) job.no(new Error(m.error)); else job.ok({ w: m.w, h: m.h, ch: m.ch, data: Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength) });
      pump();
    });
    w.on('error', (e) => { for (const j of pending.values()) if (j.w === w) j.no(e); });
  }
  return {
    mix: (pngs) => new Promise((ok, no) => { queue.push({ id: seq++, pngs, ok, no }); pump(); }),
    close: () => Promise.all(ws.map((w) => w.terminate())),
  };
}
