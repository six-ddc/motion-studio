---
name: film-story
description: 一支片子在写渲染代码之前的"文戏与导演设计"——按主题选叙事策略、KOL传播力与前3秒钩子、中段完播留存、营销种草与转化弧线（CTA）、听觉化台词打磨、选题调研与事实核查（docs/facts.md 与 factcheck 对账）、参考片拆解、视觉机制与音画关系、讲法与视觉方向比选及近作对照（siblings）、镜头设计与可执行分镜（shotlist.md 对齐 narration.json）、本片法律 style_guide.md、风格帧比稿与粗剪预演。用户说写脚本、写台词、出创意、前3秒钩子、吸引人、完播率、传播性、爆款感、像博主/KOL一样讲、带货转化、痛点种草、调研、查资料、事实核查、fact check、出处、别编数字、拆解参考片、画面方案、怎么拍、分镜、shotlist、storyboard、运镜、镜头设计、电影感、构图、视觉方向、风格帧、animatic、粗剪，或嫌没创意、太平、像PPT模板、和上一支撞脸、重要事件一闪而过时加载；用户只说"做一支讲某事的片子"也先用它立意或调研。转场实现归 film-motion，语音合成归 film-narration，成片检查归 film-critique。
---

# film-story

本 skill 负责片子进入画面编码之前的**立意、调研、脚本、传播设计与分镜编排**。它提供可按题型自由组合的方法论工具箱，**不规定固定的先后八股或单一审美套路**——硬套死流程只会把不同题材压成同一种腔调。

本 skill 不负责：画面渲染实现（film-motion / film-typography / film-physics / film-webfx）；素材授权与下载（film-assets）；语音合成与时间戳生成（film-narration）；成片质检（film-critique）。

## 三条技术硬约束（其余皆是方法参考，按需取舍）

1. **事实有据，不拿模型记忆冒充出处**：凡进入台词、屏幕或代码数据数组的客观数字、日期、专名与因果断言，都要查证原页并记入 `docs/facts.md`；搜索前先写 `memory-snapshot.md` 抓记忆偏差。纯虚构或纯视觉抽象片无需调研。
2. **有声同步时只读实测时间**：旁白与画面同步的片子先经 `film-narration` 产出 `narration.json`（或配乐产出 `beats.json`），分镜时刻只写锚点与具名 `pads`，片头/片尾留白只写进 `film.json`（`narrationOffset` / `narrationTail`），手填猜测秒数会导致重录后全片错位。
3. **状态断言在念读区间内成立**：台词一旦断言画面正在发生某种状态（"只剩一点余墨""延迟掉下来"），该状态在念这句话的区间里要在画面上真实成立。

## 1. 按主题与传播目的选路（不写死先后顺序）

不同题型的核心抓手、音画主从关系和创作起点不同，动笔前先选路，不必每支片子都走同一套顺序：

| 题型与目标 | 适合从哪入手 | 音画关系怎么配 | 错套其他路线的代价 |
|---|---|---|---|
| **抽象原理 / 机制科普**（算法、物理、协议、金融机制） | **视觉机制先行或音画同写**：找准核心变量映射成连续演化的视觉变量（`references/mechanism.md`） | **音画同构**为主：画面自己演化因果，台词点破画面正在发生的事 | 若先写满篇书面解释再找图配，画面极易退化成网格卡片与箭头 PPT |
| **历史 / 人物 / 事故与案例复盘** | **冲突弧线与调研先行**：抓反常结局、命运拐点与具体细节，按叙事权重而非物理年份分时长 | **证据 + 情绪对位**：关键处亮一手证据或尺度对比，不必把复杂人事硬压成单一数学变量 | 强套单一连续变量会让故事变得生硬做作；按时间均分则会让高潮一闪而过 |
| **KOL 观点 / 行业洞察 / 认知拆解** | **核心论点与钩子先行**：像视频博主面对面拆解误区，靠反直觉判断、层层递进与金句抓人 | **音画对位与留白**：嘴上说表面常识、画面亮反差证据，或停顿半秒让画面自己说话 | 逐句按字面意思弹图标配图，会彻底沦为枯燥的动态朗读稿 |
| **产品种草 / 商业营销 / 工具发布** | **受众痛点与转化弧线先行**：具体摩擦 → 旧法瓶颈 → 核心爽点实证（USP）→ 低门槛下一步（CTA） | **真实交互与前后反差**：把镜头给最痛那一步的前后对比（微距特写 + 拉远揭示），少堆砌功能清单 | 一上来报产品名罗列十项功能，非老粉会在前 3 秒划走 |
| **品牌情绪 / 预告片 / 节拍视觉片** | **画面与节拍先行**（`--recipe visual`，`references/lookdev.md`）：先定镜头张力、风格帧与节拍栅格 | **画面主导，声音贴画面**：台词极简点睛或按定好的镜头时长回写 | 用长句旁白去驱动宣传片，镜头会被切成毫无呼吸感的等长配图 |

## 2. 传播力、KOL 钩子与听觉文案设计

