---
name: film-physics
description: 在 seek(t) 纯函数视频管线里做可任意跳帧的物理运动：粒子系统（发射、场力、生命周期、爆发）、重力弹道与落地弹跳、刚体碰撞与约束、布料绳索（Verlet）、群集（boids）、流体近似、摆与轨道、一维跟随链（跟车、幽灵堵车、红绿灯起步、排队挪动），以及事件表驱动的多通道冲击编排（打击感、后坐力、镜头手感、一个事件带动光/粒子/声音）与游戏化反馈（屏震、顿帧 hitstop、闪白、压扁、拖尾）。给出闭式解 / 定步重放+检查点 / 预烘焙三条可 seek 化策略的选型判据与实测代价，matter.js / planck.js / rapier 的定步改造，以及影片时间到仿真时间的映射（快进、慢镜头、定格）。片子里有东西"掉下来、弹起来、撞上、炸开、飘散、成群、流动、晃屏"，要做堵车、排队、链式传播，要引入物理引擎或写"从上一帧推下一帧"的循环、让仿真快进慢放时使用，哪怕用户只说"加点粒子""做个物理效果"。
---

# film-physics

物理天生是迭代的：下一帧 = f(上一帧)。管线却要求 `seek(t)` 是 t 的纯函数，乱序求值必须和顺序求值逐像素一致（`../film-core/references/kernel.md` §2）。
本 skill 讲**怎样把有状态的仿真变成从外部看无状态的函数**、每种做法的代价，以及各类物理效果在这个约束下难在哪。
算法本身（弹道公式、Verlet、boids、Clavet 流体……）由你按本片需要直接写；这里给原理、难点、实测代价和坑，不给成品工厂。

分工：本 skill 算**位置**（以及速度、事件时刻）。把点画成像素（辉光、着色器、混合、后期）归 film-webfx；GPU 粒子主要工作是着色就归 webfx，主要是运动积分就归这里。
`seek(t)` 契约、`settle()`、`seeded()`/`hash01()`、事件表 `events.js`、seamcheck、渲染和交付见 film-core。画什么、什么时候炸开，由 film-story 和本片 `docs/style_guide.md` 决定。

## 硬约束（技术不变量）

1. **物理库自带的循环要关掉**（kernel.md §2）：matter 的 `Runner.run`/`Render.run`、planck 的 testbed、rapier 的 rAF 包装、cannon 的 `fixedStep()` 都由 rAF 和墙钟驱动，seek 一跳就错。改成手动 `step(固定 dt)`，步数由 t 算出。
2. **步数由整数帧号算**：`n = Math.round(t * fps) * substeps`（t、fps 都是**仿真**时间里的量，见"时间映射"）。`Math.floor(t / dt)` 在 t=0.3 这类值上会因浮点误差少一步，乱序时偶发不一致。
3. **随机数用计数器式 hash**：film-core `rand.js` 的 `hash01(seed, i, k)`，本 skill 统一按 `(种子, 体号或步号, 属性号)` 传。闭包里按顺序调用的 `seeded()` 在恢复检查点时不会跟着回退。
4. **可以缓存，不能留状态**：判据是 `physcheck` 和 seamcheck 过不过，不是代码里有没有可变变量。

## 三条策略

| | ① 闭式解 | ② 定步重放 + 检查点 | ③ 预烘焙查表 |
|---|---|---|---|
| 原理 | 直接对解析式 `x(t)` 求值 | 从 t=0 以固定 dt 推进；单调缓存，每仿真秒存一个检查点 | 离线跑一次 ②，把每帧每个体的字段写成 Float32 表 |
| 能做 | 弹道、线性阻力、平面弹跳、弹簧、小角度摆、开普勒轨道、发射器、屏震、顿帧、闪白 | 全部：体间碰撞、约束、布料、boids、流体、第三方引擎 | 与 ② 相同 |
| 做不到 | **物体之间的相互作用**（碰撞、群集、约束都是全局耦合） | 物理上不受限，只受时间预算限制 | 改参数要重烘 |
| seek 单帧（实测） | 2000 粒子 0.5 ms；20000 粒子 4.4 ms | 顺序 0.11 ms/帧（300 球）；乱序最坏重放一个检查点间隔 | 300 球 0.04 ms/帧 |
| 冷启动 seek 到片尾 | 同上（与 t 无关） | O(t)：300 球 10 s 约 80 ms，60 s 约 480 ms | 读一次文件 |
| 循环（首帧 = 末帧） | **免费**：属性按 `i mod (rate·L)` 取 | 混沌系统一般做不到 | 同 ② |
| 磁盘 | 0 | 0 | 存 x,y：300 体 10 s 1.4 MiB，1000 体 60 s 27.5 MiB |
| 实现成本 | 低，但要会推公式 | 中：state 必须能完整 clone | 中：多一步烘焙，要管文件版本 |

