// film-core lib · 环境定位：films/ 在哪、node_modules 依赖在哪、.venv 在哪、套件装在哪、别的 skill 装没装。
// skill 自己的位置靠 import.meta.url，调用方的东西（films/、node_modules、.venv）跟着 cwd 走，
// 两者互不假设——skill 可能装在 ~/.claude/skills/ 或只读的插件缓存里。
//
// 全套件唯一一份实现：能力 skill 的 Node 脚本 import '../../film-core/lib/env.mjs'（装到同一层后相对关系不变）。
// Python 侧的等价物是 film-core/lib/film.py。
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** 从 cwd 往上找第一个含 films/ 的目录，返回那个 films/ 的绝对路径；找不到返回 null。 */
export function findFilmsUp(start = process.cwd()) {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (isDir(join(d, 'films'))) return join(d, 'films');
    if (d === dirname(d)) return null;
  }
}

/**
 * films/ 的位置：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录。
 * 都没有时：fallback = 'cwd' 返回 <cwd>/films（新建片子用），否则返回 null（调用方报错）。
 * given：命令行 --films-dir 的值（可为 null）。
 */
export function locateFilmsDir(given = null, { fallback = null } = {}) {
  if (given) return resolve(given);
  if (process.env.FILMS_DIR) return resolve(process.env.FILMS_DIR);
  const up = findFilmsUp();
  if (up) return up;
  return fallback === 'cwd' ? join(process.cwd(), 'films') : null;
}

/** 找不到 films/ 时统一的报错文案 */
export function noFilmsDirMessage() {
  return `从 ${process.cwd()} 往上找不到 films/ 目录。在含 films/ 的目录（或其子目录）下运行，或用 --films-dir <dir> / $FILMS_DIR 指定`;
}

// ---------------------------------------------------------------------------
// node_modules 依赖（playwright、@fontsource/*……）
// 顺序：先按 cwd 往上的 package.json / node_modules 解析（调用方项目装的那份），
//      再按脚本自己的位置解析（skill 在仓库里时命中）。
// 不用裸 `import 'playwright'`：skill 拷到 ~/.claude/skills/ 后，裸导入只会从脚本位置往上找，ERR_MODULE_NOT_FOUND。
// ---------------------------------------------------------------------------
const BASES = () => [join(process.cwd(), 'package.json'), import.meta.url];

/** 返回包内文件的绝对路径（如 'playwright' 或 '@fontsource-variable/inter/package.json'）；找不到返回 null。 */
export function resolvePkg(spec) {
  for (const base of BASES()) {
    try { return createRequire(base).resolve(spec); } catch {}
  }
  return null;
}

/** 动态导入一个 node_modules 包；找不到返回 null（调用方决定 SKIP 还是报错）。
 *  按 require 条件解析到的多半是 CJS 入口：import 它只有 default 一个导出，所以把 default 的成员摊平进来，
 *  `const { chromium } = await importPkg('playwright')` 和 `(M.default ?? M)` 两种写法都成立。 */
export async function importPkg(spec) {
  const p = resolvePkg(spec);
  if (!p) return null;
  const ns = await import(pathToFileURL(p).href);
  const d = ns.default;
  return d && (typeof d === 'object' || typeof d === 'function') ? Object.assign({}, d, ns) : ns;
}

/** 找不到就报错退出（exit 1，stderr 说清怎么装）。 */
export async function requirePkg(spec, hint = `在项目根执行 npm i -D ${spec}`) {
  const m = await importPkg(spec);
  if (m) return m;
  process.stderr.write(`✗ 找不到 ${spec}（从 ${process.cwd()} 往上和脚本位置都解析不到）。${hint}\n`);
  process.exit(1);
}

let _pw;
/** playwright 模块；找不到抛错。只给 browser.mjs 用：起浏览器一律走 browser.mjs 的 launchBrowser()（渲染与检查同一条件）。 */
export async function playwright() {
  if (_pw) return _pw;
  _pw = await importPkg('playwright');
  if (_pw) return _pw;
  throw new Error(`找不到 playwright（从 ${process.cwd()} 往上和脚本位置都解析不到）。在项目根执行 npm i -D playwright && npx playwright install chromium`);
}

