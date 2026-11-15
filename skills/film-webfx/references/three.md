# 三维：three.js 按帧契约

目录：1 three-film 与第三方插件 · 2 舞台 `stage3d.js`（复位、锚点、世界文字可读性、接自写后期） · 3 三维运镜 · 4 GPU 闭式粒子 · 5 程序化表面（onBeforeCompile） · 6 打光、PBR 与阴影 · 7 代价表 · 8 阴性对照与盲区

后期链见 `three-post.md`；天空、雾、地面、表面风化、火花烟见 `three-world.md`；建模与 GLB 见 `models.md`。实测记录在仓库 docs/verified/film-webfx.md。

## 1. three-film 与第三方插件

`assets/runtime/three-film.core.js` / `three-film.module.js` 由仓库开发工具 `dev/film-webfx/vendor-three.mjs` 从 `three@0.186.1`（MIT，许可证全文在文件开头）生成。补丁按「精确文本 + 精确出现次数」匹配，上游一变脚本就失败：

| 位置 | 上游行为 | 改成 | 原因 |
|---|---|---|---|
| `generateUUID` ×4 | `Math.random` | 计数器加整数混洗 | uuid 只作身份；加载期构造顺序固定，每次得到同一组 |
| `MathUtils.randInt/randFloat/…`、`Vector*.random`、`Quaternion.random`、`randomDirection` ×17 | `Math.random` | **抛错**，提示用 seeded() | 静默返回一个数的危害比抛错大得多 |
| `Clock` / `Timer` ×5 | `performance.now` | **抛错** | `getDelta()` 照常返回一个数，片子却每次不一样——最典型的静默失败 |
| `renderer.setAnimationLoop` ×2 | rAF | **抛错** | 渲染只在 seek 里同步调用一次 |
| `compileAsync` / `probeAsync` ×4 | `setTimeout` 轮询 | **抛错** | 预热用同步的 `renderer.compile()` |
| Loader 命中缓存 ×3、`yieldToMain` ×1 | `setTimeout(0)` / rAF | 微任务 | 加载期异步回调，语义不变 |

用原版 three 也行（kernel.md §3），代价是上面这些用错时不报错，只能靠 seamcheck 探针和门 2 事后发现。
**升级 three**：`npm pack three@<版本>` 解包，`node dev/film-webfx/vendor-three.mjs --src <目录>/package`，再跑夹具 `tests/fixtures/_test-3d` 的 seamcheck。已交付的片子冻结了自己那份，不受影响。
**只支持 WebGL2**（three r163 起删了 WebGL1 渲染器；本机 SwiftShader 的 WebGL2 可用）。
**AnimationMixer**：用 `mixer.setTime(t)`（从 0 重放到 t，可乱序）；`mixer.update(delta)` 是增量，违约。

**examples/jsm 插件**（GLTFLoader、RGBELoader、Sky、EffectComposer 各 pass、Reflector……）没有随片。如需：从**同一版本**的包拷进片子，用 import map 把 `three` 指向 `./runtime/three-film.module.js`，先 grep 一遍 `Clock` / `requestAnimationFrame` / `Math.random` / `setTimeout`。已知的坑：
- 官方 `EffectComposer` 构造时就建一个 `Clock`（three-film 下直接抛错）；它的 pass 本身（UnrealBloomPass、BokehPass、SSAOPass、OutputPass）可以拆出来自己串 render target，时间类 uniform 从 t 传。
- pmndrs `postprocessing` 的 `EffectPass` 内部累积 time；用它要把时间改成每帧从 t 显式设，且 `GrainEffect`/`NoiseEffect` 这类按帧号播种。
- 任何"上一帧结果 × 衰减"的 pass（`AfterimagePass`、TAA、自动曝光）都是跨帧状态，按硬约束只能定步重放或改成离线表（three-post.md §4）。

## 2. 舞台 `stage3d.js`

```js
import { createStage3D, THREE } from './runtime/stage3d.js';
const S = createStage3D({ canvas, width: L.width, height: L.height,
  clear: [r, g, b, a], toneMapping: THREE.ACESFilmicToneMapping, shadows: true, shadowType: THREE.PCFSoftShadowMap });
S.scene.add(...);  S.freeze();                          // 加载期搭场景，记下静止姿态
window.seek = A.install((t) => S.frame(t, (t) => {     // A = film-core anchors.js 的 createAnchors
  setCamera(S.camera, t);                               // 自己写的镜头函数，t 的纯函数（§3）
  mesh.rotation.y = 0.4 * t;
  S.anchor(A, '主体', mesh);
}));
```

