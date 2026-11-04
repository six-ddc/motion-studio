#!/usr/bin/env node
// 字体来源检查：这支片子画出来的每一个字，是不是都由随片打包（films/<slug>/assets/）的字体画的。
//
//   node <film-core>/scripts/font_source.mjs --film <slug> [--step 0.25] [--format 16x9] [--static-only]
//
// 内核门（references/kernel.md §2「字体随片打包」）：有入口页的片子永远开。字体文件从哪来、怎么子集化归 film-assets，
// 这里只判"画出来的字是不是随片字体画的"。托管与起浏览器走 lib/serve.mjs + lib/browser.mjs，与渲染同一条件。
//
// 为什么要它：用系统字体（PingFang、微软雅黑……）渲出来的片子，换台机器重渲就是另一套字形，
// 而且没有任何报错。静态 grep 抓不全——字体名常常是变量拼出来的（`${weight} ${fs}px ${CAPTION.font}`），
// 所以判定在浏览器里做：真的加载场景、真的 seek，记下每次 fillText/strokeText 用的字体栈和字，再逐条判。
//
// 判定（任何一条不过 = exit 1）：
//   1. 随片字体族 = 所有 face 的来源都是本片 assets/ 下真实存在的文件（@font-face 或 new FontFace(url)）。
//      local()、外链、文件不存在、指到 assets/ 外 → 这个族不算随片。
//   2. 每条实际用到的字体栈里，**排在第一个随片族前面**的族名：
//      通用族（sans-serif…）/ 本机装了的字体 / 已知的系统字体名 → 不合格（它会抢先画字）。
//      都不是（拼错或别的机器才有的名字）→ 警告。
//   3. 栈里没有任何随片族 → 不合格（整串字都由系统字体画）。
//   4. 逐字验证：只留栈里的随片族，后面接 7 组不同的回退栈各画一次，像素不一致 = 这个字随片字体没有、
//      回退到了系统字体 → 不合格并列出这些字。
//   5. DOM/SVG 文字：CDP CSS.getPlatformFontsForNode 直接问 Chromium 这段字用了哪些字体，
//      出现 isCustomFont=false（系统字体）→ 不合格。每个采样时刻扫当前在文档里、看得见的元素，
//      按"字体样式 + 字"去重（不按元素身份：每帧克隆舞台的片子每帧都是新元素），没问过的字才问。
//   6. 加载晚：初次就绪（window.ready + document.fonts.ready）之后，seek 期间还有 FontFace 从 unloaded
//      变成 loading/loaded（unicode-range 分片第一次被用到），或还有字体文件请求 → 不合格，并列出触发它的字。
//      字不缺，只是来得晚：第一次画到它的那一帧用回退字体画、同时触发加载，下一帧才对。
//      判定 1–5 全过也会这样（它们只问"最后是谁画的"），seamcheck 门 1a/2 看得到症状但说不出是哪些字。
// 静态层（不开浏览器也跑）：local()、外链/缺失的 @font-face 文件 → 不合格；代码里出现的系统字体名列出行号
// （浏览器层是裁判；--static-only 时这些命中直接判不合格，因为没人复核）。
//
// 不查：授权与台账（audit.mjs）、字够不够（subset_font.py --check）。
// 已知盲区：只看采样时刻画过的字（--step 越小越全）；Worker 里的 OffscreenCanvas、WebGL 自己栅格化的字看不到。
//   判定 6 同理：只在某个采样时刻第一次画到的分片才抓得到；只在两个采样时刻之间出现的字，它触发的晚加载看不到。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GENERIC, SYSTEM_FONT_RE } from '../lib/fontcss.mjs';
import { FILM_OPTS, parseArgs, resolveFilm as coreResolve, fail } from '../lib/film.mjs';
import { serve } from '../lib/serve.mjs';
import { launchBrowser, FORMATS } from '../lib/browser.mjs';

