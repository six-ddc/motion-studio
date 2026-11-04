# film-production 验证记录

验证日期 2026-10-21。环境：macOS Darwin 25、Node + Playwright(Chromium 156)、ffmpeg。

## 测了什么

### 1. 参数校验（四条路径全部正确退出）

```
$ node skills/film-production/scripts/new-film.mjs --list
可拷的运行时：
  [基础] film-motion        motion.js
  [基础] film-narration     narration.js sfx.mjs
  [可选] film-typography    —— 未安装
  [可选] film-physics       closed.js replay.js
  [可选] film-webfx         webfx.js
```
未安装的 skill 正确降级成警告而不是失败——这是刻意的，少装一个可选 skill
不该让建片失败。

```
$ node ... new-film.mjs "Bad_Slug"
slug 只能用小写字母、数字和连字符，拿到的是 "Bad_Slug"       exit=2
$ node ... new-film.mjs ok --format 4x3
画幅只能是 9x16 / 1x1 / 16x9，拿到的是 "4x3"                exit=2
$ node ... new-film.mjs <已存在的>
films/x/ 已存在。要往里补文件加 --force（已有文件不会被覆盖）。 exit=2
```

### 2. 建片骨架

```
$ node ... new-film.mjs scaffold-selftest --title "脚手架自测" --format 9x16 --with physics,webfx
films/scaffold-selftest/  9x16 1080×1920 @30fps sub=1

新建: film.json  docs/{brief,facts,mechanism,style_guide,shotlist,review_log}.md
      script.json  scene.html
运行时: runtime/{layout,motion,serve,narration,sfx,baked,closed,replay,sims,webfx}.js
```
`--with` 的可选运行时正确拷入；重跑时已存在的文件走"跳过"而不是覆盖（实测）。

### 3. 端到端：脚手架 → 渲染 → 确定性验收

脚手架生成的 `scene.html` 带一段占位内容（一个用 `spring({duration,overshoot})`
反解参数、落到画面中心的圆），目的就是让新建的片子**立刻可渲**，
从而证明运行时拷贝、import 路径、渲染器接口三者是通的。

```
$ node skills/film-motion/scripts/render.mjs --film scaffold-selftest
▶ 9x16 1080×1920  0–3s  30fps ×1 子帧 shutter=1  = 90 次截图
✓ films/scaffold-selftest/out/silent-9x16.mp4   90 帧   5.5s
  ffprobe: 1080,1920,30/1,90
```

```
$ node skills/film-motion/scripts/seamcheck.mjs --film scaffold-selftest
门 1  同 t 可重复        ✓ 通过
门 2  乱序求值            ✓ 通过（8 个时刻逐像素一致）
门 1b 全新页面重载再求     ✓ 通过
门 3  循环接缝            — 未判（film.json 未声明 loop）
探针  seek 期间禁用 API    ✓ 无
全部通过                  exit=0
```

**这一条是整套能不能拼起来的关键证据**：脚手架写出的模板、film-motion 的运行时、
film-motion 的渲染器和验收工具，四者接口一致，不需要人工粘合。

三个画幅同一条时间线都渲通了（同一份 `scene.html`，不改一行）：

```
9x16  1080×1920  90 帧  5.5s   ffprobe: 1080,1920,30/1,90
1x1   1440×1440  90 帧  6.1s   ffprobe: 1440,1440,30/1,90
16x9  1920×1080  90 帧  5.7s   ffprobe: 1920,1080,30/1,90
```
这是"坐标一律走 `place()`/`size()`、不写死像素"那条约束的直接回报。

### 4. 文档模板从各 skill 拷，下游脚本能解析

脚手架原来内联了六份文档模板。**内联是错的**：film-storyboard 的 shotlist 模板里
有一个 `check_shotlist.py` 要解析的 ```json 块，我的内联版漏了它，脚本会直接报错退出；
film-research 的 facts.md 总表列名也和我内联的那版完全不同，`factcheck.mjs` 报
"找不到总表" exit=2。两处都是同一个病：同一份内容抄两遍，skill 一改就对不上。

改成清单驱动，模板一律从**拥有那个阶段的 skill** 的 `assets/` 里拷，
并替换 `<片名>` `<slug>` `<film-xxx>`（skill 目录替成绝对路径，模板里的命令可直接复制运行）。
来源 skill 没装时落占位并在报告里列出来。

验证：用脚手架新建的片子直接喂给两个下游脚本，都能解析——

```
$ node skills/film-research/scripts/factcheck.mjs --film scaffold-selftest
  警告: F01 承重但状态是"待核" —— 承重事实应至少两个独立来源或一手来源
  结果: 0 错误, 1 警告                                            exit=0
