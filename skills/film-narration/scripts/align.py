#!/usr/bin/env python3
"""已有音频 -> 字级时间戳；以及成片音轨的事后校验（四条保证的第 4 条）。

两个模式：

1) 反推（先有人声、后配画面）：自己录的口播、别人给的音频、非中英文语种
   （火山 enable_subtitle 只支持中英文）。产出 narration.json，下游完全一样。

       python align.py --film <slug> --from assets/vo.wav

2) 校验：把成片（或 out/vo.wav）的音轨重新转写，和 script.json 比对。
   **校验器不能被告知答案**：转写时不给 Whisper 任何脚本正文作提示。给了会诱导它「听出」
   期望结果，系统性低报错误；实测还会坍缩——喂全文后三句只吐出最后一句（吻合度 51%）。
   专有名词听不准本身就是要发现的信号。确需术语提示时用 --hint-file 给**领域词表**
   （不得是脚本正文，脚本里出现的词会被剔除），输出会标「带提示，结果偏乐观」。

   指标，按行报、按字算：
     硬错误率     删字 + 多字 + 非同音替换 ÷ 脚本字数，高于 1 - --min-ratio（默认 3%）→ 退出码 1。
                  抓错字、漏句、截断、接错音轨。
     疑似同音     等长替换且拼音相同（需要可选依赖 pypinyin 确认）。不判错，但列出来**要人听**——
                  Whisper 从声音上分不出「在/再」，TTS 也可能真念错。
                  没装 pypinyin 时分不出同音和真错字，**按硬错误计**（校验器宁可误报），标「同音未排除」。
     外文词       中文音频里英文术语的拼写差异（seek→Seq），不计硬错误，列出来要人听。
     时间漂移     转写出的字时刻 vs narration.json 的字时刻，取中位数。
                  超过 --max-drift（默认 0.15s）→ 退出码 2。抓音轨整体偏移、拼接错位。
     选错文件     转写前比媒体时长和 narration.json：差 1.5 倍以上 → 退出码 3，不浪费一次转写。
     偏移链路     film.json narrationOffset（片头留白）和分镜 / 场景运行时 / 音效对不上 → 退出码 4。
                  分镜没写 vo_offset 不算没接住（真相源只有 film.json）；写了且数不同才报。
     真峰         只查成片（转写 out/vo.wav 时跳过）：true peak > -1.0 dBTP（发布规范天花板）→ 退出码 5；
                  介于 -1.5 和 -1.0 之间只警告。
     字时间戳     narration.json 的字级时间戳 vs 每句 wav 的能量包络（_timing.py）：意群起点错拍 ≥ 0.20s → 退出码 6。
                  漂移看全片中位数，几个字挤在一起抓不到；这一条按句查。

       python align.py --film <slug> --verify                       # 只认 out/final[-<格式>].mp4，没有则 out/vo.wav
       python align.py --film <slug> --verify out/final-9x16.mp4

Whisper 自身的字级误差约 0.05-0.15s，所以漂移判据看中位数，不看单字最大值。
模型默认 large-v3-turbo（small 会把普通词听错，实测「事故→试过」；首次跑会下载约 1.6 GB 权重）。
"""
from __future__ import annotations

import difflib
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import unicodedata
from decimal import Decimal
from pathlib import Path

try:
    from pypinyin import lazy_pinyin
except ImportError:  # 可选依赖：没有就退化成「等长短替换都算疑似同音」
    lazy_pinyin = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, rel, die, need_file, installed_skills, capability  # noqa: E402
from _offset import narration_offset, offset_links  # noqa: E402
from _markup import spoken  # noqa: E402  —— script.json 台词里的 [#指令] [停顿] 不念，比对前去掉

def strip_punct(s: str) -> str:
    """NFKC 后去掉一切标点（P*）、空白（Z*）、控制符（C*），再小写。
    NFKC 先把全角/小型变体折成基本形：Whisper 单独转写 vo.wav 时会吐 U+FE50「﹐」（小型逗号），
    旧版按固定字符表去标点，它漏网后被算成「多字」硬错误（ghost-jam 实测 11 处）。"""
    s = unicodedata.normalize("NFKC", s)
    return "".join(c for c in s if unicodedata.category(c)[0] not in "PZC").lower()


