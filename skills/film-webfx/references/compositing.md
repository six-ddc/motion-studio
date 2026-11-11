# 合成：WebGL × 2D、纹理只传一次、混合模式

## 1. 两条方向（实测，仓库 `dev/film-webfx/bench.mjs` 的 composite 段）

| 方向 | 怎么做 | 1080×1920 成本 | 何时用 |
|---|---|---|---|
| 着色器 → 2D | `fx.render(t)` 之后调用 `fx.drawTo(ctx)`（内部是 `drawImage(glCanvas)`） | 5.2 ms | 着色器产出一层画面，交给 2D 做挖空、混合或叠字 |
| 2D → 着色器 | `fx.texture('u_src', canvas2d)` 之后调用 `fx.render(t)` | 上传约 2 ms（「上传 + 色差」9.0 ms，只做色差 6.9 ms）；`{static:true}` 命中缓存时 0.1 ms | 对 2D 已经画好的内容做置换、色差、调色或模糊 |
| 半分辨率层放大回全画幅 | `scale:0.5` 加 `drawTo` | high 26 ms / medium 12.5 / low 6.3 | 着色器本身超过约 25 ms 时才划算 |

`drawTo` 默认使用 `imageSmoothingQuality='high'`。低频内容（烟雾、模糊、泛光）可以用 `low` 放大：自己设置 `ctx.imageSmoothingQuality='low'`，再调用 `ctx.drawImage(fx.canvas, 0, 0, W, H)`。

**同步性**：`render()` 只提交绘制命令，`drawImage(glCanvas)` 会隐式等待绘制完成，所以 seek 里按 `render → drawTo` 的顺序调用时不需要 `finish()`。封装开启了 `preserveDrawingBuffer:true`，render 之后无论隔多久再 drawImage，拿到的都是同一帧（这部分额外成本没有单独测量）。

**alpha 预乘**（边缘发亮或发黑最常见的原因）：
- WebGL context 默认 `premultipliedAlpha:true`，因此**着色器必须输出预乘后的颜色** `vec4(rgb*a, a)`。实测输出 `vec4(.4,.2,.1,.5)`，进入 2D 后读回的是 `[203,102,52,128]`：2D 把 (.4,.2,.1) 当作预乘值，反预乘成了 (.8,.4,.2)。如果本意是「颜色 .4、半透明」，就应该写 `vec4(.4*.5, …, .5)`。输出非预乘色会让半透明边缘发亮。
- 2D 转纹理时，封装设置了 `UNPACK_PREMULTIPLY_ALPHA_WEBGL=true`，采样得到的是预乘色；偏移采样（置换、色差）后原样输出，预乘关系保持不变。在着色器里调色（乘法、曲线）时，要先 `rgb /= max(a, 1e-5)`，调完再乘回去。
- 已设置 `UNPACK_FLIP_Y_WEBGL=true`：`v_uv=(0,0)` 是左下角，对应 canvas 的左下角。
- 挖空、遮罩和混合模式放在 2D 一侧做（离屏层加 `globalCompositeOperation`），比写进着色器更灵活。

## 2. 纹理只传一次、mipmap / 各向异性

`texture()` 默认每次调用都会上传。可用的选项如下：

| 选项 | 什么情况下不再上传 | 适合 | 代价 |
|---|---|---|---|
| 默认 | 从不跳过（每次都上传） | 每帧按 t 重画的 2D 层 | 1080×1920 每次约 2 ms |
| `static: true` | 源对象、尺寸和 URL（img/video 的 `src`、video 的 `currentTime`）都没有变化 | 加载后内容不再变化的源：木纹、纸纹、预先渲染的底图、图片 | 命中时 0.1 ms。**如果源对象被原地重画而尺寸不变，缓存察觉不到**，纹理会停留在旧内容上 |
| `key: 值` | 满足上一行的条件，并且 key 没有变化 | 内容只在少数时刻变化的源（按段切换的底图） | key 必须取自「内容由什么决定」（段号、素材名）。**取 `Math.floor(t)` 这种按时间分桶的值是错的**：桶内第一个被求值的帧决定了内容，结果会依赖求值顺序 |

