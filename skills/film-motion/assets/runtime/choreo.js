// film-motion 运行时 · 缓动与编排（纯数学：浏览器和 Node 都能 import）
//
// 三件事：
//   1. EASE：缓动词汇表（Penner 族 + 预备动作 + 回弹 + 指数 + CSS cubic-bezier + 弹簧归一化）。
//      **没有默认缓动**：transitions.js / textfx.js 的每个入口都要求调用方显式给 ease，
//      给什么由本片 style_guide 定。`easeInfo()` 能把任意缓动量出过冲/预备/峰值时刻，代价表就是它量的。
//   2. stagger()：交错编排器——一组元素按顺序 / 到某点的距离 / 网格 / 种子随机错开（借 GSAP stagger 的参数语义）。
//   3. timeline()：镜头 + 转场的数据结构（借 Remotion TransitionSeries 的"转场吃掉两侧重叠"语义，
//      但边界用剪辑点 + align 表达，剪辑点可以直接是 narration 的字时间戳）。
//
// 全部是 t 的纯函数；timeline() 在加载时建一次，seek 里只查表。
// 场景 import './runtime/choreo.js'；它 import './motion.js'（film-core 提供，同一张挂载表）。Node 里先 film-core
// lib/runtime-node.mjs 的 registerRuntimeResolver()。

import { sat, settle, springInfo, seeded, win } from './motion.js';

// ===========================================================================
// 1. 缓动
// ===========================================================================
const PI = Math.PI;
const family = (fin) => ({
  in: fin,
  out: (p) => 1 - fin(1 - p),
  inOut: (p) => (p < 0.5 ? fin(2 * p) / 2 : 1 - fin(2 - 2 * p) / 2),
  outIn: (p) => (p < 0.5 ? (1 - fin(1 - 2 * p)) / 2 : 0.5 + fin(2 * p - 1) / 2),
});
const pow = (k) => (p) => p ** k;
const backIn = (s) => (p) => p * p * ((s + 1) * p - s);
function bounceOut(p) {
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
}
const elasticOut = (amp = 1, period = 0.3) => {
  const a = Math.max(1, amp);
  const s = (period / (2 * PI)) * Math.asin(1 / a);
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : a * 2 ** (-10 * p) * Math.sin(((p - s) * 2 * PI) / period) + 1);
};
const flip = (fout) => (p) => 1 - fout(1 - p);

/** 缓动表。每一族有 in / out / inOut / outIn。值域：back、elastic 越界（那是它们的意义）；其余 [0,1]。 */
export const EASE = Object.freeze({
  linear: (p) => p,
  sine: family((p) => 1 - Math.cos((p * PI) / 2)),
  quad: family(pow(2)),
  cubic: family(pow(3)),
  quart: family(pow(4)),
  quint: family(pow(5)),
  expo: family((p) => (p <= 0 ? 0 : 2 ** (10 * p - 10))),
  circ: family((p) => 1 - Math.sqrt(Math.max(0, 1 - p * p))),
  back: family(backIn(1.70158)),           // in = 预备动作（先往反方向退 10%），out = 过冲 10%
  elastic: family(flip(elasticOut())),
  bounce: family(flip(bounceOut)),
});

