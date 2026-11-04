"""量实际旁白里「钥」那一段，并按闸门阈值判读。
用法（仓库根）: .venv/bin/python tests/fixtures/_test-narration/formant/target.py <narration.json> <s2.wav 或 vo.wav 或 成片 mp4> [line|abs]
  line: 音频是单句 out/vo/s2.wav（时间戳要减去 s2 的 start）；abs: 音频是整条 vo.wav / 成片。"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from formant import load, measure

nar, audio, mode = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "abs")
n = json.load(open(nar)); s2 = [l for l in n["lines"] if l["id"] == "s2"][0]
tok = [w for w in s2["words"] if w["w"].startswith("钥")][-1]
off = s2["start"] if mode == "line" else 0.0
m = measure(load(audio), tok["start"] - off, tok["end"] - off)
g = json.load(open(Path(__file__).parent / "fm/gate.json"))
yue = [x["F1_p80"] for x in g["yue"]]; yao = [x["F1_p80"] for x in g["yao"]]
thr = (np.median(yue) + np.median(yao)) / 2
print(f"{audio}: 「钥」token [{tok['start']:.3f}-{tok['end']:.3f}]s  有声帧 {m['nvoiced']}  F1_p80 {m['F1_p80']:.0f} Hz  "
      f"F1_med {m['F1_med']:.0f} Hz  F2_p10 {m['F2_p10']:.0f} Hz  F2_med {m['F2_med']:.0f} Hz")
print(f"  参照 yuè F1_p80 {min(yue):.0f}–{max(yue):.0f} Hz / yào {min(yao):.0f}–{max(yao):.0f} Hz，阈值 {thr:.0f} Hz → 判 {'yào' if m['F1_p80'] > thr else 'yuè'}")
print("  轨迹 (t, F1, F2):", [(a, int(b), int(c)) for a, b, c in m["track"]])
