---
name: film-motion
description: 二维画面"怎么动、怎么换镜头"的方法与代价：缓动曲线的选择与度量（预备、过冲、回弹、cubic-bezier、阶跃、弹簧当缓动）、交错编排（顺序/距离/网格/种子错峰）、剪辑点对齐旁白里的字、转场的原理与实现（擦除、划像、亮度图溶解、推移、穿越缩放、甩镜、故障切、漏光、匹配剪辑、Magic Move 共享元素）、矢量形状动画（按弧长采样、描边生长/修剪路径、两个形状之间变形 morph、沿路径运动并自动朝向）、透视斜看一个平面（棋盘、桌面、地面）、从截图重建产品界面（App/网页界面演示）、数据图表动效（柱状图竞赛、折线生长、坐标轴伸缩、地图与航线、力导向展开），以及压扁扫描 tiltcheck。要做转场、选缓动曲线、让一组元素错峰入场、两个镜头之间共享元素平滑变形、线条描出来、图形变成另一个图形、物体沿路径跑、斜俯视一个平面、复刻产品界面、让图表随数据动起来，或觉得"斜着的平面看起来是扁的"时加载。
---

# film-motion：二维动效的原理与代价

本 skill 讲二维画面怎么动、镜头怎么换：每个话题给**原理**（算法、关键公式、短伪代码）、**在 `seek(t)` 下难在哪**、**代价与什么时候值得**、**实测过的坑**。
它不带运行时：代码由你按本片需要写，或者用成熟的库。唯一无条件的约束是 film-core 的 `seek(t)` 纯函数契约（`<film-core>/references/kernel.md`）；
运动基元（`win` `spring` `settle` `follow` `camera` `beatGrid` `sequence`）、种子随机（`seeded` `hash01`）、布局、锚点在 film-core 的运行时里，可以直接 import。

边界：文字动效归 film-typography；着色器、三维、后期归 film-webfx；粒子与碰撞归 film-physics；转场用在哪里、用不用，由 film-story 和本片 `docs/style_guide.md` 决定。

**没有默认缓动、默认转场、默认颜色。** 下面列的是可用的手法和各自的代价，不是推荐；选哪个写进本片 style_guide。

## 0. 先想清楚再写代码

模型自己写动效时最常见的失败不是写不出来，而是每支片子都写成同一套：cubic.out 入场、叠化转场、居中弹出。动手前回答三个问题：

1. **这个运动在说什么？** 入场是"出现"还是"被放下"？转场是"时间过去"还是"钻进去看细节"？说不出来的运动多半是装饰。
2. **时间真相源是什么？** 旁白的字（film-narration 的 `vo.at`）、音乐节拍（film-core `beatGrid`）、还是镜头表自己的时长？剪辑点从真相源读，不手填秒数。
3. **它在 `seek(t)` 下怎么算？** 每个动画都要能写成"给定 t，直接算出这一帧"。需要上一帧才能算的东西（拖影、累积、仿真），要么换成闭式、要么加载期预算好查表。

有现成库时用库，不重造轮子（每节末尾列了可选的库和"怎么用 t 驱动它"）；但库的参数空间就是它的边界，画面要的东西在边界外时自己写。

## 1. 缓动与交错 → `references/transitions.md` §6–§7

- **缓动**是 `p → 值` 的函数，作用在区间进度上：`ease(sat((t − start)/dur))`（film-core 的 `win` 就是这个）。Penner 族、back、elastic、bounce、CSS `cubic-bezier`、`steps`、"弹簧归一化成缓动"都能几行写出来。
- **按数字选，不按名字选**：量 t80（第一次走到 80% 行程时的 p）、过冲、预备量。表和测量方法在 transitions.md §6；参考片的 t80 用 film-story 的 `motionprint.mjs` 测。
- **交错**是"每个单元一个延迟"：延迟 = ease(到起点的归一化距离) × 总跨度。随机错峰必须用种子随机（`Math.random` 违反契约）。

过冲用在小物件上读作弹性，用在大面积上读作晃动，用在正文上会妨碍阅读；用不用、用多少由 style_guide 决定。

## 2. 镜头与转场 → `references/transitions.md`

接口只有一种形状：**给两个镜头的 paint 函数和转场进度，画出这一帧**。

- **时间轴**：剪辑点是绝对秒数，直接写旁白时间戳；转场窗口 `[cut − align·dur, cut + (1−align)·dur)`，窗口内两个镜头都在画、各自按局部时间推进。
  film-core 的 `sequence` 已经给出镜头表、交棒窗口、`MARKS`；本 skill 讲窗口里怎么合成。
