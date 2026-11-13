// events.js（film-core）/ feel.js、closed.js（film-physics）的 Node 数值断言。运行：node tests/fixtures/_test-events/tests/unit.mjs
// 运行时之间的相对 import（feel.js → ./events.js → ./rand.js）用 film-core 的 registerRuntimeResolver 按挂载表语义解析。
// 参照一律是**独立实现**：RK4 / 定步模拟 / 整数节拍的冷却计时器 / 暴力枚举约束，不调被测函数；"改动前"的公式原样抄在本文件里做逐位/数值对照。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { registerRuntimeResolver } = await import('file://' + join(ROOT, 'skills/film-core/lib/runtime-node.mjs'));
registerRuntimeResolver();
const E = await import('file://' + join(ROOT, 'skills/film-core/assets/runtime/events.js'));
const F = await import('file://' + join(ROOT, 'skills/film-physics/assets/runtime/feel.js'));
const C = await import('file://' + join(ROOT, 'skills/film-physics/assets/runtime/closed.js'));
const { hash01 } = await import('file://' + join(ROOT, 'skills/film-core/assets/runtime/rand.js'));

let pass = 0, failN = 0;
const ok = (c, msg, extra = '') => { if (c) pass++; else failN++; console.log(`${c ? '✓' : '✗'} ${msg} ${extra}`); };
const fmt = (x) => x.toExponential(2);
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const withFilm = (fps, f) => { globalThis.FILM = Object.freeze({ fps, width: 1080, height: 1920, format: '9x16' }); try { return f(); } finally { delete globalThis.FILM; } };

// RK4 积分 x'' = f(x, v, t)
function rk4(acc, x, v, t, dt) {
  const k1x = v, k1v = acc(x, v, t);
  const k2x = v + k1v * dt / 2, k2v = acc(x + k1x * dt / 2, k2x, t + dt / 2);
  const k3x = v + k2v * dt / 2, k3v = acc(x + k2x * dt / 2, k3x, t + dt / 2);
  const k4x = v + k3v * dt, k4v = acc(x + k3x * dt, k4x, t + dt);
  return [x + dt * (k1x + 2 * k2x + 2 * k3x + k4x) / 6, v + dt * (k1v + 2 * k2v + 2 * k3v + k4v) / 6];
}

// ── 改动前的公式（原样抄录，只做对照）──────────────────────────────
function oldKick(p) { // 旧 events.js springKick 的 f / v
  const w = p.omega ?? Math.sqrt(p.k), z = p.zeta ?? p.c / (2 * Math.sqrt(p.k));
  if (Math.abs(z - 1) < 1e-6) return [(t) => t * Math.exp(-w * t), (t) => (1 - w * t) * Math.exp(-w * t)];
  if (z < 1) { const wd = w * Math.sqrt(1 - z * z), a = z * w; return [(t) => Math.exp(-a * t) * Math.sin(wd * t) / wd, (t) => Math.exp(-a * t) * (Math.cos(wd * t) - (a / wd) * Math.sin(wd * t))]; }
  const r = w * Math.sqrt(z * z - 1), s1 = -z * w + r, s2 = -z * w - r, d = s1 - s2;
  return [(t) => (Math.exp(s1 * t) - Math.exp(s2 * t)) / d, (t) => (s1 * Math.exp(s1 * t) - s2 * Math.exp(s2 * t)) / d];
}
function oldSpring(t, x0, v0, target, k = 170, c = 26) { // 旧 closed.js spring
  if (t <= 0) return x0;
  const w = Math.sqrt(k), z = c / (2 * w), A = x0 - target;
  if (z < 1) { const wd = w * Math.sqrt(1 - z * z); return target + Math.exp(-z * w * t) * (A * Math.cos(wd * t) + ((v0 + z * w * A) / wd) * Math.sin(wd * t)); }
  if (z === 1) return target + Math.exp(-w * t) * (A + (v0 + w * A) * t);
  const r = w * Math.sqrt(z * z - 1), s1 = -z * w + r, s2 = -z * w - r;
  const C2 = (v0 - s1 * A) / (s2 - s1), C1 = A - C2;
  return target + C1 * Math.exp(s1 * t) + C2 * Math.exp(s2 * t);
}
function oldHitstop(t, hits, dur = 0.06) { let lost = 0; for (const h of hits) lost += Math.min(Math.max(t - h, 0), dur); return t - lost; }
function oldFlash(t, hits, dur = 0.12) { let v = 0; for (const h of hits) { const s = t - h; if (s >= 0 && s < dur) v = Math.max(v, 1 - s / dur); } return v; }

