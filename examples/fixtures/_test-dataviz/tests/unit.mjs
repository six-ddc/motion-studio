// 运行：node tests/fixtures/_test-dataviz/tests/unit.mjs（任意 cwd）
// film-motion chart.js 的数值断言：比例尺与 invert 互逆、ticks 取整、stack 求和、排名交换连续、投影已知点、
// forceLayout 同种子逐位相同；最后起一个浏览器，确认同一组输入在 Chromium 里和 Node 里逐位相同。
// 全部通过 exit 0，并打印「chart 单测全部通过」；任何一条不过 exit 1。
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const FILM = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(FILM, '..', '..', '..', 'skills');
const LIB = join(SKILLS, 'film-core', 'lib');
const { registerRuntimeResolver } = await import(join(LIB, 'runtime-node.mjs'));
registerRuntimeResolver();
const CHART = join(SKILLS, 'film-motion', 'assets', 'runtime', 'chart.js');
const C = await import(pathToFileURL(CHART).href);

let fails = 0, passes = 0;
const ok = (cond, msg, extra = '') => { if (cond) passes++; else { fails++; console.log(`✗ ${msg}${extra ? '  ' + extra : ''}`); } };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

// ---- 1. 比例尺与 invert ----
{
  const cases = [
    C.scaleLinear({ domain: [-3, 17], range: [100, 900] }),
    C.scaleLinear({ domain: [10, 0], range: [0, 1080] }),
    C.scaleLog({ domain: [1, 1e6], range: [0, 600] }),
    C.scaleLog({ domain: [-1000, -1], range: [0, 300] }),
    C.scaleLog({ domain: [2, 1024], range: [0, 10], base: 2 }),
    C.scalePow({ domain: [-5, 5], range: [0, 100], exponent: 3 }),
    C.scaleSqrt({ domain: [0, 400], range: [0, 20] }),
    C.scaleTime({ domain: [Date.UTC(2020, 0, 1), Date.UTC(2024, 0, 1)], range: [0, 1000] }),
  ];
  let worst = 0;
  for (const s of cases) {
    const [a, b] = s.domain;
    for (let i = 0; i <= 50; i++) {
      const x = s.kind === 'log' ? Math.sign(a) * Math.abs(a) ** (1 - i / 50) * Math.abs(b) ** (i / 50) : a + (b - a) * (i / 50);
      const back = s.invert(s(x));
      const rel = Math.abs(back - x) / Math.max(1, Math.abs(x));
      worst = Math.max(worst, rel);
    }
  }
  ok(worst < 1e-12, '比例尺 invert(s(x)) == x', `最大相对误差 ${worst}`);
  console.log(`  invert 往返最大相对误差 ${worst.toExponential(2)}（8 种比例尺 × 51 点）`);
  const s = C.scaleLinear({ domain: [0, 10], range: [0, 100], clamp: true });
  ok(s(20) === 100 && s(-5) === 0 && s.invert(150) === 10, 'clamp 两端截断（正反两个方向）');
  ok(C.scaleLinear({ domain: [0, 10], range: [0, 100] })(20) === 200, '不开 clamp 就外推');
  ok(C.scaleSqrt({ domain: [0, 100], range: [0, 10] })(25) === 5, 'sqrt：25 → 5');
}

