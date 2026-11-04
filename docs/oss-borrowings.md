# 开源「代码生成视频」项目：可借鉴机制清单

两轮调研，同一天（2026-10-21）：

- **第一轮（0–4 节）比渲染性能**：截图方式、并行渲帧、分片编码、帧哈希清单、组合子、预览器。
- **第二轮（第 5 节）比验证**：怎么知道渲出来的是想要的（内容断言）、时间重映射、确定性。
  对应 INTEGRATION.md「验证门本身的六个盲区」。**第二轮更正了第一轮 §3.A 的一条结论**，见 5.0。

目录：0 顺带发现 · 1 可借鉴清单（#1–#11） · 2 不该借的 · 3 三个问题（A 乱序门 / B 纯函数撑不住的场景 / C 标配缺席）
· 4 已经做对的 · **5 第二轮：验证**（5.0 更正 / 5.1 内容断言 / 5.2 时间重映射 / 5.3 确定性 / 5.4 汇总） · **6 第三轮：设计方法**（frontend-design / canvas-design）
· **7 第四轮：三维与特效**（three.js / pmndrs postprocessing / Theatre.js / shader） · 附 落地顺序 · **Motion Graphics 一轮**（转场、镜头切换、文字动画、缓动编排）

> 这是开发调研日志（不随 skill 安装）。skill 正文里的"借了 X 的思路"都指向这里的对应节。

第一轮读源码的版本：

| 项目 | 版本 | 读了什么 |
|---|---|---|
| Remotion | `remotion-dev/remotion` @ `f29e9f3`（2026-10-20） | `packages/renderer` `packages/core` `packages/player` `packages/lambda*` `packages/media-utils`，**挖得最深** |
| Motion Canvas | `motion-canvas/motion-canvas` @ `7b91435`（2026-07-02） | `packages/core/src/app` `scenes` `signals` |
| Revideo | `redotvideo/revideo` @ `b5de67a`（2026-07-15） | `packages/renderer` |
| Manim CE | `ManimCommunity/manim` main（2026-10-21 拉取） | `manim/utils/hashing.py` `manim/scene/scene_file_writer.py` |

Theatre.js 只读了文档。Rive / Lottie / p5 / FFCreator / editly / diagrams-as-code **没读源码**，
时间预算花在 Remotion 上了；第 2 节提到它们的地方都标了「未读源码」。

下面「实测」的数字全来自这台机器（16 核，48 GB，Playwright 1.64.1 自带的 Chromium），
基准场景是 1080×1920 的 canvas2D 合成场景（每帧画 3000 个圆加一行字，240 帧）。
脚本在 `<scratchpad>/bench/`（`bench.mjs` `bench2.mjs` `ident.mjs`）。
**WebGL 重场景、SwiftShader 软渲染下曲线会不一样，没测。**

---

## 0. 先说三个调研中顺带发现的事实

1. **弹簧时长反解已经做了，而且比 Remotion 好。** `film-motion/assets/runtime/motion.js` 里已经有
   `spring({duration, overshoot})` 和 `springInfo()`，理由见第 4 节。原来列的第 4 条可以划掉。
2. **`film-motion/SKILL.md:289` 指向 `<fm>/scripts/preview.mjs`，但这个文件不存在。**
   `skills/film-motion/scripts/` 下只有 `render.mjs` `seamcheck.mjs` `lib/`。仓库根有个 12 行的
   `scripts/preview.mjs`，是旧版本。所以这条是**死链接**，不只是「预览简陋」。
3. **截图那一步才是最大的单项浪费，比串行还大。** `scripts/lib/scene.mjs` 的 `shot()` 用的是
   `stage.screenshot()`（Playwright locator 截图）。同一页面、同一帧，换成直接调 CDP
   `Page.captureScreenshot`：**14.2 → 32.5 fps，单页就快 2.3 倍**；解码后 RGBA 的 md5 完全一致
   （`372946a0…`）。这条改动很小，排在第 1。

---

## 1. 可借鉴清单（按值不值得做排序）

### #1 截图走 CDP `Page.captureScreenshot`，不走 locator.screenshot

- **是什么**：绕过 Playwright 的 locator 截图（它每次都要做可操作性检查、滚动进视口、处理 `animations`），
  直接发一个 CDP 命令，传 `clip` 和 `optimizeForSpeed:true`。
- **谁这么做**：Remotion `packages/renderer/src/screenshot-task.ts`：
  `client.send('Page.captureScreenshot', {format, quality, clip:{x:0,y:0,width,height,scale:1}, captureBeyondViewport:true, optimizeForSpeed:true, fromSurface})`。
  注释里说，`fromSurface:false` 时截图上限是 8192×8192。
- **实测**（单页、串行、240 帧）：

  | 截法 | fps |
  |---|---|
  | `locator.screenshot({type:'png', animations:'disabled'})`（现状） | 14.2 |
  | CDP png，`optimizeForSpeed` | 32.5 |
  | CDP jpeg q90 | 36.4 |

  locator 截图和 CDP 截图解码后逐像素一致（md5 相同）。PNG 文件字节数不同（102 KB 对 150 KB），
  是压缩参数不同，像素没变。
- **怎么改**：`skills/film-motion/scripts/lib/scene.mjs` 的 `openScene()`：
  `const cdp = await context.newCDPSession(page)`；加载完用 `stage.boundingBox()` 量一次 clip；
  `shot()` 换成 CDP 调用后 `Buffer.from(data,'base64')`。大约 15 行。seamcheck 也是走 `shot()`，所以两边一起变快。
- **代价和风险**：
  - 丢了 Playwright `animations:'disabled'` 的兜底。现在这个兜底本来就只在没声明 `USES_WAAPI`
    时起作用，而加载时的 `cssAnims > 0` 检查已经会直接报错。缺口在 **seek 过程中新建的 CSS 动画**：
    建议每次 seek 后检查一遍 `document.getAnimations().length`，不是 0 就报错。
  - `stage` 元素的位置如果会变（不应该变），clip 就会截错。加载时量一次，然后断言它不变。

### #2 并行渲帧：多个浏览器进程，每个进程开少量页面

- **是什么**：`seek(t)` 是纯函数，帧与帧之间没有依赖，可以开 N 个页面同时截。
- **Remotion 本地渲染怎么做**（`packages/renderer/src/render-frames.ts`）：
  - **一个浏览器**开 `concurrency` 个 tab（`getPool()`：`new Array(concurrency).map(makeNewPage)`），
    放进 `pool.ts` 里一个极简的 acquire/release 资源池。
  - **不按区间切片，而是动态取帧**：`next-frame-to-render.ts` 每次给空闲的 tab 发「下一个还没渲的帧」，
    失败的帧 `returnFrame()` 放回队列（每帧最多重试 `MAX_RETRIES_PER_FRAME` 次，见 `render-frame-and-retry-target-close.ts`）。
  - **送进编码器前重新排序**：`ensure-frames-in-order.ts` 用 waiter 队列，帧 k 一直等到 k-1 写完才写进 ffmpeg stdin。
  - **默认并发**：`get-concurrency.ts`：`Math.round(Math.min(8, Math.max(1, cpus/2)))`，上限是核数。
  - **后台 tab 的坑**：`cycle-browser-tabs.ts` 每 200 ms 对下一个 tab 调一次 `bringToFront()`，
    启动参数里还有 `--disable-background-timer-throttling` `--disable-renderer-backgrounding`
    `--disable-backgrounding-occluded-windows`（`open-browser.ts`）。Playwright 默认已经带了这三个参数
    （在 `playwright-core/lib/coreBundle.js` 里查到），所以 bringToFront 轮转我们**大概率**用不上——属于猜测，
    下面的实测里没加它，帧也全对。
- **Remotion Lambda 怎么做**（分布式）：`packages/lambda-client/src/best-frames-per-function-param.ts`：
  0 到 10 分钟（30 fps）之间，并发数从 75 线性插值到 150，每个函数至少分 20 帧；
  `packages/lambda/src/functions/plan-frame-ranges.ts` 切成连续区间；每个函数编出自己的 h264 分片，最后在
  `packages/renderer/src/combine-video-streams.ts` 用 ffmpeg concat demuxer `-c:v copy` 拼起来（**不重编码**）。
  `can-concat-seamlessly.ts`：只有 h264 能这样无缝拼；音频必须是 AAC，并且分片要 > 4 帧。
- **Revideo 怎么做**（`packages/renderer/server/render-video.ts`、`client/render.ts`）：
  N 个 worker，每个 worker 一个 puppeteer 浏览器加一个 vite server（端口递增），**等长连续切片**
  （`getWorkerFirstAndLastFrame`），各自编码，最后 `concatenateMedia`。它只能切连续区间，
  原因见第 2 节（Motion Canvas 系的生成器不能随机访问）。
- **实测**（CDP png，240 帧）：

  | 拓扑 | fps | 相对现状 14.2 |
  |---|---|---|
  | 1 浏览器 × 1 页（只换截图方式） | 32.5 | 2.3× |
  | 1 浏览器 × 4 页 | 86.4 | 6.1× |
  | 1 浏览器 × 8 页（≈ Remotion 默认） | 109–110 | 7.7× |
  | 1 浏览器 × 12 页 | 110.5 | 饱和 |
  | 2 浏览器 × 4 页 | 182 | 12.8× |
  | 4 浏览器 × 3 页 | 294 | 20.7× |
  | 6 浏览器 × 2 页 | 319 | 22.4× |
  | **8 浏览器 × 2 页** | **368** | **25.9×** |
  | 8 浏览器 × 1 页 | 236 | |
  | 12 浏览器 × 1 页 | 324 | |

  **单浏览器在约 8 个页面时就饱和（约 110 fps）**，再多开页面也没用，瓶颈在一个浏览器进程内部
  （猜测是共享的 GPU 进程或 browser 进程；没去 profile）。**多开浏览器进程才能继续往上走**，
  这台 16 核机器的甜点大约在「核数/2 个浏览器 × 2 页」。这一点和 Remotion 本地「单浏览器多 tab」的做法不同，
  我们可以做得比它好。
  **正确性**：`ident.mjs` 用 1×8 和 4×3 两种拓扑各渲 96 帧，和串行结果逐帧比 PNG md5，**0/96 不同**。
- **编码会变成新瓶颈**：libx264 `-preset slow -crf 18`、1080×1920 时，编码速度随内容变化很大。
  实测 testsrc2 约 180 fps，叠满颗粒噪声只有约 8.3 fps。截图到 300+ fps 之后，单个 ffmpeg 会卡住整条管线，
  颗粒、噪点多的片子尤其明显。所以 #2 必须和 #3（分片编码）一起做。
- **怎么改**：重写 `skills/film-motion/scripts/render.mjs` 的帧循环，约 150–200 行：
  - `--workers B --pages P`，默认 `B = max(1, floor(cpus/4))`、`P = 2`。这是按上表推的，**换机器要重测**。
  - **按连续分片分配，不按单帧动态分配。** 理由是每个分片要交给自己的 ffmpeg（见 #3）。
    分片长度取 2–4 秒，分片数远多于页面数，所以用一个分片队列做动态负载均衡（Remotion 的动态取帧加 Lambda 的连续区间，取两者之长）。
  - 运动模糊 `sub>1` 时，分片边界必须对齐输出帧，也就是每组 `sub` 个子帧。现在的 `tmix` + `select` 写法是每组自包含的，可以照用。
  - 一个 `serve()` 静态服务器给所有浏览器共用就够，不用学 Revideo 每个 worker 起一个 server。
- **代价和风险**：
  - 内存：每个 Chromium 进程加上 1080×1920 的页面大约几百 MB（没精确测），48 GB 的机器开 8 个没问题。
  - **任何「加载时状态」的 bug 都会放大成闪烁**，因为每个页面各加载一次。seamcheck 门 1b 正好守这个，
    所以门 1b 是并行渲染的前提，不是可选项（见 A）。

### #3 分片编码 + 拼接时不重编码 + 逐帧像素哈希清单 → 增量重渲和「改动泄漏报告」

- **是什么**：每个分片单独编成 h264，用 `ffmpeg -f concat -c:v copy` 拼起来。每帧截完先算像素哈希，
  写进清单；下次渲染时，哈希没变的分片直接复用上次的 mp4，不再编码。
- **谁这么做**：
  - Remotion Lambda 的分片加 concat copy：见上面 `combine-video-streams.ts`。
  - Manim 的分段缓存：`manim/utils/hashing.py` 的 `get_hash_from_play_call()` 对这些东西依次喂 sha256：
    `backend`、`encoder_fingerprint`、相机状态的 JSON、按 `str` 排序后的动画列表 JSON（`include_pixel_array=True`）、
    当前所有 mobject 的 JSON、`renderer_state`。每项都带长度前缀。
    命中就跳过，见 `scene_file_writer.py` 的 `is_already_cached()`、`partial_movie_files`。
    最后用 concat manifest 拼起来（`_write_concat_manifest`），旧文件按 `max_files_cached` 清掉。
- **为什么不能照抄 Manim 的缓存键**：Manim 的键是**场景状态的序列化**。它能做到，是因为每段动画就是一次
  `play()` 调用，输入是可以枚举的对象。我们的 `seek(t)` 对外是黑盒，从外面没法知道「t∈[4,7] 依赖哪些代码」。
  拿代码文件哈希当键，等于改一行就整片失效，没用。
- **我们的改法**（这是基于上面两个项目的**设计提案**，没有项目原样这么做）：
  键用**输出本身**。截图现在已经很便宜（#1 和 #2 之后能到 300 fps），贵的是编码（颗粒片 8 fps）。所以：
  1. 每次都**全量截图**，但每帧只算哈希（RGBA 的 md5 或 xxhash），写进 `out/frames.manifest.json`：
     `{fps, format, sub, chunkLen, frames:[hash…], chunks:[{from,to,hash,file}]}`。
  2. 分片哈希就是它所有帧哈希串起来再哈希。和上次一样，就复用 `out/chunks/<hash>.mp4`，不编码。
  3. 编码器参数（crf、preset、pix_fmt、ffmpeg 版本）也要进分片键，学 Manim 的 `encoder_fingerprint`。
  4. 最后 concat copy。
- **顺带得到一个现在没有的能力：改动泄漏报告**。渲完打印「这次和上次相比，哪几秒的像素变了」。
  你只想改第 3 镜，报告却说第 7 镜也变了，就说明改动漏到了别处：动了共享的 `place()`、种子顺序变了、
  某个 `follow()` 的 stops 共用了。这是**比「只重渲三秒」更有用的纪律工具**：它把「只重渲改动的那几秒」
  从一条靠自觉的纪律，变成一份自动产出的报告。放进 `film-critique` 的自检循环也合适。
- **工作量**：`render.mjs` 加约 80 行（manifest 读写、分片复用、concat）。和 #2 一起写比分开写省事。
- **代价和风险**：
  - concat copy 要求所有分片的编码参数完全一致，并且每片都从 IDR 开始。各片单独起 ffmpeg 时，这两条天然满足。
    Remotion 额外加了 `-video_track_timescale 90000` 保持 time base 一致，照抄。
  - 码控在每片内部独立做，分片边界附近画质可能有轻微跳变。crf 模式下理论上很小，**没测**。
  - 音频不跟着视频分片：我们本来就是 `film-narration` 的 `mux.sh` 在最后合流，正好绕开了 Remotion 那套无缝 AAC 拼接（`seamless-aac-trim.ts`）的复杂度。

### #4 每次 seek 后 `await document.fonts.ready`；给 seek 内部的异步加上带标签、有超时的 hold

- **是什么**：Remotion 不只在加载时等字体。`packages/renderer/src/seek-to-frame.ts` 的 `seekToFrame()`
  **每一帧**都依次做三件事：`waitForReady` → `window.remotion_setFrame(f)` → 再 `waitForReady`
  → `await document.fonts.ready`。
- **delayRender 的 API 设计**（`packages/core/src/delay-render.ts`）：
  - `delayRender(label?, {timeoutInMilliseconds, retries})` 返回一个 handle（`Math.random()` 生成），
    push 进 `window.remotion_delayRenderHandles`，同时把 `remotion_renderReady` 置为 false。
  - `continueRender(handle)` 移除这个 handle；列表空了，才把 `remotion_renderReady` 置为 true。
  - 渲染器侧（`seek-to-frame.ts` 的 `waitForReady`）轮询 `window.remotion_renderReady === true`。
    超时的时候，**把所有还没释放的 handle 的 label 列出来**写进错误信息
    （`Open delayRender() handles: "1. 加载封面图", …`）。这是这套 API 最有价值的一点：卡住时你知道是谁在卡。
  - 超时会比 puppeteer 的超时短 2 秒（`- 2000`），保证先报出 delayRender 自己的错误，而不是笼统的超时。
  - 支持重试：`retries` 配合 `remotion_attempt`，超时后可以整帧重试。
