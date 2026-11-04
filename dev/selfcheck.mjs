#!/usr/bin/env node
// film-* skill 套件自己的质量闸门。
//
// 为什么需要它：这套东西的核心主张是"skill 呈现能力，不规定风格"。
// 主张容易写，容易腐烂 —— 加一条"推荐用深色背景"没人会拦，
// 几次之后套件就退回它要修的那个病（审美被写成法律，模型退回安全牌）。
// 所以这条主张必须是可执行的检查，不是文档里的一句话。
//
// 用法:
//   node dev/selfcheck.mjs              查
//   node dev/selfcheck.mjs --verbose    连通过的项一起列
//   node dev/selfcheck.mjs --no-syntax  跳过语法冒烟（node --check / py_compile / bash -n，约 2 秒）
//   node dev/selfcheck.mjs --leak-test  量风格扫描的漏检率：往每份被扫文档的每一行注入违规句，数有几处没抓到
//
// 除了风格中立，还查套件的形状：film-core 是唯一的核，能力 skill 一共 9 个（SUITE）；
// 能力 skill 只许 import film-core（跨能力走 capability()）；起服务器/浏览器只在 film-core/lib；
// 各 skill 的 gates.json 合法、命令指向的脚本存在、片子声明的 checks id 都有人认领；装机 md 总行数。
//
// 退出码 0 通过，1 有不合格项。
//
// 失败级别只放**硬规范**（官方上限、文件引用断了、运行时违约、无条件审美禁令）；
// 自定的建议线（400 行、参考文件目录、description 篇幅、触发词重叠）只报警告——文档瘦身是持续的事，
// 不能因为加了一条建议就让仓库永久红（红了没人修的闸门训练人无视红色）。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEV, '..');
const SKILLS = join(ROOT, 'skills');
const VERIFIED = join(ROOT, 'docs', 'verified');   // 实测记录：开发台账，不随 skill 安装
// 套件的全部 skill。film-core 是入口和内核；其余是可插拔能力，只许依赖 film-core。
const SUITE = ['film-core', 'film-motion', 'film-webfx', 'film-physics', 'film-typography', 'film-narration', 'film-assets', 'film-story', 'film-critique'];
const MD_BUDGET = 6500;   // 装机 md（skills/film-*/ 下全部 .md）总行数的目标线，超了只警告
const argv = process.argv.slice(2);
const KNOWN = new Set(['--verbose', '--no-syntax', '--leak-test', '--help', '-h']);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(8, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
for (const a of argv) if (!KNOWN.has(a)) { console.error(`selfcheck: 未知参数 ${a}（--help 看用法）`); process.exit(2); }
const VERBOSE = argv.includes('--verbose');
const dirs = readdirSync(SKILLS).filter((d) => d.startsWith('film-') &&
  statSync(join(SKILLS, d)).isDirectory()).sort();

const fails = [], warns = [], passes = [];
const fail = (s, m) => fails.push(`${s}: ${m}`);
const warn = (s, m) => warns.push(`${s}: ${m}`);
const pass = (s, m) => passes.push(`${s}: ${m}`);

// ── 1. 结构完整 ───────────────────────────────────────────────
for (const s of SUITE) if (!dirs.includes(s)) fail('suite', `缺 skill ${s}（套件应恰好是这 ${SUITE.length} 个：${SUITE.join(' ')}）`);
for (const s of dirs) if (!SUITE.includes(s)) fail('suite', `多出 skill ${s}：不在套件清单里（合并进已有 skill，或把它加进 dev/selfcheck.mjs 的 SUITE）`);
for (const e of readdirSync(SKILLS)) {
  if (e.startsWith('film-') || e === 'README.md' || e === 'commands' || e === '.DS_Store') continue;
  warn('suite', `skills/${e}：装机只拷 skills/film-*/，套件顶层别的东西不随安装（开发工具放 dev/，记录放 docs/）`);
}
for (const s of dirs) {
  if (!existsSync(join(SKILLS, s, 'SKILL.md'))) fail(s, '缺 SKILL.md');
  if (existsSync(join(SKILLS, s, 'VERIFIED.md'))) fail(s, 'VERIFIED.md 还在 skill 里：实测记录移到 docs/verified/<skill>.md（不随安装）');
  if (!existsSync(join(VERIFIED, `${s}.md`))) fail(s, `缺 docs/verified/${s}.md（实测记录）`);
}

// ── 2. frontmatter 合法且 name 与目录同名 ────────────────────
const metaOf = {};
for (const s of dirs) {
  const p = join(SKILLS, s, 'SKILL.md');
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf-8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) { fail(s, 'SKILL.md 没有 YAML frontmatter'); continue; }
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  let desc = m[1].match(/^description:\s*([\s\S]+?)(?=\n\w+:|$)/m)?.[1]?.trim();
  if (desc && /^[>|][-+]?$/.test(desc.split('\n')[0])) desc = desc.split('\n').slice(1).map((l) => l.trim()).join(' ').trim();  // YAML 块标量
  if (name !== s) fail(s, `frontmatter name "${name}" 与目录名不一致`);
  if (!desc) fail(s, 'frontmatter 缺 description —— 那是唯一的触发机制');
  else {
    // 1024 是 Agent Skills 规范对 description 的上限（超了会被截断或拒收），硬规范；600 是自定的篇幅提醒：
    // description 每轮都进上下文，越长越贵，而且长了以后触发词互相稀释。
    if (desc.length > 1024) fail(s, `description ${desc.length} 字符，超过规范上限 1024`);
    else if (desc.length > 600) warn(s, `description ${desc.length} 字符（> 600）：它每轮都进上下文，考虑把细节挪进正文`);
    if (desc.length < 60) warn(s, `description 只有 ${desc.length} 字，触发词可能不够`);
  }
  const body = text.slice(m[0].length);
  // 行数按整个文件算（wc -l 口径）。500 是 skill 规范建议的 SKILL.md 上限 → 不合格；
  // 400 是自定的渐进披露线 → 只警告。
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  if (lines > 500) fail(s, `SKILL.md ${lines} 行，超过 500 行上限 —— 细节挪进 references/`);
  else if (lines > 400) warn(s, `SKILL.md ${lines} 行，超过 400 行渐进披露线`);
  metaOf[s] = { text, body, desc };
}

