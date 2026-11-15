#!/usr/bin/env node
// 选型用的规模化计时（Node，纯仿真不含绘制）。回答"我这个规模用策略 2 冷启动 seek 要多久、烘焙文件多大"。
//   node bench.mjs [--sim balls] [--n 300,1000,3000] [--duration 10,60] [--fps 60 --substeps 4]
// 输出每个 (n, 片长)：每步 ms、冷启动 seek 到片尾 ms（= 从 0 重放）、检查点间隔 1s 时最坏乱序 seek ms、
// 烘焙 x,y Float32 文件大小、每个检查点占多少内存（clone 出来的 state 里所有 TypedArray 的字节数）。
// 开发基准（不随 skill 安装）：node dev/film-physics/bench.mjs
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { importRuntime } from '../../skills/film-core/lib/runtime-node.mjs';
cli({
  usage: 'node bench.mjs [--sim balls] [--n 300,1000,3000] [--duration 10,60] [--fps 60] [--substeps 4]',
  about: '选型用的规模化计时（Node，纯仿真不含绘制）：每步 ms、冷启动 seek、最坏乱序 seek、烘焙文件大小、检查点内存。',
  opts: {
    sim: ['<name>', 'film-physics 运行时 sims.js 里的仿真（默认 balls）'], n: ['<N,N,...>', '体数（逗号分隔，默认 300,1000,3000）'],
    duration: ['<s,s,...>', '片长秒（逗号分隔，默认 10,60）'], fps: ['<N>', '帧率（默认 60）'], substeps: ['<N>', '每帧子步（默认 4）'],
  },
});
const { createReplay } = await importRuntime('replay.js');
const sims = await importRuntime('sims.js');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const simName = flag('sim', 'balls'), fps = Number(flag('fps', 60)), sub = Number(flag('substeps', 4));
const ns = flag('n', '300,1000,3000').split(',').map(Number), durs = flag('duration', '10,60').split(',').map(Number);
if (!sims[simName]) { console.error('未知 sim ' + simName); process.exit(2); }
console.log(`sim=${simName} fps=${fps} substeps=${sub}`);
console.log('n\t片长s\tms/步\t冷启动seek片尾ms\t最坏乱序seek ms(检查点1s)\t烘焙x,y大小\t检查点KiB/个\t检查点总计(片长/1s)');
const bytesOf = (s) => Object.values(s).reduce((a, v) => a + (ArrayBuffer.isView(v) ? v.byteLength : typeof v === 'number' ? 8 : 0), 0);
for (const n of ns) {
  const opts = simName === 'cloth' ? { cols: Math.round(Math.sqrt(n * 1.5)), rows: Math.round(Math.sqrt(n / 1.5)) }
    : simName === 'chain' ? { n, perturb: [{ unit: 0, t: 0.5, dur: 1.2, decel: 2 }] } : { n };
  // 每步耗时：跑 2 秒取平均
  const sim = sims[simName]({ fps, substeps: sub, ...opts });
  const R = createReplay({ fps, substeps: sub, init: sim.init, step: sim.step, clone: sim.clone });
  let t0 = process.hrtime.bigint(); R.stateAt(2); const per = Number(process.hrtime.bigint() - t0) / 1e6 / (2 * fps * sub);
  const cpKiB = bytesOf(sim.clone(R.stateAt(2))) / 1024;
  for (const D of durs) {
    const cold = per * D * fps * sub;
    const worst = per * fps * sub; // 检查点 1s：最多重放 1 秒
    const bytes = (D * fps + 1) * 2 * (sim.n ?? n) * 4;
    console.log(`${sim.n ?? n}\t${D}\t${per.toFixed(4)}\t${cold.toFixed(0)}\t${worst.toFixed(1)}\t${(bytes / 1048576).toFixed(1)} MiB\t${cpKiB.toFixed(1)}\t${(cpKiB * (D + 1) / 1024).toFixed(2)} MiB`);
  }
}
