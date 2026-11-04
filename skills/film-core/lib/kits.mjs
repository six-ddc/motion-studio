// film-core lib · kit：品牌/系列范围内共享的、审过的组件库（logo 几何与动效、主题、token、标准帧）。契约见 references/kits.md。
//
// 为什么是 kit 而不是套件运行时：套件运行时（skills/film-*/assets/runtime/）是**能力**，全套件任何一支片子都能用、不带审美；
// kit 是某个品牌/系列**已经定下来**的长相，只给声明了它的片子用。它不进 skills/，放仓库顶层 kits/<名>/。
//
// 挂载沿用运行时那一套，不另起一套：
//   film.json "kits": ["acme"]  →  场景 import './runtime/kits/acme/brand.js'
//   serve 把 /runtime/kits/<kit>/<文件> 解析成：片内 runtime/kits/<kit>/<文件>（冻结副本，片内优先）> kits/<kit>/<文件>（只认 kit.json exports 列的）。
//   加载记录、渲染清单、分片缓存键、uses 门、冻结、收据全部复用运行时那条路径：名字是 kits/<kit>/<文件>，来源记成 kit:<kit>@<版本>。
// 没写 kits 的片子：这里一行都不执行（serve 不找 kits/ 目录、不读 kit.json），行为与改动前逐字节相同。
//
// kits/ 在哪：$KITS_DIR > 从片子目录往上找到的第一个 kits/（仓库根的 kits/；夹具可以在自己目录旁边放一个）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';

export const KIT_NAME = /^[a-z][a-z0-9-]*$/;
export const KIT_PREFIX = 'kits/';
const VERSION = /^\d+\.\d+\.\d+$/;
const KIT_KEYS = new Set(['schema', 'name', 'version', 'about', 'exports', 'check', 'note']);

/**
 * kit 内文件名的规范写法（exports 校验与请求查表共用）：posix normalize，'./a.js' → 'a.js'、'sub/../sub/b.js' → 'sub/b.js'。
 * 越出 kit 目录（'../x.js'）、绝对路径、空名 → null。
 */
