// events.js / feel.js（film-physics）的 Node 数值断言。运行：node tests/fixtures/_test-events/tests/unit.mjs
// events.js import './rand.js'（在 film-core），用 film-core 的 registerRuntimeResolver 按挂载表语义解析。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { registerRuntimeResolver } = await import('file://' + join(ROOT, 'skills/film-core/lib/runtime-node.mjs'));
registerRuntimeResolver();
const E = await import('file://' + join(ROOT, 'skills/film-physics/assets/runtime/events.js'));
const F = await import('file://' + join(ROOT, 'skills/film-physics/assets/runtime/feel.js'));
const { hash01 } = await import('file://' + join(ROOT, 'skills/film-core/assets/runtime/rand.js'));

let pass = 0, failN = 0;
const ok = (c, msg, extra = '') => { if (c) pass++; else failN++; console.log(`${c ? '✓' : '✗'} ${msg} ${extra}`); };
const fmt = (x) => x.toExponential(2);

// RK4 积分 x'' = f(x, v, t)
function rk4(acc, x, v, t, dt) {
  const k1x = v, k1v = acc(x, v, t);
  const k2x = v + k1v * dt / 2, k2v = acc(x + k1x * dt / 2, k2x, t + dt / 2);
  const k3x = v + k2v * dt / 2, k3v = acc(x + k2x * dt / 2, k3x, t + dt / 2);
  const k4x = v + k3v * dt, k4v = acc(x + k3x * dt, k4x, t + dt);
  return [x + dt * (k1x + 2 * k2x + 2 * k3x + k4x) / 6, v + dt * (k1v + 2 * k2v + 2 * k3v + k4v) / 6];
}

// 1. 弹簧冲量核 vs 数值积分（三种阻尼）
for (const [name, p] of [['欠阻尼 ζ≈0.69', { k: 150, c: 17 }], ['临界 ζ=1', { k: 100, c: 20 }], ['过阻尼 ζ=2', { k: 64, c: 32 }]]) {
  const h = E.springKick(p);
  let x = 0, v = 1, err = 0; const dt = 1e-4;
  for (let i = 1; i <= 20000; i++) { [x, v] = rk4((x, v) => -p.k * x - p.c * v, x, v, 0, dt); err = Math.max(err, Math.abs(x - h(i * dt))); }
  ok(err < 1e-10, `springKick ${name} 与 RK4(dt=1e-4, 2s) 最大误差`, fmt(err));
}
// 速度
{ const h = E.springKick({ k: 150, c: 17 }); const d = 1e-6; let err = 0;
  for (let t = 0.01; t < 1; t += 0.013) err = Math.max(err, Math.abs((h(t + d) - h(t - d)) / (2 * d) - h.velocity(t)));
  ok(err < 1e-6, 'springKick.velocity 与中心差分', fmt(err)); }

// 随机事件表
const evs = []; for (let i = 0; i < 40; i++) evs.push({ t: 0.2 + 9.5 * hash01(5, i, 1), type: i % 3 ? 'hit' : 'blast', power: 0.3 + hash01(5, i, 2) });
const T = E.eventTrack(evs);
ok(T.length === 40 && T.times.every((x, i) => i === 0 || x >= T.times[i - 1]), 'eventTrack 排序、补 id');
ok(T.of('hit')[0].id === 'hit#' + evs.filter((e) => e.type === 'hit').findIndex((e) => e.t === T.of('hit')[0].t), 'id 按本类型原表顺序编号');
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
  for (let i = 0; i <= 100000; i++) { const t = i * dt; while (k < hits.length && hits[k].t <= t) { // 冲量在 hits[k].t 精确施加：先倒退到 t_k
      v += hits[k].power; k++; }
    if (i % 50 === 0 && t > 0.3) err2 = Math.max(err2, Math.abs(x - dip(t)));
    [x, v] = rk4((x, v) => -300 * x - 14 * v, x, v, t, dt); }
  ok(err2 < 0.02 * 0.12, 'springDip 与冲量序列 RK4 模拟（冲量落在 1e-4 栅格上，误差来自时刻量化）', fmt(err2));
}

