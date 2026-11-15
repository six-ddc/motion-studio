# fxchain：一个 context 里的多 pass 与可 seek 的帧间反馈

目录：1 什么时候用 · 2 多 pass 接法与浮点目标 · 3 帧间反馈（定步重放 + 检查点） · 4 反馈的代价 · 5 验收与没做的

运行时 `assets/runtime/fxchain.js`（只 import 本 skill 的 `webfx.js`，零依赖，只支持 WebGL2）。耗时都是 SwiftShader、本仓库实测。可跑的例子：仓库夹具 `tests/fixtures/_test-fxchain`（不随安装）。

## 1. 什么时候用

| 需求 | 用什么 | 为什么 |
|---|---|---|
| 一遍着色器 | `webfx.js` 的 `createShaderLayer` | 最简单，WebGL1/2 都行 |
| 单遍，但想让漏传参数直接报错 | `createPass(o)` | 同形接口，缺 uniform 抛错 |
| 两遍以上（泛光、halation、拉丝、分离模糊） | `createChain({ passes })` | 中间结果留在 FBO，不经 2D 中转：4 遍全分辨率模糊 54 ms，经 2D 中转 83.6 ms |
| 中间结果超出 [0,1] | 目标 `format:'rgba16f'` / `'rgba32f'` | 8 位目标会截断，泛光阈值只能 < 1 |
| 这一帧取决于上一帧 | `createChain({ feedback })` | 定步重放 + 检查点，任意 seek 结果只取决于 t |

## 2. 多 pass 接法与浮点目标

```js
import { createChain, HEADER } from './runtime/fxchain.js';
const chain = createChain({ width: L.width, height: L.height, seed: 5, passes: [
  { name: 'ex',  out: 'ex', scale: 0.5,  format: 'rgba16f', frag: HEADER + EXTRACT, in: { u_src: 'src' } },
  { name: 'bh',  out: 'bh', scale: 0.25, format: 'rgba16f', frag: HEADER + BLUR,    in: { u_src: 'ex' }, uniforms: { u_dir: [2, 0] } },
  { name: 'bv',  out: 'bv', scale: 0.25, format: 'rgba16f', frag: HEADER + BLUR,    in: { u_src: 'bh' }, uniforms: { u_dir: [0, 2] } },
  { name: 'mix', out: 'screen',                             frag: HEADER + MIX,     in: { u_src: 'src', u_glow: 'bv' } },
] });   // EXTRACT / BLUR / MIX 是片子自己写的 GLSL 主体（原理见 post.md §3）
window.seek = (t) => {
  paint2d(t);
  chain.texture('src', canvas2d);   // 每帧重画的 2D 层每帧上传（约 2 ms）
  chain.render(t, { ex: { u_thresh: …, u_knee: … }, mix: { u_amount: … } });
  chain.drawTo(ctx);
};
```

- **pass 字段**：`name`、`frag`（以 `#version 300 es` 开头，拼 `HEADER`）、`out`（`'screen'` 或目标名）、`scale`（可写 `[sx, sy]` 做扁目标）、`format`、`filter`、`wrap`、`in`（`{ sampler: 来源名 }`）、`uniforms`（加载期常量）。
- **来源名**按顺序查：反馈名 → pass 目标名 → `texture()` / `data()` / `lut()` 建过的名字。每个输入另自动传 `<sampler>_size`（vec2 像素）。
- **顺序就是执行顺序**。读一个本次 render 还没写过的目标会抛错（那张纹理装的是上一帧）；pass 读写同一目标也抛错，要读上一帧的自己就写成 feedback。
- **render(t, u)**：值是普通对象的键只给同名 pass；其余键给所有声明了它的 pass。`u_time`（`period>0` 时取模）、`u_res`、`u_seed` 自动传。**着色器里实际用到的非内置 uniform 这一帧没给就抛错并列出名字**：缺省成上一帧的值是跨帧状态，缺省成"默认值"是替片子做审美决定。
- 其余 API：`drawTo`、`texture(name, src, {static, key, filter, wrap})`（缓存语义同 webfx，同受 `WEBFX_NOCACHE` 控制、同过 texcache 门）、`data(name, {width,height,data,format})`、`lut(name, parseCube(text))`、`pixels(name?)`、`finish()`、`stats()`、`caps`、`formats`、`stepAt(name, t)`。
- 每条链一个 WebGL2 context，Chromium 每页 context 上限约 16：宫格类画面把各格写进同一条链的不同目标，最后一个 pass 拼起来。

