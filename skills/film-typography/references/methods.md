# 文字手法详解

每条手法依次说明做法、参数、代价和代码。代码都是 `seek(t)` 里的片段。标有 **[已跑]** 的手法在 `tests/fixtures/_test-typography/scene.html` 里通过了 seamcheck；其余是用同一组基元写的片段，**没有单独验证**，使用前先在自己的片子里跑一遍 seamcheck。以下代码假设已有：

```js
import { sat, norm, settle, SPRING, seeded } from './runtime/motion.js';   // film-core
import * as T from './runtime/text.js';
import * as X from './runtime/textfx.js';                                   // unitProgress、typeSchedule/typedAt 等
const ease = (p) => 1 - (1 - p) ** 3;
// 加载时：ctx.font = F; const g = T.splitText(ctx, TEXT);   // [{ch, x, w}], g.totalWidth
```

目录：1 硬切 · 2 淡入淡出 · 3 遮罩升起 · 4 裁切滑入 · 5 逐字交错 · 6 打字机 · 7 乱码解码 · 8 字重渐变 · 9 轴动画 · 10 笔画顺序 · 11 描边生长 · 12 缩放冲击 · 13 字作遮罩 · 14 逐词高亮 · 15 模糊对焦 · 附：出场、组合

## 1. 硬切
`if (t >= t0) ctx.fillText(…)`。硬切在 seek 栅格上表现为"在某一帧出现"，t0 最好落在帧边界上，否则用不同 fps 渲染时，文字出现的帧会不同。

## 2. 淡入 / 淡出 **[已跑：段落出场]**
`globalAlpha = ease(norm(t, t0, t0 + 0.4))`。alpha 相当于把墨量覆盖率乘以 alpha，所以过渡过程中的有效对比度可以用 measurements.md §3 的同一算法估算（未单独实测）。

## 3. 遮罩升起 **[已跑]**
```js
const IN = (i) => X.unitProgress(t, i, { start: 0.2, dur: 0.5, stagger: 0.04, ease });
T.drawRiseIn(ctx, g, t, { x, y, size, align: 'center', rise: 1.2, progress: IN });
// 出场：沉回遮罩
T.drawRiseIn(ctx, g, t, { x, y, size, rise: 1.2, progress: (i) => IN(i) * (1 - ease(norm(t, 3, 3.6))) });
// 出场：向上离开遮罩 —— 用 dir:-1 并让 p 从 1 走到 0
```
参数：`rise` 是位移量（字号的倍数，必须给出）；`progress(i)` 返回每段已缓动的进度（必须给出，交错与缓动都在这里实现）。中文逐字交错取 0.03–0.05 s，英文逐词交错更自然。代价：升起过程中字被裁掉一半，可读性损失中等；遮罩矩形默认高 `size*1.5`，带降部的字母（gjpqy）和带上标的中文标点可能被裁掉，这时要调整遮罩，或改用 `progress` 加大。

## 4. 裁切滑入
固定一个窗口 `ctx.rect(x, y - size, g.totalWidth, size * 1.3); ctx.clip()`，把文字画在 `x - (1 - p) * g.totalWidth`，让它从左侧滑进窗口。代价：方向必须与画面运动一致（镜头往右推时，字从右边进来就会冲突）。整行一起动比逐字动的开销小，可读性损失中等。

## 5. 逐字交错（位移 / 缩放 / 旋转）
```js
// 加载时：lay = X.layoutText(ctx, TEXT); rnd = seeded(7); order = lay.units.map((_, i) => i).sort(() => rnd() - 0.5)
X.drawUnits(ctx, lay, x, y, (u, i) => {
  const p = X.unitProgress(t, i, { start: t0, dur: 0.5, stagger: 0.03, order, ease });
  return p <= 0 ? null : { rot: (1 - p) * 0.4, sx: p, sy: p };      // 现成预设见 textfx.md §2 的 IN.*
});
```
代价：总时长为 dur + (n-1)·stagger，长句很容易超过 1.5 s，观众读到一半时字还没出完。乱序必须使用 `seeded()`（`Math.random` 违反契约）；`sort(() => rnd()-0.5)` 的分布不均匀但结果确定，要均匀分布就用 Fisher–Yates。

