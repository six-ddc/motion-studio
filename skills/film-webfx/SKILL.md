---
name: film-webfx
description: 代码渲染视频里决定"像素颜色、光影与立体空间"的那一层：WebGL/WebGL2 片元着色器（噪声、fbm、domain warp、流场、光线步进 SDF）、后期处理（泛光 bloom、色差、晕影、颗粒、景深、halation、拉丝、调色 LUT）、风格化（半调、像素化、勾线、Kuwahara、ASCII）、多 pass 管线与可 seek 帧间反馈（反应扩散、拖影、墨晕）、扭曲折射、SVG 滤镜与 canvas 混合/挖空，以及按帧契约驱动的 three.js 三维（PBR 打光、软阴影、三维运镜、GPU 闭式粒子、GLB 模型资产、世界文字可读性）。需要着色器、GLSL、辉光、颗粒、色散、水波、玻璃、墨晕、烟雾、后期调色、混合挖空、3D、three.js、景深、体积光、建模或评估渲染耗时时加载。
---

# film-webfx

负责**着色、后期与三维**：只给原理、在 `seek(t)` 下的难点、实测代价与基础设施，不给效果模板和默认风格。可选基础设施（在线挂载，按需 import，也可直接用原生 WebGL/Three.js）：`assets/runtime/webfx.js`、`assets/runtime/fxchain.js`、`assets/runtime/stage3d.js`、`assets/runtime/three-film.module.js` / `three-film.core.js`。

## 0. 性能与后端选型（实测：1080×1920）

默认软件渲染（SwiftShader，16 线程 CPU）单帧中位耗时 vs 硬件 GPU（`film.json` 写 `"backend": "gpu"`）：

| 档位 | 代表效果 | 1080×1920（软） | 540×960（软） | 说明 |
|---|---|---:|---:|---|
| T0–T1 | 调色/晕影/5 层 fbm 烟云 | 3.6–5.3 ms | 0.9–1.6 ms | 比 PNG 截图（~50ms）便宜 |
| T2 | 三重 domain warp / curl | 19–21 ms | 5.4 ms | 流体/墨流性价比高 |
| T3–T4 | 64 步 SDF / 25 采样模糊泛光 | 40–41 ms | 10.3 ms | 与截图同量级 |
| T5 | 重型地形步进 / Kuwahara r=4 | 144–156 ms | 36 ms | 建议降分辨率或开 GPU |
| Three.js PBR | 基准场景 / 软阴影 / 景深 | 8 / +5 / +78 ms | — | 后期直通 +11ms；MSAA +53ms |

**探索期建议**：重着色器或三维片在 `film.json` 设 `"backend": "gpu"`（Apple Metal 下全部档位 ≤5ms，整片快 3–10×），**不要为了省软件渲染时间放弃光影和质感**；代价仅是像素与软件后端不同、只能在同款显卡复现。软件后端降级顺序：降着色器 `scale: 0.5` → 减步数/层数 → 局部层渲染 → 静态层顶层预渲缓存。

## 1. 硬约束（违反即 bug）

1. **时间只从 uniform 传入**：着色器与 JS 不读墙钟/rAF；`render(t)` 同步完成后像素即可被 `drawImage` 取用。
2. **随机只用无 sin 哈希**：如 `GLSL.hash`（避免 `fract(sin(x)*43758.)` 跨后端精度漂移）；逐帧颗粒混入 `Math.round(t * fps)`。
3. **每种 context 独立 canvas**：同一 canvas 先取 `webgl` 再取 `webgl2` 返回 `null`。
4. **长片防 float32 抖动**：循环传 `period` 在 JS 侧 double 取模；高频相位在 JS 算完传入。
5. **一次渲染固定后端**：SwiftShader 同机跨进程逐位一致，与 Metal 不同。
6. **uniform 每帧全量传**：GL 保留上次值，漏传即跨帧状态（`fxchain.js` 反射核对缺则抛错）；数组 uniform 传满长度。
7. **纹理缓存键只跟内容走**：`texture(..., { static:true })` / `{ key }` 漏更内容时 seamcheck 照绿，需过 `texcache-check`。
8. **帧间反馈必须定步重放 + 检查点**：用 `fxchain.js` feedback，往回 seek 从检查点重放，不能拿双缓冲每次 seek 盲推一步。
9. **离屏目标不跨帧残留**：反射/深度/模糊/AO 等 RT 每次 seek 内按 `t` 重画；强度为 0 跳过时绑黑纹理或零权重。

