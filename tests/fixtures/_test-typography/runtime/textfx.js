// film-typography 运行时 · 文字动画（kinetic typography）
//
// 用法：scene.html 里 import './runtime/textfx.js'（套件挂载；交付时冻结进片子）。
// 建在 text.js（本 skill 的基础层：拆字、前缀测量、断行）之上；sat/lerp 与 hash01 来自 film-core 的 motion.js / rand.js。
//   import { units, layoutText, drawUnits, IN, OUT, EMPHASIS, scramble, typeSchedule, typedAt, cursorOn,
//            pathSampler, drawOnPath, drawSliceReveal, drawLineReveal, odometer, drawDigits, digitAdvance,
//            glyphSprites, drawFlip, matchUnits, drawMorphText } from './runtime/textfx.js';
//
// 约定（和 text.js 一样）：拆分、测量、断行、精灵图、路径弧长表都在**加载时**做一次；seek(t) 只读结果按 t 画。
// 每一条手法都要求调用方显式给 ease / 时序 / 颜色：这里**没有默认手法、默认缓动、默认颜色**。
// 代价表与实测耗时见 film-typography references/textfx.md。

import { segments, wrapCJK, punctClass, prefixMeasure } from './text.js';
import { sat, lerp, win } from './motion.js';
import { hash01 } from './rand.js';

const need = (v, what, who) => { if (v == null) throw new Error(`${who}: 必须给 ${what}——不替你选`); return v; };

// ===========================================================================
// 1. 拆分单元（中文正确：按字拆，标点不单独飞）
// ===========================================================================
const isSpace = (s) => /^\s+$/u.test(s);
/**
 * units(text, { by: 'char' | 'word', locale }) → string[]
 *  - 'char'：按字素拆；闭标点/句读/间隔号/空格**挂到前一个单元**，开标点（「（《“）**挂到后一个单元**。
 *    所以「纯函数，」拆成 「纯 / 函 / 数，」——逗号跟着"数"一起动，不会自己飞进来。
 *  - 'word'：Intl.Segmenter 词粒度（中文用 ICU 词典切词；切法随 Chromium/ICU 版本可能变，钉浏览器的另一个理由），
 *    非词片段（标点、空格）同样按上面的规则挂靠。
 * 合并后的单元仍是字符串，可以直接 fillText；拼起来逐字节等于原文。
 */
