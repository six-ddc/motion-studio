// check.mjs 的运动读数：motion（突变 / 同时运动区域 / 匀速段）、variety（镜头间构图变化）、beatsync（画面事件 × 拍点）、
// hook（开头 N 秒）、mute（旁白在说而画面既无字也不动）。
//
// 都只在本片 film.json checks 里声明了才跑，**只报 LOOK / PASS / SKIP，永不 FAIL**：它们是读数和疑点，不是法律。
// 阈值是"报疑点的起点"，来历写在下面每个常量旁；片子在 checks 的对象参数里改（{"motion": {"jerk": 0.7}}）。
// 没声明的片子，check.mjs 不调用本模块，主采样也不多算任何东西，输出与引入它之前相同。
//
// 量的是什么（与你可能以为它量的不一样）：
//   能量 e   相邻两个采样帧在 180px 缩略亮度图上的平均绝对差（0–255）。对平移的实心物体 e ∝ 速度 × 边缘长度 × 反差，
//            所以它是"速度的代理"，不是速度：淡入淡出、变色、物体出现消失也有能量；同速的两个物体，大的那个能量高。
//            逐元素的真实轨迹要用 film-story 的 motionprint.mjs --film（读 window.anchors）。
//   前景     90px 宽的 RGB 缩略图上"与背景色差 > 28"的像素；背景色 = 出现最多的量化色（每通道 4 位）。
//            纯色或近纯色底上准；渐变底、照片底、满屏纹理上前景会把背景一起算进去（读数失真，不会因此 FAIL）。
//   运动区域 前景里互不相连（8 邻接）的块中，含 ≥2 个相邻采样间变化像素（RGB 任一通道差 > 20）的块数。
//   切点     checks 参数 cuts > window.CUT_WINDOWS / CUTS > MARKS 首尾相接处（推测）> 能量尖峰（推测）。切点处的能量不算突变。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sceneCuts, normalizeWindows } from './_cuts.mjs';
import { resolveCuts } from './_flow.mjs';

export const KIN_IDS = ['motion', 'variety', 'beatsync', 'hook', 'mute'];
export const RGB_W = 90;                // 前景分割用的 RGB 缩略图宽度（180 的一半：BFS 连通块的开销 ∝ 像素数）
const FG_TOL = 28, DIFF_RGB = 20;        // 前景色差 / 变化像素阈值（0–255，按通道最大差）：抗锯齿边缘在 90px 缩略下的色差多在 20 以内
const MIN_COMP = 0.0005;                 // 连通块最小面积（占画面）：1920 宽下 ≈ 20px 见方以下的点不计（粒子、噪点）

// ───────────────────────── 每帧的粗特征（check.mjs 主采样里按时间顺序调用） ─────────────────────────
export function kineticsAccumulator() {
  let prevL = null, prevRGB = null;
  return (L, rgb) => {
    const k = { e: null, mov: 0 };
    if (prevL) {
      let s = 0, n = 0;
      for (let i = 0; i < L.length; i++) { const d = Math.abs(L[i] - prevL[i]); s += d; if (d > 8) n++; }
      k.e = s / L.length; k.mov = n / L.length;
    }
    if (rgb) { Object.assign(k, segment(rgb, RGB_W, Math.floor(rgb.length / 3 / RGB_W), prevRGB)); prevRGB = rgb; }
    prevL = L;
    return k;
  };
}

function segment(rgb, W, H, prev) {
  const N = W * H, key = (q) => ((rgb[q] >> 4) << 8) | ((rgb[q + 1] >> 4) << 4) | (rgb[q + 2] >> 4);
  const cnt = new Uint32Array(4096);
  for (let i = 0; i < N; i++) cnt[key(i * 3)]++;
  let mk = 0; for (let c = 1; c < 4096; c++) if (cnt[c] > cnt[mk]) mk = c;
  let br = 0, bgc = 0, bb = 0;
  for (let i = 0; i < N; i++) { const q = i * 3; if (key(q) === mk) { br += rgb[q]; bgc += rgb[q + 1]; bb += rgb[q + 2]; } }
  const bg = [br / cnt[mk], bgc / cnt[mk], bb / cnt[mk]];
  const fg = new Uint8Array(N), hist = new Float32Array(64), md = prev ? new Uint8Array(N) : null;
  for (let i = 0; i < N; i++) {
    const q = i * 3, r = rgb[q], g = rgb[q + 1], b = rgb[q + 2];
    if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > FG_TOL) fg[i] = 1;
    hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    if (md && Math.max(Math.abs(r - prev[q]), Math.abs(g - prev[q + 1]), Math.abs(b - prev[q + 2])) > DIFF_RGB) md[i] = 1;
  }
  // 连通块在"膨胀一格"的前景上找（8 邻接，显式栈）：90px 宽下一格 ≈ 1920 宽的 21px，同一行字、同一个物体被抗锯齿断开的几笔并成一块；
  // 面积、重心、包围盒只计原前景像素。代价：间距小于约两格（≈ 40px@1920）的两个物体会被当成一块。
  const fgD = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!fg[y * W + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) fgD[Y * W + X] = 1; } }
  const lab = new Int32Array(N).fill(-1), stack = new Int32Array(N), minPx = Math.max(2, Math.round(N * MIN_COMP));
  let area = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, nComp = 0, regions = 0, movArea = 0;
  const movBoxes = [];
  for (let s = 0; s < N; s++) {
    if (!fg[s] || lab[s] >= 0) continue;   // 从原前景像素起步，沿膨胀后的掩码扩展
    let sp = 0, n = 0, m = 0, cx = 0, cy = 0, bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    stack[sp++] = s; lab[s] = s;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i / W) | 0;
      if (fg[i]) { n++; cx += x; cy += y; if (md?.[i]) m++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X; if (fgD[j] && lab[j] < 0) { lab[j] = s; stack[sp++] = j; }
      }
    }
    if (n < minPx) continue;
    nComp++; area += n; sx += cx; sy += cy;
    if (bx0 < x0) x0 = bx0; if (by0 < y0) y0 = by0; if (bx1 > x1) x1 = bx1; if (by1 > y1) y1 = by1;
    if (m >= 2) { regions++; movArea += n; if (movBoxes.length < 16) movBoxes.push([bx0 / W, by0 / H, (bx1 + 1) / W, (by1 + 1) / H].map((v) => +v.toFixed(3))); }
  }
  return {
    bg: bg.map(Math.round), fill: area / N, nComp, regions, movArea: movArea / N, movBoxes,
    box: area ? [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H] : null,
    cx: area ? sx / area / W : null, cy: area ? sy / area / H : null,
    hist: Array.from(hist, (v) => +(v / N).toFixed(4)),
  };
}

