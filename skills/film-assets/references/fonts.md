# 字体来源与授权清单

**这份清单只是起点，不具备权威性。** "✔ 原文"表示读过权利人发布的 LICENSE 或官方页面原文；"△ 转述"表示只找到媒体或第三方的转述（官方页是 SPA，抓不到正文），使用前要自己打开官方页或下载包里的协议读一遍。

目录：1. 怎么自己查 · 2. 中文（OFL 系）· 3. 中文（厂商自定协议）· 4. 中文（需授权/慎用）· 5. 西文
· 6. 分片包子集化 `--pack` · 7. 缺字放行的作用域 `--allow-missing` · 8. 子集化的代价（6–8 是 `subset_font.py` 工具细节，`<fa>` = 本 skill 目录）

## 1. 怎么自己查（比下面的结论耐用）

```bash
# GitHub 仓库：看授权文件和最新 release
gh api repos/<org>/<repo>/license --jq '.license.spdx_id, .html_url'   # NOASSERTION = 非标准协议，必须读原文
curl -sSL https://raw.githubusercontent.com/<org>/<repo>/<branch>/OFL.txt | head -20
gh api repos/<org>/<repo>/releases/latest --jq '.tag_name, .published_at, (.assets[]|"\(.name) \(.size)")'

# 字体文件自己声明了什么（name 13 = 授权描述，14 = 授权 URL，0 = 版权）
.venv/bin/python -I -c "from fontTools.ttLib import TTFont as T;f=T('X.ttf');[print(i,f['name'].getDebugName(i)) for i in (0,13,14)]"
```

读 OFL 时要看第一行的 **Reserved Font Name（RFN）**（代价见第 8 节），以及 OFL 后面可能附加的 `[ADDITIONAL PERMISSION]`（例如霞鹜文楷）。厂商自定协议按 SKILL.md 里的四个问题去读；多数协议没写子集化算不算"修改"。协议里写了"禁止提供其他下载渠道"，就意味着不能把字体文件放进公开仓库。

## 2. 中文：SIL OFL 1.1 系（可商用、可修改、可再分发；注意 RFN）

| 字体 | 来源（看这里的授权文件） | 授权（查证） | 字重 | 覆盖 | 大小 |
|---|---|---|---|---|---|
| **思源黑体 Source Han Sans** | github.com/adobe-fonts/source-han-sans → `LICENSE.txt` | OFL 1.1，RFN **"Source"**；Copyright 2014-2025 Adobe ✔ 原文 2026-10-21 | 7 个（ExtraLight–Heavy），另有可变版 | 简繁日韩，约 6.5 万字形；包含 GB18030 常用部分 | 最新 release 2.005R（2025-06-18）。单语言子集 OTF 约 8-16 MB/字重；完整包数百 MB |
| **思源宋体 Source Han Serif** | github.com/adobe-fonts/source-han-serif → `LICENSE.txt` | OFL 1.1，RFN "Source"；Copyright 2017-2022 ✔ 原文 2026-10-21 | 7 个 | 同上 | release 2.003R（2024-07-30） |
| **Noto Sans/Serif CJK** | github.com/notofonts/noto-cjk → `Sans/LICENSE` | OFL 1.1 ✔ 原文 2026-10-21 | 7 个 | 与思源同源（同一套字形，只是换了名字） | 同上 |
| **Noto Sans SC / Noto Serif SC**（Google Fonts 版） | github.com/google/fonts `ofl/notosanssc/` | `METADATA.pb` 写的是 `license: "OFL"`，文件 `NotoSansSC[wght].ttf` 是**可变字体** ✔ 原文 2026-10-21 | wght 轴可变，范围 100–900 | 简中加拉丁字母 | 单文件可变字体，是做字重动画的首选之一 |
| **霞鹜文楷 LXGW WenKai** | github.com/lxgw/LxgwWenKai → `OFL.txt` | OFL 1.1，RFN 为 "霞鹜/霞鶩/落霞孤鹜/落霞孤鶩/LXGW"，**附加许可：重新编译，或为网页分发而子集化、转成 WOFF2 的修改版可以保留原名**（但不得作为可安装的桌面字体） ✔ 原文 2026-10-21 | 3 个（Light/Regular/Medium），另有 Mono | 简繁，覆盖较广（由 Klee One 衍生） | v1.530（2026-10-17）；Regular.ttf ≈ 24.7 MB |
| **得意黑 Smiley Sans** | github.com/atelier-anchor/smiley-sans → `LICENSE` | OFL 1.1，RFN 为 **"Smiley" 和 "得意黑"** ✔ 原文 2026-10-21 | 1 个（斜体风格的展示字体） | 覆盖有限（约 GB2312 级别），生僻字会缺，先运行 `subset_font.py` 看缺哪些字 | v2.0.1（2024-02-07），zip ≈ 5 MB |
| **站酷快乐体 ZCOOL KuaiLe** | github.com/google/fonts `ofl/zcoolkuaile/OFL.txt` | OFL 1.1 ✔ 原文 2026-10-21 | 1 个 | 简中常用字 | — |
| **站酷庆科黄油体 ZCOOL QingKe HuangYou** | github.com/google/fonts `ofl/zcoolqingkehuangyou/OFL.txt` | OFL 1.1 ✔ 原文 2026-10-21 | 1 个 | 简中常用字 | — |
| 站酷小薇 LOGO 体 ZCOOL XiaoWei、马善政毛笔楷 Ma Shan Zheng、刘建毛草 Liu Jian Mao Cao、龙藏体 Long Cang、志莽行书 Zhi Mang Xing | github.com/google/fonts `ofl/<name>/` | 被 Google Fonts 收录即为 OFL；**本次没有逐个读原文** | 1 个 | 以常用字为主 | — |

