# film-critique 测试片 · 自检记录

三层评判（详见 film-critique skill）：
客观项脚本判定 / 本片项读 style_guide.md / 倾向性提醒只是值得看一眼

模型没有眼睛也没有耳朵。主观项没人看过就标"未经人眼确认"，不要假装打了分。

<!-- 每轮由 film-critique/scripts/review_log.mjs 追加一节，人工补"看到了什么"和"改了什么"。 -->

## 第 1 轮
日期：2026-10-21　入口：scene-bad.html　时长 3.5s　采样 10fps
人眼：无人在场。下面所有主观项均为「未经人眼确认」，没有分数
备注：缺陷变体 scene-bad.html：故意做坏六处，验证脚本能抓

### 客观项（脚本判定）

| 结论 | 项 | 时刻 | 说明 |
|---|---|---|---|
| FAIL | duration.film | — | film.json duration=4.5s 与场景 DURATION=3.5s 不符 |
| FAIL | duration.narration | 3.50s | 旁白在 3.90s 才结束，画面 3.50s 就完了：最后 0.40s 旁白被截掉 |
| FAIL | loop | 3.48s | 本片要求循环，但首帧与末帧不同（180px 缩略下 685 个像素差 >8/255） |
| TODO | determinism | — | 确定性 / 乱序求值三条门：参见 film-motion 的 seamcheck.mjs（本脚本不重复实现） |
| FAIL | readability.size | 0.00s | 「注：示意」在 360px 宽时只有 6.7px（阈值 12px） |
| FAIL | facts | — | facts.md 里找不到出处的数字：三百（=300，画面） |
| FAIL | mark.visible | 2.00s | 事件「坊线铺开」2.00s–2.90s 起点前一帧与区间中点画面相同：声明了但没画出来 |
| PASS | mark.sync | — | 事件「坊线铺开」与词「一百零八」差 0.000s |
| FAIL | mark.length | 3.25s | 承重事件「盖印」只占 0.05s（3 帧 @60fps），阈值 0.50s：观众看不见它 |
| FAIL | mark.visible | 3.25s | 事件「盖印」3.25s–3.30s 起点前一帧与区间中点画面相同：声明了但没画出来 |
| PASS | mark.sync | — | 事件「盖印」与词「朱」差 0.000s |

### 本片项（来自 docs/style_guide.md）

| 结论 | 法律 | 时刻 | 说明 |
|---|---|---|---|
| FAIL | law.palette | 0.00s | 出现色板外颜色：4 个采样秒超标，最严重 0.00s 占 1.15% 像素 |
| FAIL | law.max_still | 0.90s | 0.90s–2.90s 画面完全静止 2.00s（期间旁白 s1/s2 在说），超过本片声明的 max_still=1.5s |
| 未经人眼确认 | law.no-curve | — | 不出现曲线运动（怎么看：看 strip.png 里连续帧的位移方向；stills 只能看到位置不能看到轨迹） |
| 未经人眼确认 | law.cinnabar-once | — | 朱砂只出现一次，用在印上（怎么看：contact.png 里数红色出现的格子） |

### 疑点（测得到，是不是问题看本片意图）

| 结论 | 项 | 时刻 | 说明 | 判定（故意/失误） |
|---|---|---|---|---|
| LOOK | empty.vo | 3.40s | 3.40s–3.50s 画面已空（边缘像素 <0.1%），旁白还在说：s2「一百零八坊铺开，盖上朱印。」2.00s–3.90s。查文案和画面是否矛盾 | 未经人眼确认 |

### 倾向性提醒（references/tendencies.md，值得看一眼，不是扣分项）

逐条过一遍，只记"看了，是故意的"或"看了，是偷懒，改"。无人在场时整节为「未经人眼确认」。

- （待填）

### 静帧上看到的（只有看过图的人能写）

- 未经人眼确认。模型可以描述它在图上看到的形状，但"好不好看""像不像脸"不作为结论。

### 最弱几点（带时间戳，FAIL 在前）

1. duration.film：film.json duration=4.5s 与场景 DURATION=3.5s 不符
2. **0.00s** readability.size：「注：示意」在 360px 宽时只有 6.7px（阈值 12px）
3. facts：facts.md 里找不到出处的数字：三百（=300，画面）
4. **0.00s** law.palette：出现色板外颜色：4 个采样秒超标，最严重 0.00s 占 1.15% 像素
5. **0.90s** law.max_still：0.90s–2.90s 画面完全静止 2.00s（期间旁白 s1/s2 在说），超过本片声明的 max_still=1.5s

### 改了什么 / 重渲区间

- （待填：改法见对应能力 skill；只重渲改动的秒数，参见 film-motion render.mjs --from/--to）

## 第 2 轮
日期：2026-10-21　入口：scene.html　时长 4.5s　采样 10fps
人眼：无人在场。下面所有主观项均为「未经人眼确认」，没有分数
备注：正常版 scene.html；MP4 是 --fps 30 --sub 1 迭代渲染

