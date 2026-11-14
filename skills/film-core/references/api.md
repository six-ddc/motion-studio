# film-core 对外契约（能力 skill 依赖的全部接口）

能力 skill（film-motion、film-webfx、film-physics、film-typography、film-narration、film-assets、film-story、film-critique……）
**只许 import film-core**。本文件列出它们能依赖的全部接口；没写在这里的导出随时可能变动。

目录：0 依赖规则 · 1 lib 导出 · 2 capability · 3 服务器、挂载表与加载记录 · 4 gates.json · 5 film.json checks ·
6 receipt.json · 6b 合流记录与成片新鲜度 · 7 配方 recipe.json · 8 脚本命令行 · 9 Python：film.py

---

## 0. 依赖规则

- Node 侧用 `import { … } from '../../film-core/lib/<模块>.mjs'` 引入（各 skill 装在同一层目录，相对路径关系不变）。运行时用 `import './runtime/<名>.js'`。
- 跨能力调用（A skill 要用 B skill 的模块或文件）**一律**通过 `capability('film-b')`。B 没装时抛出 `MissingCapability`，脚本经 `main()` 打印
  「缺能力 film-b：…」并 exit 1。不要写指向别的 skill 目录的相对路径。验收方法：`rg -P "\.\./\.\./film-(?!core)" skills` 的结果必须为空。
- 起服务器只用 `serve()`，起浏览器只用 `launchBrowser()`。验收方法：`rg -l "create[S]erver|chromium[.]launch" skills` 只命中 `film-core/lib/`（写成字符类，是为了让这条命令不会匹配到写着它自己的这一行）。
- 运行时里需要随机数时，用 `import { seeded, hash01 } from './rand.js'`（`motion.js` 也转导出了这两个）。另写一份 `hash01` 的代价是两处签名会逐渐不一致（重构前就出现过三份签名各不相同的实现），所以整个套件只保留 `rand.js` 这一份。

## 1. lib 导出

### `lib/env.mjs`：环境定位与能力

| 导出 | 签名 | 说明 |
|---|---|---|
| `locateFilmsDir` | `(given=null, {fallback=null}) → string\|null` | 返回 films/ 的位置，依次取 `--films-dir`、`$FILMS_DIR`、从 cwd 往上找到的目录；`fallback:'cwd'` 时退回 `<cwd>/films` |
| `findFilmsUp` | `(start=cwd) → string\|null` | 只做"往上查找"这一步 |
| `noFilmsDirMessage` | `() → string` | 统一的报错文案 |
| `resolvePkg` / `importPkg` / `requirePkg` | `(spec) → path\|null` / `async (spec) → module\|null` / `async (spec, hint) → module`（找不到 exit 1） | 解析 node_modules 依赖（先按 cwd 解析，再按脚本所在位置解析） |
| `playwright` / `playwrightVersion` | `async () → module` / `() → string\|null` | 只给 browser.mjs 用；其他地方起浏览器用 `launchBrowser()` |
| `findVenvBin` | `(name, {filmsDir}) → path\|null` | 查找 `.venv/bin/<name>`：先从 cwd 往上找，再从 films 的父目录往上找，最后查 `$VIRTUAL_ENV` |
| `CORE_DIR` / `SKILLS_ROOT` | `string` | 分别是 film-core 目录和安装 skill 的那一层目录 |
| `installedSkills` | `() → [{name, dir}]` | 只有 `SKILLS_ROOT/film-*/SKILL.md` 存在的才算已安装 |
| `capability` | `(name) → {name, dir, path(rel), import: async (rel) → module}` | 见第 2 节；没装时抛出 `MissingCapability` |
| `hasCapability` | `(name) → boolean` | 不抛错的探测 |
| `MissingCapability` | `class extends Error`，`code='MISSING_CAPABILITY'`，`skill` | 消息以「缺能力 film-X」开头 |

### `lib/cli.mjs`：命令行守卫

| 导出 | 签名 | 说明 |
|---|---|---|
| `cli` | `(spec, argv=process.argv.slice(2)) → {positionals}` | 遇到 `--help`/`-h` 时打印帮助并 exit 0；未知参数、缺值、多余的位置参数、`--k=v` 写法都 exit 2。spec 的格式：`{usage, about, opts:{名: '开关说明' \| ['<元变量>', '说明']}, positional?, positionalHelp?, maxPositional?, notes?}` |
| `FILM_OPTS` | `{film, 'films-dir'}` | 合并进 opts 的两个标准选项 |

### `lib/film.mjs`：找片、film.json、checks、参数

