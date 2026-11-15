# 片元着色器：时间、噪声、光线步进、置换

目录：1 时间怎么进着色器 · 2 噪声、fbm、domain warp、curl · 3 光线步进 SDF · 4 置换类扭曲（水波、热浪、玻璃、液化） · 5 坑

耗时均为 1080×1920、SwiftShader、单次 `render()`，本仓库实测。拼接顺序 `GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + 你的 main`（WebGL2 把 header 换成 `header2`，主体不用改）。

## 1. 时间怎么进着色器

| 需求 | 写法 | 原因 |
|---|---|---|
| 线性演化 | `fbm(p + vec2(0., .3*u_time))` | u_time 就是 t |
| 循环片（首尾帧一致） | `createShaderLayer({period: D})` + `loopFbm(p, u_time/u_period, r)` | JS 用 double 取模，t=D 时 u_time 精确为 0；loopNoise 把相位映射到圆上，首尾帧逐像素一致（实测过门 3） |
| 每帧换一次的颗粒 | `u_frame = Math.round(t*fps)`，`hash12(gl_FragCoord.xy + 17.*u_frame + u_seed)` | 颗粒按帧跳变，不随 t 连续漂移；同一帧的运动模糊子帧颗粒相同 |
| 高频振荡、长片 | JS 里算 `phase = (t*f) % 1` 传 `u_phase` | t 大时 float32 不够 |
| 念到某个字时触发 | JS 里 `p = norm(t, vo.at('X'), vo.at('X')+0.6)` 传 `u_p` | 时刻来自 film-narration；着色器只接 0–1 进度 |

循环噪声的原理：把相位 φ 放到半径 r 的圆上，作为第三维喂 3D 噪声：`vnoise3(vec3(p.x, p.y + r·sin 2πφ, r·cos 2πφ))`。r 越大一圈里变化越多；>2 时看得出"转圈"。同理可用 4D 噪声把二维相位放到环面上。

## 2. 噪声、fbm、domain warp、curl

**value noise**：格点 hash 值，`f*f*(3-2f)` 平滑插值。便宜，但有方格感。**gradient / simplex noise**：格点放随机梯度，各向同性更好，每次贵约 1.5–2 倍；如需，lygia 的 `generative/` 有现成的 snoise / cnoise / worley。

**fbm**：`Σ aⁱ·n(Mⁱ p)`，a≈0.5；每层乘一个带旋转的矩阵（如 `mat2(1.6,1.2,-1.2,1.6)`）而不只是 ×2，能消掉轴向条纹。
- 代价：每层约占 20%（5 层 5.3 ms）。超过 6 层在 1080 宽画面上基本看不出差别。
- 远处/缩小时高频层只会变成闪烁：按像素足迹（`fwidth(p)`）截断层数，这比多算更好看。

**domain warp**（流体、大理石、墨流）：`q = fbm(p)`，`r = fbm(p + 4q)`，`f = fbm(p + 4r)`。三重 = 15 次 noise，21 ms；半分辨率 5.4 ms，内容低频，降分辨率几乎无损。
- 时间加在 q、r 的偏移里（两处速度不同），比加在 p 上更像"流动"而不是"平移"。
- `dot(q,q)`、`length(r)` 是现成的第二、三个通道，拿来混色比再算一遍噪声便宜。

**curl noise**（流场条纹、风向）：`curl(p) = (∂n/∂y, −∂n/∂x)`，中心差分要 4 次 fbm，19 ms；得到无散度速度场。
- 只**画**流场：方向色、沿方向的正弦条纹。粒子沿流场积分属于状态推进，走 film-physics 的重放，或 fxchain 反馈（fxchain.md）。GLSL float32 与 JS double 不能逐位一致，粒子位置以 JS 为准，着色器只负责画。

**worley / 细胞噪声**：取最近（或次近）特征点距离 F1、F2；`F2−F1` 得到裂纹/细胞边。每像素查 3×3（2D）或 27（3D）个格子，比 value noise 贵数倍。

## 3. 光线步进 SDF

`d += sdf(ro + rd·d)`，直到 `h < ε·d` 或 `d > far`；法线用中心差分 6 次求值，或四面体法 4 次。SDF 组合：`min` 并、`max` 交、`smin`（多项式平滑并）做融合；`mod` 重复空间；软阴影沿光线再步进一次取 `min(k·h/t)`。

| 内容 | 1080×1920 |
|---|---:|
| 64 步 + 法线 + 一盏灯 | 40 ms |
| fbm 高度场地形，每步一次 5 层 fbm，最多 96 步 | 144 ms（半分辨率 36 ms） |

- 成本 ≈ 步数 × SDF 复杂度。大面积天空/背景的画面提前 `break` 能省一半以上。
- 地形是**性能断崖**：每步一次 fbm。真要用：降分辨率、松弛步长（`d += 0.5h`）、远处用更少层的 fbm。
- 要场景图、PBR、阴影图、模型时用 three（three.md），SDF 适合"一个数学形体就是整个画面"的场合。
- 参考写法如需：Inigo Quilez 的 SDF 函数集与 smin、lygia 的 `sdf/`、`lighting/raymarch`。

## 4. 置换类扭曲（吃 2D 层当纹理）

原理都是 `TEX(u_src, v_uv + offset(v_uv, t))`，区别只在 offset：

| 效果 | offset | 备注 |
|---|---|---|
| 噪声置换、液化 | `(vnoise2(p + t) − .5)·amp` | 6.6 ms；amp 单位是 uv（0.03 ≈ 画宽 3%） |
| 水波 | `dir·sin(dot(uv,dir)·k − ω·t)·amp`，多方向叠加；同心波用 `normalize(uv−c)·sin(|uv−c|·k − ωt)` | 振幅随距离/时间衰减；起波时刻挂 `vo.at` |
| 热浪 | 只在 y 方向偏移，噪声向上移动，幅度按热源遮罩 | 低频、半分辨率即可 |
| 玻璃、透镜 | 用一张 SDF/高度图的梯度作偏移方向，`offset = ∇h·η` | 边缘再叠菲涅耳高光和色散（R/B 用不同 η）才像玻璃 |
| 涟漪法线 → 光照 | 先算高度场导数，再用它同时做偏移与高光 | 一次导数两处用 |

- 内容每帧变就每帧 `texture()` 上传，1080×1920 约 2 ms；内容静止用 `static` 只传一次（compositing.md §2）。
- 采样越界时 CLAMP_TO_EDGE 会把边缘拉成条纹：留边距，或让 amp 在边缘衰减。
- 预乘 alpha：偏移采样后原样输出即可；要在着色器里调色先反预乘（compositing.md §1）。
- 低频、作用于 SVG/DOM 元素的整块扭曲可用 SVG `feDisplacementMap`，不写 GLSL（compositing.md §4）。

## 5. 坑

- **不要用 `fract(sin(x)*43758.5453)` 做 hash**：sin 大参数在不同后端结果不同。用无 sin 的 hash（`GLSL.hash`）或整数哈希（`GLSL.pcg`，WebGL2）。
- **`u_seed` 混进坐标而不是混进 hash 结果**：`hash12(p + u_seed)` 换种子换整张图；`hash12(p) + u_seed` 只是平移了值。
- **循环片里的任何非周期项**（线性漂移、`u_time` 直接乘频率）都会让门 3 红；要循环，所有时间项都得以 period 为周期。
- **首帧 JIT 20–80 ms**：在 `ready` 里 `render(0)` 一次，别让第一帧的计时误导降级判断。
- 着色器里的 `for` 循环在 WebGL1 必须是常量上界；变上界写成常量上界 + `if (i >= n) break;`。
