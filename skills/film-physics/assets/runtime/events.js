// events.js —— 事件表 → 多通道响应。一个事件同时驱动光、粒子、镜头、声音，各通道用自己的时间常数。
//
// 纯函数视频里的写法：一张事件时刻表（加载期排好、补 id、建索引，之后是常量）+ 每个通道写成
// "自事件起经过时间 τ 的闭式函数"，求值时对窗口内的事件求和 / 取最大 / 取最近。
// 节流、帧对齐、连射结束补尾音这些"有记忆"的规则在加载期对整张表做一次，结果只取决于事件表。
// 非线性但"事件之间有闭式流"的量（创伤值封顶、保持时间被下一发重置的后坐、状态过渡）用 piecewise()：
// 加载期单遍扫描算出每个事件刚发生后的状态，求值时二分找到最近事件、再走一段闭式流。O(log n)。
//
// 随机：每个事件按 hash01(seed, e.key, 通道名的整数键, k) 随机访问（不是顺序流）。
// 只依赖 film-core 的 rand.js；浏览器与 Node 都能 import。没有任何幅度、颜色、时长的默认值——那是本片 style_guide 的事。
import { hash01 } from './rand.js';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 字符串 → int32（FNV-1a）。hash01 只吃整数键（内部做 k|0），字符串名字先过它。 */
export function keyOf(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v | 0;
  const s = String(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

// 有序数组上的二分：第一个 > x（upper）/ 第一个 ≥ x（lower）的下标
function upper(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
function lower(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

function matcher(on) {
  if (on == null) return () => true;
  if (typeof on === 'function') return on;
  if (typeof on === 'string') return (e) => e.type === on;
  if (Array.isArray(on)) { const S = new Set(on); return (e) => S.has(e.type); }
  throw new Error('events: on 要是类型名、类型名数组或 (e) => boolean');
}

const isTrack = (x) => x && x.__eventTrack === true;

// ---------------------------------------------------------------------------
// 事件表
// ---------------------------------------------------------------------------

/**
 * eventTrack(events) → track。events 是 [{ t, type, id?, ...任意字段 }] 或另一个 track。
 * 加载期：校验 t 有限、按 t 稳定排序（同刻按原顺序）、补 id（缺省 `${type}#${本类型内第几个}`，按原表顺序计数，
 * 所以给别的类型加事件不会让这个类型的 id 变）、算 key = keyOf(id)、按类型建索引。事件对象被冻结。
 * 时刻约定："t 之前" = t_e ≤ t（事件当帧 τ = 0 就算发生）。
 */
export function eventTrack(events) {
  const src = isTrack(events) ? events.events : events;
  if (!Array.isArray(src)) throw new Error('eventTrack: 要一个数组 [{t, type, ...}]');
  const perType = new Map();
  const tmp = src.map((e, i) => {
    if (!e || !Number.isFinite(e.t)) throw new Error(`eventTrack: 第 ${i} 个事件的 t 不是有限数（${e && e.t}）——vo.at 没找到字时常见`);
    const type = e.type ?? 'event';
    const n = perType.get(type) ?? 0; perType.set(type, n + 1);
    const id = e.id ?? `${type}#${n}`;
    return { e, i, type, id };
  });
  tmp.sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  const seen = new Set();
  const list = tmp.map(({ e, type, id }, index) => {
    if (seen.has(id)) throw new Error(`eventTrack: id「${id}」重复（随机键和派生事件靠它区分）`);
    seen.add(id);
    return Object.freeze({ ...e, t: e.t, type, id, key: keyOf(id), index });
  });
  const times = Float64Array.from(list, (e) => e.t);
  const byType = new Map();
  for (const e of list) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(e); }
  const typeIdx = new Map([...byType].map(([k, es]) => [k, { events: es, times: Float64Array.from(es, (e) => e.t) }]));
  const sel = (type) => (type == null ? { events: list, times } : typeIdx.get(type) ?? { events: [], times: new Float64Array(0) });

  return Object.freeze({
    __eventTrack: true,
    events: list, times, length: list.length,
    types: [...byType.keys()],
    /** 某类型的全部事件（加载期数组，只读） */
    of: (type) => sel(type).events,
    /** 过滤出一张新表（id/key 保留，所以随机数不变） */
    only: (on) => eventTrack(list.filter(matcher(on))),
    /** t 之前（t_e ≤ t）的事件，按时间升序 */
    before(t, type) { const s = sel(type); return s.events.slice(0, upper(s.times, t)); },
    /** t 之前一共发生了几次：O(log n) */
    count(t, type) { return upper(sel(type).times, t); },
    /** t 之前最近的一个，没有返回 null */
    last(t, type) { const s = sel(type); const k = upper(s.times, t) - 1; return k >= 0 ? s.events[k] : null; },
    /** t 之后（t_e > t）的第一个，没有返回 null */
    next(t, type) { const s = sel(type); const k = upper(s.times, t); return k < s.events.length ? s.events[k] : null; },
    /** (t − span, t] 内的事件 */
    window(t, span, type) { const s = sel(type); return s.events.slice(upper(s.times, t - span), upper(s.times, t)); },
  });
}

/** 合并几张表 / 数组成一张（id 必须不冲突；派生事件的 id 由派生函数保证带前缀） */
export function merge(...parts) {
  return eventTrack(parts.flatMap((p) => (isTrack(p) ? p.events : p)).map(({ key, index, ...e }) => e));
}

// ---------------------------------------------------------------------------
// 通道：对窗口内事件的响应求和 / 取最大 / 取最近
// ---------------------------------------------------------------------------

/**
 * channel(track, { name, on, response, support, lead, combine, seed }) → ch(t)
 *   on        哪些事件驱动这个通道（类型名 / 数组 / 谓词），加载期过滤一次
 *   response  (τ, e, rnd) → 数。τ = t − e.t；rnd(k) = hash01(seed, e.key, keyOf(name), k)，随机访问
 *   support   响应的支撑时长（秒），数或 (e) → 数；τ ≥ support 当 0。缺省读 response.support（下面的核都带）
 *   lead      允许"事件之前"就开始响应的秒数（预备动作、高斯脉冲的前半），缺省读 response.lead 或 0
 *   combine   'sum'（线性叠加）| 'max'（取最亮，不叠爆）| 'last'（只看最近一个活着的事件）| { init, add(acc, v, e, τ) }
 *   name/seed 随机键：同名通道拿到同一组随机数（相关）；要独立就换名字
 * 复杂度：每次求值 O(log n + 窗口内事件数)；窗口 = [t − max support, t + lead]，二分定位。
 * support 为 Infinity 时窗口是"之前全部"，那就是 O(n)——累积量改用 piecewise()。
 * ch.active(t) → [{ e, tau, rnd }]：窗口内活着的事件（画每个事件自己的粒子爆发时用）。
 */
export function channel(track, { name = 'channel', on, response, support, lead, combine = 'sum', seed = 0 } = {}) {
  if (typeof response !== 'function') throw new Error('channel: response(τ, e, rnd) 必填');
  const T = isTrack(track) ? track : eventTrack(track);
  const evs = T.events.filter(matcher(on));
  const times = Float64Array.from(evs, (e) => e.t);
  const sup = support ?? response.support;
  if (sup == null) throw new Error(`channel「${name}」: 给 support（秒），或用带 .support 的核`);
  const supOf = typeof sup === 'function' ? sup : () => sup;
  let maxSup = 0;
  for (const e of evs) { const s = supOf(e); if (!(s >= 0)) throw new Error(`channel「${name}」: support 必须 ≥ 0（事件 ${e.id} 得到 ${s}）`); if (s > maxSup) maxSup = s; }
  const ld = lead ?? response.lead ?? 0;
  const ck = keyOf(name);
  const rndOf = (e) => (k) => hash01(seed, e.key, ck, k);
  const red = typeof combine === 'object' ? combine
    : combine === 'sum' ? { init: 0, add: (a, v) => a + v }
    : combine === 'max' ? { init: -Infinity, add: (a, v) => (v > a ? v : a), done: (a) => (a === -Infinity ? 0 : a) }
    : combine === 'last' ? null
    : (() => { throw new Error(`channel「${name}」: combine 只认 sum / max / last / {init, add}`); })();

  function range(t) { return [lower(times, t - maxSup), upper(times, t + ld)]; }
  function alive(e, t) { const tau = t - e.t; return tau >= -ld && tau < supOf(e) ? tau : null; }

  const ch = (t) => {
    const [i0, i1] = range(t);
    if (!red) { // last：从最近的往回找第一个活着的
      for (let i = i1 - 1; i >= i0; i--) { const e = evs[i], tau = alive(e, t); if (tau !== null) return response(tau, e, rndOf(e)); }
      return 0;
    }
    let acc = red.init;
    for (let i = i0; i < i1; i++) { const e = evs[i], tau = alive(e, t); if (tau !== null) acc = red.add(acc, response(tau, e, rndOf(e)), e, tau); }
    return red.done ? red.done(acc) : acc;
  };
  ch.active = (t) => { const [i0, i1] = range(t); const out = []; for (let i = i0; i < i1; i++) { const e = evs[i], tau = alive(e, t); if (tau !== null) out.push({ e, tau, rnd: rndOf(e) }); } return out; };
  ch.events = evs; ch.support = maxSup; ch.lead = ld; ch.channelName = name;
  return ch;
}

// ---------------------------------------------------------------------------
// 响应核：全部闭式、τ < 0 时为 0（高斯除外，它带 .lead）、带 .support（之后恒为 0 或小于 eps）
// ---------------------------------------------------------------------------
const kernel = (f, support, lead = 0) => Object.assign(f, { support, lead });

/** 线性衰减闪：τ=0 时 1，dur 秒线性降到 0。动态光、闪白的"剩余/总时长"写法 */
export function flashDecay(dur) {
  if (!(dur > 0)) throw new Error('flashDecay(dur): dur 必须 > 0');
  return kernel((tau) => (tau < 0 || tau >= dur ? 0 : 1 - tau / dur), dur);
}

/** 平方根熄灭：√(1 − τ/dur)。先亮着、到尾巴骤然熄灭（枪口火光的写法） */
export function sqrtFade(dur) {
  if (!(dur > 0)) throw new Error('sqrtFade(dur): dur 必须 > 0');
  return kernel((tau) => (tau < 0 || tau >= dur ? 0 : Math.sqrt(1 - tau / dur)), dur);
}

/** 指数衰减：e^(−rate·τ)。support = ln(1/eps)/rate（eps 是截断阈值，技术量，不是手感） */
export function expDecay(rate, { eps = 1e-4 } = {}) {
  if (!(rate > 0)) throw new Error('expDecay(rate): rate 必须 > 0（1/秒）');
  return kernel((tau) => (tau < 0 ? 0 : Math.exp(-rate * tau)), Math.log(1 / eps) / rate);
}

/** 高斯脉冲：exp(−½((τ − at)/width)²)。at 可以是 0（峰值就在事件上，前半段靠 .lead 在事件前开始） */
export function gaussPulse({ at, width }) {
  if (!(width > 0) || !Number.isFinite(at)) throw new Error('gaussPulse({at, width}): width > 0、at 有限');
  return kernel((tau) => { const u = (tau - at) / width; return Math.abs(u) > 4 ? 0 : Math.exp(-0.5 * u * u); }, at + 4 * width, Math.max(0, 4 * width - at));
}

/**
 * 阻尼弹簧的单位速度冲量响应 h(τ)：x'' + c x' + k x = 0，x(0)=0，x'(0)=1。
 * 线性系统：一串冲量 v_k 的响应 = Σ v_k·h(τ_k)（channel 的 sum 就是精确解，不是近似）。
 *   欠阻尼 ζ<1：e^(−ζωτ)·sin(ω_d τ)/ω_d；临界：τ e^(−ωτ)；过阻尼：(e^(s1 τ) − e^(s2 τ))/(s1 − s2)
 * 参数给 {k, c} 或 {omega, zeta}（ω = √k，ζ = c/(2ω)）。support：包络降到 eps/ω 以下的时刻。
 * kernel.velocity(τ) 是 h'(τ)（要速度的通道用，例如按速度拉伸的拖尾）。
 */
export function springKick(p, { eps = 1e-4 } = {}) {
  const w = p.omega ?? Math.sqrt(p.k), z = p.zeta ?? p.c / (2 * Math.sqrt(p.k));
  if (!(w > 0) || !(z >= 0)) throw new Error('springKick: 给 {k, c} 或 {omega, zeta}，k > 0、c ≥ 0');
  let f, v, sup;
  if (Math.abs(z - 1) < 1e-6) {
    f = (tau) => tau * Math.exp(-w * tau);
    v = (tau) => (1 - w * tau) * Math.exp(-w * tau);
    let lo = 1 / w, hi = 1 / w; while (hi * Math.exp(-w * hi) > eps / w) hi *= 2;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (m * Math.exp(-w * m) > eps / w) lo = m; else hi = m; }
    sup = hi;
  } else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z), a = z * w;
    f = (tau) => Math.exp(-a * tau) * Math.sin(wd * tau) / wd;
    v = (tau) => Math.exp(-a * tau) * (Math.cos(wd * tau) - (a / wd) * Math.sin(wd * tau));
    sup = z === 0 ? Infinity : Math.log(w / (eps * wd)) / a; // |h| ≤ e^(−aτ)/ω_d < eps/ω
  } else {
    const r = w * Math.sqrt(z * z - 1), s1 = -z * w + r, s2 = -z * w - r, d = s1 - s2;
    f = (tau) => (Math.exp(s1 * tau) - Math.exp(s2 * tau)) / d;
    v = (tau) => (s1 * Math.exp(s1 * tau) - s2 * Math.exp(s2 * tau)) / d;
    sup = Math.log(w / (eps * d)) / -s1; // |h| ≤ e^(s1 τ)/d
  }
  sup = Math.max(sup, 0);
  const k = kernel((tau) => (tau < 0 ? 0 : f(tau)), sup);
  k.velocity = (tau) => (tau < 0 ? 0 : v(tau));
  k.omega = w; k.zeta = z;
  return k;
}

