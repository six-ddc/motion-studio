#!/usr/bin/env node
// 在 Chromium 里证明某个字体文件真的能渲出给定文字，而不是悄悄回退到系统字体。
//
//   node <film-assets>/scripts/font_proof.mjs --film <slug> --font assets/fonts/x.subset.woff2 \
//        [--text "要验的句子"] [--size 96]
//   不给 --text 时读同名 .subset.json 台账里的 chars。
//   分片包：--font assets/fonts/<name>.subset.css（subset_font.py --pack 的产出，或任何本地 @font-face CSS），
//   每片按自己的 unicode-range 注册成同一个私有族，和浏览器里真实的分片选择一致。[--weight 600]
//
// 判据（不靠肉眼）：每个字用 `__proof__, <回退>` 配多组不同回退栈各画一次。
// 字来自待验字体 → 各次像素完全相同；回退到了系统字体 → 至少两组不同。
// 局限：若本机所有回退栈对某字都落到同一款系统字体，检测不出——所以另有 subset_font.py --check 查 cmap。
// 这样即使本机装了同名字体，也不会被"看起来对"骗过（FontFace 用的是私有族名 __proof__）。
// 产出 out/font-proof-<name>.png；有字回退则 exit 1 并列出。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { parseFontFaceCss } from '../../film-core/lib/fontcss.mjs';
import { FILM_OPTS, parseArgs, resolveFilm, fail } from '../../film-core/lib/film.mjs';
import { launchBrowser } from '../../film-core/lib/browser.mjs';

