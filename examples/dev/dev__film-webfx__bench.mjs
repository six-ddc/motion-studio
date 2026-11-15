// 软件渲染（SwiftShader）下的着色器性能 + 确定性实测。
//
// 测什么：
//   1. 各复杂度档位 × 各分辨率的单帧耗时（gl.readPixels(1px) 强制同步，量的是真画完）
//   2. 合成开销：WebGL canvas → 2D drawImage；2D canvas → texImage2D 上传
//   3. 确定性：同页同 t 两次、乱序后回到同 t、跨两次独立启动浏览器 —— 全帧 SHA-256
//   4. 模板库每个模板能编译、能出非空像素、同 t 可重复
//
// 用法: node dev/film-webfx/bench.mjs [--quick] [--json] [--gpu]
//   --quick 只测全分辨率 + 少帧数   --gpu 改用 Metal 后端（对照用；一次渲染别混用后端）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { serve } from '../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

cli({
  usage: 'node bench.mjs [--quick] [--json] [--gpu]',
  about: '软件渲染（SwiftShader）下的着色器性能 + 确定性实测；模板库逐个编译、出像素、同 t 可重复。任意 cwd。',
  opts: { quick: '只测全分辨率 + 少帧数', json: '输出 JSON', gpu: '改用 Metal 后端（对照用；一次渲染别混用后端）' },
});

const DEV = dirname(fileURLToPath(import.meta.url));
const SKILL = join(DEV, '../../skills/film-webfx');   // 被测的运行时
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const asJson = args.includes('--json');
const gpu = args.includes('--gpu');

// 页面：空白 '/'；/assets/* 来自 skill（runtime/ 与模板库 templates.mjs）
const BLANK = '<!doctype html><body style="margin:0"></body>';
const serveBench = () => serve(SKILL, { routes: { '/': BLANK } });

