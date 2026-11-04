"""条件组：同一句「两端交换参数，各自算出同一个密钥。」不带词典 / 词典 yue4 / 词典 yao4 各 12 次；
外加词典正对照「他走进了一家银行。」不带 / 银行/(yin2)(xing2) 各 8 次。
每次用和闸门完全相同的管线测目标字，并按闸门的留一法阈值（两参照组 F1_p80 中位数的中点）逐个判读。"""
import json, sys
from pathlib import Path
import numpy as np
from scipy.stats import mannwhitneyu
sys.path.insert(0, str(Path(__file__).parent))
from gate import collect

root = Path(__file__).parent / "fm"
g = json.loads((root / "gate.json").read_text())
yue = np.array([x["F1_p80"] for x in g["yue"]]); yao = np.array([x["F1_p80"] for x in g["yao"]])
thr = (np.median(yue) + np.median(yao)) / 2
print(f"判读阈值 F1_p80 = {thr:.0f} Hz（参照 yuè 中位 {np.median(yue):.0f} / yào 中位 {np.median(yao):.0f}）\n")

res = {}
for c in ("c_nodict", "c_dict_yue", "c_dict_yao", "b_nodict", "b_dict_xing"):
    r = collect(c); res[c] = r
    v = np.array([x["F1_p80"] for x in r]); f2 = np.array([x["F2_p10"] for x in r])
    nv = [x["nvoiced"] for x in r]
    line = f"{c:12s} F1_p80 中位 {np.median(v):5.0f} Hz ({v.min():.0f}–{v.max():.0f})  F2_p10 中位 {np.median(f2):5.0f} Hz  有声帧中位 {np.median(nv):.0f}"
    if c.startswith("c_"):
        line += f"   判 yào {int((v > thr).sum())}/{len(v)}"
    print(line)
    print("     F1_p80:", " ".join(f"{x:.0f}" for x in v))


def mw(a, b, k="F1_p80"):
    va = [x[k] for x in res[a]]; vb = [x[k] for x in res[b]]
    u, p = mannwhitneyu(va, vb, alternative="two-sided")
    return f"{a} vs {b}: {k} 中位差 {np.median(vb)-np.median(va):+.0f} Hz  U={u:.1f} p={p:.3g}"


print()
for a, b in (("c_nodict", "c_dict_yue"), ("c_nodict", "c_dict_yao"), ("c_dict_yue", "c_dict_yao"),
             ("b_nodict", "b_dict_xing")):
    print(mw(a, b)); print("   " + mw(a, b, "F2_p10"))
json.dump(res, open(root / "cond.json", "w"), ensure_ascii=False, default=float)
