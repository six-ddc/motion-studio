#!/usr/bin/env node
// 文字能力探测：复核 film-typography 依赖的 Chromium 行为（含两条非标准行为）。
// 升级 Playwright / Chromium 之后跑一遍；任何一条翻转，exit 1。
//
//   node dev/film-typography/probe.mjs [--font <可变字体 woff2>] [--json]   （开发基准，不随 skill 安装）
//
// 默认字体：@fontsource-variable/inter 的 latin standard（wght 100–900 + opsz 14–32）。
// 必须用**真的可变字体**测字重与轴；必须用**只声明单一字重的 face** 测合成粗体；
// 合成粗体必须**数墨水像素**，measureText 的 advance 不变。三条都是踩过的假阴性。
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { resolvePkg } from '../../skills/film-core/lib/env.mjs';
import { serve } from '../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

// --help 必须在起浏览器之前返回
cli({
  usage: 'node probe.mjs [--font <可变字体 woff2>] [--json]',
  about: '文字能力探测：复核 film-typography 依赖的 Chromium 行为。任何一条翻转 exit 1。升级 Playwright / Chromium 后跑。',
  opts: { font: ['<woff2>', '可变字体文件（默认 @fontsource-variable/inter 的 latin standard）'], json: '输出 JSON' },
});
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { process.stderr.write(`probe: ${m}\n`); process.exit(2); };
let fontPath = flag('font');
if (!fontPath) {
  // 先按 cwd 往上、再按脚本位置解析（film-core lib/env.mjs）
  fontPath = resolvePkg('@fontsource-variable/inter/files/inter-latin-standard-normal.woff2')
    ?? die('没有 --font，也解析不到 @fontsource-variable/inter（在项目根 npm i -D @fontsource-variable/inter）');
}
if (!existsSync(fontPath)) die(`字体不存在 ${fontPath}`);
fontPath = resolve(fontPath);
const fontUrl = '/font/' + encodeURIComponent(basename(fontPath));

const server = await serve(dirname(fontPath), { runtime: false, mounts: { '/font/': dirname(fontPath) },
  routes: { '/': '<!doctype html><canvas id=c width=700 height=300></canvas>' } });
const browser = await launchBrowser();
const page = await browser.newPage();
await page.goto(`${server.url}/`);

const r = await page.evaluate(async (fontUrl) => {
  const log = {};
  const c = document.getElementById('c');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const vf = new FontFace('ProbeVF', `url(${fontUrl})`, { weight: '100 900' });
  await vf.load(); document.fonts.add(vf);
  const one = new FontFace('Probe400', `url(${fontUrl})`, { weight: '400' });
  await one.load(); document.fonts.add(one);
  const w = (s) => +ctx.measureText(s).width.toFixed(2);
  const ink = (font, s = 'Motion') => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff'; ctx.font = font; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, 10, 150);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n;
  };

  // A 数字字重连续
  const ws = {}; for (const n of [400, 650, 651, 900]) { ctx.font = `${n} 80px ProbeVF`; ws[n] = w('Motion'); }
  log.weight = { widths: ws, continuous: ws[650] !== ws[651] && ws[400] !== ws[900] };

  // B fontStretch 关键词
  ctx.font = '80px ProbeVF';
  ctx.fontStretch = 'condensed'; const kw = ctx.fontStretch;
  ctx.fontStretch = '75%'; const pct = ctx.fontStretch;
  log.fontStretch = { exists: 'fontStretch' in ctx, keywordAccepted: kw === 'condensed', percentAccepted: pct === '75%', afterPercent: pct };
  ctx.fontStretch = 'normal';

  // C 【非标准】canvas 元素 font-variation-settings，是否需要重设 ctx.font
  c.style.fontVariationSettings = 'normal';
  ctx.font = '400 80px ProbeVF'; const base = w('Motion'); const baseInk = ink('400 80px ProbeVF');
  ctx.font = '400 80px ProbeVF';
  c.style.fontVariationSettings = "'wght' 900";
  const noRe = w('Motion');
  ctx.font = '400 80px ProbeVF';
  const re = w('Motion');
  const reInk = ink('400 80px ProbeVF');
  c.style.fontVariationSettings = "'opsz' 32";
  ctx.font = '400 80px ProbeVF'; const opsz32 = w('Motion');
  c.style.fontVariationSettings = "'opsz' 14";
  ctx.font = '400 80px ProbeVF'; const opsz14 = w('Motion');
  c.style.fontVariationSettings = 'normal';
  log.fvs = { base, withoutReassign: noRe, afterReassign: re, baseInk, reInk, opsz14, opsz32,
    takesEffect: re !== base, requiresReassign: noRe === base && re !== base, opszWorks: opsz14 !== opsz32 };

  // D 合成粗体：advance vs 墨水；【非标准】font-synthesis:none
  c.style.fontSynthesis = '';
  ctx.font = '400 80px Probe400'; const adv400 = w('Motion');
  ctx.font = '700 80px Probe400'; const adv700 = w('Motion');
  const i400 = ink('400 80px Probe400'); const i700 = ink('700 80px Probe400');
  c.style.fontSynthesis = 'none';
  const i700none = ink('700 80px Probe400');
  c.style.fontSynthesis = '';
  log.synth = { adv400, adv700, advanceUnchanged: adv400 === adv700, ink400: i400, ink700: i700, ink700none: i700none,
    happens: i700 > i400 * 1.05, noneDisables: i700 > i400 * 1.05 && Math.abs(i700none - i400) <= i400 * 0.01 };

  // E 陷阱：document.fonts.check 对不存在的字族返回 true；load 返回空数组
  log.checkTrap = { checkMissingFamily: document.fonts.check('80px "NoSuchFamilyXYZ"', 'abc'),
    loadMissingFamilyFaces: (await document.fonts.load('80px "NoSuchFamilyXYZ"', 'abc')).length };

  // F 前缀测量 vs 逐字相加（kerning）
  ctx.font = '400 80px ProbeVF';
  const s = 'AVATAR Wave Type'; const segs = [...s];
  const sum = segs.reduce((a, ch) => a + ctx.measureText(ch).width, 0);
  log.kerning = { whole: w(s), sumOfGlyphs: +sum.toFixed(2), drift: +(sum - ctx.measureText(s).width).toFixed(2) };

  // G Segmenter + CJK advance
  log.segmenter = typeof Intl.Segmenter === 'function';
  log.words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment('画面必须是时间的纯函数')].map((x) => x.segment);
  ctx.font = '40px sans-serif';
  log.cjkAdvance40 = Object.fromEntries(['画', '，', '。', '「', '—'].map((ch) => [ch, w(ch)]));
  log.offscreen = typeof OffscreenCanvas === 'function';
  return log;
}, fontUrl);
const version = browser.version();
await browser.close(); server.close();

