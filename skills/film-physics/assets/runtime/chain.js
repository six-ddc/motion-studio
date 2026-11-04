// 一维跟随链：一串单元排成一列，每个单元只看它前面那一个，按"和前者的间距"调整自己的速度。
// 交通（跟车、幽灵堵车、红绿灯起步）、排队（窗口前的队伍挪动）、列车/传送带上的一串货、
// 任何"信号沿着一串单元逆着运动方向传回去"的东西，都是这一类。
//
// 模型：最优速度模型（OVM，Bando 等 1995）+ 可关的运动学安全刹车。
//   dv_i/dt = a·( V(h_i) − v_i )                       h_i = 前者位置 − 自己位置（车头到车头）
//   安全项：正在逼近前者时，至少踩到"刚好在前者速度上停住"所需的减速度
// 参数的物理含义、稳定/失稳判据、两种失败模式见 references/chain.md。一句话：
//   κ  = 2·V'(h0)/a      管"堵不堵"：κ < 1 扰动衰减（"根本不堵"）；κ > 1 放大成堵，关安全项时成堵 ≈ 0.7–2 × efold
//   A* = a·(h0−hs)/V(h0) 管"撞不撞"：关安全项时 A* ≤ 1.15 失稳必撞、≥ 1.38 不撞（实测）
//   安全项开着永不撞，但它本身是阻尼，会把成堵门槛推高（a=1 要 κ≈4）。
//   用 chainDesign() 按物理量反解形状参数、chainProbe() 无头试跑，不要手扫 hc/w。
//
// 遵守策略 ② 的五条（replay.js 顶部）：
//   1. 全部可变量在 state 里，clone 完整复制（含步号 k、统计量）
//   2. 随机只用 hash01(seed, 步号, 单元号)；扰动时刻按"步号 × dt"判断，不用累加的浮点时间
//   3/4. 检查点由 replay.js 存 clone
//   5. tmp 是每步开头全部重写的草稿缓冲；perturb/leader 是只读参数（leader 必须是仿真时间的纯函数）
// 单位随意（米/秒、像素/秒都行），但所有长度（unitLen stopGap safeGap minDen L h0）和速度（vmax stopV …）
// 要一起换；默认值是米和秒。Node 与浏览器通用。
import { hash01 } from './rand.js';

// 最优速度函数（tanh 形）。V(hs) = 0（hs = unitLen + stopGap，停住时的车头间距），V(∞) = vmax − V0(hs)。
export function ovFunction({ vmax, hc, w, hs }) {
  const V0 = (h) => (vmax / 2) * (1 + Math.tanh((h - hc) / w));
  const off = V0(hs);
  return {
    V: (h) => Math.max(0, V0(h) - off),
    dV: (h) => (h <= hs ? 0 : (vmax / (2 * w)) / Math.cosh((h - hc) / w) ** 2),
    vInf: vmax - off,
  };
}

// 线性稳定性分析（均匀流 h ≡ h0, v ≡ V(h0) 上加小扰动）。
//   特征方程 σ² + aσ = a·V'·(e^{iθ} − 1)，θ 是相邻单元间的相位差。
//   环：θ_k = 2πk/n，k = 1..n−1（只有这些模态存在）；直路：θ ∈ (0, π] 连续。
//   growth = max Re σ（1/s）。> 0 失稳，e 倍放大时间 = 1/growth。
// 判据 V' > a/2（κ > 1）是长波极限；环上单元少时最不稳定的模态是离散的，growth 以这里算的为准。
export function chainAnalyze({ V, dV, a, h0, n, ring = true, hs = null }) {
  const vp = dV(h0);
  let growth = -Infinity, theta = 0;
  const thetas = ring ? Array.from({ length: n - 1 }, (_, k) => (2 * Math.PI * (k + 1)) / n)
    : Array.from({ length: 256 }, (_, k) => (Math.PI * (k + 1)) / 256);
  for (const th of thetas) {
    // disc = a² + 4aV'(cosθ − 1 + i sinθ)，σ = (−a + √disc)/2，取实部大的根
    const re = a * a + 4 * a * vp * (Math.cos(th) - 1), im = 4 * a * vp * Math.sin(th);
    const mod = Math.hypot(re, im);
    const sr = Math.sqrt((mod + re) / 2);
    const g = (-a + sr) / 2;
    if (g > growth) { growth = g; theta = th; }
  }
  const v0 = V(h0);
  // 余量比 A* = a·(h0 − hs)/v0 = "富余净距 / 一个松弛时间里走过的距离"。实测（references/chain.md）：
  // 纯 OVM（safety:false）A* ≤ 1.15 失稳后必撞，≥ 1.38 不撞（4 种几何 + 像素单位，共 40 组）。
  const slack = hs == null ? null : (a * (h0 - hs)) / v0;
  if (theta > Math.PI) theta = 2 * Math.PI - theta;                  // θ 与 2π−θ 增长率相同，折到 (0, π]
  return {
    h0, v0, slope: vp, kappa: (2 * vp) / a,
    regime: vp > a / 2 ? 'unstable' : 'stable',
    growth, efold: growth > 0 ? 1 / growth : Infinity, theta,
    waves: ring ? Math.round((theta * n) / (2 * Math.PI)) : null,   // 环上最不稳定模态的波数（一圈几个堵团）
    slack,
    // 运动学波速（长波、实验室系，负 = 逆着运动方向传）：c = V(h0) − h0·V'(h0)
    waveSpeed: v0 - h0 * vp,
  };
}

