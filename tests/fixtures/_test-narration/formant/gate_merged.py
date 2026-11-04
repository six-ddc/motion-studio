"""合并窗口版闸门：文本转写条目会把「密」「月」两个 token 还原成一个「密钥。」，单字边界丢了。
所以分析段改成 [密.start, 目标字.end]，用同一批参照数据**重新过闸门**（判据同 gate.py：p<0.001 且留一法 ≥ 23/24），
过了才能拿这个窗口去量真实旁白。其余管线参数与 formant.py 完全相同。
用法: gate_merged.py [<narration.json> <音频> line|abs]   不带参数只跑闸门。"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from formant import load, measure
from gate import report

root = Path(__file__).parent / "fm"
def merged(cond):
    out = []
    for js in sorted((root / cond).glob("*.json")):
        d = json.loads(js.read_text()); w = d["words"]
        i = max(k for k, x in enumerate(w) if x["w"].startswith(d["target"]))
        assert w[i - 1]["w"][0] in "密蜜秘", w[i - 1]
        m = measure(load(js.with_suffix(".mp3")), w[i - 1]["start"], w[i]["end"]); m["file"] = js.stem; out.append(m)
    return out
yue, yao = merged("ref_yue"), merged("ref_yao")
print("合并窗口 [密.start, 目标字.end + 0.05s]")
for k in ("F1_p80", "F1_med", "F2_p10"):
    report(yue, yao, k)
thr = (np.median([x["F1_p80"] for x in yue]) + np.median([x["F1_p80"] for x in yao])) / 2
print(f"判读阈值 F1_p80 {thr:.0f} Hz")
for c in ("w_alias", "c_dict_yue"):
    v = [x["F1_p80"] for x in merged(c)]
    print(f"  旁证 {c}: F1_p80 中位 {np.median(v):.0f} Hz ({min(v):.0f}–{max(v):.0f})  判 yào {sum(x > thr for x in v)}/{len(v)}")
if len(sys.argv) > 2:
    n = json.load(open(sys.argv[1])); s2 = [l for l in n["lines"] if l["id"] == "s2"][0]
    tok = [w for w in s2["words"] if w["w"].startswith("密钥")][-1]
    off = s2["start"] if sys.argv[3] == "line" else 0.0
    m = measure(load(sys.argv[2]), tok["start"] - off, tok["end"] - off)
    print(f"\n目标 {sys.argv[2]}: token {tok['w']} [{tok['start']:.3f}-{tok['end']:.3f}] alias {tok.get('alias')}  有声帧 {m['nvoiced']}"
          f"  F1_p80 {m['F1_p80']:.0f} Hz  F1_med {m['F1_med']:.0f} Hz  F2_p10 {m['F2_p10']:.0f} Hz → 判 {'yào' if m['F1_p80'] > thr else 'yuè'}")
    print("  yuè 组 F1_p80 %.0f–%.0f Hz / yào 组 %.0f–%.0f Hz" % (min(x['F1_p80'] for x in yue), max(x['F1_p80'] for x in yue), min(x['F1_p80'] for x in yao), max(x['F1_p80'] for x in yao)))
