// 浏览器内重放 vs Node 烘焙（float32 舍入后逐位比）。运行：node tests/fixtures/_test-physics/node-vs-browser.mjs（任意 cwd）
import { dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../../skills/film-core/lib/browser.mjs';
const S = await serve(dirname(fileURLToPath(import.meta.url)), { record: false });
const b = await launchBrowser(); const pg = await b.newPage();
await pg.goto(`${S.url}/replay-balls.html`);
const res = await pg.evaluate(async () => {
  const { createReplay } = await import('./runtime/replay.js'); const { balls } = await import('./runtime/sims.js'); const { makeTrack } = await import('./runtime/baked.js');
  const head = await (await fetch('./assets/balls.json')).json(); const data = new Float32Array(await (await fetch('./assets/balls.bin')).arrayBuffer());
  const tr = makeTrack(head, data);
  const sim = balls({ fps: 60, substeps: 4, ...head.opts }); const R = createReplay({ fps: 60, substeps: 4, init: sim.init, step: sim.step, clone: sim.clone });
  let mism = 0, frames = 0;
  for (let f = 0; f <= 360; f++) { const s = R.stateAt(f / 60), k = tr.frame(f / 60); frames++;
    for (let i = 0; i < head.n; i++) if (Math.fround(s.x[i]) !== k.x[i] || Math.fround(s.y[i]) !== k.y[i]) { mism++; break; } }
  return { frames, mism };
});
console.log('浏览器内重放 vs Node 烘焙（float32 舍入后逐位比）:', JSON.stringify(res));
await b.close(); await S.close();
