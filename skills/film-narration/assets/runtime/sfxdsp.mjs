// 音效合成的 DSP 基元、分层配方、程序化空间（冲激响应）与总线处理。纯函数，浏览器和 Node 都能 import。
// sfx.mjs 转导出这里的东西：cue 写 "type": "<配方名>" 时，混音器先把配方渲成一段 samples，再走素材那条路径。
//
// 确定性：随机全部来自 film-core 的 rand.js（seeded），噪声种子 = cue.seed ?? 名字哈希 + 变体×7919；
// 变体（没钉死时）与 jitter 按 hash(配方名, cue.id) 取，没有 id 时按 (配方名, 同名出现序号)。
// 同样的 (配方, 参数, 种子, 变体, 抖动键) 逐样本相同。配方里不读时钟、不用 Math.random。
// 采样率只在这里定义一次（SR）；sfx.mjs 的 RATE 就是它。
// 配方各层管哪段频带和时间、听起来是什么、代价是什么：film-narration references/sfx-recipes.md。
import { seeded } from './rand.js';

export const SR = 48000;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ───────────────────────── 基元 ─────────────────────────
export const buf = (sec) => new Float32Array(Math.max(1, Math.round(sec * SR)));
export const between = (r, a, b) => a + (b - a) * r();
/** 名字 → 32 位哈希（FNV-1a），给配方当种子基数：换 cue 顺序不改变某个配方的声音 */
export function nameHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** RBJ 双二阶系数 [b0, b1, b2, a1, a2]（已除 a0）。kind: lp | hp | bp（带通取 0 dB 峰值） */
export function biquad(kind, f, q) {
  if (!Number.isFinite(f) || !(Number.isFinite(q) && q > 0)) throw new Error('biquad: f 必须有限，q 必须有限且 > 0');
  const w = TAU * clamp(f, 10, SR * 0.46) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  let b0, b1, b2;
  if (kind === 'lp') { b1 = (1 - c); b0 = b2 = b1 / 2; }
  else if (kind === 'hp') { b1 = -(1 + c); b0 = b2 = (1 + c) / 2; }
  else if (kind === 'bp') { b0 = al; b1 = 0; b2 = -al; }
  else throw new Error(`滤波类型只认 lp / hp / bp，收到 ${kind}`);
  return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - al) / a0];
}

/** 定参数双二阶（原地）。q 默认 0.707（巴特沃斯） */
export function filter(x, kind, f, q = 0.707) {
  const [b0, b1, b2, a1, a2] = biquad(kind, f, q);
  let z1 = 0, z2 = 0;
  for (let n = 0; n < x.length; n++) {
    const s = x[n], y = b0 * s + z1;
    z1 = b1 * s - a1 * y + z2; z2 = b2 * s - a2 * y; x[n] = y;
  }
  return x;
}

/** 时变双二阶（原地）：f(u)、q(u) 是位置 u∈[0,1) 的函数（q 也可以是常数），每 step 个样本重算一次系数 */
export function sweep(x, kind, f, q = 0.707, step = 32) {
  let z1 = 0, z2 = 0, k = null;
  const N = x.length;
  for (let n = 0; n < N; n++) {
    if (n % step === 0) k = biquad(kind, f(n / N), typeof q === 'function' ? q(n / N) : q);
    const s = x[n], y = k[0] * s + z1;
    z1 = k[1] * s - k[3] * y + z2; z2 = k[2] * s - k[4] * y; x[n] = y;
  }
  return x;
}
/** 指数扫频曲线：u=0 时 a，u=1 时 b，curve<1 先快后慢 */
export const expRamp = (a, b, curve = 1) => (u) => a * Math.pow(b / a, Math.pow(u, curve));

/** 指数衰减包络（可带指数起音）：(1 − e^(−t/att))·e^(−t/tau) */
export const decay = (tau, att = 0) => (t) => (att > 0 ? 1 - Math.exp(-t / att) : 1) * Math.exp(-t / tau);
/** 不对称高斯包络：peak 秒处为 1，前沿宽 rise、后沿宽 fall */
export const gauss = (peak, rise, fall) => (t) => { const d = (t - peak) / (t < peak ? rise : fall); return Math.exp(-d * d); };
export function shape(x, env) { for (let n = 0; n < x.length; n++) x[n] *= env(n / SR); return x; }

export function white(sec, r) { const x = buf(sec); for (let n = 0; n < x.length; n++) x[n] = r() * 2 - 1; return x; }
export function peakOf(x) { let p = 0; for (let n = 0; n < x.length; n++) { const a = Math.abs(x[n]); if (a > p) p = a; } return p; }
export function normalize(x, to = 1) { const p = peakOf(x); if (p > 0) for (let n = 0; n < x.length; n++) x[n] *= to / p; return x; }
/** 把 src 乘 g 叠进 dst 的 at 秒处（越界截掉） */
export function mixAt(dst, src, at, g = 1) {
  const o = Math.round(at * SR), end = Math.min(src.length, dst.length - o);
  for (let n = Math.max(0, -o); n < end; n++) dst[o + n] += src[n] * g;
  return dst;
}

/** 滤波噪声 + 指数衰减：{ dur, tau, att?, hp?, lp?, bp?, q? }，归一到峰值 1（层的响度由叠加时的增益决定） */
export function noiseHit(r, { dur, tau, att = 0, hp, lp, bp, q = 1 }) {
  const x = white(dur, r);
  if (hp) filter(x, 'hp', hp);
  if (lp) filter(x, 'lp', lp);
  if (bp) filter(x, 'bp', bp, q);
  return normalize(shape(x, decay(tau, att)));
}

/** 指数下滑音高的正弦（鼓的身体）：f(t) = f1 + (f0 − f1)·e^(−t/glide)，振幅 decay(tau, att) */
export function glide({ dur, f0, f1, glide: g, tau, att = 0.0006 }) {
  const x = buf(dur);
  let ph = 0;
  for (let n = 0; n < x.length; n++) {
    const t = n / SR;
    ph += TAU * (f1 + (f0 - f1) * Math.exp(-t / g)) / SR;
    x[n] = Math.sin(ph) * (1 - Math.exp(-t / att)) * Math.exp(-t / tau);
  }
  return x;
}

/** 模态合成：modes = [[频率 Hz, 衰减时间常数 s, 振幅], ...]，频率比可以非谐（金属、玻璃）。随机初相来自 r；0.4 ms 线性起音防咔哒 */
export function modal(r, { dur, modes, att = 0.0004 }) {
  const x = buf(dur);
  for (const [f, tau, a] of modes) {
    if (f > SR * 0.46) continue;
    const w = TAU * f / SR, ph = r() * TAU, k = Math.exp(-1 / (tau * SR));
    let amp = a;
    for (let n = 0; n < x.length && amp > 1e-5; n++) { x[n] += Math.sin(w * n + ph) * amp; amp *= k; }
  }
  const na = Math.min(x.length, Math.round(att * SR));
  for (let n = 0; n < na; n++) x[n] *= n / na;
  return x;
}

/** 啁啾：频率在 dur 内从 f0 指数走到 f1；arch=true 时套一个半正弦拱形包络 */
export function chirp({ dur, f0, f1, arch = true }) {
  const x = buf(dur), N = x.length;
  let ph = 0;
  for (let n = 0; n < N; n++) {
    const u = n / N;
    ph += TAU * f0 * Math.pow(f1 / f0, u) / SR;
    x[n] = Math.sin(ph) * (arch ? Math.sin(Math.PI * u) : 1);
  }
  return x;
}

/** 随机碎响颗粒：count 个 1–4 ms（minLen..maxLen）的噪声小爆，起点在 [from, dur) 里按 u^fall 分布（fall>1 前密后疏） */
export function grains(r, { dur, count, from = 0, fall = 1, minLen = 0.001, maxLen = 0.004, ampFall = 0, hp, lp, bp, q = 1 }) {
  const x = buf(dur);
  for (let i = 0; i < count; i++) {
    const at = from + (dur - from - 0.02) * Math.pow(r(), fall);
    const o = Math.round(at * SR), len = Math.max(1, Math.round(between(r, minLen, maxLen) * SR));
    const a = between(r, 0.2, 1) * (ampFall ? Math.exp(-at / ampFall) : 1);
    for (let n = 0; n < len && o + n < x.length; n++) x[o + n] += (r() * 2 - 1) * a * Math.exp(-4 * n / len);
  }
  if (hp) filter(x, 'hp', hp);
  if (lp) filter(x, 'lp', lp);
  if (bp) filter(x, 'bp', bp, q);
  return x;
}

