#!/usr/bin/env python3
"""check_shotlist.py — 把 docs/shotlist.md 和 narration.json 对账。

查这些（全是机械活，不靠嘱咐）：
  0. 留白对账：shotlist 的 vo_offset / pads.tail 与 film.json narrationOffset / narrationTail 一致（真相源是 film.json）。
  1. 时刻从哪来：镜头起止、关键帧、曲线钉点必须是 narration 锚点，数字字面量 = 手填秒数 = 报错。
  2. 覆盖：镜头首尾相接、不重叠；每句旁白都落在某个镜头里。
  3. 叙事权重 vs 物理时长：segments 里声明的"重要区间"实际拿到几秒，低于下限报错。
     （唐片安史之乱 755→757 按年线性映射只拿到 0.11s，就是这条要抓的）
  4. 音画矛盾：claims 里写"这句旁白在断言机制处于什么状态"，脚本在旁白实测区间上
     逐毫秒求曲线值验证。（唐片"纸上只剩一点余墨"时墨量已经是 0，就是这条要抓的）
     source 为 scene / pixels / anchor 的曲线只验意图与规格，画面实测交给 film-critique check.mjs（--plan / --verdict）。
  5. 发散留痕（film.json checks 声明了 divergence 才查）：讲法 / 视觉方向 / 近作对照写没写。
     只声明了 divergence、没声明 shotlist 的片子只查这一项（0–4 不跑，也不要求 narration.json）。
  另有提示（不判失败）：没有 keyframes、正文疑似手写秒数、镜头功能（role）占比。

用法：
  python3 check_shotlist.py --film <slug> [--films-dir <dir>] [--write] [--floor 1.0]
  找片：--film 给 slug 或片子目录；films/ 按 --films-dir > $FILMS_DIR > 从 cwd 往上找（film-core lib/film.py）
  （--plan / --verdict / --divergence 是给 check.mjs、siblings.mjs 调的机器接口，输出 JSON）

只用标准库。exit 0 = 通过；1 = 对账失败；2 = 输入缺失或格式错。
shotlist.md 里第一个 ```json 代码块是机器可读部分，格式见 references/templates.md。
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
import film as core  # noqa: E402  film-core 的找片 / 参数守卫 / checks 读取

PUNCT = re.compile(r"[\s，。、；：！？,.;:!?\"'“”‘’()（）《》—…·\-]")
BEGIN, END = "<!-- timeline:begin -->", "<!-- timeline:end -->"


def die(msg, code=2):
    print(f"[check_shotlist] 错误: {msg}", file=sys.stderr)
    sys.exit(code)


class Timeline:
    """把锚点字符串解析成秒。锚点语法：
       start | end | vo.end | s3 | s3.start | s3.end | s3@裂痕 | s3@裂痕.end | s3@一#2 | span:rule | span:rule.end
       后面可接 +pad名 / -pad名（pad 在 pads 里具名声明）。
    """

    def __init__(self, nar, pads, off, tail):
        self.lines = {l["id"]: l for l in nar.get("lines", [])}
        if not self.lines:
            die("narration.json 里没有 lines[]")
        self.spans = nar.get("spans") or {}
        self.pads = pads
        self.off = float(off)          # film.json narrationOffset：旁白第 0 秒落在成片第几秒
        self.tail = tail               # film.json narrationTail（没写时退回 shotlist pads.tail，并提示迁过去）；None = 没声明
        self.vo_end = float(nar["duration"]) if "duration" in nar else max(l["end"] for l in self.lines.values())
        self.film_end = None  # 由 tail 决定，见 resolve('end')

    def _pad(self, name):
        if isinstance(name, (int, float)):
            raise ValueError(f"vo_offset 写成了数字 {name}，请在 pads 里具名声明再引用")
        if name not in self.pads:
            raise ValueError(f"未声明的 pad: {name}")
        return float(self.pads[name])

    def _word_span(self, line, word, nth):
        # Match film-narration/assets/runtime/narration.js: strip punctuation, casefold, and enforce token boundaries.
        chars, owner, word_start = [], [], set()
        for i, w in enumerate(line.get("words", [])):
            k = PUNCT.sub("", w["w"]).lower()
            if not k:
                continue
            word_start.add(len(chars))
            for ch in k:
                chars.append(ch)
                owner.append(i)
        text = "".join(chars)
        target = PUNCT.sub("", word).lower()
        if not target:
            raise ValueError(f"关键词「{word}」去掉标点后为空")
        word_end = lambda p: p == len(text) or p in word_start
        pos, seen = -1, 0
        while True:
            pos = text.find(target, pos + 1)
            if pos < 0:
                raise ValueError(f"{line['id']} 里找不到第 {nth} 个「{word}」（共见到 {seen} 次；该句文本：{line['text']}）")
            if pos in word_start and word_end(pos + len(target)):
                seen += 1
                if seen == nth:
                    ws = line["words"]
                    return ws[owner[pos]]["start"], ws[owner[pos + len(target) - 1]]["end"]

    def resolve(self, a):
        if isinstance(a, (int, float)):
            raise ValueError(f"手填秒数 {a} —— 时刻必须写成 narration 锚点（如 s3.start、s3@裂痕）")
        if not isinstance(a, str):
            raise ValueError(f"锚点类型错: {a!r}")
        m = re.fullmatch(r"\s*([^+\-]+?)\s*((?:[+\-]\s*[A-Za-z_一-鿿][\w一-鿿]*\s*)*)", a)
        if not m:
            raise ValueError(f"锚点语法错: {a!r}（偏移只能用具名 pad，例如 s5.end+tail）")
        base, rest = m.group(1), m.group(2)
        t = self._base(base)
        for sign, name in re.findall(r"([+\-])\s*([A-Za-z_一-鿿][\w一-鿿]*)", rest):
            t += self._pad(name) if sign == "+" else -self._pad(name)
        return round(t, 4)

    def _base(self, b):
        if re.fullmatch(r"[\d.]+", b):
            raise ValueError(f"手填秒数 {b} —— 改成 narration 锚点")
        if b == "start":
            return 0.0
        if b == "vo.end":
            return self.vo_end + self.off
        if b == "end":
            if self.tail is None:
                raise ValueError("用了锚点 end，但 film.json 没有 narrationTail（片尾留白，秒）")
            return self.vo_end + self.off + float(self.tail)
        sm = re.fullmatch(r"span:([A-Za-z0-9_.\u4e00-\u9fff]+?)(?:\.(start|end))?", b)
        if sm:
            sa, sb = self.named_span(sm.group(1))
            return sa if (sm.group(2) or "start") == "start" else sb
        m = re.fullmatch(r"([A-Za-z0-9_]+)(?:@([^.#]+)(?:#(\d+))?)?(?:\.(start|end))?", b)
        if not m or m.group(1) not in self.lines:
            raise ValueError(f"锚点 {b!r} 指向不存在的旁白句（已有：{', '.join(self.lines)}）")
        line, word, nth, edge = self.lines[m.group(1)], m.group(2), int(m.group(3) or 1), m.group(4) or "start"
        if word:
            s, e = self._word_span(line, word, nth)
        else:
            s, e = line["start"], line["end"]
        return (s if edge == "start" else e) + self.off

    def named_span(self, sid):
        if sid not in self.spans:
            have = ", ".join(self.spans) or "无"
            raise ValueError(f"语义区间 {sid!r} 在 narration.json spans 里不存在（已有：{have}）")
        sp = self.spans[sid]
        return sp["start"] + self.off, sp["end"] + self.off

    def line_span(self, lid):
        l = self.lines[lid]
        return l["start"] + self.off, l["end"] + self.off


class Curves:
    """机制状态曲线。keys 钉在锚点上（时间曲线），或钉在另一条曲线的值域上（of）。
    钉点之间线性插值 —— 足够查端点和单调性；实现时可以换缓动，但钉点值不能变。"""

    def __init__(self, spec, tl):
        self.spec, self.tl, self.cache = spec, tl, {}

    def source(self, name):
        """curve = 场景读的就是这些钉点（本脚本验的就是画面，差一个缓动）；
        scene / pixels = 画面上的这个量是别处推出来的（仿真、迭代、库、数据），钉点只是意图，
        真值要到有浏览器的阶段取：scene → window.probe(t)，pixels → 截帧数像素，
        anchor → window.anchors(t) 里某个锚点的屏幕框（场景绘制时登记的，film-core references/runtime.md §6）（都在 film-critique check.mjs）。"""
        c = self.spec.get(name)
        return (c or {}).get("source", "curve")

    def has_keys(self, name):
        return bool((self.spec.get(name) or {}).get("keys"))

    def _keys(self, name):
        if name in self.cache:
            return self.cache[name]
        if name not in self.spec:
            raise KeyError(f"曲线 {name} 没有在 curves 里声明")
        c = self.spec[name]
        if "of" in c:
            keys = [(float(x), float(v)) for x, v in c["keys"]]
        else:
            keys = [(self.tl.resolve(a), float(v)) for a, v in c["keys"]]
        if any(keys[i][0] > keys[i + 1][0] for i in range(len(keys) - 1)):
            raise ValueError(f"曲线 {name} 的钉点没有按自变量递增（检查锚点顺序）")
        self.cache[name] = keys
        return keys

    @staticmethod
    def _interp(keys, x):
        if x <= keys[0][0]:
            return keys[0][1]
        for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
            if x <= x1:
                return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        return keys[-1][1]

    def at(self, name, t):
        c = self.spec[name]
        x = self.at(c["of"], t) if "of" in c else t
        return self._interp(self._keys(name), x)


OPS = {">": lambda v, x: v > x, ">=": lambda v, x: v >= x, "<": lambda v, x: v < x,
       "<=": lambda v, x: v <= x, "==": lambda v, x: abs(v - x) < 1e-6}
TREND_FLAT = 0.2  # 趋势断言：区间头/尾有 ≥20% 时长值一动不动，就提醒（端点比较看不见它）


def eval_claim(c, ts, vals):
    """一条断言在一组 (t, 值) 上的判定。返回 (bad, warn, bad_t, summary)。
    分镜阶段（意图曲线、逐毫秒）和自检阶段（film-critique check.mjs 交来的场景实测/像素实测、逐帧）
    共用这一个函数：同一份断言只能有一种语义，两边各写一份迟早给出相反结论。"""
    op, name = c["op"], c["curve"]
    if not ts:
        return "区间里一个采样点都没有", None, None, ""
    if any(v is None for v in vals):
        k = next(i for i, v in enumerate(vals) if v is None)
        # 按曲线来源给原因：三种来源的"无值"是三件不同的事。
        # 旧版除 anchor 外一律说"像素无质心"，scene 曲线的 probe 返回 null 也这么报，把人引去查颜色范围。
        src = c.get("source")
        why = {"anchor": "锚点这一帧没有登记：没画，或画了没登记",
               "pixels": "像素统计在没有匹配像素时无质心",
               "scene": "window.probe(t) 这一帧给这条曲线返回了 null：probe 没算这个量，或这一刻场景里没有它"
               }.get(src, "这一帧没有值")
        return f"t={ts[k]:.3f}s 时 {name} 无值（{why}）", None, ts[k], ""
    bad, bad_t, warn = None, None, None
    if op in OPS:
        for t, v in zip(ts, vals):
            if not OPS[op](v, c["value"]):
                bad, bad_t = f"t={t:.3f}s 时 {name}={v:.3f}，不满足 {op} {c['value']}", t
                break
    elif op in ("falling", "rising"):
        delta = vals[-1] - vals[0]
        if (op == "falling" and delta >= 0) or (op == "rising" and delta <= 0):
            bad, bad_t = f"{name} 在区间内从 {vals[0]:.3f} 到 {vals[-1]:.3f}，不是 {op}", ts[0]
        else:
            # 趋势只比端点：0,0,0,…,0,5 也算 rising。旁白说的若是"正在发生"，开头那段平台就是音画矛盾
            # （ghost-jam s4「一辆传一辆」开头 0.6–0.9s 一盏灯都没有，rising 照样通过）。只提醒，不判失败。
            tol = c.get("tol") or 1e-9
            span = ts[-1] - ts[0]
            head = next((t for t, v in zip(ts, vals) if abs(v - vals[0]) > tol), ts[-1]) - ts[0]
            tail = ts[-1] - next((t for t, v in zip(reversed(ts), reversed(vals)) if abs(v - vals[-1]) > tol), ts[0])
            for where, d, v in (("开头", head, vals[0]), ("末尾", tail, vals[-1])):
                if span > 0 and d >= TREND_FLAT * span and d >= 0.3:
                    warn = (f"{op} 只比端点；区间{where} {d:.2f}s（占 {d / span:.0%}）{name} 一直是 {v:g} 没动。"
                            f"旁白若说的是'正在发生'，补一条水平断言（如 >= 某值）")
                    break
    elif op == "steady":
        if max(vals) - min(vals) > (c.get("tol") if c.get("tol") is not None else 0.02):
            k = max(range(len(vals)), key=lambda i: abs(vals[i] - vals[0]))
            bad, bad_t = f"{name} 在区间内变化 {max(vals) - min(vals):.3f}，不是 steady", ts[k]
    else:
        return f"未知 op {op}", None, None, ""
    return bad, warn, bad_t, f"{vals[0]:.3f}…{vals[-1]:.3f}"


PIXEL_STATS = ("count", "cx", "cy", "motion")


def check_pixels_spec(name, p):
    """source: pixels 的曲线要声明怎么从一帧里数出这个量。分镜阶段没有浏览器，只验写法，
    真正去数在 film-critique check.mjs。返回错误列表。"""
    errs = []
    if not isinstance(p, dict):
        return [f"曲线 {name} 是 source: pixels，但没有 pixels 规格（{{near,tol}} 或 {{r,g,b}} 区间 + stat）"]
    st = p.get("stat")
    if st not in PIXEL_STATS:
        errs.append(f"曲线 {name} 的 pixels.stat 必须是 {' / '.join(PIXEL_STATS)}，写的是 {st!r}")
    if st != "motion":
        has_near = isinstance(p.get("near"), str) and re.fullmatch(r"#[0-9a-fA-F]{6}", p["near"])
        has_rng = all(isinstance(p.get(k), list) and len(p[k]) == 2 for k in "rgb")
        if not (has_near or has_rng):
            errs.append(f"曲线 {name} 的 pixels 要么写 near: \"#rrggbb\"（+ tol），要么写 r/g/b 三个 [lo,hi] 区间")
    reg = p.get("region")
    if reg is not None and not (isinstance(reg, list) and len(reg) == 4 and all(0 <= x <= 1 for x in reg)
                                and reg[0] < reg[2] and reg[1] < reg[3]):
        errs.append(f"曲线 {name} 的 pixels.region 是 [x0,y0,x1,y1]，画幅比例 0..1")
    return errs


ANCHOR_STATS = ("cx", "cy", "w", "h")


def check_anchor_spec(name, a):
    """source: anchor 的曲线要说取哪个锚点的哪个量（归一化到画面宽高，0..1，可越界 = 出画）。
    分镜阶段只验写法；锚点名是否真被场景登记，要到 check.mjs 逐帧取 window.anchors(t) 才知道。"""
    if not isinstance(a, dict):
        return [f"曲线 {name} 是 source: anchor，但没有 anchor 规格（{{\"name\": 锚点名, \"stat\": cx/cy/w/h}}）"]
    errs = []
    if not isinstance(a.get("name"), str) or not a["name"]:
        errs.append(f"曲线 {name} 的 anchor.name 要写场景登记的锚点名（非空字符串）")
    if a.get("stat") not in ANCHOR_STATS:
        errs.append(f"曲线 {name} 的 anchor.stat 必须是 {' / '.join(ANCHOR_STATS)}，写的是 {a.get('stat')!r}")
    return errs


def fmt(x):
    return f"{x:7.3f}"


# ---------- 发散留痕：讲法（mechanism.md）/ 视觉方向 + 近作对照（style_guide.md） ----------
# 方法见 references/divergence.md。这里只查"这一步留下了实质的痕迹"，不评判选得好不好。
# 宽容格式：候选可以是 ### 标题、**粗体行**、"- **…**" 列表项；编号 0/A/B/一/二 都认；节名有几种叫法。
# 严格实质：≥2 个候选、有一个标了选定、每个落选的写了输在哪；或者一条带理由的跳过声明 + 一行选定。
# 样板 films/weiqi-intro/docs/style_guide.md（"视觉概念：三个方向，选了一个"）必须一字不改就通过。
DIV_COMMENT = re.compile(r"<!--.*?-->", re.S)
DIV_HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
DIV_BOLD = re.compile(r"^\s*(?:[-*+]\s+)?\*\*(.+?)\*\*")
DIV_ID = re.compile(r"^(?:候选|概念|方向|讲法|结构|look)?\s*([0-9]|[A-Z]|[一二三四五六七八])(?=\s*[.、·:：）)]|\s|$)", re.I)
DIR_SEC = re.compile(r"视觉方向|视觉概念|长相|\blook\b", re.I)
STRUCT_SEC = re.compile(r"讲法|脚本结构|叙事结构")
NEAR_RE = re.compile(r"近作|拉开|前[一二两三几]支|其他片子|别的片子|siblings", re.I)
WON = re.compile(r"选定|选中|采用")
LOST = re.compile(r"落选|淘汰|死于|否决|吸收|放弃")
REASON = re.compile(r"(输在[哪里]?|代价|理由|因为|死于[^\s：:]*|演不出|读不出|看不出|不如|淘汰原因)\s*[：:—\-]*\s*(.*)")
SKIP = re.compile(r"跳过")
MEANINGFUL = re.compile(r"[\w一-鿿]")


def _meaningful(s, n):
    """一段文字里至少有 n 个字/字母/数字（标点、星号、空白不算）——判"写了东西"而不是"留了个标签"。"""
    return len(MEANINGFUL.findall(s or "")) >= n


def _div_lines(text):
    return DIV_COMMENT.sub("", text or "").splitlines()


def _marker(line):
    """标题行或粗体行的文字（候选、节名都从这里认）；普通正文行返回 None。"""
    h = DIV_HEAD.match(line)
    if h:
        return len(h.group(1)), h.group(2)
    b = DIV_BOLD.match(line)
    if b:
        return 99, b.group(1)          # 粗体行不是层级，不截断所在的节
    return None


def _section(lines, pat):
    """第一个名字匹配 pat 的 # 标题节：返回 (标题文字, 节内各行)；没有返回 (None, [])。"""
    for i, line in enumerate(lines):
        h = DIV_HEAD.match(line)
        if h and pat.search(h.group(2)):
            lvl, body = len(h.group(1)), []
            for nxt in lines[i + 1:]:
                h2 = DIV_HEAD.match(nxt)
                if h2 and len(h2.group(1)) <= lvl:
                    break
                body.append(nxt)
            return h.group(2), body
    return None, []


