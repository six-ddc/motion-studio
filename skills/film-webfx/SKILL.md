---
name: film-webfx
description: 代码渲染视频里决定"一个像素是什么颜色"的那一层：WebGL/WebGL2 片元着色器（程序化噪声、fbm、domain warp、流场、光线步进 SDF）、后期处理（泛光、色差、晕影、胶片颗粒、色调映射、景深、halation、变形镜头拉丝、镜头畸变）、风格化（半调、抖动、像素化、Sobel 勾线、油画 Kuwahara、ASCII）与调色（LUT、lift/gamma/gain）、多 pass 管线与可 seek 的帧间反馈（反应扩散、拖影、墨晕）、位移与扭曲（置换、水波、热浪、玻璃折射）、SVG 滤镜、canvas 混合模式与挖空，以及按帧契约改造的 three.js 三维（场景、材质打光、软阴影、三维运镜、GPU 闭式粒子、GLB 模型资产、三维文字可读性）。片子里出现"着色器""shader""GLSL""噪声纹理""辉光""bloom""颗粒""色散""扭曲""水波""玻璃""墨晕""烟雾""程序化背景""后期""调色""混合模式""挖空""3D""三维""three.js""立体""打光""景深""体积光""数字雨""建模""产品模型""硬表面""倒角""天空云层""湿地面""程序化贴图"，或要在 2D canvas、SVG 滤镜、WebGL 之间选型、估算着色器渲染耗时时使用。
---

# film-webfx

本 skill 管**着色**，也就是一个像素最终是什么颜色。二维的运动、转场（包括故障切、漏光、推拉）和相机归 film-motion；文字动效（包括乱码解码 scramble）归 film-typography；
粒子的动力学归 film-physics，这里只管粒子怎么着色，以及闭式 GPU 粒子；画什么归 film-story。`seek(t)` 契约见 `../film-core/references/kernel.md`。

参考文档：`references/shaders.md`（着色器模板，以及时间怎么传进着色器）、`references/compositing.md`（WebGL 与 2D 互相合成、预乘、纹理只上传一次与 mipmap、混合模式、泛光链）、
`references/svg-filters.md`、`references/three.md`（三维的全部内容）、`references/models.md`（模型资产）、`references/fxchain.md`（一个 context 里的多 pass 管线、浮点目标、帧间反馈的定步重放）、`references/stylize.md`（风格化后期与调色的效果菜单、参数、实测代价、对细线小字的影响）。
程序化场景按需读 `references/modeling.md`（拆件、倒角、扫掠、装配合批）、`references/sky.md`（天/雾/环境同源、PCSS）、`references/surfaces.md`（湿润、积垢、顶点色风化）、`references/world-surfaces.md`（贴图烘焙、湿地面反射、受光烟火花）、`references/post-chain.md`（AO、阴影步进体积雾、镜头与显示后期）。

## 0. 先看代价（实测环境：SwiftShader 软件渲染，16 线程 CPU）

渲染环境里的 WebGL 是 **SwiftShader**，着色器在 CPU 上执行。下表是单次 `render(t)` 画完的中位耗时，可以在仓库里运行 `node dev/film-webfx/bench.mjs` 复现（该脚本不随安装分发）：

| 档位 | 代表效果 | 1080×1920 | 540×960 | 270×480 |
|---|---|---:|---:|---:|
| T0 渐变、晕影（几条算术指令） | 整屏调色、晕影 | **3.6 ms** | 0.9 | 0.3 |
| T1 5 层 fbm（约 20 次 hash） | 烟、云、纸纹 | **5.3 ms** | 1.6 | 0.5 |
| T2 三重 domain warp（15 次 noise） | 流体、大理石、墨流 | **21 ms** | 5.4 | 1.5 |
| T3 64 步光线步进加法线计算 | 程序化 3D 场景 | **40 ms** | 10.3 | 2.6 |
| T4 25 次纹理采样 | 模糊、泛光、景深 | **41 ms** | 10.4 | 2.9 |
| T5 fbm 地形步进（每像素约 2000 次 hash） | 重型程序化地形 | **144 ms** | 36 | 9.4 |
| 参照：渲染器截一张 1080×1920 PNG | — | **50 ms** | | |

**截图才是瓶颈**：T0–T2 比截图便宜，T3、T4 与截图同一量级，T5 会让单帧成本翻 3 倍。整片耗时约为 `帧数 × 子帧数 × (seek 耗时 + ≈50ms 截图)`，例如 20 秒、30fps、4 个子帧时，T3 级约 4 分钟，T5 级约 8 分钟。着色器成本大致等于**像素数乘以每像素指令数**；首帧还要多花 20–80 ms 做 JIT 编译，所以先调用 `render(0)` 预热。GPU 后端（`--use-angle=metal`）下所有档位都在 5 ms 以内，但输出与 SwiftShader 不逐像素一致（见硬约束 5）。

