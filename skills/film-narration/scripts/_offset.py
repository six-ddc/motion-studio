"""片头留白 narrationOffset：读取与「各环有没有接住」的机械检查（film-narration 专有；找片、参数等通用部分在 film-core 的 film.py）。

单一真相源是 film.json：
    "narrationOffset": 0.6   旁白音频第 0 秒落在成片第几秒（缺省 0）
    "narrationTail":   2.5   旁白念完后的片尾留白（缺省 0）

narration.json 的时刻永远是**旁白音频内**的秒（tts.py / align.py --from 每次重写它，手填的值会被冲掉）；
成片时间 = 旁白时间 + narrationOffset。各环怎么接：
    narration.js loadNarration  自动读 film.json，vo.at() 等直接返回成片时间
    sfx.mjs                     at 绑定的 cue 加偏移，out/sfx.wav 按成片时间渲，并在 out/sfx.json 记下用的偏移
    subs.py                     字幕时间加偏移（字幕挂在成片上）
    mux.sh                      旁白 adelay 偏移；音效不再延迟（已是成片时间）
    align.py --verify           转写成片时按 旁白时间 + 偏移 算漂移；转写 out/vo.wav 时偏移为 0
offset_links() 是「某一环没接住」的检查，mux.sh 和 align.py --verify 都跑。

命令行（mux.sh 用）：python3 _offset.py <片子目录> [--sfx <wav>]
    stdout 一行偏移秒数；链路错误打 stderr 并退出 1。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import die, film_json  # noqa: E402


def narration_offset(film: Path) -> float:
    v = film_json(film).get("narrationOffset", 0)
    if v is None:
        v = 0
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
        die(f"film.json 的 narrationOffset 必须是 ≥ 0 的秒数（收到 {v!r}）")
    return float(v)


def _shotlist_spec(film: Path):
    sl = film / "docs" / "shotlist.md"
    if not sl.exists():
        return None
    m = re.search(r"```json\s*\n(.*?)\n```", sl.read_text(encoding="utf-8"), re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def _scene_imports(film: Path, name: str) -> bool:
    entry = film / (film_json(film).get("entry") or "scene.html")
    return entry.exists() and f"runtime/{name}" in entry.read_text(encoding="utf-8")


def offset_links(film: Path, offset: float, sfx: Path | None = None) -> tuple[list[str], list[str]]:
    """逐环查有没有接住片头留白。返回 (错误, 提示)。
    只查「写了的地方和 film.json 是否矛盾」，不要求任何下游抄一份 narrationOffset。"""
    errors, notes = [], []
    tail = film_json(film).get("narrationTail")
    # 1. 分镜：shotlist 不需要抄一份留白。写了 vo_offset 且与 film.json 不同 = 真矛盾（画面按一个留白排、合流按另一个）
    spec = _shotlist_spec(film)
    if spec is not None:
        pads = spec.get("pads") or {}
        name = spec.get("vo_offset")
        sl_off = None
        if isinstance(name, str):
            if name in pads:
                sl_off = pads[name]
            else:
                notes.append(f"docs/shotlist.md 的 vo_offset 引用了未声明的 pad「{name}」，没拿它和 film.json 比"
                             f"（片头留白只看 film.json narrationOffset，vo_offset 可以删掉）")
        elif isinstance(name, (int, float)) and not isinstance(name, bool):
            sl_off = name
        if isinstance(sl_off, (int, float)) and not isinstance(sl_off, bool) and abs(float(sl_off) - offset) > 1e-3:
            label = f"pads.{name}={sl_off}s" if isinstance(name, str) else f"{sl_off}s"
            errors.append(f"docs/shotlist.md 的 vo_offset（{label}）≠ film.json narrationOffset={offset}s："
                          f"分镜按一个留白排时间，合流和画面按另一个。真相源是 film.json：删掉 shotlist 的 vo_offset，"
                          f"或改成和 film.json 一致")
        if tail is not None and isinstance(pads.get("tail"), (int, float)) and abs(pads["tail"] - tail) > 1e-3:
            errors.append(f"docs/shotlist.md 的 pads.tail={pads['tail']}s ≠ film.json narrationTail={tail}s")
    # 2. 场景：片内的 runtime/narration.js（冻结副本或片子自己改的那份）必须认 narrationOffset
    rt = film / "runtime" / "narration.js"
    if rt.exists():
        if offset and "narrationOffset" not in rt.read_text(encoding="utf-8"):
            errors.append(f"片内 runtime/narration.js 不认 film.json 的 narrationOffset：声音会延迟 {offset}s，画面不会。"
                          f"删掉片内这份改用套件挂载的 narration.js，或在它的 loadNarration 里读 narrationOffset")
    elif offset and not _scene_imports(film, "narration.js"):
        notes.append(f"场景没 import runtime/narration.js：narrationOffset={offset}s 要场景自己加。"
                     f"画面层对点用 film-critique 的 check.mjs（mark.sync）查")
    # 3. 音效：sfx.wav 按成片时间渲，必须是按现在这个偏移渲的
    if sfx is not None and sfx.exists():
        meta = sfx.with_suffix(".json")
        if meta.exists():
            m_off = json.loads(meta.read_text(encoding="utf-8")).get("narrationOffset", 0)
            if abs(float(m_off) - offset) > 1e-3:
                errors.append(f"{sfx.name} 是按 narrationOffset={m_off}s 渲的，现在是 {offset}s：重跑 sfx.mjs")
        elif offset:
            errors.append(f"{sfx.name} 没有 {meta.name}（不知道它按哪个偏移渲的）：重跑 sfx.mjs")
    return errors, notes


if __name__ == "__main__":
    _USAGE = ("用法：python3 _offset.py <片子目录> [--sfx <wav>]\n"
              "  mux.sh 用：stdout 一行片头留白秒数（film.json narrationOffset）；偏移链路没接住退出 1")
    argv = sys.argv[1:]
    if any(a in ("-h", "--help") for a in argv):
        print(_USAGE)
        sys.exit(0)
    sfx_arg = None
    if len(argv) == 3 and argv[1] == "--sfx":
        sfx_arg = Path(argv[2])
    elif len(argv) != 1 or argv[0].startswith("-"):
        die(f"参数不对：{' '.join(argv) or '（空）'}\n{_USAGE}", 2)
    f = Path(argv[0]).resolve()
    if not (f / "film.json").exists():
        die(f"{f} 不是片子目录（没有 film.json）", 2)
    if sfx_arg is not None and not sfx_arg.is_absolute():
        sfx_arg = f / sfx_arg
    off = narration_offset(f)
    errs, notes = offset_links(f, off, sfx_arg)
    for n in notes:
        print(f"⚠ {n}", file=sys.stderr)
    for e in errs:
        print(f"✗ 偏移没接住：{e}", file=sys.stderr)
    print(f"{off:g}")
    sys.exit(1 if errs else 0)