| 导出 | 签名 | 说明 |
|---|---|---|
| `parseArgs` | `(spec, argv?) → {argv, flag(n,d), num(n,d), all(n), has(n), film}` | 先用 `cli(spec)` 校验，再返回取值器（必须提供参数表）。`flag` 取第一个值；可重复的参数（`--text a --text b`）用 `all(n)` 取，得到 `['a','b']` |
| `readArgs` | `(argv?) → 同上` | 不做校验的取值器（入口已经校验过时使用） |
| `resolveFilm` | `(slugOrDir, args) → {slug, dir, films, config, raw, out, entryUrl, formats}` | 参数可以是 slug，也可以是含 film.json 的片子目录路径（与 Python 的 `resolve_film` 相同）；没给且只有一部片时自动选中它；`config` 是 DEFAULTS 与 film.json 合并后的结果，并校验内核字段；`films` 是片子所在的目录；**不创建任何目录**（`out` 只是路径，需要写文件的脚本自己 mkdir）；出错时抛出 Error |
| `filmsDir` / `listFilms` | `(args) → string` / `(dir) → [slug]` | |
| `DEFAULTS` / `validateConfig` | 见 `film-json.md` | 内核字段的默认值与校验（不校验 checks） |
| `parseChecks` | `(raw) → Map<id, true\|参数对象>` | 格式见第 5 节；写错时抛出 Error |
| `readChecks` | `(filmDir) → Map` | 读取 film.json 后调用 parseChecks |
| `checkParam` | `(filmDir, id) → false\|true\|参数对象` | 检查脚本用它读取自己的开关和阈值 |
| `CHECK_ID` | `RegExp` | id 的命名规则 |
| `fail` | `(msg, code=1) → never` | 向 stderr 输出 `✗ msg` 后退出 |
| `main` | `async (fn)` | 顶层包装：遇到异常（含 MissingCapability）时输出到 stderr 并 exit 1 |

### `lib/serve.mjs`：唯一的服务器（第 3 节）

| 导出 | 签名 | 说明 |
|---|---|---|
| `serve` | `(root, {port=0, routes={}, mounts={}, runtime='auto', record=true}) → Promise<{server, port, url, close(), loaded(), suite()}>` | root 下有 film.json 时自动挂载运行时并写加载记录。`routes` 是内存中的页面（值为字符串，或每次请求现算的 `() → 字符串`）；`mounts` 用 `{'/前缀/': 绝对目录}` 添加额外挂载；`loaded()` 返回 `[{name, from, sha256, bytes, path}]` |
| `suiteRuntimeIndex` | `() → Map<名, {skill, path}>` | 套件运行时的扁平索引；有重名时抛错 |
| `runtimeRecordPath` / `readRuntimeRecord` | `(filmDir) → path` / `(filmDir) → record\|null` | 记录文件位于 `out/.render/runtime.json` |
| `runtimeDigest` | `(loaded) → sha256 hex` | 由名字和 sha256 算出的摘要（用作分片缓存键） |

### `lib/browser.mjs`：唯一的浏览器

| 导出 | 签名 | 说明 |
|---|---|---|
| `launchBrowser` | `async ({backend='swiftshader', extraArgs=[]}={}) → Browser` | 启动参数固定为 `LAUNCH_ARGS` + `BACKENDS[backend]`；遵循 `FILM_CHROMIUM` 环境变量。打开某支片子的工具传 `backend: filmBackend(F)`；`backend:'gpu'` 起不来硬件 WebGL 时抛错（`code: 'BACKEND_UNAVAILABLE'`），不退回软件。`extraArgs` 只给 dev/ 下的基准脚本用，**门和渲染都不能传** |
| `openScene` | `async (film, format, {browser?, port?, probe=false, initScripts=[], capture='cdp', scale=1, png='fast', record=true, query={}, fps=film.json fps}) → {page, context, shot(t)→PNG, advance(t), info:{duration, usesWaapi, …}, errors, probeCalls(), close(), film, width, height, outWidth, outHeight}` | 打开场景，等待 ready 和字体就绪，处理 USES_WAAPI。页面脚本之前注入只读 `window.FILM = {fps, width, height, format}`（`fps` 取这个参数：按别的帧率截帧的调用方必须传，返回值 `film` 是注入的那份）。传入的 browser 后端与本片 film.json `backend` 不符时不用它，自起一个对的（stderr 提示一次）。不传 port 时自带一个 serve（`record:false` 时不写加载记录，用于只读地查看别的片子）；`initScripts` 在场景脚本之前注入（探针放在这里）；`query` 是额外的 URL 参数（如 `{variant}`） |
| `filmGlobals` / `filmGlobalsScript` | `(film, format, fps=film.json fps, scale=1) → 冻结的 {fps, width, height, format, scale}` / `(g) → JS 字符串` | 自己开页面（不经 openScene）的工具用它们注入同一份 `window.FILM`（fontsrc、preflight 用 `addInitScript({content})`，preview 改写入口页） |
| `makeComparer` | `async (browser) → {compare(pngA, pngB) → {diff, max, total, identical}, close()}` | 逐像素比较 |
| `rendererFingerprint` | `async (browser) → {chromium, playwright, args}`（gpu 后端另加 `backend, gpu, gpuDriver`） | 记录进 film.json 的 renderer 字段和收据 |
| `filmBackend` / `browserBackend` / `backendMismatch` | `(F) → 'swiftshader'\|'gpu'` / `(browser) → 同上` / `(记录a, 记录b) → 原因\|null` | 本片声明的后端；某个浏览器由哪个后端起；两份渲染器记录（后端、显卡、驱动）可不可比 |
| `LAUNCH_ARGS` `BACKENDS` `DEFAULT_BACKEND` `CHROMIUM_ENV` `chromiumOverride` `PNG_MODES` `pngModeOf` `scaledSize` `FORMATS` | | `FORMATS` 就是 `runtime/layout.js` 里的画幅表 |

