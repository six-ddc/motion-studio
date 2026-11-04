---
name: film-narration
description: 代码渲染视频的声音，以及画面时间轴的数据来源：旁白 TTS 合成（火山引擎豆包语音，edge / say 兜底）、按内容筛选音色、字级时间戳 narration.json、关键词触发动画 vo.at()、字幕的时间数据与 SRT/ASS 导出、代码合成音效并按关键词/节拍摆放、音乐节拍栅格、代码合成原创配乐（先定曲子再对齐事件）、配乐闪避与混音、声音质量门（开场静音、发闷、配乐截断）、音画合流与响度归一、成片转写校验。片子里有声音时使用：配音、旁白、解说、口播、TTS、选音色、多音字或术语读错、音画不同步、镜头该多长、音效时刻、节拍卡点、ducking、合流、LUFS/真峰、已有录音反推时间戳、成片念读校验。画面内字幕怎么画归 film-typography，素材文件从哪来、能不能商用归 film-assets。
---

# film-narration

**动画和音频对齐的办法，是让动画直接读取音频的时间戳，不靠手工把动画凑到音频上。**
本 skill 产出 `narration.json`，画面上的所有时刻都以它为准。本 skill **只输出时间数据，不负责画字**：画面如何响应时间戳见 film-core（`seek(t)` 契约），
旁白文案归 film-story，画面内字幕怎么画归 film-typography。

## 能力地图

| 要做的事 | 工具 | 产出（相对 `films/<slug>/`） |
|---|---|---|
| 为本片选音色（查带标签的音色目录，对比加不加语气指令的效果） | `scripts/voices.py` | `out/voices/_compare.wav` 和 `report.json` |
| 写稿时估算时长（不调用 TTS） | `scripts/_timing.py estimate <script.json>` | 终端输出每句和总秒数 |
| 合成旁白并生成字级时间戳 | `scripts/tts.py` | `out/vo/<id>.wav` `out/vo.wav` `narration.json` |
| 从已有录音反推时间戳 | `scripts/align.py --from` | `narration.json` |
| 在场景里按字查时刻、取字幕块的时间数据 | `assets/runtime/narration.js` | — |
| 导出字幕文件 | `scripts/subs.py` | `out/subs.srt` / `out/subs.ass` |
| 合成音效（可选能力：立体声声像、跟随锚点、场景事件、读取 probe 曲线、共享房间） | `scripts/sfx.mjs` 和 `assets/runtime/sfx.mjs` | `out/sfx.wav` |
| 测量已有曲子的节拍栅格 | `scripts/beats.py` | `out/beats.json` |
| 用代码合成原创配乐（可选；结果确定，段落跟随旁白） | `scripts/music.py` | `out/music.wav` 和 `out/music.json` |
| 音画合流、配乐闪避、响度归一 | `scripts/mux.sh` | `out/final-<fmt>.mp4` |
| 片头 / 片尾留白 | `film.json` 的 `narrationOffset` / `narrationTail` | 各工具自动读取，见第四节 |
| 声音质量门（可选：查开场静音、声音发闷、配乐截断、真峰） | `scripts/audiocheck.py` | 终端输出红 / 黄判级和实测数值 |
| 事后校验 | `scripts/align.py --verify` | 退出码 0 / 1（错字）/ 2（时间漂移）/ 3（选错文件）/ 4（留白没对上）/ 5（成片真峰 > -1.0 dBTP）/ 6（字时间戳错位） |

**调用约定。** 命令写成 `.venv/bin/python <film-narration>/scripts/<工具>.py`（`<film-narration>` 是本 skill 目录；`mux.sh` 用 `bash` 运行，`sfx.mjs` 用 `node` 运行）。
所有工具都用 `--film <slug>` 指定片子（也可以给目录路径），查找片子的优先级依次是 `--films-dir`、`$FILMS_DIR`、从 cwd 向上找到的 `films/`。失败时退出码一律非 0，并在 stderr 说明原因。场景里直接 `import './runtime/narration.js'`（预听音效时再 import `./runtime/sfx.mjs`）：运行时由套件挂载，交付时冻结进片子（`../film-core/references/runtime.md` §2）。

**按声明开启的检查**（写在 film.json 的 `checks` 里，由 `gates.json` 登记）：`verify` 运行 `align.py --verify`（需要成片）；`vo-timing` 运行 `tts.py --check-timing`（离线，只检查字时间戳，不合成）；`audiocheck` 运行 `audiocheck.py`（需要成片，见第九节）。

## 四条对齐保证（硬约束）

