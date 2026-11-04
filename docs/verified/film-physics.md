# film-physics 验证记录

环境：macOS Darwin 25 / Node 22.17 / Playwright 1.64.1 / Chromium 156（headless，canvas 2D）。
测试片：`tests/fixtures/_test-physics/`（留着，可复现）。所有原始输出在 `tests/fixtures/_test-physics/out/*.txt`。
runtime 已按契约拷进 `tests/fixtures/_test-physics/runtime/`（film-motion 的 motion.js/layout.js + 本 skill 六个文件；
第 6–8 节那一轮把 `replay.js`（新增 `stats.lastN`）、`sims.js`（转出 `chain`）重拷了一次，并新增 `chain.js`、`timemap.js`）。

入口（每个变体一个 html，film-motion seamcheck 用 `--entry` 切换）：

| 入口 | 内容 |
|---|---|
| `closed.html` | 策略 ①：2000 雪粒子（循环发射器）+ 12 弹跳球（拖尾/压扁/顿帧/屏震/闪白）+ 5 轨道体，4 s 循环 |
| `closed-20k.html` | 同上，发射率 ×10 → 20000 粒子 |
| `replay.html` | 策略 ②：300 碰撞球 + 26×16 布料 + 250 boids + 400 流体粒子，四个 Replay 并存，6 s |
| `replay-balls.html` | 策略 ②：只有 300 碰撞球 |
| `replay-leak-{ref,rng,nocp}.html` | 策略 ② 故意植入三种缓存泄漏 |
| `baked.html` | 策略 ③：查 `assets/balls.bin`（由 bake.mjs 从同一 `balls` 仿真烘出） |
| `chain.html` | 策略 ② + 时间映射：22 单元环形跟随链（默认参数），8 s 片里 1×→5.75×→1×，倍率由"第一辆停住落在影片 6.0 s"反解；声明 PHYS.timeMap 与 3 条断言 |
| `chain-{crash,nojam}.html` | 故意的坏参数：关安全项 + a=1, κ=3（A*=0.74）/ a=2, κ=0.9（稳定区） |
| `chain-leak-{ref,flag}.html` | 故意的缓存泄漏：检查点存引用 / 扰动"已触发"开关放在闭包里 |
| `warp-{accum,inverted,coarse}.html` | 故意写错的时间映射：seek 里累加 simT / `stateAt(S.inv(t))` / 0.25× 慢镜头配 60/s 查询栅格 |
| `warp-slowmo.html` | `warp-coarse` 的修好版：同一条映射，查询栅格 240/s（dt 不变） |
（这些入口共用 `chain.js`，参数开关在各 html 的 `window.CFG` 里。）

## 1. 契约 seamcheck（film-motion 版，三门 + 禁用 API 探针）

```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry closed.html --loop    → exit 0
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry closed-20k.html --loop → exit 0
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry replay.html           → exit 0
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry baked.html            → exit 0
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry replay-leak-ref.html  → exit 1
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry replay-leak-rng.html  → exit 1
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-physics --entry replay-leak-nocp.html → exit 1
```

closed.html（节选）：
```
影片 _test-physics  入口 closed.html  9x16 1080×1920  4s @ 60fps  采样 8 个时刻  loop=true
门 2  乱序求值（按种子 7 打乱后再扫一遍，和顺序结果逐像素比）：  ✓ 通过
门 3  循环接缝：
  3a frame(0) vs frame(4): 逐像素一致
  3b 跨缝 frame(3.983)→frame(0): 146872 像素变化；相邻帧典型 114469.5 像素；容差 457878
  ✓ 通过：首尾一致且跨缝无跳变
探针  seek 期间调用的禁用 API：  ✓ 无
```
replay.html / baked.html：门 1a、1b、2、探针全过；门 3 "未判"（非循环片，`film.json loop:false`）。

**一个踩到的坑**：第一次跑 closed.html 门 3a 失败——我按旧版 seamcheck 的习惯写了
`DURATION = LOOP + 1/fps`，而 film-motion 新版比的是 `frame(DURATION)` vs `frame(0)`。
改成 `DURATION = LOOP` 后通过。已写进 SKILL.md 的示例注释。

## 2. 缓存泄漏测试（策略 ② 的命门）

工具：`scripts/physcheck.mjs`。顺序扫 t=0,0.1,…,3.0（31 帧，帧栅格对齐）记 canvas SHA-1，
再按种子 7 打乱扫一遍、倒序扫一遍，逐帧比；另开新页面冷启动直接 seek(3.0) 比。

