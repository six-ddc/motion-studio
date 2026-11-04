#!/usr/bin/env node
// 把字体拷进 films/<slug>/assets/fonts/，生成 assets/fonts/fonts.css（相对路径 @font-face），
// 让片子自包含：渲染机器换了，字体不变。
//
// 两种输入：
//   --css <fontsource 的 css>   unicode-range 分片字体（如 @fontsource-variable/noto-sans-sc/wght.css）
//                               只拷与 --text 有交集的分片
//   --file <字体文件> --family <名字> [--weight "100 900"]
//                               单文件字体。若有 --text 且找得到 .venv/bin/pyftsubset（从 cwd 和仓库根往上找，
//                               或 $VIRTUAL_ENV），用它子集化为 woff2（可变轴保留）；找不到时原样拷贝并在 stderr 提示怎么装
// 文字来源：--text "…" 或 --text-file <path>（可多次给，合并去重）。
// 输出：默认追加进 assets/fonts/fonts.css。--css-name <文件名> 换一个 css（look.mjs 用 look-fonts.css），
//       --fresh 从空 css 开始写而不是追加（重跑同一组字体时不会叠出重复的 @font-face）。
//
// 用法:
// films/ 按 --films-dir > $FILMS_DIR > 从 cwd 往上找；--css / --file / --text-file 的相对路径相对 cwd。
//   node fontpack.mjs --film <slug> --css node_modules/@fontsource-variable/noto-sans-sc/wght.css --text-file films/x/script.json
//   node fontpack.mjs --film <slug> --file path/Font.ttf --family "My Font" --weight "100 900" --text "…"
//
// 字体从哪找、授权是否可商用：参见 film-assets skill。这里只管打包与加载。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FILM_OPTS, parseArgs, resolveFilm } from '../../film-core/lib/film.mjs';
import { findVenvBin } from '../../film-core/lib/env.mjs';

const A = parseArgs({
  usage: 'node fontpack.mjs --film <slug> (--css <fontsource css> | --file <字体> --family <名>) [--text "…"] [--text-file <path>]...',
  about: '把字体拷进 films/<slug>/assets/fonts/ 并生成相对路径 @font-face 的 css，让片子自包含。',
  opts: {
    ...FILM_OPTS,
    css: ['<css>', 'unicode-range 分片字体的 css（只拷与文字有交集的分片）'],
    file: ['<字体文件>', '单文件字体（有文字且有 pyftsubset 时子集化为 woff2）'],
    family: ['<名字>', '--file 的字族名（必填）'], weight: ['<w>', '--file 的字重（默认 400，可变字体写 "100 900"）'],
    text: ['<文字>', '文案（可多次）'], 'text-file': ['<path>', '文案文件（可多次）'],
    'css-name': ['<x.css>', '输出 css 文件名（默认 fonts.css）'], fresh: '从空 css 开始写（不追加）',
  },
});
const { all, flag } = A;
const die = (m) => { process.stderr.write(`fontpack: ${m}\n`); process.exit(1); };

let dir;
try { dir = resolveFilm(A.film, A).dir; } catch (e) { die(e.message); }
const out = join(dir, 'assets', 'fonts');
mkdirSync(out, { recursive: true });
let text = all('text').join('');
for (const f of all('text-file')) text += readFileSync(f, 'utf8');
const cps = new Set([...text].map((c) => c.codePointAt(0)));

const cssName = flag('css-name', 'fonts.css');
if (!/^[\w.-]+\.css$/.test(cssName)) die(`--css-name 只能是 assets/fonts/ 下的文件名（*.css），拿到 ${cssName}`);
const cssPath = join(out, cssName);
let css = existsSync(cssPath) && !A.has('fresh') ? readFileSync(cssPath, 'utf8') : '';
const report = [];

if (flag('css')) {
  const src = resolve(flag('css'));
  const srcCss = readFileSync(src, 'utf8');
  const blocks = srcCss.match(/@font-face\s*{[^}]*}/g) ?? die('css 里没有 @font-face');
  let kept = 0, bytes = 0;
  for (const b of blocks) {
    const ur = /unicode-range:\s*([^;]+);/.exec(b);
    const hit = !ur || !cps.size || ur[1].split(',').some((r) => {
      const [a, z] = r.trim().replace(/^U\+/i, '').split('-').map((h) => parseInt(h, 16));
      for (const c of cps) if (c >= a && c <= (z ?? a)) return true;
      return false;
    });
    if (!hit) continue;
    const url = /url\(([^)]+)\)/.exec(b)[1].replace(/['"]/g, '');
    const file = resolve(dirname(src), url);
    copyFileSync(file, join(out, basename(file)));
    bytes += statSync(file).size; kept++;
    css += b.replace(url, './' + basename(file)).replace(/font-display:[^;]+;/, 'font-display: block;') + '\n';
  }
  report.push(`${basename(src)}: ${blocks.length} 片中拷了 ${kept} 片，${(bytes / 1024).toFixed(1)} KB`);
}

if (flag('file')) {
  const file = resolve(flag('file'));
  const family = flag('family') ?? die('--file 需要 --family');
  const weight = flag('weight', '400');
  let dst = join(out, basename(file));
  const py = cps.size ? findVenvBin('pyftsubset', { filmsDir: dirname(dir) }) : null;
  if (cps.size && !py) {
    process.stderr.write('fontpack: ⚠ 找不到 .venv/bin/pyftsubset（从 cwd、仓库根往上找过，$VIRTUAL_ENV 也没有），字体原样拷贝、没有子集化。\n'
      + '  要子集化：在仓库根 python3 -m venv .venv && .venv/bin/pip install fonttools brotli 后重跑\n');
  }
  if (cps.size && py) {
    dst = join(out, basename(file, extname(file)) + '.subset.woff2');
    writeFileSync(join(out, '.subset.txt'), text);
    execFileSync(py, [file, `--text-file=${join(out, '.subset.txt')}`, '--flavor=woff2', `--output-file=${dst}`, '--layout-features=*']);
  } else copyFileSync(file, dst);
  report.push(`${basename(file)}: ${(statSync(file).size / 1024).toFixed(1)} KB -> ${basename(dst)} ${(statSync(dst).size / 1024).toFixed(1)} KB`);
  css += `@font-face {\n  font-family: '${family}';\n  font-weight: ${weight};\n  font-display: block;\n  src: url(./${basename(dst)});\n}\n`;
}

if (!flag('css') && !flag('file')) die('需要 --css 或 --file');
writeFileSync(cssPath, css);
console.log(report.join('\n'));
console.log(`-> ${cssPath}`);
console.log(`scene.html 里: <link rel="stylesheet" href="./assets/fonts/${cssName}">，然后 await loadFonts([...])`);
