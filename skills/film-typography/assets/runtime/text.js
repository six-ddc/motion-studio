// film-typography 运行时：文字作为视觉元素的基础层——字体保障、拆字与前缀测量、可变轴、中日韩排版、字幕绘制。
// 用法：scene.html 里 import './runtime/text.js'（套件挂载；交付时冻结进片子）。依赖 film-core 的 motion.js。
// 文字动画手法（入场预设、打字机节奏、乱码、沿路径、数字滚动、翻转、Magic Move）在同 skill 的 textfx.js，建在本文件之上。
//
// 约定：拆字、测量、断行在**加载时**做一次；seek(t) 只读预计算结果并按 t 画。
//
// 标了【非标准】的函数依赖 Chromium 的实现行为，不是规范保证。
// 升级 Playwright 后跑仓库 dev/film-typography/probe.mjs 回归。

import { sat } from './motion.js';

// ===========================================================================
// 1. 字体加载与保障
// ===========================================================================
/**
 * 显式加载每种字体 + 它要显示的文字，任何一项不成立就抛错。
 *
 * 为什么不只 await document.fonts.ready：
 *  - ready 只等**已被触发加载**的字体。canvas 第一次 fillText 前没人触发，
 *    会先用回退字体画出一帧错的。
 *  - unicode-range 分片字体只加载用到的片，必须把文字传进去才会去取对应片。
 *  - document.fonts.check() 对**根本不存在的字族**返回 true（规范如此：没有匹配的
 *    FontFace 就"无需加载"）。字族名拼错 = 静默回退到系统字体。所以这里改看
 *    load() 返回的 FontFace 数组是否为空。
 *  - 字体缺某个字形时浏览器逐字回退，check() 也测不出来。coverage 选项逐字比对
 *    "主字体, serif" 与 "主字体, sans-serif" 两种回退下的像素：一致 = 字形来自主字体。
 *
 *  - **运行时拼出来的字**（`白子：${n} 口气` 里的 n）不在任何字面量里，最容易漏列。
 *    漏列的字落在没加载的 unicode-range 分片上时，第一次画它的那一帧用回退字体画、同时触发加载，
 *    下一帧才对——这是确定性失败（seamcheck 门 1a/2 抓得到症状；film-assets font_source.mjs 报
 *    "seek 期间才加载"并点名是哪些字）。所以文字位置除了字符串，还可以**按类声明**：
 *      [font, { text: '白子：口气', sets: ['digits'] }]
 *      [font, ['白子：口气', { sets: ['digits', 'ascii'] }, { ranges: ['U+2460-2473'] }]]
 *    sets 见 CHARSETS；ranges 写法同 CSS unicode-range（U+XXXX、U+XXXX-YYYY）。
 *    代价：声明的整类都会被加载、都会逐字核对覆盖（缺一个就抛错）——类越宽，加载越多、越容易
 *    撞上字体本来就不打算排的字。声明"会画到的那一类"，不是"所有可能的字"。
 *
 * @param {Array<[string, string | object | Array]>} specs [[ctx.font 字符串, 要显示的全部文字], ...]
 * @param {{coverage?: boolean}} opts coverage 默认 true，逐字核对字形覆盖（每个独立字约 0.05ms）
 */
export async function loadFonts(specs, { coverage = true } = {}) {
  const problems = [];
  specs = specs.map(([font, text]) => [font, expandChars(text)]);
  for (const [font, text] of specs) {
    let faces;
    try { faces = await document.fonts.load(font, text); }
    catch (e) { problems.push(`${font}: 加载失败 ${e}`); continue; }
    if (!faces.length) {
      problems.push(`${font}: 没有任何 @font-face 匹配这个字族/字重/字形（拼错了？没声明？）`);
      continue;
    }
    const bad = faces.filter((f) => f.status !== 'loaded');
    if (bad.length) problems.push(`${font}: ${bad.length} 个 FontFace 状态 ${bad[0].status}`);
  }
  await document.fonts.ready;
  if (!problems.length && coverage) {
    for (const [font, text] of specs) {
      const miss = missingGlyphs(font, text);
      if (miss.length) problems.push(`${font}: 缺字形 ${miss.slice(0, 20).join('')}${miss.length > 20 ? '…' : ''}（共 ${miss.length} 个，会被逐字回退）`);
    }
  }
  if (problems.length) {
    throw new Error('字体保障失败，继续渲会用回退字体，排版整体错位：\n  ' + problems.join('\n  '));
  }
}

