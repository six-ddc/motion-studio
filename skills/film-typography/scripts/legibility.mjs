#!/usr/bin/env node
// 小字号可读性实测：在成片分辨率下画字，缩到手机有效宽度（默认 360 CSS px）后，
// 用客观指标判断笔画是否还分得开。给出"最小可读字号"（成片像素 & 有效 px）和对比度下限。
//
//   node legibility.mjs --film <slug> --cjk '"Noto Sans SC Variable"' --latin '"Inter Variable"'
//       [--frame-width 1080] [--view 360] [--weights 400,700]
//       [--min 12] [--max 72] [--step 2]     字号扫描范围（**成片 px**，按 --frame-width 缩放：
//                                            1080 宽时 12–72，1920 宽时 22–128，都等于 4–24 有效px。
//                                            1080 宽的默认值 = 最初测 8.7/10.0/18.7 的那次）
//       [--phases 0]                         >0 时附加"像素相位"诊断：言 在 N 个亚像素偏移下各测一次
//       [--chars '一圈路']                    附加逐字下限：每个字各自的横画段数 vs 它 300px 时的参考
//       [--at 58.32,40]                      附加"指定字号判定"：在这些成片 px 字号下 言/逐字 过不过
//       [--out legibility]                   输出文件名前缀（films/<slug>/out/<out>.txt|.json）
//       [--dir <目录>]                        代替 --film：任意含 assets/fonts/fonts.css 的目录（相对 cwd），输出进 <目录>/out/
//       [--films-dir <dir>]                  films/ 位置（默认 $FILMS_DIR，再从 cwd 往上找含 films/ 的目录）
//
// 指标（都在缩小后的图上算）：
//   笔画可分辨：取一个多横画的字（量，9 条横向笔画段）或多竖画的串（mmm，9 根竖干），
//     沿笔画垂直方向取墨水剖面，在 50% 墨量处二值化数段数。段数等于大字号时的参考值 = 分得开。
//     最小可读字号 = 从这个字号起往上（到 --max）全部分得开的最小值。
//   形近字区分：未/末、己/已、rn/m 缩小后的逐像素差异（参考用，不参与判定）。
//   笔画峰值覆盖率：下限字号下，笔画中心像素的墨量中位数（< 1 表示细笔画被抹灰）。
//     有效对比度 = 按覆盖率混合前景/背景后的 WCAG 对比度；据此反推所需的标称对比度。
//   笔画几何（不缩放，1000px 画）：言 在"最能分开的那一列"上最窄的笔画间隙与笔画厚度（em）。
//     用来解释下限为什么随字重变：间隙被加粗吃掉，下限 ≈ 常数 / 间隙。
// 主判据（默认参数下）与最初版本数字一致（仓库 docs/verified/film-typography.md 有比对）；新增项全部是附加诊断，不改主判据。
// 字体必须已打包进影片（fontpack.mjs），从 films/<slug>/assets/fonts/fonts.css 加载。
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cli, FILM_OPTS } from '../../film-core/lib/cli.mjs';
import { locateFilmsDir, noFilmsDirMessage } from '../../film-core/lib/env.mjs';
import { serve } from '../../film-core/lib/serve.mjs';
import { launchBrowser } from '../../film-core/lib/browser.mjs';

