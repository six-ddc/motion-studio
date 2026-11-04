"""字级时间戳 vs 能量包络 自检。

缘起（weiqi-intro）：s4「上、下、左、右」四个字的时间戳挤在 0.1 秒内，声音里是四段相隔约 0.75 秒的能量；
tts.py 只把它们列进低置信度，场景按字触发的动画全部错拍。

为什么必须在这里查：接口回的字级时间戳是**唯一**的时间真相源，下游没有第二个来源能发现它错了——
  - `align.py --verify` 的漂移看**全片中位数**（阈值 0.15 s），几个字错位淹没在几百个字里；
  - film-critique 的 mark.sync 拿画面 MARKS 比 narration.json，两边出自同一份错的时间戳，必然对上。
所以只能拿**声音本身**比。

做法：
  1. 能量包络：16 kHz 单声道，25 ms 窗 / 10 ms 步的 RMS，dB 相对本句 p95 帧（对音量、音色不敏感）。
     相对 ≥ SPEECH_DB 的帧算有声；间隔 < PAUSE 的并成一段；只认峰值 ≥ MIN_PEAK_DB 的段（滤掉换气）。
  2. 文本按停顿标点（，。、；：！？—…）切成意群，每个意群的音节数 = 汉字数（拉丁词按元音组数）。
  3. 意群 ↔ 能量段做单调动态规划对齐，**只用时长**（音节数 × 本句平均语速），不用接口给的时间戳——
     否则时间戳整体错位时，对齐会跟着它一起错。允许一个意群跨几段（句中有塞音闭塞）
     或几个意群共一段（标点处没停顿），每次合并罚 MERGE_PENALTY。
  4. 每组第一个意群的起点 = 停顿之后的第一个声音，是包络上最可靠的锚。
     比它和接口给的第一个字的 start：差 ≥ FAIL_SHIFT 判失败，≥ WARN_SHIFT 警告。
另外两条只警告：字落在静音里（字区间内最大能量 < SILENT_DB）、字尾截短（某段能量里 ≥ TAIL_UNCOVERED 秒
没有任何字的区间盖住：vo.endOf() 偏早）。

阈值的依据（仓库 docs/verified/film-narration.md 第 21 节，可复现命令在那里）：
  普查  仓库里 10 支片 85 句 volcano-stream 旁白（含进行中的 weiqi-ch1），306 个意群锚点。
        正常的：|Δ| 最大 0.15 s（weiqi-ch1 p1），其余 ≤ 0.14 s。
        普查顺带抓到 3 处此前没人发现的真错，频谱/包络逐一核过：
          eval-clearing s5「是」晚 0.25 s（「是」的擦音从 1.18 s 起，接口把「是」标在「四」上，「四行账」并成一个 conf 0.215 的 token）；
          weiqi-ch1 d6「一样」晚 0.22 s（「样」落在 -45 dB 的静音里）；weiqi-ch1 d8「有两只眼的棋」晚 0.78 s（6 个字挤进 0.31 s，4 个落在静音里）
  复现  weiqi-intro 原句（顿号版，同音色同语速）现合 4 次：4/4 挤压，|Δ| 0.36 / 0.50 / 0.91 / 2.48 s；
        逗号版 2 次：1 次干净，1 次在后面的「它、」处挤压（1.42 s）；把 weiqi-intro s4 的四个字人为挤进 0.1 s：2.05 s
  FAIL_SHIFT = 0.20 s：正常上界 0.15 s 与真错下界 0.22 s 之间；也超过 ITU-R BT.1359 的音画同步可接受界
          （声音晚 185 ms / 早 90 ms）——这么大的错拍看得出来。两边余量都只有约 0.05 s，所以报错里给全了时刻，人可以复核
  MERGE_PENALTY = 0.6：0.15 时动态规划会把四个单音节意群并错（weiqi-intro s4 误报 1.29 s）；0.3 / 0.6 结果一致，取保守的
"""
from __future__ import annotations

import array
import math
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

