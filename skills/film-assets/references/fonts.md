# 字体来源清单

清单只是起点：版本、大小、字重这些数会随上游更新而变（下面标的是 2026-10-21 查到的），用之前以下载到的文件为准。

目录：1. 怎么自己查 · 2. 中文开源字体 · 3. 中文厂商字体与其他 · 4. 西文
· 5. 分片包子集化 `--pack` · 6. 缺字放行的作用域 `--allow-missing` · 7. 子集化的代价（5–7 是 `subset_font.py` 工具细节，`<fa>` = 本 skill 目录）

## 1. 怎么自己查（比下面的结论耐用）

```bash
# GitHub 仓库：最新 release 与附件大小
gh api repos/<org>/<repo>/releases/latest --jq '.tag_name, .published_at, (.assets[]|"\(.name) \(.size)")'

# 字体文件自己声明了什么（1 = 族名，2 = 字形，4 = 全名，5 = 版本，16 = 首选族名）、有没有可变轴、覆盖多少字
.venv/bin/python -I -c "from fontTools.ttLib import TTFont as T;f=T('X.ttf');[print(i,f['name'].getDebugName(i)) for i in (1,2,4,5,16)];print('axes',[(a.axisTag,a.minValue,a.maxValue) for a in f['fvar'].axes] if 'fvar' in f else None);print('cmap',len(f.getBestCmap()))"
```

字够不够用，最终以 `subset_font.py` 的缺字报告和 `font_proof.mjs` 的逐字样张为准（cmap 有这个码位不代表字形画得像样）。

## 2. 中文开源字体

| 字体 | 下载 | 字重 | 覆盖 | 大小与版本 |
|---|---|---|---|---|
| **思源黑体 Source Han Sans** | github.com/adobe-fonts/source-han-sans | 7 个（ExtraLight–Heavy），另有可变版 | 简繁日韩，约 6.5 万字形；包含 GB18030 常用部分 | 最新 release 2.005R（2025-06-18）。单语言子集 OTF 约 8-16 MB/字重；完整包数百 MB |
| **思源宋体 Source Han Serif** | github.com/adobe-fonts/source-han-serif | 7 个 | 同上 | release 2.003R（2024-07-30） |
| **Noto Sans/Serif CJK** | github.com/notofonts/noto-cjk | 7 个 | 与思源同源（同一套字形，只是换了名字） | 同上 |
| **Noto Sans SC / Noto Serif SC**（Google Fonts 版） | github.com/google/fonts `ofl/notosanssc/` | 文件 `NotoSansSC[wght].ttf` 是**可变字体**，wght 100–900 | 简中加拉丁字母 | 单文件可变字体，是做字重动画的首选之一 |
| **霞鹜文楷 LXGW WenKai** | github.com/lxgw/LxgwWenKai | 3 个（Light/Regular/Medium），另有 Mono | 简繁，覆盖较广（由 Klee One 衍生） | v1.530（2026-10-17）；Regular.ttf ≈ 24.7 MB |
| **得意黑 Smiley Sans** | github.com/atelier-anchor/smiley-sans | 1 个（斜体风格的展示字体） | 覆盖有限（约 GB2312 级别），生僻字会缺，先运行 `subset_font.py` 看缺哪些字 | v2.0.1（2024-02-07），zip ≈ 5 MB |
| **站酷快乐体 ZCOOL KuaiLe** | github.com/google/fonts `ofl/zcoolkuaile/` | 1 个 | 简中常用字 | — |
| **站酷庆科黄油体 ZCOOL QingKe HuangYou** | github.com/google/fonts `ofl/zcoolqingkehuangyou/` | 1 个 | 简中常用字 | — |
| 站酷小薇 LOGO 体 ZCOOL XiaoWei、马善政毛笔楷 Ma Shan Zheng、刘建毛草 Liu Jian Mao Cao、龙藏体 Long Cang、志莽行书 Zhi Mang Xing | github.com/google/fonts `ofl/<name>/` | 1 个 | 以常用字为主 | — |

> 站酷字体以 Google Fonts 仓库里的那份为准：转载站上的同名文件版本来源不清，字形和覆盖可能不一样。

## 3. 中文厂商字体与其他

下面多数官方页面是 SPA，抓不到正文，下载入口以官方页为准。