| API | 做什么 |
|---|---|
| `createStage3D({canvas?, width, height, scale=1, antialias, clear, toneMapping, colorSpace, shadows, shadowType, reset=true})` | WebGL2 renderer（`preserveDrawingBuffer`、`alpha`、预乘）、`scene`、`camera`（已入树）。`render --scale` 小样时像素再乘 `window.FILM.scale`（`S.width/height/scale` 是实际像素；锚点仍按原尺寸量），定稿不受影响 |
| `S.freeze()` | 记下整棵树的静止姿态。此后在 seek 里 add/remove 抛错 |
| `S.frame(t, paint, postParams?)` | **seek 的标准写法**：复位 → `paint(t)` → 结构检查 → 渲染 → 处理本帧锚点。paint 的返回值作为后期参数 |
| `S.reset()` / `S.render(t, postParams)` | frame 的前后两半，自己编排流程时用 |
| `S.anchor(A, name, obj, {mode:'box'|'vertices', rect, meta})` / `anchorBox` / `anchorPoint` | 渲染后用渲染时的矩阵把物体（含子树）/世界盒/世界点投影进锚点表 |
| `S.project(p, rect)` | 世界点 → `{x, y, depth, behind}`（让 2D 标注跟 3D 物体） |
| `S.legible(name, obj, {from, to, em?, box?, rect?})` | 加载期登记一段世界文字及其阅读时间窗 |
| `S.drawTo(ctx, rect)` | 舞台不是主画布时画进 2D 主画布（1080×1920 约 5 ms） |
| `S.warm(t, paint)` / `S.finish()` | 预热（compile + 渲一帧，放 `ready` 里）/ 读 1 像素强制画完（计时） |

**复位（默认开）**：保留式场景图里，`seek(5)` 写了 `visible=false` 而 `seek(2)` 没写，t=2 时物体也是隐藏的——门 1a/1b 抓不到，只有门 2 能。`S.frame` 先把整棵树复位到 freeze 时：位置、四元数、缩放、up、可见性、renderOrder、形变权重；灯光/相机/雾/背景的标量、颜色和引用；材质的标量、颜色、贴图引用和 `material.uniforms` 的值；几何体 drawRange。303 个对象一次 0.4 ms。
**不会复位、要自己每帧写满的**：BufferAttribute 内容、InstancedMesh 的 instanceMatrix 与 count、`onBeforeCompile` 注入的 uniform 对象（不在 `material.uniforms` 上，§5）、renderer 状态（曝光、toneMapping、render target、viewport/scissor）。

**锚点**：`S.anchor()` 在 paint 里排队，渲染完成后用 `projectionMatrix × matrixWorldInverse` 投影，写进 film-core anchors.js（语义见 film-core `references/runtime.md` §6）。包围盒 8 角先在视空间对近平面裁剪（沿 12 条棱求交）再投影，物体一半在相机后时框照样对；完全在后面时不登记。`mode:'vertices'` 逐顶点投影，更贴合，O(顶点数)。坐标不裁剪（出画时 <0 或 >1）。

**世界文字读不读得出**（`S.legible`，可选）：贴图平面或 TextGeometry 上的字，投影字高 ≈ 字高 × sin(视线与字面夹角) / 距离，还会沿基线被挤扁；film-critique 的 fillText 拦截看不到。
- 在 `S.freeze()` 之后的加载期调用 `S.legible('关键词', wordMesh, { from: vo.span('k').start, to: vo.span('k').end, em: 0.5 })`。文字在 obj 局部 XY 平面，+x 阅读方向、+y 字的上方；`em` 是一个 em 在局部坐标里的高度（贴图文字：字号 px / 贴图高 px × 平面高），不给取文字框高（只对单行成立）。
- 每次渲染后（只测 t ∈ [from, to]）在文字框上取 3 点（多行 3×3），把每点一个 em 小方块投影得到雅可比 [u v]：`em` 取 |v| 最小值（原生像素），`squash` 取奇异值比 σmin/σmax 最小值（不受画面内旋转影响，切变也计入），`aspect` 为中心 |u|/|v|。
- `window.legible(t)` 执行一次 seek，返回 `{ t, items: { 名: {em, emMax, squash, aspect, cx, cy, depth, behind, shown, opacity} } }`；`.last()` 不重画；`.windows()` 返回登记表。判定阈值写在 film.json `checks` 的 `legible` 里，由 film-critique 判，套件不给默认。
- 盲区：测几何不测像素，看不到遮挡、景深、mipmap 模糊和对比度；`em` 写大了会放过过小的字。

