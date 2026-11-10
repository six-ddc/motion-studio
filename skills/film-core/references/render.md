# render.mjs / seamcheck.mjs / preview.mjs 参数全集

目录：render.mjs 参数 · seamcheck.mjs · preview.mjs · lib/browser.mjs ·
渲染细节（缩小版、并行、截图、逐帧哈希清单、分片缓存、自适应子帧）· 渲染器钉版本

所有脚本都可以在任意 cwd 下调用；影片目录依次取 `--films-dir`、`$FILMS_DIR`、从 cwd 向上找到的 `films/`。
只有一部影片时可以省略 `--film <slug>`（有多部时报错并列出全部，不会自动挑选一部）。
失败时一律向 stderr 写 `✗ 原因` 并以非 0 退出。命令行参数优先于 film.json 里的配置。

## render.mjs

| 参数 | 默认 | 说明 |
|---|---|---|
| `--film <slug>` | 唯一的那部 | 影片 |
| `--format <key>` | film.json `format` | `9x16` / `1x1` / `16x9` |
| `--all` | — | 依次渲染 film.json `formats` 里的每个画幅 |
| `--fps <n>` | film.json `fps` | 输出帧率 |
| `--sub <n>` | film.json `sub` | 运动模糊的子帧数，1 表示关闭 |
| `--shutter <0-1>` | film.json `shutter` | 子帧覆盖帧间隔的比例；1 相当于 360°，0.5 相当于 180° |
| `--crf <n>` | film.json `crf` | x264 质量参数，值越小画质越好、文件越大 |
| `--preset <p>` | `slow` | x264 preset；迭代时用 `veryfast` |
| `--from <s>` / `--to <s>` | 0 / DURATION | 只渲染这个区间 |
| `--dur <s>` | — | 等价于 `--to from+dur` |
| `--out <file>` | 见下文 | 覆盖输出路径。**相对路径解析到 `films/<slug>/out/` 下，不是 cwd**（开头的 `out/` 会被去掉，`partial.mp4` 与 `out/partial.mp4` 等价）；绝对路径原样使用；父目录自动创建；扩展名必须是 `.mp4` |
| `--entry <x.html>` | film.json `entry` | 临时更换入口页（测试变体、调试单个镜头） |
| `--workers <n>` | CPU 核数/2，上限 16 | 并行页面数；1 表示串行 |
| `--pages-per-browser <p>` | 2 | 每个浏览器进程开几个页面；浏览器数 = ceil(workers/p) |
| `--chunk-seconds <s>` | 1 | 分片长度；分片边界在绝对帧号 round(s·fps) 的整数倍上（与 workers、--from 无关，这样缓存才能命中） |
| `--x264-threads <n>` | 4 | x264 线程数，**固定不变，不随核数变化**（线程数不同，输出的像素也不同）；会写入缓存键和 film.json `renderer` |
| `--no-cache` | — | 不复用分片缓存，全部重新编码（仍会写入缓存） |
| `--clean-cache` | — | 先删除当前画幅的分片缓存 |
| `--capture cdp\|locator` | `cdp` | 截图方式；locator 是 Playwright 的原实现，保留用于对照 |
| `--pin-renderer` | — | 渲染成功后把当前浏览器指纹写进 film.json `renderer`（覆盖旧记录） |
| `--scale <s>` | 1 | 生成迭代用的缩小版：截图时由 CDP 降采样（页面仍按全分辨率光栅化）。缩放后的宽高都必须是偶数整数（0.5/0.25/0.75）；只支持 `--capture cdp`。scale 会写入缓存键；产物和清单单独存放（见下文）；`--out` 不能命名为 `silent-*`/`final-*` |
| `--films-dir <dir>` | `$FILMS_DIR`，否则从 cwd 向上找 `films/` | 影片根目录 |
| `--variant <id>` | — | 按片子根目录的 `content.json` 渲染一个变体（如 `hook-b.cta-a`；`base` 表示基础内容），输出 `out/variants/<id>/silent-<fmt>.mp4`；如果主片的成片音轨存在，再输出 `final-<fmt>.mp4`；结果记进 `out/variants/manifest.json`（`content-json.md` §5） |
| `--matrix` | — | 把 `content.json` matrix 的全部组合在每个画幅下各渲染一遍（加 `--format` 时只渲染其中一个画幅）；不能与 `--variant`、`--out` 同时使用 |

