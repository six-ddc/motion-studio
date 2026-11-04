#!/usr/bin/env node
// 字体文件大小对渲染启动的影响：每个字体文件开一个新页面，测
//   load   = FontFace.load() 完成（下载 + 解析 + 校验）
//   first  = 第一次 fillText 一段中文完成
// 各跑 --runs 次，取中位数。本地回环服务器，不含网络时间（渲染机就是这个情况）。
//
//   node dev/film-typography/fontcost.mjs <font1> [font2 ...] [--runs 5] [--text "…"]   （开发基准，不随 skill 安装）
import { statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { serve } from '../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

cli({
  usage: 'node fontcost.mjs <font1> [font2 ...] [--runs 5] [--text "…"]',
  about: '字体文件大小对渲染启动的影响：每个字体开新页面测 FontFace.load() 与首次 fillText 耗时，取中位数。只读。',
  positional: '<字体文件...>',
  positionalHelp: '要测的字体文件（相对 cwd）',
  opts: { runs: ['<N>', '每个文件跑几次（默认 5）'], text: ['<文字>', '首次 fillText 的文字'] },
});
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!files.length) { process.stderr.write('fontcost: 至少给一个字体文件\n'); process.exit(2); }
const runs = Number(flag('runs', 5));
const text = flag('text', '画面必须是时间的纯函数。字距不能丢，前缀测量保住字距。');
// 每个字体文件所在目录挂一个前缀；?i 让每次都是新 URL（不吃浏览器缓存）
const dirs = [...new Set(files.map((f) => dirname(resolve(f))))];
const mounts = Object.fromEntries(dirs.map((d, k) => [`/f${k}/`, d]));
const urlOf = (f) => `/f${dirs.indexOf(dirname(resolve(f)))}/${encodeURIComponent(basename(f))}`;
const server = await serve(process.cwd(), { runtime: false, mounts,
  routes: { '/': '<!doctype html><canvas id=c width=1080 height=200></canvas>' } });
const base = server.url;
const browser = await launchBrowser();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

console.log(`${'文件'.padEnd(40)} ${'大小'.padStart(9)}   load 中位   first 中位   (ms, ${runs} 次)`);
for (const f of files) {
  const url = urlOf(f);
  const L = [], F = [];
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage();
    await page.goto(base + '/');
    const r = await page.evaluate(async ({ text, i, url }) => {
      const t0 = performance.now();               // 这是测量工具，不是影片运行时
      const face = new FontFace('Cost', `url(${url}?${i})`);
      await face.load(); document.fonts.add(face);
      const t1 = performance.now();
      const ctx = document.getElementById('c').getContext('2d');
      ctx.font = '48px Cost'; ctx.fillText(text, 10, 100);
      ctx.getImageData(0, 0, 1, 1);               // 强制光栅化完成
      return { load: t1 - t0, first: performance.now() - t1 };
    }, { text, i, url });
    L.push(r.load); F.push(r.first);
    await page.close();
  }
  console.log(`${basename(f).padEnd(40)} ${((statSync(f).size / 1048576).toFixed(2) + ' MB').padStart(9)}   ${med(L).toFixed(1).padStart(8)}   ${med(F).toFixed(1).padStart(9)}`);
}
await browser.close(); server.close();