/** tanh 软削波（原地），按 tanh(drive) 归一：满幅输入仍落在 ±1，小信号增益约 drive/tanh(drive)。drive 必须 > 0（0 时归一系数是 1/0） */
export function softclip(x, drive) {
  if (!(Number.isFinite(drive) && drive > 0)) throw new Error(`softclip: drive 必须有限且 > 0（0 时 1/tanh(0) = ∞，整段变 NaN），收到 ${drive}`);
  const k = 1 / Math.tanh(drive); for (let n = 0; n < x.length; n++) x[n] = Math.tanh(x[n] * drive) * k; return x;
}

/** 二阶巴特沃斯高通去直流（原地）。只用在配方输出（非循环配方），20 Hz：30 Hz 处约 −0.8 dB */
export const DC_HP = 20;
export function dcBlock(x, f = DC_HP) { return filter(x, 'hp', f); }

/** 等功率首尾交叉做无缝循环：输入长 loop + fade 样本，返回长 loop 的缓冲，首尾相接处没有跳变 */
export function loopXfade(x, loop) {
  const fade = x.length - loop;
  if (fade <= 0) throw new Error(`loopXfade：输入要比循环长度长（多出来的部分用作交叉），收到 ${x.length} ≤ ${loop}`);
  const out = Float32Array.from(x.subarray(0, loop));
  for (let n = 0; n < fade && n < loop; n++) {
    const u = (n + 0.5) / fade;
    out[n] = x[n] * Math.sin(u * Math.PI / 2) + x[loop + n] * Math.cos(u * Math.PI / 2);
  }
  return out;
}

/** 首尾防咔哒：线性淡入 inSec、平方淡出 outSec */
export function edges(x, inSec, outSec) {
  const a = Math.min(x.length >> 1, Math.round(inSec * SR)), b = Math.min(x.length >> 1, Math.round(outSec * SR));
  for (let n = 0; n < a; n++) x[n] *= n / a;
  for (let n = 0; n < b; n++) { const u = n / b; x[x.length - 1 - n] *= u * u; }
  return x;
}

// ───────────────────────── 配方 ─────────────────────────
// 每个配方：{ use, about, variants: [音高系数...], dur(p), render(r, p, k, v) }
//   r 种子随机；p 参数（已合并默认）；k 音高系数（变体 × pitch × 抖动）；v 变体序号
// render 返回单声道 Float32Array；外层统一 edges + 峰值归一到 PEAK（层间比例才是配方，绝对响度交给 cue 的 gain）。
export const PEAK = 0.9;
const pick = (arr, v) => arr[((v % arr.length) + arr.length) % arr.length];

const MATERIALS = {
  // 金属：非谐模态（频率比来自板/壳振动的非整数比），衰减随阶数加快
  // 缓冲长度随 ring 拉长（ring ≤ 1 时与原长度相同）：余振截断点永远在同一个相对衰减处，不会因为 ring 变大被切掉
  metal: (r, p, k, v) => {
    const g = Math.max(1, p.ring), o = buf(0.5 * g), base = pick([640, 880, 745], v) * k;
    mixAt(o, noiseHit(r, { dur: 0.015, tau: 0.003, hp: 1500 }), 0, 1);
    mixAt(o, noiseHit(r, { dur: 0.04, tau: 0.008, lp: 1800 }), 0, 0.6);
    const ratios = [1, 1.58, 2.24, 2.92, 3.71, 4.93, 6.31, 8.1];
    mixAt(o, modal(r, { dur: 0.48 * g, modes: ratios.map((m, i) => [base * m, 0.13 * p.ring / (1 + i * 0.55), 1 / (1 + i * 0.5)]) }), 0.0005, 0.42);
    return o;
  },
  // 混凝土 / 石：低通闷击 + 下滑身体 + 高频碎屑颗粒
  concrete: (r, p, k) => {
    const o = buf(0.36);
    mixAt(o, noiseHit(r, { dur: 0.06, tau: 0.013, lp: 950 * k }), 0, 1.1);
    mixAt(o, glide({ dur: 0.05, f0: 150 * k, f1: 70, glide: 0.012, tau: 0.016 }), 0, 0.6);
    mixAt(o, noiseHit(r, { dur: 0.012, tau: 0.002, hp: 2000 }), 0, 0.6);
    mixAt(o, noiseHit(r, { dur: 0.12, tau: 0.024, bp: 3500 * k, q: 0.7 }), 0.003, 0.3);
    mixAt(o, grains(r, { dur: 0.34, count: Math.round(16 * p.debris), from: 0.03, fall: 1.8, hp: 1800, ampFall: 0.1 }), 0, 0.35);
    return o;
  },
  // 木：少数几个低模态（谐波性弱、衰减快）+ 中频碎屑
  wood: (r, p, k) => {
    const g = Math.max(1, p.ring), o = buf(0.26 * g);
    mixAt(o, modal(r, { dur: 0.2 * g, modes: [[238 * k, 0.03 * p.ring, 1], [512 * k, 0.022 * p.ring, 0.8], [893 * k, 0.016 * p.ring, 0.6], [1410 * k, 0.01 * p.ring, 0.4]] }), 0, 0.6);
    mixAt(o, noiseHit(r, { dur: 0.03, tau: 0.006, lp: 2100 }), 0, 0.8);
    mixAt(o, noiseHit(r, { dur: 0.01, tau: 0.002, hp: 3000 }), 0, 0.5);
    mixAt(o, grains(r, { dur: 0.2, count: Math.round(6 * p.debris), from: 0.01, fall: 2, bp: 2600, q: 1.5 }), 0, 0.3);
    return o;
  },
  // 玻璃：高频点击 + 一串散开的高频模态对（3.2–9.5 kHz，前密后疏）
  glass: (r, p, k) => {
    const g = Math.max(1, p.ring), o = buf(0.45 * g);
    mixAt(o, noiseHit(r, { dur: 0.01, tau: 0.002, hp: 2500 }), 0, 1);
    const n = Math.round(9 * p.debris);
    for (let i = 0; i < n; i++) {
      const f = between(r, 3200, 9500) * k;
      mixAt(o, modal(r, { dur: 0.1 * g, modes: [[f, between(r, 0.01, 0.03) * p.ring, 1], [f * 1.47, 0.01 * p.ring, 0.5]] }), Math.pow(r(), 2) * 0.3, between(r, 0.1, 0.35));
    }
    return o;
  },
  // 水：带通扫频的泼溅 + 嘶声 + 几个上扬的水滴啁啾 + 低频闷响
  water: (r, p, k) => {
    const len = 0.5, g = Math.max(1, p.ring), o = buf(len * g), s = white(len * 0.9 * g, r);
    sweep(s, 'bp', expRamp(1500 * k, 520 * k), 0.8);
    mixAt(o, normalize(shape(s, decay(0.085 * p.ring, 0.007))), 0, 0.9);
    mixAt(o, noiseHit(r, { dur: len * 0.8 * g, tau: 0.07 * p.ring, att: 0.012, hp: 3000 }), 0.01, 0.25);
    const drops = Math.round(5 * p.debris);
    for (let i = 0; i < drops; i++) {
      const f = between(r, 500, 1700) * k;
      mixAt(o, chirp({ dur: between(r, 0.008, 0.02), f0: f, f1: f * between(r, 1.3, 1.9) }), between(r, 0.03, len * 0.6), between(r, 0.1, 0.3));
    }
    mixAt(o, glide({ dur: 0.06, f0: 100 * k, f1: 55, glide: 0.02, tau: 0.02, att: 0.002 }), 0, 0.5);
    mixAt(o, chirp({ dur: 0.035, f0: 420 * k, f1: 1150 * k }), 0, 0.5);
    return o;
  },
};