| # | 保证 | 做法 | 缺了会怎样 |
|---|---|---|---|
| 1 | 音频先行 | 先用 `tts.py` 生成 `narration.json`，再排分镜 | 分镜按猜测的时长排，合成后全部要返工 |
| 2 | 时长回写 | 镜头边界从 `vo.line(id)` 或 `lines[].duration` 读取 | 手填的 3.2s 在重新录制后对不上 |
| 3 | 关键词触发 | 事件写 `vo.at('纯函数')`，音效 cue 写 `"at": "纯函数"` | 语速一改，所有时刻全部漂移 |
| 4 | 事后校验 | 用 `align.py --verify` 转写成片音轨，比对文本和时刻 | 错字、接错音轨要到成片里才发现 |

**TTS 不是确定性的**，同一句重新合成，时长也会变。因此 `narration.json` 只能来自最后一次合成，不要手工拼接两次合成的结果；只改一句时用 `--only s3`，脚本会复用其他句的 wav 和时间戳，并重排整条时间轴。`narration.json` 记录了 `script_hash`，下游据此发现脚本改了却没重新合成。

## 一、选引擎

| 引擎 | 用途 | 特有能力 | 时间戳 | 计费 |
|---|---|---|---|---|
| `volcano-stream`（默认） | 旁白 | 发音词典、语音指令（`context_texts`）、30+ 语种、方言、声音复刻 | 秒，带置信度 | 按文本字数（指令不计） |
| `volcano-audio` | 音效、多人对白、氛围 | 用自然语言描述音效或多说话人对白，可给参考音频和图片，可控制时间轴，单次不超过 120s | 毫秒，无置信度 | 按音频秒数 |
| `edge` | 没有 key 时兜底 | 免费，接口原生返回词边界 | 秒 | — |
| `say` | 离线兜底 | macOS 自带 | 接口不提供，自动用 Whisper 反推 | — |

`volcano-audio` 的代价是不支持发音词典和 SSML、按秒计费、读音不可控。字级时间戳只支持中英文，其他语种自动改用 Whisper 反推（字上带 `"src": "whisper"`，精度低一档）。凭证只放在仓库根 `.env` 的 `VOLC_TTS_API_KEY`；TLS 拦截由 `make_ssl_context()`（truststore）处理。请求体、错误码、语气机制见 `references/volcano-api.md`。

## 二、为这支片子选音色

`speaker` 每支片子按内容单独定，理由写进 `_注释.音色`。本 skill 不给默认音色，也不给「题材对应音色」的表，只提供维度、代价和测量工具（`references/voices.md`）。

1. 由模型把题材换算成维度目标：音域、起伏、语速、停顿、辨识度、指令响应度，每条轴写明往哪一端推、要付什么代价。
2. 由模型挑候选：`voices.py --list-catalog --gender 女 --sort f0_sd_st`（官方 2.0 中文音色 98 个，带标签与实测指标），挑 3–5 个，其中包含一个反直觉的对照。
3. 由模型用本片台词试合成：`voices.py --film <slug> --voices a,b,c --line s1 [--instruction "<指令>" --ab]`。
4. 由人试听 `out/voices/_compare.wav`（模型没有耳朵），然后定稿：在 `_注释.音色` 写下选择、指标依据和付出的代价。
   没人在场时，按第 1 步定的方向对指标排序取第一个，并在 `docs/review_log.md` 记下 **"音色未经人耳确认"**。

## 三、写 script.json、合成

字段表见 `references/schemas.md`。起始文件是 `assets/script.template.json`（film-core 的 `new-film.mjs --recipe explainer` 从这里复制）；模板里的 `speaker` 只是提示，不是音色 ID，`tts.py` 遇到占位符或空 `text` 会直接报错。

```bash
.venv/bin/python <film-narration>/scripts/tts.py --film <slug>              # 全量合成
.venv/bin/python <film-narration>/scripts/tts.py --film <slug> --only s3    # 只重新合成一句
.venv/bin/python <film-narration>/scripts/tts.py --film <slug> --dry-run    # 打印请求体（key 打码），不发请求、不计费（见 volcano-api.md「调试」）
.venv/bin/python <film-narration>/scripts/_timing.py estimate <script.json 或片子目录> [--json]   # 写稿时估算时长
```

`tts.py` 输出末尾列出每句的绝对区间（`s1  0.000 -> 3.448 (3.448s)`），也就是镜头时长，照抄进 `docs/shotlist.md`（设了 `narrationOffset` 时输出两列）。
`_timing.py` 估算的误差逐句约 9%（p90 为 19%），全片约 5–6%，陌生音色按 ±15% 理解；镜头时长仍然只取合成后的 narration.json。

