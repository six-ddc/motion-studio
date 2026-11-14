// film-core lib · 浏览器：唯一的 launchBrowser()，以及打开场景、按 t 截帧（openScene）、逐像素比较（makeComparer）。
// 全套件的 chromium.launch 只在这里出现：渲染、门、静帧、评审用同一套启动参数和同一个浏览器构建，
// 否则"检查时看到的帧"和"成片里的帧"不是同一个东西。WAAPI 的冻结也只在这里写一次。
import { statSync, accessSync, readdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, playwrightVersion } from './env.mjs';
import { FORMATS } from '../assets/runtime/layout.js';
import { BACKEND_KEYS } from './film.mjs';

export { FORMATS };

// 固定的启动参数：像素由 Chromium 光栅化决定，参数变了字形抗锯齿就可能变。
// --font-render-hinting=none 关掉平台相关的字形 hinting（主要影响 Linux；macOS 上无害）。
export const LAUNCH_ARGS = ['--font-render-hinting=none'];

// 渲染后端：film.json `backend` 声明（film-json.md）。缺省 = 'swiftshader' = 改动前的唯一行为，启动参数逐字不变。
// 'gpu'：只把 WebGL/WebGL2 换到本机硬件 GPU（macOS 上是 ANGLE Metal），2D 光栅与合成仍走软件。
// 为什么要关掉 GPU 光栅和 GPU 合成（仓库 docs/verified/film-core.md「GPU 后端」，Chromium 156 headless shell、Apple M3 Max）：
//   只加 --use-angle=metal 时，Chromium 把 2D 光栅和合成也搬上 GPU：纯 2D 夹具与软件后端差 0.02%、最大 61/255，
//   _test-typography 在**同一个浏览器里**换页面重载 10/16 帧不同、并行 4 页 10/16 帧不同（3 次复现）——2D 文字的 GPU 光栅不确定，门 1b/4 会红。
//   加上下面三条后：2D 夹具与软件后端逐像素相同，四支夹具同 t / 乱序 / 重载 / 并行 / 跨启动全部逐字节一致；WebGL 仍在 Metal 上。
// 换一组参数 = 换了另一支片子的像素：改这里要重跑上述实验并在 verified 里记数字。
export const BACKENDS = Object.freeze({
  swiftshader: Object.freeze([]),
  gpu: Object.freeze(['--use-angle=metal', '--disable-gpu-rasterization', '--disable-accelerated-2d-canvas', '--disable-gpu-compositing']),
});
export const DEFAULT_BACKEND = 'swiftshader';
if (JSON.stringify(Object.keys(BACKENDS)) !== JSON.stringify(BACKEND_KEYS)) throw new Error('browser.mjs BACKENDS 与 film.mjs BACKEND_KEYS 不一致');
/** 一支片子声明的后端（resolveFilm 已校验取值）。F = resolveFilm 的返回。 */
export const filmBackend = (F) => F?.config?.backend ?? DEFAULT_BACKEND;
// launchBrowser 起的每个浏览器记下它的后端与实测 WebGL renderer：openScene 据此核对"这个浏览器是不是这支片子声明的后端"
const _browserInfo = new WeakMap();
export const browserBackend = (browser) => _browserInfo.get(browser)?.backend ?? DEFAULT_BACKEND;
// 软件实现的 renderer 字符串：声明了 gpu 却拿到它们 = 本机没起来硬件 GPU
const SOFTWARE_GL = /SwiftShader|llvmpipe|softpipe|Software|Basic Render|Microsoft Basic/i;

