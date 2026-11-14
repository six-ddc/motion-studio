# VERIFIED — film-narration

测试日期 2026-10-21（第 26–27 节同日补测），macOS Darwin 25，`.venv` Python 3.11，Chromium（Playwright，仓库根 node_modules）。
测试片 `tests/fixtures/_test-narration/`（保留，不删）。下面每条都带命令和真实输出。

## 1. tts.py（volcano-stream）端到端 —— 已跑

`script.json`：4 句，发音词典 `帧/(zhen1)`（拼音）+ `ffmpeg/F F mpeg`（文本转写），音色 `zh_male_m191_uranus_bigtts`。
从 `tests/fixtures/_test-narration/docs/`（非片子根）调用，验证任意 cwd：

```
$ cd tests/fixtures/_test-narration/docs && ../../../.venv/bin/python ../../../skills/film-narration/scripts/tts.py --film _test-narration
片子: _test-narration   引擎: volcano-stream   音色: zh_male_m191_uranus_bigtts
发音词典: ['帧/(zhen1)', 'ffmpeg/F F mpeg']
[1/4] s1: 每一帧画面，都是时间的纯函数。      3.448s, 13 个字级时间戳
[2/4] s2: 渲染器调用 seek，把第几秒交给页面。  3.056s, 14 个字级时间戳
[3/4] s3: 截下的帧交给 ffmpeg，编码成视频。    4.415s, 14 个字级时间戳
[4/4] s4: 声音先行，画面去读它的时间戳。      3.422s, 13 个字级时间戳
✓ out/vo.wav   总长 15.541s（拼接后实测 15.541s）
✓ narration.json   54 个字级时间戳   script_hash bc4e05fe4fb1
  计费文本字数合计：70
⚠ 1 个低置信度时间戳（conf < 0.4），要人听一遍这几处：
    s3:mpeg，@2.79s(conf 0.271)
```

**发现**：文本转写词典条目改写了时间戳 token，s3 回来的是 `F[8.529-8.839] F[8.839-9.109] mpeg，[10.099-10.129|0.271]`，
`vo.at('ffmpeg')` 会查不到。于是给 `tts.py` 加了 `restore_dict_words()`，并用 `--only s3` 只重合成这一句：

```
$ tts.py --film . --only s3
✓ out/vo.wav   总长 14.731s（拼接后实测 14.731s）
✓ narration.json   52 个字级时间戳   script_hash bc4e05fe4fb1
  计费文本字数合计：20
⚠ s3:ffmpeg，@1.26s(conf 0.242)
  s1  0.000 ->  3.448   s2  3.848 ->  6.904   s3  7.304 -> 10.909 (3.605s)   s4 11.309 -> 14.731
```

**发现**：同一句重合成，时长 4.415s → 3.605s。TTS 非确定 → 写进 SKILL.md。`--only` 正确地把 s4 从 12.119 平移到 11.309。

当前 `narration.json` 的字级时间戳（节选，绝对秒）：

| 词 | start | end | conf |
|---|---|---|---|
| 帧（s1） | 0.395 | 0.635 | 0.829 |
| 纯 / 函 / 数。 | 2.365 / 2.695 / 2.935 | 2.695 / 2.935 / 3.215 | 0.918 / 0.87 / 0.97 |
| seek， | 4.663 | 5.053 | 0.915 |
| ffmpeg，（alias `F F mpeg，`） | 8.569 | 9.229 | 0.242 |
| 戳。 | 14.214 | 14.394 | — |

`--dry-run`（不发请求）打印的 stream 请求体里 `additions` 为字符串
`"{\"pronunciation_dict\": {\"tone\": [\"帧/(zhen1)\", \"ffmpeg/F F mpeg\"]}}"`，`X-Api-Key` 显示为 `<已设置，打码>`。

## 2. volcano-audio —— 已真跑（集成方跑的），外加 dry-run

我这边先只跑了 `--dry-run` 确认请求构造（按音频秒计费）：

```
$ tts.py --film _test-narration --engine volcano-audio --dry-run
POST https://openspeech.bytedance.com/api/v3/tts/create
body { "model": "seed-audio-1.0", "text_prompt": "每一帧画面，都是时间的纯函数。",
       "audio_config": {…, "enable_subtitle": true}, "references": [{"speaker": "zh_male_m191_uranus_bigtts"}] }
```

dry-run 暴露了一处：这个接口不支持 `pronunciationDict`，旧代码会静默丢掉，现在改成警告。

随后**集成方真调了一次**（`tests/fixtures/_test-audio-api/`，计费 4.4 音频秒）：

```
$ tts.py --film _test-audio-api
片子: _test-audio-api   引擎: volcano-audio   音色: zh_male_m191_uranus_bigtts
[1/1] a1: 两端交换参数，各自算出同一个密钥。
      4.441s, 17 个字级时间戳
✓ out/vo.wav   总长 4.441s（拼接后实测 4.441s）
  计费音频秒数合计：4.4s
两@0.48 端@0.76 交@1.12 换@1.44 参@1.76 数@2.04 ，@2.16 各@2.52 … 密@4.04 钥@4.28 。@4.36
```

毫秒→秒换算正确：时刻单调递增，末词 end 4.36 ≤ 时长 4.441。
**和 stream 的差异：标点是独立的零宽 token**（`，` start == end），stream 则把标点粘在前一字上并带时长。
我拿这份 narration.json 复测了下游：`locate('交换参数')` → `{start 1.12, end 2.16}`，`at('密钥')` → 4.04；
`captionAt` 在零宽标点处 activeIndex = -1、progress = 0，不会除零；`subs.py` 出 2 条 SRT，断行正确。
`subs.py` 的 ASS 改成把零宽标点并到前一个 `\kf` 段（原来会给每个标点硬塞 1cs）。
这一条是在手造的零宽 token narration.json 上验证的（复测时 `_test-audio-api/narration.json` 已被删）：
`{\kf12}数，{\k36}{\kf24}各{\kf28}自。`。差异已写进 schemas.md 和 volcano-api.md。

## 3. voices.py —— 已跑

```
$ cd skills && ../.venv/bin/python film-narration/scripts/voices.py --film _test-narration --preset documentary
```

样本取 script.json 第一句（14 字），`speechRate 0`，5 个候选全部 ✓（即本账号都已授权）：

| # | 音色 | 基频中位 Hz | 基频跨度 半音 | 语速 字/秒 | 响度 dBFS | 停顿占比 | 时长 s |
|---|---|---|---|---|---|---|---|
| 1 | 译制片男 2.0 | 126.4 | 17.0 | 3.97 | -22.3 | 0.16 | 3.448 |
| 2 | 磁性解说男声 2.0 | 102.1 | 19.6 | 4.06 | -23.6 | 0.28 | 3.605 |
| 3 | 解说小明 2.0 | 113.9 | 15.2 | 4.34 | -22.1 | 0.08 | 3.03 |
| 4 | 云舟 2.0 · 通用 | 146.9 | 13.0 | 3.96 | -24.5 | 0.05 | 3.448 |
| 5 | 霸气青叔 2.0 · 有声阅读 | 111.3 | 17.2 | 4.46 | -21.1 | 0.23 | 3.056 |

产出 `out/voices/_compare.wav` + `report.json`。按"技术讲解要稳、要连贯"选云舟（跨度最小、停顿最少），
`docs/review_log.md` 已记 **"音色未经人耳确认"**——走的就是 SKILL.md 写的无人退化路径。

## 4. subs.py —— 已跑

```
$ subs.py --film . --max-chars 14                          ✓ out/subs.srt  8 条字幕
$ subs.py --film . --format ass --font "PingFang SC" --max-chars 14   ✓ out/subs.ass  8 条字幕
$ subs.py --film . --format ass                            ✗ ASS 需要 --font（按本片 style_guide 定…）  exit=1
```

SRT 前 3 条：

```
1
00:00:00,045 --> 00:00:01,115
每一帧画面，

2
00:00:01,325 --> 00:00:03,215
都是时间的纯函数。

3
00:00:03,848 --> 00:00:05,053
渲染器调用 seek，
```

ASS（带词间空拍 `\k9`）：

```
Dialogue: 0,0:00:07.30,0:00:09.23,Main,,0,0,0,,{\kf21}截{\kf18}下{\kf9}的{\kf27}帧{\kf20}交{\kf23}给{\k9}{\kf66} ffmpeg，
```

**发现并修掉的旧缺陷**（第一次跑旧算法 `--max-chars 10/18` 时实测）：
贪心截断留下孤字 `面。`（6.323→6.583，0.26s 一闪）和 `频。`；拉丁词丢空格 `调用seek`；
`\kf` 不含词间停顿，填色会逐渐超前于人声。现在：标点切意群 + 超长均分；补空格；`\k` 补空拍。

## 5. align.py --verify —— 已跑（修过一次闸门失效的 bug）

**Bug（集成方发现）**：旧版把脚本正文 `expected[:200]` 当 Whisper 的 `initial_prompt`。
集成方实测三句中文片：喂全文后只转写出最后一句，吻合度 51%；不喂则三句都在。
更根本的是**校验器被告知了答案**，会系统性低报错误。本片之前报的「100%」就是这么来的——去掉提示后真实转写是：

```
每一帧画面都是时间的纯函数。渲染器调用Seq, 把第几秒交给页面。截下的帧交给FFAmpick, 编码成视频。…
```

即 `seek`、`ffmpeg` 两个英文术语 Whisper 根本没"听出"，之前的提示把这个信号盖掉了。
不带任何提示时还会输出繁体（`帧→幀`）。

**修法**：`--verify` 只给一句不含答案的文体提示「以下是普通话的句子，使用简体中文。」；
术语提示只能走 `--hint-file`（领域词表，脚本里出现的词自动剔除，输出标「结果偏乐观」）；
`--from` 反推走 `--hint`，对齐不是校验，可以给原稿。改为按行报、按字算，分四类：
硬错误（计入阈值）/ 疑似同音（需要 pypinyin 确认，要人听）/ 外文词拼写差异（要人听）/ 漂移。
**本环境没装 pypinyin**，所以等长短替换算不出同音，一律按硬错误计并标「同音未排除」（宁可误报）。

```
$ align.py --film _test-narration --verify out/final-9x16.mp4          # 成片：音效 + 配乐 + 闪避
| s2 | 17 | 0 | - | - | ek→q |
| s3 | 17 | 0 | - | - | ∅→a eg→ick |
按字准确率（不计疑似同音）: 100.0%   原始吻合度 95.0%   要人听 2 处
时间漂移: 中位 -0.013s   |漂移| p90 0.149s   匹配字数 57
✓ 成片音轨和脚本一致，时间轴无漂移（2 处要人听，见上表）              exit=0

# 反例 A：脚本改三处（每一帧→每一真、渲染→渲杂、编码成视频→编码成为视频），音频不变
| s1 | 13 | 1 | 真→帧(同音未排除) | …
| s2 | 17 | 1 | 杂→染(同音未排除) | …
| s3 | 18 | 1 | 漏「为」 | …
按字准确率: 95.1% (阈值 97%)                                          exit=1

# 反例 B：vo.wav 整体延迟 400ms（ffmpeg adelay=400）
时间漂移: 中位 +0.385s   |漂移| p90 0.431s
✗ 音轨和 narration.json 整体错位 …                                     exit=2
```

反例 B 是在修 bug 之前跑的；漂移检查的代码这次没改。

### 5b. 自动挑文件挑中派生品（集成方发现，已修）

旧 `pick_source` 取「最新的 final*.mp4」，会挑中 film-critique 的 `final-9x16-loop.mp4`（片子拼两遍），
报 s3 多 38 字、准确率 0%。现在只正向匹配，并在转写前比时长。复现：用 ffmpeg 把成片拼两遍，
造一个最新的 `out/final-9x16-loop.mp4`（29.610s）：

```
$ align.py --film . --verify
（自动挑选忽略了派生产物：final-9x16-loop.mp4）
源: out/final-9x16.mp4    按字准确率 100.0%   ✓                            exit=0
$ align.py --film . --verify out/final-9x16-loop.mp4
✗ 选中的 out/final-9x16-loop.mp4 时长 29.610s，narration.json 是 14.731s，差了 2.01 倍——这多半不是成片…   exit=3
```

`mux.sh` 的同类通配（`ls -t out/silent*.mp4`）也改了：造一个更新的 `silent-9x16-loop.mp4` 诱饵，
合流仍取 `silent-9x16.mp4`（视频 14.8s，实测 -14.1 LUFS）。诱饵文件测完已删。

## 6. sfx.mjs —— 已跑

`cues.json` 用了 `at` 关键词绑定（含 `nth: 2`）和 `t`。从 `/tmp` 用 `FILMS_DIR` 调用：

```
$ FILMS_DIR=…/films node skills/film-narration/scripts/sfx.mjs --film _test-narration
✓ out/sfx.wav  5 个事件  14.91s
  2.325s  thump  ← 「纯函数」      (2.365 - 0.04)
  4.663s  tick  ← 「seek」
  7.779s  click  ← 「帧」          (第 2 次出现)
  13.714s  chime  ← 「时间戳」
```

两次运行 `md5 out/sfx.wav` 都是 `55d5011dd5c5f24c868b37cdf7f0a5c9`。
`file` 素材路径和 `beat` 绑定的代码路径**没有用真实素材/真实音乐跑过**。

## 7. mux.sh —— 已跑（用合成测试素材）

无声视频是 ffmpeg 生成的 14.8s 纯色片（`out/silent-9x16.mp4`），配乐是 220Hz 正弦（`assets/test-tone.wav`）：

```
$ FILMS_DIR=…/films bash skills/film-narration/scripts/mux.sh --film _test-narration --music assets/test-tone.wav
✓ out/final-9x16.mp4   视频 14.800000s   旁白 out/vo.wav + out/sfx.wav + assets/test-tone.wav(-18dB, duck=1)
  混音前响度 -20.63 LUFS -> 目标 -14
  实测 I:         -14.1 LUFS
  实测 LRA:         4.4 LU
```

闪避的听感**没人听过**；当时只验证了滤镜图能跑、响度达标、校验通过。闪避深度后来机械测了，
响度数字也独立复核过，并因此修了 `mux.sh` 两处——见第 13 节。

## 8. beats.py —— 只跑了失败路径

```
$ beats.py --film _test-narration --track assets/test-tone.wav
✗ 只测到 0 拍，这段音频可能没有稳定节拍（氛围乐/人声？），别硬套栅格    exit=1
```

**没有用真实音乐跑过成功路径**（仓库里没找到授权音乐）。librosa 调用和旧版 beats.py 相同。

## 9. 运行时 narration.js —— 已跑

Node 里对真实 narration.json：

