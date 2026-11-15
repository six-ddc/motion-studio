---
name: film-webfx
description: 代码渲染视频里决定"一个像素是什么颜色"的那一层：WebGL/WebGL2 片元着色器（程序化噪声、fbm、domain warp、流场、光线步进 SDF）、后期处理（泛光、色差、晕影、胶片颗粒、色调映射、景深、halation、变形镜头拉丝、镜头畸变）、风格化（半调、抖动、像素化、Sobel 勾线、油画 Kuwahara、ASCII）与调色（LUT、lift/gamma/gain）、多 pass 管线与可 seek 的帧间反馈（反应扩散、拖影、墨晕）、位移与扭曲（置换、水波、热浪、玻璃折射）、SVG 滤镜、canvas 混合模式与挖空，以及按帧契约改造的 three.js 三维（场景、材质打光、软阴影、三维运镜、GPU 闭式粒子、GLB 模型资产、三维文字可读性）。片子里出现"着色器""shader""GLSL""噪声纹理""辉光""bloom""颗粒""色散""扭曲""水波""玻璃""墨晕""烟雾""程序化背景""后期""调色""混合模式""挖空""3D""三维""three.js""立体""打光""景深""体积光""数字雨""建模""产品模型""硬表面""倒角""天空云层""湿地面""程序化贴图"，或要在 2D canvas、SVG 滤镜、WebGL 之间选型、估算着色器渲染耗时时使用。
---

# film-webfx

本 skill 管**着色**：一个像素最终是什么颜色。二维运动、转场和 2D 相机归 film-motion；文字动效归 film-typography；
粒子动力学归 film-physics（这里只管粒子怎么着色和闭式 GPU 粒子）；画什么归 film-story。`seek(t)` 契约见 `../film-core/references/kernel.md`。

这里给的是**方向、原理和技术约束**，不是模板。每个效果写清楚：原理（够自己实现的公式或 GLSL 草图）、在 `seek(t)` 下难在哪、实测代价、踩过的坑、可借的主流库。
具体取什么值、长什么样，由本片 `docs/style_guide.md` 决定。

随片的基础设施只有四样：`assets/runtime/webfx.js`（着色器层）、`assets/runtime/fxchain.js`（多 pass 与可 seek 的帧间反馈）、
`assets/runtime/stage3d.js`（three.js 舞台）、`assets/runtime/three-film.module.js` / `three-film.core.js`（three@0.186.1 的违约即抛错版，可选）。

参考文档：
- `references/shaders.md`：时间怎么进着色器、噪声 / fbm / domain warp / curl / 光线步进 SDF、置换类扭曲（水波、热浪、玻璃）
- `references/post.md`：2D 路线的后期（泛光、halation、拉丝、色差、颗粒、晕影、色调映射、镜头畸变）、风格化（半调、抖动、像素化、Sobel、Kuwahara、ASCII）、调色（LGG、LUT）、对细线小字的影响
- `references/fxchain.md`：一个 context 里的多 pass、浮点目标、帧间反馈的定步重放与检查点
- `references/compositing.md`：WebGL 与 2D 互相合成、预乘、纹理缓存与 mipmap、混合模式与挖空、SVG 滤镜
- `references/three.md`：three 的帧契约、舞台、三维运镜、GPU 闭式粒子、程序化表面、世界文字可读性、代价全表
- `references/three-post.md`：HDR 后期（泛光、景深、体积光、AO、眩光、色调映射、离线曝光、FXAA）
- `references/three-world.md`：天空与云、环境反射、高度雾、软阴影、表面分层与风化、湿地面与平面反射、火花与烟
- `references/models.md`：硬表面建模（拆件、倒角、扫掠、合批）与 GLB 模型资产（度量、评审、内联、LOD）

## 0. 先看代价（实测环境：SwiftShader 软件渲染，16 线程 CPU）

渲染环境里的 WebGL 是 **SwiftShader**，着色器在 CPU 上执行。单次 `render(t)` 画完的中位耗时（本仓库实测）：