## 1. 硬约束（违反就是 bug）

1. **时间只能从 `u_time` 传入**，由 `fx.render(t)` 每次显式传入。着色器里没有时钟；JS 一侧不读 `performance.now()`，也不开 rAF。`render()` 是同步的，返回时像素已经可以被 `drawImage` 取用。
2. **随机只能来自 hash**：用 `hash12(p + u_seed)` 这类纯函数。需要"每帧换一次"的颗粒，就把帧号 `Math.round(t*fps)` 作为 uniform 混进 hash（见模板 `grade`）。不用 `Math.random` 生成纹理。
3. **每种 context 用一个新 canvas。** 在同一个 canvas 上先取 `webgl` 再取 `webgl2` 会返回 null。`createShaderLayer` 每次都新建 canvas，不会遇到这个问题。
4. **长片的时间精度**：float32 在 t≈3600 时的 ulp 约为 2.4e-4 s，`sin(u_time*1000.)` 会抖动。循环效果要传 `period`，让 JS 先用 double 取模；非循环的高频项在 JS 里算好相位再传入。
5. **一次渲染只用一个固定后端**。SwiftShader 在同一台机器上逐次渲染、跨进程、WebGL1 与 WebGL2 之间都逐位一致；与 Metal 之间不一致；跨机器（不同 CPU 架构）还没测过。需要跨机器重渲的片子，给关键帧留黄金帧哈希。
6. **sampler 必须用 `uniform1i` 设置**。封装好的 `texture()` / `setUniform` 已经按反射得到的类型分派；绕过封装直接调用 `gl.uniform*` 时，不要把 sampler 当 float 设置。
7. **纹理缓存的键只能来自内容，不能来自时间。** `texture(..., { static:true })` / `{ key }` 命中缓存后就不再上传；如果键没有反映内容的变化，纹理会一直停在第一次上传时的样子，而 **seamcheck 的三道门照样全部通过**。所以用了缓存就要过 texcache 门（§6；规则见 compositing.md §2）。
8. **这一帧取决于上一帧的效果只能定步重放。** 用 `fxchain.js` 的 feedback：状态定义为第 n 步 = step(第 n−1 步)、n 由 t 算出，往回 seek 从检查点重放。自己拿两张纹理每次 seek 只推一步，顺序渲染看着对，乱序和并行渲染就错（阴性对照：seamcheck 只有门 2 红，fxreplay 倒序、乱序红）。step 只能读上一步、步号和加载期确定的纹理（fxchain.md §4）。

## 2. 接入

场景里直接 `import './runtime/webfx.js'`（服务器从已安装的 skill 挂载这个文件，deliver 时冻结进片子）。它没有外部依赖。

```js
import { createShaderLayer, GLSL } from './runtime/webfx.js';
import { makeLayout } from './runtime/layout.js';          // film-core 提供
const L = makeLayout(new URLSearchParams(location.search).get('format') || '9x16');

const fx = createShaderLayer({
  width: L.width, height: L.height,
  scale: 0.5,            // 着色器层分辨率倍率（见第 5 节何时值得）
  seed: 11,              // → u_seed
  period: DURATION,      // 循环片：u_time = t mod period，t=D 与 t=0 逐像素一致
  frag: GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + `
uniform float u_period;
void main(){
  vec2 p = v_uv * vec2(u_res.x/u_res.y, 1.) * 2.5 + u_seed;
  float n = loopFbm(p, u_time / u_period, 0.7);
  OUT = vec4(vec3(n), 1.);
}`,
});
fx.render(0);                                  // 预热 JIT

window.seek = (t) => {
  ctx.fillRect(0, 0, L.width, L.height);       // 2D 底
  fx.render(t, { u_period: DURATION });        // 其它 uniform 每帧全量传，不依赖上次留下的值
  fx.drawTo(ctx);                              // 合成进 2D 主画布
};
```

API：`render(t, uniforms)`、`drawTo(ctx, {x,y,width,height,smoothing})`、`texture(name, canvasOrImage, {filter, wrap, static, key, mipmap, anisotropy})`（把 2D 画面传给着色器，见 compositing.md）、`setUniform(name, v)`、`pixels()`（读回像素，调试用）、`finish()`（计时用）。