> 站酷字体**只以 Google Fonts 仓库里的那份 OFL 为准**：官网对同名字体有时另有说明，转载站上的版本来源不清。

## 3. 中文：厂商自定协议（免费商用，但修改/再分发有限制）

这一类字体可以用于成片，但**子集化和放进公开仓库之前要读协议原文**。下面多数官方页面是 SPA，本次抓不到正文。

| 字体 | 去哪读协议 | 本次查到的情况 | 字重 | 备注 |
|---|---|---|---|---|
| **MiSans**（小米） | hyperos.mi.com/font/zh/faq（FAQ）、下载包内的协议 | ✔ 官方 FAQ 原文 2026-10-21："MiSans Global 所有的字体都是供全球免费商用"；**嵌入软件时需要"在软件中特别注明使用了 MiSans 字体"**；可以调整粗细和间距，但"不得单独将 MiSans 字体或其组件进行外观上的更改"；没有提到再分发 | 可变字体（生僻字库只有 Regular） | 生僻字库对应 GB18030-2022 级别 3。协议没说子集化算不算"外观更改"，保守做法是只在本地渲染时子集化，文件不放进公开仓库 |
| **HarmonyOS Sans**（华为） | 从 developer.huawei.com/consumer/cn/design/resource/ 下载 `HarmonyOS-Sans.zip`（实测 HEAD 返回 200，52,165,952 字节），读包内的协议 | △ 只有媒体转述"免费商用"；官方页是 SPA，抓不到 | 6 个左右（Thin–Black），另有繁中、阿拉伯文等版本 | ⚠ npm 包 `harmonyos-sans@1.0.0` 里的 `LICENSE` 是 **GPL-3.0**，那是打包者给 wrapper 写的协议，**不是**华为的字体协议，不能据此认定字体是 GPL |
| **OPPO Sans**（OPPO × 汉仪） | open.oppomobile.com 字体页、下载包内的协议 | △ 媒体转述（IT之家等，2024-10）：4.0 版"免费授权给全社会使用（含商用）"，**禁止改编或二次开发、禁止售卖、禁止向他方提供其他下载渠道** | 4.0 版有若干字重 | 因为"禁止改编或二次开发"，子集化有风险；因为"禁止提供下载渠道"，不能放进公开仓库 |
| **阿里巴巴普惠体**（2.0/3.0） | fonts.alibabagroup.com / alibabafonts.com（SPA，法律声明在站内） | △ 媒体转述：3.0 版"全球永久免费正版商用"，符合 GB18030-2022；2019 版声明禁止上传、发布、转载字体文件，禁止售卖，**没有授权修改** | 3.0 版约 5 个字重，另有可变版 | 同上：成片可以用，子集化或放进仓库之前要读站内的法律声明 |