| 档位 | 代表效果 | 1080×1920 | 540×960 | 270×480 |
|---|---|---:|---:|---:|
| T0 渐变、晕影（几条算术指令） | 整屏调色、晕影 | **3.6 ms** | 0.9 | 0.3 |
| T1 5 层 fbm（约 20 次 hash） | 烟、云、纸纹 | **5.3 ms** | 1.6 | 0.5 |
| T2 三重 domain warp（15 次 noise） | 流体、大理石、墨流 | **21 ms** | 5.4 | 1.5 |
| T3 64 步光线步进加法线计算 | 程序化 3D 场景 | **40 ms** | 10.3 | 2.6 |
| T4 25 次纹理采样 | 模糊、泛光、景深 | **41 ms** | 10.4 | 2.9 |
| T5 fbm 地形步进（每像素约 2000 次 hash） | 重型程序化地形 | **144 ms** | 36 | 9.4 |
| 参照：渲染器截一张 1080×1920 PNG | — | **50 ms** | | |

**截图才是瓶颈**：T0–T2 比截图便宜，T3、T4 与截图同一量级，T5 让单帧成本翻 3 倍。整片耗时约为 `帧数 × 子帧数 × (seek 耗时 + ≈50ms 截图)`，例如 20 秒、30fps、4 个子帧时，T3 级约 4 分钟，T5 级约 8 分钟。
着色器成本 ≈ **像素数 × 每像素指令数**；首帧另有 20–80 ms 的 JIT 编译，所以先 `render(0)` 预热。GPU 后端（`--use-angle=metal`）下所有档位都在 5 ms 以内，但输出与 SwiftShader 不逐像素一致（硬约束 5）。

## 1. 硬约束（违反就是 bug）

1. **时间只能从 uniform 传入**，由 `render(t)` 每次显式传。着色器里没有时钟；JS 一侧不读 `performance.now()`，也不开 rAF。`render()` 是同步的，返回时像素已经可以被 `drawImage` 取用。
2. **随机只能来自 hash**：`hash12(p + u_seed)` 这类纯函数。要"每帧换一次"的颗粒，就把帧号 `Math.round(t*fps)` 作为 uniform 混进 hash。不用 `Math.random` 生成纹理。hash 不要用 `fract(sin(x)*43758.)`：sin 在大参数下各后端精度不同，是跨后端不一致的常见来源；webfx 的 `GLSL.hash` 是无 sin 的版本。
3. **每种 context 用一个新 canvas。** 同一个 canvas 上先取 `webgl` 再取 `webgl2` 会返回 null。`createShaderLayer` 每次都新建 canvas。
4. **长片的时间精度**：float32 在 t≈3600 时的 ulp 约 2.4e-4 s，`sin(u_time*1000.)` 会抖。循环效果传 `period` 让 JS 先用 double 取模；非循环的高频项在 JS 里算好相位再传。
5. **一次渲染只用一个固定后端**。SwiftShader 在同一台机器上逐次、跨进程、WebGL1 与 WebGL2 之间都逐位一致；与 Metal 不一致；跨机器（不同 CPU 架构）没测。需要跨机器重渲的片子，给关键帧留黄金帧哈希。
6. **uniform 每帧全量传**。GL 会留着上一次设的值，少传一个就是跨帧状态。`fxchain.js` 用反射核对、缺了抛错；`createShaderLayer` 不查，自己传满。sampler 必须用 `uniform1i` 设（封装已按反射类型分派；绕过封装直接 `gl.uniform*` 时别把 sampler 当 float）。
7. **纹理缓存的键只能来自内容，不能来自时间。** `texture(..., { static:true })` / `{ key }` 命中缓存就不再上传；键没反映内容变化时纹理停在第一次上传的样子，**seamcheck 的三道门照样全过**。用了缓存就过 texcache 门（§6，规则见 compositing.md §2）。
8. **这一帧取决于上一帧的效果只能定步重放**：状态定义为第 n 步 = step(第 n−1 步)、n 由 t 算出，往回 seek 从检查点重放（`fxchain.js` 的 feedback）。自己拿两张纹理每次 seek 推一步，顺序渲染看着对，乱序和并行渲染就错（阴性对照：seamcheck 只有门 2 红，fxreplay 倒序、乱序红）。step 只能读上一步、步号和加载期确定的纹理（fxchain.md §3）。
9. **离屏目标不能把上一帧带进这一帧**。任何 render target（反射、深度、模糊链、AO）都要在本次 seek 里、相机和物体按 t 设好之后重画再读；"画完这一帧再更新、下一帧再用"是游戏的常见做法，在这里就是门 1a/2 红。强度为 0 时跳过子链要绑黑纹理或让权重恰为 0，不能读残留的旧 RT。

