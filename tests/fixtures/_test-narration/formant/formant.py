"""LPC 极点法测目标字段的 F1/F2。参数全部固定在这里，参照组、目标、条件组共用同一条管线。

参数（预先定下，看参照组结果前就写死）：
  解码      ffmpeg -> 单声道 44100 Hz float
  重采样    10000 Hz（男声 5 个共振峰都在 5 kHz 以内；librosa.resample soxr_hq）
  预加重    y[n] - 0.97 y[n-1]（在 10 kHz 信号上）
  分帧      25 ms Hamming 窗（250 点），步长 5 ms
  LPC 阶数  12（= 2 + fs/1000）
  极点筛选  虚部 > 0；90 Hz < f < 4800 Hz；带宽 B = -(fs/π)ln|r| < 400 Hz；F1 = 最低，F2 = 次低
  有声判定  pyin(整句, fmin 60, fmax 300, frame 2048) voiced_flag 且 帧 RMS > 段内最大 RMS - 25 dB
  分析段    目标字 token 的 [start, end + 0.05 s]（时间戳来自接口；句末 token 的 end 常偏早）
  主指标    F1_p80：段内有声帧 F1 的第 80 百分位（抓韵腹：yào 的 [ɑ] vs yuè 的 [ɛ]）
  副指标    F2_p10：有声帧 F2 的第 10 百分位（yào 收在 [u]，F2 会掉得很低）
"""
import json, subprocess
import numpy as np
import librosa

SR0, SR = 44100, 10000
PRE, WIN, HOP, ORDER = 0.97, 0.025, 0.005, 12
TAIL = 0.05


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR0),
                          "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def formants_frame(fr):
    a = librosa.lpc(fr, order=ORDER)
    r = np.roots(a)
    r = r[np.imag(r) > 0]
    f = np.angle(r) * SR / (2 * np.pi)
    bw = -SR / np.pi * np.log(np.abs(r))
    keep = (f > 90) & (f < 4800) & (bw < 400)
    f = np.sort(f[keep])
    return (f[0] if len(f) > 0 else np.nan, f[1] if len(f) > 1 else np.nan)


def measure(y44, t0, t1):
    """返回 dict：F1_p80, F2_p10, F1_med, F2_med, nvoiced, 以及逐帧轨迹。"""
    t1 = t1 + TAIL
    i0, i1 = int(t0 * SR0), min(len(y44), int(t1 * SR0))
    seg44 = y44[max(0, i0 - int(0.05 * SR0)): i1 + int(0.05 * SR0)]   # 两侧留 50ms 给 pyin/LPC 窗
    off = (max(0, i0 - int(0.05 * SR0))) / SR0
    # pyin 跑整句而不是只跑分析段：只喂 0.3 s 的短段时 HMM 平滑在段边缘不可靠，
    # 第一版这样做让 ref_yao/秘药_03 的有声帧掉到 < 3 帧（该段实际有约 0.1 s 清楚的浊音）
    f0, vflag, _ = librosa.pyin(y44, fmin=60, fmax=300, sr=SR0, frame_length=2048,
                                hop_length=int(HOP * SR0))
    tv = librosa.times_like(f0, sr=SR0, hop_length=int(HOP * SR0))
    y = librosa.resample(seg44, orig_sr=SR0, target_sr=SR, res_type="soxr_hq")
    y = np.append(y[0], y[1:] - PRE * y[:-1])
    n, h = int(WIN * SR), int(HOP * SR)
    w = np.hamming(n)
    rows = []
    rms_all = []
    for s in range(0, len(y) - n, h):
        tc = off + (s + n / 2) / SR
        fr = y[s:s + n] * w
        rms_all.append((tc, 20 * np.log10(np.sqrt(np.mean(fr ** 2)) + 1e-9), fr))
    in_seg = [(tc, db, fr) for tc, db, fr in rms_all if t0 <= tc <= t1]
    if not in_seg:
        return None
    dbmax = max(db for _, db, _ in in_seg)
    for tc, db, fr in in_seg:
        k = int(np.argmin(np.abs(tv - tc)))
        if not vflag[k] or db < dbmax - 25:
            continue
        F1, F2 = formants_frame(fr)
        rows.append((tc, F1, F2))
    if len(rows) < 3:
        return {"nvoiced": len(rows)}
    F1 = np.array([r[1] for r in rows]); F2 = np.array([r[2] for r in rows])
    F1, F2 = F1[~np.isnan(F1)], F2[~np.isnan(F2)]
    return {"F1_p80": float(np.percentile(F1, 80)), "F2_p10": float(np.percentile(F2, 10)),
            "F1_med": float(np.median(F1)), "F2_med": float(np.median(F2)),
            "nvoiced": len(rows), "t0": t0, "t1": t1,
            "track": [(round(a, 3), round(b, 0), round(c, 0)) for a, b, c in rows]}


def target_token(words, ch):
    """最后一个以 ch 开头的 token（句末那个字）。"""
    hits = [w for w in words if w["w"].startswith(ch)]
    if not hits:
        raise KeyError(f"找不到 {ch}: {[w['w'] for w in words]}")
    return hits[-1]
