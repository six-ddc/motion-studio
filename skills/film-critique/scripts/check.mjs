// 客观检查：只做机器能判的事，不做审美。
//
// 用法:
//   node <film-critique>/scripts/check.mjs --film <slug> [--mp4 films/<slug>/out/x.mp4]
//        [--sample-fps 10] [--claim-fps <film fps>] [--strict]
//        [--workers N（默认 核数/2，≤16；1 = 串行排查）] [--pages-per-browser 2]
//
// 三类结论（详见 references/checks.md）：
//   FAIL  客观不变量被破坏，或本片 style_guide 声明的法律被破坏 → exit 1
//   LOOK  疑点：测得到、但是不是问题要看本片意图（死拍、空画面配旁白……）→ exit 0
//         --strict 时 LOOK 也算失败
//   HUMAN 本片法律里机器判不了的条目，原样列出，留给人眼
//   HOLD  落在 MARKS hold 区间里的 LOOK：作者声明故意保留并写了理由 → exit 0，理由进 review_log
// 产出：films/<slug>/out/critique/checks.json + 每条带时间戳发现的证据帧 PNG
// 查哪些子判据由本片 film.json checks（扁平 id 数组）声明，见下文"本片声明了哪些检查"；没声明的一项都不查。
// 跨能力（narration.js、tiltscan、check_shotlist.py）经 film-core 的 capability() 取：声明了要它的检查而它没装 →「缺能力 film-X」exit 1。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capability, hasCapability } from '../../film-core/lib/env.mjs';
import { importRuntime } from '../../film-core/lib/runtime-node.mjs';
import { args, resolveFilm, readLaws, die, FILM_OPTS } from './_film.mjs';
// 世界文字可读性（three 里的字，film-webfx stage3d.js S.legible）：只有 checks 里 legible 写了阈值才调用，见第 10 节。
import { runLegible } from './_legible.mjs';
// 并行：逐帧的活（主采样、像素法律/断言、锚点、事件截图、压扁扫描）切成连续分片分给多个页面（_pool.mjs），
// 原生分辨率的像素统计在 Node 端 worker 线程里算（_pixels.mjs），不再把整帧 PNG 转 base64 送进分析页。
import { openPool, defaultWorkers } from './_pool.mjs';
import { pixelThreads } from './_pixels.mjs';
import { writeMeta } from './_fresh.mjs';
// 空间锚点（film-core references/runtime.md §6）的三个消费者放在独立模块里；只有本片声明了 occlude / inframe 法律
// 或 shotlist 有 source: "anchor" 曲线时才会被调用，没声明的片子这里的行为不变。
import { isAnchorLaw, runAnchorLaw, anchorClaims } from './_anchors.mjs';
// 衔接度 / 节奏（只报 LOOK，判据借自 onetake）：只有 checks 声明了 continuity / rhythm 才调用，见第 9 节。
import { runContinuity, runRhythm } from './_flow.mjs';
// 运动读数（motion / variety / beatsync / hook / mute，只报 LOOK）：声明了其中任何一项，主采样才多算每帧的粗特征，见第 9b 节。
import { KIN_IDS, RGB_W, kineticsAccumulator, runKinetics } from './_kinetics.mjs';

// 局部运行（--only / --law / --claim / --from --to）写进过文档但没有实现：明确拒绝，不静默整片跑。
const wantsHelp = process.argv.includes('--help') || process.argv.includes('-h');
for (const a of ['--only', '--law', '--claim', '--from', '--to']) {
  if (!wantsHelp && process.argv.includes(a)) die(`${a} 未实现：check.mjs 没有局部运行，只能整片跑（见 film-critique SKILL.md「没有局部运行」）`);
}
const { flag, num, has } = args({
  usage: 'node check.mjs --film <slug> [--mp4 films/<slug>/out/x.mp4] [--sample-fps 10] [--claim-fps N] [--strict] [--workers N] [--pages-per-browser 2]',
  about: '客观检查：只做机器能判的事。FAIL → exit 1；LOOK 疑点 exit 0（--strict 时也算失败）；HUMAN 留给人眼。\n'
    + '产出 films/<slug>/out/critique/checks.json + 证据帧。查哪些子判据由 film.json checks 声明（references/checks.md）。',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'],
    mp4: ['<file>', '对成片 mp4 做 narration/mp4/truepeak 类检查'], 'sample-fps': ['<N>', '主采样帧率（默认 10）'],
    'claim-fps': ['<N>', '断言/锚点逐帧帧率（默认 film fps）'], strict: 'LOOK 也算失败',
    workers: ['<N>', '并行页面数（默认 核数/2，≤16；1 = 串行排查）'], 'pages-per-browser': ['<P>', '每浏览器页面数（默认 2）'],
  },
});
const F = resolveFilm(flag('film'));
const sfps = num('sample-fps', 10);
const mp4 = flag('mp4', null);
const laws = readLaws(F);
// ---------- 本片声明了哪些检查：film.json checks（扁平 id 数组，film-core references/api.md §5） ----------
// 页面契约（film-core references/kernel.md）之外，这里的每一项都是质量护栏，不是契约，所以都由片子自己声明，没有默认开的项：
//   film.json  "checks": ["readability", { "contrast": { "min": 4.5, "large": 3 } }, "laws", …]
// 本脚本认领哪些 id 只写在 gates.json 一处（accept --deep / deliver 按它决定跑不跑本脚本）。
const CLAIMED = JSON.parse(readFileSync(new URL('../gates.json', import.meta.url), 'utf8')).gates.flatMap((g) => g.when?.checks ?? []);
const declared = F.checks;
const on = (k) => declared.has(k);
const param = (k) => { const v = declared.get(k); return v && typeof v === 'object' ? v : {}; };
// 对比度阈值：只写 "contrast" = WCAG 正文 4.5:1、大字 3:1（大字 = ≥18.66 有效 px）；写对象可改阈值
const CT = param('contrast');
const C_MIN = CT.min ?? 4.5, C_LARGE = CT.large ?? 3, C_LARGE_PX = CT.large_px ?? 18.66;
const C_DEFAULT = C_MIN === 4.5 && C_LARGE === 3 && C_LARGE_PX === 18.66;
const outDir = join(F.out, 'critique');
mkdirSync(outDir, { recursive: true });
// onscreen.txt 只在"有数字可对账"时才写；不先删，上一次运行留下的旧文件会被 factcheck --also 当成这一次的画面文字
for (const f of readdirSync(outDir)) if (f.startsWith('evidence-') || f === 'onscreen.txt') execFileSync('rm', [join(outDir, f)]);

const findings = [];
const add = (level, layer, id, msg, extra = {}) => findings.push({ level, layer, id, msg, ...extra });
const fmt = (t) => `${t.toFixed(2)}s`;
{ const off = CLAIMED.filter((k) => !on(k));
  if (off.length) add('SKIP', '客观', 'checks', `本片 film.json checks 没声明这些子判据，不查：${off.join(' ')}（要用就加进 checks，见 film-critique references/checks.md）`); }

// ---------- 探针：拦截 canvas 文字绘制，记录字号/颜色/底色 ----------
const PROBE = () => {
  const rec = []; window.__crit = rec; window.__critOn = false;
  const probe = document.createElement('canvas').getContext('2d');
  const norm = (s) => { try { probe.fillStyle = '#000'; probe.fillStyle = s; return probe.fillStyle; } catch { return null; } };
  const P = CanvasRenderingContext2D.prototype;
  const cids = new WeakMap(); let nextCid = 0;
  for (const fn of ['fillText', 'strokeText']) {
    const orig = P[fn];
    P[fn] = function (text, x, y, ...rest) {
      if (window.__critOn) try {
        const m = /(\d+(?:\.\d+)?)px/.exec(this.font); const px = m ? +m[1] : 10;
        const tr = this.getTransform(); const sc = Math.sqrt(Math.abs(tr.a * tr.d - tr.b * tr.c));
        const mt = this.measureText(String(text));
        const asc = mt.actualBoundingBoxAscent || px * 0.8, desc = mt.actualBoundingBoxDescent || px * 0.2;
        const l = x - (mt.actualBoundingBoxLeft || 0), r = x + (mt.actualBoundingBoxRight || mt.width);
        const cs = [[l, y - asc], [r, y - asc], [l, y + desc], [r, y + desc]]
          .map(([u, v]) => [tr.a * u + tr.c * v + tr.e, tr.b * u + tr.d * v + tr.f]);
        const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
        const bx = Math.max(0, Math.floor(Math.min(...xs))), by = Math.max(0, Math.floor(Math.min(...ys)));
        const bw = Math.min(this.canvas.width, Math.ceil(Math.max(...xs))) - bx;
        const bh = Math.min(this.canvas.height, Math.ceil(Math.max(...ys))) - by;
        let bg = null;
        if (bw > 0 && bh > 0) {
          const d = this.getImageData(bx, by, bw, bh).data; let R = 0, G = 0, B = 0, n = 0;
          for (let i = 0; i < d.length; i += 16) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
          bg = [R / n, G / n, B / n];
        }
        const style = fn === 'fillText' ? this.fillStyle : this.strokeStyle;
        const cssScale = this.canvas.getBoundingClientRect().width / this.canvas.width || 1;
        const wm = /\b(bold|[1-9]00)\b/.exec(this.font);
        // box：未裁剪的文字框，归一化到视口（= 画面）。给遮挡门用（_anchors.mjs）：和锚点出自同一次绘制。
        // 只对挂在文档里的 canvas 算——离屏 canvas 上的字还没落到画面上，位置无从说起。
        let box = null;
        if (this.canvas.isConnected) { const cr = this.canvas.getBoundingClientRect(), kx = cr.width / this.canvas.width, ky = cr.height / this.canvas.height;
          box = [(cr.left + Math.min(...xs) * kx) / innerWidth, (cr.top + Math.min(...ys) * ky) / innerHeight, (cr.left + Math.max(...xs) * kx) / innerWidth, (cr.top + Math.max(...ys) * ky) / innerHeight]; }
        // line：这一笔在画布像素里的基线段（advance 起点 → 终点，已套当前变换）+ em（画布像素）+ 字体串 + 所在画布。
        // 只给 onscreen.txt / 事实对账拼段用（同一帧、同一画布、同基线、首尾相接的几笔 = 一段话，见下文 joinRuns）。
        // 用 advance 不用墨水框：等宽字逐字画时墨水框之间有缝，按墨水量会在每个字之间插空格。
        if (!cids.has(this.canvas)) cids.set(this.canvas, nextCid++);
        const al = this.textAlign, a0 = al === 'center' ? x - mt.width / 2 : al === 'right' || al === 'end' ? x - mt.width : x, a1 = a0 + mt.width;
        const P0 = [tr.a * a0 + tr.c * y + tr.e, tr.b * a0 + tr.d * y + tr.f], P1 = [tr.a * a1 + tr.c * y + tr.e, tr.b * a1 + tr.d * y + tr.f];
        const line = { cid: cids.get(this.canvas), x0: P0[0], y0: P0[1], x1: P1[0], y1: P1[1], em: px * Math.hypot(tr.a, tr.b), base: this.textBaseline, font: this.font };
        rec.push({ text: String(text), px: px * sc * cssScale, weight: wm ? (wm[1] === 'bold' ? 700 : +wm[1]) : 400, color: typeof style === 'string' ? norm(style) : null,
          alpha: this.globalAlpha, bg, onscreen: bw > 0 && bh > 0, box, line });
      } catch { /* 探针失败不影响场景 */ }
      return orig.call(this, text, x, y, ...rest);
    };
  }
};

