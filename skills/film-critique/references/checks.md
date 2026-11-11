# 客观检查：做法、判据、阈值来源

本文逐项说明 `scripts/check.mjs` 的检查。原则是**测量本身客观，阈值写明出处**；凡是属于惯例而非物理定律的阈值，都可以在 `style_guide.md` 的 critique 块里覆盖。
各项的实测数据与来历记录在仓库 docs/verified/film-critique.md。

目录：
0. 声明哪些检查（film.json `checks`）
1. 结论等级
2. 场景要暴露什么
3. style_guide 的 critique 块
4. 逐项说明：采样 / 并行 / 局部运行 / inputs.changed / duration / mp4 / loop / readability / facts.screen / law pixels / law occlude·inframe / claims / tilt.ortho / continuity·rhythm / motion·variety·beatsync·hook·mute / legible / law.palette / still / empty.vo / cover / hold / mark / page.errors
5. 不归本 skill 的两条门

---

## 0. 声明哪些检查（film.json `checks`）

本文的每一项都是质量检查，不属于页面契约（契约写在 film-core `references/kernel.md`，由 seamcheck 负责），所以**只有片子声明了才会开启，没有默认开启的项**。
`checks` 是 film-core 规定的扁平 id 数组（格式见 film-core `references/api.md` §5），需要传参数时写成单键对象，例如：
`"checks": ["laws", "loop", "readability", { "contrast": { "min": 4.5, "large": 3 } }, "marks"]`。
声明之后按原有的严格程度执行，不会降级成提醒。各 skill 认领的 id 只登记在 `gates.json`；没有声明的项汇总成一条 `SKIP checks`；id 写错（没有任何 skill 认领）时，accept --deep / deliver 会报红（缺能力）。

| id | 开启后检查的项目（见第 4 节） | 依赖的能力 |
|---|---|---|
| `narration` | `narration.format`、`duration.narration`（包括有 script.json 却没有 narration.json 的情况）、`duration.wav`，以及 `mp4.asr` 的 TODO | film-narration |
| `mp4` | `mp4.fps` / `mp4.duration` / `mp4.av`（传了 `--mp4` 时检查；没传则报一条 `SKIP mp4`） | |
| `truepeak` | `mp4.truepeak`（传了 `--mp4` 时检查） | |
| `loop` | `loop`（film.json 或 critique 块声明了 loop 时才判定） | |
| `readability` | `readability.size`、`readability.time`、`style_guide.units` | |
| `contrast` | `readability.contrast`。只写 `"contrast"` 时按 WCAG 标准：正文 4.5:1、大字 3:1（大字指有效字号 ≥18.66 px）；写成对象可以修改阈值：`{ "contrast": { "min": 3, "large": 2, "large_px": 24 } }` | |
| `facts.screen` | `facts.screen`、`facts.single`（画面文字与旁白里的数字要能在 facts.md 中找到同值的数） | |
| `style-guide` | 缺少 style_guide.md 或其中没有 critique 块时报的两条 LOOK | |
| `laws` | critique 块里的 `law.*`（pixels / occlude / inframe / HUMAN）、`law.palette`、`law.max_still` | |
| `still` | 本片没有声明 `max_still` 时报的 `still` LOOK | |
| `empty` | `empty.vo` | |
| `cover` | `cover.empty`：首帧（t=0，即默认缩略图）是空画面 | |
| `marks` | `mark.length` / `mark.visible` / `mark.sync` / `marks` | film-narration |
| `claims` | 分镜断言的画面实测（`claims.*`、`probe.pure`、`anchors.pure`） | film-story |
| `tilt` | `tilt.ortho` | film-motion |
| `page` | `page.errors` | |
| `continuity`（可选疑点） | `continuity`：镜头交接处有没有元素延续下来。写 `"continuity"`，或写成 `{ "continuity": { "cuts": ["MARK label", "label.end", 12.3] } }` 声明有意的切点（这些切点不计分） | |
| `rhythm`（可选疑点） | `rhythm.cv`（镜头长度的变异系数）、`rhythm.still`（静止占比与最长静止段）。写 `"rhythm"`，或用 `{ "rhythm": { "cuts": [...] } }` 指定镜头切点 | |
| `motion`（可选疑点） | `motion.jerk`（非切点处的突然起停）、`motion.step`（瞬间出现 / 消失的跳变，只计数）、`motion.regions`（同时在动的互不相连区域）、`motion.uniform`（匀速段占比）、`motion`（整片运动读数）。参数见第 4 节 motion | |
| `variety`（可选疑点） | `variety`：连续 N 个镜头构图几乎相同（景别、重心、填充率，可选主色） | |
| `beatsync`（可选疑点） | `beatsync`：画面事件（切点、MARKS 起点、运动起步）与最近拍点的偏差分布；没有 beats.json / music.json 时 SKIP | |
| `hook`（可选疑点） | `hook`：开头 N 秒（默认 3）里空画面持续多久、有没有变化，并拼 0 / 0.5 / 1 / 2 / 3 秒五帧 | |
| `mute`（可选疑点） | `mute`：旁白在说、画面却既没截到文字也没变化的占比 | |
| `legible`（要片子给阈值） | `legible`、`legible.pure`：三维场景里的文字在阅读时间窗内投影后的字高与压扁比。必须写成 `{ "legible": { "min_px": <原生像素>, "min_squash": <0–1> } }`（至少给一个阈值）；只写 `"legible"` 会直接 FAIL，因为套件没有默认阈值 | |

- 「依赖的能力」一列：声明了某项检查但对应的 skill 没有安装时，check.mjs 会在启动浏览器之前报「缺能力 film-X」并 exit 1。
- `claims.source` 疑点通过读取服务器的加载记录，判断本片加载了哪些 film-physics 运行时（film-physics 没有安装时，只认记录里标为 `from: film-physics` 的条目）。
- 本片法律里的 HUMAN 条目写了 `from` / `to` 时，check.mjs 会保存时间窗中点的帧 `evidence-human-<id>-<t>s.png`，指明人该看哪一帧（结论仍是 HUMAN）；
  check.mjs 还会在 checks.json 旁写一份 `checks.json.meta.json` 记录新鲜度（见 `references/sampling.md` §4）。`duration.film`（film.json 的 duration 与 DURATION 对账）和 `determinism` 的 TODO 不受 `checks` 开关控制。
