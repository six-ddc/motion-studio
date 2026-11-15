// film-motion 运行时 · 矢量形状层（纯数学，零依赖：浏览器和 Node 都能 import）
//
//   import { pathSampler, trim, morph, along, tracePath, circle, star } from './runtime/shapes.js';
//
// 四件事，全部是参数的纯函数：
//   1. pathSampler：SVG path d（M L H V C S Q T A Z，绝对/相对）或点数组 → 按弧长参数化的折线采样器（多子路径）。
//   2. trim：描边生长（AE 的 Trim Paths）：start/end/offset 都是弧长比例，返回可以直接 stroke 的折线或 Path2D。
//   3. morph：任意两个形状之间的变形（flubber 那类方法的自实现）：按弧长重采样到同样点数、统一绕向、
//      旋转起点使总位移平方和最小、逐点插值；子路径数量不同时显式配对，多出来的从质心长出或缩回。
//   4. along：沿路径运动并自动朝向（切线，可用 lookahead 平滑拐角）。
// 外加圆、椭圆、圆角矩形、正多边形、星形的 d 字符串生成器，只为方便给 morph 起止。
//
// 约定：采样器、morph 的配对与对齐都在**加载时**建一次；seek 里只调 at / trim / m(p) / along。
// 这里没有任何颜色、线宽、线帽之类的审美值：画成什么样由调用方的 ctx 决定。代价与实测见 film-motion references/shapes.md。
//
// 数据形状：Poly = { pts: [[x, y], …], closed: boolean }；Shape = Poly[]（一个子路径一个 Poly）。
// 所有接收"路径"的函数都接受：d 字符串 | 点数组 [[x,y],…]（开放折线）| Poly | Shape | pathSampler 的返回值。

const TAU = Math.PI * 2;
const EPS = 1e-9;

// ===========================================================================
// 1. 解析 SVG path d → Shape（曲线按容差压平成折线）
// ===========================================================================
const ARGC = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(d) {
  const cmds = [];
  let i = 0, cur = null;
  const n = d.length;
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      cur = ch; i++;
      if (ARGC[ch.toUpperCase()] === 0) { cmds.push({ c: ch, a: [] }); }
      continue;
    }
    if (!cur) throw new Error(`parsePath: d 必须以命令字母开头，位置 ${i} 是「${ch}」`);
    const U = cur.toUpperCase();
    const need = ARGC[U];
    if (need === 0) throw new Error(`parsePath: ${cur} 之后不该有数字（位置 ${i}）`);
    const a = [];
    for (let k = 0; k < need; k++) {
      skip();
      if (U === 'A' && (k === 3 || k === 4)) {        // 弧的两个标志位可以不带分隔符：a1 1 0 011 1
        if (d[i] !== '0' && d[i] !== '1') throw new Error(`parsePath: 弧标志位必须是 0/1（位置 ${i}）`);
        a.push(+d[i]); i++; continue;
      }
      NUM.lastIndex = i;
      const m = NUM.exec(d);
      if (!m) throw new Error(`parsePath: ${cur} 缺参数或参数不是数字（位置 ${i}：「${d.slice(i, i + 12)}」）`);
      a.push(parseFloat(m[0])); i = NUM.lastIndex;
    }
    cmds.push({ c: cur, a });
    if (cur === 'M') cur = 'L'; else if (cur === 'm') cur = 'l';   // M 后面多出的坐标对是隐式 L
  }
  return cmds;
}

// Wang 公式：n 段折线把 d 次 Bézier 的误差压到 tol 以内
function wangN(deg, ctrl, tol) {
  let M = 0;
  for (let i = 0; i + 2 < ctrl.length; i++) {
    const dx = ctrl[i][0] - 2 * ctrl[i + 1][0] + ctrl[i + 2][0];
    const dy = ctrl[i][1] - 2 * ctrl[i + 1][1] + ctrl[i + 2][1];
    M = Math.max(M, Math.hypot(dx, dy));
  }
  const n = Math.ceil(Math.sqrt((deg * (deg - 1) / 8) * M / tol));
  return Math.min(1024, Math.max(1, n));
}

function arcPoints(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, tol, out) {
  // SVG 1.1 F.6.5：端点参数化 → 圆心参数化
  if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < EPS || ry < EPS) { out.push([x2, y2]); return; }
  const phi = (phiDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cs * dx + sn * dy, y1p = -sn * dx + cs * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2, cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= TAU; else if (fs && dth < 0) dth += TAU;
  const r = Math.max(rx, ry);
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 2;
  const n = Math.min(1024, Math.max(1, Math.ceil(Math.abs(dth) / step)));
  for (let k = 1; k <= n; k++) {
    const th = th1 + (dth * k) / n, ex = rx * Math.cos(th), ey = ry * Math.sin(th);
    out.push(k === n ? [x2, y2] : [cs * ex - sn * ey + cx, sn * ex + cs * ey + cy]);
  }
}

