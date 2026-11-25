---
name: film-narration
description: 代码渲染视频的声音与时间轴真相源：旁白 TTS 合成（火山引擎豆包语音，edge / say 兜底）、按内容筛选音色、字级时间戳 narration.json、关键词触发 vo.at()、字幕时间数据与 SRT/ASS 导出、代码合成音效与事件对齐、分层音效与空间尾音、音乐节拍栅格与原创配乐合成、配乐闪避与混音合流、声音质量门 audiocheck、成片转写校验。片子里有配音、旁白、解说、口播、TTS、选音色、多音字或术语读错、音画不同步、镜头时长、音效、节拍卡点、ducking、合流、LUFS/真峰、已有录音反推时间戳、成片念读校验时加载。画面内字幕绘制归 film-typography，外部真实音频素材获取归 film-assets。
---

# film-narration

**音画对齐的唯一正解：让动画读音频时间戳，而不是手调动画去凑音频。** 本 skill 产出 `narration.json`、音轨与成片合流，**只输出时间数据，不画字**（画面内字幕绘制归 `film-typography`；真实音乐/拟音素材获取归 `film-assets`）。

调用约定：Python 用 `.venv/bin/python <fn>/scripts/<工具>.py`，`mux.sh` 用 `bash`，`sfx.mjs` 用 `node`（`<fn>` 为本 skill 目录）。均支持 `--film <slug>`、`--films-dir`、`--help`；场景内按需 `import './runtime/narration.js'`（在线挂载，交付冻结）。

## 四条对齐硬约束（有旁白同步时缺一不可）

1. **音频先行**：先跑 `tts.py` 拿 `narration.json`，再定镜头时长与画面事件。
2. **时长回写**：镜头边界从 `vo.line(id)` 读，不手填秒数。
3. **关键词触发**：事件写 `vo.at('词')` / `vo.span('id')`，音效 cue 写 `"at": "词"`。
4. **事后校验**：`align.py --verify` 回检成片音轨（不把脚本正文喂给 Whisper，防止假绿灯）。

TTS 具有非确定性：改单句务必用 `tts.py --only <id>` 复用其余句子的 wav 和时间戳；`narration.json` 含 `script_hash` 供下游防过期。

## 一、工具一览

| 事 | 命令 | 产出（相对 `films/<slug>/`） |
|---|---|---|
| 筛选/对比音色 | `scripts/voices.py --list-catalog` / `--film <slug> --voices a,b,c --line s1 [--instruction … --ab]` | `out/voices/_compare.wav`、`report.json` |
| 写稿估时长（免费） | `scripts/_timing.py estimate <script.json>` | 终端输出每句与总秒数（全片误差 ~5–6%） |
| 合成旁白 + 字时间戳 | `scripts/tts.py --film <slug> [--only s3 \| --captions \| --spans \| --dry-run]` | `out/vo/*.wav`、`out/vo.wav`、`narration.json` |
| 已有录音反推时间戳 | `scripts/align.py --film <slug> --from assets/vo.wav` | `narration.json` |
| 导出字幕文件 | `scripts/subs.py --film <slug> [--format ass\|srt]` | `out/subs.srt` / `out/subs.ass` |
| 合成/摆放音效 | `node <fn>/scripts/sfx.mjs --film <slug>`（读 `cues.json`，运行时 `assets/runtime/sfx.mjs`） | `out/sfx.wav`、`out/sfx.json` |
| 测节拍 / 合成配乐 | `scripts/beats.py --track assets/music.wav` / `scripts/music.py --style chip\|pluck\|ambient` | `out/beats.json` / `out/music.wav` + `music.json` |
| 音画合流与响度归一 | `bash <fn>/scripts/mux.sh --film <slug> [--music … --music-gain -18 --lufs -14 --duck 1]` | `out/final-<fmt>.mp4` + `.mux.json` |
| 声音质量门 / 转写校验 | `scripts/audiocheck.py` / `scripts/align.py --verify`（`checks` 声明 `audiocheck` / `verify` / `vo-timing`） | 终端判级与退出码 |

## 二、引擎、选音色与合成要点