- `continuity`、`rhythm`、`motion`、`variety`、`beatsync`、`hook`、`mute` **只报 LOOK / PASS / SKIP，永远不会 FAIL**，`--strict` 时 LOOK 照常算失败（与其他 LOOK 同一语义）；`explainer` 配方不会替片子声明它们和 `legible`。
  要把其中某个量当本片法律，写进 style_guide 的 critique 块（如 `max_still`）或 `laws[]` 的像素判据，走第 3 节的法律机制，这几项本身不升级。

## 1. 结论等级

| 等级 | 含义 | exit |
|---|---|---|
| FAIL | 客观不变量被破坏，或违反了本片自己声明的法律 | 1 |
| LOOK | 疑点：能测出来，但算不算问题取决于本片意图 | 0（`--strict` 时 1） |
| HUMAN | 本片法律里机器无法判定的条目，原样交给人判断 | 0 |
| HOLD | 落在 MARKS `hold` 区间里的 LOOK：作者声明这是故意保留的，并写了理由（见第 4 节 hold） | 0（`--strict` 也不拦） |
| TODO | 应该检查，但归别的 skill 负责（ASR 校验、确定性门） | 0 |
| PASS / SKIP | 通过 / 前置条件不存在所以不检查（会说明原因） | 0 |

LOOK 不是"轻一点的 FAIL"：脚本只负责把那一秒指出来（附证据帧），判断留给了解本片意图的人。

## 2. 场景要暴露什么

| 全局 | 必需 | 用途 |
|---|---|---|
| `window.seek(t)` | 是 | 契约本身 |
| `window.DURATION` | 是 | 时长对账、确定采样范围 |
| `window.MARKS` | 强烈建议 | `[{label, start, end, load?, word?, text?, nth?, line?}]` 叙事事件表 |
| `window.VO_OFFSET` 或 film.json `narrationOffset` | 旁白不从 0 开始时 | narration.json 时刻 + offset = 画面时刻 |
| `window.USES_WAAPI` | 用了 WAAPI/CSS 动画时 | 截帧时冻结 playbackRate |
| `window.probe(t)` | shotlist 有 `source: scene` 的曲线时 | 返回 `{曲线名: 数}`，用于分镜断言的画面实测（见 claims.*） |
| `window.anchors(t)` | style_guide 有 `occlude` / `inframe` 法律，或 shotlist 有 `source: anchor` 曲线时 | 画出第 t 秒并返回本帧锚点表 `{t, items:{名:{x,y,w,h,cx,cy,n}}}`（坐标归一化、不裁剪）。由 film-core `runtime/anchors.js` 的 `A.install(seek)` 安装，语义见 film-core `references/runtime.md` §6 |
| `window.CUT_WINDOWS` / `window.CUTS` | 有转场或硬切时建议提供 | 转场窗口 `[{label,start,end,cut}]`（film-motion `TL.transitionMarks()`）与硬切时刻。供 transitions.mjs 取帧、contact.sh 确定特写起点（`references/sampling.md`）；`motion` / `variety` / `beatsync` 用它分镜头、排除切点处的整屏变化（不参与任何 FAIL） |
| `window.legible(t)` | checks 声明了 `legible` 时 | 画出第 t 秒并返回本帧三维场景中文字的测量表 `{t, items:{名:{em, emMax, squash, aspect, cx, cy, depth, behind, shown, opacity}}}`；`.windows()` 返回 `[{name, from, to}]`。由 film-webfx `stage3d.js` 的 `S.legible(name, obj, {from, to, em})` 安装（在加载期登记） |

MARKS 各字段：`load: true` 表示该事件在叙事上是关键事件（check.mjs 输出和本节标题里叫「承重事件」）；`hold: "<理由>"` 表示这段里的疑点是故意保留的（见第 4 节 hold）；`word` 是绑定的旁白词；`text` 是事件附带的屏幕文字（用于计算阅读时间）；`nth` / `line` 见 mark.sync。**脚本只能检查已声明的事件**。MARKS 应当从同一份数据计算出来（例如年份到秒的映射函数），手抄的数值会和画面各自漂移。

## 3. style_guide 的 critique 块

在 `docs/style_guide.md` 里写一个 ` ```critique ` 代码块（JSON 格式），**只写本片真正在乎的项**，没写的项不检查：

```critique
{ "palette": ["#EDE4D3", "#1F1C18", "#B33A28"], "palette_tol": 40, "palette_max": 0.005, "max_still": 1.5, "loop": true,
  "min_text_src_px": { "latin": 26, "latin_bold": 30, "cjk": 56, "cjk_bold": null }, "read_cps": 9, "min_mark": 0.5, "sync_tol": 0.2, "empty_edge": 0.001,
  "laws": [ { "id": "no-curve", "text": "不出现曲线运动", "how": "看 strip.png 连续帧位移方向" } ] }