/** 参数化的缓动工厂。返回 p -> 值 的函数。 */
export const easeOf = {
  /** 幂次可连续调：power(2.5).out */
  power: (k) => family(pow(k)),
  /** 回拉/过冲幅度可调：s=1.70158 时约 10% */
  back: (s) => family(backIn(s)),
  /** amp ≥ 1 振幅，period 周期（占全程比例） */
  elastic: (amp, period) => family(flip(elasticOut(amp, period))),
  /**
   * 预备动作（anticipation）：先用 at 比例的时间退到 -pull，再用 release 缓动冲向 1。
   * 退的那段末速度为 0，释放段起速由 release 决定——expo.out 之类会在交界处速度突变，读作"蓄力后弹出"。
   */
  anticipate: ({ pull, at, release }) => {
    if (!(pull >= 0 && at > 0 && at < 1)) throw new Error('anticipate 需要 pull ≥ 0 与 0 < at < 1');
    const rel = resolveEase(release);
    return (p) => (p <= 0 ? 0 : p >= 1 ? 1
      : p < at ? -pull * (1 - Math.cos(PI * (p / at))) / 2
      : -pull + (1 + pull) * rel((p - at) / (1 - at)));
  },
  /** CSS cubic-bezier(x1,y1,x2,y2)：和浏览器同一条曲线（Newton + 二分求 x→t，误差 < 1e-7） */
  cubicBezier: (x1, y1, x2, y2) => cubicBezier(x1, y1, x2, y2),
  /** CSS steps(n, jump-end | jump-start | jump-none | jump-both) */
  steps: (n, jump = 'jump-end') => (p) => {
    const q = sat(p);
    if (jump === 'jump-start') return Math.min(1, Math.ceil(q * n) / n);
    if (jump === 'jump-none') return n > 1 ? Math.min(1, Math.floor(q * n) / (n - 1)) : q < 1 ? 0 : 1;
    if (jump === 'jump-both') return Math.min(1, (Math.floor(q * n) + 1) / (n + 1));
    return q >= 1 ? 1 : Math.floor(q * n) / n;
  },
  /** 弹簧当缓动：把 spring({duration, overshoot}) 的停止时长归一到 p=1（p≥1 精确为 1）。 */
  spring: (sp) => {
    const { duration } = springInfo(sp);
    return (p) => (p >= 1 ? 1 : p <= 0 ? 0 : settle(p * duration, sp.stiffness, sp.damping));
  },
  /** 两条缓动按 k 混合（k=0 全 a） */
  blend: (a, b, k) => { const A = resolveEase(a), B = resolveEase(b); return (p) => A(p) * (1 - k) + B(p) * k; },
  /** 往返：0→1→0（yoyo） */
  mirror: (e) => { const E = resolveEase(e); return (p) => (p < 0.5 ? E(2 * p) : E(2 - 2 * p)); },
  /** 反向：in ↔ out */
  reverse: (e) => { const E = resolveEase(e); return (p) => 1 - E(1 - p); },
};

function cubicBezier(x1, y1, x2, y2) {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) throw new Error('cubicBezier 的 x1/x2 必须在 [0,1]（同 CSS）');
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (u) => ((ax * u + bx) * u + cx) * u;
  const Y = (u) => ((ay * u + by) * u + cy) * u;
  const dX = (u) => (3 * ax * u + 2 * bx) * u + cx;
  const solve = (x) => {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const e = X(u) - x;
      if (Math.abs(e) < 1e-7) return u;
      const d = dX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= e / d;
    }
    let lo = 0, hi = 1; u = x;
    for (let i = 0; i < 60; i++) { const v = X(u); if (Math.abs(v - x) < 1e-7) break; if (v < x) lo = u; else hi = u; u = (lo + hi) / 2; }
    return u;
  };
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Y(solve(p)));
}

/** 'cubic.out' / 'linear' / 函数 → 函数。没给或拼错直接抛错：**这里没有默认缓动**。 */
export function resolveEase(e) {
  if (typeof e === 'function') return e;
  if (typeof e === 'string') {
    if (e === 'linear') return EASE.linear;
    const [fam, dir] = e.split('.');
    const f = EASE[fam]?.[dir];
    if (typeof f === 'function') return f;
    throw new Error(`缓动「${e}」不存在。可用：linear，或 <族>.<in|out|inOut|outIn>，族 = ${Object.keys(EASE).filter((k) => k !== 'linear').join(' / ')}；参数化的见 easeOf`);
  }
  throw new Error('没有给缓动（ease）。本套件不替你选缓动——从 EASE / easeOf 里按本片 style_guide 挑一个显式传进来');
}