## 2. 接入 webfx.js

场景里直接 `import './runtime/webfx.js'`（服务器从已安装的 skill 挂载，deliver 时冻结进片子）。没有外部依赖。

```js
import { createShaderLayer, GLSL } from './runtime/webfx.js';
const fx = createShaderLayer({
  width: L.width, height: L.height,     // L = film-core layout.js 的 makeLayout(format)
  scale: 0.5,                           // 着色器层分辨率倍率（何时值得见 §5）
  seed: 11,                             // → u_seed
  period: DURATION,                     // 循环片：u_time = t mod period
  frag: GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + `
uniform float u_period;
void main(){ vec2 p = v_uv * vec2(u_res.x/u_res.y, 1.) * 2.5 + u_seed;
  OUT = vec4(vec3(loopFbm(p, u_time / u_period, 0.7)), 1.); }`,
});
fx.render(0);                                   // 预热 JIT
window.seek = (t) => {
  ctx.fillRect(0, 0, L.width, L.height);        // 2D 底
  fx.render(t, { u_period: DURATION });         // 其它 uniform 每帧全量传
  fx.drawTo(ctx);                               // 合成进 2D 主画布
};
```

API：`render(t, uniforms)`、`drawTo(ctx, {x,y,width,height,smoothing})`、`texture(name, canvasOrImage, {filter, wrap, static, key, mipmap, anisotropy})`（2D → 着色器，见 compositing.md）、`setUniform(name, v)`、`pixels()`（调试读回）、`finish()`（计时）。
uniform 按类型对应：数字 → float；`[x,y]`…`[x,y,z,w]` → vec2–vec4；9 / 16 个数 → mat3 / mat4；`true/false` → bool；其余按着色器声明分派（int / ivec / mat2 / uint / sampler）。
**数组** `uniform vec4 u_pts[8]` 可传嵌套数组、扁平数组或 `Float32Array`；写整个数组时元素数必须不少于声明长度（少传会让剩余元素留着上一帧的值，直接抛错）。uniform 总量上限是 `MAX_FRAGMENT_UNIFORM_VECTORS`（本机 SwiftShader 4096 个 vec4，规范保底 WebGL1 16、WebGL2 224），元素上千改用数据纹理。
GLSL 片段：`header`（WebGL1）、`header2`（WebGL2）、`hash`（hash12/hash22/hash13，无 sin）、`ign`（交错梯度噪声，屏幕坐标的纯函数）、`pcg`（整数哈希 pcg3d，GLSL ES 3.00）、`noise`（vnoise、vnoise3、fbm）、`loop`（loopNoise、loopFbm）。`OUT` / `TEX` 两个宏让同一段着色器在 WebGL1/2 下都能编（输出逐位一致）。

可运行的例子：仓库夹具 `tests/fixtures/_test-webfx/scene.html`（两个合成方向加 destination-out 挖空，过 seamcheck 全部门）。

## 3. 效果地图

