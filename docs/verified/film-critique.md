# film-critique · VERIFIED

日期 2026-10-21。macOS Darwin 25 / Node 22.17 / Playwright Chromium / ffmpeg。
测试片 `tests/fixtures/_test-critique/`（保留）：9:16 1080×1920，60fps，4.5s，loop。
运行时 `runtime/motion.js` `layout.js` 拷自仓库根 `lib/`（按任务要求）。
`narration.json` 是**手写**的时间轴（没跑 TTS，没有 `wav` 字段）。

两个入口共用一份代码：
- `scene.html` 正常版
- `scene-bad.html` 缺陷变体：在前面插一个 `window.VARIANT`，故意做坏六处
  （画面 3.5s 短于旁白 3.9s / 0.9–2.9s 冻住 = 2 秒死拍 / 承重事件「盖印」只占 3 帧 /
  3.32s 起清空而旁白还在说 / 画面写「三百坊」而 facts.md 只有 108 /
  色板外的蓝块 + 20px 小字）

## 0. 与 film-motion 共用截帧

`scripts/_film.mjs` 是薄适配层：`resolveFilm` 用 `../../film-motion/scripts/lib/film.mjs`，
`openScene` 用 `../../film-motion/scripts/lib/scene.mjs`（WAAPI 冻结只在那一处），
画幅表用 `../../film-motion/assets/runtime/layout.js`。切换后下面第 1、3 节全部重跑，结果与切换前一致
（正常版 FAIL 0；缺陷版 FAIL 10 LOOK 1）。为此测试片 film.json 补了 `"schema": 1`（film-motion 的校验要求）。

fillText 探针改走 film-motion 新加的 `openScene(..., { initScripts })`，在场景任何脚本之前注入
（不再在加载后打 prototype），场景加载期缓存的 `ctx.fillText` 引用也被包住。

循环口径按 film-motion 实测改成 3a frame(D)≈frame(0) + 3b 跨缝跳变 ≤ 4×相邻帧典型差。

## 1. 静帧闸门

```
node skills/film-critique/scripts/stills.mjs --film _test-critique --at 0.4,1.2,2.6,3.5,4.3
✓ tests/fixtures/_test-critique/out/stills.png   5 张 / 5×1
node skills/film-critique/scripts/stills.mjs --film _test-critique --entry scene-bad.html --label stills-bad --at 0.4,1.2,2.6,3.27,3.45
✓ tests/fixtures/_test-critique/out/stills-bad.png   5 张 / 5×1
```

**用 Read 看了，图上实际看到的：**

- `stills.png`：0.4s 黑方块在上方、「618」「长安」半透明灰；1.2s 文字全黑；
  2.6s 下方坊线铺了一半（横线长短不一、竖线从上往下长）；3.5s 网格完整，黑方块右下多了一个朱砂方块；
  4.3s 收尾——横线收向中轴、竖线只缩短不移位，留下一排孤立的短竖条，文字变浅。
  另外 1.2s 和 2.6s 两格上半部完全相同。
- `stills-bad.png`：每格左上角都有一个蓝块和一行很小的「注：示意」（360px 下几乎读不出）；
  3.27s 网格下写「三百坊」，黑方块右下只有**一个红色像素点**——3 帧的「盖印」在静帧上就是这样；
  3.45s 整格空白纸。

**闸门自身的问题，看图才发现的**：第一版把时间戳盒压在每格左上角，正好盖住了缺陷变体里的蓝块和小字。
改成每格下方单独一条边条（`stills.mjs`），重拍后左上角内容完整可见。
同时修了原版补位格高度估算（`428 * Math.round(h/w)`：9:16 时比真格高约 100px）。

## 2. 成片对照图

```
node skills/film-motion/scripts/render.mjs --film _test-critique --fps 30 --sub 1
✓ tests/fixtures/_test-critique/out/silent-9x16.mp4   135 帧   9.5s   ffprobe: 1080,1920,30/1,135
bash skills/film-critique/scripts/contact.sh tests/fixtures/_test-critique/out/silent-9x16.mp4
源: ...silent-9x16.mp4   时长 4.500000s   接触表 6x5 @ 6.6667fps
产出：contact.png 113K / loop.mp4 140K / phone.png 34K / poster.png 40K / strip.png 17K
```

**看到的：**
- `contact.png` 6×5：第 1 行墨块下落、文字渐显；**第 2 行六格完全相同**（约 1.0–2.0s 平台期，
  低于本片 max_still=1.5s 所以脚本没报，但图上一眼可见）；第 3 行坊线逐条长出；第 4 行朱砂出现；
  第 5 行收尾，倒数第 2、3 格是"| | ‡ | |"状的断栅栏——没有被设计过的中间态（T6）。
- `strip.png`：默认起点 35%=1.575s，**12 帧全同**，正好落在平台期，这张图对本片没有信息量。
  这是 contact.sh 默认起点的真实缺陷，SKILL.md 已写明要按 checks.json timeline 手选起点（没自动化）。

维护注意：contact.sh 里 `awk printf` 结尾的 `\n` 不能删——没有它 `read` 在 EOF 返回非 0，`set -e` 直接杀脚本。

## 3. 客观检查能抓到问题

正常版：

```
$ node skills/film-critique/scripts/check.mjs --film _test-critique
采样 45 帧 @ 10fps（1080×1920，时长 4.5s）..... 完成
== 客观 ==
  TODO  determinism            确定性门（同 t 重复 / 全新页面重载 / 乱序 / 循环）：参见 film-motion 的 seamcheck.mjs。…
  PASS  duration.narration     旁白 0.30s–3.90s 落在画面 0–4.50s 内（片尾留白 0.60s，offset 0s）
  PASS  loop                   frame(D)≈frame(0)（差 0），跨缝跳变 0 ≤ 4×典型相邻差 20.5
  PASS  readability            3 段文字：360px 宽最小 16.3px，对比度均达标
  PASS  facts                  4 个数字都能在 facts.md 找到：六一八、一百零八、618
  PASS  mark.sync              事件「坊线铺开」与词「一百零八」差 0.000s
  PASS  mark.sync              事件「盖印」与词「朱」差 0.000s
  PASS  marks                  3 个事件：时长、可见性、对点都过
== 本片法律 ==
  HUMAN law.no-curve           不出现曲线运动（怎么看：…）
  HUMAN law.cinnabar-once      朱砂只出现一次，用在印上（怎么看：…）
  PASS  law.palette            每秒抽 1 帧，色板外像素都 ≤ 0.5%
FAIL 0  LOOK 0  HUMAN 2        exit=0   用时约 4s
```

缺陷变体（六处缺陷全部抓到，exit=1）：