export function units(text, { by = 'char', locale = 'zh' } = {}) {
  let raw;
  if (by === 'char') raw = segments(text, { locale, granularity: 'grapheme' }).map((s) => ({ s, word: !isSpace(s) && !punctClass(s) && !/^[\p{P}]$/u.test(s) }));
  else if (by === 'word') raw = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)].map((x) => ({ s: x.segment, word: x.isWordLike }));
  else throw new Error(`units: by 只能是 'char' | 'word'（按行用 layoutText 的 lines）`);
  const out = [];
  let pendingOpen = '';
  for (const { s, word } of raw) {
    const cls = /^[(\[{]$/.test(s) ? 'open' : punctClass(s[0]) ?? (word ? null : isSpace(s) ? 'space' : 'punct');
    if (cls === 'open') { pendingOpen += s; continue; }
    if (cls && cls !== 'open' && out.length && !pendingOpen) { out[out.length - 1] += s; continue; }
    out.push(pendingOpen + s); pendingOpen = '';
  }
  if (pendingOpen) { if (out.length) out[out.length - 1] += pendingOpen; else out.push(pendingOpen); }
  return out;
}

/**
 * layoutText(ctx, text, { by, maxWidth, lineHeight, align, locale }) → { units:[{s,x,y,w,i,line,li,cx}], lines:[{text,width,y,x}], width, height }
 * ctx.font 先设好、字体已 loadFonts。断行用 wrapCJK（避头尾），行内单元位置用**前缀测量**（保 kerning）。
 * 坐标原点：第一行基线左端（align:'center' 时是行中心）；y 是各行基线相对第一行的偏移。
 */
export function layoutText(ctx, text, { by = 'char', maxWidth = Infinity, lineHeight, align = 'left', locale = 'zh' } = {}) {
  const lines = Number.isFinite(maxWidth) ? wrapCJK(ctx, text, maxWidth) : text.split('\n');
  if (lines.length > 1 && lineHeight == null) throw new Error('layoutText: 多行时必须给 lineHeight（px）');
  const out = [], L = [];
  let i = 0, width = 0;
  lines.forEach((ln, li) => {
    const us = units(ln, { by, locale });
    const m = prefixMeasure(ctx, us);
    const w = m.totalWidth;
    const x0 = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    const y = li * (lineHeight ?? 0);
    m.forEach(({ s, x, w: uw }, k) => {
      out.push({ s, x: x0 + x, y, w: uw, i: i++, line: li, li: k, cx: x0 + x + uw / 2 });
    });
    L.push({ text: ln, width: w, y, x: x0, n: us.length });
    width = Math.max(width, w);
  });
  return { units: out, lines: L, width, height: (lines.length - 1) * (lineHeight ?? 0) };
}

// ===========================================================================
// 2. 逐单元绘制 + 预设（入场 / 出场 / 强调）
// ===========================================================================
/**
 * drawUnits(ctx, lay, x, y, style) —— 每个单元调用 style(u, i) → { dx, dy, sx, sy, rot, skewX, alpha, fill, stroke, lineWidth, text, filter } | null（null = 不画）
 * 变换以单元的**视觉中心**（cx, 基线上方 0.35em 处）为原点；size 用来估中心，取 ctx.font 里的 px。
 */
export function drawUnits(ctx, lay, x, y, style) {
  const size = fontPx(ctx.font);
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const baseFill = ctx.fillStyle;
  for (const u of lay.units) {
    const s = style(u, u.i);
    if (!s) continue;
    const a = s.alpha ?? 1;
    if (a <= 0) continue;
    const ox = x + u.cx, oy = y + u.y - size * 0.35;
    ctx.save();
    ctx.translate(ox + (s.dx ?? 0), oy + (s.dy ?? 0));
    if (s.rot) ctx.rotate(s.rot);
    if (s.skewX) ctx.transform(1, 0, Math.tan(s.skewX), 1, 0, 0);
    if (s.sx != null || s.sy != null) ctx.scale(s.sx ?? 1, s.sy ?? 1);
    ctx.globalAlpha *= a;
    if (s.filter) ctx.filter = s.filter;
    const text = s.text ?? u.s;
    if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = s.lineWidth ?? size * 0.04; ctx.lineJoin = 'round'; ctx.strokeText(text, 0, size * 0.35); }
    ctx.fillStyle = s.fill ?? baseFill;
    if (s.fill !== 'none') ctx.fillText(text, 0, size * 0.35);
    ctx.restore();
  }
  ctx.restore();
}
export const fontPx = (font) => { const m = /(\d+(?:\.\d+)?)px/.exec(font); if (!m) throw new Error(`读不出字号：${font}`); return +m[1]; };

/**
 * 每单元进度：p_i = win(t, start + d_i, dur, ease)（film-core motion.js 的区间进度；dur ≤ 0 是阶跃）。text.js 的 drawRiseIn、本文件的 drawUnits 都用它给进度。
 *   d_i = delays[i]（任意交错表：film-motion choreo.js 的 stagger() 按距离/种子随机算出的那种），
 *   或 stagger·i（等间隔）；两个都不给 = 同时。order 是打乱后的名次（用 seeded() 生成），只配 stagger 用。
 */
export function unitProgress(t, i, { start, dur, ease, delays = null, stagger = null, order = null }) {
  need(ease, 'ease', 'unitProgress'); need(dur, 'dur', 'unitProgress'); need(start, 'start', 'unitProgress');
  if (delays && stagger != null) throw new Error('unitProgress: delays 和 stagger 只给一个');
  const d = delays ? delays[i] ?? 0 : stagger != null ? stagger * (order ? order[i] : i) : 0;
  return win(t, start + d, dur, ease);
}

/**
 * 入场预设：IN.<名>(参数) → (p, u, size) => style。p 已经过缓动（0 = 未出现，1 = 就位）。
 * 每个预设的位移量都是参数（以字号为单位），不给就抛错——同一个预设，0.3em 和 2em 是两种完全不同的手感。
 */
export const IN = {
  /** 淡入 */
  fade: () => (p) => ({ alpha: p }),
  /** 升起：从下方 dist em 升到位（配 alpha 就是"浮现"；fade:false 就是硬升，通常要配行遮罩 drawLineReveal） */
  rise: ({ dist, fade = true }) => (p, u, size) => ({ dy: (1 - p) * need(dist, 'dist', 'IN.rise') * size, alpha: fade ? sat(p * 1.5) : 1 }),
  /** 落下：从上方 dist em 落下 */
  drop: ({ dist, fade = true }) => (p, u, size) => ({ dy: -(1 - p) * need(dist, 'dist', 'IN.drop') * size, alpha: fade ? sat(p * 1.5) : 1 }),
  /** 缩放：从 from 倍放到 1（配 back.out 就是"弹出"） */
  scale: ({ from }) => (p) => { const k = lerp(need(from, 'from', 'IN.scale'), 1, p); return { sx: k, sy: k, alpha: sat(p * 2) }; },
  /** 旋入：从 angle 弧度转正，同时从 dist em 位移 */
  spin: ({ angle, dist = 0 }) => (p, u, size) => ({ rot: (1 - p) * need(angle, 'angle', 'IN.spin'), dy: (1 - p) * dist * size, alpha: sat(p * 2) }),
  /** 斜切滑入：skew 弧度 + 横向 dist em */
  skew: ({ angle, dist }) => (p, u, size) => ({ skewX: (1 - p) * need(angle, 'angle', 'IN.skew'), dx: (1 - p) * need(dist, 'dist', 'IN.skew') * size, alpha: sat(p * 2) }),
  /** 字距收拢：每个单元从"离行中心 spread 倍远"的位置收回 */
  track: ({ spread }) => (p, u) => ({ dx: (1 - p) * need(spread, 'spread', 'IN.track') * u.cx, alpha: p }),
  /** 模糊对焦：ctx.filter blur，很贵（见代价表） */
  blur: ({ radius }) => (p, u, size) => ({ filter: p < 1 ? `blur(${(1 - p) * need(radius, 'radius', 'IN.blur') * size}px)` : 'none', alpha: p }),
  /** 仿射翻转（绕水平轴）：sy = cos。没有透视收缩，接近 90° 时读作"压扁"而不是"翻"；要透视用 drawFlip(strips) */
  flipAffine: () => (p) => ({ sy: Math.max(0.001, Math.sin((p * Math.PI) / 2)), alpha: p > 0 ? 1 : 0 }),
};
/** 出场 = 入场反着放：OUT(IN.rise({dist:0.6})) 的 p 是"离开了多少"（0 = 还在，1 = 走完） */
export const OUT = (inPreset) => (p, u, size) => inPreset(1 - p, u, size);

/**
 * 强调预设（不进不出，就位后的持续动作）：EMPHASIS.<名>(参数) → (t, u, size) => style。
 * 都是 t 的周期/种子函数；amp 等全部要给。
 */
export const EMPHASIS = {
  /** 波浪：dy = sin(2π(freq·t − phase·i))·amp em */
  wave: ({ amp, freq, phase }) => (t, u, size) => ({ dy: Math.sin(2 * Math.PI * (need(freq, 'freq', 'wave') * t - need(phase, 'phase', 'wave') * u.i)) * need(amp, 'amp', 'wave') * size }),
  /** 脉冲：整体缩放 1 + amp·bump，bump 是 [t0, t0+dur] 上的 sin 半周期，逐单元延迟 each 秒 */
  pulse: ({ t0, dur, amp, each = 0 }) => (t, u) => { const q = sat((t - t0 - each * u.i) / dur); const k = 1 + amp * Math.sin(Math.PI * q); return { sx: k, sy: k }; },
  /** 抖动：seeded，按 rate 次/秒换一次位置 */
  jitter: ({ amp, rate, seed }) => (t, u, size) => {
    const k = Math.floor(t * need(rate, 'rate', 'jitter'));
    return { dx: (hash01(need(seed, 'seed', 'jitter'), u.i, k, 1) - 0.5) * 2 * amp * size, dy: (hash01(seed, u.i, k, 2) - 0.5) * 2 * amp * size };
  },
};

// ===========================================================================
// 3. 解码 / 乱码揭示（scramble）
// ===========================================================================
/**
 * scramble(t, lay.units, { start, delays, settle, rate, pool, seed, keep }) → [{ text, state: 'hidden'|'noise'|'locked' }]
 *  - 单元 i 在 start + delays[i] 出现，先乱码 settle 秒，再锁定成原字。
 *  - 乱码字 = pool[ hash01(seed, i, floor(t·rate)) ]：**只依赖 (seed, i, t)**，乱序求值一致；rate = 每秒换几次。
 *  - keep(s) 为 true 的单元不乱码（默认：标点、空格直接随锁定出现）。挂靠在单元上的标点在锁定前不显示。
 *  - pool 必给，而且 **pool 里的每个字都要进 loadFonts 的文字声明**——乱码字是运行时才画的字，
 *    漏掉的那几个会在第一次被抽中的那一帧用回退字体画（film-typography 硬约束 2）。
 * 画法：用 drawUnits 的 style 返回 { text } 换字；位置仍按原字的 cx 居中——替换字宽不同也不推开后面的字。
 */
export function scramble(t, us, { start, delays = null, settle, rate, pool, seed, keep = null }) {
  need(start, 'start', 'scramble'); need(settle, 'settle', 'scramble'); need(rate, 'rate', 'scramble');
  const P = [...need(pool, 'pool（乱码字池，记得加进 loadFonts）', 'scramble')];
  need(seed, 'seed', 'scramble');
  const k = Math.floor(t * rate);
  return us.map((u, i) => {
    const t0 = start + (delays ? delays[i] ?? 0 : 0);
    if (t < t0) return { text: '', state: 'hidden' };
    if (t >= t0 + settle || (keep ? keep(u.s) : !/[\p{L}\p{N}]/u.test(u.s))) return { text: u.s, state: 'locked' };
    const n = Math.max(1, [...u.s.replace(/[\p{P}\s]/gu, '')].length);
    let s = '';
    for (let j = 0; j < n; j++) s += P[Math.floor(hash01(seed, i, j, k) * P.length)];
    return { text: s, state: 'noise' };
  });
}

// ===========================================================================
// 4. 打字机（带标点停顿与光标）
// ===========================================================================
/**
 * typeSchedule(us, { start, perUnit, pauses, seed, jitter }) → Float64Array 每个单元出现的时刻（加载时算一次）
 *   us: layoutText 的 units / 字符串数组 / 单元个数（只给个数时没有文本，pauses 不起作用 = 匀速）
 *   pauses: { '，': 0.18, '。': 0.35 } —— 单元**以这些字结尾**时，下一个单元多等这么久（中文打字的呼吸感来自这里，不来自匀速）
 *   jitter: 0..1，每个间隔乘 (1 ± jitter) 的种子随机（人手打字不匀），要给 seed
 * 匀速打字机 = 不给 pauses 和 jitter：typedAt(t, typeSchedule(n, { start, perUnit }))。
 */
export function typeSchedule(us, { start, perUnit, pauses = {}, jitter = 0, seed }) {
  need(start, 'start', 'typeSchedule'); need(perUnit, 'perUnit', 'typeSchedule');
  if (jitter && seed == null) throw new Error('typeSchedule: jitter > 0 时必须给 seed');
  const list = typeof us === 'number' ? Array.from({ length: us }, () => '') : us;
  const out = new Float64Array(list.length);
  let at = start;
  list.forEach((u, i) => {
    out[i] = at;
    let gap = perUnit * (jitter ? 1 + (hash01(seed, i) - 0.5) * 2 * jitter : 1);
    const last = [...(typeof u === 'string' ? u : u.s)].at(-1);
    if (last in pauses) gap += pauses[last];
    at += gap;
  });
  out.end = at;
  return out;
}
/** t 时刻已打出几个单元（二分）。整数，变化那一刻就是 tick 音效的时刻。 */
export function typedAt(t, sched) {
  let lo = 0, hi = sched.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sched[m] <= t) lo = m + 1; else hi = m; }
  return lo;
}
/**
 * 光标亮不亮：打字中（距上一次击键 < hold 秒）常亮，空闲时按 blink Hz 闪（亮灭各半）。纯 t 函数。
 */