```
纯函数 2.365 3.215 | seek 4.663 5.053 | ffmpeg 8.569 9.229 | 时间戳 13.714 14.394 | 帧 0.395 | 帧#2 7.779
at('安史')     → THROW 旁白里找不到「安史」第 1 次出现…   （旧 includes 匹配会误中「长安」类的单字）
at('画面去看') → THROW
captionAt(3.5) → null（句间停顿）
```

`findKeyword(data, '纯函数')` → `{start: 2.365, end: 3.215, first: 10, last: 12}`（导出给 film-critique 等复用）。

浏览器：`tests/fixtures/_test-narration/scene.html`（四个弹簧绑在 `vo.at()` 上 + `drawCaption`）。
**film-motion 正式 seamcheck**（runtime 已换成 `film-motion/assets/runtime/` 的 motion.js / layout.js）：

```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-narration
门 1 / 门 2 / 门 1b（全新页面重载）全部 ✓ 逐像素一致；门 3 未声明 loop 只报告；探针：seek 期间无禁用 API
全部通过                                                                exit=0
```

早先的自写简化版 `seamcheck-lite.mjs`：

```
{"duration":14.731,"sameT":true,"shuffled":true,"distinctFrames":7,"errors":[]}
```

即同 t 可重复 ✓、乱序求值一致 ✓（7 个时刻）。第 3 条循环接缝不适用（测试片不循环）。
静帧 `out/_still-8.7s.png` 人眼看过：
t=8.7 时第三个点（绑 `ffmpeg`@8.569）刚弹出，字幕「截下的帧交给 ffmpeg，」全部填色。

## 10. script.template.json —— 已跑

`assets/script.template.json` 是合法 JSON（`json.load` 通过）。原样拷成 `scratchpad/films/tpl/script.json` 后：

```
$ tts.py --film tpl
✗ script.json 里这些句子 text 为空：['s1']（模板占位还没填？）                exit=1
# 填上 text 后
✗ speaker 还是占位符「<跑 film-narration 的 voices.py …」。先跑 voices.py …   exit=1
```

## 11. 发音词典能不能自动冒烟 —— 前三种方法都不能（第四种能，见第 12 节）

集成方提议：同一句带/不带词典各合成一次，比逐样本差。他实测「算出同一个密钥。」带 `密钥/(mi4)(yue4)`：
最大差 0.897、均方差 0.131，据此认为"词典确实生效"。**我加了对照组**：同一请求不带词典连发两次。

```
（逐样本，16bit 48k，补零对齐）
plain vs plain   最大差 0.779   均方差 0.1286   两次长度都是 77741 样本
plain vs dict    最大差 0.914   均方差 0.1363

（log-mel 64 维 + DTW，每步平均距离）
p1–p2 51.91    d1–d2 59.97      ← 同条件重复
p1–d1 62.61    p2–d2 53.35      ← 带/不带词典
p1–w1 38.78    d1–w1 60.67      w = 故意写错的 (mi4)(yao4)
「密」的起点：p1 0.945  p2 1.035  d1 1.255  d2 1.045  w1 0.935
```

同条件重复的差异和带/不带词典的差异同量级，故意写错的词典反而离不带词典的最近——**噪声主导，两种测法都判不了词典是否生效**。
所以没做 `--dict-smoke`；做了的是 `tts.py` 合成前的**静态检查**（`lint_dict`）：

```
lint_dict(…'密钥/(mi4)(yue4)','银行/(yin2)xing2','晕开/(yun4)','abc'…)
→ 「密钥」不在任何一句里，是死条目
→ 「银行/(yin2)xing2」拼音段格式不对
→ 「晕开/(yun4)」音节数 1 和字数 2 不一致（通常一字一音节）
→ 「abc」缺少 '/'
```

**token 时长统计也不行**（集成方实测，`films/_dict-stat/`，已清理）：带/不带 `密钥/(mi4)(yue4)` 各 12 次，共 24 次合成：

```
「密」 带词典 中位 0.220s (0.20–0.26)   不带 中位 0.235s (0.21–0.27)   Mann-Whitney U=46.5  p=0.1430  中位差 +0.015s
「钥」 带词典 中位 0.160s (0.08–0.22)   不带 中位 0.165s (0.13–0.25)   Mann-Whitney U=52.5  p=0.2688  中位差 +0.005s
```

**差点成为假阳性**：先跑 N=6 vs 6 时，「钥」中位差 60ms、p=0.064，方向一致（带词典的更短）。
停在那里就会报出"token 时长能判别词典生效"。p=0.064 是检验力不足、不是阴性，该做的是加样本；
补到 N=12，效应消失，说明 N=6 的趋势是噪声。

三种方法三种失败（波形差分 / MFCC-DTW 判方向 / token 时长统计）。汇总（原在 SKILL.md 第三节，已下沉到这里）：

| 方法 | 想判什么 | 为什么不成立 |
|---|---|---|
| 带/不带词典的波形差分（逐样本、log-mel DTW） | 是否生效 | 同一请求连发两次的差异和带/不带词典同量级；故意写错的词典反而离不带词典最近 |
| MFCC + DTW 对参照读音（「密月」「密药」） | 念的方向 | 方法学对照失败：强制 `银行/(yin2)(xing2)` 的版本测得更接近 háng，且差距小于参照互距 |
| 接口返回的 token 时长做统计（Mann-Whitney） | 是否生效 | 12 vs 12 次：「密」p=0.143、「钥」p=0.269，中位差 ≤15ms。N=6 时「钥」曾显示 60ms、p=0.064，补样本后消失——**p 在边缘时该补样本，不是二选一地解读** |

前三种都是拿整词的谱距离判一个音节的元音，信号被淹了；第四种（第 12 节）只取目标字那一段、只看 F1/F2，才分得开。
当时的结论「`lint_dict` 的静态格式检查是唯一站得住的自动项」**被第 12 节推翻**：问题不在"读音不可测"，
在于这三种都拿整词的谱距离判一个音节的元音。

还没验证的：接口对格式错误的条目是报错还是静默忽略。

## 12. 第四种方法：目标字段的共振峰（F1/F2）—— 闸门通过，词典的拼音写法实测无效

实验脚本和全部合成结果在 `tests/fixtures/_test-narration/formant/`（`fm/<条件>/*.mp3|json`，`gate.json` `cond.json` `alt.json`）。
合成一律走 `tts.py` 的 `synth_volcano_stream`，音色和参数取 `films/demo-tls/script.json`
（`zh_male_m191_uranus_bigtts`、seed-tts-2.0、mp3 44100 Hz、speechRate -6），只换文本 / 词典 / SSML。
语境句统一是 demo 的第二句「两端交换参数，各自算出同一个□□。」，目标字在句末。

**测量管线**（`formant.py`，参数在看参照组结果之前写死）：ffmpeg 解码为单声道 44100 Hz → soxr 重采样到 10000 Hz →
预加重 0.97 → 25 ms Hamming 窗、5 ms 步长 → LPC 12 阶（2 + fs/1000）→ 取虚部 > 0 的极点，保留 90 < f < 4800 Hz 且
带宽 < 400 Hz 的，最低为 F1、次低为 F2。分析段 = 接口给的目标字 token `[start, end + 0.05 s]`；
有声帧 = pyin(60–300 Hz) 判浊 且 帧电平 > 段内最大 − 25 dB。
**主指标 F1_p80**（有声帧 F1 的第 80 百分位，抓韵腹：yào 的 [ɑ] F1 高、yuè 的 [ɛ] F1 低），副指标 F2_p10。

**改过一处，如实记**：第一版 pyin 只喂分析段（约 0.3 s），`ref_yao/秘药_03` 的有声帧掉到 < 3 帧、算不出数。
改成 pyin 跑整句。这是在**看过参照组数值之后**改的，但只修了有声判定，指标、阈值、窗长都没动；改前改后 23 个能算的样本两组都不重叠。

### 12a. 检验力闸门（先做，没过就停）

两组参照各 12 次：yuè 组「密月 / 蜜月 / 密阅」各 4 次，yào 组「密药 / 秘药 / 密耀」各 4 次。
预先定的通过判据：F1_p80 的 Mann-Whitney 双侧 p < 0.001 且留一法阈值分类 ≥ 23/24。

```
$ .venv/bin/python tests/fixtures/_test-narration/formant/gate.py
F1_p80  yue: 中位    375 Hz  范围 305–409   yao: 中位    650 Hz  范围 500–722
        组间中位差 +275 Hz   d=+5.22   MW U=0.0 p=3.66e-05   留一法 23/24
F1_med  yue: 中位    266 Hz  范围 253–305   yao: 中位    464 Hz  范围 382–679
        组间中位差 +198 Hz   d=+3.47   MW U=0.0 p=3.66e-05   留一法 24/24
F2_p10  yue: 中位   1697 Hz  范围 1615–1772   yao: 中位   1332 Hz  范围 1106–1532
        组间中位差 -364 Hz   d=-3.26   MW U=144.0 p=3.66e-05   留一法 23/24
F2_med  yue: 中位   1853 Hz  范围 1773–1953   yao: 中位   1763 Hz  范围 1371–1992
        组间中位差 -90 Hz   d=-1.21   MW U=119.0 p=7.26e-03   留一法 16/24
```

**闸门通过。** F1_p80 两组完全不重叠（yuè 最大 409 Hz < yào 最小 500 Hz，U=0；12 vs 12 时 p 的下限就是 3.66e-05）。
留一法错的那一个是 yào 组最低的 500 Hz（密耀_03），落在阈值 512 Hz 下方 12 Hz。
F2_med 只有 16/24，不能用——所以判读只用 F1_p80（附 F1_med、F2_p10 作旁证）。判读阈值 = 两组中位数的中点 512 Hz。

### 12b. demo-tls 实际旁白里的「钥」

```
$ .venv/bin/python tests/fixtures/_test-narration/formant/target.py <demo-tls 副本>/narration.json <副本>/out/vo/s2.wav line
「钥」token [5.684-5.844]s  有声帧 12  F1_p80 547 Hz  F1_med 395 Hz  F2_p10 1490 Hz  F2_med 1826 Hz
  参照 yuè F1_p80 305–409 Hz / yào 500–722 Hz，阈值 512 Hz → 判 yào
  轨迹 (t, F1, F2): (3.277, 318, 2094) … (3.307, 409, 1743) … (3.332, 661, 1410)
```

同一段在整条 `vo.wav`（F1_p80 546 Hz）和成片 `final-9x16.mp4` 音轨（547 Hz）上量出一样的数。
**判定：念的是 mì yào，词典 `密钥/(mi4)(yue4)` 没让它念成 yuè。** 四个量都指向 yào：F1_p80 547 Hz 在 yào 组范围内、
比 yuè 组最大值高 138 Hz；F1_med 395 Hz 高于 yuè 组最大 305 Hz；F2_p10 1490 Hz 低于 yuè 组最小 1615 Hz；
有声帧 12 帧，yuè 组是 20–37 帧、yào 组 13–24 帧。轨迹 F1 318 → 661 Hz、F2 2094 → 1410 Hz 是 [j] 滑向 [ɑ] 的形状。
**置信度高，但只有一次观测**：547 Hz 靠近 yào 组的低端，离阈值 35 Hz。下面 12c 的 12 次重复里同一请求 12/12 判 yào，和它一致。
（demo 这条音频确实带着词典合成：`narration.json` 的 `script_hash` 353b7fc95404 = 带词典的 `script.json` 的哈希，不带词典是 aa380bc6668c。）

### 12c. 词典到底生不生效（每种条件多次重复取分布）

```
$ .venv/bin/python tests/fixtures/_test-narration/formant/cond.py
c_nodict     F1_p80 中位   687 Hz (552–723)  判 yào 12/12     「密钥」不带词典
c_dict_yue   F1_p80 中位   695 Hz (600–718)  判 yào 12/12     「密钥」+ 密钥/(mi4)(yue4)   ← demo 的配置
c_dict_yao   F1_p80 中位   706 Hz (511–740)  判 yào 11/12     「密钥」+ 密钥/(mi4)(yao4)
c_nodict vs c_dict_yue: F1_p80 中位差 +8 Hz  p=0.885    F2_p10 中位差 +19 Hz  p=0.795
```

**只比带/不带词典不够**：引擎默认就念 yào 时，一条"让它念 yào"的词典测出来也是无差。所以加了两个方向的**正对照**——
拿拼音词典去强改本来不是多音字的字，如果词典生效，读音必须翻过去：

```
p_dict_yao2yue  「密药」+ 密药/(mi4)(yue4)   F1_p80 中位 712 Hz (636–723)  判 yào 8/8    ← 没翻
p_dict_yue2yao  「密月」+ 密月/(mi4)(yao4)   F1_p80 中位 388 Hz (345–488)  判 yào 0/8    ← 没翻
w_alias         「密钥」+ 密钥/密月（文本转写） F1_p80 中位 385 Hz (331–452)  判 yào 0/12   ← 翻了，与 ref_yue 比 p=0.403
s_ssml_yue      SSML <phoneme alphabet="py" ph="mi4 yue4">密钥</phoneme>   F1_p80 中位 700 Hz  判 yào 12/12   ← 没翻
s_ssml_yao2yue  SSML 同上包「密药」                                      F1_p80 中位 680 Hz  判 yào 8/8     ← 没翻
```

结论（这个量的检验力已由 12a 证明，d=5.2 的差别 12 vs 12 必然测得出）：

- **拼音写法 `原词/(pin1)(yin1)` 在 seed-tts-2.0 + 这个音色上不改变韵母。** 三条本该改变读音的条目共 28 次合成，0 次改变。
  接口不报错。格式和官方文档的例子 `北京/(bei3)(jing1)` 一致，不是写错了格式。
- **文本转写写法生效**：`密钥/密月` 12/12 读 yuè，分布和「密月」参照组无差。经 `tts.py --only s2` 端到端跑过（在 demo 的副本上）：
  token 回来是 `密` `月。`，被还原成 `密钥。`（alias `密 月。`），`findKeyword('密钥')` → `{start 5.144, end 5.514}`，
  `findKeyword('钥')` 抛错——这是这种写法的代价，demo 的 `scene.html` 只查 `vo.at('密钥')`，不受影响。
- **SSML `<phoneme>` 不改变读音**。SSML 本身被接受（标签没被念出来），但按 SSML 字符串计费：同一句 79 字 vs 纯文本 17 字。
  官方文档没有列 phoneme 标签。
- 据此 `tts.py` 的 `lint_dict` 对拼音条目加了警告，SKILL.md 第三节改写。

**作废的一组**：本来想用「他走进了一家银行。」带/不带 `银行/(yin2)(xing2)` 各 8 次做第二个正对照。
F1_p80 量出 732–1371 Hz——不可能是 F1，是 -ng 鼻韵尾把 F1 极点的带宽撑过 400 Hz 被滤掉、次一个极点顶了上来。
这一对读音**没有过闸门**，所以这组数据不解读（数据留在 `fm/b_*`）。