/**
 * parsePath(d, { tolerance }) → Shape。tolerance = 曲线压平的最大偏差（px），这是精度参数不是审美值。
 * 规则同 SVG：M 后多余的坐标对是 L；Z 之后不带 M 的绘制命令从该子路径起点开新子路径；S/T 反射上一段控制点。
 * 只有一个点的子路径被丢掉（它画不出任何东西；canvas 的 round 线帽会把它画成点，那种需求自己 arc）。
 */
export function parsePath(d, { tolerance = 0.25 } = {}) {
  if (typeof d !== 'string') throw new Error('parsePath: d 必须是字符串');
  if (!(tolerance > 0)) throw new Error('parsePath: tolerance 必须 > 0');
  const shape = [];
  let poly = null, x = 0, y = 0, sx = 0, sy = 0, lastC = null, lastQ = null;
  const begin = (px, py) => { if (poly && poly.pts.length > 1) shape.push(poly); poly = { pts: [[px, py]], closed: false }; };
  const ensure = () => { if (!poly) begin(x, y); };
  for (const { c, a } of tokenize(d)) {
    const rel = c === c.toLowerCase(), U = c.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let nc = null, nq = null;
    if (U === 'M') { x = ox + a[0]; y = oy + a[1]; sx = x; sy = y; begin(x, y); }
    else if (U === 'Z') {
      if (poly) {
        const p0 = poly.pts[0], pl = poly.pts[poly.pts.length - 1];
        if (Math.abs(p0[0] - pl[0]) < EPS && Math.abs(p0[1] - pl[1]) < EPS && poly.pts.length > 1) poly.pts.pop();
        poly.closed = true;
        if (poly.pts.length > 1) shape.push(poly);
        poly = null;
      }
      x = sx; y = sy;
    } else {
      ensure();
      const P = poly.pts;
      if (U === 'L') { x = ox + a[0]; y = oy + a[1]; P.push([x, y]); }
      else if (U === 'H') { x = ox + a[0]; P.push([x, y]); }
      else if (U === 'V') { y = oy + a[0]; P.push([x, y]); }
      else if (U === 'C' || U === 'S') {
        let c1;
        let c2, e;
        if (U === 'C') { c1 = [ox + a[0], oy + a[1]]; c2 = [ox + a[2], oy + a[3]]; e = [ox + a[4], oy + a[5]]; }
        else { c1 = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]; c2 = [ox + a[0], oy + a[1]]; e = [ox + a[2], oy + a[3]]; }
        const p0 = [x, y], n = wangN(3, [p0, c1, c2, e], tolerance);
        for (let k = 1; k <= n; k++) {
          const u = k / n, v = 1 - u;
          P.push(k === n ? [e[0], e[1]] : [
            v * v * v * p0[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0],
            v * v * v * p0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]);
        }
        nc = c2; x = e[0]; y = e[1];
      } else if (U === 'Q' || U === 'T') {
        let q, e;
        if (U === 'Q') { q = [ox + a[0], oy + a[1]]; e = [ox + a[2], oy + a[3]]; }
        else { q = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]; e = [ox + a[0], oy + a[1]]; }
        const p0 = [x, y], n = wangN(2, [p0, q, e], tolerance);
        for (let k = 1; k <= n; k++) {
          const u = k / n, v = 1 - u;
          P.push(k === n ? [e[0], e[1]] : [v * v * p0[0] + 2 * v * u * q[0] + u * u * e[0], v * v * p0[1] + 2 * v * u * q[1] + u * u * e[1]]);
        }
        nq = q; x = e[0]; y = e[1];
      } else if (U === 'A') {
        const ex = ox + a[5], ey = oy + a[6];
        arcPoints(x, y, a[0], a[1], a[2], a[3], a[4], ex, ey, tolerance, P);
        x = ex; y = ey;
      }
    }
    lastC = nc; lastQ = nq;
  }
  if (poly && poly.pts.length > 1) shape.push(poly);
  return shape.map(dedupe).filter((p) => p.pts.length > 1);
}

function dedupe(poly) {
  const out = [];
  for (const p of poly.pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > EPS || Math.abs(q[1] - p[1]) > EPS) out.push([p[0], p[1]]);
  }
  if (poly.closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) out.pop();
  }
  return { pts: out, closed: !!poly.closed && out.length > 2 };
}

