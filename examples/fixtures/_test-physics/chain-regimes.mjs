#!/usr/bin/env node
// 一维跟随链的参数区间实测（Node，无绘制）。产出 out/chain-regimes.txt，references/chain.md 的表就是它。
//   node tests/fixtures/_test-physics/chain-regimes.mjs [--T 180] [--n 22]
// 基准场景：环形 n=22、周长 230 m（h0=10.45 m）、单元长 3.8 m、停车净距 0.5 m、vCruise 8.33 m/s（30 km/h）、
// vFree 11.1 m/s（40 km/h）；仿真 t=5 s 时 0 号单元以 2 m/s² 减速 1.2 s（"轻轻慢了一下"）。dt = 1/240 s。
import { importRuntime } from '../../../skills/film-core/lib/runtime-node.mjs';
const { chain, chainDesign, chainProbe } = await importRuntime('chain.js');   // chain.js 里的 ./rand.js 在 film-core，按挂载语义解析
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const T = Number(flag('T', 180)), n = Number(flag('n', 22)), L = n * 230 / 22;
const perturb = [{ unit: 0, t: 5, dur: 1.2, decel: 2 }];
const f = (x, d = 1) => (x == null ? '—' : Number.isFinite(x) ? x.toFixed(d) : '∞');
console.log(`环 n=${n} L=${L.toFixed(0)} m  T=${T} s  扰动 t=5 s 2 m/s²×1.2 s   时间列都是"扰动后多少仿真秒"`);
console.log('a\tκ\tgrowth/s\te倍时间s\t| safety\t成堵s\t首停s\t最小净距m\t堵速km/h\tvmin');
for (const a of [1, 1.5, 2, 3]) for (const kappa of [0.9, 1.1, 1.3, 1.6, 2, 3, 4, 6]) {
  let d; try { d = chainDesign({ n, L, a, kappa }); } catch (e) { console.log(`${a}\t${kappa}\t不可行：${e.message.split('：')[1].split('。')[0]}`); continue; }
  for (const [lab, sp] of [['off', { safety: false }], ['on', { safety: true }], ['on@1', { safety: true, safeOnset: 1 }]]) {
    const t0 = process.hrtime.bigint();
    const p = chainProbe({ ...d.params, ...sp, perturb }, { T });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const rel = (x) => (x == null ? null : x - 5);
    console.log([a, kappa, f(d.analysis.growth, 3), f(d.analysis.efold), '|', lab, f(rel(p.firstJam)), f(rel(p.firstStop)), (p.crashed ? '撞 ' : '') + f(p.minGap, 2), p.jamSpeed == null ? '—' : f(p.jamSpeed * 3.6), f(p.vmin, 2), `${ms.toFixed(0)}ms`].join('\t'));
  }
}

// ── 第二段：撞车边界 A* = a(h0−hs)/v0 是否跨几何成立（纯 OVM，safety:false）──
console.log('\n撞车边界（safety:false）：A* = a·(h0−hs)/V(h0)，最小净距按 (h0−hs) 归一');
console.log('几何\ta\tκ\tA*\tefold s\t成堵s\t最小净距/(h0−hs)');
const geoms = [
  { tag: 'n22 L300', g: { n: 22, L: 300, vCruise: 8.33, vFree: 11.1 } },
  { tag: 'n40 L400 v5', g: { n: 40, L: 400, vCruise: 5, vFree: 8 } },
  { tag: 'n15 L230 v12', g: { n: 15, L: 230, vCruise: 12, vFree: 15 } },
  { tag: 'n22 像素×100', g: { n: 22, L: 23000, unitLen: 380, stopGap: 50, vCruise: 833, vFree: 1110 }, px: true },
];
for (const { tag, g, px } of geoms) for (const a of [0.8, 1, 1.5, 2, 3]) for (const kappa of [2, 3]) {
  const d = chainDesign({ ...g, a, kappa });
  const sc = px ? { safeGap: 30, minDen: 20, stopV: 30 } : {};
  const pp = perturb.map((q) => ({ ...q, decel: px ? 200 : q.decel }));
  const p = chainProbe({ ...d.params, ...sc, safety: false, perturb: pp }, { T });
  const room = d.params.h0 - d.params.unitLen - d.params.stopGap;
  console.log([tag, a, kappa, f(d.analysis.slack, 2), f(d.analysis.efold), f(p.firstJam == null ? null : p.firstJam - 5), (p.crashed ? '撞 ' : '') + f(p.minGap / room, 3)].join('\t'));
}

// ── 第三段：排队起步波、直路上的扰动放大 ──
{
  const n = 12, X = (n - 1) * 4.3 + 2;
  const sim = chain({ n, ring: false, start: 'queue', leader: (t) => (t < 3 ? { x: X + 3.8, v: 0 } : null) });
  const s = sim.init(), dt = 1 / 240, go = new Array(n).fill(null);
  for (let k = 0; k < 240 * 30; k++) { sim.step(s, dt); for (let i = 0; i < n; i++) if (go[i] == null && s.v[i] > 0.5) go[i] = (k + 1) * dt; }
  console.log('\n红灯起步（默认参数，12 辆排队，t=3 s 变绿）');
  console.log('  起步时刻（前→后）', go.slice().reverse().map((x) => f(x, 2)).join(' '), ' 最小净距', f(s.minGap[0], 2), 'm');
  for (const kappa of [1.5, 4]) {
    const d = chainDesign({ n: 40, ring: false, h0: 10.45, a: 2, kappa });
    const sim2 = chain({ ...d.params, leader: () => ({ x: 1e9, v: d.analysis.v0 }), perturb: [{ unit: 39, t: 2, dur: 1.2, decel: 2 }] });
    const s2 = sim2.init(), mv = new Array(40).fill(Infinity);
    for (let k = 0; k < 240 * 60; k++) { sim2.step(s2, dt); for (let i = 0; i < 40; i++) mv[i] = Math.min(mv[i], s2.v[i]); }
    console.log(`  直路 40 辆 a=2 κ=${kappa}：最低速（最前→最后，每 5 辆）`, mv.slice().reverse().filter((_, i) => i % 5 === 0).map((x) => f(x, 2)).join(' '), ' 最小净距', f(s2.minGap[0], 2), 'm');
  }
}
