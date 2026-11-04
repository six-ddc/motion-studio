---
name: film-physics
description: 在 seek(t) 纯函数视频管线里做可任意跳帧的物理运动：粒子系统（发射、场力、生命周期、爆发）、重力弹道与落地弹跳、刚体碰撞与约束、布料绳索（Verlet）、群集（boids）、流体近似、摆与轨道、一维跟随链（跟车、幽灵堵车、红绿灯起步、排队挪动），以及游戏化反馈（屏震、顿帧 hitstop、闪白、压扁、拖尾）。给出闭式解 / 定步重放+检查点 / 预烘焙三条可 seek 化策略的选型判据与实测代价，matter.js / planck.js / rapier 的定步改造，以及影片时间到仿真时间的映射（快进、慢镜头、定格）。片子里有东西"掉下来、弹起来、撞上、炸开、飘散、成群、流动、晃屏"，要做堵车、排队、链式传播，要引入物理引擎或写"从上一帧推下一帧"的循环、让仿真快进慢放时使用，哪怕用户只说"加点粒子""做个物理效果"。
---

# film-physics

物理天生是迭代的：下一帧 = f(上一帧)。而管线要求 `seek(t)` 是 t 的纯函数，乱序求值必须和顺序求值逐像素一致（`../film-core/references/kernel.md` §2）。本 skill **把有状态的仿真包装成从外部观察无状态的函数**，并给出每种包装方式的代价。

本 skill 负责算**位置**（以及速度、事件时刻）。把点画成像素（辉光、着色器、混合、后期）见 film-webfx；GPU 粒子如果主要工作是着色就归 webfx，主要是运动积分就归这里。
`seek(t)` 契约、`settle()`、`seeded()`/`hash01()`、`place()`/`size()`、seamcheck、渲染和交付见 film-core。画什么、什么时候炸开，由 film-story 和本片 `docs/style_guide.md` 决定。

## 硬约束（技术不变量）

1. **物理库自带的循环要关掉**（kernel.md §2）：matter 的 `Runner.run`/`Render.run`、planck 的 `testbed`、rapier 的 rAF 包装、cannon 的 `fixedStep()` 都由 rAF 和墙钟驱动，seek 一跳就会出错。改成手动调用 `step(fixedDt)`，步数由 t 算出。
2. **步数由整数帧号算出**：`n = Math.round(t * fps) * substeps`（t 和 fps 都是**仿真**时间里的量，见下文"仿真时间与影片时间不同"）。用 `Math.floor(t / dt)` 时，t=0.3 这类值会因浮点误差少算一步，乱序时偶尔出现不一致。
3. **随机数用计数器式 hash**：`hash01(seed, i, k)`（film-core `runtime/rand.js`，参数个数可变；本 skill 统一按 `(种子, 体号或步号, 属性号)` 传）。闭包里按顺序调用的 `seeded()` 在恢复检查点时不会跟着回退（physcheck 阴性对照 `replay-leak-rng`）。
4. **可以用缓存，不能留状态**：判据是 `physcheck` 和 `seamcheck` 能不能通过，而不是代码里有没有可变变量。

## 三条策略

| | ① 闭式解 | ② 定步重放 + 缓存 | ③ 预烘焙查表 |
|---|---|---|---|
| 原理 | 直接对解析式 `x(t)` 求值 | 从 t=0 开始以固定 dt 推进；单调缓存，每秒存一个检查点 | 离线跑一次，把每帧每个物体的数据写成 Float32 表 |
| 能做 | 弹道、阻力、落地或撞墙弹跳、弹簧、摆、轨道、发射器、屏震、顿帧、闪白 | 全部都能：体间碰撞、约束、布料、boids、流体、第三方引擎 | 与 ② 相同（把 ② 的结果存盘） |
| 做不到 | **物体之间的相互作用**（碰撞、群集、约束都是全局耦合） | 没有物理上的限制，只受时间预算限制 | 改参数要重新烘焙 |
| seek 单帧（实测） | 2000 粒子 0.5 ms；20000 粒子 4.4 ms | 顺序 0.11 ms/帧（300 球）；乱序最坏要重放不超过 1 秒 | 300 球 0.04 ms/帧 |
| 冷启动 seek 到片尾 | 同上（与 t 无关） | O(t)：300 球 10s 约 80 ms，60s 约 480 ms | 读一次文件 |
| 循环（首帧与末帧相同） | **免费**：`emitter({loop})` 配合 `wrap(t)` | 混沌系统一般做不到 | 同 ② |
| 磁盘 | 0 | 0 | 存 x,y 两个 Float32 字段：300 体 10s 为 1.4 MiB，1000 体 60s 为 27.5 MiB |
| 实现成本 | 低，但要会推公式 | 中：状态必须能完整 clone | 中：多一步烘焙，还要管理文件版本 |

