# 内核契约：唯一无条件的那一层

**先读这一页。** 本页写的是做任何一支片子都绕不开的技术契约。其余内容都是可选的能力或配方，
包括各 `film-*` skill 的运行时与工具、配方（如解说片）、风格与思路菜单（`style-menu.md`），
用不用、用哪个，由片子自己决定。

目录：1 页面契约 · 2 唯一的规则 · 3 Clip 适配器 · 4 守契约的门 · 5 症状表 · 6 不在这里的东西（各门的实测来历在仓库 docs/verified/film-core.md）

收录标准只有一条：**不遵守就会让片子渲坏（闪烁、错帧、白帧、换机器后字形改变）的规则，才写在这里。**
"该怎么拍""该写哪份文档"都不在本页范围内。

> 非契约的门（分镜对账、发散留痕、可读性、对比度、事实对账、念读核验……）**只有片子在 film.json `checks` 里声明了才会打开**，
> 声明之后按原有的严格度判定；只对某些运行时才有意义的门（物理重放、纹理缓存……）**在片子用到对应运行时时才打开**。
> 这两类门都由提供它的 skill 在自己的 `gates.json` 里登记（格式见 `api.md`）。只遵守本页契约的片子把 `checks` 留空为 `[]`，
> 验收时只跑第 4 节那组内核门。

---

## 1. 页面契约

一支片子就是一个网页。渲染器（Playwright 逐帧截图，再用 ffmpeg 编码）只认下面这几样：

| 名字 | 必需 | 含义 | 不遵守的后果 |
|---|---|---|---|
| `window.seek(t)` | 是 | 画出第 t 秒的那一帧，可以同步返回，也可以返回 Promise | 15 秒内没有出现，渲染器报错退出 |
| `window.DURATION` | 是（或由 film.json `duration` 兜底） | 片长，单位为秒 | 无法确定总帧数 |
| `window.ready` | 有异步资源时必需 | 一个 Promise，表示字体、图片、JSON、wasm、库初始化全部就绪 | 加载期间没等加载完的资源，只有门 1b 能发现 |
| `#stage` | 是（选择器可以在 film.json `stage` 里修改） | 被截图的那个元素，canvas 或 div 都可以 | 找不到时报错 |
| `window.USES_WAAPI = true` | 页面上有 CSS/WAAPI 动画时必需 | 渲染器每次 seek 后把动画设为 `playbackRate = 0`。**`currentTime` 由场景在 seek 里自己设置** | 不声明会直接报错；声明了但不设置 `currentTime`，动画会按真实时间播放 |
| `window.FILM` | 内核提供，场景只读 | 页面任何脚本执行前注入的冻结对象 `{ fps, width, height, format, scale }`：这次渲染/检查实际用的帧率（含 `render --fps` 覆盖、门 5 按清单重渲的 fps）与画幅布局尺寸；`scale` 是截图缩放，只在 `render --scale` 小样里 < 1，场景**可以**据此少画像素（布局不变），定稿、门 1–4、deliver 恒为 1。render、seamcheck、preview、fontsrc、preflight 及一切经 `openScene` 开的页面都有 | 场景自己写死帧率时，`--fps` 换了它不知道：按 30 对齐的 50 ms 闪光在 24 fps 下 47/200 个只亮 1 帧（film-core `events.md` §6）。赋值无效（不可写、不可重定义） |

渲染器不读取 `MARKS`、`probe`、`anchors`、`VO_OFFSET`。这些是给可选检查用的数据通道（见 `runtime.md`「层间数据」）。

## 2. 唯一的规则

**`seek(t)` 的输出只取决于 t 和加载期确定的常量。**

- **seek 期间不能读取时钟和随机源**，也不能靠定时器推进状态。涉及的 API 有 `Date.now`、`performance.now`、无参 `new Date()`、
  `Math.random`、`setTimeout`、`setInterval`、rAF。这条属于契约，与风格无关。
