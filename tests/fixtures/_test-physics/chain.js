// film-physics 测试片：一维跟随链（runtime/chain.js）+ 影片时间→仿真时间映射（runtime/timemap.js）。
// 变体参数来自 window.CFG（入口 html 里设），全部是故意的 bug 或故意的坏参数，physcheck 必须红：
//   crash   安全项关掉 + a=1, κ=3（纯 OVM 失稳区）          → F "不撞" 红
//   nojam   a=2, κ=0.9（稳定区）                              → F "堵成了" 红
//   leak=ref   检查点存引用                                    → B/C 红
//   leak=flag  扰动"已触发"开关放在闭包里而不是 state 里       → B/C 红（第一个检查点之后才露馅）
//   warp=accum    seek 里累加 simT += rate·Δt                  → B/C/E4 红
//   warp=inverted stateAt(S.inv(t))（映射传反）               → 只有 E4 红，B/C/D 全过
//   warp=coarse   0.25× 慢镜头 + 仿真查询栅格 60/s，影片 60 fps → 只有 E3 红
//   warp=slowmo   同一条慢镜头映射，查询栅格改成 240/s（dt 不变）→ 全绿（coarse 的修好版）
import { makeLayout } from './runtime/layout.js';
import { createReplay } from './runtime/replay.js';
import { chain, chainDesign, chainProbe } from './runtime/chain.js';
import { timeMap, fitRate } from './runtime/timemap.js';

const CFG = window.CFG || {};
const L = makeLayout(new URLSearchParams(location.search).get('format') || '9x16');
const canvas = document.getElementById('stage');
canvas.width = L.width; canvas.height = L.height;
const ctx = canvas.getContext('2d', { alpha: false });

export function mountChain() {
  const PERTURB_T = 2;                                                   // 仿真秒
  const perturb = [{ unit: 0, t: PERTURB_T, dur: 1.2, decel: 2 }];
  let opts = { perturb };                                                // 默认参数（= ghost-jam 实测可用的一组）
  if (CFG.crash) opts = { ...chainDesign({ a: 1, kappa: 3 }).params, safety: false, perturb };
  if (CFG.nojam) opts = { ...chainDesign({ a: 2, kappa: 0.9 }).params, perturb };
  let sim = chain(opts);
  if (CFG.leak === 'flag') {
    // ✗ 常见写法：用一个闭包里的开关记"扰动打过了没有"。回退到扰动之前的检查点时开关不会复位。
    const base = chain({ ...opts, perturb: [] });
    let fired = false;
    sim = { ...base, step(s, dt) {
      const t = s.k[0] * dt;
      if (!fired && t >= PERTURB_T) { fired = true; for (let i = 0; i < s.v.length; i++) if (i === 0) s.v[i] = Math.max(0, s.v[i] - 2.4); }
      base.step(s, dt);
    } };
  }
  // 时间映射：片头 1×，然后加速到 W×，最后回到 1×。W 反解自"第一辆停住的仿真时刻落在影片 6.0 s"。
  const fpsFilm = 60, D = 8;
  const probe = chainProbe(opts, { T: 90 });
  const stopSim = probe.firstStop ?? 40;                                 // nojam 时没有停车，随便给个值让映射成立
  const build = (W) => timeMap([{ t: 0, rate: 1 }, { t: 1.5, rate: 1 }, { t: 2.5, rate: W }, { t: 6.5, rate: W }, { t: 7.5, rate: 1 }]);
  let S = build(fitRate(build, 6.0, stopSim, { lo: 1, hi: 40 }));
  let simFps = 240, substeps = 1;
  if (CFG.warp === 'coarse' || CFG.warp === 'slowmo') { S = timeMap([{ t: 0, rate: 1 }, { t: 1, rate: 0.25 }, { t: 7, rate: 0.25 }]); simFps = 60; substeps = 4; }
  if (CFG.warp === 'slowmo') { simFps = 240; substeps = 1; }           // 修好的版本：dt 不变（1/240），查询栅格 60 → 240/仿真秒
  const R = createReplay({ fps: simFps, substeps, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1, leak: CFG.leak === 'ref' ? 'ref' : null });

  let acc = 0, lastT = 0;                                                // 只给 warp=accum 用（故意的跨帧状态）
  const simTimeOf = (t) => {
    if (CFG.warp === 'accum') { acc += S.rate(t) * (t - lastT); lastT = t; return acc; }   // ✗
    if (CFG.warp === 'inverted') return S.inv(t);                                          // ✗
    return S(t);
  };
  const cx = L.width / 2, cy = L.height / 2, rad = L.width * 0.38, n = sim.n;
  function frame(t) {
    const s = R.stateAt(simTimeOf(t));
    ctx.fillStyle = '#101418'; ctx.fillRect(0, 0, L.width, L.height);
    ctx.strokeStyle = '#2a3038'; ctx.lineWidth = 28; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < n; i++) {
      const th = (s.x[i] / sim.L) * Math.PI * 2 - Math.PI / 2;
      const brake = Math.min(1, Math.max(0, (-s.ac[i] - 0.8) / 0.5)), slow = Math.min(1, Math.max(0, (2.4 - s.v[i]) / 0.8));
      ctx.fillStyle = Math.max(brake, slow) > 0.5 ? '#e0603a' : '#e8e2d4';
      ctx.beginPath(); ctx.arc(cx + Math.cos(th) * rad, cy + Math.sin(th) * rad, 16, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#7fb0c8'; ctx.fillRect(0, L.height - 20, L.width * (S(t) / S(D)), 20);   // 仿真时间进度条
    return s;
  }
  window.DURATION = D;
  window.seek = (t) => { frame(t); return true; };
  window.ready = Promise.resolve();
  const at = (t) => R.stateAt(S(t));                                     // 断言读的状态与画面同源（同一个 R、同一条 S）
  window.PHYS = {
    timeMap: S,
    parts: [{ name: 'chain', stats: R.stats, cps: R.checkpoints, stepsAt: R.stepsAt }],
    claims: CFG.warp ? [] : [
      { what: '不撞：全程最小净距 > 0', from: 0, to: D, test: (t) => { const g = at(t).minGap[0]; return { ok: g > 0, value: g }; } },
      { what: '扰动之前全员匀速（没有车在刹）', from: 0, to: S.inv(PERTURB_T) - 0.05, test: (t) => at(t).ac.every((a) => Math.abs(a) < 1e-9) },
      { what: '影片 6.0 s 之后至少一辆停住过', from: 6.05, to: D, test: (t) => at(t).firstStop[0] >= 0 },
    ],
  };
  window.__chain = { W: S.keys[2].rate, stopSim, probe: { ...probe, analysis: undefined }, analysis: sim.analysis };
}