// 1. 弹簧冲量核 vs RK4（三种阻尼）；与改动前公式、三种参数写法、closed.spring 一致
for (const [name, p] of [['欠阻尼 ζ≈0.69', { k: 150, c: 17 }], ['临界 ζ=1', { k: 100, c: 20 }], ['过阻尼 ζ=2', { k: 64, c: 32 }]]) {
  const h = E.springKick(p);
  let x = 0, v = 1, err = 0; const dt = 1e-4;
  for (let i = 1; i <= 20000; i++) { [x, v] = rk4((x, v) => -p.k * x - p.c * v, x, v, 0, dt); err = Math.max(err, Math.abs(x - h(i * dt))); }
  ok(err < 1e-10, `springKick ${name} 与 RK4(dt=1e-4, 2s) 最大误差`, fmt(err));
}
{
  let eOld = 0, eV = 0, eAlias = 0, eSpr = 0;
  for (const z of [0.05, 0.3, 0.69, 1 - 5e-7, 1, 1 + 5e-7, 1 + 2e-6, 1.5, 4, 50]) {
    const w = 11, h = E.springKick({ omega: w, zeta: z }), [f, fv] = oldKick({ omega: w, zeta: z });
    const hs = E.springKick({ stiffness: w * w, damping: 2 * z * w }), hk = E.springKick({ k: w * w, c: 2 * z * w });
    for (let t = 0; t < 3; t += 0.0031) {
      const sc = 1 / w;   // h 的量级 ~ 1/ω
      eOld = Math.max(eOld, Math.abs(h(t) - f(t)) / sc); eV = Math.max(eV, Math.abs(h.velocity(t) - fv(t)));
      eAlias = Math.max(eAlias, Math.abs(hs(t) - hk(t)));
      // closed.spring 只在 ζ 恰为 1 时走临界公式；|ζ−1| < 1e−6 时它的欠/过阻尼式有抵消误差（实测 ~1e−7），这一段不比
      if (Math.abs(z - 1) >= 1e-6 || z === 1) eSpr = Math.max(eSpr, Math.abs(h(t) - C.spring(t, 0, 1, 0, w * w, 2 * z * w)) / sc);
    }
  }
  ok(eOld < 1e-12 && eV < 1e-12, 'springKick 改用 oscillate 后与改动前公式一致（10 个 ζ，含 1±5e-7 临界带）', `位置相对 ${fmt(eOld)} 速度 ${fmt(eV)}`);
  ok(eAlias === 0, '{stiffness, damping} 与 {k, c} 逐位相同');
  ok(eSpr < 1e-9, 'springKick 与 closed.spring(τ,0,1,0) 同一份闭式', fmt(eSpr));
  let bit = true;
  for (const [k, c] of [[170, 26], [600, 18], [100, 20], [64, 32], [9.81, 0], [150, 0.4]])
    for (let t = -0.1; t < 4; t += 0.0137) for (const [x0, v0, g] of [[0, 0, 1], [-0.3, 0, 0], [1.2, -3, 0.4]]) if (C.spring(t, x0, v0, g, k, c) !== oldSpring(t, x0, v0, g, k, c)) bit = false;
  ok(bit, 'closed.spring 委托 oscillate 后与改动前逐位相同（6 组 k,c × 3 组初值 × 300 个 t）');
  const a = F.springDip([{ t: 0.3 }, { t: 0.7 }], { impulse: 2, stiffness: 150, damping: 11 }), b = F.springDip([{ t: 0.3 }, { t: 0.7 }], { impulse: 2, k: 150, c: 11 });
  let same = true; for (let t = 0; t < 3; t += 0.01) if (a(t) !== b(t)) same = false;
  ok(same, 'springDip 接受 {stiffness, damping}，与 {k, c} 逐位相同');
  ok(throws(() => E.springKick({ k: 1, stiffness: 1, c: 1 }), /只给一种/), '{k} 与 {stiffness} 同时给报错');
  ok(E.springKick({ omega: 5, zeta: 0 }).support === Infinity, 'ζ=0 无阻尼：support = Infinity（文档写明 O(n) 代价）');
}
{ const h = E.springKick({ k: 150, c: 17 }); const d = 1e-6; let err = 0;
  for (let t = 0.01; t < 1; t += 0.013) err = Math.max(err, Math.abs((h(t + d) - h(t - d)) / (2 * d) - h.velocity(t)));
  ok(err < 1e-6, 'springKick.velocity 与中心差分', fmt(err)); }
{ let err = 0; // oscillate 的速度：与 RK4 带初值、带目标
  const k = 220, c = 9; let x = 0.7, v = -2; const dt = 1e-4;
  for (let i = 1; i <= 15000; i++) { [x, v] = rk4((x, v) => -k * (x - 0.2) - c * v, x, v, 0, dt); const o = E.oscillate(i * dt, 0.7, -2, 0.2, k, c); err = Math.max(err, Math.abs(o.x - x), Math.abs(o.v - v) / 20); }
  ok(err < 1e-9, 'oscillate {x, v} 带初值/目标与 RK4', fmt(err)); }

