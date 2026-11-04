# 维护 film-* 套件

给改 skill 的人看，不随 skill 安装（skill 正文不应依赖这份文件）。做片子的人读 film-core 就够。

目录：skill 清单与边界 · 写 skill · 交付标准 · 门与收据 · 开发工具与夹具 · 文档分层 · 附：原 ARCHITECTURE.md 去向

## skill 清单与边界（9 个）

边界按"能力"切，不按流水线阶段切——调用方要的往往是某个能力，不是走完整条线。

| skill | 管什么 | 不管什么 |
|---|---|---|
| `film-core` | **入口与内核**：seek(t) 契约、脚手架与配方机制、共享 lib（找片、命令行、服务器与挂载表、浏览器、帧与缓存、收据、门注册表）、基础运行时（motion/layout/anchors/rand）、渲染与预览、内核门（seamcheck、fontsrc）、deliver/freeze/accept | 任何具体技法和审美 |
| `film-motion` | 2D 动效词汇：choreo、transitions、camera3d、ui-rebuild、tiltcheck | 引擎（在 core） |
| `film-webfx` | 着色器、后期、三维、SVG 滤镜、混合模式 | 2D canvas 基础绘制 |
| `film-physics` | 粒子、重力、碰撞、布料、群集——全部可 seek | 渲染风格 |
| `film-typography` | 文字绘制，含全部字幕绘制 | 字幕的时间轴（narration） |
| `film-narration` | 旁白、字级时间戳、节拍、音效、合流——**只出时间数据，不画字** | 画面怎么响应时间戳 |
| `film-assets` | 字体文件来源、子集化、打包；图标/图片/音频来源与授权 | 字体来源门（内核门，在 core） |
| `film-story` | 调研与事实核查、视觉机制、发散、分镜、解说片配方 | 机制怎么实现 |
| `film-critique` | 静帧闸门、对照图、按本片 style_guide 打分、质量检查 | 替人做审美判断 |

依赖规则（可执行）：能力 skill 只许 import film-core；跨能力一律 core 的 `capability(name)`，没装报「缺能力 X」exit 1。
`rg -P "\.\./\.\./film-(?!core)" skills` 必须为空；`rg -l "create[S]erver|chromium[.]launch" skills` 只命中 `film-core/lib/`。
跨 skill 的文字引用写成"参见 film-xxx"，不复制对方的内容——复制会腐烂。

## 写 skill

**风格判据**（来历见 CLAUDE.md）：每一条"不要 X"都要能改写成"X 的代价是 Y，什么时候值得付"。改写不了的，要么是技术不变量
（写进 kernel.md 或本 skill 的"硬约束"小节），要么是个人口味（删掉）。不给默认配色、默认字体组合、默认转场；给选择的维度和判据。

| 类别 | 性质 | 写在哪 |
|---|---|---|
| 技术不变量 | 违反就是 bug，无条件 | film-core `references/kernel.md`；各 skill"硬约束"只写本 skill 特有的 |
| 风格词汇表 | 可选菜单，带代价说明 | 各 skill 的"手法"小节、film-core `references/style-menu.md` |
| 本片法律 | 覆盖任何 skill 默认 | `films/<slug>/docs/style_guide.md` |

**SKILL.md 写法**（skill-creator 的渐进披露）：

```
<skill>/
├── SKILL.md          ≤ 300 行（硬上限 500）。能力地图 + 判据 + 指向下层
├── references/       按需读的细节（> 100 行的开头加目录；只从 SKILL.md 引一层）
├── scripts/          Agent 工具（共享实现一律 import film-core/lib）
├── assets/runtime/   影片运行时（扁平、全套唯一的文件名；随机用 core 的 rand.js）
└── gates.json        可选：本 skill 的门（uses 门 / checks 门），格式见 film-core references/api.md
```

- frontmatter 的 `description` 是唯一的触发机制：第三人称，写清"做什么"+"什么时候用"，枚举用户会说的触发词；
  每份 250–450 字，skill 之间触发词边界不重叠。
- 正文用命令式，解释**为什么**而不是堆 MUST；每条技法给**代价**；带跑过的最小例子；不写 Claude 本就懂的东西。
- 研究过程、实测历史、变更记录进 `docs/verified/<skill>.md` 或 `docs/`，不进 skill。
- 引用本仓库具体片子当例子时标"本仓库样例"：skill 装到别处时那些片子不存在。
- 不写安装/拷贝运行时的说明：运行时在线挂载，用到就 `import './runtime/x.js'`。

## 交付标准（每个 skill）

1. `SKILL.md` frontmatter 合法（`name` 与目录同名，`description` 写满触发词）。
2. 声称能跑的 `scripts/` 真的跑过，`--help` exit 0、未知参数 exit 2。
3. 提供 `assets/runtime/` 的，写一个最小场景验证它按 t 求值，并过 seamcheck 门 1a/1b/2。
4. 提供门的，登记进 `gates.json`，并在一支片子上 `accept --deep` 看到它真的被触发、真的会红（先造一个阴性对照）。
5. `docs/verified/<skill>.md` 记：测了什么、怎么测的、**实测数字**、哪些没测到。不写"应该可以"。
6. 明确列出没解决的问题。留白比假装覆盖有用。