// boom 的缓冲：3√size，且装得下最晚的金属叮（1.9·size 起 + 0.2 s）和 1.6·size 的亚低频；size ≤ 1.7 时就是 3√size
const boomLen = (size) => Math.max(3 * Math.sqrt(size), 1.9 * size + 0.2, 1.6 * size);
// clatter 的缓冲：最晚一次撞击的上界（首间隔 ≤ 0.15，之后每次 ≤ 0.1125）+ 0.22 s 余振；默认 2–3 次时就是 0.55
const clatterLen = (hits) => Math.max(0.55, 0.15 * Math.min(1, hits - 1) + 0.1125 * Math.max(0, hits - 2) + 0.22 + 0.01);

export const RECIPES = {
  // ── 冲击 ──
  crack: {
    use: '冲击', about: '短促爆裂冲击（枪声、鞭响、重拍）：瞬态 + 身体 + 爆压 + 中频冲击 + 空气 + 可选机械层',
    variants: [1, 0.955, 1.045, 0.985], defaults: { body: 1, mech: 1, air: 1, drive: 1.5 },
    dur: () => 0.32,
    render(r, p, k, v) {
      const o = buf(0.32), tone = pick([1, 1.12, 0.9, 1.05], v);
      mixAt(o, noiseHit(r, { dur: 0.012, tau: 0.0011, hp: 2600 * tone }), 0, 2.6);          // 瞬态：>2.6 kHz，前 12 ms
      mixAt(o, noiseHit(r, { dur: 0.02, tau: 0.003, hp: 1200, lp: 8000 }), 0.0002, 1.2);     // 爆裂：1.2–8 kHz，20 ms
      mixAt(o, glide({ dur: 0.11, f0: 160 * k, f1: 45 * k, glide: 0.024, tau: 0.03, att: 0.003 }), 0, 0.62 * p.body); // 身体
      mixAt(o, noiseHit(r, { dur: 0.22, tau: 0.03, att: 0.0012, hp: 300 * k, lp: 2500 * k * tone }), 0, 1.5);       // 爆压
      mixAt(o, noiseHit(r, { dur: 0.09, tau: 0.016, att: 0.001, bp: 760 * k, q: 2.2 }), 0, 0.9);                   // 中频冲击
      mixAt(o, noiseHit(r, { dur: 0.16, tau: 0.04, hp: 4800 }), 0.001, 0.34 * p.air);                              // 空气嘶声
      if (p.mech > 0) {                                                                                             // 机械层
        const m = 0.035 + (v % 4 - 1.5) * 0.0015;
        mixAt(o, modal(r, { dur: 0.05, modes: [[2150 * k, 0.007, 1], [3420 * k, 0.006, 0.7], [5230, 0.004, 0.5], [880 * k, 0.012, 0.5]] }), m, 0.26 * p.mech);
        mixAt(o, noiseHit(r, { dur: 0.012, tau: 0.002, bp: 3100, q: 1.2 }), m, 0.3 * p.mech);
        mixAt(o, modal(r, { dur: 0.05, modes: [[1780 * k, 0.008, 1], [2890 * k, 0.006, 0.6], [640 * k, 0.02, 0.5]] }), m + 0.027, 0.17 * p.mech);
        mixAt(o, noiseHit(r, { dur: 0.01, tau: 0.002, bp: 2400, q: 1.2 }), m + 0.027, 0.16 * p.mech);
        mixAt(o, modal(r, { dur: 0.2, modes: [[712 * k, 0.05, 1], [1466 * k, 0.03, 0.4]] }), m + 0.03, 0.035 * p.mech);
      }
      for (let n = 0; n < o.length; n++) o[n] *= 0.46;
      return softclip(o, p.drive);
    },
  },
  boom: {
    use: '冲击', about: '爆炸 / 巨物落地：爆裂 + 亚低频下滑 + 扫频冲击噪声 + 隆隆 + 碎响颗粒 + 零星金属叮；size 越大越低越长',
    variants: [1, 0.9], defaults: { size: 1, debris: 1, pings: 7, drive: 1.7 },
    dur: (p) => boomLen(p.size),
    render(r, p, k) {
      const L = boomLen(p.size), o = buf(L), s = k / Math.sqrt(p.size);
      mixAt(o, noiseHit(r, { dur: 0.03, tau: 0.006, hp: 1500 }), 0, 1.8);                                       // 爆裂 >1.5 kHz
      mixAt(o, glide({ dur: 1.6 * p.size, f0: 96 * s, f1: 27, glide: 0.16, tau: 0.36 * p.size, att: 0.001 }), 0, 0.85); // 亚低频 96→27 Hz
      const shock = white(1.6 * p.size, r);
      sweep(shock, 'lp', expRamp(2800, 260, 0.5), 0.7);
      mixAt(o, normalize(shape(shock, decay(0.26 * p.size, 0.002))), 0, 3.2);                                   // 冲击噪声 LP 2800→260
      const rumble = filter(white(Math.min(L, 2.6 * p.size), r), 'lp', 120);
      mixAt(o, normalize(shape(rumble, decay(0.7 * p.size, 0.03))), 0, 2.2);                                     // 隆隆 <120 Hz
      mixAt(o, noiseHit(r, { dur: 0.5, tau: 0.09, bp: 520 * s, q: 1.2 }), 0, 1.3);                               // 身体 520 Hz
      mixAt(o, grains(r, { dur: L * 0.83, count: Math.round(120 * p.debris), from: 0.25, fall: 1.5, hp: 1500, lp: 9000, ampFall: 0.8 * p.size, maxLen: 0.01 }), 0, 0.5); // 碎响
      for (let i = 0; i < p.pings; i++) {                                                                        // 零星金属叮
        const f = between(r, 900, 3600);
        mixAt(o, modal(r, { dur: 0.2, modes: [[f, between(r, 0.02, 0.06), 1], [f * 1.61, 0.02, 0.5]] }), between(r, 0.4, 1.9) * p.size, between(r, 0.03, 0.09));
      }
      for (let n = 0; n < o.length; n++) o[n] *= 0.36;
      return softclip(o, p.drive);
    },
  },
  impact: {
    use: '冲击', about: '按材质的碰撞：material = metal | concrete | wood | glass | water（必填）；ring 拉长余振，debris 改碎屑量',
    variants: [1, 1.1, 0.9], defaults: { material: null, ring: 1, debris: 1 },
    dur: (p) => (({ metal: 0.5, concrete: 0.36, wood: 0.26, glass: 0.45, water: 0.5 })[p.material] ?? 0.5) * (p.material === 'concrete' ? 1 : Math.max(1, p.ring)),
    render(r, p, k, v) {
      const m = MATERIALS[p.material];
      if (!m) throw new Error(`impact 要写 params.material：${Object.keys(MATERIALS).join(' / ')}（材质是这一下打在什么上，套件不替你选），收到 ${JSON.stringify(p.material)}`);
      return m(r, p, k, v);
    },
  },
  zing: {
    use: '冲击', about: '弹开的啸叫（跳弹、金属擦过）：下滑正弦带颤音 + 同音高带通噪声 + 起始点击',
    variants: [1, 0.82, 1.18], defaults: { vibrato: 1 },
    dur: () => 0.75,
    render(r, p, k, v) {
      const o = buf(0.75), hi = pick([3300, 2700, 3900], v) * k / pick([1, 0.82, 1.18], v), lo = pick([820, 1100, 700], v) * k / pick([1, 0.82, 1.18], v);
      const f = (t) => lo + (hi - lo) * Math.exp(-t / 0.16);
      let ph = 0;
      for (let n = 0; n < o.length; n++) {
        const t = n / SR;
        ph += TAU * f(t) * (1 + 0.035 * p.vibrato * Math.sin(TAU * (18 + 30 * t) * t)) / SR;
        o[n] = (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) * (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.19);
      }
      const nz = white(0.75, r);
      sweep(nz, 'bp', (u) => f(u * 0.75), 6);
      mixAt(o, normalize(shape(nz, decay(0.15, 0.003))), 0, 0.5);
      mixAt(o, noiseHit(r, { dur: 0.01, tau: 0.002, hp: 2500 }), 0, 0.7);
      return o;
    },
  },
  passby: {
    use: '滑过', about: '近距离掠过（子弹、飞虫、快速物体）：带通扫频噪声 + 高斯包络，peak 是最近点时刻',
    variants: [1, 0.83, 1.17], defaults: { peak: 0.05, from: 5200, to: 1300 },
    dur: (p) => Math.max(0.3, p.peak + 0.25),
    render(r, p, k) {
      const L = Math.max(0.3, p.peak + 0.25), o = buf(L), s = white(L - 0.02, r);
      sweep(s, 'bp', expRamp(p.from * k, p.to * k, 0.8), 3.5);
      mixAt(o, shape(s, gauss(p.peak, 0.018, 0.05)), 0, 1);
      mixAt(o, noiseHit(r, { dur: 0.006, tau: 0.0008, hp: 3000 }), Math.max(0, p.peak - 0.002), 0.25);
      mixAt(o, chirp({ dur: 0.2, f0: p.from * k * 0.5, f1: p.to * k * 0.6 }), 0, 0.03);
      return o;
    },
  },
  // ── 物件 / 余韵 ──
  clatter: {
    use: '物件', about: '小金属件落地弹跳（弹壳、螺丝、钥匙）：2–3 次撞击，间隔递减、增益递减；size 越大越低',
    variants: [1, 1.09, 0.93], defaults: { hits: null, size: 1 },
    dur: (p) => clatterLen(p.hits ?? 3),
    render(r, p, k, v) {
      const hits = p.hits ?? (v % 3 === 1 ? 2 : 3), o = buf(clatterLen(hits));
      let at = 0, g = 1;
      for (let i = 0; i < hits; i++) {
        const c = k / p.size * between(r, 0.96, 1.05);
        mixAt(o, modal(r, { dur: 0.22, modes: [[4180 * c, between(r, 0.03, 0.055), 1], [6830 * c, 0.03, 0.7], [9760 * c, 0.02, 0.5], [11900 * c, 0.012, 0.3], [2470 * c, 0.012, 0.3]] }), at, g * 0.5);
        mixAt(o, noiseHit(r, { dur: 0.004, tau: 0.0008, hp: 3500 }), at, g * 0.5);
        at += between(r, 0.085, 0.15) * (i ? 0.75 : 1);
        g *= between(r, 0.45, 0.62);
      }
      return o;
    },
  },
  step: {
    use: '物件', about: '脚步 / 轻落：低频闷击 + 低通身体 + 中频鞋面 + 采样保持调幅的高频砂砾',
    variants: [1, 1.07, 0.94, 1.03], defaults: { grit: 1 },
    dur: () => 0.3,
    render(r, p, k) {
      const o = buf(0.3);
      mixAt(o, glide({ dur: 0.06, f0: 112 * k, f1: 58 * k, glide: 0.018, tau: 0.02, att: 0.002 }), 0, 0.75);
      mixAt(o, noiseHit(r, { dur: 0.06, tau: 0.016, lp: 720 * k }), 0, 0.9);
      mixAt(o, noiseHit(r, { dur: 0.1, tau: 0.028, att: 0.004, bp: 2500 * k, q: 0.7 }), 0.012, 0.22);
      const grit = noiseHit(r, { dur: 0.2, tau: 0.05, att: 0.01, hp: 3800 }), hold = Math.round(SR * 0.0015);
      let a = 1;
      for (let n = 0; n < grit.length; n++) { if (n % hold === 0) a = 0.3 + r() * 0.7; grit[n] *= a; }
      mixAt(o, grit, 0.02, 0.16 * p.grit);
      return o;
    },
  },
  land: {
    use: '物件', about: '重落地（人、箱子）：更深更长的闷击 + 低通身体 + 3 声装备碰响 + 砂砾，轻度软削波',
    variants: [1, 0.94], defaults: { gear: 1 },
    dur: () => 0.45,
    render(r, p, k) {
      const o = buf(0.45);
      mixAt(o, glide({ dur: 0.14, f0: 124 * k, f1: 44 * k, glide: 0.03, tau: 0.045, att: 0.002 }), 0, 1);
      mixAt(o, noiseHit(r, { dur: 0.14, tau: 0.035, lp: 520 * k }), 0, 1);
      mixAt(o, noiseHit(r, { dur: 0.2, tau: 0.06, att: 0.01, bp: 1500, q: 0.7 }), 0.01, 0.16);
      for (const at of [0.022, 0.05, 0.088]) mixAt(o, noiseHit(r, { dur: 0.012, tau: 0.003, bp: between(r, 2200, 4200), q: 2 }), at, between(r, 0.1, 0.22) * p.gear);
      mixAt(o, noiseHit(r, { dur: 0.2, tau: 0.05, att: 0.01, hp: 3500 }), 0.015, 0.1);
      return softclip(o, 1.2);
    },
  },
  rub: {
    use: '滑过', about: '摩擦 / 布料 / 拉链：带通扫频噪声 + 随机振幅抖动（rate Hz），拱形包络',
    variants: [1, 1.08, 0.93], defaults: { dur: 0.17, from: 1700, to: 3400, rate: 190, q: 1.6 },
    dur: (p) => p.dur,
    render(r, p, k) {
      const x = white(p.dur, r);
      sweep(x, 'bp', expRamp(p.from * k, p.to * k), p.q);
      const hold = Math.max(1, Math.round(SR / p.rate));
      let a = 0.5, tgt = 0.5;
      for (let n = 0; n < x.length; n++) {
        if (n % hold === 0) tgt = 0.25 + r() * 0.75;
        a += (tgt - a) * 0.02;
        x[n] *= a * Math.sin(Math.PI * Math.pow(n / x.length, 0.7));
      }
      return x;
    },
  },
  // ── 通用：蓄力、低频冲击、闪烁、嗡鸣 ──
  riser: {
    use: '通用', about: '上升扫频蓄力：带通噪声冲刷（中心频率上扫、Q 收紧）+ 两条失谐啁啾 + 越来越密的高频颗粒，末尾 30 ms 收住',
    variants: [1, 1.06, 0.95], defaults: { dur: 2, from: 300, to: 6000, tone: 1, sparkle: 1 },
    dur: (p) => p.dur,
    render(r, p, k) {
      const L = p.dur, o = buf(L), N = o.length, wash = white(L, r);
      sweep(wash, 'bp', expRamp(p.from * k, p.to * k, 1.4), (u) => 0.7 + 3 * u);
      normalize(wash);
      for (let i = 0; i < 2; i++) mixAt(o, chirp({ dur: L, f0: p.from * 0.66 * k * (1 + i * 0.012), f1: p.to * 0.27 * k * (1 + i * 0.012), arch: false }), 0, 0.12 * p.tone);
      mixAt(o, wash, 0, 0.8);
      mixAt(o, grains(r, { dur: L, count: Math.round(60 * L * p.sparkle), from: L * 0.2, fall: 0.45, hp: 5000 }), 0, 0.5);
      const rel = Math.round(0.03 * SR);
      for (let n = 0; n < N; n++) { const u = n / N; o[n] *= u * u * (n > N - rel ? (N - n) / rel : 1); }
      return o;
    },
  },
  sub: {
    use: '通用', about: '亚低频冲击（drop、重音、logo 落地）：70→30 Hz 下滑正弦 + 起始低通闷击，软削波补出谐波让小喇叭也听得见',
    variants: [1, 0.94], defaults: { dur: 1.2, from: 70, to: 30, drive: 1.4 },
    dur: (p) => p.dur,
    render(r, p, k) {
      const o = buf(p.dur);
      mixAt(o, glide({ dur: p.dur, f0: p.from * k, f1: p.to * k, glide: p.dur * 0.25, tau: p.dur * 0.4, att: 0.002 }), 0, 1);
      mixAt(o, noiseHit(r, { dur: 0.08, tau: 0.02, lp: 200 }), 0, 0.5);
      return softclip(o, p.drive);
    },
  },
  shimmer: {
    use: '通用', about: '高频闪烁（亮点、魔法、出现）：2–9 kHz 的一簇模态各自慢颤 + 稀疏小亮点，60 ms 淡入',
    variants: [1, 1.12, 0.9], defaults: { dur: 1.5, partials: 9, sparkle: 1 },
    dur: (p) => p.dur,
    render(r, p, k) {
      const o = buf(p.dur), N = o.length;
      for (let i = 0; i < p.partials; i++) {
        const f = between(r, 2000, 9000) * k, rate = between(r, 4, 9), ph = r() * TAU, ph2 = r() * TAU, tau = between(r, 0.3, 0.9) * p.dur;
        const a = between(r, 0.3, 1);
        for (let n = 0; n < N; n++) {
          const t = n / SR;
          o[n] += a * Math.sin(TAU * f * t + ph) * (0.6 + 0.4 * Math.sin(TAU * rate * t + ph2)) * Math.exp(-t / tau);
        }
      }
      mixAt(o, grains(r, { dur: p.dur, count: Math.round(25 * p.dur * p.sparkle), fall: 1.3, hp: 6000, minLen: 0.0005, maxLen: 0.002 }), 0, 2);
      const att = Math.round(0.06 * SR);
      for (let n = 0; n < att && n < N; n++) o[n] *= n / att;
      return o;
    },
  },
  hum: {
    use: '通用', about: '嗡鸣（电器、引擎怠速、底噪床）：f0 的 1..harmonics 次谐波（1/n）+ 窄带噪声；首尾等功率交叉，配 cue 的 dur 无缝循环',
    variants: [1, 1.03, 0.97], defaults: { f0: 100, harmonics: 6, dur: 2, noise: 0.3 },
    dur: (p) => p.dur,
    loop: true,
    render(r, p, k) {
      const fade = 0.25, x = buf(p.dur + fade), f0 = p.f0 * k;
      for (let h = 1; h <= p.harmonics; h++) {
        const ph = r() * TAU, w = TAU * f0 * h / SR;
        for (let n = 0; n < x.length; n++) x[n] += Math.sin(w * n + ph) / h;
      }
      if (p.noise > 0) mixAt(x, normalize(filter(white(p.dur + fade, r), 'bp', f0 * 3, 4)), 0, p.noise);
      return loopXfade(x, Math.round(p.dur * SR));
    },
  },
};

