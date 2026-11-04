#!/usr/bin/env node
// films/<slug>/look.json（可选）→ films/<slug>/assets/look.css：本片的颜色 token 和字体，写成 CSS 变量。
//
// 这是可选能力，不是门：没有 look.json 的片子什么都不用做，也没有任何检查读它。
// 本脚本不带任何默认值——look.json 里写什么就生成什么，没写的 token 就不存在。
//
// look.json 形状（全部字段可选，名字随便起）：
//   {
//     "colors": { "<名字>": "<任意 CSS 颜色>" },                       → --color-<名字>
//     "fonts":  { "<名字>": { "family": "<字族>",                       → --font-<名字>: '<字族>', <fallback>
//                             "file": "<相对片子目录的字体文件>",        单文件：交给 fontpack.mjs 拷贝/子集化
//                             "css":  "<fontsource 的 css>",             分片包：交给 fontpack.mjs 取分片
//                             "weight": "100 900", "fallback": "<可选的通用族>" } },
//     "subsetText": ["script.json", "assets/text/labels.txt"]          给了才子集化；路径相对片子目录
//   }
// 只写 family、不给 file/css 的字体只生成变量，不打包（打包另走 fontpack.mjs 或 film-assets 的 subset_font.py）。
//
// 用法（任意 cwd；films/ 按 --films-dir > $FILMS_DIR > 从 cwd 往上找，.venv/ 由 fontpack.mjs 往上找）:
//   node look.mjs --film <slug> [--films-dir <dir>]
// scene 里：<link rel="stylesheet" href="./assets/look.css">
//   DOM 片直接 var(--color-xxx)；canvas 片在加载期读一次（加载期常量，符合内核契约）：
//   const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FILM_OPTS, parseArgs, resolveFilm } from '../../film-core/lib/film.mjs';

const A = parseArgs({
  usage: 'node look.mjs --film <slug>',
  about: '把 films/<slug>/look.json（可选）生成为 assets/look.css（颜色 token / 字体 CSS 变量）；有 file/css 的字体交给 fontpack.mjs 打包。',
  opts: { ...FILM_OPTS },
});
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const die = (m) => { process.stderr.write(`look: ${m}\n`); process.exit(1); };

let F;
try { F = resolveFilm(A.film, A); } catch (e) { die(e.message); }
const { slug, dir } = F;
const base = dirname(dir);
const lookPath = join(dir, 'look.json');
if (!existsSync(lookPath)) die(`${slug} 没有 look.json。它是可选的：不用就不用跑本脚本`);

let look;
try { look = JSON.parse(readFileSync(lookPath, 'utf8')); } catch (e) { die(`look.json 不是合法 JSON：${e.message}`); }
const NAME = /^[a-zA-Z][\w-]*$/;
const SAFE = (v) => typeof v === 'string' && v.trim() && !/[;{}<>]/.test(v);   // 防止值里混进别的 CSS 规则
const fromFilm = (p) => (isAbsolute(p) ? p : join(dir, p));
const known = new Set(['colors', 'fonts', 'subsetText']);
for (const k of Object.keys(look)) if (!known.has(k)) die(`look.json 不认识的字段 "${k}"（只认 colors / fonts / subsetText）`);

const vars = [];
for (const [name, value] of Object.entries(look.colors ?? {})) {
  if (!NAME.test(name)) die(`colors 的名字 "${name}" 只能用字母、数字、-、_，且字母开头`);
  if (!SAFE(value)) die(`colors.${name} 要是一个 CSS 颜色字符串，拿到 ${JSON.stringify(value)}`);
  vars.push(`  --color-${name}: ${value.trim()};`);
}

const textFiles = (look.subsetText ?? []).map(fromFilm);
for (const f of textFiles) if (!existsSync(f)) die(`subsetText 里的 ${f} 不存在`);
const fontsCss = join(dir, 'assets', 'fonts', 'look-fonts.css');
let packed = 0;
for (const [name, spec] of Object.entries(look.fonts ?? {})) {
  if (!NAME.test(name)) die(`fonts 的名字 "${name}" 只能用字母、数字、-、_，且字母开头`);
  if (!spec || !SAFE(spec.family)) die(`fonts.${name} 要有 family（字族名）`);
  if (spec.fallback != null && !SAFE(spec.fallback)) die(`fonts.${name}.fallback 不合法`);
  if (spec.file && spec.css) die(`fonts.${name} 的 file 和 css 只能给一个`);
  vars.push(`  --font-${name}: '${spec.family.replace(/'/g, "\\'")}'${spec.fallback ? `, ${spec.fallback}` : ''};`);
  if (!spec.file && !spec.css) { console.log(`· ${name}: 只生成变量，没给 file/css，不打包`); continue; }
  const src = fromFilm(spec.file ?? spec.css);
  if (!existsSync(src)) die(`fonts.${name} 的 ${spec.file ? 'file' : 'css'} 不存在：${src}`);
  // 字体文件的拷贝、按文案取分片或 pyftsubset 子集化全部交给 fontpack.mjs，这里不另写一套。
  const fp = ['--film', slug, '--films-dir', base, '--css-name', 'look-fonts.css', ...(packed === 0 ? ['--fresh'] : []),
    ...(spec.file ? ['--file', src, '--family', spec.family, '--weight', String(spec.weight ?? '400')] : ['--css', src]),
    ...textFiles.flatMap((f) => ['--text-file', f])];
  try {
    const out = execFileSync(process.execPath, [join(HERE, 'fontpack.mjs'), ...fp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`· ${name}: ${out.split('\n')[0]}`);
  } catch (e) { die(`fonts.${name} 打包失败：${(e.stderr || e.message).trim()}`); }
  if (spec.css) console.log(`  注意：分片包的字族名以它自己的 css 为准，look.json 的 family 要和它一致`);
  packed++;
}
if (!packed && existsSync(fontsCss)) rmSync(fontsCss);   // 上一次生成的，现在 look.json 里已经没有要打包的字体

mkdirSync(join(dir, 'assets'), { recursive: true });
const css = `/* 由 look.mjs 从 look.json 生成，改 look.json 后重跑，别手改这里 */\n`
  + (packed ? `@import url('./fonts/look-fonts.css');\n` : '')
  + `:root {\n${vars.join('\n')}\n}\n`;
writeFileSync(join(dir, 'assets', 'look.css'), css);
console.log(`-> ${join(dir, 'assets', 'look.css')}（${vars.length} 个变量${packed ? `，${packed} 个字体已打包进 assets/fonts/look-fonts.css` : ''}）`);
if (packed) console.log(`字体仍要在 window.ready 里 await loadFonts([...])（film-typography 硬约束 2）；子集外的字会被 missingGlyphs 抓到。`);
if (packed && !textFiles.length) console.log(`没给 subsetText：字体是整份拷进来的，没子集化。`);
