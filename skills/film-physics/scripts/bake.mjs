#!/usr/bin/env node
// 策略 3 的烘焙工具：在 Node 里跑定步仿真，把每帧每个体的字段写成 Float32 表。
//
// 用法:
//   node bake.mjs --sim balls --opts '{"n":300}' --fps 60 --duration 10 --out films/<slug>/assets/balls
//   node bake.mjs --module ./my-sim.js --export mySim ...     # 自定义仿真（同样返回 {init,step,clone,pack}）
// 产出 <out>.json（头）+ <out>.bin（数据），scene 里 loadBake('<out 的 URL>') 查表。
// 失败一律 exit 1 + stderr 说明。
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReplay } from '../assets/runtime/replay.js';
import { cli } from '../../film-core/lib/cli.mjs';
import { registerRuntimeResolver } from '../../film-core/lib/runtime-node.mjs';

cli({
  usage: 'node bake.mjs (--sim <name> | --module <path> --export <name>) --duration <s> --out <路径前缀> [--opts JSON] [--fps 60] [--substeps 4]',
  about: '策略 3 烘焙：Node 里跑定步仿真，每帧每体字段写成 Float32 表，产出 <out>.json（头）+ <out>.bin（数据）。失败 exit 1。',
  opts: {
    sim: ['<balls|cloth|boids|fluid>', 'assets/runtime/sims.js 里的仿真'], module: ['<path>', '自定义仿真模块（返回 {init,step,clone,pack}）'],
    export: ['<name>', '自定义模块里的导出名（默认 = --sim）'], opts: ['<JSON>', '传给仿真工厂的选项（可含 fields）'],
    fps: ['<N>', '帧率（默认 60）'], substeps: ['<N>', '每帧子步（默认 4）'], duration: ['<s>', '片长秒（必填）'],
    out: ['<路径前缀>', '输出前缀，不带扩展名（必填，相对 cwd）'],
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const die = (m) => { console.error('bake: ' + m); process.exit(1); };

const simName = flag('sim', null), modPath = flag('module', null), exportName = flag('export', simName);
const fps = Number(flag('fps', 60)), substeps = Number(flag('substeps', 4)), duration = Number(flag('duration', NaN));
const out = flag('out', null);
let opts;
try { opts = JSON.parse(flag('opts', '{}')); } catch (e) { die('--opts 不是合法 JSON: ' + e.message); }
if (!simName && !modPath) die('需要 --sim <balls|cloth|boids|fluid> 或 --module <path> --export <name>');
if (!Number.isFinite(duration) || duration <= 0) die('需要 --duration <秒>');
if (!out) die('需要 --out <路径前缀>（不带扩展名）');

// sims.js / chain.js / closed.js 里的 import './rand.js' 在 film-core：装挂载表同语义的解析钩子（自定义模块 import './runtime/x.js' 也走它）
registerRuntimeResolver();
const mod = modPath ? await import(pathToFileURL(resolve(modPath)).href) : await import(pathToFileURL(resolve(HERE, '../assets/runtime/sims.js')).href);
const factory = mod[exportName];
if (typeof factory !== 'function') die(`模块里没有导出 ${exportName}`);
const sim = factory({ fps, substeps, ...opts });
if (!sim.pack) die('仿真体缺少 pack(state) -> [Float64Array...]，不知道导出哪些字段');

const R = createReplay({ fps, substeps, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1e9 });
const frames = Math.round(duration * fps) + 1;
const probe = sim.pack(R.stateAt(0));
const fields = (opts.fields ?? ['x', 'y', 'f2', 'f3', 'f4'].slice(0, probe.length));
const n = probe[0].length;
const data = new Float32Array(frames * fields.length * n);
const t0 = process.hrtime.bigint();
for (let f = 0; f < frames; f++) {
  const cols = sim.pack(R.stateAt(f / fps));
  for (let k = 0; k < fields.length; k++) data.set(cols[k], (f * fields.length + k) * n);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
mkdirSync(dirname(resolve(out)), { recursive: true });
const head = { version: 1, sim: exportName, opts, fps, substeps, frames, n, fields, dtype: 'float32', layout: 'frame-major' };
writeFileSync(out + '.json', JSON.stringify(head, null, 1));
writeFileSync(out + '.bin', Buffer.from(data.buffer));
const bytes = statSync(out + '.bin').size;
console.log(`baked ${exportName}: n=${n} frames=${frames} (${duration}s@${fps}) fields=${fields.join(',')}  ${ms.toFixed(0)} ms  ${(bytes / 1024).toFixed(0)} KiB -> ${out}.bin`);