HOP = 0.01            # 10 ms
WIN = 400             # 25 ms @ 16 kHz
SR = 16000
SPEECH_DB = -25.0     # 相对本句 p95
PAUSE = 0.08          # 段与段之间至少这么长的静音才算停顿（0.06–0.10 结果相同）
MIN_PEAK_DB = -15.0   # 段峰值低于此视为换气/拖音，不当成字
MIN_SEG = 0.06
MERGE_PENALTY = 0.6
MAX_GROUP = 6
FAIL_SHIFT = 0.20
WARN_SHIFT = 0.15
SILENT_DB = -20.0
TAIL_GAP = 0.12       # 字尾截短用的段：间隔 < 0.12 s 的并成一段
TAIL_UNCOVERED = 0.20
PAUSE_PUNCT = re.compile(r"[，。、；：！？,.;:!?—…]+$")


def _letters(s: str) -> str:
    return "".join(c for c in s if unicodedata.category(c)[0] not in "PZS")


def _is_cjk(c: str) -> bool:
    return "㐀" <= c <= "鿿" or "豈" <= c <= "﫿"


def _syllables(w: str) -> int:
    lt = _letters(w)
    n = sum(1 for c in lt if _is_cjk(c))
    latin = re.sub(r"[㐀-鿿豈-﫿]", " ", lt)
    n += sum(max(1, len(re.findall(r"[aeiouyAEIOUY]+", x))) for x in latin.split())
    return max(n, 1)


def envelope(wav: Path) -> list[float]:
    """每 10 ms 一帧的 dB（相对本句 p95）。不依赖 numpy/librosa：ffmpeg 解码 + 前缀平方和。"""
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(wav), "-ac", "1", "-ar", str(SR),
                        "-f", "s16le", "-"], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 解码 {wav} 失败：{r.stderr.decode('utf-8', 'replace')[:200]}")
    pcm = array.array("h")
    pcm.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    hop = int(SR * HOP)
    pad = WIN // 2                      # 居中分帧（与 librosa center=True 一致：帧 k 的中心在 k×10 ms）
    sq = [0.0] * (len(pcm) + 2 * pad + 1)
    acc = 0.0
    for i, v in enumerate(pcm):
        acc += (v / 32768.0) ** 2
        sq[pad + i + 1] = acc
    for i in range(pad + len(pcm) + 1, len(sq)):
        sq[i] = acc
    db = []
    for k in range(1 + len(pcm) // hop):
        a = k * hop
        e = (sq[min(a + WIN, len(sq) - 1)] - sq[a]) / WIN
        db.append(10 * math.log10(e + 1e-18))
    ref = sorted(db)[int(0.95 * (len(db) - 1))]
    return [x - ref for x in db]


def segments(rel: list[float], gap: float = PAUSE, min_len: float = MIN_SEG) -> list[tuple[float, float]]:
    runs, i = [], 0
    while i < len(rel):
        if rel[i] >= SPEECH_DB:
            j = i
            while j < len(rel) and rel[j] >= SPEECH_DB:
                j += 1
            runs.append([i, j])
            i = j
        else:
            i += 1
    merged: list[list[int]] = []
    for r in runs:
        if merged and (r[0] - merged[-1][1]) * HOP < gap:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(round(a * HOP, 3), round(b * HOP, 3)) for a, b in merged
            if (b - a) * HOP >= min_len - 1e-9 and max(rel[a:b]) >= MIN_PEAK_DB]


def _text_punct(words: list[dict], text: str) -> list[str] | None:
    """每个 token 之后、在**台词原文**里紧跟的停顿标点。edge 的 WordBoundary token 不带标点（「上」「下」），
    volcano-stream 把标点粘在 token 上（「上，」）——从原文取，两种引擎切出同样的意群。
    逐字对不上原文（Whisper 反推的字可能和原文不同）返回 None，退回只看 token 自带的标点。"""
    norm = lambda x: _letters(x).lower()
    i, n, out = 0, len(text), []
    for w in words:
        lt = norm(w["w"])
        for c in lt:
            while i < n and not norm(text[i]):
                i += 1
            if i >= n or norm(text[i]) != c:
                return None
            i += 1
        j = i
        while j < n and not norm(text[j]):
            j += 1
        m = re.findall(r"[，。、；：！？,.;:!?—…]", text[i:j])
        out.append("".join(m))
    return out