def _status(s):
    """一行里先出现的是"选定"还是"落选/死于/吸收"——"落选（与选定方向相比…）"算落选。"""
    w, l = WON.search(s), LOST.search(s)
    if w and (not l or w.start() < l.start()):
        return "won"
    if l:
        return "lost"
    return None


def _candidates(body):
    """节内的候选：带编号的标题/粗体行开一个候选，到下一个候选或节尾为止。"""
    cands, cur = [], None
    for line in body:
        mk = _marker(line)
        m = DIV_ID.match(mk[1].strip()) if mk else None
        if m:
            cur = {"id": m.group(1).upper(), "title": mk[1].strip(), "lines": []}
            cands.append(cur)
        elif cur is not None:
            cur["lines"].append(line)
    for c in cands:
        st = _status(c["title"])
        if st is None:
            for line in c["lines"]:
                if re.match(r"\s*(?:[-*+]\s+)?(?:\*\*)?结果", line):
                    st = _status(line)
                    if st:
                        break
        c["status"] = st
        c["reasoned"] = any(_meaningful(m.group(2), 4) for line in c["lines"]
                            for m in [REASON.search(line)] if m)
        c["default"] = c["id"] == "0" or "默认" in c["title"]
    return cands


def _skip_and_pick(body):
    """跳过声明（"跳过…：<理由>"）和一行"选定：…"。返回 (跳过理由或 None, 选定那行或 None)。"""
    skip = pick = None
    for line in body:
        s = line.strip()
        m = SKIP.search(s)
        if m and skip is None and _meaningful(s[m.end():], 8):
            skip = s
        p = WON.search(s)
        if p and pick is None and not SKIP.search(s) and _meaningful(s[p.end():], 4):
            pick = s
    return skip, pick


