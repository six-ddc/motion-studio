---
name: film-core
description: 用代码做视频的总入口与极薄内核。一支片子是 films/<slug>/ 里暴露 window.seek(t) 的网页，由 Playwright 逐帧截图、ffmpeg 编码成 MP4（可再转 GIF）。本 skill 建骨架、守住 seek(t) 纯函数契约与字体随片打包，提供可选的运动基元（弹簧、follow、种子随机、相机、节拍栅格、镜头组合子、事件表）、三画幅布局、空间锚点、内容变体与 kit，负责预览、并行与小样渲染、确定性验收 seamcheck、交付 deliver 与验收 accept，并指路其余 8 个按需能力 skill。用户说做个视频、生成视频、GIF 动图、做段动画、短片、解说片、科普片、数据故事片、产品演示片、片头、MV、竖版短视频，改一支已有的片子，写或改 scene.html，重渲某几秒、改画幅，排查"两次渲染不一样/成片闪烁/循环接缝跳/每帧截出来一样/CSS 动画或 WAAPI 截图不动"，或交付、验收一支片子时加载。
---

# film-core：用代码渲染视频的极薄内核

模型产出**程序**（暴露 `window.seek(t)` 的网页），渲染器按帧栅格逐帧截图并用 ffmpeg 编码。时间可任意跳转、支持局部重渲与并行编码，也能用上整个前端生态与外部/生成式素材。

路径记号：`<core>` 指本 skill 目录。脚本可从任意 cwd 调用，按 `--films-dir` > `$FILMS_DIR` > 向上查找 `films/` 定位；只有一部片子时可省略 `--film`。参数用 `--help` 查看。

## 1. 唯一无条件的契约（其余全部自由）

完整契约见 `references/kernel.md`（先读）。只有两条硬规则，其余一切（审美、技术栈、UI 框架、动画库、文档、可选检查）全部由你按本片自由决定：

1. **`seek(t)` 纯函数 + 字体随片打包**：`window.seek(t)` 的输出只取决于 `t` 和加载期常量。seek 期间不读时钟/随机/定时器（`Date.now`、`performance.now`、无参 `new Date()`、`Math.random`、`setTimeout`、`setInterval`、rAF），加载期随机用种子，第三方库关掉自带循环改由 `t` 驱动，字体文件随片打包。允许无外部可观测状态的缓存（以 `seamcheck` 通过为准）。
2. **有旁白同步时音频先行**：先由 `film-narration` 合成拿 `narration.json`，镜头边界与画面事件从 `vo.at()` / `vo.line()` 读，不手填秒数。

**自由选择技术栈与混合资产**：Canvas 2D、SVG、HTML/CSS、WebGL/Shader、Three.js、PixiJS、GSAP、D3、Lottie、p5 都可以直接用（接法见 `references/kernel.md` §3）；套件的 `runtime/*.js` 只是按需取用的便利件，不强制 import。遇到复杂有机插画、写实场景、材质纹理、3D 模型、视频或高质量配乐，直接走混合管线接入真实/生成式素材（见 `film-assets`），不必拿 2D 代码硬画一切。

## 2. 轻量创作闭环（像素优先，目标是一支能发的作品）

默认目标是一支**有审美、有钩子、有人愿意看完和转发的作品**，不是平涂演示或课件。最常见的失败是**做浅**（平涂 + 淡入 + 镜头不动 + 没声音情绪），其次是**写一堆文档却整片返工**。用最轻的流程同时防住这两件事：

1. **建最薄骨架**：`new-film.mjs <slug> --format 9x16`（横版加 `--format 16x9`）。不拷运行时，写 `import './runtime/x.js'` 即可由本地服务器在线挂载，交付时自动冻结。只有确实需要模板或预设检查时才加可选配方 `--recipe explainer` / `--recipe visual`。
2. **先在像素上拍板，再写整片（Lookdev 硬断点）**：只要用户没指定现成长相、也没明说"直接出完"，动手写完整时间轴前，先写 **2–3 个真正不同方向的单帧 `look/*.html`**（调子/材质/镜头/媒介感不同，不只换配色），用 `film-critique` 的 `stills.mjs --entries` 拼成 `out/lookdev.png` **交给用户挑**。定下后用半页 `docs/style_guide.md` 记下美术方向、3–5 个冲击点与素材取舍即可。
3. **探索期求快求美，交付期求稳**：迭代阶段直接用 `render.mjs --draft`（等价 `--scale 0.5 --sub 1 --preset veryfast`，产出进 `out/draft/`）；重 Shader/3D 在 `film.json` 写 `"backend": "gpu"` 走本机硬件 GPU（快 3–10×），大胆把光影、纵深和运动做足。
4. **改已有片子**：先读 `docs/style_guide.md` 和上一轮记录，核对目录 mtime 避免覆盖用户手改；改完只用 `render.mjs --from --to` 重渲改动区间。

