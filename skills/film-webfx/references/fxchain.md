# fxchain：一个 context 里的多 pass 管线与可 seek 的帧间反馈

目录：1 什么时候用它 · 2 多 pass 接法 · 3 浮点目标与降级 · 4 帧间反馈（定步重放 + 检查点） · 5 反馈的代价 · 6 每帧全量传参 · 7 验收 · 8 没做的

运行时 `assets/runtime/fxchain.js`（只 import 本 skill 的 `webfx.js` 拿 GLSL 片段，零依赖，只支持 WebGL2），GLSL 片段在 `assets/runtime/fxglsl.js`（`STYLIZE` / `FEEDBACK`，见 `stylize.md`）。
耗时都是 SwiftShader、本仓库实测（数字与测法在仓库 docs/verified/film-webfx.md「fxchain」一节）。完整可跑的例子：夹具 `tests/fixtures/_test-fxchain`（仓库内，不随安装）。

## 1. 什么时候用它

| 需求 | 用什么 | 为什么 |
|---|---|---|
| 一遍着色器就够 | `webfx.js` 的 `createShaderLayer` | 最简单，WebGL1/2 都行 |
| 单遍，但想让"漏传参数"直接报错 | `createPass(o)`（fxchain 的单 pass 封装） | 同形接口，缺 uniform 抛错（§6） |
| 两遍以上串起来（泛光、halation、拉丝、分离模糊） | `createChain({ passes })` | 中间结果留在 FBO 里，不经 2D 中转：4 遍全分辨率 blur9 实测 54 ms，用 4 个 `createShaderLayer` 经 2D 中转是 83.6 ms（540×960：13.8 vs 22.5 ms） |
| 中间结果要超出 [0,1]（HDR 亮部、累加） | 目标 `format:'rgba16f'` / `'rgba32f'` | 8 位目标会截断，泛光阈值只能 < 1 |
| 这一帧取决于上一帧（反应扩散、流体、拖影、墨晕、生命游戏） | `createChain({ feedback })` | 只有它做定步重放 + 检查点，任意 seek 结果只取决于 t |

## 2. 多 pass 接法

```js
import { createChain, HEADER } from './runtime/fxchain.js';
import { STYLIZE } from './runtime/fxglsl.js';

const chain = createChain({ width: L.width, height: L.height, seed: 5, passes: [
  { name: 'ex', out: 'ex', scale: 0.5,  format: 'rgba16f', frag: HEADER + STYLIZE.extract, in: { u_src: 'src' } },
  { name: 'dn', out: 'dn', scale: 0.25, format: 'rgba16f', frag: HEADER + STYLIZE.down4,   in: { u_src: 'ex' } },
  { name: 'bh', out: 'bh', scale: 0.25, format: 'rgba16f', frag: HEADER + STYLIZE.blur9,   in: { u_src: 'dn' }, uniforms: { u_dir: [2, 0] } },
  { name: 'bv', out: 'bv', scale: 0.25, format: 'rgba16f', frag: HEADER + STYLIZE.blur9,   in: { u_src: 'bh' }, uniforms: { u_dir: [0, 2] } },
  { name: 'mix', out: 'screen',                             frag: HEADER + STYLIZE.glow_mix, in: { u_src: 'src', u_glow: 'bv', u_mask: 'ex' } },
] });

window.seek = (t) => {
  paint2d(t);
  chain.texture('src', canvas2d);            // 每帧重画的 2D 层：每帧上传（约 2 ms @1080×1920）
  chain.render(t, { ex: { u_thresh: …, u_knee: … }, mix: { u_tint: […], u_amount: …, u_ring: 0, u_mono: 0 } });
  chain.drawTo(ctx);
};
```

- **pass 字段**：`name`（唯一）、`frag`（以 `#version 300 es` 开头，拼 `HEADER`）、`out`（`'screen'` 或目标名）、`scale`（相对 width/height，可写 `[sx, sy]` 做扁目标，拉丝就靠它）、`format`、`filter`、`wrap`、`in`（`{ sampler 名: 来源名 }`）、`uniforms`（加载期常量）。
- **来源名**按顺序查：反馈名 → pass 目标名 → `texture()` / `data()` / `lut()` 建过的名字。每个输入另自动传 `<sampler>_size`（vec2，像素），`down4` 靠它。
- **顺序就是执行顺序**。读一个本次 render 里还没写过的目标会抛错，因为那张纹理装的是上一帧的结果（跨帧状态）；pass 读写同一个目标也抛错，要"读上一帧的自己"就写成 feedback。
- **render(t, u)**：`u` 里键是 pass 名、值是普通对象的，只给那个 pass；其余键给所有声明了它的 pass。`u_time`（`period>0` 时取模）、`u_res`（本 pass 输出尺寸）、`u_seed` 自动传。
- 其余 API：`drawTo(ctx, {x,y,width,height,smoothing})`、`texture(name, src, {static, key, filter, wrap})`（缓存语义与 webfx 的 `texture()` 相同，同受 `WEBFX_NOCACHE` 控制、同过 texcache 门）、`data(name, {width,height,data,format})`（浮点数据纹理，加载期建）、`lut(name, parseCube(text))`（3D LUT）、`pixels(name?)`（读回目标，浮点目标给 Float32Array）、`finish()`、`stats()`、`caps`、`formats`、`stepAt(name, t)`。
- 同一页面开多条链时每条一个 WebGL2 context。Chromium 每页 context 数有上限（16 左右），所以宫格类画面把各格写进同一条链的不同目标、最后一个 pass 拼起来（夹具 `scene-stylize.html` 就是 12 格一条链）。