// ---- 2. ticks 取整（1/2/5）与 nice ----
{
  const T = (d, n) => C.ticks(C.scaleLinear({ domain: d, range: [0, 1] }), n);
  ok(eq(T([0, 1], 5), [0, 0.2, 0.4, 0.6, 0.8, 1]), 'ticks [0,1]×5 = 0,0.2…1（无 0.30000000000000004）', JSON.stringify(T([0, 1], 5)));
  ok(eq(T([0, 1], 10), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]), 'ticks [0,1]×10 是精确的十分位');
  ok(eq(T([-7, 93], 5), [0, 20, 40, 60, 80]), 'ticks [-7,93]×5 = 0..80 步 20', JSON.stringify(T([-7, 93], 5)));
  ok(eq(T([93, -7], 5), [80, 60, 40, 20, 0]), '反向域的 ticks 也反向');
  ok(eq(T([0, 1234], 4), [0, 200, 400, 600, 800, 1000, 1200]), 'ticks [0,1234]×4：308.5 落在 [√2,√10) → 步 200（同 d3）', JSON.stringify(T([0, 1234], 4)));
  ok(eq(T([0.0012, 0.0087], 5), [0.002, 0.004, 0.006, 0.008]), '小数刻度精确');
  // 所有刻度都是 {1,2,5}×10^k 的整倍数
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const a = Math.sin(k * 1.7) * 10 ** (k % 7 - 2), b = a + Math.abs(Math.cos(k * 0.9)) * 10 ** (k % 5) + 1e-3;
    const tk = T([a, b], 3 + (k % 8));
    if (tk.length < 2) continue;
    const step = tk[1] - tk[0], p = 10 ** Math.floor(Math.log10(step) + 1e-9), m = step / p;
    if (![1, 2, 5, 10].some((f) => Math.abs(m - f) < 1e-6)) bad++;
    if (tk[0] < Math.min(a, b) - 1e-12 || tk[tk.length - 1] > Math.max(a, b) + 1e-12) bad++;
  }
  ok(bad === 0, '300 个随机域：步长都是 1/2/5×10^k、刻度都在域内', `坏 ${bad}`);
  const nl = C.nice(C.scaleLinear({ domain: [0.13, 9.87], range: [0, 1] }), 5);
  ok(eq(nl.domain, [0, 10]), 'nice [0.13, 9.87] → [0, 10]', JSON.stringify(nl.domain));
  const lg = C.ticks(C.scaleLog({ domain: [1, 1000], range: [0, 1] }), 10);
  ok(lg[0] === 1 && lg.includes(10) && lg.includes(100) && lg.includes(1000) && lg.includes(20), 'log ticks 含整次幂与 2..9 倍', JSON.stringify(lg));
  ok(eq(C.nice(C.scaleLog({ domain: [3, 870], range: [0, 1] }), 5).domain, [1, 1000]), 'log nice → [1, 1000]');
  // 时间刻度
  const ty = C.ticks(C.scaleTime({ domain: [Date.UTC(2001, 5, 3), Date.UTC(2023, 2, 1)], range: [0, 1] }), 5);
  ok(ty.unit === 'year' && ty.every((v) => new Date(v).getUTCMonth() === 0 && new Date(v).getUTCDate() === 1 && new Date(v).getUTCFullYear() % 5 === 0), '年刻度落在每 5 年的 1 月 1 日', `${ty.unit}/${ty.step} ${ty.map((v) => new Date(v).toISOString().slice(0, 10))}`);
  const tm = C.ticks(C.scaleTime({ domain: [Date.UTC(2024, 0, 15), Date.UTC(2024, 11, 20)], range: [0, 1] }), 4);
  ok(tm.unit === 'month' && tm.step === 3 && tm.every((v) => new Date(v).getUTCDate() === 1 && new Date(v).getUTCMonth() % 3 === 0), '季度刻度落在 1/4/7/10 月 1 日', `${tm.unit}/${tm.step} ${tm.map((v) => new Date(v).toISOString().slice(0, 10))}`);
  const th = C.ticks(C.scaleTime({ domain: [Date.UTC(2024, 0, 1, 1, 10), Date.UTC(2024, 0, 2, 0, 0)], range: [0, 1] }), 8);
  ok(th.unit === 'hour' && th.step === 3 && th.every((v) => new Date(v).getUTCHours() % 3 === 0 && new Date(v).getUTCMinutes() === 0), '3 小时刻度整点', `${th.unit}/${th.step}`);
  const td = C.ticks(C.scaleTime({ domain: [Date.UTC(2024, 1, 3), Date.UTC(2024, 1, 12)], range: [0, 1] }), 8);
  ok(td.unit === 'day' && td.step === 1 && td.length === 10, '日刻度 2/3..2/12 共 10 个', `${td.unit}/${td.step}/${td.length}`);
  // utcOffset：+480（东八区）下日刻度落在当地 0 点
  const t8 = C.ticks(C.scaleTime({ domain: [Date.UTC(2024, 1, 3), Date.UTC(2024, 1, 8)], range: [0, 1], utcOffset: 480 }), 5);
  ok(t8.every((v) => C.timeParts(v, { utcOffset: 480 }).hour === 0), 'utcOffset=480 的日刻度是当地零点');
  const nt = C.nice(C.scaleTime({ domain: [Date.UTC(2024, 0, 15), Date.UTC(2024, 11, 20)], range: [0, 1] }), 4);
  ok(nt.domain[0] === Date.UTC(2024, 0, 1) && nt.domain[1] === Date.UTC(2025, 0, 1), '时间 nice → [2024-01-01, 2025-01-01]', nt.domain.map((v) => new Date(v).toISOString()).join(' '));
}

