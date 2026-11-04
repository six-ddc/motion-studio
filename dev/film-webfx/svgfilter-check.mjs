// SVG 滤镜的确定性 + 成本实测。
//
// 测什么（全部在 1080×1920 下，截图 PNG 的 SHA-256 比对）：
//   1. feTurbulence 同参数两次截图是否一致
//   2. 乱序：A → B → A 是否回到同一像素
//   3. seed 属性是否真的起作用（seed=1 vs 2 应不同）；小数 seed 怎么处理（1 vs 1.4 vs 1.6）
//   4. 跨两次独立启动浏览器是否一致
//   5. 2D canvas 的 ctx.filter = 'url(#id)' 走同一个滤镜：确定性 + 成本
//   6. 成本：带滤镜截图 vs 不带滤镜截图
//
// 用法: node dev/film-webfx/svgfilter-check.mjs [--json]
import { createHash } from 'node:crypto';
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

cli({
  usage: 'node svgfilter-check.mjs [--json]',
  about: 'SVG 滤镜（feTurbulence 等）的确定性 + 成本实测，1080×1920 截图 SHA 比对。',
  opts: { json: '输出 JSON' },
});

const asJson = process.argv.includes('--json');
const W = 1080, H = 1920;
const md5 = (b) => createHash('md5').update(b).digest('hex').slice(0, 12);

const HTML = `<!doctype html><html><body style="margin:0;background:#111">
<svg id="stage" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="warp" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence id="turb" type="fractalNoise" baseFrequency="0.008" numOctaves="4" seed="1" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="80" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur in="d" stdDeviation="1.5"/>
    </filter>
    <filter id="noiseOnly" x="0" y="0" width="100%" height="100%">
      <feTurbulence id="turb2" type="turbulence" baseFrequency="0.01" numOctaves="5" seed="1"/>
    </filter>
  </defs>
  <g id="content">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#223"/>
    <circle cx="540" cy="900" r="320" fill="#e8c070"/>
    <rect x="200" y="1300" width="680" height="120" fill="#7ac"/>
  </g>
</svg>
<canvas id="cv" width="${W}" height="${H}" style="display:none"></canvas>
<script>
  // seek 接口：按 t 设置滤镜参数，纯函数
  window.setState = ({ seed, freq, scale, filter }) => {
    const t = document.getElementById('turb');
    t.setAttribute('seed', seed); t.setAttribute('baseFrequency', freq);
    document.querySelector('feDisplacementMap').setAttribute('scale', scale);
    document.getElementById('content').setAttribute('filter', filter ? 'url(#warp)' : '');
  };
  window.canvasFilter = (seed) => {
    document.getElementById('turb2').setAttribute('seed', seed);
    const c = document.getElementById('cv'); const x = c.getContext('2d');
    x.filter = 'none'; x.clearRect(0, 0, c.width, c.height);
    x.filter = 'url(#noiseOnly)'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.filter = 'none';
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261; for (let i = 0; i < d.length; i += 7) { h ^= d[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  };
</script></body></html>`;