### `lib/frames.mjs` · `lib/pngmix.mjs` · `lib/fontcss.mjs`

| 导出 | 签名 | 说明 |
|---|---|---|
| `frameShooter` | `({fps, sub, shutter, adapt?, stats?}) → async (S, K) → {pngs, hash}` | 决定一个输出帧怎么截图、帧哈希怎么计算（render 与门 5 共用） |
| `inputsFingerprint` | `(dir, loaded=null) → md5 hex` | 渲染输入的指纹；运行时按实际加载的那一份计算 |
| `decodePng` / `mixPngs` / `mixPool` | | 子帧平均（用于自适应运动模糊） |
| `parseFontFaceCss` / `parseFontShorthand` / `splitFamilies` / `GENERIC` / `SYSTEM_FONT_RE` | | 字体 CSS 解析与系统字体名表（font_source 与 film-assets 共用） |

### `lib/gates.mjs` · `lib/receipt.mjs`（accept / deliver 用；能力 skill 一般不需要）

`loadGates() → {gates, claims: Map<checkId, gate>, errors}` · `planGates(filmDir, {mode, filmsDir, slug, loaded?}) → [{id, kind, state, why, cmd}]` ·
`runGate([bin,args], {cwd, timeoutMs})` · `manifestOf(dir)` · `finalState(dir, fmt?) → {state: 'none'|'fresh'|'stale', path, why, record}` · `finalOf(dir, fmt?)`（只返回新鲜的成片）· `muxRecordPath` / `readMuxRecord(dir, fmt)` · `loadedRuntimeNames(dir)`；
`receiptInputs(dir)` · `receiptState(dir) → {state: 'none'|'ok'|'changed'|'broken'|'deleted', why, receipt}` · `receiptTracked(dir)` · `readReceipt` · `writeReceipt` · `diffInputs` · `portablePath(p, root)` / `portableCmd([bin,args], root)` · `envFingerprint`。

### 运行时（`assets/runtime/`，场景里 `import './runtime/<名>'`）

| 文件 | 导出 |
|---|---|
| `rand.js` | `seeded(seed) → () → [0,1)`、`hash01(...keys) → [0,1)`、`hashRange(lo, hi, ...keys)`。**全套件唯一的随机实现** |
| `motion.js` | `sat lerp clamp norm win wrap settle spring springInfo zetaForOvershoot follow SPRING pill labelAlpha camera applyCamera beatGrid`、镜头组合子 `sequence series loopT rate freeze`，并转导出 `seeded hash01`。`win(t, start, dur, ease)` 等于 `ease(sat((t-start)/dur))`（ease 是函数，dur ≤ 0 时为阶跃），film-motion 的 `envelope` 与 film-typography 的 `unitProgress` 都建立在它之上。`sequence(list, {start, end, overlap, align, marks}) → {at(t), cuts, boundaries, windows, marks, bounds(name), list, duration}`；`series(durations, start) → {at(t), cuts, end}`；`loopT(t, period, {from, times})`、`rate(t, k, from)`、`freeze(t, at, dur)` 返回局部时间 |
| `layout.js` | `FORMATS makeLayout(key) layoutFromURL(fallback) pick(L, by)` |
| `anchors.js` | `createAnchors(canvas) → A`（`A.ctxRect / A.box / A.get / A.install(draw)`，语义见 runtime.md §6） |
| `events.js` | 事件表 `eventTrack merge channel`，响应核 `flashDecay sqrtFade expDecay gaussPulse oscillate springKick springParams riseHoldFall holdFallFlow holdFrames`，加载期规则 `throttle burstEnds snapToFrames piecewise trauma traumaOf countRing`，声音桥 `toCues toSceneEvents`，`keyOf filmFps`。可选能力，语义见 `events.md`；`snapToFrames`/`holdFrames` 的 fps 缺省读 `globalThis.FILM.fps`，两者都没有抛错。film-physics `feel.js`/`closed.js` 建在它上面 |
| `content.js` | `loadContent() → Promise<C>`（`C.text/slot/asset/color/font/param/strings`、`C.id`），纯函数 `resolveContent validateContent parseVariant variantId expandMatrix stableStringify`。Node 侧的包装在 `lib/content.mjs`（`readContentDoc contentHash muxVariant writeVariantManifest`）。schema 见 content-json.md |

