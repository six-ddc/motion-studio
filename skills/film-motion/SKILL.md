---
name: film-motion
description: 二维画面"怎么动、怎么换镜头"的动效词汇：缓动表 EASE 与 easeOf（预备、过冲、回弹、cubic-bezier、阶跃）、交错编排 stagger（顺序/距离/网格/种子错峰）、镜头+转场时间轴 timeline（剪辑点对齐旁白里的字）、转场库（擦除、亮度图溶解、推移、穿越缩放、甩镜、故障切、漏光、匹配剪辑、Magic Move 共享元素）、透视相机 camera3d（斜看棋盘桌面地面）、从截图重建产品界面（App/网页界面演示）、压扁扫描 tiltcheck。要做转场、选缓动曲线、让一组元素错峰入场、两个镜头之间共享元素平滑变形、斜俯视一个平面、复刻产品界面，或觉得"斜着的平面看起来是扁的"时加载。
---

# film-motion：二维动效词汇

本 skill 提供缓动、交错、镜头与转场、透视相机、界面重建，建在 film-core 之上：`seek(t)` 契约、运动基元（`settle/spring/follow/camera/beatGrid`）、
`seeded/hash01`、布局、锚点、渲染、seamcheck、deliver 都在 film-core（`../film-core/SKILL.md`、`../film-core/references/kernel.md`）。

边界：文字动效归 film-typography；着色器、三维、后期归 film-webfx；粒子与碰撞归 film-physics；转场用在哪里，由 film-story 和本片 `docs/style_guide.md` 决定。

**没有默认缓动、默认转场、默认颜色**：缺了就抛错。下面的表格列的是可用的词汇和各自的代价，不是推荐。

## 0. 运行时

| 文件 | 提供什么 | 依赖 |
|---|---|---|
| `choreo.js` | `EASE` `easeOf` `resolveEase` `easeInfo` `envelope` `stagger` `timeline` `cutsFrom`（区间进度函数 `win` 在 film-core 的 `motion.js` 里） | film-core `motion.js` |
| `transitions.js` | `createStage`（舞台：单个镜头时直接画，转场时把两个镜头分别画进离屏层再合成）、`TRANSITIONS` 表、`mixColor` `mixProps` | `motion.js`、`choreo.js` |
| `camera3d.js` | `camera3d` `distanceForFov` `orthoDeviation` `edgeRatio` `CAMERA3D_GLSL` | 无 |
| `uirebuild.js` | `localRect` `placeReplica` `screenPx` `zoomFor` `strings` | 无 |

场景里直接 `import './runtime/choreo.js'`：服务器把 `/runtime/<名>` 映射到已安装 skill 的 `assets/runtime/`，deliver 时冻结进片子（`../film-core/references/runtime.md` §2）。
这些函数全部是 t 的纯函数，`timeline()` 在加载时建一次，seek 里只查表。在 Node 里 import（测量缓动、离线计算剪辑点）之前，先调用 film-core `lib/runtime-node.mjs` 的 `registerRuntimeResolver()`，否则 `./motion.js` 解析不到。

## 1. 缓动与交错（`choreo.js`）

```js
import { EASE, easeOf, easeInfo, envelope, stagger } from './runtime/choreo.js';
import { win } from './runtime/motion.js';                  // film-core：区间进度，ease 给函数
const inA = easeOf.cubicBezier(0.2, 0, 0, 1);              // CSS 写法
const p   = win(t, 1.2, 0.6, EASE.back.out);               // 区间进度 = ease(sat((t-1.2)/0.6))，dur=0 是阶跃
const a   = envelope(t, [0.5, 0.4, 'quad.out'], [3.0, 0.3, 'quad.in']);   // 入场 × 出场
const d   = stagger(24, { each: 0.04, from: 'center', grid: [6, 4], ease: 'quad.in' });   // d[i] = 第 i 个的延迟秒数，d.total 总跨度
easeInfo('back.out');   // → { overshoot, anticipation, peakAt, monotonic, halfAt }，按手感数字选
```

- **`EASE`**：Penner 族（quad/cubic/quart/quint/sine/expo/circ，每种都有 in/out/inOut/outIn），外加 `back`、`elastic`、`bounce`；
  `easeOf` 提供 `anticipate` `cubicBezier` `steps` `spring`……。字符串 `'cubic.inOut'` 和函数都能用（由 `resolveEase()` 解析）。
- **t80**（第一次走到 80% 行程时的 p）：越小，手感越接近"一下到位再慢慢收住"；越大，越接近"蓄着劲最后才到"。全表见 transitions.md §7；参考片的 t80 用 film-story 的 `motionprint.mjs` 测量。
- **`stagger(n, {each|amount, from, grid|positions, axis, ease, seed})`**：语义与 GSAP 相同，参数表见 transitions.md §8。

过冲用在小物件上看起来是弹性，用在大面积上看起来是晃动，用在正文上会影响阅读；要不要用、用多少，由 style_guide 决定。

## 2. 镜头 + 转场（`timeline` + `createStage`）

接口只有一种形式：**输入两个镜头的 paint 函数和转场进度，画出这一帧**。

