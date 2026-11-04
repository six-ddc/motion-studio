# Chromium 文字行为：非标准、度量陷阱、假阴性

以下内容全部在 Chromium 156.0.8078.4 / Playwright 1.64 上实测。升级后在仓库里重跑 `node dev/film-typography/probe.mjs`（这是开发基准，不随 skill 安装；共 11 条，任何一条结果翻转都会 exit 1 并列出是哪一条；加 `--json` 输出原始数字，加 `--font 本片的可变字体.woff2` 测本片的字体）。

## A. 非标准但可用（规范没保证，依赖实现）

### A1. canvas 元素的 CSS `font-variation-settings` 影响 2D context
```js
canvas.style.fontVariationSettings = "'wght' 900";
ctx.font = ctx.font;          // ← 必须重新赋值（哪怕是同一个串）才生效
```
实测：设置后不重新赋值，`measureText('Motion')` 仍是 241.52；重新赋值后变为 276.41，墨量从 5513 增至 10323。opsz 同样生效（14 / 32 时分别为 261.02 / 241.52），任意轴都走这条路径。
**每次改轴都要重新设置 font**（`setAxes` 已经做了）；用完后调用 `clearAxes`，否则后面画的所有字都会继承这组轴。`wght` 轴会覆盖 ctx.font 里的数字字重。限制：OffscreenCanvas 和 Worker 里没有 canvas 元素，不能用这种方法。

### A2. canvas 元素的 `font-synthesis: none` 关掉合成粗体
```js
canvas.style.fontSynthesis = 'none';
```
实测（只声明了 `weight: 400` 的 face，请求 700）：墨量原为 5513，合成粗体后变为 7194，设为 none 后回到 5513。写在 `@font-face` 描述符里**无效**，必须设在 canvas 元素上。合成策略因平台和版本而异，两台机器渲染出来的粗细会不同；关掉合成之后，要 700 就必须真的有 700 字重的字面（或者使用可变字体）。

## B. 标准行为，但容易用错

| 行为 | 实测 | 后果 |
|---|---|---|
| ctx.font 中的数字字重对可变字体是**连续**的 | 650 / 651 时分别为 257.22 / 257.28 | 字重可以直接随 t 做动画，不需要用 A1 的方法 |
| `ctx.fontStretch` 只接受 9 个关键词 | 设为 `'75%'` 后读回仍是上一个值 `condensed` | 字宽无法做连续动画，要用 A1 的 `wdth` 轴 |
| `document.fonts.check(不存在的字族)` 返回 **true** | `check('80px "NoSuchFamilyXYZ"')` 返回 true，`load()` 返回 0 个 face | 字族名拼错照样"通过"，所以 `loadFonts` 改为检查 load 的返回值 |
| `document.fonts.ready` 只等待已经触发的加载 | （行为描述，出自规范） | canvas 第一次 fillText 之前没有任何东西触发加载，第一帧会用回退字体 |
| 合成粗体**不改变 advance** | 400 和 700 都是 241.52 | measureText 测不出合成粗体，只能数墨水像素 |
| 逐字 measureText 相加不等于整串测量 | Inter 80px 的 `AVATAR Wave Type`：逐字相加 727.54，整串 679.73（相差 47.81） | 拆字时必须用前缀测量 |
| CJK 字符与全角标点的 advance 为 1em | 40px 下全部是 40 | 标点挤压要自己实现 |
| unicode-range 分片只加载用到的分片 | 测试片共 101 片，只加载了 14 片 | `loadFonts` 必须传入全部文案 |
| 未挂载的 canvas 上，CJK 回退字体不随 generic family 变化 | `画` 在 serif 和 sans-serif 下像素相同；挂载后不同 | 缺字检测必须使用挂载到文档里的 canvas（`missingGlyphs` 已处理） |
| `font-optical-sizing: auto` 默认开启 | 80px 下的基线宽度等于 opsz 32 时的宽度 | 做字号动画时 opsz 随字号变化，字形会轻微改变 |

## C. 假阴性清单（"不支持"之前先查这里）

| 结论 | 错在哪 | 正确测法 |
|---|---|---|
| "可变轴在 canvas 里不生效" | 用静态字体测试 | 用 fvar 里真有该轴的字体测试（用 `fontTools` 查看 axes） |
| "font-variation-settings 不影响 canvas" | 设置后没有重新赋值 `ctx.font` | 设置后执行 `ctx.font = …` 再测 |
| "没有合成粗体" | 用 measureText 测；或者用可变字体测（可变字体的 700 是真字重） | 用只有单一字重的 face，并数墨水像素 |
| "font-synthesis:none 无效" | 写在了 @font-face 里 | 写在 canvas 元素的 style 上 |
| "缺字检测没发现缺字" | 检测用的 canvas 没有挂进文档 | 挂载后比较 serif / sans-serif / cursive 三种回退的结果 |
| "中文小字号都分不清笔画" | 剖面取在字的中线上，正好压在竖画上 | 在多列上取剖面，取最大段数（legibility.mjs） |
| "字体加载成功" | 只看了 `fonts.check` | 看 `fonts.load()` 返回的 face 数量和状态 |
