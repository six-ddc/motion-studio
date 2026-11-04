# schemas：script.json / narration.json / cues.json / beats.json / music.json

目录：script.json（必填 / 通用可选 / 语气与停顿控制 / volcano-stream 专有 / volcano-audio 专有 / edge·say 专有）·
film.json 里的留白字段 · narration.json（含两个火山引擎的 token 差异）· cues.json · out/beats.json · out/music.json

这份文档供其他 skill 查阅。场景只读 `narration.json`（通过 `runtime/narration.js`），不读 `script.json`。

## script.json（输入，`films/<slug>/script.json`）

顶层字段就是默认值，`lines[]` 里的同名字段可以逐句覆盖（例如某一句单独换语速或换音色）。
字段名用 camelCase，由 `tts.py` 负责翻译成火山接口要求的 snake_case。

### 必填

| 字段 | 类型 | 说明 |
|---|---|---|
| `lines` | array | 旁白句子，数组顺序就是播放顺序 |
| `lines[].id` | string | 句子 id，全片唯一，**镜头按它引用**（`vo.line('s2')`）。不写时自动编号为 `L1..Ln`，但分镜要稳定引用就必须写 |
| `lines[].text` | string | 要念的文字。标点会影响停顿和字幕断行 |
| `speaker` | string | 音色 ID（volcano-*）。**按内容选择**，流程见 SKILL.md 第二节 |

### 通用可选

| 字段 | 默认 | 说明 |
|---|---|---|
| `engine` | `volcano-stream` | 可选 `volcano-stream` / `volcano-audio` / `edge` / `say`；命令行 `--engine` 可以临时覆盖 |
| `gap` | `0.35` | 句间静音的秒数。成片时间轴包含这段静音 |
| `format` | `mp3` | 接口返回的音频格式；最终统一转成 48k 单声道 WAV |
| `sampleRate` | `44100` | 接口采样率 |
| `speechRate` | `0` | 语速，取值 -50..100（volcano） |
| `loudnessRate` | `0` | 音量，取值 -50..100（volcano） |
| `_注释` | — | 自由格式的对象，**不发给接口**。约定的键有：`音色`（选择理由和指标）、`pronunciationDict`（为什么这样读）、`speechRate`、`事实核对` |
| `lines[].timingWaive` | — | 字符串。当这一句的字级时间戳与能量包络的自检（`_timing.py`）报错，而**人已经听过**、确认是误报时，在这里写明理由。该句的失败会降为警告，理由随结果一起打印（`tts.py` 和 `align.py --verify` 都识别这个字段）。不发给接口 |
| `lines[].gapAfter` | 顶层 `gap` | 这一句之后的静音秒数（≥ 0），覆盖 `gap`。在本地拼接，结果确定；写了这个字段的句子会在 narration.json 里记录 `gapAfter` |

### 语气与停顿控制（逐句 + 全片默认）

顶层字段是全片默认值，`lines[]` 里的同名字段逐句覆盖（写 `"instruction": null` 或 `""` 表示这一句不用指令）。生效强度因音色而异，见 `volcano-api.md`。