**语气与节奏**可以这样控制：`instruction`（语气指令，不计费）、逐句 `speechRate`、标点停顿、台词里的 `[#指令]` 和 `[停顿 0.6]`（切段合成）、
`[@rule]…[@/rule]`（标记语义区间，用 `vo.span('rule')` 读取）、`gapAfter` / `pitch`；写法与各自代价见 `references/schemas.md`「语气与停顿控制」。
**行内标记不能原样发给接口（硬约束）**：写进 text 的标记会被念出来、计入费用，还会让字时间戳自检失败；`tts.py`、`align.py --verify`、`voices.py` 共用 `scripts/_markup.py` 去掉这些标记。

**改读音要靠改写文本**（`密钥/密月`、`ffmpeg/F F mpeg`），拼音写法和 SSML phoneme 都会静默失效。`tts.py` 会列出 conf < 0.4 的时间戳和覆盖率不足的句子，**这几处需要人听**。见 `references/pronunciation.md`。

**合成后用声音核对时间戳（硬约束，失败退出 6）**：每句按标点切成意群，与 wav 的能量包络比对起点，差值 ≥ 0.20 s 判失败（`scripts/_timing.py`）。这项检查用来发现接口把几个字挤在一起、导致后面整串错位的情况。
修法多半是改标点（顿号「、」最常出问题）或拆句后再 `--only <id>`；如果人听过确认是误报，在那句写 `"timingWaive": "<理由>"`。`align.py --verify` 每次也会查这一项。

已有录音（自录口播、非中英文语种）走反推，下游流程完全一样：`align.py --film <slug> --from assets/vo.wav`。反推有两个坑（来源 HyperFrames captions.md）。一是中日文转写常把整句当成一个"词"，字级时刻要按字数平均分配，精度降一档。二是 Whisper 会在尾部静音里编造词语（如"谢谢观看"），所以先用 `ffmpeg -af silencedetect=noise=-35dB:d=0.6` 找出静音段，丢掉落在静音段里的词。

## 四、场景里按字取时刻

```js
import { loadNarration } from './runtime/narration.js';
const vo = await loadNarration('./narration.json');   // 同时读取 film.json 里的留白
window.DURATION = vo.filmDuration;                     // 片头留白 + 旁白 + 片尾留白

const s2 = vo.line('s2');              // { start, end, duration, words }，用作镜头边界
const hit = vo.at('纯函数');           // 这个词开始被念到的时刻
const done = vo.endOf('纯函数');       // 这个词念完的时刻
const pre = vo.after('seek', -0.08);   // 相对关键词偏移
const again = vo.at('帧', 2);          // 第二次出现
const rule = vo.span('rule');          // 台词里 [@rule]…[@/rule] 那段 { start, end, line, text }
const both = vo.span('黑棋', '右边');   // 两个关键词之间
```

**片头留白只写在 film.json 的 `narrationOffset`（秒）这一处。** `loadNarration` 会把所有时刻平移成**成片时间**，场景里不要再加一次，否则会加两遍；`narration.json` 始终存旁白音频内部的秒数。
`sfx.mjs`、`subs.py`、`mux.sh`、`align.py --verify` 读同一个字段，后两者还会逐个环节核对（分镜 `vo_offset`、片内 `runtime/narration.js`、`out/sfx.json`），对不上就报错，不合流；见 `references/schemas.md`。

**`at()` 查不到就抛错，不会返回 0**。查找在去掉标点和空白的字符流里进行，命中位置必须在词边界上（`at('安史')` 不会误中「长安」）。
其他 skill 判断关键词是否在旁白里，用导出的 `findKeyword(narrationJson, kw, nth)`（或 `vo.locate()`）。`narration.js` 是纯函数（只有一次 fetch）。只改 `[@id]` 区间时，用 `tts.py --spans` 离线重算 `spans`；区间无法投影到字时间戳上时（如 Whisper 反推的结果）退出 7。

## 五、字幕：时间数据归这里，绘制归 film-typography

```js
const cap = vo.captionAt(t, { maxChars: 14, hold: 0 });
// 返回 { text, words: [{w, start, end}], spaces, start, end, activeIndex, progress, t }；句间停顿返回 null
```

`words` 已经是成片时间，`spaces[i]` 是第 i 个词前要补的空格。分块时先按标点切意群，超长的意群均分后再装箱；`chunkWords(words, maxChars)` 单独导出，和 `subs.py` 用同一个算法。

