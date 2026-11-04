#!/usr/bin/env node
// 把 three.js 的 npm 包改成"帧契约版"（three-film），拷进本 skill 的 assets/runtime/。
//
//   node dev/film-webfx/vendor-three.mjs --src <解开的 three 包目录> [--out <目录>]
//
// 为什么要改而不是原样拷：three 里有几处读墙钟 / 用 Math.random / 开 rAF 循环 / setTimeout 轮询。
// 不改的话，(1) skills/selfcheck.mjs 第 8 项会判运行时违约；(2) 更要紧的是，用错的那一刻没有任何提示——
// Clock.getDelta() 照常返回一个数，渲出来的片子每次不一样。改成"用到就抛错、错误信息说该用什么"，
// 违约从静默变成当场失败。
//
// 每一处补丁都按**精确文本 + 精确次数**匹配；上游改了代码、次数对不上就失败退出（exit 1），
// 不会悄悄产出一个半补丁版。升级 three 就是：换 --src 重跑，过了再跑 bench3d.mjs 和夹具的 seamcheck。
//
// 退出码：0 成功；1 补丁对不上 / 产物里还有禁用 API；2 用法错误
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../../skills/film-core/lib/cli.mjs';

cli({
  usage: 'node vendor-three.mjs --src <three 包目录> [--out <目录>]',
  about: '把 three.js 的 npm 包改成帧契约版（three-film）拷进本 skill 的 assets/runtime/。退出码 0 成功 / 1 补丁对不上或产物里还有禁用 API / 2 用法错',
  opts: {
    src: ['<dir>', '解开的 three 包目录（含 build/three.core.js、build/three.module.js、package.json、LICENSE）'],
    out: ['<dir>', '输出目录（默认 <film-webfx>/assets/runtime）'],
  },
});

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills/film-webfx');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const die = (m, code = 1) => { process.stderr.write(`vendor-three: ${m}\n`); process.exit(code); };

const src = flag('src');
if (!src) die('用法: vendor-three.mjs --src <three 包目录（含 build/three.core.js、package.json、LICENSE）> [--out 目录]', 2);
const out = resolve(flag('out', join(SKILL, 'assets', 'runtime')));
for (const f of ['build/three.core.js', 'build/three.module.js', 'package.json', 'LICENSE'])
  if (!existsSync(join(src, f))) die(`--src 里缺 ${f}`, 2);