- **加载期的随机也要可复现**（使用种子）。否则在同一个页面里看不出问题，换一个页面结果就变了。
- **第三方库自带的循环必须关掉，改由 t 驱动。** 选库时唯一的技术判据是：它能否按任意 t 精确求值。
- **允许缓存，但不允许外部能观测到的状态。** 闭式解、定步重放加检查点、预烘焙、库的 `goToAndStop` 都可以。
  判断标准是下面的门能否通过，代码里有没有可变变量并不重要。
- **字体随片打包。** 这条保证的是可复现性（换机器、换浏览器构建后重渲，字形不变），与单次渲染是否正确无关：
  使用系统字体时，本机这一次可能渲得完全正确，换一台机器或换一种构建就会变成另一套字形。
  它属于内核契约，所以第 4 节的字体来源门（`scripts/font_source.mjs`）对所有有入口页的片子始终打开，画字时只要用到系统字体就判为不合格。

## 3. Clip 适配器：约定与示例

任何"给定 t 就能画出这一帧"的东西，都可以包装成同一个形状再合成。**这只是一种写法约定，没有对应的运行时模块需要 import：**

```js
// Clip：一个能按 t 画的东西
//   ready      Promise：加载资源、预计算，并且在这里关掉库自己的循环
//   duration   可选：自带时长的素材（Lottie、视频）
//   render(t)  画出 t 时刻；不依赖上一次调用的结果（要缓存的话，外部必须观测不到）
const clips = [/* … */];
window.ready = Promise.all(clips.map((c) => c.ready));
window.seek  = (t) => { clear(); for (const c of clips) c.render(c.map ? c.map(t) : t); };
```

`map(t)` 是这个 Clip 的时间映射，用来做偏移、变速、定格，或者用 `vo.at('字')` 对齐到旁白上。

下表列出每种来源的接法。**标"已验"的在仓库内有实测，标"推演"的没在本仓库跑过，接入前先用第 4 节的门验证。**

| 来源 | 如何关掉自带时钟并映射 t | 状态 |
|---|---|---|
| 手写 canvas 2D / SVG | 不需要处理 | 已验（全部现有片子） |
| three.js | 用 film-webfx `stage3d.js` 的 `S.frame(t, paint)`（每帧复位到冻结时的姿态）；原版 three 也可以，只要不使用 `setAnimationLoop` / `Clock` | 已验（#41，weiqi-fx-open） |
| 片元着色器 | 用 film-webfx `webfx.js` 的 `fx.render(t)`，时间只通过 uniform 传入 | 已验 |
| 增量引擎：物理、ECS、游戏逻辑 | 用 film-physics `createReplay({init, step, clone})` 做定步重放加检查点，seek 里调用 `draw(stateAt(t))` | 已验（physcheck）；接入 Phaser 之类属于推演 |
| 视频 / 图片序列 | seek 返回 Promise，等待 `seeked` 事件 | 已验 |
| CSS / WAAPI 动效 | 加载时对 `getAnimations()` 返回的动画逐个 `pause()`；seek 里设置 `a.currentTime = (t - start) * 1000`；声明 `USES_WAAPI`。CSS `transition` 由样式变化触发、按真实时间推进，**无法 seek** | 推演（WAAPI 冻结路径本身已验） |
| Lottie（lottie-web） | 设 `autoplay:false`；用 `lottie.freeze()` 停掉全局 rAF；ready 等待 `DOMLoaded` 和图片加载完；`render = t => anim.goToAndStop(t * anim.frameRate, true)`。canvas 渲染器可以通过 `rendererSettings.context` 画进本片的 canvas，作为其中一层 | 推演。AE 表达式里的 `wiggle`/`random` 可能读取 Math.random，探针会报出具体调用 |
| PixiJS | `app.init({ autoStart:false, sharedTicker:false, preserveDrawingBuffer:true })`，再调用 `ticker.stop()`；seek 里设置属性后调用 `renderer.render(stage)`；帧动画用 `gotoAndStop(floor(t*fps) % n)`，不用 `play()` | 推演。`Text` 会先画到离屏纹理上，可读性检查测到的字号和底色可能不准 |
| p5.js | 调用 `noLoop()`；`randomSeed` / `noiseSeed` 放在 setup 里；seek 里调用 `redraw()`；不使用 `frameCount` / `millis()` | 推演 |
| 精灵表 / 瓦片地图 | 帧号取 `floor(t * 动画fps) % 帧数`，本身就是纯函数 | 已验（scratch 探针片，seamcheck 全部通过） |

