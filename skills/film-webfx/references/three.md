# 三维：three.js 舞台、镜头、后期、粒子（按帧契约）

做程序化场景时，按需读 `modeling.md`（造型/装配/合批）、`sky.md`（天空/PMREM/雾/PCSS）、`surfaces.md`（材质层/风化）、`world-surfaces.md`（贴图/湿地面/反射/烟火花）。显式后期扩展与离线曝光见 `post-chain.md`；本页保留原舞台、镜头与后期基础 API。

本页是 SKILL.md 第 7 节的展开。三维代价的完整表格只在 §7 维护。实测记录在仓库 docs/verified/film-webfx.md §8–9。

目录：1. three-film 补丁表 / 2. 舞台 `stage3d.js`（复位、锚点、世界文字可读性 `S.legible`）/ 3. 镜头 `camrig.js` / 4. 后期 `post3d.js` / 5. 粒子 `particles3d.js` / 6. 程序化表面（onBeforeCompile）/ 7. 代价表 / 8. 阴性对照 / 9. 盲区与没解决的

## 1. three-film：three.js 的帧契约版

`assets/runtime/three-film.core.js` 和 `three-film.module.js` 由仓库开发工具 `dev/film-webfx/vendor-three.mjs` 从 npm 包 `three@0.186.1`（MIT 许可，许可证全文写在两个文件的开头，随文件分发）生成。它们**不是原样拷贝**：补丁按「精确文本 + 精确出现次数」匹配，上游代码一有变化，脚本就会失败：

| 位置 | 上游行为 | 改成 | 原因 |
|---|---|---|---|
| `generateUUID` ×4 | `Math.random` | 计数器加整数混洗 | uuid 只用作身份标识，不影响像素；加载期的构造顺序是固定的，每次加载得到同一组 uuid |
| `MathUtils.randInt/randFloat/randFloatSpread`、`Vector2/3/4.random`、`Quaternion.random`、`randomDirection` ×17 | `Math.random` | **抛错**，提示「用 seeded()」 | 只要用了就不可重复；静默返回一个数的危害比抛错大得多 |
| `Clock` / `Timer` ×5 | `performance.now` | **抛错** | `getDelta()` 照常返回一个数，渲出来的片子却每次都不一样，这是最典型的静默失败 |
| `renderer.setAnimationLoop` ×2 | rAF | **抛错** | 渲染只在 seek 里同步调用一次 |
| `compileAsync` / `probeAsync` ×4 | `setTimeout` 轮询 | **抛错** | 预热改用同步的 `renderer.compile()` |
| Loader 命中缓存 ×3 | `setTimeout(fn, 0)` | 微任务 | 属于加载期的异步回调，语义不变 |
| `yieldToMain` 兜底 ×1 | rAF | 微任务 | 同上 |

这样一来，违反契约就从「静默出错」变成了「当场抛错，并在错误信息里写明该用什么」（阴性对照为 `tests/fixtures/_test-3d/scene-bad-clock.html`，见 §8）。

**升级 three**：先用 `npm pack three@<版本>` 解包到一个空目录，再运行 `node dev/film-webfx/vendor-three.mjs --src <目录>/package`，然后跑 `dev/film-webfx/bench3d.mjs` 和夹具 `tests/fixtures/_test-3d` 的 seamcheck。已交付的片子冻结了自己那一份 `runtime/three-film.*.js`，不受升级影响（见 film-core `references/runtime.md` §2）。
**只支持 WebGL2**：three 从 r163 起删除了 WebGL1 渲染器；本机 SwiftShader 的 WebGL2 可用。
**AnimationMixer**：用 `mixer.setTime(t)`（从 0 重放到 t，可以乱序调用）；`mixer.update(delta)` 是增量更新，违反帧契约。带淡入淡出权重的 action 没有测过（见 §9）。

**插件（examples/jsm）**：没有 vendor 进来。需要 GLTFLoader 之类的插件时，从同一版本的包里拷进片子，用 import map 把 `three` 指向 `./runtime/three-film.module.js`，并先 grep 一遍 `Clock` / `requestAnimationFrame` / `Math.random`。官方的 `EffectComposer` 在构造时就会创建一个 `Clock`，所以后期处理要用 `post3d.js`（见 §4）。

## 2. 舞台 `stage3d.js`