## 6. 打字机 **[已跑]**
使用运行时的 `typeSchedule` / `typedAt` / `cursorOn`（textfx.md §5）：加载时排好每个单元的出现时刻，seek 里用 `typedAt(t, SCHED)` 取已打出的字数，光标闪烁也是 t 的函数。代价：匀速打字时节奏被字数绑定（可以传 `pauses` 让标点处停顿）；可读性损失低。`typedAt` 每变化一次就对应一次 tick 音效（参见 film-narration 的音效部分）。多行文本先用 `wrapCJK` 断好行，再把时间预算逐行分配（见测试片）。

## 7. 乱码解码（scramble）
使用运行时的 `scramble`（textfx.md §4）：替换字只取决于 (seed, 单元, t)，画在最终字的位置上，不会推开后面的字。代价：可读性损失高（解码完成前读不出来），但记忆点也高。替换字宽度不同会导致左右抖动，解决办法是按最终字的 x 坐标放置，或者使用等宽字体；中文的替换池要用同字号的汉字，否则宽度和灰度都会跳变。

## 8. 字重渐变 **[已跑]**
```js
const w = 100 + 800 * ease(norm(t, t0, t0 + 1.2));
ctx.font = `${w} ${size}px "X Variable"`;                  // 标准行为，连续
const gw = T.splitText(ctx, WORD);                         // 字重变了 advance 也变，重新测
T.drawRiseIn(ctx, gw, t, { x: cx, y, size, align: 'center', rise: 1.2, progress: () => 1 });
```
代价：字重增大时字会变宽（Inter 80px 从 400 到 900，宽度从 241.5 px 变为 276.4 px），整行被推开。解决办法有两种：每帧重新测量并重新居中（测试片的做法，仍然是 t 的纯函数）；或者只对行里孤立的一个词做动画，并为它预留宽度。
字体必须是可变字体，且 `@font-face` 声明了字重范围（fontsource 的 `font-weight: 100 900`）；静态字体会跳档或者触发合成粗体。

## 9. 轴动画（wdth / opsz / slnt / 自定义）**[已跑：opsz]**
```js
T.setAxes(ctx, { wdth: 75 + 50 * p, slnt: -10 * p }, `${size}px "Roboto Flex Variable"`);
ctx.fillText(TEXT, x, y);
T.clearAxes(ctx, nextFont);                                 // 别让轴设置泄漏到后面画的字
```
代价：这是**非标准行为**（见 chromium.md A1）；字体必须真的有该轴（用 `fontTools` 查看 fvar：`python -c "from fontTools.ttLib import TTFont;print([a.axisTag for a in TTFont('x.woff2')['fvar'].axes])"`）。
`font-variation-settings` 里的 `wght` 会覆盖 ctx.font 中的字重。wdth 变化同样会推开整行。

## 10. 笔画顺序（书写）
思路：`hanzi-writer-data` 为每个字提供 `strokes`（轮廓 SVG path）和 `medians`（中线点列）。对第 k 笔，用 `Path2D(strokes[k])` 做 clip，沿 `medians[k]` 画一条粗线，线长随进度增长。
```js
// data = 预加载的 JSON（素材来源与许可：参见 film-assets skill —— 它不是 MIT）
// 字形坐标系是 1024 单位、y 轴向上：ctx.translate(x, y); ctx.scale(s, -s); ctx.translate(0, -900)
data.strokes.forEach((d, k) => {
  const p = sat((t - t0) / 0.35 - k);                       // 每笔 0.35 s 依次
  if (p <= 0) return;
  ctx.save(); ctx.clip(new Path2D(d));
  const pts = data.medians[k]; const n = Math.max(2, Math.ceil(pts.length * p));
  ctx.lineWidth = 140; ctx.lineCap = 'round'; ctx.beginPath();
  pts.slice(0, n).forEach(([px, py], j) => (j ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.stroke(); ctx.restore();
});
```
**未验证**。代价：实现成本高；只覆盖数据集里有的字（常用简繁汉字），字形是数据集的楷体风格，与片子使用的字体不一致。

