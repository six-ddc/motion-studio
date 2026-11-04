"""film-core lib · Python 侧的找片、找 .venv、参数守卫、能力查找（Node 侧 env.mjs / film.mjs / cli.mjs 的等价物）。

能力 skill 的 Python 脚本这样引它（装到同一层后相对关系不变）：

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
    import film  # noqa: E402

约定与 Node 侧逐条一致：
  - films/ 的位置：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录。
  - --film <slug>（也可以给目录）；只有一部片子时可省，多部时报错并列出，绝不默默挑一个。
  - 参数守卫：--help / -h exit 0；未知参数、缺值、多余位置参数 exit 2（argparse 本身就是 exit 2，parser() 只统一文案）。
  - 失败 exit 非 0 并在 stderr 写 "✗ 原因"。
  - .venv：从 cwd 往上 → 从 films/ 的父目录往上 → $VIRTUAL_ENV 兜底。
  - capability(name)：别的 film-* skill 装了就返回它的目录，没装 die("缺能力 film-X…", 1)。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

CORE_DIR = Path(__file__).resolve().parent.parent
SKILLS_ROOT = CORE_DIR.parent


def die(msg: str, code: int = 1) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- 参数
class _Parser(argparse.ArgumentParser):
    def error(self, message):  # 未知参数 / 缺值 → exit 2，文案与 Node 侧一致
        self.print_usage(sys.stderr)
        print(f"✗ {message}\n  用 --help 查看参数表", file=sys.stderr)
        sys.exit(2)


def parser(description: str, *, film: bool = True) -> argparse.ArgumentParser:
    """统一的 argparse：带 --film / --films-dir（film=True 时）。"""
    ap = _Parser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    if film:
        ap.add_argument("--film", help="片子 slug 或目录；只有一部时可省")
        ap.add_argument("--films-dir", help="films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录")
    return ap


# ---------------------------------------------------------------- 找片
def films_dir(explicit: str | None = None) -> Path | None:
    """films/ 的位置；找不到返回 None。"""
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("FILMS_DIR")
    if env:
        return Path(env).expanduser().resolve()
    cwd = Path.cwd()
    for d in [cwd, *cwd.parents]:
        if (d / "films").is_dir():
            return (d / "films").resolve()
    return None


def list_films(root: Path) -> list[str]:
    if not root or not root.is_dir():
        return []
    return sorted(d.name for d in root.iterdir() if d.is_dir() and (d / "film.json").exists())


def resolve_film(arg: str | None, films_dir_arg: str | None = None) -> Path:
    """返回片子目录（绝对路径）。arg 可以是 slug 或目录。"""
    if arg:
        p = Path(arg).expanduser()
        if p.is_dir() and (p / "film.json").exists():
            return p.resolve()
    root = films_dir(films_dir_arg)
    if root is None:
        die(f"从 {Path.cwd()} 往上找不到 films/ 目录。在含 films/ 的目录（或其子目录）下运行，或用 --films-dir / $FILMS_DIR 指定", 2)
    all_ = list_films(root)
    if arg:
        if (root / arg / "film.json").exists():
            return (root / arg).resolve()
        die(f"找不到 {root / arg / 'film.json'}。现有影片：{' / '.join(all_) or '（无）'}", 2)
    if len(all_) == 1:
        return (root / all_[0]).resolve()
    die(f"{root} 下有多部影片，必须用 --film 指定：{' / '.join(all_)}" if all_ else f"{root} 下没有影片（需要 films/<slug>/film.json）", 2)
    raise AssertionError


def film_json(film: Path) -> dict:
    p = film / "film.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        die(f"{p} 不是合法 JSON：{e}")
        raise


def out_dir(film: Path, *sub: str) -> Path:
    d = film.joinpath("out", *sub)
    d.mkdir(parents=True, exist_ok=True)
    return d


def rel(p: Path, film: Path) -> str:
    try:
        return str(p.resolve().relative_to(film))
    except ValueError:
        return str(p)


def need_file(p: Path, hint: str) -> Path:
    if not p.exists():
        die(f"缺少 {p}。{hint}")
    return p


def load_dotenv(film: Path) -> None:
    """从片子目录往上找第一个 .env，只填充未设置的变量。不打印任何值。"""
    for d in [film, *film.parents]:
        env = d / ".env"
        if env.exists():
            for raw in env.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))
            return


# ---------------------------------------------------------------- checks 声明
CHECK_ID = re.compile(r"^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$")


def checks(film: Path) -> dict:
    """film.json checks → {id: True | 参数dict}。格式错 die(…, 2)（拼错的声明不能静默不开）。"""
    raw = film_json(film).get("checks")
    out: dict = {}
    if raw is None:
        return out
    if not isinstance(raw, list):
        die(f"{film / 'film.json'} 的 checks 必须是数组（扁平 id 列表），收到 {json.dumps(raw, ensure_ascii=False)[:80]}", 2)
    for item in raw:
        if isinstance(item, str):
            k, v = item, True
        elif isinstance(item, dict) and len(item) == 1:
            (k, v), = item.items()
            if not isinstance(v, dict):
                die(f"checks 里 {{\"{k}\": …}} 的参数必须是对象", 2)
        else:
            die(f"checks 的每一项是 id 字符串或单键对象，收到 {json.dumps(item, ensure_ascii=False)}", 2)
        if not CHECK_ID.match(k):
            die(f"checks id \"{k}\" 不合法：小写字母开头，只含 [a-z0-9-]，最多一级点号", 2)
        if k in out:
            die(f"checks 里 \"{k}\" 出现了两次", 2)
        out[k] = v
    return out


def check_param(film: Path, cid: str):
    """声明了没有：False / True / 参数 dict。"""
    return checks(film).get(cid, False)


# ---------------------------------------------------------------- .venv
def find_venv_bin(name: str, films_dir_arg: str | None = None) -> Path | None:
    starts = [Path.cwd()]
    fd = films_dir(films_dir_arg)
    if fd:
        starts.append(fd.parent)
    for s in starts:
        for d in [s.resolve(), *s.resolve().parents]:
            p = d / ".venv" / "bin" / name
            if p.exists():
                return p
    venv = os.environ.get("VIRTUAL_ENV")
    if venv and (Path(venv) / "bin" / name).exists():
        return Path(venv) / "bin" / name
    return None


# ---------------------------------------------------------------- 能力
def installed_skills() -> list[str]:
    if not SKILLS_ROOT.is_dir():
        return []
    return sorted(d.name for d in SKILLS_ROOT.iterdir()
                  if re.match(r"^film-[a-z0-9-]+$", d.name) and (d / "SKILL.md").exists())


def capability(name: str) -> Path:
    """别的 film-* skill 的目录；没装 die('缺能力 film-X…', 1)。"""
    p = SKILLS_ROOT / name
    if not re.match(r"^film-[a-z0-9-]+$", name) or not (p / "SKILL.md").exists():
        die(f"缺能力 {name}：没装在 {SKILLS_ROOT}/ 下。装上它（把 skills/{name}/ 拷到 film-core 旁边），或者不用依赖它的功能", 1)
    return p