cli({
  usage: "node legibility.mjs --film <slug> --cjk '\"Noto Sans SC Variable\"' --latin '\"Inter Variable\"' [选项]",
  about: '小字号可读性实测：成片分辨率画字、缩到手机有效宽度后判断笔画是否分得开，给出最小可读字号与对比度下限。\n'
    + '产出 films/<slug>/out/<out>.txt|.json（或 <dir>/out/）。字体须已由 fontpack.mjs 打包进 assets/fonts/fonts.css。',
  opts: {
    ...FILM_OPTS,
    dir: ['<目录>', '代替 --film：任意含 assets/fonts/fonts.css 的目录（相对 cwd）'],
    cjk: ['<字族>', 'CJK 字族（CSS font-family 写法，必填）'], latin: ['<字族>', '拉丁字族（必填）'],
    'frame-width': ['<px>', '成片宽（默认 1080）'], view: ['<px>', '手机有效宽（默认 360）'],
    weights: ['<w1,w2>', '字重（默认 400,700）'],
    min: ['<px>', '扫描下限（成片 px）'], max: ['<px>', '扫描上限（成片 px）'], step: ['<px>', '扫描步长（成片 px）'],
    phases: ['<N>', '>0 时附加像素相位诊断'], chars: ['<字>', '附加逐字下限'],
    at: ['<px,px>', '附加指定字号判定（成片 px）'], out: ['<前缀>', '输出文件名前缀（默认 legibility）'],
    png: '未实现（旧注释里写过，脚本从没产出过 PNG；给了会报错）',
  },
});
if (process.argv.includes('--png')) { process.stderr.write('legibility: --png 未实现（脚本不产出 PNG）\n'); process.exit(2); }
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { process.stderr.write(`legibility: ${m}\n`); process.exit(2); };
// --dir 直接给一个含 assets/fonts/fonts.css 的目录（例如从别的片子只读拷出来的字体夹具），代替 --film
// films/ 按 --films-dir > $FILMS_DIR > 从 cwd 往上找（film-core lib/env.mjs）
const filmsRoot = () => locateFilmsDir(flag('films-dir')) ?? die(noFilmsDirMessage());
const dir = flag('dir') ? resolve(process.cwd(), flag('dir')) : join(filmsRoot(), flag('film') ?? die('需要 --film <slug> 或 --dir <目录>'));
if (!existsSync(join(dir, 'assets/fonts/fonts.css'))) die(`${dir}/assets/fonts/fonts.css 不存在，先跑 fontpack.mjs`);
const CJK = flag('cjk') ?? die('需要 --cjk 字族');
const LAT = flag('latin') ?? die('需要 --latin 字族');
const FW = Number(flag('frame-width', 1080));
const VIEW = Number(flag('view', 360));
const WEIGHTS = flag('weights', '400,700').split(',').map(Number);
// 扫描范围是**成片 px**，下限却是**有效 px**，两者差 FW/VIEW 倍。
// 12–72 这对默认值是在 1080 宽上定的（有效 4–24px，正好跨过中文 18.7 那条线）。
// 原样搬到 1920 宽的片上，72 成片px 只有 13.5 有效px —— 扫描从没碰到阈值，
// 整列主判据全是 null，打出来却像"每一档都只有 1 段、全不合格"。
// 所以默认范围跟着画幅缩放，让"默认参数"在任何画幅下都等价于 4–24 有效px。
const defSize = (v) => Math.max(2, Math.round((v * FW) / 1080 / 2) * 2);
const MIN = Number(flag('min', defSize(12))), MAX = Number(flag('max', defSize(72))), STEP = Number(flag('step', 2));
const PHASES = Number(flag('phases', 0));
const CHARS = [...new Set([...(flag('chars', '') ?? '')].filter((c) => /[㐀-鿿豈-﫿]/.test(c)))].join('');
const AT = (flag('at', '') ?? '').split(',').filter(Boolean).map(Number);
const OUT = flag('out', 'legibility');
if (![FW, VIEW, MIN, MAX, STEP].every((v) => v > 0) || WEIGHTS.some((w) => !(w >= 1 && w <= 1000)) || AT.some((v) => !(v > 0))) die('数值参数不合法');

// 只托管字体：不挂运行时、不写加载记录（这不是在看片子）
const server = await serve(dir, { runtime: false, record: false,
  routes: { '/': '<!doctype html><link rel=stylesheet href="/assets/fonts/fonts.css"><body>' } });
const browser = await launchBrowser();
const page = await browser.newPage();
await page.goto(`${server.url}/`);

