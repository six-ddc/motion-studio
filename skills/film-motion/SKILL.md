---
name: film-motion
description: 二维画面动效与转场的原理与选型：缓动曲线度量（t80、预备、过冲、cubic-bezier、阶跃、弹簧缓动）、交错编排、剪辑点对齐旁白、各类转场原理（擦除、亮度图溶解、推移、穿越缩放、甩镜、故障切、漏光、匹配剪辑、Magic Move 共享元素）、矢量路径动画（按弧长采样、描边生长、形状变形 morph、沿路径运动）、透视斜看平面、从截图重建产品界面、动态数据图表（柱状图竞赛、折线生长、轴域伸缩、地图航线、力导向）及压扁扫描 tiltcheck。做转场、选缓动、错峰入场、共享元素变形、描边生长、路径运动、斜俯视平面、复刻产品 UI、动态图表或觉得"斜平面像压扁的"时加载。
---

# film-motion

讲二维画面**怎么动、怎么换镜头**：只给原理、在 `seek(t)` 下的难点、实测代价与坑，**不带运行时、不规定默认缓动或转场**。你可以手写代码，也可以自由接入 GSAP、D3、PixiJS、Lottie 等成熟库（只要关掉自带循环由 `t` 驱动，见 `film-core/references/kernel.md` §3）；基础运动原语（`win`/`spring`/`follow`/`camera`/`sequence`/`beatGrid`）在 `film-core` 可按需 import。

## 动手前先想三件事

1. **运动动机**：入场和转场在说什么（揭示、对比、推进还是进入细节）？避免每支片都退回“cubic.out 居中弹出 + 叠化”。
2. **时间真相源**：剪辑点与关键动作从 `vo.at()`、`beatGrid` 或具名时刻表读取，不手填散落秒数。
3. **可 seek 化**：跨帧累积（拖影、力导向展开、名次交换）在加载期预算好查表或改写为闭式函数。

## 能力与参考地图

| 主题 | 核心要点与坑 | 详阅 |
|---|---|---|
| **缓动与交错** | 按数字（`t80`、过冲、预备）选曲线，不按名字猜；交错延迟用种子随机或距离函数，不用 `Math.random` | `references/transitions.md` §6–7 |
| **镜头与转场** | 双镜头 `paint` 进离屏层按进度合成；窗口 `[cut - align·dur, cut + (1-align)·dur)`。坑：以 canvas 为图源缩放时 `imageSmoothingQuality='high'` 会引入跨帧依赖（门 4 可抓） | `references/transitions.md` §2–5、§8 |
| **矢量路径与变形** | 加载期压平曲线建弧长表，seek 期 O(1) 查表实现描边生长、沿路径朝向与 morph（凹/自交形直线插值会打结） | `references/shapes.md` |
| **斜看平面透视** | Canvas 2D 仿射压扁是正交投影、平行线不汇聚；要真透视用针孔相机投影（JS 投物件 + Shader 反投影平面）；真三维走 `film-webfx` | `references/camera3d.md` |
| **产品 UI 重建** | 按原截图坐标用 HTML/Canvas 重建、`set(state)` 纯函数全量写状态、从 DOM 量高亮框；按 `原字号×缩放×变焦` 算屏幕可读字号 | `references/ui-rebuild.md` |
| **动态数据图表** | 静态几何借 `d3-scale`/`d3-shape`/`d3-geo`；名次交换、折线生长、轴刻度进出、力导向布局在加载期预解、seek 期查表 | `references/dataviz.md` |
| **效果反查表** | 按效果名直接查对应 skill 与文档 | `references/effects.md` |

## 压扁扫描（可选，`tiltcheck.mjs`）

```bash
node <film-motion>/scripts/tiltcheck.mjs --film <slug> [--format 9x16] [--sample-fps 4] [--strict]
```

拦截 2D 变换矩阵，大面积非等比压扁时报 LOOK（不判 FAIL；刻意正交可在 `style_guide` 的 `critique` 块写 `"ortho_ok": "<理由>"`）。本 skill `gates.json` 为空，由 `film-critique` 的 `tilt` 检查按需复用，离屏合成确定性由 `deliver` 的门 4 兜底。
