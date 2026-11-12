# 事件编排与镜头手感

目录：1 方法与取舍 · 2 事件表与通道 · 3 响应核 · 4 加载期规则 · 5 手感与相机 · 6 验证

## 1. 用一张事件表驱动多个通道

把事件时刻当真相源，把每个响应写成自事件起的年龄 `τ=t−e.t` 的函数。
光、位移、粒子和声音共用事件 ID 与时刻，各通道的时间常数分别决定冲量和余韵。
相同输入可以任意跳帧；代价是不能直接照搬游戏每帧累加的状态。

以下是游戏拆解里的可选配方数值，不是本片的默认手感：

| 事件 | 通道 | 时间尺度与代价 |
|---|---|---|
| 冲击 | 动态光、闪白 | 50 ms 线性或平方根熄灭；短闪可能落在两帧之间 |
| 冲击 | 相机/物体后坐 | 35% 永久、65% 可恢复，快起慢收；永久偏移会改变构图 |
| 冲击 | 屏震 | 创伤值平方 × 多正弦；小事件被压低，大事件更显著 |
| 一串冲击结束 | 空间尾音 | 相邻间隔判定串的结束；完整事件表已知时可离线决定 |
| 落地 | 弹簧下沉 | 欠阻尼回弹；输出限幅不等于真实碰到限位后的非线性运动 |

## 2. 事件表与通道

```js
import { eventTrack, channel, flashDecay, toCues } from './runtime/events.js';
const hits = eventTrack([{ t: 1.2, type: 'hit', id: 'impact-a', power: .7 }]);
const light = channel(hits, {
 name: 'light', on: 'hit', support: .05,
 response: (age, e, rnd) => e.power * flashDecay(.05)(age) * (.9 + .1 * rnd(0)),
 combine: 'max', seed: 5,
});
// seek(t) 里全量写入：lamp.intensity = light(t)
const cues = toCues(hits, { hit: { type: 'thump', gain: e => e.power } });
```

加载期稳定排序并补 ID；显式 ID 在插入同类型事件后仍能保持随机数不变。
`keyOf(id)` 为整数哈希，`rnd(k)=hash01(seed,e.key,keyOf(name),k)`，调用顺序不影响随机值。
把表和事件字段当常量；嵌套对象、公开索引数组不做深冻结，修改会破坏查询一致性。

| API | 语义/代价 |
|---|---|
| `eventTrack(events)` | `{t,type,id?,...}` 数组 → 排序并按类型建索引；同刻保留原表顺序 |
| `track.before(t,type?) / count / last / next` | 事件当刻计入；`next` 严格晚于 t；count/last/next 二分 O(log n) |
| `track.window(t,span,type?) / of(type) / only(on)` | 时间窗 `(t−span,t]`；取类型表；过滤成新表并保留 ID |
| `merge(...tracks)` | 合并，ID 冲突报错 |
| `channel(track,{name,on,response,support,lead,combine,seed})` | `on` 为类型/数组/谓词；support 秒或 `(e)=>秒`；lead 允许预备动作 |
| `ch(t) / ch.active(t)` | 求标量；或枚举 `{e,tau,rnd}` 画每次爆发；O(log n+窗口内事件数) |
| `combine` | `sum/max/last`，或 `{init,add,done?}`；无活动事件的 max/last 为 0 |

无限 support 会把求值成本变成 O(n)。累积量可换成下面的事件间闭式流。

## 3. 响应核

核返回函数，并附 `.support` 和 `.lead`。将核直接作为 response，或包一层后显式给 support。

| 工厂 | 公式与参数（秒/1秒） |
|---|---|
| `flashDecay(dur)` | `max(0,1−τ/dur)`，τ<0 为0 |
| `sqrtFade(dur)` | `sqrt(max(0,1−τ/dur))`，尾部熄灭更突然 |
| `expDecay(rate,{eps?})` | `exp(−rate·τ)`；support=`ln(1/eps)/rate` |
| `gaussPulse({at,width})` | `exp(−.5((τ−at)/width)^2)`，截在4倍宽度，可在事件前出现 |
| `springKick({k,c}或{omega,zeta},{eps?})` | 解 `x''+cx'+kx=0,x(0)=0,x'(0)=1`，含三种阻尼；`.velocity(τ)` 读速度 |
| `riseHoldFall({rise,hold,fall},{eps?})` | 目标保持后指数回落，输出一阶跟随；rise/fall 为时间常数 |
| `holdFrames(kernel,{fps,minFrames})` | 把短核拉长至 N/fps；会改变手感，核本身若起点为0，不承诺每帧都有亮度 |

