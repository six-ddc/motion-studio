#!/usr/bin/env node
// 自包含 + 台账检查。
//   node <film-assets>/scripts/audit.mjs --film <slug>
// 查：assets/ 下没进 LICENSES.md 的文件（台账一行可记一个 `dir/`）；入口页（film.json entry）/ 片内 runtime/ 里的 local()、file://、绝对路径、
//     外链 http(s) 素材；用到了但没有本地 @font-face / FontFace 声明的字体族名。有问题 exit 1。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { FILM_OPTS, parseArgs, resolveFilm, fail } from '../../film-core/lib/film.mjs';

const A = parseArgs({
  usage: 'node audit.mjs --film <slug>',
  about: '自包含 + 台账检查：assets/ 未入 LICENSES.md 的文件、local()/file:// /绝对路径/外链素材、没有本地声明的字体族。有问题 exit 1。只读。',
  opts: { ...FILM_OPTS },
});
const die = (m, code = 2) => fail(m, code);
/** 解析片子；返回 { slug, dir, config, path(p) }（p 相对片子目录，绝对路径原样） */
const film = () => {
  let F;
  try { F = resolveFilm(A.flag('film'), A); } catch (e) { die(e.message); }
  return { ...F, path: (p) => (isAbsolute(p) ? p : join(F.dir, p)) };
};
const F = film();
const problems = [];
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => {
  const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p];
}) : []);

// 1. 台账
const ledgerPath = F.path('assets/LICENSES.md');
const assets = walk(F.path('assets')).map((p) => relative(F.dir, p))
  .filter((p) => !p.includes('/_incoming/') && !/LICENSES\.md$|\.subset\.(?:json|css)$|\.DS_Store$|^assets\/text\//.test(p));
if (!existsSync(ledgerPath)) {
  if (assets.length) problems.push(`assets/ 有 ${assets.length} 个文件但没有 assets/LICENSES.md（模板在 film-assets/assets/LICENSES.md）`);
} else {
  const ledger = readFileSync(ledgerPath, 'utf8');
  // 一行可以记一个目录（写成以 / 结尾的路径，如 `assets/fonts/noto-sans-sc/`）：
  // 分片包几十个文件同源同授权，逐个记只会让台账没人看
  const dirs = [...ledger.matchAll(/`((?:assets\/)?[^`\s]+\/)`/g)].map((m) => m[1].replace(/^assets\//, ''));
  for (const a of assets) {
    const short = a.replace(/^assets\//, '');
    if (!ledger.includes(a) && !ledger.includes(short) && !dirs.some((d) => short.startsWith(d))) problems.push(`未入账：${a}`);
  }
  if (/待确认|TODO/.test(ledger)) problems.push('LICENSES.md 里还有"待确认/TODO"条目');
}

// 2. 引用检查
const code = [F.path(F.config.entry), ...walk(F.path('runtime'))].filter((p) => existsSync(p) && /\.(html|m?js|css)$/.test(p));
const declared = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial']);
const used = new Map();
for (const p of code) {
  const s = readFileSync(p, 'utf8'), rel = relative(F.dir, p);
  for (const m of s.matchAll(/local\(\s*['"]?([^'")]+)/g)) problems.push(`${rel}: local(${m[1]}) 依赖本机字体`);
  for (const m of s.matchAll(/file:\/\/[^\s'")]+/g)) problems.push(`${rel}: ${m[0]}`);
  for (const m of s.matchAll(/['"(](\/(?:Users|System|Library|home|tmp|private)\/[^'")]+)/g)) problems.push(`${rel}: 绝对路径 ${m[1]}`);
  for (const m of s.matchAll(/(?:src|url|href)\s*[=(]\s*['"]?(https?:\/\/[^'")\s]+\.(?:woff2?|ttf|otf|png|jpe?g|webp|svg|mp4|webm|mp3|wav|ogg))/gi))
    problems.push(`${rel}: 外链素材 ${m[1]}（下载进 assets/）`);
  for (const m of s.matchAll(/font-family\s*:\s*['"]?([^;'"}]+)/g)) declared.add(m[1].trim());
  for (const m of s.matchAll(/new FontFace\(\s*['"]([^'"]+)/g)) declared.add(m[1].trim());
  // ctx.font = '600 48px "X", sans-serif' / font: 48px X
  for (const m of s.matchAll(/font\s*[:=]\s*[`'"][^`'"]*?\d+(?:\.\d+)?px\s+([^`'";]+)/g))
    for (const fam of m[1].split(',')) { const f = fam.trim().replace(/^["']|["']$/g, ''); if (f && !f.includes('$')) used.set(f, rel); }
}
for (const [f, rel] of used) if (!declared.has(f)) problems.push(`${rel}: 字体族 "${f}" 没有本地 @font-face/FontFace 声明，会取本机字体或回退`);

if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); die(`${problems.length} 个问题`, 1); }
console.log(`✓ ${F.slug}: ${assets.length} 个素材已入账，代码里无本机/外链依赖`);