---

## 门与收据

门分四层，注册表是各 skill 的 `gates.json`（格式见 film-core `references/api.md` §4）：

| 层 | 何时开 | 谁声明 |
|---|---|---|
| 内核门（seam 1a/1b/2/3、探针、页面报错、fontsrc） | 永远 | 只有 film-core（`"when": "always"`） |
| uses 门 | 片子实际加载了某个运行时（serve 的加载记录） | 提供该运行时的 skill |
| checks 门 | film.json `checks` 声明了某个 id（扁平数组，api.md §5） | 认领该 id 的 skill；声明了没人认领 = 缺能力，红 |
| 交付门 | `deliver`：定稿渲染、门 4 总开、门 5 与渲染清单对账、跑全部适用的门 | film-core |

`deliver` 全部非红才冻结运行时并写 `receipt.json`（入库）。`accept` 默认只对账收据：输入摘要没变 ✓，变了 ✗（计入退出码），
没收据记「未交付」不计入；`--deep` 把门真跑一遍。`freeze --receipt "<理由>"` 补的是不过门的收据，显示「✓收据·免门」——
只给"成片早已按当时全套门渲好、`runtime/` 就是当时那份"的片子用（例如有 deliver 之前就交付了的 weiqi 系列、tencent-5y）。

## 开发工具与夹具（`dev/`、`tests/fixtures/`，不随安装）

```bash
node dev/selfcheck.mjs            # 套件形状：9 个 skill、依赖方向、gates.json 与 checks 认领、风格中立、实测记录、语法；装机 md 行数
node dev/selfcheck.mjs --leak-test  # 风格扫描的漏检率
node dev/test.mjs [--quick]       # 各 skill 自测 + 阴性/阳性对照（期望表 dev/test-fixtures.json，加夹具只改表）
```

基准与探针脚本放 `dev/<skill>/`（capabilities、bench、libprobe……），它们可以给 `launchBrowser({extraArgs})` 传参，门和渲染不许。

阴性/阳性对照夹具在 `tests/fixtures/_test-*/`，不在 `films/`：

- 夹具**没有 `runtime/`**，由服务器挂套件里的现行运行时——它们测的就是现行代码，不冻结、不交付、没有收据。
  要在夹具上跑某个脚本，加 `--films-dir tests/fixtures`（dev/test.mjs 就是这么调的）。
  `accept.mjs --fixtures` 默认就去 `<films 的父目录>/tests/fixtures` 找（`--fixtures-dir` 改位置），`--film _test-x` 在 films/ 找不到时也查那里。
- 夹具的身份也是 `film.json`：只给检查脚本当输入的目录（`_test-research`、`_test-storyboard/*`、`_test-audio-api`）放一份最小的 `{"schema": 1}`。
- 夹具里自带的小脚本（`_test-typography/tests/*.mjs`、`_test-physics/node-vs-browser.mjs` 等）起服务器和浏览器也只用 film-core 的 `serve()` / `launchBrowser()`，
  Node 里取运行时用 `lib/runtime-node.mjs`。
- 新增夹具：放进 `tests/fixtures/`，在 `dev/test-fixtures.json` 加一行期望（门、入口、判词、出处），不用改 test.mjs。

## 文档分层

| 放哪 | 写什么 |
|---|---|
| `skills/film-*/SKILL.md`、`references/` | 用法、判据、代价、契约——随安装，模型会读 |
| `docs/verified/<skill>.md` | 实测记录：测了什么、怎么测、数字、没测到什么 |
| `docs/INTEGRATION.md` | 跨 skill 的 bug 与门的来历（按需查，索引在开头） |
| `docs/oss-borrowings.md`、`docs/neutrality-eval.md` | 调研与评测 |
| 仓库 `CLAUDE.md` | 原则、合格线、环境既成事实 |

装机 md（`skills/film-*/` 下全部 .md）目标 ≤ 6500 行，selfcheck 每次报总数。

---

## 附：原 `skills/ARCHITECTURE.md` 各章去向

INTEGRATION.md 里的「ARCH §N」按这张表找。

| 原章节 | 去向 |
|---|---|
| §0 在干什么 | film-core `SKILL.md` 开头 |
| §1 呈现能力不规定风格 | 仓库 `CLAUDE.md`（与它重复的部分删了）；下面"写 skill"一节留判据 |
| §2 技术不变量的来历 | film-core `references/kernel.md` §7 |
| §3 目录约定、运行时、浏览器钉版本 | film-core `references/runtime.md` §1–3（运行时改为在线挂载 + 交付冻结） |
| §4 两种脚本 | film-core `references/runtime.md` §4、`references/api.md` |
| §5 skill 边界 | 本文件「skill 清单与边界」 |
| §6 解说片配方 | film-story `references/explainer.md`（配方文件 `assets/recipes/explainer/`） |
| §7 SKILL.md 写法、§8 交付标准 | 本文件 |
| §9 环境既成事实 | 与 `CLAUDE.md` 重复的删了；非标准 Chromium 行为 → film-typography `SKILL.md`「非标准」与 `references/chromium.md` |
| §10 层间数据（时间、状态、空间） | film-core `references/runtime.md` §5–6 |
