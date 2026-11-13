#!/usr/bin/env node
// 确定性验收门。在 canvas（截图像素）层面比对，不经编码器，所以没有 H.264 残差噪声。
//
//   node <film-core>/scripts/seamcheck.mjs --film <slug> [--format 9x16] [--samples 8] [--loop|--no-loop]
//
// 门 1  同 t 可重复
//       1a 同一页面里同一个 t 求两次，像素一致            → 抓 seek 里读时钟/Math.random、跨调用累积
//       1b 换一个全新页面（重新加载）求同一批 t，像素一致  → 抓"加载时"的 Math.random / Date.now
//          （1a 抓不到它：同一页面里那个随机值一直不变，两次当然相同 —— 但下一次渲染就变了）
// 门 2  乱序求值：顺序扫一遍 vs 按种子打乱的顺序扫一遍，逐像素一致 → 证明没有跨帧状态
// 门 3  循环接缝（film.json loop:true 或 --loop 时才判，否则只报告）
//       3a frame(DURATION) ≡ frame(0)
//       3b 跨缝跳变：frame(D-1/fps)→frame(0) 的差异不超过相邻帧典型差异的 4 倍（+ 0.1% 像素容差）
//          → 抓"首尾数值相等、但速度不连续"的假循环（例如 wrap 之后末端仍在快速运动）
// 门 4（--parallel N 时）：全片逐帧（帧栅格、sub=1）顺序截一遍，再在 N 个页面里并发、倒序交错截一遍，
//       逐帧比 md5 → render.mjs 并行渲染的前提。成本 = 2 × 全片帧数次截图。
//       顺序那一遍也分给 N 个页面：页面 i 截连续一段 [a_i, b_i)，截之前先在同一页面里**不截图**地顺序 seek 0…a_i−1，
//       所以每个被截的帧前面的求值历史与"1 个页面从头顺序截到尾"逐次相同（理由见门 4 的代码注释）。
// 门 5（--relaunch N 时）：跨启动。按 render.mjs 的拓扑（多浏览器 × 多页面、1 秒分片）全新启动浏览器逐帧截，比 md5，
//       并和上一次 render 的逐帧清单对账。清单能对账时它本身算一次独立启动，只新跑 N−1 遍；渲染参数
//       （fps、sub、shutter、PNG 模式、自适应子帧）以清单为准。门 1–4 都在同一个浏览器进程里，看不见跨启动的差异。
//       --scale 0.5 / --every k 降成本。不是默认门，定稿前跑。
// 另：探针统计 seek 期间对 Math.random / Date.now / performance.now / new Date() / setTimeout /
//     setInterval / requestAnimationFrame 的调用。默认是硬失败（契约第 2 节禁止它们），
//     --probe-warn 降为警告（第三方库在 seek 里读 performance.now 做统计但不影响像素时用，自己说明理由）。
//
// 退出码：0 全过；1 有门没过或页面报错；2 用法错误
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../lib/film.mjs';
import { openScene, makeComparer, launchBrowser, scaledSize, rendererFingerprint, pngModeOf, filmBackend, backendMismatch } from '../lib/browser.mjs';
import { frameShooter, inputsFingerprint } from '../lib/frames.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FORMATS } from '../assets/runtime/layout.js';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { seeded } from '../assets/runtime/rand.js';
import { serve } from '../lib/serve.mjs';