$ python3 skills/film-storyboard/scripts/check_shotlist.py --film scaffold-selftest
  错误: narration.json 不存在 —— 音频先行                          exit=2
```
两个退出码都是对的：facts 模板结构合法（只是占位行还没核实），
shotlist 正确拒绝在没有实测时间轴时排时间。

### 5. `--from` 变体、PROGRESS.md 模板（2026-10-23，全部在 scratch 目录跑）

改动前后各跑一遍 `t-plain` / `t-expl --recipe explainer --format 16x9` / `t-narr --with narration,typography` /
`t-facts --with facts --formats 9x16,1x1`，`diff -r` 只有一行：`Only in new/films/t-expl/docs: PROGRESS.md`。

```
$ node new-film.mjs l1-alt --from weiqi2-l1 --title "变体" --format 16x9     # 源片 64M，其中 out/ 63M
⚠ --from 时忽略 --format：变体沿用 weiqi2-l1 的设置，要改就改新片 film.json
复制 61 个文件（含 out/ 下旁白音频 11 个）                                      # 新片 10M
这些文件里还写着旧 slug "weiqi2-l1"，看一眼要不要改: assets/LICENSES.md docs/*.md scene.html script.json
film.json: slug=l1-alt variantOf=weiqi2-l1
```
`diff -r -x out` 两片只差 film.json 的 slug/title/variantOf 三行。再跑一遍 `--force`：复制 0 个、全部跳过。
`--from nope` / `--from` 自己 → exit 2。
**没测**：用变体真渲一遍（render.mjs 不读 variantOf，按理无影响，但没跑过）。

## 与其他 skill 的接口对齐情况

| 项 | 状态 |
|---|---|
| `film.json` schema | 已与 film-motion 的 `scripts/lib/film.mjs` 对齐，render.mjs 能直接读 |
| `scene.html` 模板 import | 用 `layoutFromURL()` + `spring()` + `settle()` + `seeded()`，与 film-motion 当前运行时一致 |
| 基础运行时集 | `film-motion`(layout/motion/serve) + `film-narration`(narration/sfx)，实测全部拷到 |
| `docs/*.md` 模板 | 由脚手架生成；各 skill 的模板需与之一致，不一致以各 skill 为准并改脚手架 |

## 没测到的

- **`serve.mjs` 被拷进了片子的 `runtime/`，但 `scene.html` 并不 import 它**
  （它是 agent 工具，不是影片运行时）。这违反契约 §4 的分类，属于
  film-motion 把它放错了目录。不影响功能（多拷一个文件），但该归位。
- 全套十个 skill 的**真实片子端到端**（调研→机制→音频→分镜→实现→自检）没跑过。
  这里验的只是脚手架与引擎的接口，不是流程本身的有效性。
- `/film` slash command 没在真实会话里触发过。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

### kernel.md 原 §7 门的来历（实测）

- **`USES_WAAPI` 为什么必须声明**：Playwright 截图的 `animations:'disabled'` 会对 CSS/WAAPI 动画调 `finish()`，
  把它们打成终态。实测四个不同时刻截出同一帧。渲染器看到这个标志改用 `playbackRate = 0`。
- **门 1b 为什么存在**：1a/2/3 对**加载期**的非确定性全部是假门。加载时用 `Math.random` 生成布局，1a、2、3 全部通过，
  只有换全新页面重载的 1b 抓到（13–15 万像素不同）。
- **门 3 的判据为什么不是逐字节相同**：一支正确的循环片，首末帧本来就差约 8900 像素。现在的判据是
  frame(DURATION)=frame(0)，且跨缝跳变不超过相邻帧典型差异的 4 倍。
- **探针**：统计 seek 期间调用禁用 API 的次数，直接点名 `Math.random ×840` 这类违约。
- **判据在 canvas 层不在编码器层**：H.264 残差噪声让 `md5(mp4)` 比对不可靠（实测两次渲染有 46 个像素差 1–2/255）。
- **缓存泄漏只有带回退路径的乱序求值能抓**：实测三种泄漏（检查点存引用而不存副本、仿真循环外挂了个顺序 `seeded()`、
  时间往回跳时不回退），冷启动直接 seek 和门 1a、1b 三种都抓不到，只在门 2 失败，其中一种要到第一个检查点之后（t=1.1s）才露馅。
  所以写缓存之前先写一个有泄漏的版本，确认门真的会红，再修好。film-physics 的 physcheck 做顺序、乱序、倒序逐帧比，比通用 seamcheck 更狠。

### render.md 原「渲染器钉版本」实测

像素由两层外部版本决定——浏览器（版本号 **和** 构建形态）与编码器（ffmpeg/x264 版本与线程数）。
浏览器这层的实测（demo-tls 9x16 整片 313 帧，用 `FILM_CHROMIUM` 换构建，同一台 macOS + SwiftShader，仓库 docs/verified/film-motion.md §11）：

| 换了什么 | 像素 | 看得出来吗 |
|---|---|---|
| 版本 143/145/151/156，Playwright 默认的 headless shell | 四个版本渲出的 mp4 **逐字节相同** | 不 |
| 版本 143/145/151/156，完整 Chrome | 143/151/156 抽样帧解码后逐像素相同；145 每帧都差：0.001%–0.36% 像素、最大 1–5/255 | 不 |
| 同为 156，headless shell ↔ 完整 Chrome，**字体没随片打包**（demo-tls 用 `ui-monospace`） | 明文时刻 4.4%–5.4% 像素、最大 3/255；画方块字（▚▞▟，`ui-monospace` 没有、必须回退）的时刻 10.4%–13.6%、最大 216/255 | 回退时刻**看得出来** |
| 同上一对构建，字体随片打包（`_test-typography`，协调者实测） | 0.18%–0.90% 像素；差 >8/255 的只有 93–3534 个、集中在一小块（边线挪一个像素） | 不 |

所以在版本这条轴上，钉版本**不是为了视觉保真，是为了哈希缓存和可复现性**：逐帧哈希比的是截图 PNG 的**字节**，
而 PNG 编码器本身会随版本变（143→151 解码像素全同、PNG 字节全变）。换一个版本，画面一样，但哈希全变、
分片缓存整体重编、改动报告说"313 帧像素变了"（报告会附注这一点）——"像素到底变没变"只能解码后回答。
反过来也别以为"版本随便换"：145 就是那个真有差异的，只是差异低于可见阈值。

唯一看得出来的那一行，因果链是：**字体没随片打包 → 字形缺失时走系统回退 → 回退选哪个字随构建而变 → 大面积可见差异**。
不是两种构建光栅化不同（明文时刻最大差只有 3/255）。字体随片打包后降到亚像素级。所以根治是打包字体，
渲染前用 `<film-core>/scripts/font_source.mjs --film <slug>` 查有没有系统字体或通用族（`ui-monospace`、`sans-serif`…）抢在随片字体前面；
钉构建形态只是避开症状。`browser.version()` 分不出两种形态，指纹里完整 Chrome 记成 `156.0.8078.4 (full Chrome)`，切换时告警会点名。

### render.md 移出的实测数字

- `--scale 0.5`：ghost-jam（16x9，708 帧，sub=1 veryfast）截图+编码 27.8s → 12.0s。
- 并行（2s 测试片拉到 8s/60fps，480 帧，sub=1）：1 worker 25.6 截图/秒 → 8×2 页 141.9 → 16 worker/8 浏览器 213.0；单浏览器 8 页只有 69.2。6 种拓扑截图哈希逐帧相同。
- CDP 截图 vs locator：15.0→29.9 fps，120 帧逐像素一致。PNG fast：weiqi2-l1 单帧 174→45 ms（docs/verified/film-motion.md §17）。
- 哈希清单：只改 t>1.5 的指针颜色 → `14 帧像素变了 → 1.53–2.00s`；ghost-jam 改刹车灯辉光半径 → `206 帧 → 6.83–13.70s`（24 片里编码 8 片、复用 16 片，30 秒）。
- 分片缓存：改 0.5s 内容，4 片里编码 2 片、复用 2 片；sub=1 与 sub=4 混合拼接 vs 全量重编都是 120/120 解码相同。
  x264 线程：1 vs 16 线程最大差 61/255、4.8% 像素；4 vs 8 线程 88/120 帧不同。