// ---- 3. band / point ----
{
  const b = C.scaleBand({ domain: ['a', 'b', 'c', 'd'], range: [0, 100], paddingInner: 0.2, paddingOuter: 0.1 });
  // step = 100 / (4 - 0.2 + 0.2) = 25；start = (100 - 25*3.8)*0.5 = 2.5；bandwidth = 20
  ok(close(b.step, 25) && close(b.bandwidth, 20) && close(b('a'), 2.5) && close(b('d'), 77.5), 'band 几何：step 25、bandwidth 20、a=2.5、d=77.5', `${b.step} ${b.bandwidth} ${b('a')} ${b('d')}`);
  ok(close(b.at(1.5), 40), 'band.at(1.5) 是 b、c 之间的中点');
  ok(b.invert(60) === 'c' && b.invert(50) === 'b' && b.invert(-10) === 'a', 'band.invert 找所在带（间隙归前一带）');
  ok(throws(() => C.scaleBand({ domain: 3, range: [0, 1] }), /padding/), 'band 不给 padding 就报错');
  const pt = C.scalePoint({ domain: [0, 1, 2], range: [0, 100], padding: 0 });
  ok(pt(0) === 0 && pt(2) === 100 && pt.bandwidth === 0, 'point padding 0 首尾贴边');
  const rb = C.scaleBand({ domain: 4, range: [100, 0], padding: 0 });
  ok(close(rb(0), 75) && close(rb(3), 0), '反向 range 的 band 从下往上排');
}

// ---- 4. 格式化 ----
{
  ok(C.grouped(1234567.891, { decimals: 2 }) === '1,234,567.89', '千分位');
  ok(C.grouped(-999.5, { decimals: 0 }) === '-1,000', '千分位进位与负号');
  ok(C.grouped(1234567, { decimals: 0, sep: ' ', group: 4 }) === '123 4567', '万位分组', C.grouped(1234567, { decimals: 0, sep: ' ', group: 4 }));
  ok(C.si(12345, { decimals: 1 }) === '12.3k' && C.si(999950, { decimals: 1 }) === '1.0M' && C.si(0.0042, { decimals: 1 }) === '4.2m', 'SI 词头与进位', `${C.si(999950, { decimals: 1 })}`);
  ok(C.cjk(123456789, { decimals: 2 }) === '1.23亿' && C.cjk(99995, { decimals: 0 }) === '10万' && C.cjk(9999.6, { decimals: 0 }) === '1万', '万/亿与进位', `${C.cjk(99995, { decimals: 0 })} ${C.cjk(9999.6, { decimals: 0 })}`);
  ok(C.cjk(3.2e12, { decimals: 1 }) === '3.2万亿' && C.cjk(512, { decimals: 0 }) === '512' && C.cjk(-25000, { decimals: 1, trim: true }) === '-2.5万', '万亿、无单位、负数与 trim');
  ok(C.percent(0.1234, { decimals: 1 }) === '12.3%' && C.percent(0.07, { decimals: 0 }) === '7%', '百分比');
  ok(C.fixed(-0.0001, 2) === '0.00', 'fixed 不出 -0.00');
  ok(throws(() => C.si(1, {}), /decimals/) && throws(() => C.formatter('cjk', {}), /decimals/), '不给 decimals 就报错（formatter 在建时就报）');
}