// 随机事件表
const evs = []; for (let i = 0; i < 40; i++) evs.push({ t: 0.2 + 9.5 * hash01(5, i, 1), type: i % 3 ? 'hit' : 'blast', power: 0.3 + hash01(5, i, 2) });
const T = E.eventTrack(evs);
ok(T.length === 40 && T.times.every((x, i) => i === 0 || x >= T.times[i - 1]), 'eventTrack 排序、补 id');
ok(T.of('hit')[0].id === 'hit:' + evs.filter((e) => e.type === 'hit').findIndex((e) => e.t === T.of('hit')[0].t), 'id 缺省 `${type}:${本类型原表序号}`');
ok(T.count(5, 'hit') === evs.filter((e) => e.type === 'hit' && e.t <= 5).length && T.window(5, 1).length === evs.filter((e) => e.t > 4 && e.t <= 5).length, 'count / window 与朴素过滤一致');

// 2. 多事件叠加 = 逐个相加；springDip（无限幅）= 冲量序列的 RK4 模拟
{
  const h = E.springKick({ k: 300, c: 14 });
  const all = E.channel(T, { name: 'dip', on: 'hit', response: (tau, e) => e.power * h(tau), support: h.support });
  const singles = T.of('hit').map((e) => E.channel([{ ...e }], { name: 'dip', response: (tau, ee) => ee.power * h(tau), support: h.support }));
  let err = 0; for (let t = 0; t < 10; t += 0.0071) { let s = 0; for (const c of singles) s += c(t); err = Math.max(err, Math.abs(all(t) - s)); }
  ok(err < 1e-12, '多事件 channel(sum) 与逐个事件单独求值再相加', fmt(err));
  const dip = F.springDip(T, { on: 'hit', impulse: (e) => e.power, k: 300, c: 14 });
  const hits = T.of('hit'); let x = 0, v = 0, k = 0, err2 = 0; const dt = 1e-4;
  for (let i = 0; i <= 100000; i++) { const t = i * dt; while (k < hits.length && hits[k].t <= t) { v += hits[k].power; k++; }
    if (i % 50 === 0 && t > 0.3) err2 = Math.max(err2, Math.abs(x - dip(t)));
    [x, v] = rk4((x, v) => -300 * x - 14 * v, x, v, t, dt); }
  ok(err2 < 0.02 * 0.12, 'springDip 与冲量序列 RK4 模拟（冲量落在 1e-4 栅格上，误差来自时刻量化）', fmt(err2));
}

// 3. 节流：无 priority 对整数节拍的冷却计时器；有 priority 对暴力约束枚举
{
  // 事件落在 1 ms 栅格上；minGap/span 取半毫秒，避开浮点边界的"恰好相等"
  const ticks = Array.from({ length: 300 }, (_, i) => Math.floor(10000 * hash01(9, i, 0)));
  const dense = E.eventTrack(ticks.map((k) => ({ t: k / 1000, type: 'hit' })));
  const th = E.throttle(dense, { on: 'hit', minGap: 0.0905, maxPerWindow: { n: 4, span: 0.6005 } });
  // 参照：游戏式每 tick 一步。cooldown 是整数计数器（触发后置 91 tick、每 tick 减 1）；窗口是 601 格的环形计数（每 tick 该格清零）
  const ring = new Int32Array(601); let inWin = 0, cool = 0; const keptTicks = [];
  const byTick = new Map(); for (const k of [...ticks].sort((a, b) => a - b)) byTick.set(k, (byTick.get(k) ?? 0) + 1);
  for (let tick = 0; tick <= 10001; tick++) {
    const slot = tick % 601; inWin -= ring[slot]; ring[slot] = 0;   // 601 tick 之前那一格滑出窗口
    for (let j = 0; j < (byTick.get(tick) ?? 0); j++) if (cool <= 0 && inWin < 4) { keptTicks.push(tick); cool = 91; ring[slot]++; inWin++; }
    cool--;
  }
  ok(keptTicks.length === th.length && keptTicks.every((k, i) => k / 1000 === th.times[i]), `throttle 与整数节拍冷却计时器 + 环形窗口逐个一致（${th.length}/300 触发，${th.dropped.length} 丢弃）`);
  // priority：暴力枚举验证（不复用贪心）。① 结果满足 minGap 与"任意半开 span 窗口 ≤ n"；② 每个被丢的 d，加进
  // "优先级高于它的已触发事件"集合就违反约束（贪心按优先级处理到 d 时，已接受的正好是这些）
  const pr = (e) => hash01(9, e.index, 7);
  const valid = (ts, gap, n, span) => { const s = [...ts].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] < gap) return false;
    for (const a of s) if (s.filter((x) => x >= a && x < a + span).length > n) return false; return true; };
  for (const [gap, mpw] of [[0.09, null], [0.03, { n: 3, span: 0.5 }], [0.0905, { n: 4, span: 0.6005 }]]) {
    const tp = E.throttle(dense, { on: 'hit', minGap: gap, maxPerWindow: mpw, priority: pr });
    const P = new Map(dense.events.map((e) => [e.id, pr(e)]));
    const n = mpw?.n ?? Infinity, span = mpw?.span ?? 1;
    const keptOk = valid(tp.times, gap, n, span);
    const justified = tp.dropped.every((d) => !valid([...tp.events.filter((k) => P.get(k.id) > P.get(d.id)).map((k) => k.t), d.t], gap, n, span));
    ok(keptOk && justified && tp.length + tp.dropped.length === 300, `throttle(priority${mpw ? ' + maxPerWindow' : ''}, minGap ${gap}) 暴力枚举：结果满足约束、每个丢弃都被更高优先级挡住（${tp.length} 触发）`);
  }
  const be = E.burstEnds(E.eventTrack([0, 0.08, 0.16, 1, 1.05, 3].map((t) => ({ t, type: 'shot' }))), { on: 'shot', gap: 0.1, delay: 0.1, type: 'tail' });
  ok(be.length === 3 && Math.abs(be.times[0] - 0.26) < 1e-12 && be.events[0].count === 3 && be.events[1].count === 2 && be.events[0].last === 'shot:2', 'burstEnds：3 串连射，尾音在最后一发 +0.1s，last 是那一发的 id');
}

