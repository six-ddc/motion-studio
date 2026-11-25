---
name: film-typography
description: 代码渲染影片里"文字作为视觉元素"的能力：字体加载与缺字保障、按字/词/行拆分并保留 kerning、文字入场/出场/强调手法（遮罩升起、打字机、逐字交错、乱码解码、沿路径排字、数字滚动、逐字翻转、文字变形过渡）、可变字体轴动画、中日韩排版（断行、避头尾、标点挤压）、竖版小字号可读性下限，以及画面内字幕绘制（逐词高亮、描边、布局）。scene.html 画标题、大字报、kinetic typography、数字跳动、引言卡、内嵌字幕，或字体没生效、中文换行难看、标点太空、字发虚、字距不对时加载。字幕时间轴归 film-narration，找字与子集化归 film-assets。
---

# film-typography

文字在视频里是**核心画面元素**。本 skill 提供只管“字对不对、排在哪”的可选运行时 `assets/runtime/text.js`，外加文字动效原理、代价与实测可读性下限；**不给默认字体和固定动效模板**，HTML/CSS 排版或 Canvas 绘制均可按本片自由选用。

## 硬约束（违反即 bug）

1. **字体随片打包（内核门 `fontsrc` 强制检查）**：字体放 `films/<slug>/assets/fonts/`，用相对路径 `@font-face` 引用；绝不依赖系统字体或 CDN。打包/子集化可用 `scripts/fontpack.mjs` 或 `film-assets` 的 `subset_font.py`。
2. **`window.ready` 里显式等全量字体并核对缺字**：推荐 `await loadFonts([['700 80px "X"', 全部文案], …])`（失败即抛错，防静默回退）。**运行时动态拼出的字**（数字、计数器、乱码池）必须一起声明，可用字符类 `[font, { text, sets: ['digits'], ranges: ['U+2460-2473'] }]`，否则 seek 期才加载分片会导致当帧回退并让 `fontsrc` 报红。
3. **测量放加载期，不缓存跨帧宽度**：字重随 `t` 变化时按当前 `t` 重算。
4. **拆字必须用前缀测量**：直接累加逐字 `measureText` 会丢 kerning（实测 80px Inter `AVATAR Wave Type` 差 47.8px），用 `prefixMeasure` / `splitText`。
5. **测粗细数墨水像素（`inkCount`）**：伪粗体 advance 不变但墨量暴涨；需要关合成粗体用 `disableFontSynthesis`。

## 可选运行时（`import { ... } from './runtime/text.js'`）

| 类别 | API | 用途 |
|---|---|---|
| 字体保障 | `loadFonts` / `missingGlyphs` / `CHARSETS` / `expandChars` | 缺字族/缺字形直接抛错 |
| 拆分与测量 | `segments` / `prefixMeasure` / `splitText` / `inkCount` | Intl.Segmenter 拆分 + 保留 kerning |
| CJK 排版 | `wrapCJK` / `layoutCJK(…, {punct})` / `punctClass` | 避头尾、拉丁数字不断、三档标点挤压（`none/adjacent/half`，繁/日居中标点慎挤） |
| 遮罩与可变轴 | `drawRiseIn` / `setAxes`（【非标准】CSS variation 驱动任意轴）/ `disableFontSynthesis` | 仅调字重直接写 `ctx.font = \`${w} 80px "X"\``（标准连续） |
| 字幕绘制 | `drawCaption(ctx, cap, opts)` / `layoutCaption` | 接 `film-narration` 的 `vo.captionAt(t)`，绘制 `d`（稿子显示文字）而非裸 token |

## 常用手法代价速览（原理与伪代码见 `references/methods.md`）

- **克制信息型**：硬切（跟拍/高密度）、遮罩升起 / 裁切滑入（标题与关键句，中文逐字 >15 字易拖沓）、淡入淡出（次要信息，过多会“软”）、逐词高亮（字幕卡点）。
- **视觉冲击型**：逐字交错（短口号）、缩放弹簧冲击（大数字/结论，勿用于正文）、数字滚动（等宽防抖）、字重/可变轴渐变（强调词，注意整行 advance 推移）、乱码解码（种子哈希+等宽，全片最多用一次）、字作遮罩（需粗字重）、沿路径排字（按弧长）、描边生长→填充（需 `opentype.js`/`fontkit` 轮廓）。

## 小字号可读性与安全区（实测：1080 宽缩至 360 有效宽）

| 文字 | 字重 | 最小成片字号（1080 宽 px） | 有效 px | `L.size()` 比例 |
|---|---:|---:|---:|---:|
| 拉丁（mmm） | 400 / 700 | **26** / **30** | 8.7 / 10.0 | 0.024 / 0.028 |
| 中文常规字（言） | 400 / 600 / 700 | **56** / **74** / **88** | 18.7 / 24.7 / **29.3** | 0.052 / 0.069 / 0.081 |
| 中文密字（量） | 400 / 700 | 80 / 110（参考） | 26.7 / 36.7 | — |

下限字号附近拉丁需对比度 ≥9.8:1、中文 ≥4.5–5.0:1；换字体/横版 1920 宽需复测。`9x16` 竖版信息流注意主字与主体避让顶部 ~168px、底部 ~30% 与右侧互动栏（可用 `<div data-avoid="...">` 配合 `preflight` 机检）；**遮挡带不等于留空**，底部在成片与转发里依然露出，可放背景延伸或次要装饰，别留成一块死白。

## 字幕边界与绘制要点

时间轴归 `film-narration`（`vo.captionAt(t)`），外观绘制全归这里（或由你用 HTML/Canvas 自由实现）。须遵守：**画 `d` 不画裸 token**、字幕全部字符加入 `loadFonts`、任一时刻仅显示一组字幕、首组字幕起点建议 ≥0.1s（避免像静态印字）。

```bash
node <film-typography>/scripts/fontpack.mjs --film <slug> --file <字体> --family <族名> --text-file <文案>
node <film-typography>/scripts/legibility.mjs --film <slug> --cjk '"字族"' --latin '"字族"' --weights 400,700 [--frame-width 1920]
```

## 下层文档

`references/methods.md`（手法原理与伪代码）· `references/cjk.md`（断行/标点挤压/竖排）· `references/chromium.md`（非标准行为与度量坑）· `references/measurements.md`（字重可读曲线与对比度）
