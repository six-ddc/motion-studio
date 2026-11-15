// film-motion 运行时 · 镜头与转场（canvas 2D 合成）
//
// 接口只有一个形状：**两个镜头的 paint 函数 + 转场进度 → 画出这一帧**。
//   const S = createStage(canvas, { anchors: A });         // A 可省（film-core anchors.js）
//   const TL = timeline([...]);                            // choreo.js
//   window.seek = A.install((t) => S.frame(t, TL));
//   或者不用时间轴，直接混两个镜头：
//   S.mix('wipe', { paint: pa, lt: la }, { paint: pb, lt: lb }, pe, { shape: 'iris', ... });
//
// 镜头：paint(ctx, lt, sh) —— 画一整帧（**必须铺满不透明底**：转场是两帧之间的合成，透明区会露出另一帧或黑）。
//   sh.el(name, rect, draw, { props, morph })   画一个有名字的元素并登记它（Magic Move / 匹配剪辑 / 锚点都靠它）
//   sh.anchor(name, x, y, w, h)                 只登记不画（ctx 当前变换下的局部矩形）
//   sh.get(name)                                本镜头本帧已登记的屏幕框 {x0,y0,x1,y1}
//   sh.lt / sh.t / sh.p / sh.dur / sh.name / sh.L / sh.W / sh.H
// 镜头里要登记锚点就用 sh.el / sh.anchor，不要直接调 A.ctxRect：转场里镜头画在离屏层上，
// 层在屏幕上被平移/缩放过，只有 stage 知道那个变换，直接登记会记成"没转场时的位置"。
//
// 纯函数：离屏画布是**复用的对象**（每次用前清空），不承载跨帧信息；噪声图按参数缓存，只依赖参数。
// 没有默认转场、没有默认缓动、没有默认颜色：每个要颜色的转场都要求显式给色值。
// 代价表与实测耗时见 film-motion references/transitions.md。

import { sat, lerp, hash01 } from './motion.js';
import { resolveEase } from './choreo.js';

