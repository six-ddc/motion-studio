"""script.json 台词里的行内控制标记：语气指令与停顿。

为什么要在本地解析、绝不原样发给接口（仓库 docs/verified/film-narration.md 第 26 节，2026-10-21 实测 seed-tts-2.0）：
  `[#用低沉缓慢的语气说]夜色降临……` 原样发过去，接口把它**念出来**（Whisper 听到「井号用低沉缓慢……」），
  计费字数 29 → 46，时长 6.2 s → 10.6 s，时间戳里多出这几个字，字时间戳自检 6/6 次失败。
  `（低沉缓慢地）`（默认括号过滤也没滤掉）、`<cot text=…>`（use_tag_parser，官方说只对声音复刻 2.0 表现力版生效）同样被念出来。
  官方控制台的 `[#…]` 写法在 HTTP 接口上对应的是 additions.context_texts，不是文本里的字。
所以：标记只在这里解析，`spoken()` 之后的文本才是要念的、进字幕的、进 narration.json 的、被 `--verify` 比对的。

语法（方括号半角 [] 或全角【】都认）：
  [#<指令>]          从这里起的语气指令（发给 context_texts），直到下一个 [#…] 或句末
  [#]                回到这一句的默认指令（line.instruction，没有则 script.json 顶层 instruction）
  [停顿 0.6] [停顿 600ms] [pause 0.6s]   在这里插入一段静音（秒，0 < x ≤ 10）
  [@<id>] … [@/<id>]  语义区间：不念、不切段、不影响请求和时间戳，只在 narration.json 的 spans 里记下
                     这一段字被念的 {start, end}，场景用 vo.span('<id>') 取（见下面 spans()）
其他任何方括号内容都报错——接口会把方括号里的字念出来，写错一个标记就是一句错音。

句首只有一个 [#…]、没有别的标记时，等价于这一句的 instruction，只发一次请求。
句中有标记时这一句被切成几段分别合成再拼接（tts.py）：每段是独立的一次合成，**段与段的接缝处语调会像句子边界**，
而且每段多一次请求。只有「同一句里前后半句语气真的不同」或「这里要一段精确长度的静音」时才值得付。
"""
from __future__ import annotations

import re

MARK = re.compile(r"\[([^\[\]]*)\]|【([^【】]*)】")
SPAN = re.compile(r"^[@＠](/?)\s*([0-9A-Za-z_.\-\u4e00-\u9fff]*)$")
PAUSE = re.compile(r"^(?:停顿|停|pause)\s*([0-9]*\.?[0-9]+)\s*(ms|s|秒|毫秒)?$", re.I)


class MarkupError(ValueError):
    pass


def parse(text: str) -> list[dict]:
    """→ 段列表 [{text, instruction, pause_before}]。
    instruction: None = 用这一句的默认；"" = 显式清空（[#] 且句默认也空时等同 None，由调用方决定）；其余为指令文本。
    instruction 用哨兵 INHERIT 表示「跟随句默认」。pause_before：这一段之前插入的静音秒数。"""
    segs: list[dict] = []
    cur = {"text": "", "instruction": INHERIT, "pause_before": 0.0}
    pos = 0
    for m in MARK.finditer(text):
        cur["text"] += text[pos:m.start()]
        pos = m.end()
        body = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
        if body[:1] in ("@", "＠"):     # 语义区间：零宽，不切段（位置由 spans() 单独算）
            if not SPAN.match(body) or not SPAN.match(body).group(2):
                raise MarkupError(f"「{m.group(0)}」区间标记写成 [@<id>] … [@/<id>]，id 只用字母、数字、汉字、_ . -")
            continue
        if body.startswith("#") or body.startswith("＃"):
            ins = body[1:].strip()
            if cur["text"].strip():
                segs.append(cur)
                cur = {"text": "", "instruction": INHERIT, "pause_before": 0.0}
            cur["instruction"] = ins if ins else INHERIT
            continue
        pm = PAUSE.match(body)
        if pm:
            sec = float(pm.group(1)) / (1000 if (pm.group(2) or "").lower() in ("ms", "毫秒") else 1)
            if not 0 < sec <= 10:
                raise MarkupError(f"「{m.group(0)}」停顿要在 0–10 秒之间")
            ins = cur["instruction"]
            if cur["text"].strip():
                segs.append(cur)
                cur = {"text": "", "instruction": ins, "pause_before": 0.0}
            cur["pause_before"] += sec
            continue
        raise MarkupError(
            f"「{m.group(0)}」不是认得的行内标记。方括号保留给控制：[#语气指令]、[#]（回到默认）、[停顿 0.6]、"
            f"[@区间]…[@/区间]。"
            f"接口会把方括号里的字原样念出来（实测），所以写错的标记直接报错而不是发出去")
    cur["text"] += text[pos:]
    for ch in "[]【】":
        if ch in cur["text"] or any(ch in s["text"] for s in segs):
            raise MarkupError(f"台词里有没配对的「{ch}」：方括号保留给行内控制标记")
    if cur["text"].strip() or cur["pause_before"] or not segs:
        segs.append(cur)
    return segs


