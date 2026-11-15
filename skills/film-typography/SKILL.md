---
name: film-typography
description: 代码渲染影片里"文字作为视觉元素"的能力：字体加载与缺字保障、按字/词/行拆分并保留 kerning、文字入场/出场/强调手法（遮罩升起、打字机、逐字交错、乱码解码、沿路径排字、数字滚动、逐字翻转、文字按字符变形过渡）、可变字体轴动画、中日韩排版（断行、避头尾、标点挤压）、竖版小字号可读性下限，以及画面内字幕的全部绘制（逐词高亮的字形、颜色、描边、布局）。scene.html 里要画标题、大字报、kinetic typography、数字跳动、标签、引言卡、烧进画面的字幕时加载；遇到"字体没生效""中文换行难看""标点太空""字发虚看不清""加粗没效果""字距不对"也用它。字幕的时间轴归 film-narration，字体文件来源与授权归 film-assets。
---

# film-typography

文字在这套片子里是**画面元素**，不是排好版的段落。canvas 2D 没有自动换行、标点挤压和字体回退警告，这些都要自己做；seek(t) 契约又要求一切都能按任意 t 精确求值。本 skill 提供一份只管"字对不对、放在哪"的基础运行时，一组手法的原理、代价与坑（代码由你按本片写），和一组实测的可读性下限。**用什么字体、什么手法、什么节奏由本片 `docs/style_guide.md` 决定**，这里不给默认组合。

## 运行时（基础设施，不是手法）

`assets/runtime/text.js` 只管"字对不对、放在哪"：字体保障、拆分测量、断行、字幕绘制。**文字怎么动的代码由你按本片写**，原理和坑在 `references/methods.md`。
在 scene.html 里直接 import（套件挂载，交付时冻结进片子，见 `../film-core/references/runtime.md` §2）：

```js
import { loadFonts, splitText, prefixMeasure, wrapCJK, layoutCJK, drawCaption } from './runtime/text.js';
```

| 能力 | API | 说明 |
|---|---|---|
| 字体保障 | `loadFonts(specs)` / `missingGlyphs(font, text)` / `CHARSETS` / `expandChars` | 缺字族、缺字形、加载失败、字符类名写错时**一律抛错** |
| 拆分 | `segments(text, {granularity})` | Intl.Segmenter，按 grapheme / word / sentence |
| 前缀测量 | `prefixMeasure(ctx, pieces, {gaps})` → `[{s,x,w}]` | 一切"拆开逐段画"的布局都用它定位，保留 kerning |
| 拆字布局 | `splitText(ctx, text)` → `[{ch,x,w}]` + `totalWidth` | 按字素调用 `prefixMeasure` |
| 墨量 | `inkCount(ctx, rect)` | 测粗细只能数墨水像素 |
| 遮罩升起基元 | `drawRiseIn(ctx, glyphs, t, {progress, rise, …})` | 行遮罩 + 逐段位移；缓动与交错由调用方的 `progress(i)` 给 |
| 可变轴 | `setAxes(ctx, axes, font)` / `clearAxes` / `axesString` | 【非标准】任意轴；只调字重不需要它 |
| 合成粗体 | `disableFontSynthesis(ctx)` | 【非标准】关掉伪粗体 |
| 标点分类 | `punctClass` / `NO_LINE_START` / `NO_LINE_END` | 断行禁则、拆分时标点挂靠方向 |
| 中文断行 | `wrapCJK(ctx, text, maxW)` | 避头尾，拉丁 / 数字串不拆 |
| 中文布局 | `layoutCJK(ctx, text, size, {punct})` / `punctAdjust` | 标点挤压三档：`none` / `adjacent` / `half` |
| 字幕绘制 | `drawCaption(ctx, cap, opts)` / `layoutCaption` | cap 来自 film-narration 的 `vo.captionAt(t)`，见「字幕绘制」 |

## 硬约束（技术不变量，违反就是 bug）

1. **字体随片打包**（内核契约，见 `../film-core/references/kernel.md`；film-core 的 fontsrc 门对所有片子始终开启）。系统字体和 CDN 字体会随机器、浏览器构建和时间变化，本机这次渲得对，不代表换台机器也对。字体文件放进 `films/<slug>/assets/fonts/`，`@font-face` 用相对路径引用。
   打包命令：`node <本skill>/scripts/fontpack.mjs --film <slug> --css <fontsource css> --text-file <文案>`，或 `--file <字体> --family <名字> --text-file <文案>`（用 pyftsubset 子集化，保留可变轴）。字体从哪里找、能不能商用，**参见 film-assets skill**。