公式、伪代码、文件格式见 `references/strategies.md`。

### 怎么选

1. **物体之间需要相互作用吗？** 不需要就用 ①。雪、雨、火花、抛物、落地弹跳、摆、轨道、命中反馈，绝大多数"粒子效果"都不需要体间碰撞；① 还顺带支持循环和预热。
2. 需要的话，再看**乱序 seek 的最坏耗时能不能接受**。先搭一个 ② 的原型，`physcheck` 的计时部分会直接给出顺序、乱序、冷启动各要多少 ms；也可以用 `ms/步 × fps × substeps × 检查点间隔` 估算最坏乱序 seek 的耗时（每步 ms 见下表）。能接受就用 ②，改参数立即生效。
3. 不能接受时（物体多、片子长、要反复重渲、要多机并行渲染）用 ③，把 O(t) 的开销挪到一次离线计算里。
4. 也可以混用：主体碰撞走 ② 或 ③，背景尘埃走 ①，屏震从 ② 或 ③ 记录下的碰撞事件推出（屏震本身是 ① 的函数）。

## 策略 ① 闭式解：`runtime/closed.js`

场景里直接 `import './runtime/closed.js'`（服务器从已安装的 skill 挂载，deliver 时冻结进片子），它只依赖 `rand.js`。完整可运行的版本（含绘制和 layout 换算）在测试夹具 `tests/fixtures/_test-physics/shared.js`。

```js
import { emitter, ballistic, bounce, wobble, hitShake, hitstop, squash, trail, orbit, spring } from './runtime/closed.js';
import { wrap } from './runtime/motion.js';

const LOOP = 4;
const snow = emitter({ seed: 11, rate: 500, life: LOOP, loop: LOOP });  // 2000 个在场，可无缝循环
window.DURATION = LOOP;                                                   // seamcheck 门 3a 比 frame(D) 与 frame(0)
window.seek = (tRaw) => {
  const t = wrap(tRaw, LOOP);
  for (const p of snow(t)) {                                              // 只枚举此刻存活的粒子
    const q = ballistic(p.age, { x: p.r(0) * W, y: -20 }, { x: 0, y: 40 }, { x: 0, y: 260 }, 1.6);
    const x = q.x + 18 * wobble(p.age * 1.3 + p.r(3) * 10, 3);           // 位移噪声摇摆
    draw(x, q.y, 1.5 + 2.5 * p.r(4));
  }
};
```

- **发射器是一个关于生命周期的函数**：粒子 i 出生于 `start + i/rate`，属性 `p.r(k)` 等于 `hash01(seed, i, k)`。成本是 O(rate × life)，与片长无关。`prewarm:true` 让片头一开始就处于稳态；`loop:L` 要求 `rate·L` 是整数，否则报错。爆发用 `burst()`。可变发射率要用累积发射量 N(t) 的反函数来做（运行时只提供常量发射率和 burst）。
- **场力**：常力加线性阻力有闭式解（`ballistic` 的 `k` 参数）。湍流和涡流**没有**闭式积分；`wobble()` 是用位移场做的替代，只能摆动，做不出漂移和卷曲，真正的涡流要走 ②。
- **与静态世界的碰撞**：`bounce()` 用几何级数在 O(1) 内算出当前是第几跳，返回 `lastHit`/`impactSpeed`。只支持平面；斜面、多墙反射、体间碰撞都做不了。
- **弹簧、摆、轨道**：`spring()` 支持初速度（`settle()` 是它的特例）；`pendulum()` 做了小角度线性化，摆角超过约 30° 时周期误差超过 2%；`orbit()` 是开普勒椭圆，用牛顿迭代 8 次求解。

## 策略 ② 定步重放：`runtime/replay.js` + `runtime/sims.js`

```js
import { createReplay } from './runtime/replay.js';
import { balls } from './runtime/sims.js';
const sim = balls({ n: 300, W: 1000, H: 1700, fps: 60 });
const R = createReplay({ fps: 60, substeps: 4, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1 });
window.seek = (t) => { const s = R.stateAt(t); /* 只读 s.x / s.y，不要改 */ draw(s); };
```