/**
 * 快起 – 保持 – 慢收（单个事件的线性响应，峰值 1）。两级：目标 x 在 τ=0 跳到 1、保持 hold 秒后以时间常数 fall 指数回零；
 * 看到的量 b 以时间常数 rise 一阶跟随 x。rise=0 时 b ≡ x。
 *   τ ≤ hold：b = 1 − e^(−τ/rise)
 *   τ > hold：u = τ − hold，b_h = 1 − e^(−hold/rise)，p = 1/rise，r = 1/fall，
 *             b = b_h e^(−pu) + p/(p − r)·(e^(−ru) − e^(−pu))（p = r 时第二项为 p·u·e^(−pu)）
 * 多个事件按线性叠加是"每发各自保持"；游戏里"保持被下一发重置"是非线性的，用 feel.js 的 recoil()（piecewise 精确扫描）。
 */
export function riseHoldFall({ rise, hold, fall }, { eps = 1e-4 } = {}) {
  if (!(rise >= 0) || !(hold >= 0) || !(fall > 0)) throw new Error('riseHoldFall({rise, hold, fall}): rise ≥ 0、hold ≥ 0、fall > 0（秒，时间常数）');
  const f = (tau) => holdFallFlow(0, 1, tau, rise, hold, fall).b;
  return kernel((tau) => (tau < 0 ? 0 : f(tau)), hold + (fall + rise) * Math.log(1 / eps) + rise * 2);
}