const res = await page.evaluate(async ({ CJK, LAT, FW, VIEW, WEIGHTS, MIN, MAX, STEP, PHASES, CHARS, AT }) => {
  for (const w of WEIGHTS) {
    const a = await document.fonts.load(`${w} 40px ${CJK}`, '量言未末己已' + CHARS);
    const b = await document.fonts.load(`${w} 40px ${LAT}`, 'mrn');
    if (!a.length || !b.length) throw new Error(`字体没加载上：${CJK} / ${LAT} @${w}`);
  }
  // 逐字确认字体里真有这些字（缺字会静默回退到系统字体，测出来的是别的字体）。
  // 不能用 fonts.check（不在任何 unicode-range 里的字它也返回 true）；同 text.js 的 missingGlyphs：
  // 挂载的 canvas 上用两种回退各画一次，像素不同 = 主字体没有这个字。canvas 必须带 lang，
  // 否则（本页就没有 <html lang>）各回退落到同一个系统字体，缺字全部漏报——实测过，见仓库 docs/verified/film-typography.md §5。
  {
    const mc = document.createElement('canvas'); mc.width = 96; mc.height = 96; mc.setAttribute('lang', 'zh');
    mc.style.cssText = 'position:fixed;left:-200px;top:0;visibility:hidden'; document.body.append(mc);
    const mx = mc.getContext('2d', { willReadFrequently: true });
    const draw = (fb, ch) => { mx.clearRect(0, 0, 96, 96); mx.font = `400 64px ${CJK}, ${fb}`; mx.fillText(ch, 8, 72); return mx.getImageData(0, 0, 96, 96).data; };
    const eq = (a, b) => { for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false; return true; };
    const miss = [...'量言未末己已' + CHARS].filter((ch) => { const a = draw('serif', ch); return !eq(a, draw('sans-serif', ch)) || !eq(a, draw('cursive', ch)); });
    mc.remove();
    if (miss.length) throw new Error(`字体 ${CJK} 缺字形：${miss.join('')}（会回退到系统字体，测出来的不是这个字体）`);
  }
  const k = FW / VIEW;                                   // 缩小倍数
  const big = document.createElement('canvas');
  const small = document.createElement('canvas');
  // 在成片分辨率画（白字黑底），缩到 1/k，返回小图 alpha（=墨量）。dx/dy = 亚像素相位偏移（成片 px）
  const render = (font, text, sizeFrame, dx = 0, dy = 0, kk = k) => {
    const W = Math.ceil(sizeFrame * (text.length + 1)), H = Math.ceil(sizeFrame * 1.6);
    big.width = W; big.height = H;
    const b = big.getContext('2d');
    b.fillStyle = '#000'; b.fillRect(0, 0, W, H);
    b.fillStyle = '#fff'; b.font = `${font.replace('SIZE', sizeFrame)}`; b.textBaseline = 'alphabetic';
    b.fillText(text, sizeFrame * 0.5 + dx, sizeFrame * 1.2 + dy);
    if (kk === 1) {                                       // 不缩放：直接读大图（几何测量用）
      const d = b.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = d[i * 4] / 255;
      return { g, w: W, h: H };
    }
    const w = Math.max(1, Math.round(W / kk)), h = Math.max(1, Math.round(H / kk));
    small.width = w; small.height = h;
    const s = small.getContext('2d', { willReadFrequently: true });
    s.imageSmoothingEnabled = true; s.imageSmoothingQuality = 'high';
    s.drawImage(big, 0, 0, w, h);
    const d = s.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4] / 255;   // 白字 → R 通道即覆盖率（sRGB 编码值）
    return { g, w, h };
  };
  const bbox = ({ g, w, h }) => {
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] > 0.1) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1 };
  };
  // 剖面段数：axis 'rows' = 沿竖线取（数横画），在 bbox 宽 15%–85% 的每一列上都数，取最大
  //（存在一列能把横画全部分开 = 分得开；避开竖画穿过的列）；'cols' = 沿横线取（数竖干）
  const count = (prof) => {
    let n = 0, on = false;
    for (const v of prof) { if (v >= 0.5) { if (!on) { n++; on = true; } } else on = false; }
    const peaks = [];
    for (let i = 1; i < prof.length - 1; i++) if (prof[i] >= prof[i - 1] && prof[i] > prof[i + 1] && prof[i] > 0.05) peaks.push(prof[i]);
    return { n, peaks };
  };
  const runs = (img, axis) => {
    const { g, w } = img; const bb = bbox(img);
    if (bb.x1 < 0) return { n: 0, peaks: [] };
    if (axis === 'rows') {
      let best = { n: 0, peaks: [] };
      for (let xc = Math.round(bb.x0 + (bb.x1 - bb.x0) * 0.15); xc <= bb.x0 + (bb.x1 - bb.x0) * 0.85; xc++) {
        const prof = []; for (let y = bb.y0; y <= bb.y1; y++) prof.push(g[y * w + xc]);
        const r = count(prof); if (r.n > best.n) best = r;
      }
      return best;
    }
    const yc = Math.round(bb.y0 + (bb.y1 - bb.y0) * 0.55);
    const prof = []; for (let x = bb.x0; x <= bb.x1; x++) prof.push(g[yc * w + x]);
    return count(prof);
  };
  const diff = (a, b) => {                                // 形近字逐像素平均绝对差
    const n = Math.min(a.g.length, b.g.length); let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a.g[i] - b.g[i]);
    return +(s / n).toFixed(4);
  };
  // 笔画几何：1000px 不缩放画，在 15%–85% 的列里找"段数 = 参考且最小间隙最大"的那一列，
  // 报该列的最小间隙、平均笔画厚度（单位 em）。检测器取各列最大段数，所以可分性由最好那一列决定。
  // axis 'cols'（拉丁 mmm）：只取与 runs() 相同的那一行（bbox 高 55%），量竖干间的内白（counter）。
  const geometry = (font, ch, ref, axis = 'rows') => {
    const S = 1000, img = render(font, ch, S, 0, 0, 1), { g, w } = img, bb = bbox(img);
    let best = null;
    const lanes = axis === 'rows'
      ? Array.from({ length: Math.floor((bb.x1 - bb.x0) * 0.7) + 1 }, (_, i) => Math.round(bb.x0 + (bb.x1 - bb.x0) * 0.15) + i)
      : [Math.round(bb.y0 + (bb.y1 - bb.y0) * 0.55)];
    for (const lane of lanes) {
      const on = [], off = []; let cur = null, len = 0;
      const [a0, a1] = axis === 'rows' ? [bb.y0, bb.y1] : [bb.x0, bb.x1];
      for (let q = a0; q <= a1; q++) {
        const v = (axis === 'rows' ? g[q * w + lane] : g[lane * w + q]) >= 0.5;
        if (v === cur) len++; else { if (cur === true) on.push(len); else if (cur === false && on.length) off.push(len); cur = v; len = 1; }
      }
      if (cur === true) on.push(len);
      if (on.length !== ref) continue;
      const gap = Math.min(...off), stroke = on.reduce((a, b) => a + b, 0) / on.length;
      if (!best || gap > best.gap) best = { gap, stroke };
    }
    return best && { gapEm: +(best.gap / S).toFixed(4), strokeEm: +(best.stroke / S).toFixed(4) };
  };
  const out = {};
  const sizes = []; for (let s = MIN; s <= MAX + 1e-9; s += STEP) sizes.push(+s.toFixed(3));
  const phaseOffs = []; for (let j = 0; j < PHASES; j++) phaseOffs.push((j / PHASES) * k); // 跨一个有效像素
  const floorOf = (rows, key, ref) => { let f = null; for (let i = rows.length - 1; i >= 0; i--) { if (rows[i][key] === ref) f = rows[i].s; else break; } return f; };
  for (const wt of WEIGHTS) {
    const fc = `${wt} SIZEpx ${CJK}`, fl = `${wt} SIZEpx ${LAT}`;
    const refC = runs(render(fc, '量', 300), 'rows').n;
    const refT = runs(render(fc, '言', 300), 'rows').n;
    const refL = runs(render(fl, 'mmm', 300), 'cols').n;
    const rows = sizes.map((s) => {
      const c = runs(render(fc, '量', s), 'rows');
      const tc = runs(render(fc, '言', s), 'rows');
      const l = runs(render(fl, 'mmm', s), 'cols');
      const row = { s, cjkRuns: c.n, typRuns: tc.n, typPeaks: tc.peaks, cjkPeaks: c.peaks, latRuns: l.n, latPeaks: l.peaks,
        diffWeiMo: diff(render(fc, '未', s), render(fc, '末', s)),
        diffJiYi: diff(render(fc, '己', s), render(fc, '已', s)),
        diffRnM: diff(render(fl, 'rn', s), render(fl, 'm', s)) };
      if (PHASES) row.typPhaseOk = phaseOffs.filter((o) => runs(render(fc, '言', s, o, o), 'rows').n === refT).length;
      return row;
    });
    const o = { refC, refT, refL, rows, cjkFloor: floorOf(rows, 'cjkRuns', refC), typFloor: floorOf(rows, 'typRuns', refT), latFloor: floorOf(rows, 'latRuns', refL) };
    if (PHASES) {                                       // 全部相位都分得开 / 过半相位分得开 的下限
      let all = null, half = null;
      for (let i = rows.length - 1; i >= 0 && rows[i].typPhaseOk === PHASES; i--) all = rows[i].s;
      for (let i = rows.length - 1; i >= 0 && rows[i].typPhaseOk * 2 > PHASES; i--) half = rows[i].s;
      o.typFloorAllPhases = all; o.typFloorHalfPhases = half;
    }
    o.geomTyp = geometry(fc, '言', refT);
    o.geomLat = geometry(fl, 'mmm', refL, 'cols');
    if (CHARS) {
      o.chars = {};
      for (const ch of CHARS) {
        const ref = runs(render(fc, ch, 300), 'rows').n;
        const cr = sizes.map((s) => ({ s, n: runs(render(fc, ch, s), 'rows').n }));
        o.chars[ch] = { ref, floor: floorOf(cr, 'n', ref) };
      }
    }
    if (AT.length) {
      o.at = AT.map((s) => {
        const offs = PHASES ? phaseOffs : [0];
        const typOk = offs.filter((q) => runs(render(fc, '言', s, q, q), 'rows').n === refT).length;
        const r = { s, typRuns: runs(render(fc, '言', s), 'rows').n, typPhaseOk: typOk, phases: offs.length };
        if (CHARS) {
          r.charOk = {};
          for (const ch of CHARS) r.charOk[ch] = runs(render(fc, ch, s), 'rows').n === o.chars[ch].ref;
        }
        return r;
      });
    }
    out[wt] = o;
  }
  return { k, out };
}, { CJK, LAT, FW, VIEW, WEIGHTS, MIN, MAX, STEP, PHASES, CHARS, AT })
  .catch(async (e) => { await browser.close(); server.close(); die(String(e.message).split('\n')[0].replace(/^page\.evaluate: (Error: )?/, '')); });