- **我们已经有的**：`scene.mjs` 里是 `await window.seek(x)`。**seek 本来就能返回 Promise**，所以「这一帧要等」在机制上已经通了，
  比 Remotion 的全局计数器还直接。缺的是三件事：
  1. 每次 seek 之后没有 `await document.fonts.ready`。在 seek 里第一次用到某个字重或某个子集字体时，就会截到回退字体。
     改 `scene.mjs` 的 `shot()`，**1 行**。
  2. 卡住时不知道是谁：seek 的 Promise 不 resolve，就只能等 Playwright 的通用超时。
     建议在 `motion.js`（或单独一个 `assets/runtime/hold.js`）提供 `hold(label)` / `release(h)`，
     渲染器在 seek 之后等 `window.__holds` 清空，超时就列出所有 label。约 30 行。
  3. canvas `drawImage` 碰到还没解码完的图片，会**静默画空**。这正是「截到半成品」的典型来源。
     Remotion 的 `<Img>` 内部也是用 delayRender 等 `onload`。建议在 runtime 里提供
     `await loadImage(url)`，统一走 `img.decode()`，在 `window.ready` 里收齐；
     seek 里用到没登记过的图就直接 throw。约 20 行。
- **代价**：很小。要注意别让 hold 变成「在 seek 里拉网络」的许可。动态加载的东西越多，
  渲染越慢，而且门 1b 越容易因为加载时序出问题。原则仍然是：能放进 `window.ready` 预载的，都放进去。

### #5 钉住 Chromium 版本，加 `--font-render-hinting=none`

- **是什么**：ARCHITECTURE §3 说「拷贝把运行时版本钉在片子上，半年后引擎升级，老片重渲结果不变」，
  但钉住的只是 JS。**光栅化是 Chromium 做的**：Playwright 一升级，Chromium 跟着换，文字抗锯齿、
  Skia 路径、色彩管理都可能变，老片重渲就不再逐像素一致。
- **谁这么做**：Remotion 把测试过的 Chrome 版本写死在 `packages/renderer/src/browser/BrowserFetcher.ts`
  （`TESTED_VERSION`，还有自己打补丁的 `-remotion-v3` 构建），下载的是固定版本的 chrome-headless-shell。
  启动参数里有 `--font-render-hinting=none` 和 `--force-color-profile=srgb`（`open-browser.ts`）。
  我在 `playwright-core` 里查过：Playwright 默认带了 `--force-color-profile=srgb`，**没带 `--font-render-hinting=none`**。
  另外 Remotion 在 Lambda 上会加 `--disable-gpu-rasterization`，注释说是为了避免「重复的横条」
  （remotion-dev/remotion#11428）。这说明 GPU 光栅化本身就是一个不确定性来源。
- **怎么改**：`scene.mjs` 的 `chromium.launch({ args:['--font-render-hinting=none'] })`；
  `render.mjs` 把 `browser.version()` 和 Playwright 版本写进 manifest（#3），
  `seamcheck` 和 manifest 对比，版本不同时警告「像素差可能来自浏览器升级，而不是你的改动」。约 10 行。
- **代价**：`--font-render-hinting=none` 会让文字和现在的渲染结果有细微差别，**所有已有片子的基准帧会一次性变化**。
  这个参数对 macOS 的实际影响**没测**（Remotion 的这个参数主要是冲着 Linux 的 FreeType 去的，这是猜测）。

### #6 时间平移组合子：`shot()` / `chain()` / `freeze` / `loop` / `rate`，写成纯函数

- **Remotion 怎么做**（`packages/core/src/Sequence.tsx`、`use-current-frame.ts`、`series/index.tsx`、`loop/index.tsx`、`freeze.tsx`）：
  - `<Sequence from durationInFrames>` 往 React context 里放 `cumulatedFrom` 和 `relativeFrom`，嵌套时一层层累加
    （`cumulatedFrom = parent.cumulatedFrom + parent.relativeFrom`）。
  - `useCurrentFrame()` = `(absoluteFrame - (cumulatedFrom + relativeFrom)) * playbackRate`。
    **它仍然是纯函数**：context 只是在组件树上传递偏移量，不是跨帧状态。
  - 不在区间内的 Sequence 不挂载；`premountFor` 会提前若干帧隐藏挂载，让资源先加载。
  - `<Series>` 根据每段的 `durationInFrames` 加 `offset` 自动算出每段的 `from`；`<Loop>` 取模；`<Freeze frame>` 把时间钉死；Sequence 上还能设 `playbackRate`。
- **我们怎么做**：不需要 context，**显式传 t** 就行。裸 canvas 也没有组件树。往 `motion.js` 加：
  ```js
  // 返回镜头局部时间，或 null（不在区间）；局部时间从 0 开始
  shot(t, from, dur)                       // → t-from ∈ [0,dur) 或 null
  chain([['a', dA], ['b', dB, {offset}]])  // → { a:{from,dur}, b:{from,dur}, at(t)→[name, localT] }
  freeze(t, at) / loop(t, len) / rate(t, k, from=0)
  ```
  `chain` 的时长应该来自 `narration.json`（`vo.span('第二段')`），不是手填，这样就和 §6 的「时长回写」接上了。
  约 40 行，加一个最小 `scene.html` 用例，跑 seamcheck 验证。
- **代价**：几乎没有。唯一要防的是误用：镜头里用 `shot()` 拿到局部时间之后，又去读全局 `t`。
  文档里写清「镜头函数签名只收 localT」就够了。

### #7 最小预览器：一个页面包住 scene，拖动条加播放，音频当主时钟，时间轴上画词和镜头

- **Remotion Player 怎么做**（`packages/player/src/use-playback.ts`、`calculate-next-frame.ts`）：
  - 用 `performance.now() - startedTime` 算出应该在哪一帧，rAF 驱动，跟不上就丢帧。
    tab 进后台、rAF 停掉的时候，改用 setTimeout（`use-playback.ts` 第 82 和 402 行的注释）。
  - 音视频元素**追随时间轴**，不当时钟用：`packages/core/src/get-media-sync-action.ts` 里，播放时漂移超过
    `0.15 s` 才重新 seek，暂停时阈值是 `0.01 s`。Safari 放大音量时会滞后约 0.4 s，所以那种情况下阈值放宽到 0.65 s（`use-media-playback.ts`）。
- **Motion Canvas 的可编辑时间事件**（`packages/core/src/scenes/timeEvents/EditableTimeEvents.ts`）：
  代码里写 `waitUntil('名字')`，编辑器时间轴上显示成一个可以拖的标记。存进 `.meta` 文件的是
  `{initialTime, targetTime, offset}`。代码一改，`initialTime` 跟着变，**`offset` 保留**（`preserveTiming`）。
  这和我们的 `vo.at('词')` 是同一个问题的不同解法，正好可以合起来：
  **`vo.at('词') + offsets.json['词']`**。旁白重录后词的时刻会变，人手调过的偏移不丢。
  这是 Motion Canvas 已经有、我们还没有的能力。
- **Theatre.js**（只读了文档 https://www.theatrejs.com/docs/latest/manual/projects ）：
  编辑器里调好的关键帧导出成 JSON，生产环境用 `getProject('名字', {state: json})` 加载。
  思路相同：**可视化编辑的产物是数据文件，代码只读数据**。不建议把 Theatre 整个引进来（理由见第 2 节），借的是这个思路。
- **我们的改法**：在 `skills/film-motion/scripts/preview.mjs` 新建（同时修好 SKILL.md 的死链接），约 150 行：
  - 起 `serve()`，返回一个外壳页：iframe 里加载 `scene.html?format=`，下面是 `<input type=range>`、播放/暂停、逐帧按钮、当前时间。
  - **播放时用 `<audio>` 的 `currentTime` 当时钟**（有 `out/vo.wav` 时），每个 rAF 调一次 `seek(audio.currentTime)`。
    这和 Remotion 相反（它用 performance.now，让媒体追随），但我们是音频先行，旁白就是真相源，
    听着对就是对。**这是建议，不是哪个项目的做法。**
  - 时间轴上画出 `narration.json` 的词（小刻度）和镜头边界（来自 #6 的 `chain`），点哪个就跳到哪。
  - 第二步再做：拖词标记生成 `offsets.json`（Motion Canvas 的做法）。
- **代价**：预览是 rAF 驱动的，一旦 seek 慢于 16 ms 就会卡。这只是预览体验差，判据永远是 seamcheck 和渲染，SKILL.md:293 已经写明了。

### #8 Web Audio 可视化：整段解码 + 按 t 取窗口 FFT + 相邻帧平均来平滑

- **Remotion 怎么做**（`packages/media-utils/src/get-audio-data.ts`、`visualize-audio.ts`）：
  先 `decodeAudioData` 把整个文件解码成样本数组；`visualizeAudio({audioData, frame, fps, numberOfSamples})`
  对 frame 附近的样本窗口做 FFT（实现在 `fft/` 目录下）。**平滑不用指数滑动平均，而是把 `frame-1, frame, frame+1` 三帧的纯值平均**
  （`visualize-audio.ts` 第 76–78 行附近）。平滑本来是最容易引入跨帧状态的地方，这样做之后仍然是纯函数。
- **对我们**：不要用实时的 `AnalyserNode`（它是有状态的实时流）。在 `film-narration` 的 runtime 里加一个
  `audioViz.js`，约 60 行。也可以在 Python 侧用 librosa 预先烘成每帧频谱表，和 `film-physics/scripts/bake.mjs` 的思路一致。
  **需要的时候再做**，不是每支片子都有频谱。

### #9 视频素材：在浏览器外抽帧，按 t 查图

- **Remotion 怎么做**：`<OffthreadVideo>` 渲染时不用 `<video>` 元素。`packages/renderer/src/offthread-video-server.ts`
  起一个本地 HTTP 端点，接收 `?src=&time=&toneMapped=`，由 Rust compositor（内部调 ffmpeg）抽出精确的那一帧，返回成图片。
  原因写在 `render-frames.ts` 第 405–407 行的注释里：`<Html5Video>`「not always frame perfect and give a flicker」，
  所以 Remotion 甚至专门**按顺序渲染**来降低闪烁概率。`core/src/warn-about-non-seekable-media.ts` 还专门检测 `seekable` 区间为空的媒体。
- **对我们**：`film-assets` 里加一条：视频素材先用 `ffmpeg -i x.mp4 -vf fps=<片子 fps> out/…/%05d.png` 抽成序列（或者打成精灵图），
  scene 里按 `Math.round(t*fps)` 查图，图片走 #4 的 `loadImage` 预载。**不要在 seek 里拿 `<video>.currentTime` 去 seek。**
  工作量是一段文档加一条 ffmpeg 命令。代价是磁盘：1080p PNG 每帧约 1–3 MB（估算），长素材建议用 jpg。

### #10 参数化批量出片（schema + props）——**已实现**（2026-10-26，形态改为 content.json 内容层 + 变体矩阵，见本条末）

- **Remotion 怎么做**：组件的 props 用 zod schema 定义（core 里有 `any-zod-type.ts`、`use-schema.ts`），
  渲染时传 `inputProps`，`calculateMetadata()` 可以根据 props **异步算出时长和尺寸**
  （文档：https://www.remotion.dev/docs/calculate-metadata ，这条没读源码）。
  Revideo 的 `renderVideo({variables})`（`render-video.ts` 第 85 行附近）是同一回事。
- **对我们**：真正的价值是「同一个机制换数据出一批片」，可我们目前的流水线是**一片一个 brief、一个机制**，
  核心环节（research → mechanism → 静帧闸门）恰恰是**不能批量化的判断**。
  如果以后要做「一套模板 × N 条数据」，最小实现是：`film.json` 加 `props` 字段，渲染器用 `?props=<file>` 传给页面，
  scene 读 `window.PROPS`，`render.mjs --props a.json --props b.json` 循环渲。约 30 行。不要引入 zod，写一个 JSON Schema 校验就够了。
  ~~现在不做。~~
- **已实现（2026-10-26）**：需求真来了（宣传片要 3 hook × 2 CTA × 画幅的矩阵导出），做法比草稿多走了一步——
  不是 `film.json props` + `window.PROPS` 的一坨参数，而是片子根目录可选的 `content.json`：文案槽位（maxChars / font+box / 代码 lang / locked）、
  素材登记、品牌 token、claims（宣传说法 + facts.md 出处）、`variants` 维度表（只许覆盖 text/assets/brand/params，不改动画代码）和 `matrix`。
  场景 `await loadContent()`（`film-core/assets/runtime/content.js`，按 URL `?variant=` 加载期合并，同 `?format=` 的规矩），
  `render.mjs --variant <id>` / `--matrix` → `out/variants/<id>/final-<fmt>.mp4` + `manifest.json`（组合、内容哈希、源/模板/运行时哈希、渲染设置、产物哈希）。
  分片缓存跨变体按像素复用（同一分片多份内容并存）。和草稿的差别及理由：变体 id 由维度组合而来（`hook-b.cta-a`），
  一份数据文件而不是 N 个 props 文件——"一份源 × 多份数据"要能一眼看出各版本差在哪；时长仍由场景/旁白决定，不做 `calculateMetadata` 式的按数据算时长。
  没有 content.json 的片子输出逐字节不变（demo-tls 实测）。schema：`film-core/references/content-json.md`；试点为一支产品宣传片。

### #11 渲染器健壮性细节（顺手抄）

都来自 Remotion `packages/renderer/src/`，每条几行：
- 页面崩溃（`Target closed`）时换一个新页面，重试这一帧（`render-frame-and-retry-target-close.ts`、`replace-browser.ts`）。
  多进程并行以后，偶发崩溃的概率按进程数放大，这条就有必要了。
- 帧数校验：我们已经用 ffprobe `nb_read_frames` 做了，Remotion 没在这里做，这一项我们更严。
- 用 `--disable-dev-shm-usage` `--mute-audio` `--hide-scrollbars`：Playwright 已带，不用动。

---

## 2. 明确不该借鉴的