/** riseHoldFall 与 recoil 共用的段内闭式流：从 (b0, x0) 出发经过 s 秒。导出给 feel.js。 */
export function holdFallFlow(b0, x0, s, rise, hold, fall) {
  const r = 1 / fall;
  if (rise === 0) return { b: s <= hold ? x0 : x0 * Math.exp(-r * (s - hold)), x: s <= hold ? x0 : x0 * Math.exp(-r * (s - hold)) };
  const p = 1 / rise;
  if (s <= hold) return { x: x0, b: x0 + (b0 - x0) * Math.exp(-p * s) };
  const u = s - hold, bh = x0 + (b0 - x0) * Math.exp(-p * hold);
  const ep = Math.exp(-p * u), er = Math.exp(-r * u);
  const forced = Math.abs(p - r) < 1e-9 * p ? x0 * p * u * ep : (x0 * p / (p - r)) * (er - ep);
  return { x: x0 * er, b: bh * ep + forced };
}

/**
 * 最短可见：把短于 minFrames 帧的核按时间拉长到恰好 minFrames/fps（峰值不变），配合 snapToFrames 用。
 * 对齐后事件落在帧上，第 j 帧取 τ = j/fps，拉长后前 minFrames 帧（j = 0..N−1）都在支撑内、值 > 0。
 * 代价：响应变长、变"软"，原来 50 ms 的闪在 30 fps、N=2 时成了 66.7 ms。
 */
