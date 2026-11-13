---
name: film-core
description: 用代码做视频的总入口与内核。一支片子是 films/<slug>/ 里暴露 window.seek(t) 的网页，由 Playwright 逐帧截图、ffmpeg 编码成 MP4（可再转 GIF）。本 skill 建骨架（可选配方），给出 seek(t) 纯函数契约和运动基元（弹簧、follow、种子随机、相机、节拍栅格、镜头表组合子）、三画幅布局、空间锚点，负责预览、渲染（并行、缓存、运动模糊、画幅与 fps）、确定性验收 seamcheck、字体来源门、交付 deliver 与验收 accept，并指出其他能力该找哪个 film-* skill。用户说做个视频、生成视频、GIF 动图、做段动画、短片、解说片、科普片、数据故事片、产品演示片、片头、MV、竖版短视频，改一支已有的片子，写或改 scene.html，重渲某几秒、改画幅，排查"两次渲染不一样/成片闪烁/循环接缝跳/每帧截出来一样/CSS 动画或 WAAPI 截图不动"，或交付、验收一支片子时加载，哪怕没提代码、canvas、渲染等词。
---

# film-core：用代码渲染视频的内核

模型不直接产出像素，而是产出**程序**：一个暴露 `window.seek(t)` 的网页。渲染器按帧栅格逐帧调用它并截图，再由 ffmpeg 编码。
好处是时间可以任意跳、可以只重渲 3 秒、可以用上整个前端生态，代价是**一切都必须能按任意 t 精确求值**。
本 skill 负责守住这个代价，并提供让它容易守住的工具。其余能力（转场、着色器、物理、文字、旁白、素材、调研分镜、评审）由可插拔的兄弟 skill 提供。

路径记号：`<core>` 指本 skill 的目录。所有脚本都能从任意工作目录调用，片子根目录依次按 `--films-dir`、`$FILMS_DIR`、从 cwd 向上找到的 `films/` 定位；
只有一部片子时可以省略 `--film`。各脚本的参数用 `--help` 查看。

## 1. 唯一无条件的契约

「契约」指片子页面必须满足、渲染器和各项检查都依赖的那组约定；「内核」就是这组契约加上守住它的工具。「门」指套件登记在案的自动检查，脚本逐道报告通过或失败（§8、§9）。
完整版在 `references/kernel.md`（一页，先读），包括页面契约（`seek` / `DURATION` / `ready` / `#stage` / `USES_WAAPI`）、唯一的规则、
Clip 适配器（Lottie、Pixi、three、p5、CSS 动效、游戏引擎怎么接入）、守契约的门和症状表。一句话版本：

**`seek(t)` 的输出只取决于 t 和加载期确定的常量。** seek 期间不读时钟和随机源（`Date.now`、`performance.now`、无参 `new Date()`、
`Math.random`、`setTimeout`、`setInterval`、rAF），加载期的随机也要用种子，第三方库自带的循环要关掉、改由 t 驱动，字体随片打包。
可以做缓存，但不能有可观测的状态：判断标准是门能不能通过，而不是代码里有没有变量。

其余一切（风格、配方、质量检查）都是可选的。风格与思路见 `references/style-menu.md`（它是菜单，不是规定）。

## 2. 建骨架

配方（recipe）是可选的起步流程：替片子生成文档模板，并在 film.json 里声明要开的检查。

```bash
node <core>/scripts/new-film.mjs <slug>                         # 内核骨架：只生成 film.json 和 scene.html，不写文档、不拷运行时
node <core>/scripts/new-film.mjs <slug> --format 16x9           # 横版；默认是 9x16，忘了指定的话后面的布局全错
node <core>/scripts/new-film.mjs <slug> --recipe explainer      # 解说片配方：生成文档模板，在 film.json 的 checks 里声明检查（已有片子也能补）
node <core>/scripts/new-film.mjs <slug> --recipe visual         # 画面先行配方：镜头节奏先定，声音去贴（宣传片、片头、MV、logo 演绎）
node <core>/scripts/new-film.mjs --list                         # 列出已安装的配方
node <core>/scripts/new-film.mjs <新slug> --from <已有slug>     # 以已有片子为起点另做一支（整支复制）；同一来源出多个版本用 content.json，见 §5b
```

