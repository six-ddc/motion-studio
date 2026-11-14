# 风格与思路菜单

**这是菜单，不是规定。** 下面列出的是可以参考的做片思路、外部设计能力，以及仓库里已有片子的长相。
每条只写三件事：它是什么、去哪里看、代价是什么。**不推荐，也不排名。**选哪个、混不混用、要不要全部无视，都由本片的 brief 和 `style_guide.md` 决定。

使用之前要知道一件事：**写得越具体，越容易诱导所有片子收敛到同一种长相。** 这套东西就这样失败过：旧的分镜示例本身画的就是网格，
结果两支片子都画了网格（见 film-story 开头）。所以这里一律只写维度和代价，不放成品示例。
读完一条就去它指向的原文看，不要照着这里的一句话直接动手。
想知道新片"和上一支像不像"，运行 film-story 的 `scripts/siblings.mjs`，不要靠记忆判断。

技术上，下面每一条都只需要遵守 [`kernel.md`](kernel.md)：seek(t) 是纯函数，第三方库自带的时钟要关掉。
具体接法写在 kernel.md 第 3 节的 Clip 表里。标了"推演"的接法没有在本仓库实测过。

---

## 1. 外部设计 skill

片子可以整体采用其中任何一个 skill 的方向，连同它的取舍一起采用，只要在本片 `style_guide.md` 里写一句
"视觉方向采用 <skill> 的 <哪部分>"（写法见 film-story 的 `references/divergence.md` 第 0 节）。
本机路径：`~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/<名字>/SKILL.md`。

| skill | 它是什么 | 代价 / 接入时要注意的地方 |
|---|---|---|
| frontend-design | Design Thinking：先想清目的、定一个鲜明的调子、找出"最让人记住的一个东西"，强调 intentionality not intensity；附一张字体和配色的禁用清单 | 它的运动建议偏向 CSS 动画、scroll 和 hover。CSS 动画要声明 `USES_WAAPI`，并在 seek 里设置 `currentTime`；transition、scroll、hover 无法按 t seek。它推荐的独特字体要子集化并随片打包 |
| canvas-design | 先给美学方向起名、写一段宣言，再把它表达成静态构图 | 产出的是一套静态的美学主张，动起来的部分（节奏、转场）它不管，要自己补 |
| algorithmic-art | 用 p5.js 做生成艺术：种子随机、噪声场、流场、粒子 | p5 默认由 rAF 驱动，`random()`、`frameCount`、`millis()` 都要改成由 seed 和 t 计算（kernel.md 第 3 节）。它的交互式 seed 浏览只适合挑参数，不进成片 |
| theme-factory | 一组可以直接套用的主题（色板加字体组合） | 拿来就用最快，代价是同一套主题别人也在用，要清楚自己在重复什么 |
| （任何其他设计 skill） | — | 先看它的输出能不能做到"给定 t 就能画出来"。做不到的部分只能借鉴思路 |

## 2. 本仓库的做片思路（各 skill 里已有的方法）