缓存只看内容来源，与 t 无关，所以同一个 t 求值两次、乱序求值，结果都与每次重新上传逐像素相同，**前提是键覆盖了内容的全部变化**。这一点 seamcheck 在结构上抓不到（「改了内容却没有更新 key」时三道门全部通过，「按秒分桶」时也只有门 2 不通过）。为此有一道专门的门：`node <film-webfx>/scripts/texcache-check.mjs --film <slug>`。它启动两个全新页面，一个照常运行，另一个设置 `WEBFX_NOCACHE`（让缓存纹理退回到每次都上传），对同一批 t 逐像素比较，并报告两边的上传次数（次数相同说明本片没有用到缓存，这道门实际没有检查任何东西，脚本会明确说明）。`--samples` 用于抽样，`--all` 用于逐帧检查。

| 选项 | 解决什么 | 代价 |
|---|---|---|
| `mipmap: true` | 缩小时细线走样、平移时闪烁（8 倍缩小时，与面积平均参照图的 RMSE 从 35.1 降到 0.35，平移闪烁从 62.6 降到 2.6 /255） | 每次上传多一次 `generateMipmap`（1080×1920 约 +2.6 ms，配合 `static` 只付一次）；WebGL1 要求宽高都是 2 的幂，否则**抛错**，非 2 的幂的尺寸要用 `webgl2:true` |
| `anisotropy: n` | **斜看的平面**（透视相机下的地面、桌面、棋盘纹理）：两个方向的缩小倍数不同时，只开 mipmap 会把其中一个方向糊掉。在 1:8 的采样范围下，只开 mipmap 的 RMSE 为 64.9，**比不开还差**（39.1），加上 `anisotropy:16` 后降到 0.29 | 依赖 `EXT_texture_filter_anisotropic`（本机 SwiftShader 支持，上限 16）；没有这个扩展时会被静默忽略 |

## 3. 2D 混合模式

混合要**在离屏层上做**，否则会把底下的背景一起挖掉；在 `alpha:false` 的主画布上用 `destination-out`，挖出来的是黑色而不是透明。

- **挖空**（已实测）：先在离屏层上画内容，再用 `globalCompositeOperation='destination-out'` 填充形状，最后 drawImage 回主画布。形状是「让出来的」，轮廓由留白构成。
  `tests/fixtures/_test-webfx` 就用这种方法从着色器生成的墨场里挖出圆孔，并通过了 seamcheck。`globalAlpha` 配合 `destination-out` 可以实现「半挖」，让挖空程度随 t 变化（tang-dynasty 的宫阙轮廓就是 `globalAlpha = clarity`）。
- 其余模式（用 `source-in` 裁进路径、用 `lighter` / `screen` 叠加光效、用 `multiply` 压暗）遵循标准 Canvas 语义，没有单独测试。

## 4. 泛光链（多遍）

```
主画面(2D) ─texture→ bright(阈值提取, 可 scale:0.25) ─drawTo→ 离屏 2D
            ─texture→ blur 层(scale:0.25, T4 档 2.9 ms) ─drawTo(ctx, low 放大)→ 主画布 lighter/screen 叠回
```
上图每一遍都是独立的 `createShaderLayer`（各有一个 canvas 和一个 context）。每经过 2D 中转一次约 5 ms，好处是每一遍都可以单独用 `pixels()` 检查、单独跑 seamcheck。
同样的链在一个 WebGL2 context 里用 FBO 串起来是 `fxchain.js` 的 `createChain`（中间目标可以是 rgba16f/32f，接法和积木见 `fxchain.md`、`stylize.md` §4）：4 遍全分辨率模糊实测 54 ms，经 2D 中转是 83.6 ms；完整泛光链（提取 → 降采样 → 横竖模糊 → 合成）全分辨率 17.7 ms（rgba16f）。三维路线的多级泛光在 `post3d.js` 里（见 three.md §4）。阈值、半径、叠回模式和强度都是风格参数，由本片的 style_guide 决定。