const die = (msg, code = 2) => fail(msg, code);
const A = parseArgs({
  usage: 'node font_source.mjs --film <slug> [--step 0.25] [--format 16x9] [--entry x.html] [--static-only]',
  about: '字体来源检查：片子画出的每个字是否都由随片打包（assets/）的字体画。任何一条判定不过 exit 1。',
  opts: {
    ...FILM_OPTS,
    entry: ['<x.html>', '临时换入口（测试变体）'],
    step: ['<秒>', '采样间隔（默认 0.25；越小越全）'],
    format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    'static-only': '只做静态层（不开浏览器），命中直接判不合格',
  },
});
let F;
try { F = coreResolve(A.film, A); } catch (e) { die(e.message); }
F.path = (p) => (isAbsolute(p) ? p : join(F.dir, p));
const film = F.raw;
const entry = F.config.entry;
const format = A.flag('format', null) ?? F.config.format;
const step = Number(A.flag('step', 0.25));
const staticOnly = A.has('static-only');
const assetsDir = F.path('assets') + sep;

const errors = [], warns = [];
const rel = (p) => relative(F.dir, p) || '.';
const inAssets = (p) => resolve(p).startsWith(assetsDir);

// ───────────────────────── 静态层 ─────────────────────────
const SKIP = new Set(['out', 'node_modules', 'tools', 'tests', 'docs', '_incoming']);
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return n.startsWith('.') || SKIP.has(n) ? [] : walk(p);
  return /\.(html?|m?js|css)$/.test(n) ? [p] : [];
});
// 去注释但保留换行，行号才对得上
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, a) => a + blank(m.slice(a.length)));
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