**接自写的后期链**：一个有 `render(t, params)` 的对象经 `S._attachPost(post)` 挂上后，`S.frame` 在渲染步骤调用它（不再直接上屏），params 是 paint 的返回值或第三个参数。没挂后期却传了参数会抛错。后期的写法见 three-post.md。

## 3. 三维运镜（镜头是 t 的纯函数）

镜头函数 `shot(t) → { pos, target, up?, fov?, roll?, shift?, near?, far?, focus? }`，每帧写进 `S.camera`。全部要么是闭式解，要么是"加载期建表、求值时查表"。

| 手法 | 原理 | 坑 |
|---|---|---|
| 关键帧轨道 | 二分查所在段，段内按该段缓动插值 | 关键帧时刻必须严格递增：几段各自给关键帧再拼时，交界处常有同一时刻两个值，要错开或改成镜头表 |
| 多镜硬切 | 镜头表 `[{t0, t1, a, b, ease}]`：镜内 a→b，镜间直接换（上一镜止于 t1−ε） | 硬切没有过程，全靠前后两帧的景别/角度/焦段差撑；切点挂 `vo.at` |
| 样条运镜 | 向心 Catmull-Rom（α=0.5，不会自交和尖角），**按弧长参数化**：加载期建弧长表，u→s 查表 | 按参数 u 而不是弧长走，速度在控制点稀疏处忽快忽慢 |
| 有动机的长运镜 | 一条样条穿过 N 个机位；进度 u(t) 用**单调三次插值**（Fritsch–Carlson）穿过各「(旁白时刻, 该机位弧长分数)」点 | 用分段缓动每到一个机位都会刹停；单调插值不停顿、到点准确、不过冲（见 `films/weiqi-fx-open`） |
| 环绕、推拉 | `pos = center + R(angle(t))·[r, h, 0]`；沿视线 `pos = target − dir·dist(t)` | — |
| 跟随（带惯性） | **不积分**：对 target 过去 lag 秒内的轨迹做固定权重平均（每次求值采样固定次数） | 弹簧积分依赖求值顺序，门 2 红 |
| 焦点切换 | target 在 A、B 之间按缓动插值，焦距同步 | — |
| 手持晃动 | 一维值噪声，按整数格点 hash（`hash(floor(t·freq), seed)` 插值），几个八度叠加 | 不要用顺序随机流（seeded() 的下一个数）——那依赖调用次数 |
| 主点偏移 | `camera.setViewOffset` 移主点，让注视点落在画面中心以外（主体压到下部、上方留字），不把相机转歪 | 复位会还原 view；每帧写 |

**和 film-motion 的 2D 透视相机对齐**：film-motion 的 camera3d（针孔相机斜看一个平面）可换算成等价的 three 镜头：fov = 2·atan(H / 2 / (S·d))，主点取其 `screen`，坐标 (x, y, z) 对应 three 的 (x, z, y)。本仓库实测两边投影最大差 1.1e-12 px，2D 标注和 three 物体可以逐点对齐。

## 4. GPU 闭式粒子

**原理**：粒子 i 在 t 的状态 = f(i, 它的种子随机数, t)，在顶点着色器里算。种子在加载期由种子化 PRNG（与 film-core `seeded()` 同算法）生成，存进 attribute。
- **寿命循环**：`k = floor(t/life + phase_i)` 是第几次生命，`age = fract(t/life + phase_i)·life`；第 k 次重生的随机数 = `hash(i, k)`。状态只依赖 (i, k, age)，可乱序求值。
- **运动**：`p = 出生点 + v·age + ½g·age² + drift(出生点, age)·幅度`。带阻力的弹道也有闭式解：`p = p0 + v0·(1−e^{−c·a})/c + g·(a − (1−e^{−c·a})/c)/c`。
- **位移场不是平流**：drift 是"出生点处的平滑位移"，粒子并不被速度场带着走。真要沿 curl 场积分，走 film-physics 的重放或检查点，把位置每帧整块上传（CPU 粒子）。
- **小于 1 px 的点**：按覆盖面积降 alpha 而不是缩成 0，跨帧才不闪。
- **混合方式**必须选：加法（只会变亮、不能遮挡、无需排序）还是普通（要排序）——这是风格选择，也决定景深能不能看到它（§8）。
- **锚点**：GPU 粒子位置不在 CPU 上，登记"闭式解保证粒子始终在其中的体积"（`S.anchorBox`）。

