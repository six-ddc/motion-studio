# 风格化后期与调色：能力菜单

目录：1 怎么接 · 2 单 pass 效果 · 3 调色（lift/gamma/gain、3D LUT） · 4 多 pass 效果（泛光、halation、变形镜头拉丝） · 5 对细线与小字的影响 · 6 没做的

这是一张菜单，不是推荐：每项写"它是什么、参数、代价"。用不用、用哪个、取什么值由本片 `docs/style_guide.md` 决定。
片段全部在 `assets/runtime/fxglsl.js` 的 `STYLIZE`（`assets/templates.mjs` 转导出同一份）。**没有任何参数有默认值**：全是 uniform，每帧全量传。

耗时：单次 render，SwiftShader，16 线程 M3 Max，输入是一张静态纹理（不含 2D 画面上传的约 2 ms）。测时机器 1 分钟负载 3–8；仓库 docs/verified/film-webfx.md「fxchain」一节有原始输出。

## 1. 怎么接

```js
import { createPass, HEADER } from './runtime/fxchain.js';
import { STYLIZE } from './runtime/fxglsl.js';
import { GLSL } from './runtime/webfx.js';
const fx = createPass({ width: L.width, height: L.height, scale: 0.5, frag: HEADER + GLSL.hash + STYLIZE.dither, in: { u_src: 'src' } });
// seek 里：
fx.texture('src', canvas2d);
fx.render(t, { u_pixel: …, u_spread: …, u_noise: …, u_frame: Math.round(t * fps), u_pal: [/* 传满 8 个 vec3 */], u_npal: … });
fx.drawTo(ctx);
```

- 单 pass 模板体只用 `TEX` / `OUT` 宏和 GLSL ES 1.00 语法，拼 `GLSL.header`（`createShaderLayer` WebGL1）、`GLSL.header2` 或 fxchain 的 `HEADER` 都能编（`lut3d` 除外，只能 WebGL2）。
- 用 `createPass` / `createChain` 时漏传参数会抛错（`fxchain.md` §6）；用 `createShaderLayer` 时 GL 会静默沿用上一次的值，要自己传满。
- 输入是预乘色（2D canvas 上传后就是预乘的），输出也是预乘色。半调、抖动、描边、ASCII、Kuwahara 输出不透明（alpha 1）。
- 逐帧变化的噪声只按帧号播种：`u_frame = Math.round(t * fps)`（同一帧的运动模糊子帧噪声相同）。
- 降分辨率（`scale: 0.5`）后成本约 1/4，但这几类效果的颗粒（网点、抖动格、像素格、字形）尺寸以**本层像素**计，放大回原尺寸时颗粒也跟着放大、边缘被双线性糊掉；要锐利的格子，用全分辨率或 `drawTo(ctx, {smoothing:false})`。

## 2. 单 pass 效果

| 模板 | 是什么 | 参数 | 1080×1920 / 540×960 |
|---|---|---|---:|
| `halftone` | 旋转网格上每格一个圆点，面积 ∝ 1 − 亮度；查本格与 8 邻格，暗部大点跨格不被截平 | `u_cell` 格宽 px、`u_angle` 网角（弧度）、`u_soft` 点边羽化 px、`u_ink` `u_paper` 两色、`u_color`（0 墨色，1 点取原色） | 27.6 / 7.0 ms（9 次取样） |
| `dither` | 8×8 Bayer 有序抖动 + 调色板最近色量化（sRGB 欧氏距离）；`u_noise` 往白噪声混 | `u_pixel` 抖动格 px、`u_spread`（≈ 调色板相邻色间距时过渡最平滑，小了出色带、大了满屏噪点）、`u_noise` 0..1、`u_frame`、`u_pal[8]` 传满、`u_npal` 用前几个 | 7.5 / 2.0 ms |
| `pixelate` | 按格取样；`u_avg` 0 取格心一点，1 取格内 4 点平均 | `u_cell` px、`u_origin` 网格原点 px、`u_avg` | 8.7 / 2.4 ms |
| `outline` | Sobel 亮度梯度 → `smoothstep(thresh, thresh+soft)` → 线色 | `u_width` 取样间距 px（越大线越粗越"晕"）、`u_thresh` `u_soft`、`u_line` `u_paper`、`u_keep`（0 线画在纸色上，1 叠在原图上） | 13.9 / 3.6 ms（9 次取样） |
| `kuwahara` | 经典四象限 Kuwahara：取方差最小的象限均值，平涂、保边，油画感 | `u_radius`（取整，≤ 编译期 `KMAX`）；拼接时在模板前写 `#define KMAX r` | r=2：60.9 / 15.5 · r=4：156 / 39 · r=6：301 / 73 ms |
| `ascii` | 每格取亮度挑 10 个程序化 5×5 字形之一（按墨量排）；字形编在着色器里，不用字体文件 | `u_cell` px（取 6 的倍数字形像素对齐）、`u_ink` `u_paper`、`u_color` | 6.5 / 1.8 ms |
| `lens` | 径向多项式畸变 f = 1 + k1 r² + k2 r⁴（角上 r=1）；R / B 用 (1 ∓ disp) 的 f 做边缘色散 | `u_k1`（> 0 桶形，< 0 枕形）、`u_k2`、`u_zoom`（> 1 把桶形推出画面的边拉回来）、`u_disp`、`u_edge` 出界色（预乘 vec4） | 7.9 / 2.1 ms |

