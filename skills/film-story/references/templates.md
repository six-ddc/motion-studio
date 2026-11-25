# 可选文档与 shotlist.md 规格

全部文档按需选用，不强求每支片都建齐。

## docs/style_guide.md & docs/brief.md（按需）

- **`docs/style_guide.md`**：只需半页写清本片真正作数的约定——画幅/时长/用户硬要求、比稿选定方向、色板与字级、呈现路线（2D/3D/HTML/混合素材）、3–5 个冲击点、声音人设与本片拒绝项。需要脚本机读校验时再加 ` ```critique ` JSON 块（见 `film-critique` `references/checks.md` §3）。
- **`docs/brief.md`**（大型或复杂项目可选）：把“高级/克制/有劲”等形容词换算成本片具体的色值、字号、留白、缓动与同屏动效上限。
- **`docs/mechanism.md`**（复杂科普片可选）：记核心视觉机制与状态变量；台词全文只维护在根目录 `script.json`，不写两份。

## docs/shotlist.md（严格音画对账时用）

`check_shotlist.py` 解析首个 ` ```json ` 代码块（前面不要放别的 json 块）：

```jsonc
{
  "pads": {"settle": 0.4, "xfade": 0.3},        // 具名时间常量（唯一允许写秒数处；留白写 film.json）
  "overlap": 0,                                 // 可选：默认相邻镜头最大转场交叠秒数或 pad 名
  "floor": 1.0,                                 // 可选：weight>=2 叙事区间最短屏幕秒数
  "shots": [
    {"id": "裂", "from": "s3.start", "to": "s4.start", "overlap": "xfade",
     "does": "画面动作", "mech": "焦点变化", "handoff": "交棒方式", "carry": "共享元素", "role": "proof"}
  ],
  "curves": {
    "年份": {"keys": [["s1.start", 618], ["s3@裂痕", 755], ["s3.end", 757]]},
    "墨量": {"of": "年份", "keys": [[618, 0.16], [755, 0.96], [757, 0.46]]},
    "灯数": {"source": "scene", "keys": [["s3@轻", 0], ["s4.start", 2]]},
    "红灯": {"source": "pixels", "pixels": {"r": [170, 255], "g": [0, 85], "b": [0, 85], "stat": "count"}}
  },
  "segments": [{"label": "安史之乱", "curve": "年份", "range": [755, 757], "weight": 3}],
  "claims": [
    {"line": "s5", "says": "纸上只剩一点余墨", "curve": "墨量", "op": ">", "value": 0},
    {"span": "rule", "says": "语义区间断言", "curve": "墨量", "op": "falling"}
  ],
  "keyframes": [{"at": "s2@宫阙", "read": "关键帧要读出什么"}]
}
```

- **锚点语法**：`start` `end`（=`vo.end + narrationTail`）`vo.end` `s3` `s3.start` `s3.end` `s3@词` `s3@词.end` `s3@词#2` `span:<id>` `span:<id>.end`，可接 `+pad` / `-pad`；手填数字字面量报错。所有时刻均为成片时间（自动含 `film.json` `narrationOffset`）。
- **curves.source**：`curve`（默认钉点插值）/ `scene`（`window.probe(t)`）/ `pixels`（截帧像素统计，`near`/`r,g,b` + `stat: count|cx|cy|motion` + 可选 `region`）/ `anchor`（`window.anchors(t)`，`{"name": …, "stat": "cx"|"cy"|"w"|"h"}`）。后三种由 `film-critique` `check.mjs` 实测（详见 `references/claims.md`）。
- **claims.op**：`> >= < <= ==`（全程成立）；`rising` / `falling`（仅比首尾，需“正在发生”则补水平断言）；`steady`（波动 ≤`tol`）。支持 `"span": [锚点, 锚点]` 或 `"span": "<语义区间id>"`。
- **可选 `role`**：标注镜头叙事功能（如 `hook`/`context`/`proof`/`B-roll`/`screen`/`MG`/`cta`），`check_shotlist.py --write` 会在 `<!-- timeline:begin -->`…`<!-- timeline:end -->` 写出时间表与占比提示。
