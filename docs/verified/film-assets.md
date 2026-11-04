# film-assets 验证记录（2026-10-21）

环境：macOS Darwin 25，Node + Playwright 1.64.1（Chromium），`.venv` Python，ffmpeg 8.0。
本次往 `.venv` 装了 `fonttools 4.67.0` 与 `brotli 1.2.0`（woff2 需要）——仓库根没有 requirements.txt，
新机器上需 `.venv/bin/python -m pip install fonttools brotli`。
测试片：`tests/fixtures/_test-assets/`（保留）。所有命令都从 `/tmp` 或 `/` 执行（证明不依赖 cwd），用 `--films-dir` 指向仓库 `films/`。

## 1. 中文字体授权查证

| 字体 | 查的链接 | 看到的 | 方式 |
|---|---|---|---|
| 思源黑体 | https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/LICENSE.txt | SIL OFL 1.1，"Copyright 2014-2025 Adobe … with Reserved Font Name 'Source'" | 原文 |
| 思源宋体 | https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/LICENSE.txt | OFL 1.1，Copyright 2017-2022，RFN 'Source' | 原文 |
| Noto CJK | https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE | OFL 1.1 | 原文 |
| Noto Sans SC（GF 版） | https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/METADATA.pb | `license: "OFL"`，文件 `NotoSansSC[wght].ttf`（可变） | 原文 |
| 霞鹜文楷 | https://raw.githubusercontent.com/lxgw/LxgwWenKai/main/OFL.txt | OFL 1.1，RFN 霞鹜/LXGW 等，**附加许可**：为网页分发子集化/转 WOFF2 可保留原名 | 原文 |
| 得意黑 | https://raw.githubusercontent.com/atelier-anchor/smiley-sans/main/LICENSE | OFL 1.1，RFN "Smiley" 和 "得意黑" | 原文 |
| 站酷快乐体 / 庆科黄油体 | https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/OFL.txt 、…/zcoolqingkehuangyou/OFL.txt | OFL 1.1 | 原文 |
| **霞鹜新晰黑** | https://raw.githubusercontent.com/lxgw/LxgwNeoXiHei/main/LICENSE.md ；`gh api repos/lxgw/LxgwNeoXiHei/license` | **IPA Font License v1.0**，spdx_id `NOASSERTION` | 原文 |
| MiSans | https://hyperos.mi.com/font/zh/faq | 免费商用；嵌入软件需注明使用 MiSans；"不得单独将 MiSans 字体或其组件进行外观上的更改"；再分发未提 | 官方页原文 |
| HarmonyOS Sans | https://developer.huawei.com/consumer/cn/design/resource/ （SPA，无正文）；官方 zip `curl -I` → 200，52,165,952 B；https://cdn.jsdelivr.net/npm/harmonyos-sans@1.0.0/LICENSE | 官方条款**未读到**；npm 包 LICENSE 是 **GPL-3.0**（打包者声明，不是华为协议） | 未完成 |
| OPPO Sans / 阿里巴巴普惠体 / 方正四款 | open.oppomobile.com、alibabafonts.com、foundertype.com | 官方页 SPA 或无专门条款，**只有媒体转述**；方正四款"是否需书面授权"说法矛盾 | 未完成（转述） |

Release 版本与大小用 `gh api repos/<repo>/releases/latest` 实测（见 references/fonts.md）。

### 与常见印象不符的（重点）
1. **霞鹜新晰黑是 IPA Font License，不是 OFL**（与同作者 OFL 授权的霞鹜文楷不同）。
2. **思源、得意黑都声明了 RFN**，子集化版本公开分发时严格说不应沿用原名；霞鹜文楷则专门许可了子集保留原名。
3. **`harmonyos-sans` npm 包写 GPL-3.0**——不能拿 npm/镜像的 license 判断字体授权。
4. **方正四款"免费字体"**：普遍印象"免费商用"，公开资料互相矛盾，官网无明确公开条款 → 按"需申请书面授权"处理。

## 2. 字体子集化（subset_font.py）实测

源字体：`/System/Library/Fonts/Hiragino Sans GB.ttc` 拷到 `tests/fixtures/_test-assets/assets/fonts/src/`（Apple 系统字体，**仅本地测试，已在台账标"不可进仓库"**）。
TTC 含 W3/W6 两个字重，共 22.43 MB；单抽 W3 存成 TTF 为 **11 MB**（29352 个字形）。

