// check.mjs 的两项可选疑点：衔接度（continuity）与节奏（rhythm）。判据借自 onetake 项目。
//
// 都只在本片 film.json checks 里声明了才跑，**只报 LOOK / PASS / SKIP，永不 FAIL**：
//   "continuity": true | { "cuts": ["MARK label", "label.end", 12.3, …] }
//   "rhythm":     true | { "cuts": [ … ] }
// 没声明的片子，check.mjs 不调用本模块，输出与引入它之前相同。
//
// continuity 读 window.anchors(t)（film-core runtime/anchors.js，名字 → 归一化框），不看像素：
//   相隔 0.4s 的两帧求加权 Jaccard（权重 = 画面内可见面积 × 透明度；锚点 meta 没有 alpha/opacity 就只用面积），
//   < 0.2 的连续区间 = 一个交接窗；中途淡到"一个锚点都没有"的帧，≤ 1.5s 的空档把前后接成同一个交接。
//   每个交接比较窗口两端的两帧：
//     两边共有的元素位移 ≥ 对角线 2% 或 |ln 线性尺度变化| ≥ 0.1 → carried（被带过去）
//     只有面积 ≥ 3% 的原样不动元素存活                       → anchored（钉住不动的东西托底）
//     都没有                                                    → bare（裸切换）
//   豁免：1.5s 内 ≥ 3 个硬切的快切连击、片尾 1.2s、本片声明的切点（cuts）；外加片头从空画面淡入（onetake 没有这条：
//   第一个东西出现时前面什么都没有，算 bare 只会惩罚每一支从黑场开头的片子）。
//   score = (carried + anchored / 2) / 计分交接数。< 0.5 / < 0.7 两档 LOOK 措辞不同。
// rhythm：镜头长度变异系数（< 0.25 = 像节拍器）+ 静止帧占比（< 25%，或没有 ≥ 1s 的静止段 = 没有呼吸）。
//   静止判定就是 law.max_still / still 用的那一份（check.mjs 采样里的 moved：与"上次变化时的帧"比，缩略图 ≥4 像素差）。
// 这些数是惯例不是定律：低分只说明"这里值得看一眼"，快切 MV、节拍器式的教学片都可能是有意的。
import { sampleAnchors } from './_anchors.mjs';

const GAP = 0.4, LOW = 0.2, BRIDGE = 1.5, BURST_N = 3, BURST_WIN = 1.5, TAIL = 1.2;
const MOVE_DIAG = 0.02, SCALE_LOG = 0.1, ANCHOR_AREA = 0.03;

/** cuts 声明 → 秒数。字符串走 check.mjs 的 markRef（MARK label / label.start / label.end / start / end），数字原样。 */
export function resolveCuts(list, markRef) {
  if (list == null) return null;
  if (!Array.isArray(list)) throw new Error('cuts 要写成数组：["MARK label", "label.end", 12.3]');
  return list.map((r) => (typeof r === 'number' ? r : markRef(String(r), null))).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

const clip01 = (v) => Math.max(0, Math.min(1, v));
function weigh(items) {
  const m = new Map();
  for (const [name, b] of Object.entries(items ?? {})) {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.w)) continue;
    const vis = Math.max(0, clip01(b.x + b.w) - clip01(b.x)) * Math.max(0, clip01(b.y + b.h) - clip01(b.y));
    const al = Number.isFinite(b.alpha) ? b.alpha : Number.isFinite(b.opacity) ? b.opacity : 1;
    const w = vis * clip01(al);
    if (w > 0) m.set(name, { w, vis, cx: b.cx ?? b.x + b.w / 2, cy: b.cy ?? b.y + b.h / 2, area: b.w * b.h });
  }
  return m;
}
function jaccard(A, B) {
  if (!A.size && !B.size) return 1; // 两边都空：没有东西要交接
  let lo = 0, hi = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) { const a = A.get(k)?.w ?? 0, b = B.get(k)?.w ?? 0; lo += Math.min(a, b); hi += Math.max(a, b); }
  return hi > 0 ? lo / hi : 1;
}

