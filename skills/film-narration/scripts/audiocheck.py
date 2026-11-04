#!/usr/bin/env python3
"""声音质量门（可选）：像审画面一样审声音。量四件事，每件说清"它测的量"和"你可能以为它测的量"。

用法（任意 cwd）:
    python audiocheck.py --film <slug>                    # 量 out/final-<format>.mp4（gates.json 的门会传 --mp4）
    python audiocheck.py --film <slug> --mix out/x.wav    # 量任意音频/视频文件
    python audiocheck.py --film <slug> --only open,peak   # 只量其中几项

  open  开场静音   成片前 --open-sec 秒（默认 0.5）的 RMS < --open-db（默认 -45 dBFS）判红；第一窗（0–50 ms）就低于阈值判黄
  tone  闷不闷     频谱质心与 <400 Hz 功率占比。音效轨 out/sfx.wav 判红/黄；混音只在无人声时判（人声本身就有大量
                   <400 Hz 能量）；配乐轨最多判黄（贝斯本来就在低频）
  tail  尾巴       混音最后一个可闻窗（≥ -60 dBFS）离画面结束多远；配乐文件比画面短（被截掉/没写够）或长出很多且结尾
                   没收（被 mux 的 -t 硬切）
  peak  真峰       成片 true peak（loudnorm 口径，两位小数）> -1.0 dBTP 红，> -1.5 黄

阈值都可在 film.json 声明里给：{"audiocheck": {"openSec": 0.5, "openDb": -45, "lowWarn": 0.7, "lowFail": 0.8,
"centroidWarn": 800, "centroidFail": 500, "tailSec": 1.0}}，命令行同名参数优先。
退出码：0 通过（可以有黄）；1 有红；2 输入不全（没有成片也没给 --mix）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, rel, die, check_param  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _audio as A  # noqa: E402

DEFAULTS = {"openSec": 0.5, "openDb": -45.0, "lowWarn": 0.70, "lowFail": 0.80, "centroidWarn": 800.0, "centroidFail": 500.0,
            "tailSec": 1.0}
# 默认阈值的来历：tencent-5y 第一版成片 <400 Hz 81.6%、质心 492 Hz（用户嫌闷），改亮后 57.7% / 2304 Hz（本门同口径复量）
MARK = {"ok": "✓", "warn": "⚠", "fail": "✗"}


class Report:
    def __init__(self):
        self.rows = []

    def add(self, item, level, msg, what=None):
        self.rows.append((item, level, msg, what))

    def print(self):
        for item, level, msg, what in self.rows:
            print(f"{MARK[level]} {item:4}  {msg}")
            if what and level != "ok":
                print(f"        {what}")
        reds = sum(1 for r in self.rows if r[1] == "fail")
        yel = sum(1 for r in self.rows if r[1] == "warn")
        print(f"\n{'✗ audiocheck 不合格' if reds else '✓ audiocheck 通过'}：{reds} 红 {yel} 黄 / {len(self.rows)} 项")
        return 1 if reds else 0


def find_target(film: Path, cfg: dict, args) -> Path:
    for p in (args.mix, args.mp4):
        if p:
            q = Path(p).expanduser()
            q = q if q.is_absolute() else film / q
            if not q.exists():
                die(f"找不到 {q}", 2)
            return q
    fmts = [cfg.get("format")] + list(cfg.get("formats") or [])
    for f in [x for x in fmts if x] + [None]:
        q = film / "out" / (f"final-{f}.mp4" if f else "final.mp4")
        if q.exists():
            return q
    die("没有成片 out/final-<format>.mp4（先 mux.sh 合流），或用 --mix 指定要量的文件", 2)


def judge_tone(st: dict, th: dict, max_level="fail") -> str:
    if st["low"] is None:
        return "ok"
    lvl = "ok"
    if st["low"] > th["lowWarn"] or st["centroid"] < th["centroidWarn"]:
        lvl = "warn"
    if max_level == "fail" and (st["low"] > th["lowFail"] or st["centroid"] < th["centroidFail"]):
        lvl = "fail"
    return lvl


def main() -> None:
    ap = parser(__doc__)
    ap.add_argument("--mp4", help="要量的成片（gates 的 mp4: optional 会传绝对路径）")
    ap.add_argument("--mix", help="要量的任意音频/视频文件，相对片子目录或绝对路径（优先于 --mp4）")
    ap.add_argument("--sfx", help="音效轨（默认 out/sfx.wav，存在才量）")
    ap.add_argument("--music", help="配乐文件（默认取合流记录 out/.render/<成片名>.mux.json 里的 music）")
    ap.add_argument("--only", help="逗号分隔：open,tone,tail,peak")
    for k, v in DEFAULTS.items():
        ap.add_argument("--" + "".join("-" + c.lower() if c.isupper() else c for c in k), dest=k, type=float, help=f"默认 {v}")
    args = ap.parse_args()
    film = resolve_film(args.film, args.films_dir)
    cfg = json.loads((film / "film.json").read_text(encoding="utf-8"))
    param = check_param(film, "audiocheck")
    th = dict(DEFAULTS)
    if isinstance(param, dict):
        unknown = set(param) - set(DEFAULTS)
        if unknown:
            die(f"film.json checks.audiocheck 有不认识的参数：{', '.join(sorted(unknown))}（认：{', '.join(DEFAULTS)}）", 2)
        th.update({k: float(v) for k, v in param.items()})
    th.update({k: getattr(args, k) for k in DEFAULTS if getattr(args, k) is not None})
    only = set(args.only.split(",")) if args.only else {"open", "tone", "tail", "peak"}
    bad = only - {"open", "tone", "tail", "peak"}
    if bad:
        die(f"--only 不认识：{', '.join(sorted(bad))}", 2)

    target = find_target(film, cfg, args)
    durs = A.probe_durations(target)
    try:
        x = A.decode(target)
    except A.NoAudioStream:
        die(f"{rel(target, film)} 没有音轨（只有画面）：先 mux.sh 合流出带声音的成片，或用 --mix 指定要量的文件", 2)
    alen = len(x) / A.SR
    vdur = durs["video"]
    w = A.window_rms_db(x, win=0.05)
    R = Report()
    print(f"audiocheck  {rel(target, film)}  音频 {alen:.2f}s" + (f"  画面 {vdur:.2f}s" if vdur else "  （无视频流）"))

    # 人声在不在：有 narration.json 且 out/vo.wav 不是静音占位（tencent-5y 就是静音占位）
    vo = film / "out" / "vo.wav"
    voiced = (film / "narration.json").exists() and vo.exists() and A.rms_db(A.decode(vo)) > -60
    # 配乐：--music，否则合流记录 out/.render/<成片名>.mux.json 里的 inputs.music
    mus = args.music
    mux_rec = film / "out" / ".render" / f"{target.stem}.mux.json"
    if not mus and mux_rec.exists():
        mus = (json.loads(mux_rec.read_text(encoding="utf-8")).get("inputs", {}).get("music") or {}).get("path")
    mus_p = None
    if mus:
        mus_p = Path(mus).expanduser() if Path(mus).is_absolute() else film / mus
        if not mus_p.exists():
            R.add("tail", "warn", f"配乐 {mus} 不存在（合流记录里有、文件没了），配乐两项不量")
            mus_p = None

    if "open" in only:
        n = int(th["openSec"] * A.SR)
        r = A.rms_db(x[:n])
        onset = next((i * 0.05 for i, v in enumerate(w) if v >= th["openDb"]), None)
        what = (f"测的：前 {th['openSec']:g}s 的数字电平（RMS，dBFS，混音后、解码后）。不是：响度感知、更不是\"开场的声音合不合适\"——"
                f"一层 -40 dBFS 的底噪就能过；旁白偏移 narrationOffset 期间要有声，靠配乐/底噪铺上，而不是把阈值调低")
        on = "从未" if onset is None else f"{onset:.2f}s"
        if r < th["openDb"]:
            R.add("open", "fail", f"开场静音：前 {th['openSec']:g}s RMS {r:.1f} dBFS < {th['openDb']:g}，第一个可闻窗在 {on}"
                  f"（用户反馈过：开场无声、人声突兀进来）", what)
        elif w[0] < th["openDb"]:
            R.add("open", "warn", f"第 0 帧没有声音：前 {th['openSec']:g}s RMS {r:.1f} dBFS 够了，但第一个可闻窗在 {on}", what)
        else:
            R.add("open", "ok", f"开场有声：前 {th['openSec']:g}s RMS {r:.1f} dBFS（阈值 {th['openDb']:g}）")

    if "tone" in only:
        what = ("测的：功率谱里能量落在哪（质心 = 功率加权平均频率；<400 Hz 占比）。不是：\"亮不亮、好不好听\"——"
                "一声很响的低频撞击能把占比拉满，耳朵记住的却可能是上面的镲。修法是给音效补 1–8 kHz 起音、低频层降增益/高通，然后人听")
        tracks = []
        sfx = Path(args.sfx) if args.sfx else film / "out" / "sfx.wav"
        sfx = sfx if sfx.is_absolute() else film / sfx
        if sfx.exists():
            tracks.append(("音效轨", sfx, "fail"))
        if mus_p is not None:
            tracks.append(("配乐轨", mus_p, "warn"))
        for name, p, cap in tracks:
            st = A.band_stats(A.decode(p))
            lvl = judge_tone(st, th, cap)
            if st["low"] is None:
                R.add("tone", "warn", f"{name} {rel(p, film)} 全程低于 -60 dBFS，没法量")
                continue
            msg = (f"{name} {rel(p, film)}：质心 {st['centroid']:.0f} Hz、<400 Hz 占 {st['low']:.1%}、>2.5 kHz 占 {st['high']:.1%}"
                   + ("" if lvl == "ok" else f"（阈值 <400 Hz {th['lowWarn']:.0%}/{th['lowFail']:.0%}、质心 {th['centroidWarn']:.0f}/{th['centroidFail']:.0f} Hz"
                      + ("；配乐的贝斯本来在低频，最多判黄" if cap == "warn" else "") + "）"))
            R.add("tone", lvl, msg, what)
        st = A.band_stats(x)
        if st["low"] is not None:
            msg = f"混音：质心 {st['centroid']:.0f} Hz、<400 Hz 占 {st['low']:.1%}、>2.5 kHz 占 {st['high']:.1%}"
            if voiced:
                R.add("tone", "ok", msg + "（有人声，混音只报数不判：人声基频与第一共振峰就在这一带）")
            else:
                lvl = judge_tone(st, th)
                R.add("tone", lvl, msg + ("" if lvl == "ok" else f"（无人声片按混音判；tencent-5y 嫌闷那版是 81.6% / 492 Hz）"), what)

    if "tail" in only:
        what = ("测的：混音最后一个 ≥ -60 dBFS 的 50 ms 窗离画面结束多远，以及配乐文件时长 vs 画面时长。不是：\"结尾收得好不好\"——"
                "一个刻意的静音定格也会被报出来，是刻意的就在 style_guide 写一句、把 tailSec 调大")
        last = max([i for i, v in enumerate(w) if v >= -60] + [-1]) * 0.05 + 0.05
        ref = vdur or alen
        gap = ref - last
        if mus_p is not None:
            md = A.probe_durations(mus_p)["format"] or 0
            if md < ref - 0.1:
                lvl = "fail" if gap > th["tailSec"] else "warn"
                R.add("tail", lvl, f"配乐 {rel(mus_p, film)} {md:.2f}s 比画面 {ref:.2f}s 短 {ref - md:.2f}s"
                      + (f"，片尾 {gap:.2f}s 数字静音" if gap > th["tailSec"] else "（别的层盖住了片尾）"), what)
            elif md > ref + 0.5 and A.rms_db(x[-int(0.1 * A.SR):]) > A.rms_db(x) - 12:
                R.add("tail", "warn", f"配乐 {md:.2f}s 比画面长 {md - ref:.2f}s，成片最后 0.1s 仍有 {A.rms_db(x[-int(0.1 * A.SR):]):.1f} dBFS："
                      f"被 mux 的 -t 硬切，结尾没收（music.py 按片长生成、最后 0.25s 淡出）", what)
            else:
                R.add("tail", "ok" if gap <= th["tailSec"] else "fail",
                      f"配乐 {md:.2f}s / 画面 {ref:.2f}s；最后可闻 {last:.2f}s" + (f"，片尾 {gap:.2f}s 数字静音" if gap > th["tailSec"] else ""), what)
        elif gap > th["tailSec"]:
            R.add("tail", "warn", f"声音在 {last:.2f}s 就没了，画面到 {ref:.2f}s：片尾 {gap:.2f}s 数字静音（没有配乐记录，判黄）", what)
        else:
            R.add("tail", "ok", f"最后可闻 {last:.2f}s / 画面 {ref:.2f}s")
        if vdur and durs["audio"] and durs["audio"] < vdur - 0.1:
            R.add("tail", "warn", f"音频流 {durs['audio']:.2f}s 比视频流 {vdur:.2f}s 短（播放器会在片尾静音）", what)

    if "peak" in only:
        L = A.loudness(target)
        what = ("测的：解码后的 true peak（4× 过采样估计）。修法先降 mux.sh --lufs；--limit auto 也能压峰，但它会压坏人声，"
                "和念读核验 align.py --verify 打架（ghost-jam 实测 98.9% → 96.7% 掉过 97% 线）——旁白片加了必须重跑 --verify")
        lvl = "fail" if L["tp"] > -1.0 else "warn" if L["tp"] > -1.5 else "ok"
        R.add("peak", lvl, f"true peak {L['tp']:.2f} dBTP（> -1.0 红 / > -1.5 黄）  响度 {L['I']:.1f} LUFS  LRA {L['lra']:.1f}", what)

    sys.exit(R.print())


if __name__ == "__main__":
    main()
