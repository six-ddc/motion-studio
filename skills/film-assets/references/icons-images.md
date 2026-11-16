# 图标与图片/视频：来源与处理

## 1. 图标

### 怎么查
- npm 包：`npm view <pkg> version` 看最新版本，下载后看包里的 SVG 目录结构；GitHub 上的查询命令见 `fonts.md` 第 1 节。
- 聚合站（Iconify 等）：一个聚合包里有很多图标集合，风格、stroke 宽度、viewBox 各不相同，按集合挑，不要混着用。

### 选择维度
- **描边型还是填充型**：要做描边生长动画（`setLineDash`），需要 stroke 型图标，而且几何形状全是 `<path>` 或能转成 path。
- **stroke 宽度**：混用不同的图标库时，stroke 宽度不一致比风格不一致更显眼（有的是 2，有的是 1.5）。
- **viewBox**：大多数是 24×24；Material Symbols 是 `0 -960 960 960`（y 为负），缩放前要先平移。
- **能否插值**：多字重的填充图标（例如 Phosphor 的 6 个 weight）是各自独立的文件，不能连续插值；可变图标字体（Material Symbols 的 FILL/wght 轴）可以。

| 库 | 形态 | 处理要点 |
|---|---|---|
| Tabler `@tabler/icons` | outline，全部是 path | 每个文件都带一个 `stroke="none"` 的 `M0 0h24v24H0z` 占位框，`svg2path.mjs` 会自动去掉 |
| Lucide `lucide` | stroke 型，含 circle/rect/line 元素 | 用 `svg2path.mjs` 转成 d；或者直接用包里的 `icon-nodes.json` |
| Iconoir | stroke 宽度 1.5 | 有少量非 path 元素 |
| Heroicons | outline stroke，宽度 **1.5** | 全部是 path |
| Phosphor `@phosphor-icons/core` | 填充轮廓 | 不适合做描边生长 |
| Material Symbols | 可变字体和 SVG | viewBox 的 y 为负 |
| Font Awesome Free | 填充型（solid / regular / brands） | 品牌图标（brands）全在这一套里 |
| Remix Icon | 线性和填充成对（`-line` / `-fill`） | 同一图标两种形态，适合做"描边→填充"的状态切换 |

转成 canvas 可用的 path 用 SKILL.md 里的 `svg2path.mjs`；画法和描边长度参见 film-motion skill。

## 2. 图片 / 视频

| 源 | 内容 | 处理要点 |
|---|---|---|
| Pexels | 图、视频 | 视频提供多档分辨率，竖版素材也多 |
| Unsplash | 图 | 网页手动下载原图；API 返回的是热链 URL，离线渲染要先存进 `assets/` |
| Pixabay | 图、视频、插画、矢量图 | 下载后存本地，不要热链 |
| Mixkit | 视频 | 按类别分好，短镜头多 |
| Coverr | 视频 | 偏生活方式类的短镜头 |
| Poly Haven | HDRI、纹理、模型 | 调用 API 时必须带唯一的 User-Agent |
| ambientCG / Kenney | 纹理（PBR 贴图组）/ 游戏美术包 | 整包下载 |

下载时按硬约束 2 放进 `assets/_incoming/<来源>/`，图片用 `media.mjs image` 裁切缩放进 `assets/img/`。

### 视频素材处理
视频素材的裁切缩放（`media.mjs` 不处理）直接用 ffmpeg；用 `-an` 去掉音轨，素材原声一般用不上，声音在混音时另配（参见 film-narration）：

```bash
ffmpeg -i in.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920" -an -c:v libx264 -crf 16 assets/video/x.mp4
```
