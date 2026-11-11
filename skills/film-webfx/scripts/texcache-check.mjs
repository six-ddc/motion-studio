#!/usr/bin/env node
// 纹理"只传一次"缓存的等价门：缓存版 vs 每次都上传版，同一批 t 逐像素比。
//
//   node <film-webfx>/scripts/texcache-check.mjs --film <slug> [--entry x.html] [--format 9x16] [--samples 24 | --all]
//
// 为什么要单独一道门：webfx.js 的 texture(name, src, { static:true } / { key }) 命中缓存就不再上传。
// 缓存键漏掉了内容变化（源 canvas 按 t 重画了、却没 bump key）时，纹理冻结在第一次上传那一刻——
// 这是"冻结"而不是"累积"，同一个页面里每次都冻在同一处，所以 seamcheck 的门 1a / 1b / 2 全绿
// （实测阴性对照 scene-stale：三门全过）。只有和"不缓存"那条路比才看得见：契约 §2 说缓存允许、前提是外部观测不到差别，
// 这道门就是把"观测不到差别"直接测出来。
//
// 做法：两个全新页面，一个照常，一个在加载前设 globalThis.WEBFX_NOCACHE = true（webfx.js 读它，所有缓存纹理改回每次上传）；
// 都按时间顺序 seek 同一批 t（帧栅格上均匀取 --samples 个，--all 取全部帧），逐像素比截图。
// 两边都包一层 texImage2D 计上传次数：次数相同说明这支片根本没用缓存，门是空的，会明说。
//
// 退出码：0 一致（或没用缓存）；1 有差异 / 页面报错；2 用法错误
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene, makeComparer, launchBrowser, filmBackend } from '../../film-core/lib/browser.mjs';
import { serve } from '../../film-core/lib/serve.mjs';

const args = parseArgs({
  usage: 'node texcache-check.mjs --film <slug> [--entry x.html] [--format 9x16] [--samples 24 | --all]',
  about: '纹理"只传一次"缓存的等价门：缓存版 vs 不缓存版（WEBFX_NOCACHE）同一批 t 逐像素比。退出码 0 一致或没用缓存 / 1 有差异或页面报错 / 2 用法错',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    samples: ['<N>', '帧栅格上均匀取几个 t（默认 24，最少 2）'], all: '取全部帧',
  },
});

// 加载前注入：计 texImage2D 次数（不改行为）
const COUNT = () => {
  window.__texUploads = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const orig = C.prototype.texImage2D;
    C.prototype.texImage2D = function (...a) { window.__texUploads++; return orig.apply(this, a); };
  }
};
const NOCACHE = () => { globalThis.WEBFX_NOCACHE = true; };

await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const fps = F.config.fps;
  const { port, close: closeServer } = await serve(F.dir);
  const browser = await launchBrowser({ backend: filmBackend(F) });
  try {
    const A = await openScene(F, format, { browser, port, initScripts: [COUNT] });
    const B = await openScene(F, format, { browser, port, initScripts: [COUNT, NOCACHE] });
    const D = A.info.duration;
    const nFrames = Math.max(1, Math.floor(D * fps));
    const want = args.has('all') ? nFrames : Math.min(nFrames, Math.max(2, args.num('samples', 24)));
    const ts = [...new Set(Array.from({ length: want }, (_, i) => Math.round((i * (nFrames - 1)) / Math.max(1, want - 1)) / fps))];
    console.log(`影片 ${F.slug}  入口 ${F.config.entry}  ${format}  ${D}s @ ${fps}fps  按时间顺序 ${ts.length} 个时刻`);
    const up0 = [await A.page.evaluate(() => window.__texUploads), await B.page.evaluate(() => window.__texUploads)];
    const cmp = await makeComparer(browser);
    const bad = [];
    for (const t of ts) {
      const r = await cmp.compare(await A.shot(t), await B.shot(t));
      if (!r.identical) bad.push({ t, ...r });
    }
    const up = [(await A.page.evaluate(() => window.__texUploads)) - up0[0], (await B.page.evaluate(() => window.__texUploads)) - up0[1]];
    console.log(`texImage2D 次数（seek 期间）：缓存版 ${up[0]}，每次上传版 ${up[1]}（加载期另有 ${up0[0]} / ${up0[1]}）`);
    await cmp.close(); await A.close(); await B.close();
    if (up[0] === up[1] && up0[0] === up0[1]) {
      console.log('— 这支片没有命中过纹理缓存（两边上传次数相同），本门没有可比的东西：通过但为空');
      return;
    }
    if (!bad.length) { console.log(`✓ ${ts.length}/${ts.length} 个时刻逐像素一致：缓存在外部观测不到`); return; }
    for (const b of bad.slice(0, 12)) console.log(`  t=${b.t.toFixed(3)}s  ✗ ${b.diff} 像素不同，最大差 ${b.max}/255`);
    if (bad.length > 12) console.log(`  …另有 ${bad.length - 12} 个时刻`);
    fail(`纹理缓存改变了画面：${bad.length}/${ts.length} 个时刻与"每次都上传"不同（${bad[0].t.toFixed(3)}s 起）。`
      + `\n  某个 texture(..., { static:true } 或 { key }) 的源在加载后内容还在变，而 key 没跟着变。`
      + `\n  内容随 t 变的源去掉 static/key（每帧上传）；内容只在少数时刻变的，key 取自"内容由什么决定"（例如那一段的编号），不要取自 t 的分桶。`);
  } finally { await browser.close(); closeServer(); }
});
