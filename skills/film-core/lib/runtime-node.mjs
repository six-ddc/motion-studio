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
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { suiteRuntimeIndex } from './serve.mjs';

let registered = false;
let index = null;
const idx = () => (index ??= suiteRuntimeIndex());

export function registerRuntimeResolver() {
  if (registered) return;
  if (typeof registerHooks !== 'function') {
    throw new Error(`Node ${process.versions.node} 没有 module.registerHooks：在 Node 里 import 运行时需要 Node ≥ 22.15`);
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (e) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        const hit = relative && e?.code === 'ERR_MODULE_NOT_FOUND' && idx().get(basename(specifier));
        if (!hit) throw e;
        return { url: pathToFileURL(hit.path).href, shortCircuit: true };
      }
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
  const filmDir = typeof film === 'string' ? film : film?.dir ?? null;
  if (filmDir) {
    const own = join(filmDir, 'runtime', name);
    if (existsSync(own)) return import(pathToFileURL(own).href);
  }
  const hit = idx().get(name);
  if (!hit) throw new Error(`${filmDir ? `片内 runtime/ 和` : ''}套件运行时里都没有 ${name}：提供它的 skill 没装（运行时索引见 serve.mjs suiteRuntimeIndex）`);
  return import(pathToFileURL(hit.path).href);
}
