# 风格、技术栈与创作思路菜单

**这是菜单，不是规定。** 只要守住 [`kernel.md`](kernel.md) 的 `seek(t)` 纯函数契约，这里的一切都能自由组合、混用或完全无视。不推荐、不排名、不放固定模板。

## 1. 自由选用的前端技术栈与混合资产

| 路线 | 擅长什么 | 接入 `seek(t)` 的要点（详情见 `kernel.md` §3） |
|---|---|---|
| **HTML / CSS / Tailwind / DOM** | 现代 UI、发布会网页、排版网格、毛玻璃、复杂布局 | 静态/JS 驱动样式天然纯函数；CSS 动画需 `pause()` + `currentTime` + `USES_WAAPI = true`，不用 `transition` |
| **Canvas 2D / SVG** | 精确矢量图解、数据图表、粒子、动态排版、细粒度控制 | 直接按 `t` 绘制；SVG 路径动画或 `Path2D` 都很顺手 |
| **WebGL / GLSL / Three.js** | 光影、材质、纵深、流体/烟雾/扭曲、立体镜头与 PBR 场景 | 关掉 rAF/`Clock`，`uniform` 全量传入；三维保留式场景图每帧复位（`film-webfx`）；探索期可用 `"backend": "gpu"` |
| **动画与图形库（GSAP / D3 / PixiJS / Lottie / p5）** | 成熟时间轴、复杂图表、现成 AE 动效、生成艺术 | 关掉自带 ticker/rAF，用 `tl.seek(t)` / `goToAndStop(t*fps, true)` / `redraw()` 由 `t` 驱动 |
| **混合资产（Hybrid Pipeline）** | 写实画面、复杂插画、真实纹理/HDRI、3D GLB 模型、实拍/AI 视频片段、真实配乐与拟音 | 放进 `assets/` 随片自包含（`film-assets`），代码专注镜头调度、合成、排版与精准卡点，**不要拿 2D 原语硬画一切** |

## 2. 外部设计 skill（可选整套采用）

可在 `docs/style_guide.md` 写明采用某个外部设计 skill 的视觉方向（本机路径 `~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/<名字>/SKILL.md`）：
- **frontend-design**：Design Thinking（明确定调、一个最难忘的核心元素、intentionality not intensity）；接入时把 CSS 动效改成 `seek(t)` 驱动、字体随片打包。
- **canvas-design**：静态美学宣言与构图体系，动效与节奏由本片补足。
- **algorithmic-art**：p5.js 生成艺术（噪声场、流场、粒子），把 `random()`/`frameCount`/`millis()` 改为由种子和 `t` 计算。
- **theme-factory**：现成色板与字体主题，出片快但易撞脸，适合明确想要系列统一或极速出稿的场景。

## 3. 常见做片思路（按题型自选）

| 思路 | 核心抓手 | 去哪看 | 代价 |
|---|---|---|---|
| **像素先行比稿** | 写整片前先出 2–3 个不同方向的单帧 `look/*.html`，拼图拍板 | `film-story/references/lookdev.md` | 多花几分钟，换来避免整片推倒重做 |
| **视觉机制驱动** | 把核心变量映射成连续变化的视觉变量（适合原理/算法/金融/物理） | `film-story/references/mechanism.md` | 人物故事、KOL 观点或产品演示强套单一变量会生硬 |
| **KOL 钩子与转化弧线** | 前 3 秒认知缺口、静音首帧、未闭合悬念环、痛点→爽点→CTA | `film-story/references/creator-playbook.md` | 钩子过猛而证据弱像标题党 |
| **音频先行 / 画面先行** | 旁白主导读 `vo.at()`；节奏主导用 `--recipe visual` + 节拍/时刻表 | `film-narration` / `lookdev.md` §5 | 音频先行防漂但易成句锁配图；画面先行需台词迁就镜头 |
| **游戏与模拟思路** | ECS、定步重放、顿帧/屏震/闪白多通道冲击、精灵表帧动画 | `film-physics` / `film-core/references/events.md` | 增量状态需经 `createReplay` 保乱序一致 |

想知道新片有没有无意识撞脸已有片子，直接跑 `node <film-story>/scripts/siblings.mjs --film <slug>` 看 `out/siblings.png`（重复本身不是错，系列片有意沿用只需写明）。