| 效果 | 最便宜的做法 | 代价 | 读哪里 |
|---|---|---|---|
| 渐变、晕影、整屏调色 | 2D `createRadialGradient` + `multiply` | 几乎为 0 | compositing.md |
| 挖空、"从墨里让出形状" | 2D 离屏层 `destination-out` | 一次离屏 drawImage，约 5 ms | compositing.md §3 |
| 发光叠加、光斑累积 | 2D `lighter` / `screen` | 低 | compositing.md §3 |
| 静态纸纹、做旧底纹 | SVG `feTurbulence` 或 T1 着色器渲一次缓存 | 只付一次 | compositing.md §4、shaders.md §2 |
| 斜看的平面上的纹理 | `texture(..., {mipmap:true, anisotropy:16})` | 上传多 2.6 ms（配 static 只付一次） | compositing.md §2 |
| 会动的烟、云、墨流、大理石 | fbm / domain warp | T1–T2 | shaders.md §2 |
| 流场条纹、风向 | curl noise | T2（19 ms） | shaders.md §2 |
| 程序化 3D（全屏） | 光线步进 SDF | T3 起步 | shaders.md §3 |
| 水波、热浪、玻璃、液化 | 2D 内容当纹理过置换着色器 | 上传约 2 ms + T1 | shaders.md §4 |
| 低频整块扭曲（SVG/DOM 元素） | SVG `feDisplacementMap` | 截图多 13 ms | compositing.md §4 |
| 色差、颗粒、晕影、色调映射、镜头畸变 | 合进一遍着色器 | 6–9 ms | post.md §2 |
| 泛光、halation、变形镜头拉丝 | 提取亮部 → 降采样模糊 → 叠回；多遍用 fxchain | 全链 11–18 ms | post.md §3 |
| 景深、大半径模糊（2D） | `ctx.filter='blur(Npx)'` 或降采样后 T4 | 13–16 ms | post.md §3 |
| 半调、抖动、像素化、描边、ASCII | 单 pass | 6.5–28 ms | post.md §4 |
| 油画感（Kuwahara） | 单 pass | ∝ 4(r+1)²，r=4 时 156 ms | post.md §4 |
| lift/gamma/gain、3D LUT | 单 pass | 7–9 ms | post.md §5 |
| 这一帧取决于上一帧（反应扩散、拖影、墨晕） | fxchain feedback：定步 + 检查点 | 每仿真秒 = 步数 × 每步；冷启动 O(t) | fxchain.md §3–4 |
| 三维场景、打光、PBR、模型 | three.js（原版或 three-film）+ `stage3d.js` | 基准场景约 8 ms 起 | three.md |

## 4. 选型判据：2D / SVG 滤镜 / WebGL / three

- **2D canvas**：混合、挖空、渐变和 `ctx.filter='blur()'` 都没有编译和 context 成本。该升级到 WebGL 的信号是：**每个像素的颜色要由一个函数算出**（噪声、距离场、偏移采样），这和"画一个形状"是两类工作。
- **SVG 滤镜**：不写 GLSL，直接作用于 DOM/SVG，确定性已实测。代价：seed 只能取整数、没有连续时间轴、做不了 domain warp、画进 2D 每次 96 ms（compositing.md §4）。
- **WebGL 着色器**：表达力最高，也比 SVG 滤镜便宜；代价是写 GLSL、首帧编译 20–80 ms、后端固定。
- **三维**（场景图、相机、灯光阴影、PBR、模型）：three.js。原版可以用，只要不用 `setAnimationLoop` / `Clock`（kernel.md §3）；three-film 是同一版 three 加"违约就抛错"的补丁，好处是用错立刻报错而不是渲出不可重复的片子。只做全屏片元效果时 `webfx.js` 就够，three 的首帧编译、PBR 着色、HDR 后期都要钱。
- **第三方库**（如需）：three.js 的 examples/jsm（EffectComposer 各 pass、GLTFLoader、RGBELoader、Sky）、pmndrs `postprocessing`、`lygia` 着色器函数库、regl / ogl。本仓库没有装，也没在 seamcheck 下复测；接入前按 kernel.md §3 关掉自带循环、把时间改成从 t 传入（three.md §1 列了 three 生态里已知会读时钟的地方）。

## 5. 性能：降级顺序（按性价比）

1. **先确认真的慢**：seek 低于 50 ms 时瓶颈在截图，优化着色器没有收益。
2. **降低分辨率**（`scale: 0.5`）：成本降到四分之一，适合低频内容。放大回原尺寸另付 26 / 12.5 / 6.3 ms（high / medium / low 平滑，compositing.md §1），所以着色器本身超过约 25 ms 才划算；锐利边缘、网点、像素格会变糊。
3. **减少每像素工作**：减 fbm 层数（每层约占 1/5）、减步进步数、提前 `break`、把不可见区域 alpha 置 0 并跳过昂贵分支。
4. **局部渲染**：只开效果所在区域大小的层，再 `drawTo(ctx,{x,y,width,height})` 放回。
5. **静态部分只渲一次**：与 t 无关的层在模块顶层渲进离屏 canvas，seek 里只 `drawImage`（缓存不算状态，seamcheck 照样过）。
6. **预烘焙序列帧**（未实测）：在 `ready` 里按帧栅格渲成 ImageBitmap 数组；1080×1920 一帧约 8 MB，几百帧就是 GB 级内存。
7. **换 GPU 后端**：快 10–30 倍，但整片必须同一后端，输出与 SwiftShader 不一致。