// FILM_CHROMIUM=<Chromium 可执行文件路径>：换一个浏览器构建来渲染。
//
// 为什么存在：它是**验证用的口子，不是日常开关**。不设它，Playwright 永远用自己注册表里那一个
// Chromium，于是 render.mjs 的"渲染器漂移告警"、"换版本后分片缓存对不对"这些分支在一台机器上
// 根本触发不了，只能靠猜。设它，就能在同一台机器上拿另一个构建（例如 ms-playwright 缓存里的旧版本）
// 实测"换浏览器版本时像素变不变、告警打不打、缓存复用不复用"。日常渲染不要设。
//
// 为什么不危险：rendererFingerprint() 记的是**实际启动的那个**浏览器（版本号 + 构建形态，见 chromiumBuild），
// 不是 Playwright 声称的版本。所以用它渲出来的片子会在 film.json renderer.chromium 里留下真实构建，
// 之后用默认浏览器再渲，漂移告警会点名；逐帧哈希（截图 PNG 字节）也会变，分片缓存整体重编，不会复用旧分片。
// 像素变化不会静默混进成片。
//
// 两个实测过的坑（仓库 docs/verified/film-motion.md §11）：
//   - 同一版本号有两种二进制：chromium-<rev>/…/Google Chrome for Testing（完整 Chrome）和
//     chromium_headless_shell-<rev>/…/chrome-headless-shell（Playwright 默认用的就是它）。
//     只想换版本、不想换形态，就指到 headless shell；指到完整 Chrome 等于同时换了两条轴。
//   - 旧版 headless shell（143、145）**新装或新拷贝后的第一次启动**，每个页面开头若干帧截成纯白，不报错
//     （实测 6/6 次复现；之后的启动 0/158；151、156 的 shell 和完整 Chrome 不会）。新装的旧 shell 先空跑一次再用；
//     渲完可以用 seamcheck --relaunch 2 和这次渲染的逐帧清单对账（同上 §12）。
//
// 不设或设为空串 = 行为与没有这个口子时完全一样。
export const CHROMIUM_ENV = 'FILM_CHROMIUM';
export function chromiumOverride() {
  const p = process.env[CHROMIUM_ENV];
  if (!p) return null;
  let st;
  try { st = statSync(p); }
  catch { throw new Error(`${CHROMIUM_ENV}=${p}：路径不存在。它要指向 Chromium 的可执行文件本体，例如\n  ~/Library/Caches/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell（与默认同形态，只换版本）\n  ~/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing（完整 Chrome）\n  不需要换浏览器时把这个变量删掉（unset ${CHROMIUM_ENV}）`); }
  if (st.isDirectory()) {
    let hint = '';
    if (/\.app\/?$/.test(p)) {
      const macos = join(p, 'Contents', 'MacOS');
      let bins = [];
      try { bins = readdirSync(macos); } catch {}
      hint = `\n  macOS 的 .app 要指到里面的二进制：${bins.length === 1 ? join(macos, bins[0]) : join(macos, '<可执行文件>')}`;
    }
    throw new Error(`${CHROMIUM_ENV}=${p} 是目录，不是可执行文件。${hint}`);
  }
  try { accessSync(p, constants.X_OK); }
  catch { throw new Error(`${CHROMIUM_ENV}=${p}：文件存在但没有执行权限`); }
  return p;
}

let _warnedOverride = false;
const _warnedBackend = new Set();
/**
 * 起一个浏览器。渲染、seamcheck、字体来源、评审、静帧……全部经它，参数一律 LAUNCH_ARGS。
 * extraArgs 只给开发基准（dev/ 下的 bench）用，**门和渲染不许传**——传了"检查的条件"就不再是"渲染的条件"。
 */
