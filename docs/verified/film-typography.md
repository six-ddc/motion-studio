# film-typography 实测记录

环境：macOS Darwin 25，Playwright 1.64，**Chromium 156.0.8078.4**（headless），2026-10-21。
所有命令在仓库根运行。原始输出都存在 `tests/fixtures/_test-typography/out/`。

## 1. 运行时在浏览器里按 t 求值：seamcheck 三门

测试片 `tests/fixtures/_test-typography/`：中文标题逐字遮罩升起（`layoutCJK` 相邻标点挤压）+
`Motion` 字重 100→900 连续插值（标准 ctx.font）同时 opsz 14→32（非标准 `setAxes`）+
每帧按当前字重重新 `splitText` 前缀测量 + 中文段落 `wrapCJK` 避头尾 + 打字机 + 统一出场，
首帧 = 末帧（全空）。字体由 `fontpack.mjs` 打进 `assets/fonts/`（Noto Sans SC 14 片 771.6 KB，
Inter opsz 1 片 71.2 KB），`window.ready` 里 `loadFonts` 覆盖全部文案与两个端点字重。

```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-typography
影片 _test-typography  入口 scene.html  9x16 1080×1920  4s @ 30fps  采样 8 个时刻  loop=true
门 1a  同一页面，同一个 t 求两次：            ✓ 通过（8/8 逐像素一致）
门 2  乱序求值（种子 7 打乱后再扫一遍）：      ✓ 通过（8/8）
门 3  3a frame(0) vs frame(4): 逐像素一致
      3b 跨缝 frame(3.967)→frame(0): 0 像素变化；容差 2074   ✓ 通过
门 1b  全新页面重新加载，同一批 t 再求一次：  ✓ 通过（8/8）
探针  seek 期间调用的禁用 API：              ✓ 无
全部通过   (exit 0)
```
全文见 `tests/fixtures/_test-typography/out/seamcheck.txt`。静帧 `out/still-2.8.png` 人眼看过：
标题第一版字号 0.085 撑出画幅，改成 0.075 后正常；段落第一行以 `kerning！` 结尾（`！` 未落行首）。

## 2. 两条非标准行为复核：**仍然成立**

```
$ node skills/film-typography/scripts/probe.mjs
Chromium 156.0.8078.4   字体 node_modules/@fontsource-variable/inter/files/inter-latin-standard-normal.woff2
  ✓ 数字字重连续（650≠651）   {"400":241.52,"650":257.22,"651":257.28,"900":276.41}
  ✓ ctx.fontStretch 存在且只吃关键词（75% 被拒）   设 75% 后读回 condensed
  ✓ 【非标准】canvas 元素 font-variation-settings 生效   宽 241.52 -> 276.41，墨 5513 -> 10323
  ✓   且必须重设 ctx.font 才生效   不重设时宽 241.52
  ✓   任意轴（opsz 14 vs 32）   261.02 vs 241.52
  ✓ 合成粗体发生且 advance 不变（measureText 测不出）   advance 241.52/241.52，墨 5513 -> 7194
  ✓ 【非标准】canvas 元素 font-synthesis:none 关掉合成粗体   关后墨 5513
  ✓ 陷阱：fonts.check(不存在的字族) 返回 true   check=true load()=0 个 face
  ✓ 逐字相加会漂（需前缀测量）   整串 679.73 vs 逐字和 727.54，漂 47.81px @80px
  ✓ Intl.Segmenter   画面/必须/是/时间/的/纯/函数
  ✓ CJK/全角标点 advance = 1em   {"画":40,"，":40,"。":40,"「":40,"—":40}
```
- font-variation-settings：`'wght' 900` 写在 canvas 元素上，**不重设 ctx.font 宽度不变（241.52）**，
  重设后 276.41——与旧实测 241.5 → 276.4 一致。新增证据：非 wght 轴也生效（opsz 14/32 宽 261.02/241.52）。
- font-synthesis：只声明 400 的 face 要 700，墨量 5513 → 7194；canvas 元素 `font-synthesis:none`
  后回到 5513——与旧实测一致。同时 advance 400/700 都是 241.52，**measureText 完全测不出合成粗体**。
- 测法要点：可变字体测轴（静态字体必然假阴性）；单字重 face 测合成（可变字体的 700 是真字重）；数墨水像素。

## 3. 可读性下限（9:16，360 有效宽）