**先写有泄漏的版本，确认测试能抓到**。三种泄漏都是真实会犯的错，开关在 `createReplay({leak})`
和 `shared.js`：

| 泄漏 | 怎么写错的 | physcheck 结果 | seamcheck 门 2 |
|---|---|---|---|
| A `ref` | 检查点 `cps.set(n, cur)` 存引用不存 clone，后续步把检查点也改了 | ✗ 乱序 0/31、倒序 0/31 一致 | ✗ 8/8 时刻不一致 |
| B `rng` | step 里用闭包 `seeded(42)` 给前 8 个球加抖动；回退检查点时 rng 不回退 | ✗ 乱序 11/31，**首个不一致 t=1.100**（第一个检查点之后才露馅） | ✗ |
| C `nocp` | t 变小时不回退，直接返回当前（未来）状态 | ✗ 乱序 1/31、倒序 1/31 | ✗ |

```
$ node skills/film-physics/scripts/physcheck.mjs --film _test-physics --entry replay-leak-rng.html --t0 0 --t1 3 --step 0.1
physcheck _test-physics/replay-leak-rng.html  9x16  t=0..3 步长 0.1s（31 帧）@60fps  打乱种子 7
  ✗ B 乱序 vs 顺序: 11/31 帧一致  首个不一致 t=1.100 共 20 帧: 1.10,1.20,1.30,1.40,1.50,1.60,1.70,1.80
  ✗ C 倒序 vs 顺序: 12/31 帧一致  首个不一致 t=1.100 共 19 帧: 1.10,1.20,1.30,1.40,1.50,1.60,1.70,1.80
  ✓ D 冷启动直接 seek(3) vs 顺序
✗ 2 项未通过
```
注意 D（冷启动）对三种泄漏**全部通过**——只做"新页面 seek 一次"的测试抓不到缓存 bug，
必须有回退路径参与。泄漏 B 只在跨过第一个检查点（1 s）之后才出现，所以测试时刻要覆盖 > 1 个检查点间隔。
另外三种泄漏下 seamcheck 门 1a（同 t 求两次）和 1b（重载页面）也都通过——只有门 2 抓到。

**修好后（不传 leak）**：
```
$ node skills/film-physics/scripts/physcheck.mjs --film _test-physics --entry replay.html --t0 0 --t1 3 --step 0.1
  ✓ B 乱序 vs 顺序: 31/31 帧一致
  ✓ C 倒序 vs 顺序: 31/31 帧一致
  ✓ D 冷启动直接 seek(3) vs 顺序
  仿真统计: balls 步数=2156 回退=1 检查点=6 | cloth 步数=2156 回退=1 检查点=6 | boids 步数=539 回退=1 检查点=6 | fluid 步数=1078 回退=1 检查点=6
✓ 全部通过
```
closed.html、closed-20k.html、replay-balls.html、baked.html 同样 31/31、31/31、冷启动 ✓。

## 3. 性能（实测）

浏览器内（physcheck，含 canvas 2D 绘制，不含截图/编码），9x16 1080×1920，60 fps：

| 策略 | 场景 | 体数 | 片长 | 顺序 seek ms/帧 | 乱序 seek 均值/最大 ms | 冷启动 seek(3s) | 整片顺序 seek 总计 | 磁盘 |
|---|---|---|---|---|---|---|---|---|
| ① 闭式 | closed | 2017 | 4 s | 0.49 | 0.59 / 1.2 | 2.9 ms | 240 帧 118 ms | 0 |
| ① 闭式 | closed-20k | 20017 | 4 s | 4.40 | 4.39 / 5.5 | 10.7 ms | 240 帧 1056 ms | 0 |
| ② 重放 | replay-balls | 300 球 | 6 s | 0.11 | 2.19 / 7.8 | 15.5 ms | 360 帧 41 ms | 0 |
| ② 重放 | replay（四仿真） | 300+416+250+400 | 6 s | 3.27 | 110 / 353 | 522 ms | 360 帧 1177 ms | 0 |
| ③ 烘焙 | baked | 300 球 | 6 s | 0.04 | 0.05 / 0.2 | 0.9 ms | 360 帧 14 ms | 846 KiB（烘焙耗时 40 ms） |

（"乱序 seek"在 physcheck 里是 0.1 s 间隔打乱，单次可能回退+重放至多 1 s；replay 四仿真里
流体占大头。顺序 ms/帧列来自整片逐帧顺序 seek。）

