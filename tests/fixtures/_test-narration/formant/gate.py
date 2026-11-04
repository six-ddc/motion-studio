"""检验力闸门：两组参照（必然 yuè / 必然 yào）在 F1_p80 / F2_p10 上能否被清楚分开。
预先定的通过判据：主指标 F1_p80 的 Mann-Whitney 双侧 p < 0.001 且 留一法阈值分类正确率 >= 23/24。
"""
import json, sys
from pathlib import Path
import numpy as np
from scipy.stats import mannwhitneyu
sys.path.insert(0, str(Path(__file__).parent))
from formant import load, measure, target_token

root = Path(__file__).parent / "fm"


def collect(cond):
    res = []
    for js in sorted((root / cond).glob("*.json")):
        d = json.loads(js.read_text())
        tok = target_token(d["words"], d["target"])
        m = measure(load(js.with_suffix(".mp3")), tok["start"], tok["end"])
        m["file"] = js.stem; m["tok"] = tok
        res.append(m)
    return res


def loo(a, b, key, hi_is_b=True):
    """留一法：每次拿掉一个样本，用剩下的两组中位数的中点当阈值，判被拿掉的那个。"""
    ok = 0
    allx = [(x[key], 0) for x in a] + [(x[key], 1) for x in b]
    for i, (v, lab) in enumerate(allx):
        rest = [p for j, p in enumerate(allx) if j != i]
        ma = np.median([p[0] for p in rest if p[1] == 0]); mb = np.median([p[0] for p in rest if p[1] == 1])
        thr = (ma + mb) / 2
        pred = int(v > thr) if mb > ma else int(v < thr)
        ok += pred == lab
    return ok, len(allx)


def report(a, b, key, na="yue", nb="yao"):
    va = np.array([x[key] for x in a]); vb = np.array([x[key] for x in b])
    u, p = mannwhitneyu(va, vb, alternative="two-sided")
    ok, n = loo(a, b, key)
    sd = np.sqrt((va.var(ddof=1) + vb.var(ddof=1)) / 2)
    print(f"{key:7s} {na}: 中位 {np.median(va):6.0f} Hz  范围 {va.min():.0f}–{va.max():.0f}   "
          f"{nb}: 中位 {np.median(vb):6.0f} Hz  范围 {vb.min():.0f}–{vb.max():.0f}")
    print(f"        组间中位差 {np.median(vb)-np.median(va):+.0f} Hz   d={(vb.mean()-va.mean())/sd:+.2f}   "
          f"MW U={u:.1f} p={p:.2e}   留一法 {ok}/{n}")
    return p, ok, n


if __name__ == "__main__":
    yue, yao = collect("ref_yue"), collect("ref_yao")
    for g, name in ((yue, "ref_yue"), (yao, "ref_yao")):
        print(f"\n[{name}]")
        for m in g:
            print(f"  {m['file']:10s} tok {m['tok']['w']}[{m['tok']['start']:.3f}-{m['tok']['end']:.3f}] "
                  f"voiced {m['nvoiced']:2d}  F1_p80 {m['F1_p80']:5.0f}  F1_med {m['F1_med']:5.0f}  "
                  f"F2_p10 {m['F2_p10']:5.0f}  F2_med {m['F2_med']:5.0f}")
    print()
    for k in ("F1_p80", "F1_med", "F2_p10", "F2_med"):
        report(yue, yao, k)
    json.dump({"yue": yue, "yao": yao}, open(root / "gate.json", "w"), ensure_ascii=False, default=float)
