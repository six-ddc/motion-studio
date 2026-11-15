// film-motion 运行时 · 数据图表的几何与数值（纯数学，零 npm 依赖：浏览器和 Node 都能 import）
//
//   import { scaleLinear, ticks, barRace, projection, geoShapes, forceLayout } from './runtime/chart.js';
//
// 只出**几何和数值**：坐标、点列、刻度、角度区间、排名位置、透明度系数。不画任何东西，
// 没有颜色、线宽、字体、留白之类的值——画成什么样由调用方的 ctx 决定。用法、代价与实测见 film-motion references/dataviz.md。
//
// 七组：
//   1. 比例尺：scaleLinear scaleLog scalePow scaleSqrt scaleTime scaleBand scalePoint；ticks(scale, n) nice(scale, n)
//   2. 数值格式：fixed grouped si cjk percent formatter；timeParts（时间刻度拼标签用）
//   3. 序列几何：curvePath curvePoints traceCurve areaPoints stack pie arcPoints bin extent
//   4. 随 t 变化的数据：keyframes barRace lineGrower axisTicks
//   5. 地理：projection fit geoShapes projectLine greatCircle
//   6. 关系图：forceLayout fitPoints
//
// 全部输出只取决于参数。有状态的东西（力导向仿真、排名交换事件表）在**加载期**一次算完，seek 里只查表/插值。
// 随机只来自 film-core 的 rand.js（seeded）。时间刻度一律按 UTC + 调用方给的固定偏移（分钟）计算，不读本机时区：
// 本机时区是环境状态，换机器刻度就变。
// Node 里 import 之前先调 film-core lib/runtime-node.mjs 的 registerRuntimeResolver()，否则 ./rand.js 解析不到。
//
// 算法来源：刻度取整（1/2/5、tickIncrement）、单调三次插值（Steffen 法）、旋转与 Albers 公式、
// 力导向（速度 Verlet + alpha 衰减）的语义照 d3（ISC）重写，不是拷贝；参数名尽量和 d3 一致，方便对照文档。

import { seeded } from './rand.js';

const PI = Math.PI, TAU = 2 * PI, D2R = PI / 180, R2D = 180 / PI;
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, p) => a + (b - a) * p;
const need = (cond, msg) => { if (!cond) throw new Error(`chart.js：${msg}`); };
const isFn = (f) => typeof f === 'function';

// ===========================================================================
// 0. 跨引擎逐位一致的数学内核
// ===========================================================================
// 为什么不用 Math.sin/cos/atan2/log/exp/pow：ECMAScript 不要求它们正确舍入。实测 Node 22.23 的 V8 与 Chromium 156 的 V8
// 在 4000 个输入上有 2.5–17% 差 1 ULP（连 10 ** 整数 都有 3%），力导向跑 300 步后差异放大到 1e-13 量级——
// 检查脚本在 Node 里算的坐标和浏览器里画的就不是同一组数。+ − × ÷ 与 sqrt 是 IEEE 754 规定正确舍入的，各引擎一致，
// 所以下面只用它们（多项式系数照 fdlibm），误差 ≤ 约 1 ULP，输出在任何符合标准的引擎里逐位相同。实测见 docs/verified/film-motion.md。
const PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11, PIO2_3 = 2.02226624871116645580e-21, INV_PIO2 = 6.36619772367581382433e-01;
function kSin(x) { const z = x * x, v = z * x, r = 8.33333333332248946124e-03 + z * (-1.98412698298579493134e-04 + z * (2.75573137070700676789e-06 + z * (-2.50507602534068634195e-08 + z * 1.58969099521155010221e-10))); return x + v * (-1.66666666666666324348e-01 + z * r); }
function kCos(x) { const z = x * x, r = z * (4.16666666666666019037e-02 + z * (-1.38888888888741095749e-03 + z * (2.48015872894767294178e-05 + z * (-2.75573143513906633035e-07 + z * (2.08757232129817482790e-09 + z * -1.13596475577881948265e-11))))); const hz = 0.5 * z, w = 1 - hz; return w + (((1 - w) - hz) + z * r); }
function sincos(x) {   // → [sin, cos]；|x| ≲ 1e6 时约 1 ULP（Cody–Waite 三段 π/2 约简）
  if (!Number.isFinite(x)) return [NaN, NaN];
  const n = Math.round(x * INV_PIO2), r = ((x - n * PIO2_1) - n * PIO2_2) - n * PIO2_3;
  const s = kSin(r), c = kCos(r);
  switch (((n % 4) + 4) % 4) { case 0: return [s, c]; case 1: return [c, -s]; case 2: return [-s, -c]; default: return [-c, s]; }
}
const ATANHI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATANLO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02,
  -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
function atan(x) {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0; let ax = neg ? -x : x, id = -1;
  if (ax > 7.378697629483821e19) return neg ? -ATANHI[3] - ATANLO[3] : ATANHI[3] + ATANLO[3];
  if (ax >= 0.4375) {
    if (ax < 1.1875) { if (ax < 0.6875) { id = 0; ax = (2 * ax - 1) / (2 + ax); } else { id = 1; ax = (ax - 1) / (ax + 1); } }
    else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1 + 1.5 * ax); } else { id = 3; ax = -1 / ax; }
  }
  const z = ax * ax, w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  const r = id < 0 ? ax - ax * (s1 + s2) : ATANHI[id] - ((ax * (s1 + s2) - ATANLO[id]) - ax);
  return neg ? -r : r;
}
function atan2(y, x) {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0) return y > 0 ? PI / 2 : y < 0 ? -PI / 2 : (Object.is(x, -0) ? (Object.is(y, -0) ? -PI : PI) : y);
  const a = atan(y / x);
  return x > 0 ? a : y >= 0 ? a + PI : a - PI;
}
const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INV_LN2 = 1.44269504088896338700e+00;
const TWO64 = 18446744073709551616;
function log(x) {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let k = 0;
  while (x >= TWO64) { x /= TWO64; k += 64; }
  while (x < 1 / TWO64) { x *= TWO64; k -= 64; }
  while (x >= 2) { x /= 2; k++; }
  while (x < 1) { x *= 2; k--; }
  if (x > Math.SQRT2) { x /= 2; k++; }
  const f = x - 1, s = f / (2 + f), z = s * s, w = z * z;
  const R = z * (6.666666666666735130e-01 + w * (2.857142874366239149e-01 + w * (1.818357216161805012e-01 + w * 1.479819860511658591e-01)))
    + w * (3.999999999940941908e-01 + w * (2.222219843214978396e-01 + w * 1.531383769920937332e-01));
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
}
const POW2 = new Map();
function pow2(k) {   // 2^k 精确（乘 2 是精确运算）
  let v = POW2.get(k); if (v !== undefined) return v;
  v = 1; const step = k > 0 ? 2 : 0.5; for (let i = 0; i < Math.abs(k); i++) v *= step;
  POW2.set(k, v); return v;
}
function exp(x) {
  if (Number.isNaN(x)) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019411) return 0;
  const k = Math.round(x * INV_LN2), hi = x - k * LN2_HI, lo = k * LN2_LO, r = hi - lo, t = r * r;
  const c = r - t * (1.66666666666666019037e-01 + t * (-2.77777777770155933842e-03 + t * (6.61375632143793436117e-05 + t * (-1.65339022054652515390e-06 + t * 4.13813679705723846039e-08))));
  const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  return k < -1020 ? y * pow2(k + 1000) * pow2(-1000) : k > 1020 ? y * pow2(k - 10) * pow2(10) : y * pow2(k);
}
const pow10 = (k) => Number(`1e${k}`);   // 整数次幂：字符串解析按规范正确舍入，各引擎一致
/** 跨引擎逐位一致的数学函数（只用 + − × ÷ sqrt）。片子里需要和 chart.js 同一份三角函数时也可以用。 */
export const dmath = Object.freeze({
  sin: (x) => sincos(x)[0], cos: (x) => sincos(x)[1], tan: (x) => { const [s, c] = sincos(x); return s / c; }, sincos,
  atan, atan2, asin: (x) => (x > 1 || x < -1 ? NaN : atan2(x, Math.sqrt((1 - x) * (1 + x)))),
  log, exp, log10: (x) => log(x) / 2.302585092994046, log2: (x) => log(x) * INV_LN2,
  pow: (b, e) => (e === 0 ? 1 : e === 0.5 ? Math.sqrt(b) : Number.isInteger(e) && Math.abs(e) <= 64 ? powInt(b, e) : b < 0 ? NaN : b === 0 ? (e > 0 ? 0 : Infinity) : exp(e * log(b))),
  hypot: (x, y) => Math.sqrt(x * x + y * y), pow10,
});
function powInt(b, e) { let r = 1, x = b, n = Math.abs(e); while (n) { if (n & 1) r *= x; x *= x; n >>= 1; } return e < 0 ? 1 / r : r; }
/** floor(log10(x)) 的稳健版：先估，再用精确的 10^k 校正（log10 在整次幂附近差一点就会差一档） */
function floorLog10(x) { let p = Math.floor(dmath.log10(x)); if (pow10(p + 1) <= x) p++; else if (pow10(p) > x) p--; return p; }

// ===========================================================================
// 1. 比例尺
// ===========================================================================
const E10 = Math.sqrt(50), E5 = Math.sqrt(10), E2 = Math.sqrt(2);

// [i1, i2, inc]：inc > 0 时刻度 = i·inc；inc < 0 时刻度 = i / (−inc)（避免 0.1·3 = 0.30000000000000004）
function tickSpec(start, stop, count) {
  const step = (stop - start) / Math.max(0, count);
  const power = floorLog10(step);
  const error = step / pow10(power);
  const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
  let i1, i2, inc;
  if (power < 0) {
    inc = pow10(-power) / factor;
    i1 = Math.round(start * inc); i2 = Math.round(stop * inc);
    if (i1 / inc < start) ++i1;
    if (i2 / inc > stop) --i2;
    inc = -inc;
  } else {
    inc = pow10(power) * factor;
    i1 = Math.round(start / inc); i2 = Math.round(stop / inc);
    if (i1 * inc < start) ++i1;
    if (i2 * inc > stop) --i2;
  }
  if (i2 < i1 && count >= 0.5 && count < 2) return tickSpec(start, stop, count * 2);
  return [i1, i2, inc];
}