/** 规范化 JSON：对象键排序，同一个值不管键序如何都得到同一个字符串（分组、缓存的键） */
export function canon(v) {
  if (v instanceof Float32Array || v instanceof Float64Array) return `[${Array.from(v).join(',')}]`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const POSITIVE = ['dur', 'size', 'ring', 'f0', 'from', 'to', 'rate', 'q', 'drive'];
const POS_INT = ['partials', 'harmonics', 'hits'];

/**
 * 渲一个配方：返回 { samples, variant, seed, pitch, gain }。jitter = 数字（音高 ±比例）或 { pitch, gain }。
 * jitterSeed：抖动的种子（expandRecipes 按 cue.id / 出现序号给）；不给时取噪声种子派生（同变体同抖动，旧行为）。
 * 非循环配方输出过 20 Hz 去直流高通（DC_HP），再 edges + 归一。任何参数让输出出现 NaN/Inf 都直接报错，不写静音。
 */
export function renderRecipe(name, { params = {}, variant = 0, seed = null, pitch = 1, jitter = 0, jitterSeed = null } = {}, recipes = RECIPES) {
  const R = recipes[name];
  if (!R) throw new Error(`没有配方 ${name}，可选 ${Object.keys(recipes).join(' ')}`);
  const p = { ...R.defaults, ...params };
  if (!Number.isInteger(variant) || !Number.isFinite(pitch) || !(pitch > 0)) throw new Error('renderRecipe: variant 必须为整数，pitch 必须有限且 > 0');
  if (seed != null && !Number.isFinite(seed)) throw new Error('renderRecipe: seed 必须有限');
  if (jitterSeed != null && !Number.isFinite(jitterSeed)) throw new Error('renderRecipe: jitterSeed 必须有限');
  for (const [key, value] of Object.entries(p)) {
    if (typeof R.defaults?.[key] === 'number' && typeof value !== 'number') throw new Error(`renderRecipe: ${name}.params.${key} 要是数字，收到 ${JSON.stringify(value)}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`renderRecipe: ${name}.params.${key} 必须有限`);
    if (POSITIVE.includes(key) && value != null && !(value > 0)) throw new Error(`renderRecipe: ${name}.params.${key} 必须 > 0，收到 ${value}${key === 'drive' ? '（drive 是软削波的驱动量，0 时归一系数 1/tanh(0) 无穷大）' : ''}`);
    if (POS_INT.includes(key) && value != null && !(Number.isInteger(value) && value > 0)) throw new Error(`renderRecipe: ${name}.params.${key} 必须是正整数`);
    if (key === 'pings' && !(Number.isInteger(value) && value >= 0)) throw new Error(`renderRecipe: ${name}.params.pings 必须是 ≥ 0 的整数`);
  }
  const s = (seed ?? (nameHash(name) + variant * 7919)) >>> 0;
  const r = seeded(s);
  const jp = typeof jitter === 'number' ? jitter : (jitter?.pitch ?? 0), jg = typeof jitter === 'number' ? 0 : (jitter?.gain ?? 0);
  if (!(Number.isFinite(jp) && jp >= 0 && jp < 1 && Number.isFinite(jg) && jg >= 0 && jg <= 1)) throw new Error('renderRecipe: jitter.pitch ∈ [0,1)，jitter.gain ∈ [0,1]');
  const jr = seeded(jitterSeed != null ? (jitterSeed >>> 0) : (s ^ 0x5bd1e995));
  const kj = 1 + jp * (jr() * 2 - 1), gj = 1 - jg * jr();
  const k = pick(R.variants, variant) * pitch * kj;
  const x = R.render(r, p, k, variant);
  if (!R.loop) { dcBlock(x); edges(x, 0.0003, 0.012); }
  normalize(x, PEAK * gj);
  for (let n = 0; n < x.length; n++) if (!Number.isFinite(x[n])) throw new Error(`renderRecipe: ${name} 输出第 ${n} 个样本是 ${x[n]}（参数 ${canon(p)}）：某个参数让配方算出了非有限数`);
  return { samples: x, variant, seed: s, pitch: +k.toFixed(5), gain: +gj.toFixed(4) };
}

/**
 * 把 cue 表里"type 是配方名"的 cue 展开成 samples（其他 cue 原样返回，同一个对象）。
 * 变体：写数字 = 钉死；不写时有 cue.id 按 hash(配方名, id) 取（插入别的事件不改它，代价是相邻两发可能同变体），
 *   没有 id 按同名配方的时间顺序轮换（第 n 次出现用 n mod 变体数；插入一个同名 cue 会让后面的全部换变体）。
 * jitter 的种子同理：hash(配方名, id) 或 hash(配方名, 出现序号)——不再每个变体一个固定抖动。
 * 同一张表里参数完全相同的 cue 只渲一次（按规范化参数缓存），返回的 samples 是共享的同一个数组，不要原地改。
 */
export function expandRecipes(cues, { recipes = RECIPES, sounds = {} } = {}) {
  const isRecipe = (c) => c && !c.samples && !c.file && c.type != null && !Object.hasOwn(sounds, c.type) && Object.hasOwn(recipes, c.type);
  if (!cues.some(isRecipe)) return cues;
  const order = cues.map((c, i) => [c, i]).filter(([c]) => isRecipe(c)).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]);
  const seen = {}, auto = new Map();
  for (const [c, i] of order) { const n = seen[c.type] ?? 0; seen[c.type] = n + 1; auto.set(i, n); }
  const cache = new Map();
  return cues.map((c, i) => {
    if (!isRecipe(c)) return c;
    const who = c.id != null ? `id:${c.id}` : `n:${auto.get(i)}`;
    const variant = Number.isInteger(c.variant) ? c.variant
      : c.id != null ? nameHash(`${c.type}\u0000variant\u0000${who}`) % recipes[c.type].variants.length
      : auto.get(i) % recipes[c.type].variants.length;
    const jitter = c.jitter ?? 0, still = jitter === 0 || (typeof jitter === 'object' && !jitter.pitch && !jitter.gain);
    const jitterSeed = still ? null : nameHash(`${c.type}\u0000jitter\u0000${who}`);
    const key = canon([c.type, c.params ?? {}, variant, c.seed ?? null, c.pitch ?? 1, still ? 0 : jitter, jitterSeed]);
    let out = cache.get(key);
    if (!out) { out = renderRecipe(c.type, { params: c.params, variant, seed: c.seed ?? null, pitch: c.pitch ?? 1, jitter, jitterSeed }, recipes); cache.set(key, out); }
    return { ...c, samples: out.samples, _recipe: { variant: out.variant, seed: out.seed, pitch: out.pitch, gain: out.gain } };
  });
}

// ───────────────────────── 空间：程序化冲激响应 ─────────────────────────
// 室外：离散早反射（越晚越暗）+ 低通从亮扫到暗的扩散尾巴 + 低频隆隆。
// 室内：密集早反射 + 扩散尾巴 + 房间驻波（窄带模态）+ 颤动回声（等间隔、逐次变暗）。
// 左右声道用不同种子去相关。scale 按比例拉长/缩短全部延迟与衰减，bright 乘全部低通截止。
export const SPACES = {
  outdoor: (r, { scale = 1, bright = 1 }, right) => {
    const o = buf(1.55 * scale), sh = right ? 1.07 : 0.96;
    const refl = [[0.062, 0.55, 4600], [0.089, 0.42, 3600], [0.118, 0.36, 2700], [0.151, 0.26, 2000], [0.178, 0.2, 1700], [0.243, 0.1, 1400]];
    for (const [at, a, lp] of refl) mixAt(o, noiseHit(r, { dur: 0.012, tau: 0.0018, hp: 700, lp: lp * bright }), (at * sh + between(r, -0.004, 0.004)) * scale, a * between(r, 0.6, 1.15));
    const tail = filter(white(1.3 * scale, r), 'hp', 300);
    sweep(tail, 'lp', expRamp(6000 * bright, 900 * bright, 0.6), 0.7);
    mixAt(o, normalize(shape(tail, decay(0.27 * scale, 0.04 * scale))), 0.04 * scale, 0.16);
    const rum = filter(white(1.0 * scale, r), 'lp', 150);
    mixAt(o, normalize(shape(rum, decay(0.26 * scale, 0.03 * scale))), 0.02 * scale, 0.12);
    return o;
  },
  indoor: (r, { scale = 1, bright = 1 }, right) => {
    const o = buf(2.3 * scale);
    const diff = white(2.25 * scale, r);
    sweep(diff, 'lp', expRamp(5200 * bright, 650 * bright, 0.5), 0.7);
    mixAt(o, normalize(shape(diff, decay(0.33 * scale, 0.006))), 0.012 * scale, 0.3);
    const low = filter(white(2.1 * scale, r), 'lp', 260);
    mixAt(o, normalize(shape(low, decay(0.4 * scale, 0.01))), 0.012 * scale, 0.35);
    for (const [f, a] of [[54, 1], [81, 0.8], [117, 0.6], [163, 0.45], [228, 0.3]]) {
      const m = filter(white(2.2 * scale, r), 'bp', f * (right ? 1.06 : 1) / Math.sqrt(scale), 9);
      mixAt(o, normalize(shape(m, decay(0.5 * scale, 0.02))), 0.01 * scale, a * 0.12);
    }
    for (const [at, a] of [[0.018, 0.7], [0.031, 0.55], [0.047, 0.45], [0.067, 0.38], [0.093, 0.3], [0.139, 0.2]])
      mixAt(o, noiseHit(r, { dur: 0.008, tau: 0.0015, lp: 4500 * bright }), at * (right ? 1.09 : 0.95) * scale, a);
    const gap = (right ? 0.051 : 0.044) * scale;
    for (let i = 1; i < 9; i++) mixAt(o, noiseHit(r, { dur: 0.05, tau: 0.009, hp: 500, lp: 3800 * bright / (1 + i * 0.35) }), gap * i + between(r, -0.003, 0.003), 0.42 * Math.pow(0.74, i));
    return o;
  },
};
const irCache = new Map();
/** space 的规范形：'outdoor' 与 { preset: 'outdoor' }、键序不同的对象都得到同一个 { preset, gain, scale, bright, seed } */
export function spaceSpec(space) {
  const spec = typeof space === 'string' ? { preset: space } : { ...space };
  if (!spec || !SPACES[spec.preset]) throw new Error(`space 只认 ${Object.keys(SPACES).join(' / ')}，或 { preset, gain, scale?, bright?, seed? }，收到 ${JSON.stringify(space)}`);
  for (const k of ['scale', 'bright']) if (spec[k] != null && !(Number.isFinite(spec[k]) && spec[k] > 0)) throw new Error(`space.${k} 必须有限且 > 0`);
  if (spec.gain != null && !(Number.isFinite(spec.gain) && spec.gain >= 0)) throw new Error('space.gain 必须有限且 ≥ 0');
  return { preset: spec.preset, gain: spec.gain ?? null, scale: spec.scale ?? 1, bright: spec.bright ?? 1, seed: spec.seed ?? 0 };
}
/** 分组键（规范化、与键序无关）。withGain=false 时只看冲激响应本身（同一个 IR 不同 gain 共用一次卷积） */
export const spaceKey = (space, withGain = true) => { const { gain, ...ir } = spaceSpec(space); return canon(withGain ? { ...ir, gain } : ir); };
/**
 * space: 'outdoor' | 'indoor' | { preset, gain, scale?, bright?, seed? } → { L, R, gain, key }（每声道归一到单位能量）。
 * gain 没有默认值（这里返回 null，renderStereo 用到时报错）：单位能量 IR 乘 1 时尾音能量与干声相当，已经很湿；多湿是片子的选择。
 */
export function makeIR(space) {
  const spec = spaceSpec(space);
  const key = spaceKey(spec, false);
  if (!irCache.has(key)) {
    const base = nameHash('space:' + spec.preset) + spec.seed * 7919;
    const [L, R] = [0, 1].map((ch) => {
      const h = SPACES[spec.preset](seeded(base + ch * 131), spec, ch === 1);
      let e = 0; for (let n = 0; n < h.length; n++) e += h[n] * h[n];
      const g = e > 0 ? 1 / Math.sqrt(e) : 0; for (let n = 0; n < h.length; n++) h[n] *= g;
      return h;
    });
    irCache.set(key, { L, R });
  }
  return { ...irCache.get(key), gain: spec.gain, key };
}

// 基 2 FFT（确定：同一输入同一运算顺序）。旋转因子与位反转表按长度缓存；短级（half < 64）按旋转因子外层循环，长级按块外层循环
const twiddles = new Map(), revs = new Map();
function twiddleOf(n) {
  let t = twiddles.get(n);
  if (!t) {
    const c = new Float64Array(n >> 1), s = new Float64Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) { c[k] = Math.cos(TAU * k / n); s[k] = Math.sin(TAU * k / n); }
    t = { c, s }; twiddles.set(n, t);
  }
  return t;
}
function revOf(n) {
  let r = revs.get(n);
  if (!r) { r = new Uint32Array(n); for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; r[i] = j; } revs.set(n, r); }
  return r;
}
function fft(re, im, inv) {
  const n = re.length;
  if (n < 2) return;
  const r = revOf(n);
  for (let i = 1; i < n; i++) { const j = r[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let i = 0; i < n; i += 2) { const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1]; re[i] = ar + br; im[i] = ai + bi; re[i + 1] = ar - br; im[i + 1] = ai - bi; }
  const { c: cw, s: sw0 } = twiddleOf(n), sg = inv ? 1 : -1;
  for (let len = 4; len <= n; len <<= 1) {
    const half = len >> 1, stride = n / len;
    if (half < 64) {
      for (let k = 0, w = 0; k < half; k++, w += stride) {
        const c = cw[w], s = sg * sw0[w];
        for (let p = k; p < n; p += len) { const q = p + half, qr = re[q], qi = im[q], xr = qr * c - qi * s, xi = qr * s + qi * c, pr = re[p], pi = im[p]; re[q] = pr - xr; im[q] = pi - xi; re[p] = pr + xr; im[p] = pi + xi; }
      }
    } else {
      for (let i = 0; i < n; i += len) for (let k = 0, w = 0; k < half; k++, w += stride) {
        const c = cw[w], s = sg * sw0[w];
        const p = i + k, q = p + half, qr = re[q], qi = im[q], xr = qr * c - qi * s, xi = qr * s + qi * c, pr = re[p], pi = im[p]; re[q] = pr - xr; im[q] = pi - xi; re[p] = pr + xr; im[p] = pi + xi;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** x * h（线性卷积），返回长 x.length + h.length − 1 */
export function convolve(x, h) {
  const len = x.length + h.length - 1;
  let n = 1; while (n < len) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(h);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, len));
}

// IR 频谱缓存：同一个 IR 数组（makeIR 已缓存）在同一 FFT 长度下只变换一次
const specCache = new WeakMap();
function spectrumOf(h, M) {
  let m = specCache.get(h); if (!m) { m = new Map(); specCache.set(h, m); }
  let S = m.get(M);
  if (!S) { const re = new Float64Array(M), im = new Float64Array(M); re.set(h); fft(re, im, false); S = { re, im }; m.set(M, S); }
  return S;
}
/**
 * 单声道输入 x 同时卷左右两条 IR：分块重叠相加（块长按"非零块数 × M log M"最小选，M ≤ max(2^18, 2·IR 长)），全零块跳过；
 * 两个输入块拼成一个复数做正变换（实部/虚部各一块），左右 IR 各一次逆变换，实部/虚部各是一块的输出。
 * 返回 [yL, yR]（Float64Array，长 x.length + max(hL, hR) − 1）。与 convolve() 逐路结果在浮点误差内相同。
 * 给了 into = { L, R, at }：直接叠进 L/R 的 at 起处（越界截掉），不分配整段输出，返回 into。
 */
export function convolveStereo(x, hL, hR, into = null) {
  const hLen = Math.max(hL.length, hR.length), full = x.length + hLen - 1;
  const at = into?.at ?? 0, outLen = into ? Math.max(0, Math.min(full, into.L.length - at)) : full;
  const yL = into ? into.L : new Float64Array(outLen), yR = into ? into.R : new Float64Array(outLen);
  const done = () => (into ?? [yL, yR]);
  const CH = 1024, nz = new Uint8Array(Math.ceil(x.length / CH));
  for (let n = 0; n < x.length; n++) if (x[n] !== 0) { nz[(n / CH) | 0] = 1; n = ((n / CH) | 0) * CH + CH - 1; }
  let p2 = 1; while (p2 < hLen) p2 <<= 1;
  let best = null;
  // M 的上限 2^18：实测（V8）2^18 以上每蝶形慢约 1.7 倍（数组出缓存），块数省下的抵不过
  for (let M = p2 * 2; M <= Math.max(p2 * 2, 1 << 18); M <<= 1) {
    const B = M - hLen + 1; let blocks = 0;
    for (let s0 = 0; s0 < x.length; s0 += B) { for (let c = (s0 / CH) | 0; c * CH < Math.min(x.length, s0 + B); c++) if (nz[c]) { blocks++; break; } }
    const cost = blocks * M * Math.log2(M);
    if (!best || cost < best.cost) best = { M, B, cost };
  }
  if (!best || best.cost === 0) return done();
  const { M, B } = best, HL = spectrumOf(hL, M), HR = spectrumOf(hR, M);
  const nonzero = (s0) => { const e0 = Math.min(x.length, s0 + B); for (let c = (s0 / CH) | 0; c * CH < e0; c++) if (nz[c]) return true; return false; };
  const starts = []; for (let s0 = 0; s0 < x.length; s0 += B) if (nonzero(s0)) starts.push(s0);
  // 两个实数块一次正变换：z = a + i·b，h 是实数 ⇒ IFFT(Z·H) = a*h + i·(b*h)。每两块 1 次正变换 + 左右各 1 次逆变换
  const zr = new Float64Array(M), zi = new Float64Array(M), re = new Float64Array(M), im = new Float64Array(M);
  const addOut = (y, s0, src) => { if (s0 < 0) return; const lim = Math.min(M, outLen - s0); for (let n = 0; n < lim; n++) y[at + s0 + n] += src[n]; };
  for (let j = 0; j < starts.length; j += 2) {
    const a0 = starts[j], b0 = j + 1 < starts.length ? starts[j + 1] : -1;
    zr.fill(0); zi.fill(0);
    for (let n = a0, e = Math.min(x.length, a0 + B); n < e; n++) zr[n - a0] = x[n];
    if (b0 >= 0) for (let n = b0, e = Math.min(x.length, b0 + B); n < e; n++) zi[n - b0] = x[n];
    fft(zr, zi, false);
    for (const [H, y] of [[HL, yL], [HR, yR]]) {
      for (let i = 0; i < M; i++) { const xr = zr[i], xi = zi[i]; re[i] = xr * H.re[i] - xi * H.im[i]; im[i] = xr * H.im[i] + xi * H.re[i]; }
      fft(re, im, true);
      addOut(y, a0, re); addOut(y, b0, im);
    }
  }
  return done();
}

/**
 * 尾音挂在哪些 cue 上（对整张 cue 表一次性决定，确定）。返回 Map<cue 下标, space>。
 * 显式：只要表里有任何一个 cue 写了 tail 字段（true/false），就严格按 tail——tail: true 的挂（它必须有 space），其余都不挂，
 *   rule 不再参与（事件表 burstEnds → toCues 给连射末发写 tail: true，声音与画面读同一张表）。
 * 自判（表里完全没有 tail 字段）：同一个 space（规范化后比较，与键序无关）的 cue 按时间排序，相邻间隔 < burstGap 算一串，
 *   一串只在最后一个 cue 上挂；edges: 'both' 也保留开头；写了 throttle 时，串中离上一次尾音 ≥ throttle 的也挂。
 *   burstGap 没有默认值：多近算"一串"取决于这支片的射速/步频。
 */
export function planTails(cues, rule) {
  const plan = new Map();
  if (cues.some((c) => c && c.tail !== undefined)) {
    cues.forEach((c, i) => {
      if (c.tail === undefined) return;
      if (typeof c.tail !== 'boolean') throw new Error(`cue #${i}：tail 只认 true / false，收到 ${JSON.stringify(c.tail)}`);
      if (!c.tail) return;
      if (c.space == null) throw new Error(`cue #${i}（t=${c.t}）写了 tail: true，但没有 space（尾音是哪个空间的）`);
      spaceSpec(c.space); plan.set(i, c.space);
    });
    return plan;
  }
  if (!cues.some((c) => c.space != null)) return plan;
  const { burstGap, throttle = null, edges = 'end' } = rule ?? {};
  if (burstGap == null) throw new Error('有 cue 写了 space，但表里没有任何 tail 字段，也没给 spaceRule.burstGap。二选一：'
    + 'cue 上显式写 tail（事件表 burstEnds → toCues 给连射末发写 tail: true），或顶层写 spaceRule.burstGap（秒：相邻间隔小于它算一串，只在串尾挂尾音；'
    + '参考量级：自动武器连射 0.1–0.2，脚步 0.3–0.5；太大会把分开的事件并成一串、吞掉尾音，太小每发都挂尾音会糊）');
  if (!(Number.isFinite(burstGap) && burstGap > 0) || (throttle != null && !(Number.isFinite(throttle) && throttle > 0)) || !['end', 'both'].includes(edges)) throw new Error('spaceRule: burstGap/throttle 要为正秒数，edges 要为 end 或 both');
  const groups = new Map();
  cues.forEach((c, i) => { if (c.space != null) { const k = spaceKey(c.space); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); } });
  for (const idx of groups.values()) {
    idx.sort((a, b) => cues[a].t - cues[b].t || a - b);
    let lastTail = -Infinity;
    for (let j = 0; j < idx.length; j++) {
      const i = idx[j], t = cues[i].t;
      const first = j === 0 || t - cues[idx[j - 1]].t >= burstGap;
      const last = j === idx.length - 1 || cues[idx[j + 1]].t - t >= burstGap;
      const thr = throttle != null && t - lastTail >= throttle;
      if ((edges === 'both' && first) || last || thr) { plan.set(i, cues[i].space); lastTail = t; }
    }
  }
  return plan;
}

