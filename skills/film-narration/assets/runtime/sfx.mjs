// 代码合成音效：纯函数，浏览器和 Node 都能 import（不依赖 node:fs）。
// 场景里可以 import 它做 WebAudio 预听；成片音效由 scripts/sfx.mjs 调它离线渲成 WAV。
//
// 合成音的代价：零授权风险、可按 t 精确摆放、可重复；但 UI 点击这类「真实物件声」
// 合成出来听着廉价。转场 whoosh、低频 thump、tick 用合成足够；需要质感时用素材
// （cues 里写 file，见 scripts/sfx.mjs）。

import { expandRecipes, RECIPES, planTails, makeIR, convolve, muffleCurve, applyMuffle, duckCurve, applyMaster } from './sfxdsp.mjs';
// 分层配方、DSP 基元、程序化空间与总线处理在 sfxdsp.mjs；这里转导出，片子和脚本只认 sfx.mjs 一个入口
export { RECIPES, expandRecipes, renderRecipe, stats, duckCurve, muffleCurve, applyMuffle, makeIR, planTails } from './sfxdsp.mjs';

export const RATE = 48000;
const TAU = Math.PI * 2;
const env = (t, len, k) => Math.exp(-k * t) * (t < len ? 1 : 0);

// 种子噪声：每个事件用自己的种子，渲染顺序不影响结果（cue 增删不会让别的 cue 变声）
function noise(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2147483648) - 1;
}

// 每个音色：[时长秒, (t, rnd) -> 样本]
export const SOUNDS = {
  click:  [0.05, (t) => 0.50 * Math.sin(TAU * 1800 * t) * env(t, 0.05, 90)],
  pop:    [0.15, (t) => 0.40 * Math.sin(TAU * (600 + 900 * t) * t) * env(t, 0.15, 30)],
  thump:  [0.50, (t) => 0.90 * Math.sin(TAU * (90 - 60 * t) * t) * env(t, 0.50, 9)],
  whoosh: [0.35, (t, r) => 0.25 * r() * Math.sin(Math.PI * Math.min(1, t / 0.35))],
  tick:   [0.03, (t, r) => 0.35 * r() * env(t, 0.03, 220)],
  chime:  [0.70, (t) => 0.30 * (Math.sin(TAU * 880 * t) + 0.5 * Math.sin(TAU * 1320 * t)) * env(t, 0.70, 5)],
  sweep:  [0.60, (t) => 0.22 * Math.sin(TAU * (200 + 1400 * (t / 0.6) ** 2) * t) * env(t, 0.60, 4)],
  // 连续层的原料，不是一个设计好的声音：配 cue 的 dur + lowpass / gain 曲线才成风声、摩擦声（见 renderStereo）
  noise:  [1.00, (t, r) => 0.5 * r()],
};

/** cues: [{ t, type, gain? , seed? }] 或已解码的 { t, samples:Float32Array, gain? } -> Float32Array */
export function renderCues(cues, { tail = 0.5, length = 0 } = {}) {
  cues = expandRecipes(cues, { sounds: SOUNDS });   // type 是配方名的 cue 先渲成 samples；其余 cue 原样（同一个对象）
  const lenOf = (c) => c.samples ? c.samples.length / RATE : (SOUNDS[c.type]?.[0] ?? 0);
  const last = cues.reduce((m, c) => Math.max(m, c.t + lenOf(c)), 0);
  const mix = new Float32Array(Math.ceil(Math.max(length, last + tail) * RATE));
  cues.forEach((cue, idx) => {
    const gain = cue.gain ?? 1;
    const first = Math.round(cue.t * RATE);
    if (cue.samples) {
      for (let n = 0; n < cue.samples.length && first + n < mix.length; n++) mix[first + n] += gain * cue.samples[n];
      return;
    }
    const voice = SOUNDS[cue.type];
    if (!voice) throw new Error(`未知音效类型 ${cue.type}，可选 ${Object.keys(SOUNDS).join(' ')}`);
    const [len, sample] = voice;
    const rnd = noise(cue.seed ?? (idx + 1) * 2654435761);
    for (let n = 0; n < len * RATE && first + n < mix.length; n++) mix[first + n] += gain * sample(n / RATE, rnd);
  });
  return mix;
}