# ---------------------------------------------------------------------------
# 数字归一：Whisper 把念出来的「二十二」写成「22」（ghost-jam 实测 small / large-v3-turbo 都这样），
# 逐字比对会记成删字硬错误。比对前把每段数字切成一个「数字单元」，按**数值**比：
#   - 中文数字 ↔ 阿拉伯数字：数值相等即算念对（二十二 = 22，两 = 2，三百五 = 350，一万二 = 1.2万 = 12000，
#     三点五 = 3.5，百分之五十 = 50%，二零二四 = 2024）。
#   - 数值不同就是硬错误，不管两边是什么写法（二十二→三十二、二十二→32、44→4.4 都红）。
#   - 两边都是中文、数值相同但写法不同（两→二、〇→零）：不计错，列进「要人听」——那是不同的读音。
#   - 脚本里写阿拉伯数字时（「2024 年」）读法有两种（逐位 / 数值），两种都认，不判 TTS 念了哪种。
#   - **量词和单位不归一**（辆、米、公里、km）：它们是独立念出来的音节，照常逐字比；
#     「二十二辆」→「22米」仍然是硬错误。空格本来就被当标点去掉，所以「22 辆」=「22辆」。
#   - 解析不了的中文数字串（「万一」「千万」这类词）不当数字，退回逐字比。
# 自测：python align.py --selftest（会红的用例和会绿的用例各一组）。
# ---------------------------------------------------------------------------
ZH_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9}
ZH_UNIT = {"十": 10, "百": 100, "千": 1000}
ZH_BIG = {"万": 10 ** 4, "亿": 10 ** 8}
_ZD = "零〇一二两三四五六七八九"
_ZN = f"[{_ZD}十百千万亿]+(?:点[零〇一二三四五六七八九]+[万亿]?)?"
NUM_RE = re.compile(rf"百分之{_ZN}|\d+(?:\.\d+)?(?:[万亿千百]+\d*)?%?|{_ZN}")


def _zh_int(s: str):
    """中文整数 → int；不是合法数字串返回 None。支持口语省略（三百五 = 350、一万二 = 12000）。"""
    if not s:
        return None
    if len(s) >= 2 and all(c in ZH_DIGIT and c != "两" for c in s):
        return None                                     # 逐位读法（二零二四），由调用方按字符串处理
    total, section, num = 0, 0, None
    last_unit, after_unit, zero = 10 ** 9, 0, False     # after_unit：上一个字是单位时记它的值
    for c in s:
        if c in ZH_DIGIT:
            if num is not None:
                return None                             # 两个数字连着又带单位：「二三十」这类约数不解析
            num, zero = ZH_DIGIT[c], zero or c in "零〇"
            if c in "零〇":
                num = None
            continue
        if c in ZH_UNIT:
            u = ZH_UNIT[c]
            if num is None:
                if c == "十" and section == 0 and (total == 0 or zero):
                    num = 1                             # 「十二」「一万零十」
                else:
                    return None
            if u >= last_unit:
                return None                             # 「十百」「二十三十」
            section += num * u
            num, last_unit, after_unit, zero = None, u, u, False
            continue
        if c in ZH_BIG:
            b = ZH_BIG[c]
            if num is not None and after_unit >= 100 and not zero:
                num *= after_unit // 10                 # 「三百五万」按同一条省略规则 = 350 万（与 film-story factcheck 一致）
            section += num or 0
            if section == 0 and total == 0:
                return None                             # 「万一」
            if b == 10 ** 8:
                total = (total + section) * b
            else:
                if total % 10 ** 8 >= 10 ** 4:
                    return None
                total += section * b
            section, num, last_unit, after_unit, zero = 0, None, 10 ** 9, b, False
            continue
        return None
    if num is not None:
        if after_unit and not zero and after_unit >= 100:
            num *= after_unit // 10                     # 口语省略末位单位：三百五、两千三、四万四
        section += num
    return total + section


def num_key(tok: str):
    """一个数字单元 → 规范值字符串（比对用的键）；解析不了返回 None。"""
    pct = tok.startswith("百分之") or tok.endswith("%")
    body = tok[3:] if tok.startswith("百分之") else tok.rstrip("%")
    big, rest = 1, 0
    am = re.fullmatch(r"(\d+(?:\.\d+)?)([万亿千百]*)(\d*)", body)
    if am:                                              # 阿拉伯数字，可带中文单位：4.4万、3千、125万6340
        mult = {"万": 10 ** 4, "亿": 10 ** 8, "千": 1000, "百": 100}
        for c in am.group(2):
            big *= mult[c]
        if am.group(3) and not am.group(2):
            return None
        body, rest = am.group(1), int(am.group(3) or 0)
    elif "点" in body and body[-1] in ZH_BIG:
        big, body = ZH_BIG[body[-1]], body[:-1]
    if am:
        val = Decimal(body)
    elif "点" in body:
        ip, fp = body.split("点", 1)
        iv = _zh_int(ip) if len(ip) != 1 or ip not in ZH_DIGIT else ZH_DIGIT[ip]
        if iv is None or not fp or any(c not in ZH_DIGIT for c in fp):
            return None
        val = Decimal(f"{iv}." + "".join(str(ZH_DIGIT[c]) for c in fp))
    elif len(body) >= 2 and all(c in ZH_DIGIT and c != "两" for c in body):
        if big != 1:
            return None
        return "".join(str(ZH_DIGIT[c]) for c in body) + ("%" if pct else "")   # 逐位：保留前导零
    elif len(body) == 1 and body in ZH_DIGIT:
        val = Decimal(ZH_DIGIT[body])
    else:
        iv = _zh_int(body)
        if iv is None:
            return None
        val = Decimal(iv)
    val = val * big + rest
    s = format(val.normalize(), "f") if val == val.to_integral() else format(val, "f")
    return s + ("%" if pct else "")