**运行时不拷贝。** scene.html 直接写 `import './runtime/motion.js'`。服务器把 `/runtime/<名>` 解析成片内的 `runtime/<名>`（存在就用它），
否则解析成已安装 skill 的 `assets/runtime/<名>`，这就是「挂载」。用到哪个 skill 的运行时就 import 哪个，建片时不用预先猜。交付时这些文件会被「冻结」，也就是复制进片子目录，之后不再随套件变化。细节和代价见 `references/runtime.md` §2。
要改已有片子就跳过建骨架，先读那支片的 `docs/`，尤其是 `style_guide.md`，审美判据以它为准。新片默认只出静帧或低分辨率小样，用户确认或明确说"直接出"之后才渲终稿并 deliver。人的判断放在两个最便宜的时刻最划算：几个方向各出一帧让用户挑长相，占位形状的粗剪小样让用户定节奏（`film-story/references/lookdev.md`）。改已有片子之前，先比对片子目录的 mtime 和 receipt，
再读上一轮 review_log 里的「下一轮先读」；对话之外发生的改动视为用户的意图，不要覆盖，并向用户说明。手写有名字的效果之前先查 `film-motion/references/effects.md`。

**kit（品牌或系列共享的组件，可选）。** 已经定下来的 logo、主题、token、标准帧放在仓库顶层的 `kits/<名>/`。film.json 写上 `"kits": ["acme"]` 之后
就能 `import './runtime/kits/acme/brand.js'`，它走同一张挂载表在线挂载，交付时冻结进 `runtime/kits/`，收据里记下版本和哈希。kit 不是套件的默认模板，没声明的片子不受影响。契约、kit.json、声明才开的标准帧门见 `references/kits.md`。

## 3. 场景骨架

```html
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>
<canvas id="stage"></canvas>
<script type="module">
import { follow, seeded, spring } from './runtime/motion.js';
import { layoutFromURL } from './runtime/layout.js';

const L = layoutFromURL();                 // 画幅只从 URL ?format= 来
const cv = document.getElementById('stage');
cv.width = L.width; cv.height = L.height;
const c = cv.getContext('2d');

window.DURATION = 2;                       // 有旁白时在 ready 里按 narration.json 实测覆盖
const rnd = seeded(42);                    // 加载时一次取完，seek 里只读
const DOTS = Array.from({ length: 24 }, () => ({ x: rnd(), y: rnd() }));
const SP = spring({ duration: 0.5, overshoot: 0.08 });

window.seek = (t) => {
  c.clearRect(0, 0, L.width, L.height);
  const p = follow(t, [[0, 0], [0.1, 1], [0.95, 0]], SP);
  for (const d of DOTS) {
    const { x, y } = L.place(d.x, d.y + p * 0.1);
    c.beginPath(); c.arc(x, y, L.size(0.03), 0, 7); c.fill();
  }
};
window.ready = (async () => { /* await 字体、图片、narration.json */ })();
</script>
```

**组织长片。** 把时间轴拆成镜头表（§4 的 `sequence()`），seek 里找出覆盖 t 的镜头并传入它的局部时间；区间可以重叠，重叠时两个镜头同时画，用来交棒。
镜头边界从时间的数据来源读取（旁白时间戳、节拍栅格、仿真），不手填秒数。先把 t 映射成一个有意义的量（年份、进度、温度），画面只依赖这个量，能让长片保持可读，代价是调某一秒时要先算出它对应的量。

**seek 可以返回 Promise**（例如等待 `<video>` 的 `seeked` 事件），渲染器会 await 它；代价是每帧多一次往返，能同步就同步。
**CSS/WAAPI 动画**要在加载时逐个 `pause()`，在 seek 里设置 `currentTime`，并声明 `window.USES_WAAPI = true`。不声明的话，截图会把动画拍成终态
（每帧都一样，而且不报错），所以 `openScene` 发现页面有动画却没声明时会直接报错退出。CSS `transition` 没法 seek。

## 4. 运动基元（`runtime/motion.js`、`runtime/rand.js`）

全部是 t 的纯函数，浏览器和 Node 都能 import。