## 4. 守契约的门，各自防什么

只有这一组门直接守护契约。它们适用于所有片子，不依赖任何文档。`deliver.mjs` 交付时全部打开（包括门 4、门 5），
`accept.mjs --deep` 跑除门 4 以外的全部门（门 4 由用了离屏合成运行时的 skill 在 gates.json 里通过 uses 条件打开）。

| 门 | 怎么跑 | 防什么 | 证据（仓库 `docs/INTEGRATION.md`，不随 skill 安装） |
|---|---|---|---|
| 1a 同页同 t 两次 | `scripts/seamcheck.mjs` | seek 里读取时钟或随机源、每次调用都在累积状态 | 基础门 |
| 1b 全新页面重载 | 同上 | **加载期**的随机和时钟、没等加载完的资源 | 盲区「原来的三道门对加载期非确定性是假门」：1a/2/3 全部通过，只有 1b 查出 13–15 万像素的差异 |
| 2 乱序求值 | 同上 | 跨帧状态、缓存回退时的泄漏、保留式场景图漏写的属性 | 盲区「缓存泄漏只有带回退路径的乱序求值能抓」；#41 的 `scene-bad-noreset` 只有门 2 报红 |
| 3 循环接缝 | 同上，`loop:true` 时才判定；循环片写 `DURATION = 周期`，不额外加一帧 | 首尾画面不一致，或速度不连续 | 第 7 节 |
| 4 全片并行 | `--parallel N`（deliver 始终打开；accept --deep 由 gates.json 的 uses 条件打开） | 只在"连续两帧都执行某个操作"时才出现的依赖 | #40、#42：48 个采样全部通过，只有门 4 报出 4/432 帧 |
| 5 跨启动 + 和渲染清单对账 | `--relaunch 2`，deliver 在定稿渲染之后跑 | **那一次渲染本身出了问题** | 盲区「一次渲染可以静默地坏掉」：84/326 帧纯白，render 报 ✓，只有对账报 ✗ |
| 探针 | seamcheck 默认打开 | 直接报出 seek 期间调用了哪个禁用 API、调用了几次 | 第 7 节 |
| 帧数与分辨率核对 | `scripts/render.mjs` 渲完后自查 | 编码丢帧、尺寸错误 | 仓库 docs/verified |
| 字体来源 | `scripts/font_source.mjs`，有入口页就跑（判定表与盲区见本节末尾） | 用系统字体画字、字体分片在 seek 期间才加载 | #8、#33；`render.md`「渲染器钉版本」（换构建后差异 216/255） |
| 纹理缓存（用了才跑，登记在 film-webfx 的 gates.json） | texcache 检查 | 缓存键漏掉了内容，纹理停留在第一次上传时的样子，而**seamcheck 三道门全部通过** | #36 |
| 重放缓存（用了才跑，登记在 film-physics 的 gates.json） | physcheck | 按顺序、乱序、倒序逐帧比较 | 第 7 节 |

**这组门的已知盲区**：它们验证的是"同一个 t 总是得到同一帧"，不验证"这一帧是不是正确时刻的那一帧"。
时间映射传反的片子照样全部通过（盲区「确定性全绿，而片子在错误的时刻播放正确的帧」，要靠 physcheck E 组或人工查看）。

### 字体来源门：判定表与盲区

```bash
node <film-core>/scripts/font_source.mjs --film <slug> [--step 0.25] [--format 16x9] [--static-only]
```

这道门只回答一个问题：**这支片子画出来的每一个字，是不是都由 `films/<slug>/assets/` 里的字体画的。**
不合格时 exit 1，stderr 逐条写明是哪条字体栈、哪个族名、哪些字。它是内核门 fontsrc（与 seamcheck 同级，有入口页就始终打开）。

