---
name: film-critique
description: 代码渲染影片（films/<slug>/）的自检与评审：静帧闸门（写完代码先出几张关键静帧拼图）、成片对照图（接触印相表 contact sheet、连续帧特写条、360px 手机尺寸、循环接缝、海报帧）、客观检查（时长与音画流对账、事件对词、360px 字号与对比度、死拍/静止、旁白在说而画面已空、关键事件太短、分镜断言的画面实测、遮挡与出画、运动读数：起停突变/同屏几样在动/镜头构图变没变/卡拍偏差/开头几秒）、按本片 docs/style_guide.md 判本片法律、倾向性提醒、带时间戳列出最弱的几处、写 docs/review_log.md。用户说"看看效果""出几张静帧""渲出来检查一下""自检""评审""打分""挑问题""哪里不对""有点平""缓动太硬""镜头不够变""卡点不准""接触表""review"，以及写完代码要渲、渲完要交付之前加载。只指出问题和证据帧，修法在各能力 skill；数字与出处的严格对账归 film-story；不替人做审美判断。
---

# film-critique

MP4 本身读不出内容，代码也读不出画面。这个 skill 把片子变成**能看的静态图**和**能判的数字**，并写清楚每一项是谁判的。

| 层 | 标准从哪来 | 谁判 | 判不过意味着什么 |
|---|---|---|---|
| **客观项** | 物理规律和契约，全片通用 | 脚本 | 是 bug，要修 |
| **本片项** | 本片 `docs/style_guide.md` | 能机读的由脚本判，其余由人判 | 违反了本片自己定的法律 |
| **倾向性提醒** | `references/tendencies.md` | 人看一眼 | 不意味着任何事，只是值得看一眼 |

**片子没声明的事不打分。** 审美标准只有一个来源，就是这支片子自己的 style_guide。skill 只提供测量工具和一份"值得看一眼"的清单
（拿 skill 自带的审美维度打分，会把每支片推向同一种风格，早期版本的教训见仓库 docs/verified/film-critique.md）。

---

## 诚实性边界：模型没有眼睛也没有耳朵

| 模型自己能做（可信） | 模型能做但只算描述（要人确认） | 必须由人做 |
|---|---|---|
| 跑全部客观脚本并读结论；对照 style_guide 里能机读的法律 | 看静帧和接触表，描述"这里有个方块，那里有一排竖线" | 判断有没有意外的语义（像脸、像齿轮），以及是故意还是偷懒 |
| 定位带时间戳的问题并给出证据帧；只重渲改动过的秒数 | 指出"这几格完全相同"；按 tendencies 清单逐条找候选 | 构图、质感、整体节奏；听觉上的音色、音效、混音、口播语气 |

**没人在场时**，跑完全部客观检查，把结果和证据帧写进 review_log；主观项写"未经人眼确认"，**不打分**（`review_log.mjs` 不传 `--seen-by` 时就是这样生成的）。
假装打了分比留白更糟，因为下一轮的人会以为那一项有人看过。不过即使没人看，仍有两步要做。

**第一步：把每条法律拆成机械部分和感知残余。** 一条 HUMAN 法律里能机读的部分变成判据，剩下的残余才交给人；残余越小，人判得越可靠。
以 `films/demo-tls` 为例：「密钥成立后中轴线必须退场」整条都能机读（强调色像素在 `from` 之后恒为 0，像素法律 PASS）。
「文本流不能读成数字雨」拆出三条可机读的判据：没有绿色（`law.palette`）、内容是真实 HTTP 头（源码断言）、各行同速（源码断言），残余只剩"读起来还像不像"。
「关掉旁白也能看出从可读变成不可读」中，关键变量由 `window.probe(t)` 逐帧断言，残余是"人能不能看出来"。

**第二步：模型必须真的看图，写成"模型描述"。** 只写可复述的事实（有什么、在哪、相对关系、文字内容、有没有某个颜色），
不写"好看""协调"。检验标准是：另一个人对着同一张图，能判断这句话是对是错。格式参考 `films/ghost-jam/docs/review_log.md`：

```
### 静帧上看到的（模型描述，不作结论）
- 模型描述：<具体事实>
- 模型描述的风险点：<哪些话模型给不出，必须人看>
```

---

## 一、静帧闸门（写完代码，渲整片之前）

方向错了，只损失几十秒，而不是半小时。