// ---------- 跨能力：声明了要它的检查才取；没装 →「缺能力 film-X」exit 1（在起浏览器之前） ----------
let makeNarration = null, tilt = null, SL_PY = null;
try {
  // 关键词查找用 film-narration 运行时的同一个函数（字符流 + 词边界），不自己实现：两个 skill 对同一份 narration.json 给出相反结论是最糟的情况。
  // 片内有冻结副本时用片内那份（和场景在浏览器里加载的是同一份）
  if (on('narration') || on('marks')) { capability('film-narration'); ({ makeNarration } = await importRuntime('narration.js', { film: F.dir })); }
  // 压扁疑点（斜看的平面画成了正交投影）：探针和判据在 film-motion，这里只接线
  if (on('tilt')) tilt = await capability('film-motion').import('scripts/lib/tiltscan.mjs');
  // 分镜断言的语义只在 film-story 的 check_shotlist.py 写一遍：这里取区间、逐帧采值，交回它判定
  if (on('claims')) SL_PY = capability('film-story').path('scripts/check_shotlist.py');
} catch (e) { die(e.message, 1); }

// ---------- 并行池：--workers N（默认 核数/2，≤16）、--pages-per-browser P（默认 2），拓扑同 film-core render.mjs ----------
const nWorkers = num('workers', defaultWorkers()), perBrowser = num('pages-per-browser', 2);
if (!(Number.isInteger(nWorkers) && nWorkers >= 1)) die(`--workers 必须是 ≥1 的整数，收到 ${nWorkers}`);
if (!(Number.isInteger(perBrowser) && perBrowser >= 1)) die(`--pages-per-browser 必须是 ≥1 的整数，收到 ${perBrowser}`);
const tRun0 = Date.now(), phases = {};
const phase = async (name, fn) => { const t0 = Date.now(); try { return await fn(); } finally { phases[name] = (phases[name] ?? 0) + Date.now() - t0; } };
// 分析页：把截图缩到 180px 宽在浏览器里算缩略统计（缩放要和原来逐位一致，只能交给同一个 drawImage）。
// 有状态的部分（静止判定的锚点帧、dPrev 的上一帧）不放在这里：分析页交回缩略亮度图（Float32 原样字节），Node 端按时间顺序比。
const ANALYSIS = () => {
  window.A = {
    W: 180,
    async load(b64) {
      const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      this.H = Math.round((bm.height * this.W) / bm.width); this.bm = bm;
      const c = new OffscreenCanvas(this.W, this.H).getContext('2d');
      c.drawImage(bm, 0, 0, this.W, this.H);
      return c.getImageData(0, 0, this.W, this.H).data;
    },
    lum(d) { const L = new Float32Array(d.length / 4); for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return L; },
    diff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) n++; return n; },
    edge(L) { const W = this.W, H = this.H; let n = 0;
      for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const i = y * W + x;
        if (Math.max(Math.abs(L[i] - L[i + 1]), Math.abs(L[i] - L[i + W])) > 20) n++; }
      return n / (W * H); },
    offPalette(d, pal, tol) {
      const segs = []; for (let i = 0; i < pal.length; i++) for (let j = i; j < pal.length; j++) segs.push([pal[i], pal[j]]);
      let off = 0, n = 0;
      for (let k = 0; k < d.length; k += 4) { n++; let best = 1e9;
        for (const [a, b] of segs) { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [d[k] - a[0], d[k + 1] - a[1], d[k + 2] - a[2]];
          const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2; const u = L2 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2)) : 0;
          const e = (ap[0] - u * ab[0]) ** 2 + (ap[1] - u * ab[1]) ** 2 + (ap[2] - u * ab[2]) ** 2; if (e < best) best = e; }
        if (best > tol * tol) off++; }
      return off / n; },
    // 一帧的无状态部分：边缘密度、色板外占比（pal 给了才算）、缩略亮度图（Float32 字节 → base64）、
    // rgbW > 0 时另给一张 rgbW 宽的 RGB 缩略图（运动读数的前景分割用，_kinetics.mjs；不影响上面几项）
    async thumb(b64, pal, tol, rgbW) {
      const d = await this.load(b64), L = this.lum(d);
      const r = { edge: this.edge(L) };
      if (pal) r.off = this.offPalette(d, pal, tol);
      if (rgbW) { const h = Math.max(1, Math.round((this.bm.height * rgbW) / this.bm.width)), c = new OffscreenCanvas(rgbW, h).getContext('2d');
        c.drawImage(this.bm, 0, 0, rgbW, h); const q = c.getImageData(0, 0, rgbW, h).data, u = new Uint8Array(rgbW * h * 3);
        for (let i = 0, j = 0; i < q.length; i += 4, j += 3) { u[j] = q[i]; u[j + 1] = q[i + 1]; u[j + 2] = q[i + 2]; }
        let t = ''; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000)); r.rgb = btoa(t); }
      const u8 = new Uint8Array(L.buffer); let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      r.L = btoa(s);
      return r;
    },
    async compare(a, b) { return this.diff(this.lum(await this.load(a)), this.lum(await this.load(b))); },
  };
};
const pool = await phase('open', () => openPool(F, { workers: nWorkers, perBrowser, initScript: PROBE, analysis: ANALYSIS }));
const S = pool.S, ap = pool.ap;
const D = S.duration;
if (!Number.isFinite(D) || D <= 0) { await pool.close(); die('场景没有暴露 window.DURATION（秒）', 1); }
// 原生分辨率像素统计的线程数：浏览器进程本身也吃 CPU，取 worker 数的一半就够（解一帧 PNG + 数像素约 15–25ms）
const pix = pixelThreads(Math.max(1, Math.min(8, Math.ceil(nWorkers / 2))));
const marks = (await S.page.evaluate(() => window.MARKS ?? null)) || [];
const voOffset = F.config.narrationOffset ?? (await S.page.evaluate(() => window.VO_OFFSET ?? 0));

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const pal = Array.isArray(laws.palette) ? laws.palette.map(hex) : null;
const palTol = laws.palette_tol ?? 40;

// ---------- 逐帧采样 ----------
const lastT = (Math.round(D * F.fps) - 1) / F.fps;
const N = Math.floor(D * sfps - 1e-9) + 1;
const ts = Array.from({ length: N }, (_, i) => +(i / sfps).toFixed(4));
const samples = [];
const evidence = new Map();
// 运动读数：声明了才在 consume 里按时间顺序算（帧差能量、前景、运动区域），没声明的片子这里什么都不多做
const KIN = KIN_IDS.some(on), kinRGB = on('motion') || on('variety') || on('hook');
const kinAcc = KIN ? kineticsAccumulator() : null;
let firstPng, lastPng;
process.stdout.write(`采样 ${N} 帧 @ ${sfps}fps（${F.width}×${F.height}，时长 ${D}s；${pool.info.workers} 个页面 / ${pool.info.browsers} 个浏览器）`);
// 每个分片在自己的页面里逐帧：开探针 → seek+截图 → 收文字 → 分析页算缩略统计。
// 静止判定（moved：与"上次变化时的帧"比）和 dPrev 是跨帧状态，分片按时间顺序拼回后在这里按顺序算：同一个 diff、同一份 Float32。
const COLLECT = () => {
  window.__critOn = false;
  const dom = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const s = n.textContent.trim(); if (!s || !n.parentElement) continue;
    const cs = getComputedStyle(n.parentElement), r = n.parentElement.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    dom.push({ text: s, px: parseFloat(cs.fontSize), weight: +cs.fontWeight || 400, color: null, alpha: +cs.opacity, bg: null, onscreen: true, dom: true });
  }
  return [...window.__crit, ...dom];
};
const lumDiff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) n++; return n; };
{
  let prevL = null, anchorL = null, done = 0;
  const ready = new Map(); let nextK = 0;
  const consume = (part) => { // 按时间顺序吃一个分片：算 dPrev / moved，丢掉缩略图
    for (const x of part) {
      const b = Buffer.from(x.L, 'base64'), L = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      const r = { edge: x.edge, dPrev: prevL ? lumDiff(L, prevL) : null };
      r.moved = !anchorL || lumDiff(L, anchorL) >= 4;
      if (r.moved) anchorL = L;
      prevL = L;
      if ('off' in x) r.off = x.off;
      if (kinAcc) r.k = kinAcc(L, x.rgb ? Buffer.from(x.rgb, 'base64') : null);
      samples.push({ t: x.t, ...r, texts: x.texts });
      evidence.set(x.t, x.png);
      x.L = null; x.png = null; x.texts = null; x.rgb = null;
    }
  };
  await phase('sample', () => pool.chunks(ts, async (w, part, i0) => {
    const out = [];
    for (const [j, t] of part.entries()) {
      const i = i0 + j;
      await w.S.page.evaluate(() => { window.__crit.length = 0; window.__critOn = true; });
      const png = await w.S.shot(t);
      const texts = await w.S.page.evaluate(COLLECT);
      const usePal = pal && (i % Math.max(1, Math.round(sfps)) === 0);
      const r = await w.ap.evaluate(([b, p, tol, rw]) => window.A.thumb(b, p, tol, rw), [png.toString('base64'), usePal ? pal : null, palTol, kinRGB ? RGB_W : 0]);
      out.push({ t, png, texts, ...r });
    }
    return out;
  }, { onChunk: (k, a, res) => {
    ready.set(k, res);
    while (ready.has(nextK)) { consume(ready.get(nextK)); ready.delete(nextK); nextK++; }
    const d0 = Math.floor(done / 10); done += res.length; for (let z = d0; z < Math.floor(done / 10); z++) process.stdout.write('.');
  } }));
  firstPng = evidence.get(ts[0]);
}
lastPng = await S.shot(lastT);
console.log(' 完成\n');

const nearest = (t) => ts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), ts[0]);
const saveEvidence = (id, t) => {
  const k = nearest(t), f = join(outDir, `evidence-${id}-${k.toFixed(2)}s.png`);
  writeFileSync(f, evidence.get(k)); return f;
};
const runs = (pred) => { // 连续满足 pred 的采样区间
  const out = []; let s = null;
  samples.forEach((x, i) => { if (pred(x, i)) { if (s === null) s = i; } else if (s !== null) { out.push([s, i - 1]); s = null; } });
  if (s !== null) out.push([s, samples.length - 1]);
  return out.map(([a, b]) => ({ from: samples[a].t, to: samples[b].t + 1 / sfps }));
};