```js
import { createStage3D, THREE } from './runtime/stage3d.js';
const S = createStage3D({ canvas, width: L.width, height: L.height,
  clear: [r, g, b, a], toneMapping: THREE.ACESFilmicToneMapping, shadows: true, shadowType: THREE.PCFSoftShadowMap });
S.scene.add(...);                   // 加载期搭场景
S.freeze();                         // 记下静止姿态
window.seek = A.install((t) => S.frame(t, (t) => {   // A = film-core anchors.js 的 createAnchors
  applyShot(S.camera, shot(t), S);  // camrig.js
  mesh.rotation.y = 0.4 * t;
  S.anchor(A, '主体', mesh);
  return postParams(t);             // 有 createPost 时：这一帧的后期参数（全量）
}));
```

| API | 做什么 |
|---|---|
| `createStage3D({canvas?, width, height, scale=1, antialias, clear, toneMapping, colorSpace, shadows, shadowType, reset=true})` | 创建 WebGL2 renderer（`preserveDrawingBuffer:true`、`alpha`、预乘）、`scene` 和 `camera`（已加入场景） |
| `S.freeze()` | 记下整棵场景树的静止姿态。此后在 seek 里 add/remove 会抛错 |
| `S.frame(t, paint, postParams?)` | **seek 的标准写法**：依次执行复位、`paint(t)`、结构检查、渲染（有后期时走后期）、处理本帧的锚点。paint 的返回值作为后期参数 |
| `S.reset()` / `S.render(t, postParams)` | 分别是 frame 的前后两半，需要自己编排流程时使用 |
| `S.anchor(A, name, obj, {mode:'box'|'vertices', rect, meta})` | 把物体（含子树）在屏幕上的外包框写入 `A.box`。在渲染之后，用渲染时的矩阵投影 |
| `S.anchorBox(A, name, box3)` / `S.anchorPoint(A, name, p, r)` | 分别把世界盒子、世界点加半径写入 `A.box` / `A.disc` |
| `S.project(p, rect)` | 把世界点投影成屏幕坐标 `{x, y, depth, behind}`（让 2D 标注跟着 3D 物体移动时使用） |
| `S.legible(name, obj, {from, to, em?, box?, rect?})` | 在**加载期**登记一段世界文字及其阅读时间窗（见下文「世界文字读不读得出」） |
| `S.drawTo(ctx, rect)` | 舞台不是主画布时，把它画进 2D 主画布（1080×1920 一次 drawImage 约 5 ms，见 compositing.md） |
| `S.warm(t, paint)` / `S.finish()` | 分别用于预热（compile 加渲染一帧）和读取 1 个像素来强制画完（计时用） |

### 复位（默认开）

在保留式场景图里，如果 `seek(5)` 写了 `visible=false` 而 `seek(2)` 没有写，那么 t=2 时物体也是隐藏的。这类 bug 门 1a 和 1b 抓不到，只有门 2 能抓到。
`S.frame` 一开始会把整棵树复位到 `freeze()` 时的状态，包括：位置、四元数、缩放、up、可见性、renderOrder、形变权重；对象上的标量、颜色和引用（灯光的强度与颜色、相机的 fov/near/far/view、雾、背景）；材质上的标量、颜色、贴图引用和 **uniform 值**；几何体的 drawRange。这一帧没有写的属性会回到静止值。

以下内容不会复位，需要自己每帧写满：BufferAttribute 的内容（在 CPU 上改顶点）、InstancedMesh 的 instanceMatrix、通过 `onBeforeCompile` 注入的 uniform 对象（它们不在 `material.uniforms` 上，要像 `films/weiqi-fx-open` 那样放进一个共享对象，每帧全部重写），以及 renderer 状态（曝光由 post 每帧设置）。

代价：303 个对象的场景执行一次 `reset()` 需要 0.4 ms（bench3d 实测）。可以用 `reset:false` 关掉，代价是上面那类 bug 只能靠门 2 发现。

### 锚点（语义见 film-core `references/runtime.md` §6）

