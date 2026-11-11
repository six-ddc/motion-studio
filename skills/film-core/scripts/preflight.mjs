#!/usr/bin/env node
// 渲染前预检：宁可拒收坏输入，也不渲出一支漂亮但错误的片子。几秒内跑完，打一张表，给一个退出码。
//
//   node <film-core>/scripts/preflight.mjs --film <slug> [--variant <id>] [--format 16x9] [--samples 12] [--safe 0.9] [--static-only]
//
// 可选检查：film.json checks 声明 "preflight"（或 {"preflight": {"safe": 0.9, "samples": 12}}）才由 deliver / accept --deep 跑；
// render 在声明了它时于渲染前调用本脚本，非 0 退出则中止渲染。没声明的片子什么都不变。
// 也可以随手单独跑。content.json（内容数据层：顶层 assets 映射、text 槽位、claims 列表）存在才查相关项，读不到就跳过。
//
// 六项（任何一项 ✗ = exit 1）：
//   assets    素材在不在：scene / shots / 片内 html·js·css / content.json assets 引用的本地路径缺文件 → ✗；外链素材 → ✗
//             （与 film-assets audit 同口径）；页面加载时实际请求 404 或请求外部主机 → ✗
//   fonts     document.fonts 里有 face 加载失败（status=error）→ ✗；loadFonts/fonts.load 的异常被空 catch 吞掉 → ✗；
//             content.json 全部文本 + 采样时刻页面可见文字，随片字体画不出来的字 → ✗（逐字判法复用 film-typography text.js 的 missingGlyphs）
//   overflow  content.json 槽位声明的 maxChars / box 超了 → ✗；采样时刻带 data-slot 的元素内容溢出自己的盒子、越出舞台或标题安全区、
//             压住带 data-avoid 的元素 → ✗。不带 data-slot 的文字只报 ⚠（区分不了有意出画）
//   code      画面里的代码：content.json 带 lang 的槽位、页面里 [data-code-lang] 的块。lua → luac -p（没装 SKIP）、js → node --check、
//             json → JSON.parse；代码行元素 display 是 flex/grid（行首缩进被吞）、white-space 折叠了行首空格 → ✗
//   residue   film.json 有 variantOf 时：docs/*.md、tools/*、scene、shots、content.json 里残留源片 slug/标题、未替换的 {{占位}} → ✗
//   claims    content.json claims 每条要有 source，且是 docs/facts.md 事实总表里状态可上片的 id → ✗
//
// 它测的是"输入在渲染前是否站得住"，不测"渲出来对不对"（那是 seamcheck / fontsrc / critique）。盲区见 references/preflight.md。
// 退出码：0 通过；1 有 ✗；2 用法错 / 片子找不到
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FILM_OPTS, parseArgs, resolveFilm, fail, checkParam } from '../lib/film.mjs';
import { hasCapability } from '../lib/env.mjs';
import { serve } from '../lib/serve.mjs';
import { launchBrowser, FORMATS, filmBackend } from '../lib/browser.mjs';
import { importRuntime } from '../lib/runtime-node.mjs';

const A = parseArgs({
  usage: 'node preflight.mjs --film <slug> [--variant <id>] [--format <9x16|1x1|16x9>] [--samples N] [--safe 0.9] [--static-only]',
  about: '渲染前预检：素材在不在、字体加载与覆盖、文字溢出/安全区、画面代码语法、变体复制残留、宣传数据有出处。有 ✗ exit 1。',
  opts: {
    ...FILM_OPTS,
    variant: ['<id>', '变体 id（如 hook-b.cta-a）：按内容层 resolveContent 合并 content.json，并以 ?variant=<id> 打开页面'],
    format: ['<9x16|1x1|16x9>', '只查这个画幅（默认 film.json formats 全部）'],
    entry: ['<file.html>', '临时换入口（测试变体用，不改 film.json）'],
    samples: ['<N>', '没有 window.MARKS 时均匀采样几刻（默认 12；film.json {"preflight": {"samples": N}} 也行）'],
    safe: ['<比例>', '标题安全区占舞台的比例（默认 0.9，即四边各留 5%；film.json {"preflight": {"safe": 0.9}} 也行）'],
    'static-only': '不开浏览器：只查 assets / residue / claims / 静态字体写法 / content.json 的 maxChars 与代码',
  },
});

const t0 = Date.now();   // 只用于打印耗时
let F;
try { F = resolveFilm(A.film, A); } catch (e) { fail(e.message, 2); }
let P = {};
try { const p = checkParam(F.dir, 'preflight'); if (p && typeof p === 'object') P = p; } catch {}
const variant = A.flag('variant', null);
const safe = Number(A.flag('safe', null) ?? P.safe ?? 0.9);
if (!(safe > 0 && safe <= 1)) fail(`--safe 要在 (0,1]，收到 ${safe}`, 2);
const samples = Math.max(1, Math.round(Number(A.flag('samples', null) ?? P.samples ?? 12)));
const formats = A.flag('format', null) ? [A.flag('format')] : F.formats;
for (const f of formats) if (!FORMATS[f]) fail(`未知画幅 ${f}`, 2);
const staticOnly = A.has('static-only');
const rel = (p) => relative(F.dir, p) || '.';