// ---------- 1. 时长对账 ----------
const fdur = F.config.duration;
if (fdur != null && Math.abs(fdur - D) > 1 / F.fps) add('FAIL', '客观', 'duration.film', `film.json duration=${fdur}s 与场景 DURATION=${D}s 不符`);
const nar = F.readJSON('narration.json');
let vo = null;
if (nar && makeNarration) { try { vo = makeNarration(nar); } catch (e) { if (on('narration')) add('FAIL', '客观', 'narration.format', `narration.json 读不了：${e.message}`); } }
const lines = (nar?.lines ?? []).map((l) => ({ ...l, s: l.start + voOffset, e: l.end + voOffset }));
if (!on('narration')) { /* 没声明 narration：旁白时长、WAV 实测不对账 */ }
else if (!nar) {
  if (F.readJSON('script.json')) add('FAIL', '客观', 'duration.narration', '有 script.json 但没有 narration.json：旁白还没合成或时间轴丢了，画面时长无从对账');
  else add('SKIP', '客观', 'duration.narration', '无旁白（script.json / narration.json 都没有），跳过时长对账');
} else {
  const voEnd = Math.max(...lines.map((l) => l.e));
  const voStart = Math.min(...lines.map((l) => l.s));
  if (voEnd > D + 1e-3) add('FAIL', '客观', 'duration.narration', `旁白在 ${fmt(voEnd)} 才结束，画面 ${fmt(D)} 就完了：最后 ${(voEnd - D).toFixed(2)}s 旁白被截掉`, { t: D });
  else if (voStart < -1e-3) add('FAIL', '客观', 'duration.narration', `旁白从 ${fmt(voStart)} 开始（负数），offset 配错了`);
  else add('PASS', '客观', 'duration.narration', `旁白 ${fmt(voStart)}–${fmt(voEnd)} 落在画面 0–${fmt(D)} 内（片尾留白 ${(D - voEnd).toFixed(2)}s，offset ${voOffset}s）`);
  for (const l of nar.lines) {
    if (!l.wav) continue;
    const w = resolve(F.dir, l.wav);
    if (!existsSync(w)) { add('FAIL', '客观', 'duration.wav', `${l.id} 指向的 ${l.wav} 不存在`); continue; }
    const real = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', w]).toString();
    if (Math.abs(real - l.duration) > 0.05) add('FAIL', '客观', 'duration.wav', `${l.id} 时间轴写 ${l.duration}s，WAV 实测 ${real.toFixed(3)}s：narration.json 不是实测回写的`);
  }
}
if (mp4) {
  if (!existsSync(mp4)) die(`--mp4 ${mp4} 不存在`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
  const vd = +v.duration, want = Math.round(D * F.fps);
  const [rn, rd] = v.r_frame_rate.split('/').map(Number);
  if (on('mp4') && Math.abs(rn / rd - F.fps) > 0.01) add('FAIL', '客观', 'mp4.fps', `MP4 帧率 ${rn / rd}，film.json 写 ${F.fps}`);
  if (!on('mp4')) { /* 没声明 mp4 */ }
  else if (Math.abs(vd - D) > 1 / F.fps + 1e-3) add('FAIL', '客观', 'mp4.duration', `MP4 视频流 ${vd}s，场景 ${D}s，差 ${(vd - D).toFixed(3)}s`);
  else add('PASS', '客观', 'mp4.duration', `MP4 视频流 ${vd}s（${v.nb_frames ?? '?'} 帧，应为 ${want}）与场景一致`);
  if (a) {
    const ad = +a.duration;
    if (!on('mp4')) { /* 没声明 mp4 */ }
    else if (Math.abs(ad - vd) > 1 / F.fps + 0.05) add('FAIL', '客观', 'mp4.av', `音轨 ${ad.toFixed(3)}s vs 视频 ${vd.toFixed(3)}s，差 ${(ad - vd).toFixed(3)}s：合流时有一条被截断或补齐了`);
    else add('PASS', '客观', 'mp4.av', `音轨与视频流时长差 ${(ad - vd).toFixed(3)}s`);
    if (nar && on('narration')) add('TODO', '客观', 'mp4.asr', `音画漂移的终检要重新转写音轨：参见 film-narration 的 align.py --verify（本脚本不跑 ASR）`);
    // 成片 true peak：与 film-narration 的 mux.sh / align.py --verify 同阈值、同测法（交付文件解码后用 loudnorm 测，两位小数；
    // ebur128 只给一位，-1.01 会显示成 -1.0）。放在这里是因为纯配乐、没有旁白的成片进不了 --verify，真峰原来没有任何门查。
    // 有旁白的片子两边都会报，结论应一致——口径不同就是 bug。
    const TP_CEILING = -1.0, TP_TARGET = -1.5; // dBTP：常见发布规范天花板（YouTube / Spotify）/ 本套件 mux.sh 的 loudnorm 目标
    // ffmpeg 把 loudnorm 的 JSON 打在 stderr，所以用 spawnSync（execFileSync 成功时拿不到 stderr）
    const ln = on('truepeak') ? spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mp4, '-map', '0:a:0', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }) : null;
    const tpm = /"input_tp"\s*:\s*"([^"]+)"/.exec(ln?.stderr ?? '');
    const tp = tpm && Number.isFinite(+tpm[1]) ? +tpm[1] : null;
    if (!on('truepeak')) { /* 没声明 truepeak */ }
    else if (tp === null) add('FAIL', '客观', 'mp4.truepeak', `量不出成片音轨的 true peak（ffmpeg loudnorm 没给 input_tp），没法判是否超标`);
    else if (tp > TP_CEILING) add('FAIL', '客观', 'mp4.truepeak', `成片 true peak ${tp.toFixed(2)} dBTP > ${TP_CEILING.toFixed(1)}：超过常见发布规范的天花板（YouTube / Spotify），平台转码后会削顶。参见 film-narration 的 mux.sh（降 --lufs 或 --limit auto，加了要重跑 --verify）`);
    else if (tp > TP_TARGET) add('LOOK', '疑点', 'mp4.truepeak', `成片 true peak ${tp.toFixed(2)} dBTP：满足发布规范（≤ ${TP_CEILING.toFixed(1)}），但高于本套件 ${TP_TARGET.toFixed(1)} 的目标`);
    else add('PASS', '客观', 'mp4.truepeak', `成片 true peak ${tp.toFixed(2)} dBTP（≤ ${TP_TARGET.toFixed(1)}；loudnorm 测，与 mux.sh / align --verify 同口径）`);
  } else if (on('truepeak')) add('SKIP', '客观', 'mp4.truepeak', '成片没有音轨，不查 true peak');
} else {
  const want = ['mp4', 'truepeak'].filter(on);
  if (want.length) add('SKIP', '客观', 'mp4', `本片声明了 ${want.join(' / ')}，但这次没给 --mp4（accept/deliver 有 out/final-<画幅>.mp4 时自动带上）：成片没查`);
}

// ---------- 2. 循环接缝 ----------
const loopReq = laws.loop ?? F.config.loop;
const md5 = (b) => createHash('md5').update(b).digest('hex');
if (!on('loop')) { /* 没声明 loop（seamcheck 门 3 是内核门，照常查） */ }
else if (loopReq) {
  // 口径与 film-core seamcheck 一致（它实测过旧口径是错的）：
  //   3a frame(D) 与 frame(0) 一致 —— 循环片的 t=D 就是下一圈的 t=0
  //   3b 跨缝跳变 frame(lastT)→frame(0) 不超过相邻帧典型差异的 4 倍
  // 旧口径"末帧 frame(lastT) 与首帧逐字节相同"会把正确的循环片判错（末帧本该差一帧的运动量）。
  const cmp = (a, b, p = ap) => (a.equals(b) ? 0 : p.evaluate(([x, y]) => window.A.compare(x, y), [a.toString('base64'), b.toString('base64')]));
  const atD = await S.shot(D);
  const d3a = await cmp(atD, firstPng);
  // 8 对相邻帧互不相干：每对在一个页面里截两张、比一次（与串行同一个 compare）
  const adj = await phase('loop', () => pool.chunks([1, 2, 3, 4, 5, 6, 7, 8], async (w, part) => {
    const out = []; for (const k of part) { const t = (lastT * k) / 9; out.push(await cmp(await w.S.shot(t), await w.S.shot(t + 1 / F.fps), w.ap)); } return out;
  }, { size: 1 }));
  adj.sort((a, b) => a - b);
  const typical = (adj[3] + adj[4]) / 2, jump = await cmp(lastPng, firstPng), lim = 4 * Math.max(typical, 1);
  if (d3a >= 4) { writeFileSync(join(outDir, 'evidence-loop-D.png'), atD); add('FAIL', '客观', 'loop', `本片要求循环，但 frame(D=${fmt(D)}) 与 frame(0) 不同（180px 缩略下 ${d3a} 个像素差 >8/255）`, { t: D }); }
  else if (jump > lim) { writeFileSync(join(outDir, 'evidence-loop-last.png'), lastPng); add('FAIL', '客观', 'loop', `跨缝跳变 ${jump} 像素，超过相邻帧典型差异 ${typical} 的 4 倍：循环会跳`, { t: lastT }); }
  else add('PASS', '客观', 'loop', `frame(D)≈frame(0)（差 ${d3a}），跨缝跳变 ${jump} ≤ 4×典型相邻差 ${typical}`);
} else add('SKIP', '客观', 'loop', '本片未声明 loop，不查首末帧');
add('TODO', '客观', 'determinism', '确定性门（同 t 重复 / 全新页面重载 / 乱序 / 循环）：参见 film-core 的 seamcheck.mjs（内核门，accept/deliver 永远跑）。本脚本的所有测量都在同一页面内，抓不到加载期 Math.random 一类违约');

// ---------- 3. 可读性（360px 宽手机） ----------
// 阈值按文种（和字重）分档：中文常规字的下限约是拉丁的 2.2 倍，一个全局数字必然错量一边。
// 两种写法，单位不同（都可以是数字 = 所有文种同一阈值，向后兼容）：
//   min_text_px     手机有效 px（成片缩到 360 宽后的 px）
//   min_text_src_px 本片原生宽度下的 px（film-typography 的表就是这个单位）
// 对象键：latin / cjk / symbol / latin_bold / cjk_bold；值为 null = "该档没有稳定下限"→ LOOK。
// 没写的文种不查（例如 symbol：乱码、方块字符没有"读"的概念）。
// 观看宽度：默认 360（手机竖持）。横版片也按 360 判是故意的——信息流里横片就是以手机宽度内嵌播放的，
// 转横全屏是观众额外的动作，不能当默认。本片明确以横持全屏为主时，在 style_guide 写 view_width（如 720）。
const viewW = laws.view_width ?? 360;
const phone = viewW / F.width;
// film-typography 实测下限（有效 px，360 宽）。中文按字重查表：500 的下限是 24.0 而不是 400 档的 18.7，
// 只分"常规/粗"两档会放过 500 字幕；旧版 cjk_bold=null（→ 只报 LOOK）还让加粗反而更宽松。
const TYPO_1080 = { latin: 8.7, latin_bold: 10.0, cjk: 18.7, cjk_bold: 29.3,
  cjk_100: 26.7, cjk_200: 17.3, cjk_300: 17.3, cjk_400: 18.7, cjk_500: 24.0, cjk_600: 24.7, cjk_700: 29.3, cjk_800: 28.0, cjk_900: 30.7 };
// 这张表原来只按（文种，字重）查，等于默认"有效 px 的下限与画幅无关"。**实测不成立。**
// 同一字体、同一有效宽 360，只换画幅做对照（legibility.mjs --frame-width）：
//   言 400 档下限  1080→360（×3）18.7 有效px ｜ 1440→360（×4）21.5 ｜ 1920→360（×5.33）21.4
// 缩得越狠，相邻笔画在重采样里并得越多，下限就越高。1080 那一列是在 ×3 下测的，
// 拿去判 1920 的横版片会放过 18.7–21.5 这一整段（ghost-jam 的字幕 19.9 就落在里面，门却是绿的）。
// ×5.33 全字重实测（同字体，Noto Sans SC Variable）：
const TYPO_X533 = { cjk_100: 29.6, cjk_200: 22.1, cjk_300: 20.3, cjk_400: 21.4, cjk_500: 24.0,
  cjk_600: 28.1, cjk_700: 26.3, cjk_800: 29.6, cjk_900: 32.3 };