`S.anchor()` 在 paint 里先排队，**渲染完成后**再用 `camera.projectionMatrix × matrixWorldInverse`（也就是渲染时用的那组矩阵）投影，然后通过 `A.box()` 写进 film-core anchors.js 的锚点表。这就是「在绘制路径上登记」在 3D 里的含义。包围盒的 8 个角先在视空间里对近平面做裁剪（沿 12 条棱求交点）再投影，所以物体有一半在相机后面时，框照样是对的；物体完全在相机后面时不登记。`mode:'vertices'` 逐个顶点投影，框更贴合，开销为 O(顶点数)。坐标归一化到锚点画布，不做裁剪（出画时的值小于 0 或大于 1）。

### 世界文字读不读得出（`S.legible`，可选）

贴图平面或 TextGeometry 里的文字投影到屏幕后，字高约等于「字高 × sin(视线与字面的夹角) / 距离」，还会沿基线方向被挤扁。film-critique 的 fillText 拦截看不到这些文字，所以要由场景自己测量：在 `S.freeze()` 之后的加载期调用一次
`S.legible('关键词', wordMesh, { from: vo.span('k').start, to: vo.span('k').end, em: 0.5 })`，之后照常写 `window.seek = A.install((t) => S.frame(t, paint))`。

- **文字位于 obj 的局部 XY 平面上**：+x 是阅读方向，+y 是字的上方（这是 PlaneGeometry / TextGeometry 的约定；不符合时，外面包一层 Group 转过来）。`em` 表示一个 em 在局部坐标里有多高（贴图文字的算法是：字号 px / 贴图高度 px × 平面高度）；不给时取文字框的高度（只对单行文字成立）。`box` 不给时使用几何包围盒。
- 每次渲染后（只测量 t ∈ [from, to] 范围内的文字），在文字框上取 3 个点（多行文字取 3×3 个点），用渲染时的同一组矩阵把每个点处一个 em 大小的小方块投影出去，得到雅可比矩阵 [u v]：
  `em` 取 |v| 的最小值（单位是原生像素，`rect` 默认为片子的宽高），`squash` 取奇异值比 σmin/σmax 的最小值，`aspect` 为中心点的 |u|/|v|。
  σmin/σmax 不受画面内旋转的影响，横向挤压和纵向挤压得到同一个数，切变也计算在内；`aspect` 也一并报告，方便人判断是往哪个方向挤压的。
- `window.legible(t)` 执行一次 seek，返回 `{ t, items: { 名: {em, emMax, squash, aspect, cx, cy, depth, behind, shown, opacity} } }`；`.last()` 返回上次结果而不重新绘制；`.windows()` 返回登记表。
  如果这一帧没有走到渲染步骤（这一段不画三维），返回空表，不会沿用上一帧的结果。它独立于 `anchors(t)`（锚点表是「名字到屏幕框」的映射，会被多个使用方按名字整表读取），但两者来自同一次绘制、同一组矩阵，接口形状也照搬了 `anchors(t)`（一次 seek、`last()`、纯函数）。
- 判定标准在 film-critique 里（在 film.json 的 `checks` 中写 `{"legible": {"min_px": …, "min_squash": …}}`；片子写了阈值才做判定，套件不提供默认值）。
- 代价：每个处在时间窗内的词，每帧需要 9–36 次点投影，相对渲染来说可以忽略。不登记就不测量，也不会安装 `window.legible`。盲区：它测量的是几何而不是像素，所以看不到遮挡、景深、mipmap 造成的模糊和对比度问题；`em` 写大了会放过过小的字。

## 3. 镜头 `camrig.js`

这里的函数全部是 t 的纯函数（要么是闭式解，要么是「加载期建表，求值时查表」）。它们不依赖 three，在 Node 里也能 import。