// ---- 5. 序列几何 ----
{
  const rows = [{ a: 1, b: 2, c: 3 }, { a: 4, b: 0, c: 1 }, { a: 2.5, b: 2.5, c: 5 }];
  const st = C.stack(rows, ['a', 'b', 'c'], { offset: 'zero' });
  ok(rows.every((r, j) => close(st[2].points[j][1], r.a + r.b + r.c) && st[0].points[j][0] === 0), 'stack zero：顶层上沿 = 行和，底层从 0 起');
  ok(rows.every((_, j) => close(st[1].points[j][0], st[0].points[j][1])), 'stack 相邻层首尾相接');
  const ex = C.stack(rows, ['a', 'b', 'c'], { offset: 'expand' });
  ok(rows.every((_, j) => close(ex[2].points[j][1], 1)), 'stack expand：每行归一到 1');
  const dv = C.stack([{ a: 3, b: -2, c: 1 }], ['a', 'b', 'c'], { offset: 'diverging' });
  ok(eq(dv.map((s) => s.points[0]), [[0, 3], [-2, 0], [3, 4]]), 'stack diverging：负值往下');
  const sil = C.stack(rows, ['a', 'b', 'c'], { offset: 'silhouette' });
  ok(rows.every((_, j) => close(sil[0].points[j][0], -sil[2].points[j][1])), 'stack silhouette：以 0 为中线对称');

  const pi = C.pie([1, 2, 1], { start: -Math.PI / 2, end: 1.5 * Math.PI });
  ok(close(pi[0].a0, -Math.PI / 2) && close(pi[2].a1, 1.5 * Math.PI) && close(pi[1].a1 - pi[1].a0, Math.PI), 'pie：首尾覆盖整圈、2/4 份占 π');
  const pp = C.pie([1, 1, 1, 1], { start: 0, end: 2 * Math.PI, pad: 0.1 });
  ok(close(pp.reduce((s, x) => s + (x.a1 - x.a0), 0), 2 * Math.PI - 0.4), 'pie pad：总角减去间隙');

  const hb = C.bin([0, 0.5, 1, 1.5, 2, 9.99, 10], { domain: [0, 10], thresholds: 5 });
  ok(hb.length === 5 && hb[0].count === 4 && hb[4].count === 2 && hb.reduce((s, x) => s + x.count, 0) === 7, '直方图：5 箱、=hi 进最后一箱、总数守恒', JSON.stringify(hb.map((x) => [x.x0, x.count])));

  // monotone：单调数据不过冲
  const data = [[0, 0], [1, 0], [2, 10], [3, 10.5], [4, 10.5], [5, 30], [6, 30]];
  const mp = C.curvePoints(data, 'monotone', { samples: 32 });
  let over = 0;
  for (let i = 1; i < mp.length; i++) if (mp[i][1] < mp[i - 1][1] - 1e-9) over++;
  ok(over === 0 && Math.max(...mp.map((p) => p[1])) <= 30 + 1e-9, 'monotone：单调输入 → 单调输出、不越过最大值', `回退 ${over}`);
  ok(mp.some((p) => close(p[0], 2) && close(p[1], 10)), 'monotone 经过数据点');
  ok(throws(() => C.curvePath([[0, 0], [0, 1], [1, 2]], 'monotone'), /严格递增/), 'monotone 要求 x 严格递增');
  const sa = C.curvePoints([[0, 0], [10, 5], [20, 2]], 'stepAfter');
  ok(eq(sa, [[0, 0], [10, 0], [10, 5], [20, 5], [20, 2]]), 'stepAfter 几何');
  const ar = C.areaPoints([[0, 1], [1, 2], [2, 3]], 10);
  ok(eq(ar, [[0, 1], [1, 2], [2, 3], [2, 10], [1, 10], [0, 10]]), 'areaPoints 基线');
}