| 不借 | 为什么 | 出处 |
|---|---|---|
| **React `<Sequence>` 的 context 机制本身** | 它解决的是「组件树深处怎么拿到偏移」。我们是裸 canvas，函数调用时显式传 `localT` 更简单，也更不容易出错。借抽象（#6），不借实现。 | `core/src/Sequence.tsx` |
| **`premountFor` 预挂载** | 它存在是因为 React 组件挂载时才开始加载资源。我们的约定是在 `window.ready` 里全部预载，没有「挂载」这一步。 | 同上 |
| **Remotion 的 `spring()` / `measureSpring()`** | 见第 4 节：它是逐帧步进，每次调用 O(frame)，靠 memo 缓存撑性能；`measureSpring` 是线性扫描，扫到阈值后再要求「连续 20 帧都在阈值内」，这是启发式；没有过阻尼分支（ζ>1 时直接用了临界阻尼公式）；也不能按过冲反解。我们的 `settle`/`spring`/`springInfo` 全面更强。 | `core/src/spring/spring-utils.ts` `measure-spring.ts` |
| **Motion Canvas 的生成器时间线（`yield*`）** | 它不能随机访问：`PlaybackManager.seek()` 往回 seek 时会 `reset()` 场景，然后**从场景第一帧一路 `next()` 重放**到目标帧。这和我们「任意 t 精确求值」的契约正面冲突。它的好处（写起来像脚本）是拿可 seek 性换的。 | `core/src/app/PlaybackManager.ts` 第 83–108 行 |
| **Motion Canvas 的 signals 响应式图** | 本质是带依赖追踪的缓存，「外部观测不到」得靠框架保证。我们现在的判据是 seamcheck，引入一套响应式运行时，只是多一层要验证的东西。它的 `render()` 里「有 pending promise 就重画，最多 10 次」（`GeneratorScene.ts` 第 168–177 行）是 delayRender 的另一种做法，我们的 async seek 已经覆盖了。 | `core/src/scenes/GeneratorScene.ts` |
| **Revideo 的等长静态切片 + 每个 worker 一个 vite server** | 等长切片是被生成器不能随机访问逼出来的：每个 worker 都要先从头重放到自己的起点。我们是纯函数，可以用分片队列动态均衡（#2），一个静态 server 就够。 | `renderer/client/render.ts` `getWorkerFirstAndLastFrame` |
| **JPEG 当中间帧格式**（Remotion 视频渲染的默认值） | 实测只比 PNG 快 12%（单页 36.4 对 32.5 fps；单浏览器 8 页 141 对 110）。代价是有损：压过一次 JPEG 再进 x264 是两代损失，文字边缘尤其明显。我们的验收门在像素层，也要求无损。省下的这点不值。 | `image-format.ts` `DEFAULT_VIDEO_IMAGE_FORMAT = 'jpeg'` |
| **Remotion 共享内存抓帧** | 需要他们自己打补丁的 Chromium（`--remotion-shared-memory-capture`，`remotion-shared-memory.ts`），我们够不着。#2 的多进程已经足够快，下一个瓶颈在编码。 | `open-browser.ts` |
| **Lambda / 云端分布式** | 本机 8 浏览器已经到 368 fps，30 秒 60 fps 的片子截图只要 5 秒。分布式解决的是我们没有的问题。值得借的只有它的「分片 + concat copy」（#3）。 | `packages/lambda` |
| **Manim 的「序列化场景状态」当缓存键** | 前提是动画能拆成可序列化的 `play()` 调用；我们的 `seek(t)` 是黑盒。改用输出像素哈希（#3）。 | `manim/utils/hashing.py` |
| **Theatre.js 整个引入** | 它的 sequence 求值本身应该能按 position seek（**未读源码，猜测**），但它带一个 studio UI 运行时，还有自己的对象模型。我们要的只是「编辑结果导出成数据」这个思路（#7 的 `offsets.json`）。 | 文档 |
| **Rive 状态机** | **未读源码。** 据我对 Rive 运行时 API 的了解（`advance(elapsedSeconds)` 推进状态机），状态机由输入加经过的时间驱动，是有状态的，不满足纯函数契约。线性动画（不带状态机）可能可以按时间 apply，没验证。 | 猜测，需要查证 |
| **p5.js `saveFrames`** | **未读源码。** 据文档，它是在 `draw()` 循环里实时录若干秒，帧依赖循环推进的状态，和我们的契约正好相反。 | 猜测 |
| **FFCreator / editly** | **没调研**，时间都给了 Remotion。 | — |

---

## 3. 三个问题的答案

### A. 「乱序求值逐像素一致」这条门，有没有同类项目在做？

> **第二轮更正（见 5.0）**：下面"没找到"错在搜索范围。Remotion 的
> `packages/it-tests/src/rendering/gsap-render-parity.test.ts` 就是一道串行 vs 并发 vs 乱序 `renderStill`
> 的像素比对——但它只测 Remotion 自己的 GSAP 适配层 fixture，**不是给用户作品用的门**。
> 正确的说法是「Remotion 有这类测试，只用来测框架自己」。本节其余推理（用户侧靠 lint + 文档 + `--concurrency=1`）仍成立。

**在 Remotion 的源码里没找到。** 在 `packages/renderer/src` 和 `packages/core/src` 里 grep
`deterministic|out of order|shuffle`，只命中 `random.ts`、`random.test.ts`，以及音频相关的两处，没有任何渲染级的乱序像素比对。
Remotion 处理这件事靠的是：

- **静态 lint**：用了 `Math.random()` 就给 ESLint 警告（Remotion v4.1.4 引入，文档 https://remotion.dev/docs/random ）。
  第三方 `oxlint-plugin-react-doctor` 也有一条 `remotion-deterministic-randomness`。
- **文档加逃生口**：https://www.remotion.dev/docs/flickering 明确写了「tab 之间不共享状态，帧不按顺序渲，有的帧会被跳过或渲两次」，
  给的解法是从 `useCurrentFrame()` 派生一切；实在不行就用 `--concurrency=1`。**这个逃生口本身就说明，这类 bug 在他们用户那里真实存在，而且常见。**
- 渲染器内部也承认自己的组件不是帧精确的：`render-frames.ts` 第 405–407 行，为了降低 `<Html5Video>` 的闪烁，「按顺序渲」。

Motion Canvas、Revideo **结构上用不到这条门**：它们本来就顺序重放，不存在乱序求值。
Revideo 的并行是每个 worker 从头重放到自己的起点，再顺序渲染。

**结论：没人做，不是因为没必要，也不是因为难（我们已经做出来了），而是因为在他们的架构里，确定性是「用户的责任」。**
Remotion 选择用 lint 加文档加 `--concurrency=1` 把问题推给用户；我们把它变成了自动验收门。

**这条门对并行渲帧是不是必要前提？** 是，但要说准确是哪几条：

1. **门 1b（全新页面重新加载）是最关键的前提。** 并行渲染时，N 个页面各加载一次。加载时的任何不确定性
   （加载阶段的 `Math.random`、竞态的异步资源、没等的字体）都会让**不同页面产出不同的帧**，表现为成片按分片边界闪烁。
   这正是 Remotion flickering 文档描述的那类 bug。
2. **门 2（乱序）也是前提**：动态分片队列下，每个页面看到的是一串不连续的区间，和顺序扫描不一样。
3. **但现有的门有一个缺口**：门 2 只在**一个页面**里打乱了 8 个采样点。真实的并行渲染是**多个页面，各自走不同的子序列**。
   页面内带缓存的计算（ARCHITECTURE 允许「缓存，前提是外部观测不到」）如果有 bug，只在特定的访问序列下才暴露，8 个点未必采到。
   **#3 的帧哈希清单天然补上了这个缺口**：用 `--workers 1` 和 `--workers 8` 各渲一次，比较清单，就是「对整片、按真实的并行拓扑」做的门 2。
   建议做成 `seamcheck --parallel`：只比清单，不编码，以现在的速度也就几秒到几十秒。
   本次 `ident.mjs` 就是这个检查的原型：1×8 和 4×3 两种拓扑对串行，0/96 帧不同。

### B. 纯函数帧契约有没有被证明撑不住的场景？别人怎么绕的？

有。每一种的绕法本质都一样：**把「有历史的东西」挪到渲染之前算好，渲染时按 t 查表。**

| 场景 | 为什么撑不住 | 别人怎么绕 | 我们现状 |
|---|---|---|---|
| **视频素材解码** | `<video>.currentTime = x` 之后显示的帧不保证精确，而且是异步的 | Remotion `<OffthreadVideo>`：浏览器外用 ffmpeg 抽精确帧，经本地 HTTP 返回图片（`offthread-video-server.ts`）。连 Remotion 自己都在注释里承认 `<Html5Video>` 会闪（`render-frames.ts:405`） | **缺**，补 #9 |
| **长尾物理 / 迭代仿真** | 第 t 帧依赖前面所有步 | Motion Canvas 的做法是从场景开头重放（`PlaybackManager.seek`），代价是 seek 的复杂度是 O(n) | **已做对**：`film-physics/scripts/bake.mjs` 在 Node 里跑定步仿真，烘成 Float32 表，scene 里查表 |
| **Web Audio 可视化** | `AnalyserNode` 是实时流，有内部平滑状态 | Remotion 整段 `decodeAudioData`，按 frame 取窗口 FFT，平滑用相邻三帧平均（`media-utils/src/visualize-audio.ts`） | **缺**，补 #8 |
| **异步数据和资源** | 加载完成的时序不确定 | Remotion `delayRender` 加带标签的超时；Motion Canvas 的 render 一直重画到没有 pending promise 为止 | 部分有（`window.ready` 加 async seek），补 #4 |
| **CSS / WAAPI 动画** | 由墙钟驱动 | Remotion 直接不支持，文档让你改用 `useCurrentFrame` 派生（https://www.remotion.dev/docs/troubleshooting/css-animations ） | **我们做得更好**：`USES_WAAPI` 加 `playbackRate=0` 冻结 |
| **随机种子** | 每次加载都不同 | Remotion 用 `random(seed)` 无状态哈希；Motion Canvas 第一次用 `Math.random` 生成种子，然后**持久化**到场景的 `.meta` 文件（`SceneMetadata.ts:12` `seed: new MetaField('seed', Random.createSeed())`） | **已做对**：`seeded()` / `hash01()` |
| **浏览器光栅化本身** | Chromium 一升级，抗锯齿和 Skia 输出就变；GPU 光栅化可能出错 | Remotion 钉 Chrome 版本（`BrowserFetcher.ts` `TESTED_VERSION`），Lambda 上关 GPU 光栅化（#11428） | **缺**，补 #5。这是 ARCHITECTURE §3「老片重渲不变」这个承诺里一个没覆盖的洞 |

**没找到「撑不住、只能放弃纯函数」的案例。** Remotion 生态里最复杂的视频、音频、Lottie、Three.js 集成，都是收敛到「预计算加按帧查」或者「用 delayRender 等异步就绪」。
（Lottie 的 `goToAndStop(frame, true)` 是可以按帧 seek 的；Remotion 的 `@remotion/lottie` 就是这么包的。这一条是根据记忆，**没读源码**，也没在本仓库实测。
文末「Motion Graphics 一轮」旧版写过"接进纯函数要整个重写"，那句是错的，已更正，以这里为准。）

### C. 有没有这类项目的标配，而我们完全缺席？

按重要性：

1. **并行渲染**：Remotion、Revideo 都有，我们没有（#2）。而且我们的契约天然支持，不做最可惜。
2. **能用的预览器**：Remotion Studio、Player，Motion Canvas 编辑器都有。我们连脚本都是死链接（#7）。
3. **可拖拽的时间事件，并且回写成数据**：Motion Canvas `EditableTimeEvents`、Theatre.js state JSON 都有。
   我们有 `vo.at()` 但不能微调（#7 第二步）。这是**我们完全没想到的一项**：音频先行解决了「对齐到词」，
   却没解决「人想让它比词早 80 ms」，而后者在剪辑里很常见。
4. **分片缓存和增量重渲的工具**：Manim 有，Remotion Lambda 有分片但不缓存。我们只有纪律（#3）。
5. **浏览器版本钉死**：Remotion 有，我们没有（#5）。
6. **渲染失败按帧重试 / 替换崩溃的页面**：Remotion 有（#11）。我们现在串行时问题不大，并行后就需要。
7. **组合子**（Sequence / Series / Loop / Freeze / playbackRate）：Remotion 有，我们只有 `wrap()`（#6）。

不算缺席、只是我们刻意不做的：React 组件模型、云端渲染、批量模板（#10）。

---

## 4. 我们已经做对的地方（同类项目也收敛到了同样方案）

| 我们的做法 | 同类项目的对应 | 说明 |
|---|---|---|
| `seek(t)` 纯函数 + 帧之间零依赖 | Remotion 整个架构就建在这上面：`useCurrentFrame()` 派生一切，flickering 文档把违反它列为头号 bug 来源 | 方向对。区别是我们**验证**它，Remotion 只**要求**它 |
| `seeded()` 用 mulberry32；`hash01(...keys)` 无状态哈希 | Remotion `core/src/random.ts`：**同样是 mulberry32**，`random(seed)` 也是无状态的（种子进，一个数出），字符串种子先 hashCode | 几乎逐字收敛 |
| 闭式解弹簧 `settle()`，再按 `{duration, overshoot}` 反解 | Remotion `spring({durationInFrames})` 先用 `measureSpring` 量出自然时长，再按比例拉伸时间轴（`spring/index.ts` 第 43–74 行） | 都收敛到「按时长指定弹簧」。我们的停止时刻是用二分法求出的精确最后越界时刻，Remotion 是「连续 20 帧在阈值内」的启发式；我们还多了过冲反解（闭式 ζ）和过阻尼分支 |
| 时长以 `window.DURATION`（来自 `narration.json` 实测）为准，`film.json` 只兜底 | Remotion `calculateMetadata()`：时长和尺寸在渲染前根据数据异步算出（文档） | 收敛。我们更进一步：时长绑定的是实测音频 |
| 物理先烘焙再查表（`film-physics/scripts/bake.mjs`） | Remotion 音频可视化先整段解码；`<OffthreadVideo>` 在浏览器外抽帧；Motion Canvas 反面教材（只能重放） | 收敛到「有历史的东西挪到渲染前」 |
| seek 期间探测禁用 API（`scene.mjs` 的 `PROBE`） | Remotion 只有静态 ESLint 规则 | 我们是运行时检测，能抓到第三方库内部的调用，lint 抓不到。更强 |
| 验收在 canvas 像素层，不比 mp4 的 md5 | 没找到同类做法 | 理由（H.264 残差噪声）成立，#3 的帧哈希清单正好建在这个判断上 |
| WAAPI 用 `playbackRate=0` 冻结 | Remotion 直接说 CSS 动画不支持 | 我们多支持了一类场景 |
| runtime 拷贝进片子目录，钉版本 | Remotion 把 Chrome 版本钉在 renderer 版本上 | 思路一致，但我们只钉了 JS，没钉浏览器（#5） |
| 音频单独最后合流（`mux.sh`），视频无声渲染 | Remotion Lambda 为了分片拼接，不得不处理无缝 AAC（`seamless-aac-trim.ts`、`can-concat-seamlessly.ts`） | 我们的分离让 #3 的分片拼接简单得多，这是一个**事后才看出来的好决定** |
| 帧数用 ffprobe `nb_read_frames` 校验 | Remotion 渲染路径上没有这种逐帧计数校验（没找到） | 比它严 |

---

## 5. 第二轮：验证「渲出来的确实是想要的」

第一轮比的是渲染性能，这一轮比的是 INTEGRATION.md「验证门本身的六个盲区」那一类问题：
**门测的量，和它的提示语让人以为它测的量，不是同一个。**

新读的源码都在 `scratchpad/oss2/` 下（只读，没有构建、没有执行里面的任何脚本）：

| 项目 | 版本 | 读了什么 |
|---|---|---|
| Remotion | `f29e9f3`（同第一轮） | `packages/it-tests/src/rendering/`（`gsap-render-parity.test.ts` `frame-accuracy.test.ts` `test-utils.ts`）、`packages/example/e2e/`、`packages/core/src/{freeze.tsx,use-current-frame.ts,Sequence.tsx}`、`packages/eslint-plugin/src/rules/`；文档 `testing.mdx` `flickering.mdx` `use-current-frame.mdx` `fonts.mdx` `lambda/runtime.mdx` `videos/different-segments-at-different-speeds.mdx` |
| Motion Canvas | `7b91435`（同第一轮） | `packages/e2e/`、`packages/core/src/**/*.test.ts`、`app/PlaybackManager.ts`、`threading/Thread.ts`、`scenes/Inspectable.ts` |
| Revideo | `b5de67a`（同第一轮） | `packages/e2e/`（和 Motion Canvas 的同名文件只差一行 import） |
| Manim CE | `3e19ee0`（2026-10-20） | `manim/utils/testing/`（`frames_comparison.py` `_frames_testers.py` `_test_class_makers.py`、两个 cfg）、`tests/test_graphical_units/`、`tests/utils/video_tester.py`、`manim/animation/speedmodifier.py`、`.github/workflows/ci.yml`、`.github/scripts/ci_build_cairo.py`、`docs/source/contributing/testing.rst` |
| Playwright | `89cd2a6`（2026-10-20） | `packages/utils/comparators.ts`、`packages/utils/image_tools/compare.ts`、`packages/playwright-core/src/server/page.ts`（`expectScreenshot`）、`tests/image_tools/`、`docs/src/test-snapshots-js.md` |
| pixelmatch | `ab76f52`（v8.0.0） | `index.js` `README.md` |
| jest-image-snapshot | `1a9a025` | `src/index.js` `src/diff-snapshot.js` |
| BackstopJS | `a11d365` | `core/util/compare/` `core/util/engineTools.js` `README.md` |
| reg-suit | `5c09c8e` | `packages/reg-suit-core/src/` `packages/reg-suit-interface/src/core.ts` `README.md` |
| Chromatic | — | 只读了文档 https://www.chromatic.com/docs/threshold/ |
| Percy | — | **没拿到官方文档**，只有 BrowserStack 营销页和第三方博客；下文涉及 Percy 的都标了 |