完整方法、钩子原型表、留存机制与平台差异见 `references/creator-playbook.md`。动笔写 `brief.md` 与 `script.json` 时重点把握五件事：

- **前 3 秒停留理由 + 0 秒静音首帧**：信息流里观众默认划走。开场优先用反常识颠覆、具象痛点嘴替、终局倒叙或极端数字反差建立"认知缺口"，避免百科定义式慢热开场；同时检查静音看前 2 秒画面与大字能否独立留人。
- **中段完播滑梯**：避免前 3 秒抛完钩子就退回平行罗列。用未闭合悬念环（Open Loop）、逐层推翻浅解释的认知滑梯或中段节奏换挡（景别跳切、`[停顿 0.5]`）维持期待；高潮闭环后干脆收尾，非清单查阅片少做拖沓的尾部总结。
- **说话姿态（Persona）与给耳朵写的口播**：先定"我是谁、在对谁说话"（同行老友拆解 / 冷静观察者 / 直给痛点的主理人），句式与 `film-narration` 的 `voices.py` 选角及 `instruction` 语气对齐。长定语拆短句、消解同音歧义、每 30 秒只留 1–2 个承重数字；合成前跑 `python3 <film-narration>/scripts/_timing.py estimate <script.json>` 摸底秒数，超长就砍字，别靠拉高倍速硬塞。
- **社交货币与丝滑转化（CTA）**：明确本片主攻**转发**（替受众发声的凝练金句）、**收藏**（可复用的结构框架）还是**评论**（真实两难分岔）。营销转化片让产品作为痛点拆解后的自然解法出场，需要测试多组开场钩子或渠道 CTA 时配合 `content.json`（见 `<film-core>/references/content-json.md`）出变体。
- **平台与画幅语境**：`9x16` 竖版对应被动刷屏，核心画面与字幕避开底部约 20% 文案遮挡区和右侧互动栏；`16x9` 横版对应主动点播，允许更完整的空间调度与论证纵深，不必照搬竖版短视频的催促腔。

## 3. 模块化能力与工具（按需选用）

### 产出文件概览（按片子需要裁剪）

