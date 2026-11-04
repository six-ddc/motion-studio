# 影片时间 ≠ 仿真时间：时间映射 S(t)

目录：1 定义 · 2 和检查点怎么配合 · 3 四种写错的方式 · 4 代价 · 5 用仿真结果反解映射 · 6 怎么验 · 7 运动模糊子帧 · 8 验证路径通则与分镜断言的分工

运行时代码在 `assets/runtime/timemap.js`（`timeMap`、`fitRate`）。验证由 `scripts/physcheck.mjs` 的 E 组与 F 组负责。

## 1. 定义

把"没过几分钟"压缩进 3 秒、让关键的一刻慢下来、定格，这些都可以表示为一条从影片时间 t 到仿真时间 S(t) 的映射：

```js
import { timeMap } from './runtime/timemap.js';
const S = timeMap([
  { t: 0,   rate: 1 },               // 片头实时
  { t: 6.0, rate: 1 },
  { t: 7.0, rate: 5 },               // 6→7 s 平滑加速到 5×（默认 ease 'smooth'：倍率 C¹ 连续）
  { t: 12,  rate: 5 },
  { t: 13,  rate: 1 },               // 12→13 s 减回 1×
]);
window.seek = (t) => { const s = R.stateAt(S(t)); draw(s); };
```

- `S(t) = s0 + ∫ rate`，每一段都用闭式积分计算（smoothstep 的积分是 `u³ − u⁴/2`），与细步长数值积分的结果相差 2.6e-9 s。
- `S.rate(t)` 返回倍率，`S.inv(s)` 是反函数（用于把仿真事件换算回影片时间轴，例如屏震、字幕），往返误差为 7e-15 s。
- `ease: 'step'` 表示到达这个 key 时瞬间切换；`rate: 0` 表示定格；`rate < 0` 表示倒放，需要写 `{ reverse: true }` 才会被接受。`s0` 是片头时已经过去的仿真时间（用于开场即处于稳态的情况）。

`stateAt(x)` 是 x 的纯函数，S 是 t 的纯函数，两者复合后仍是 t 的纯函数，契约自然成立。`createReplay` 的 `fps` 是**仿真时间里的查询栅格**，`stateAt` 的参数单位是**仿真秒**；只有在默认的 S(t) = t 时，它们才恰好等于影片 fps 和影片时间。

## 2. 和检查点怎么配合

不需要额外配合。检查点按**仿真步号**保存（每 `checkpointEvery` 仿真秒存一个），查询时用 `n = round(S(t)·fps)·substeps`：

- 检查点的间隔以**仿真秒**计。在 5× 段里，影片每走 0.2 s 就会跨过一个检查点；乱序 seek 的最坏耗时与倍率无关。
- 定格段每一帧求的是同一个步号，命中缓存，走 0 步；倒放段每一帧都要"恢复检查点再重放"，这也是 E2 在 reverse 时报告回退次数的原因。

## 3. 四种写错的方式（每种在 `_test-physics` 里有一个会红的反例）

| 写法 | 后果 | 能检出的检查 | 反例入口 |
|---|---|---|---|
| **在 seek 里累加**：`simT += rate(t)·(t − lastT)` | 产生跨帧状态。乱序、倒序、冷启动的结果全错 | B、C、D、E4 | `warp-accum.html` |
| **映射传反或忘了映射**：`stateAt(S.inv(t))`、`stateAt(t)` | 结果完全确定，同一个 t 得到同一帧，乱序与顺序一致，所以 **B/C/D 和 seamcheck 全部通过**，但画面出现在错误的时刻 | 只有 **E4** | `warp-inverted.html` |
| **慢镜头时查询栅格太粗**：rate·fps_sim < fps_film·sub | 相邻帧落在同一个仿真步上，画面一顿一顿的（这是量化问题，不是不确定性） | 只有 **E3** | `warp-coarse.html`；修好的版本是 `warp-slowmo.html`（fps 240，dt 不变） |
| **仿真参数用了影片时间**：扰动或事件时刻直接写 `vo.at('轻')` | 只要映射在这个时刻之前开始变速，事件就会挪位 | F 组断言 | — |

第四种的正确写法是：仿真参数一律用仿真秒，写 `perturb.t = S(vo.at('轻'))`；仿真里记录下的事件要回到影片时间轴时，用 `S.inv(hitT)`。E4 不比较像素，而是比较"实际传给 stateAt 的步号"和"按声明的 S(t) 换算出的步号"。原因是确定性验收只能证明画面是 t 的函数，不能证明它是正确的那个函数。

## 4. 代价

时间映射不改变每一步的开销，只改变**每帧要走多少步**：

- 顺序渲染时每帧走 `rate · fps_sim·substeps / fps_film` 步。例如 5×、240 Hz、30 fps 时，每帧走 40 步。
- 冷启动 seek(t) 要走 `S(t) · fps_sim · substeps` 步。**分片并行渲染时，每个 worker 都要冷启动到自己分片的起点**："10 分钟压进 10 秒"的片子，每个 worker 要先跑 600 仿真秒（300 个球约 4.9 s；22 个单元的跟随链约 0.2 s）。这种情况下可以考虑改用 ③ 预烘焙，或者调大检查点间隔来节省内存。
- 慢镜头（rate < 1）要求 `fps_sim ≥ fps_film·sub / rate`。只要保持 `fps·substeps` 不变，仿真结果就不会变：`fps: 60, substeps: 4` 改成 `fps: 240, substeps: 1` 是同一个 dt=1/240 的仿真，只是可查询的点密了 4 倍。

