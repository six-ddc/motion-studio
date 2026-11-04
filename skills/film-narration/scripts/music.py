#!/usr/bin/env python3
"""代码合成配乐（原创、零授权风险、确定性）：先定曲，再把画面事件挂到它的节拍/段落上。

用法（任意 cwd）:
    python music.py --film <slug> --style chip                       # -> out/music.wav + out/music.json
    python music.py --film <slug> --style pluck --drop a2 --final 游戏就成了
    python music.py --film <slug> --style ambient --dry-run          # 只打印段落/小节规划，不合成
    python music.py --list-styles

时刻全部从数据读，不写死秒数：narration.json 的句子时刻 + film.json 的 narrationOffset / narrationTail（片长 =
偏移 + 旁白 + 片尾，与 runtime/narration.js 的 filmDuration 同一口径）；film.json 写了 duration 就用它。
旁白改了重跑本脚本即可（--seed 固定 → 同输入逐字节同输出）。

结构（每种风格都按这个骨架，只换音色和编制）：
    开场 0 → drop     第 0 秒就有声（空气底噪 + 铺底/轻拍），滤波逐渐打开，噪声上扬进 drop
    drop              默认 = 第一句开口；--drop 可指到某句 id / 关键词 / 秒。栅格原点对齐它：drop 落在小节线上
    段落              句子 id 按字母前缀分组（a1 a2 | b1 b2 …；全是同一前缀就一句一段）；--sections 显式给每段首句。
                      段落切点 = 首句开口 − --lead 秒；切点前半小节过门、切点上一声镲；每段换一套和声，
                      隔段加一层（--accent 指定哪几段）
    尾段              最后一段（≥3 段时）鼓退出，只留铺底与高层；--final（默认最后一句开口）落终和弦，余音收到片尾，
                      最后 0.25 s 淡到 0——结尾随画面收，不被 mux 的 -t 硬切
低频克制：贝斯在 175–262 Hz、铺底和声放在 C5 以上、总线 2 阶高通 70 Hz；合成后自测频谱质心与 <400 Hz 占比写进 music.json。

产出 out/music.json 是 out/beats.json 的超集（bpm/beats/downbeats/hits 同名同义），sfx.mjs 的 beat cue 与
runtime motion.js 的 beatGrid(m.bpm, m.offset, m.meter) 直接读它；另有 sections（段落切点与和声换处）、events。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, out_dir, rel, die  # noqa: E402

import numpy as np  # noqa: E402

SR = 48000
METER = 4

# 风格预设：编制与音色的组合，不是审美推荐——哪支片子用哪种、为什么，写进片子的 style_guide。
STYLES = {
    "chip": {"bpm": 120, "air": 0.010,
             "about": "8-bit 芯片：脉冲波十六分琶音 + 三角波贝斯 + 噪声鼓 + 铃声高层",
             "cost": "一听就是游戏/复古；十六分琶音密，旁白多的段落要靠 mux 闪避让路"},
    "pluck": {"bpm": 112, "air": 0.012,
              "about": "明亮拨弦电子：加法合成拨弦（起音亮、尾巴暗）+ 反拍和弦 + 拍手 + 沙锤 + 泵感铺底",
              "cost": "偏广告/科技发布会；高频多，和亮音效叠在一起会抢起音"},
    "ambient": {"bpm": 84, "air": 0.022,
                "about": "温暖铺底：去低频的失谐和声铺 + 空气底噪 + 稀疏铃音，拍点只有轻木块",
                "cost": "推进感弱；画面事件要挂在段落换和声与铃音上，挂鼓点会落空"},
}

# 和声（C 大调级数 → (贝斯根音 midi, 和声音 midi)）。和声音放在 C5 以上：铺底不落进 <400 Hz
CH = {"I": (48, [72, 76, 79, 84]), "V": (43, [71, 74, 79, 83]), "vi": (45, [72, 76, 81, 84]),
      "IV": (41, [72, 77, 81, 84]), "iii": (40, [71, 76, 79, 83]), "ii": (50, [74, 77, 81, 86])}
PROGS = [["I", "V", "vi", "IV"], ["vi", "IV", "I", "V"], ["IV", "V", "iii", "vi"]]
OUTRO = ["IV", "V", "I", "I"]
KEYS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5, "F#": -6, "Gb": -6, "G": -5, "Ab": -4, "A": -3, "Bb": -2, "B": -1}
PUNCT = re.compile(r"[\s，。！？、；：,.!?;:—…·“”\"'‘’（）()《》【】\[\]-]+")


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- 时刻
def find_keyword(nar: dict, kw: str) -> float:
    """关键词首字开始的时刻（旁白音频时间）。在去标点空白的字符流里找，查不到报错（不返回 0）。"""
    key = PUNCT.sub("", kw)
    for line in nar.get("lines", []):
        toks = [PUNCT.sub("", w["w"]) for w in line.get("words", [])]
        s = "".join(toks)
        i = s.find(key) if key else -1
        if i < 0:
            continue
        acc = 0
        for tok, w in zip(toks, line["words"]):
            if acc <= i < acc + max(len(tok), 1) and tok:
                return float(w["start"])
            acc += len(tok)
    raise KeyError(kw)


def resolve_time(spec: str, nar: dict | None, lines: dict, off: float, what: str) -> float:
    """--drop / --final / --outro 的取值：句子 id → 开口；数字 → 成片秒；否则当旁白关键词。返回成片时间。"""
    if spec in lines:
        return lines[spec]["start"] + off
    try:
        return float(spec)
    except ValueError:
        pass
    if not nar:
        die(f"{what} {spec!r}：没有 narration.json，只能给秒数")
    try:
        return find_keyword(nar, spec) + off
    except KeyError:
        die(f"{what} {spec!r}：既不是句子 id，也不是数字，旁白里也查不到这个关键词")


def group_sections(line_ids: list[str]) -> list[tuple[str, list[str]]]:
    """按 id 的字母前缀分组（a1 a2 | b1 …）→ [(段名, 句子 id…)]；所有句子同一前缀（s1 s2 …）就一句一段。"""
    pref = [(re.match(r"^([A-Za-z_]+?)\d", i) or re.match(r"^(.*)$", i)).group(1) for i in line_ids]
    if len(set(pref)) <= 1:
        return [(i, [i]) for i in line_ids]
    groups: list[tuple[str, list[str]]] = []
    for i, p in zip(line_ids, pref):
        if groups and groups[-1][0] == p:
            groups[-1][1].append(i)
        else:
            groups.append((p, [i]))
    return groups


def make_plan(film: Path, args) -> dict:
    cfg = json.loads((film / "film.json").read_text(encoding="utf-8"))
    off = float(cfg.get("narrationOffset") or 0)
    tail = float(cfg.get("narrationTail") or 0)
    nar_p = film / "narration.json"
    nar = json.loads(nar_p.read_text(encoding="utf-8")) if nar_p.exists() else None
    lines = {l["id"]: l for l in (nar or {}).get("lines", [])}
    ids = list(lines)
    if args.duration:
        end = float(args.duration)
    elif cfg.get("duration"):
        end = float(cfg["duration"])
    elif nar:
        end = off + float(nar.get("duration") or max(l["end"] for l in lines.values())) + tail
    else:
        die("没有 narration.json，film.json 也没写 duration：用 --duration <秒> 给片长")
    style = STYLES[args.style]

    # 栅格：--beats 跟随已有的节拍栅格；否则按 --bpm（缺省取风格预设）让 drop 落在小节线上
    drop = resolve_time(args.drop, nar, lines, off, "--drop") if args.drop else (off + lines[ids[0]]["start"] if ids else 0.0)
    if args.beats:
        bp = Path(args.beats)
        bp = bp if bp.is_absolute() else film / bp
        if not bp.exists():
            die(f"--beats {bp} 不存在（先跑 beats.py 或去掉 --beats）")
        bj = json.loads(bp.read_text(encoding="utf-8"))
        bpm = float(bj["bpm"])
        first = (bj.get("downbeats") or bj["beats"])[0]
        bar = 60 / bpm * METER
        t0 = first % bar
    else:
        bpm = float(args.bpm or style["bpm"])
        bar = 60 / bpm * METER
        t0 = drop % bar
    if not 30 <= bpm <= 240:
        die(f"bpm {bpm} 超出 30–240")
    spb = 60 / bpm

    # 段落：切点 = 首句开口 − lead
    if args.sections:
        heads = [s.strip() for s in args.sections.split(",") if s.strip()]
        bad = [h for h in heads if h not in lines]
        if bad:
            die(f"--sections 里这些不是句子 id：{', '.join(bad)}")
        groups, cur = [], []
        for i in ids:
            if i in heads and cur:
                groups.append((cur[0], cur))
                cur = []
            cur.append(i)
        if cur:
            groups.append((cur[0], cur))
    elif ids:
        groups = group_sections(ids)
    else:
        groups = []
    parts = []
    if drop > 0.05:
        parts.append({"id": "intro", "role": "intro", "t": 0.0, "lines": []})
    for k, (name, g) in enumerate(groups):
        t = drop if k == 0 else max(drop, lines[g[0]]["start"] + off - args.lead)
        parts.append({"id": name, "role": "body", "t": round(t, 3), "lines": g})
    if not groups:   # 无旁白：drop 起每 8 小节一段
        t, k = drop, 0
        while t < end - bar:
            parts.append({"id": f"p{k + 1}", "role": "body", "t": round(t, 3), "lines": []})
            t += 8 * bar
            k += 1
    # 尾段：默认最后一段（≥3 个正文段时）；--outro none 关掉
    body = [p for p in parts if p["role"] == "body"]
    if args.outro and args.outro != "none":
        ot = resolve_time(args.outro, nar, lines, off, "--outro") - (args.lead if args.outro in lines else 0)
        parts = [p for p in parts if p["t"] < ot - 1e-6] + [{"id": "outro", "role": "outro", "t": round(ot, 3), "lines": []}]
    elif args.outro is None and len(body) >= 3:
        body[-1]["role"] = "outro"
    final = resolve_time(args.final, nar, lines, off, "--final") if args.final else (off + lines[ids[-1]]["start"] if ids else end - 2 * bar)
    final = min(max(final, 0.0), end)
    accent = set(a.strip() for a in args.accent.split(",")) if args.accent else None
    bi = 0
    for p in parts:
        p["bar"] = int(round((p["t"] - t0) / bar)) if p["role"] != "intro" else int(np.floor((0 - t0) / bar)) - 1
        p["barT"] = round(t0 + p["bar"] * bar, 3)
        if p["role"] == "intro":
            p["chords"] = PROGS[0]
            p["accent"] = False
        elif p["role"] == "outro":
            p["chords"] = OUTRO
            p["accent"] = True
        else:
            p["chords"] = PROGS[bi % len(PROGS)]
            p["accent"] = (p["id"] in accent) if accent is not None else bi % 2 == 1
            bi += 1
    beats = [round(t0 + i * spb, 5) for i in range(int((end - t0) / spb) + 1) if t0 + i * spb < end]
    return {"film": film, "cfg": cfg, "nar": nar, "off": off, "tail": tail, "end": end, "bpm": bpm, "spb": spb, "bar": bar,
            "t0": t0, "drop": drop, "final": final, "parts": parts, "beats": beats, "style": args.style}


# ---------------------------------------------------------------- 合成


class Synth:
    def __init__(self, P: dict, seed: int, key: int):
        try:
            from scipy.signal import lfilter, butter, sosfilt
        except ImportError as exc:
            die(f"缺少依赖 {exc.name}：.venv/bin/pip install scipy（librosa 已带）")
        self.lfilter, self.butter, self.sosfilt = lfilter, butter, sosfilt
        self.P, self.key = P, key
        self.rng = np.random.default_rng(seed)
        self.N = int(np.ceil(P["end"] * SR))
        self.out = np.zeros((self.N, 2))
        self._sos = {}

    # -- 基础件
    def tv(self, dur):
        return np.arange(max(1, int(round(dur * SR)))) / SR

    def env(self, n, a=0.002, d=0.1):
        t = np.arange(n) / SR
        return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)

    def lp(self, x, fc):
        a = np.exp(-2 * np.pi * min(fc, SR * 0.45) / SR)
        return self.lfilter([1 - a], [1, -a], x)

    def hp(self, x, fc):
        return x - self.lp(x, fc)

    def noise(self, n, lo, hi):
        """带通白噪声（2 阶 Butterworth）。一阶差分噪声的能量堆在 10–24 kHz，听着是嘶声不是"亮"，所以每处都给上下限。"""
        key = (lo, hi)
        if key not in self._sos:
            self._sos[key] = self.butter(2, [lo, hi], btype="bandpass", fs=SR, output="sos")
        return self.sosfilt(self._sos[key], self.rng.standard_normal(n))

    def m(self, midi):
        return hz(midi + self.key)

    def add(self, sig, t, gain=1.0, pan=0.0):
        i = int(round(t * SR))
        if i >= self.N or i + len(sig) <= 0:
            return
        a, b = max(0, i), min(self.N, i + len(sig))
        s = sig[a - i:b - i] * gain
        self.out[a:b, 0] += s * np.sqrt(0.5 * (1 - pan))
        self.out[a:b, 1] += s * np.sqrt(0.5 * (1 + pan))

    # -- 鼓与打击
    def kick(self, punch=1.0):
        t = self.tv(0.14)
        f = 60 + 150 * np.exp(-t / 0.02)
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.05)
        click = self.noise(len(t), 1000, 8000) * np.exp(-t / 0.002) * 0.8 * punch   # 2 ms 击发：小喇叭上也听得到这一下
        return body * 0.7 + click

    def snare(self):
        t = self.tv(0.16)
        return self.noise(len(t), 1500, 9000) * 0.6 * np.exp(-t / 0.05) + np.sin(2 * np.pi * 220 * t) * 0.25 * np.exp(-t / 0.03)

    def clap(self):
        t = self.tv(0.2)
        nz = self.noise(len(t), 1000, 6000)
        e = sum(np.exp(-np.maximum(t - d, 0) / 0.012) * (t >= d) for d in (0, 0.011, 0.022)) + 0.6 * np.exp(-np.maximum(t - 0.03, 0) / 0.08) * (t >= 0.03)
        return nz * e * 0.35

    def hat(self, open_=False):
        t = self.tv(0.14 if open_ else 0.035)
        return self.noise(len(t), 6000, 12000) * 0.5 * np.exp(-t / (0.06 if open_ else 0.012))

    def shaker(self):
        t = self.tv(0.06)
        return self.noise(len(t), 4000, 10000) * 0.4 * np.minimum(1, t / 0.008) * np.exp(-t / 0.02)

    def wood(self, f=2300):
        t = self.tv(0.09)
        return (0.42 * np.sin(2 * np.pi * f * t) * np.exp(-t * 70) + 0.2 * np.sin(2 * np.pi * f * 1.61 * t) * np.exp(-t * 110)
                + 0.4 * self.noise(len(t), 1000, 6000) * np.exp(-t * 900))

    def crash(self, dur=1.6, soft=False):
        t = self.tv(dur)
        nz = self.noise(len(t), 3000, 11000) if not soft else self.noise(len(t), 1500, 7000)
        return nz * 0.35 * np.exp(-t / (0.45 if not soft else 0.8))

    # -- 音高件
    def pulse(self, f, dur, duty=0.25):
        ph = (f * self.tv(dur)) % 1
        return np.where(ph < duty, 1.0, -1.0)

    def tri(self, f, dur):
        ph = (f * self.tv(dur)) % 1
        return 4 * np.abs(ph - 0.5) - 1

    def pluck(self, f, dur, bright=1.0):
        """加法合成拨弦：高次谐波衰减更快 → 起音亮、尾巴暗。"""
        t = self.tv(dur)
        s = np.zeros_like(t)
        for h in range(1, 13):
            if f * h > 16000:
                break
            s += np.sin(2 * np.pi * f * h * t) / h * np.exp(-t * (6 + 9 * h / bright))
        return s * np.minimum(1, t / 0.002)

    def bell(self, f, dur=0.6):
        t = self.tv(dur)
        return (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 6)
                + 0.08 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 20)) * np.exp(-t / 0.22) * np.minimum(1, t / 0.001)

    def pad(self, notes, dur, fade=0.3, wave="tri", detune=0.004):
        t = self.tv(dur)
        s = np.zeros_like(t)
        for n in notes:
            for d in (-detune, detune):
                f = self.m(n) * (1 + d)
                s += (self.tri(f, dur) if wave == "tri" else np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t))
        e = np.minimum(1, t / fade) * np.minimum(1, (dur - t) / fade)
        return s * e / (2 * len(notes))


CREST_DB = 16   # 峰值因数上限：镲 + 底鼓叠在切点上时峰值比整体高 30 dB，mux 拉响度后 AAC 会过冲（tencent-5y 实测到 -0.2 dBTP）


def limit(x: np.ndarray, S: Synth, crest_db: float) -> np.ndarray:
    """前瞻限幅（向量化）：把峰值压到"有声部分 RMS + crest_db"。前后 5 ms 取最小增益，再 40 ms 一阶平滑，最后硬夹到所需增益。"""
    from scipy.ndimage import minimum_filter1d
    mono = np.abs(x).max(axis=1)
    act = mono[mono > 1e-4]
    if not len(act):
        return x
    ceil = np.sqrt(np.mean(x[mono > 1e-4] ** 2)) * 10 ** (crest_db / 20)
    need = np.minimum(1.0, ceil / np.maximum(mono, 1e-12))
    if need.min() >= 1.0:
        return x
    g = minimum_filter1d(need, size=int(0.01 * SR) + 1)
    a = np.exp(-1 / (0.04 * SR))
    g = np.minimum(S.lfilter([1 - a], [1, -a], g - 1.0) + 1.0, g)    # 从 1 起步的平滑，释放约 40 ms
    g = np.minimum(minimum_filter1d(g, size=int(0.01 * SR) + 1), need)
    return x * g[:, None]


def render(P: dict, seed: int, key: int) -> tuple[np.ndarray, list]:
    S = Synth(P, seed, key)
    st, end, bar, beat, t0 = P["style"], P["end"], P["bar"], P["spb"], P["t0"]
    parts, drop, final = P["parts"], P["drop"], P["final"]
    cuts = [p["t"] for p in parts if p["role"] != "intro" and p["t"] > drop + 1e-3]
    outro_t = next((p["t"] for p in parts if p["role"] == "outro"), float("inf"))

    def part_at(t):
        cur = parts[0]
        for p in parts:
            if p["t"] <= t + 1e-6:
                cur = p
        return cur

    def chord_at(t):
        b = int(np.floor((t - t0) / bar + 1e-6))
        cur = parts[0]
        for p in parts:
            if p["bar"] <= b:
                cur = p
        return CH[cur["chords"][(b - cur["bar"]) % 4]]

    hits = []
    bar0 = int(np.floor((0 - t0) / bar)) - 1
    bar1 = int(np.ceil((end - t0) / bar)) + 1
    for b in range(bar0, bar1):
        tb = t0 + b * bar
        for step in range(16):
            t = tb + step * beat / 4
            if t < -1e-3 or t >= end or t >= final - 0.01:
                continue
            p = part_at(t)
            root, notes = chord_at(t + 1e-6)
            intro, outro, acc = p["role"] == "intro", p["role"] == "outro", p["accent"]
            k_open = min(1.0, max(0.0, t / max(drop, 0.1))) if intro else 1.0      # 开场滤波逐渐打开
            if st == "chip":
                if not outro:
                    if step % 4 == 0:
                        S.add(S.kick(), t, 0.45)
                    if not intro and step in (4, 12):
                        S.add(S.snare(), t, 0.6)
                    if step % 2 == 0:
                        S.add(S.hat(), t, 0.5 if step % 4 else 0.3, pan=0.25)
                    if not intro and step % 4 == 2:
                        S.add(S.hat(True), t, 0.3, pan=-0.2)
                    if step % 2 == 0:
                        d = beat / 2 * 0.9
                        S.add(S.tri(S.m(root + 12), d) * S.env(len(S.tv(d)), 0.003, 0.15), t, 0.13)
                note = notes[step % 4] - 12 + (12 if (step // 4) % 2 else 0)
                d = beat / 4 * 0.95
                sig = S.pulse(S.m(note), d, 0.25) * S.env(len(S.tv(d)), 0.002, 0.08)
                sig = S.lp(sig, 900 + 7000 * k_open) if intro else S.lp(sig, 7000)
                S.add(sig, t, 0.09 if not outro else 0.05, pan=0.3 if step % 2 else -0.3)
                if acc and step % 2 == 0:
                    S.add(S.bell(S.m(notes[(step // 2) % 4] + 12), 0.5), t, 0.06, pan=-0.4 if step % 4 else 0.4)
            elif st == "pluck":
                if not outro:
                    if step % 4 == 0:
                        S.add(S.kick(1.3), t, 0.5 if not intro else 0.3)
                    if not intro and step in (4, 12):
                        S.add(S.clap(), t, 0.7, pan=0.05)
                    S.add(S.shaker(), t, (0.5 if step % 2 else 0.3) * (0.6 if intro else 1), pan=-0.3)
                    if not intro and step % 4 == 2:
                        S.add(S.hat(True), t, 0.25, pan=0.3)
                    if step % 4 == 2 and not intro:
                        d = beat / 2
                        S.add(np.sin(2 * np.pi * S.m(root + 12) * S.tv(d)) * S.env(len(S.tv(d)), 0.004, 0.12), t, 0.2)
                if step % 2 == 0:                                       # 八分拨弦琶音
                    seq = [0, 2, 1, 3, 2, 1, 3, 0]
                    n = notes[seq[(step // 2) % 8]]
                    S.add(S.pluck(S.m(n), 0.45, bright=0.4 + 0.8 * k_open), t, 0.13, pan=0.35 if (step // 2) % 2 else -0.35)
                if not intro and not outro and step in (6, 14):              # 反拍和弦
                    for i, n in enumerate(notes[:3]):
                        S.add(S.pluck(S.m(n), 0.3, bright=1.4), t, 0.05, pan=(i - 1) * 0.4)
                if acc and step % 2 == 1:                                   # 高层：两个八度上的对位
                    S.add(S.pluck(S.m(notes[(step // 2) % 4] + 12), 0.25, bright=2), t, 0.045, pan=-0.5 if step % 4 == 1 else 0.5)
            else:   # ambient
                if not outro and not intro and step in (0, 8):
                    S.add(S.wood(2300 if step == 0 else 1900), t, 0.18, pan=-0.2 if step else 0.2)
                prob = (0.5 if acc else 0.25) * (0.5 if intro else 1)
                if step % 2 == 0 and S.rng.random() < prob:
                    n = notes[int(S.rng.integers(0, 4))] + (12 if S.rng.random() < 0.4 else 0)
                    S.add(S.bell(S.m(n), 1.2), t, 0.05, pan=float(S.rng.uniform(-0.6, 0.6)))
        # 铺底：每小节一个和弦，相邻小节交叠淡入淡出
        if tb + bar > 0 and tb < end:
            p = part_at(max(tb, 0) + 1e-3)
            root, notes = chord_at(tb + 1e-6)
            d = min(bar + 0.3, end - max(tb, 0))
            if d > 0.05:
                wave = "sine" if st == "ambient" else "tri"
                g = {"chip": 0.05, "pluck": 0.05, "ambient": 0.11}[st] * (1.6 if p["role"] == "outro" else 1)
                sig = S.pad(notes[:3], d, fade=0.03 if tb <= 0 else (0.6 if st == "ambient" else 0.3), wave=wave)
                sig = S.lp(sig, 5000 if st != "ambient" else 3500)
                if st == "pluck" and p["role"] == "body":          # 泵感：每拍压一下
                    tt = S.tv(d)
                    sig = sig * (1 - 0.6 * np.exp(-((tt + (max(tb, 0) - tb)) % beat) / 0.12))
                S.add(sig, max(tb, 0), g)
                if st == "ambient" and not (tb < 0):                 # 低一层的根音：很轻，只给和声一个落点
                    S.add(np.sin(2 * np.pi * S.m(root + 24) * S.tv(d)) * np.minimum(1, S.tv(d) / 0.5) * np.minimum(1, (d - S.tv(d)) / 0.5), tb, 0.025)

    # 过门：切点前半小节（ambient 用上扬噪声代替鼓）
    for c in cuts:
        if c >= outro_t + 1e-3 or c >= final:
            continue
        if st == "ambient":
            d = min(beat * 2, c)
            tt = S.tv(d)
            S.add(S.noise(len(tt), 2000, 8000) * (tt / d) ** 2 * 0.2, c - d)
        else:
            g0 = t0 + np.ceil((c - bar / 2 - t0) / (beat / 4)) * beat / 4      # 切点前半小节内的第一个十六分格
            for i in range(8):
                t = g0 + i * beat / 4
                if t < c - 0.02 and t >= 0:
                    S.add(S.snare() if st == "chip" else S.clap(), t, 0.2 + 0.4 * i / 7)
    # 开场噪声上扬进 drop
    if drop > 0.3:
        d = min(1.6, drop)
        tt = S.tv(d)
        S.add(S.noise(len(tt), 1500, 9000) * (tt / d) ** 2 * 0.3, drop - d)
    # 冲击：drop + 每个切点（切点就是画面换段处，事件可以挂在 music.json 的 hits 上）
    for c in ([drop] if drop > 0.3 else []) + cuts:
        if c >= final:
            continue
        S.add(S.crash(soft=st == "ambient"), c, 0.5)
        if st != "ambient":
            S.add(S.kick(), c, 0.5)
        hits.append(round(c, 3))
    # 终和弦：余音收到片尾
    d = end - final
    if d > 0.05:
        root, notes = CH["I"]
        tt = S.tv(d)
        if st == "chip":
            sig = sum(S.pulse(S.m(n), d, 0.5) * 0.3 + S.tri(S.m(n), d) for n in [60] + notes)
            sig = S.lp(sig, 4000)
        elif st == "pluck":
            sig = sum(S.pluck(S.m(n), d, bright=1.5) * 3 for n in [60] + notes) + S.pad(notes, d, fade=0.01, wave="sine") * 2
        else:
            sig = S.pad(notes + [88], d, fade=0.01, wave="sine") * 3
        sig = sig[:len(tt)] * np.exp(-tt / max(1.4, d / 2.5))
        S.add(sig, final, 0.12)
        S.add(S.bell(S.m(notes[-1] + 12), min(d, 2.0)), final, 0.08)
        S.add(S.crash(dur=min(d, 2.5), soft=st == "ambient"), final, 0.6)
        if st != "ambient":
            S.add(S.kick(), final, 0.7)
        hits.append(round(final, 3))
    # 空气底噪：第 0 秒起一直在（bed），2–8 kHz 带通，不占人声基频带
    air = S.noise(S.N, 2000, 8000)
    S.out += (air * STYLES[st]["air"])[:, None]
    # 总线：2 阶高通 70 Hz → 开头 5 ms / 结尾 0.25 s 淡变 → 峰值 -3 dBFS
    sos = S.butter(2, 70, btype="highpass", fs=SR, output="sos")
    out = S.sosfilt(sos, S.out, axis=0)
    out = limit(out, S, CREST_DB)
    n_in, n_out = int(0.005 * SR), int(min(0.25, end / 4) * SR)
    out[:n_in] *= np.linspace(0, 1, n_in)[:, None]
    out[-n_out:] *= np.linspace(1, 0, n_out)[:, None] ** 2
    peak = np.max(np.abs(out))
    out = out / peak * 10 ** (-3 / 20) if peak > 0 else out
    return out.astype(np.float32), hits


def main() -> None:
    ap = parser(__doc__)
    ap.add_argument("--style", choices=sorted(STYLES), help="编制预设（--list-styles 看各自的代价）；必填，套件不替片子选")
    ap.add_argument("--list-styles", action="store_true", help="列出风格预设后退出")
    ap.add_argument("--bpm", type=float, help="速度（缺省取风格预设）")
    ap.add_argument("--beats", help="跟随已有节拍栅格（如 out/beats.json）：bpm 与小节相位取它的，drop 不再强制落在小节线上")
    ap.add_argument("--key", default="C", choices=sorted(KEYS), help="调（移调半音，默认 C）")
    ap.add_argument("--drop", help="全编制进来的时刻：句子 id / 关键词 / 成片秒（默认第一句开口）")
    ap.add_argument("--final", help="终和弦时刻：句子 id / 关键词 / 成片秒（默认最后一句开口）")
    ap.add_argument("--outro", help="尾段（鼓退出）起点：句子 id / 关键词 / 秒；none = 不要尾段（默认 ≥3 段时取最后一段）")
    ap.add_argument("--sections", help="逗号分隔的段落首句 id（默认按 id 字母前缀分组）")
    ap.add_argument("--accent", help="逗号分隔的段落 id：这些段加高层（默认隔段加）")
    ap.add_argument("--lead", type=float, default=0.35, help="段落切点比首句开口提前的秒数（默认 0.35）")
    ap.add_argument("--duration", type=float, help="片长秒（默认 narrationOffset + 旁白 + narrationTail，或 film.json duration）")
    ap.add_argument("--seed", type=int, default=1, help="随机种子（噪声、铃音的取舍）；同输入同种子逐字节同输出")
    ap.add_argument("--out-dir", help="产出目录（默认片子的 out/）")
    ap.add_argument("--json", help="music.json 写到哪（默认与 wav 同目录；场景要 fetch 它就写到片子根目录，好进交付收据）")
    ap.add_argument("--dry-run", action="store_true", help="只打印规划，不合成、不写文件")
    args = ap.parse_args()
    if args.list_styles:
        for k, v in STYLES.items():
            print(f"{k:8} {v['bpm']:>4.0f} bpm  {v['about']}\n{'':8}           代价：{v['cost']}")
        return
    if not args.style:
        die("要 --style（chip / pluck / ambient；--list-styles 看各自的代价）。套件不给默认风格：选哪种写进本片 style_guide", 2)
    film = resolve_film(args.film, args.films_dir)
    P = make_plan(film, args)

    print(f"{args.style}  {P['bpm']:.1f} bpm  小节 {P['bar']:.3f}s  栅格原点 {P['t0']:.3f}s  片长 {P['end']:.3f}s  "
          f"drop {P['drop']:.3f}s  终和弦 {P['final']:.3f}s")
    for p in P["parts"]:
        print(f"  {p['role']:5} {p['id']:<8} 切点 {p['t']:7.3f}s  和声换在第 {p['bar']:>3} 小节 {p['barT']:7.3f}s  "
              f"{'-'.join(p['chords'])}{'  +高层' if p['accent'] else ''}  {','.join(p['lines'])}")
    if args.dry_run:
        print("（--dry-run：未合成）")
        return

    import soundfile as sf
    audio, hits = render(P, args.seed, KEYS[args.key])
    import _audio as A
    mono = audio.mean(axis=1)
    spec = A.band_stats(mono, SR)
    open_db = A.rms_db(mono[: int(0.5 * SR)])
    od = Path(args.out_dir).expanduser().resolve() if args.out_dir else out_dir(film)
    od.mkdir(parents=True, exist_ok=True)
    wav = od / "music.wav"
    sf.write(wav, audio, SR, subtype="PCM_16")
    jp = Path(args.json).expanduser() if args.json else od / "music.json"
    jp = jp if jp.is_absolute() else film / jp
    nar_p = film / "narration.json"
    beats = P["beats"]
    rec = {
        "schema": 1, "generator": "film-narration/scripts/music.py", "style": args.style, "seed": args.seed, "key": args.key,
        "source": rel(wav, film), "duration": round(P["end"], 3), "sampleRate": SR,
        "bpm": round(P["bpm"], 6), "meter": METER, "offset": round(P["t0"], 6), "confidence": 1.0,
        "beats": beats, "downbeats": beats[::METER], "hits": hits,
        "sections": [{k: p[k] for k in ("id", "role", "t", "bar", "barT", "chords", "accent", "lines")} for p in P["parts"]],
        "events": {"drop": round(P["drop"], 3), "final": round(P["final"], 3)},
        "inputs": {"narrationOffset": P["off"], "narrationTail": P["tail"],
                   "narration_sha256": hashlib.sha256(nar_p.read_bytes()).hexdigest() if nar_p.exists() else None},
        "measure": {"centroidHz": spec["centroid"], "lowShare": spec["low"], "highShare": spec["high"], "open05RmsDb": round(open_db, 1)},
    }
    jp.write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"✓ {rel(wav, film)}  {P['end']:.2f}s  {len(beats)} 拍  {len(hits)} 个冲击点")
    print(f"✓ {rel(jp, film)}  （beats/downbeats/hits 与 out/beats.json 同义；beatGrid(m.bpm, m.offset, m.meter)）")
    print(f"  自测：频谱质心 {spec['centroid']} Hz、<400 Hz 占 {spec['low']:.1%}、>2.5 kHz 占 {spec['high']:.1%}、"
          f"前 0.5 s RMS {open_db:.1f} dBFS（质心/占比是能量分布，不是\"好不好听\"——要人听）")


if __name__ == "__main__":
    main()