```
$ node skills/film-critique/scripts/check.mjs --film _test-critique --entry scene-bad.html
采样 35 帧 @ 10fps（1080×1920，时长 3.5s）.... 完成
== 客观 ==
  FAIL  duration.film          film.json duration=4.5s 与场景 DURATION=3.5s 不符
  FAIL  duration.narration     旁白在 3.90s 才结束，画面 3.50s 就完了：最后 0.40s 旁白被截掉
  FAIL  loop                   本片要求循环，但 frame(D=3.50s) 与 frame(0) 不同（180px 缩略下 685 个像素差 >8/255）
  FAIL  readability.size       「注：示意」在 360px 宽时只有 6.7px（阈值 12px）
  FAIL  facts                  facts.md 里找不到出处的数字：三百（=300，画面）
  FAIL  mark.visible           事件「坊线铺开」2.00s–2.90s 起点前一帧与区间中点画面相同：声明了但没画出来
  FAIL  mark.length            承重事件「盖印」只占 0.05s（3 帧 @60fps），阈值 0.50s：观众看不见它
  FAIL  mark.visible           事件「盖印」3.25s–3.30s 起点前一帧与区间中点画面相同：声明了但没画出来
  PASS  mark.sync              ×2
== 本片法律 ==
  FAIL  law.palette            出现色板外颜色：4 个采样秒超标，最严重 0.00s 占 1.15% 像素
  FAIL  law.max_still          0.90s–2.90s 画面完全静止 2.00s（期间旁白 s1/s2 在说），超过本片声明的 max_still=1.5s
  HUMAN law.no-curve / law.cinnabar-once
== 疑点 ==
  LOOK  empty.vo               3.40s–3.50s 画面已空（边缘像素 <0.1%），旁白还在说：s2「一百零八坊铺开，盖上朱印。」2.00s–3.90s。查文案和画面是否矛盾
FAIL 10  LOOK 1  HUMAN 2       exit=1
```

附带结论：
- 「坊线铺开」mark.visible FAIL 不是误报：冻结区间 0.9–2.9s 盖住了它，事件声明了但画面没动。
- 「盖印」mark.visible 也 FAIL：3 帧里弹簧只走了 0.025s，中点只有一个像素（静帧上也只看到一个红点）。
- 第一版 mark.visible 比的是"起点前 vs 终点"，对瞬时事件会误报（终点时事件已消失），改成比中点。
- empty.vo 报的是 3.40s 而不是真实的 3.32s：采样 10fps，时间分辨率 ±0.1s。

成片流对账：

```
$ node skills/film-critique/scripts/check.mjs --film _test-critique --mp4 tests/fixtures/_test-critique/out/silent-9x16.mp4
  FAIL  mp4.fps                MP4 帧率 30，film.json 写 60          ← 真的：迭代渲染用了 --fps 30
  PASS  mp4.duration           MP4 视频流 4.5s（135 帧，应为 270）与场景一致
```
音轨分支（`mp4.av`）**没测**：测试 MP4 无声。

确定性门（film-motion 的，调用不搬）：

```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-critique
  ... ✓ 逐像素一致 / 探针 seek 期间调用的禁用 API：✓ 无 / 全部通过   exit=0
```

接口：从 scratchpad 目录用 `--films-dir` 调用成功；不存在的片子 →
`✗ 找不到 …/films。在仓库根（含 films/ 的目录）下运行，或传 --films-dir`，exit=2。

## 4. review_log

```
node skills/film-critique/scripts/review_log.mjs --film _test-critique --note "缺陷变体…"   # 第 1 轮（先跑了 bad 的 check）
node skills/film-critique/scripts/review_log.mjs --film _test-critique --note "正常版…"     # 第 2 轮
✓ 追加第 N 轮 → tests/fixtures/_test-critique/docs/review_log.md（无人在场，主观项标「未经人眼确认」）
```

`tests/fixtures/_test-critique/docs/review_log.md` 两轮。第 2 轮手工补了"模型描述"（T1 文字全是渐显、
T3 平台期、T6 断栅栏中间态、"墨滴"是锐边方块），全部标"未经人眼确认"，没有任何分数。
模板 `assets/review_log.md` 的头部与 film-production `new-film.mjs` 生成的骨架逐字一致；
骨架的"## 第 1 轮 / 日期 / 客观项 / 本片项 / 最弱三点"是本脚本生成节的子集。
建议脚手架骨架补两行"倾向性提醒："和"人眼："，否则手填时容易漏掉诚实性标注。

## 5. 第二轮：demo-tls 实跑反馈后的修复

协调方用 `films/demo-tls` 跑出三个问题，逐条修并复测：

**(a) `min_text_px` 单一全局值错量文种**。改成按文种/字重分档（`latin` / `latin_bold` / `cjk` / `cjk_bold` / `symbol`，
null = 无稳定下限 → LOOK），新增 `min_text_src_px`（原生 px）；单个数字保持旧行为。
文种取字符多数派。默认值取 film-typography 实测表。另加单位防呆。

demo-tls 原样（style_guide 写的是 `"min_text_px": 26`，按本脚本口径是有效 px）：
```
FAIL readability.size 「G」「E」「T」「i」「n」… ×40 段拉丁文字（0.00s–5.90s）在 360px 宽时 12.3px（原生 37px），阈值 26.0px（all）
FAIL readability.size 「/」「.」「:」「=」「-」… ×26 段符号文字 … 12.3px（原生 37px），阈值 26.0px（all）
FAIL readability.size 「你在看一条公开的线路。」… ×3 段中文文字 … 20.0px（原生 60px），阈值 26.0px（all）
FAIL readability.size 「各自算▛▒▞╱▞钥┿」… ×43 段符号文字 … 20.0px（原生 60px），阈值 26.0px（all）
LOOK style_guide.units min_text_px 的单位是手机有效 px（360 宽）。你写的 26 相当于原生 78px —— … 改用 min_text_src_px
```
即：demo-tls 的 26 本意是原生 px，被当成有效 px，单位防呆把它指了出来。
在 scratchpad 副本里把它改成 `"min_text_src_px": { "latin": 26, "latin_bold": 30, "cjk": 56, "cjk_bold": null }` 后：
```
PASS readability 112 段文字字号与对比度均达标（阈值来源：style_guide min_text_src_px）
FAIL 0  LOOK 2  HUMAN 3
```
（原来是 116 条 FAIL。）`films/demo-tls` 本身没动，style_guide 要它的作者改。

**(b) 逐帧换字刷爆 LOOK**。同项 × 文种 × 字重 × 字号档合并成一条 ×N；`readability.time` 的单字不分文种合成"持续变化的文字区"。
demo-tls：原来 91 条 → 现在 2 条：
```
LOOK readability.time 「G」「E」「T」「/」「i」… ×66 段单字（拉丁/符号）文字（0.00s–10.40s）每个都只短暂出现（最长 0.00s）：像是持续变化的文字区（乱码/逐帧换字/滚动底纹）。若是刻意的可忽略；…
LOOK readability.time 「各自算▛▒▞╱▞钥┿」「╲╲算▒▞╱▞▓┿╲」… ×43 段中文/符号文字（5.60s–9.50s）完全显现约 0.10s，按 9 字/秒读完要 1.11s（若是刻意的闪字可忽略）
```
测试片缺陷变体补了第 7 处缺陷：底部一条每 1/6 秒换字形的乱码带（132 个字形，含 0-3）。合并成一条：
```
LOOK readability.time 「─」「┅」「┊」「┏」「└」… ×59 段单字（符号/拉丁）文字（0.00s–3.30s）每个都只短暂出现（最长 0.30s）：像是持续变化的文字区…
```
乱码带里的单个数字一开始被 facts 当成"无出处的数字 1、3、0、2"报 FAIL——又一个噪声源。
改成单字不参与事实对账（计数报 SKIP `facts.single`），另加 `facts_ignore` 正则。

**(c) mark.sync 与 narration.js 结论相反**。改为直接 import `../../film-narration/assets/runtime/narration.js` 的 `makeNarration`，
用同一个 `vo.at()`。demo-tls 四条 mark 由 FAIL 变成：
```
PASS mark.sync 事件「明文可读」与词「公开」差 0.000s（查找用 film-narration 的 vo.at）
PASS mark.sync 事件「两端交换」与词「交换」差 0.000s …「密钥成立」/「密钥」… 「只剩乱码」/「乱码」…
```
测试片的「盖印」改绑跨 token 的词「朱印」（token 是 `朱` + `印。`），同样 PASS。
测试片 narration.json 补了顶层 `words[]`（makeNarration 要求 film-narration 的标准格式）。

