# film-motion · VERIFIED

环境：macOS Darwin 25，Node + Playwright（Chromium 156.0.8078.4），ffmpeg 8.0。日期 2026-10-21。
第 11 节另用 `FILM_CHROMIUM` 换过 143/145/151/156 四个版本 × headless shell / 完整 Chrome 两种形态。
测试片：`tests/fixtures/_test-motion/`（保留，未删）。下面的命令都是**从 `/tmp` 这个无关 cwd 调用**，
`FILMS_DIR=<repo>/films`，用来证明脚本不依赖 cwd。

## 1. 最小闭环：settle/follow/seeded/place 场景 → seamcheck → MP4

场景 `tests/fixtures/_test-motion/scene.html`：24 个点，位置来自 `seeded(42)`，用 `follow()` + `spring({duration:0.5, overshoot:0.08})`
去而复返，坐标走 `L.place()` / `L.size()`；一根以 2πt/D 旋转的指针；`seek = t => paint(wrap(t, 2))`。
film.json：`9x16, fps 30, sub 4, loop true`。

```
$ node .../scripts/seamcheck.mjs --film _test-motion
影片 _test-motion  入口 scene.html  9x16 1080×1920  2s @ 30fps  采样 8 个时刻  loop=true
门 1a  同一页面，同一个 t 求两次：      8/8 ✓ 逐像素一致   ✓ 通过
门 2  乱序求值（按种子 7 打乱）：       8/8 ✓ 逐像素一致   ✓ 通过
门 3  循环接缝：
  3a frame(0) vs frame(2): 逐像素一致
  3b 跨缝 frame(1.967)→frame(0): 8922 像素变化；相邻帧典型 7821 像素；容差 31284
  ✓ 通过：首尾一致且跨缝无跳变
门 1b  全新页面重新加载：               8/8 ✓ 逐像素一致   ✓ 通过
探针  seek 期间调用的禁用 API：  ✓ 无
全部通过                       EXIT=0     墙钟 3.7s
```

```
$ node .../scripts/render.mjs --film _test-motion
▶ 9x16 1080×1920  0–2s  30fps ×4 子帧 shutter=1  = 240 次截图
✓ .../tests/fixtures/_test-motion/out/silent-9x16.mp4   60 帧   16.4s   ffprobe: 1080,1920,30/1,60      EXIT=0
$ node .../scripts/render.mjs --film _test-motion --sub 1 --from 0.5 --to 1 --preset veryfast
✓ .../out/silent-9x16-0.5-1.mp4   15 帧   1.1s   ffprobe: 1080,1920,30/1,15                  EXIT=0
$ node .../scripts/render.mjs --film _test-motion --format 16x9 --sub 1 --preset veryfast --out .../out/wide.mp4
✓ .../out/wide.mp4   60 帧   4.3s   ffprobe: 1920,1080,30/1,60                                EXIT=0
```

运动模糊目测：`out/blur-0p233.png`（t=0.233s 帧）里快速运动的点呈现为 **4 个分离的残影**，指针呈扇形拖影。
即 tmix 生效，但 sub=4 对"一帧位移 ≫ 物体尺寸"的运动是频闪感而非连续拖影——已写进 SKILL.md §5 的代价表。

## 2. 故意违约：seamcheck 能不能抓到

同一目录下的变体入口，用 `--entry` 切换。全部 EXIT=1。

| 入口 | 违约方式 | 1a | 2 | 3 | 1b | 探针 |
|---|---|---|---|---|---|---|
| `bad-random.html` | seek 里 `Math.random()*4` 抖动位置 | ✗ | ✗ | ✗ | ✗ | ✗ `Math.random ×840` |
| `bad-clock.html` | 指针角度加 `Date.now()%1000/1000` | ✗ | ✗ | ✗ | ✗ | ✗ `Date.now ×35` |
| `bad-state.html` | `let drift=0; seek 内 drift+=1` 画方块 | ✗ | ✗ | ✗ | ✗ | ✓（没有禁用 API，纯状态） |
| `bad-loadrandom.html` | **加载时**用 `Math.random` 代替 `seeded(42)` 生成布局 | **✓** | **✓** | **✓** | ✗ | ✓ |
| `bad-loop.html` | `paint(Math.min(t,1.2))`，loop:true 但片尾停在 1.2s 状态 | ✓ | ✓ | ✗ | ✓ | ✓ |
| `bad-waapi-undeclared.html` | WAAPI 动画但不声明 `USES_WAAPI` | 加载即报错退出 | | | | |

`bad-loadrandom` 的原始输出（关键段）：

```
门 1a ✓ 通过     门 2 ✓ 通过     门 3 ✓ 通过：首尾一致且跨缝无跳变
门 1b  全新页面重新加载，同一批 t 再求一次：
  t=0.000s  ✗ 145285 像素不同，最大差 207/255
  ...（8 个时刻全部 ✗，13 万～15 万像素不同）
  ✗ 两次加载结果不同：加载阶段用了 Math.random / 时钟 / 未等待的异步资源（字体、图片）
探针 ✓ 无
✗ seamcheck 未通过：1 项不合格
```

**结论：只有"同页面"的三条门是假门。** 加载时的 `Math.random` 在同一页面里是常量，同 t 两次、乱序、首尾全过；
只有重新加载才暴露。仓库原 `scripts/seamcheck.mjs` 的三条门全部在同一页面内（结构上等同本表的 1a/2/3），
按此推断会放过这一类——我没有直接跑旧脚本（它只认 `projects/`，按边界不能动），这是推断，不是实测。
修法就是新增的门 1b（全新 context 重新加载后比对）和探针（seek 期间禁用 API 计数）。

`bad-waapi-undeclared` 输出：
```
✗ 页面上有 1 个 CSS/WAAPI 动画，但没有声明 window.USES_WAAPI = true。
  不声明的话截图参数 animations:'disabled' 会把它们 finish() 成终态，每帧都一样（静默失败）。
EXIT=1
```

## 3. 旧循环门的问题（实测数据支持）

旧 seamcheck 的循环门比较 `frame(0)` 与 `frame((N-1)/fps)` 是否逐字节相同。正确的循环片里这两帧本该相差一帧的运动：
本片实测 `frame(1.967)→frame(0)` 变化 8922 像素（与相邻帧典型 7821 相当）。旧判据会把这支**正确**的循环片判失败。
新门 3 改为 3a `frame(D) ≡ frame(0)` + 3b 跨缝跳变 ≤ max(4×相邻帧典型差异, 0.1% 像素)。`bad-loop` 证明 3a 能抓首尾不一致。
3b 单独失败的情形（首尾相等但速度不连续）**没有构造用例测过**。

## 4. WAAPI 路径

`waapi.html`：一个 div 用 `element.animate()` 左右往返，`pause()` 后在 seek 里设 `currentTime`，声明 `USES_WAAPI`。
- seamcheck 全部通过（EXIT=0），3b 跨缝 12000 像素 = 相邻帧典型 12000。
- 渲出 `out/waapi.mp4`（60 帧），在 t=0.25/0.5/1.0 处裁出方块所在行算 md5：三个值互不相同
  （`bfa8ea05…` / `95510966…` / `5c908d9c…`）→ 不是同一帧，playbackRate=0 的保护有效。
- "不声明就四个时刻截出同一帧"是上游已验证事实，本次没有绕过守卫去复现它。

## 5. spring() 反解（时长 + 过冲 → stiffness/damping）

脚本 `<scratchpad>/springtest.mjs`：对 duration ∈ {0.2, 0.5, 1, 2} × overshoot ∈ {0, 0.01, 0.05, 0.1, 0.3, 0.6}
共 24 组求参数，再用 settle() 以 duration/20000 步长暴力扫描实测"最后一次 |x−1|>0.005"的时刻和峰值。
- 停止时刻相对误差最大 **0.005%**（dur=0.2 那组，等于扫描步长本身）；其余 0.000%
- 峰值过冲与要求值一致到小数点后 4 位（例：要 0.3 实测 0.3000）
- 预设实测：snappy 0.390s/0.79%，default 0.566s/0%（ζ=0.997），heavy 1.198s/0%（ζ=1.265），playful 0.568s/16.61%

临界阻尼分支改成 `|ζ−1|<1e-6`：对比旧 `lib/motion.js`，ζ−1=1e-8 时旧值误差 3.9e-9，1e-10 时 3.9e-11。
**这不是可见 bug**（远小于一个像素），保留只是为了 `spring({overshoot:0})` 算出 ζ 恰为 1 附近时不走过阻尼公式。

## 6. 其他脚本

- `capabilities.mjs`（从 /tmp 调用）：Chromium 156.0.8078.4；可变字体已加载；canvas CSS font-variation-settings 生效
  且需重新赋值 ctx.font（241.523→276.406）；伪粗体墨量 5513→7194，font-synthesis:none 后 5513；WebGL/WebGL2 均为 SwiftShader。EXIT=0
- `preview.mjs --port 4399`：`/__preview.html` 200，`/scene.html` 200，Range 请求 206，`/../../CLAUDE.md` 404（不越出影片目录）。
  **没有在浏览器里实际点播放/拖动**，只验证了服务器侧。
- 错误路径：无 films/ → `✗ /private/tmp/films 下没有影片…` EXIT=1（修过一次：空 `FILMS_DIR` 曾被当成 cwd）；
  不存在的片 → 列出现有影片 EXIT=1；`--fps abc` → `✗ --fps 需要数字` EXIT=1。
- 兼容性：film-production 脚手架产出的 `films/scaffold-selftest`（`fps:30, sub:1, duration:null, runtime[]`），
  从仓库根执行 seamcheck → 全部通过 EXIT=0。

## 7. 集成反馈后的修复（第二轮）

**`--out` 按 cwd 解析的问题**：原先 `--out out/partial.mp4` 被原样交给 ffmpeg，按 cwd 解析，只报 ffmpeg 自己的错
（`Error opening output files: No such file or directory`）。现在相对路径解析到 `films/<slug>/out/`（开头的 `out/` 去掉），
绝对路径原样用，父目录 `mkdir -p`，失败时报完整路径。实测（scaffold-selftest）：