/**
 * 量一条缓动：{ min, max, overshoot, anticipation, peakAt, monotonic, halfAt }。
 * overshoot = max-1（冲过终点多少），anticipation = -min（先往回退多少），halfAt = 第一次到 0.5 的 p（"重心"）。
 */
export function easeInfo(e, n = 4000) {
  const f = resolveEase(e);
  let min = Infinity, max = -Infinity, peakAt = 0, mono = true, prev = f(0), halfAt = null;
  for (let i = 0; i <= n; i++) {
    const p = i / n, v = f(p);
    if (v < min) min = v;
    if (v > max) { max = v; peakAt = p; }
    if (v < prev - 1e-12) mono = false;
    if (halfAt === null && v >= 0.5) halfAt = p;
    prev = v;
  }
  return { min, max, overshoot: Math.max(0, max - 1), anticipation: Math.max(0, -min), peakAt, monotonic: mono, halfAt };
}

// 区间进度 win(t, start, dur, ease) 在 film-core 的 motion.js（ease 给函数：win(t, 1.2, 0.6, EASE.back.out)）。

/** 入场 × 出场包络：envelope(t, [inStart, inDur, inEase], [outStart, outDur, outEase]) → 0..1（out 可省；ease 可写 'quad.out' 或函数） */
export function envelope(t, enter, exit = null) {
  const a = win(t, enter[0], enter[1], resolveEase(enter[2]));
  return exit ? a * (1 - win(t, exit[0], exit[1], resolveEase(exit[2]))) : a;
}

// ===========================================================================
// 2. 交错编排器
// ===========================================================================
/**
 * stagger(n, opts) → Float64Array 延迟（秒），另带 .total（最大延迟）。加载时算一次，seek 里只读。
 * 参数语义借 GSAP 的 stagger 对象：
 *   each    每单位距离的延迟（秒）       } 两者必给其一：**没有默认间隔**
 *   amount  全部延迟铺开的总时长（秒）   }
 *   from    'start' | 'end' | 'center' | 'edges' | 'random' | 下标 | [fx, fy]（网格/坐标里的归一化点）
 *   grid    [cols, rows]：按网格位置算距离；positions：[{x,y}]（比如 splitText 的字心）按真实坐标算距离
 *   axis    'x' | 'y'：只按一个轴的距离
 *   ease    把"归一化距离 → 延迟"再过一道缓动（GSAP 的 stagger ease）：前密后疏 / 前疏后密
 *   seed    from:'random' 时必给（种子随机；Math.random 违反契约）
 */
export function stagger(n, { each, amount, from = 'start', grid = null, positions = null, axis = null, ease = 'linear', seed } = {}) {
  if (!(n >= 0)) throw new Error('stagger: n 必须 ≥ 0');
  if (each == null && amount == null) throw new Error('stagger: 给 each（每步秒数）或 amount（总铺开秒数）——没有默认间隔');
  const E = resolveEase(ease);
  const out = new Float64Array(n);
  if (n === 0) { out.total = 0; return out; }
  let pos;
  if (positions) {
    if (positions.length !== n) throw new Error(`stagger: positions 有 ${positions.length} 个，n = ${n}`);
    pos = positions.map((q) => [q.x, q.y ?? 0]);
  } else if (grid) {
    const [cols] = grid;
    pos = Array.from({ length: n }, (_, i) => [i % cols, Math.floor(i / cols)]);
  } else pos = Array.from({ length: n }, (_, i) => [i, 0]);

  let d;
  if (from === 'random') {
    if (seed == null) throw new Error('stagger: from:"random" 必须给 seed');
    const r = seeded(seed);
    const keys = Array.from({ length: n }, (_, i) => [r(), i]).sort((a, b) => a[0] - b[0]);
    d = new Array(n);
    keys.forEach(([, i], rank) => { d[i] = rank; });
  } else {
    const xs = pos.map((q) => q[0]), ys = pos.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let o;
    if (from === 'start') o = pos[0];
    else if (from === 'end') o = pos[n - 1];
    else if (from === 'center' || from === 'edges') o = [(x0 + x1) / 2, (y0 + y1) / 2];
    else if (typeof from === 'number') { if (!pos[from]) throw new Error(`stagger: from 下标 ${from} 越界`); o = pos[from]; }
    else if (Array.isArray(from)) o = [x0 + from[0] * (x1 - x0), y0 + (from[1] ?? 0) * (y1 - y0)];
    else throw new Error(`stagger: 不认识的 from「${from}」`);
    d = pos.map(([x, y]) => {
      const dx = x - o[0], dy = y - o[1];
      return axis === 'x' ? Math.abs(dx) : axis === 'y' ? Math.abs(dy) : Math.hypot(dx, dy);
    });
    if (from === 'edges') { const m = Math.max(...d); d = d.map((v) => m - v); }
  }
  const maxD = Math.max(...d) || 1;
  const total = amount != null ? amount : each * maxD;
  for (let i = 0; i < n; i++) out[i] = E(d[i] / maxD) * total;
  out.total = total;
  return out;
}

