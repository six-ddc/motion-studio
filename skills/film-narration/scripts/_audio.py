"""音频测量的共用小件：ffmpeg 解码、短窗 RMS、频带占比与频谱质心、成片 true peak。

music.py（合成完自测）和 audiocheck.py（声音质量门）共用同一份口径，两边报的数才能对上。
只依赖 numpy + 系统 ffmpeg/ffprobe；不 import librosa（门要快、要少依赖）。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import numpy as np

SR = 48000
LOW_HZ = 400       # "闷"的分界：tencent-5y 实测成片 <400 Hz 占 81.6%（用户嫌闷），改亮后 v2 见 review_log
HIGH_HZ = 2500     # "亮"的分界：起音、齿音、镲所在


class NoAudioStream(RuntimeError):
    """文件能读，但里面没有音轨（例如只合了画面的 mp4）。调用方按"输入不全"处理，不当崩溃。"""


def decode(path: str | Path, sr: int = SR, mono: bool = True) -> np.ndarray:
    """任何 ffmpeg 能读的文件（wav/mp4/m4a/mp3）→ float32。mono=True 返回 (n,)，否则 (n, 2)。
    没有音轨抛 NoAudioStream，其他解码失败抛 RuntimeError。"""
    ch = 1 if mono else 2
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", str(ch), "-ar", str(sr),
                        "-f", "f32le", "-"], capture_output=True)
    if p.returncode != 0:
        # -vn 之后一条流都不剩 = 没有音轨（ffmpeg 报 "Output file does not contain any stream"）
        if "does not contain any stream" in p.stderr.decode(errors="replace"):
            raise NoAudioStream(f"{path} 没有音轨")
        raise RuntimeError(f"ffmpeg 解码 {path} 失败：{p.stderr.decode(errors='replace').strip()[:200]}")
    x = np.frombuffer(p.stdout, dtype=np.float32)
    return x if mono else x.reshape(-1, 2)


def probe_durations(path: str | Path) -> dict:
    """{format, video, audio}：容器 / 视频流 / 音频流时长（秒，没有的流为 None）。"""
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,duration",
                        "-of", "json", str(path)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffprobe 读不了 {path}：{p.stderr.strip()[:200]}")
    j = json.loads(p.stdout)
    out = {"format": float(j.get("format", {}).get("duration") or 0) or None, "video": None, "audio": None}
    for s in j.get("streams", []):
        if s.get("codec_type") in ("video", "audio") and s.get("duration") and out[s["codec_type"]] is None:
            out[s["codec_type"]] = float(s["duration"])
    return out


def db(x: float) -> float:
    return float(20 * np.log10(max(x, 1e-12)))


def rms_db(x: np.ndarray) -> float:
    return db(float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))) if len(x) else -240.0


def window_rms_db(x: np.ndarray, sr: int = SR, win: float = 0.05) -> np.ndarray:
    """每 win 秒一个不重叠窗的 RMS（dBFS）。"""
    n = int(win * sr)
    k = len(x) // n
    if k == 0:
        return np.array([rms_db(x)])
    m = np.sqrt(np.mean(np.square(x[:k * n].reshape(k, n), dtype=np.float64), axis=1))
    return 20 * np.log10(np.maximum(m, 1e-12))


def band_stats(x: np.ndarray, sr: int = SR, gate_db: float = -60.0) -> dict:
    """功率谱口径：4096 点 Hann、半重叠，只累计 RMS ≥ gate_db 的帧（静音不拉低质心）。

    返回 centroid（Hz，功率加权平均频率）、low（<400 Hz 功率占比）、high（>2.5 kHz 占比）、frames（参与的帧数）。
    量的是"能量落在哪"，不是"听着亮不亮"：一声很响的低频撞击能把整段的 low 拉满，而耳朵记住的可能是上面的镲。
    """
    n, hop = 4096, 2048
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    k = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(k)[:, None]
    fr = x[idx].astype(np.float64)
    keep = 20 * np.log10(np.maximum(np.sqrt(np.mean(fr ** 2, axis=1)), 1e-12)) >= gate_db
    if not keep.any():
        return {"centroid": None, "low": None, "high": None, "frames": 0}
    spec = np.abs(np.fft.rfft(fr[keep] * np.hanning(n)[None, :], axis=1)) ** 2
    p = spec.sum(axis=0)
    f = np.fft.rfftfreq(n, 1 / sr)
    p[0] = 0.0                                    # 去直流
    tot = p.sum()
    if tot <= 0:
        return {"centroid": None, "low": None, "high": None, "frames": int(keep.sum())}
    return {"centroid": round(float((f * p).sum() / tot), 1), "low": round(float(p[f < LOW_HZ].sum() / tot), 4),
            "high": round(float(p[f > HIGH_HZ].sum() / tot), 4), "frames": int(keep.sum())}


def loudness(path: str | Path) -> dict:
    """ffmpeg loudnorm 第一遍的实测：I（LUFS）、tp（dBTP，两位小数——和 mux.sh 的成片真峰门同一口径）。"""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af", "loudnorm=print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"\{[^{}]*\"input_tp\"[^{}]*\}", p.stderr, re.S)
    if not m:
        raise RuntimeError(f"loudnorm 量不出 {path} 的响度/真峰")
    j = json.loads(m.group(0))
    return {"I": float(j["input_i"]), "tp": float(j["input_tp"]), "lra": float(j["input_lra"])}