class _Inherit:
    def __repr__(self):
        return "INHERIT"


INHERIT = _Inherit()


def spoken(text: str) -> str:
    """去掉全部行内标记后的台词：要念的、进字幕和 narration.json 的、被 --verify 比对的就是它。"""
    return "".join(s["text"] for s in parse(text))


def has_markup(text: str) -> bool:
    return bool(MARK.search(text))


# ---------------------------------------------------------------------------
# 语义区间 [@id] … [@/id]
# 为什么：vo.at('词') 只能锚一个词；「讲规则的这半句」这种语义段落要两头各写一个关键词，
# 改一个字就要改两处，而且同一个词出现两次时 nth 跟着变。区间标记写在台词里，跟着文本走。
# 它是零宽的：不念、不切段、不改请求体，也不进 narration.json 的 text——对接口和字级时间戳完全透明。
# 区间只在一句之内（跨句用 vo.line() 的边界）；可以嵌套、相邻、交叉（闭合按 id 配对）；id 全片唯一。
# ---------------------------------------------------------------------------
def spans(text: str) -> list[dict]:
    """→ [{id, a, b}]：区间在 spoken(text) 里的字符下标（左闭右开），按开标记出现顺序。"""
    out, opened, pos, n = [], {}, 0, 0
    for m in MARK.finditer(text):
        n += m.start() - pos
        pos = m.end()
        body = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
        sm = SPAN.match(body)
        if not sm or not sm.group(2):
            continue
        close, sid = sm.group(1) == "/", sm.group(2)
        if not close:
            if sid in opened or any(o["id"] == sid for o in out):
                raise MarkupError(f"区间「{sid}」在这一句里开了两次")
            opened[sid] = len(out)
            out.append({"id": sid, "a": n, "b": None})
        else:
            if sid not in opened:
                raise MarkupError(f"「{m.group(0)}」没有对应的 [@{sid}]")
            out[opened.pop(sid)]["b"] = n
    if opened:
        raise MarkupError(f"区间没闭合：{', '.join('[@' + k + ']' for k in opened)}（区间只在一句之内，要写 [@/<id>]）")
    sp = spoken(text)
    for o in out:
        if not _norm(sp[o["a"]:o["b"]]):
            raise MarkupError(f"区间「{o['id']}」里没有要念的字（只有标点/空白），没有时刻可取")
    return out


def strip_spans(text: str) -> str:
    """只去掉区间标记、保留其他标记。tts.py 的 script_hash 用它：区间不改声音，加/改区间不算「脚本改了没重跑」，
    没写区间的台词哈希不受影响。"""
    def keep(m):
        body = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
        sm = SPAN.match(body)
        return "" if sm and sm.group(2) else m.group(0)
    return MARK.sub(keep, text)