export function holdFrames(k, { fps, minFrames }) {
  if (!(k.support > 0) || !(fps > 0) || !(minFrames >= 1)) throw new Error('holdFrames(kernel, {fps, minFrames})：kernel 要带 support');
  const need = minFrames / fps;
  if (k.support >= need) return k;
  const s = k.support / need;
  return kernel((tau, e, rnd) => k(tau * s, e, rnd), need, (k.lead || 0) / s);
}

// ---------------------------------------------------------------------------
// 加载期对整张表做一次的规则：节流、连射结束、帧对齐
// ---------------------------------------------------------------------------

/**
 * throttle(track, { on, minGap, maxPerWindow: {n, span}, priority }) → 只含"实际触发"事件的新表（.dropped 是被丢的）
 *   没有 priority：按时间顺序贪心（和游戏运行时的冷却计时器同义）：距上一个触发 ≥ minGap、且 (t − span, t] 内已触发 < n 才触发。
 *   有 priority(e) → 数：先按优先级降序（同级按时间）贪心接受，与已接受的任何事件都满足 minGap、并且插入后任意长 span 的
 *     半开窗口内不超过 n 个才接受。不是因果的（后来的重要事件能"抢掉"之前的次要事件），但只取决于事件表。
 * 只处理 on 选中的事件；结果里只有它们（要和别的类型放一起用 merge）。
 */