function linearTicks(a, b, count) {
  if (!(count > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return [];
  if (a === b) return [a];
  const rev = b < a; const [lo, hi] = rev ? [b, a] : [a, b];
  const [i1, i2, inc] = tickSpec(lo, hi, count);
  if (!(i2 >= i1)) return [];
  const n = i2 - i1 + 1, out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = inc < 0 ? (i1 + i) / -inc : (i1 + i) * inc;
  return rev ? out.reverse() : out;
}

function tickIncrement(a, b, count) { return tickSpec(a, b, count)[2]; }

function niceLinear(d0, d1, count) {
  let a = d0, b = d1; const rev = b < a; if (rev) [a, b] = [b, a];
  let prev;
  for (let k = 0; k < 10; k++) {
    const step = tickIncrement(a, b, count);
    if (step === prev) break;
    if (step > 0) { a = Math.floor(a / step) * step; b = Math.ceil(b / step) * step; }
    else if (step < 0) { a = Math.ceil(a * step) / step; b = Math.floor(b * step) / step; }
    else break;
    prev = step;
  }
  return rev ? [b, a] : [a, b];
}

function pair(v, name) {
  need(Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(+x)), `${name} 要是两个有限数 [a, b]`);
  return [+v[0], +v[1]];
}

function continuous(kind, fwd, inv, opts, extra = {}) {
  const domain = pair(opts.domain, `${kind} 的 domain`), range = pair(opts.range, `${kind} 的 range`);
  const clamp = !!opts.clamp;
  const t0 = fwd(domain[0]), t1 = fwd(domain[1]);
  need(Number.isFinite(t0) && Number.isFinite(t1), `${kind} 的 domain 在变换后不是有限数（log 要求同号且非零）`);
  const [r0, r1] = range, dt = t1 - t0;
  const s = (x) => {
    let u = dt === 0 ? 0.5 : (fwd(+x) - t0) / dt;
    if (clamp) u = sat(u);
    return r0 + u * (r1 - r0);
  };
  s.invert = (y) => {
    let u = r1 === r0 ? 0.5 : (y - r0) / (r1 - r0);
    if (clamp) u = sat(u);
    return inv(t0 + u * dt);
  };
  s.kind = kind; s.domain = domain; s.range = range; s.clamp = clamp; s.opts = { ...opts };
  s.copy = (patch = {}) => FACTORY[kind]({ ...opts, ...patch });
  Object.assign(s, extra);
  return s;
}

/** 线性：scaleLinear({ domain:[a,b], range:[c,d], clamp }) → s(x)，s.invert(y) */
export const scaleLinear = (opts) => continuous('linear', (x) => x, (x) => x, opts);

/** 对数：scaleLog({ domain, range, base=10, clamp })。domain 必须同号且非零（负域按 −log(−x)）。 */
export function scaleLog(opts) {
  const base = opts.base ?? 10; need(base > 0 && base !== 1, 'scaleLog 的 base 要 > 0 且 ≠ 1');
  const neg = +opts.domain[0] < 0;
  const lb = dmath.log(base);
  const fwd = neg ? (x) => -dmath.log(-x) / lb : (x) => dmath.log(x) / lb;
  const inv = neg ? (y) => -dmath.pow(base, -y) : (y) => dmath.pow(base, y);
  return continuous('log', fwd, inv, { ...opts, base }, { base });
}

/** 幂：scalePow({ domain, range, exponent, clamp })，按符号保持：sign(x)·|x|^k。exponent 必给。 */
export function scalePow(opts) {
  const k = opts.exponent; need(Number.isFinite(k) && k !== 0, 'scalePow 要给非零的 exponent');
  const sp = (e) => (x) => (x < 0 ? -dmath.pow(-x, e) : dmath.pow(x, e));
  return continuous('pow', sp(k), sp(1 / k), opts, { exponent: k });
}
/** 平方根：面积编码（气泡半径）用它，值翻倍面积翻倍。 */
export const scaleSqrt = (opts) => scalePow({ ...opts, exponent: 0.5 });

/** 时间：scaleTime({ domain:[ms, ms], range, clamp, utcOffset=0 })。domain 是时间戳（毫秒）或 Date；utcOffset 单位分钟。 */
export function scaleTime(opts) {
  const utcOffset = opts.utcOffset ?? 0;
  return continuous('time', (x) => +x, (x) => x, { ...opts, utcOffset }, { utcOffset });
}

/**
 * 分类轴：scaleBand({ domain: keys | n, range:[a,b], paddingInner, paddingOuter | padding, align=0.5 })
 * padding 没有默认：间距是长相的一部分，必须由调用方给。s(key) → 带起点；s.bandwidth、s.step；
 * s.at(i) 接受**小数下标**（柱状图竞赛里的连续名次就喂给它）；s.invert(px) → 所在的 key。
 */
export function scaleBand(opts) { return bandLike('band', opts); }
/** 点轴：scalePoint({ domain, range, padding })，等价于 paddingInner = 1 的 band，bandwidth = 0。 */
export function scalePoint(opts) {
  need(Number.isFinite(opts.padding), 'scalePoint 要给 padding（两端留几个 step 的一半，0 表示首尾贴边）');
  return bandLike('point', { ...opts, paddingInner: 1, paddingOuter: opts.padding });
}
function bandLike(kind, opts) {
  const keys = typeof opts.domain === 'number' ? Array.from({ length: opts.domain }, (_, i) => i) : [...opts.domain];
  const pi = opts.paddingInner ?? opts.padding, po = opts.paddingOuter ?? opts.padding;
  need(Number.isFinite(pi) && Number.isFinite(po), `${kind} 要给 paddingInner 与 paddingOuter（或 padding）：间距没有默认值`);
  need(pi >= 0 && pi <= 1 && po >= 0, `${kind} 的 paddingInner 要在 [0,1]、paddingOuter ≥ 0`);
  const align = opts.align ?? 0.5;
  const [r0, r1] = pair(opts.range, `${kind} 的 range`);
  const n = keys.length, rev = r1 < r0;
  const lo = Math.min(r0, r1), hi = Math.max(r0, r1);
  const step = (hi - lo) / Math.max(1, n - pi + po * 2);
  const start = lo + (hi - lo - step * (n - pi)) * align;
  const bandwidth = step * (1 - pi);
  const at = (i) => start + step * (rev ? n - 1 - i : i);
  const index = new Map(keys.map((k, i) => [k, i]));
  const s = (key) => { const i = index.get(key); return i === undefined ? undefined : at(i); };
  s.at = at;
  s.invert = (px) => {
    if (!n) return undefined;
    let i = Math.floor((px - start) / step); i = Math.max(0, Math.min(n - 1, i));
    return keys[rev ? n - 1 - i : i];
  };
  Object.assign(s, { kind, domain: keys, range: [r0, r1], step, bandwidth, opts: { ...opts } });
  s.copy = (patch = {}) => FACTORY[kind]({ ...opts, ...patch });
  return s;
}

const FACTORY = { linear: scaleLinear, log: scaleLog, pow: scalePow, time: scaleTime, band: scaleBand, point: scalePoint };

function logTicks(s, count) {
  const [a, b] = s.domain, base = s.base;
  if (a < 0) return logTicks({ domain: [-a, -b], base }, count).map((x) => -x);   // 负域镜像
  const rev = b < a; const [u, v] = rev ? [b, a] : [a, b];
  const lb = dmath.log(base);
  const i = Math.floor(dmath.log(u) / lb), j = Math.ceil(dmath.log(v) / lb);
  const pw = (k) => (base === 10 ? pow10(k) : powInt(base, k));
  let z = [];
  if (Number.isInteger(base) && j - i < count) {
    for (let k = i; k <= j; k++) for (let m = 1; m < base; m++) {
      const t = k < 0 ? m / pw(-k) : m * pw(k);
      if (t >= u * (1 - 1e-12) && t <= v * (1 + 1e-12)) z.push(t);
    }
    if (z.length * 2 < count) z = linearTicks(u, v, count);
  } else {
    z = linearTicks(i, j, Math.min(j - i, count)).filter(Number.isInteger).map(pw);
  }
  return rev ? z.reverse() : z;
}

// ---- 时间刻度 ----
const SEC = 1e3, MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const T_IV = [
  ['second', 1, SEC], ['second', 5, 5 * SEC], ['second', 15, 15 * SEC], ['second', 30, 30 * SEC],
  ['minute', 1, MIN], ['minute', 5, 5 * MIN], ['minute', 15, 15 * MIN], ['minute', 30, 30 * MIN],
  ['hour', 1, HOUR], ['hour', 3, 3 * HOUR], ['hour', 6, 6 * HOUR], ['hour', 12, 12 * HOUR],
  ['day', 1, DAY], ['day', 2, 2 * DAY], ['day', 7, 7 * DAY],
  ['month', 1, 30 * DAY], ['month', 3, 91 * DAY], ['year', 1, 365 * DAY],
];

// 时间间隔：在"已加偏移"的 UTC 空间里取整与步进
function timeInterval(unit, step) {
  const fixedMs = { millisecond: 1, second: SEC, minute: MIN, hour: HOUR }[unit];
  if (fixedMs) { const ms = step * fixedMs; return { unit, step, floor: (v) => Math.floor(v / ms) * ms, next: (v) => v + ms }; }
  const D = (v) => new Date(v);
  if (unit === 'day') {
    const ok = (v) => (D(v).getUTCDate() - 1) % step === 0;
    const day0 = (v) => { const d = D(v); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    return { unit, step, floor: (v) => { let x = day0(v); while (!ok(x)) x -= DAY; return x; }, next: (v) => { let x = day0(v) + DAY; while (!ok(x)) x += DAY; return x; } };
  }
  if (unit === 'month') {
    return { unit, step, floor: (v) => { const d = D(v), m = d.getUTCMonth(); return Date.UTC(d.getUTCFullYear(), m - (m % step), 1); },
      next: (v) => { const d = D(v); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1); } };
  }
  const fl = (y) => Math.floor(y / step) * step;
  return { unit, step, floor: (v) => Date.UTC(fl(D(v).getUTCFullYear()), 0, 1), next: (v) => Date.UTC(D(v).getUTCFullYear() + step, 0, 1) };
}

function pickTimeInterval(lo, hi, count) {
  const target = (hi - lo) / count;
  if (target < SEC) return timeInterval('millisecond', Math.max(1, tickIncrement(0, hi - lo, count)));
  if (target > 365 * DAY) {
    const y0 = new Date(lo).getUTCFullYear(), y1 = new Date(hi).getUTCFullYear();
    return timeInterval('year', Math.max(1, tickIncrement(y0, Math.max(y1, y0 + 1), count)));
  }
  let best = T_IV[0], bd = Infinity;
  for (const iv of T_IV) { const d = Math.abs(dmath.log(iv[2] / target)); if (d < bd) { bd = d; best = iv; } }
  return timeInterval(best[0], best[1]);
}

function timeTicksOf(a, b, count, off) {
  const rev = b < a, sh = off * MIN;
  const lo = Math.min(a, b) + sh, hi = Math.max(a, b) + sh;
  const iv = pickTimeInterval(lo, hi, count), out = [];
  let v = iv.floor(lo); if (v < lo) v = iv.next(v);
  for (let guard = 0; v <= hi && guard < 10000; guard++, v = iv.next(v)) out.push(v - sh);
  if (rev) out.reverse();
  out.unit = iv.unit; out.step = iv.step;
  return out;
}

/**
 * 取整刻度。linear/pow：1/2/5×10^k；log：整次幂（跨度小时补 2…9 倍）；time：按秒/分/时/日/月/年（返回数组带 .unit .step）；
 * band/point：返回 domain。count 是"大约几个"，不是保证。
 */
export function ticks(scale, count) {
  need(scale && scale.kind, 'ticks(scale, count) 的 scale 要是本文件造的比例尺');
  need(scale.kind === 'band' || scale.kind === 'point' || count > 0, 'ticks 要给 count > 0');
  switch (scale.kind) {
    case 'linear': case 'pow': return linearTicks(scale.domain[0], scale.domain[1], count);
    case 'log': return logTicks(scale, count);
    case 'time': return timeTicksOf(scale.domain[0], scale.domain[1], count, scale.utcOffset);
    default: return [...scale.domain];
  }
}

/** 把 domain 外扩到取整刻度上，返回新比例尺（原比例尺不变）。 */
export function nice(scale, count) {
  need(count > 0, 'nice 要给 count > 0');
  const [a, b] = scale.domain;
  if (scale.kind === 'linear' || scale.kind === 'pow') return scale.copy({ domain: niceLinear(a, b, count) });
  if (scale.kind === 'log') {
    const lb = dmath.log(scale.base), sg = a < 0 ? -1 : 1;
    const [u, v] = [Math.abs(a), Math.abs(b)];
    const f = (x, up) => dmath.pow(scale.base, up ? Math.ceil(dmath.log(x) / lb - 1e-12) : Math.floor(dmath.log(x) / lb + 1e-12));
    return scale.copy({ domain: u <= v ? [sg * f(u, false), sg * f(v, true)] : [sg * f(u, true), sg * f(v, false)] });
  }
  if (scale.kind === 'time') {
    const sh = scale.utcOffset * MIN, lo = Math.min(a, b) + sh, hi = Math.max(a, b) + sh;
    const iv = pickTimeInterval(lo, hi, count);
    const nlo = iv.floor(lo); let nhi = iv.floor(hi); if (nhi < hi) nhi = iv.next(nhi);
    return scale.copy({ domain: a <= b ? [nlo - sh, nhi - sh] : [nhi - sh, nlo - sh] });
  }
  return scale.copy();
}

/** 时间戳 → 各字段（UTC + 偏移分钟）。月份 1–12，weekday 0=周日。拼什么样的标签由调用方决定。 */
export function timeParts(ts, { utcOffset = 0 } = {}) {
  const d = new Date(+ts + utcOffset * MIN);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(),
    minute: d.getUTCMinutes(), second: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), weekday: d.getUTCDay() };
}

