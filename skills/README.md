# film-* · 用代码渲染视频的 skill 套件

模型不直接产出像素，而是产出**程序**：一个暴露 `window.seek(t)` 的网页。
Playwright 逐帧调用它截图，ffmpeg 再把截图编码成 MP4。

这样做的好处是时间可以任意跳、可以只重渲改动过的三秒、可以用上整个前端生态
（canvas / WebGL / SVG / 字体 / 物理库）。代价是**一切都必须能按任意 t 精确求值**。

## 安装

```bash
# 全局（所有项目可用）
mkdir -p ~/.claude/skills ~/.claude/commands
cp -r skills/film-* ~/.claude/skills/
cp skills/commands/film.md ~/.claude/commands/

# 或者只给当前项目：把上面的 ~/.claude 换成 .claude
```

只拷 `skills/film-*/` 就够了：契约、共享库和菜单都在 `film-core` 里，其他 skill 只依赖它。
**film-core 必须安装，其余按需安装**。用到没装的能力时，工具会直接提示「缺能力 film-X」并退出，既不会崩溃，也不会悄悄跳过。
开发台账（`docs/`）和自检脚本（`dev/`）只在本仓库里使用，不需要拷贝。

依赖：Node 18+、ffmpeg、Playwright（`npx playwright install chromium`）。
旁白和音频分析需要 Python 环境，见 film-narration。

## 使用

跟模型说"做一支讲 X 的 20 秒竖版动画"就行，`film-core` 的 description 会让它被自动加载。也可以显式输入 `/film`。

```bash
node ~/.claude/skills/film-core/scripts/new-film.mjs my-film --format 9x16                      # 内核骨架，不写文档、不拷运行时
node ~/.claude/skills/film-core/scripts/new-film.mjs my-film --format 9x16 --recipe explainer   # 解说片配方：生成文档模板并声明检查
node ~/.claude/skills/film-core/scripts/preview.mjs --film my-film                               # 边写边看
node ~/.claude/skills/film-core/scripts/deliver.mjs --film my-film                               # 定稿渲染，跑全部门，冻结运行时，写收据
```

这里的「门」是套件里登记在案的自动检查，脚本逐道报告通过或失败；「冻结」是把片子实际用到的运行时文件复制进片子目录；「收据」是交付时写下的 `receipt.json`。下文会分别展开。

## 先读内核契约，其余都是可选的

[`film-core/references/kernel.md`](film-core/references/kernel.md) 用一页写完了唯一无条件的要求：页面暴露 `seek(t)` / `DURATION` / `ready` / `#stage`，
并且 seek 是 t 的纯函数。任何"给定 t 就能画出这一帧"的东西，都能按 Clip 约定接进来（Lottie、Pixi、three、p5、CSS 动效、游戏或物理引擎）。
这份文档还列出了守住契约的门和症状表。风格与思路是菜单，不是规定：[`film-core/references/style-menu.md`](film-core/references/style-menu.md)。

## 九个 skill

| skill | 负责什么 |
|---|---|
| **film-core** | 入口与内核：契约、脚手架与配方、渲染与预览、确定性验收、交付与验收、共享库、基础运行时 |
| film-motion | 2D 动效词汇：缓动与交错、镜头加转场的时间轴、Magic Move、透视相机、界面重建 |
| film-webfx | 着色器、后期、三维、SVG 滤镜、混合模式 |
| film-physics | 粒子、重力、碰撞、布料、群集，全部可以 seek |
| film-typography | 文字绘制（含字幕）、可变字体轴、中日韩排版、小字号可读性 |
| film-narration | 旁白、字级对齐、节拍、音效、合流，只输出时间数据 |
| film-assets | 字体、图标、图片、音频的来源与授权，子集化，打包 |
| film-story | 调研与事实核查、视觉机制、发散、分镜、解说片配方 |
| film-critique | 静帧闸门、对照图、按本片法律打分、质量检查 |

按需读，不要全读。一支纯排版的片子用不着 `film-physics`。

## 两条设计原则

**一、skill 呈现能力，不规定风格。**

你不会在任何一个 skill 里找到默认配色、默认字体组合、默认转场，或者"禁止 X"。
这是有意的。这套东西的早期版本把一种审美写成了法律（"禁止渐变背景上的居中标题"
"所有元素不许淡入""每 2-4 秒必须有新东西"），结果对水墨片成立的规则，放到霓虹赛博片上
全是错的；模型为了守规则，每次都退回它最拿手的那一招，两支片子长得一模一样。

审美判据的唯一来源是每支片自己的 `docs/style_guide.md`。
skill 提供的是可选的维度，以及每种选择的代价。