| 调用 | 结果 |
|---|---|
| cwd=仓库根 `--from 1.0 --to 2.0 --out out/partial.mp4` | ✓ `films/scaffold-selftest/out/partial.mp4` 30 帧，EXIT=0 |
| cwd=/tmp `--out cuts/a.mp4`（目录不存在） | ✓ `films/scaffold-selftest/out/cuts/a.mp4` 15 帧，EXIT=0 |
| `--out <scratchpad>/abs/x.mp4`（绝对） | ✓ 原样落盘，15 帧，EXIT=0 |
| `--out /System/nope/x.mp4` | `✗ 无法创建输出目录 /System/nope：EPERM…` EXIT=1 |
| `--out x.mov` | `✗ --out 必须是 .mp4 文件，收到 x.mov（解析为 …/out/x.mov）` EXIT=1 |

仓库根没有生出 `out/`。ffmpeg 非 0 时的错误也带上了输出文件路径。

**`openScene({ initScripts })`**（film-critique 的请求）：在场景脚本之前执行的注入脚本。
测试：注入一个函数记录 `typeof window.seek` 并包 `CanvasRenderingContext2D.prototype.arc`，外加一个 `{content}` 脚本；
对 `_test-motion` seek(0.5) 一次 → `{ seekAtInit: 'undefined', arcsAfterOneSeek: 24, second: 1 }`。
即注入时场景尚未运行，包装能看到全部 24 次 arc（= 24 个点），两种形式都生效。

## 8. 第三轮：CDP 截图、并行渲染、钉渲染器（依据仓库 `docs/oss-borrowings.md`）

**CDP vs locator 截图**（`scratchpad/cdp-bench.mjs`，同一浏览器，各 60 帧，解码后逐像素比）：

| 场景 | locator | CDP | 提速 | 像素不同的帧 |
|---|---|---|---|---|
| `scene.html`（canvas） | 15.0 fps | 29.9 fps | 1.99× | 0/60 |
| `waapi.html`（DOM + WAAPI） | 19.3 fps | 30.1 fps | 1.56× | 0/60 |

上游报告是 14.2→32.5（2.3×），本机实测略低。

**并行渲染**（`render.mjs --fps 60 --sub 1 --to 8 --preset veryfast`，480 帧 1080×1920，16 核机器）：

| workers / 浏览器 | 截图/秒 | 相对串行 | 截图哈希与串行不同的帧 |
|---|---|---|---|
| 1 / 1 | 25.6 | 1× | — |
| 4 / 2 | 88.8 | 3.5× | 0/480 |
| 8 / 1（单浏览器 8 页） | 69.2 | 2.7× | 0/480 |
| 8 / 4 | 141.9 | 5.5× | 0/480 |
| 8 / 8 | 156.0 | 6.1× | 0/480 |
| 16 / 8 | 213.0 | 8.3× | 0/480 |

第一轮测试的分片固定 2 秒，只有 4 片，worker 再多也只用到 4 个（4/8/16 都卡在约 93 截图/秒）。
已改成按 worker 数自动切细（每个 worker 至少 2 片，下限 8 帧）。
运动模糊路径：sub=4 时 workers 1 vs 8，截图哈希逐帧相同；两个 mp4 解码后 60/60 帧 md5 不同，
`psnr` 平均 55.1 dB（最小 53.9）→ 只是分片 GOP 边界不同带来的编码噪声，不是内容差异。
上游报告的 368 fps（8×2）是另一台机器/场景的数字，本机没达到。**满屏噪声场景下的编码瓶颈（上游实测约 8 fps/进程）没测。**

**seamcheck 门 4 `--parallel 8`**：`scene.html` 60 帧 0 帧不同，EXIT=0；`bad-state.html --parallel 4` 60/60 帧不同，✗。

**改动泄漏报告**：`scene.html` 渲一次 → 只把 t>1.5 的指针改色 → 同设置再渲 →
`与上次渲染相比：14 帧像素变了 → 1.53–2.00s`（1.533s 起正好 14 帧）。scene.html 已还原。

**渲染器指纹**：首次渲染写入 `_test-motion/film.json`：
`renderer = {chromium: 156.0.8078.4, playwright: 1.64.1, args: [--font-render-hinting=none]}`。
版本不一致时的警告分支当时没有触发过（需要换一个 Chromium 版本）；第 11 节用 `FILM_CHROMIUM` 端到端触发了，告警原文在那里。
`package.json` 里 playwright 仍是 `^1.64.1`——它在仓库根，不在我的边界内，没改。

**回归**：换 CDP 之后，`scene` / `waapi` EXIT=0；6 个违约变体（`bad-random` `bad-clock` `bad-loadrandom` `bad-state` `bad-loop`
`bad-waapi-undeclared`）全部 EXIT=1，和第一轮一致。

## 9. 第四轮：分片编码缓存（只重编改动的分片）

方案（协调者提出，我改了一处）：协调者原方案是"哈希没变的分片不喂 ffmpeg"。问题是要截完一整片才知道哈希对不对得上，
这时帧已经扔了。改成边截边和缓存的哈希比对：对不上的那一刻，从片头**重新截**（seek 纯函数 → 重截 = 原帧，
顺手核对哈希）再开始编码。不用缓冲 PNG，最坏多截一片。分片边界改为绝对帧号 30 的整数倍（1s@30fps），与 worker 数无关。

`_test-motion`，`--to 4 --preset medium --workers 4`，4 个分片。改动 = 指针颜色在 1.5<t<2 时变橙（wrap 后 3.5–4 也变）：

| # | 操作 | 分片 编码/复用 | 结果 |
|---|---|---|---|
| 1 | `--sub 1 --clean-cache` | 4 / 0 | 120 帧 |
| 2 | 不改，重渲 | 0 / 4 | 与 #1 解码后 0/120 帧不同 |
| 3 | 改中段 | 2 / 2 | 报告 `28 帧像素变了 → 1.53–2.00s, 3.53–4.00s` |
| 4 | 同一改动 `--no-cache` | 4 / 0 | **#3 vs #4 解码后 0/120 帧不同** |
| 5 | `--sub 4`（编码参数变了） | 4 / 0 | 不误用 sub=1 的缓存 |
| 6 | `--sub 4` 改中段 | 2 / 2 | 报告 30 帧（1.50 起：第 45 帧的子帧 t=1.508.. 已变） |
| 7 | `--sub 4 --no-cache` | 4 / 0 | **#6 vs #7 解码后 0/120 帧不同** |
| 8 | `--sub 4 --from 1 --to 2` | 0 / 1 | 与 #7 的第 30–59 帧解码后 0/30 不同 |
| 9 | `--sub 4 --from 0.5 --to 1.5` | 2 / 0 | 首尾半片单独缓存，30 帧 |

对协调者提的两个坑：
- **concat -c copy 混合来源**：#3 成片显示序帧间隔全部 = 1/30（0/120 偏离），4 个关键帧（每片一个 IDR）；
  包序 pts 非单调是 B 帧的正常现象。解码结果与全量重编相同（#4、#7），不存在时间戳或关键帧问题。
- **tmix 跨片**：不会。每片单独起 ffmpeg，tmix 窗口在片内；分片边界总在输出帧之间，每组 sub 个子帧不会跨片。
  #6/#7 的逐帧一致直接证明了这一点。
- **编码噪声时间上不一致**：x264 对相同输入 + 相同参数是确定的（#2、#4、#7），复用的分片与当场重编的逐字节等价。
  另有一个容易误读的现象：#1 vs #3 解码后第 34–59 帧不同，但像素只从第 46 帧起变了。原因是被重编的那一片里，
  未变的帧也被 x264 码率控制重新分配了比特。这与全量重编一致（#3≡#4），不是缓存造成的接缝。

缓存占用：本轮测试后 `out/.render/cache` 2.0 MB。没有自动清理。

**`--font-render-hinting=none`**：协调者实测 macOS 上 none/full/medium 哈希全同（CoreText 不做 hinting）。
我没复测；SKILL.md 已改为"本机无差别，防的是换平台"。

**serve.mjs 挪到 `scripts/lib/`**：协调者做的，理由（它是 Agent 工具，按契约 §4 不该进片子的 runtime/）我同意。
SKILL.md §8 和 references 已同步。本轮所有测试都是在挪动之后跑的。

## 10. 第五轮：钉 x264 线程数

协调者实测：同一份 YUV、同样 `-preset slow -crf 16`，只改 `-threads`，码流 md5 各不相同，**解码像素也不同**：
1 vs 8 线程最大差 59/255、1.16% 像素；1 vs 16 线程最大差 61/255、4.77% 像素。
原来的 render.mjs 没钉 `-threads`，缓存键里也没有它。换一台核数不同的机器重渲时，复用的分片和新编的分片
会是两种编码的混合，而且是静默的。第 9 节"x264 是确定的"只在线程数相同时成立。

修法：`-threads` 固定（`--x264-threads`，默认 4），进缓存键，并和 ffmpeg 版本一起记进 film.json `renderer`。
实测（`_test-motion --sub 1 --to 4 --preset medium`）：

| # | 操作 | 结果 |
|---|---|---|
| 1 | 首次渲染 | `film.json renderer 补记 ffmpeg, x264Threads`（旧记录只补缺的字段） |
| 2 | `--no-cache --workers 4` | mp4 md5 `df0b9f73…` |
| 3 | `--no-cache --workers 1` | mp4 md5 `df0b9f73…`，**与 #2 逐字节相同** |
| 4 | `--x264-threads 8` | 警告 `x264Threads 4 → 8`；缓存键变了，4/4 片重编（没复用 4 线程的分片）；与 #2 解码后 88/120 帧不同，PSNR 59.3 dB |

缓存目录里不同 pkey 的分片各自独立（5 组），没有混用。

结论改为：**跨线程数不等价，已用缓存键隔离**。"跨机器像素确定性"在编码器这一层已经消掉
（同 ffmpeg 版本 + 同线程数 → 逐字节相同）；浏览器那一层的**版本轴**在第 11 节实测关掉了（同机 143→156），
**GPU / 操作系统轴**仍然没测。

## 11. 第六轮：换浏览器构建（`FILM_CHROMIUM`），触发漂移告警

新增环境变量 `FILM_CHROMIUM=<可执行文件>`：`launchBrowser()` 设了它就走 `executablePath`，不设与原来完全一样。
render / seamcheck / film-critique 的 stills·check（经 `openScene()`）都走 `launchBrowser()`，自动跟随；
`capabilities.mjs` 自己 launch（不加渲染参数），也改成跟随。错误路径实测：

