# 合成：WebGL × 2D、纹理缓存、混合模式、SVG 滤镜

目录：1 两个方向与预乘 · 2 纹理只传一次、mipmap / 各向异性 · 3 2D 混合模式与挖空 · 4 SVG 滤镜

## 1. 两个方向与预乘（实测 1080×1920）

| 方向 | 怎么做 | 成本 | 何时用 |
|---|---|---|---|
| 着色器 → 2D | `fx.render(t)` 后 `fx.drawTo(ctx)`（内部 `drawImage(glCanvas)`） | 5.2 ms | 着色器产出一层画面，交给 2D 挖空、混合、叠字 |
| 2D → 着色器 | `fx.texture('u_src', canvas2d)` 后 `fx.render(t)` | 上传约 2 ms；`static` 命中 0.1 ms | 对 2D 已画好的内容做置换、色差、调色、模糊 |
| 半分辨率层放大回全画幅 | `scale:0.5` + `drawTo` | high 26 / medium 12.5 / low 6.3 ms | 着色器本身超过约 25 ms 才划算 |

`drawTo` 默认 `imageSmoothingQuality='high'`；低频内容（烟、模糊、泛光）可以自己设 `'low'` 再 `drawImage`。
**同步性**：`drawImage(glCanvas)` 会隐式等待绘制完成，seek 里 `render → drawTo` 不需要 `finish()`。封装开了 `preserveDrawingBuffer:true`，render 之后隔多久 drawImage 都是同一帧。

**预乘 alpha**（边缘发亮或发黑最常见的原因）：
- context 默认 `premultipliedAlpha:true`，**着色器必须输出预乘色** `vec4(rgb*a, a)`。实测输出 `vec4(.4,.2,.1,.5)` 进 2D 读回 `[203,102,52,128]`：2D 把它当预乘值反预乘成了 (.8,.4,.2)。输出非预乘色会让半透明边缘发亮。
- 2D 转纹理时封装设了 `UNPACK_PREMULTIPLY_ALPHA_WEBGL=true`，采样得到预乘色；偏移采样后原样输出即可。在着色器里调色先 `rgb /= max(a,1e-5)`，调完乘回。
- `UNPACK_FLIP_Y_WEBGL=true`：`v_uv=(0,0)` 是左下角，对应 canvas 左下角。
- 三维舞台叠在 2D 上时同理：色调映射作用在预乘色上，半透明边缘亮度会略偏（没测量过）。

## 2. 纹理只传一次、mipmap / 各向异性

| 选项 | 什么时候不再上传 | 适合 | 代价 |
|---|---|---|---|
| 默认 | 从不跳过 | 每帧按 t 重画的 2D 层 | 1080×1920 每次约 2 ms |
| `static: true` | 源对象、尺寸、URL（img/video 的 `src`、video 的 `currentTime`）都没变 | 加载后不再变的源：纸纹、预渲底图、图片 | 命中 0.1 ms。**源画布被原地重画而尺寸不变时察觉不到**，纹理停在旧内容 |
| `key: 值` | 上一行条件成立且 key 没变 | 只在少数时刻变化的源（按段切换的底图） | key 必须取自"内容由什么决定"（段号、素材名）。**取 `Math.floor(t)` 这类按时间分桶的值是错的**：桶内第一个被求值的帧决定内容，结果依赖求值顺序 |

缓存只看内容来源，与 t 无关，所以重复求值、乱序求值都与每次上传逐像素相同——**前提是键覆盖了内容的全部变化**。seamcheck 结构上抓不到这个（"改了内容没更新 key"三道门全过，"按秒分桶"只有门 2 红）。专门的门：`node <film-webfx>/scripts/texcache-check.mjs --film <slug>`：两个新页面，一个照常、一个设 `WEBFX_NOCACHE`（缓存退回每次上传），对同一批 t 逐像素比，并报告两边上传次数（次数相同说明没用到缓存，门实际没检查任何东西，脚本会明说）。`--samples` 抽样，`--all` 逐帧。