// ───────────────────────── 共用：分位数、切点、运动段 ─────────────────────────
const quant = (xs, p) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
const cfgOf = (v) => (v && typeof v === 'object' ? v : {});

async function findCuts(ctx, es) {
  const { S, F, D, fps, markRef, cfg } = ctx;
  const own = cfgOf(cfg('motion')).cuts ?? cfgOf(cfg('variety')).cuts ?? cfgOf(cfg('beatsync')).cuts;
  if (own != null) {
    const cs = resolveCuts(own, markRef);
    return { list: cs.map((c) => ({ t0: c, t1: c })), source: 'checks 参数 cuts', guessed: false };
  }
  const sc = await sceneCuts(S.page, fps);
  if (sc) {
    const ws = normalizeWindows(sc.raw, D, sc.source);   // 不合法 → 抛错，调用方报 LOOK 并退回尖峰
    return { list: ws.map((w) => ({ t0: w.t0, t1: w.t1 })), source: sc.source, guessed: /推测/.test(sc.note) };
  }
  // 能量尖峰（推测）：整屏平均变化 ≥ 10/255 且远高于本片中位（×6）、并且是两侧的 2 倍以上——单个采样间隔里发生的整屏变化
  const ts = ctx.ts, med = quant(es.slice(1), 0.5), th = Math.max(10, 6 * med), list = [];
  for (let i = 1; i < es.length; i++) if (es[i] >= th && es[i] >= 2 * Math.max(es[i - 1] ?? 0, es[i + 1] ?? 0)) list.push({ t0: ts[i - 1], t1: ts[i], spike: true });
  return { list, source: list.length ? `能量尖峰（推测：阈值 ${th.toFixed(1)}/255）` : '没有（场景未声明切点，也没测到能量尖峰）', guessed: true };
}

async function prepare(ctx) {
  const { samples, sfps, F, fps, ts } = ctx;
  const es = samples.map((s) => s.k?.e ?? null);
  const P = {};
  try { P.cuts = await findCuts(ctx, es); }
  catch (e) { P.cuts = { list: [], source: `声明不合法，当作没有：${e.message}`, guessed: true, bad: e.message }; }
  const h = 1 / fps;
  P.isCut = es.map((_, i) => i > 0 && P.cuts.list.some((c) => ts[i] >= c.t0 - h - 1e-6 && ts[i - 1] <= c.t1 + h + 1e-6));
  const vals = es.slice(1).filter(Number.isFinite);
  P.baseline = quant(vals, 0.1); P.p98 = quant(vals, 0.98);
  P.rest = cfgOf(ctx.cfg('motion')).rest ?? P.baseline + Math.max(0.01, 0.04 * (P.p98 - P.baseline));
  P.moving = es.map((e, i) => i > 0 && e > P.rest);
  P.es = es;
  // 运动段：连续"在动且不在切点上"的采样；段首前一帧 / 段尾后一帧是静（且不是切点）才算"从静起步 / 停到静"
  P.segs = [];
  for (let i = 1; i < es.length; i++) {
    if (!P.moving[i] || P.isCut[i]) continue;
    let j = i; while (j + 1 < es.length && P.moving[j + 1] && !P.isCut[j + 1]) j++;
    const fromRest = i - 1 >= 1 && !P.moving[i - 1] && !P.isCut[i - 1];
    const toRest = j + 1 < es.length && !P.moving[j + 1] && !P.isCut[j + 1];
    P.segs.push({ a: i, b: j, fromRest, toRest });
    i = j;
  }
  P.restF = P.baseline + (P.rest - P.baseline) * (sfps / fps);   // 成片帧间隔更短，同一运动的帧差按间隔比例缩小
  return P;
}

// 成片帧格上细取：kind=start 在 [t(a-1), +0.45s]，kind=stop 在 [t(b+1) − 0.45s, t(b+1)]。
// 返回 onset/stop 时刻、比值 ratio（起停那两帧的帧差 / 0.45s 窗口里的最大帧差）、需要时留下前后几帧做证据条。
const REFINE = 0.45;
async function refine(ctx, P, cands, { keepAt = null } = {}) {
  const { pool, fps, lastT } = ctx;
  if (!cands.length) return [];
  return pool.chunks(cands, async (w, part) => {
    const out = [];
    for (const c of part) {
      const from = c.kind === 'start' ? c.t : Math.max(0, c.t - REFINE), to = c.kind === 'start' ? Math.min(lastT, c.t + REFINE) : c.t;
      const ks = []; for (let k = Math.ceil(from * fps - 1e-6); k <= Math.floor(to * fps + 1e-6); k++) ks.push(k);
      const pngs = []; for (const k of ks) pngs.push(await w.S.shot(k / fps));
      const eF = [null, ...(await w.ap.evaluate(async (bs) => {
        const A = window.A; let prev = null; const o = [];
        for (const b of bs) { const L = A.lum(await A.load(b)); if (prev) { let s = 0; for (let i = 0; i < L.length; i++) s += Math.abs(L[i] - prev[i]); o.push(s / L.length); } prev = L; }
        return o;
      }, pngs.map((p) => p.toString('base64'))))];
      let j = -1, ratio = null;
      if (c.kind === 'start') {
        j = eF.findIndex((v, i) => i > 0 && v > P.restF);
        if (j > 0) { const pk = Math.max(...eF.slice(j)); ratio = pk > 0 ? Math.max(eF[j], eF[j + 1] ?? 0) / pk : null; }
      } else {
        for (let i = eF.length - 1; i > 0; i--) if (eF[i] > P.restF) { j = i; break; }
        if (j > 0) { const pk = Math.max(...eF.slice(1, j + 1)); ratio = pk > 0 ? Math.max(eF[j], j > 1 ? eF[j - 1] : 0) / pk : null; }
      }
      // 跳变：起停那一帧的帧差是一个孤立尖峰（相邻那帧 < 它的 35%）——东西瞬间出现 / 消失 / 换字，不是"以全速起步"。
      // 线性起步的相邻两帧帧差同量级（夹具实测 1.21 / 1.82），字幕弹出是 7.15 → 0.34（ghost-jam 8.53s）。
      const nb = j > 0 ? (c.kind === 'start' ? eF[j + 1] : eF[j - 1]) : null;
      const step = j > 0 && nb != null && nb < 0.35 * eF[j];
      const r = { ...c, frame: j > 0 ? ks[j] : null, at: j > 0 ? ks[j] / fps : null, ratio, step, eF: eF.map((v) => (v == null ? null : r3(v))) };
      if (j > 0 && keepAt && keepAt(r)) r.strip = [-2, -1, 0, 1, 2].map((d) => j + d).filter((x) => x >= 0 && x < ks.length)
        .map((x) => ({ png: pngs[x], cap: `f${ks[x]} ${(ks[x] / fps).toFixed(3)}s · 帧差 ${eF[x] == null ? '—' : eF[x].toFixed(2)}`, hl: x === j }));
      out.push(r);
    }
    return out;
  }, { size: 1 });
}