| 字段 / 写法 | 发给接口的形式 | 作用范围 | 说明 |
|---|---|---|---|
| `instruction` | `additions.context_texts: [instruction]` | 整句（或句中一段，见下） | 自然语言的语气指令，例如「你可以说慢一点吗？」「像老师给初学者讲解，耐心、亲切」。**不计费**。只有 volcano-stream 支持，其他引擎会警告并忽略。和 `contextTexts` 同时给出会报错（接口只认 context_texts 的第一个值）。代价是换音色后要重新听 |
| `speechRate` | `audio_params.speech_rate` | 整句 | 已有字段，逐句写就能让语速有起伏；句间速度跳变是否自然要人听 |
| `pitch` | `additions.post_process.pitch` | 整句 | 单位为半音，范围 [-12, 12]，属于后处理变调（实测很精确）；变调幅度大时音色会失真 |
| `contextTexts` | `additions.context_texts` | 整句 | 原样透传；列表里**只有第一条生效**（实测），多给会警告 |
| 台词里写 `[#<指令>]` | 在本地解析成这一段的 `context_texts` | 从标记处到下一个 `[#…]` 或句末 | 只在句首出现一个时，等同于这一句的 `instruction`（只发一次请求）；出现在句中时，这一句会切段合成 |
| 台词里写 `[#]` | — | — | 回到这一句的默认 `instruction` |
| 台词里写 `[停顿 0.6]` / `[停顿 600ms]` / `[pause 0.6s]` | 在本地插入静音 | 标记处 | 取值 0 < x ≤ 10 秒，叠加在接口自带的段首、段尾静音之上。会让这一句切段合成 |
| 台词里写 `[@<id>]…[@/<id>]` | 不发送（零宽） | 两个标记之间的字 | 语义区间：不切段，不改变请求体和时间戳，只在 narration.json 里写入 `spans.<id>`。id 可用字母、数字、汉字和 `_.-`，全片唯一；区间可以嵌套、相邻、交叉，但不能跨句；区间里至少要有一个要念的字 |
| 全角 `【…】` | 同上 | | 和 `[…]` 等价 |

**行内标记的硬约束**（`scripts/_markup.py`）：标记只在本地解析，`tts.py` 发给接口的是去掉标记后的文本，因为实测接口会把 `[#…]`、`（…）`、`<cot>` 原样念出来。
去掉标记后的文本，才是 narration.json 里的 `text`，也是字幕、`vo.at()` 和 `align.py --verify` 比对的对象；字级时间戳只覆盖要念的字。
方括号里的内容不属于上面三种写法时会报错（写错一个标记，就会多念出一句错音）。台词里确实需要出现方括号字符时，没有转义写法，只能改用别的符号。

切段的代价：每一段独立合成，接缝处的语调听起来像句子边界；每多一段就多一次请求（计费字数不变）。如果只是想停得久一点，用标点（「，」<「——」<「……」）不会切段，代价是字幕也会跟着变。
其他 skill 读取 script.json 的 `text` 时（film-story 的 factcheck、字体子集化）拿到的是带标记的原文，这个问题目前还没有解决。

### volcano-stream 专有

| 字段 | 接口字段 | 说明 |
|---|---|---|
| `resourceId` | header `X-Api-Resource-Id` | 默认 `seed-tts-2.0`；复刻音色用 `seed-icl-2.0` |
| `model` | `req_params.model` | 只有复刻音色需要 |
| `pronunciationDict` | `additions.pronunciation_dict` | 例如 `{"tone": ["密钥/密月", "ffmpeg/F F mpeg"]}`。文本转写可以改读音（会改变 token，tts.py 自动还原并记录 `alias`）；拼音写法 `原词/(pin1)(yin1)` 改不了读音，tts.py 会给出警告 |
| `ssml` | `req_params.ssml` | 给了就不再读 `text` |
| `explicitLanguage` | `additions.explicit_language` | 指定语种；非中英文时接口不返回时间戳，自动改用 Whisper |
| `explicitDialect` | `additions.explicit_dialect` | 方言 |
| `silenceDuration` | `additions.silence_duration` | 句尾静音（ms） |
| `filterParenthesis` | `additions.max_length_to_filter_parenthesis` | 过滤括号内的注释 |
| `disableMarkdownFilter` / `disableEmojiFilter` / `latexParser` | 同名的 snake_case 字段 | 文本过滤开关 |
| `autoLanguage` | `additions.enable_auto_language_recognition` | 自动识别语种 |
| `contextTexts` / `instruction` / `pitch` | 见上一节 | 语音指令或引用上文，只有第一条生效 |
| `toneFidelity` / `aigcWatermark` / `bitRate` | 对应字段 | 见 `volcano-api.md` |