// 每项的结果：bad = ✗ 明细，warn = ⚠，info = 一句话；skip = 这项整体没查的原因
const ROWS = ['assets', 'fonts', 'overflow', 'code', 'residue', 'claims'];
const R = Object.fromEntries(ROWS.map((k) => [k, { bad: [], warn: [], info: [], skip: null }]));
const bad = (k, m) => R[k].bad.push(m), warn = (k, m) => R[k].warn.push(m), info = (k, m) => R[k].info.push(m);

// ───────────────────────── content.json（可选，D 的内容数据层）─────────────────────────
// 只按"认得的形状"读：assets {名: 路径 | {path|src}}、text {槽位: 字符串 | {text|value, maxChars, box, font, lang}}、
// claims [{text, source}]、code {名: {lang, text}} 或数组、variants {id: 同形状的覆盖}。不认识的字段不管。
let content = null;                 // 生效内容（多画幅时取第一个画幅那份：claims / residue 只看有没有，不随画幅变）
let contentByFmt = [];              // [{ fmt, content }]：要查的每个画幅各合并一份（variants.format.<画幅> 可以改文案、素材）
const contentPath = join(F.dir, 'content.json');
if (variant && !existsSync(contentPath)) {
  fail(`${F.slug} 没有 content.json，不能用 --variant ${variant}：变体是 content.json variants 里的覆盖（schema 见 film-core references/content-json.md）`, 2);
}
if (existsSync(contentPath)) {
  let doc = null;
  try { doc = JSON.parse(readFileSync(contentPath, 'utf8')); } catch (e) { bad('assets', `content.json 不是合法 JSON：${e.message}`); }
  if (doc) {
    // 合并规则只认内容层运行时 content.js 的 resolveContent（与页面 loadContent、render 的变体同一份；片内冻结副本优先）。
    // 给了 --format 只合并该画幅；没给就对 film.json formats（或 format）每个画幅各合并一份，下面逐份查、报告标明画幅。
    // 套件里还没有它时退回最朴素的读法：variants[id] 的 assets/text/code 浅覆盖（不分画幅）
    let resolveContent = null;
    try { ({ resolveContent } = await importRuntime('content.js', { film: F.dir })); } catch {}
    if (resolveContent) {
      try { contentByFmt = formats.map((fmt) => ({ fmt, content: { ...doc, ...resolveContent(doc, { variant, format: fmt }) } })); }
      catch (e) {
        bad('assets', `content.json${variant ? `（变体 ${variant}）` : ''}：${e.message.replace(/^content\.json\s*/, '').replace(/\n\s*-\s*/g, ' ')}`);
        contentByFmt = formats.map((fmt) => ({ fmt, content: doc }));
      }
    } else {
      const c = { ...doc };
      const v = variant ? c.variants?.[variant] : null;
      if (variant && !v) warn('assets', `content.json 没有 variants.${variant}，按基础内容查`);
      if (v) { for (const k of ['assets', 'text', 'code']) if (v[k]) c[k] = { ...(c[k] ?? {}), ...v[k] }; if (v.claims) c.claims = v.claims; }
      contentByFmt = formats.map((fmt) => ({ fmt, content: c }));
    }
    content = contentByFmt[0].content;
  }
}
// 同一条内容在几个画幅里一样就只查一次；多画幅时报告前缀标出它属于哪些画幅（[9x16] / [16x9/9x16]）
const fmtTag = (fmts) => (formats.length > 1 ? `[${fmts.join('/')}] ` : '');
const byFmt = (pick) => {
  const m = new Map();
  for (const { fmt, content: c } of contentByFmt) for (const [key, x] of pick(c)) {
    const e = m.get(key) ?? m.set(key, { ...x, fmts: [] }).get(key);
    e.fmts.push(fmt);
  }
  return [...m.values()].map((x) => ({ ...x, tag: fmtTag(x.fmts) }));
};
const slotText = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.text ?? v.value ?? null) : null);
const contentSlots = byFmt((c) => (c?.text && typeof c.text === 'object'
  ? Object.entries(c.text).map(([id, v]) => ({ id, text: slotText(v), ...(v && typeof v === 'object' ? v : {}) })).filter((s) => typeof s.text === 'string')
  : []).map((s) => [JSON.stringify(s), s]));
const slotsFor = (fmt) => contentSlots.filter((s) => s.fmts.includes(fmt));
const contentCode = [
  ...contentSlots.filter((s) => s.lang).map((s) => ({ where: `${s.tag}content.json text.${s.id}`, lang: s.lang, text: s.text })),
  ...byFmt((c) => (c?.code ? (Array.isArray(c.code) ? c.code.map((x, i) => [i, x]) : Object.entries(c.code))
    .filter(([, x]) => x && typeof x.text === 'string').map(([k, x]) => [`${k}\u0000${x.lang}\u0000${x.text}`, { k, lang: x.lang, text: x.text }]) : []))
    .map((x) => ({ where: `${x.tag}content.json code.${x.k}`, lang: x.lang, text: x.text })),
];