/**
 * 按类声明字符时可用的类名。只是字符集合，不是推荐：用哪类由本片要画什么决定。
 * 想要的类不在这里，用 ranges 写码位区间。
 */
export const CHARSETS = Object.freeze({
  digits: '0123456789',
  'fullwidth-digits': '０１２３４５６７８９',
  'latin-upper': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'latin-lower': 'abcdefghijklmnopqrstuvwxyz',
  latin: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ascii: Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join(''),
});

/**
 * 把 loadFonts 的文字声明展开成字符串。字符串原样返回（旧写法行为逐字节不变）；
 * 其余按顺序拼接，不去重——去重按码位切会拆坏 emoji ZWJ 序列这类多码位字形。
 *   'abc'                              → 字面
 *   { text, sets: [...], ranges: [...] } → 字面 + 各类 + 各码位区间
 *   [上面两种的任意组合]
 * 类名拼错、区间写错直接抛错：静默忽略 = 那一类没被加载，正是这个写法要防的事。
 */
export function expandChars(spec) {
  if (typeof spec === 'string') return spec;
  const out = [];
  const add = (s) => { out.push(s); };
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === 'string') return add(x);
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x !== 'object') throw new Error(`loadFonts: 看不懂的文字声明 ${String(x)}`);
    const extra = Object.keys(x).filter((k) => !['text', 'sets', 'ranges'].includes(k));
    if (extra.length) throw new Error(`loadFonts: 文字声明里不认识的键 ${extra.join('、')}（只有 text / sets / ranges）`);
    if (x.text != null) add(String(x.text));
    for (const name of x.sets ?? []) {
      if (!(name in CHARSETS)) throw new Error(`loadFonts: 没有字符类「${name}」（有：${Object.keys(CHARSETS).join('、')}；别的用 ranges）`);
      add(CHARSETS[name]);
    }
    for (const r of x.ranges ?? []) {
      for (const part of String(r).split(',')) {
        const m = /^\s*U\+([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
        if (!m) throw new Error(`loadFonts: 码位区间写法不对「${part}」（写 U+0030-0039 或 U+2460）`);
        const a = parseInt(m[1], 16), b = m[2] ? parseInt(m[2], 16) : a;
        if (b < a || b > 0x10ffff) throw new Error(`loadFonts: 码位区间「${part}」上界小于下界或超出 Unicode`);
        for (let cp = a; cp <= b; cp++) out.push(String.fromCodePoint(cp));
      }
    }
  };
  walk(spec);
  return out.join('');
}

/** 返回 text 中主字体没有的字形（空白字符跳过）。font 是完整的 ctx.font 串。 */
export function missingGlyphs(font, text) {
  // 必须挂进文档：未挂载的 canvas 上 serif 与 sans-serif 的 CJK 回退是同一个系统字体，
  // 比不出差别（实测：挂载前 '画' 两种回退像素相同，挂载后不同）。
  // 还必须带 lang：文档没有 lang 属性时（ghost-jam 的 scene.html 就没有），serif / sans-serif / cursive
  // 的 CJK 回退全落到同一个系统字体，缺字照样像素相同、全部漏报（实测「龘」三种回退 566994 墨量全等；
  // canvas 上 setAttribute('lang','zh') 后变成 433586 / 566994 / 332261）。设在 canvas 上，不碰页面。
  const c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  c.setAttribute('lang', 'zh');
  c.style.cssText = 'position:fixed;left:-200px;top:0;visibility:hidden';
  document.body.append(c);
  try { return missingGlyphsOn(c, font, text); } finally { c.remove(); }
}
function missingGlyphsOn(c, font, text) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const m = /^(.*?\d+(?:\.\d+)?px(?:\/\S+)?\s+)(.+)$/.exec(font);
  if (!m) throw new Error(`missingGlyphs: 看不懂的 font 串 ${font}`);
  const [, head, family] = m;
  const draw = (fallback, ch) => {
    ctx.clearRect(0, 0, 96, 96);
    ctx.font = `${head.replace(/\d+(?:\.\d+)?px/, '64px')}${family}, ${fallback}`;
    ctx.fillText(ch, 8, 72);
    return ctx.getImageData(0, 0, 96, 96).data;
  };
  const uniq = [...new Set([...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment))]
    .filter((ch) => ch.trim());
  const miss = [];
  const eq = (a, b) => { for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false; return true; };
  for (const ch of uniq) {
    const a = draw('serif', ch);
    if (!eq(a, draw('sans-serif', ch)) || !eq(a, draw('cursive', ch))) miss.push(ch);
  }
  return miss;
}

