// 策略 1：闭式解物理。每个函数都是 (t, 参数) -> 状态，没有循环、没有缓存、没有积分。
// 任意 t 直接求值、乱序免费、天然可循环。代价：体与体之间不能碰撞（碰撞是全局耦合）。
// 体与"静态世界"（地面、墙）的碰撞仍可闭式：见 bounce()。
// 随机来自 film-core 的 rand.js（全套件唯一的一份）：hash01(seed, i, k) 计数器式随机访问，
// 第 i 个粒子的第 k 个属性只取决于 (seed, i, k)，不取决于之前求值过多少个数——闭式粒子能 O(在场粒子数) 求值的前提。
import { hash01 } from './rand.js';

// ---------------------------------------------------------------------------
// 弹道：常重力 g，可选线性阻力 k（v' = g - k v）。逐轴独立。
// ---------------------------------------------------------------------------
export function ballistic1(t, x0, v0, g, k = 0) {
  if (k === 0) return x0 + v0 * t + 0.5 * g * t * t;
  const vt = g / k; // 终端速度
  return x0 + vt * t + (v0 - vt) * (1 - Math.exp(-k * t)) / k;
}
export function ballisticV1(t, v0, g, k = 0) {
  if (k === 0) return v0 + g * t;
  const vt = g / k;
  return vt + (v0 - vt) * Math.exp(-k * t);
}
export function ballistic(t, p0, v0, g, k = 0) {
  return {
    x: ballistic1(t, p0.x, v0.x, g.x, k), y: ballistic1(t, p0.y, v0.y, g.y, k),
    vx: ballisticV1(t, v0.x, g.x, k), vy: ballisticV1(t, v0.y, g.y, k),
  };
}

// ---------------------------------------------------------------------------
// 落地弹跳：1D，画布坐标 y 向下，g > 0，地面 floor，恢复系数 e ∈ [0,1)。
// 几何级数求和，O(1) 定位当前是第几跳。返回 lastHit（最近一次触地时刻）
// ——命中反馈（屏震、压扁、音效 cue）都从它派生，仍是纯函数。
// ---------------------------------------------------------------------------
export function bounce(t, y0, v0, g, floor, e = 0.6) {
  // 第一次触地：y0 + v0 τ + ½gτ² = floor
  const d = floor - y0;
  const t1 = (-v0 + Math.sqrt(v0 * v0 + 2 * g * d)) / g;
  if (t < t1) return { y: y0 + v0 * t + 0.5 * g * t * t, vy: v0 + g * t, hits: 0, lastHit: -Infinity, impactSpeed: 0, rest: false };
  const u = e * (v0 + g * t1); // 第一次反弹的上抛速度
  if (u < 1e-9 || e <= 0) return { y: floor, vy: 0, hits: 1, lastHit: t1, impactSpeed: v0 + g * t1, rest: true };
  const s = t - t1;
  const tRest = (2 * u) / (g * (1 - e));
  if (s >= tRest) return { y: floor, vy: 0, hits: Infinity, lastHit: t1 + tRest, impactSpeed: 0, rest: true };
  // 第 n 段飞行开始于 S_n = (2u/g)(1-e^n)/(1-e)
  const n = Math.floor(Math.log(1 - (s * g * (1 - e)) / (2 * u)) / Math.log(e));
  const Sn = ((2 * u) / g) * (1 - Math.pow(e, n)) / (1 - e);
  const un = u * Math.pow(e, n);
  const tau = s - Sn;
  return {
    y: floor - (un * tau - 0.5 * g * tau * tau),
    vy: -(un - g * tau),
    hits: n + 1,
    lastHit: t1 + Sn,
    impactSpeed: un / e, // 本次触地前的下落速度
    rest: false,
  };
}

// ---------------------------------------------------------------------------
// 阻尼振子，带初速度（motion.js 的 settle 是它的特例：x0=0,v0=0,target=1）。
// x'' + c x' + k (x - target) = 0
// ---------------------------------------------------------------------------
export function spring(t, x0, v0, target, k = 170, c = 26) {
  if (t <= 0) return x0;
  const w = Math.sqrt(k), z = c / (2 * w), A = x0 - target;
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return target + Math.exp(-z * w * t) * (A * Math.cos(wd * t) + ((v0 + z * w * A) / wd) * Math.sin(wd * t));
  }
  if (z === 1) return target + Math.exp(-w * t) * (A + (v0 + w * A) * t);
  const r = w * Math.sqrt(z * z - 1), s1 = -z * w + r, s2 = -z * w - r;
  const C2 = (v0 - s1 * A) / (s2 - s1), C1 = A - C2;
  return target + C1 * Math.exp(s1 * t) + C2 * Math.exp(s2 * t);
}

// 单摆（小角度线性化 + 阻尼）。大角度没有初等闭式解，> ~30° 时周期误差 > 2%。
export const pendulum = (t, theta0, omega0, length, g = 9.81, damping = 0) =>
  spring(t, theta0, omega0, 0, g / length, damping);

