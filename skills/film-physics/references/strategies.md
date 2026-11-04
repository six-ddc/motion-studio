# 三条策略：实现说明

目录：1 为什么缓存不违反契约 · 2 闭式解 · 3 定步重放 · 4 预烘焙 · 5 混用

选型判据和实测代价表在 SKILL.md 里；浏览器内多种规模的实测见仓库 docs/verified/film-physics.md §3。另见 `chain.md`、`timemap.md`。

## 1. 为什么缓存不违反契约

契约禁止的是"会影响输出的跨帧状态"，判断标准来自外部观测：同一个 t 求两次结果一致，乱序求值与顺序求值结果相同。
定步重放的 `stateAt(t)` 在**定义上**等于 `stepⁿ(init())`，其中 n = round(t·fps)·substeps。只要缓存和检查点只是对这个定义的忠实加速（恢复出来的状态与"从头一步步走到这里"逐位相同），输出就仍然是 t 的函数。
有三类错误会破坏这种等价，physcheck 的阴性对照都能检出：检查点存的是引用而不是副本（A）、在 state 之外使用顺序推进的随机数生成器（B）、往回 seek 时不回退状态（C）。

## 2. 闭式解（runtime/closed.js）

| 函数 | 公式或算法 | 适用边界 |
|---|---|---|
| `ballistic(t,p0,v0,g,k)` | k=0 时为 `p0+v0t+½gt²`；k>0 时为 `p0 + (g/k)t + (v0-g/k)(1-e^{-kt})/k` | 常力加线性阻力。二次阻力没有初等闭式解 |
| `bounce(t,y0,v0,g,floor,e)` | 解二次方程得到首次触地时刻；之后每次飞行时长构成几何级数 2u eⁿ/g，`n = floor(log(1 - s g(1-e)/2u)/log e)` | 只处理单个平面；e<1 时在有限时间内静止（越过 Zeno 点之后直接进入静止） |
| `spring(t,x0,v0,target,k,c)` | 二阶线性 ODE 的三个分支（欠阻尼、临界阻尼、过阻尼） | 线性弹簧 |
| `pendulum` | 用 `spring`，取 k=g/L | 小角度 |
| `orbit` | 开普勒方程，牛顿迭代 8 次 | 二体问题；多体没有闭式解 |
| `emitter` | 粒子 i 的出生时刻为 `start+i/rate`；属性取 `hash01(seed, i mod N, k)` | 发射率恒定；`loop` 要求 rate·L 为整数 |
| `hitShake/hitstop/flash/squash/trail` | 在事件时刻上叠加的函数 | 事件很多时开销为 O(hits)，可以先按时间窗过滤 |

计数器式随机数只需要计算当前在场的粒子，开销为 O(rate·life)；顺序推进的随机数要从第 0 个粒子开始抽取，seek 到 t 的开销是 O(总发射数)。
循环的原理：属性按 `i mod (rate·L)` 取值，所以 t+L 时刻的在场粒子集合，就是把 t 时刻的集合整体平移 rate·L 个下标，年龄和属性都相同，因此两帧逐像素相同。prewarm 允许使用负下标。

## 3. 定步重放（runtime/replay.js）

```
stateAt(t):
  n = round(t·fps)·substeps
  if n < curN: k = floor(n/every)·every; cur = clone(cps[k]); curN = k
  while curN < n: step(cur, dt, curN); curN++; if curN % every == 0: cps[curN] = clone(cur)
  return cur
```
- 检查点只在第一次顺序经过时保存，所以凡是不超过已到达最大步数的 every 整数倍步号，都有对应的检查点。开销为：顺序渲染每帧 O(substeps)，回退 O(every)，冷启动 O(n)。内存占用为检查点数乘以 state 大小（300 个球约 4×300×8 B，即每个检查点约 10 KB）。
- substeps：碰撞或约束越硬，步长就要越细。balls 和 cloth 用 4（dt=1/240），boids 用 1 就够。改动 substeps 会改变结果（离散化方式不同了），定稿后再改就要重新看一遍。
- 事件（例如碰撞时刻）要存进 state（`balls` 用的是定长环形缓冲区 `hitT`），才能随检查点一起回退。
- 伪代码里的 t 是仿真时间，fps 是仿真时间里的查询栅格。影片时间与仿真时间不同时，调用 `stateAt(S(t))`，检查点不需要改，见 `timemap.md`。
- "开关"类的一次性事件（扰动是否已经施加、某个物体是否已经消失）同样必须放在 state 里，或者直接根据步号判断（`t >= p.t && t < p.t + p.dur`，其中 t = 步号 × dt）。如果用闭包里的 `fired` 标志，回退到它被置位之前的检查点时，这个标志不会复位（阴性对照 `_test-physics/chain-leak-flag.html`：乱序和倒序都判红；冷启动时一旦跑过扰动时刻，整支片子里扰动都不会再发生）。

## 4. 预烘焙（scripts/bake.mjs + runtime/baked.js）

- 文件格式：`<name>.json` 是文件头（sim、opts、fps、substeps、frames、n、fields），`<name>.bin` 是 Float32 数据，按帧优先排列：`data[(f·fields + k)·n + i]`。
- `loadBake` 会校验数据长度，不符时抛错。`frame(t)` 返回零拷贝的 subarray；`lerp(t)` 在帧间插值。
- 文件大小 = (D·fps+1) × fields × n × 4 字节。超过几十 MB 时有三条出路：只存可见的物体、降为 Int16 定点数（精度 1/16 像素已经足够）、拆成多个分段文件。本运行时没有实现这些压缩方式。

## 5. 混用

一个场景可以同时用三条策略。例如主体的 200 个碰撞块用 ③ 预烘焙，背景的 5000 粒尘埃用 ① 闭式解，屏震用 ① 的 `hitShake()`；命中时刻可以从 ③ 的烘焙数据里一起导出（在 `pack` 里多加一个事件字段），也可以在烘焙脚本里另存一份 JSON。