/** 任意"路径"输入 → Shape（见文件头的数据形状）。 */
export function toShape(input, opts = {}) {
  if (input == null) throw new Error('toShape: 没给路径');
  if (typeof input === 'string') return parsePath(input, opts);
  if (input.shape && typeof input.at === 'function') return input.shape;
  if (Array.isArray(input)) {
    if (!input.length) return [];
    if (Array.isArray(input[0]) && typeof input[0][0] === 'number') return [dedupe({ pts: input, closed: !!opts.closed })].filter((p) => p.pts.length > 1);
    return input.map((p) => dedupe(p)).filter((p) => p.pts.length > 1);
  }
  if (Array.isArray(input.pts)) return [dedupe(input)].filter((p) => p.pts.length > 1);
  throw new Error('toShape: 路径要么是 d 字符串、点数组、{pts, closed}、它们的数组，要么是 pathSampler 的返回值');
}

// ===========================================================================
// 2. 弧长表与采样器
// ===========================================================================
function ring(poly) {
  const P = poly.closed ? [...poly.pts, poly.pts[0]] : poly.pts;
  const n = P.length, xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = P[i][0]; ys[i] = P[i][1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  return { xs, ys, cum, n, length: cum[n - 1], closed: poly.closed, poly };
}
function segAt(R, s) {           // 最后一个 cum[i] ≤ s 的段号 i（0..n-2）
  let lo = 0, hi = R.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.cum[m] <= s) lo = m; else hi = m; }
  return lo;
}
function pointOn(R, s) {
  if (R.n < 2) return { x: R.xs[0] ?? 0, y: R.ys[0] ?? 0, angle: 0 };
  const sc = Math.max(0, Math.min(R.length, s));
  const i = segAt(R, sc);
  const L = R.cum[i + 1] - R.cum[i];
  const q = L > 0 ? (sc - R.cum[i]) / L : 0;
  const dx = R.xs[i + 1] - R.xs[i], dy = R.ys[i + 1] - R.ys[i];
  return { x: R.xs[i] + dx * q, y: R.ys[i] + dy * q, angle: Math.atan2(dy, dx) };
}
function extract(R, s0, s1) {    // 0 ≤ s0 ≤ s1 ≤ length → 点数组（端点插值，中间保留原顶点）
  const a = pointOn(R, s0), b = pointOn(R, s1);
  const out = [[a.x, a.y]];
  const i0 = segAt(R, s0), i1 = segAt(R, s1);
  for (let i = i0 + 1; i <= i1; i++) if (R.cum[i] > s0 + EPS && R.cum[i] < s1 - EPS) out.push([R.xs[i], R.ys[i]]);
  out.push([b.x, b.y]);
  return out;
}

// 只按值缓存 d 字符串（不可变）。数组/对象不缓存：调用方改了数组内容，按引用缓存的采样器就过期了，结果会依赖求值顺序。
const CACHE_S = new Map();
/**
 * pathSampler(path, { tolerance }) → { length, shape, subpaths:[{start, length, closed}], at(s), slice(a, b, {as}) }
 *   at(s)        s = 沿全部子路径累计的弧长（px，子路径之间的空跳不计长度），越界夹到两端 → { x, y, angle }（angle = 所在段的切线方向，弧度）
 *   slice(a, b)  弧长 [a, b] 这一截 → Shape（跨子路径时是几段开放折线）；{ as: 'path2d' } 返回 Path2D（只在浏览器里有）
 * 可以直接交给 film-typography 的 drawOnPath（它只用 length 和 at）。加载时建一次，seek 里只查。
 */
export function pathSampler(path, opts = {}) {
  if (path && path.shape && typeof path.at === 'function') return path;
  const key = typeof path === 'string' ? `${opts.tolerance ?? ''}|${path}` : null;
  if (key && CACHE_S.has(key)) return CACHE_S.get(key);
  const shape = toShape(path, opts);
  const rings = shape.map(ring);
  const subpaths = [];
  let acc = 0;
  for (const R of rings) { subpaths.push({ start: acc, length: R.length, closed: R.closed }); R.start = acc; acc += R.length; }
  const length = acc;
  const locate = (s) => {
    const sc = Math.max(0, Math.min(length, s));
    for (let k = 0; k < rings.length; k++) if (sc < rings[k].start + rings[k].length || k === rings.length - 1) return [rings[k], sc - rings[k].start];
    return [null, 0];
  };
  const S = {
    length, shape, subpaths, rings,
    at(s) { const [R, ls] = locate(s); return R ? pointOn(R, ls) : { x: 0, y: 0, angle: 0 }; },
    slice(a, b, { as = 'points' } = {}) {
      const lo = Math.max(0, Math.min(a, b)), hi = Math.min(length, Math.max(a, b));
      const out = [];
      for (const R of rings) {
        const s0 = Math.max(lo, R.start), s1 = Math.min(hi, R.start + R.length);
        if (s1 - s0 > EPS) out.push({ pts: extract(R, s0 - R.start, s1 - R.start), closed: false });
      }
      return as === 'path2d' ? toPath2D(out) : out;
    },
  };
  if (key) { if (CACHE_S.size > 64) CACHE_S.delete(CACHE_S.keys().next().value); CACHE_S.set(key, S); }
  return S;
}