## 2. capability：跨能力懒加载

```js
import { capability } from '../../film-core/lib/env.mjs';
import { main } from '../../film-core/lib/film.mjs';

await main(async () => {
  const T = capability('film-typography');            // 没装 → 抛 MissingCapability → main 打印「缺能力 film-typography：…」exit 1
  const { measure } = await T.import('scripts/_measure.mjs');
  const tpl = T.path('assets/x.json');                // 只拼路径，不查存在
});
```

可选依赖（没装也能跑，只是少一项功能）先用 `hasCapability(name)` 探测，再决定 SKIP 还是调用 capability()。
Python 侧：`film.capability('film-x') → Path`（没装时 die 1）。运行时之间不走 capability：它们都在同一张挂载表里，直接 `import './x.js'` 即可。

## 3. 服务器、挂载表与加载记录

- `/runtime/<rel>` 的解析顺序：先找 `<片子>/runtime/<rel>`（片内文件优先，可以有子目录）；找不到且 `rel` 不含 `/` 时，查套件索引 `<skills>/film-*/assets/runtime/<rel>`。
  **套件运行时采用扁平命名，在全套件内唯一**；两个 skill 提供同名文件时 `serve()` 直接 reject。提供运行时的 skill 只需要把文件放进自己 `assets/runtime/` 的顶层。
- 其余路径依次匹配 `mounts` 前缀和片子目录本身（越出片子目录时返回 403）。支持 Range 请求（206）和 `Cache-Control: no-store`。
- **加载记录** `<片子>/out/.render/runtime.json`（每个服务会话都会覆盖它，内容是本次会话加载过的全部文件）：
  ```json
  { "schema": 1, "at": "2026-10-24T03:35:12Z",
    "files": { "motion.js": { "from": "film-core", "sha256": "…", "bytes": 7988 }, "go/board.js": { "from": "film", "sha256": "…", "bytes": 912 } } }
  ```
  `from` 取 `"film"`（片内文件）或提供该文件的 skill 名。
- **渲染清单** `out/.render/<format>.frames.json` 新增了 `runtime: [{name, from, sha256}]` 字段（内容是这次渲染第一个页面加载完时的清单，加上之后追加的文件），
  `inputs` 按实际加载的运行时计算。分片缓存键包含 `runtimeDigest`，所以运行时改动一个字节，全部分片都会重新编码。
- **Node 侧 import 运行时**（检查脚本或烘焙脚本复用浏览器代码时）：使用 `lib/runtime-node.mjs`。
  `registerRuntimeResolver()` 安装同步解析钩子：运行时之间的相对 import（`./motion.js`）按文件路径找不到时，按文件基名改为指向套件索引里的那一份，与挂载表的语义相同。
  `await importRuntime('narration.js', { film })` 按扁平名字获取：给了 `film`（片子目录或 resolveFilm 的返回值），并且片内 `runtime/` 有同名文件（冻结的副本或片子自己写的）时，
  取片内的那一份，否则取套件的。这与挂载表的语义相同，保证检查脚本读到的和场景在浏览器里加载的是同一份。不给 `film` 时只认套件里的文件。
  需要 Node ≥ 22.15。不要在各 skill 里另写一套本地解析实现。
- **Node 侧加载记录** `<片子>/out/.render/runtime-node.json`：`importRuntime(name, { film })` 之后，本进程为这支片子解析到的运行时（含相对 import 的传递依赖）
  与调用它的脚本（`process.argv[1]`，在 skills 目录下时）的 sha256 合并写入：`{ schema, at, files: {名: {from, sha256}}, scripts: {"{skills}/…": {sha256, at}} }`。
  `readNodeRuntimeRecord(dir)` / `nodeRuntimeRecordPath(dir)` 读它。deliver 把 files 与浏览器加载的一起冻结（同名而 sha 不同 → 红），scripts 记进收据 `node.scripts`。
  这是让 Node 里生成的产物（film-narration 的 out/sfx.wav、烘焙数据）所用的代码进入交付的唯一通道：生成脚本要用 `importRuntime(…, { film })` 加载运行时，不要按路径 import。