const I6 = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [ // m·n，矩阵 [a,b,c,d,e,f]
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const fromDOM = (d) => [d.a, d.b, d.c, d.d, d.e, d.f];
const mapBox = (m, x, y, w, h) => {
  const ps = [apply(m, x, y), apply(m, x + w, y), apply(m, x, y + h), apply(m, x + w, y + h)];
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const boxMap = (m, b) => mapBox(m, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
const lerpBox = (a, b, q) => ({ x0: lerp(a.x0, b.x0, q), y0: lerp(a.y0, b.y0, q), x1: lerp(a.x1, b.x1, q), y1: lerp(a.y1, b.y1, q) });
const center = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
// 把屏幕框 a 映射到屏幕框 b 的仿射（fit:'fill' 非等比；'uniform' 等比取几何平均，中心对齐）
function boxToBox(a, b, fit = 'fill') {
  const aw = Math.max(1e-6, a.x1 - a.x0), ah = Math.max(1e-6, a.y1 - a.y0);
  let sx = (b.x1 - b.x0) / aw, sy = (b.y1 - b.y0) / ah;
  if (fit === 'uniform') sx = sy = Math.sqrt(Math.abs(sx * sy));
  const [ca, cb] = [center(a), center(b)];
  return [sx, 0, 0, sy, cb[0] - sx * ca[0], cb[1] - sy * ca[1]];
}
// 让变换后的整帧仍盖满画面（缩放 ≥ 1，平移夹在不露边的范围内）。匹配剪辑因此可能对不准——那是"不露黑边"的代价。
function coverClamp(m, S, on) {
  if (!on) return m;
  const sx = Math.max(1, m[0]), sy = Math.max(1, m[3]);
  // 保持原变换下画面中心的去向，再把平移夹住
  const cx = S.W / 2, cy = S.H / 2;
  const tx0 = m[0] * cx + m[4] - sx * cx, ty0 = m[3] * cy + m[5] - sy * cy;
  const tx = Math.min(0, Math.max(S.W - sx * S.W, tx0)), ty = Math.min(0, Math.max(S.H - sy * S.H, ty0));
  return [sx, 0, 0, sy, tx, ty];
}
function reset(c) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'medium';   // 不用 'high'：实测 Chromium 156 下 canvas 源缩放 drawImage 会与上一帧相关（门 4 抓到），见 transitions.md
}
const need = (v, what, kind) => { if (v == null) throw new Error(`${kind}: 必须给 ${what}——转场不替你选`); return v; };

// ---------------------------------------------------------------------------
// 颜色插值（Magic Move 的 props 用）。OKLab 是 CSS Color 4 渐变/color-mix 的默认插值空间——技术默认，可换 'srgb'。
// ---------------------------------------------------------------------------
function parseColor(s) {
  if (typeof s !== 'string') return null;
  let m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s.trim());
  if (m) { const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; }
  return null;
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const unlin = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toOklab([r, g, b]) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
export function mixColor(a, b, q, space = 'oklab') {
  const A = parseColor(a), B = parseColor(b);
  if (!A || !B) return q < 0.5 ? a : b;
  let rgb;
  if (space === 'srgb') rgb = [0, 1, 2].map((i) => lerp(A[i], B[i], q));
  else { const la = toOklab(A), lb = toOklab(B); rgb = fromOklab([0, 1, 2].map((i) => lerp(la[i], lb[i], q))); }
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgba(${cl(rgb[0])},${cl(rgb[1])},${cl(rgb[2])},${+lerp(A[3], B[3], q).toFixed(4)})`;
}
/** 两组 props 插值：数 → lerp；颜色串 → mixColor；数组逐项；其余在 q=0.5 处切换。 */
export function mixProps(a, b, q, space = 'oklab') {
  if (a == null || b == null) return q < 0.5 ? a : b;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number') out[k] = lerp(x, y, q);
    else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) out[k] = x.map((v, i) => (typeof v === 'number' ? lerp(v, y[i], q) : q < 0.5 ? v : y[i]));
    else if (parseColor(x) && parseColor(y)) out[k] = mixColor(x, y, q, space);
    else out[k] = x === undefined ? y : y === undefined ? x : q < 0.5 ? x : y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 舞台
// ---------------------------------------------------------------------------
export function createStage(canvas, { anchors = null, L = null } = {}) {
  const W = canvas.width, H = canvas.height;
  const main = canvas.getContext('2d');
  const pool = new Map();
  /** 复用的离屏层（同尺寸）。clear=true 时清空并复位状态。 */
  const layer = (name, clear = true, w = W, h = H) => {
    let c = pool.get(name);
    if (!c || c.width !== w || c.height !== h) {
      c = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
      c.width = w; c.height = h; pool.set(name, c);
    }
    const x = c.getContext('2d');
    reset(x);
    if (clear) x.clearRect(0, 0, w, h);
    return c;
  };
  const maps = new Map();     // 噪声图缓存：键只由参数决定

  function makeSh(c, shot, lt, t, mode, rec) {
    return {
      name: shot.name, lt, t, p: shot.dur ? sat(lt / shot.dur) : 0, dur: shot.dur, shot, L, W, H, ctx: c, mode,
      el(name, rect, draw, opts = {}) {
        if (typeof draw !== 'function') throw new Error(`sh.el(${name}): 第三个参数是 draw(ctx, props, rect)`);
        const M = fromDOM(c.getTransform());
        const r = { name, kind: 'el', M, rect: { ...rect }, box: mapBox(M, rect.x, rect.y, rect.w, rect.h),
          draw, props: opts.props ?? null, morph: !!opts.morph, z: rec.length, alpha: c.globalAlpha };
        rec.push(r);
        if (mode !== 'collect') { c.save(); draw(c, r.props, r.rect); c.restore(); }
        return r.box;
      },
      anchor(name, x, y, w, h, meta) {
        const M = fromDOM(c.getTransform());
        rec.push({ name, kind: 'anchor', M, box: mapBox(M, x, y, w, h), meta });
      },
      get(name) {
        let b = null;
        for (const r of rec) if (r.name === name) b = b ? { x0: Math.min(b.x0, r.box.x0), y0: Math.min(b.y0, r.box.y0), x1: Math.max(b.x1, r.box.x1), y1: Math.max(b.y1, r.box.y1) } : { ...r.box };
        return b;
      },
    };
  }

  /** 把镜头画进 target（canvas）。mode 'collect' 时 sh.el 只记录不画（Magic Move 的根层）。返回元素记录。 */
  function paintShot(target, side, t, mode = 'draw') {
    const c = target === canvas ? main : target.getContext('2d');
    reset(c);
    const rec = [];
    c.save();
    side.shot.paint(c, side.lt, makeSh(c, side.shot, side.lt, t, mode, rec));
    c.restore();
    reset(c);
    return rec;
  }

  function register(rec, m, meta) {
    if (!anchors) return;
    for (const r of rec) {
      const b = m ? boxMap(m, r.box) : r.box;
      anchors.box(r.name, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, { ...(r.meta ?? {}), ...meta });
    }
  }

  const S = {
    canvas, ctx: main, W, H, L, layer, maps,
    /** 画第 t 秒：查时间轴，单镜头直接画到主画布（零额外开销），转场时两镜头各画进离屏层再合成。 */
    frame(t, tl) {
      const at = tl.at(t);
      reset(main);
      if (at.type === 'shot') {
        const rec = paintShot(canvas, { shot: at.shot, lt: at.lt }, t);
        register(rec, null, { shot: at.shot.name });
        return at;
      }
      S.mix(at.tr.kind, at.a, at.b, at.pe, { ...at.tr, p: at.p, t });
      return at;
    },
    /**
     * 混两个镜头。a/b = { shot | paint, lt }；pe = 缓动后的进度；opts = 该转场的参数（p = 原始进度，t = 全局时刻，dur = 转场秒数）。
     */
    mix(kind, a, b, pe, opts = {}) {
      const fx = TRANSITIONS[kind];
      if (!fx) throw new Error(`没有转场「${kind}」。可用：${Object.keys(TRANSITIONS).join(' / ')}`);
      const norm = (s) => (s.shot ? s : { shot: { name: s.name ?? '?', paint: s.paint, dur: s.dur ?? 0 }, lt: s.lt });
      a = norm(a); b = norm(b);
      const p = opts.p ?? pe, t = opts.t ?? 0;
      const ctxInfo = { S, a, b, p, pe, t, dur: opts.dur ?? 0, opts };
      if (fx.custom) { reset(main); return fx.custom(ctxInfo); }  // Magic Move 自己管画法
      const LA = layer('A'), LB = layer('B');
      ctxInfo.recA = paintShot(LA, a, t);
      ctxInfo.recB = paintShot(LB, b, t);
      reset(main);
      const res = fx(main, LA, LB, pe, ctxInfo) ?? {};
      reset(main);
      // 锚点：同名两边都有 → 取占优的一边（pe<0.5 取 A）；只有一边的照登。框按层在屏幕上的变换映射。
      if (anchors) {
        const namesB = new Set(ctxInfo.recB.map((r) => r.name)), namesA = new Set(ctxInfo.recA.map((r) => r.name));
        const keepA = ctxInfo.recA.filter((r) => !namesB.has(r.name) || pe < 0.5);
        const keepB = ctxInfo.recB.filter((r) => !namesA.has(r.name) || pe >= 0.5);
        if (res.mA !== 'hidden') register(keepA, res.mA ?? null, { shot: a.shot.name });
        if (res.mB !== 'hidden') register(keepB, res.mB ?? null, { shot: b.shot.name });
      }
      return res;
    },
    paintShot, register, makeSh,
    /** Magic Move 的锚点：共享元素登记插值后的框；其余按根转场的层变换映射 */
    registerMM(shared, restA, restB, rres, a, b) {
      if (!anchors) return;
      for (const o of shared) anchors.box(o.name, o.box.x0, o.box.y0, o.box.x1 - o.box.x0, o.box.y1 - o.box.y0, { shot: b.shot.name, shared: true });
      if (rres.mA !== 'hidden') register(restA, rres.mA ?? null, { shot: a.shot.name });
      if (rres.mB !== 'hidden') register(restB, rres.mB ?? null, { shot: b.shot.name });
    },
  };
  return S;
}

// ---------------------------------------------------------------------------
// 合成小件
// ---------------------------------------------------------------------------
const draw = (c, img, alpha = 1, m = null, op = 'source-over') => {
  c.save(); c.globalAlpha = alpha; c.globalCompositeOperation = op;
  if (m) c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  c.drawImage(img, 0, 0); c.restore();
};
/** 便宜的模糊：缩到 1/k 再放大（双线性）。ctx.filter='blur()' 在 SwiftShader 下慢得多（见代价表）。 */
function cheapBlur(S, src, k, name = 'blur') {
  const w = Math.max(1, Math.round(S.W / k)), h = Math.max(1, Math.round(S.H / k));
  const s = S.layer(name + 's', true, w, h);
  s.getContext('2d').drawImage(src, 0, 0, w, h);
  const out = S.layer(name);
  out.getContext('2d').drawImage(s, 0, 0, S.W, S.H);
  return out;
}
// 方向：'left' | 'right' | 'up' | 'down' 或角度（弧度，0 = 向右）→ 单位向量
function dirVec(d) {
  if (typeof d === 'number') return [Math.cos(d), Math.sin(d)];
  const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[d];
  if (!v) throw new Error(`方向「${d}」不认识：left / right / up / down 或弧度`);
  return v;
}
// 找焦点框：opts.focus 是名字（在 rec 里找）或屏幕框 {x0,y0,x1,y1} 或 {x,y,w,h}
function focusBox(f, rec, S, side) {
  if (!f) return null;
  if (typeof f === 'string') {
    let b = null;
    for (const r of rec ?? []) if (r.name === f) b = b ? { x0: Math.min(b.x0, r.box.x0), y0: Math.min(b.y0, r.box.y0), x1: Math.max(b.x1, r.box.x1), y1: Math.max(b.y1, r.box.y1) } : { ...r.box };
    if (!b) throw new Error(`转场焦点「${f}」在镜头 ${side} 这一帧没有登记（sh.el / sh.anchor）`);
    return b;
  }
  if ('x0' in f) return f;
  return { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h };
}

// 遮罩擦除的形状：返回在 mask ctx 上画出 alpha 遮罩（1 = 显示 B）
function drawShapeMask(m, shape, q, info) {
  const { S, opts } = info, W = S.W, H = S.H;
  const fe = Math.max(0, opts.feather ?? 0) * Math.hypot(W, H);
  m.fillStyle = '#fff';
  if (shape === 'linear') {
    const [ux, uy] = dirVec(opts.dir ?? opts.angle ?? need(opts.dir, 'dir（擦除方向）', 'wipe linear'));
    // 屏幕四角在方向上的投影范围
    const pr = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => x * ux + y * uy);
    const lo = Math.min(...pr), hi = Math.max(...pr);
    const edge = lerp(lo - fe, hi, q);                    // 软边的后沿
    const ox = W / 2 - ux * ((lo + hi) / 2), oy = H / 2 - uy * ((lo + hi) / 2);  // 投影原点修正
    const P = (s) => [ox + ux * s, oy + uy * s];
    if (fe < 0.5) {
      const [px, py] = P(edge);
      m.beginPath();
      const big = 4 * Math.hypot(W, H);
      // 半平面：投影 < edge 的一侧
      m.moveTo(px - uy * big, py + ux * big); m.lineTo(px + uy * big, py - ux * big);
      m.lineTo(px + uy * big - ux * big, py - ux * big - uy * big); m.lineTo(px - uy * big - ux * big, py + ux * big - uy * big);
      m.closePath(); m.fill();
    } else {
      const [x0, y0] = P(edge), [x1, y1] = P(edge + fe);
      const g = m.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      m.fillStyle = g; m.fillRect(0, 0, W, H);
    }
    return;
  }
  if (shape === 'iris' || shape === 'clock') {
    const fb = focusBox(opts.focus, info.irisRec, S, 'A/B');
    const [cx, cy] = fb ? center(fb) : opts.center ? [opts.center[0] * W, opts.center[1] * H] : [W / 2, H / 2];
    const R = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
    if (shape === 'iris') {
      const r0 = fb && opts.fromBox ? Math.hypot(fb.x1 - fb.x0, fb.y1 - fb.y0) / 2 : 0;   // fromBox:true = 从元素外接圆起步（p=0 时 B 已露在元素里）
      const r = lerp(r0, R + fe, q);
      if (fe < 0.5) { m.beginPath(); m.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2); m.fill(); }
      else {
        const g = m.createRadialGradient(cx, cy, Math.max(0, r - fe), cx, cy, Math.max(0.01, r));
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        m.fillStyle = g; m.fillRect(0, 0, W, H);
      }
    } else {
      const a0 = opts.startAngle ?? -Math.PI / 2, sweep = Math.PI * 2 * q * (opts.ccw ? -1 : 1);
      m.beginPath(); m.moveTo(cx, cy); m.arc(cx, cy, R + 2, a0, a0 + sweep, !!opts.ccw); m.closePath(); m.fill();
    }
    return;
  }
  if (shape === 'box') {
    const fb = focusBox(opts.focus, info.irisRec, S, 'A/B') ?? { x0: W / 2, y0: H / 2, x1: W / 2, y1: H / 2 };
    const b = lerpBox(fb, { x0: 0, y0: 0, x1: W, y1: H }, q);
    m.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    return;
  }
  if (shape === 'bars') {
    const n = need(opts.bars, 'bars（条数）', 'wipe bars');
    const [ux, uy] = dirVec(opts.dir ?? need(opts.dir, 'dir', 'wipe bars'));
    const spread = opts.spread ?? 0.5;               // 第一条与最后一条的起步差（占全程比例）
    const D = Math.hypot(W, H), bw = D / n;
    m.save(); m.translate(W / 2, H / 2); m.transform(ux, uy, -uy, ux, 0, 0);
    for (let i = 0; i < n; i++) {
      const d = n > 1 ? (i / (n - 1)) * spread : 0;
      const qi = sat((q - d) / (1 - spread || 1));
      if (qi <= 0) continue;
      // 条沿方向 u 生长；条的排布沿法向
      m.fillRect(-D / 2, -D / 2 + i * bw, D * qi, bw + 1);
    }
    m.restore();
    return;
  }
  if (shape === 'custom') {
    const f = need(opts.mask, 'mask(ctx, q, info)（自己画 alpha 遮罩）', 'wipe custom');
    f(m, q, info);
    return;
  }
  throw new Error(`wipe 形状「${shape}」不认识：linear / iris / clock / box / bars / custom`);
}

// 噪声 / 颗粒 / 自定义亮度图（luma wipe 用），按参数缓存
function lumaMap(S, opts) {
  const kind = opts.map;
  if (kind && typeof kind === 'object' && 'width' in kind) return kind;   // 调用方给的 canvas/图片（灰度）
  const seed = need(opts.seed, 'seed（噪声种子）', 'luma');
  const cell = need(opts.cell, 'cell（噪声格子大小，占短边比例）', 'luma');
  const key = `${kind}|${seed}|${cell}|${opts.octaves ?? 1}`;
  if (S.maps.has(key)) return S.maps.get(key);
  const short = Math.min(S.W, S.H);
  const cw = Math.max(1, Math.round(short * cell));
  const gw = Math.ceil(S.W / cw) + 1, gh = Math.ceil(S.H / cw) + 1;
  const out = S.layer(`map:${key}`);
  const o = out.getContext('2d');
  o.fillStyle = '#000'; o.fillRect(0, 0, S.W, S.H);
  const oct = kind === 'noise' ? (opts.octaves ?? 1) : 1;
  for (let k = 0; k < oct; k++) {
    const f = 2 ** k, w = gw * f, h = gh * f;
    const small = S.layer(`mapsmall:${key}:${k}`, true, w, h);
    const sc = small.getContext('2d');
    const img = sc.createImageData(w, h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = Math.round(255 * hash01(seed, k, i, j));
      const o4 = 4 * (j * w + i);
      img.data[o4] = img.data[o4 + 1] = img.data[o4 + 2] = v; img.data[o4 + 3] = 255;
    }
    sc.putImageData(img, 0, 0);
    o.save();
    o.imageSmoothingEnabled = kind === 'noise';      // noise = 双线性放大成团块；grain = 最近邻，方块颗粒
    o.globalAlpha = oct > 1 ? 1 / (k + 1) : 1;
    o.globalCompositeOperation = k ? 'source-over' : 'copy';
    o.drawImage(small, 0, 0, w * cw / f, h * cw / f);
    o.restore();
  }
  if (oct > 1) { // 多层叠加后拉回 0..1：用 contrast 把均值附近的分布撑开
    const tmp = S.layer(`mapn:${key}`); const tc = tmp.getContext('2d');
    tc.filter = `contrast(${1 + 0.5 * (oct - 1)})`; tc.drawImage(out, 0, 0); tc.filter = 'none';
    o.globalCompositeOperation = 'copy'; o.drawImage(tmp, 0, 0); o.globalCompositeOperation = 'source-over';
  }
  S.maps.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// 转场表：fx(main, LA, LB, pe, info) → { mA?, mB? }（层在屏幕上的仿射，给锚点映射用；'hidden' = 这一侧没画）
// ---------------------------------------------------------------------------
export const TRANSITIONS = {
  /** 硬切：pe 过 at（默认 0.5）的那一刻切。窗口 > 0 时可以配合 match / 声音在窗口内任意点切。 */
  cut(c, A, B, pe, { opts }) {
    const at = opts.at ?? 0.5;
    if (pe < at) { draw(c, A); return { mB: 'hidden' }; }
    draw(c, B); return { mA: 'hidden' };
  },

  /** 叠化：B 以 pe 的不透明度叠在 A 上 */
  crossfade(c, A, B, pe) { draw(c, A); draw(c, B, sat(pe)); return {}; },

  /** 经由颜色：前半 A → color，后半 color → B。hold 为纯色停留占比。 */
  dip(c, A, B, pe, { opts, S }) {
    const color = need(opts.color, 'color（经由的颜色）', 'dip');
    const hold = opts.hold ?? 0;
    const h0 = (1 - hold) / 2, h1 = 1 - h0;
    const aSide = pe < 0.5;
    draw(c, aSide ? A : B);
    const k = pe < h0 ? pe / h0 : pe > h1 ? (1 - pe) / (1 - h1) : 1;
    c.save(); c.globalAlpha = sat(k); c.fillStyle = color; c.fillRect(0, 0, S.W, S.H); c.restore();
    return aSide ? { mB: 'hidden' } : { mA: 'hidden' };
  },

  /** 形状遮罩擦除：shape = linear / iris / clock / box / bars / custom。invert:true = A 收缩成形状、B 在外 */
  wipe(c, A, B, pe, info) {
    const { S, opts } = info;
    const shape = need(opts.shape, 'shape', 'wipe');
    info.irisRec = opts.focusIn === 'B' ? info.recB : info.recA;
    const M = S.layer('mask'), m = M.getContext('2d');
    const inv = !!opts.invert;
    drawShapeMask(m, shape, inv ? 1 - pe : pe, info);
    const top = inv ? A : B, bottom = inv ? B : A;
    const T = S.layer('wipeTop'); const tc = T.getContext('2d');
    tc.drawImage(top, 0, 0); tc.globalCompositeOperation = 'destination-in'; tc.drawImage(M, 0, 0);
    draw(c, bottom); draw(c, T);
    if (opts.edge) { // 可选：擦除边沿描一道（edge = { color, width }，宽占短边比例）。只对 iris/linear 硬边有意义
      const em = S.layer('edge'); const ec = em.getContext('2d');
      ec.drawImage(M, 0, 0); ec.globalCompositeOperation = 'source-in';
      ec.fillStyle = need(opts.edge.color, 'edge.color', 'wipe'); ec.fillRect(0, 0, S.W, S.H);
      const w = Math.max(1, (opts.edge.width ?? 0.004) * Math.min(S.W, S.H));
      // 外扩一圈 = 遮罩向外偏移后减去原遮罩：用 shadow 近似，便宜
      c.save(); c.shadowColor = opts.edge.color; c.shadowBlur = w; c.globalCompositeOperation = 'source-over';
      c.globalAlpha = sat(Math.sin(Math.PI * pe) * 4);
      c.drawImage(T, 0, 0); c.restore();
    }
    return {};
  },

  /**
   * 亮度图擦除（AE 的 Gradient Wipe）：map 的每个像素在 v < pe 时露出 B，softness 是软边宽度（占亮度范围）。
   * map = 'noise'（双线性团块：溶解）| 'grain'（最近邻方块颗粒）| 调用方给的灰度 canvas（任意图案：径向、文字、照片的亮度）。
   * 要求两镜头不透明（用乘法 + 加法合成：A·(1-m) + B·m）。
   */
  luma(c, A, B, pe, info) {
    const { S, opts } = info;
    const map = lumaMap(S, opts);
    const soft = Math.max(1 / 64, need(opts.softness, 'softness（软边宽度，0..1 的亮度范围）', 'luma'));
    const k = 1 / soft;
    const pp = pe * (1 + soft);
    const M = S.layer('lm'), m = M.getContext('2d');
    m.globalCompositeOperation = 'copy'; m.drawImage(map, 0, 0, S.W, S.H);
    m.globalCompositeOperation = 'lighter';
    const g = Math.round(255 * sat(1 - pp)); m.fillStyle = `rgb(${g},${g},${g})`; m.fillRect(0, 0, S.W, S.H);
    m.globalCompositeOperation = 'difference'; m.fillStyle = '#fff'; m.fillRect(0, 0, S.W, S.H);
    // 现在 M = max(0, pp - v)；乘 k 得软阈值遮罩
    const K = S.layer('lmk'), kc = K.getContext('2d');
    kc.fillStyle = '#000'; kc.fillRect(0, 0, S.W, S.H); kc.filter = `brightness(${k})`; kc.drawImage(M, 0, 0); kc.filter = 'none';
    const XB = S.layer('lmB'), xb = XB.getContext('2d');
    xb.drawImage(B, 0, 0); xb.globalCompositeOperation = 'multiply'; xb.drawImage(K, 0, 0);
    kc.globalCompositeOperation = 'difference'; kc.fillStyle = '#fff'; kc.fillRect(0, 0, S.W, S.H);   // 1 - m
    draw(c, A, 1, null, 'copy'); draw(c, K, 1, null, 'multiply'); draw(c, XB, 1, null, 'lighter');
    if (opts.burn) {
      // 可选：溶解前沿烧一道颜色。burn = { color, strength, width }，三项都必给（亮度和宽度就是这个手法的观感本身）：
      //   width    烧边宽度，占 softness 的比例（1 = 和软边一样宽；0.3 = 只在软边最前缘一条细线）
      //   strength 0..1，烧边峰值亮度（加法叠加，1 = 边上纯色）
      const color = need(opts.burn.color, 'burn.color', 'luma');
      const bw = need(opts.burn.width, 'burn.width（占 softness 的比例）', 'luma');
      const bs = need(opts.burn.strength, 'burn.strength（0..1）', 'luma');
      // 用更陡的阈值重算一张窄遮罩 m2 = sat((pp - v)·k/width)，边 = 4·m2·(1 − m2)
      const E = S.layer('lmE'), ec = E.getContext('2d');
      ec.fillStyle = '#000'; ec.fillRect(0, 0, S.W, S.H);
      ec.filter = `brightness(${k / Math.max(0.02, bw)})`; ec.drawImage(M, 0, 0); ec.filter = 'none';
      const E2 = S.layer('lmE2'), e2 = E2.getContext('2d');
      e2.drawImage(E, 0, 0); e2.globalCompositeOperation = 'multiply'; e2.filter = 'invert(1)'; e2.drawImage(E, 0, 0); e2.filter = 'none';
      const E3 = S.layer('lmE3'), e3 = E3.getContext('2d');
      e3.filter = `brightness(${4 * sat(bs)})`; e3.drawImage(E2, 0, 0); e3.filter = 'none';
      e3.globalCompositeOperation = 'multiply'; e3.fillStyle = color; e3.fillRect(0, 0, S.W, S.H);
      draw(c, E3, 1, null, 'lighter');
    }
    return {};
  },

  /** 推移：A 被推出、B 跟进，dir = 内容运动方向。parallax < 1 时 A 走得比 B 慢（纵深感）。 */
  push(c, A, B, pe, { S, opts }) {
    const [ux, uy] = dirVec(need(opts.dir, 'dir', 'push'));
    const D = Math.abs(ux) * S.W + Math.abs(uy) * S.H;
    const par = opts.parallax ?? 1;
    const mA = [1, 0, 0, 1, ux * D * pe * par, uy * D * pe * par];
    const mB = [1, 0, 0, 1, -ux * D * (1 - pe), -uy * D * (1 - pe)];
    draw(c, A, 1, mA); draw(c, B, 1, mB);
    return { mA, mB };
  },

  /** 覆盖：B 滑入盖住不动的 A（mode:'cover'），或 A 滑走露出 B（mode:'uncover'）。shade = 被盖那一侧压暗的颜色（可省）。 */
  slide(c, A, B, pe, { S, opts }) {
    const [ux, uy] = dirVec(need(opts.dir, 'dir', 'slide'));
    const D = Math.abs(ux) * S.W + Math.abs(uy) * S.H;
    const mode = need(opts.mode, "mode（'cover' | 'uncover'）", 'slide');
    const shade = (img, k) => { if (!opts.shade) return; c.save(); c.globalAlpha = k; c.fillStyle = opts.shade; c.fillRect(0, 0, S.W, S.H); c.restore(); };
    if (mode === 'cover') {
      const mB = [1, 0, 0, 1, -ux * D * (1 - pe), -uy * D * (1 - pe)];
      draw(c, A); shade(A, pe); draw(c, B, 1, mB); return { mB };
    }
    const mA = [1, 0, 0, 1, ux * D * pe, uy * D * pe];
    draw(c, B); shade(B, 1 - pe); draw(c, A, 1, mA); return { mA };
  },

  /** 缩放叠化：A 放大淡出、B 从 scaleB 缩回 1 淡入（不穿越任何元素；要"钻进某个东西"用 zoomThrough） */
  zoom(c, A, B, pe, { S, opts }) {
    const za = need(opts.scaleA, 'scaleA（A 结束时的倍数）', 'zoom'), zb = need(opts.scaleB, 'scaleB（B 起始倍数）', 'zoom');
    const [cx, cy] = opts.center ? [opts.center[0] * S.W, opts.center[1] * S.H] : [S.W / 2, S.H / 2];
    const sc = (z) => [z, 0, 0, z, cx - z * cx, cy - z * cy];
    const mA = sc(Math.exp(Math.log(za) * pe)), mB = sc(Math.exp(Math.log(zb) * (1 - pe)));
    draw(c, A, 1, mA); draw(c, B, sat(pe), mB);
    return { mA, mB };
  },

  /**
   * 穿越式缩放：相机钻进 A 里的一个元素（focus = 名字或屏幕框），B 画在那个元素"里面"，钻到底时 B 正好铺满。
   * log 空间推进（等速感）。clip: 'rect' | 'ellipse' | 'none'；reveal = B 在门框里淡入所占的进度比例（防止 p=0 时 B 突然出现）。
   */
  zoomThrough(c, A, B, pe, { S, opts, recA }) {
    const F = focusBox(need(opts.focus, 'focus（钻进去的那个元素名）', 'zoomThrough'), recA, S, 'A');
    const W = S.W, H = S.H;
    const fw = Math.max(1, F.x1 - F.x0), fh = Math.max(1, F.y1 - F.y0);
    const clip = opts.clip ?? 'rect';
    const Z = Math.max(W / fw, H / fh) * (clip === 'ellipse' ? Math.SQRT2 : 1);   // 门框盖满屏幕需要的倍数（椭圆要再大 √2 才盖住四角）
    const z = Math.exp(Math.log(Z) * pe);
    const [fx, fy] = center(F);
    const s = Z > 1 ? (z - 1) / (Z - 1) : 1;
    const cxp = lerp(fx, W / 2, s), cyp = lerp(fy, H / 2, s);
    const T = [z, 0, 0, z, cxp - z * fx, cyp - z * fy];
    // B 被"画"在 A 世界里以 F 为中心、W/Z × H/Z 的矩形里
    const rw = W / Z, rh = H / Z;
    const R = [rw / W, 0, 0, rh / H, fx - rw / 2, fy - rh / 2];
    const mB = mul(T, R);
    draw(c, A, 1, T);
    c.save();
    if (clip !== 'none') {
      c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
      c.beginPath();
      if (clip === 'ellipse') c.ellipse(fx, fy, fw / 2, fh / 2, 0, 0, Math.PI * 2); else c.rect(F.x0, F.y0, fw, fh);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clip();
    }
    const rv = opts.reveal ?? 0.25;
    c.globalAlpha = rv > 0 ? sat(pe / rv) : 1;
    c.setTransform(mB[0], mB[1], mB[2], mB[3], mB[4], mB[5]);
    c.drawImage(B, 0, 0);
    c.restore();
    return { mA: T, mB };
  },

  /**
   * 甩镜（whip pan）：两镜头沿 dir 高速推移，带**场景内**方向拖影（smear.samples 份沿速度方向的均值）。
   * 拖影长度 = 一帧内位移 × smear.shutter，所以要告诉它 smear.fps。也可以 smear:null 不做，
   * 渲染时 `render.mjs --from a --to b --sub 12 --shutter 0.5` 用真实子帧累积——两条路的代价见 transitions.md。
   */
  whip(c, A, B, pe, info) {
    const { S, opts } = info;
    const [ux, uy] = dirVec(need(opts.dir, 'dir', 'whip'));
    const D = Math.abs(ux) * S.W + Math.abs(uy) * S.H;
    const gap = (opts.gap ?? 0) * D;                // 两镜头之间的空隙（甩过一段"空"）
    const L = D + gap;
    const off = pe * L;
    const sm = opts.smear;
    // 速度（像素 / 秒）：对 pe 的数值导数 × 行程 / 转场时长
    let blurLen = 0;
    if (sm) {
      const fps = need(sm.fps, 'smear.fps', 'whip'), sh = sm.shutter ?? 0.5;
      const e = info.opts.ease ?? null;
      const E = e ? resolveEase(e) : null;
      const p = info.p, dp = 1e-3;
      const v = E ? (E(Math.min(1, p + dp)) - E(Math.max(0, p - dp))) / (Math.min(1, p + dp) - Math.max(0, p - dp)) : 1;
      blurLen = (v * L / Math.max(1e-6, info.dur)) * (sh / fps);
    }
    const mA = [1, 0, 0, 1, ux * off, uy * off];
    const mB = [1, 0, 0, 1, ux * (off - L), uy * (off - L)];
    const fill = () => { if (opts.fill) { c.fillStyle = opts.fill; c.fillRect(0, 0, S.W, S.H); } };
    if (!sm || blurLen < 1) { fill(); draw(c, A, 1, mA); draw(c, B, 1, mB); return { mA, mB }; }
    // 对数步长盒式模糊：第 k 遍把图和自己平移 step·2^k 的副本各取一半 → passes 遍后是 2^passes 个等距抽头，
    // 铺满 blurLen。比逐份叠 N 次便宜得多（N=64 抽头只要 6 遍 × 2 次 drawImage），且不出现分离的残影。
    const passes = Math.max(1, Math.min(8, sm.passes ?? Math.ceil(Math.log2(Math.max(2, sm.samples ?? 64)))));
    const taps = 2 ** passes, step = blurLen / (taps - 1);
    let X = S.layer('whipX'), Y = S.layer('whipY');
    const xc = X.getContext('2d');
    if (opts.fill) { xc.fillStyle = opts.fill; xc.fillRect(0, 0, S.W, S.H); }
    xc.setTransform(1, 0, 0, 1, mA[4], mA[5]); xc.drawImage(A, 0, 0);
    xc.setTransform(1, 0, 0, 1, mB[4], mB[5]); xc.drawImage(B, 0, 0);
    reset(xc);
    for (let k = 0; k < passes; k++) {
      const d = step * 2 ** k;
      const yc = Y.getContext('2d'); reset(yc);
      if (opts.fill) {   // 底先铺 fill：平移露出的边是 0.5·X + 0.5·fill，而不是半透明
        yc.globalCompositeOperation = 'copy'; yc.fillStyle = opts.fill; yc.fillRect(0, 0, S.W, S.H);
        yc.globalCompositeOperation = 'source-over'; yc.drawImage(X, -ux * d, -uy * d);
        yc.globalAlpha = 0.5; yc.drawImage(X, 0, 0);                       // over 不透明底 = 两半各 0.5
      } else {
        yc.clearRect(0, 0, S.W, S.H);
        yc.globalAlpha = 0.5; yc.drawImage(X, 0, 0);
        yc.globalCompositeOperation = 'lighter'; yc.drawImage(X, -ux * d, -uy * d);   // 预乘相加：重合处 α = 1
      }
      [X, Y] = [Y, X];
    }
    draw(c, X, 1, [1, 0, 0, 1, ux * blurLen / 2, uy * blurLen / 2], 'copy');
    if (opts.fill) { // 居中平移后另一侧露出的边
      c.save(); c.globalCompositeOperation = 'destination-over'; c.fillStyle = opts.fill; c.fillRect(0, 0, S.W, S.H); c.restore();
    }
    return { mA, mB };
  },

  /**
   * 故障切：按 rate（次/秒）量化的"故障帧"里，横条带随机错位、随机取 A 或 B（取 B 的概率 = pe），可选 RGB 分离。
   * 随机全部来自 hash01(seed, 故障帧号, 条号) —— 同 t 同像素，乱序求值一致。
   */
  glitch(c, A, B, pe, info) {
    const { S, opts } = info;
    const seed = need(opts.seed, 'seed', 'glitch'), rate = need(opts.rate, 'rate（每秒换几次故障帧）', 'glitch');
    const k = Math.floor((info.p * info.dur) * rate);
    const amp = (opts.shift ?? 0.08) * S.W * Math.sin(Math.PI * info.p) ** (opts.curve ?? 0.5);
    const n = opts.slices ?? 14;
    const src = S.layer('glSrc'); const sc = src.getContext('2d');
    // 条带高度随机，总和 = H
    const hs = Array.from({ length: n }, (_, i) => 0.3 + hash01(seed, k, i, 1));
    const sum = hs.reduce((a, b) => a + b, 0);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const h = (hs[i] / sum) * S.H;
      const useB = hash01(seed, k, i, 2) < pe;
      const dx = (hash01(seed, k, i, 3) - 0.5) * 2 * amp * (hash01(seed, k, i, 4) < 0.6 ? 1 : 0);
      sc.drawImage(useB ? B : A, 0, y, S.W, h + 1, dx, y, S.W, h + 1);
      if (dx > 0) sc.drawImage(useB ? B : A, S.W - dx, y, dx, h + 1, 0, y, dx, h + 1);
      else if (dx < 0) sc.drawImage(useB ? B : A, 0, y, -dx, h + 1, S.W + dx, y, -dx, h + 1);
      y += h;
    }
    const split = (opts.split ?? 0) * S.W * Math.sin(Math.PI * info.p);
    if (split < 0.5) { draw(c, src, 1, null, 'copy'); return {}; }
    c.save(); c.globalCompositeOperation = 'copy'; c.fillStyle = '#000'; c.fillRect(0, 0, S.W, S.H); c.restore();
    const ch = S.layer('glCh', false); const cc = ch.getContext('2d');
    for (const [col, dx] of [['#f00', -split], ['#0f0', 0], ['#00f', split]]) {
      cc.setTransform(1, 0, 0, 1, 0, 0); cc.globalAlpha = 1; cc.globalCompositeOperation = 'copy'; cc.drawImage(src, 0, 0);
      cc.globalCompositeOperation = 'multiply'; cc.fillStyle = col; cc.fillRect(0, 0, S.W, S.H);
      c.save(); c.globalCompositeOperation = 'lighter'; c.drawImage(ch, dx, 0); c.restore();
    }
    return {};
  },

  /**
   * 光晕 / 漏光：叠化，叠化中段整画面过曝（自身的便宜模糊加回去 = bloom）并飘过几团彩色光斑。
   * colors 必给（光斑颜色）；bloom 0..1 为过曝强度；blobs 光斑数；seed 决定光斑路径。
   */
  leak(c, A, B, pe, info) {
    const { S, opts } = info;
    const colors = need(opts.colors, 'colors（漏光颜色数组）', 'leak');
    const seed = need(opts.seed, 'seed', 'leak');
    const bell = Math.sin(Math.PI * sat(info.p)) ** (opts.curve ?? 1.5);
    draw(c, A); draw(c, B, sat(pe));
    const bloom = (opts.bloom ?? 0.6) * bell;
    if (bloom > 0.003) { const bl = cheapBlur(S, c.canvas, opts.blurK ?? 24); draw(c, bl, bloom, null, 'lighter'); }
    const n = opts.blobs ?? 3, W = S.W, H = S.H, R = Math.hypot(W, H);
    c.save(); c.globalCompositeOperation = 'screen';
    for (let i = 0; i < n; i++) {
      const sx = hash01(seed, i, 1), sy = hash01(seed, i, 2), ex = hash01(seed, i, 3), ey = hash01(seed, i, 4);
      const x = lerp(sx, ex, info.p) * W, y = lerp(sy, ey, info.p) * H;
      const r = (0.3 + 0.4 * hash01(seed, i, 5)) * R;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const col = colors[i % colors.length];
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = bell * (opts.intensity ?? 0.8);
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    c.restore();
    return {};
  },

  /**
   * 匹配剪辑辅助：A 结束时的元素 focus 与 B 开始时的同名元素在剪辑点**重合**，剪辑点之后 B 的取景缓回自己的构图。
   * at = 剪辑点在窗口里的比例（硬切发生处），meet = 对齐工作有多少由 A 在切点前做（0 = 全由 B 在切点后做）。
   * blend > 0 时剪辑点前后 blend 比例内叠化（"溶解式匹配"）。fit: 'uniform'（默认，保持比例）| 'fill'。
   */
  match(c, A, B, pe, { S, opts, recA, recB }) {
    const name = need(opts.focus, 'focus（两镜头里同名的元素）', 'match');
    const fa = focusBox(name, recA, S, 'A'), fb = focusBox(name, recB, S, 'B');
    const at = opts.at ?? 0.5, meet = opts.meet ?? 0, blend = opts.blend ?? 0, fit = opts.fit ?? 'uniform';
    // A 侧：切点前把 A 的元素逐步对到"两者之间的会合框"；B 侧：切点后从会合框松回自己的位置
    const meetBox = lerpBox(fa, fb, meet);
    const qa = sat(pe / at), qb = sat((pe - at) / (1 - at));
    const cover = opts.cover !== false;
    const mA = coverClamp(boxToBox(fa, lerpBox(fa, meetBox, qa), fit), S, cover);
    const mB = coverClamp(boxToBox(fb, lerpBox(meetBox, fb, qb), fit), S, cover);
    const before = pe < at;
    if (blend > 0 && Math.abs(pe - at) < blend) {
      const k = sat((pe - (at - blend)) / (2 * blend));
      draw(c, A, 1, mA); draw(c, B, k, mB);
      return { mA, mB };
    }
    if (before) { draw(c, A, 1, mA); return { mA, mB: 'hidden' }; }
    draw(c, B, 1, mB); return { mB, mA: 'hidden' };
  },

  /**
   * 共享元素转场（Keynote Magic Move / PowerPoint 平滑 / CSS View Transitions）：
   * 两个镜头里用 sh.el 登记了**同名**元素的，框从 A 的位置/大小插值到 B 的；其余内容（"根"）用 root 指定的转场。
   * 详见 MAGIC_MOVE 注释与 references/transitions.md §Magic Move。
   */
  magicMove: { custom: magicMove },
};

/**
 * Magic Move 的实现（View Transitions 的分层模型，在 canvas 里做）：
 *  1. 两个镜头各画一遍"根"：sh.el 只记录不画（collect）。只出现在一侧的元素随后补画进该侧的根（跟着根一起退场/入场）。
 *  2. 根层按 root 转场合成（root 必给：'crossfade' / 'push' / 'wipe' ……任何非 magicMove 的转场，参数放 rootOpts）。
 *  3. 同名元素按 B 的绘制顺序画在最上面：
 *     - 两侧都标了 morph:true → 一次绘制：draw(ctx, mixProps(propsA, propsB, q), 插值后的屏幕矩形)，ctx 是屏幕坐标。
 *       位置、大小、颜色、圆角、任意数值 props 一起插值（Keynote "对象"级 Magic Move / PPT 平滑）。
 *     - 否则 → FLIP 快照：旧元素按"旧框 → 当前框"的仿射重放其 draw、新元素按"新框 → 当前框"重放，
 *       两者在一个组层里以 plus-lighter（canvas 的 'lighter'）叠化：重合处不透明度 1-q + q = 1，不出现半透明凹陷
 *       （这是 View Transitions 给 ::view-transition-old/new 默认加 mix-blend-mode: plus-lighter 的原因）。
 *  4. 锚点：同名元素登记插值后的框（不是两边的外包）。
 * 选项：root, rootOpts, fit('fill'|'uniform'), arc（路径弧度：0 直线；正负 = 向哪侧拱，单位是位移长度的比例），
 *       delay(name, i) → [0,1) 本元素晚走的比例（交错），space（颜色插值空间）。
 */
function magicMove(info) {
  const { S, a, b, pe, t, opts } = info;
  const root = need(opts.root, "root（非共享内容怎么过渡：'crossfade' / 'push' / 'wipe' …）", 'magicMove');
  if (root === 'magicMove') throw new Error('magicMove 的 root 不能是 magicMove');
  const LA = S.layer('A'), LB = S.layer('B');
  const allA = S.paintShot(LA, a, t, 'collect'), allB = S.paintShot(LB, b, t, 'collect');
  const recA = allA.filter((r) => r.kind === 'el'), recB = allB.filter((r) => r.kind === 'el');
  const byA = new Map(), byB = new Map();
  for (const r of recA) if (!byA.has(r.name)) byA.set(r.name, r);
  for (const r of recB) if (!byB.has(r.name)) byB.set(r.name, r);
  const replay = (L, r, m = null, alpha = 1) => {
    const x = L.getContext('2d'); x.save();
    const M = m ? mul(m, r.M) : r.M;
    x.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]); x.globalAlpha = alpha * (r.alpha ?? 1);
    r.draw(x, r.props, r.rect); x.restore();
  };
  // 只在一侧的元素补画进那一侧的根
  for (const r of recA) if (!byB.has(r.name)) replay(LA, r);
  for (const r of recB) if (!byA.has(r.name)) replay(LB, r);
  const fx = TRANSITIONS[root];
  if (!fx || fx.custom) throw new Error(`magicMove root「${root}」不可用`);
  reset(S.ctx);
  const rootInfo = { ...info, opts: { ...(opts.rootOpts ?? {}), ease: opts.ease, p: info.p }, recA, recB };
  const rres = fx(S.ctx, LA, LB, pe, rootInfo) ?? {};
  reset(S.ctx);

  const c = S.ctx, fit = opts.fit ?? 'fill', arc = opts.arc ?? 0;
  const shared = recB.filter((r) => byA.has(r.name) && byB.get(r.name) === r);
  const EA = S.layer('mmA', false), EB = S.layer('mmB', false), G = S.layer('mmG', false);
  const out = [];
  shared.forEach((rb, i) => {
    const ra = byA.get(rb.name);
    const d = opts.delay ? sat(opts.delay(rb.name, i)) : 0;
    const q = d > 0 ? resolveEase(opts.ease)(sat((info.p - d) / (1 - d))) : pe;
    let box = lerpBox(ra.box, rb.box, q);
    if (arc) {
      const [ax, ay] = center(ra.box), [bx, by] = center(rb.box);
      const dx = bx - ax, dy = by - ay, k = arc * 4 * q * (1 - q);
      box = { x0: box.x0 - dy * k, x1: box.x1 - dy * k, y0: box.y0 + dx * k, y1: box.y1 + dx * k };
    }
    out.push({ name: rb.name, box });
    if (ra.morph && rb.morph) {
      c.save(); reset(c);
      const props = mixProps(ra.props, rb.props, q, opts.space ?? 'oklab');
      rb.draw(c, props, { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 });
      c.restore();
      return;
    }
    // FLIP 快照叠化（plus-lighter）
    for (const L of [EA, EB, G]) { const x = L.getContext('2d'); reset(x); x.clearRect(0, 0, S.W, S.H); }
    replay(EA, ra, boxToBox(ra.box, box, fit));
    replay(EB, rb, boxToBox(rb.box, box, fit));
    const g = G.getContext('2d');
    g.globalAlpha = 1 - q; g.drawImage(EA, 0, 0);
    g.globalAlpha = q; g.globalCompositeOperation = 'lighter'; g.drawImage(EB, 0, 0);
    reset(g);
    draw(c, G);
  });
  const sharedNames = new Set(out.map((o) => o.name));
  S.registerMM(out, allA.filter((r) => !sharedNames.has(r.name)), allB.filter((r) => !sharedNames.has(r.name)), rres, a, b);
  return { shared: out, root: rres };
}
