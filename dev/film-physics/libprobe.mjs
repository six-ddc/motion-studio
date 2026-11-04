#!/usr/bin/env node
// 第三方物理库的"定步确定性"实测（Node，同进程）。每个库跑同一个场景：
// 80 个盒子落进一个碗，dt=1/240，600 步。三问：
//   Q1 两次全新 world 跑同样步数，所有体位置逐位相同吗？（策略 2 "从头重放" 的前提）
//   Q2 乱序：先跑 600 步的 world 和只跑 300 步的 world，在 300 步处一致吗？（就是 Q1 的前缀，顺带测）
//   Q3 检查点：第 300 步存快照 → 恢复 → 再跑 300 步，与连续跑 600 步逐位相同吗？（策略 2 检查点的前提）
// 未安装的库报 SKIP。用法: node libprobe.mjs [--steps 600]
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { importPkg } from '../../skills/film-core/lib/env.mjs';

cli({
  usage: 'node libprobe.mjs [--steps 600]',
  about: '第三方物理库（matter-js / planck / rapier2d-compat）定步确定性实测：两次重放一致、前缀一致、快照恢复一致。未安装的库报 SKIP。',
  opts: { steps: ['<N>', '每次跑多少步（默认 600，dt=1/240）'] },
});
const argv = process.argv.slice(2);
const STEPS = Number(argv[argv.indexOf('--steps') + 1] || 600) || 600;
const DT = 1 / 240;
const N = 80;
// 体的初始位置用固定公式，不用随机
const spawn = (i) => ({ x: (i % 10) * 0.55 - 2.5 + (i % 3) * 0.01, y: 2 + Math.floor(i / 10) * 0.6 });
const bits = (arr) => { const f = new Float64Array(arr); return Buffer.from(f.buffer).toString('base64'); };
const report = [];
const out = (lib, q, ok, note = '') => { report.push({ lib, q, ok }); console.log(`  ${ok === null ? '–' : ok ? '✓' : '✗'} ${lib.padEnd(10)} ${q}  ${note}`); };

// 先按 cwd 往上、再按脚本位置解析（film-core lib/env.mjs）
async function tryImport(name) { try { return await importPkg(name); } catch { return null; } }

// ---------------- matter-js ----------------
{
  const M = await tryImport('matter-js');
  if (!M) out('matter', 'all', null, 'SKIP 未安装');
  else {
    const Matter = M.default ?? M;
    const build = () => {
      const engine = Matter.Engine.create();
      const ground = [Matter.Bodies.rectangle(0, 300, 800, 40, { isStatic: true }), Matter.Bodies.rectangle(-300, 0, 40, 800, { isStatic: true, angle: 0.3 }), Matter.Bodies.rectangle(300, 0, 40, 800, { isStatic: true, angle: -0.3 })];
      const boxes = Array.from({ length: N }, (_, i) => { const p = spawn(i); return Matter.Bodies.rectangle(p.x * 60, -p.y * 60, 24, 24); });
      Matter.Composite.add(engine.world, [...ground, ...boxes]);
      return { engine, boxes };
    };
    const run = (n) => { const w = build(); for (let k = 0; k < n; k++) Matter.Engine.update(w.engine, DT * 1000); return w; };
    const pos = (w) => bits(w.boxes.flatMap((b) => [b.position.x, b.position.y, b.angle]));
    const a = pos(run(STEPS)), b = pos(run(STEPS));
    out('matter', 'Q1 两次全新重放一致', a === b);
    const h1 = pos(run(STEPS / 2)), h2 = pos(run(STEPS / 2));
    out('matter', 'Q2 前缀一致', h1 === h2);
    out('matter', 'Q3 快照/恢复', null, '无官方快照 API（Engine 内部有 pairs/contact 缓存、sleeping 计时，手工 clone 不完整）→ 只能从头重放或烘焙');
    const t0 = process.hrtime.bigint(); run(STEPS); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`             ${N} 体 × ${STEPS} 步 = ${ms.toFixed(0)} ms（${(ms / STEPS).toFixed(3)} ms/步）`);
  }
}

