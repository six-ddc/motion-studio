# 三个产出文件：字段说明与填写要点

目录：docs/brief.md（调性换算成数）· docs/mechanism.md · docs/shotlist.md（json 字段、镜头功能 `role`、人看的部分）· docs/style_guide.md

空模板在 `assets/` 里，只有占位符，刻意不给可以照抄的画面（示例画面会被当成默认值抄走）；案例只放在 `references/mechanism.md`，正反成对。
`new-film.mjs --recipe explainer` 直接从本 skill 的 `assets/` 拷贝这三份（只替换标题占位符），字段说明以本目录为唯一来源。手动拷贝：`cp <film-story>/assets/{mechanism,shotlist,style_guide}.md films/<slug>/docs/`

## docs/brief.md：定位与调性换算成数

除了主题、画幅、时长，brief 先写清三项传播前提（方法见 `references/creator-playbook.md`）：**传播目的与平台语境**（信息流被动刷到还是主动点播，主攻转发、收藏还是转化 CTA）、**受众起点与常见误区**（已知什么、错信什么、痛点在哪）、**说话姿态（人设）**（对应 `film-narration` 的选音色与语气）。

调性写的是形容词（高级、克制、干净、有劲、活泼、电影感……），实现只认数字。brief 的 LOOK / MOTION 两栏把每个形容词换算成**本片的**维度和数值（镜头拆分归 `shotlist.md` 或 `beats.md`，不在 brief 里重复维护）；下表只列"该量哪个维度"，**不给取值**，因为同一个"高级"在水墨片和霓虹片里对应的数可能正好相反。

| 栏 | 写哪些维度 |
|---|---|
| LOOK | 色（hex，以及哪个颜色承载主变量或焦点）、字体、字号（原生 px）、字距、阴影（偏移、模糊、不透明度）、颗粒或噪声百分比、留白占画面的比例 |
| MOTION | 缓动按角色命名（入、出、强调）并写出曲线；时长以帧为单位；弹簧写阻尼比；同屏同时运动的元素数量上限；次要运动相对主运动的幅度与延迟 |

写完后回读：每个形容词都至少能对应到一个数，才算换算完成。数值写进 style_guide 的「视觉」「运动」两节，能被机器读取的写进 critique 块。

## docs/mechanism.md

记录本片的视觉主轴（连续变量映射，或冲突/反差/证据弧线）、前 3 秒钩子与留存思路，以及可选的方案比选。选定机制的状态变量由作者写入 `shotlist.md` 的 `curves`；台词定稿直接维护在 `script.json`（唯一真相源，不在 mechanism.md 重复维护第二份全文）。只有 `film.json` 的 `checks` 声明了 `divergence` 时，`check_shotlist.py` 才会检查本文件里的「讲法」比选留痕（`references/divergence.md` §1、§5）。

## docs/shotlist.md

由一个 ```json 块（机器可读的 spec）加上给人看的段落组成。`check_shotlist.py` 解析的是**第一个 ```json 块**，不要在它前面放别的 json 块。

### json 字段

```jsonc
{
  "pads": {"settle": 0.4, "xfade": 0.3},     // 具名时间常量（锚点 +pad / -pad 或 overlap 引用）。唯一允许写秒数的地方；片头/片尾留白不在这里
  "overlap": 0,                              // 可选：相邻镜头默认允许的最大交叠秒数（数字或 pads 名），配合转场交接
  "shots": [                                 // 按状态阶段或叙事换挡切镜
    {"id": "裂", "from": "s3.start", "to": "s4.start",
     "overlap": "xfade",                     // 可选：本镜与上一镜允许的最大转场交叠（数字或 pads 名）
     "does": "画面在做什么", "mech": "状态变量或焦点怎么变", "handoff": "怎么交给下一镜",
     "carry": "墨团",                         // 可选：交到下一镜时谁活下来（锚点名或一句话）。check_shotlist 不校验它
     "role": "proof"}                         // 可选：这一镜在叙事里干什么（字符串或数组，词表自定）。见下「镜头功能」
  ],
  "curves": {                                // 状态曲线（无连续变量的片子可按需只写要验证的曲线）
    "年份": {"keys": [["s1.start", 618], ["s3@裂痕", 755], ["s3.end", 757], ["s5.end", 907]]},
    "墨量": {"of": "年份", "keys": [[618, 0.16], [741, 1.0], [755, 0.96], [757, 0.46], [907, 0.05]]},
    "灯数": {"source": "scene", "keys": [["s3@轻", 0], ["s4.start", 2]]},   // 仿真推出的量：keys 只是意图，可省
    "红灯像素": {"source": "pixels", "pixels": {"r": [170, 255], "g": [0, 85], "b": [0, 85], "stat": "count"}}
  },
  "segments": [                              // 重要叙事区间：脚本量它实际拿到几秒
    {"label": "安史之乱", "curve": "年份", "range": [755, 757], "weight": 3}
  ],
  "claims": [                                // 旁白对画面状态的断言：脚本在实测区间逐毫秒验证
    {"line": "s5", "says": "纸上只剩一点余墨", "curve": "墨量", "op": ">", "value": 0},
    {"span": "rule", "says": "语义区间断言", "curve": "墨量", "op": "falling"}
  ],
  "keyframes": [                             // 静帧闸门截哪几帧
    {"at": "s2@宫阙", "read": "这一帧要读出什么"}
  ]
}
```