// ───────────────────────── 总线：闷音、压低、压缩、软削波 ─────────────────────────
const asSpec = (v, key) => (typeof v === 'number' ? { [key]: v } : v);
/** 闷音强度 Z(t) = max_e z_e·e^(−(t−t_e)/recover_e)；cue.muffle = { amount, recover }，recover 必填（没有默认恢复时间） */
export function muffleCurve(cues, N) {
  const ev = cues.filter((c) => c.muffle != null).map((c) => { const s = asSpec(c.muffle, 'amount'), z = s.amount, tau = s.recover;
    if (tau == null) throw new Error(`muffle 要写 { amount, recover }（t=${c.t}）：recover 是闷音恢复的时间常数（秒），参考 0.6–1.5（耳鸣式的长闷 1 以上，只想压一下高频 0.3–0.6）；越长遮蔽后面的信息越久`);
    if (!(Number.isFinite(c.t) && Number.isFinite(z) && z >= 0 && z <= 1 && Number.isFinite(tau) && tau > 0)) throw new Error('muffle: t 必须有限，amount ∈ [0,1]，recover 必须有限且 > 0');
    return { t: c.t, z, tau }; });
  if (!ev.length) return null;
  const Z = new Float32Array(N);
  for (const e of ev) {
    const first = Math.round(e.t * SR), o = Math.max(0, first), end = Math.min(N, first + Math.ceil(e.tau * 9 * SR));
    for (let n = o; n < end; n++) { const z = e.z * Math.exp(-(n - first) / SR / e.tau); if (z > Z[n]) Z[n] = z; }
  }
  return Z;
}
/** Z → 低通截止 Hz：20000·0.03^Z（Z=0.2 ≈ 9.9 kHz，0.5 ≈ 3.5 kHz，0.8 ≈ 1.2 kHz） */
export const muffleCutoff = (z) => 20000 * Math.pow(0.03, z);
/** 按 Z 曲线给一条声道做时变低通（原地）。Z < 0.02 处与原信号平滑交叉，没闷音的段落逐样本不变 */
export function applyMuffle(x, Z, step = 32) {
  let z1 = 0, z2 = 0, k = null;
  for (let n = 0; n < x.length; n++) {
    const z = Z[Math.min(n, Z.length - 1)];
    if (n % step === 0) k = biquad('lp', muffleCutoff(z), 0.5);
    const s = x[n], y = k[0] * s + z1;
    z1 = k[1] * s - k[3] * y + z2; z2 = k[2] * s - k[4] * y;
    const w = Math.min(1, z / 0.02);
    if (w > 0) x[n] = s + (y - s) * w;
  }
  return x;
}
/** 配乐增益曲线 g(t) = min_e [1 − (1 − depth_e)·e^(−(t−t_e)/recover_e)]；cue.duck = { depth（压到的线性增益）, recover }，recover 必填 */
export function duckCurve(cues, N) {
  const ev = cues.filter((c) => c.duck != null).map((c) => { const s = asSpec(c.duck, 'depth'), d = s.depth, tau = s.recover;
    if (tau == null) throw new Error(`duck 要写 { depth, recover }（t=${c.t}）：recover 是配乐回升的时间常数（秒），参考 0.2–0.4（短促冲击）到 1 以上（大事件后留白）；太短听得出配乐"泵"，太长配乐空掉`);
    if (!(Number.isFinite(c.t) && Number.isFinite(d) && d >= 0 && d <= 1 && Number.isFinite(tau) && tau > 0)) throw new Error('duck: t 必须有限，depth ∈ [0,1]，recover 必须有限且 > 0');
    return { t: c.t, d, tau }; });
  if (!ev.length) return null;
  const G = new Float32Array(N).fill(1);
  for (const e of ev) {
    const first = Math.round(e.t * SR), o = Math.max(0, first), end = Math.min(N, first + Math.ceil(e.tau * 9 * SR));
    for (let n = o; n < end; n++) { const g = 1 - (1 - e.d) * Math.exp(-(n - first) / SR / e.tau); if (g < G[n]) G[n] = g; }
  }
  return G;
}