const A = parseArgs({
  usage: 'node font_proof.mjs --film <slug> --font assets/fonts/x.subset.woff2|x.subset.css [--text "句子"] [--size 96] [--family 名] [--weight 600]',
  about: '在 Chromium 里证明字体文件真的渲出给定文字（没回退到系统字体）。产出 out/font-proof-<name>.png；有字回退 exit 1。',
  opts: {
    ...FILM_OPTS,
    font: ['<path>', '字体文件或分片包 CSS（相对片子目录）'],
    text: ['<文字>', '要验的文字；不给时读同名 .json 台账的 chars'],
    size: ['<px>', '字号（默认 96）'],
    family: ['<族名>', '分片 CSS 里有多个族时指定'],
    weight: ['<N>', '字重'],
  },
});
const die = (m, code = 2) => fail(m, code);
/** 解析片子；返回 { slug, dir, config, path(p) }（p 相对片子目录，绝对路径原样） */
const film = () => {
  let F;
  try { F = resolveFilm(A.flag('film'), A); } catch (e) { die(e.message); }
  return { ...F, path: (p) => (isAbsolute(p) ? p : join(F.dir, p)) };
};
const F = film();
const fontRel = A.flag('font') ?? die('缺 --font');
const fontPath = F.path(fontRel);
if (!existsSync(fontPath)) die(`字体不存在：${fontPath}`);
let text = A.flag('text');
if (!text) {
  const manifest = fontPath.replace(/\.(woff2|ttf|otf|css)$/, '.json');
  if (!existsSync(manifest)) die('没给 --text，也找不到同名 .json 台账');
  text = JSON.parse(readFileSync(manifest, 'utf8')).chars.replace(/[\x20-\x7e]/g, '');
}
const size = Number(A.flag('size', 96));
// 单文件 = 一片、不限 unicode-range；分片包 = CSS 里每个 @font-face 一片
let pieces;
if (/\.css$/i.test(fontPath)) {
  const faces = parseFontFaceCss(fontPath);
  if (!faces.length) die(`${fontRel} 里没有 @font-face`);
  const fams = [...new Set(faces.map((f) => f.family))];
  const fam = A.flag('family') ?? (fams.length === 1 ? fams[0] : die(`${fontRel} 里有 ${fams.length} 个族，用 --family 指定：${fams.join(' / ')}`));
  pieces = faces.filter((f) => f.family.toLowerCase() === fam.toLowerCase()).map((f) => {
    if (!f.path || !existsSync(f.path)) die(`分片不是本地文件或不存在：${f.url}`);
    return { b64: readFileSync(f.path).toString('base64'), desc: { ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}), weight: f.weight, style: f.style } };
  });
} else {
  pieces = [{ b64: readFileSync(fontPath).toString('base64'), desc: {} }];
}
const single = [...new Set(pieces.map((p) => p.desc.weight).filter(Boolean))];
const weight = A.flag('weight') ?? (single.length === 1 && /^\d+$/.test(single[0]) ? single[0] : '400');

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.setContent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="margin:0;background:#fff">');
const res = await page.evaluate(async ({ pieces, text, size, weight }) => {
  for (const p of pieces) {
    const bin = Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0));
    const face = new FontFace('__proof__', bin.buffer, p.desc);
    try { await face.load(); } catch (e) { return { error: `FontFace 加载失败：${e.message}` }; }
    document.fonts.add(face);
  }
  const glyph = (ch, fallback) => {
    const c = new OffscreenCanvas(size * 2, size * 2), x = c.getContext('2d');
    x.font = `${weight} ${size}px __proof__, ${fallback}`; x.fillStyle = '#000'; x.textBaseline = 'middle';
    x.fillText(ch, size / 2, size);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const FALLBACKS = ['serif', 'sans-serif', 'monospace', 'cursive', '"Songti SC", "SimSun", serif', '"PingFang SC", "Microsoft YaHei", sans-serif', '"Kaiti SC", "KaiTi", cursive'];
  const chars = [...new Set([...text])].filter((ch) => ch.trim());
  const fellBack = [];
  for (const ch of chars) {
    // 系统对中文的 serif/sans-serif/monospace/cursive 回退往往落到同一款字体，
    // 所以用多组回退栈：任意两组像素不同 → 这个字不是待验字体画的。
    const r = FALLBACKS.map((f) => glyph(ch, f));
    let ink = 0, diff = 0;
    for (let i = 3; i < r[0].length; i += 4) {
      if (r[0][i]) ink++;
      for (let k = 1; k < r.length; k++) if (r[k][i] !== r[0][i]) { diff++; break; }
    }
    if (diff > 0 || ink === 0) fellBack.push(ch);
  }
  // 出一张人眼可看的样张：上行 = 待验字体，下行 = 同句强制系统 serif 作对照
  const lines = [];
  for (let i = 0; i < text.length; i += 14) lines.push(text.slice(i, i + 14));
  const cv = document.createElement('canvas');
  cv.width = 1600; cv.height = Math.min(900, 60 + lines.length * size * 1.3 * 2 + 40);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#111'; ctx.textBaseline = 'top';
  let y = 30;
  for (const l of lines) {
    ctx.font = `${weight} ${size}px __proof__, serif`; ctx.fillText(l, 40, y); y += size * 1.3;
    ctx.fillStyle = '#999'; ctx.font = `${size * 0.5}px serif`; ctx.fillText('↑ 待验字体   ↓ 系统 serif 对照', 40, y); y += size * 0.6;
    ctx.font = `${size}px serif`; ctx.fillText(l, 40, y); y += size * 1.4; ctx.fillStyle = '#111';
  }
  return { png: cv.toDataURL('image/png').split(',')[1], fellBack, checked: chars.length };
}, { pieces, text, size, weight });
await browser.close();
if (res.error) die(res.error, 1);

const out = join(F.dir, 'out');
mkdirSync(out, { recursive: true });
const png = join(out, `font-proof-${basename(fontPath).replace(/\.[^.]+$/, '')}.png`);
writeFileSync(png, Buffer.from(res.png, 'base64'));
console.log(`样张：${png}`);
if (res.fellBack.length) die(`${res.fellBack.length}/${res.checked} 个字没由该字体渲出（回退了）：${res.fellBack.join('')}`, 1);
console.log(`✓ ${res.checked} 个字全部由 ${basename(fontPath)}${pieces.length > 1 ? `（${pieces.length} 片）` : ''} 渲出（多组回退栈像素一致，字重 ${weight}）`);