- **`settle(t, stiffness, damping)`**：阻尼振子对单位阶跃（从 0 到 1）的闭式解，任意 t 直接求值，不跑仿真循环。
  调用方真正关心的是"多久停下、过冲多少"，所以用 `spring({ duration, overshoot }) → { stiffness, damping }` 反解参数，反方向用 `springInfo(sp)`。
  `duration` 是一个精确时刻，从这一刻起 |x−1| 永远 ≤ eps（默认是行程的 0.5%）。代价是弹簧没有"准时到达"，停下要多久由物理决定；要正好在某个字念出时停稳，
  就用 `spring({duration})` 反解，或者改用 `norm()` 加手写曲线。过冲放在小物件上读作弹性，放在大面积上读作晃动，放在正文上会影响阅读。
- **`SPRING`** 提供四个起点（实测停止时长和过冲）：snappy 0.39s / 0.8%，default 0.57s / 0%，heavy 1.20s / 0%（过阻尼，尾巴长），playful 0.57s / 16.6%。只是起点，不是推荐值。
- **`follow(t, [[t0,v0],[t1,v1],…], sp)`**：从首值出发，每次变化叠加一个弹簧，中途改目标时速度自然衔接。每次调用的代价是 O(关键帧数)。`pill()` 是让两条边用不同硬度拉伸的现成写法。
- **`seeded(seed)`** 是顺序随机流：在加载时或 seek 内部用固定种子新建一个生成器再取数。如果多次 seek 之间共用一个生成器往下取，就等于跨帧状态（门 2 能抓到）。
  **`hash01(...keys)`** 按索引随机访问，粒子、网格单元、逐帧抖动（`hash01(seed, i, frame)`）用它，增删元素时其他元素的随机值不会错位。
  这两个函数只在 `rand.js` 里实现一次，全套件共用。
- **`camera(t, [[t, zoom, x, y], …], sp)` 和 `applyCamera(ctx, cam, w, h)`**：zoom 在对数空间插值（从 1 到 2 与从 2 到 4 一样快）。相机运动和画面内的运动都用弹簧时，容易让人看晕。
- **`beatGrid(bpm, offset, beatsPerBar)`** 返回 `{ spb, at(beat), bar(n), phase(t), index(t) }`，bpm 和 offset 来自节拍检测（film-narration）。每个事件都卡在拍上会显得机械。
- **镜头组合子**：`sequence([{ name, dur | until }], { overlap, align, marks })` 把镜头表变成 `at(t) → [{ name, local, progress, enter, exit }]`，`until` 可以写旁白时刻、节拍或 `marks` 里的名字；`overlap` 是交棒窗口，两个镜头同时活着。
  `Q.cuts` 直接给 `window.CUTS`，`Q.windows`/`Q.marks` 给 `CUT_WINDOWS`/`MARKS`。`series(durs)` 首尾相接，`loopT` `rate` `freeze` 是局部时间映射。它们只管时间；要转场 kind、缓动和离屏合成，用 film-motion 的 `timeline()`。
- 其他：`sat lerp clamp norm(t, from, to) win(t, start, dur, ease) wrap(t, len) labelAlpha()`。`win` 等于 `ease(sat((t-start)/dur))`，ease 传一个函数（缓动词汇表在 film-motion 的 `choreo.js`，也可以自己写）。
- **事件表（`runtime/events.js`，可选）**：一张 `[{t, type, id?, …}]` 同时驱动光、粒子、镜头和声音——`channel` 把每个事件的响应写成 τ = t − e.t 的闭式函数，
  `throttle` `burstEnds` `snapToFrames` 在加载期对整张表做一次，`toCues` 把同一张表交给 film-narration 出声。帧率读内核注入的 `window.FILM.fps`。见 `references/events.md`。

## 5. 画幅（`runtime/layout.js`）

```js
const L = makeLayout('9x16');   // 或 layoutFromURL()
L.width L.height L.short L.long L.cx L.cy L.tall L.wide L.square L.key
L.place(x, y)    // 把归一化坐标 [0,1] 换算成像素（可以越界，用于出画入画）
L.size(n)        // 短边乘以 n 再取整；同一个 size(0.05) 在三个画幅里视觉重量一致；sizeExact 不取整
L.pad / L.padBy(r)
pick(L, { tall: 0.3, wide: 0.46, square: 0.4 })   // 按画幅挑值
```

`9x16` 是 1080×1920，`1x1` 是 1440×1440，`16x9` 是 1920×1080。**这层换算是手段，不是不变量**：三个画幅共用一条时间线时，值得付出这层换算的成本；
单画幅的片子写死像素也不会渲坏，代价是以后加画幅时要逐处修改。竖版和横版通常需要**不同的构图**，用 `pick()` 分别给坐标，不要硬套同一组。