```
FILM_CHROMIUM=/nope/chrome  →  ✗ FILM_CHROMIUM=/nope/chrome：路径不存在。它要指向 Chromium 的可执行文件本体，例如 …   EXIT=1
FILM_CHROMIUM=<…>.app       →  ✗ … 是目录，不是可执行文件。
                                 macOS 的 .app 要指到里面的二进制：<…>.app/Contents/MacOS/Google Chrome for Testing   EXIT=1
FILM_CHROMIUM=film.json     →  ✗ …：文件存在但没有执行权限   EXIT=1
```

本机可用的构建（`~/Library/Caches/ms-playwright/`）：每个 rev 有两种二进制——
`chromium-<rev>/…/Google Chrome for Testing`（完整 Chrome，新 headless）和
`chromium_headless_shell-<rev>/…/chrome-headless-shell`。rev 1200/1208/1234/1248 = 143.0.7499.4 / 145.0.7632.6 / 151.0.7922.34 / 156.0.8078.4。
测试片：`films/demo-tls` 拷到 scratchpad 用 `--films-dir` 渲（连 `out/vo` 一起拷，场景要读），仓库里的 demo-tls 没碰。

### 11.1 方法学：三种会骗人的比法

1. **比 PNG 文件 md5 测的是容器**。协调者第一次比 PNG md5 得到"143/145/151 两两 5/5 帧全不同"；解码后 143 与 151 逐像素相同。
   本轮复核：同样 5 帧，143 与 151/156 的 PNG md5 5/5 不同、字节数差几到十几字节（例 t=1.4：138382 vs 138386 字节），
   ffmpeg 解码成 RGBA 后 md5 5/5 相同；151 与 156 连 PNG 字节都相同。判据是解码后的像素，不是 PNG 字节。
2. **读 canvas `getImageData` 会改变后面帧的光栅路径**。同一个完整 Chrome 143、同样 5 个时刻，每帧截图后回读一次 canvas vs 不回读：
   t=0.5、1.4 相同；t=3/6.2/8.8 差 4.4% / 6.9% / 11.9% 像素、最大 2–4/255。两次回读运行之间相互一致。
   推断（没读源码证实）：Chrome 对频繁回读的 canvas 会降级到 CPU 光栅。协调者"143 vs 145 只有 1/5 帧不同"是在回读下测的；
   渲染器不回读，同一对构建在渲染路径上 5/5 帧都不同（见 11.2）。两边在 t=0.5（第一帧，回读还没生效）给出完全相同的数：
   276 像素、最大 3/255、全在 y=1478 这一行——说明两套测法在可比处是一致的。
3. **"Chromium 156" 不是一个东西**。Playwright 默认的 headless 用 `chromium_headless_shell`，`executablePath` 指到 Chrome for Testing
   是完整 Chrome。两者 `browser.version()` 都是 `156.0.8078.4`；CDP `Browser.getVersion` 的 `product` 分别是
   `HeadlessChrome/156.0.8078.4` 和 `Chrome/156.0.8078.4`。像素差得很大（下表），这是本轮最大的发现。

### 11.2 像素矩阵（渲染路径：`openScene` + CDP 截图，不回读；t = 0.5/1.4/3/6.2/8.8；PNG 解码成 RGBA 逐像素比）

| 比较 | 不同的帧 | 幅度 |
|---|---|---|
| headless shell 143 / 145 / 151 vs 156 | 0/5（三对都是） | — |
| 完整 Chrome 143 / 151 vs 156 | 0/5 | — |
| 完整 Chrome 143 vs 145 | **5/5** | 25–7555 像素（0.001%–0.36%），最大 1–5/255，差 >8 的像素 0 |
| 156：headless shell vs 完整 Chrome | **5/5** | 111969–282738 像素（5.4%–13.6%），t=0.5 最大 3/255；t=6.2 最大 54/255、t=8.8 最大 216/255 |

最后一行看得出来：并排看 t=8.8，方块/斜线字符的字形宽度不一样——`ui-monospace, monospace` 的字体回退在两种形态下选了不同的字。
**根因是片子没把字体随片打包**，不是两种形态的光栅化不同（协调者复核）：同一对构建按解码像素比，demo-tls 明文时刻
（t=0.5/3.0）差 4.4–5.4%、最大 2–3/255、差 >8 的像素 0；画方块字（▚▞▟，`ui-monospace` 没有、必须回退）的 t=6.5/8.8
差 10.4–13.6%、最大 216/255、差 >8 的 6.5 万–7.8 万像素。字体随片打包的 `_test-typography` 在同一对构建下差 >8 的只有
93–3534 像素、集中在一小块（边线挪一个像素的特征）。film-assets 的 `font_source.mjs` 把 demo-tls 判为不合格。
所以 SKILL.md 写成因果链：没打包字体 → 回退随构建变 → 可见差异；根治是打包字体，钉构建只是避开症状。

### 11.3 整片端到端（`render.mjs`，demo-tls 313 帧 30fps sub=1，8 worker / 11 分片）

| # | 浏览器 | 告警 | 分片 编码/复用 | mp4 md5 | 解码后与 #2 不同的帧 |
|---|---|---|---|---|---|
| 1 | shell 143 `--pin-renderer` | `156.0.8078.4 → 143.0.7499.4` | 11 / 0 | `f54f8ccf…` | — |
| 2 | 默认（shell 156），带 #1 的缓存 | `143.0.7499.4 → 156.0.8078.4` | **11 / 0** | `f54f8ccf…` | 0/313 |
| 3 | 默认，再渲 | 同上 | 0 / 11 | `f54f8ccf…` | 0/313 |
| 4 | 默认 `--no-cache` | 同上 | 11 / 0 | `f54f8ccf…` | 0/313 |
| 5 | 默认 `--pin-renderer` | 同上 | 0 / 11 | `f54f8ccf…` | 0/313 |
| 6 | 完整 Chrome 156 | `156.0.8078.4 → 156.0.8078.4 (full Chrome)` | 11 / 0 | `27483cc0…` | 313/313 |
| 7 | shell 145 | | 11 / 0 | `f54f8ccf…` | 0/313 |
| 8 | shell 151 | | 11 / 0 | `f54f8ccf…` | 0/313 |
| 9 | 完整 Chrome 143×3、151、156×2（143、156 各有一次 `--workers 1`） | | 11 / 0 | 6 次全是 `502213ea…` | 313/313 |
| 10 | 完整 Chrome 145 | | 11 / 0 | `b6eabc7b…` | 313/313 |

#1 后 `film.json renderer.chromium` = `"143.0.7499.4"`；#5 后改回 `"156.0.8078.4"`。告警原文（#2，stderr）：

```
⚠ 本片记录的渲染环境与当前不同：chromium "143.0.7499.4" → "156.0.8078.4"。像素可能与当初不同，重渲后重跑 seamcheck 并重看静帧（确认后 --pin-renderer 改记）。
```

#6（同版本、换形态，加了构建形态后缀之后才抓得到）：

```
⚠ 本片记录的渲染环境与当前不同：chromium "156.0.8078.4" → "156.0.8078.4 (full Chrome)"。像素可能与当初不同，重渲后重跑 seamcheck 并重看静帧（确认后 --pin-renderer 改记）。
```

**分片缓存换版本后的行为**：#2 带着 143 渲出的缓存，11 片全部重编、0 片复用，成片与 143 的**逐字节相同**（`f54f8ccf…`）。
即方向保守：不会复用旧像素——缓存哈希是 PNG 字节，字节相等蕴含像素相等，所以构造上就不可能"哈希对上但像素不同"。
代价是白干：143 → 156 像素一样，因为 PNG 编码器变了，11 片全重编。改动报告当时会说 `313 帧像素变了 → 0.00–10.43s`，
现在后面附一行：

```
  注意：上次是 Chromium 143.0.7499.4 截的，这次是 156.0.8078.4。上面比的是截图 PNG 字节，换浏览器构建后 PNG 编码会变，"变了"不等于像素变了。要判断像素，解码后比（例如两个 mp4 各跑 ffmpeg -f framemd5）。
```

（这一行只在上次清单里记的 chromium 与这次不同时出现；同一构建下输出与原来一样。）
没有发现错误复用旧分片的情况，所以缓存键没改。

### 11.4 顺手修掉的问题

- **旧构建下所有影片加载即失败**。Chromium 143/145/151（两种形态都是）加载页面时请求 `/favicon.ico`，404 打一条 console error，
  `openScene` 把它当场景错误中止：`✗ 场景加载报错，已中止：Failed to load resource: … 404`。156 不发这个请求，所以以前看不到。
  现在滤掉 location 是 `/favicon.ico` 的 console error；场景自己的 404 照常中止。
- **渲染失败也会改写 `film.json renderer`**。上面那次失败的渲染里，`--pin-renderer` 在加载场景之前就把记录改成了 143。
  现在渲染成功后才写。
- **指纹分不出 headless shell 与完整 Chrome**（11.1 第 3 条）。默认形态照旧只记版本号（已有 film.json 不会因此告警），
  另一种形态记 `<版本> (full Chrome)`。

**默认行为不变的核对**：不设 `FILM_CHROMIUM` 时，仓库里 11 部带 film.json 的影片 seamcheck 全部通过；`_test-motion` 的
`bad-random` `bad-loadrandom` `bad-waapi-undeclared` 仍然 EXIT=1；`capabilities.mjs` 报 Chromium 156.0.8078.4；
默认渲染 demo-tls 拷贝 7 次 mp4 md5 都是 `f54f8ccf…`。

### 11.5 两个没解释的异常（第一个在 §12 查清了）

- **旧版 headless shell 偶发纯白帧**。shell 143、145 共跑 9 次 5 帧截图，2 次从第二帧起全部截成纯白（均值 255），无任何报错。
  shell 156 和完整 Chrome 的所有运行里 0 次。整片渲染 #1、#7（shell 143/145）数过白帧：0/313。
  → §12.3：是"新装/新拷贝的二进制第一次启动"，可稳定复现。
