// camrig.js —— 三维镜头运动：按 t 直接求出相机这一帧在哪、看哪、多宽、怎么歪。
//
// 全部是 t 的纯函数（闭式或"加载期建表 + 查表"），可以乱序求值：没有"上一帧的相机"。
// 浏览器和 Node 都能 import（不依赖 three；applyShot 只调用传进来的相机对象的方法；Node 里先 film-core lib/runtime-node.mjs 的
// registerRuntimeResolver()，./rand.js 才解析得到）。
//
// 一个"镜头状态" shot = { pos:[x,y,z], target:[x,y,z], up?:[0,1,0], fov?:度(竖直), roll?:弧度,
//                        shift?:[dx,dy]（主点偏移，像素，+ = 右/下）, near?, far?, focus?:对焦距离 }
// 组合方式就是普通的函数组合：pos 来自 orbit/spline/follow，target 来自 blendTargets，再加 shake。
// 这里没有任何默认运镜——推多快、绕多大、晃多少，是本片 shotlist / style_guide 的事。
//
// 和 2D 相机的关系：
//   - film-core motion.js 的 camera()/applyCamera() 是 2D canvas 的平移缩放；film-motion 的 camera3d.js 是"针孔相机斜看一个平面"，
//     给 2D canvas 投影点用。本文件给 three 的 PerspectiveCamera 用，是完整的六自由度相机。
//   - fromCamera3d(cam, W, H) 把 camera3d 的参数换成等价的 three 镜头：同一组参数下，
//     camera3d.project() 画的 2D 标注和 three 渲出来的 3D 物体逐点对齐（实测误差见仓库 docs/verified/film-webfx.md）。
//     坐标轴映射：camera3d 的 (x, y, z)（y 朝向观众、z 离开平面向上）= three 的 (x, z, y)，用 fromCamera3dPoint()。

import { hash01 } from './rand.js';   // 按 (seed, i) 随机访问（seeded() 是顺序流，不适合按 t 取值）

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, s) => a + (b - a) * s;
const lerpV = (a, b, s) => (typeof a === 'number' ? lerp(a, b, s) : a.map((x, i) => lerp(x, b[i], s)));
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const scl = (a, s) => a.map((x) => x * s);
const len = (a) => Math.hypot(...a);

// ---- 缓动 -------------------------------------------------------------------
export const ease = {
  linear: (p) => p,
  smooth: (p) => p * p * (3 - 2 * p),
  smoother: (p) => p * p * p * (p * (p * 6 - 15) + 10),
  inOut: (k = 3) => (p) => (p < 0.5 ? 0.5 * Math.pow(2 * p, k) : 1 - 0.5 * Math.pow(2 - 2 * p, k)),
  in: (k = 3) => (p) => Math.pow(p, k),
  out: (k = 3) => (p) => 1 - Math.pow(1 - p, k),
  /** CSS cubic-bezier(x1,y1,x2,y2)。固定迭代次数（牛顿 8 次 + 二分兜底 30 次），结果与求值顺序无关 */
  bezier(x1, y1, x2, y2) {
    const bx = (s) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
    const by = (s) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
    const dx = (s) => 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
    return (p) => {
      if (p <= 0) return 0; if (p >= 1) return 1;
      let s = p;
      for (let i = 0; i < 8; i++) { const d = dx(s); if (Math.abs(d) < 1e-7) break; s -= (bx(s) - p) / d; }
      if (!(s >= 0 && s <= 1) || Math.abs(bx(s) - p) > 1e-6) {
        let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { s = (lo + hi) / 2; if (bx(s) < p) lo = s; else hi = s; }
      }
      return by(s);
    };
  },
};
// 按名字取缓动：'in' / 'out' / 'inOut' 是带参数的工厂，名字直接用 = 取它们的默认幂次 3
const EASE_BY_NAME = { linear: ease.linear, smooth: ease.smooth, smoother: ease.smoother, in: ease.in(), out: ease.out(), inOut: ease.inOut() };
const easeOf = (e) => {
  if (typeof e === 'function') return e;
  if (e == null) return ease.linear;
  const f = EASE_BY_NAME[e];
  if (!f) throw new Error(`camrig: 不认识的缓动 ${e}（可用：${Object.keys(EASE_BY_NAME).join(' / ')}，或传函数）`);
  return f;
};

// ---- 关键帧轨道（Theatre.js 的"属性 = 关键帧序列"思路，求值只看 t）----------------
/** track([[t0, v0, 缓动?], [t1, v1, 缓动?], ...]) → f(t)。v 是数或等长数组。
 *  第 i 个关键帧的缓动管 i → i+1 这一段；t 在首帧之前/末帧之后保持端值。 */
