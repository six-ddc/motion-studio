#!/usr/bin/env python3
"""narration.json -> SRT / ASS 字幕文件（字幕的「导出文件」那条路）。

canvas 内逐词高亮那条路不需要本脚本：时间数据用 runtime/narration.js 的 captionAt()，绘制归 film-typography 的 runtime/text.js。
两条路的代价对比见 SKILL.md「字幕」。

用法（任意 cwd）:
    python subs.py --film <slug>                    # -> out/subs.srt
    python subs.py --film <slug> --format ass       # -> out/subs.ass（\\kf 逐词填色）
    python subs.py --film <slug> --format ass --width 1920 --height 1080 --font "Source Han Sans SC"

烧进画面（硬字幕，不可关）:
    ffmpeg -i out/final-9x16.mp4 -vf "subtitles=out/subs.ass" -c:a copy out/burned.mp4
挂软字幕轨（可关，MP4 只支持纯文本 mov_text，逐词填色会丢）:
    ffmpeg -i out/final-9x16.mp4 -i out/subs.srt -c copy -c:s mov_text out/withsubs.mp4
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, need_file, rel, die  # noqa: E402
from _offset import narration_offset  # noqa: E402


PUNCT_END = tuple("，。、；：！？,.;:!?")


def wlen(w: str) -> float:
    """显示宽度近似：汉字 1，拉丁字母 0.55。"""
    return sum(0.55 if ord(c) < 128 else 1 for c in w)


def chunk_words(words, max_chars):
    """先按标点切成意群，再把意群装箱到 ≤max_chars；单个意群超长时**均分**，
    不做贪心截断——贪心会留下「面。」这种 0.26 秒一闪的孤字（实测过）。
    runtime/narration.js 的 captionAt() 用同一算法，两条路的断行一致。"""
    phrases, cur = [], []
    for w in words:
        cur.append(w)
        if w["w"].endswith(PUNCT_END):
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    pieces = []
    for ph in phrases:
        total = sum(wlen(w["w"]) for w in ph)
        n = max(1, -(-int(total + 0.999) // max_chars))
        if n == 1:
            pieces.append(ph)
            continue
        # 均分：按累计宽度切到 n 份
        target, part, acc, k = total / n, [], 0.0, 1
        for w in ph:
            part.append(w)
            acc += wlen(w["w"])
            if acc >= target * k - 1e-6 and k < n:
                pieces.append(part)
                part, k = [], k + 1
        if part:
            pieces.append(part)
    chunks, cur, length = [], [], 0.0
    for pc in pieces:
        L = sum(wlen(w["w"]) for w in pc)
        if cur and length + L > max_chars:
            chunks.append(cur)
            cur, length = [], 0.0
        cur = cur + pc
        length += L
    if cur:
        chunks.append(cur)
    return chunks


def _latin(c: str) -> bool:
    return bool(c) and c.isascii() and c.isalnum()


def join_words(ws) -> str:
    """拉丁词与相邻字之间补空格，前一个词以标点结尾时不补（与 narration.js 的 spacing() 同规则）。
    接口返回的 token 不带空格，实测不补会出「调用seek」。"""
    out, prev = "", ""
    for w in ws:
        t = w["w"]
        if prev and (_latin(prev[-1]) or _latin(t[:1])) and not prev.endswith(PUNCT_END):
            out += " "
        out += t
        prev = t
    return out


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6_000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def as_srt(blocks) -> str:
    out = []
    for i, blk in enumerate(blocks, 1):
        out.append(str(i))
        out.append(f"{srt_time(blk['start'])} --> {srt_time(blk['end'])}")
        out.append(blk["text"])
        out.append("")
    return "\n".join(out)


ASS_HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{size},&H00FFFFFF,&H0080DE4A,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,{outline},0,2,60,60,{marginv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def as_ass(blocks, width, height, font, size, karaoke) -> str:
    head = ASS_HEAD.format(
        w=width, h=height, font=font, size=size,
        outline=max(2, round(size * 0.1)), marginv=round(height * 0.08),
    )
    rows = []
    for blk in blocks:
        if karaoke:
            # \kf 让播放器按百分之一秒逐词填色；SecondaryColour 是已念过的颜色
            # \\k 空拍补上词间停顿，否则填色会越走越超前于人声
            parts, cursor = [], blk["start"]
            for i, w in enumerate(blk["words"]):
                gap_cs = int(round((w["start"] - cursor) * 100))
                if gap_cs > 0:
                    parts.append(f"{{\\k{gap_cs}}}")
                if w["end"] <= w["start"]:
                    # volcano-audio 的标点 token 是零宽的：不单独占 \\kf 时长，跟在前一个词后面
                    parts.append(w["w"])
                    cursor = max(cursor, w["end"])
                    continue
                cs = max(1, int(round((w["end"] - w["start"]) * 100)))
                sep = " " if i and join_words([blk["words"][i-1], w]).count(" ") else ""
                parts.append(f"{{\\kf{cs}}}{sep}{w['w']}")
                cursor = w["end"]
            text = "".join(parts)
        else:
            text = blk["text"]
        rows.append(
            f"Dialogue: 0,{ass_time(blk['start'])},{ass_time(blk['end'])},Main,,0,0,0,,{text}"
        )
    return head + "\n".join(rows) + "\n"


def main() -> None:
    ap = parser(__doc__)
    ap.add_argument("--format", default="srt", choices=["srt", "ass"])
    ap.add_argument("--max-chars", type=int, default=18,
                    help="每块最大字数，竖版建议 14-18")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--font", default=None, help="必填：用本片 style_guide 定的字体，skill 不给默认")
    ap.add_argument("--size", type=int, default=0,
                    help="字号，0 = 按短边 4.4%% 自动")
    ap.add_argument("--no-karaoke", action="store_true",
                    help="ASS 不加逐词填色标签")
    ap.add_argument("--out", default=None)
    ap.add_argument("--offset", type=float, default=None,
                    help="字幕整体平移秒数。默认读 film.json 的 narrationOffset（字幕挂在成片上，用成片时间）；"
                         "给 out/vo.wav 单独配字幕时传 0")
    args = ap.parse_args()

    film = resolve_film(args.film, args.films_dir)
    if args.format == "ass" and not args.font:
        die("ASS 需要 --font（按本片 style_guide 定；SRT 的字体由播放器决定所以不需要）")
    data = json.loads(need_file(film / "narration.json", "先跑 tts.py 或 align.py --from").read_text(encoding="utf-8"))
    if not data.get("words"):
        die("narration.json 里没有字级时间戳。先跑 tts.py 或 align.py --from")

    off = narration_offset(film) if args.offset is None else args.offset

    def sh(w):
        return {**w, "start": w["start"] + off, "end": w["end"] + off}

    blocks = []
    for line in [{**sh(l), "words": [sh(w) for w in l.get("words") or []]} for l in data["lines"]]:
        if not line.get("words"):
            blocks.append({"start": line["start"], "end": line["end"],
                           "text": line["text"], "words": []})
            continue
        for chunk in chunk_words(line["words"], args.max_chars):
            blocks.append({
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "text": join_words(chunk),
                "words": chunk,
            })

    size = args.size or round(min(args.width, args.height) * 0.044)
    text = (as_srt(blocks) if args.format == "srt"
            else as_ass(blocks, args.width, args.height, args.font, size,
                        not args.no_karaoke))

    target = Path(args.out) if args.out else film / "out" / f"subs.{args.format}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    print(f"✓ {rel(target, film)}  {len(blocks)} 条字幕  （成片时间，片头偏移 +{off:g}s）")


if __name__ == "__main__":
    main()
