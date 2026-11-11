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

## 镜头组合子 sequence / series / loopT / rate / freeze（motion.js，2026-11-10）

来由：docs/oss-borrowings.md #6（Remotion Sequence/Series/Loop/Freeze 的纯函数版）。只新增导出，`git diff` 对 motion.js 只有 134 行插入、0 行删除，已有函数行为不变。
名字避开了已有运行时的导出：film-webfx camrig.js 已有 `shots()`（相机关键帧）、film-physics chain.js 已有 `chain()`，所以这里叫 `sequence` / `series`，同一场景一起 import 不撞名。
与 film-motion `timeline()`/`cutsFrom()` 的分工：core 只回答"t 时刻哪些镜头活着、各自的局部时间和进度、交棒窗口进度"，不认转场 kind、缓动和 paint；
timeline 要求镜头与转场交替、必须给 kind/ease，交给 createStage 做离屏合成。cutsFrom 只返回累计时刻数组，series 多了 at(t)。

**测了什么**（`node tests/fixtures/_test-shapes/tests/unit.mjs` 中的 14 条，全部通过）：
- 边界来自具名时刻：`marks: { 起: 1.2, 落: 3.0 }`、`until: '起'` → boundaries [1.2, 3]、end 5；边界直接用 `beatGrid(120, 0.5).bar(n)` → cuts [2.5]、end 4.5。
- `cuts` 只含 overlap=0 的边界（[1.2]）；交棒窗口 b→c = [2.8, 3.2]（overlap 0.4，align 0.5），格式同 CUT_WINDOWS。
- 硬切 t=1.2 只有 b 且 local=0；交棒中点 t=3.0：b.exit=0.5、c.enter=0.5、c.local=0.2；窗口右端开（3.2 只有 c）；片外夹到首/末镜头；progress 是名义区间进度（2.1 → 0.5）。
- 抛错：边界非递增、具名时刻找不到、窗口越过相邻镜头名义边界、重名，4/4。
- series([1,2,0.5], 1)：cuts [2,4]、end 4.5、at(3) = 第 1 段 local 1；loopT / rate / freeze 各 4、2、4 个取值。
- 在浏览器里：夹具 `_test-shapes/scene.html` 的镜头表用 sequence 驱动，并把 `Q.cuts`/`Q.windows`/`Q.marks` 挂到 window.CUTS/CUT_WINDOWS/MARKS；seamcheck 门 1a/1b/2 全部通过、门 4 180 帧 0 不同（数字见 film-motion.md 同日一节）。
- film-critique `transitions.mjs --film _test-shapes --films-dir tests/fixtures`：exit 0，输出「剪辑点来源：window.CUT_WINDOWS + window.CUTS · 2 个窗口」，#1 硬切 2.000s（中 f60），#2 转场 3.900–4.500s（cut 4.200s）· morph→split，说明 `Q.cuts`/`Q.windows` 的格式被下游原样识别。

**没测到**：render.mjs 读取 `Q.cuts` 做子帧截断的实际效果（夹具 sub=1，没开运动模糊）；三个以上镜头同时活着（窗口互相重叠，代码允许）的画面；长片（> 2 分钟）镜头表的查表耗时（at(t) 是 O(镜头数) 线性扫描）。

## GPU 后端：film.json `backend: "gpu"`（2026-11-10）

环境：macOS 26.2（Darwin 25.2），Apple M3 Max（16 线程），Chromium 156.0.8078.4 **headless shell**（Playwright 1.64.1 默认那个，不是完整 Chrome）。
实验脚本放在 scratchpad 里，没有入库：`launchBrowser({extraArgs})` 打开夹具，取 16 个均匀时刻，检查同 t 两次、乱序、同浏览器新页面重载、4 页并行交错、关掉浏览器重启这五项，逐帧比较截图 PNG 的 md5；后端之间的差异用 `makeComparer` 解码后逐像素比较。

### 1. headless shell 认哪些参数（WebGL UNMASKED_RENDERER + CDP SystemInfo featureStatus）

