# content.json：内容数据层与变体矩阵（可选）

目录：1 什么时候用 · 2 schema · 3 场景里怎么读 · 4 变体与矩阵 · 5 渲染与清单 · 6 画幅：重排不裁切 · 7 代价与边界

## 1. 什么时候用

一支片子要出**几个版本**（两版开场 hook、两版 CTA、横竖两个画幅等），或者画面上的文案要允许别人修改而不碰动画代码时使用。
内容决定画什么（content.json），动画系统决定怎么画（scene.html / shots/*.js）。变体是同一份源文件配上多份数据，
而不是用 `new-film --from` 拷出来的副本。副本从第一天起就各自走样：源片修了镜头，副本不会跟着改；时间常量两边各存一份；标题和脚本里还残留着旧片的内容。
没有 content.json 的片子不受任何影响：render 的输出、清单、分片缓存和没有这一层时逐字节相同。

## 2. schema（schema 1）

```json
{
  "schema": 1,
  "brand":  { "colors": { "ink": "#3A1604", "accent": "#F06A2C" }, "fonts": { "sans": "Film Sans" }, "look": "look.json" },
  "assets": { "logo": "assets/logo.svg", "music": "assets/music.wav" },
  "text": {
    "tagline":    { "text": "拼一拼，说一说，游戏就成了。", "locked": true, "maxChars": 14 },
    "hook.title": { "text": "", "maxChars": 13, "font": "900 92px \"Film Sans\"", "box": { "w": 1500, "lines": 1 } },
    "cta.label":  "",
    "cta.url":    "g.example.com",
    "brand.name": { "text": "Example", "kind": "identity", "description": "本片推广的产品名" },
    "demo.code":  { "text": "print('hi')", "lang": "lua" }
  },
  "claims": [ { "text": "导出到网页、手机、电脑", "source": "F01" } ],
  "params": { "hold": 1.2 },
  "variants": {
    "hook":   { "a": { "text": { "hook.title": "第一版" } }, "b": { "text": { "hook.title": { "text": "第二版", "emph": "二" } } } },
    "cta":    { "a": {}, "b": { "text": { "cta.label": "现在就来" } } },
    "format": { "9x16": { "text": { "hook.title": "短一点" }, "params": { "hold": 1.5 } } }
  },
  "matrix": { "product": ["hook", "cta"], "exclude": [ { "hook": "b", "cta": "b" } ], "formats": ["16x9", "9x16"] }
}
```

| 字段 | 含义 |
|---|---|
| `brand` | 品牌 token。`colors` / `fonts` 是名字到值的映射；可以用 `look` 指向本片的 look.json（只用于衔接，内核不读）。审美判断仍以本片 style_guide 为准 |
| `assets` | 素材登记表，把 id 映射到相对片子目录的路径。预检会检查文件是否存在；场景用 `C.asset(id)` 取路径（换图的变体只需改这里） |
| `text` | 槽位表，把槽位 id 映射到 `"文本"` 或一个对象。对象里 `text` 必填，其余可选：`maxChars`；`font` 加 `box {w, lines}`（预检用它量宽度）；`lang`（代码槽位的语言，如 lua/js，预检会做语法检查）；`emph`（片子自定义的强调词）；`locked`（与旁白或时间数据来源绑定，变体不允许修改）；`note`；`description` / `kind`（语义声明，见下文）。其余字段原样传给场景 |
| `claims` | 画面或旁白里的宣传说法，包含 `text` 和 `source`（docs/facts.md 事实总表里的 id；**宣传数据必须有来源**）。可以加 `where` |
| `params` | 少量命名参数（停留时长、版式开关）。变体只能修改已经声明过的参数名 |
| `variants` | 结构是"维度 → 选项 → 覆盖内容"。覆盖内容只能包含 `text` / `assets` / `brand` / `params`（以及 `note`），**不修改动画代码**；`{}` 表示不覆盖。维度名须匹配 `[a-z][a-z0-9]*`，选项名须匹配 `[a-z0-9]+` |
| `matrix` | 要导出的组合。缺省时取全部维度的笛卡尔积；写成数组时是显式列表 `[{hook:"a", cta:"b", format?: …}]`；写成对象时是 `{ product, exclude?, include?, formats? }` |

预检（`preflight.mjs`；film.json 的 checks 里声明了 `"preflight"` 时，render 会在渲染前自动运行）读取以下字段：`assets`、`text` 的 `maxChars`/`font`/`box`/`lang`、`claims`。
DOM 里绘制槽位文字的元素要标上 `data-slot="<槽位 id>"`，预检据此检查溢出。

**槽位语义（可选）**：`description` 写**这个槽位代表什么**（例如"本片推广的产品名"），不写它在画面哪里（例如"页角小字"）。接手做变体的 agent 读它来决定填什么。
`kind` 取值为 `content`（文案）、`identity`（品牌名、产品名、logo、网址、背书方、榜单）或 `style`。**identity 槽位取不到值时，停下来问人，不能自己编造**：
换品牌、换主角的变体最容易凭空编出 slogan、榜单和背书。render 读取 content.json 时（`lib/content.mjs` 的 `validateSlotMeta`）会检查三件事：kind 的取值合法、identity 槽位必须有 description、值和变体覆盖不能是空串。浏览器运行时不读这两个字段。

## 3. 场景里怎么读（`runtime/content.js`）

```js
import { loadContent } from './runtime/content.js';
const C = await loadContent();      // 加载期一次：fetch ../content.json，按 URL ?variant=<id>&format=<key> 合并；同时挂 window.CONTENT
C.text('cta.url')  C.slot('hook.title').emph  C.asset('logo')  C.color('ink')  C.font('sans')  C.param('hold')
C.id  C.picks  C.strings()          // strings()：生效内容的全部文字，拿去预加载字体分片
```

- 合并在加载期完成，seek 里只读取 C。URL 是变体信息的唯一来源（和 `layoutFromURL` 一样），所以 seek(t) 仍然只取决于 t 和加载期常量。
- 读取不存在的 id 会直接抛错，因为拼错的槽位名如果静默画出空串，是最难发现的错误。
- 字体：变体文案里新出现的字要加进字体子集，否则第一次绘制时会走回退字体。film-assets 的 `subset_font.py` 默认从 content.json 收集全部变体的文字（`--check` 用同样的口径）。
- Node 侧（render、预检）`import` 同一个文件里的纯函数：`resolveContent(doc, {variant, format})`、`parseVariant`、`expandMatrix`、`validateContent`。

## 4. 变体与矩阵

- **合并顺序**：先取基础内容，再按 `variants` 里的声明顺序叠加各维度选项，最后叠加 `format` 维度（渲染哪个画幅就叠哪个）。文本覆盖可以只写字符串（替换 `text`），也可以写对象（合并进槽位）。
- **变体 id**：每个维度写成 `<维度>-<选项>`，按声明顺序用 `.` 连接，例如 `hook-b.cta-a`；什么都不选时 id 为 `base`（即基础内容）。画幅不进 id。
- **locked 槽位**：和旁白逐字同步的文案（例如随旁白字词砸入的标语）要标 `locked`。变体覆盖这类槽位会直接报错，因为旁白音频不会随变体改变。
- **只在变体里出现的内容**（例如只有变体才有的开场标题卡）：在基础内容里放空串，场景遇到空串就不创建节点。这样基础版和加入内容层之前逐帧一致。

## 5. 渲染与清单

```bash
node <core>/scripts/render.mjs --film <slug> --variant hook-b.cta-a            # → out/variants/hook-b.cta-a/silent-<fmt>.mp4 (+ final-<fmt>.mp4)
node <core>/scripts/render.mjs --film <slug> --variant cta-b --from 62 --to 70 # 区间小样：…/final-<fmt>-62-70.mp4
node <core>/scripts/render.mjs --film <slug> --matrix [--format 16x9]          # 矩阵全部组合 × 画幅
```

- 打开页面后会核对 `window.CONTENT.id` 是否等于要渲染的变体，不相等就报错，这样场景没接 content.js 时不会悄悄渲染出基础版。
- **音轨**：从主片 `out/final-<fmt>.mp4` 取出音轨重新封装（旁白、音效、配乐不随文案变化）。前提是主片的合流记录存在且音频输入没有改过，否则只输出无声片并说明原因。
- **缓存**：分片缓存与主片共用，缓存键里不包含变体，所以像素相同的分片可以跨变体复用。同一个分片的不同内容可以并存（一份主份加最多 6 份备份），
  来回渲染 hook-a 和 hook-b 时，只有开场那几个分片各编码一次。逐帧清单另存在 `out/.render/variants/<id>/<fmt>.frames.json`，不覆盖主片的基线。
- **清单** `out/variants/manifest.json`：每个导出占一条记录（键为 `<id>/<fmt>[@from-to]`），内容包括：组合、`contentHash`（对生效内容取哈希，与键的顺序和组合名无关）、
  `sources`（content.json、模板即除 content.json 以外的全部输入、全部输入的 sha256、挂载的运行时）、渲染设置、渲染器指纹、帧数/时长/宽高、
  `framesDigest`、无声片与成片的路径和 sha256。

## 6. 画幅：重排不裁切

画幅是一个维度，而不是一次裁切，因为竖版需要另一套构图。做法与 `layout.js` 的 `pick()` 以及 tencent-5y 的 `GEOMS` 相同：
每个画幅配一张几何表（标题位置、字号、图表区域），场景按 `L.key` 取用；`variants.format` 里只放**数据**上的差异（竖版的短文案、更长的停留时间 `params`）。
把 16:9 的画面直接裁成 9:16 会切掉排版，文字框也不再与 `box` 对应。

## 7. 代价与边界

- 变体只能替换数据。要换镜头、改时间结构，那就是另一支片子（或者在场景里加一个 `params` 开关，代价是场景里多一条分支需要维护）。
- 界面上的数据只能来自产品的真实输出，宣传数字必须有 `claims.source`。内容层让文案容易修改，也让"随手改出一个没有来源的数字"变得容易，预检的 claims 项就是为此设置的。
- 交付（deliver/receipt）仍以主片为准；变体是同一份输入的不同导出，`manifest.json` 记录它们各自对应的输入哈希。