## 4. 中文：需要申请授权 / 慎用

| 字体 | 情况 |
|---|---|
| **方正黑体 / 书宋 / 仿宋 / 楷体**（方正"四款免费字体"） | △ 网上流传"免费商用"，但说法互相矛盾：有的说可以直接商用，有的说**商业发布前仍需取得方正的书面授权**（免费，但要申请）。方正官网（foundertype.com）对这四款没有明确的公开条款；家庭版协议明确写着"个人、非商业目的"。**结论：按"需要申请授权"处理，拿到书面授权之前不用于商业片。** 咨询邮箱：font_sales@founder.com（官网所列） |
| 方正的其他字体、汉仪、造字工房、华康等 | 属于商业字体。视频、广告、商业发布通常是**单独计价**的授权类型 |
| 本机系统字体（PingFang、Hiragino、STHeiti、微软雅黑、宋体…） | 随操作系统授权。**不能拷进片子目录分发**；在商业视频中的使用许可各家规定不一。只用于本地测试 |
| **霞鹜新晰黑 LXGW Neo XiHei** | **不是 OFL，而是 IPA Font License v1.0**（继承自 IPAex Gothic；GitHub API 报 `NOASSERTION`）✔ 原文 `github.com/lxgw/LxgwNeoXiHei` `LICENSE.md` 2026-10-21。派生物（包括子集）的分发条件与 OFL 不同，使用前读协议第 3 条。它常被和同一作者的霞鹜文楷混为一谈。v1.305，约 7 MB |
| 仓耳今楷等"个人免费"字体 | 旧 skill 标注为待核对，本次也没有核对。看到"个人免费""非商用免费"字样的，一律按不可商用处理 |

## 5. 西文

| 来源 | 授权怎么看 | 备注 |
|---|---|---|
| **Google Fonts** | 在 github.com/google/fonts 中，目录名前缀 `ofl/` `apache/` `ufl/` 就表示授权类型，目录内有协议原文 | 有大量可变字体（文件名带 `[wght]` `[opsz,wght]`） |
| **Fontsource** `@fontsource-variable/<name>` | 看 npm 包内的 `LICENSE`，与上游一致 | 仓库根目录已经安装了 `@fontsource-variable/inter` 和 `@fontsource-variable/noto-sans-sc`（5.3.1，OFL，wght 100–900，共 101 个分片）。西文直接拷贝 `files/*-latin-*.woff2` 即可；中文走第 6 节的 `--pack`。noto-sans-sc 包内 `LICENSE` 首行写的是 "Google Inc."，而 name 表里的版权方是 Adobe（RFN 'Source'），两份都要随附 |
| 字体自己的 GitHub 仓库（Inter、IBM Plex、JetBrains Mono、Recursive…） | 看仓库根目录的 `LICENSE`/`OFL.txt` | 版本比 Google Fonts 上的新 |
| 商业字体厂商（Klim、Grilli、Commercial Type…） | 看 EULA 里的 "video / broadcast / app" 条款 | 桌面授权通常**不包含**视频输出，需要另外加购 |

## 6. 分片包子集化：`subset_font.py --pack`

分片包是指一组 woff2 文件，加上一份为每个分片写一条 `unicode-range` 的 `@font-face` CSS（例如 fontsource 的中文包、Google Fonts 的 CSS、其他片子的 `fonts.css`）：

```bash
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --pack @fontsource-variable/noto-sans-sc \
    [--family "Noto Sans SC Variable"] [--rename "Film Sans"] [--name noto-sans-sc] [--copy-chunks] [--license OFL.txt]
# -> assets/fonts/noto-sans-sc/*.subset.woff2 + LICENSE、assets/fonts/noto-sans-sc.subset.css、.subset.json
.venv/bin/python <fa>/scripts/subset_font.py --film <slug> --check assets/fonts/noto-sans-sc.subset.css
node <fa>/scripts/font_proof.mjs --film <slug> --font assets/fonts/noto-sans-sc.subset.css [--weight 600]
```

