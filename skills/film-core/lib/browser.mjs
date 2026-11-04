// film-core lib · 浏览器：唯一的 launchBrowser()，以及打开场景、按 t 截帧（openScene）、逐像素比较（makeComparer）。
// 全套件的 chromium.launch 只在这里出现：渲染、门、静帧、评审用同一套启动参数和同一个浏览器构建，
// 否则"检查时看到的帧"和"成片里的帧"不是同一个东西。WAAPI 的冻结也只在这里写一次。
import { statSync, accessSync, readdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, playwrightVersion } from './env.mjs';
import { FORMATS } from '../assets/runtime/layout.js';

export { FORMATS };

// 固定的启动参数：像素由 Chromium 光栅化决定，参数变了字形抗锯齿就可能变。
// --font-render-hinting=none 关掉平台相关的字形 hinting（主要影响 Linux；macOS 上无害）。
export const LAUNCH_ARGS = ['--font-render-hinting=none'];

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
/**
 * 起一个浏览器。渲染、seamcheck、字体来源、评审、静帧……全部经它，参数一律 LAUNCH_ARGS。
 * extraArgs 只给开发基准（dev/ 下的 bench）用，**门和渲染不许传**——传了"检查的条件"就不再是"渲染的条件"。
 */
export async function launchBrowser({ extraArgs = [] } = {}) {
  const exe = chromiumOverride();
  const args = [...LAUNCH_ARGS, ...extraArgs];
  if (!exe) return (await playwright()).chromium.launch({ args });
  if (!_warnedOverride) {
    _warnedOverride = true;
    process.stderr.write(`⚠ ${CHROMIUM_ENV} 已设置：用 ${exe} 而不是 Playwright 默认的 Chromium（验证用，日常渲染不要设）\n`);
  }
  try {
    return await (await playwright()).chromium.launch({ args, executablePath: exe });
  } catch (e) {
    throw new Error(`${CHROMIUM_ENV}=${exe} 启动失败（版本差太多时 Playwright 的协议可能不兼容）：\n  ${String(e.message).split('\n')[0]}`);
  }
}

// 渲染环境指纹：写进 film.json 的 renderer 字段，用来发现"换了浏览器版本，像素可能变了"
export async function rendererFingerprint(browser) {
  const pw = playwrightVersion();
  return { chromium: await chromiumBuild(browser), playwright: pw, args: LAUNCH_ARGS };
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
 */
export async function openScene(film, format, { browser, probe = false, port, initScripts = [], capture = 'cdp', scale = 1, png = 'fast', record = true, query = {} } = {}) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`未知画幅 ${format}`);
  if (!PNG_MODES.includes(png)) throw new Error(`png 只能是 ${PNG_MODES.join(' / ')}，收到 ${png}`);
  if (png === 'fast' && capture !== 'cdp') png = 'default';   // locator 截图没有这个开关
  const out = scaledSize(fmt, scale);
  if (scale !== 1 && capture !== 'cdp') throw new Error('--scale 只支持 --capture cdp（locator 截图没有任意缩放）');
  const own = !browser;
  let srv;
  if (!port) { srv = await serve(film.dir, { record }); port = srv.port; }   // 自带服务器：同样挂运行时、写加载记录（record:false 不写）
  if (own) browser = await launchBrowser();

  const context = await browser.newContext({ viewport: { width: fmt.width, height: fmt.height }, deviceScaleFactor: 1 });
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

  const close = async () => { await context.close(); if (own) await browser.close(); srv?.close(); };

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
  // 缩放只发生在截图这一步：页面照常按全分辨率布局和光栅化，CDP 把截好的图缩小后再编码 PNG。
  // 所以缩小版是定稿帧的降采样，不是"另一种渲染"（不改 deviceScaleFactor —— 那会换一条光栅路径，
  // 字形 hinting、细线取整都可能不同，迭代时看到的就不是定稿会出来的东西）。
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

  return { page, context, shot, advance, info: { ...info, duration }, errors, probeCalls, close, width: fmt.width, height: fmt.height,
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