export function cursorOn(t, sched, { blink, hold }) {
  need(blink, 'blink（Hz）', 'cursorOn'); need(hold, 'hold（秒）', 'cursorOn');
  const n = typedAt(t, sched);
  const last = n ? sched[n - 1] : -Infinity;
  if (n === 0) return Math.floor((t - sched[0]) * blink * 2) % 2 === 0;   // 还没开始打：按 blink 闪
  if (t - last < hold) return true;
  return Math.floor((t - last - hold) * blink * 2) % 2 === 0;
}

// ===========================================================================
// 5. 沿路径排字
// ===========================================================================
/**
 * pathSampler(spec, { samples }) → { length, at(s) → {x, y, angle} }，按弧长取点（加载时建弧长表）。
 * spec：点数组 [[x,y],...]（折线）| { cubic: [p0,p1,p2,p3] } | { arc: [cx, cy, r, a0, a1] } | 函数 u∈[0,1] → [x,y]
 */
export function pathSampler(spec, { samples = 512 } = {}) {
  let f;
  if (typeof spec === 'function') f = spec;
  else if (Array.isArray(spec)) {
    const seg = []; let L = 0;
    for (let i = 1; i < spec.length; i++) { const d = Math.hypot(spec[i][0] - spec[i - 1][0], spec[i][1] - spec[i - 1][1]); seg.push(d); L += d; }
    f = (u) => {
      let s = u * L, i = 0;
      while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
      const q = seg[i] ? s / seg[i] : 0;
      return [lerp(spec[i][0], spec[i + 1][0], q), lerp(spec[i][1], spec[i + 1][1], q)];
    };
  } else if (spec.cubic) {
    const [a, b, c, d] = spec.cubic;
    f = (u) => { const v = 1 - u; return [0, 1].map((k) => v * v * v * a[k] + 3 * v * v * u * b[k] + 3 * v * u * u * c[k] + u * u * u * d[k]); };
  } else if (spec.arc) {
    const [cx, cy, r, a0, a1] = spec.arc;
    f = (u) => { const a = lerp(a0, a1, u); return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  } else throw new Error('pathSampler: spec 是点数组 / {cubic} / {arc} / 函数');
  const us = new Float64Array(samples + 1), ss = new Float64Array(samples + 1), pts = [];
  let acc = 0, prev = f(0);
  pts.push(prev);
  for (let i = 1; i <= samples; i++) {
    const u = i / samples, p = f(u);
    acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    us[i] = u; ss[i] = acc; pts.push(p); prev = p;
  }
  const length = acc;
  const at = (s) => {
    const sc = Math.max(0, Math.min(length, s));
    let lo = 0, hi = samples;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ss[m] <= sc) lo = m; else hi = m; }
    const q = ss[hi] > ss[lo] ? (sc - ss[lo]) / (ss[hi] - ss[lo]) : 0;
    const [x0, y0] = pts[lo], [x1, y1] = pts[hi];
    // 超出两端时沿端点切线外推（字可以从路径外"开进来"）
    const over = s - sc;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    return { x: lerp(x0, x1, q) + over * Math.cos(ang), y: lerp(y0, y1, q) + over * Math.sin(ang), angle: ang };
  };
  return { length, at };
}
/**
 * drawOnPath(ctx, lay, path, { offset, normal, style }) —— 单行布局的每个单元放在弧长 offset + u.cx 处，按切线旋转。
 * offset 随 t 变 = 字沿路径流动；style(u, i) 同 drawUnits（可再叠入场）。normal = 沿法向偏移（px，正 = 路径左侧）。
 */