例子（夹具 `tests/fixtures/_test-3d`）：「数字雨」每格一个粒子，按列 hash 出速度和相位，头部位于第 `mod(t·speed + 相位, span)` 行，拖尾 `exp(−d/trail)` 衰减，字形由 `hash13(列, 行, floor(t·rate + 相位))` 从种子化的 5×7 点阵图集选（不依赖字体回退）。「星尘」用寿命循环给出生点，再绕轴螺旋上升叠 drift。
可用的库（如需）：three 的 `Points` / `InstancedMesh` + 自写 ShaderMaterial 就够；three.quarks 之类粒子系统内部是增量更新，要改成闭式或重放才能用。

## 5. 程序化表面（onBeforeCompile）

像"线条在棋盘面上长出来"这种随 t 变的图案，每帧重画 2D 贴图再上传要 2–4 ms（1080 级），还要管缓存键。另一条路是向 `MeshStandardMaterial` / `MeshPhysicalMaterial` 注入代码：
- `#include <map_fragment>` 之后改 `diffuseColor`；`<roughnessmap_fragment>` 之后改 `roughnessFactor`；`<emissivemap_fragment>` 之后加 `totalEmissiveRadiance`；`<normal_fragment_maps>` 之后扰动 `normal`。
- uniform 放进共享对象 `U = { uT: {value} }`，`onBeforeCompile` 里 `Object.assign(shader.uniforms, U)`，**paint 里每帧全部重写**（复位管不到它）。
- 图案用 `fwidth` 做解析抗锯齿，斜看也不走样；打光、阴影、清漆、景深照常作用在图案上。例子：`films/weiqi-fx-open/scene.html` 的盘面线、星位、交叉点亮点。
- 同一材质叠多个补丁（雾、软阴影、表面、地面）时：只设一个 `onBeforeCompile` 按顺序调用各补丁；`customProgramCacheKey` 由各补丁结构参数拼成，否则不同组合会串用同一程序；替换掉的 chunk 留个标记，后来的补丁还能插在它后面。
- 与 t 无关的纹理（木纹）在加载期用 `createShaderLayer` 渲一次拷进 `CanvasTexture`，或用 `WebGLRenderTarget` 烘焙（烘完恢复 renderer 的目标、viewport、scissor）。

## 6. 打光、PBR 与阴影

- **一个主光 + 环境光照（IBL）** 是 PBR 读得出材质的最低配置：金属、清漆、玻璃的样子几乎全靠反射环境；没有环境贴图时金属是黑的。环境贴图可以从 HDRI（RGBELoader + PMREMGenerator，在加载期做）或从自己的程序化天空拍（three-world.md §1）。
- 颜色管理：贴图里的颜色用 `SRGBColorSpace`，数据贴图（法线、粗糙度、金属度、AO）用线性；十六进制 sRGB 色直接除 255 当线性传入会高估反照率。
- **软阴影**：PCF 2048² 一盏灯 +5.5 ms，"物体稳稳放在平面上"主要靠它。阴影相机的视锥按场景包围盒拟合，越紧精度越高；`bias` / `normalBias` 治阴影痤疮和漂浮。接触越近越硬的 PCSS 见 three-world.md §3。
- 色调映射在不走后期时由 `renderer.toneMapping` 做；走后期时在最后一遍做，中间 RT 保持线性 HDR。

## 7. 代价表（实测）

基准场景上逐项添加，每次 `S.frame()` 后读 1 像素强制画完，取中位数（ms），增量相对同画幅基准。后期成本只与像素数有关，换场景增量大致不变；同时有其他任务在跑时数字会高一截。