```
$ cd /tmp && .venv/bin/python -I <fa>/scripts/subset_font.py --films-dir <repo>/films --film _test-assets \
    --font "assets/fonts/src/Hiragino Sans GB.ttc" --font-number 0 --name hiragino-w3
✓ Hiragino Sans GB W3: 22.43 MB -> 20.5 KB  (140 字符, 0.09%)        # 只有 script.json 时
（加了 scene.html 后重跑）
✓ Hiragino Sans GB W3: 22.43 MB -> 24.5 KB  (158 字符, 0.11%)
  授权字段(name 13)：（字体里没写，去来源页确认）
```
子集字形数 258（含 ASCII、标点、.notdef 及 GSUB 关联字形）。
同字符集输出 TTF 为 32.6 KB（woff2 再省约 25%）。

**"改文案就要重做"的代价被实测撞上**：先子集化、后写 `scene.html`（注释里有中文），再跑 `--check`：
```
✗ hiragino-w3.subset.woff2 缺 18 个字（文案改过了？重跑子集化）：产从体出加图字对径标测的相试路载都集
exit=1
```
重跑后 `--check` → `✓ … 覆盖当前文案全部 158 个字符`，exit 0。

其他失败路径：源字体缺字（`--text "𠀀"`）→ exit 1 并列出；`--font nope.ttf` → exit 2。

## 2b. 缺字放行的作用域（`--allow-missing <类>`）— 2026-10-21

**问题**（weiqi-intro 作者报告）：中文片里的 Inter 只排数字，可收字是整片文案，不加 `--allow-missing` 过不去；
而旧的 `--allow-missing` 是全开关——放过汉字的同时，**Inter 自己该有的字缺了也一起放过**。
实测佐证：weiqi-intro 现在的文案里多了 `≈`，旧脚本裸放行照样 exit 0；新脚本按 `cjk,chars:→∈✓`（作者当年真正想放的范围）会点名 `≈`。

**修法**：放行必须写明类（`cjk`/`han`/`latin`/`digits`/`ascii`/`U+…`/`chars:…`，可加 `族名=` 前缀只对那一款字体生效）；
类外缺字照旧 exit 1，报"缺 N 个字（不在任何 --allow-missing 声明的范围内）"并列出已放行的分类计数。
声明写进台账 `allowMissing` / `missingAllowed`，`--check` 沿用。脚本顺带支持 `$FILMS_DIR`（与 check.mjs 同名；不设时行为不变）。

**阴性对照**（夹具在 scratch：`zh-digits` = 含"白子：${n} 口气"的中文片；`wq` = weiqi-intro 的 scene/script/narration 副本；
`zh-short.ttf` = Hiragino 只留 15 个字；`inter-no7.ttf` = Inter 拉丁片去掉 `7`）：

| 情形 | 命令要点 | 结果 |
|---|---|---|
| ① Inter 单文件，不放行 | `--font inter.woff2` | ✗ 缺 41 个字（汉字+CJK 标点+全角），exit 1 |
| ② Inter，放行 cjk | `--allow-missing cjk` | ✓ exit 0，`[cjk] 41 个` 列在 stderr |
| ③ 中文字体真缺字，放行只写给 Inter | `--font zh-short.ttf --allow-missing 'Inter Variable=cjk'` | ✗ 缺 126 个字，exit 1；提示"1 条放行限定了别的字体，不生效" |
| ③b Inter 缺了本该有的 `7`，放行 cjk | `--font inter-no7.ttf --allow-missing cjk` | ✗ **缺 1 个字：7**，exit 1（另报已放行 [cjk] 41） |
| ④ 旧裸写法 | `--font inter-no7.ttf --allow-missing` | ✓ exit 0（旧语义保留），stderr ⚠"关掉了全部缺字保护…缺的 133 个字全部放行" |
| 拼错类名 | `--allow-missing cjkk` | ✗ exit 2，列出可用类 |
| 分片包 Inter（weiqi-intro 副本），放行 cjk | `--pack @fontsource-variable/inter --allow-missing cjk` | ✗ 缺 4 个：`→∈≈✓` |
| 同上 + `chars:→∈≈✓` → `--check` | | ✓ build exit 0；`--check` 读台账声明 exit 0 |
| 文案加汉字「劫」/ 加 `→` 后 `--check`（单文件 Inter） | | 劫：✓ exit 0（在 cjk 内）；→：✗ exit 1 点名 `→` |
| 旧台账（旧脚本裸放行产出，无 `allowMissing`）`--check` | | ✗ exit 1，与旧版相同 |