// ───────────────────────── 片内要扫的源文件 ─────────────────────────
const SKIP = new Set(['out', 'node_modules', 'tools', 'tests', 'docs', '_incoming', 'runtime', 'src']);
const walk = (d, keep) => (existsSync(d) ? readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  let st; try { st = statSync(p); } catch { return []; }
  if (st.isDirectory()) return n.startsWith('.') || SKIP.has(n) ? [] : walk(p, keep);
  return keep(n) ? [p] : [];
}) : []);
const entryPath = join(F.dir, F.config.entry);
// 入口页 + 片内全部 js/css（别的 .html 不是这次渲染的入口：备用入口、阴性对照、旧版本，不扫）
const codeFiles = [...new Set([entryPath, ...walk(F.dir, (n) => /\.(m?js|css)$/.test(n))])];
// 去注释但保留换行（与 font_source 同一写法），行号才对得上
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, (m, a) => a + blank(m.slice(a.length)));
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

// ───────────────────────── a. 素材在不在（静态）─────────────────────────
const ASSET_EXT = 'png|jpe?g|webp|gif|svg|avif|bmp|ico|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac|opus|woff2?|ttf|otf|json|glb|gltf|hdr|exr|ktx2|bin|lottie|csv|txt|atlas';
const ASSET_RE = new RegExp(`^[^\\s<>{}|*?"'\`]+\\.(?:${ASSET_EXT})(?:[?#][^\\s]*)?$`, 'i');
const EXT_ASSET_RE = new RegExp(`\\.(?:${ASSET_EXT})(?:[?#]|$)`, 'i');
let nRefs = 0;
const checkRef = (file, line, v, before) => {
  v = v.trim();
  if (!v || v.includes('${') || /^(data|blob|mailto|about|javascript):|^#/i.test(v)) return;
  if (/^https?:\/\//i.test(v)) {
    if (/xmlns|w3\.org\/\d{4}\//.test(before + v)) return;
    if (EXT_ASSET_RE.test(v) || /(?:src|href)\s*=\s*$|from\s*$|import\(\s*$|url\(\s*$/i.test(before)) {
      nRefs++; bad('assets', `${rel(file)}:${line}  外链 ${v}（下载进 assets/，与 film-assets audit 同口径）`);
    }
    return;
  }
  if (!ASSET_RE.test(v)) return;
  const path = decodeURIComponent(v.split(/[?#]/)[0]);
  if (/^\/(?:Users|System|Library|home|tmp|private|var|opt|Volumes)\//.test(path)) { nRefs++; bad('assets', `${rel(file)}:${line}  绝对路径 ${path}`); return; }
  if (/^\.?\/?runtime\//.test(path)) return;                        // 运行时由挂载表解析，不是素材
  nRefs++;
  const cands = path.startsWith('/') ? [join(F.dir, path)]
    : [resolve(dirname(file), path), resolve(dirname(entryPath), path), resolve(F.dir, path)];
  if (cands.some((c) => existsSync(c))) return;
  if (!path.includes('/') && existsSync(join(F.dir, 'assets', path))) return;
  if (path.includes('/')) bad('assets', `${rel(file)}:${line}  引用 ${v}，文件不存在`);
  else warn('assets', `${rel(file)}:${line}  "${v}" 像文件名但哪里都找不到（拼出来的？死代码？）`);
};
for (const p of codeFiles) {
  const s = stripComments(readFileSync(p, 'utf8'));
  for (const m of s.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) checkRef(p, lineOf(s, m.index), m[2], s.slice(Math.max(0, m.index - 24), m.index));
  for (const m of s.matchAll(/url\(\s*([^'"\s)][^)]*?)\s*\)/g)) checkRef(p, lineOf(s, m.index), m[1], 'url(');
}
for (const { k, v, tag } of byFmt((c) => (c?.assets && typeof c.assets === 'object' ? Object.entries(c.assets).map(([k, v]) => [`${k}\u0000${JSON.stringify(v)}`, { k, v }]) : []))) {
  const p = typeof v === 'string' ? v : v?.path ?? v?.src;
  if (typeof p !== 'string') { bad('assets', `${tag}content.json assets.${k} 没有路径`); continue; }
  nRefs++;
  if (/^https?:\/\//i.test(p)) bad('assets', `${tag}content.json assets.${k}  外链 ${p}`);
  else if (!existsSync(resolve(F.dir, p.split(/[?#]/)[0]))) bad('assets', `${tag}content.json assets.${k}  ${p} 不存在`);
}

// ───────────────────────── b. 字体：吞异常的写法（静态）─────────────────────────
// loadFonts(...).catch(() => {}) / try { await loadFonts(...) } catch {}：字体保障抛的错被吞掉，缺字照样渲，排版整体错位
const FONT_CALL = /loadFonts|fonts\.load|new FontFace|\.load\s*\(/;
for (const p of codeFiles.filter((f) => /\.(html?|m?js)$/.test(f))) {
  const s = stripComments(readFileSync(p, 'utf8'));
  for (const m of s.matchAll(/\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|null|undefined|void 0|0|false)\s*\)/g)) {
    const stmt = s.slice(Math.max(0, s.lastIndexOf(';', m.index), s.lastIndexOf('\n\n', m.index)), m.index);
    if (FONT_CALL.test(stmt)) bad('fonts', `${rel(p)}:${lineOf(s, m.index)}  字体加载的异常被空 catch 吞掉（${m[0].replace(/\s+/g, ' ')}）：缺字、拼错族名都会静默渲完`);
  }
  for (const m of s.matchAll(/try\s*\{([^{}]*)\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
    if (FONT_CALL.test(m[1])) bad('fonts', `${rel(p)}:${lineOf(s, m.index)}  try { 字体加载 } catch {}：异常被吞掉`);
  }
}

// ───────────────────────── e. 复制残留（variantOf）─────────────────────────
const variantOf = F.raw.variantOf;
if (!variantOf) R.residue.skip = '不是变体（film.json 没有 variantOf）';
else {
  let srcTitle = null;
  try { srcTitle = JSON.parse(readFileSync(join(F.films, variantOf, 'film.json'), 'utf8')).title ?? null; } catch {}
  if (srcTitle && srcTitle === F.raw.title) srcTitle = null;     // 标题本来就一样：没法当残留判
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [[new RegExp(`(?<![\\w-])${esc(variantOf)}(?![\\w-])`, 'g'), `源片 slug「${variantOf}」`],
    ...(srcTitle && srcTitle.length >= 2 ? [[new RegExp(esc(srcTitle), 'g'), `源片标题「${srcTitle}」`]] : []),
    [/\{\{\s*[\w.一-鿿-]+\s*\}\}/g, '未替换的占位']];
  const textish = (n) => /\.(md|txt|json|html?|m?js|css|py|sh|ya?ml|toml)$/i.test(n);
  const docs = existsSync(join(F.dir, 'docs')) ? readdirSync(join(F.dir, 'docs')).filter((n) => n.endsWith('.md')).map((n) => join(F.dir, 'docs', n)) : [];
  const tools = []; const walkAll = (d) => { if (existsSync(d)) for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walkAll(p); else if (textish(n)) tools.push(p); } };
  walkAll(join(F.dir, 'tools'));
  const files = [...new Set([...docs, ...tools, ...codeFiles.filter((p) => !p.includes(`${sep}assets${sep}`)), ...(content ? [contentPath] : [])])];
  let hits = 0;
  for (const p of files) {
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((L, i) => {
      if (L.includes('preflight:allow')) return;
      for (const [re, what] of pats) for (const m of L.matchAll(re)) { hits++; if (hits <= 40) bad('residue', `${rel(p)}:${i + 1}  ${what}：${m[0]}`); }
    });
  }
  if (hits > 40) bad('residue', `…共 ${hits} 处`);
  info('residue', `变体自 ${variantOf}，扫了 ${files.length} 个文件`);
}

// ───────────────────────── f. 宣传数据要有出处 ─────────────────────────
const claims = Array.isArray(content?.claims) ? content.claims : null;
if (!claims) R.claims.skip = content ? 'content.json 没有 claims' : '没有 content.json';
else {
  const ONAIR = new Set(['已核', '单源', '争议', '免核']);   // 同 film-story factcheck 的"可上片"
  const facts = new Map();
  const fp = join(F.dir, 'docs', 'facts.md');
  if (existsSync(fp)) {
    let header = null;
    for (const raw of readFileSync(fp, 'utf8').split('\n')) {
      const L = raw.trim();
      if (!L.startsWith('|')) { if (header && facts.size) break; continue; }
      const cells = L.slice(1, L.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim().replace(/`/g, ''));
      if (!header) { if (cells[0].toLowerCase() === 'id' && cells.includes('状态')) header = cells; continue; }
      if (/^:?-{2,}/.test(cells[0])) continue;
      facts.set(cells[0], Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])));
    }
  }
  claims.forEach((c, i) => {
    const what = `claims[${i}]${c?.text ? ` 「${String(c.text).slice(0, 24)}」` : ''}`;
    const src = c?.source;
    if (!src || (Array.isArray(src) && !src.length)) { bad('claims', `${what} 没有 source`); return; }
    if (!existsSync(fp)) { bad('claims', `${what} source=${JSON.stringify(src)}，但没有 docs/facts.md 可对（格式见 film-story factcheck）`); return; }
    for (const id of [src].flat()) {
      const f = facts.get(String(id));
      if (!f) bad('claims', `${what} source「${id}」在 docs/facts.md 事实总表里找不到这个 id`);
      else if (!ONAIR.has(f['状态'])) bad('claims', `${what} source「${id}」状态是「${f['状态']}」，不能上片（要 已核/单源/争议/免核）`);
    }
  });
  info('claims', `${claims.length} 条，facts.md ${facts.size} 条事实`);
}

// ───────────────────────── c. content.json 槽位长度（静态部分）─────────────────────────
for (const s of contentSlots) {
  const n = [...s.text].length;
  if (Number.isFinite(s.maxChars) && n > s.maxChars) bad('overflow', `${s.tag}content.json text.${s.id}：${n} 字 > maxChars ${s.maxChars}「${s.text.slice(0, 30)}」`);
  const lines = s.text.split('\n');
  if (Number.isFinite(s.maxLines) && lines.length > s.maxLines) bad('overflow', `${s.tag}content.json text.${s.id}：${lines.length} 行 > maxLines ${s.maxLines}`);
}

// ───────────────────────── 浏览器层：b 字体 / c 溢出 / d 代码 ─────────────────────────
const domCode = new Map();   // 去重：lang + 文本
if (staticOnly) {
  for (const k of ['fonts', 'overflow']) info(k, '仅静态（--static-only）：页面层没查');
} else {
  const server = await serve(F.dir, { record: false });
  let browser;
  try { browser = await launchBrowser({ backend: filmBackend(F) }); }
  catch (e) { server.close(); fail(e.message, 1); }
  try { for (const fmt of formats) await inBrowser(fmt, server.url, browser); }
  finally { await browser.close(); server.close(); }
}

// ───────────────────────── d. 代码语法 ─────────────────────────
const codes = [...contentCode, ...domCode.values()];
if (!codes.length) R.code.skip = '没有声明代码块（页面 [data-code-lang] 或 content.json 带 lang 的槽位）';
else {
  const tmp = mkdtempSync(join(tmpdir(), 'preflight-'));
  const has = (bin, args) => { const r = spawnSync(bin, args, { encoding: 'utf8' }); return r.status === 0 || /Lua/.test(`${r.stdout}${r.stderr}`); };
  const luac = ['luac', 'luac5.4', 'luac5.3'].find((b) => has(b, ['-v']));
  const luajit = !luac && has('luajit', ['-v']) ? 'luajit' : null;
  try {
    codes.forEach((c, i) => {
      const lang = String(c.lang ?? '').toLowerCase();
      const firstErr = (r) => `${r.stderr ?? ''}${r.stdout ?? ''}`.split('\n').map((l) => l.replace(/\S*b\d+\.(?:lua|mjs|cjs)/g, '代码块')).find((l) => /error|Error|expected|unexpected|near/.test(l))?.trim() ?? `退出码 ${r.status}`;
      if (lang === 'lua') {
        if (!luac && !luajit) { warn('code', `${c.where}（lua）SKIP：没装 luac（brew install lua）`); return; }
        const p = join(tmp, `b${i}.lua`); writeFileSync(p, c.text);
        const r = luac ? spawnSync(luac, ['-p', p], { encoding: 'utf8' }) : spawnSync(luajit, ['-b', p, join(tmp, `b${i}.out`)], { encoding: 'utf8' });
        if (r.status !== 0) bad('code', `${c.where}（lua）${luac ?? 'luajit -b'} 不过：${firstErr(r)}`);
        else info('code', `lua ✓`);
      } else if (['js', 'javascript', 'mjs', 'ts'].includes(lang)) {
        if (lang === 'ts') { warn('code', `${c.where}（ts）没查：node --check 不认类型标注`); return; }
        const r1 = (writeFileSync(join(tmp, `b${i}.mjs`), c.text), spawnSync(process.execPath, ['--check', join(tmp, `b${i}.mjs`)], { encoding: 'utf8' }));
        const r2 = r1.status === 0 ? r1 : (writeFileSync(join(tmp, `b${i}.cjs`), c.text), spawnSync(process.execPath, ['--check', join(tmp, `b${i}.cjs`)], { encoding: 'utf8' }));
        if (r2.status !== 0) bad('code', `${c.where}（js）node --check 不过：${firstErr(r1)}`);
        else info('code', 'js ✓');
      } else if (lang === 'json') {
        try { JSON.parse(c.text); info('code', 'json ✓'); } catch (e) { bad('code', `${c.where}（json）解析不过：${e.message}`); }
      } else warn('code', `${c.where}：不认识的语言「${c.lang}」，只查了排版没查语法（认 lua / js / json）`);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ───────────────────────── 报告 ─────────────────────────
const SAY = {
  assets: '素材引用都在、无外链',
  fonts: '字体全部加载、无吞异常、字都画得出',
  overflow: '槽位不超长、不溢出、不越安全区',
  code: '画面代码语法过、缩进没被吞',
  residue: '没有源片残留与未替换占位',
  claims: '宣传数据都有 facts.md 出处',
};
const ms = Date.now() - t0;
console.log(`预检 ${F.slug}${variant ? ` · 变体 ${variant}` : ''}（${F.config.entry} · ${formats.join('/')}${staticOnly ? ' · 仅静态' : ''}${content ? ' · 有 content.json' : ''} · ${(ms / 1000).toFixed(1)}s）`);
let nBad = 0;
for (const k of ROWS) {
  const r = R[k];
  const mark = r.bad.length ? '✗' : r.skip ? '–' : r.warn.length ? '⚠' : '✓';
  if (r.bad.length) nBad++;
  const infos = [...new Set(r.info)];
  const head = r.bad.length ? `${r.bad.length} 处不合格` : r.skip ?? `${SAY[k]}${infos.length ? `（${infos.join('；')}）` : ''}`;
  console.log(`  ${mark} ${k.padEnd(9)}${head}`);
  for (const m of r.bad.slice(0, 12)) console.log(`      ✗ ${m}`);
  if (r.bad.length > 12) console.log(`      … 另 ${r.bad.length - 12} 条`);
  for (const m of r.warn.slice(0, 6)) console.log(`      ⚠ ${m}`);
  if (r.warn.length > 6) console.log(`      … 另 ${r.warn.length - 6} 条警告`);
}
if (nBad) fail(`${F.slug}: 预检不过（${nBad} 项）。宁可现在拒收，也不渲出一支漂亮但错的片子；各项测的是什么见 film-core references/preflight.md`, 1);
console.log(`✓ ${F.slug}: 预检通过`);

// ═════════════════════════ 浏览器层 ═════════════════════════
async function inBrowser(fmt, origin, browser) {
  const tag = formats.length > 1 ? `[${fmt}] ` : '';
  const slots = slotsFor(fmt);        // 这个画幅合并出的 content.json 槽位
  const { width, height } = FORMATS[fmt];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [], external = new Set(), http = new Set();
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(origin) || /^(data|blob):/.test(u)) return route.continue();
    external.add(u); return route.abort();                       // 外链不放行：预检离线、快，也证明片子离线能渲
  });
  const page = await context.newPage();
  let onErr; const firstErr = new Promise((r) => { onErr = r; });   // 加载期抛错就别再等满 15 秒
  page.on('pageerror', (e) => { errors.push(String(e.message ?? e)); onErr(false); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) http.add(`HTTP ${r.status()} ${decodeURIComponent(new URL(r.url()).pathname)}`); });
  try {
    const q = `?format=${fmt}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}`;
    await page.goto(`${origin}${F.entryUrl}${q}`, { waitUntil: 'load' });
    const seekIn = (ms) => page.waitForFunction(() => typeof window.seek === 'function', null, { timeout: ms }).then(() => true, () => false);
    const okSeek = await Promise.race([firstErr.then(() => seekIn(1500)), seekIn(15_000)]);   // 报错后再宽限 1.5 秒（不致命的报错）
    let readyErr = null;
    if (okSeek) {
      try { await page.evaluate(() => window.ready ?? null); } catch (e) { readyErr = e.message.replace(/^page\.evaluate:\s*/, '').split('\n')[0]; }
      await page.evaluate(() => document.fonts.ready.then(() => null));
    }
    for (const u of external) bad('assets', `${tag}页面加载时请求外部主机 ${u}`);
    for (const h of http) bad('assets', `${tag}页面加载时 ${h}`);
    if (!okSeek || readyErr) {
      const why = !okSeek ? (errors.length ? '加载期报错，没有暴露 window.seek' : '15 秒内没有暴露 window.seek') : `window.ready 失败：${readyErr}`;
      for (const k of ['fonts', 'overflow']) bad(k, `${tag}${why}${errors.length ? `；页面错误：${errors[0]}` : ''}（页面层没法查）`);
      return;
    }
    if (errors.length) warn('fonts', `${tag}页面报错 ${errors.length} 条，首条：${errors[0]}`);

    // b. FontFace 状态：error = 文件坏/路径错/格式错，一定红；unloaded 的分片正常（没用到的 unicode-range），不判
    const faces = await page.evaluate(() => [...document.fonts].map((f) => ({ family: f.family.replace(/^['"]|['"]$/g, ''), weight: f.weight, status: f.status })));
    for (const f of faces.filter((x) => x.status === 'error')) bad('fonts', `${tag}FontFace "${f.family}" ${f.weight} 加载失败（status=error）`);
    for (const f of faces.filter((x) => x.status === 'loading')) bad('fonts', `${tag}FontFace "${f.family}" ${f.weight} 在 ready 之后仍在加载（ready 没等它）`);
    const fams = [...new Set(faces.filter((f) => f.status !== 'error').map((f) => f.family))];
    info('fonts', faces.length ? `${tag}${faces.length} 个 face：${faces.filter((f) => f.status === 'loaded').length} 已加载，${faces.filter((f) => f.status === 'unloaded').length} 个分片未用到` : `${tag}页面没有声明字体`);
    if (!faces.length && slots.length) warn('fonts', `${tag}页面没有随片字体，content.json 文本的覆盖没查（画字用系统字体归内核门 fontsrc 判）`);

    // 采样时刻：MARKS 中点（承重时刻，元素该站定的时候），没有就均匀 N 刻
    const dur = await page.evaluate(() => window.DURATION);
    const D = Number(dur ?? F.config.duration);
    const marks = await page.evaluate(() => (Array.isArray(window.MARKS) ? window.MARKS.map((m) => [m.start, m.end]) : []));
    let times = marks.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([a, b]) => (a + b) / 2);
    const how = times.length ? 'MARKS 中点' : '均匀';
    if (!times.length) times = Array.from({ length: samples }, (_, i) => ((i + 0.5) / samples) * D);
    times = times.filter((t) => t >= 0 && (!(D > 0) || t <= D)).map((t) => Number(t.toFixed(3)));
    info('overflow', `${tag}${how} ${times.length} 刻，安全区 ${Math.round(safe * 100)}%`);

    // 同一个问题在多个采样时刻重复出现：只报一次，记首次时刻和出现几刻
    const seen = new Map();
    const badT = (k, key, msg, t) => { const x = seen.get(key) ?? seen.set(key, { k, msg, ts: [] }).get(key); x.ts.push(t); };
    const texts = new Map();          // font → 字（覆盖检查用）
    const loose = { out: 0, clip: 0, ex: null };
    for (const t of times) {
      try { await page.evaluate(async (t) => { await window.seek(t); }, t); } catch (e) { bad('overflow', `${tag}seek(${t}) 抛错：${e.message.split('\n')[0]}`); continue; }
      const m = await page.evaluate(MEASURE, { stageSel: F.config.stage, safe });
      if (!m) { bad('overflow', `${tag}页面里没有 ${F.config.stage}`); break; }
      for (const s of m.slots) {
        const at = `${tag}data-slot="${s.slot}"「${s.text.slice(0, 20)}」`, o = (key, msg) => badT('overflow', `${s.slot}|${s.text}|${key}`, `${at} ${msg}`, t);
        if (s.overX) o('x', `内容宽 ${s.sw}px 超出盒子 ${s.cw}px`);
        if (s.overY) o('y', `内容高 ${s.sh}px 超出盒子 ${s.ch}px`);
        if (s.outStage) o('stage', `越出舞台（${s.box}）`);
        else if (s.outSafe) o('safe', `越出 ${Math.round(safe * 100)}% 安全区：${s.outSafe}`);
        if (Number.isFinite(s.maxChars) && [...s.text].length > s.maxChars) o('max', `${[...s.text].length} 字 > data-max-chars ${s.maxChars}`);
        for (const a of s.covers) o(`avoid:${a}`, `压住了 data-avoid="${a}"`);
        const cs = slots.find((c) => c.id === s.slot);
        if (cs && Number.isFinite(cs.maxChars) && [...s.text].length > cs.maxChars) o('cmax', `实际 ${[...s.text].length} 字 > content.json maxChars ${cs.maxChars}`);
      }
      for (const e of m.loose) { if (e.out) loose.out++; if (e.clip) loose.clip++; loose.ex ??= `t=${t}s「${e.text.slice(0, 16)}」${e.clip ? '被自己的盒子截断' : '越出安全区'}`; }
      for (const [font, s] of m.fonts) texts.set(font, (texts.get(font) ?? '') + s);
      for (const c of m.code) {
        const key = `${c.lang}\u0000${c.text}`;
        if (!domCode.has(key)) domCode.set(key, { where: `${tag}页面 [data-code-lang=${c.lang}]（t=${t}s）`, lang: c.lang, text: c.text });
        if (c.flex.length) badT('code', `${key}|flex`, `${tag}[data-code-lang=${c.lang}] ${c.flex.length} 行代码行元素 display:${c.flex[0].display}（第 ${c.flex.map((l) => l.i + 1).slice(0, 8).join(',')} 行）——行首缩进会被吞（代码行用 block + white-space:pre）`, t);
        if (c.ws.length) badT('code', `${key}|ws`, `${tag}[data-code-lang=${c.lang}] 第 ${c.ws.map((l) => l.i + 1).slice(0, 8).join(',')} 行有行首空格，但 white-space:${c.ws[0].ws} 把它折叠了`, t);
      }
    }
    for (const x of seen.values()) bad(x.k, `${x.msg}（t=${x.ts[0]}s${x.ts.length > 1 ? ` 起 ${x.ts.length}/${times.length} 刻` : ''}）`);
    if (loose.out || loose.clip) warn('overflow', `${tag}没标 data-slot 的文字：${loose.out} 处越出安全区、${loose.clip} 处被盒子截断（例：${loose.ex}）。区分不了有意出画，不判红；要管就给它标 data-slot`);

    // b. 字形覆盖：content.json 文本（槽位声明了 font 用它，否则用全部随片字体族）+ 采样到的页面可见文字（用它自己的计算字体）
    if (!hasCapability('film-typography')) { warn('fonts', '覆盖检查 SKIP：缺能力 film-typography（逐字判法在它的 text.js missingGlyphs）'); return; }
    const stack = fams.length ? fams.map((f) => `"${f}"`).join(', ') : null;
    const jobs = [...texts].map(([font, s]) => ({ where: '页面文字', font, text: [...new Set(s)].join('') }));
    for (const s of slots.filter((x) => !x.lang)) {
      const font = s.font ?? (stack ? `40px ${stack}` : null);
      if (font) jobs.push({ where: `content.json text.${s.id}`, font, text: s.text, box: s.box });
    }
    for (const c of Array.isArray(content?.claims) ? content.claims : []) if (c?.text && stack) jobs.push({ where: 'content.json claims', font: `40px ${stack}`, text: String(c.text) });
    const res = await page.evaluate(COVER, jobs);
    if (res.error) { warn('fonts', `${tag}覆盖检查没跑起来：${res.error}`); return; }
    for (const r of res.out) {
      if (r.miss.length) bad('fonts', `${tag}${r.where}（${r.font}）${r.miss.length} 个字随片字体画不出、会回退：${r.miss.slice(0, 30).join('')}${r.miss.length > 30 ? '…' : ''}`);
      if (r.wide) bad('overflow', `${tag}${r.where} 量宽 ${r.wide.w}px > box ${r.wide.max}px（${r.font}）`);
    }
    for (const s of slots.filter((x) => x.box && !x.font && !x.lang)) warn('overflow', `${tag}content.json text.${s.id} 声明了 box 但没给 font，量不了宽度`);
  } finally { await context.close(); }
}

// ───────────── 以下函数在页面里执行 ─────────────
function MEASURE({ stageSel, safe }) {
  const stage = document.querySelector(stageSel);
  if (!stage) return null;
  const S = stage.getBoundingClientRect();
  const mx = (S.width * (1 - safe)) / 2, my = (S.height * (1 - safe)) / 2;
  const opacity = (el) => { let o = 1; for (let e = el; e && e !== document.documentElement; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && opacity(el) > 0.02;
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const fontOf = (cs) => `${cs.fontStyle} ${cs.fontWeight} 40px ${cs.fontFamily}`;
  const geom = (el) => {
    const r = el.getBoundingClientRect();
    const box = `${Math.round(r.left - S.left)},${Math.round(r.top - S.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
    const outStage = r.left < S.left - 1 || r.top < S.top - 1 || r.right > S.right + 1 || r.bottom > S.bottom + 1;
    const sides = [];
    if (r.left < S.left + mx - 0.5) sides.push(`左 ${Math.round(r.left - S.left)}<${Math.round(mx)}`);
    if (r.right > S.right - mx + 0.5) sides.push(`右 ${Math.round(S.right - r.right)}<${Math.round(mx)}`);
    if (r.top < S.top + my - 0.5) sides.push(`上 ${Math.round(r.top - S.top)}<${Math.round(my)}`);
    if (r.bottom > S.bottom - my + 0.5) sides.push(`下 ${Math.round(S.bottom - r.bottom)}<${Math.round(my)}`);
    return { r, box, outStage, outSafe: sides.join('，') };
  };
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const avoid = [...stage.querySelectorAll('[data-avoid]')].filter(visible).map((el) => ({ el, name: el.dataset.avoid || el.id || el.tagName, r: el.getBoundingClientRect() }));
  const slots = [...stage.querySelectorAll('[data-slot]')].filter(visible).map((el) => {
    const g = geom(el);
    return { slot: el.dataset.slot, text: el.textContent.trim(), sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
      overX: el.scrollWidth > el.clientWidth + 1, overY: el.scrollHeight > el.clientHeight + 1, box: g.box, outStage: g.outStage, outSafe: g.outSafe,
      maxChars: el.dataset.maxChars != null ? Number(el.dataset.maxChars) : NaN,
      covers: avoid.filter((a) => !el.contains(a.el) && !a.el.contains(el) && hit(g.r, a.r)).map((a) => a.name) };
  });
  const loose = [], fonts = new Map();
  for (const el of stage.querySelectorAll('*')) {
    if (/^(SCRIPT|STYLE|CANVAS|TEMPLATE|svg)$/i.test(el.tagName)) continue;
    const t = own(el);
    if (!t || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const f = fontOf(cs); fonts.set(f, (fonts.get(f) ?? '') + t);
    if (el.closest('[data-slot]') || el.closest('[data-code-lang]')) continue;
    const g = geom(el);
    const clip = /hidden|clip/.test(cs.overflowX + cs.overflowY) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    if (g.outSafe || clip) loose.push({ text: t, out: !!g.outSafe, clip });
  }
  const code = [...stage.querySelectorAll('[data-code-lang]')].filter(visible).map((b) => {
    const marked = [...b.querySelectorAll('[data-code-line]')];
    const lines = marked.length ? marked : [...b.children].filter((c) => !/^(SCRIPT|STYLE|BR)$/.test(c.tagName));
    const flex = [], ws = [];
    lines.forEach((l, i) => {
      const cs = getComputedStyle(l);
      if (/flex|grid/.test(cs.display)) flex.push({ i, display: cs.display });
      else if (/^[ \t]/.test(l.textContent) && /^(normal|nowrap)$/.test(cs.whiteSpace)) ws.push({ i, ws: cs.whiteSpace });
    });
    const text = lines.length ? lines.map((l) => l.textContent).join('\n') : b.textContent;
    if (!lines.length && /\n[ \t]/.test(text) && /^(normal|nowrap)$/.test(getComputedStyle(b).whiteSpace)) ws.push({ i: 0, ws: getComputedStyle(b).whiteSpace });
    return { lang: b.dataset.codeLang, text, flex, ws };
  });
  return { slots, loose, fonts: [...fonts], code };
}

async function COVER(jobs) {
  let T;
  try { T = await import('/runtime/text.js'); } catch (e) { return { error: `加载 /runtime/text.js 失败：${e.message}` }; }
  const out = [];
  for (const j of jobs) {
    const chars = [...new Set([...j.text].filter((c) => !/[\s\p{Cc}\p{Cf}]/u.test(c)))].join('');
    if (!chars) continue;
    try { await document.fonts.load(j.font, chars); } catch {}
    const r = { where: j.where, font: j.font, miss: T.missingGlyphs(j.font, chars) };
    if (j.box && Number.isFinite(j.box.w)) {
      const c = document.createElement('canvas').getContext('2d'); c.font = j.font;
      // 文本里自己换了行：每行都要放得下；没换行：按 box.lines 行估（总宽 ≤ w × 行数，不模拟断行，偏宽松）
      const ls = j.text.split('\n');
      const w = ls.length > 1 ? Math.max(...ls.map((l) => c.measureText(l).width)) : c.measureText(j.text).width;
      const max = ls.length > 1 ? j.box.w : j.box.w * (Number.isFinite(j.box.lines) ? j.box.lines : 1);
      if (w > max + 0.5) r.wide = { w: Math.round(w), max };
    }
    out.push(r);
  }
  return { out };
}