// ===========================================================================
// 2. 拆字与度量
// ===========================================================================
const segmenters = new Map();
const segmenter = (locale, granularity) => {
  const key = locale + '|' + granularity;
  if (!segmenters.has(key)) segmenters.set(key, new Intl.Segmenter(locale, { granularity }));
  return segmenters.get(key);
};

/** 按 grapheme / word / sentence 拆，返回字符串数组（emoji ZWJ 序列保持完整） */
export function segments(text, { locale = 'zh', granularity = 'grapheme' } = {}) {
  return [...segmenter(locale, granularity).segment(text)].map((s) => s.segment);
}

/**
 * 前缀测量：一串片段在同一行上的位置。返回 [{ s, x, w }] + totalWidth，x_i = measureText(前 i 段).width。
 * 逐段宽度相加会丢 kerning 与 letterSpacing，长行累计误差可达数像素；本套件里一切"拆开逐段画"的布局
 * （splitText、字幕 layoutCaption、textfx 的 layoutText）都走这一个函数。
 * gaps[i] 是第 i 段前要插的字符串（字幕的词间空格）；它算进位置，不算进该段的宽度。
 * 调用前 ctx.font / ctx.letterSpacing 必须已设好，字体已加载（loadFonts）。
 */
export function prefixMeasure(ctx, pieces, { gaps = null } = {}) {
  let acc = '';
  const out = pieces.map((s, i) => {
    acc += gaps?.[i] ?? '';
    const x = ctx.measureText(acc).width;
    acc += s;
    return { s, x, w: 0, end: ctx.measureText(acc).width };
  });
  out.totalWidth = ctx.measureText(acc).width;
  for (const u of out) { u.w = u.end - u.x; delete u.end; }
  return out;
}

/**
 * 把一行文字拆成 [{ ch, x, w }]（前缀测量），x 是相对行首的偏移。
 * 代价：拆开逐段画会丢跨段的连字（fi、ffl）和上下文变体；阿拉伯文、天城文不能这样拆。
 */
export function splitText(ctx, text, { locale = 'zh', granularity = 'grapheme' } = {}) {
  const lay = prefixMeasure(ctx, segments(text, { locale, granularity }));
  const out = lay.map(({ s, x, w }) => ({ ch: s, x, w }));
  out.totalWidth = lay.totalWidth;
  return out;
}

/** 墨水像素数（alpha > threshold 的像素）。测粗细、测合成粗体只能用这个，measureText 测不出来。 */
export function inkCount(ctx, { x = 0, y = 0, w = ctx.canvas.width, h = ctx.canvas.height, threshold = 8 } = {}) {
  const d = ctx.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > threshold) n++;
  return n;
}

// ===========================================================================
// 3. 遮罩升起（入场 / 出场基元；进度由调用方给，缓动、交错、节奏都在调用方——见 textfx.js unitProgress）
// ===========================================================================
/**
 * 逐段从基线下方升进一个行遮罩。alpha 不动。出场：把进度反过来给，或 dir:-1 让字向上离开遮罩。
 *
 * @param glyphs splitText / layoutCJK 的结果（[{ch, x}] + totalWidth）
 * @param opts.x,y      锚点与基线（align 决定 x 是行首、行中还是行尾）
 * @param opts.size     字号 px，决定位移和遮罩高度
 * @param opts.progress (i) => 第 i 段已缓动的进度 [0,1]（必给）
 * @param opts.rise     位移，字号的倍数（必给）
 * @param opts.dir      1 = 自下而上进入；-1 = 自上而下进入
 */