### 5b. 内容数据层与变体（可选，`runtime/content.js`）

片子根目录放一个 `content.json`（文案槽位、素材、品牌 token、claims、变体维度与矩阵），场景在加载期执行 `const C = await loadContent()`，
画面上的文字一律用 `C.text('槽位')` 取。同一份 scene 换数据就能出几个版本：`render.mjs --variant hook-b.cta-a` 或 `--matrix`
输出 `out/variants/<id>/final-<fmt>.mp4` 和 `manifest.json`，像素相同的分片在变体之间复用。变体只换数据、不改动画，和旁白绑定的文案要标 `locked`。
没有 content.json 的片子行为不变。schema、合并顺序和清单格式见 `references/content-json.md`。

## 6. 空间锚点（`runtime/anchors.js`）

画某个有名字的东西时，在画它的那一行顺手登记它的屏幕框：`A.ctxRect('黄车', ctx, x, y, w, h)` 会读取 ctx 当前的变换，`A.box` 直接接收屏幕像素。
`window.seek = A.install(draw)` 每帧清空登记表，并提供 `window.anchors(t)`。字幕、特效、音效、评审读的是同一张表，看到的也就是同一个位置。锚点只暴露数据，不做布局；坐标归一化，不做裁剪。语义（属于硬约束）、为什么不并进 probe、已知盲区见 `references/runtime.md` §5–6。

## 7. 预览与渲染

```bash
node <core>/scripts/preview.mjs --film <slug> [--format 9x16] [--port 4321]     # 人眼预览：拖动条加播放（rAF 只在播放器里用）
node <core>/scripts/render.mjs --film <slug>                                      # 按 film.json 的设置渲染
node <core>/scripts/render.mjs --film <slug> --scale 0.5 --sub 1 --preset veryfast   # 迭代用小样，输出到 out/draft/（约快 2.3 倍）
node <core>/scripts/render.mjs --film <slug> --from 4 --to 7                      # 只重渲 4–7 秒
node <core>/scripts/render.mjs --film <slug> --all                                # 渲染 film.json formats 里的全部画幅
```

产出是 `out/silent-<format>.mp4`（区间渲染的文件名带区间后缀；小样放在 `out/draft/`，下游挑成片时不会选中它），渲完用 ffprobe 核对帧数和分辨率。
**并行**默认开启，因为帧与帧之间没有依赖。**逐帧哈希清单**让再次渲染时打印"哪些时间段的像素变了"，用来反查一处改动影响到了哪几秒。
**分片缓存**只重新编码像素变了的分片，缓存键里包含挂载运行时的哈希，所以运行时改动一个字节就会全部重编。
**渲染器固定版本**：首次渲染时把浏览器和编码器的指纹写进 film.json 的 `renderer`，之后不一致就警告。全部参数和实测数字见 `references/render.md`。
**渲染后端**默认是软件的 SwiftShader。重着色器、三维的片子可以在 film.json 写 `"backend": "gpu"`，让 WebGL 改走本机硬件 GPU（实测三维截图快 3–4 倍）。代价是像素和软件后端不同，只能在同款显卡上复现，没有 GPU 的机器渲不了，见 `references/render.md`「渲染后端」。
**时长**以 `window.DURATION` 为准；film.json 的 `duration` 只在场景没给出时兜底。
**GIF 动图**要先渲出 mp4 再转，用两遍调色板：`ffmpeg -i out/silent-<format>.mp4 -vf "fps=15,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out/<slug>.gif`（帧率和宽度按体积取舍；GIF 每帧最多 256 色，大面积渐变会出现色带）。

### 运动模糊

每个输出帧 k 在 `[k/fps, (k+shutter)/fps)` 区间内均匀取 `sub` 个子帧求平均。

| 选择 | 代价 |
|---|---|
| `sub=1` 关闭 | 快；快速运动会显得卡顿、频闪 |
| `sub=4` | 渲染时间变成 4 倍；一帧内位移远大于物体尺寸时，会出现 4 个分离的残影，而不是连续的拖影 |
| `sub=8–16` | 拖影连续，渲染时间同比增加；只在快速运动的片段上值得 |
| 场景提供 `window.MOTION(t0,t1)`（自适应） | 快速段拖影连续，静止帧约等于只截 1 张，硬切处（`window.CUTS`）不会混入前后镜头；快速段的截图张数随位移增加 |
| `shutter=0.5`（180°） | 拖影减半，动作更利落；默认值是 1（360°） |

