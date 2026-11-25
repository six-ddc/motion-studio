---
description: 用代码渲染一支视频：极薄 seek(t) 内核 + 像素优先风格帧比稿 + 自由技术栈与混合素材，按时间真相源推进到成片
argument-hint: [主题或 slug，可带 --format 9x16 等]
---

读 `film-core` skill，按它的说明做一支片子。

用户给的是：$ARGUMENTS

## 工作方式（轻量、像素优先、不锁技术栈）

1. **先明确三件事**（若上面未给）：**主题、时长、画幅（默认 9x16）**。已存在的 `films/<slug>/` 直接读它的 `docs/style_guide.md` 与现状，局部修改重渲即可。
2. **只守两条硬约束，其余自由发挥**：
   - `window.seek(t)` 是 `t` 的纯函数 + 字体随片打包（见 `film-core/references/kernel.md`）。
   - 有旁白同步时**音频先行**：先用 `film-narration` 合成拿到 `narration.json`，所有镜头边界与事件读 `vo.at()` / `vo.line()`，绝不手填秒数。
   - **不限技术栈、框架、动画库或素材来源**：Canvas 2D、SVG、HTML/CSS、Three.js、Shader、GSAP、PixiJS、Lottie，以及真实/AI 生成的图片、插画、模型、视频和配乐都能混用；长片自由拆成多模块（如 `shots/*.js`）。`runtime/*.js` 和 `--recipe` 都是可选工具，不是硬性规定。
3. **像素优先比稿（硬确认点，防整片返工）**：
   - 只要用户没指定现成长相、也没明说"直接出完"，先建最薄骨架 `new-film.mjs <slug>`，在写整片之前先用几分钟写出 **2–3 个真正不同方向的单帧 `look/*.html`**，跑 `stills.mjs --entries` 拼出 `out/lookdev.png`，**先给用户看图拍板方向，再写整片**。
   - 决定落盘为简短的 `docs/style_guide.md`（半页写清美术方向、核心冲击点、声音与素材取舍即可，不必写长篇八股）。
4. **快速迭代 + 陌生人盲审 + 按需交付**：
   - 探索期用 `render.mjs --draft`（3D/重着色器片在 `film.json` 加 `"backend": "gpu"`）快速出小样看动态、节奏和声音情绪；不要为了省算力退回平涂课件。
   - 出终稿前看静帧、转场图并做一次**陌生人盲审**（不看代码和说明，只看画面挑“哪儿显廉价、第几秒会划走”）。用户点头定稿后再跑 `deliver.mjs --film <slug>` 过门、冻结运行时、写 `receipt.json`。