def build_spans(script_lines: list[dict], nar_lines: list[dict]) -> tuple[dict, list[str]]:
    """全片：script.json 的 lines（带标记原文）× narration.json 的 lines（字级时间戳，绝对秒）→ ({id: {start, end, line, text}}, 警告)。
    id 全片唯一；某句 narration 的 text 和去掉标记的台词对不上（脚本改了没重合成）抛 MarkupError。"""
    by_id = {l["id"]: l for l in nar_lines}
    out: dict = {}
    warns: list[str] = []
    for i, sl in enumerate(script_lines):
        lid = sl.get("id") or f"L{i + 1}"
        text = str(sl.get("text", ""))
        if not spans(text):
            continue
        nl = by_id.get(lid)
        if nl is None or nl.get("text") != spoken(text):
            raise MarkupError(f"{lid}: narration.json 里这一句和去掉标记后的台词对不上（脚本改了没重合成？），区间没法投影")
        try:
            got, w = project_spans(text, nl.get("words") or [])
        except MarkupError as e:
            raise MarkupError(f"{lid}: {e}") from None
        warns += [f"{lid}: {x}" for x in w]
        for sid, v in got.items():
            if sid in out:
                raise MarkupError(f"区间 id「{sid}」在 {out[sid]['line']} 和 {lid} 都用了：id 要全片唯一（vo.span(id) 按它取）")
            out[sid] = {"start": v["start"], "end": v["end"], "line": lid, "text": v["text"]}
    return out, warns


def _norm(x: str) -> str:
    import unicodedata
    return "".join(c for c in x if unicodedata.category(c)[0] not in "PZS").lower()


def project_spans(text: str, words: list[dict]) -> tuple[dict, list[str]]:
    """把 spans(text) 投影到这一句的字级时间戳上 → ({id: {start, end, text}}, 警告)。
    逐字把 spoken(text) 的字和 token 的字对上（标点/空白不算，大小写不敏感；发音词典的文本转写已由 tts.py 拼回原词）：
    区间 start = 第一个字所属 token 的 start，end = 最后一个字所属 token 的 end。
    区间边界切在一个多字 token 中间（英文词、词典条目）时扩到整个 token 并警告。
    逐字对不上（Whisper 反推的字和原文不同）抛 MarkupError——不猜。"""
    sl = spans(text)
    if not sl:
        return {}, []
    sp = spoken(text)
    owner = [None] * len(sp)          # spoken 字符下标 -> token 下标（只给字母/汉字）
    first_char: dict[int, int] = {}
    last_char: dict[int, int] = {}
    i = 0
    for k, w in enumerate(words):
        for c in _norm(w["w"]):
            while i < len(sp) and not _norm(sp[i]):
                i += 1
            if i >= len(sp) or _norm(sp[i]) != c:
                raise MarkupError(f"字级时间戳和台词逐字对不上（token「{w['w']}」，台词第 {i} 字附近），区间没法投影")
            owner[i] = k
            first_char.setdefault(k, i)
            last_char[k] = i
            i += 1
    out, warns = {}, []
    for o in sl:
        idx = [j for j in range(o["a"], o["b"]) if owner[j] is not None]
        if not idx:
            raise MarkupError(f"区间「{o['id']}」里的字没有时间戳")
        k0, k1 = owner[idx[0]], owner[idx[-1]]
        if first_char[k0] < idx[0] or last_char[k1] > idx[-1]:
            warns.append(f"区间「{o['id']}」的边界切在 token 中间（「{words[k0]['w']}」/「{words[k1]['w']}」），按整个 token 取")
        out[o["id"]] = {"start": words[k0]["start"], "end": words[k1]["end"], "text": sp[o["a"]:o["b"]]}
    return out, warns


def resolve(segs: list[dict], line_instruction: str | None) -> list[dict]:
    """把 INHERIT 换成这一句的默认指令；返回 [{text, instruction(str|None), pause_before}]。"""
    out = []
    for s in segs:
        ins = line_instruction if s["instruction"] is INHERIT else s["instruction"]
        out.append({"text": s["text"], "instruction": ins or None, "pause_before": s["pause_before"]})
    return out


