# 按效果检索：效果 → 原理在哪

目录：转场与镜头 · 2D 动效与编排 · 矢量形状 · 数据图表 · 文字 · 三维与后期 · 物理与粒子 · 声音与时间

用途：从"想要的效果"找到讲它原理、代价和坑的那一节，然后按本片需要自己写，或用那一节列出的库。唯一要守的是 `seek(t)` 契约（`<film-core>/references/kernel.md`）。
这张表只是索引，不排优劣，也不给默认选择。「在哪」一列：本 skill 的写 `references/…` 路径；别的 skill 写"skill · 文档"；仍随套件安装的运行时写"skill · 文件"，可以直接 import。
代价一列摘自各处的代价表（ms 为 1080p SwiftShader 实测）。

| 效果（常见叫法） | 在哪 | 代价摘要 |
|---|---|---|
| **转场与镜头** | | |
| 镜头表、剪辑点对齐旁白、交棒窗口 | `references/transitions.md` §1；core · motion.js 的 `sequence` | 窗口重叠、剪辑点找不到字都应当报错而不是悄悄修正 |
| 硬切、叠化、闪黑/闪白 | `references/transitions.md` §2 | 0–3 ms；处处叠化，片子没有骨架 |
| 擦除、划像（iris）、时钟擦、百叶窗、字形遮罩 | `references/transitions.md` §2 | 5–10 ms；从主体出发读作世界的一部分，从画面中心无故打开像幻灯片 |
| 噪点溶解、亮度图溶解、烧边 | `references/transitions.md` §2 | 50 ms；粗颗粒 + 宽软边 + 亮烧边变成满屏斑块；8 位台阶 |
| 推、滑入、缩放转场、钻进画面里的东西 | `references/transitions.md` §2（穿越缩放有伪代码） | 13–15 ms；推移方向要和画内运动一致 |
| 甩镜、拖影、运动模糊 | `references/transitions.md` §5；渲染器子帧见 film-core render | 场景内拖影 100 ms/帧；子帧模糊渲染时间 × sub |
| 故障转场、漏光 | `references/transitions.md` §2 | 34–41 ms；和题材无关时只是装饰 |
| 匹配剪辑 | `references/transitions.md` §4 | 12 ms；需要缩小才能对上时对不准 |
| 共享元素、Magic Move、平滑切换 | `references/transitions.md` §3 | 6 ms；同时移动的太多会乱；只按名字配对 |
| 颜色渐变插值（OKLab） | `references/transitions.md` §3 | sRGB 插值中段发灰 |
| 2D 推拉摇、镜头缩放 | core · motion.js 的 `camera` / `applyCamera` | 相机运动和画内运动都用弹簧时容易晕 |
| 透视斜看平面、2.5D 斜俯视 | `references/camera3d.md` | 用压扁代替的代价是平行线不收拢；差多少可以算 |
| 3D 环绕、推轨、跟拍、手持抖；2D 标注贴 3D | film-webfx · three.md（镜头一节）；与二维相机对齐见 `references/camera3d.md` §6 | 都是 t 的纯函数 |
| 产品界面重建、放大到可读 | `references/ui-rebuild.md` | 原生控件像素级一致的代价是随浏览器版本变 |
| **2D 动效与编排** | | |
| 缓动曲线、cubic-bezier、阶跃、预备、过冲 | `references/transitions.md` §6；区间进度 core · motion.js 的 `win` | 按 t80/过冲数字选；elastic 用在正文上几乎总是廉价 |
| 弹簧、回弹；弹簧跟随、中途改目标 | core · motion.js 的 `spring` `settle` `follow` | 过冲用在正文上显得廉价 |
| 交错（顺序/中心/网格/随机） | `references/transitions.md` §7 | 超过约 15 个单元观众等不及；随机错峰读作"散" |
| 卡节拍 | core · motion.js 的 `beatGrid` | — |
| 跟随某个元素的位置（锚点） | core · anchors.js | 转场里要经过舞台登记，见 `references/transitions.md` §1 |
| 确定性随机、抖动取值 | core · rand.js 的 `seeded` `hash01` | 纯函数 |
| 多画幅自适应布局 | core · layout.js | 多一层坐标换算 |
| 事件驱动的多通道响应（闪光、后坐、屏震） | core · events.js；film-core · events.md | 非线性限位仍需重放 |
| **矢量形状** | | |
| 描边生长、线条描出来、两端收、跑动光段（trim path） | `references/shapes.md` §2 | < 0.01 ms/次；多子路径按总长走时短的一闪就过 |
| 形状变形、图形变成另一个图形、一个分裂成几个 | `references/shapes.md` §3 | 建表 0.2–2.4 ms；凹形/自交中间态会打结（§6） |
| 沿路径运动并自动朝向 | `references/shapes.md` §4 | lookahead 平滑拐角的代价是急弯切内道 |
| **数据图表** | | |
| 柱状图竞赛、排名交换 | `references/dataviz.md` §4 | 加载期建表 45–67 ms；交换密集时跟不上 |
| 折线/面积生长、末端跟标签 | `references/dataviz.md` §5 | 按 x 推进时陡坡段笔尖变快 |
| 坐标轴随数据伸缩、刻度淡入淡出 | `references/dataviz.md` §6 | blend 大则同屏刻度多、标签易挤 |
| 地图、地球自转、航线 | `references/dataviz.md` §7 | 正射 2000 点约 1–2 ms/帧；墨卡托高纬面积放大约 1/cos²φ |
| 关系图、力导向布局展开 | `references/dataviz.md` §8 | O(n²)：n=500 约 150–230 ms，上千个离线算 |
| **文字**（都在 film-typography · methods.md，按手法编号） | | |
| 逐字交错、kinetic typography、遮罩升起、按行升起、切分揭示 | film-typography · methods.md | 中文超过约 15 字逐字升起显得拖沓 |
| 打字机、乱码解码、数字滚动、逐字翻转 | film-typography · methods.md | 乱码字池里的字都要进字体子集 |
| 沿路径排字 | film-typography · methods.md；弧长采样器见 `references/shapes.md` §1 | 曲率大处中文字会挤 |
| 文字 Magic Move、词序重排 | film-typography · methods.md | 没有共享字时退化成叠化 |
| 可变字体轴、字重动画 | film-typography · methods.md；绘制在 typography · text.js | 依赖 Chromium；advance 变化会推开整行 |
| 字幕、逐词高亮 | typography · text.js；时间轴来自 narration · narration.js | 时间必须来自 narration.json |
| 中文断行、标点挤压 | film-typography · cjk.md | — |
| **三维与后期** | | |
| 着色器背景、噪声、fbm、domain warp、SDF | film-webfx · shaders.md；运行时 webfx · webfx.js | 1080×1920 下几 ms 到上百 ms，按复杂度分档 |
| 置换、水波、热浪、玻璃折射 | film-webfx · shaders.md（置换类扭曲） | 要把 2D 层当纹理传进去 |
| 泛光、色差、颗粒、暗角、调色、LUT、半调、像素化、勾线 | film-webfx · post.md、fxchain.md；运行时 webfx · fxchain.js | 多 pass 效果对细线和小字有影响 |
| 2D 混合模式、挖空、SVG 滤镜 | film-webfx · compositing.md | `ctx.filter` 在软件渲染下慢 |
| 3D 场景、PBR、模型、三维文字 | film-webfx · three.md；运行时 webfx · stage3d.js、three-film.* | 基准场景约 8 ms 起 |
| 3D 后期（景深、体积光、bloom） | film-webfx · three-post.md | 景深最贵 |
| 天空、云、湿地面、风化 | film-webfx · three-world.md | — |
| **物理与粒子** | | |
| 抛物线、落地弹跳、摆、轨道、粒子发射 | film-physics · effects.md、strategies.md（闭式解） | 闭式解做不了物体之间的相互作用 |
| 碰撞、布料、绳、鸟群、流体 | film-physics · effects.md、strategies.md（定步重放、预烘焙）；运行时 physics · replay.js、baked.js | 每步 0.03–13 ms；大量粒子流体基本只能预烘焙 |
| 屏震、顿帧、闪白、压扁、拖尾 | film-physics · events.md | 震多了字幕读不清；闪白有光敏风险 |
| 跟车、堵车、排队链式传播 | film-physics · chain.md | — |
| 快进、慢镜头、定格、倒放 | film-physics · timemap.md；运行时 physics · timemap.js | — |
| 引入 matter.js / planck.js / rapier | film-physics · libraries.md | 要改成定步并关掉自带循环 |
| **声音与时间** | | |
| 画面卡旁白某个词 | narration · narration.js 的 `vo.at` | 见 film-narration |
| 合成音效、分层冲击、空间尾音、闷音 | narration · sfx.mjs；film-narration · sfx-recipes.md | 真实感需试听 |
