---
description: 用代码渲染一支视频：建 films/<slug>/ 骨架（默认内核骨架，可选配方），按片子自己的时间真相源推进到成片，deliver 交付
argument-hint: [主题或 slug，可带 --format 9x16 等]
---

读 `film-core` skill，按它的说明做一支片子。唯一无条件的是它的 `references/kernel.md`（seek(t) 纯函数）；
其余流程是可选配方，风格是菜单不是规定。

用户给的是：$ARGUMENTS

如果上面是空的，先问清三件事再动手——**时长、画幅、主题**，这三个定了之后改动成本最高。

默认建内核骨架（`new-film.mjs <slug>`），不写文档、不拷运行时（`import './runtime/x.js'` 直接用）。
是解说片、科普片时可以用配方（`--recipe explainer`：调研 → 机制 → 音频先行 → 分镜 → 实现 → 自检）；
配乐片、Lottie 片、游戏或模拟驱动的片子按各自的时间真相源排序（见 film-core 的 `references/style-menu.md`）。
走解说片配方时，机制那一步最容易被跳过，跳过的代价是退回"最好写代码的那个画法"——值不值得慢下来，由片子定。

做完用 `deliver.mjs --film <slug>` 交付：定稿渲染、全部门、冻结运行时、写收据。没有收据的片子不算做完。

如果上面给的是一个已存在的 `films/<slug>/`，不从 brief 重来：读那支片的 `docs/`（尤其 `style_guide.md`，那是它的法律），
改，只重渲改动的那几秒，跑门，再 deliver。
