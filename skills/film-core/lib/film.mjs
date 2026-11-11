// film-core lib · 影片解析、film.json 字段与校验、checks 声明、参数读取（Agent 工具共用）。
// 约定：影片在 <films>/<slug>/，<films> 按 --films-dir > $FILMS_DIR > 从 cwd 往上找（env.mjs）；
// skill 自己的位置靠 import.meta.url 自解析。两者互不假设：skill 可以装在只读的插件缓存里，films/ 跟着调用方的 cwd 走。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { locateFilmsDir, noFilmsDirMessage, MissingCapability } from './env.mjs';
import { cli, FILM_OPTS } from './cli.mjs';

export { FILM_OPTS };

// films/ 的位置：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录（都没有时退回 <cwd>/films，后面会报"没有影片"）
export function filmsDir(args) {
  return locateFilmsDir(args?.flag('films-dir', null), { fallback: 'cwd' });
}

export function listFilms(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'film.json')))
    .map((d) => d.name)
    .sort();
}

// film.json 里内核读的字段与默认值。其他字段原样保留、不校验（别的 skill 的命名空间）
export const DEFAULTS = Object.freeze({
  schema: 1,
  entry: 'scene.html',
  format: '9x16',
  formats: null,      // null = 只有 [format]
  fps: 60,
  sub: 4,
  shutter: 1,
  loop: false,
  duration: null,     // null = 以 window.DURATION 为准
  stage: '#stage',
  crf: 16,
});

const FORMAT_KEYS = ['9x16', '1x1', '16x9'];
// 渲染后端（取值与 browser.mjs BACKENDS 的键一致；film.mjs 不 import browser.mjs，免得只读工具也拉起 playwright 解析）
export const BACKEND_KEYS = ['swiftshader', 'gpu'];

export function validateConfig(c, where) {
  const errs = [];
  const want = (cond, msg) => { if (!cond) errs.push(msg); };
  want(c.schema === 1, `schema 必须是 1（收到 ${JSON.stringify(c.schema)}）`);
  want(typeof c.entry === 'string' && c.entry.endsWith('.html'), `entry 必须是 .html 文件名（收到 ${JSON.stringify(c.entry)}）`);
  want(FORMAT_KEYS.includes(c.format), `format 必须是 ${FORMAT_KEYS.join(' / ')} 之一（收到 ${JSON.stringify(c.format)}）`);
  want(c.formats === null || (Array.isArray(c.formats) && c.formats.length && c.formats.every((f) => FORMAT_KEYS.includes(f))),
    `formats 必须是画幅数组或 null（收到 ${JSON.stringify(c.formats)}）`);
  want(Number.isInteger(c.fps) && c.fps > 0 && c.fps <= 240, `fps 必须是 1-240 的整数（收到 ${c.fps}）`);
  want(Number.isInteger(c.sub) && c.sub >= 1 && c.sub <= 32, `sub 必须是 1-32 的整数（收到 ${c.sub}）`);
  want(typeof c.shutter === 'number' && c.shutter > 0 && c.shutter <= 1, `shutter 必须在 (0,1]（收到 ${c.shutter}）`);
  want(typeof c.loop === 'boolean', `loop 必须是布尔值（收到 ${JSON.stringify(c.loop)}）`);
  want(c.duration === null || (typeof c.duration === 'number' && c.duration > 0), `duration 必须是正数或 null（收到 ${c.duration}）`);
  want(typeof c.stage === 'string' && c.stage.length > 0, `stage 必须是 CSS 选择器（收到 ${JSON.stringify(c.stage)}）`);
  want(Number.isInteger(c.crf) && c.crf >= 0 && c.crf <= 51, `crf 必须是 0-51 的整数（收到 ${c.crf}）`);
  // backend 不进 DEFAULTS：缺省时 config 里就没有这个键（与改动前逐字相同），读的地方一律 browser.mjs filmBackend(F)
  want(c.backend === undefined || BACKEND_KEYS.includes(c.backend), `backend 必须是 ${BACKEND_KEYS.join(' / ')} 之一，或不写（= swiftshader）（收到 ${JSON.stringify(c.backend)}）`);
  if (errs.length) throw new Error(`${where} 不合法：\n  - ${errs.join('\n  - ')}`);
}

/**
 * 解析一部影片。slug 可以是名字（films/<slug>/），也可以是片子目录的路径（含 film.json 的目录，相对 cwd 或绝对；
 * 与 Python film.py 的 resolve_film 同语义）。没给 slug 时：只有一部就用它，否则报错并列出 —— 默默挑一个会渲错片子。
 * 以 _ 开头的目录（夹具）也算，但只有一部时才会被自动选中。
 * **不建任何目录**：只读工具（审计、对照、siblings）调用它不会在别人的片子里留下 out/。要写 out/ 的脚本自己 mkdir。
 * 返回 { slug, dir, films, config, raw, out, entryUrl, formats }；films = 片子所在的目录（门命令的 {films} 用它）。
 */