def phrases(words: list[dict], s0: float, text: str | None = None) -> list[dict]:
    """按停顿标点切意群。每个意群记：文本、音节数、接口给的起止（句内秒）、各字、结尾标点。
    给了台词原文就按原文里的标点切（见 _text_punct），否则按 token 自带的标点切。"""
    toks = [w for w in words if _letters(w["w"])]
    from_text = _text_punct(toks, text) if text else None
    out, cur = [], []

    def close(p, punct):
        if p:
            out.append({"text": "".join(_letters(w["w"]) for w in p),
                        "n": sum(_syllables(w["w"]) for w in p),
                        "a": p[0]["start"] - s0, "b": p[-1]["end"] - s0, "words": p,
                        "punct": punct})
    k = 0
    for w in words:
        if not _letters(w["w"]):        # 纯标点 token（「——」）：当停顿
            close(cur, "")
            cur = []
            continue
        cur.append(w)
        tail = from_text[k] if from_text is not None else (lambda m: m.group(0) if m else "")(PAUSE_PUNCT.search(w["w"]))
        k += 1
        if tail:
            close(cur, tail)
            cur = []
    close(cur, "")
    return out


def align(ph: list[dict], sg: list[tuple[float, float]]):
    """意群 ↔ 能量段单调对齐，只用时长。返回 [(意群起, 意群止, 段起, 段止)]（下标，左闭右开），对不齐返回 None。"""
    m, k = len(ph), len(sg)
    if not m or not k:
        return None
    rate = sum(b - a for a, b in sg) / sum(p["n"] for p in ph)
    INF = float("inf")
    dp = [[INF] * (k + 1) for _ in range(m + 1)]
    back = [[None] * (k + 1) for _ in range(m + 1)]
    dp[0][0] = 0.0
    for i in range(m + 1):
        for j in range(k + 1):
            if dp[i][j] == INF:
                continue
            for a in range(1, MAX_GROUP + 1):
                for b in range(1, MAX_GROUP + 1):
                    if (a > 1 and b > 1) or i + a > m or j + b > k:
                        continue
                    dur = sg[j + b - 1][1] - sg[j][0]
                    want = sum(p["n"] for p in ph[i:i + a]) * rate
                    c = dp[i][j] + math.log(dur / want) ** 2 + MERGE_PENALTY * ((a - 1) + (b - 1))
                    if c < dp[i + a][j + b]:
                        dp[i + a][j + b] = c
                        back[i + a][j + b] = (i, j)
    if dp[m][k] == INF:
        return None
    groups, i, j = [], m, k
    while (i, j) != (0, 0):
        pi, pj = back[i][j]
        groups.append((pi, i, pj, j))
        i, j = pi, pj
    return groups[::-1]


