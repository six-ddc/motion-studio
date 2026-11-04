// 影片时间 t → 仿真时间 S(t)。叙事片里"没过几分钟"压进 3 秒、慢镜头、定格，都是这条映射。
//
//   const S = timeMap([{ t: 0, rate: 1 }, { t: 6, rate: 1 }, { t: 7, rate: 5 }, { t: 12, rate: 5 }, { t: 13, rate: 1 }]);
//   window.seek = (t) => { const s = R.stateAt(S(t)); ... };      // 永远是 stateAt(S(t))
//
// 为什么这样就仍然合法：stateAt(x) 是 x 的纯函数，S 是 t 的纯函数 → 复合仍是 t 的纯函数。
// 检查点按仿真步存（createReplay 的 fps/substeps 是**仿真**时间的步频，与影片 fps 无关），查询走 S(t)，
// 两者不需要任何额外配合。会出错的只有下面几种写法，physcheck 的 E 组逐条抓（references/timemap.md）：
//   ✗ 在 seek 里累加：simT += rate(t) * (t − lastT)          → 跨帧状态，乱序就错（E 不用管，B/C 已红）
//   ✗ 传反：stateAt(S.inv(t)) 或 stateAt(t)（忘了映射）     → 确定性的，B/C/D 全过；E4 "喂给 stateAt 的步数 ≠ S(t)" 抓
//   ✗ 慢镜头时仿真步频太粗：rate·fps_sim < fps_film·sub     → 相邻帧落在同一步，画面一顿一顿；E3 抓
//   ✗ 仿真里的参数（扰动时刻、事件时刻）写成影片时间        → 用 S(t影片) 换算；反过来事件回影片用 S.inv
//
// keys：按 t 升序的 { t, rate, ease }。ease 描述"从上一个 key 过渡到这个 key"：
//   'smooth'（默认，smoothstep，倍率 C¹ 连续）/ 'linear' / 'step'（到这个 key 的时刻瞬间切换，用在硬切镜头）
// 第一个 key 之前按第一个 rate 外推，最后一个之后按最后一个 rate 外推。
// rate = 0 是定格（S 不动，仿真不推进）；rate < 0 是倒放，默认拒绝（要 { reverse: true }）——倒放仍是纯函数，
// 但每帧都走"回退到检查点 + 重放"路径，最坏单帧 = 一个检查点间隔的步数。
// s0：S(keys[0].t) 的值。片头就想看到"已经跑了 60 秒"的稳态时用（冷启动代价 O(s0)）。
const E = {
  smooth: (u) => u * u * u - (u * u * u * u) / 2,   // ∫₀ᵘ (3x² − 2x³) dx
  linear: (u) => (u * u) / 2,
  step: () => 0,
};
const W = { smooth: (u) => u * u * (3 - 2 * u), linear: (u) => u, step: (u) => (u >= 1 ? 1 : 0) };

export function timeMap(keys, { s0 = 0, reverse = false } = {}) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('timeMap: 至少要一个 key');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!Number.isFinite(k.t) || !Number.isFinite(k.rate)) throw new Error(`timeMap: key ${i} 的 t/rate 不是有限数`);
    if (i && !(k.t > keys[i - 1].t)) throw new Error(`timeMap: key ${i} 的 t=${k.t} 没有严格递增`);
    if (k.rate < 0 && !reverse) throw new Error(`timeMap: key ${i} rate=${k.rate} < 0（倒放要显式 { reverse: true }）`);
    if (k.ease && !E[k.ease]) throw new Error(`timeMap: 未知 ease "${k.ease}"`);
  }
  const ks = keys.map((k) => ({ t: k.t, rate: k.rate, ease: k.ease ?? 'smooth' }));
  const cum = [s0];
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1], b = ks[i], d = b.t - a.t;
    cum.push(cum[i - 1] + d * (a.rate + (b.rate - a.rate) * E[b.ease](1)));
  }
  const seg = (t) => { let lo = 0, hi = ks.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ks[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  const S = (t) => {
    if (t <= ks[0].t) return s0 + ks[0].rate * (t - ks[0].t);
    const i = seg(t);
    if (i === ks.length - 1) return cum[i] + ks[i].rate * (t - ks[i].t);
    const a = ks[i], b = ks[i + 1], d = b.t - a.t, u = (t - a.t) / d;
    return cum[i] + d * (a.rate * u + (b.rate - a.rate) * E[b.ease](u));
  };
  S.rate = (t) => {
    if (t <= ks[0].t) return ks[0].rate;
    const i = seg(t);
    if (i === ks.length - 1) return ks[i].rate;
    const a = ks[i], b = ks[i + 1], u = (t - a.t) / (b.t - a.t);
    return a.rate + (b.rate - a.rate) * W[b.ease](u);
  };
  // 反函数：仿真时刻 → 影片时刻（仿真里记下的事件要回到影片时间轴，例如屏震、字幕对齐）。
  // 二分（单调时有效）；定格段上取最早的那个影片时刻。倒放映射没有唯一反函数，直接报错。
  S.inv = (s) => {
    if (reverse) throw new Error('timeMap: 倒放映射没有唯一反函数');
    let lo = ks[0].t, hi = ks[ks.length - 1].t;
    if (S(lo) > s) { if (ks[0].rate <= 0) throw new Error(`timeMap.inv: ${s} 早于映射起点`); lo -= (S(lo) - s) / ks[0].rate + 1; }
    if (S(hi) < s) { const r = ks[ks.length - 1].rate; if (r <= 0) throw new Error(`timeMap.inv: ${s} 超出映射终点且末段定格`); hi += (s - S(hi)) / r + 1; }
    for (let it = 0; it < 100; it++) { const m = (lo + hi) / 2; if (S(m) < s) lo = m; else hi = m; }
    return hi;
  };
  S.keys = ks; S.s0 = s0; S.reverse = reverse;
  return S;
}

// 反解一个倍率，使 build(r)(t) === sTarget。build 是"给倍率 r 造一条 timeMap"的函数，S(t) 必须随 r 单调增。
// 典型用法：先无头跑一遍仿真拿到事件的仿真时刻（例如第一辆车停住），再让它落在旁白锚点上：
//   const W = fitRate((r) => timeMap([... { t: up1, rate: r }, { t: hold, rate: r } ...]), vo.at('逼'), firstStopSim);
// 反解必须只依赖"从 init 起的无头仿真结果"和只读参数——不要依赖已经 seek 过什么。
export function fitRate(build, t, sTarget, { lo = 1e-3, hi = 1e3, tol = 1e-9 } = {}) {
  const f = (r) => build(r)(t) - sTarget;
  if (f(lo) > 0 || f(hi) < 0) throw new Error(`fitRate: 倍率在 [${lo}, ${hi}] 内够不到 S(${t}) = ${sTarget}（S(lo)=${build(lo)(t)}, S(hi)=${build(hi)(t)}）`);
  for (let it = 0; it < 200 && hi - lo > tol; it++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