- **完整 Chrome 156 一次整片渲染不可复现**。#6 的第 150–239 帧（连续 3 个 1s 分片，像是同一个 worker 的页面）与另外两次完整 Chrome 156、
  以及完整 Chrome 143/151 的结果不同：5.7%–6.1% 像素、最大 42–174/255；表中第 9 行那 6 次完整 Chrome 渲染没再出现。
  headless shell 路径 10 次整片渲染（143/145/151 各一次、156 七次）全部 `f54f8ccf…`。原因没查；门 1–4 在单个浏览器进程内，抓不到这种跨启动的差异——§12 加了门 5。

## 12. 第七轮：`--scale` 缩小版迭代 + 门 5 跨启动

来源：ghost-jam（16x9，22 辆车跟车仿真，708 帧）使用者的摩擦日志 F-030 / F-031，以及 §11.5 的两个异常。
测试都在 scratchpad 的拷贝上用 `--films-dir` 跑，仓库里的 `films/ghost-jam`、`films/demo-tls` 没碰（结束时核对过 md5）。

### 12.1 `--scale`

film-production 写了"迭代期一律半分辨率"，render.mjs 原来没有这个选项（F-031）。加了，实现是 CDP 截图时 `clip.scale` 降采样，
页面仍按全分辨率光栅化——缩小版是定稿帧的降采样。没用 deviceScaleFactor：那会换光栅路径，迭代看到的不是定稿。

ghost-jam，sub=1 veryfast，8 worker，24 分片：

| # | 操作 | 截图+编码 | 分片 编码/复用 | 产物 |
|---|---|---|---|---|
| 1 | 全分辨率 | 27.8s | 24 / 0 | `out/silent-16x9.mp4` 1920×1080 |
| 2 | `--scale 0.5` | 12.0s | 24 / 0 | `out/draft/draft-16x9-0.5x.mp4` 960×540 |
| 3 | `--scale 0.5` 再渲 | 11.9s | 0 / 24 | 同上，`与上次渲染相比：所有帧像素不变` |
| 4 | 全分辨率再渲 | 27.6s | **0 / 24（复用的是 #1 的全分辨率分片，没碰 #2 的）** | 1920×1080，`所有帧像素不变` |
| 5 | `--scale 0.25 --from 6 --to 8` | 1.6s | 2 / 0 | `out/draft/draft-16x9-0.25x-6-8.mp4` 480×270 |

缓存索引里三组 pkey 各自独立（24 / 24 / 2 片）。两份清单 `16x9.frames.json` 和 `16x9@0.5x.frames.json` 并存，#4 的"与上次比"对的是 #1。
2.3× 的提速来自截图侧：门 5 只截不编码，全分辨率一遍 28.7s、0.5x 一遍 13.5s，几乎等于渲染时间——瓶颈是浏览器里的全尺寸 PNG 编码，不是 x264。
错误路径：`--scale 1.5` → `✗ --scale 必须在 (0, 1]`；`--scale 0.5 --out silent-16x9.mp4` → `✗ … silent-*/final-* 会被下游当成定稿挑中`；
`--scale 0.5 --capture locator` → `✗ --scale 只支持 --capture cdp`；全部 EXIT=1。

防误当定稿：不叫 `silent-*` 且放在 `out/draft/`。核对过下游怎么挑：mux.sh 只认 `out/silent-<format>.mp4` 等确切名字，
contact.sh 认 `out/final-*.mp4` / `out/silent-*.mp4`（不进子目录），align.py 只认 `out/final[-<format>].mp4`——三者都挑不中缩小版。

### 12.2 门 5：跨启动（`seamcheck --relaunch N`）

做法：按 render.mjs 的拓扑（ceil(W/2) 个浏览器 × W 个页面、1 秒分片动态领活）每遍全新启动，截全片逐帧 md5；哈希算法与 render 相同
（每帧 = sub 个子帧 PNG 拼起来的 md5），所以还能和**上一次 render 的逐帧清单**对账。不同的帧把两边 PNG 存进 `out/.render/relaunch/` 并报幅度。

**代价**（ghost-jam 708 帧，sub=1）：全分辨率每遍 28.7s，`--relaunch 3` 墙钟 95s；`--scale 0.5` 每遍 13.2s，墙钟 48s；
`--every 3` 每遍 10.3s。定稿 sub=4 时每遍约 ×4。所以不是默认门，定稿前显式跑。

**`--scale` 损失的检出力**（合成用例：渐变 + 细线底上，一块 p×p 像素的 R 通道 +Δ，不回读 canvas）：

| p×p \ Δ | 1/255 | 3/255 | 8/255 |
|---|---|---|---|
| 全分辨率 | 1×1 起全抓到 | 全抓到 | 全抓到 |
| 0.5x | 1×1、2×2 **漏** | 1×1、2×2 **漏** | 全抓到 |
| 0.25x | 1×1 **漏**（2×2 抓到，取决于对齐） | 1×1 **漏** | 全抓到 |

4×4 起三档都抓到。也就是 0.5x 抓不到 §11.2 里"145 那一条扫描线、最大 3/255"那一类；抓得到下面两个真实异常（幅度都远大于此）。
（第一次做这个用例时变体用 `getImageData` 改像素，结果 0.25x 下 1×1 也"抓到"——是回读把整张 canvas 换了光栅路径，用例本身错了，§11.1 第 2 条。）

### 12.3 能不能复现 §11.5 的两个异常——先证明门有检出力

**纯白帧：复现了，根因是新二进制的第一次启动。** 原样重跑 24 次 + 在 CPU 满载下跑 126 次：0 次纯白。
注意到之前两次纯白都发生在**那个二进制的第一次启动**，于是把 `chromium_headless_shell-<rev>` 整个目录拷一份新的再启动：

```
shell-1200 副本A 第1/2/3次启动: .白白白白 ..... .....
shell-1200 副本B 第1/2/3次启动: 白白白白白 ..... .....
shell-1208 副本1 第1/2次启动:   .白白白白 .....        shell-1208 副本2: 白白白白白 .....
shell-1200 副本1 第1/2次启动:   .白白白白 .....        shell-1200 副本2: .白白白白 .....
shell-1234 副本1/2、shell-1248 副本1/2、完整 Chrome 156 副本：第 1 次起全部正常
```

143、145 的 shell 第一次启动 6/6 出白帧，之后的启动 0/158。默认的 156 不受影响。

用它当阳性对照验证门 5：新拷贝的 shell 143 **第一次启动就渲整片** → render.mjs 报 `✓ … 326 帧 … 分片：编码 11`，
成片里 **84/326 帧纯白**（每个 1s 分片的前约 11 帧，即每个页面开头）——静默失败。接着跑 `seamcheck --relaunch 2`：

```
门 1a ✓ 通过    门 2 ✓ 通过    门 1b ✓ 通过
门 5  跨启动：2 遍，每遍全新启动 4 个浏览器 × 8 个页面，326 帧 × 1 子帧：
  第 1 遍  4.7s  基准
  第 2 遍  4.7s  ✓ 与第 1 遍逐帧相同
  上次渲染清单 vs 第 1 遍：✗ 88/326 帧不同 → 0.00–0.37s, 1.00–1.37s, 2.00–2.37s, 3.00–3.37s, 4.00–4.37s, 5.00–5.37s —— 那次渲染的成片不可信，重渲
EXIT=1
```

结论很关键：**"再跑 N 遍彼此比"对这一类没有检出力**（事后的 N 遍都是好的），**有检出力的是和那次渲染的清单对账**。
这就是门 5 要读 `frames.json` 的原因。对账也要条件：同 fps/sub/shutter、整片、同浏览器构建（PNG 字节跨构建不可比）；
不满足时它明说"不对账"而不是假装通过。阴性对照：ghost-jam 全分辨率渲一次后 `--relaunch 2 --every 3` → `✓ 236 帧逐帧相同`；
`--scale 0.5` 对 `@0.5x` 清单 → `✓ 708 帧逐帧相同`。

**完整 Chrome 156 的跨启动差异：碰到了一次，量不出来。** `FILM_CHROMIUM` 指到完整 Chrome 156，demo-tls `--relaunch 6` 跑 5 次共 30 遍：
第一次的第 1 遍在第 210 帧（t=7.00s，分片首帧）与其余 5 遍不同，其余 29 遍彼此一致。当时门 5 还不存 PNG，幅度没留下；
加了存图之后又跑了 18 遍，没再出现。所以门 5 **对这一类有检出力**（它确实报了），但复现率低（约 1/30 遍），原因仍不知道。
存图与报幅度的路径用一个故意加载时随机的场景走通过：`16000 像素不同（0.77%），最大差 204/255 → out/.render/relaunch/t0.000-run{1,2}.png`。
默认 headless shell 156：门 5 共 18 遍（ghost-jam 12、demo-tls 6）全部一致。

**真出了这类问题怎么查**：见 `references/nondeterminism.md`「门 5 失败」。要点：先分"N 遍之间不一致"还是"只和渲染清单不一致"；
看不同的帧是不是整片分片对齐（是 → 页面/浏览器级状态，不是场景代码）；永远解码后比幅度；换构建时先查字体是不是随片打包。

## 13. 第八轮：空间锚点 `assets/runtime/anchors.js`

契约见 ARCHITECTURE §10。在 `films/ghost-jam` 上接入（黄车、灯团、停着的车、参照树、树#k、岗亭、字幕底条），实测：

```
Node 单元（假 canvas 1920×1080）：
  seek 之外 A.box(...)          → 抛错「anchors.登记() 在 seek(t) 之外调用」
  seek 之后 A.get(...)          → 抛错
  同名两次 box → 外包、n=2；disc(0,0,96) → x=-0.05（不裁剪）；ctxRect 按 getTransform 映射 → 正确
ghost-jam 只加登记、不改构图，整片重渲：与上次渲染相比 0–11.27s 帧像素全同（11 片复用），
  变了的 370 帧全部在 11.27s 之后——那是同一轮改的推近终点。登记本身不动像素。
seamcheck / relaunch（门 5，--sub 4 对账）/ physcheck 重渲后全过（accept --film ghost-jam 8 门全绿）
anchors(t) 代价：286 帧 4.7s ≈ 16ms/帧（整帧绘制；同片像素断言 158ms/帧）
```

阴性对照（夹具副本，对 check.mjs 的锚点门）：把上一帧的黄车框并进本帧 → `anchors.pure` 和两道法律门都报不纯；
把历史框**累积**并进来（会饱和）→ 顺序/倒序结果相同，纯函数检查**抓不到**，只有 `claims.anchor`（cx 不再变化）报红。

