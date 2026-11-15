# 第三方物理库：定步改造与实测确定性

什么时候用库：需要多边形刚体、关节、摩擦、堆叠稳定性时。只有圆、点、距离约束、群集、流体近似时，自己写（`effects.md`）更省：零依赖、Node 与浏览器逐位一致（圆形刚体已测）、可以直接 `bake.mjs` 预烘焙。

复测命令（升级库之后跑；开发工具不随安装）：仓库里 `node dev/film-physics/libprobe.mjs`。内容是 80 个盒子落进 V 形碗，dt=1/240，600 步，Node 22 同一进程内逐位比较所有物体的 (x, y, angle)。

| 库 / 版本 | 协议 | 两次全新重放逐位一致 | 从检查点续跑 = 连续跑 | 80 体每步耗时 |
|---|---|---|---|---|
| matter-js 0.20.0 | MIT | ✓ | 没有快照 API | 0.045 ms |
| planck 1.4.2 | MIT | ✓ | ✗ 经 `Serializer.toJson/fromJson` 恢复后续跑偏差达 3.14 m | 0.177 ms |
| @dimforge/rapier2d-compat 0.14.0 | Apache-2.0 | ✓ | ✓ `takeSnapshot/restoreSnapshot`，快照 70 KiB | 0.056 ms |

本次没有在浏览器内复测。旧调研记录：matter、rapier、cannon-es 在 Chromium 内乱序 seek 都能通过；从 0 重新积分一个 10 s 场景，matter 29 ms、rapier 26 ms、cannon 509 ms；rapier 恢复快照最慢 6 ms。

## 通用改造

1. 不启动任何自带循环（matter 的 `Runner`/`Render`、cannon 的 `fixedStep`、任何 demo/testbed）。
2. 按 `createReplay` 的接口封装：`init` 建 world 并返回 `{world, bodies}`，`step` 调一次固定步长推进，`clone` 做快照（做不了见下）。
3. 步数 `n = round(t·fps)·substeps`，dt 写死，不随帧率变。迭代次数（速度/位置迭代）也写死。
4. 库里用了 `Math.random` 时（matter 的 `Common.random` 是自带种子的 LCG，确定；部分插件不是），在构造和 step 前后把 `Math.random` 临时换成 film-core rand.js 的 `seeded(种子)`，结束再换回。注意这是一个顺序随机源：它的状态必须随检查点一起保存/恢复，否则回退后随机序列对不上——做不到就别做检查点，从头重放。
5. 碰撞事件从库的回调里收集时，写进 state（或从 world 状态派生），不要写进闭包数组。

## matter-js

```js
const engine = Matter.Engine.create();           // 不建 Runner、不建 Render
Matter.Engine.update(engine, 1000 / 240);        // 参数是毫秒
```
- 没有快照：Engine 内部有 pairs 表、接触的 warm-start 冲量、sleeping 计时器和 `timing.timestamp`，手写 clone 很难复制完整。
- 只能自己写一个单调前进的 `stateAt`：`if (n < curN) { engine = build(); curN = 0 }`，再推进到 n。顺序渲染快，任何回退都付 O(t)；要乱序也快就改走 ③ 预烘焙。（这种写法没单独实测。）

## planck.js

```js
const world = new planck.World({ gravity: planck.Vec2(0, -10) });
world.step(1 / 240, 8, 3);                       // 速度/位置迭代次数固定
```
- 重放确定，但 Serializer 不能当检查点（丢接触缓存，续跑分叉）。处理同 matter：从头重放或预烘焙。每步约为 matter 的 4 倍。

## rapier2d（wasm）

```js
await RAPIER.init();                              // 放进 window.ready
const world = new RAPIER.World({ x: 0, y: -10 }); world.timestep = 1 / 240;
world.step();
const snap = world.takeSnapshot();                // Uint8Array
const w2 = RAPIER.World.restoreSnapshot(snap);    // handle 不变，用 getRigidBody(handle) 取回体
```
- 唯一能做真检查点的现成引擎：`clone` 用 takeSnapshot 实现，恢复后续跑与连续跑逐位一致。旧 world 必须 `free()`，否则 wasm 内存泄漏（seek 多了 OOM）。
- 跨机器：官方对 `-compat` 包只承诺同平台一致；要跨平台一致用 `@dimforge/rapier2d-deterministic-compat`。**没测过。**
- 库文件（含 .wasm）随片打包，来源与授权归 film-assets。运行时从 CDN 拉的代价是渲染依赖网络、版本可能漂移，确定性门复现不了。

## cannon-es（3D）

旧调研：只调 `world.step(dt)`，不传第二个参数，也不用 `fixedStep()`；本次没复测。三维场景的绘制归 film-webfx。