// 9 档里 7 档比 ×3 严（+1.6 到 +4.8），500 档相等，700 档反而松 3.0 ——
// 所以没有干净的乘法修正，只知道"不是画幅无关、且对多数字重偏松"。
// **只修中文，不修拉丁，这个不对称是故意的。** 拉丁用 mmm 竖干数，在 ×5.33 下实测
// 400→9.8、600→6.0、700→7.1：字重越粗下限越低，和 ×3 那一列（8.7 → 粗体 10.0）方向相反，
// 物理上说不通（加粗只会吃掉竖干间的内白）。这说明 mmm 这个统计量在这个缩放比下噪声太大，
// 不足以当判据。拿它去"对齐"只会把噪声写成法律——所以拉丁维持 ×3 的数，等有可靠测量再说。
// 判据取两次测量里**更严**的那个：我们不知道这个函数的确切形状，只知道单用一列不安全。
// 比 ×3 更接近 ×3 的画幅（ratio < 3.5，例如 1080 竖版）仍只用 1080 那一列，不凭空加严。
const typoTable = (ratio) => {
  if (ratio < 3.5) return TYPO_1080;
  const t = { ...TYPO_1080 };
  for (const [k, v] of Object.entries(TYPO_X533)) if (t[k] == null || v > t[k]) t[k] = v;
  if (t.cjk_400 > t.cjk) t.cjk = t.cjk_400;          // 不分字重时的兜底也跟着收紧
  return t;
};
const scaleTier = (v, k) => (typeof v === 'number' ? v * k : Object.fromEntries(Object.entries(v).map(([n, x]) => [n, x == null ? null : x * k])));
const TYPO = typoTable(F.width / viewW);
const tier = laws.min_text_src_px != null ? scaleTier(laws.min_text_src_px, phone)
  : laws.min_text_px != null ? laws.min_text_px : TYPO;
// 单位防呆：手机有效 px 超过 24 ≈ 原生 72px（1080 宽），几乎一定是把原生 px 写进了 min_text_px
{ const vals = typeof laws.min_text_px === "number" ? [laws.min_text_px] : Object.values(laws.min_text_px ?? {}).filter((v) => typeof v === "number");
  if (on('readability') && vals.some((v) => v > 24)) add("LOOK", "本片法律", "style_guide.units", `min_text_px 的单位是手机有效 px（360 宽）。你写的 ${Math.max(...vals)} 相当于原生 ${(Math.max(...vals) / phone).toFixed(0)}px —— 若这是原生宽度下的字号（film-typography 的表就是原生 px），改用 min_text_src_px`); }
const tierSrc = laws.min_text_src_px != null ? 'style_guide min_text_src_px' : laws.min_text_px != null ? 'style_guide min_text_px'
  : `film-typography 实测默认（${F.width}/${viewW} = ×${(F.width / viewW).toFixed(2)} 缩放${F.width / viewW < 3.5 ? '，用 ×3 那一列' : '，取 ×3 与 ×5.33 两列里更严的'}）`;
const charScript = (c) => (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(c) ? "cjk"
  : /[A-Za-z0-9\u00c0-\u024f]/.test(c) ? "latin" : /[\s\p{P}]/u.test(c) ? null : "symbol");