**测试片的连带变化**：style_guide 改用 `min_text_src_px` 分档；按 cjk 18.7 有效 px 的下限，原来的「长安」(54 原生 px)
和「一百零八坊」(48.6) 会 FAIL，scene.html 把两者调到 `L.size(0.055)`≈59px。复测：正常版 FAIL 0（exit 0），
缺陷版 FAIL 10 / LOOK 2（exit 1）。第 1-2 节的静帧和对照图是改字号之前出的（stills 已重出，contact 没有重渲）。
重出的 stills-bad.png 里能看到底部乱码带，且 1.2s 与 2.6s 两格的乱码完全相同——冻结区间在静帧上也看得见。

## 6. 第三轮：分镜断言的画面实测 + 像素法律 + 字重查表（ghost-jam / demo-tls 反馈）

### 6a. claims.*：window.probe 与像素逐帧验 shotlist 断言

背景与设计见 film-storyboard VERIFIED.md C1。这里只记 check.mjs 这一侧的实测。回归用例在 `<scratchpad>/films/gj-*`
（ghost-jam 的拷贝，原件 scene/docs/script 没动；生成脚本 `<scratchpad>/probe-reg/setup.mjs`）。

```
$ node skills/film-critique/scripts/check.mjs --films-dir <scratchpad>/films --film gj-bug
分镜断言像素实测：6 条，450 帧 @30fps........ 82.6s
  FAIL  claims.scene   音画矛盾 「轻轻慢了一下」[7.16s–8.17s] 灯数 >= 1：t=8.100s 时 灯数=0.000，不满足 >= 1（window.probe逐帧实测 31 帧；…）
  FAIL  claims.scene   音画矛盾 「一辆传一辆（传的时候得有灯）」[8.52s–10.92s] 灯数 >= 1：t=8.533s 时 灯数=0.000 …（72 帧）
  FAIL  claims.pixels  音画矛盾 「一辆传一辆（画面上有红）」[8.52s–10.92s] 红灯像素 > 0：t=8.533s 时 红灯像素=0.000 …
  LOOK  claims.trend   「后面的就慢得更多，一辆传一辆」灯数 rising：rising 只比端点；区间开头 0.90s（占 38%）灯数 一直是 0 没动 …
FAIL 3  LOOK 2  HUMAN 5    exit=1   real 136.44s
gj-orig（阈值 0.8 = films/ghost-jam 现状）：FAIL 2（s4 两条；开头 0.60s 无灯）  exit=1
gj-fix （阈值 0.5）：PASS claims.scene 9 条（650 帧次）  PASS claims.pixels 6 条（1021 帧次）  FAIL 0  exit=0
（6d 接入中文字重表之后再跑，gj-fix 多一条 readability.size FAIL——字幕 600 字重 58px，与断言无关，所以复测 exit=1；claims.* 结论不变）
gj-noprobe（不标 source、不加 probe）：LOOK claims.source 场景带了 film-physics 运行时（baked.js、closed.js、replay.js、sims.js）… exit=0   real 53.04s
```

像素断言的几条附带结论（gj-fix 全过）：
- 相机锁死：`天空变化`（region 上 22%，`motion` = 与前一帧比变了的像素占比）在 s6.start→end 286 帧全为 0。
  这是协调方先用 MP4 量过的结论（相邻帧 0.00%）；他第一次拿 t=13.5s 当固定参照帧，得出"一直在动"（26.7%→41.4%），
  因为参照帧本身在动。所以 `motion` 只和前一帧比，没提供"和某参照帧比"的选项。
- "车往前、堵往后"：红灯质心 x 0.249→0.775（rising），黄车质心 x 0.406→0.080（falling），符号相反。
  这条 style_guide 里原是 HUMAN（jam-backward），现在能以 shotlist 像素断言的形式机读。
- **probe 和像素会分歧**：gj-bug 在 8.100s probe 灯数=0（亮度 >0.5 才算一盏），截帧数到 140 个饱和红像素（绘制从亮度 0.01 起画）。
  s3 那条 probe 断言 FAIL、对应像素断言 PASS——两者回答的问题不同，SKILL.md 写了边界。

纯函数检查（`probe.pure`）：顺序取一遍、倒序取一遍逐帧比 JSON，带 probe 的三份都一致。

### 6a'. probe.pure 的检出能力：先造坏的 probe

`<scratchpad>/probe-reg/leaks.mjs` 从 gj-fix（全绿）拷出变体，只改 scene.html 里的 probe（为省时去掉了像素断言），
另外两份手改（gj-wrong-subtle 基于 gj-orig、gj-seek-broken 基于 gj-fix，都保留像素断言）：

| 变体 | 写坏的方式 | probe.pure | claims.scene | claims.pixels |
|---|---|---|---|---|
| leak-near | \|Δt\|<0.05s 返回上次的值（近似缓存，只在未命中时更新） | **FAIL**（t=0.033s 黄车里程 0 vs 0.550） | 原来报 PASS → 改成 SKIP"不算数" | — |
| leak-back | t 比上次小就返回上次的值（往回跳不重算） | **FAIL**（t=0 灯数 0 vs 9） | 同上 | — |
| leak-integrate | 里程靠调用间积分（从上一次调用带过来的变量） | **FAIL**（t=0 里程 0 vs −9.12） | 同上 | — |
| leak-clock | 承重值里混进 `Date.now()%1000 × 1e-6` | **FAIL**（t=0 0.000767 vs 0.000798） | 同上 | — |
| wrong-pure | probe 自己取状态、忘了时间倍率：`stateAt(t)` | PASS（它是纯的） | FAIL 3 条（只是碰巧错得够大） | — |
| wrong-subtle | probe 自己重算"灯亮"：`ac<-0.3 或 v<2.4`，不用 seek 画灯的 brakeLevel | PASS | **PASS 9 条** | **FAIL**（s4 t=8.533s 红灯像素=0） |
| seek-broken | **probe 正确**，seek 改坏（忘了时间倍率，physics 的 warp-inverted 同类） | PASS | **PASS 9 条** | **FAIL 2 条**（s6 起红灯团、黄车质心无值） |

第一版 check.mjs 在 probe.pure FAIL 时仍然打出"claims.scene 9 条全部为真 PASS"——不纯的 probe 让 PASS 失去意义。
已改：probe.pure FAIL 时 scene 断言即使全过也只报 SKIP"这个过不算数"（leak-near 复测确认）。

结论：**probe.pure 守得住"probe 不是 t 的纯函数"这一类**（四种泄漏全红）；**守不住"probe 和 seek 不是同一份状态"**——
后两行里 probe 自洽、9 条场景断言全绿，画面是错的。那一类只有像素断言抓到（它不经过场景自己的代码）。
"probe 必须和 seek 共用同一个取状态的函数"现在只靠约定，SKILL.md 已写明。

### 6b. 代价：逐帧取值到底贵不贵