export function throttle(track, { on, minGap = 0, maxPerWindow = null, priority = null } = {}) {
  const T = isTrack(track) ? track : eventTrack(track);
  const evs = T.events.filter(matcher(on));
  const n = maxPerWindow?.n ?? Infinity, span = maxPerWindow?.span ?? 0;
  if (maxPerWindow && !(n >= 1 && span > 0)) throw new Error('throttle: maxPerWindow 要 {n ≥ 1, span > 0}');
  const kept = [], dropped = [];
  if (!priority) {
    let last = -Infinity; const win = [];
    for (const e of evs) {
      while (win.length && win[0] <= e.t - span) win.shift();
      if (e.t - last >= minGap && win.length < n) { kept.push(e); last = e.t; win.push(e.t); } else dropped.push(e);
    }
  } else {
    const order = evs.slice().sort((a, b) => priority(b) - priority(a) || a.t - b.t || a.index - b.index);
    const acc = []; // 已接受的时刻，升序
    for (const e of order) {
      const i = lower(acc, e.t);
      const okGap = (i === acc.length || acc[i] - e.t >= minGap) && (i === 0 || e.t - acc[i - 1] >= minGap);
      let okWin = true;
      if (okGap && n < Infinity) {
        const ins = [...acc.slice(0, i), e.t, ...acc.slice(i)];
        // 计数最大的窗口总能平移到以某个已接受事件为起点：只查以 [e.t − span, e.t] 内各点起头的窗口
        for (let a = lower(ins, e.t - span + 1e-12); a <= i && okWin; a++) if (lower(ins, ins[a] + span) - a > n) okWin = false;
      }
      if (okGap && okWin) { acc.splice(i, 0, e.t); kept.push(e); } else dropped.push(e);
    }
    kept.sort((a, b) => a.index - b.index);
    dropped.sort((a, b) => a.index - b.index);
  }
  const out = eventTrack(kept.map(({ key, index, ...e }) => e));
  return Object.freeze({ ...out, dropped });
}

/**
 * burstEnds(track, { on, gap, delay, type }) → 派生表：每串连射（相邻间隔 < gap）的最后一发 + delay 处一个事件。
 * 字段：{ type, id: `${type}:${最后一发 id}`, t, count, start, last: 最后一发的 id }。"连射结束才补尾音"。
 */