Kuwahara 是这张表里唯一的成本悬崖：成本 ∝ 4(r+1)²。r=4 全分辨率 156 ms，比截图（≈50 ms）贵 3 倍；半分辨率 39 ms。夹具里 360×480 的格子 r=4 观感已经明显（`tests/fixtures/_test-fxchain/scene-stylize.html`）。第一版写法（−r..r 双重循环里四个 if 分象限）同参数慢约 2 倍，现在的写法每圈同时取 4 个对称点。
ASCII 的成本几乎全是一次取样，但字形只有 10 个且固定为 5×5 点阵；要真字体的字形得把字画进一张随片字体的图集再查表（没做，要过字体来源门）。

## 3. 调色

| 模板 | 是什么 | 参数 | 1080×1920 / 540×960 |
|---|---|---|---:|
| `grade_lgg` | 在反预乘颜色上：`c·2^exposure` → `gain·(c + lift·(1−c))` → `c^(1/gamma)` → 饱和度 | `u_lift` `u_gamma` `u_gain`（vec3）、`u_exposure`、`u_sat`。恒等值 lift 0 / gamma 1 / gain 1 / exposure 0 / sat 1 是数学上的"不变"，不是推荐值 | 7.4 / 1.9 ms |
| `lut3d` | 3D LUT，WebGL2 `sampler3D`，硬件三线性 | `u_lut`（`chain.lut('lut', parseCube(text))` 建，RGBA16F）、`u_mix` | 9.0 / 2.4 ms |
| `lut_strip` | 同一个 LUT 摊成 2D 条带（宽 n²、高 n、8 位），b 方向手工插值；WebGL1 / `createShaderLayer` 可用 | `u_lut`（`cubeCanvas(cube)` 上传）、`u_lutn`、`u_mix` | 7.7 / 2.1 ms |

- `parseCube(text)`（fxchain.js 导出，纯函数）：只认 `LUT_3D_SIZE` 与 [0,1] 定义域，`LUT_1D_SIZE` 或别的 `DOMAIN_*` 抛错；行数不对抛错。LUT 文件放片子 `assets/`，在 `window.ready` 里 fetch 完再解析（没 await 完就是门 1b 的那类加载期问题）。素材授权参见 film-assets。
- 两条路实测同一 17³ LUT、256×256 输入：逐通道最大差 1/255、平均 0.073/255（来自 8 位条带的量化）。条带的代价是 LUT 本身只有 8 位精度：暗部陡曲线会出色阶断层；`lut3d` 存 16 位浮点。
- LUT 和 lift/gamma/gain 都假定输入在 [0,1]（显示参考）；接在 HDR 目标后面时先做色调映射（webfx 模板 `grade` 里有 Reinhard），否则 > 1 的部分被 clamp。

## 4. 多 pass 效果（`createChain`，积木都在 `STYLIZE`）