```bash
node <film-critique>/scripts/stills.mjs --film <slug> --at 1.2,8.8,9.8,22
node <film-critique>/scripts/stills.mjs --film <slug>          # 不给 --at：取 window.MARKS 的中点，没有就均匀 5 个
#   --entry scene-v2.html（临时换入口，不改 film.json）   --cols 5 --tile 420 --label stills
node <film-critique>/scripts/stills.mjs --film <slug> --entries look/a.html,look/b.html [--at 0.1,0.9]   # 比稿：每个入口一行，拼成 out/lookdev.png
```

产出 `films/<slug>/out/stills.png`（每格下方标时间戳）和 `out/stills/still-<t>s.png`。

**比稿**（`--entries`）用在动手写整片之前：几个视觉方向各画一帧，拼在一张图上让用户挑；入口是片子目录下任何暴露 seek 的页面。什么时候值得做、页面怎么写见 `film-story/references/lookdev.md` §2。

**怎么挑时刻**：取每个镜头画面定型的那一刻，加上每个关键事件的中点。转场进行到一半的画面交给下面的转场拼图，因为 MARKS 中点和均匀取点很少正好落在转场中段。

### 转场拼图（有剪辑点就跑）

```bash
node <film-critique>/scripts/transitions.mjs --film <slug>             # 每个剪辑点 / 转场窗口取 前·入·中·出·后 5 帧
#   --cuts 3.2,8.0-8.4   手给（单个数 = 硬切，a-b = 窗口）   --scan [--scan-fps 5]  场景没声明时逐帧差分找峰（推测，慢）
#   --pad 0.3  "前/后"离窗口边的秒数   --tile 360  --label transitions
```

产出 `out/transitions.png`（每格标位置、时刻和成片帧号，橙框表示"中"）和单帧，**只取帧，不做判断**。已知缺陷多出在转场中段（框中框、网格错位、
甩镜残影、匹配剪辑露黑边），历史上都是碰巧看图才发现的。剪辑点来源的优先级（`--cuts` > `CUT_WINDOWS`/`CUTS` > 推测）、取帧规则和局限见 `references/sampling.md` §1–2。

**看什么**（stills 和 transitions 的图都要用 Read 真的打开）：没看过脚本的人能不能说出片子在讲什么；画面有没有被读成别的东西（T7/T8，模型描述后交给人）；镜头有没有设计，即景别有没有变化、运动有没有动机（T9；镜头平铺且 style_guide 没写理由的，记为待改）；
关键事件有没有出现（没出现可能是时刻挑错了，也可能是事件太短，交给 check.mjs 判）；style_guide 里能从静帧看出来的法律（色彩、构图、字体）。
**运动在静帧上看不见**：缓动硬不硬、同屏几样东西在动、镜头之间构图变没变、卡点准不准、开头几秒有没有东西，要看 check.mjs 的 `motion` / `variety` / `beatsync` / `hook` 读数，并用 Read 打开它们拼的证据条（起停前后 5 帧、各镜头代表帧、拍点对事件帧、开头五帧）。读数只说明量到了什么，好不好由本片 style_guide 判。

截帧用 film-core `lib/browser.mjs`（`openScene`），和渲染器是同一份代码。WAAPI 场景要设 `playbackRate=0` 冻住动画，否则 Playwright 的 `animations:'disabled'` 会调用 `finish()` 跳到终态，四个时刻截出同一帧且不报错。

## 二、客观检查（每次改完都跑，开销小）

```bash
node <film-critique>/scripts/check.mjs --film <slug>                       # 画面层，不需要 MP4
node <film-critique>/scripts/check.mjs --film <slug> --mp4 films/<slug>/out/final-9x16.mp4
#   --sample-fps 10（默认）  --claim-fps <成片 fps>（分镜断言实测的帧率）  --entry x.html  --strict（LOOK 也算失败）
#   --workers N（默认 核数/2，≤16）  --pages-per-browser 2   并行抽样，拓扑同 film-core render.mjs；--workers 1 = 串行（排查用）
```

**查哪些项由本片声明**：这里没有一项属于页面契约（契约在 `<film-core>/references/kernel.md`）。每个子判据都要片子在 film.json 的 `checks` 里声明了才会开启；`checks` 是扁平的 id 数组，
需要阈值时写成单键对象，如 `{"contrast": {"min": 4.5}}`。下面这些 id 只登记在 `gates.json` 里，accept --deep 和 deliver 发现声明了其中任何一个，就会跑 check.mjs：