```
films/<slug>/docs/
├── brief.md            目标、平台语境、受众起点/误区、说话姿态、调性换算数值
├── memory-snapshot.md  搜索前写下的记忆快照（涉及客观事实调研时用）
├── facts.md            事实总表 + 原文出处 + 叙事权重骨架（有事实断言时用）
├── mechanism.md        视觉机制或叙事主轴、开场钩子、可选讲法比选
├── shotlist.md         镜头设计与 ```json 可执行分镜 spec（多镜/音画对账时用）
└── style_guide.md      参考锚、视觉方向与近作对照、配色/字体/运动/本片拒绝项
```

另可选 `look/<名>.html`（风格帧比稿）与 `docs/beats.md`（`--recipe visual` 节奏骨架）。用 `node <film-core>/scripts/new-film.mjs <slug> --recipe explainer`（或 `visual`）可一键生成模板；字段细节见 `references/templates.md`，完整解说片协作流见 `references/explainer.md`。

### A. 调研与事实对账（涉及数据、历史、科学、外部事实时用）

核心原则是**把"以为记得的"和"查到原文的"分开落盘**：
1. **搜索前写 `docs/memory-snapshot.md`**：按打算上片的原话写下数字、事件日期（分清发生/发表/实施）、地点、人名与结论；搜完逐条比对，记错且易顺嘴说出的列为 `否决` 条目交给脚本守门。
2. **读原页写 `docs/facts.md`**：搜索摘要不算来源，打开原页拿到原文句子才算；承重事实用独立双源或一手源。匹配词带单位（`22辆`、`30 km/h`）；有争议写明分歧与片中措辞；定性建构曲线写明锚点且画面不标精确刻度。详见 `references/facts-format.md`、`references/fact-check.md`、`references/tools.md`。
3. **脚本对账**（自动剥离 `script.json` 里的 `[#语气]`、`[停顿 0.6]`、`[@区间]` 控制标记后核对数值、单位与状态）：
   ```bash
   node <film-story>/scripts/factcheck.mjs --film <slug>
   node <film-story>/scripts/factcheck.mjs --film <slug> --also out/critique/onscreen.txt --strict
   ```

### B. 参考拆解与"先看后写"（防闭门造车与成片返工）

- **拆解同类好片**：拆对方怎么抓钩子、怎么映射核心关系、信息密度与运动手感（`scripts/motionprint.mjs` 测速度/静止占比/能量曲线），不照搬具体表皮。见 `references/deconstruct.md`。
- **参考锚、风格帧比稿、粗剪预演**：在 `style_guide.md` 写清参考锚取什么不取什么；拿不准长相时先画 2–3 张静态风格帧拼图让用户挑，拿不准节奏时先用占位几何跑粗剪预演。见 `references/lookdev.md`。
- **近作对照**：跑 `node <film-story>/scripts/siblings.mjs --film <slug>` 生成 `out/siblings.png`，看清仓库里已有片子的真实画面，决定本片要拉开哪些维度，还是作为系列片有意沿用。

### C. 视觉机制与防默认诊断透镜（防退回廉价 PPT 模板）

当片子需要一个贯穿全片的视觉主轴，或感觉初稿画面像通用卡片网格时，可用两套诊断透镜（详见 `references/mechanism.md`、`references/divergence.md`）：
- **机制三刀诊断**：把核心变量映射到物质、空间、时间、文字、视角或力维度的视觉变量，检验：① **换题测试**（去掉专名套进菜谱/融资/一天还成立，说明只是通用容器而非专属机制）；② **自演化**（后续画面能否由规则自然推出）；③ **音画咬合**（画面是否在直接证明或有力对位台词，而非摆图标配图）。容器、图标与一次性变形都能用做局部辅助，只是撑不起整片主梁。
- **"候选 0"与多方案比选（可选留痕）**：如果担心第一反应落回最偷懒的默认画法或百科流水账，先把那个第一反应显式写成"候选 0"，再跨类别想 1–2 个替代方案比对代价。若在 `film.json` 的 `checks` 显式加入 `"divergence"`，`check_shotlist.py` 会校验讲法、视觉方向与近作对照是否留下了比选或跳过理由。

### D. 镜头设计与可执行分镜（`shotlist.md`）

- **镜头设计**：每镜明确景别、机位角度、运动与**动机**（揭示、强调、跟随或对比什么）、视觉焦点、交棒方式。整片正面平铺不动是偷懒默认值，确需平面排版时在 `style_guide.md` 写明理由。运镜词汇、代价及 2D/CSS 3D/Three.js 实现指路见 `references/cinematography.md`、`references/vocabulary.md`。
- **切镜与权重分配**：避免机械地每念完一句就切一镜同景别画面——按状态转折、情绪换挡或句中关键词揭示切镜更有呼吸感（快节奏排比金句除外）。物理跨度不等于叙事权重，重要转折在 `segments` 里单独绑定锚点区间，防止被线性时间压缩成 0.1 秒闪过。
- **可执行 spec 与对账**（`shotlist.md` 首个 ```json 块，字段规范见 `references/templates.md`）：
  - 锚点支持句/词边界（`s3`、`s3.end`、`s3@裂痕`、`s3@一#2`，大小写不敏感且遵守分词边界，与 `narration.js` `vo.at()` 一致）以及 `script.json` 里的语义区间（`span:rule`、`span:rule.end`）。
  - 转场交叠可在顶层或单镜声明 `"overlap"`（秒数或 `pads` 名），与 `sequence(..., { overlap })` 对齐；未声明的重叠会报错。
  - 曲线来源 `curves.source` 支持 `curve`（默认钉点插值）与仿真/实测类的 `scene` / `pixels` / `anchor`（见 `references/claims.md`）。
  ```bash
  python3 <film-story>/scripts/check_shotlist.py --film <slug> --write
  ```

### E. 本片法律（`style_guide.md`）

汇总本片的配色、字体、运动数值、形似风险（关键帧剪影要像什么、避免误看成脸或齿轮）以及"本片拒绝项"。每条拒绝都指回本片目标、机制或平台语境（写得出"因为什么代价不值得付"才写入，不写无理由的个人口味）。

## 声明的检查（`gates.json`）

`film.json` 的 `checks` 按需声明：`shotlist` 运行 `check_shotlist.py` 第 0–4 项（留白、锚点、覆盖与 `overlap`、重要区间时长、旁白状态断言）；`divergence`（可选）加查讲法、视觉方向与近作对照留痕；`facts.script` 运行 `factcheck.mjs` 核对台词事实与数字。`--recipe explainer` 默认开启 `shotlist` 与 `facts.script`（需强制比选留痕时再加 `divergence`）。

## 下层文件

- 传播与脚本：`references/creator-playbook.md`（前 3 秒钩子、静音首帧、中段留存、KOL 听觉口播与人设、传播驱动力与营销转化弧线、平台画幅语境）
- 调研与拆解：`references/facts-format.md`（分级、状态、格式、匹配规则、产品 UI）· `references/fact-check.md`（核查步骤、来源分级、争议与建构）· `references/tools.md`（搜索与 PDF 工具坑）· `references/deconstruct.md`（参考片拆解、`motionprint`）
- 机制、镜头与分镜：`references/mechanism.md`（机制判据、适用边界、正反案例、代价）· `references/divergence.md`（讲法/视觉方向/近作比选与可选 `divergence` 门）· `references/cinematography.md`（运镜词汇与代价、实现指路、CSS 3D 坑）· `references/vocabulary.md`（转场/节奏/构图/形似菜单）· `references/templates.md`（各文档字段与 shotlist json 规范）· `references/claims.md`（`curves.source` 选型）
- 先看后写与配方：`references/lookdev.md`（参考锚、风格帧比稿、粗剪预演、`visual` 配方）· `references/explainer.md`（解说片协作流）· 配方 `assets/recipes/explainer/`、`assets/recipes/visual/` · 模板 `assets/` · 脚本 `scripts/factcheck.mjs`、`scripts/check_shotlist.py`、`scripts/siblings.mjs`、`scripts/motionprint.mjs`
