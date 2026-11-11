# 数据图表的几何：`chart.js`

目录：0 约定 · 1 比例尺与刻度 · 2 数值格式 · 3 序列几何 · 4 随 t 变化的数据（关键帧、柱状图竞赛、折线生长、轴刻度进出） · 5 地理 · 6 关系图 · 7 跨引擎一致与 dmath · 8 局限

`chart.js` 只返回**几何和数值**：坐标、点列、刻度、角度区间、连续名次、透明度系数。它不画任何东西，也不带颜色、线宽、字体、留白；
怎么画由本片 `docs/style_guide.md` 和你的 ctx 决定。实测数字来自夹具 `tests/fixtures/_test-dataviz`（仓库内），本页只给结论。

```js
import { scaleLinear, ticks, barRace, projection, fit, geoShapes, forceLayout } from './runtime/chart.js';
```

Node 里 import（检查脚本、离线算布局）之前先调 film-core `lib/runtime-node.mjs` 的 `registerRuntimeResolver()`：chart.js 依赖 film-core 的 `rand.js`。

## 0. 约定

- **有状态的东西在加载期算完。** `barRace` 扫交换事件、`forceLayout` 跑仿真、`lineGrower` 累积弧长，都在模块顶层建一次；seek 里只调 `.at(t)`。
  在 seek 里重建它们不会坏确定性（输出只取决于参数），代价是每帧重付建表的时间（见各节数字）。
- **参数没有默认的长相。** band 的 padding、饼图的起始角、竞赛的交换时长与淡出宽度、格式的小数位都必须给，缺了就抛错。
  有默认值的只有数学定义本身（log 的底 10、SI 词头表、万/亿表、时间按 UTC）。
- **坐标约定同 canvas**：y 向下；角度是弧度，0 指向 +x，屏幕上顺时针增大（12 点钟方向是 −π/2）。
- 任意 SVG 路径的描边生长、形状变形在 `shapes.js`（`references/shapes.md`）；文字数字滚动在 film-typography 的 `odometer`。这里只管数据到几何。

## 1. 比例尺与刻度

```js
const x = scaleLinear({ domain: [0, 240], range: [40, 920], clamp: false });   // x(v)、x.invert(px)
const r = scaleSqrt({ domain: [0, maxPop], range: [0, 60] });                  // 气泡半径：面积正比于值
const y = scaleLog({ domain: [1, 1e6], range: [600, 0] });                     // base 默认 10，负域按 −log(−x)
const t = scaleTime({ domain: [Date.UTC(2001, 0, 1), Date.UTC(2024, 0, 1)], range: [0, 900], utcOffset: 480 });
const b = scaleBand({ domain: ['甲', '乙', '丙'], range: [0, 600], paddingInner: 0.2, paddingOuter: 0.1 });   // b(key)、b.bandwidth、b.at(1.5)
ticks(x, 5);              // [0, 50, 100, 150, 200]：1/2/5×10^k 取整（规则同 d3），值是精确十进制（没有 0.30000000000000004）
ticks(t, 6);              // 时间：按秒/分/时/日/月/年挑间隔，数组带 .unit .step；年刻度再按 1/2/5 取整
nice(x, 5);               // 返回新比例尺：域外扩到取整刻度
timeParts(ts, { utcOffset: 480 });   // → { year, month, day, hour, … }：标签拼成什么样由你决定
```

- `scaleTime` 不读本机时区：刻度按 UTC 加你给的固定偏移（分钟）算。读本机时区的代价是换一台机器刻度就挪位，门 1b 抓不到（同一台机器上两次一样）。
- `scalePow`/`scaleSqrt` 适合面积编码。用半径直接线性编码值，值翻倍时面积变 4 倍，观众按面积读会高估大值。
- `scaleBand.at(i)` 接受小数下标：柱状图竞赛的连续名次直接喂给它。
- `count` 是"大约几个"：[0, 1234] 要 4 个得到步长 200 的 7 个（308.5 落在 [√2, √10) 档），想要更少就减小 count。

## 2. 数值格式

```js
grouped(1234567.8, { decimals: 1 })            // '1,234,567.8'；sep / point / group 可换（group: 4 做万位分组）
si(999950, { decimals: 1 })                    // '1.0M'（四舍五入进位后换到上一个词头，不出 '1000.0k'）
cjk(123456789, { decimals: 2 })                // '1.23亿'；万亿/亿/万，9999.6 → '1万'
percent(0.1234, { decimals: 1 })               // '12.3%'，输入是比例
fixed(-0.0001, 2)                              // '0.00'（不出 '-0.00'）
const fmt = formatter('cjk', { decimals: 1, trim: true });   // 参数不全在建时就抛错
```

