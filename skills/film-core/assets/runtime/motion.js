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

// ---------------------------------------------------------------------------
// 镜头组合子：把"第几秒归哪个镜头、镜头内走到哪"从手写 if 里拿出来（Remotion Sequence/Series/Loop/Freeze 的纯函数版）。
// 只管时间，不管怎么画、怎么转场：转场 kind、缓动、离屏合成在 film-motion 的 timeline()/createStage()。
// 全部在加载时建一次，seek 里只查表。
// ---------------------------------------------------------------------------

/**
 * sequence(list, { start, end, overlap, align, marks }) → Q
 *   list 每项 { name, dur } 或 { name, until }（可带任意自定义字段，比如 paint；可带 overlap/align 覆盖它**结尾那个边界**）
 *     dur    这个镜头的名义时长（秒）
 *     until  名义终点的绝对时刻：数字（vo.at('字')、beat.bar(4)）或字符串（交给 marks 解析）
 *     最后一项两者都不给时，终点取 end
 *   overlap  边界处的交棒时长（秒，默认 0 = 硬切）。窗口 = [边界 − align·overlap, 边界 + (1−align)·overlap]，窗口内两个镜头都活着
 *   align    0..1（默认 0.5 骑在边界上；1 = 交棒在边界时刻完成；0 = 从边界开始）
 *   marks    具名时刻表：对象 { 名: 秒 } 或函数 名 → 秒（如 (w) => vo.at(w)）
 *
 * Q.at(t) → [{ name, index, shot, local, progress, enter, exit }]（按镜头顺序；t 在片外时夹到首/末镜头）
 *   local     从这个镜头第一帧可见算起的秒数（交棒窗口的起点算 0）
 *   progress  名义区间内的进度 sat((t − 名义起点) / 名义时长)
 *   enter     入场窗口的线性进度 0..1（没有交棒时恒为 1）；exit 出场窗口的线性进度（不在出场时为 0）。要缓动自己套
 * Q.cuts      硬切时刻（overlap = 0 的边界），直接 window.CUTS = Q.cuts
 * Q.boundaries 全部名义边界；Q.windows [{label, start, end, cut}]（交棒窗口，格式同 window.CUT_WINDOWS）；Q.marks [{label, start, end}]（给 window.MARKS）
 * Q.bounds(name) → { start, end, cutIn, cutOut }；Q.list、Q.start、Q.end、Q.duration
 * 校验不过就抛错：边界必须严格递增、有限；窗口不能越过相邻镜头的名义边界。
 */
