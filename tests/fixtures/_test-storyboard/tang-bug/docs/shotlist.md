# 分镜 · 唐（复现原片 scene.html 的时间映射，用来验证 check_shotlist 能抓到原片的 bug）

曲线照抄 projects/tang-dynasty/scene.html：yearAt() 钉在 s1/s3/s5 开口，fortune() 按年份定义。

```json
{
  "pads": {"lead": 1.2, "tail": 2.8},
  "vo_offset": "lead",
  "shots": [
    {"id": "落墨", "from": "start", "to": "s1.start", "does": "一滴墨落下", "mech": "墨量 0→0.16", "handoff": "—"},
    {"id": "盛", "from": "s1.start", "to": "s3.start", "does": "墨晕开，宫阙从墨里挖出", "mech": "墨量 0.16→0.96", "handoff": "墨团持续"},
    {"id": "裂", "from": "s3.start", "to": "s4.start", "does": "裂痕横过纸面", "mech": "墨量骤降", "handoff": "裂痕不愈合"},
    {"id": "衰", "from": "s4.start", "to": "s5.start", "does": "墨色变淡", "mech": "墨量下降", "handoff": "同一团墨"},
    {"id": "余", "from": "s5.start", "to": "end", "does": "只剩余墨", "mech": "墨量 →0", "handoff": "首帧=末帧"}
  ],
  "curves": {
    "年份": {"keys": [["start", 618], ["s1.start", 618], ["s3.start", 755], ["s5.start", 907]]},
    "墨量": {"of": "年份", "keys": [[618, 0.16], [649, 0.5], [690, 0.58], [713, 0.76], [741, 1.0], [755, 0.96], [757, 0.46], [763, 0.42], [820, 0.3], [875, 0.17], [907, 0.0]]}
  },
  "segments": [
    {"label": "安史之乱", "curve": "年份", "range": [755, 757], "weight": 3},
    {"label": "开元盛世", "curve": "年份", "range": [713, 741], "weight": 2}
  ],
  "claims": [
    {"line": "s4", "says": "此后墨色一路淡下去", "curve": "墨量", "op": "falling"},
    {"line": "s5", "says": "纸上只剩一点余墨", "curve": "墨量", "op": ">", "value": 0}
  ],
  "keyframes": [
    {"at": "s2@宫阙", "read": "三座殿宇从墨里挖出"},
    {"at": "s3@裂痕", "read": "裂痕横过"}
  ]
}
```

原片 shotlist 里写的是 1.6–4.2 这类手填秒数：

| 0.0–1.6 | 一滴墨 |