## 14. 第九轮：透视相机 `assets/runtime/camera3d.js` + 压扁扫描 `scripts/tiltcheck.mjs`

起因：weiqi-intro 第一版的开场棋盘用 `setTransform` 纵向压扁当"斜着看"，用户一眼看出"像长方形"，所有门都没抓到。
那支片子后来自己写对了（针孔投影 + 着色器反投影），这一轮把它提炼成运行时，**weiqi-intro 本身没改**。

夹具在 scratchpad（`FILMS_DIR` 指过去），同一块 19 道棋盘六种画法：`persp`（camera3d，俯角 90°→35° 弹簧 + yaw 随 t 转）、
`topdown`（camera3d 正俯视）、`squash`（setTransform 压扁，错法）、`path2d`（压扁 + Path2D）、`stretchimg`（方贴图 drawImage 拉扁）、`balls`（12 个小球挤压拉伸）。

**数值**（WebGL2 RGBA32F 帧缓冲读回，1080×1920 每 7 px 取一点，42630 点）：

```
                 GL反投影→JS投影 回原像素   JS 自身互逆      JS vs GL 反投影（世界单位）  GL 自身互逆   远/近边比  透视vs压扁
正俯视 90°        2.2e-4 px                 1.6e-13 px      4.6e-6                      1.4e-4 px    1.000      0 px
俯角 60°          3.3e-4 px                 5.1e-13 px      1.3e-5                      2.5e-4 px    0.739      103 px
俯角 35°          3.0e-4 px                 5.1e-13 px      9.5e-4（近地平线处 float）   3.7e-4 px    0.606      166 px
俯角 35° yaw 0.6  3.5e-4 px                 7.2e-13 px      9.7e-4                      5.5e-4 px    —          192 px
俯角 35° d=200    2.9e-4 px                 4.7e-13 px      1.2e-5                      2.7e-4 px    0.929      19.5 px
俯角 85°          2.5e-4 px                 5.1e-13 px      5.0e-6                      2.5e-4 px    0.949      16.7 px
与 weiqi-intro 的 project()（tilt=sin 俯角，yaw=0，4 个俯角 × 242 点 × z∈{0,0.3}）最大差 2.3e-13 px
```

GLSL 与 JS 互逆误差 ≤ 5.5e-4 px（float32 量级），正俯视时 z=0 平面的透视量精确为 0（远近比 1.000、与压扁差 0 px）。
`seamcheck --entry persp.html`：门 1a/1b/2 全过、禁用 API 探针无。

**压扁扫描阴性对照**（`tiltcheck --strict`，4fps × 3s = 12 帧）：

| 夹具 | 结果 | 退出码 |
|---|---|---|
| squash | 0.75–3.00s 34% 面积，σ2/σ1 0.74（≈ 俯角 48° 的纵向压扁）| 1 |
| path2d | 0.75–3.00s 28%，0.74 | 1 |
| stretchimg | 0.75–3.00s 34%，0.74 | 1 |
| persp | 无（真透视在扫描里自然为空）| 0 |
| topdown | 无 | 0 |
| balls | 最大组 0.7% 面积（σ2/σ1 0.52），低于 10%，不报 | 0 |

0–0.75s 不报是对的：那时俯角还在 90° 附近，σ2/σ1 ≥ 0.9。接进 check.mjs 的版本（临时副本，未落盘）在三份夹具上：
squash → `LOOK tilt.ortho`，persp → 无，squash + critique 块 `"ortho_ok"` → `PASS tilt.ortho`（只报告）。

**现有片子**：

| 片子 | 结果 | 耗时 |
|---|---|---|
| weiqi-intro | 最大组 0.9%，不报 | 243 帧 17.6s（≈ 72ms/帧，片子本身的着色器层贵）|
| demo-tls | 无 | 44 帧 24ms |
| ghost-jam | **0–23.75s 100% 面积 σ2/σ1 0.52**（`TILT = 0.52` 纵向压扁整块地面）| 95 帧 2.1s |

ghost-jam 是真阳性，而且和 weiqi-intro 同一类：它的 style_guide「构图策略」写"近大远小只做简单透视"，
场景的 `proj()` 却是 `s` 与深度无关的纯正交（`y·s·TILT`）。没改那支片子，记在这里。

## 15. seamcheck 门 1a/2 失败时分辨"字体来得晚"

字体分片在 seek 期间才加载（`loadFonts` 漏列了运行时拼出来的数字）时，第一次画到它的那一帧用回退字体，
门 1a、2 会红——但提示语是"读了时钟/Math.random""存在跨帧状态"，方向错，作者要自己猜。
现在门 2 之后、只在 1a 或 2 失败时，比一遍初次就绪时和现在的 `document.fonts` 状态，有 FontFace 在 seek 期间
从 unloaded 变成加载中就加一行 ⚠，指向 film-assets 的 `font_source.mjs`（那里点名是哪些字）。只是提示，不改任何门的判定。

| 夹具（scratchpad，`FILMS_DIR`） | 结果 |
|---|---|
| lazy-bad（`白子：${n} 口气` 的数字没列进 loadFonts） | 门 1a、2 ✗（t=2.267s 6388 像素）+ ⚠ "1 个 FontFace 是 seek 期间才开始加载的：Noto Sans SC Variable U+20-3D…" |
| lazy-ok（按类声明 `sets: ['digits']`） | 全部通过，没有 ⚠ |

没测：门通过时不检查（晚加载却碰巧像素一致的情形不提示——那种情况 font_source 仍会判不合格）。

## 16. 自适应子帧 `window.MOTION` + 静止帧只截一张 + 硬切同侧（2026-10-23）

做法见 SKILL.md §5。测试都在 scratchpad 的影片拷贝上（`--films-dir`），基线是改动前 `scripts/` 的整份拷贝。

**老片逐字节不变**（没定义 MOTION 的片子不经过新路径）：

| 片子（sub=4） | 区间 | 改前 / 改后 mp4 md5 | 逐帧哈希清单 | 截图+编码 改前 / 改后 |
|---|---|---|---|---|
| `_test-motion` 30fps | 0–2s，两次 | `c6be58d4…` / 同 | — | 5.6 / 5.7s，5.5 / 5.6s |
| `_test-physics` 60fps | 1–4s | `fd038e7f…` / 同 | 逐字节相同 | 14.1 / 14.1s |
| `_test-typography` 30fps | 1–4s | `ff44cabc…` / 同 | 逐字节相同 | 5.2 / 5.2s |

缓存键也没变：改前渲一遍建缓存，改后渲同片 → `分片：编码 0 / 复用 2`，`所有帧像素不变`。

**PNG 解码器**：3 支片 × 4 个时刻的 CDP 截图，`decodePng` 与 ffmpeg 解码逐字节相同 12/12；同一张图 5 份平均 = 原图 12/12（静止帧单张与 n 张平均在这条路径上等价）。

**残影对比**（截图在 `<scratchpad>/shots/`）：
- `_test-motion` 加上按路径长度算的 MOTION，t=0.233：改前 4 个分离残影，改后连续拖影、指针扇形变平滑。60 帧 240 → 1352 次截图（单帧最多 48），1.8s → 17.3s（`--chunk-seconds 0.25`）。
- 合成片（16x9，白点 3000px/s = 100px/帧，半径 8px；0.6–2.05s 静止；2.05s 硬切）：改前 4 个点，改后一条线（17 张）；
  90 帧 541 次截图（固定要 360），静止帧 44 帧各 1 张。跨切点那一帧（t=2.033）改前混了一半下一个镜头（橙条 + 半透明白点），改后只有本镜头。
- 默认 1s 分片时快段全落在第一片，墙钟 10.5s；`--chunk-seconds 0.2` 4.1s（改前固定 sub=4 2.1s）。
- MOTION 恒返回 0 的撒谎场景：15 帧全部两端不同 → 退回 4 张 + 警告，EXIT=0。

没测：WebGL / DOM 场景用 MOTION；RGBA PNG（Chromium 截图实测都是 RGB）；线性光平均（待办，见 SKILL.md §5）。

## 17. PNG 快速编码 + 门 5 按清单对账、少跑一遍 + 门 4 顺序那一遍分段并行（2026-10-23）

测试全在 scratchpad 副本（`--films-dir …/scratchpad/perf2/films`），基线是改动前 `film-motion/` 的整份拷贝。机器同时在跑别的进程（load 7–16），计时只看相对值。

**fast PNG 确定性**（`openScene({ png:'fast' })` = CDP `optimizeForSpeed:true`）。每片 12 个时刻：同页连截 4 次（中间插一帧别的）、同浏览器另一页、另一次启动的浏览器，比 PNG **字节**；再与 default 模式解码后逐像素比：

| 片子 | 同页 ×4 字节 | 跨页 + 跨启动字节 | fast ≡ default（解码） | 单帧 fast / default | PNG 大小 fast / default |
|---|---|---|---|---|---|
| weiqi2-l1 | 12/12 | 12/12 | 12/12 | 45 / 174 ms | 939 / 654 KB |
| weiqi2-l1 @0.5x | 6/6 | 6/6 | 6/6 | 37 / 88 ms | 344 / 251 KB |
| _test-webfx（WebGL） | 12/12 | 12/12 | 12/12 | 88 / 160 ms | 733 / 417 KB |
| weiqi-fx-eyes | 12/12 | 12/12 | 12/12 | 30 / 39 ms | 124 / 85 KB |

字节确定，所以帧哈希继续用 PNG 字节 md5，不需要改成解码后像素哈希（那要多付一次解码）。整片佐证：weiqi2-l1 副本用 fast 重渲（sub 4 / shutter 0.5，6420 次截图）得到的 silent mp4 与 films/ 里那条 default 渲的**逐字节相同**（`aa30cc08…`）；
`_adapt`（自适应子帧）和 `_leak-adj`（tmix 路径）各渲 fast / default 两遍，mp4 md5 相同。缓存键：default ↔ fast 交替渲 `_clean` → 编码 3/复用 0、编码 3/复用 0、复用 3、复用 3；改动前的 render.mjs 能复用新代码 default 模式留下的分片（default 键没变）。`--capture locator` 的清单不带 `png`（= default）。