// 按物理量反解 OV 函数参数。你给"想要什么"，它算 hc、w：
//   h0       平衡车头间距（环：L/n）     vCruise  平衡速度 V(h0)        vFree  前方无限空时的速度 V(∞)
//   a        敏感度 1/s（= 1/反应松弛时间） kappa    失稳裕度 2V'(h0)/a（< 1 稳定，> 1 失稳）
// 返回 { params（可直接展开给 chain()）, analysis }。不可行时抛错并说明原因（不默默给个凑合的）。
export function chainDesign({ n = 22, ring = true, L = null, h0 = null, unitLen = 3.8, stopGap = 0.5,
  vCruise = 8.33, vFree = 11.1, a = 1, kappa = 4 } = {}) {
  const hs = unitLen + stopGap;
  if (ring) { if (L == null) L = n * (h0 ?? 10.45); h0 = L / n; }
  else if (h0 == null) throw new Error('chainDesign: 直路需要 h0（平衡车头间距）');
  if (!(h0 > hs)) throw new Error(`chainDesign: 平衡间距 h0=${h0.toFixed(2)} ≤ 停车间距 unitLen+stopGap=${hs.toFixed(2)}，单元塞不下`);
  if (!(vCruise > 0 && vCruise < vFree)) throw new Error('chainDesign: 需要 0 < vCruise < vFree');
  // 三个约束：V(∞)=vFree、V(h0)=vCruise、V'(h0)=κa/2。令 u0=(h0−hc)/w，前两个把 w、vmax 写成 u0 的函数，
  // V'(h0) 随 u0 单调下降 → 对 u0 二分。u0 上限取 lo+3（再往上 vmax 指数爆炸、数值抵消），对应可达的最缓斜率。
  const slope = (kappa * a) / 2, D = h0 - hs, rho = vCruise / vFree;
  const lo = Math.atanh(2 * rho - 1);
  const shapeAt = (u0) => {
    const T0 = Math.tanh(u0), Ts = (T0 - rho) / (1 - rho), us = Math.atanh(Ts);
    const w = D / (u0 - us), vmax = (2 * vFree) / (1 - Ts);
    return { w, vmax, hc: h0 - u0 * w, slope: (vmax / (2 * w)) * (1 - T0 * T0) };
  };
  const minSlope = shapeAt(lo + 3).slope;
  if (!(slope > minSlope)) {
    throw new Error(`chainDesign: kappa=${kappa} 在 a=${a} 下做不到：这组 h0/hs/vCruise/vFree 要求 V'(h0) ≥ ${minSlope.toFixed(3)}/s，`
      + `即 κ ≥ ${(2 * minSlope / a).toFixed(2)}。要更稳就加大 a（反应更快）、拉开 h0−hs，或让 vCruise 更接近 vFree`);
  }
  let uLo = lo + 1e-9, uHi = lo + 3;
  for (let it = 0; it < 200; it++) { const m = (uLo + uHi) / 2; if (shapeAt(m).slope > slope) uLo = m; else uHi = m; }
  const { vmax, hc, w } = shapeAt((uLo + uHi) / 2);
  const params = { n, ring, L, h0, unitLen, stopGap, vmax, hc, w, a };
  const ov = ovFunction({ vmax, hc, w, hs });
  return { params, analysis: chainAnalyze({ ...ov, a, h0, n, ring, hs }) };
}