| 思路 | 它是什么 | 去哪看 | 代价 |
|---|---|---|---|
| 机制驱动 | 把核心变量映射到一个视觉变量，整片靠这一条规则支撑；可用三刀诊断筛掉通用卡片容器 | film-story 的 `SKILL.md` §1/§3C、`references/mechanism.md` | 适合把抽象原理或连续变化讲透的片子。对人物故事、KOL 观点输出、具体产品演示或纯视觉片，强求单一连续变量只是走形式 |
| KOL 钩子、留存与转化弧线 | 前 3 秒停留钩子、静音首帧、未闭合悬念环、听觉化口播人设、痛点—爽点—CTA 种草结构 | film-story 的 `references/creator-playbook.md` | 钩子过猛而证据不足会沦为标题党；信息流快节奏照搬到深度横版片会显得浮躁 |
| 讲法和长相的比选、近作对照 | 脚本结构和视觉方向多想几个候选再挑；用 `siblings.mjs` 看一眼仓库里已有的片子 | film-story 的 `references/divergence.md` | 写下候选要花时间；它只能证明"对比过"，不能保证"选得好"（可在 `checks` 加 `divergence` 强制留痕） |
| 音频先行、关键词触发 | 画面读取旁白的字级时间戳，用 `vo.at('字')` 触发 | film-narration 的 `SKILL.md` | 有旁白且需要同步时几乎是必需的；无旁白的片子用不上。镜头长度跟着句子走，画面容易变成台词的配图 |
| 画面先行 | 镜头节奏先定（节拍栅格或一张具名时刻表），旁白和配乐去贴它；配方 `--recipe visual` | film-story 的 `references/lookdev.md` §5 | 旁白要按镜头时长去写，句子可能要删改；没有分镜断言对账 |
| 参考锚、风格帧比稿、粗剪预演 | 审美写明参照谁；候选方向各画一帧再挑；占位形状先把时间跑通 | film-story 的 `references/lookdev.md` §1–4 | 各多一轮：拆解参考、每个方向几十行代码、一次小样渲染。换来的是在最便宜的时刻改长相和节奏 |
| 节拍驱动 | 从配乐测出节拍栅格，让事件对准节拍 | film-narration `scripts/beats.py`、film-core `runtime/motion.js` 的 `beatGrid` | 每个事件都卡拍会显得机械，完全不卡拍又会和音乐脱节 |
| 镜头语言与转场 | 时间轴、16 种转场、共享元素 Magic Move、缓动表 | film-motion 的 `references/transitions.md` | 每个转场都要把参数写全；花样太多会看起来像样品册 |
| 视觉 token（look.json） | 本片把颜色和字体集中写成一处 token，生成 CSS 变量供 scene 引用；不带任何预设值 | film-typography 的 `SKILL.md`「可选：look.json」 | 多了一层间接引用；token 改名时 scene 里的引用不会跟着改 |
| 文字即画面 | 拆字、可变字体轴、乱码解码、打字机、文字 Magic Move | film-typography 的 `SKILL.md` | 中文字体要子集化并随片打包；小字号要按观看场景验证可读性 |
| 物理与涌现 | 粒子、碰撞、布料、群集、跟车仿真，全部支持 seek | film-physics 的 `SKILL.md` | 涌现出来的状态无法用分镜断言验证，需要写 `probe`（ghost-jam friction F-018） |
| 着色器、后期、三维 | 片元着色器层、泛光、景深、体积光、按帧契约改造的 three.js | film-webfx 的 `SKILL.md`、film-webfx 的 `references/three.md` | SwiftShader 软件渲染慢（`bench3d.mjs` 给出了每帧毫秒数）；保留式场景图每帧都要复位 |
| 透视 vs 正交 | 斜着看一个平面时，选用针孔投影还是仿射压扁 | film-motion 的 `references/camera3d.md` | 压扁就是正交投影，平行线不会汇聚。刻意做图解或等轴测风格时值得用 |

## 3. 游戏开发思路

| 思路 | 它是什么 | 接法 | 代价 |
|---|---|---|---|
| ECS（实体–组件–系统） | 实体是一组组件，系统是函数 | 系统写成 t 的闭式函数；需要积分的部分用 film-physics 的 `createReplay({init, step, clone})` 做定步重放，seek 里调用 `draw(stateAt(t))` | 写成增量状态再"顺手缓存一下"是最常见的泄漏来源，只有 seamcheck 门 2 抓得到 |
| 瓦片地图（tilemap） | 网格化的关卡或场景 | 在加载期用种子生成，seek 里只读取 | 网格是最顺手的画法之一，要分清自己是不是因为好写才选它（见 film-story 开头） |
| 精灵表帧动画 | 从一张图里切出 N 帧，按时间切换 | 帧号 = `floor(t * 动画fps) % N`，天然是纯函数 | 低帧率的"一卡一卡"本身是一种风格，要不要配 `sub` 运动模糊由本片决定 |
| PixiJS | 2D WebGL 渲染器加场景图 | 设置 `autoStart:false`、调用 `ticker.stop()`，seek 里调用 `renderer.render(stage)`；帧动画用 `gotoAndStop` | 推演。`Text` 会先画到离屏纹理上，可读性检查的读数可能不准 |
| Phaser | 完整的游戏引擎：主循环、Arcade 物理、tween、timer | 只把它当渲染器和场景图用，状态由 t 或 `createReplay` 提供；或者停掉主循环，从检查点按定步重放 | 推演，而且是最重的一种接法：它的每个子系统都按 delta 增量推进，改造工作量确实很大 |

