# 着色器模板库

完整可运行的源码在本 skill 的 `assets/templates.mjs` 里（随安装分发；导出 `TEMPLATES` / `TIERS`，都是纯字符串，按名字取出模板体拷进片子）。仓库开发工具 `dev/film-webfx/bench.mjs`（不随安装分发）每次都会编译、计时，并校验「同一个 t 结果可重复、跨启动结果一致」。
本页只讲怎么接入和代价。拼接顺序为 `GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + 模板体`（WebGL2 时把 header 换成 `header2`，模板体不用改）。耗时均为 1080×1920、SwiftShader、单次 `render()` 的结果。

## 时间怎么接（所有模板通用）

| 需求 | 写法 | 原因 |
|---|---|---|
| 普通的线性演化 | `fbm(p + vec2(0., .3*u_time))` | u_time 就是 t，直接使用即可 |
| 循环片（首尾帧一致） | `createShaderLayer({period: D})` 加 `loopFbm(p, u_time/u_period, r)` | JS 用 double 取模，t=D 时 u_time 精确为 0；loopNoise 把相位映射到圆上，首尾帧逐像素一致（`loop_fbm` 实测 loopSeam 通过 ✓） |
| 每帧换一次的颗粒 | uniform `u_frame = Math.round(t*fps)`，`hash12(gl_FragCoord.xy + 17.*u_frame + u_seed)` | 颗粒必须按帧跳变，而不是随 t 连续漂移；按帧号取种子，可以保证同一帧的各个子帧（运动模糊）颗粒相同 |
| 高频振荡、长片 | 在 JS 里算 `phase = (t*f) % 1`，传入 `u_phase` | t 很大时 float32 精度不够 |
| 事件触发（念到某个字时） | 在 JS 里算 `p = norm(t, vo.at('X'), vo.at('X')+0.6)`，传入 `u_p` | 时刻来自 narration，参见 film-narration；着色器只接收 0 到 1 的进度值 |

## 噪声与图案

### `loop_fbm` — 循环 fbm（9.7 ms）
`loopFbm(p, phase, r)`：5 层，每层调用一次 `vnoise3`。`r` 是相位圆的半径：越大，一个循环里的变化越多；太大（>2）时会看出「转圈」的感觉。

### `t1_fbm` — 线性 fbm（5.3 ms）
每多一层，成本约增加 20%；超过 6 层后，在 1080 宽的画面上基本看不出差别。

### `t2_warp` — 三重 domain warp（21 ms）
`f = fbm(p + 4*r)`，`r = fbm(p + 4*q)`，`q = fbm(p)`。这是做流体、大理石、墨流的主要手段。把时间加在 q 和 r 的偏移量里（两处速度不同），比加在 p 上更像「流动」而不是「平移」。半分辨率下只要 5.4 ms，而且内容是低频的，降低分辨率几乎没有损失。

### `curl_field` — curl noise 流场（19 ms）
`curl(p) = (∂n/∂y, -∂n/∂x)`，需要 4 次 fbm，得到的是无散度速度场，可以直接可视化成条纹或方向色。粒子沿流场积分的做法参见 film-physics；GLSL 的 float32 与 JS 的 double 不能逐位一致，所以粒子位置以 JS 的计算为准，着色器只负责画出流场。

### `t3_raymarch` — SDF 光线步进（40 ms）
64 步，加上用中心差分求法线所需的 6 次求值。成本主要取决于步数乘以 SDF 的复杂度。对有大面积天空或背景的画面，提前 `break`（`h<1e-3 || d>30`）能省一半以上。

### `t5_terrain` — fbm 高度场步进（144 ms）
这是一个性能断崖：每一步都要算一次 5 层 fbm。确实要用时，可以降到 0.5 分辨率（36 ms）或减少步数。

## 位移与扭曲（吃 2D 层当纹理）

需要调用 `fx.texture('u_src', canvas)`。如果内容每帧都变，就每帧调用一次，1080×1920 每次上传约 2 ms。

### `displace` — 噪声置换（6.6 ms）
`TEX(u_src, v_uv + (noise2 - .5) * u_amp)`。`u_amp` 的单位是 uv（0.03 约等于画面宽度的 3%）。做水波时，把噪声换成 `sin(dot(uv, dir)*k - ω*u_time)`；做热浪时，只在 y 方向偏移，并让噪声向上移动；做玻璃时，用一张 SDF 的梯度作为偏移方向。采样越界时，CLAMP_TO_EDGE 会把边缘拉成条纹，解决办法是留出边距，或者让 `u_amp` 在边缘处衰减。

## 后期

### `chroma` — 色差（7.1 ms）
R、B 通道沿径向反向偏移，G 通道不动，共三次采样。

### `grade` — 色调映射 + 颗粒 + 晕影（6.3 ms）
依次做 Reinhard 色调映射、颗粒（按帧号 hash）和径向晕影，一遍完成。曲线、强度和形状由本片 style_guide 决定，模板只提供接口。

### `bright` — 泛光的亮部提取（4.1 ms）
用 `smoothstep(thresh, thresh+.1, luma)` 选出亮部。完整的泛光链见 compositing.md：先提取亮部，再在 1/4 分辨率下模糊（T4 档 270×480 只要 2.9 ms），最后用 `lighter` 叠回。

### `t4_blur25` — 5×5 采样模糊（41 ms）
同样的视觉半径，在 1/4 分辨率下只要 2.9 ms。2D 的 `ctx.filter='blur(Npx)'` 在半径 4–48px 范围内都约为 13–16 ms（`dev/film-webfx/blur2d-check.mjs`），普通的高斯模糊用它更省事。