**整片渲染耗时**：上表是 seek 本身。完整渲染（截图 + 编码）由 film-motion 的 render.mjs 决定，
截图开销与物理策略无关，**本次未跑完整 render**。

规模外推（Node，纯仿真无绘制，`scripts/bench.mjs`，substeps=4，检查点 1 s）：

| 仿真 | n | ms/步 | 冷启动 seek 到 10 s / 60 s | 最坏乱序 seek | 烘焙 x,y（10 s / 60 s） |
|---|---|---|---|---|---|
| balls | 300 | 0.034 | 80 / 482 ms | 8 ms | 1.4 / 8.2 MiB |
| balls | 1000 | 0.087 | 208 / 1251 ms | 21 ms | 4.6 / 27.5 MiB |
| balls | 3000 | 0.42 | 1.0 / 6.1 s | 102 ms | 13.8 / 82.4 MiB |
| boids | 1000 | 0.34 | 0.8 / 4.9 s | 82 ms | 4.6 / 27.5 MiB |
| boids | 3000 | 2.19 | 5.3 / 31.6 s | 527 ms | 13.8 / 82.4 MiB |
| fluid | 300 | 0.89 | 2.1 / 12.9 s | 215 ms | 1.4 / 8.2 MiB |
| fluid | 1000 | 3.44 | 8.3 / 49.6 s | 826 ms | 4.6 / 27.5 MiB |
| cloth | 1014 点 | 0.15 | 0.36 / 2.1 s | 36 ms | 4.6 / 27.9 MiB |

完整表见 `tests/fixtures/_test-physics/out/bench.txt`。

## 4. 跨环境：Node 烘焙 vs 浏览器重放

```
$ node tests/fixtures/_test-physics/node-vs-browser.mjs
浏览器内重放 vs Node 烘焙（float32 舍入后逐位比）: {"frames":361,"mism":0}
```
Node 22 烘出的 balls 表与 Chromium 156 里跑同一份 sims.js 的结果，361 帧全部逐位一致。

## 5. 第三方库（`scripts/libprobe.mjs`，Node 同进程，80 盒落碗，dt=1/240，600 步）

```
  ✓ matter     Q1 两次全新重放一致
  ✓ matter     Q2 前缀一致
  – matter     Q3 快照/恢复  无官方快照 API → 只能从头重放或烘焙
             80 体 × 600 步 = 27 ms（0.045 ms/步）
  ✓ planck     Q1 两次全新重放一致
  ✗ planck     Q3 Serializer 存档→恢复→续跑 = 连续跑  最大位置偏差 3.14e+0 m（序列化丢接触缓存/warm-start）
             80 体 × 600 步 = 106 ms（0.177 ms/步）
  ✓ rapier2d   Q1 两次全新重放一致
  ✓ rapier2d   Q3 takeSnapshot→restore→续跑 = 连续跑  快照 70 KiB
             80 体 × 600 步 = 34 ms（0.056 ms/步）
```
版本：matter-js 0.20.0、planck 1.4.2、@dimforge/rapier2d-compat 0.14.0（已装进仓库根 package.json）。

## 6. 一维跟随链 `chain()`（回应 ghost-jam F-023）

**收进 skill 的理由**：ghost-jam 证明了"按五条约束写一个跟车仿真"不难，难的是**调参**——它扫了约 40 组 hc/w/a，
因为两种失败（撞车、根本不堵）都没有判据。下一个做交通/排队/链式传播的人会原样重扫一遍。
收进来的不是"一支片子的模型"，而是两个可计算的判据（κ、A*）+ 按物理量反解参数的 `chainDesign` + 50 ms 的无头试跑 `chainProbe`。
同时在 `references/chain.md` §1 写明了**不该用它**的情况（固定延迟逐个传 → 闭式 ①），免得它变成"一维的东西都套它"。

### 6.1 与 ghost-jam 的 sim.js 逐位一致

用 ghost-jam 的 RING 参数、它自己的扰动时刻（`vo.at('轻')` = 6.817 s）喂 `chain()`，与原 `films/ghost-jam/sim.js` 同步推 120 仿真秒：
```
tPerturb 6.817 120 s 仿真: 位置最大差 0 m 速度最大差 0 逐位不同的步数 0 / 28800
```
第一版不是 0（位置差 1.3e-11 m）：`init` 里无条件做了 `((x % L) + L) % L`，`(x + L) % L` 会引入舍入。改成只在越界时取模后逐位一致。
另一处差异是有意保留的：ghost-jam 用累加的 `s.t += dt` 判断扰动窗口，`chain` 用步号 × dt。扰动时刻取 5.0 s 时两者差一步
（位置最大差 0.18 m / 230 m，首停 28.01 vs 28.03 s）——累加浮点时间正是硬约束 2 要避免的写法。