- **转场分类**：切与叠化；遮罩擦除（直线、iris、时钟、方框、百叶、自定义形状）；亮度图溶解（可烧边）；空间类（推、覆盖、缩放、穿越缩放）；能量类（甩镜、故障、漏光）；关系类（匹配剪辑、Magic Move）。
  每种的原理、实测耗时（1080p SwiftShader，约 0–100 ms）、廉价感从哪来，见 transitions.md §2–§5。
- **在 seek(t) 下难在哪**：两个镜头要先各自画进离屏层再合成；离屏层是复用对象，不能承载跨帧信息；以 canvas 为图源做缩放时 `imageSmoothingQuality = 'high'` 会让结果依赖上一帧（只有逐帧比较的门 4 抓得到）。见 transitions.md §8。

## 3. 矢量形状 → `references/shapes.md`

路径按弧长采样后，三件事都是查表：**描边生长**（AE Trim Paths：取弧长区间 [start, end] + offset）、**沿路径运动**（取弧长 s 处的点与切线）、**形状变形**（两边重采样到同点数、统一绕向、旋转起点使位移最小、逐点插值）。
难点在加载期：压平曲线、建弧长表、配对与对齐都只做一次，seek 里只查表。凹形、自交形状变形时中间态会打结——这是逐点直线插值的结构性代价，shapes.md §6 有实测表。

## 4. 透视斜看一个平面 → `references/camera3d.md`

canvas 2D 只有仿射变换。把平面 `setTransform` 纵向压扁是**正交投影**：平行线不收拢，斜放的正方形看上去就是长方形。
要透视就写一个针孔相机：JS 侧 `project` 画平面上的东西，着色器侧用同一组公式按像素反投影画平面本身。公式、什么时候压扁就够（可计算的判据）、跟拍手法见 camera3d.md。真三维场景走 film-webfx。

## 5. 压扁扫描（`scripts/tiltcheck.mjs`）

```bash
node <film-motion>/scripts/tiltcheck.mjs --film <slug> [--format 9x16] [--sample-fps 4] [--entry x.html] [--strict]
```

seek 期间拦截 2D 绘制，按变换矩阵分组记屏幕外包框；某组面积 ≥ 画布 10% 且奇异值比 < 0.9 时报**疑点**（`--strict` 才 exit 1）。
只能报 LOOK：斜放正方形的正交像与正俯视长方形逐像素相同，是不是问题只有作者知道。有意用正交的片子在 style_guide 的 critique 块写 `"ortho_ok": "<理由>"`。
判据与盲区见 camera3d.md §4。逻辑在 `scripts/lib/tiltscan.mjs`；film-critique 的 `tilt` 检查通过 `capability('film-motion')` 复用它（在 film.json `checks` 里声明 `tilt`）。

## 6. 产品界面重建 → `references/ui-rebuild.md`

照着截图用 HTML/canvas 重建界面，在截图自己的像素坐标里绝对定位；文字集中在一张表里；界面状态是 `set(state)` 的纯函数（每次把所有可变属性写一遍）；
高亮框位置从 DOM 量；可读性是算术：屏幕字号 = 原字号 × 复刻缩放 × 镜头变焦。

## 7. 数据图表动效 → `references/dataviz.md`

比例尺、刻度、格式、序列几何用成熟的库（d3-scale、d3-shape、d3-geo）就够；本 skill 讲静态图表库没有的部分——**随 t 变化**：
柱状图竞赛的名次连续交换、折线生长、轴域随数据伸缩时刻度连续进出、地球自转与航线、力导向布局展开。共同原则：有状态的东西（交换事件、力导向仿真）在加载期算完，seek 里只查表。

## 8. 门

本 skill 没有门（`gates.json` 为空）。用了离屏层缩放合成的片子，deliver 本来就会跑 seamcheck 门 4（顺序渲染与并行渲染逐帧比较），transitions.md §8 的坑由它兜底。

## 下层文档

- `references/effects.md`：按效果名检索——想要的效果 → 原理在哪个 skill 的哪份文档；手写一个有名字的效果之前先查
- `references/transitions.md`：转场的代价、时间轴语义、各转场的原理与实测耗时、Magic Move、匹配剪辑、甩镜两条路、缓动表（t80）、交错、确定性的坑
- `references/shapes.md`：路径压平与弧长采样、描边生长、morph 的算法与代价、沿路径运动、实测数字与局限
- `references/camera3d.md`：针孔相机公式、正交与透视之间可计算的判据、跟拍手法、压扁扫描的判据与盲区
- `references/ui-rebuild.md`：从截图重建产品界面的做法与代价
- `references/dataviz.md`：随 t 变化的数据图表：关键帧、柱状图竞赛、折线生长、刻度进出、地理投影、力导向、跨引擎一致
