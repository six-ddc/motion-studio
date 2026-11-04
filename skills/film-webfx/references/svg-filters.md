# SVG 滤镜：能力与确定性实测

复现方法（仓库开发工具）：`node dev/film-webfx/svgfilter-check.mjs`（1080×1920，对截图 PNG 计算 md5，用两个独立的浏览器各跑一次）。

## 实测结论（Chromium 156 / Playwright 1.64）

| 问题 | 结论 | 证据 |
|---|---|---|
| 同样的参数截两次图，结果一致吗？ | ✓ | `feTurbulence(4 oct) → feDisplacementMap → feGaussianBlur` 这条链两次的 md5 相同 |
| 乱序 A→B→A 后能回到同样的像素吗？ | ✓ | 把 seed/baseFrequency/scale 改成 B 再改回 A，md5 相同 |
| 两次独立启动的结果一致吗？ | ✓ | 6 组状态的 md5 全部相同 |
| `seed` 起作用吗？ | ✓ | seed=1 与 seed=2 的输出不同 |
| seed 取小数会怎样？ | **截断取整** | seed=1、1.4、1.6 三者的 md5 完全相同 |
| seed≤0 会怎样？ | 按规范映射 | seed=0 等价于 seed=1，seed=-1 等价于 seed=2（符合 Filter Effects 规范对 lSeed≤0 的处理） |
| `baseFrequency` 做微调时输出连续吗？ | ✓ | 从 0.008 改到 0.0081，输出不同且可重复 |
| 2D `ctx.filter='url(#id)'` | ✓ 结果可重复，seed 生效 | 但每次要 96 ms（含 getImageData） |
| 与 `--use-angle=metal` 的关系 | 未测 | 它不经过 GL 后端选择 |

## 怎么让它"动"

- **跳变式**（手绘线条「沸腾」、定格动画式抖动）：`seed = Math.floor(t * 12) + base`。按整数步进，正好利用了截断取整的行为。由于 seed 只能取整数，**不可能对 seed 做插值**。
- **连续式**：调整 `baseFrequency`（产生缩放感）、`feDisplacementMap scale`（控制强度），或者用 `transform` 平移被滤镜作用的元素（让噪声场相对于内容滑动）。这些都是在 `seek(t)` 里调用 `setAttribute`，满足纯函数要求。
- 想要像 `loopFbm` 那样原地连续演化而不是平移的噪声，SVG 做不到，要用着色器。

## 成本

| | 截图 1080×1920 |
|---|---|
| 无滤镜 | 51 ms |
| turbulence(4 层) + 置换 + 模糊 | 64 ms（+13） |
| 同上 numOctaves=8 | 83 ms（+32） |

成本随 `numOctaves` 线性增长，这一点与着色器里的 fbm 相同。滤镜区域（`x/y/width/height`）越小越省。

## 和 WebGL 的取舍

SVG 滤镜直接作用于 SVG/DOM 元素，没有编译成本，但时间参数只能通过属性值传入，primitive 也是固定的（没有 domain warp，不能写自定义函数），转到 2D 还要 96 ms。着色器只能作用于纹理，首帧编译需要 20–80 ms，还要固定渲染后端，但转到 2D 用 `drawImage` 只要 5 ms。判断方法：**场景本来就是 SVG/DOM，效果也是噪声置换、模糊这类标准 primitive** 时，用 SVG 滤镜；场景是 canvas，或者需要自定义像素函数时，用着色器。不要为了使用 SVG 滤镜而把 canvas 场景套进 `ctx.filter='url()'`。

SVG/DOM 场景如果用了 CSS 动画或 WAAPI，要声明 `window.USES_WAAPI`（见 film-core `references/kernel.md` §1）；本页的做法是每帧调用 `setAttribute`，不涉及动画时间线。