**二、技术不变量和风格偏好严格分开。**

| 类别 | 性质 | 写在哪里 |
|---|---|---|
| 技术不变量 | 违反就是 bug，无条件成立 | 各 skill 的"硬约束"小节 |
| 风格词汇表 | 可选菜单，附代价说明 | 各 skill 的"手法"小节 |
| 本片法律 | 优先于任何 skill 的默认值 | `films/<slug>/docs/style_guide.md` |

## 目录约定

```
films/<slug>/
├── film.json          画幅、fps、运动模糊、入口、checks（声明了才开启的检查）
├── scene.html         程序本体，暴露 window.seek(t)
├── runtime/           片内运行时：自己写的，加上交付时冻结进来的套件运行时
├── receipt.json       交付收据：输入哈希、运行时哈希、通过的门、环境指纹
├── assets/            本片素材
├── docs/              可选：配方生成的文档（brief / style_guide / …）
└── out/               所有产出
```

运行时在制作期间**在线挂载**，交付时**冻结**。制作中写 `import './runtime/x.js'`，服务器会把它解析到片内文件或已安装 skill 里的同名文件；
`deliver` 跑完全部门之后，把实际用到的那几份文件冻结进片子并写收据。此后套件升级不会改变这支片子的像素，也不会修复它的 bug，要修就改完再交付一次。

## 合格线是可执行的

```bash
node skills/film-core/scripts/accept.mjs            # 检查片子：有收据就比对输入哈希，改过却没重新交付就报红；没收据记为「未交付」
node skills/film-core/scripts/accept.mjs --deep     # 对每支片子把适用的门实际跑一遍
node skills/film-core/scripts/deliver.mjs --film x  # 交付一支：定稿渲染，开启全部门，冻结，写收据
```

**两条合格线必须都有。** selfcheck 检查的是 skill 本身（结构、风格中立、实测记录 docs/verified/ 的质量，见 `dev/`），它查不到"这些 skill 装好之后，
片子到底能不能过门"（为什么要分开，见下面的"它真的跑通过"）。

门分三层。**内核门**（seamcheck 1a/1b/2/3/4/5、探针、fontsrc）守住内核契约，永远开启。
**用了才开**的门由提供运行时的 skill 在自己的 `gates.json` 里登记，例如用了重放运行时才跑 physcheck。
**声明才开**的检查写在 film.json 的 `checks` 里（扁平 id 数组），由认领该 id 的 skill 执行，所以只守内核的新片不需要为了验收写任何文档。
不适用的门标 `–`，**不算失败，也不假装通过**；声明了检查却没装对应 skill，结果是红的。
`--list --verbose` 会打印每道门实际要跑的命令。门的参数是计算出来的，只看门名看不出它到底会跑什么。

**夹具默认排除。** `_` 前缀的片子是各 skill 的测试夹具，它们的失败往往是有意设计的阴性对照（例如故意用系统字体来测试字体检测器）。
如果把它们都算进去，这张表永远不可能全绿，而验收结论里的噪音比没有结论更糟，会让人习惯无视红色。
没做完的片子没有收据，表上标「未交付」，不计入退出码；一旦交付过，再修改却不重新交付就会报红。

这套东西的核心主张是"skill 呈现能力，不规定风格"。这种主张容易写，也容易慢慢失效：
加一条"推荐用深色背景"不会有人拦，加上几次之后，套件就退回到它当初要治的那个毛病。
所以这条主张被做成了一项**可执行的检查**，而不只是文档里的一句话。检查共八项：

| 检查 | 判据 |
|---|---|
| 结构完整 | 每个 skill 都有 SKILL.md；实测记录放在仓库的 `docs/verified/<skill>.md`（开发台账，不随安装），skill 目录里不许再有 VERIFIED.md |
| frontmatter | `name` 与目录同名；`description` 存在且足够长（它是唯一的触发机制） |
| **风格中立** | 没有无条件禁令，没有默认配色、字体组合或转场。要区分"下规定"和"否定其存在或引用反例"：写"你不会找到默认配色"是在描述这个毛病，不是在犯这个毛病 |
| 跨 skill 引用 | 引用的 skill 真实存在 |
| 文件引用 | `scripts/` `references/` `assets/runtime/` 下被引用的文件真实存在 |
| 实测记录质量 | 有"没解决"一节；有带单位的实测数字；**出现"应该可以"直接判不合格** |
| 工具与运行时分离 | `assets/runtime/` 里不许出现 Node API（它跑在浏览器里） |
| 运行时守契约 | 套件自己写的 `assets/runtime/` 里不许有 `Math.random` / `Date.now` / `setTimeout` 等调用。第三方库列在 `<skill>/assets/vendored.json`（写明 upstream 和 license），不做词法检查，它们在 seek 期间是否违约由逐片的 seamcheck 探针判定 |

