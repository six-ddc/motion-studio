# 渲染前预检 preflight（声明才开）

```bash
node <core>/scripts/preflight.mjs --film <slug> [--variant <id>] [--format 16x9] [--samples 12] [--safe 0.9] [--static-only]
```

预检的出发点是：**宁可拒收坏的输入，也不要渲染出一支漂亮但内容错误的片子。** 它几秒内就能跑完（实测 1.7 s），输出一张六行的表，只要有 ✗ 就 exit 1。
它不是内核门：只有 film.json 的 `checks` 里声明了 `"preflight"`（需要调参时写 `{"preflight": {"safe": 0.9, "samples": 12}}`），
deliver 和 accept --deep 才会运行它；声明之后 render 也会在渲染前调用它，返回非 0 就中止渲染。没有声明的片子不受任何影响，也可以随时单独运行。

`--variant <id>`（例如 `hook-b.cta-a`）：content.json 按内容层运行时 `content.js` 的 `resolveContent` 合并（与页面、render 使用同一套规则；变体 id 不合法时判 ✗），页面以 `?variant=<id>` 打开。render 的钩子会对每个变体调用一次。

## 六项：它测的量 vs 你可能以为它测的量

| 项 | 实际检查的内容 | 不检查的内容 |
|---|---|---|
| assets | 入口页、片内 js/css、content.json `assets` 里**以字面量写出**的本地路径是否存在；外链素材（与 film-assets audit 口径相同）；页面加载时**实际**发生的 404 和外部请求（外部请求一律拦截，所以也顺带证明了能离线渲染） | 授权与台账（归 audit.mjs）；用变量拼出来的路径，只有加载时真的发出了请求才能发现；其他 .html 文件（备用入口、旧版本）不扫描 |
| fonts | `document.fonts` 里 status=error 的 face；ready 之后仍处于 loading 的 face；`loadFonts(…).catch(() => {})` 或 `try { fonts.load } catch {}` 这类吞掉异常的写法；content.json 的全部文本加上采样时刻页面上可见的 DOM 文字中，**用该元素自己的计算字体**逐字检查画不出来的字（判断方法是 film-typography `text.js` 的 `missingGlyphs`，没有安装时 SKIP） | 绘制文字用的是不是系统字体（归内核门 fontsrc）；canvas 上绘制的文字（由 fontsrc 逐字检查）；没有用到的 unicode-range 分片（处于 unloaded 状态是正常的，不做判断） |
| overflow | content.json 槽位的 `maxChars` / `maxLines` / `box:{w, lines?}` 加 `font`（用 canvas 量宽度）；采样时刻带 `data-slot` 的元素是否出现以下情况：内容溢出自己的盒子（scrollWidth/Height）、超出舞台、超出标题安全区、压住带 `data-avoid` 的元素；`data-max-chars` | 没有标 `data-slot` 的文字只报 ⚠（飞入飞出的卡片是有意出画，脚本无法区分）；canvas 上绘制的文字（用 anchors 加 film-critique 的遮挡/出画检查）；两个采样时刻之间的瞬间状态 |
| code | 页面里的 `[data-code-lang]` 代码块，以及 content.json 里带 `lang` 的槽位：lua 用 `luac -p` 检查（没有安装时 SKIP 并说明），js 用 `node --check`，json 用 `JSON.parse`；代码行元素的 display 是 flex/grid，或者 white-space 折叠了行首空格 | 代码能不能运行、运行结果对不对；没有声明 `data-code-lang` 的代码（例如没标语言的 `飞船.lua`） |
| residue | film.json 有 `variantOf` 时，检查 docs/*.md、tools/*、入口页、片内 js/css、content.json 里是否残留源片的 slug、源片标题、`{{占位}}` | 语义上的残留（源片的配色、镜头节奏）；带 `preflight:allow` 的行会跳过（有意引用源片时使用） |
| claims | content.json `claims` 的每一条都有 `source`，该 id 存在于 docs/facts.md 事实总表（film-story factcheck 的格式）中，且状态允许上片（已核、单源、争议、免核） | 说法本身是否正确（那属于调研和 factcheck 的工作）；"经客户确认"要体现为 facts.md 中那一条的来源与状态，预检只核对记录 |

采样时刻：取 `window.MARKS` 每段的中点（关键时刻，此时元素应该已经站定）；没有 MARKS 时均匀采样 `--samples` 个时刻。同一个问题在多个时刻重复出现时只报一次，写明首次出现的时刻和一共出现在几个时刻。

## 页面约定（全部可选，不标就不查那一项）

```html
<h1 data-slot="title" data-max-chars="14">…</h1>      <!-- 位置和长度要管的文字 -->
<div data-avoid="landmark">…</div>                     <!-- 不许被 data-slot 压住的东西（地标、logo、关键画面） -->
<pre data-code-lang="lua"><div>function f()</div><div>  return 1</div><div>end</div></pre>
<!-- 代码块的直接子元素（或 [data-code-line]）= 一行：display:block + white-space:pre -->
```

content.json 的结构见 `content-json.md`。预检读取其中的以下字段：`assets`（名字到路径的映射）；`text` 槽位（`text` `maxChars` `maxLines` `box:{w, lines?}` `font`；带 `lang` 的槽位按代码检查）；
`claims`（`text` 加 `source`，`source` 是 facts.md 里的 id）；可选的 `code`（`{名: {lang, text}}`）。其余字段不读取。

## 历史坑 → 哪一项

| 历史问题 | 由哪一项发现 |
|---|---|
| 网格在纵向溢出舞台；标题贴顶被状态栏遮住；字幕底条盖住地标；长句没有切分 | overflow（需要标 data-slot / data-avoid / maxChars） |
| `loadFonts(…).catch(() => {})` 把缺字错误吞掉，渲染完才发现用了回退字体 | fonts |
| 画面里的 Lua 代码有语法错误；代码行用了 flex 布局，缩进被吞掉 | code |
| 复制变体后，docs 和配乐脚本里还是源片的名字 | residue |
| 宣传数字没有经过确认就上了片 | claims |

## 阴性对照

`tests/fixtures/_test-preflight/`：`good/scene.html` 全部通过；同目录下的 `bad-assets / bad-fonts / bad-overflow / bad-code.html` 各自让对应的那一项失败（bad-fonts 的字体文件缺失，所以 assets 也会同时失败）；
`bad-content`（content.json 超长、缺素材、claims 没有出处、出处找不到或状态为待核）、`bad-variant`（从 `pf-src` 派生的变体残留了源片内容）。期望表在 `dev/test-fixtures.json`。