// 3. 节流 vs 朴素冷却计时器模拟
{
  const dense = E.eventTrack(Array.from({ length: 300 }, (_, i) => ({ t: 10 * hash01(9, i, 0), type: 'hit' })));
  const th = E.throttle(dense, { on: 'hit', minGap: 0.09, maxPerWindow: { n: 4, span: 0.6 } });
  // 朴素：0.1 ms 一步推进，冷却计时器递减；窗口用"最近触发时刻"列表
  const kept = []; let cool = 0, k = 0; const ev = dense.events, dt = 1e-4; let lastT = 0;
  for (let i = 0; i <= 101000 && k < ev.length; i++) {
    const t = i * dt; cool -= t - lastT; lastT = t;
    while (k < ev.length && ev[k].t <= t) {
      const e = ev[k++]; const recent = kept.filter((x) => x > e.t - 0.6).length;
      const since = kept.length ? e.t - kept[kept.length - 1] : Infinity;
      if (since >= 0.09 && recent < 4) kept.push(e.t);
    }
  }
  ok(kept.length === th.length && kept.every((x, i) => x === th.times[i]), `throttle 与逐事件朴素模拟一致（${th.length}/300 触发，${th.dropped.length} 丢弃）`);
  let gapOk = true; for (let i = 1; i < th.length; i++) if (th.times[i] - th.times[i - 1] < 0.09) gapOk = false;
  ok(gapOk, 'throttle 结果相邻间隔 ≥ minGap');
  // 优先级：结果满足约束，且每个被丢的事件都和某个优先级 ≥ 它的已触发事件冲突
  const pr = (e) => hash01(9, e.index, 7);
  const tp = E.throttle(dense, { on: 'hit', minGap: 0.09, priority: pr });
  let g2 = true; for (let i = 1; i < tp.length; i++) if (tp.times[i] - tp.times[i - 1] < 0.09) g2 = false;
  const keptP = tp.events.map((e) => ({ t: e.t, p: pr(dense.events.find((d) => d.id === e.id)) }));
  const justified = tp.dropped.every((d) => keptP.some((q) => Math.abs(q.t - d.t) < 0.09 && q.p >= pr(d)));
  ok(g2 && justified, `throttle(priority) 满足 minGap，且每个丢弃都被更高优先级的触发事件挡住（${tp.length} 触发）`);
  const be = E.burstEnds(E.eventTrack([0, 0.08, 0.16, 1, 1.05, 3].map((t) => ({ t, type: 'shot' }))), { on: 'shot', gap: 0.1, delay: 0.1, type: 'tail' });
  ok(be.length === 3 && Math.abs(be.times[0] - 0.26) < 1e-12 && be.events[0].count === 3 && be.events[1].count === 2, 'burstEnds：3 串连射，尾音在最后一发 +0.1s');
}