## 6. 验收

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> --parallel 4   # 内核门 + 门 4（离屏层合成）
node <film-webfx>/scripts/texcache-check.mjs --film <slug>          # 用了 texture 的 static/key 时：缓存版 vs 每次上传版逐像素比
node <film-webfx>/scripts/fxreplay-check.mjs --film <slug>          # 用了 fxchain 的 feedback 时：检查点/重放 vs 从第 0 步算
```

`gates.json` 登记了三道"用了才开"的门：加载了 `webfx.js` / `fxchain.js` / `stage3d.js` 时 `accept --deep` 跑门 4（`seam4`，与 film-motion 共用，一支片子只跑一次）；加载了 `webfx.js` 或 `fxchain.js` 时跑 `texcache`；加载了 `fxchain.js` 时跑 `fxreplay`。deliver 总是开门 4，另外跑 texcache 和 fxreplay。
三维和自写后期链没有专门的门：它们的跨帧状态靠 seamcheck 门 2（乱序）和门 4 抓，所以**自写的每个离屏 pass 都要能在乱序下重画**（硬约束 9）。

已知未解决：WebGL1 下非 2 的幂纹理配合 `wrap:'repeat'/'mirror'` 采样全黑且不报错（`mipmap` 的同类情况已改成抛错）；SwiftShader 跨机器一致性没测；`static:true` 察觉不到对源画布的原地重画（只能靠 texcache-check 事后发现）；三维盲区见 three.md §8。

## 7. 三维（three.js，按帧契约）

随片的是 `three-film.core.js` / `three-film.module.js`（three 0.186.1 加违约抛错补丁，MIT）和舞台 `stage3d.js`；锚点用 film-core 的 `anchors.js`。
镜头、后期链、粒子、天空、地面、材质补丁都**自己写**：three.md 及其后三页讲原理、难点、代价和坑。可运行例子：仓库夹具 `tests/fixtures/_test-3d`（含阴性对照）、片子 `films/weiqi-fx-open`（立体棋盘、长运镜、焦点拉走）。

**硬约束（three 版）**：
1. 每次 seek 都从 t 算出全部状态；反射、深度、阴影与后期的额外 pass 在同一次帧求值内完成。用 `S.frame(t, paint)` 统一复位和最终绘制。three-film 里用到 `Clock` / `Timer` / `setAnimationLoop` / `Math.random` 系列 / `compileAsync` 会直接抛错。
2. **保留式场景图会把上一帧的状态带过来**：`S.frame()` 每帧先把场景复位到 `S.freeze()` 时的静止姿态（默认开；`reset:false` 的代价是漏写一个属性只有门 2 能发现）；seek 里 add/remove 对象直接抛错。
3. 后期的风格参数每帧全量传，没有默认值；颗粒按 `floor(t·fps)` 播种；粒子是 (i, 种子, t) 的闭式函数；镜头是 t 的纯函数，不积分。
4. 锚点在渲染之后用渲染时的矩阵投影（`S.anchor`），不另外推算一遍坐标。

可选能力：**世界文字可读性** `S.legible(name, obj, {from, to, em})` 测投影后的字高与压扁比，film.json 的 `checks` 声明 `{"legible": {"min_px": …, "min_squash": …}}` 时由 film-critique 判定（three.md §2）。模型要登记进 film-assets 的台账（"3D 模型"一类）。

**代价**（SwiftShader，全表见 three.md §7）：基准 PBR 场景约 8 ms；开任何后期先付一遍直通约 11 ms；景深最贵（+78 ms）；逐像素效果合进一遍只比单开一项多几 ms；软阴影 +5 ms；GPU 闭式粒子 1 万个几乎不花钱；后期 RT 开 MSAA +53 ms。

**验收**：`seamcheck --film <slug> --parallel 4`（全部门）。升级 three 后重新生成 three-film 并跑夹具 `_test-3d` 的 seamcheck（three.md §1）。