/** playwright 的版本号（package.json），找不到返回 null */
export function playwrightVersion() {
  const p = resolvePkg('playwright/package.json');
  if (!p) return null;
  try { return createRequire(import.meta.url)(p).version; } catch { return null; }
}

// ---------------------------------------------------------------------------
// .venv：从 cwd 往上找，再从 films/ 的父目录（仓库根）往上找。不只认 <cwd>/.venv。
// ---------------------------------------------------------------------------
/** 返回 .venv/bin/<name> 的绝对路径；找不到返回 null。 */
export function findVenvBin(name, { filmsDir = null } = {}) {
  const starts = [process.cwd()];
  const fd = filmsDir ?? locateFilmsDir();
  if (fd) starts.push(dirname(fd));
  for (const s of starts) {
    for (let d = resolve(s); ; d = dirname(d)) {
      const p = join(d, '.venv', 'bin', name);
      if (existsSync(p)) return p;
      if (d === dirname(d)) break;
    }
  }
  // 已激活的 venv 只作兜底：shell profile 自动激活的环境不该抢在项目自己的 .venv 前面
  if (process.env.VIRTUAL_ENV) {
    const p = join(process.env.VIRTUAL_ENV, 'bin', name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 套件与能力：film-core 在 <skills>/film-core/，别的能力 skill 是它的兄弟目录 <skills>/film-*/。
// 能力 skill 之间不互相 import 相对路径；跨能力一律 capability(name)：装了就用，没装就抛 MissingCapability，
// 调用方（main() 包装）打印「缺能力 film-X」并 exit 1——不崩、不猜。
// ---------------------------------------------------------------------------
export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_ROOT = dirname(CORE_DIR);

/** 已安装的 film-* skill：[{ name, dir }]，按名字排序。判据：<skills>/film-<x>/SKILL.md 存在。 */
export function installedSkills() {
  let names = [];
  try { names = readdirSync(SKILLS_ROOT); } catch { return []; }
  return names.filter((n) => /^film-[a-z0-9-]+$/.test(n) && existsSync(join(SKILLS_ROOT, n, 'SKILL.md')))
    .sort().map((name) => ({ name, dir: join(SKILLS_ROOT, name) }));
}

export class MissingCapability extends Error {
  constructor(name, why = '') {
    super(`缺能力 ${name}：${why || `没装在 ${SKILLS_ROOT}/ 下`}。装上它（把 skills/${name}/ 拷到 film-core 旁边），或者不用依赖它的功能`);
    this.name = 'MissingCapability';
    this.code = 'MISSING_CAPABILITY';
    this.skill = name;
  }
}

/** 这个能力装了没有（不抛错）。 */
export const hasCapability = (name) => installedSkills().some((s) => s.name === name);

/**
 * 取一个能力 skill 的句柄；没装抛 MissingCapability。
 *   const T = capability('film-typography');
 *   T.dir                      该 skill 的绝对路径
 *   T.path('assets/x.json')    其中某个文件的绝对路径（不检查存在）
 *   await T.import('scripts/_x.mjs')   动态 import 该 skill 里的模块；文件不存在也抛 MissingCapability
 */
export function capability(name) {
  if (!/^film-[a-z0-9-]+$/.test(name)) throw new Error(`capability(${JSON.stringify(name)})：能力名是 film-<名字>`);
  const s = installedSkills().find((x) => x.name === name);
  if (!s) throw new MissingCapability(name);
  return {
    name, dir: s.dir,
    path: (rel) => join(s.dir, rel),
    import: async (rel) => {
      const p = join(s.dir, rel);
      if (!existsSync(p)) throw new MissingCapability(name, `装了，但没有 ${rel}（版本不对？）`);
      return import(pathToFileURL(p).href);
    },
  };
}