## 13. ducking 与响度 —— 机械测了，修了 mux.sh 两处

### 13a. demo-tls：ducking 不适用

demo-tls 的 `out/` 里没有 `sfx.wav`，片子目录没有 `cues.json`，`mux.sh` 没给 `--music`。
用成片音轨逐 50 ms 帧拟合 `final ≈ g(t)·vo.wav`：

```
残差/信号 中位 -40.1 dB, p90 -29.0 dB（174 帧）；停顿里的低电平帧（< -38 dBFS，28 帧）中位 -39.4 dB
无旁白段电平：1.815–2.474s -48.2 dBFS，3.984–4.124s -41.3，5.924–6.436s -41.5（vo.wav 同段 -52.4 / -44.4 / -44.6）
旁白结束后（9.52s → 10.433s）最大绝对样本 0.0
```

成片音轨就是旁白乘一条时变增益，残差是 AAC 编码噪声的量级；停顿里的 -41 到 -48 dBFS 是旁白自带的气口和底噪，跟着 vo.wav 走。
**没有配乐，也没有音效。闪避只作用在配乐上，所以对这支片是"不适用"，不是"未确认"。**

### 13b. 响度独立复核（ffmpeg ebur128，peak=true）

```
$ ffmpeg -i final-9x16.mp4 -af ebur128=peak=true:framelog=quiet -f null -
I: -13.9 LUFS   LRA: 2.1 LU   True peak: -1.5 dBTP
（vo.wav 本身：I -20.4 LUFS  LRA 2.4 LU  peak -3.8 dBTP）
```

`-14 LUFS` 目标偏差 0.1 LU；true peak -1.5 dBTP，没有超过常见的 -1 dBTP 交付上限。
**但 `mux.sh` 原注释"第二遍线性归一，不会抽"对 demo-tls 不成立。** 重放它的两遍 loudnorm：

```
第一遍 input_i -20.38  input_tp -6.79  →  第二遍(linear=true) "normalization_type" : "dynamic"
```

要 +6.4 dB 才到 -14 LUFS，true peak 只有 -6.79 → -1.5 = 5.3 dB 余量，ffmpeg 自动退回动态模式（LRA 2.4 → 2.1 LU）。
**修**：`mux.sh` 第二遍把 `normalization_type` 读回来打印，是 `dynamic` 时 stderr 警告并给出两条出路（降目标 / 先限幅）；
末尾的实测改用 `ebur128=peak=true`，打 I / LRA / true peak 三个数。

### 13c. 闪避本身：造最小测试片跑通

`tests/fixtures/_test-narration/formant/duck-test/`（输入是 demo-tls 的副本，产出不入库，按下面命令重跑）：demo-tls 的 `vo.wav` + `silent-9x16.mp4`（10.433 s），配乐用 55 Hz 正弦（-18 dB）当探针——
闪避增益只由旁白（侧链）决定，跟配乐内容无关；55 Hz 处旁白自身能量低（不加配乐时有旁白帧 -57.5 dBFS、停顿 -240 dBFS），
所以用 0.2 s 窗的 FFT 读 55 Hz 那一格就能单独量配乐电平。三种合流：无配乐 / `--duck 0` / 默认闪避。

```
$ D=tests/fixtures/_test-narration/formant/duck-test
$ bash skills/film-narration/scripts/mux.sh --film $D --out out/final-v2none.mp4
$ bash skills/film-narration/scripts/mux.sh --film $D --music assets/tone55.wav --duck 0 --out out/final-v2duck0.mp4
$ bash skills/film-narration/scripts/mux.sh --film $D --music assets/tone55.wav --out out/final-v2duck1.mp4
$ cd $D && ../../../../.venv/bin/python ../duckmeas.py v2none v2duck0 v2duck1
v2duck0  55Hz  有旁白 中位 -29.9 dBFS (n=68)  片内停顿 -28.9 (n=7)  片尾 -29.8 (n=13)
v2duck1  55Hz  有旁白 中位 -39.4 dBFS (n=68)  片内停顿 -28.8 (n=7)  片尾 -29.8 (n=13)
  v2duck1−v2duck0 有旁白:   p10 -13.3  中位 -9.8  p90 -7.5 dB
  v2duck1−v2duck0 片内停顿: p10   0.0  中位  0.0  p90  0.1 dB
```

**闪避深度：有旁白时配乐压低 9.8 dB（中位），停顿里完全恢复。** s1 末字结束后约 0.21 s 回到 -1 dB 以内（含 0.2 s 分析窗的模糊；release 设的是 400 ms）。
两次合流都退回了 dynamic loudnorm，但两边的旁白一样，差值只剩闪避本身。

**这次跑出来一个真 bug，已修**：修之前同样的测试片尾 13 帧配乐是 **-240 dBFS**（数字静音）。原因是 `amix=duration=first`
让混音长度跟旁白走，旁白 9.52 s 结束、视频 10.433 s，最后 0.91 s 配乐被截掉，第 3 步 apad 补的是静音。
`_test-narration` 当年测不出来，是因为它的视频（14.8 s）和旁白（14.731 s）差不到 0.1 s。
**修**：旁白 `apad` 补长，混音输出 `-t <视频时长>`。修后片尾 -29.8 dBFS，和停顿一致；
无配乐时 I / LRA / true peak 仍是 -13.9 LUFS / 2.1 LU / -1.5 dBTP，和修前的 demo 成片一致。

## 14. demo-tls 修复的闭环、两处工具修改、关键词触发的反向验证

`films/demo-tls/script.json` 换成 `密钥/密月`，`tts.py --only s2` → `render.mjs` → `mux.sh` → `align.py --verify`。逐轮记录在 `films/demo-tls/docs/review_log.md` 第 6 轮。

**改了 `tts.py`：`words[].parts`。** 文本转写还原成整词后，单字边界丢了。第一次复核我改用「密+月」合并窗口，
拿同一批参照重新过闸门——**没过**（`gate_merged.py`：F1_p80 留一法 21/24 < 23/24，yuè 285–344 Hz / yào 319–659 Hz 重叠），读数作废。
于是让还原后的词保留每个原始 token 的 `{w, start, end}`（`--only` 复用路径也会同步平移），复核改回已过闸门的单字窗口：

```
$ .venv/bin/python tests/fixtures/_test-narration/formant/target_fixed.py films/demo-tls/narration.json films/demo-tls/out/final-9x16.mp4
密钥。 alias 密 月。，取 parts「月。」[5.934-6.104]s → 判 yuè（阈值 512 Hz）
  F1_p80     349   yuè 组 305–409 ✓在内   yào 组 500–722   在外
  F1_med     258   yuè 组 253–305 ✓在内   yào 组 382–679   在外
  F2_p10    1707   yuè 组 1615–1772 ✓在内   yào 组 1106–1532   在外
  nvoiced     25   yuè 组 20–37 ✓在内   yào 组 13–24   在外
```

s2 合成了三次：3.004 s（合并窗口没过闸门，未判读）、3.657 s（判 yuè，F1_p80 415 Hz，比 yuè 组上限高 6 Hz；且时长与改前相同）、
**4.101 s（定稿，四项都在 yuè 组内）**。定稿版本是按"时长要变"挑的，不是按读音挑的——三版里能判读的两版都判 yuè。

**改了 `align.py`：校验器认发音词典的读音。** 修复后 Whisper（不看答案）把句子转写成「同一个蜜月」——独立旁证念的是 yuè，
但旧校验器因此**误报**：pypinyin 注「密钥」为 mi yao，「密钥→蜜月」算非同音硬错误，准确率 94.7%，exit 1。
现在对词典里「中文原词 / 等长中文转写」的条目：和词典读音同音 → 疑似同音（要人听，不计错）；
和默认注音同音、和词典读音不同 → **硬错误**（「念成默认读音，词典要求读 密月」）。函数级测试：

```
蜜月 hard 0  ['密钥→蜜月(按发音词典读 密月)']
秘药 hard 2  ['密钥→秘药(念成默认读音，词典要求读 密月)']      ← 旧版这里是 0：和默认注音同音，被放过
$ align.py --film demo-tls --verify
| s2 | 15 | 0 | - | 密钥→蜜月(按发音词典读 密月) | - |
按字准确率 100.0%   时间漂移: 中位 -0.024s   |漂移| p90 0.065s        exit=0
```

**关键词触发的反向验证：通过，`scene.html` 一个字符没改。** 之前只验过正向（按音频做出来能对上），这次是做好以后旁白变了。
在真实浏览器里读 `window.DURATION` / `window.MARKS`（`node tests/fixtures/_test-narration/formant/marks.mjs films/demo-tls`）：DURATION 10.420 → 10.864 s（+0.444）；
「公开」不动（s1 复用）；「交换」+0.050 s；「密钥」+0.260 s；「乱码」+0.444 s——每个都等于它所绑那个字的音频位移。
`scene.html` md5 改前改后都是 `8982c3fc40446ef5e1adf53df4a99725`。像素层：强调色 `#e0603a` 的峰值和归零时刻在新旧两版里都后移 +0.267 s，
期望 +0.260 s，差在一帧（0.033 s）内。

合流：I -13.9 LUFS，LRA 2.3 LU，true peak -1.4 dBTP（dynamic 模式；比 mux 的 -1.5 上限超 0.1 dB，没超 -1 dBTP）。

## 15. `--verify` 的数字归一与标点归一（ghost-jam F-032）—— 已跑

**问题**：Whisper 把念出来的「二十二」写成 `22`，逐字比对记 3 个硬错误。ghost-jam（7 句 90 字，「一圈路，二十二辆车…」）用旧版：

```
$ align.py --film ghost-jam --verify out/final-16x9.mp4 --model large-v3-turbo     # 旧版
| s1 | 13 | 3 | 二十二→22 | …
按字准确率 95.6% (阈值 97%)                                                        exit=1
$ align.py --film ghost-jam --verify out/vo.wav --model small                       # 旧版，单独转写 vo.wav
| s2 | 10 | 5 | 多「﹐」 多「﹐」 事故→试过﹐ | …        （U+FE50 小型逗号被算成字，全片 11 处）
按字准确率 82.2%                                                                    exit=1
```

**修法**（规则写在 `align.py` 的「数字归一」注释）：比对前 NFKC 并去掉一切 Unicode 标点（P*/Z*/C*）；
每段数字（中文、阿拉伯、`4.4万`、`125万6340`、`百分之五十`、`三点五`、逐位 `二零二四`）切成一个单元按**数值**比。
数值不同一律硬错误；两边都是中文、数值相同写法不同（两→二）进「要人听」；**量词和单位不归一**；
解析不了的串（约数「二三十」、「千万」）退回逐字比，**不剔出分母**。

修后（同样的文件，转写本身不变）：

| 源 | 模型 | 旧版 | 新版 | 剩下的硬错误 |
|---|---|---|---|---|
| final-16x9.mp4 | large-v3-turbo | 95.6% exit 1 | **98.9% exit 0** | 漏「的」1 字 |
| final-16x9.mp4 | small | 93.3% exit 1 | 96.7% exit 1 | 事故→试过 2 字、漏「的」 |
| vo.wav | small | 82.2% exit 1 | 96.7% exit 1 | 事故→试过、的→那 |
| vo.wav | large-v3-turbo | 93.3% exit 1 | 96.7% exit 1 | 事故→试过、漏「的」 |

漂移不受影响（final + turbo 中位 -0.007 s，|漂移| p90 0.085 s）。

**会红的用例**（`align.py --selftest`，40 条，新版 40/40；同一组喂给旧版 `score_lines` 只过 12/32——那时还没有后 8 条）：

```
$ .venv/bin/python skills/film-narration/scripts/align.py --selftest
✓ 红  「二十二辆车」 vs 「32辆车」      硬错误 3/5  二十二→32(数值不符)
✓ 红  「二十二辆车」 vs 「三十二辆车」  硬错误 3/5  二十二→三十二(数值不符)
✓ 红  「二十二辆车」 vs 「22米车」      硬错误 1/5  辆→米            ← 量词不归一
✓ 红  「四十四米」 vs 「4.4米」 / 「440米」   硬错误 3/4
✓ 红  「22 辆车」 vs 「32 辆车」        硬错误 2/4  22→32(数值不符)  ← 旧版 0 个硬错误：整段 ASCII，当外文词放过
✓ 红  「三百五米」 vs 「305米」          硬错误 3/4                   ← 口语省略：三百五 = 350
✓ 红  「约二三十人」 vs 「约20到30人」  硬错误 5/5                   ← 解析不了的约数不被剔出比对
✓ 红  「千万别停」 vs 「1000万别停」 / 「二十二辆车」 vs 「辆车」 / 「没有事故」 vs 「没有试过」 …
✓ 黄  「两辆车」 vs 「二辆车」  硬错误 0/3  要人听 两→二(数值相同、读法不同)
40/40 通过
交叉校验 film-research factcheck.mjs：33 个输入，33 个一致，已知分歧 0，新分歧 0
```

每条用例还核对**分母 = 脚本去标点后的字数**：归一失败的 token 若被静默剔掉，分母变小、准确率虚高——
这是和误报方向相反的假绿灯，这一条断言就是守它的。

**交叉校验（常设，在 `--selftest` 里）守的是：两个独立实现在同一组输入上必须给同样结果。** film-research 的
`factcheck.mjs` 也解析中文数字（给事实对账用，JS）。不直接 import：它是 CLI，模块顶层就读片子目录并 `process.exit`，
没有导出。于是 `--selftest` 抽它的 `cnToNumber` / `numValue` 源码，用 node 跑同一批 33 个输入比数值。
第一次跑就抓到 4 条分歧：`三百五 / 两千三 / 一万二 / 四万四` factcheck 读成 305 / 2003 / 10002 / 40004
（口语省略末位单位读错）。research 侧确认是真 bug（会让「三百五米」对 `305米` 的事实对账 exit 0）并改了，复跑 33/33 一致。
`三百五万` 两边约定读 350 万（同一条省略规则），SKILL.md 劝写稿写「三百五十万」。
抽取失败（函数改名）时 `--selftest` 退出 1，不静默跳过。比各自加用例有效，是因为两边不会以同样的方式想错。

## 16. `--verify` 默认模型：small → large-v3-turbo —— 已量

本机缓存 `mobiuslabsgmbh/faster-whisper-large-v3-turbo`（faster-whisper 1.2.1 的 `large-v3-turbo` 别名）。
同一份 ghost-jam 成片音轨（23.6 s，16 kHz 单声道），M3 Max CPU int8，各跑两次：

```
small            rep0 load  0.89s  transcribe  4.38s   …没有试过…
small            rep1 load  0.54s  transcribe  4.21s
large-v3-turbo   rep0 load  1.43s  transcribe 10.75s   …没有事故…
large-v3-turbo   rep1 load  1.63s  transcribe 10.86s
```