const staticHits = []; // { file, line, name }
for (const p of walk(F.dir)) {
  const s = stripComments(readFileSync(p, 'utf8')), r = rel(p);
  for (const m of s.matchAll(/local\(\s*['"]?([^'")]+)/g))
    errors.push(`${r}:${lineOf(s, m.index)}  local(${m[1]}) —— 取的是本机装的字体，不随片`);
  // @font-face 的 url：CSS 文件相对它自己，HTML 里的相对页面
  for (const m of s.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    for (const u of m[1].matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)) {
      const url = u[1], line = lineOf(s, m.index + u.index);
      if (/^https?:/i.test(url)) { errors.push(`${r}:${line}  @font-face 外链 ${url} —— 下载进 assets/fonts/`); continue; }
      if (/^data:/i.test(url)) continue;
      const base = /\.css$/.test(p) ? join(p, '..') : join(F.path(entry), '..');
      const file = resolve(base, url.split(/[?#]/)[0]);
      if (!existsSync(file)) errors.push(`${r}:${line}  @font-face 指向不存在的文件 ${url}`);
      else if (!inAssets(file)) errors.push(`${r}:${line}  @font-face 文件 ${rel(file)} 不在 assets/ 下（不进台账、不随片管理）`);
    }
  }
  // 代码里出现的系统字体名：字符串字面量 + CSS 的 font / font-family 值
  const cands = [...s.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => [m.index, m[2]]);
  if (/\.(css|html?)$/.test(p)) for (const m of s.matchAll(/font(?:-family)?\s*:\s*([^;{}]+)/gi)) cands.push([m.index, m[1]]);
  for (const [i, str] of cands) {
    for (const piece of str.split(',')) {
      const name = piece.trim().replace(/^.*\d(?:px|pt|em|rem|%)\s+/, '').replace(/^['"]|['"]$/g, '').trim();
      if (name && SYSTEM_FONT_RE.test(name)) staticHits.push({ file: r, line: lineOf(s, i), name });
    }
  }
}
const uniqHits = [...new Map(staticHits.map((h) => [`${h.file}:${h.line}:${h.name}`, h])).values()];

// ───────────────────────── 浏览器层 ─────────────────────────

let report = null;
if (!staticOnly) report = await runBrowser();

// 系统字体名命中：浏览器层确认过用到的已经单独报了；没用到的只提醒（可能是死代码或 if 分支没走到）
const usedNames = new Set(report?.usedNames ?? []);
const unconfirmed = uniqHits.filter((h) => !usedNames.has(h.name.toLowerCase()));
if (staticOnly || !report ? uniqHits.length : unconfirmed.length) {
  const list = (staticOnly || !report ? uniqHits : unconfirmed).map((h) => `${h.file}:${h.line} "${h.name}"`).join('、');
  if (staticOnly || !report) errors.push(`代码里写了系统字体名（没有浏览器复核，按不合格算）：${list}`);
  else warns.push(`代码里写了系统字体名，采样时刻没有用它画字（死代码？没采到的分支？）：${list}`);
}
// 授权文本随附（OFL 等要求随字体分发）：查不到只警告，台账与授权由 audit.mjs / LICENSES.md 负责
const fontFiles = existsSync(F.path('assets/fonts')) ? walkAll(F.path('assets/fonts')).filter((p) => /\.(woff2?|ttf|otf|ttc)$/i.test(p) && !p.includes(`${sep}src${sep}`)) : [];
const licFiles = existsSync(F.path('assets/fonts')) ? walkAll(F.path('assets/fonts')).filter((p) => /^(licen[cs]e|ofl|copying)/i.test(p.split(sep).pop())) : [];
if (fontFiles.length && !licFiles.length)
  warns.push(`assets/fonts/ 有 ${fontFiles.length} 个字体文件，但没有许可文本（LICENSE / OFL.txt）。OFL 要求随附，台账见 audit.mjs`);

// ───────────────────────── 报告 ─────────────────────────
console.log(`字体来源检查  ${F.slug}（${entry}，${format}${report ? `，seek ${report.seeks} 次，步长 ${report.step}s，时长 ${report.duration}s` : staticOnly ? '，仅静态' : '，浏览器层失败，只有静态结果'}）`);
if (report) {
  console.log('随片字体族：');
  if (!report.families.length) console.log('  （无）');
  for (const f of report.families) console.log(`  ${f.bundled ? '✓' : '✗'} "${f.family}"  ${f.faces} 个 face：${f.where}`);
  console.log('实际画字用到的字体栈：');
  if (!report.stacks.length) console.log('  （采样时刻没有 canvas 画字）');
  // 字重/字号动画会产生几十条只差数字的栈：判定逐条做，显示按族名列表合并
  const groups = new Map();
  for (const s of report.stacks) {
    const k = s.font.replace(/^.*?\d+(?:\.\d+)?px(?:\s*\/\s*\S+)?\s+/, '');
    const g = groups.get(k) ?? { fonts: [], calls: 0, chars: 0, ok: true };
    g.fonts.push(s.font); g.calls += s.calls; g.chars = Math.max(g.chars, s.chars); g.ok &&= s.ok;
    groups.set(k, g);
  }
  for (const [k, g] of groups) console.log(`  ${g.ok ? '✓' : '✗'} ${k}  ${g.fonts.length > 1 ? `${g.fonts.length} 种字重/字号，` : `${g.fonts[0].replace(k, '').trim()}，`}${g.calls} 次 fillText/strokeText，最多 ${g.chars} 个不同字${g.ok ? '，全部由随片字体画出' : ''}`);
  if (report.dom.length) {
    console.log('DOM/SVG 文字（Chromium 报告的实际字体）：');
    for (const d of report.dom) console.log(`  ${d.ok ? '✓' : '✗'} ${JSON.stringify(d.text.slice(0, 24))}  ${d.fonts}`);
  }
}
for (const w of warns) console.error(`⚠ ${w}`);
for (const e of errors) console.error(`✗ ${e}`);
const nLate = errors.filter((e) => e.startsWith('seek 期间')).length;
if (errors.length) die(`${F.slug}: 字体不合格（${errors.length} 条）。${errors.length > nLate ? '换台机器重渲，字形会变' : ''}${nLate ? `${errors.length > nLate ? '；' : ''}${nLate} 条是字体来得晚：有几帧是回退字体画的` : ''}`, 1);
console.log(staticOnly
  ? `✓ ${F.slug}: 静态层没发现本机/外链字体（未经浏览器复核：变量拼出的字体名、缺字回退都查不到）`
  : `✓ ${F.slug}: 画出来的字全部来自随片字体（assets/）`);

function walkAll(d) {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walkAll(p) : [p]; });
}

async function runBrowser() {
  // 与渲染同一种托管（./runtime/* 片内优先、否则套件）和同一种浏览器（launchBrowser）
  const server = await serve(F.dir);
  const origin = server.url;
  const browser = await launchBrowser();
  try {
    const { width, height } = FORMATS[format] ?? die(`未知画幅 ${format}`);
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const fontRequests = [];
    page.on('request', (r) => { if (r.resourceType() === 'font' || /\.(woff2?|ttf|otf)(?:[?#]|$)/i.test(r.url())) fontRequests.push(r.url()); });
    await page.addInitScript(HOOK);
    await page.goto(`${origin}/${entry}?format=${format}`, { waitUntil: 'load' });
    try { await page.evaluate(() => window.ready ?? null); } catch (e) {
      errors.push(`window.ready 失败，浏览器层没跑：${e.message.replace(/^page\.evaluate:\s*/, '')}（字体加载失败常见于 local() / 文件路径错）`);
      return null;
    }
    await page.evaluate(() => document.fonts.ready.then(() => null));
    const duration = await page.evaluate(() => (typeof window.seek === 'function' ? window.DURATION : null));
    if (duration === null) die(`${entry} 没有暴露 window.seek`, 1);
    const dur = Number(duration ?? film.duration);
    if (!(dur > 0)) die('拿不到时长：window.DURATION 和 film.json 的 duration 都没有');
    const eff = Math.max(step, dur / 800);
    const times = [];
    for (let t = 0; t < dur; t += eff) times.push(Number(t.toFixed(4)));
    times.push(dur);

    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const domSeen = new Map();
    // DOM 文字已问过的字：样式键 → 字集合。上限按"问 Chromium 的次数"计，超了明说，不静默截断
    const domChars = new Map(), DOM_MAX = 5000;
    let domAsked = 0, domSkipped = 0;
    // 判定 6 的基线：初次就绪之后的 FontFace 状态和字体请求数。此后的变化都算"seek 期间才加载"
    await page.evaluate(lateBaseline);
    const reqBase = fontRequests.length;
    for (const t of times) {
      try {
        await page.evaluate(async (t) => {
          const S = window.__fs; S.cur = [];
          S.on = true; try { await window.seek(t); } finally { S.on = false; }
          void document.body?.offsetHeight; // DOM 文字的字体在排版时才触发加载：强制排版，让它落在这一次 seek 名下
          S.scanLate(t);
        }, t);
      } catch (e) { die(`seek(${t}) 抛错：${e.message}`, 1); }
      // DOM/SVG 文字：问 Chromium 实际用了哪些字体。
      // 去重按"字体样式 + 字"，不按元素身份：每次 seek 克隆整棵舞台的片子（freshStage 写法）每帧都是新元素，
      // 按元素去重再配一个总额，额度几秒就被同一批字用光，后面才出现的字根本没人问（漏检过「飞船」「−」）。
      // 同一组样式下已经问过的字不再问；一个元素只要带来一个没问过的字就整段问一次。
      const els = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
          if (/^(SCRIPT|STYLE|CANVAS|TEMPLATE)$/.test(el.tagName)) continue;
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
          if (!own || !el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden') continue;
          // 每次重新编号：克隆来的元素会连 data-fsid 一起抄走，沿用旧号会让 querySelector 拿到别的元素
          el.dataset.fsid = String(window.__fs.ids++);
          const style = [cs.fontFamily, cs.fontWeight, cs.fontStyle, cs.fontStretch, el.closest('[lang]')?.getAttribute('lang') ?? ''].join('|');
          out.push({ id: el.dataset.fsid, text: own, style });
        }
        return out;
      });
      const fresh = [];
      for (const e of els) {
        const seen = domChars.get(e.style) ?? new Set();
        const chars = [...e.text].filter((c) => !/\s/u.test(c) && !seen.has(c));
        if (!chars.length) continue;
        if (domAsked >= DOM_MAX) { domSkipped++; continue; }
        domAsked++;
        for (const c of chars) seen.add(c);   // 同一帧里后面的元素就不再为这些字重复问
        domChars.set(e.style, seen);
        fresh.push(e);
      }
      if (fresh.length) {
        const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
        for (const e of fresh) {
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-fsid="${e.id}"]` });
          if (!nodeId) continue;
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          domSeen.set(`${e.style}|${e.text}`, { text: e.text, fonts });
        }
      }
    }
    if (domSkipped) warns.push(`DOM/SVG 文字：问了 ${DOM_MAX} 次之后还有 ${domSkipped} 段带新字的文字没查（字太多？逐帧变化的随机串？）`);
    if (pageErrors.length) warns.push(`页面报错 ${pageErrors.length} 条，首条：${pageErrors[0]}`);

    // ── 6. 加载晚（必须在 judgeStacks 之前收：它自己会 document.fonts.load）
    await page.evaluate(() => document.fonts.ready.then(() => null)); // 让 seek 触发的请求都落地、request 事件都到
    const late = await page.evaluate(() => window.__fs.lateAll());
    const lateReqs = fontRequests.slice(reqBase).map((u) => decodeURIComponent(new URL(u).pathname).split('/').pop());
    const show = (s) => [...s].map((c) => (c === ' ' ? '␠' : c)).join('');
    for (const l of late) {
      const who = l.chars == null ? '没有截到触发它的 fillText/strokeText（DOM/SVG 文字？或在 Worker 里画的？）'
        : l.chars ? `首次由这些字触发：${show(l.chars)}${l.all && l.all !== l.chars ? `（全片采样里用这款字画过、落在这个分片的字：${show(l.all)}）` : ''}`
        : '这一次 seek 画的字里没有落在它 unicode-range 里的（DOM/SVG 文字触发？）';
      errors.push(`seek 期间才加载字体（初次就绪之后）：t=${l.t}s 起 "${l.family}" ${l.weight} ${l.style}` +
        `${l.range && l.range !== 'U+0-10FFFF' ? ` 分片 ${l.range.length > 60 ? l.range.slice(0, 60) + '…' : l.range}` : ''}${l.added ? '（seek 里才 add 进 document.fonts）' : ''}，${who}。` +
        `这一帧用回退字体画、同时触发加载，之后的帧才对——确定性失败（seamcheck 门 1a/2 看到的就是它）。` +
        `修法：把这些字列进 loadFonts；运行时拼出来的字（数字、计数）可以按类声明 [font, { text, sets: ['digits'] }]，参见 film-typography text.js`);
    }
    if (lateReqs.length && !late.length)
      errors.push(`seek 期间请求了字体文件（初次就绪之后）：${[...new Set(lateReqs)].slice(0, 6).join('、')}${lateReqs.length > 6 ? '…' : ''}，但 document.fonts 里没看到哪个 FontFace 开始加载（字体在别的文档/Worker 里？）。来得晚的字体会让那几帧用回退字体画`);
    else if (lateReqs.length) warns.push(`seek 期间的字体请求：${[...new Set(lateReqs)].slice(0, 6).join('、')}${lateReqs.length > 6 ? '…' : ''}（对应下面的"加载晚"）`);

    const state = await page.evaluate(collectFaces);
    // ── 1. 每个字体族的来源
    const fams = new Map();
    const add = (family, src, how) => {
      const k = family.replace(/^['"]|['"]$/g, '').toLowerCase();
      if (!fams.has(k)) fams.set(k, { family: family.replace(/^['"]|['"]$/g, ''), sources: [] });
      fams.get(k).sources.push({ ...classify(src, origin, fontRequests), how });
    };
    for (const f of state.css) add(f.family, f.src, '@font-face');
    for (const f of state.ctor) add(f.family, f.src, 'new FontFace');
    for (const e of state.cssErrors) warns.push(`读不到样式表 ${e}（跨域？），其中的 @font-face 没查`);
    const families = [...fams.values()].map((f) => {
      const bad = f.sources.filter((s) => !s.ok);
      const byWhy = new Map();
      for (const s of bad) byWhy.set(`${s.how}|${s.why}`, (byWhy.get(`${s.how}|${s.why}`) ?? 0) + 1);
      for (const [k, n] of byWhy) { const [how, why] = k.split('|'); errors.push(`字体族 "${f.family}" 有 ${n} 个 ${how} 来源不随片：${why}`); }
      for (const s of f.sources.filter((s) => s.ok && s.warn)) warns.push(`字体族 "${f.family}"：${s.warn}`);
      const where = [...new Set(f.sources.map((s) => s.where))].join('；');
      return { family: f.family, faces: f.sources.length, bundled: !bad.length, where };
    });
    const loaded = new Map(state.status.map((s) => [s.family.replace(/^['"]|['"]$/g, '').toLowerCase(), s]));
    const bundled = families.filter((f) => f.bundled).map((f) => f.family.toLowerCase());
    for (const b of bundled) {
      const st = loaded.get(b);
      if (st && st.error === st.total) errors.push(`随片字体族 "${b}" 的 ${st.total} 个 face 全部加载失败`);
    }

    // ── 2-4. 每条实际用到的字体栈
    const verdicts = await page.evaluate(judgeStacks, {
      draws: state.draws, bundled, declared: [...fams.keys()], generic: [...GENERIC], systemRe: SYSTEM_FONT_RE.source,
    });
    const stacks = [];
    for (const v of verdicts) {
      let ok = true;
      if (!v.hasBundled) {
        // 整条栈没有随片字体：合成一条说清楚，每个族名是什么
        ok = false;
        const who = v.pre.map((p) => `"${p.name}" ${p.short}`).join('，');
        errors.push(`字体栈 ${v.font}：没有任何随片字体，${v.chars} 个字全部由系统字体画出（例：${v.sample}）。${who}`);
      } else {
        for (const p of v.pre) {
          if (p.kind === 'warn') { warns.push(`字体栈 ${v.font}：排在随片字体前的 "${p.name}" ${p.why}`); continue; }
          ok = false; errors.push(`字体栈 ${v.font}：排在随片字体前的 "${p.name}" ${p.why}`);
        }
        if (v.miss.length) {
          ok = false;
          errors.push(`字体栈 ${v.font}：${v.miss.length} 个字随片字体里没有，回退到了系统字体：${v.miss.join('')}`);
        }
      }
      stacks.push({ font: v.font, calls: v.calls, chars: v.chars, ok });
    }
    // ── 5. DOM 文字
    const dom = [...domSeen.values()].map(({ text, fonts }) => {
      const sys = fonts.filter((f) => !f.isCustomFont);
      for (const f of sys) errors.push(`DOM 文字 ${JSON.stringify(text.slice(0, 24))}：${f.glyphCount} 个字形由系统字体 "${f.familyName}" 画出`);
      return { text, ok: !sys.length, fonts: fonts.map((f) => `${f.familyName}${f.isCustomFont ? '' : '（系统）'}×${f.glyphCount}`).join(', ') };
    });
    if (!stacks.length && !dom.length) warns.push('采样时刻没有画任何字。如果片子有字，可能在 Worker / WebGL 里画，本检查看不到');
    const usedNames = [...verdicts.flatMap((v) => v.families), ...[...domSeen.values()].flatMap((d) => d.fonts.map((f) => f.familyName))]
      .map((n) => n.toLowerCase());
    return { seeks: times.length, step: Number(eff.toFixed(3)), duration: dur, families, stacks, dom, usedNames, late: late.length };
  } finally {
    await browser.close();
    server.close();
  }
}

/** 一个字体来源算不算随片：本片 assets/ 下真实存在的文件才算。 */
function classify(src, origin, fontRequests) {
  if (src.local) return { ok: false, why: `local(${src.local})`, where: `local(${src.local})` };
  if (src.binary) {
    // new FontFace(name, ArrayBuffer)：字节从哪来看不见，退而看页面请求过的字体文件是不是都在 assets/ 里
    const outside = fontRequests.filter((u) => !u.startsWith(origin) || !inAssets(join(F.dir, decodeURIComponent(new URL(u).pathname))));
    if (outside.length) return { ok: false, why: `ArrayBuffer 来源，且页面请求过 assets/ 以外的字体 ${outside[0]}`, where: 'ArrayBuffer' };
    return { ok: true, where: 'ArrayBuffer', warn: '用 ArrayBuffer 构造，来源按"页面请求过的字体文件都在 assets/"推断；改用 url() 可直接证明' };
  }
  const u = src.url;
  if (u.startsWith('data:')) return { ok: true, where: 'data: 内嵌', warn: 'data: 内嵌字体，台账里记不了文件，建议拆成 assets/fonts/ 下的文件' };
  if (!u.startsWith(origin)) return { ok: false, why: `外链 ${u}`, where: u };
  const file = join(F.dir, decodeURIComponent(new URL(u).pathname));
  if (!existsSync(file)) return { ok: false, why: `文件不存在 ${rel(file)}`, where: rel(file) };
  if (!inAssets(file)) return { ok: false, why: `${rel(file)} 不在 assets/ 下`, where: rel(file) };
  const r = rel(file);
  return { ok: true, where: r.includes('/') ? r.slice(0, r.lastIndexOf('/') + 1) : r };
}

// ───────────── 以下函数在页面里执行 ─────────────
function HOOK() {
  const S = window.__fs = { on: false, draws: {}, ctor: [], ids: 0, cur: [], late: [], known: null };
  const rec = (ctx, text) => {
    if (!S.on || text == null) return;
    const d = S.draws[ctx.font] ??= { calls: 0, chars: {} };
    d.calls++;
    for (const ch of String(text)) d.chars[ch] = 1;
    S.cur.push([ctx.font, String(text)]);
  };
  // 判定 6：每次 seek 之后比 FontFace 状态。FontFace.status 在 fillText 触发加载时**同步**变成 loading
  // （实测：seek 返回前就变了，请求随后才发），所以能按 seek 归属，不用猜请求是哪一帧发的。
  const famOf = (font) => {
    const m = /\d(?:\.\d+)?px(?:\s*\/\s*\S+)?\s+(.+)$/.exec(font);
    return m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '').toLowerCase()) : [];
  };
  const inRange = (range) => {
    const rs = String(range || 'U+0-10FFFF').split(',').map((p) => {
      const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(p.trim()); if (!m) return null;
      const a = parseInt(m[1].replace(/\?/g, '0'), 16), b = m[2] ? parseInt(m[2], 16) : m[1].includes('?') ? parseInt(m[1].replace(/\?/g, 'f'), 16) : a;
      return [a, b];
    }).filter(Boolean);
    return (ch) => { const cp = ch.codePointAt(0); return rs.some(([a, b]) => cp >= a && cp <= b); };
  };
  S.scanLate = (t) => {
    if (!S.known) return;
    for (const f of document.fonts) {
      const was = S.known.get(f);
      S.known.set(f, f.status);
      if (was !== undefined && was !== 'unloaded') continue;
      if (f.status === 'unloaded') continue;
      const fam = f.family.replace(/^['"]|['"]$/g, '').toLowerCase(), hit = inRange(f.unicodeRange);
      let chars = S.cur.length ? '' : null;
      const seen = new Set();
      for (const [font, text] of S.cur) {
        if (!famOf(font).includes(fam)) continue;
        for (const ch of text) if (!seen.has(ch) && hit(ch)) { seen.add(ch); chars += ch; }
      }
      S.late.push({ t, family: f.family.replace(/^['"]|['"]$/g, ''), fam, weight: f.weight, style: f.style, range: f.unicodeRange, added: was === undefined, chars });
    }
  };
  S.lateAll = () => S.late.map((l) => {
    const hit = inRange(l.range); let all = '';
    for (const [font, d] of Object.entries(S.draws)) if (famOf(font).includes(l.fam)) for (const ch of Object.keys(d.chars)) if (hit(ch) && !all.includes(ch)) all += ch;
    return { ...l, all };
  });
  for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    if (!C) continue;
    for (const m of ['fillText', 'strokeText']) {
      const orig = C.prototype[m];
      C.prototype[m] = function (text, ...rest) { rec(this, text); return orig.call(this, text, ...rest); };
    }
  }
  const Orig = window.FontFace;
  window.FontFace = new Proxy(Orig, { construct(T, a, nt) {
    S.ctor.push({ family: String(a[0]), source: typeof a[1] === 'string' ? a[1] : null });
    return Reflect.construct(T, a, nt);
  } });
}

function lateBaseline() {
  const S = window.__fs;
  S.known = new Map([...document.fonts].map((f) => [f, f.status]));
  S.late = [];
}

function collectFaces() {
  const parseSrc = (src, base) => {
    const out = [];
    for (const m of src.matchAll(/local\(\s*['"]?([^'")]+)['"]?\s*\)|url\(\s*['"]?([^'")]+?)['"]?\s*\)/g))
      out.push(m[1] ? { local: m[1] } : { url: new URL(m[2], base).href });
    return out;
  };
  const css = [], cssErrors = [];
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r instanceof CSSFontFaceRule) {
        for (const s of parseSrc(r.style.getPropertyValue('src'), base)) css.push({ family: r.style.getPropertyValue('font-family'), src: s });
      } else if (r instanceof CSSImportRule && r.styleSheet) walk(r.styleSheet.cssRules, r.styleSheet.href ?? base);
      else if (r.cssRules) walk(r.cssRules, base);
    }
  };
  for (const sh of document.styleSheets) {
    try { walk(sh.cssRules, sh.href ?? document.baseURI); } catch { cssErrors.push(sh.href); }
  }
  const ctor = window.__fs.ctor.flatMap((c) => (c.source === null
    ? [{ family: c.family, src: { binary: true } }]
    : parseSrc(c.source, document.baseURI).map((src) => ({ family: c.family, src }))));
  const status = {};
  for (const f of document.fonts) {
    const s = status[f.family] ??= { family: f.family, total: 0, error: 0 };
    s.total++; if (f.status === 'error') s.error++;
  }
  const draws = Object.entries(window.__fs.draws).map(([font, d]) => ({ font, calls: d.calls, chars: Object.keys(d.chars).join('') }));
  return { css, cssErrors, ctor, status: Object.values(status), draws };
}

async function judgeStacks({ draws, bundled, declared, generic, systemRe }) {
  const B = new Set(bundled), D = new Set(declared), G = new Set(generic), SYS = new RegExp(systemRe, 'i');
  // 必须挂进文档：未挂载的 canvas 上不同 generic 的 CJK 回退会落到同一款字体，比不出差别
  const cv = document.createElement('canvas');
  cv.width = 160; cv.height = 160;
  cv.style.cssText = 'position:fixed;left:-400px;top:0;visibility:hidden';
  document.body.append(cv);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const FALLBACKS = ['serif', 'sans-serif', 'monospace', 'cursive', '"Songti SC", "SimSun", serif',
    '"PingFang SC", "Microsoft YaHei", sans-serif', '"Kaiti SC", "KaiTi", cursive'];
  const px = (font, ch) => { ctx.clearRect(0, 0, 160, 160); ctx.font = font; ctx.fillText(ch, 16, 120); return ctx.getImageData(0, 0, 160, 160).data; };
  const same = (a, b) => { for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false; return true; };
  const q = (f) => `"${f.replace(/"/g, '\\"')}"`;
  // 本机有没有这个族：拿它当首选、配 7 组不同回退，像素全一样 = 是它自己画的
  const installed = (fam) => ['永', 'Ag'].some((ch) => {
    const bare = FALLBACKS.map((fb) => px(`64px ${fb}`, ch));
    if (bare.every((x) => same(x, bare[0]))) return false;
    const r = FALLBACKS.map((fb) => px(`64px ${q(fam)}, ${fb}`, ch));
    return r.every((x) => same(x, r[0]));
  });
  const split = (list) => {
    const out = []; let cur = '', qq = null;
    for (const ch of list) {
      if (qq) { if (ch === qq) qq = null; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { qq = ch; continue; }
      if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
    return out;
  };
  const out = [];
  for (const d of draws) {
    const m = /^(.*?)(\d+(?:\.\d+)?)px(?:\s*\/\s*\S+)?\s+(.+)$/.exec(d.font);
    const chars = [...d.chars].filter((c) => !/[\s\p{Cc}\p{Cf}]/u.test(c));
    const v = { font: d.font, calls: d.calls, chars: chars.length, sample: chars.slice(0, 12).join(''), pre: [], hasBundled: false, miss: [], families: [] };
    out.push(v);
    if (!m) { v.pre.push({ name: d.font, kind: 'error', short: '看不懂', why: '看不懂的 font 串' }); continue; }
    const [, head, , list] = m;
    const fams = split(list);
    v.families = fams;
    const inStack = fams.filter((f) => B.has(f.toLowerCase()));
    v.hasBundled = inStack.length > 0;
    for (const f of fams) {
      const k = f.toLowerCase();
      if (B.has(k)) break;
      if (D.has(k)) v.pre.push({ name: f, kind: 'error', short: '来源不随片', why: '声明了，但来源不随片（见上面的族来源）' });
      else if (G.has(k)) v.pre.push({ name: f, kind: 'error', short: '是通用族', why: '是通用族，由系统挑字体' });
      else if (installed(f)) v.pre.push({ name: f, kind: 'error', short: '是本机系统字体', why: `是本机装的系统字体${SYS.test(f) ? '' : '（不在已知系统字体表里，但本机确实有）'}` });
      else if (SYS.test(f)) v.pre.push({ name: f, kind: 'error', short: '是别的平台的系统字体', why: '是别的平台的系统字体：本机没有所以被跳过，换到有它的机器上它会抢先画字' });
      else v.pre.push({ name: f, kind: 'warn', short: '本机没有也没声明（拼错了？）', why: '本机没有、也没声明，被静默跳过（拼错了？）' });
    }
    if (!v.hasBundled || !chars.length) continue;
    const base = `${head}64px ${inStack.map(q).join(', ')}`;
    try { await document.fonts.load(base, chars.join('')); } catch {}
    for (const ch of chars) {
      const r = FALLBACKS.map((fb) => px(`${base}, ${fb}`, ch));
      let ink = 0;
      for (let i = 3; i < r[0].length; i += 4) if (r[0][i]) ink++;
      if (!ink || !r.every((x) => same(x, r[0]))) v.miss.push(ch);
    }
  }
  cv.remove();
  return out;
}