async function launch(port) {
  const browser = await launchBrowser({ extraArgs: gpu ? ['--use-angle=metal'] : [] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`);
  return { browser, page, errs };
}

// 在页面里跑的测量。返回纯 JSON
async function measure(page, { quick }) {
  return page.evaluate(async ({ quick }) => {
    const { createShaderLayer, GLSL } = await import('/assets/runtime/webfx.js');
    const { TIERS, TEMPLATES } = await import('/assets/templates.mjs');
    const W = 1080, H = 1920;
    const LIB = GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop;
    const sha = async (u8) => {
      const d = await crypto.subtle.digest('SHA-256', u8);
      return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    // 计时只在测量脚本里用 performance.now —— 场景运行时绝不读它
    const now = () => performance.now();

    // 2D 源图：后期类模板要吃一张纹理
    const src = document.createElement('canvas'); src.width = W; src.height = H;
    const sctx = src.getContext('2d');
    const gr = sctx.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#203040'); gr.addColorStop(1, '#f0c080');
    sctx.fillStyle = gr; sctx.fillRect(0, 0, W, H);
    sctx.fillStyle = '#fff'; sctx.font = 'bold 300px sans-serif'; sctx.fillText('FX', 200, 1000);

    const out = { tiers: {}, composite: {}, determinism: {}, templates: {}, hashes: {} };
    const scales = quick ? [1] : [1, 0.5, 0.25];
    const N = quick ? 3 : 5;

    for (const [name, body] of Object.entries(TIERS)) {
      out.tiers[name] = {};
      for (const s of scales) {
        const t0 = now();
        const fx = createShaderLayer({ width: W, height: H, scale: s, frag: LIB + body, seed: 3 });
        if (body.includes('u_src')) fx.texture('u_src', src);
        fx.render(0); fx.finish();               // 首帧含着色器 JIT 编译
        const first = now() - t0;
        const ts = [];
        for (let i = 0; i < N; i++) { const a = now(); fx.render(1 + i / 30); fx.finish(); ts.push(now() - a); }
        ts.sort((a, b) => a - b);
        out.tiers[name][s] = { w: fx.width, h: fx.height, firstMs: +first.toFixed(1), medianMs: +ts[N >> 1].toFixed(1), minMs: +ts[0].toFixed(1) };
        // 确定性：同 t 两次 / 乱序后回到同 t
        if (s === 1) {
          fx.render(2.5); const a = await sha(fx.pixels());
          fx.render(2.5); const b = await sha(fx.pixels());
          fx.render(9.9); fx.render(0.1); fx.render(2.5); const c = await sha(fx.pixels());
          out.determinism[name] = { same: a === b, reorder: a === c, hash: a };
          out.hashes[name] = a;
        }
        fx.gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }

    // 合成开销（全分辨率）
    {
      const fx = createShaderLayer({ width: W, height: H, frag: LIB + TIERS.t0_gradient });
      const main = document.createElement('canvas'); main.width = W; main.height = H;
      const mctx = main.getContext('2d');
      const sync2d = () => mctx.getImageData(0, 0, 1, 1);
      fx.render(0); fx.finish(); fx.drawTo(mctx); sync2d();
      const r = [];
      for (let i = 0; i < N; i++) { fx.render(i); fx.finish(); const a = now(); fx.drawTo(mctx); sync2d(); r.push(now() - a); }
      r.sort((a, b) => a - b);
      out.composite.webglToCanvas2d_ms = +r[N >> 1].toFixed(1);
      // 半分辨率层放大到全画幅
      const fxh = createShaderLayer({ width: W, height: H, scale: 0.5, frag: LIB + TIERS.t0_gradient });
      fxh.render(0); fxh.finish(); fxh.drawTo(mctx); sync2d();
      const r2 = [];
      for (let i = 0; i < N; i++) { fxh.render(i); fxh.finish(); const a = now(); fxh.drawTo(mctx); sync2d(); r2.push(now() - a); }
      r2.sort((a, b) => a - b);
      out.composite.halfResUpscale_high_ms = +r2[N >> 1].toFixed(1);
      for (const q of ['low', 'medium']) {
        const rq = [];
        for (let i = 0; i < N; i++) { fxh.render(i); fxh.finish(); const a = now();
          mctx.imageSmoothingEnabled = true; mctx.imageSmoothingQuality = q; mctx.drawImage(fxh.canvas, 0, 0, W, H); sync2d(); rq.push(now() - a); }
        rq.sort((a, b) => a - b);
        out.composite['halfResUpscale_' + q + '_ms'] = +rq[N >> 1].toFixed(1);
      }
      // 2D → 纹理上传
      const fxt = createShaderLayer({ width: W, height: H, frag: LIB + TEMPLATES.chroma });
      // 用 src 的副本做上传测试：改动副本模拟"每帧 2D 内容都变了"，不污染后面模板测试用的 src
      const dyn = document.createElement('canvas'); dyn.width = W; dyn.height = H;
      const dctx = dyn.getContext('2d'); dctx.drawImage(src, 0, 0);
      fxt.texture('u_src', dyn); fxt.render(0); fxt.finish();
      const u = [];
      for (let i = 0; i < N; i++) { dctx.fillRect(i, 0, 1, 1); const a = now(); fxt.texture('u_src', dyn); fxt.render(0); fxt.finish(); u.push(now() - a); }
      u.sort((a, b) => a - b);
      out.composite.canvas2dToTexture_plus_chroma_ms = +u[N >> 1].toFixed(1);
      const c = [];
      for (let i = 0; i < N; i++) { const a = now(); fxt.render(i); fxt.finish(); c.push(now() - a); }
      c.sort((a, b) => a - b);
      out.composite.chroma_only_ms = +c[N >> 1].toFixed(1);

      // 预乘 alpha 往返：着色器输出 (0.5*a 预乘) 经 drawImage 后像素值
      const fa = createShaderLayer({ width: 4, height: 4, frag: GLSL.header + `void main(){ OUT = vec4(0.4, 0.2, 0.1, 0.5); }` });
      const tiny = document.createElement('canvas'); tiny.width = 4; tiny.height = 4;
      const tctx = tiny.getContext('2d'); fa.render(0); fa.drawTo(tctx, { width: 4, height: 4 });
      out.composite.premulRoundtrip = { shaderOut: [0.4, 0.2, 0.1, 0.5], canvas2dGetImageData: [...tctx.getImageData(0, 0, 1, 1).data] };
    }

    // 模板库：编译 + 非空 + 同 t 可重复 + 计时（全分辨率）
    for (const [name, body] of Object.entries(TEMPLATES)) {
      try {
        const fx = createShaderLayer({ width: W, height: H, frag: LIB + body, seed: 7 });
        if (body.includes('u_src')) fx.texture('u_src', src);
        const U = { u_period: 4, u_amp: 0.03, u_amt: 0.02, u_frame: 12, u_grain: 0.08, u_vig: 0.6, u_thresh: 0.6 };
        fx.render(1.3, U); fx.finish();
        const a = now(); fx.render(1.3, U); fx.finish(); const ms = now() - a;
        const p1 = fx.pixels(); const h1 = await sha(p1);
        fx.render(3.1, U); fx.render(1.3, U); const h2 = await sha(fx.pixels());
        let nonzero = 0; for (let i = 0; i < p1.length; i += 4) if (p1[i] | p1[i + 1] | p1[i + 2]) nonzero++;
        let loopSeam = null;
        if (name === 'loop_fbm') { fx.render(0, U); const s0 = await sha(fx.pixels()); fx.render(4, U); const s1 = await sha(fx.pixels()); loopSeam = s0 === s1; }
        out.templates[name] = { ok: true, ms: +ms.toFixed(1), nonzeroFrac: +(nonzero / (p1.length / 4)).toFixed(3), repeatable: h1 === h2, loopSeam, hash: h1 };
        out.hashes['tpl_' + name] = h1;
        fx.gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch (e) { out.templates[name] = { ok: false, error: String(e).slice(0, 400) }; }
    }

    // 浮点：同一着色器 WebGL1 vs WebGL2 是否逐位一致（同后端不同前端）
    {
      const body = TIERS.t2_warp;
      const f1 = createShaderLayer({ width: 270, height: 480, frag: LIB + body });
      const lib2 = GLSL.header2 + GLSL.hash + GLSL.noise + GLSL.loop;
      const f2 = createShaderLayer({ width: 270, height: 480, frag: lib2 + body, webgl2: true });
      f1.render(2); f2.render(2);
      const a = f1.pixels(), b = f2.pixels(); let diff = 0, maxd = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { diff++; maxd = Math.max(maxd, d); } }
      out.determinism.webgl1_vs_webgl2 = { diffChannels: diff, maxDiff: maxd, of: a.length };
    }
    // renderer 字符串
    const g = document.createElement('canvas').getContext('webgl');
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    out.renderer = dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    out.hw = navigator.hardwareConcurrency;
    return out;
  }, { quick });
}

const { port, close } = await serveBench();

// 第一次启动：完整测量
const A = await launch(port);
const r = await measure(A.page, { quick });
// 截图成本基线：渲染器每帧都要付这一笔，着色器耗时要和它比
await A.page.evaluate(() => {
  const c = document.createElement('canvas'); c.id = 'stage'; c.width = 1080; c.height = 1920;
  document.body.appendChild(c); const x = c.getContext('2d'); x.fillStyle = '#345'; x.fillRect(0, 0, 1080, 1920);
});
const shots = [];
for (let i = 0; i < 4; i++) { const a = Date.now(); await A.page.locator('#stage').screenshot({ type: 'png' }); shots.push(Date.now() - a); }
r.screenshotPng_ms = shots.sort((a, b) => a - b)[2];
r.errors = A.errs;
await A.browser.close();

// 第二次独立启动：只比哈希（跨进程确定性）
const B = await launch(port);
const r2 = await measure(B.page, { quick: true });
await B.browser.close();
close();
r.crossLaunch = {};
for (const k of Object.keys(r.hashes)) r.crossLaunch[k] = r.hashes[k] === r2.hashes[k];

if (asJson) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }

console.log(`renderer: ${r.renderer}   CPU 线程: ${r.hw}   后端: ${gpu ? 'Metal(--use-angle=metal)' : '默认(SwiftShader)'}`);
console.log(`\n单帧耗时 ms（中位数；first = 含 JIT 编译的首帧）`);
const scales = Object.keys(Object.values(r.tiers)[0]);
console.log(['档位'.padEnd(14), ...scales.map((s) => { const x = Object.values(r.tiers)[0][s]; return `${x.w}×${x.h}`.padStart(16); })].join(''));
for (const [n, v] of Object.entries(r.tiers)) {
  console.log([n.padEnd(14), ...scales.map((s) => `${v[s].medianMs} (f ${v[s].firstMs})`.padStart(16))].join(''));
}
console.log(`\n合成开销 ms: ${JSON.stringify(r.composite)}`);
console.log(`截图 PNG 1080×1920 基线: ${r.screenshotPng_ms} ms`);
console.log(`\n确定性（全帧 SHA-256）`);
for (const [n, v] of Object.entries(r.determinism)) console.log(`  ${n.padEnd(18)} ${JSON.stringify(v)}`);
console.log(`  跨两次独立启动: ${Object.entries(r.crossLaunch).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`);
console.log(`\n模板库`);
for (const [n, v] of Object.entries(r.templates)) console.log(`  ${n.padEnd(12)} ${JSON.stringify(v)}`);
if (r.errors.length) console.log('页面错误:', r.errors);
const allOk = Object.values(r.determinism).filter((v) => 'same' in v).every((v) => v.same && v.reorder)
  && Object.values(r.crossLaunch).every(Boolean) && Object.values(r.templates).every((v) => v.ok && v.repeatable);
console.log(allOk ? '\n确定性全部通过' : '\n✗ 有不一致项，见上');
process.exit(allOk ? 0 : 1);