`<scratchpad>/probe-reg/bench.mjs`，gj-fix，1920×1080，708 帧 @30fps：
```
probe 一次 evaluate 取全片（新页面第一次）  0.02 s（0.04 ms/帧）
probe 一次 evaluate 取全片（再取一次）      0.02 s（0.03 ms/帧）
probe 一次 evaluate 倒序取全片            0.04 s（0.06 ms/帧）
probe 每帧一次 evaluate                   0.22 s（0.31 ms/帧）
  其中空 evaluate 往返                     0.16 s（0.23 ms/帧）
像素：截图 13.26 s（186.82 ms/帧）；解码+数像素 3.14 s（44.17 ms/帧）（抽 71 帧）
```
结论：720 帧每帧一次 evaluate 只要 0.22s，担心的那个代价不存在；check.mjs 仍然一次 evaluate 取完（快 10 倍且少写代码）。
probe 的成本取决于场景自己算什么（ghost-jam 是 240Hz 跟车仿真 + 每帧检查点，0.03ms/帧）。
**贵的是像素**：≈0.23s/帧，比 probe 贵约 1000 倍。所以只在断言区间里采，`--claim-fps` 可降帧
（10fps 会漏掉 s3 那种 2 帧 = 0.07s 的全灭）。check.mjs 对 ghost-jam 从 49.1s（改前）涨到 136s（6 条像素断言 450 帧占 83s）。

### 6c. 本片法律的像素判据（demo-tls "密钥成立后中轴线必须退场"）

`films/demo-tls/docs/style_guide.md` 那条 law 加了
`"pixels": {"near": "#e0603a", "tol": 40, "stat": "count", "max": 0}, "from": "密钥成立.end", "grace": 0.5`（只改了这一条）。
tol=40 的理由：线是 alpha 0.85 画在 #07090c 上，混出的颜色离 #e0603a 约 36。先做会红的版本：
`<scratchpad>/films/tls-dead` 把 `drawEnds` 的退场关掉（`const done = 0`）。
```
tls-dead  FAIL law.no-dead-line  …6.80s 时 count(#e0603a±40)=4320，超出 max 0（6.76s–10.86s 的 41 个采样帧（10fps））   exit=1
demo-tls  PASS law.no-dead-line  …6.76s–10.86s 的 41 个采样帧（10fps）里 count(#e0603a±40) ∈ [0, 0]（像素判据，机器判）  exit=0
```
demo-tls 其余结论与改前逐条相同：FAIL 0 LOOK 2，HUMAN 3 → 2（少的就是这一条）。
窗口起点 6.76s = MARK「密钥成立」结束 6.26s + grace 0.5s = 场景里线收完的时刻（密钥后 +1.05s）。

### 6d. 中文按字重查表 + view_width

film-typography 扩大扫描范围后给了全字重表（有效 px）：100–900 = 26.7 / 17.3 / 17.3 / 18.7 / 24.0 / 24.7 / 29.3 / 28.0 / 30.7。
check.mjs 本来就从 `ctx.font` 解析字重，所以按字重查表（`cjk_<w>` → `cjk_bold` → `cjk`），不接单个常数——
常数会留下 500 的洞（500 真实下限 24.0，旧版走 18.7）。旧版 `cjk_bold: null` 让 600 只报 LOOK、比 500 还松，现在没有 null。
```
ghost-jam  改前 LOOK readability.size …×61 段中文粗体文字 10.9px（原生 58px），中文粗体这一档没有稳定可读下限（cjk_bold=null）
           改后 FAIL readability.size …×61 段中文 600文字 在 360px 宽时 10.9px（原生 58px），阈值 24.7px（cjk_600）
```
这是 film-typography 预告的那个样本（600 字重 58px，「言」只剩 3/6 段），判成 FAIL 说明接对了。
`_test-critique`（style_guide 自己声明了分档）正常版 FAIL 0、缺陷版 FAIL 10，与改前相同。

横版片按 360 宽判：保留为默认，**是故意的**（信息流里横片以手机宽度内嵌播放）；本片以横屏全屏为主时写 `view_width`。
`view_width` 只走过代码路径，没有专门的用例。

### 6e. 数字对账的两套语义（与 film-research factcheck.mjs）

没合并，写明分工：check.mjs 的 `facts` 是宽松筛（只比数值、全文搜）——FAIL 可靠、PASS 不等于对账；
严格对账归 factcheck.mjs。check.mjs 现在把采样截到的画面文字写进 `out/critique/onscreen.txt`，PASS/FAIL 文案里给出命令：
```
$ node skills/film-research/scripts/factcheck.mjs --film ghost-jam --also out/critique/onscreen.txt
  提示: 裸数字匹配词会命中任何单位的同值数（"22"也放过"22米"）：F01(22) —— 写上单位（"22辆"）能收紧
  结果: 0 错误, 0 警告     exit=0
```
没复用它的解析器：它要求 facts.md 的总表结构，`_test-critique` 的 facts.md 不满足，接进来会让成片阶段的提示项卡在调研格式上。

### 6f. 既有验收（改前 → 改后）

| 片子 | 改前 | 改后 | 差异 |
|---|---|---|---|
| demo-tls | FAIL 0 LOOK 2 HUMAN 3 | FAIL 0 LOOK 2 HUMAN 2 | no-dead-line HUMAN→PASS |
| _test-critique 正常版 | FAIL 0 LOOK 0 HUMAN 2 | 同 | 多一条 SKIP claims（没有 shotlist） |
| _test-critique 缺陷版 | FAIL 10 LOOK 2 HUMAN 2 | 同 | facts 文案 |
| ghost-jam | FAIL 0 LOOK 1 HUMAN 5，49.1s | FAIL 1 LOOK 1 HUMAN 5 | readability LOOK→FAIL（6d，真问题）；新 LOOK claims.source（真问题） |

注意：跑 check.mjs 会重写 `films/<slug>/out/critique/`（checks.json、证据帧、onscreen.txt）。demo-tls 和 ghost-jam 的这几个产物被本轮覆盖了。

### 6g. review_log 占位（F-034）

无人在场时去掉了"倾向性提醒"下的 `- （待填）`（上一句已说整节未看），"改了什么"改成 HTML 注释。
`_test-critique` 拷贝实测：无人在场一节"待填"从 2 处降到 0 处；`--seen-by` 时 4 处，都是该人填的格子。

## 7. 第四轮：空间锚点的两道门 + `claims.anchor`（`scripts/_anchors.mjs`）

check.mjs 只接了四处线（import、fillText 探针多记一个未裁剪的 `box`、法律循环里分流 `occlude`/`inframe`、claims 里分流 `source: anchor`）。
**没声明的片子行为不变**：同一份 demo-tls 用改前/改后的 check.mjs 各跑一遍，`checks.json` 的 findings / timeline / laws 逐项相同，stdout 相同。

ghost-jam（夹具副本 → 正片），每道门都做了阴性对照：

```
构图改前（CAM_CLOSE z2.0 x0 y31.5）
  FAIL law.landmarks-clear  192/282 帧相交，最深 14.20s「参照树」与 字幕底条 重叠 9.5px
  FAIL law.stopped-in-frame 42 帧次主语出画面，最严重 13.43s「停着的车」只有 60.3% 在画面内（越界 左 57px）
构图改后（z1.85 x-3 y32.5）
  PASS law.landmarks-clear  282 帧从不相交，最近时相距 36.3px
  PASS law.stopped-in-frame 26 帧主语在画面内的面积占比最低 100.0%
  PASS claims.anchor        2 条 572 帧次
构造的阴性对照（各自一份副本，改一处）
  字幕上移 150px + against 只写 "text"  → FAIL 文字「车」盖参照树 85.7px（fillText 文字框这条路本身通）
  承重锚点名写成 参照树X               → FAIL 没有登记
  inframe safe 0.05                    → FAIL 只有 89.8% 在安全区内（越界 左 14px）
  黄车cx 的 op 改成 rising             → FAIL claims.anchor 0.462→0.167 不是 rising
  灯团cx 的 anchor.name 写成 灯团X      → FAIL 无值（锚点这一帧没有登记）
  上一帧黄车框并进本帧                  → FAIL anchors.pure + 两道法律门各报不纯
  场景不 install（没有 window.anchors） → FAIL ×3（两条法律 + claims.anchor）
```