### 客观项（脚本判定）

| 结论 | 项 | 时刻 | 说明 |
|---|---|---|---|
| PASS | duration.narration | — | 旁白 0.30s–3.90s 落在画面 0–4.50s 内（片尾留白 0.60s，offset 0s） |
| FAIL | mp4.fps | — | MP4 帧率 30，film.json 写 60 |
| PASS | mp4.duration | — | MP4 视频流 4.5s（135 帧，应为 270）与场景一致 |
| PASS | loop | — | 首帧 t=0 与末帧 t=4.48s 逐字节一致 |
| TODO | determinism | — | 确定性 / 乱序求值三条门：参见 film-motion 的 seamcheck.mjs（本脚本不重复实现） |
| PASS | readability | — | 3 段文字：360px 宽最小 16.3px，对比度均达标 |
| PASS | facts | — | 4 个数字都能在 facts.md 找到：六一八、一百零八、618 |
| PASS | mark.sync | — | 事件「坊线铺开」与词「一百零八」差 0.000s |
| PASS | mark.sync | — | 事件「盖印」与词「朱」差 0.000s |
| PASS | marks | — | 3 个事件：时长、可见性、对点都过 |

### 本片项（来自 docs/style_guide.md）

| 结论 | 法律 | 时刻 | 说明 |
|---|---|---|---|
| PASS | law.palette | — | 每秒抽 1 帧，色板外像素都 ≤ 0.5% |
| 未经人眼确认 | law.no-curve | — | 不出现曲线运动（怎么看：看 strip.png 里连续帧的位移方向；stills 只能看到位置不能看到轨迹） |
| 未经人眼确认 | law.cinnabar-once | — | 朱砂只出现一次，用在印上（怎么看：contact.png 里数红色出现的格子） |

### 疑点（测得到，是不是问题看本片意图）

无。

### 倾向性提醒（references/tendencies.md，值得看一眼，不是扣分项）

逐条过一遍，只记"看了，是故意的"或"看了，是偷懒，改"。无人在场时整节为「未经人眼确认」。

模型对着 contact.png 过了一遍，以下是**模型的描述，未经人眼确认**：
- T1 透明度入场：「618」「长安」「一百零八坊」三处文字都是 alpha 渐显（contact 第 1 行第 3-4 格灰→黑），收尾三者又都是 alpha 渐隐。整片文字只有这一种手法。本片 style_guide 没说文字怎么入场，所以不扣分；是否故意 → 未经人眼确认。
- T3 平台期：contact 第 2 行六格完全相同（约 1.0–2.0s），旁白 s1 已结束、s2 未开始。约 1.0s，低于本片 max_still=1.5s，脚本没报，但图上一眼可见。
- T6 退场中间态：倒数第 2、3 格，横线向中心收、竖线只缩高度不收位置，留下一排"| | ‡ | |"的短竖条，读起来像条形码或断栅栏——这不是任何镜头设计过的状态。

### 静帧上看到的（只有看过图的人能写）

- 未经人眼确认。以下只是模型描述的形状，不作为审美结论：
  - stills.png 3.5s：黑方块（"墨滴"）+ 右下方朱砂小方块 + 下方「618」。"墨滴"是一个锐边正方形，读起来更像一个占位块/图标而不是墨——要不要它像墨，取决于本片想要什么，style_guide 没说。
  - 0.4s 和 1.2s 两格：黑块位置不同（下落中），但 1.2s 与 2.6s 的上半部完全一样——和 contact 上的平台期一致。
  - strip.png（起点 1.575s）12 帧全同：特写条正好落在平台期，这一张对本片没有信息量（见 VERIFIED"没解决"）。

### 最弱几点（带时间戳，FAIL 在前）

1. mp4.fps：MP4 帧率 30，film.json 写 60

### 改了什么 / 重渲区间

- （待填：改法见对应能力 skill；只重渲改动的秒数，参见 film-motion render.mjs --from/--to）

## 第 3 轮
日期：2026-10-21　入口：scene-bad.html　时长 3.5s　采样 10fps
人眼：无人在场。下面所有主观项均为「未经人眼确认」，没有分数

### 客观项（脚本判定）