`narration mp4 truepeak loop readability contrast facts.screen style-guide laws still empty cover marks claims tilt page continuity rhythm legible motion variety beatsync hook mute`

每个 id 会报出哪些发现（`duration.*`、`law.*`、`cover.empty`、`mark.*`、`claims.*` 等）见 `references/checks.md` 第 0 节；结论等级见第 1 节；做法、阈值、出处和局限见第 4 节。
**跨能力依赖**：`narration` / `marks` 需要 film-narration，`tilt` 需要 film-motion，`claims` 需要 film-story。声明了却没装对应 skill 时，报「缺能力 film-X」并 exit 1，不会静默跳过。
`legible` 必须带阈值对象；`continuity` / `rhythm` 和运动读数 `motion` / `variety` / `beatsync` / `hook` / `mute` **只报 LOOK，永远不报 FAIL**（阈值是报疑点的起点，在 checks 对象参数里改；读数写进 checks.json 的 `kinetics`，量法、来历、代价和误报见 checks.md 第 4 节）；`determinism`、`mp4.asr` 列为 TODO（分别归 film-core `seamcheck.mjs` 和 film-narration `align.py --verify`）。
**不支持局部运行**：`--only` / `--law` / `--claim` / `--from` / `--to` 会报"未实现"并 exit 2，要验证一条法律也得整片跑。并行跑出的结论与 `--workers 1` 逐字节相同。
如果运行途中改了 scene.html、shotlist 或 style_guide，结论可能是新旧两版混出来的，需要重跑（`inputs.changed` 指纹已经写好，但还没接进流程）。
带时间戳的发现会在 `out/critique/` 下保存证据帧，**要去看证据帧**；结果写在 `out/critique/checks.json`。

### 场景需要配合的几件事（全局表见 checks.md 第 2 节）

1. **声明关键事件**（check.mjs 的输出里叫「承重事件」）：`window.MARKS = [{label, start, end, load:true, word:'安史'}]`。脚本只能查声明过的事件，哪些事件算关键由人判断。MARKS 和画面要从同一份数据算出来，不要手抄。
2. **旁白不从 0 秒开始时**，在 film.json 写 `narrationOffset`（全套只以这一个字段为准，由 film-narration 定义）。
3. **关键变量不是由 shotlist 钉点插值出来时，暴露 `window.probe = (t) => ({ 灯数: 3 })`**：键名就是 shotlist 里 `source: "scene"` 的曲线名，值是数字或 null。
   什么时候要写，见 film-story 的「改钉点测试」。probe 和 seek 共用同一个取状态函数，它不画任何东西，并且是 t 的纯函数（按顺序和倒序各取一遍比对，即 `probe.pure`）。它不和 MARKS 合并（MARKS 说明哪一段关键，probe 给出任一时刻的状态），也和 film-physics 的 `PHYS.claims`（仿真不变量自检）不是一回事。
   "共用同一份状态"只靠约定保证，所以 `source: pixels` 是**唯一不经过场景自身代码的旁证**，最关键的一两条断言两种来源都写。
4. **本片法律或断言需要知道"某物画在哪"时，登记空间锚点**：用 film-core 的 `runtime/anchors.js`，`A.ctxRect('黄车', ctx, …)`，再用 `window.seek = A.install(draw)` 装上 `window.anchors(t)`（契约见 `<film-core>/references/runtime.md` §6）。

断言的代价（probe 和像素断言每帧的耗时、用 `--claim-fps` 降帧会漏掉什么）见 checks.md 第 4 节 claims。
**数字对账的分工**：`facts.screen` 只是宽松筛查，严格对账归 film-story 的 `factcheck.mjs`（用 `--also out/critique/onscreen.txt` 补上画面那一半；两者结论不同时以 factcheck 为准，见 checks.md 第 4 节）。

### LOOK 怎么处理

LOOK 表示"测得到，但是不是问题要看意图"（死拍在产品片里是失误，在水墨片里可能是留白）。逐条处理：先看证据帧，再查 style_guide 有没有说过。
说过就是故意的；没说过但你认为这样是对的，就**去 style_guide 补一条**（如 `max_still`），让它从疑点变成法律。
如果只是某一段故意这样（定格等旁白、黑场开场），在 MARKS 上写 `hold: "<理由>"`，段内的 LOOK 改记为 HOLD，理由写进 review_log 的「故意保留」（只豁免 LOOK，规则见 checks.md 第 4 节 hold）。