经验判据：子帧之间的位移小于物体尺寸的一半，残影才能连成一片。

## 8. 门：确定性验收

```bash
node <core>/scripts/seamcheck.mjs --film <slug> [--format 16x9] [--samples 8] [--loop|--no-loop]
node <core>/scripts/font_source.mjs --film <slug>          # 检查画出来的字是不是全部来自随片字体
```

| 门 | 抓什么 |
|---|---|
| 1a 同 t 两次 | seek 里读时钟或 `Math.random`、每次调用都在累积状态 |
| 1b 重新加载 | **加载期**的随机或时钟、没等加载完的字体和图片（1a 和 2 都抓不到） |
| 2 乱序求值 | 跨帧状态、缓存回退造成的泄漏 |
| 3 循环接缝 | 首尾不一致，或首尾相等但速度不连续（`loop: true` 时才判，`DURATION` 要写成周期本身） |
| 4 并行（`--parallel N`） | 只在连续求值时才出现的依赖 |
| 5 跨启动（`--relaunch N`） | "那一次渲染本身就坏了"的情况：和上一次 render 的逐帧清单对账 |
| 探针 | 直接点名 seek 期间调用了哪个禁用 API、调了几次（第三方库只为统计读取 `performance.now` 时用 `--probe-warn`，并在 review_log 里写明理由） |

判断依据在截图像素层面，不经过编码器（H.264 的残差噪声让 mp4 的 md5 不可靠）。失败后怎么定位见 `references/nondeterminism.md`（按门索引）；
各道门防住过哪些真实缺陷见 `references/kernel.md` §4–5、§7。多画幅时每个 `--format` 各跑一次。

## 9. 交付与验收

```bash
node <core>/scripts/deliver.mjs --film <slug>          # 依次跑定稿渲染、（重新合流、）门 1–5、fontsrc、uses 门、声明的检查，再冻结并写 receipt.json
node <core>/scripts/deliver.mjs --film <slug> --list   # 先看会跑哪些步骤
node <core>/scripts/accept.mjs                         # 所有片子：有收据就比对输入哈希；没收据记为「未交付」
node <core>/scripts/accept.mjs --deep                  # 把门全跑一遍（不渲染、不冻结）
node <core>/scripts/freeze.mjs --film <slug>           # 只冻结、不跑门：要用外部 dev server 打开片子时用
```

**一支片子"做完了"的唯一定义，是有一份和当前输入对得上的收据 `receipt.json`。** deliver 任何一步变红就停下，不冻结、不写收据。
交付之后片子不再依赖套件的运行时：套件升级不会改变它的像素，也不会修复它的 bug（要修就改完再 deliver 一次）。改了任何输入却没有重新交付，accept 会报红。
**成片要新鲜。** 读取成片 `out/final-<format>.mp4` 的门（verify、critique 的 mp4 检查项）只认和当前无声成片、旁白、音效对得上的那一份，
依据是合流脚本写下的合流记录 `out/.render/final-<format>.mux.json`。定稿重渲之后，deliver 按这份记录经 `capability()` 重放合流（film-narration 的 mux.sh）；
没装那个 skill 就只交付无声成片，过期的成片会让已声明的成片检查变红。从没合流过的片子，deliver 不会替你选混音参数。

门分三层。**内核门**永远开启，就是上面那一组。**用了才开**的门由提供运行时的 skill 在 `gates.json` 里按 `uses` 登记（例如用了重放运行时就跑 physcheck）。
**声明才开**的检查写在 film.json 的 `checks` 里（扁平 id 数组，需要阈值时写成对象：`["shotlist", {"contrast": {"min": 4.5}}]`），
由认领该 id 的 skill 执行；声明了却没装对应的 skill 属于缺能力，判红。格式与全部契约见 `references/api.md`。

## 10. film.json

内核读取 `entry` `format` `formats` `fps`（默认 60）`sub`（默认 4）`shutter` `loop` `duration`（兜底时长）`stage` `crf` `renderer`，
accept 和 deliver 还会读 `checks`。类型、默认值和校验规则见 `references/film-json.md`。其他 skill 的字段原样保留、不做校验；
新增字段放进自己命名空间的对象里，避开上面这些名字。命令行参数优先于 film.json。