像素版与锚点版并行（同一区间 s6.start→end、同 286 帧）：黄车 r=1.000、恒差 7px，逐帧方向 281/285 同向；
灯团端点位移 +0.428 vs +0.417 一致，但逐帧方向只有 179/285 同向、差中位 69px 最大 182px——成组锚点的外包框中心随成员进出跳变，
还算进了出画的车。结论一致；只适合端点比较的断言。

## 8. 第五轮：三处误导提示 + 拼段 + `facts_single` + 接线 `tilt.ortho`（weiqi-intro 作者报告）

夹具 `crit3`（scratchpad，`FILMS_DIR` 指过去）：字幕 0.5s 出现、4.0–4.6s 一条深带从它底下扫过；读数「19」「道」两种字体两笔画；
「7」「道」同上；描边 + 填充同一段「共 361 个点」；同基线上离得远的「甲方」「乙方」；等宽字逐格画 `Content-Length: 1842`；
六个孤立的单个数字 4–9；`window.probe` 在 t≥3 返回 null；另放一条找不到红像素的 `source: pixels` 断言作对照。改前 / 改后各跑一遍：

| 项 | 改前 | 改后 |
|---|---|---|
| contrast「镜头说明文字」 | 1.00:1，证据帧 **0.50s**（第一次出现，那一帧没问题） | 1.00:1，"最差在 4.40s"，证据帧 4.40s |
| claims.scene 无值 | "像素统计在没有匹配像素时无质心" | "window.probe(3.000).可读性 = null，不是有限数：场景说这一刻没有这个状态…" |
| claims.pixels 无值（对照） | "像素统计在没有匹配像素时无质心" | 不变 |
| onscreen.txt | `19`、`共 361 个点`、`甲方`、`乙方`… | `19道`、`7道`、`共 361 个点`（没拼成两遍）、`甲方`、`乙方` 各自一行 |
| `factcheck --strict --also onscreen.txt` | "19 在 facts.md 里没有条目（同值但单位对不上：要求单位道）" | 这一条消失 |
| facts.single（未声明） | SKIP "6 个逐字绘制的单个数字字符不参与" | LOOK，列出「1842」「4」…「9」和时刻 |
| `"facts_single": "check"` | — | 参与对账：facts.md 没有 7/8/9/1842 → FAIL 点名 |
| `"facts_single": "瓣里的数字是序号"` | — | SKIP 并照写理由 |
| `check` + `"facts_ignore": "^[789]$"` | — | 只剩 4/5/6 参与，PASS |

拼段判据第一版按**墨水框**量缝，demo-tls 的等宽底纹逐字画、墨水框之间有缝，拼出来是 `C o o kie:`；改成按 advance 量。
第二版把同一字体逐字画的串也当普通段，demo-tls 的 HTTP 底纹冒出 `1842` 等数，宽松筛 FAIL、整片变红——那是装饰不是事实陈述，
所以"整段每笔都是单字且同一字体"归到 `facts_single` 那一类（字体不同的几笔，例如数字 + 单位，照常对账）。

三支片子改前 / 改后逐条比 findings（exit 码三支都不变）：

| 片子 | 变化 |
|---|---|
| ghost-jam | facts 计数 1→2（字幕逐词画，旧 onscreen.txt 只剩「路，」「车，」这种碎片；新版 16 句完整字幕，"二十二辆车，"第一次进对账）；新增 LOOK tilt.ortho（见 film-motion §14，真阳性，未改片子） |
| demo-tls | facts.single SKIP → LOOK（25 段逐字绘制的数字，全在 HTTP 底纹 / 乱码里） |
| weiqi-intro | facts 10 → 22 个数字（`2道`…`19道`、`0口气`…`6口气` 进来了，数值都在 facts.md）；facts.single SKIP → LOOK（瓣里的 1–6，17.8–36.5s） |

拼好的 onscreen.txt 交给 `factcheck --strict --also`：ghost-jam 0 错误（改前也是 0，但改前它只看到字幕碎片）；
weiqi-intro 改前 0 错误 → 改后 1 条：读数 `5口气`（6 口被一口口堵掉时的中间值）在 facts.md 没有带单位"口"的条目。
改前它是一笔裸的单个 `5`，被整个跳过。这不是画面缺陷，是 facts.md 的登记缺口（同 X03 对 `1道…16道` 的做法，登记成免核即可）；
accept 的 facts 门不带 `--also`，不会因此变红。没改那支片子。

另：onscreen.txt 只在有数字可对账时才写，旧版不删上一次的文件——demo-tls 本轮中途撞到过一次被当成本次画面文字的旧文件。
现在每次运行开头和证据帧一起删掉。

`tilt.ortho` 的接线是 film-motion 提供的三行（`scripts/lib/tiltscan.mjs`），本 skill 只加了耗时记账（`cost.tilt_ms`）。

## 9. 成片 true peak（`--mp4`，协调方追加）

同阈值同测法照抄 film-narration（`mux.sh` 合流后 / `align.py` 的 `true_peak()`：`loudnorm=print_format=json` 的 `input_tp`）。
夹具 `tp`（scratchpad，2s 纯配乐、没有 narration.json，进不了 `--verify`）：

| 成片 | input_tp | 结果 |
|---|---|---|
| 997Hz 调幅正弦 ×0.95，AAC 192k | −0.44 | FAIL `mp4.truepeak` |
| ×0.875 | −1.16 | LOOK |
| ×0.7 | −3.09 | PASS |
| 无音轨 | — | SKIP |
| ghost-jam `final-16x9.mp4` | −1.01 | LOOK（协调方给的期望：警告不是失败） |
| demo-tls `final-9x16.mp4` / weiqi-intro `final-9x16.mp4` | −1.43 / −1.44 | LOOK |

顺带：`mp4.asr` 的 TODO 改成有 narration.json 才列（纯配乐片列它是误导）。
weiqi-intro 的 `final-9x16-loop.mp4`（contact.sh 的拼接派生物）是 −0.18，accept 只挑非 `-loop` 的那个，不受影响。

## 10. 可选疑点 continuity / rhythm（`scripts/_flow.mjs`，判据借自 onetake，2026-10-23）

只报 LOOK / PASS / SKIP。临时声明全在 scratchpad 副本上做（`--films-dir`），films/ 下没动。

**没声明时输出不变**：weiqi2-l1 副本，改动前后各跑一次 check.mjs（不声明）：控制台只差一行像素断言耗时（96.7s / 93.3s），
checks.json 去掉 `cost` 后逐字节相同（19 条 findings）。
**只声明疑点不关别的门**：_test-mg 副本，`checks.critique = { continuity, rhythm }` 与删掉 `checks.critique` 两份对比，
差别只有三条疑点（FAIL 0 / LOOK 3 vs FAIL 0 / LOOK 0）——laws / loop / page 照查。