**门 5 对账修复**：weiqi2-l1 清单 `shutter 0.5`，film.json 没写 shutter（默认 1），旧门 5 报"设置不同（shutter: 0.5 → 1），不对账"后判 ✓——对账从没发生。
同样的片子（清单 shutter ≠ film.json）：weiqi-fx-eyes、weiqi2-l1、l2、l4、l5（l3 film.json 写了 0.5，不受影响）。现在 fps/sub/shutter/PNG 模式/自适应参数全取清单。

| weiqi2-l1 副本（1605 帧 × sub 4） | 改前 | 改后 |
|---|---|---|
| 门 4（`--parallel 4`，整条 seamcheck） | 521 s，✓ | 88 s，✓ 1605 帧 0 帧不同 |
| 门 5，旧 default 清单（`--relaunch 2 --sub 4`，即 accept 的调用） | 554 s（2 遍 × 272 s），**没对账** | 273 s（新跑 1 遍，PNG default），**✓ 1605 帧与清单逐帧相同** |
| render（fast，sub 4 / shutter 0.5） | 277 s（perf/ 里的旧计时） | 61 s |
| 门 5，fast 清单 | — | 58 s，✓ 逐帧相同 |

weiqi-fx-eyes 副本门 5（旧 default 清单）：27 s，✓ 920 帧与清单逐帧相同。

**门 5 判定与分诊**（`_clean`，3s / 90 帧；`_leak-load` 加载时 `Date.now() % 2` 决定颜色）：

| 情形 | 结果 |
|---|---|
| 刚渲完 | ✓，新跑 1 遍 |
| 清单里改 3 个哈希（模拟"那次渲染坏了"） | ✗ 3/90 → 补跑第 2 遍与第 1 遍相同 → "输入没变，问题出在那次渲染的进程里" |
| 同上且删掉 `inputs`（模拟旧清单） | ✗ → "没有输入指纹，分不清渲坏了还是改过输入，都要重渲" |
| 渲完后 scene.html 加一行注释 | ✓ + "输入改过，但逐帧像素不变" |
| 渲完后改颜色 | ✗ 90/90 → "输入改过，成片已过期" |
| `_leak-load` | ✗ 60/90 与清单不同 → 补跑第 2 遍又与第 1 遍差 30 帧 → "不同启动渲出不同的帧" |
| `_adapt`（MOTION + CUTS，`--sub 4 --shutter 0.5` 渲） | ✓，按清单的自适应参数截，没传 --shutter |

门 5 对同拓扑下的跨帧泄漏（`_leak-adj`、`_leak-vol`）改前改后都是 ✓——那是门 4 的事，门 5 从来不抓它。

**门 4 检出力**：顺序那一遍改成 4 页各截一段、段前用 `advance()`（shot 去掉截图）顺序 seek 0…a−1 补齐历史。

| 场景 | 改前 | 改后 | 对照变体：段前只重叠 1 秒（截而不补全历史） |
|---|---|---|---|
| `_clean` | ✓ | ✓ | — |
| `_leak-adj`（上一次正好是前一帧时走增量欧拉，否则闭式解；门 1a/1b/2 全 ✓） | ✗ 239/240 | ✗ 239/240 | ✗ 239/240 |
| `_leak-vol`（本页 seek 过 150 次后颜色差 2/255；门 1a/1b/2 全 ✓） | ✗ 90/240（5.000s 起） | ✗ 90/240（同样的帧） | **✓ 漏掉** |

所以段边界必须补齐完整的顺序历史，只重叠一小段会漏"页面求值过多少帧才出现"的泄漏。

没测：补历史用的 advance 不截图，页面这段时间里合成的帧数比改动前少——靠 rAF/合成次数推进状态的场景（契约禁止，探针在 seek 内能点名）在两种做法下 seek 历史相同、合成次数不同；没构造这种用例。

## 没测到 / 没解决

1. 门 3b 单独失败（首尾相等但速度不连续）没有构造用例。
2. 1x1 画幅没渲过（9x16 和 16x9 渲过）。
3. `--shutter <1`、`--dur` 没跑过。`--all` 由 film-production 用 `formats: [9x16,16x9]` 批渲两画幅验证过（他们的实测，不是我跑的）。
4. 跨机器确定性：编码器层已消掉（第 10 节）；浏览器的**版本轴**同机实测关掉了（第 11 节，143→156）。
   **GPU / 操作系统轴没关**：8 个构建都在同一台 macOS、同一个 SwiftShader 软件渲染下跑，换 Linux + FreeType 字体栈、
   或换真 GPU 光栅会怎样不知道。`--font-render-hinting=none` 在 macOS 上整体无效（CoreText 不做 hinting），
   它是给 Linux 买的保险，而 Linux 正是测不到的那一侧。版本轴的结论也只来自 demo-tls 一支片（2D canvas 文字 + 方块字符），
   WebGL / SVG 滤镜 / 大面积渐变的片子没换构建测过。
11. 换浏览器构建后分片缓存整体重编，哪怕像素没变（第 11.3 节，143→156 白重编 11/11 片）。根因是哈希比 PNG 字节；
    改成哈希解码后的像素能省掉这次重编，但每帧要多一次 PNG 解码，没做。方向是保守的，不会错用旧分片。
12. 纯白帧已查清（§12.3：143/145 的 shell 新二进制第一次启动，6/6 复现），但**为什么**第一次启动会白没查（猜是 macOS 首次校验签名拖慢了 GPU 进程，没证实）；
    render.mjs 不会自己发现它，要靠渲染后 `seamcheck --relaunch 2` 和清单对账。完整 Chrome 156 的跨启动差异约 1/30 遍，原因不知道，幅度没量到。
    原来这条：旧版 headless shell 偶发从第二帧起纯白（9 次里 2 次）；完整 Chrome 156 有 1 次整片渲染
    3 个分片与其余 6 次不同。默认路径（headless shell 156）10 次整片渲染全部一致，没见到这两种情况——但这只是"没见到"。
13. 别的 skill 自己 `chromium.launch()` 的工具（film-physics `physcheck`、film-typography、film-webfx、film-assets 的检查脚本）
    不走 `launchBrowser()`，不跟随 `FILM_CHROMIUM`，也不带 `--font-render-hinting=none`。不在本 skill 边界内，没改。
5. seamcheck 只抽样 8 个时刻，不是逐帧；某一帧才触发的非确定性（例如只在第 37 帧调 Math.random）可能漏掉——
   探针只在被采样的 seek 期间计数。要全覆盖用 `--samples` 加大（成本线性）。
6. playwright 的 cwd 回退解析（skill 装在插件缓存、playwright 在调用方项目）没有在真正分离的布局下测过；
   本仓库里走的是第一条（按 skill 位置向上找到仓库根 node_modules）。
7. tmix 在 gamma 空间平均，拖影亮度不是物理正确的；没有提供线性空间方案。
8. 自定义画幅（4x5 等）不支持。
9. 分片缓存不自动清理：每个编码参数组合 × 每个分片位置留一份。长片反复切换 `--sub 1` / `--sub 4` 时会累积，靠 `--clean-cache`。
   x264 线程数不同时输出不等价（最大差约 60/255），已把 `-threads` 钉死并放进缓存键隔离（第 10 节）。
   **ffmpeg/x264 版本**也在缓存键里；但同一 ffmpeg 版本号下 x264 库版本不同（不同发行版的构建）没有区分。
10. 默认 workers = CPU/2。场景加载很贵或内存很大时可能要调小；没有自动探测。
14. 门 5 的 `--scale 0.5` 漏 ≤2×2 像素、≤3/255 的局部差异（§12.2）。要守亚像素级就用全分辨率跑，成本翻倍。
15. 门 5 只能和**最后一次**整片渲染的清单对账；区间渲染会替换基线（render.md）。sub>1 的定稿要用同样 `--sub` 跑门 5 才对得上，成本 ×sub。
16. `--scale` 只省截图侧（PNG 编码）和编码，不省光栅：canvas 场景照常按全分辨率画。光栅很贵的场景（大着色器）提速会小于 2.3×，没测。
17. **`anchors.js` 只在 ghost-jam 一支 2D canvas 片子上用过**。WebGL / SVG / DOM 场景怎么登记（没有 ctx 变换可取）没做过，
    目前只能 `A.box` 传自己算的屏幕框——那就又回到"另算一遍"，要靠和像素断言并行来兜。
18. **累积型跨帧泄漏**（把历史框不断并进同名锚点）在顺序/倒序比对下会饱和成同一个框，纯函数检查抓不到（§13 阴性对照）。
    门 1b 那样的"全新页面冷求值"能抓，但锚点没进 seamcheck，没做。
19. **camera3d 只在夹具里用过**，没有真片子从头用它做。GLSL 片段只在 WebGL2（`header2`）下读回验过数值；WebGL1 下只是同一段源码，没单独读回。
    平面上的圆画成 `ellipse(rx·k, rx·k·sin e)` 是小圆近似（大圆在透视下不是以投影中心为心的椭圆），误差没量。
20. **压扁扫描结构上只能当疑点**：斜放正方形的正交像与正俯视长方形逐像素相同，"本来是不是方的"只有作者知道。
    看不见：着色器里压扁、加载时预渲进离屏 canvas 的压扁、CSS transform、`ellipse()` 的 rx≠ry。阈值（10% 面积、σ2/σ1 0.9）只在夹具 + 三支片上校过。

---

## §MG 镜头 / 转场 / 缓动编排（choreo.js + transitions.js，2026-10-21）

夹具 `tests/fixtures/_test-mg`（16x9，30 fps，14.4 s，12 镜头、11 个转场，第 10 个剪辑点钉在合成字时间戳「移」上）。

```bash
node skills/film-motion/scripts/seamcheck.mjs --film _test-mg --samples 48 --parallel 4
# 门 1a ✓  门 2 ✓  门 1b ✓  门 4 ✓ 432 帧 0 帧不同  探针 ✓ 无     （门 3 非循环片只报告）
```

**门 4 抓到一个采样门抓不到的确定性问题**：第一版离屏层用 `imageSmoothingQuality='high'`，门 1a/1b/2（48 个采样时刻）全过，
门 4 报 4/432 帧不同（5.667 / 5.700 / 5.767 / 5.933 s，全在 zoomThrough 窗口）。单页复现（同一 t，变的是前一帧）：

