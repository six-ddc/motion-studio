# 解说与叙事片配方：从 brief 到交付

目录：1. 流程与分工 · 2. 各环节要点 · 3. 音频先行的四条保证 · 4. 声明的检查 · 5. 中途停下

这是**参考协作配方，不是死流程**。有旁白且要求音画同步时，唯一的技术硬约束是**音频先行**（不遵守会让画面与声音漂移）；至于先构思视觉机制、先抓冲突故事线还是先打磨 KOL 痛点钩子，完全随题型调整（见 `SKILL.md` §1 路由表与 `references/creator-playbook.md`）。非旁白驱动的片子按自身时间源排序：配乐卡点片以节拍栅格为先（`--recipe visual`），Lottie 片以 AE 时间线为准，仿真片以模拟步进为准。

`node <film-core>/scripts/new-film.mjs <slug> --recipe explainer` 对新片和已有片子都适用：它会补齐文档模板，并在 `film.json` 的 `checks` 里声明常用客观护栏。配方文件在 `assets/recipes/explainer/`（格式见 film-core `references/api.md` §7）。

## 1. 流程与分工

| 环节 | 产出 | 谁管 |
|---|---|---|
| 立项定位 | `docs/brief.md`（目标、平台、受众误区、说话姿态、调性换算） | 本配方 + `creator-playbook.md` |
| 调研（按需） | `docs/memory-snapshot.md`、`docs/facts.md` | film-story「调研与事实对账」 |
| 主轴与视觉 | `docs/mechanism.md`、`docs/style_guide.md` | film-story（机制 / 叙事弧线 / 近作对照） |
| 台词与合成 | `script.json` → `narration.json` | film-story（听觉文案）+ film-narration（选音色、合成、时间戳） |
| 分镜对账 | `docs/shotlist.md` | film-story `check_shotlist.py` |
| 实现 | `scene.html` | film-core（契约），以及 film-motion / film-typography / film-physics / film-webfx；素材归 film-assets |
| 静帧闸门、自检 | `out/stills.png`、`out/critique/`、`docs/review_log.md` | film-critique |
| 音效、合流、校验 | `out/final-<画幅>.mp4` | film-narration |
| 交付 | `receipt.json` | film-core `deliver.mjs` |

## 2. 各环节要点

- **brief**：先定画幅、目标时长、传播目的（涨粉转发 / 收藏干货 / 种草转化）与说话姿态（人设）。`9x16` 信息流与 `16x9` 主动点播的开场耐心和遮挡区完全不同（`creator-playbook.md` §5）。
- **调研**：涉及真实数据、历史、科学或行业案例时必做；纯虚构或纯视觉演绎可跳过。"我记得这个"不是跳过的理由。
- **主轴、钩子与视觉方向**：原理题找准承重视觉机制，故事/观点/产品题找准冲突弧线或痛点反差，并设计好前 3 秒停留钩子与 0 秒静音首帧；动笔前可跑 `siblings.mjs` 对照近作避免无意识撞脸。
- **风格帧**（可选）：视觉方向的候选各画一帧，拼图后交给用户挑，再排分镜（`lookdev.md` §2）。没有参考锚的新片最值得做。
- **台词与旁白**：用给耳朵听的短句写进 `script.json`，先跑 `_timing.py estimate` 摸底时长再调 `tts.py`（见第 3 节）。有配乐的片子去 film-narration 跑节拍栅格。
- **分镜**：锚点负责对齐字词时刻，重要转折在 `segments` 里保证屏幕停留秒数。
- **粗剪预演**（可选）：实现时先让全片以占位形状按真实时刻跑通，出小样确认节奏，再逐镜精修（`lookdev.md` §3）。
- **静帧闸门**：先出 3–5 张关键静帧拼图来看（film-critique `stills.mjs`），方向错了也只损失几十秒。形似问题（殿宇被看成一张脸）只有看静帧才会发现。
- **渲染与自检**：迭代阶段用小样参数 `render.mjs --scale 0.5 --sub 1 --preset veryfast`（产物放进 `out/draft/`；细线和小字的可读性要用全分辨率判断）。打分记在 `docs/review_log.md`，没有人看过的主观项标"未经人眼确认"。
- **交付**：`node <film-core>/scripts/deliver.mjs --film <slug>` 依次执行定稿渲染、内核门、用到了才开启的门、声明的检查、冻结运行时，最后写 `receipt.json`；任何一步报红就不写收据。

## 3. 音频先行的四条保证

1. **音频先行**：先合成旁白，拿到真实时长和字级时间戳（写稿期可用 `_timing.py estimate` 零成本预估）。
2. **时长回写**：镜头的 `end` 由实测的 WAV 时长决定，不手填秒数。
3. **关键词与区间触发**：事件绑定在字词或语义区间上，写 `vo.at('纯函数')` 或 `vo.span('rule')`，不写死 `3.2`。
4. **事后校验**：对成片音轨重新转写，和脚本比对，检查错字和漂移。

**音频先行的代价**：镜头若机械地一句一镜，画面容易沦为等长配图。缓解做法：按状态阶段或认知换挡切镜；用 `gap` 或行内 `[停顿 0.5]` 给无词视觉冲击留呼吸空间；把长句拆给景别递进的两三个镜头；需要叠化/匹配交接时声明 `overlap`。若镜头节奏本身重于台词（宣传片、片头、MV），改用 `--recipe visual`（`lookdev.md` §5）。

## 4. 声明的检查

`--recipe explainer` 会在 film.json 的 `checks` 里并入以下默认检查（已有的不动；若还想强制检查多方案比选留痕，可手动往 `checks` 加 `"divergence"`）：

| id | 认领方 | 查什么 |
|---|---|---|
| `shotlist`（可选加 `divergence`） | film-story（`check_shotlist.py`） | 分镜锚点、覆盖与交叠、重要区间时长、旁白状态断言；（加了 `divergence` 时再查比选留痕） |
| `facts.script` | film-story（`factcheck.mjs`） | 旁白数字与事实对账（自动忽略行内语气/停顿/区间标记） |
| `verify` | film-narration（`align.py --verify`） | 对成片音轨重新转写 |
| `narration` `mp4` `truepeak` `loop` `readability` `contrast` `facts.screen` `style-guide` `laws` `still` `empty` `marks` `claims` `tilt` `page` | film-critique（`check.mjs`） | 见 film-critique `references/checks.md` 第 0 节 |

这些检查在 deliver 时才统一把关。做风格帧和粗剪的阶段不需要先让它们变绿：那时该花注意力的是画面，客观项留到实现之后一次清。
声明了检查却没装认领它的 skill，就算缺少能力，deliver 会拒绝交付。不想要某一项就从 `checks` 里删掉：这些都是质量护栏，不是契约。

## 5. 中途停下

`docs/PROGRESS.md` 只记当前的问题和下一步（几行即可，过时就删）；做过什么去看 review_log 和 git。