def _judge(cands, body, what, need_default):
    """一节候选/跳过的判定 → (失败列表, 摘要, 选定的那一行)。"""
    errs = []
    skip, pick = _skip_and_pick(body)
    won = [c for c in cands if c["status"] == "won"]
    if len(cands) >= 2 or (cands and not skip):
        if len(cands) < 2:
            errs.append(f"{what}只有 {len(cands)} 个候选（发散要 ≥2 个；不发散就写一条带理由的跳过声明）")
        if not won:
            errs.append(f"{what}的 {len(cands)} 个候选里没有一个标了「选定」")
        for c in cands:
            if c["status"] is None:
                errs.append(f"{what}候选 {c['id']}「{c['title'][:24]}」没写结果（选定 / 落选 / 死于… / 吸收）")
            elif c["status"] == "lost" and not c["reasoned"]:
                errs.append(f"{what}候选 {c['id']}「{c['title'][:24]}」落选了但没写输在哪")
        if need_default and not any(c["default"] for c in cands):
            errs.append(f"{what}没有候选 0（本题的默认{'讲法' if '讲法' in what else '长相'}）——它要写成正式候选、由判据杀死，而不是被回避")
        summ = f"{len(cands)} 个候选，选定 {'/'.join(c['id'] for c in won) or '—'}"
        chosen = won[0] if won else None
    elif skip:
        if not pick:
            errs.append(f"{what}声明了跳过，但没写「选定：…」——跳过的是发散，不是选择")
        summ, chosen = f"跳过：{skip[:40]}", ({"title": pick, "lines": []} if pick else None)
    else:
        errs.append(f"{what}既没有候选也没有跳过声明")
        summ, chosen = "—", None
    return errs, summ, chosen