```
t       冷求值      前一帧=t-1/30  前一帧=1.0s  前一帧=t+1/30
5.667   ab97fc479e  9f33cf3a02     ab97fc479e   9f33cf3a02   DIFF
5.767   0762a8c280  0762a8c280     b52b30132f   0762a8c280   DIFF
```
改 `'medium'`（和 `'low'`）后四种前序哈希全同，门 4 0/432。运行时现在一律 `'medium'`。根因没查到 Skia 层。

**每帧耗时**（1920×1080，Chromium 156 headless shell，SwiftShader；单页串行）。"绘制" = 页面内 seek + `getImageData(0,0,1,1)` 强制光栅完成，
3 遍全片的中位数（读回会改变后续光栅路径，所以这个页面只计时）；"seek+截图" = render 同路径（CDP），中位/最大。
测量时机：两次。第一次 2026-10-21 15:22，`ps` 里另有 2 个渲染/检查进程（其他 agent 的 accept/render）。按协调者要求等空闲重测：16:12 前等了 20 分钟，机器一直没空下来（其他 agent 的全仓库 accept、weiqi-fx-open 渲染，3–6 个进程），于是 16:12–16:13 在负载下又测了一遍：绘制中位数与第一次相差 ≤ 3%（如 luma 49.7→50.4、whip 99.5→100.8、magicMove 6.1→6.2 ms）。单页串行在 16 核机器上看来不受这点负载影响，但**没有在真正空闲的机器上测过**。下表取第一次的值。

| 段 | 绘制 ms | seek+截图 ms |
|---|---|---|
| 单镜头帧（s1–s12） | 0.2–3.1 | 16–45 |
| wipe linear | 10.2 | 51 / 65 |
| wipe iris | 5.4 | 29 / 44 |
| wipe bars | 5.5 | 34 / 45 |
| luma noise（细颗粒 3 层 + 烧边） | 49.7 | 108 / 152 |
| push | 12.8 | 52 / 61 |
| zoomThrough | 14.4 | 40 / 67 |
| glitch（16 条 + RGB 分离） | 41.0 | 76 / 91 |
| leak（bloom 0.45，3 团光斑） | 33.6 | 132 / 354（最大值是首帧建模糊层） |
| whip（对数步长拖影 6 遍 = 64 抽头） | 99.5 | 133 / 144 |
| match | 11.5 | 37 / 65 |
| magicMove（2 个 morph + 1 个 FLIP 元素，root crossfade） | 6.1 | 31 / 60 |

整段渲染（5 worker，sub=1，veryfast）：0–4.8 s 144 帧 3.0 s；3.0–9.9 s 207 帧 4.8 s；9.6–14.4 s 144 帧 1.5 s。

**静帧看出来、门看不出来的三处**（都已修）：
1. 甩镜第一版"叠 10 份"拖影：静帧 9.6 s 出现 10 道分离的竖边（每道约 60 px）。改成对数步长盒式模糊。
2. 匹配剪辑 `meet: 0.5` 让 B 缩到 0.85 倍：静帧 10.75 s 四周露黑边。加 `cover` 约束（缩放 ≥ 1、平移不露边），夹具改 `meet: 1`。
3. 噪声溶解第一版粗颗粒（cell 0.05）+ 宽软边 + 亮烧边：用户看小样指出"满屏大块黑白斑，像廉价转场"。烧边宽度/亮度改成必填参数，夹具改细颗粒。

**缓动**：`easeInfo()` 全表见 `references/transitions.md` §7（back.out 过冲 10.0%、elastic.out 37.3%、`cubicBezier(.25,.1,.25,1)(0.5) = 0.8024` 与 CSS `ease` 一致）。
`timeline()` 的校验在 Node 里跑过：缺 ease / 缺 each|amount / 窗口重叠 都抛错；`at()` 在窗口边界 0.75 / 1.249 / 1.25 / 2.0 s 返回预期的镜头与局部时间。

**没测到**：9x16 / 1x1 画幅（像素数相同，没单独跑）；真 GPU；`slide` `zoom` `dip` `crossfade` `wipe clock/box/custom` 没进夹具时间轴（代码路径与已测的同构，耗时是估计值，表里标了 ~）；
render `--sub 12` 与场景内拖影叠用的效果。

## §t80 缓动 / 弹簧预设的 t80 列（2026-10-23）

`references/transitions.md` §7 缓动表与 SKILL.md 弹簧预设表各加一列 t80（第一次走到 80% 行程的时刻占比），只加数据、不加推荐。
数字不是估的：film-research 的 `motionprint.mjs --curves` 直接 import 本 skill 的 `choreo.js` / `motion.js`，10⁵ 点扫描求第一次 ≥ 0.8 的 p；
弹簧在 [0, 停止时长] 上 2×10⁵ 点扫描 `settle()`。

```
$ node skills/film-research/scripts/motionprint.mjs --curves
  linear 0.8 · sine.out 0.59 · quad.out 0.553 · cubic.out 0.415 · cubic.inOut 0.632 · quart.out 0.331 · quint.out 0.275
  expo.out 0.232 · expo.inOut 0.566 · circ.out 0.4 · back.out 0.241 · back.in 0.955 · elastic.out 0.06 · bounce.out 0.325
  snappy   320/30  停止 0.39s  t80 0.142s = 0.365
  default  170/26  停止 0.566s  t80 0.229s = 0.405
  heavy    90/24  停止 1.198s  t80 0.405s = 0.338
  playful  260/16  停止 0.568s  t80 0.117s = 0.205
```

交叉核对：quad.out / cubic.out / quint.out / expo.out 与 onetake `lib/motion.js` 注释里的 .55 / .42 / .28 / .23 一致。
**没测到**：越界缓动（back、elastic、anticipate）的 t80 按"第一次过 0.8"算，和"按行程累计 80%"（视频测法）定义不同，两者在这几条上不可直接比。

## 附：弹簧反解的推导（从 SKILL.md §3 移来）

- `overshoot` 反解 ζ：欠阻尼峰值过冲只取决于 ζ，`ζ = -ln(OS)/√(π²+ln²OS)`，闭式。
- `duration` 反解 ω：响应只依赖 ωt，所以停止时刻 = τ\*(ζ)/ω，τ\* 在无量纲曲线上数值求一次（扫描+二分），
  是精确的"最后一次越界"时刻（此后 |x−1| 永远 ≤ eps，eps 默认 0.005 行程；1080px 行程 ≈ 5px）。
- 实测 24 组 (duration, overshoot) 往返误差 ≤ 0.005%，过冲误差 < 1e-4。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

skill 里只留结论和可执行判据；以下来历、实测细节从 `skills/film-motion/` 的 md 移来。

**transitions.md §0 代价表的来历**：借自 Anthropic frontend-design skill 的 Motion 一节（一次编排好的错峰揭示胜过到处撒的微交互；
实现复杂度要和美学愿景匹配），翻译成影片里每个转场要付的注意力账。

**transitions.md §3 合成管线**（为什么 luma 是遮罩类的 5 倍）：亮度图 → `lighter` 加 (1−p) → `difference` 取反 → `brightness(k)` 滤镜拉成软阈值 →
乘法合成 `A·(1−m) + B·m`；开 `burn` 再加一次滤镜和三次合成。wipe 是两次全屏 drawImage + 一次遮罩绘制。

**transitions.md §4 Magic Move 的出处**：Keynote Magic Move、PowerPoint 平滑（Morph）、CSS View Transitions 的分层模型。
FLIP 叠化用 plus-lighter 是照 VT 给 `::view-transition-old/new` 默认加 `mix-blend-mode: plus-lighter` 的理由（重合处不透明度 (1−q)+q = 1）。
`root` 必给：VT 默认是叠化，这里不替调用方选。

**transitions.md §5/§6/§10 的来历**：匹配剪辑 `meet: 0.5` 露黑边 → 加 `cover`、夹具改 `meet: 1`；甩镜"叠 10 份"残边 → 对数步长
（和渲染器 sub=4 残影是同一现象）；`imageSmoothingQuality='high'` 门 4 4/432 帧与单页复现哈希——都见上文 §MG。疑似 high 质量缩放用到的缓存
（mipmap/滤镜中间结果）按源画布对象复用、没有按内容失效；夹具 s10→s11 的 Magic Move 在「移」字落定（`align: 1`）。

**ui-rebuild.md 的实测例**（完整记录在 docs/verified/film-story.md §2g）：
- CSS 不收根类名的代价：onetake 记录过复刻里的通用类 `.ph` 和片子样式撞出满屏虚线框。
- 复刻缩放 1.5625、变焦 1.772 时 `localRect` → 画面与 BCR 相差 ≤ 1.4 px；把 BCR 的 x=1014 当参考帧坐标再映射一次落在 x≈2408，出画。
- 整数 `offsetWidth` 排版：靠右排的计时文字整体左移约 1 px，差异图上一圈重影。
- 可读性算术核对：渲出来字的墨迹高 27 px，参考截图同一串字 10 px × 1.5625 × 1.772 = 27.7 px。

**camera3d.md 的来历**：weiqi-intro 的棋盘面在着色器里反投影取木纹和线，棋子、厚度、影子、气泡在 JS 里 `project()`；远处线宽加 `0.5·fp` 是它的做法。
"提前约 0.1s 跟拍、甩镜先定落点"两条手法借自 onetake。正交 vs 透视判据表的数字见上文 §14。

## shapes.js 矢量形状层（trim / morph / along / pathSampler，2026-11-10）