数字随 t 插值时每帧格式化一次即可（纯函数）。代价：位数变化时字符串宽度跳动，标签跟着条末端走时会抖；
要稳就用等宽数字字形（film-typography 的字体选择）或右对齐。`decimals` 越大，插值中的数字越像在"乱跳"，观众读不出任何一个值。

## 3. 序列几何

```js
const pts = data.map((d) => [x(d.t), y(d.v)]);
const cmds = curvePath(pts, 'monotone');                       // 'linear' | 'step' | 'stepBefore' | 'stepAfter' | 'monotone'
traceCurve(ctx, cmds); ctx.stroke();                           // 只 moveTo/lineTo/bezierCurveTo
const poly = curvePoints(pts, 'monotone', { samples: 12 });    // 折线（生长、面积、弧长都在折线上算）
traceCurve(ctx, areaPoints(poly, y(0)), { close: true }); ctx.fill();
const layers = stack(rows, ['a', 'b', 'c'], { offset: 'zero' });   // [{ key, points: [[y0, y1], …] }]；expand | diverging | silhouette
const arcs = pie(values, { start: -Math.PI / 2, end: 1.5 * Math.PI, pad: 0.01 });   // [{ a0, a1, mid }]，按输入顺序
arcPoints(cx, cy, r0, r1, a.a0, a.a1, { step: Math.PI / 90 });  // 扇区多边形；r0 > 0 是环
bin(values, { domain: [0, 100], thresholds: 10 });             // [{ x0, x1, count, values }]
```

- **monotone 的适用条件**：x 严格递增（否则抛错）。它保证单调的数据画出来也单调、平台段保持水平、不越过相邻点的值域。实测：
  [0,0,10,10.5,10.5,30,30] 采 32 点/段，0 处回退、最大值不超过 30。代价是它在拐点处比 Catmull–Rom 之类更"硬"；
  数据本身有噪声时，平滑后的曲线会让观众以为趋势是连续的，那是在替数据说话。
- step 系列表示"值在两次采样之间不变"（利率、价格档位）；用它画连续量，观众会读成突变。
- `stack` 的层序就是 keys 的顺序。`silhouette`（河流图）中线居中，代价是每一层都没有平直的基线，观众读不出单层的绝对值。
- `pie` 不排序。按值排序更好比大小，代价是跨时刻比较时同一扇区会换位置。

## 4. 随 t 变化的数据

这是静态图表库没有的部分：给定 t，直接得到那一帧的数值与位置。

### 4a. 关键帧插值 `keyframes`

```js
const K = keyframes([{ t: 0, values: { a: 10, b: 3 } }, { t: 2, values: { a: 20 } }, { t: 4, values: { a: 5, b: 9 } }],
                    { ease: EASE.cubic.inOut });   // 线性 p => p；阶梯 p => 0（到下一关键帧才跳）
K.at(t)        // { a, b }；某帧缺键时在包含它的前后两帧之间插值，首末之外保持边上的值
```

关键帧的 t 可以直接写旁白时间戳（`vo.at('翻倍')`）。ease 作用在每段内部；分段缓动会让值在每个关键帧处减速，
数据点多时读起来像"一顿一顿"，那是缓动的代价，线性插值没有这个问题但起止生硬。

### 4b. 柱状图竞赛 `barRace`

```js
const R = barRace(frames, { top: 10, ease: (p) => p, swap: { duration: 0.6, ease: EASE.cubic.inOut }, fade: 1, fill: 0 });
const band = scaleBand({ domain: 10, range: [y0, y1], paddingInner: 0.2, paddingOuter: 0 });
for (const it of R.at(t)) {            // [{ key, value, pos, rank, alpha }]，按 pos 排好
  ctx.globalAlpha = it.alpha;
  ctx.fillRect(x(0), band.at(it.pos), x(it.value) - x(0), band.bandwidth);
}
const xNow = scaleLinear({ domain: [0, R.maxAt(t)], range: [x0, x1] });   // 轴随最大值连续伸缩
```

- **名次怎么连续**：名次由当前插值值实时决定；加载期以 `resolution`（默认 1/240 s）扫出每次交换并二分出值相等的时刻，
  每次交换在 `duration` 秒内由 `swap.ease` 走完，交换点位于窗口的 `align` 处（默认 0.5）。两条交换的位置之和恒定，在窗口中点正好擦肩。
  实测（ease 用 smoothstep、duration 0.8、30 fps）：相邻两帧位置差最大 0.0624 名次，上界 1.5/(duration·fps) = 0.0625；所有条目的 pos 之和逐帧不变。