```js
import { timeline } from './runtime/choreo.js';
import { createStage } from './runtime/transitions.js';
import { createAnchors } from './runtime/anchors.js';      // film-core，可省
const TL = timeline([
  { shot: 'a', paint: paintA },
  { cut: vo.at('纯函数'), kind: 'wipe', dur: 0.5, align: 0.5, ease: 'cubic.inOut', shape: 'iris', focus: '黄车', feather: 0.06 },
  { shot: 'b', paint: paintB },
  { cut: vo.endOf('移'), kind: 'magicMove', dur: 0.7, align: 1, ease: 'cubic.inOut', root: 'crossfade' },
  { shot: 'c', paint: paintC },
], { end: window.DURATION });
window.MARKS = TL.marks();             // 镜头的名义区间，stills.mjs 不给 --at 时取中点
const A = createAnchors(canvas);
const S = createStage(canvas, { anchors: A, L });
window.seek = A.install((t) => S.frame(t, TL));
// 不用时间轴：S.mix(kind, { paint: pa, lt: la }, { paint: pb, lt: lb }, pe, opts)
```

剪辑点 `cut` 是绝对秒数，可以直接写旁白时间戳；转场窗口是 `[cut − align·dur, cut + (1−align)·dur)`。镜头的 `paint(ctx, lt, sh)` 必须铺满不透明的底色，
命名元素通过 `sh.el` / `sh.anchor` 登记。语义与校验见 `references/transitions.md` §1–§2、§9。

转场 kind 分几类：切和叠化 `cut` `crossfade` `dip`；遮罩擦除 `wipe`（linear / iris / clock / box / bars / custom）；亮度图溶解 `luma`（noise / grain / 自带灰度图，可以烧边）；
空间类 `push` `slide` `zoom` `zoomThrough`；能量类 `whip`（场景内对数步长拖影）`glitch` `leak`；关系类 `match`（匹配剪辑）`magicMove`（共享元素）。
以下章节号都指 `references/transitions.md`：每个转场都要付出的观众注意力代价见 §0；全部参数、实测耗时（1080p SwiftShader，从约 0 到 100 ms）以及廉价感从哪里来见 §3；
Magic Move（同名 `sh.el` 之间插值边框和 `props`，颜色在 OKLab 空间里混合）见 §4；匹配剪辑见 §5；甩镜的两种做法（场景内拖影，或渲染器子帧运动模糊）见 §6。

**确定性问题**：把 canvas 当图源做缩放 `drawImage` 时，`imageSmoothingQuality = 'high'` 会让结果依赖上一帧，只有门 4 能发现；场景自己在 seek 里这样设置也会出问题（transitions.md §10）。

## 3. 透视相机（`camera3d.js`）

斜着看一个平面（棋盘、桌面、地面）时用 `camera3d({ S, elevation, distance, look, screen, yaw })`，它返回 `project(x,y,z)` / `unproject(X,Y,h)` / `uniforms()`，
配合 `CAMERA3D_GLSL` 使用（`cam_unproject` 是 JS `project` 的精确逆运算：着色器画平面，JS 画平面上的东西，两者共用一个投影）。
`distanceForFov(fovY, S, H)` 按视场角反解距离；`edgeRatio(cam, w, h)` 给出远边与近边的宽度比；`orthoDeviation(cam, 角点)` 给出透视投影与纵向压扁（正交）之间的最大像素差。
要和三维场景对齐时，film-webfx `camrig.js` 的 `fromCamera3d()` 能把同一组参数换算成 three 的镜头。约定、公式、判断正交何时够用的表格和跟拍手法见 `references/camera3d.md`。

## 4. 压扁扫描（`scripts/tiltcheck.mjs`）

```bash
node <film-motion>/scripts/tiltcheck.mjs --film <slug> [--format 9x16] [--sample-fps 4] [--entry x.html] [--strict]
```

某组变换下的 2D 绘制面积不小于画布的 10%、且奇异值比小于 0.9 时，报告为**疑点**（加 `--strict` 才会 exit 1），只能报 LOOK；有意使用正交的片子，在 critique 块里写 `"ortho_ok": "<理由>"`。
判据与盲区见 `references/camera3d.md` §压扁扫描。逻辑在 `scripts/lib/tiltscan.mjs` 里；film-critique 的 `tilt` 检查通过 `capability('film-motion')` 复用它。

## 5. 产品界面重建（`uirebuild.js`）

复刻 App 或网页界面的做法是：在截图的像素坐标里绝对定位，文字集中放在一张表里，界面状态写成 `set(state)` 的纯函数，用 `placeReplica` 放进画面，
用 `localRect` 从 DOM 量出元素框，用 `zoomFor` 计算可读性；逐状态对照页 `assets/ui-rebuild/compare.html` 是开发期工具。做法与代价见 `references/ui-rebuild.md`。

## 6. 门

`gates.json` 登记了一道"用了才开"的门：片子实际加载了 `transitions.js` 时，`accept --deep` 会跑 seamcheck 门 4（`--parallel 4`，原因见本文 §2 的确定性问题）。
deliver 总是开启门 4，不会重复跑。tiltcheck 只报告疑点，不算门；要在评审里看它的结果，就在 film.json 的 `checks` 里声明 `tilt`（由 film-critique 处理）。

## 下层文档

- `references/effects.md`：按效果检索全套运行时，每条列出对应的函数、所在 skill 与文件、代价；手写一个有名字的效果之前先查它
- `references/transitions.md`：代价、时间轴语义、转场全表与耗时、Magic Move、匹配剪辑、甩镜、缓动表（t80）、交错、旁白对接、确定性问题
- `references/camera3d.md`：透视相机约定与公式、正交与透视之间可计算的判据、跟拍手法、压扁扫描的判据与盲区；`references/ui-rebuild.md`：从截图重建产品界面的做法与代价