export function burstEnds(track, { on, gap, delay = 0, type = 'burstEnd' } = {}) {
  if (!(gap > 0)) throw new Error('burstEnds: gap 必须 > 0');
  const T = isTrack(track) ? track : eventTrack(track);
  const evs = T.events.filter(matcher(on));
  const out = [];
  for (let i = 0; i < evs.length;) {
    let j = i; while (j + 1 < evs.length && evs[j + 1].t - evs[j].t < gap) j++;
    out.push({ type, id: `${type}:${evs[j].id}`, t: evs[j].t + delay, count: j - i + 1, start: evs[i].t, last: evs[j].id });
    i = j + 1;
  }
  return eventTrack(out);
}

/**
 * snapToFrames(track, fps, { mode, minFrames }) → 事件时刻对齐到帧栅格的新表（原时刻存在 e.t0，minFrames 记在 e.minFrames）。
 *   mode 'round'：挪动 ≤ 半帧，可能提前；'ceil'：只往后挪，≤ 1 帧。
 * 对齐后 τ 在帧上恰为 0, 1/fps, 2/fps…，响应的峰值一定被某帧采到；短于 minFrames 帧的核再套 holdFrames()。
 * 音画同步：声音要读对齐后的时刻（toCues 读的就是 e.t），否则声画差最多半帧。
 */
export function snapToFrames(track, fps, { mode = 'round', minFrames = 1 } = {}) {
  if (!(fps > 0)) throw new Error('snapToFrames: fps 必须 > 0');
  const T = isTrack(track) ? track : eventTrack(track);
  const q = mode === 'round' ? Math.round : mode === 'ceil' ? (x) => Math.ceil(x - 1e-9) : null;
  if (!q) throw new Error("snapToFrames: mode 只认 'round' / 'ceil'");
  return eventTrack(T.events.map(({ key, index, ...e }) => ({ ...e, t0: e.t0 ?? e.t, t: q(e.t * fps) / fps, minFrames })));
}

// ---------------------------------------------------------------------------
// 有记忆的量：事件处跳变 + 事件之间闭式流
// ---------------------------------------------------------------------------

/**
 * piecewise(track, { on, init, jump(s, e) → s, flow(s, dt, e) → s, value(s) → 输出 }) → f(t)
 * 加载期单遍：s 从 init 起，到每个事件先 flow 到事件时刻、再 jump，存下"事件刚发生后的状态"。
 * 求值：二分找 t 之前最近的事件 k，返回 value(flow(s_k, t − t_k, e_k))；第一个事件之前返回 value(init)（init 应是静止态）。
 * jump/flow 必须返回新值、不改参数（状态会被缓存复用）。f.states 是 [{t, s}]。
 * 能精确表达的：事件之间的演化有闭式（线性衰减、指数逼近、线性弹簧……），事件处的非线性随便（封顶、重置、取最大）。
 * 表达不了的：演化本身依赖画面或外部输入、事件之间没有闭式——那就换 film-physics 的定步重放。
 */
export function piecewise(track, { on, init, jump, flow, value = (s) => s }) {
  if (typeof jump !== 'function' || typeof flow !== 'function') throw new Error('piecewise: jump 与 flow 必填');
  const T = isTrack(track) ? track : eventTrack(track);
  const evs = T.events.filter(matcher(on));
  const times = Float64Array.from(evs, (e) => e.t);
  const states = [];
  let s = init;
  for (let i = 0; i < evs.length; i++) {
    if (i > 0) s = flow(s, evs[i].t - evs[i - 1].t, evs[i - 1]);
    s = jump(s, evs[i]);
    states.push(s);
  }
  const f = (t) => { const k = upper(times, t) - 1; return k < 0 ? value(init) : value(flow(states[k], t - times[k], evs[k])); };
  f.states = states.map((st, i) => ({ t: times[i], s: st }));
  f.events = evs;
  return f;
}

const addOf = (add) => (typeof add === 'function' ? add : () => add);

/**
 * 创伤值：每个事件 +add（数或 (e) → 数），以每秒 decay 线性衰减到 0，封顶 max。
 * trauma(track, t, opts)：单遍扫描 O(t 之前的事件数)，不建表，适合少量求值；
 * traumaOf(track, opts) → f(t)：加载期扫一次，之后 O(log n)。两者对同一输入结果逐位相同。
 */