**没用到新功能时行为不变**：同一夹具上 Noto 分片包不带放行，新旧脚本产出的 `.subset.css` 逐字节相同、`.subset.json`
只有 `bytesAfter` 不同、25 个 woff2 除 `head` 表外所有表逐字节相同——差异来自 fontTools 保存时写入的 `head.modified`
时间戳（旧脚本自己跑两次也一样不同），不是本次改动。台账只在用了放行时才多 `allowMissing` 两个键。

**没解决**：类是码位区间，不知道"这款字体在片子里实际排哪些字"——放行 `cjk` 的拉丁字体若被场景拿去排了汉字，
这里查不出（那是 font_proof.mjs / 回退检测的事）。`族名=` 前缀按 name 表 ID 1/16 或 CSS `font-family` 精确比较（不分大小写），
`Inter` 不会匹配 `Inter Variable`。

## 3. 浏览器里确认子集字体真能渲出（font_proof.mjs）

```
$ node <fa>/scripts/font_proof.mjs --films-dir <repo>/films --film _test-assets \
    --font assets/fonts/hiragino-w3.subset.woff2 --text "素材自包含：片子不依赖机器上装了什么。"
样张：tests/fixtures/_test-assets/out/font-proof-hiragino-w3.subset.png
✓ 19 个字全部由 hiragino-w3.subset.woff2 渲出（多组回退栈像素一致）

$ … --text "素材自包含龘鬱"          # 龘鬱 不在子集里
✗ 2/7 个字没由该字体渲出（回退了）：龘鬱      exit=1
```
**方法踩坑**：第一版只用 `serif` vs `monospace` 两组回退栈比对，**负例没检出**——Chromium 在 macOS 上对中文的
这两个 generic 回退落到同一款系统字体。改成 7 组（含 Songti/PingFang/Kaiti）后负例正确报错。
本机测试源恰好是系统已装的 Hiragino，所以 FontFace 用私有族名 `__proof__`，避免同名系统字体"冒充"。

另在 `scene.html` 里用 `new FontFace('TestHei', 'url(./assets/fonts/hiragino-w3.subset.woff2)')` 渲一帧
（借 film-critique 的 `openScene`）：`document.fonts` → `TestHei:loaded`，页面错误为空，
`out/scene-t0.png` 中句子与两个图标均正确。

## 4. svg2path.mjs

输入为手写的 Tabler 风格 SVG（含占位框、circle、polyline）、带 `rx` 的 rect + line + `<script>` + 注释、带 transform 的 rect：
```
✓ clock: 2 段（跳过 占位 path）
✓ card: 2 段（跳过 script/foreignObject/use/image（已忽略））
-> tests/fixtures/_test-assets/assets/icons/icons.json
exit=0
  clock.paths = ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0z", "M12 7L12 12L15 15"], strokeWidth 2, round/round
  card.paths  = ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z", "M3 10L21 10"], strokeWidth 1.5

$ … rotated.svg
✗ assets/_incoming/handmade/rotated.svg: <rect transform="rotate(45 8 8)">。忽略 transform 会画歪；加 --allow-transform …
✗ 1 个文件失败     exit=1
```
产出的 d 在 Chromium `new Path2D(d)` 中渲染正确（见 `out/scene-t0.png`）。
**未测**：真实 Tabler/Lucide 包里的文件（本次没下载图标包，用的是手写的同格式 SVG）。

## 5. media.mjs

```
✓ assets/_incoming/generated/big.png (1195.1 KB) -> assets/img/big.webp (68.2 KB)     # 4000x3000 testsrc2, --size 1080x1920 --fit cover
✓ assets/_incoming/generated/tone.mp3 (16.1 KB) -> assets/audio/tone.wav (375.1 KB)
ffprobe: webp 1080x1920；pcm_s16le 48000 Hz 2ch
不存在的输入 → exit 1；省略 --film 时解析到唯一的非下划线片子（当时是 scaffold-selftest）并报文件不存在 → exit 1
```
未测：`--fit contain` 的透明填充在 webp 下的表现。

