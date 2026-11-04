# 调研工具：适用场景与已知坑

> 工具名（`mcp__Claude_Browser__*`、`browser-cli`、`context7`）和站点行为（x.com 对 WebFetch 返回 402、PDF 读不出正文等）是 2026-10 实测的结果，属于时效信息，使用前以当时的实际表现为准。

## 决策顺序（从上往下，先命中先用）

1. 要查软件库或 API 的事实：用 context7（先 resolve-library-id，再 query-docs），版本号写进 facts.md。
2. 内容需要登录才能看（x.com、付费墙、内部系统）：用 browser-cli（用户已登录的真实 Chrome）。
3. 需要看页面长相、截图或 JS 渲染出的内容：用内置浏览器 mcp__Claude_Browser__*。
4. 已知 URL 时用 WebFetch；否则先用 WebSearch standard，不够再用 extended，拿到 URL 后回到 WebFetch 读原页。

## WebSearch

- **standard** 快且便宜，适合第一轮找来源；**extended** 贵好几倍，用在承重事实、中文或冷门史料、standard 只返回百科和内容农场、需要找反方观点这些场合。
- **摘要会混入搜索模型自己的记忆**（实测出现过没有任何来源的"据我所知…"），也会把多个来源揉成一个结论，导致归属张冠李戴。摘要只能当线索。
- 中文主题要中英文各搜一次，英文百科给的数字常和中文学者给的不同。

## WebFetch

- 返回的是**小模型对页面内容的回答**，不是页面本身。prompt 要写"逐字摘出原文句子"并写明要找的点，否则转述可能改掉数字格式甚至单位。它回答"文中没有这个信息"，本身也是有用的结果。页面没写日期时它可能根据 URL 推断，登记时要写"日期为推断"。结果有 15 分钟缓存。
- 失败场景：**x.com / twitter.com 返回 HTTP 402**（改用 browser-cli）；登录页和付费墙会返回登录页或空内容；重 JS 的 SPA 内容不完整（换内置浏览器）；跨域重定向不会自动跟随（用返回的新 URL 再调一次）；localhost 和不带点号的主机名无法访问。
- **PDF**（论文、规格书、年报）读不出正文，但会存到本地并给出路径。做法是拷进片子的 `out/research/`，用 `pdftotext -layout <pdf> <txt>` 抽出文本，自己阅读并摘录原句；`.txt` 留在 `out/research/` 方便复查，facts.md 的来源仍写 PDF 原始 URL，并注明"本地抽取文本 <路径>"。
- 历史版本：`https://web.archive.org/web/2007/<原 URL>`（用来查产品首发时的规格页、新闻稿）。

## 内置浏览器（mcp__Claude_Browser__*）

使用前先读 `anthropic-skills:built-in-browser` skill。适合 JS 渲染的页面、产品 UI 截图和折叠内容。`get_page_text` 读取正文，`read_page` 获取结构，`computer` 的 `screenshot` / `zoom` 用来截图。它有自己的登录态，但不是用户的 Chrome。截图存到 `films/<slug>/assets/` 或 `out/research/`，facts.md 里写路径、来源 URL 和日期；授权问题归 film-assets。

## browser-cli skill（用户已登录的真实 Chrome）

使用前加载 `browser-cli` skill。适合 x.com、付费数据库、产品后台，也是产品 UI 截图的最佳来源（拿到的是用户真实看到的版本）。这是用户的真实账号：只读，不发帖，不点任何提交类按钮，需要操作时先问用户。

## 来源登记的最小信息

`- 来源: [作者《标题》，刊物 日期](URL) — "原文句子"`：作者或机构、日期、URL、原文句子，缺任何一项，可信度就降一级。