// ===========================================================================
// 2. 数值格式化（格式由调用方选；decimals 一律必给）
// ===========================================================================
const needDec = (d, who) => need(Number.isInteger(d) && d >= 0 && d <= 20, `${who} 要给 decimals（0–20 的整数）`);
const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** 定长小数：fixed(3.14159, 2) → '3.14'；−0.001 → '0.00'（不出 '-0.00'）。 */
export function fixed(x, decimals) {
  needDec(decimals, 'fixed');
  if (!Number.isFinite(x)) return String(x);
  const s = x.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** 千分位：grouped(1234567.8, { decimals: 1, sep: ',', point: '.', group: 3 }) → '1,234,567.8' */
export function grouped(x, { decimals, sep = ',', point = '.', group = 3, trim = false } = {}) {
  needDec(decimals, 'grouped');
  let s = fixed(x, decimals); if (trim) s = trimZeros(s);
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  const [ip, fp] = s.split('.');
  let out = '';
  for (let i = 0; i < ip.length; i++) { if (i && (ip.length - i) % group === 0) out += sep; out += ip[i]; }
  return (neg ? '-' : '') + out + (fp !== undefined ? point + fp : '');
}

export const SI_UNITS = Object.freeze([[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']]);
export const CJK_UNITS = Object.freeze([[1e12, '万亿'], [1e8, '亿'], [1e4, '万'], [1, '']]);

function scaledFormat(x, units, decimals, trim, who) {
  needDec(decimals, who);
  if (!Number.isFinite(x)) return String(x);
  const us = [...units].sort((a, b) => b[0] - a[0]);
  const ax = Math.abs(x);
  let k = us.findIndex(([u]) => ax >= u);
  if (k < 0) k = us.length - 1;
  if (ax === 0) k = us.findIndex(([u]) => u === 1) >= 0 ? us.findIndex(([u]) => u === 1) : us.length - 1;
  // 进位：9999.6 按 0 位小数是 '10000'，该升到上一个单位（'1万'）
  for (;;) {
    const m = fixed(x / us[k][0], decimals);
    if (k > 0 && Math.abs(+m) * us[k][0] >= us[k - 1][0]) { k--; continue; }
    return (trim ? trimZeros(m) : m) + us[k][1];
  }
}
/** SI 词头：si(12345, { decimals: 1 }) → '12.3k'。units 可换（如 [[1e9,'B'],[1e6,'M'],[1e3,'K'],[1,'']]）。 */
export const si = (x, { decimals, trim = false, units = SI_UNITS } = {}) => scaledFormat(x, units, decimals, trim, 'si');
/** 中文万/亿：cjk(123456789, { decimals: 2 }) → '1.23亿'；units 默认 万亿/亿/万。 */
export const cjk = (x, { decimals, trim = false, units = CJK_UNITS } = {}) => scaledFormat(x, units, decimals, trim, 'cjk');
/** 百分比：percent(0.1234, { decimals: 1 }) → '12.3%'（输入是比例，不是百分数）。 */
export const percent = (x, { decimals, trim = false, sign = '%' } = {}) => { needDec(decimals, 'percent'); const s = fixed(x * 100, decimals); return (trim ? trimZeros(s) : s) + sign; };

/** formatter('cjk', { decimals: 1 }) → x → 字符串。kind ∈ fixed | grouped | si | cjk | percent */
export function formatter(kind, opts = {}) {
  const F = { fixed: (x) => fixed(x, opts.decimals), grouped: (x) => grouped(x, opts), si: (x) => si(x, opts), cjk: (x) => cjk(x, opts), percent: (x) => percent(x, opts) }[kind];
  need(F, `formatter 不认识 ${kind}（可选 fixed grouped si cjk percent）`);
  F(0);   // 参数不全在建的时候就报错，而不是在第一帧
  return F;
}

// ===========================================================================
// 3. 序列几何
// ===========================================================================
const sgn = (x) => (x < 0 ? -1 : 1);
function slope3(x0, y0, x1, y1, x2, y2) {
  const h0 = x1 - x0, h1 = x2 - x1;
  const s0 = (y1 - y0) / (h0 || (h1 < 0 && -0)), s1 = (y2 - y1) / (h1 || (h0 < 0 && -0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (sgn(s0) + sgn(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}
function slope2(x0, y0, x1, y1, t) { const h = x1 - x0; return h ? (3 * (y1 - y0) / h - t) / 2 : t; }

/**
 * 点列 → 路径命令 [['M',x,y], ['L',x,y], ['C',c1x,c1y,c2x,c2y,x,y], …]
 * curve：'linear' | 'step'（中点换阶）| 'stepBefore' | 'stepAfter' | 'monotone'（单调三次，x 必须严格递增）
 */
export function curvePath(pts, curve) {
  need(Array.isArray(pts), 'curvePath 的 pts 要是 [[x,y],…]');
  need(['linear', 'step', 'stepBefore', 'stepAfter', 'monotone'].includes(curve), `curvePath 不认识 curve=${curve}`);
  const n = pts.length; if (!n) return [];
  const out = [['M', pts[0][0], pts[0][1]]];
  if (curve === 'monotone' && n > 2) {
    for (let i = 1; i < n; i++) need(pts[i][0] > pts[i - 1][0], `monotone 要求 x 严格递增（第 ${i} 点 x=${pts[i][0]} ≤ 前一点）`);
    const m = new Array(n);
    for (let i = 1; i < n - 1; i++) m[i] = slope3(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    m[0] = slope2(pts[0][0], pts[0][1], pts[1][0], pts[1][1], m[1]);
    m[n - 1] = slope2(pts[n - 1][0], pts[n - 1][1], pts[n - 2][0], pts[n - 2][1], m[n - 2]);
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], dx = (x1 - x0) / 3;
      out.push(['C', x0 + dx, y0 + dx * m[i], x1 - dx, y1 - dx * m[i + 1], x1, y1]);
    }
    return out;
  }
  for (let i = 1; i < n; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i];
    if (curve === 'step') { const xm = (px + x) / 2; out.push(['L', xm, py], ['L', xm, y]); }
    else if (curve === 'stepAfter') out.push(['L', x, py]);
    else if (curve === 'stepBefore') out.push(['L', px, y]);
    out.push(['L', x, y]);
  }
  return out;
}

/** 路径命令 → 折线点列（三次段每段采 samples 个点；生长、弧长、面积都在折线上算）。 */
export function curvePoints(pts, curve, { samples } = {}) {
  const cmds = curvePath(pts, curve);
  if (curve === 'monotone' && pts.length > 2) need(Number.isInteger(samples) && samples >= 1, 'monotone 的 curvePoints 要给 samples（每段采样数，整数 ≥ 1）');
  const out = [];
  let cx = 0, cy = 0;
  for (const c of cmds) {
    if (c[0] === 'M' || c[0] === 'L') { out.push([c[1], c[2]]); cx = c[1]; cy = c[2]; continue; }
    const [, x1, y1, x2, y2, x3, y3] = c;
    for (let k = 1; k <= samples; k++) {
      const u = k / samples, v = 1 - u;
      out.push([v * v * v * cx + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3,
        v * v * v * cy + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3]);
    }
    cx = x3; cy = y3;
  }
  return out;
}

/** 把路径命令或点列描进 ctx 的当前路径（只 moveTo/lineTo/bezierCurveTo，不 stroke 不 fill）。 */
export function traceCurve(ctx, cmdsOrPts, { close = false } = {}) {
  const cmds = cmdsOrPts.length && typeof cmdsOrPts[0][0] === 'string' ? cmdsOrPts : cmdsOrPts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
    else ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
  }
  if (close) ctx.closePath();
}

/** 面积多边形：上沿点列 + 下沿（数 = 水平基线 y；或同长点列，比如堆叠的下一层）倒序拼接。 */
export function areaPoints(top, base) {
  const bottom = typeof base === 'number' ? top.map(([x]) => [x, base]) : base;
  need(Array.isArray(bottom), 'areaPoints 的 base 要是数（基线 y）或点列');
  return [...top, ...[...bottom].reverse()];
}

/**
 * 堆叠：stack(rows, keys, { offset, value }) → [{ key, points: [[y0, y1], …] }]（每行一对；顺序就是 keys 的顺序）
 * offset：'zero'（从 0 往上）| 'expand'（每行归一到 [0,1]）| 'diverging'（正值往上、负值往下）| 'silhouette'（以 0 为中线居中）
 */
export function stack(rows, keys, { offset, value = (row, key) => row[key] } = {}) {
  need(['zero', 'expand', 'diverging', 'silhouette'].includes(offset), 'stack 要给 offset：zero | expand | diverging | silhouette');
  const series = keys.map((key) => ({ key, points: new Array(rows.length) }));
  const totals = new Array(rows.length);
  rows.forEach((row, j) => {
    const vs = keys.map((k) => { const v = +value(row, k); return Number.isFinite(v) ? v : 0; });
    const pos = vs.reduce((s, v) => s + Math.max(0, v), 0), neg = vs.reduce((s, v) => s + Math.min(0, v), 0);
    totals[j] = pos + neg;
    if (offset === 'diverging') {
      let up = 0, dn = 0;
      vs.forEach((v, i) => { if (v >= 0) { series[i].points[j] = [up, up + v]; up += v; } else { series[i].points[j] = [dn + v, dn]; dn += v; } });
      return;
    }
    const sum = vs.reduce((s, v) => s + v, 0);
    let y = offset === 'silhouette' ? -sum / 2 : 0;
    const k = offset === 'expand' ? (sum ? 1 / sum : 0) : 1;
    vs.forEach((v, i) => { series[i].points[j] = [y * k, (y + v) * k]; y += v; });
  });
  series.totals = totals;
  return series;
}

/**
 * 饼/环角度区间：pie(values, { start, end, pad }) → [{ index, value, a0, a1, mid }]，按输入顺序（要排序先自己排）。
 * 角度约定同 canvas：弧度，0 = +x 方向，屏幕上顺时针增大（12 点钟方向是 −π/2）。start/end 必给；负值按 0。
 */
export function pie(values, { start, end, pad = 0 } = {}) {
  need(Number.isFinite(start) && Number.isFinite(end), 'pie 要给 start、end（弧度；12 点钟方向是 −π/2）');
  const vs = values.map((v) => Math.max(0, +v || 0));
  const total = vs.reduce((s, v) => s + v, 0), dir = end >= start ? 1 : -1;
  const avail = Math.max(0, Math.abs(end - start) - pad * vs.length);
  let a = start;
  return vs.map((v, index) => {
    const span = total ? (v / total) * avail : 0;
    const a0 = a + (dir * pad) / 2, a1 = a0 + dir * span;
    a = a1 + (dir * pad) / 2;
    return { index, value: values[index], a0, a1, mid: (a0 + a1) / 2 };
  });
}

/** 扇形/环形扇区的多边形点列：外弧 a0→a1（半径 r1），内弧 a1→a0（半径 r0；r0=0 时收到圆心）。step = 每段最大弧度。 */
export function arcPoints(cx, cy, r0, r1, a0, a1, { step } = {}) {
  need(step > 0, 'arcPoints 要给 step（每段最大弧度，如 π/90）');
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
  const out = [];
  for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); out.push([cx + r1 * dmath.cos(a), cy + r1 * dmath.sin(a)]); }
  if (r0 > 0) for (let i = n; i >= 0; i--) { const a = lerp(a0, a1, i / n); out.push([cx + r0 * dmath.cos(a), cy + r0 * dmath.sin(a)]); }
  else out.push([cx, cy]);
  return out;
}

/** 直方图分箱：bin(values, { domain:[lo,hi], thresholds: 数组 | count }) → [{ x0, x1, count, values }]；= hi 的值进最后一箱。 */
export function bin(values, { domain, thresholds } = {}) {
  const [lo, hi] = pair(domain, 'bin 的 domain');
  let th;
  if (Array.isArray(thresholds)) th = thresholds.filter((v) => v > lo && v < hi).sort((a, b) => a - b);
  else { need(thresholds > 0, 'bin 要给 thresholds（边界数组，或大约几箱的 count）'); th = linearTicks(lo, hi, thresholds).filter((v) => v > lo && v < hi); }
  const edges = [lo, ...th, hi];
  const bins = edges.slice(0, -1).map((x0, i) => ({ x0, x1: edges[i + 1], count: 0, values: [] }));
  for (const v of values) {
    if (!(v >= lo && v <= hi)) continue;
    let a = 0, b = bins.length - 1;
    while (a < b) { const m = (a + b + 1) >> 1; if (bins[m].x0 <= v) a = m; else b = m - 1; }
    bins[a].count++; bins[a].values.push(v);
  }
  return bins;
}

/** [min, max]；acc 可取字段。空数组 → [undefined, undefined]。 */
export function extent(values, acc = (d) => d) {
  let lo, hi;
  for (const d of values) { const v = +acc(d); if (!Number.isFinite(v)) continue; if (lo === undefined || v < lo) lo = v; if (hi === undefined || v > hi) hi = v; }
  return [lo, hi];
}

// ===========================================================================
// 4. 随 t 变化的数据
// ===========================================================================
function checkFrames(frames, who) {
  need(Array.isArray(frames) && frames.length >= 1, `${who} 要至少一个关键帧 [{ t, values: {键: 数} }, …]`);
  for (let i = 0; i < frames.length; i++) {
    need(Number.isFinite(frames[i].t) && frames[i].values && typeof frames[i].values === 'object', `${who} 第 ${i} 帧要有 t 和 values`);
    if (i) need(frames[i].t > frames[i - 1].t, `${who} 关键帧的 t 要严格递增（第 ${i} 帧）`);
  }
}
const seg = (ts, t) => { let a = 0, b = ts.length - 1; if (t <= ts[0]) return 0; if (t >= ts[b]) return b; while (a < b) { const m = (a + b + 1) >> 1; if (ts[m] <= t) a = m; else b = m - 1; } return a; };

/**
 * 多序列关键帧插值：keyframes([{ t, values: {a: 1, b: 2} }, …], { ease }) → K
 * K.at(t) → {键: 值}；K.get(key, t)；K.keys。ease(p) 是段内进度映射（线性 p=>p；阶梯 p=>0；缓动任选），必给。
 * 某帧缺某个键：在包含它的前后两帧之间插值；在它首次出现之前/最后出现之后保持边上的值。
 */
export function keyframes(frames, { ease } = {}) {
  checkFrames(frames, 'keyframes'); need(isFn(ease), 'keyframes 要给 ease 函数（线性 p => p，阶梯 p => 0）');
  const keys = []; const seen = new Set();
  for (const f of frames) for (const k of Object.keys(f.values)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const tracks = new Map(keys.map((k) => {
    const ts = [], vs = [];
    for (const f of frames) if (Object.hasOwn(f.values, k) && Number.isFinite(+f.values[k])) { ts.push(f.t); vs.push(+f.values[k]); }
    return [k, { ts, vs }];
  }));
  const get = (k, t) => {
    const tr = tracks.get(k); if (!tr || !tr.ts.length) return undefined;
    const { ts, vs } = tr, i = seg(ts, t);
    if (i >= ts.length - 1 || t <= ts[0]) return t <= ts[0] ? vs[0] : vs[ts.length - 1];
    return lerp(vs[i], vs[i + 1], ease((t - ts[i]) / (ts[i + 1] - ts[i])));
  };
  return { keys, get, at: (t) => Object.fromEntries(keys.map((k) => [k, get(k, t)])), t0: frames[0].t, t1: frames[frames.length - 1].t };
}

/**
 * 柱状图竞赛：barRace(frames, { top, ease, swap, fade, fill, resolution }) → R
 *   frames  [{ t, values: {名: 值} }, …]
 *   top     显示前几名（Top-N）
 *   ease    关键帧之间值的插值进度映射（同 keyframes）
 *   swap    名次怎么换：
 *             { duration, ease, align=0.5 }：名次由**当前插值后的值**实时决定；每次交换在 duration 秒内由 ease(0→1) 平滑走完，
 *                交换点（值相等的时刻）位于过渡窗口的 align 处。两条交换的位置之和恒定，正好在窗口中点擦肩。
 *             'keyframe'：名次只在关键帧上算，整段 lerp（ease 同上）；交换在整段里慢慢完成。
 *   fade    进出榜的淡出宽度（以名次计）：alpha = sat((top − pos) / fade)
 *   fill    某帧缺某名时用的值（必须显式给；不给而数据有缺口就报错）
 *   resolution 加载期扫描交换事件的时间步（秒，默认 1/240）：两次交换间隔小于它会并成一次
 * R.at(t) → [{ key, value, pos, rank, alpha }]（pos 是连续名次，0 = 第一；只返回 alpha > 0 的，按 pos 升序）
 * R.all(t) → 全部条目；R.maxAt(t) → 当前最大值（连续，适合喂给轴的 domain）；R.events → 交换事件表
 */
export function barRace(frames, { top, ease, swap, fade, fill, resolution = 1 / 240 } = {}) {
  checkFrames(frames, 'barRace');
  need(Number.isInteger(top) && top >= 1, 'barRace 要给 top（整数 ≥ 1）');
  need(isFn(ease), 'barRace 要给 ease（值在关键帧之间的插值进度映射）');
  need(fade > 0, 'barRace 要给 fade（进出榜淡出宽度，以名次计，如 1）');
  need(swap === 'keyframe' || (swap && swap.duration > 0 && isFn(swap.ease)), "barRace 要给 swap：'keyframe' 或 { duration, ease, align }");
  const keys = []; const seen = new Set();
  for (const f of frames) for (const k of Object.keys(f.values)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const n = keys.length, nf = frames.length;
  const V = frames.map((f, fi) => keys.map((k) => {
    if (Object.hasOwn(f.values, k) && Number.isFinite(+f.values[k])) return +f.values[k];
    need(Number.isFinite(fill), `barRace：第 ${fi} 帧（t=${f.t}）缺 "${k}"，要给 fill（缺口按什么值算）`);
    return fill;
  }));
  const ts = frames.map((f) => f.t);
  const valuesAt = (t, out = new Float64Array(n)) => {
    const i = seg(ts, t);
    if (i >= nf - 1 || t <= ts[0]) { const row = V[t <= ts[0] ? 0 : nf - 1]; for (let j = 0; j < n; j++) out[j] = row[j]; return out; }
    const p = ease((t - ts[i]) / (ts[i + 1] - ts[i]));
    for (let j = 0; j < n; j++) out[j] = lerp(V[i][j], V[i + 1][j], p);
    return out;
  };
  const order = keys.map((_, i) => i);
  const ranksOf = (vals) => {   // 值降序，平局按首次出现顺序：确定性的全序
    const o = order.slice().sort((a, b) => (vals[b] - vals[a]) || (a - b));
    const r = new Int32Array(n); o.forEach((k, i) => { r[k] = i; }); return r;
  };
  const rankAt = (t) => ranksOf(valuesAt(t));

  let posAt, events = [];
  if (swap === 'keyframe') {
    const RK = V.map((row) => ranksOf(row));
    posAt = (t, out) => {
      const i = seg(ts, t);
      if (i >= nf - 1 || t <= ts[0]) { const r = RK[t <= ts[0] ? 0 : nf - 1]; for (let j = 0; j < n; j++) out[j] = r[j]; return out; }
      const p = ease((t - ts[i]) / (ts[i + 1] - ts[i]));
      for (let j = 0; j < n; j++) out[j] = lerp(RK[i][j], RK[i + 1][j], p);
      return out;
    };
  } else {
    const { duration: d, ease: se } = swap, align = swap.align ?? 0.5;
    const r0 = rankAt(ts[0]);
    const steps = Math.max(1, Math.ceil((ts[nf - 1] - ts[0]) / resolution));
    let prevT = ts[0], prev = r0;
    for (let s = 1; s <= steps; s++) {
      const tt = Math.min(ts[nf - 1], ts[0] + s * resolution), cur = rankAt(tt);
      for (let j = 0; j < n; j++) if (cur[j] !== prev[j]) {
        let a = prevT, b = tt;   // 二分出这一名的名次第一次改变的时刻
        for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (rankAt(m)[j] === prev[j]) a = m; else b = m; }
        events.push({ key: keys[j], index: j, t: (a + b) / 2, from: prev[j], to: cur[j] });
      }
      prev = cur; prevT = tt;
    }
    const byKey = keys.map(() => []);
    for (const e of events) byKey[e.index].push(e);
    posAt = (t, out) => {
      for (let j = 0; j < n; j++) {
        let p = r0[j];
        for (const e of byKey[j]) p += (e.to - e.from) * se(sat((t - e.t) / d + align));
        out[j] = p;
      }
      return out;
    };
  }
  const all = (t) => {
    const vals = valuesAt(t), pos = posAt(t, new Float64Array(n)), rk = ranksOf(vals);
    return keys.map((key, j) => ({ key, value: vals[j], pos: pos[j], rank: rk[j], alpha: sat((top - pos[j]) / fade) }))
      .sort((a, b) => a.pos - b.pos || a.rank - b.rank);
  };
  return {
    keys, events, top,
    all,
    at: (t) => all(t).filter((it) => it.alpha > 0),
    maxAt: (t) => { const v = valuesAt(t); let m = -Infinity; for (const x of v) if (x > m) m = x; return m; },
    valuesAt: (t) => { const v = valuesAt(t); return Object.fromEntries(keys.map((k, j) => [k, v[j]])); },
  };
}

/**
 * 折线生长：lineGrower(pts) → G（加载期算一次累积弧长）
 * G.at(p, by)：by = 'length'（按弧长比例）| 'x'（按 x 域比例，要求 x 单调）→ { points, end:[x,y], angle, length, index }
 * G.atX(x)、G.atLength(s) 同上但给绝对量。points 含插值出来的末端点，可直接 traceCurve 后 stroke。
 * 任意 SVG 路径的弧长生长（Trim Paths）见 shapes.js 的 trim；这里多了"按 x 推进"和末端点/朝向，跟标签或镜头用。
 */
export function lineGrower(pts) {
  need(Array.isArray(pts) && pts.length >= 1, 'lineGrower 要点列 [[x,y],…]');
  const n = pts.length, L = new Float64Array(n);
  for (let i = 1; i < n; i++) L[i] = L[i - 1] + dmath.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const total = L[n - 1];
  const result = (i, u) => {   // 截到第 i 段的 u 处
    if (n === 1) return { points: [pts[0].slice()], end: pts[0].slice(), angle: 0, length: 0, index: 0 };
    i = Math.max(0, Math.min(n - 2, i));
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const end = [lerp(x0, x1, u), lerp(y0, y1, u)];
    const points = pts.slice(0, i + 1).map((p) => p.slice()); points.push(end);
    return { points, end, angle: dmath.atan2(y1 - y0, x1 - x0), length: lerp(L[i], L[i + 1], u), index: i };
  };
  const atLength = (s) => {
    s = Math.max(0, Math.min(total, s));
    let a = 0, b = n - 1; while (a < b) { const m = (a + b + 1) >> 1; if (L[m] <= s) a = m; else b = m - 1; }
    if (a >= n - 1) return result(n - 2, 1);
    const sl = L[a + 1] - L[a];
    return result(a, sl ? (s - L[a]) / sl : 0);
  };
  const atX = (x) => {
    const inc = pts[n - 1][0] >= pts[0][0], lo = inc ? pts[0][0] : pts[n - 1][0], hi = inc ? pts[n - 1][0] : pts[0][0];
    x = Math.max(lo, Math.min(hi, x));
    for (let i = 0; i < n - 1; i++) {
      const xa = pts[i][0], xb = pts[i + 1][0];
      if ((inc && x <= xb) || (!inc && x >= xb)) return result(i, xb === xa ? 1 : (x - xa) / (xb - xa));
    }
    return result(n - 2, 1);
  };
  return {
    total, atLength, atX,
    at: (p, by) => {
      need(by === 'length' || by === 'x', "lineGrower.at(p, by)：by 要给 'length' 或 'x'");
      p = sat(p);
      return by === 'length' ? atLength(p * total) : atX(lerp(pts[0][0], pts[n - 1][0], p));
    },
  };
}

/**
 * 随域变化的坐标轴刻度：axisTicks(scale, count, { blend, edge }) → [{ value, pos, alpha, step }]
 * 只认 linear / pow。它是比例尺的纯函数：域随 t 连续变化时，把 scale(t) 传进来，每个刻度的 pos 与 alpha 自然连续——
 *   blend  在 1/2/5 两档步长之间交叉淡化的宽度（log10 单位，> 0；如 0.15）。刻度的 alpha = 它所属各档权重之和，两档共有的刻度一直是 1
 *   edge   刻度进出轴两端时的淡化距离（像素，≥ 0）：在域外 edge 像素以内的刻度按距离淡出；0 = 到边就消失（会跳）
 */
export function axisTicks(scale, count, { blend, edge } = {}) {
  need(scale && (scale.kind === 'linear' || scale.kind === 'pow'), 'axisTicks 只支持 linear / pow 比例尺');
  need(count > 0 && blend > 0 && edge >= 0, 'axisTicks 要给 count > 0、blend > 0（log10 单位）、edge ≥ 0（像素）');
  const [da, db] = scale.domain, lo = Math.min(da, db), hi = Math.max(da, db);
  if (!(hi > lo)) return [];
  const L = dmath.log10((hi - lo) / count);
  const B = [dmath.log10(E2), 0.5, dmath.log10(E10) - 1];    // 1→2、2→5、5→10 的分界（相对 q）
  const levels = [];
  for (let q = Math.floor(L) - 1; q <= Math.floor(L) + 1; q++) {
    const spans = [[1, q - 1 + dmath.log10(E10), q + B[0]], [2, q + B[0], q + B[1]], [5, q + B[1], q + 1 + B[2]]];
    for (const [f, a, b] of spans) {
      const w = sat((L - a) / blend + 0.5) * sat((b - L) / blend + 0.5);
      if (w > 0) levels.push({ f, q, w });
    }
  }
  if (!levels.length) return [];
  const qu = Math.min(...levels.map((l) => l.q));
  const unit = (i) => (qu >= 0 ? i * pow10(qu) : i / pow10(-qu));
  for (const l of levels) l.m = l.f * pow10(l.q - qu);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const mMin = levels.reduce((g, l) => gcd(g, l.m), 0);   // 几档并存（如 20 与 50）时按公约数枚举，两档的刻度都要枚举到
  const [r0, r1] = scale.range, pxPerUnit = Math.abs(r1 - r0) / (hi - lo);
  const ext = edge > 0 && pxPerUnit > 0 ? edge / pxPerUnit : 0;   // edge 像素换成域单位（pow 下是线性近似）
  const u0 = qu >= 0 ? pow10(qu) : 1 / pow10(-qu);
  const i0 = Math.ceil((lo - ext) / u0 / mMin) * mMin, i1 = Math.floor((hi + ext) / u0 / mMin) * mMin;
  const out = [];
  const rlo = Math.min(r0, r1), rhi = Math.max(r0, r1);
  for (let i = i0; i <= i1; i += mMin) {
    // 属于几档就把几档的权重加起来：相邻两档在分界处权重和为 1，所以两档共有的刻度（20 与 50 档里的 100）全程不透明
    let a = 0, step = 0, best = 0;
    for (const l of levels) if (i % l.m === 0) { a += l.w; if (l.w > best) { best = l.w; step = unit(l.m); } }
    a = Math.min(1, a);
    if (!(a > 0)) continue;
    const value = unit(i), pos = scale(value);
    const outside = Math.max(0, rlo - pos, pos - rhi);
    const ae = outside === 0 ? 1 : edge > 0 ? sat(1 - outside / edge) : 0;
    if (a * ae > 0) out.push({ value, pos, alpha: a * ae, step });
  }
  return out;
}

// ===========================================================================
// 5. 地理（不带任何地图数据）
// ===========================================================================
const wrapPi = (l) => { l = ((l + PI) % TAU + TAU) % TAU - PI; return l; };
const asinC = (x) => dmath.asin(x < -1 ? -1 : x > 1 ? 1 : x);

function makeRotation([l0 = 0, p0 = 0, g0 = 0] = []) {
  const dl = l0 * D2R, dp = p0 * D2R, dg = g0 * D2R;
  const cp = dmath.cos(dp), sp = dmath.sin(dp), cg = dmath.cos(dg), sg = dmath.sin(dg), pg = dp !== 0 || dg !== 0;
  return {
    fwd(l, p) {
      l = wrapPi(l + dl); if (!pg) return [l, p];
      const c = dmath.cos(p), x = dmath.cos(l) * c, y = dmath.sin(l) * c, z = dmath.sin(p), k = z * cp + x * sp;
      return [dmath.atan2(y * cg - k * sg, x * cp - z * sp), asinC(k * cg + y * sg)];
    },
    inv(l, p) {
      if (pg) {
        const c = dmath.cos(p), x = dmath.cos(l) * c, y = dmath.sin(l) * c, z = dmath.sin(p), k = z * cg - y * sg;
        const l2 = dmath.atan2(y * cg + z * sg, x * cp + k * sp); p = asinC(k * cp - x * sp); l = l2;
      }
      return [wrapPi(l - dl), p];
    },
  };
}

const RAW = {
  equirectangular: () => ({ cyl: true, fwd: (l, p) => [l, p], inv: (x, y) => [x, y] }),
  mercator: ({ clipLat = 85.05112877980659 }) => {
    const pm = clipLat * D2R;
    return { cyl: true, clipLat, fwd: (l, p) => [l, dmath.log(dmath.tan(PI / 4 + Math.max(-pm, Math.min(pm, p)) / 2))], inv: (x, y) => [x, 2 * dmath.atan(dmath.exp(y)) - PI / 2] };
  },
  orthographic: () => ({ sphere: true, fwd: (l, p) => [dmath.cos(p) * dmath.sin(l), dmath.sin(p)],
    inv: (x, y) => { const r2 = x * x + y * y; if (r2 > 1 + 1e-12) return null; const z = Math.sqrt(Math.max(0, 1 - r2)); return [dmath.atan2(x, z), asinC(y)]; } }),
  albers: ({ parallels }) => {
    need(Array.isArray(parallels) && parallels.length === 2, 'albers 要给 parallels:[φ1, φ2]（度）');
    const s1 = dmath.sin(parallels[0] * D2R), n = (s1 + dmath.sin(parallels[1] * D2R)) / 2;
    need(Math.abs(n) > 1e-6, 'albers 的两条标准纬线关于赤道对称（n≈0），退化成圆柱：改用 equirectangular 或换纬线');
    const c = 1 + s1 * (2 * n - s1), r0 = Math.sqrt(c) / n;
    return {
      fwd: (l, p) => { const r = Math.sqrt(Math.max(0, c - 2 * n * dmath.sin(p))) / n; return [r * dmath.sin(l * n), r0 - r * dmath.cos(l * n)]; },
      inv: (x, y) => {
        const r0y = r0 - y; let l = dmath.atan2(x, Math.abs(r0y)) * Math.sign(r0y || 1);
        if (r0y * n < 0) l -= PI * Math.sign(x) * Math.sign(r0y);
        return [l / n, asinC((c - (x * x + r0y * r0y) * n * n) / (2 * n))];
      },
    };
  },
};

/**
 * projection(kind, { scale=1, translate=[0,0], rotate=[λ,φ,γ], parallels, clipLat }) → P
 *   kind：'equirectangular' | 'mercator' | 'orthographic' | 'albers'（等积圆锥，parallels 必给）
 *   rotate 语义同 d3（度）：把 (lon, lat) 转到画面中心用 rotate: [−lon, −lat]
 * P.project([lon, lat]) → [x, y]，屏幕坐标（y 向下）；orthographic 背面的点返回 null
 * P.invert([x, y]) → [lon, lat] | null；P.visible([lon, lat])；P.with(patch) → 新投影；P.worldRect()（圆柱投影的 ±180° 外框）
 */
export function projection(kind, opts = {}) {
  need(RAW[kind], `projection 不认识 ${kind}（可选 ${Object.keys(RAW).join(' / ')}）`);
  const o = { scale: 1, translate: [0, 0], rotate: [0, 0, 0], ...opts };
  const raw = RAW[kind](o), rot = makeRotation(o.rotate);
  const k = o.scale, [tx, ty] = o.translate;
  const toScreen = (X, Y) => [tx + k * X, ty - k * Y];
  const P = {
    kind, opts: o, raw, rot, scale: k, translate: [tx, ty], cylindrical: !!raw.cyl, sphere: !!raw.sphere,
    toScreen,
    rotated: ([lon, lat]) => rot.fwd(lon * D2R, lat * D2R),
    projectRotated: (l, p) => { const [X, Y] = raw.fwd(l, p); return toScreen(X, Y); },
    visible: ([lon, lat]) => { if (!raw.sphere) return true; const [l, p] = rot.fwd(lon * D2R, lat * D2R); return dmath.cos(p) * dmath.cos(l) >= 0; },
    project(ll) { const [l, p] = rot.fwd(ll[0] * D2R, ll[1] * D2R); if (raw.sphere && dmath.cos(p) * dmath.cos(l) < 0) return null; const [X, Y] = raw.fwd(l, p); return toScreen(X, Y); },
    invert([x, y]) {
      const r = raw.inv((x - tx) / k, (ty - y) / k); if (!r) return null;
      const [l, p] = rot.inv(r[0], r[1]); return [l * R2D, p * R2D];
    },
    with: (patch) => projection(kind, { ...o, ...patch }),
    worldRect() {
      need(raw.cyl, 'worldRect 只对圆柱投影（equirectangular / mercator）有意义');
      const lat = (raw.clipLat ?? 90) * D2R;
      const [x0, y0] = toScreen(...raw.fwd(-PI, lat)), [x1, y1] = toScreen(...raw.fwd(PI, -lat));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, period: TAU * k };
    },
  };
  return P;
}

const toVec = (l, p) => { const c = dmath.cos(p); return [c * dmath.cos(l), c * dmath.sin(l), dmath.sin(p)]; };
const fromVec = ([x, y, z]) => [dmath.atan2(y, x), asinC(z / dmath.hypot(x, y, z))];

function densifyLL(ring, maxDeg) {
  if (!(maxDeg > 0) || ring.length < 2) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], gc = greatCircle(a, b), deg = gc.distance * R2D;
    const n = Math.ceil(deg / maxDeg);
    for (let s = 1; s < n; s++) out.push(gc.at(s / n));
    out.push(b);
  }
  return out;
}

// 球面（orthographic）：把一串旋转后的点按地平线切开。返回可见段 [{ pts: 屏幕点, startCut, endCut, a0, a1 }]
function sphereRuns(P, rl) {
  const runs = []; let cur = null;
  const vis = (v) => v[0] >= 0;
  const limb = (v) => { const y = v[1], z = v[2], h = dmath.hypot(y, z) || 1; return [y / h, z / h]; };
  const limbScreen = (yz) => P.toScreen(yz[0], yz[1]);
  for (let i = 0; i < rl.length; i++) {
    const v = toVec(rl[i][0], rl[i][1]);
    if (i > 0) {
      const u = toVec(rl[i - 1][0], rl[i - 1][1]);
      if (vis(u) !== vis(v)) {
        const s = u[0] / (u[0] - v[0]);
        const c = limb([0, u[1] + s * (v[1] - u[1]), u[2] + s * (v[2] - u[2])]);
        if (vis(u)) { cur.pts.push(limbScreen(c)); cur.endCut = dmath.atan2(c[1], c[0]); runs.push(cur); cur = null; }
        else { cur = { pts: [limbScreen(c)], startCut: dmath.atan2(c[1], c[0]), endCut: null }; }
      }
    }
    if (vis(v)) { if (!cur) cur = { pts: [], startCut: null, endCut: null }; cur.pts.push(P.projectRotated(rl[i][0], rl[i][1])); }
  }
  if (cur) runs.push(cur);
  return runs;
}

function limbArc(P, a0, a1, stepRad) {
  let d = wrapPi(a1 - a0);   // 走短的那一边
  const n = Math.max(1, Math.ceil(Math.abs(d) / stepRad)), out = [];
  for (let i = 1; i < n; i++) { const a = a0 + (d * i) / n; out.push(P.toScreen(dmath.cos(a), dmath.sin(a))); }
  return out;
}

// 圆柱投影的经度展开：跨 ±180° 时不折回，而是继续往外走（画两遍 ± period 并裁到 worldRect 即得正确结果）
function unwrapCyl(P, rl) {
  const pts = []; let off = 0, crosses = false;
  for (let i = 0; i < rl.length; i++) {
    if (i) { const d = rl[i][0] - rl[i - 1][0]; if (d > PI) { off -= TAU; crosses = true; } else if (d < -PI) { off += TAU; crosses = true; } }
    pts.push(P.projectRotated(rl[i][0] + off, rl[i][1]));
  }
  return { pts, off, crosses };
}

function ringScreen(P, ring, { densify, limbStep }) {
  const ll = densifyLL(ring, densify);
  const rl = ll.map(([lon, lat]) => P.rot.fwd(lon * D2R, lat * D2R));
  if (P.sphere) {
    // 让起点落在可见点上，环才能按"可见段 + 地平线弧"重新闭合
    const vis = rl.map(([l, p]) => dmath.cos(p) * dmath.cos(l) >= 0);
    if (!vis.some(Boolean)) return { pts: [], clipped: true };
    if (vis.every(Boolean)) return { pts: rl.map(([l, p]) => P.projectRotated(l, p)), clipped: false };
    const closed = rl.length > 1 && rl[0][0] === rl[rl.length - 1][0] && rl[0][1] === rl[rl.length - 1][1];
    const base = closed ? rl.slice(0, -1) : rl, bv = closed ? vis.slice(0, -1) : vis;
    const s = bv.indexOf(true);
    const rot = [...base.slice(s), ...base.slice(0, s), base[s]];
    const runs = sphereRuns(P, rot);
    const pts = [];
    runs.forEach((r, i) => {
      pts.push(...r.pts);
      const nx = runs[(i + 1) % runs.length];
      if (r.endCut !== null && nx.startCut !== null) pts.push(...limbArc(P, r.endCut, nx.startCut, limbStep));
    });
    return { pts, clipped: true };
  }
  if (P.cylindrical) {
    const { pts: out, off, crosses } = unwrapCyl(P, rl);
    // 绕极点的环（南极洲那类）：展开后首尾差一个周期，沿极纬补边闭合
    if (off !== 0 && rl.length > 2) {
      const pole = rl.reduce((s, [, p]) => s + p, 0) < 0 ? -1 : 1;
      const lat = pole * (P.raw.clipLat ?? 90) * D2R;
      out.push(P.projectRotated(rl[rl.length - 1][0] + off, lat), P.projectRotated(rl[0][0], lat));
    }
    return { pts: out, clipped: false, crosses };
  }
  return { pts: rl.map(([l, p]) => P.projectRotated(l, p)), clipped: false };
}

/**
 * 经纬度点列 → 屏幕折线段（球面投影按地平线切成多段；圆柱投影跨 ±180° 时展开不折回）。
 * projectLine(P, [[lon,lat],…], { densify }) → { parts: [[[x,y],…], …], crosses }
 */
export function projectLine(P, coords, { densify = 0 } = {}) {
  const ll = densifyLL(coords, densify);
  const rl = ll.map(([lon, lat]) => P.rot.fwd(lon * D2R, lat * D2R));
  if (P.sphere) return { parts: sphereRuns(P, rl).map((r) => r.pts).filter((p) => p.length), crosses: false };
  if (P.cylindrical) { const u = unwrapCyl(P, rl); return { parts: [u.pts], crosses: u.crosses }; }
  return { parts: [rl.map(([l, p]) => P.projectRotated(l, p))], crosses: false };
}

function geometries(g, feature, out) {
  if (!g) return;
  if (g.type === 'FeatureCollection') { g.features.forEach((f) => geometries(f, f, out)); return; }
  if (g.type === 'Feature') { geometries(g.geometry, g, out); return; }
  if (g.type === 'GeometryCollection') { g.geometries.forEach((x) => geometries(x, feature, out)); return; }
  out.push({ geom: g, feature });
}

/**
 * GeoJSON → 屏幕形状：geoShapes(P, geojson, { densify, limbStep }) → [{ type, rings | parts | points, feature, clipped, crosses }]
 *   type 'polygon'：rings = [[[x,y],…], …]（第一个是外环，其余是洞；填充用 evenodd）
 *   type 'line'   ：parts = 折线段
 *   type 'point'  ：points = [[x,y] | null, …]（背面为 null）
 *   densify   每条边按大圆细分到不超过这么多度（0 = 不细分：边在球面/圆锥上会变成弦）
 *   limbStep  球面裁剪时沿地平线补弧的步长（弧度，默认 π/90）
 * 支持 FeatureCollection / Feature / GeometryCollection / Polygon / MultiPolygon / LineString / MultiLineString / Point / MultiPoint。
 */
export function geoShapes(P, geojson, { densify = 0, limbStep = PI / 90 } = {}) {
  const items = []; geometries(geojson, null, items);
  const out = [];
  for (const { geom: g, feature } of items) {
    const props = { feature, properties: feature?.properties ?? null };
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
        const rs = poly.map((ring) => ringScreen(P, ring, { densify, limbStep }));
        const rings = rs.map((r) => r.pts).filter((r) => r.length > 2);
        if (rings.length) out.push({ type: 'polygon', rings, clipped: rs.some((r) => r.clipped), crosses: rs.some((r) => r.crosses), ...props });
      }
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
        const r = projectLine(P, line, { densify });
        if (r.parts.length) out.push({ type: 'line', parts: r.parts, crosses: r.crosses, ...props });
      }
    } else if (g.type === 'Point' || g.type === 'MultiPoint') {
      out.push({ type: 'point', points: (g.type === 'Point' ? [g.coordinates] : g.coordinates).map((c) => P.project(c)), ...props });
    } else throw new Error(`chart.js：geoShapes 不认识几何类型 ${g.type}`);
  }
  return out;
}