整条命令（含 ffmpeg 抽音轨）：demo-tls 5.1 s → 12.1 s，_test-narration 4.6 s → 12.3 s，ghost-jam 6.1 s → 12.8 s。
转写速度约 0.18 → 0.46 倍实时，慢 2.5 倍；3 分钟的片子约 80 s。两次转写文本一字不差。
**决定：默认换 large-v3-turbo。** 理由是 small 在一个普通词上就让闸门误判（成片 96.7% FAIL，turbo 98.9% PASS），
而闸门误报的代价是人去复核一个不存在的问题；多 7 s 在合流后的终检里可以接受。
没解决：单独转写 vo.wav 时 turbo 也听成「试过」（见上表）——是 TTS 这一处念得含糊，还是 Whisper 的错，没人听过。

## 17. 片头留白 narrationOffset（ghost-jam F-021）—— 端到端跑通，含反例

**单一真相源：`film.json` 的 `narrationOffset`（秒，缺省 0）**，外加 `narrationTail`（片尾留白）。理由和各方读法见
`references/schemas.md`。narration.json 的时刻不变（永远是旁白音频时间）；`loadNarration()` 读 film.json 平移成成片时间。

**漂移中位数为什么没抓到整体位移**：旧 `--verify` 比的是「成片音轨 vs narration.json」。留白只写在分镜 json 里，mux 没加延迟，
于是音轨和 narration.json 都是旁白时间，逐字对上，漂移 ≈ 0；画面却按分镜平移了。它不看画面，期望偏移又被隐含成 0——
测得准，但比的参照少了一项，成功提示「时间轴无漂移」读起来像音画同步，实际没测画面。复现（`_test-narration` 的副本，
场景已按 0.6 s 平移，用**旧版** `mux.sh` 合流）：

```
旧 align.py:  时间漂移: 中位 -0.016s  |漂移| p90 0.155s   ✓ 成片音轨和脚本一致，时间轴无漂移      exit=0   ← 假绿灯
新 align.py:  期望旁白起点: +0.6s（film.json narrationOffset）
              时间漂移: 中位 -0.615s  |漂移| p90 0.705s   ✗ 音轨和 narration.json（+0.6s 偏移）整体错位   exit=2
```

**端到端**（`tests/fixtures/_test-narration/`，film.json `narrationOffset: 0.6`，新 runtime 拷进片子，场景 `window.DURATION = vo.filmDuration`，
加了 `window.MARKS`）：`render.mjs --fps 30 --sub 1`（474 帧，15.8 s）→ `sfx.mjs` → `mux.sh --music assets/test-tone.wav` → `--verify`：

```
sfx.mjs:  2.935s thump ←「纯函数」  5.546s tick ←「seek」  8.712s click ←「帧」  14.797s chime ←「时间戳」  0.000s whoosh（t，不平移）
mux.sh:   ✓ out/final-9x16.mp4  视频 15.8s  旁白 out/vo.wav（片头偏移 +0.6s，film.json narrationOffset） + out/sfx.wav + …
verify:   按字准确率 100.0%   期望旁白起点 +0.6s   时间漂移: 中位 -0.024s  |漂移| p90 0.186s     exit=0
```

画面这一侧单独量：从无声成片逐帧找四个弹簧点第一次出现的帧（`tests/fixtures/_test-narration/dotmeas.py <片子目录> <无声成片> 0.6`，缩到 270×480 灰度、阈值 100）：

```
纯函数  画面首现 帧  91 = 3.033s   期望 vo.at+偏移 2.975s   差 +0.058s
seek    画面首现 帧 168 = 5.600s   期望 5.546s   差 +0.054s
ffmpeg  画面首现 帧 285 = 9.500s   期望 9.442s   差 +0.058s
时间戳  画面首现 帧 445 = 14.833s  期望 14.797s  差 +0.036s
```

四个点都在期望时刻后 36–58 ms（弹簧从 0 长到可见阈值 + 帧量化，一帧 33 ms），没有 0.6 s 量级的偏差；
声音一侧漂移中位 -0.024 s。film-critique `check.mjs` 的 mark.sync 四条全 PASS（差 0.000 s），duration.narration「旁白 0.60s–15.81s，offset 0.6s」。

**链路检查的反例**（全部在 scratchpad 副本上，`mux.sh` 拒绝合流 exit 1，`--verify` exit 4）：

| 造的错 | 报错 |
|---|---|
| 片子里拷的是旧版 `runtime/narration.js` | `runtime/narration.js 是旧版，不认 film.json 的 narrationOffset：声音会延迟 0.6s，画面不会` |
| `docs/shotlist.md` json 写 `pads.lead = 0` | `docs/shotlist.md 的 vo_offset（pads.lead=0s）≠ film.json narrationOffset=0.6s` |
| `out/sfx.json` 记的偏移是 0 | `sfx.wav 是按 narrationOffset=0s 渲的，现在是 0.6s：重跑 sfx.mjs` |
| 没有 `out/sfx.json`（旧版 sfx.mjs 渲的） | `sfx.wav 没有 sfx.json（旧版 sfx.mjs 渲的，绑关键词的音效没加偏移）` |
| shotlist 改成 `pads.lead = 0.6` | 通过，正常合流 |

`subs.py`：同一份 narration.json，`--offset 0.6` 首条 `00:00:00,645 --> 00:00:01,715`；默认读 film.json（偏移 0 时和旧输出逐字节相同）。
Node 里 `makeNarration(d, {offset: 0.6})` 四个关键词全部 +0.600 s，`captionAt(0.5)` 返回 null（留白里没字幕），负偏移抛错。
demo-tls（无 narrationOffset）回归：`--verify` 100.0%、漂移中位 -0.015 s、exit 0。

## 18. `tts.py --only` 复用路径平移 `words[].parts` —— 真跑了

第 14 节加 `parts` 时只读过代码。`tests/fixtures/_test-narration/`：先 `--only s3`（`ffmpeg/F F mpeg` 文本转写，s3 第一次带上 parts，3.605 s），
再把 `gap` 0.4 → 0.5 并 `--only s1`（s1 3.448 → 3.631 s），s3/s4 走复用路径：

```
s3 句首平移 0.383      （= s1 变长 0.183 + gap 多 0.1 × 2）
 词 ffmpeg， A 8.459 9.349 B 8.842 9.732 Δ 0.383 0.383
   part F      A 8.459 8.719 B 8.842 9.102 Δ 0.383 0.383
   part F      A 8.719 8.949 B 9.102 9.332 Δ 0.383 0.383
   part mpeg， A 9.319 9.349 B 9.702 9.732 Δ 0.383 0.383
   parts 全部平移 = 句首平移: True   首尾与整词对齐: True
顶层 words 与 lines[].words 的 parts 一致: True
```

平移正确。测试片的 script.json 因此留在 `gap 0.5`（和 narration.json 的 script_hash 02e2768a4b84 一致），
第 1、9 节引用的旧时刻（gap 0.4 时代）不再对应当前文件。

## 19. `mux.sh --limit` / `--lra`（ghost-jam F-033）—— 跑了，顺带改正一处旧结论

ghost-jam 的 vo.wav + sfx.wav + 无声成片拷到 scratchpad（不动原片），`mux.sh --lufs -14`：

```
无参数                     dynamic   I -14.1 LUFS  LRA 3.5  TP -1.0 dBTP   （复现使用者报的 TP -1.0）
--limit auto               dynamic   I -14.0       LRA 3.7  TP -1.2        限幅：天花板 -10.54 dBFS，峰值 -8.01 -> -10.44 dBTP
--limit auto --lra 16      linear    I -13.9       LRA 3.9  TP -1.4
```

**旧注释「退回动态 = true peak 余量不够」只说对了一半。** 只加 `--limit` 仍是 dynamic；手工重放第二遍 loudnorm，
同一组实测值只改目标 LRA：`LRA=11 → dynamic`，`LRA=16 / 20 → linear`。线性还要求 loudnorm 测得的输入 LRA（这里 15.4 LU）
≤ 目标 LRA。`mux.sh` 现在把两条原因分别算出来打印，并加了 `--lra`。demo-tls 当年的输入 LRA 是 2.4，所以那次确实只是 TP。
TP -1.4 比 loudnorm 的 -1.5 高 0.1 dB，是 AAC 编码后再测的（第 14 节 demo 也是这样），没超 -1 dBTP。

## 20. F-016 / F-015

- F-016：`tts.py` 的低置信度清单跳过纯标点 token（去掉 P/Z/S 类字符后为空，「——」「，」「%」都算）。
  只做了函数级检查（`——` `—` `，` → 跳过；`ffmpeg，` `密钥。` → 保留），没有重合成一句带破折号的台词来复现。
- F-015：当前 SKILL.md、`assets/script.template.json`、`references/` 里对拼音写法的说法已一致（「接口接受但实测不改读音」），
  使用者读到的「只改读音，时间戳 token 不变」已不存在（`grep -rn 只改读音 skills/film-narration` 无结果）。没改。

## 21. 字时间戳 vs 能量包络（weiqi-intro「上、下、左、右」）—— 真跑，含复现与阴性对照

`scripts/_timing.py`，`tts.py` 合成后调（退出 6）、`tts.py --check-timing` 只查、`align.py --verify` 每次查（退出 6）。
做法和阈值的理由写在 `_timing.py` 文件头。量法：本节所有数字都由下面三条命令出（scratchpad 的探索脚本只用来选参数）。

```bash
python3 scripts/_timing.py films/<slug>                 # 单独跑，退出 0 / 6
.venv/bin/python scripts/tts.py --film <slug> --check-timing
```

**第一版判据（「每段能量都要有字从那里起」）被真复现推翻了，值得记。** 人为把 weiqi-intro s4 的四个字挤进 0.1 s 时它能报；
但现合的真实挤压里，后面的字会**整串顺移**去填前面的能量段（v2：「紧」「挨」落进「下」那段、「着它还空」落进「左」那段），
每段都有字起点，一条都不报。所以改成**只用时长**把意群对到能量段（动态规划），再比意群起点——时间戳整串错位时对齐不跟着错。

**普查（正常组）**：仓库 10 支片 85 句 volcano-stream 旁白，306 个意群锚点。

| | 意群起点 \|Δ\| |
|---|---|
| 正常的最大值 | 0.15 s（weiqi-ch1 p1「传说」）；其余 ≤ 0.14 s（eval-deepsea s2 0.135、weiqi-intro s1 0.12） |
| 普查抓到的真错（频谱/包络逐一核过） | eval-clearing s5「是」**+0.25 s**（「是」的擦音 1.18 s 起，接口把它标在「四」上，「四行账」并成 conf 0.215 的一个 token）；weiqi-ch1 d6「一样」**+0.22 s**（「样」在 -45 dB 静音里）；weiqi-ch1 d8「有两只眼的棋」**+0.78 s**（6 字挤进 0.31 s） |

**阳性组**（scratchpad，weiqi-intro 原音色 `zh_female_cancan_uranus_bigtts`、speechRate 12，原句）：

| 样本 | 接口给的「上下左右」起点（句内秒） | 包络 | 判定 |
|---|---|---|---|
| 顿号 v1 | 2.58 / 3.115 / 4.085 / 4.115 | 2.47 / 2.95 / 3.59 / 3.98 | ✗ 「左」晚 0.50 s，「左右」挤在 0.07 s |
| 顿号 v2 | 2.68 / 2.725 / 2.755 / 2.785 | 2.53 / 3.15 / 3.81 / 4.27 | ✗ 后面整串错位，最大早 2.48 s |
| 顿号 v3 | 2.60 / 2.645 / 3.685 / 3.715 | 2.55 / 3.00 / 3.55（左右并段） | ✗「下」早 0.36 s |
| 顿号 dun | 2.62 / 2.665 / 2.695 / 3.995 | — | ✗「左」早 0.91 s，「上下左」挤在 0.10 s |
| 逗号 dou | 2.52 / 2.935 / 3.635 / 3.885 | — | ✗ **在后面的「它、」处挤**：「紧挨着它还空」6 字挤在 0.30 s，最大早 1.42 s |
| 逗号 dou2 | 2.60 / 3.105 / 3.845 / 4.405 | — | ✓ 0 失败 |
| weiqi-intro s4 人为挤进 0.1 s | 2.50 / 2.525 / 2.55 / 2.575 | 2.45 / 3.18 / 3.96 / 4.62 | ✗ 最大早 2.05 s |

顿号 4/4 次挤压。逗号不是保证：1/2 次在同句后面的顿号处挤。所以报错的修法是「改标点或拆句，**重合成后再查**」，不是「换成逗号就好」。
报错示例（v3）：

```
✗ 字时间戳 vs 能量包络［错拍］v3: 「下」接口 2.64s / 包络 3.00s（早 0.36s）；接口把「上下」2 个字挤在 2.60–2.68s（0.07s）里。句内秒；旁白秒 = 句内 + 15.747。按字触发的动画会错拍这么多
    修法：把这几处顿号「、」换成逗号「，」（…）；然后 tts.py --only v3 重合成，这条消失才算修好
```

**参数敏感性**：停顿下限 0.06 / 0.08 / 0.10 s 结果相同；合并罚 0.15 时动态规划把 s4 的四个单音节意群并错（weiqi-intro 正常的 s4 误报 1.29 s），0.3 / 0.6 相同，取 0.6。
FAIL 0.20 s 夹在正常上界 0.15 与真错下界 0.22 之间，**两边余量都只有约 0.05 s**。

**其他阴性对照**：`timingWaive` 写了理由 → 该句失败降为警告并打印理由（rep2 dun：2 处失败 → 1 处）；
Whisper 反推的时间戳（当时的 edge 引擎就是，原因和修复见第 25 节）首字被标在 0：两句各早 0.19 / 0.20 s，只警告不失败。
现有片子：weiqi-intro / ghost-jam / demo-tls / demo-grid / tang-dynasty / eval-deepsea / _test-narration 0 失败；
eval-clearing 1 失败（s5，真错，没有成片所以不进 verify 门）；weiqi-ch1 2 失败（d6 / d8，真错，进行中的片子，没动）。
耗时：纯 Python + ffmpeg，weiqi-intro 60 s 旁白 0.8 s。

## 22. 片头留白：shotlist 没写 vo_offset 不再当成 0 —— 阴性对照 6 种写法

`_film.py offset_links`（`mux.sh` / `--verify` 共用）。film.json `narrationOffset 0.3 / narrationTail 1.2`，片子里拷了认偏移的 narration.js：

