// 压扁扫描：seek 期间，canvas 上有多大面积是在**非等比**变换下画的。
//
// 要抓的是"斜着看的平面用 setTransform 纵向压扁画"——那是正交投影：平行线不收拢、远近边一样宽，
// 一个斜放的正方形在画面上就是长方形（weiqi-intro 第一版的棋盘，所有门都没抓到，用户一眼看出）。
//
// 为什么只能报 LOOK、不能判 FAIL（结构性的，不是没做完）：
//   1. 像素上无解：斜放正方形的正交像，和正俯视一个长方形的像**逐像素相同**。东西本来是不是方的，只有作者知道。
//   2. API 上有大量正当的非等比变换：挤压拉伸（squash & stretch）、刻意的平面/图解/等轴测风格、压窄的字。
// 所以这里只做一件可以做到的事：把"大面积、非等比、仿射"的时段找出来，指给人看——
// 透视画法下一整块平面**不可能**用一个仿射变换画出来（远近边宽度不同），所以真透视的片子在这里自然是空的。
//
// 判据（检测阈值，不是审美）：同一个变换矩阵下画的东西的屏幕外包框 ≥ 画布面积的 AREA_MIN，
// 且该矩阵的两个奇异值之比 σ2/σ1 < RATIO_MAX（= 至少压扁 10%）。按矩阵分组：一块压扁的棋盘
// 是一次 setTransform + 几十笔线，外包 = 棋盘；一群各自挤压的小球各有各的矩阵，每组都小，不报。
//
// 盲区（写进 SKILL/VERIFIED）：着色器里压扁（WebGL 顶点/片元里乘 sin）看不见；加载时预渲进离屏 canvas 的压扁看不见
// （只拦 seek 期间）；ellipse() 的 rx≠ry 不算（透视下圆本来就投成椭圆）；CSS transform 压扁 DOM 看不见。

export const AREA_MIN = 0.1;
export const RATIO_MAX = 0.9;