// ===========================================================================
// 3. 画出来：tracePath / toPath2D（不 beginPath、不 stroke：样式全归调用方）
// ===========================================================================
/** 把 Shape 追加进 ctx 的当前路径。调用方自己 beginPath()、设样式、fill()/stroke()。任何有 moveTo/lineTo/closePath 的对象都行。 */
export function tracePath(ctx, shape) {
  for (const p of shape) {
    if (!p.pts.length) continue;
    ctx.moveTo(p.pts[0][0], p.pts[0][1]);
    for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i][0], p.pts[i][1]);
    if (p.closed) ctx.closePath();
  }
  return ctx;
}
/** Shape → Path2D（浏览器）。Node 里没有 Path2D，会抛错——Node 里用点数组。 */
export function toPath2D(shape) {
  if (typeof Path2D !== 'function') throw new Error('toPath2D: 这个环境没有 Path2D（Node 里请用点数组，或 tracePath 到自己的 ctx）');
  return tracePath(new Path2D(), shape);
}

// ===========================================================================
// 4. 描边生长 trim
// ===========================================================================
const frac = (x) => x - Math.floor(x);
function trimRanges(start, end, offset) {
  const lo = Math.min(start, end), span = Math.min(1, Math.abs(end - start));
  if (span <= EPS) return [];
  if (span >= 1 - EPS) return null;               // 全长
  const a = frac(lo + offset), b = a + span;
  return b <= 1 + EPS ? [[a, Math.min(1, b)]] : [[a, 1], [0, b - 1]];
}
function trimRing(R, ranges) {
  if (ranges === null) return [{ pts: R.poly.pts.map((p) => [p[0], p[1]]), closed: R.closed }];
  const pieces = ranges.map(([a, b]) => extract(R, a * R.length, b * R.length));
  if (pieces.length === 2 && R.closed) {          // 闭合路径绕过起点：接成一条，起点处不留线帽缝
    return [{ pts: [...pieces[0], ...pieces[1].slice(1)], closed: false }];
  }
  return pieces.map((pts) => ({ pts, closed: false }));
}
/**
 * trim(path, start, end, offset = 0, { each, as }) → Shape | Path2D
 *   start / end   弧长比例 [0,1]（AE Trim Paths 的 Start/End）。0→1 生长：trim(p, 0, k)；两端同时收：trim(p, k/2, 1 - k/2)
 *   offset        比例，整体平移并在 1 处绕回（循环跑动的光段：trim(p, 0, 0.2, t * 速度)）。闭合路径绕过起点时接成一条线
 *   each          false（默认）= 全部子路径首尾相接当成一条长路径算比例（AE "Simultaneously"）；true = 每个子路径各自按同样的比例裁（"Individually"）
 *   as            'points'（默认，Node 也能用）| 'path2d'
 * start = end 时返回空数组（什么都不画）；|end - start| ≥ 1 时返回整条路径（闭合的保持闭合）。
 */
export function trim(path, start, end, offset = 0, { each = false, as = 'points' } = {}) {
  if (![start, end, offset].every(Number.isFinite)) throw new Error('trim: start / end / offset 必须是有限数');
  const S = pathSampler(path);
  const ranges = trimRanges(start, end, offset);
  let out = [];
  if (each || S.rings.length === 1) {
    for (const R of S.rings) if (R.length > 0) out.push(...trimRing(R, ranges));
  } else if (ranges === null) {
    out = S.rings.map((R) => ({ pts: R.poly.pts.map((p) => [p[0], p[1]]), closed: R.closed }));
  } else {
    for (const [a, b] of ranges) out.push(...S.slice(a * S.length, b * S.length));
  }
  return as === 'path2d' ? toPath2D(out) : out;
}