| 函数 | 做什么 | 怎么保证可以乱序求值 |
|---|---|---|
| `track([[t, v, 缓动?], ...])` | 关键帧轨道（值可以是数，也可以是等长数组），每一段有自己的缓动 | 二分查找所在段，段内插值。关键帧时刻必须严格递增：几段各自给关键帧再拼起来时，交界处常有两段同一时刻，会直接抛错——错开，或改用 `shots()`。**`shots([{t0, t1, a, b?, ease?}, ...])`** 生成多镜硬切的关键帧数组交给 track：镜内 a→b，镜间硬切（上一镜止于 t1−ε，相邻镜可写 t1 = 下一镜 t0），镜头太短/重叠/时刻 NaN 抛错；代价：硬切没有过程，全靠前后两帧的关系撑（景别、角度、焦段差得够不够），切点要挂在 `vo.at` 上 |
| `spline(points, {alpha=.5, closed, samples})` → `{at(u), tangent(u), length}` | 向心 Catmull-Rom 样条，**u 按弧长参数化** | 弧长表在加载期建一次 |
| `orbit({center, radius, height, angle})` | 绕竖直轴环绕，参数可以是 f(t) | 闭式解 |
| `dolly({from, target, dist})` | 沿视线推拉 | 闭式解 |
| `aim(pos, yaw, pitch, dist)` | 由俯仰和偏航算出 target | 闭式解 |
| `follow(target, {lag, samples})` | 带惯性的跟随 | **不做积分**：对 target 过去 lag 秒内的轨迹做固定权重平均（每次求值采样 samples 次） |
| `blendTargets([[t0, A], [t1, B]], {dur, ease})` | 切换焦点（注视点从 A 过渡到 B） | 闭式解 |
| `shake({amp, freq, seed, octaves})` | 手持晃动或震动 | 一维值噪声，按整数格点做哈希（不是 seeded() 那种顺序随机流） |
| `ease.linear/smooth/smoother/in/out/inOut/bezier(x1,y1,x2,y2)` | 缓动函数；bezier 使用固定的迭代次数 | — |
| `applyShot(camera, shot, size)` | 写入 PerspectiveCamera，返回对焦距离 | — |
| `fromCamera3d(cam3d, W, H)` / `fromCamera3dPoint([x,y,z])` | 把 film-motion 的 camera3d 转换成等价的 three 镜头 | — |

shot 的结构为 `{ pos, target, up?, fov?, roll?, shift?:[dx,dy] 主点偏移像素, near?, far?, focus? }`。`shift` 通过 `setViewOffset` 实现，可以让被注视的点落在画面中心以外的位置（比如把主体压到画面下部，上方留给文字），而不需要把相机转歪。

**和 2D 相机的关系**：film-motion 的 `camera3d.js`（用针孔相机斜看一个平面，为 2D canvas 提供投影点）可以通过 `fromCamera3d` 转换成 three 镜头：fov = 2·atan(H / 2 / (S·d))，主点取 `screen`，camera3d 的 (x, y, z) 对应 three 的 (x, z, y)。两边投影的最大差为 **1.1e-12 px**，2D 标注和 three 物体可以逐点对齐。

**有动机的长运镜**的一种写法（见 `films/weiqi-fx-open`）：用一条样条穿过 N 个机位，进度 u(t) 用单调三次插值（Fritsch–Carlson）穿过各个「(旁白时刻, 该机位的弧长分数)」点。这样经过机位时不会停顿，到达时刻准确，也不会过冲。这里不用 `track` 的分段缓动，因为那样每到一个机位都会刹停。

## 4. 后期 `post3d.js`

这里既不用官方的 `EffectComposer`（它在构造时会创建 Clock），也不用 pmndrs 的 `EffectPass`（它在内部累积 time），而是自己串联 render target：

```
场景 → rtScene（HalfFloat 线性 HDR；可选 MSAA；景深时带深度纹理）
  ├ bloom   亮部提取(软膝) → 13 tap 下采样 × levels → 3×3 帐篷上采样回 1/2   （Jimenez 2014 / UnrealBloomPass / pmndrs MipmapBlur）
  ├ dof     单遍螺旋采样聚集（Gustafsson 2018），分辨率可调；CoC = blur·|1 − focus/z|，近处的大模糊能盖到焦内物体上
  ├ godrays 亮部提取(1/4) → 朝光源屏幕位置径向模糊（GPU Gems 3 ch.13）；光源在相机后面时不画
  └ 合成一遍（pmndrs 的"效果合进一个着色器"）：故障位移 → 色差 → 叠泛光/体积光 → 曝光 + 色调映射 → sRGB → 暗角 → 扫描线 → 颗粒
```

```js
const post = createPost(S, { samples: 0, bloom: { levels: 5 }, dof: { resolution: 0.5 }, grain: true, vignette: true, seed: 7 });
// 每帧（S.frame 的 paint 返回它）：
{ exposure, bloom: { threshold, knee, strength, radius }, dof: { focus, blur, maxBlur },
  godrays: { light: [x,y,z] | lightUV: [u,v], threshold, density, decay, weight, exposure },
  chroma: { amount }, grain: { amount, fps, size? }, vignette: { amount, radius, softness },
  scanlines: { count, amount, phase? }, glitch: { amount, rate, slices, shift, split? } }
```