这项检查本身验证过：往 `film-webfx/SKILL.md` 里植入三条违规（默认配色、默认转场、
无条件禁令），三条全部被抓到；移除后检查立刻恢复安静。

**但它只能做词法检查。** 它能抓到"默认配色"这四个字，却抓不到
"模型读完这套 skill 之后，是不是每次都画出同一种东西"。后者才是这套东西真正要防的问题，
只能靠行为测试。这一半记录在仓库的 [`docs/neutrality-eval.md`](../docs/neutrality-eval.md)：
四个全新的 agent（两组带 skill、两组作对照），两个差异极大的主题，判据**在看到结果之前**就写定了，
并且明确写了"这个测试可能证伪我自己的主张"。改过 `film-story` 或
`film-core` 之后应该重跑，prompt 原样记在那份文件里。
它第一次跑就抓到了两个真问题：dev server 被放进了影片运行时（于是被白白拷进每支片子），
以及 `film-critique` 的文档把另一个 skill 的文件写成了自己的相对路径。

## 它真的跑通过

`films/demo-tls`（10 秒竖版，讲一次 TLS 握手）走完了整条流水线：

```
new-film.mjs      → 骨架 + 六份文档模板（各自来自负责的 skill）
tts.py            → 9.96s 音频 + 字级时间戳
subset_font.py    → JetBrains Mono 15.6 KB + Noto Sans SC 156 KB，随片打包
scene.html        → 事件全部绑定在 vo.at('公开'/'交换'/'密钥'/'乱码') 上，没有一处写死秒数
stills.mjs        → 静帧闸门，看图发现 3 个脚本查不出的问题
render.mjs        → 326 帧 2.6s（8 worker × 4 浏览器，CDP 截图）
seamcheck.mjs     → 四道门 + 禁用 API 探针，全部通过
seamcheck --relaunch 2 → 跨启动检查，并和渲染清单对账，通过
check_shotlist.py → 0 失败；关键区间「密钥成立那一下」实测 0.717s（下限 0.4s）
check.mjs         → FAIL 0  LOOK 2  HUMAN 2；4 条分镜断言按 window.probe 逐帧实测，285 帧次全部为真
factcheck.mjs     → 0 错误
font_source.mjs   → 画出来的字全部来自随片字体
mux.sh            → -13.9 LUFS，true peak -1.4 dBTP
align.py          → 按字准确率 100%，漂移中位数 -0.015s，exit 0
```

**这七道门里有两道曾经一直在失败，却一直没人发现，因为从来没有跑过它们。** 这就是两条合格线要分开、验收要用一条命令跑完的原因。
做完第二支片子之后，把所有门对所有片子跑了一遍，才发现
这支片子的分镜一直是没填写的脚手架模板（跳过了流水线第 5 步），
而且字体一个都没有随片打包。反倒是另一个 agent 照着文档做的 `ghost-jam` 四道门全部通过。
这两个问题都修好了，过程记在 `films/demo-tls/docs/review_log.md` 第 7 轮。

**表里最后一行曾经是这套东西最大的一次假绿灯，值得作为脚注留下来。**
它一度全绿（100%、exit 0），而片子实际上把「密钥」念成了 mì yào。
原因是 ASR 会把声音归一成**字**，读音错了但字是对的，它必然给绿灯。
后来用共振峰实测（F1 的 p80，两组参照完全不重叠）才查出来，修好后复核为
**547 → 349 Hz**，回到 yuè 的区间。更尴尬的是，修好之后这道门反而变红了：
有效的修法是用同音字转写，而注音库把原词注成了错误的读音。
**也就是说，它原来的行为是念错给绿灯、念对给红灯**。现在两个方向都修好了，
详见仓库 [`docs/INTEGRATION.md`](../docs/INTEGRATION.md) 里的"十一个盲区"。

**这支片子还被用来反向验证"音频先行 + 关键词触发"。** 修改读音让旁白变长了 0.444s，
而 `scene.html` **一个字符都没动**（前后 md5 相同）：`DURATION` 自动从 10.420 变成 10.864，
帧数自动从 313 变成 326，四个关键事件各自跟着它所绑定的那个字移动了位置。
通过统计强调色像素实测，画面事件后移了 +0.267s，期望值是 +0.260s，**误差在一帧以内**。
之前只验证过正向（按音频做出来的画面能对上），这次验证的是反向：音频变了，画面自己跟上。