### 怎么选

1. **物体之间需要相互作用吗？** 不需要就用 ①。雪、雨、火花、抛物、落地弹跳、摆、轨道、命中反馈，大多数"粒子效果"都不需要体间碰撞；① 还顺带支持循环和预热。
2. 需要的话，看**乱序 seek 的最坏耗时能不能接受**。先搭 ② 的原型，`physcheck` 的计时部分直接给出顺序、乱序、冷启动各多少 ms；也可以按 `ms/步 × fps × substeps × 检查点间隔` 估算（每步 ms 见 `references/effects.md`）。能接受就用 ②，改参数立即生效。
3. 不能接受（物体多、片子长、要反复重渲、多机并行渲染）就用 ③，把 O(t) 挪到一次离线计算。
4. 可以混用：主体碰撞走 ② 或 ③，背景尘埃走 ①，屏震由 ②/③ 记录的碰撞事件推出（屏震本身是 ① 的函数）。

实现细节（为什么缓存不违约、检查点伪代码、烘焙文件格式）见 `references/strategies.md`。

## 本 skill 带的基础设施

只有"把有状态的东西包装成可 seek"的那几件，效果本身都不带。场景里 `import './runtime/x.js'`（服务器从已安装的 skill 挂载，deliver 时冻结进片子）。

**定步重放 `assets/runtime/replay.js`**：

```js
import { createReplay } from './runtime/replay.js';
const R = createReplay({ fps: 60, substeps: 4, init, step, clone, checkpointEvery: 1 });
window.seek = (t) => draw(R.stateAt(t));     // 只读返回值，不要改
```

`stateAt(t)` 的**定义**是"从 `init()` 走 n 步之后的状态"，缓存只是实现：顺序渲染每帧走 `substeps` 步，乱序最坏走一个检查点间隔，冷启动走 n 步。一个检查点就是一份 state（300 球约 10 KB）。
`init/step/clone` 自己写，守五条（违反任何一条，乱序就和顺序不一致，physcheck 能发现）：
1. 所有可变量都在 `state` 里，`clone` 完整复制（Float64Array 用 `slice()`）。
2. 随机只用 `hash01(seed, stepIndex, k)`；`step(state, dt, stepIndex)` 的第三个参数就是步号。
3. 一次性开关（扰动是否已施加、某体是否已消失）也放进 state，或直接由步号判断（`k·dt >= t0`）；闭包里的 `fired` 标志回退时不复位。
4. 调用方不修改 `stateAt()` 的返回值，它就是缓存本身。
5. 草稿缓冲（空间网格、加速度暂存）可以放闭包，前提是每步开头全部重写。

同文件还有 `eventRing / pushEvent / cloneRing / eventTimes`：定长环形缓冲，把碰撞时刻存进 state，让事件随检查点一起回退。

**时间映射 `assets/runtime/timemap.js`**：影片时间 ≠ 仿真时间（快进、慢镜头、定格）时写 `R.stateAt(S(t))`，`S = timeMap(keys)` 分段倍率、闭式积分、带反函数 `S.inv`；`fitRate` 反解倍率，让仿真里的事件对准旁白锚点。
`createReplay` 的 `fps` 是**每仿真秒的查询栅格**，`checkpointEvery` 以仿真秒计。四种写错的方式（其中"传反"和"忘了映射"完全确定，seamcheck 全过）见 `references/timemap.md`。

**预烘焙 `scripts/bake.mjs` + `assets/runtime/baked.js`**：

```bash
node <film-physics>/scripts/bake.mjs --module films/<slug>/sim.js --export mySim \
     --opts '{"n":300}' --fps 60 --duration 6 --out films/<slug>/assets/balls
```
```js
import { loadBake } from './runtime/baked.js';
let track; window.ready = loadBake('./assets/balls').then((t) => { track = t; window.DURATION = t.duration; });
window.seek = (t) => { const f = track.frame(t); draw(f.x, f.y); };   // subarray，零拷贝，只读
```
- 模块导出一个工厂 `(opts) => ({init, step, clone, pack})`，opts 里会带上 `fps`、`substeps`；`pack(state)` 返回要导出的字段数组（x,y 之外可以加角度、颜色索引、存活标志，名字用 `opts.fields` 给）。场景里用 ② 重放的也是同一个模块，原型和成片不分叉。
- `track.lerp(t)` 帧间线性插值，给运动模糊子帧或 fps 不同的片子用；代价是碰撞折角被削掉一点。
- 代价：Float32 量化（像素级无影响）；改任何参数都要重烘（烘焙命令写进本片 docs，否则 .bin 的来历无从追溯）。
- 烘焙在 Node 里跑，模块里的 `import './rand.js'` 按挂载表同语义解析。同一份仿真代码 Node 烘焙与 Chromium 内重放逐位相同（圆形刚体实测）；跨机器没测过。