2. **在 `window.ready` 里 `await loadFonts([...])`，失败就让它抛错**。回退字体不会报错，只会让排版错位，两台机器渲出的 md5 也不同。`loadFonts` 已经处理了三个坑：`fonts.ready` 只等待已经触发加载的字体，`fonts.check()` 对不存在的字族也返回 true，缺字形时浏览器会逐字回退（见 chromium.md B/C）。
   `specs` 要覆盖本片的**全部文案**（含字幕）和**每个用到的字重**：`[['700 80px "X"', 全部文案], …]`。
   **运行时拼出来的字**（如 `白子：${n} 口气` 里的 n）最容易漏掉。漏掉的字如果属于还没加载的 unicode-range 分片，第一次画到它的那一帧就会用回退字体。所以也可以**按字符类声明**：`[font, { text: 文案, sets: ['digits'], ranges: ['U+2460-2473'] }]`（类名见导出的 `CHARSETS`，写错会直接抛错）。
   代价是声明的整类字符都会加载，也都会逐字核对覆盖，类越宽，越容易碰到字体本来就不打算覆盖的字。有没有漏，fontsrc 门会点名报出（"seek 期间才加载字体"）。
3. **测量在加载阶段完成**；seek 里如果要重新测量，只能依赖 t（例如字重随 t 变化时，按当前字重重新 `splitText`）。不要缓存"上一帧的宽度"。
4. **拆字要用前缀测量**，不要把逐字 `measureText` 的结果相加：Inter 80px 的 `AVATAR Wave Type` 逐字相加比整串测量宽 **47.8px**。
5. **测粗细要数墨水像素**。合成粗体的 advance 不变（241.52 → 241.52），墨量却从 5513 变成 7194。

**这是手段，不是不变量**：坐标和字号用 film-core `layout.js` 的 `L.size()` / `L.place()`（按短边比例换算），多画幅时值得用，代价是多一层换算。

## 可变字体能做什么

| 想做 | 怎么做 | 性质 |
|---|---|---|
| 字重连续动画 | `ctx.font = \`${w} 80px "X"\``，w 取任意数 | **标准**，连续 |
| 字宽（wdth） | `ctx.fontStretch` 只接受 9 个关键词，所以只能离散变化 | 标准，但离散 |
| 任意轴连续变化（wdth/opsz/slnt/GRAD/自定义） | `setAxes(ctx, {wdth: 87.5, opsz: 24}, font)` | **【非标准】**：通过 canvas 元素的 CSS `font-variation-settings` 加上重设 `ctx.font` 实现；OffscreenCanvas 上不可用 |
| 精确字形轮廓、笔画描边 | 用 opentype.js / fontkit 导出路径，转成 `Path2D` | 与浏览器无关，确定性最好 |

非标准行为的实测结果、假阴性清单（测轴必须用**真正的可变字体**）以及升级 Chromium 后的复测命令，见 `references/chromium.md`。

## 手法（入场 / 出场 / 强调）

代价分三个维度：**实现**（代码量和坑）、**可读损失**（动画期间能不能读）、**记忆点**。没有绝对的"好手法"，只有和本片 style_guide 匹配与否。
下表只列代价；每条的原理、伪代码、确定性陷阱和可用的库见 `references/methods.md`（含出场、组合、实测耗时）。距离、角度、缓动、交错间隔都没有默认值。