async function run() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(HTML);
  const stage = page.locator('#stage');
  const shot = async (st) => { await page.evaluate((s) => window.setState(s), st); return md5(await stage.screenshot({ type: 'png' })); };
  const A = { seed: 1, freq: '0.008', scale: 80, filter: true };
  const B = { seed: 9, freq: '0.02', scale: 30, filter: true };
  const r = {};
  r.a1 = await shot(A); r.a2 = await shot(A);
  await shot(B); r.a3 = await shot(A);
  r.seed2 = await shot({ ...A, seed: 2 });
  r.seed1_4 = await shot({ ...A, seed: 1.4 });
  r.seed1_6 = await shot({ ...A, seed: 1.6 });
  r.seed0 = await shot({ ...A, seed: 0 });
  r.seedNeg = await shot({ ...A, seed: -1 });
  // baseFrequency 连续变化是否连续可 seek（不同值不同，同值相同）
  r.f1 = await shot({ ...A, freq: '0.0081' }); r.f1b = await shot({ ...A, freq: '0.0081' });
  // 成本
  const time = async (st, n = 4) => { const ts = []; for (let i = 0; i < n; i++) { const a = Date.now(); await shot({ ...st, scale: st.scale + i * 1e-3 }); ts.push(Date.now() - a); } return ts.sort((x, y) => x - y)[n >> 1]; };
  r.ms_noFilter = await time({ ...A, filter: false });
  r.ms_filter = await time(A);
  r.ms_filter_oct8 = await page.evaluate(() => document.getElementById('turb').setAttribute('numOctaves', '8')).then(() => time(A));
  await page.evaluate(() => document.getElementById('turb').setAttribute('numOctaves', '4'));
  // canvas ctx.filter = url(#...)
  r.cv1 = await page.evaluate(() => window.canvasFilter(1));
  r.cv1b = await page.evaluate(() => window.canvasFilter(1));
  r.cv2 = await page.evaluate(() => window.canvasFilter(2));
  r.cv_ms = await page.evaluate(() => { const a = performance.now(); for (let i = 0; i < 3; i++) window.canvasFilter(1 + i); return +((performance.now() - a) / 3).toFixed(1); });
  await browser.close();
  return r;
}

const r1 = await run();
const r2 = await run();
const out = {
  sameTwice: r1.a1 === r1.a2,
  reorderABA: r1.a1 === r1.a3,
  seedChangesOutput: r1.a1 !== r1.seed2,
  fractionalSeed: { 'seed=1': r1.a1, 'seed=1.4': r1.seed1_4, 'seed=1.6': r1.seed1_6, 'seed=2': r1.seed2 },
  seed0: r1.seed0, seedNeg1: r1.seedNeg,
  freqStep: { differs: r1.f1 !== r1.a1, repeatable: r1.f1 === r1.f1b },
  crossLaunch: ['a1', 'seed2', 'seed1_4', 'f1', 'cv1', 'cv2'].map((k) => [k, r1[k] === r2[k]]),
  canvasCtxFilter: { repeatable: r1.cv1 === r1.cv1b, seedWorks: r1.cv1 !== r1.cv2, ms: r1.cv_ms },
  cost: { screenshotNoFilter_ms: r1.ms_noFilter, screenshotWithFilter_ms: r1.ms_filter, numOctaves8_ms: r1.ms_filter_oct8 },
};
if (asJson) console.log(JSON.stringify({ r1, r2, ...out }, null, 1));
else {
  console.log(`同参数两次截图一致: ${out.sameTwice ? '✓' : '✗'}`);
  console.log(`乱序 A→B→A 一致:   ${out.reorderABA ? '✓' : '✗'}`);
  console.log(`seed 改变输出:      ${out.seedChangesOutput ? '✓' : '✗'}`);
  console.log(`小数 seed:          ${JSON.stringify(out.fractionalSeed)}`);
  console.log(`seed=0 ${out.seed0}  seed=-1 ${out.seedNeg1}`);
  console.log(`baseFrequency 微调: 不同 ${out.freqStep.differs ? '✓' : '✗'}，可重复 ${out.freqStep.repeatable ? '✓' : '✗'}`);
  console.log(`跨两次独立启动:     ${out.crossLaunch.map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`);
  console.log(`2D ctx.filter=url(): 可重复 ${out.canvasCtxFilter.repeatable ? '✓' : '✗'}，seed 生效 ${out.canvasCtxFilter.seedWorks ? '✓' : '✗'}，${out.canvasCtxFilter.ms} ms/次（含 getImageData）`);
  console.log(`成本: ${JSON.stringify(out.cost)}`);
}
const ok = out.sameTwice && out.reorderABA && out.seedChangesOutput && out.crossLaunch.every(([, v]) => v) && out.canvasCtxFilter.repeatable;
process.exit(ok ? 0 : 1);