- **结构参数**（启用哪些效果、几级、几步、什么分辨率）在调用 createPost 时确定，着色器只编译一次。
- **风格参数每帧都要全量传入，没有默认值**：缺少任何一个都会抛错。缺失的参数既不会沿用上一帧的值（那是跨帧状态），也不会取一个「好看的默认值」（那是审美判断）。
- 强度为 0 的那一帧会跳过整条子链（合成时这一项的权重恰好为 0，读到的旧纹理乘以 0，输出与完整跑一遍逐位相同），所以景深只在需要它的段落里产生开销。
- **颗粒按帧号播种**：种子为 `floor(t·fps)`，fps 必须填写（取 24、12 还是逐帧，属于风格选择）。同一个 t 得到同一帧颗粒；运动模糊的各个子帧落在同一帧内，颗粒也相同。
- **故障按时间桶取值**：用 `floor(t·rate)` 决定哪些横切片发生错位。每个桶的内容都是 t 的函数，这和「按秒分桶的缓存键」（compositing.md §2）不是一回事。
- **色差、颗粒会吃细边**：色差把边缘拆成错位的彩色重影，颗粒给平面加一层逐像素噪声，两者都和物体尺寸无关、只和像素有关，所以细线物体在竖版 1080 宽下受影响最大，再经 H.264 压缩就读作发虚。本仓库样例 xa-agent 在 chroma 1.5、grain 0.05 时细环边缘发虚，降到 0.6 / 0.025 后改善（同时开了 MSAA，两项改动没有拆开测）。取多少是本片的事；判断时看全分辨率静帧，缩小版看不出来。
- 色调映射使用 renderer.toneMapping（构造时选定），曝光每帧设置。最后一遍渲染到 `output`（RT）时不做色调映射（three 只在输出到屏幕时做）。

## 5. 粒子 `particles3d.js`

```js
const rain = createParticles(S, { count, seed, blending: 'add', sprite: SPRITE.atlas(8), uniforms: { uAtlas: tex },
  kernel: `void particle(float id, vec4 rnd, vec4 rnd2, float t, inout vec3 pos, inout float size, inout vec4 col, inout float aux){ ... }` });
S.scene.add(rain.points);  // paint 里：rain.update(t, { 这一帧要变的 uniform })
```

- **闭式解**：粒子 i 在 t 时刻的状态 = f(i, 它的 8 个种子随机数, t)。种子在加载期由 mulberry32 生成（与 film-core `rand.js` 的 `seeded()` 是同一个算法）。
- `PARTICLE_GLSL` 提供：`hash12/hash13/vnoise/vnoise3/fbm`（来自 webfx.js）、`lifecycle(t, life, phase)`（返回第几次生命以及本次生命内的 age）、`rebirth(id, k)`（第 k 次重生时的随机数）、`drift(p, s)`（平滑的位移场）。寿命循环的粒子在 t 时刻的状态只依赖 `(i, floor(t/life + phase))`。
- **和 `spritefx3d.js` 的分工**：这里是点精灵 + 片子自写的闭式运动，适合大量同质粒子；事件触发、按速度拉长、受光烟图集、深度软交界走 spritefx3d（`world-surfaces.md` §4）。
- **位移场不是平流**：`p = 出生点 + v·age + drift(出生点, age)·幅度`，粒子并不是被速度场带着走的。如果确实要沿 curl 场积分，要用 film-physics 的「从 0 重放」或检查点方案，再交给 `createCPUParticles` 绘制。
- `createCPUParticles(S, { count, seed, fn(i, rnd, t, out) })`：每帧在 JS 里算出全部粒子并整块上传；`update(t)` 返回位置数组（锚点或碰撞需要用到位置时使用）。
- sprite 可以用 `SPRITE.disc / soft / square / atlas(cols)`，也可以自己写 `vec4 sprite(vec4 col, float aux)`；`blending` 必须填写。不提供默认的形状和混合方式。
- 小于 1px 的点按覆盖面积降低 alpha（而不是缩成 0），因此跨帧不会闪烁。
- 锚点：GPU 粒子的位置不在 CPU 上，所以登记的是**闭式解保证粒子始终位于其中的那个体积**（用 `S.anchorBox`），见第 9 节的盲区说明。