/** 注入页面的探针（可重复调用，只装一次）。拦截 seek 期间的 2D 绘制，按变换矩阵记屏幕外包框。 */
export const TILT_PROBE = ([AREA_MIN, RATIO_MAX]) => {
  if (window.__tilt) return;
  const T = window.__tilt = { on: false, cv: new Map(), AREA_MIN, RATIO_MAX };
  const ratioOf = (a, b, c, d) => {
    const F = a * a + b * b + c * c + d * d, D = Math.abs(a * d - b * c);
    const r = Math.sqrt(Math.max(0, F * F - 4 * D * D));
    const s1 = Math.sqrt((F + r) / 2), s2 = Math.sqrt(Math.max(0, (F - r) / 2));
    return s1 > 1e-9 ? s2 / s1 : 1;
  };
  // m = 屏幕 ← 局部 的 2×3 矩阵；pts = 局部坐标点
  const note = (ctx, m, pts) => {
    const r = ratioOf(m.a, m.b, m.c, m.d);
    if (!(r < RATIO_MAX) || r < 1e-3) return;                 // 等比（或退化成 0 宽）不记
    const cvs = ctx.canvas;
    let per = T.cv.get(cvs);
    if (!per) T.cv.set(cvs, (per = new Map()));
    const key = [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 1000) / 1000).join(',');
    let g = per.get(key);
    if (!g) per.set(key, (g = { r, a: m.a, b: m.b, c: m.c, d: m.d, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }));
    for (const [u, v] of pts) {
      const X = m.a * u + m.c * v + m.e, Y = m.b * u + m.d * v + m.f;
      if (X < g.x0) g.x0 = X; if (X > g.x1) g.x1 = X; if (Y < g.y0) g.y0 = Y; if (Y > g.y1) g.y1 = Y;
    }
    g.n++;
  };
  const rectPts = (x, y, w, h) => [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  const P = CanvasRenderingContext2D.prototype;
  const wrap = (obj, name, ptsOf) => {
    const orig = obj[name]; if (typeof orig !== 'function') return;
    obj[name] = function (...a) {
      if (T.on) try { const p = ptsOf.apply(this, a); if (p) note(this, this.getTransform(), p); } catch { /* 探针失败不影响场景 */ }
      return orig.apply(this, a);
    };
  };
  wrap(P, 'moveTo', (x, y) => [[x, y]]);
  wrap(P, 'lineTo', (x, y) => [[x, y]]);
  wrap(P, 'quadraticCurveTo', (a, b, x, y) => [[a, b], [x, y]]);
  wrap(P, 'bezierCurveTo', (a, b, c, d, x, y) => [[a, b], [c, d], [x, y]]);
  wrap(P, 'arcTo', (a, b, x, y) => [[a, b], [x, y]]);
  wrap(P, 'arc', (x, y, r) => rectPts(x - r, y - r, 2 * r, 2 * r));
  wrap(P, 'ellipse', (x, y, rx, ry) => { const R = Math.max(rx, ry); return rectPts(x - R, y - R, 2 * R, 2 * R); });
  wrap(P, 'rect', rectPts);
  wrap(P, 'roundRect', rectPts);
  wrap(P, 'fillRect', rectPts);
  wrap(P, 'strokeRect', rectPts);
  for (const fn of ['fillText', 'strokeText']) wrap(P, fn, function (text, x, y) {
    const mt = this.measureText(String(text));
    const asc = mt.actualBoundingBoxAscent || 0, desc = mt.actualBoundingBoxDescent || 0;
    return rectPts(x - (mt.actualBoundingBoxLeft || 0), y - asc, (mt.actualBoundingBoxLeft || 0) + (mt.actualBoundingBoxRight || mt.width), asc + desc);
  });
  // drawImage：有效矩阵 = 当前变换 × (目标框 / 源框)。把一张方图拉成扁的贴上去，同样是压扁。
  const origDraw = P.drawImage;
  P.drawImage = function (img, ...a) {
    if (T.on) try {
      const iw = img.naturalWidth || img.videoWidth || img.displayWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.displayHeight || img.height;
      let sx = 0, sy = 0, sw = iw, sh = ih, dx, dy, dw, dh;
      if (a.length === 2) [dx, dy] = a, dw = iw, dh = ih;
      else if (a.length === 4) [dx, dy, dw, dh] = a;
      else [sx, sy, sw, sh, dx, dy, dw, dh] = a;
      if (sw && sh) {
        const m = this.getTransform(), kx = dw / sw, ky = dh / sh;
        note(this, { a: m.a * kx, b: m.b * kx, c: m.c * ky, d: m.d * ky, e: m.a * dx + m.c * dy + m.e, f: m.b * dx + m.d * dy + m.f }, rectPts(0, 0, sw, sh));
      }
    } catch { /* 同上 */ }
    return origDraw.call(this, img, ...a);
  };
  // Path2D：建路径时不经过 ctx 的变换，fill/stroke(path) 时才套当前变换。在 Path2D 上记局部外包，填的时候映射。
  if (typeof Path2D === 'function') {
    const Q = Path2D.prototype;
    const grow = (p, pts) => { const b = p.__tb || (p.__tb = [Infinity, Infinity, -Infinity, -Infinity]);
      for (const [x, y] of pts) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } };
    const track = (name, ptsOf) => { const o = Q[name]; if (typeof o !== 'function') return;
      Q[name] = function (...a) { try { grow(this, ptsOf(...a)); } catch { /* */ } return o.apply(this, a); }; };
    track('moveTo', (x, y) => [[x, y]]); track('lineTo', (x, y) => [[x, y]]);
    track('quadraticCurveTo', (a, b, x, y) => [[a, b], [x, y]]); track('bezierCurveTo', (a, b, c, d, x, y) => [[a, b], [c, d], [x, y]]);
    track('arc', (x, y, r) => rectPts(x - r, y - r, 2 * r, 2 * r)); track('rect', rectPts); track('roundRect', rectPts);
    track('ellipse', (x, y, rx, ry) => { const R = Math.max(rx, ry); return rectPts(x - R, y - R, 2 * R, 2 * R); });
    for (const fn of ['fill', 'stroke']) {
      const o = P[fn];
      P[fn] = function (...a) {
        if (T.on) try { const p = a.find((v) => v instanceof Path2D); const b = p && p.__tb;
          if (b && b[0] <= b[2]) note(this, this.getTransform(), rectPts(b[0], b[1], b[2] - b[0], b[3] - b[1])); } catch { /* */ }
        return o.apply(this, a);
      };
    }
  }
  // 一帧的汇总：每块 canvas 取面积最大的那一组（外包裁到画布内）
  T.summary = () => {
    let best = null;
    for (const [cvs, per] of T.cv) {
      const W = cvs.width, H = cvs.height;
      for (const g of per.values()) {
        const x0 = Math.max(0, g.x0), y0 = Math.max(0, g.y0), x1 = Math.min(W, g.x1), y1 = Math.min(H, g.y1);
        const frac = x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / (W * H) : 0;
        if (!best || frac > best.frac) best = { frac, ratio: g.r, axis: Math.abs(g.b) < 1e-6 && Math.abs(g.c) < 1e-6 ? Math.abs(g.d / g.a) : null,
          ops: g.n, canvas: { w: W, h: H, onscreen: cvs.isConnected, id: cvs.id || null } };
      }
    }
    return best;
  };
};