def needs_split(segs: list[dict]) -> bool:
    """只有一段、没有静音 → 一次请求即可（句首的 [#…] 就是这一句的指令）。"""
    return len(segs) > 1 or any(s["pause_before"] for s in segs)


def selftest() -> int:
    cases = [
        ("围棋有多老？", ["围棋有多老？"], 1),
        ("[#放慢]围棋有多老？", ["围棋有多老？"], 1),
        ("围棋有多老？[停顿 0.6]传说，是尧造的。", ["围棋有多老？", "传说，是尧造的。"], 2),
        ("【#轻声】但那只是传说。", ["但那只是传说。"], 1),
        ("A[#快]B[#]C", ["A", "B", "C"], 3),
        ("A[停顿600ms]B", ["A", "B"], 2),
    ]
    bad = ["A[快]B", "A[停顿 20]B", "A]B", "A【停顿】B"]
    n = 0
    for text, want, k in cases:
        segs = parse(text)
        got = [s["text"] for s in segs]
        ok = got == want and len(segs) == k and spoken(text) == "".join(want)
        n += not ok
        print(("✓" if ok else "✗"), repr(text), "→", got, [s["pause_before"] for s in segs])
    for text in bad:
        try:
            parse(text)
            print("✗ 应报错却没报：", repr(text))
            n += 1
        except MarkupError as e:
            print("✓ 报错", repr(text), str(e)[:40])
    # 语义区间：零宽、不切段、可嵌套/相邻/交叉
    sc = [("围棋[@q]有多老[@/q]？", "围棋有多老？", 1, {"q": (2, 5)}),
          ("[@a]黑棋[@b]圈住[@/a]左边[@/b]。", "黑棋圈住左边。", 1, {"a": (0, 4), "b": (2, 6)}),
          ("[@x]上[@/x]，[@y]下[@/y]", "上，下", 1, {"x": (0, 1), "y": (2, 3)}),
          ("[#慢][@r]A[停顿 0.5]B[@/r]", "AB", 2, {"r": (0, 2)})]
    for text, want, k, wsp in sc:
        got = {o["id"]: (o["a"], o["b"]) for o in spans(text)}
        ok = spoken(text) == want and len(parse(text)) == k and got == wsp
        n += not ok
        print(("✓" if ok else "✗"), "区间", repr(text), "→", repr(spoken(text)), got)
    for text in ["[@a]A", "A[@/a]", "[@a]A[@/a][@a]B[@/a]", "[@]A", "[@a]，[@/a]A", "[@a b]A[@/a b]"]:
        try:
            spans(text)
            print("✗ 区间应报错却没报：", repr(text))
            n += 1
        except MarkupError as e:
            print("✓ 区间报错", repr(text), str(e)[:40])
    ws = [{"w": "黑", "start": 1.0, "end": 1.2}, {"w": "棋，", "start": 1.2, "end": 1.5},
          {"w": "ffmpeg", "start": 1.6, "end": 2.0}]
    got, warns = project_spans("[@a]黑[@/a]棋，[@b]ff[@/b]mpeg", ws)
    ok = got == {"a": {"start": 1.0, "end": 1.2, "text": "黑"}, "b": {"start": 1.6, "end": 2.0, "text": "ff"}} and len(warns) == 1
    n += not ok
    print(("✓" if ok else "✗"), "区间投影", got, warns)
    segs = resolve(parse("[#低沉]A[#]B"), "默认")
    ok = [s["instruction"] for s in segs] == ["低沉", "默认"]
    n += not ok
    print(("✓" if ok else "✗"), "resolve 继承", [s["instruction"] for s in segs])
    return n


if __name__ == "__main__":
    import sys
    if any(a in ("-h", "--help") for a in sys.argv[1:]):
        print("用法：python3 _markup.py   跑本模块的自测（不读写任何文件），全过退出 0")
        sys.exit(0)
    if sys.argv[1:]:
        print(f"✗ 未知参数 {sys.argv[1]}（本脚本不收参数，--help 查看用法）", file=sys.stderr)
        sys.exit(2)
    sys.exit(1 if selftest() else 0)