### volcano-audio 专有

专有字段有 `audioModel`（默认 `seed-audio-1.0`）、`promptPrefix`（拼在 `text` 前面的自然语言描述，可写音效、说话人、时间轴）、`pitchRate`（音高）、`watermark`（水印）。
参考来源 `speaker` / `audioData` / `audioUrl` / `imageData` / `imageUrl` **五个里只能给一个**，多给会报错。不支持 `pronunciationDict` / `ssml` / `explicitLanguage` / `explicitDialect`，给了会警告并忽略。

### edge / say 专有

edge 引擎用 `voice`（如 `zh-CN-YunyangNeural`，可用 `tts.py --list-edge-voices zh` 列出）和 `rate` / `pitch`（写法为 `"+0%"` / `"+0Hz"`）；macOS say 用 `sayVoice` / `sayRate`。

## film.json 里本 skill 读的两个字段 —— 片头 / 片尾留白的唯一真相源

| 字段 | 类型 | 说明 |
|---|---|---|
| `narrationOffset` | number ≥ 0，缺省为 0 | 旁白音频的第 0 秒对应成片的第几秒（片头留白）。**成片时间 = 旁白时间 + narrationOffset** |
| `narrationTail` | number ≥ 0，缺省为 0 | 旁白念完之后的片尾留白。`vo.filmDuration = narrationOffset + duration + narrationTail` |

这两个字段放在 film.json 而不是 narration.json，是因为 narration.json 每次跑 `tts.py` / `align.py --from` 都会整份重写，而修改留白不应该触发重新合成。留白偏移只在 film.json 这一处写，其他地方不另存。各方读取方式如下：

| 读取方 | 做什么 |
|---|---|
| `runtime/narration.js` 的 `loadNarration()` | 读取 film.json，把**所有时刻平移成成片时间**；提供 `vo.offset`、`vo.tail`、`vo.duration`（= 偏移 + 旁白长度）和 `vo.filmDuration` |
| `scripts/sfx.mjs` | 用 `at` 绑定的 cue 加上偏移；`out/sfx.wav` 使用成片时间；所用的偏移记进 `out/sfx.json` |
| `scripts/subs.py` | 字幕时间加上偏移（`--offset 0` 用于单独给 vo.wav 配字幕） |
| `scripts/mux.sh` | 用 `adelay` 给旁白加偏移；合流前先跑 `_offset.py` 检查整条链路，任何一环对不上就拒绝合流 |
| `scripts/align.py --verify` | 转写成片时，按旁白时间加偏移计算漂移；转写 `out/vo.wav` 时偏移为 0；链路对不上时退出码为 4 |
| film-critique 的 `check.mjs` | 用 `vo.at()` + `narrationOffset` 对照 `window.MARKS`（画面层的对点） |
| film-story 的 `check_shotlist.py` | 读取 film.json 的这两个字段来解析 `start` / `vo.end` / `end` 锚点。shotlist **不需要**另写 `vo_offset`；如果写了，`mux.sh` 和 `--verify` 会核对 `pads[vo_offset]`（或数字形式的 `vo_offset`）/ `pads.tail` 是否与这里一致，只有**写了且不一致**时才报错，没写就不比较 |

在 Node 里，`makeNarration(data)` / `findKeyword(data, kw)` 默认 `offset = 0`（即旁白时间）；要得到成片时间需要传入 `{ offset }`。

## narration.json（产出，`films/<slug>/narration.json`）—— 画面的唯一真相源

