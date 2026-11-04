#!/usr/bin/env node
// 探测当前渲染用 Chromium 的文字/图形能力。
//
// 为什么要常驻：有几条**不是规范保证的行为**（最典型的是"canvas 元素的
// CSS font-variation-settings 会影响 ctx"）。Chromium 一升级就可能没了，
// 届时依赖它的片子会静默地渲错。升级 Playwright 之后跑一遍这个。
//
// 用法: node dev/film-motion/capabilities.mjs [--json]   （开发工具，不随 skill 安装）
// 可变字体从 @fontsource-variable/inter 找（先按 cwd 往上、再按脚本位置解析，film-core lib/env.mjs）；找不到就标明结论不作数。
// 浏览器经 launchBrowser()：探测的就是渲染用的那个构建 + 那组启动参数（跟随 FILM_CHROMIUM）。
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { serve } from '../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';
import { resolvePkg } from '../../skills/film-core/lib/env.mjs';
import { cli } from '../../skills/film-core/lib/cli.mjs';

cli({
  usage: 'node capabilities.mjs [--json]',
  about: '探测当前渲染用 Chromium 的文字/图形能力（升级 Playwright 后跑一遍）。任意 cwd。',
  opts: { json: '输出 JSON' },
});
const asJson = process.argv.includes('--json');

// 必须用**真的可变字体**来测字重和轴。拿静态字体测，所有轴都"无效"，得到假阴性。
function findVF() {
  const pkg = resolvePkg('@fontsource-variable/inter/package.json');
  if (!pkg) return null;
  const f = join(dirname(pkg), 'files', 'inter-latin-standard-normal.woff2');
  return existsSync(f) ? f : null;
}
const vfFile = findVF();
const hasVF = !!vfFile;
const root = hasVF ? dirname(vfFile) : process.cwd();

const blank = '<!doctype html><meta charset="utf-8"><canvas id="c" width="600" height="300"></canvas>';
const { port, close } = await serve(root, { routes: { '/__caps.html': blank } });
let browser;
try { browser = await launchBrowser(); } catch (e) { process.stderr.write(`✗ ${e.message}\n`); close(); process.exit(1); }
const version = browser.version();
const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
// 走 http 而不是 setContent 的 about:blank —— 否则字体是跨源的，FontFace 加载会被挡
await page.goto(`http://127.0.0.1:${port}/__caps.html`, { waitUntil: 'load' });