/** 在场景页里逐个 t 调 window.seek(t)，返回每个 t 面积最大的非等比组（没有 = null）。 */
export async function tiltScan(page, ts, { areaMin = AREA_MIN, ratioMax = RATIO_MAX } = {}) {
  await page.evaluate(TILT_PROBE, [areaMin, ratioMax]);
  return page.evaluate(async (ts) => {
    const T = window.__tilt, out = [];
    for (const t of ts) {
      T.cv = new Map(); T.on = true;
      try { await window.seek(t); } finally { T.on = false; }
      out.push({ t, hit: T.summary() });
    }
    return out;
  }, ts);
}

/** 把逐帧结果并成时段：只保留面积 ≥ areaMin 的帧，相邻采样点连成一段。 */
export function tiltRuns(samples, { areaMin = AREA_MIN, step } = {}) {
  const runs = [];
  let cur = null;
  for (const [i, s] of samples.entries()) {
    const ok = s.hit && s.hit.frac >= areaMin;
    if (ok && cur && i === cur.last + 1) {
      cur.to = s.t; cur.last = i; cur.n++;
      if (s.hit.frac > cur.frac) { cur.frac = s.hit.frac; cur.ratio = s.hit.ratio; cur.axis = s.hit.axis; cur.canvas = s.hit.canvas; cur.worstT = s.t; }
    } else if (ok) {
      cur = { from: s.t, to: s.t, last: i, n: 1, frac: s.hit.frac, ratio: s.hit.ratio, axis: s.hit.axis, canvas: s.hit.canvas, worstT: s.t };
      runs.push(cur);
    } else cur = null;
  }
  for (const r of runs) { delete r.last; if (step) r.to = +(r.to + step).toFixed(4); }
  return runs;
}

/** 一段的人话。比值若是纯纵向压扁，换算成"相当于俯角多少度的正交投影"。 */
export function describeRun(r, fmt = (t) => `${t.toFixed(2)}s`) {
  const deg = (Math.asin(Math.min(1, r.ratio)) * 180) / Math.PI;
  const where = r.canvas.onscreen ? '画布' : `离屏画布 ${r.canvas.w}×${r.canvas.h}`;
  const kind = r.axis != null && r.axis < 1 ? `纵/横 ${r.axis.toFixed(2)}，相当于俯角 ${deg.toFixed(0)}° 的纵向压扁` : `相当于俯角 ${deg.toFixed(0)}° 的正交投影`;
  return `${fmt(r.from)}–${fmt(r.to)} ${where}上 ${(r.frac * 100).toFixed(0)}% 面积在非等比仿射变换下绘制（短/长轴 ${r.ratio.toFixed(2)}，${kind}；最大在 ${fmt(r.worstT)}）`;
}
