# 像素优先：风格帧比稿、粗剪预演与画面先行

长相和节奏只在文字里定，等到整片渲完才第一次被看见，改动成本最高。下面两步把关键判断挪到最便宜的时刻，**不在 Markdown 里空想画面，直接用像素说话**。

## 1. 风格帧比稿（硬确认点，防整片返工）

只要用户没指定现成长相、也没明说"直接出完"，写整片时间轴前先出 **2–3 个真正不同方向的单帧**：

- **差异要大**：两两之间至少有两个维度不同（明暗调子、材质/媒介感、2D/3D/网页视觉语言、镜头视角、字的身份），不要同一种画法只换配色；至少放一个跳出第一反应的大胆方向。
- **画承重那一刻且画到位**：每个方向写一页 `films/<slug>/look/<名>.html`（暴露 `#stage`、`window.seek`、`window.DURATION`、`ready`，用真实文案、随片字体或真实素材）。再问一句：这个方向换到**另一镜**（景别或机位不同）还成立吗？拿不准就给该方向多画一帧另一镜，或用 `seek(0.1)` 与 `seek(0.9)` 看动前后两态。
- **拼图让用户拍板**：
  ```bash
  node <film-critique>/scripts/stills.mjs --film <slug> --entries look/a.html,look/b.html,look/c.html
  node <film-critique>/scripts/stills.mjs --film <slug> --entries look/a.html,look/b.html --at 0.1,0.9
  ```
- 用 Read 打开 `out/lookdev.png`，**先展示给用户挑选方向**（没人在场或用户说"直接出"时自己选并简记理由）。选定那一页就是 `scene.html` 的起点；`look/` 不计入收据输入摘要，落选页面可保留作对照，不必在 `deliver` 前删除。
- **参考锚**：若用户给了参考片/图/网站，在 `docs/style_guide.md` 写明取哪几个维度、不取什么；运动手感可用 `motionprint.mjs` 量，取色可用 `film-assets` 的 `media.mjs tiles`。

## 2. 粗剪预演（多镜头长片按需）

15 秒以上多镜头或强节奏片，在精修每个镜头前，可先用占位块 + 真实镜头时刻/相机运动跑通一遍时间轴：
- `node <film-core>/scripts/render.mjs --film <slug> --draft` 出低分小样进 `out/draft/`，或跑 `contact.sh` 看全局节奏。
- 看哪一镜太拖/太赶、景别有没有变化、开头 2 秒抓不抓人；确认节奏后再逐镜把美术和细节做精。

## 3. 画面先行配方（`--recipe visual`）

适合宣传片、片头、MV、logo 演绎、产品秀这类**镜头节奏重于台词**的片子：
`node <film-core>/scripts/new-film.mjs <slug> --recipe visual`

- **时间真相源**：有配乐就先定曲子并读 `beats.json` / `music.json`；无配乐无旁白就在代码顶部放一张具名时刻表（`const T = { open: 0, turn: 2.4, … }`），全片只引用名字。
- **从属旁白**：先定镜头再写词合成，合成后画面对点仍读 `vo.at()`；句长超出镜头时调词、调语速或微调镜头时长。
- **默认检查**：只开 `page`、`mp4`、`readability`、`hook`、`motion`、`variety`（其中后三项只报 LOOK，永不拦交付）。