export async function launchBrowser({ extraArgs = [], backend = DEFAULT_BACKEND } = {}) {
  if (!Object.hasOwn(BACKENDS, backend)) throw new Error(`未知渲染后端 ${JSON.stringify(backend)}（可用：${Object.keys(BACKENDS).join(' / ')}）`);
  const exe = chromiumOverride();
  const args = [...LAUNCH_ARGS, ...BACKENDS[backend], ...extraArgs];
  let browser;
  if (!exe) browser = await (await playwright()).chromium.launch({ args });
  else {
    if (!_warnedOverride) {
      _warnedOverride = true;
      process.stderr.write(`⚠ ${CHROMIUM_ENV} 已设置：用 ${exe} 而不是 Playwright 默认的 Chromium（验证用，日常渲染不要设）\n`);
    }
    try {
      browser = await (await playwright()).chromium.launch({ args, executablePath: exe });
    } catch (e) {
      throw new Error(`${CHROMIUM_ENV}=${exe} 启动失败（版本差太多时 Playwright 的协议可能不兼容）：\n  ${String(e.message).split('\n')[0]}`);
    }
  }
  if (backend === DEFAULT_BACKEND) { _browserInfo.set(browser, { backend }); return browser; }
  // 声明了硬件后端：当场核实 WebGL 真跑在硬件上。起不来就报错退出，不静默退回软件渲染——
  // 那会让同一支片子在两台机器上像素不同却都"通过"。
  let gl;
  try { gl = await webglRenderer(browser); }
  catch (e) { await browser.close().catch(() => {}); throw new Error(`渲染后端 ${backend}：探测 WebGL renderer 失败：${String(e.message).split('\n')[0]}`); }
  const bad = !gl.webgl || !gl.webgl2 || SOFTWARE_GL.test(gl.webgl) || SOFTWARE_GL.test(gl.webgl2) || gl.webgl !== gl.webgl2;
  if (bad) {
    await browser.close().catch(() => {});
    const e = new Error(`缺能力：本片 film.json 声明 "backend": "${backend}"，但本机浏览器没有起来硬件 GPU 的 WebGL`
      + `（webgl: ${gl.webgl ?? 'null'}；webgl2: ${gl.webgl2 ?? 'null'}）。\n`
      + `  不退回软件渲染：那样同一支片子换台机器像素就不同，门却照样通过。\n`
      + `  这个后端目前只在 macOS + Apple GPU（ANGLE Metal）上实测过；在有 GPU 的那台机器上渲，或把 film.json 的 backend 删掉（= 软件后端，像素会变，重看静帧）`);
    e.code = 'BACKEND_UNAVAILABLE';
    throw e;
  }
  // 驱动版本（macOS 上随系统更新）：UNMASKED_RENDERER 里没有版本号（"Unspecified Version"），只记它的话系统升级换了 Metal 驱动也不会告警
  let gpuDriver = null;
  try {
    const s = await browser.newBrowserCDPSession();
    const d = (await s.send('SystemInfo.getInfo')).gpu?.devices?.[0];
    await s.detach().catch(() => {});
    if (d?.driverVersion) gpuDriver = `${d.driverVendor ?? ''} ${d.driverVersion}`.trim();
  } catch {}
  _browserInfo.set(browser, { backend, gpu: gl.webgl, gpuDriver });
  return browser;
}

// 各取一个独立 canvas 读 UNMASKED_RENDERER（同一个 canvas 先取 webgl 再取 webgl2 返回 null）
async function webglRenderer(browser) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate(() => {
      const q = (v) => {
        const g = document.createElement('canvas').getContext(v);
        if (!g) return null;
        const ext = g.getExtension('WEBGL_debug_renderer_info');
        return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      };
      return { webgl: q('webgl'), webgl2: q('webgl2') };
    });
  } finally { await ctx.close(); }
}

// 渲染环境指纹：写进 film.json 的 renderer 字段，用来发现"换了浏览器版本，像素可能变了"。
// 软件后端（缺省）的形状与改动前逐字相同；硬件后端多记 backend 与实测 WebGL renderer（gpu），换后端或换显卡会被漂移告警点名。
export async function rendererFingerprint(browser) {
  const pw = playwrightVersion();
  const bi = _browserInfo.get(browser);
  const backend = bi?.backend ?? DEFAULT_BACKEND;
  const fp = { chromium: await chromiumBuild(browser), playwright: pw, args: [...LAUNCH_ARGS, ...BACKENDS[backend]] };
  if (backend !== DEFAULT_BACKEND) { fp.backend = backend; fp.gpu = bi.gpu; fp.gpuDriver = bi.gpuDriver; }
  return fp;
}
/** 渲染器记录（film.json renderer、清单 renderer、收据 env）的后端：没记 = 软件后端 */
export const recordedBackend = (r) => ({ backend: r?.backend ?? DEFAULT_BACKEND, gpu: r?.gpu ?? null, gpuDriver: r?.gpuDriver ?? null });
/** 两份渲染器记录的后端是否可比（同后端、同显卡、同驱动）；不可比返回一句原因，可比返回 null */
export function backendMismatch(a, b) {
  const x = recordedBackend(a), y = recordedBackend(b);
  if (x.backend !== y.backend) return `渲染后端不同（${x.backend} vs ${y.backend}）`;
  if (x.gpu !== y.gpu) return `显卡不同（${x.gpu} vs ${y.gpu}）`;
  if (x.gpuDriver !== y.gpuDriver) return `显卡驱动不同（${x.gpuDriver} vs ${y.gpuDriver}）`;
  return null;
}