// 开普勒轨道：牛顿迭代解 M = E - e sinE，固定 8 次迭代（固定次数 = 确定性）。
export function orbit(t, { a, e = 0, period, phase = 0, rot = 0 }) {
  const M = (2 * Math.PI * t) / period + phase;
  let E = e < 0.8 ? M : Math.PI;
  for (let it = 0; it < 8; it++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  return { x: x * cr - y * sr, y: x * sr + y * cr };
}

// ---------------------------------------------------------------------------
// 闭式发射器。粒子 i 出生于 start + i/rate，属性来自 hash01(seed, i mod N, k)。
// emit(t) 只枚举此刻存活的粒子：O(rate × life)，与片长无关。
//   loop:L  → 属性按 i mod (rate·L) 取，t 与 t+L 的帧逐像素相同（首帧=末帧）
//   prewarm → 允许 i < 0，片头就是稳态，不会"空场慢慢长满"
// 位置由调用方用 age 喂给 ballistic() 等函数——发射器只管生命周期。
// ---------------------------------------------------------------------------
export function emitter({ seed = 1, rate = 60, life = 2, lifeJitter = 0, start = 0, end = Infinity, loop = 0, prewarm = false }) {
  const N = loop ? Math.round(rate * loop) : 0;
  if (loop && Math.abs(N - rate * loop) > 1e-9) throw new Error(`emitter: rate*loop 必须是整数（现在 ${rate * loop}），否则循环接缝对不上`);
  const maxLife = life * (1 + lifeJitter);
  return function emit(t) {
    const out = [];
    const iHi = Math.floor((Math.min(t, end) - start) * rate + 1e-9);
    let iLo = Math.ceil((t - maxLife - start) * rate - 1e-9);
    if (!prewarm && !loop) iLo = Math.max(iLo, 0);
    for (let i = iLo; i <= iHi; i++) {
      const born = start + i / rate;
      const key = N ? ((i % N) + N) % N : i;
      const l = life * (1 + lifeJitter * (2 * hash01(seed, key, 999) - 1));
      const age = t - born;
      if (age < 0 || age >= l) continue;
      out.push({ i, key, born, age, life: l, u: age / l, r: (k) => hash01(seed, key, k) });
    }
    return out;
  };
}

// 一次性爆发：count 个粒子同时在 at 出生
export function burst(t, { at, count, life = 1, seed = 1 }) {
  const age = t - at;
  if (age < 0 || age >= life) return [];
  const out = [];
  for (let i = 0; i < count; i++) out.push({ i, key: i, born: at, age, life, u: age / life, r: (k) => hash01(seed, i, k) });
  return out;
}

// 平滑一维噪声（多个带种子相位的正弦相加）。用作"位移场"而不是"力"：
// 雪花摇摆、尘埃漂浮。代价：位移不累积，所以只能做摆动，做不出真正的涡流漂移。
export function wobble(x, seed, octaves = 3) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += amp * Math.sin(x * f + hash01(seed, o, 7) * 6.2832);
    norm += amp; amp *= 0.5; f *= 2.13;
  }
  return v / norm;
}

// ---------------------------------------------------------------------------
// 游戏化反馈。hits 是命中时刻数组（可以来自 bounce().lastHit、来自 narration 的 vo.at()、
// 来自定步仿真记录下的碰撞事件）。全部是 t 的纯函数。
// ---------------------------------------------------------------------------

// 命中屏震：每次命中叠加一段指数衰减的噪声位移。返回 {x,y,rot}
// （film-webfx camrig.js 的 shake() 是持续手持噪声，不是这个；名字分开免得按名字互换）
export function hitShake(t, hits, { amp = 20, decay = 12, freq = 30, rotAmp = 0, seed = 7 } = {}) {
  let x = 0, y = 0, rot = 0;
  for (let h = 0; h < hits.length; h++) {
    const s = t - hits[h];
    if (s < 0 || s > 6 / decay) continue;
    const env = Math.exp(-decay * s);
    x += amp * env * wobble(s * freq, seed + h * 3);
    y += amp * env * wobble(s * freq, seed + h * 3 + 1);
    rot += rotAmp * env * wobble(s * freq, seed + h * 3 + 2);
  }
  return { x, y, rot };
}

// 顿帧（hitstop）：命中后 dur 秒内"世界时间"冻结。返回重映射后的本地时间。
// 用法：const tw = hitstop(t, hits, 0.06); 然后所有物理都用 tw 求值。
// 注意 hits 是在"未冻结的时间"里给出的；若 hits 本身由物理推出，要用迭代或预先算好。
export function hitstop(t, hits, dur = 0.06) {
  let lost = 0;
  for (const h of hits) lost += Math.min(Math.max(t - h, 0), dur);
  return t - lost;
}

// 命中闪白：0..1，命中瞬间 1，按 dur 衰减
export function flash(t, hits, dur = 0.12) {
  let v = 0;
  for (const h of hits) { const s = t - h; if (s >= 0 && s < dur) v = Math.max(v, 1 - s / dur); }
  return v;
}

// 落地压扁：命中后 y 方向缩放的弹簧回弹。strength 通常 ∝ 冲击速度
export function squash(t, lastHit, strength = 0.3, k = 600, c = 18) {
  const s = t - lastHit;
  if (!(s >= 0)) return { sx: 1, sy: 1 };
  const d = spring(s, -strength, 0, 0, k, c);
  return { sx: 1 - d * 0.5, sy: 1 + d };
}

// 拖尾：对任意 pos(t) 函数回采 n 个历史点。闭式下是精确的，不需要存历史。
export function trail(pos, t, n = 8, dt = 1 / 60) {
  const pts = [];
  for (let k = 0; k < n; k++) { const tk = t - k * dt; if (tk < 0) break; pts.push(pos(tk)); }
  return pts;
}