def check_line(line: dict, wav: Path, waive: str | None = None) -> list[dict]:
    """返回问题列表 [{level: fail|warn, kind, line, msg, fix}]。时刻给句内秒和旁白秒（narration.json 里的时间）。"""
    s0 = float(line["start"])
    lid = line["id"]
    rel = envelope(wav)
    ph = phrases(line["words"], s0, line.get("text"))
    sg = segments(rel)
    issues: list[dict] = []
    if not ph or not sg:
        return issues

    # 1. 意群起点 vs 包络
    groups = align(ph, sg)
    if groups is None:
        issues.append({"level": "warn", "kind": "对不齐", "line": lid,
                       "msg": f"{lid}: {len(ph)} 个意群和 {len(sg)} 段能量对不上（差得太多），这句没做起点核对，要人听",
                       "fix": "人听"})
    else:
        bad = []      # (组序号, 意群下标, 段下标, 差)
        for gi, (pi, _pe, si, _se) in enumerate(groups):
            d = ph[pi]["a"] - sg[si][0]
            if abs(d) >= WARN_SHIFT:
                bad.append((gi, pi, si, d))
        # 相邻的组连着错的合成一条报（「上、下、左、右」是一处毛病，不是四处）
        runs: list[list[tuple[int, int, int, float]]] = []
        for item in bad:
            if runs and item[0] == runs[-1][-1][0] + 1:
                runs[-1].append(item)
            else:
                runs.append([item])
        for run in runs:
            worst = max(abs(d) for *_x, d in run)
            level = "fail" if worst >= FAIL_SHIFT else "warn"
            parts = []
            for _gi, pi, si, d in run:
                p = ph[pi]
                parts.append(f"「{p['text']}」接口 {p['a']:.2f}s / 包络 {sg[si][0]:.2f}s（{'早' if d < 0 else '晚'} {abs(d):.2f}s）")
            first = ph[run[0][1]]
            lo = max(0, run[0][1] - 1)
            hi = min(len(ph), groups[run[-1][0]][1] + 1)
            span = [w for p in ph[lo:hi] for w in p["words"]]
            # 挤压：相邻几个字每个 ≤ 0.06 s、起点之间也 ≤ 0.06 s（正常语速一个音节 0.15–0.25 s）
            best_sq: list[dict] = []
            cur: list[dict] = []
            for w in span:
                short = w["end"] - w["start"] <= 0.06 + 1e-9
                if short and cur and w["start"] - cur[-1]["start"] <= 0.06 + 1e-9:
                    cur.append(w)
                else:
                    cur = [w] if short else []
                if len(cur) > len(best_sq):
                    best_sq = list(cur)
            sq_txt = ""
            if len(best_sq) >= 2:
                a, b = best_sq[0]["start"] - s0, best_sq[-1]["end"] - s0
                sq_txt = (f"；接口把「{''.join(_letters(w['w']) for w in best_sq)}」{len(best_sq)} 个字挤在 "
                          f"{a:.2f}–{b:.2f}s（{b - a:.2f}s）里")
            puncts = {p["punct"] for p in ph[lo:hi] if p["punct"]}
            if "、" in puncts:
                how = "把这几处顿号「、」换成逗号「，」（weiqi-intro 实测：顿号版「上、下、左、右」现合 4/4 次挤压；换逗号也要重合成后再查）"
            else:
                how = "改这几处的标点（逗号/句号让接口在这里断开），或把这几个意群拆成单独一句"
            issues.append({
                "level": level, "kind": "错拍", "line": lid, "words": first["text"],
                "shift": round(worst, 3),
                "msg": (f"{lid}: " + "，".join(parts) + sq_txt +
                        f"。句内秒；旁白秒 = 句内 + {s0:.3f}" +
                        ("。按字触发的动画会错拍这么多" if level == "fail" else "")),
                "fix": f"{how}；然后 tts.py --only {lid} 重合成，这条消失才算修好",
            })

    toks = [w for w in line["words"] if _letters(w["w"])]
    # 2. 字落在静音里
    for w in toks:
        a, b = w["start"] - s0, w["end"] - s0
        ia, ib = int(round(a / HOP)), max(int(round(b / HOP)), int(round(a / HOP)) + 1)
        seg = rel[max(0, ia):min(len(rel), ib)]
        if seg and max(seg) < SILENT_DB:
            t = _letters(w["w"])
            issues.append({"level": "warn", "kind": "字在静音里", "line": lid, "words": t,
                           "msg": f"{lid}:「{t}」{a:.2f}–{b:.2f}s（旁白 {w['start']:.2f}s）区间内最大能量 "
                                  f"{max(seg):.1f} dB（相对本句 p95），那里听不到字：时刻多半偏了，用到 vo.at('{t}') 的地方要人听",
                           "fix": f"人听；偏了就改标点/拆句后 tts.py --only {lid}"})

    # 3. 字尾截短：能量段里没被任何字区间盖住的部分
    cov = [False] * len(rel)
    for w in toks:
        for i in range(max(0, int((w["start"] - s0 - 0.05) / HOP)), min(len(rel), int((w["end"] - s0 + 0.05) / HOP) + 1)):
            cov[i] = True
    for a, b in segments(rel, TAIL_GAP, 0.15):
        best = run = 0
        for i in range(int(round(a / HOP)), int(round(b / HOP))):
            run = run + 1 if not cov[i] else 0
            best = max(best, run)
        if best * HOP >= TAIL_UNCOVERED - 1e-9:
            prev = [w for w in toks if w["start"] - s0 < b]
            name = _letters(prev[-1]["w"]) if prev else "?"
            end = f"止于 {prev[-1]['end'] - s0:.2f}s" if prev else ""
            issues.append({"level": "warn", "kind": "字尾截短", "line": lid, "words": name,
                           "msg": f"{lid}: 能量段 {a:.2f}–{b:.2f}s 里有 {best * HOP:.2f}s 没有字的区间盖住"
                                  f"（之前最后一个字「{name}」{end}）：vo.endOf() 偏早，at() 不受影响",
                           "fix": "用 endOf() 驱动的动作人听确认"})

    # Whisper 反推的时间戳（say 引擎 / 接口没回字幕）：首字常被它标在 0（实测 edge 两句首字都早 0.19–0.20 s），
    # 而且没有「改标点重合成」这条修法——精度低一档是已知代价（SKILL.md 第一节），这里只警告
    whisper = any(w.get("src") == "whisper" for w in line["words"])
    for i in issues:
        if i["level"] == "fail" and (waive or whisper):
            i["level"] = "warn"
            i["msg"] += (f"（script.json 已豁免：{waive}）" if waive else
                         "（时间戳是 Whisper 反推的，只警告；要准就换能回字级时间戳的引擎，或人工校）")
    return issues