## 6. audit.mjs

- `_test-assets`（台账齐全）：`✓ _test-assets: 5 个素材已入账，代码里无本机/外链依赖`，exit 0。
- 台账缺失时：`✗ assets/ 有 3 个文件但没有 assets/LICENSES.md`，exit 1。
- 构造的坏片子（scratchpad）：同时报 `local(PingFang SC)`、外链 `https://example.com/a.png`、
  `"PingFang SC"` 无本地声明、缺台账，exit 1。不存在的片子 → exit 2。

## 7. 分片包（subset_font.py --pack / font_proof.mjs 吃 CSS）— 2026-10-21 第二轮

起因：ghost-jam 的使用者为了用仓库里现成的 `@fontsource-variable/noto-sans-sc`（101 片 unicode-range woff2）
自写了 `tools/pick_font_chunks.mjs`（收字 → 找覆盖的片 → 原样拷 12 片 686 KiB + OFL → 写清单给 FontFace）。
测试片全部是 `films/` 的拷贝（scratchpad 里），命令从 `/tmp` 跑、`--films-dir` 指过去。

```
$ subset_font.py --film ghost-jam --pack @fontsource-variable/noto-sans-sc --rename "GhostJam Sans" --name noto-sans-sc
✓ Noto Sans SC Variable（@fontsource-variable/noto-sans-sc@5.3.1）：101 片中挑 23 片，1.22 MB -> 152.1 KB  (512 字符, 逐片子集化)
  许可：SIL OFL 1.1，RFN ['Source']；原文已拷到 assets/fonts/noto-sans-sc/LICENSE
（1.57 s）
$ … --copy-chunks        → 23 片 1.22 MB -> 1.22 MB；拷出的片与 node_modules 原片 sha256 相同
$ … --check assets/fonts/noto-sans-sc.subset.css             → ✓ 覆盖当前文案全部 512 个字符，exit 0
$ … --check … --text "龘"                                     → ✗ 缺 1 个字：龘，exit 1
$ rm assets/fonts/noto-sans-sc/LICENSE; … --check …           → ✗ 许可文件不见了…（OFL 要求随字体分发），exit 1
$ … --pack tests/fixtures/_test-typography/assets/fonts/fonts.css      → ✗ 有 2 个族，用 --family 指定，exit 2
$ … --family "Noto Sans SC Variable"                          → ✗ 分片包旁边找不到许可文件…用 --license 指定，exit 1
$ … --license node_modules/@fontsource-variable/noto-sans-sc/LICENSE → ✗ 分片包缺 34 个字，exit 1（它是只挑了 14 片的包）
$ … --font assets/fonts/noto-sans-sc.subset.css               → ✗ 是分片包（CSS/目录），用 --pack，exit 2
```
- 挑片比使用者的工具多 11 片，是因为收字来源多了 `scene.html` 的全部非 ASCII（含注释）和常用中文标点（512 字 vs 它只收旁白）；
  体积仍从 686 KiB 降到 152 KB，因为每片只留分到它的字。
- 子集后的片仍是可变字体：`fvar` 轴 `wght 100–900`、`gvar` 在；name 表 0（Adobe 版权 + RFN 'Source'）和 14（OFL URL）保留。
- **子集化不改字形，实测**：把 ghost-jam 拷贝改成 `<link>` 产出的 `.subset.css`，与原片（原样分片）在 t = 4 / 9.5 / 15 / 21 s
  各截一帧 canvas（`page.screenshot`，不回读），ffmpeg 解码成 raw RGBA 后 md5：**4 帧全部相同**。
- 重跑保护：在产出目录手放一个 `handmade.woff2`，重跑后仍在（只删上次 `.subset.json` 记着的文件）。
- `font_proof.mjs --font assets/fonts/noto-sans-sc.subset.css --weight 600` → `✓ 416 个字全部由 …（23 片）渲出`（0.8 s）；
  `--text "幽灵堵车龘鬱"` → `✗ 2/6 个字没由该字体渲出：龘鬱`，exit 1。单文件路径回归：hiragino 子集仍 19 字 ✓，重新子集仍 22.43 MB -> 24.5 KB。