/** ctx: { S, pool?, D, F, add, fmt, sfps, lastT, markRef, cfg } */
export async function runContinuity(ctx) {
  const { S, D, F, add, fmt, sfps, lastT, markRef } = ctx;
  const cfg = typeof ctx.cfg === 'object' && ctx.cfg ? ctx.cfg : {};
  const id = 'continuity';
  if (!(await S.page.evaluate(() => typeof window.anchors === 'function'))) {
    add('LOOK', '疑点', id, '本片声明了 continuity，但场景没有暴露 window.anchors(t)（film-core 的 runtime/anchors.js，A.install(seek)）：衔接度要读锚点，量不了'); return;
  }
  let declared;
  try { declared = resolveCuts(cfg.cuts, markRef) ?? []; } catch (e) { add('LOOK', '疑点', id, `continuity.cuts：${e.message}`); return; }
  const h = 1 / sfps, k = Math.max(1, Math.round(GAP * sfps));
  const ts = []; for (let i = 0; i / sfps <= lastT + 1e-9; i++) ts.push(+(i / sfps).toFixed(4));
  let fr;
  // ctx.pool（check.mjs 的并行池）：连续分片分给多个页面、按原顺序拼回；没有 pool = 主页面整段（旧行为）
  try { fr = ctx.pool ? await ctx.pool.chunks(ts, (w, part) => sampleAnchors(w.S.page, part)) : await sampleAnchors(S.page, ts); } catch (e) { add('LOOK', '疑点', id, `window.anchors 求值出错，衔接度没量：${String(e.message).split('\n')[0]}`); return; }
  const Wt = fr.map((f) => weigh(f.items)), empty = Wt.map((m) => m.size === 0), n = ts.length;
  if (empty.every(Boolean)) { add('LOOK', '疑点', id, `${n} 帧里 window.anchors 一个可见锚点都没登记：衔接度无从量`); return; }

  // 硬切：相邻采样帧（1/sfps）的加权 Jaccard 就已 < 0.2
  const hard = [];
  for (let i = 0; i + 1 < n; i++) if (jaccard(Wt[i], Wt[i + 1]) < LOW) hard.push(ts[i + 1]);
  const burst = hard.filter((c) => hard.some((s) => s <= c + 1e-9 && c <= s + BURST_WIN + 1e-9 && hard.filter((x) => x >= s - 1e-9 && x <= s + BURST_WIN + 1e-9).length >= BURST_N));

  // 交接窗：J(t, t+0.4) < 0.2 的连续区间 → [起点帧, 末点帧 + 0.4s]
  let win = [];
  for (let i = 0, s = null; i + k < n + 1; i++) {
    const low = i + k < n && jaccard(Wt[i], Wt[i + k]) < LOW;
    if (low && s === null) s = i;
    if (!low && s !== null) { win.push([s, i - 1 + k]); s = null; }
  }
  // 中途淡空：≤1.5s 的"无锚点"空档把与它相接的窗口并成一个交接，两端取空档前后最近的非空帧
  for (let i = 0; i < n; i++) {
    if (!empty[i] || (i > 0 && empty[i - 1])) continue;
    let j = i; while (j + 1 < n && empty[j + 1]) j++;
    if (i > 0 && j < n - 1 && (j - i + 1) * h <= BRIDGE + 1e-9) {
      const a = i - 1, b = j + 1, touch = win.filter(([s, e]) => e >= a - k && s <= b + k);
      win = win.filter((w) => !touch.includes(w));
      win.push([Math.min(a, ...touch.map((w) => w[0])), Math.max(b, ...touch.map((w) => w[1]))]);
    }
    i = j;
  }
  win.sort((x, y) => x[0] - y[0]);
  const merged = []; for (const w of win) { const L = merged.at(-1); if (L && w[0] <= L[1]) L[1] = Math.max(L[1], w[1]); else merged.push([...w]); }

  const diag = Math.hypot(F.width, F.height), names = (m) => [...m.keys()].join('、') || '（无）';
  const hand = [];
  for (const [s, e] of merged) {
    const p = s, q = e;   // 超过 1.5s 的空档不桥接：端点落在空帧上就是"淡到什么都没有"，如实记成（无）
    const P = Wt[p], Q = Wt[q], from = ts[s], to = ts[e];
    let kind = 'bare', carrier = null;
    const shared = [...P.keys()].filter((x) => Q.has(x));
    for (const x of shared) {
      const a = P.get(x), b = Q.get(x);
      const mv = Math.hypot((b.cx - a.cx) * F.width, (b.cy - a.cy) * F.height) / diag;
      const sc = a.area > 0 && b.area > 0 ? Math.abs(0.5 * Math.log(b.area / a.area)) : 0;
      if (mv >= MOVE_DIAG || sc >= SCALE_LOG) { kind = 'carried'; carrier = x; break; }
    }
    if (kind === 'bare') { const st = shared.find((x) => Math.min(P.get(x).vis, Q.get(x).vis) >= ANCHOR_AREA); if (st) { kind = 'anchored'; carrier = st; } }
    const near = (c) => c >= from - h - 1e-9 && c <= to + h + 1e-9;
    const opening = !P.size && Wt.slice(0, p + 1).every((m) => !m.size);  // 片头从空画面淡入：前面什么都还没有，谈不上交接
    const exempt = from >= D - TAIL - 1e-9 ? '片尾' : opening ? '片头淡入' : declared.some(near) ? '声明的切点' : burst.some(near) ? '快切连击' : null;
    hand.push({ from, to, kind, carrier, exempt, before: names(P), after: names(Q), tb: ts[p], ta: ts[q] });
  }
  const scored = hand.filter((x) => !x.exempt), cnt = (kd) => scored.filter((x) => x.kind === kd).length;
  const ex = hand.filter((x) => x.exempt), exTxt = ex.length ? `；豁免 ${ex.length} 个（${[...new Set(ex.map((x) => x.exempt))].map((r) => `${r} ${ex.filter((x) => x.exempt === r).length}`).join('、')}）` : '';
  const how = `window.anchors @${sfps}fps，相隔 ${GAP}s 的加权 Jaccard < ${LOW} 为交接；判据借自 onetake`;
  const detail = { handoffs: hand.map(({ from, to, kind, carrier, exempt, before, after }) => ({ from, to, kind, carrier, exempt, before, after })), hardCuts: hard };
  if (!scored.length) { add('SKIP', '疑点', id, `没有可计分的交接（共 ${hand.length} 个${exTxt}）（${how}）`, detail); return; }
  const C = cnt('carried'), A = cnt('anchored'), B = scored.filter((x) => x.kind === 'bare');
  const score = (C + A / 2) / scored.length;
  const head = `衔接度 ${score.toFixed(2)}：${scored.length} 个交接里 carried ${C} / anchored ${A} / bare ${B.length}${exTxt}`;
  const bareTxt = B.slice(0, 8).map((x) => `${fmt(x.from)}–${fmt(x.to)}「${x.before}」→「${x.after}」`).join('；') + (B.length > 8 ? `；…共 ${B.length} 个` : '');
  const extra = { t: B[0]?.from, score, ...detail };
  if (score < 0.5) add('LOOK', '疑点', id, `${head}。多数交接是裸切换：前后两帧没有共同的东西被带过去或托底，观众每次都要重新找视线落点。若这是有意的（拼贴、快切、章节断开）可忽略；否则看这些时刻能不能让一个元素活过交接（shotlist carry）：${bareTxt}（${how}）`, extra);
  else if (score < 0.7) add('LOOK', '疑点', id, `${head}。有几处裸切换，值得看一眼是不是有意的断点：${bareTxt}（${how}）`, extra);
  else add('PASS', '疑点', id, `${head}${B.length ? `；裸切换：${bareTxt}` : ''}（${how}）`, extra);
}