| format | 一像素 | 需要 | 适合 |
|---|---|---|---|
| `rgba8` | 4 B | 无 | 只在 [0,1] 的中间结果；多次叠加的泛光会出带状 |
| `rgba16f` | 8 B | `EXT_color_buffer_half_float` 或 `_float` | HDR 亮部、模糊链、有衰减的反馈。11 位尾数：值近 1 时步长约 5e-4，更小的增量被舍掉 |
| `rgba32f` | 16 B | `EXT_color_buffer_float`；线性过滤另要 `OES_texture_float_linear` | 每步增量很小的仿真（Gray-Scott） |

本机 SwiftShader 三种都可渲染、32F 可线性过滤。不可用时默认**抛错**；传 `floatFallback:'rgba8'` 才降级（记在 `chain.formats[名].note`），代价：HDR 截到 [0,1]，反应扩散停住不长。同 270×240 的 Gray-Scott，rgba16f 每步 1.10 ms、rgba32f 0.58 ms：半精度在 SwiftShader 下要转换，反而更慢。

## 3. 帧间反馈（定步重放 + 检查点）

```js
const chain = createChain({ width, height, seed: 3, feedback: [{
  name: 'rd', scale: [0.25, 0.125], format: 'rgba32f', filter: 'linear', wrap: 'repeat',
  rate: 30, substeps: 8,          // 每仿真秒 30 个查询点 × 8 步 → dt = 1/240 s
  every: 1,                       // 每 1 仿真秒存一张检查点
  init: HEADER + INIT,            // 第 0 步；不给 = 全 0
  frag: HEADER + STEP,            // 第 k 步 = step(第 k−1 步)，读 u_prev
  uniforms: (k, s) => ({ … }),    // 第 k 步的参数，只能是 k / s = k·dt 的函数
}], passes: [{ name: 'show', out: 'screen', in: { u_state: 'rd' }, frag: … }] });
```

**定义**：`render(t)` 用的状态是 S(n)，n = round(time(t)·rate)·substeps，S(0) = init，S(k) = step(S(k−1))。步长固定，与影片 fps 无关。实现只是这个定义的加速：
- 往前 seek 从当前步接着走；往回 seek 从 ≤ n 的最近检查点逐位拷回再走到 n；冷启动（新页面、每个并行 worker 的第一帧）从 0 走到 n，O(n)。
- `maxCheckpoints`：超过就把间隔翻倍、丢掉不在新间隔上的检查点（第 0 步永远留）。每张都是 S(k) 的逐位副本，只影响重放快慢，不影响像素。
- `time: (t) => 仿真秒`：快进、慢放、定格改这个映射（思路见 film-physics 的时间映射），必须是 t 的纯函数。

**step 能读什么**（违反任何一条，乱序求值就和顺序不同）：`u_prev`、内置 `u_time`（= k·dt）、`u_step`、`u_dt`、`u_res`、`u_seed`；`uniforms(k, s)` 的返回值（笔尖轨迹、注入源位置都写成 s 的闭式函数）；加载期确定的纹理（`static` / `key` / `data()` / `lut()`）。读每帧上传的纹理、pass 目标、另一路反馈都**直接抛错**。随机用 `hash(gl_FragCoord.xy + u_step + u_seed)`。
一路反馈的全部状态就是一张 RGBA；要更多通道，把两路合进一张，或让第二路只读第一路的加载期结果。