/** Float32Array -> 16bit 单声道 WAV 的 Uint8Array */
export function toWav(mix) {
  const bytes = mix.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
  for (let n = 0; n < mix.length; n++) v.setInt16(44 + n * 2, Math.round(Math.max(-1, Math.min(1, mix[n])) * 32767), true);
  return new Uint8Array(buf);
}

// ───────────────────────── 立体声混音器（可选能力） ─────────────────────────
// renderCues / toWav 是单声道路径（cues 不写下面这些字段时 scripts/sfx.mjs 只走它）。
// renderStereo 是立体声路径：声像、曲线驱动的增益/音高/滤波、连续层、共享混响送量。
//
// 声像律：等功率（L = cos θ, R = sin θ，θ = (pan+1)·π/4）。选它不是口味，是为了和单声道路径对齐：
//   pan = 0 时两声道各乘 cos45° = 0.7071，而 mux.sh 把单声道 sfx.wav aformat 成立体声时
//   ffmpeg 也是每声道 -3.01 dB（实测，仓库 docs/verified/film-narration.md §29）。所以同一个 cue 不写 pan 走立体声路径，成片里和单声道路径一样响。
//
// 参数（gain / pan / send / rate / lowpass）都可以是：
//   数字            常量
//   曲线 { t0, rate, v }   从成片时间 t0 起每秒 rate 个点（scripts/sfx.mjs 从 probe(t) / anchors(t) 采好），线性插值、两端钳住
export const PAN_LAW = 'equal-power';
const panGains = (p) => { const a = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };
const isCurve = (p) => p != null && typeof p === 'object' && p.v != null;
function param(p, dflt) {
  if (p == null) return () => dflt;
  if (typeof p === 'number') return () => p;
  if (!isCurve(p)) throw new Error(`参数要是数字或 {t0, rate, v} 曲线，收到 ${JSON.stringify(p)}`);
  const { t0, rate, v } = p, last = v.length - 1;
  return (t) => {
    const x = (t - t0) * rate;
    if (!(x > 0)) return v[0];
    if (x >= last) return v[last];
    const i = Math.floor(x), f = x - i;
    return v[i] + (v[i + 1] - v[i]) * f;
  };
}

/** 一个 cue 在成片里占多久（秒）。dur 优先；否则按音色/素材长度和 rate 推。 */
export function spanOf(cue, sounds = SOUNDS) {
  if (cue.dur != null) return cue.dur;
  const base = cue.samples ? cue.samples.length / RATE : (sounds[cue.type]?.[0] ?? 0);
  if (cue.rate == null || typeof cue.rate === 'number') return base / Math.max(1e-6, cue.rate ?? 1);
  const r = param(cue.rate, 1);               // 曲线音高：按 1 ms 步长积分到素材用完，最多 120 s
  let tau = 0, s = 0;
  for (; tau < base && s < 120; s += 0.001) tau += Math.max(0, r(cue.t + s)) * 0.001;
  return s;
}