```
$ node skills/film-typography/scripts/legibility.mjs --film _test-typography \
    --cjk '"Noto Sans SC Variable"' --latin '"Inter Variable"'
```
**怎么测的**：1080 宽成片尺度下白字黑底画字 → canvas `imageSmoothingQuality:'high'` 缩到 360 宽
（1 有效 px ≈ 手机 1 CSS px）→ 沿笔画垂直方向取墨量剖面，50% 墨量处二值化数段数。
中文：「量」（9 段横画，密字）与「言」（6 段，常规字），在 bbox 宽 15%–85% 每一列都数、取最大
（避开竖画穿过的列——第一版只取中线，正好落在「里」的中竖上，全字号都是 1 段，是测法错）。
拉丁：`mmm` 中部横线上数竖干（9 根）。参考段数取 300px 时的值。下限 = 从此往上全部等于参考值的最小字号。
字号步长 2px，范围 12–72。

| | 400 | 700 |
|---|---|---|
| 拉丁 mmm | **26px**（8.7 有效 px） | **30px**（10.0） |
| 中文 言 | **56px**（18.7 有效 px） | 72px 内无稳定下限（62–72 在 5/6 与 6/6 间跳） |
| 中文 量 | 72px 内无（62 起 7–8/9） | 72px 内无 |

形近字缩小后平均像素差：未/末 0.006–0.019，己/已 0.009–0.021（全字号区间），rn/m 0.09–0.17。
中文形近字差异比拉丁小一个数量级——这是中文需要更大字号的直接证据。

**对比度**：下限字号处笔画峰值墨量中位数——拉丁 400@26：0.63；拉丁 700@30：0.94；中文 400@56：0.94。
按覆盖率在 sRGB 编码空间混合前景与背景（canvas 缩放就这样混），深灰底（编码值 0.07）上
有效对比度 ≥ 4.5:1 所需的**标称**对比度：拉丁 400@26 → **9.8:1**；拉丁 700@30 → **5.0:1**；
中文 400@56 → **4.9:1**。有效 ≥ 7:1：分别 16.6 / 7.8 / 7.8:1。
全表：`tests/fixtures/_test-typography/out/legibility.txt`，原始数据 `legibility.json`。

**这个测法的局限**（如实写）：
- 50% 阈值的笔画分离是严格标准；人读中文靠轮廓与上下文，能读出比这更小的字，但形近字会混。
- 像素相位影响大：同一字号 ±2px 段数会跳（见表中 42–54px 区间），所以下限取"之后全部稳定"。
- 只测了一对字体、白字黑底、无 H.264。没有做真人阅读测试。

## 3b. 中文粗体下限（补 `cjk_bold`）：**700 → 88px 成片 / 29.3 有效 px**

2026-10-21 补测。**同一套方法、同一判据、同一对字体**（Noto Sans SC Variable 5.3.1 分片 + Inter Variable，
白字黑底，1080→360，`imageSmoothingQuality:'high'`，「言」6 段横画、bbox 15%–85% 列取最大、50% 墨量二值化、
参考 = 300px 段数、下限 = 从此往上到扫描上限全部等于参考的最小字号）。脚本只加了参数和附加诊断，主判据代码没动。

**先证明新脚本没改旧判据**：默认参数重跑，逐行比对旧表：
```
$ node skills/film-typography/scripts/legibility.mjs --film _test-typography \
    --cjk '"Noto Sans SC Variable"' --latin '"Inter Variable"' --out legibility-repro
$ diff <(grep -E '^\s+[0-9]+ ' tests/fixtures/_test-typography/out/legibility.txt) \
       <(grep -E '^\s+[0-9]+ ' tests/fixtures/_test-typography/out/legibility-repro.txt) && echo DEFAULT_TABLE_IDENTICAL
DEFAULT_TABLE_IDENTICAL
```