## 4. Lottie 与外部动画数据

| 来源 | 它是什么 | 接法 | 代价 |
|---|---|---|---|
| Lottie（lottie-web） | After Effects 导出的 JSON 动画 | 设置 `autoplay:false` 并调用 `lottie.freeze()`，seek 里调用 `goToAndStop(t * frameRate, true)`；用 canvas 渲染器时可以画进本片的 canvas，作为其中一层 | 推演。AE 表达式里的随机可能读取 Math.random；节奏以 AE 时间线为准，要和旁白对齐就得做时间重映射，或者让旁白去配合它；文字层用系统字体时，换一台机器字形就会变 |
| 视频、图片序列 | 现成素材 | seek 返回 Promise，等待 `seeked` 事件 | 每帧多一次往返，速度慢 |

## 5. 本仓库已有片子的长相（各一行，用来知道自己在重复什么）

| 片子 | 画幅 | 长相 | 去哪看 |
|---|---|---|---|
| demo-tls | 9x16 | 窃听者视角：深色底、满屏竖向滚动的等宽明文、中轴一条线；密钥建立后文字溶成乱码，全片只有一处强调色 | `films/demo-tls/docs/style_guide.md` |
| ghost-jam | 16x9 | 斜俯视的白天环形试车场，写实偏插画；刹车灯的红是画面里唯一的红，"你"那辆车是唯一的黄；由跟车仿真驱动 | `films/ghost-jam/docs/style_guide.md` |
| weiqi-intro | 9x16 | 「气泡透镜」：榧木棋盘微距，每块棋包着一团沿棋盘线伸展的透明气泡，气泡的瓣数就是气数 | `films/weiqi-intro/docs/style_guide.md` |
| weiqi-ch1 | 9x16 | 4 分钟长片，沿用 weiqi-intro 的气泡透镜，文字是压在木面上的墨字 | `films/weiqi-ch1/docs/style_guide.md` |
| weiqi-fx-open | 9x16 | 「一盏灯」：灯下的立体棋盘（PBR、景深、浮尘），一条样条曲线长运镜，焦点代表可信度 | `films/weiqi-fx-open/docs/style_guide.md` |
| weiqi-fx-eyes | 9x16 | 「棋书图解」：平面墨线纸面、正俯视局部图、一种印刷蓝；同一组棋子跨镜头保持身份 | `films/weiqi-fx-eyes/docs/style_guide.md` |
| weiqi2-l1…l5 | 9x16 | 系列片，沿用「棋书图解」 | 各片 `docs/style_guide.md` |
| weiqi2-cards | 9x16 | 「一盏灯 → 一页纸」：九路榧木盘，每张卡一个机位，镜头转到正俯视后，木盘摊平成纸 | `films/weiqi2-cards/docs/style_guide.md` |
| eval-clearing / eval-deepsea | 9x16 | 未完成的评测片，只有机制，没有做过视觉设计（分别是"账本缩成一行字"和"阳光是唯一的颜料"） | 各片 `docs/` |
| tang-dynasty / demo-grid | — | 重构前的归档片，已经跑不起来。前者是墨色表现的王朝兴衰；后者是被批评"只会画格子"的那支网格片 | 各片 `ARCHIVED.md`、`films/tang-dynasty/out/` |

如果想把上表的某一支当作本片的方向（系列片、有意重复），在 style_guide 的近作对照里写明"有意重复 <slug>：原因"。
重复本身不是问题，不知不觉地重复才是问题。