// ───────────────────────── 拼图：同一个浏览器里排版截图（与 transitions.mjs 同法） ─────────────────────────
async function sheet(ctx, file, { title, note, rows }) {
  const { S, F, outDir } = ctx;
  const tmp = join(outDir, '.kin-sheet'); mkdirSync(tmp, { recursive: true });
  const tileW = F.width >= F.height ? 320 : 180, tileH = Math.round((tileW * F.height) / F.width);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  let n = 0;
  const body = rows.map((r) => `<div class="row">${r.title ? `<div class="rt">${esc(r.title)}</div>` : ''}<div class="tiles">${r.tiles.map((t) => {
    const f = `t${n++}.png`; writeFileSync(join(tmp, f), t.png);
    const boxes = (t.boxes ?? []).map(([a, b, c, d]) => `<i style="left:${a * tileW}px;top:${b * tileH}px;width:${(c - a) * tileW}px;height:${(d - b) * tileH}px"></i>`).join('');
    return `<div class="tile${t.hl ? ' hl' : ''}"><div class="im"><img src="${f}">${boxes}</div><div class="cap">${esc(t.cap)}</div></div>`;
  }).join('')}</div></div>`).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
 body{margin:0;background:#2b2b2b;color:#eee;font:14px/1.35 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
 .wrap{padding:12px;display:inline-block} h1{font-size:16px;margin:0 0 4px} .meta{color:#bbb;margin:0 0 8px;max-width:${6 * (tileW + 8)}px}
 .row{margin:8px 0 0} .rt{font-weight:600;margin:0 0 4px} .tiles{display:flex;gap:8px;flex-wrap:wrap;max-width:${6 * (tileW + 8)}px}
 .tile{width:${tileW}px} .im{position:relative;width:${tileW}px;height:${tileH}px;outline:1px solid #555} .im img{display:block;width:${tileW}px;height:${tileH}px}
 .im i{position:absolute;box-sizing:border-box;border:2px solid #29e0ff} .hl .im{outline:3px solid #ff7a3d}
 .cap{font:11px/1.3 ui-monospace,Menlo,monospace;padding:3px 0 0;color:#ddd}
</style><div class="wrap" id="sheet"><h1>${esc(title)}</h1><p class="meta">${esc(note)}</p>${body}</div>`;
  const hp = join(tmp, 'sheet.html'); writeFileSync(hp, html);
  const c = await S.browser.newContext({ viewport: { width: 6 * (tileW + 8) + 40, height: 300 }, deviceScaleFactor: 1 });
  try { const pg = await c.newPage(); await pg.goto(pathToFileURL(hp).href, { waitUntil: 'load' }); await (await pg.$('#sheet')).screenshot({ path: file }); }
  finally { await c.close(); rmSync(tmp, { recursive: true, force: true }); }
  return file;
}

// ───────────────────────── motion ─────────────────────────
// 默认阈值的来历（都是报疑点的起点，checks 参数可改）：
//   jerk 0.5     起停那两帧的帧差 / 0.45s 内最大帧差。线性缓动从静止直接到全速，比值 ≈ 1；cubic.inOut 0.3s 实测 0.19、1s 更低；
//                expo.out 的起步、弹出式出场本身就是速度不连续，也会 ≥ 0.5（如实报）。0.5 落在两类的中间（实测见仓库 docs/verified/film-critique.md）
//   regions 5    同时运动的互不相连区域数 ≥ 5 且持续 ≥ 2 个采样。来历：多目标追踪的容量约 4（Pylyshyn & Storm 1988），超过就难以同时盯住
//   uniform      能量在 ±12% 内持续 ≥ 1.0s 算匀速段；匀速段占运动时间 ≥ 30% 报 LOOK。机械感是否是本意（传送带、滚动字幕、恒速旋转）只能人判
const MOTION_DEF = { jerk: 0.5, regions: 5, uniform_tol: 0.12, uniform_min: 1.0, uniform_share: 0.3, max_points: 40 };

async function runMotion(ctx, P, R) {
  const { samples, ts, sfps, add, fmt, outDir } = ctx, C = { ...MOTION_DEF, ...cfgOf(ctx.cfg('motion')) }, id = 'motion';
  const es = P.es, n = es.length;
  const how = `${sfps}fps 采样、180px 缩略亮度帧差；切点来源：${P.cuts.source}`;
  const movingIdx = es.map((_, i) => i).filter((i) => P.moving[i] && !P.isCut[i]);
  const still = samples.filter((x, i) => i > 0 && !x.moved).length / Math.max(1, n - 1);
  const vals = es.slice(1).filter(Number.isFinite), peakI = es.reduce((a, e, i) => (e != null && !P.isCut[i] && e > (es[a] ?? -1) ? i : a), 1);
  const readings = {
    sampleFps: sfps, rest: r3(P.rest), baseline: r3(P.baseline), stillRatio: r3(still), movingRatio: r3(movingIdx.length / Math.max(1, n - 1)),
    energy: { p50: r3(quant(vals, 0.5)), p90: r3(quant(vals, 0.9)), peak: r3(es[peakI] ?? 0), peakT: ts[peakI] },
    cuts: { source: P.cuts.source, count: P.cuts.list.length },
    series: es.map((e) => (e == null ? null : r2(e))),
  };
  if (P.cuts.bad) add('LOOK', '疑点', 'motion.cuts', `切点声明不合法，当作没有切点（切点处的整屏变化可能被当成突变）：${P.cuts.bad}`);

  // ---- 突变：从静起步 / 停到静的那一刻，成片帧格上细取 ----
  const cands = [];
  for (const s of P.segs) {
    if (s.b === s.a) continue;   // 只占一个采样的瞬变（闪、弹出、未声明的切点）不判起停，计数进读数
    if (s.fromRest) cands.push({ kind: 'start', t: ts[s.a - 1], seg: s });
    if (s.toRest) cands.push({ kind: 'stop', t: ts[s.b + 1], seg: s });
  }
  const blips = P.segs.filter((s) => s.b === s.a).map((s) => ts[s.a]);
  const used = cands.slice(0, C.max_points);
  const refd = R.motion = await refine(ctx, P, used, { keepAt: (r) => r.ratio != null && r.ratio >= C.jerk && !r.step });
  const jerks = refd.filter((r) => r.ratio != null && r.ratio >= C.jerk && !r.step), steps = refd.filter((r) => r.step);
  readings.jerk = { checked: refd.length, skipped: cands.length - used.length, threshold: C.jerk, blips: blips.map(r2), steps: steps.map((r) => r3(r.at)),
    points: refd.map((r) => ({ kind: r.kind, t: r.at == null ? null : r3(r.at), ratio: r.ratio == null ? null : r3(r.ratio), step: r.step })) };
  const stepTxt = steps.length ? `；另有 ${steps.length} 处是跳变（瞬间出现 / 消失 / 换字，不算起停）：${steps.slice(0, 6).map((r) => fmt(r.at)).join(' ')}${steps.length > 6 ? '…' : ''}` : '';
  const what = (r) => `${fmt(r.at)} ${r.kind === 'start' ? '起步' : '停住'}（比值 ${r.ratio.toFixed(2)}）`;
  if (!refd.length) add('SKIP', '疑点', 'motion.jerk', `没有"从静起步 / 停到静"的运动段可判（${P.segs.length} 段运动、${blips.length} 个单采样瞬变）（${how}）`);
  else if (jerks.length) {
    const evs = [];
    for (const r of jerks.slice(0, 6)) {
      evs.push(await sheet(ctx, join(outDir, `evidence-motion-jerk-${r.at.toFixed(2)}s.png`), {
        title: `motion.jerk · ${what(r)}`, note: `成片帧格上连续 5 帧，橙框 = ${r.kind === 'start' ? '第一帧在动' : '最后一帧在动'}。比值 = 起停那两帧的帧差 / ${REFINE}s 内最大帧差；≈1 是从静止直接到全速（或全速直接停住）`,
        rows: [{ tiles: r.strip }] }));
      r.strip = null;
    }
    add('LOOK', '疑点', 'motion.jerk', `${jerks.length}/${refd.filter((r) => !r.step && r.ratio != null).length} 处起停是突变（帧差在一帧内从静到峰的 ≥${C.jerk}）：${jerks.slice(0, 8).map(what).join('；')}${jerks.length > 8 ? '…' : ''}。典型来源是线性缓动的硬起硬停，也可能是有意的弹出 / 急停。看证据条判断${stepTxt}（${how}）`,
      { t: jerks[0].at, to: jerks[0].at, ev: evs[0], evidence: evs });
    if (stepTxt) add('PASS', '疑点', 'motion.step', stepTxt.slice(1));
  } else {
    const ok = refd.filter((r) => !r.step && r.ratio != null), nul = refd.filter((r) => r.ratio == null).length;
    add('PASS', '疑点', 'motion.jerk', `${ok.length} 处起停都有渐变${ok.length ? `（比值最大 ${Math.max(...ok.map((r) => r.ratio)).toFixed(2)} < ${C.jerk}）` : ''}${nul ? `；${nul} 处在成片帧格上没量到在动的帧（太慢：逐帧差都在静止阈值内），未判` : ''}${stepTxt}（${how}）`);
  }

  // ---- 同时运动的区域 ----
  if (samples.some((s) => s.k?.regions != null)) {
    const rs = samples.map((s, i) => (i > 0 && P.moving[i] && !P.isCut[i] ? s.k.regions : null));
    const hist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
    for (const v of rs) if (v != null) hist[v >= 5 ? '5+' : v]++;
    let best = -1; rs.forEach((v, i) => { if (v != null && (best < 0 || v > rs[best] || (v === rs[best] && samples[i].k.movArea > samples[best].k.movArea))) best = i; });
    const areas = samples.map((s, i) => (rs[i] != null ? s.k.movArea : null));
    readings.regions = { hist, p50: quant(rs, 0.5), p90: quant(rs, 0.9), max: best >= 0 ? rs[best] : 0, maxT: best >= 0 ? ts[best] : null,
      areaP50: r3(quant(areas, 0.5)), areaP90: r3(quant(areas, 0.9)) };
    let run = 0, runAt = null, longest = { n: 0, i: null };
    rs.forEach((v, i) => { if (v != null && v >= C.regions) { if (!run) runAt = i; run++; if (run > longest.n) longest = { n: run, i: runAt }; } else run = 0; });
    const txt = `运动区域数分布 ${Object.entries(hist).map(([k, v]) => `${k}:${v}`).join(' ')}（在动的采样里），中位 ${readings.regions.p50}、p90 ${readings.regions.p90}；运动面积中位 ${(readings.regions.areaP50 * 100).toFixed(1)}%`;
    if (best >= 0) {
      const ev = await sheet(ctx, join(outDir, `evidence-motion-regions-${ts[best].toFixed(2)}s.png`), {
        title: `motion.regions · 最满的时刻 ${fmt(ts[best])}`, note: `青框 = 这一采样间隔里在动的前景块（${rs[best]} 个，占画面 ${(samples[best].k.movArea * 100).toFixed(1)}%）。前景按背景色差分割，渐变 / 照片底上不准`,
        rows: [{ tiles: [{ png: ctx.evidence.get(ts[best]), cap: `${ts[best].toFixed(2)}s · ${rs[best]} 区`, boxes: samples[best].k.movBoxes }] }] });
      if (longest.n >= 2) add('LOOK', '疑点', 'motion.regions', `${fmt(ts[longest.i])} 起连续 ${longest.n} 个采样有 ≥${C.regions} 块互不相连的区域同时在动（最满 ${fmt(ts[best])}：${rs[best]} 块）。同时追踪的容量约 4 个，超过时观众只能看个大概；粒子、群体、错峰入场的尾巴都会落在这里。${txt}`, { t: ts[longest.i], to: ts[longest.i + longest.n - 1], ev });
      else add('PASS', '疑点', 'motion.regions', `最满 ${fmt(ts[best])}：${rs[best]} 块同时在动。${txt}`, { ev });
    } else add('SKIP', '疑点', 'motion.regions', '没有在动的采样');
  }

  // ---- 匀速段 ----
  const minN = Math.max(2, Math.round(C.uniform_min * sfps)), runs = [];
  for (const s of P.segs) {
    for (let i = s.a; i <= s.b;) {
      let lo = es[i], hi = es[i], sum = es[i], j = i;
      while (j + 1 <= s.b) { const v = es[j + 1], L = Math.min(lo, v), H = Math.max(hi, v), m = (sum + v) / (j + 2 - i); if (H - L > 2 * C.uniform_tol * m) break; lo = L; hi = H; sum += v; j++; }
      if (j - i + 1 >= minN) { runs.push({ from: ts[i - 1], to: ts[j], e: sum / (j - i + 1) }); i = j + 1; } else i++;
    }
  }
  const movT = movingIdx.length / sfps, uniT = runs.reduce((a, r) => a + (r.to - r.from), 0), share = movT ? uniT / movT : 0;
  readings.uniform = { share: r3(share), seconds: r2(uniT), runs: runs.map((r) => ({ from: r2(r.from), to: r2(r.to), e: r2(r.e) })) };
  const rtxt = runs.slice(0, 6).map((r) => `${fmt(r.from)}–${fmt(r.to)}`).join('、') + (runs.length > 6 ? '…' : '');
  if (!movT) add('SKIP', '疑点', 'motion.uniform', '没有在动的采样');
  else if (share >= C.uniform_share) {
    const r0 = runs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    const ev = await sheet(ctx, join(outDir, `evidence-motion-uniform-${r0.from.toFixed(2)}s.png`), {
      title: `motion.uniform · 最长匀速段 ${fmt(r0.from)}–${fmt(r0.to)}`, note: `能量在 ±${C.uniform_tol * 100}% 内保持不变：恒速运动。前、中、后三帧`,
      rows: [{ tiles: [r0.from, (r0.from + r0.to) / 2, r0.to].map((t) => { const s = ts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)); return { png: ctx.evidence.get(s), cap: `${s.toFixed(2)}s · e ${(es[ts.indexOf(s)] ?? 0).toFixed(2)}` }; }) }] });
    add('LOOK', '疑点', 'motion.uniform', `匀速段占运动时间 ${(share * 100).toFixed(0)}%（${uniT.toFixed(1)}s / ${movT.toFixed(1)}s；≥${C.uniform_min}s、能量 ±${C.uniform_tol * 100}% 内）：${rtxt}。恒速的代价是读起来像机械（传送带、匀速平移）；滚动字幕、恒速旋转等要的就是它（${how}）`, { t: r0.from, to: r0.to, ev });
  } else add('PASS', '疑点', 'motion.uniform', `匀速段占运动时间 ${(share * 100).toFixed(0)}%${runs.length ? `：${rtxt}` : ''}`);

  add('PASS', '疑点', 'motion', `运动读数：静止帧 ${(still * 100).toFixed(1)}%、在动 ${(readings.movingRatio * 100).toFixed(1)}%，能量中位 ${readings.energy.p50} / p90 ${readings.energy.p90} / 峰 ${readings.energy.peak}@${fmt(readings.energy.peakT)}（0–255 帧差；整条曲线在 checks.json 的 kinetics.motion.series）`);
  return readings;
}

// ───────────────────────── variety ─────────────────────────
// 每个镜头取"最定型的那一帧"（镜头中段 70% 里能量最低的采样）的粗特征：前景包围盒的线性尺度（景别的代理）、前景重心、前景填充率，
// 可选主色直方图。和镜头的第一个代表帧比，下面几项都在阈值内就算"几乎相同"；连续 run 个这样的镜头报 LOOK。
// 默认阈值来历：景别跳一档约是 1.5× 线性尺度（剪辑的"30° / 景别跳一档"惯例），取 1.25 只抓明显没变的；
// 重心 0.08（画面宽高归一化的欧氏距离）、填充率 1.3×、颜色直方图距离 0.3 是报疑点的起点，不是测出来的分界：
// 本仓库夹具上同构图的相邻镜头读数是 1.00× / 0 / 1.00×，换构图的相邻镜头最小 1.27× / 0.25 / 1.61×（tests/fixtures/_test-kin-variety）。
const VARIETY_DEF = { run: 4, scale: 1.25, center: 0.08, fill: 1.3, color: 0.3, features: ['scale', 'center', 'fill'] };

function runVariety(ctx, P) {
  const { samples, ts, sfps, D, add, fmt } = ctx, C = { ...VARIETY_DEF, ...cfgOf(ctx.cfg('variety')) }, id = 'variety';
  const cuts = P.cuts.list;
  const bounds = []; let a = 0;
  for (const c of cuts) { if (c.t0 > a + 1e-6) bounds.push([a, c.t0]); a = Math.max(a, c.t1); }
  if (D > a + 1e-6) bounds.push([a, D]);
  const shots = bounds.map(([s, e], k) => {
    const L = e - s, inner = samples.map((x, i) => i).filter((i) => ts[i] >= s + 0.15 * L - 1e-6 && ts[i] <= e - 0.15 * L + 1e-6 && ts[i] < e - 1e-6);
    const pool = inner.length ? inner : [samples.map((x, i) => i).reduce((p, i) => (Math.abs(ts[i] - (s + e) / 2) < Math.abs(ts[p] - (s + e) / 2) ? i : p), 0)];
    const rep = pool.reduce((p, i) => ((P.es[i] ?? 0) < (P.es[p] ?? 0) ? i : p), pool[0]);
    const f = (i) => { const q = samples[i].k; const sc = q.box ? Math.sqrt((q.box[2] - q.box[0]) * (q.box[3] - q.box[1])) : 0; return { scale: sc, cx: q.cx ?? 0.5, cy: q.cy ?? 0.5, fill: q.fill, hist: q.hist }; };
    const R = f(rep), A = f(pool[0]), B = f(pool.at(-1));
    const internal = { scale: A.scale && B.scale ? Math.max(A.scale, B.scale) / Math.min(A.scale, B.scale) : 1, travel: Math.hypot(B.cx - A.cx, B.cy - A.cy) };
    return { k: k + 1, from: s, to: e, rep, t: ts[rep], ...R, internal, moves: internal.scale >= C.scale || internal.travel >= C.center };
  });
  const src = `切点来源：${P.cuts.source}${P.cuts.guessed && P.cuts.list.length ? '；推测来源只有确实是镜头分段时读数才成立' : ''}`;
  const readings = { source: P.cuts.source, guessed: P.cuts.guessed, thresholds: C,
    shots: shots.map((s) => ({ k: s.k, from: r2(s.from), to: r2(s.to), t: s.t, scale: r3(s.scale), cx: r3(s.cx), cy: r3(s.cy), fill: r3(s.fill), internalScale: r2(s.internal.scale), internalTravel: r3(s.internal.travel) })) };
  if (shots.length < C.run) { add('SKIP', '疑点', id, `只有 ${shots.length} 个镜头（${src}），不到 run=${C.run}，镜头间变化说明不了什么`); return { readings }; }
  const dist = (x, y) => {
    const d = { scale: x.scale && y.scale ? Math.max(x.scale, y.scale) / Math.min(x.scale, y.scale) : (x.scale || y.scale ? Infinity : 1),
      center: Math.hypot(x.cx - y.cx, x.cy - y.cy), fill: x.fill && y.fill ? Math.max(x.fill, y.fill) / Math.min(x.fill, y.fill) : (x.fill || y.fill ? Infinity : 1),
      color: x.hist.reduce((acc, v, i) => acc + Math.abs(v - y.hist[i]), 0) / 2 };
    return d;
  };
  const same = (x, y) => { const d = dist(x, y); return C.features.every((f) => d[f] < C[f]); };
  const runs = [];
  for (let i = 0; i < shots.length;) {
    let j = i;
    if (!shots[i].moves) while (j + 1 < shots.length && !shots[j + 1].moves && same(shots[i], shots[j + 1])) j++;
    if (j - i + 1 >= C.run) runs.push([i, j]);
    i = j + 1;
  }
  const scales = shots.map((s) => s.scale).filter((v) => v > 0), spread = scales.length ? Math.max(...scales) / Math.min(...scales) : 1;
  readings.scaleSpread = r2(spread); readings.runs = runs.map(([i, j]) => [shots[i].k, shots[j].k]);
  const cap = (s) => `#${s.k} ${s.from.toFixed(1)}–${s.to.toFixed(1)}s 尺度${s.scale.toFixed(2)} 心(${s.cx.toFixed(2)},${s.cy.toFixed(2)}) 填${(s.fill * 100).toFixed(0)}%`;
  return { readings, shots, runs, spread, src, cap, C };
}

async function reportVariety(ctx, V) {
  const { add, fmt, outDir, evidence } = ctx, id = 'variety';
  if (!V.runs) return V.readings;
  const { shots, runs, spread, src, cap, C } = V;
  const head = `${shots.length} 个镜头，前景尺度跨度 ${spread.toFixed(2)}×（最大 / 最小；景别一档约 1.5×）`;
  if (runs.length) {
    const [i, j] = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const seg = shots.slice(i, j + 1), ev = await sheet(ctx, join(outDir, `evidence-variety-${seg[0].from.toFixed(2)}s.png`), {
      title: `variety · 镜头 #${seg[0].k}–#${seg.at(-1).k} 构图几乎相同`, note: `每格 = 该镜头中段最定型的一帧（${src}）。比的是 ${C.features.join(' / ')}：尺度 < ${C.scale}×、重心 < ${C.center}、填充 < ${C.fill}×${C.features.includes('color') ? `、颜色 < ${C.color}` : ''}`,
      rows: [{ tiles: seg.map((s) => ({ png: evidence.get(s.t), cap: cap(s) })) }] });
    add('LOOK', '疑点', id, `${head}；${runs.length} 段连续 ≥${C.run} 个镜头构图几乎相同（${runs.map(([a, b]) => `#${shots[a].k}–#${shots[b].k} ${fmt(shots[a].from)}–${fmt(shots[b].to)}`).join('、')}）：景别、重心、填充率都没变，镜头内也没有推拉横移。代价是每个镜头读起来像同一张卡换了内容；章节卡、刻意的版式重复要的就是它（${src}）`,
      { t: seg[0].from, to: seg.at(-1).to, ev });
  } else add('PASS', '疑点', id, `${head}；没有连续 ${C.run} 个构图几乎相同的镜头（${src}）`);
  return V.readings;
}

// ───────────────────────── beatsync ─────────────────────────
// 事件：声明的切点、MARKS 起点、运动起步（成片帧格上细取到第一帧在动，分辨率 1/fps）。拍点：beats.json / music.json。
// "每个事件都卡拍"不是目标；只报读数和两类离群：
//   整体偏移   事件 ≥ 3 个且带符号偏差的中位数 |m| > tol：多半是时间轴整体错位（offset、片头留白、音乐起点没对上）
//   差一点卡上 tol < |偏差| ≤ near × 拍间隔，且本片 ≥ 50% 的事件在 tol 内（看得出想卡拍）：这几个"差一点"
// tol 默认 0.1s：ITU-R BT.1359 的视听不同步可察觉阈约 +45 / −125 ms，取两者之间；near 0.4：落在半拍附近（≥ 0.4 拍）的是切分，不算差一点。
const BEAT_DEF = { tol: 0.1, near: 0.4, grid: 'beats', offset: 0, events: ['cuts', 'marks', 'onsets'] };

function beatFile(F, cfg) {
  const cands = cfg.file ? [cfg.file] : ['out/beats.json', 'out/music.json', 'music.json', 'beats.json'];
  for (const rel of cands) { try { const j = F.readJSON(rel); if (j) return { rel, j }; } catch (e) { return { rel, err: e.message }; } }
  return null;
}

async function runBeatsync(ctx, P, R) {
  const { F, ts, fps, add, fmt, marks } = ctx, C = { ...BEAT_DEF, ...cfgOf(ctx.cfg('beatsync')) }, id = 'beatsync';
  const bf = beatFile(F, C);
  if (!bf) { add('SKIP', '疑点', id, `没有节拍文件（${C.file ?? 'out/beats.json / out/music.json / music.json / beats.json'}），不量`); return null; }
  if (bf.err) { add('LOOK', '疑点', id, `${bf.rel} 读不了：${bf.err}`); return null; }
  const beats = (bf.j[C.grid] ?? []).map((b) => b + C.offset).filter(Number.isFinite).sort((x, y) => x - y);
  if (beats.length < 2) { add('SKIP', '疑点', id, `${bf.rel} 的 ${C.grid} 少于 2 个拍点`); return null; }
  const ev = [];
  if (C.events.includes('cuts')) for (const c of P.cuts.list) ev.push({ kind: c.spike ? '切点(推测)' : '切点', t: c.spike ? null : c.t0, spike: c.spike ? c : null });
  if (C.events.includes('marks')) for (const m of marks) if (Number.isFinite(m.start) && m.start > 1e-6) ev.push({ kind: `MARK「${m.label}」`, t: m.start });
  if (C.events.includes('onsets')) {
    const starts = P.segs.filter((s) => s.fromRest).map((s) => ({ kind: 'start', t: ts[s.a - 1] }));
    const spikeC = ev.filter((e) => e.spike).map((e) => ({ kind: 'start', t: e.spike.t0, spike: true }));
    const refd = await refine(ctx, P, [...starts, ...spikeC].slice(0, 80));
    for (const r of refd) if (r.at != null) { if (r.spike) { const e = ev.find((x) => x.spike && x.spike.t0 === r.t); if (e) e.t = r.at; } else ev.push({ kind: '运动起步', t: r.at }); }
  }
  const evs = ev.filter((e) => e.t != null).sort((x, y) => x.t - y.t).filter((e, i, a) => !a.slice(0, i).some((p) => Math.abs(p.t - e.t) < 1 / fps + 1e-6));
  if (!evs.length) { add('SKIP', '疑点', id, `${bf.rel} 有 ${beats.length} 个拍点，但画面上没有可量的事件（切点 / MARKS / 运动起步）`); return null; }
  const near = (t) => { let k = 0; for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - t) < Math.abs(beats[k] - t)) k = i; const iv = (beats[Math.min(beats.length - 1, k + 1)] - beats[Math.max(0, k - 1)]) / (k > 0 && k < beats.length - 1 ? 2 : 1); return { k, d: t - beats[k], iv }; };
  const rows = evs.map((e) => ({ ...e, ...near(e.t) }));
  const signed = quant(rows.map((r) => r.d), 0.5), absMed = quant(rows.map((r) => Math.abs(r.d)), 0.5);
  const onBeat = rows.filter((r) => Math.abs(r.d) <= C.tol).length / rows.length;
  const miss = rows.filter((r) => Math.abs(r.d) > C.tol && Math.abs(r.d) <= C.near * r.iv);
  const readings = { file: bf.rel, grid: C.grid, beats: beats.length, events: rows.length, medianSigned: r3(signed), medianAbs: r3(absMed), onBeatShare: r3(onBeat), tol: C.tol,
    rows: rows.map((r) => ({ kind: r.kind, t: r3(r.t), beat: r3(beats[r.k]), d: r3(r.d) })) };
  const ms = (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 1000)}ms`;
  const head = `${rows.length} 个画面事件 × ${beats.length} 个拍点（${bf.rel} 的 ${C.grid}）：偏差中位 ${ms(signed)}（绝对值中位 ${Math.round(absMed * 1000)}ms），${(onBeat * 100).toFixed(0)}% 在 ±${Math.round(C.tol * 1000)}ms 内；事件时刻分辨率 1/${fps}s`;
  const list = (xs) => xs.slice(0, 8).map((r) => `${fmt(r.t)} ${r.kind}（拍 ${fmt(beats[r.k])}，${ms(r.d)}）`).join('；') + (xs.length > 8 ? `；…共 ${xs.length} 个` : '');
  const evSheet = async (xs, why) => {
    const sh = [];
    for (const r of xs.slice(0, 4)) {
      const bt = Math.max(0, Math.min(ctx.lastT, Math.round(beats[r.k] * fps) / fps)), pre = Math.max(0, Math.round(r.t * fps) / fps - 1 / fps);
      sh.push({ title: `${r.kind} ${r.t.toFixed(3)}s · 最近的拍 ${beats[r.k].toFixed(3)}s · ${ms(r.d)}`, tiles: [
        { png: await ctx.S.shot(bt), cap: `拍点 ${bt.toFixed(3)}s`, hl: true }, { png: await ctx.S.shot(pre), cap: `事件前一帧 ${pre.toFixed(3)}s` }, { png: await ctx.S.shot(r.t), cap: `事件 ${r.t.toFixed(3)}s` }] });
    }
    return sheet(ctx, join(ctx.outDir, `evidence-beatsync-${xs[0].t.toFixed(2)}s.png`), { title: `beatsync · ${why}`, note: `每行：拍点那一帧（橙框）/ 事件前一帧 / 事件第一帧（${bf.rel} 的 ${C.grid}）。最多列 4 个`, rows: sh });
  };
  if (rows.length >= 3 && Math.abs(signed) > C.tol) add('LOOK', '疑点', id, `${head}。整体偏移：多数事件都${signed > 0 ? '晚' : '早'}于拍点约 ${Math.round(Math.abs(signed) * 1000)}ms，多半是时间轴整体错位（narrationOffset、音乐起点、拍点文件不是这一版）：${list(rows)}`, { t: rows[0].t, to: rows.at(-1).t, ev: await evSheet(rows, '整体偏移') });
  else if (miss.length && onBeat >= 0.5) add('LOOK', '疑点', id, `${head}。看得出在卡拍，这 ${miss.length} 个差一点（${Math.round(C.tol * 1000)}ms < |偏差| ≤ ${C.near} 拍）：${list(miss)}`, { t: miss[0].t, to: miss.at(-1).t, ev: await evSheet(miss, '差一点卡上') });
  else add('PASS', '疑点', id, `${head}${onBeat < 0.5 && miss.length ? '；事件与拍点没有明显对齐关系，读数仅供参考' : ''}`);
  return readings;
}

// ───────────────────────── hook ─────────────────────────
// 开头 seconds 秒（默认 3）：首个有内容的采样在几秒（内容量口径同 empty.vo / cover：缩略图边缘像素占比）、这段里有没有任何变化、
// 前景填充和边缘量从 t=0 到 N 的增长、有没有截到文字。拼 0 / N/6 / N/3 / 2N/3 / N 五帧（默认 0 / 0.5 / 1 / 2 / 3s）。
// LOOK：空画面持续 ≥ empty_max（默认 1.0s），或这 N 秒里画面一帧都没变。首帧是否为空归 cover.empty，这里不重复判。
// 来历：短视频平台以"前 3 秒"作为完播的第一道筛（平台创作者文档的惯例口径）；1.0s 留给从黑场淡入的正当开场。
const HOOK_DEF = { seconds: 3, empty_max: 1.0 };

async function runHook(ctx) {
  const { S, samples, ts, lastT, D, add, fmt, outDir, emptyTh, coverOn } = ctx, C = { ...HOOK_DEF, ...cfgOf(ctx.cfg('hook')) }, id = 'hook';
  const N = Math.min(C.seconds, D), win = samples.filter((s) => s.t <= N + 1e-6);
  const first = win.find((s) => s.edge >= emptyTh), lead = first ? first.t : null;
  const moved = win.filter((s, i) => i > 0 && s.moved).length, changed = moved > 0;
  const e0 = win[0]?.edge ?? 0, eMax = Math.max(...win.map((s) => s.edge)), f0 = win[0]?.k?.fill ?? null, fN = win.at(-1)?.k?.fill ?? null;
  const texted = win.filter((s) => s.texts?.some((x) => x.onscreen && x.alpha >= 0.05 && x.text.trim())).length;
  const pts = [0, N / 6, N / 3, (2 * N) / 3, N].map((t) => Math.min(lastT, t));
  const tiles = [];
  for (const t of pts) {
    const s = samples.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    tiles.push({ png: await S.shot(t), cap: `${t.toFixed(2)}s · 边缘 ${(s.edge * 100).toFixed(2)}%${s.k?.fill != null ? ` · 前景 ${(s.k.fill * 100).toFixed(0)}%` : ''}` });
  }
  const ev = await sheet(ctx, join(outDir, `evidence-hook-${N.toFixed(2)}s.png`), { title: `hook · 开头 ${N}s`, note: `0 / ${pts.slice(1).map((t) => t.toFixed(2)).join(' / ')}s 五帧（取帧时刻在成片里不一定恰好是帧格）。内容量 = 缩略图边缘像素占比（同 empty.vo / cover）`, rows: [{ tiles }] });
  const readings = { seconds: N, firstContent: lead, movedSamples: moved, samples: win.length, edge0: r3(e0), edgeMax: r3(eMax), fill0: f0 == null ? null : r3(f0), fillEnd: fN == null ? null : r3(fN), textSamples: texted };
  const txt = `开头 ${N}s：${lead == null ? '一直是空画面' : lead > 0 ? `第一个有内容的采样在 ${fmt(lead)}` : '首帧即有内容'}，${moved}/${Math.max(0, win.length - 1)} 个采样在变，边缘量 ${(e0 * 100).toFixed(2)}% → 峰 ${(eMax * 100).toFixed(2)}%${f0 != null ? `，前景 ${(f0 * 100).toFixed(0)}% → ${(fN * 100).toFixed(0)}%` : ''}，${texted ? `${texted} 个采样截到文字` : '没截到文字'}${coverOn ? '（首帧空不空见 cover.empty）' : ''}`;
  if (lead == null || lead >= C.empty_max - 1e-6) add('LOOK', '疑点', id, `${txt}。空画面持续 ≥ ${C.empty_max}s：静音自动播放的观众在这段时间里没有东西可看。若是有意的黑场 / 留白开场，在 MARKS 上给这段写 hold 理由`, { t: 0, to: lead ?? N, ev });
  else if (!changed) add('LOOK', '疑点', id, `${txt}。这 ${N}s 里画面一帧都没变：开头是一张静图`, { t: 0, to: N, ev });
  else add('PASS', '疑点', id, txt, { ev });
  return readings;
}

// ───────────────────────── mute ─────────────────────────
// 静音可懂性的代理：旁白在说的采样里，画面上没截到任何文字（canvas fillText / DOM 文本）**且**画面没变（与 still 同一判定）的占比。
// 与 empty.vo 不重复：empty.vo 只抓"画面已空"；这里抓"画面不空、但关掉声音什么新东西都得不到"。
// LOOK：这类采样占旁白时间 ≥ share（默认 25%），或连续 ≥ run（默认 2.0s）。来历：信息流里多数观看是静音的，
// 无字又不动的段落对静音观众是空白；25% / 2s 是报疑点的起点，不是行业数字。
const MUTE_DEF = { share: 0.25, run: 2.0 };

async function runMute(ctx) {
  const { samples, sfps, lines, add, fmt, outDir, evidence } = ctx, C = { ...MUTE_DEF, ...cfgOf(ctx.cfg('mute')) }, id = 'mute';
  if (!lines.length) { add('SKIP', '疑点', id, '没有 narration.json（或没有句子）：没有"旁白在说"的区间可量'); return null; }
  const speaking = (t) => lines.some((l) => t >= l.s - 1e-6 && t < l.e);
  const hasText = (s) => s.texts?.some((x) => x.onscreen && x.alpha >= 0.05 && x.text.trim());
  const vo = samples.map((s, i) => ({ s, i, on: speaking(s.t) })).filter((x) => x.on);
  if (!vo.length) { add('SKIP', '疑点', id, '采样帧里没有落在旁白区间的'); return null; }
  const noText = vo.filter((x) => !hasText(x.s)), still = vo.filter((x) => x.i > 0 && !x.s.moved), dead = vo.filter((x) => !hasText(x.s) && x.i > 0 && !x.s.moved);
  const runs = []; let cur = null;
  for (const x of vo) { const d = !hasText(x.s) && x.i > 0 && !x.s.moved; if (d && cur && x.i === cur.j + 1) cur.j = x.i; else if (d) { cur = { i: x.i, j: x.i }; runs.push(cur); } else cur = null; }
  const longest = runs.reduce((a, r) => (r.j - r.i > (a?.j ?? 0) - (a?.i ?? 0) ? r : a), null);
  const share = dead.length / vo.length, lenL = longest ? (longest.j - longest.i + 1) / sfps : 0;
  const readings = { voSamples: vo.length, noTextShare: r3(noText.length / vo.length), stillShare: r3(still.length / vo.length), deadShare: r3(share), longest: r2(lenL) };
  const txt = `旁白在说的 ${vo.length} 个采样里：无字 ${(readings.noTextShare * 100).toFixed(0)}%、画面不动 ${(readings.stillShare * 100).toFixed(0)}%、既无字又不动 ${(share * 100).toFixed(0)}%（最长连续 ${lenL.toFixed(1)}s${longest ? ` @${fmt(samples[longest.i].t)}` : ''}）`;
  if (share >= C.share || lenL >= C.run - 1e-6) {
    const t = samples[longest.i].t, l = lines.find((q) => t >= q.s - 1e-6 && t < q.e);
    const f = join(outDir, `evidence-mute-${t.toFixed(2)}s.png`); writeFileSync(f, evidence.get(t));
    add('LOOK', '疑点', id, `${txt}。关掉声音时这些段落什么新东西都得不到${l ? `；例如 ${l.id}「${String(l.text).slice(0, 16)}」` : ''}。截不到预渲染进位图 / 路径 / WebGL 的字，那种情况是误报`, { t, to: samples[longest.j].t + 1 / sfps, ev: f });
  } else add('PASS', '疑点', id, txt);
  return readings;
}

// ───────────────────────── 入口 ─────────────────────────
/** ctx: { S, pool, F, D, fps, sfps, ts, lastT, samples, evidence, marks, markRef, lines, emptyTh, coverOn, add, fmt, outDir, on, cfg(id) } → 读数对象（进 checks.json 的 kinetics） */
export async function runKinetics(ctx) {
  const t0 = Date.now(), out = { cost: {} };
  const needP = ['motion', 'variety', 'beatsync'].some(ctx.on);
  const P = needP ? await prepare(ctx) : null, R = {};
  const lap = async (k, fn) => { const a = Date.now(); const r = await fn(); out.cost[k] = Date.now() - a; return r; };
  if (ctx.on('motion')) out.motion = await lap('motion', () => runMotion(ctx, P, R));
  if (ctx.on('variety')) out.variety = await lap('variety', () => reportVariety(ctx, runVariety(ctx, P)));
  if (ctx.on('beatsync')) out.beatsync = await lap('beatsync', () => runBeatsync(ctx, P, R));
  if (ctx.on('hook')) out.hook = await lap('hook', () => runHook(ctx));
  if (ctx.on('mute')) out.mute = await lap('mute', () => runMute(ctx));
  out.cost.total = Date.now() - t0;
  return out;
}
