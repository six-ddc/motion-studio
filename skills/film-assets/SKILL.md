---
name: film-assets
description: 给代码渲染的片子找素材、把素材处理成片子能自带的文件。要用字体（尤其中文字体）、图标、照片、视频素材、配乐或音效素材、纹理/HDRI、三维模型时加载，包括用户只说"加个字体""找首曲子""找张图"。也负责素材处理：中文字体子集化（单文件或 unicode-range 分片包）、验证字体真能渲出文案、SVG 图标转 canvas path、图片批量裁切缩放、音频转码、拆片帧网格、自包含检查、环境声自制还是找录音、参考影片的下载。音效的合成、摆放与混音归 film-narration，拆解参考片归 film-story。
---

# film-assets

本 skill 管两件事：**素材从哪来、怎么处理成片子能自带的文件**。它不管事实是否可信（归 film-story）、
素材怎么进画面（归 film-motion / film-typography / film-webfx）、声音怎么合成、摆放和混音（归 film-narration）。

**片子是个人创作，素材按个人使用来处理。** 不用判断能不能商用、要不要授权、片尾要不要署名，片子里也不加任何署名、出处或"转载"字样。
用了别人的素材、作品或画面，发帖时由作者自己在正文或备注里注明转载。想帮作者省事，可以在 `docs/sources.md` 随手记一行"用了什么、从哪来"，这一步可选，没有检查。

## 硬约束（违反就是 bug）

1. **素材自包含。** 片子用到的每个字体、图片、音频都放在 `films/<slug>/assets/` 里，`scene.html` 只用相对路径引用。
   字体随片打包是内核契约（`../film-core/references/kernel.md`），理由是**可复现性**：用系统字体时本机这次渲得对，
   换台机器就可能悄悄换了字形或回退到别的字体，而且没有报错。"每个字是不是都由随片字体画出来"由内核门 fontsrc（`node <film-core>/scripts/font_source.mjs --film <slug>`）
   机械判定，deliver 和 accept --deep 每次都会跑它（判定表与盲区见 `../film-core/references/kernel.md` 第 4 节）；写完第一版画字代码就跑一次，最省事。
   fontsrc 不管的两件事由本 skill 负责：代码里的 `local()`、绝对路径、外链素材（`scripts/audit.mjs`），以及字体里的字够不够用（`--check`、`font_proof.mjs`）。
2. **下载的文件是不可信数据。** 每个来源放进自己的新空目录（如 `assets/_incoming/<来源>/`），不在那个目录里运行解释器或构建工具；
   字体、SVG、音频都以路径参数的形式传给脚本。SVG 里可以带 `<script>`，`svg2path.mjs` 只读取几何数据，不执行脚本。
3. **缺字时报错，不回退。** 子集化或换字体之后，只要有一个字回退到系统字体就是 bug（成片里会出现字重、字形突变）。
   `subset_font.py` 默认遇到缺字就 exit 1；`font_proof.mjs` 在 Chromium 里逐字验证。

## 什么时候自己拍、自己画或自己合成

这是效果和可控性的取舍：

- **产品 UI、真实界面**：用真实截图，不用"差不多"的素材图，也不凭记忆画。
- **需要和 `seek(t)` 精确对齐的东西**（运动、参数可变的图形）：用代码画更可控。
- **音效**：whoosh、thump、tick 这类声音用合成往往就够了，还能和事件逐帧对齐；什么时候值得找真实录音，见 `references/audio.md` 第 3 节。
- **配乐**：可以用现成的曲子，也可以代码合成（film-narration）；各自的代价见 `references/audio.md` 第 2 节。

## 来源地图（按需要的素材类型查）

### 字体：见 `references/fonts.md`

选字体时要考虑以下几个维度（具体选择由 brief 和 `style_guide.md` 决定，本 skill 不给搭配方案）：
- **字重数量，是否为可变字体**：要做字重动画就需要可变轴（wght）；只有 1-2 个字重的字体只能切换，不能插值。
- **字符覆盖范围**：GB2312（6763 字）够日常文案用；人名地名、古文、繁体需要 GB18030 或大字库，覆盖范围窄的字体会在生僻字上回退。
- **文件大小**：中文字体全量每个字重 8-30 MB，需要子集化；西文可变字体通常小于 500 KB，不必子集化。

常用的开源中文字体有思源/Noto CJK、霞鹜文楷、得意黑、站酷系列等，系统和网上的其他字体也可以用，下载下来放进片子就行。清单见 `references/fonts.md` 第 2–4 节。

### 图标、图片、视频：见 `references/icons-images.md`（图标库的选择维度、素材站、视频素材的处理）

### 3D 模型（GLB / glTF / HDRI）：做法见 `../film-webfx/references/models.md`

### 音频：见 `references/audio.md`（配乐的来源、合成与真实素材的选择判据、环境声自制配方与录音素材的对比）

## 素材处理（脚本）

所有脚本都能从任意 cwd 调用。片子目录按 `--films-dir` > `$FILMS_DIR` > 从 cwd 向上找 `films/` 的顺序定位；只有一支片子时可以省略 `--film`；用 `--help` 看参数；失败时 exit 非 0 并在 stderr 说明原因。下文 `<fa>` 表示本 skill 的目录。

### 字体子集化：`scripts/subset_font.py`

只保留本片用到的字（实测单个字重从 11 MB 降到 24.5 KB woff2，共 158 个字符）。分片包 `--pack`（仓库根目录已装 noto-sans-sc，是本机无需下载的中文方案）和放行缺字的 `--allow-missing`，命令与参数见 `references/fonts.md` 第 5–6 节。