```

| 键 | 含义 | 细节 |
|---|---|---|
| `palette` / `palette_tol` / `palette_max` | 本片色板、匹配容差、色板外像素的占比上限 | law.palette |
| `max_still` | 连续完全静止的秒数上限（写了之后，超限从 LOOK 升为 FAIL） | still |
| `loop` | 本片要求循环 | loop |
| `min_text_src_px` / `min_text_px` | 字号下限：前者用原生 px，后者用手机有效 px（360 宽）；可以写单个数字，也可以按档写（`latin` `latin_bold` `cjk` `cjk_500` `cjk_bold`…）；值为 `null` 表示该档没有稳定下限，出现这一档的文字就报 LOOK | readability |
| `view_width` | 观看宽度，默认 360；以横屏全屏观看为主的片子写 720 | readability |
| `read_cps` | 阅读速度，默认 9 字/秒 | readability.time、mark.length |
| `min_mark` / `sync_tol` | 关键事件的最短时长 / 事件对词的容差 | mark.* |
| `empty_edge` | 判定"画面已空"的边缘像素占比 | empty.vo |
| `facts_ignore` | 不参与对账的数字（正则，按整段匹配） | facts |
| `facts_single` | 孤立的单个数字：写 `"check"` 表示也参与对账；写其他字符串表示不对账，该字符串作为理由原样写进报告 | facts.single |
| `ortho_ok` | 一句理由，说明大面积非等比变换是有意的（等轴测、图解风格），写了之后 `tilt.ortho` 转为 PASS | tilt.ortho |

`laws[]` 里的条目默认写进 review_log 的 HUMAN 行（`how` 要写清楚人该看哪张图）；能由机器判定的条目加上判据后，就不再进 HUMAN：

```jsonc
// 像素判据：某颜色在本片只属于那个元素时成立（颜色签名唯一）；10fps 采样帧上判 max/min
{ "id": "no-dead-line", "text": "…", "pixels": { "near": "#e0603a", "tol": 40, "stat": "count", "max": 0 }, "from": "密钥成立.end", "grace": 0.5 }
// 遮挡门：承重锚点不与文字框 / 其他锚点相交；"text" = 同一次绘制里拦截到的文字框；pad 为原生像素；逐帧判
{ "id": "…", "text": "…", "occlude": { "anchors": ["参照树", "岗亭"], "against": ["text", "字幕底条"], "pad": 0 }, "from": "车往前、堵往后", "to": "end" }
// 出画门：safe 为四边内缩比例（数或 [x, y]），min 为框落在区内的面积占比下限；某帧没登记 = FAIL
{ "id": "…", "text": "…", "inframe": { "anchors": ["停着的车"], "safe": 0, "min": 1.0 }, "from": "有车被逼停", "to": "有车被逼停.end" }
```

`from` / `to` 引用 MARKS 的 label（`<label>.start|.end`，或 `start` / `end`），不直接写秒数；`grace` 是留给退场动画的容差秒数。
锚点类法律要求场景在绘制路径上登记锚点（film-core `runtime/anchors.js`）。脚本不提供默认构图，也不会自动避让，只保证各层看到的是同一个位置。

## 4. 逐项说明

### 采样
默认以 10fps（`--sample-fps`）截取全分辨率帧，在浏览器里缩到 180px 宽后计算统计量，所以**时间分辨率为 ±0.1s**，原画幅中小于约 6px 的变化可能被漏掉。60 秒的片子约需 600 次截图。想跑得更快应先加大并行度，降低采样率会漏掉东西（±0.2s）。

### 并行（`--workers N`，默认 核数/2、≤16；`--pages-per-browser 2`）
实现在 `scripts/_pool.mjs`，拓扑与 film-core `render.mjs` 相同：每个 worker 包含一个场景页，加上同一浏览器里的一个分析页；0 号 worker 的场景页是主页面，负责读取 MARKS / probe、输出证据帧、比较 frame(D) 与 frame(0)。
逐帧类检查（主采样、像素/锚点法律、像素/锚点断言、事件可见性、循环接缝的 8 对相邻帧、压扁扫描、continuity）按**连续**的时间分片派发，结果按原顺序拼回；
有状态的比较（静止判定、`dPrev`、像素断言的 `motion`）在 Node 端按时间顺序计算，每个分片开头会重新截取前一帧来补上状态。原生分辨率的像素统计由 `scripts/_pixels.mjs` 在 worker 线程里完成
（要求 8 位、非隔行、不透明的 PNG，不满足就抛错）。结论与 `--workers 1` 逐字节相同（页面报错有多条时，前 3 条的先后顺序可能不同）。代价是每个页面都要各自加载一遍场景，
内存随页面数增长；不纯的场景在不同分片上会给出不同结果，这本身就违反了内核契约。

### 局部运行：没有
传入 `--only` / `--law` / `--claim` / `--from` / `--to` 时会报"未实现"并 exit 2，不会悄悄改成整片运行。要验证一条法律，就整片运行。

### inputs.changed：未接线
`scripts/_inputs.mjs` 已经写好：它在开始和结束时各记录一次本次读过的输入文件的 md5、大小和 mtime，两次不一致时报 `inputs.changed` FAIL，checks.json 带上 `void`，本次结果作废。但 check.mjs 还没有调用它，所以目前不会报这一项。
接线时的设计（比较哪些文件、不比较哪些、盲区）写在 docs/verified/film-critique.md 的移出小节。在接线之前，运行过程中改过输入就要重新运行。

### duration.*：时长对账
- `film.json.duration` 与 `window.DURATION` 相差超过 1 帧时 FAIL（说明其中有一处是手填的）。
- 旁白最晚结束时刻加 offset 超过 DURATION 时 FAIL（旁白被截掉了）；最早开始时刻小于 0 时也 FAIL。
- `lines[].wav` 存在时用 ffprobe 实测时长，与 `lines[].duration` 相差超过 50ms 时 FAIL（说明 narration.json 不是按实测时长回写的）。
- 有 script.json 却没有 narration.json 时 FAIL，不会当作 0 处理。

### mp4.*：成片流对账（`--mp4`）
- 帧率不等于 film.json 的 fps 时 FAIL（迭代时用 `--fps 30` 渲染是正常的，这一条用来提醒这还不是定稿）。
- 视频流时长与 DURATION 相差超过 1 帧时 FAIL。
- 音轨与视频流相差超过 1 帧加 50ms 时 FAIL（50ms 余量用于 AAC priming 和尾帧对齐，实测常见 20–40ms）。
- 音画**内容**漂移：列一条 TODO，指向 film-narration 的 `align.py --verify`（有旁白时才列）。
- `truepeak`：读取 ffmpeg `loudnorm=print_format=json` 的 `input_tp`（两位小数；ebur128 只给一位）。高于 −1.0 dBTP 时 FAIL；在 −1.5 到 −1.0 之间报 LOOK（满足发布规范，但没达到 mux.sh 的 −1.5 目标）；
  量不出来时 FAIL；没有音轨时 SKIP。阈值和测法照搬 film-narration 的 `mux.sh` / `align.py --verify`；放在这里是因为纯配乐片走不了 `--verify`。

### loop
`loop: true`（写在 critique 块或 film.json）时，判定口径与 film-core seamcheck 一致：
- 3a：frame(D) 与 frame(0) 一致（180px 缩略图下像素差少于 4 个）。循环片的 t=D 就是下一圈的 t=0。
- 3b：跨接缝的跳变 diff(frame(lastT), frame(0)) 不超过相邻帧典型差的 4 倍（典型差取均匀分布的 8 对相邻帧差值的中位数）。

"末帧与首帧逐字节相同"是错误的口径：正确的循环片里，这两帧本来就应该相差一帧的运动量。完整的确定性门（包括全新页面重载）是 film-core 的 seamcheck。

### readability.*：360px 可读性
探针通过 film-core `openScene` 的 `initScripts` 在场景的任何脚本之前注入，包装 `fillText/strokeText`，记录字号乘以当前变换缩放和 CSS 缩放后的值、字重、颜色，以及绘制前包围盒内的底色，
再按 `360 / 画幅宽` 折算成手机上的有效 px。DOM 文本读取 computed font-size / weight。

**文种**：一段文字按字符的多数派归类（不计标点和空白），分为 cjk / latin / symbol（溶解过程中的乱码算 symbol，不按中文阈值衡量）。

**字号阈值按文种和字重分档**（来源：film-typography「可读性下限」，把 1080 宽缩到 360 宽后数笔画段数）：

| 档 | 原生 px（1080 宽） | 有效 px（默认值） |
|---|---|---|
| latin | 26 | 8.7 |
| latin_bold（≥600） | 30 | 10.0 |
| cjk_100 … cjk_900 | 80 / 52 / 52 / 56 / **72** / 74 / 88 / 84 / 92 | 26.7 / 17.3 / 17.3 / 18.7 / **24.0** / 24.7 / 29.3 / 28.0 / 30.7 |
| cjk（查不到字重时） / cjk_bold（≥600） | 56 / 88 | 18.7 / 29.3 |
| symbol | — | 不检查（乱码、方块字符不存在阅读问题） |

查找顺序：先找 `<文种>_<字重>`（字重取整到百位）；找不到时，字重 ≥600 的再找 `<文种>_bold`；最后找 `<文种>`。
观看宽度默认 360，横版片同样按 360 判定（信息流里的横版片以手机宽度内嵌播放，要保证这种最坏情况也看得清）；以横屏全屏观看为主的片子写 `view_width`（如 720），有效 px 按新宽度折算。
阈值可以写 `min_text_src_px`（原生 px，按 360/宽 换算）或 `min_text_px`（有效 px）；写成对象时按档给值，写单个数字表示所有文种用同一个阈值。
`min_text_px` 里出现大于 24 的值时报 `style_guide.units` LOOK（有效 24px 约等于原生 72px，这种情况几乎一定是单位写错了）。

- `size`：低于本档阈值时 FAIL；本档阈值为 null 时报 LOOK。
- `contrast`：文字完全显现（alpha>0.9）时，WCAG 对比度低于阈值即 FAIL。报告这段文字全片**最差**的对比度，时刻和证据帧也取最差的那一帧（字号同理，取最小的那一帧）。
  渐显过程中的低对比度不计。film-typography 的结论是，在下限字号附近 4.5:1 不够（细笔画会被抹灰）；脚本仍按 WCAG 口径判定，不替本片加严。
- `time`：完全显现的时长小于 max(0.5s, 字数 / read_cps) 时报 LOOK。`read_cps` 默认 9 字/秒（Netflix 简体中文字幕的成人阅读速度上限）。

**合并**：同一项、同一文种、同一字重、同一字号档（0.5px）的发现合并成一条，附带前 5 个样例、×N 和时间区间，checks.json 中每条带 `count`；
`time` 项里的单字（逐帧换字的乱码带、逐字绘制的底纹）不区分文种，合成一组，报告为"持续变化的文字区"。每组的代表条目取组里最差的一段。

探针截不到的情况：文字预渲染成位图、Path2D 或 WebGL 纹理时探针看不见，结果为 SKIP，只能由人查看 phone.png（三维场景里的文字用 `legible`）。

### facts.screen：画面数字对账
从旁白文本和画面文字里抽取数字：包括阿拉伯数字；含"十百千万亿"的中文数词按位值换算，不含这些字且有 3 位以上的按逐位读法换算（六一八即 618）；"一点""一滴"不算数字。
每个数字的**数值**都必须能在 `docs/facts.md` 全文中找到（facts.md 按同样规则抽取后比较数值），找不到时 FAIL；有数字却没有 facts.md 时也 FAIL。

**这是一道宽松的筛查**：只比较数值、不识别单位（"22 辆"会命中"22 米"），所以 FAIL 可靠，PASS 只说明"这个数在 facts.md 里出现过"。严格对账（数值、单位、事实状态、来源）归 film-story 的 `factcheck.mjs`（即 checks 里的 `facts.script`），它只读 script.json；
本脚本会把画面文字写进 `out/critique/onscreen.txt`，再运行 `factcheck.mjs --film <slug> --also out/critique/onscreen.txt` 补上画面这一半。两者结论不同时以 factcheck 为准。

**对账以"一段话"为单位**：在同一采样帧里，满足以下条件的几笔文字拼成一段：同一画布、同一 `textBaseline`、基线方向一致且垂直偏差 ≤0.15 em、后一笔的起点在前一笔墨水右端之后 −0.3…+0.6 个 em 以内（em 按较小的字号计）。
同一个字在同一位置画两遍（描边加填充、投影层）只算一笔；两侧都是字母或数字且间隙 ≥0.15 em 时补一个空格。可读性检查仍按单笔计量。DOM 文字以一个文本节点为一段。
拼段之后仍然孤立的单个数字看 `facts_single`：值为 `"check"` 时参与对账；值为其他字符串时 SKIP 并原样写出理由；没有声明时报 LOOK `facts.single`，列出是哪些数、出现在哪一刻。
装饰性数字用 `facts_ignore` 排除（正则，按整段匹配，对单个数字同样生效）。**只核对数字，不核对语义**（"唐朝 618 年灭亡"这种错误要靠人看）。

### law.<id> 带 pixels（本片法律）
在 `[from + grace, to]` 窗口内的每个采样帧（`--sample-fps`）上，按原生分辨率计算像素统计量，任一帧高于 `max` 或低于 `min` 时 FAIL，并附证据帧。
规格与 shotlist 中 `source: pixels` 的格式相同：`{near:"#rrggbb", tol}` 或 `{r:[lo,hi], g, b}`，`stat` 只能是 count / cx / cy，region 可选。
**前提是颜色签名唯一**：这个颜色在本片里只属于那一个元素（例如 demo-tls 的强调色只用于中轴线和相遇点，所以"线退场了"就等于强调色像素归零）。

### law.<id> 带 occlude / inframe（本片法律，空间锚点）
实现在 `scripts/_anchors.mjs`。时间窗口与 pixels 法律相同，但改为**逐帧**判定（`--claim-fps`，默认取成片 fps；锚点只需要 draw、不截图，所以不会漏掉 0.07s 级别的出画）。
每条法律都把锚点表按顺序取一遍、再倒序取一遍进行比对，结果不一致时该法律 FAIL（判定不可信）。
- **occlude**：`anchors` 里的每个关键锚点与 `against` 里的每个遮挡物计算有符号间距（遮挡物写 `"text"` 时，指同一次绘制中 fillText 拦截到的文字框加上可见的 DOM 文字；其他值指锚点名），间距减去 `pad` 后 ≤ 0 即判为相交。
  报告相交的帧数、最深的重叠量（原生 px）和证据帧（红框为关键锚点，黄色虚线为遮挡物）；PASS 时报告最近间距。比较前先把两边的框裁到画面 [0,1]² 以内（出画的部分不算压字）。
  关键锚点在某一帧没有登记时 FAIL；只对 `"text"` 判定、而窗口里一段文字都没截到时也 FAIL（没有可比较的对象）。
- **inframe**：主体锚点的框（不裁剪）与安全区（四边内缩 `safe`）的交集面积除以框面积，小于 `min` 时 FAIL，报告越界方向、越界像素数和证据帧。主体锚点在某一帧没有登记时 FAIL。
- 文字框是探针按 ctx 当前变换映射得到的 `measureText` ink 框（不含描边宽度和阴影），再按 canvas 在页面上的位置归一化到视口；只统计挂在文档里的 canvas。
  锚点则按 `createAnchors(canvas)` 的 canvas 归一化，**两者一致的前提是舞台 canvas 铺满画面**。字幕底条这类围绕文字的 UI，要由场景自己登记成锚点并写进 `against`。

### claims.*：分镜断言的画面实测
1. 运行 `python3 <film-story>/scripts/check_shotlist.py --film <dir> --plan`（通过 `capability('film-story')` 定位），拿到每条断言解析后的区间、曲线来源和像素规格。
2. 在区间里按 `--claim-fps`（默认成片 fps）逐帧取值：
   - `source: scene`（或者是 `curve`，但 probe 恰好返回了同名键）：用一次 `evaluate` 按顺序取完所有帧，再倒序取一遍比对（不一致时 `probe.pure` FAIL）。
   - `source: pixels`：逐帧截图（与 10fps 采样重合的帧直接复用），按原生分辨率计算统计量。`motion` 与**前一帧**比较（如果固定参照帧本身在动，就测不出静止）。
   - `source: anchor`：通过 `window.anchors(t)` 逐帧取锚点的 `cx`/`cy`/`w`/`h`，顺序、倒序各取一遍比对（不一致时 `anchors.pure` FAIL）；某一帧没有登记时值为 null，判为"无值"。
3. 采样结果写进 `out/critique/claims-samples.json`，交给 `check_shotlist.py --verdict` 判定：**判定语义只有一份**（共用同一个 `eval_claim`）。
   对 `source: scene` 的"无值"，本脚本会把提示语改写成 probe 的说法，并附上那一帧 probe 的实际值（判定结果不变）。
4. 交叉检查：check_shotlist 算出的片头留白与本脚本使用的不同时，`claims.offset` FAIL；shotlist 用了锚点 `end` 且与 DURATION 不同（相差超过 1 帧）时，`claims.end` FAIL。
5. rising/falling 通过了，但区间开头和结尾各 ≥20% 时长内的值都没有变化时，报 `claims.trend` LOOK（只比较端点时看不出这种平台）。
6. 断言用的全是手写固定值的曲线，而片子带有 film-physics 运行时，报 `claims.source` LOOK。

代价：probe 逐帧取值几乎没有开销（ghost-jam 708 帧耗时 0.02s），像素断言约 0.23s/帧，只在断言区间里采样；`--claim-fps` 可以降低帧率，代价是 10fps 会漏掉 0.07s 级别的全灭。

### tilt.ortho：斜看的平面是不是正交投影（疑点）
扫描实现在 film-motion 的 `scripts/lib/tiltscan.mjs`（独立工具为 `scripts/tiltcheck.mjs`），通过 `capability('film-motion')` 接入。在主采样的约 4fps 子集上，
按变换矩阵分组，记录 seek 期间的屏幕外包框；某一组面积 ≥ 画布的 10% 且奇异值比 < 0.9 时报 LOOK，证据帧取面积最大的那一刻。
**这一项只能是 LOOK**：斜放正方形的正交投影与正俯视的长方形逐像素相同，挤压、拉伸和等轴测也都是正当的非等比变换。有意如此时写 `"ortho_ok": "<理由>"`（转为 PASS 并原样写出理由）。
检测不到的情况：在着色器里压扁、加载时预渲染进离屏 canvas、CSS transform。

### continuity / rhythm：衔接度与节奏（可选疑点）
实现在 `scripts/_flow.mjs`，声明了才运行，只报 LOOK。判据借鉴自 onetake。

**continuity** 读取 `window.anchors(t)`，按主采样帧率逐帧取值（只 draw、不截图）：
- 每帧中每个锚点的权重等于画面内可见面积乘以锚点 meta 的 `alpha` / `opacity`（没有就按 1 计）。对相隔 0.4s 的两帧计算加权 Jaccard（Σmin / Σmax，按名字配对），
  值 < 0.2 的连续区间算作一次**交接**；如果中途出现一个锚点都没有的空档且不超过 1.5s，前后两段接成同一次交接。
- 判定交接两端：共有元素位移 ≥ 对角线的 2%，或 |ln 线性尺度变化| ≥ 0.1，记为 **carried**；只有面积 ≥ 3% 且原样不动的元素延续下来，记为 **anchored**；两者都没有，记为 **bare**。
- 以下交接不计分：1.5s 内出现 ≥ 3 个硬切的快切连击、起点落在片尾 1.2s 以内的、窗口里有声明切点（`cuts`）的、片头从空画面淡入的。
- `score = (carried + anchored/2) / 计分交接数`。分数 < 0.5 和 < 0.7 分两档报 LOOK，≥ 0.7 为 PASS；报告列出每个 bare 交接的时刻和前后的元素名，明细写进 checks.json 的 `handoffs`。
- 前提是**锚点按物件命名**：按类别登记的片子（整盘棋子都叫「棋面」）J 值会一直很高，结果是"没有可计分的交接"（SKIP），这表示量不出来，而不是衔接得好。
  低分只意味着"值得看一眼"（拼贴、快切、章节断开都是正当的 bare）。希望某处交接有元素延续过去，就在 shotlist 的镜头上写 `carry`（film-story）。

**rhythm**：
- `rhythm.cv`：镜头长度的来源按优先级依次为 `rhythm.cuts` 声明的切点、shotlist.md 的时间表（「起/止」列）、`window.MARKS` 的起点（事件不等于镜头，报告中会写明来源）。不足 3 个镜头时 SKIP。变异系数 < 0.25 时报 LOOK「像节拍器」。
- `rhythm.still`：静止判定与 `still` 共用同一份结果。静止帧占比 < 25%，或者没有 ≥ 1s 的静止段时，报 LOOK「没有呼吸」。
- 代价与何时值得：等长镜头让观众能预判下一次剪切，教学步骤、卡拍配乐要的正是这种效果；画面一直在动会让观众没有空档消化内容，而高密度、快节奏的片子可能正需要这样。

### motion / variety / beatsync / hook / mute：运动读数（可选疑点）
实现在 `scripts/_kinetics.mjs`，声明了才运行，只报 LOOK / PASS / SKIP。模型看不见运动，这几项把运动量成数字、把证据条拼出来给人看；**它们不判断好不好**，读数含义和代价写在报告里，是不是本意由本片 style_guide 决定。
所有阈值都是"报疑点的起点"，在 checks 里写成对象修改：`{ "motion": { "jerk": 0.7, "regions": 8 } }`。读数整体写进 checks.json 的 `kinetics`（两次渲染之间可以直接比较）。

**共用的量**（都在主采样上算，声明了任一项才多算）：
- **能量**：相邻两个采样帧在 180px 缩略亮度图上的平均绝对差（0–255）。对平移的实心物体，能量正比于速度 × 边缘长度 × 反差，所以它是速度的代理，不是速度：淡入淡出、变色、出现消失都有能量，同速的两个物体大的那个能量高。逐元素的真实轨迹用 film-story 的 `motionprint.mjs --film`。
- **静止阈值**：全片能量的 10% 分位数（噪声底）加上 max(0.01, 4% × (98% 分位数 − 噪声底))；`rest` 参数直接给绝对值。
- **前景**：90px 宽 RGB 缩略图上与背景色（出现最多的量化色）相差 > 28 的像素，膨胀一格后找 8 邻接连通块，小于画面 0.05% 的块不计。纯色、近纯色底上准；渐变底、照片底、满屏纹理会把背景算进前景。
- **切点**：checks 参数 `cuts`（数组，写法同 continuity）> `window.CUT_WINDOWS` / `window.CUTS` > MARKS 首尾相接处（推测）> 能量尖峰（推测：≥ 10/255、≥ 中位 ×6、≥ 两侧 2 倍）。切点前后一帧内的整屏变化不算起停。报告写明用的是哪个来源。

**motion**
- `motion.jerk`：每段"从静到动 / 从动到静"的边界，在成片帧格上细取 0.45s（成片 fps），算起停那两帧的帧差与这 0.45s 内最大帧差之比。≥ `jerk`（0.5）报 LOOK，拼 5 帧证据条（`evidence-motion-jerk-<t>s.png`，橙框是第一帧在动 / 最后一帧在动）。
  来历：线性缓动从静止直接到全速，比值 ≈ 1（夹具实测 1.00）；cubic.inOut 1.5s 实测 0.18–0.27，0.3s 约 0.19。expo.out 的起步、弹出、急停本身就是速度不连续，也会被报出来，是不是本意由人判断。
- `motion.step`：起停那一帧的帧差是孤立尖峰（相邻一帧 < 它的 35%），即东西瞬间出现、消失或换字，只计数，不算突变（字幕弹出实测 7.15 → 0.34，线性起步 1.21 → 1.82）。只占一个采样的瞬变同样只计数。
- `motion.regions`：在动的前景块数（块内 ≥ 2 个像素在相邻采样间变化）。连续 ≥ 2 个采样有 ≥ `regions`（5）块同时在动时报 LOOK，并在最满的那一帧上画出青框（`evidence-motion-regions-<t>s.png`）。来历：多目标追踪的容量约 4 个（Pylyshyn & Storm 1988）。读数包括块数分布、中位数、p90、运动面积。
- `motion.uniform`：运动段里能量保持在 ±`uniform_tol`（12%）内、持续 ≥ `uniform_min`（1.0s）的段落算匀速；匀速段占运动时间 ≥ `uniform_share`（30%）时报 LOOK。恒速读起来像机械，传送带、滚动字幕、恒速旋转要的正是这种效果。
- `motion`：整片读数（静止帧占比与 still 同一判定、在动占比、能量中位 / p90 / 峰值及时刻、整条能量曲线 `kinetics.motion.series`）。
- 参数：`jerk` `regions` `uniform_tol` `uniform_min` `uniform_share` `rest` `cuts` `max_points`（细取的起停点上限，默认 40，超出的记 `skipped`）。

**variety**：按切点分镜头，每个镜头取中段 70% 里能量最低的一帧作代表，量前景包围盒的线性尺度（景别的代理）、前景重心、填充率、64 格主色直方图；与一串镜头的第一个比，`features` 里的每项都在阈值内（尺度 < 1.25×、重心 < 0.08、填充 < 1.3×，颜色 < 0.3 要写进 `features` 才比），镜头内也没有推拉横移（同样的阈值），就算"几乎相同"。连续 ≥ `run`（4）个这样的镜头报 LOOK，拼出这些镜头的代表帧（`evidence-variety-<t>s.png`）。
来历：景别跳一档约是 1.5× 线性尺度，1.25 只抓明显没变的；其余几个数是起点，夹具上同构图的读数是 1.00× / 0 / 1.00×，换构图的相邻镜头最小 1.27× / 0.25 / 1.61×。不足 `run` 个镜头时 SKIP。切点来源是推测时，只有它确实是镜头分段，读数才成立。默认不比颜色，所以"同一构图只换颜色和文字"会被报出来。

**beatsync**：拍点依次从 `file` 参数、`out/beats.json`、`out/music.json`、`music.json`、`beats.json` 读（字段见 film-narration `references/schemas.md`），默认 `grid: "beats"`，可改 `downbeats` / `hits`；`offset` 是加到拍点上的秒数（拍点文件按音乐文件计时、音乐不从 0 秒开始时用）。都没有时 SKIP。
事件是声明的切点、MARKS 起点、运动起步（每段"从静到动"在成片帧格上细取到第一帧在动，分辨率 1/fps）。读数为偏差（事件 − 最近拍点）的带符号中位数、绝对值中位数、±`tol` 内的占比，每个事件一行写进 checks.json。
"每个事件都卡拍"不是目标，只报两类离群：**整体偏移**（≥ 3 个事件且带符号中位数的绝对值 > `tol`，多半是时间轴整体错位）；**差一点卡上**（`tol` < |偏差| ≤ `near` × 拍间隔，而且本片 ≥ 50% 的事件在 `tol` 内）。证据图每行是"拍点那一帧 / 事件前一帧 / 事件第一帧"。
`tol` 默认 0.1s，取 ITU-R BT.1359 视听不同步可察觉阈（约 +45 / −125ms）之间；`near` 默认 0.4，落在半拍附近的事件算切分，不算差一点。缓入的起步要走一段才看得出来，测到的起步会晚于设计时刻（缓得越慢晚得越多），读成"晚"之前先看证据图。

**hook**：开头 `seconds`（3）秒里，第一个有内容的采样在几秒（内容量口径同 empty.vo / cover）、有几个采样在变、边缘量和前景填充从 0 秒到峰值的增长、有没有截到文字；拼 0 / N/6 / N/3 / 2N/3 / N 五帧（默认 0 / 0.5 / 1 / 2 / 3 秒，`evidence-hook-<N>s.png`）。
空画面持续 ≥ `empty_max`（1.0s）或这 N 秒里一帧都没变时报 LOOK。首帧是不是空的归 `cover.empty`，这里只量"空多久"。来历：短视频平台以"前 3 秒"作为完播的第一道筛；1.0s 给从黑场淡入的开场留出余地。有意的黑场开场在 MARKS 上写 hold。

**mute**：旁白在说的采样里，探针没截到任何文字（canvas fillText / DOM 文本）、画面也没变（与 still 同一判定）的占比。占旁白时间 ≥ `share`（25%）或连续 ≥ `run`（2.0s）时报 LOOK，证据帧取最长那段的第一帧。
与 `empty.vo` 不重复：empty.vo 只抓"画面已空"，这里抓"画面不空，但关掉声音得不到新东西"。没有 narration.json 时 SKIP。

**代价**（16 核机器，默认 `--sample-fps 10`、8 个页面）：15 秒 1920×1080 合成片只声明 `page` 时整次运行 2.0–2.3s，五项全开 3.5–4.0s；ghost-jam（23.6s）7.3s → 13.6s，demo-tls（10.9s）7.4s。主采样多出来的 RGB 缩略图和逐帧分割几乎不增加耗时，增量几乎都在 motion 的细取上（每个起停点约 14 次成片帧截图），所以起停点越多越慢，`max_points` 封顶。`--sample-fps 5` 让主采样减半，细取的成本不变，而且尖峰推测的切点会变（ghost-jam 实测 variety 由 4 个镜头变成不足 4 个而 SKIP）。

**已知误报 / 漏报**：
- 误报：文字流、粒子、群体每一行 / 每一颗都算一个运动区域（demo-tls 的 HTTP 头文字流中位 24 块）；满屏噪声或颗粒让能量一直高于静止阈值，起停一个都量不到；渐变底和照片底上前景分割失真，variety 的尺度读数随之失真。
- 漏报：两个物体间距小于约 40px@1920（膨胀一格）会并成一块；运动重叠时，后一个动作的起步不在"从静到动"的边界上，jerk 不判；慢于静止阈值的运动、成片帧格上逐帧差都在阈值内的起停记为"没量到"；预渲染进位图、路径或 WebGL 的字，mute 看不见。

### legible / legible.pure：三维里的字读不读得出（要片子给阈值）
fillText 拦截看不到贴图平面和 TextGeometry 里的文字，而这些文字恰恰最容易读不出来（投影后字高 ≈ 字高 × sin(夹角) / 距离，还会沿基线被挤扁）。
场景用 film-webfx 的 `S.legible` 在渲染后自行测量（使用渲染时的同一组矩阵），这里只读取测量表，按本片阈值判定：
- **取样**：对 `window.legible.windows()` 给出的每个阅读窗，按成片 fps 逐帧（可用 `--claim-fps` 修改）取 `window.legible(t)`；每个分片按顺序和倒序各取一遍，JSON 不同时 `legible.pure` FAIL，其余项不再判定。
- **测量内容**：`em` 是一个 em 方块投影后的高度（原生像素，取文字框各取样点中的最小值）；`squash` 是该方块投影雅可比矩阵的奇异值比 σmin/σmax（1 表示没有变形，对画面内的旋转不变）；`aspect` 只用于在报告里说明方向。
- **判定**：窗口内某一帧 `em < min_px` 或 `squash < min_squash` 时记为不合格帧，出现不合格帧即 FAIL（报告字高最小或最扁的那一帧，并附截图）；全部通过则 PASS，并报告取值范围。
  `visible=false` 或透明度 < 0.05 的帧不计入；整个窗口一帧都没量到时 FAIL。声明了阈值但场景没有提供 `window.legible` 时 FAIL。
- **阈值由本片自己定**：`min_px` 的单位是原生像素（与 `min_text_src_px` 相同）；film-typography 的 2D 正面文字下限可以作为起点，三维场景里通常还要再留余量（贴图采样发糊、景深、运动）。
- **盲区**：测量的是几何而不是像素，文字被遮挡、景深模糊、mipmap 模糊或对比度不够时，em 照样达标；`em` 由场景登记时给出，写大了会放过小字。

### law.palette（本片法律）
每秒抽一帧，逐像素计算该像素到"色板中任意两色连线"的最近 RGB 距离（用连线是为了覆盖抗锯齿和半透明混合）。距离 > `palette_tol` 的像素占比 > `palette_max` 时 FAIL。
局限：色板外的颜色如果恰好落在两个色板色的连线上（例如墨与纸之间的灰），不会被抓到。

### still / law.max_still：静止
用参照帧比较：把当前帧与"上次发生变化时的帧"比较，180px 缩略图上有 ≥4 个像素的亮度差 > 8/255 才算在动（慢速漂移累积到可见程度也算动）。
连续不动的时长 ≥ `max_still` 时，本片声明了该项就 FAIL；没有声明时，≥1.0s 就报 LOOK，并注明这段时间旁白是否在说话。

### empty.vo：空画面配旁白
帧的"内容量"等于缩略图上亮度梯度 > 20 的像素占比（不受渐变背景和纸纹干扰）。内容量 < `empty_edge`（0.1%）且这段时间被某句旁白的区间覆盖时，报 LOOK 并列出那句旁白。
这一项只能抓到矛盾的**下限**：它知道画面空了，但不知道文案在说什么。

### cover.empty：封面帧
首帧 t=0 的内容量（口径同 empty.vo）< `empty_edge` 时报 LOOK。t=0 是播放器的默认缩略图，也是信息流静音自动播放时观众的第一眼；从黑场淡入是正当的开场方式，所以这一项只是疑点。

### hold：故意保留（MARKS 的 `hold`）
疑点的处理只有两种：**修掉，或者故意保留并写明理由**。保留的写法是在 MARKS 上标注：`{ label, start, end, hold: "定格留给旁白念完结论" }`。
- 起止时刻都落在某个 hold 区间内（容差为一个采样间隔）的 LOOK 改记为 **HOLD**：不计入 LOOK，`--strict` 也不拦截；review_log 的「故意保留」一节会原样抄录区间名和理由，交付说明可以从那里摘抄。
- 只豁免 LOOK。FAIL 代表客观不变量或本片自己写的法律被破坏，标记不能豁免（要改就去改法律）。
- `hold` 的值不是非空字符串时（如 `hold: true`）报 `mark.hold` FAIL，这一段不作保留。这一项不受 `checks` 开关控制，只在有人写了 hold 时出现。

与 HyperFrames `check` 中同类项的对照（它的阈值与本套件不同，以本表为准）：`first_frame_empty` 对应 `cover.empty`；`dead_stretch`（>3 s 无变化）对应 `still` / `law.max_still`（默认 1.0 s 起报）；
`line_unread`（停留 < 0.5 s + 0.3 s/词）对应 `readability.time`（< max(0.5 s, 字数 / read_cps)）。

### mark.*：承重事件
- `length`：`load:true` 的关键事件时长 < max(0.5s, text 字数 / read_cps) 时 FAIL。0.5s 是一次注视（200–300ms）加上注意力转移的保守下限。
- `visible`：比较起点前一帧与区间内的画面，区间内按成片帧栅格最多取 24 帧（总会包含中点），一旦有一帧差异达到 4 个像素就停止；全都没有差别时 FAIL（说明声明了但没画出来，或者画面被冻住了）。
- `sync`：有 `word` 时，事件起点与该词念到的时刻相差 > `sync_tol`（默认 0.2s）则 FAIL。查词时直接 import film-narration `assets/runtime/narration.js` 的
  `makeNarration().at(word, nth)`（与场景里 `vo.at()` 的结论一致），查不到时原样转出它的报错。词出现多次时按以下优先级选择：`nth`，其次是 `line`（这句里离事件最近的那次），最后是全片离事件最近的那次；
  说明里会写明取的是第几次，要固定取某一次就写 `line` 或 `nth`。参考 ITU-R BT.1359（可察觉约 +45/−125ms，可接受约 +90/−185ms）；事件对词不是口型同步，所以取 0.2s，需要更严时在 critique 块里修改。

### page.errors
页面出现任何 pageerror 或 console.error 时 FAIL。

## 5. 不归本 skill 的两条门

- 确定性、全新页面重载、乱序求值、循环接缝：由 film-core 的 `seamcheck.mjs` 负责（内核门，始终开启）。本 skill 的测量都是在同一个页面内重复求值，**加载期发生的违约在这里查不出来**。
- 成片音轨重新转写比对（匹配率 < 97% 时非 0 退出）：由 film-narration 的 `align.py --verify` 负责。

这两项都会在 check.mjs 的输出里列为 TODO，review_log 里要写上它们的实际结果。