// ---- 6. keyframes / barRace / lineGrower / axisTicks ----
{
  const K = C.keyframes([{ t: 0, values: { a: 0, b: 10 } }, { t: 2, values: { a: 10 } }, { t: 4, values: { a: 20, b: 30 } }], { ease: (p) => p });
  ok(K.get('a', 1) === 5 && K.get('b', 2) === 20 && K.get('a', -1) === 0 && K.get('a', 9) === 20, 'keyframes：线性插值、缺键跨帧插值、两端保持');
  const S = C.keyframes([{ t: 0, values: { a: 0 } }, { t: 1, values: { a: 1 } }], { ease: () => 0 });
  ok(S.get('a', 0.999) === 0 && S.get('a', 1) === 1, '阶梯 ease：在下一关键帧上才跳');

  // 名次交换：a 从 10 线性降到 0，b 从 0 升到 10（t=5 时相等），c 恒 7（两次交换）
  const frames = [{ t: 0, values: { a: 10, b: 0, c: 7, d: 1 } }, { t: 10, values: { a: 0, b: 10, c: 7, d: 1 } }];
  const smooth = (p) => p * p * (3 - 2 * p);
  const R = C.barRace(frames, { top: 2, ease: (p) => p, swap: { duration: 0.8, ease: smooth }, fade: 1 });
  ok(R.events.length >= 6, `交换事件被扫出来（${R.events.length} 条）`);
  const fps = 30;
  let maxStep = 0, maxSumErr = 0;
  const prev = new Map();
  for (let f = 0; f <= 10 * fps; f++) {
    const t = f / fps, all = R.all(t);
    for (const it of all) { if (prev.has(it.key)) maxStep = Math.max(maxStep, Math.abs(it.pos - prev.get(it.key))); prev.set(it.key, it.pos); }
    maxSumErr = Math.max(maxSumErr, Math.abs(all.reduce((s, x) => s + x.pos, 0) - 6));   // 0+1+2+3
  }
  // smoothstep 最大斜率 1.5/duration 名次/秒；一帧 1/30 s → 1.5/0.8/30 = 0.0625
  ok(maxStep <= 1.5 / 0.8 / fps + 1e-6, '连续名次：相邻两帧位置差 ≤ 1.5/(duration·fps)', `实测 ${maxStep.toFixed(4)}，上界 ${(1.5 / 0.8 / fps).toFixed(4)}`);
  ok(maxSumErr < 1e-9, '名次守恒：所有条目 pos 之和恒为 0+1+…+(n−1)', `${maxSumErr}`);
  console.log(`  barRace 相邻帧最大位移 ${maxStep.toFixed(4)} 名次（上界 ${(1.5 / 0.8 / fps).toFixed(4)}）`);
  // a 与 c 交换点：10 - t = 7 → t = 3；交换窗口 [2.6, 3.4]，中点两者位置相等
  const ac = R.all(3).filter((x) => x.key === 'a' || x.key === 'c');
  ok(Math.abs(ac[0].pos - ac[1].pos) < 0.01, '交换窗口中点两条擦肩（pos 相等）', ac.map((x) => `${x.key}=${x.pos.toFixed(3)}`).join(' '));
  const ev = R.events.find((e) => e.key === 'a' && e.from === 0);
  ok(ev && Math.abs(ev.t - 3) < 1e-3, '交换时刻二分到值相等的时刻', ev ? String(ev.t) : '无');
  // Top-N 截断处连续：top=2，c 从名次 1 掉到 2（t≈5 附近 b 超过 c），alpha 连续
  let maxA = 0; let pa = null;
  for (let f = 0; f <= 10 * fps; f++) { const c = R.all(f / fps).find((x) => x.key === 'c'); if (pa !== null) maxA = Math.max(maxA, Math.abs(c.alpha - pa)); pa = c.alpha; }
  ok(maxA <= 1.5 / 0.8 / fps + 1e-6, 'Top-N 截断处 alpha 连续', `相邻帧最大 alpha 变化 ${maxA.toFixed(4)}`);
  ok(R.at(0).map((x) => x.key).join() === 'a,c' && R.at(10).map((x) => x.key).join() === 'b,c', 'Top-2 首尾名单', `${R.at(0).map((x) => x.key)} / ${R.at(10).map((x) => x.key)}`);
  ok(throws(() => C.barRace([{ t: 0, values: { a: 1 } }, { t: 1, values: { b: 1 } }], { top: 1, ease: (p) => p, swap: 'keyframe', fade: 1 }), /fill/), '数据有缺口而没给 fill 就报错');
  const RK = C.barRace(frames, { top: 2, ease: (p) => p, swap: 'keyframe', fade: 1 });
  ok(close(RK.all(5).find((x) => x.key === 'a').pos, 1.5), "swap:'keyframe'：名次在整段里 lerp（a 0→3 在 t=5 为 1.5）");

  const G = C.lineGrower([[0, 0], [10, 0], [10, 10]]);
  const g = G.at(0.75, 'length');
  ok(close(g.end[0], 10) && close(g.end[1], 5) && close(g.angle, Math.PI / 2) && g.points.length === 3, '弧长生长 75% → (10,5)，朝下');
  const gx = C.lineGrower([[0, 0], [10, 10], [20, 0]]).at(0.25, 'x');
  ok(close(gx.end[0], 5) && close(gx.end[1], 5), '按 x 生长 25% → (5,5)');

  // axisTicks：域从 [0,100] 连续涨到 [0,1000]，每个刻度的 alpha 与位置逐帧连续
  let maxDA = 0, maxDP = 0; let last = new Map(); let minFull = Infinity;
  const N = 600;
  for (let f = 0; f <= N; f++) {
    const hi = 100 * 10 ** (f / N);
    const s = C.scaleLinear({ domain: [0, hi], range: [0, 800] });
    const tk = C.axisTicks(s, 5, { blend: 0.15, edge: 40 });
    const cur = new Map(tk.map((x) => [x.value, x]));
    if (f) for (const v of new Set([...cur.keys(), ...last.keys()])) {
      const a = cur.get(v)?.alpha ?? 0, b = last.get(v)?.alpha ?? 0;
      maxDA = Math.max(maxDA, Math.abs(a - b));
      if (cur.has(v) && last.has(v)) maxDP = Math.max(maxDP, Math.abs(cur.get(v).pos - last.get(v).pos));
    }
    minFull = Math.min(minFull, tk.filter((x) => x.alpha > 0.99).length);
    last = cur;
  }
  ok(maxDA < 0.1, '轴域 10 倍连续增长（600 帧）：刻度 alpha 逐帧变化有上界', `最大 ${maxDA.toFixed(4)}`);
  ok(maxDP < 8, '刻度位置逐帧连续', `最大 ${maxDP.toFixed(2)} px`);
  ok(minFull >= 2, '任何时刻至少 2 个全不透明刻度', `${minFull}`);
  console.log(`  axisTicks 600 帧：相邻帧 alpha 最大变化 ${maxDA.toFixed(4)}、位置最大变化 ${maxDP.toFixed(2)} px、全不透明刻度最少 ${minFull} 个`);
  const zero = C.axisTicks(C.scaleLinear({ domain: [0, 100], range: [0, 800] }), 5, { blend: 0.15, edge: 40 }).find((x) => x.value === 0);
  ok(zero && zero.alpha === 1, '域端点上的 0 刻度 alpha = 1（edge 只淡化域外的）');
}