| 参数 | WebGL / WebGL2 renderer | 2D 光栅 / 合成 |
|---|---|---|
| 不加（默认） | SwiftShader（Playwright 自己就带了 `--enable-unsafe-swiftshader`） | 软件 / 软件 |
| `--use-angle=metal`（加不加 `--use-gl=angle`、`--ignore-gpu-blocklist`、`--disable-software-rasterizer` 结果都一样） | **ANGLE Metal: Apple M3 Max** | **GPU / GPU** |
| `--enable-gpu` | ANGLE Metal | GPU / GPU |
| `--ignore-gpu-blocklist`、`--use-angle=gl` | SwiftShader | 软件 / 软件 |
| `--use-angle=swiftshader` | SwiftShader | GPU 进程里的软件实现 |
| `--use-angle=metal --disable-gpu` | SwiftShader（**静默退回**） | 软件 / 软件 |
| `--use-angle=metal --disable-gpu-rasterization --disable-accelerated-2d-canvas` | ANGLE Metal | 软件 / GPU |
| 上一行再加 `--disable-gpu-compositing`（**采用**） | ANGLE Metal（featureStatus `webgl=enabled_readback`） | 软件 / 软件 |

结论：headless shell 能用上硬件 GPU，不需要换完整 Chrome。最后一行的 SystemInfo 设备串是 `ANGLE Metal Renderer: Apple M3 Max, Version 26.2 (Build 25C56)`，`driverVersion` 是 26.2；
UNMASKED_RENDERER 里写的是 "Unspecified Version"，所以指纹另记 `gpuDriver`。

### 2. 同机确定性（16 个时刻，五项分别是 同t / 乱序 / 重载 / 并行4 / 重启，数字是 16 帧里不同的帧数）

| 夹具 | 软件（默认） | 只加 `--use-angle=metal` | 采用的四参数 |
|---|---|---|---|
| `_test-kernel`（纯 2D） | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 |
| `_test-typography`（2D 文字） | 0/0/0/0/0 | **0/1/10/9/0**，又跑两次：0/1/10/10/0、0/1/10/10/0 | 0/0/0/0/0（跑了 3 次） |
| `_test-webfx`（片元着色器） | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 |
| `_test-3d`（three 场景 + 粒子 + 泛光/景深） | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 |
| weiqi-fx-open 拷贝（本仓库样例，三维重片） | 0/0/0/0/0 | 没测 | 0/0/0/0/0 |

只开 Metal 时，2D 文字在 GPU 光栅下**不确定**：同一个浏览器里换个新页面重载、或者并行开页，结果就不一样，而跨浏览器重启反而一致。门 1b 和门 4 会报红。所以 GPU 光栅和 GPU 合成必须关掉。
只关 GPU 光栅、保留 GPU 合成的那组参数，四个夹具的像素与采用的参数**逐位相同**；采用的参数多关一条 GPU 合成，图的是截图路径与软件后端一致。

### 3. 和软件后端比像素（同一批 16 个时刻）

| 夹具 | 不同帧 | 像素差 | 最大通道差 |
|---|---|---|---|
| `_test-kernel`，采用的参数 | 0/16 | 0 | 0 |
| `_test-typography`，采用的参数 | 0/16 | 0 | 0 |
| `_test-kernel`，只加 Metal | 16/16 | 0.02% | 61 |
| `_test-typography`，只加 Metal | 12/16 | 0–1.34% | 189 |
| `_test-webfx`，采用的参数 | 16/16 | 3.63–6.51% | 8 |
| `_test-3d`，采用的参数 | 16/16 | 23.0–46.0% | 254 |
| weiqi-fx-open，采用的参数 | 16/16 | 8.2–24.7% | 202 |

肉眼对比 weiqi-fx-open t≈13s、`_test-3d` t=3.73s 的两张截图：是同一张图，粒子亮度和泛光边缘有细微差别，没有错位，也没有缺东西。

### 4. 耗时

单页测量（16 个时刻取中位数；seek = `advance(t)`，截一帧 = seek + CDP 截图 + PNG fast）：

| | seek 软件 → GPU | 截一帧 软件 → GPU |
|---|---|---|
| `_test-3d` | 0.7 → 0.8 ms（three 的 seek 只提交命令，GPU 的活落在截图里） | 211 → 79 ms |
| weiqi-fx-open | 288 → 19 ms | 395 → 108 ms |
| `_test-webfx` | 49.5 → 37 ms（WebGL 读回到软件合成） | 82 → 67 ms |
| `_test-kernel`（2D） | 0.4 → 0.4 ms | 16.7 → 16.6 ms（第一次测得 33 ms，是同时有别的负载，复测持平） |