**画面内字幕**：把 `vo.captionAt(t)` 交给 film-typography 绘制，字幕和画面共享字体、配色、动效；代价是观众不能关闭，剪辑时不能修改，换语种要重新渲染。
**导出字幕文件**：`subs.py --film <slug> [--format ass --font <字体>]`，观众可以关闭，剪辑师和译者能修改，平台可以渲染，还能做多语种；代价是 SRT 只有文字，ASS 的 `\kf` 逐词填色只在部分播放器或硬烧时生效，MP4 软字幕轨（mov_text）会丢掉全部样式。
两条路可以并用：硬烧用 `ffmpeg -i out/final-9x16.mp4 -vf "subtitles=out/subs.ass" -c:a copy out/burned.mp4`；软字幕轨用 `-i out/subs.srt -c copy -c:s mov_text`。

## 六、音效

在 `films/<slug>/cues.json` 里描述事件，再用 `node <film-narration>/scripts/sfx.mjs --film <slug>` 渲成 `out/sfx.wav`：

```json
[{ "at": "纯函数", "offset": -0.04, "type": "thump", "gain": 0.7 },
 { "at": "帧", "nth": 2, "file": "assets/sfx/shutter.wav" },
 { "beat": 8, "grid": "downbeats", "type": "tick" },
 { "t": 0.0, "type": "whoosh", "gain": 0.3 }]
```

`at` 绑定旁白关键词（查不到会报错），`beat` 绑定 `out/beats.json` 里的节拍，`t` 只用于和旁白、音乐都无关的事件。三种时刻都是**成片时间**：
`at` 会自动加上 `narrationOffset`，用到的偏移记进 `out/sfx.json`，供 `mux.sh` 核对。每个事件有独立的随机种子，增删一个 cue 不会让其他事件的声音改变。合成音色（`type`，自带 `click pop thump whoosh tick chime sweep`）来自运行时 `sfx.mjs`，场景预听和离线渲染用的是同一组；在片内新增音色的方法见 schemas 的 `type` 行，代价是片内那份不再跟随套件更新。
**可选能力**（都不写时输出单声道）：声像 `pan` / 锚点 `anchor`、probe 曲线、`dur` 连续层、共享房间、`fromScene` 映射场景事件。
**`panWidth`、`room` 和 kind 到音色的映射都没有默认值**，只要出现任一新字段就输出立体声。字段见 `references/schemas.md`，代价见 `references/sound-design.md`。

用合成音效还是素材：合成音效没有授权风险，能精确摆放，可以重复生成，代价是"真实物件声"（按键、快门）听起来廉价；素材从哪找、能否商用归 film-assets。
摆放音效有两条经验（来源 HyperFrames sound.md，属于代价上的取舍，不是规则）。一是同一种事件轮换 2–3 个 take（换种子、微调 `gain`/`offset` 或换文件），每个转场都用同一声 whoosh 最容易听出机器味。二是撞击声的峰值放在画面事件的**后一帧**（`offset` 约 +1/fps），比放在同一帧更像"打中了"。

## 七、音乐：先定曲子，再把事件对齐上去

声音是时间线的一部分：先拿到曲子的节拍、段落和冲击点，再把点击、图表完成、转场、logo 揭示这些事件对齐上去；顺序反过来，就成了事后给画面配一段对不上的音乐。
旁白主导时事件绑定关键词，音乐主导时绑定节拍，选哪种由本片决定。流程、风格代价、字段见 `references/music.md`。

```bash
.venv/bin/python <film-narration>/scripts/beats.py --film <slug> --track assets/music.wav   # 已有曲子：测量节拍，写入 out/beats.json
.venv/bin/python <film-narration>/scripts/music.py --film <slug> --style chip|pluck|ambient [--drop a2 --final 游戏就成了]  # 没有曲子：合成
```

**`beats.py`** 的产出字段见 `references/schemas.md`；测不到稳定节拍时（氛围乐、纯人声）直接报错。

**`music.py`**（可选）读取 narration.json 的句子时刻和 `narrationOffset/Tail`，合成原创配乐：句子按 id 的字母前缀分段，每段换和声，隔段加一层，切点前加过门，切点处响一声镲。
`--style` 必填（`--list-styles` 列出各风格的代价）；固定 `--seed` 时结果逐字节可重复；`--dry-run` 只打印段落规划。共同骨架与代价见 `references/music.md` 第 2 节。
`out/music.json` 是 `beats.json` 的超集：cue 可以写 `{ "beat": 3, "grid": "sections" }`（没有 `out/beats.json` 时 `sfx.mjs` 会自动读取它）；场景里 `beatGrid(m.bpm, m.offset, m.meter)`（film-core motion.js）与 `m.beats[n]` 逐拍一致，切点读 `m.sections[i].t`；合流时用 `mux.sh --music out/music.wav`（合流记录会记下它的 sha）。