await browser.close(); server.close();

// WCAG 相对亮度与对比度（灰阶）
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// 覆盖率 c 是在 sRGB 编码空间混合的（canvas 缩放就是这么做的），所以先在编码空间混再算亮度
const effRatio = (fg, bg, c) => ratio(lin(bg + c * (fg - bg)), lin(bg));
const needFg = (bg, c, target) => { for (let fg = bg; fg <= 1.0001; fg += 0.001) if (effRatio(fg, bg, c) >= target) return fg; return null; };

const lines = [];
const P = (s) => { lines.push(s); console.log(s); };
const eff = (s) => (s == null ? '—' : (s / res.k).toFixed(1));
const PRINT_MAX = MAX === 72 && MIN === 12 && STEP === 2 ? 60 : MAX;   // 默认参数下保持旧版输出
P(`成片宽 ${FW}px 缩到有效宽 ${VIEW}px（×1/${+res.k.toFixed(4)}），中文测「量」横画段数，拉丁测 mmm 竖干数；字号 ${MIN}–${MAX} 步长 ${STEP}`);
for (const wt of WEIGHTS) {
  const o = res.out[wt];
  P(`\n字重 ${wt}：参考段数 量=${o.refC} 言=${o.refT} mmm=${o.refL}`);
  P(` 成片px 有效px | 量  言  mmm | 未/末 己/已 rn/m 差异${PHASES ? ` | 言 相位通过/${PHASES}` : ''}`);
  for (const r of o.rows) if (r.s <= PRINT_MAX) P(`  ${String(r.s).padStart(3)}  ${(r.s / res.k).toFixed(1).padStart(5)}  | ${String(r.cjkRuns).padStart(2)}  ${String(r.typRuns).padStart(2)}  ${String(r.latRuns).padStart(2)}  | ${r.diffWeiMo} ${r.diffJiYi} ${r.diffRnM}${PHASES ? ` | ${r.typPhaseOk}` : ''}`);
  const fc = o.rows.find((r) => r.s === o.cjkFloor), fl = o.rows.find((r) => r.s === o.latFloor);
  P(`  → 中文 密字「量」${o.cjkFloor}px 成片（${eff(o.cjkFloor)} 有效px）；常规字「言」${o.typFloor}px（${eff(o.typFloor)} 有效px）；拉丁 ${o.latFloor}px 成片（${eff(o.latFloor)} 有效px）`);
  if (PHASES) P(`  → 「言」相位稳健性：全部 ${PHASES} 个相位都分得开 ${o.typFloorAllPhases}px（${eff(o.typFloorAllPhases)} 有效px）；过半相位 ${o.typFloorHalfPhases}px（${eff(o.typFloorHalfPhases)} 有效px）`);
  // null 的下限必须说清是哪一种 null。「扫描到顶还没达到参考段数」和「达到过但不稳定」
  // 是两件完全不同的事，前者是范围没给够、后者才是这一档没有稳定下限。
  // 混成一个 `—` 已经咬过两次（check.mjs 的 cjk_bold=null 被当成"没下限"而放松了判定）。
  {
    const top = o.rows[o.rows.length - 1], lacking = [];
    for (const [name, key, ref] of [['量', 'cjkRuns', o.refC], ['言', 'typRuns', o.refT], ['mmm', 'latRuns', o.refL]]) {
      const floor = { 量: o.cjkFloor, 言: o.typFloor, mmm: o.latFloor }[name];
      if (floor != null) continue;
      lacking.push(top[key] < ref
        ? `${name}：扫到顶 ${MAX}px（${eff(MAX)} 有效px）仍只有 ${top[key]}/${ref} 段 —— **扫描范围不够高，不是没有下限**，加大 --max`
        : `${name}：范围内达到过 ${ref} 段但不连续 —— 这一档确实没有稳定下限`);
    }
    for (const l of lacking) P(`  ⚠ ${l}`);
  }
  if (o.geomTyp) P(`  → 「言」几何（1000px 不缩放，最可分的一列）：最小笔画间隙 ${o.geomTyp.gapEm} em，平均横画厚 ${o.geomTyp.strokeEm} em${o.typFloor ? `；下限处最小间隙 = ${(o.geomTyp.gapEm * o.typFloor / res.k).toFixed(2)} 有效px` : ''}`);
  if (o.geomLat) P(`  → 「mmm」几何（同上，竖干间内白）：最小间隙 ${o.geomLat.gapEm} em，平均竖干厚 ${o.geomLat.strokeEm} em${o.latFloor ? `；下限处最小间隙 = ${(o.geomLat.gapEm * o.latFloor / res.k).toFixed(2)} 有效px` : ''}`);
  const ft = o.rows.find((r) => r.s === o.typFloor);
  for (const [name, row] of [['中文密字', fc], ['中文常规', ft], ['拉丁', fl]]) {
    if (!row) continue;
    const pk = row[name === '中文密字' ? 'cjkPeaks' : name === '中文常规' ? 'typPeaks' : 'latPeaks'];
    const c = median(pk);
    const bg = 0.07; // #121212 附近的深底
    const fg45 = needFg(bg, c, 4.5), fg7 = needFg(bg, c, 7);
    P(`  ${name}下限字号处笔画峰值覆盖率中位数 ${c.toFixed(2)}；深底(灰 ${bg})上要让有效对比度≥4.5，标称前景需≥${fg45?.toFixed(3) ?? '达不到'}（标称对比度 ${fg45 ? ratio(lin(fg45), lin(bg)).toFixed(1) : '—'}:1）；≥7 需 ${fg7 ? ratio(lin(fg7), lin(bg)).toFixed(1) + ':1' : '达不到'}`);
  }
  if (o.chars) {
    const ent = Object.entries(o.chars);
    P(`  逐字下限（各字 300px 时段数为参考，成片px/有效px；— = 到 ${MAX}px 仍不稳定）：`);
    P('   ' + ent.map(([ch, v]) => `${ch}${v.ref}:${v.floor ?? '—'}/${eff(v.floor)}`).join('  '));
  }
  if (o.at) for (const a of o.at) {
    const cs = a.charOk ? Object.entries(a.charOk) : [];
    const bad = cs.filter(([, ok]) => !ok).map(([ch]) => ch).join('');
    P(`  @${a.s}px 成片（${eff(a.s)} 有效px）：言 ${a.typRuns}/${o.refT} 段${PHASES ? `，相位通过 ${a.typPhaseOk}/${a.phases}` : ''}` +
      (cs.length ? `；逐字 ${cs.length - bad.length}/${cs.length} 分得开${bad ? `，分不开：${bad}` : ''}` : ''));
  }
}
const outDir = join(dir, 'out'); mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${OUT}.txt`), lines.join('\n') + '\n');
writeFileSync(join(outDir, `${OUT}.json`), JSON.stringify(res, null, 1));
console.log(`\n-> ${join(outDir, `${OUT}.txt`)}`);