文件里所有时刻都是**旁白音频内的绝对秒数**（从 `out/vo.wav` 的第 0 个采样起算），已包含句间 `gap`，**不包含**片头留白
（留白在 film.json 的 `narrationOffset` 里，见上节）。通过 `loadNarration()` 读进场景后，才换算成成片时间。

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | int | schema 版本，当前为 1 |
| `audio` | string | 完整旁白音频，路径相对于片子目录（`out/vo.wav`） |
| `engine` | string | 生成它的引擎；从录音反推时为 `whisper-<model>` |
| `voice` | string | 音色 ID |
| `script_hash` | string | 生成时 script.json 关键字段的 sha1 前 12 位；对不上说明脚本改了但没重跑。台词里的区间标记 `[@id]` 不计入（因为不影响声音） |
| `duration` | number | 旁白总长，等于最后一句的 `end`。场景的 `window.DURATION` 取 `vo.filmDuration`（已加上 film.json 的留白） |
| `gap` | number | 句间静音 |
| `lines[]` | array | 每句一条 |
| `lines[].id` / `.text` | string | 与 script.json 相同，但 `text` 是**去掉行内标记后**要念的字 |
| `lines[].instruction` | string \| array? | 只在用了语气指令时写：整句只有一条指令时是字符串；切段且各段指令不同时是逐段的列表 |
| `lines[].segments[]` | array? | 只在这一句被行内标记切段时写：每段为 `{start, end, instruction}`（绝对秒）。插入的静音位于段与段之间 |
| `lines[].gapAfter` | number? | 只在这一句之后的静音不等于 `gap` 时写 |
| `lines[].start` / `.end` / `.duration` | number | 该句在总时间轴上的区间，`duration` 由 ffprobe 实测得到 |
| `lines[].words[]` | array | 该句的字级时间戳（格式同下） |
| `lines[].wav` | string | 单句音频，`out/vo/<id>.wav` |
| `words[]` | array | 全片的字级时间戳，按时间排序（等于各句 words 依次拼接） |
| `spans` | object? | 只在台词里写了 `[@id]…[@/id]` 时出现，格式为 `{id: {start, end, line, text}}`。start/end 分别是区间首字的 start 和末字的 end（绝对秒），`text` 是区间内要念的字。`vo.span(id)` 读取它（会加上 offset）。可用 `tts.py --spans` 离线重新计算 |
| `words[].w` | string | 一个 token。中文通常一个字一个 token，英文一个词一个 token。**标点归到哪个 token 因引擎而异**（见下表） |
| `words[].start` / `.end` | number | 绝对秒 |
| `words[].conf` | number? | 置信度 0..1，只有 volcano-stream 提供；低于 0.4 要人听 |
| `words[].alias` | string? | 发音词典的文本转写被还原时，记录接口原始返回的 token（如 `F F mpeg，`） |
| `words[].parts` | array? | 同上情形下，每个原始 token 的 `{w, start, end}`（绝对秒）。`vo.at()` 不用它；需要单独分析转写词里某个字的音频时才用 |
| `words[].src` | string? | 值为 `whisper` 表示这一条是 Whisper 反推得到的，精度低一档 |

### 两个火山引擎产出的 token 差异

| | volcano-stream | volcano-audio |
|---|---|---|
| 标点 | 粘在前一个字上，带时长：`数。` 2.935–3.215 | **独立成一个 token，宽度为零**：`，` 的 start == end（2.16–2.16） |
| `conf` | 有 | 无 |
| 接口原始单位 | 秒 | 毫秒（tts.py 已换算成秒） |

所以**不能假设 `w.end > w.start`**：按词宽计算进度、停顿或 `\kf` 时长的代码必须能处理零宽 token。本 skill 已经处理好：`activeWord` / `captionAt` 不会选中零宽 token（不会出现除以零）；
`subs.py` 把零宽标点并入前一个 `\kf` 段；`at()` / `findKeyword()` 在去掉标点的字符流上查找，两种标点归属方式得到的结果一致。

真实片段（`tests/fixtures/_test-narration/narration.json`）：

```json
{"w": "seek，", "start": 4.663, "end": 5.053, "conf": 0.915}
{"w": "ffmpeg，", "start": 8.569, "end": 9.229, "conf": 0.242, "alias": "F F mpeg，"}
```