| shotlist json | 旧版 | 新版 |
|---|---|---|
| 没写 `vo_offset` | ✗ 拒绝合流（`pads.None=0s ≠ 0.3`） | ✓ 不比 |
| `vo_offset: "lead"`, `lead: 0.3`（weiqi-intro 现状） | ✓ | ✓ |
| `lead: 0.5` | ✗ | ✗ |
| `vo_offset: 0.5`（数字） | ✗ | ✗ |
| `vo_offset: "lead"` 但 pads 里没有 | ✗（当成 0） | ⚠ 提示，不比（check_shotlist 报错） |
| 只写 `pads.tail: 2.0` | ✗ ✗（两条） | ✗（只剩 tail 那条，真矛盾） |

weiqi-intro 实片：`_film.py offset films/weiqi-intro --sfx out/sfx.wav` → `0.3`，退出 0。

## 23. sfx.mjs 用片子自己的音色运行时 —— 真跑

- 回归：改前全部 7 支片的 `runtime/sfx.mjs` 与 skill 版逐字相同。weiqi-intro（50 个事件，全是 `file`）、ghost-jam 重渲到 scratchpad，
  与各自现有 `out/sfx.wav` **逐字节相同**（weiqi-intro 的 `sfx.json` 也相同）。
- 加音色：scratchpad 片子的 `runtime/sfx.mjs` 里加 `wood`，cue `{"at":"在","nth":2,"type":"wood"}` → 渲出，16.054 s 处峰值 -4.2 dB（15.5 s 处 -91 dB）。skill 的运行时没动。
- 阴性：片内没登记的 `inhale` → 退出 1，列出片内那份的音色并说怎么加；片子没拷运行时却要 `wood` → 退出 1，提示先拷再加；没拷运行时用内置 `click` → 照常（用 skill 的那份，并打印来源）。

## 24. 成片 true peak 门 —— 真跑，weiqi-intro 重混

量法：交付的 mp4 解码后 `loudnorm=print_format=json` 取 `input_tp`。ebur128 只给一位小数（ghost-jam -1.01 显示 -1.0），
两种表对同一文件最多差 0.2 dB（weiqi-intro `--lufs -17`：loudnorm -1.10，ebur128 -1.3）。

| 文件 | TP | `mux.sh` | `--verify` |
|---|---|---|---|
| weiqi-intro 原定稿（`--lufs -14`，dynamic） | -0.51 | 退出 5（重放到 scratchpad） | **退出 5**，准确率 99.1% |
| weiqi-intro `--lufs -16`（dynamic，新定稿） | -1.44 | 退出 0 + ⚠ | 退出 0 + ⚠，**100.0%**，漂移中位 -0.006 s |
| weiqi-intro `--lufs -19.5`（linear） | -1.93 | 退出 0 ✓ | 退出 0，99.1% |
| ghost-jam 定稿 | -1.01 | — | 退出 0 + ⚠，98.9% |
| demo-tls 定稿 | -1.43 | — | 退出 0 + ⚠，100.0% |

weiqi-intro 的 `--lufs` 扫描（全 dynamic，只 -19.5 linear）：-15 → -1.35、-15.5 → -1.13、-16 → -1.44、-17 → -1.10、-18 → -1.49、-19 → -1.51。
**动态模式下真峰不单调**：限幅器按 -1.5 压，AAC 过冲 0–0.4 dB。混音前 -21.65 LUFS / -4.08 dBTP，线性上限 -19.1 LUFS——
`mux.sh` 的动态模式提示现在会算出这个数（`≤ -19.1 能保持线性`）。新定稿音轨与 scratchpad 校验过的那版逐样本相同。

## 25. edge 引擎恢复原生词边界 + 时间戳自检按 volcano 同等对待 —— 真跑

edge-tts 7.3.1 的 `Communicate` 默认 `boundary='SentenceBoundary'`，`synth_edge` 只收 `WordBoundary`，
所以每句都静默退回 Whisper 反推（第 21 节的 edge 样本 narration.json 全是 `src: whisper`，首字被标在 0）。
改成按签名判断：有 `boundary` 参数就传 `'WordBoundary'`，老版本（没有这个参数、本来只发词边界）不传。

现合同一份 script（`zh-CN-XiaoxiaoNeural`，「上、下、左、右，紧挨着它的点。」+ weiqi-intro s4 顿号原句）：
修前 0 个原生时间戳、全走 Whisper；修后 9 + 26 个原生词边界，无 `src: whisper`，`tts.py` 退出 0。

**edge 的 token 不带标点**（「上」「下」，volcano 是「上，」），旧的意群切分只看 token 尾巴，edge 整句会切成一个意群、只剩一个锚点。
所以 `_timing.phrases()` 改成**从台词原文取 token 后面的停顿标点**（逐字对不上原文时退回 token 自带的标点）。
回归：仓库 86 句 volcano 旁白的 306 个锚点 |Δ| 与改前逐项相同（仍是最大 0.15 s，eval-clearing s5 0.25 s）。
edge 两句切出 14 个意群（`上 / 下 / 左 / 右 / 紧挨着它的点` …），|Δ| 最大 0.11 s，和 volcano 的正常组同一分布。
阳性对照：把 edge 那句的「上下左右」人为挤进 0.10 s → ✗ 错拍（最大早 1.79 s），修法提示认出原文里的顿号。
**结论：edge 原生词边界按 volcano 同等判（失败就是失败）**；只有 `src: whisper` 的反推结果仍只警告（首字常被标在 0，且没有「改标点重合成」这条修法）。

（weiqi-ch1 在这期间重写并重合成了 d6 / d8，第 21 节报的那两处现在 0 失败；`--check-timing` 全片 0 失败 10 警告。）

## 26. seed-tts-2.0 的每种语气/节奏控制到底生不生效 —— 真跑，每条件重复取分布

背景：用户说旁白「音色 low、语速平缓没有高级自然感」。核实后模型版本不是问题（`seed-tts-2.0` 就是当前最新的合成模型，官方来源见 `references/volcano-api.md`），
问题在用法：weiqi-ch1 44 句全是 `speechRate 12`、0 句用 `context_texts`。所以逐种验控制方式。

量法：同一句「夜色降临，城市的灯一盏一盏亮起来，没有人注意到那扇门开了。」（27 字），知性灿灿（weiqi 用的）和云舟两把嗓子，
每条件合 2–6 次。指标：语速（去首尾静音）、发音速率（再去句内停顿）、基频 sd（半音）、句内停顿（≥ 0.12 s 静音）、100 ms 窗响度 sd。
和 base 比用 Mann-Whitney 双侧。脚本在会话 scratchpad（`tools/expA*.py`、`analyze.py`），这里贴结论。

**云舟**（n=6 vs 6，除注明外）：

| 条件 | 时长 Δ | 语速 Δ 字/秒 | 句内停顿总长 Δ s | 响度 sd Δ dB |
|---|---|---|---|---|
| `context_texts: ["你可以说快一点吗？"]` | −0.90 s（p=0.004） | +1.06（p=0.002） | +0.32（p=0.035） | −1.81（p=0.002） |
| `["你可以说慢一点吗？"]` | +0.78 s（p=0.012） | −0.41（p=0.026） | +0.69（p=0.005） | −1.75（p=0.004） |
| `["请用低沉、压着嗓子、充满悬念的语气说"]` | +0.09（p=0.46） | +0.04（p=0.69） | +0.52（p=0.063） | −1.37（p=0.065） |
| `["快","慢"]`（n=3） | −0.99 s（p=0.022） | 跟「快」 | | |
| `["慢","快"]`（n=3） | +0.39 s（p=0.082） | 跟「慢」 | | |
| `section_id`（先合上一句，同 ID 再合本句，n=3） | −0.18（p=1.0） | 无差 | | |

**知性灿灿**（n=6 vs 6）：说快点 语速 +0.21 字/秒（p=0.009）、停顿 −0.22 s（p=0.030）；说慢点 −0.17（p=0.24，不显著）；
「非常缓慢、一字一顿」（n=3）时长 +0.38 s（p=0.048）；低沉/激动/悲伤类指令在基频中位、基频 sd、响度 sd 上全部 p ≥ 0.24。

结论：
- `context_texts` **生效**、**只认第一个值**、**不计费**（每次计费都是 29 字，和不带一样）、不被念出来（时间戳 token 与原文逐字相同）、字时间戳自检 0 失败。
- **强度因音色而异**：同样的「说快/说慢」，云舟 ±13–15% 时长，灿灿 ±3–5%。weiqi 现在的嗓子恰好是响应弱的那把。
- **情绪/语气类指令在这几项物理量上测不出**。这不等于没效果（音色质感、重音位置这些指标量不到），只说明「加一句情绪指令就有起伏」没有证据——要靠人听。

**原样写进 text 的三种「行内指令」全被念出来**（Whisper large-v3-turbo 转写）：

| 写法 | 转写 | 计费字 | 时长 | 字时间戳自检 |
|---|---|---|---|---|
| `[#用低沉缓慢、充满悬念的语气说]` + 原句（官方控制台写法） | 「警号/锦绍/景浩用低沉缓慢充满悬念的语气说，夜色降临……」 | 29 → 46 | 6.2 → 10.6 s | 6/6 失败（「用低沉缓慢」晚 0.27–0.88 s） |
| `（低沉缓慢地）` + 原句（默认括号过滤应当滤掉） | 「低沉缓慢地，夜色降临……」 | 29 → 36 | 7.8 s | 0 失败（但念了） |
| `<cot text=语速缓慢>…</cot>` + `use_tag_parser: true` | 「Code Text 等于语速缓慢，夜色降临……」 | 29 → 50 | 8.8 s | 警告 |

→ 行内标记必须本地解析（`scripts/_markup.py`），这是硬约束，写进了 SKILL.md。

**其他控制**：

| 控制 | 结果 |
|---|---|
| `emotion: sad, emotion_scale: 5`（n=2） | 无可测变化，不报错（官方：只对部分音色） |
| `post_process.pitch` ±6 | 基频 218 → 316 / 157 Hz（= ±6 半音，误差 < 0.6 半音），时长不变 |
| SSML `<speak>夜色降临，<break time="1s"/>城市……</speak>`（灿灿 3 次、云舟 2 次） | 最长停顿 0.98 s（base 0.73），确实停了；**时间戳回了但被挤压**：「色降临」挤在 0.18 s、整串晚 0.5 s，自检 1/1 失败；计费 62 字（按 SSML 字符串） |
| 标点：同一处「到那」之间的静音（能量包络，n=4–6） | 灿灿：无标点 0.08 ± 0.05 / 「，」0.15 ± 0.02 / 「——」0.26 ± 0.04 / 「……」0.35 ± 0.07 s；云舟：0 / 0.26 ± 0.13 / 0.35 ± 0.03 / 0.31 ± 0.20 s。时间戳全部 0 失败；「……」回成两个独立的「…」token |

### 26b. 接进 script.json 后的端到端（scratchpad 片子，`tts.py` 真跑）

- `instruction`（顶层 + 逐句覆盖）、逐句 `speechRate`、`gapAfter`、行内 `[#…]` / `[停顿 0.25]`：weiqi-ch1 p1–p3 新版 3 句，p1 切成 3 段合成，
  计费 75 字（和不切段的原设置重合 75 字相同），时间戳 61 个，`tts.py` 自检 0 失败；`align.py --verify`（out/vo.wav）100.0%，漂移中位 −0.004 s，narration.json 的 `text` 不含任何标记。
- `--only p3` 复用切过段的 p1：`segments` 按新时间轴平移；p1 加 `gapAfter 0.8` 后 p2 从 5.276 s 移到 5.726 s（+0.45 = 0.8 − 0.35）；
  p2 改了指令但不在 `--only` 里 → 警告「复用的是旧音频」。
- edge 引擎同一份 script：警告指令被忽略，标记照样去掉，`[停顿]` 和 `gapAfter` 照样生效，原生词边界，自检 0 失败。
- 向后兼容：仓库 12 支有 script.json 的片子，新旧 `tts.py --dry-run` 的请求体逐字相同，`script_hash` 逐个相同；
  ghost-jam / demo-tls / weiqi-intro 的 `align.py --verify` 照旧通过（98.9% / 100% / 漂移中位 −0.005 / −0.015 s，0 处时间戳失败），`--selftest` 33/33 一致。

## 27. 按题材选音色：一轮完整实测（三种题材 × 3 候选 × 带/不带指令）——数据，不是推荐

**目录**：官方 2.0 中文音色 90 个 `*_uranus_bigtts` + 8 个 `ICL_uranus_*_tob`，用同一句中性台词各合 1 次（98 次请求，2842 字），
**98/98 本账号可用**，物理量写进 `references/voice-catalog.json`。

**三种题材**，各写两句台词，按 SKILL.md 第二节走「题材 → 维度目标 → 候选」，每个候选带/不带按句指令各合一条（36 次请求，918 字）。
每格单次合成；第 26 节测得同条件语速 sd≈0.15 字/秒，差得比这小的不算数。

| 题材 | 维度目标（写给打分用的） | 候选（目录里怎么缩出来的） |
|---|---|---|
| 围棋入门讲解 | 亲近、有起伏、语速适中：4.0–4.8 字/秒内取基频 sd 最大 | 渊博小叔（男，95 Hz）、知性女声（女，基频 sd 6.5、语速 4.9）、Tina 老师（官方「教育场景」） |
| 赛博 / 黑客帝国 | 冷、平、有留白：停顿总长 − 基频 sd，语速 > 4.2 扣分 | 机甲智能（ICL，基频 sd 3.7）、深夜播客（82 Hz，基频 sd 3.5）、高冷御姐（女声对照） |
| 玄幻 / 仙侠 | 史诗感：基频 sd + 停顿总长/2，语速 > 3.8 扣分 | 擎苍（官方古风、86 Hz、基频 sd 8.3）、东方浩然（91 Hz、7.1）、古风少御（女声对照） |