// ---- 7. 地理 ----
{
  const M = C.projection('mercator', { scale: 100, translate: [500, 300] });
  ok(eq(M.project([0, 0]), [500, 300]), 'mercator (0,0) → translate');
  const m45 = M.project([0, 45])[1];
  ok(close(300 - m45, 100 * Math.log(Math.tan(Math.PI / 4 + Math.PI / 8)), 1e-12), 'mercator 45°N y = ln tan(π/4+φ/2)');
  ok(M.project([0, 45])[1] < 300, 'y 向下：北纬在上（没有翻转）');
  ok(M.project([90, 0])[0] > 500, '东经在右');
  const inv = M.invert(M.project([116.4, 39.9]));
  ok(close(inv[0], 116.4, 1e-12) && close(inv[1], 39.9, 1e-12), 'mercator invert 往返');
  const E = C.projection('equirectangular', { scale: 180 / Math.PI, translate: [0, 0] });
  ok(close(E.project([30, 60])[0], 30) && close(E.project([30, 60])[1], -60), 'equirectangular：scale=180/π 时坐标即度数');

  const O = C.projection('orthographic', { scale: 200, translate: [400, 400], rotate: [-100, -30] });
  const c0 = O.project([100, 30]);
  ok(close(c0[0], 400) && close(c0[1], 400), 'orthographic rotate [−100,−30] 把 (100E,30N) 放到中心', JSON.stringify(c0));
  ok(O.project([-80, -30]) === null && O.visible([-80, -30]) === false, 'orthographic 对跖点被背面剔除');
  ok(O.project([100, 30 + 89]) !== null && O.project([100 + 180, 30]) === null, '地平线前后的可见性');
  const ri = O.invert(O.project([120, 10]));
  ok(close(ri[0], 120, 1e-9) && close(ri[1], 10, 1e-9), 'orthographic + rotate 的 invert 往返', JSON.stringify(ri));
  // 地平线裁剪：一个跨越地平线的方块，裁剪后所有点都在圆盘内
  const sq = { type: 'Polygon', coordinates: [[[150, 0], [210, 0], [210, 40], [150, 40], [150, 0]]] };
  const shp = C.geoShapes(O, sq, { densify: 2 });
  const rmax = Math.max(...shp[0].rings[0].map(([x, y]) => Math.hypot(x - 400, y - 400)));
  ok(shp[0].clipped && rmax <= 200 + 1e-6, '跨地平线的多边形被裁到圆盘内', `最大半径 ${rmax.toFixed(3)}`);

  const A = C.projection('albers', { parallels: [25, 47], rotate: [-105, 0] });
  const ai = A.invert(A.project([-90, 40]));
  ok(close(ai[0], -90, 1e-9) && close(ai[1], 40, 1e-9), 'albers invert 往返');
  // 等积：同样 1°×1° 的格子在 30°N 和 45°N 投影面积之比 = 球面面积之比
  const area = (P, lon, lat) => { const r = [[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1]].map((c) => P.project(c)); let s = 0; for (let i = 0; i < 4; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % 4]; s += x0 * y1 - x1 * y0; } return Math.abs(s / 2); };
  const sph = (lat) => Math.sin((lat + 1) * Math.PI / 180) - Math.sin(lat * Math.PI / 180);
  const ratio = (area(A, -100, 30) / area(A, -100, 45)) / (sph(30) / sph(45));
  ok(Math.abs(ratio - 1) < 2e-3, 'albers 等积：格子面积比 = 球面面积比', `比值 ${ratio.toFixed(5)}`);
  const merRatio = (area(M, 0, 0) / area(M, 0, 60));
  console.log(`  mercator 60°N 的 1°×1° 格子面积是赤道的 ${(1 / merRatio).toFixed(2)} 倍（球面上是 ${(sph(60) / sph(0)).toFixed(2)} 倍）`);

  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { n: 'a' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]] } },
    { type: 'Feature', properties: { n: 'b' }, geometry: { type: 'Point', coordinates: [10, 5] } },
  ] };
  const F = C.fit(C.projection('equirectangular'), fc, [100, 100, 400, 400]);
  const pts = C.geoShapes(F, fc)[0].rings[0];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  ok(close(Math.min(...xs), 100) && close(Math.max(...xs), 500) && close((Math.min(...ys) + Math.max(...ys)) / 2, 300), 'fit：宽度撑满 rect、纵向居中');
  ok(close(F.project([10, 5])[0], 300) && close(F.project([10, 5])[1], 300), 'fit 后几何中心落在 rect 中心');
  ok(C.geoShapes(F, fc)[1].properties.n === 'b', 'geoShapes 保留 properties');

  // 跨 ±180° 的线：圆柱投影展开不折回
  const ln = C.projectLine(E, [[170, 0], [-170, 0]]);
  ok(ln.crosses && close(ln.parts[0][1][0] - ln.parts[0][0][0], 20), '跨日界线的线段向外展开 20°，不横穿全图');

  const gc = C.greatCircle([116.4, 39.9], [-0.13, 51.5]);
  const km = gc.distance * 6371.0088;
  ok(Math.abs(km - 8140) < 30, `北京—伦敦大圆距离 ${km.toFixed(0)} km（≈8140）`);
  const mid = gc.at(0.5);
  ok(mid[1] > 51.5, '北京—伦敦大圆中点纬度高于两端（航线北拱）', JSON.stringify(mid.map((v) => +v.toFixed(2))));
  const gp = gc.points(10, 0.5);
  ok(gp.length === 6 && close(gp[5][0], mid[0], 1e-12), 'points(n, upto) 截到进度并以进度点结束');
}