环境变量 `FILM_CHROMIUM=<Chromium 可执行文件>` 会让 render、seamcheck 以及所有经 `launchBrowser()` 启动浏览器的工具
（film-critique 的 stills/check）改用这个浏览器构建。**它供验证使用，不是日常开关**，用途是在一台机器上实测更换构建的后果。
不设置时保持原行为。路径不存在、是 `.app` 目录或没有执行权限时直接报错（`.app` 会在提示里给出里面的二进制路径）。
只想换版本、不想换形态时，指向 `chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell`
（Playwright 默认就使用 headless shell）；指向 `chromium-<rev>/…/Google Chrome for Testing` 会同时换成完整 Chrome，
指纹记为 `<版本> (full Chrome)`。实测数据见仓库 docs/verified/film-motion.md §11。

产出：`out/silent-<format>.mp4`；渲染区间时为 `out/silent-<format>-<from>-<to>.mp4`。
使用 `--scale` 时产出 `out/draft/draft-<format>-<s>x[-<from>-<to>].mp4`，日志带有 `⚠ 迭代产物` 和 `✓ [迭代 0.5x]`；
逐帧清单为 `out/.render/<format>@<s>x.frames.json`（不覆盖定稿的基线）。ffprobe 同时核对帧数和宽高，宽高不符即判为失败。
注意，每个画幅（每个 scale）的清单只保留**最后一次**渲染的结果：渲染过一次 `--from/--to` 区间后，整片的基线就被区间清单替换了，
下一次整片渲染不会打印"与上次相比"，门 5 也对不上账。再完整渲染一次整片即可恢复。
编码参数固定为 H.264 / yuv420p / `+faststart` / `-threads`，没有音轨（合流见 film-narration）。
渲完后用 ffprobe 数帧，帧数不等于 `round((to-from)·fps)` 即判为失败。

帧时刻：输出帧 k 的子帧 j 位于 `from + (k + shutter·j/sub)/fps`。sub=1 时就是 `from + k/fps`。

中止条件：`--out` 不是 .mp4 或父目录无法创建（会报出完整路径）、场景加载报错、15 秒内没有出现 `window.seek`、找不到 `stage` 元素、有动画但没声明
`USES_WAAPI`、`DURATION` 无效、渲染过程中出现页面错误、ffmpeg 返回非 0、帧数不符。

`--from/--to` 会对齐到帧栅格（第 K 帧位于 K/fps）。
中间产物包括：`out/.render/cache/<format>/` 下的分片缓存（`<pkey>-<a>-<b>.mp4` 加 `index.json`，保留不删除）；`out/.render/<format>.frames.json` 逐帧哈希清单
（只有 `key`，即 entry/fps/sub/shutter/from/frames 都相同时，才与上次对比；另外记录 `renderer`、`inputs`（输入指纹，运行时按实际加载的那份计算）和
`runtime`（这次渲染实际加载的运行时 `[{name, from, sha256}]`，deliver 按它冻结））；
以及 `out/.render/runtime.json`（serve 每次会话的加载记录，accept/deliver 按它触发 gates.json 中的 uses 门）。
哈希针对的是**截图 PNG 的字节**，不是解码后的像素。在同一个浏览器构建下二者等价；换了构建，PNG 编码器可能会变
（实测从 143 换到 151/156，解码后的像素完全相同，PNG 字节全部改变），这时报告会附注"不等于像素变了"，缓存也会整体重新编码（偏保守的处理）。

