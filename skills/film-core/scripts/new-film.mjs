#!/usr/bin/env node
// 建一支新片子的骨架：film.json + scene.html + assets/ + out/。**不拷运行时**。
//
// 运行时怎么到片子里：scene.html 写 import './runtime/motion.js'，由 lib/serve.mjs 在线挂载
// （films/<slug>/runtime/ 里有同名文件就用片内的，否则用已安装 skill 的 assets/runtime/）；
// 交付时 deliver 把实际加载的那几份冻结进 films/<slug>/runtime/ 并写收据。所以建片时什么都不用选、不用猜。
//
// 用法:
//   node new-film.mjs <slug>                                   内核骨架
//   node new-film.mjs <slug> --format 16x9 --fps 24 --title "标题"
//   node new-film.mjs <slug> --recipe explainer                再按配方写文档模板、声明检查（已存在的片子也可以补）
//   node new-film.mjs --list                                   看已安装的配方
//   node new-film.mjs <slug> --from <已有slug> [--title "标题"] 复制已有片子，清掉 out/（同源多版本请用 content.json variants，不要拷贝）
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cli } from '../lib/cli.mjs';
import { locateFilmsDir, installedSkills } from '../lib/env.mjs';
import { parseChecks } from '../lib/film.mjs';
import { FORMATS as LAYOUT } from '../assets/runtime/layout.js';

const argv = process.argv.slice(2);
const { positionals } = cli({
  usage: 'node new-film.mjs <slug> [选项]',
  about: '建 films/<slug>/ 内核骨架（film.json + scene.html），不拷运行时：./runtime/* 由 film-core 的服务器挂载，交付时冻结。',
  positional: '<slug>', positionalHelp: '片子名：小写字母、数字、连字符', maxPositional: 1,
  opts: {
    title: ['<文字>', '片名，默认用 slug'],
    format: ['<画幅>', '9x16 | 1x1 | 16x9，默认 9x16（横版片记得带 --format 16x9）'],
    fps: ['<数>', '默认 30'],
    sub: ['<数>', '运动模糊子帧数，默认 1（迭代期关掉，定稿再提）'],
    formats: ['<列表>', '要同时出的画幅，逗号分隔，如 9x16,16x9；render.mjs --all 渲这个列表'],
    recipe: ['<名字>', '按配方写文档模板、在 film.json checks 里声明检查（--list 看有哪些）。片子已存在时只补缺的文件、并入检查'],
    from: ['<slug>', '把 films/<slug>/ 整支复制成新片（out/ 只带 narration.json 引用的旁白音频），film.json 写 variantOf。只换文案/CTA/画幅的"同源多版本"用 content.json variants + render --variant/--matrix，不拷贝'],
    'films-dir': ['<dir>', 'films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录，都没有就建在 <cwd>/films/'],
    list: '列出已安装 skill 提供的配方后退出',
  },
  notes: '不拷运行时：用到哪个 skill 的运行时直接在 scene.html 里 import，服务器按挂载表解析。',
}, argv);
const flag = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(`--${name}`);
const die = (msg, code = 2) => { process.stderr.write(`✗ ${msg}\n`); process.exit(code); };

// ---- 配方：任何已安装 skill 的 assets/recipes/<名字>/recipe.json ----
function recipes() {
  const out = [];
  for (const { name: skill, dir } of installedSkills()) {
    const root = join(dir, 'assets', 'recipes');
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) if (existsSync(join(root, n, 'recipe.json'))) out.push({ name: n, skill, dir: join(root, n) });
  }
  return out;
}
function loadRecipe(name) {
  const all = recipes().filter((r) => r.name === name);
  if (!all.length) die(`没有叫 "${name}" 的配方。已安装的配方：${recipes().map((r) => `${r.name}（${r.skill}）`).join('、') || '（无）'}`);
  if (all.length > 1) die(`配方 "${name}" 在多个 skill 里都有：${all.map((r) => r.skill).join('、')}。删掉其中一个`);
  const r = all[0];
  let j;
  try { j = JSON.parse(readFileSync(join(r.dir, 'recipe.json'), 'utf8')); } catch (e) { die(`${r.skill} 的配方 ${name}/recipe.json 不是合法 JSON：${e.message}`, 1); }
  if (j.schema !== 1 || !Array.isArray(j.files ?? [])) die(`${r.skill} 的配方 ${name}/recipe.json 要 { "schema": 1, "files": [...] }`, 1);
  try { parseChecks(j.checks ?? []); } catch (e) { die(`${r.skill} 的配方 ${name}：${e.message}`, 1); }
  return { ...j, dir: r.dir, skill: r.skill };
}