// ---- 8. 力导向 ----
let nodeLayout;
{
  const N = 60, nodes = Array.from({ length: N }, (_, i) => ({ id: 'n' + i }));
  const links = []; for (let i = 1; i < N; i++) links.push({ source: 'n' + i, target: 'n' + Math.floor((i - 1) / 3) });
  const o = { seed: 7, iterations: 300, distance: 30, charge: -60, record: 10 };
  const a = C.forceLayout(nodes, links, o), b = C.forceLayout(nodes, links, o);
  const bits = (r) => Buffer.from(new Float64Array(r.nodes.flatMap((n) => [n.x, n.y])).buffer).toString('hex');
  ok(bits(a) === bits(b), 'forceLayout 同种子两次逐位相同');
  ok(bits(a) !== bits(C.forceLayout(nodes, links, { ...o, seed: 8 })), '换种子布局不同');
  ok(a.frames.length === 31 && eq(a.at(300), a.nodes), 'record=10：31 帧，at(终步) = 终态');
  const h = a.at(15), h10 = a.at(10), h20 = a.at(20);
  ok(close(h[5].x, (h10[5].x + h20[5].x) / 2), 'at(k) 按迭代步线性插值');
  // 连线长度收敛到 distance 附近
  const pos = new Map(a.nodes.map((n) => [n.id, n]));
  const lens = links.map((l) => Math.hypot(pos.get(l.source).x - pos.get(l.target).x, pos.get(l.source).y - pos.get(l.target).y));
  const meanLen = lens.reduce((s, x) => s + x, 0) / lens.length;
  ok(meanLen > 15 && meanLen < 80 && a.movement < 0.05, `收敛：平均边长 ${meanLen.toFixed(1)}，末步平均位移 ${a.movement.toExponential(2)}`);
  const pinned = C.forceLayout([{ id: 'x', fx: 5, fy: 6 }, { id: 'y' }], [{ source: 'x', target: 'y' }], { seed: 1, iterations: 50, distance: 10, charge: -30 });
  ok(eq(pinned.position('x'), [5, 6]), 'fx/fy 钉住的节点不动');
  nodeLayout = bits(a);
  // 实测耗时（Node，给文档）
  for (const n of [50, 200, 500]) {
    const ns = Array.from({ length: n }, (_, i) => ({ id: i })), ls = []; for (let i = 1; i < n; i++) ls.push({ source: i, target: Math.floor((i - 1) / 3) });
    const t0 = performance.now(); C.forceLayout(ns, ls, { seed: 1, iterations: 300, distance: 30, charge: -60 }); const ms = performance.now() - t0;
    console.log(`  forceLayout n=${n} 300 步：${ms.toFixed(0)} ms（Node ${process.version}）`);
  }
}

// ---- 8b. dmath：只用四则与 sqrt 的超越函数，精度对照 Math ----
const ulp = (a, b) => { if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return 0; const buf = new DataView(new ArrayBuffer(16)); buf.setFloat64(0, a); buf.setFloat64(8, b);
  const ia = buf.getBigInt64(0), ib = buf.getBigInt64(8); const o = (x) => (x < 0n ? -(x & 0x7fffffffffffffffn) : x); const d = o(ia) - o(ib); return Number(d < 0n ? -d : d); };