export function drawOnPath(ctx, lay, path, { offset = 0, normal = 0, style = null }) {
  const size = fontPx(ctx.font);
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const base = ctx.fillStyle;
  for (const u of lay.units) {
    const s = style ? style(u, u.i) : {};
    if (!s || (s.alpha ?? 1) <= 0) continue;
    const q = path.at(offset + u.cx);
    ctx.save();
    ctx.translate(q.x - Math.sin(q.angle) * normal, q.y + Math.cos(q.angle) * normal);
    ctx.rotate(q.angle + (s.rot ?? 0));
    ctx.translate(s.dx ?? 0, s.dy ?? 0);
    if (s.sx != null || s.sy != null) ctx.scale(s.sx ?? 1, s.sy ?? 1);
    ctx.globalAlpha *= s.alpha ?? 1;
    ctx.fillStyle = s.fill ?? base;
    ctx.fillText(s.text ?? u.s, 0, size * 0.35);
    ctx.restore();
  }
  ctx.restore();
}

// ===========================================================================
// 6. 遮罩切分揭示
// ===========================================================================
/**
 * drawSliceReveal(ctx, text, x, y, { slices, progress, dist, alternate, axis }) —— 整行字横切成 slices 条，
 * 每条在自己的条带遮罩里从 ±dist 滑进来（alternate:true 相邻条反向）。progress(k) → 第 k 条的进度（已缓动）。
 * axis:'x' 条带水平、沿 x 滑；'y' 条带竖直、沿 y 滑。text 以 (x, y) 为基线中心画（textAlign center）。
 */