## 效果索引

每个效果在参考文件里都按 **原理 → 在 seek(t) 下难在哪 → 代价 / 什么时候值得 → 坑 → 可用的库** 写。

| 效果 | 通常走 | 难点一句话 | 读 |
|---|---|---|---|
| 粒子、发射器、爆发、场力 | ① | 发射器要写成"生命周期的函数"，按下标随机访问；湍流没有闭式积分 | `references/effects.md` §1 |
| 弹道、落地弹跳 | ① | 第几跳要 O(1) 算出；e<1 在有限时间内静止（Zeno 点） | §2 |
| 弹簧、摆、轨道 | ① | 大角度摆、多体没有闭式解 | §3 |
| 刚体碰撞与约束 | ② / ③ | 全局耦合；子步数决定结果；事件要进 state | §4、`references/libraries.md` |
| 布料、绳索（Verlet） | ② / ③ | 位置式积分的"速度"藏在上一帧位置里，clone 要带上 | §5 |
| 群集 boids | ② / ③ | 更新顺序会改变结果，要先算全部加速度再统一应用 | §6 |
| 流体近似（Clavet 双密度） | ③ 为主 | 每步最贵；>1000 粒子时 ② 的乱序 seek 到秒级 | §7 |
| 一维跟随链：跟车、幽灵堵车、红绿灯起步、排队 | ② | 堵不堵、撞不撞由两个无量纲数决定，不该靠扫参 | `references/chain.md` |
| 屏震、顿帧、闪白、压扁、拖尾、后坐、着陆下沉 | ① | 哪些通道读影片时间、哪些读世界时间；顿帧与物理的循环依赖 | `references/events.md` |
| 第三方引擎 matter / planck / rapier | ② / ③ | 只有 rapier 能做真检查点 | `references/libraries.md` |

## 事件驱动的多通道冲击

一次冲击（命中、落地、爆炸）是**一个事件、多条响应**：光、闪白、屏震、后坐、粒子爆发、声音 cue 都从同一张事件表读同一个时刻，各自用自己的响应核（自事件起的年龄 τ = t − e.t 的函数）决定冲量和余韵。
事件表、响应核、节流与帧对齐、声音桥都在 film-core `runtime/events.js`（文档 film-core `references/events.md`）；本 skill 的 `references/events.md` 讲游戏手感那几条通道的原理、代价，以及顿帧下"影片时间 / 世界时间"怎么分。
事件可以来自任何地方：闭式弹跳算出的触地时刻、② 仿真记录进 state 的碰撞、旁白时间戳 `vo.at('撞')`（film-narration）。由物理推出的事件若要回到影片时间轴，过一遍 `S.inv`。

## 验收

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> [--loop]                       # 内核门
node <film-physics>/scripts/physcheck.mjs --film <slug> --t0 0 --t1 3 --step 0.1    # 逐帧顺序/乱序/倒序/冷启动比 + 计时
```
seamcheck 门 2 只采样 8 个时刻；physcheck 每帧都比，还倒序扫一遍（每帧都走"回退到检查点"），专抓缓存泄漏。两者都要过。physcheck 在 `gates.json` 里按 `uses` 登记：片子加载了 `replay.js` / `baked.js` 时，`accept --deep` 和 `deliver` 自动跑（默认 t=0–3 s）。
只用 ① 的片子不加载这两个文件，seamcheck 就够。

声明了 `window.PHYS` 会多跑两组：**E 时间映射**（`PHYS.timeMap = S`）验 S 是纯函数、步号单调、不顿帧、seek 确实传入了 S(t)；**F 断言**（`PHYS.claims`）对着真实 seek 逐帧验由仿真推出的事实，比如不相撞、锚点之前没停。seamcheck 只能证明画面是 t 的函数，证明不了它是正确的那个函数。写法见 `references/timemap.md` §6–§8。

## 未解决

**体间碰撞 + 长片 + 大规模 + 频繁改参数**同时出现时没有好办法（② 乱序慢，③ 每改一次要重烘；分段烘焙没实现）。GPU 物理没实测；大角度摆、斜面弹跳、多墙反射没有闭式解；跨机器确定性没测过。