## 4. gates.json：每个 skill 登记自己的门

放在 skill 根目录（`skills/film-x/gates.json`）。accept --deep 和 deliver 会读取全部已安装 skill 的 gates.json。

```json
{
  "schema": 1,
  "gates": [
    { "id": "physcheck", "about": "重放缓存：顺序/乱序/倒序逐帧比",
      "when": { "uses": ["replay.js", "baked.js", "chain.js"] },
      "run": ["node", "{skill}/scripts/physcheck.mjs", "--film", "{slug}", "--films-dir", "{films}"], "cost": 2 },

    { "id": "seam4", "about": "离屏层合成：门 4 并行逐帧比（deliver 已永远开门 4，所以不重复）",
      "when": { "uses": ["transitions.js"] },
      "run": ["node", "{core}/scripts/seamcheck.mjs", "--film", "{slug}", "--films-dir", "{films}", "--parallel", "4"],
      "deliver": false, "timeoutPerFrame": 1000 },

    { "id": "critique", "about": "check.mjs：可读性、对比度、法律、分镜断言……",
      "when": { "checks": ["readability", "contrast", "laws", "marks", "claims", "facts.screen", "mp4", "truepeak", "page", "loop"] },
      "run": ["node", "{skill}/scripts/check.mjs", "--film", "{slug}", "--films-dir", "{films}"], "mp4": "optional", "cost": 3 },

    { "id": "verify", "when": { "checks": ["verify"] },
      "run": ["python", "{skill}/scripts/align.py", "--film", "{slug}", "--films-dir", "{films}", "--verify"], "needs": ["final"] }
  ]
}
```

| 字段 | 必需 | 含义 |
|---|---|---|
| `id` | 是 | 门名，格式为 `[a-z][a-z0-9-]*`，**在全套件内唯一**（重复时注册表报错，accept/deliver 拒绝运行）。例外是下文的**共享门** |
| `when` | 是 | 取值有三种：`"always"`（**只有 film-core 能用**，表示内核门）；`{"uses": [运行时文件名…]}`（这支片子实际加载了其中任意一个时才打开）；`{"checks": [check id…]}`（film.json 声明了其中任意一个时才打开；一个 id 只能被一个门认领） |
| `run` | 是 | 命令模板。首项为 `node` 时使用当前的 Node；为 `python` 时使用 `.venv` 里的 python（没有就退回 python3）；其余原样执行。占位符：`{skill}` 是本 skill 目录，`{core}` 是 film-core 目录，`{slug}` 是片子名，`{films}` 是 films/ 目录，`{film}` 是片子目录 |
| `about` | 否 | 一句话说明 |
| `mp4` | 否 | 取 `"optional"` 时，如果有**新鲜**的成片 `out/final-<format>.mp4`，就追加参数 `--mp4 <绝对路径>`；取 `"required"` 时，没有成片就判红。成片存在但已过期（见 6b 节）时，两种取值都判红，不会当作"没有成片"跳过 |
| `needs` | 否 | 前置条件：`scene`（入口页）、`manifest`（整片渲染清单）、`final`（新鲜的成片 mp4；过期的不算，而且会让任何类别的门判红）。不满足时，内核门和 uses 门记为 `–`（不适用），**checks 门记红**（声明了就不能静默跳过） |
| `deliver` | 否 | 设为 `false` 时 deliver 不运行它（交付流程已经覆盖了它的检查，如 seam4） |
| `cost` | 否 | 相对成本，同类门按它排序 |
| `timeoutPerFrame` | 否 | 用于逐帧扫描全片的门：墙钟时间上限 = max(30 分钟, 帧数 × 它 + 10 分钟) |

**共享门**：同一道门可以由几个 skill 共同认领（如门 4：film-motion 的转场与 film-webfx 的着色器层都需要它）。各 skill 分别写一个**同一 id** 的
`uses` 门，要求 `run` / `needs` / `deliver` / `mp4` / `timeoutPerFrame` 逐字相同，且 `run` 不含 `{skill}`；注册表把它们合成一道门（`when.uses` 取并集，
`skills` 列出全部认领方，`about` 拼接起来，`cost` 取最大值），一支片子两边都用到时也只跑一次。不满足这些条件时，仍按 id 重复报错。
另外，`planGates` 会按展开后的命令去重：两道不同 id 的门命令完全相同时，只运行先排到的那道，后一道记为 `–`，原因写「与 X 同一条命令」。

门脚本的约定：exit 0 表示通过，非 0 表示不通过；输出中含 `✗`/`失败`/`FAIL`/`不合格` 的行会被摘进汇总。门脚本自己读取 film.json checks，决定查哪些子项（用 `checkParam(dir, id)`）。