`--pack` 接受三种输入：npm 包名（从片子目录、cwd、本脚本所在位置往上找 `node_modules`）、CSS 文件，或者包含 `index.css` 的目录。
处理步骤如下：先收集片子用到的字；再计算每个分片实际覆盖的字，即同时落在 `unicode-range` 内且存在于字体 cmap 中的字（range 只是声明，不代表真有字形）；然后用贪心算法挑出最少的分片；接着逐个分片做子集化，并把 range 改成精确值；最后写出 CSS（`font-display: block`）。
场景里用 `<link rel="stylesheet" href="./assets/fonts/<name>.subset.css">` 引入，绘制文字前调用 `document.fonts.load(…)`（参见 film-typography）。

- **许可文件一定要随附**：脚本会在包目录及其上级目录查找 `LICENSE`/`OFL.txt` 并拷进产出目录；找不到就 exit 1，要求用 `--license` 指定。脚本还会解析 RFN，字体族名包含保留名而又没有指定 `--rename` 时给出警告。`--check` 能发现许可文件被删除的情况。
- **`--copy-chunks`**：把挑中的分片原样拷贝，字节与上游一致，可以按台账里的 sha256 复核；代价是体积约为子集化的 8 倍（实测 23 个分片共 1.22 MB，子集化后为 152 KB）。
- 一个包里有多个字体族（例如 Noto 和 Inter）时，要用 `--family` 指定；不同字重或字形的 face 按组分别挑选分片。
- 重新运行时只删除上次台账里记录过的文件，目录里的其他文件不会动。
- 如果用的是已经"挑过一遍"的分片包（例如其他片子的 `fonts.css`），覆盖不了新文案时会报缺字，这时要回到完整的上游包。
- 台账里可以用一行记录整个目录（`assets/fonts/noto-sans-sc/`），`audit.mjs` 认可这种写法；`*.subset.css` 和 `*.subset.json` 一样不需要登记。

## 7. 缺字放行的作用域：`--allow-missing`

收字范围是整支片子的全部文案，所以中文片里只用来排数字的拉丁字体必然会"缺"全部汉字。放行时要写明放行**哪一类**字，这一类之外的缺字照样 exit 1：

```bash
… --pack @fontsource-variable/inter --name inter --allow-missing cjk               # 只放行汉字/假名/CJK 标点/全角形
… --allow-missing 'cjk,chars:→∈✓'                                                  # 再加几个字面字符
… --allow-missing 'Inter Variable=cjk'                                              # 只对这一款字体生效（一条命令循环套多款字体时）
```

可用的类有：`cjk`、`han`（只含汉字）、`latin`、`digits`、`ascii`、`U+XXXX-YYYY`、`chars:字面`；可以重复使用，也可以用逗号组合；类名拼错会直接报错。放行声明会记进台账的 `allowMissing` 字段，`--check` 沿用同一份声明，新增的字只要落在声明范围之外就判为失败。
不带类名的 `--allow-missing` 表示**放行全部缺字**，连本来应该有的字（比如数字）缺了也不报，此时 stderr 会给出告警。

## 8. 子集化的代价

- **改了文案就要重新子集化。** 漏掉的新字会回退到系统字体，在本机上"看起来还行"，换一台机器就变成豆腐块。改了文案就运行 `--check`（fontsrc 内核门也会报失败，但那时已经开始渲染了）。
- **OFL 保留字体名（RFN）**：思源、得意黑等字体声明了 RFN，子集化后的文件属于修改版本，严格来说公开分发时不应沿用保留名（"OFL 就是随便改"的印象并不完整）。只在本地渲染、不分发时没有影响；要放进公开仓库时，用 `--name` 改名并在台账里注明。霞鹜文楷额外许可了"为网页分发而子集化或转换格式"的版本可以保留原名。
- **厂商自定协议**大多没有提到子集化，部分协议明确限制修改。不确定时只使用完整字体文件，并且不放进公开仓库（用 `.gitignore` 忽略 `assets/fonts/src/`）。
- 子集化会丢掉没有列出的 OpenType 特性。默认保留 `kern,liga,calt,locl,vert,vrt2,palt,halt`（竖排和标点挤压需要用到），需要其他特性时用 `--keep-features` 指定。
- 可变字体子集化后仍然是可变字体（轴会保留），体积随字数线性增长。