- **`swap: 'keyframe'`**：只在关键帧上排名、整段 lerp。交换跨整段慢慢完成，代价是中途名次与长度对不上（短条暂时排在长条上面）。
- **Top-N 截断**：`alpha = sat((top − pos) / fade)`，条目越过第 top 名时连续淡出，pos 也继续往下走；画面裁剪归你（出榜的条会滑出图区）。
- **代价：交换密集时可读性**。20 条正弦数据 30 s 扫出 1084 次交换，平均每秒 36 次；观众跟不上任何一条。
  缓解的办法各有代价：加大 `duration`（交换更柔，但名次滞后于值更久）、关键帧更稀（数据失真）、减小 top（看到的少）。
- 建表开销：20 条 × 30 s × 240 Hz 扫描 45–67 ms（Chromium / Node，高负载机器中位数），加载期一次；`at(t)` 每帧约 6–8 µs。
- 缺数据：某帧缺某名时必须给 `fill`（通常 0），否则抛错并点名是哪一帧哪一名。不默认补 0 是因为"没有数据"和"值为 0"在故事里意思不同。

### 4c. 折线生长 `lineGrower`

```js
const G = lineGrower(curvePoints(pts, 'monotone', { samples: 12 }));   // 加载期
const g = G.at(p, 'x');                 // 'x'：末端按 x 匀速推进（时间轴图）；'length'：按弧长匀速（路线、轨迹）
traceCurve(ctx, g.points); ctx.stroke();
ctx.arc(g.end[0], g.end[1], r, 0, 2 * Math.PI);   // g.angle 是末段朝向；镜头可以跟 g.end
```

按 x 推进时陡坡段的笔尖会变快（同样的 x 位移对应更长的弧）；按弧长推进则时间轴上的日期变成非匀速。看观众该读的是时间还是形状。

### 4d. 轴刻度随域变化 `axisTicks`

```js
const s = scaleLinear({ domain: [0, R.maxAt(t)], range: [x0, x1] });
for (const tk of axisTicks(s, 5, { blend: 0.15, edge: 30 })) { ctx.globalAlpha = tk.alpha; /* 在 tk.pos 画刻度线和标签 */ }
```

它是比例尺的纯函数：域随 t 连续变化，每个刻度的 pos 与 alpha 就连续。`blend`（log10 单位）是 1→2→5→10 档之间交叉淡化的宽度：
刻度的 alpha 是它所属各档的权重之和，所以两档共有的刻度（20 档与 50 档里的 100）始终不透明，只有一档独有的刻度淡入淡出。
`edge`（像素）让域外刚进来的刻度从 0 淡入；域端点上的刻度（比如 0）始终是 1。
实测域 10 倍连续增长、600 帧：相邻帧 alpha 最大变化 0.080，位置最大变化 3.2 px，任何时刻至少 2 个全不透明刻度。
`blend` 越小换档越干脆但越像跳变；越大同时可见的刻度越多、标签越容易挤。只支持 linear / pow。

## 5. 地理

不内置任何地图数据：GeoJSON 由片子自带（来源与授权归 film-assets）。

```js
let P = projection('orthographic', { rotate: [-lon0, -lat0] });   // 'equirectangular' | 'mercator' | 'orthographic' | 'albers'（parallels 必给）
P = fit(P, geojson, [x, y, w, h]);                                 // 等比装进矩形、居中
for (const s of geoShapes(P, geojson, { densify: 2 })) {           // polygon: rings（填充用 'evenodd' 挖洞）| line: parts | point: points
  ctx.beginPath(); for (const r of s.rings ?? []) traceCurve(ctx, r, { close: true }); ctx.fill('evenodd');
}
const gc = greatCircle([116.4, 39.9], [-0.13, 51.5]);              // gc.distance（弧度）、gc.at(p)
const route = projectLine(P, gc.points(64, progress), { densify: 0 }).parts;   // 末端 = P.project(gc.at(progress))
```

- **rotate 语义同 d3**：把 (lon, lat) 放到画面中心写 `rotate: [−lon, −lat]`。地球自转动画就是让 rotate[0] 随 t 变；每帧重算 `geoShapes`，
  2000 点的环在正射投影（含裁剪）下 0.6–1.8 ms，墨卡托 0.3–0.8 ms。
- **orthographic 背面剔除**：`P.project` 对背面返回 null；`geoShapes` 把多边形按地平线切开，背面那段沿地平线圆补弧重新闭合，线切成多段。
  `densify`（度）把每条边按大圆细分：不细分时长边在球面上是弦，会穿进球体内侧，也会让裁剪点不准。
