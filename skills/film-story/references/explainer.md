# 解说与叙事片协作指南（`--recipe explainer`）

轻量参考协作流，不是死板八股。有旁白同步时唯一硬约束是**音频先行**；其余步骤和文档均按题型与复杂度取舍。

```bash
node <film-core>/scripts/new-film.mjs <slug> --format 9x16 --recipe explainer
```

## 精简节奏

1. **像素定调**：需要定长相时先出 2–3 个方向单帧 `look/*.html` → `out/lookdev.png` 让用户拍板，简记进 `docs/style_guide.md`（见 `references/lookdev.md`）。
2. **按需调研**：涉及客观数据、历史、科学或真实产品参数时查原页记 `docs/facts.md`；虚构或观点片可跳过。
3. **音频先行**：写听觉化台词进 `script.json`（先跑 `_timing.py estimate` 摸底时长）→ `tts.py` 合成拿到实测 `narration.json`；片头/片尾留白只写 `film.json` 的 `narrationOffset` / `narrationTail`。
4. **实现与快速迭代**：自由选前端技术与混合素材写 `scene.html`（长片拆 `shots/*.js`），用 `vo.at()` / `vo.line()` 绑事件与镜头边界；探索期用 `render.mjs --draft`（3D/重着色器可开 `"backend": "gpu"`）快速看节奏与效果。
5. **盲审与交付**：看静帧/转场图 + 陌生人盲审修掉廉价感；`mux.sh` 合流 → `deliver.mjs` 交付写 `receipt.json`。

**避免句锁配图**：不要机械地一句切一镜；按状态转折或情绪换挡切镜，用 `gap` / `[停顿 0.5]` 留视觉呼吸，长句可拆给景别递进的 2–3 镜。

## 配方默认声明的检查

`--recipe explainer` 默认只开启高信噪比的核心客观检查：`verify`、`narration`、`mp4`、`truepeak`、`readability`、`page`，外加只报 LOOK、永不拦交付的 `variety`（提醒是否一个机位到底）。
如果本片写了 `docs/facts.md`、`docs/shotlist.md` 或 `style_guide` 里的机读 `critique` 法律，再按需往 `film.json` 的 `checks` 追加 `facts.script`、`shotlist`、`claims`、`laws`、`contrast`、`tilt`、`still`、`empty`、`marks` 等即可。
