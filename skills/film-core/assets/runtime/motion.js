// film-core 运行时 · 运动基元
// 全部是时间的纯函数：不存状态、不读时钟、不做仿真。
// 浏览器 <script type="module"> 和 Node 都能 import。场景写 import './runtime/motion.js'，
// 由 film-core 的服务器挂载（片内 runtime/ 同名文件优先）；交付时冻结进片子。
import { seeded, hash01 } from './rand.js';
export { seeded, hash01 };

export const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, p) => a + (b - a) * p;
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// 把 t 归一化到 [0,1]，用于手写区间
export const norm = (t, from, to) => sat((t - from) / (to - from));

/**
 * 区间进度：ease(sat((t - start) / dur))。dur ≤ 0 时是阶跃（t ≥ start 为 1）。
 * ease 必须是函数（p → 值）：缓动词汇表在 film-motion choreo.js 的 EASE / easeOf，或自己写；这里不替你选。
 * film-motion 的 envelope、film-typography 的 unitProgress 都建在它上面。
 */
export function win(t, start, dur, ease) {
  if (typeof ease !== 'function') throw new Error('win(t, start, dur, ease)：ease 必须是函数（如 choreo.js 的 EASE.cubic.out，或 p => p）');
  if (dur <= 0) return t >= start ? 1 : 0;
  return ease(sat((t - start) / dur));
}

// 循环：让 t = length 的那帧等于 t = 0 的那帧
export const wrap = (t, length) => ((t % length) + length) % length;

// ---------------------------------------------------------------------------
// 弹簧：阻尼振子对单位阶跃的闭式解，0 -> 1
// 方程 x'' + 2ζω x' + ω²x = ω²，初值 x(0)=0, x'(0)=0，ω = √stiffness，ζ = damping / (2ω)
// 闭式解意味着任意 t 可直接求值 —— 这是能跳帧渲染的根本原因。
// ---------------------------------------------------------------------------
const CRIT_EPS = 1e-6; // |ζ-1| 小于它按临界处理：过阻尼公式在 ζ→1 时分母 s1-s2→0，会灾难性抵消

export function settle(t, stiffness = 170, damping = 26) {
  if (t <= 0) return 0;
  const w = Math.sqrt(stiffness);
  const zeta = damping / (2 * w);

  if (Math.abs(zeta - 1) < CRIT_EPS) {
    // 临界阻尼：最快无过冲
    return 1 - Math.exp(-w * t) * (1 + w * t);
  }
  if (zeta < 1) {
    // 欠阻尼：衰减振荡，有过冲
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w * t);
    return 1 - decay * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
  }
  // 过阻尼：两个实根，缓慢逼近
  const r = w * Math.sqrt(zeta * zeta - 1);
  const s1 = -zeta * w + r;
  const s2 = -zeta * w - r;
  return 1 + (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s1 - s2);
}

// 四个起点手感。数字是 springInfo() 实测（ε=0.5%），见 SKILL.md 表格。
// 它们只是起点，不是推荐；本片要什么手感由 style_guide 定，用 spring() 直接按时长/过冲给。
export const SPRING = {
  snappy:  { stiffness: 320, damping: 30 },
  default: { stiffness: 170, damping: 26 },
  heavy:   { stiffness: 90,  damping: 24 },
  playful: { stiffness: 260, damping: 16 },
};

// ---------------------------------------------------------------------------
// 按直觉给弹簧：spring({ duration, overshoot }) -> { stiffness, damping }
//   duration  多少秒后"停下"：此后 |x-1| 永远 ≤ eps（不是包络近似，是数值精确的最后越界时刻）
//   overshoot 过冲比，0 = 临界阻尼（不过冲），0.1 = 冲过终点 10% 的行程，须 < 1
//   eps       "停下"的阈值，占行程的比例，默认 0.005（1080px 行程 ≈ 5px）
//
// 为什么可解：
//   1) 欠阻尼阶跃响应的峰值过冲只取决于 ζ：OS = exp(-ζπ/√(1-ζ²))
//      反解 ζ = -ln(OS) / √(π² + ln²OS)，闭式。
//   2) x(t) 只依赖 ωt（无量纲时间 τ），所以对固定 ζ 的停止时刻 τ*(ζ) 是一个常数，
//      ω = τ*/duration。τ* 用无量纲曲线数值求一次（扫描 + 二分），与 duration 无关。
// ---------------------------------------------------------------------------
export function zetaForOvershoot(overshoot) {
  if (!(overshoot >= 0 && overshoot < 1)) throw new Error(`overshoot 必须在 [0,1)，收到 ${overshoot}`);
  if (overshoot === 0) return 1;
  const L = Math.log(overshoot);
  return -L / Math.sqrt(Math.PI * Math.PI + L * L);
}