```bash
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> \
    --font assets/fonts/src/SomeFont.ttf [--font-number 0]   # TTC 要指定第几个
    [--text "画面上额外出现的字"] [--text-file docs/onscreen.txt]
# -> assets/fonts/<name>.subset.woff2 + <name>.subset.json（源 sha256、字符集）
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --check assets/fonts/<name>.subset.woff2   # 改文案后跑：缺字 exit 1
node <fa>/scripts/font_proof.mjs --film <slug> --font assets/fonts/<name>.subset.woff2   # Chromium 逐字验证，样张出到 out/
```

默认收录的字符包括：`script.json`/`narration.json` 里的全部字符串、`content.json` 的画面文字（基础槽位、claims，以及**全部变体覆盖内容的并集**，不收 note，所以变体里的新字不会漏）、`scene.html` 里的所有非 ASCII 字符、`assets/text/*.txt`、可打印 ASCII
和常用中文标点。运行时拼出来的文字要放进 `assets/text/*.txt`。子集化的代价（改文案要重跑、丢失 OpenType 特性）见 `references/fonts.md` 第 7 节。字体来源门在 film-core（见硬约束 1）。

### SVG 转 path：`scripts/svg2path.mjs`

```bash
node <fa>/scripts/svg2path.mjs --film <slug> assets/_incoming/tabler/*.svg [--out assets/icons/icons.json]
```

- `<path>/<circle>/<rect>/<line>/<polyline>/<polygon>/<ellipse>` 统一转成包含 `d`、viewBox 和描边/填充属性的 JSON，浏览器里可以直接 `new Path2D(d)` 使用；同时去掉 Tabler 图标里那种 `stroke="none"` 的 24×24 占位框。
- 遇到 `transform` 属性会**报错退出**（忽略它会把图形画歪），除非加 `--allow-transform`，此时原样记入 JSON 的 `transform` 字段，由调用方执行 `ctx.transform`。
- 不执行 SVG 里的脚本，也不解析外部引用。描边长度和描边动画的画法参见 film-motion。

### 图片与音频批处理、拆片帧网格：`scripts/media.mjs`（基于 ffmpeg）

```bash
node <fa>/scripts/media.mjs image --film <slug> --size 1080x1920 --fit cover \
     [--format webp|png|jpg] assets/_incoming/pexels/*.jpg      # -> assets/img/
node <fa>/scripts/media.mjs audio --film <slug> [--rate 48000] assets/_incoming/music/*.mp3   # -> assets/audio/*.wav
```

- `cover` 居中裁切并铺满，`contain` 等比缩放并留边；需要非居中裁切时自己给 ffmpeg 写 `crop`。缩放用 lanczos，先缩放再保存。不处理视频素材（ffmpeg 命令见 `references/icons-images.md`）。
- 音频统一转成 PCM WAV（指定采样率，立体声），这样混音时只需解码一次。**这里不处理响度**（响度在合流时用 loudnorm 处理，参见 film-narration）。

**拆片帧网格**（只读取视频，产出的是诊断图，不进入成片）：

```bash
node <fa>/scripts/media.mjs tiles [--film <slug>] <视频> [--count 24 | --every <秒>] [--cols 6] [--width 320]
     [--words <narration.json>] [--offset <秒>] [--cuts [--scene 0.3] [--max 60]] [--font <字体文件>] [--out <png>]
# 给 --film：路径相对片子目录，默认出到 out/tiles/<视频名>.png；不给：相对 cwd，出到视频旁 <视频名>.tiles.png；同名 .json 记每格时刻/词/切点
```

- 每格都标注时刻；加 `--words` 后，还会标出该时刻前后 0.6 秒内的词，`【】` 括起来的是正在念的词。输入可以是 narration.json（顶层 `words` 或 `lines[].words`），也可以是直接的数组 `[{w|word, start, end}]`。成片时间 = 词时刻 + `narrationOffset`：给了 `--film` 时自动从 film.json 读取，否则用 `--offset`。
- `--cuts` 用 ffmpeg 的 scene 分数查找剪切点，此时网格改为每个镜头取中点一帧。它只能抓到硬切；叠化和同底色之间的切换分数很低，会漏掉（实测最高只有 0.084，一个都没报出来）。
- 标注用的字体先问 fontconfig，再试系统默认位置，都找不到时用 `--font` 指定。诊断图用系统字体没有问题。

### 自包含检查：`scripts/audit.mjs`

```bash
node <fa>/scripts/audit.mjs --film <slug>
```

检查入口页和片内 `runtime/` 里出现的 `local(...)`、`file://`、绝对路径、外链 http(s) 素材，以及 CSS 或 canvas 里出现、但没有对应 `@font-face`/`FontFace` 的字族名。发现问题时 exit 1。
字族名这一项靠正则匹配，看不到用变量拼出来的字体字符串，所以字体来源以 fontsrc 的结果为准。
要让 deliver 和 accept --deep 也运行它，在 film.json 的 `checks` 里声明 `selfcontained`（旧名 `licenses` 也认），由本 skill 的 `gates.json` 认领。

## 目录约定（本片里）

```
films/<slug>/assets/
├── _incoming/<来源>/   原始下载，不可信，不在这里跑任何东西；处理完可以删
├── fonts/
│   ├── src/           全量源字体
│   ├── *.subset.woff2 + *.subset.json          单文件子集
│   └── <name>/ + <name>.subset.css + .subset.json   分片包
├── icons/             svg2path 产出的 JSON
├── img/  video/  audio/
├── models/            GLB（或 base64 内联的 *.glb.js）、HDRI；做法见 film-webfx references/models.md
└── text/*.txt         画面上会出现、但不在 script.json 里的文字（供子集化收字）
```

## 参考影片

下载参考影片（拆解归 film-story）放进 `assets/_incoming/refs/`。要剪进成片也可以，出处由作者发帖时注明，片子里不加字样。