**没查的**：Lottie / Rive / Theatre.js 自己怎么测、diagrams-as-code 类项目、AE time remapping 的官方文档
（下文 AE 一条标了「凭常识，未查证」）。问题里点名的「Diagrams / animation 领域别的做法」这一项**查不到 / 没查**。

实测脚本在 `<scratchpad>/oss2-scripts/`（`fx.cjs` `pm.cjs`）。
用的是**本仓库 `node_modules` 里 Playwright 1.64.1 的比较器**；输入是 Playwright 仓库自带的比较器夹具 PNG（只当数据读）。

### 5.0 先更正第一轮的一条结论

§3.A 写的是「Remotion 源码里没找到乱序像素比对」。**这条错了，错在搜索范围**：
第一轮只 grep 了 `packages/renderer/src` 和 `packages/core/src`。
`packages/it-tests/src/rendering/gsap-render-parity.test.ts`（300 行）里就有一道串行 + 并发 + 乱序 + 重复的像素门：

- 同一个 composition，`renderFrames` 用 `concurrency: 1` 渲全片，再用 `min(8, availableParallelism())` 并发渲全片，
  逐帧 `pixelmatch(..., {threshold: 0})` 要求 0；
- 再按 `[84, 30, 9, 64, 10, 45, 29, 23, 16, 44, 0, 59, 15]` 这个打乱的顺序逐帧 `renderStill`，和并发结果比；
- 同一帧 `renderStill` 两次，比一次。

但它的定位要说准：**这是 Remotion 给自己的 GSAP 适配层写的 CI 回归测试**，跑在固定的 `packages/example/src/Gsap/*` fixture 上，
**不是用户作品能用的门**。用户侧仍然只有 lint、flickering 文档和 `--concurrency=1`。所以 §3.A 的结论应改成：
「Remotion 有乱序像素比对，但只用来测框架自己，没有交给用户」。
INTEGRATION.md「开源项目比对」一节那句「Remotion 没有乱序求值的像素门」需要同样改（那个文件不在本次修改范围内）。

还有一处细节：它写的 `threshold: 0` **不等于逐像素相等**，见 5.1「前端视觉回归生态」的实测。

### 5.1 问题 1：怎么验证"渲出来的东西确实是想要的"

**先给总结论。查到的所有项目只做两件事：**

- **(a) 回归**：和一份**人看过、批准过**的基准比（Manim 的 `.npz`、Playwright/jest-image-snapshot/Backstop/reg-suit 的基准图）。
- **(b) 框架自测**：用作者能**独立算出答案**的人造 fixture，测框架 API 的语义（Remotion 的帧号编码成颜色、已知时刻的已知像素值；Motion Canvas 的 tween 时长）。

**没有一个项目对「用户自己的作品」做「对照规格的内容断言」。** 我们的 `claims` + `probe(t)` / `pixels`，在调研范围内没有对应物。

两种可能都要摆出来：

- **这是真空白**。我们的前提和它们都不一样：
  1. 每支片子都是新的，第一次渲染就没有基准。**回归测试对"第一次就错"毫无检出力**。门 5 + 清单对账也一样，它对照的是上一次渲染，不是规格。
  2. 作者是模型，不是一个会逐帧看自己作品的人。Manim 和 Playwright 的 oracle 都是「人在 `--set_test` / `--update-snapshots` 那一刻看过」。
  3. 旁白给出了**带时刻、可以机检的命题**（"一辆传一辆"），UI 回归和数学动画都没有这种规格来源。
- **这是我们想多了**。业界真正的 oracle 一直是"人看"，而我们已经有静帧闸门和接触印相。
  对手钉曲线的片子，claims 验的就是作者自己写的那条曲线（film-storyboard 自己也写了：改钉点测试过了就不要写 probe）。

**我的判断：是真空白，但很窄。** 只有画面状态**不是作者直接钉出来的**片子（物理、涌现、仿真、时间映射）才需要。
ghost-jam 就是这类片子：真实仿真里 s4 开头 0.60 s 一盏灯都没有，而 `check_shotlist` 全绿、作者自写的 `simcheck` 也放过了
（INTEGRATION「分镜断言验的是作者的意图」一节）。0.6 秒的缺口，3–5 张静帧也很可能抽不到（推断，没有回放当时的静帧验证）。
所以：**保留现有的 claims + probe 机制，不要往"通用内容断言"扩。** 扩下去就会变成 Playwright 那种要人批准基准的回归系统，而我们没有那个人。

#### Remotion

- **他们怎么做**：
  - **面向用户的只有一种**：`docs/testing.mdx` 教你用 `<Thumbnail component frameToDisplay={10} noSuspense>` 加 `renderToString`，
    在 Bun + Happy DOM 里 `expect(html).toContain('<div>We are on frame 10</div>')`，断言**某一帧的 DOM 标记**。
    文档自己说这个办法 "not the most sophisticated"。**没有像素级的官方断言方案，也没有集成任何视觉回归工具。**
  - **框架自测里有两种内容断言，都值得细看**（`packages/it-tests/src/rendering/`）：
    1. **把答案编码进内容**（`frame-accuracy.test.ts` + `test-utils.ts`）：嵌入视频的第 k 帧是一块纯色，
       颜色由 `random(\`red-${k}\`)` 这类种子算出。渲完读输出帧左上角像素，和期望色比，任一通道差 > 35/255 就记一帧"错帧"
       （注释：编码会让颜色轻微偏移）。断言：`<Video>` 100 帧里错帧 ≤ 8，`<OffthreadVideo>` 必须 0。
       `getMissedFramesWithPlaybackrate` 用同一招测 4× 播放速率：输出第 k 帧应该是源视频的第 4k 帧。
    2. **已知时刻的已知值（锚点）**：`gsap-render-parity.test.ts` 的第二个用例读 (50,50) 像素：
       第 0 帧 `[0,0,0,255]`、30 fps 下第 12 帧 `[102,0,0,255]`、第 59 帧 `[255,0,0,255]`。
       102 = 0.4 × 255，是测试作者独立算出来的，不是从渲染结果里抄来的。
  - **社区一般怎么做：查不到。** 搜 Remotion + renderStill + visual regression，只找到通用的 jest-image-snapshot 教程，
    没有 Remotion 专用的方案或讨论。`renderStill` 加任意像素比较器在机制上可行，但我没找到有人公开这么做。
- **我们怎么做**：`claims` 的 `source: scene` 由 `check.mjs` 逐帧调 `window.probe(t)` 取真实状态
  （相当于 Remotion 的 DOM 断言，只是取场景状态而不是 DOM）；`source: pixels` 截帧数像素（相当于它的 `pixelAt`）。
  物理片还有 F 组旁白锚点断言（"锚点前没车停 / 锚点后停过"，见 `film-physics/references/timemap.md`）。
- **结论**：
  - **「把答案编码进内容」：值得借鉴，但只借进工具自测（见 5.4 V2）。**
    我们的渲染管线（分片、并行、子帧运动模糊的 `tmix`、concat copy、缓存复用）现在靠"和串行比哈希"证明正确。
    这只证明**一致**，不证明帧放对了位置：拼接掉一帧、重一帧、错位一帧，串行和并行会**一样错**，门 4 抓不到。
    做一支测试片：第 k 帧画颜色 `hash(k)`，角上画 k 的二进制粗块条码；渲成 mp4，解码后逐帧读回。
    Remotion 用 35/255 的容差，是因为它的链路上有 jpeg 和 h264。我们读回 mp4 也要有容差，条码块要粗（≥ 8×8），
    这样才扛得住 yuv420 的色度下采样。
  - **「锚点」：我们已经有，而且做在作品层面**（F 组）。Remotion 只在框架 fixture 里做。
    但这**不算我们更好**：它的用户是在 Studio 里看着画面写代码的人，不需要作品层面的锚点。
  - **官方的 DOM 断言：不借鉴，前提不同**。我们是裸 canvas，没有 DOM 可断言；`probe(t)` 就是它的对应物。

#### Motion Canvas / Revideo

- **他们怎么做**：
  - **e2e**（`packages/e2e/src/rendering.test.ts`；Revideo 的同名文件只差一行 import）：
    用 **Firefox**（`app.ts`：`firefox.launch`）起编辑器，点渲染按钮，然后**每个场景只读 `000000.png`，也就是第一帧**，
    用 `toMatchImageSnapshot` 和 `__image_snapshots__/{circle,rect}.png` 比。两个场景都是静态的（`circle.tsx` 只有一个 `yield`）。
    jest-image-snapshot 的默认值：`failureThreshold: 0`（按像素数，`src/index.js:157`），pixelmatch `threshold: 0.01`（`src/diff-snapshot.js:66`）。
  - **单元测试**（`core/src/**/*.test.ts`，约 20 个）：`tweening/tween.test.ts` 和 `flow/scheduling.test.ts` 里有
    "Framerate-independent tween duration"（同一个 `tween(3.1415)`，60 fps 和 24 fps 下结束时 `useTime()` 都 `toBeCloseTo(3.1415)`）
    和 "Accumulated time offset"（子帧余量的累计）。signals 有单测（`createSignal.test.ts` 等），测的是响应式图本身。
  - **某一时刻的状态能不能从外部查？能，但只有一条路**：`PlaybackManager.seek(frame)`（`app/PlaybackManager.ts:83–108`）
    往回 seek 时先 `reset()` 场景，再一路 `next()` 到目标帧。之后场景树里的节点是活对象，signal 可以直接读。
    编辑器的 `Inspectable` 接口（`scenes/Inspectable.ts`：`inspectPosition(x, y)` / `inspectAttributes(el)`）就是这么把属性给人看的。
    **没有给测试用的 API，e2e 也没用它。**
- **我们怎么做**：`probe(t)` 是场景的显式约定；`check.mjs` 在 708 帧上一次取完只要 0.02 s（INTEGRATION 实测）。
- **结论**：**不借鉴**。它的 e2e 只覆盖"两个静态场景的第一帧"，测的是渲染器能出图，不是动画内容。
  在它那里查任意时刻的状态，成本是 O(t) 的重放。"60/24 fps 时长不变"测的是框架的时间记账，我们对应的是 physcheck 的 E3，见 5.2。

#### Manim（这一条最值得细看）

- **他们怎么做**（`manim/utils/testing/`）：
  - **存什么**：测试函数加 `@frames_comparison`，`__module_test__` 决定目录。控制数据是
    `tests/test_graphical_units/control_data/<module>/<test>.npz`，内容是 **`np.savez_compressed` 存下来的解码后 uint8 RGBA 数组**
    （`_ControlDataWriter.save_contol_data`），不是 PNG 文件。仓库里共 237 个 `.npz`。
  - **默认只比最后一帧**（`last_frame=True`）：切到 `config_graphical_tests_monoframe.cfg`（854×480），强制 `frame_rate=1`、`dry_run=True`。
    `_make_test_scene_class` 在 `construct` 末尾补一次 `update_to_time(get_run_time(...))` 再渲一帧，注释说这是在补
    "normally the last frame is not the very end of the animation" 这个坑。
    docstring 自己警告：场景里有运动时，测试必须设 `last_frame=False`。
  - **多帧**（`last_frame=False`）：用 `config_graphical_tests_multiframes.cfg`，**427×240、6 fps**；
    `TestSceneFileWriter.write_frame` 每写一帧就 `check_frame(i, pixels)`。
    统计：`tests/` 下共 229 个 `@frames_comparison`，其中 69 个是多帧。**约 70% 的图形测试只看终态。**
  - **容差**（`_frames_testers.py`）：`np.testing.assert_allclose(frame, expected, atol=1.01)`，每个通道差 ≤ 1 不算错。
    超出时再数不匹配的**通道值**个数，比例 < `1e-5`（0.001%）就只发 warning 放行。
    注释写的是 "accounts for minor OS dependent inconsistencies"。
  - **帧数本身是断言**：`testing()` 退出时 `assert self._frames_compared == self._number_frames`，
    `check_frame` 里还有 `assert frame_number < self._number_frames`。多一帧、少一帧都红。
  - **跨平台**：CI 矩阵是 ubuntu-22.04 / macos-latest / windows-latest（`ci.yml:25`），**三个平台共用同一份 `.npz`**，
    靠上面的 atol 加比例容差吸收差异。Linux 和 macOS 上 Cairo 从源码编固定版本 1.18.0，并校验 sha256
    （`.github/scripts/ci_build_cairo.py:23`）；版本低于 `MIN_CAIRO_VERSION = 11800` 就 `pytest.skip`。
    `pytest_report_header` 把 Cairo 版本和 OpenGL 的 vendor/renderer 打在报告头上。
    图形测试里文字只有 2 个，都显式写 `font="Sans"`，注释是 "set both to a singular font so that the tests agree"。
  - **oracle 是人**：`docs/source/contributing/testing.rst` 要求 "After carefully checking that the rendered result is correct"
    之后才用 `--set_test` 生成控制数据，并提供 `scripts/extract_frames.py` 把 `.npz` 转成 PNG 给人看。失败时用 `--show_diff` 出差异图。
  - **视频层不比像素**：`tests/utils/video_tester.py` 的 `video_comparison` 只比 ffprobe 元数据
    （codec、宽高、`avg_frame_rate`、`duration`、`nb_frames`、`pix_fmt`）和 section 目录结构。
    文档给的理由是编码在不同系统之间会变。
- **我们怎么做**：门 1–4 在 canvas 层比**解码后的像素**，容差 0（`scene.mjs` 的 `makeComparer`：字节相同直接过，否则解码逐像素取最大通道差）。
  门 5 加清单对账比的是**截图 PNG 的 md5**，对账前先查设置和浏览器构建是否一致，不一致就明说"不对账"。
  成片层用 ffprobe `nb_read_frames` 校帧数，不比 mp4 的 md5。
- **结论**（分六点，各自结论不同）：
  1. **「存解码像素，不存 PNG」：收敛，谈不上谁借谁。** 我们是踩了三次坑才得出"判据不能是 PNG 字节"，Manim 一开始就存 uint8 数组。
     门 5 用 PNG md5 是一个**有意识的例外**：同一浏览器构建下 PNG 编码器是确定的，字节相同就意味着像素相同，
     方向是安全的（只会多报、不会漏报），而且构建不同时已经拒绝对账。保持现状。
  2. **「视频层只比元数据和帧数」：收敛**，和我们的 `nb_read_frames` 是同一个判断。
  3. **「atol = 1.01 + 1e-5 比例容差」：不借鉴，前提不同。** Manim 要拿**一份**基准跑三个操作系统，必须吸收 ±1 噪声。
     我们的门 1–5 全是"同机同构建自比"，默认路径实测 10 次整片渲染全一致，容差 0 可行。
     而且 INTEGRATION 里记的那类信号（143 vs 145 只差一条扫描线、最大 3/255）就在 atol 1 附近，给了容差就会被吞掉。
     **风险也要写下来**：Chromium 同机同构建也有 ±1 的非确定性（见下面 crbug-919955 夹具：8 个像素差 1/255）。
     哪天门 1a/1b 在默认路径上因为 ±1 偶发变红，正确的反应是先按这一类排查，而不是放宽到 1。
     要放宽，得先用正对照证明 ≤ 1 的差异里没有真信号。
  4. **「默认只测终态」「降分辨率加降帧率」：这是反面教材，正好对上我们两条盲区。**
     - 70% 的图形测试只看最后一帧，所以 `rate_func` 写错、`run_time` 写错这类"在错误的时刻播放正确的帧"的 bug，
       在这些测试里**结构上看不见**，因为终态是对的。这就是我们 `warp-inverted` 那一类。
     - 多帧测试是 427×240 / 6 fps：空间上约为 1080p 的 0.22 倍，时间上每秒 6 个采样。
       这和我们"0.5x 漏掉 1×1 / 2×2、≤ 3/255 的块"是同一个取舍，Manim 取得更狠，换来的是测试速度和 `.npz` 体积。
     - **这算我们做得更好吗？只在一点上算**：我们把缩放损失的检出力实测出来，写进了门 5 的说明；Manim 没有记录这个取舍的检出力（查不到）。
       但 Manim 不需要，它测的是几何原语，1 像素级别的回归不是它关心的。所以这条**不算"我们更好"，只是需求不同**。
  5. **「帧数是断言的一部分」：已有，只差一句提示语。** 我核了 `seamcheck.mjs` 第 275–279 行：帧数在对账的键里，
     清单帧数和这次不同时，走的是「设置不同，不对账」分支——这是对的，因为我们的清单不是规格，时长变了只说明旧成片过期了。
     **Manim 判红是因为它的控制数据就是规格，这个前提我们没有，所以不借"判红"。**
     可以借的只是把"帧数不同"从"设置不同"里单独拎出来说："时长变了（旧 N 帧 → 新 M 帧），上次的成片已过期"。几行，低优先级。
  6. **「oracle 是人在 `--set_test` 时看过」：不借鉴，也借不了。** 这正是总结论里我们缺的那个人。
     我们的对应物是静帧闸门和接触印相，它们是抽样，所以 claims + probe 才有存在的理由。