export function drawRiseIn(ctx, glyphs, t, { x, y, size, progress, rise, align = 'left', dir = 1 }) {
  if (typeof progress !== 'function') throw new Error('drawRiseIn: 必须给 progress(i) => 已缓动进度（缓动和交错由调用方定，不替你选）');
  if (rise == null) throw new Error('drawRiseIn: 必须给 rise（位移，字号的倍数）——不替你选');
  const x0 = align === 'center' ? x - glyphs.totalWidth / 2
    : align === 'right' ? x - glyphs.totalWidth : x;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 - size, y - size * 1.25, glyphs.totalWidth + size * 2, size * 1.5);
  ctx.clip();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < glyphs.length; i++) {
    const p = progress(i);
    if (p <= 0) continue;
    ctx.fillText(glyphs[i].ch, x0 + glyphs[i].x, y + dir * (1 - p) * size * rise);
  }
  ctx.restore();
}

// ===========================================================================
// 4. 可变字体轴
// ===========================================================================
/** {wght: 700, opsz: 32} -> "'wght' 700, 'opsz' 32" */
export const axesString = (axes) => Object.entries(axes).map(([k, v]) => `'${k}' ${v}`).join(', ');

/**
 * 【非标准】驱动任意可变轴（wdth / opsz / slnt / GRAD / 自定义轴）。
 *
 * 机制：canvas **元素**的 CSS font-variation-settings 会被 2D context 继承，
 * 但只在**重新给 ctx.font 赋值**时读取。所以这里两步都做。
 * 只动字重时不需要它：ctx.font 的数字字重本身就是连续的（标准行为）。
 * OffscreenCanvas 没有元素，这招不可用。
 * 每次调用都写一次 style，属于 DOM 写，但不读布局，不会强制回流。
 */
export function setAxes(ctx, axes, font) {
  const canvas = ctx.canvas;
  if (!canvas.style) throw new Error('setAxes: OffscreenCanvas 没有元素，设不了可变轴');
  canvas.style.fontVariationSettings = axesString(axes);
  ctx.font = font;
}

/** 清掉 setAxes 的轴设置，避免泄漏到后面画的字 */
export function clearAxes(ctx, font) {
  ctx.canvas.style.fontVariationSettings = 'normal';
  ctx.font = font;
}

/**
 * 【非标准】关掉合成粗体/斜体。只声明 400 的字族被要求 700 时，Chromium 会把字形涂厚
 * （advance 不变，measureText 看不出来）；不同机器合成策略可能不同。
 * 写在 @font-face 里没用，必须设在 canvas 元素上。
 */
export function disableFontSynthesis(ctx) {
  if (ctx.canvas.style) ctx.canvas.style.fontSynthesis = 'none';
}

// ===========================================================================
// 5. 中日韩排版
// ===========================================================================
// 标点分类（clreq / JIS X 4051 的简化版）
const OPEN = '「『（《〈【〔［｛“‘';
const CLOSE = '」』）》〉】〕］｝”’';
const STOP = '、，。．：；！？';
const MIDDLE = '・·';
export const punctClass = (ch) =>
  OPEN.includes(ch) ? 'open' : CLOSE.includes(ch) ? 'close' : STOP.includes(ch) ? 'stop' : MIDDLE.includes(ch) ? 'middle' : null;

/** 避头：不能出现在行首 */
export const NO_LINE_START = CLOSE + STOP + MIDDLE + 'ー～%‰℃々ゝゞヽヾぁぃぅぇぉっゃゅょァィゥェォッャュョ';
/** 避尾：不能出现在行尾 */
export const NO_LINE_END = OPEN;

/**
 * 标点挤压。canvas 里全角标点 advance 严格 1em（实测），没有 DOM 的 text-spacing-trim。
 *
 * mode:
 *  'none'     全角式：每个标点占 1em（大陆出版物默认习惯）
 *  'adjacent' 相邻挤压：两个标点相邻时，前一个收成半角（clreq 的"标点挤压"）
 *  'half'     全部半角：所有标点占 0.5em（密、现代，代价是标点存在感弱）
 * 返回每个字的 { advanceScale, shift }：shift 以 em 计，开括号收半角时字形在 em 框右半，
 * 需左移 0.5em 才不会留出空隙。
 * ⚠ 字形在 em 框里的位置随字体地区而变：简体字体的 ，。 在左下，繁体/日文字体可能居中。
 *   居中的字体不适合挤压，挤了标点会贴到下一个字上。
 */