**为什么当初是 null**：扫描范围写死 12–72px。700 在 62–72 是 5/6 与 6/6 交替的过渡区，范围在过渡区里截断，
所以"72 内无稳定下限"。不是"粗体中文没有稳定阈值"——扩到 200px：
```
$ node skills/film-typography/scripts/legibility.mjs --film _test-typography \
    --cjk '"Noto Sans SC Variable"' --latin '"Inter Variable"' \
    --weights 100,200,300,400,500,550,600,650,700,800,900 --min 12 --max 200 --step 2 --phases 8 \
    --out legibility-cjk-weights
```
700 的「言」段数（成片 px：段数，括号内 = 8 个亚像素相位里分得开的个数）：
`72:5(5) 74:6(4) 76:6(8) 78:6(6) 80:6(6) 82:6(7) 84:6(5) 86:5(7) 88:6(8) 90:6(8) … 200:6(8)`。
**88px 起到 200px 连续 57 个字号全是 6/6，且 8 个相位全过**。主判据下限 = 相位稳健下限 = 88px（29.3 有效 px）。
扩范围后旧三个数不变：400 言 56、拉丁 400 26、拉丁 700 30。

**字重函数**（1080→360，有效 px；全表 `out/legibility-cjk-weights.txt`）：

| 字重 | 言 主判据 | 言 8 相位全过 | 言 最小间隙 em | 下限×间隙（有效 px） | 量 | mmm | mmm 内白 em |
|---|---|---|---|---|---|---|---|
| 100 | 26.7 | 27.3 | 0.107 | 2.85 | 23.3 | 32.7 | 0.131 |
| 200 | 17.3 | 20.7 | 0.101 | 1.75 | 23.3 | 16.0 | 0.128 |
| 300 | 17.3 | 18.0 | 0.097 | 1.68 | 23.3 | 12.7 | 0.126 |
| 400 | **18.7** | 23.3 | 0.082 | 1.53 | 26.7 | **8.7** | 0.123 |
| 500 | 24.0 | 25.3 | 0.071 | 1.70 | 33.3 | 8.7 | 0.116 |
| 550 | 24.0 | 25.3 | 0.068 | 1.63 | 34.0 | 9.3 | 0.113 |
| 600 | 24.7 | 27.3 | 0.065 | 1.60 | 34.0 | 9.3 | 0.109 |
| 650 | 24.7 | 27.3 | 0.061 | 1.50 | 34.0 | 12.7 | 0.105 |
| 700 | **29.3** | 29.3 | 0.057 | 1.67 | 36.7 | **10.0** | 0.102 |
| 800 | 28.0 | 30.0 | 0.051 | 1.43 | 49.3 | 12.0 | 0.094 |
| 900 | 30.7 | 38.7 | 0.044 | 1.35 | 59.3 | 14.0 | 0.084 |

**这张表只在 1080 宽的片子上成立。** 「有效 px」看起来是个画幅无关的量（都归一到 360 观看宽），
实测不是。同一字体、同一观看宽 360，只换 `--frame-width` 做对照（言 400 档主判据）：

| 画幅→360 | 缩放 | 言 下限（有效px） | 8 相位全过 |
|---|---|---|---|
| 1080 | ×3.00 | **18.7** | 23.3 |
| 1440 | ×4.00 | **21.5** | 21.5 |
| 1920 | ×5.33 | **21.4** | 21.4 |

机制：缩得越狠，相邻笔画在重采样里并得越多。1080 那一档精确复现本表的 18.7 / 23.3，
说明差异来自缩放比，不是别的。×5.33 全字重实测（同字体）：

| 字重 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 |
|---|---|---|---|---|---|---|---|---|---|
| ×3（本表） | 26.7 | 17.3 | 17.3 | 18.7 | 24.0 | 24.7 | **29.3** | 28.0 | 30.7 |
| ×5.33 | 29.6 | 22.1 | 20.3 | 21.4 | 24.0 | 28.1 | **26.3** | 29.6 | 32.3 |
| 差 | +2.9 | +4.8 | +3.0 | +2.7 | 0 | +3.4 | **−3.0** | +1.6 | +1.6 |

9 档里 7 档 ×5.33 更严（+1.6…+4.8），500 相等，**700 反而松 3.0**。
所以没有干净的乘法修正——单调下限这个统计量对任意一个字号上的凹陷很敏感，噪声就在这个量级。
能确定的只有一句：**不是画幅无关，且对多数字重偏松**。
`check.mjs` 因此按缩放比分列、取两列里更严的那个（ratio < 3.5 仍只用 ×3 列，不凭空加严）。

这条是怎么被发现的：ghost-jam（1920 宽横版）字幕按 18.7 定到 106px，门是绿的；
把 `legibility.mjs` 指到它自己的画幅上重测，下限是 21.4，19.9 落在 18.7–21.4 这段放过去的区间里。
**门量的是"字号×观看缩放"，门说的是"这支片的字读得清"**——第七个同形盲点。

