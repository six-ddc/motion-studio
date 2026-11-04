# 第三方物理库：seek 化改造与实测确定性

复测命令（升级库之后运行；开发工具不随安装分发）：在仓库里运行 `node dev/film-physics/libprobe.mjs`。测试内容是 80 个盒子落进 V 形碗，dt=1/240，跑 600 步，在 Node 22 的同一进程内逐位比较所有物体的 (x, y, angle)。

| 库 / 版本 | 协议 | Q1 两次全新重放逐位一致 | Q3 从检查点续跑与连续跑一致 | 80 个物体每步耗时 |
|---|---|---|---|---|
| matter-js 0.20.0 | MIT | ✓ | 没有快照 API（无法测试） | 0.045 ms |
| planck 1.4.2 | MIT | ✓ | ✗ 经 `Serializer.toJson/fromJson` 恢复后续跑，偏差达 3.14 m | 0.177 ms |
| @dimforge/rapier2d-compat 0.14.0 | Apache-2.0 | ✓ | ✓ 用 `takeSnapshot/restoreSnapshot`，快照大小 70 KiB | 0.056 ms |

本次没有在浏览器内复测。旧的调研记录显示，matter、rapier、cannon-es 在 Chromium 内乱序 seek 都能通过：从 0 开始重新积分一个 10 s 的场景，matter 用时 29 ms，rapier 26 ms，cannon 509 ms；rapier 恢复快照最慢 6 ms。

## 通用改造

1. 不启动任何自带的循环（matter 的 `Runner`/`Render`、cannon 的 `fixedStep`，以及任何 demo/testbed）。
2. 按 `createReplay` 的接口封装：`init` 建立 world 并返回 `{world, bodies}`，`step` 调用一次固定步长的推进。
3. 步数取 `n = round(t·fps)·substeps`，dt 写死，不随帧率变化。
4. 如果库里用了 `Math.random`（matter 的 `Common.random` 是自带种子的 LCG，结果确定；但部分插件不是），就用 `withSeed` 包住构造和 step 过程：在构造和 step 之前把 `Math.random` 换成 rand.js 的 `seeded(种子)`，结束后再换回来。

## matter-js

```js
const engine = Matter.Engine.create();           // 不建 Runner、不建 Render
Matter.Engine.update(engine, 1000 / 240);        // 参数是毫秒
```
- 没有快照能力：Engine 内部有 pairs 表、接触的 warm-start 冲量、sleeping 计时器和 `timing.timestamp`，手写 clone 很难复制完整。
- `createReplay` 需要 `clone`，而 matter 提供不了。只能自己写一个单调前进缓存的 `stateAt`：`if (n < curN) { engine = build(); curN = 0 }`，再推进到 n。这样顺序渲染很快，但任何回退都要付出 O(t) 的代价；需要乱序也快，就改用策略 ③ 预烘焙。（这种写法没有单独实测过。）

## planck.js

```js
const world = new planck.World({ gravity: planck.Vec2(0, -10) });
world.step(1 / 240, 8, 3);                       // 速度/位置迭代次数也固定
```
- 重放结果是确定的，但 Serializer 不能当作检查点使用（它会丢掉接触缓存，续跑后结果分叉）。处理方式和 matter 一样：从头重放，或者预烘焙。每步耗时约为 matter 的 4 倍。

## rapier2d（wasm）

```js
await RAPIER.init();                              // 放进 window.ready
const world = new RAPIER.World({ x: 0, y: -10 }); world.timestep = 1 / 240;
world.step();
const snap = world.takeSnapshot();                // Uint8Array
const w2 = RAPIER.World.restoreSnapshot(snap);    // 句柄（handle）保持不变，用 getRigidBody(handle) 取回体
```
- 它是唯一能做真正检查点的现成引擎：`clone(state)` 就用 takeSnapshot 实现，恢复后续跑的结果与连续跑逐位一致。旧的 world 必须调用 `free()` 释放，否则 wasm 内存会泄漏（seek 次数多了会 OOM）。
- 跨机器：官方对 `-compat` 包只承诺同平台下结果一致；需要跨平台一致时用 `@dimforge/rapier2d-deterministic-compat`。**这一点没有测过。**

## 库 vs runtime/sims.js

- 需要多边形刚体、关节、摩擦或堆叠稳定性时，用第三方库（其中能做检查点的只有 rapier）。
- 只需要圆、点、约束、群集或流体近似时，`sims.js` 就够用：它在 Node 和浏览器中逐位一致（已测），而且可以直接预烘焙。
- cannon-es（3D）：旧调研的结论是只调用 `world.step(dt)`，不传第二个参数，也不用 `fixedStep()`；本次没有复测。
