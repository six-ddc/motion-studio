#!/usr/bin/env python3
"""音色筛选：用本片自己的一句台词跑多个候选，出客观指标 + 一条可听的对比样音。

模型没有耳朵。这个脚本只做模型能诚实做到的三件事：
  1. 把候选缩小到「这个账号真的能调」的范围（没授权的会直接报错，列为 ✗）
  2. 给出可测量的属性 —— 基频中位数（音高）、基频跨度（起伏/平板）、
     语速（字/秒）、响度、停顿占比
  3. 把样音按顺序拼成一条，让人 30 秒听完挑一个
「这个音色配不配这片」是审美判断，最后一步由人定。判据流程见 references/voices.md。

用法（任意 cwd）:
    python voices.py --film <slug> --preset historical          # 默认拿 script.json 第一句当样本
    python voices.py --film <slug> --preset documentary --line s3
    python voices.py --film <slug> --voices zh_male_xxx,zh_female_yyy --text "自定样本"
    python voices.py --film <slug> --preset edge-zh             # 没有火山 key 时的兜底候选
    python voices.py --list-presets
    python voices.py --list-catalog --gender 男 --sort f0_med     # 带标签的官方 2.0 音色目录（references/voice-catalog.json）
    python voices.py --film <slug> --voices a,b,c --line s1 --instruction "用低沉、缓慢的语气说" --ab
                                                                # 每个候选带/不带语气指令各合一条，同表对比

产出（films/<slug>/out/voices/）:
    <voice_id>.wav     每个候选一条
    _compare.wav       按表格顺序拼好的对比样音（候选间 0.9s 静音）
    report.json        指标表，选定后把理由抄进 script.json 的 _注释.音色

样本句里的行内标记（[#指令] [停顿 0.6]，见 _markup.py）会被去掉再合成——接口会把它们念出来。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, load_dotenv, out_dir, rel, die  # noqa: E402
import tts  # noqa: E402
from _markup import spoken, parse as parse_markup, MarkupError  # noqa: E402

CATALOG = HERE.parent / "references" / "voice-catalog.json"

# 候选组。来自火山引擎官方音色列表（豆包语音合成模型 2.0）的「场景」标注，
# 不是凭耳朵判断音质。账号没授权的音色会在跑的时候报错，表里标 ✗。
PRESETS: dict[str, list[tuple[str, str]]] = {
    "historical": [
        ("zh_male_ruyayichen_uranus_bigtts", "儒雅逸辰 2.0 · 视频配音"),
        ("zh_male_qingcang_uranus_bigtts", "擎苍 2.0 · 角色扮演/古风"),
        ("zh_female_gufengshaoyu_uranus_bigtts", "古风少御 2.0 · 角色扮演"),
        ("zh_male_yizhipiannan_uranus_bigtts", "译制片男 2.0 · 纪录片腔"),
        ("zh_male_cixingjieshuonan_uranus_bigtts", "磁性解说男声 2.0"),
    ],
    "documentary": [
        ("zh_male_yizhipiannan_uranus_bigtts", "译制片男 2.0"),
        ("zh_male_cixingjieshuonan_uranus_bigtts", "磁性解说男声 2.0"),
        ("zh_male_jieshuoxiaoming_uranus_bigtts", "解说小明 2.0"),
        ("zh_male_m191_uranus_bigtts", "云舟 2.0 · 通用"),
        ("zh_male_baqiqingshu_uranus_bigtts", "霸气青叔 2.0 · 有声阅读"),
    ],
    "product": [
        ("zh_female_vv_uranus_bigtts", "Vivi 2.0 · 通用"),
        ("zh_female_shuangkuaisisi_uranus_bigtts", "爽快思思 2.0"),
        ("zh_male_taocheng_uranus_bigtts", "小天 2.0"),
        ("zh_female_qingxinnvsheng_uranus_bigtts", "清新女声 2.0"),
        ("zh_male_ruyaqingnian_uranus_bigtts", "儒雅青年 2.0"),
    ],
    "story": [
        ("zh_male_xuanyijieshuo_uranus_bigtts", "悬疑解说 2.0 · 有声阅读"),
        ("zh_female_cancan_uranus_bigtts", "知性灿灿 2.0"),
        ("zh_female_wenroushunv_uranus_bigtts", "温柔淑女 2.0"),
        ("zh_male_silang_uranus_bigtts", "四郎 2.0 · 角色扮演"),
        ("zh_female_popo_uranus_bigtts", "婆婆 2.0"),
    ],
    # 无 key 兜底：edge-tts 的中文音色
    "edge-zh": [
        ("zh-CN-YunjianNeural", "云健 · 男 · 体育/激昂"),
        ("zh-CN-YunxiNeural", "云希 · 男 · 青年"),
        ("zh-CN-YunyangNeural", "云扬 · 男 · 新闻播报"),
        ("zh-CN-XiaoxiaoNeural", "晓晓 · 女 · 通用"),
        ("zh-CN-XiaoyiNeural", "晓伊 · 女 · 活泼"),
    ],
}
PUNCT = re.compile(r"[\s，。、；：！？,.;:!?\"'“”‘’()（）《》—…·-]")


def measure(wav: Path, chars: int) -> dict:
    """全部是物理量，不含任何"好不好听"的判断。
    后加的四项（f0_sd_st / n_pause / pause_tot / pause_max / loud_sd_db）回答「平不平」：
    同一句话带/不带语气指令、换音色时，起伏和停顿到底变了多少（仓库 docs/verified/film-narration.md 第 26、27 节用的就是这套量法）。"""
    import numpy as np
    import librosa

    y, sr = librosa.load(str(wav), sr=None, mono=True)
    dur = len(y) / sr
    out = {"duration": round(dur, 3)}
    out["rms_db"] = round(float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)), 1)
    # 停顿占比：低于峰值 -35dB 的帧算静音（含首尾）
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    db = 20 * np.log10(rms + 1e-12)
    out["pause_ratio"] = round(float(np.mean(db < db.max() - 35)), 2)
    # 语速：去掉首尾静音再算，否则接口自带的头尾留白会让快嗓子显得慢
    voiced_t, _ = librosa.effects.trim(y, top_db=35)
    speak = len(voiced_t) / sr
    out["chars_per_sec"] = round(chars / speak, 2) if speak else None
    f0, _, _ = librosa.pyin(y, sr=sr, fmin=60, fmax=500, frame_length=2048)
    vals = f0[~np.isnan(f0)]
    if len(vals):
        out["f0_median"] = round(float(np.median(vals)), 1)
        p10, p90 = np.percentile(vals, [10, 90])
        out["f0_span_st"] = round(float(12 * np.log2(p90 / p10)), 1)  # 半音
        out["f0_sd_st"] = round(float(np.std(12 * np.log2(vals / np.median(vals)))), 2)
    else:
        out["f0_median"] = out["f0_span_st"] = out["f0_sd_st"] = None
    # 句内停顿：10 ms 帧，低于本句 p95 -30 dB 算静音；首尾之间连续 ≥ 0.12 s 的静音算一次停顿（塞音闭塞 < 0.1 s 不算）
    hop = max(1, int(0.01 * sr))
    r2 = librosa.feature.rms(y=y, frame_length=max(hop * 2, int(0.025 * sr)), hop_length=hop)[0]
    d2 = 20 * np.log10(r2 + 1e-9)
    sp = d2 >= np.percentile(d2, 95) - 30
    idx = np.where(sp)[0]
    pauses, run = [], 0
    if len(idx):
        for v in sp[idx[0]:idx[-1] + 1]:
            if not v:
                run += 1
            else:
                if run * 0.01 >= 0.12:
                    pauses.append(run * 0.01)
                run = 0
        segs = [d2[i:i + 10].mean() for i in range(idx[0], idx[-1] - 9, 10) if sp[i:i + 10].mean() > 0.5]
        out["loud_sd_db"] = round(float(np.std(segs)), 2) if segs else None   # 100 ms 窗响度的起伏
    out["n_pause"] = len(pauses)
    out["pause_tot"] = round(sum(pauses), 2)
    out["pause_max"] = round(max(pauses), 2) if pauses else 0.0
    return out


def synth_one(engine: str, vid: str, text: str, dst: Path, rate: int, instruction: str | None = None) -> None:
    raw = dst.with_suffix(".raw")
    if engine == "edge":
        pct = f"{rate:+d}%"
        tts.synth_edge(text, raw, {"voice": vid, "rate": pct})
    else:
        tts.synth_volcano_stream(text, raw, {
            "speaker": vid, "format": "mp3", "sampleRate": 44100,
            "speechRate": rate, "resourceId": "seed-tts-2.0", "instruction": instruction})
    tts.to_wav(raw, dst)
    raw.unlink(missing_ok=True)


def list_catalog(gender: str | None, scene: str | None, sort: str | None, md: bool) -> None:
    """带标签的官方 2.0 音色目录（references/voice-catalog.json）。官方字段 / 名称推断 / 实测分列，来源见文件头 _说明。"""
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    rows = [v for v in cat["voices"] if (not gender or v.get("gender") == gender)
            and (not scene or scene in (v.get("scene") or ""))]
    if sort:
        rows.sort(key=lambda v: ((v.get("measured") or {}).get(sort) is None, (v.get("measured") or {}).get(sort) or 0))
    cols = ["f0_med", "f0_sd_st", "cps", "pause_tot", "loud_sd_db", "centroid_hz"]
    print("| 名称 | 音色 ID | 性别 | 官方场景 | 名称推断 | 官方特殊标签 | 基频中位 Hz | 基频 sd 半音 | 语速 字/秒 | 句内停顿 s | 响度起伏 dB | 谱质心 Hz | 本账号 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for v in rows:
        m = v.get("measured") or {}
        hint = " ".join(x for x in (v.get("age_by_name"), "角色腔" if v.get("character_voice_by_name") else None) if x)
        print(f"| {v['name']} | `{v['id']}` | {v.get('gender') or ''} | {v.get('scene') or ''} | {hint} | "
              f"{v.get('tags') or ''} | " + " | ".join(str(m.get(c, '')) for c in cols) +
              f" | {'✓' if '✓' in v.get('authorized', '') else '✗'} |")
    if not md:
        print()
        print(f"{len(rows)} 个。量法与局限见 {CATALOG.name} 的 _说明（单次合成，只够分档）；"
              f"挑出候选后用 --voices a,b,c --line <本片一句> 在本片台词上重测、人听定稿")


def main() -> None:
    ap = parser(__doc__)
    ap.add_argument("--preset", default=None, choices=list(PRESETS))
    ap.add_argument("--voices", default=None, help="逗号分隔的音色 ID，覆盖 preset")
    ap.add_argument("--line", default=None, help="用 script.json 里这一句当样本（默认第一句）")
    ap.add_argument("--text", default=None, help="直接给样本文本")
    ap.add_argument("--speech-rate", type=int, default=0,
                    help="火山 speech_rate（-50..100）；edge 按百分比解释")
    ap.add_argument("--instruction", default=None,
                    help="语气指令（发给 context_texts）。只有 volcano-stream 认")
    ap.add_argument("--ab", action="store_true", help="每个候选带/不带 --instruction 各合一条")
    ap.add_argument("--list-presets", action="store_true")
    ap.add_argument("--list-catalog", action="store_true", help="列出带标签的官方 2.0 音色目录")
    ap.add_argument("--gender", choices=["男", "女"], help="--list-catalog 过滤")
    ap.add_argument("--scene", help="--list-catalog 过滤官方场景（子串）")
    ap.add_argument("--sort", help="--list-catalog 按实测字段排序：f0_med f0_sd_st cps pause_tot loud_sd_db centroid_hz")
    ap.add_argument("--md", action="store_true", help="--list-catalog 只输出 markdown 表")
    args = ap.parse_args()

    if args.list_catalog:
        list_catalog(args.gender, args.scene, args.sort, args.md)
        return
    if args.list_presets:
        for k, v in PRESETS.items():
            print(f"{k}:")
            for vid, name in v:
                print(f"    {vid:<46} {name}")
        return
    if not (args.preset or args.voices):
        die("给 --preset 或 --voices。--list-presets 看候选组，--list-catalog 看全部官方 2.0 音色")
    if args.ab and not args.instruction:
        die("--ab 要配 --instruction")

    film = resolve_film(args.film, args.films_dir)
    load_dotenv(film)
    text = args.text
    if not text:
        sp = film / "script.json"
        if not sp.exists():
            die("没有 script.json 时用 --text 给样本。样本应是本片真实台词，"
                "通用句子测不出音色和内容的配合")
        lines = json.loads(sp.read_text(encoding="utf-8"))["lines"]
        pick = next((l for l in lines if l.get("id") == args.line), None) if args.line else lines[0]
        if not pick:
            die(f"script.json 里没有句子 {args.line}")
        text = pick["text"]
    try:
        if parse_markup(text) and len(parse_markup(text)) > 1:
            print("⚠ 样本句里有句中标记（[#…] / [停顿]）：这里只去掉标记整句合成，不分段——要听分段效果跑 tts.py")
        text = spoken(text)
    except MarkupError as e:
        die(str(e))

    engine = "edge" if args.preset == "edge-zh" or (args.voices and "Neural" in args.voices) \
        else "volcano"
    if args.instruction and engine != "volcano":
        die("语气指令只有火山 2.0（volcano-stream）认")
    cands = ([(v.strip(), "") for v in args.voices.split(",")] if args.voices
             else PRESETS[args.preset])
    variants = [None, args.instruction] if args.ab else [args.instruction]
    chars = len(PUNCT.sub("", text))
    vdir = out_dir(film, "voices")

    print(f"样本：{text}（{chars} 字）  引擎 {engine}  语速参数 {args.speech_rate}" +
          (f"  指令「{args.instruction}」" + ("（带/不带各一条）" if args.ab else "") if args.instruction else ""))
    print()
    rows, ok_files = [], []
    for vid, name in cands:
        for ins in variants:
            dst = vdir / (f"{vid}+ins.wav" if ins else f"{vid}.wav")
            label = (name or vid) + (" +指令" if ins else "")
            try:
                synth_one(engine, vid, text, dst, args.speech_rate, ins)
            except SystemExit as e:  # tts 里失败走 sys.exit(str)
                msg = str(e.code).strip().splitlines()
                rows.append({"voice": vid, "name": name, "instruction": ins,
                             "error": (msg[-1] if msg else "失败")[:120]})
                print(f"✗ {label}: {rows[-1]['error']}")
                break
            m = measure(dst, chars)
            rows.append({"voice": vid, "name": name, "instruction": ins, **m, "wav": rel(dst, film)})
            ok_files.append(dst)
            print(f"✓ {label}")

    report = {"text": text, "engine": engine, "speech_rate": args.speech_rate,
              "instruction": args.instruction, "ab": args.ab, "rows": rows}
    (vdir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n",
                                      encoding="utf-8")

    print()
    print("| # | 音色 | 指令 | 基频中位 Hz | 基频跨度 半音 | 基频 sd 半音 | 语速 字/秒 | 句内停顿 次/s | 响度起伏 dB | 响度 dBFS | 停顿占比 | 时长 s |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    n = 0
    for r in rows:
        if "error" in r:
            print(f"| ✗ | {r['name'] or r['voice']} | | 不可用：{r['error']} | | | | | | | | |")
            continue
        n += 1
        print(f"| {n} | {r['name'] or r['voice']} | {'✓' if r['instruction'] else '-'} | {r['f0_median']} | "
              f"{r['f0_span_st']} | {r['f0_sd_st']} | {r['chars_per_sec']} | {r['n_pause']}/{r['pause_tot']} | "
              f"{r.get('loud_sd_db')} | {r['rms_db']} | {r['pause_ratio']} | {r['duration']} |")

    if len(ok_files) > 1:
        gap = vdir / "_gap.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.9",
                        "-c:a", "pcm_s16le", str(gap)], check=True)
        listing = vdir / "_list.txt"
        listing.write_text("".join(f"file '{f.name}'\nfile '{gap.name}'\n" for f in ok_files),
                           encoding="utf-8")
        compare = vdir / "_compare.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
                        "-safe", "0", "-i", str(listing), "-c", "copy", str(compare)], check=True)
        listing.unlink()
        gap.unlink()
        print()
        print(f"✓ 对比样音 {rel(compare, film)}（顺序同表格 #）")
    print(f"✓ 指标 {rel(vdir / 'report.json', film)}")
    print()
    print("这些数字只描述声音的物理属性，不回答「配不配」。按 references/voices.md 的判据流程，"
          "由人听 _compare.wav 定稿；没人在场就按指标选，并在 review_log 标「音色未经人耳确认」。")
    if args.ab:
        print("TTS 不确定：带/不带指令各一条的差，和同一请求连发两次的差可能同量级（仓库 docs/verified/film-narration.md 第 26 节）。"
              "要下结论「指令有用」，每种条件合几次比分布。")
    if not ok_files:
        sys.exit(1)


if __name__ == "__main__":
    main()