## 11. 什么事找谁

能力按职责切分，不按流水线阶段切分；按需读，一支纯排版的片子用不着物理。没装的 skill 用不了，工具会直接提示「缺能力 film-X」。

| skill | 负责什么 |
|---|---|
| film-motion | 2D 动效词汇：缓动表、交错编排、镜头加转场的时间轴、Magic Move、透视相机 camera3d、界面重建、压扁扫描 |
| film-webfx | 着色器、后期、三维（按帧契约改造的 three.js）、SVG 滤镜、混合模式 |
| film-physics | 粒子、重力、碰撞、布料、群集，全部可以 seek（闭式解、定步重放） |
| film-typography | 文字绘制：拆字、可变字体轴、中日韩排版、字幕绘制、小字号可读性 |
| film-narration | 旁白 TTS、字级时间戳、节拍、音效、合流，只输出时间数据 |
| film-assets | 字体、图标、图片、音频的来源与授权，子集化，打包 |
| film-story | 调研与事实核查、视觉机制、讲法与长相的发散、分镜、解说片配方 |
| film-critique | 静帧闸门、对照图、按本片 style_guide 打分、质量检查 |

审美判据的唯一来源是本片的 `docs/style_guide.md`。套件里没有默认配色、默认字体组合、默认转场。
如果你发现自己在按某个 skill 的"推荐做法"而不是按 brief 和 style_guide 做设计决定，那多半是没清理干净的默认审美，代价是这支片子会变成上一支。
片子可以整体采用某个外部设计 skill 的方向，在 style_guide 里写一句采用了谁即可（`references/style-menu.md`）。

## 12. 什么时候不用这整套

- 只要一张静态图：直接用 canvas 画，或者用别的工具。
- 只是剪辑一段现成素材：直接用 ffmpeg。这套管线用来**生成**画面，不是用来剪辑的。
- 改一支已有片子里的三秒：读它的 `docs/`，改完用 `render --from --to` 只重渲那三秒，再 deliver。
- 时长超过两分钟：这套管线在这个长度上验证得少，先拆段分别渲染再拼接，并确认渲染时间可以接受。

## 下层文档

- `references/kernel.md`：内核契约一页版（页面契约、唯一的规则、Clip 适配器、门、症状表、门的来历）
- `references/api.md`：lib 导出签名、capability、gates.json、film.json checks、receipt.json、配方格式，也就是能力 skill 依赖的全部契约
- `references/runtime.md`：片子目录、运行时的挂载与冻结、浏览器版本固定、两种脚本、层间数据通道、空间锚点语义
- `references/render.md`：render / seamcheck / preview 的参数全集、并行、截图、哈希清单、分片缓存、自适应子帧、渲染器版本固定
- `references/film-json.md`：film.json 的 schema 与校验
- `references/content-json.md`：可选的内容数据层 content.json、变体与矩阵导出、变体清单
- `references/events.md`：事件表（多通道响应核、节流、帧对齐、给声音的 cue 桥）
- `references/kits.md`：可选的 kit（品牌或系列共享组件库）：挂载、冻结与收据、kit.json、标准帧自检
- `references/nondeterminism.md`：常见的非确定性来源，按失败的门索引
- `references/style-menu.md`：风格与思路菜单（外部设计 skill、做片思路、游戏思路、Lottie）

## 渲染前预检、平台档位、已知的坑

```bash
node <core>/scripts/preflight.mjs --film <slug> [--variant <id>]   # 几秒跑完：检查素材、字体、槽位溢出、画面代码、变体残留、宣传数据出处；有 ✗ 时 exit 1
node <core>/scripts/deliver.mjs --film <slug> --phone              # 只转码：生成 ≤30MB、720p 的手机预览 out/phone-<format>.mp4
node <core>/scripts/deliver.mjs --film <slug> --compare <旧.mp4>   # 生成旧版与新版的对比片，只带新版音轨（可加 --phone）
```

preflight 是声明才开的检查（在 film.json 的 `checks` 里写 `"preflight"`，render 渲染前会先跑它），见 `references/preflight.md`。
门红了而原因不在契约字面上时（mipmap 色阶、上下文状态、光栅滞回、x264 线程、开场无声……），查 `references/pitfalls.md`。
