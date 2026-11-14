"""测离线配方的客观频谱与包络；不代表听感验收。先跑 tests/unit.mjs 生成 WAV。"""
import json
from pathlib import Path
import numpy as np
from scipy.io import wavfile

out = Path(__file__).resolve().parents[1] / 'out' / 'recipes'
rows = []
for p in sorted(out.glob('*.wav')):
    sr, raw = wavfile.read(p)
    st = raw.astype(float) / 32767
    x = st.mean(axis=1) if st.ndim == 2 else st   # 立体声配方（rain）：频谱量取中声道，另记左右相关与分窗 RMS
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / sr)
    power = np.abs(np.fft.rfft(x)) ** 2
    centroid = float((power * f).sum() / max(power.sum(), 1e-20))
    low = float(power[f < 200].sum() / max(power.sum(), 1e-20))
    high = float(power[f > 2500].sum() / max(power.sum(), 1e-20))
    def cent(a, b):
        y = x[round(a*sr):round(b*sr)]
        if not len(y): return 0
        spec = np.abs(np.fft.rfft(y)) ** 2
        return float((spec*np.fft.rfftfreq(len(y), 1/sr)).sum()/max(spec.sum(), 1e-20))
    rows.append(dict(name=p.stem, seconds=n/sr, peak=round(float(np.abs(x).max()),3),
                     centroidHz=round(centroid), low200Pct=round(low*100,1), high2500Pct=round(high*100,1),
                     peakMs=round(float(np.argmax(np.abs(x))/sr*1000),2),
                     centroidEarly=round(cent(0,min(.03,n/sr))), centroidLate=round(cent(.05,min(.2,n/sr))),
                     dc=round(float(x.mean()),6), nan=int((~np.isfinite(x)).sum())))
    if st.ndim == 2:
        w = int(.25 * sr); win = np.sqrt((st[:n // w * w] ** 2).mean(axis=1).reshape(-1, w).mean(axis=1))
        rows[-1].update(peak=round(float(np.abs(st).max()),3), lrCorr=round(float(np.corrcoef(st[:,0], st[:,1])[0,1]),3),
                        win250Cv=round(float(win.std() / win.mean()),3), crestDb=round(float(20*np.log10(np.abs(st).max()/np.sqrt((st**2).mean()))),1))
assert len(rows) == 18
lookup = {r['name']: r for r in rows}
assert lookup['crack']['peakMs'] < 15
assert lookup['sub']['low200Pct'] > 90
assert lookup['shimmer']['high2500Pct'] > 80
rain = lookup['rain']   # 连续床：左右去相关、0.25 s 分窗 RMS 没有空洞、能量在中高频（300 Hz 高通的噪声底 + 雨滴带通）
assert abs(rain['lrCorr']) < .3 and rain['win250Cv'] < .35 and rain['low200Pct'] < 5 and 1500 < rain['centroidHz'] < 6000, rain
assert all(r['nan'] == 0 and r['peak'] <= .901 for r in rows)
assert all(abs(r['dc']) < 1e-3 for r in rows), [(r['name'], r['dc']) for r in rows if abs(r['dc']) >= 1e-3]  # 配方输出过 20 Hz 去直流高通
print(json.dumps(rows,ensure_ascii=False,indent=1))
(out.parent / 'measure.json').write_text(json.dumps(rows,ensure_ascii=False,indent=1)+'\n')
print('sfx 客观特征全部通过：18 种配方/材质')
