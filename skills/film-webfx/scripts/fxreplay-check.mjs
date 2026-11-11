#!/usr/bin/env node
// 帧间反馈（fxchain.js feedback）的重放等价门：缓存版在顺序 / 倒序 / 乱序下 vs "定义本身"（每个 t 都从第 0 步算）逐像素比。
//
//   node <film-webfx>/scripts/fxreplay-check.mjs --film <slug> [--entry x.html] [--format 9x16] [--samples 12 | --all]
//
// 为什么在 seamcheck 之外再设一道：seamcheck 门 2 只拿 8 个时刻打乱一次，比的是"缓存版和缓存版"——
// 两边用的是同一套检查点，检查点本身错了（存了引用、稀疏化删错、恢复后步号对不上）时两边可能错得一样。
// 这道门的参照是定义：页面加载前设 globalThis.FXCHAIN_NOCACHE = true，fxchain 不存检查点、每次 render 都从 init 走到 n(t)。
// 缓存版分三种顺序各开一个全新页面（顺序、倒序、按种子乱序），每张截图都和参照比。
//
// 退出码：0 一致（或页面没有反馈，门为空并明说）；1 有差异 / 页面报错；2 用法错误
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene, makeComparer, launchBrowser } from '../../film-core/lib/browser.mjs';
import { serve } from '../../film-core/lib/serve.mjs';
import { seeded } from '../../film-core/assets/runtime/rand.js';

const args = parseArgs({
  usage: 'node fxreplay-check.mjs --film <slug> [--entry x.html] [--format 9x16] [--samples 12 | --all]',
  about: '帧间反馈重放等价门：缓存版（顺序/倒序/乱序）vs 每次从第 0 步重算（FXCHAIN_NOCACHE）逐像素比。退出码 0 一致或没有反馈 / 1 有差异或页面报错 / 2 用法错',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    samples: ['<N>', '帧栅格上均匀取几个 t（默认 12，最少 3）'], all: '取全部帧（参照页每帧都从第 0 步算，慢）',
  },
});

const NOCACHE = () => { globalThis.FXCHAIN_NOCACHE = true; };
const stats = (S) => S.page.evaluate(() => (globalThis.__FXCHAIN__ ?? []).map((f) => f()));

await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const fps = F.config.fps;
  const { port, close: closeServer } = await serve(F.dir);
  const browser = await launchBrowser();
  try {
    const R = await openScene(F, format, { browser, port, initScripts: [NOCACHE] });
    const D = R.info.duration;
    const nFrames = Math.max(1, Math.floor(D * fps));
    const want = args.has('all') ? nFrames : Math.min(nFrames, Math.max(3, args.num('samples', 12)));
    const ts = [...new Set(Array.from({ length: want }, (_, i) => Math.round((i * (nFrames - 1)) / Math.max(1, want - 1)) / fps))];
    const st0 = await stats(R);
    console.log(`影片 ${F.slug}  入口 ${F.config.entry}  ${format}  ${D}s @ ${fps}fps  ${ts.length} 个时刻`);
    if (!st0.length) { console.log('— 页面里没有带 feedback 的 fxchain，本门没有可比的东西：通过但为空'); await R.close(); return; }
    console.log(`反馈 ${st0.flatMap((s) => Object.keys(s.feedback)).join(' / ')}`);
    const ref = new Map();
    for (const t of ts) ref.set(t, await R.shot(t));
    await R.close();

    const rnd = seeded(7);
    const shuffled = [...ts]; for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const orders = { 顺序: ts, 倒序: [...ts].reverse(), 乱序: shuffled };
    const cmp = await makeComparer(browser);
    let bad = 0;
    for (const [label, order] of Object.entries(orders)) {
      const A = await openScene(F, format, { browser, port });
      const fails = [];
      for (const t of order) {
        const r = await cmp.compare(await A.shot(t), ref.get(t));
        if (!r.identical) fails.push({ t, ...r });
      }
      const st = (await stats(A)).map((s) => Object.entries(s.feedback).map(([n, f]) => `${n}: 走 ${f.steps} 步、回退 ${f.restores} 次、检查点 ${f.checkpoints} 个`).join('；')).join('；');
      if (A.errors?.length) fails.push({ t: NaN, diff: 0, max: 0, err: A.errors.join(' | ') });
      await A.close();
      if (!fails.length) { console.log(`  ${label}  ✓ ${order.length}/${order.length} 与"从第 0 步算"逐像素一致（${st}）`); continue; }
      bad += fails.length;
      console.log(`  ${label}  ✗ ${fails.length}/${order.length} 不同（${st}）`);
      for (const f of fails.slice(0, 6)) console.log(f.err ? `    页面报错：${f.err}` : `    t=${f.t.toFixed(3)}s  ✗ ${f.diff} 像素不同，最大差 ${f.max}/255`);
    }
    await cmp.close();
    if (bad) fail('反馈的检查点 / 重放改变了画面：缓存版与"每次从第 0 步算"不同。'
      + '\n  常见原因：检查点存了引用而不是拷贝；step 读了每帧变化的东西（render 的 uniform、每帧上传的纹理、外部变量）；uniforms(k, s) 不是 k 的纯函数。');
    console.log('✓ 通过：检查点与重放在外部观测不到');
  } finally { await browser.close(); closeServer(); }
});
