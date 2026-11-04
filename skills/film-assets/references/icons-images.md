# 图标与图片/视频：来源与授权边界

**查证状态**：授权结论沿用旧 `motion-assets` skill 的记录，**2026-10-21 没有逐条复核原文**。使用前按"怎么查"一节自己核对，并把结果写进本片的 `LICENSES.md`。

## 1. 图标

### 怎么查
- npm 包：先运行 `npm view <pkg> version license`，再**读包里的 LICENSE 文件**（npm 的 license 字段可能是旧的，见下文 Remix Icon）；GitHub 上的查询命令见 `fonts.md` 第 1 节。
- 聚合站（Iconify 等）：**每个图标集合单独授权**，要看集合的 `info.license`，不要看聚合包本身的 MIT 协议。

### 选择维度
- **描边型还是填充型**：要做描边生长动画（`setLineDash`），需要 stroke 型图标，而且几何形状全是 `<path>` 或能转成 path。
- **stroke 宽度**：混用不同的图标库时，stroke 宽度不一致比风格不一致更显眼（有的是 2，有的是 1.5）。
- **viewBox**：大多数是 24×24；Material Symbols 是 `0 -960 960 960`（y 为负），缩放前要先平移。
- **能否插值**：多字重的填充图标（例如 Phosphor 的 6 个 weight）是各自独立的文件，不能连续插值；可变图标字体（Material Symbols 的 FILL/wght 轴）可以。

| 库 | 授权（旧记录） | 形态 | 处理要点 |
|---|---|---|---|
| Tabler `@tabler/icons` | MIT | outline，全部是 path | 每个文件都带一个 `stroke="none"` 的 `M0 0h24v24H0z` 占位框，`svg2path.mjs` 会自动去掉 |
| Lucide `lucide` | ISC | stroke 型，含 circle/rect/line 元素 | 用 `svg2path.mjs` 转成 d；或者直接用包里的 `icon-nodes.json` |
| Iconoir | MIT | stroke 宽度 1.5 | 有少量非 path 元素 |
| Heroicons | MIT | outline stroke，宽度 **1.5** | 全部是 path |
| Phosphor `@phosphor-icons/core` | MIT | 填充轮廓 | 不适合做描边生长 |
| Material Symbols | Apache-2.0 | 可变字体和 SVG | viewBox 的 y 为负 |
| Font Awesome Free | 图标是 **CC BY 4.0**（代码是 MIT，字体是 OFL） | — | **需要署名** |
| Remix Icon | **从 4.9.0 起改用自有协议**（不得用作 logo 或商标，不得用来做竞品图标库），但 npm 字段仍写着 Apache-2.0 | — | 使用 4.9 之前的版本，或者换一个库；以仓库里的 LICENSE 为准 |

转成 canvas 可用的 path 用 SKILL.md 里的 `svg2path.mjs`；画法和描边长度参见 film-motion skill。

## 2. 图片 / 视频

### 怎么查
看站内的 License 页面，再看**每个素材自己的授权标签**（混合授权的站点，同一站内会有两种档位）。下载时截图或保存下载页 URL，记进台账；带"下载证书"的素材（Pixabay 的部分曲目、某些站点的视频），把证书存进 `assets/_incoming/<来源>/`。

| 源 | 商用 | 署名 | 关键限制（旧记录） |
|---|---|---|---|
| Pexels 图/视频 | ✓ | 不要求 | 不得原样再分发或做成模板；不得爬取用于 ML |
| Unsplash | ✓ | 网页下载不要求；**通过 API 使用时强制署名、带 UTM 参数，而且必须热链** | 热链与离线渲染冲突，所以要走网页手动下载；不得用于 AI 训练 |
| Pixabay | ✓ | 不要求 | **不允许永久热链，必须自己存储**；"只做了调色、裁剪、缩放"仍然算原样分发 |
| Mixkit | **逐个看标签** | 看授权档位 | 标为 Video **Restricted** 的只能个人使用，带变现的 YouTube 频道也不行；不得注册 Content ID |
| Coverr | ⚠ 文档前后矛盾 | 不要求 | API 能否商用的说法互相冲突，待核 |
| Poly Haven（HDRI、纹理、模型） | ✓ CC0 | 不要求 | 调用 API 时必须带唯一的 User-Agent |
| ambientCG / Kenney | ✓ CC0 | 不要求 | 可以放心打包再分发 |

### 授权边界
- 肖像权和商标权不在素材站的许可范围内（见 SKILL.md「什么时候自己拍、自己画或自己合成」）：素材里有可识别的人脸或 Logo，又要用于商业宣传时，要找带 model release 的素材。
- 视频素材的裁切缩放（`media.mjs` 不处理）直接用 ffmpeg；用 `-an` 去掉音轨，因为素材原声的授权常常和画面分开：
  `ffmpeg -i in.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920" -an -c:v libx264 -crf 16 assets/video/x.mp4`