export function resolveFilm(slug, args) {
  let dir, films;
  const asDir = slug ? resolve(slug) : null;
  if (asDir && isDir(asDir) && existsSync(join(asDir, 'film.json'))) {
    dir = asDir; films = dirname(asDir); slug = basename(asDir);
  } else {
    films = filmsDir(args);
    const all = listFilms(films);
    if (!slug) {
      if (all.length === 1) slug = all[0];
      else {
        throw new Error(all.length
          ? `${films} 下有多部影片，必须用 --film 指定：${all.join(' / ')}`
          : existsSync(films)
            ? `${films} 下没有影片（需要 films/<slug>/film.json）。当前 cwd = ${process.cwd()}`
            : noFilmsDirMessage());
      }
    }
    dir = join(films, slug);
    if (!existsSync(join(dir, 'film.json'))) throw new Error(`找不到 ${join(dir, 'film.json')}。现有影片：${all.join(' / ') || '（无）'}`);
  }
  const cfgPath = join(dir, 'film.json');
  let raw;
  try { raw = JSON.parse(readFileSync(cfgPath, 'utf8')); }
  catch (e) { throw new Error(`${cfgPath} 不是合法 JSON：${e.message}`); }

  const config = { ...DEFAULTS, ...raw };
  // 命令行 --entry 可临时换入口（测试变体、单镜头调试），不改 film.json
  const entry = args?.flag('entry', null) ?? config.entry;
  config.entry = entry;
  validateConfig(config, cfgPath);
  if (!existsSync(join(dir, entry))) throw new Error(`入口 ${join(dir, entry)} 不存在（film.json entry = ${entry}）`);

  return {
    slug, dir, films, config, raw,
    out: join(dir, 'out'),
    entryUrl: '/' + entry.split('/').map(encodeURIComponent).join('/'),
    formats: config.formats ?? [config.format],
  };
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * 统一参数读取：先按参数表校验（--help 打印后 exit 0；未知参数 exit 2），再给出 flag/num/all/has 取值器。
 * flag(n) 取第一个值；可重复的参数（--text a --text b）用 all(n) 取全部。
 * spec 见 cli.mjs：{ usage, about, opts, positional?, notes? }。opts 里通常要并上 FILM_OPTS。
 * 参数表是必填的：不给就没法拒绝未知参数，拼错的 --fomat 会被静默忽略、按默认值跑完（最贵的那种 bug）。
 */
export function parseArgs(spec, argv = process.argv.slice(2)) {
  if (!spec || Array.isArray(spec) || !spec.opts) throw new Error('parseArgs 需要参数表 { usage, opts }（见 lib/cli.mjs）');
  cli(spec, argv);
  return readArgs(argv);
}

/** 不校验的取值器：已经在入口校验过、内部再取一次时用。 */
export function readArgs(argv = process.argv.slice(2)) {
  const flag = (n, d) => {
    const at = argv.indexOf(`--${n}`);
    return at >= 0 && argv[at + 1] != null && !argv[at + 1].startsWith('--') ? argv[at + 1] : d;
  };
  const num = (n, d) => {
    const v = flag(n, null);
    if (v == null) return d;
    const x = Number(v);
    if (!Number.isFinite(x)) fail(`--${n} 需要数字，收到 ${v}`);
    return x;
  };
  /** 可重复参数：--text a --text b → ['a', 'b']（没给 = []） */
  const all = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
  return { argv, flag, num, all, has: (n) => argv.includes(`--${n}`), film: flag('film', null) };
}

/** 失败：非 0 退出码 + stderr 说清为什么 */
export function fail(msg, code = 1) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(code);
}

/** 顶层包装：把异常转成 stderr + exit 1，而不是让 Node 打一屏栈。缺能力（MissingCapability）同样 exit 1，消息以「缺能力 film-X」开头。 */
export async function main(fn) {
  try { await fn(); }
  catch (e) { fail(e instanceof MissingCapability ? e.message : (e?.message ?? String(e))); }
}

// ---------------------------------------------------------------------------
// film.json checks：声明才开的检查（契约见 references/api.md「checks」）。
//   "checks": ["shotlist", "facts.script", "readability", { "contrast": { "min": 4.5 } }]
// 扁平 id 数组；要阈值/参数时写成单键对象 { id: 参数对象 }。id 规则：小写字母开头，[a-z0-9-]，可带一级点号命名空间
// （facts.script / facts.screen）。同一个 id 只能出现一次。id 由某个已安装 skill 的 gates.json 认领，
// 没人认领的 id 在 accept --deep / deliver 里是红的（缺能力），不会静默不开。
// ---------------------------------------------------------------------------
export const CHECK_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$/;

/** 解析 checks 数组 → Map<id, true | 参数对象>。格式不对直接抛错（拼错的声明不能静默不开）。null/缺省 = 空。 */
export function parseChecks(raw) {
  const out = new Map();
  if (raw == null) return out;
  if (!Array.isArray(raw)) throw new Error(`checks 必须是数组（扁平 id 列表，例 ["shotlist", {"contrast": {"min": 4.5}}]），收到 ${JSON.stringify(raw).slice(0, 80)}`);
  for (const item of raw) {
    let id, val;
    if (typeof item === 'string') { id = item; val = true; }
    else if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1) {
      id = Object.keys(item)[0]; val = item[id];
      if (!val || typeof val !== 'object' || Array.isArray(val)) throw new Error(`checks 里 {"${id}": …} 的参数必须是对象，收到 ${JSON.stringify(val)}`);
    } else throw new Error(`checks 的每一项是 id 字符串或单键对象 {id: 参数}，收到 ${JSON.stringify(item)}`);
    if (!CHECK_ID.test(id)) throw new Error(`checks id "${id}" 不合法：小写字母开头，只含 [a-z0-9-]，最多一级点号（如 facts.script）`);
    if (out.has(id)) throw new Error(`checks 里 "${id}" 出现了两次`);
    out.set(id, val);
  }
  return out;
}

/** 读某支片 film.json 的 checks（dir = 片子目录）→ Map。film.json 坏了抛错。 */
export function readChecks(dir) {
  const raw = JSON.parse(readFileSync(join(dir, 'film.json'), 'utf8'));
  return parseChecks(raw.checks);
}

/** 这支片声明了 id 没有：返回 false / true / 参数对象。供能力 skill 的检查脚本读自己的开关和阈值。 */
export function checkParam(dir, id) {
  return readChecks(dir).get(id) ?? false;
}
