# 解说片配方：从 brief 到交付

目录：1. 流程与分工 · 2. 各步要点 · 3. 音频先行的四条保证 · 4. 声明的检查 · 5. 中途停下

这是**配方，不是契约**。有旁白时唯一的技术约束是**音频先行**（不遵守的话，画面会和声音漂开）；其余顺序都是推荐做法。不是解说片时，按片子自己决定时间的数据来源排序：配乐片以节拍为先，Lottie 片以 AE 时间线为准，游戏或模拟片以仿真为准（思路菜单见 film-core 的 `references/style-menu.md`）。

`node <film-core>/scripts/new-film.mjs <slug> --recipe explainer` 对新片和已有的片子都适用：它会补齐文档模板，并在 film.json 的 checks 里声明这套流程用到的检查。配方文件在 `assets/recipes/explainer/`（`recipe.json` 列出要写哪些模板、要并入哪些 film.json 字段、要声明哪些检查；格式见 film-core `references/api.md` §7）。模板由各自的 skill 提供，哪个 skill 没装，就写一个占位并给出提示。

## 1. 流程与分工

| 步 | 产出 | 谁管 |
|---|---|---|
| brief | `docs/brief.md` | 本配方 |
| 调研 | `docs/facts.md`（另有 `docs/memory-snapshot.md`） | film-story「调研」 |
| 机制 | `docs/mechanism.md`、`docs/style_guide.md` 顶部的视觉方向 | film-story 第 1–3 步 |
| 旁白 | `script.json` → `narration.json` | film-narration |
| 分镜 | `docs/shotlist.md` | film-story 第 4–6 步 |
| 实现 | `scene.html` | film-core（契约），以及 film-motion / film-typography / film-physics / film-webfx；素材由 film-assets 负责 |
| 静帧闸门、自检 | `out/stills.png`、`out/critique/`、`docs/review_log.md` | film-critique |
| 音效、合流、校验 | `out/final-<画幅>.mp4` | film-narration |
| 交付 | `receipt.json` | film-core `deliver.mjs` |

## 2. 各步要点

- **brief**：写清主题、受众、时长、画幅、调性和硬性要求。时长和画幅一旦定下，之后改动的成本最高，没说清楚就先问。
- **调研**：只有主题纯属抽象、没有需要核实的数字和日期时才可以跳过；"我知道这个"不是跳过的理由。
- **机制**：这是最该慢下来的一步，跳过它，画面就会退回到"最好写代码的那个画法"。同一步里还要发散讲法和视觉方向（先跑 `siblings.mjs`）。
- **风格帧**（可选）：视觉方向的候选各画一帧，拼图后交给用户挑，再排分镜（`lookdev.md` §2）。没有参考锚的新片最值得做。
- **旁白**：见第 3 节；有音乐的片子去 film-narration 跑节拍栅格。
- **分镜**：锚点负责对齐，但管不了承重事件该分到几秒（SKILL.md 第 5 步）。
- **粗剪预演**（可选）：实现时先让全片以占位形状按真实时刻跑通，出小样确认节奏，再逐镜精修（`lookdev.md` §3）。
- **静帧闸门**：先出 3–5 张关键静帧，拼成一张图来看（film-critique `stills.mjs`），方向错了也只损失几十秒。形似问题（殿宇被看成一张脸）只有看静帧才会发现。
- **渲染与自检**：迭代阶段用小样参数 `render.mjs --scale 0.5 --sub 1 --preset veryfast`（产物放进 `out/draft/`；细线和小字的可读性要用全分辨率判断）。自检分三类：客观项（由脚本判断）、本片项（读 style_guide）和倾向性提醒；打分记在 `docs/review_log.md`，没有人看过的主观项标"未经人眼确认"。
- **交付**：`node <film-core>/scripts/deliver.mjs --film <slug>` 依次执行定稿渲染、内核门、用到了才开启的门、声明的检查、冻结运行时，最后写 `receipt.json`；任何一步报红就不写收据。

## 3. 音频先行的四条保证

1. **音频先行**：先合成旁白，拿到真实时长和字级时间戳。
2. **时长回写**：镜头的 `end` 由实测的 WAV 时长决定，不手填秒数。
3. **关键词触发**：事件绑定在某个字被念到的那一刻，写 `vo.at('纯函数')`，不写死 `3.2`。
4. **事后校验**：对成片音轨重新转写，和脚本比对，检查错字和漂移。

**音频先行的代价**：镜头长度由句子决定，画面容易沦为台词的配图，连续几镜一样长。几种缓解，按需取用：按机制状态切镜头而不是按句子切（SKILL.md 第 5 步）；用 `gapAfter` 或台词里的停顿标记给无词镜头留时间；把一句话拆给两三个景别不同的镜头。如果这支片子的镜头节奏比台词重要（宣传片、片头、MV），换用画面先行配方 `visual`（`lookdev.md` §5），让旁白去迁就镜头。

## 4. 声明的检查

`--recipe explainer` 会在 film.json 的 `checks` 里并入以下检查（已有的不动）：

| id | 认领方 | 查什么 |
|---|---|---|
| `shotlist` `divergence` | film-story（`check_shotlist.py`） | 分镜对账；讲法、视觉方向和近作对照的留痕 |
| `facts.script` | film-story（`factcheck.mjs`） | 旁白数字对账 |
| `verify` | film-narration（`align.py --verify`） | 对成片音轨重新转写 |
| `narration` `mp4` `truepeak` `loop` `readability` `contrast` `facts.screen` `style-guide` `laws` `still` `empty` `marks` `claims` `tilt` `page` | film-critique（`check.mjs`） | 见 film-critique `references/checks.md` 第 0 节 |

这些检查在 deliver 时才统一把关。做风格帧和粗剪的阶段不需要先让它们变绿：那时该花注意力的是画面，客观项留到实现之后一次清。
声明了检查却没装认领它的 skill，就算缺少能力，deliver 会拒绝交付。不想要某一项就从 `checks` 里删掉：这些都是质量护栏，不是契约。

## 5. 中途停下

`docs/PROGRESS.md` 只记当前的问题和下一步（几行即可，过时就删）；做过什么去看 review_log 和 git。