def units(text: str) -> list[dict]:
    """文本 → 比对单元。非数字：一个字一个单元（去标点、小写）；数字串：一个单元，key 是数值。
    每个单元带 lit（原文写法）和 n（占脚本几个字，用于按字计数）。"""
    s = unicodedata.normalize("NFKC", text)
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)            # 1,000 → 1000
    out, pos = [], 0

    def plain(seg):
        for c in strip_punct(seg):
            out.append({"key": c, "lit": c, "n": 1, "num": False})

    for m in NUM_RE.finditer(s):
        plain(s[pos:m.start()])
        tok = m.group(0)
        k = num_key(tok)
        if k is None:
            plain(tok)
        else:
            out.append({"key": "#" + k, "lit": tok.lower(), "n": len(tok), "num": True})
        pos = m.end()
    plain(s[pos:])
    return out


def extract_audio(src: Path) -> Path:
    tmp = Path(tempfile.mkdtemp()) / "audio.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                    "-vn", "-ac", "1", "-ar", "16000", str(tmp)], check=True)
    return tmp


def transcribe(audio: Path, model_size: str, language: str | None, hint: str | None):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        die("未安装 faster-whisper：.venv/bin/pip install faster-whisper")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(audio), language=language, word_timestamps=True,
                                      initial_prompt=hint, vad_filter=True)
    lines, words = [], []
    for i, seg in enumerate(segments):
        sw = [{"w": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3),
               "src": "whisper"} for w in (seg.words or []) if w.word.strip()]
        lines.append({"id": f"L{i+1}", "text": seg.text.strip(), "start": round(seg.start, 3),
                      "end": round(seg.end, 3), "duration": round(seg.end - seg.start, 3),
                      "words": sw})
        words.extend(sw)
    return lines, words, info


def char_times(words):
    """把词拆成字，每个字分到词时长的等分。返回 (字串, 每字起始时刻)。"""
    chars, times = [], []
    for w in words:
        k = strip_punct(w["w"])
        if not k:
            continue
        step = (w["end"] - w["start"]) / len(k)
        for n, c in enumerate(k):
            chars.append(c)
            times.append(w["start"] + n * step)
    return "".join(chars), times


def drift(expected_words, got_words):
    a, ta = char_times(expected_words)
    b, tb = char_times(got_words)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    diffs = []
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            diffs.append(tb[blk.b + k] - ta[blk.a + k])
    return diffs


STYLE_HINT = {"zh": "以下是普通话的句子，使用简体中文。"}


def homophone(a: str, b: str) -> bool | None:
    """True 同音 / False 不同音 / None 无法判断（没装 pypinyin）。"""
    if len(a) != len(b):
        return False
    if lazy_pinyin is None:
        return None
    return lazy_pinyin(a) == lazy_pinyin(b)


def dict_readings(spec: dict) -> dict:
    """发音词典里「中文原词 → 等长中文转写」的条目（如 密钥/密月）。这些词**按规定就该念成转写的读音**，
    Whisper 照读音写出转写字（实测 密钥 → 蜜月）是念对了，不是错字。
    不处理拼音条目（实测不改读音）和英文转写（长度不等，走外文词那一类）。"""
    out = {}
    for item in (spec.get("pronunciationDict") or {}).get("tone") or []:
        if "/" not in item:
            continue
        src, dst = item.split("/", 1)
        if not dst.startswith("(") and len(src) == len(dst) and not (src + dst).isascii():
            out[src] = dst
    return out