if (has('list')) {
  const rs = recipes();
  console.log(rs.length ? '已安装的配方：\n' + rs.map((r) => {
    let about = '';
    try { about = JSON.parse(readFileSync(join(r.dir, 'recipe.json'), 'utf8')).about ?? ''; } catch {}
    return `  ${r.name.padEnd(12)} ${r.skill.padEnd(16)} ${about}`;
  }).join('\n') : '没有已安装的配方（不用配方也行：内核骨架就够渲）');
  process.exit(0);
}

const slug = positionals[0];
if (!slug) die('要给 slug：node new-film.mjs my-film（--help 看选项）');
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) die(`slug 只能用小写字母、数字和连字符，拿到的是 "${slug}"`);
const format = flag('format', '9x16');
if (!LAYOUT[format]) die(`画幅只能是 ${Object.keys(LAYOUT).join(' / ')}，拿到的是 "${format}"`);

const FILMS = locateFilmsDir(flag('films-dir'), { fallback: 'cwd' });
const root = join(FILMS, slug);
const recipeName = flag('recipe');
const recipe = recipeName ? loadRecipe(recipeName) : null;
const exists = existsSync(root);
if (exists && (!recipe || has('from'))) die(`${root}/ 已存在。要给已有片子补配方用 --recipe <名字>（只补缺的文件）；要另起一支换个 slug`);

if (has('from')) { variantFrom(flag('from')); process.exit(0); }