const DM_INPUTS = () => { const xs = []; for (let i = 0; i < 4000; i++) xs.push(Math.fround(Math.sin(i * 12.9898) * 4.37) + i * 1e-3); return xs; };
const DM_FNS = (D) => ({ sin: D.sin, cos: D.cos, tan: D.tan, atan: D.atan, asin: (x) => D.asin(x / 5), atan2: (x) => D.atan2(x, 1.3),
  log: (x) => D.log(Math.abs(x) + 1e-3), exp: D.exp, pow: (x) => D.pow(Math.abs(x) + 0.1, 1.7), log10: (x) => D.log10(Math.abs(x) + 1e-3) });
{
  const xs = DM_INPUTS(), mine = DM_FNS(C.dmath), ref = DM_FNS({ sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, asin: Math.asin, atan2: Math.atan2, log: Math.log, exp: Math.exp, pow: Math.pow, log10: Math.log10 });
  const worst = {};
  for (const k of Object.keys(mine)) worst[k] = Math.max(...xs.map((x) => ulp(mine[k](x), ref[k](x))));
  console.log('  dmath 对照 Node Math 的最大 ULP 差：' + Object.entries(worst).map(([k, v]) => `${k} ${v}`).join('，'));
  ok(Object.entries(worst).every(([k, v]) => v <= (k === 'pow' ? 8 : 4)), 'dmath 与 Math 相差 ≤ 4 ULP（pow 走 exp(e·log b) ≤ 8；4000 个输入 × 10 个函数）', JSON.stringify(worst));
  ok(C.dmath.sin(0) === 0 && C.dmath.cos(0) === 1 && C.dmath.exp(0) === 1 && C.dmath.log(1) === 0 && C.dmath.atan2(0, -1) === Math.PI, 'dmath 特殊点精确');
}

// ---- 9. Node 与浏览器逐位一致 ----
{
  const { serve } = await import(join(LIB, 'serve.mjs'));
  const { launchBrowser } = await import(join(LIB, 'browser.mjs'));
  const { port, close: closeSrv } = await serve(FILM, { record: false });
  const br = await launchBrowser(); const page = await br.newPage();
  await page.goto(`http://127.0.0.1:${port}/scene.html`); await page.evaluate(() => window.ready);
  const probe = async (C) => {
    const N = 60, nodes = Array.from({ length: N }, (_, i) => ({ id: 'n' + i }));
    const links = []; for (let i = 1; i < N; i++) links.push({ source: 'n' + i, target: 'n' + Math.floor((i - 1) / 3) });
    const L = C.forceLayout(nodes, links, { seed: 7, iterations: 300, distance: 30, charge: -60, record: 10 });
    const O = C.projection('orthographic', { scale: 200, translate: [400, 400], rotate: [-100, -30] });
    const sq = { type: 'Polygon', coordinates: [[[150, 0], [210, 0], [210, 40], [150, 40], [150, 0]]] };
    const R = C.barRace([{ t: 0, values: { a: 10, b: 0, c: 7 } }, { t: 10, values: { a: 0, b: 10, c: 7 } }], { top: 2, ease: (p) => p * p, swap: { duration: 0.8, ease: (p) => p * p * (3 - 2 * p) }, fade: 1 });
    const nums = [...L.nodes.flatMap((n) => [n.x, n.y]), ...C.geoShapes(O, sq, { densify: 2 })[0].rings[0].flat(),
      ...R.all(3.1).map((x) => x.pos), ...C.ticks(C.scaleTime({ domain: [0, 3e10], range: [0, 1] }), 7),
      ...C.curvePoints([[0, 0], [1, 3], [2, 2], [3, 8]], 'monotone', { samples: 8 }).flat()];
    return nums;
  };
  const nodeNums = await probe(C);
  const brNums = await page.evaluate(`(async () => { const C = await import('./runtime/chart.js'); return (${probe.toString()})(C); })()`);
  const hex = (a) => Buffer.from(new Float64Array(a).buffer).toString('hex');
  ok(nodeNums.length === brNums.length && hex(nodeNums) === hex(brNums), `Node 与 Chromium 逐位相同（${nodeNums.length} 个数：力导向、球面裁剪、交换名次、时间刻度、单调曲线）`);
  const dmNode = (() => { const xs = DM_INPUTS(), f = DM_FNS(C.dmath); return Object.values(f).flatMap((g) => xs.map(g)); })();
  const dmBr = await page.evaluate(`(async () => { const C = await import('./runtime/chart.js'); const DM_INPUTS = ${DM_INPUTS.toString()}; const DM_FNS = ${DM_FNS.toString()};
    const xs = DM_INPUTS(), f = DM_FNS(C.dmath); return Object.values(f).flatMap((g) => xs.map(g)); })()`);
  ok(hex(dmNode) === hex(dmBr), `dmath 在 Node 与 Chromium 逐位相同（${dmNode.length} 个值；同样的输入 Math.* 有 2.5–17% 不同）`);
  await br.close(); await closeSrv();
}

console.log(fails ? `✗ chart 单测 ${fails} 条不通过（${passes} 条通过）` : `chart 单测全部通过（${passes} 条）`);
process.exit(fails ? 1 : 0);
