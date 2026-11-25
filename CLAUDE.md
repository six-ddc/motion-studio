# motion-studio

这个仓库是 **film-\* skill 套件**的开发工作区，外加用它做出来的片子。

## 做片子

读 `film-core` skill 或直接用 `/film`。

```bash
node skills/film-core/scripts/new-film.mjs <slug> --format 9x16
node skills/film-core/scripts/render.mjs --film <slug> --draft     # 探索期快速小样（0.5x / sub=1 / veryfast）
node skills/film-core/scripts/deliver.mjs --film <slug>            # 定稿渲染 → 全部适用的门 → 冻结运行时 → receipt.json
```

片子在 `films/<slug>/`，产出进 `out/`。新片不拷运行时：服务器按"片内 `runtime/` 优先，否则套件挂载"解析 `/runtime/*`；`deliver` 过门后冻结进片子 `runtime/` 并写 `receipt.json`。

## 核心哲学：极薄内核 + 像素优先 + 释放自主性

这套东西刻意保持**极薄的一层**，只锁住时间驱动的底层物理契约，把其余全部自由还给模型：

1. **只有两条技术硬约束，其余全部可选**：
   - **时间纯函数（`kernel.md`）**：`window.seek(t)` 只由 `t` 与加载期常量决定，不读时钟/裸 `Math.random`/定时器，第三方库关闭自带循环改由 `t` 驱动，字体随片打包。
   - **有旁白同步时音频先行（`film-narration`）**：先合成拿字级时间戳 `narration.json`，画面事件与时长从 `vo.at()` / `vo.line()` 读，不手填猜测秒数。
2. **不限定风格、工具、UI 框架或动画库**：
   - 模型可以自由选用原生 Canvas 2D、SVG、HTML/CSS、WebGL/Shader、Three.js、PixiJS、GSAP、D3、Lottie、p5 或任意前端库，也可以自由组合真实/生成式图片、插画、纹理、3D 模型、视频片段与外部音轨（**混合管线**：代码负责精密时间轴、镜头调度、排版、交互与合成，视觉/听觉资产负责丰富质感，不必拿 2D 原语硬画一切）。
   - 套件自带的 `runtime/*.js`、`--recipe` 配方、各类文档模板和可选检查门都是**按需取用的杠杆，不是必须执行的仪式**。
3. **像素优先，而非文档先行（Think by Rendering）**：
   - 不靠长篇文字发散空想画面。风格未定前，直接写出 2–3 个真正不同方向的单帧 `look/*.html`，拼成 `out/lookdev.png` 给用户看图拍板，再写整片。
   - **探索期与交付期解耦**：创作探索期优先用 `--draft` 小样或硬件 GPU（`"backend": "gpu"`）大胆打磨审美、镜头张力和声音情绪；定稿确认后再走 `deliver` 完整确定性验收与冻结。
4. **追求作品感，对抗“做浅”**：
   - 不给效果模板、默认配色、默认字体或“禁止 X”的审美立法；只讲原理、在 `seek(t)` 下的难点和代价。
   - 目标是一支能发出去、有人看完和转发的片子，而不是能跑的课件或平涂演示。用“像素比稿 → 快速小样看节奏 → 陌生人盲审挑廉价感”来抬高成片上限。

## 改 skill

先读 `skills/film-core/references/kernel.md`、`skills/film-core/references/api.md` 和 `docs/MAINTAINING.md`。
往套件加内容前先问：**它是 `seek(t)` 或音频同步的硬契约吗？** 不是的话，就不要做成拦路的门、必写文档或强制依赖。依赖只有一个方向：能力 skill 只许 import `film-core`，跨能力走 `capability(name)`。

审美判据只来自每支片自己的 `films/<slug>/docs/style_guide.md`。每一条“不要 X”都要能改写成“X 的代价是 Y，什么时候值得付”。

## 合格线（可执行）

```bash
node skills/film-core/scripts/accept.mjs   # 查片子：已交付的对账收据，未交付的只报告（--deep 全跑门）
node dev/selfcheck.mjs                     # 查 skill：9 个 skill、依赖方向、gates.json、md 行数、语法
node dev/test.mjs                          # 回归：自测 + 阴性/阳性对照（--quick 跳过慢的三维夹具）
```

改完 skill 后三条都要过；改了门或运行时，再对受影响片子跑 `accept --deep`。API key 只放 `.env`。

## 环境既成事实

- Node + Playwright(Chromium 156)，`node_modules/` 在仓库根。默认用 `chromium_headless_shell-*`（与完整 Chrome 像素差 5.4–13.6%，字体回退不同），统一走 `film-core/lib/browser.mjs`。
- Python 在 `.venv/`：librosa、edge-tts、faster-whisper、truststore。
- **本机做 TLS 拦截**，Python 直连会 `CERTIFICATE_VERIFY_FAILED`，走 `truststore` 系统钥匙串（见 `film-narration` `make_ssl_context()`）。
- WebGL 默认软件渲染（SwiftShader），声明 `"backend": "gpu"` 可走 Apple Metal 硬件加速（快 3–10×）。**每种 context 必须用各自的 canvas**，同一 canvas 先取 `webgl` 再取 `webgl2` 返回 `null`。

## 目录

```
skills/film-core/    入口与内核：seek(t) 契约、共享 lib、基础运行时、渲染、内核门、deliver/freeze/accept
skills/film-*/       8 个按需能力 skill：motion webfx physics typography narration assets story critique
dev/                 开发工具：selfcheck、test（test-fixtures.json）、基准脚本（不随安装）
examples/            退出的效果模板，不随安装、不维护
tests/fixtures/      阴性/阳性对照夹具 _test-*（--films-dir tests/fixtures）
docs/                MAINTAINING.md、INTEGRATION.md、verified/<skill>.md
films/<slug>/        片子；已交付的带 receipt.json
.venv/               Python 环境
```