「间隙」= 1000px 不缩放画、在段数等于参考的列里取"最小笔画间隙最大"那一列（检测器取各列最大段数，
所以可分性由最好那一列决定）。200–900 的「下限×间隙」都落在 1.35–1.75 有效 px：**下限 ≈ 1.5 有效 px ÷ 间隙(em)**。
这就是粗体变差的机制：加粗不改字身，只把笔画往间隙里长。100 字重偏离这条线（2.85），
是另一种失败——发丝横画缩小后峰值墨量不到 50%，二值化时整段消失。
拉丁为什么不一样：mmm 内白本来是「言」间隙的 1.5 倍，400→700 只缩 17%（「言」缩 30%）；
而拉丁 400 的下限卡在细竖干被抹灰（峰值墨量 0.63），700 把墨量补到 0.94，两种效应相抵。
（"拉丁粗体比常规更清楚"只对对比度成立；笔画分离上拉丁粗体也更差，只是差得少：+15% 对中文 +57%。）

**会红的对照**（`--at`，700，1080→360，8 相位）：
```
$ node skills/film-typography/scripts/legibility.mjs --film _test-typography \
    --cjk '"Noto Sans SC Variable"' --latin '"Inter Variable"' --weights 400,600,700 \
    --min 12 --max 200 --step 2 --phases 8 --at 32.8,44,56,72,86,88,100,120,160 --out legibility-cjk-bold-controls
```
| 成片 px（有效 px） | 32.8 (10.9) | 44 (14.7) | 56 (18.7) | 72 (24.0) | 86 (28.7) | **88 (29.3)** | 100 (33.3) | 120 (40.0) | 160 (53.3) |
|---|---|---|---|---|---|---|---|---|---|
| 700 言段数 / 相位 | 4/6 · 0/8 | 3/6 · 0/8 | 5/6 · 0/8 | 5/6 · 5/8 | 5/6 · 7/8 | **6/6 · 8/8** | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 |
| 600 | 4/6 · 0/8 | 4/6 · 0/8 | 5/6 · 1/8 | 5/6 · 5/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 |
| 400 | 4/6 · 0/8 | 6/6 · 1/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 |

下限以下（≤ 86px）全判"分不开"，以上全判"分得开"；同一字号 56px 下 400 分得开、700 分不开——
判据对字重敏感，不是对什么都说过。

**换缩放倍数复核**（ghost-jam 是 1920 宽，×1/5.33 而不是 ×1/3）：同一字体，`--frame-width 1920 --max 220`，
「言」下限 400 → 114px（21.4 有效 px），600 → 150px（28.1），700 → 140px（26.3；8 相位全过 156px = **29.3**）。
有效 px 跨缩放倍数基本可迁移，单次测量差 ±15%；700 的相位稳健值两个倍数下都是 29.3。

## 3c. 用例：ghost-jam 的字幕 —— **不过**

ghost-jam：16x9 1920×1080，字幕 `600 ${L.size(0.054)}px "GhostJam Sans"` = 58.32px 原生，
360 宽下 **10.9 有效 px**。"GhostJam Sans" 就是 Noto Sans SC Variable 5.3.1：它的 11 个分片和
`_test-typography` 里同名文件 md5 逐个相同（第 12 个 `111` 只在 ghost-jam 里有）。只读，不改那个目录。

为了逐字测它的全部字幕字，在本 skill 的测试片 out/ 里搭一个全量字体夹具（软链 fontsource，不拷字体）：
```
$ F=tests/fixtures/_test-typography/out/fixture-noto-full/assets/fonts; mkdir -p $F && \
    cp node_modules/@fontsource-variable/noto-sans-sc/wght.css $F/fonts.css && \
    ln -sfn "$PWD/node_modules/@fontsource-variable/noto-sans-sc/files" $F/files
$ T="$(node -e 'const s=require("./films/ghost-jam/script.json");process.stdout.write(s.lines.map(l=>l.text).join(""))')"
$ node skills/film-typography/scripts/legibility.mjs --dir tests/fixtures/_test-typography/out/fixture-noto-full \
    --cjk '"Noto Sans SC Variable"' --latin '"Noto Sans SC Variable"' --frame-width 1920 \
    --weights 400,600,700 --min 12 --max 220 --step 2 --phases 8 --chars "$T" --at 58.32,100,132,160,180 --out ghostjam-1920
```
（`--chars` 先用挂载 canvas 的两种回退比像素确认 57 个字都在字体里，缺一个就抛错。）