`stateAt(t)` 的**定义**是"从 init 走 n 步之后的状态"，缓存只是实现手段：顺序渲染时每帧走 `substeps` 步；乱序时最坏走一个检查点间隔；冷启动时走 n 步。一个检查点就是一份 state（300 球约 10 KB），通常每秒存一个就够了。

**仿真时间与影片时间不同**（快进、慢镜头、定格）：写成 `R.stateAt(S(t))`，其中 S 用 `runtime/timemap.js` 的 `timeMap(keys)` 构造（分段倍率、闭式积分、带反函数 `S.inv`），`fitRate` 反解倍率，让仿真里的事件对准旁白锚点。
`createReplay` 的 `fps` 是**每仿真秒的查询栅格**，`checkpointEvery` 的单位是仿真秒。四种常见的写错方式（其中"传反"和"忘了映射"两种结果完全确定，seamcheck 会全部通过）、代价和验证方法见 `references/timemap.md`。

自己写仿真体时要守住五条（违反任何一条，乱序结果就会和顺序不一致，physcheck 能发现）：
1. 所有可变量都放在 `state` 里，`clone(state)` 要完整复制（Float64Array 用 `slice()`）。2. 随机只用 `hash01(seed, stepIndex, k)`，`step` 的第三个参数就是步号。
3. 检查点存 clone，不存引用。4. 调用方不修改 `stateAt()` 的返回值，因为它就是缓存本身。
5. 草稿缓冲（比如空间网格）可以放在闭包里，前提是每一步开头都完全重写。

现成的仿真体（`sims.js`，Node 和浏览器通用，可以直接烘焙）：

| 工厂 | 效果 | 关键参数 | 每步 ms（Node，n≈300 / 1000 / 3000） |
|---|---|---|---|
| `balls` | 刚体圆：重力、墙、两两碰撞（位置修正加冲量）、分批出生、强碰撞时记录事件 | `n e g spawnOver hitSpeed` | 0.034 / 0.087 / 0.42 |
| `cloth` | Verlet 加距离约束迭代，顶排固定点，用 hash 生成阵风；`cols:1` 就是绳子 | `cols rows spacing iters wind` | 0.064 / 0.15 / 0.41 |
| `boids` | 分离、对齐、聚合，环面边界 | `view sep maxSpeed w*` | 0.081 / 0.34 / 2.2 |
| `fluid` | Clavet 双密度松弛粒子流体（近似方法，不是 NS 方程）；超过 1000 个粒子时 ② 的乱序 seek 会到秒级，基本只能用 ③ | `h k kNear rest visc` | 0.89 / 3.4 / 13.1 |
| `chain`（`runtime/chain.js`） | 一维跟随链：最优速度模型加运动学安全刹车，支持环路、直路、排队，以及扰动和虚拟前车 | `n a safety perturb leader start`（形状用 `chainDesign` 的 `kappa`） | 0.033 / 0.053 / 0.17 |

`chain` 的参数靠两个无量纲数来设计，不需要手动扫参数：κ 决定"堵不堵"，A\* 决定"撞不撞"，`chain().analysis` 会直接给出这两个值；`chainDesign()` 按物理量反解形状参数，`chainProbe()` 用于无头试跑。如果信号只是以**固定延迟**逐个传递（多米诺式点亮、人浪），用闭式 ① 的 `t0 + i·δ` 更省事。公式、实测边界和设计流程见 `references/chain.md`。

第三方引擎（matter-js 0.20 / planck 1.4 / rapier2d-compat 0.14）同样套用 `createReplay`：`init` 里建 world，`step` 里调用一次固定步长的步进；三者重放两次的结果都逐位一致。只有 rapier 能做检查点（`takeSnapshot/restoreSnapshot`）；matter 没有快照功能，planck 的 Serializer 会丢失接触缓存，这两者回退时只能从头重放，或者改走 ③。
固定步长的写法、每步耗时和跨机器确定性见 `references/libraries.md`。

## 策略 ③ 预烘焙：`scripts/bake.mjs` + `runtime/baked.js`