// 4. 帧对齐 + 最短可见：按这次渲染的 fps（FILM.fps）对齐与拉长，每个 50 ms 闪光至少 N=2 帧；帧率不对时报错
{
  const N = 2, fl = E.flashDecay(0.05);
  const raw = E.eventTrack(Array.from({ length: 200 }, (_, i) => ({ t: 1 + 20 * hash01(3, i, 0), type: 'flash' })));
  // 第 K 帧采样 τ = K/fps − t_e；数有几帧 > 0（与被测代码无关的独立计数）
  const framesLit = (track, k, fps) => track.events.map((e) => { let c = 0; for (let K = Math.floor(e.t * fps) - 2; K < e.t * fps + 12; K++) if (k(K / fps - e.t) > 0) c++; return c; });
  const peakSeen = (track, k, fps) => track.events.every((e) => { for (let K = Math.floor(e.t * fps) - 1; K < e.t * fps + 3; K++) if (k(K / fps - e.t) === 1) return true; return false; });
  ok(Math.min(...framesLit(raw, fl, 30)) < N && !peakSeen(raw, fl, 30), `对照：不对齐时最少只落在 ${Math.min(...framesLit(raw, fl, 30))} 帧，且有闪光的峰值一帧也没采到`);
  for (const fps of [24, 25, 30, 50, 60]) {
    const r = withFilm(fps, () => { const s = E.snapToFrames(raw); return { s, k: E.holdFrames(fl, { minFrames: N }) }; });
    const lit = framesLit(r.s, r.k, fps);
    const shift = Math.max(...r.s.events.map((e) => Math.abs(e.t - e.t0)));
    ok(r.s.fps === fps && Math.min(...lit) >= N && peakSeen(r.s, r.k, fps) && shift <= 0.5 / fps + 1e-12,
      `FILM.fps=${fps}：snapToFrames/holdFrames 不传 fps，每个闪光 ≥ ${N} 帧（最少 ${Math.min(...lit)}）、峰值都被某帧采到、挪动 ≤ 半帧`);
  }
  // 旧写法的失败模式：按 30 对齐、按 24 渲染 → 少于 2 帧。现在这种组合直接报错
  { const s30 = E.snapToFrames(raw, 30), k30 = E.holdFrames(fl, { fps: 30, minFrames: N });
    const bad = framesLit(s30, k30, 24).filter((c) => c < N).length;
    ok(bad > 0, `对照：按 30 fps 对齐/拉长、按 24 fps 渲染时 ${bad}/200 个闪光少于 ${N} 帧`); }
  ok(withFilm(24, () => throws(() => E.snapToFrames(raw, 30), /24 fps/)) && withFilm(30, () => throws(() => E.holdFrames(fl, { fps: 60, minFrames: 2 }), /30 fps/)),
    '显式 fps 与 FILM.fps 不相容时报错（30 栅格 @24 渲染；按 60 拉长 @30 渲染）');
  ok(withFilm(60, () => E.snapToFrames(raw, 30).fps === 30 && E.holdFrames(fl, { fps: 30, minFrames: 2 }).support > 0), '相容时照常：30 的栅格 @60 渲染、按 30 拉长 @60 渲染');
  ok(throws(() => E.snapToFrames(raw), /FILM/) && throws(() => E.holdFrames(fl, { minFrames: 2 }), /FILM/), '没给 fps 也没有 FILM：报错，不猜 30');
  ok(throws(() => E.snapToFrames(raw, 30, { minFrames: 2 }), /holdFrames/), 'snapToFrames 不再收死参数 minFrames（报错指向 holdFrames）');
}

// 5. trauma 闭式 vs 小步长模拟；trauma 与 traumaOf 逐位相同
{
  const opt = { on: ['hit', 'blast'], add: (e) => (e.type === 'blast' ? 0.5 : 0.12 + 0.1 * e.power), decay: 1.7, max: 1 };
  const tf = E.traumaOf(T, opt);
  let v = 0, k = 0, err = 0, same = true; const dt = 1e-5;
  for (let i = 0; i <= 1050000; i++) { const t = i * dt;
    while (k < T.length && T.times[k] <= t) v = Math.min(1, v + opt.add(T.events[k++]));
    if (i % 997 === 0) { err = Math.max(err, Math.abs(v - tf(t))); }
    v = Math.max(0, v - 1.7 * dt); }
  ok(err < 1.7 * 1e-5 * 1.01, 'traumaOf 与 dt=1e-5 模拟（误差上界 = decay·dt，来自事件时刻量化）', fmt(err));
  for (let t = 0; t < 11; t += 0.0137) if (E.trauma(T, t, opt) !== tf(t)) same = false;
  ok(same, 'trauma(track,t) 单遍扫描与 traumaOf 预计算逐位相同');
}