// ===========================================================================
// 5. 沿路径运动 along
// ===========================================================================
/**
 * along(path, p, { orient, lookahead, wrap }) → { x, y, angle }
 *   p          弧长比例。只有一个闭合子路径时默认绕回（p = 1.25 等于 0.25，适合循环）；否则夹在 [0,1]
 *   orient     true（默认）= angle 取切线方向；false = angle 恒为 0；数字 = 切线方向再加这么多弧度（素材画的是朝上/朝左时用）
 *   lookahead  px。> 0 时朝向取 [s - lookahead/2, s + lookahead/2] 两点连线的方向：折线拐角处朝向不再突跳，代价是在急弯里"切内道"
 *   wrap       显式指定是否绕回
 * path 传 d 字符串时按值缓存采样器；传数组时每次调用都重建弧长表。最省的写法是加载时建好 pathSampler 再传进来。
 */
export function along(path, p, { orient = true, lookahead = 0, wrap } = {}) {
  const S = pathSampler(path);
  const L = S.length;
  const loop = wrap ?? (S.rings.length === 1 && S.rings[0].closed);
  const pos = (s) => (loop ? ((s % L) + L) % L : Math.max(0, Math.min(L, s)));
  const s = pos(p * L);
  const q = S.at(s);
  let angle = q.angle;
  if (orient === false) angle = 0;
  else {
    if (lookahead > 0) {
      const h = lookahead / 2;
      let a = S.at(pos(p * L - h)), b = S.at(pos(p * L + h));
      if (Math.hypot(b.x - a.x, b.y - a.y) < EPS) { a = q; b = S.at(pos(p * L + lookahead)); }
      if (Math.hypot(b.x - a.x, b.y - a.y) > EPS) angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
    if (typeof orient === 'number') angle += orient;
  }
  return { x: q.x, y: q.y, angle };
}

// ===========================================================================
// 6. 变形 morph
// ===========================================================================
/** 闭合多边形的有向面积（屏幕坐标 y 向下时，正 = 顺时针）。开放折线返回 0。 */
export function signedArea(poly) {
  if (!poly.closed) return 0;
  let s = 0;
  const P = poly.pts;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) s += P[j][0] * P[i][1] - P[i][0] * P[j][1];
  return s / 2;
}

const CORNER = 0.26;   // 约 15°：转角大于它的顶点优先占一个采样点，直线多边形的角不会被削掉
function resample(R, N) {
  const closed = R.closed, L = R.length;
  const pos = new Float64Array(N);
  for (let k = 0; k < N; k++) pos[k] = closed ? (k * L) / N : (N > 1 ? (k * L) / (N - 1) : 0);
  if (L > 0) {
    // 角点吸附：按转角从大到小，各自占最近的采样点；采样点只移动不超过半个步长，所以顺序不乱
    const cand = [];
    const last = R.n - 1;
    for (let i = closed ? 0 : 1; i < (closed ? last : last); i++) {
      const ip = i === 0 ? last - 1 : i - 1, inx = i + 1;
      const a1 = Math.atan2(R.ys[i] - R.ys[ip], R.xs[i] - R.xs[ip]);
      const a2 = Math.atan2(R.ys[inx] - R.ys[i], R.xs[inx] - R.xs[i]);
      let d = Math.abs(a2 - a1); if (d > Math.PI) d = TAU - d;
      if (d > CORNER) cand.push([d, R.cum[i]]);
    }
    cand.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    const step = closed ? L / N : L / Math.max(1, N - 1);
    const taken = new Uint8Array(N);
    if (!closed) { taken[0] = 1; taken[N - 1] = 1; }
    for (const [, s] of cand) {
      let k = Math.round(s / step);
      if (closed) k = ((k % N) + N) % N; else k = Math.max(0, Math.min(N - 1, k));
      if (taken[k] || (closed && k === 0 && s > L / 2)) continue;   // 落在终点附近的角绕回 0 号点会打乱顺序，让给别的点
      taken[k] = 1; pos[k] = s;
    }
  }
  const out = new Float64Array(N * 2);
  for (let k = 0; k < N; k++) { const q = pointOn(R, pos[k]); out[2 * k] = q.x; out[2 * k + 1] = q.y; }
  return out;
}
const reverseRing = (A, N) => { const o = new Float64Array(N * 2); for (let k = 0; k < N; k++) { const j = (N - k) % N; o[2 * k] = A[2 * j]; o[2 * k + 1] = A[2 * j + 1]; } return o; };
const reverseOpen = (A, N) => { const o = new Float64Array(N * 2); for (let k = 0; k < N; k++) { const j = N - 1 - k; o[2 * k] = A[2 * j]; o[2 * k + 1] = A[2 * j + 1]; } return o; };
function costAt(A, B, N, k) {
  let c = 0;
  for (let i = 0; i < N; i++) { const j = (i + k) % N, dx = A[2 * i] - B[2 * j], dy = A[2 * i + 1] - B[2 * j + 1]; c += dx * dx + dy * dy; }
  return c;
}
const rotate = (B, N, k) => { const o = new Float64Array(N * 2); for (let i = 0; i < N; i++) { const j = (i + k) % N; o[2 * i] = B[2 * j]; o[2 * i + 1] = B[2 * j + 1]; } return o; };
const meanOf = (A, N) => { let x = 0, y = 0; for (let i = 0; i < N; i++) { x += A[2 * i]; y += A[2 * i + 1]; } return [x / N, y / N]; };