def divergence(film):
    """返回 {"errors": [...], "warns": [...], "rows": [...], "direction": 选定的视觉方向那一行或 None}。
    siblings.mjs 用 --divergence 取 direction，和门用同一份解析——两处各写一份迟早给出相反结论。"""
    out = {"errors": [], "warns": [], "rows": [], "direction": None, "direction_detail": None}
    docs = film / "docs"
    sib = sorted(d.name for d in film.parent.iterdir()
                 if d.is_dir() and d.name != film.name and not d.name.startswith((".", "_")))

    # 视觉方向（style_guide.md 顶部）+ 近作对照
    sg = docs / "style_guide.md"
    if not sg.exists():
        out["errors"].append("docs/style_guide.md 不存在 —— 视觉方向要在分镜之前定（film-story references/divergence.md）")
    else:
        lines = _div_lines(sg.read_text(encoding="utf-8"))
        name, body = _section(lines, DIR_SEC)
        if name is None:
            out["errors"].append("style_guide.md 没有视觉方向一节（标题含「视觉方向」「视觉概念」或「长相」）："
                                 "≥2 个候选并标明选定，或一条带理由的跳过声明")
            out["rows"].append("  BAD 视觉方向  —")
        else:
            errs, summ, chosen = _judge(_candidates(body), body, "视觉方向", need_default=False)
            out["errors"] += errs
            if chosen:
                clean = lambda x: re.sub(r"[*`]", "", x).strip()
                out["direction"] = clean(chosen["title"])
                out["direction_detail"] = next((clean(x)[:80] for x in chosen["lines"] if _meaningful(x, 6)), None)
            out["rows"].append(f"  {'OK ' if not errs else 'BAD'} 视觉方向  「{name}」 {summ}")
        # 近作对照：一个名字含"近作/拉开/前两支…"的标题、粗体行或以它开头的行，到下一个标题为止
        block, label = None, None
        for i, line in enumerate(lines):
            mk = _marker(line)
            hit = (mk and NEAR_RE.search(mk[1])) or NEAR_RE.match(re.sub(r"^\s*(?:[-*+]\s+)?", "", line))
            if hit:
                label, block = (mk[1] if mk else line.strip()), [line]
                for nxt in lines[i + 1:]:
                    if DIV_HEAD.match(nxt):
                        break
                    block.append(nxt)
                break
        if block is None:
            out["errors"].append("style_guide.md 没有近作对照（标题或行首含「近作」「拉开」「前两支」之类）："
                                 "跑 siblings.mjs 看过其他片子，写下拉开了什么、或有意重复了什么")
            out["rows"].append("  BAD 近作对照  —")
        else:
            text = "\n".join(block)
            named = [s for s in sib if s in text]
            skip, _ = _skip_and_pick(block)
            alone = re.search(r"没有(其他|别的)片子|第一支片子", text)
            ok = bool(named or skip or alone)
            if not ok:
                out["errors"].append(f"近作对照「{label[:20]}」没有点名任何一支其他片子（现有：{' / '.join(sib) or '无'}）"
                                     f"——要么点名并写拉开/重复了什么，要么写「仓库里没有其他片子」，要么写跳过理由")
            how = f"点名 {', '.join(named)}" if named else ("跳过：" + skip[:40] if skip else ("无其他片子" if alone else "未点名"))
            out["rows"].append(f"  {'OK ' if ok else 'BAD'} 近作对照  「{label[:20]}」 {how}")

    # 讲法（mechanism.md 的「讲法」一节）
    mech = docs / "mechanism.md"
    lines = _div_lines(mech.read_text(encoding="utf-8")) if mech.exists() else []
    name, body = _section(lines, STRUCT_SEC)
    if name is None:
        # 整节没有只警告；这一节由 assets/mechanism.md 模板带进片子，写了却留空不填 = 下面判失败。
        out["warns"].append("mechanism.md 没有「讲法」一节（脚本结构的发散：候选 0 = 本题默认讲法 + 2–3 个不同类的讲法）。"
                            "见 references/divergence.md")
        out["rows"].append("  --  讲法      没有这一节（只警告）")
    else:
        errs, summ, _ = _judge(_candidates(body), body, "讲法", need_default=False)
        out["errors"] += errs
        out["rows"].append(f"  {'OK ' if not errs else 'BAD'} 讲法      「{name}」 {summ}")
    return out