| 片子（副本） | 声明 | 结果 |
|---|---|---|
| _test-mg | `continuity: { cuts: [2.5] }`, `rhythm: true` | `continuity` LOOK 0.20：5 个计分交接 carried 1（orb 带进 card/orb/title）/ anchored 0 / bare 4；豁免 2（片头淡入 1、声明切点 1）。`rhythm.cv` LOOK 0.00（12 个 MARKS 段都是 1.20s）；`rhythm.still` LOOK 16.1%，最长静止 1.00s |
| weiqi2-l1 | `continuity: true`, `rhythm: true` | `continuity` SKIP：0 个交接（锚点按类别命名，「棋面」「盘线」跨镜头都在，硬切处 J≈0.47）。`rhythm.cv` PASS 0.27（shotlist 时间表 6 镜 5.19–12.37s）；`rhythm.still` PASS 66.9%，最长 3.10s |
| weiqi-intro | `continuity: true` | LOOK：场景没有 window.anchors |

代价：continuity 一次 10fps 的 `window.anchors` 顺序取（weiqi2-l1 54s 约 540 帧，只 draw 不截图）；rhythm 不另采样。
**已知盲区**：锚点按类别登记的片子量不出交接（SKIP 不等于衔接好）；交接只看名字配对，同名换了一个物件（另一颗「棋面」）照样算 carried/anchored。
shotlist 的 `carry` 字段 check_shotlist.py 本来就不拒（weiqi2-l1 副本加 `carry` 前后输出一致）。

## 11. check.mjs 并行化（`_pool.mjs` 接线 + `_pixels.mjs`，2026-10-23）

改前：主采样、像素法律/断言、锚点、事件截图全在一个场景页 + 一个分析页里串行，每帧 PNG 转 base64 送分析页；`_pool.mjs` 写好了没人 import，
文档里的 `--workers` 没实现。改后拓扑见 references/checks.md「并行」：W 个场景页（默认 8 = 16 核/2）分在 ⌈W/P⌉ 个浏览器（P=2），
连续分片按时间顺序拼回；原生分辨率数像素改在 Node 端 worker 线程（⌈W/2⌉ 个）里解 PNG、数像素。

**Node 端解码与浏览器逐字节相同**：demo-tls / ghost-jam 各 12 帧截图，`decodePNG` 的 RGBA 与分析页 `createImageBitmap → drawImage → getImageData`
的 RGBA md5 全部相同（12/12、12/12；截图是 8 位 RGB，无 alpha）。解一帧 13ms（1080×1920）/ 21ms（1920×1080）。

**一致性**（全部在 scratchpad 副本上跑，`--films-dir`；基线 = 改前 skills/ 整份拷贝，含本会话的 _flow.mjs）。
比的是 checks.json 去掉 `cost` 后的字节、claims-samples.json（像素/锚点/probe 逐帧原值）、onscreen.txt、证据帧文件名与 PNG 字节：

| 副本 | 覆盖到的路径 | 改前 | 改后（默认 8 worker） | 一致 |
|---|---|---|---|---|
| demo-tls | 像素法律、probe 断言、压扁 | 8s | 5s | 全部相同 |
| _test-mg + `continuity`/`rhythm` 声明 | 衔接度（锚点并行采样）、rhythm、21 张 FAIL 证据帧 | 10s | 3s | 全部相同（证据帧 21/21 字节相同）；`--workers 3 --pages-per-browser 3` 也相同 |
| ghost-jam | 遮挡门 + 出画门（顺序/倒序在分片内）、`claims.anchor`、`claims.pixels` 358 帧 | 91s | 16s | 全部相同 |
| weiqi2-l1 | 遮挡门 + 出画门、像素法律、`claims.pixels` 601 帧、535 帧主采样 | 112s / 117s | 22s / 23s | 全部相同；`--workers 1` 也相同（102s） |
| gj-motion（ghost-jam + 3 条 `stat: motion` 像素断言 + film.json `loop: true`） | motion 的"上一帧"跨分片、loop 8 对相邻帧、claims FAIL 证据帧 | 150s | 24s | 全部相同（708 帧 motion 原值逐个相同）；`--workers 3` 也相同 |

weiqi2-l1 分阶段（ms，8 worker）：open 1267 / 主采样 8927 / 像素法律 1489 / 锚点法律 2676 / 像素断言 5676（改前 45714）/ 事件 311 / 压扁 91。
worker 数（同一负载时段，weiqi2-l1）：4 → 36s，8 → 23s，12 → 21s；默认保持 8（12 只快 2s，内存多 4 个场景页）。机器负载 load≈9，绝对值偏慢，看相对值。

**没做的**：`--only` / `--law` / `--claim` / `--from --to` 局部运行与 `inputs.changed`（`_inputs.mjs`）在文档里写过但 check.mjs 没有，
本轮没实现，文档已改成"没有 / 未接线"。页面报错多于 3 条时，报告里前 3 条的先后按 worker 汇总，可能与串行不同（条数相同）。
不纯的场景在不同分片上会给出与串行不同的结果——那本身是内核违约，`anchors.pure` / `probe.pure` 照报。

## 12. 世界文字可读性 `legible`（`scripts/_legible.mjs`，2026-10-23）

接线：`checks.critique.legible: { "min_px", "min_squash" }`，名字在 `_film.mjs` 的 `CRITIQUE_THRESHOLD`（不在 `CRITIQUE_CHECKS`，pin-checks 不钉）；
check.mjs 第 10 节，`phase('legible')`，帧序列经 `pool.chunks` 分片、每片自己的页面里顺序 + 倒序各取一遍。

夹具 `legtest`（film-webfx VERIFIED §9，五个词；film.json 只声明 `legible: { min_px: 40, min_squash: 0.6 }`）：

| 运行 | 结果 |
|---|---|
| `check.mjs --film legtest --films-dir <scratch>/films --workers 4` | FAIL 3：「推远」28/46 帧，最小字高 17.2px @3.00s；「斜看」19/46 帧，squash 0.15 @4.50s；「地面」43/43 帧，squash 0.35 @5.50s。PASS 2：「正面」「滚转」257.3px / squash 1.00。193 帧 legible 阶段 1.27 s。证据帧人眼看过（地面那张：字明显扁） |
| 同上 `--workers 1` | checks.json 去掉 cost 后与 `--workers 4` 逐字节相同 |
| `--entry scene-noreg.html`（声明了阈值、没登记） | FAIL `legible`：场景没有登记任何世界文字 |
| `--entry scene-leak.html`（推远距离带上一帧的值） | FAIL `legible.pure` @1.50s，其余不判 |
| film.json 写 `"legible": true` | FAIL `legible`：要写阈值，套件不给默认 |

老片一致性（改前的 check.mjs 存成临时副本，同一机器先后跑，默认 8 worker，checks.json 去掉 cost 后逐字节比；副本已删）：

| 片子 | 改前 | 改后 | checks.json（去 cost） |
|---|---|---|---|
| `weiqi-fx-open`（three 片，pinned 全套 critique） | FAIL 0 LOOK 3 HUMAN 3 | 同 | **逐字节相同**（26122 字节） |
| `weiqi2-l1`（pinned 全套 critique） | FAIL 0 LOOK 0 HUMAN 2 | 同 | **逐字节相同**（44567 字节） |

（`weiqi-ch1` 没用 three，只用了 webfx.js，所以 3D 老片选的是 weiqi-fx-open。）`node skills/selfcheck.mjs`：全部通过，0 警告。
没测：带 `--mp4` 的老片对照（legible 与 mp4 分支无交集）；真片里登记 legible（目前只有夹具）。

## 没测到 / 没解决

0. **3b 跨缝跳变分支没有专门的缺陷场景**：缺陷版在 3a 就 FAIL 了，没造一个"frame(D)=frame(0) 但最后一帧跳"的片子。

