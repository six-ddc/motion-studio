# 文字动画运行时（`assets/runtime/textfx.js`）

目录：1 拆分（中文怎么拆）· 2 逐单元绘制与预设 · 3 代价表（实测耗时）· 4 乱码解码 · 5 打字机 · 6 沿路径 · 7 切分揭示 · 8 数字滚动 · 9 逐字 3D 翻转 · 10 文字 Magic Move · 11 没解决

本运行时建在 `text.js` 之上，`sat`/`lerp`/`hash01` 来自 film-core 的 `motion.js`/`rand.js`；交错表和缓动表可以使用 film-motion `choreo.js` 的 `stagger()`/`EASE`（安装了 film-motion 才有）。
预设的距离、角度、幅度都是必填参数（同样是 `rise`，0.3 em 和 2 em 是两种完全不同的手感）。夹具 `tests/fixtures/_test-mg` 的 s1–s8、s12 各演示一种手法，本文的数字都出自那里。

## 1. 拆分：`units(text, { by: 'char' | 'word' })`

- `'char'`：按字素拆分；闭标点、句读、间隔号、破折号、空格**挂到前一个单元**，开标点（「（《“ 与 ASCII `([{`）**挂到后一个单元**。所以 `时间的纯函数，乱序也一样。` 会拆成 `时 间 的 纯 函 数， 乱 序 也 一 样。`，标点跟着字一起动，不会自己单独飞进来。
- `'word'`：使用 `Intl.Segmenter` 的词粒度，中文走 ICU 词典切词（`把 / 胆子 / 放在 / 一处， / 其余 / 保持 / 安静。`）。**切法可能随 ICU 版本变化**；需要逐字节固定时就自己提供词表。
- 所有单元拼起来逐字节等于原文。按行处理时用 `layoutText` 返回的 `lines`。

`layoutText(ctx, text, { by, maxWidth, lineHeight, align })` 返回 `{ units: [{s, x, y, w, cx, i, line, li}], lines, width, height }`：断行使用 `wrapCJK`（处理避头尾），行内位置用**前缀测量**（保留 kerning）。在加载时调用一次。

## 2. 逐单元绘制与预设

`drawUnits(ctx, lay, x, y, style)`：`style(u, i)` 返回 `{ dx, dy, sx, sy, rot, skewX, alpha, fill, stroke, text, filter } | null`，变换以单元的视觉中心为原点。
`unitProgress(t, i, { start, dur, ease, delays | stagger, order })` 为每个单元给出一个已缓动的进度。

- 入场：`IN.fade()` `IN.rise({dist})` `IN.drop({dist})` `IN.scale({from})` `IN.spin({angle,dist})` `IN.skew({angle,dist})` `IN.track({spread})` `IN.blur({radius})` `IN.flipAffine()`
- 出场：`OUT(入场预设)`，把 p 反过来用
- 强调：`EMPHASIS.wave({amp,freq,phase})` `EMPHASIS.pulse({t0,dur,amp,each})` `EMPHASIS.jitter({amp,rate,seed})`，都是 t 的周期函数或种子函数

## 3. 代价表

耗时条件：1920×1080、SwiftShader，取整个镜头 seek 耗时的中位数（只画背景加一行标签为 0.2 ms；截图约 32 ms，所以文字手法都不是瓶颈）。

