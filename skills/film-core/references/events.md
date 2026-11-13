# 事件表：画面与声音共用的时间真相源（`runtime/events.js`）

目录：1 方法与取舍 · 2 事件表与通道 · 3 响应核 · 4 加载期规则与有记忆的量 · 5 给声音的桥 · 6 帧率

可选能力，不是内核契约。镜头手感、后坐、屏震、顿帧在 film-physics `references/events.md`（`feel.js`、`closed.js`）。

## 1. 方法与取舍

把事件时刻当真相源，把每个响应写成自事件起的年龄 `τ=t−e.t` 的函数。
光、位移、粒子和声音共用事件 id 与时刻，各通道的时间常数分别决定冲量和余韵。
相同输入可以任意跳帧；代价是不能直接照搬游戏每帧累加的状态（节流、帧对齐、连射收尾在加载期对整张表做一次）。
运行时没有任何幅度、时长的默认值；数字都是本片的选择。

## 2. 事件表与通道

```js
import { eventTrack, channel, flashDecay, toCues } from './runtime/events.js';
const hits = eventTrack([{ t: 1.2, type: 'hit', id: 'impact-a', power: .7 }]);
const light = channel(hits, { name: 'light', on: 'hit', response: flashDecay(.05), combine: 'max', seed: 5 });
// seek(t) 里全量写入：lamp.intensity = light(t)
```

| API | 语义/代价 |
|---|---|
| `eventTrack(events)` | `{t,type,id?,...}` → 稳定排序、补 id、按类型建索引；同刻保留原表顺序；事件对象浅冻结 |
| `track.before / count / last / next / window / of / only` | 事件当刻计入；`next` 严格晚于 t；`window` 是 `(t−span,t]`；二分 O(log n)；`only` 保留 id |
| `merge(...tracks)` | 合并，id 冲突报错 |
| `channel(track,{name,on,response,support,lead,combine,seed})` | `ch(t)` 标量；`ch.active(t)` 枚举 `{e,tau,rnd}`；O(log n+窗口内事件数) |
| `combine` | `sum` 线性叠加 / `max` 不叠爆 / `last` 只看一个：**已发生（τ≥0）且活着的最近一个优先**，都没发生才取下一个事件的预备段（lead）/ `{init,add,done?}` |

**id**：显式 id 原样；缺省 `${type}:${同类型原表序号}`。缺省的代价：在同类型事件**中间插入**一个，后面同类的 id 全部后移，
它们的随机数（`rnd(k)=hash01(seed,e.key,keyOf(name),k)`）和声音变体跟着变。要插入后不变就写显式 id。
support 为 Infinity（如 ζ=0 的 `springKick`）时每次求值扫"之前全部"，O(n)；累积量改用 `piecewise`。

## 3. 响应核

核是函数，附 `.support`（之后恒为 0）和 `.lead`（之前多久开始）。

| 工厂 | 公式与参数（秒/1秒） |
|---|---|
| `flashDecay(dur)` / `sqrtFade(dur)` | `1−τ/dur` / `√(1−τ/dur)`；film-physics `closed.js flash()` 委托前者 |
| `expDecay(rate,{eps?})` | `exp(−rate·τ)`，support=`ln(1/eps)/rate`（eps 是截断阈值，技术量） |
| `gaussPulse({at,width})` | 截在 ±4 width；at 可为负（峰值在事件前），但 `at+4·width ≤ 0` 报错（整段都在事件前） |
| `oscillate(t,x0,v0,target,k,c)` | 阻尼振子 `{x,v}` 闭式，全套件唯一一份（closed.js `spring` 调它） |
| `springKick(p,{eps?})` | 单位速度冲量响应 = `oscillate(τ,0,1,0,…).x`；`p` 为 `{k,c}`、`{stiffness,damping}`（motion.js 的名字，同义）或 `{omega,zeta}`；`.velocity(τ)` |
| `riseHoldFall({rise,hold,fall})` | 目标保持后指数回落，输出一阶跟随；多发"保持被重置"用 film-physics `recoil` |
| `holdFrames(k,{minFrames,fps?})` | 短核拉长到 `minFrames/fps`（峰值不变，手感变软）；fps 缺省 `FILM.fps` |

## 4. 加载期规则与有记忆的量

- `throttle(track,{on,minGap,maxPerWindow:{n,span},priority})`：无 priority 按时间贪心（= 游戏冷却计时器）；有 priority 先按优先级接受，后来的重要事件能抢掉先前的（非因果）。`.dropped` 是被丢的。
- `burstEnds(track,{on,gap,delay,type})`：每串（相邻间隔 < gap）最后一发 + delay 处派生 `{type:'burstEnd', id:'burstEnd:<最后一发 id>', count, start, last}`。
- `snapToFrames(track, fps?, {mode})`：时刻对齐到帧栅格，原时刻存 `t0`，表上 `.fps`。round ≤ 半帧、ceil ≤ 1 帧。最短可见另配 `holdFrames`。
- `trauma / traumaOf`（每事件 +add、每秒减 decay、封顶 max）、`piecewise({on,init,jump,flow,value})`（事件处跳变 + 事件间闭式流，O(log n)）、
  `countRing(track,t,{on,size,fade})`（环形缓冲；谓词 `on` 的过滤结果按 (表, 谓词) 缓存，谓词要是加载期定义的同一个函数）。

## 5. 给声音的桥（只产数据，不 import film-narration）

`toCues(track, mapping, {tails?})` → cues.json 数组；`toSceneEvents(track,{kind,v,anchor,on})` → `window.events()`。

- 每条 cue = `{t, id, event: 事件类型, ...事件其余字段（pan、power、t0…）, ...模板}`；不出现 `at/beat/key/index`。
  透传的代价：事件字段名若恰是 sfx 认的 cue 字段（gain/pan/rate/dur/send/variant/tail…），声音会读它；模板里写 `undefined` 删掉。
- mapping 未覆盖的类型报错，写 null 静音。模板值可以是 `(e) => 值`。
- `tails: burstEnds(...)`：每串最后一发的 cue 写 `tail: true`，其余不写 tail。film-narration 见到任何显式 tail 就严格照它挂尾音，画面和声音用同一个 gap。
  也可以把 burstEnd 事件本身映射成 cue。
- 声音读的 `t` 是对齐、节流之后的时刻，与画面同一张表。

## 6. 帧率

`snapToFrames` / `holdFrames` 不给 fps 时读内核注入的 `window.FILM.fps`（kernel.md §1；`render --fps 24` 时就是 24）；两者都没有（Node 里）报错，不猜。
显式 fps 与 `FILM.fps` 不相容时报错：对齐栅格要整除渲染帧率（30 的栅格 @60 可以，@24 不行）；`holdFrames` 的 fps 不能高于渲染帧率。
不这样做的代价（实测，`_test-events` 单测）：按 30 fps 对齐与拉长、按 24 fps 渲染，200 个 50 ms 闪光里 47 个只亮 1 帧。
