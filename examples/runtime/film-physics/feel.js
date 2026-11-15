// feel.js —— 相机与物体的"手感"：全部是 t（或事件表 + t）的纯函数，参数显式，没有审美默认值。
//
// 都建在 film-core 的 events.js 上（运行时挂载表扁平解析，所以这里照样写 './events.js'）：事件处跳变 + 事件之间闭式流（piecewise），或线性冲量响应求和（channel + springKick）。
// 输出是数（角度、位移、标量），合成进相机由调用方做：三维走 shot 结构（perturbShot），二维走 film-core 的 camera()。
// 这里不 import film-webfx：perturbShot 只按 shot 的数据约定（pos/target/up/roll）改值，applyShot 由片子自己调用。
import { hash01 } from './rand.js';
import { channel, piecewise, springKick, springParams, holdFallFlow } from './events.js';

const TAU = Math.PI * 2;
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------------------
// 1. 创伤值屏震：振幅 = amp · trauma^power，每轴两个不同频率的正弦（绝对时间 t，天然纯函数）
// ---------------------------------------------------------------------------

/**
 * shakeTermsFromSeed(seed, { band: [loHz, hiHz], second, avoid? }) → { pitch, yaw, roll }，每轴 [[hz, 权重, 相位], [hz, 权重, 相位]]。
 * 第一项权重 1、第二项权重 second；两个频率都在 band 里按 hash 取。
 * avoid = { ratios: [1, 2, …], tol }：两频率之比 max/min 落在某个 ratios[i] ± tol 内就按 hash01(seed, 轴, 1, 1, j) 重抽第二个频率
 *   （j = 1, 2, …，确定性；最多 tries 次，默认 32，抽不到报错——band 太窄放不下）。比值同时检查了 f2/f1 与 f1/f2，所以 0.5 与 2 是同一种情况。
 *   比值≈1 会拍频成一个慢摆、≈小整数会让两项周期性同步，有人觉得"机械"——那是本片的判断，不是套件的：不给 avoid 就不避，
 *   第一次抽到的频率原样用（与给了 avoid 但第一次就合格时相同）。
 */
export function shakeTermsFromSeed(seed, { band, second, avoid = null }) {
  need(Array.isArray(band) && band[1] > band[0] && band[0] > 0, 'shakeTermsFromSeed: band = [低 Hz, 高 Hz]');
  need(second >= 0, 'shakeTermsFromSeed: second（第二个正弦的权重）必填');
  const ratios = avoid?.ratios ?? [], tol = avoid?.tol, tries = avoid?.tries ?? 32;
  if (avoid) need(Array.isArray(ratios) && ratios.every((q) => q >= 1) && tol > 0, 'shakeTermsFromSeed: avoid = { ratios: [≥1 的比值…], tol > 0, tries? }（例：{ ratios: [1, 2], tol: 0.1 }）');
  const at = (u) => band[0] + (band[1] - band[0]) * u;
  const near = (a, b) => { const r = a > b ? a / b : b / a; return ratios.some((q) => Math.abs(r - q) < tol); };
  const out = {};
  ['pitch', 'yaw', 'roll'].forEach((name, ax) => {
    const f1 = at(hash01(seed, ax, 0, 1));
    let f2 = at(hash01(seed, ax, 1, 1));
    for (let j = 1; near(f1, f2); j++) {
      if (j > tries) throw new Error(`shakeTermsFromSeed: band [${band}] 里抽 ${tries} 次都避不开比值 ${ratios.join('/')} ± ${tol}（f1 = ${f1.toFixed(2)} Hz）：放宽 band 或缩小 tol`);
      f2 = at(hash01(seed, ax, 1, 1, j));
    }
    out[name] = [[f1, 1, TAU * hash01(seed, ax, 0, 2)], [f2, second, TAU * hash01(seed, ax, 1, 2)]];
  });
  return out;
}

/**
 * traumaShake(t, trauma, { amp: {pitch, yaw, roll}, terms, power }) → { pitch, yaw, roll }（单位随 amp：弧度或像素）
 *   trauma  0..1 的创伤值（events.js 的 traumaOf(track, …)(t)）
 *   terms   { pitch: [[hz, 权重, 相位], …], … }；给不出就用 shakeTermsFromSeed 派生
 *   power   振幅指数，必填（不给默认）。2 = "创伤值平方"（游戏里常见：小事件几乎看不见、大事件很猛，代价是中等事件也被压得很弱）；
 *           1 = 线性（每个事件都看得见，代价是满创伤值时不再"爆"出来）
 * 与 closed.js 的 hitShake 的区别：hitShake 每次命中各自一条指数包络 × 从命中起算的噪声，线性叠加，命中越多越抖；
 * traumaShake 只有一个全局包络（封顶、线性衰减、再取幂），正弦按绝对时间走，所以连续命中不会让相位重启、也不会无限叠大。
 * 两者可以同时用（例如 hitShake 管物体，traumaShake 管相机）；hitShake 的行为不变。
 */