```bash
node <film-physics>/scripts/bake.mjs --sim balls --opts '{"n":300,"W":1000,"H":1688.9}' \
     --fps 60 --duration 6 --out films/<slug>/assets/balls
# baked balls: n=300 frames=361 (6s@60) fields=x,y  40 ms  846 KiB
```
```js
import { loadBake } from './runtime/baked.js';
let track; window.ready = loadBake('./assets/balls').then((t) => { track = t; window.DURATION = t.duration; });
window.seek = (t) => { const f = track.frame(t); draw(f.x, f.y); };   // f.x 是 Float32Array subarray
```
- 自定义仿真用 `--module ./my-sim.js --export mySim`，模块导出一个工厂函数，返回 `{init, step, clone, pack}`；`pack(state)` 决定导出哪些字段（除 x,y 之外还可以加角度、颜色索引、存活标志）。
- `track.lerp(t)` 在帧之间做线性插值，用于运动模糊子帧或 fps 不同的片子；代价是碰撞时的折角会被削掉一点。
- 代价：Float32 量化（在像素级没有影响）；改任何参数都要重新烘焙（烘焙命令要写进本片 docs，否则 .bin 文件的来历无从追溯）。
- 烘焙在 Node 里运行（运行时里的 `import './rand.js'` 由 film-core `lib/runtime-node.mjs` 按挂载表以相同语义解析，`--module` 也一样）。Node 烘焙的结果与 Chromium 内重放同一个 `balls` 逐位相同（夹具 `_test-physics/node-vs-browser.mjs`）；跨机器没测过。

## 游戏化反馈（全部是 ① 的纯函数，事件可以来自任何地方）

命中时刻 `hits[]` 可以来自 `bounce().lastHit`、② 仿真记录的事件（`balls` 的 `state.hitT`，会随检查点一起回退），或者旁白时间戳 `vo.at('撞')`（见 film-narration）。

| 手法 | 函数 | 代价与适用时机 |
|---|---|---|
| 屏震 | `hitShake(t, hits, {amp, decay, freq, rotAmp, seed})` 返回 `{x, y, rot}` | 用来强调冲击；震得太多观众会疲劳，字幕也读不清。震的是相机，不改物理 |
| 顿帧 | `hitstop(t, hits, dur)` 返回本地时间 | 让重击显得"有分量"；它会占用时间轴，旁白对齐的片子要把冻结时长算进镜头 |
| 闪白 | `flash(t, hits, dur)` | 最便宜的命中信号；有光敏风险，频率要克制 |
| 压扁 | `squash(t, lastHit, strength)` | 卡通弹性；在写实片里会显得轻 |
| 拖尾 | `trail(pos, t, n, dt)` 回采历史位置 | ① 下结果精确且不用保存历史；② 下要么每个回采点都调用 `stateAt`（很贵），要么把最近 n 帧的位置存进 state |
| 生成与消亡的节奏 | `emitter` 的 rate/life/jitter、`burst()`、`balls` 的 `spawnOver` | 节奏可以绑定到节拍栅格（film-core `motion.js` 的 `beatGrid`） |

`hitShake` 是在每个命中时刻叠加一次衰减震动；film-webfx `camrig.js` 的 `shake()` 是持续的手持噪声，两者是两回事。`hitstop` 有循环依赖问题：如果 hits 是由物理本身推出来的，冻结会改变之后的命中时刻。做法是先在未冻结的时间里算出 hits（作为常量），再把整条物理放进冻结后的时间里。

## 验收

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> [--loop]             # 内核门
node <film-physics>/scripts/physcheck.mjs --film <slug> --t0 0 --t1 3 --step 0.1   # 物理专用：逐帧顺序/乱序/倒序/冷启动比 + 计时
```
seamcheck 门 2 只采样 8 个时刻；physcheck 每帧都比较，还会倒序扫一遍（每帧都走"回退到检查点"的路径），专门用来发现缓存泄漏。两者都要通过。physcheck 在 `gates.json` 里按 `uses` 登记：片子加载了 `replay.js` / `baked.js` / `chain.js` 时，`accept --deep` 和 `deliver` 会自动运行它（默认 t=0–3s）。

场景声明了 `window.PHYS` 后会多跑两组检查。**E 时间映射**（`PHYS.timeMap = S`）验证 S 是纯函数、步号单调、没有顿帧、seek 确实传入了 S(t)；**F 断言**（`PHYS.claims`）对着真实的 seek 逐帧验证由仿真推出的事实，比如不相撞、锚点之前没有停下。seamcheck 只能证明画面是 t 的函数，证明不了它是正确的那个函数。
写法、判为不通过的条件，以及"断言和 seek 共用同一个 `at(t)`"、`PHYS.claims` 与分镜断言如何分工，见 `references/timemap.md` §6–§8。

## 未解决

**体间碰撞、长片、大规模、频繁改参数**同时出现时没有好办法（② 乱序慢，③ 每改一次都要重新烘焙；分段烘焙还没实现）。GPU 物理没有实测；大角度摆、斜面弹跳、多墙反射没有闭式解；跨机器确定性没测过。