#### 前端视觉回归生态

- **他们怎么做**（默认值都是从源码或官方文档读的）：

  | 工具 | 比较方式 | 默认容差 | 抗锯齿 | 跨平台 |
  |---|---|---|---|---|
  | Playwright `toHaveScreenshot` | `packages/utils/comparators.ts`：解码后用 pixelmatch；可选 `comparator: 'ssim-cie94'` | pixelmatch `threshold 0.2`（感知色差），`maxDiffPixels` 默认 0 | pixelmatch 默认识别并**忽略**抗锯齿像素。`ssim-cie94`（`image_tools/compare.ts`）先放过 ΔE94 ≤ 1.0（"刚好可察觉"）的像素，3×3 方差为 0 的算实心区直接判不同，其余用 15 像素窗口 SSIM ≥ 0.99 判为抗锯齿 | 基准文件名带浏览器和平台（`example-test-1-chromium-darwin.png`）。文档列的变化来源：host OS、版本、设置、硬件、电源（电池还是插电）、headless 模式 |
  | Playwright 的"稳定截图" | `server/page.ts` 的 `expectScreenshot`：按 `[0, 100, 250, 500]` ms 间隔反复截，**连续两张相同**才拿去和基准比 | — | — | 超时报 "Failed to take two consecutive stable screenshots." |
  | jest-image-snapshot（Motion Canvas / Revideo 用它） | pixelmatch 或 ssim | `threshold 0.01`，`failureThreshold 0`（像素） | 同 pixelmatch | 有 `blur` 选项，默认 0 |
  | BackstopJS | `core/util/compare/compare.js`：**先比文件 md5**，相同直接过；不同再交给 resemble.js | `misMatchThreshold 0.1`（百分比，`engineTools.js:9`），`requireSameDimensions` 默认 true | resemble 的 `ignoreAntialiasing` 可选 | `--docker`：用版本跟 `package.json` 一致的 BackstopJS 镜像渲染，README 说目的是消除跨平台渲染差异 |
  | reg-suit | img-diff-js | `matchingThreshold 0`、`thresholdRate 0`、`thresholdPixel 0` | `enableAntialias` 默认 **false**，即默认**不**忽略抗锯齿，几个工具里最严 | 没有内建方案（没查到） |
  | Chromatic | 云端渲染，YIQ 色差 | `diffThreshold 0.063` | 默认检测并忽略抗锯齿。文档承认这会让**单像素变化漏报**，为此提供 `diffIncludeAntiAliasing: true` | 自家云端浏览器 |
  | Percy | 上传 DOM，在自家浏览器里重渲 | 查不到官方数字 | 第三方页面说它忽略孤立的 1px 差异 | 同上。**这一行全部来自营销页和博客，不是官方文档** |

- **实测**：Playwright 仓库的 `tests/image_tools/fixtures/` 是一套**比较器自己的正反对照夹具**，每个夹具目录有 README 写出处：
  `should-match/`（WebKit Linux 渲染伪影、Chromium 同机非确定性 crbug-919955、抗锯齿样本、looks-same 库的用例）和
  `should-fail/`（一个红像素、少一个光标、两种 SSIM 陷阱：灰度 SSIM 认为相同的彩色图、Julia SSIM 认为相同的白图和灰图）。
  我用本仓库 Playwright 1.64.1 的比较器和一个逐像素脚本跑了一遍：

  | 夹具 | 尺寸 | 逐像素不同 | 最大差 | 我们的门（容差 0） | pixelmatch 0.2（Playwright 默认） | pixelmatch 0（Remotion 的写法） | ssim-cie94 |
  |---|---|---|---|---|---|---|---|
  | should-fail / single-red-pixel | 736×684 | 1 | 250 | 红 | 红 | 红 | 红 |
  | should-fail / no-caret | 176×26 | 1 | 255 | 红 | 红 | 红 | 红 |
  | should-fail / julia-ssim-trap（白 vs 灰，整幅差 8/255） | 20×20 | 400（100%） | 8 | 红 | **绿（漏报）** | 红 | 红 |
  | should-match / crbug-919955 example-1 | 800×184 | 8 | 1 | 红 | 绿 | **绿（8 个全被当成抗锯齿剔掉）** | 绿 |
  | should-match / crbug-919955 example-2 | 22×22 | 15 | 1 | 红 | 绿 | 红（只数到 6 个） | 绿 |
  | should-match / webkit-four-pixels | 45×35 | 4 | 25 | 红 | 绿 | 红 | 绿 |
  | should-match / antialiasing-tolerance-2 | 24×18 | 51 | 10 | 红 | 绿 | 红（只数到 19 个） | 绿 |

  读出三件事：
  1. **Playwright 默认的 0.2 会放过"整幅画面亮度偏 8/255"**（julia-ssim-trap）。对 UI 无所谓，对影片就是一次可见的调色漂移。
  2. **pixelmatch 的 `threshold: 0` 不是"逐像素相等"**：它默认仍然把判成抗锯齿的像素剔掉（`includeAA=false`）。
     crbug example-1 的 8 个差异像素全被剔掉，example-2 的 15 个剔掉 9 个。
     所以 Remotion `gsap-render-parity` 断言的"0 个不同"，实际是"0 个非抗锯齿的不同"。
     （注意：我跑的是 Playwright 内置的 pixelmatch，Remotion 依赖的是 `pixelmatch@7.1.0`。
     两者 `includeAA` 默认都是 false，抗锯齿判定同源，但版本不同，数字只能当量级参考。）
  3. **Chromium 同机同构建也会有 ±1 的非确定性**（crbug-919955，最大差 1/255）。我们容差 0 的门遇到它会红。
     这是我们这些门真实存在的误报来源候选，只是默认路径实测还没撞上（10/10 一致）。

- **我们怎么做**：容差 0、比解码像素、字节相同走快路径（`makeComparer`）；门 5 可以在 0.5x 下比 PNG md5；
  "再渲一遍比对"已经在 INTEGRATION 里写明：它测的是一致性，不是正确性。
- **结论**：
  - **「字节相同就跳过解码」：收敛。** BackstopJS 的 `compare-hash` → `compare-resemble`，和我们的 `a.equals(b)` → 解码，是同一个两段式。
  - **「连续两张截图相同才算稳定」：收敛，它的局限也和我们第六个盲区一模一样。**
    Playwright 用它**等页面稳定**，不用它判对错，判对错靠的是和基准比；它从不把"稳定"说成"正确"。
    我们那张盲区表里"再渲一遍比对：测的是两次是否一致，不是这次是好的"是同一个结论，只是我们是撞上纯白帧之后才写下来的。不算谁更好。
  - **抗锯齿剔除和感知阈值：不借鉴。** 它们全是在解决"一份基准要能跨机器、跨 GPU、跨字体栈复用"。
    这个问题我们用"同机自比，指纹不同就不对账"绕开了。而它们付出的代价正好是我们最在意的信号：
    Chromatic 自己承认单像素变化会漏，pixelmatch 0 也会剔掉 1 像素的线。
    我们的门比它们严，**这是需求不同，不是"我们更好"**：它们要的是几百个组件、几十种平台组合下误报低；
    我们要的是一支片子、一台机器上零漏报。
  - **「比较器自己的正反对照夹具」：值得借鉴，这是这一节里最该抄的一条（5.4 V1）。**
    Playwright 不是只给比较器写单元测试，而是收集了**真实世界里应该判相同的差异**（WebKit 伪影、Chromium 非确定性、抗锯齿）
    和**应该判不同的陷阱**（单像素、SSIM 陷阱），每个夹具配一个 README 写出处。
    这就是 INTEGRATION 那条通则的工具化：「每加一道门，要能回答它会漏掉哪一类违约」，夹具是这个答案的可执行形式。
    我们的对应物现在是散的：`warp-inverted.html`、`replay-leak-rng.html`、门 5 那组 1×1 / 2×2 / 4×4 合成块、`_test-physics` 里几支泄漏样本，
    各自只在当初那一次实验里跑过。

### 5.2 问题 2：时间重映射（仿真时间 ≠ 影片时间）

**总结论：有时间重映射概念的项目（Remotion、Manim、AE），没有一个检测"映射本身传反了 / 忘了传"。**
它们的做法是：靠 API 的形状让这类错误难写出来，再加框架自测里的不变性测试。用户作品层面一律不检测。

我们的 E 组是查到的唯一一个在作品层面查这件事的。但要诚实写清：**E4 守的是"声明的映射 = 实际用的映射"，
声明本身写错了，它照样绿。** 这一层目前只有人看。

#### Remotion

- **他们怎么做**：
  - **概念**：`<Sequence from durationInFrames trimBefore playbackRate>`、`<Loop>`、`<Freeze frame active>`、`<Series>`。
    所有重映射都发生在 `useCurrentFrame()` 这一个点上：`(frame - (cumulatedFrom + relativeFrom)) * playbackRate`（`core/src/use-current-frame.ts`）。
    `<Freeze>` 把 `TimelineContext` 换成冻结的那一份（`freeze.tsx`：`frameToFreeze / playbackRate + relativeFrom`，
    注释 "Advancing the outer timeline must not invalidate the frozen clock"）。
    **不支持任意曲线重映射**。分段变速是文档里的一段手写 snippet（`docs/videos/different-segments-at-different-speeds.mdx`）：
    按段累加时长，每段一个 `<Series.Sequence>`，配 `trimBefore` 和 `playbackRate`。
  - **防错靠 API 形状**：组件里**拿不到绝对帧**。`docs/use-current-frame.mdx`「Getting the absolute frame of the timeline」一节的办法是：
    在顶层组件里调 `useCurrentFrame()`，再当 prop 往下传。也就是说，在 Remotion 里"忘了映射"很难写出来——
    在 Sequence 里你只能拿到局部时间。代价是想要绝对时间时得手动穿透。
  - **参数校验**：`Sequence.tsx` 约 20 处 `TypeError`（`playbackRate` 必须是正的有限数、`from` 必须有限、`trimBefore ≥ 0`……），
    `freeze.tsx` 4 处（缺 `frame`、不是数字、NaN、不是有限数）。全是类型和范围校验，不涉及语义。
  - **框架自测里的不变性**：`gsap-render-parity.test.ts` 的第二个用例——同一个动画在 24 / 30 / 60 fps 下取 0.5 s 那一帧
    （第 12 / 15 / 30 帧）必须像素相同；放进 `<Sequence>`、嵌套 `<Sequence>` 里取对应的帧，也必须和顶层相同；
    再加第 0 / 12 / 59 帧三个锚点像素值。`test-utils.ts` 的 `getMissedFramesWithPlaybackrate` 测 4× 下输出第 k 帧等于源第 4k 帧。
    e2e `sequence-playback-rate.test.mts` 测 Studio 里裁剪、移动一个 2× 父序列下的子序列之后，界面上显示的 "Local frame: 14" 不变——
    这是**给人看的局部时间读数**。
  - **用户作品层面：不检测。**
- **我们怎么做**：`physcheck` 的 E 组（场景声明了 `window.PHYS.timeMap` 才跑）：
  E1 `S(t)` 是纯函数；E2 步号单调（声明了 reverse 的倒放例外）；E3 不顿帧（慢镜头下仿真查询栅格太粗）；
  E4 在 `seek(t)` 之后读 replay 的 `stats.lastN`，和 `stepsAt(S(t))` 比——**插桩生产路径**，抓"传反了 / 忘了映射 / 用了 S.inv"。
  另有 F 组旁白锚点断言。
- **结论**：
  - **「拿不到绝对时间」这种 API 形状：值得借一半（5.4 V3）。**
    借的是"镜头函数只收 localT"——§1 #6 的 `shot()` 已经是这个思路。对应到仿真：`stateAt` 的调用方**不该直接拿到影片 t**，
    应该由 runtime 用声明过的 `timeMap` 换算好再喂进去（`replay.at(t)` 内部做 `stateAt(S(t))`，场景代码不碰 S）。
    这样"忘了传"和"传了 S.inv"在写法上就不存在了，E4 从"抓错"降级为"防回归"。
    **另一半不借**：Remotion 能完全藏住，是因为它只有一种时间（帧）。我们有影片时间和仿真时间两种，
    仿真参数（扰动时刻这类）本来就必须写成 `S(vo.at('轻'))`，S 没法完全藏起来。
  - **fps 不变性（同一秒、不同 fps → 同一帧）：值得借鉴，代价很低，但只对一类片子有意义（5.4 V4）。**
    我们的 `seek(t)` 收的是秒，纯手钉曲线的片子这条天然成立，测了白测。
    有意义的是**读了 fps 的代码路径**：`replay.js` 的 `stepsAt = round(t·fps)·substeps`（这个 fps 是仿真查询栅格，
    `timemap.md` 专门写过它"恰好等于影片 fps，只是因为默认 S(t) = t"），以及任何用 `Math.round(t * FPS)` 查表的场景
    （§1 #9 的视频抽帧、`bake.mjs` 烘出来的表）。把 `film.json` 的 fps 从 30 改成 60，渲几个时刻比同一 t 的像素，
    混淆了"影片帧"和"仿真步 / 表格行"的代码会在这里露馅。它和 E3 不重叠：E3 查栅格够不够细，不查单位有没有用错。
    **我没有构造反例验证它真能抓到我们代码里的某个 bug，这一条是推断。**
  - **锚点：已有**（F 组），不重复。
  - **「Local frame」读数：值得借进预览器（5.4 V5）。** `preview.mjs`（§1 #7）显示当前 t 时，同时显示每个声明了 timeMap 的仿真的 `S(t)`（仿真秒）。
    人拖时间轴时一眼能看出"影片 3 s 处仿真才走了 0.4 s"。**映射声明本身写错时，所有自动门都绿，这是唯一能帮上忙的东西。**

#### Motion Canvas / Revideo

- **他们怎么做**：**没有"场景内时间重映射"这个概念。** 时间是生成器每次 `next()` 时 `Thread.update(dt)` 累加出来的
  （`threading/Thread.ts`：`time` signal 和 `fixedTime`；后者是帧时长的整数倍，用来补"tween 时长不是帧时长整数倍"的余量）。
  `PlaybackManager.speed` 只影响预览时每次前进几帧（`this.frame += this.speed`），`recalculate()` 算时长时强制设成 1；`Renderer.ts` 里没有引用 `speed`。
  时间正确性靠的就是上面那几个 "Framerate-independent" / "Accumulated time offset" 单测。
- **结论**：**不借鉴。** 时间是隐式累加的，根本不存在"传错映射"这类 bug，取而代之的是"子帧余量累计错"，它用单测守。
  我们的 E3 对应同一族问题（栅格和量化），已经有了。

#### Manim

- **他们怎么做**：`ChangeSpeed(anim, speedinfo={0.3: 1, 0.4: 0.1, 0.6: 0.1, 1: 1})`（`manim/animation/speedmodifier.py`）：
  键是 run_time 的百分比，值是速度倍率，段间线性插值，积分出新的总时长和 `rate_func`。
  校验：缺 0 / 1 节点自动补；`assert ChangeSpeed.is_changing_dt is False`，禁止嵌套（因为 dt 是全局类变量）。
  检测：`tests/test_graphical_units/test_speed.py` 一个多帧金样测试（6 fps、427×240），把映射后的整段帧序列钉住。
- **结论**：**不借鉴，但它印证了一件事。** Manim 70% 的图形测试只看终态，而时间映射错误恰恰终态正确，
  所以它唯一的 ChangeSpeed 测试**必须**是多帧的，否则测了等于没测。
  这和我们"确定性门对时间映射全绿"是同一个结构性原因：**一道门只采样了它不会出错的那个量。**

#### After Effects time remapping（凭常识，未查证官方文档）