### 6.2 ghost-jam 真实回归（scratchpad 拷贝，原片目录未动）

拷贝里把 `sim.js` 的 `ringSim` 换成 `chain()` 的薄包装，跑它自己的 `tools/simcheck.mjs`：14 条全过，数字与原片逐项相同
（W=5.26、黄车 #9、s6–end 灯团 −43.9 m / 9.5 s = **−16.6 km/h 逆车流**、最小净距 1.19 m）。
再给 scene.html 加 PHYS 声明跑 physcheck（`--t0 0 --t1 22 --step 0.5 --sub 4`）：B/C/D、E1–E4、F 三条全过，E 报告总跨度 43.2 仿真秒。
原片自身 physcheck（未改动）同样 B/C/D 全过，顺序 seek 18.9 ms/帧（含绘制，ghost-jam 的绘制占绝大部分）。

### 6.3 参数区间（`node tests/fixtures/_test-physics/chain-regimes.mjs` → `out/chain-regimes.txt`）

基准：环 n=22、L=230 m、vCruise 8.33 m/s、vFree 11.1 m/s，仿真 5 s 时 0 号 2 m/s²×1.2 s，dt=1/240 s，跑 180 s。
每组 chainProbe 45–62 ms（Node）。完整表在 `references/chain.md` §4，要点：
- κ = 0.9（a = 1.5/2/3，关/开安全项共 9 组）：180 s 内全部不成堵——"根本不堵"可预测。
- 关安全项时成堵时间是 efold 的 0.7–1.9 倍（25 组成堵样本；efold 越短越接近 1 倍。a=2：κ=1.3 → 61.3 s/36.6 s；κ=2 → 7.5/6.5 s；a=1：κ=2 → 23.3/12.9 s）。
- 开安全项（onset 0）时 30 组最小净距最低 1.15 m，从不撞；但 a=1 时 κ=2、3 都不堵，κ=4 才堵（成堵 9.5 s，堵速 −17.4 km/h）。
- 撞车边界：4 种几何（含 ×100 像素单位）× a ∈ {0.8,1,1.5,2,3} × κ ∈ {2,3} 共 40 组纯 OVM，
  **撞的 A* 最大 1.14，不撞的 A* 最小 1.38**。像素单位与米制同参数的成堵时间到 0.1 s 全部相同（缩放不变性）。
- `chainDesign` 对不可达的 κ 抛错并给下限（a=1 时 κ ≥ 1.25）。
- 排队起步（默认参数，12 辆）：变绿后每辆比前车晚 1.15 s 起步（第一辆 0.97 s），最小净距 0.50 m = stopGap。

### 6.4 确定性与反例（physcheck，`--t0 0 --t1 8 --step 0.1`，81 帧）

| 入口 | physcheck | 红在哪 | seamcheck |
|---|---|---|---|
| `chain` | exit 0 | — | exit 0 |
| `chain-crash` | exit 1 | F "不撞" 390/481 帧，首个为假 t=6.500 净距 −0.038 m | **exit 0**（确定性的错，seamcheck 看不见） |
| `chain-nojam` | exit 1 | F "6.0 s 后有车停过" 0/118 | **exit 0** |
| `chain-leak-ref` | exit 1 | B 0/81、C 0/81 | exit 1 |
| `chain-leak-flag` | exit 1 | B 55/81（首个 t=1.900 = 仿真 2.14 s，扰动刚开始）、C 77/81、F 0/118 | exit 1 |

### 6.5 性能

Node（`bench.mjs --sim chain`，fps 60 × substeps 4，检查点 1 s；原始输出 `out/bench-chain.txt`）：

| n | ms/步 | 冷启动 seek 到 10 s / 60 s | 最坏乱序 seek | 检查点 KiB/个 | 检查点总计（60 s） |
|---|---|---|---|---|---|
| 22 | 0.0099 | 24 / 142 ms | 2.4 ms | 0.7 | 0.04 MiB |
| 300 | 0.033 | 79 / 474 ms | 7.9 ms | 9.7 | 0.58 MiB |
| 1000 | 0.053 | 127 / 763 ms | 12.7 ms | 32.3 | 1.92 MiB |
| 3000 | 0.17 | 0.40 / 2.4 s | 39.9 ms | 96.7 | 5.76 MiB |