export function drawSliceReveal(ctx, text, x, y, { slices, progress, dist, alternate = true, axis = 'x' }) {
  need(slices, 'slices', 'drawSliceReveal'); need(progress, 'progress(k)', 'drawSliceReveal'); need(dist, 'dist（px）', 'drawSliceReveal');
  const size = fontPx(ctx.font);
  const w = ctx.measureText(text).width;
  const top = y - size * 0.95, h = size * 1.25, left = x - w / 2 - size * 0.1, ww = w + size * 0.2;
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (let k = 0; k < slices; k++) {
    const p = progress(k);
    if (p <= 0) continue;
    const sgn = alternate && k % 2 ? -1 : 1;
    ctx.save(); ctx.beginPath();
    if (axis === 'x') ctx.rect(left - dist, top + (k * h) / slices, ww + 2 * dist, h / slices + 0.5);
    else ctx.rect(left + (k * ww) / slices, top - dist, ww / slices + 0.5, h + 2 * dist);
    ctx.clip();
    const off = (1 - p) * dist * sgn;
    ctx.fillText(text, axis === 'x' ? x + off : x, axis === 'y' ? y + off : y);
    ctx.restore();
  }
  ctx.restore();
}
/**
 * drawLineReveal(ctx, lay, x, y, { progress, rise, clipPad }) —— 多行：每行一个行遮罩，行内整行从遮罩下方升起。
 * progress(line) → 已缓动进度。和 text.js drawRiseIn 的区别：按行而不是按字，适合段落。
 */