| 题材 | 音色 | 指令 | 语速 | 基频中位 | 基频 sd | 停顿总长 | 最长停顿 | 响度 sd | 得分 |
|---|---|---|---|---|---|---|---|---|---|
| 围棋 | 渊博小叔 | 无 / 带 | 4.38 / 4.55 | 93.5 / 103.8 | 5.89 / 5.26 | 1.70 / 1.77 | 0.57 / 0.68 | 5.34 / 4.57 | 5.89 / 5.26 |
| 围棋 | 知性女声 | 无 / 带 | 4.36 / 4.28 | 231.6 / 229.0 | 5.39 / **6.24** | 1.79 / 1.51 | 0.93 / 0.87 | 4.83 / 5.21 | 5.39 / **6.24** |
| 围棋 | Tina 老师 | 无 / 带 | 3.77 / 3.85 | 189.8 / 188.1 | 7.60 / 7.80 | 1.88 / 1.69 | 0.73 / 0.74 | 6.05 / 6.55 | 5.60 / 5.80（语速出界扣分） |
| 赛博 | 机甲智能 | 无 / 带 | 4.09 / 3.78 | 110.3 / 108.7 | 3.46 / 4.51 | 1.06 / 1.01 | 0.74 / 0.70 | 7.31 / 7.52 | −2.40 / −3.50 |
| 赛博 | 深夜播客 | 无 / 带 | 3.68 / **3.22** | 86.8 / 81.4 | **2.95** / 3.53 | 3.55 / **4.06** | 0.55 / 0.81 | 6.37 / 6.49 | **0.60** / 0.53 |
| 赛博 | 高冷御姐 | 无 / 带 | 4.10 / 4.20 | 201.6 / 200.5 | 5.33 / 4.47 | 3.18 / 3.02 | 0.57 / 0.63 | 6.53 / 6.33 | −2.15 / −1.45 |
| 仙侠 | 擎苍 | 无 / 带 | 3.47 / 3.49 | 86.3 / 80.0 | 5.65 / 4.88 | 3.21 / 3.24 | 0.77 / 0.77 | 6.68 / 5.59 | 7.26 / 6.50 |
| 仙侠 | 东方浩然 | 无 / 带 | 3.50 / 3.49 | 86.5 / 86.3 | **6.29** / 5.93 | 3.04 / 3.12 | 0.85 / 0.95 | 6.58 / 6.15 | **7.81** / 7.49 |
| 仙侠 | 古风少御 | 无 / 带 | 3.80 / 3.73 | 290.2 / 325.7 | 3.42 / 4.03 | 3.53 / 3.73 | 0.77 / 0.80 | 5.16 / 5.70 | 5.18 / 5.90 |

（每个样本两句，句间 0.35 s 算进停顿。18 个样本里 36 句的字时间戳自检全部 0 失败，指令全部没被念出。）

读法：
- 带/不带指令的差，大多数格子落在单次方差之内；超出的只有深夜播客的「慢、停顿长」（语速 −0.46、停顿 +0.51 s）、机甲智能的语速 −0.31。
  `ICL_uranus_*_tob` 官方能力列为空，机甲智能带指令仍有变化，但单次样本不足以下结论。
- 古风少御带指令那条基频中位 290 → 326 Hz，没有听过，可能是 pyin 的倍频错误，也可能真的被指令推高了。
- 按指标挑出的各题材前两名拼在 scratchpad 的 `voice-ab/_compare_best2.wav`（提示音响 n 声 = 第 n 段），每种题材全部 6 个版本在 `voice-ab/_compare_<题材>.wav`。
  **没有经过人耳**：上面的「得分」只是把维度目标翻成了数字。

### 27b. weiqi-ch1 前三句：新控制 vs 原设置（scratchpad，正片没动）

| 版本 | 三句语速 字/秒 | 句间语速极差 | 基频 sd 均值 半音 | 句内停顿合计 s | 三句总时长 s |
|---|---|---|---|---|---|
| 正片原版（灿灿、全片 speechRate 12、无指令） | 4.27 / 4.60 / 5.13 | 0.86 | 5.38 | 2.15 | 13.85 |
| 原设置今天重合一次 | 4.28 / 4.66 / 5.10 | 0.82 | 6.64 | 2.50 | 13.84 |
| 新：灿灿 + 逐句指令 + speechRate 4/8/14 + p1 句中转折与 0.25 s 停顿（第 1 次） | 3.80 / 4.32 / 5.19 | 1.39 | 4.49 | 2.63 | 14.54 |
| 同上第 2 次 | 3.70 / 4.56 / 5.11 | 1.41 | 5.41 | 2.53 | 14.38 |
| 新：知性女声 + 同样的控制 | 3.83 / 4.80 / 5.33 | 1.50 | 4.52 | 2.06 | 14.02 |

结论：句与句之间的**语速起伏**确实变大了（极差 0.82–0.86 → 1.39–1.50 字/秒，主要靠逐句 `speechRate`，两次重合可复现）；
**句内基频起伏没有变大**（4.5–5.4 vs 原版 5.4–6.6）——在灿灿和知性女声上，语气指令都没有把基频推出更大的起伏。
「更自然」能不能听出来，要人听 scratchpad 的 `weiqi-p13-compare.wav`（1 声 = 正片原版，2 声 = 灿灿新版，3 声 = 知性女声新版）。

### 27c. 两支围棋短片的正式旁白（weiqi-fx-open / weiqi-fx-eyes）

知性女声 + 逐句指令 + speechRate 0，台词逐字照抄 weiqi-ch1。首轮各 1 处时间戳失败：weiqi-fx-open p1「传说」晚 0.31 s、weiqi-fx-eyes d7「这两口气」晚 0.20 s。
p1 又重合了 3 次，前两次仍失败（晚 0.22、0.26 s），第 3 次通过；d7 重合 1 次通过。两支最终 `--check-timing` 都是 0 失败、0 警告，时长 24.404 / 25.991 s。
**p1 在这把嗓子 + 这句指令下，4 次里有 3 次「传说」晚了**（问号后面那一口气比接口标的长）。以后重合 p1 要预期多抽几次。

### 27d. 「不够自然」的对比：S2S 主打四音色 / 去指令 / seed-audio / 聊天类音色 / 口语化改写（p1 p2 d7 d8 四句）

用户听了 27c 的旁白，说「不够自然」，点名「Vivi 2.0、小何 2.0、云舟 2.0、小天 2.0 是 S2S 的主打音色」。
官方音色列表第一张表的标题就是「豆包语音合成模型 2.0、S2S-O2.0、S2S-全双工」音色列表，所以这四个**本来就是 TTS 2.0 音色**
（`zh_female_vv` / `zh_female_xiaohe` / `zh_male_m191` / `zh_male_taocheng` + `_uranus_bigtts`）。用 volcano-stream 就能合，有字级时间戳，不用走实时语音接口。
共 40 次请求：seed-tts-2.0 36 次、912 字，seed-audio 4 次、25.9 音频秒。每段四句、句间 0.35 s，每段单次合成。

| 版本 | 语速 | 基频 sd | 停顿总长 | 最长停顿 | 时间戳失败（4 句里） |
|---|---|---|---|---|---|
| Vivi / 小何 / 云舟 / 小天（无指令） | 3.45 / 3.76 / 3.37 / 3.70 | 6.53 / 3.84 / 5.69 / 6.42 | 3.9 / 4.15 / 3.41 / 5.09 | 0.53 / 0.60 / 0.64 / 0.66 | 1 / 0 / 1 / 1 |
| 知性女声 + 指令（现版）/ 无指令 | 3.58 / 3.76 | 5.17 / 4.18 | 5.75 / 4.78 | 0.90 / 0.91 | 0 / 1 |
| seed-audio-1.0（参考音色知性女声） | 2.65 | 3.53 | 9.56 | 2.34 | 3 |
| 深夜播客 / 亲切女声（无指令） | 2.68 / 4.09 | 3.81 / 2.83 | 9.65 / 2.50 | 0.67 / 0.78 | 0 / 3 |
| 口语化改写稿 · 知性女声 / Vivi | 4.45 / 3.99 | 4.29 / 6.46 | 4.56 / 6.14 | 0.93 / 0.79 | 2 / 0 |

**这些指标不代表「自然」**，结论只有两条是机械的：
- 知性女声带指令那版（现版）的基频起伏比不带的大（5.17 vs 4.18）。
- seed-audio 做纯旁白时又慢又拖（最长停顿 2.34 s），四句里 3 句时间戳失败。

对比音频在会话 scratchpad 的 `voice-ab/natural/_compare_natural.wav`，没有经过人耳。

## 28. 语义区间 `[@id]…[@/id]` + `vo.span(id)`，写稿前估时长 —— 离线真跑（2026-10-23，没调 TTS）

**区间。** 拷 weiqi2-l1 到 scratchpad，台词加 8 个区间（a1 嵌套 `rule ⊃ side` + 相邻 `goal`，a4 `dirs ⊃ up, down` + `qi`，a8 全角 `【@atari】`）。
`tts.py --spans` 实测输出（旁白秒）：rule 2.045→5.235「黑棋圈住左边，白棋圈住右边。」、side 4.765→5.235、goal 6.435→7.565、
dirs 19.415→22.100、up 19.415→19.780、down 20.070→20.500、qi 25.810→25.930、atari 45.909→46.459；rule.start = 原 narration.json 里「黑」的 start。
除新增的 `spans` 键外与原片 narration.json 完全相等（script_hash 也不变）。`--dry-run` 请求体的 `text` 不含任何标记。
主流程也走了一遍：重放脚本把引擎换成「返回旧时间戳 + 旧 wav」（不发请求），`--only a4` 跑完整个 `main()`，产出与 `--spans` 逐字节相同。
运行时（Node）：`vo.span('rule')` 加 offset 0.6 → 2.645→5.835；未知 id 和 `constructor` 都抛错；两参数 `span('黑棋','右边')` 照旧。
`_markup.py` 自测加了 4 条区间正例、6 条反例（不闭合、无开标记、同句重复 id、空 id、区间只有标点、id 带空格）和 1 条投影（边界切进英文 token 时扩整并警告）。

**老片不变。** 同一个重放脚本对 weiqi2-l1(a3) / ghost-jam(s2) / weiqi-intro(s3) 原样跑 `--only`：三支 narration.json 与仓库里的**逐字节一致**。
另对仓库 15 支有 script_hash 的片子用新代码重算：哈希全部等于已存值，`build_spans` 全部为空（不会出现 `spans` 键）。

**估时长。** 特征：汉字数、句中停顿标点（，、；：）、句末/破折/省略、拉丁音节、`[停顿]`、speechRate 系数 1+r/100；
对 17 支片 141 句 volcano-stream `lines[].duration` 最小二乘：0.145 s/字、0.49 s/逗号类、0.63 s/句末类、0.20 s/句、0.27 s/拉丁音节。

| 评估 | 逐句 MAPE | 逐句 p90 | 片总长（平均绝对 / 最差） |
|---|---|---|---|
| 留一片交叉验证，线性模型 | 9.0% | 19.3% | 5.9% / ghost-jam +25.7%（只算句子） |
| 留一片交叉验证，只用 3.8 字/秒 | 12.0% | 24.2% | 7.1% |
| 全量拟合（即 `_timing.py` 里的系数），含 gap | 8.6% | 18.3% | 4.7% / ghost-jam +20.3%、eval-clearing +14.2%、tang-dynasty −11.5% |

音色差异是主要误差：实测 taocheng 4.42、m191 4.05、vv 3.84、xuanyijieshuo 3.72、灿灿 3.71、qingcang 3.43 字/秒（含停顿，按语速系数还原）。
weiqi2-l1 估 52.2 s，实测 51.9 s。复现：逐片读 script.json + narration.json，按 id 配对、只取去标记后文本与 narration 一致的句子，对每句调 `_timing.estimate_line` 与 `duration` 比。

## 29. 音效可选能力（立体声声像 / 锚点 / 场景事件 / probe 曲线 / 共享房间）+ 无旁白合流 —— 真跑（2026-10-23）

工作目录 `<scratchpad>/sfxdev`（scratchpad，不动 films/）。先用**改动前**的 `film-narration` 整份拷贝（`orig/`）出基线，再用改后的脚本重跑比对。

**老片一致性（三支用了音效的片子的副本：weiqi-intro 50 个 cue（素材 + at）、ghost-jam 1 个素材 cue、weiqi2-l1 13 个 cue（含合成 whoosh））**：

```
sfx.mjs 重跑：out/sfx.wav、out/sfx.json 与基线 cmp 逐字节相同（三支都是）
mux.sh 重跑（默认参数）：final mp4 逐字节相同
  weiqi-intro e6b0a2590a2c68b0acbdf8136f40dccc   ghost-jam 198876e5ad6c511fb1cccb81015079c0   weiqi2-l1 5864217f55ca9964047bfd0b4f23d31b
```
理由：cue 不写新字段、cues.json 是数组时，`sfx.mjs` 走的是原来的 `renderCues` / `toWav`（片子那份运行时），代码路径一字不改；
`mux.sh` 有 vo.wav 时滤镜图一字不改。

**为什么等功率声像（pan=0 → ×0.7071）**：实测 ffmpeg 把单声道 `aformat=channel_layouts=stereo` 成立体声是每声道 -3.01 dB
（440 Hz 正弦单声道峰值 -18.06 dB → 上混后两声道各 -21.07 dB）。把 weiqi-intro 的 50 个 cue 强制走立体声（`"stereo": true`）：
sfx.wav 两声道相同、= 单声道 ×0.70711（残差 ≤ 0.85 LSB）；mux 混音前响度 -21.65 LUFS / 真峰 -4.08 dBTP，与单声道路径**一字不差**；
合流前混音残差 **-83.6 dB**（最大 218 LSB@24bit ≈ 16 bit 量化级）。但 AAC 编码后成片 PCM 差 -33.8 dB RMS（`--lufs -20` 线性模式下）——
AAC 对微小输入差异做出不同的量化决策。**所以老片必须走老路径才能保证成片不变**，这就是"不写新字段 = 老路径"的原因。

**无旁白合流**：tencent-5y 副本（静音 vo.wav 占位 + 立体声 sfx.wav）：
```
改前 mux.sh：final 31511861431e8c02758dd033f5be3bf8   改后 mux.sh（vo.wav 还在）：31511861431e8c02758dd033f5be3bf8
改后、删掉占位 vo.wav（走无旁白路径）：            31511861431e8c02758dd033f5be3bf8   ← 三者逐字节相同
```
其他分支：只给 `--music`（无 vo、无 sfx）→ 合流成功并提示"--duck 没有触发源"；三者都没有 → 退出 1；`--vo` 显式给了不存在的文件 → 退出 1。

**演示片 `<scratchpad>/sfxdev/films/_sfx-demo`**（16x9，6 s，无旁白、无 script.json；黄球从左弹到右，场景暴露 `anchors(t)`（球）、`probe(t)`（speed 0..1）、
`events()`（8 次落地 bounce + 每次落地后 20 ms 的 scrape + 一个 debug-marker））。cues.json：`panWidth 0.8`、`room {size 0.6, damp 0.5}`、
`dedupe 0.04`、`fromScene.map`（bounce→thump，gain 读事件 v、send 0.35、stack hit；scrape→tick；debug-marker→null），
外加手写两条：一条 6 s 的 noise 连续层（`anchor: 球, follow`，gain/lowpass 读 probe speed）和一条 chime。