// ---------------- planck ----------------
{
  const P = await tryImport('planck');
  if (!P) out('planck', 'all', null, 'SKIP 未安装');
  else {
    const pl = P.default ?? P;
    const build = () => {
      const world = new pl.World({ gravity: new pl.Vec2(0, -10) });
      const g = world.createBody();
      g.createFixture(new pl.Edge(new pl.Vec2(-6, 0), new pl.Vec2(6, 0)));
      g.createFixture(new pl.Edge(new pl.Vec2(-6, 0), new pl.Vec2(-8, 8)));
      g.createFixture(new pl.Edge(new pl.Vec2(6, 0), new pl.Vec2(8, 8)));
      const boxes = Array.from({ length: N }, (_, i) => { const p = spawn(i); const b = world.createDynamicBody(new pl.Vec2(p.x, p.y)); b.createFixture(new pl.Box(0.2, 0.2), { density: 1, friction: 0.4 }); return b; });
      return { world, boxes };
    };
    const run = (n, w = build()) => { for (let k = 0; k < n; k++) w.world.step(DT, 8, 3); return w; };
    const pos = (w) => bits(w.boxes.flatMap((b) => [b.getPosition().x, b.getPosition().y, b.getAngle()]));
    const a = pos(run(STEPS)), b = pos(run(STEPS));
    out('planck', 'Q1 两次全新重放一致', a === b);
    // Q3：planck 有 Serializer（toJson/fromJson），但不序列化接触缓存（warm starting），实测是否逐位相等
    if (pl.Serializer) {
      const w = run(STEPS / 2);
      let ok = false, note = '';
      try {
        const json = pl.Serializer.toJson(w.world);
        const world2 = pl.Serializer.fromJson(json);
        const bodies = []; for (let bd = world2.getBodyList(); bd; bd = bd.getNext()) if (bd.isDynamic()) bodies.push(bd);
        bodies.reverse(); // body list 是头插
        for (let k = 0; k < STEPS / 2; k++) world2.step(DT, 8, 3);
        const restored = bits(bodies.flatMap((bd) => [bd.getPosition().x, bd.getPosition().y, bd.getAngle()]));
        ok = restored === a;
        if (!ok) {
          const fa = new Float64Array(Buffer.from(a, 'base64').buffer.slice(0)), fr = new Float64Array(Buffer.from(restored, 'base64').buffer.slice(0));
          let mx = 0; for (let i = 0; i < fa.length; i++) mx = Math.max(mx, Math.abs(fa[i] - fr[i]));
          note = `最大位置偏差 ${mx.toExponential(2)} m（序列化丢接触缓存/warm-start）`;
        }
      } catch (e) { note = 'Serializer 报错: ' + e.message; }
      out('planck', 'Q3 Serializer 存档→恢复→续跑 = 连续跑', ok, note);
    } else out('planck', 'Q3', null, '无 Serializer');
    const t0 = process.hrtime.bigint(); run(STEPS); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`             ${N} 体 × ${STEPS} 步 = ${ms.toFixed(0)} ms（${(ms / STEPS).toFixed(3)} ms/步）`);
  }
}

// ---------------- rapier2d (wasm) ----------------
{
  const R0 = await tryImport('@dimforge/rapier2d-compat');
  if (!R0) out('rapier2d', 'all', null, 'SKIP 未安装');
  else {
    const R = R0.default ?? R0;
    await R.init();
    const build = () => {
      const world = new R.World({ x: 0, y: -10 }); world.timestep = DT;
      world.createCollider(R.ColliderDesc.polyline(new Float32Array([-8, 8, -6, 0, 6, 0, 8, 8])));
      const boxes = Array.from({ length: N }, (_, i) => { const p = spawn(i); const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y)); world.createCollider(R.ColliderDesc.cuboid(0.2, 0.2), b); return b; });
      return { world, boxes };
    };
    const pos = (boxes) => bits(boxes.flatMap((b) => [b.translation().x, b.translation().y, b.rotation()]));
    const run = (n) => { const w = build(); for (let k = 0; k < n; k++) w.world.step(); return w; };
    const w1 = run(STEPS), w2 = run(STEPS);
    const a = pos(w1.boxes);
    out('rapier2d', 'Q1 两次全新重放一致', a === pos(w2.boxes));
    w1.world.free(); w2.world.free();
    const w = run(STEPS / 2);
    const snap = w.world.takeSnapshot();
    const handles = w.boxes.map((b) => b.handle);
    w.world.free();
    const w3 = R.World.restoreSnapshot(snap);
    for (let k = 0; k < STEPS / 2; k++) w3.step();
    const b3 = handles.map((h) => w3.getRigidBody(h));
    out('rapier2d', 'Q3 takeSnapshot→restore→续跑 = 连续跑', pos(b3) === a, `快照 ${(snap.length / 1024).toFixed(0)} KiB`);
    w3.free();
    const t0 = process.hrtime.bigint(); const wt = run(STEPS); const ms = Number(process.hrtime.bigint() - t0) / 1e6; wt.world.free();
    console.log(`             ${N} 体 × ${STEPS} 步 = ${ms.toFixed(0)} ms（${(ms / STEPS).toFixed(3)} ms/步）`);
  }
}
const failed = report.filter((r) => r.ok === false && r.q.startsWith('Q1'));
process.exit(failed.length ? 1 : 0);