/** shotlist.md 里 check_shotlist.py --write 生成的时间表 → [{id, a, b}]；没有就 null。 */
function shotTable(md) {
  const m = /<!-- timeline:begin -->([\s\S]*?)<!-- timeline:end -->/.exec(md ?? '');
  if (!m) return null;
  const rows = m[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|')).map((l) => l.split('|').map((c) => c.trim()))
    .filter((c) => Number.isFinite(parseFloat(c[2])) && Number.isFinite(parseFloat(c[3])));
  return rows.length ? rows.map((c) => ({ id: c[1], a: +c[2], b: +c[3] })) : null;
}

/** ctx: { D, F, add, fmt, samples, stills, sfps, marks, markRef, cfg } */
export function runRhythm(ctx) {
  const { D, F, add, fmt, samples, stills, sfps, marks, markRef } = ctx;
  const cfg = typeof ctx.cfg === 'object' && ctx.cfg ? ctx.cfg : {};
  // ---- 镜头长度：rhythm.cuts > shotlist 时间表 > MARKS 起点。continuity.cuts 只是"哪些交接是有意的切"，不是完整分段，不拿来用 ----
  let lens = null, src;
  try {
    const own = resolveCuts(cfg.cuts, markRef);
    if (own) { src = 'film.json checks 的 rhythm.cuts'; lens = cutsToLens(own, D); }
  } catch (e) { add('LOOK', '疑点', 'rhythm.cuts', `cuts：${e.message}`); }
  if (!lens) { const tb = shotTable(F.readText('docs/shotlist.md')); if (tb) { src = 'shotlist.md 时间表（check_shotlist.py --write 生成）'; lens = tb.map((s) => s.b - s.a).filter((x) => x > 1e-6); } }
  if (!lens && marks.length) { src = 'window.MARKS 的起点（场景没有更好的镜头分段时的退路：MARKS 是事件不是镜头，读数要打折扣）'; lens = cutsToLens(marks.map((m) => m.start), D); }
  if (!lens) add('SKIP', '疑点', 'rhythm.cv', '没有镜头分段可用（checks 的 {"rhythm": {"cuts": …}} / shotlist.md 时间表 / window.MARKS 都没有）');
  else if (lens.length < 3) add('SKIP', '疑点', 'rhythm.cv', `只有 ${lens.length} 个镜头（取自 ${src}），变异系数说明不了什么`);
  else {
    const mu = lens.reduce((a, b) => a + b, 0) / lens.length, sd = Math.sqrt(lens.reduce((a, b) => a + (b - mu) ** 2, 0) / lens.length), cv = sd / mu;
    const txt = `${lens.length} 个镜头，长度 ${Math.min(...lens).toFixed(2)}–${Math.max(...lens).toFixed(2)}s（均值 ${mu.toFixed(2)}s），变异系数 ${cv.toFixed(2)}（取自 ${src}）`;
    if (cv < 0.25) add('LOOK', '疑点', 'rhythm.cv', `${txt}：镜头长度几乎等长，像节拍器。等长的代价是观众能预判下一刀、注意力随之放松；需要稳定律动（教学步骤、配乐卡拍）时值得付`, { cv, lens });
    else add('PASS', '疑点', 'rhythm.cv', txt, { cv, lens });
  }
  // ---- 呼吸：静止帧占比 + 最长静止段（与 law.max_still / still 同一份 moved 判定） ----
  const N = samples.length - 1;
  if (N < 1) return;
  const still = samples.filter((x, i) => i > 0 && !x.moved).length / N;
  const longest = stills.reduce((a, r) => (r.to - r.from > a.len ? { len: r.to - r.from, r } : a), { len: 0, r: null });
  const txt = `静止帧占 ${(still * 100).toFixed(1)}%（${sfps}fps 采样，与 max_still 同一判定），最长静止段 ${longest.len.toFixed(2)}s${longest.r ? `（${fmt(longest.r.from)}–${fmt(longest.r.to)}）` : ''}`;
  if (still < 0.25 || longest.len < 1 - 1e-6) add('LOOK', '疑点', 'rhythm.still', `${txt}：${still < 0.25 ? '静止不到 25%' : '没有 ≥1s 的静止段'}，画面一直在动、没有呼吸。代价是观众没有空档消化上一个信息点；高密度的快节奏片可能就要这样`, { still, longest: longest.len });
  else add('PASS', '疑点', 'rhythm.still', txt, { still, longest: longest.len });
}

function cutsToLens(cuts, D) {
  const b = [0, ...cuts.filter((c) => c > 1e-3 && c < D - 1e-3), D].sort((x, y) => x - y);
  const out = []; for (let i = 1; i < b.length; i++) if (b[i] - b[i - 1] > 1e-3) out.push(b[i] - b[i - 1]);
  return out;
}