// 6. recoil（保持被重置）vs 游戏式定步逻辑；approach vs 定步指数逼近
{
  const shots = E.eventTrack([...Array.from({ length: 12 }, (_, i) => ({ t: 0.5 + i * 0.083, type: 'shot' })), { t: 3, type: 'shot' }, { t: 3.06, type: 'shot' }]);
  const opt = { on: 'shot', amount: 0.01, keep: 0.35, rise: 1 / 34, hold: 0.09, fall: 1 / 6.5, max: 0.3 };
  const rc = F.recoil(shots, opt);
  let P = 0, x = 0, b = 0, A = 0, k = 0, err = 0; const dt = 1e-5;
  for (let i = 0; i <= 500000; i++) { const t = i * dt;
    while (k < shots.length && shots.times[k] <= t) { P += 0.35 * 0.01; x = Math.min(0.3, x + 0.65 * 0.01); A = 0.09; k++; }
    if (i % 503 === 0) { const r = rc(t); err = Math.max(err, Math.abs(r.visual - b), Math.abs(r.target - x), Math.abs(r.permanent - P)); }
    A -= dt; if (A <= 0) x *= Math.exp(-6.5 * dt);
    b = x + (b - x) * Math.exp(-34 * dt);
  }
  ok(err < 5e-6, 'recoil 与游戏式 1e-5 s 定步（保持计时器每发重置，不调被测代码）最大误差', fmt(err));
  const kr = E.riseHoldFall({ rise: 0.03, hold: 0.09, fall: 0.15 });
  let xx = 1, bb = 0, e2 = 0;
  for (let i = 1; i <= 100000; i++) { const t = i * 1e-5; if (t > 0.09) xx *= Math.exp(-1e-5 / 0.15); bb += (xx - bb) * (1 - Math.exp(-1e-5 / 0.03)); if (i % 97 === 0) e2 = Math.max(e2, Math.abs(bb - kr(t))); }
  ok(e2 < 5e-4, 'riseHoldFall 核与 1e-5 s 指数步进', fmt(e2));
  // approach：状态事件改目标与速率；参照是显式欧拉 dv = rate·(g − v)·dt（不用指数闭式）
  const st = E.eventTrack([{ t: 0.4, type: 'dark', g: 0.2, r: 3 }, { t: 1.1, type: 'dark', g: 0.9, r: 7 }, { t: 1.15, type: 'dark', g: 0.5, r: 1.5 }, { t: 2.6, type: 'dark', g: 1, r: 4 }]);
  const ap = F.approach(st, { on: 'dark', init: 1, target: (e) => e.g, rate: (e) => e.r });
  let vv = 1, g = 1, r = 0, j = 0, e3 = 0; const h = 1e-6;
  for (let i = 0; i <= 4000000; i++) { const t = i * h;
    while (j < st.length && st.times[j] <= t + 1e-12) { g = st.events[j].g; r = st.events[j].r; j++; }
    if (i % 4999 === 0) e3 = Math.max(e3, Math.abs(vv - ap(t)));
    vv += r * (g - vv) * h; }
  ok(e3 < 2e-5, 'approach 与显式欧拉 dt=1e-6（目标/速率随事件切换）', fmt(e3));
}

// 7. 乱序求值与顺序求值逐位相同
{
  const fl = E.channel(T, { name: 'flash', on: 'hit', response: E.flashDecay(0.12), combine: 'max' });
  const tf = E.traumaOf(T, { add: 0.2, decay: 1.5, max: 1 });
  const rc = F.recoil(T, { on: 'hit', amount: (e) => e.power, keep: 0.3, rise: 0.03, hold: 0.09, fall: 0.15 });
  const ap = F.approach(T, { on: 'blast', init: 1, target: (e) => e.power, rate: 2.2 });
  const dp = F.springDip(T, { on: 'blast', impulse: 1, k: 150, c: 17, min: -0.2, max: 0.05 });
  const sparks = E.channel(T, { name: 'sparks', on: 'hit', response: (tau, e, r) => r(1) * Math.exp(-tau), support: 2 });
  const terms = F.shakeTermsFromSeed(7, { band: [4, 14], second: 0.6 });
  const isBlast = (e) => e.type === 'blast';
  const tw = C.hitstopOf(T.of('hit'), { dur: 0.06 });
  const all = (t) => JSON.stringify([fl(t), tf(t), rc(t), ap(t), dp(t), sparks(t), sparks.active(t).map((a) => [a.e.id, a.tau, a.rnd(3)]), F.traumaShake(t, tf(t), { amp: { pitch: 0.03, yaw: 0.03, roll: 0.045 }, terms, power: 2 }), E.countRing(T, t, { on: 'hit', size: 8, fade: 3 }).map((r) => r.alpha), E.countRing(T, t, { on: isBlast, size: 4 }).map((r) => r.e.id), tw(t)]);
  const ts = Array.from({ length: 600 }, (_, i) => i / 60);
  const seq = ts.map(all);
  const perm = ts.map((_, i) => i).sort((a, b) => hash01(1, a) - hash01(1, b));
  const out = new Array(ts.length); for (const i of perm) out[i] = all(ts[i]);
  ok(out.every((s, i) => s === seq[i]), '11 个通道乱序求值与顺序求值逐位相同（600 帧，含谓词 countRing 缓存与 hitstopOf）');
  const rs = (t) => JSON.stringify(E.countRing(T, t, { on: 'blast', size: 4 }).map((r) => r.e.id));
  ok(ts.every((t) => rs(t) === JSON.stringify(E.countRing(T, t, { on: isBlast, size: 4 }).map((r) => r.e.id))), 'countRing 谓词（加载期缓存）与类型名结果相同');
}