export function chain({
  n = 22, ring = true, L = null, h0 = null, unitLen = 3.8, stopGap = 0.5,
  vmax = 11.1, hc = 9.32, w = 2.06, a = 1,
  safety = true, safeGap = 0.3, safeOnset = 0, minDen = 0.2,
  perturb = [],        // [{ unit, t, dur, decel }]：仿真时间 t 起持续 dur 秒，unit 至少以 decel 减速
  leader = null,       // 直路：(tSim) => ({ x, v }) 或 null（前方空）。x 与单元同一参考点；停止线 X 写 { x: X + unitLen, v: 0 }
  start = 'uniform',   // 'uniform' 等距平衡速度 / 'queue' 首尾相接静止（排队、红灯前）
  jitter = 0, noise = 0, seed = 1, stopV = 0.3,
} = {}) {
  const hs = unitLen + stopGap;
  if (ring) { if (L == null) L = n * (h0 ?? 10.45); h0 = L / n; }
  else if (h0 == null) h0 = start === 'queue' ? hs : 10.45;
  const { V, dV } = ovFunction({ vmax, hc, w, hs });
  const byUnit = Array.from({ length: n }, () => []);
  for (const p of perturb) {
    if (!(p.unit >= 0 && p.unit < n)) throw new Error(`chain: perturb.unit=${p.unit} 越界`);
    byUnit[p.unit].push(p);
  }
  const tmp = new Float64Array(n);                                   // 草稿：每步开头全部重写
  let LH = 0, LV = 0;                                                // lead() 的两个返回值（草稿，调用即覆盖）
  const lead = (s, i, t) => {                                        // 车头间距 → LH，前者速度 → LV
    if (i + 1 < n) { LH = s.x[i + 1] - s.x[i]; if (ring && LH < 0) LH += L; LV = s.v[i + 1]; return; }
    if (ring) { LH = s.x[0] - s.x[i]; if (LH < 0) LH += L; LV = s.v[0]; return; }
    const ld = leader ? leader(t) : null;
    if (ld) { LH = ld.x - s.x[i]; LV = ld.v; } else { LH = Infinity; LV = s.v[i]; }
  };
  const analysis = chainAnalyze({ V, dV, a, h0, n, ring, hs });
  return {
    n, L, h0, ring, unitLen, V, analysis,
    init() {
      const s = { x: new Float64Array(n), v: new Float64Array(n), ac: new Float64Array(n), odo: new Float64Array(n),
        k: new Float64Array(1), minGap: new Float64Array(1).fill(Infinity), firstStop: new Float64Array(1).fill(-1),
        stopped: new Uint8Array(n) };
      const gap0 = start === 'queue' ? hs : h0;
      for (let i = 0; i < n; i++) {
        s.x[i] = i * gap0 + (jitter ? jitter * (hash01(seed, i, 7) - 0.5) : 0);
        if (ring && (s.x[i] < 0 || s.x[i] >= L)) s.x[i] = ((s.x[i] % L) + L) % L;   // 只在越界时取模：(x+L)%L 会引入舍入
        s.v[i] = start === 'queue' ? 0 : V(h0);
      }
      if (start === 'queue') { s.stopped.fill(1); s.firstStop[0] = 0; }   // 排队起步：一开始就全停着
      return s;
    },
    clone: (s) => ({ x: s.x.slice(), v: s.v.slice(), ac: s.ac.slice(), odo: s.odo.slice(), k: s.k.slice(),
      minGap: s.minGap.slice(), firstStop: s.firstStop.slice(), stopped: s.stopped.slice() }),
    step(s, dt) {
      const k = s.k[0], t = k * dt;                                  // 步号是唯一时钟
      const { x, v } = s;
      for (let i = 0; i < n; i++) {
        lead(s, i, t); const h = LH, vl = LV;
        let acc = a * (V(h) - v[i]);
        if (safety && v[i] > vl && h < Infinity) {
          const need = (v[i] * v[i] - vl * vl) / (2 * Math.max(minDen, h - unitLen - safeGap));
          if (need > safeOnset) acc = Math.min(acc, -need);
        }
        for (const p of byUnit[i]) if (t >= p.t && t < p.t + p.dur) acc = Math.min(acc, -p.decel);
        if (noise) acc += noise * (2 * hash01(seed, k, i) - 1);
        tmp[i] = acc;
      }
      for (let i = 0; i < n; i++) {
        const nv = Math.max(0, v[i] + tmp[i] * dt);
        s.ac[i] = (nv - v[i]) / dt;                                  // 实际加速度（被 0 截断后），刹车灯之类读它
        v[i] = nv;
        x[i] += nv * dt; if (ring && x[i] >= L) x[i] -= L;
        s.odo[i] += nv * dt;
      }
      const tEnd = (k + 1) * dt;
      for (let i = 0; i < n; i++) {
        if (ring || i + 1 < n) { lead(s, i, tEnd); if (LH - unitLen < s.minGap[0]) s.minGap[0] = LH - unitLen; }
        if (v[i] < stopV && !s.stopped[i]) { s.stopped[i] = 1; if (s.firstStop[0] < 0) s.firstStop[0] = tEnd; }
      }
      s.k[0] = k + 1;
    },
    gap: (s, i) => { if (!ring && i + 1 >= n) return Infinity; lead(s, i, 0); return LH - unitLen; },  // 净距；直路最前一个返回 Infinity
    // 一组单元（pred(i) 为真）的中心位置：环上用圆周平均，直路用算术平均；没有返回 null
    center(s, pred) {
      let sx = 0, sy = 0, m = 0;
      for (let i = 0; i < n; i++) if (pred(i)) {
        if (ring) { const th = (s.x[i] / L) * 2 * Math.PI; sx += Math.cos(th); sy += Math.sin(th); } else sx += s.x[i];
        m++;
      }
      if (!m) return null;
      return ring ? ((((Math.atan2(sy, sx) / (2 * Math.PI)) * L) + L) % L) : sx / m;
    },
    pack: (s) => [s.x, s.v, s.ac],
  };
}