例子：「数字雨」（夹具 `tests/fixtures/_test-3d`）每个格子一个粒子，按列哈希出速度和相位，头部位于第 `mod(t·speed + 相位, span)` 行，拖尾按 `exp(-d/trail)` 衰减；字形由 `hash13(列, 行, floor(t·rate + 相位))` 从种子化的 5×7 点阵图集中选取（不依赖字体回退）。「星尘」用 `lifecycle` 加 `rebirth` 给出出生点，再绕轴螺旋上升并叠加 `drift`。

## 6. 程序化表面：图案随 t 变，写进 PBR 材质

像「线条在棋盘面上长出来」这类效果，如果每帧重画 2D 贴图再上传，需要 2–4 ms（1080 级分辨率），还要管理缓存键。另一种做法是通过 `material.onBeforeCompile` 向 `MeshStandardMaterial/MeshPhysicalMaterial` 注入代码：在 `#include <map_fragment>` 之后修改 `diffuseColor`，在 `<roughnessmap_fragment>` 之后修改 `roughnessFactor`，在 `<emissivemap_fragment>` 之后加上 `totalEmissiveRadiance`。
uniform 放进一个共享对象 `U = { uT: {value} }`，在 `onBeforeCompile` 里执行 `Object.assign(shader.uniforms, U)`，并在 paint 里每帧全部重写（复位管不到它）。
图案用 `fwidth` 做解析抗锯齿，斜着看也不会走样；打光、阴影、清漆和景深照常作用在图案上。例子见 `films/weiqi-fx-open/scene.html` 里的盘面线、星位和交叉点亮点。
木纹这类与 t 无关的纹理，可以在加载时用 webfx 的 `createShaderLayer` 渲染一次，拷进 2D canvas 作为 `CanvasTexture`（见 `films/weiqi-fx-open` 的 `bakeWood`）。

## 7. 代价表（实测）

数据来自仓库开发工具 `node dev/film-webfx/bench3d.mjs`：在基准场景上逐项添加，每次 `S.frame()` 之后读取 1 个像素强制画完，取中位数（ms），增量相对于同画幅的基准。后期的成本只与像素数有关，换到别的场景，增量大致不变。如果同时有其他渲染任务在跑，数字会高一截（测量时的负载见 docs/verified/film-webfx.md §8）。

| 项目（基准 = 一个 PBR 多面体 + 地面 + 方向光，直接上屏） | 1080×1920 | 1920×1080 | 什么时候值得付 |
|---|---:|---:|---|
| 基准 | 8.7 | 7.6 | — |
| 后期直通（HDR RT 加一遍合成，不开任何效果） | +11.0 | +10.6 | 只要用后期就得付这一遍；之后每加一种逐像素效果，边际成本都很小 |
| 色差 / 颗粒 / 暗角 / 扫描线 / 故障（各自单独开启，含直通） | +15.6 / +10.7 / +10.9 / +10.9 / +16.7 | +16.0 / +11.1 / +11.0 / +11.1 / +17.3 | 颗粒、暗角、扫描线在直通之上几乎不额外花钱；色差和故障各多约 +5（需要多次取色） |
| 上面五样合进一遍 | +18.7 | +18.8 | 比分开做（5 遍，每遍各付一次约 11 的固定成本）省约 45 ms |
| 泛光（5 级下采样链） | +35.6 | +35.6 | 需要高光真正发光时；只想让画面「柔一点」时用不着 |
| 景深（1/2 分辨率，maxBlur 16 px） | +77.7 | +78.3 | 焦点本身就是戏的一部分时（拉焦、用虚化交代「传说」）；采样数与 (maxBlur·分辨率)² 成正比，blur=0 的帧会整条跳过 |
| 体积光（48 步，1/4 分辨率） | +23.3 | +23.2 | 光源在画面内或附近、需要光束时 |
| 全部后期 | +138.4 | +138.7 | — |
| 默认帧缓冲 MSAA 4× | +8.8 | +8.4 | 不走后期时用于抗锯齿 |
| 后期 HDR RT 开 MSAA 4× | +53.4 | +53.2 | 很贵：多重采样 RT 的 resolve 在 SwiftShader 下很慢；先确认锯齿是否真的看得见。不开的代价：细圆环、发光描边、细走线这类细几何会出阶梯锯齿，运动中闪烁，经 H.264 压缩后读作毛边、「整体发糊」（本仓库样例 xa-agent：用户评「边缘不清晰」，开 4× 后同帧细环变成干净实线；该片的逐帧增量未单独测） |
| 软阴影（PCF，2048² 阴影图，一盏灯） | +5.5 | +5.2 | 便宜：物体稳稳放在平面上的感觉主要靠它 |
| GPU 闭式粒子 1 万 / 10 万 | +0.9 / +11.3 | +1.0 / +11.1 | 几万个以内几乎不花钱 |
| CPU 闭式粒子 1 万 / 10 万 | +1.3 / +15.3 | +1.2 / +13.8 | 需要在 JS 侧拿到粒子位置时（锚点、碰撞、来自 film-physics 的轨迹） |
| 每帧复位（303 个对象） | reset() 0.4 | 0.4 | 默认开启；几乎不花钱 |
| 参照：截一张 PNG | ≈50 | ≈50 | 整支片子的参照：`weiqi-fx-open`（PBR + 清漆 + 环境反射 + 软阴影 + 景深 + 泛光 + 颗粒 + 暗角）seek 中位数为 409 ms |

