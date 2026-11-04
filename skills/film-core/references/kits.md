# kit：品牌/系列范围内共享的组件库

目录：1 是什么 · 2 挂载 · 3 冻结与收据 · 4 kit.json · 5 自检（声明才开）· 6 代价与边界

## 1. 是什么

kit 把一个品牌或系列**已经定下来**的长相（logo 的真实几何与动效、主题绘制方案、品牌色和字体角色 token、标准首尾帧）做成审核过的模块，
片子只需**选用并配置**它，不必让模型每支片子重画一遍。kit 放在仓库顶层的 `kits/<名>/`，不放进 `skills/`；使用说明写在 `kits/<名>/README.md`。
kit 不是套件的默认模板。套件运行时提供的是**能力**，谁 import 谁使用，不带审美倾向；kit 带有审美倾向，只对在 film.json `kits` 里声明了它的片子生效。
kit 要解决的是几个老问题：系列片之间主题割裂；靠手工拷贝加同步脚本维护，留下复制残留；logo 被手画成近似的形状。值得做成 kit 的信号是：**第二支**片子要用同一个组件。

## 2. 挂载（就是运行时挂载，没有第二套）

在 film.json 里写 `"kits": ["acme"]`，场景里写 `import './runtime/kits/acme/brand.js'`（shots/ 子目录里写 `../runtime/kits/…`）。
`lib/serve.mjs` 按以下顺序解析 `/runtime/kits/<kit>/<文件>`：片内的 `runtime/kits/<kit>/<文件>` 优先（这是冻结副本）；否则从 `kits/<kit>/` 中取
**kit.json `exports` 列出的**文件，来源记为 `kit:<kit>@<版本>`。`kits/` 的位置按优先级取 `$KITS_DIR`，没有时从片子目录往上找到的第一个 `kits/`。

| 情形 | 结果 |
|---|---|
| 没有声明 kits | 不执行这一套解析，行为不变；如果 import 了 kit 文件，返回 404，stderr 提示"film.json 没有声明 kits" |
| 声明了，但 kits/ 里没有，片内也没有冻结 | `serve()` reject，所有工具在启动时就说明是哪个 kit 缺失 |
| 声明了，kits/ 里没有，但片内冻结过 | 照常打开（适用于交付过的片子被搬到别处的情况） |
| import 了没有导出的文件 | 返回 404，stderr 提示"不在 kit.json exports 里" |

kit 文件以 `kits/<kit>/<文件>` 为名记入加载记录、渲染清单的 `runtime`、分片缓存键和 seamcheck 输入指纹，与运行时同等对待，所以 kit 改动一个字节，全部分片都要重新编码。
kit 内部的相对 import（`./tokens.js`）和对套件运行时的引用（`../../motion.js`）最终都解析回 `/runtime/…`，走同一张挂载表。

## 3. 冻结与收据

deliver 第 6 步和 `freeze.mjs` 共用 `lib/freeze.mjs`：把实际加载的 kit 文件连同当时那一版 kit.json 一起拷进 `runtime/kits/<kit>/`，拷贝前先逐个核对 sha256。
**一支片子不能混用两个版本的 kit**：片内冻结的是 A 版，又要从已经升级到 B 版的源头补充文件时会报错（处理办法是删掉整个目录再交付，或者把旧版缺少的文件补进来）。
收据在 `runtime` 之外多一段 `kits`（只有声明了 kits 的片子才有）：

```json
"runtime": { "kits/acme/brand.js": { "from": "kit:acme@1.0.0", "sha256": "7a42…" } },
"kits":    { "acme": { "version": "1.0.0", "files": { "brand.js": "7a42…" } } }
```

`inputs.files` 包含 `runtime/kits/…`，所以改动冻结副本后 accept 同样会失败。交付之后 kit 升级不会改变这支片子的像素，也不会修掉它的 bug；
要用新版就删掉 `runtime/kits/<kit>/` 再 deliver。`kitcheck.mjs --list` 会列出每个 kit 被哪些片子使用、各自冻结的是哪一版。

## 4. kit.json

```jsonc
{ "schema": 1, "name": "acme", "version": "1.0.0",       // name = 目录名；改了导出文件的内容就升 version
  "about": "一句话", "exports": ["brand.js", "tokens.js"],  // 只有这些能挂；工具、PNG、文档不导出
  "check": { "std": { "png": "std-frame.png", "format": "9x16", "at": [0, "end"] },   // 可选，§5
             "cmd": ["node", "{kit}/tools/check-brand.mjs", "{film}"] } }
```

导出的文件属于影片运行时，要遵守 kernel.md（不能用 Node API、`Math.random` 和时钟）。`tools/` 下是 Agent 工具，不导出。

## 5. 自检（声明才开，不是必过门）

片子的 `checks` 里写了 `"kits"`，才会运行 `scripts/kitcheck.mjs`，对声明的每个 kit 执行 kit.json 里的 `check`：
- **`std`**：在 `at` 列出的时刻（秒数或 `"end"`）截取 `#stage`，要求截图的 RGB 与 kit 里的 PNG 逐像素相等（对应系列片"首尾帧是同一个画面"的约定）；不相等时把截图存到 `out/kitcheck/`。
- **`cmd`**：退出码非 0 即判为失败；可用占位符有 `{kit}` `{film}` `{slug}` `{films}`，cwd 是 kit 目录（例如品牌 kit 检查 content.json `brand` 下的同名键是否等于 kit 的 token）。

没有登记 check 的 kit 记为「–」。自检按 kits/ 中的当前版本运行，片内冻结的是旧版时会给出提示。阴性对照在 `tests/fixtures/_test-kits/`，期望表在 `dev/test-fixtures.json`。

## 6. 代价与边界

- 用不用某个 kit 由 brief 决定，不是默认行为；片子的 `style_guide.md` 里要写一句"采用 kit X"。片子自己的颜色、版式、镜头、转场不放进 kit。
- 还在探索中的长相先不要提成 kit，因为过早固化之后，后面每支片子都得绕着它走。
- 已交付的片子不跟随 kit 升级。老片迁移是一次显式的"修改片子并重新交付"，像素不变的迁移通常不值得做（weiqi-wood 的老五课保持原样）。
- `lib/runtime-node.mjs` 的 `importRuntime` 不解析 `kits/…`；kit 的 Node 工具直接按文件路径 import。