- **mercator 高纬变形**：实测 60°N 的 1°×1° 格子投影面积是赤道的 2.03 倍，而球面上只有 0.49 倍：面积放大约 4 倍（1/cos²φ）。
  比较各国大小、讲人口密度时，这个放大会被观众当成事实；用 albers（等积，实测格子面积比与球面比相差 < 0.2%）或 equirectangular 换取正确面积，代价是形状变形。
  mercator 在 ±85.0511° 截断（`clipLat` 可改）。
- **跨日界线**：圆柱投影（equirectangular / mercator）不把跨 ±180° 的环折回，而是继续往外展开（`crosses: true`）。
  画法：裁到 `P.worldRect()`，平移 `±period` 再画一遍。绕极点的环（南极洲那类）自动沿极纬补边闭合。
- 大圆航线北拱：北京—伦敦中点纬度高于两端（实测距离 8142 km，中点约 62.5°N）。在墨卡托上它是弧线，观众可能读成"绕路"，要不要解释由片子决定。

## 6. 关系图

力导向是有状态仿真，不能在 seek 里迭代（门 2 乱序求值会抓到）。在加载期跑完、seek 里查表：

```js
const G = forceLayout(nodes, links, { seed: 11, iterations: 300, distance: 30, charge: -60, record: 5 });
const F = fitPoints(G.nodes, [x, y, w, h]);           // 等比缩放居中
const pos = G.at(300 * p).map((n) => F.map(n));       // "布局展开"：按迭代步插值，不是按时钟
// 终态：G.nodes / G.position(id)；钉住节点：{ id, fx, fy }
```

- 语义照 d3-force（速度 Verlet、alpha 从 1 衰减到 `alphaMin` 恰好用完 `iterations` 步、连线强度 1/min(度)）。
  `seed` 只决定初始叶序螺旋的起始角和重合点的微扰；同种子两次结果逐位相同，Node 与 Chromium 逐位相同。
- **迭代次数与耗时**（300 步，斥力是精确两两求和 O(n²)，高负载机器中位数，Node / Chromium）：n=50 约 2–3 ms，n=200 约 28–40 ms，
  n=500 约 150–230 ms，n=1000 约 580–870 ms。几百个节点以内在页面加载时跑完即可；上千个节点会拖慢每个渲染页面的启动
  （并行渲染时每个 worker 各跑一遍），这时在 Node 里离线算好写成 JSON 随片带（逐位一致保证和浏览器里算的一样）。
- 收敛判据：返回的 `movement` 是末步平均位移；实测 60 节点树 300 步末步 < 0.05。迭代太少，布局还在"呼吸"就停了，展开动画的最后一帧会显得没站稳。
- 展开动画按迭代步插值（`record` 越小越细，内存 = 帧数 × 2n 个双精度）。早期迭代变化剧烈，线性映射 t → 步数会前快后慢，
  要匀速感就给 p 一条先慢后快的映射，代价是开头几帧节点挤在一起读不出结构。

## 7. 跨引擎一致与 dmath

ECMAScript 不要求 `Math.sin/cos/atan2/log/exp/pow` 正确舍入。实测 Node 22.23 与 Chromium 156 的 V8 在 4000 个输入上有 2.5–17% 差 1 ULP，
连 `10 ** 整数` 都有 3% 不同；力导向 300 步后差异放大到 1e-13。所以 chart.js 不用它们：内部的 `dmath` 只用 IEEE 规定正确舍入的四则运算和 sqrt
（多项式系数照 fdlibm），对照 Math 误差 ≤ 2 ULP（pow 走 exp(e·log b) ≤ 5 ULP），输出在 Node 与浏览器逐位相同。

```js
import { dmath } from './runtime/chart.js';   // sin cos tan sincos atan atan2 asin log exp log10 log2 pow hypot pow10
```

只在"Node 里的检查脚本要和浏览器里画的是同一组数"时才需要它；单纯画图用 Math 也满足 seek 契约（同一浏览器内确定）。代价是 sin 约慢 1.4–1.8 倍（10 万次 2.2 ms vs 1.2–1.6 ms）。

## 8. 局限（没解决的）

- `axisTicks` 只支持 linear / pow；log 与时间轴的刻度换档会跳变（时间刻度可以用 `ticks` 自己按 `.unit` 做淡化）。
- 球面裁剪按"走地平线的短弧"补边：一个包住整个可见半球边缘的多边形（比如整片海洋）会补错方向。albers 不裁剪背面经线，只适合区域图。
- 斥力没有 Barnes–Hut 近似，n 上千时只能离线算。碰撞是简化版（只推开速度），节点大小差异很大时会有重叠。
- `barRace` 的交换扫描分辨率之内连续两次交换会并成一次；同一名次同时被多次交换时位置是各次过渡的线性叠加。