const title = flag('title', slug);
const fps = Number(flag('fps', 30));
const sub = Number(flag('sub', 1));
if (!(Number.isInteger(fps) && fps > 0 && fps <= 240)) die(`--fps 要 1–240 的整数，拿到 ${flag('fps')}`);
if (!(Number.isInteger(sub) && sub >= 1 && sub <= 32)) die(`--sub 要 1–32 的整数，拿到 ${flag('sub')}`);
const multiRaw = (flag('formats', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const bad of multiRaw.filter((f) => !LAYOUT[f])) die(`--formats 不认识 "${bad}"，可选 ${Object.keys(LAYOUT).join(' / ')}`);
// null = 只出 format 那一个画幅。默认不三画幅全开：多数片子只要一个，全开让每次渲染慢三倍
const multi = multiRaw.length ? [...new Set([format, ...multiRaw])] : null;
const { width, height } = LAYOUT[format];

const wrote = [], skipped = [], absent = [], leaked = [];
const put = (rel, content) => {
  const p = join(root, rel);
  if (existsSync(p)) { skipped.push(rel); return; }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
  wrote.push(rel);
};

// ---- 内核骨架 ----
if (!exists) {
  for (const d of ['assets', 'out']) mkdirSync(join(root, d), { recursive: true });
  put('film.json', JSON.stringify({
    slug, title, format, fps, sub,
    entry: 'scene.html',
    formats: multi,        // null = 只出 format 那一个画幅；给了数组，render.mjs --all 才会批渲
    duration: null,        // null = 时长由场景的 window.DURATION 决定（有旁白时它来自 narration.json 实测）
    loop: false,
    checks: [],            // 声明才开的检查（扁平 id 数组）；内核门不用声明、永远开。见 film-core references/api.md
  }, null, 2) + '\n');
  put('scene.html', sceneTemplate());
}

// ---- 配方 ----
let recipeChecks = [];
if (recipe) {
  const T = Object.fromEntries(installedSkills().map((s) => [s.name, s.dir]));
  for (const f of recipe.files ?? []) {
    let src = null;
    if (f.skill) {
      if (!T[f.skill]) { absent.push([f.dest, f.skill]); }
      else src = join(T[f.skill], f.from);
    } else src = join(recipe.dir, f.from);
    if (src && !existsSync(src)) { absent.push([f.dest, `${f.skill ?? recipe.skill}/${f.from}`]); src = null; }
    if (!src) {
      put(f.dest, f.fallback != null ? (typeof f.fallback === 'string' ? f.fallback : JSON.stringify(f.fallback, null, 2) + '\n')
        : /\.json$/.test(f.dest) ? '{}\n'
          : `<!-- 这份模板由 ${f.skill ?? recipe.skill} 提供，它没装上，所以这里是空的。装好之后重跑：node new-film.mjs ${slug} --recipe ${recipe.name} -->\n`);
      continue;
    }
    // 占位符：片名、slug、画幅，以及 <film-xxx>（替成该 skill 的绝对路径，模板里的命令可直接复制运行）。
    // 两套写法都认（<片名> 与 {{title}}）——漏替换是静默的，所以下面还有泄漏检查。
    let text = readFileSync(src, 'utf-8')
      .replaceAll('<片名>', () => title).replaceAll('{{title}}', () => title)   // 函数替换：标题里的 $& 不当替换模式
      .replaceAll('<slug>', slug).replaceAll('{{slug}}', slug)
      .replaceAll('<画幅>', `${format}（${width}×${height}）`);
    for (const [name, dir] of Object.entries(T)) text = text.replaceAll(`<${name}>`, () => dir);
    const leak = [...new Set(text.match(/\{\{[a-zA-Z_]+\}\}/g) || [])];
    if (leak.length) leaked.push([f.dest, leak]);
    put(f.dest, text);
  }
  // film.json：并入配方字段（已有的不改）和配方检查（已声明的不重复）
  const fj = JSON.parse(readFileSync(join(root, 'film.json'), 'utf-8'));
  let declared;
  try { declared = parseChecks(fj.checks); } catch (e) { die(`${slug}/film.json：${e.message}。先改成数组形式再补配方`); }
  const add = (recipe.checks ?? []).filter((c) => !declared.has(typeof c === 'string' ? c : Object.keys(c)[0]));
  const addFields = Object.entries(recipe.film ?? {}).filter(([k]) => !(k in fj));
  if (add.length || addFields.length) {
    for (const [k, v] of addFields) fj[k] = v;
    fj.checks = [...(fj.checks ?? []), ...add];
    writeFileSync(join(root, 'film.json'), JSON.stringify(fj, null, 2) + '\n');
  }
  recipeChecks = add;
}

// ---- 报告 ----
console.log(`films/${slug}/  ${format} ${width}×${height}${exists ? '（已存在，补配方）' : ` @${fps}fps sub=${sub}`}\n`);
if (wrote.length) console.log('新建:\n  ' + wrote.join('\n  '));
if (skipped.length) console.log('\n已存在，跳过:\n  ' + skipped.join('\n  '));
if (absent.length) {
  console.log('\n⚠ 这些模板的来源没装（落的是占位，内容要自己补）:');
  for (const [dest, who] of absent) console.log(`    ${dest.padEnd(22)} ← ${who}`);
}
if (leaked.length) {
  console.log('\n⚠ 这些文件里残留了没被替换的占位符（模板用了脚手架不认识的写法），先手工改掉再往下做:');
  for (const [dest, ph] of leaked) console.log(`    ${dest.padEnd(22)} ${ph.join(' ')}`);
}
if (recipe) {
  console.log(`\n配方 ${recipe.name}（${recipe.skill}）：film.json checks ${recipeChecks.length ? `新声明 ${recipeChecks.map((c) => (typeof c === 'string' ? c : Object.keys(c)[0])).join(' ')}` : '没有要新加的'}`);
  if (recipe.next?.length) console.log('\n下一步（配方的推荐顺序；只有"有旁白时音频先行"是技术约束）:\n  ' + recipe.next.join('\n  '));
} else {
  console.log(`\nfilm.json checks: []（只跑内核门）
下一步：写 scene.html，守 film-core references/kernel.md（seek(t) 纯函数）。
  用到哪个 skill 的运行时就直接 import './runtime/<文件名>'，不用拷；
  看效果 preview.mjs，出片 render.mjs，交付 deliver.mjs（定稿渲染 + 全部门 + 冻结运行时 + 写收据）。`);
}

// ---------------------------------------------------------------------------
function sceneTemplate() {
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  html,body { margin:0; background:#000; }
  #stage { display:block; }
</style>
<canvas id="stage"></canvas>
<script type="module">
// 契约：seek(t) 是时间的纯函数。画出第 t 秒那一帧，别的什么都不做。
// seek 期间不读时钟、不用 Math.random、不靠定时器或上一帧的变量（film-core references/kernel.md）。
// ./runtime/* 不在片子目录里也能 import：film-core 的服务器先找片内 runtime/，再找已安装 skill 的运行时。
import { layoutFromURL } from './runtime/layout.js';
import { settle, spring, seeded } from './runtime/motion.js';

const L = layoutFromURL('${format}');
const cv = document.getElementById('stage');
cv.width = L.width; cv.height = L.height;
const c = cv.getContext('2d');

const rnd = seeded(1);          // 随机数只能来自种子，Math.random 会让两次渲染不一致

// 有旁白时由 narration.json 实测时长决定，不手填
window.DURATION = 3;

// spring() 按「多久停下 + 过冲多少」反解弹簧参数，比直接猜 stiffness/damping 直观
const drop = spring({ duration: 0.9, overshoot: 0.12 });

window.seek = (t) => {
  c.fillStyle = '#000';
  c.fillRect(0, 0, L.width, L.height);

  // ↓↓↓ 占位内容：只为让脚手架立刻能渲通，写自己的东西时整段删掉 ↓↓↓
  const p = settle(t, drop.stiffness, drop.damping);
  const from = L.place(0.5, 0.18);
  const to = L.place(0.5, 0.5);
  c.beginPath();
  c.arc(from.x, from.y + (to.y - from.y) * p, L.size(0.06), 0, Math.PI * 2);
  c.fillStyle = '#e8e4da';
  c.fill();
  // ↑↑↑ 占位内容结束 ↑↑↑
};

window.ready = true;
</script>
`;
}

// ---- 变体：--from <slug> ----
// 复用旁白、素材、文档、片内运行时；不带上一支片子的产物和收据。
// out/ 里只保留 narration.json 引用的旁白音频：narration.json 是时间真相源，它指向的音频没了，合流和念读核验都接不上，
// 而重合成会让字级时间戳全变。其余 out/ 内容（渲染帧、分片缓存、成片、静帧）一律不带——那是旧片的结论。
function variantFrom(src) {
  if (!src || !/^[a-z0-9_][a-z0-9-]*$/.test(src)) die(`--from 要给已有片子的 slug，拿到的是 "${src}"`);
  if (src === slug) die('--from 和新 slug 不能相同');
  const from = join(FILMS, src);
  if (!existsSync(join(from, 'film.json'))) die(`找不到 ${from}/film.json`);
  // 拷贝出来的副本从第一天起就和源片各自漂（改了源片的镜头，副本不跟；时间常量两边各一份）。
  // 只是换文案、CTA、hook、画幅的"同一支片子的几个版本"，应该是一份源 × 多份数据：content.json variants
  console.log(`提示：同源多版本（换 hook / CTA / 文案 / 画幅）请用 content.json variants + render.mjs --variant/--matrix，`
    + `不要拷贝（film-core references/content-json.md）。--from 适合"以这支为起点另做一支新片"。`
    + `${existsSync(join(from, 'content.json')) ? `\n  ⚠ ${src} 已经有 content.json：要的多半是在它里面加一个变体维度，而不是复制。` : ''}\n`);
  const ignored = ['format', 'fps', 'sub', 'formats', 'recipe'].filter(has);
  if (ignored.length) console.log(`⚠ --from 时忽略 ${ignored.map((s) => `--${s}`).join(' ')}：变体沿用 ${src} 的设置，要改就改新片 film.json\n`);

  const SKIP = new Set(['.DS_Store', '__pycache__', 'node_modules']);
  const keepOut = new Set();
  const narPath = join(from, 'narration.json');
  if (existsSync(narPath)) {
    try {
      const nar = JSON.parse(readFileSync(narPath, 'utf-8'));
      for (const p of [nar.audio, ...(nar.lines || []).map((l) => l.wav)])
        if (typeof p === 'string' && p.startsWith('out/')) keepOut.add(p);
    } catch (e) { console.log(`⚠ ${src}/narration.json 解析失败（${e.message}），旁白音频没带过来`); }
  }
  const copied = [], lost = [];
  const copy = (rel) => {
    const d = join(root, rel);
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(join(from, rel), d);
    copied.push(rel);
  };
  const walk = (rel) => {
    for (const name of readdirSync(join(from, rel))) {
      if (SKIP.has(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && (name === 'out' || name === 'receipt.json')) continue;   // 产物和收据是旧片的，不带
      if (statSync(join(from, r)).isDirectory()) walk(r); else copy(r);
    }
  };
  walk('');
  mkdirSync(join(root, 'out'), { recursive: true });
  for (const p of keepOut) existsSync(join(from, p)) ? copy(p) : lost.push(p);

  const { slug: _old, title: oldTitle, variantOf: _prev, ...rest } = JSON.parse(readFileSync(join(root, 'film.json'), 'utf-8'));
  const newTitle = flag('title', oldTitle);
  writeFileSync(join(root, 'film.json'), JSON.stringify({ slug, title: newTitle, variantOf: src, ...rest }, null, 2) + '\n', 'utf-8');

  // 已知残留（历史坑）：模板占位符 {{title}}/{{slug}} 没替换、review_log 标题还是旧片名、脚本还指向旧片
  const TEXT = /\.(md|json|html|txt|sh|js|mjs|py|css)$/;
  const textFiles = copied.filter((r) => TEXT.test(r) && r !== 'film.json' && !r.startsWith('runtime/') && !r.startsWith('out/'));
  const fixedPh = [];
  for (const r of textFiles) {
    const p = join(root, r), t = readFileSync(p, 'utf-8');
    // 替换值用函数传：字符串替换值里的 $&、$1 会被当成替换模式（--title 'A$&B' 要原样写入）
    const u = t.replaceAll('{{title}}', () => newTitle).replaceAll('{{slug}}', () => slug);
    if (u !== t) { writeFileSync(p, u, 'utf-8'); fixedPh.push(r); }
  }
  const retitled = [];
  for (const r of textFiles.filter((x) => /^docs\/review_log\.md$/.test(x))) {
    const p = join(root, r), lines = readFileSync(p, 'utf-8').split('\n');
    if (!/^#\s/.test(lines[0] ?? '')) continue;
    let h = lines[0];
    if (oldTitle && newTitle !== oldTitle) h = h.replaceAll(oldTitle, () => newTitle);
    h = h.replace(new RegExp(`(?<![\\w-])${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), () => slug);
    if (h !== lines[0]) { lines[0] = h; writeFileSync(p, lines.join('\n'), 'utf-8'); retitled.push(r); }
  }
  // 脚本里的旧 slug：跑了会去改旧片（--film 旧片 / films/旧片/），逐行列出
  const SCRIPT = /\.(sh|py|mjs|js)$/;
  const oldRef = new RegExp(`(--film[ =]+['"]?${src}(?![\\w-])|films/${src}(?![\\w-])|['"]${src}['"])`);
  const scriptHits = [];
  for (const r of copied.filter((x) => SCRIPT.test(x) && !x.startsWith('runtime/') && !x.startsWith('out/'))) {
    readFileSync(join(root, r), 'utf-8').split('\n').forEach((l, i) => { if (oldRef.test(l)) scriptHits.push(`${r}:${i + 1}  ${l.trim().slice(0, 90)}`); });
  }

  // 文档和场景里写死的旧 slug 不自动替换（有的是在说"沿用自哪支"，替错比不替糟），列出来让人看
  const mention = copied.filter((r) => TEXT.test(r) && r !== 'film.json' && !r.startsWith('runtime/') && !r.startsWith('out/'))
    .filter((r) => readFileSync(join(root, r), 'utf-8').includes(src));
  const outN = copied.filter((r) => r.startsWith('out/')).length;
  console.log(`films/${slug}/  变体，来自 films/${src}/\n`);
  console.log(`复制 ${copied.length} 个文件${outN ? `（含 out/ 下旁白音频 ${outN} 个）` : ''}`);
  if (lost.length) console.log(`\n⚠ narration.json 引用的音频在 ${src}/out/ 里不存在，没带过来:\n  ` + lost.join('\n  '));
  if (fixedPh.length) console.log(`\n已替换模板占位符 {{title}}/{{slug}}:\n  ` + fixedPh.join('\n  '));
  if (retitled.length) console.log(`\n已把标题行改成新片:\n  ` + retitled.join('\n  '));
  if (!has('title')) console.log(`\n⚠ 没给 --title：片名沿用「${oldTitle}」，成片、文档里会和源片同名`);
  if (scriptHits.length) console.log(`\n⚠ 这些脚本还指向旧片 "${src}"（跑了会改旧片，不是这支），改成 ${slug}:\n  ` + scriptHits.join('\n  '));
  if (mention.length) console.log(`\n这些文件里还写着旧 slug "${src}"，看一眼要不要改:\n  ` + mention.join('\n  '));
  console.log(`\nfilm.json: slug=${slug} variantOf=${src}（没有收据：变体是未交付的新片）`);
  console.log(`下一步：在 docs/ 写一句这支变体和 ${src} 差在哪，然后照常渲染（out/ 是空的，渲染缓存从零开始）。`);
}