const args = parseArgs({
  usage: 'node seamcheck.mjs --film <slug> [选项]',
  about: '确定性验收门（canvas 像素层）：同 t 可重复 / 乱序一致 / 循环接缝；可选门 4（--parallel）、门 5（--relaunch）。退出码 0 全过 / 1 有门没过 / 2 用法错',
  opts: {
    ...FILM_OPTS,
    entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅'], fps: ['<N>', '帧率'], sub: ['<N>', '子帧数（门 5 无清单时用）'],
    samples: ['<N>', '门 1/2 采样数（默认 8，最少 4）'], loop: '按循环片判门 3', 'no-loop': '不按循环片判门 3',
    'probe-warn': '时钟/随机探针命中只警告不失败', parallel: ['<N>', '门 4：N 个页面并发逐帧比对'],
    relaunch: ['<N>', '门 5：启动 N 次浏览器逐帧比对（≥2）'], scale: ['<k>', '门 5 缩放'], every: ['<k>', '门 5 每 k 帧取一帧'],
    workers: ['<W>', '门 5 并行页面数'], 'pages-per-browser': ['<P>', '门 5 每浏览器页面数'],
  },
});

await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const fps = args.num('fps', F.config.fps);
  const nSamples = Math.max(4, args.num('samples', 8));
  const loop = args.has('loop') ? true : args.has('no-loop') ? false : F.config.loop;
  const probeWarn = args.has('probe-warn');
  const parallel = args.num('parallel', 0);
  const relaunch = args.num('relaunch', 0);
  const every = args.num('every', 1);
  const scale = args.num('scale', 1);
  const workers = args.num('workers', Math.max(1, Math.min(16, Math.floor(cpus().length / 2))));
  const perBrowser = args.num('pages-per-browser', 2);
  if (relaunch && !(Number.isInteger(relaunch) && relaunch >= 2)) fail(`--relaunch 需要 ≥2 的整数（启动几次浏览器来比），收到 ${relaunch}`);
  if (!(Number.isInteger(every) && every >= 1)) fail(`--every 必须是 ≥1 的整数，收到 ${every}`);
  if (scale !== 1 && !relaunch) fail('--scale 只用于门 5（--relaunch）；门 1–4 永远在全分辨率比');
  if (relaunch) scaledSize(FORMATS[format] ?? fail(`未知画幅 ${format}`), scale);

  const srv = await serve(F.dir);
  const { port, close: closeServer } = srv;
  const browser = await launchBrowser({ backend: filmBackend(F) });   // 与 render.mjs 同一套启动参数（含 film.json backend），像素才可比
  const cmp = await makeComparer(browser);
  let bad = 0;
  const allErrors = [];
  const verdict = (ok, label) => { if (!ok) bad++; return ok ? `✓ ${label}` : `✗ ${label}`; };
  const fmtDiff = (r) => (r.identical ? '逐像素一致' : `${r.diff} 像素不同，最大差 ${r.max}/255`);

  try {
    const A = await openScene(F, format, { browser, port, probe: true, fps });
    const D = A.info.duration;
    const frames = Math.round(D * fps);
    const lastT = (frames - 1) / fps;
    // 采样时刻：落在帧栅格上，含首尾，避开整数秒的巧合
    const times = Array.from({ length: nSamples }, (_, i) => Math.round((i / (nSamples - 1)) * (frames - 1)) / fps);
    console.log(`影片 ${F.slug}  入口 ${F.config.entry}  ${format} ${A.width}×${A.height}  ${D}s @ ${fps}fps  采样 ${times.length} 个时刻  loop=${loop}`);
    console.log();
    // 字体来得晚的基线：初次就绪之后各 FontFace 的状态。门 1a/2 失败时拿来区分"字体在 seek 期间才加载"
    // 和"读了时钟/有跨帧状态"——两者在像素上一样（第一次画到某个分片的那一帧用回退字体），提示语却该不同。
    await A.page.evaluate(() => { window.__seamFonts = new Map([...document.fonts].map((f) => [f, f.status])); });
    const lateFonts = () => A.page.evaluate(() => [...document.fonts]
      .filter((f) => { const was = window.__seamFonts.get(f); return (was === undefined || was === 'unloaded') && f.status !== 'unloaded'; })
      .map((f) => `"${f.family.replace(/^['"]|['"]$/g, '')}"${f.unicodeRange && f.unicodeRange !== 'U+0-10FFFF' ? ` ${f.unicodeRange.length > 40 ? f.unicodeRange.slice(0, 40) + '…' : f.unicodeRange}` : ''}`));

    // ---- 门 1a ----
    console.log('门 1a  同一页面，同一个 t 求两次：');
    const ref = new Map();
    let ok1a = true;
    for (const t of times) {
      const a = await A.shot(t);
      const b = await A.shot(t);
      const r = await cmp.compare(a, b);
      ref.set(t, a);
      if (!r.identical) ok1a = false;
      console.log(`  t=${t.toFixed(3)}s  ${r.identical ? '✓' : '✗'} ${fmtDiff(r)}`);
    }
    console.log(`  ${verdict(ok1a, ok1a ? '通过' : 'seek 不可重复：读了时钟/Math.random，或每次调用都在累积状态')}`);

    // ---- 门 2：乱序 ----
    console.log();
    console.log('门 2  乱序求值（按种子 7 打乱后再扫一遍，和顺序结果逐像素比）：');
    const rnd = seeded(7);
    const shuffled = [...times].sort(() => rnd() - 0.5);
    // 确保每个时刻前面紧挨的都是不同的时刻（否则就退化成门 1a）
    let ok2 = true;
    for (const t of shuffled) {
      const r = await cmp.compare(ref.get(t), await A.shot(t));
      if (!r.identical) ok2 = false;
      console.log(`  t=${t.toFixed(3)}s  ${r.identical ? '✓' : '✗'} ${fmtDiff(r)}`);
    }
    console.log(`  ${verdict(ok2, ok2 ? '通过' : '结果依赖求值顺序：存在跨帧状态（上一帧的变量影响了这一帧）')}`);
    if (!ok1a || !ok2) {
      const late = await lateFonts();
      if (late.length) console.log(`  ⚠ 上面的不一致多半不是时钟/跨帧状态：${late.length} 个 FontFace 是 seek 期间才开始加载的（初次就绪之后）：${late.slice(0, 3).join('；')}${late.length > 3 ? '…' : ''}。\n    第一次画到这些字的那一帧用回退字体画。点名是哪些字：film-core 的 scripts/font_source.mjs --film ${F.slug}；修法是把它们列进 loadFonts（运行时拼的数字可按类声明，参见 film-typography）`);
    }

    // ---- 门 3：循环接缝 ----
    console.log();
    console.log(`门 3  循环接缝${loop ? '' : '（film.json 未声明 loop，只报告不判）'}：`);
    const f0 = await A.shot(0);
    const fD = await A.shot(D);
    const r3a = await cmp.compare(f0, fD);
    const fLast = await A.shot(lastT);
    const seam = await cmp.compare(fLast, f0);
    // 相邻帧典型差异：片尾两对 + 片头两对，取中位数
    const neigh = [];
    for (const [x, y] of [[lastT - 2 / fps, lastT - 1 / fps], [lastT - 1 / fps, lastT], [0, 1 / fps], [1 / fps, 2 / fps]]) {
      neigh.push((await cmp.compare(await A.shot(Math.max(0, x)), await A.shot(y))).diff);
    }
    neigh.sort((p, q) => p - q);
    const typical = (neigh[1] + neigh[2]) / 2;
    const allowance = Math.max(typical * 4, A.width * A.height * 0.001);
    const ok3a = r3a.identical;
    const ok3b = seam.diff <= allowance;
    console.log(`  3a frame(0) vs frame(${D}): ${fmtDiff(r3a)}`);
    console.log(`  3b 跨缝 frame(${lastT.toFixed(3)})→frame(0): ${seam.diff} 像素变化；相邻帧典型 ${typical} 像素；容差 ${Math.round(allowance)}`);
    if (loop) {
      console.log(`  ${verdict(ok3a && ok3b, ok3a && ok3b ? '通过：首尾一致且跨缝无跳变'
        : !ok3a ? '首尾不一致，循环会跳' : '首尾相等但跨缝跳变远大于相邻帧：速度不连续，循环会顿')}`);
    } else {
      console.log(`  — 未判（${ok3a && ok3b ? '实际上满足循环条件' : '不满足循环条件，非循环片无所谓'}）`);
    }

    // ---- 探针 ----
    const calls = await A.probeCalls();
    const hasMotion = await A.page.evaluate(() => typeof window.MOTION === 'function');
    allErrors.push(...A.errors);
    await A.close();

    // ---- 门 1b：重新加载 ----
    console.log();
    console.log('门 1b  全新页面重新加载，同一批 t 再求一次：');
    const B = await openScene(F, format, { browser, port, probe: false, fps });
    let ok1b = true;
    for (const t of times) {
      const r = await cmp.compare(ref.get(t), await B.shot(t));
      if (!r.identical) ok1b = false;
      console.log(`  t=${t.toFixed(3)}s  ${r.identical ? '✓' : '✗'} ${fmtDiff(r)}`);
    }
    allErrors.push(...B.errors);
    await B.close();
    console.log(`  ${verdict(ok1b, ok1b ? '通过' : '两次加载结果不同：加载阶段用了 Math.random / 时钟 / 未等待的异步资源（字体、图片）')}`);

    // ---- 门 4：并行 ----
    if (parallel > 1) {
      console.log();
      console.log(`门 4  并行：全片 ${frames} 帧，顺序（${Math.min(parallel, frames)} 页分段、段前补齐顺序历史）vs ${parallel} 个页面并发倒序交错：`);
      const md5 = (b) => createHash('md5').update(b).digest('hex');
      // 顺序那一遍：N 个页面各截一段连续区间，段内顺序截。段首之前的历史用 advance() 补齐——
      // 页面 i 先按 0, 1/fps, …, (a_i−1)/fps 顺序 seek（页面里执行的东西与 shot 逐字相同，只是不截图），再截 [a_i, b_i)。
      // 于是每个被截的帧 k 之前，这个页面上发生过的 seek 序列恰好是 0…k−1，与改动前"1 个页面从头截到尾"相同。
      // 只重叠一小段（例如 1 秒）不够：依赖"这个页面已经求值过多少帧"的泄漏（容量满了才开始淘汰的缓存、
      // 只在连续顺序调用很久之后才偏的增量积分）在每段都只有 1/N 片长的历史时不出现，而单页顺序那一遍里会出现。
      // 补齐历史的代价是 seek + 一次 evaluate 往返（weiqi2-l1 约 5 ms），截图是 30–190 ms。
      // 截图本身不碰页面状态（CDP 在页面外取合成结果），所以"seek 了但没截"和"seek 了也截了"对场景是同一段历史。
      const nSeg = Math.min(parallel, frames);
      const bounds = Array.from({ length: nSeg + 1 }, (_, i) => Math.round((i * frames) / nSeg));
      const seq = new Array(frames);
      const qs = [];
      for (let w = 0; w < nSeg; w++) qs.push(await openScene(F, format, { browser, port, fps }));
      await Promise.all(qs.map(async (S, w) => {
        for (let k = 0; k < bounds[w]; k++) await S.advance(k / fps);
        for (let k = bounds[w]; k < bounds[w + 1]; k++) seq[k] = md5(await S.shot(k / fps));
      }));
      for (const S of qs) { allErrors.push(...S.errors); await S.close(); }
      const ps = [];
      for (let w = 0; w < parallel; w++) ps.push(await openScene(F, format, { browser, port, fps }));
      const par = new Array(frames);
      await Promise.all(ps.map(async (S, w) => { for (let k = frames - 1 - w; k >= 0; k -= parallel) par[k] = md5(await S.shot(k / fps)); }));
      for (const S of ps) { allErrors.push(...S.errors); await S.close(); }
      const diff = seq.map((h, k) => (h !== par[k] ? k : -1)).filter((k) => k >= 0);
      if (diff.length) console.log(`  不同的帧：${diff.slice(0, 12).map((k) => (k / fps).toFixed(3) + 's').join(' ')}${diff.length > 12 ? ' …' : ''}`);
      console.log(`  ${verdict(!diff.length, !diff.length ? `通过：${frames} 帧 0 帧不同` : `${diff.length}/${frames} 帧不同 —— 不能并行渲染（用 render --workers 1，并查 references/nondeterminism.md）`)}`);
    }

    // ---- 门 5：跨启动 ----
    if (relaunch > 1) {
      console.log();
      const r5 = await relaunchGate(F, format, { port, srv, fps, D, hasMotion, runs: relaunch, every, scale, workers, perBrowser,
        sub: args.num('sub', F.config.sub), shutter: F.config.shutter, fp: await rendererFingerprint(browser), cmp,
        explicit: { fps: args.flag('fps', null) != null, sub: args.flag('sub', null) != null } });
      allErrors.push(...r5.errors);
      verdict(r5.ok, '');
    }

    console.log();
    console.log('探针  seek 期间调用的禁用 API：');
    const names = Object.keys(calls);
    if (!names.length) console.log('  ✓ 无');
    else {
      for (const n of names) console.log(`  ${probeWarn ? '⚠' : '✗'} ${n} ×${calls[n]}`);
      if (!probeWarn) { bad++; console.log('  ✗ 契约第 2 节禁止在 seek 里调用这些（--probe-warn 可降为警告，需自己说明理由）'); }
    }
  } finally {
    await cmp.close();
    await browser.close();
    closeServer();
  }

  console.log();
  if (allErrors.length) {
    console.log(`✗ 页面报了 ${allErrors.length} 条错误：`);
    allErrors.slice(0, 8).forEach((e) => console.log('  ' + e));
  }
  if (bad === 0 && allErrors.length === 0) console.log('全部通过');
  else { process.stderr.write(`✗ seamcheck 未通过：${bad} 项不合格${allErrors.length ? `，${allErrors.length} 条页面错误` : ''}\n`); process.exit(1); }
});