图层上一条可以打关键帧的属性：合成时间 → 图层源时间，在图表编辑器里看曲线。没有任何自动校验，靠人看曲线和预览。不展开。

### 5.3 问题 3：确定性

#### 「两次渲染是否一致」有什么保证或检查

- **Remotion**：
  - **用户侧**：`@remotion/eslint-plugin` 的 `deterministic-randomness`（`Math.random()`，报 "will change between frames while in rendering mode"）
    和 `non-pure-animation`（CSS `transition` 属性和 Tailwind 的 `transition-*` 类，报 "will lead to flickering"）。
    `docs/flickering.mdx` 给四条自检：同一帧多次调用画面相同、不依赖渲染顺序、暂停时不动、除了 `random()` 不用随机数。
    兜底是 `--concurrency=1`，文档自己说它不能完全解决问题，而且会挡住 Lambda。
    **`Date.now` / `performance.now` 没有 lint 规则**（`rules/` 下 16 条里没有，别处也没找到）。
  - **框架侧**：5.0 说的 `gsap-render-parity`，像素级，但只测框架 fixture，而且 pixelmatch 0 会剔掉抗锯齿像素。
  - **没有给用户的像素级门。**
- **Manim**：图形测试本身就是确定性门（同一份代码在三个 OS 上都要和同一份 `.npz` 吻合）；
  场景层面 `Scene(random_seed=...)` 默认取 `config.seed`（`scene.py:183–187`）。没有"同一场景渲两次比"的检查（查不到）。
- **Motion Canvas**：随机种子持久化进 `.meta`（第一轮已写）；没有像素级确定性门，e2e 只比两张静态首帧。
- **我们**：门 1a / 1b / 2 / 3 / 4 / 5，加禁用 API 的运行时探针。
- **结论：我们做得更好，这一条是真的。** 不是因为他们不需要：Remotion 有 flickering 文档、有 `--concurrency=1`，
  还给自己的 GSAP 适配层写了乱序并发像素测试——**说明他们需要，也知道怎么做，只是没交给用户**。
  我们把同一个测试变成了每支片子的验收门，还多了 1b（跨页面的加载期）和 5（跨启动）。
  这两条 Remotion 的框架测试也没有：它的 parity 测试全程复用同一个 `puppeteerInstance`。

#### 浏览器构建形态 / 版本导致像素不同；字体打包是不是通用做法

- **他们怎么做**：
  - **Remotion**：钉 chrome-headless-shell 版本（第一轮 #5）。字体：`docs/fonts.mdx` 给的三条路都是**随项目走的 web 字体**
    （`@remotion/google-fonts`、`@remotion/fonts` 的 `loadFont({url: staticFile(...)})`、手写 `FontFace` 加 `delayRender`）。
    Lambda 运行时（`docs/lambda/runtime.mdx`）在层里**打包了一组固定的 Noto 字体**：Noto Sans 各字重、Color Emoji、
    阿拉伯 / 天城 / 希伯来 / 泰米尔 / 泰文，以及**只在 arm64 上才有**的简中、繁中、日文、韩文。
    文档写明：要用别的字体，推荐用 Webfonts。
  - **Manim**：CI 从源码编固定版本的 Cairo；文字测试显式钉 `font="Sans"`。
  - **Playwright**：不消除差异，**按平台分基准**（`-chromium-darwin.png`）。
  - **BackstopJS**：`--docker`，镜像版本跟着 BackstopJS 版本走。
  - **Percy / Chromatic**：在自家云端浏览器里渲，把环境统一掉（Percy 部分来自营销页）。
- **我们怎么做**：钉 Playwright 精确版本；`film.json.renderer` 记指纹，指纹里带构建形态（用 CDP 的 `product` 区分 headless shell 和完整 Chrome）；
  指纹不同就告警，门 5 不对账；`font_source.mjs` 在渲染前查字体是否随片打包。
  实测：构建形态差异的全部原因是字体回退，打包之后最大差从 216/255 掉到 4/255。
- **结论**：
  - **字体打包：是通用做法，我们收敛了。** Remotion 在 Lambda 上替用户打包字体、文档推 web 字体；Manim 测试钉字体名。
    没有一个项目依赖"系统字体在两台机器上碰巧一样"。值得补一句：Remotion 的 CJK 字体**只在 arm64 层里有**，
    说明就算框架方替你打包，覆盖面也有边界。这正好支持我们把"字体必须随片打包"做成硬约束，而不是依赖环境。
  - **按平台分基准（Playwright）、用容器统一环境（Backstop、Percy、Chromatic）：不借鉴。** 它们都是为了跨机器复用同一份基准，
    而我们没有跨机器的基准（门全是同机自比），渲染本来就该在钉死的那一个构建上做。
    Docker 的 Linux 环境对我们反而意味着"换成 FreeType 字体栈"，也就是 ARCHITECTURE 里写的"测不到的那一侧"。
    哪天真要在 Linux CI 上渲片子，再回来看 Backstop 的做法。
  - **「构建形态是一条独立的轴」：我们做得更好，但范围很小。** 查到的项目要么钉版本、要么钉环境，
    **没有一个区分"同一版本的 headless shell 和完整 Chrome"**。Remotion 只下载 headless shell，所以不存在这个问题；
    Playwright 的基准按"浏览器名 + 平台"分，`chromium` 不分形态。我们是手动指定路径真撞上了才加的。
    "更好"成立的前提是：我们的环境里两种形态都可能被拿到。在只用一种形态的项目里，这根本不是问题。
  - **报告头打印渲染环境**（Manim 的 `pytest_report_header` 打 Cairo 版本和 GL renderer）：已有。
    `film.json.renderer` 加漂移告警比它多一步——它只打印，不比较。

### 5.4 汇总：这一轮借什么、不借什么

| # | 借什么 | 来自 | 补哪个盲区 | 代价 | 优先级 |
|---|---|---|---|---|---|
| V1 | **门的正反对照夹具**：`should-fail/<名>/` 每类违约一支小 scene，`should-pass/<名>/` 每类容易误报的正确 scene（例：首末帧本来就差约 8900 像素的正确循环片），各带 README 写违约类型、哪道门该红、出自哪次事故；由 `accept.mjs` 或 `selfcheck.mjs` 断言每道门的红绿 | Playwright `tests/image_tools/fixtures/` | 把"每道门会漏掉哪一类违约"变成可执行的；改门（放宽容差、加缩放、换哈希）时，检出力掉没掉立刻可见，不再靠一次性手工实验 | 收拢现有的散落反例，加约 60 行 runner，半天 | **高** |
| V2 | **把答案编码进内容的管线自测**：第 k 帧画颜色 `hash(k)` 加粗块条码，渲成 mp4，解码读回 | Remotion `frame-accuracy.test.ts` | 分片拼接掉帧、重帧、错位一帧——串行和并行一样错，门 4 抓不到 | 测试片约 30 行，读回约 40 行 | 中 |
| V3 | **runtime 替场景做 S(t) 换算**，场景代码不碰影片 t | Remotion "组件拿不到绝对帧" 的 API 形状 | "忘了传 / 传了 S.inv"从"写得出来、再被 E4 抓"变成"写不出来" | `replay.js` 约 15 行，加 `timemap.md` 的说明 | 中 |
| V4 | **fps 不变性**：同一 t 在 30 / 60 fps 下渲，比像素 | Remotion gsap parity 第二个用例、Motion Canvas tween 单测 | 混淆"影片帧"和"仿真步 / 表格行"的单位错误 | 约 30 行；**没构造反例验证过** | 低（只有仿真或查表的片子才跑） |
| V5 | **预览器同时显示每个仿真的 S(t)** | Remotion Studio 的 "Local frame" 读数 | 映射**声明本身**写错时，唯一的人眼兜底 | 约 10 行，跟 #7 一起做 | 低 |
| V6 | 门 5 对账时，把"帧数不同"从"设置不同"里单独拎出来说（"时长变了，上次成片已过期"），**不判红** | Manim `_frames_compared == _number_frames`（只借提示，不借判红：它的控制数据是规格，我们的清单不是） | 时长变了被笼统说成"设置不同" | 几行 | 低 |

**不借**：抗锯齿剔除和感知阈值（Playwright / pixelmatch / Chromatic）、atol = 1 的容差（Manim）、按平台分基准、Docker 或云端统一环境、
只测终态、降到 427×240 / 6 fps 来测、"人在 `--set_test` 时批准"这种 oracle、Motion Canvas 的 Inspectable 查询路径。理由见各条。

**我们做得更好的（诚实版本，只有两条）**：

1. **把乱序 / 并发 / 跨页面 / 跨启动的像素一致性，做成每支片子的验收门。** Remotion 有需要也有能力（给自己写了），但没交给用户。
2. **区分构建形态。** 仅限于"环境里两种形态都可能被拿到"这个前提。

**不是我们更好、只是需求不同的**：容差 0（它们要跨平台复用基准）；时间映射 E 组（它们的 API 让这类错误很难写出来，或者根本没有仿真时间）；
作品层面的锚点断言（它们只在框架 fixture 里需要）；把缩放损失的检出力量出来（Manim 测的是几何原语，不关心 1 像素级的回归）。

---

## 6. 第三轮：设计方法——Anthropic 的 frontend-design / canvas-design skill（2026-10-21）

这一轮借的不是代码，是**方法**。用户原话："Claude Design 的思想我觉得很重要，他避免了千篇一律的设计风格，
可以把这个 skill 依赖加到我们的设计环节甚至是脚本构思环节。"读的是两份原文：
`anthropic-agent-skills/skills/frontend-design/SKILL.md`（Design Thinking 一节）和 `canvas-design/SKILL.md`（设计哲学一节）。
落地在 `film-storyboard/references/divergence.md`，门在 `check_shotlist.py`，工具是 `film-storyboard/scripts/siblings.mjs`。

### 借了什么

| 来源 | 原文的意思 | 落到哪 |
|---|---|---|
| frontend-design · Purpose | 先想清楚它解决什么、给谁 | 已有：brief + 机制第 1 步（核心变量），没有新增 |
| frontend-design · Tone | 动手前选定一个鲜明的方向 | 视觉方向的发散：候选 0 = 默认长相，再 1–2 个，选一个（divergence §2） |
| frontend-design · Differentiation | "观众会记住的那一个东西是什么" | 每个视觉方向候选必填"最难忘的那一个东西"，判据问它是不是承重的那个 |
| frontend-design · *intentionality, not intensity* | 极简和繁复都成立，要的是故意 | 判据第 3 条；和 style_guide "每条都要有因为"是同一条规矩，所以直接接上 |
| frontend-design · 不同次生成不要收敛 | 每个设计都该不一样，跨次生成别收敛到同一套选择 | **改写成近作对照**（下面） |
| canvas-design · 给运动起名 + 宣言 | 先命名一个美学方向、写一段宣言，再表达 | 每个视觉方向候选必填名字（两到四个字）和一两句宣言 |
| （延伸）同一套方法用于脚本 | 两个 skill 都只管视觉 | 讲法的发散：候选 0 = 本题默认讲法，2–3 个结构不同类的讲法，两刀从机制来（divergence §1） |

### 改了什么，为什么

1. **禁令清单没搬。** frontend-design 点名了几种该躲开的字体和一种渐变配色，并给了一串语气菜单。
   本仓库铁律（`CLAUDE.md`）：skill 呈现能力，不规定风格；每条"不要 X"都要能改写成"X 的代价是 Y，什么时候值得付"。
   那张清单本质上是"上一代模型最常收敛到的长相"——它会过期，而且会把人推向清单外最顺手的下一个，
   这正是旧 `motion-reference` 的"默认片"警告失败的方式（film-storyboard SKILL.md 开头第 1 条）。
   改写成：**不规定选什么，只要求知道自己在重复什么**。任何选择本身都可用，代价是"和某支已有片子并排时像一个模板出来的"；
   系列片、brief 要求、机制逼出来的时候这个代价值得付，要声明。语气菜单改成了"长相的维度"表（调子/材质/镜头/字的身份/色），
   明说是查重用的、不是菜单——和机制那张视觉变量类表同一个处理。
2. **"不要收敛"从一句嘱咐变成了一个文件。** 模型不记得上一次生成了什么，跨次不收敛靠自觉做不到。
   所以加了 `siblings.mjs`（列其他片子的画幅、声明的方向、并排代表帧）和 style_guide 的「近作对照」一节，门查它点名了真实存在的片子。
3. **网页专属的部分全丢了**：CSS 变量、hover、滚动触发、React/Motion 库、页面加载的错峰入场——影片里没有对应物。
4. **canvas-design 的"反复强调匠心"没搬。** 那是提示语技巧，不是方法；本套件的质量判据是可执行的门和 film-critique 的打分项。
5. **没有硬依赖。** 两个 skill 都是外部插件；依赖它们会破坏"套件可整体拷到 `~/.claude/skills/` 单独用"。
   方法吸收进 divergence.md 并注明出处；装了那两个 skill 的话，它们的 Design Thinking 一节和本方法兼容，可以一起读。

### 实测出的一件事

样板 weiqi-intro 的视觉方向发散做得好（三个方向、各写输在哪、和前两支拉开的距离），而它的**讲法**正是候选 0 的形状：
历史（s1–s3）→ 气的规则（s4–s10）→ 两只眼（s11–s12）。brief 点名了"历史"和"气"，这条顺序大半是 brief 给的——
但没有任何一步记下"这是 brief 的约束还是默认"，下游分不出来。这是讲法这一步只先上警告（不是失败）的原因之一，见 INTEGRATION.md 第 27 条。

---

## 7. 第四轮：三维与特效——three.js、pmndrs/postprocessing、Theatre.js、shader 艺术（2026-10-21）

用户原话："我觉得需要 3d 能力，以及加特效，加比如镜头的变换……有那种玄幻的或者像是黑客帝国的那种高级感。""本质就是做 web 效果"。
落地在 film-webfx：`assets/runtime/three-film.*.js`（three.js 0.186.1 的帧契约版）、`stage3d.js`、`camrig.js`、`post3d.js`、`particles3d.js`，
工具 `scripts/vendor-three.mjs`、`scripts/bench3d.mjs`，文档 `film-webfx/references/three.md`。夹具 `tests/fixtures/_test-3d`，真片 `films/weiqi-fx-open`。

### 借了什么、改了什么、为什么

| 来源 | 借了什么 | 改了什么 | 为什么 |
|---|---|---|---|
| **three.js**（MIT，0.186.1，npm 包拷进片子） | 整个渲染器：场景图、PBR 材质、阴影、PMREM 环境、render target、ShaderMaterial | **打补丁**生成 three-film：`Clock`/`Timer`/`setAnimationLoop`/`compileAsync`/`Math.random` 系列用到就抛错；uuid 改成计数器；Loader 缓存回调改微任务。补丁按精确文本 + 次数匹配，上游一变脚本失败 | 原样拷，违约是静默的（`getDelta()` 照常返回一个数）；selfcheck 第 8 项也会判运行时含禁用 API。改成"用错当场抛错、错误信息写着该用什么" |
| three.js **官方 examples 的后期管线**（`EffectComposer` + `UnrealBloomPass` + `BokehPass` + godrays 例子） | 管线结构：场景渲进 RT → 一串全屏 pass → 上屏；UnrealBloom 的"多级下采样再逐级加回"；godrays 例子的径向模糊 | 不用 `EffectComposer` 本身：它构造时建一个 `Clock`，`render()` 不传 delta 就读墙钟。自己串 RT，每个 pass 是一个 ShaderMaterial | 帧契约：时间只从 t 进 |
| **pmndrs/postprocessing** | ① **把逐像素效果合进一个着色器**（EffectPass 的核心思想）② MipmapBlur 的 Jimenez 13 tap 下采样 + 帐篷上采样 ③ 效果参数化而不是写死 | 不依赖这个库（它的 EffectPass 内部累积 time）；合并在 `post3d.js` 的"合成一遍"里手写；参数**每帧全量传、没有默认值** | ① 是实测出来最值的一条：SwiftShader 下每个全屏遍都有固定成本，色差+颗粒+暗角+扫描线+故障分开是 5 遍，合进一遍只比单开一样多几 ms（bench3d）。参数不给默认：默认值就是默认审美 |
| **Theatre.js** 的时间轴思想 | ① 属性 = 关键帧序列，求值只看"序列位置"② **没上时间轴的属性取静态值** | ① → `camrig.track()`（关键帧 + 每段缓动，二分查段）② → `stage3d` 的**复位**：每帧先把整棵场景树复位到 `freeze()` 的静止姿态，这一帧没写的属性回到静态值 | ② 是三维里最要紧的一条：three 是保留式场景图，漏写一个属性就把上一帧带过来，门 1a/1b 都抓不到（阴性对照实测只有门 2 红）。Theatre 的语义正好消灭这一类 |
| **Gustafsson 2018**《Bokeh depth of field in a single pass》 | 单遍螺旋采样聚集：每个采样按自己的 CoC 判断能不能盖到中心；身后的采样 CoC 夹到中心的 2 倍 | 采样数换算到 RT 分辨率（采样数 ≈ (maxBlur·res)²/(2·step)，降分辨率直接省平方）；blur=0 整条跳过 | 近处的大虚化能盖到焦内物体上、焦内物体不糊进背景，一遍完成 |
| **GPU Gems 3 第 13 章**（体积光散射后期） | 从像素朝光源屏幕位置走 N 步、逐步衰减累加 | 光源在相机后面时不画（方向是反的）；亮部提取在 1/4 分辨率 | 便宜的光束 |
| **Jimenez 2014**（COD:AW 后期） | 13 tap 下采样核（中心盒 0.5 + 四角盒 0.125） | 原样 | 下采样不闪 |
| Awwwards 级 three.js 站点 / shader 艺术（Shadertoy 一类）的常见手法 | ① 程序化表面：图案写进材质而不是贴图 ② 闭式粒子（顶点着色器里算位置）③ 生成式纹理（fbm 木纹）加载时烘一次 | ① 用 `onBeforeCompile` 注入 PBR 材质（打光、阴影、景深照常作用在图案上）② 网页里粒子常按帧积分（`p += v·dt`），这里一律闭式：`lifecycle` / `rebirth` / `drift` ③ 用 webfx 的着色器层烘 | 网页作品跑在实时循环里，"上一帧"是免费的；影片不能有上一帧 |