| 手法 | API | 绘制 ms | 读起来 | 什么时候值得 | 廉价感从哪来 |
|---|---|---|---|---|---|
| 逐字交错入场 | `drawUnits` + `IN.*` + `stagger` | 0.4（2 行 × 13 单元） | 有节奏地出现 | 短句、口号、标题 | 每一句都交错出现，观众就一直在等字出完；`back.out` 加 `scale` 用在正文上显得廉价 |
| 乱码解码 | `scramble` | 0.2 | 计算、破译、"正在得出结论" | 题材是数据、密码或揭晓；**只揭晓一次** | 乱码池随便选（中英混杂、符号杂乱）会显得像"黑客片模板"；每个标题都用解码 |
| 打字机 + 光标 | `typeSchedule` / `typedAt` / `cursorOn` | 0.2 | 正在被写出来、对话、代码 | 代码、对话、"一个人在思考" | 匀速显得像机器，标点停顿和 jitter 让它更像人。和配音同步时，节奏要跟着旁白，而不是跟着字数 |
| 沿路径排字 | `pathSampler` / `drawOnPath` | 0.7 | 流动、轨迹、文字变成图形 | 文字在描述一条路径或流向 | 曲率大的地方中文字会挤在一起（字按切线旋转，弯道内侧重叠）；纯装饰性的弧线 |
| 遮罩切分揭示 | `drawSliceReveal` | 0.3（6 条） | 拼合、构建、有力量 | 大字标题，只用一次 | 条数多加上方向交替，就是典型的 MG 预设；小字号时切口锯齿明显 |
| 按行升起 | `drawLineReveal` | 0.3 | 安静、有编辑感 | 段落、引文 | 很少显得廉价；行数多时总时长会很长 |
| 数字滚动（里程表） | `odometer` / `drawDigits` | 0.3 | 累积、计量 | 数字本身是主角 | 所有数字都在滚；滚得太久（数值早就读不清了）|
| 数字滚动（老虎机） | `drawDigits`（自己给出每位的位置）| 0.3 | 抽奖、揭晓 | 数字是"结果" | 与题材无关时像游戏 UI |
| 逐字 3D 翻转（透视条带） | `glyphSprites` / `drawFlip(mode:'strips')` | 3.1（6 字 × 40 条 + 6 字仿射） | 物理的翻牌 | 翻牌器、卡片、"翻过一页" | 条数少时竖笔画出现台阶（实测 16 条肉眼可见，40 条时消失）；精灵的颜色在加载时就定死了 |
| 逐字 3D 翻转（仿射） | `drawFlip(mode:'affine')` / `IN.flipAffine` | 同上 | 压扁再展开 | 小字号、快速翻转 | 没有近大远小，接近 90° 时看起来是"压扁"而不是"翻转" |
| 按词波浪 / 脉冲 | `EMPHASIS.wave` / `pulse` | 0.3 | 活泼，强调某个词 | 强调**一个**词 | 整句一直在波浪起伏，看起来像字在抖，难以阅读 |
| 文字 Magic Move | `matchUnits` / `drawMorphText` | 0.2 | 同一组字重新排列出新的意思 | 词序变化本身就是要点（"纯函数的时间"变成"时间的纯函数"） | 两句话没有共享的字时，退化成交叉淡化 |
| 模糊对焦 | `IN.blur` | 没在夹具里测 | 梦境、回忆 | — | `ctx.filter` 在 SwiftShader 下很慢（methods.md §15） |

## 4. 乱码解码 `scramble(t, units, { start, delays, settle, rate, pool, seed, keep })`

单元 i 在 `start + delays[i]` 时刻出现，乱码持续 `settle` 秒后锁定为最终字。乱码字 = `pool[hash01(seed, i, j, floor(t·rate))]`，**只依赖 (seed, i, t)**，所以乱序求值的结果一致。
标点和空格默认不参与乱码（可以用 `keep` 修改）；挂在单元上的标点在锁定前不显示。通过 `drawUnits` 的 `{ text }` 换字，位置仍按原字的中心计算，替换字宽度不同也不会推开后面的字。

**`pool` 里的每个字都要传进 `loadFonts`**：乱码字是运行时才画出来的，漏掉的字会在第一次被抽中的那一帧用回退字体绘制（SKILL.md 硬约束 2）。

## 5. 打字机