## 3. 浮点目标与降级

| format | 一个像素 | 需要 | 适合 |
|---|---|---|---|
| `rgba8` | 4 B | 无 | 只在 [0,1] 内的中间结果；8 位截断会让多次叠加的泛光出带状 |
| `rgba16f` | 8 B | `EXT_color_buffer_half_float` 或 `EXT_color_buffer_float` | HDR 亮部、模糊链、墨晕这类有衰减的反馈。11 位尾数：值接近 1 时步长约 5e-4，更小的增量会被舍掉 |
| `rgba32f` | 16 B | `EXT_color_buffer_float`；线性过滤另要 `OES_texture_float_linear` | 每步增量很小的仿真（Gray-Scott） |

本机 SwiftShader 三种都可渲染、32F 可线性过滤。不可用时默认**抛错**并说明缺哪个扩展；传 `floatFallback:'rgba8'` 才降级，降级记在 `chain.formats[名字].note`。降级的代价要自己判断：HDR 截到 [0,1]，反应扩散会停住不长（这是数值问题，不是画风）。
同 270×240 的 Gray-Scott，rgba16f 实测每步 1.10 ms、rgba32f 0.58 ms：半精度在 SwiftShader 下要转换，反而更慢。

## 4. 帧间反馈（定步重放 + 检查点）

```js
const chain = createChain({ width, height, seed: 3, feedback: [{
  name: 'rd', scale: [0.25, 0.125], format: 'rgba32f', filter: 'linear', wrap: 'repeat',
  rate: 30, substeps: 8,          // 每仿真秒 30 个查询点，每点 8 步 → dt = 1/240 s
  every: 1,                       // 每 1 仿真秒存一张检查点
  init: HEADER + GLSL.hash + FEEDBACK.gs_init,   // 第 0 步；不给 = 全 0
  frag: HEADER + GLSL.hash + FEEDBACK.gs_step,   // 第 k 步 = step(第 k−1 步)，读 u_prev
  uniforms: (k, s) => ({ … }),    // 第 k 步的参数，只能是 k / s = k·dt 的函数
}], passes: [{ name: 'show', out: 'screen', in: { u_state: 'rd' }, frag: … }] });
```

**定义**：`render(t)` 用的状态是 S(n)，n = round(time(t)·rate)·substeps，S(0) = init，S(k) = step(S(k−1))。步长固定，与影片 fps 无关；改 fps 不改仿真，只改取哪些 n。
**实现只是这个定义的加速**：

- 往前 seek：从当前步接着走。顺序渲染时每帧只走 rate·substeps/fps 步。
- 往回 seek：从 ≤ n 的最近检查点拷回（texelFetch 逐位拷贝），再走到 n。检查点在第一次经过 every 的整数倍时存，所以回退最多走 every 步。
- 冷启动（全新页面、并行渲染的每个 worker 的第一帧）：从第 0 步走到 n，O(n)。
- `maxCheckpoints`：超过就把间隔翻倍、丢掉不在新间隔上的检查点（第 0 步永远留）。留下哪些取决于走过哪些步，但每张都是 S(k) 的逐位副本，所以只影响重放快慢，不影响像素。
- `time: (t) => 仿真秒`：快进、慢放、定格就改这个映射（参见 `film-physics/references/timemap.md` 的思路），必须是 t 的纯函数。

**step 能读什么**（违反任何一条，乱序求值就和顺序求值不同）：
1. `u_prev`（上一步状态）、内置 `u_time`（= 仿真秒 k·dt）、`u_step`（= k）、`u_dt`、`u_res`、`u_seed`。
2. `uniforms(k, s)` 的返回值。笔尖轨迹、注入源的位置都写成 s 的闭式函数。
3. 加载期确定的纹理：`texture(…, {static:true})` / `{key}`、`data()`、`lut()`。
读每帧上传的纹理、读 pass 目标、读另一路反馈都会**直接抛错**：重放第 k 步时它们装的是"这次 seek 的 t"的内容。render 的 uniform 根本不会传给 step。
随机数用 hash（`hash12(gl_FragCoord.xy + u_step + u_seed)`），别在 JS 里用顺序推进的生成器喂 step。