### 明确没借的

- **实时站点的交互与滚动驱动**（鼠标视差、滚动触发、hover）：影片里没有对应物。
- **网页 shader 艺术里的 `iTime` 直接驱动一切**：在这里也是这么做的（u_time = t），但网页作品常在 JS 里累积相位、按帧积分粒子——那一半不能借。
- **"黑客帝国""辉光"作为默认组合**：夹具 `_test-3d` 里有数字雨 + 辉光，那是演示能力，不是推荐；SKILL.md 只给能力和代价表。
  `weiqi-fx-open` 的 style_guide 明说"不用色差、扫描线、故障"——同一套能力，不同的片子做相反的选择。

### 实测出的两件事

1. **"有没有积分"不是判据**：第一版积分阴性对照是 `p += v·dt`、v 常数，**过了全部门**——Σdt 伸缩成 t − t0，碰巧就是闭式解。
   只有速度依赖状态的积分才和求值顺序有关。判据仍然只有 seamcheck 门 2。
2. **对照片里"贵"来自光，不来自后期**：`weiqi-fx-open` 第一版亮度把木纹吃光、看起来像塑料；改的是灯的强度和锥角、加环境反射，
   后期参数几乎没动。后期在那支片里只做两件事：让唯一的高光真的发光（泛光）、让"焦点被拉走"看得见（景深）。

---

## 附：建议的落地顺序

1. **#1 + #4 的 fonts.ready 那一行 + #5 的启动参数**：都在 `scene.mjs`，半小时，单页提速 2.3 倍，补一个确定性的洞。
2. **#2 + #3 一起做**：重写 `render.mjs`，并行截图、分片编码、帧哈希清单、concat copy、改动泄漏报告，顺带做出 `seamcheck --parallel`。大约半天到一天。
3. **#6 组合子**：`motion.js` 加 40 行。
4. **#7 预览器**：修死链接，第一版只做拖动条、播放和词/镜头刻度；`offsets.json` 放第二版。
5. #8 / #9 等片子需要时再做；#10 不做。
6. **第二轮（5.4）**：V1 门的正反对照夹具最先做（半天，以后改任何门都靠它）；V2 管线帧号自测、V3 runtime 代做 S(t) 其次；
   V4 / V5 / V6 顺手做。另外 INTEGRATION.md「开源项目比对」里「Remotion 没有乱序求值的像素门」一句要按 5.0 改措辞。

---

## Motion Graphics 一轮：转场、镜头切换、文字动画、缓动编排（2026-10-21）

用户原话："加比如镜头的变换，Motion Graphics 有更多的动画……做 ppt 的思路也可以参考，转场动画元素文字动画等等"，"本质就是做 web 效果"。
落地：film-motion `assets/runtime/choreo.js`（缓动 / 交错 / 时间轴）+ `transitions.js`（舞台与转场），film-typography `assets/runtime/textfx.js`；
夹具 `tests/fixtures/_test-mg`；代价与实测见两个 skill 的 `references/transitions.md` / `references/textfx.md`。

**读了什么、没读什么（诚实留白）**：本机能读到原文的只有 Anthropic frontend-design `SKILL.md` 的 Motion 一节（读了）。
Keynote Magic Move / PowerPoint 平滑、CSS View Transitions、GSAP（stagger / SplitText / ScrambleText）、FLIP、Lottie、Remotion `@remotion/transitions`、
Motion Canvas、Manim 这一轮**没有拉源码或规范原文**，借的是它们公开的**行为与 API 语义**（下表每条写的是借的那个行为），实现全部自写。
哪条行为描述和原作不一致，以原作为准，这里的实现以夹具实测为准。

### 借了什么、改了什么、为什么

| 来源 | 借的行为 | 落到哪 | 改了什么，为什么 |
|---|---|---|---|
| Keynote Magic Move / PPT 平滑 | 两页之间**同名/同一**元素自动插值位置、大小、颜色 | `magicMove` 的 morph 路径：`sh.el(name, rect, draw, {props, morph:true})` 两侧同名 → `draw(ctx, mixProps(a,b,q), 插值框)` | 配对**只按名字**，不做 Keynote 那种自动识别"同一个对象"——自动识别在代码里就是猜，猜错了没有门能查。名字就是我们已有的空间锚点（ARCHITECTURE §10），一份登记两处用 |
| CSS View Transitions | 分层模型：命名元素抽出成组、根（其余内容）单独过渡、old/new 两张快照以 `plus-lighter` 叠化 | `magicMove` 的 FLIP 路径与 `root` 参数 | ① VT 快照是**位图**，放大会糊；这里重放的是元素自己的**矢量 draw**。② VT 的根默认叠化；这里 `root` 必给（不给默认转场）。③ `plus-lighter` 原样借——不借的话重合处中段不透明度只有 (1-q)+q·(1-(1-q)) < 1，出现半透明凹陷 |
| FLIP（First-Last-Invert-Play） | 只记首末两个框，用一个反变换把末态"放回"首态再播放 | FLIP 路径的 `boxToBox()`：旧框→当前框、新框→当前框各一个仿射 | DOM 里 FLIP 是为了避开布局开销；这里没有布局，借的只是"两个框决定一个变换"这个想法 |
| Remotion `@remotion/transitions`（`TransitionSeries`） | 转场**吃掉两侧的重叠**、两个序列在转场里各自继续走时间；转场 = presentation × timing 两个正交参数 | `timeline()`：窗口内两镜头各走各的局部时间；`kind`（画法）与 `ease` / `dur`（时序）分开给 | 边界不用"每段时长"表达，改用**剪辑点 + align**：剪辑点可以直接是 `vo.at('字')`，`align` 说转场和那个字的关系（到达/骑在上面/从它开始）。这是 film-narration "关键词触发"那条规矩在转场上的落地；按时长累加的写法旁白一改就漂 |
| GSAP stagger | `each` / `amount` / `from: 'center'|'edges'|'random'|index` / `grid` / `axis` / `ease` | `stagger()` | `each` 和 `amount` 必给其一（GSAP 有默认值）；`random` 必给 `seed`（GSAP 用 Math.random） |
| GSAP SplitText | 按字/词/行拆分，保留可逐个动画的单元 | `units()` / `layoutText()` | 中文规则是新加的：标点挂靠（闭标点挂前、开标点挂后），GSAP 按字素拆时标点会单独飞；位置用前缀测量（text.js 的规矩），不逐字相加 |
| GSAP ScrambleText | 字符逐个从乱码锁定成原文 | `scramble()` | 乱码字由 `hash01(seed, 单元, t·rate)` 决定，不是随机抽——任意 t 可乱序求值；并要求乱码池进 `loadFonts`（运行时才画的字最容易缺字，INTEGRATION 第 33 条） |
| CSS `cubic-bezier()` / `steps()` | 同一条曲线、同一个 jump 语义 | `easeOf.cubicBezier` / `easeOf.steps` | 无（为了和网页设计稿里的缓动值一一对应）；`(.25,.1,.25,1)(0.5) = 0.8024` 和浏览器一致 |
| Penner 缓动族 / GSAP `back` `elastic` `bounce` `anticipate` | 词汇 | `EASE` / `easeOf` | `resolveEase()` 没收到参数就抛错——**没有默认缓动**；`easeInfo()` 把每条量出过冲/预备/重心，代价表的数字就是它量的 |
| After Effects Gradient Wipe（亮度图擦除） | 灰度图的每个像素按阈值依次露出下一镜 | `luma` | canvas 2D 没有逐像素阈值：用 `lighter` + `difference` + `brightness()` 滤镜拼出 `sat((p−v)·k)`，再乘法合成。8 位台阶是这个拼法的代价 |
| Manim `Transform` / `TransformMatchingShapes` | 相同的部件飞到新位置，其余淡入淡出 | `matchUnits()` / `drawMorphText()` | 按字符串相等配对，不按字形轮廓（轮廓配对需要路径数据，代价大、收益小） |
| Lottie 图层与遮罩 | 遮罩是一张图层、可以是任意形状（含文字） | `wipe` 的 `custom` 形状：`mask(ctx, q)` 自己画 alpha 遮罩 | 只借了"遮罩 = 一层"的组织方式；这次没做 Lottie 文件导入。它可以按帧 seek（`goToAndStop(frame, true)`），接法见下文"没借的"和 `../KERNEL.md` 第 3 节 |
| Motion Canvas | 场景里的对象按引用拿位置（`node.position()`）做后续动画 | 已有的锚点 `sh.get(name)` / `A.get(name)` | 没新加东西：我们的"按名字拿本帧的框"就是这个；区别是我们的框出自绘制路径，不出自对象树 |
| frontend-design · Motion | "一次编排好的页面加载比到处撒的微交互更让人愉快"；复杂度匹配美学 | 两份 references 的第 0 节、SKILL.md 的代价表 | 写成**代价**而不是禁令："每个剪辑点都用不同花式转场"读作样品册、是最快让人觉得"AI 做的"的信号——值得付的时候是片子本身在展示转场。哪一处放胆子由 style_guide 定 |

### 没借的

- **GSAP / Motion Canvas 的播放器与时间线对象**：它们的时间由内部时钟/播放头推进，
  而且时间线对象里带着播放状态。没有把它们当作本套件运行时的一部分来借，转场和编排改成了自己的纯函数实现（choreo / transitions）。
  这句话说的是"这次没借"，不是"它们接不进来"：只要关掉自带时钟、在 seek 里按 t 设播放头，再过 seamcheck 的门，
  任何库都能当一个 Clip 用（`../KERNEL.md` 第 3 节）。GSAP 的 `timeline.pause().seek(t)` 是否对乱序求值无状态，**推演，未实测**。
- **Lottie**（更正）：旧版本这里写"它的时间是帧号 + 内部播放器，接进纯函数要整个重写"。**这是错的**，并且和第 3 节 B「纯函数帧契约有没有被证明撑不住的场景」末尾那句矛盾。
  lottie-web 的 `anim.goToAndStop(frame, true)` 求的是这一帧的合成状态，正是本契约要的形状（Remotion `@remotion/lottie` 同法，见第 3 节 B）。
  接法：`autoplay:false` 加 `lottie.freeze()` 停掉全局 rAF，ready 等 `DOMLoaded` 和图片，seek 里 `goToAndStop(t * frameRate, true)`。
  这次没做 Lottie 文件导入，只是因为没有一支片子要它，不是因为契约不允许。
  **推演、未在本仓库实测**的风险点有两个：AE 表达式里的 `wiggle()` / `random()` 可能读 Math.random（探针会点名）；
  图片资源是异步加载的（门 1b 会抓到）。
- **PowerPoint 的"转场预设库"**（涟漪、立方体、蜂巢……）：数量本身没有价值；而且 canvas 2D 只有仿射，立方体/翻页这类透视转场要走 film-webfx 着色器，留白。
- **按形状自动配对的 Magic Move**：见上表第一行。

### 实测出的一件事

**门 4（全片并行）抓到了采样门抓不到的确定性问题**：离屏层用 `imageSmoothingQuality='high'` 时，canvas 当图源的缩放 drawImage 结果依赖上一帧（Chromium 156）。
48 个均匀采样时刻里没有两个相邻帧落在同一个转场窗口里，所以门 1a/1b/2 全绿。转场的特点就是"短窗口里连续的大变换"——
**做转场类运行时，门 4 应该当默认门跑**，不是定稿前才跑。细节见 film-motion `references/transitions.md` §10。

---

## 第五轮：HyperFrames 与 Remotion 官方 agent skills（2026-10-26）

这一轮比的是**给 agent 的那一层**（SKILL.md 怎么写、检查怎么报、模板与参数怎么暴露），不是渲染内核——内核前四轮已比过。

| 项目 | 版本 | 读了什么 |
|---|---|---|
| HyperFrames | `heygen-com/hyperframes` main 浅克隆（2026-10-26），Apache-2.0 | `skills/hyperframes/` 全部 references、`skills/hyperframes-registry`、`docs/concepts/{determinism,variables,frame-adapters}`、`registry/` 结构、`themes/CONTRACT.md`、`packages/lint/src/rules` 目录；**没读引擎截图/混音源码，没跑任何东西** |
| Remotion skills | `remotion-dev/skills` main 浅克隆（skill 版本号 4.0.538），**许可证见下** | 全部 SKILL.md、`remotion-markup/{parameters,multi-scene-video,calculate-metadata,compositions,voiceover}`、`remotion-captions/*`、`remotion-create/video-layout` |

> 克隆在 `scratchpad/oss/hyperframes` 与 `scratchpad/oss/remotion-skills`（只读）。

### 它们是什么，一句话

- **HyperFrames**：HTML + GSAP 暂停时间线，逐帧 seek 截图。时间模型是 DOM 里每个元素的 `data-start / data-duration`，
  动画是 GSAP 时间线（`window.__timelines[id] = tl`），其他运行时（Lottie / anime / three / canvas）走 `hf-seek` 事件或 `window.__hfLottie` 注册。
  与我们同一个契约：**画面是 t 的纯函数，禁 `Date.now` / 无种子 `Math.random` / 渲染中 fetch / `repeat:-1`**（`docs/concepts/determinism`）。
  它的确定性保证是「规则 + lint + 可选 Docker 钉浏览器和字体」；**没看到乱序求值的像素门**（grep `out-of-order`/`shuffle` 在 engine 与 core 里没命中门相关代码；只能说"没找到"，不是"证明没有"）。
  所以我们的 seamcheck 四道门在这一点上仍比它严。
- **Remotion skills**：十几个小 skill（多数 0.7–2.7 KB，最大两个 13 KB），`remotion-best-practices` 是**纯路由**，
  其余按任务切（create / markup / captions / render / studio / maps…），细节放同目录 `*.md`（每个带 `tags` 的 frontmatter）。

### 值得借的（按值排序）

#### R1. 「警告是问题，不是规则」：可度量的工艺警告 + 带理由的保留（HyperFrames `check` / `review.md`）

- **对方怎么做**：`check --json` 除了错误，还报**能量出来的工艺问题**：`line_unread`（一行字停留短于读完所需）、`dead_stretch`（>3 s 画面无变化）、
  `text_below_floor`（字小于短边 2.6%）、`first_frame_empty`（缩略图帧是空的）、`film_silent`（>15 s 无声）。
  警告的处理写成规矩：「修掉，或故意保留并在交付说明里写理由；故意的停留加 `data-hold` 标记」。review.md 还写了「数字与眼睛冲突时信数字」。