| 手法 | 实现 | 可读损失 | 记忆点 | 什么时候值得 | 代价要点 |
|---|---|---|---|---|---|
| 硬切 | 极低 | 无 | 低 | 信息密集、跟节拍切 | 没有过程，全靠排版和时机 |
| 淡入淡出 | 极低 | 低 | 低 | 衬托、次要信息、出场 | 没有方向感，多了画面"软"；半透明叠字会糊 |
| 遮罩升起 / 按行升起 | 低 | 中 | 中 | 标题、关键句、段落 | 升起中字被裁半；中文逐字超 15 字拖沓 |
| 裁切滑入 / 切分揭示 | 低 | 中 | 中 | 标签、横向信息流、大字标题 | 方向要和画面运动一致；条数多加交替就是 MG 预设 |
| 逐字交错（位移/缩放/旋转/字距） | 低 | 中到高 | 中到高 | 短句、口号 | 总时长 = dur + (n-1)·stagger，长句读到一半字还没出完 |
| 打字机 | 极低 | 低 | 中 | 代码、对话、"正在想" | 匀速像机器；节奏要跟旁白而不是跟字数 |
| 乱码解码 | 中 | 高 | 高 | 数据、密码、揭晓，只用一次 | 乱码必须是 (种子, 单元, 时间步) 的哈希；宽度跳变要按原字中心放或用等宽 |
| 字重渐变（wght） | 低 | 低 | 中 | 强调一个词、"变重" | advance 跟着变，整行被推开 |
| 轴动画（wdth/opsz/slnt） | 中（非标准） | 低到中 | 高 | 品牌字、伸缩隐喻 | 依赖 Chromium；字体要真有该轴 |
| 笔画顺序（书写） | 高 | 高 | 高 | 书法、教学、单字特写 | 要笔画数据，字形和片子字体不一致 |
| 描边生长 → 填充 | 中到高 | 高 | 高 | logo、标题定格 | 描的是闭合外框，不是沿中线书写 |
| 缩放冲击（弹簧） | 低 | 中 | 高 | 数字、结论、节拍重音 | 过冲用在正文上廉价 |
| 字作遮罩 | 中 | 低 | 高 | 片头、转场 | 小字号时纹理让字更难读，要粗字重 |
| 沿路径排字 | 中 | 中 | 中到高 | 文字描述一条路径或流向 | 必须按弧长放字；弯道内侧中文会重叠 |
| 数字滚动（里程表/老虎机） | 中 | 中 | 高 | 数字本身是主角 | 列宽要等宽否则抖；滚太久数值读不清 |
| 逐字 3D 翻转 | 中到高 | 中 | 高 | 翻牌、卡片 | canvas 2D 无透视：仿射像压扁，条带近似有台阶 |
| 文字 Magic Move | 中 | 低 | 高 | 词序变化本身是要点 | 两句没共享字时退化为交叉淡化 |
| 逐词高亮（字幕式） | 低 | 无 | 中 | 旁白同步、卡拉 OK | 时间轴必须来自 narration.json |
| 波浪 / 脉冲 / 抖动强调 | 低 | 中 | 中 | 强调**一个**词 | 整句一直动就是字在抖 |
| 模糊对焦 | 中 | 高 | 中 | 梦境、回忆 | `ctx.filter` 在软件渲染下很慢 |

所有手法共同的确定性要求：拆分、测量、路径弧长表、精灵图在加载时做一次；seek 里每个单元的状态只由 t 算出（`p_i = ease(sat((t - start - delay_i)/dur))`），
随机一律来自种子哈希，不靠上一帧。运行时才出现的字（乱码池、拼出来的数字）要进 `loadFonts`。

## 可读性下限（实测，9:16 竖版，360 有效宽）

判定方法：把 1080 宽的成片缩到 360 宽（1 个有效 px 约等于手机上 1 个 CSS px），数笔画能分出几段；下限是从该字号往上**全部**都能分开的最小字号。所用字体为 Noto Sans SC Variable 和 Inter Variable。测法与局限见仓库 docs/verified/film-typography.md §3。

| 文字 | 字重 | 最小字号（成片 1080 宽 px） | 有效 px | `L.size()` 比例 |
|---|---|---|---|---|
| 拉丁（mmm 9 根竖干） | 400 | **26** | 8.7 | 0.024 |
| 拉丁 | 700 | **30** | 10.0 | 0.028 |
| 中文常规字（言，6 段横画） | 400 | **56** | 18.7 | 0.052 |
| 中文常规字 | 600 | **74** | 24.7 | 0.069 |
| 中文常规字 | 700 | **88** | **29.3** | 0.081 |
| 中文密字（量，9 段横画） | 400 / 700 | 80 / 110 | 26.7 / 36.7 | 仅供参考，不作检查阈值 |

中文下限随字重变化（200–400 最宽容，100 和 900 两头都会出问题），逐字重的曲线和读法见 `references/measurements.md` §1–2。
**对比度**：在下限字号附近，WCAG 4.5:1 不够用。拉丁 400@26px 的标称对比度要 ≥ 9.8:1，中文 4.5–5.0:1 即可；字号大一档以上，4.5:1 才可信（measurements.md §3）。

换了自己的字体、字号或背景，要复测：
```bash
node <本skill>/scripts/legibility.mjs --film <slug> --cjk '"本片中文字族"' --latin '"本片拉丁字族"' --weights 400,700
# 粗体/大字号要放宽扫描范围；--at 直接判本片字号；--phases 看像素相位稳不稳；--chars 逐字看
node <本skill>/scripts/legibility.mjs --film <slug> --cjk … --latin … --frame-width 1920 \
    --weights 600 --max 220 --phases 8 --at 58.32 --chars "$(本片字幕文案)"
```