// Freeverb（Jezar 的公版结构：每声道 8 个梳状 + 4 个全通，右声道错开 23 个样本）。
// 选它是因为 O(N)、确定、不需要 FFT；房间的大小和阻尼是片子的事，所以 room 没有默认值。
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ALLPASS = [556, 441, 341, 225], SPREAD = 23;
function freeverb(inL, inR, { size, damp, width = 1 }) {
  if (!(size >= 0 && size <= 1) || !(damp >= 0 && damp <= 1)) throw new Error(`room 要写 { size: 0..1, damp: 0..1 }，收到 ${JSON.stringify({ size, damp })}`);
  const k = RATE / 44100, fb = size * 0.28 + 0.7, d = damp * 0.4, N = inL.length;
  const mk = (len) => ({ buf: new Float32Array(Math.round(len * k)), i: 0, st: 0 });
  const chan = (off) => ({ c: COMBS.map((l) => mk(l + off)), a: ALLPASS.map((l) => mk(l + off)) });
  const ch = [chan(0), chan(SPREAD)], out = [new Float32Array(N), new Float32Array(N)];
  for (let n = 0; n < N; n++) {
    const x = (inL[n] + inR[n]) * 0.015;
    for (let c = 0; c < 2; c++) {
      let y = 0;
      for (const cb of ch[c].c) {
        const o = cb.buf[cb.i]; cb.st = o * (1 - d) + cb.st * d; cb.buf[cb.i] = x + cb.st * fb;
        if (++cb.i >= cb.buf.length) cb.i = 0; y += o;
      }
      for (const ap of ch[c].a) {
        const b = ap.buf[ap.i], o = b - y; ap.buf[ap.i] = y + b * 0.5;
        if (++ap.i >= ap.buf.length) ap.i = 0; y = o;
      }
      out[c][n] = y * 3;
    }
  }
  const w1 = width / 2 + 0.5, w2 = (1 - width) / 2;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let n = 0; n < N; n++) { L[n] = out[0][n] * w1 + out[1][n] * w2; R[n] = out[1][n] * w1 + out[0][n] * w2; }
  return [L, R];
}

/**
 * cues: [{ t, type | samples, gain?, pan?, send?, rate?, lowpass?, dur?, seed? }] -> { L, R }
 *   pan      -1（左）..1（右），默认 0
 *   send     送进共享房间的比例，默认 0（= 不进房间）。任何 cue 的 send > 0 时必须给 room
 *   rate     播放速率 = 音高倍数（变速变调，素材和合成音色都适用），默认 1
 *   lowpass  一阶低通截止频率 Hz，不写就不滤
 *   dur      连续层：在这段时长里循环音色/素材（不写就按音色长度放一次）
 */