export function track(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('camrig.track: 至少一个关键帧 [t, value]');
  const K = keys.map(([t, v, e]) => ({ t, v, e: easeOf(e) }));
  for (let i = 1; i < K.length; i++) if (!(K[i].t > K[i - 1].t)) throw new Error(`camrig.track: 关键帧时刻必须递增（第 ${i} 个 ${K[i].t} ≤ ${K[i - 1].t}）`);
  return (t) => {
    if (t <= K[0].t) return K[0].v;
    if (t >= K[K.length - 1].t) return K[K.length - 1].v;
    let lo = 0, hi = K.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (K[m].t <= t) lo = m; else hi = m; }
    const a = K[lo], b = K[hi];
    return lerpV(a.v, b.v, a.e((t - a.t) / (b.t - a.t)));
  };
}

// ---- 样条路径 ---------------------------------------------------------------
/** 向心 Catmull-Rom（alpha=0.5，不打结、不过冲成环）穿过 points。返回 { at(u), tangent(u), length }，
 *  u ∈ [0,1] **按弧长**：u 匀速走 = 相机匀速。加载期建一张弧长表（samples 段），之后只查表——是常量，不是状态。 */
export function spline(points, { alpha = 0.5, closed = false, samples = 512 } = {}) {
  if (points.length < 2) throw new Error('camrig.spline: 至少两个点');
  const P = points.map((p) => p.slice());
  const n = P.length, segs = closed ? n : n - 1;
  const get = (i) => (closed ? P[((i % n) + n) % n] : i < 0 ? add(P[0], sub(P[0], P[1])) : i >= n ? add(P[n - 1], sub(P[n - 1], P[n - 2])) : P[i]);
  const seg = (i, s) => {   // Barry–Goldman 金字塔形式
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const kn = (a, b) => Math.max(Math.pow(len(sub(b, a)), alpha), 1e-9);
    const t0 = 0, t1 = t0 + kn(p0, p1), t2 = t1 + kn(p1, p2), t3 = t2 + kn(p2, p3);
    const tt = lerp(t1, t2, s);
    const L = (a, b, ta, tb) => lerpV(a, b, (tt - ta) / (tb - ta));
    const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
    const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
    return L(B1, B2, t1, t2);
  };
  const raw = (v) => { const x = clamp01(v) * segs; const i = Math.min(segs - 1, Math.floor(x)); return seg(i, x - i); };
  // 弧长表
  const N = Math.max(16, samples), lut = new Float64Array(N + 1);
  let prev = raw(0), acc = 0;
  for (let k = 1; k <= N; k++) { const q = raw(k / N); acc += len(sub(q, prev)); lut[k] = acc; prev = q; }
  const total = acc;
  const param = (u) => {   // 弧长分数 u → 原始参数 v
    const target = clamp01(u) * total;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lut[m] <= target) lo = m; else hi = m; }
    const span = lut[hi] - lut[lo];
    return (lo + (span > 0 ? (target - lut[lo]) / span : 0)) / N;
  };
  const at = (u) => raw(param(u));
  const tangent = (u, h = 1e-3) => { const a = at(Math.max(0, u - h)), b = at(Math.min(1, u + h)); const d = sub(b, a); const l = len(d) || 1; return scl(d, 1 / l); };
  return { at, tangent, length: total };
}

// ---- 常用机位 ---------------------------------------------------------------
/** 环绕：绕 center 的竖直轴（three 的 +y）转。angle / radius / height 可以是数或 f(t)。返回 f(t) → pos */
export function orbit({ center = [0, 0, 0], radius, height = 0, angle }) {
  const F = (v) => (typeof v === 'function' ? v : () => v);
  const r = F(radius), hgt = F(height), a = F(angle);
  if (radius == null || angle == null) throw new Error('camrig.orbit: radius 与 angle 必填（数或 f(t)）');
  return (t) => { const A = a(t), R = r(t); return [center[0] + R * Math.sin(A), center[1] + hgt(t), center[2] + R * Math.cos(A)]; };
}

/** 推拉：沿 from→target 的视线把相机放在"离 target 的距离 = dist(t)"处。返回 f(t) → pos */
export function dolly({ from, target, dist }) {
  const d0 = sub(from, target), L0 = len(d0), dir = scl(d0, 1 / L0);
  const D = typeof dist === 'function' ? dist : () => dist;
  return (t) => add(target, scl(dir, D(t)));
}

/** 由俯仰/偏航给出看向的点：yaw 绕 +y、pitch 抬头为正（弧度）。返回 target = pos + 方向 × dist */
export function aim(pos, yaw, pitch, dist = 1) {
  const c = Math.cos(pitch);
  return [pos[0] - Math.sin(yaw) * c * dist, pos[1] + Math.sin(pitch) * dist, pos[2] - Math.cos(yaw) * c * dist];
}

/** 跟随：相机跟着 target(t) 走，带"惯性"。惯性不是积分出来的（积分要上一帧），
 *  而是对 target 过去 lag 秒内的轨迹做固定权重的加权平均——任意 t 直接求值，乱序一致。
 *  samples 越多越平滑、越贵（每次求值 samples 次 target 调用）。t-lag 之前的时刻钳在 tMin。 */