## 5. 用仿真结果反解映射（"让第一辆车停住的那一刻落在旁白上"）

1. 无头运行一遍仿真（用 `chainProbe` 或 `init` + `step`），得到事件的**仿真**时刻，例如 `firstStop`。
2. 映射的形状由旁白锚点决定（在哪里加速、在哪里减回），只剩倍率 W 是自由的。
3. 调用 `fitRate((W) => timeMap([...{ t: up1, rate: W }, { t: hold, rate: W }...]), vo.at('逼'), firstStop)`，用二分法求出使 S(vo.at('逼')) = firstStop 的 W。这要求 S 随 W 单调递增（加速段的倍率总是满足这一点）。

前提是事件时刻只取决于"从 init 开始、使用同一组参数"的无头仿真。旁白重新录制后，W 会在加载时重新计算，画面自动跟上（如果用的是 ③ 预烘焙，每次重录都要重新烘焙）。

## 6. 怎么验

在场景里做如下声明（只是声明，不改变画面）：

```js
const at = (t) => R.stateAt(S(t));                       // seek 和断言共用这一个函数
window.seek = (t) => draw(at(t));
window.PHYS = {
  timeMap: S,                                            // 或 { S: fn, reverse: true }
  parts: [{ name: 'chain', stats: R.stats, cps: R.checkpoints, stepsAt: R.stepsAt }],
  claims: [
    { what: '不撞', test: (t) => ({ ok: at(t).minGap[0] > 0, value: at(t).minGap[0] }) },
    { what: '锚点前没有车停', from: 0, to: vo.at('逼') - 0.3, test: (t) => at(t).firstStop[0] < 0 },
  ],
};
```
```bash
node <film-physics>/scripts/physcheck.mjs --film <slug> --t0 0 --t1 <片长> --step 0.1 --sub <渲染时的 sub>
```

E 组只在声明了 `PHYS.timeMap` 时运行：

| | 检查什么 | 判红条件 |
|---|---|---|
| E1 | S 是纯函数 | 在 fps×sub 栅格上顺序求一遍、打乱顺序再求一遍，任何一处结果不相等 |
| E2 | 步号单调 | `stepsAt(S(t))` 随 t 增大而减小（没有声明 reverse 时） |
| E3 | 不顿帧 | 相邻子帧之间 S 在变化但步号没动，并且该处倍率 ≥ `--dup-rate`（默认 0.2；低于这个值只警告，因为在定格前的减速斜坡末尾，任何有限栅格都会出现同步）。报告中会给出所需的 fps |
| E4 | 实际传入的就是 S(t) | `seek(t)` 之后 replay 的 `stats.lastN` ≠ `stepsAt(S(t))` |

F 组有一个陷阱：如果断言自己调用 `R.stateAt(S(t))`，而 seek 画的却是 `stateAt(t)`，断言会全部通过，验证的只是声明本身而不是画面。所以 seek 和断言要共用同一个 `at(t)`，再由 E4 保证 seek 确实用了它。

E4 依赖 `replay.js` 的 `stats.lastN`（片内冻结的旧版 `replay.js` 没有这个字段时，结果报为"未判"）。如果一帧里对同一个 replay 多次调用 `stateAt`（例如拖尾效果要回溯采样），`lastN` 记录的是最后一次调用，E4 会误报。解决办法是给拖尾单独开一个 replay，或者不声明 timeMap。

## 7. 运动模糊子帧

render.mjs 的子帧时刻 `(K + shutter·j/sub)/fps` 同样要经过 S 映射，所以**模糊长度会随倍率变化**：5× 段的模糊长度是实时段的 5 倍（相当于用同样快门角度拍摄的延时摄影）。要让模糊长度与倍率无关，需要把帧号和帧内偏移分开映射：S_b(t) = S(K/fps) + min(rate, cap)·(t − K/fps)。本运行时**没有实现**这一点。
E3 的 `--sub` 只检查子帧有没有落在同一个仿真步上（落在同一步，意味着那一帧的运动模糊被悄悄关掉了）。

## 8. 验证路径通则与分镜断言的分工

**通则：验证所走的路径必须就是被验证的那条路径。** 检查读取的值和画面使用的值，必须是**同一个函数算出来的同一个量**：被验证的量只计算一次，两边共用（`at(t)`、同一个阈值常量、同一个参照帧选取函数）。在此之外，还要有一道**不经过检查代码本身**的旁证：
在本 skill 里是 E4 比对 replay 实际收到的步号，在 film-critique 里是 `source: pixels`。

| | `PHYS.claims`（本 skill，physcheck F 组） | shotlist `source: scene`（由 film-story 定义、film-critique 的 `check.mjs` 运行） |
|---|---|---|
| 定位 | 实现阶段的快速自检 | 流水线上的放行检查 |
| 验证内容 | 仿真自身的不变量：不撞、不穿模、锚点前没停、扰动后确实堵住了 | 旁白所说的状态在画面上成立，例如念到"传"时亮灯的数量在增加 |
| 依赖 | 只依赖场景和仿真（写锚点时刻时只是借用了 narration） | 依赖 narration.json 的实测区间和 `window.probe(t)` |
| 运行时机 | 调参或修改仿真之后，几秒内出结果 | 分镜定稿后、渲染之前 |

两者不能互相替代：前者不知道旁白在说什么；后者的 probe 如果没有和 seek 共用 `at(t)`，即使通过也只能证明 probe 自身一致。两套都用时，都从同一个 `at(t)` 取值。