1. **音轨**：`mp4.av` 和 `align.py --verify` 没跑过（测试片无音频）。
2. **`duration.wav`**：手写 narration 没有 wav 字段，WAV 实测对账分支没跑过。
3. **WAAPI 场景**：冻结 playbackRate 的逻辑照搬自已跑通的旧 stills.mjs，本轮测试片是纯 canvas，没重测。
4. **DOM 文本**：可读性探针的 DOM 分支没有测试场景覆盖；DOM 文字只查字号不查对比度。
4b. **合并粒度**：按字号档合并，所以同一字号下一段真正的问题文字会和底纹合成一条（样例只列前 5 个）。完整列表要看 checks.json；没有按屏幕区域分组。
4c. **文种多数派**：拉丁中文混排（如「HTTP 握手」）按多数派只套一档阈值，少数派那几个字没单独量。
5. **文字探针看不见的字**：预渲染到位图 / Path2D / WebGL 纹理的字 → SKIP，只能人看 phone.png。
6. **MARKS 依赖**：只能查声明过的事件。安史之乱若没进 MARKS，check.mjs 全绿。哪些事件承重是人的判断。
7. **音画矛盾只抓下限**："旁白在说、画面已空"能抓；"旁白说红、画面是蓝"抓不到。
8. **facts 只核数字不核语义**："618 年灭亡"也能在 facts.md 找到 618。
9. **色板检查**：落在两个色板色连线上的外来色（墨与纸之间的灰）抓不到。
10. **strip.png 起点**：默认 35% 处可能落在平台期（本次就是）；没有自动选"最活跃处"，靠人传参数。
11. **采样分辨率**：10fps 时时间精度 ±0.1s；比 6px 小的变化可能漏。长片截图成本线性增长（60s 约 600 次截图）。
12. 意外语义（T7/T8）没有任何自动化，这是设计上的选择，不是遗漏。
13. **probe 与 seek 共用同一份状态没有机械保证**（6a' 后两行）：probe.pure 只证明 probe 自洽。旁证只有像素断言，前提是颜色签名唯一；没写像素断言的片子，这类错误全绿。
14. **probe 只证明场景算出的状态**：不证明画出来了；像素断言能补，前提是颜色签名唯一。签名不唯一（别的东西也是这个红）时像素路会假绿。
15. **像素断言测的是截帧**，不是成片：没经过运动模糊（sub>1）和 H.264。ghost-jam 是 sub=1；sub>1 的片子没测。
16. **像素法律只在 10fps 采样帧上判**（复用主采样，不另截），时间分辨率 ±0.1s；比这短的残留会漏。
17. **`view_width`、`cjk_<w>` 自定义键**只走过代码路径，没有专门用例；`min_text_src_px` 和 `view_width` 同时改时，原生 px 的换算口径没想清楚。
17b. **场景自己又加一遍留白**（和 narration.js 的平移叠成两遍）：有 MARKS 时 mark.sync 会抓；有 scene/pixels 断言时，
   断言在 shotlist 锚点时刻取值，状态整体错位多半会让断言红（推理，没造用例）；两样都没有的片子没有任何机械手段能抓。
18. **`claims.source` 启发式**只认 film-physics 的运行时文件名；自写迭代、数据驱动、第三方物理库的片子不会提醒。
19. **数字对账仍是两套**（6e）：分工写明了，但 check.mjs 的 PASS 依旧会放过"22 辆 vs 22 米"，要人记得跑 factcheck。
20. **锚点门只在一支片子上跑过**（ghost-jam，2D canvas、舞台铺满画面）。舞台 canvas 不铺满画面时，锚点（按 canvas 归一化）
    和文字框（按视口归一化）不在同一坐标系，没做换算也没造用例。
21. **遮挡门的文字框是 `measureText` 的 ink 框**，不含描边宽度和阴影；字幕底条这类"字周围的 UI"要场景自己登记成锚点再写进 `against`。
22. **锚点只说画在哪，不说看得见**：被盖住、alpha 为 0 时框照样在；"看得见"仍要像素断言。登记在错的那一笔上，锚点门全绿——
    ghost-jam 的硬性要求因此像素版和锚点版并行写。
23. **"无值"提示的根子在 film-storyboard**：`check_shotlist.py` 的 `eval_claim` 对非锚点来源一律写"像素统计在没有匹配像素时无质心"。
    check.mjs 对 `source: scene` 按"无值（"这串字改写；那边措辞一变，改写就不再触发（退回旧的误导提示，不会报错）。该由 film-storyboard 按 source 分三种写。
24. **拼段是几何判据**：同一基线上恰好挨着的两个独立标签会被拼成一段；换行、竖排、曲线排字的一句话不会被拼。
    描边字（stroke 白、fill 黑）对比度按 strokeText 那一笔量会是 1:1——这是本轮夹具顺带撞到的旧问题（探针分别量每一笔），没修。

---

## 改用 film-core 与扁平 checks 之后的回归（2026-10-24）

`check.mjs` 不再有内置的子判据表和默认开的项：查哪些只看 film.json `checks`（扁平 id），认领的 id 只写在 `gates.json`。
跨能力（narration.js、tiltscan、check_shotlist.py）经 `capability()` 取。对照基线是 7cd1351 的同一脚本：