**常见 step 的原理**：
- **Gray-Scott 反应扩散**：A、B 两种浓度存 r、g。9 点拉普拉斯（中心 −1、四邻 0.2、四角 0.05），`A += dt·(Da·∇²A − AB² + F(1−A))`，`B += dt·(Db·∇²B + AB² − (k+F)B)`。F、k 的取值决定斑点/条纹/迷宫；dt 太大会发散（降 substeps 前先试稳定性）。需要 rgba32f。
- **墨晕 / 拖影**：上一步状态沿 curl 流场平流（`uv − vel·flow`）、和四邻平均按 bleed 混、乘 decay 衰减，再在笔尖处盖上新墨。decay=1、flow=0、bleed=0 就是永不消失的纯拖影。rgba16f 够用。
- **元胞自动机**（生命游戏等）：texelFetch 读 8 邻，`filter:'nearest'`，rgba8 即可。

**循环片**：反馈不周期，S(n_D) ≠ S(0)，门 3 会红。要循环只能在 D 处淡回一个与状态无关的画面，或预烘焙一个周期再交叉淡化（都没实现）。

## 4. 反馈的代价

| 状态 | 每步 |
|---|---:|
| 270×240 rgba32f，Gray-Scott 9 次取样 | 0.58 ms |
| 270×240 rgba16f，同上 | 1.10 ms |
| 540×960 rgba32f，同上 | 2.65 ms |
| 540×480 rgba16f，墨晕（4 次 vnoise3 + 5 次取样） | 2.73 ms |
| 1080×1920 rgba16f，墨晕 | 19.1 ms |
| 参照：64×64 一次取样的空步 | 0.19 ms（每步固定开销） |

- **冷启动**：每仿真秒 = rate·substeps × 每步。夹具（GS 240 步/s + 墨晕 30 步/s）冷启动 seek 1 / 3 / 5 / 10 / 30 s 实测 0.40 / 0.74 / 1.12 / 2.12 / 5.95 s（线性）；顺序渲染的下一帧 17 ms。**每个并行 worker 第一帧都付一次冷启动**：N 个 worker 总重放量约 N/2 遍全片。
- **往回跳**：最多 every 秒的步数（夹具回退半秒 107 ms）。
- **显存**：每张检查点 = 宽×高×每像素字节；夹具 10 s 时 22 张、合计 38.6 MB，30 s 时 62 张、97.9 MB。长片把 every 拉大或设 `maxCheckpoints`，代价是往回跳更慢。
- 降成本顺序：降状态分辨率（显示 pass 线性放大）> 降 substeps（反应扩散类会失稳）> 只在关键段开反馈（其余时间显示与状态无关的画面）。
- 负载高时（1 分钟负载 40 左右）同样的数慢 2–5 倍。

## 5. 验收与没做的

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> --parallel 4     # 门 1a/1b/2 + 门 4
node <film-webfx>/scripts/fxreplay-check.mjs --film <slug>           # 有反馈时：缓存版（顺序/倒序/乱序）vs 每次从第 0 步算
node <film-webfx>/scripts/texcache-check.mjs --film <slug>           # 用了 texture() 的 static/key 时
```

`fxreplay-check` 的参照是定义本身：加载前设 `globalThis.FXCHAIN_NOCACHE = true`，每次 render 都从 init 走到 n；三个新页面分别按顺序、倒序、乱序截图逐张比。夹具阴性对照（往回跳不重放、检查点存引用）在 seamcheck 里只有门 2 红，在这道门里顺序那遍通过、倒序 11/12、乱序 9–10/12 红。

没做的：MRT、多重采样目标、mipmap 目标；反馈 step 每步读一张随时间变化的 2D 画面（"文字慢慢洇开"，要在重放时按步号重画上传，冷启动成本翻倍以上）；冷启动成本跨 worker 共享；Metal 后端和跨机器的逐位一致性没测。