| 项目（基准 = 一个 PBR 多面体 + 地面 + 方向光，直接上屏） | 1080×1920 | 1920×1080 | 什么时候值得付 |
|---|---:|---:|---|
| 基准 | 8.7 | 7.6 | — |
| 后期直通（HDR RT + 一遍合成，不开效果） | +11.0 | +10.6 | 只要用后期就得付；之后每加一种逐像素效果边际成本很小 |
| 色差 / 颗粒 / 暗角 / 扫描线 / 故障（各自单开，含直通） | +15.6 / +10.7 / +10.9 / +10.9 / +16.7 | +16.0 / +11.1 / +11.0 / +11.1 / +17.3 | 色差、故障各多约 +5（多次取色） |
| 上面五样合进一遍 | +18.7 | +18.8 | 比分开做（每遍各付约 11 的固定成本）省约 45 ms |
| 泛光（5 级下采样链） | +35.6 | +35.6 | 高光真要发光时；只想"柔一点"用不着 |
| 景深（1/2 分辨率，maxBlur 16 px） | +77.7 | +78.3 | 焦点本身是戏的一部分时；采样数 ∝ (maxBlur·分辨率)²，blur=0 的帧整条跳过 |
| 体积光（48 步径向，1/4 分辨率） | +23.3 | +23.2 | 光源在画面内或附近、需要光束时 |
| 全部后期 | +138.4 | +138.7 | — |
| 默认帧缓冲 MSAA 4× | +8.8 | +8.4 | 不走后期时抗锯齿 |
| 后期 HDR RT 开 MSAA 4× | +53.4 | +53.2 | 很贵（多重采样 RT 的 resolve 在 SwiftShader 下慢）。不开的代价：细圆环、发光描边、细走线出阶梯，运动中闪，经 H.264 读作毛边（样例 xa-agent：用户评"边缘不清晰"，开 4× 后细环变成干净实线） |
| 软阴影（PCF，2048²，一盏灯） | +5.5 | +5.2 | 便宜 |
| GPU 闭式粒子 1 万 / 10 万 | +0.9 / +11.3 | +1.0 / +11.1 | 几万个以内几乎不花钱 |
| CPU 闭式粒子 1 万 / 10 万 | +1.3 / +15.3 | +1.2 / +13.8 | 需要在 JS 侧拿到粒子位置时（锚点、碰撞、film-physics 的轨迹） |
| 每帧复位（303 个对象） | 0.4 | 0.4 | 默认开 |
| 参照：截一张 PNG | ≈50 | ≈50 | 整片参照：`weiqi-fx-open`（PBR + 清漆 + 环境反射 + 软阴影 + 景深 + 泛光 + 颗粒 + 暗角）seek 中位数 409 ms |

GPU 后端（Metal）下同类场景整帧 1.5–6 ms；软件渲染下**面数直接等于成本**，先测目标面数下的单帧耗时再决定要不要 LOD（models.md §6）。

## 8. 阴性对照与盲区

夹具 `tests/fixtures/_test-3d`：

| 入口 | 写错了什么 | seamcheck |
|---|---|---|
| `scene.html` | 正片 | **全部通过** |
| `scene-bad-noreset.html` | `reset:false`，只在 t>3.5 写 `visible=false`，从不写回 | **门 2 红**，1a、1b 通过 |
| `scene-sloppy-reset.html` | 同样漏写，但 `reset:true` | 全部通过：复位兜住了 |
| `scene-bad-integrate.html` | 按 dt 带阻尼逐帧积分位置 | **门 2 红** |
| `scene-bad-clock.html` | seek 里 `new THREE.Clock().getElapsedTime()` | **抛错退出**，信息里写明该用什么 |

匀速积分 `p += v·dt`（v 常数）可化简成闭式解，能过全部门；只有速度依赖状态的积分才和求值顺序有关。判断依据不是"有没有积分"，而是门 2。

盲区：
- **景深看不到加法混合的粒子**：它们不写深度，景深按身后物体的深度算 CoC。要让粒子各自虚化：让粒子写深度（加法混合会出排序问题），或在粒子着色器里按自身 CoC 放大 sprite。
- GPU 粒子的锚点是一个体积而不是粒子本身；遮挡门对粒子云只能保守判断。锚点只说"画在哪"，不说"看不看得见"。
- `AnimationMixer.setTime` 配带淡入淡出权重的 action、SkinnedMesh、morph 动画：没有夹具测过。
- 其他显卡/驱动未测；PCFSoft 和 PMREM 跨后端不承诺同像素。