// 无头试跑：给一组参数，跑 T 秒仿真时间，报告"会不会撞、会不会堵、什么时候堵、堵往哪走多快"。
// 22 个单元 × 180 s × 240 Hz 约 50 ms（Node，仓库 docs/verified/film-physics.md），在 Node 里调参或在场景 ready 里自检都行。
// 判据：堵 = 速度极差 > jamSpread·V(h0)（默认 0.5）；堵团中心 = 速度 < 0.5·V(h0) 的单元的中心，
// 对后 40% 时段做线性回归得 jamSpeed（负 = 逆着运动方向）。
export function chainProbe(opts, { T = 120, hz = 240, jamSpread = 0.5 } = {}) {
  const sim = chain(opts), s = sim.init(), dt = 1 / hz, v0 = sim.analysis.v0;
  let firstJam = -1, prev = null, unwrapped = 0; const track = [];
  const N = Math.round(T * hz), every = Math.max(1, Math.round(hz / 10));
  for (let k = 0; k < N; k++) {
    sim.step(s, dt);
    if (k % every) continue;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < sim.n; i++) { lo = Math.min(lo, s.v[i]); hi = Math.max(hi, s.v[i]); }
    const t = (k + 1) * dt;
    if (firstJam < 0 && hi - lo > jamSpread * v0) firstJam = t;
    const c = sim.center(s, (i) => s.v[i] < 0.5 * v0);
    if (c == null) { prev = null; continue; }
    if (prev != null) { let d = c - prev; if (sim.ring) { if (d > sim.L / 2) d -= sim.L; if (d < -sim.L / 2) d += sim.L; } unwrapped += d; }
    prev = c; track.push([t, unwrapped]);
  }
  const tail = track.filter(([t]) => t > T * 0.6);
  let jamSpeed = null;
  if (tail.length > 5) {
    const mt = tail.reduce((p, q) => p + q[0], 0) / tail.length, mx = tail.reduce((p, q) => p + q[1], 0) / tail.length;
    let nu = 0, de = 0; for (const [t, x] of tail) { nu += (t - mt) * (x - mx); de += (t - mt) ** 2; }
    jamSpeed = nu / de;
  }
  let vmin = Infinity, vmean = 0; for (let i = 0; i < sim.n; i++) { vmin = Math.min(vmin, s.v[i]); vmean += s.v[i] / sim.n; }
  return { analysis: sim.analysis, crashed: s.minGap[0] < 0, minGap: s.minGap[0], firstStop: s.firstStop[0] < 0 ? null : s.firstStop[0],
    firstJam: firstJam < 0 ? null : firstJam, jamSpeed, vmin, vmean, T };
}