区间重渲后的拼接：各段 fps 和编码参数相同时，可以用 `ffmpeg -f concat -safe 0 -i list.txt -c copy`，
但 H.264 的段界不在关键帧上时会出问题，稳妥的做法是拼接时重新编码。

## seamcheck.mjs

| 参数 | 默认 | 说明 |
|---|---|---|
| `--film` `--entry` `--films-dir` | 同上 | |
| `--format <key>` | film.json `format` | 每个画幅各跑一次 |
| `--fps <n>` | film.json `fps` | 决定采样时刻对齐到哪个帧栅格 |
| `--samples <n>` | 8（最少 4） | 采样时刻数，均匀分布并包含首尾 |
| `--loop` / `--no-loop` | film.json `loop` | 是否判定门 3 |
| `--probe-warn` | — | 把探针命中降级为警告 |
| `--parallel <n>` | 0（不判） | 门 4：全片用 1 个页面顺序截图，再用 n 个页面并发交错截图，逐帧比较 md5 |
| `--relaunch <n>` | 0（不判） | 门 5：按 render 的拓扑（多个浏览器、每个浏览器多个页面、1 秒分片）全新启动浏览器 n 遍（n ≥ 2），逐帧比较 md5；再和上一次 render 的逐帧清单对账（fps/sub/shutter/整片/浏览器构建一致时）。不一致的帧会把两边的 PNG 存进 `out/.render/relaunch/`，并报告差异幅度 |
| `--scale <s>` | 1 | 只用于门 5：截图时降采样以节省时间（ghost-jam 708 帧跑一遍从 28.7s 降到 13.5s）。会漏掉 ≤2×2 像素、≤3/255 的局部差异；对账时比较 `<format>@<s>x.frames.json` |
| `--every <k>` | 1 | 只用于门 5：每 k 帧取 1 帧 |
| `--sub <n>` | film.json `sub` | 只用于门 5：每帧截几个子帧（要和 render 的 sub 一致才能对上账） |
| `--workers <n>` / `--pages-per-browser <p>` | 同 render | 只用于门 5 |

各道门的做法：

| 门 | 做法 | 抓什么 |
|---|---|---|
| 1a 同 t 可重复 | 在同一个页面对同一个 t 求值两次 | seek 里读取时钟或 `Math.random`、每次调用都累积状态 |
| 1b 重新加载 | 在全新页面上求同一批 t | **加载时**的 `Math.random`/时钟、没等加载完的字体和图片。1a 和 2 都发现不了这类问题 |
| 2 乱序求值 | 用种子打乱顺序后再扫一遍 | 跨帧状态 |
| 3 循环接缝 | `frame(D) ≡ frame(0)`，并且跨接缝的跳变不超过相邻帧典型差异的 4 倍 | 首尾不一致；首尾相等但速度不连续 |
| 4 并行（`--parallel N`） | 全片逐帧比较：先顺序截一遍，再用 N 个页面并发倒序交错截一遍，比较 md5。顺序那一遍分给 N 个页面各截一段，每段开始前先不截图地顺序 seek 0…a−1，使每帧之前的求值历史与单个页面从头截到尾时相同 | 并行渲染下会出错的场景（包括"页面求值过足够多帧后才出现"的泄漏，只重叠一小段是发现不了的）；成本是 2 倍全片帧数的截图，外加补齐求值历史的 seek |
| 5 跨启动（`--relaunch N`） | 按 render 的拓扑全新启动浏览器逐帧截图，与**上一次 render 的逐帧清单**对账。fps/sub/shutter/PNG 模式/自适应参数**以清单为准**；清单本身算作一次独立启动，所以只新跑 N−1 遍。对不上时再补跑一遍用于分诊，区分是跨启动不一致、那次渲染本身坏了，还是输入改过导致成片过期（后两种要靠清单的 `inputs` 区分，老清单没有这个字段时会说明分不清）。没有清单，或设置对不上（时长变了、区间渲染、换了浏览器构建）时，退回到新跑 N 遍，只验证跨启动的一致性 | 门 1–4 都在同一个浏览器进程里运行，看不到跨启动的差异；"那一次渲染本身坏了"只有对账能发现。它不是默认门，在定稿前跑；`--scale 0.5` 能降低成本，但会漏掉 ≤2×2 像素、≤3/255 的局部差异 |
| 探针 | 统计 seek 期间禁用 API 的调用次数 | 直接报出是哪个 API |