| 1920 宽，600 字重 | 58.32 (10.9) | 100 (18.8) | 132 (24.8) | 160 (30.0) | 180 (33.8) |
|---|---|---|---|---|---|
| 言 段数 · 相位 | **3/6 · 0/8** | 6/6 · 5/8 | 6/6 · 8/8 | 6/6 · 8/8 | 6/6 · 8/8 |
| 字幕 57 字里分得开的 | **16/57** | 35/57 | 44/57 | 47/57 | 49/57 |

结论：**10.9 有效 px 远低于 600 字重自己的下限 24.7，也低于 `cjk_bold` 取 700 值的 29.3，
甚至低于常规档 18.7**。按任一档都是 FAIL，不是 LOOK。58px 时分得开的 16 个字全是简单字
（一二十个灯可只了下后几分钟开走么）；「圈路辆车速度事故慢停堵」这些片子的关键词全分不开。
要过，1080 尺度的 24.7 有效 px 换到 1920 宽 ≈ 132px 原生，是现在的 2.3 倍。
附带一个观察：`cjk_bold=null` 让粗体反而比常规宽松——同一字幕若用 500 字重会被 18.7 判 FAIL，用 600 只得 LOOK。

逐字下限（`--chars`）的读法：同一判据逐字套用，每字以自己 300px 的段数为参考。它**噪声大**——
「前红每名」在 400 到 220px 都不稳定，「灯」400 下 30px 就稳、600 下到 220 都不稳。
原因是判据只数横画，斜画、点、竖钩多的字段数在大字号也会因列位置跳。所以它只当分布参考，阈值仍只用「言」——
这也是当初测 cjk=18.7 时处理字形复杂度的方式（常规字「言」定阈值，密字「量」单列参考）。

## 4. 中文字体大小对渲染启动的影响

```
$ node skills/film-typography/scripts/fontcost.mjs out/fontcost/hiragino-full.ttf … --runs 5
文件                                     大小      load 中位   first 中位   (ms, 5 次)
hiragino-full.ttf                     11.08 MB       76.1         2.5
hiragino-full.woff2                    7.83 MB      145.6         2.4
hiragino-subset.woff2                  0.02 MB        1.6         1.8
noto-sans-sc-100-wght-normal.woff2     0.06 MB        2.5         9.0
```
测试文件：从 `/System/Library/Fonts/Hiragino Sans GB.ttc` 用 fontTools 抽出第 0 个字面（**系统字体，
仅用于测大小，不可分发**，只放在 `tests/fixtures/_test-typography/out/fontcost/`）；woff2 用 fontTools 转；
子集用 `pyftsubset --text-file=docs/text.txt`。每个文件 5 个新页面，本地回环服务器。
结论：11 MB 级中文字体启动代价约 0.1 s/页，不是瓶颈；WOFF2 因 brotli 解压比 TTF 慢一倍。

## 5. 运行时单元行为

`node tests/fixtures/_test-typography/tests/unit.mjs`（输出 `out/unit.txt`）：

| 用例 | 结果 |
|---|---|
| `loadFonts` 正常字体 | ok |
| 字族名拼错 `"Noto Sans SC Varable"` | 抛错：没有任何 @font-face 匹配 |
| 分片里没有的字 `龘` | 抛错：缺字形 龘 |
| 拉丁字体画中文 `"Inter Variable"` + `画` | 抛错：缺字形 画 |
| `wrapCJK('一二三四五，六七', 200)` | `一二三四 / 五，六七`（逗号不落行首，带前一字下行） |
| `wrapCJK('一二三四「五六七', 200)` | `一二三四 / 「五六七`（开括号不落行尾） |
| `wrapCJK('一二三seek(t)四五', 200)` | `一二三 / seek(t)四 / 五`（拉丁串不拆） |
| `wrapCJK('一二三四五。」六', 200)` | `一二三四 / 五。」六`（连续两个避头字符） |
| `layoutCJK('「好」，。啊', 40)` | none 240 / adjacent 180 / half 160 px |