欠阻尼冲量为 `exp(−ζωτ)sin(ω√(1−ζ²)τ)/(ω√(1−ζ²))`；临界为 `τ exp(−ωτ)`。
线性通道可叠加；每发重置保持计时器应使用 `recoil`，不能把几个独立保持核相加当成同一运动。

## 4. 加载期规则与有记忆的量

`throttle(track,{on,minGap,maxPerWindow:{n,span},priority})` 选出实际触发事件，`.dropped` 留下丢弃项。
无 priority 时按时间贪心；有 priority 时后来的重要事件可能抢掉先前事件，代价是非因果。
`burstEnds(track,{on,gap,delay,type})` 在每串最后一发后 delay 秒派生一个事件。
`snapToFrames(track,fps,{mode:'round'|'ceil',minFrames})` 移动时刻并保存 `t0`；最短可见还要配 `holdFrames`。
round 最多移动半帧，ceil 最多一帧；声音也读对齐后的表才能对点。子帧采样会改变闪光平均亮度。

`trauma(track,t,{on,add,decay,max})` 单遍求值；`traumaOf(track,opts)` 预计算后 O(log n)。
每事件 +add，事件间每秒减 decay，到0为止，事件处封顶 max。
`piecewise(track,{on,init,jump,flow,value})` 把事件后状态缓存起来，二分后只计算最近一段闭式流。
jump/flow 返回新值；第一个事件前返回 init（所以 init 应是静止态）。状态间没有闭式时改用定步重放。
`countRing(track,t,{on,size,fade})` 按此前事件数量保留最近 size 个，返回 `{e,rank,alpha}`；适合贴花/脚印。
`toCues(track,mapping)` 只产音频数据，mapping 未覆盖的类型报错，写 null 可静音。
`toSceneEvents(track,{kind,v,anchor,on})` 生成给 `window.events()` 的 `{t,kind,v?,anchor?}` 数据。

## 5. 手感与相机：`runtime/feel.js`

| API | 输出与代价 |
|---|---|
| `shakeTermsFromSeed(seed,{band,second})` | 各轴两个 `[Hz,权重,相位]`，用于可复现的多正弦 |
| `traumaShake(t,trauma,{amp,terms,power})` | pitch/yaw/roll；振幅随创伤值取幂；不同于每次冲击独立包络的 `hitShake` |
| `recoil(track,{on,amount,keep,rise,hold,fall,min?,max?})(t)` | `{permanent,visual,target,total}`，每发重置保持时间 |
| `springDip(track,{on,impulse,k,c,min?,max?,eps?})(t)` | 单位速度冲量 × impulse 求和，再对输出限幅 |
| `arcTable(pos,{t0,t1,n}) / arcFromSamples(points,times?)` | 加载期弧长表，返回 `.s(t)`；采样越稀，弧长越短 |
| `stepPhase(t,{arc,stride,stops,snapRate}) / stepBob(h,opts)` | 弧长/步幅 → 步相位；停顿吸附整数步；opts 为 vertical/horizontal/roll/accent |
| `lagOffset(t,pos,{k,c,span,steps})` | 父物体加速度与弹簧核卷积；Simpson 近似 O(steps)/轴，离散冲量改用 channel 更省 |
| `drift(t,terms) / driftTerms(seed,n,{amp,band,falloff})` | 多正弦漂移及其加载期参数表 |
| `cruise(u,soft,ease?) / approach(track,{on,init,target,rate})` | 线性与缓动混合；状态目标的指数逼近 |
| `perturbShot(shot,{pitch,yaw,roll,offset})` | 返回 camrig 的新 shot 数据，角度为弧度，offset 为世界位移 |

三维：`applyShot(S.camera,perturbShot(baseShot,shake),{width:S.width,height:S.height})`；`applyShot` 来自 film-webfx，参见其相机文档。
二维：把 yaw/pitch 作为像素位移加到 film-core `camera()` 的 x/y，把 roll 加到旋转，单位由片子确定。

## 6. 局部验证

本仓库样例 `_test-events` 同时驱动闪白、屏震、粒子、弹簧、贴花，未制作完整成片。
`node tests/fixtures/_test-events/tests/unit.mjs` 验证32项数值与乱序求值；seamcheck 的并行门覆盖180帧。
`bad-accum.html` 只在顺序前进时累积创伤值，同刻重算不变，乱序门会报“结果依赖求值顺序”。
