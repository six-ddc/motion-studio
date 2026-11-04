# 症状 → 该改哪个文件

评审指出"哪一秒、什么问题"之后，下一步是找到**产生这个问题的那份产物**。在下游修（在 scene.html 里硬凑）常常能让这次检查变绿，
但上游那份文件仍然是错的，下次改动或重新合成旁白时，问题会原样回来。用法：先按症状找到对应行，再用"先查"列确认成因（一个症状常有几种成因，按越上游越先排除的顺序排列），
然后回到"改哪里"列指出的那一层修改，再往下游重跑。这张表只说明问题归属，不是审美判据：是不是问题，仍然只看本片的 `docs/style_guide.md`（SKILL.md 第三节）。

| # | 症状 | 先查（判据 / 证据） | 改哪里 | 归哪个 skill |
|---|---|---|---|---|
| 1 | 旁白和画面对不上（说 A 时画着 B） | `claims.*` 是否 FAIL；`mark.sync`；T5 | 旁白断言写错了，改 `docs/shotlist.md` 的 `claims`/`curves`；画面没有按曲线走，改 `scene.html`；旁白本身只是在"介绍"、画面只能配图，改 `docs/mechanism.md` 的旁白草稿和 `script.json` | film-story / film-motion / film-narration |
| 2 | 整体错位一个常数（全片都早或晚一点） | `claims.offset` / `claims.end`；`duration.*` | `film.json` 的 `narrationOffset` / `narrationTail`（偏移量只以这里为准，shotlist 不另存） | film-narration |
| 3 | 某个词上的事件时刻不对（对到了别的词上） | `mark.sync`；`align.py --verify` 退出码 6（字级时间戳错拍） | 锚点写错了，改 `docs/shotlist.md`（`s3@词`）或 `cues.json` 的 `at`；时间戳本身错了，重新合成 `narration.json`（`tts.py --only`） | film-story / film-narration |
| 4 | 重要事件一闪而过 | `mark.length`；shotlist `segments` 的权重与屏幕时长是否相称；T4 | 自变量按物理单位线性映射到秒时，在 `docs/shotlist.md` 里给它单独的旁白锚点区间或 `floor`；旁白里根本没给它一句话时，改 `script.json` | film-story / film-narration |
| 5 | 关键事件根本没画出来 / 旁白在说而画面已空 | `mark.visible`；`empty.vo`；`claims.pixels` / `claims.anchor` FAIL 而 `claims.scene` 通过 | `scene.html`（probe 算对了但没画出来，或者锚点没有登记） | film-motion / film-physics / film-webfx |
| 6 | 像模板 / 又是格子 / 和上一支长得一样 | `siblings.mjs` 生成的 `out/siblings.png`；T1/T2；刀 1 换题测试 | 机制只是通用容器时，回到 `docs/mechanism.md` 重新发散；长相和近作撞脸时，改 `docs/style_guide.md` 的视觉方向与近作对照。这类问题不是在 scene.html 里换个缓动就能修好的 | film-story |
| 7 | 画面在"配图"，没有证据（看完说不出机制） | shotlist 镜头功能统计里几乎没有证据类镜头；刀 3 旁白同构 | `docs/shotlist.md` 的 `does`/`role`；根源在于 `docs/mechanism.md` 的核心变量没有对应到视觉变量 | film-story |
| 8 | 数字不对 | `facts.screen` FAIL；`factcheck.mjs --also out/critique/onscreen.txt` | 事实本身错误或没有出处，改 `docs/facts.md`；facts 正确但旁白念错，改 `script.json`；画面文字错误，改 `scene.html`；数字只是序号而非事实，在 style_guide critique 块里写 `facts_single` / `facts_ignore` | film-story / film-narration / film-motion |
| 9 | 字太小、看不清 | `readability.size`（按文种和字重分档）、`readability.contrast` | 字号、字重、底色在 `scene.html` 里改；本片有理由使用不同阈值（横屏全屏观看）时，改 style_guide critique 块的 `view_width` / `min_text_src_px`；字体回退问题查 `font_source.mjs` 与 `assets/` | film-typography / film-assets |
| 10 | 字幕或文字没读完就消失了 | `readability.time` | 显示时长在 `scene.html` 里改；句子太长时，在 `script.json` 里拆句后重新合成 | film-typography / film-narration |
| 11 | 节奏像节拍器（镜头一样长、每 N 秒换一次） | `rhythm.cv`（可选疑点）；T3 | 镜头按句子切而不是按机制阶段切，改 `docs/shotlist.md` 的 `shots`；旁白句长全都一样，改 `script.json` | film-story / film-narration |
| 12 | 平台期 / 死拍（画面长时间不动） | `still` / `law.max_still`；`rhythm.still` | 如果是有意留白，写进 `docs/style_guide.md`（`max_still`），让它从疑点变成法律；如果不是，查 `docs/shotlist.md` 那一镜的 `mech` 是否没有状态变化，再改 `scene.html` | film-story / film-motion |
| 13 | 衔接断开（切点两边像两支片子） | `continuity`（可选疑点）；镜头的 `carry` | 交接没有设计，改 `docs/shotlist.md` 的 `handoff`/`carry`；设计了但没实现（切点两侧没有画同一个物体、没有登记同名锚点），改 `scene.html` | film-story / film-motion |
| 14 | 中间态怪 / 关键帧都对但半路难看 | `*-strip.png`；T6 | `scene.html`（插值、缓动）；中间态本该是关键画面却没写，在 `docs/shotlist.md` 的 `keyframes` 里补一个半路帧 | film-motion |
| 15 | 读成了别的东西（像脸、像齿轮） | 静帧 / `*-phone.png`；T7/T8（靠人眼） | 目标没写，补 `docs/shotlist.md` 关键帧的剪影描述与形似风险；写了但没照做，改 `scene.html` 的参数 | film-story / film-webfx / film-physics |
| 16 | 色彩超出本片色板 | `law.palette` | `scene.html`；色板本身要变时，改 `docs/style_guide.md` 的 critique 块 | film-motion |
| 17 | 音效闷、乱或互相撞车 | 人耳；`out/sfx.json`；`mp4.truepeak` | 事件太密或撞车，改 `cues.json`（`dedupe`、删 cue）；音色问题改片子自己的 `runtime/sfx.mjs`；房间感和声像改 `cues.json` 的 `room`/`pan`；削波在 `mux.sh` 混音时处理 | film-narration（`references/sound-design.md`） |
| 18 | 念错字 / 成片音轨接错 | `align.py --verify` 退出码 1 / 3 | 念错字时改 `script.json`（改写或标注那一句）后运行 `tts.py --only`；接错文件时改 `mux.sh` 的输入 | film-narration |
| 19 | 成片时长、帧率、音画流长度对不上 | `duration.*`、`mp4.fps` / `mp4.duration` / `mp4.av` | `film.json`（fps、时长）、`DURATION` 与 `narration.json` 三者对账；渲染参数问题查 `render.mjs` 的调用 | film-narration / film-core |
| 20 | 两次渲染不一样 / 乱序取帧结果不同 | `seamcheck.mjs`（含 `--relaunch`）；`probe.pure` / `anchors.pure` | `scene.html` 里的墙钟、`Math.random`、跨帧状态、未关闭的第三方 rAF（违反 film-core 内核契约）。先修这一条，否则其他所有观察都无法复现 | film-core |
| 21 | 循环接缝跳 | `loop` | `scene.html`（frame(D) 与 frame(0)）；是否要求循环在 `film.json` 或 critique 块的 `loop` 里声明 | film-motion |
| 22 | 该查的没查 / 不该查的在报 | `accept.mjs --list --verbose` | 改 `film.json` 的 `checks` 声明（id 见 `checks.md` 第 0 节），而不是改检查脚本 | film-core |
| 23 | 片子讲的不是想要的内容（受众、时长、必须出现的东西错了） | 对照 `docs/brief.md` | 改 `docs/brief.md`，然后从调研开始往下全部重做。这一层错了，下游每个文件都在忠实地执行一个错误的目标 | film-story |

## 怎么用这张表

- **先排除上游。** 同样是"对不上"，如果是 `claims` 写错了，改 scene.html 只是让画面去迎合一个错误的断言。
  所以排查顺序始终是 brief → facts.md → mechanism.md → script.json / narration.json → shotlist.md / style_guide.md → scene.html / cues.json。
- **改完后从那一层往下重跑。** 改了 script.json 就要重新合成，narration.json 随之变化，接着 check_shotlist 重新对账，check.mjs 重新测量；
  只改了 scene.html，就只重渲改动的那几秒（film-core `render.mjs --from --to`）。
- **在 review_log 里记录。** "改了什么"一栏要写文件名，不能只写现象，这样下一轮的人才知道问题是在哪一层修掉的。表里没有列出的症状，按同一个问题去找：**哪份文件里写着导致它的那个决定？**