const checks = [
  ['数字字重连续（650≠651）', r.weight.continuous, JSON.stringify(r.weight.widths)],
  ['ctx.fontStretch 存在且只吃关键词（75% 被拒）', r.fontStretch.exists && r.fontStretch.keywordAccepted && !r.fontStretch.percentAccepted, `设 75% 后读回 ${r.fontStretch.afterPercent}`],
  ['【非标准】canvas 元素 font-variation-settings 生效', r.fvs.takesEffect, `宽 ${r.fvs.base} -> ${r.fvs.afterReassign}，墨 ${r.fvs.baseInk} -> ${r.fvs.reInk}`],
  ['  且必须重设 ctx.font 才生效', r.fvs.requiresReassign, `不重设时宽 ${r.fvs.withoutReassign}`],
  ['  任意轴（opsz 14 vs 32）', r.fvs.opszWorks, `${r.fvs.opsz14} vs ${r.fvs.opsz32}`],
  ['合成粗体发生且 advance 不变（measureText 测不出）', r.synth.happens && r.synth.advanceUnchanged, `advance ${r.synth.adv400}/${r.synth.adv700}，墨 ${r.synth.ink400} -> ${r.synth.ink700}`],
  ['【非标准】canvas 元素 font-synthesis:none 关掉合成粗体', r.synth.noneDisables, `关后墨 ${r.synth.ink700none}`],
  ['陷阱：fonts.check(不存在的字族) 返回 true', r.checkTrap.checkMissingFamily && r.checkTrap.loadMissingFamilyFaces === 0, `check=${r.checkTrap.checkMissingFamily} load()=${r.checkTrap.loadMissingFamilyFaces} 个 face`],
  ['逐字相加会漂（需前缀测量）', r.kerning.drift !== 0, `整串 ${r.kerning.whole} vs 逐字和 ${r.kerning.sumOfGlyphs}，漂 ${r.kerning.drift}px @80px`],
  ['Intl.Segmenter', r.segmenter, r.words.join('/')],
  ['CJK/全角标点 advance = 1em', Object.values(r.cjkAdvance40).every((v) => v === 40), JSON.stringify(r.cjkAdvance40)],
];
if (argv.includes('--json')) console.log(JSON.stringify({ chromium: version, font: fontPath, ...r }, null, 1));
else {
  console.log(`Chromium ${version}   字体 ${fontPath}`);
  for (const [k, ok, d] of checks) console.log(`  ${ok ? '✓' : '✗'} ${k}   ${d}`);
}
const flipped = checks.filter(([, ok]) => !ok);
if (flipped.length) { process.stderr.write(`\n${flipped.length} 条行为与 film-typography 文档不符：${flipped.map(([k]) => k.trim()).join('；')}\n`); process.exit(1); }