## 11. 描边生长 → 填充
思路：用 opentype.js 的 `font.getPath(text, x, y, size).toPathData()` 得到路径数据，再转成 `Path2D`；用 `ctx.setLineDash([L*p, L])` 控制描边长度，L 用离屏 `SVGPathElement.getTotalLength()` 计算（未挂载也能测量，本 skill 未复测）。
p 到 1 后，再用填充淡入或遮罩升起。代价：轮廓是闭合外形，描出来的是"空心字外框在生长"，而不是沿笔画中线书写；中文字的轮廓段数多、L 很大，用 `setLineDash` 一次画完会显得"多处同时生长"，按子路径逐段延迟更像书写。**未验证**。

## 12. 缩放冲击
```js
const s = settle(t - t0, SPRING.playful.stiffness, SPRING.playful.damping);   // 闭式弹簧（film-core motion.js）
ctx.save(); ctx.translate(cx, y); ctx.scale(s, s); ctx.textAlign = 'center'; ctx.fillText(NUM, 0, 0); ctx.restore();
```
代价：过冲量由弹簧参数决定，用在正文上容易显得廉价，用在数字或结论上记忆点高；s<0.5 的那几帧字号低于可读下限。

## 13. 字作遮罩 / 字里透画面
先在离屏 canvas 上 `drawImage(画面层)`，再设置 `globalCompositeOperation = 'destination-in'` 后 `fillText`（字形之外的部分全部清掉），最后画回主 ctx。
OffscreenCanvas 上不能用 `setAxes`/`disableFontSynthesis`（没有 canvas 元素），需要轴时改用隐藏的 `<canvas>` 元素。代价：小字号时透出的纹理会让字更难读，通常要配合粗字重和大字号。

## 14. 逐词高亮（字幕式）
`drawCaption(ctx, vo.captionAt(t), { style: (i, state, p) => ({ fill, dy, axes }) })`，用法见 SKILL.md「字幕绘制」。
代价：时间轴必须来自 narration.json（film-narration）。如果 `style` 返回 `axes: { wght: … }` 让当前词做字重渐变（非标准行为，见第 9 条），当前词会变宽；而 `layoutCaption` 按 `font` 的基础字重测量，加粗的词会和下一个词挤在一起。解决办法是给词间留出空隙，或者改用颜色、位移来高亮。**没有接入真实的 narration.json 运行过。**

## 15. 模糊对焦
``ctx.filter = `blur(${(1 - p) * size * 0.15}px)` ``，画完后复位为 `'none'`（对应运行时的 `IN.blur`）。代价：`ctx.filter` 在软件渲染（SwiftShader）下很慢，大字加上大模糊半径会明显拖慢逐帧渲染；模糊过程中完全读不出文字。

## 出场

- 任何入场手法反过来用就是出场：把 p 乘以 `1 - ease(norm(t, out0, out1))`（对应运行时的 `OUT(入场预设)`）。
- 出场和入场一样长时，代价是占用下一条信息的入场时间；出场明显更快（测试片短 30–50%）时节奏利落，代价是出场本身没有记忆点。需要让出场表达意义时（例如"这件事消散了"），值得放慢。
- 循环片：所有出场都要在 `DURATION - 1/fps` 之前完成，首帧与末帧相同（测试片在 3.7 s 结束，4 s 循环一次）。

## 组合

- 用**不同手法**区分主次（测试片中主标题用遮罩升起，正文用淡出），代价是画面语言变杂；用同一手法的不同速度区分，代价是速度差不够大时分不出主次。
- 同时运动的文字块越多，视线越没有落点，代价是观众每块都只读到一半；故意制造"信息过载"时值得付这个代价。
