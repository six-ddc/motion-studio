---
name: film-story
description: 视频进入完整编码前的创意与导演工具箱——传播力与前3秒钩子、中段完播与转化弧线（CTA）、听觉化口播文案、像素优先风格帧比稿（lookdev）、按需调研与事实核查（facts.md 与 factcheck）、参考片拆解、视觉机制与镜头设计、近作对照（siblings）、可选分镜对账（shotlist.md）与轻量化 style_guide.md。用户说写脚本、写台词、出创意、前3秒钩子、吸引人、完播率、传播性、爆款感、像博主/KOL一样讲、带货转化、痛点种草、调研、查资料、事实核查、fact check、出处、别编数字、拆解参考片、画面方案、怎么拍、分镜、shotlist、storyboard、运镜、镜头设计、电影感、构图、视觉方向、风格帧、animatic、粗剪，或嫌没创意、太平、像PPT模板、和上一支撞脸时加载。具体渲染实现归各能力 skill，素材归 film-assets，语音合成归 film-narration，质检归 film-critique。
---

# film-story

编码前的**立意、脚本、风格定调与镜头设计**工具箱。全部方法**按题型与需要自选**，不强制走固定文档流程，也不规定单一审美（硬套“单一变量极简科普”反而会把产品发布、故事或情绪片做枯燥）。

## 三条硬约束（其余皆为按需工具）

1. **事实有据**：进入台词、画面或数据数组的客观数字、日期、专名与因果断言，必须核查原页并记入 `docs/facts.md`（搜前可写简短记忆快照防幻觉）。纯虚构或纯视觉片无需调研。
2. **有声同步只读实测时间**：旁白驱动的片子先经 `film-narration` 产出 `narration.json`，镜头与事件只读锚点（片头/片尾留白只写进 `film.json` 的 `narrationOffset` / `narrationTail`），不手填秒数。
3. **断言与画面一致**：台词明确断言画面状态（"只剩一点余墨""延迟掉下来"）时，该状态在念读区间内要在画面上真实成立。

## 1. 像素优先：先看画面再写整片

最容易整片返工的原因，是在纯文字里定了一个“听起来很高级、画出来很单调”的方案。

- **风格帧比稿（新片首选）**：除非用户指定了长相或明说"直接出完"，先用几分钟写 **2–3 个真正不同方向的单帧 `look/*.html`**（调子、材质、镜头、媒介感不同，不只换配色；自由混用 2D / 3D / HTML+CSS / 外部或生成式素材），用 `film-critique` 的 `stills.mjs --entries` 拼成 `out/lookdev.png` **给用户拍板**，再写整片。见 `references/lookdev.md`。
- **轻量化 `docs/style_guide.md`**：半页写清选定方向、色板与字级、3–5 个冲击点（含开头 2 秒钩子）、声音策略与素材/技术取舍即可，不必填长表。
- **近作对照（按需）**：担心和仓库旧片撞脸时跑 `node <film-story>/scripts/siblings.mjs --film <slug>` 看 `out/siblings.png`。

## 2. 按题型选抓手（不写死先后顺序）

| 题型 | 核心抓手 | 音画关系 | 避坑 |
|---|---|---|---|
| **原理 / 算法 / 机制科普** | 找连续演化的核心视觉机制（`references/mechanism.md`） | 音画同构：画面演化因果，台词点破 | 先写满篇书面解释再配图标 → 退化成 PPT 卡片 |
| **历史 / 人物 / 案例复盘** | 冲突弧线、反常结局、按叙事权重分时长 | 证据 + 情绪对位 | 强塞进单一数学变量会生硬；按年份均分会吞掉高潮 |
| **KOL 观点 / 认知拆解** | 反常识钩子、层层加码滑梯、金句与说话人设 | 音画对位与留白反差 | 逐句字面弹图标 → 枯燥朗读稿 |
| **产品种草 / 发布会 / 营销** | 具象痛点 → 旧法瓶颈 → 核心爽点实证 → 低门槛 CTA | 真实界面/交互与前后对比，大胆用丰富网页/3D 视觉语言 | 开头罗列功能清单，或执着单一物体反复展示 |
| **品牌情绪 / 片头 / 节拍片** | 画面与节拍先行（`--recipe visual`），先定视觉奇观与剪辑节奏 | 画面主导，声音贴画 | 长句旁白切碎镜头呼吸感 |

## 3. 传播力与听觉文案（详阅 `references/creator-playbook.md`）

- **前 3 秒钩子 + 0 秒静音首帧**：开场用反常识、痛点嘴替、终局倒叙、极端量级对比或静音视觉奇观建立认知缺口；静音看前 2 秒就能明白发生了什么异常。
- **中段留存**：用未闭合悬念环、认知滑梯或节奏换挡（景别跳切、`[停顿 0.5]`）替代平铺罗列；高潮闭环后利落收尾。
- **给耳朵写口播**：定清说话姿态（与 `voices.py` 选角和 `instruction` 联动）；长定语拆短句、消同音歧义、每 30 秒 ≤1–2 个承重数字；合成前跑 `_timing.py estimate` 摸底时长，超长直接砍字不靠拉倍速硬塞。
- **画幅语境**：`9x16` 信息流避开底部 ~20% 文案区与右侧互动栏；`16x9` 主动点播允许从容铺垫与宽空间调度。

## 4. 按需工具与可选门

- **调研与事实核查**：需要严谨事实时，读原页写 `docs/facts.md`（匹配词带单位，见 `references/facts-format.md`、`references/fact-check.md`），跑：
  `node <film-story>/scripts/factcheck.mjs --film <slug> [--also out/critique/onscreen.txt --strict]`
- **参考片拆解与运动量测**：拆参考片的钩子、节奏和运动手感（`scripts/motionprint.mjs` 量速度/静止占比/probe 跳变），见 `references/deconstruct.md`。
- **镜头设计与分镜对账**：每镜思考景别、运动动机与交棒方式（拒绝无理由整片正面平铺，见 `references/cinematography.md`）；需要严格校验锚点、叙事时长下限或 `claims` 时，才写 `docs/shotlist.md` 并跑 `python3 <film-story>/scripts/check_shotlist.py --film <slug> --write`。
- **可选门（`gates.json`）**：在 `film.json` `checks` 显式声明才开——`shotlist`（旧名 `divergence` 兼容）跑分镜对账；`facts.script` 跑台词事实对账。

## 下层文档（按需查阅）

- 传播与脚本：`references/creator-playbook.md`
- 像素比稿与配方：`references/lookdev.md` · `references/explainer.md` · `assets/recipes/explainer/` · `assets/recipes/visual/`
- 调研与拆解：`references/facts-format.md` · `references/fact-check.md` · `references/tools.md` · `references/deconstruct.md`
- 机制、镜头与分镜：`references/mechanism.md` · `references/divergence.md` · `references/cinematography.md` · `references/vocabulary.md` · `references/templates.md` · `references/claims.md`
- 脚本：`scripts/factcheck.mjs` · `scripts/check_shotlist.py` · `scripts/siblings.mjs` · `scripts/motionprint.mjs`