**一路反馈存几样东西**：一张 RGBA 就是全部状态。需要更多通道时开第二路反馈也不能互读（会抛错）——把两路合进一张 RGBA，或者把第二路写成只读第一路"加载期结果"的东西。

**循环片**：反馈不周期，S(n_D) ≠ S(0)，门 3 会红。要循环只能让画面在 D 处淡回一个与状态无关的画面，或者预烘焙一个周期再交叉淡化（都没在本 skill 里实现）。

## 5. 反馈的代价

实测（16 线程 M3 Max、SwiftShader，1 分钟负载 3–8；负载 40 左右时同样的数慢 2–5 倍）：

| 状态 | 每步 |
|---|---:|
| 270×240 rgba32f，Gray-Scott 9 次取样 | 0.58 ms |
| 270×240 rgba16f，同上 | 1.10 ms |
| 540×960 rgba32f，同上 | 2.65 ms |
| 540×480 rgba16f，墨晕（4 次 vnoise3 + 5 次取样） | 2.73 ms |
| 1080×1920 rgba16f，墨晕 | 19.1 ms |
| 参照：64×64 只做一次取样的空步 | 0.19 ms（每步的固定开销） |

- **冷启动**：每仿真秒成本 = rate·substeps × 每步。夹具（GS 240 步/s + 墨晕 30 步/s）冷启动 seek 1 s / 3 s / 5 s / 10 s / 30 s 实测 0.40 / 0.74 / 1.12 / 2.12 / 5.95 s（约 0.2 s 每仿真秒，线性）；顺序渲染的下一帧 17 ms。**并行渲染的每个 worker 第一帧都要付一次冷启动**，所以 worker 越多、片子越长，这笔钱越多：N 个 worker 的总重放量约是 N/2 遍全片。
- **往回跳**：最多 every 秒的步数（夹具在 t=10/30 回退半秒 107 ms，跳回 0.2 s 48 ms）。
- **显存**：每张检查点 = 宽×高×每像素字节；夹具 10 s 时两路共 22 张检查点、全部目标合计 38.6 MB，30 s 时 62 张、97.9 MB。长片把 every 拉大或设 `maxCheckpoints`，代价是往回跳更慢。
- 降成本的顺序：降状态分辨率（显示 pass 用线性过滤放大）> 降 substeps（反应扩散类每步增量变大会失稳）> 关键帧附近才开反馈（其余时间显示与状态无关的画面）。

## 6. 每帧全量传参

GL 的 uniform 留着上一次设的值。少传一个 = 用上一帧的值，这是跨帧状态；补一个"默认值"是替片子做审美决定。所以 fxchain 在每次 render 时用反射核对：**着色器里实际用到的非内置、非 sampler uniform，这一帧没在 pass 的 `uniforms` 常量或 render 参数里出现，就抛错并列出名字**。数组 uniform 要传满声明长度。反馈 step 的参数同理，由 `uniforms(k, s)` 每步全量给出。
`createShaderLayer` 不做这个检查；用它跑 `fxglsl.js` 的模板时，自己保证每帧传满。

## 7. 验收

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> --parallel 4     # 门 1a/1b/2 + 门 4
node <film-webfx>/scripts/fxreplay-check.mjs --film <slug>           # 有反馈时：缓存版（顺序/倒序/乱序）vs 每次从第 0 步算
node <film-webfx>/scripts/texcache-check.mjs --film <slug>           # 用了 texture() 的 static/key 时
```

`fxreplay-check` 的参照是定义本身：加载前设 `globalThis.FXCHAIN_NOCACHE = true`，不存检查点、每次 render 都从 init 走到 n。三个全新页面分别按顺序、倒序、乱序截图，逐张和参照比。夹具阴性对照（`leak:'noreplay'` 往回跳不重放、`leak:'ref'` 检查点存引用）在 seamcheck 里都只有门 2 红，在这道门里顺序那一遍通过（两个 bug 都只在往回跳时出现），倒序 11/12、乱序 9–10/12 红，exit 1。
gates.json：加载了 `fxchain.js` 的片子在 `accept --deep` 里自动跑 `seam4`、`texcache`、`fxreplay`。

## 8. 没做的

- MRT（一个 pass 写多张目标）、多重采样目标、mipmap 目标：没有。
- 反馈 step 每步读一张随时间变化的 2D 画面（"文字慢慢洇开"）：没做。要做就得在重放时按步号重画并上传那张画面（每步约 2 ms 上传），代价是冷启动成本翻倍以上；现在只能把源写成 `uniforms(k, s)` 驱动的程序化形状。
- 冷启动的重放成本无法跨 worker 共享（每个页面各走一遍）；预烘焙状态序列没做。
- Metal 后端和跨机器的逐位一致性没测（webfx 的结论是同后端内一致）。