// 门 5：跨启动。门 1–4 全在**同一个浏览器进程**里，跨进程、跨启动的差异它们结构上看不见
// （实测见过两种：旧版 headless shell 偶发从第二帧起整屏纯白；完整 Chrome 一次整片渲染里某个 worker 的
// 3 个分片与其余各次不同）。这道门按 render.mjs 的拓扑全新启动浏览器——多浏览器 × 多页面、
// 按 1 秒分片动态领活——逐帧截图算帧哈希。只截不编码。
//
// 和**上一次 render.mjs 的逐帧哈希清单**对账（out/.render/<format>[@<scale>x].frames.json）是这道门的检出力所在：
// 渲染进程里出的事，事后另起进程重跑多少遍都是好的（实测：旧版 headless shell 新装后第一次启动截出纯白，
// 第二次起正常；那次两遍彼此完全一致）。
//
// 对账的规则：
// - **渲染参数以清单为准**：fps、sub、shutter、PNG 编码模式（key.png，没有 = default）、自适应子帧（key.adapt）
//   全取清单，帧哈希用 render 同一份 lib/frames.mjs 算。旧版从 film.json 读 shutter（没写 = 1），
//   清单记的是 0.5 的片子（weiqi2-l1 等）因此永远落进"设置不同，不对账"，门是绿的，对账从没发生过。
// - 清单本身就是**一次独立启动**的结果（render 全新启动浏览器、同一拓扑），所以能对账时 --relaunch N 只新跑 N−1 遍。
// - 判定只看像素：新跑的帧与清单逐帧相同 = 通过——这时不管输入指纹变没变，成片都与当前场景对得上，两次启动也一致。
//   不同 = 不通过；这时再全新启动一遍（若还没跑够两遍），用清单里的输入指纹（inputs）分清三种情况：
//   这几遍彼此不同（跨启动不确定）/ 彼此相同且输入没变（那次渲染坏了）/ 彼此相同但输入改过（成片过期）。
//   旧清单没有指纹：说"分不清是渲坏了还是过期了"，结论都是重渲——不误报成"渲坏了"，也不把差异放过去。
// - 对不了账（没有清单、入口不同、时长变了、区间渲染、浏览器构建不同）：退回只验跨启动，新跑 N 遍彼此比，并说清为什么没对账。
async function relaunchGate(F, format, { port, srv, fps, D, hasMotion, runs, every, scale, workers, perBrowser, sub, shutter, fp, cmp, explicit }) {
  const mf = join(F.out, '.render', scale !== 1 ? `${format}@${scale}x.frames.json` : `${format}.frames.json`);
  const mrel = mf.slice(F.dir.length + 1);
  let m = null;
  try { if (existsSync(mf)) m = JSON.parse(readFileSync(mf, 'utf8')); } catch {}
  const k = m?.key;
  const ds = (n, f) => `${n} 帧 / ${(n / f).toFixed(3)}s`;
  let why = null, hint = null;
  if (!k) why = `没有 ${mrel}`;
  else if (!(Number.isInteger(k.fps) && k.fps > 0 && Number.isInteger(k.sub) && k.sub >= 1 && k.shutter > 0 && Number.isInteger(k.frames))) why = `${mrel} 的 key 不完整（${JSON.stringify(k)}）`;
  else if (k.entry !== F.config.entry) why = `入口不同（清单 ${k.entry}，现在 ${F.config.entry}）`;
  else if (k.from !== 0) why = `那次是区间渲染（从 ${k.from}s 起 ${k.frames} 帧），不是整片`;
  else if (k.frames !== Math.round(D * k.fps)) {
    // 帧数不同是最常见的一种"对不上"，而且原因通常不是参数：旁白重录了、时长回写了。单独说清楚
    const now = Math.round(D * k.fps);
    why = `时长变了（那次 ${ds(k.frames, k.fps)} → 现在 ${ds(now, k.fps)}，差 ${((now - k.frames) / k.fps).toFixed(3)}s）`;
    hint = '—— 不是参数传错。常见原因是旁白重录后 film.json 的时长回写了；out/ 里那条成片按旧时间轴渲的，已经过期，重渲一次再对账';
  }
  else if (m.renderer?.chromium !== fp.chromium) why = `浏览器构建不同（${m.renderer?.chromium} vs ${fp.chromium}），PNG 字节不可比`;
  else if (backendMismatch(m.renderer, fp)) why = `${backendMismatch(m.renderer, fp)}，像素不可比`;
  else if (k.adapt && !hasMotion) why = '清单是按自适应子帧（window.MOTION）渲的，现在的场景没有 MOTION';
  else if (!Array.isArray(m.hashes) || m.hashes.length !== k.frames) why = `${mrel} 的 hashes 有 ${m.hashes?.length} 个，key.frames 是 ${k.frames}`;
  const recon = !why;
  // 渲染参数：能对账就全取清单；不能就按命令行 / film.json（与旧版相同），PNG 用 fast（没有要对的旧字节）
  const P = recon
    ? { fps: k.fps, sub: k.sub, shutter: k.shutter, png: pngModeOf(k), adapt: k.adapt ?? null }
    : { fps, sub, shutter, png: 'fast', adapt: null };
  const frames = recon ? k.frames : Math.round(D * fps);
  const newRuns = recon ? runs - 1 : runs;

  const keep = new Map(); let kept = 0; const CAP = 256 << 20;
  const dumpDir = join(F.out, '.render', 'relaunch');
  const ks = [];
  for (let i = 0; i < frames; i += every) ks.push(i);
  const chunk = Math.max(1, Math.round(P.fps / every));
  const chunks = [];
  for (let i = 0; i < ks.length; i += chunk) chunks.push(ks.slice(i, i + chunk));
  const nW = Math.min(workers, chunks.length);
  const nB = Math.ceil(nW / perBrowser);
  const pset = `fps ${P.fps} / ${P.adapt ? `自适应子帧 ${P.adapt.subMin}–${P.adapt.subMax}` : `sub ${P.sub}`} / shutter ${P.shutter} / PNG ${P.png}`;
  console.log(`门 5  跨启动：每遍全新启动 ${nB} 个浏览器 × ${nW} 个页面，${ks.length} 帧${every > 1 ? `（每 ${every} 帧取 1）` : ''}，${pset}${scale !== 1 ? `，截图缩到 ${scale}x` : ''}`);
  if (recon) {
    console.log(`  对账基线 ${mrel}：渲染参数取自清单；清单本身算 1 遍独立启动，新跑 ${newRuns} 遍`);
    const notes = [];
    if (explicit.fps && fps !== k.fps) notes.push(`命令行 --fps ${fps}`);
    if (explicit.sub && sub !== k.sub) notes.push(`命令行 --sub ${sub}`);
    if (shutter !== k.shutter) notes.push(`film.json shutter ${shutter}${F.raw.shutter == null ? '（没写，默认）' : ''}`);
    if (notes.length) console.log(`  （${notes.join('、')} 与清单不同：门 5 按清单记的那次渲染来截）`);
  } else {
    console.log(`  上次渲染清单：${why}，不对账，只验跨启动（新跑 ${newRuns} 遍彼此比）`);
    if (hint) console.log(`    ${hint}`);
  }

  const errors = [];
  const all = [];
  const shoot = frameShooter({ fps: P.fps, sub: P.sub, shutter: P.shutter, adapt: P.adapt });
  const runOnce = async (r) => {
    const t0 = Date.now(); // 只用于打印耗时
    const browsers = await Promise.all(Array.from({ length: nB }, () => launchBrowser({ backend: filmBackend(F) })));
    const hashes = new Map();
    const odd = [];
    try {
      const pages = [];
      for (let w = 0; w < nW; w++) pages.push(await openScene(F, format, { browser: browsers[w % nB], port, scale, png: P.png, fps: P.fps }));
      let next = 0;
      await Promise.all(pages.map(async (S) => {
        while (next < chunks.length) {
          for (const kk of chunks[next++]) {
            const { pngs, hash } = await shoot(S, kk);
            hashes.set(kk, hash);
            if (r === 0 && kept + pngs[0].length <= CAP) { keep.set(kk, pngs[0]); kept += pngs[0].length; }
            else if (r > 0 && hash !== all[0].get(kk) && (odd.length < 3)) odd.push([kk, pngs[0]]);
          }
        }
      }));
      for (const S of pages) { errors.push(...S.errors); await S.close(); }
    } finally {
      await Promise.all(browsers.map((b) => b.close()));
    }
    all.push(hashes);
    const diff = r === 0 ? [] : ks.filter((x) => hashes.get(x) !== all[0].get(x));
    const sp = spans(diff, P.fps, every);
    const where = diff.length ? ` → ${sp.slice(0, 6).join(', ')}${sp.length > 6 ? ' …' : ''}` : '';
    console.log(`  第 ${r + 1} 遍  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${r === 0 ? '基准' : diff.length ? `✗ ${diff.length}/${ks.length} 帧与第 1 遍不同${where}` : '✓ 与第 1 遍逐帧相同'}`);
    hashes.diff = diff.length;
    for (const [x, png] of odd.sort((a, b) => a[0] - b[0])) {
      const base = keep.get(x);
      if (!base) { console.log(`    t=${(x / P.fps).toFixed(3)}s：第 1 遍的帧没留（超过 256 MB 上限），说不出幅度`); continue; }
      mkdirSync(dumpDir, { recursive: true });
      const tag = (x / P.fps).toFixed(3);
      writeFileSync(join(dumpDir, `t${tag}-run1.png`), base);
      writeFileSync(join(dumpDir, `t${tag}-run${r + 1}.png`), png);
      const d = await cmp.compare(base, png);
      console.log(`    t=${tag}s（第一个子帧）：${d.identical ? '这一子帧相同，差在后面的子帧' : `${d.diff} 像素不同（${(d.diff / d.total * 100).toFixed(2)}%），最大差 ${d.max}/255`}  → ${join('out/.render/relaunch', `t${tag}-run{1,${r + 1}}.png`)}`);
    }
  };
  for (let r = 0; r < newRuns; r++) await runOnce(r);

  const runsOk = () => all.every((h) => !h.diff);
  if (!recon) {
    const ok = runsOk();
    console.log(`  ${ok ? '✓ 通过（只验了跨启动一致；没和渲染清单对账，见上）' : '✗ 不同启动渲出不同的帧：结果取决于这次启动的浏览器状态，不只取决于 t（排查见 references/nondeterminism.md「门 5」）'}`);
    return { ok, errors };
  }
  const diff = ks.filter((x) => m.hashes[x] !== all[0].get(x));
  const sp = spans(diff, P.fps, every);
  console.log(`  上次渲染清单 vs 第 1 遍：${diff.length ? `✗ ${diff.length}/${ks.length} 帧不同 → ${sp.slice(0, 6).join(', ')}${sp.length > 6 ? ' …' : ''}` : `✓ ${ks.length} 帧逐帧相同`}`);
  // 输入指纹按"实际加载的运行时"算（lib/frames.mjs）：deliver 冻结之后，同一份字节从片内加载，指纹不变
  const stale = m.inputs ? m.inputs !== inputsFingerprint(F.dir, Array.isArray(m.runtime) ? srv.loaded() : null) : null;   // null = 旧清单没有指纹
  if (!diff.length) {
    if (runsOk() && stale) console.log('  （清单之后片子目录里的输入改过，但逐帧像素不变：成片仍与当前场景一致）');
    const ok = runsOk();
    console.log(`  ${ok ? '✓ 通过' : '✗ 不同启动渲出不同的帧：结果取决于这次启动的浏览器状态，不只取决于 t（排查见 references/nondeterminism.md「门 5」）'}`);
    return { ok, errors };
  }
  // 不一致：只有一遍新跑时再全新启动一遍，分清是哪一边的问题（只在失败时多付这一遍）
  if (all.length < 2) {
    console.log('  和清单对不上：再全新启动一遍，分清是这次启动的问题还是那次渲染的问题');
    await runOnce(all.length);
  }
  console.log(`  ✗ ${!runsOk() ? '不同启动渲出不同的帧：结果取决于这次启动的浏览器状态，不只取决于 t（排查见 references/nondeterminism.md「门 5」）'
    : stale === false ? '这几遍彼此一致、输入自那次渲染以来没变，却和那次渲染不一致：问题出在那次渲染的进程里，成片不可信，重渲后再跑一次门 5'
      : stale === true ? '和那次渲染不一致，而清单之后片子的输入（场景/运行时/素材/narration/film.json）改过：out/ 里的成片已过期，重渲后再跑一次门 5'
        : '和那次渲染不一致。清单是旧版 render 写的，没有输入指纹，分不清是那次渲染坏了还是之后改过输入——两种都要重渲，重渲后再跑一次门 5'}`);
  return { ok: false, errors };
}

function spans(ks, fps, every) {
  const out = [];
  for (let i = 0; i < ks.length; i++) {
    let j = i;
    while (j + 1 < ks.length && ks[j + 1] === ks[j] + every) j++;
    out.push(`${(ks[i] / fps).toFixed(2)}–${((ks[j] + 1) / fps).toFixed(2)}s`);
    i = j;
  }
  return out;
}