// 8. combine 'last' + lead：已发生的事件优先于下一个事件的预备段
{
  const resp = Object.assign((tau, e) => (e.id === 'a' ? 1 : 2) + tau, { support: 1, lead: 0.3 });
  const ch = E.channel([{ t: 1, id: 'a' }, { t: 1.2, id: 'b' }], { response: resp, combine: 'last' });
  ok(ch(1.05) === 1 + 0.050000000000000044 || Math.abs(ch(1.05) - 1.05) < 1e-12, 'last@1.05：a 已发生、b 在预备段 → 取 a', String(ch(1.05)));
  ok(Math.abs(ch(0.95) - (1 - 0.05)) < 1e-12, 'last@0.95：都还没发生 → 取离现在最近的 a 的预备段', String(ch(0.95)));
  ok(Math.abs(ch(1.25) - (2 + 0.05)) < 1e-12, 'last@1.25：b 已发生 → 取 b', String(ch(1.25)));
  ok(ch(0.6) === 0 && ch(2.3) === 0, 'last：窗口外为 0');
}

// 9. 顿帧：重叠时取并集、单调不减；不重叠时与改动前逐位相同
{
  const ov = [1, 1.03];
  const vals = [1, 1.03, 1.05, 1.06, 1.09, 1.2].map((t) => C.hitstop(t, ov, 0.06));
  ok(Math.abs(vals[2] - 1) < 1e-12 && Math.abs(vals[4] - 1) < 1e-12 && Math.abs(vals[5] - 1.11) < 1e-12, '例：命中 1.0/1.03、dur .06 → 1.03..1.09 平在 1.000，之后斜率 1（以前 1.05 倒退到 0.980）', vals.map((v) => v.toFixed(3)).join(' '));
  let mono = true, err = 0, bits = true, invErr = 0;
  for (let s = 0; s < 30; s++) {
    const hs = Array.from({ length: 12 }, (_, i) => 0.2 + 3 * hash01(77, s, i));
    const dur = 0.02 + 0.2 * hash01(78, s);
    const f = C.hitstopOf(hs, { dur });
    let prev = -Infinity;
    for (let t = 0; t < 4; t += 0.0007) { const a = C.hitstop(t, hs, dur), b = f(t); if (a < prev - 1e-12) mono = false; prev = a; err = Math.max(err, Math.abs(a - b)); invErr = Math.max(invErr, Math.abs(f(f.inv(b)) - b)); }
    // 独立参照：1e-5 s 步进，不在任何 [h, h+dur) 里的步才计入世界时间
    let w = 0; const dt = 1e-5; let e3 = 0;
    for (let i = 0; i < 400000; i++) { const t = i * dt; if (i % 1000 === 0) e3 = Math.max(e3, Math.abs(w - f(t))); if (!hs.some((h) => t >= h && t < h + dur)) w += dt; }
    err = Math.max(err, e3 > 13 * dt ? e3 : 0);
    const spaced = []; for (let i = 0, t = 0.2; i < 12; i++, t += dur + 0.01 + 0.05 * hash01(79, s, i)) spaced.push(t);
    spaced.reverse();   // 乱序给：不重叠判断要先排序，求和仍按调用方给的顺序
    for (let t = 0; t < 5; t += 0.0013) if (C.hitstop(t, spaced, dur) !== oldHitstop(t, spaced, dur)) bits = false;
  }
  ok(mono, '30 组随机重叠命中：hitstop 世界时间单调不减（以前会倒退）');
  ok(err < 1e-9, 'hitstop(t) 与 hitstopOf 一致，二者与 1e-5 s 步进的冻结计时（误差 ≤ 12 段 × dt）一致');
  ok(bits, '互不重叠时 hitstop 与改动前逐位相同（30 组 × 3800 个 t）');
  ok(invErr < 1e-12, 'hitstopOf.inv：tw(inv(w)) = w', fmt(invErr));
  ok(throws(() => C.hitstopOf([1], {}), /dur/), 'hitstopOf 的 dur 必填');
  let fb = true; for (let t = 0; t < 4; t += 0.003) for (const d of [0.05, 0.12, 0.3]) if (C.flash(t, [0.5, 0.55, 2], d) !== oldFlash(t, [0.5, 0.55, 2], d)) fb = false;
  ok(fb && C.flash(1, [1], 0) === 0, 'closed.flash 委托 flashDecay 后与改动前逐位相同');
}

