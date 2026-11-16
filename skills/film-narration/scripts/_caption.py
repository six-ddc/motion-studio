"""字幕显示文本：把"给人看的字"挂到"念出来的字级时间戳"上。

坑：TTS / Whisper 返回的 token 不是字幕。
- 没有标点（edge 整句去掉标点；volcano 有时给零宽标点 token，有时没有）；
- 分词按引擎的切法来，不按意思（实测 edge 切成「叫定|宽曲|线」「圆和|排滚」）；
- 念法和写法不同：「百分之九十八点八」写作 98.8%，「派乘以宽度」写作 π×w，发音词典的转写字更不该上屏。
直接拿 token 拼字幕，就是一行没有标点、断在词中间的字。所以字幕的**文字**来自稿子，**时间**来自 token：

    显示文本 = script.json 这一句的 caption（有就用，可用 | 强制断行），否则 = 去掉控制标记的台词原文（带标点）
    每个字归属到念它的那个 token（逐字对齐；写法和念法不同的一段整体挂到那段的第一个 token 上）
    → narration.json 每个词多两个字段：d（这个词在屏幕上显示成什么，可为空串）、br（显示完这个词之后强制断行）

w 字段不变：vo.at('关键词') 仍按念出来的字查。
"""
from __future__ import annotations

import difflib
import unicodedata

OPENERS = set("「『“‘（(《【[〈")


def _key(c: str) -> str:
    """单字的比对键：标点、空白、符号不参与对齐（它们跟着相邻的字走）。"""
    return "" if unicodedata.category(c)[0] in "PZS" else c.lower()


class CaptionError(ValueError):
    pass


def project_caption(display: str, words: list[dict], *, min_ratio: float = 0.5) -> tuple[list[dict], list[str]]:
    """display（给人看的这一句）× words（这一句的字级时间戳）→ ([{d, br}] 与 words 等长, 警告)。

    对齐用 difflib 逐字比对（大小写不敏感，标点空白不参与）：
    - 相同的字：归属到念它的 token；
    - 写法≠念法的一段（98.8% ↔ 百分之九十八点八）：整段挂到那段第一个 token 上，其余 token 的 d 为空串；
    - 只写不念的字：跟前一个字走；只念不写的 token：d 为空串；
    - 标点、空白跟前一个字走（开引号、开括号跟后一个字走）。
    字能对上的比例低于 min_ratio 抛 CaptionError：那多半是 caption 写成了另一句话，不猜。"""
    brk_after: set[int] = set()
    chars: list[str] = []
    for c in display:
        if c == "|":
            if chars:
                brk_after.add(len(chars) - 1)
            continue
        chars.append(c)
    n = len(words)
    if not n:
        return [], []
    dk_pos = [i for i, c in enumerate(chars) if _key(c)]
    dk = "".join(_key(chars[i]) for i in dk_pos)
    sk, sowner = [], []
    for k, w in enumerate(words):
        for c in str(w.get("w", "")):
            if _key(c):
                sk.append(_key(c))
                sowner.append(k)
    sk = "".join(sk)
    if not dk or not sk:
        raise CaptionError("这一句没有可对齐的字")
    sm = difflib.SequenceMatcher(None, dk, sk, autojunk=False)
    owner_k: list[int | None] = [None] * len(dk)
    matched = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for t in range(i2 - i1):
                owner_k[i1 + t] = sowner[j1 + t]
            matched += i2 - i1
        elif tag == "replace":
            for t in range(i1, i2):
                owner_k[t] = sowner[j1]
        # delete（只写不念）留 None，下面跟前一个字；insert（只念不写）什么都不做
    ratio = matched / min(len(dk), len(sk))   # 写法和念法长度可以差很多（98.8% ↔ 百分之九十八点八），按短的一边算
    if ratio < min_ratio:
        raise CaptionError(f"显示文本和念的字只对上 {ratio:.0%}（< {min_ratio:.0%}）：caption 是不是写成了另一句话？")
    # 只写不念的字：跟前一个有归属的字（开头的跟后一个）
    last = None
    for t in range(len(owner_k)):
        if owner_k[t] is None:
            owner_k[t] = last
        last = owner_k[t]
    first = next((o for o in owner_k if o is not None), 0)
    owner_k = [first if o is None else o for o in owner_k]
    # 单调：显示顺序不能倒着挂（倒挂会让高亮往回跳）
    run = 0
    for t in range(len(owner_k)):
        run = max(run, owner_k[t])
        owner_k[t] = run
    # 每个显示字符（含标点空白）的归属
    owner_c: list[int] = [0] * len(chars)
    key_at = {p: owner_k[t] for t, p in enumerate(dk_pos)}
    prev = None
    pending: list[int] = []        # 开引号等：等后一个字
    for i, c in enumerate(chars):
        if i in key_at:
            o = key_at[i]
            for p in pending:
                owner_c[p] = o
            pending = []
            owner_c[i] = o
            prev = o
        elif c in OPENERS or prev is None:
            pending.append(i)
        else:
            owner_c[i] = prev
    for p in pending:
        owner_c[p] = prev if prev is not None else 0
    out = [{"d": "", "br": False} for _ in range(n)]
    for i, c in enumerate(chars):
        out[owner_c[i]]["d"] += c
    for i in brk_after:
        out[owner_c[i]]["br"] = True
    warns = []
    if ratio < 0.9:
        warns.append(f"显示文本和念的字对上 {ratio:.0%}，写法和念法差得较多的地方按整段挂时间，逐字高亮会粗一些")
    return out, warns