/** 前馈压缩器（立体声联动、峰值检测、软拐点），原地。{ threshold dB, ratio, attack s, release s, knee dB, makeup dB } */
export function compress(L, R, { threshold = -10, ratio = 6, attack = 0.002, release = 0.14, knee = 6, makeup = 0 } = {}) {
  if (![threshold, ratio, attack, release, knee, makeup].every(Number.isFinite) || ratio < 1 || attack <= 0 || release <= 0 || knee < 0) throw new Error('compress: 参数必须有限，ratio ≥ 1，attack/release > 0，knee ≥ 0');
  const ca = Math.exp(-1 / (attack * SR)), cr = Math.exp(-1 / (release * SR));
  let g = 0, maxGr = 0;
  for (let n = 0; n < L.length; n++) {
    const x = 20 * Math.log10(Math.max(1e-9, Math.abs(L[n]), Math.abs(R[n]))), d = x - threshold;
    let y;
    if (2 * d < -knee) y = x;
    else if (knee > 0 && 2 * Math.abs(d) <= knee) y = x + (1 / ratio - 1) * (d + knee / 2) ** 2 / (2 * knee);
    else y = threshold + d / ratio;
    const gr = y - x;
    g = gr < g ? ca * g + (1 - ca) * gr : cr * g + (1 - cr) * gr;
    if (g < maxGr) maxGr = g;
    const m = Math.pow(10, (g + makeup) / 20);
    L[n] *= m; R[n] *= m;
  }
  return { maxReductionDb: +(-maxGr).toFixed(2) };
}
/** 软拐点削波（原地）：|x| ≤ knee 线性，以上 knee + (1−knee)·tanh((|x|−knee)/(1−knee))，渐近 ±1 */
export function kneeClip(x, knee = 0.6) {
  if (!(Number.isFinite(knee) && knee >= 0 && knee < 1)) throw new Error('kneeClip: knee ∈ [0,1)');
  for (let n = 0; n < x.length; n++) {
    const a = Math.abs(x[n]);
    if (a > knee) x[n] = Math.sign(x[n]) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return x;
}
/** 总线末级：master = { comp?: {...}, trim?: 线性增益, clip?: { knee } | true } */
export function applyMaster(L, R, master) {
  const info = {};
  if (master.comp) info.comp = compress(L, R, master.comp === true ? {} : master.comp);
  if (master.trim != null) for (let n = 0; n < L.length; n++) { L[n] *= master.trim; R[n] *= master.trim; }
  if (master.clip) { const k = master.clip === true ? 0.6 : (master.clip.knee ?? 0.6); kneeClip(L, k); kneeClip(R, k); info.clip = { knee: k }; }
  return info;
}

// ───────────────────────── 自测统计 ─────────────────────────
/** 峰值、过载样本数（|x| > 1）、NaN、直流偏移、整体 RMS、每 win 秒的 RMS（dBFS） */
export function stats(chs, { win = 0.5 } = {}) {
  const N = chs[0].length, db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);
  let peak = 0, over = 0, nan = 0, sum = 0, sq = 0;
  const W = Math.max(1, Math.round(win * SR)), wins = new Float64Array(Math.ceil(N / W));
  for (const x of chs) for (let n = 0; n < N; n++) {
    const v = x[n];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 1) over++;
    sum += v; sq += v * v; wins[Math.floor(n / W)] += v * v;
  }
  const cnt = N * chs.length;
  return {
    seconds: +(N / SR).toFixed(3), channels: chs.length, peak: +peak.toFixed(4), peakDb: db(peak), over, nan,
    dc: +(sum / cnt).toExponential(2), rmsDb: db(Math.sqrt(sq / cnt)),
    win, windowsDb: Array.from(wins, (e, i) => db(Math.sqrt(e / (Math.min(W, N - i * W) * chs.length)))),
  };
}