export function trauma(track, t, { on, add, decay, max = Infinity }) {
  if (!(decay >= 0)) throw new Error('trauma: decay（每秒衰减量）必填且 ≥ 0');
  const T = isTrack(track) ? track : eventTrack(track);
  const A = addOf(add), m = matcher(on);
  let v = 0, last = null;
  for (const e of T.events) {
    if (e.t > t) break;
    if (!m(e)) continue;
    if (last !== null) v = Math.max(0, v - decay * (e.t - last));
    v = Math.min(max, v + A(e)); last = e.t;
  }
  return last === null ? 0 : Math.max(0, v - decay * (t - last));
}
export function traumaOf(track, { on, add, decay, max = Infinity }) {
  if (!(decay >= 0)) throw new Error('traumaOf: decay（每秒衰减量）必填且 ≥ 0');
  const A = addOf(add);
  return piecewise(track, { on, init: 0, jump: (v, e) => Math.min(max, v + A(e)), flow: (v, dt) => Math.max(0, v - decay * dt) });
}

/**
 * countRing(track, t, { on, size, fade }) → [{ e, rank, alpha }]：环形缓冲（贴花、弹孔、脚印）。
 * 只看"t 之前一共发生了几次"：rank 0 是最新的，rank ≥ size 的已被覆盖（不返回）；最老的 fade 个按 rank 渐隐：
 * alpha = rank < size − fade ? 1 : (size − rank)/(fade + 1)。on 是类型名或不给时 O(log n + size)。
 */
export function countRing(track, t, { on, size, fade = 0 }) {
  if (!(size >= 1) || !(fade >= 0 && fade < size)) throw new Error('countRing: size ≥ 1，0 ≤ fade < size');
  const T = isTrack(track) ? track : eventTrack(track);
  let evs, n;
  if (on == null || typeof on === 'string') { evs = on == null ? T.events : T.of(on); n = T.count(t, on ?? undefined); }
  else { evs = T.events.filter(matcher(on)); n = upper(Float64Array.from(evs, (e) => e.t), t); } // 谓词：O(n)，热路径先 only() 成一张表
  const out = [];
  for (let i = Math.max(0, n - size); i < n; i++) {
    const rank = n - 1 - i;
    out.push({ e: evs[i], rank, alpha: rank < size - fade ? 1 : (size - rank) / (fade + 1) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 给声音的桥（只产数据，不 import film-narration）
// ---------------------------------------------------------------------------

/**
 * toCues(track, mapping) → film-narration cues.json 的数组（cue 的 t 是成片秒数）。
 *   mapping: { 事件类型: cue 模板 | (e) → 模板 | null }。模板里的值可以是 (e) → 值（如 gain: (e) => e.power）。
 *   模板须给 type（音色名）或 file；没列出的事件类型直接报错（写 null 表示明确不出声），和 sfx.mjs fromScene 同一规矩。
 *   e.t 已经是对齐、节流之后的时刻：声音和画面读的是同一张表。
 */
export function toCues(track, mapping) {
  const T = isTrack(track) ? track : eventTrack(track);
  const out = [];
  for (const e of T.events) {
    if (!(e.type in mapping)) throw new Error(`toCues: 事件类型「${e.type}」没在 mapping 里（不出声写 null）`);
    let tpl = mapping[e.type];
    if (typeof tpl === 'function') tpl = tpl(e);
    if (tpl == null) continue;
    const cue = { t: e.t };
    for (const [k, v] of Object.entries(tpl)) { const x = typeof v === 'function' ? v(e) : v; if (x !== undefined) cue[k] = x; }
    if (cue.type == null && cue.file == null) throw new Error(`toCues: 「${e.type}」的模板要给 type（音色）或 file`);
    if ('at' in cue || 'beat' in cue) throw new Error('toCues: 生成的 cue 用 t，不要再写 at / beat');
    out.push(cue);
  }
  return out;
}

/** toSceneEvents(track, { kind, v, anchor, on }) → [{t, kind, v?, anchor?}]：给场景的 window.events()（sfx.mjs fromScene 读它） */
export function toSceneEvents(track, { kind = (e) => e.type, v, anchor, on } = {}) {
  const T = isTrack(track) ? track : eventTrack(track);
  return T.events.filter(matcher(on)).map((e) => {
    const o = { t: e.t, kind: typeof kind === 'function' ? kind(e) : kind };
    if (v) o.v = v(e);
    if (anchor) o.anchor = anchor(e);
    return o;
  });
}