```
✓ out/sfx.wav  立体声  10 个事件（其中 8 个来自场景 window.events()）  去重丢掉 8 个（dedupe 0.04s）  8.80s  峰值 -4.4 dBFS
  cue #0（noise）  gain ← probe「speed」 1441 点 @240Hz  范围 0.000..0.500；lowpass 200..3200；pan ← 锚点「球」 跟随 181 帧 @30fps 范围 -0.67..0.67
  cue #1..#8（thump，事件 bounce）pan ← cx 0.109 → -0.63 … cx 0.891 → 0.63
```
- 落地 thump 落地后 60 ms 的 R−L 能量：-10.0 / -6.7 / -4.0 / -1.2 / +1.7 / +4.5 / +7.3 / +9.7 dB（随球单调从左到右）
- 只渲 noise 层（`--cues` 单独一条）：速度 0.16 → 1.00 → 0.07 时 L 声道 -52.1 → -26.7 → -85.6 dBFS；t=3.0（cx=0.5）L/R 相差 0.2 dB
- 8 个 scrape 全部被 40 ms 去重丢掉（stack 不同），记进 `out/sfx.json` `dropped`；debug-marker 映射成 null 不出声
- 同一命令重跑 sfx.wav 逐字节相同
- 成片（render.mjs → mux.sh 无旁白）：`<scratchpad>/sfxdev/films/_sfx-demo/out/final-16x9.mp4`，2 声道，AAC 后 0.667 s 处 L/R +10.0 dB、5.333 s 处 -9.6 dB
- 报错路径：去掉 panWidth → 报错并列出 1 / 0.6 / 0 三种取值的代价；map 少写 scrape → 报"kind 没有映射：scrape"；有 send 没 room → 报错（不给默认房间）

产物：`<scratchpad>/sfxdev/films/_sfx-demo/out/sfx.wav`、`wind-only.wav`、`final-16x9.mp4`、`final-sfx-music.mp4`、`cues.scene.json`（`--emit`）。

没测：浏览器里 import `renderStereo` 做 WebAudio 预听（运行时不依赖 node:fs，按设计可用）；立体声素材文件（`file` 仍按单声道解码）；
`rate` 曲线变调只做了单元测试（`ratetest.mjs`：440 Hz 正弦、1 s 内 rate 1→2，过零计频 0–0.1 s 460 Hz、0.9–1.0 s 850 Hz，期望约 462 / 858），没进演示片。

## 没测到 / 没解决

1. volcano-audio 只真跑过一句（集成方，4.4s）；多句、`promptPrefix` 音效描述、参考音频/图片路径都没跑过。
2. **`ffmpeg/F F mpeg` 的读音没人听过**；conf 0.242。可能有更好的转写写法，需要人听着试。
3. **音色、闪避的听感未经人耳确认**——模型没有耳朵，这是结构性的。闪避的**深度**（9.8 dB）和响度三个数是机械量过的（第 13 节），
   不属于这一条；"压 9.8 dB 听着合不合适"属于。
4. edge / say 引擎本轮没跑（旧版跑通过；`--film` 改造只动了 main，引擎函数未改）。
5. `beats.py` 成功路径、`sfx.mjs` 的 `file` 和 `beat` 绑定没跑过。
6. `align.py --from`（反推模式）本轮没跑；`tts.py` 内的 Whisper 兜底同样没触发过。
7. `--film` 只能从含 `films/` 的目录或其子目录解析 slug；仓库外调用要 `FILMS_DIR` 或直接给目录路径。
8. `drawCaption` 只做单行居中；多行、竖排、逐字动效留给调用方（参见 film-typography skill）。
9. 字幕断行宽度用"汉字 1 / 拉丁 0.55"近似，不是真实字形测量；canvas 那条路要精确可自己 `measureText`。
10. pypinyin 已由集成方装进 `.venv`（0.55.0，写进 requirements.txt）；没装的环境里同音字按硬错误计（会误报「在/再」类）。
11. 外文词差异一律不计硬错误——TTS 真把 seek 念错时闸门不会拦，只靠「要人听」清单。
12. 共振峰法只对**韵母差异大**的读音对过了闸门（yuè/yào，F1 差 275 Hz）。只差声调（如 `帧/(zhen1)` 那类）、
    带鼻韵尾（háng/xíng 的那组直接测出不可能的 F1）的读音没有能过闸门的自动方法，仍要人听。每遇到一对新读音，先合成两组参照过闸门。
13. 拼音词典无效只在 seed-tts-2.0 + `zh_male_m191_uranus_bigtts` 上测过；别的音色、复刻音色（seed-icl-2.0）、只改声调的拼音条目都没测。
    文本转写也只测了 `密钥/密月` 一条。
14. 接口对格式错误的词典条目是报错还是静默忽略——仍没测（拼音条目格式正确时它也是静默无效）。
15. ~~demo-tls 的音频还念着 mì yào~~ → 第 14 节已修并闭环复核。仍没解决的：`--verify` 在 Whisper 照写原词时
    （修复前写出的就是「密钥」）分不出念的是哪个音，多音字的读音只能靠共振峰法或人耳，校验器拦不住。
    ~~`parts` 的 `--only` 复用路径只读过代码~~ → 第 18 节真跑过，平移正确。
16. 闪避只用正弦探针量了增益；真实配乐下的听感、`threshold=0.03 ratio=6` 对别的旁白电平（侧链吃的是归一化**之前**的旁白）是否合适，没测。
17. `mux.sh` 的 `--sfx` 路径修完截断后没有用真实音效重跑（逻辑同一处：旧版音效在旁白结束后同样会被截掉）。
18. 数字归一没覆盖：分数（三分之一 ↔ 1/3）、负数（零下五 ↔ -5）、符号单位（km、℃、m/s）——
    这些写法不同时仍按逐字/外文词判，会误报或进「要人听」。`3千米` 按读音归一成 3000 + 米，和 film-research 的事实对账（3 千米）语义不同，两边目的不同，没对齐。
19. 片头留白的**画面**那一环只有静态检查（拷进片子的 runtime 是否认 narrationOffset）和 film-critique 的 mark.sync（靠场景自报 MARKS）。
    场景**自己又加一遍**留白（和 narration.js 的平移叠成两遍）时，没有 MARKS 的片子没有机械手段能抓到。
20. ~~check_shotlist 还在用 shotlist 的 vo_offset~~ → 它已改读 film.json；`_film.py` 也不再要求 shotlist 抄一份（第 22 节）。
    仍然只是交叉检查：写了的 `vo_offset` / `pads.tail` 才比，`pads.tail` 只在 film.json 写了 `narrationTail` 时才比。
21. `--limit` 只在 ghost-jam 一支片的副本上跑过；alimiter 的 attack 5 ms / release 50 ms 对音效瞬态的听感没人听过。
22. 「事故→试过」（ghost-jam 单独转写 vo.wav，两个模型都这样）是 TTS 念得含糊还是 Whisper 听错，没人听过。
23. 字时间戳自检的 FAIL 0.20 s 两边余量都只有约 0.05 s（正常上界 0.15、真错下界 0.22），样本是一个账号、几个音色的 volcano-stream。
    别的音色、语速、英文为主的旁白没普查过。**意群内部**的挤压（不在停顿之后的字，如 weiqi-intro s4 末尾「它的气」每字 0.06 s）
    没有锚点可比，只靠「字在静音里」「字尾截短」两条警告。
24. ~~edge 引擎拿不到词边界~~ → 已修（第 25 节）。edge 词边界的普查只有 2 句，挤压没在 edge 上自然复现过（只做了人为挤压）。
25. 成片真峰门只覆盖**有旁白**的成片（accept 的 verify 门要 narration.json）；纯配乐片没有门查真峰——需求已交给集成方（check.mjs --mp4）。
    动态模式下的 TP 不可预测（第 24 节），ghost-jam 离 -1.0 只有 0.01 dB。
26. 片内改过的 `runtime/sfx.mjs` 不会自动拿到 skill 的运行时修复，也没有工具报「这份和 skill 版不一致」。
27. 语气指令的**情绪**效果没有过任何物理量的显著性检验（第 26 节全部 p ≥ 0.24）；它们可能改了音色质感、重音位置，这些指标都量不到，只能人听。
28. 指令响应强度只在两把嗓子上做了重复实验（云舟强、知性灿灿弱），目录里其余 96 个音色的响应度未知；第 27 节每格只合了 1 次。
29. 行内 `[#…]` 切段的接缝语调（像句子边界）没人听过；`section_id` 能不能缓和接缝没测（第 26 节里它在指标上测不出效果）。
30. `voice-catalog.json` 只测了 8 个 `ICL_uranus_*_tob`（官方 2.0 表里约 200 个）；授权状态是 2026-10-21 的。
31. 音色设计模型（SoundDesignAPI，2026-03）没接、没测。
32. 第 27 节的三种题材候选、得分、「前两名」全部**未经人耳确认**。


## 从 skill 文档移出的实测叙事（2026-10 瘦身）

skill 文档只留结论和可执行判据；下面是从 `skills/film-narration/` 各文件移出、且上文各节没有的叙事与样例，原样保留以备追溯。
`references/voice-catalog.md`（118 行的人读音色总表）已删除：它由 `voices.py --list-catalog --md` 从 `voice-catalog.json` 生成，随时可重出，数据只在 JSON 里一份。

### 音效设计（原 `references/sound-design.md`）

来源：onetake 的声音笔记（一组宣传片里被用户退回、再改对的记录，只读借鉴，转述）和本仓库 `films/tencent-5y/tools/audio.mjs`
（片内自写的立体声合成器：声像跟线头、音高跟价格、增益读速度）。sfx.mjs 的可选能力就是把后者收回套件的那部分（第 29 节）。

- **打点密度**：onetake 第一版几十个打字 tick + 十几个字母 tick + 一串彩纸 pop，听起来像老虎机，因此被退回。
- **去重窗口**：onetake 用 40 ms；落地的 thump + 钟声这类叠层靠同一个 `stack` 保留。
- **同质撞击 = "青蛙声"**：等间隔、几乎相同的撞击叠成周期信号（每秒 24 次 ≈ 24 Hz 脉冲串，加上样本自身的中频共振），耳朵听到「呱呱」的音高。
  onetake 的做法（一种做法，不是配方）：每次撞击换一组略失谐的声音；只保留跟得住的几下当重音，密处时间放松几毫秒；其余变成随机时刻的颗粒，电平跟"这一刻落下了多少"。
  警示量：> 1.5 kHz 包络在 20–80 ms 滞后上的自相关峰，onetake 的密段从 ~0.7 降到 ~0.1。
- **声像幅度**：onetake 和 tencent-5y 都取 `panWidth` 0.6。
- **连续声**：tencent-5y 的笔尖摩擦读速度；onetake 的镜头风声读缩放速度、按景深在三个频带间交叉淡化。
- **共享房间**：onetake 的经验是不相干的合成声各自干巴巴地贴在画面上，送进同一个房间后才像"一部片子"；按距离给送量（近的键盘 0.15，远处一口长气 0.6）。
- **按窗口找"糊"**：onetake 有一版整段 41.6% 的能量在 100–300 Hz，削掉最可疑的低频轰鸣没用；按 0.5 s 窗口算频带占比，
  才找到某个窗口里一串低八度的长尾音堆起来（那一窗 95% 低中频）。音高跑句放高一个八度、尾巴剪短后，那一窗降到 6%。
- **立体声 vs 单声道**：同一组 cue 强制立体声，合流前混音残差 -83.6 dB（16 bit 量化级），见第 29 节。

### 音色（原 `references/voices.md`）

- 停顿维度的例子：知性灿灿在逗号处自带长停顿，6.2 s 的句子里 1.2 s 是停顿；再加 `gapAfter`、`[停顿]` 会叠加。
- 指令响应度的例子：云舟「说快点」时长 −15%；知性灿灿同样指令只 ±3–5%（第 26 节）。
- 唐朝片（`films/tang-dynasty`）的选择记录（写法参考，不是推荐）：擎苍，基频中位 90.7 Hz 是 historical 组最沉的，语速 3.29 字/秒偏慢，
  官方定位古风（那一轮的语速口径未去首尾静音，和第 3 节的表不可直接比较）。
- 原 voices.md 里的五组 `--preset` 表与 `voices.py` 的 `PRESETS` 重复，改为指向 `voices.py --list-presets`。

### 火山接口（原 `references/volcano-api.md`）

- 音频生成 `seed-audio-1.0` 的官方文档里**没有**邀测/白名单字样；本账号 2026-10 真调通（第 2 节）。
- 外语 2.0 音色在官方音色列表里另有「推荐推理模式」一列：QA（指令遵循）或 Context（上下文遵循，部分仅限单向流）。本 skill 没测外语音色。
- 第三方文章里出现过的 `emotion` 写法对 2.0 音色无效；WebSocket 地址以官方表为准。
- 2.0 语气控制每一行的实测数（`[#…]` 写进 text：计费 29 → 46 字、时长 6.2 → 10.6 s、时间戳自检 6/6 失败；SSML `<break>`「色降临」挤在 0.18 s、计费 29 → 62 字；
  `pitch` +6 → 基频 218 → 316 Hz、−6 → 157 Hz；`emotion` n=2、`section_id` n=3 无差别）都在第 26 节。

### 改读音（原 `references/pronunciation.md`）

- 拼音写法：seed-tts-2.0 + 云舟，带/不带各 12 次读音分布无差（p=0.885），全部读 yào；强改非多音字也推不动（`密药/(mi4)(yue4)` 8/8 仍读 yào，`密月/(mi4)(yao4)` 8/8 仍读 yuè）。
- 文本转写 `密钥/密月`：12/12 读 yuè，F1 中位 385 Hz，与「密月」参照组无差（p=0.40）。
- SSML phoneme：12/12 仍读 yào；强改「药」8/8 仍读 yào；79 字 vs 17 字计费。
- 原 pronunciation.md 写的「银行 F1 测出 1100 Hz」即第 12 节「作废的一组」（F1_p80 732–1371 Hz，-ng 韵没过闸门）。

### 其他（原 SKILL.md、mix.md、verify.md）

- TTS 非确定：s3 同一句重合成 4.415 s → 3.605 s（第 1 节）。
- 字时间戳挤压的样例：weiqi-intro「上、下、左、右」挤在 0.1 s 内（第 21 节）。
- mix / verify 里删掉的样例数（demo-tls +6.4 dB vs 5.3 dB 余量、ghost-jam 副本 `--limit auto --lra 16` → linear、weiqi-intro `--lufs` 扫描、
  small vs turbo 的 96.7% / 98.9% 与 10.8 s vs 4.3 s、U+FE50 全片 11 处）全部已在第 13、15、16、19、24 节。

## 2026-11-12 分层音效接续验证

完成分层冲击、五种材质碰撞、掠过/落地/摩擦/蓄力/低频/高频闪烁/嗡鸣、种子变体、室内外IR、闷音与音乐压低，以及可选总线处理。接口和代价见 `sfx-recipes.md`，没有修改mux.sh。

