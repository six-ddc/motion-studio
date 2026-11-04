#!/usr/bin/env python3
"""旁白/音效合成 + 字级时间戳。这是"音频和画面对齐"的源头。

核心思路：**音频先行**。先把声音做出来，拿到每个字被念到的精确时刻，
再让动画去读这些时刻。绝不是先做动画然后把音频硬塞进去。

四个引擎，同一份 narration.json 输出契约：

  volcano-stream  默认。火山引擎 单向流式语音合成（HTTP Chunked）
                  POST /api/v3/tts/unidirectional   模型 seed-tts-2.0 / seed-icl-2.0
                  旁白主力。独有：发音词典、SSML、30+ 语种、方言、括号过滤、声音复刻
                  时间戳 sentence.words[].{word,startTime,endTime,confidence}（秒）
                  计费按文本字数。enable_subtitle 仅支持中英文。
                  https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http

  volcano-audio   火山引擎 音频生成（非流式）
                  POST /api/v3/tts/create           模型 seed-audio-1.0
                  音效/多人对白/氛围音。独有：自然语言描述音效、参考音频/参考图片、
                  时间轴控制（用自然语言指定总时长和人声说话时段）。单次 ≤120 秒。
                  时间戳 subtitle.sentences[].words[].{text,start_time,end_time}（毫秒）
                  计费按 original_duration 秒数。
                  https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http

  edge            免费兜底，不要 key，原生返回词边界，需联网
  say             macOS 离线兜底，无时间戳，自动用 Whisper 反推

用法（任意 cwd，从 cwd 往上找 films/<slug>/）:
    python tts.py --film <slug>                       # 读 script.json 的 engine 字段
    python tts.py --film <slug> --engine edge         # 临时换引擎
    python tts.py --film <slug> --only s3             # 只重合成一句，其余复用 out/vo/*.wav 和旧时间戳
    python tts.py --film <slug> --dry-run             # 只打印请求体（key 打码），不发请求、不计费
    python tts.py --film <slug> --check-timing        # 不合成，只对现有 narration.json 跑「字时间戳 vs 能量包络」自检
    python tts.py --film <slug> --spans               # 不合成：按 script.json 的 [@id]…[@/id] 重算 narration.json 的 spans
    python tts.py --list-edge-voices zh

凭证（放 .env，别写进脚本或 prompt —— prompt 会被截图）：
    VOLC_TTS_API_KEY=...          新版控制台 > API Key 管理（两个方案都用它）
  旧版控制台（仅 volcano-audio 支持双头鉴权）：
    VOLC_TTS_APP_ID=...
    VOLC_TTS_ACCESS_KEY=...

产出（全部相对 films/<slug>/）:
    out/vo/<id>.wav   每句一条，镜头时长由它决定（别手填）

合成完会拿每句 wav 的能量包络核对字级时间戳（_timing.py；weiqi-intro 的「上、下、左、右」挤在 0.1s 内就是这么漏的）。
意群起点错拍 ≥ 0.20s → 退出码 6。narration.json 照样写出（--only 重合成要用它），但修好之前别拿它排分镜、渲染。
人听过、确认时间戳没错（检查误报）时，在 script.json 那一句写 "timingWaive": "<理由>"，失败降为警告并带着理由打印。
    out/vo.wav        拼好的完整旁白，48kHz 单声道
    narration.json    绝对时间轴 + 字级时间戳，画面和字幕的唯一真相源（schema 见 references/schemas.md）
                      台词写了区间标记 [@id]…[@/id] 时多一个 spans: {id: {start, end, line, text}}；没写就没有这个键。
                      区间投影不上（字级时间戳和台词逐字对不上）→ narration.json 照写、不带 spans，退出码 7。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, load_dotenv, out_dir, rel, die, need_file  # noqa: E402
from _offset import narration_offset  # noqa: E402
from _markup import parse as parse_markup, resolve as resolve_markup, needs_split, MarkupError  # noqa: E402
from _markup import strip_spans, build_spans  # noqa: E402

DRY_RUN = False
URL_STREAM = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
URL_AUDIO = "https://openspeech.bytedance.com/api/v3/tts/create"
TICKS_PER_SECOND = 10_000_000          # edge-tts 的 offset 单位是 100ns
LOW_CONFIDENCE = 0.4                   # 低于此值的时间戳提示人工复核


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def need(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        sys.exit(f"找不到 {binary}（brew install {binary}）")
    return path


def to_wav(src: Path, dst: Path) -> float:
    """统一转 48k 单声道 WAV，返回 ffprobe 实测时长（秒）。
    时长一律以实测为准，不信接口自报的数字 —— 变速和后处理会让两者不一致。"""
    need("ffmpeg")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(src), "-ac", "1", "-ar", "48000", str(dst)],
        check=True,
    )
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(dst)],
        check=True, capture_output=True, text=True,
    )
    return round(float(out.stdout.strip()), 3)


def make_silence(dst: Path, seconds: float) -> None:
    """48k 单声道 s16 静音，和 to_wav 的产出同格式（concat demuxer 要求逐段格式一致）。"""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
         "-t", str(seconds), "-c:a", "pcm_s16le", str(dst)], check=True)


def concat_wavs(parts: list[Path], dst: Path, listing: Path) -> None:
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(dst)], check=True)
    listing.unlink(missing_ok=True)


def make_ssl_context():
    """证书链。公司网络/本地代理做 TLS 拦截时，certifi 认不出那张自签 CA，
    但系统钥匙串认（curl 能通就是证据）。优先级：
      显式指定的 CA 包 > 系统信任库(truststore) > certifi 默认
    """
    bundle = os.environ.get("VOLC_TTS_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    if bundle and Path(bundle).exists():
        return ssl.create_default_context(cafile=bundle)
    try:
        import truststore
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        return ssl.create_default_context()


class DryRun(Exception):
    pass


def post_json(url: str, headers: dict, body: dict, timeout: int = 300):
    if DRY_RUN:
        shown = {k: ("<已设置，打码>" if k.lower() in ("x-api-key", "x-api-access-key") else v)
                 for k, v in headers.items()}
        print(f"POST {url}")
        print("headers " + json.dumps(shown, ensure_ascii=False, indent=1))
        print("body " + json.dumps(body, ensure_ascii=False, indent=1))
        raise DryRun()
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=make_ssl_context()) as res:
            return res.read(), res.headers.get("X-Tt-Logid", "")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:800]
        die(f"火山引擎返回 HTTP {e.code}\n{detail}")
    except urllib.error.URLError as e:
        die(f"连不上火山引擎：{e.reason}（TLS 拦截见 make_ssl_context）")


def iter_json_values(raw: bytes):
    """HTTP Chunked 的响应体是一串连着的 JSON 对象（可能夹换行）。
    逐个解出来，不假设分隔符是什么。"""
    text = raw.decode("utf-8", "replace")
    decoder = json.JSONDecoder()
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " \r\n\t":
            i += 1
        if i >= n:
            return
        try:
            value, end = decoder.raw_decode(text, i)
        except json.JSONDecodeError:
            return
        yield value
        i = end


def volcano_key() -> str:
    key = os.environ.get("VOLC_TTS_API_KEY")
    if not key and DRY_RUN:
        return "<未设置>"
    if not key:
        sys.exit(
            "缺少 VOLC_TTS_API_KEY。到 火山引擎控制台 > API Key 管理 取，写进 .env：\n"
            "  VOLC_TTS_API_KEY=...\n"
            "不想用火山引擎可以 --engine edge（免费）或 --engine say（离线）"
        )
    return key


# ---------------------------------------------------------------------------
# engine: volcano-stream —— 旁白主力
# ---------------------------------------------------------------------------
def synth_volcano_stream(text: str, dst_raw: Path, spec: dict):
    fmt = spec.get("format", "mp3")
    audio_params = {
        "format": fmt,
        "sample_rate": int(spec.get("sampleRate", 44100)),
        "speech_rate": int(spec.get("speechRate", 0)),
        "loudness_rate": int(spec.get("loudnessRate", 0)),
        "enable_subtitle": True,            # ← 字级时间戳的开关（仅中英文）
    }
    if spec.get("bitRate"):
        audio_params["bit_rate"] = int(spec["bitRate"])

    speaker = spec.get("speaker")
    if not speaker:
        sys.exit("volcano-stream 必须指定 speaker（音色 ID，见控制台 > 音色库）")

    req_params: dict = {
        "text": text,
        "speaker": speaker,
        "audio_params": audio_params,
    }
    if spec.get("model"):
        req_params["model"] = spec["model"]          # 仅复刻音色需要
    if spec.get("ssml"):
        req_params["ssml"] = spec["ssml"]

    # additions 必须是 JSON 序列化后的字符串
    additions: dict = {}
    for key, field in (
        ("pronunciationDict", "pronunciation_dict"),   # 发音词典，修专有名词读音
        ("explicitLanguage", "explicit_language"),
        ("explicitDialect", "explicit_dialect"),
        ("silenceDuration", "silence_duration"),
        ("filterParenthesis", "max_length_to_filter_parenthesis"),
        ("disableMarkdownFilter", "disable_markdown_filter"),
        ("disableEmojiFilter", "disable_emoji_filter"),
        ("latexParser", "latex_parser"),
        ("autoLanguage", "enable_auto_language_recognition"),
        ("contextTexts", "context_texts"),
        ("toneFidelity", "tone_fidelity"),
        ("aigcWatermark", "aigc_watermark"),
    ):
        if spec.get(key) is not None:
            additions[field] = spec[key]
    # 语气指令（仓库 docs/verified/film-narration.md 第 26 节）：官方「语音指令」= additions.context_texts，只认列表第一个值（实测：
    # [快, 慢] 与 [慢, 快] 分别跟着第一个走），不计费（实测计费字数不变）。instruction 是它的简写；
    # 两个都给就不知道该听谁的，直接报错。
    if spec.get("instruction"):
        if spec.get("contextTexts"):
            sys.exit("instruction 和 contextTexts 同时给了：接口只认 context_texts 的第一个值，二选一")
        additions["context_texts"] = [str(spec["instruction"])]
    if spec.get("pitch") is not None:                   # 后处理变调，半音 [-12, 12]；实测 ±6 → 基频 ×1.45 / ×0.72
        p = int(spec["pitch"])
        if not -12 <= p <= 12:
            sys.exit(f"pitch={p} 超出 [-12, 12]（半音）")
        additions["post_process"] = {**(additions.get("post_process") or {}), "pitch": p}
    if additions:
        req_params["additions"] = json.dumps(additions, ensure_ascii=False)

    headers = {
        "Content-Type": "application/json",
        "Connection": "keep-alive",
        "X-Api-Key": volcano_key(),
        "X-Api-Resource-Id": spec.get("resourceId", "seed-tts-2.0"),
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Control-Require-Usage-Tokens-Return": "*",   # 要回计费字数
    }

    raw, logid = post_json(URL_STREAM, headers, {"req_params": req_params})

    audio = bytearray()
    words: list[dict] = []
    billed_words = 0
    # 流式协议里 0 是成功，20000000 是"本次会话正常结束"的事件码，都不是错误
    SUCCESS_CODES = {0, 20000000}
    for chunk in iter_json_values(raw):
        code = chunk.get("code")
        if code is not None and code not in SUCCESS_CODES:
            sys.exit(f"合成失败 code={code} message={chunk.get('message')} logid={logid}")
        if chunk.get("data"):
            audio.extend(base64.b64decode(chunk["data"]))
        sentence = chunk.get("sentence") or {}
        for w in sentence.get("words") or []:
            token = (w.get("word") or "").strip()
            if not token:
                continue
            words.append({
                "w": token,
                "start": round(float(w["startTime"]), 3),
                "end": round(float(w["endTime"]), 3),
                "conf": round(float(w.get("confidence", 1)), 3),
            })
        billed_words += int((chunk.get("usage") or {}).get("text_words") or 0)

    if not audio:
        sys.exit(f"接口没有返回音频 logid={logid}")
    dst_raw.write_bytes(bytes(audio))
    words.sort(key=lambda w: w["start"])
    return words, {"text_words": billed_words}


# ---------------------------------------------------------------------------
# engine: volcano-audio —— 音效 / 多人对白 / 氛围音
# ---------------------------------------------------------------------------
def synth_volcano_audio(text: str, dst_raw: Path, spec: dict):
    for k in ("pronunciationDict", "ssml", "explicitLanguage", "explicitDialect"):
        if spec.get(k):
            print(f"      ⚠ volcano-audio 不支持 {k}，这一项被忽略。专有名词要靠它的话换 volcano-stream",
                  file=sys.stderr)
    headers = {
        "Content-Type": "application/json",
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    api_key = os.environ.get("VOLC_TTS_API_KEY")
    app_id = os.environ.get("VOLC_TTS_APP_ID")
    access_key = os.environ.get("VOLC_TTS_ACCESS_KEY")
    if api_key:
        headers["X-Api-Key"] = api_key                  # 新版控制台：单头
    elif app_id and access_key:
        headers["X-Api-App-Id"] = app_id                # 旧版控制台：双头
        headers["X-Api-Access-Key"] = access_key
    else:
        volcano_key()                                   # 统一报错文案

    body: dict = {
        "model": spec.get("audioModel", "seed-audio-1.0"),
        # text_prompt 既可以是纯文本，也可以是带音效/说话人/时长描述的提示词
        "text_prompt": spec.get("promptPrefix", "") + text,
        "audio_config": {
            "format": spec.get("format", "mp3"),
            "sample_rate": int(spec.get("sampleRate", 44100)),
            "speech_rate": int(spec.get("speechRate", 0)),
            "loudness_rate": int(spec.get("loudnessRate", 0)),
            "pitch_rate": int(spec.get("pitchRate", 0)),
            "enable_subtitle": True,        # ← 字级时间戳的开关
        },
    }
    # speaker / audio_data / audio_url / image_* 四者互斥
    refs: dict = {}
    for key, field in (("speaker", "speaker"), ("audioData", "audio_data"),
                       ("audioUrl", "audio_url"), ("imageData", "image_data"),
                       ("imageUrl", "image_url")):
        if spec.get(key):
            refs[field] = spec[key]
    if len(refs) > 1:
        sys.exit(f"speaker / audioData / audioUrl / imageData / imageUrl 互斥，"
                 f"你给了 {list(refs)}")
    if refs:
        body["references"] = [refs]
    if spec.get("watermark"):
        body["watermark"] = spec["watermark"]

    raw, logid = post_json(URL_AUDIO, headers, body)
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("code") not in (None, 0) or not payload.get("audio"):
        sys.exit(f"合成失败 code={payload.get('code')} "
                 f"message={payload.get('message')} logid={logid}")

    dst_raw.write_bytes(base64.b64decode(payload["audio"]))

    words: list[dict] = []
    for sentence in (payload.get("subtitle") or {}).get("sentences") or []:
        for w in sentence.get("words") or []:
            token = (w.get("text") or "").strip()
            if not token:
                continue
            words.append({
                "w": token,
                "start": round(w["start_time"] / 1000, 3),   # 毫秒 -> 秒
                "end": round(w["end_time"] / 1000, 3),
            })
    words.sort(key=lambda w: w["start"])
    return words, {"original_duration": payload.get("original_duration")}


# ---------------------------------------------------------------------------
# engine: edge
# ---------------------------------------------------------------------------
async def _edge(text: str, mp3: Path, voice: str, rate: str, pitch: str):
    import edge_tts

    # edge-tts 7.x 起 Communicate 默认 boundary='SentenceBoundary'：只回整句边界，不回 WordBoundary，
    # 下面的循环收不到任何词 → 每句都静默退回 Whisper 反推（实测 7.3.1）。显式要词边界；
    # 老版本没有这个参数（只会发 WordBoundary），按签名判断，不传。
    import inspect
    kw = {"rate": rate, "pitch": pitch}
    if "boundary" in inspect.signature(edge_tts.Communicate.__init__).parameters:
        kw["boundary"] = "WordBoundary"
    comm = edge_tts.Communicate(text, voice, **kw)
    audio = bytearray()
    words: list[dict] = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            start = chunk["offset"] / TICKS_PER_SECOND
            words.append({
                "w": chunk["text"],
                "start": round(start, 3),
                "end": round(start + chunk["duration"] / TICKS_PER_SECOND, 3),
            })
    if not audio:
        sys.exit(f"edge-tts 没有返回音频，检查网络或音色名：{voice}")
    mp3.write_bytes(bytes(audio))
    return words


def synth_edge(text: str, dst_raw: Path, spec: dict):
    words = asyncio.run(_edge(
        text, dst_raw,
        spec.get("voice", "zh-CN-XiaoxiaoNeural"),
        spec.get("rate", "+0%"),
        spec.get("pitch", "+0Hz"),
    ))
    return words, {}


async def list_edge_voices(prefix: str):
    import edge_tts
    for v in await edge_tts.list_voices():
        if v["ShortName"].lower().startswith(prefix.lower()):
            print(f'{v["ShortName"]:<34} {v["Gender"]:<7} {v.get("FriendlyName","")}')


# ---------------------------------------------------------------------------
# engine: say
# ---------------------------------------------------------------------------
def synth_say(text: str, dst_raw: Path, spec: dict):
    cmd = [need("say"), "-o", str(dst_raw)]
    if spec.get("sayVoice"):
        cmd += ["-v", spec["sayVoice"]]
    if spec.get("sayRate"):
        cmd += ["-r", str(spec["sayRate"])]
    cmd.append(text)
    subprocess.run(cmd, check=True)
    return [], {}


def align_with_whisper(wav: Path, hint: str, model_size: str = "small") -> list[dict]:
    """用 faster-whisper 反推字级时间戳。say 必走；接口没返回字幕时兜底。"""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("      ⚠ 未装 faster-whisper，这句没有字级时间戳", file=sys.stderr)
        return []
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        str(wav), word_timestamps=True, initial_prompt=hint or None, vad_filter=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            token = w.word.strip()
            if token:
                words.append({"w": token, "start": round(w.start, 3),
                              "end": round(w.end, 3)})
    return words


ENGINES = {
    "volcano-stream": synth_volcano_stream,
    "volcano-audio": synth_volcano_audio,
    "edge": synth_edge,
    "say": synth_say,
}


# ---------------------------------------------------------------------------
import hashlib  # noqa: E402
import re  # noqa: E402
import unicodedata  # noqa: E402

PUNCT = re.compile(r"[\s，。、；：！？,.;:!?\"'“”‘’()（）《》—…·-]")


def script_hash(spec: dict) -> str:
    """narration.json 记下它是从哪版脚本生成的。脚本改了没重跑，下游能查出来。
    后加的控制字段只在写了时才进哈希——没用到这些字段的片子哈希不变，不会被误报「脚本改了没重跑」。"""
    keys = ("engine", "speaker", "voice", "speechRate", "pronunciationDict", "gap", "lines")
    blob_d = {k: spec.get(k) for k in keys}
    # 区间标记 [@id] 不改声音：哈希里去掉它。没写区间的句子原样进哈希
    if any(strip_spans(str(l.get("text", ""))) != str(l.get("text", "")) for l in spec.get("lines") or []):
        blob_d["lines"] = [{**l, "text": strip_spans(str(l["text"]))} if "text" in l else l for l in spec["lines"]]
    for k in ("instruction", "contextTexts", "pitch"):
        if spec.get(k) is not None:
            blob_d[k] = spec[k]
    blob = json.dumps(blob_d, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def lint_dict(spec: dict, lines: list[dict]) -> list[str]:
    """发音词典的合成前静态检查。
    读音本身能测：仓库 docs/verified/film-narration.md 第 12 节的共振峰法（先过检验力闸门）测出
    **拼音写法 原词/(pin1)(yin1) 在 seed-tts-2.0 上没有改变韵母**——「密钥/(mi4)(yue4)」「密药/(mi4)(yue4)」
    「密月/(mi4)(yao4)」三条本该改变读音的条目共 28 次合成，0 次改变读音；**文本转写写法 密钥/密月 生效**（12/12 读 yuè）。
    所以这里对拼音条目报一条警告，建议改成同音字转写。"""
    issues = []
    alltext = "".join(l.get("text", "") for l in lines)
    for item in (spec.get("pronunciationDict") or {}).get("tone") or []:
        if "/" not in item:
            issues.append(f"「{item}」缺少 '/'，格式应为 原词/(pin1)(yin1) 或 原词/转写文本")
            continue
        src, dst = item.split("/", 1)
        if len(src) > 9:
            issues.append(f"「{src}」超过 9 字符，接口会忽略")
        if src not in alltext:
            issues.append(f"「{src}」不在任何一句里，是死条目（大小写也要一致）")
        if dst.startswith("("):
            issues.append(f"「{item}」是拼音写法：实测在 seed-tts-2.0 上不改变读音（仓库 docs/verified/film-narration.md 第 12 节）。"
                          f"要换读音改用文本转写，写成 {src}/<读音正确的同音字>，例 密钥/密月；代价是该词的时间戳 token 变成转写字，"
                          f"tts.py 会拼回原词，vo.at('{src}') 可用，但单查其中一个字查不到")
            syl = re.findall(r"\(([a-z]+)([1-5])\)", dst)
            if "".join(f"({a}{b})" for a, b in syl) != dst:
                issues.append(f"「{item}」拼音段格式不对，每个音节写成 (pin1)，声调 1-5")
            elif len(syl) != len(src):
                issues.append(f"「{item}」音节数 {len(syl)} 和字数 {len(src)} 不一致（通常一字一音节）")
    return issues


def restore_dict_words(words: list[dict], spec: dict) -> list[dict]:
    """发音词典的「文本转写」条目（如 ffmpeg/F F mpeg）会改写接口返回的时间戳 token：
    实测 `ffmpeg` 回来是 `F` `F` `mpeg，` 三个词。不还原的话 vo.at('ffmpeg') 直接查不到。
    这里把连续 token 拼回原词：start 取首、end 取尾、conf 取最小，并记 alias。
    拼音条目（帧/(zhen1)）不改 token，不用处理（它也不改读音，见 lint_dict）。"""
    entries = []
    for item in (spec.get("pronunciationDict") or {}).get("tone") or []:
        if "/" not in item:
            continue
        src, dst = item.split("/", 1)
        if dst.startswith("("):
            continue
        entries.append((src, PUNCT.sub("", dst).lower()))
    if not entries:
        return words
    out, i = [], 0
    while i < len(words):
        hit = None
        for src, target in entries:
            acc, j = "", i
            while j < len(words) and len(acc) < len(target):
                acc += PUNCT.sub("", words[j]["w"]).lower()
                j += 1
            if acc == target:
                hit = (src, j)
                break
        if not hit:
            out.append(words[i])
            i += 1
            continue
        src, j = hit
        group = words[i:j]
        tail = re.sub(r"^.*?([，。、；：！？,.;:!?]*)$", r"\1", group[-1]["w"])
        merged = {"w": src + tail, "start": group[0]["start"], "end": group[-1]["end"],
                  "alias": " ".join(g["w"] for g in group),
                  # 原始子 token 的时间也留着：拼回整词会丢掉单字边界，事后要单独分析某个字
                  # （仓库 docs/verified/film-narration.md 第 12 节的共振峰复核只认单字窗口——「密+月」合并窗口没过闸门）就靠它
                  "parts": [{"w": g["w"], "start": g["start"], "end": g["end"]} for g in group]}
        confs = [g["conf"] for g in group if g.get("conf") is not None]
        if confs:
            merged["conf"] = min(confs)
        out.append(merged)
        i = j
    return out


def timing_check(film: Path, nar: dict, spec: dict | None) -> int:
    """字时间戳 vs 能量包络（_timing.py）。打印结果，返回失败条数。
    为什么做成失败而不是警告：场景按字触发动画（vo.at），时间戳错了画面就错拍，而下游没有任何一道门能发现——
    align --verify 的漂移看全片中位数，film-critique 的 mark.sync 和 narration.json 出自同一份时间戳。
    weiqi-intro 的作者只能靠肉眼看包络才发现，tts.py 当时只把它们列进了低置信度。"""
    from _timing import check_narration, report
    issues, skipped = check_narration(film, nar, spec)
    print()
    n_fail = report(issues, skipped, sys.stderr)
    if n_fail:
        print(f"✗ 字时间戳 vs 能量包络：{n_fail} 处失败——按字触发的画面会错拍。narration.json 已写出（--only 重合成要用它），"
              f"修好之前别拿它排分镜、渲染。人听过确认没错时在 script.json 那一句写 \"timingWaive\": \"<理由>\"",
              file=sys.stderr)
    else:
        print(f"✓ 字时间戳 vs 能量包络：0 处失败，{len(issues)} 处警告（阈值与依据见 _timing.py）")
    return n_fail


def spans_or_report(spec: dict, nar_lines: list[dict]) -> tuple[dict | None, bool]:
    """→ (spans 或 None, 是否失败)。没写区间标记 → (None, False)，narration.json 不出现 spans 键。"""
    try:
        sp, warns = build_spans(spec.get("lines") or [], nar_lines)
    except MarkupError as e:
        print(f"✗ 区间标记：{e}。narration.json 不带 spans 写出", file=sys.stderr)
        return None, True
    for w in warns:
        print(f"⚠ 区间：{w}", file=sys.stderr)
    if sp:
        print(f"✓ 区间 {len(sp)} 个：" + "  ".join(f"{k} {v['start']:.3f}→{v['end']:.3f}" for k, v in sp.items()))
    return sp or None, False


def refresh_spans(film: Path) -> int:
    """tts.py --spans：只重算 spans，其余字段原样、键序不变。返回退出码。"""
    nar_path = need_file(film / "narration.json", "先跑 tts.py 合成")
    spec = json.loads(need_file(film / "script.json", "").read_text(encoding="utf-8"))
    nar = json.loads(nar_path.read_text(encoding="utf-8"))
    sp, bad = spans_or_report(spec, nar.get("lines") or [])
    if bad:
        return 7
    if not sp and "spans" not in nar:
        print("✓ 台词里没有区间标记，narration.json 不动")
        return 0
    nar.pop("spans", None)
    if sp:
        nar["spans"] = sp
    if nar.get("script_hash") not in (None, script_hash(spec)):
        print("⚠ script_hash 和当前 script.json 不一致：除区间以外还有别的改动，声音可能过期——该重合成的要重合成", file=sys.stderr)
    nar_path.write_text(json.dumps(nar, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"✓ narration.json spans {'已更新' if sp else '无（台词里没有区间标记）'}")
    return 0


def main() -> None:
    global DRY_RUN
    ap = parser("旁白合成 + 字级时间戳 -> films/<slug>/narration.json")
    ap.add_argument("--engine", default=None, choices=list(ENGINES),
                    help="默认读 script.json 的 engine 字段，没有则 volcano-stream")
    ap.add_argument("--only", default=None,
                    help="逗号分隔的句子 id，只重合成这几句；其余复用已有 wav 和时间戳")
    ap.add_argument("--dry-run", action="store_true",
                    help="打印第一句的请求体（key 打码）后退出，不发请求、不计费")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--check-timing", action="store_true",
                    help="不合成：只对现有 narration.json 跑字时间戳 vs 能量包络自检（退出 0 / 6）")
    ap.add_argument("--spans", action="store_true",
                    help="不合成：按 script.json 的区间标记重算现有 narration.json 的 spans（改了区间不用重花 TTS）")
    ap.add_argument("--list-edge-voices", metavar="PREFIX")
    args = ap.parse_args()

    if args.list_edge_voices:
        asyncio.run(list_edge_voices(args.list_edge_voices))
        return

    film = resolve_film(args.film, args.films_dir)
    if args.check_timing:
        nar = json.loads(need_file(film / "narration.json", "先跑 tts.py 合成").read_text(encoding="utf-8"))
        sp = film / "script.json"
        n_fail = timing_check(film, nar, json.loads(sp.read_text(encoding="utf-8")) if sp.exists() else None)
        sys.exit(6 if n_fail else 0)
    if args.spans:
        sys.exit(refresh_spans(film))
    load_dotenv(film)
    script_path = need_file(film / "script.json",
                            "旁白脚本由 film-story 的分镜产出，schema 见 references/schemas.md")
    spec = json.loads(script_path.read_text(encoding="utf-8"))
    engine = args.engine or spec.get("engine", "volcano-stream")
    if engine not in ENGINES:
        die(f"未知引擎 {engine}，可选 {list(ENGINES)}")
    synth = ENGINES[engine]
    gap = float(spec.get("gap", 0.35))
    lines = spec.get("lines") or die("script.json 没有 lines")
    ids = [l.get("id") or f"L{i+1}" for i, l in enumerate(lines)]
    empty = [ids[i] for i, l in enumerate(lines) if not str(l.get("text", "")).strip()]
    if empty:
        die(f"script.json 里这些句子 text 为空：{empty}（模板占位还没填？）")
    for i, l in enumerate([spec, *lines]):
        sp = str(l.get("speaker") or "")
        if engine.startswith("volcano") and ("<" in sp or not sp.isascii()):
            die(f"speaker 还是占位符「{sp[:30]}…」。先跑 voices.py --film {film.name} --preset <组> "
                f"按内容筛选音色，再填 ID（流程见 SKILL.md 第二节）")
    if len(set(ids)) != len(ids):
        die(f"script.json 的句子 id 有重复：{ids}")

    # 行内标记（_markup.py）：[#语气指令] [停顿 0.6]。本地解析、绝不原样发给接口——实测接口会把它们念出来。
    # plans[lid] = [{text, instruction, pause_before}]；instruction 已按 句 > 顶层 解析好。
    plans: dict[str, list[dict]] = {}
    gap_after: dict[str, float] = {}
    for i, line in enumerate(lines):
        lid = ids[i]
        line_ins = line["instruction"] if "instruction" in line else spec.get("instruction")
        try:
            plans[lid] = resolve_markup(parse_markup(str(line["text"])), line_ins)
        except MarkupError as e:
            die(f"{lid}: {e}")
        if not "".join(s["text"] for s in plans[lid]).strip():
            die(f"{lid}: 去掉行内标记后没有要念的字")
        ga = line.get("gapAfter", gap)
        if not isinstance(ga, (int, float)) or ga < 0:
            die(f"{lid}: gapAfter 要是 ≥ 0 的秒数，拿到 {ga!r}")
        gap_after[lid] = float(ga)
    uses_ins = any(s["instruction"] for p in plans.values() for s in p)
    if uses_ins and engine != "volcano-stream":
        print(f"⚠ 语气指令（instruction / [#…]）只有 volcano-stream 认，{engine} 会忽略；"
              f"标记照样从台词里去掉，[停顿] 照样生效", file=sys.stderr)
    for i, l in enumerate([spec, *lines]):
        ct = l.get("contextTexts")
        if isinstance(ct, list) and len(ct) > 1:
            print(f"⚠ {'顶层' if i == 0 else ids[i - 1]} contextTexts 有 {len(ct)} 条：接口只认第一条"
                  f"（实测 [快, 慢] / [慢, 快] 各跟第一条走，仓库 docs/verified/film-narration.md 第 26 节），后面的不生效", file=sys.stderr)

    if args.dry_run:
        DRY_RUN = True
        merged = {**spec, **lines[0]}
        segs = plans[ids[0]]
        print(f"[dry-run] 引擎 {engine}，第一句 {ids[0]}")
        print(f"要念的字：{''.join(s['text'] for s in segs)}")
        if needs_split(segs):
            for k, s in enumerate(segs):
                print(f"  段 {k + 1}: 前置静音 {s['pause_before']:g}s  指令 {s['instruction'] or '-'}  「{s['text']}」")
            print("（下面只打印第 1 段的请求）")
        if not engine.startswith("volcano"):
            print("（这个引擎不走火山 HTTP，没有请求体可打印）")
            return
        first = next(s for s in segs if s["text"].strip())
        try:
            synth(first["text"], Path(os.devnull), {**merged, "instruction": first["instruction"]})
        except DryRun:
            pass
        return

    vo_dir = out_dir(film, "vo")
    only = set(args.only.split(",")) if args.only else None
    if only and not only <= set(ids):
        die(f"--only 里有不存在的 id：{sorted(only - set(ids))}")
    old_lines = {}
    if only:
        old = film / "narration.json"
        need_file(old, "--only 需要上一版 narration.json 来复用其余句子")
        old_lines = {l["id"]: l for l in json.loads(old.read_text(encoding="utf-8"))["lines"]}

    cursor = 0.0
    result_lines: list[dict] = []
    wav_paths: list[Path] = []
    usage_words = 0
    usage_seconds = 0.0
    low_conf: list[str] = []
    coverage_warn: list[str] = []

    voice_label = spec.get("speaker") or spec.get("voice") or spec.get("sayVoice") or "-"
    print(f"片子: {film.name}   引擎: {engine}   音色: {voice_label}")
    if engine == "volcano-stream" and spec.get("pronunciationDict"):
        print(f"发音词典: {spec['pronunciationDict'].get('tone', [])}")
        for issue in lint_dict(spec, lines):
            print(f"⚠ 发音词典：{issue}", file=sys.stderr)
    print()

    gaps_used: list[float] = []
    for i, line in enumerate(lines):
        lid = ids[i]
        text = "".join(s["text"] for s in plans[lid])     # 要念的字（去掉了行内标记）
        raw = vo_dir / f"{lid}.raw"
        wav = vo_dir / f"{lid}.wav"
        ins_shown = {s["instruction"] for s in plans[lid] if s["instruction"]}
        print(f"[{i+1}/{len(lines)}] {lid}: {text[:46]}" +
              (f"   指令: {' | '.join(sorted(ins_shown))[:40]}" if ins_shown else ""))

        reuse = only is not None and lid not in only
        if reuse:
            prev = old_lines.get(lid)
            if not prev or prev["text"] != text or not wav.exists():
                die(f"{lid} 不在 --only 里，但旧 narration.json/wav 和当前文本对不上，不能复用")
            want_ins = [s["instruction"] for s in plans[lid] if s["text"].strip()]
            want_ins = (want_ins[0] if len(set(want_ins)) == 1 else want_ins) if any(want_ins) else None
            if prev.get("instruction") != want_ins:
                print(f"      ⚠ {lid} 的语气指令和上次合成时不同（上次 {prev.get('instruction')!r}，现在 {want_ins!r}），"
                      f"但它不在 --only 里，复用的是旧音频；要生效把它加进 --only", file=sys.stderr)
            dur = to_wav(wav, raw.with_suffix(".probe.wav"))
            raw.with_suffix(".probe.wav").unlink(missing_ok=True)
            def back(x):   # 绝对秒 -> 句内秒（parts 同样平移）
                y = {**x, "start": round(x["start"] - prev["start"], 3),
                     "end": round(x["end"] - prev["start"], 3)}
                if x.get("parts"):
                    y["parts"] = [back(p) for p in x["parts"]]
                return y
            words = [back(w) for w in prev["words"]]
            print(f"      复用 {dur:.3f}s")
        else:
            merged = {**spec, **line}            # 单句可覆盖音色、语速、发音词典、语气指令
            merged.pop("text", None)
            segs = plans[lid]
            words, seg_spans = [], []
            if not needs_split(segs):
                seg = segs[0]
                one = {**merged, "instruction": seg["instruction"]}
                words, usage = synth(seg["text"], raw, one)
                usage_words += int(usage.get("text_words") or 0)
                usage_seconds += float(usage.get("original_duration") or 0)
                dur = to_wav(raw, wav)           # 以 ffprobe 实测为准
                raw.unlink(missing_ok=True)
                words = restore_dict_words(words, one)
                if not words:
                    print("      ⚠ 接口未返回字幕时间戳（非中英文？say 引擎？），用 Whisper 反推",
                          file=sys.stderr)
                    words = align_with_whisper(wav, text, args.whisper_model)
                    for w in words:
                        w["src"] = "whisper"
            else:
                # 行内标记把这一句切成几段：每段单独合成（各自的语气指令），段前按 [停顿] 垫静音，拼成这一句的 wav。
                # 时间戳逐段平移到句内秒。代价见 _markup.py：接缝像句子边界、每段多一次请求。
                parts: list[Path] = []
                t = 0.0
                for k, seg in enumerate(segs):
                    if seg["pause_before"]:
                        sil = vo_dir / f"{lid}.sil{k}.wav"
                        make_silence(sil, seg["pause_before"])
                        parts.append(sil)
                        t += seg["pause_before"]
                    if not seg["text"].strip():
                        continue
                    one = {**merged, "instruction": seg["instruction"]}
                    sraw = vo_dir / f"{lid}.seg{k}.raw"
                    swav = vo_dir / f"{lid}.seg{k}.wav"
                    sw, usage = synth(seg["text"], sraw, one)
                    usage_words += int(usage.get("text_words") or 0)
                    usage_seconds += float(usage.get("original_duration") or 0)
                    sdur = to_wav(sraw, swav)
                    sraw.unlink(missing_ok=True)
                    sw = restore_dict_words(sw, one)
                    if not sw:
                        print(f"      ⚠ 第 {k + 1} 段接口未返回字幕时间戳，用 Whisper 反推", file=sys.stderr)
                        sw = align_with_whisper(swav, seg["text"], args.whisper_model)
                        for w in sw:
                            w["src"] = "whisper"
                    for w in sw:
                        w2 = {**w, "start": round(w["start"] + t, 3), "end": round(w["end"] + t, 3)}
                        if w.get("parts"):
                            w2["parts"] = [{**p, "start": round(p["start"] + t, 3),
                                            "end": round(p["end"] + t, 3)} for p in w["parts"]]
                        words.append(w2)
                    seg_spans.append({"start": round(t, 3), "end": round(t + sdur, 3),
                                      "instruction": seg["instruction"]})
                    parts.append(swav)
                    t += sdur
                concat_wavs(parts, wav, vo_dir / f"{lid}._parts.txt")
                for p in parts:
                    p.unlink(missing_ok=True)
                dur = to_wav(wav, raw.with_suffix(".probe.wav"))
                raw.with_suffix(".probe.wav").unlink(missing_ok=True)
                print(f"      {len(seg_spans)} 段合成 + {sum(s['pause_before'] for s in segs):g}s 插入静音")

        # 时间戳覆盖率：接口偶尔会吞掉数字/英文的时间戳，提前发现
        said = PUNCT.sub("", "".join(w["w"] for w in words)).lower()
        want = PUNCT.sub("", text).lower()
        if want and len(said) < 0.95 * len(want):
            coverage_warn.append(f"{lid}: 时间戳只覆盖 {len(said)}/{len(want)} 字")

        for w in words:
            # 纯标点 token（stream 引擎会给「——」单独一个带时长的时间戳）不进低置信度清单：
            # 没有可听的字，报出来只是让人去判断一个不存在的问题（ghost-jam F-016：s3:—@2.27s conf 0.329）
            if not "".join(c for c in w["w"] if unicodedata.category(c)[0] not in "PZS"):
                continue
            if w.get("conf") is not None and w["conf"] < LOW_CONFIDENCE:
                low_conf.append(f'{lid}:{w["w"]}@{w["start"]:.2f}s(conf {w["conf"]})')

        abs_words = []
        for w in words:
            item = {"w": w["w"],
                    "start": round(w["start"] + cursor, 3),
                    "end": round(w["end"] + cursor, 3)}
            for extra in ("conf", "src", "alias"):
                if w.get(extra) is not None:
                    item[extra] = w[extra]
            if w.get("parts"):
                item["parts"] = [{**p, "start": round(p["start"] + cursor, 3),
                                  "end": round(p["end"] + cursor, 3)} for p in w["parts"]]
            abs_words.append(item)

        rec = {
            "id": lid, "text": text,
            "start": round(cursor, 3), "end": round(cursor + dur, 3),
            "duration": dur, "words": abs_words,
            "wav": rel(wav, film),
        }
        # 控制字段只在用了时才写
        if reuse:
            for k in ("instruction", "segments"):
                if prev.get(k) is not None:
                    rec[k] = prev[k] if k != "segments" else [
                        {**s, "start": round(s["start"] - prev["start"] + cursor, 3),
                         "end": round(s["end"] - prev["start"] + cursor, 3)} for s in prev[k]]
        else:
            ins = [s["instruction"] for s in plans[lid] if s["text"].strip()]
            if any(ins):
                rec["instruction"] = ins[0] if len(set(ins)) == 1 else ins
            if seg_spans:
                rec["segments"] = [{**s, "start": round(s["start"] + cursor, 3),
                                    "end": round(s["end"] + cursor, 3)} for s in seg_spans]
        this_gap = gap_after[lid]
        if this_gap != gap:
            rec["gapAfter"] = this_gap
        result_lines.append(rec)
        wav_paths.append(wav)
        gaps_used.append(this_gap)
        cursor += dur + this_gap
        if not reuse:
            print(f"      {dur:.3f}s, {len(abs_words)} 个字级时间戳")

    # 拼接：句间垫静音，保证成品时间轴和 narration.json 逐毫秒一致。
    # 片段格式一致（48k 单声道 WAV），concat demuxer + copy 最精确。
    concat = film / "out" / "vo.wav"
    # 句间静音：默认 gap，某句写了 gapAfter 就用它的（每种长度生成一个静音片段）。
    # 全片统一 gap 时文件名和内容与旧版相同（_gap.wav）。
    gap_files: dict[float, Path] = {}
    listing_rows = []
    for n, p in enumerate(wav_paths):
        listing_rows.append(f"file '{p.name}'")
        g = gaps_used[n]
        if n < len(wav_paths) - 1 and g > 0:
            if g not in gap_files:
                gp = vo_dir / ("_gap.wav" if g == gap else f"_gap_{g:g}.wav")
                make_silence(gp, g)
                gap_files[g] = gp
            listing_rows.append(f"file '{gap_files[g].name}'")
    listing = vo_dir / "_concat.txt"
    listing.write_text("\n".join(listing_rows) + "\n", encoding="utf-8")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c", "copy", str(concat)], check=True)

    total = round(cursor - gaps_used[-1], 3)
    payload = {
        "version": 1,
        "audio": rel(concat, film),
        "engine": engine,
        "voice": voice_label,
        "script_hash": script_hash(spec),
        "duration": total,
        "gap": gap,
        "lines": result_lines,
        "words": [w for ln in result_lines for w in ln["words"]],
    }
    spans, spans_bad = spans_or_report(spec, result_lines)
    if spans:
        payload["spans"] = spans       # 只在写了区间标记时出现
    target = film / "narration.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    measured = to_wav(concat, vo_dir / "_probe.wav")
    (vo_dir / "_probe.wav").unlink(missing_ok=True)
    print()
    print(f"✓ out/vo.wav   总长 {total}s（拼接后实测 {measured}s）")
    print(f"✓ narration.json   {len(payload['words'])} 个字级时间戳   script_hash {payload['script_hash']}")
    if usage_words:
        print(f"  计费文本字数合计：{usage_words}")
    if usage_seconds:
        print(f"  计费音频秒数合计：{usage_seconds:.1f}s")
    if abs(measured - total) > 0.05:
        print(f"⚠ 拼接后时长和时间轴差 {measured - total:+.3f}s，检查 gap 静音的采样格式",
              file=sys.stderr)
    for item in coverage_warn:
        print(f"⚠ {item}，那一句的关键词可能查不到", file=sys.stderr)
    if low_conf:
        print()
        print(f"⚠ {len(low_conf)} 个低置信度时间戳（conf < {LOW_CONFIDENCE}），要人听一遍这几处：")
        for item in low_conf[:12]:
            print(f"    {item}")
    print()
    off = narration_offset(film)
    if off:
        print(f"镜头时长按这个来，别手填（成片时间 = 旁白时间 + film.json narrationOffset {off:g}s；"
              f"narration.json 里存的是旁白时间）：")
        for ln in result_lines:
            print(f"  {ln['id']:<6} 成片 {ln['start'] + off:>7.3f} -> {ln['end'] + off:>7.3f}  "
                  f"旁白 {ln['start']:>7.3f} -> {ln['end']:>7.3f}  ({ln['duration']}s)")
    else:
        print("镜头时长按这个来，别手填：")
        for ln in result_lines:
            print(f"  {ln['id']:<6} {ln['start']:>7.3f} -> {ln['end']:>7.3f}  ({ln['duration']}s)")

    if timing_check(film, payload, spec):
        sys.exit(6)
    if spans_bad:
        sys.exit(7)


if __name__ == "__main__":
    main()