export function follow(target, { lag, samples = 12, offset = [0, 0, 0], tMin = 0 }) {
  if (!(lag >= 0)) throw new Error('camrig.follow: lag（秒）必填且 ≥ 0');
  const w = Array.from({ length: samples }, (_, k) => Math.exp((-3 * k) / Math.max(1, samples - 1)));
  const W = w.reduce((a, b) => a + b, 0);
  return (t) => {
    if (lag === 0) return add(target(t), offset);
    let acc = [0, 0, 0];
    for (let k = 0; k < samples; k++) acc = add(acc, scl(target(Math.max(tMin, t - (lag * k) / Math.max(1, samples - 1))), w[k] / W));
    return add(acc, offset);
  };
}

/** 焦点切换：cuts = [[t0, A], [t1, B], ...]，A/B 是点或 f(t)。在每个切点用 dur 秒从上一个过渡到下一个。返回 f(t) → 点 */
export function blendTargets(cuts, { dur = 0.6, ease: e = 'smooth' } = {}) {
  const E = easeOf(e);
  const P = cuts.map(([t, v]) => [t, typeof v === 'function' ? v : () => v]);
  return (t) => {
    let i = 0;
    while (i + 1 < P.length && t >= P[i + 1][0]) i++;
    const cur = P[i][1](t);
    if (i === 0 || dur <= 0) return cur;
    const s = E(clamp01((t - P[i][0]) / dur));
    return s >= 1 ? cur : lerpV(P[i - 1][1](t), cur, s);
  };
}

const vnoise1 = (seed, x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash01(seed, i), hash01(seed, i + 1), u) * 2 - 1; };

/** 手持/震动：三个轴各一条 1D 值噪声（按整数格点哈希，任意 t 直接求值）。
 *  amp 数或 [ax,ay,az]（世界单位），freq（Hz，每秒几个噪声格），octaves 层。返回 f(t) → [dx,dy,dz] */
export function shake({ amp, freq, seed = 1, octaves = 2 }) {
  if (amp == null || freq == null) throw new Error('camrig.shake: amp 与 freq 必填');
  const A = typeof amp === 'number' ? [amp, amp, amp] : amp;
  return (t) => A.map((a, ax) => {
    let s = 0, g = 1, f = freq, norm = 0;
    for (let o = 0; o < octaves; o++) { s += g * vnoise1(seed * 131 + ax * 17 + o * 7919, t * f); norm += g; g *= 0.5; f *= 2.03; }
    return (a * s) / norm;
  });
}

// ---- 落到 three 相机上 ----------------------------------------------------------
/** 把 shot 写进 three 的 PerspectiveCamera。size = { width, height }（舞台像素，createStage3D 的返回就行），
 *  shift 要用到它。返回对焦距离（shot.focus，缺省 = 相机到 target 的距离）——景深用。 */
export function applyShot(camera, shot, size) {
  const { pos, target, up = [0, 1, 0], fov, roll = 0, shift, near, far } = shot;
  if (!pos || !target) throw new Error('camrig.applyShot: shot.pos 与 shot.target 必填');
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.up.set(up[0], up[1], up[2]);
  camera.lookAt(target[0], target[1], target[2]);
  if (roll) camera.rotateZ(roll);
  if (fov != null) camera.fov = fov;
  if (near != null) camera.near = near;
  if (far != null) camera.far = far;
  if (shift && (shift[0] || shift[1])) {
    if (!size) throw new Error('camrig.applyShot: 用 shift 要传 size（舞台宽高）');
    camera.setViewOffset(size.width, size.height, -shift[0], -shift[1], size.width, size.height);
  } else if (camera.view && camera.view.enabled) camera.clearViewOffset();
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return shot.focus ?? len(sub(target, pos));
}

/** film-motion camera3d 的点 (x, y, z) → three 坐标 [x, z, y] */
export const fromCamera3dPoint = ([x, y, z = 0]) => [x, z, y];

/** film-motion camera3d({S, elevation, distance, look, screen, yaw}) → 等价的 shot（three 坐标）。
 *  W/H = 画面像素。camera3d 的注视点落在 screen=[X,Y]，不一定在画面中心 → 用主点偏移（shift）表达。 */
export function fromCamera3d(cam, W, H) {
  const sn = Math.sin(cam.elevation), cs = Math.cos(cam.elevation), d = cam.distance;
  const yaw = cam.yaw ?? 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  const [lx, ly] = cam.look, [px, py] = cam.screen;
  return {
    pos: [lx - sy * cs * d, sn * d, ly + cy * cs * d],
    target: [lx, 0, ly],
    up: [sn * sy, cs, -sn * cy],
    fov: (2 * Math.atan(H / 2 / (cam.S * d)) * 180) / Math.PI,
    shift: [px - W / 2, py - H / 2],
    focus: d,
  };
}