// 版本号 + 构建形态。同一个版本号有两种二进制，像素不一样：
//   Playwright 默认的 headless 用 chromium-headless-shell（CDP product = "HeadlessChrome/x"）；
//   FILM_CHROMIUM 指到 "Google Chrome for Testing" 是完整 Chrome 的新 headless（product = "Chrome/x"）。
// 实测同为 156.0.8078.4，两者在 demo-tls 上差 5.4%–13.6% 像素、最大 216/255（等宽字体回退选了不同的字形）。
// browser.version() 对两者返回同一个字符串，只记它的话漂移告警会漏掉这种切换。
// 默认形态（headless shell）照旧只记版本号，已有 film.json 的记录不受影响；另一种形态加后缀。
async function chromiumBuild(browser) {
  const v = browser.version();
  try {
    const s = await browser.newBrowserCDPSession();
    const { product } = await s.send('Browser.getVersion');
    await s.detach().catch(() => {});
    if (product && !product.startsWith('HeadlessChrome/')) return `${v} (full Chrome)`;
  } catch {}
  return v;
}

/**
 * 内核在页面脚本执行前注入的只读全局 window.FILM（kernel.md §1）：这次打开实际用的帧率与画幅。
 * fps 缺省 film.json fps；render / seamcheck 的 --fps 覆盖、门 5 按清单重渲时传的是那次实际的 fps。
 * width/height 是画幅的布局尺寸（--scale 只缩截图，不改布局，所以不变）。
 * scale：这次截图的缩放（render --scale 的迭代小样 < 1；定稿、门 1–4、deliver、preview 恒为 1）。场景**可以**在 < 1 时少画像素（stage3d 就这么做），
 * 布局不许变。它只出现在小样里：凡是与定稿对账的东西都在 scale 1 下跑。
 */
export function filmGlobals(film, format, fps = film?.config?.fps, scale = 1) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`未知画幅 ${format}`);
  if (!(Number.isInteger(fps) && fps > 0)) throw new Error(`window.FILM.fps 必须是正整数（收到 ${fps}）`);
  if (!(scale > 0 && scale <= 1)) throw new Error(`window.FILM.scale 必须在 (0, 1]（收到 ${scale}）`);
  return Object.freeze({ fps, width: fmt.width, height: fmt.height, format, scale });
}
/** filmGlobals 的注入脚本（addInitScript 的 content，或 preview 写进页面的 <script>）：不可写、不可重定义 */
export const filmGlobalsScript = (g) =>
  `Object.defineProperty(globalThis,'FILM',{value:Object.freeze(${JSON.stringify({ fps: g.fps, width: g.width, height: g.height, format: g.format, scale: g.scale ?? 1 })}),writable:false,configurable:false,enumerable:true});`;

// 注入到每个页面的探针：记录"禁用 API"在 seek 期间被调用的次数。
// 它不改变行为，只计数 —— 是诊断线索，像素比对才是判据。
const PROBE = () => {
  const P = (window.__filmProbe = { inSeek: false, calls: {} });
  const hit = (name) => { if (P.inSeek) P.calls[name] = (P.calls[name] || 0) + 1; };
  const wrapFn = (obj, key, name) => {
    const orig = obj[key];
    if (typeof orig !== 'function') return;
    obj[key] = function (...a) { hit(name); return orig.apply(this, a); };
  };
  wrapFn(Math, 'random', 'Math.random');
  wrapFn(Date, 'now', 'Date.now');
  wrapFn(performance, 'now', 'performance.now');
  wrapFn(window, 'setTimeout', 'setTimeout');
  wrapFn(window, 'setInterval', 'setInterval');
  wrapFn(window, 'requestAnimationFrame', 'requestAnimationFrame');
  const OrigDate = Date;
  // new Date() 无参 = 读时钟
  window.Date = new Proxy(OrigDate, {
    construct(T, args) { if (args.length === 0) hit('new Date()'); return new T(...args); },
  });
};