export function drawLineReveal(ctx, lay, x, y, { progress, rise }) {
  need(progress, 'progress(line)', 'drawLineReveal'); need(rise, 'rise（em）', 'drawLineReveal');
  const size = fontPx(ctx.font);
  ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  lay.lines.forEach((ln, li) => {
    const p = progress(li);
    if (p <= 0) return;
    ctx.save(); ctx.beginPath(); ctx.rect(x + ln.x - size * 0.2, y + ln.y - size * 1.0, ln.width + size * 0.4, size * 1.3); ctx.clip();
    ctx.fillText(ln.text, x + ln.x, y + ln.y + (1 - p) * rise * size);
    ctx.restore();
  });
  ctx.restore();
}

// ===========================================================================
// 7. 数字滚动（里程表 / 老虎机）
// ===========================================================================
/** 数字 0–9 里最宽的 advance。按它排列每一位 = 等宽，滚动时不左右抖（字体有 tnum 时也可直接用）。加载时测一次。 */
export function digitAdvance(ctx) { let m = 0; for (let d = 0; d < 10; d++) m = Math.max(m, ctx.measureText(String(d)).width); return m; }
/**
 * odometer(value, digits) → 每一位（从高到低）的连续位置 pos ∈ [0, 10)：
 *   个位 pos = value mod 10（连续滚）；高位只在低位从 9 滚到 0 的最后一个单位里滚（真正的里程表进位）。
 */