退出码：0 表示全部通过；1 表示有门没过或页面报错。
耗时：一段 2s、1080×1920 的测试片约需 3.7s 墙钟时间（8 个时刻，每个约 5 次截图）。

## preview.mjs

参数为 `--film` `--format` `--port`（默认 4321）`--entry`。打开 `http://127.0.0.1:<port>/__preview.html` 即可预览。
播放器在 iframe 外用 rAF 调用 seek；拖动条的步长为 1/fps。

## lib/browser.mjs（给其他 skill 复用；全部导出见 api.md）

```js
import { openScene, makeComparer, launchBrowser } from '<film-core>/lib/browser.mjs';
import { resolveFilm, parseArgs } from '<film-core>/lib/film.mjs';
const F = resolveFilm(slug, parseArgs());
const S = await openScene(F, '9x16', {          // { shot(t) -> PNG Buffer, page, info, errors, close }
  initScripts: [() => { /* 在场景任何脚本之前执行：包 prototype 的探针放这里 */ }],  // 函数 / { path } / { content }
});
const png = await S.shot(1.25);                 // 已处理 USES_WAAPI
await S.close();
```

## 渲染细节

### `--scale`：迭代用缩小版

页面照常按全分辨率布局和光栅化，只在截图时由 CDP 缩小，所以缩小版就是定稿帧的降采样，不是另一套渲染结果。
这里不改 deviceScaleFactor，因为改它会换一条光栅路径，迭代时看到的就不是定稿会出来的画面。
速度约快 2.3 倍（瓶颈在全尺寸 PNG 编码，不在光栅化）。
产物放在 `out/draft/draft-<format>-<scale>x.mp4`，不以 `silent-*` 命名：mux.sh、contact.sh、align.py 按名字挑选成片，不会选中它；
`--out` 命名为 `silent-*`/`final-*` 时直接报错。scale 会写入分片缓存键，逐帧清单也单独存一份（`<format>@0.5x.frames.json`），
不会和定稿的分片或基线混在一起。代价是细节被平均掉：1 像素宽的细线、小字号在缩小版里看不准，判断可读性和字号要用 film-critique
的全分辨率工具。边缘锐度同理：缩小版加 `--preset veryfast` 放大到手机上读作「整体发糊」，分不清是缩小、编码还是场景（锯齿、后期）的问题（本仓库样例 xa-agent 的 0.5x 小样被评「边缘不清晰」）；缩小版只看构图、节奏和运镜，清晰度看 `stills.mjs` 全分辨率静帧或定稿。比例必须让宽高都是偶数整数（0.5 / 0.25 / 0.75），不会悄悄取整。

### 并行

`seek(t)` 是纯函数，帧与帧之间没有依赖，所以默认用多个页面并行渲染：时间轴切成分片，每个 worker（页面）
领取一片，各自启动 ffmpeg 编码，最后用 `concat -c copy` 拼接（如果只并行截图、不并行编码，x264 会成为新的瓶颈）。
要用多个浏览器才能扩展上去（同一浏览器内的页面共享光栅进程）；不同拓扑下截图哈希逐帧相同。
代价：内存随 worker 数线性增长；场景加载开销大（大纹理、长旁白解码）时，每个 worker 都要付一次；
**并行的前提是 seamcheck 门 1b 和门 4 通过**，带跨帧状态的场景并行渲出来，每一片都不一样。
分片数不同的 mp4 解码后不会逐字节相同（GOP 边界不同，实测 PSNR 55 dB），这是编码层的差异，像素层面以哈希清单为准。