// 10. 屏震频率：avoid 是参数；比值同时查 f2/f1 与 f1/f2
{
  const near = (T3, q, tol) => ['pitch', 'yaw', 'roll'].filter((ax) => { const [a, b] = [T3[ax][0][0], T3[ax][1][0]]; return Math.abs(Math.max(a, b) / Math.min(a, b) - q) < tol; }).length;
  let n1 = 0, n2 = 0, b1 = 0, b2 = 0, inBand = true, sameFirst = true;
  for (let s = 0; s < 2000; s++) {
    const plain = F.shakeTermsFromSeed(s, { band: [4, 13], second: 0.6 });
    const av = F.shakeTermsFromSeed(s, { band: [4, 13], second: 0.6, avoid: { ratios: [1, 2], tol: 0.1 } });
    b1 += near(plain, 1, 0.1); b2 += near(plain, 2, 0.1); n1 += near(av, 1, 0.1); n2 += near(av, 2, 0.1);
    for (const ax of ['pitch', 'yaw', 'roll']) {
      for (const [hz] of av[ax]) if (hz < 4 || hz >= 13) inBand = false;
      if (near({ [ax]: plain[ax], pitch: plain[ax], yaw: plain[ax], roll: plain[ax] }, 1, 0.1) === 0 && near({ pitch: plain[ax], yaw: plain[ax], roll: plain[ax] }, 2, 0.1) === 0 && JSON.stringify(av[ax]) !== JSON.stringify(plain[ax])) sameFirst = false;
    }
  }
  ok(b1 > 0 && b2 > 0, `对照：不给 avoid 时 6000 轴里比值≈1 有 ${b1} 个、≈2（含 f2/f1≈0.5）有 ${b2} 个`);
  ok(n1 === 0 && n2 === 0 && inBand, 'avoid {ratios:[1,2], tol:.1}：6000 轴里 0 个落在 1±.1 或 2±.1（含 0.5），频率都在 band 内');
  ok(sameFirst, '第一次抽到就合格的轴，给不给 avoid 结果相同');
  ok(throws(() => F.shakeTermsFromSeed(1, { band: [10, 10.5], second: 0.5, avoid: { ratios: [1], tol: 0.1 } }), /band/), 'band 太窄避不开：报错');
  ok(throws(() => F.traumaShake(0, 0.5, { amp: { pitch: 1 }, terms: F.shakeTermsFromSeed(1, { band: [4, 9], second: 0.5 }) }), /power/), 'traumaShake 的 power 必填（不给默认 2）');
}

// 11. 其它
{
  const ring = E.countRing(T, 99, { on: 'hit', size: 10, fade: 4 });
  ok(ring.length === 10 && ring[0].alpha === 0.2 && ring[9].alpha === 1 && ring[5].alpha === 1, 'countRing：最老 4 个渐隐 0.2..0.8', ring.map((r) => r.alpha).join(','));
  let threw = false; try { E.toCues(T, { hit: { type: 'x' } }); } catch { threw = true; }
  ok(threw, 'toCues 遇到没列出的事件类型报错');
  ok(throws(() => E.gaussPulse({ at: -1, width: 0.1 }), /事件之前/) && E.gaussPulse({ at: -0.1, width: 0.1 }).lead > 0, 'gaussPulse：整段在事件前时报错说明原因；at 为负但脉冲跨过事件时照常');
  const circ = F.arcTable((t) => [Math.cos(t), Math.sin(t)], { t0: 0, t1: 2 * Math.PI, n: 4096 });
  ok(Math.abs(circ.length - 2 * Math.PI) < 1e-5, 'arcTable 单位圆弧长', fmt(circ.length - 2 * Math.PI));
  const arc = (t) => Math.min(t, 3.37) * 1.4;
  const h = F.stepPhase(10, { arc, stride: 1.55, stops: [[3.37, Infinity]], snapRate: 8 });
  ok(Math.abs(h - Math.round(h)) < 1e-6, '停下 6.6 s 后相位吸附到整步', h.toFixed(9));
  const h2 = F.stepPhase(5, { arc: (t) => t * 1.4, stride: 1.55, stops: [[2, 2.5]], snapRate: 8 });
  const h2b = F.stepPhase(5 + 1e-7, { arc: (t) => t * 1.4, stride: 1.55, stops: [[2, 2.5]], snapRate: 8 });
  ok(Math.abs(h2b - h2) < 1e-6, '再走之后相位连续');
  const s0 = { pos: [0, 2, 5], target: [1, 1, 0], fov: 40 };
  const s1 = F.perturbShot(s0, { pitch: 0.1, yaw: -0.2, roll: 0.05 });
  const d = (s) => Math.hypot(...s.target.map((x, i) => x - s.pos[i]));
  ok(Math.abs(d(s1) - d(s0)) < 1e-12 && s1.fov === 40 && s1.roll === 0.05, 'perturbShot 不改注视距离、保留其余字段');
  ok(F.perturbShot({ pos: [0, 0, 0], target: [0, 0, -1] }, { pitch: 0.1 }).target[1] > 0, 'pitch > 0 抬头');
  const P = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
  let y = 0, v = 0, e3 = 0; const dt = 1e-4; const acc = (t) => (P(t + 1e-4) - 2 * P(t) + P(t - 1e-4)) / 1e-8;
  for (let i = 0; i < 20000; i++) { const t = i * dt; if (i % 200 === 0) e3 = Math.max(e3, Math.abs(y - F.lagOffset(t, P, { k: 110, c: 15, span: 1.5, steps: 600 }))); [y, v] = rk4((y, v, tt) => -110 * y - 15 * v - acc(tt), y, v, t, dt); }
  ok(e3 < 1e-4, 'lagOffset（Simpson 600 段）与 RK4 子物体模拟', fmt(e3));
  ok(F.cruise(0.5, 0.25) === 0.5 && F.cruise(0, 0.25) === 0 && F.cruise(1, 0.25) === 1, 'cruise 端点与中点');
}