export function punctAdjust(chars, mode = 'adjacent') {
  return chars.map((ch, i) => {
    const cls = punctClass(ch);
    if (!cls || mode === 'none') return { advanceScale: 1, shift: 0 };
    const next = punctClass(chars[i + 1] ?? '');
    const prev = punctClass(chars[i - 1] ?? '');
    const squeeze = mode === 'half' || (mode === 'adjacent' && (
      (cls !== 'open' && next) || (cls === 'open' && prev)));
    if (!squeeze) return { advanceScale: 1, shift: 0 };
    if (cls === 'open') return { advanceScale: 0.5, shift: -0.5 };
    if (cls === 'middle') return { advanceScale: 0.5, shift: -0.25 };
    return { advanceScale: 0.5, shift: 0 };
  });
}

/**
 * 断行 + 避头尾，返回行字符串数组。ctx.font 要先设好。
 *  - 连续的拉丁字母/数字当作不可断的一个单元（不把 "seek" 拆成 "se/ek"）
 *  - 违反避头尾时把前面的单元一起挪到下一行（"推出"），连续多个禁则字符也处理
 *  - 一行只剩一个单元仍超宽时强制放下（不死循环）
 * 只测量整行前缀，不逐字相加，kerning 与 letterSpacing 都算进去了。
 * 不做标点挤压；需要挤压时用 layoutCJK。
 */
export function wrapCJK(ctx, text, maxWidth) {
  const units = toUnits(text);
  const lines = [];
  let line = [];
  const width = (arr) => ctx.measureText(arr.join('')).width;
  for (const u of units) {
    if (u === '\n') { lines.push(line.join('')); line = []; continue; }
    const cand = [...line, u];
    if (!line.length || width(cand) <= maxWidth) { line = cand; continue; }
    // 超宽，要在 u 之前断。若 u 避头或行尾避尾，往回挪
    let carry = [u];
    while (line.length > 1 && (startsForbidden(carry[0]) || NO_LINE_END.includes(line[line.length - 1]))) {
      carry.unshift(line.pop());
    }
    lines.push(line.join(''));
    line = carry;
  }
  if (line.length) lines.push(line.join(''));
  return lines.map((l) => l.replace(/^ +| +$/g, ''));
}
const startsForbidden = (u) => NO_LINE_START.includes(u[0]);
function toUnits(text) {
  const out = [];
  for (const g of segments(text, { granularity: 'grapheme' })) {
    const prev = out[out.length - 1];
    if (prev && /^[A-Za-z0-9'’.\-]+$/.test(prev) && /^[A-Za-z0-9'’.\-]$/.test(g)) out[out.length - 1] = prev + g;
    else out.push(g);
  }
  return out;
}

/**
 * 一行 CJK 文字的逐字布局（带标点挤压），返回 [{ ch, x }] + totalWidth。
 * 汉字之间用 1em 固定 advance（实测 canvas 里本来就是 1em），拉丁段用前缀测量。
 * size 是字号 px。
 */
export function layoutCJK(ctx, text, size, { punct = 'adjacent' } = {}) {
  const chars = segments(text, { granularity: 'grapheme' });
  const adj = punctAdjust(chars, punct);
  const out = [];
  let x = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = ctx.measureText(chars[i]).width;
    out.push({ ch: chars[i], x: x + adj[i].shift * size, w: w * adj[i].advanceScale });
    x += w * adj[i].advanceScale;
  }
  out.totalWidth = x;
  return out;
}

// ===========================================================================
// 6. 字幕绘制（时间轴归 film-narration：cap = vo.captionAt(t) 给出哪些词、各词起止；这里只管字形）
// ===========================================================================
/**
 * 一块字幕的逐词布局（前缀测量），返回 [{ w, x, width }] + totalWidth。
 * 词间空格：cap.spaces（narration.js 按拉丁词边界算好的）优先；没有时用 joiner（英文 token 不带空格时传 ' '）。
 */