export function traumaShake(t, trauma, { amp, terms, power }) {
  need(amp && terms, 'traumaShake: amp 与 terms 必填（terms 可用 shakeTermsFromSeed 派生）');
  need(power > 0, 'traumaShake: power 必填（> 0）。2 = 创伤值平方（游戏常见，小事件被压低），1 = 线性');
  const g = Math.pow(Math.max(0, trauma), power);
  const out = { pitch: 0, yaw: 0, roll: 0 };
  if (g === 0) return out;
  for (const ax of ['pitch', 'yaw', 'roll']) {
    const a = amp[ax] ?? 0; if (!a) continue;
    let s = 0;
    for (const [hz, w, ph] of terms[ax] ?? []) s += w * Math.sin(TAU * hz * t + ph);
    out[ax] = a * g * s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 后坐：永久偏移 + 可恢复偏移，快起 – 保持 – 慢收；保持时间被下一发重置（piecewise 精确）
// ---------------------------------------------------------------------------

/**
 * recoil(track, { on, amount, keep, rise, hold, fall, min, max }) → f(t) → { permanent, visual, target, total }
 *   amount  每发的冲量（数或 (e) → 数，可正可负）
 *   keep    0..1：直接计入"永久"（准星、构图的真实偏移，不回来）的比例；其余进可恢复的视觉偏移
 *   rise    视觉偏移跟随目标的时间常数（秒）；hold 每发之后目标保持多久（被下一发重置）；fall 回正的时间常数（秒）
 *   min/max 目标偏移的限幅（可选）
 * 状态在事件处：permanent += keep·a，target = clamp(target + (1−keep)·a)，visual 连续；事件之间是 events.js holdFallFlow 的闭式。
 * 这是"保持被重置"的精确解：连射中目标不衰减，最后一发 hold 之后才回正，和定步模拟一致（夹具 unit.mjs 有对照）。
 */
export function recoil(track, { on, amount, keep, rise, hold, fall, min = -Infinity, max = Infinity }) {
  need(keep >= 0 && keep <= 1 && rise >= 0 && hold >= 0 && fall > 0, 'recoil: keep∈[0,1]、rise ≥ 0、hold ≥ 0、fall > 0 都要给');
  const A = typeof amount === 'function' ? amount : () => amount;
  const f = piecewise(track, {
    on, init: { p: 0, x: 0, b: 0 },
    jump: (s, e) => { const a = A(e); return { p: s.p + keep * a, x: Math.min(max, Math.max(min, s.x + (1 - keep) * a)), b: s.b }; },
    flow: (s, dt) => { const q = holdFallFlow(s.b, s.x, dt, rise, hold, fall); return { p: s.p, x: q.x, b: q.b }; },
    value: (s) => ({ permanent: s.p, visual: s.b, target: s.x, total: s.p + s.b }),
  });
  return f;
}

// ---------------------------------------------------------------------------
// 3. 着陆 / 受力：二阶弹簧下沉（线性叠加）+ 输出限幅
// ---------------------------------------------------------------------------

/**
 * springDip(track, { on, impulse, k, c, min, max, eps }) → f(t)；{k, c} 也可写成 {stiffness, damping}（film-core motion.js 的名字，同义）或 {omega, zeta}
 *   每个事件给弹簧一个初速度 impulse（数或 (e) → 数），响应 Σ impulse·h(τ)，h 是 events.js springKick 的闭式（oscillate 同一份）。
 *   min/max 限幅作用在**输出**上；游戏里常见的"限幅在状态里"（撞到限位后速度也被截）是非线性的，
 *   连续两次大冲量时两者会不同——要严格复现就把这个量放进定步重放。
 */
export function springDip(track, { on, impulse, min = -Infinity, max = Infinity, eps, ...sp }) {
  springParams(sp, 'springDip');   // 校验：缺参数在这里报，不到 springKick 里报
  const h = springKick(sp, eps ? { eps } : undefined);
  const I = typeof impulse === 'function' ? impulse : () => impulse;
  const ch = channel(track, { name: 'springDip', on, response: (tau, e) => I(e) * h(tau), support: h.support });
  const f = (t) => Math.min(max, Math.max(min, ch(t)));
  f.raw = ch; f.kernel = h;
  return f;
}

// ---------------------------------------------------------------------------
// 4. 步幅相位的行走晃动
// ---------------------------------------------------------------------------

/**
 * arcTable(pos, { t0, t1, n }) → { length, s(t), times, lengths }：对 pos(t)（返回数组或 {x,y,z}）均匀采 n+1 点、累计弧长。
 * s(t) 在采样点之间线性插值，区间外夹到端点。加载期建一次，是常量。相机样条直接把它的位置函数传进来。
 */
export function arcTable(pos, { t0, t1, n }) {
  need(t1 > t0 && n >= 1, 'arcTable: t1 > t0、n ≥ 1');
  const times = [], pts = [];
  for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * (i / n); times.push(t); pts.push(pos(t)); }
  return arcFromSamples(pts, times);
}

/** arcFromSamples(points, times?) → 同 arcTable。points 是 [[x,y(,z)]…] 或 [{x,y,z?}…]；times 缺省 = 下标 */
export function arcFromSamples(points, times) {
  need(points.length >= 2, 'arcFromSamples: 至少两个点');
  const T = times ?? points.map((_, i) => i);
  const v = (p) => (Array.isArray(p) ? p : [p.x ?? 0, p.y ?? 0, p.z ?? 0]);
  const S = [0];
  for (let i = 1; i < points.length; i++) {
    const a = v(points[i - 1]), b = v(points[i]);
    let d = 0; for (let j = 0; j < Math.max(a.length, b.length); j++) d += ((b[j] ?? 0) - (a[j] ?? 0)) ** 2;
    S.push(S[i - 1] + Math.sqrt(d));
  }
  const s = (t) => {
    if (t <= T[0]) return 0;
    if (t >= T[T.length - 1]) return S[S.length - 1];
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    return S[lo] + (S[hi] - S[lo]) * ((t - T[lo]) / (T[hi] - T[lo]));
  };
  return { length: S[S.length - 1], s, times: T, lengths: S };
}

/**
 * stepPhase(t, { arc, stride, stops, snapRate }) → 步相位 h（整数 = 一只脚落地）
 *   arc     t → 已走弧长（arcTable(...).s）；stride 一步多长（同单位）
 *   stops   [[停下时刻, 再走时刻], …]（升序，再走可为 Infinity）：停下后相位以速率 snapRate（1/秒）指数吸附到最近的整步，
 *           于是停稳时落在一只脚上；再走之后吸附量作为常数偏移保留，相位连续。
 * 闭式近似：吸附只在停下期间发生（游戏里是每帧按速度判断），停顿短于 1/snapRate 时吸附没走完、按已走的比例保留。
 */
export function stepPhase(t, { arc, stride, stops = [], snapRate = 0 }) {
  need(typeof arc === 'function' && stride > 0, 'stepPhase: arc(t) 与 stride 必填');
  let corr = 0;
  for (const [ts, tg] of stops) {
    if (t <= ts) break;
    const h0 = arc(ts) / stride + corr;
    const c = Math.round(h0) - h0;
    const until = Math.min(t, tg);
    corr += c * (snapRate > 0 ? 1 - Math.exp(-snapRate * (until - ts)) : 0);
  }
  return arc(t) / stride + corr;
}

/**
 * stepBob(h, { vertical, horizontal, roll, accent }) → { y, x, roll }（单位随幅度）
 *   y    = −vertical·cos(2πh) − accent.amp·(½ + ½cos(2πh + accent.phase))^accent.power   （每步一次，落脚处最低）
 *   x    = horizontal·sin(πh)，roll = roll·sin(πh)                                         （两步一个周期，左右脚交替）
 *   accent 是落脚重音：高次幂让每步有一个尖的下沉；power 越大越尖。没给的分量为 0。
 */
export function stepBob(h, { vertical = 0, horizontal = 0, roll = 0, accent = null } = {}) {
  let y = -vertical * Math.cos(TAU * h);
  if (accent) { need(accent.amp != null && accent.power > 0, 'stepBob: accent = {amp, power, phase?}'); y -= accent.amp * Math.pow(0.5 + 0.5 * Math.cos(TAU * h + (accent.phase ?? 0)), accent.power); }
  return { y, x: horizontal * Math.sin(Math.PI * h), roll: roll * Math.sin(Math.PI * h) };
}

// ---------------------------------------------------------------------------
// 5. 次级运动
// ---------------------------------------------------------------------------

/**
 * lagOffset(t, pos, { k, c, span, steps }) → 子物体相对父物体的偏移（一个轴；多轴各调一次）
 *   子物体用弹簧 (k, c) 挂在父物体上：y'' + c y' + k y = −a_父(t)，零初态的解 y(t) = −∫₀^span a(t−u)·h(u) du（h = springKick）。
 *   a 由 pos 的中心差分得到，积分用 Simpson，steps 段（偶数）。span 取 h.support 足够；比它短会截掉尾巴。
 *   代价 O(steps)/次/轴；父物体运动由离散冲量（速度跳变）组成时，改用 channel(track, {response: (τ,e) => −e.dv·h(τ)}) 精确且更省。
 */
export function lagOffset(t, pos, { span, steps, ...sp }) {
  need(span > 0 && steps >= 2, 'lagOffset: k、c（或 stiffness、damping）、span、steps 必填');
  const N = steps + (steps % 2), du = span / N, h = springKick(sp);
  const acc = (x) => (pos(x + du) - 2 * pos(x) + pos(x - du)) / (du * du);
  let s = 0;
  for (let i = 0; i <= N; i++) { const w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2; s += w * acc(t - i * du) * h(i * du); }
  return -s * du / 3;
}

/** drift(t, terms) = Σ amp·sin(2π·hz·t + phase)：呼吸、手持漂移这类低频多正弦。terms = [[amp, hz, phase], …] */
export function drift(t, terms) {
  let v = 0; for (const [a, hz, ph = 0] of terms) v += a * Math.sin(TAU * hz * t + ph); return v;
}
/** driftTerms(seed, n, { amp, band, falloff }) → terms：第 j 项频率在 band 里按 hash 取、幅度 amp·falloff^j、相位按 hash */
export function driftTerms(seed, n, { amp, band, falloff = 1 }) {
  need(amp != null && Array.isArray(band), 'driftTerms: amp 与 band 必填');
  return Array.from({ length: n }, (_, j) => [amp * Math.pow(falloff, j), band[0] + (band[1] - band[0]) * hash01(seed, j, 11), TAU * hash01(seed, j, 12)]);
}

// ---------------------------------------------------------------------------
// 6. 时间重映射与状态过渡
// ---------------------------------------------------------------------------

/**
 * cruise(u, soft, ease) = soft·ease(u) + (1−soft)·u：基本匀速、两端柔化。soft=0 纯匀速，1 纯 ease。
 * ease 缺省 smoothstep（3p²−2p³，两端速度为 0、中段最快 1.5 倍）：代价是起停对称，要"慢起快停"这类不对称手感就自己传 ease。
 */
export function cruise(u, soft, ease = (p) => p * p * (3 - 2 * p)) {
  need(soft >= 0 && soft <= 1, 'cruise: soft ∈ [0,1] 必填');
  const p = u < 0 ? 0 : u > 1 ? 1 : u;
  return soft * ease(p) + (1 - soft) * p;
}

/**
 * approach(track, { on, init, target, rate }) → f(t)：状态事件改目标值，量以速率 rate（1/秒，可为 (e) → 数）指数逼近。
 * v(t) = g_k + (v_k − g_k)·e^(−rate·(t − t_k))。饱和度、暗场、音乐闪避量这类"进入某状态就慢慢过去"的标量。
 */
export function approach(track, { on, init, target, rate }) {
  need(Number.isFinite(init) && target != null && rate != null, 'approach: init、target、rate 必填');
  const G = typeof target === 'function' ? target : () => target;
  const R = typeof rate === 'function' ? rate : () => rate;
  return piecewise(track, {
    on, init: { v: init, g: init, r: 0 },
    jump: (s, e) => ({ v: s.v, g: G(e), r: R(e) }),
    flow: (s, dt) => ({ v: s.g + (s.v - s.g) * Math.exp(-s.r * dt), g: s.g, r: s.r }),
    value: (s) => s.v,
  });
}

// ---------------------------------------------------------------------------
// 7. 合成进相机（只改数据，不调用任何渲染库）
// ---------------------------------------------------------------------------
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function rot(v, k, a) { // Rodrigues：v 绕单位轴 k 转 a 弧度
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * d * (1 - c));
}

/**
 * perturbShot(shot, { pitch, yaw, roll, offset }) → 新 shot（camrig 的 shot 约定：pos、target、up?、roll?……其余字段原样保留）
 *   pitch > 0 抬头、yaw > 0 向左转（绕 up）、roll 加到 shot.roll（弧度）；offset [dx,dy,dz] 同时平移 pos 与 target（世界单位）。
 *   视线绕相机位置转，所以注视距离不变、景深的 focus 不受影响。
 */
export function perturbShot(shot, { pitch = 0, yaw = 0, roll = 0, offset = null } = {}) {
  const up = norm3(shot.up ?? [0, 1, 0]);
  let dir = sub3(shot.target, shot.pos);
  if (yaw) dir = rot(dir, up, yaw);
  if (pitch) dir = rot(dir, norm3(cross(dir, up)), pitch);
  const pos = offset ? add3(shot.pos, offset) : shot.pos.slice();
  return { ...shot, pos, target: add3(pos, dir), roll: (shot.roll ?? 0) + roll };
}