| 选项 | 解决什么 | 代价 |
|---|---|---|
| `mipmap: true` | 缩小时细线走样、平移闪烁（8 倍缩小时与面积平均参照的 RMSE 35.1 → 0.35，平移闪烁 62.6 → 2.6 /255） | 每次上传多一次 `generateMipmap`（约 +2.6 ms，配 `static` 只付一次）；WebGL1 要求宽高都是 2 的幂，否则**抛错**，非 2 的幂用 `webgl2:true` |
| `anisotropy: n` | **斜看的平面**（透视下的地面、桌面、棋盘）：两个方向缩小倍数不同时只开 mipmap 会把一个方向糊掉。1:8 采样范围下只开 mipmap 的 RMSE 64.9，**比不开还差**（39.1），加 `anisotropy:16` 降到 0.29 | 依赖 `EXT_texture_filter_anisotropic`（本机上限 16）；没有扩展时静默忽略 |

## 3. 2D 混合模式与挖空

混合要**在离屏层上做**，否则会把底下的背景一起挖掉；在 `alpha:false` 的主画布上 `destination-out` 挖出来的是黑色而不是透明。

- **挖空**（已实测）：离屏层画内容 → `globalCompositeOperation='destination-out'` 填形状 → drawImage 回主画布。形状是"让出来的"，轮廓由留白构成。夹具 `tests/fixtures/_test-webfx` 用它从着色器墨场里挖圆孔，过 seamcheck。`globalAlpha` 配 `destination-out` 做"半挖"，挖空程度随 t 变。
- 其余模式（`source-in` 裁进路径、`lighter` / `screen` 叠光、`multiply` 压暗）遵循标准 Canvas 语义，没有单独测。
- 挖空、遮罩、混合放在 2D 一侧做比写进着色器灵活；着色器只负责"每个像素由函数算出"的那层。

## 4. SVG 滤镜

实测（Chromium 156，1080×1920，对截图算 md5，两个独立浏览器各跑一次）：

| 问题 | 结论 |
|---|---|
| 同参数两次截图、乱序 A→B→A、两次独立启动 | 都一致（`feTurbulence(4 oct) → feDisplacementMap → feGaussianBlur`，6 组状态） |
| `seed` 取小数 | **截断取整**：1、1.4、1.6 输出相同 |
| `seed ≤ 0` | 按规范映射：0 等价 1，−1 等价 2 |
| `baseFrequency` 微调 | 连续且可重复（0.008 → 0.0081） |
| 2D `ctx.filter='url(#id)'` | 可重复、seed 生效，但每次 96 ms（含 getImageData） |

**怎么让它动**：
- 跳变式（手绘线"沸腾"、定格动画抖动）：`seed = Math.floor(t * 12) + base`。seed 只能取整数，**不可能插值**。
- 连续式：改 `baseFrequency`（缩放感）、`feDisplacementMap scale`（强度），或 `transform` 平移被滤镜作用的元素。都是 seek 里 `setAttribute`，满足纯函数要求。
- 原地连续演化（像 loopFbm 那样不是平移）SVG 做不到，要用着色器。

**成本**：无滤镜截图 51 ms；turbulence(4 层) + 置换 + 模糊 64 ms（+13）；numOctaves=8 时 83 ms（+32）。随层数线性增长；滤镜区域（`x/y/width/height`）越小越省。

**取舍**：场景本来就是 SVG/DOM、效果是噪声置换、模糊这类标准 primitive 时用 SVG 滤镜（无编译成本、不写 GLSL）；场景是 canvas 或需要自定义像素函数时用着色器（drawImage 进 2D 只要 5 ms，而 SVG 滤镜进 2D 要 96 ms）。把 canvas 场景套进 `ctx.filter='url()'` 只为用 SVG 滤镜，代价是每帧 96 ms。
SVG/DOM 场景用了 CSS 动画或 WAAPI 时要声明 `window.USES_WAAPI`（kernel.md §1）；本节做法是每帧 `setAttribute`，不涉及动画时间线。