n=22 那一行被 JIT 预热主导（bench 只跑 2 s = 480 步取平均）；浏览器里 22 单元冷启动 seek(8)（7625 步，含绘制）10.9 ms，
即 ≤ 1.4 µs/步。同一口径的 balls n=300：0.032 ms/步、检查点 9.4 KiB/个。

浏览器（physcheck，`chain.html`，含绘制）：顺序 0.17 ms/帧，乱序均值 1.32 / 最大 6.1 ms，冷启动 seek(8) 10.9 ms，整片 480 帧顺序 9 ms。

## 7. 时间映射 `timemap.js` + physcheck E/F（回应 ghost-jam F-024）

数值：`timeMap` 与细步长（1e-4 s）数值积分倍率的最大差 2.6e-9 s；`S.inv(S(t))` 往返最大误差 7.1e-15 s；
`fitRate` 在 1×→W×→1× 映射上反解 S(12.5)=40 得 W=5.656。

**先写会红的版本**（physcheck `--t0 0 --t1 8 --step 0.1`）：

| 入口 | 写错了什么 | physcheck | 红在哪 | seamcheck |
|---|---|---|---|---|
| `warp-accum` | seek 里 `simT += rate·Δt` | exit 1 | B 0/81、C 0/81、D、E4 81 帧不符 | exit 1 |
| `warp-inverted` | `stateAt(S.inv(t))` | exit 1 | **只有 E4**：65/81 帧不符，首个 t=1.600（S 开始偏离恒等之后） | **exit 0** |
| `warp-coarse` | 0.25× 慢镜头，查询栅格 60/s，影片 60 fps | exit 1 | **只有 E3**：337 对相邻帧同步，提示查询栅格 ≥ 240/仿真秒 | **exit 0** |
| `warp-slowmo` | 修好：fps 240 × substeps 1（dt 仍 1/240） | exit 0 | — | exit 0 |
| `chain` | 正确 | exit 0 | E1–E4 全过 | exit 0 |

真实片回归：ghost-jam 拷贝 `ghost-jam-nomap` 把 `REPLAY.stateAt(simT)` 改成 `stateAt(t)`：
```
  ✓ B 乱序 vs 顺序: 45/45 帧一致
  ✓ C 倒序 vs 顺序: 45/45 帧一致
    ✗ E4 [ring] seek(t) 喂给 stateAt 的步号 = stepsAt(S(t))（45 帧）：27 帧不符，首个 t=9.000 …
  ✓ D 冷启动直接 seek(22) vs 顺序
    ✓ 不撞：最小净距 > 0.3 m  [0.00–23.59s all]  708/708 帧为真
    ✓ s5@逼 之前没有车停 …  ✓ s5@停 之后至少一辆停过 …
```
F 三条在这个错的版本上**全绿**——断言自己调了正确的 `stateAt(TL.S(t))`，验的是声明而不是画面。
这就是 `references/timemap.md` §6 要求 seek 与断言共用同一个 `at(t)`、并且必须有 E4 的原因。

## 8. 既有验收不退化

改动后重跑第 1、2 节全部入口，physcheck 与 seamcheck 的判定行与改动前逐行相同（closed / closed-20k / replay / replay-balls / baked 过，
三个 leak 红）；`node-vs-browser.mjs` 仍 `{"frames":361,"mism":0}`。E/F 两组只在场景声明 `window.PHYS.timeMap` / `claims` 时运行，
老入口的输出没有多出任何行。`node skills/selfcheck.mjs` exit 0。

## 没测到 / 没解决

- **浏览器内的第三方库**：本次只在 Node 测。旧 motion-libraries skill 记过 matter / rapier 在 Chromium
  里乱序 seek 通过（从 0 重积分、rapier 快照），planck 浏览器内未测。
- **跨机器确定性**：自写仿真、rapier（需 `-deterministic` 包）都未测。
- **GPU 物理**（变换反馈 / 浮点纹理）：未实现未测。软件渲染下预期不占优。
- **完整 render.mjs 渲染耗时**：未跑。
- planck 的 Q3 失败也可能部分源于 body 顺序映射（fromJson 后用 body list 反序对应）；结论"不能当检查点用"
  不受影响，但 3.14 m 这个数不要当作 Serializer 精度的度量。
