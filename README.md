# motion-studio

一套让 Claude 用代码做视频的 skill。模型不直接生成像素，而是写一个网页程序：页面暴露 `window.seek(t)`，调用它就画出第 t 秒的那一帧。Playwright 逐帧调用并截图，ffmpeg 再把截图编码成 MP4（也可以转成 GIF）。

```
台词 ──TTS──> 旁白音频 + 每个字的发音时刻（narration.json）
                     │
                     ├──> 镜头时长（取实测值，不手填）
                     ├──> 动画触发时刻（对齐到某个字，而不是某一秒）
                     └──> 字幕（逐词高亮 / SRT / ASS）
                               │
seek(t) ──Playwright 逐帧截图──> ffmpeg ──> MP4
```

## 为什么用 seek(t)

一支片子被写成「时间的纯函数」：`seek(t)` 的输出只取决于 t，画的时候不读时钟、不用 `Math.random`、不靠上一帧的状态往下推。这条约束换来三件事：

1. 同样的输入渲两次，像素完全一致。交付前有一组自动检查专门验证这一点。
2. 可以直接跳到任意一秒，所以能多进程并行渲染，也能只重渲改过的那几秒。
3. 整个前端生态都能用：canvas、WebGL、SVG、three.js、物理引擎、Lottie，只要把它们自带的动画循环关掉、改由 t 驱动。

## 套件里有什么

`skills/` 下是 9 个 skill，`film-core` 是入口和内核，其余 8 个是按需加载的能力：

| skill | 负责什么 |
|---|---|
| `film-core` | 新建片子、`seek(t)` 契约、运动基元（弹簧、种子随机、相机、节拍栅格）、三画幅布局、预览、渲染、确定性检查、交付与验收 |
| `film-motion` | 缓动、错峰入场、镜头与转场时间轴、共享元素变形、透视相机、产品界面重建 |
| `film-webfx` | 着色器、后期处理、SVG 滤镜、混合模式，以及按帧驱动的 three.js 三维 |
| `film-physics` | 粒子、重力弹跳、碰撞、布料绳索、群集、屏震顿帧，全部可以跳帧求值 |
| `film-typography` | 文字拆分与入场动画、可变字体、中文排版、画面内字幕 |
| `film-narration` | 旁白 TTS 与字级时间戳、音效、代码合成配乐、混音合流、成片念读校验 |
| `film-assets` | 字体、图标、图片、音频的来源与授权，字体子集化，素材台账 |
| `film-story` | 选题调研与事实核查、参考片拆解、分镜与镜头设计、解说片流程 |
| `film-critique` | 关键帧静帧、接触表、可读性与对比度等客观检查、按本片风格指南评审 |

这套 skill 只提供能力和每种做法的代价，不规定审美：没有默认配色、默认字体、默认转场。每支片子的审美标准写在它自己的 `docs/style_guide.md` 里。

## 安装

```bash
# 依赖：Node 18+、ffmpeg
npm install
npx playwright install chromium

# 需要旁白、音频分析或字体子集化时，再装 Python 环境
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 旁白用火山引擎豆包语音，key 填进 .env（没有 key 时可以用 edge-tts 免费兜底）
cp .env.example .env
```

在本仓库里直接打开 Claude Code 就能用：`.claude/skills/` 已经链接到 `skills/`。

要在别的项目里用，把 skill 拷过去即可（`film-core` 必装，其余按需）：

```bash
mkdir -p ~/.claude/skills ~/.claude/commands
cp -r skills/film-* ~/.claude/skills/
cp skills/commands/film.md ~/.claude/commands/
```

用到没装的能力时，工具会提示「缺能力 film-X」并退出，不会悄悄跳过。

## 使用

跟 Claude 说「做一支讲 X 的 30 秒竖版动画」就行，`film-core` 会被自动加载；也可以输入 `/film`。片子放在 `films/<slug>/`，所有产出写进它的 `out/`。

常用命令：

```bash
node skills/film-core/scripts/new-film.mjs my-film --format 9x16                      # 新建片子（竖版；横版用 16x9）
node skills/film-core/scripts/new-film.mjs my-film --format 9x16 --recipe explainer   # 解说片：额外生成文档模板和检查声明
node skills/film-core/scripts/preview.mjs --film my-film                               # 浏览器里拖动预览
node skills/film-core/scripts/render.mjs --film my-film                                # 渲染无声成片
node skills/film-core/scripts/deliver.mjs --film my-film                               # 定稿渲染、跑全部检查、冻结运行时、写 receipt.json
node skills/film-core/scripts/accept.mjs                                               # 核对所有已交付的片子是否和当前输入一致
```

有旁白的片子，顺序是先合成旁白、再按实测时长排镜头，动画通过 `vo.at('关键词')` 读取某个词被念到的时刻：

```js
const vo = await loadNarration('./narration.json');
const s2 = vo.line('s2');        // 第 s2 句的起止时刻，用作镜头边界
const hit = vo.at('纯函数');      // 「纯函数」开始被念到的时刻
```

旁白重新合成、语速变了，画面会跟着时间戳自动对齐，不需要手改任何秒数。完整流程见 `skills/film-core/SKILL.md` 和 `skills/film-narration/SKILL.md`。

## 目录

```
skills/film-core/     入口与内核：契约、共享库、基础运行时、渲染、检查、交付与验收
skills/film-*/        另外 8 个能力 skill
skills/commands/      /film 命令
dev/                  套件自身的开发工具：selfcheck（规范检查）、test（回归测试）
tests/fixtures/       回归测试用的阳性和阴性对照片子
docs/                 维护约定、变更记录、各 skill 的实测记录
films/                你的片子（不在版本库里）
```

## 开发

改动 skill 之后，下面两条都要通过：

```bash
node dev/selfcheck.mjs      # 9 个 skill 的结构、依赖方向、gates.json、风格中立、语法
node dev/test.mjs           # 各 skill 自测和阴性/阳性对照（--quick 跳过较慢的三维用例）
```

内核的唯一技术契约在 `skills/film-core/references/kernel.md`，能力 skill 能依赖的接口在 `skills/film-core/references/api.md`，维护约定在 `docs/MAINTAINING.md`。

## 环境说明

- Playwright 默认用的是 `chromium_headless_shell`，不是完整版 Chromium。两者 `browser.version()` 返回同一个字符串，但渲出来的像素有可见差异（等宽字体回退不同），手动指定浏览器路径时要注意。首次渲染会把浏览器和编码器版本写进 `film.json`，之后版本变了会警告。
- 如果所在网络做了 TLS 拦截，Python 直连会报 `CERTIFICATE_VERIFY_FAILED`。`requirements.txt` 里的 `truststore` 会让 Python 改用系统证书库；也可以用 `VOLC_TTS_CA_BUNDLE` 或 `SSL_CERT_FILE` 指定证书包。
- WebGL 在无头浏览器里是软件渲染（SwiftShader），着色器重的片子渲染会慢一些。

## 许可证

[Apache-2.0](LICENSE)。各 skill 自带的第三方素材（字体等）按各自的许可证分发，见对应目录下的 `LICENSES.md`。