触发顺序：先跑内核门，再跑 uses 门（依据内核门 seam 刚写入的加载记录与渲染清单中 runtime 字段的并集来判定），最后跑 checks 门。

## 5. film.json `checks`：声明才开

```json
"checks": ["shotlist", "divergence", "facts.script", "facts.screen", "readability", { "contrast": { "min": 4.5, "large": 3 } }, "marks"]
```

- **扁平数组**。每一项是 id 字符串；需要参数时写成**单键对象** `{ "id": { 参数… } }`（参数必须是对象）。为空时写 `[]`（只跑内核门）。
- **id 规则**：`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$`，即以小写字母开头，由 `[a-z0-9-]` 组成，最多带一级点号命名空间；同一个 id 只能出现一次。
  id 由某个 skill 的 gates.json `when.checks` 认领；**声明了却没有 skill 认领，视为缺能力，判红**（deliver 拒绝交付，accept --deep 报红）。
- 以下旧写法已不再支持：`checks.critique` 子对象、`_` 前缀的注释键、`true/false` 值；也不再因为"style_guide 里写了法律"就隐式打开 check 门，要检查法律就声明 `laws`。
- 读取方法：Node 用 `checkParam(dir, id)` / `readChecks(dir)`；Python 用 `film.check_param(film, id)` / `film.checks(film)`。

## 6. receipt.json：交付收据（`films/<slug>/receipt.json`，入库）

```json
{
  "schema": 1,
  "slug": "demo-tls",
  "deliveredAt": "2026-10-24T03:37:53.271Z",
  "via": "deliver",
  "inputs": { "algo": "sha256", "digest": "986f…", "files": { "film.json": "d20f…", "runtime/motion.js": "92a8…", "scene.html": "…" } },
  "runtime": { "motion.js": { "from": "film-core", "sha256": "92a8…" } },
  "render": { "format": "9x16", "formats": ["9x16"], "fps": 30, "sub": 4, "shutter": 1, "frames": 326,
              "manifest": "out/.render/9x16.frames.json", "outputs": { "out/silent-9x16.mp4": "<sha256>" } },
  "gates": [ { "id": "render", "kind": "render", "result": "pass", "ms": 2600, "cmd": "node …/render.mjs --film demo-tls …" },
             { "id": "seam", "kind": "kernel", "result": "pass", "ms": 41000, "cmd": "… --parallel 4 --relaunch 2" },
             { "id": "physcheck", "kind": "uses", "result": "na", "why": "没加载 replay.js / baked.js / chain.js" } ],
  "checks": ["shotlist", { "contrast": { "min": 4.5 } }],
  "env": { "chromium": "156.0.8078.4", "playwright": "1.64.1", "args": ["--font-render-hinting=none"], "x264Threads": 4,
           "ffmpeg": "ffmpeg version 8.0 …", "node": "v22.17.0", "platform": "darwin-arm64" }
}
```

| 字段 | 含义 |
|---|---|
| `inputs.files` | 片子目录里 **out/ 以外**全部文件的 sha256（不含 receipt.json 自身；film.json 去掉 `renderer` 字段后再计算；跳过 .DS_Store/__pycache__/node_modules/.git）。在冻结之后计算，所以包含 `runtime/` 里冻结的副本 |
| `inputs.digest` | 按路径排序后，对 `路径\0sha\0…` 计算的 sha256。**accept 只比较这一个值** |
| `runtime` | 渲染时实际加载的运行时；`from` 是冻结前的来源（`film`、skill 名或 `kit:<kit>@<版本>`） |
| `node` | 只有片子有 Node 侧加载记录时才有：`{ runtime: {名: {from, sha256}}, scripts: {"{skills}/…/x.mjs": sha256} }`。runtime 已冻结进片内（所以在 `inputs` 里）；scripts 是生成音效/烘焙的工具脚本（与 render.mjs 同类，不冻结、不进 inputs），交付时它们若在生成之后改过，deliver 打 ⚠ |
| `kits` | 只有 film.json 声明了 kits 时才有：`{<kit>: {version, files: {文件: sha256}}}`，记录冻结的 kit 版本，见 `kits.md` §3 |
| `render` | 定稿渲染的参数与产物 sha256（`via: freeze` 时为 null） |
| `gates` | 每一步的记录：`kind` 取 render / kernel / uses / checks 之一；`result` 取 pass / fail / na 之一；只有全部步骤都不是 fail 时，deliver 才写收据。`cmd` 只作记录，accept 不比对；其中不含本机绝对路径：仓库根（films/ 的父目录）下的路径写成相对路径，装 skill 那一层下的写成 `{skills}/…`，家目录下的写成 `~/…` |
| `checks` | 交付时 film.json checks 的原样副本 |
| `env` | 环境指纹；`backend: "gpu"` 的片子另有 `backend`、`gpu`（WebGL UNMASKED_RENDERER）、`gpuDriver`，这样的收据只在同款显卡、同驱动上可复现像素（accept 只比输入哈希，不受影响） |
| `via` / `note` | 取值为 `deliver`；或者为 `freeze`，表示由 `freeze.mjs --receipt "<理由>"` 补写、不过门的收据，理由记在 `note`，accept 显示「✓收据·免门」 |