## cues.json（输入，`films/<slug>/cues.json`）—— 音效事件

文件是一个数组，每项字段如下：

| 字段 | 说明 |
|---|---|
| `t` / `at` / `beat` | 三者选一个，全部是**成片时间**。`t` 是成片秒数；`at` 是旁白关键词（可配 `nth`，自动加上 `narrationOffset`）；`beat` 是节拍序号（可配 `grid: "beats" \| "downbeats" \| "hits" \| "sections"`，默认 beats。依次读取 `out/beats.json`、`out/music.json`、片子根目录的 `music.json`，用第一个存在的；`sections` 只有 music.json 提供；其他 grid 值会报错） |
| `offset` | 秒，可以为负 |
| `type` | 合成音色名，在运行时 `sfx.mjs` 的 `SOUNDS` 中查找（片内的 `runtime/sfx.mjs` 优先，没有则用套件自带的）。skill 自带 `click pop thump whoosh tick chime sweep`；要在片内加音色，就把套件那份拷到 `runtime/sfx.mjs`，然后在 `SOUNDS` 里加一条 `名字: [时长秒, (t, rnd) => 样本]` |
| `file` | 素材路径（相对于片子目录），与 `type` 二选一；用 ffmpeg 解码，支持任何格式 |
| `gain` | 线性增益，默认 1 |
| `seed` | 噪声类音色的种子，默认取 cue 的序号 |

**可选字段**（只要出现任意一个，就走立体声路径 `renderStereo`，输出 2 声道；一个都不写时走原来的单声道路径，输出逐样本不变）：

| 字段 | 说明 |
|---|---|
| `pan` | 取值 -1（左）..1（右），默认 0。采用等功率声像：`pan = 0` 时每个声道乘 0.7071，与 `mux.sh` 把单声道上混成立体声时的 -3.01 dB 相同，所以在成片里响度一致 |
| `anchor` | 锚点名：声像取场景 `window.anchors(t).items[名].cx`，按 `pan = panWidth·(2·cx − 1)` 计算。与 `pan` 二选一；该帧没有登记这个锚点时报错 |
| `follow` | 与 `anchor` 一起用：在整个 cue 期间按 film.json 的 `fps` 采样锚点，声像跟着移动（中途某帧没有登记时，沿用上一次的位置） |
| `panWidth` | 声像幅度，可以写在 cue 上，也可以写在顶层配置里。**没有默认值**，用 `anchor` 时必须写 |
| `send` | 送进共享房间混响的比例，默认 0。只要有一个 cue 的 `send > 0`，顶层就必须写 `room` |
| `rate` | 播放速率，等于音高倍数（变速同时变调） |
| `lowpass` | 一阶低通的截止频率，单位 Hz |
| `dur` | 连续层：在这段时长内循环播放音色或素材。`rate` 读取曲线时必须写 |
| `stack` | 去重时的叠层组名：同一个 `stack` 的 cue 之间不算冲突 |

`gain` / `pan` / `send` / `rate` / `lowpass` 可以写成**参数式**：
`{ "probe": "曲线名", "scale": 1, "add": 0, "pow": 1, "min": -∞, "max": ∞ }`，
表示在 cue 期间按 `curveRate` 采样 `window.probe(t)[曲线名]`，再按 `y = clamp(add + scale·sign(x)|x|^pow)` 映射；采样到非有限数时报错。
`{ "v": true, … }` 使用同样的映射，但 x 取场景事件的 `v`（只在 `fromScene` 模板里有意义）。

**对象写法**：`cues.json` 也可以写成 `{ "cues": [...], 配置 }`（数组写法仍然可用）。配置键如下：