- `audit.mjs` 台账一行记目录 `assets/fonts/noto-sans-sc/`：25 个素材已入账，exit 0（改前要逐片记 12 行）。

## 8. 字体来源检查（font_source.mjs）

**前提和交代的不一样**：仓库里现在的 `films/ghost-jam` 已经被它的作者在定稿前改成了 Noto 分片（review_log 第 70 行），
所以真实目录是**绿**的。红例是按 review_log / style_guide 还原的"改之前"：拷贝一份，去掉 FontFace 加载，
字幕 `font: '"PingFang SC"'`（A）。另外构造了 7 个变体覆盖其它失败方式。

| 用例 | 结论 | 关键输出 |
|---|---|---|
| `films/ghost-jam`（真实，已改用 Noto 分片） | ✓ exit 0，2.7 s | 96 次 seek @0.25 s；`600 58px "GhostJam Sans"` 972 次 fillText、59 个字全部由随片字体画出 |
| `tests/fixtures/_test-typography`（真实） | ✓ exit 0，0.5 s | Noto Sans SC Variable 14 片 + Inter 1 片；10 条栈全过；⚠ assets/fonts 没有许可文本 |
| A 改前状态：`"PingFang SC"`，不加载随片字体 | ✗ exit 1 | 没有任何随片字体，59 个字全部由系统字体画出。"PingFang SC" 是本机系统字体 |
| B `"PingFang SC", "GhostJam Sans"` | ✗ | 排在随片字体前的 "PingFang SC" 是本机装的系统字体 |
| C 分片清单删掉一片（116 号） | ✗ | 7 个字随片字体里没有，回退到了系统字体：十速红只几每走（正是那一片的 7 个字） |
| D `local("PingFang SC")` | ✗ | 静态层抓到 local()；该 FontFace 加载失败、`window.ready` 拒绝，浏览器层报失败 |
| D2 `local("PingFangSC-Semibold")`（能加载成功） | ✗ | 字体族 "GhostJam Sans" 有 12 个 new FontFace 来源不随片：local(…) |
| E `"Microsoft YaHei", "GhostJam Sans"`（本机没装雅黑） | ✗ | 别的平台的系统字体：换到有它的机器上它会抢先画字 |
| F 族名拼错 `"GhostJam Sanz"` | ✗ | 没有任何随片字体；该名"本机没有也没声明（拼错了？）" |
| G 加两段 DOM 文字（PingFang / 随片） | ✗ | CDP：`"片头系统字" PingFang SC（系统）×5` 不合格；`"幽灵堵车" Noto Sans SC Thin×4` ✓ |

- **旧 `audit.mjs` 对 A、B、E 全部 exit 0**（`✓ … 代码里无本机/外链依赖`）：它的族名正则只认 `font = '… 48px X'` 这种字面量，
  `font: '"PingFang SC"'` + 模板字符串拼接看不见。这就是 F-027 一路做到渲染都没人拦的直接原因。
- 用系统 PingFang 和随片 Noto 渲同一帧（t = 9.5 s，字幕"后面的就慢得更多，一辆传一辆。"）：1920×1080 里 **12131 px 不同（0.59%），最大差 205/255**。
- `--static-only`：A → ✗（scene.html:292 "PingFang SC"）；C → ✓（**缺字回退静态层查不到**，所以它不是默认）。
- 全仓库片子扫一遍（只读）：`_test-critique`、`_test-narration`（`54px sans-serif`）、`demo-tls`（`ui-monospace, monospace`）✗；
  `demo-grid`、`tang-dynasty` 没有 `window.seek`（旧契约）exit 1；其余 ✓（其中 5 支采样时刻没画字，警告）。
  demo-tls 正是 ARCHITECTURE §3 里"等宽字体回退选了不同的字、headless shell 与完整 Chrome 差 5.4–13.6%"那支——这个检查会提前抓到它。
- 方法上踩的坑：canvas 必须挂进文档才比得出 CJK 回退差别（沿用 film-typography `missingGlyphs` 的实测结论）；
  回退栈用 7 组（沿用 font_proof 第一版只用 2 组漏检的教训）。

### 8b. 字体来得晚（判定 6）— 2026-10-21

起因：weiqi-intro 的 `白子：${n} 口气` 里的数字没列进 `loadFonts`，数字所在分片要等第一次画到才加载。
旧版本门对它是**绿**的（字不缺，只是加载晚）；seamcheck 门 1a/2 红，但提示语说"读了时钟/有跨帧状态"。