`missingGlyphs` 第一版用**未挂载**的 canvas，`画` 在 serif / sans-serif 两种回退下像素相同，
导致缺字检测全部漏报；挂进文档后两种回退不同（`tests/fb.mjs` 复现）。已修。

**第二个同类漏报（2026-10-21 补测 §3b 时发现，已修）**：挂载了还不够，**文档没有 `lang` 属性时**
serif / sans-serif / cursive 的 CJK 回退全落到同一个系统字体。自测片 `<html lang="zh">` 所以单元测试是绿的；
ghost-jam 的 scene.html 没有 `lang`。实测「龘」（不在分片里）三种回退墨量：无 lang 566994 / 566994 / 566994，
canvas 上 `setAttribute('lang','zh')` 后 433586 / 566994 / 332261；`ctx.lang = 'zh'` 效果相同。
`missingGlyphs` 现在在自己的临时 canvas 上设 lang，不碰页面。复现（无 lang 的页面里跑两份 text.js）：
```
旧副本 tests/fixtures/_test-typography/runtime/text.js：正常 ok / 缺字龘 ok（漏报）      / Inter 画中文 抛错
新版   skills/film-typography/assets/runtime/text.js：正常 ok / 缺字龘 抛错：缺字形 龘 / Inter 画中文 抛错
```
`legibility.mjs --chars` 用同样的检查：`--chars 龘` → `legibility: … 缺字形：龘` exit 2。
已拷进片子的旧 `text.js` 不会自动得到这个修复（运行时按片钉版本）；片子的 `<html>` 带任意 lang 也能绕过。

## 6. 按类声明字符（`loadFonts` 的 `{ text, sets, ranges }`）

起因：weiqi-intro 的 `白子：${n} 口气` 里 n 是运行时拼的，没列进 `loadFonts`。Noto 子集的数字和空格在
`U+20-7E` 那一片，这一片要等第一次画到才加载——那一帧用回退字体。只有 seamcheck 门 1a/2 红
（提示语是"读了时钟/有跨帧状态"，方向错），`font_source.mjs` 绿（字不缺，只是来得晚）。

- 展开函数 `expandChars`（node 里直接测）：`{text:'白子：口气', sets:['digits']}` → `白子：口气0123456789`；
  `['a', {ranges:['U+2460-2462, U+41']}]` → `a①②③A`；字符串原样返回（`expandChars('abc') === 'abc'`，旧写法逐字节不变）；
  类名拼错 `digit`、区间 `0030`、多余键 `txt` 三种都抛错并说明可用写法。
- 端到端（夹具在 scratchpad，`FILMS_DIR` 指过去，同一份 weiqi-intro 的 Noto 子集）：

  | 夹具 | `loadFonts` 的文字 | font_source.mjs | seamcheck |
  |---|---|---|---|
  | lazy-bad | `'白子：口气'` | ✗ exit 1：t=2s 起 `U+20-3D…` 分片 seek 期间才加载，首次由 `2␠` 触发 | 门 1a、2 ✗（t=2.267s 6388 像素） |
  | lazy-ok | `{ text: '白子：口气 ', sets: ['digits'] }` | ✓ exit 0 | 全部通过 |
  | weiqi-intro 副本，去掉 allText 末尾的 `' 0123456789'` | 原片写法 | ✗ exit 1：t=51s 起，首次由 `0␠` 触发 | — |
  | 同上，500 那条改成 `{ text: allText + ' ', sets: ['digits'] }`（新 text.js） | 按类声明 | ✓ exit 0 | — |

- 没测：`ranges` 声明整块 CJK（2 万字）时的加载/覆盖核对耗时；`fullwidth-digits` 等类没有片子用过。

## 7. look.mjs（look.json → assets/look.css）— 2026-10-23