export function renderStereo(cues, { sounds = SOUNDS, tail = 0.5, length = 0, room = null, spaceRule = undefined, master = null } = {}) {
  cues = expandRecipes(cues, { sounds });
  const tails = planTails(cues, spaceRule);                       // 尾音挂在哪些 cue 上：对整张表一次性决定
  const spans = cues.map((c) => spanOf(c, sounds));
  const wet = cues.some((c) => c.send != null && c.send !== 0);
  if (wet && !room) throw new Error('有 cue 写了 send > 0，但没给 room（{ size, damp }）：房间的大小是片子的选择，套件不给默认');
  const last = cues.reduce((m, c, i) => Math.max(m, c.t + spans[i]), 0);
  const N = Math.ceil(Math.max(length, last + tail + (wet ? 2 : 0)) * RATE);
  const L = new Float32Array(N), R = new Float32Array(N);
  const useDry = cues.some((c) => c.bus === 'dry');
  const DL = useDry ? new Float32Array(N) : null, DR = useDry ? new Float32Array(N) : null;
  for (const c of cues) if (c.bus != null && c.bus !== 'dry' && c.bus !== 'main') throw new Error(`bus 只认 "main"（默认，过闷音）/ "dry"（不过闷音），收到 ${JSON.stringify(c.bus)}`);
  const tailSrc = new Map();
  const WL = wet ? new Float32Array(N) : null, WR = wet ? new Float32Array(N) : null;
  cues.forEach((cue, idx) => {
    const g = param(cue.gain, 1), pn = param(cue.pan, 0), sd = param(cue.send, 0), rt = param(cue.rate, 1);
    const lp = cue.lowpass == null ? null : param(cue.lowpass, 0);
    const constPan = !isCurve(cue.pan), [cl, cr] = panGains(pn(0));
    const constRate = !isCurve(cue.rate) ? (cue.rate ?? 1) : null;
    const loop = cue.dur != null;
    let src, srcLen;
    if (cue.samples) { src = cue.samples; srcLen = src.length / RATE; }
    else {
      const voice = sounds[cue.type];
      if (!voice) throw new Error(`未知音效类型 ${cue.type}，可选 ${Object.keys(sounds).join(' ')}`);
      [srcLen, src] = voice;
    }
    const rnd = noise(cue.seed ?? (idx + 1) * 2654435761);
    const first = Math.round(cue.t * RATE), count = Math.ceil(spans[idx] * RATE);
    let tau = 0, y = 0;
    const OL = cue.bus === 'dry' ? DL : L, OR = cue.bus === 'dry' ? DR : R;
    const ts = tails.has(idx) ? new Float32Array(Math.max(1, count)) : null;
    if (ts) tailSrc.set(idx, { buf: ts, first, out: [OL, OR] });
    for (let n = 0; n < count; n++) {
      const at = first + n;
      if (at >= N) break;
      const tA = cue.t + n / RATE;
      if (constRate != null) tau = n * constRate / RATE;
      if (!loop && tau >= srcLen) break;
      const tt = loop ? tau % srcLen : tau;
      let s;
      if (cue.samples) {
        const x = tt * RATE, i = Math.floor(x), f = x - i;
        s = i + 1 < src.length ? src[i] + (src[i + 1] - src[i]) * f : (src[i] ?? 0);
      } else s = src(tt, rnd);
      if (constRate == null) tau += Math.max(0, rt(tA)) / RATE;
      if (lp) { const a = 1 - Math.exp(-TAU * Math.max(1, lp(tA)) / RATE); y += a * (s - y); s = y; }
      if (at < 0) continue;
      const v = g(tA) * s;
      const [gl, gr] = constPan ? [cl, cr] : panGains(pn(tA));
      OL[at] += v * gl; OR[at] += v * gr;
      if (ts) ts[n] = v;
      if (wet) { const k = sd(tA); if (k) { WL[at] += v * k * gl; WR[at] += v * k * gr; } }
    }
  });
  if (wet) {
    const [rl, rr] = freeverb(WL, WR, room);
    for (let n = 0; n < N; n++) { L[n] += rl[n]; R[n] += rr[n]; }
  }
  // 尾音：干声 × 程序化冲激响应（左右去相关），从 cue 起点叠回它所在的总线；超出片长的部分截掉
  const tailInfo = [];
  for (const [idx, { buf: src, first, out: [OL, OR] }] of tailSrc) {
    const ir = makeIR(tails.get(idx));
    for (const [h, O] of [[ir.L, OL], [ir.R, OR]]) {
      const y = convolve(src, h);
      for (let n = 0; n < y.length; n++) { const at = first + n; if (at >= 0 && at < N) O[at] += y[n] * ir.gain; }
    }
    tailInfo.push({ t: +cues[idx].t.toFixed(3), type: cues[idx].type ?? 'samples', space: tails.get(idx) });
  }
  const info = {};
  if (tailInfo.length) info.tails = tailInfo;
  // 闷音：主总线时变低通（dry 总线不过）
  const Z = muffleCurve(cues, N);
  if (Z) { applyMuffle(L, Z); applyMuffle(R, Z); info.muffle = Z; }
  if (useDry) for (let n = 0; n < N; n++) { L[n] += DL[n]; R[n] += DR[n]; }
  const G = duckCurve(cues, N);
  if (G) info.duck = G;
  if (master) info.master = applyMaster(L, R, master);
  return { L, R, ...info };
}

/** 两条 Float32Array -> 16bit 立体声 WAV 的 Uint8Array（与 toWav 同样的削顶和量化） */
export function toWavStereo(L, R) {
  const frames = L.length, bytes = frames * 4;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
  const q = (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let n = 0; n < frames; n++) { v.setInt16(44 + n * 4, q(L[n]), true); v.setInt16(46 + n * 4, q(R[n]), true); }
  return new Uint8Array(buf);
}