## 八、合流与响度

```bash
bash <film-narration>/scripts/mux.sh --film <slug> [--music assets/music.wav --music-gain -18] [--lufs -14] [--duck 0] [--limit auto] [--lra 11]
```

输入是 `out/silent-<film.json 的 format>.mp4`（按 format 精确匹配，不用通配符）、`out/vo.wav`（没有旁白的片子可以没有）以及存在的 `out/sfx.wav`。
旁白按 `narrationOffset` 延迟，音效已经是成片时间。混音长度以视频为准，视频流 `-c:v copy`，音频短了补静音；配乐长了会被 `-t` 硬切，短了片尾是数字静音（`music.py` 按片长生成）。有配乐时默认闪避（`--duck 0` 关闭）。响度做两遍 loudnorm（线性/动态模式见 `references/mix.md`）。**成片 true peak 是一道门**：> -1.0 dBTP 退出 5，-1.5 到 -1.0 之间警告，修法是先降低 `--lufs`。每次合流写 `out/.render/<成片名>.mux.json`（记录输入与成片的 sha 和参数）：film-core 凭它判断成片是否新鲜，定稿重渲后 `deliver` 按它重放本脚本（格式见 film-core 的 api 文档 6b 节）。因此混音参数只需在第一次合流时给出。

## 九、事后校验

```bash
.venv/bin/python <film-narration>/scripts/align.py --film <slug> --verify   # 只认 out/final[-<格式>].mp4，否则用 out/vo.wav
.venv/bin/python <film-narration>/scripts/align.py --selftest               # 数字/标点归一用例，以及与 film-story factcheck 的交叉校验
```

默认模型是 `large-v3-turbo`，不把脚本正文提供给 Whisper；比对前做标点归一，**数字按数值比较**（量词和单位不归一）；见 `references/verify.md`。

| 类别 | 是否计入阈值 | 含义 |
|---|---|---|
| 硬错误 | 计入（准确率 < 97% 退出 1） | 删字、多字、非同音替换 |
| 疑似同音 | 不计入，要人听 | 拼音相同的替换（需要 pypinyin；没装时按硬错误计，并标「同音未排除」） |
| 外文词 | 不计入，要人听 | 中文音频里的英文术语，Whisper 拼写不可靠 |
| 时间漂移 | 中位数 > 0.15s 退出 2 | 转写的字时刻与 narration.json **加上 narrationOffset** 后比较（转写 vo.wav 时偏移取 0）；看中位数是因为 Whisper 的字级误差约 0.05–0.15s |
| 成片真峰 | > -1.0 dBTP 退出 5 | 只查成片；-1.5 到 -1.0 之间警告 |
| 字时间戳错位 | 意群起点差 ≥ 0.20s 退出 6 | 比较 narration.json 与每句 wav 的能量包络 |

自动挑选文件的规则见 `references/verify.md`。"要人听"清单不为空时，这道门通过不代表读音正确。**这一关只比对声音**；画面层的对点检查见 film-critique 的 `check.mjs`（mark.sync）。

**声音质量门 `audiocheck`**（可选，在 checks 里声明 `"audiocheck"` 才开启）：声音要和画面一样接受检查。
命令是 `audiocheck.py --film <slug> [--mix <文件>] [--only open,tone,tail,peak]`；各项的判级、测量的量、阈值与改法见 `references/music.md` 第 3 节。

## 参考

- `references/schemas.md`：各 json 的字段表，以及留白字段由谁读取（其他 skill 读这份）；`references/volcano-api.md`：请求体、经官方核实的模型与 2.0 语气机制、返回码、网络
- `references/voices.md`：选音色的维度、代价、指标、候选组命令；`references/voice-catalog.json`：官方 2.0 中文音色目录（`voices.py --list-catalog [--md]` 读取它）
- `references/pronunciation.md`：改读音的写法以及能否自动验证；`references/mix.md`：loudnorm 模式、限幅、成片真峰门；`references/verify.md`：模型、归一、挑文件、留白链路
- `references/music.md`：定曲流程、`music.py` 的风格与代价、`audiocheck` 的口径与阈值；`references/sound-design.md`：各项音效能力的代价
- 实测记录（不随安装）：仓库 `docs/verified/film-narration.md`