在 scratch 目录建片，look.json 写 3 个颜色、3 个字体（一个单文件 Inter 可变 woff2、一个 fontsource 分片包、一个只给字族名），
`subsetText: ["script.json"]`（文案「你好，世界 Hello」）：
```
· latin: inter-latin-wght-normal.woff2: 47.1 KB -> inter-latin-wght-normal.subset.woff2 16.6 KB
· cjk: wght.css: 101 片中拷了 12 片，658.6 KB
· mono: 只生成变量，没给 file/css，不打包
-> assets/look.css（6 个变量，2 个字体已打包进 assets/fonts/look-fonts.css）
```
Chromium（Playwright headless shell）里 `<link>` 这个 look.css：`getComputedStyle` 读出 `--color-ink` = `rgb(20 20 20)`、
`--color-accent-1` = `oklch(0.6 0.2 30)`；两个打包字族状态都是 loaded，`document.fonts.check` 对「你好」为 true。
重跑一次 look-fonts.css 仍是 13 个 @font-face（1 + 12，`--fresh` 生效，不叠加）；去掉 look.json 里的字体再跑，look-fonts.css 被删、look.css 不再 @import。
名字带空格、值里混 `; } body{` → exit 1 并说明。
**没测**：真实片子的 scene.html 用 look.css 渲整片过 seamcheck（只测了 token 能读出、字体能加载）。

## 没测到 / 没解决

1. **H.264 之后的可读性**：4:2:0 色度下采样会让彩色细字（尤其红/蓝字在深底）明显变糊，没量化。
2. **真人阅读测试**：下限数字是像素指标，没有用户实验校准。
3. **opsz 自动**：`font-optical-sizing: auto` 时 canvas 会按字号自动设 opsz（80px 时等于 opsz 32），
   字号动画时 opsz 跟着变，字形会轻微跳。看到了现象（base 宽 = opsz 32 的宽），没系统测。
4. **竖排、注音、着重号**：只在 cjk.md 写了做法，没写运行时函数也没测。
5. **`wrapCJK` 与 Chrome DOM 的 `line-break: strict` 是否逐行一致**：没比对。
6. **笔画顺序手法**（hanzi-writer-data）：methods.md 给了思路，没有跑过的代码。
7. ~~中文 700 没有稳定下限~~ 已解决（§3b）：原因是扫描范围止于 72px。仍没解决的：
   - **相位敏感**：主判据只测一个相位。400 主判据 56px，8 相位全过要 70px（23.3 有效 px）；
     900 是 92 vs 116px。实际字幕落在任意相位，主判据偏乐观。为了和旧三个数可比，闸门仍用主判据。
   - **缩放倍数**：同一字重，1080→360 和 1920→360 下的有效 px 下限差 ±15%（§3b 末），只测了这两个倍数。
   - **一个数代表一档的误差**：700 取 29.3，对 600–650（24.7）偏严、对 900（30.7）偏松；
     常规档 18.7 对 500（24.0）偏松 5.3px。要更准得按字重查表，没有接进任何闸门。
   - 只测了 Noto Sans SC 一种中文字体。下限 ≈ 1.5 有效 px ÷ 最小笔画间隙(em) 这条关系
     在其它字体上成不成立，没测；换字体要用 `legibility.mjs` 复测，不要套这张表。
   - 白底黑字、彩色字、描边字、半透明底条上的字（ghost-jam 就是这种）没测。
8. `drawCaptionWords` 没接真 narration.json 跑过（只保证与 `captionAt` 返回结构一致：`words[{w,start,end}]`）。
9. 字幕边界表里"纯中文逐词宽度相加不漂"是从 §2 的 probe（汉字/全角标点 advance = 1em）推出来的，
   没有拿 ghost-jam 的真字幕逐行比对 `drawCaption` 和 `drawCaptionWords` 的总宽。
10. 360 有效宽对 16x9 片子是竖持手机看横片（上下黑边）的情形；横持约 2 倍宽，ghost-jam 58px 会到约 23 有效 px。
    片子该按哪种观看方式判，是 film-critique / 本片 style_guide 的事，这里没定。

---

## §MG 文字动画运行时（textfx.js，2026-10-21）

夹具 `tests/fixtures/_test-mg` 的 s1（逐字交错 ×2 种编排）、s2（乱码解码）、s3（打字机 + 标点停顿 + 光标）、s4（沿三次贝塞尔排字）、s5（切分揭示 + 按行升起）、
s6（里程表 + 老虎机）、s7（3D 翻转：透视条带 vs 仿射）、s8（按词波浪 / 脉冲，下划线画出切词边界）、s12（文字 Magic Move）。
seamcheck 全部门过（含门 4 全片 432 帧并行），见 film-motion VERIFIED §MG。

- **中文拆分**：`时间的纯函数，乱序也一样。` by char → 13 个单元，`，` `。` 分别挂在 `数` `样` 上；`把胆子放在一处，其余保持安静。` by word →
  `把 / 胆子 / 放在 / 一处， / 其余 / 保持 / 安静。`（Chromium 156 ICU，静帧 9.0 s 下划线核对）。
