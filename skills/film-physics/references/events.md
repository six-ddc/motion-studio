# 冲击手感与镜头：`feel.js` + `closed.js` 的游戏化反馈

目录：1 游戏里的配方数值与代价 · 2 影片时间与世界时间 · 3 手感与相机 · 4 局部验证

事件表本身（`eventTrack` `channel` 响应核、`throttle` `burstEnds` `snapToFrames`、`toCues`）在 film-core `runtime/events.js`，
文档是 film-core `references/events.md`。片子里照旧 `import './runtime/events.js'`（挂载表扁平解析，`feel.js` 也这样 import 它）。

## 1. 游戏里的配方数值与代价

下面是游戏拆解里的数，**不是本片的默认手感**；运行时都要求显式给（`traumaShake` 的 power、`hitstopOf` 的 dur、`shakeTermsFromSeed` 的 avoid）。

| 事件 → 通道 | 常见数值 | 代价 / 什么时候改 |
|---|---|---|
| 冲击 → 动态光、闪白 | 50 ms 线性或平方根熄灭 | 短于 2 帧会落在帧之间：配 `snapToFrames` + `holdFrames(k,{minFrames:2})`，手感因此变长变软；要"脆"就宁可接受偶尔只亮 1 帧 |
| 冲击 → 后坐 | 35% 永久、65% 可恢复（`recoil` keep=0.35） | 永久部分会累积改变构图，连射 20 发就偏出画；叙事镜头要回正就把 keep 设 0 |
| 冲击 → 屏震 | 创伤值平方（power=2）× 多正弦 | 小事件被压到几乎看不见、大事件才显著；要每次都看得见用 power=1，代价是满值时不再"爆" |
| 冲击 → 顿帧 | 30–100 ms（`hitstop` 缺省 0.06） | 越长打击越重、越拖节奏；连击时冻结段合并（见 §2），总冻结时长 ≠ 次数 × dur |
| 冲击 → 闪白 | `closed.flash` 缺省 0.12 s | 越长越糊，连击时闪成一片 |
| 一串冲击结束 → 空间尾音 | 相邻间隔判串 | 完整事件表已知才能离线判；画面和声音要用同一个 gap（`toCues({tails})`） |
| 落地 → 弹簧下沉 | 欠阻尼回弹 | 输出限幅 ≠ 真撞到限位后的非线性运动（那要定步重放） |
| 屏震频率 | 两正弦避开 1:1、1:2 | 比值≈1 拍频成慢摆、≈小整数周期性同步；这是口味，`avoid` 参数里写，不给就不避 |

`closed.js` 里 `hitShake`（amp 20、decay 12、freq 30）、`squash`（k 600、c 18）的缺省是旧接口保留的起点，代价同上：按本片改。

## 2. 影片时间与世界时间

顿帧把"世界"（物理、粒子运动、动画曲线）停住，反馈本身不停：

| 读影片时间 t | 读世界时间 `tw = hitstopOf(hits,{dur})(t)` |
|---|---|
| 闪白、屏震（`traumaShake`、`hitShake`）、后坐、声音 cue、字幕 | 弹道、粒子位置、`springDip` 之类"物体在动"的量、角色动画 |

`hitstop(t, hits, dur)` / `hitstopOf(hits, {dur})`：冻结区间 `[h, h+dur]` **取并集**，`tw` 单调不减。
以前逐个相减，重叠时世界时间倒退（命中 1.00/1.03、dur .06：t 1.03→1.05 映到 1.000→0.980）；现在平在 1.000。互不重叠时与旧版逐位相同。
`hitstopOf` 加载期预计算（O(log n)），dur 可以是 `(e)=>秒`；`tw.inv(w)` 反查第一个影片时刻；`tw.intervals` 是并集。
命中时刻本身是影片时间；若命中由物理推出（世界时间），先在世界时间里算出命中，再用 `tw.inv` 换成影片时间。

## 3. 手感与相机：`runtime/feel.js`

| API | 输出与代价 |
|---|---|
| `shakeTermsFromSeed(seed,{band,second,avoid?})` | 各轴两个 `[Hz,权重,相位]`。`avoid:{ratios:[1,2],tol:.1}`：max/min 比值落在 ratios±tol 就按 hash 确定性重抽（最多 tries=32，抽不到报错）；不给就不避 |
| `traumaShake(t,trauma,{amp,terms,power})` | pitch/yaw/roll；power 必填；不同于每次冲击独立包络、越叠越大的 `hitShake` |
| `recoil(track,{on,amount,keep,rise,hold,fall,min?,max?})(t)` | `{permanent,visual,target,total}`，每发重置保持时间（piecewise 精确） |
| `springDip(track,{on,impulse,k,c 或 stiffness,damping,min?,max?,eps?})(t)` | 单位速度冲量 × impulse 求和（film-core `springKick`），再对输出限幅 |
| `arcTable / arcFromSamples / stepPhase / stepBob` | 弧长表 → 步相位（停顿吸附整步）→ 步态晃动 |
| `lagOffset(t,pos,{k,c,span,steps})` | 父物体加速度与弹簧核卷积；Simpson O(steps)/轴，离散冲量改用 channel 更省 |
| `drift / driftTerms` | 多正弦漂移及其加载期参数表 |
| `cruise(u,soft,ease?)` | 匀速与缓动混合；ease 缺省 smoothstep（两端速度 0、中段 1.5 倍），代价是起停对称 |
| `approach(track,{on,init,target,rate})` | 状态事件改目标，指数逼近 |
| `perturbShot(shot,{pitch,yaw,roll,offset})` | camrig 的新 shot 数据，注视距离不变 |

三维：`applyShot(S.camera,perturbShot(baseShot,shake),…)`（film-webfx）。二维：yaw/pitch 当像素位移加到 film-core `camera()`，roll 加到旋转。

## 4. 局部验证

`_test-events` 同时驱动闪白、屏震、粒子、弹簧、贴花，帧率读 `window.FILM.fps`。
`node tests/fixtures/_test-events/tests/unit.mjs` 72 项数值断言（参照都是独立实现：RK4、定步、整数节拍冷却计时器、暴力约束枚举）；
`tests/browser.mjs` 在 24/30/60 fps 下各开一次；`bad-accum.html` 跨帧累加创伤值，乱序门报"结果依赖求值顺序"。