// ===========================================================================
// 3. 时间轴：镜头 + 转场
// ===========================================================================
/**
 * timeline(items, { start, end }) —— 加载时建一次。
 *
 * items 是镜头与转场交替的数组：
 *   { shot: 'a', paint(ctx, lt, sh) {...}, ...任意自定义字段 }
 *   { cut: 2.4, kind: 'wipe', dur: 0.6, align: 0.5, ease: 'cubic.inOut', ...该转场的参数 }
 *   { shot: 'b', paint }
 *   { cut: vo.at('纯函数'), kind: 'cut' }        // 剪辑点直接是旁白的字时间戳（参见 film-narration）
 *   ...
 *
 * 语义：
 *   - `cut` 是**剪辑点**（绝对秒）。镜头 k 的名义区间 = [cut_{k-1}, cut_k]。
 *   - 转场窗口 = [cut - align·dur, cut + (1-align)·dur)。align = 0.5 骑在剪辑点上；
 *     align = 1 = 转场在这个字**念到时完成**；align = 0 = 从这个字开始。
 *   - 窗口内两个镜头都在画、各走各的局部时间（Remotion TransitionSeries 同语义：转场吃掉两侧的重叠，不冻结）。
 *   - 镜头的局部时间 lt 从它**第一帧可见**算起（= 前一个转场窗口的起点）。
 *   - kind:'cut' 且 dur 省略 = 硬切。别的 kind 必须给 dur 和 ease（没有默认）。
 *
 * at(t) → { type:'shot', shot, lt } | { type:'transition', tr, a:{shot, lt}, b:{shot, lt}, p, pe }
 *   p 是转场原始进度 [0,1)，pe = tr.ease(p)。窗口右端开：t = 窗口终点那一帧只画 B。
 */
