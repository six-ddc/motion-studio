"""批量合成参照音与条件组。复用 film-narration/scripts/tts.py 的 synth_volcano_stream。
用法（仓库根）: .venv/bin/python tests/fixtures/_test-narration/formant/synth.py <plan.json> <outdir>
音色和参数取 films/demo-tls/script.json（去掉其中的 pronunciationDict，按 plan 重新给）。
plan: [{"cond": "ref_yue", "text": "...", "dict": [...] | null, "n": 4, "target": "月"}, ...]
每次合成存 <outdir>/<cond>/<k>.mp3 + .json（字级时间戳）。已存在的跳过（可断点续）。
"""
import json, sys, copy
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

REPO = Path(__file__).resolve().parents[4]   # tests/fixtures/_test-narration/formant/ -> 仓库根
sys.path.insert(0, str(REPO / "skills/film-narration/scripts"))
import tts  # noqa
from _film import load_dotenv  # noqa

load_dotenv(REPO / "films/demo-tls")
base = json.loads((REPO / "films/demo-tls/script.json").read_text())
plan = json.loads(Path(sys.argv[1]).read_text())
out = Path(sys.argv[2])

jobs = []
for p in plan:
    for k in range(p["n"]):
        jobs.append((p, k))


def run(job):
    p, k = job
    d = out / p["cond"]; d.mkdir(parents=True, exist_ok=True)
    mp3 = d / f"{p.get('tag', '')}{k:02d}.mp3"
    js = mp3.with_suffix(".json")
    if js.exists():
        return f"skip {mp3.name}"
    spec = copy.deepcopy(base)
    spec.pop("pronunciationDict", None)
    if p.get("dict"):
        spec["pronunciationDict"] = {"tone": p["dict"]}
    if p.get("ssml"):
        spec["ssml"] = p["ssml"]
    words, usage = tts.synth_volcano_stream(p["text"], mp3, spec)
    js.write_text(json.dumps({"text": p["text"], "dict": p.get("dict"), "ssml": p.get("ssml"), "target": p["target"],
                              "words": words, "usage": usage}, ensure_ascii=False))
    return f"ok {p['cond']}/{mp3.name} {len(words)} words"


with ThreadPoolExecutor(6) as ex:
    for r in ex.map(run, jobs):
        print(r, flush=True)