- **引擎**：默认 `volcano-stream`（火山豆包语音，带字时间戳、发音词典、`instruction` 语气指令；key 放仓库根 `.env` 的 `VOLC_TTS_API_KEY`，TLS 拦截由 `make_ssl_context()` 走 `truststore` 处理）；`volcano-audio` 适合音效/多人对白；无 key 用 `edge` 免费兜底，离线用 `say`。详情见 `references/volcano-api.md`、`references/schemas.md`。
- **选音色**：不给默认音色，按片子气质用 `voices.py` 从 `references/voice-catalog.json`（98 个官方 2.0 音色）挑 3–5 个试合成，**由人试听 `_compare.wav` 定稿**（没人在场时按指标挑并在记录标明“音色未经人耳确认”）。见 `references/voices.md`。
- **行内控制与改读音**：支持 `[#语气指令]`、`[停顿 0.6]`、`[@id]…[@/id]`（由 `_markup.py` 自动剥离，不会念出或计费）。改多音字/术语靠文本同音替换（如 `密钥/密月`、`ffmpeg/F F mpeg`），拼音和 SSML phoneme 会静默失效，见 `references/pronunciation.md`。
- **字时间戳自检（硬约束，退出 6）**：合成后自动对比意群起点与 wav 能量包络（差 ≥0.20s 失败，常因顿号引起，改标点/拆句后 `--only` 重录，人听确认误报可写 `timingWaive`）。已有录音反推需注意 Whisper 尾部静音幻觉（先用 `silencedetect` 过滤）。

## 三、场景读取时间与字幕数据（`assets/runtime/narration.js`）

```js
import { loadNarration } from './runtime/narration.js';
const vo = await loadNarration('./narration.json');   // 自动读取 film.json 的 narrationOffset / narrationTail
window.DURATION = vo.filmDuration;
const s2 = vo.line('s2');                             // { start, end, duration, words }
const hit = vo.at('纯函数');                          // 查不到直接抛错；另有 endOf / after / span / locate
const cap = vo.captionAt(t, { maxChars: 14, endPunct: 'keep' });  // 交 film-typography drawCaption() 绘制
```

- **留白单一真相源**：片头/片尾留白只写 `film.json` 的 `narrationOffset` / `narrationTail`（秒）。`narration.js`、`sfx.mjs`、`subs.py`、`mux.sh`、`align.py --verify` 统一读取并互核，场景里**不要再手动加一次偏移**。
- **字幕文字来自稿子、时间来自 token**：TTS token 缺标点且分词破碎，念法≠写法（如念“百分之九十八点八”、写 `98.8%`）。`tts.py` 会将显示文本（或句内 `caption` 字段，支持 `|` 强制断行）挂到 token 的 `d` 字段；只改 `caption`/标点跑 `--captions` 离线重算不花钱。画面内字幕用 `drawCaption` 绘 `d`；外挂字幕用 `subs.py` 导出 SRT/ASS。

## 四、音效、配乐、合流与校验

- **声音质感提醒**：代码合成音效（`sfx.mjs` 自带 `click/pop/thump/whoosh/tick/chime/sweep` 及分层配方 `references/sfx-recipes.md`）适合精准 UI/节奏点，但真实物件拟音与高情绪配乐强烈建议优先走 `film-assets` 接入真实/高质量音轨，避免全片听起来像单薄电子音。同种事件轮换 2–3 个变体，撞击声峰值放画面后一帧（`+1/fps`）打击感更强；**重击音效和关键词同刻会盖掉字**，可提前 0.2–0.3s 放进停顿里，或压低增益/去低频只留瞬态，放完跑 `--verify` 复核。
- **音乐与节拍**：先定曲子再对齐事件。已有曲子用 `beats.py` 测节拍写 `out/beats.json`；无素材可用 `music.py` 按旁白段落确定性合成 `out/music.wav` + `out/music.json`（见 `references/music.md`）。`cues.json` 支持 `at` / `beat` / `t` 及可选立体声 `pan` / `anchor` / `room` / `fromScene`（见 `references/sound-design.md`）。
- **合流与真峰门**：`mux.sh` 以视频时长为准（`-c:v copy`），自动按 `narrationOffset` 延迟旁白、对配乐做人声闪避（`--duck 1`）并两遍 loudnorm，同时写 `out/.render/<成片名>.mux.json` 供 `deliver` 自动重放。**成片 true peak > -1.0 dBTP 退出 5**（修法优先降 `--lufs`，旁白片慎用 `--limit auto`，会压坏人声导致 `--verify` 变红，见 `references/mix.md`）。
- **事后校验**：`align.py --verify` 退出码 `0` 通过 / `1` 错字（硬错误率 ≥3%，数字已按数值归一，同音/外文单列“要人听”）/ `2` 时间漂移（中位数 >0.15s）/ `3` 文件错 / `4` 留白错 / `5` 真峰超标 / `6` 字时间戳错位（见 `references/verify.md`）。可选 `audiocheck.py` 查开场静音、发闷、配乐截断与真峰。

## 下层参考

`references/schemas.md` · `references/volcano-api.md` · `references/voices.md` · `references/voice-catalog.json` · `references/pronunciation.md` · `references/sfx-recipes.md` · `references/sound-design.md` · `references/music.md` · `references/mix.md` · `references/verify.md`