export function normKitFile(f) {
  if (typeof f !== 'string' || !f || f.startsWith('/') || f.includes('\\')) return null;
  const n = posix.normalize(f);
  return n === '.' || n === '..' || n.startsWith('../') || n.endsWith('/') ? null : n;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 从 start 往上找第一个 kits/ 目录；$KITS_DIR 优先。找不到返回 null */
export function kitsRoot(start) {
  if (process.env.KITS_DIR) return resolve(process.env.KITS_DIR);
  for (let d = resolve(start); ; d = dirname(d)) {
    if (isDir(join(d, 'kits'))) return join(d, 'kits');
    if (d === dirname(d)) return null;
  }
}

/** film.json 的 kits 字段 → 名字数组。没写 = []；写错直接抛错（拼错的声明不能静默不挂） */
export function declaredKits(raw, where = 'film.json') {
  const k = raw?.kits;
  if (k == null) return [];
  if (!Array.isArray(k) || !k.every((x) => typeof x === 'string' && KIT_NAME.test(x))) {
    throw new Error(`${where} 的 kits 要是 kit 名字数组（小写字母开头，[a-z0-9-]），收到 ${JSON.stringify(k).slice(0, 80)}`);
  }
  if (new Set(k).size !== k.length) throw new Error(`${where} 的 kits 里有重复的名字：${k.join(' ')}`);
  return [...k];
}

/**
 * 读并校验一个 kit：<root>/<name>/kit.json。
 * 返回 { name, version, about, dir, exports: Map<文件, 绝对路径>, check, json }；不合法抛错（说清哪一项）。
 */
export function loadKit(root, name) {
  const dir = join(root, name);
  const p = join(dir, 'kit.json');
  if (!isFile(p)) throw new Error(`找不到 kit ${name}：${p} 不存在（kits/ = ${root}）`);
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${p} 不是合法 JSON：${e.message}`); }
  const errs = [];
  const want = (c, m) => { if (!c) errs.push(m); };
  want(j.schema === 1, `schema 要是 1（收到 ${JSON.stringify(j.schema)}）`);
  want(j.name === name, `name 要等于目录名 "${name}"（收到 ${JSON.stringify(j.name)}）`);
  want(typeof j.version === 'string' && VERSION.test(j.version), `version 要是 x.y.z（收到 ${JSON.stringify(j.version)}）`);
  want(Array.isArray(j.exports) && j.exports.length && j.exports.every((x) => typeof x === 'string'), 'exports 要是非空的文件名数组');
  const extra = Object.keys(j).filter((k) => !KIT_KEYS.has(k));
  want(!extra.length, `不认识的字段 ${extra.join(', ')}`);
  const exports = new Map();
  for (const f of Array.isArray(j.exports) ? j.exports : []) {
    const n = normKitFile(f);
    if (!n || n === 'kit.json') { errs.push(`exports 里的 ${f} 要是 kit 目录内的相对路径（且不是 kit.json）`); continue; }
    const abs = resolve(dir, n);
    if (!isFile(abs)) { errs.push(`exports 里的 ${f} 不存在`); continue; }
    exports.set(n, abs);   // 键用规范写法：请求侧 locateKitFile 同样先 normKitFile 再查
  }
  if (j.check != null) {
    const c = j.check;
    if (typeof c !== 'object' || Array.isArray(c)) errs.push('check 要是对象 { std?, cmd? }');
    else {
      const ck = Object.keys(c).filter((k) => !['std', 'cmd', 'about'].includes(k));
      if (ck.length) errs.push(`check 里不认识的字段 ${ck.join(', ')}`);
      if (c.std != null) {
        const s = c.std;
        if (typeof s?.png !== 'string' || !isFile(join(dir, s.png))) errs.push(`check.std.png 要指向 kit 里存在的 PNG（收到 ${JSON.stringify(s?.png)}）`);
        if (s?.at != null && !(Array.isArray(s.at) && s.at.length && s.at.every((x) => x === 'end' || (typeof x === 'number' && x >= 0)))) errs.push('check.std.at 要是 [秒数 | "end", …]');
      }
      if (c.cmd != null && !(Array.isArray(c.cmd) && c.cmd.length && c.cmd.every((x) => typeof x === 'string'))) errs.push('check.cmd 要是非空字符串数组');
    }
  }
  if (errs.length) throw new Error(`${p} 不合法：\n  - ${errs.join('\n  - ')}`);
  return { name, version: j.version, about: j.about ?? '', dir, exports, check: j.check ?? null, json: j };
}

/** 列出 root 下全部 kit（只读 kit.json；坏的那个返回 { name, error }） */
export function listKits(root) {
  if (!root || !isDir(root)) return [];
  return readdirSync(root).filter((n) => KIT_NAME.test(n) && isFile(join(root, n, 'kit.json'))).sort().map((n) => {
    try { return loadKit(root, n); } catch (e) { return { name: n, error: e.message }; }
  });
}

/** 片内冻结副本的位置：<片子>/runtime/kits/<kit>/ */
export const frozenKitDir = (filmDir, name) => join(filmDir, 'runtime', 'kits', name);

/** 片内冻结的 kit.json（冻结时随文件一起拷进来，记版本用）；没有返回 null */
export function frozenKitInfo(filmDir, name) {
  try { return JSON.parse(readFileSync(join(frozenKitDir(filmDir, name), 'kit.json'), 'utf8')); } catch { return null; }
}

/** '/runtime/' 之后的相对名 → { kit, file } 或 null（不是 kits/<kit>/<文件> 的形状） */
export function parseKitPath(rel) {
  if (!rel.startsWith(KIT_PREFIX)) return null;
  const rest = rel.slice(KIT_PREFIX.length);
  const i = rest.indexOf('/');
  if (i <= 0 || i === rest.length - 1) return null;
  return { kit: rest.slice(0, i), file: rest.slice(i + 1) };
}

/**
 * 一支片子的 kit 挂载表（serve、freeze、deliver 共用）。没声明 kits → { names: [], kits: Map() }，root 不找。
 * 声明了的 kit：kits/ 里有就读并校验（坏了抛错）；kits/ 里没有但片内已冻结 → 照常（交付过的片子搬走后还能开）；两边都没有 → 抛错。
 */
export function filmKits(filmDir, raw = null) {
  if (!raw) { try { raw = JSON.parse(readFileSync(join(filmDir, 'film.json'), 'utf8')); } catch { raw = {}; } }
  const names = declaredKits(raw, join(filmDir, 'film.json'));
  const kits = new Map();
  if (!names.length) return { names, kits, root: null };
  const root = kitsRoot(filmDir);
  const missing = [];
  for (const n of names) {
    if (root && isFile(join(root, n, 'kit.json'))) kits.set(n, loadKit(root, n));
    else if (!frozenKitInfo(filmDir, n)) missing.push(n);
  }
  if (missing.length) {
    throw new Error(`film.json 声明了 kit ${missing.join(' ')}，但${root ? ` ${root} 里` : '从片子目录往上找不到 kits/ 目录，'}没有，片内 runtime/kits/ 也没有冻结副本`
      + `（$KITS_DIR 可以指定 kits/ 的位置）`);
  }
  return { names, kits, root };
}

/**
 * 解析 kits/<kit>/<文件> 的套件外来源（片内副本由调用方先查）：
 *   → { path, from: 'kit:<kit>@<版本>' } | { error: 人话 }
 */
export function locateKitFile(fk, rel) {
  const k = parseKitPath(rel);
  if (!k) return { error: `${rel}：kit 文件的路径是 kits/<kit>/<文件>` };
  if (!fk.names.includes(k.kit)) return { error: `/runtime/${rel}：kit ${k.kit} 没在 film.json kits 里声明（声明了才挂：film.json 加 "kits": ["${k.kit}"]）` };
  const kit = fk.kits.get(k.kit);
  if (!kit) return { error: `/runtime/${rel}：kit ${k.kit} 只有片内冻结副本，而副本里没有 ${k.file}（kits/ 里也没有这个 kit）` };
  const path = kit.exports.get(normKitFile(k.file));
  if (!path) return { error: `/runtime/${rel}：${k.file} 不在 ${k.kit} 的 kit.json exports 里（只伺服导出的文件：${[...kit.exports.keys()].join(' ')}）` };
  return { path, from: `kit:${kit.name}@${kit.version}` };
}

/** 运行时来源字符串是不是 kit：'kit:acme@1.0.0' → { kit, version } | null */
export function kitFrom(from) {
  const m = /^kit:([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(from ?? '');
  return m ? { kit: m[1], version: m[2] } : null;
}

/**
 * 收据的 kits 段（冻结之后调）：{ <kit>: { version, files: { 文件: sha256 } } }，按片内冻结副本算。
 * 没声明 kits 返回 null（收据里不写这个键，老片子的收据格式不变）。
 * loaded：这次渲染加载的运行时清单 [{name, from, sha256}]——用来标出"声明了但没用到"的 kit。
 */
export function kitsReceipt(filmDir, loaded = [], raw = null) {
  if (!raw) { try { raw = JSON.parse(readFileSync(join(filmDir, 'film.json'), 'utf8')); } catch { raw = {}; } }
  const names = declaredKits(raw);
  if (!names.length) return null;
  const out = {};
  for (const n of names) {
    const info = frozenKitInfo(filmDir, n);
    const files = {};
    for (const r of [...loaded].sort((a, b) => a.name.localeCompare(b.name))) {
      const k = parseKitPath(r.name);
      if (!k || k.kit !== n) continue;
      const p = join(frozenKitDir(filmDir, n), k.file);
      files[k.file] = existsSync(p) ? sha256(readFileSync(p)) : r.sha256;
    }
    out[n] = { version: info?.version ?? null, files, ...(Object.keys(files).length ? {} : { note: '声明了但这次渲染没加载它的任何文件' }) };
  }
  return out;
}