export function layoutCaption(ctx, words, { spaces = null, joiner = '' } = {}) {
  const gaps = words.map((_, i) => spaces?.[i] ?? (i ? joiner : ''));
  const lay = prefixMeasure(ctx, words.map((wd) => wd.w), { gaps });
  const out = lay.map(({ s, x, w }) => ({ w: s, x, width: w }));
  out.totalWidth = lay.totalWidth;
  return out;
}

/**
 * 逐词高亮字幕。cap 来自 film-narration 的 vo.captionAt(t)（{ words:[{w,start,end}], spaces, t }），或任何同形数据。
 * 外观全部由调用方按本片 style_guide 给，没有默认字体和配色（缺了就抛错，避免所有片子长成同一个字幕）。
 *
 *   drawCaption(ctx, cap, { font, x, y, align, idle, active, mode, stroke, lineWidth, alpha })
 *     font    完整 ctx.font 串（'700 56px "Noto Sans SC"'）       x, y   锚点与基线（align: center|left|right，默认 center）
 *     idle    未念到的词的填色     active   念到的词的填色
 *     mode    'cumulative'（念过的都亮，与 ASS \kf 同义）| 'current'（只亮正在念的词），默认 cumulative
 *     stroke / lineWidth  描边（可选）   alpha  整块透明度（默认 1）
 *   drawCaption(ctx, cap, { font, x, y, align, style })
 *     style(i, state, activeP) → { fill, stroke?, lineWidth?, dy?, axes?, alpha? }
 *       state ∈ 'past' | 'active' | 'future'；activeP = 当前词已念进度 0..1（扫光、字重渐变、逐词弹起用它）。
 *       给了 style 就不看 idle / active / mode。
 *   t 默认取 cap.t（captionAt 记下的时刻）；要错开时显式传 opts.t。
 * 只画单行；多行、竖排、逐字入场在调用方用 wrapCJK / textfx 自己排。
 */
export function drawCaption(ctx, cap, opts) {
  if (!cap) return;
  const { font, x, y, align = 'center', style = null, joiner = '', alpha = 1 } = opts ?? {};
  const need = ['font', 'x', 'y', ...(style ? [] : ['idle', 'active'])];
  const miss = need.filter((k) => opts?.[k] == null);
  if (miss.length) throw new Error(`drawCaption 缺少参数 ${miss.join(', ')}（按本片 style_guide 定）`);
  const t = opts.t ?? cap.t;
  if (t == null) throw new Error('drawCaption: cap 里没有 t（不是 captionAt 的结果），显式传 opts.t');
  const mode = opts.mode ?? 'cumulative';
  if (!['cumulative', 'current'].includes(mode)) throw new Error(`drawCaption: mode 只能是 cumulative / current，收到 ${mode}`);
  const paint = style ?? ((i, state) => ({
    fill: (mode === 'current' ? state === 'active' : state !== 'future') ? opts.active : opts.idle,
    stroke: opts.stroke, lineWidth: opts.lineWidth,
  }));
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const lay = layoutCaption(ctx, cap.words, { spaces: cap.spaces, joiner });
  const x0 = align === 'center' ? x - lay.totalWidth / 2 : align === 'right' ? x - lay.totalWidth : x;
  cap.words.forEach((wd, i) => {
    const state = t >= wd.end ? 'past' : t >= wd.start ? 'active' : 'future';
    const activeP = sat((t - wd.start) / Math.max(1e-6, wd.end - wd.start));
    const s = paint(i, state, activeP);
    if (!s) return;
    const px = x0 + lay[i].x, py = y + (s.dy ?? 0);
    ctx.save();
    if (s.alpha != null) ctx.globalAlpha *= s.alpha;
    if (s.axes) setAxes(ctx, s.axes, font);
    if (s.stroke && (s.lineWidth ?? 0) > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = s.lineWidth;
      ctx.strokeStyle = s.stroke;
      ctx.strokeText(wd.w, px, py);
    }
    ctx.fillStyle = s.fill;
    ctx.fillText(wd.w, px, py);
    if (s.axes) clearAxes(ctx, font);
    ctx.restore();
  });
  ctx.restore();
}