function info(poly) {
  const R = ring(poly);
  const area = signedArea(poly);
  let cx = 0, cy = 0;
  if (poly.closed && Math.abs(area) > EPS) {
    const P = poly.pts;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const f = P[j][0] * P[i][1] - P[i][0] * P[j][1]; cx += (P[j][0] + P[i][0]) * f; cy += (P[j][1] + P[i][1]) * f; }
    cx /= 6 * area; cy /= 6 * area;
  } else {
    for (let i = 1; i < R.n; i++) { const w = R.cum[i] - R.cum[i - 1]; cx += ((R.xs[i] + R.xs[i - 1]) / 2) * w; cy += ((R.ys[i] + R.ys[i - 1]) / 2) * w; }
    cx /= R.length || 1; cy /= R.length || 1;
  }
  return { R, area, c: [cx, cy] };
}

/**
 * morph(a, b, { samples, align, winding, pair, orphans, tolerance }) → m(p, { as }) → Shape | Path2D
 *
 *   samples   每对子路径的采样点数。不给 = 按较长那条的弧长每 4px 一个，夹在 [32, 1000]。数字越大越贴原形，代价见 shapes.md 实测
 *   align     'rotate'（默认）= 旋转 b 的起点，使逐点位移平方和最小（开放路径改为比较正向与反向）；'none' = 保留两边各自的起点（形状会"拧"过去）；
 *             整数 = 手工指定起点偏移（采样点个数）
 *   winding   'match'（默认）= 绕向相反时把 b 反过来（不反的话中间态会翻折穿过自身）；'keep' = 不动
 *   pair      子路径配对。'auto'（默认）= 按质心距离²+面积平方根差²贪心配对，孔洞只和孔洞配；'order' = 按下标；[[i, j], …] = 手工指定
 *   orphans   子路径数量不同时**必须给**：'self' = 没配上的就地缩到自己的质心 / 从自己的质心长出来；
 *             'nearest' = 缩进 / 长自对面离它最近的那个子路径的质心（读作"合并 / 分裂"）
 *
 * m(p)：p ≤ 0 返回 a 原样（压平后），p ≥ 1 返回 b 原样，中间逐点线性插值（缓动由调用方先套：m(ease(q))）。
 * 返回的数组是新建的（p 在端点时返回内部数组的拷贝），可以随意改。
 * m.pairs：[{ a, b, samples, offset, reversed, cost }]，a/b 是下标（null = 孤儿），cost = 平均每点位移²，用来判断配对合不合理。
 */