accept 的判定方法：有收据时重算 `inputs.digest`，相同显示 ✓，不同显示 ✗（列出修改、新增、删除了哪些文件，并计入退出码）；没有收据但 git 跟踪着它（索引或 HEAD 里有）时显示「✗收据被删」，计入退出码；没有收据也没有入库（或者不是 git 仓库）时显示「未交付」，不计入退出码；`--deep` 会跑全部门。

## 6b. 合流记录与成片新鲜度

成片 `out/final-<format>.mp4` 由合流脚本（film-narration 的 `mux.sh`）把无声成片、旁白、音效和配乐合成出来，render 并不产出它。
定稿重渲之后，它可能还是上一版的。所以**合流脚本写成片时会同时写合流记录** `out/.render/final-<format>.mux.json`：

```json
{ "schema": 1, "at": "2026-10-24T04:37:50Z", "skill": "film-narration", "script": "scripts/mux.sh", "args": ["--lufs", "-16"],
  "narrationOffset": 0.6,
  "inputs": { "video": { "path": "out/silent-9x16.mp4", "sha256": "…" }, "vo": { "path": "out/vo.wav", "sha256": "…" }, "sfx": { "path": "out/sfx.wav", "sha256": "…" } },
  "output": { "path": "out/final-9x16.mp4", "sha256": "…" } }
```

- `finalState` 判定成片新鲜需要同时满足：记录存在、成片的 sha 等于 `output.sha256`、`inputs` 中每一项当前的 sha 与记录相同、film.json 的 `narrationOffset` 与记录相同。
  没有记录的成片（手工合的、其他工具合的）也算过期，因为无法知道它是基于哪次渲染合成的。记录中的路径相对于片子目录；`args` 不含 `--film` / `--films-dir`。
- 门：成片过期时，读取成片的门（有 `mp4` 字段或 `needs: ["final"]` 的门）判红，原因写明"合流之后 out/silent-… 变了"。
- **deliver**：定稿渲染后，如果成片过期且有记录，就用 `capability(record.skill)` 重放 `record.script record.args`（`.sh` 用 bash、`.py` 用 .venv 里的 python、其余用 node），
  重放后的成片必须是新鲜的；没装那个 skill 时，这一步记为 `–`（如实写明缺能力），只交付无声成片，声明了的成片检查也因此判红。没有成片的片子（无声交付）什么都不做；
  deliver **不替作者做第一次合流**（混音参数由作者决定）。收据的 `render.outputs` 只记录新鲜的成片。
- 其他合流工具想要接入，写同样格式的记录即可（`skill` 和 `script` 要能被 deliver 重放）。

## 7. 配方 recipe.json

任何 skill 都可以提供 `assets/recipes/<名>/recipe.json`；`new-film.mjs <slug> --recipe <名>` 会按它写入文件、合并 film.json 字段、声明检查。
配方名在全套件内唯一。new-film 扫描所有已安装 skill 的 `assets/recipes/`，core 自身不带配方；解说片配方 `explainer` 位于
`film-story/assets/recipes/explainer/`（包含 brief.md、PROGRESS.md、recipe.json），画面先行配方 `visual` 在它旁边。

```json
{ "schema": 1, "name": "explainer", "about": "一句话",
  "files": [ { "dest": "docs/brief.md", "from": "brief.md" },
             { "dest": "docs/shotlist.md", "skill": "film-story", "from": "assets/shotlist.md" },
             { "dest": "script.json", "skill": "film-narration", "from": "assets/script.template.json", "fallback": { "lines": [] } } ],
  "film": { "narrationOffset": 0, "narrationTail": 0 },
  "checks": ["shotlist", "facts.script", { "contrast": { "min": 4.5 } }],
  "next": ["1. …"] }
```

`from` 不带 `skill` 时，路径相对于配方目录；带 `skill` 时相对于那个 skill 的目录（那个 skill 没装时写入占位内容或 `fallback`，并给出提示）。
模板占位符有 `<片名>` `{{title}}` `<slug>` `{{slug}}` `<画幅>` `<film-xxx>`（替换为该 skill 的绝对路径）；残留的 `{{…}}` 会被点名报出。

## 8. 脚本命令行（全部 `--help` exit 0、未知参数 exit 2）