uniform 的取值按类型对应：数字对应 float；`[x,y]` 到 `[x,y,z,w]` 对应 vec2 到 vec4；9 个或 16 个数对应 mat3 / mat4；`true/false` 对应 bool；其余按着色器里声明的类型分派（`int` / `ivec` / `mat2` / `uint`（WebGL2）/ sampler）。
**数组** `uniform vec4 u_pts[8]` 可以传 `[[x,y,z,w], …]`、扁平数组或 `Float32Array`，名字写 `u_pts` 和写 `u_pts[0]` 等价，写 `u_pts[3]` 则从第 3 个元素开始写入。写整个数组时**元素数必须不少于声明长度**（少传会让剩下的元素保留上一帧的值，所以直接抛错），多传的尾部会被截掉。uniform 总量上限是 `MAX_FRAGMENT_UNIFORM_VECTORS`（本机 SwiftShader 为 4096 个 vec4，规范保底 WebGL1 16 个、WebGL2 224 个），超出会导致 link 失败；元素上千时改用数据纹理。
GLSL 片段有 `header`（WebGL1）、`header2`（WebGL2）、`hash`、`noise`（vnoise、vnoise3、fbm）、`loop`（loopNoise、loopFbm）。`OUT` 和 `TEX` 两个宏让同一段着色器在 WebGL1 和 WebGL2 下都能编译（输出逐位一致）。

完整可运行的例子：`tests/fixtures/_test-webfx/scene.html`（包含两个合成方向和 destination-out 挖空，能通过 seamcheck 的全部门）。

## 3. 效果地图

| 效果 | 最便宜的做法 | 代价或档位 | 模板 |
|---|---|---|---|
| 纯色、渐变、晕影、整屏调色 | 2D `createRadialGradient` 配合 `multiply` | 几乎为 0 | compositing.md |
| 挖空、镂空、"从墨里让出形状" | 2D `destination-out` 离屏层 | 一次离屏 drawImage，约 5 ms | compositing.md |
| 发光叠加、光斑累积 | 2D `lighter` / `screen` | 低 | compositing.md |
| 静态纸纹、做旧底纹 | SVG `feTurbulence` 或 T1 着色器渲染一次后缓存；作为纹理传给着色器时用 `texture(..., {static:true})` | 只渲染一次、上传一次 | svg-filters.md / shaders.md `fbm` / compositing.md §2 |
| 斜看的平面上的纹理（透视相机下的木纹、网格） | `texture(..., {mipmap:true, anisotropy:16})` | 上传多花 2.6 ms（配合 static 只付一次） | compositing.md §2 |
| 会动的烟、云、墨流 | 着色器 fbm / domain warp | T1–T2 | shaders.md `loop_fbm` `warp` |
| 流场条纹、风向可视化 | 着色器 curl noise | T2（19 ms） | shaders.md `curl_field` |
| 水波、热浪、玻璃、液化 | 把 2D 内容当纹理，再过置换着色器 | 上传约 2 ms，另加 T1 | shaders.md `displace` |
| 低频的整块扭曲（作用于 SVG/DOM 元素） | SVG `feDisplacementMap` | 截图多花 13 ms | svg-filters.md |
| 色差、RGB 分离 | 着色器三次采样 | 7 ms | shaders.md `chroma` |
| 颗粒、晕影加色调映射 | 着色器一遍完成 | 6 ms | shaders.md `grade` |
| 泛光 | 提取亮部，降采样模糊，再用 `lighter` 叠回 | 1/4 分辨率模糊约 3 ms | shaders.md `bright` + compositing.md |
| 景深、大半径模糊 | 2D `ctx.filter='blur(Npx)'`（半径 4–48px 都约 13–16 ms，结果可重复），或降采样后用 T4 | 13–16 ms | compositing.md |
| 程序化 3D | 光线步进 SDF | T3 起步 | `assets/templates.mjs` 的 `t3_raymarch` |
| 两遍以上的后期链（泛光、halation、变形镜头拉丝） | `fxchain.js` 的 `createChain`：一个 WebGL2 context、FBO 串联、可用 rgba16f/32f 中间目标 | 泛光整条链 17.7 ms；4 遍模糊 54 ms，经 2D 中转是 84 ms | fxchain.md、stylize.md §4 |
| 这一帧取决于上一帧（反应扩散、拖影、墨晕、元胞） | `createChain({ feedback })`：定步推进，往回 seek 从检查点重放 | 每仿真秒 = 步数 × 每步（270×240 每步 0.58 ms）；冷启动 O(t)，夹具 30 s 要 6 s | fxchain.md §4–5、`fxglsl.js` 的 `FEEDBACK` |
| 半调、抖动、像素化、描边、ASCII | `fxglsl.js` 的 `STYLIZE`，单 pass | 6.5–28 ms | stylize.md §2 |
| 油画感（Kuwahara） | `STYLIZE.kuwahara` | 成本 ∝ 4(r+1)²，r=4 时 156 ms（半分辨率 39 ms） | stylize.md §2 |
| 镜头畸变、lift/gamma/gain、3D LUT（.cube） | `STYLIZE.lens` / `grade_lgg` / `lut3d`（WebGL1 用 `lut_strip`）；`parseCube` 在 fxchain.js | 7–9 ms | stylize.md §3 |
| 三维场景、打光、PBR、模型 | three-film（第 7 节） | 基准场景约 8 ms 起 | three.md |

