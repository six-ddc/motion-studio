# 从无声成片里量每个弹簧点第一次出现的帧时刻，对照 vo.at(k)+narrationOffset
# 用法（仓库根）: .venv/bin/python tests/fixtures/_test-narration/dotmeas.py <夹具目录> <silent.mp4> <narrationOffset>
import json, subprocess, sys
from pathlib import Path
import numpy as np
REPO = Path(__file__).resolve().parents[3]   # tests/fixtures/_test-narration/ -> 仓库根
RUNTIME_NODE = REPO / "skills/film-core/lib/runtime-node.mjs"
film, mp4, off = sys.argv[1], sys.argv[2], float(sys.argv[3])
W, H = 270, 480
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-vf", f"scale={W}:{H}:flags=neighbor", "-f", "rawvideo",
                      "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, H, W)
last = fr[-1].astype(int)
band = last[int(H*0.3):int(H*0.5)]
cols = np.where((band > 100).any(axis=0))[0]
groups = np.split(cols, np.where(np.diff(cols) > 3)[0] + 1)
centers = [int(g.mean()) for g in groups]
nar = json.load(open(f"{film}/narration.json"))
keys = ['纯函数', 'seek', 'ffmpeg', '时间戳']
js = subprocess.run(["node", "-e", f"""import('{RUNTIME_NODE}').then(r=>r.importRuntime('narration.js')).then(m=>{{
const v=m.makeNarration(JSON.parse(require('fs').readFileSync('{film}/narration.json','utf8')),{{offset:{off}}});
console.log(JSON.stringify({json.dumps(keys)}.map(k=>v.at(k))))}})"""], capture_output=True, text=True, check=True).stdout
want = json.loads(js)
fps = 30
for k, cx, w in zip(keys, centers, want):
    region = fr[:, int(H*0.3):int(H*0.5), max(0, cx-12):cx+12].astype(int)
    vis = np.where((region > 100).any(axis=(1, 2)))[0]
    t = vis[0] / fps
    print(f"{k:6s} 画面首现 帧{vis[0]:4d} = {t:.3f}s   期望 vo.at+偏移 {w:.3f}s   差 {t - w:+.3f}s")