export function odometer(value, digits) {
  const out = [];
  const v = Math.max(0, value);
  for (let k = digits - 1; k >= 0; k--) {
    const p = 10 ** k;
    const base = Math.floor(v / p);
    const roll = k === 0 ? v - Math.floor(v) : sat((v % p) - (p - 1));
    out.push(((base % 10) + roll) % 10);
  }
  return out;
}
/**
 * drawDigits(ctx, cols, x, y, { adv, lineHeight, align, hideLeading, value }) —— 每一位在自己的窗口里竖着滚。
 * cols = odometer() 或自己算的每位位置（老虎机：pos = 目标位 + 10·圈数·(1 − ease(p))）。
 * hideLeading:true 时比 value 的最高位更高的列不画（value 必给）。
 */
export function drawDigits(ctx, cols, x, y, { adv, lineHeight, align = 'center', hideLeading = false, value = null }) {
  need(adv, 'adv（digitAdvance(ctx)）', 'drawDigits'); need(lineHeight, 'lineHeight（px）', 'drawDigits');
  const size = fontPx(ctx.font);
  const n = cols.length, w = n * adv;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const lead = hideLeading ? Math.max(1, String(Math.floor(Math.max(0, value ?? 0))).length) : n;
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  cols.forEach((pos, k) => {
    if (n - k > lead) return;
    const cx = x0 + (k + 0.5) * adv;
    ctx.save(); ctx.beginPath(); ctx.rect(cx - adv / 2, y - size * 0.95 - (lineHeight - size * 1.2) / 2, adv, lineHeight); ctx.clip();
    const d = Math.floor(pos) % 10, f = pos - Math.floor(pos);
    ctx.fillText(String(d), cx, y - f * lineHeight);
    ctx.fillText(String((d + 1) % 10), cx, y + (1 - f) * lineHeight);
    ctx.restore();
  });
  ctx.restore();
}

// ===========================================================================
// 8. 逐字 3D 翻转（透视用条带切片近似；仿射版见 IN.flipAffine）
// ===========================================================================
/**
 * glyphSprites(ctx, lay, { pad }) → 每个单元一张离屏精灵（加载时画，用当前 ctx.font / fillStyle）。
 * 代价：颜色在加载时就定了（要动颜色就在 drawFlip 之后用 source-atop 叠色，或者每种颜色各备一套）；每张精灵占内存。
 */
export function glyphSprites(ctx, lay, { pad = 0.25 } = {}) {
  const size = fontPx(ctx.font);
  return lay.units.map((u) => {
    const w = Math.ceil(u.w + size * pad * 2), h = Math.ceil(size * (1.3 + pad * 2));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.font = ctx.font; x.fillStyle = ctx.fillStyle; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    x.fillText(u.s, w / 2, h / 2 + size * 0.35);
    return { canvas: c, w, h };
  });
}
/**
 * drawFlip(ctx, sprite, cx, cy, angle, { axis, mode, strips, focal, back }) —— 精灵绕自己中心的水平轴（axis:'x'）或竖直轴（'y'）转 angle 弧度。
 *  mode:'strips'：精灵切成 strips 条，每条按自己的深度单独缩放 = 分段仿射逼近透视（focal = 焦距 px，越小透视越强）。
 *  mode:'affine'：只按 cos 压扁，没有近大远小。
 *  转过 90° 后看到背面：back 给另一张精灵（翻牌换字），不给就再画一遍正面（不镜像）。
 */
export function drawFlip(ctx, sprite, cx, cy, angle, { axis = 'x', mode, strips = 16, focal, back = null }) {
  need(mode, "mode（'strips' | 'affine'）", 'drawFlip');
  let a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let spr = sprite;
  const cosA = Math.cos(a);
  if (cosA < 0) { spr = back ?? sprite; a = a - Math.PI; }        // 背面：转回正对的那一侧再画
  const { canvas: img, w, h } = spr;
  const c = Math.cos(a), s = Math.sin(a);
  if (Math.abs(c) < 1e-3) return;
  if (mode === 'affine') {
    ctx.save(); ctx.translate(cx, cy);
    if (axis === 'x') ctx.scale(1, c); else ctx.scale(c, 1);
    ctx.drawImage(img, -w / 2, -h / 2); ctx.restore();
    return;
  }
  need(focal, 'focal（焦距 px）', 'drawFlip strips');
  const n = Math.max(2, strips);
  const L = axis === 'x' ? h : w;
  for (let i = 0; i < n; i++) {
    const v0 = -L / 2 + (i * L) / n, v1 = v0 + L / n, vm = (v0 + v1) / 2;
    const k0 = focal / (focal + v0 * s), k1 = focal / (focal + v1 * s), km = focal / (focal + vm * s);
    const p0 = v0 * c * k0, p1 = v1 * c * k1;
    if (axis === 'x') {
      const ww = w * km;
      ctx.drawImage(img, 0, (i * h) / n, w, h / n, cx - ww / 2, cy + Math.min(p0, p1), ww, Math.abs(p1 - p0) + 0.6);
    } else {
      const hh = h * km;
      ctx.drawImage(img, (i * w) / n, 0, w / n, h, cx + Math.min(p0, p1), cy - hh / 2, Math.abs(p1 - p0) + 0.6, hh);
    }
  }
}

