# motion-studio

这个仓库是 **film-\* skill 套件**的开发工作区，外加用它做出来的片子。

## 做片子

读 `film-core` skill。它是入口：建内核骨架（解说片流程是可选配方 `--recipe explainer`），给出 seek(t) 契约，并指出每步该读哪个 skill。
或者 `/film`。

```bash
node skills/film-core/scripts/new-film.mjs <slug> --format 9x16
node skills/film-core/scripts/deliver.mjs --film <slug>     # 定稿渲染 → 全部适用的门 → 冻结运行时 → receipt.json
```

片子在 `films/<slug>/`，一切产出进 `out/`。新片不拷运行时：服务器把 `/runtime/*` 解析为"片内同名文件优先，否则套件里的"；
`deliver` 过门后把实际加载的运行时冻结进片子 `runtime/`，写入库的 `receipt.json`。交付之后改了任何输入，accept 就是红的，重新 deliver。

配方不是唯一做法：配乐片、Lottie 片、游戏思路的片子各按自己的时间真相源排序。
唯一绕不开的是 `skills/film-core/references/kernel.md`。风格和思路是菜单，不是规定（`film-core/references/style-menu.md`）；
片子可以整体采用一个外部设计 skill 的方向，在 style_guide 写一句采用了谁即可。

## 改 skill

先读 film-core 的 `references/kernel.md`（唯一无条件的技术契约）和 `references/api.md`（能力 skill 能依赖的全部接口），
再读 `docs/MAINTAINING.md`（skill 边界、写法、交付标准）。改任何一个 skill 之前先确认不是你该让步。

这套东西要保持**很薄的一层**：内核之外的东西都应该是可插拔的能力、可参考的菜单、可选的检查，
不管以后叠加什么（外部设计 skill、游戏开发思路、Lottie……）都应该好加。
往套件里加东西前先问：它是内核契约吗？不是的话，它就不该是拦路的门，也不该是每支片都要写的文档。
依赖只有一个方向：能力 skill 只许 import film-core，跨能力走 `capability(name)`。

一条贯穿全套的原则：**skill 呈现能力，不规定风格。**

不要往任何 skill 里加默认配色、默认字体组合、默认转场，或者"禁止 X"。
这套东西早期版本就是因为把一种审美写成了法律而失败的——
规则对水墨片成立，对霓虹赛博全是错的；模型为了守规则每次都退回它最会写的那一招，
两支片子长得一模一样。

审美判据的唯一来源是每支片自己的 `films/<slug>/docs/style_guide.md`。
如果你发现自己在往 skill 里写"推荐做法"，先问这是技术不变量还是你的口味。
每一条"不要 X"都要能改写成"X 的代价是 Y，什么时候值得付"；
改写不了的，要么标成硬约束，要么删掉。

## 合格线，都是可执行的

```bash
node skills/film-core/scripts/accept.mjs   # 查片子：已交付的对账收据，未交付的只报告（--deep 把门全跑一遍）
node dev/selfcheck.mjs                     # 查 skill 本身：9 个 skill、依赖方向、gates.json、风格中立、语法
node dev/test.mjs                          # 回归：各 skill 自测 + 阴性/阳性对照（--quick 跳过慢的三维夹具）
```

改完任何东西，这三条都要过。改了门或运行时，再对受影响的片子跑 `accept --deep`。

## 技术不变量（这些才是无条件的）

一部影片是**时间的纯函数**：`seek(t)` 画出第 t 秒那一帧，别的什么都不做——seek 期间不读时钟、不用 `Math.random`、
不靠定时器或跨帧状态推进，第三方库的自带循环关掉改由 t 驱动，字体随片打包。
完整契约、守它的门（1a/1b/2/3/4/5、探针、字体来源等）和症状表只在 film-core `references/kernel.md` 写一遍，以它为准。

## 音频对齐（最容易做错的地方）

对齐不是把动画凑到音频上，是让动画去读音频的时间戳。音频先行、时长回写、
关键词触发、事后校验，四条缺一条就漂。细节见 `film-narration`。

API key 只放 `.env`，代码和文档里只提变量名。

## 环境既成事实

- Node + Playwright(Chromium 156)，`node_modules/` 在仓库根。
  **默认跑的是 `chromium_headless_shell-*`，不是 `chromium-*` 那个完整 Chrome。**
  两者 `browser.version()` 返回同一个字符串，但渲出来差 5.4–13.6% 像素、肉眼可见
  （等宽字体回退不同）。手动指定浏览器路径时特别容易拿错那个。
- Python 在 `.venv/`：librosa、edge-tts、faster-whisper、truststore
- **这台机器做 TLS 拦截**，Python 直连会 `CERTIFICATE_VERIFY_FAILED`。
  解法是 `truststore` 走系统钥匙串，见 `film-narration` 的 `make_ssl_context()`
- WebGL/WebGL2 都可用但是软件渲染（SwiftShader）。
  **每种 context 必须用各自的 canvas**，同一个 canvas 上先取 webgl 再取 webgl2 返回 null

## 目录

```
skills/film-core/    入口与内核：契约、共享 lib、基础运行时、渲染、内核门、deliver/freeze/accept
skills/film-*/       另外 8 个能力 skill：motion webfx physics typography narration assets story critique
                     装机只拷 skills/film-*/（装法见 skills/README.md）
dev/                 开发工具，不随安装：selfcheck、test（期望表 test-fixtures.json）、各 skill 的基准脚本
tests/fixtures/      阴性/阳性对照夹具 _test-*：没有 runtime/、测现行代码、不交付；脚本对它们加 --films-dir tests/fixtures
docs/                开发台账：MAINTAINING.md 维护约定、INTEGRATION.md 变更与 bug 记录、verified/<skill>.md 实测记录
films/<slug>/        片子；已交付的带 receipt.json
.venv/               Python 环境
```