def score_lines(script_lines: list[str], got: str, readings: dict | None = None):
    """按字比对，错误归到脚本的行。返回每行统计 + 全局硬错误数。
    readings：dict_readings() 的结果。比对仍对着脚本原文，只在判同音时改用词典规定的读音。"""
    ua, owner = [], []
    for i, t in enumerate(script_lines):
        us = units(t)
        # 词典读音：等长中文转写，在去标点后的字流上逐字替换，再按单元切回去（非数字单元一字一个）
        plain = "".join(u["lit"] for u in us)
        read = plain
        for src, dst in (readings or {}).items():
            read = read.replace(src.lower(), dst.lower())
        k = 0
        for u in us:
            u["read"] = read[k:k + len(u["lit"])] if len(read) == len(plain) else u["lit"]
            k += len(u["lit"])
            ua.append(u)
            owner.append(i)
    ub = units(got)
    rows = [{"chars": 0, "hard": 0, "homo": [], "latin": [], "errors": []} for _ in script_lines]
    for u, o in zip(ua, owner):
        rows[o]["chars"] += u["n"]
    sm = difflib.SequenceMatcher(None, [u["key"] for u in ua], [u["key"] for u in ub], autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            # 数值相同、两边都是中文但写法不同（两→二）：读音不同，不计错，要人听
            for x, y in zip(ua[i1:i2], ub[j1:j2]):
                if x["num"] and x["lit"] != y["lit"] and not (x["lit"] + y["lit"]).isascii() \
                        and not re.search(r"\d", x["lit"] + y["lit"]):
                    rows[owner[i1]]["homo"].append(f"{x['lit']}→{y['lit']}(数值相同、读法不同)")
            continue
        ln = owner[min(i1, len(owner) - 1)] if owner else 0
        sa = "".join(u["lit"] for u in ua[i1:i2])
        sb = "".join(u["lit"] for u in ub[j1:j2])
        has_num = any(u["num"] for u in ua[i1:i2] + ub[j1:j2])
        na = sum(u["n"] for u in ua[i1:i2])
        if has_num:
            # 数字单元数值不同 = 念错了数（或听错了数），一律硬错误。不进「外文词」那一类——
            # 旧版里脚本写 22、转写成 32 时整段是 ASCII，会被当外文词拼写差异放过
            rows[ln]["hard"] += max(na, len(sb))
            rows[ln]["errors"].append({"replace": f"{sa}→{sb}", "delete": f"漏「{sa}」",
                                       "insert": f"多「{sb}」"}[op] + "(数值不符)")
            continue
        if (sa + sb).isascii():
            # 中文音频里的英文术语：Whisper 的拼写极不可靠（实测 seek→Seq、ffmpeg→FF Ampig），
            # TTS 也可能真念错——两种都分不清，所以单列要人听，不计硬错误
            rows[ln]["latin"].append(f"{sa or '∅'}→{sb or '∅'}")
            continue
        if op == "replace":
            ra = "".join(u["read"] for u in ua[i1:i2])
            if ra != sa:
                # 这段落在发音词典规定了读音的词上：只认词典读音。
                if homophone(ra, sb):
                    # 按规定念的（例 密钥 按 密钥/密月 念成 mì yuè，Whisper 写成 蜜月）
                    rows[ln]["homo"].append(f"{sa}→{sb}(按发音词典读 {ra})")
                    continue
                if homophone(sa, sb):
                    # 和默认注音同音、和词典读音不同 = 念成了词典要纠正的那个读音（例 秘药 = mì yào）
                    rows[ln]["hard"] += len(sa)
                    rows[ln]["errors"].append(f"{sa}→{sb}(念成默认读音，词典要求读 {ra})")
                    continue
            h = homophone(sa, sb)
            if h:
                rows[ln]["homo"].append(f"{sa}→{sb}")
                continue
            if h is None and len(sa) == len(sb) <= 2:
                # 没装 pypinyin 分不出同音和真错字。校验器宁可误报不可漏报：计硬错误，但标出来
                rows[ln]["hard"] += len(sa)
                rows[ln]["errors"].append(f"{sa}→{sb}(同音未排除)")
                continue
        rows[ln]["hard"] += max(len(sa), len(sb))
        rows[ln]["errors"].append({"replace": f"{sa}→{sb}", "delete": f"漏「{sa}」",
                                   "insert": f"多「{sb}」"}[op])
    return rows, sum(u["n"] for u in ua), sum(r["hard"] for r in rows)


# 数字归一与标点归一的自测。「红」= 必须有硬错误，「绿」= 必须零硬错误，「黄」= 零硬错误但必须进「要人听」。
# 红的那组是闸门的本职：归一做过头会把真错误抹平，这组就是防这个的。
SELFTEST = [
    ("绿", "一圈路，二十二辆车，同一个速度。", "一圈路,22辆车,同一个速度。"),   # ghost-jam s1 实测转写
    ("绿", "二十二辆车", "22 辆车"),
    ("绿", "四十四米", "44米"),
    ("绿", "两辆车", "2辆车"),
    ("绿", "三百五十人", "350人"),
    ("绿", "三百五", "350"),
    ("绿", "一万两千", "12000"),
    ("绿", "一万两千", "1.2万"),
    ("绿", "四万四千", "4.4万"),
    ("绿", "百分之五十", "50%"),
    ("绿", "三点五秒", "3.5秒"),
    ("绿", "二零二四年", "2024年"),
    ("绿", "2024 年", "二零二四年"),
    ("绿", "2024 年", "两千零二十四年"),
    ("绿", "第二十二辆", "第22辆"),
    ("绿", "一百零五", "105"),
    ("绿", "十分钟", "10分钟"),
    ("绿", "速度，前面没有红灯", "速度﹐前面没有红灯"),        # U+FE50 小型逗号
    ("绿", "千万别停", "千万别停"),                          # 解析不了的数字串退回逐字比
    ("红", "二十二辆车", "32辆车"),
    ("红", "二十二辆车", "三十二辆车"),
    ("红", "二十二辆车", "22米车"),                          # 量词不归一
    ("红", "四十四米", "4.4米"),
    ("红", "四十四米", "440米"),
    ("红", "22 辆车", "32 辆车"),                            # 旧版：整段 ASCII，被当外文词放过
    ("红", "百分之五十", "15%"),
    ("红", "三点五秒", "35秒"),
    ("红", "一万两千", "1200"),
    ("红", "二零二四年", "2042年"),
    ("红", "没有事故", "没有试过"),                          # 非数字的对照：归一不影响别的字
    ("红", "速度，前面", "速度,,前方"),
    ("绿", "125万6340人", "一百二十五万六千三百四十人"),
    ("绿", "1,000 米", "一千米"),
    # 解析不了的数字串（约数「二三十」、词「千万」）不能被剔出比对——剔掉会让分母变小、准确率虚高，
    # 是和误报方向相反的假绿灯。它们退回逐字比，念错照样红；每条用例还会核对分母 = 脚本去标点后的字数。
    ("绿", "约二三十人", "约二三十人"),
    ("红", "约二三十人", "约20到30人"),
    ("红", "千万别停", "1000万别停"),
    ("红", "二十二辆车", "辆车"),                              # 漏掉整个数
    ("红", "三百五米", "305米"),                               # 口语省略：三百五 = 350，不是 305
    ("绿", "三百五米", "350米"),
    ("黄", "两辆车", "二辆车"),
]

# film-story 的 factcheck.mjs 也解析中文数字（给事实对账用）。两个 skill 对同一个数给出不同数值是最糟的情况，
# 所以自测会抽取它的 cnToNumber/numValue 跑同一批输入比对。已知分歧列在这里，并写明谁对：
KNOWN_DIVERGENCE: dict[str, str] = {
    # 首次交叉校验抓到 4 条（三百五 / 两千三 / 一万二 / 四万四：factcheck 按 305 / 2003 / 10002 / 40004），
    # factcheck 已改成口语省略规则，现在为空。新分歧出现时在这里写明哪边对、为什么，不要直接改成一致了事。
}
# 口语省略规则：数字紧跟 百/千/万/亿 且中间没有「零」时，是下一级单位的系数（三百五 = 350、一万二 = 12000）；
# 「一百零五」才是 105。「三百五万」写法本身不规范（也有人读 305 万），两个 skill 约定一律读 350 万，
# 写稿时写「三百五十万」。
CROSS_INPUTS = ["二十二", "四十四", "十", "十二", "一百零五", "三百零五", "三百五十", "三百五", "两千三",
                "一万两千", "一万二", "四万四千", "四万四", "十五万八", "十万八", "两万五", "一万零五百",
                "三百五十万", "三百五万", "十万", "一千万", "三亿五千万", "三亿五", "二零二四", "一〇二三",
                "九〇七", "六一八", "两", "三", "22", "4.4万", "125万6340", "1000"]
_CROSS_JS = r"""
const fs = require('fs'); const src = fs.readFileSync(process.argv[1], 'utf8');
const grab = (re) => { const m = src.match(re); if (!m) { console.log('EXTRACT_FAIL ' + re); process.exit(3); } return m[0]; };
const code = [grab(/const CN_DIGIT = [^\n]*\n/), grab(/const CN_UNIT = [^\n]*\n/), grab(/const CN_BIG = [^\n]*\n/),
  grab(/function cnToNumber\(s\) \{[\s\S]*?\n\}\n/), grab(/const NUM_RE = [^\n]*\n/),
  grab(/function toHalf\(s\) [^\n]*\n/), grab(/function numValue\(m\) \{[\s\S]*?\n\}\n/)].join('');
const f = new Function(code + 'return (s) => { const m = [...s.matchAll(NUM_RE)]; return m.length === 1 && m[0][0] === s ? numValue(m[0]) : null; };')();
console.log(JSON.stringify(process.argv.slice(2).map(f)));
"""


def cross_check() -> int:
    # 可选依赖：film-story 没装就跳过（不是缺能力：自测本身不需要它）
    if "film-story" not in installed_skills():
        print("（跳过交叉校验：没装 film-story，没有 factcheck.mjs 可比）")
        return 0
    fc = capability("film-story") / "scripts" / "factcheck.mjs"
    node = shutil.which("node")
    if not fc.exists() or not node:
        print(f"（跳过交叉校验：{'没有 node' if not node else '找不到 ' + str(fc)}）")
        return 0
    r = subprocess.run([node, "-e", _CROSS_JS, str(fc), *CROSS_INPUTS], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"✗ 交叉校验跑不起来（factcheck.mjs 的函数名或结构变了？）：{(r.stdout + r.stderr).strip()[:300]}")
        return 1
    theirs = json.loads(r.stdout.strip().splitlines()[-1])
    bad = 0
    for s_, v in zip(CROSS_INPUTS, theirs):
        mine = num_key(s_)
        same = v is not None and mine is not None and Decimal(mine) == Decimal(str(v))
        if same and s_ in KNOWN_DIVERGENCE:
            print(f"  ✓ {s_}: 两边已一致（{mine}），可以从 KNOWN_DIVERGENCE 删掉")
        elif not same and s_ in KNOWN_DIVERGENCE:
            print(f"  ⚠ {s_}: 已知分歧，本 skill {mine}，factcheck {v}；正确读法 {KNOWN_DIVERGENCE[s_]}")
        elif not same:
            bad += 1
            print(f"  ✗ {s_}: 本 skill {mine}，factcheck {v} —— 新分歧，两个 skill 读同一个数给了不同答案")
    print(f"交叉校验 film-story factcheck.mjs：{len(CROSS_INPUTS)} 个输入，"
          f"{len(CROSS_INPUTS) - bad - sum(1 for k in KNOWN_DIVERGENCE if k in CROSS_INPUTS)} 个一致，"
          f"已知分歧 {sum(1 for k in KNOWN_DIVERGENCE if k in CROSS_INPUTS)}，"
          f"新分歧 {bad}")
    return 1 if bad else 0


def selftest() -> int:
    bad = 0
    for want, script, heard in SELFTEST:
        rows, total, hard = score_lines([script], heard)
        listen = rows[0]["homo"] + rows[0]["latin"]
        ok = {"红": hard > 0, "绿": hard == 0, "黄": hard == 0 and bool(listen)}[want]
        if total != len(strip_punct(re.sub(r"(?<=\d),(?=\d{3})", "", script))):
            ok = False                                  # 分母必须是脚本全部字数：有东西被剔出比对就红
            print(f"  分母 {total} ≠ 脚本字数 {len(strip_punct(script))}")
        bad += not ok
        print(f"{'✓' if ok else '✗'} {want}  「{script}」 vs 「{heard}」  硬错误 {hard}/{total}  "
              f"{' '.join(map(str, rows[0]['errors'])) or '-'}  要人听 {' '.join(listen) or '-'}")
    print(f"{len(SELFTEST) - bad}/{len(SELFTEST)} 通过")
    print()
    return 1 if bad or cross_check() else 0


def load_hint(path: str | None, script_text: str) -> str | None:
    if not path:
        return None
    words = [w.strip() for w in Path(path).read_text(encoding="utf-8").replace(",", "\n").splitlines()]
    words = [w for w in words if w]
    kept = [w for w in words if strip_punct(w) not in strip_punct(script_text)]
    dropped = sorted(set(words) - set(kept))
    if dropped:
        print(f"⚠ 词表里这些词出现在脚本正文中，已剔除（否则等于告诉校验器答案）：{dropped}")
    return "、".join(kept) or None


FINAL_RE = re.compile(r"^final(-(9x16|1x1|16x9))?\.(mp4|mov)$")


TP_CEILING = -1.0   # dBTP。常见发布规范的天花板（YouTube / Spotify）：超过判失败
TP_TARGET = -1.5    # dBTP。本套件 mux.sh 的 loudnorm 目标：超过只警告


def true_peak(p: Path) -> float | None:
    """被校验文件（解码后）的 true peak，dBTP，两位小数。ebur128 只打一位（-1.01 显示成 -1.0），所以用 loudnorm 的测量输出。"""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(p), "-af", "loudnorm=print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r'"input_tp"\s*:\s*"([^"]+)"', r.stderr)
    try:
        return float(m.group(1)) if m else None
    except ValueError:
        return None


def media_duration(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        die(f"ffprobe 读不出 {p} 的时长：{r.stderr.strip()[:200]}")
        raise


def pick_source(film: Path, given: str | None) -> Path:
    """显式路径优先。自动挑只**正向匹配** out/final.mp4 或 out/final-<9x16|1x1|16x9>.mp4；
    同目录里 film-critique 等产出的派生品（*-loop.mp4 把片子拼两遍、*-phone/-strip/-poster）
    一律不认——挑错文件报出来的会像是片子的问题（"s3 多了一大段"），很难反应过来。"""
    if given:
        p = Path(given)
        p = p if p.is_absolute() else (film / p if (film / p).exists() else Path.cwd() / p)
        return need_file(p, "")
    out = film / "out"
    finals = [f for f in out.glob("final*") if FINAL_RE.match(f.name)] if out.is_dir() else []
    ignored = sorted(f.name for f in out.glob("final*.mp4") if f not in finals) if out.is_dir() else []
    fmt = None
    fj = film / "film.json"
    if fj.exists():
        fmt = json.loads(fj.read_text(encoding="utf-8")).get("format")
    preferred = [f for f in finals if fmt and f.stem == f"final-{fmt}"]
    pick = (preferred or sorted(finals, key=lambda f: f.stat().st_mtime))[-1:] or None
    if ignored:
        print(f"（自动挑选忽略了派生产物：{' '.join(ignored)}）")
    if pick:
        return pick[0]
    return need_file(out / "vo.wav", "没有 out/final[-<格式>].mp4 也没有 out/vo.wav。"
                     "先跑 tts.py，或用 --verify <文件> 显式指定")


def main() -> None:
    ap = parser("旁白反推 / 校验：--from 从音频反推字级时间戳，--verify 转写成片核对念对没有、漂没漂；--selftest 数字归一自测")
    ap.add_argument("--selftest", action="store_true", help="跑数字/标点归一的自测用例（不需要片子）")
    ap.add_argument("--from", dest="src", metavar="AUDIO", help="反推模式：音频/视频文件")
    ap.add_argument("--verify", nargs="?", const="", default=None, metavar="MEDIA",
                    help="校验模式：成片或音频，省略则自动挑")
    ap.add_argument("--model", default="large-v3-turbo",
                    help="Whisper 模型。默认 large-v3-turbo：small 在 ghost-jam 上把「事故」听成「试过」；"
                         "代价是转写慢约 2.5 倍（23.6s 音频 10.8s vs 4.3s，M3 Max CPU int8）")
    ap.add_argument("--language", default=None, help="zh / en …，留空自动识别")
    ap.add_argument("--min-ratio", type=float, default=0.97,
                    help="校验：1 - 硬错误率 的下限（同音疑似不计入）")
    ap.add_argument("--hint-file", default=None,
                    help="校验：领域词表（每行一个），默认不给。脚本里出现的词会被剔除")
    ap.add_argument("--hint", default=None,
                    help="反推（--from）：给 Whisper 的上下文提示，如原稿文本。对齐不是校验，可以给")
    ap.add_argument("--max-drift", type=float, default=0.15)
    ap.add_argument("--vo-offset", type=float, default=None,
                    help="校验：旁白在被校验文件里的起点（秒）。默认成片取 film.json narrationOffset、out/vo.wav 取 0")
    ap.add_argument("--allow-duration-mismatch", action="store_true",
                    help="校验：媒体时长和 narration.json 差 1.5 倍以上也照样转写")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(selftest())
    film = resolve_film(args.film, args.films_dir)

    if args.verify is not None:
        spec = json.loads(need_file(film / "script.json", "").read_text(encoding="utf-8"))
        src = pick_source(film, args.verify or None)
        nar_pre = film / "narration.json"
        # 时间基准：out/vo.wav 是旁白音频时间（偏移 0）；成片是成片时间 = 旁白时间 + film.json narrationOffset。
        # 旧版不分这两种，一律按偏移 0 比——片头留白 0.6s 而 mux 没加延迟时，成片音轨和 narration.json
        # 照样逐字对上（漂移 ≈ 0），画面却晚 0.6s：它比的是「音轨 vs 时间轴」，而时间轴本身不知道有留白。
        film_off = narration_offset(film)
        vo_audio = film / "out" / "vo.wav"
        if nar_pre.exists():
            vo_audio = film / (json.loads(nar_pre.read_text(encoding="utf-8")).get("audio") or "out/vo.wav")
        is_vo = src.resolve() == vo_audio.resolve()
        expect_off = args.vo_offset if args.vo_offset is not None else (0.0 if is_vo else film_off)
        if nar_pre.exists():
            want = (json.loads(nar_pre.read_text(encoding="utf-8")).get("duration") or 0) + expect_off
            have = media_duration(src)
            if want and not args.allow_duration_mismatch and \
                    (have > want * 1.5 or have < want / 1.5):
                die(f"选中的 {rel(src, film)} 时长 {have:.3f}s，narration.json 是 {want}s，差了 "
                    f"{have / want:.2f} 倍——这多半不是成片（循环拼接版？别的片子？旧版本？）。"
                    f"用 --verify <文件> 显式指定；确实如此（长片尾/片头）加 --allow-duration-mismatch", 3)
            if want and abs(have - want) > 0.5:
                print(f"⚠ {rel(src, film)} 时长 {have:.3f}s 和 narration.json {want}s 差 "
                      f"{have - want:+.3f}s（片尾留白/配乐延长可以接受，否则检查版本）")
        # 比的是要念的字：script.json 里的行内标记（[#语气指令]、[停顿 0.6]）接口不念（tts.py 本地去掉），这里也去掉
        expected_lines = [spoken(str(l["text"])) for l in spec["lines"]]
        expected = "".join(expected_lines)
        hint = load_hint(args.hint_file, expected)
        # 唯一的默认提示是**不含任何答案内容**的文体提示：不给的话 Whisper 常输出繁体（实测 帧→幀）
        style = STYLE_HINT.get(args.language or spec.get("language") or "zh", "")
        hint = (style + (hint or "")) or None
        lines, words, info = transcribe(extract_audio(src), args.model, args.language, hint)
        got = "".join(l["text"] for l in lines)
        ratio = difflib.SequenceMatcher(None, strip_punct(expected), strip_punct(got),
                                        autojunk=False).ratio()
        rows, total, hard = score_lines(expected_lines, got, dict_readings(spec))
        acc = 1 - hard / total if total else 0.0
        print(f"源: {rel(src, film)}")
        print(f"识别语言: {info.language} ({info.language_probability:.2f})   音频时长 {info.duration:.3f}s")
        print("提示: " + ("带领域词表 —— 结果偏乐观" if args.hint_file else
                            f"仅文体提示「{style}」，不含脚本内容（校验器不看答案）"))
        print(f"转写: {got}")
        print()
        ids = [l.get("id") or f"L{i+1}" for i, l in enumerate(spec["lines"])]
        print("| 句 | 字数 | 硬错误 | 差异 | 疑似同音（要人听） | 外文词（要人听） |")
        print("|---|---|---|---|---|---|")
        for lid, r in zip(ids, rows):
            print(f"| {lid} | {r['chars']} | {r['hard']} | {' '.join(r['errors']) or '-'} | "
                  f"{' '.join(r['homo']) or '-'} | {' '.join(r['latin']) or '-'} |")
        print()
        n_homo = sum(len(r["homo"]) + len(r["latin"]) for r in rows)
        print(f"按字准确率（不计疑似同音）: {acc:.1%}   (阈值 {args.min_ratio:.0%})   "
              f"原始吻合度 {ratio:.1%}   要人听 {n_homo} 处")
        if lazy_pinyin is None and "同音未排除" in str(rows):
            print("  （未装 pypinyin：同音替换无法排除，已按硬错误计。装上后同音字会降级为「要人听」）")

        code = 0
        nar_path = film / "narration.json"
        if nar_path.exists():
            nar = json.loads(nar_path.read_text(encoding="utf-8"))
            shifted = [{**w, "start": w["start"] + expect_off, "end": w["end"] + expect_off}
                       for w in nar["words"]]
            d = drift(shifted, words)
            print(f"期望旁白起点: +{expect_off:g}s（" + ("--vo-offset" if args.vo_offset is not None else
                  "转写的是旁白音频本身，不加偏移" if is_vo else "film.json narrationOffset") + "）")
            if d:
                med = statistics.median(d)
                absd = sorted(abs(x) for x in d)
                p90 = absd[int(0.9 * (len(absd) - 1))]
                print(f"时间漂移: 中位 {med:+.3f}s   |漂移| p90 {p90:.3f}s   匹配字数 {len(d)}"
                      f"   (阈值 中位 ±{args.max_drift}s)")
                if abs(med) > args.max_drift:
                    print(f"✗ 音轨和 narration.json（+{expect_off:g}s 偏移）整体错位：mux 是否按 film.json narrationOffset 加了延迟、"
                          "音轨是否接错版本、narration.json 是否是旧的", file=sys.stderr)
                    code = 2
        else:
            print("（没有 narration.json，跳过漂移检查）")

        # 偏移链路：分镜 / 场景运行时 / 音效 是不是都按同一个 narrationOffset（漂移只看得见音轨这一环）
        sfx_path = film / "out" / "sfx.wav"
        errs, notes = offset_links(film, film_off, None if is_vo else sfx_path)
        for n_ in notes:
            print(f"⚠ {n_}")
        for e in errs:
            print(f"✗ 偏移没接住：{e}", file=sys.stderr)
        if errs:
            code = code or 4

        # 成片 true peak（weiqi-intro：loudnorm 退回动态模式，成片 -0.5 dBTP，高于目标却没人标红）。
        # 只查交付物：转写的是 out/vo.wav 时跳过（它不是交付的文件，也没经过 loudnorm）
        if not is_vo:
            tp = true_peak(src)
            if tp is None:
                print(f"✗ 量不出 {rel(src, film)} 的 true peak，没法判是否超标", file=sys.stderr)
                code = code or 5
            elif tp > TP_CEILING:
                print(f"✗ 成片 true peak {tp:.2f} dBTP > {TP_CEILING}：超过常见发布规范的天花板（YouTube / Spotify），"
                      f"平台转码后会削顶。降 mux.sh 的 --lufs 重混（旁白片别先上 --limit auto，它压人声），再跑一遍 --verify",
                      file=sys.stderr)
                code = code or 5
            elif tp > TP_TARGET:
                print(f"⚠ 成片 true peak {tp:.2f} dBTP：满足发布规范（≤ {TP_CEILING}），但高于本套件 {TP_TARGET} 的目标")
            else:
                print(f"成片 true peak {tp:.2f} dBTP（≤ {TP_TARGET} ✓）")

        # 字时间戳 vs 能量包络（weiqi-intro：s4「上、下、左、右」挤在 0.1s 内）。上面的漂移看全片中位数，
        # 几个字错位抓不到；画面层 mark.sync 和 narration.json 出自同一份时间戳，也抓不到。只能拿声音本身比
        if nar_path.exists():
            from _timing import check_narration, report as timing_report
            try:
                t_issues, t_skipped = check_narration(film, nar, spec)
            except Exception as e:  # noqa: BLE001 —— 查不了要说出来，不能当成通过
                print(f"✗ 字时间戳自检没跑成：{e}", file=sys.stderr)
                code = code or 6
            else:
                n_fail = timing_report(t_issues, t_skipped, sys.stdout)
                if n_fail:
                    print(f"✗ 字时间戳自检 {n_fail} 处失败：按字触发的画面会错拍（见上，修法逐条给了）", file=sys.stderr)
                    code = code or 6
                else:
                    print(f"字时间戳 vs 能量包络：0 处失败，{len(t_issues)} 处警告")
        if acc < args.min_ratio:
            print("✗ 硬错误超阈值。先分清是 TTS 念错（改发音词典/文本）还是 Whisper 听错"
                  "（专有名词常见，人听一遍确认）", file=sys.stderr)
            code = code or 1
        if code == 0:
            print("✓ 音轨和脚本一致，音轨相对 narration.json（+偏移）无漂移" +
                  (f"（{n_homo} 处要人听，见上表）" if n_homo else ""))
            print("  这一关只比声音。画面有没有按同一个偏移走，由 narration.js 读 film.json 保证；"
                  "画面层对点参见 film-critique 的 check.mjs（mark.sync）")
        sys.exit(code)

    if not args.src:
        die("给 --from <音频>（反推）或 --verify（校验）")
    src = Path(args.src)
    src = src if src.is_absolute() else (film / src if (film / src).exists() else Path.cwd() / src)
    need_file(src, "")
    lines, words, info = transcribe(extract_audio(src), args.model, args.language, args.hint)
    out = {"version": 1, "audio": rel(src, film), "engine": f"whisper-{args.model}",
           "voice": "-", "language": info.language, "duration": round(info.duration, 3),
           "gap": 0, "lines": lines, "words": words}
    target = film / "narration.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"✓ narration.json  {len(lines)} 句  {len(words)} 个字级时间戳（Whisper 反推）")
    print("  句子 id 是自动编的 L1..Ln；专有名词和错别字要人校对一遍。")


if __name__ == "__main__":
    main()