// ===========================================================================
// 9. 文字的 Magic Move（Keynote "按字符" / Manim TransformMatchingShapes）
// ===========================================================================
/**
 * matchUnits(a, b) → { pairs: [[ia, ib]], onlyA: [ia], onlyB: [ib] }
 * 相同的单元配对（按出现次序就近配，所以「纯函数」→「函数纯」的三个字都能飞到新位置）；其余分别淡出/淡入。
 * a、b 是 layoutText 的 units（比的是 u.s，含挂靠的标点——要按字配就先用 by:'char' 且两边标点一致）。
 */
export function matchUnits(a, b) {
  const used = new Set(), pairs = [], onlyB = [];
  b.forEach((ub, ib) => {
    let best = -1, bd = Infinity;
    a.forEach((ua, ia) => { if (!used.has(ia) && ua.s === ub.s && Math.abs(ia - ib) < bd) { best = ia; bd = Math.abs(ia - ib); } });
    if (best >= 0) { used.add(best); pairs.push([best, ib]); } else onlyB.push(ib);
  });
  const onlyA = a.map((_, i) => i).filter((i) => !used.has(i));
  return { pairs, onlyA, onlyB };
}
/**
 * drawMorphText(ctx, layA, layB, m, p, { a: [x,y], b: [x,y], arc, fadeOut, fadeIn, delays })
 *  m = matchUnits(layA.units, layB.units)（加载时算）；p = 已缓动进度。
 *  配对的单元从 A 位置沿（可拱起的）路径飞到 B 位置；onlyA 在前 fadeOut 比例内淡出，onlyB 在最后 fadeIn 比例内淡入。
 *  delays(k) → [0,1) 第 k 对晚走的比例（交错）。两个布局要用同一个 ctx.font（不同字号就先在外面 scale）。
 */
export function drawMorphText(ctx, layA, layB, m, p, { a, b, arc = 0, fadeOut, fadeIn, delays = null }) {
  need(fadeOut, 'fadeOut', 'drawMorphText'); need(fadeIn, 'fadeIn', 'drawMorphText');
  const size = fontPx(ctx.font);
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const put = (s, x, y, alpha) => { if (alpha <= 0) return; ctx.globalAlpha = alpha; ctx.fillText(s, x, y); };
  for (const ia of m.onlyA) { const u = layA.units[ia]; put(u.s, a[0] + u.cx, a[1] + u.y, 1 - sat(p / fadeOut)); }
  for (const ib of m.onlyB) { const u = layB.units[ib]; put(u.s, b[0] + u.cx, b[1] + u.y, sat((p - (1 - fadeIn)) / fadeIn)); }
  m.pairs.forEach(([ia, ib], k) => {
    const ua = layA.units[ia], ub = layB.units[ib];
    const d = delays ? sat(delays(k)) : 0;
    const q = d > 0 ? sat((p - d) / (1 - d)) : p;
    const x0 = a[0] + ua.cx, y0 = a[1] + ua.y, x1 = b[0] + ub.cx, y1 = b[1] + ub.y;
    const bump = arc * size * 4 * q * (1 - q) * (k % 2 ? 1 : -1);
    put(ub.s, lerp(x0, x1, q), lerp(y0, y1, q) + bump, 1);
  });
  ctx.restore();
}
