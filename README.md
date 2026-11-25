# motion-studio

一套让 AI 用代码做视频的极薄 skill 套件。模型产出一个暴露 `window.seek(t)` 的网页程序，Playwright 逐帧调用并截图，ffmpeg 编码成 MP4（或转 GIF）。

```
台词 ──TTS──> 旁白音频 + 字级时间戳（narration.json）
                   │  （无旁白片可用配乐节拍或具名时刻表）
                   ├──> 镜头边界 & 动画触发（vo.at('关键词')）
                   └──> 字幕（稿子文字 + token 时间）
                             │
seek(t)（自由选用 2D / 3D / Shader / HTML+CSS / 第三方库 / 混合素材）
   ──Playwright 并行截图──> ffmpeg ──> MP4
```

## 设计哲学：极薄内核 + 释放创造力

整套系统只守两条硬约束，其余全部保持轻量与开放：

1. **`seek(t)` 是时间的纯函数 + 字体随片打包**：任意 `t` 都能精确求值，换来并行渲染、局部重渲、分片缓存和零闪烁确定性。
2. **有旁白同步时音频先行**：动画和字幕读取实测字级时间戳，改词重录不漂移。

除此之外，**不规定审美、不给效果模板、不限定技术栈或动画库**：Canvas 2D、SVG、HTML/CSS、Three.js、GLSL、GSAP、PixiJS、Lottie 均可按需接入，也鼓励用**混合管线**（代码做精准时空编排、排版与合成，真实或生成式图片/模型/视频/音轨补足视觉与听觉质感）。

## 套件结构（9 个 skill）

`film-core` 是总入口和内核，其余 8 个按需加载：

| skill | 负责什么 |
|---|---|
| `film-core` | 建骨架、`seek(t)` 契约、可选运动/布局/锚点/事件基元、小样与并行渲染、确定性验收、交付与冻结 |
| `film-story` | 传播钩子与听觉脚本、像素优先风格帧比稿、按需调研核查、视觉机制与镜头设计、分镜对账 |
| `film-motion` | 2D 动效原理与代价：缓动、交错、转场、路径生长与变形、透视、界面重建、动态图表 |
| `film-webfx` | GLSL 着色器、后期处理、多 pass 反馈、SVG 滤镜、按帧驱动的 Three.js 三维 |
| `film-physics` | 可 seek 物理（闭式解 / 定步重放 / 预烘焙）、粒子、碰撞、布料、群集、打击手感 |
| `film-typography` | 字体保障、拆字与 CJK 排版、可变轴、文字动效原理、画面内字幕绘制、可读性下限 |
| `film-narration` | 旁白 TTS 与字级时间戳、音效、节拍与原创配乐、混音合流、成片转写校验 |
| `film-assets` | 混合素材（图/插画/视频/模型/音轨/字体）获取与处理、字体子集化、自包含检查 |
| `film-critique` | 静帧与转场拼图、接触表、客观检查、陌生人盲审视角 |

## 安装与使用

```bash
# 依赖：Node 18+、ffmpeg
npm install
npx playwright install chromium

# 需要旁白、音频分析或字体子集化时安装 Python 环境
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # 填火山引擎豆包语音 key（无 key 可用 edge-tts 兜底）
```

在仓库内直接对话或使用 `/film` 即可（`.claude/skills/` 已链接到 `skills/`）。安装到其他项目时拷 `skills/film-*` 到 `~/.claude/skills/`，`skills/commands/film.md` 到 `~/.claude/commands/`。

常用命令：

```bash
node skills/film-core/scripts/new-film.mjs my-film --format 9x16          # 最薄内核骨架（可选 --recipe explainer|visual）
node skills/film-core/scripts/preview.mjs --film my-film                  # 浏览器拖动预览
node skills/film-core/scripts/render.mjs --film my-film --draft           # 探索期快速小样 → out/draft/
node skills/film-core/scripts/render.mjs --film my-film --from 4 --to 7   # 局部重渲
node skills/film-core/scripts/deliver.mjs --film my-film                  # 定稿渲染 + 门 + 冻结运行时 + receipt.json
node skills/film-core/scripts/accept.mjs                                  # 对账已交付片子
```

## 开发验证

```bash
node dev/selfcheck.mjs      # 套件结构、依赖方向、gates.json、装机 md 行数、语法
node dev/test.mjs           # 自测与阴性/阳性对照（--quick 跳过慢三维夹具）
```

## 许可证

[Apache-2.0](LICENSE)。