export function timeline(items, { start = 0, end } = {}) {
  if (!(end > start)) throw new Error('timeline: 必须给 end（片长，通常 = window.DURATION）');
  const shots = [], trs = [];
  items.forEach((it, i) => {
    const isShot = 'shot' in it, isCut = 'cut' in it;
    if (isShot === isCut) throw new Error(`timeline: 第 ${i} 项要么是 {shot, paint}，要么是 {cut, kind}`);
    if ((i % 2 === 0) !== isShot) throw new Error(`timeline: 第 ${i} 项顺序不对——必须镜头、转场、镜头……交替，首尾都是镜头`);
    if (isShot) {
      if (typeof it.paint !== 'function') throw new Error(`timeline: 镜头 ${it.shot} 没有 paint(ctx, lt, sh)`);
      shots.push({ ...it, name: it.shot });
    } else {
      const kind = it.kind;
      if (!kind) throw new Error(`timeline: 剪辑点 ${it.cut} 没有 kind（硬切写 kind:'cut'）——没有默认转场`);
      const dur = it.dur ?? 0;
      if (kind !== 'cut' && !(dur > 0)) throw new Error(`timeline: ${kind} 转场必须给 dur > 0`);
      if (dur > 0 && it.ease == null) throw new Error(`timeline: ${kind} 转场（剪辑点 ${it.cut}）没有给 ease——没有默认缓动`);
      const align = it.align ?? 0.5;
      if (!(align >= 0 && align <= 1)) throw new Error('timeline: align 必须在 [0,1]');
      if (!Number.isFinite(it.cut)) throw new Error(`timeline: 剪辑点不是有限数 ${it.cut}（vo.at 没找到字？）`);
      trs.push({ ...it, kind, dur, align, ease: dur > 0 ? resolveEase(it.ease) : null,
        t0: it.cut - align * dur, t1: it.cut + (1 - align) * dur });
    }
  });
  if (!shots.length || items.length % 2 === 0) throw new Error('timeline: 首尾都必须是镜头');
  for (let k = 0; k < trs.length; k++) {
    const tr = trs[k];
    const lo = k ? trs[k - 1].cut : start, hi = k + 1 < trs.length ? trs[k + 1].cut : end;
    if (!(tr.cut > lo && tr.cut < hi)) throw new Error(`timeline: 剪辑点必须严格递增且在 (${start}, ${end}) 内，第 ${k} 个是 ${tr.cut}`);
    if (k && tr.t0 < trs[k - 1].t1 - 1e-9) throw new Error(`timeline: 转场 ${k - 1} 与 ${k} 的窗口重叠（${trs[k - 1].t1.toFixed(3)} > ${tr.t0.toFixed(3)}），一个镜头不能同时在两个转场里`);
    if (tr.t0 < start - 1e-9 || tr.t1 > end + 1e-9) throw new Error(`timeline: 转场窗口 [${tr.t0}, ${tr.t1}] 超出片子 [${start}, ${end}]`);
  }
  shots.forEach((s, k) => {
    s.index = k;
    s.cutIn = k ? trs[k - 1].cut : start;
    s.cutOut = k < trs.length ? trs[k].cut : end;
    s.start = k ? trs[k - 1].t0 : start;            // 第一帧可见
    s.end = k < trs.length ? trs[k].t1 : end;        // 最后一帧可见（右端开）
    s.dur = s.end - s.start;
  });
  trs.forEach((tr, k) => { tr.index = k; tr.a = shots[k]; tr.b = shots[k + 1]; });

  const at = (t) => {
    for (const tr of trs) {
      if (tr.dur > 0 && t >= tr.t0 && t < tr.t1) {
        const p = (t - tr.t0) / tr.dur;
        return { type: 'transition', tr, p, pe: tr.ease(p), t,
          a: { shot: tr.a, lt: t - tr.a.start }, b: { shot: tr.b, lt: t - tr.b.start } };
      }
    }
    let k = 0;
    while (k < trs.length && t >= trs[k].cut) k++;
    const s = shots[k];
    return { type: 'shot', shot: s, lt: t - s.start, t };
  };
  return {
    shots, transitions: trs, start, end, at,
    /** 给 window.MARKS 用：每个镜头的名义区间（剪辑点到剪辑点）。stills.mjs 不给 --at 时取它们的中点。 */
    marks: () => shots.map((s) => ({ label: s.name, start: s.cutIn, end: s.cutOut })),
    /** 每个转场的窗口，给评审/调试看 */
    transitionMarks: () => trs.filter((tr) => tr.dur > 0).map((tr) => ({ label: `${tr.a.name}→${tr.b.name} ${tr.kind}`, start: tr.t0, end: tr.t1, cut: tr.cut })),
  };
}

/** 时长链 → 剪辑点：cutsFrom(0, [1.2, 0.9, 1.4]) → [1.2, 2.1, 3.5]。有旁白时剪辑点直接用 film-narration 的 vo.at('字') / vo.endOf('字')，这只是无旁白时的写法。 */
export function cutsFrom(start, durations) {
  let acc = start;
  return durations.map((d) => (acc += d));
}