景深的采样数约为 (maxBlur·分辨率)² / (2·step)（maxBlur 16、1/2 分辨率时约 64 次，每次读两次纹理）；泛光的主要成本在 1/2 分辨率的前两级。估算整支片子的渲染时间：`帧数 × (seek + ≈50–300 ms 截图)`。

## 8. 阴性对照：门会不会红（夹具 `tests/fixtures/_test-3d`）

| 入口 | 写错了什么 | seamcheck |
|---|---|---|
| `scene.html` | 正片 | **全部通过**（1a / 2 / 1b / 探针） |
| `scene-bad-noreset.html` | 设置 `reset:false`，只在 t>3.5 时写 `rings.visible=false`，从不写回 | **门 2 不通过**（24–50 万像素不同），1a、1b 照常通过 |
| `scene-sloppy-reset.html` | 同样漏写，但设置了 `reset:true` | **全部通过**：复位兜住了这个错误 |
| `scene-bad-integrate.html` | 按 dt 带阻尼逐帧积分位置 | **门 2 不通过** |
| `scene-bad-clock.html` | 在 seek 里调用 `new THREE.Clock().getElapsedTime()` | **抛错退出**，错误信息里写明了该用什么 |

匀速积分 `p += v·dt`（v 为常数）可以化简成闭式解，因此能通过全部门；只有速度依赖状态的积分才会和求值顺序有关。所以判断依据不是「有没有积分」，而是门 2 的结果。

## 9. 盲区与没解决的

- **景深看不到透明粒子**：加法混合的粒子不写入深度，景深会按粒子身后物体的深度给它计算 CoC，所以近处的粒子不会按自己的距离虚化（`weiqi-fx-open` 的浮尘是通过「对焦到浮尘所在那一层的距离」来表现焦点拉走的）。要让粒子各自虚化，可以让粒子写入深度（代价是加法混合会出现排序问题），或者在粒子着色器里按自身的 CoC 放大 sprite。
- **GPU 粒子的锚点是一个体积，而不是粒子本身**：登记的是闭式解保证的范围，不是这一帧粒子实际占据的位置。遮挡门对粒子云只能做保守判断。
- 锚点只说明「画在哪里」，不说明「看不看得见」（见 film-core `references/runtime.md` §6）：被挡住或被景深糊掉时，框照样存在。
- 预乘 alpha 的舞台叠在 2D 上时，色调映射作用在预乘色上，半透明边缘的亮度会略有偏差。夹具都使用不透明的舞台，没有测量过。
- `AnimationMixer.setTime` 配合带淡入淡出权重的 action、SkinnedMesh、morph 动画：都没有夹具测试过。
- 本机 Metal 的局部天空/表面/模型/扩展后期代价已测，见上述参考页与仓库 verified 记录；其他显卡/驱动未测，PCFSoft 和 PMREM 跨后端不承诺同像素。后期 RT 开 MSAA 并带深度纹理时，景深边缘是否正确仍未验证。