| 结论 | 项 | 时刻 | 说明 |
|---|---|---|---|
| FAIL | duration.film | — | film.json duration=4.5s 与场景 DURATION=3.5s 不符 |
| FAIL | duration.narration | 3.50s | 旁白在 3.90s 才结束，画面 3.50s 就完了：最后 0.40s 旁白被截掉 |
| FAIL | loop | 3.50s | 本片要求循环，但 frame(D=3.50s) 与 frame(0) 不同（180px 缩略下 776 个像素差 >8/255） |
| TODO | determinism | — | 确定性门（同 t 重复 / 全新页面重载 / 乱序 / 循环）：参见 film-motion 的 seamcheck.mjs。本脚本的所有测量都在同一页面内，抓不到加载期 Math.random 一类违约 |
| FAIL | readability.size | 0.00s | 「注：示意」（中文 400）在 360px 宽时只有 6.7px（原生 20px），阈值 18.7px（cjk） |
| SKIP | facts.single | — | 2 个逐字绘制的单个数字字符不参与事实对账（若数字是逐字画出的，这项要人看） |
| FAIL | facts | — | facts.md 里连同值的数都找不到：三百（=300，画面）。严格对账（认单位）跑 film-research 的 factcheck.mjs --film _test-critique --also out/critique/onscreen.txt |
| FAIL | mark.visible | 2.00s | 事件「坊线铺开」2.00s–2.90s 起点前一帧与区间中点画面相同：声明了但没画出来 |
| PASS | mark.sync | — | 事件「坊线铺开」与词「一百零八」差 0.000s（查找用 film-narration 的 vo.at） |
| FAIL | mark.length | 3.25s | 承重事件「盖印」只占 0.05s（3 帧 @60fps），阈值 0.50s：观众看不见它 |
| FAIL | mark.visible | 3.25s | 事件「盖印」3.25s–3.30s 起点前一帧与区间中点画面相同：声明了但没画出来 |
| PASS | mark.sync | — | 事件「盖印」与词「朱印」差 0.000s（查找用 film-narration 的 vo.at） |
| SKIP | claims | — | 没有 docs/shotlist.md，分镜断言无从实测 |

### 本片项（来自 docs/style_guide.md）

| 结论 | 法律 | 时刻 | 说明 |
|---|---|---|---|
| FAIL | law.palette | 0.00s | 出现色板外颜色：4 个采样秒超标，最严重 0.00s 占 1.15% 像素 |
| FAIL | law.max_still | 0.90s | 0.90s–2.90s 画面完全静止 2.00s（期间旁白 s1/s2 在说），超过本片声明的 max_still=1.5s |
| 未经人眼确认 | law.no-curve | — | 不出现曲线运动（怎么看：看 strip.png 里连续帧的位移方向；stills 只能看到位置不能看到轨迹） |
| 未经人眼确认 | law.cinnabar-once | — | 朱砂只出现一次，用在印上（怎么看：contact.png 里数红色出现的格子） |

### 疑点（测得到，是不是问题看本片意图）

| 结论 | 项 | 时刻 | 说明 | 判定（故意/失误） |
|---|---|---|---|---|
| LOOK | readability.time | 0.00s | 「─」「┅」「┊」「┏」「└」… ×59 段单字（符号/拉丁）文字（0.00s–3.30s）每个都只短暂出现（最长 0.30s）：像是持续变化的文字区（乱码/逐帧换字/滚动底纹）。若是刻意的可忽略；若这是逐字绘制的正文，要人看它读不读得完 | 未经人眼确认 |
| LOOK | empty.vo | 3.40s | 3.40s–3.50s 画面已空（边缘像素 <0.1%），旁白还在说：s2「一百零八坊铺开，盖上朱印。」2.00s–3.90s。查文案和画面是否矛盾 | 未经人眼确认 |

### 倾向性提醒（references/tendencies.md，值得看一眼，不是扣分项）

逐条过一遍，只记"看了，是故意的"或"看了，是偷懒，改"。无人在场时整节为「未经人眼确认」。


### 静帧上看到的（模型描述，不作结论）

- **模型描述**：（必填 —— 真的用 Read 打开 stills.png / *-phone.png / *-contact.png 看，写可复述的事实：画面上有什么、在哪、相对关系、文字内容、有没有某个颜色。不写"好看""协调""节奏不错"。）
- **模型描述给不出、必须人看的**：（必填 —— 哪些话靠看图给不出，例如意外语义、质感联想、"这是故意的还是偷懒"、以及一切和声音有关的。）
- 以上**不是打分**。主观项仍然 未经人眼确认。

### 最弱几点（带时间戳，FAIL 在前）

1. duration.film：film.json duration=4.5s 与场景 DURATION=3.5s 不符
2. **0.00s** readability.size：「注：示意」（中文 400）在 360px 宽时只有 6.7px（原生 20px），阈值 18.7px（cjk）
3. facts：facts.md 里连同值的数都找不到：三百（=300，画面）。严格对账（认单位）跑 film-research 的 factcheck.mjs --film _test-critique --also out/critique/onscreen.txt
4. **0.00s** law.palette：出现色板外颜色：4 个采样秒超标，最严重 0.00s 占 1.15% 像素
5. **0.90s** law.max_still：0.90s–2.90s 画面完全静止 2.00s（期间旁白 s1/s2 在说），超过本片声明的 max_still=1.5s

### 改了什么 / 重渲区间

<!-- 改了再写：改法见对应能力 skill；只重渲改动的秒数，参见 film-motion render.mjs --from/--to -->