// 12. 端到端：事件表 → 对齐 → 节流 → 连射收尾 → toCues → cues.json 形状（film-narration sfx.mjs 读它；CONTRACT §1 / §5）
{
  const shots = [];
  for (let i = 0; i < 5; i++) shots.push({ t: 0.5 + i * 0.07, type: 'shot', pan: -0.4, power: 0.8 });
  for (let i = 0; i < 3; i++) shots.push({ t: 2 + i * 0.07, type: 'shot', pan: 0.3, power: 0.6 });
  shots.push({ t: 1.4, type: 'land', id: 'land-hero', pan: 0, power: 1 });
  const snapped = E.snapToFrames(E.eventTrack(shots), 30);
  const fired = E.merge(E.throttle(snapped, { on: 'shot', minGap: 0.06 }), snapped.only('land'));
  const ends = E.burstEnds(fired, { on: 'shot', gap: 0.15 });
  const cues = E.toCues(fired, { shot: { type: 'crack', gain: (e) => e.power }, land: { type: 'land', gain: 0.9 } }, { tails: ends });
  const json = JSON.parse(JSON.stringify({ cues }));
  const shapeOk = json.cues.every((c) => Number.isFinite(c.t) && typeof c.id === 'string' && typeof c.event === 'string' && (typeof c.type === 'string' || typeof c.file === 'string')
    && !('at' in c) && !('beat' in c) && !('key' in c) && !('index' in c) && (c.pan === undefined || (c.pan >= -1 && c.pan <= 1)) && (c.tail === undefined || typeof c.tail === 'boolean'));
  const ids = json.cues.map((c) => c.id);
  const tails = json.cues.filter((c) => c.tail === true).map((c) => c.id);
  ok(shapeOk && new Set(ids).size === ids.length && Math.abs(json.cues[0].t * 30 - Math.round(json.cues[0].t * 30)) < 1e-9,
    `toCues 输出形状：t（帧上）/ id（唯一）/ event / type / 透传 pan、power、t0；无 at/beat/key/index（${json.cues.length} 条）`);
  ok(JSON.stringify(tails) === JSON.stringify(['shot:4', 'shot:7']), `tails：每串最后一发 tail: true（${tails.join(' ')}），其余不写 tail`);
  ok(json.cues.find((c) => c.id === 'land-hero').pan === 0 && json.cues.find((c) => c.id === 'shot:0').pan === -0.4, 'pan 原样透传（含 0）');
  const viaEnd = E.toCues(E.merge(fired, ends), { shot: null, land: null, burstEnd: { type: 'boom', tail: true } });
  ok(viaEnd.length === 2 && viaEnd.every((c) => c.tail === true && c.event === 'burstEnd' && c.last && c.count > 0), 'burstEnd 事件直接映射成 tail: true 的 cue（带 last/count/start）');
  const over = E.toCues(E.eventTrack([{ t: 1, type: 'hit', rate: 9 }]), { hit: { type: 'thump', rate: undefined } });
  ok(!('rate' in over[0]), '模板写 undefined 可去掉透传的同名字段（事件的 rate 不会被当成播放速率）');
  const se = E.toSceneEvents(fired, { v: (e) => e.power });
  ok(se.every((e) => typeof e.id === 'string' && e.kind && 'pan' in e && !('type' in e)) && se[0].v === 0.8, 'toSceneEvents 透传 id / pan / 其余字段，事件类型进 kind');
  if (process.argv.includes('--print-cues')) console.log(JSON.stringify(json.cues, null, 1));
}

console.log(`\nevents 单测：${pass} 通过，${failN} 失败`);
process.exit(failN ? 1 : 0);