def check_narration(film: Path, nar: dict, spec: dict | None = None) -> tuple[list[dict], list[str]]:
    """逐句查。返回 (问题, 跳过说明)。spec 给了就读每句的 timingWaive（人听过、确认没错时写理由）。"""
    waives = {}
    for i, l in enumerate((spec or {}).get("lines") or []):
        if l.get("timingWaive"):
            waives[l.get("id") or f"L{i + 1}"] = str(l["timingWaive"])
    issues, skipped = [], []
    for ln in nar.get("lines") or []:
        wav = film / ln["wav"] if ln.get("wav") else None
        if wav is None or not wav.is_file():
            skipped.append(f"{ln.get('id')}: 没有逐句 wav（{ln.get('wav') or 'narration.json 未记'}），没法比包络")
            continue
        issues += check_line(ln, wav, waives.get(ln["id"]))
    return issues, skipped


def report(issues: list[dict], skipped: list[str], out) -> int:
    """打印，返回 fail 条数。"""
    fails = [i for i in issues if i["level"] == "fail"]
    for s in skipped:
        print(f"  （时间戳自检跳过 {s}）", file=out)
    for i in fails:
        print(f"✗ 字时间戳 vs 能量包络［{i['kind']}］{i['msg']}", file=out)
        print(f"    修法：{i['fix']}", file=out)
    for i in issues:
        if i["level"] == "warn":
            print(f"⚠ 字时间戳 vs 能量包络［{i['kind']}］{i['msg']}", file=out)
    return len(fails)


# ---------------------------------------------------------------------------
# 写稿前估时长（不调 TTS、不花钱）
# 用途：分镜/写稿阶段要知道「这稿大概多长」，又不想为每一版草稿付一次合成费。它**不是**镜头时长——
# 镜头边界永远取合成后 narration.json 的实测（四条对齐保证第 2 条），这里只回答「稿子要不要删」。
#
# 模型（每句，秒）：(EST_CHAR·汉字 + EST_COMMA·句中停顿标点 + EST_STOP·句末/破折/省略 + EST_BASE) / 语速系数
#                  + EST_LATIN·拉丁词音节 + [停顿 x] 的 x；全片再加句间 gap / gapAfter（这两项本地拼接，精确）。
# 语速系数 = 1 + speechRate/100（volcano speech_rate：100 = 2 倍速，-50 = 0.5 倍速）。
# 系数来源：2026-10-23 用仓库 17 支片 141 句 volcano-stream 实测 lines[].duration 最小二乘拟合
#   （6 个音色，vv 和灿灿占 85% 的字）。留一片交叉验证：逐句平均绝对误差 9.0%（p90 19%），
#   片总长（只算句子，不含 gap）平均 5.9%、最差 +25.7%（ghost-jam：taocheng 语速 4.4 字/秒，比均值快 16%）。
#   只用「字数 / 3.8 字/秒」一个数：逐句 12.0%、片总长 7.1%。音色之间 3.4–4.4 字/秒，所以换了陌生音色先按 ±15% 读。
#   复现命令见仓库 docs/verified/film-narration.md 第 28 节。
EST_CHAR = 0.145
EST_LATIN = 0.27
EST_COMMA = 0.49
EST_STOP = 0.63
EST_BASE = 0.20
_COMMA = re.compile(r"[，、；：,;:]")
_STOP = re.compile(r"[。！？!?.]|——|—|…+")


def estimate_line(text: str, speech_rate: float = 0) -> dict:
    """一句台词（可带行内标记）→ {seconds, chars, latin, pause}。标记按 _markup 解析：[停顿] 计入，[#…] [@…] 不计字。"""
    from _markup import parse
    segs = parse(text)
    sp = "".join(x["text"] for x in segs)
    pause = sum(x["pause_before"] for x in segs)
    cjk = sum(1 for c in sp if _is_cjk(c))
    latin = sum(_syllables(w) for w in re.findall(r"[A-Za-z0-9]+", sp))
    f = 1 + float(speech_rate or 0) / 100
    if f <= 0:
        raise ValueError(f"speechRate={speech_rate} 换算出的语速系数 ≤ 0")
    sec = (EST_CHAR * cjk + EST_COMMA * len(_COMMA.findall(sp)) + EST_STOP * len(_STOP.findall(sp)) + EST_BASE) / f
    sec += EST_LATIN * latin + pause
    return {"seconds": round(sec, 2), "chars": cjk, "latin": latin, "pause": round(pause, 3), "text": sp}