`typeSchedule(units, { start, perUnit, pauses: {'，': 0.16}, jitter, seed })` 在加载时排好每个单元的出现时刻；`typedAt(t, sched)` 用二分查找得到已打出的字数（整数，它变化的那一刻就是 tick 音效的时刻）；
`cursorOn(t, sched, { blink, hold })`：距上一次击键不足 hold 秒时常亮，空闲时按 blink Hz 闪烁。以上全部是 t 的纯函数。
匀速打字机是其中的特例：`typeSchedule(n, { start, perUnit })`（只给个数，不给 pauses / jitter）。给了 pauses / jitter 时，节奏才由文本决定（标点后停顿、种子抖动）。

## 6. 沿路径排字

`pathSampler(spec)`：spec 可以是点数组、`{cubic}`、`{arc}` 或函数，加载时建立 512 段的弧长表；`at(s)` 按弧长取点和切线，超出两端时沿切线外推（字可以从路径外开进来）。
`drawOnPath(ctx, lay, path, { offset, normal, style })`：每个单元放在弧长 `offset + u.cx` 处，并按切线旋转。让 offset 随 t 变化，字就会沿路径流动。

## 7. 切分揭示

`drawSliceReveal(ctx, text, x, y, { slices, progress(k), dist, alternate, axis })`：把整行切成 slices 条，每条在自己的条带遮罩里从 ±dist 处滑进来。
`drawLineReveal(ctx, lay, x, y, { progress(line), rise })`：用于多行文字，每行一个行遮罩，整行从遮罩下方升起。

## 8. 数字滚动

`digitAdvance(ctx)` 取 0–9 中最宽的 advance 作为列宽（保持等宽，滚动时不会左右抖动）。`odometer(value, digits)`：个位连续滚动，高位只在低位从 9 滚到 0 的最后一个单位内滚动（即真正的进位）。
`drawDigits(ctx, cols, x, y, { adv, lineHeight, hideLeading, value })`：每列在自己的窗口里竖向滚动；老虎机效果则是自己给出每位的位置 `目标 + 10·圈数·(1 − ease(p))`。

## 9. 逐字 3D 翻转

canvas 2D 只支持仿射变换，做不出透视。有两条路：
- **仿射近似**（`mode: 'affine'` / `IN.flipAffine`）：绕轴转 θ 等价于在那个方向上缩放 cos θ，没有梯形收缩。
- **透视条带**（`mode: 'strips'`）：把精灵切成 N 条，每条按自己的深度 z = v·sin θ 单独缩放 f/(f+z)，用分段仿射逼近透视，在每条的中心处是精确的。代价：条与条之间宽度有阶跃，竖笔画会出现台阶；在 120 px 的字上，16 条肉眼可见，40 条就看不出来；耗时随条数线性增长。`focal` 越小透视越强。转过 90° 后看到背面时，提供 `back` 精灵（用于翻牌换字）。
- 需要真透视或带光照时，用 film-motion 的 camera3d 或 film-webfx 的着色器，把字当作贴图处理；本运行时没有实现。

`glyphSprites` 在加载时用当时的 ctx.font / fillStyle 绘制精灵，颜色因此固定；要变色就用 `source-atop` 叠色，或者准备多套精灵。

## 10. 文字 Magic Move

`matchUnits(a, b)`：相同的单元按就近次序配对（允许换序：「纯函数的时间」变成「时间的纯函数」时，六个字全部能配上）；其余单元记入 onlyA / onlyB。
`drawMorphText(ctx, layA, layB, m, p, { a, b, arc, fadeOut, fadeIn, delays })`：配对的字从 A 的位置沿拱起的路径飞到 B 的位置，onlyA 淡出、onlyB 淡入。配对依据是字符串相等，而不是字形轮廓。

## 11. 没解决

- 拆分只处理中文与拉丁文；阿拉伯文、天城文的字素逐个绘制会破坏连字（与 text.js `splitText` 的限制相同）。
- 竖排文字的动画（沿竖排方向交错、标点旋转）没有实现；`IN.blur` 没有在夹具里测量。