## 4. 选型判据：2D / SVG 滤镜 / WebGL / three

- **2D canvas**：混合、挖空、渐变和 `ctx.filter='blur()'` 都没有编译和 context 创建成本。该升级到 WebGL 的信号是：**每个像素的颜色要由一个函数算出**（噪声、距离场、偏移采样），这和"画一个形状"是两类工作。
- **SVG 滤镜**：不用写 GLSL，可以直接作用于 DOM/SVG 元素，确定性已实测通过。代价（seed 只能取整数、没有连续时间轴、做不了 domain warp、画进 2D 每次 96 ms）和取舍判据见 svg-filters.md。
- **WebGL 着色器**：表达力最高，也比 SVG 滤镜便宜；代价是要写 GLSL、首帧编译 20–80 ms、后端固定。
- **三维场景**（场景图、相机、灯光阴影、PBR、模型）：用随片的 three-film（第 7 节）。只做全屏片元效果时 `webfx.js` 就够了，因为 three 的首帧编译、PBR 着色和 HDR 后期链都有成本。regl / ogl / pmndrs postprocessing 没有安装，也没有复测（关闭它们自带循环的要点见仓库 docs/verified/film-webfx.md 末节）。

## 5. 性能：降级顺序（按性价比排列）

1. **先确认真的慢**：seek 低于 50 ms 时瓶颈在截图，优化着色器没有收益。
2. **降低分辨率**（`scale: 0.5`）：着色器成本降到四分之一，适合低频内容。放大回原尺寸要另付 26 / 12.5 / 6.3 ms（对应 high / medium / low，见 compositing.md §1），所以着色器本身超过约 25 ms 才划算；锐利边缘会变糊。
3. **减少每像素的工作量**：减少 fbm 层数（每层约占 1/5 成本）、减少步进步数、提前 `break`、把不可见区域的 alpha 置 0 并跳过昂贵分支。
4. **局部渲染**：`createShaderLayer` 只开效果所在区域的大小，再用 `drawTo(ctx,{x,y,width,height})` 放回原位。
5. **静态部分只渲染一次**：与 t 无关的层在模块顶层渲染进离屏 canvas，seek 里只做 `drawImage`（缓存不算状态，seamcheck 照样能过）。
6. **预烘焙序列帧**（未实测）：在 `ready` 里按帧栅格渲染成 ImageBitmap 数组；1080×1920 一帧约 8 MB，几百帧就要 GB 级内存。
7. **换 GPU 后端**：快 10–30 倍，但整片必须用同一个后端，且输出与 SwiftShader 不一致。