// 4. 帧对齐 + 最短可见：每个 50 ms 闪光在 30 fps 下至少落在 N=2 帧
{
  const fps = 30, N = 2; const fl = E.flashDecay(0.05);
  const raw = E.eventTrack(Array.from({ length: 200 }, (_, i) => ({ t: 1 + 20 * hash01(3, i, 0), type: 'flash' })));
  const countFrames = (track, k) => track.events.map((e) => { let c = 0; for (let K = Math.floor(e.t * fps) - 2; K < e.t * fps + 10; K++) if (k(K / fps - e.t) > 0) c++; return c; });
  const before = countFrames(raw, fl);
  const snapped = E.snapToFrames(raw, fps, { minFrames: N });
  const after = countFrames(snapped, E.holdFrames(fl, { fps, minFrames: N }));
  ok(Math.min(...before) < N, `对照：不对齐时最少只落在 ${Math.min(...before)} 帧（${before.filter((c) => c < N).length}/200 个少于 ${N} 帧）`);
  ok(Math.min(...after) >= N, `snapToFrames + holdFrames 后每个闪光至少 ${N} 帧（最少 ${Math.min(...after)}）`);
  const shift = Math.max(...snapped.events.map((e) => Math.abs(e.t - e.t0)));
  ok(shift <= 0.5 / fps + 1e-12, 'round 对齐挪动 ≤ 半帧', fmt(shift));
  ok(snapped.events.every((e) => Math.round(e.t * fps) / fps === e.t), '对齐后 τ 在帧上恰为 0（K/fps 逐位相等）');
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

// 6. recoil（保持被重置）vs 游戏式定步逻辑
{
  const shots = E.eventTrack([...Array.from({ length: 12 }, (_, i) => ({ t: 0.5 + i * 0.083, type: 'shot' })), { t: 3, type: 'shot' }, { t: 3.06, type: 'shot' }]);
  const opt = { on: 'shot', amount: 0.01, keep: 0.35, rise: 1 / 34, hold: 0.09, fall: 1 / 6.5, max: 0.3 };
  const rc = F.recoil(shots, opt);
  let P = 0, x = 0, b = 0, A = 0, k = 0, err = 0; const dt = 1e-5;
  for (let i = 0; i <= 500000; i++) { const t = i * dt;
    while (k < shots.length && shots.times[k] <= t) { P += 0.35 * 0.01; x = Math.min(0.3, x + 0.65 * 0.01); A = 0.09; k++; }
    if (i % 503 === 0) { const r = rc(t); err = Math.max(err, Math.abs(r.visual - b), Math.abs(r.target - x), Math.abs(r.permanent - P)); }
    // 游戏式每步（和原游戏同一写法：kn 指数逼近 + 保持计时器），不调用被测代码
    A -= dt; if (A <= 0) x *= Math.exp(-6.5 * dt);
    b = x + (b - x) * Math.exp(-34 * dt);
  }
  ok(err < 5e-6, 'recoil 与游戏式 1e-5 s 定步（保持计时器每发重置，不调被测代码）最大误差', fmt(err));
  // 线性 riseHoldFall 核 vs 欧拉细步
  const kr = E.riseHoldFall({ rise: 0.03, hold: 0.09, fall: 0.15 });
  let xx = 1, bb = 0, e2 = 0;
  for (let i = 1; i <= 100000; i++) { const t = i * 1e-5; if (t > 0.09) xx *= Math.exp(-1e-5 / 0.15); bb += (xx - bb) * (1 - Math.exp(-1e-5 / 0.03)); if (i % 97 === 0) e2 = Math.max(e2, Math.abs(bb - kr(t))); }
  ok(e2 < 5e-4, 'riseHoldFall 核与 1e-5 s 指数步进', fmt(e2));
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
  const all = (t) => JSON.stringify([fl(t), tf(t), rc(t), ap(t), dp(t), sparks(t), sparks.active(t).map((a) => [a.e.id, a.tau, a.rnd(3)]), F.traumaShake(t, tf(t), { amp: { pitch: 0.03, yaw: 0.03, roll: 0.045 }, terms }), E.countRing(T, t, { on: 'hit', size: 8, fade: 3 }).map((r) => r.alpha)]);
  const ts = Array.from({ length: 600 }, (_, i) => i / 60);
  const seq = ts.map(all);
  const perm = ts.map((_, i) => i).sort((a, b) => hash01(1, a) - hash01(1, b));
  const out = new Array(ts.length); for (const i of perm) out[i] = all(ts[i]);
  ok(out.every((s, i) => s === seq[i]), '9 个通道乱序求值与顺序求值逐位相同（600 帧）');
}

// 8. 其它
{
  const ring = E.countRing(T, 99, { on: 'hit', size: 10, fade: 4 });
  ok(ring.length === 10 && ring[0].alpha === 0.2 && ring[9].alpha === 1 && ring[5].alpha === 1, 'countRing：最老 4 个渐隐 0.2..0.8', ring.map((r) => r.alpha).join(','));
  const cues = E.toCues(E.eventTrack([{ t: 1, type: 'hit', power: 0.5 }, { t: 2, type: 'quiet' }]), { hit: { type: 'thump', gain: (e) => e.power }, quiet: null });
  ok(JSON.stringify(cues) === '[{"t":1,"type":"thump","gain":0.5}]', 'toCues 生成 sfx cue', JSON.stringify(cues));
  let threw = false; try { E.toCues(T, { hit: { type: 'x' } }); } catch { threw = true; }
  ok(threw, 'toCues 遇到没列出的事件类型报错');
  const circ = F.arcTable((t) => [Math.cos(t), Math.sin(t)], { t0: 0, t1: 2 * Math.PI, n: 4096 });
  ok(Math.abs(circ.length - 2 * Math.PI) < 1e-5, 'arcTable 单位圆弧长', fmt(circ.length - 2 * Math.PI));
  const arc = (t) => Math.min(t, 3.37) * 1.4; // 3.37 s 停下
  const h = F.stepPhase(10, { arc, stride: 1.55, stops: [[3.37, Infinity]], snapRate: 8 });
  ok(Math.abs(h - Math.round(h)) < 1e-6, '停下 6.6 s 后相位吸附到整步', h.toFixed(9));
  const h2 = F.stepPhase(5, { arc: (t) => t * 1.4, stride: 1.55, stops: [[2, 2.5]], snapRate: 8 });
  const h2b = F.stepPhase(5 + 1e-7, { arc: (t) => t * 1.4, stride: 1.55, stops: [[2, 2.5]], snapRate: 8 });
  ok(Math.abs(h2b - h2) < 1e-6, '再走之后相位连续');
  const s0 = { pos: [0, 2, 5], target: [1, 1, 0], fov: 40 };
  const s1 = F.perturbShot(s0, { pitch: 0.1, yaw: -0.2, roll: 0.05 });
  const d = (s) => Math.hypot(...s.target.map((x, i) => x - s.pos[i]));
  ok(Math.abs(d(s1) - d(s0)) < 1e-12 && s1.fov === 40 && s1.roll === 0.05, 'perturbShot 不改注视距离、保留其余字段');
  const up = F.perturbShot({ pos: [0, 0, 0], target: [0, 0, -1] }, { pitch: 0.1 });
  ok(up.target[1] > 0, 'pitch > 0 抬头');
  // lagOffset vs RK4：父物体 pos = 平滑起停
  const P = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));
  let y = 0, v = 0, e3 = 0; const dt = 1e-4; const acc = (t) => (P(t + 1e-4) - 2 * P(t) + P(t - 1e-4)) / 1e-8;
  for (let i = 0; i < 20000; i++) { const t = i * dt; if (i % 200 === 0) e3 = Math.max(e3, Math.abs(y - F.lagOffset(t, P, { k: 110, c: 15, span: 1.5, steps: 600 }))); [y, v] = rk4((y, v, tt) => -110 * y - 15 * v - acc(tt), y, v, t, dt); }
  ok(e3 < 1e-4, 'lagOffset（Simpson 600 段）与 RK4 子物体模拟', fmt(e3));
  ok(F.cruise(0.5, 0.25) === 0.5 && F.cruise(0, 0.25) === 0 && F.cruise(1, 0.25) === 1, 'cruise 端点与中点');
}

console.log(`\nevents 单测：${pass} 通过，${failN} 失败`);
process.exit(failN ? 1 : 0);