| 字体 | 下载 | 字重 | 备注 |
|---|---|---|---|
| **MiSans**（小米） | hyperos.mi.com/font/zh/ | 可变字体（生僻字库只有 Regular） | 生僻字库对应 GB18030-2022 级别 3 |
| **HarmonyOS Sans**（华为） | developer.huawei.com/consumer/cn/design/resource/ 下载 `HarmonyOS-Sans.zip`（实测 HEAD 返回 200，52,165,952 字节） | 6 个左右（Thin–Black） | 另有繁中、阿拉伯文等版本 |
| **OPPO Sans**（OPPO × 汉仪） | open.oppomobile.com 字体页 | 4.0 版有若干字重 | — |
| **阿里巴巴普惠体**（2.0/3.0） | fonts.alibabagroup.com / alibabafonts.com | 3.0 版约 5 个字重，另有可变版 | 3.0 版覆盖 GB18030-2022 |
| **霞鹜新晰黑 LXGW Neo XiHei** | github.com/lxgw/LxgwNeoXiHei | — | 继承自 IPAex Gothic；v1.305，约 7 MB。常被和同一作者的霞鹜文楷混为一谈，字形风格完全不同 |
| 方正、汉仪、造字工房、华康等字库的字体 | 各厂商官网 | 视具体字体 | 字形风格多，书法、宋楷类选择比开源字体丰富 |
| 本机系统字体（PingFang、Hiragino、STHeiti、微软雅黑、宋体…） | macOS `/System/Library/Fonts/`，Windows `C:\Windows\Fonts\` | 视具体字体 | 多为 TTC，子集化时要用 `--font-number` 选第几个。**拷进 `assets/fonts/src/` 再子集化**：直接用 `local()` 或系统路径引用会被 fontsrc 和 `audit.mjs` 判不合格（换台机器就没有这个字体） |

## 4. 西文

| 来源 | 说明 | 备注 |
|---|---|---|
| **Google Fonts** | github.com/google/fonts，按字体分目录，目录内是 ttf 源文件和 `METADATA.pb` | 有大量可变字体（文件名带 `[wght]` `[opsz,wght]`） |
| **Fontsource** `@fontsource-variable/<name>` | npm 包，已经切好 `unicode-range` 分片的 woff2 加一份 CSS | 仓库根目录已经安装了 `@fontsource-variable/inter` 和 `@fontsource-variable/noto-sans-sc`（5.3.1，wght 100–900，共 101 个分片）。西文直接拷贝 `files/*-latin-*.woff2` 即可；中文走第 5 节的 `--pack` |
| 字体自己的 GitHub 仓库（Inter、IBM Plex、JetBrains Mono、Recursive…） | 看 release 附件 | 版本比 Google Fonts 上的新 |
| 商业字体厂商（Klim、Grilli、Commercial Type…） | 官网 | 常同时提供桌面 OTF 和网页 woff2，片子用哪种格式都行 |

## 5. 分片包子集化：`subset_font.py --pack`

分片包是指一组 woff2 文件，加上一份为每个分片写一条 `unicode-range` 的 `@font-face` CSS（例如 fontsource 的中文包、Google Fonts 的 CSS、其他片子的 `fonts.css`）：

```bash
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --pack @fontsource-variable/noto-sans-sc \
    [--family "Noto Sans SC Variable"] [--rename "Film Sans"] [--name noto-sans-sc] [--copy-chunks]
# -> assets/fonts/noto-sans-sc/*.subset.woff2、assets/fonts/noto-sans-sc.subset.css、.subset.json
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --check assets/fonts/noto-sans-sc.subset.css
node <fa>/scripts/font_proof.mjs --film <slug> --font assets/fonts/noto-sans-sc.subset.css [--weight 600]
```

`--pack` 接受三种输入：npm 包名（从片子目录、cwd、本脚本所在位置往上找 `node_modules`）、CSS 文件，或者包含 `index.css` 的目录。
处理步骤如下：先收集片子用到的字；再计算每个分片实际覆盖的字，即同时落在 `unicode-range` 内且存在于字体 cmap 中的字（range 只是声明，不代表真有字形）；然后用贪心算法挑出最少的分片；接着逐个分片做子集化，并把 range 改成精确值；最后写出 CSS（`font-display: block`）。
场景里用 `<link rel="stylesheet" href="./assets/fonts/<name>.subset.css">` 引入，绘制文字前调用 `document.fonts.load(…)`（参见 film-typography）。

- `--rename` 改产出 CSS 里的族名（默认沿用原族名），`--name` 改产出的文件名前缀。
- **`--copy-chunks`**：把挑中的分片原样拷贝，字节与上游一致，可以按 `.subset.json` 里的 sha256 复核；代价是体积约为子集化的 8 倍（实测 23 个分片共 1.22 MB，子集化后为 152 KB）。
- 一个包里有多个字体族（例如 Noto 和 Inter）时，要用 `--family` 指定；不同字重或字形的 face 按组分别挑选分片。
- 重新运行时只删除上次 `.subset.json` 里记录过的文件，目录里的其他文件不会动。
- 如果用的是已经"挑过一遍"的分片包（例如其他片子的 `fonts.css`），覆盖不了新文案时会报缺字，这时要回到完整的上游包。

## 6. 缺字放行的作用域：`--allow-missing`

收字范围是整支片子的全部文案，所以中文片里只用来排数字的拉丁字体必然会"缺"全部汉字。放行时要写明放行**哪一类**字，这一类之外的缺字照样 exit 1：

```bash
… --pack @fontsource-variable/inter --name inter --allow-missing cjk               # 只放行汉字/假名/CJK 标点/全角形
… --allow-missing 'cjk,chars:→∈✓'                                                  # 再加几个字面字符
… --allow-missing 'Inter Variable=cjk'                                              # 只对这一款字体生效（一条命令循环套多款字体时）
```

可用的类有：`cjk`、`han`（只含汉字）、`latin`、`digits`、`ascii`、`U+XXXX-YYYY`、`chars:字面`；可以重复使用，也可以用逗号组合；类名拼错会直接报错。放行声明会记进 `.subset.json` 的 `allowMissing` 字段，`--check` 沿用同一份声明，新增的字只要落在声明范围之外就判为失败。
不带类名的 `--allow-missing` 表示**放行全部缺字**，连本来应该有的字（比如数字）缺了也不报，此时 stderr 会给出告警。

## 7. 子集化的代价

- **改了文案就要重新子集化。** 漏掉的新字会回退到系统字体，在本机上"看起来还行"，换一台机器就变成豆腐块。改了文案就运行 `--check`（fontsrc 内核门也会报失败，但那时已经开始渲染了）。
- 子集化会丢掉没有列出的 OpenType 特性。默认保留 `kern,liga,calt,locl,vert,vrt2,palt,halt`（竖排和标点挤压需要用到），需要其他特性时用 `--keep-features` 指定。
- 可变字体子集化后仍然是可变字体（轴会保留），体积随字数线性增长。