## 6. 验收

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> --parallel 4   # 内核门 + 门 4（离屏层合成）
node <film-webfx>/scripts/texcache-check.mjs --film <slug>          # 用了 texture 的 static/key 时：缓存版 vs 每次上传版逐像素比
node <film-webfx>/scripts/fxreplay-check.mjs --film <slug>          # 用了 fxchain 的 feedback 时：检查点/重放 vs 从第 0 步算
node <film-webfx>/scripts/lightdebug.mjs --film <slug> --at <t>     # 诊断不是门：逐个关掉光源/反射/泛光，报某处亮度从哪来（world-surfaces.md §3）
```

`gates.json` 登记了三道"用了才开"的门：片子加载了 `webfx.js` / `fxchain.js` / `stage3d.js` / `post3d.js` 时，`accept --deep` 会跑门 4（`seam4`，与 film-motion 共用，一支片子只跑一次）；加载了 `webfx.js` 或 `fxchain.js` 时还会跑 `texcache`；加载了 `fxchain.js` 时跑 `fxreplay`（`scripts/fxreplay-check.mjs`：帧间反馈的缓存版按顺序/倒序/乱序与"每次从第 0 步算"逐像素比，fxchain.md §7）。deliver 总是开启门 4，另外再跑 texcache 和 fxreplay。环境基准脚本在仓库 `dev/film-webfx/`（不随安装分发）：`bench.mjs [--quick] [--gpu]`（升级 Playwright 后要重跑；如果失败，说明环境已经不再逐次一致，先不要渲片）、`svgfilter-check.mjs`、`blur2d-check.mjs`、`bench3d.mjs`。

已知未解决的问题：WebGL1 下非 2 的幂纹理配合 `wrap:'repeat'/'mirror'` 采样结果全黑且不报错（`mipmap` 的同类情况已改成抛错，这一条还没改）；SwiftShader 跨机器一致性没测（§1.5）；`static:true` 察觉不到对源画布的原地重画（只能靠 texcache-check 事后发现）；三维方面的盲区见 three.md §9。

## 7. 三维（three.js，按帧契约）

场景里直接 `import './runtime/<名>'`，可用的文件有：`three-film.core.js` 和 `three-film.module.js`（three.js 0.186.1 按帧契约改造的版本，MIT 协议）、`stage3d.js`（舞台）、`camrig.js`（镜头）、`post3d.js`（后期链）、`particles3d.js`（粒子，依赖 `webfx.js`）；锚点用 film-core 的 `anchors.js`。完整 API、做法、代价全表和盲区见 `references/three.md`。例子有夹具 `tests/fixtures/_test-3d`（含阴性对照）和片子 `films/weiqi-fx-open`（立体棋盘、长运镜、焦点拉走）。

**硬约束（three 版）**：
1. 每次 seek 都从 t 算出全部状态；反射、深度与后期的额外 pass 在同一次帧求值内完成。用 `S.frame()` 统一复位和最终绘制。在 three-film 里用到 `Clock` / `Timer` / `setAnimationLoop` / `Math.random` 系列 / `compileAsync` 会直接抛错（补丁表见 three.md §1）。
2. **保留式场景图会把上一帧的状态带过来**：`S.frame()` 每帧先把场景复位到 `S.freeze()` 时的静止姿态（默认开启；用 `reset:false` 关掉的代价是，漏写一个属性时只有 seamcheck 门 2 能发现）；在 seek 里 add/remove 对象会直接抛错。
3. 后期的风格参数每帧全量传入，没有默认值；颗粒按 `floor(t·fps)` 播种；粒子是 (i, 种子, t) 的闭式函数。
4. 锚点在渲染之后用渲染时的矩阵投影（`S.anchor`），不另外推算一遍坐标。

可选能力：**世界文字可读性** `S.legible(name, obj, {from, to, em})` 测量投影后的字高与压扁比，film.json 的 `checks` 声明了 `{"legible": {"min_px": …, "min_squash": …}}` 时由 film-critique 判定（three.md §2）。
**镜头** `camrig.js` 全部是 t 的纯函数（多镜硬切的镜头表用 `shots()` 生成关键帧），`fromCamera3d()` 让 film-motion 的 2D 标注与 3D 物体共用同一个投影（three.md §3）。
**程序化模型与场景**：`model3d.js` 在加载期造型和装配；`sky3d.js` 统一天空、环境反射与雾；`surface3d.js` 注入物体材质，`texture3d.js` 烘焙共享破损贴图。`ground3d.js` 提供连续湿润地面和当帧平面反射，`spritefx3d.js` 提供速度拉伸火花与受光烟图集。它们均为可选能力，参数与代价见上方各参考页。
**扩展后期**：`post3d.js` 显式开启能量混合泛光、AO、阴影体积雾、调色与镜头层、FXAA/锐化/抖动；用加载期测光表生成曝光曲线，见 `references/post-chain.md`。旧调用路径保持原有输出。
**模型资产**（获取、度量、评审、内联、截面扫掠、LOD）见 `references/models.md`；模型要登记进 film-assets 的台账（"3D 模型"一类）。

**代价**（SwiftShader，`dev/film-webfx/bench3d.mjs`，全表见 three.md §7）：基准 PBR 场景约 8 ms；只要开任何后期，先要付一遍直通，约多 11 ms；景深最贵（多 78 ms，blur=0 时整条跳过）；色差、颗粒、暗角、扫描线、故障合并成一遍，只比单开一项多几 ms；软阴影多 5 ms；GPU 闭式粒子 1 万个几乎不花时间。

**验收**：`seamcheck --film <slug> --parallel 4`（全部门）；换机器或升级 Playwright 后重跑 `dev/film-webfx/bench3d.mjs`；升级 three 后重跑 `dev/film-webfx/vendor-three.mjs`（three.md §1）。
