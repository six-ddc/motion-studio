---
name: film-physics
description: 在 seek(t) 纯函数视频管线里实现可任意跳帧的物理与打击感：粒子系统（发射、场力、爆发）、重力弹道与弹跳、刚体碰撞与约束、布料绳索（Verlet）、群集（boids）、流体近似、摆与轨道、一维跟随链（跟车/幽灵堵车/排队），以及事件表驱动的多通道冲击与游戏手感（屏震、顿帧 hitstop、闪白、压扁、拖尾、后坐）。给出闭式解 / 定步重放+检查点 / 预烘焙三条策略的选型与取舍、matter.js/planck.js/rapier 改造与时间映射（快进/慢镜/定格）。片子出现掉落、弹跳、碰撞、爆炸、飘散、成群、流动、晃屏、堵车链或引入物理引擎时加载。
---

# film-physics

把迭代物理变成外部无状态的 `seek(t)` 函数：本 skill 算**位置、速度与事件时刻**（像素着色归 `film-webfx`，事件表 `events.js` 归 `film-core`），只给策略、代价与封装底座，具体算法与库由你按本片自由写。

## 四条硬约束

1. **关掉物理库自带循环**：禁掉 matter `Runner.run`、planck testbed、rapier rAF、cannon `fixedStep()`，改手动 `step(固定 dt)`。
2. **步数由整数帧号算**：`n = Math.round(t * fps) * substeps`（`Math.floor(t / dt)` 在浮点边界如 `0.3` 会少一步致乱序不一致）。
3. **随机只用计数器哈希**：`hash01(seed, stepOrId, attr)`（`film-core/runtime/rand.js`）；顺序 `seeded()` 闭包在检查点回退时不会复位。
4. **缓存可存在但对外不可观测**：以 `seamcheck` + `physcheck` 全绿为准。

## 三条可 seek 策略与选型

| 维度 | ① 闭式解 `x(t)` | ② 定步重放 + 检查点（`replay.js`） | ③ 预烘焙查表（`bake.mjs` + `baked.js`） |
|---|---|---|---|
| 适用 | 粒子发射/爆发、弹道弹跳、弹簧、小角摆、轨道、屏震/顿帧/闪白 | **任何体间相互作用**：刚体碰撞、布料、boids、流体、第三方引擎 | 同 ②，用于大规模/长片/反复重渲 |
| 单帧代价（实测） | 2000 粒子 0.5ms / 20000 粒子 4.4ms | 300 球顺序 0.11ms；冷启动 O(t)（10s 约 80ms） | 300 球 0.04ms（Float32 表 1.4 MiB） |
| 循环 / 调参 | 循环免费、改参即生效 | 混沌难循环、改参即生效 | 改参需重烘 |

**选型顺序**：无体间相互作用一律选 ① → 需要相互作用先搭 ② 并用 `physcheck` 看耗时 → 乱序/冷启动太慢再转 ③（可混用：主体走 ②/③，尘埃与屏震走 ①）。详阅 `references/strategies.md`。

## 可选底座（按需 import，在线挂载）

- **定步重放 `assets/runtime/replay.js`**：
  ```js
  import { createReplay } from './runtime/replay.js';
  const R = createReplay({ fps: 60, substeps: 4, init, step, clone, checkpointEvery: 1 });
  window.seek = (t) => draw(R.stateAt(t)); // 只读，勿修改返回值
  ```
  `init/step/clone` 守五条：全部可变状态和一次性开关进 `state` 并深拷贝；随机用 `hash01(seed, stepIndex, k)`；勿改返回值；草稿缓冲每步开头重写。同文件提供 `eventRing` 让碰撞事件随检查点回退。
- **时间映射 `assets/runtime/timemap.js`**：影片时间≠仿真时间（快进/慢放/定格）时写 `R.stateAt(S(t))`，`S = timeMap(keys)` 带闭式积分与反函数 `S.inv`（`fitRate` 反解倍率对准旁白锚点）。反传或漏传映射会让 `seamcheck` 假绿，需用 `physcheck` E 组查（见 `references/timemap.md`）。
- **预烘焙 `scripts/bake.mjs` + `assets/runtime/baked.js`**：
  ```bash
  node <film-physics>/scripts/bake.mjs --module films/<slug>/sim.js --export mySim --opts '{"n":300}' --fps 60 --duration 6 --out films/<slug>/assets/balls
  ```
  场景用 `loadBake('./assets/balls')` 读取零拷贝 `track.frame(t)` 或插值 `track.lerp(t)`，与 ② 共用同一份 `sim.js`。

## 效果与多通道冲击索引

- **粒子/弹跳/刚体/布料/boids/流体**：原理、难点与代价见 `references/effects.md`；第三方引擎（matter/planck/rapier，仅 rapier 支持真检查点）见 `references/libraries.md`；跟车/幽灵堵车无量纲判据见 `references/chain.md`。
- **多通道冲击**：一次命中/爆发由同一张 `film-core/runtime/events.js` 事件表同时驱动光、闪白、屏震、压扁、粒子与声音 cue；顿帧下“影片时间 vs 世界时间”拆分见 `references/events.md`。

## 验收（加载 `replay.js`/`baked.js` 时由 `gates.json` 自动开启）

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> [--loop]
node <film-physics>/scripts/physcheck.mjs --film <slug> --t0 0 --t1 3 --step 0.1
```

声明 `window.PHYS`（`PHYS.timeMap` / `PHYS.claims`）可额外校验时间映射正确性与仿真不变量。局限：大规模体间碰撞 + 长片 + 频繁调参无完美解（未做分段烘焙）；跨机器确定性未测。