### 截图

默认使用 CDP 截图（`--capture cdp`），比 Playwright `locator.screenshot` 快约 2 倍，并且逐像素一致。`--capture locator` 保留用于对照（使用它时，SKILL.md §1 提到的 WAAPI 问题依然存在）。每帧 seek 之后都会等待 `document.fonts.ready`。
PNG 默认使用快速编码（`--png fast`，即 CDP 的 `optimizeForSpeed`，对应 `openScene` 的 `png` 选项）：速度约快 4 倍，解码后与 `default` 逐像素相同；
同一画面多次截图、跨页面、跨启动时**字节**也相同，所以字节 md5 仍可当作像素指纹；代价是 PNG 体积约大 1.4 倍。
两种模式的字节不同，所以和**以前存下的哈希**对账时，要按记录的模式截图：清单的 `key.png` 和分片缓存键只在 fast 模式下才带这个字段
（没有这个字段即为 default，老清单、老缓存键保持不变，也不会被 fast 模式误复用）。

### 逐帧哈希清单与改动泄漏报告

每个输出帧的子帧 PNG md5 写进 `out/.render/<format>.frames.json`（另外记录 `key.png` 和 `inputs` 输入指纹，指纹覆盖 out/ 以外的全部文件，film.json 去掉 renderer 后计算；门 5 会用到）。
用同样的设置再次渲染时，会打印哪些时间段的像素变了（如 `206 帧像素变了 → 6.83–13.70s`）。
它最大的用处是**反查改动的影响范围**，省时间倒在其次：例如只想改第 3 镜，结果第 7 镜也变了，一眼就能看出来。

### 分片缓存：只重编改动的分片

开销大的是编码（x264 slow 在满屏噪声下每个进程约 8 fps），截图并不贵。
所以每次照常全量截图、逐帧计算哈希。分片缓存放在 `out/.render/cache/<format>/`，缓存键由编码参数和绝对帧区间组成。编码参数包括画幅、fps、sub、shutter、
crf、preset、ffmpeg 版本、x264 线程数、**挂载运行时的哈希**（第一个页面加载完时 serve 记录的名字和 sha256；运行时改动一个字节，全部分片都会重编），以及只在非默认时才出现的 scale、自适应参数、PNG 快速编码。截一个分片时，边截图边和缓存里的哈希比较：全部对上时直接复用缓存的分片 mp4，
不交给 ffmpeg；某一帧对不上时，从分片开头重新截图（seek 是纯函数，重截得到的就是原帧，同时顺便核对哈希），再进行编码。
不需要缓冲 PNG，最坏情况是多截一个分片。分片边界在绝对帧号 N 的整数倍上（由 `--chunk-seconds` 决定，默认 1s），
与 worker 数和 `--from` 无关，所以区间渲染也能复用整片渲染留下的分片。
混合拼接出的成片与 `--no-cache` 全量重编的成片**解码后逐帧相同**（x264 对相同输入的输出是确定的）。
**前提是线程数相同**：线程数不同，输出连解码后的像素都不同。所以 `-threads` 固定为一个值
（`--x264-threads`，默认 4，与机器核数无关），并写入缓存键：换了这个值，旧分片自动失效并重编，不会混进成片。
固定线程数之后，成片 mp4 与 worker 数无关，逐字节相同（4 个 worker 与 1 个 worker 的 md5 一致）。
代价：
- 缓存占用磁盘（每种编码参数组合在每个分片位置各存一份，不会自动清理；`--clean-cache` 清除当前画幅的缓存）。
- 在重编的那一片里，像素没变的帧解码结果也会和旧版本略有不同，因为 x264 的码率控制看到了后面变化的内容。
  这与全量重编的结果一致，并不是接缝。
- 分片短时，区间渲染能用的 worker 少（1s 的区间只有 1 片，也就只有 1 个 worker）；分片长时，改一帧要重编的内容更多。
  `--no-cache` 强制全量重编（仍会刷新缓存）。