整片测量（`render.mjs --preset veryfast`，默认 worker 数）：

| | 截图阶段 软件 → GPU | 墙钟 软件 → GPU |
|---|---|---|
| `_test-3d` 210 帧 | 20.1 → 5.9 s | 31.0 → 14.1 s |
| weiqi-fx-open 763 帧 | 149.9 → 21.9 s | 184.8 → 41.0 s |
| `_test-webfx` 120 帧 | 3.3 → 3.1 s | 5.0 → 5.1 s（瓶颈在编码） |
| `_test-3d` 的 `seamcheck --parallel 4 --relaunch 2` | — | 165.4 → 40.5 s |

### 5. 门（GPU 后端，用的是真实脚本，片子是声明了 `"backend": "gpu"` 的 scratch 拷贝）

- `_test-3d`：`seamcheck --parallel 4 --relaunch 2`，1a/1b/2 各 8/8 ✓，门 4 210 帧 0 帧不同，门 5 与渲染清单 210 帧逐帧相同，exit 0。
- `_test-webfx`：同样的参数，门 4 120/120 一致，门 5 一致，exit 0。
- weiqi-fx-open 拷贝：`--parallel 4 --relaunch 3`，门 4 763 帧 0 帧不同，门 5 新跑 2 遍彼此相同，与清单也相同，exit 0（158 s）。
- 渲染拓扑：`_test-3d` 9x16 分别用 workers 7（4 个浏览器）、1、16（每个浏览器 1 页）渲染，都是「所有帧像素不变」；16x9 用默认拓扑和 `--workers 16 --pages-per-browser 4 --no-cache` 渲染，结果也相同。
- `deliver` 交付 `_test-webfx` 的 gpu 拷贝：render、seam、fontsrc、texcache 全部通过，收据 `env` 带上了 `backend`/`gpu`/`gpuDriver`，输出开头是代价提示。
- 在 GPU 后端下，门 4 和门 5 实测都稳定，所以 **deliver 不强制单 worker**。

### 6. 声明了但起不来

把 `FILM_CHROMIUM` 指向一个包装脚本，脚本给 headless shell 加上 `--disable-gpu` 再 exec，模拟没有 GPU 的机器（表 1 里实测这种情况会**静默退回** SwiftShader）：
render、seamcheck、font_source、preflight，以及 film-critique 的 stills（它经 openScene 打开片子），都输出「✗ 缺能力：本片 film.json 声明 "backend": "gpu"，但本机浏览器没有起来硬件 GPU 的 WebGL（webgl: ANGLE (Google, Vulkan … SwiftShader driver) …）」并以 exit 1 退出。
同一个包装脚本跑缺省后端的片子时，seamcheck 照常全部通过。

### 7. 默认路径零回归

`LAUNCH_ARGS` 没有变；缺省后端下 `launchBrowser()` 拼出的参数与改动前逐字相同（包装脚本记下的实际命令行里，套件只加了 `--font-render-hinting=none`）；`rendererFingerprint` 的形状也与改动前相同。
`node dev/test.mjs --quick` 全部符合期望；`accept.mjs` 通过，已交付片子的收据都是 ✓；`selfcheck` 通过。

### 没测到

- **Linux、Windows、别的显卡**（AMD、Intel、NVIDIA、其他代的 Apple 芯片）一定没测到；跨机器的像素一致性也没测，预期不一致，所以收据只在同款显卡上可复现。
- 同一台机器换 macOS 版本（Metal 驱动随系统更新）之后像素会不会变：没测，只做了告警（`gpuDriver`）。
- 只测了 Metal。Linux 上对应的 `--use-angle=vulkan` / `--use-gl=egl` 没实现，声明了 gpu 会报「缺能力」。
- 长时间渲染时 GPU 降频、温控，以及显存压力下的确定性：只测过 ≤ 25 s 的片子。
- `sub > 1` 运动模糊、`--scale` 缩小版在 GPU 后端下的表现：没单独测（截图路径与软件后端相同，预期没有差别）。
- 其他 skill 自己起浏览器、不经 openScene 的检查（film-physics physcheck、film-typography legibility、film-assets font_proof、film-story siblings 的拼图页）仍然用软件后端。physcheck 自己和自己比，结论不受影响，但它看到的不是 gpu 像素。