## 三、本片项：从 style_guide 读取

在 `docs/style_guide.md` 里放一个 ` ```critique ` JSON 块，写能机读的法律，如
`{ "palette": [...], "max_still": 1.5, "min_text_src_px": { "latin": 26, "cjk": 56, "cjk_bold": null }, "laws": [{ "id", "text", "how" }] }`。

- 由脚本判的键：palette / palette_tol / palette_max / max_still / loop / min_text_px / min_text_src_px / view_width / read_cps / min_mark / sync_tol / empty_edge / facts_ignore / facts_single / ortho_ok。
  键表、完整示例和默认阈值见 `references/checks.md` 第 3 节。字号按文种和字重分档；`view_width` 默认 360（横版片也按手机宽度判），以横屏全屏观看为主的片子写 720。
- `laws[]` 默认原样写进 review_log 的 HUMAN 行（`how` 写明看哪张图）；加上 `pixels`、`occlude`（遮挡判定）或 `inframe`（出画判定）就变成机读，时间窗用 MARKS 的 label 指定（checks.md 第 3 节）。
- **没写进来的事不打分**；没有 style_guide 时本片项整层为空，只报一条 LOOK。style_guide 由 film-story 产出，这里只读不写。

## 四、成片对照图（渲完之后）

```bash
bash <film-critique>/scripts/contact.sh --film <slug> [特写起点秒]          # 挑 out/ 下的 final-*/silent-*，跳过 *-loop.mp4
bash <film-critique>/scripts/contact.sh films/<slug>/out/silent-9x16.mp4 [特写起点秒]
```

| 产物（在 MP4 旁边） | 内容 | 看什么 |
|---|---|---|
| `*-contact.png` | 接触印相表，约 30 张缩略图（密度按时长自适应） | 整体节奏、平台期、色彩分布 |
| `*-strip.png` | 从起点开始的连续 12 帧，每格标帧号与毫秒 | 中间态（T6）、单帧跳变、文字重叠、运动方向 |
| `*-phone.png` | 按观看宽度每秒一帧，图头写明宽度假设 | 小尺寸下轮廓被读成了什么（T8），字能不能读出来 |
| `*-loop.mp4` | 首尾相接播放两遍 | 循环接缝（由人看） |
| `*-poster.png` | 12% 处的一帧 | |

帧率从 film.json 读取；特写起点默认对准 transitions 的第 K 个窗口（`--strip-cut K`）；手机图的观看宽度默认是竖持 360（与 check.mjs 相同），
可以用 `view_width`、`--hold landscape` 或 `--view-width N` 修改。优先级与回退规则见 `references/sampling.md` §3。

## 五、倾向性提醒

`references/tendencies.md`（T1–T9）是一份"如果不是故意的，大概就是没想过"的清单，**不是禁令，也不扣分**。逐条用一句话回答：是故意的（因为___，依据是 style_guide 或 mechanism.md 里说过）、是偷懒要改，或者没看。

## 六、记录

```bash
node <film-critique>/scripts/review_log.mjs --film <slug>                    # 无人在场
node <film-critique>/scripts/review_log.mjs --film <slug> --seen-by 杜 --note "第二版配色"
```

脚本从 checks.json 生成一节，追加到 `docs/review_log.md`（文件不存在时用 `assets/review_log.md` 模板新建，与 `new-film --recipe explainer` 用的是同一份）。每轮按固定结构写：

- **派生品新鲜度**：已过期的派生品在本轮开头用 ⚠ 引用块醒目列出（只提示，不拦截）。
- **检查过的时间点**：每行写时刻、来源（切点的前/入/中/出/后、MARKS 中点、均匀取点、发现处）、帧路径、脚本在附近的结论、人判。没有转场拼图时要明写"转场中段没被专门看过"。
- 客观项表、本片项表（**HUMAN 行写明看哪一帧**：时间窗中点帧或现有拼图，见 checks.md 第 0 节）、疑点表、倾向性提醒（有人在场时 T1–T9 每条一行）、静帧上看到的内容（模型描述）。
- **发现的问题、修法和遗留**（FAIL 在前，按时间排序，带证据帧）；改了什么、重渲了哪个区间；**故意保留**的项（HOLD 及理由，交付说明照抄）。
- **下一轮先读（交接）**：创作决定和放弃的备选、哪些测过、哪些只看过、哪些没人查、最弱的一镜、新点名的默认、用户手改过的文件、渲染状态。下一轮（换会话或换 agent）动手前，先读最新一轮的这一节。

需要人填的地方留**结构化空项**（空的表格格子、`字段：` 后面留空），不写"（待填）"，这样空着就表示没人填，一眼能数出来。
脚本**永远不填分数**；`--seen-by` 只记录谁看过，不传时人判格写"未经人眼确认"。
派生品新鲜度的做法：每个派生品旁边写一个 `<产物>.meta.json`，`fresh.mjs --film <slug>` 列出新鲜、过期、未知三类（加 `--strict` 才 exit 1）。它比较的是输入是否逐字节相同，不是画面有没有变（`references/sampling.md` §4）。

## 七、循环

```
写完代码 → stills.mjs + transitions.mjs → 看 → check.mjs → 修 → 渲（只渲改动的秒数）
         → contact.sh → 看 → check.mjs --mp4 → review_log.mjs（看过期提示）→ 填修法 / 遗留 → 修 → …