| 片子 | 合并前 | 之后 |
|---|---|---|
| `_test-critique` | FAIL 0 LOOK 0 HUMAN 2 | 相同；结论 id 只多两条 SKIP（`checks` 列出未声明的 continuity/rhythm/legible；`mp4` 声明了但没给 --mp4），`facts` 改名 `facts.screen` |
| `_test-critique --entry scene-bad.html` | — | FAIL 8（law.palette、law.max_still、readability.size、loop 等都在） |
| `weiqi2-l1`（53.5s，8 页面，21s） | 结论 id 相同；基线多出的 10 条 `duration.wav` 是工作树里没有 out/vo/*.wav（不入库），与改动无关 | FAIL 0 LOOK 0 HUMAN 2 |

只装 film-core + film-critique（拷到 scratch 的假安装）：声明了 `marks`/`narration` →「缺能力 film-narration」exit 1；
`tilt` →「缺能力 film-motion」；`claims` →「缺能力 film-story」；只声明 `loop`、`laws` 时照常跑完 exit 0。都在起浏览器之前报。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

2026-10 装机 md 瘦身时，从 `skills/film-critique/SKILL.md` 与 `references/checks.md` 移出的来历、实测叙事和设计细节。
skill 里只留结论、判据、命令与代价数字；这里保留"为什么是这个数 / 这个口径"。

**为什么片子没声明的事不打分。** 上一版 skill 有七个固定维度、每项 ≥8 才算过，其中"变化密度（每 2-4 秒有新东西）"
对快节奏产品片对，对刻意沉静的水墨片就是错的。拿 skill 自带的审美打分会把每支片推向同一种风格；
"每项 ≥8 分"需要一把 skill 自带的审美尺子，这正是要避免的。

**截帧为什么直接用 film-core `openScene`。** 两边各抄一份截帧代码，迟早静默地不一致（WAAPI 冻结只在一处做对）。
Playwright `animations:'disabled'` 会把 WAAPI 动画 `finish()` 成终态：实测四个时刻截出同一帧，且不报错。

**probe 与像素断言的分工（第 6a'、6b 节的结论）。** `probe.pure`（顺序取 / 倒序取比对）实测抓得住近似缓存、往回跳不重算、调用间积分、读墙钟四种泄漏。
但"probe 和 seek 共用同一份状态"只靠约定：实测把 seek 的时间映射改坏、probe 保持正确，`probe.pure` 和 9 条 `claims.scene` 全绿，只有像素断言红。
所以 `source: pixels` 是唯一不经过场景自身代码的旁证。

**并行结论与串行逐项相同靠的四条**（第 11 节实现）：
1. 时间轴切成连续分片（默认 W×4 片），谁先空谁领下一片，结果按原顺序拼回。
2. 静止判定（和"上次变化时的帧"比）与 `dPrev`（和上一帧比）原是分析页状态，挪到 Node 端按时间顺序算：分析页只交回每帧缩略亮度图（Float32 原样字节），diff 同一函数。
3. 像素断言的 `motion` 和上一帧比（原 `measure` 的 `mPrev`，相差恰好 1/claim-fps 才有值）：串行时第 0 帧的上一帧是最后一条像素法律量的最后一帧；
   并行时每个分片把它前面那一帧重截一次（纯函数，像素相同）交给线程，只设状态不出值。
4. 事件可见性按事件分，结论按原顺序写。纯函数检查（`anchors.pure`、锚点法律的顺序/倒序）在每个分片自己的页面里先顺序后倒序取；`--workers 1` 时整段一个分片。
`_pixels.mjs` 在 Node 端解 PNG（zlib + 逐行反滤波）、worker 线程数 = ⌈W/2⌉（≤8）；与浏览器 `createImageBitmap → getImageData` 逐字节相同的前提是 8 位非隔行 RGB/RGBA 且不透明。
180px 缩略统计（边缘、色板、静止）仍在分析页里做：缩放要和原来逐位一致，只能交给同一个 `drawImage`。SwiftShader 的 GPU 进程按浏览器算，一个浏览器塞太多页面它先成为瓶颈。

**inputs.changed 的接线设计（`_inputs.mjs` 已写，check.mjs 未调用）。**
开始时（解析完影片、开页面之前）给片子目录里除 `out/` 外的每个文件、narration.json 指向的 wav、`--mp4` 记 md5 + 大小 + mtime；
结束时（最后一次读输入——`check_shotlist.py --verdict`——之后）对"本次读过的输入"再算一遍：入口 html、film.json、narration.json、script.json、`docs/**`、`runtime/**` 总是比
（运行中新出现 / 被删也算），其余文件（assets/、tools/、片子根下的 js）只比页面真的加载过的（每个页面的资源计时，加载前把缓冲开大）。
内容一样但 mtime 变了也算（中途可能读到过另一版）。不比：`docs/review_log.md`（下一步的产物）；film.json 的 `renderer` 字段（render.mjs 会改写，film.json 按去掉它之后的内容比，不看 mtime）；不看 ctime。
动机：weiqi-ch1 一次 28 分钟的检查里作者同时在改 scene.html，抽样读的是开头加载的旧页面、shotlist 读的是新的，出了 2 条假 FAIL，没人发现是混合结果。
盲区：只比开头和结尾——中途改了又逐字节、连 mtime 一起还原的抓不到（`rsync -a`、`cp -p`）；CDN 资源不在比对范围；skill 自己的脚本在运行中被改也不管。

**loop 口径。** "末帧 frame((N−1)/fps) 与首帧逐字节相同"的旧口径：film-core seamcheck 实测一支正确的循环片这两帧本该差约 8900 像素（一帧的运动量），
旧口径会把对的判错、把"最后一帧停住"的判对。

**中文字重分档的来历（第 6d 节）。** 旧版中文只有 cjk / cjk_bold 两档、且 cjk_bold = null：500 字重走 18.7（真实下限 24.0，偏松），600 只报 LOOK——加粗反而让闸门变松。
null 的来历是当初扫描范围写死 12–72px，700 的下限 88px 落在范围外（film-typography 扩到 200px 后实测，旧三个数一个没变）。
ghost-jam 的 600 字重字幕 58px（10.9 有效 px）旧版 LOOK，现在按 cjk_600=24.7 FAIL。

**对比度取最差帧。** 旧版时刻取"第一次出现"，weiqi-intro 的证据帧因此落在一帧什么问题都没有的 17.7s，真问题在相机横移那一刻。

**可读性合并的动机。** demo-tls 的乱码每 1/6 秒换字形，旧版逐条报了 91 条 LOOK，真正的 FAIL 被淹掉。

**facts.screen 为什么不复用 factcheck 的解析器。** 它要求 facts.md 的总表结构，不按总表写 facts.md 的片子（含本 skill 的测试片）不满足，
接进来会让一个成片阶段的提示项把整片卡在调研格式上。

**像素法律实测（6c）。** demo-tls「密钥成立后中轴线必须退场」：强调色 `#e0603a` 6.76–10.86s 41 帧全为 0；把退场关掉的回归副本 6.80s = 4320 → FAIL。

**锚点门阴性对照（第 7 节，ghost-jam 第 8 轮，夹具副本）。** 构图改前两道门各 FAIL（参照树被底条盖 9.5px；停车被左边缘切 57px）；
字幕整体上移 150px 且只对 `"text"` 判 → FAIL（文字「车」盖参照树 85.7px，证明文字框路径本身通）；锚点名写错 → FAIL（没登记）；
`safe 0.05` → FAIL（越界 14px）；把上一帧的框并进本帧 → 两道法律都报不纯。

**claims 的"无值"提示语。** `check_shotlist.py` 的 `eval_claim` 只分锚点 / 其它两种，其它一律写"像素统计在没有匹配像素时无质心"——对 `source: scene` 是错的。
check.mjs 按"无值（"这串字改写成 probe 的说法；根子应由 film-story 按 `source` 分三种写，改好之后这里的改写自然不再触发。

**legible 阈值的参照。** onetake 的一支片子定的是 ≥ 24 px、≥ 0.6（它的压扁比是"em 方块投影高/宽"，与这里的 σmin/σmax 不是同一个量），那是它的数，不是这里的默认。

**continuity 的不计分条件里"片头从空画面淡入"一条是本仓库加的，onetake 没有。**

**mark.* 的来历。** 均匀映射下事件时长 = 事件跨度 / 总跨度 × 映射段长度；墨色兴衰里安史之乱因此只剩 0.11s。
`visible` 只比中点会把短促的变化（闪一下、中点前已复原）误判成没画出来，所以取多帧。
`sync` 一律取全片第一次出现的代价：MARK 绑的是后一句的「下进去」而前一句先念过一次，就会报一个十几秒的假错位；所以按 `nth` > `line` > 最近 取。

**同页面测量对加载期违约是假门。** film-core 实测：加载期用 Math.random 生成布局，同页面三道门全过，只有全新页面重载那道抓到。

## stills.mjs `--entries` 比稿模式（2026-11-10）

多个入口各出一行静帧，拼成 `out/lookdev.png`，给风格帧比稿用（film-story `references/lookdev.md` §2）。
实测（两个各 1 秒的单帧页面，9x16）：不给 `--at` 时每个入口取中点，出 1×2；`--at 0.1,0.9` 出 2×2，每格下方标「入口名 时刻」，图看过，行列正确；
入口不存在 exit 2；不带 `--entries` 的原有行为不变（`--at 0.5` 出 1×1，meta 的 `points` 仍是 `{t, file}`）；`--help` exit 0，未知参数 exit 2。
没测到：入口是 WAAPI 场景、WebGL 场景时的比稿；入口名含中文时的标签（非字母数字和汉字的字符会被替换成下划线）。