| 键 | 说明 |
|---|---|
| `panWidth` | 见上，没有默认值 |
| `room` | `{ size: 0..1, damp: 0..1, width?: 0..1 }`，共享房间混响（Freeverb）。没有默认值 |
| `dedupe` | 单位为秒。cue 按时间排序后，和上一个保留下来的 cue 间隔小于这个值的会被丢掉（同一个 `stack` 的除外），丢掉的 cue 记进 `out/sfx.json` 的 `dropped`。不写就不去重 |
| `curveRate` | probe 的采样率，默认 240 Hz（这是控制量的采样率，采样点之间线性插值） |
| `fromScene` | `{ map: { kind: cue 模板 \| null }, format? }`：打开场景读取 `window.events()`，得到 `[{t, kind, anchor?, v?, pan?}]`，每个事件按 `map[kind]` 生成一个 cue（`t` 取事件时刻，再加上模板里的 `offset`；模板没写 `pan`/`anchor` 时用事件自带的）。**map 里没有列出的 kind 会直接报错**，写 `null` 表示明确不出声。没有默认映射 |
| `stereo` | 设为 `true` 时，即使没用到上述立体声字段也输出立体声 |

命令：`node sfx.mjs --film <slug> --dump-events` 只打印场景事件；`--emit <path>` 把场景事件生成的 cue 写成普通数组（用于留存记录或手工修改）。用到 `anchor` / `probe` / `fromScene` 时，`sfx.mjs` 会用 film-core 的 `openScene` 打开一次场景（Playwright）。

`sfx.mjs` 还会另写一份 `out/sfx.json`：`{narrationOffset, script_hash, cues[]}`。`mux.sh` 用它核对音效是否按当前偏移渲染。
立体声路径还会额外记录 `channels: 2`、`panLaw`、`mixer`（混音器来自片内运行时还是 skill）、`room`、`dedupe`、`dropped`，以及每个 cue 的参数（曲线记为 `{t0, rate, n}`）。

## out/beats.json（产出）

字段包括：`source` 音乐文件；`duration` / `bpm`，分别是秒数和估计速度；`confidence`，等于 1 − 拍间隔变异系数（越接近 1，节拍越稳）；
`beats` / `downbeats` / `hits`，均为时刻数组（秒），分别是每一拍、近似的小节首拍（每 `--meter` 拍取一拍，第一拍不是强拍时用 `--downbeat-offset` 修正）、起音峰值。

## out/music.json（产出，`music.py`）

它是 `out/beats.json` 的超集：上节的六个字段同名同义（其中 `confidence` 恒为 1，因为合成的节拍栅格是精确值而不是估计值），读 beats.json 的代码不用改就能读它。另外还有：

| 字段 | 说明 |
|---|---|
| `offset` / `meter` | 第 0 拍（同时是第 0 小节首拍）的成片时刻 / 每小节拍数。满足 `beatGrid(bpm, offset, meter).at(n) == beats[n]`、`.bar(n) == downbeats[n]` |
| `sections[]` | `{id, role: intro\|body\|outro, t, bar, barT, chords, accent, lines}`：`t` 是段落切点（首句开口时刻减 `--lead`，也是画面换段的位置）；`barT` 是和声实际切换的那条小节线（取离 `t` 最近的一条）；`lines` 是本段的句子 id。有 intro 时它是 `sections[0]` |
| `hits` | drop、各切点和终和弦的时刻（音乐里的冲击点，可以直接把事件挂上去） |
| `events` | `{drop, final}` |
| `style` / `seed` / `key` / `source` | 生成参数和 wav 路径；同样的参数和输入会得到逐字节相同的输出 |
| `inputs` | `narrationOffset`、`narrationTail`、`narration_sha256`：旁白重新合成后对不上，就应该重跑 music.py |
| `measure` | 自测结果：`centroidHz`、`lowShare`（400 Hz 以下）、`highShare`（2.5 kHz 以上）、`open05RmsDb`（前 0.5 s），口径与 `audiocheck.py` 相同 |

场景需要 `fetch` 它时，用 `--json music.json` 写到片子根目录。交付收据只统计 `out/` 以外的文件，放在 `out/` 里的话，修改后不会让 accept 变红。