- 分段烘焙（只重烘改动段）、可变发射率、大角度摆、斜面弹跳：未实现。
- `chain` 撞车边界 A* 在 1.15–1.38 之间没有样本；只测了 κ=2、3 和单次 2 m/s²×1.2 s 扰动，更猛的扰动（急刹到 0）可能把边界右移。
  安全项开着时的成堵门槛只有基准几何上的表，没有理论，也没在其它几何上复测。
- `chain` 只测了 OVM 一种跟随律；IDM 没有收（ghost-jam 实测它在环上"太稳根本不堵"，没有在本 skill 里复测这个结论）。
- 时间映射下的运动模糊：子帧也走 S，模糊长度随倍率变；"模糊与倍率无关"的映射没实现。没有渲成片看过 5× 段的模糊效果。
- E4 假设一帧只对每个 replay 调一次 `stateAt`；拖尾回采等多次调用会误报，没有做区分。
- F 断言是逐帧 seek 再调 test，ghost-jam 23.6 s × 30 fps 要再走一遍整片 seek（约 15 s）；更长的片子要用 `--step` 之外的抽样，本次没做。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

skill 里只留结论、判据和代价数字；下面是原来写在 SKILL.md / references 里的来历与反例叙事。
`references/strategies.md` 原 §5"实测数字"表与本文件 §3、§6.5 重复，已删，数字以本文件为准。

**chain 参数为什么要两个无量纲数（原 chain.md §2–§5）**
- 模型是 Bando 1995 的 OVM，Sugiyama 2008 环形实验论文用的同一类。`hc`、`w` 没有直接物理含义，ghost-jam 扫了约 40 组就是在扫它们。
- ghost-jam 的 a=1、h0=10.45、hs=4.3、v0=8.24 给出 A* = 0.75——纯 OVM 必撞，它实测的"最小净距 −2.9 m"就是这条；
  "κ 明明 > 1 却不堵"是安全项开着把门槛推高了——这是 ghost-jam 扫参的另一半原因。默认 `chain()` 就是 ghost-jam 实测组。
- κ < 1 的"180 s 内从不成堵"来自 a = 1.5/2/3 × κ = 0.9 的 9 组；成堵 ≈ 0.7–2 × efold 来自 25 组成堵样本（a=2：κ=1.3 → 61 s / efold 37 s；κ=2 → 7.5 / 6.5 s）。
- A* 边界的 40 组：n=15/22/40，h0 = 10–15 m，vCruise = 5–12 m/s，外加像素单位，κ = 2/3（§6.3）。

**时间映射反解与第四种写错法（原 timemap.md §3、§5）**
- ghost-jam 没踩到"仿真参数写成影片时间"，是因为它的扰动发生在加速开始之前（S(t) = t 那一段）。
- ghost-jam 还用了一个更强的性质：扰动前系统严格均匀、时不变，"扰动后多久停车"与扰动时刻无关，所以能闭式反解倍率；
  一般情况用 `fitRate` 二分即可。它选 ② 不选 ③，是因为旁白重录后 W 在加载时重算即可，③ 每次重录要重烘。
- "传反/忘了映射"在真实片上的反例：ghost-jam 回归副本把 `stateAt(simT)` 改成 `stateAt(t)`（§7 `ghost-jam-nomap`）。
- E3 默认阈值 0.2 的理由：定格斜坡尾巴上倍率趋于 0，任何有限栅格都会出现同步帧，而那里每帧运动不到正常的 1/5。

**"验证路径必须就是被验证的路径"的三个实测反例（原 timemap.md §8）**
- film-physics：`warp-inverted` 和 ghost-jam 回归副本里，seek 画的是 `stateAt(t)`，断言调的是正确的 `stateAt(S(t))` →
  F 三条全绿，画面在错的时刻；确定性闸门也抓不到，每个 t 都稳定地对应了错的帧。
- film-critique：probe 按"亮度 > 0.5 才算一盏灯"报 0 盏，绘制从亮度 0.01 起就画，画面上有 140 个饱和红像素。
- 量相机是否静止时，拿一个本身处在运动段里的帧当参照，"静止"量成了"一直在动"。

**一次性事件放闭包的反例（原 strategies.md §3）**：`chain-leak-flag.html` 乱序 55/81 帧一致，首个不一致在影片 1.9 s
（仿真 2.14 s，扰动刚开始）；冷启动先跑过扰动之后，整片顺序重扫里扰动不再发生（F "有车停过" 0/118 帧为真）。