```

- **修法不在这里**：文字问题找 film-typography，运动和时序找 film-motion，旁白对点找 film-narration，物理找 film-physics。
  某个症状该回到哪份产物去修（brief / facts.md / mechanism.md / script.json / shotlist.md / style_guide.md / scene.html / film.json / cues.json），见 `references/attribution.md`。
- 只重渲改动过的区间：用 film-core 的 `render.mjs --from <s> --to <s>`。
- **点名没想过的默认，"本片拒绝"清单随片增长**：首次渲染后对着静帧逐个点名"这里用的是没想过的默认"（同一种淡入、居中、默认缓动等），写进 style_guide 的「本片拒绝」再修；下一版再点名，清单只增不减。只记在本片里，不回写到 skill。
- **先预览，后终稿**：没听到用户点头（或明说"直接出"）之前，只出静帧或低分辨率小样，不渲定稿，也不 deliver。
- **动手前先看用户改了什么**：接手已有的片子时，先把 `films/<slug>/` 的 mtime 和 receipt、上一轮 review_log 做比较；对话之外发生的改动视为用户意图，不要覆盖，并在回复里说一句。
- **什么时候停**：客观项没有 FAIL，本片法律没有 FAIL，每条 LOOK 都有判定，HUMAN 行有人看过。没人看过时只能说"客观项通过，主观项未经人眼确认"。
- 优先级：页面报错与确定性 > 时长与对点 > 本片法律 > 可读性 > LOOK > 倾向性提醒（非确定性会让后面所有观察都无法复现）。

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `scripts/stills.mjs` | 静帧闸门：截取关键时刻并拼图（写入时刻来源和 meta） |
| `scripts/transitions.mjs` | 转场拼图：每个剪辑点取前/入/中/出/后 5 帧 |
| `scripts/contact.sh` | 成片的五种对照图（帧率读 film.json，特写对准转场，手机图标明观看宽度） |
| `scripts/fresh.mjs` | 派生品新鲜度（只提示；`--selftest` 是阴性/阳性对照） |
| `scripts/check.mjs` | 客观检查和本片机读法律，输出 checks.json 与证据帧 |
| `scripts/review_log.mjs` | 把 checks.json 写成 review_log 的一节，主观项默认"未经人眼确认" |
| `scripts/_film.mjs` `_pool.mjs` `_pixels.mjs` `_anchors.mjs` `_flow.mjs` `_kinetics.mjs` `_legible.mjs` `_inputs.mjs` | check.mjs 的内部模块，依次负责找片和截帧（用 film-core lib）、并行池、原生分辨率像素统计、锚点判定、衔接与节奏、运动读数、画面中的文字、输入指纹（**尚未接入流程**）；`_cuts.mjs` 负责剪辑点来源与取帧规则，`_fresh.mjs` 负责派生品 meta 读写与过期判定 |

所有脚本都能从任意 cwd 调用（`--film <slug>`；找片顺序为 `--films-dir` > `$FILMS_DIR` > 从 cwd 向上找 `films/`，与 film-core 相同），
失败时 exit 非 0，并在 stderr 说明原因。依赖 Playwright（仓库根 node_modules）和 ffmpeg。