（值只用来说明字段，不是推荐画面。）

- **锚点**：`start` `end`（= vo.end + film.json `narrationTail`）`vo.end` `s3` `s3.start` `s3.end` `s3@词` `s3@词.end` `s3@词#2` `span:<id>` `span:<id>.end`（对应 `script.json` 里的 `[@id]…[@/id]`），后面可以接 `+pad` `-pad`。写数字字面量会报错。`s3@词` 匹配忽略大小写与标点，且要求落在 `narration.json` 的词边界上（与 `narration.js` 的 `vo.at()` 行为一致）。
  所有锚点都是**成片时间**：句子或词的时刻等于 narration.json 里的秒数加上 film.json 的 `narrationOffset`。
- **转场交叠（`overlap`）**：默认要求镜头不重叠；当使用叠化、擦除或 `sequence(..., { overlap })` 需要前后两镜短暂共存时，可在顶层或后一镜上声明 `"overlap": <秒数或 pad 名>`，未超限的交叠通过，超限或未声明的重叠报错。
- **片头片尾留白统一以 film.json 为准**（`narrationOffset` 是片头留白，`narrationTail` 是片尾留白；film-narration 读的也是这两处）。shotlist 里写的 `vo_offset` / `pads.tail` 只用于交叉检查：和 film.json 不一致会直接报错；film.json 没写 `narrationTail` 时，退回使用 `pads.tail`，并提示迁移到 film.json。
- **curves**：没有 `of` 的曲线，钉点以锚点为横坐标（从时间映射到值）；有 `of` 的曲线，钉点以另一条曲线的值为横坐标（从值映射到值）。脚本按线性插值求值；实现时可以换成别的缓动，但**钉点值不能变**。
- **curves.source**：`curve`（默认）/ `scene`（`window.probe(t)`）/ `pixels`（截帧数像素，要写 `pixels` 规格）/ `anchor`（`window.anchors(t)`，写 `"anchor": {"name": 锚点名, "stat": "cx"|"cy"|"w"|"h"}`，
  取值是画面比例 0..1，可以越界；语义见 film-core `references/runtime.md` §6）。后三种的 `keys` 只表示意图，可以省略，画面实测由 film-critique 的 `check.mjs` 完成；各自验什么、怎么选，见 `references/claims.md`。
  `pixels` 规格：`{"near": "#rrggbb", "tol": 40}` 或 `{"r": [lo,hi], "g": [lo,hi], "b": [lo,hi]}`，
  `stat` 取 `count`（匹配的像素数）、`cx` `cy`（匹配像素的质心，画幅比例 0..1）或 `motion`（与前一帧相比发生变化的像素占比），可选 `region: [x0,y0,x1,y1]`（比例坐标）。
- **segments**：`weight ≥ 2` 的区间，如果屏幕时长低于下限（`--floor`，默认 1.0s；顶层可设 `"floor"`，每条也可单独写 `min`）就报错。
- **claims.op**：`> >= < <= ==`（区间内每一刻都成立）；`rising` `falling`（**只比较首尾**：`0,0,0,…,0,5` 也算 rising）；`steady`（变化量不超过 `tol`，默认 0.02）。
  旁白说的是"正在发生"时，再补一条水平断言（`>= 某值`）；如果区间开头或结尾有至少 20% 的时长值没有变化，脚本会提醒。可以用 `"span": [锚点, 锚点]` 或 `"span": "<语义区间id>"` 代替 `line`，只对局部区间做断言。
- 每句旁白都必须被镜头覆盖，否则报错。

### 镜头功能（可选 `role`）

给镜头标注它在叙事里承担什么作用。示例词如下（**不是枚举**，可以自定义，也可以一镜标多个，如 `["proof", "MG"]`）：`hook` 开场抓停；`context` 交代（谁、在哪、演示什么）；`proof` 证据（让旁白的断言在画面上成立）；`B-roll`（具体动作、物件、情绪对位）；`screen` 录屏或界面（字面细节要紧）；`MG` 动态图形（镜头拍不出的结构、累积、变换）；`cta` 收尾转化引导。

写了 `role` 之后，`check_shotlist.py` 的时间表会多出一列"功能"，并按屏幕时长打印各功能的占比（**只是信息，不判 FAIL**）：如果全是 `context`/`B-roll`、几乎没有 `proof`，多半说明画面只是在配图。证据镜头的代价是要把断言做成可见的状态变化；值得付这个代价的，是旁白在做**断言**（变快、变少、坍塌）的那几句。

**人看的部分**：时间表放在 `<!-- timeline:begin -->` / `<!-- timeline:end -->` 之间，由 `--write` 生成（正文里手写 `1.6–4.2` 这类秒数，脚本会警告）；镜头设计、关键帧剪影描述与形似风险、交棒各写一节（镜头设计的六项见 `references/cinematography.md` §1）。

## docs/style_guide.md

模板各节的注释就是填写说明。机器会读取的部分：**视觉方向**和**近作对照**（`siblings.mjs` 读取选定方向；声明了 `checks.divergence` 时由 `check_shotlist.py` 检查，见 `references/divergence.md` §2–3、§5）；**自检打分项**（film-critique 会读取本片声明的标准）。叙事区间下限若不同于默认 `1.0s`，同步写入 `shotlist.md` json 顶层的 `"floor"` 字段以便验收自动生效。