- `node tests/fixtures/_test-sfx/tests/unit.mjs`：27项通过。扩展前8个旧音色（原7个加noise）的单声道、立体声、Freeverb固定SHA256基线逐样本相同；17配方/材质同种子相同、不同variant不同，峰值0.9、无NaN/过载。FFT卷积对朴素卷积误差小于1e-7。
- `node tests/fixtures/_test-sfx/tests/cli.mjs`：真实CLI help=0、未知参数=2、音色列表、ffmpeg音乐处理、全长duck恢复、统计均通过；`measure.py`的17配方频谱与瞬态检查通过。
- 真实 `sfx --film _test-sfx --stats`：5事件、5.50s、尾音1个，峰值-13.1dBFS（0.2218）、0过载/0NaN、DC0.000828、RMS-30.9dBFS。
- 修复IR尾音输出截断、连续触发默认首尾各挂一次尾音、长配乐duck停在sfx末点，以及负时刻包络年龄。没有启用新字段时旧PCM保持原样。

### 客观特征（能量加权频谱质心，48kHz/seed73/variant0，PCM16量化后）

|配方|秒|质心Hz|<200Hz%|>2500Hz%|峰时ms|
|---|---:|---:|---:|---:|---:|
|boom|3.0|374|74.2|2.5|40.94|
|clatter|0.55|5451|0.0|99.7|1.79|
|crack|0.32|2646|24.0|26.8|0.42|
|hum|2.0|167|66.4|0.0|89.42|
|impact-concrete|0.36|984|45.2|7.0|2.25|
|impact-glass|0.45|6750|0.0|99.9|0.42|
|impact-metal|0.5|1339|0.6|6.2|1.62|
|impact-water|0.5|2719|9.6|26.9|14.04|
|impact-wood|0.26|665|3.0|2.0|2.44|
|land|0.45|289|81.2|1.5|9.88|
|passby|0.3|4023|0.0|89.6|48.21|
|riser|2.0|3704|0.0|59.4|1876.71|
|rub|0.17|3477|0.0|60.6|96.0|
|shimmer|1.5|5477|0.0|84.0|160.17|
|step|0.3|747|54.7|5.1|2.52|
|sub|1.2|51|99.8|0.0|3.88|
|zing|0.75|2552|0.0|52.0|29.85|


这些量只验证频谱、包络、峰值与确定性；没有人耳验收，不能从频谱推出真实或悦耳，也没有完整影片验证。IR采用非分区FFT卷积，长素材有内存代价；不同JS引擎不承诺新配方最后一位相同。

## 2026-11-13 分层音效评审修复（NaN、变体种子、尾音契约、缓冲长度、卷积性能、去直流、浮点中间文件）

机器：4 核、Node 22.23.2，测时有别的会话并发（load 4–6），数字取交错跑两轮的范围。没有 ffmpeg、仓库根没有 `.venv`（见文末"没测到"）。

**改前复现**（改前运行时拷在 scratchpad，`probe.mjs`）：`crack/boom/sub` 的 `drive:0` → 15360/144000/57600 个 NaN、峰值 0，`sfx.mjs` 写成静音、退出 0；
8 发带 jitter 的 crack 只有 4 种 PCM（按变体取种子，每 4 发重复）；space 写成 `{preset,gain}` 与 `{gain,preset}` 交替时 `planTails` 分成两组、多挂一个尾音（[2,1] 而不是 [2]）；
boom 直流 0.00884、land 0.00488；metal 缓冲固定 0.5 s（ring 4 时在 −8 dB 处截断）、clatter 0.55 s（hits 8 时第 5 次以后被丢）。

**修法与实测**
- `softclip` / `renderRecipe`：drive 等正参数 ≤ 0、数字参数给了非数字直接报错；配方输出逐样本查有限性。`scripts/sfx.mjs` 写 WAV 前查 NaN/Inf，有就退出 1、不写、删掉同名旧文件（不再只靠 `--stats`）。
  CLI 用例：`gain: 1e39` → 退出 1，"有 1 个样本是 NaN/Inf"；`drive: 0` → 退出 1。
- 变体/抖动：有 `cue.id` 按 hash(配方, id)，没有按 (配方, 出现序号)。8 发 jitter → 8 种音高、8 种 PCM；有 id 时前面插一个同名事件，后三发 PCM 与 `_recipe` 逐位不变；40 个 id 用到了 step 的全部 4 个变体。
- 尾音：表里任一 cue 有 `tail` 就严格按它挂；都没有时 `spaceRule.burstGap` 必填（缺了报错写参考量级）。分组键改为规范化 space（键序无关）。
  事件表回归（`cli.mjs`，按 CONTRACT §5 的 snapToFrames → throttle → burstEnds → `toCues(…,{tails})`）：`out/sfx-events.json` `tailMode: explicit`，尾音只在 `shot:4`、`shot:7`，9 个 id 原样记录；表尾追加一发更早的枪后已有 9 发的变体/音高全部不变。
- 缓冲长度：metal/wood/glass/water 按 max(1, ring) 拉长；boom = max(3√size, 1.9·size+0.2, 1.6·size)；clatter 按 hits 上界。默认参数长度不变（boom 3.000 s、clatter 0.550 s、metal 0.500 s）；ring 4 → 2.0 s，hits 8 → 1.055 s，size 4 → 7.8 s。
- 去直流：非循环配方输出过 20 Hz 二阶巴特沃斯高通。默认参数 17 种配方/材质直流全部 ≤ 1.2e-4（boom 9.6e-7、sub 1.15e-4、land 5.2e-5）。旧 8 音色 3 组 PCM 基线（单声道、等功率声像、Freeverb）SHA256 不变。
- 采样率：`sfxdsp.mjs` 的 `SR` 是唯一来源，`sfx.mjs` 的 `RATE = SR`，CLI 发现不一致直接报错。
- 中间文件：`out/sfx.wav`、`music.out` 改写 32 位浮点 WAV（格式码 3 + fact 块），超过 ±1 不削顶。
- 默认值政策：`space.gain`、`muffle.recover`、`duck.recover`、`spaceRule.burstGap` 改为必填，报错写参考量级；`master.comp: true` 的默认值保留，sfx-recipes.md 写了代价。

**卷积性能**（`renderStereo` 计时，独立进程，`maxRSS`；场景同评审：300 cue / 120 s，每 3 个带 space（室内外交替），spaceRule 0.15；90 s hum + indoor）

| 场景 | 改前 | 改后 |
|---|---|---|
| 300 cue / 120 s，100 个尾音 | 15.1–18.5 s，RSS 222 MB | 5.0–5.6 s，RSS 195 MB |
| 90 s hum + indoor | 10.9–13.4 s，RSS 459–509 MB | 2.6–3.3 s，RSS 158 MB |

做法：同 IR、同总线的干声（已乘 space.gain）叠成一条，每组卷一次；分块重叠相加，M ≤ 2^18（实测 V8 上 2^19/2^20 每蝶形慢约 1.7 倍：2^18 一次 FFT 22.6 ms，2^20 171 ms），
全零块跳过，两块实数拼一次复数正变换，左右各一次逆变换，IR 频谱按 (IR, M) 缓存，旋转因子/位反转表缓存，直接叠进输出；同一张表里同参数配方只渲一次。
剖析（改后 300 cue，`--cpu-prof`）：剩下的时间大部分是 FFT，其余是闷音约 0.28 s、配方展开约 0.16 s。

**与改前的数值对照**（`equiv.mjs`：配方先用改前代码渲成 samples，两边喂同一份，只比混音器）：

| 用例 | max\|Δ\| | Δ/峰值 | SNR |
|---|---|---|---|
| 300 cue / 120 s（两种 IR、dry 总线、闷音、duck） | 4.77e-7 | 1.48e-7 | 147.6 dB |
| 90 s hum + indoor | 5.96e-8 | 7.1e-8 | 146.8 dB |
| 重叠尾音 / 负起点 / edges both / scale·bright·seed | 5.96e-8 | 8.6e-8 | 148.0 dB |
| 同上 + length 截断 + master | 5.96e-8 | 9.7e-8 | 147.3 dB |
| 不带 space 的同一张表 | 0（逐位相同） | | |

差异在 float32 舍入量级（尾音从"逐 cue 卷积再相加"变成"相加再卷积"，求和顺序不同）。

**回归**：`unit.mjs` 38 项（新增：50 个 配方×材质×变体 PCM 钉死在 `recipe-pcm.json`；两个子进程与本进程综合混音 SHA256 相同；分块卷积对整段卷积相对误差 < 1e-6；
阴性 drive 0 / jitter 重复 / 键序分组 / 缓冲截断）。`cli.mjs` 4 组：事件表 cues、插入稳定、非有限数退出 1、配乐 duck 全长恢复（浮点 WAV 读回，误差 < 1e-5）。

**没测到**：本机没有 ffmpeg——配乐 duck 段只用一个本地极简替身（16 位/浮点 WAV → f32le）跑通，真 ffmpeg 读 32 位浮点 WAV 和 `mux.sh` 合流没在这台机器上跑；
`cli.mjs` 在没有 ffmpeg 时会在配乐段红并写明原因。仓库根没有 `.venv`，`measure.py`（新加了直流 < 1e-3 断言）没跑，`dev/test.mjs` 遇到没有 .venv 时跳过并说明。
20 Hz 高通让 boom（27 Hz 底）和 sub（30 Hz 底）最低频约弱 0.8–1.3 dB，没有人耳对比。

## 2026-11-14 雨声床配方 `rain`、mux 浮点中间文件、.venv 下的旁白测试

**来由**：雨夜样片（films/forge，不入库）想要雨声，`RECIPES` 里全是冲击/瞬态，没有连续环境床，只好不放。

**`rain` 的做法**（`sfxdsp.mjs` `rainBed`）：两路独立白噪声按 `width` 混 → 300 Hz 高通 + 5.2 kHz·bright 低通 → 1.3 s 一节点的余弦插值阵风（±25 %，左右共用），
电平 `0.05·wash·√(density/100)`（远处雨滴的叠加按 √N 长）；每滴：起点均匀、大小 u^2.5（小滴多）、带通噪声激励（fc 1.8–6.5 kHz × bright × 大小 × 硬度，Q = 0.6 + 5·hard²），
hard > 0 时 fc 处加 0.35·hard² 的衰减正弦振铃（τ 1.5–11.5 ms，截在 5τ），`pool` 比例的滴后接 Minnaert 式上扬啁啾；按落点等功率声像；distance > 0 再整体低通（1 ≈ 1.9 kHz）。
20 Hz 去直流后左右各自 `loopXfade`（0.5 s 交叉），两路**一起**峰值归一到 0.9（保住左右电平差）。`density`、`hard` 没有默认值（`rain` 不写它们直接报错并给参考量级）。

**立体声怎么接进管线**：配方声明 `stereo: true` 时 `render` 返回 `[L, R]`，`renderRecipe` 多返回 `samplesR`，`expandRecipes` 透传；
`renderStereo` 左右各读各的（插值、cue.lowpass、dur 循环都两路同做），pan 当平衡用同一对等功率增益——pan 0 时每路 ×0.707，与单声道 cue 在立体声路径、
以及 mux 把单声道 sfx.wav 升成立体声时的 −3.01 dB 一致；尾音总线与 Freeverb 送 (L+R)/2。`renderCues`（单声道路径）取 (L+R)/√2（去相关时功率守恒）。
`scripts/sfx.mjs` 遇到立体声配方自动走立体声路径。没有 `samplesR` 的 cue 走原代码，旧音色/声像/Freeverb 三个 PCM 基线和 50 个旧配方钉子逐位不变。

**实测**（density 300、hard 0.5、dur 10，`rain-test.wav`）：峰值 0.900（−0.92 dBFS），RMS −18.4 dBFS（crest 17.5 dB），频谱质心 3600 Hz，<200 Hz 0.13 %，>2.5 kHz 61.7 %，
左右相关 0.119，0.25 s 分窗 RMS 变异系数 0.093（没有空洞），直流 2.8e-8。分层：同参数 wash 0 时 crest 23.5 dB，即噪声底比雨滴层高约 4 dB。
RMS 随参数（6 s）：hard 0/0.5/1 × density 30/300/2000 = −22.0/−15.6/−14.4、−23.6/−18.3/−14.6、−24.2/−18.7/−16.0 dBFS——峰值归一按最大一滴，响度随密度变，用 cue.gain 定。
**耗时**（机器 load ≈ 13，同时在跑整套回归，数字偏大）：10 s/300 滴 0.84 s；60 s/300 滴 2.1 s；60 s/2000 滴 hard 1 6.6 s（振铃截 7τ 时 8.1 s）、hard 0 + pool 0.5 5.0 s；maxRSS 约 132 MB。
逐样本 `r()` 换成每滴一个种子的内联 LCG、气泡与振铃改相量递推后，同一负载下 60 s/2000 滴从约 16 s 降到上面的数。

**回归**：`unit.mjs` 42 项（新增 rain 必填/范围报错、width 1 相关 < 0.3、width 0 左右逐位相同、循环接缝跳变 ≤ 相邻差 99.9 分位、renderStereo dur 循环两路各读各的、单声道 (L+R)/√2；
`recipe-pcm.json` 加 rain v0–v2，钉子哈希左右两路）；`cli.mjs` 5 组（新增：只写 params 的 rain cue 输出 2 声道且左右不同，缺 hard 退出 1）；
`measure.py` 18 种（rain：|相关| < 0.3、分窗 CV < 0.35、<200 Hz < 5 %、质心 1.5–6 kHz）。

**mux.sh 中间文件**：`mix.wav` / `mix_lim.wav` / `norm.wav` 从 pcm_s24le（norm 原为默认 s16）改为 pcm_f32le。合成输入（3 s 黑场 + 浮点 sfx.wav，无旁白）新旧对照：

| 输入 | 旧 mix.wav | 旧结果 | 新 mix.wav | 新结果 |
|---|---|---|---|---|
| 0.25 正弦 + 峰值 2.0 的点击（+5.9 dBFS） | 峰 0.0 dB，flat factor 18.7（削成平顶） | 混音前 TP 0.24（已削）、成片 −1.00 dBTP | 峰 +5.94 dB，flat factor 0 | 混音前 TP +5.94、成片 −1.50 dBTP |
| 满幅 ×2 正弦（整体 +5.95 LUFS） | 削成方波 | **loudnorm 第二遍失败，退出 1** | 原样 | 先浮点线性降 15.95 dB 再归一，成片 −12.73 dBTP |

第二行暴露的另一处：loudnorm 的 `measured_I` 只收 ≤ 0，整体 > 0 LUFS 的混音（旧版削顶后也有约 +3 LUFS）第二遍直接报错；现在整体 > −1 LUFS 时先在浮点里降到 −10 LUFS 再测（输出打印一行说明）。
其他情况滤镜图与参数不变。3 s 的输入 loudnorm 都退回动态模式（它对 < 3 s 的输入不做线性），所以没测到线性模式下的 > 0 dBFS 输入。

**没测到**：雨声像不像、阵风起伏是否自然、气泡啁啾的比例，都没经过人耳；没在 films/forge 上实际合流（不改那支片）。rain 只有一个连续床，没有风声（`wind`）配方。
