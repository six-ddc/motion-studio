---
name: film-assets
description: 为代码渲染视频提供与处理外部及生成式素材（混合管线）：字体获取与中文字体子集化、矢量图标转 canvas path、照片/插画/AI生成图/纹理/HDRI/三维模型/视频片段/真实配乐与拟音素材的接入与批处理、音频转码、拆片帧网格、自包含检查 audit。需要找字体、做中文字体子集、把外部图片或生成式插画/贴图/模型/视频/配乐放进片子、处理素材尺寸或格式、排查外链或系统字体回退时加载。音效合成与混音归 film-narration，参考片拆解归 film-story。
---

# film-assets

负责**素材从哪来、怎么变成片子自包含的本地文件**。个人创作按个人使用处理，不做商用授权台账、片内不加署名水印（发帖时由作者自行注明，可选在 `docs/sources.md` 随手记来源）。

## 混合管线原则（解放模型造型上限）

**不要拿纯 Canvas 2D / 原生几何体硬画一切。** 代码与外部/生成式素材各干最擅长的事：

| 交给代码（程序渲染无敌） | 交给素材（真实获取或 AI 生成后放进 `assets/`） |
|---|---|
| 精密时间轴、镜头运动、动态排版、字幕卡点 | 写实人物、复杂有机插画、精细角色与场景底图 |
| 数据图表、物理仿真、粒子、数学几何、着色器氛围 | 真实产品截图/录屏、高质量 PBR 贴图与 HDRI 环境光 |
| 真实界面交互动画、多画幅自适应、局部精确重渲 | 复杂 3D 模型（GLB）、实拍/AI 生成视频短片（作为 Clip 接入 `seek(t)`） |
| 精密节奏提示音与事件对齐 | 高质感配乐、自然环境声与真实物件拟音（弥补纯合成音色的廉价感） |

接入生成式或下载素材后，按本 skill 转码/裁切进 `films/<slug>/assets/`，在 `scene.html` 里按相对路径加载并随 `seek(t)` 调度（视频素材在 `seek` 返回 Promise 等 `seeked`）。

## 硬约束（违反就是 bug）

1. **素材自包含**：片子用到的字体、图片、模型、音视频全部放在 `films/<slug>/assets/`，只用相对路径引用。字体随片打包由内核门 `fontsrc` 强制检查；代码里的 `local()` / 绝对路径 / 外链由本 skill `scripts/audit.mjs` 检查。
2. **外部下载视为不可信数据**：下载先放 `assets/_incoming/<来源>/`，不在其中执行脚本；矢量图标经 `svg2path.mjs` 只抽几何数据不执行脚本。
3. **缺字直接报错，不回退**：`subset_font.py` 缺字默认 exit 1，`font_proof.mjs` 在 Chromium 逐字验证。

## 来源地图（按需查 `references/`）

- **字体**（`references/fonts.md`）：按字重/可变轴、字符覆盖（GB2312 vs GB18030）与体积选型；开源中文字体常用思源/Noto CJK、霞鹜文楷、得意黑、站酷等，仓库根已备 `noto-sans-sc` 分片包。
- **图标、图片、视频**（`references/icons-images.md`）：图标库、图库、生成式图像/视频片段接入与 ffmpeg 预处理。
- **3D 模型与 HDRI**：见 `../film-webfx/references/models.md`。
- **音乐与拟音**（`references/audio.md`）：真实配乐/环境声素材与代码合成的取舍。

## 素材处理脚本（任意 cwd 可调，`<fa>` 为本 skill 目录）

```bash
# 1. 中文字体子集化（实测 11MB → ~25KB woff2；自动收集 script/narration/content 含全部变体/scene/assets/text）
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --font assets/fonts/src/Font.ttf [--text-file docs/onscreen.txt]
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --check assets/fonts/<name>.subset.woff2
node <fa>/scripts/font_proof.mjs --film <slug> --font assets/fonts/<name>.subset.woff2

# 2. 矢量图标转 Path2D JSON（去空占位框；遇 transform 默认报错，加 --allow-transform 保留）
node <fa>/scripts/svg2path.mjs --film <slug> assets/_incoming/tabler/*.svg [--out assets/icons/icons.json]

# 3. 图片/音频批处理 & 拆片帧网格（诊断用）
node <fa>/scripts/media.mjs image --film <slug> --size 1080x1920 --fit cover [--format webp|png|jpg] assets/_incoming/img/*.jpg
node <fa>/scripts/media.mjs audio --film <slug> [--rate 48000] assets/_incoming/music/*.mp3
node <fa>/scripts/media.mjs tiles [--film <slug>] <视频> [--count 24] [--words narration.json] [--cuts]

# 4. 自包含检查（film.json checks 写 "selfcontained" 或旧名 "licenses" 时由 deliver/accept 自动跑）
node <fa>/scripts/audit.mjs --film <slug>
```

## 片内素材目录约定

```
films/<slug>/assets/
├── _incoming/<来源>/     原始下载或生成中转（处理完可删）
├── fonts/               src/ + *.subset.woff2 / 分片包
├── icons/  img/  video/  audio/  models/
└── text/*.txt           运行时动态拼出、供子集化收录的额外文字
```