**竖版平台遮挡带**（来源 HyperFrames vertical.md，**未核实，平台会改版**）：在 1080×1920 的信息流里，顶部约 168 px（8.75%）、1330 px 以下（约 30%）和右侧动作栏会被平台 UI 盖住，文字和主体应放在 168–1330 px 的区间内。要让机器检查，就在舞台里放透明的 `<div data-avoid="平台顶栏">`（以及底栏）盖住遮挡带，film-core preflight 的 overflow 检查会报出压住它的 `data-slot`。preflight 的 `--safe` 是四边对称的比例，表达不了这种不对称的遮挡。

## 中日韩排版（细节见 references/cjk.md）

canvas 里汉字和全角标点的 advance **严格等于 1em**，没有 `text-spacing-trim`。`wrapCJK` 处理避头避尾（拉丁和数字串不拆开）。标点挤压 `layoutCJK(…, {punct})` 的三档是**风格选择**，能不能挤取决于字体面向的地区：简体的 `，。` 位于 em 框左下，可以挤；繁体和日文的标点常居中，挤了会贴到字上。中英混排要分别指定字族；竖排、注音、着重号要自己画。

## 字幕绘制（和 film-narration 的边界）

**时间轴归 film-narration**，包括 `narration.json`、`vo.captionAt(t)` 的分块（哪几个词放一屏）、各词起止时间、词间空格 `spaces` 和 `activeIndex`。**绘制全部归这里**，包括字族、字号下限、颜色、描边、逐词高亮的样式和布局测量。导出 SRT/ASS 文件那条路不画字，归 film-narration 的 `subs.py`。

```js
import { loadNarration } from './runtime/narration.js';   // film-narration：只出时间数据
import { drawCaption } from './runtime/text.js';

const cap = vo.captionAt(t, { maxChars: 14 });            // null = 句间停顿，drawCaption 什么都不画
// 两色：念到的词（cumulative：念过的都亮；current：只亮正在念的）用 active，其余 idle
drawCaption(ctx, cap, { font: `700 ${L.size(0.052)}px "本片字族"`, x: L.cx, y: L.height - L.pad,
                        idle: '<本片色>', active: '<本片色>', mode: 'cumulative', stroke: '<可选>', lineWidth: L.size(0.006) });
// 逐词样式：字重渐变、上浮、扫光、缩放都从 style(i, state, activeP) 来；给了 style 就不看 idle/active
drawCaption(ctx, cap, { font, x: L.cx, y, style: (i, state, p) => ({ fill: state === 'future' ? A : B, dy: -p * L.size(0.004) }) });
```

- 布局一律用前缀测量（中英混排时，拉丁词之间的空格取 `cap.spaces`）。缺少外观参数就抛错，因为套件不提供默认的字幕样式。
- 只画一行。多行、竖排、逐字入场的字幕，拿 `cap.words` 自己用 `wrapCJK` / `layoutCJK` / `prefixMeasure` 排。
- 字幕文案（`narration.json` 里的全部字）要加进 `loadFonts`。字号下限按上表、**按字幕实际使用的字重**取值。
- **一次只显示一组**：任一时刻可见的字幕组 ≤ 1。`captionAt(t)` 是纯函数，天然不会有残留；自己排多组字幕时，不要让上一组的淡出叠在下一组上。
- **第一组字幕不要从 0 s 开始**：0 s 就在的字会被读成"本来就印在画面上"，不像是在念；起点 ≥ 0.1 s（来源 HyperFrames captions，经验值）。如果要从 0 开始，写进 style_guide。

## 脚本

| 脚本 | 做什么 |
|---|---|
| `scripts/fontpack.mjs --film <slug> …` | 把字体拷进影片，按文案取分片或子集化，生成使用相对路径的 fonts.css |
| `scripts/legibility.mjs --film <slug> …` | 测小字号笔画可分辨性和对比度下限，并按字重、相位、逐字、指定字号做诊断，结果写进 `out/<--out>.*` |

所有脚本都能从任意 cwd 调用（向上查找 `films/`，或给 `--films-dir`），用 `--help` 看参数。本 skill 不登记门：文字对不对由内核门（fontsrc、seam）和评审负责。

## 下层文档

`references/methods.md`（每条手法的原理、伪代码、代价、坑、可用的库，以及出场、组合、耗时）·
`references/cjk.md`（断行规则、标点挤压的三种习惯、全角半角、竖排与注音）· `references/chromium.md`（非标准行为、度量陷阱、假阴性清单与复测命令）·
`references/measurements.md`（可读性下限的字重曲线与读法、对比度推导、字体文件加载耗时）