```bash
node <core>/scripts/new-film.mjs <slug> [--format 16x9] [--recipe explainer|visual]
node <core>/scripts/new-film.mjs <新slug> --from <已有slug>       # 以已有片子另起一支（同源多版本用 content.json）
node <core>/scripts/preview.mjs --film <slug> [--format 9x16]     # 浏览器拖动预览
node <core>/scripts/render.mjs --film <slug> --draft              # 快速小样 → out/draft/
node <core>/scripts/render.mjs --film <slug> [--from 4 --to 7]    # 正式无声渲染 → out/silent-<format>.mp4
node <core>/scripts/deliver.mjs --film <slug>                     # 定稿渲染 → 全部门 → 冻结运行时 → receipt.json
```

## 3. 最小场景骨架与长片拆分

```html
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden}#stage{display:block}</style>
<canvas id="stage"></canvas>
<script type="module">
import { follow, seeded, spring } from './runtime/motion.js';
import { layoutFromURL } from './runtime/layout.js';

const L = layoutFromURL();                       // 也可单画幅直接写死像素
const cv = document.getElementById('stage'); cv.width = L.width; cv.height = L.height;
const c = cv.getContext('2d');
window.DURATION = 3;                             // 有旁白时在 ready 里按 narration.json 覆盖
const rnd = seeded(42);
const SP = spring({ duration: 0.5, overshoot: 0.08 });

window.seek = (t) => {
  c.clearRect(0, 0, L.width, L.height);
  const p = follow(t, [[0, 0], [0.1, 1]], SP);
  c.beginPath(); c.arc(L.cx, L.cy * p, L.size(0.05), 0, Math.PI * 2); c.fill();
};
window.ready = (async () => { /* await 字体、素材、narration.json */ })();
</script>
```

- **长片模块化**：超过 ~45 秒或多段落片子，建议把各段拆进 `shots/*.js`、`world.js`、`lib.js`，由 `scene.html` 按时间表或 `sequence()` 调度，避免单文件膨胀失控；服务器直接伺服片子目录下全部 ES 模块。
- **异步 seek**：`seek(t)` 可返回 Promise（如等 `<video>` 的 `seeked`），能同步尽量同步。
- **CSS/WAAPI**：加载期逐个 `pause()`，seek 里设 `currentTime`，并声明 `window.USES_WAAPI = true`（不声明会直接报错）；CSS `transition` 无法 seek。

## 4. 可选基础运行时（在线挂载，按需 import）

全部是 `t` 的纯函数，浏览器与 Node 共用；不用时完全可以不 import。

- **`./runtime/motion.js` & `./runtime/rand.js`**：
  - `spring({ duration, overshoot })` 闭式反解阻尼振子 + `settle(t, stiffness, damping)` + `follow(t, keyframes, sp)`（`SPRING` 含 `snappy/default/heavy/playful` 四个起点）。
  - `seeded(seed)`（加载期或 seek 内新建的顺序随机流）与 `hash01(...keys)`（按索引哈希，增删元素不串位）。
  - `camera(t, [[t, zoom, x, y], …], sp)` + `applyCamera(ctx, cam, w, h)`（zoom 对数插值）。
  - `beatGrid(bpm, offset, beatsPerBar)`；`sequence(shots, { overlap, align, marks })`（产出 `at(t)` 与 `Q.cuts`/`Q.windows`/`Q.marks`）；`sat lerp clamp norm win wrap`。
- **`./runtime/events.js`**：一张事件表 `[{t, type, …}]` 同时驱动光、粒子、屏震和声音（`channel`/`throttle`/`snapToFrames`/`toCues`，帧率读 `window.FILM.fps`），见 `references/events.md`。
- **`./runtime/layout.js`**：三画幅换算（`9x16` 1080×1920、`1x1` 1440×1440、`16x9` 1920×1080）：`layoutFromURL()`、`L.place(x,y)`、`L.size(n)`、`pick(L, {tall, wide, square})`。单画幅片不必强用。
- **`./runtime/anchors.js`**：绘制路径上登记屏幕框 `A.ctxRect(name, ctx, x, y, w, h)` / `A.box()`，`window.seek = A.install(draw)` 暴露 `window.anchors(t)` 给遮挡/出画检查与声像消费，见 `references/runtime.md` §5–6。
- **`./runtime/content.js` & `kits/`**：同源多变体（`content.json` + `render --variant/--matrix` 跨变体复用分片，见 `references/content-json.md`）；品牌/系列共享组件放顶层 `kits/<名>/`，`film.json` 声明 `"kits": ["..."]` 后 `import './runtime/kits/<名>/...'`（见 `references/kits.md`）。