| 脚本 | 做什么 |
|---|---|
| `scripts/new-film.mjs <slug> [--format --fps --sub --formats --title --recipe <名> --from <slug> --films-dir] / --list` | 建内核骨架（不拷贝运行时）；`--recipe` 补充配方文件；`--from` 用于建变体 |
| `scripts/render.mjs --film <slug> [...] [--variant <id> \| --matrix]` | 逐帧渲染（参数见 render.md）；`--variant hook-b.cta-a` 渲染一个内容变体；`--matrix` 把 content.json matrix 的全部组合在每个画幅下各渲染一遍，输出到 `out/variants/<id>/` 并写 `manifest.json`（content-json.md §5） |
| `scripts/preflight.mjs --film <slug> [--variant <id>] [--format] [--entry] [--samples 12] [--safe 0.9] [--static-only]` | 渲染前做六项预检（assets / fonts / overflow / code / residue / claims），有 ✗ 时 exit 1；只有声明了 `preflight`，render / deliver 才会运行它（preflight.md） |
| `scripts/preview.mjs --film <slug> [--format --port]` | 供人眼预览（使用同一个 serve） |
| `scripts/seamcheck.mjs --film <slug> [--parallel N] [--relaunch N] [...]` | 内核门 1a/1b/2/3/4/5 和探针 |
| `scripts/font_source.mjs --film <slug> [--step --format --static-only]` | 内核门 fontsrc |
| `scripts/deliver.mjs --film <slug> [--list] [--relaunch-every N] [--gate-timeout M]` | 依次执行定稿渲染、按合流记录重新合流（仅在成片过期时）、跑全部门、冻结、写收据 |
| `scripts/deliver.mjs --film <slug> --phone [--max-mb 30] / --compare <旧.mp4> [--layout side\|stack] [--format]` | 平台档位，不渲染、不过门、不写收据。`--phone` 转码出不超过 max-mb 的 720p 手机预览 `out/phone-<fmt>.mp4`；`--compare` 生成新旧版本对比片 `out/compare-<fmt>.mp4`（只带新版音轨；layout 默认横版上下排列、其余画幅左右排列）；两个选项可以同时用 |
| `scripts/freeze.mjs --film <slug> [--from-record] [--dry-run] [--receipt <理由>]` | 只做冻结（给使用外部 dev server 的片子用）；`--receipt` 补写不过门的收据 |
| `scripts/accept.mjs [--deep] [--film] [--list [--verbose]] [--fixtures [--fixtures-dir]] [--films-dir]` | 全仓库验收；`--fixtures` 把夹具一起验收（默认目录 `<films 的父目录>/tests/fixtures`） |

能力 skill 里可以单独调用的脚本（同样 `--help` exit 0、未知参数 exit 2；细节在各自的 SKILL.md）：

| 脚本 | 做什么 |
|---|---|
| film-critique `scripts/transitions.mjs --film <slug> [--cuts 3.2,8.0-8.4] [--scan [--scan-fps 5]] [--pad] [--tile] [--label]` | 对每个剪辑点或转场窗口取前、入、中、出、后 5 帧拼图，只取帧不判定；声明不合法时 exit 1 |
| film-critique `scripts/fresh.mjs --film <slug> [--strict] [--selftest]` | 检查 out/ 里的派生产物是否基于当前的输入（默认只提示，加 `--strict` 才 exit 1） |
| film-narration `scripts/music.py --film <slug> --style <ambient\|chip\|pluck> [--drop --final --sections --bpm --key --seed --dry-run] / --list-styles` | 用代码合成配乐，输出 `out/music.wav` 和 `out/music.json`，时刻从 narration.json 和 film.json 读取 |
| film-narration `scripts/audiocheck.py --film <slug> [--mp4 \| --mix <file>] [--only open,tone,tail,peak] [阈值参数]` | 声音质量门：检查开场静音、发闷、尾巴、真峰；退出码 0 表示通过，1 表示判红，2 表示输入不全 |

## 9. Python：`lib/film.py`

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "film-core" / "lib"))
import film  # noqa: E402

ap = film.parser(__doc__)            # 带 --film / --films-dir；未知参数 exit 2
ap.add_argument("--verify", action="store_true")
a = ap.parse_args()
F = film.resolve_film(a.film, a.films_dir)     # → Path；找不到 die(…, 2)
cfg = film.film_json(F)
if film.check_param(F, "verify"): ...
py = film.find_venv_bin("python", a.films_dir)
story = film.capability("film-story")          # 没装 die("缺能力 film-story…", 1)
```

导出：`CORE_DIR SKILLS_ROOT die parser films_dir list_films resolve_film film_json out_dir rel need_file load_dotenv CHECK_ID checks check_param find_venv_bin installed_skills capability`。