def apply(display: str, words: list[dict]) -> list[str]:
    """就地给 words 写 d / br（br 只在 True 时写）。返回警告。"""
    got, warns = project_caption(display, words)
    for w, g in zip(words, got):
        w["d"] = g["d"]
        if g["br"]:
            w["br"] = True
        else:
            w.pop("br", None)
    return warns


def disp(w: dict) -> str:
    """词在屏幕上的样子：有 d 用 d，否则退回念出来的 token。"""
    return w["d"] if "d" in w else w["w"]


def selftest() -> int:
    n = 0

    def check(name, display, toks, want_d, want_br=None):
        nonlocal n
        ws = [{"w": t, "start": i, "end": i + 1} for i, t in enumerate(toks)]
        got, _ = project_caption(display, ws)
        d = [g["d"] for g in got]
        br = [i for i, g in enumerate(got) if g["br"]]
        ok = (want_d is None or d == want_d) and (want_br is None or br == want_br) and "".join(d) == display.replace("|", "")
        n += not ok
        print(("✓" if ok else "✗"), name, d, br)

    # edge：token 无标点、分词怪
    check("edge 分词", "这叫定宽曲线。它和圆一样宽！", ["这", "叫定", "宽曲", "线", "它", "和圆", "一样", "宽"],
          ["这", "叫定", "宽曲", "线。", "它", "和圆", "一样", "宽！"])
    # 写法≠念法：整段挂第一个 token
    check("数字写法", "扫过的面积是98.8%。", ["扫过", "的", "面积", "是", "百分之", "九十八", "点八"],
          ["扫过", "的", "面积", "是", "98.8%。", "", ""])
    # 强制断行与开引号
    check("断行与引号", "他说|「对」。", ["他", "说", "对"], ["他", "说", "「对」。"], [1])
    # 拉丁词与空格
    check("英文空格", "调用 seek 函数", ["调用", "seek", "函数"], ["调用 ", "seek ", "函数"])
    # 只写不念
    check("写法换符号", "周长=π×w", ["周长", "等于", "派", "乘以", "w"], None)
    try:
        project_caption("完全是另一句话", [{"w": "天气", "start": 0, "end": 1}, {"w": "很好", "start": 1, "end": 2}])
        print("✗ 应报错却没报")
        n += 1
    except CaptionError as e:
        print("✓ 报错", str(e)[:30])
    return n


if __name__ == "__main__":
    import sys
    sys.exit(1 if selftest() else 0)