不用 grep 判定，是因为字体名常常是拼接出来的（`` `${weight} ${fs}px ${CAPTION.font}` ``），
本仓库样例 ghost-jam 改用 Noto 之前的写法 `font: '"PingFang SC"'` **照样能通过 `audit.mjs`**（实测，见仓库 docs/verified/film-assets.md）。
所以判定放在浏览器里做：加载场景，按步长 seek 全片，钩住每次 `fillText`/`strokeText` 调用，记下 `ctx.font` 和画的字，再按下表判定：

| 判什么 | 怎么判 |
|---|---|
| 哪些族算"随片" | 每个 face 的来源（`@font-face` 的 `src`、`new FontFace` 的 url）都是 `assets/` 下真实存在的文件。`local()`、外链、文件缺失、指向 `assets/` 之外的，都不算 |
| 系统字体抢先 | 字体栈里排在第一个随片族**前面**的名字，如果是通用族（`sans-serif`、`ui-monospace`…）、本机装了的字体（用像素探针判断：把它设为首选并分别搭配 7 组回退，画出来都一样，就说明是它自己画的）或已知系统字体名（`lib/fontcss.mjs` 的 `SYSTEM_FONT_RE`，覆盖 macOS/Windows/Linux 常见名），判为不合格。本机没有的系统字体名照样不合格，因为换到装了它的机器上，它会排在随片字体前面先被使用 |
| 栈里根本没随片字体 | 不合格，所有字都由系统字体画 |
| 缺字回退 | 只保留栈里的随片族，后面分别接 7 组不同的回退字体逐字画，像素不一致就说明随片字体里没有这个字，列出这些字 |
| DOM/SVG 文字 | 通过 CDP `CSS.getPlatformFontsForNode` 直接询问 Chromium 用了哪些字体，`isCustomFont=false` 判为不合格 |
| 字体来得晚 | 初次就绪（`window.ready` + `document.fonts.ready`）之后，如果某次 seek 让一个 FontFace 从 `unloaded` 变成加载中（unicode-range 分片第一次被用到），或者仍有字体文件请求，判为不合格，并列出发生在哪一刻、哪个分片、首次由哪些字触发。这种情况下字并不缺，只是来得晚，那一帧用回退字体画了。上面几条全部通过时也可能出现这种情况（它们只检查"最后是谁画的"）；修复方法是在加载期把要用到的字都触发一遍（film-typography 的 `loadFonts` 能把字列全，运行时拼出的数字可以按字符类别声明） |

系统字体名表只影响**报错措辞**，不影响判定：不在随片声明里的名字一律算"没随片"，表外的名字只是少了一句"它是系统字体"的说明。
代码里出现了系统字体名、但采样时刻没有用它画字的，只发出警告（可能是死代码，或没采样到的分支）；`--static-only` 不启动浏览器，
这类命中直接判为不合格，但查不到变量拼出的名字，也查不了缺字回退。

**盲区**：只检查采样时刻画过的字（`--step` 越小覆盖越全，默认 0.25 s，上限 800 次 seek）；Worker 里的 OffscreenCanvas、
WebGL 自己栅格化的字都检查不到；`new FontFace(name, ArrayBuffer)` 的来源无法看到，只能根据"页面请求过的字体文件都在 `assets/` 里"推断，并发出警告。
它不检查授权（由 film-assets 的 `audit.mjs` 和素材台账负责），也不检查"字够不够"（由 film-assets 的 `subset_font.py --check` 负责）。

## 5. 症状表：先看现象，再找门

