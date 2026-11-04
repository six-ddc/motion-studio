#!/usr/bin/env python3
"""把一首曲子测成节拍栅格，供画面和音效读取。先测量，再让画面迁就测量结果。

用法（任意 cwd）:
    python beats.py --film <slug> --track assets/music.wav     # -> out/beats.json

输出字段:
    bpm        估计速度（librosa 对 rubato/无鼓点的曲子会不准，看 confidence 和听）
    beats      每一拍的时刻（秒）
    downbeats  按 --meter 每 N 拍取一拍的近似小节首拍（librosa 不做真正的小节检测，
               第一拍不是强拍时整体错位，用 --downbeat-offset 修正）
    hits       起音峰值，音效对齐用
用法建议是词汇表不是法律：状态变化放 beats、大动作放 downbeats、音效放 hits 是一种组织方式，
代价是画面会被音乐「牵着走」；旁白主导的片子通常让旁白关键词优先，音乐只做底。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
from film import parser, resolve_film, need_file, out_dir, rel, die  # noqa: E402


def main() -> None:
    ap = parser(__doc__)
    ap.add_argument("--track", required=True, help="音乐文件，相对片子目录或绝对路径")
    ap.add_argument("--meter", type=int, default=4)
    ap.add_argument("--downbeat-offset", type=int, default=0)
    args = ap.parse_args()
    try:
        import numpy as np
        import librosa
    except ImportError as exc:
        die(f"缺少依赖 {exc.name}：.venv/bin/pip install numpy librosa soundfile")

    film = resolve_film(args.film, args.films_dir)
    track = Path(args.track)
    track = track if track.is_absolute() else film / track
    need_file(track, "")
    y, sr = librosa.load(str(track), sr=None, mono=True)
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beats = librosa.frames_to_time(frames, sr=sr).round(3).tolist()
    if len(beats) < 4:
        die(f"只测到 {len(beats)} 拍，这段音频可能没有稳定节拍（氛围乐/人声？），别硬套栅格")
    envelope = librosa.onset.onset_strength(y=y, sr=sr)
    peaks = librosa.util.peak_pick(envelope, pre_max=3, post_max=3, pre_avg=3, post_avg=5,
                                   delta=0.5, wait=10)
    ibi = np.diff(beats)
    grid = {
        "source": rel(track, film),
        "duration": round(len(y) / sr, 3),
        "bpm": round(float(np.atleast_1d(tempo)[0]), 2),
        "confidence": round(float(1 - np.std(ibi) / np.mean(ibi)), 3),  # 拍间隔越稳越接近 1
        "beats": beats,
        "downbeats": beats[args.downbeat_offset::args.meter],
        "hits": librosa.frames_to_time(peaks, sr=sr).round(3).tolist(),
    }
    target = out_dir(film) / "beats.json"
    target.write_text(json.dumps(grid, indent=1) + "\n", encoding="utf-8")
    print(f"✓ {rel(target, film)}  bpm {grid['bpm']}  稳定度 {grid['confidence']}  "
          f"{len(beats)} 拍  {len(grid['hits'])} 个起音")


if __name__ == "__main__":
    main()