- 对有 `content.json` 的片子，同一个分片位置可以并存几份内容（主份 `<pkey>-<a>-<b>.mp4`，加最多 6 份备份 `…~<哈希>.mp4`，记录在 `index.json` 的 `alts` 里），
  逐帧比较时任意一份全部对上就复用。这样变体之间像素相同的分片只编码一次，来回切换变体也不会互相覆盖。没有 content.json 的片子只有主份，行为与之前相同。

### 自适应子帧（`window.MOTION`）

`MOTION(t0, t1)` 返回这段时间内画面上任意一点的最大位移（单位为像素，≥0；用场景自己的纯函数细分求路径长度，不读取截图）。
提供了它且 `sub>1` 时，每帧按大约每 6px 一张的密度取 4–48 张子帧（参数为 `--motion-px` `--sub-min` `--sub-max`，`--no-adaptive` 关闭）；
返回 0 时只截快门两端，两端逐字节相同就只用一张，不同则退回 4 张并发出警告。`window.CUTS = [硬切时刻…]` 让跨越硬切点的快门只截到切点为止（帧起点那一侧）。
子帧平均在 Node 里完成（`lib/pngmix.mjs`）；没提供 MOTION 的片子与以前逐字节相同。
适合使用的情况：位移远大于物体尺寸的快动作，或者大段静止又想开运动模糊的片子。MOTION 估得偏低时残影会回来（只有返回 0 的帧有两端比对兜底），估得偏高只是多截几张；
快动作集中在一个分片里时，配合 `--chunk-seconds 0.25` 使用。"两端相同就跳过"只对声明 MOTION=0 的帧生效，因为两端相同推不出中间也相同（往返运动、闪烁、转一整圈）。
tmix 在 sRGB（gamma）空间做平均，亮暗交界处的拖影会略微偏暗。要得到物理正确的拖影，需要在场景内的线性空间累积（渲染器侧的线性光平均还是待办事项，将来接在 `pngmix.mjs` 上）。

## 渲染器钉版本

**记录与告警**：首次渲染成功后，把 `{chromium, playwright, args, ffmpeg, x264Threads}` 写进 `film.json renderer`（旧记录缺字段时只补缺失的字段）；
之后任何一项不一致都会发出警告。`--pin-renderer` 主动把记录改为当前环境（应在新环境下重新检查过静帧之后再做）。
`FILM_CHROMIUM=<可执行文件>` 用来更换浏览器构建。它是供验证用的入口，不是日常开关（理由见 `lib/browser.mjs`）。
启动参数固定为 `--font-render-hinting=none`：**在 macOS 上实测没有差别**（CoreText 不做 hinting，none/full/medium 三档的哈希相同），
它防的是换到 Linux（FreeType）上渲染的情况，而 Linux 和真实 GPU 恰好都还没有测过。
要真正固定版本，还需要项目的 `package.json` 写明确切的 playwright 版本（不带 `^`）。那是项目自己负责的事，本 skill 只负责发现不一致。

像素由两层外部版本决定：浏览器（版本号**和**构建形态）与编码器（ffmpeg/x264 的版本与线程数）。实测结论如下（数字见仓库 docs/verified/film-core.md）：
- 换浏览器**版本**时，画面通常会发生肉眼看不出的变化，但 PNG 字节会变，于是哈希全部改变、分片缓存整体重编。固定版本是为了缓存命中和可复现，与视觉保真无关。
- headless shell 和完整 Chrome 之间唯一看得出的差异，来自**字体没有随片打包**时的系统字体回退（4–14% 的像素）；打包字体后，差异降到亚像素级。
  根本的解决办法是打包字体，渲染前用 `font_source.mjs --film <slug>` 检查；`browser.version()` 区分不出两种形态，所以指纹里把完整 Chrome 记为 `… (full Chrome)`。
