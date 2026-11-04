"""修复后的闭环复核：文本转写条目还原后，用 narration.json 里 words[].parts 的单字时间取「月」——
沿用 gate.py 已过闸门的单字窗口，不用没过闸门的「密+月」合并窗口（gate_merged.py，留一法 21/24）。
用法（仓库根）: target_fixed.py <narration.json> <vo.wav 或成片 mp4>   （绝对时间）"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from formant import load, measure
g = json.load(open(Path(__file__).parent / "fm/gate.json"))
R = {k: [x[k] for x in g["yue"]] for k in ("F1_p80", "F1_med", "F2_p10", "nvoiced")}
Y = {k: [x[k] for x in g["yao"]] for k in ("F1_p80", "F1_med", "F2_p10", "nvoiced")}
thr = (np.median(R["F1_p80"]) + np.median(Y["F1_p80"])) / 2
n = json.load(open(sys.argv[1]))
w = [x for x in n["words"] if x["w"].startswith("密钥")][-1]
p = w["parts"][-1]
m = measure(load(sys.argv[2]), p["start"], p["end"])
print(f"{sys.argv[2]}: {w['w']} alias {w['alias']}，取 parts「{p['w']}」[{p['start']:.3f}-{p['end']:.3f}]s → 判 {'yào' if m['F1_p80'] > thr else 'yuè'}（阈值 {thr:.0f} Hz）")
for k in ("F1_p80", "F1_med", "F2_p10", "nvoiced"):
    inr = min(R[k]) <= m[k] <= max(R[k]); iny = min(Y[k]) <= m[k] <= max(Y[k])
    print(f"  {k:7s} {m[k]:6.0f}   yuè 组 {min(R[k]):.0f}–{max(R[k]):.0f} {'✓在内' if inr else '  在外'}   yào 组 {min(Y[k]):.0f}–{max(Y[k]):.0f} {'✓在内' if iny else '  在外'}")
