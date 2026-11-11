# film.json schema（内核部分，schema 1）

```json
{
  "schema": 1,
  "slug": "tang",
  "title": "唐 · 二百八十九年",
  "entry": "scene.html",
  "format": "9x16",
  "formats": ["9x16", "16x9"],
  "fps": 30,
  "sub": 4,
  "shutter": 1,
  "loop": false,
  "duration": null,
  "stage": "#stage",
  "crf": 16,
  "renderer": { "chromium": "156.0.8078.4", "playwright": "1.64.1", "args": ["--font-render-hinting=none"],
                "ffmpeg": "ffmpeg version 8.0 …", "x264Threads": 4 },
  "checks": ["shotlist", { "contrast": { "min": 4.5 } }]
}
```

## 内核读并校验的字段

| 字段 | 类型 / 取值 | 默认 | 校验失败时 |
|---|---|---|---|
| `schema` | `1` | `1` | 报错（以后修改结构时递增） |
| `entry` | 以 `.html` 结尾的相对路径 | `scene.html` | 报错；文件不存在也报错 |
| `format` | `9x16` `1x1` `16x9` | `9x16` | 报错 |
| `formats` | 由上述 key 组成的非空数组，或 `null` | `null`（等同于 `[format]`） | 报错 |
| `fps` | 整数 1–240 | `60` | 报错 |
| `sub` | 整数 1–32 | `4` | 报错 |
| `shutter` | (0, 1] | `1` | 报错 |
| `loop` | bool | `false` | 报错 |
| `duration` | 正数或 `null` | `null` | 报错 |
| `stage` | CSS 选择器 | `#stage` | 报错；页面里找不到对应元素也报错 |
| `crf` | 整数 0–51 | `16` | 报错 |
| `backend` | `"swiftshader"` / `"gpu"`，或不写 | 不写 = `swiftshader`（软件 WebGL，改动前的唯一行为，启动参数逐字不变） | 报错。`"gpu"` 的含义、代价、什么时候值得用，见 `render.md`「渲染后端」。render、seamcheck、fontsrc、preflight、freeze、kitcheck 以及所有经 `openScene` 打开本片的工具都读它，用同一组启动参数 |
| `renderer` | `{chromium, playwright, args, ffmpeg, x264Threads}`；`backend: "gpu"` 时再加 `{backend, gpu, gpuDriver}` | 首次**成功**渲染后由 render.mjs 写入；缺字段时只补缺少的部分（后端三项不补，换后端要 `--pin-renderer`）。`chromium` 记录版本号，完整 Chrome（非 headless shell）会加上后缀 ` (full Chrome)`；`gpu` 是实测的 WebGL `UNMASKED_RENDERER`，`gpuDriver` 是驱动版本 | 不校验；任一项与当前环境不一致时给出警告（后端、显卡、驱动也算） |

## 内核读、不在 resolveFilm 里校验的字段

`checks`：声明后才启用的检查，是一个扁平的 id 数组（需要参数时写成单键对象）。格式、id 规则以及由哪个 skill 认领，见 `api.md`「checks」。
accept --deep 和 deliver 会读取它，格式写错时这两处会报错（render 和 seamcheck 不受影响）。render 只看其中有没有 `preflight`：有就在渲染前先运行预检，格式有问题时只给出警告。

`kits`：kit 名数组（例如 `["acme"]`）。serve 读取它：声明了才会把 `/runtime/kits/<kit>/…` 挂载到仓库顶层的 `kits/<kit>/`，交付时冻结进 `runtime/kits/`，收据里多一段 `kits`，详见 `kits.md`。

## 不读、原样保留的字段

`slug`、`title`、`variantOf`（由 `new-film --from` 留下的来源记录。同一支片子的几个版本不通过拷贝实现，而是用片子根目录下 `content.json` 里的变体，content.json 不是 film.json 的字段，见 `content-json.md`），以及其他 skill 定义的任何字段（例如 film-narration 定义的 `narrationOffset` / `narrationTail`）。
其他 skill 添加配置时，使用以自己命名的对象（`"narration": {...}`），不要占用上表里的顶层字段名。
film.json 里没有 `runtime` 名单：运行时不再拷贝，实际加载了什么由 serve 记录在 `out/.render/runtime.json`，交付时再冻结进 `runtime/`。

## 语义要点

- **时长**：以 `window.DURATION` 为准（由场景运行时给出，通常等于 narration.json 的实测时长加上首尾留白）。
  `duration` 只在场景没有给出时兜底；`null` 表示"由场景或旁白决定"。两者都给出且不一致时给出警告，并以场景为准。
- **优先级**：命令行参数高于 film.json，film.json 高于上表的默认值。
- **默认值的性质**：`fps:60 / sub:4` 是渲染器的缺省值，不是审美推荐；脚手架 `new-film.mjs` 写入的是 `fps:30, sub:1`
  （迭代阶段成本低），定稿时由本片自己决定。
- **扩展位**：目前还不支持自定义画幅（例如 4x5），要支持需要同时修改 `layout.js` 的 `FORMATS` 和校验逻辑。
  届时会递增 schema 或新增 `customFormats` 字段，不复用 `format`。

## 与脚手架的对应

`new-film.mjs` 生成 `{slug,title,format,fps:30,sub:1,entry,formats:null,duration:null,loop:false,checks:[]}`；
加上 `--recipe <名>` 时，再按配方的 `film` 字段合并额外字段，并按配方的 `checks` 声明检查项。

## checks 里的 preflight（film-core 自己认领）

写法是 `"checks": ["preflight"]`，或者带参数的 `{"preflight": {"safe": 0.9, "samples": 12}}`。`safe` 是标题安全区占舞台的比例（默认 0.9），
`samples` 是没有 `window.MARKS` 时均匀采样的时刻数（默认 12）。声明之后，render 会在渲染前先运行 `scripts/preflight.mjs`，失败就中止；
deliver 和 accept --deep 把它当作一道 checks 门运行。命令行的 `--safe` / `--samples` 会覆盖这里的值。六项判断标准见 `preflight.md`。
