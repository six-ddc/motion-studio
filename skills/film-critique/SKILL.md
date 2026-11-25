---
name: film-critique
description: 代码渲染影片（films/<slug>/）的视觉自检、比稿拼图与质量评审：风格帧比稿（--entries）、静帧闸门（stills）、转场拼图（transitions）、成片对照图（接触表 contact / 连续帧 strip / 手机尺寸 phone / 循环接缝）、客观脚本检查（check.mjs：音画流、字号与对比度、死拍、遮挡出画、分镜断言、运动读数）、按本片 style_guide 判机读法律，以及陌生人盲审视角。用户说看看效果、比稿、出几张静帧、渲出来检查一下、自检、评审、挑问题、哪里不对、有点平、廉价感、像PPT、缓动太硬、镜头不够变、卡点不准、接触表、review，以及写完代码要渲、渲完要交付之前加载。只指出问题和证据帧，修法归各能力 skill；不替人强加默认审美。
---

# film-critique

把代码和 MP4 变成**看得见的静帧/对照图**和**可机检的数字**，在不强加固定审美的前提下，帮作者和用户尽早抓出 bug、平庸与廉价感。

## 诚实性边界与三层检视

模型看静帧可靠、听声音和看微动感不可靠——**没看过的动态与听觉项不要假装通过，主观审美与音色最终由人确认**。

| 层 | 做什么 | 谁来判 |
|---|---|---|
| **1. 客观硬项** | 时长、字体、可读性、遮挡出画、对点、死拍、运动读数（`check.mjs`，按 `film.json checks` 声明开启） | 脚本（FAIL 是 bug，LOOK 是疑点） |
| **2. 陌生人盲审** | **忘掉代码和意图**，以第一次刷到视频的陌生观众视角审图与小样（见下节） | 模型（或独立评审子代理）+ 人 |
| **3. 本片法律** | 本片 `docs/style_guide.md` 里的约定（含可选 ` ```critique ` 机读 JSON 块）与冲击点核对 | 机读项脚本判，感知项人判 |

## 一、比稿、静帧与转场拼图（渲整片前先看图）

```bash
# 风格帧比稿：动手写整片前，2–3 个方向各画一帧拼 out/lookdev.png 给用户拍板
node <film-critique>/scripts/stills.mjs --film <slug> --entries look/a.html,look/b.html,look/c.html [--at 0.1,0.9]

# 静帧闸门：写完场景先抽关键时刻（不给 --at 则取 MARKS 中点或均匀 5 点）
node <film-critique>/scripts/stills.mjs --film <slug> [--at 1.2,4.5,8.8,14.5] [--entry x.html]

# 转场拼图：每个剪辑点/转场窗口取 前·入·中·出·后 5 帧（专抓转场中段破绽）
node <film-critique>/scripts/transitions.mjs --film <slug> [--cuts 3.2,8.0-8.4 | --scan]
```

**必须用 Read 真正打开产出的 PNG 查看。** 静帧看不出缓动和节奏——多镜头或动效重的片子，务必跑一次 `render.mjs --draft` 快速小样（必要时截关键片段交给用户或视频理解能力看动态手感），再用 `contact.sh` 出对照图：

```bash
bash <film-critique>/scripts/contact.sh --film <slug> [特写起点秒]   # 产出 *-contact.png / *-strip.png / *-phone.png / *-loop.mp4 / *-poster.png
```

## 二、陌生人盲审（对抗“做浅”和作者自证偏差）

脚本全绿只说明片子没坏，不说明好看。对着 `stills.png`、`transitions.png`、`*-phone.png`（必要时派一个**不读 `scene.html` 和策划文档**的独立子代理来盲看），残酷回答四个问题：

1. **不看脚本，单看画面你以为这支片在讲什么？** 有没有元素在小图上被误读成脸、齿轮或奇怪符号（`references/tendencies.md` T7/T8）？
2. **哪一帧显得廉价、像课件/PPT 模板？**（眯眼看拼图检查构图与景别有没有变化：是否全员同一种淡入、整片正面平铺不动、无层次平涂、信息挤成一团）
3. **观众最可能在第几秒划走？为什么？**（前 2 秒是否足够抓人？中段有没有无意义的静止平台期？）
4. **冲击点真的成立吗？** 对照 `style_guide.md` 里的 3–5 个冲击点，逐一抽帧确认分量够不够、有没有被字幕或别的元素抢戏。

发现“没想过的默认偷懒”直接修，顺手补一条进本片 `style_guide.md` 的「本片拒绝」即可。

## 三、客观检查（`check.mjs`，按声明开启）

```bash
node <film-critique>/scripts/check.mjs --film <slug> [--mp4 films/<slug>/out/final-9x16.mp4] [--strict] [--workers N]
```

只在 `film.json` 的 `checks` 里显式声明了对应 ID 时才运行（完整 ID 口径、阈值与局限见 `references/checks.md`）：
- **常规客观项**：`narration` `mp4` `truepeak` `loop` `readability` `contrast` `facts.screen` `style-guide` `laws` `still` `empty` `cover` `marks` `claims` `tilt` `page` `legible`
- **只报 LOOK（永不拦交付）**：`continuity` `rhythm` `motion` `variety` `beatsync` `hook` `mute`

场景按需配合的通道（不声明对应检查则无需写）：`window.MARKS`（关键事件与 `hold: "<理由>"` 豁免 LOOK）、`window.probe(t)`（仿真状态曲线）、`window.anchors(t)`（空间锚点，见 `film-core/references/runtime.md` §6）。
`docs/style_guide.md` 可放 ` ```critique ` JSON 块配置 `palette`、`max_still`、`min_text_src_px`、`view_width`、`ortho_ok` 及机读 `laws[]`（`pixels` / `occlude` / `inframe`），详情见 `references/checks.md` §3。

## 四、轻量记录与迭代

只在多轮修改或跨会话交接时，把关键结论简记进 `docs/review_log.md`（几行写清：**看了哪些图、发现了什么、改了什么、哪些主观项未经人眼确认、下一轮先读**），不必每轮填长表。需要确认派生图是否过期时跑 `node <film-critique>/scripts/fresh.mjs --film <slug>`。

- 优先级：页面报错与确定性 > 时长与音画对点 > 可读性与画面穿帮 > 审美质感与节奏。
- 症状该回哪个环节修见 `references/attribution.md`；倾向性自查清单（T1–T9）见 `references/tendencies.md`；采样与新鲜度规则见 `references/sampling.md`。