const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf-8'));
const license = readFileSync(join(src, 'LICENSE'), 'utf-8').trim();
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---- 补丁表 ----------------------------------------------------------------
// [文件, 说明, 精确原文, 替换为, 期望次数]
const F = (what, instead) => `_filmForbidden( ${JSON.stringify(what)}, ${JSON.stringify(instead)} )`;
const CORE = [
  ['generateUUID 的 4 个 Math.random → 计数器 + 整数混洗（uuid 只当身份用，不进像素；加载期构造顺序固定 → 每次加载同一组 uuid）',
    /const (d[0-3]) = Math\.random\(\) \* 0xffffffff \| 0;/g, (_, d) => `const ${d} = _filmUUIDWord();`, 4],
  ['其余 Math.random（MathUtils.randInt/randFloat/randFloatSpread、Vector2/3/4.random、Quaternion.random、randomDirection）→ 抛错',
    /Math\.random\(\)/g, () => '_filmNoRandom()', 'any'],
  ['probeAsync 的 setTimeout 轮询（compileAsync / readRenderTargetPixelsAsync 用）→ 抛错',
    /setTimeout\( probe, interval \)/g, () => F('probeAsync（compileAsync / readRenderTargetPixelsAsync 的 setTimeout 轮询）', '预热用同步的 renderer.compile(scene, camera) 加一次 render；读回用同步的 readRenderTargetPixels'), 2],
  ['Loader 命中缓存时的 setTimeout(fn, 0) → 微任务（加载期的异步回调，语义不变）',
    /setTimeout\(/g, () => '_filmDefer(', 3],
  ['yieldToMain 的 requestAnimationFrame 兜底 → 微任务',
    /requestAnimationFrame\( resolve \)/g, () => '_filmDefer( resolve )', 1],
  ['Clock / Timer 的 performance.now → 抛错',
    /performance\.now\(\)/g, () => '_filmNoClock()', 5],
];
const MODULE = [
  ['WebGLAnimation 的 rAF（renderer.setAnimationLoop(fn) 走这里）→ 抛错',
    /context\.requestAnimationFrame\( onAnimationFrame \)/g, () => F('renderer.setAnimationLoop / rAF 循环', '渲染只在 seek(t) 里同步调一次 render'), 2],
  ['compileAsync 的 setTimeout 轮询 → 抛错',
    /setTimeout\( checkMaterialsReady, 10 \)/g, () => F('renderer.compileAsync（setTimeout 轮询）', '预热用同步的 renderer.compile(scene, camera)，放在 window.ready 里'), 2],
  ['import 路径 ./three.core.js → ./three-film.core.js',
    /'\.\/three\.core\.js'/g, () => "'./three-film.core.js'", 'any'],
];

const HELPERS_CORE = `
// ---- three-film 补丁的辅助函数（dev/film-webfx/vendor-three.mjs 注入）----
function _filmForbidden( what, instead ) {
	throw new Error( 'three-film: ' + what + ' 违反帧契约（seek(t) 必须是 t 的纯函数）。' + instead );
}
function _filmNoRandom() {
	return _filmForbidden( 'Math.random（MathUtils.randInt/randFloat/randFloatSpread、Vector*.random、Quaternion.random 等）', '随机数用 rand.js 的 seeded() / hash01()，在加载期取完' );
}
function _filmNoClock() {
	return _filmForbidden( 'Clock / Timer 读墙钟', '时间只从 seek(t) 的 t 来；AnimationMixer 用 mixer.setTime(t)（每次从 0 重放），不要 update(delta)' );
}
function _filmDefer( fn ) { Promise.resolve().then( fn ); }
let _filmUUIDn = 0;
function _filmUUIDWord() {
	let x = Math.imul( ++ _filmUUIDn, 0x9E3779B1 ) >>> 0;
	x ^= x >>> 16; x = Math.imul( x, 0x85EBCA6B ) >>> 0;
	x ^= x >>> 13; x = Math.imul( x, 0xC2B2AE35 ) >>> 0;
	x ^= x >>> 16;
	return x | 0;
}
`;
const HELPERS_MODULE = `
// ---- three-film 补丁的辅助函数（dev/film-webfx/vendor-three.mjs 注入）----
function _filmForbidden( what, instead ) {
	throw new Error( 'three-film: ' + what + ' 违反帧契约（seek(t) 必须是 t 的纯函数）。' + instead );
}
`;

function apply(text, table, file) {
  const log = [];
  for (const [what, re, rep, expect] of table) {
    let n = 0;
    text = text.replace(re, (...m) => { n++; return rep(...m); });
    if (expect === 'any' ? n < 1 : n !== expect) die(`${file}: 补丁「${what}」期望 ${expect} 处，实际 ${n} 处——上游代码变了，先读 diff 再改补丁表`);
    log.push(`${n}× ${what}`);
  }
  return { text, log };
}

// 与 skills/selfcheck.mjs 第 8 项同一种剥注释 + 同一组正则：产物必须过它
function residual(text) {
  const strip = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hits = [];
  for (const [re, w] of [[/\bMath\.random\s*\(/, 'Math.random'], [/\bDate\.now\s*\(/, 'Date.now'], [/\bperformance\.now\s*\(/, 'performance.now'],
    [/\bsetTimeout\s*\(/, 'setTimeout'], [/\bsetInterval\s*\(/, 'setInterval'], [/\brequestAnimationFrame\s*\(/, 'requestAnimationFrame'],
    [/from\s+['"]node:|require\(['"]node:|\bprocess\.(argv|exit|cwd)/, 'Node API']]) if (re.test(strip)) hits.push(w);
  return hits;
}

const coreSrc = readFileSync(join(src, 'build/three.core.js'), 'utf-8');
const modSrc = readFileSync(join(src, 'build/three.module.js'), 'utf-8');
const core = apply(coreSrc, CORE, 'three.core.js');
const mod = apply(modSrc, MODULE, 'three.module.js');

const header = (name, upstream, upstreamSha, log) => `/*
 * ${name} —— three.js ${pkg.version} 的帧契约版（film-webfx）。
 * 由 dev/film-webfx/vendor-three.mjs 从 npm 包 three@${pkg.version} 的 build/${upstream} 生成，不要手改：
 * 升级就换 --src 重跑脚本。上游文件 sha256 ${upstreamSha}
 *
 * 补丁（精确文本 + 精确次数匹配，对不上脚本直接失败）：
${log.map((l) => ` *   - ${l}`).join('\n')}
 *
 * 其余代码与上游逐字相同。用到被封掉的 API 会当场抛错，错误信息写着该用什么。
 *
 * ---- 上游许可证（MIT，随文件分发必须保留）----
${license.split('\n').map((l) => ` * ${l}`.trimEnd()).join('\n')}
 */
`;

// 辅助函数插在第一条 import / 正文之前（上游文件开头是 @license 注释块）
const inject = (text, helpers) => {
  const end = text.indexOf('*/');
  if (end < 0 || end > 400) die('上游文件开头不是预期的 @license 注释块');
  return text.slice(0, end + 2) + '\n' + helpers + text.slice(end + 2);
};
// three.module.js 的第一句是 import，辅助函数（函数声明）放在 import 之后也会被提升，放 license 块后即可
const coreOut = header('three-film.core.js', 'three.core.js', sha(coreSrc), core.log) + inject(core.text, HELPERS_CORE);
const modOut = header('three-film.module.js', 'three.module.js', sha(modSrc), mod.log) + inject(mod.text, HELPERS_MODULE);

for (const [n, t] of [['three-film.core.js', coreOut], ['three-film.module.js', modOut]]) {
  const r = residual(t);
  if (r.length) die(`${n} 打完补丁还剩禁用 API：${r.join('、')}`);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'three-film.core.js'), coreOut);
writeFileSync(join(out, 'three-film.module.js'), modOut);
console.log(`three ${pkg.version} → ${out}`);
for (const l of core.log) console.log(`  core   ${l}`);
for (const l of mod.log) console.log(`  module ${l}`);
console.log(`  three-film.core.js ${(coreOut.length / 1024).toFixed(0)} KB, three-film.module.js ${(modOut.length / 1024).toFixed(0)} KB`);