// 一段文字的文种 = 字符多数派（标点空白不计）。溶解中的字幕「各自算▛▒▞╱▞钥┿」算符号，不按中文阈值量
const scriptOf = (s) => {
  const n = { cjk: 0, latin: 0, symbol: 0 };
  for (const c of s) { const k = charScript(c); if (k) n[k]++; }
  const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return top[1] ? top[0] : "symbol";
};
const SCRIPT_NAME = { cjk: '中文', latin: '拉丁', symbol: '符号' };
// 查找顺序：<文种>_<字重>（如 cjk_500）→ 字重 ≥600 时 <文种>_bold → <文种>。
const limitOf = (script, weight) => {
  if (typeof tier === 'number') return { v: tier, key: 'all' };
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  for (const key of [`${script}_${w}`, ...(weight >= 600 ? [`${script}_bold`] : []), script]) if (key in tier) return { v: tier[key], key };
  return null;
};
const lumOf = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const parseColor = (s) => { if (!s) return null; if (s[0] === '#') return [...hex(s), 1]; const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
const textSeen = new Map(); // text -> {px, ratio, times[], full[], script, bold}
for (const s of samples) for (const x of s.texts) {
  if (!x.onscreen || x.alpha < 0.05 || !x.text.trim()) continue;
  let ratio = null; const c = parseColor(x.color);
  if (c && x.bg) { const a = c[3] * x.alpha; const fg = [0, 1, 2].map((k) => c[k] * a + x.bg[k] * (1 - a)); const [L1, L2] = [lumOf(fg), lumOf(x.bg)].sort((p, q) => q - p); ratio = (L1 + 0.05) / (L2 + 0.05); }
  const e = textSeen.get(x.text) ?? { px: Infinity, pxT: s.t, ratio: Infinity, ratioT: null, times: [], full: [], script: scriptOf(x.text), bold: false, weight: 400 };
  // 报的是全片最差的那个值，时刻和证据帧就得是最差的那一帧——不是这段字第一次出现的时候
  // （weiqi-intro：对比度最差在相机横移那一刻，证据帧却取在 17.7s 第一次出现时，那一帧什么问题都没有）
  if (x.px * phone < e.px) { e.px = x.px * phone; e.pxT = s.t; }
  if (ratio != null && x.alpha > 0.9 && ratio < e.ratio) { e.ratio = ratio; e.ratioT = s.t; }
  e.bold ||= (x.weight ?? 400) >= 600; e.weight = Math.max(e.weight, x.weight ?? 400);
  e.times.push(s.t); if (x.alpha > 0.9) e.full.push(s.t);
  textSeen.set(x.text, e);
}
// 先逐段判，再按"同一项 × 同一文种 × 同字重 × 同字号档"合并：
// 逐帧换字的乱码、逐字绘制的底纹会产生上百条同质发现，逐条报会把真正的问题淹掉。
const raw = [];
const cps = laws.read_cps ?? 9;
for (const [text, e] of textSeen) {
  const where = e.times[0], last = e.times.at(-1), base = { text, t: where, first: where, last, script: e.script, bold: e.bold, weight: e.weight, px: e.px };
  const lim = limitOf(e.script, e.weight);
  if (!on('readability')) { /* 没声明 readability */ }
  else if (lim && lim.v === null) raw.push({ ...base, t: e.pxT, level: 'LOOK', layer: '疑点', id: 'readability.size', why: `${SCRIPT_NAME[e.script]}${e.bold ? '粗体' : ''}这一档没有稳定可读下限（${lim.key}=null）` });
  else if (lim && e.px < lim.v) raw.push({ ...base, t: e.pxT, level: 'FAIL', layer: '客观', id: 'readability.size', why: `阈值 ${lim.v.toFixed(1)}px（${lim.key}）` });
  const big = e.px >= C_LARGE_PX; // WCAG "大字" ≈ 18.66 CSS px（14pt 粗）/ 24px（18pt）；保守取 18.66。阈值可在 checks 的 {"contrast": {…}} 改
  if (on('contrast') && e.ratio !== Infinity && e.ratio < (big ? C_LARGE : C_MIN)) raw.push({ ...base, t: e.ratioT, level: 'FAIL', layer: '客观', id: 'readability.contrast', ratio: e.ratio,
    why: C_DEFAULT ? `WCAG ${big ? '大字 3' : '4.5'}:1` : `本片声明的对比度下限 ${big ? `大字 ${C_LARGE}` : C_MIN}:1` });
  const need = Math.max(0.5, [...text].length / cps), shown = e.full.length / sfps;
  if (on('readability') && shown + 1 / sfps < need) raw.push({ ...base, level: 'LOOK', layer: '疑点', id: 'readability.time', shown, need });
}
const groups = new Map();
for (const r of raw) {
  // readability.time：单字（乱码带、逐帧换字、逐字绘制）不分文种合成一组；多字文本按字号档分组
  const k = r.id === 'readability.time'
    ? [r.id, r.level, [...r.text].length < 2 ? 'single' : `multi|${Math.round(r.px * 2) / 2}`].join('|')
    : [r.id, r.level, r.script, r.weight, Math.round(r.px * 2) / 2].join('|');
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const q = (s) => `「${s.slice(0, 20)}」`;
// 合并报告时的代表条目 = 最差的那一条（证据帧取它的最差时刻），不是组里第一条
const worstOf = (g) => g[0].id === 'readability.contrast' ? g.reduce((a, b) => (b.ratio < a.ratio ? b : a))
  : g[0].id === 'readability.size' ? g.reduce((a, b) => (b.px < a.px ? b : a)) : g[0];
for (const g of groups.values()) {
  const r = worstOf(g), single = g.every((x) => [...x.text].length < 2);
  const kinds = [...new Set(g.map((x) => SCRIPT_NAME[x.script]))].join('/');
  const kind = r.id === 'readability.time' ? (single ? `单字（${kinds}）` : kinds) : `${SCRIPT_NAME[r.script]} ${r.weight}`;
  const from = Math.min(...g.map((x) => x.first)), to = Math.max(...g.map((x) => x.last));
  const many = g.length >= 3, who = many ? `${g.slice(0, 5).map((x) => q(x.text)).join('')}… ×${g.length} 段${kind}文字（${fmt(from)}–${fmt(to)}）` : null;
  for (const x of many ? [r] : g) {
    const subj = many ? who : `${q(x.text)}（${kind}）`;
    let msg;
    if (x.id === 'readability.size') msg = `${subj}在 ${viewW}px 宽时${many ? '' : '只有'} ${x.px.toFixed(1)}px（原生 ${(x.px / phone).toFixed(0)}px），${x.why}${Math.abs(x.t - x.first) > 1e-6 ? `；最小在 ${fmt(x.t)}` : ''}`;
    else if (x.id === 'readability.contrast') msg = `${subj}完全显现时对比度${many ? '最低' : ''} ${x.ratio.toFixed(2)}:1（${x.why}；最差在 ${fmt(x.t)}${many ? `，${q(x.text)}` : ''}）`;
    else {
      const churn = many && single;
      msg = churn ? `${subj}每个都只短暂出现（最长 ${Math.max(...g.map((y) => y.shown)).toFixed(2)}s）：像是持续变化的文字区（乱码/逐帧换字/滚动底纹）。若是刻意的可忽略；若这是逐字绘制的正文，要人看它读不读得完`
        : `${subj}完全显现约 ${x.shown.toFixed(2)}s，按 ${cps} 字/秒读完要 ${x.need.toFixed(2)}s（若是刻意的闪字可忽略）`;
    }
    add(x.level, x.layer, x.id, msg, { t: x.t, count: many ? g.length : 1, ev: x.level === 'FAIL' ? saveEvidence(x.id.split('.')[1], x.t) : undefined });
  }
}
if (!on('readability') && !on('contrast')) { /* 都没声明：不报 */ }
else if (!textSeen.size) add('SKIP', '客观', 'readability', '采样帧里没截到文字绘制（canvas fillText / DOM 文本）。若字是预渲染到位图或路径里的，这项只能人看 phone.png');
else if (!raw.some((r) => r.level === 'FAIL')) add('PASS', '客观', 'readability', on('readability') && on('contrast') ? `${textSeen.size} 段文字字号与对比度均达标（阈值来源：${tierSrc}）`
  : on('readability') ? `${textSeen.size} 段文字字号达标（阈值来源：${tierSrc}；对比度本片没声明，不查）` : `${textSeen.size} 段文字对比度达标（字号本片没声明，不查）`);

// ---------- 4. 事实数字对账 ----------
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT = { 十: 10, 百: 100, 千: 1000, 万: 1e4, 亿: 1e8 };
const cnToNum = (s) => {
  if (![...s].some((c) => UNIT[c])) return Number([...s].map((c) => CN[c]).join('')); // 六一八 → 618（逐位读）
  let total = 0, sec = 0, cur = 0;
  for (const c of s) { if (c in CN) cur = CN[c]; else if (UNIT[c] >= 1e4) { total += (sec + cur) * UNIT[c]; sec = 0; cur = 0; } else { sec += (cur || 1) * UNIT[c]; cur = 0; } }
  return total + sec + cur;
};
const numbersIn = (s) => {
  const out = [];
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.push({ raw: m[0], n: Number(m[0]) });
  for (const m of s.matchAll(/[零〇一二两三四五六七八九十百千万亿]{2,}/g)) {
    const raw = m[0]; if (!/[十百千万亿]/.test(raw) && raw.length < 3) continue; // "一点""一滴"之类不是数字
    out.push({ raw, n: cnToNum(raw) });
  }
  return out;
};
// 对账的单位是"一段话"，不是"一次 fillText"：数字和单位常分两笔画（字号/字重不同），
// 按笔切段会把「19」「道」拆成两行，factcheck --strict 拿到裸数字、单位丢了。所以先把同一帧里
// 同一画布、同一基线、首尾相接的几笔拼成一段（joinRuns），onscreen.txt 和下面的宽松筛都用拼好的段。
// 可读性（字号/对比度/时长）仍按笔量：那几项量的是每一笔自己的字。
const isAlnum = (c) => /[A-Za-z0-9\u00c0-\u024f]/.test(c ?? '');
const isCJK = (c) => /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/.test(c ?? '');
const joinRuns = (texts) => {
  const pcs = texts.filter((x) => x.line && x.onscreen && x.alpha >= 0.05 && x.text.trim()).map((x) => {
    const L = x.line, dx = L.x1 - L.x0, dy = L.y1 - L.y0, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    return { text: x.text, font: L.font, cid: L.cid, base: L.base, em: L.em, ux, uy, ang: Math.atan2(uy, ux), s0: L.x0 * ux + L.y0 * uy, s1: L.x1 * ux + L.y1 * uy, off: -L.x0 * uy + L.y0 * ux };
  });
  // 同一笔画了两遍（描边 + 填充、投影层）：同字、同位置只留一笔，否则会拼成「字幕字幕」
  const uniq = [];
  for (const p of pcs) if (!uniq.some((u) => u.cid === p.cid && u.text === p.text && Math.abs(u.s0 - p.s0) < 0.3 * p.em && Math.abs(u.off - p.off) < 0.3 * p.em)) uniq.push(p);
  const used = new Set(), out = [];
  const same = (a, b) => a.cid === b.cid && a.base === b.base && Math.abs(a.ang - b.ang) < 0.02 && Math.abs(a.off - b.off) <= 0.15 * Math.min(a.em, b.em);
  for (const p of [...uniq].sort((a, b) => a.s0 - b.s0)) {
    if (used.has(p)) continue;
    used.add(p); let cur = p, text = p.text; const fonts = new Set([p.font]); let multi = [...p.text].length > 1;
    for (;;) {
      // 下一笔：同基线、起点在当前笔末端之后不超过 0.6 个小字号 em（数字和单位之间的字距），也不倒退进当前笔里
      const nx = uniq.filter((q) => !used.has(q) && same(cur, q)).map((q) => ({ q, gap: q.s0 - cur.s1 }))
        .filter(({ gap, q }) => gap >= -0.3 * Math.min(cur.em, q.em) && gap <= 0.6 * Math.min(cur.em, q.em)).sort((a, b) => a.gap - b.gap)[0];
      if (!nx) break;
      used.add(nx.q); fonts.add(nx.q.font); multi ||= [...nx.q.text].length > 1;
      // 缝里补不补空格：两侧都是字母数字且缝 ≥0.15 em，或缝 ≥0.25 em 且两侧都不是汉字（等宽字逐格画时空格那一格本身不画）
      const em = Math.min(cur.em, nx.q.em), L = text.at(-1), R = nx.q.text[0];
      const sp = nx.gap >= 0.15 * em && ((isAlnum(L) && isAlnum(R)) || (nx.gap >= 0.25 * em && !isCJK(L) && !isCJK(R)));
      text += (sp ? ' ' : '') + nx.q.text;
      cur = nx.q;
    }
    // glyphwise：整段每一笔都是单个字、且同一个字体串 = 逐字绘制（打字机、等宽字逐格、乱码带、逐字升起）。
    // 字体不同的几笔拼起来（数字 + 单位、粗体关键词 + 正文）是排版上的一句话；逐字画的流多半是装饰性的底纹，
    // 旧版本来就不让单字参与对账，拼成段之后也归"逐字绘制的数字"那一类，由 facts_single 声明管。
    out.push({ text, glyphwise: !multi && fonts.size === 1 });
  }
  return [...out, ...texts.filter((x) => !x.line && x.onscreen && x.alpha >= 0.05 && x.text.trim()).map((x) => ({ text: x.text, glyphwise: false }))];
};
const segSeen = new Map(); // 拼好的段 -> 第一次出现的采样时刻
const typeset = new Set(); // 至少有一帧不是逐字绘制的段（同一段字在别的帧里是整笔画的，就按整笔算）
for (const s of samples) for (const g of joinRuns(s.texts)) { if (!segSeen.has(g.text)) segSeen.set(g.text, s.t); if (!g.glyphwise) typeset.add(g.text); }
// 逐字绘制的数字（拼段之后仍孤零零的单个数字：瓣里的编号、计数器的一位；以及整段都是同一字体逐字画出来的流：
// 等宽字逐格画的 HTTP 头、乱码带）：是序号/装饰还是事实陈述，机器分不出——看本片声明（critique 块 facts_single）：
//   "check"          参与对账（和多字段一样：facts.md 里要有同值的数）
//   其它任意字符串    = 不对账的理由（"瓣里的 1–6 是序号"），照写进报告
//   没声明            疑点（LOOK），列出是哪些数、在哪一刻，不静默跳过
// 只想排除其中一部分：facts_ignore（正则，按整段匹配）对单字同样生效。
// 本片还可以用 critique 块的 facts_ignore（正则）排除装饰性数字，例如 HTTP 状态码底纹。
const ign = laws.facts_ignore ? new RegExp(laws.facts_ignore) : null;
const isGlyphwise = (t) => [...t.trim()].length < 2 || !typeset.has(t);
const shownTexts = [...segSeen.keys()].filter((t) => !isGlyphwise(t) && !(ign && ign.test(t)));
const singleSegs = [...segSeen.keys()].filter((t) => isGlyphwise(t) && /\d/.test(t) && !(ign && ign.test(t)))
  .sort((a, b) => segSeen.get(a) - segSeen.get(b) || a.localeCompare(b));
const singleWhere = singleSegs.map((t) => `${q(t.trim())}@${fmt(segSeen.get(t))}`).slice(0, 12).join(' ');
const checkSingles = laws.facts_single === 'check';
if (on('facts.screen') && singleSegs.length) {
  if (checkSingles) add('PASS', '本片法律', 'facts.single', `本片声明 facts_single: check：${singleSegs.length} 段逐字绘制的数字参与对账（${singleWhere}${singleSegs.length > 12 ? '…' : ''}）`);
  else if (typeof laws.facts_single === 'string' && laws.facts_single.trim()) add('SKIP', '本片法律', 'facts.single', `${singleSegs.length} 段逐字绘制的数字不对账，本片声明的理由：${laws.facts_single}（${singleWhere}${singleSegs.length > 12 ? '…' : ''}）`);
  else add('LOOK', '疑点', 'facts.single', `画面上有 ${singleSegs.length} 段逐字绘制的数字（孤立的单个数字，或同一字体逐字画出的一串），没有对账：${singleWhere}${singleSegs.length > 12 ? '…' : ''}。是事实陈述（计数、读数）就在 critique 块写 "facts_single": "check"；是序号/装饰就写一句理由（"facts_single": "瓣里的 1–6 是序号"），或用 facts_ignore 排除其中一部分`, { t: segSeen.get(singleSegs[0]) });
}
const said = [...(nar?.lines ?? []).map((l) => ({ src: `旁白 ${l.id}`, text: l.text })), ...shownTexts.map((t) => ({ src: '画面', text: t })), ...(checkSingles ? singleSegs.map((t) => ({ src: `画面（逐字绘制 @${fmt(segSeen.get(t))}）`, text: t })) : [])];
const claimed = said.flatMap((x) => numbersIn(x.text).map((n) => ({ ...n, src: x.src })));
if (!on('facts.screen')) { /* 没声明 facts.screen：画面/旁白里的数字不对账 */ }
else if (!claimed.length) add('SKIP', '客观', 'facts.screen', '画面与旁白里没有数字');
else {
  const facts = F.readText('docs/facts.md');
  if (!facts) add('FAIL', '客观', 'facts.screen', `画面/旁白出现了 ${claimed.length} 个数字，但没有 docs/facts.md 可对账：${claimed.map((c) => c.raw).join('、')}`);
  else {
    const known = new Set(numbersIn(facts).map((x) => x.n));
    const miss = claimed.filter((c) => !known.has(c.n));
    // 分工（写在两边文档里）：这里是**宽松筛**——只比数值、在 facts.md 全文里找同值数，不认单位。
    // 所以 FAIL 是可靠的（facts.md 里连这个数值都没有，按任何口径都对不上），PASS 不是对账通过：
    // "22 辆"会命中 facts.md 里的"22 米"。严格对账（值 + 单位 + 事实状态）是 film-story 的 factcheck.mjs（checks 的 facts.script）；
    // 画面文字它看不见，所以这里把截到的画面文字写进 out/critique/onscreen.txt，交给它 --also。
    // 每段一行 = 同一帧里同基线、首尾相接的几笔拼起来的（joinRuns）；声明了 facts_single: check 时单个数字也写进去
    writeFileSync(join(outDir, 'onscreen.txt'), `<!-- check.mjs 采样截到的画面文字（每段一行：同一帧同一基线上首尾相接的几笔已拼成一段），给 film-story factcheck.mjs --also 用 -->\n${[...shownTexts, ...(checkSingles ? singleSegs : [])].join('\n')}\n`);
    const strict = `严格对账（认单位）跑 film-story 的 factcheck.mjs --film ${F.slug} --also out/critique/onscreen.txt`;
    if (miss.length) add('FAIL', '客观', 'facts.screen', `facts.md 里连同值的数都找不到：${miss.map((c) => `${c.raw}（=${c.n}，${c.src}）`).join('、')}。${strict}`);
    else add('PASS', '客观', 'facts.screen', `${claimed.length} 个数字的数值都在 facts.md 出现过（只比数值、不认单位，不等于对账通过）：${[...new Set(claimed.map((c) => c.raw))].join('、')}。${strict}`);
  }
}

// ---------- 5. 本片法律：palette / max_still / 其余交给人 ----------
if (!on('style-guide')) { /* 没声明 style-guide */ }
else if (laws._missing) add('LOOK', '本片法律', 'style-guide', '没有 docs/style_guide.md：本片没有声明任何法律，本片维度无从打分（这本身值得补）');
else if (laws._noBlock) add('LOOK', '本片法律', 'style-guide', 'style_guide.md 没有 ```critique 块，机器只能跳过本片法律，全部条目交给人眼');
if (pal && on('laws')) {
  const bad = samples.filter((s) => s.off != null && s.off > (laws.palette_max ?? 0.005));
  if (bad.length) { const w = bad.reduce((a, b) => (b.off > a.off ? b : a)); add('FAIL', '本片法律', 'law.palette', `出现色板外颜色：${bad.length} 个采样秒超标，最严重 ${fmt(w.t)} 占 ${(w.off * 100).toFixed(2)}% 像素`, { t: w.t, ev: saveEvidence('palette', w.t) }); }
  else add('PASS', '本片法律', 'law.palette', `每秒抽 1 帧，色板外像素都 ≤ ${((laws.palette_max ?? 0.005) * 100).toFixed(1)}%`);
}
// 法律带 pixels 判据时机器判，否则原样交给人眼。判据只能是"每帧某个像素统计不超过/不低于某值"——
// 这类法律（"X 之后某颜色必须消失""Y 区间里必须看得见某颜色"）数像素就是答案，不需要审美。
// 时间窗引用 window.MARKS 的 label（与画面同源），不写秒数；grace 是本片给退场动画的容差（秒），和 max_still 同类。
const markRef = (ref, edge0) => {
  if (ref == null) return edge0;
  if (ref === 'start') return 0; if (ref === 'end') return D;
  const m = /^(.*?)(?:\.(start|end))?$/.exec(ref), mk = marks.find((x) => x.label === m[1]);
  if (!mk) throw new Error(`引用了不存在的 MARK「${m[1]}」（场景声明的有：${marks.map((x) => x.label).join('、') || '无'}）`);
  return m[2] === 'end' ? mk.end : mk.start;
};
// 一串帧交给像素线程：按 BATCH 帧一批并行算，结果按原顺序拼回。frames[j] 的"上一帧"是 frames[j-1]（j=0 是 before），
// prevOk[j] 为假时 motion = null——与原分析页 measure 的 mPrev / prevOk 同一语义。
const BATCH = 24;
const pixelRun = async (frames, specs, before, prevOk) => {
  const jobs = [];
  for (let a = 0; a < frames.length; a += BATCH) jobs.push(pix.run({ frames: frames.slice(a, a + BATCH), before: a ? frames[a - 1] : before, prevOk: prevOk.slice(a, a + BATCH), specs }));
  return (await Promise.all(jobs)).flat();
};
let lastMeasured = null;
for (const l of on('laws') ? laws.laws ?? [] : []) {
  if (isAnchorLaw(l)) { await phase('anchor_laws', () => runAnchorLaw(l, { S, ap, pool, F, D, add, fmt, markRef, outDir, writeFileSync, join, fps: num('claim-fps', F.fps) })); continue; }
  if (!l.pixels) {
    // HUMAN 行给"看哪一帧"：法律写了 from/to 时存时间窗中点那一帧；没写时间窗的不给（review_log 指向 stills / transitions 拼图）
    let at = null;
    if (l.from != null || l.to != null) { try { const a = markRef(l.from, 0), b = markRef(l.to, D); if (b >= a) at = (a + b) / 2; } catch { /* 引用错了照样进 HUMAN，不在这里判 */ } }
    add('HUMAN', '本片法律', `law.${l.id}`, `${l.text}${l.how ? `（怎么看：${l.how}）` : ''}`, at != null ? { t: nearest(at), ev: saveEvidence(`human-${l.id}`, at) } : {});
    continue;
  }
  const id = `law.${l.id}`, P = l.pixels;
  let a, b;
  try { a = markRef(l.from, 0) + (l.grace ?? 0); b = markRef(l.to, D); } catch (e) { add('FAIL', '本片法律', id, `${l.text}：${e.message}`); continue; }
  if (P.stat === 'motion' || (P.max == null && P.min == null)) { add('FAIL', '本片法律', id, `${l.text}：pixels 判据要写 max 或 min，stat 只能是 count / cx / cy`); continue; }
  const win = samples.filter((s) => s.t >= a - 1e-6 && s.t <= b + 1e-6);
  if (!win.length) { add('FAIL', '本片法律', id, `${l.text}：时间窗 ${fmt(a)}–${fmt(b)} 里没有采样帧`); continue; }
  let worst = null, peak = -Infinity, low = Infinity;
  // 原生分辨率数像素：Node 端 worker 线程（_pixels.mjs），按帧连续分批、按原顺序取回。stat 不会是 motion（上面已拒），不需要"上一帧"
  const vs = await phase('pixel_laws', () => pixelRun(win.map((s) => evidence.get(s.t)), [P], null, win.map(() => false)));
  for (const [k, s] of win.entries()) {
    const [v] = vs[k];
    if (v != null) { peak = Math.max(peak, v); low = Math.min(low, v); }
    if (!worst && (v == null || (P.max != null && v > P.max) || (P.min != null && v < P.min))) worst = { t: s.t, v };
  }
  lastMeasured = win.at(-1).t; // 串行时分析页的 mPrev 停在这一帧；像素断言的第一帧要据此判"上一帧"是否相邻
  const what = `${P.stat}(${P.near ?? `r${P.r}g${P.g}b${P.b}`}${P.tol != null ? `±${P.tol}` : ''})`;
  const range = `${fmt(a)}–${fmt(b)} 的 ${win.length} 个采样帧（${sfps}fps）`;
  if (worst) add('FAIL', '本片法律', id, `${l.text}：${fmt(worst.t)} 时 ${what}=${worst.v}，超出 ${P.max != null ? `max ${P.max}` : ''}${P.min != null ? ` min ${P.min}` : ''}（${range}）`, { t: worst.t, ev: saveEvidence(`law-${l.id}`, worst.t) });
  else add('PASS', '本片法律', id, `${l.text}：${range}里 ${what} ∈ [${low}, ${peak}]（像素判据，机器判）`);
}

// ---------- 6. 时间结构：静止 / 空画面 / 承重事件 ----------
const stills = runs((x, i) => i > 0 && !x.moved).map((r) => ({ ...r, from: r.from - 1 / sfps }));
const maxStill = laws.max_still; // 只有本片声明了才是法律
for (const r of stills) {
  const len = r.to - r.from; if (len < (maxStill ?? 1.0) - 1e-6) continue;
  const speaking = lines.filter((l) => l.s < r.to && l.e > r.from).map((l) => l.id);
  const msg = `${fmt(r.from)}–${fmt(r.to)} 画面完全静止 ${len.toFixed(2)}s${speaking.length ? `（期间旁白 ${speaking.join('/')} 在说）` : '（期间无旁白）'}`;
  if (maxStill != null) { if (on('laws')) add('FAIL', '本片法律', 'law.max_still', `${msg}，超过本片声明的 max_still=${maxStill}s`, { t: r.from, to: r.to, ev: saveEvidence('still', r.from) }); }
  else if (on('still')) add('LOOK', '疑点', 'still', `${msg}。本片没声明 max_still，是不是死拍看意图`, { t: r.from, to: r.to, ev: saveEvidence('still', r.from) });
}
const emptyTh = laws.empty_edge ?? 0.001;
for (const r of on('empty') ? runs((x) => x.edge < emptyTh) : []) {
  const speaking = lines.filter((l) => l.s < r.to && l.e > r.from);
  if (!speaking.length) continue;
  const ov = speaking.map((l) => `${l.id}「${l.text.slice(0, 14)}」${fmt(l.s)}–${fmt(l.e)}`).join('；');
  add('LOOK', '疑点', 'empty.vo', `${fmt(r.from)}–${fmt(r.to)} 画面已空（边缘像素 <${emptyTh * 100}%），旁白还在说：${ov}。查文案和画面是否矛盾`, { t: r.from, to: r.to, ev: saveEvidence('empty', r.from) });
}
// 封面帧：t=0 是播放器默认缩略图、信息流里静音自动播放的第一眼。空的不一定错（从黑场淡入是正当的开场），所以只报 LOOK。
if (on('cover') && samples.length) {
  const s0 = samples[0];
  if (s0.edge < emptyTh) add('LOOK', '疑点', 'cover.empty', `首帧 t=0 画面是空的（边缘像素 ${(s0.edge * 100).toFixed(3)}% < ${emptyTh * 100}%）：缩略图 / 静音自动播放的第一眼什么都没有。淡入开场是故意的就在 MARKS 里给 0 秒起的区间加 hold 理由`, { t: 0, to: 0, ev: saveEvidence('cover', 0) });
  else add('PASS', '疑点', 'cover.empty', `首帧有内容（边缘像素 ${(s0.edge * 100).toFixed(2)}%）`);
}
const syncTol = laws.sync_tol ?? 0.2;
// 可见性（下面"起点前一帧 vs 区间内"）每个事件只看自己的几帧，事件之间互不相干：先按事件并行量完，结论仍按原顺序写
const markVis = on('marks') ? await phase('marks', () => pool.chunks(marks, async (w, part) => {
  const out = [];
  for (const m of part) {
    const before = await w.S.shot(Math.max(0, m.start - 1 / F.fps));
    const mid = Math.min(lastT, (m.start + m.end) / 2);
    let vts = []; for (let k = Math.ceil(m.start * F.fps - 1e-6); k <= Math.floor(Math.min(m.end, lastT) * F.fps + 1e-6); k++) vts.push(k / F.fps);
    if (vts.length > 24) vts = Array.from({ length: 24 }, (_, i) => vts[Math.round((i * (vts.length - 1)) / 23)]);
    vts = [mid, ...vts.filter((x) => Math.abs(x - mid) > 1e-9)];
    let dpx = 0;
    for (const vt of vts) { dpx = Math.max(dpx, await w.ap.evaluate(([a, b]) => window.A.compare(a, b), [before.toString('base64'), (await w.S.shot(vt)).toString('base64')])); if (dpx >= 4) break; }
    out.push({ dpx, n: vts.length });
  }
  return out;
}, { size: 1 })) : [];
for (const [mi, m] of (on('marks') ? marks : []).entries()) {
  const len = m.end - m.start, frames = Math.round(len * F.fps);
  const need = laws.min_mark ?? Math.max(0.5, m.text ? [...m.text].length / (laws.read_cps ?? 9) : 0);
  if (m.load && len < need) add('FAIL', '客观', 'mark.length', `承重事件「${m.label}」只占 ${len.toFixed(2)}s（${frames} 帧 @${F.fps}fps），阈值 ${need.toFixed(2)}s：观众看不见它`, { t: m.start, ev: saveEvidence('mark', m.start) });
  // 可见性：起点前一帧 vs 区间内的画面，取变化最大的那一帧。旧版只比区间中点，
  // 短促的变化（闪一下、中点前已经复原）会被判"声明了但没画出来"。
  // 中点总在候选里，所以旧版判过的这里一定也过；按成片帧栅格取样，最多 24 帧，够 4 像素就停。
  const { dpx, n: nVis } = markVis[mi];
  if (dpx < 4) add('FAIL', '客观', 'mark.visible', `事件「${m.label}」${fmt(m.start)}–${fmt(m.end)} 起点前一帧与区间内 ${nVis} 个采样帧（含中点）画面都相同：声明了但没画出来`, { t: m.start });
  if (m.word) {
    // 词在旁白里可能出现多次。旧版一律取全片第一次出现：MARK 绑的是后一句里的「下进去」，
    // 而前一句先念过一次，就会拿十几秒前的那次去比，报一个假的错位。
    // 取哪一次，按 MARK 声明的上下文：nth（第几次）> line（哪一句里的）> 离事件最近的那一次。
    let at = null, which = '';
    try {
      if (!vo) at = null;
      else if (m.nth != null) at = vo.at(m.word, m.nth) + voOffset;
      else {
        const occ = []; for (let n = 1; ; n++) { try { occ.push({ n, t: vo.at(m.word, n) + voOffset }); } catch { break; } }
        if (!occ.length) vo.at(m.word, 1);                       // 一次都没有：让它抛出原来那条报错
        let pool = occ;
        if (m.line != null) { const ln = vo.line(m.line); pool = occ.filter((o) => o.t >= ln.start + voOffset - 1e-6 && o.t <= ln.end + voOffset + 1e-6);
          if (!pool.length) throw new Error(`句子 ${m.line} 里没有「${m.word}」（全片共 ${occ.length} 次）`); }
        const best = pool.reduce((a, b) => (Math.abs(b.t - m.start) < Math.abs(a.t - m.start) ? b : a));
        at = best.t;
        if (occ.length > 1) which = `；词在旁白里出现 ${occ.length} 次，取第 ${best.n} 次（${m.line != null ? `句子 ${m.line} 里离事件最近的` : '离事件最近的；要钉死写 MARK 的 line 或 nth'}）`;
      }
    }
    catch (e) { add('FAIL', '客观', 'mark.sync', `事件「${m.label}」绑定的词「${m.word}」：${e.message.split('narration.json 里有')[0].trim()}`); }
    if (!vo && !at) add('FAIL', '客观', 'mark.sync', `事件「${m.label}」绑定了词「${m.word}」，但没有可用的 narration.json`);
    else if (at != null && Math.abs(m.start - at) > syncTol) add('FAIL', '客观', 'mark.sync', `事件「${m.label}」在 ${fmt(m.start)}，词「${m.word}」念到在 ${fmt(at)}，差 ${(m.start - at).toFixed(2)}s（容差 ${syncTol}s）${which}`, { t: m.start });
    else if (at != null) add('PASS', '客观', 'mark.sync', `事件「${m.label}」与词「${m.word}」差 ${(m.start - at).toFixed(3)}s（查找用 film-narration 的 vo.at）${which}`);
  }
}
if (!on('marks')) { /* 没声明 marks */ }
else if (!marks.length) add('LOOK', '疑点', 'marks', '场景没有 window.MARKS：承重事件时长与音画对点都没法查。至少把叙事上承重的事件声明出来');
else if (!findings.some((f) => f.id.startsWith('mark.') && f.level === 'FAIL')) add('PASS', '客观', 'marks', `${marks.length} 个事件：时长、可见性、对点都过`);

// ---------- 7. 分镜断言的画面实测（shotlist claims × window.probe / 像素） ----------
// check_shotlist.py 在分镜阶段验的是作者钉的曲线 = 意图。变量由仿真/迭代/库推出时，意图和画面完全脱钩，
// 那里的绿灯是假的。这里在有浏览器的阶段逐帧取真实值，交回 check_shotlist.py 用同一份语义判定。
//   source: scene  → window.probe(t)[曲线名]：场景自己算出的机制状态（便宜、连续量）
//   source: pixels → 截帧数像素：画面上真画出来了什么（贵、只有颜色/质心/运动这几种统计）
// probe 绿只说明"场景算出的状态对"，不说明"它被画出来了"；像素绿才是画面为真。
const cost = {};
if (!on('claims')) { /* 没声明 claims：分镜断言不做画面实测 */ }
else if (!existsSync(join(F.dir, 'docs/shotlist.md'))) add('SKIP', '客观', 'claims', '没有 docs/shotlist.md，分镜断言无从实测');
else if (!existsSync(SL_PY)) add('FAIL', '客观', 'claims', `装了 film-story，但没有 ${SL_PY}（版本不对？）：分镜断言的画面实测要它判定`);
else {
  let plan = null;
  try { plan = JSON.parse(execFileSync('python3', [SL_PY, '--film', F.dir, '--plan'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { add('SKIP', '客观', 'claims', `check_shotlist.py --plan 跑不起来，分镜断言没实测：${String(e.stderr || e.message).trim().split('\n').at(-1)}`); }
  if (plan) {
    const hasProbe = await S.page.evaluate(() => typeof window.probe === 'function');
    if (Math.abs(plan.vo_offset - voOffset) > 1e-3) add('FAIL', '客观', 'claims.offset', `check_shotlist 算出的片头留白 ${plan.vo_offset}s 与本脚本用的 ${voOffset}s（film.json narrationOffset / window.VO_OFFSET）不一致：断言区间和画面错位`);
    if (plan.end_anchor != null && Math.abs(plan.end_anchor - D) > 1 / F.fps + 1e-6) add('FAIL', '客观', 'claims.end', `shotlist 的锚点 end=${fmt(plan.end_anchor)}（旁白结束 + 片尾留白），场景 DURATION=${fmt(D)}：片尾留白在两处各写了一份且不一致。以 film.json narrationTail 为准，场景用 vo.filmDuration`);
    const cf = num('claim-fps', F.fps); // 默认按成片帧率逐帧：0.07s 的全灭在 10fps 采样下会漏
    const frameTs = ([a, b]) => { const out = []; for (let k = Math.ceil(a * cf - 1e-6); k <= Math.floor(b * cf + 1e-6); k++) if (k / cf <= lastT + 1e-9) out.push(+(k / cf).toFixed(6)); return out; };
    const sampled = []; let impure = false, probeAt = null;
    // --- scene：一次 evaluate 取完所有帧（逐帧各 evaluate 一次的往返开销见仓库 docs/verified/film-critique.md），再倒序取一遍查纯函数 ---
    const sceneClaims = plan.claims.filter((c) => c.source === 'scene');
    let probeKeys = null;
    if (hasProbe) probeKeys = Object.keys((await S.page.evaluate((t) => window.probe(t), 0)) ?? {});
    const viaProbe = plan.claims.filter((c) => c.source === 'scene' || (c.source === 'curve' && probeKeys?.includes(c.curve)));
    if (sceneClaims.length && !hasProbe) add('FAIL', '客观', 'claims.scene', `shotlist 声明 ${[...new Set(sceneClaims.map((c) => c.curve))].join('、')} 来自场景（source: scene），但场景没有暴露 window.probe(t)：这 ${sceneClaims.length} 条断言在画面上是否为真，没人验过`);
    else if (viaProbe.length) {
      const ts = [...new Set(viaProbe.flatMap((c) => frameTs(c.span)))].sort((x, y) => x - y);
      const t0 = Date.now();
      const fwd = await S.page.evaluate((ts) => ts.map((t) => window.probe(t)), ts);
      cost.probe_ms = Date.now() - t0;
      const t1 = Date.now();
      const rev = (await S.page.evaluate((ts) => ts.map((t) => window.probe(t)), [...ts].reverse())).reverse();
      cost.probe_reverse_ms = Date.now() - t1; cost.probe_frames = ts.length;
      const k = ts.findIndex((_, i) => JSON.stringify(fwd[i]) !== JSON.stringify(rev[i]));
      if (k >= 0) impure = true;
      if (k >= 0) add('FAIL', '客观', 'probe.pure', `window.probe(${ts[k]}) 顺序取 ${JSON.stringify(fwd[k])}，倒序取 ${JSON.stringify(rev[k])}：probe 不是 t 的纯函数（缓存回退泄漏？参见 film-physics），断言实测不可信`, { t: ts[k] });
      const at = new Map(ts.map((t, i) => [t, fwd[i]])); probeAt = at;
      for (const c of viaProbe) {
        const cts = frameTs(c.span), miss = cts.find((t) => !(c.curve in (at.get(t) ?? {})));
        if (miss != null) { add('FAIL', '客观', 'claims.scene', `「${c.says}」要 ${c.curve}，但 window.probe(${miss}) 没返回这个键（返回了：${Object.keys(at.get(miss) ?? {}).join('、')}）`); continue; }
        sampled.push({ idx: c.idx, via: 'scene', ts: cts, vals: cts.map((t) => { const v = at.get(t)[c.curve]; return Number.isFinite(v) ? v : null; }) });
      }
    }
    // --- anchor：逐帧取 window.anchors(t) 的锚点统计量（_anchors.mjs）。只要 draw 不要截图 ---
    const anc = await phase('anchor_claims', () => anchorClaims(plan.claims.filter((c) => c.source === 'anchor'), { S, pool, add, frameTs }));
    sampled.push(...anc.sampled); Object.assign(cost, anc.cost);
    // --- pixels：逐帧截图、原生分辨率数像素。截图是这里的主要成本 ---
    const pixClaims = plan.claims.filter((c) => c.source === 'pixels');
    if (pixClaims.length) {
      const need = new Map(); // t -> Set(idx)
      for (const c of pixClaims) {
        const cts = frameTs(c.span);
        if (c.pixels.stat === 'motion' && cts.length && cts[0] > 0) cts.unshift(+(cts[0] - 1 / cf).toFixed(6)); // motion 要前一帧
        for (const t of cts) need.set(t, (need.get(t) ?? new Set()).add(c.idx));
      }
      const ts = [...need.keys()].sort((x, y) => x - y), vals = new Map(pixClaims.map((c) => [c.idx, new Map()]));
      const t0 = Date.now(); let shots = 0;
      process.stdout.write(`分镜断言像素实测：${pixClaims.length} 条，${ts.length} 帧 @${cf}fps`);
      // 串行语义：第 i 帧的"上一帧"是第 i-1 帧（第 0 帧是像素法律量的最后一帧），两者相差恰好 1/cf 时 motion 才有值
      const step = 1 / cf, specs = pixClaims.map((c) => c.pixels);
      const prevT = (i) => (i > 0 ? ts[i - 1] : lastMeasured);
      const prevOk = ts.map((t, i) => prevT(i) != null && Math.abs(t - prevT(i) - step) < 1e-4);
      const needPrev = specs.some((sp) => sp.stat === 'motion');
      const grab = async (w, t) => evidence.get(+t.toFixed(4)) ?? (shots++, await w.S.shot(t));
      // 分片：页面按时间顺序截（或取主采样已有的帧），截完一片整片交给像素线程。分片开头的"上一帧"若在别的分片里，重截一次（纯函数，像素相同）
      const r = await phase('pixel_claims', () => pool.chunks(ts, async (w, part, a) => {
        const pngs = []; for (const t of part) pngs.push(await grab(w, t));
        const before = needPrev && prevOk[a] ? (a > 0 ? await grab(w, ts[a - 1]) : evidence.get(lastMeasured)) : null;
        process.stdout.write('.');
        return pixelRun(pngs, specs, before, prevOk.slice(a, a + part.length));
      }));
      for (const [i, t] of ts.entries()) pixClaims.forEach((c, j) => vals.get(c.idx).set(t, r[i][j]));
      cost.pixel_ms = Date.now() - t0; cost.pixel_frames = ts.length; cost.pixel_shots = shots;
      console.log(` ${(cost.pixel_ms / 1000).toFixed(1)}s`);
      for (const c of pixClaims) { const cts = frameTs(c.span); sampled.push({ idx: c.idx, via: 'pixels', ts: cts, vals: cts.map((t) => vals.get(c.idx).get(t)) }); }
    }
    if (sampled.length) {
      const f = join(outDir, 'claims-samples.json');
      writeFileSync(f, JSON.stringify({ fps: cf, claims: sampled }));
      let verdict = [];
      try { verdict = JSON.parse(execFileSync('python3', [SL_PY, '--film', F.dir, '--verdict', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
      catch (e) { add('FAIL', '客观', 'claims', `check_shotlist.py --verdict 失败：${String(e.stderr || e.message).trim().split('\n').at(-1)}`); }
      for (const v of verdict) {
        const head = `「${v.says}」[${fmt(v.span[0])}–${fmt(v.span[1])}] ${v.curve} ${v.op} ${v.value ?? ''}`.trim();
        const how = v.via === 'scene' ? 'window.probe' : v.via === 'anchor' ? 'window.anchors' : '像素';
        if (v.bad && v.via === 'scene' && v.bad_t != null && /无值（/.test(v.bad)) {
          // check_shotlist 的 eval_claim 对"无值"只分锚点 / 其它两种提示，其它一律说成像素无质心——
          // 对 probe 曲线是错的提示（没有像素可言）。按来源改写成 probe 的说法，并给出这一帧 probe 实际返回了什么。
          const got = probeAt?.get(v.bad_t), raw = got && v.curve in got ? got[v.curve] : undefined;
          v.bad = `t=${v.bad_t.toFixed(3)}s 时 ${v.curve} 无值（window.probe(${v.bad_t.toFixed(3)}).${v.curve} = ${raw === undefined ? 'undefined' : JSON.stringify(raw) ?? String(raw)}，不是有限数：场景说这一刻没有这个状态。查 probe 在这段时间是不是返回了 null / NaN / undefined，或这条断言的区间是不是比状态存在的时段长）`;
        }
        if (v.bad) {
          const ev = v.bad_t != null ? join(outDir, `evidence-claim${v.idx}-${v.bad_t.toFixed(2)}s.png`) : undefined;
          if (ev) writeFileSync(ev, await S.shot(v.bad_t));
          add('FAIL', '客观', `claims.${v.via}`, `音画矛盾 ${head}：${v.bad}（${how}逐帧实测 ${v.n} 帧；分镜阶段的意图曲线不代表画面）`, { t: v.bad_t, ev });
        }
        if (v.warn) add('LOOK', '疑点', 'claims.trend', `${head}：${v.warn}（${how}实测）`, { t: v.span[0] });
      }
      for (const via of ['scene', 'pixels', 'anchor']) {
        const vs = verdict.filter((v) => v.via === via); if (!vs.length || vs.some((v) => v.bad)) continue;
        if (via === 'scene' && impure) { add('SKIP', '客观', 'claims.scene', `${vs.length} 条断言按 window.probe 取值都过了，但 probe 不纯（见 probe.pure），这个"过"不算数`); continue; }
        if (via === 'anchor' && anc.impure) { add('SKIP', '客观', 'claims.anchor', `${vs.length} 条断言按 window.anchors 取值都过了，但锚点表不纯（见 anchors.pure），这个"过"不算数`); continue; }
        add('PASS', '客观', `claims.${via}`, `${vs.length} 条分镜断言按${via === 'scene' ? ' window.probe(t)' : via === 'anchor' ? ' window.anchors(t)' : '像素'}逐帧实测全部为真（${vs.reduce((a, v) => a + v.n, 0)} 帧次 @${cf}fps${via === 'scene' ? '；probe 验的是场景算出的状态，不是像素' : via === 'anchor' ? '；锚点是绘制时登记的框，不是像素' : ''}）`);
      }
    }
    // 承重变量全部来自手钉曲线、场景却在跑仿真：分镜绿灯很可能只是意图自洽
    // 本次实际加载的运行时（服务器记录）：来自 film-physics 的，或已冻结进片子、与 film-physics 运行时同名的
    const physNames = hasCapability('film-physics') ? (() => { try { return readdirSync(capability('film-physics').path('assets/runtime')); } catch { return []; } })() : [];
    const phys = pool.runtime().filter((r) => r.from === 'film-physics' || (r.from === 'film' && physNames.includes(r.name))).map((r) => r.name);
    if (plan.claims.length && plan.claims.every((c) => c.source === 'curve') && !viaProbe.length && phys.length)
      add('LOOK', '疑点', 'claims.source', `场景带了 film-physics 运行时（${phys.join('、')}），shotlist 的 ${plan.claims.length} 条断言却全部按手钉曲线验：若承重变量是仿真推出的，check_shotlist 的绿灯只说明意图自洽。照 film-story 的"改钉点测试"（references/claims.md）判断要不要标 source: scene / pixels`);
  }
}

// ---------- 8. 压扁疑点：斜着看的平面是不是画成了正交投影（film-motion 的 scripts/lib/tiltscan.mjs，经 capability 取）----------
// 只报 LOOK：斜放正方形的正交像与正俯视长方形逐像素相同，挤压拉伸/等轴测也是正当的非等比变换。critique 块 "ortho_ok" 声明有意如此。
// 取主采样 ts 的子集（约 4–5fps）：证据帧就是最差那一帧本身，不取近邻。
if (on('tilt')) {
  const every = Math.max(1, Math.round(sfps / 4)), tts = ts.filter((_, i) => i % every === 0);
  const t0 = Date.now();
  const truns = tilt.tiltRuns(await phase('tilt', () => pool.chunks(tts, (w, part) => tilt.tiltScan(w.S.page, part))), { step: every / sfps });
  cost.tilt_ms = Date.now() - t0; cost.tilt_frames = tts.length;
  for (const r of truns) {
    if (laws.ortho_ok) add('PASS', '本片法律', 'tilt.ortho', `${tilt.describeRun(r, fmt)}——本片声明 ortho_ok：${laws.ortho_ok}`);
    else add('LOOK', '疑点', 'tilt.ortho', `${tilt.describeRun(r, fmt)}。如果这是斜着看的平面，它是正交投影：平行线不收拢、远近边一样宽，读成长方形而不是斜放的方形。要透视用 film-motion 的 runtime/camera3d.js；有意如此就在 critique 块写 "ortho_ok": "<理由>"`, { t: r.worstT, ev: saveEvidence('tilt', r.worstT) });
  }
}

// ---------- 9. 衔接度 / 节奏（_flow.mjs）：只在 checks 声明了 continuity / rhythm 时跑，只报 LOOK ----------
if (on('continuity')) { const t0 = Date.now(); await phase('continuity', () => runContinuity({ S, pool, D, F, add, fmt, sfps, lastT, markRef, cfg: declared.get('continuity') })); cost.continuity_ms = Date.now() - t0; }
if (on('rhythm')) runRhythm({ D, F, add, fmt, samples, stills, sfps, marks, markRef, cfg: declared.get('rhythm') });

// ---------- 9b. 运动读数（_kinetics.mjs）：motion / variety / beatsync / hook / mute，声明了才跑，只报 LOOK ----------
let kinetics = null;
if (KIN) { kinetics = await phase('kinetics', () => runKinetics({ S, pool, F, D, fps: F.fps, sfps, ts, lastT, samples, evidence, marks, markRef, lines, emptyTh,
  coverOn: on('cover'), add, fmt, outDir, on, cfg: (k) => declared.get(k) })); cost.kinetics_ms = kinetics.cost.total; }

// ---------- 10. 世界文字可读性（_legible.mjs）：只在 checks 里 legible 声明了阈值时跑 ----------
// fillText 拦截看不见贴图 / 几何里的字，所以三维里的字由场景在渲染后自己量（window.legible），这里只读表、按本片阈值判。
if (on('legible')) Object.assign(cost, await phase('legible', () => runLegible({ S, pool, F, D, add, fmt, outDir, writeFileSync, join, cfg: declared.get('legible'), fps: num('claim-fps', F.fps) })));

// ---------- 11. 故意保留：MARKS 里 hold: "<理由>" 的区间 ----------
// 疑点（LOOK）整段落在某个 hold 区间里 → 改记 HOLD（不计 LOOK、--strict 不拦），理由照抄进 review_log 的「故意保留」一节。
// 只对 LOOK 生效：FAIL 是客观不变量或本片自己的法律，不能靠标记豁免。hold 不是非空字符串 → mark.hold FAIL（保留必须说理由）。
{
  const holds = [];
  for (const m of marks) {
    if (m.hold == null || m.hold === false) continue;
    if (typeof m.hold !== 'string' || !m.hold.trim()) { add('FAIL', '客观', 'mark.hold', `事件「${m.label}」写了 hold 但没写理由：故意保留要写成 hold: "<为什么>"，理由会进 review_log`, { t: m.start }); continue; }
    holds.push(m);
  }
  const EPS = 1 / sfps + 1e-6;
  for (const f of findings) {
    if (f.level !== 'LOOK' || f.t == null) continue;
    const to = f.to ?? f.t;
    const h = holds.find((m) => f.t >= m.start - EPS && to <= m.end + EPS);
    if (h) { f.level = 'HOLD'; f.hold = { label: h.label, reason: h.hold.trim() }; f.msg += `（故意保留：「${h.label}」${h.hold.trim()}）`; }
  }
}

// 页面报错按所有页面汇总（串行时它们都落在同一个页面上）
const pageErrors = pool.errors();
await pool.close(); await pix.close();
if (on('page') && pageErrors.length) add('FAIL', '客观', 'page.errors', `页面报错 ${pageErrors.length} 条：${pageErrors.slice(0, 3).join(' | ')}`);
cost.phases = { ...phases, total: Date.now() - tRun0 };
cost.parallel = { ...pool.info, pixelThreads: pix.size };

// ---------- 报告 ----------
const timeline = samples.map((s) => ({ t: s.t, edge: +s.edge.toFixed(4), moved: s.moved, dPrev: s.dPrev }));
writeFileSync(join(outDir, 'checks.json'), JSON.stringify({ film: F.slug, entry: F.entry, duration: D, sampleFps: sfps, laws, findings, cost, timeline, ...(kinetics ? { kinetics } : {}) }, null, 1));
writeMeta(join(outDir, 'checks.json'), { tool: 'check', dir: F.dir, entry: F.entry, extra: { duration: D, sampleFps: sfps, samples: samples.length } });   // 新鲜度（_fresh.mjs）：只供 review_log 提示，不影响结论
const order = ['FAIL', 'LOOK', 'HUMAN', 'HOLD', 'TODO', 'PASS', 'SKIP'];
for (const layer of ['客观', '本片法律', '疑点']) {
  const fs = findings.filter((f) => f.layer === layer).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  if (!fs.length) continue;
  console.log(`== ${layer} ==`);
  for (const f of fs) console.log(`  ${f.level.padEnd(5)} ${f.id.padEnd(22)} ${f.msg}${f.ev ? `\n        证据帧 ${f.ev}` : ''}`);
  console.log();
}
const fails = findings.filter((f) => f.level === 'FAIL').length, looks = findings.filter((f) => f.level === 'LOOK').length;
const holdN = findings.filter((f) => f.level === 'HOLD').length;
console.log(`FAIL ${fails}  LOOK ${looks}  HUMAN ${findings.filter((f) => f.level === 'HUMAN').length}${holdN ? `  HOLD ${holdN}` : ''}   → ${join(outDir, 'checks.json')}`);
console.log('LOOK / HUMAN 不是分数。去看证据帧和 stills.png，判断是本片意图还是失误，写进 review_log。');
process.exit(fails || (has('strict') && looks) ? 1 : 0);