## 5. 渲染、运动模糊与确定性验收

- **并行、清单与缓存**：帧间零依赖默认并行；逐帧哈希清单打印“改动影响了哪几秒”；分片缓存只重编像素变化的片段；首次渲染将浏览器/编码器指纹写入 `film.json renderer`。全参数见 `references/render.md`。
- **运动模糊**：`sub=1` 关闭（默认探索）；`sub=4–16` 均匀子帧平均；场景暴露 `window.MOTION(t0, t1)`（配合 `window.CUTS`）可开启自适应子帧（静止帧零额外成本，快速段自动加子帧）。
- **GIF 导出**：先渲 MP4 再两遍调色板：`ffmpeg -i out/silent-<fmt>.mp4 -vf "fps=15,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out/<slug>.gif`。
- **硬件 GPU 后端**：`film.json` 写 `"backend": "gpu"` 让 WebGL 走本机硬件 GPU（代价是像素跟显卡/驱动走，无 GPU 机器无法重渲）。

```bash
node <core>/scripts/seamcheck.mjs --film <slug> [--parallel 4] [--relaunch 2]  # 门 1a/1b/2/3/4/5 + 禁用 API 探针
node <core>/scripts/font_source.mjs --film <slug>                              # 随片字体来源检查（内核门）
node <core>/scripts/preflight.mjs --film <slug> [--variant <id>]               # 可选快速预检（checks 声明 "preflight"）
node <core>/scripts/deliver.mjs --film <slug> [--list|--phone|--compare <旧.mp4>]
node <core>/scripts/accept.mjs [--deep]                                        # 对账收据 / 全量跑门
```

**交付与门分层**：内核门（`seam` 1–5 + 探针 + `fontsrc`）永远开启；`uses` 门按实际加载的运行时触发；`checks` 门只跑 `film.json` 显式声明的项。`deliver` 全过后自动按合流记录重放混音、冻结运行时并写 `receipt.json`（详情见 `references/api.md`）。

## 6. 按需能力地图（不按死流程切分）

| skill | 管什么 | 何时加载 |
|---|---|---|
| `film-story` | 钩子与传播力、按需调研与事实核查、风格帧比稿、镜头设计、分镜对账 | 立意、写稿、查事实、设计镜头、防像 PPT |
| `film-motion` | 2D 动效原理与代价（缓动、转场、矢量路径与变形、透视、界面重建、图表） | 转场、路径/变形、数据图、产品 UI 重建 |
| `film-webfx` | GLSL 着色器、后期（泛光/景深/颗粒/调色）、多 pass 反馈、Three.js 三维 | 光影、材质、后期、3D 场景与模型 |
| `film-physics` | 可 seek 的粒子、弹跳、碰撞、布料、群集、跟车链、打击反馈（顿帧/屏震） | 物理运动、粒子爆发、打击手感 |
| `film-typography` | 字体加载与缺字保障、拆字/CJK 排版、文字动效、画面内字幕、可读性下限 | 标题大字、动态排版、内嵌字幕、字发虚 |
| `film-narration` | TTS 旁白与字级时间戳、`vo.at()`、音效/配乐/节拍、混音合流、转写校验 | 有配音、音效、配乐、卡点或合流 |
| `film-assets` | 混合素材（图/插画/视频/模型/音轨/字体）获取、字体子集化、转码、自包含检查 | 找/处理外部或生成式素材、中文字体子集化 |
| `film-critique` | 静帧闸门、转场图、对照图、客观检查、陌生人盲审视角 | 比稿、看效果、自检挑刺、交付前复核 |

## 7. 何时不用这套 & 下层文档

单张静图直接画；纯剪辑现成素材直接用 ffmpeg；超 2 分钟长片拆段渲染再拼接。

- `references/kernel.md`：内核契约、Clip 适配器、门 1–5、症状表
- `references/api.md`：共享 lib 签名、`capability`、`gates.json`、`checks`、`receipt.json`、配方格式
- `references/runtime.md`：目录约定、挂载与冻结、浏览器钉版本、层间数据与空间锚点
- `references/render.md`：render / seamcheck / preview 参数全集、缓存、后端
- `references/film-json.md` · `references/content-json.md` · `references/events.md` · `references/kits.md` · `references/preflight.md` · `references/nondeterminism.md` · `references/pitfalls.md` · `references/style-menu.md`
