// film-critique 各脚本共用的薄适配层：找片、打开场景、读本片法律。
//
// 找片和"打开场景、按 t 截帧"直接用 film-core 的实现，不在这里抄第二份：截帧规则（WAAPI 场景要冻 playbackRate，
// 否则 animations:'disabled' 会把动画 finish() 成终态、每帧一样且不报错）只能有一处真相，
// 否则静帧闸门看到的帧会和成片静默地不一致。
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveFilm as coreResolve, parseArgs, readArgs, readChecks, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene as coreOpen, FORMATS } from '../../film-core/lib/browser.mjs';

/** args(spec)：按参数表校验（--help / 未知参数，见 film-core lib/cli.mjs）后返回取值器。spec.opts 里并上 FILM_OPTS。 */
export const args = parseArgs;
export { FILM_OPTS };
export const die = (msg, code = 2) => fail(msg, code);

export function resolveFilm(slug) {
  let f;
  try { f = coreResolve(slug, readArgs()); } catch (e) { die(e.message); }
  const format = f.config.format;
  const read = (rel) => (existsSync(join(f.dir, rel)) ? readFileSync(join(f.dir, rel), 'utf8') : null);
  let checks;
  try { checks = readChecks(f.dir); } catch (e) { die(`${join(f.dir, 'film.json')}：${e.message}`); }
  return {
    ...f, format, ...FORMATS[format],
    fps: f.config.fps, entry: f.config.entry,
    docs: join(f.dir, 'docs'),
    checks,                          // film.json checks → Map<id, true | 参数对象>（film-core parseChecks）
    readText: read,
    readJSON: (rel) => { const s = read(rel); return s == null ? null : JSON.parse(s); },
  };
}

/**
 * 打开场景，返回 { page, browser, shot(t), duration, usesWaapi, errors, close }。
 * initScript(s)：交给 film-core openScene 的 initScripts，在场景任何脚本之前执行，
 * 所以场景加载期缓存的 ctx.fillText 引用也是被探针包过的。
 * browser / port：check.mjs 的并行池（_pool.mjs）让多个页面共用几个浏览器和一个服务器；不给 = 自己开。
 */
export async function openScene(F, { initScript, initScripts, browser, port } = {}) {
  let S;
  try { S = await coreOpen(F, F.format, { probe: false, initScripts: initScripts ?? (initScript ? [initScript] : []), browser, port }); } catch (e) { die(e.message, 1); }
  return {
    page: S.page, browser: S.context.browser(), shot: S.shot,
    duration: S.info.duration, usesWaapi: S.info.usesWaapi, errors: S.errors, close: S.close,
  };
}

/** style_guide.md 正文里的 ```critique 块：返回 { block: 对象 } / { missing } / { noBlock } / { error }。不读文件、不退出。 */
export function parseCritiqueBlock(md) {
  if (!md) return { missing: true };
  const m = /```(?:json\s+)?critique\s*\n([\s\S]*?)```/.exec(md);
  if (!m) return { noBlock: true };
  try { return { block: JSON.parse(m[1]) }; } catch (e) { return { error: e.message }; }
}

/** 本片 style_guide.md 里的机器可读块：```critique ... ```（JSON）。 */
export function readLaws(F) {
  const r = parseCritiqueBlock(F.readText('docs/style_guide.md'));
  if (r.missing) return { _missing: true };
  if (r.noBlock) return { _noBlock: true };
  if (r.error) die(`style_guide.md 的 critique 块不是合法 JSON：${r.error}`);
  return r.block;
}