| 现象 | 先看哪道门 | 常见原因 | 出处 |
|---|---|---|---|
| 两次渲染不一样、成片闪烁 | 1a + 探针 | seek 里用了 `Math.random` 或读取了时钟 | 第 7 节 |
| 同一页面没问题，换页面就不同 | 1b | 加载期用了 `Math.random`，或资源没在 `ready` 里等加载完 | 盲区 |
| 顺序渲染没问题，乱序或并行就出错 | 2 / 4 | 跨帧状态；缓存检查点存的是引用；`seeded()` 闭包没有跟着回退；离屏层设置了 `imageSmoothingQuality='high'` | 盲区、#40 |
| 门 1a/2 报红，提示"读了时钟" | font_source | 字体分片在 seek 期间才第一次加载，那一帧用了回退字体 | #33 |
| 每一帧截出来都一样（都是终态） | openScene 报错 | 有 CSS/WAAPI 动画但没声明 `USES_WAAPI` | 第 7 节 |
| CSS 动画在截图里按真实时间播放 | — | 声明了 `USES_WAAPI`，但 seek 里没设置 `currentTime`；或者用了 `transition` | `nondeterminism.md` |
| 三维片里漏写的属性保留着上一帧的值 | 2 | 保留式场景图没有每帧复位 | #41 |
| 积分写法 `p += v·dt` 能通过所有门，换成带阻尼的写法就报红 | 2 | 常数速度的积分碰巧等于闭式解；只有门 2 能区分 | #41 |
| 纹理不随 t 变化，门却全部通过 | texcache-check | 声明了 `static` 或 key，但内容变化时没有 bump（更新）它 | #36 |
| render 报 ✓，成片里却有白帧 | 5 | 新装或新拷贝的浏览器第一次启动 | 盲区 |
| 换浏览器构建后字形变了 | font_source | 字体没有随片打包，两种构建回退到了不同的字体 | `render.md`「渲染器钉版本」 |
| 换 Chromium 版本后所有片子一加载就失败 | — | favicon 404 被当成了场景错误（已修复） | #14 |
| 场景报错只显示"ffmpeg 退出码 null" | — | 被杀掉的 ffmpeg 产生的 Promise 拒绝没有被处理，盖住了真正的错误（已修复） | #42 |
| `getContext('webgl2')` 返回 null | — | 同一个 canvas 上先取过 `webgl` | 每种 context 用各自的 canvas |
| 三维 / 着色器画面换了机器或系统更新后变了，渲染时告警 backend/gpu/gpuDriver 不同 | — | 片子声明了 `"backend": "gpu"`，像素跟显卡和驱动走 | `render.md`「渲染后端」 |
| 渲染直接报「缺能力：…没有起来硬件 GPU 的 WebGL」 | — | 声明了 gpu 后端，本机没有可用 GPU（不会退回软件） | 同上 |
| 所有门全部通过，画面播放的时刻却不对 | physcheck E / 人工查看 | 影片时间到仿真时间的映射传反了，或者忘了传 | 盲区 |

## 6. 不在这里的东西（全部可选）

- **有旁白时的对齐四条**（音频先行、时长回写、关键词触发、事后校验）：对"要和人声同步"的片子是技术约束，
  对无旁白的片子不适用。见 film-narration。
- **配方**（例如解说片：brief → 调研 → 机制 → 旁白 → 分镜 → …）：用 `new-film.mjs --recipe <名字>` 建模板并声明检查。
- **质量护栏**（可读性、对比度、事实对账、分镜断言、遮挡和出画、真峰、念读核验）：每一项都防住过真实的缺陷，
  在 film.json `checks` 里声明了才打开：`"checks": ["shotlist", "readability", {"contrast": {"min": 4.5}}]`。
  id 由提供它的 skill 在 gates.json 里认领；声明了却没有 skill 认领的 id，在 deliver / accept --deep 里报红。
- **风格与思路**：只是菜单，不是规定，见 `style-menu.md`。
- **三画幅共用一条时间线**（`L.place()` / `L.size()`）：需要同时出多个画幅时值得用，单画幅片不需要。见 SKILL.md「画幅」。
- 运行时怎么挂载与冻结、浏览器怎么固定版本、层间数据通道：见 `runtime.md`。
- **渲染后端**：一次渲染（以及守它的全部门）只用一个后端，由 film.json `backend` 声明，缺省是软件的 SwiftShader。`"gpu"` 让 WebGL 走本机硬件 GPU，第 4 节的门在这个后端下照样适用，而且都在同一个后端下运行。代价是像素只能在同款显卡上复现，起不来时直接报错。什么时候值得用见 `render.md`「渲染后端」。