| 积木 | 作用 | 参数 | 1080×1920 / 540×960 |
|---|---|---|---:|
| `extract` | 按 max(r,g,b) 过 `smoothstep(thresh, thresh+knee)` 取亮部 | `u_thresh`、`u_knee` | 4.2 / 1.2 ms |
| `down4` | 4 点双线性降采样（等于 4×4 盒式平均），比直接用低分辨率目标线性取样少闪烁 | `u_src_size`（fxchain 自动传） | 没单独计时（含在下面泛光整条链里） |
| `blur9` | 9 tap 二项式一维模糊，`u_dir` 为每 tap 步长（本 pass 像素） | `u_dir` | 13.7 / 3.6 ms（全分辨率一遍） |
| `glow_mix` | `src + amount·tint·mix(glow, luma(glow), mono)`，glow = max(模糊 − ring·亮部, 0) | `u_tint` `u_amount` `u_ring` `u_mono` | 合成一遍，与 T0 同档 |

| 组合 | 接法 | 整条链 1080×1920 / 540×960 |
|---|---|---:|
| 泛光 | extract(½) → down4(¼) → blur9 横 → blur9 竖 → glow_mix（ring 0、mono 0） | rgba16f 17.7 / 4.9 ms；rgba8 11.0 / 3.2 ms |
| halation（高光外圈红晕） | 同一份 extract → 小半径横竖模糊 → glow_mix：mono 1、偏红 tint、ring > 0（扣掉亮部本身，只留外圈） | 结构同泛光，没单独计时 |
| 变形镜头横向拉丝 | extract 到扁目标（如 `scale:[0.5, 1/16]`）→ blur9 只横向三遍，步长 1 → 3 → 9（每遍覆盖约 9 倍） → glow_mix（mono 按需） | 12.7 / 3.6 ms |

- 半径主要靠降采样换：¼ 分辨率上一遍 blur9 步长 2 ≈ 全分辨率 72 px 跨度，而成本是全分辨率一遍的 1/16。半径太大、分辨率太低时亮部会出方块状光斑（用 `down4` 而不是直接线性取样能减轻）。
- HDR 中间目标（rgba16f）比 rgba8 每条链多约 7 ms（全分辨率）；值得付的时候是阈值要 > 1 或多次叠加会截断时。
- 同一条链里多个效果共用 extract（夹具里泛光和 halation 共用一份），省一遍全屏。
- 这三样都是加法合成，假定 `src` 不透明；要叠在透明层上，先合到底色再过链。

## 5. 对细线与小字的影响（夹具 360×480 一格里的 1px / 2px 线放大看）

| 效果 | 细线怎么样 | 代价换算 |
|---|---|---|
| 半调 `u_cell` 9 | 1px 线并进网点，只剩一条略深的点带；小字不可读 | 要保留的字压在半调层之上另画 |
| 抖动 `u_pixel` 3 | 1px 线断成虚线，2px 线基本连续 | 线宽 ≥ 抖动格宽才连续 |
| 像素化 `u_cell` 12 | 间距 9px 的六条线并成两条糊带（`u_avg` 1）；`u_avg` 0 时线按落点整格出现或整格消失，随运动闪 | 字号要 ≥ 数个格宽 |
| Sobel 描边 | 每条线变成两条边线（线的两侧各一个梯度峰） | 已经是线稿的内容不该再描边，除非就要双线 |
| Kuwahara r4 | 1–2px 线几乎被抹掉（象限均值把线当噪声） | 半径 r 下宽度 < r 的线和笔画都会消失 |
| ASCII `u_cell` 12 | 线变成一行行字符 | 原文字不可读，本就是替换 |
| 镜头畸变 | 线弯曲，边缘出 R/B 色边（`u_disp`） | 小字在画面边缘会发虚发彩 |
| LGG / LUT / 泛光 / halation / 拉丝 | 线保持，只改颜色；泛光 / 拉丝会把亮底上的线吃掉一部分 | — |

## 6. 没做的

- CMYK 四色分版半调（四个网角各一次）：没做，单色 / 取原色两种模式。
- 误差扩散抖动（Floyd–Steinberg）：串行算法，没有着色器版本；有序抖动和蓝噪声纹理（自备一张静态纹理替换 Bayer）是可行的替代。
- 各向异性 Kuwahara（沿结构张量方向的椭圆核）：没做，比经典版贵数倍。
- halation 链没单独计时；Metal 后端下的耗时与像素差没测。
