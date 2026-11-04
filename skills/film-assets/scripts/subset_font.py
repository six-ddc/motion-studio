#!/usr/bin/env python3
"""字体子集化：把 10MB+ 的中文字体砍到只含本片用到的字。

用法（从任意 cwd；films/ 按 --films-dir > $FILMS_DIR > 从 cwd 往上找）：
  .venv/bin/python <film-assets>/scripts/subset_font.py --film <slug> \
      --font assets/fonts/src/XXX.ttf [--font-number 0] \
      [--text "额外的字"] [--text-file docs/onscreen.txt ...] \
      [--name xxx] [--format woff2|ttf|otf] [--allow-missing <类>]

  # 缺字放行只作用于声明的那一类字符（可重复；见下）：
  #   中文片里只拿来排数字的拉丁字体：--allow-missing cjk
  #   只对某一款字体生效（同一条命令被循环套在多款字体上时）：--allow-missing "Inter Variable=cjk"
  #   类：cjk（汉字+假名+注音+CJK 标点+全角形）/ han（只汉字）/ latin / digits / ascii /
  #       U+2190-21FF（码位区间）/ chars:→∈✓（字面字符，写在一项的最后）；逗号分隔可组合
  #   裸 --allow-missing（不带类）= 旧语义：放行全部缺字，会打警告——它同时放过了本该有的字

  # 文案改了以后检查子集还够不够（不重做，只查）：
  .venv/bin/python <film-assets>/scripts/subset_font.py --film <slug> --check assets/fonts/xxx.subset.woff2

  # 分片包（一组 woff2 + 一份 @font-face CSS，如 fontsource 的中文包）：
  .venv/bin/python <film-assets>/scripts/subset_font.py --film <slug> \
      --pack @fontsource-variable/noto-sans-sc        # npm 包名 / CSS 文件 / 含 index.css 的目录
      [--family "Noto Sans SC Variable"]              # 包里有多个族时必填
      [--rename "Film Sans"] [--name noto-sans-sc]    # 产出族名 / 文件名前缀
      [--copy-chunks]                                 # 原样拷分片，不再子集化
      [--license path/to/OFL.txt]                     # 包里找不到许可文件时必填
  # -> assets/fonts/<name>/*.woff2 + 许可文件、assets/fonts/<name>.subset.css、<name>.subset.json
  .venv/bin/python <film-assets>/scripts/subset_font.py --film <slug> --check assets/fonts/<name>.subset.css

默认收字来源（都存在才读）：
  script.json / narration.json 里的所有字符串、content.json 的画面文字（基础槽位 + claims + 全部变体覆盖的并集）、
  scene.html 的全部非 ASCII 字符、
  assets/text/*.txt、--text、--text-file。另外总是加上可打印 ASCII 和常用中文标点。

产出：
  assets/fonts/<name>.subset.<format>   子集字体
  assets/fonts/<name>.subset.json       台账：源字体 sha256、字符集、来源、日期

失败（缺源字体、源字体缺字、--check 发现缺字）时 exit 非 0，并在 stderr 说明。
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import die as core_die, parser, resolve_film  # noqa: E402

try:
    from fontTools import subset as ft_subset
    from fontTools.ttLib import TTFont
except ImportError:  # 缺依赖要报清楚，不要静默
    sys.stderr.write("✗ 缺 fontTools。装：.venv/bin/python -m pip install fonttools brotli\n")
    sys.exit(2)

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
CJK_PUNCT = "，。、；：？！“”‘’（）《》〈〉【】「」『』—…·～　"


def die(msg: str, code: int = 2) -> None:
    core_die(msg, code)


def strings_in(obj) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in strings_in(v)]
    if isinstance(obj, list):
        return [s for v in obj for s in strings_in(v)]
    return []


def content_texts(doc) -> list[str]:
    """content.json（film-core references/content-json.md）里会画到画面上的文字：基础 text 槽位、claims，
    以及 variants 下每个维度 × 每个选项的 text 覆盖——取并集，不按某一个组合合并，免得只有变体才有的字漏子集化。
    note / brand / assets / params 不收（不是画面文字）。"""
    out: list[str] = []

    def slots(text) -> None:
        if not isinstance(text, dict):
            return
        for v in text.values():
            if isinstance(v, str):
                out.append(v)
            elif isinstance(v, dict) and isinstance(v.get("text"), str):
                out.append(v["text"])

    if not isinstance(doc, dict):
        return out
    slots(doc.get("text"))
    for c in doc.get("claims") or []:
        if isinstance(c, dict) and isinstance(c.get("text"), str):
            out.append(c["text"])
    for opts in (doc.get("variants") or {}).values():
        for ov in (opts or {}).values() if isinstance(opts, dict) else []:
            if isinstance(ov, dict):
                slots(ov.get("text"))
    return out


def collect(film: Path, extra_text: list[str], extra_files: list[str]) -> tuple[set[str], list[str]]:
    chars: set[str] = set(ASCII) | set(CJK_PUNCT)
    sources: list[str] = ["<ascii+cjk-punct>"]
    for rel in ("script.json", "narration.json", "docs/script.json"):
        p = film / rel
        if p.is_file():
            try:
                data = json.loads(p.read_text("utf-8"))
            except json.JSONDecodeError as e:
                die(f"{p} 不是合法 JSON：{e}")
            chars |= set("".join(strings_in(data)))
            sources.append(rel)
    cp = film / "content.json"
    if cp.is_file():
        try:
            doc = json.loads(cp.read_text("utf-8"))
        except json.JSONDecodeError as e:
            die(f"{cp} 不是合法 JSON：{e}")
        texts = content_texts(doc)
        chars |= set("".join(texts))
        sources.append(f"content.json(基础+全部变体 {len(texts)} 段)")
    scene = film / "scene.html"
    if scene.is_file():
        chars |= {c for c in scene.read_text("utf-8") if ord(c) > 0x7F}
        sources.append("scene.html(non-ascii)")
    for p in sorted((film / "assets" / "text").glob("*.txt")):
        chars |= set(p.read_text("utf-8"))
        sources.append(str(p.relative_to(film)))
    for f in extra_files:
        p = (film / f) if not Path(f).is_absolute() else Path(f)
        if not p.is_file():
            die(f"--text-file 不存在：{p}")
        chars |= set(p.read_text("utf-8"))
        sources.append(str(f))
    for t in extra_text:
        chars |= set(t)
        sources.append(f"--text({len(t)} chars)")
    chars -= {"\n", "\r", "\t", "﻿"}
    return chars, sources


def load_font(path: Path, number: int) -> TTFont:
    try:
        return TTFont(str(path), fontNumber=number, lazy=False)
    except Exception as e:  # TTC 不给 fontNumber 等
        die(f"打不开字体 {path}（TTC 要 --font-number）：{e}")
        raise


def fmt_size(n: int) -> str:
    return f"{n/1048576:.2f} MB" if n > 1048576 else f"{n/1024:.1f} KB"


# ─────────────────────────────────────────────────────────────────────────────
# 缺字放行的作用域。收字来源是整支片子的文案，所以一款只负责一部分字的字体
# （中文片里只排数字的拉丁字体）必然"缺"另一部分。原来的 --allow-missing 是全开关：
# 为了放过那一大片汉字，连这款字体本该有的字（比如数字）缺了也一起放过——缺字保护整个关掉。
# 现在放行要写明放的是哪一类字符（可选再限定哪一款字体），类外的缺字照旧 exit 1。
# 类的定义是码位区间，不是审美：哪款字体排哪些字由调用方定，这里只让声明可执行。
# ─────────────────────────────────────────────────────────────────────────────
HAN = [(0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2FA1F), (0x30000, 0x3134F)]
ALLOW_CLASSES: dict[str, tuple[str, list[tuple[int, int]]]] = {
    "digits": ("0-9", [(0x30, 0x39)]),
    "ascii": ("U+20-7E", [(0x20, 0x7E)]),
    "latin": ("A-Z a-z + Latin-1/扩展 A/B/附加字母", [(0x41, 0x5A), (0x61, 0x7A), (0xC0, 0xD6), (0xD8, 0xF6),
                                                    (0xF8, 0x24F), (0x1E00, 0x1EFF)]),
    "han": ("汉字（基本区 + 扩展 A–H + 兼容区）", HAN),
    "cjk": ("汉字 + CJK 标点(U+3000-303F) + 假名 + 注音 + 全角/半角形(U+FF00-FFEF)",
            HAN + [(0x3000, 0x303F), (0x3040, 0x30FF), (0x3100, 0x312F), (0x31A0, 0x31BF), (0xFF00, 0xFFEF)]),
}
ALLOW_HELP = ("缺字放行的作用域，可重复：cjk / han / latin / digits / ascii / U+XXXX-YYYY / chars:字面；"
              "逗号组合；前缀 '族名=' 只对那一款字体生效。裸写（不带类）放行全部缺字并告警")


def parse_allow(values: list[str] | None) -> list[dict]:
    """--allow-missing 的每个值 → [{raw, family, all, spans, chars, label}]。写错的类名直接报错——
    拼错一个类名若被当成"什么都不放行"还好，若被当成字面字符就会悄悄放过几个字。"""
    out = []
    for raw in values or []:
        family, rest = None, raw.strip()
        if "=" in rest and not rest.lower().startswith(("chars:", "u+")):
            family, rest = (s.strip() for s in rest.split("=", 1))
            if not family:
                die(f"--allow-missing {raw!r}：'=' 前的族名是空的")
        item = {"raw": raw, "family": family, "all": False, "spans": [], "chars": set(), "labels": []}
        while rest:
            if rest.lower().startswith("chars:"):
                lit = {c for c in rest[6:] if not c.isspace()}
                if not lit:
                    die(f"--allow-missing {raw!r}：chars: 后面没有字")
                item["chars"] |= lit
                item["labels"].append("chars:" + "".join(sorted(lit)))
                break
            tok, _, rest = rest.partition(",")
            tok, rest = tok.strip(), rest.strip()
            low = tok.lower()
            if not tok:
                continue
            if low in ("*", "all"):
                item["all"] = True
                item["labels"].append("*")
            elif low in ALLOW_CLASSES:
                item["spans"] += ALLOW_CLASSES[low][1]
                item["labels"].append(low)
            elif low.startswith("u+"):
                try:
                    item["spans"] += parse_unicode_range(tok)
                except ValueError:
                    die(f"--allow-missing {raw!r}：码位区间 {tok!r} 写错了（例：U+2190-21FF）")
                item["labels"].append(tok.upper())
            else:
                die(f"--allow-missing {raw!r}：不认识的类 {tok!r}。可用：{' / '.join(ALLOW_CLASSES)} / "
                    f"U+XXXX-YYYY / chars:字面（字面字符要写 chars: 前缀，免得拼错的类名被当成几个字放行）")
        if not item["labels"]:
            die(f"--allow-missing {raw!r} 是空的")
        out.append(item)
    return out


def _family_match(item: dict, families: list[str]) -> bool:
    return item["family"] is None or any(item["family"].lower() == (f or "").lower() for f in families)


def apply_allow(missing: list[str], allow: list[dict], families: list[str], what: str):
    """把缺字分成 (放行的 {标签: 字}, 照旧致命的 [字])，并把"作用域外"的情况讲清楚。
    families：这款字体的族名（name 表 / CSS font-family / 台账 family），用于 '族名=' 限定。"""
    live = [it for it in allow if _family_match(it, families)]
    skipped = [it for it in allow if it not in live]
    if skipped:
        print(f"  · {len(skipped)} 条 --allow-missing 限定了别的字体，对 {what}（{' / '.join(f for f in families if f)}）"
              f"不生效：{', '.join(it['raw'] for it in skipped)}", file=sys.stderr)
    allowed: dict[str, list[str]] = {}
    fatal: list[str] = []
    for c in missing:
        cp = ord(c)
        hit = next((it for it in live if it["all"] or c in it["chars"] or _in_spans(cp, it["spans"])), None)
        if hit is None:
            fatal.append(c)
        else:
            allowed.setdefault(",".join(hit["labels"]), []).append(c)
    if any(it["all"] for it in live) and missing:
        print(f"  ⚠ 裸 --allow-missing（或 *）关掉了 {what} 的全部缺字保护：缺的 {len(missing)} 个字全部放行，"
              f"其中本该由这款字体排的字缺了也不会报。只想放过一类时写 --allow-missing cjk / latin / chars:… 等",
              file=sys.stderr)
    return allowed, fatal


def missing_report(what: str, fatal: list[str], allowed: dict[str, list[str]], hint: str) -> str:
    msg = f"{what} 缺 {len(fatal)} 个字（不在任何 --allow-missing 声明的范围内）：{''.join(fatal)}"
    if allowed:
        msg += f"\n  已按声明放行 {sum(map(len, allowed.values()))} 个：" + "；".join(
            f"[{k}] {len(v)} 个" for k, v in allowed.items())
    return msg + "\n  " + hint


def covered_phrase(n: int, allowed: dict[str, list[str]]) -> str:
    """没有放行时措辞与旧版逐字相同；有放行时不说"全部"——放行的那些字它并不覆盖。"""
    k = sum(map(len, allowed.values()))
    if not k:
        return f"全部 {n} 个字符"
    return f" {n} 个字符中除按声明放行的 {k} 个（" + "；".join(f"[{a}] {len(v)}" for a, v in allowed.items()) + f"）外的全部 {n - k} 个"


ALLOW_HINT = ("换字体、改文案；或确认这些字本来就不归这款字体排之后，用 --allow-missing <类> 只放行那一类"
              "（cjk / han / latin / digits / ascii / U+XXXX-YYYY / chars:字面）")


def allow_manifest(allow: list[dict], allowed: dict[str, list[str]]) -> dict:
    """台账里记下放行声明与实际放行的字——--check 照同一份声明查。没用放行时不加键（旧台账形状不变）。"""
    if not allow:
        return {}
    return {"allowMissing": [it["raw"] if it["raw"] else "*" for it in allow],
            "missingAllowed": {k: "".join(v) for k, v in allowed.items()}}


def manifest_allow(manifest_path: Path, cli_allow: list[str] | None) -> list[dict]:
    """--check 用的放行声明 = 台账里建子集时记下的 + 命令行这次给的。旧台账没有这个键 → 只有命令行的。"""
    recorded = []
    if manifest_path.is_file():
        try:
            recorded = json.loads(manifest_path.read_text("utf-8")).get("allowMissing") or []
        except (json.JSONDecodeError, AttributeError):
            recorded = []
    if recorded:
        print(f"  · 沿用台账 {manifest_path.name} 里的放行声明：{', '.join(recorded)}")
    return parse_allow([*recorded, *(cli_allow or [])])


def check(film: Path, subset_path: str, extra_text, extra_files, cli_allow=None) -> None:
    p = film / subset_path if not Path(subset_path).is_absolute() else Path(subset_path)
    if not p.is_file():
        die(f"子集字体不存在：{p}")
    chars, sources = collect(film, extra_text, extra_files)
    font = TTFont(str(p))
    cmap = font.getBestCmap()
    missing = sorted(c for c in chars if ord(c) not in cmap and not c.isspace())
    allow = manifest_allow(p.with_suffix(".json"), cli_allow)
    allowed: dict = {}
    if missing and allow:
        fams = [font["name"].getDebugName(1), font["name"].getDebugName(16)]
        allowed, missing = apply_allow(missing, allow, fams, p.name)
    if missing:
        if allowed:
            die(missing_report(p.name, missing, allowed, "文案改过了？重跑子集化；" + ALLOW_HINT), 1)
        die(f"{p.name} 缺 {len(missing)} 个字（文案改过了？重跑子集化）：{''.join(missing)}", 1)
    print(f"✓ {p.name} 覆盖当前文案{covered_phrase(len(chars), allowed)}（来源：{', '.join(sources)}）")


# ─────────────────────────────────────────────────────────────────────────────
# 分片包：一组 woff2 + 一份 @font-face CSS（每片一个 unicode-range）。
# fontsource 的中文包、Google Fonts CSS API 下载下来的东西、film-typography 拷进片子的 fonts.css
# 都是这个形态。单文件接口吃不下它，使用者只能自己写挑片工具（见仓库 docs/verified/film-assets.md）。
# ─────────────────────────────────────────────────────────────────────────────
FONT_EXT = (".woff2", ".woff", ".ttf", ".otf")
LICENSE_RE = re.compile(r"^(licen[cs]e|ofl|copying)([-_.][\w.-]*)?$", re.I)


def _strip_css_comments(s: str) -> str:
    return re.sub(r"/\*.*?\*/", "", s, flags=re.S)


def parse_unicode_range(text: str | None) -> list[tuple[int, int]]:
    if not text:
        return [(0, 0x10FFFF)]  # 没写 unicode-range = 覆盖全部码位
    spans = []
    for part in text.split(","):
        p = part.strip().upper().removeprefix("U+")
        if not p:
            continue
        if "?" in p:
            spans.append((int(p.replace("?", "0"), 16), int(p.replace("?", "F"), 16)))
        elif "-" in p:
            a, b = p.split("-", 1)
            spans.append((int(a, 16), int(b, 16)))
        else:
            spans.append((int(p, 16), int(p, 16)))
    return spans


def format_unicode_range(cps) -> str:
    cps = sorted(set(cps))
    out, i = [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:x}" if i == j else f"U+{cps[i]:x}-{cps[j]:x}")
        i = j + 1
    return ",".join(out)


def parse_font_faces(css_path: Path) -> list[dict]:
    css = _strip_css_comments(css_path.read_text("utf-8"))
    faces = []
    for idx, m in enumerate(re.finditer(r"@font-face\s*\{([^}]*)\}", css, re.S | re.I)):
        body = m.group(1)

        def prop(name: str) -> str | None:
            mm = re.search(rf"(?:^|;)\s*{name}\s*:\s*([^;]+)", body, re.I)
            return mm.group(1).strip() if mm else None

        src = prop("src") or ""
        urls = re.findall(r"url\(\s*['\"]?([^'\")]+?)['\"]?\s*\)", src)
        url = next((u for u in urls if u.split("?")[0].lower().endswith(".woff2")), urls[0] if urls else None)
        path = None
        if url and not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I):
            path = (css_path.parent / url.split("?")[0].split("#")[0]).resolve()
        rng = prop("unicode-range")
        faces.append({
            "index": idx,
            "family": (prop("font-family") or "").strip().strip("'\""),
            "style": prop("font-style") or "normal",
            "weight": prop("font-weight") or "normal",
            "stretch": prop("font-stretch"),
            "display": prop("font-display"),
            "url": url, "path": path, "hasLocal": "local(" in src.lower(),
            "rangeText": rng, "spans": parse_unicode_range(rng),
        })
    return faces


def _in_spans(cp: int, spans) -> bool:
    return any(a <= cp <= b for a, b in spans)


def resolve_pack(spec: str, film: Path) -> Path:
    """--pack 可以是：CSS 文件 / 含 index.css 的目录（相对片子目录、cwd 或绝对）/ npm 包名（含子路径）。"""
    def from_path(p: Path) -> Path | None:
        if p.is_file():
            return p.resolve()
        if p.is_dir():
            if (p / "index.css").is_file():
                return (p / "index.css").resolve()
            css = sorted(p.glob("*.css"))
            if len(css) == 1:
                return css[0].resolve()
            die(f"{p} 里有 {len(css)} 个 CSS，指定具体文件：{', '.join(c.name for c in css) or '（无）'}")
        return None

    for cand in ([Path(spec)] if Path(spec).is_absolute() else [film / spec, Path.cwd() / spec]):
        hit = from_path(cand)
        if hit:
            return hit
    here = Path(__file__).resolve().parent
    bases = [film, *film.parents, Path.cwd(), *Path.cwd().parents, *here.parents]
    for base in dict.fromkeys(bases):
        hit = from_path(base / "node_modules" / spec)
        if hit:
            return hit
    die(f"找不到分片包 {spec}（试过：片子目录、cwd、它们和本脚本各级上级的 node_modules）")
    raise SystemExit


def pack_info(css: Path) -> tuple[str | None, list[Path]]:
    """返回 (包名@版本, 候选许可文件)。只在 node_modules 里往上找 package.json——
    片子目录里的分片包往上走会撞到仓库根的 package.json，那不是字体的包。"""
    ident, roots = None, [css.parent]
    if "node_modules" in css.parts:
        d = css.parent
        while d.name != "node_modules" and d != d.parent:
            roots.append(d)
            if (d / "package.json").is_file():
                try:
                    pj = json.loads((d / "package.json").read_text("utf-8"))
                    ident = f"{pj.get('name')}@{pj.get('version')}"
                except json.JSONDecodeError:
                    pass
                break
            d = d.parent
    else:
        roots.append(css.parent.parent)
    lic = []
    for r in dict.fromkeys(roots):
        lic += [p for p in sorted(r.iterdir()) if p.is_file() and LICENSE_RE.match(p.name)]
    return ident, lic


def license_facts(text: str, copyright_: str | None) -> dict:
    blob = f"{text}\n{copyright_ or ''}"
    rfn = re.findall(r"with Reserved Font Names?\s*[\"'“‘]([^\"'”’]+)[\"'”’]", blob, re.I)
    kind = "SIL OFL 1.1" if re.search(r"SIL Open Font License", text, re.I) else (
        "Apache-2.0" if "Apache License" in text else "（未识别，读原文）")
    return {"license": kind, "reservedFontNames": sorted(set(rfn))}


def pack_coverage(faces: list[dict], need: set[int]) -> dict[int, set[int]]:
    """每个分片真正能画的码位 = unicode-range 声明 ∩ 字体 cmap。range 只是声明，cmap 才是事实。"""
    cover = {}
    for f in faces:
        hit = {cp for cp in need if _in_spans(cp, f["spans"])}
        if not hit:
            continue
        if not f["path"] or not f["path"].is_file():
            die(f"分片 {f['url']} 不存在（{f['path']}）")
        cmap = TTFont(str(f["path"]), lazy=True).getBestCmap()
        cover[f["index"]] = {cp for cp in hit if cp in cmap}
    return cover


def pick_family(faces: list[dict], family: str | None, css: Path) -> list[dict]:
    fams = list(dict.fromkeys(f["family"] for f in faces))
    if not faces:
        die(f"{css} 里没有 @font-face")
    if family:
        sel = [f for f in faces if f["family"].lower() == family.lower()]
        if not sel:
            die(f"{css.name} 里没有族 {family!r}。有：{' / '.join(fams)}")
        return sel
    if len(fams) > 1:
        die(f"{css.name} 里有 {len(fams)} 个族，用 --family 指定：{' / '.join(fams)}")
    return faces


def build_pack(film: Path, a, chars: set[str], sources: list[str]) -> None:
    css = resolve_pack(a.pack, film)
    faces = pick_family(parse_font_faces(css), a.family, css)
    bad = [f for f in faces if f["hasLocal"] or not f["path"]]
    if bad:
        die(f"{len(bad)} 个 @font-face 不是本地文件（local() 或外链），分片包必须是一组本地字体文件：{bad[0]['url']}")
    ident, lic_found = pack_info(css)
    lic_src = Path(a.license).resolve() if a.license else (lic_found[0] if lic_found else None)
    if a.license and not lic_src.is_file():
        die(f"--license 不存在：{lic_src}")
    if not lic_src:
        die(f"分片包旁边找不到许可文件（LICENSE / OFL.txt…，在 {css.parent} 及上级找过）。\n"
            f"  OFL 等授权要求许可文本随字体分发。找到原文后用 --license 指定", 1)

    need = {ord(c) for c in chars}
    groups: dict[tuple[str, str], list[dict]] = {}
    for f in faces:
        groups.setdefault((f["style"], f["weight"]), []).append(f)

    chosen: dict[int, set[int]] = {}
    missing: set[int] = set()
    for (style, weight), gfaces in groups.items():
        cover = pack_coverage(gfaces, need)
        remaining = set(need)
        while remaining:  # 贪心集合覆盖：每次挑能补上最多缺字的那片 → 片数接近最少
            best = max(cover, key=lambda i: len(cover[i] & remaining), default=None)
            if best is None or not cover[best] & remaining:
                break
            chosen[best] = chosen.get(best, set()) | (cover[best] & remaining)
            remaining -= cover[best]
        missing |= {cp for cp in remaining if not chr(cp).isspace()}

    miss_s = "".join(sorted(chr(c) for c in missing))
    allow = parse_allow(a.allow_missing)
    allowed: dict = {}
    if missing and not allow:
        die(f"分片包缺 {len(missing)} 个字（没有任何分片的 unicode-range+cmap 覆盖它）：{miss_s}\n"
            f"  {ALLOW_HINT}", 1)
    if missing:
        fams = [faces[0]["family"], a.rename]
        allowed, fatal = apply_allow(sorted(miss_s), allow, fams, f"分片包 {faces[0]['family']}")
        if fatal:
            die(missing_report(f"分片包 {faces[0]['family']}", fatal, allowed, ALLOW_HINT), 1)

    by_index = {f["index"]: f for f in faces}
    first = by_index[min(chosen)] if chosen else None
    src_font = TTFont(str(first["path"]), lazy=True) if first else None
    copyright_ = src_font["name"].getDebugName(0) if src_font else None
    lic_text = lic_src.read_text("utf-8", errors="replace")
    facts = license_facts(lic_text, copyright_)
    family_out = a.rename or faces[0]["family"]
    name = a.name or re.sub(r"[^\w-]+", "-", faces[0]["family"].lower()).strip("-")
    if not a.copy_chunks and not a.rename:
        hit = [r for r in facts["reservedFontNames"] if r.lower() in family_out.lower()]
        if hit:
            print(f"  ⚠ 族名 {family_out!r} 含保留字体名 {hit}：子集化算修改，公开分发时用 --rename 改名", file=sys.stderr)

    fonts_dir = film / "assets" / "fonts"
    out_dir = fonts_dir / name
    out_dir.mkdir(parents=True, exist_ok=True)
    # 上次挑的片这次可能用不上了，留着会变成没入账的孤儿文件。只删上次台账里记着的——
    # 目录里别的文件（手放的、别的工具生成的）不碰。
    prev = fonts_dir / f"{name}.subset.json"
    if prev.is_file():
        try:
            pm = json.loads(prev.read_text("utf-8"))
            for old in [*(f["file"] for f in pm.get("faces", [])), pm.get("licenseFile")]:
                if old and (film / old).is_file() and (film / old).parent == out_dir:
                    (film / old).unlink()
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
    lic_dst = out_dir / lic_src.name
    shutil.copyfile(lic_src, lic_dst)

    opts = ft_subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = [f for f in a.keep_features.split(",") if f]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    opts.desubroutinize = True

    out_faces, before, after, rules = [], 0, 0, []
    for idx in sorted(chosen):
        f, cps = by_index[idx], chosen[idx]
        src = f["path"]
        if a.copy_chunks:
            dst = out_dir / src.name
            shutil.copyfile(src, dst)
            rng = f["rangeText"] or format_unicode_range(cps)
        else:
            dst = out_dir / (src.stem + ".subset.woff2")
            font = TTFont(str(src))
            sub = ft_subset.Subsetter(options=opts)
            sub.populate(unicodes=sorted(cps))
            sub.subset(font)
            ft_subset.save_font(font, str(dst), opts)
            rng = format_unicode_range(cps)  # 精确声明：浏览器只为这些字请求这一片
        before += src.stat().st_size
        after += dst.stat().st_size
        rel = dst.relative_to(fonts_dir).as_posix()
        out_faces.append({
            "file": dst.relative_to(film).as_posix(), "url": f"./{dst.relative_to(film).as_posix()}",
            "weight": f["weight"], "style": f["style"], "unicodeRange": rng,
            "chars": "".join(sorted(chr(c) for c in cps)),
            "sourceFile": src.name, "sourceSha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        })
        decl = [f"font-family: '{family_out}'", f"font-style: {f['style']}", f"font-weight: {f['weight']}"]
        if f["stretch"]:
            decl.append(f"font-stretch: {f['stretch']}")
        # 一律 block：上游常写 swap（网页优先出字），离线渲染要的是"没加载完就别用回退字画"
        decl += ["font-display: block",f"src: url(./{rel}) format('woff2')", f"unicode-range: {rng}"]
        rules.append("@font-face {\n  " + ";\n  ".join(decl) + ";\n}")

    src_label = ident or str(css)
    css_out = fonts_dir / f"{name}.subset.css"
    css_out.write_text(
        f"/* 由 film-assets subset_font.py --pack 生成，别手改；改文案后重跑。\n"
        f"   源：{src_label}（{css.name}）  族：{faces[0]['family']}  模式：{'原样拷贝分片' if a.copy_chunks else '逐片子集化'}\n"
        f"   许可：{facts['license']}，原文随附 {lic_dst.relative_to(fonts_dir).as_posix()} */\n"
        + "\n".join(rules) + "\n", "utf-8")
    manifest = {
        "kind": "pack",
        "source": src_label, "sourceCss": os.path.relpath(css, film), "sourceFamily": faces[0]["family"],
        "family": family_out, "mode": "copy" if a.copy_chunks else "subset",
        "copyright": copyright_, **facts,
        "licenseFile": lic_dst.relative_to(film).as_posix(), "licenseFrom": os.path.relpath(lic_src, film),
        "css": css_out.relative_to(film).as_posix(),
        "faces": out_faces,
        "chars": "".join(sorted(chars)), "charCount": len(chars), "missingInSource": miss_s,
        **allow_manifest(allow, allowed),
        "sources": sources, "bytesBefore": before, "bytesAfter": after,
        "createdAt": _dt.date.today().isoformat(),
    }
    (fonts_dir / f"{name}.subset.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(f"✓ {faces[0]['family']}（{src_label}）：{len(faces)} 片中挑 {len(out_faces)} 片，"
          f"{fmt_size(before)} -> {fmt_size(after)}  ({len(chars)} 字符, {'原样拷贝' if a.copy_chunks else '逐片子集化'})")
    print(f"  {css_out}")
    print(f"  许可：{facts['license']}"
          + (f"，RFN {facts['reservedFontNames']}" if facts["reservedFontNames"] else "")
          + f"；原文已拷到 {lic_dst.relative_to(film).as_posix()}")
    if missing:
        print(f"  ⚠ 分片包缺字（已按 --allow-missing 跳过）：{miss_s}", file=sys.stderr)
        for k, v in allowed.items():
            print(f"    [{k}] {len(v)} 个：{''.join(v)[:60]}{'…' if len(v) > 60 else ''}", file=sys.stderr)


def check_pack(film: Path, target: Path, family: str | None, extra_text, extra_files, cli_allow=None) -> None:
    css, lic, mpath = target, None, target.with_suffix(".json")
    if target.suffix == ".json":
        m = json.loads(target.read_text("utf-8"))
        css, lic = film / m["css"], film / m["licenseFile"]
    elif target.with_suffix(".json").is_file():
        m = json.loads(target.with_suffix(".json").read_text("utf-8"))
        lic = film / m["licenseFile"] if m.get("licenseFile") else None
    if not css.is_file():
        die(f"分片包 CSS 不存在：{css}")
    faces = parse_font_faces(css)
    fams = list(dict.fromkeys(f["family"] for f in faces))
    if family:
        faces = [f for f in faces if f["family"].lower() == family.lower()]
    elif len(fams) > 1:
        die(f"{css.name} 里有 {len(fams)} 个族，用 --family 指定要查哪个：{' / '.join(fams)}")
    chars, sources = collect(film, extra_text, extra_files)
    need = {ord(c) for c in chars}
    cover = pack_coverage(faces, need)
    have = set().union(*cover.values()) if cover else set()
    lies = sorted({cp for f in faces for cp in need
                   if _in_spans(cp, f["spans"]) and cp not in cover.get(f["index"], set())})
    missing = sorted(chr(c) for c in need - have if not chr(c).isspace())
    allow = manifest_allow(mpath, cli_allow)
    allowed: dict = {}
    if missing and allow:
        allowed, missing = apply_allow(missing, allow, list(dict.fromkeys(f["family"] for f in faces)), css.name)
    problems = []
    if missing:
        problems.append(f"缺 {len(missing)} 个字（文案改过了？重跑 --pack）：{''.join(missing)}"
                        + (f"（另有 {sum(map(len, allowed.values()))} 个按声明放行："
                           + "；".join(f"[{k}] {len(v)}" for k, v in allowed.items()) + "）" if allowed else ""))
    if lic is not None and not lic.is_file():
        problems.append(f"许可文件不见了：{lic}（OFL 要求随字体分发）")
    if lic is None:
        here = [p.name for p in css.parent.iterdir() if p.is_file() and LICENSE_RE.match(p.name)]
        sub = [p for d in css.parent.iterdir() if d.is_dir() for p in d.iterdir() if LICENSE_RE.match(p.name)]
        if not here and not sub:
            print(f"  ⚠ {css.parent} 附近没有许可文件；如果是 OFL 字体，许可原文要随附", file=sys.stderr)
    if lies:
        print(f"  ⚠ {len(lies)} 个字在某片的 unicode-range 里但那片的 cmap 没有：{''.join(map(chr, lies))[:40]}",
              file=sys.stderr)
    if problems:
        die("；".join(problems), 1)
    print(f"✓ {css.name}（{len(faces)} 片）覆盖当前文案{covered_phrase(len(chars), allowed)}（来源：{', '.join(sources)}）")


def main() -> None:
    logging.getLogger("fontTools").setLevel(logging.ERROR)  # 'meta NOT subset' 之类的噪音
    ap = parser(__doc__)
    ap.add_argument("--font", help="源字体，相对片子目录或绝对路径")
    ap.add_argument("--font-number", type=int, default=0, help="TTC 里第几个字体")
    ap.add_argument("--text", action="append", default=[])
    ap.add_argument("--text-file", action="append", default=[])
    ap.add_argument("--name", help="产出文件名前缀，默认取源字体文件名")
    ap.add_argument("--format", choices=["woff2", "ttf", "otf"], default="woff2")
    ap.add_argument("--allow-missing", action="append", nargs="?", const="*", default=None, metavar="类",
                    help="源字体缺字时只放行声明的那一类（默认缺字即报错，因为缺字=成片里出豆腐块）。" + ALLOW_HELP)
    ap.add_argument("--check", metavar="SUBSET", help="只检查已有子集是否覆盖当前文案")
    ap.add_argument("--keep-features", default="kern,liga,calt,locl,vert,vrt2,palt,halt",
                    help="保留的 OpenType 特性；竖排要 vert/vrt2，标点挤压要 palt/halt")
    ap.add_argument("--pack", help="分片包：npm 包名 / @font-face CSS 文件 / 含 index.css 的目录")
    ap.add_argument("--family", help="分片包里有多个族时，取哪一个（CSS 里的 font-family）")
    ap.add_argument("--rename", help="分片包产出的族名（默认沿用原族名；有 RFN 且要公开分发时改名）")
    ap.add_argument("--copy-chunks", action="store_true",
                    help="分片原样拷贝不子集化：字节与上游一致、可按 sha256 复核，代价是体积大（ghost-jam 实测约 8 倍）")
    ap.add_argument("--license", help="许可文件；分片包旁边找不到时必填")
    a = ap.parse_args()

    film = resolve_film(a.film, a.films_dir)
    if a.check:
        target = film / a.check if not Path(a.check).is_absolute() else Path(a.check)
        if target.suffix in (".css", ".json"):
            check_pack(film, target, a.family, a.text, a.text_file, a.allow_missing)
        else:
            check(film, a.check, a.text, a.text_file, a.allow_missing)
        return
    if a.pack and a.font:
        die("--pack 和 --font 只能给一个")
    if a.pack:
        chars, sources = collect(film, a.text, a.text_file)
        build_pack(film, a, chars, sources)
        return
    if not a.font:
        die("缺 --font（单个字体文件）或 --pack（分片包）")
    if Path(a.font).suffix.lower() == ".css" or (film / a.font).is_dir():
        die(f"{a.font} 是分片包（CSS/目录），用 --pack")
    src = film / a.font if not Path(a.font).is_absolute() else Path(a.font)
    if not src.is_file():
        die(f"源字体不存在：{src}")

    chars, sources = collect(film, a.text, a.text_file)
    font = load_font(src, a.font_number)
    cmap = font.getBestCmap()
    missing = sorted(c for c in chars if ord(c) not in cmap and not c.isspace())
    allow = parse_allow(a.allow_missing)
    allowed: dict = {}
    if missing and not allow:
        die(f"源字体缺 {len(missing)} 个字，成片里会变成豆腐块或回退到别的字体：{''.join(missing)}\n"
            f"  {ALLOW_HINT}", 1)
    if missing:
        fams = [font["name"].getDebugName(1), font["name"].getDebugName(16)]
        allowed, fatal = apply_allow(missing, allow, fams, f"源字体 {fams[0]}")
        if fatal:
            die(missing_report(f"源字体 {fams[0]}（成片里会变成豆腐块或回退到别的字体）", fatal, allowed, ALLOW_HINT), 1)

    opts = ft_subset.Options()
    opts.flavor = "woff2" if a.format == "woff2" else None
    opts.layout_features = [f for f in a.keep_features.split(",") if f]
    opts.name_IDs = ["*"]          # 保留 name 表（含版权/授权声明，OFL 要求随附）
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False           # 视频按像素渲染，hinting 只增体积
    opts.desubroutinize = True     # CFF 字体子集后体积更小
    sub = ft_subset.Subsetter(options=opts)
    sub.populate(unicodes=[ord(c) for c in chars if ord(c) in cmap])
    sub.subset(font)

    name = a.name or src.stem
    out_dir = film / "assets" / "fonts"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}.subset.{a.format}"
    ft_subset.save_font(font, str(out), opts)

    before, after = src.stat().st_size, out.stat().st_size
    family = font["name"].getDebugName(1)
    manifest = {
        "source": str(src if Path(a.font).is_absolute() else a.font),
        "sourceFontNumber": a.font_number,
        "sourceSha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        "family": family,
        "copyright": font["name"].getDebugName(0),
        "licenseDescription": font["name"].getDebugName(13),
        "licenseURL": font["name"].getDebugName(14),
        "output": str(out.relative_to(film)),
        "chars": "".join(sorted(chars)),
        "charCount": len(chars),
        "missingInSource": "".join(missing),
        **allow_manifest(allow, allowed),
        "sources": sources,
        "bytesBefore": before,
        "bytesAfter": after,
        "createdAt": _dt.date.today().isoformat(),
    }
    (out_dir / f"{name}.subset.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(f"✓ {family}: {fmt_size(before)} -> {fmt_size(after)}  ({len(chars)} 字符, {after/before*100:.2f}%)")
    print(f"  {out}")
    print(f"  授权字段(name 13)：{(manifest['licenseDescription'] or '（字体里没写，去来源页确认）')[:120]}")
    if missing:
        print(f"  ⚠ 源字体缺字（已按 --allow-missing 跳过）：{''.join(missing)}", file=sys.stderr)
        for k, v in allowed.items():
            print(f"    [{k}] {len(v)} 个：{''.join(v)[:60]}{'…' if len(v) > 60 else ''}", file=sys.stderr)


if __name__ == "__main__":
    main()
