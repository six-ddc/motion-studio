# examples/：从套件里退出的效果实现

这里是以前放在 skill 里的效果模板：转场库、缓动表、形状变形、图表、文字特效、仿真预设、手感预设、
三维天空/地面/表面/模型/粒子/后期/相机封装、着色器模板。2026-11 起它们不再属于套件：

- **不随 skill 安装**，任何 skill 文档都不引用它们，也没有任何门或测试依赖它们。
- **不维护、不保证能跑**。服务器的 `/runtime/*` 只找片内 `runtime/` 和 `skills/film-*/assets/runtime/`，不找这里。
  要在一支片子里用某个文件，把它（连同它 import 的同目录文件）拷进 `films/<slug>/runtime/`，它就和片子自己写的代码一样。
- 留着是给人翻的：里面有实测过的写法和踩过的坑，git 历史和 `docs/verified/` 里有当时的测量记录。

为什么拿出来：skill 应该给方向、方法论和硬约束（`seek(t)` 纯函数契约），把需求说清楚，
而不是提前写好一套效果让模型挑函数、调参数——那样做出来的片子长得都一样，也把模型限制在模板的参数空间里。

| 目录 | 内容 |
|---|---|
| `runtime/<原 skill>/` | 原运行时文件（文件间的相对 import 保持原样；`rand.js` `motion.js` `events.js` 等仍在 film-core） |
| `fixtures/` | 原来只为测这些模板存在的夹具 |
| `dev/` | 原来只为这些模板服务的基准 / 调试脚本（文件名里的 `__` 是原路径分隔） |

还在套件里的是管线和"自己写极易写错"的基础件：film-core 的运行时（rand、motion、layout、anchors、events、content），
film-physics 的 `replay.js` / `baked.js` / `timemap.js`（检查点重放），film-webfx 的 `webfx.js` / `fxchain.js` / `stage3d.js` 和 three-film，
film-typography 的 `text.js`（字体加载与断行），film-narration 的旁白时间读取和音效合成。

`films/forge/runtime/` 和 `tests/fixtures/{_test-3d,_test-fxchain,_test-events,_test-typography}/runtime/` 里各有一份它们用到的文件副本：
forge 是这些模板写成的片子；那几个夹具是内核门的阴性/阳性对照，模板只是它们的场景内容。