const r = await page.evaluate(async ({ vfUrl, hasVF }) => {
  const log = { variableFontLoaded: false };
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');

  // 载入可变字体；失败就退回系统字体，并在报告里标明
  let FAM = 'Helvetica, Arial, sans-serif';
  if (hasVF) {
    try {
      const face = new FontFace('CapsVF', `url(${vfUrl})`, { weight: '100 900' });
      await face.load();
      document.fonts.add(face);
      await document.fonts.ready;
      FAM = '"CapsVF"';
      log.variableFontLoaded = true;
    } catch (e) { log.variableFontError = String(e); }
  }
  log.fontFamilyUsed = FAM;
  const w = (s) => +ctx.measureText(s).width.toFixed(3);

  // 1. ctx.font 的数字字重：静态字体下各档应当撞到同一个实例
  const weights = {};
  for (const n of [400, 600, 650, 651, 1000]) { ctx.font = `${n} 80px ${FAM}`; weights[n] = w('Motion'); }
  log.weightWidths = weights;
  log.weightDistinctCount = new Set(Object.values(weights)).size;

  // 2. ctx.fontStretch：存在与否、是否离散
  log.hasFontStretch = 'fontStretch' in ctx;
  const stretch = {};
  for (const s of ['ultra-condensed', 'condensed', 'normal', 'expanded', 'ultra-expanded']) {
    ctx.font = `80px ${FAM}`;
    try { ctx.fontStretch = s; stretch[s] = { applied: ctx.fontStretch, width: w('Motion') }; }
    catch (e) { stretch[s] = 'throw'; }
  }
  log.fontStretch = stretch;

  // 3. shorthand 里的 stretch / oblique 角度会不会被丢弃
  ctx.fontStretch = 'normal';
  ctx.font = `condensed 80px ${FAM}`;
  log.shorthandKeepsStretch = ctx.fontStretch !== 'normal';
  ctx.font = `oblique 12deg 80px ${FAM}`;
  log.shorthandKeepsObliqueAngle = ctx.font.includes('12deg');

  // 4. 【非标准】canvas 元素的 CSS font-variation-settings 是否影响 ctx，
  //    以及是否必须重新给 ctx.font 赋值才生效
  ctx.fontStretch = 'normal';
  ctx.font = `80px ${FAM}`;
  const base = w('Motion');
  c.style.fontVariationSettings = `'wght' 900, 'wdth' 60`;
  const noReassign = w('Motion');
  ctx.font = `80px ${FAM}`;
  const reassigned = w('Motion');
  log.canvasVariationSettings = {
    base, withoutReassign: noReassign, afterReassign: reassigned,
    takesEffect: reassigned !== base,
    requiresFontReassign: noReassign === base && reassigned !== base,
  };
  c.style.fontVariationSettings = '';

  // 5. 【非标准】canvas 元素上的 font-synthesis:none 能否关掉伪粗体。
  //    必须用**只声明了单一字重**的 face 来测：可变字体的 700 是真字重，
  //    不会触发合成，拿它测只会得到假阴性。
  log.fontSynthesis = { testable: false };
  if (hasVF) {
    try {
      const only400 = new FontFace('CapsOnly400', `url(${vfUrl})`, { weight: '400' });
      await only400.load();
      document.fonts.add(only400);
      const F = '"CapsOnly400"';
      // 合成粗体是"涂抹"字形，不一定改 advance —— 用 measureText 测不出来，
      // 必须数墨量（非背景像素数）。
      const ink = (weight) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#fff';
        ctx.font = `${weight} 80px ${F}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Motion', 10, 120);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      };
      c.style.fontSynthesis = '';
      const i400 = ink(400);
      const i700 = ink(700);
      c.style.fontSynthesis = 'none';
      const i700off = ink(700);
      log.fontSynthesis = {
        testable: true, ink400: i400, ink700: i700, ink700WithNone: i700off,
        syntheticBoldHappens: i700 > i400 * 1.02,
        noneDisablesIt: i700 > i400 * 1.02 && Math.abs(i700off - i400) < i400 * 0.02,
        computed: getComputedStyle(c).fontSynthesis,
      };
    } catch (e) { log.fontSynthesis = { testable: false, error: String(e) }; }
    c.style.fontSynthesis = '';
  }

  // 6. Intl.Segmenter
  log.hasSegmenter = typeof Intl.Segmenter === 'function';
  if (log.hasSegmenter) {
    const g = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    log.graphemes = [...g.segment('画面👨‍👩‍👧é，纯')].map((s) => s.segment);
    const wd = new Intl.Segmenter('zh', { granularity: 'word' });
    log.words = [...wd.segment('画面必须是时间的纯函数')].map((s) => s.segment);
  }

  // 7. CJK 与全角标点的 advance 是否严格 1em（决定要不要自己做标点挤压）
  ctx.font = `40px ${FAM}`;
  log.cjkAdvance = Object.fromEntries(['画', '，', '。', '「', '—', 'A'].map((ch) => [ch, w(ch)]));

  // 8. Path2D 直接吃 SVG path 的 d
  try { new Path2D('M4 12h16M12 4v16'); log.path2dFromSvgD = true; }
  catch { log.path2dFromSvgD = false; }

  // 9. 未插入 DOM 的 SVGPathElement 能否测长度（图标描边生长要用）
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', 'M0 0 L100 0');
  log.detachedPathLength = el.getTotalLength();

  // 10. WebGL / WebGL2 可用性与渲染器（决定能不能上 three.js 之类）
  //     每种上下文必须用**各自独立的 canvas**：一个 canvas 取过 webgl 之后
  //     再取 webgl2 一定返回 null，会得到"WebGL2 不可用"的假阴性。
  for (const [key, id] of [['webgl', 'webgl'], ['webgl2', 'webgl2']]) {
    const probe = document.createElement('canvas');
    const gl = probe.getContext(id);
    if (!gl) { log[key] = false; continue; }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    log[key] = {
      ok: true,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    };
  }

  // 11. OffscreenCanvas（没有元素，所以用不了第 4、5 条那两招）
  log.hasOffscreenCanvas = typeof OffscreenCanvas === 'function';

  return log;
}, { vfUrl: `http://127.0.0.1:${port}/inter-latin-standard-normal.woff2`, hasVF });

await browser.close();
close();

if (asJson) {
  console.log(JSON.stringify({ chromium: version, ...r }, null, 1));
} else {
  const yes = (b) => (b ? '✓' : '✗');
  console.log(`Chromium ${version}`);
  console.log(`测试字体: ${r.fontFamilyUsed}${r.variableFontLoaded ? '（可变字体，结果可信）' : '（静态字体，字重与轴的结论不作数）'}`);
  if (r.variableFontError) console.log(`  字体加载失败: ${r.variableFontError}`);
  console.log();
  console.log('文字');
  console.log(`  ${yes(r.weightDistinctCount > 1)} ctx.font 数字字重连续生效（静态字体下应为 ✗，可变字体才 ✓）`);
  console.log(`  ${yes(r.hasFontStretch)} ctx.fontStretch 存在（只有 9 个离散关键字）`);
  console.log(`  ${yes(r.shorthandKeepsStretch)} ctx.font 的 shorthand 保留 stretch 关键字`);
  console.log(`  ${yes(r.shorthandKeepsObliqueAngle)} ctx.font 的 shorthand 保留 oblique 角度`);
  console.log(`  ${yes(r.canvasVariationSettings.takesEffect)} 【非标准】canvas 元素 CSS font-variation-settings 影响 ctx`);
  console.log(`      需要重新给 ctx.font 赋值才生效: ${r.canvasVariationSettings.requiresFontReassign ? '是' : '否'}`);
  console.log(`      宽度 ${r.canvasVariationSettings.base} -> ${r.canvasVariationSettings.afterReassign}`);
  if (!r.fontSynthesis.testable) {
    console.log('  — 伪粗体：没测（需要单字重字体）');
  } else {
    console.log(`  ${yes(r.fontSynthesis.syntheticBoldHappens)} 单字重字体要 700 时会合成伪粗体 `
      + `（墨量 ${r.fontSynthesis.ink400} -> ${r.fontSynthesis.ink700}）`);
    console.log(`  ${yes(r.fontSynthesis.noneDisablesIt)} 【非标准】canvas 上 font-synthesis:none 能关掉它`
      + `（关掉后 ${r.fontSynthesis.ink700WithNone}）`);
  }
  console.log(`  ${yes(r.hasSegmenter)} Intl.Segmenter`);
  if (r.graphemes) console.log(`      grapheme: ${r.graphemes.join(' / ')}`);
  if (r.words) console.log(`      word:     ${r.words.join(' / ')}`);
  console.log(`      CJK advance: ${JSON.stringify(r.cjkAdvance)}`);
  console.log();
  console.log('图形');
  console.log(`  ${yes(r.path2dFromSvgD)} Path2D 直接吃 SVG 的 d`);
  console.log(`  ${yes(r.detachedPathLength > 0)} 离屏 SVGPathElement 可测长度（${r.detachedPathLength}）`);
  console.log(`  ${yes(!!r.webgl?.ok)} WebGL   ${r.webgl?.ok ? r.webgl.renderer : ''}`);
  console.log(`  ${yes(!!r.webgl2?.ok)} WebGL2  ${r.webgl2?.ok ? r.webgl2.renderer : ''}`);
  console.log(`  ${yes(r.hasOffscreenCanvas)} OffscreenCanvas（注意：没有元素，用不了上面两条非标准招数）`);
}