/**
 * 打开一个影片的场景页。返回 { page, shot(t), info, errors, close }
 *   film   resolveFilm() 的返回
 *   format 画幅 key
 *   probe  是否注入禁用 API 探针
 *   initScripts  加载前注入的脚本数组（函数 / { path } / { content }），在场景脚本之前执行
 *   png    'fast'（默认）| 'default'：CDP 截图的 PNG 编码方式，见下面 PNG_MODES
 *   record 自带服务器时是否写加载记录 out/.render/runtime.json（默认 true；只读地看别的片子时传 false）
 *   query  额外的 URL 参数 { 名: 值 }（例：{ variant: 'hook-b' }，content.js 读）；值为 null/undefined 的跳过。不给 = URL 与改动前相同
 *   fps    这次按什么帧率截（缺省 film.json fps）：只决定注入的 window.FILM.fps，截哪些 t 仍由调用方决定——两者要一致
 */
export async function openScene(film, format, { browser, probe = false, port, initScripts = [], capture = 'cdp', scale = 1, png = 'fast', record = true, query = {}, fps } = {}) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`未知画幅 ${format}`);
  const FILM = filmGlobals(film, format, fps ?? film.config.fps, scale);
  if (!PNG_MODES.includes(png)) throw new Error(`png 只能是 ${PNG_MODES.join(' / ')}，收到 ${png}`);
  if (png === 'fast' && capture !== 'cdp') png = 'default';   // locator 截图没有这个开关
  const out = scaledSize(fmt, scale);
  if (scale !== 1 && capture !== 'cdp') throw new Error('--scale 只支持 --capture cdp（locator 截图没有任意缩放）');
  const own = !browser;
  let srv;
  if (!port) { srv = await serve(film.dir, { record }); port = srv.port; }   // 自带服务器：同样挂运行时、写加载记录（record:false 不写）
  // 后端：浏览器必须是这支片子声明的那个后端（film.json backend），否则门和渲染测的不是同一支片子。
  // 调用方传来的浏览器后端不符（多半是没按 filmBackend(F) 起浏览器的旧调用点）：不用它，本页自起一个对的，并提示一次。
  const want = filmBackend(film);
  let ownBrowser = own;
  if (!own && browserBackend(browser) !== want) {
    if (!_warnedBackend.has(want)) {
      _warnedBackend.add(want);
      process.stderr.write(`⚠ 本片声明渲染后端 ${want}，调用方传来的浏览器是 ${browserBackend(browser)}：openScene 改为自起 ${want} 浏览器`
        + `（调用方应 launchBrowser({ backend: filmBackend(F) })，否则每页多起一个浏览器）\n`);
    }
    ownBrowser = true;
  }
  if (ownBrowser) {
    try { browser = await launchBrowser({ backend: want }); }
    catch (e) { srv?.close(); throw e; }
  }

  const context = await browser.newContext({ viewport: { width: fmt.width, height: fmt.height }, deviceScaleFactor: 1 });
  await context.addInitScript({ content: filmGlobalsScript(FILM) });   // window.FILM：先于探针与场景的任何脚本
  if (probe) await context.addInitScript(PROBE);
  // 调用方的加载前注入（例如 film-critique 的 fillText 探针）：在场景任何脚本之前执行，
  // 所以场景在加载期缓存的函数引用也是被包过的。元素可以是函数、{ path } 或 { content }（Playwright addInitScript 语义）。
  for (const s of initScripts) await context.addInitScript(s);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 浏览器自己发的 /favicon.ico 请求不算场景错误：实测 Chromium 143/145/151 加载页面时都会请求它，
  // 404 时打一条 console error；156 不请求。不滤掉的话，换一个浏览器构建所有影片都会在加载时被判失败。
  const isFavicon = (m) => { try { return new URL(m.location()?.url ?? '').pathname === '/favicon.ico'; } catch { return false; } };
  page.on('console', (m) => { if (m.type() === 'error' && !isFavicon(m)) errors.push(m.text()); });
  page.on('requestfailed', (r) => errors.push(`请求失败 ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  const close = async () => { await context.close(); if (ownBrowser) await browser.close(); srv?.close(); };

  try {
    const extra = Object.entries(query ?? {}).filter(([, v]) => v != null).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
    await page.goto(`http://127.0.0.1:${port}${film.entryUrl}?format=${format}${extra}`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.seek === 'function', null, { timeout: 15_000 })
      .catch(() => { throw new Error(`场景 15 秒内没有暴露 window.seek(t)${errors.length ? '；页面错误：\n  ' + errors.join('\n  ') : ''}`); });
    // 场景可暴露 window.ready（Promise）等自己的异步资源：字体、纹理、narration.json…
    await page.evaluate(() => window.ready ?? null);
    // canvas 文字在字体就绪前量出来是错的
    await page.evaluate(() => document.fonts.ready.then(() => null));
  } catch (e) { await close(); throw e; }

  if (errors.length) { await close(); throw new Error(`场景加载报错，已中止：\n  ${errors.join('\n  ')}`); }

  const info = await page.evaluate((sel) => ({
    duration: window.DURATION,
    usesWaapi: !!window.USES_WAAPI,
    hasStage: !!document.querySelector(sel),
    cssAnims: document.getAnimations().length,
  }), film.config.stage);
  if (!info.hasStage) { await close(); throw new Error(`页面里没有 ${film.config.stage}（film.json stage），截不了帧`); }
  if (info.cssAnims > 0 && !info.usesWaapi) {
    await close();
    throw new Error(`页面上有 ${info.cssAnims} 个 CSS/WAAPI 动画，但没有声明 window.USES_WAAPI = true。`
      + `\n  不声明的话：locator 截图的 animations:'disabled' 会把它们 finish() 成终态（每帧一样）；`
      + `\n  CDP 截图下它们按真实时间前进（每次渲染不一样）。两种都是静默失败。`);
  }
  // 时长：window.DURATION 是真相源（它通常来自 narration.json 实测）；film.json duration 只是兜底
  let duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : film.config.duration;
  if (!(duration > 0)) { await close(); throw new Error('场景没有给出有效的 window.DURATION，film.json 也没有 duration'); }
  if (film.config.duration && Number.isFinite(info.duration) && Math.abs(info.duration - film.config.duration) > 1e-3) {
    process.stderr.write(`⚠ window.DURATION=${info.duration} 与 film.json duration=${film.config.duration} 不一致，以场景为准\n`);
  }

  const stage = page.locator(film.config.stage);
  // 截图走 CDP Page.captureScreenshot：比 locator.screenshot 快约 2.3 倍（上游实测 14.2 → 32.5 fps，
  // 解码后 RGBA md5 完全一致）。capture:'locator' 退回 Playwright 的实现，用于对照。
  const cdp = capture === 'cdp' ? await context.newCDPSession(page) : null;
  const clip = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
  }, film.config.stage);
  // 缩放在截图这一步：页面照常按全分辨率布局和光栅化，CDP 把截好的图缩小后再编码 PNG。
  // 所以 2D 部分是定稿帧的降采样，不是"另一种渲染"（不改 deviceScaleFactor —— 那会换一条光栅路径，
  // 字形 hinting、细线取整都可能不同）。例外是读了 window.FILM.scale 主动少画像素的层（stage3d 的三维层）：
  // 它们在小样里是低分辨率渲染再放大，省的是 SwiftShader 的光栅时间；定稿不受影响。
  clip.scale = scale;

  // 截一帧。
  // - WAAPI 场景：seek 之后把所有动画 playbackRate 设 0。Playwright 的 animations:'disabled'
  //   会对有限动画 finish()、无限动画 cancel()，但跳过 playbackRate=0 的 —— currentTime 才保得住。
  //   CDP 截图本身不碰动画，但冻结 playbackRate 仍然必要：否则两次 evaluate 之间动画按真实时间前进。
  // - 每帧都等 document.fonts.ready：seek 里第一次用到某个字重/字符时可能触发新的字体加载。
  // advance(t)：shot(t) 去掉截图那一步——页面里执行的东西逐字相同。门 4 用它在不截图的情况下
  // 重放一段"顺序求值的历史"（seamcheck 门 4 的注释）。
  const advance = (t) => page.evaluate(async ([x, waapi]) => {
    const P = window.__filmProbe;
    if (P) P.inSeek = true;
    try { await window.seek(x); } finally { if (P) P.inSeek = false; }
    if (waapi) for (const a of document.getAnimations()) a.playbackRate = 0;
    await document.fonts.ready;
  }, [t, info.usesWaapi]);
  const shot = async (t) => {
    await advance(t);
    if (cdp) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true, captureBeyondViewport: false, ...(png === 'fast' ? { optimizeForSpeed: true } : {}) });
      return Buffer.from(data, 'base64');
    }
    return stage.screenshot({ type: 'png', animations: 'disabled' });
  };

  const probeCalls = () => page.evaluate(() => ({ ...(window.__filmProbe?.calls ?? {}) }));

  return { page, context, shot, advance, info: { ...info, duration }, errors, probeCalls, close, film: FILM, width: fmt.width, height: fmt.height,
    outWidth: out.width, outHeight: out.height, scale, png };
}