它的视觉机制是"**安全状态就是画面文字的可读性**"：视角是窃听者，
密钥一协商出来，连字幕都一起变模糊。这个机制通过了 film-story 筛选视觉机制的三道判据（「三刀」），
而不是套用默认的网格画法。片子的 `docs/` 下有完整的 brief / facts / style_guide / review_log，
可以当作一份真实样例来读。

### 第二支片子：换一个人做，并且不让他改 skill

`films/ghost-jam`（23.6 秒横版，讲幽灵堵车）由另一个 agent 以**使用者**的身份制作：
只读 skill，一个字都不许改，全程记录摩擦日志。这样安排是因为**自己做的片子证明不了文档是对的**：
写文档的人知道哪些话是真的，不会照着一句没人实现过的承诺去做。

它和 demo-tls 在每个维度上都不同：16x9、白天路面、由跟车仿真驱动，
还有真实文献需要核对（Sugiyama 2008 环形轨道实验）。它的视觉机制是"**慢下来的那一段就是一串亮着的刹车灯**"：
灯团前端熄灭、后端点亮，整团灯自己往后移动，而亮着灯的每一辆车其实都在往前开。

这次产出了 **36 条摩擦记录**，其中 5 条标为"重要"，全部已修复。最有价值的一条是：
**分镜断言只能验证作者手工固定的曲线，验证不了仿真自然涌现出来的状态**。
`check_shotlist` 全绿的时候，片子里其实还有两个 bug。

后来它又被用来验证**空间锚点**（film-core runtime.md §5–6：场景画某个东西时登记它的屏幕框，各层读取同一个位置）。
原本八道门全绿的它，一接上遮挡门和出画门，就各红了一处，两处都是真缺陷：字幕底条盖住了作为参照的树；
讲到"有车被逼停了"时，停住的那辆车被画面左边缘切掉了 40%。调整构图重渲后全部变绿，见仓库 `docs/INTEGRATION.md` 第 26 条。

这支片子的 `docs/friction.md` 大概是整个仓库里最值得读的一份文件。
它完整记录了一个不了解内情的人照着这套文档做事时，**具体卡在哪里、怎么绕过去的**，
正面和负面都记了（哪些地方 skill 帮他省了事，也一并记下）。

## 修改这套东西之前

先读 [`film-core/references/kernel.md`](film-core/references/kernel.md)，再读仓库的 [`docs/MAINTAINING.md`](../docs/MAINTAINING.md)（skill 边界、依赖规则、写法与交付标准）。
能力 skill 能依赖的 core 全部接口列在 [`film-core/references/api.md`](film-core/references/api.md)。改任何一个 skill 之前，先确认是不是应该由你这边让步。

仓库的 [`docs/INTEGRATION.md`](../docs/INTEGRATION.md)（开发台账，不随 skill 安装）记录了**跑真实片子才暴露出来的 43 个跨 skill 问题**，
以及验证门本身的十一个盲区，这些靠单个 skill 的验证都发现不了。其中第 27 条不是 bug，而是整整一步流程的缺口：讲法和长相没有做发散，片子之间互不知道对方；
第 28–38 条来自 60 秒围棋片作者的实际制作报告；第 39–42 条涉及音色、动效转场、三维特效三项能力和验收提速；第 43 条把不属于契约的门改成了片子声明之后才跑。

这些问题分成三类，后两类一类比一类难发现：

1. **工具之间互相对不上**：两个 skill 读同一份 `narration.json` 的方式不同；
   一个工具误选了另一个工具生成的派生产物。这一类一碰上就会暴露。
2. **没有任何一支片子走到那条路径**：demo 片没有配乐，于是整条闪避分支从来没被执行过，
   一做测试片就发现配乐会被截断。默认的 Chromium 不请求 favicon，于是
   "404 被当成场景错误"这个问题要等到第一次换浏览器构建时才暴露，而那时**所有片子都渲不出来**。
3. **文档承诺了没人实现的东西**：分镜里能写"旁白前留白 0.6 秒"，但下游没有任何一环处理它，
   照着写的结果是画面整体比声音晚 0.6 秒，三道门没有一道会报错。
   这一类只有**认真照着文档做的人**才会碰上，写文档的人自己碰不上，
   因为他知道哪些话是真的。所以第二支片子交给另一个 agent 以"使用者"身份来做，见上文。

仓库的 [`docs/oss-borrowings.md`](../docs/oss-borrowings.md) 是和
Remotion / Motion Canvas / Revideo / Manim 等项目的源码比对，附带实测数字。