判法：`FontFace.status` 在 fillText 触发加载时**同步**变成 `loading`（实测：seek 返回前就变了，网络请求随后才发），
所以每次 seek 后比一遍 `document.fonts` 的状态就能把加载归到那一次 seek，再拿这一次 seek 画过的字和那一片的
`unicodeRange` 求交，点名是哪些字。字体文件请求只作旁证（请求晚于状态变化，按请求归属会错帧）。

| 夹具（`FILMS_DIR` 指 scratchpad） | 结果 |
|---|---|
| lazy-bad：`loadFonts` 只列 `白子：口气`，t≥2 画 `白子：${⌊t⌋} 口气` | ✗ exit 1：t=2s 起 `U+20-3D…` 分片，首次由 `2␠` 触发（全片画过的 `234␠`） |
| lazy-ok：同上，改成 `{ text: '白子：口气 ', sets: ['digits'] }` | ✓ exit 0 |
| weiqi-intro 副本，allText 去掉 `' 0123456789'`（还原原缺陷） | ✗ exit 1：t=51s 起，首次由 `0␠` 触发 |
| 同上，按类声明修好 | ✓ exit 0 |
| ghost-jam / demo-tls / weiqi-intro（真实目录） | 三支都 ✓ exit 0，没有新增报错 |

盲区：只在某个采样时刻第一次画到的分片才抓得到；只在两个采样时刻之间出现的字，它触发的晚加载看不到（`--step` 越小越全）。

## 9. 环境声 / 底噪

判断：**没写成脚本，写成了手法 + 来源表**（references/audio.md 第 5 节）。ghost-jam 的作者已经用一条 ffmpeg 命令绕过去了，
缺的不是工具，是"它听起来像什么、代价是什么、真素材从哪找"。

```
# 同一条命令跑两次，wav 的 md5：
ghost-jam 配方（brown seed=7, lowpass 380）  0afa80467a42854cb4f34a72a36d6c91 ×2
两层配方（pink 带通 + brown 低通 + tremolo）  2ef65163feff965b80b21f78a5f0484b ×2
# librosa 频谱（10 s，单声道 48 kHz）
gj1.wav   centroid 320 Hz   <200Hz 71.7%  200-2k 28.3%  >2k 0.0%
road1.wav centroid 1457 Hz  <200Hz 67.4%  200-2k 30.1%  >2k 2.5%
```
来源核查：Freesound FAQ 原文（CC0 / CC BY / CC BY-NC，CC0 不要求署名，搜索可筛 Free Cultural Works）✔；
Sonniss GDC 包页面原文（可商用、不要求署名、不能单独再分发音效、禁止 AI/ML 训练）✔；BBC Sound Effects 页面抓不到 △。

## 10. media.mjs tiles（拆片帧网格）— 2026-10-23

```
$ node media.mjs tiles films/demo-tls/out/final-9x16.mp4 --words films/demo-tls/narration.json --count 20 --cols 6 --out <scratch>/demo-tls-grid.png
✓ 20 格（6×4），10.87s -> demo-tls-grid.png (935.5 KB)        # 1948×2564，1.6 s 墙钟
  词标注：37 个词，offset 0s（【】= 该时刻正在念）
$ node media.mjs tiles --film weiqi2-cards out/final-9x16.mp4 --cuts --cols 5 --width 300 --out <scratch>/cards.png
✓ 5 格（5×1），15.00s；剪切点 4 个（scene > 0.3）：3.00 6.00 9.00 12.00     # 五张卡各 3 s，实际切点就在这里
$ node media.mjs tiles --film weiqi2-l1 out/final-9x16.mp4 --words narration.json --cuts …
剪切点 0 个；offset 0.6s（自动取 film.json narrationOffset）
```
人眼看过网格：每格时刻与画面字幕对得上（demo-tls 0.91 s 格标「看一条【公】开的线」，画面字幕同句）。
最后一行不满时 tile 滤镜照常出图（20 格排 6×4）。
**没解决**：weiqi2-l1 全片 scene 最高分 0.084，镜头之间是同底色上的过渡，`--cuts` 一个也不报——硬切以外的切换它看不见。
只在 macOS（Hiragino Sans GB，fc-match 给出）上跑过，Linux 的字体查找路径未测。