// CDP 截图的 PNG 编码方式。像素一样，字节不一样——而渲染清单、分片缓存、门 4/5 比的都是 PNG 字节的 md5。
//   'fast'     optimizeForSpeed:true。实测 weiqi2-l1 单帧 187 → 32 ms，解码后逐像素与 default 相同；
//              同一画面多次截、跨页面、跨启动字节完全相同（仓库 docs/verified/film-motion.md §17），所以字节 md5 照样能当像素指纹用。
//   'default'  不带这个开关（改动前的唯一行为）。老清单都是它截的。
// 规则：凡是要和**以前存下的哈希**对账（渲染清单、分片缓存），按那份记录的模式截；记录里没有这个字段 = 'default'。
// 同一次运行里自己和自己比（门 1–4、render 的重截核对）用哪种都行，默认 fast。
export const PNG_MODES = ['fast', 'default'];
export const pngModeOf = (rec) => rec?.png ?? 'default';

// 缩放后的输出尺寸。yuv420p 要求宽高都是偶数，所以只接受让两边都落在偶数整数上的比例（0.5、0.25、0.75 …）——
// 不悄悄取整：取整会让缩放比例两个方向不一致，画面被轻微拉伸。
export function scaledSize(fmt, scale) {
  if (!(scale > 0 && scale <= 1)) throw new Error(`--scale 必须在 (0, 1]，收到 ${scale}`);
  const w = fmt.width * scale, h = fmt.height * scale;
  const ok = (v) => Math.abs(v - Math.round(v)) < 1e-9 && Math.round(v) % 2 === 0;
  if (!ok(w) || !ok(h)) throw new Error(`--scale ${scale} 让 ${fmt.width}×${fmt.height} 变成 ${w}×${h}，不是偶数整数（yuv420p 要求）。可用 0.5 / 0.25 / 0.75`);
  return { width: Math.round(w), height: Math.round(h) };
}

/**
 * 逐像素比较两张 PNG（在浏览器里解码，避免引第三方 PNG 库）。
 * 返回 { diff: 不同像素数, max: 最大通道差 0-255, total }
 */
export async function makeComparer(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<canvas id=a></canvas>');
  const compare = async (a, b) => {
    if (a.equals(b)) return { diff: 0, max: 0, total: null, identical: true };
    return page.evaluate(async ([a64, b64]) => {
      const dec = async (s) => createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob());
      const [A, B] = await Promise.all([dec(a64), dec(b64)]);
      if (A.width !== B.width || A.height !== B.height) return { diff: -1, max: 255, total: 0, sizeMismatch: true };
      const px = (bm) => { const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
      const da = px(A), db = px(B);
      let diff = 0, max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
        if (d) { diff++; if (d > max) max = d; }
      }
      return { diff, max, total: da.length / 4, identical: diff === 0 };
    }, [a.toString('base64'), b.toString('base64')]);
  };
  return { compare, close: () => ctx.close() };
}