- **乱码确定性**：乱码字只依赖 (seed, 单元, j, floor(t·rate))；门 2 乱序 / 门 4 并行 0 差异。乱码池 54 个字全部进了 `loadFonts`，font 加载无报错。
- **3D 翻转条带**：120 px 字（`L.size(0.12)` @1080）16 条时竖笔画台阶肉眼可见（7.4 s 静帧裁切），改 40 条后看不出；s7 整镜绘制 3.1 ms（6 字 × 40 条 + 6 字仿射）。
- **每帧绘制耗时**（整个镜头，页面内 seek + 读回 1 像素，中位数；测量时机同 film-motion §MG）：s1 0.4 ms、s2 0.2、s3 0.2、s4 0.7、s5 0.3、s6 0.3、s7 3.1、s8 0.3、s12 0.2。
  对照：只画背景 + 标签 ≈ 0.2 ms。截图约 32 ms/帧，文字手法都不是瓶颈。

**没测到**：`IN.blur`（ctx.filter，已知慢）；竖排；阿拉伯文/天城文；ICU 切词跨 Chromium 版本是否稳定。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

skill 里只留结论、判据、命令和代价数字；下面是原来写在 SKILL.md / references 里的来历与旁证，数字仍以本文件各节为准。

- **运行时拼出来的字漏进 loadFonts**（原 SKILL.md 硬约束 2）：本仓库样例 weiqi-intro 撞过——`白子：${n} 口气` 里的数字落在没加载的
  unicode-range 分片上，第一次画到它的那一帧用回退字体、同时触发加载，是确定性失败；`sets` / `ranges` 按类声明就是为它加的（§6）。
- **seek 里按 t 重测**（原硬约束 3）：自测片 `tests/fixtures/_test-typography` 字重随 t 变时每帧按当前字重重新 `splitText`，过了 seamcheck（§1）。
- **可读性测法**（原 SKILL.md「可读性下限」开头一段）：1080 宽白字黑底 → 高质量缩放到 360 宽 → 沿笔画垂直方向取墨量剖面、50% 二值化数段数；
  全文见 §3。中文 700 早先写成"到 72 仍不稳定"，原因只是扫描范围止于 72px，扫到 200px 后 86px 还是 5/6、88px 起 8 个相位全过（§3b）。
- **中文加粗为什么比拉丁伤得多**（原 measurements.md §2）：「言」横画间隙 400→700 从 0.082em 缩到 0.057em（−30%），mmm 竖干内白 0.123→0.102em（−17%）
  且本来宽 1.5 倍；拉丁 400 峰值墨量 0.63 被抹灰、加粗补满，两头相抵只高 15%，中文 400 墨量已 0.94，加粗只剩吃间隙，高 57%（§3b 几何表）。
- **非标准行为的旁注**（原 chromium.md A1/A2）：font-variation-settings 要重设 `ctx.font` 才生效，推测机制是 ctx.font 赋值时才从元素解析字体样式；
  `font-synthesis: none` 写在 `@font-face` 描述符里无效是旧实测，本轮未复测。
- **描边生长**（原 methods.md §11）：`SVGPathElement.getTotalLength()` 未挂载也能测，出自仓库根旧版 capabilities.mjs，本 skill 未复测。
- **文字 Magic Move 出处**（原 textfx.md §10）：借 Keynote "按字符 Magic Move" 与 Manim `TransformMatchingShapes`；区别是按字符串相等配对，不按字形轮廓。
- **textfx 夹具旁证**（原 textfx.md §1/§4/§9）：ICU 切词由 s8 下划线逐个画出边界；乱码确定性由夹具 seamcheck 门 2/4 全过证明，夹具把 POOL 拼进了 `loadFonts`；
  条带 16 条 vs 40 条的结论出自 7.4 s 静帧裁切对照（§MG）。
- **删掉的重复**：SKILL.md「字体文件大小对启动的影响」与 measurements.md §4 重复，只留后者；methods.md 打字机/乱码/逐词高亮的手写代码与 textfx 运行时、
  SKILL.md「字幕绘制」重复，改为指向运行时；SKILL.md 的 textfx 代价表与 textfx.md §3 重复，只留后者；chromium.md「D. 复测」并进开头。