export function morph(a, b, { samples, align = 'rotate', winding = 'match', pair = 'auto', orphans, tolerance } = {}) {
  const popts = tolerance ? { tolerance } : {};
  const A = toShape(a, popts), B = toShape(b, popts);
  if (!A.length || !B.length) throw new Error('morph: 两边都必须至少有一条非空路径');
  const IA = A.map(info), IB = B.map(info);
  if (A.length !== B.length && orphans !== 'self' && orphans !== 'nearest')
    throw new Error(`morph: a 有 ${A.length} 个子路径、b 有 ${B.length} 个，必须给 orphans:'self'|'nearest' 说明多出来的怎么长出/缩回（代价见 shapes.md）`);

  // --- 配对 ---
  let pairs;
  if (Array.isArray(pair)) pairs = pair.map(([i, j]) => [i, j]);
  else if (pair === 'order') pairs = Array.from({ length: Math.min(A.length, B.length) }, (_, i) => [i, i]);
  else if (pair === 'auto') {
    const big = (I) => I.reduce((m, x) => (Math.abs(x.area) > Math.abs(m.area) ? x : m), I[0]);
    const sa = Math.sign(big(IA).area), sb = Math.sign(big(IB).area);
    const hole = (x, s) => x.R.closed && s !== 0 && Math.sign(x.area) === -s;
    const cand = [];
    IA.forEach((x, i) => IB.forEach((y, j) => {
      const d = (x.c[0] - y.c[0]) ** 2 + (x.c[1] - y.c[1]) ** 2 + (Math.sqrt(Math.abs(x.area)) - Math.sqrt(Math.abs(y.area))) ** 2;
      cand.push([d + (hole(x, sa) !== hole(y, sb) ? 1e15 : 0), i, j]);
    }));
    cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const ua = new Set(), ub = new Set();
    pairs = [];
    for (const [, i, j] of cand) if (!ua.has(i) && !ub.has(j)) { ua.add(i); ub.add(j); pairs.push([i, j]); }
    pairs.sort((p, q) => p[0] - q[0]);
  } else throw new Error(`morph: pair 只能是 'auto' | 'order' | [[i, j], …]，收到 ${pair}`);
  const ua = new Set(pairs.map((p) => p[0])), ub = new Set(pairs.map((p) => p[1]));
  for (const [i, j] of pairs) if (!A[i] || !B[j]) throw new Error(`morph: 配对 [${i}, ${j}] 越界`);
  if (ua.size !== pairs.length || ub.size !== pairs.length) throw new Error('morph: 配对里同一个子路径出现了两次');

  const nFor = (La, Lb) => samples ?? Math.max(32, Math.min(1000, Math.ceil(Math.max(La, Lb) / 4)));
  const tracks = [], meta = [];
  for (const [i, j] of pairs) {
    const ra = IA[i].R, rb = IB[j].R;
    const N = nFor(ra.length, rb.length);
    let closed = ra.closed && rb.closed;
    let SA, SB, offset = 0, reversed = false;
    if (closed) {
      SA = resample(ra, N); SB = resample(rb, N);
      if (winding === 'match' && Math.sign(IA[i].area) * Math.sign(IB[j].area) < 0) { SB = reverseRing(SB, N); reversed = true; }
      if (Number.isInteger(align)) offset = ((align % N) + N) % N;
      else if (align === 'rotate') { let best = Infinity; for (let k = 0; k < N; k++) { const c = costAt(SA, SB, N, k); if (c < best - 1e-9) { best = c; offset = k; } } }
      else if (align !== 'none') throw new Error(`morph: align 只能是 'rotate' | 'none' | 整数`);
      SB = rotate(SB, N, offset);
    } else {
      // 至少一边开放：两边都当开放折线（闭合的一边在最佳起点处剪开，首尾各占一个点）
      const openOf = (R, I, other) => {
        if (!R.closed) return resample(R, N);
        const ringPts = resample(R, N - 1), M = N - 1;
        let k0 = 0;
        if (other) { let best = Infinity; for (let k = 0; k < M; k++) { let c = 0; for (let q = 0; q < M; q++) { const j2 = (q + k) % M; c += (ringPts[2 * j2] - other[2 * q]) ** 2 + (ringPts[2 * j2 + 1] - other[2 * q + 1]) ** 2; } if (c < best) { best = c; k0 = k; } } }
        const o = new Float64Array(N * 2);
        for (let q = 0; q < N; q++) { const j2 = (q + k0) % M; o[2 * q] = ringPts[2 * j2]; o[2 * q + 1] = ringPts[2 * j2 + 1]; }
        return o;
      };
      if (!ra.closed) { SA = openOf(ra); SB = openOf(rb, IB[j], SA); }
      else { SB = openOf(rb); SA = openOf(ra, IA[i], SB); }
      if (align === 'rotate') {
        const R2 = reverseOpen(SB, N);
        if (costAt(SA, R2, N, 0) < costAt(SA, SB, N, 0) - 1e-9) { SB = R2; reversed = true; }
      }
      closed = false;
    }
    tracks.push({ SA, SB, N, closed });
    meta.push({ a: i, b: j, samples: N, offset, reversed, cost: costAt(SA, SB, N, 0) / N });
  }
  // --- 孤儿：缩到 / 长自一个点（线性插值到同一点 = 绕这个点均匀缩放） ---
  const orphanTo = (I, other, otherUsed) => {
    if (orphans === 'self') return I.c;
    let best = null, bd = Infinity;
    other.forEach((y, k) => { if (!otherUsed.has(k) && pairs.length) return; const d = (y.c[0] - I.c[0]) ** 2 + (y.c[1] - I.c[1]) ** 2; if (d < bd) { bd = d; best = y.c; } });
    return best ?? I.c;
  };
  IA.forEach((x, i) => {
    if (ua.has(i)) return;
    const N = nFor(x.R.length, 0), S = resample(x.R, N), [px, py] = orphanTo(x, IB, ub);
    const P = new Float64Array(N * 2); for (let k = 0; k < N; k++) { P[2 * k] = px; P[2 * k + 1] = py; }
    tracks.push({ SA: S, SB: P, N, closed: x.R.closed });
    meta.push({ a: i, b: null, samples: N, offset: 0, reversed: false, cost: costAt(S, P, N, 0) / N });
  });
  IB.forEach((y, j) => {
    if (ub.has(j)) return;
    const N = nFor(y.R.length, 0), S = resample(y.R, N), [px, py] = orphanTo(y, IA, ua);
    const P = new Float64Array(N * 2); for (let k = 0; k < N; k++) { P[2 * k] = px; P[2 * k + 1] = py; }
    tracks.push({ SA: P, SB: S, N, closed: y.R.closed });
    meta.push({ a: null, b: j, samples: N, offset: 0, reversed: false, cost: costAt(S, P, N, 0) / N });
  });

  const copy = (shape) => shape.map((p) => ({ pts: p.pts.map((q) => [q[0], q[1]]), closed: p.closed }));
  const m = (p, { as = 'points' } = {}) => {
    if (!Number.isFinite(p)) throw new Error(`morph: p 必须是有限数，收到 ${p}`);
    let out;
    if (p <= 0) out = copy(A);
    else if (p >= 1) out = copy(B);
    else {
      out = tracks.map(({ SA, SB, N, closed }) => {
        const pts = new Array(N);
        for (let k = 0; k < N; k++) pts[k] = [SA[2 * k] + (SB[2 * k] - SA[2 * k]) * p, SA[2 * k + 1] + (SB[2 * k + 1] - SA[2 * k + 1]) * p];
        return { pts, closed };
      });
    }
    return as === 'path2d' ? toPath2D(out) : out;
  };
  m.pairs = meta;
  m.a = A; m.b = B;
  return m;
}