## 2. 接入 `webfx.js`（示例）

```js
import { createShaderLayer, GLSL } from './runtime/webfx.js';
const fx = createShaderLayer({
  width: L.width, height: L.height, scale: 0.5, seed: 11, period: DURATION,
  frag: GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + `
uniform float u_period;
void main(){ vec2 p = v_uv * vec2(u_res.x/u_res.y, 1.) * 2.5 + u_seed;
  OUT = vec4(vec3(loopFbm(p, u_time / u_period, 0.7)), 1.); }`,
});
fx.render(0); // 预热 JIT（首帧编译 20–80ms）
window.seek = (t) => { fx.render(t, { u_period: DURATION }); fx.drawTo(ctx); };
```

API：`render(t, uniforms)`、`drawTo(ctx, opts)`、`texture(name, src, {filter, wrap, static, key, mipmap, anisotropy})`、`setUniform`、`pixels()`、`finish()`；GLSL 片段含 `header/header2/hash/ign/pcg/noise/loop`（`OUT`/`TEX` 兼容 WebGL1/2）。

## 3. 效果与选型速查

- **2D Canvas 足够**：渐变、晕影、`destination-out` 挖空、`lighter`/`screen` 叠加、`ctx.filter='blur()'`。
- **升 WebGL 的信号**：每个像素的颜色需由数学函数或偏移采样算出（fbm 烟云、domain warp 墨流、curl 流场、SDF、水波/玻璃置换、泛光/色差/颗粒/调色/风格化）。
- **SVG 滤镜**：直接作用 DOM/SVG 且确定，适合静态纸纹（`feTurbulence`）或低频扭曲，但无连续时间轴且画进 2D 慢（~96ms）。
- **Three.js 三维**：可选原生 three.js 或违约即抛错的 `three-film`（禁用 `Clock`/`Timer`/`setAnimationLoop`/`Math.random`/`compileAsync`）配 `stage3d.js`：
  - 保留式场景图每帧由 `S.frame(t, paint)` 复位到 `S.freeze()` 初始态（seek 内禁止 add/remove）；
  - 后期参数每帧全量传、粒子写成 `(i, seed, t)` 闭式、镜头不积分、锚点用渲染矩阵投影（`S.anchor`）；
  - 可选 `S.legible()` 测 3D 世界文字可读性（`checks` 声明 `legible`）。

## 4. 验收（用了才开）

```bash
node <film-core>/scripts/seamcheck.mjs --film <slug> --parallel 4
node <film-webfx>/scripts/texcache-check.mjs --film <slug>     # 用了 static/key 纹理缓存
node <film-webfx>/scripts/fxreplay-check.mjs --film <slug>     # 用了 fxchain feedback
```

`gates.json` 按 `uses` 自动触发 `seam4` / `texcache` / `fxreplay`。已知局限：WebGL1 非 2 的幂纹理配 `repeat`/`mirror` 全黑不报错；`static:true` 察觉不到源画布原地重画。

## 下层文档

`references/shaders.md`（噪声/流场/SDF/置换）· `references/post.md`（2D 后期/风格化/调色）· `references/fxchain.md`（多 pass/反馈重放）· `references/compositing.md`（合成/缓存/混合/SVG 滤镜）· `references/three.md`（three 契约/镜头/粒子/代价）· `references/three-post.md`（HDR 后期）· `references/three-world.md`（天空/雾/软阴影/材质/湿地面）· `references/models.md`（硬表面建模与 GLB 资产）