// 无量纲（ω=1）下最后一次 |x-1| > eps 的 τ
function settleTau(zeta, eps) {
  const f = (tau) => Math.abs(settle(tau, 1, 2 * zeta) - 1) - eps; // ω=1: stiffness=1, damping=2ζ
  // 包络上界：exp(-ζτ)·(1+τ)/√(1-ζ²) 的保守估计，保证扫描覆盖
  const tMax = Math.max(20, (Math.log(1 / eps) + 10) / Math.max(zeta, 0.01) * 2);
  const dt = 0.002;
  let last = 0;
  for (let tau = dt; tau < tMax; tau += dt) if (f(tau) > 0) last = tau;
  // 在 [last, last+dt] 内二分出越界边界
  let lo = last, hi = last + dt;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return hi;
}

export function spring({ duration, overshoot = 0, eps = 0.005 } = {}) {
  if (!(duration > 0)) throw new Error(`duration 必须 > 0 秒，收到 ${duration}`);
  const zeta = zetaForOvershoot(overshoot);
  const w = settleTau(zeta, eps) / duration;
  return { stiffness: w * w, damping: 2 * zeta * w };
}

// 反过来：给一组 stiffness/damping，报它的实际停止时刻和峰值过冲
export function springInfo({ stiffness, damping }, eps = 0.005) {
  const w = Math.sqrt(stiffness);
  const zeta = damping / (2 * w);
  const overshoot = zeta < 1 ? Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)) : 0;
  return { duration: settleTau(zeta, eps) / w, overshoot, zeta };
}

// 多目标值：首值 + 每次变化叠加一个弹簧。叠加后仍是时间的纯函数。
// stops: [[t, value], ...]，按时间升序
export function follow(t, stops, sp = SPRING.default) {
  let value = stops[0][1];
  for (let n = 1; n < stops.length; n++) {
    const jump = stops[n][1] - stops[n - 1][1];
    value += jump * settle(t - stops[n][0], sp.stiffness, sp.damping);
  }
  return value;
}

// 配方：拉伸的指示条 —— 两条边走不同硬度的弹簧，前缘先冲出去
export function pill(t, stops, width = 120, fast = SPRING.snappy, slow = SPRING.heavy) {
  const a = follow(t, stops, fast);
  const b = follow(t, stops, slow);
  return { left: Math.min(a, b), right: Math.max(a, b) + width };
}

// 配方：变形容器里的文字 —— 等变形开始后才进，下一次变形前离开（时长参数可调）
export function labelAlpha(t, enterAt, exitAt, delay = 0.08, fadeIn = 0.12, fadeOut = 0.1) {
  return Math.min(sat((t - enterAt - delay) / fadeIn), sat((exitAt - fadeOut - t) / fadeOut));
}

// 种子随机 seeded / hash01：实现在 rand.js（全套件唯一一份），这里转出口，方便一行 import。

// ---------------------------------------------------------------------------
// 相机：关键帧 [t, zoom, x, y]，zoom 在 log 空间插值
// （log 空间插值才符合视觉上的"等速推进"：1→2 和 2→4 看起来一样快）
// ---------------------------------------------------------------------------
export function camera(t, keys, sp = SPRING.default) {
  if (keys.length === 1) {
    const [, zoom, x, y] = keys[0];
    return { zoom, x, y };
  }
  const logZoom = follow(t, keys.map(([kt, z]) => [kt, Math.log(z)]), sp);
  return {
    zoom: Math.exp(logZoom),
    x: follow(t, keys.map(([kt, , x]) => [kt, x]), sp),
    y: follow(t, keys.map(([kt, , , y]) => [kt, y]), sp),
  };
}

// 把相机套到 canvas 上下文（画内容前调用，配合 ctx.save/restore）
export function applyCamera(ctx, cam, width, height) {
  ctx.translate(width / 2, height / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-width / 2 - cam.x, -height / 2 - cam.y);
}

// ---------------------------------------------------------------------------
// 节拍栅格：把"第几拍"换成秒。bpm/offset 来自 beats.json（film-narration 产出）
// ---------------------------------------------------------------------------
export function beatGrid(bpm, offset = 0, beatsPerBar = 4) {
  const spb = 60 / bpm;
  return {
    spb,
    at: (beat) => offset + beat * spb,                    // 第 n 拍的时刻
    bar: (bar) => offset + bar * beatsPerBar * spb,       // 第 n 小节
    phase: (t) => wrap((t - offset) / spb, 1),            // 当前拍内进度 0..1
    index: (t) => Math.floor((t - offset) / spb),         // 当前是第几拍
  };
}