// ── 2b. references/*.md 长了要有目录 ─────────────────────────
// 模型按需读参考文件时常常只读开头一段（预览、head）；超过 100 行而开头没有目录，后面的章节等于不存在。
// 目录 = 开头 40 行内出现「目录」/Contents 标题或行首「目录：」，或 ≥3 个页内锚点链接 `](#…)`。只警告。
const refDocs = [];   // [显示名, 绝对路径]，风格扫描也用这张表
for (const s of dirs) {
  const r = join(SKILLS, s, 'references');
  if (existsSync(r)) for (const f of readdirSync(r).sort()) if (f.endsWith('.md')) refDocs.push([`${s}/references/${f}`, join(r, f)]);
}
for (const [name, p] of refDocs) {
  const t = readFileSync(p, 'utf-8'), ls = t.split('\n');
  if (ls.length <= 100) continue;
  const head = ls.slice(0, 40);
  const toc = head.some((l) => /^#+\s*(目录|contents|table of contents)\s*([:：(（].*)?$/i.test(l) || /^\s*(\*\*)?目录(\*\*)?\s*[:：]/.test(l))
    || head.filter((l) => /\]\(#[^)]+\)/.test(l)).length >= 3;
  if (!toc) warn(name.split('/')[0], `${name} ${ls.length} 行，开头 40 行内没有目录（按需读时只读到开头）`);
}

// ── 2c. description 触发词重叠 ────────────────────────────────
// 同一个词出现在两三份 description 里，模型拿到这个词时两个 skill 都像该触发——只是提示，
// 重叠常常是合理的（配乐既是素材也是声音），要的是作者知道有这回事。出现在一半以上 skill 里的词是背景词，不算。
{
  const STOP = new Set(['seek', 'skill', 'docs', 'films', 'film', 'canvas', 'scene.html', '<slug>', '代码渲染视频', '代码渲染影片', '片子', '视频', '影片',
    '哪怕用户只说', '包括', '用于', '使用', '也用于', '触发词', '时加载', '时使用', '加载']);
  const owners = new Map();
  for (const s of dirs) {
    const d = metaOf[s]?.desc; if (!d) continue;
    const terms = new Set(d.split(/[、，,；;（）()"“”「」『』：:。\s/／—…·]+|(?:和|与|或|及|以及)/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 2 && x.length <= 12 && !STOP.has(x) && !/^film-|[./<>]|^\d+$/.test(x)));
    for (const x of terms) owners.set(x, [...(owners.get(x) ?? []), s]);
  }
  const byPair = new Map();
  for (const [x, ss] of owners) if (ss.length >= 2 && ss.length <= Math.max(2, Math.floor(dirs.length / 3))) {
    const k = ss.join(' × '); byPair.set(k, [...(byPair.get(k) ?? []), x]);
  }
  for (const [k, xs] of [...byPair].sort()) warn('description', `${k} 共用触发词：${xs.join('、')}`);
}

// ── 3. 风格中立：这是整套的核心主张，必须可执行 ──────────────
//
// 判据不是"出现了某个词"，而是"出现了**无条件的**审美规定"。
// 一条技法写成"X 的代价是 Y"是合法的；写成"不要 X"而不给代价，就是把口味当法律。
// 扫 SKILL.md 正文和全部 references/*.md：规定写进参考文件一样会被模型照做。
const BANS = [
  // 无条件禁令：同一句里没有"因为/代价/除非……"
  { re: /(?:^|[。；\n])\s*(?:禁止|不许|一律不要|绝不能用)([^。\n]{2,40})/g, why: '无条件禁令' },
  // 默认审美：给具体的配色/字体组合当默认
  { re: /默认(?:配色|色板|主色|字体组合|字体搭配|转场)/g, why: '给了默认审美' },
  { re: /推荐(?:使用)?(?:深色|浅色|暗色)背景/g, why: '推荐了具体配色' },
  // 旧家规的原话，它们正是这次重构要删的
  { re: /每\s*\d+\s*[-–~]\s*\d+\s*秒必须/g, why: '旧家规的节奏法律' },
  { re: /渐变背景上的居中标题/g, why: '旧家规原文' },
];
// 豁免。旧版看命中处 ±200 字里有没有"不会/没有/失败/契约……"之类的词，词表又宽又常见，
// 实测往各 SKILL.md 每行注入一句"禁止使用深色背景"，47.9% 被放过（改造时在当时文档上复量 49.5%；references/ 那时根本不扫）。
// 改成下面的逐行逐句判据后：独立成行注入 0% 漏检，接在已有行尾 1.6%（漏在本身就声明了硬约束的行上）。--leak-test 可复量。
// 现在只看**命中所在的那一行、那一句**，而且每一类豁免都要求结构证据，不是附近出现某个词：
//   a) 否定存在：命中前紧挨着"没有/不给/不带…"（"没有默认转场"是在讲这个病，不是在犯）
//   b) 引用：命中落在本行未闭合的引号/反引号里（"旧规则写了'每 2–4 秒必须…'"）
//   c) 给了理由或说的是技术对象：同一句里有"因为/代价/除非/否则…"，或禁的是代码/API/时钟/随机/授权条款这类非审美对象
//   d) 反面引用：本行命中之前自称旧家规/反面教材/早期版本，或本行是表格行而表头这么自称
//   e) 硬约束：本行命中之前点名了技术不变量/硬约束/契约/KERNEL（"硬约束：禁止…"）
// 授权条款（"禁止用于 ML 训练"、"不得再分发"）归 c)：禁的是授权对象，看同一句，不看整行——
// 否则 film-assets 里每一行提到"授权"的地方都能顺手塞一条审美禁令。
// 否定可以带并列："没有默认配色、默认字体组合"里第二项也在否定之下（并列项之间只许顿号，不跨句、不跨逗号）。
const NEG_BEFORE = /(?:没有|不给|不带|不设|不会有|不提供|找不到|别写|不许写|不写|并无|无)(?:[^。；，,\n、]{1,12}、)*\s*$/;
const REASON = /因为|代价|除非|否则|导致|会让|会把|以免|不然|为了|是因为/;
const TECH_OBJ = /`[^`]+`|[A-Za-z_$][\w$]*\s*[.(]|\b(?:API|CSS|WAAPI|rAF|seek|GPU|WebGL|GLSL|AI|ML|key|token)\b|时钟|随机|跨帧|状态|纯函数|帧契约|副作用|密钥|爬取|训练|许可|授权|再分发|版权|商用|署名/;
const COUNTER = /旧家规|反面教材|早期版本|上一版|旧 skill|旧版|旧条文|旧规则|原条文/;
const HARD_LINE = /技术不变量|硬约束|契约|KERNEL/;
const QUOTES = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ['`', '`']];
function insideQuote(before) {
  before = before.replace(/^\s*(```|~~~)\S*/, '');   // 代码围栏的 ``` 不是引号
  for (const [o, c] of QUOTES) {
    if (o === c) { if ((before.split(o).length - 1) % 2 === 1) return true; }
    else if (before.split(o).length - 1 > before.split(c).length - 1) return true;
  }
  return false;
}
function styleHits(text) {
  const lines = text.split('\n');
  const starts = []; { let p = 0; for (const l of lines) { starts.push(p); p += l.length + 1; } }
  const lineAt = (idx) => { let lo = 0, hi = lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
  const tableHeader = (i) => { if (!/^\s*\|/.test(lines[i])) return null; while (i > 0 && /^\s*\|/.test(lines[i - 1])) i--; return lines[i]; };
  const hits = [];
  for (const { re, why } of BANS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let at = m.index; while (/[。；\n\s]/.test(text[at]) && at < m.index + m[0].length) at++;   // 跳过前导分隔符，定位到命中本体
      const li = lineAt(at), line = lines[li], col = at - starts[li];
      const before = line.slice(0, col);
      const sentence = line.slice(col).split(/[。；]/)[0];
      const th = tableHeader(li);
      const exempt = NEG_BEFORE.test(before.slice(-40)) || insideQuote(before)
        || REASON.test(sentence) || TECH_OBJ.test(sentence)
        || COUNTER.test(before) || (th && COUNTER.test(th)) || HARD_LINE.test(before);
      if (!exempt) hits.push({ index: at, line: li + 1, why, text: m[0].trim().slice(0, 50) });
    }
  }
  return hits;
}

const styleDocs = [];   // [skill, 显示名, 文本]
for (const s of dirs) if (metaOf[s]) styleDocs.push([s, `${s}/SKILL.md`, metaOf[s].body, metaOf[s].text.length - metaOf[s].body.length]);
for (const [name, p] of refDocs) styleDocs.push([name.split('/')[0], name, readFileSync(p, 'utf-8'), 0]);
const styleBad = new Map();
for (const [s, name, body, off] of styleDocs) {
  const fmLines = off ? metaOf[s].text.slice(0, off).split('\n').length - 1 : 0;   // SKILL.md 只扫正文，行号折回整文件
  for (const h of styleHits(body)) styleBad.set(s, [...(styleBad.get(s) ?? []), `  ${name}:${h.line + fmLines} [${h.why}] ${h.text}`]);
}
for (const s of new Set(styleDocs.map((d) => d[0]))) {
  const hits = styleBad.get(s);
  if (hits) fail(s, `风格中立被破坏，${hits.length} 处：\n${hits.join('\n')}`);
  else pass(s, '风格中立');
}

// --leak-test：量上面这套豁免的漏检率。往每份被扫文档的每一行之后插一行违规句（或接在行尾），
// 看命中数有没有在注入位置多出一条。只量不判，量完退出。
if (argv.includes('--leak-test')) {
  const PHRASES = ['禁止使用深色背景', '推荐使用深色背景', '默认配色为深蓝配金'];
  const MODES = { '独立成行': (l, p) => `${l}\n${p}。`, '接在行尾': (l, p) => `${l}${/[。；]$/.test(l) || !l.trim() ? '' : '。'}${p}。` };
  console.log('风格扫描漏检率（注入后命中数没有在注入处增加 = 漏检）\n');
  for (const [mode, inj] of Object.entries(MODES)) for (const ph of PHRASES) {
    let n = 0, miss = 0; const missAt = [];
    for (const [, name, body] of styleDocs) {
      const ls = body.split('\n');
      for (let i = 0; i < ls.length; i++) {
        const mod = [...ls.slice(0, i), inj(ls[i], ph), ...ls.slice(i + 1)].join('\n');
        const lo = ls.slice(0, i).join('\n').length, hi = lo + inj(ls[i], ph).length + 1;
        n++;
        if (!styleHits(mod).some((h) => h.index >= lo && h.index <= hi)) { miss++; if (missAt.length < 3) missAt.push(`${name}:${i + 1}`); }
      }
    }
    console.log(`  ${mode.padEnd(6)} 「${ph}」  ${miss}/${n} 漏检 = ${(100 * miss / n).toFixed(1)}%${missAt.length ? `  例：${missAt.join(' ')}` : ''}`);
  }
  process.exit(0);
}

// ── 4. 跨 skill 引用必须指向真实存在的 skill ─────────────────
for (const s of dirs) {
  if (!metaOf[s]) continue;
  // 不能匹配 `references/film-json.md` 里的 film-json —— 那是文件名不是 skill 名
  const refs = [...metaOf[s].text.matchAll(/\bfilm-([a-z]+)(?![\w.-])/g)].map((m) => `film-${m[1]}`);
  for (const r of new Set(refs)) {
    if (r !== s && !dirs.includes(r)) fail(s, `引用了不存在的 skill：${r}`);
  }
}

// ── 5. 文件引用必须真实存在（最容易腐烂的一类） ───────────────
for (const s of dirs) {
  if (!metaOf[s]) continue;
  const base = join(SKILLS, s);
  // 形如 `scripts/x.mjs` / `references/y.md` / `assets/runtime/z.js` 的本 skill 内引用
  // 只查无歧义的 skill 内路径。`assets/fonts/…`、`assets/_incoming/…` 这类
  // 指的是**片子目录**里的 assets，不在 skill 里，不能拿来判。
  const paths = [...metaOf[s].text.matchAll(/`((?:scripts|references|assets\/runtime)\/[\w./-]+)`/g)]
    .map((m) => m[1]);
  for (const rel of new Set(paths)) {
    if (!existsSync(join(base, rel))) fail(s, `引用的文件不存在：${rel}`);
  }
  // 跨 skill 的 <film-xxx>/path 形式
  const cross = [...metaOf[s].text.matchAll(/<(film-[a-z]+)>\/([\w./-]+)/g)];
  for (const [, who, rel] of cross) {
    if (!dirs.includes(who)) continue;
    if (!existsSync(join(SKILLS, who, rel))) fail(s, `引用 ${who} 的文件不存在：${rel}`);
  }
}

// ── 6. 实测记录 docs/verified/<skill>.md 必须有实测证据和"没解决"一节 ──
for (const s of dirs) {
  const p = join(VERIFIED, `${s}.md`);
  if (!existsSync(p)) continue;
  const t = readFileSync(p, 'utf-8'), v = `docs/verified/${s}.md`;
  if (!/没解决|没测|未验|未测|局限/.test(t))
    fail(s, `${v} 没有"没解决/没测到"一节 —— 留白比假装覆盖有用`);
  if (!/```/.test(t))
    warn(s, `${v} 没有代码块，可能没贴真实输出`);
  if (/应该(?:可以|能|没问题)|大概没问题|理论上可行/.test(t))
    fail(s, `${v} 里有"应该可以"这类未经实测的措辞`);
  // 必须出现数字 —— 实测结论总是带数字的
  if (!/\d+(?:\.\d+)?\s*(?:ms|s|px|fps|帧|%|倍|MB|KB|Hz|dB|LUFS)/.test(t))
    warn(s, `${v} 里没有带单位的实测数字`);
}

// ── 7. Agent 工具与影片运行时不能混（契约 §4） ────────────────
for (const s of dirs) {
  const rt = join(SKILLS, s, 'assets', 'runtime');
  if (!existsSync(rt)) continue;
  for (const f of readdirSync(rt)) {
    const t = readFileSync(join(rt, f), 'utf-8');
    // 运行时跑在浏览器里，不该 import node: 模块或用 process
    if (/from\s+['"]node:|require\(['"]node:|\bprocess\.(argv|exit|cwd)/.test(t))
      fail(s, `assets/runtime/${f} 用了 Node API —— 它跑在浏览器里，Agent 工具该放 scripts/`);
  }
}

// ── 8. 运行时不得违反技术不变量 ───────────────────────────────
// 只查**套件自己写的**运行时。第三方库（vendored）列在 <skill>/assets/vendored.json，不做词法禁令，理由：
//   - 违约只在 seek 期间有害（film-core/references/kernel.md §2）。库在加载期用 setTimeout 等资源、在没开的播放循环里读时钟，都不影响像素；
//     词法禁令分不出这两种，只能逼人给每个库打补丁（three-film 就是这么来的），新库（lottie-web、pixi、p5）一个都进不来。
//   - seek 期间真正的违约不会因此放过：每支片子的 seamcheck 探针在 seek 期间统计禁用 API 调用并判失败，
//     门 1a/1b/2/4 在像素层比对——那才是判据。
// vendored.json 每项要写 upstream 和 license（台账，见 film-assets），列了但文件不存在算不合格（清单会腐烂）。
for (const s of dirs) {
  const rt = join(SKILLS, s, 'assets', 'runtime');
  if (!existsSync(rt)) continue;
  const vp = join(SKILLS, s, 'assets', 'vendored.json');
  let vendored = {};
  if (existsSync(vp)) {
    try { vendored = JSON.parse(readFileSync(vp, 'utf-8')); } catch (e) { fail(s, `assets/vendored.json 不是合法 JSON：${e.message}`); }
    for (const [f, v] of Object.entries(vendored)) {
      if (!existsSync(join(rt, f))) fail(s, `assets/vendored.json 列了 ${f}，但 assets/runtime/ 里没有这个文件`);
      if (!v || !v.upstream || !v.license) fail(s, `assets/vendored.json 的 ${f} 要写 upstream 和 license`);
      else pass(s, `assets/runtime/${f} 是第三方库（${v.upstream}，${v.license}），不做词法禁令；seek 期间的违约由逐片 seamcheck 探针判`);
    }
  }
  for (const f of readdirSync(rt)) {
    if (Object.hasOwn(vendored, f)) continue;
    const t = readFileSync(join(rt, f), 'utf-8');
    const strip = t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [re, what] of [[/\bMath\.random\s*\(/, 'Math.random'],
                              [/\bDate\.now\s*\(/, 'Date.now'],
                              [/\bperformance\.now\s*\(/, 'performance.now'],
                              [/\bsetTimeout\s*\(/, 'setTimeout'],
                              [/\bsetInterval\s*\(/, 'setInterval']]) {
      if (re.test(strip)) fail(s, `assets/runtime/${f} 用了 ${what} —— 违反 seek(t) 纯函数契约`);
    }
  }
}

// ── 8b. 依赖方向：能力 skill 只许依赖 film-core（references/api.md §0） ──
// 等价于 `rg -P "\.\./\.\./film-(?!core)" skills` 为空、`rg -l "create[S]erver|chromium[.]launch" skills` 只命中 film-core/lib/。
// 跨能力一律 capability('film-x')：没装时报「缺能力」而不是崩；写死相对路径，少装一个 skill 就是 ENOENT。
{
  const TEXT = /\.(mjs|cjs|js|py|sh|md|json|html)$/;
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.git', 'out'].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (TEXT.test(e.name)) files.push(p);
  } };
  for (const s of dirs) walk(join(SKILLS, s));
  const SIBLING = /\.\.\/\.\.\/film-(?!core)[a-z]+/;
  const LAUNCH = /create[S]erver|chromium[.]launch/;
  let depBad = 0, launchBad = 0;
  for (const p of files) {
    const rel = relative(SKILLS, p), owner = rel.split('/')[0];
    const lines = readFileSync(p, 'utf-8').split('\n');
    lines.forEach((l, i) => {
      if (SIBLING.test(l)) { depBad++; fail(owner, `${rel}:${i + 1} 直接引用别的能力 skill（${l.match(SIBLING)[0]}）：改用 capability('film-x')`); }
      if (/\.(mjs|cjs|js|py)$/.test(p) && LAUNCH.test(l) && !rel.startsWith('film-core/lib/')) { launchBad++; fail(owner, `${rel}:${i + 1} 自己起服务器/浏览器：只用 film-core/lib 的 serve() / launchBrowser()`); }
    });
  }
  if (!depBad) pass('deps', `${files.length} 个文件没有指向别的能力 skill 的相对路径`);
  if (!launchBad) pass('deps', 'createServer / chromium.launch 只在 film-core/lib');
}

// ── 8c. gates.json：注册表合法、命令指向的脚本存在、片子声明的 checks 都有人认领 ──
// 声明了却没人认领 = 缺能力，accept --deep / deliver 报红；在这里先抓，免得要等跑片子才知道。
if (dirs.includes('film-core')) {
  const { loadGates } = await import(join(SKILLS, 'film-core/lib/gates.mjs'));
  const { parseChecks } = await import(join(SKILLS, 'film-core/lib/film.mjs'));
  const reg = loadGates();
  for (const e of reg.errors) fail('gates', e);
  if (!existsSync(join(SKILLS, 'film-core', 'gates.json'))) fail('film-core', '缺 gates.json（内核门在这里登记）');
  for (const g of reg.gates) {
    for (const a of g.run) {
      const m = a.match(/^\{(skill|core)\}\/(.+)$/);
      if (m && !existsSync(join(m[1] === 'core' ? join(SKILLS, 'film-core') : g.skillDir, m[2]))) fail(g.skill, `gates.json 的门 ${g.id} 要跑 ${a}，文件不存在`);
    }
  }
  if (!reg.errors.length) pass('gates', `${reg.gates.length} 道门（${reg.gates.map((g) => g.id).join(' ')}），${reg.claims.size} 个 checks id 有人认领`);
  // 片子（films/）和夹具（tests/fixtures/）的 checks 都要有人认领：夹具声明了没人认领的 id，check 门的阴性对照就测不到东西
  const unclaimed = new Map();
  for (const base of ['films', 'tests/fixtures']) {
    const D = join(ROOT, base);
    if (!existsSync(D)) continue;
    for (const f of readdirSync(D).sort()) {
      const fj = join(D, f, 'film.json');
      if (!existsSync(fj)) continue;
      let ids;
      try { ids = parseChecks(JSON.parse(readFileSync(fj, 'utf-8')).checks); }
      catch (e) { fail('films', `${base}/${f}/film.json checks：${e.message.slice(0, 120)}`); continue; }
      for (const id of ids.keys()) if (!reg.claims.has(id)) unclaimed.set(id, [...(unclaimed.get(id) ?? []), f]);
    }
  }
  for (const [id, fs] of unclaimed) fail('gates', `checks id「${id}」没有任何 gates.json 认领（${fs.length} 支片子声明，如 ${fs.slice(0, 3).join(' ')}）`);
}

// ── 8d. 装机 md 行数 ──────────────────────────────────────────
// 装机拷的是 skills/film-*/ 整个目录，模型按需读其中的 md；总量是上下文成本的上界。
const mdLines = {};
for (const s of dirs) {
  let n = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) { const t = readFileSync(p, 'utf-8'); n += t.split('\n').length - (t.endsWith('\n') ? 1 : 0); }
  } };
  walk(join(SKILLS, s));
  mdLines[s] = n;
}
const mdTotal = Object.values(mdLines).reduce((a, b) => a + b, 0);
const mdTable = Object.entries(mdLines).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s.replace('film-', '')} ${n}`).join(' · ');
if (mdTotal > MD_BUDGET) warn('suite', `装机 md 共 ${mdTotal} 行，超过目标 ${MD_BUDGET}（${mdTable}）`);
else pass('suite', `装机 md 共 ${mdTotal} 行（目标 ≤ ${MD_BUDGET}）`);

// ── 9. 语法冒烟 ───────────────────────────────────────────────
// 和 `node dev/test.mjs --syntax` 是同一段代码：node --check / compile() / bash -n，全部并发，约 1–2 秒。
// 解析不了的脚本一定是坏的，所以判不合格；能解析不代表能跑，跑要靠 test.mjs 的其余部分和 film-core 的 accept.mjs --deep。
if (!argv.includes('--no-syntax')) {
  const { syntaxSmoke } = await import('./test.mjs');
  for (const r of await syntaxSmoke()) {
    if (r.ok) pass('syntax', `${r.id} ${r.got}`);
    else fail('syntax', `${r.id}：${r.got}`);
  }
}

// ── 报告 ─────────────────────────────────────────────────────
console.log(`film-* skill 套件自检   ${dirs.length} 个 skill   装机 md ${mdTotal} 行（目标 ≤ ${MD_BUDGET}）\n  ${mdTable}\n`);
if (VERBOSE && passes.length) {
  console.log('通过:');
  for (const p of passes) console.log(`  ✓ ${p}`);
  console.log();
}
if (warns.length) {
  console.log('警告（不判不合格）:');
  for (const w of warns) console.log(`  ⚠ ${w}`);
  console.log();
}
if (fails.length) {
  console.log('不合格:');
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log();
}
console.log(fails.length
  ? `✗ ${fails.length} 项不合格，${warns.length} 条警告`
  : `✓ 全部通过（${warns.length} 条警告）`);
process.exit(fails.length ? 1 : 0);