## 没解决 / 没测到
- **两层底噪配方没有经过人耳**：频谱质心从 320 Hz 到 1457 Hz 只是数字，"像路"还是"像空调"没人听过。ffmpeg 换版本后是否仍字节一致没测（只在 8.0 上测了两次）。
- font_source 只看采样时刻（默认每 0.25 s 一次）画过的字；短于步长的一闪而过的字可能漏采。Worker 里的 OffscreenCanvas、WebGL 自己栅格化的文字看不到。
- font_source 的"本机是否装了某字体"是像素探针，只在这台 macOS 上验证过；Linux（字体栈是 FreeType/fontconfig 的别名替换，比如把 Arial 映射到 Liberation Sans）上会不会把"没装"判成"装了"没测——那种情况下措辞会变，但判定仍是不合格（不在随片声明里）。
- font_source 没在 WebGL / SVG `<text>` 的片子上实测（DOM 分支只测了 div）；`new FontFace(name, ArrayBuffer)` 分支没有真实用例，只写了推断逻辑。
- 分片包只测了 fontsource 的可变字体包（每片一个 face）。多字重静态包（如 `@fontsource/noto-sans-sc` 的 400/700 两套 CSS）的分组挑片逻辑写了，没实测。
- `--pack` 的 unicode-range 与 cmap 不一致（range 声称有、cmap 没有）在 fontsource 包里一次都没出现，`--check` 只警告不判错——Chromium 遇到这种片会不会继续找下一片没验证。
- `_test-typography` 的分片包没有许可文本（film-typography 拷进去时没带 LICENSE），font_source 只警告；那个目录不归本 skill 改。

### 上一轮遗留
- **HarmonyOS Sans、OPPO Sans、阿里巴巴普惠体、方正四款的官方协议原文没读到**（SPA 抓不到正文，未下载官方 zip）。references/fonts.md 里都标了 △。
- **子集化是否算厂商协议里的"修改/外观更改"**：协议没写，无法给结论，只给了保守做法。
- **icons-images.md 与 audio.md 的来源表沿用旧 skill 记录，本次未逐条复核原文**（已在文件头注明）。YouTube 音频库站外使用、Coverr API 商用仍待核。
- ~~字体子集化没在 OFL 字体上实测~~ 第二轮已在 Noto Sans SC（OFL，TrueType glyf 可变）分片上实测；fontTools 对 CFF/OTF（思源 OTF）的子集化路径仍未实测。
- audit.mjs 的族名检测基于正则，运行时拼出来的 `ctx.font` 字符串（模板字符串含 `${}`）会被跳过。第二轮没改它，字体来源改由 font_source.mjs 在浏览器里判（见第 8 节）。
- font_proof 的检测在"所有回退栈都落到同一款系统字体"的极端环境下会漏报；cmap 层的 `--check` 是互补的硬判据。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

装机 md 从 604 行瘦到 463 行。skill 里只留结论 + 代价数字，下面这些实测来历只在本文件：
- **子集化体积**：SKILL.md 只写"11 MB 单字重 → 24.5 KB woff2，158 字符"；源是 Hiragino Sans GB W3（TTC 22.43 MB），见第 2 节。
- **`--copy-chunks` 体积约 8 倍**：样例是 ghost-jam（101 片挑 23 片，1.22 MB vs 152.1 KB），见第 7 节。
- **`--cuts` 漏同底色切换**：样例是 weiqi2-l1（全片 scene 最高 0.084），见第 10 节。
- **两层底噪配方的由来**：单层棕噪声低通 380 Hz 是 ghost-jam 的原做法（质心约 320 Hz），两层配方质心约 1457 Hz、两次 md5 相同，见第 9 节。
- **"与常见印象不符的"四条**（霞鹜新晰黑是 IPA、思源/得意黑有 RFN、npm 包 GPL-3.0、方正四款）：原在 references/fonts.md 第 6 节，
  已删；霞鹜新晰黑并入 fonts.md 第 4 节表格，其余三条在表格备注里各留一处。全文见本文件第 1 节。
- fonts.md 原第 10 节（font_source 判定表指针）与 SKILL.md 重复，删去；判定表本体在 film-core `references/kernel.md`。