**测了什么、怎么测**：
- Node 数值断言 `node tests/fixtures/_test-shapes/tests/unit.mjs`（51 条，同时覆盖 film-core 的镜头组合子，见 film-core.md 同日一节）：**51 通过 0 失败**。
  - 弧长：正方形 400、相对命令 `m l h z` 120、退化三次曲线 100、多子路径空跳不计长度、粘连数字 `M1.5.5L-1-2e1`、紧凑弧标志 `a50 50 0 01100 0`。
  - 压平误差（tolerance 0.25）：r=100 圆周短 0.488 px（相对 0.078%），r=50 半圆 156.827 vs 157.080（0.16%），二次曲线 147.762 vs 解析值 147.894；
    tolerance 0.01 时圆周差 0.021 px、二次曲线 147.888。相对误差与 tolerance/(3r) 的估计一致。
  - trim：`trim(0,0.25)` 终点 (100,0)；`(0.125,0.375)` 端点 (50,0)→(100,50)；闭合路径 offset 绕过起点接成一条 (0,50)→(50,0)、长 100；开放路径绕回拆两段共 30；
    start=end 返回空；0→1 返回闭合整条；多子路径整体模式与 each 模式的长度分别为 20 和 5+15。
  - along：(0.625) = (50,100) 朝左；闭合路径 1.125 绕回；lookahead 在直角处给 45°（0.7854）。
  - morph：p=0/1 与原形状偏差 0；p=1e-9 / 1−1e-9 偏差 1.0e-7 / 9.7e-8 px（角点吸附）；方→五角星 19 个中间态自交 0（对照 `align:'none', winding:'keep'` 13 处，平均位移² 27351 vs 4588）；
    圆→逆时针方自动反转、自交 0；子路径数不同且没给 orphans 抛错；`orphans:'self'` 孤儿 p=0.5 时是以自身质心 (200,300) 为心、半径 20.000 的圆（原 40）；
    `'nearest'` 从对面已配对子路径的质心 (100,100) 长出；带孔形状外框配外框、孔配孔；开放路径反向更近时反转。
- 难例（scratchpad 脚本，39 个中间态 p=k/40，selfCrossings 计数）：凸↔凸、五角→八角（N=64 与 283）0/39；C 形→圆 23/39 帧（每帧 ≤1 处）；细长蛇形→圆 15/39（≤2）；8 字→圆 17/39。数字已写进 shapes.md §7。
- 耗时（Node 22，Apple Silicon，hrtime）：pathSampler(圆 r=300) 0.031 ms、78 点；trim 0.003–0.007 ms/次；morph 建表 N=64/256/1000 为 0.20/0.38/2.39 ms，m(p) 0.0012/0.0020/0.0078 ms/次。
- 夹具 `tests/fixtures/_test-shapes`（16x9，6 s，checks []，没有 runtime/）：scene.html 同时用 sequence（一处硬切 2.0、一处交棒窗口 [3.9, 4.5]）、trim（生长、两端收、开放路径循环光段）、
  morph（方→五角星、五角星→2 圆→3 圆，orphans:'self'）、along（lookahead）。
  - `node skills/film-core/scripts/seamcheck.mjs --film _test-shapes --films-dir tests/fixtures`：门 1a/1b/2 各 8 个时刻逐像素一致，探针无，**全部通过**；`--parallel 4`：180 帧 0 帧不同；`--entry strip.html`：全部通过。
  - `node skills/film-critique/scripts/stills.mjs … --at 0.4,0.9,1.6,2.9,3.3,4.2,4.9,5.6` 与 `--entries strip.html` 出图，Read 打开逐张看：
    strip.html 第 1、2、4 行（对齐后的 morph）七个 p 都没有翻折/打结，第 3 行（不对齐对照）中段拧成一团并自交；第 5 行 trim 描边末端与 along 打的点重合；
    scene 里 1.6 s 开放波浪路径的光段绕回时是首尾两截，4.0–4.9 s 交棒窗口内两个镜头按 enter/exit 叠化，孤儿圆从自己的位置长出。
  - 第一版夹具 split 镜头从 morph 的 p=0.5 起步（夹具自己的错），看图发现后改成从 0 起。

**没测到**：浏览器里的逐帧耗时（只在 Node 量过）；`toPath2D` 只在夹具页面里间接走过（scene 用的是 tracePath）；与 DOM SVG `getTotalLength()` 的逐条对账；
`'nearest'` 的视觉效果（只有数值断言）；Magic Move 里接 morph 的写法（transitions.md §4 写了接法，标注未实测）；自交路径与孔洞包含关系的更多形态；9x16/1x1 画幅。

## chart.js 数据图表几何（比例尺 / 格式 / 序列 / 竞赛 / 刻度进出 / 地理 / 力导向，2026-11-10）

测了什么、怎么测：Node 断言脚本 `tests/fixtures/_test-dataviz/tests/unit.mjs`（95 条，最后一段起 Chromium 比对逐位一致）；
夹具 `tests/fixtures/_test-dataviz`（16x9，8 s，checks []，没有 runtime/）四格同屏：柱状图竞赛 + axisTicks、monotone 折线生长 + 末端点、
内联 GeoJSON（不对称"F"形带洞 + 线 + 点）的墨卡托与旋转正射球面 + 大圆航线、力导向布局展开（40 节点，按迭代步插值）。

- `node tests/fixtures/_test-dataviz/tests/unit.mjs` → `chart 单测全部通过（95 条）`。关键数字：
  - 8 种比例尺 × 51 点 invert(s(x)) 最大相对误差 8.13e-14；clamp 两个方向截断。
  - ticks：[0,1]×5 = 0,0.2,…,1 精确（无 0.30000000000000004）；300 个随机域步长都是 {1,2,5}×10^k、刻度都在域内；时间刻度年（每 5 年 1 月 1 日）/季度/3 小时/日、utcOffset=480 的日刻度落在当地零点；nice 线性、log、时间。
  - band 几何（step 25 / bandwidth 20 / 首 2.5 / 末 77.5）、小数下标、反向 range；格式 千分位/万位分组/SI 进位（999950→'1.0M'）/万亿（9999.6→'1万'）/百分比/'-0.00'。
  - stack 四种 offset 求和与相接；pie 覆盖整圈与 pad；bin 总数守恒且 =hi 进最后一箱；monotone 单调输入 32 点/段回退 0 次、不越最大值。
  - barRace（smoothstep、duration 0.8、30 fps）：相邻两帧位置差最大 0.0624 名次（理论上界 1.5/(0.8·30)=0.0625）；pos 之和逐帧恒定（误差 < 1e-9）；
    交换中点两条 pos 相等；二分出的交换时刻与解析解差 < 1e-3 s；Top-N 截断处 alpha 逐帧变化同一上界。
  - axisTicks 域 [0,100]→[0,1000] 600 帧：相邻帧 alpha 最大变化 0.0804、位置 3.22 px、任何时刻 ≥ 2 个全不透明刻度。
  - 地理：mercator (0,0)→translate、45°N 与公式一致、北在上东在右；orthographic rotate [−100,−30] 把 (100E,30N) 放到中心、对跖点 null、invert 往返 1e-9；
    跨地平线方块裁剪后最大半径 = R；albers 1°格面积比/球面比 = 1 ± 2e-3；mercator 60°N 格子投影面积是赤道 2.03 倍（球面 0.49 倍）；fit 撑满矩形居中；北京—伦敦 8142 km、中点 62.5°N。
  - forceLayout 同种子两次逐位相同、换种子不同、record/at 插值、fx/fy 钉住；60 节点树 300 步末步平均位移 < 0.05。
- **跨引擎发现**：第一版用 Math.sin/cos/atan2/log/exp/`**`，Node 与 Chromium 比对不过（力导向 300 步后差 1e-13，球面裁剪点差 1 ULP）。
  逐函数扫 4000 个输入，Node 22.23.4 与 Chromium 156.0.8078.4 不一致的比例：sin 118、cos 99、tan 143、atan 362、asin 161、atan2 549、log 320、exp 414、pow 426、`10**整数` 119、log10 692；sqrt、hypot 0。
  改为 chart.js 内的 `dmath`（只用四则与 sqrt，系数照 fdlibm；整数次幂 10^k 用 `Number('1e'+k)`）后：对照 Node Math 最大 ULP 差 sin 1、cos 1、tan 2、atan 1、asin 2、atan2 1、log 1、exp 1、pow 5、log10 3；
  dmath 40000 个值、以及力导向/球面裁剪/交换名次/时间刻度/单调曲线 363 个数在 Node 与 Chromium **逐位相同**。
- `node skills/film-core/scripts/seamcheck.mjs --film _test-dataviz --films-dir tests/fixtures`：门 1a/1b/2 各 8 个时刻逐像素一致，探针无，**全部通过**（门 3 不判：非循环）。
- `node skills/film-critique/scripts/stills.mjs --film _test-dataviz --films-dir tests/fixtures --at 0,1.6,3.333,5.333,8 --cols 2 --tile 960`，Read 打开逐张看：
  1.6 s（B 超 A，解析解 70+15t = 90+2.5t → t=1.6）两条在 pos 0.5 完全重合；3.333 s F 与 C 在 pos≈3.5 重合、alpha 0.5，正越过 Top-4 截断；5.333 s D 与 B 在 0.5 重合、F 在 2、E 在 3、A 已淡出（与 `R.at(5.333)` 数值一致）；
  墨卡托与球面上的 F 都正向（北上东右）、洞按 evenodd 挖空；8 s 球转到 135°E，F 只剩地平线处一条、航线起点段被地平线截断；刻度间距 183.5 px = 50×880/240；单调曲线平台段保持水平。
  第一版夹具没把竞赛格裁剪到本格，出榜的条滑进了地图格（夹具自己的错，补了 clip）。
- 耗时（高负载机器，load average ≈ 21，中位数；Node / Chromium）：forceLayout 300 步 n=50 1.8/2.9 ms、200 27.5/39.7、500 152/230、1000 578/872 ms；
  barRace 20 条 × 30 s 建表 67/46 ms（扫出 1084 次交换），at(t) 8/6 µs；geoShapes 2000 点环 正射含裁剪 1.8/0.6 ms、墨卡托 0.8/0.3 ms；axisTicks 5.4/1.4 µs/次；dmath.sin 10 万次 2.3/2.2 ms（Math.sin 1.6/1.2）。

**没测到**：9x16/1x1 画幅；`--parallel 4` 门 4（chart.js 不做离屏合成，没跑）；axisTicks 对 pow 比例尺的连续性（只测了 linear）；
包住整个可见半球边缘的大多边形（已知会补错方向，写进 dataviz.md §8）；跨日界线环的"画两遍 + 裁剪"只有数值断言、没在夹具里画；
albers 背面经线；collide 碰撞的效果；dmath 在 |x| > 1e6 的三角函数精度（Cody–Waite 约简只覆盖到这个量级）；非 V8 引擎（Firefox/Safari）的逐位一致只是按 IEEE 推断，没跑。
