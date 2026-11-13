// film-core lib · 在 Node 里 import 运行时文件（检查脚本、烘焙脚本复用浏览器那份代码时用）。
//
// 为什么需要：运行时在浏览器里靠 serve 的挂载表扁平解析（/runtime/<名字>），
// 但运行时文件之间写的是相对 import（choreo.js 里 `import './motion.js'`）。
// 在 Node 里按文件路径解析，./motion.js 会落在 film-motion/assets/runtime/ 下——那里没有，它在 film-core。
// 这里给 Node 装一个同样语义的解析钩子：相对 import 找不到、且基名在套件运行时索引里时，改指套件那份。
//
// 用法：
//   import { registerRuntimeResolver, importRuntime } from '../../film-core/lib/runtime-node.mjs';
//   registerRuntimeResolver();                       // 之后普通 import 运行时文件即可
//   const { makeNarration } = await importRuntime('narration.js');   // 按扁平名字取套件那份（自动注册钩子）
//   const { makeNarration } = await importRuntime('narration.js', { film: F.dir });   // 片内有同名（冻结副本）时取片内的
//
// 需要 Node ≥ 22.15（module.registerHooks 同步钩子）。
//
// **Node 侧加载记录**（deliver 冻结与收据用）：importRuntime(name, { film }) 之后，这个进程为这支片子实际加载的运行时
// （含它们之间的相对 import，比如 sfx.mjs → sfxdsp.mjs → rand.js）和调用它的脚本（process.argv[1]）的 sha256，
// 合并写进 <片子>/out/.render/runtime-node.json。浏览器之外生成的产物（音效 out/sfx.wav、烘焙数据）就这样进入交付：
// deliver 把这些运行时与浏览器加载的一起冻结进片内 runtime/（于是进收据的输入摘要），脚本的 sha 记在收据 node.scripts。
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suiteRuntimeIndex } from './serve.mjs';
import { SKILLS_ROOT } from './env.mjs';

let registered = false;
let index = null;
const idx = () => (index ??= suiteRuntimeIndex());
let byPath = null;   // 套件运行时的绝对路径 → { name, skill }
const suiteByPath = () => (byPath ??= new Map([...idx()].map(([name, r]) => [resolve(r.path), { name, skill: r.skill }])));
const films = new Set();          // importRuntime 给过的片子目录（绝对路径）
const seen = new Map();           // 本进程解析到的运行时：绝对路径 → { film|null, name, from }
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function note(url) {
  if (!url?.startsWith('file:')) return;
  let p; try { p = resolve(fileURLToPath(url)); } catch { return; }
  if (seen.has(p)) return;
  const s = suiteByPath().get(p);
  if (s) { seen.set(p, { film: null, name: s.name, from: s.skill }); return; }
  for (const f of films) {
    const rt = join(f, 'runtime') + sep;
    if (p.startsWith(rt)) { seen.set(p, { film: f, name: p.slice(rt.length).split(sep).join('/'), from: 'film' }); return; }
  }
}

/** Node 侧加载记录的位置（deliver 读） */
export const nodeRuntimeRecordPath = (filmDir) => join(filmDir, 'out', '.render', 'runtime-node.json');
/** { schema, at, files: { 名字: { from, sha256 } }, scripts: { 可移植路径: { sha256, at } } }；没有返回 null */
export function readNodeRuntimeRecord(filmDir) {
  try { return JSON.parse(readFileSync(nodeRuntimeRecordPath(filmDir), 'utf8')); } catch { return null; }
}

function writeNodeRecord(filmDir) {
  const p = nodeRuntimeRecordPath(filmDir);
  const was = readNodeRuntimeRecord(filmDir) ?? {};
  const files = { ...(was.files ?? {}) }, scripts = { ...(was.scripts ?? {}) };
  for (const [path, r] of seen) if (r.film === null || r.film === filmDir) files[r.name] = { from: r.from, sha256: sha256(path) };
  const main = process.argv[1] ? resolve(process.argv[1]) : null;
  if (main && existsSync(main)) {
    const rel = relative(SKILLS_ROOT, main);
    if (rel && !rel.startsWith('..')) scripts[`{skills}/${rel.split(sep).join('/')}`] = { sha256: sha256(main), at: new Date().toISOString() };
  }
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  try {
    mkdirSync(join(filmDir, 'out', '.render'), { recursive: true });
    writeFileSync(p, JSON.stringify({ schema: 1, at: new Date().toISOString(), files: sort(files), scripts: sort(scripts) }, null, 1) + '\n');
  } catch { /* 写不了不影响导入；deliver 读不到就只冻结浏览器加载的那些 */ }
}

export function registerRuntimeResolver() {
  if (registered) return;
  if (typeof registerHooks !== 'function') {
    throw new Error(`Node ${process.versions.node} 没有 module.registerHooks：在 Node 里 import 运行时需要 Node ≥ 22.15`);
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let r;
      try {
        r = nextResolve(specifier, context);
      } catch (e) {
        const rel = specifier.startsWith('./') || specifier.startsWith('../');
        const hit = rel && e?.code === 'ERR_MODULE_NOT_FOUND' && idx().get(basename(specifier));
        if (!hit) throw e;
        r = { url: pathToFileURL(hit.path).href, shortCircuit: true };
      }
      if (films.size) note(r.url);
      return r;
    },
  });
  registered = true;
}

/**
 * 按扁平名字 import 一个运行时文件，与 serve 挂载表同语义：
 *   给了 film（片子目录，或 resolveFilm() 的返回）且 <片子>/runtime/<name> 存在 → 取片内那份（冻结副本 / 片子自写）；
 *   否则取套件那份；套件里也没有 → 抛错（提供它的 skill 没装）。
 * 片内那份里的相对 import（./motion.js）先按文件路径找片内 runtime/，找不到再由解析钩子改指套件——和浏览器里一致。
 */
export async function importRuntime(name, { film = null } = {}) {
  registerRuntimeResolver();
  const filmDir = typeof film === 'string' ? resolve(film) : film?.dir ? resolve(film.dir) : null;
  if (filmDir) films.add(filmDir);
  let url = null;
  if (filmDir) {
    const own = join(filmDir, 'runtime', name);
    if (existsSync(own)) url = pathToFileURL(own).href;
  }
  if (!url) {
    const hit = idx().get(name);
    if (!hit) throw new Error(`${filmDir ? `片内 runtime/ 和` : ''}套件运行时里都没有 ${name}：提供它的 skill 没装（运行时索引见 serve.mjs suiteRuntimeIndex）`);
    url = pathToFileURL(hit.path).href;
  }
  if (filmDir) note(url);   // 已在模块缓存里的不会再走解析钩子：入口自己先记
  const mod = await import(url);
  if (filmDir) writeNodeRecord(filmDir);
  return mod;
}