def div_only(film):
    """film.json 只声明了 divergence（没声明 shotlist）：只查发散留痕，不要求 narration.json / shotlist。"""
    div = divergence(film)
    print(f"影片 {film}  只声明了 divergence：只查发散留痕（shotlist 对账没声明，不跑）")
    print("\n发散留痕（讲法 / 视觉方向 / 近作对照，见 references/divergence.md）:\n" + "\n".join(div["rows"]))
    for w in div["warns"]:
        print(f"[警告] {w}", file=sys.stderr)
    for e in div["errors"]:
        print(f"[失败] {e}", file=sys.stderr)
    print(f"\n结果：{len(div['errors'])} 个失败，{len(div['warns'])} 个警告", file=sys.stderr)
    sys.exit(1 if div["errors"] else 0)


def main():
    ap = core.parser(__doc__)
    ap.add_argument("--plan", action="store_true",
                    help="（给 film-critique check.mjs 用）只输出 JSON：每条断言解析后的区间、来源、像素规格")
    ap.add_argument("--verdict", metavar="SAMPLES.json",
                    help="（给 film-critique check.mjs 用）读场景实测采样，用本脚本同一份语义判定，输出 JSON")
    ap.add_argument("--write", action="store_true", help="把解析后的时间表写回 shotlist.md 的 timeline 标记之间")
    ap.add_argument("--floor", type=float, default=None,
                    help="weight>=2 的叙事区间最少拿到的秒数。不给就读 shotlist json 顶层的 \"floor\"（本片声明），再没有才用 1.0")
    ap.add_argument("--divergence", action="store_true",
                    help="（给 siblings.mjs 用）只查发散留痕，输出 JSON（不需要 narration.json / shotlist）")
    args = ap.parse_args()

    film = core.resolve_film(args.film, args.films_dir)
    if args.divergence:
        print(json.dumps(divergence(film), ensure_ascii=False))
        sys.exit(0)
    want_div = bool(core.check_param(film, "divergence"))
    if want_div and not core.check_param(film, "shotlist") and not (args.plan or args.verdict or args.write):
        div_only(film)
    nar_p, sl_p = film / "narration.json", film / "docs" / "shotlist.md"
    if not nar_p.exists():
        die(f"{nar_p} 不存在 —— 音频先行：先跑 film-narration 出实测时间轴，再排分镜")
    if not sl_p.exists():
        die(f"{sl_p} 不存在")
    nar = json.loads(nar_p.read_text(encoding="utf-8"))
    md = sl_p.read_text(encoding="utf-8")
    m = re.search(r"```json\s*\n(.*?)\n```", md, re.S)
    if not m:
        die("shotlist.md 里没有 ```json 代码块（机器可读的分镜 spec）")
    try:
        spec = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        die(f"shotlist.md 的 json 块解析失败: {e}")

    errors, warns = [], []
    pads = spec.get("pads", {})
    for k, v in pads.items():
        if not isinstance(v, (int, float)):
            errors.append(f"pad {k} 必须是数字")
    # 片头/片尾留白的唯一真相源是 film.json（narrationOffset / narrationTail），
    # film-narration 的 narration.js、mux.sh、sfx.mjs、subs.py、align.py --verify 和 film-critique check.mjs 读的都是它。
    # shotlist 里的旧字段（vo_offset 引用的 pad、pads.tail）只做交叉检查：不一致就报错，绝不各用各的
    # ——F-021：shotlist 写了 lead=0.6 而下游没人接，画面整体比声音晚 0.6s，以前没有任何一道门喊。
    cfg = core.film_json(film)
    off = float(cfg.get("narrationOffset") or 0)
    tail = cfg.get("narrationTail")
    notes = []
    vo = spec.get("vo_offset")
    if vo is not None:
        if isinstance(vo, (int, float)):
            errors.append(f"vo_offset 写成了数字 {vo}：片头留白只在 film.json 的 narrationOffset 里写（删掉 vo_offset）")
        elif vo not in pads:
            errors.append(f"vo_offset 引用了未声明的 pad: {vo}")
        elif abs(float(pads[vo]) - off) > 1e-6:
            errors.append(f"shotlist 的 vo_offset={vo}（{float(pads[vo]):g}s）与 film.json narrationOffset={off:g}s 不一致："
                          f"成片里旁白从 narrationOffset 开始（narration.js / mux.sh 都只读它），按 shotlist 排的时刻会整体错位 "
                          f"{float(pads[vo]) - off:+.3f}s。改 film.json 的 narrationOffset，并删掉 vo_offset")
        else:
            notes.append("vo_offset 已由 film.json narrationOffset 取代（两者一致），可以删掉")
    if "tail" in pads and isinstance(pads["tail"], (int, float)):
        if tail is None:
            tail = float(pads["tail"])
            notes.append(f"片尾留白取自 shotlist pads.tail={tail:g}s；它的真相源应是 film.json narrationTail"
                         f"（场景用 vo.filmDuration 读同一个值），迁过去后删掉 pads.tail")
        elif abs(float(pads["tail"]) - float(tail)) > 1e-6:
            errors.append(f"shotlist pads.tail={pads['tail']:g}s 与 film.json narrationTail={float(tail):g}s 不一致："
                          f"锚点 end 和场景的 DURATION 会差 {float(pads['tail']) - float(tail):+.3f}s。以 film.json 为准，删掉 pads.tail")
    tl = Timeline(nar, pads, off, tail)

    # ---------- 1+2. 镜头：锚点解析、覆盖、重叠 ----------
    shots = []
    for s in spec.get("shots", []):
        try:
            a, b = tl.resolve(s["from"]), tl.resolve(s["to"])
        except (ValueError, KeyError) as e:
            errors.append(f"镜头 {s.get('id', '?')}: {e}")
            continue
        if b <= a:
            errors.append(f"镜头 {s['id']}: 结束 {b:.3f} 不晚于开始 {a:.3f}")
        shots.append((a, b, s))
    shots.sort(key=lambda x: x[0])
    def _overlap_limit(raw, label):
        if raw is None:
            return 0.0
        if isinstance(raw, str):
            v = tl._pad(raw)
        elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
            v = float(raw)
        else:
            raise ValueError(f"{label} 的 overlap 必须是非负秒数或 pads 里的名字，写的是 {raw!r}")
        if v < 0:
            raise ValueError(f"{label} 的 overlap 不能为负（{v}）")
        return v

    default_ov = 0.0
    if "overlap" in spec:
        try:
            default_ov = _overlap_limit(spec.get("overlap"), "shotlist 顶层")
        except ValueError as e:
            errors.append(str(e))

    for (a0, b0, s0), (a1, b1, s1) in zip(shots, shots[1:]):
        max_ov = default_ov
        if "overlap" in s1:
            try:
                max_ov = _overlap_limit(s1.get("overlap"), f"镜头 {s1.get('id', '?')}")
            except ValueError as e:
                errors.append(str(e))
        if a1 < b0 - max_ov - 1e-3:
            if max_ov > 0:
                errors.append(f"镜头 {s0['id']} 与 {s1['id']} 重叠 {b0 - a1:.3f}s（超过声明的 overlap {max_ov:g}s）")
            else:
                errors.append(f"镜头 {s0['id']} 与 {s1['id']} 重叠 {b0 - a1:.3f}s")
        elif a1 > b0 + 1e-3:
            warns.append(f"镜头 {s0['id']} → {s1['id']} 之间空 {a1 - b0:.3f}s 没人负责（有意留白就补一个镜头写明）")
    for lid in tl.lines:
        ls, le = tl.line_span(lid)
        if not any(a <= ls + 1e-3 and b >= le - 1e-3 for a, b, _ in shots) and \
                not (shots and shots[0][0] <= ls and shots[-1][1] >= le):
            errors.append(f"旁白 {lid}（{ls:.2f}–{le:.2f}）没有被镜头覆盖")

    def vo_in(a, b):
        out = []
        for lid in tl.lines:
            ls, le = tl.line_span(lid)
            if min(b, le) - max(a, ls) > 0.05:
                out.append(lid)
        return ",".join(out) or "—"

    # 可选 role（镜头在叙事里干什么：交代 / 证据 / 录屏……，词表由片子自己定）。
    # 一个镜头都没写 role 时，表格和全部输出与加这个字段之前逐字相同；写了才多一列 + 一段占比统计。只报信息，不判失败。
    has_role = any("role" in s for _, _, s in shots)

    def role_list(s):
        r = s.get("role")
        if r is None or r == "":
            return []
        if isinstance(r, str):
            return [r.strip()]
        if isinstance(r, list) and all(isinstance(x, str) for x in r):
            return [x.strip() for x in r if x.strip()]
        warns.append(f"镜头 {s.get('id', '?')} 的 role 应是字符串或字符串数组，写的是 {r!r}（不计入功能统计）")
        return []

    roles = [role_list(s) for _, _, s in shots] if has_role else [[] for _ in shots]
    rows = ["| 镜头 | 起 | 止 | 时长 | 覆盖旁白 | 画面在做什么 | 机制状态 | 交棒 |" + (" 功能 |" if has_role else ""),
            "|---|---|---|---|---|---|---|---|" + ("---|" if has_role else "")]
    role_rows = []
    for (a, b, s), rl in zip(shots, roles):
        rows.append(f"| {s['id']} | {a:.2f} | {b:.2f} | {b - a:.2f} | {vo_in(a, b)} | "
                    f"{s.get('does', '')} | {s.get('mech', '')} | {s.get('handoff', '')} |"
                    + (f" {' / '.join(rl)} |" if has_role else ""))
    if has_role:
        total = sum(b - a for a, b, _ in shots) or 1.0
        acc, untagged, multi = {}, [], False
        for (a, b, s), rl in zip(shots, roles):
            multi = multi or len(rl) > 1
            if not rl:
                untagged.append(s.get("id", "?"))
            for r in dict.fromkeys(rl):
                n, secs = acc.get(r, (0, 0.0))
                acc[r] = (n + 1, secs + (b - a))
        for r, (n, secs) in sorted(acc.items(), key=lambda kv: -kv[1][1]):
            role_rows.append(f"  {r:<10} {n:>2} 镜  {secs:7.2f}s  {secs / total:5.0%}")
        if untagged:
            role_rows.append(f"  （未标）    {len(untagged):>2} 镜：{', '.join(untagged)}")
        if multi:
            role_rows.append("  一个镜头标了多个功能时各算一次，占比之和会超过 100%")

    # ---------- 曲线 ----------
    curves = Curves(spec.get("curves", {}), tl)
    for name in spec.get("curves", {}):
        if curves.source(name) != "curve" and not curves.has_keys(name):
            continue  # 场景实测的量可以不写意图曲线
        try:
            curves._keys(name)
        except (ValueError, KeyError) as e:
            errors.append(f"曲线 {name}: {e}")
    t_end = shots[-1][1] if shots else tl.vo_end + tl.off
    dt = 0.001
    N = int(t_end / dt) + 1

    # ---------- 3. 叙事权重 vs 物理时长 ----------
    seg_rows = []
    for g in spec.get("segments", []):
        try:
            lo, hi = sorted(g["range"])
            secs = sum(dt for i in range(N) if lo <= curves.at(g["curve"], i * dt) <= hi)
        except (ValueError, KeyError) as e:
            errors.append(f"区间 {g.get('label', '?')}: {e}")
            continue
        w = g.get("weight", 1)
        # 下限的来源顺序：本区间的 min → 命令行 --floor → 本片 shotlist 顶层 "floor" → 1.0。
        # 片子的下限曾只写在 style_guide 的正文里（"叙事区间下限：1.2 秒"），机器读不到，
        # accept.mjs 只能按默认 1.0 跑——本片定的法律在验收时从没生效过。所以要写进 json。
        film_floor = args.floor if args.floor is not None else spec.get("floor", 1.0)
        floor = g.get("min", film_floor) if w >= 2 else 0
        ok = secs + 1e-9 >= floor
        seg_rows.append(f"  {'OK ' if ok else 'BAD'} {g['label']:<10} {g['curve']} ∈ [{lo:g},{hi:g}]  "
                        f"屏幕时长 {secs:.3f}s  权重 {w}  下限 {floor:g}s")
        if not ok:
            errors.append(f"叙事区间「{g['label']}」权重 {w} 只拿到 {secs:.3f}s（下限 {floor:g}s）"
                          f"—— 自变量按物理单位线性映射到秒了，给它单独的旁白锚点区间")

    # ---------- 4. 音画矛盾 ----------
    # 曲线来源决定这里验的是什么：
    #   curve（默认）  场景读的就是这些钉点 → 这里验的就是画面
    #   scene / pixels 画面上的量是仿真/迭代/库推出来的 → 这里只验"意图"自洽（有 keys 时），
    #                  画面实测交给 film-critique check.mjs（--plan / --verdict 两个接口）
    for name, cv in spec.get("curves", {}).items():
        src = (cv or {}).get("source", "curve")
        if src not in ("curve", "scene", "pixels", "anchor"):
            errors.append(f"曲线 {name}: source 只能是 curve / scene / pixels / anchor，写的是 {src!r}")
        if src == "curve" and not (cv or {}).get("keys"):
            errors.append(f"曲线 {name}: 没有 keys —— 钉不了的量（仿真/迭代推出的）标 source: scene、pixels 或 anchor")
        if src == "pixels":
            errors.extend(check_pixels_spec(name, cv.get("pixels")))
        if src == "anchor":
            errors.extend(check_anchor_spec(name, cv.get("anchor")))
    claim_rows, plan, deferred = [], [], []
    for i, c in enumerate(spec.get("claims", [])):
        try:
            if "span" in c:
                sa, sb = tl.named_span(c["span"]) if isinstance(c["span"], str) else (tl.resolve(c["span"][0]), tl.resolve(c["span"][1]))
            else:
                sa, sb = tl.line_span(c["line"])
            if c.get("op") not in (*OPS, "rising", "falling", "steady"):
                raise ValueError(f"未知 op {c.get('op')}")
            if c.get("curve") not in spec.get("curves", {}):
                raise KeyError(f"曲线 {c.get('curve')} 没有在 curves 里声明（场景实测的量也要声明一条，标 source）")
        except (ValueError, KeyError) as e:
            errors.append(f"断言 {c.get('says', '?')}: {e}")
            continue
        src = curves.source(c["curve"])
        plan.append({"idx": i, "says": c["says"], "curve": c["curve"], "op": c["op"], "value": c.get("value"),
                     "tol": c.get("tol"), "span": [sa, sb], "source": src,
                     "pixels": spec["curves"][c["curve"]].get("pixels") if src == "pixels" else None})
        if src == "anchor":  # 只在用到时加这个键：没用 anchor 的片子 --plan 输出不变
            plan[-1]["anchor"] = spec["curves"][c["curve"]].get("anchor")
        if src != "curve":
            deferred.append(c)
            if not curves.has_keys(c["curve"]):
                claim_rows.append(f"  --  「{c['says']}」 [{sa:.2f}–{sb:.2f}] {c['curve']} {c['op']} {c.get('value', '')}"
                                  f"  → 无意图曲线，待场景实测（source: {src}）")
                continue
        try:
            ts = [sa + k * dt for k in range(int((sb - sa) / dt) + 1)]
            vals = [curves.at(c["curve"], t) for t in ts]
        except (ValueError, KeyError) as e:
            errors.append(f"断言 {c.get('says', '?')}: {e}")
            continue
        bad, warn, _, summ = eval_claim(c, ts, vals)
        tag = "" if src == "curve" else "[意图] "
        claim_rows.append(f"  {'OK ' if not bad else 'BAD'} {tag}「{c['says']}」 [{sa:.2f}–{sb:.2f}] "
                          f"{c['curve']} {c['op']} {c.get('value', '')}  → {bad or summ}")
        if bad:
            errors.append(f"音画矛盾{'（意图曲线）' if tag else ''}「{c['says']}」：{bad}")
        if warn:
            warns.append(f"断言「{c['says']}」{'（意图曲线）' if tag else ''}：{warn}")

    uses_end = re.search(r'"end(?:[+\-][^"]*)?"', m.group(1)) is not None
    try:
        end_anchor = tl.resolve("end") if uses_end else None
    except ValueError:
        end_anchor = None
    if args.plan:
        print(json.dumps({"film": str(film), "vo_offset": tl.off, "film_end": t_end, "end_anchor": end_anchor, "claims": plan,
                          "errors": errors}, ensure_ascii=False))
        sys.exit(0)
    if args.verdict:
        try:
            samples = json.loads(Path(args.verdict).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            die(f"--verdict {args.verdict} 读不了: {e}")
        by_idx = {p["idx"]: p for p in plan}
        out = []
        for s in samples.get("claims", []):
            p = by_idx.get(s["idx"])
            if p is None:
                die(f"--verdict 里的断言 idx={s['idx']} 在 shotlist 里不存在（shotlist 在采样后被改过？）")
            bad, warn, bad_t, summ = eval_claim(p, s["ts"], s["vals"])
            out.append({"idx": p["idx"], "says": p["says"], "curve": p["curve"], "op": p["op"],
                        "value": p["value"], "span": p["span"], "via": s.get("via", p["source"]),
                        "n": len(s["ts"]), "bad": bad, "bad_t": bad_t, "warn": warn, "summary": summ})
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)

    # ---------- 关键帧（静帧闸门用） ----------
    kf_rows = []
    for k in spec.get("keyframes", []):
        try:
            t = tl.resolve(k["at"])
            kf_rows.append(f"  {t:7.3f}s  {k['at']:<16} 要读出：{k.get('read', '')}")
        except (ValueError, KeyError) as e:
            errors.append(f"关键帧 {k.get('at')}: {e}")
    if spec.get("shots") and not spec.get("keyframes"):
        warns.append("没有 keyframes —— 静帧闸门不知道该截哪几帧")

    # ---------- 正文里疑似手填秒数 ----------
    body = md.replace(m.group(0), "")
    body = re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), "", body, flags=re.S)
    for i, line in enumerate(body.splitlines(), 1):
        if re.search(r"\d+(\.\d+)?\s*[–~-]\s*\d+(\.\d+)?\s*(s|秒)?\s*\|", line) or \
                re.search(r"(?<![\w.])\d+\.\d+\s*(s|秒)(?!\w)", line):
            warns.append(f"shotlist.md 正文第 {i} 行疑似手写秒数：{line.strip()[:60]}（时刻请只放 json 锚点里）")

    # ---------- 5. 发散留痕（在 --plan / --verdict 之后：那两个接口的输出不变） ----------
    # 这是解说片配方的流程留痕，不是技术约束（film-core references/kernel.md）：只在本片 film.json checks 声明了
    # divergence 时才查。--divergence（siblings.mjs 用的解析接口）不受这个开关影响：它只报"写了什么"，不判对错。
    if want_div:
        div = divergence(film)
        errors.extend(div["errors"])
        warns.extend(div["warns"])
    else:
        div = {"rows": ["  –   本片 film.json checks 没有声明 divergence：不查讲法 / 视觉方向 / 近作对照的留痕（要查就加上 \"divergence\"）"]}

    # ---------- 输出 ----------
    print(f"影片 {film}  旁白实测 {tl.vo_end:.3f}s  偏移 {tl.off:.3f}s  成片 {t_end:.3f}s")
    print("\n".join(rows))
    if role_rows:
        print("\n镜头功能（按屏幕时长，只是信息，不判对错）:\n" + "\n".join(role_rows))
    if seg_rows:
        print("\n叙事区间（权重 vs 屏幕时长）:\n" + "\n".join(seg_rows))
    if claim_rows:
        print("\n旁白断言（在实测区间上逐毫秒求值）:\n" + "\n".join(claim_rows))
    if kf_rows:
        print("\n静帧闸门关键帧:\n" + "\n".join(kf_rows))
    print("\n发散留痕（讲法 / 视觉方向 / 近作对照，见 references/divergence.md）:\n" + "\n".join(div["rows"]))
    if deferred:
        names = sorted({c["curve"] for c in deferred})
        anc = any(curves.source(c["curve"]) == "anchor" for c in deferred)  # 没用 anchor 的片子输出与原来逐字相同
        print(f"\n{len(deferred)} 条断言的变量不是钉点插出来的（{'、'.join(names)}：source scene/pixels{'/anchor' if anc else ''}）。"
              f"上面只验了它们的意图；画面上是否为真，要在实现后跑 film-critique 的 check.mjs"
              f"（逐帧取 window.probe(t) / 数像素{' / 取 window.anchors(t)' if anc else ''}）。分镜阶段的绿灯不覆盖这几条。")
    for n in notes:
        print(f"[注] {n}")
    for w in warns:
        print(f"[警告] {w}", file=sys.stderr)
    for e in errors:
        print(f"[失败] {e}", file=sys.stderr)

    if args.write and not errors:
        table = "\n".join(["", "<!-- 以下由 check_shotlist.py --write 生成，勿手改；改 json 锚点后重跑 -->", *rows, ""])
        if BEGIN in md and END in md:
            md2 = re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), BEGIN + table + END, md, flags=re.S)
        else:
            md2 = md + f"\n{BEGIN}{table}{END}\n"
        sl_p.write_text(md2, encoding="utf-8")
        print(f"\n已写回 {sl_p}")
    print(f"\n结果：{len(errors)} 个失败，{len(warns)} 个警告", file=sys.stderr)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