- **我们缺什么**：film-critique 的 checks 有字号、遮挡、出画、timeline `moved`，但 **`first_frame_empty`（封面帧）、`dead_stretch`（长静止）、`line_unread`（停留 < 0.5 s + 0.3 s/词）** 我没在 checks.md 里看到同名项（需对一下 `references/checks.md` 第 3 节再定；有的可能已在别名下做了）。
  「故意保留 → 标记 + 理由」这个**机制**我们没有：现在 `laws[]` 机器判不了的进 HUMAN 行，但已判出来又想保留的没有位置。
- **怎么落**：film-critique 加三条阈值检查（封面帧非空、静止窗口 > N 秒、行停留 ≥ 0.5 + 0.3·词数）；MARKS 里加 `hold: true`，带 `hold` 的区间不报 dead_stretch，但进 review_log 的「故意保留」一节。
  放 **film-critique**（脚本 + checks.md）。成本：**中**（半天；dead_stretch 复用已有 timeline `moved` 数据，另两条几十行）。

#### R2. 形容词 → 数字，且 BANNED 清单「每片生长」（HyperFrames `spec.md`）

- **对方怎么做**：开工前写 `SPEC.md`：GOAL / TIME（秒 × fps = 帧）/ LOOK（hex、字体字号字距、阴影偏移模糊不透明度、颗粒 %）/ MOTION（缓动按角色命名、弹簧写阻尼比、时长写帧）/ SHOTS（每镜一行：帧范围、唯一主运动、观众读到什么、声音、如何交棒）/ BANNED / QA。
  附一张「premium / modern / clean / dynamic / playful / cinematic → 具体数」对照表；构图数字（主体 ≥ 画高/宽 40%、每镜只有一个主运动、次运动走 50–70% 距离且晚 100–200 ms）。
  **关键一招**：首渲后「点名每一个它仍然用上的默认，加进本片 BANNED，再修」——清单随片增长。
- **我们缺什么**：film-story 管故事、film-critique 的 `tendencies.md`（T1–T9）管「不是故意的就是没想」，但**没有「形容词必须换算成数」这一步**，也没有「本片 BANNED 行 + 首渲后补录」的闭环。
  tendencies 是通用清单，不会因每片而长。
- **怎么落**：film-story 的 brief 模板加 `LOOK/MOTION/SHOTS` 数值栏和那张换算表（中文词：高级/克制/干净/有劲/活泼/电影感）；film-critique 的评审流程末尾加「点名默认 → 写进 brief 的 BANNED → 重渲」一步。
  成本：**低**（纯文档，1–2 小时）。注意 HyperFrames 的 BANNED 默认清单带强审美立场（"深色底小元素漂浮""玻璃卡片""衬线+斜体强调"……），**抄机制，别抄清单**；我们自己的立场由 film-critique 现有 tendencies 决定。

#### R3. 参数槽的 `label / description / role / portrays`：说意义，不说位置（HyperFrames `variables.mdx`）

- **对方怎么做**：模板根上 `data-composition-variables='[{id,type,label,description,default}]'`，type 有 string/number/color/boolean/enum/font/image；
  文档明确：**description 给 agent 读，写"这个槽代表什么"（"本片所推广品牌的名字"）而不是"页角小字"**；可选 `portrays`（`subject_name / subject_logo / competitor_name / authority_badge / host_identity`…）
  标出哪些槽是**身份信息，换品牌时不许让 agent 编造**；`role`（content/style/timing/motion/layout）说明旋钮影响哪个方面。
  渲染 `--variables '{}'` + `--strict-variables`（未声明的键报错）+ `--batch rows.json --output "renders/{name}.mp4"`；嵌套同一模板多次用 `data-variable-values`。
- **我们缺什么**：#10 的结论是「现在不做」，仍然成立（核心判断不能批量）。但这里有两件**与是否批量无关**的小东西：
  ① 变体（`new-film.mjs --from`）改什么只靠 agent 读 scene 自己找，没有声明；② 「身份信息不许编」没有写进任何 skill——换品牌/换主角的变体最容易让 agent 现编 slogan、榜单、背书。
- **怎么落**：不引入批量渲染。只在 film-core 的「变体」一节加：`film.json` 可选 `slots[]`（id、含义一句话、`kind: content|identity|style`、默认值），`identity` 类槽规则 = 取不到就停下来问，不编；
  `--strict` 式的未知键报错放 #10 真做时一起。成本：**低**（文档 + 10 行 JSON 校验）；批量部分仍按 #10 **不做**。

#### R4. 先出预览、批准后再渲；改动前先读「用户在你不在时改了什么」（两家共同）

- **对方怎么做**：Remotion `best-practices` 与 `create` 都写：用户说"做个视频"**不要默认渲染**，项目一能跑就开 Studio 预览，边做边让用户看；两家都有「Preserve user changes」：
  用户可能在对话之外改了代码，发现意外改动**视为有意**，不覆盖、或先问。HyperFrames 更进一步：改动前 `history --since mine` 看人改了什么，`catch-up` 命令把"他们的改动"和"新请求"分开。
  交付时 `REVIEW.md` 写「做了哪些创作决定、没建的备选、**哪些测过哪些只看过、没人查的（声音测过没听过）**、最弱的一镜、故意保留的警告」，**下一轮先读它再动手**。
- **我们缺什么**：film-core 有 preview 和 accept，但没把「默认停在预览，用户点头才渲终稿」写成规则（需核对 SKILL.md 第 289 行附近，死链已在 §0 记录）；也没有「回合开头先看用户有没有改文件」。
  review_log 已经有「未经人眼确认」的诚实标注——这和 REVIEW.md 的"测过/看过/没查"是同一件事，我们**已经做得不差**，缺的只是「下一轮先读」。
- **怎么落**：film-core 加两句：① 新片默认出预览/低分辨率小样，用户确认或明说"直接出"才渲终稿；② 改已有片子之前先比对 `films/<slug>` 的 mtime / receipt，看是否有非 agent 的改动，有就当作用户意图并在回复里说一句。review_log 头部加「下一轮先读本节」。
  放 **film-core**。成本：**低**（文档）；mtime 对比脚本可选，**中低**。

#### R5. 先搜库再手写 + 条目自描述（HyperFrames registry / `hyperframes-registry` skill）

- **对方怎么做**：约 450 个 block（带自己时间线的整场景）和 component（并入你场景的片段）。每个条目一个 `registry-item.json`：
  `name / title / description / dimensions / duration / tags / files[] / preview(video, poster)`。SKILL 里第一条规矩：「手写任何有名字的效果（CRT 扫描线、故障、胶片颗粒、图表）前先 `catalog --query`」，
  搜索本地、不外发，英文索引；找不到要**上报缺口**（`--search-miss`）。装进项目后是**普通源码**，可改、可裁。
- **我们缺什么**：film-motion / film-webfx / film-typography 里已有大量运行时基元（转场、wipe、scramble、matchUnits…），但**没有一个按"想要的效果"检索的入口**，
  agent 要靠读 SKILL 全文或 references 才知道有什么，容易重写一遍。
- **怎么落**：不做 450 个条目的仓库。只在 film-core 或 `skills/README.md` 加一张**效果 → 运行时函数 → 所在 skill/文件 → 代价**的检索表（我们的代价表已经在 film-motion 里，汇总即可），并加一句规矩「手写有名字的效果前先查这张表」；
  每个 recipe 的 frontmatter 加 `tags`（Remotion 的 `remotion-markup/*.md` 就是这么做的）。成本：**低**（1–2 小时，之后随新增维护）。

### 其他值得顺手借的小项

| 来源 | 做法 | 我们的情况 / 建议 |
|---|---|---|
| HyperFrames `SKILL.md` 结构 | 主 SKILL.md **7 KB**：描述 → 12 条**编号合同**（每条一句，`check` 报错带 `Fix:`）→ 「Keep it editable」→ 工作循环 → **「What to read」路由表**（请求 → 读哪个 reference） | 我们的 SKILL.md 9–19 KB，film-narration 18.7 KB、film-core 18.4 KB。建议 film-core 末尾已有的"其他能力找哪个 skill"保留，但把**硬约束压成编号合同**放最前（每条能被某个门验证的才算合同），其余下沉 references。成本：中（改写，不改行为） |
| HyperFrames `captions.md` | 字幕组规则：高能 2–3 词、对话 3–5、平缓 4–6；一次只显示一组；**每组退出后必须硬杀**（`tl.set(opacity 0, visibility hidden)`）防残留；组起点 ≥ 0.1 s（0 s 起的字幕像"本来就在"）；按**位置**而非文本匹配转写词与字幕词（重复词会错配）；背景亮度 0–255 决定混合模式与 scrim 浓度 | 我们的字幕是 `narration.json` 字级时间戳 + film-typography 画，时间源比转写可靠。可借：**"一次一组 + 退出硬杀"**（我们是纯函数，天然无残留，但写进断言更稳：任一时刻可见组数 ≤ 1）、**"0 s 起字幕"**这条。放 film-typography 字幕一节。成本：低 |
| HyperFrames `captions.md` 转写坑 | 中日文本地转写常把整句当一个"词"→ 按字数摊时间；Whisper 在静音上编出 "Thank you."→ 用 `silencedetect=noise=-35dB:d=0.6` 丢掉落在末尾静音里的词；转写里 `♪`/`�` > 20% 视为失败 | 我们 narration 以 TTS 先行，转写只用于"已有录音反推"和成片校验（`align.py --verify`）。把这两条放进 film-narration 的"已有录音反推时间戳"一节。成本：低 |
| HyperFrames `vertical.md` | 平台自己的 UI 盖在画面上：1080×1920 顶部 168 px 不放东西，文字与主体在 168–1330 px 带内，右侧动作栏不压字；首帧即封面+钩子；**字数上限：一句主张约 8 个汉字或 5 个英文词，砍字不缩字** | 我们有"三画幅布局"和 360 宽可读性下限（film-typography），但**没有平台遮挡带数字**。数字来自对方、只对 1080×1920 且平台会变，**标"来源 HyperFrames，未核实"** 后加入竖版一节；"砍字不缩字"我们等价于已有规则。成本：低 |
| HyperFrames `sound.md` | 音效峰值落在画面**后一帧**；每个命中比底乐高 3–6 dB；同一音效轮换 2–3 个 take（"每个转场同一声 whoosh"是最常见的 AI 味）；不要合成叮咚音 | 我们的响度/真峰门（-1.0 dBTP、退出码 5）**比它严**。可借的只有"轮换 take"和"峰值晚一帧"两句，放 film-narration 音效摆放一节。成本：低 |
| Remotion `video-layout.md` | 「你在设计视频，不是网页」；每场先决定观众**先看哪一个**；1080 宽下安全边 80 px（左右）/100 px（上下），主标题 ≥ 84 px、辅助 ≥ 44 px，随宽度缩放；"不要多余元素" | 与 film-typography 重叠，数字更粗糙。**只借第一条心法**，放 film-story 每场 brief 的一栏：「观众最先看哪一个」。成本：极低 |
| Remotion `multi-scene-video.md` / `captions` | **字幕与它的视频放在同一个 Sequence 里，剪辑/变速作用在共同父节点上**，别把多段字幕合成一个游离在时间线外的覆盖层 | 我们的 `shot()` / `chain()` 组合子已经是同形状（时间平移作用在整个 shot 上）。**已经做对**，列入第 4 节的同类收敛即可，不用改 |
| Remotion `remotion-docs` | 文档 URL 末尾加 `.md` 取 Markdown 源，省 token；先搜再取，"用当前文档而非记忆" | 我们没有对外文档依赖；若 film-webfx 要引 three.js / pmndrs 文档，可抄这条思路。无需动作 |

### 不值得借的

- **GSAP 暂停时间线 + DOM `data-start/data-duration` 作为时间模型**：它把"何时出现"放进属性、"怎么动"放进时间线，Studio 能直接改标签——这是为**可视化编辑器**服务的结构。
  我们的是 `seek(t)` 纯函数，无编辑器；换成 DOM 时间模型会丢掉乱序求值的简单性。GSAP 暂停时间线对乱序 seek 是否无状态仍是 §「没借的」里那条**推演未实测**。
- **Remotion 的 Studio 写回源码（`Interactive.*`、"inline 内联 interpolate"、内联 captions 数组字面量供编辑器改写）**：整套规则是为"可视化编辑器能把拖动写回 JSX"而存在的。我们没有这个编辑器，这些约束只会让代码更难读。
- **HyperFrames 的 18 个主题令牌合同（`--bg --fg --accent --dur-beat --ease-standard`…）**：令牌化对"450 个可混搭条目"有意义；我们是一片一个视觉方案，style_guide 已够用。只有将来做"一套模板 × N 个品牌"（#10）时再看。
- **HeyGen 云端能力**（`media-use`、数字人、配乐检索、`remove-background` 168 MB 模型、云渲染 `aws-lambda` / `gcp-cloud-run` / `k8s`）：绑定商业服务或我们不做的场景。`remove-background` 的"字在人后面"经验数字（遮住 30–55% 最好读，< 15% 浮、> 65% 吃掉）倒值得记在 film-typography 备忘，但**要求先有抠像**，现阶段不做。
- **Remotion 的 `remotion-saas` / `lambda` / `player` / `maps` / `upgrade` skills**：服务端渲染产品、地图、版本升级——与本套件无关。
- **`remotion-docs` skill 里内嵌的 Algolia 公开搜索 key**：能抄写法，但别把任何第三方 key 写进我们的 skill。
- **"100% 确定性"的措辞**：HyperFrames 文档说 "Same input, identical output. Every time."，实际保证靠规则 + 可选 Docker；同文档自己承认本机渲染可能差 1 px。
  我们的 receipt 冻结 + 乱序门更诚实也更强，**别因为对方措辞更响就弱化自己的表述**。

### 许可证注意事项

- **HyperFrames**：仓库 `LICENSE` 为 **Apache-2.0**（读了文件头）。可抄思路和文字、可改、可商用；**若直接复制它的文件/段落进我们的 skill，需保留版权与许可声明并标注修改**。
  本节所有借鉴都是**重写思路**，没有搬原文，因此无需附带声明；但若以后复制 `registry/` 里的 block 源码或 `themes/*.css`，要查该文件自己的头部（`CREDITS.md` 里列了第三方素材来源，**本轮没细读**）。
- **Remotion（框架）**：不是 OSI 开源许可，是 Remotion License。**以 https://www.remotion.pro/license 2026-10-26 抓取为准**：
  - **免费版**：个人及**最多 3 人**的公司，含全部功能、不限商用；组织长大须升级。
  - **Company 许可**：4 人及以上的公司/协作团队必须买，按用量计费。两档：**Automators** $0.01/次渲染、每月最低 $100（批量/自动化/prompt-to-video 产品，开发者不占席位）；**Creators** $25/席位/月（低量人工制作、本地做动效体系，**页面明说包含用 AI agent 与 Studio**）。
  - **Enterprise**：$500/月起，自定条款。
  - 这页没列限制细节，细则在仓库 `LICENSE.md` 与 Terms——**本轮没读，上面数字也可能随时改**，真要用前复核。
  - **与我们的关系**：motion-studio **没有依赖 Remotion**（只读源码做比对）。若将来 `deliver` 要产出"可交给他人的 Remotion 工程"，或把 Remotion 渲染器嵌进产品，需要先对照上面的人数门槛和 Automators 档。当前个人使用在免费范围内。
- **`remotion-dev/skills` 仓库本身**：浅克隆里**没有找到独立的 LICENSE 文件**（根目录只有 README / package.json / scripts / skills），许可状况不明。
  所以：**只借思路、不拷贝文字**。上面引用的都是改写的做法描述，没有整段复制。

### 这一轮与前几轮的关系

- 对 §3 C「标配缺席」：这一轮补上两个**不是渲染而是协作**的标配——① 参数槽的语义声明（R3），② 按效果检索的入口（R5）。
- 对 §4「已经做对的」：新增三项同类收敛——纯函数画面（两家都禁 `Date.now`/无种子随机/渲染中 fetch）、字幕与视频共享时间父节点（`shot()`）、「未经人眼确认」式诚实标注（≈ `REVIEW.md` 的测过/看过/没查）。
- 优先级：**R2（文档）→ R4（文档）→ R5（文档）→ R3（文档 + 小 JSON）→ R1（脚本）**。前四条合计约半天，且都不碰渲染链路。