// ===========================================================================
// 7. 诊断：自交计数（morph 中间态有没有翻折/打结）
// ===========================================================================
/** 每个子路径内部"不相邻的两段真相交"的次数之和。O(点数²)，给测试和调参用，别放进 seek。 */
export function selfCrossings(shape) {
  let total = 0;
  for (const p of toShape(shape)) {
    const P = p.closed ? [...p.pts, p.pts[0]] : p.pts, n = P.length - 1;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (p.closed && i === 0 && j === n - 1) continue;
      if (segX(P[i], P[i + 1], P[j], P[j + 1])) total++;
    }
  }
  return total;
}
function segX(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

// ===========================================================================
// 8. 形状生成器 → d 字符串（只给几何，不带样式；全部从 +x 方向起、屏幕坐标下顺时针）
// ===========================================================================
const f = (v) => +v.toFixed(4);
/** 圆：两段半圆弧。 */
export const circle = (cx, cy, r) => `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)}Z`;
/** 椭圆。 */
export const ellipse = (cx, cy, rx, ry) => `M${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx + rx)} ${f(cy)}Z`;
/** 圆角矩形：r 是数字或 [左上, 右上, 右下, 左下]，每个角夹到 min(w, h)/2。 */
export function roundRect(x, y, w, h, r = 0) {
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const [tl, tr, br, bl] = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(lim, v)));
  const arc = (rr, ex, ey) => (rr > 0 ? `A${f(rr)} ${f(rr)} 0 0 1 ${f(ex)} ${f(ey)}` : `L${f(ex)} ${f(ey)}`);
  return `M${f(x + tl)} ${f(y)}H${f(x + w - tr)}${arc(tr, x + w, y + tr)}V${f(y + h - br)}${arc(br, x + w - br, y + h)}`
    + `H${f(x + bl)}${arc(bl, x, y + h - bl)}V${f(y + tl)}${arc(tl, x + tl, y)}Z`;
}
/** 正 n 边形：外接圆半径 r，rotation 弧度（0 = 第一个顶点在 +x 方向）。 */
export function polygon(cx, cy, r, n, rotation = 0) {
  if (!(n >= 3)) throw new Error('polygon: n 必须 ≥ 3');
  let d = '';
  for (let k = 0; k < n; k++) { const a = rotation + (k * TAU) / n; d += `${k ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`; }
  return `${d}Z`;
}
/** n 角星：外半径 r1、内半径 r2，rotation 同 polygon。 */
export function star(cx, cy, r1, r2, n, rotation = 0) {
  if (!(n >= 2)) throw new Error('star: n 必须 ≥ 2');
  let d = '';
  for (let k = 0; k < 2 * n; k++) { const a = rotation + (k * Math.PI) / n, r = k % 2 ? r2 : r1; d += `${k ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`; }
  return `${d}Z`;
}