export function sequence(list, { start = 0, end, overlap = 0, align = 0.5, marks } = {}) {
  if (!Array.isArray(list) || !list.length) throw new Error('sequence: 至少一个镜头 { name, dur | until }');
  const resolve = (v, i) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const x = typeof marks === 'function' ? marks(v) : marks?.[v];
      if (!Number.isFinite(x)) throw new Error(`sequence: 第 ${i} 项的 until「${v}」在 marks 里找不到（或不是有限数）`);
      return x;
    }
    return null;
  };
  const c = [start];
  list.forEach((it, i) => {
    let e = resolve(it.until, i);
    if (e == null && it.dur != null) e = c[i] + it.dur;
    if (e == null && i === list.length - 1 && end != null) e = end;
    if (e == null) throw new Error(`sequence: 第 ${i} 项（${it.name ?? '#' + i}）要给 dur 或 until`);
    if (!Number.isFinite(e) || !(e > c[i])) throw new Error(`sequence: 边界必须严格递增且有限，第 ${i} 项止于 ${e}，起点 ${c[i]}`);
    c.push(e);
  });
  const n = list.length, T1 = c[n];
  if (end != null && Math.abs(end - T1) > 1e-9) throw new Error(`sequence: 镜头表止于 ${T1}，与 end=${end} 不一致`);
  const names = new Set();
  const wins = [];
  for (let k = 0; k < n - 1; k++) {
    const o = list[k].overlap ?? overlap, al = list[k].align ?? align;
    if (!(o >= 0) || !(al >= 0 && al <= 1)) throw new Error(`sequence: 边界 ${k} 的 overlap 要 ≥ 0、align 在 [0,1]`);
    const w0 = c[k + 1] - al * o, w1 = c[k + 1] + (1 - al) * o;
    if (w0 < c[k] - 1e-9 || w1 > c[k + 2] + 1e-9) throw new Error(`sequence: 边界 ${c[k + 1]} 的交棒窗口 [${w0}, ${w1}] 越过了相邻镜头的名义边界`);
    wins.push({ w0, w1, cut: c[k + 1], o });
  }
  const shots = list.map((it, k) => {
    const name = it.name ?? `#${k}`;
    if (names.has(name)) throw new Error(`sequence: 镜头名「${name}」重复`);
    names.add(name);
    const s = { name, index: k, shot: it, cutIn: c[k], cutOut: c[k + 1],
      start: k ? wins[k - 1].w0 : c[0], enterEnd: k ? wins[k - 1].w1 : c[0],
      exitStart: k < n - 1 ? wins[k].w0 : T1, end: k < n - 1 ? wins[k].w1 : T1 };
    s.dur = s.end - s.start;
    return s;
  });
  const entry = (s, t) => ({
    name: s.name, index: s.index, shot: s.shot, local: t - s.start,
    progress: sat((t - s.cutIn) / (s.cutOut - s.cutIn)),
    enter: s.enterEnd > s.start ? sat((t - s.start) / (s.enterEnd - s.start)) : 1,
    exit: s.end > s.exitStart ? sat((t - s.exitStart) / (s.end - s.exitStart)) : 0,
  });
  const byName = new Map(shots.map((s) => [s.name, s]));
  return {
    list: shots, start, end: T1, duration: T1 - start,
    boundaries: c.slice(1, -1),
    cuts: wins.filter((w) => w.o === 0).map((w) => w.cut),
    windows: wins.filter((w) => w.o > 0).map((w, i) => ({ label: `${shots.find((s) => s.cutOut === w.cut).name}→${shots.find((s) => s.cutIn === w.cut).name}`, start: w.w0, end: w.w1, cut: w.cut })),
    marks: shots.map((s) => ({ label: s.name, start: s.cutIn, end: s.cutOut })),
    bounds(name) {
      const s = byName.get(name);
      if (!s) throw new Error(`sequence: 没有镜头「${name}」`);
      return { start: s.start, end: s.end, cutIn: s.cutIn, cutOut: s.cutOut };
    },
    at(t) {
      if (t < shots[0].start) return [entry(shots[0], t)];
      if (t >= T1) return [entry(shots[n - 1], t)];
      const out = [];
      for (const s of shots) if (t >= s.start && t < s.end) out.push(entry(s, t));
      return out;
    },
  };
}

/**
 * series(durations, start = 0) → { cuts, end, duration, at(t) → { index, local, progress } }
 * 首尾相接的一串时长（镜头内的小节、逐条出现的列表），只有一个活跃段；t 在外面时夹到首/末段（local 不夹）。
 * 有名字、要交棒、边界要引用旁白时刻时用 sequence。
 */
export function series(durations, start = 0) {
  if (!Array.isArray(durations) || !durations.length || !durations.every((d) => d > 0 && Number.isFinite(d)))
    throw new Error('series: durations 必须是非空的正数数组');
  const b = [start];
  for (const d of durations) b.push(b[b.length - 1] + d);
  const n = durations.length;
  return {
    cuts: b.slice(1, -1), end: b[n], duration: b[n] - start,
    at(t) {
      let k = 0;
      while (k < n - 1 && t >= b[k + 1]) k++;
      return { index: k, local: t - b[k], progress: sat((t - b[k]) / durations[k]) };
    },
  };
}

/** 局部时间循环：from 之前停在 0；每 period 秒绕回；循环满 times 次后停在 period（最后一帧）。 */
export function loopT(t, period, { from = 0, times = Infinity } = {}) {
  if (!(period > 0)) throw new Error('loopT: period 必须 > 0');
  const l = t - from;
  if (l <= 0) return 0;
  if (l >= period * times) return period;
  return l - Math.floor(l / period) * period;
}

/** 变速：from + (t − from)·k。k = 0.5 慢放、2 快放、−1 倒放（from 处时间连续）。 */
export const rate = (t, k, from = 0) => from + (t - from) * k;

/** 定格：t 走到 at 后停 dur 秒，再接着走（之后整体晚 dur 秒）；dur 省略 = 从 at 起永远停住。 */
export function freeze(t, at, dur = Infinity) {
  if (t < at) return t;
  if (t < at + dur) return at;
  return t - dur;
}
