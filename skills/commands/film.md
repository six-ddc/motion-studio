---
description: 用代码渲染一支视频：建 films/<slug>/ 骨架（默认内核骨架，可选配方），按片子自己的时间真相源推进到成片，deliver 交付
argument-hint: [主题或 slug，可带 --format 9x16 等]
---

读 `film-core` skill，按它的说明做一支片子。唯一无条件的是它的 `references/kernel.md`（seek(t) 纯函数）；
其余流程是可选配方，风格是菜单不是规定。

用户给的是：$ARGUMENTS

如果上面是空的，先问清三件事再动手——**时长、画幅、主题**，这三个定了之后改动成本最高。

默认建内核骨架（`new-film.mjs <slug>`），不写文档、不拷运行时（`import './runtime/x.js'` 直接用）。
是解说、科普、KOL 观点或产品种草片时可以用配方（`--recipe explainer`：按题型选切入路线与前 3 秒钩子 → 按需调研 → 音频先行 → 分镜对账 → 实现 → 自检）；
画面与节拍主导的宣传片、片头、MV 可用 `--recipe visual`；Lottie 片、游戏或模拟驱动的片子按各自的时间真相源排序（见 film-core 的 `references/style-menu.md`）。
有旁白同步需求时坚持音频先行；构思画面时警惕滑向"最好写代码的通用卡片网格"——先按题型定好视觉机制或证据反差（见 `film-story`）再动手写代码。

做完用 `deliver.mjs --film <slug>` 交付：定稿渲染、全部门、冻结运行时、写收据。没有收据的片子不算做完。

如果上面给的是一个已存在的 `films/<slug>/`，不从 brief 重来：读那支片的 `docs/`（尤其 `style_guide.md`，那是它的法律），
改，只重渲改动的那几秒，跑门，再 deliver。