/** 让 geojson 的投影外框装进 rect = [x, y, w, h]（保持比例、居中），返回新投影。 */
export function fit(P, geojson, rect, { densify = 0 } = {}) {
  const [x, y, w, h] = Array.isArray(rect) ? rect : [rect.x, rect.y, rect.w, rect.h];
  need([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0, 'fit 的 rect 要是 [x, y, w, h]');
  const P1 = P.with({ scale: 1, translate: [0, 0] });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const eat = ([px, py]) => { if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; };
  for (const s of geoShapes(P1, geojson, { densify })) {
    if (s.type === 'polygon') s.rings.forEach((r) => r.forEach(eat));
    else if (s.type === 'line') s.parts.forEach((r) => r.forEach(eat));
    else s.points.forEach((p) => p && eat(p));
  }
  need(x1 >= x0, 'fit：geojson 投影后没有可见的点');
  const bw = x1 - x0, bh = y1 - y0;
  const k = bw === 0 && bh === 0 ? 1 : Math.min(bw ? w / bw : Infinity, bh ? h / bh : Infinity);
  return P.with({ scale: k, translate: [x + w / 2 - k * (x0 + x1) / 2, y + h / 2 - k * (y0 + y1) / 2] });
}

/**
 * 大圆航线：greatCircle([lon,lat], [lon,lat]) → { distance（弧度）, at(p) → [lon,lat], points(n, upto=1) → [[lon,lat],…] }
 * 路线动画：pts = gc.points(64, progress) → projectLine(P, pts).parts，末端 = pts 最后一点（P.project 它跟标签）。
 */
export function greatCircle(a, b) {
  const x0 = a[0] * D2R, y0 = a[1] * D2R, x1 = b[0] * D2R, y1 = b[1] * D2R;
  const cy0 = dmath.cos(y0), sy0 = dmath.sin(y0), cy1 = dmath.cos(y1), sy1 = dmath.sin(y1);
  const kx0 = cy0 * dmath.cos(x0), ky0 = cy0 * dmath.sin(x0), kx1 = cy1 * dmath.cos(x1), ky1 = cy1 * dmath.sin(x1);
  const hav = (x) => { const s = dmath.sin(x / 2); return s * s; };
  const d = 2 * asinC(Math.sqrt(hav(y1 - y0) + cy0 * cy1 * hav(x1 - x0)));
  const sd = dmath.sin(d);
  const at = (p) => {
    if (d < 1e-12) return [a[0], a[1]];
    const t = sat(p) * d, B = dmath.sin(t) / sd, A = dmath.sin(d - t) / sd;
    const x = A * kx0 + B * kx1, y = A * ky0 + B * ky1, z = A * sy0 + B * sy1;
    return [dmath.atan2(y, x) * R2D, dmath.atan2(z, Math.sqrt(x * x + y * y)) * R2D];
  };
  return {
    distance: d, at,
    points(n, upto = 1) {
      need(Number.isInteger(n) && n >= 1, 'greatCircle.points 要给段数 n（整数 ≥ 1）');
      const u = sat(upto), m = Math.max(1, Math.ceil(n * u)), out = [];
      for (let i = 0; i <= m; i++) out.push(at((u * i) / m));
      return out;
    },
  };
}

// ===========================================================================
// 6. 关系图
// ===========================================================================
/**
 * 力导向布局（加载期跑完，seek 里只查表）：
 * forceLayout(nodes, links, { seed, iterations, distance, charge, center, linkStrength, collide, velocityDecay, alphaMin, record })
 *   nodes  [{ id, x?, y?, fx?, fy? }]（给了 x/y 就从那里出发；fx/fy 钉住）
 *   links  [{ source: id, target: id, distance?, strength? }]
 *   seed   初始布局的种子（rand.js seeded）；iterations 迭代步数（alpha 从 1 衰减到 alphaMin 恰好用完）
 *   distance 连线静长；charge 斥力强度（负数 = 互斥，同 d3 manyBody.strength）
 *   center [x, y] 每步把质心拉回这里（默认 [0,0]）；collide 节点半径（0 = 不做碰撞）
 *   record 每隔几步存一次全体坐标（0 = 不存）：R.at(k) 按**迭代步**插值，用来做"布局展开"
 * → { nodes: [{ id, x, y }], position(id), frames, at(k), iterations, movement（最后一步平均位移）, pairOps }
 * 斥力是 O(n²) 精确求和（没有 Barnes–Hut 近似）：耗时见 dataviz.md。
 */
export function forceLayout(nodes, links, opts = {}) {
  const { seed, iterations, distance, charge, center = [0, 0], linkStrength = null, collide = 0,
    velocityDecay = 0.4, alphaMin = 0.001, record = 0 } = opts;
  need(Number.isInteger(seed), 'forceLayout 要给整数 seed');
  need(Number.isInteger(iterations) && iterations >= 1, 'forceLayout 要给 iterations（整数 ≥ 1）');
  need(distance > 0 && Number.isFinite(charge), 'forceLayout 要给 distance（> 0）与 charge（负数 = 互斥）');
  const n = nodes.length, idx = new Map();
  nodes.forEach((nd, i) => { need(nd.id !== undefined && !idx.has(nd.id), `forceLayout：节点 id 缺失或重复（第 ${i} 个）`); idx.set(nd.id, i); });
  const L = links.map((l, i) => {
    const s = idx.get(l.source), t = idx.get(l.target);
    need(s !== undefined && t !== undefined, `forceLayout：第 ${i} 条连线的端点 ${l.source}→${l.target} 不在 nodes 里`);
    return { s, t, d: l.distance ?? distance, k: l.strength };
  });
  const deg = new Int32Array(n); for (const l of L) { deg[l.s]++; deg[l.t]++; }
  for (const l of L) { l.b = deg[l.s] / (deg[l.s] + deg[l.t]); if (l.k === undefined) l.k = linkStrength ?? 1 / Math.min(deg[l.s], deg[l.t]); }
  const rnd = seeded(seed);
  const jiggle = () => (rnd() - 0.5) * 1e-6;
  const X = new Float64Array(n), Y = new Float64Array(n), VX = new Float64Array(n), VY = new Float64Array(n);
  const FX = nodes.map((nd) => (Number.isFinite(nd.fx) ? nd.fx : null)), FY = nodes.map((nd) => (Number.isFinite(nd.fy) ? nd.fy : null));
  const a0 = rnd() * TAU, golden = PI * (3 - Math.sqrt(5));
  nodes.forEach((nd, i) => {
    if (Number.isFinite(nd.x) && Number.isFinite(nd.y)) { X[i] = nd.x; Y[i] = nd.y; return; }
    const r = distance * 0.35 * Math.sqrt(0.5 + i), a = a0 + i * golden;    // 叶序螺旋，种子只转起始角
    X[i] = center[0] + r * dmath.cos(a); Y[i] = center[1] + r * dmath.sin(a);
  });
  for (let i = 0; i < n; i++) { if (FX[i] !== null) X[i] = FX[i]; if (FY[i] !== null) Y[i] = FY[i]; }
  const snap = () => { const f = new Float64Array(2 * n); for (let i = 0; i < n; i++) { f[2 * i] = X[i]; f[2 * i + 1] = Y[i]; } return f; };
  const frames = record > 0 ? [snap()] : null, frameStep = [];
  if (frames) frameStep.push(0);
  let alpha = 1; const decay = 1 - dmath.pow(alphaMin, 1 / iterations);
  let movement = 0;
  for (let it = 1; it <= iterations; it++) {
    alpha += (0 - alpha) * decay;
    for (const l of L) {   // 连线弹簧
      let dx = X[l.t] + VX[l.t] - X[l.s] - VX[l.s] || jiggle(), dy = Y[l.t] + VY[l.t] - Y[l.s] - VY[l.s] || jiggle();
      let d = Math.sqrt(dx * dx + dy * dy); d = ((d - l.d) / d) * alpha * l.k; dx *= d; dy *= d;
      VX[l.t] -= dx * l.b; VY[l.t] -= dy * l.b; VX[l.s] += dx * (1 - l.b); VY[l.s] += dy * (1 - l.b);
    }
    if (charge !== 0) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {   // 斥力（精确两两）
      let dx = X[j] - X[i], dy = Y[j] - Y[i];
      if (dx === 0) dx = jiggle(); if (dy === 0) dy = jiggle();
      let l2 = dx * dx + dy * dy; if (l2 < 1) l2 = Math.sqrt(l2);
      const w = (charge * alpha) / l2;
      VX[i] += dx * w; VY[i] += dy * w; VX[j] -= dx * w; VY[j] -= dy * w;
    }
    if (collide > 0) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = X[j] + VX[j] - X[i] - VX[i], dy = Y[j] + VY[j] - Y[i] - VY[i], d2 = dx * dx + dy * dy, r = 2 * collide;
      if (d2 < r * r && d2 > 0) { const d = Math.sqrt(d2), m = ((r - d) / d) * 0.5 * 0.7; VX[i] -= dx * m; VY[i] -= dy * m; VX[j] += dx * m; VY[j] += dy * m; }
    }
    let cx = 0, cy = 0; for (let i = 0; i < n; i++) { cx += X[i]; cy += Y[i]; }
    if (n) { cx = cx / n - center[0]; cy = cy / n - center[1]; for (let i = 0; i < n; i++) { X[i] -= cx; Y[i] -= cy; } }
    movement = 0;
    for (let i = 0; i < n; i++) {
      VX[i] *= 1 - velocityDecay; VY[i] *= 1 - velocityDecay;
      if (FX[i] !== null) { X[i] = FX[i]; VX[i] = 0; } else X[i] += VX[i];
      if (FY[i] !== null) { Y[i] = FY[i]; VY[i] = 0; } else Y[i] += VY[i];
      movement += dmath.hypot(VX[i], VY[i]);
    }
    movement = n ? movement / n : 0;
    if (frames && (it % record === 0 || it === iterations)) { frames.push(snap()); frameStep.push(it); }
  }
  const out = nodes.map((nd, i) => ({ id: nd.id, x: X[i], y: Y[i] }));
  const at = (k) => {
    need(frames, 'forceLayout 没开 record，没有中间帧可插值');
    k = Math.max(0, Math.min(iterations, k));
    let a = 0, b = frameStep.length - 1; while (a < b) { const m = (a + b + 1) >> 1; if (frameStep[m] <= k) a = m; else b = m - 1; }
    const c = Math.min(a + 1, frameStep.length - 1), span = frameStep[c] - frameStep[a], u = span ? (k - frameStep[a]) / span : 0;
    const fa = frames[a], fb = frames[c];
    return nodes.map((nd, i) => ({ id: nd.id, x: lerp(fa[2 * i], fb[2 * i], u), y: lerp(fa[2 * i + 1], fb[2 * i + 1], u) }));
  };
  return { nodes: out, position: (id) => { const i = idx.get(id); return i === undefined ? undefined : [X[i], Y[i]]; },
    frames, frameSteps: frameStep, at, iterations, movement, pairOps: iterations * (n * (n - 1)) / 2 };
}

/** 把一组点（[[x,y]…] 或 [{x,y}…]）等比缩放居中装进 rect = [x, y, w, h]：→ { k, tx, ty, map([x,y]) → [x,y] } */
export function fitPoints(points, rect) {
  const [rx, ry, rw, rh] = rect;
  const xs = points.map((p) => (Array.isArray(p) ? p[0] : p.x)), ys = points.map((p) => (Array.isArray(p) ? p[1] : p.y));
  const [x0, x1] = extent(xs), [y0, y1] = extent(ys);
  need(x0 !== undefined, 'fitPoints 要至少一个点');
  const bw = x1 - x0, bh = y1 - y0;
  const k = bw === 0 && bh === 0 ? 1 : Math.min(bw ? rw / bw : Infinity, bh ? rh / bh : Infinity);
  const tx = rx + rw / 2 - (k * (x0 + x1)) / 2, ty = ry + rh / 2 - (k * (y0 + y1)) / 2;
  return { k, tx, ty, map: (p) => (Array.isArray(p) ? [tx + k * p[0], ty + k * p[1]] : [tx + k * p.x, ty + k * p.y]) };
}