def estimate(spec: dict) -> dict:
    """script.json → {lines: [{id, seconds, start, end, …}], total}。时间轴按 tts.py 的拼法：句 + gapAfter/gap，最后一句不加。"""
    gap = float(spec.get("gap", 0.35))
    out, t = [], 0.0
    lines = spec.get("lines") or []
    for i, ln in enumerate(lines):
        lid = ln.get("id") or f"L{i + 1}"
        e = estimate_line(str(ln.get("text", "")), ln.get("speechRate", spec.get("speechRate", 0)))
        out.append({"id": lid, **e, "start": round(t, 2), "end": round(t + e["seconds"], 2)})
        t += e["seconds"] + (float(ln.get("gapAfter", gap)) if i < len(lines) - 1 else 0)
    return {"lines": out, "total": round(t, 2)}


def _estimate_cli(argv: list[str]) -> int:
    import json
    if not argv:
        print("用法：python _timing.py estimate <script.json | 片子目录> [--json]", file=sys.stderr)
        return 2
    p = Path(argv[0]).resolve()
    if p.is_dir():
        p = p / "script.json"
    spec = json.loads(p.read_text(encoding="utf-8"))
    est = estimate(spec)
    if "--json" in argv:
        print(json.dumps(est, ensure_ascii=False, indent=1))
        return 0
    print(f"估时长（不调 TTS；模型与误差见 _timing.py「写稿前估时长」）  {p}")
    for ln in est["lines"]:
        print(f"  {ln['id']:<6} {ln['start']:>7.2f} -> {ln['end']:>7.2f}  ({ln['seconds']:.2f}s, {ln['chars']} 字"
              + (f" + {ln['latin']} 拉丁音节" if ln["latin"] else "") + (f" + 停顿 {ln['pause']:g}s" if ln["pause"] else "") + ")")
    print(f"  合计约 {est['total']:.1f}s（逐句误差约 ±9%，全片约 ±6%，陌生音色按 ±15% 读）。镜头时长以合成后的 narration.json 为准")
    return 0


if __name__ == "__main__":
    # 单独跑：python3 _timing.py <片子目录>            字时间戳自检，退出 0 / 5（有失败）
    #         python3 _timing.py estimate <script.json>  写稿前估时长，不调 TTS
    import json
    import sys
    _USAGE = ("用法：python3 _timing.py <片子目录>                    字时间戳自检，退出 0 / 5（有失败）\n"
              "      python3 _timing.py estimate <script.json|片子目录> [--json]   写稿前估时长，不调 TTS")
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help") or (sys.argv[1] == "estimate" and any(a in ("-h", "--help") for a in sys.argv[2:])):
        print(_USAGE, file=sys.stdout if len(sys.argv) >= 2 else sys.stderr)
        sys.exit(0 if len(sys.argv) >= 2 else 2)
    if sys.argv[1] == "estimate" and any(a.startswith("-") and a != "--json" for a in sys.argv[2:]):
        print(f"✗ 未知参数 {[a for a in sys.argv[2:] if a.startswith('-') and a != '--json'][0]}\n{_USAGE}", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] != "estimate" and (len(sys.argv) > 2 or sys.argv[1].startswith("-")):
        print(f"✗ 多余或未知的参数 {' '.join(sys.argv[1:])}\n{_USAGE}", file=sys.stderr)
        sys.exit(2)
    if sys.argv[1] == "estimate":
        sys.exit(_estimate_cli(sys.argv[2:]))
    f = Path(sys.argv[1]).resolve()
    nar = json.loads((f / "narration.json").read_text(encoding="utf-8"))
    spec = json.loads((f / "script.json").read_text(encoding="utf-8")) if (f / "script.json").exists() else None
    iss, sk = check_narration(f, nar, spec)
    n = report(iss, sk, sys.stdout)
    print(f"{'✗' if n else '✓'} 字时间戳自检：{n} 处失败，{len(iss) - n} 处警告")
    sys.exit(5 if n else 0)
