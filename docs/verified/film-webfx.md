# film-webfx 验证记录

环境：macOS Darwin 25 / Apple M3 Max / 16 线程 / Playwright 1.64 / Chromium 156。
默认后端 renderer 字符串：`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)`。
所有原始输出存在 `tests/fixtures/_test-webfx/out/`。

## 1. seamcheck 三门（验收片 `tests/fixtures/_test-webfx/scene.html`）

片子内容：循环 domain-warp 墨场（半分辨率着色器）→ 离屏 2D → `destination-out` 挖圆孔 → 主画布；
2D 画的横线 → `texture()` 上传 → 置换着色器 → 主画布。两条合成方向都走一遍，4 s 一圈，loop:true。

```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-webfx
影片 _test-webfx  入口 scene.html  9x16 1080×1920  4s @ 30fps  采样 8 个时刻  loop=true
门 1a  同一页面，同一个 t 求两次：   8/8 ✓ 逐像素一致
门 2   乱序求值（种子 7 打乱）：     8/8 ✓ 逐像素一致
门 3   3a frame(0) vs frame(4): 逐像素一致
       3b 跨缝 frame(3.967)→frame(0): 1431951 像素变化；相邻帧典型 1436320 像素；容差 5745280
       ✓ 通过：首尾一致且跨缝无跳变
门 1b  全新页面重新加载：           8/8 ✓ 逐像素一致
探针   seek 期间调用的禁用 API：     ✓ 无
全部通过   (exit 0)
```

**反例对照**（证明门不是摆设）：`scene-bad-state.html` 只改一行——让 `u_time` 每次 seek 多累加 0.01：
```
$ node skills/film-motion/scripts/seamcheck.mjs --film _test-webfx --entry scene-bad-state.html
  t=0.000s  ✗ 1133806 像素不同，最大差 7/255   …8/8 ✗
  ✗ seek 不可重复：读了时钟/Math.random，或每次调用都在累积状态
```

seek 实测耗时：`seek()` 中位数 49.5 ms，`seek + 截图` 中位数 197 ms（含 Playwright 往返）。

## 2. 性能表（`node skills/film-webfx/scripts/bench.mjs`）

计时方法：`render(t)` 后 `gl.readPixels(0,0,1,1)` 强制等 SwiftShader 画完，5 帧取中位数；f = 首帧（含 JIT）。

```
档位                   1080×1920         540×960         270×480
t0_gradient       3.6 (f 34.6)    0.9 (f 18.9)    0.3 (f 18.1)
t1_fbm            5.3 (f 29.4)    1.6 (f 25.6)    0.5 (f 24.2)
t2_warp              21 (f 63)    5.4 (f 48.8)    1.5 (f 42.7)
t3_raymarch      40.3 (f 72.3)   10.3 (f 41.3)    2.6 (f 34.2)
t5_terrain     144.3 (f 149.9)     36.2 (f 58)      9.4 (f 34)
t4_blur25        40.9 (f 74.8)   10.4 (f 38.6)    2.9 (f 31.4)

合成开销 ms: webglToCanvas2d 5.2, halfResUpscale high 26.4 / medium 12.5 / low 6.3,
             canvas2dToTexture+chroma 9.0 vs chroma_only 6.9（→ 上传 ≈2.1）
截图 PNG 1080×1920 基线: 50 ms
```

对照 Metal 后端（`--gpu`，即 `--use-angle=metal`）：t0 0.8 / t1 1.2 / t2 2.9 / t3 1.8 / t5 5.2 / t4 1.0 ms。

**结论**：用户担心的"全屏着色器单帧 2 秒"不成立。最重的 T5 是 144 ms，T0–T2 比截图还便宜。
成本与像素数严格成正比（每降一档分辨率 ≈ ÷4）。20 s × 30 fps × 4 子帧 = 2400 次 seek，
T3 级场景约 4 分钟，T5 级约 8 分钟。
**注意**：这是 16 线程机器的数；SwiftShader 是多线程 CPU 光栅化，核数少的机器会按比例变慢——换机器先跑 `bench.mjs --quick`（≈6 秒）。

2D blur（`node skills/film-webfx/scripts/blur2d-check.mjs`）：
`{"blur4":15.8,"blur16":14.7,"blur48":16.6 ms (含 getImageData 1.8 ms), repeatable: true}`。

## 3. 浮点确定性（`bench.mjs` 的确定性段，全帧 SHA-256）

| 检查 | 结果 |
|---|---|
| 6 个档位：同页同 t 两次 | 全部 ✓ |
| 6 个档位：渲 9.9、0.1 后回到 2.5 | 全部 ✓ |
| 6 档位 + 6 模板：两次独立启动浏览器 | 12/12 ✓ |
| 同一着色器 WebGL1 vs WebGL2（270×480） | diffChannels 0 / 518400，maxDiff 0 |
| Metal 后端同样三项 | 全部 ✓（同后端内确定） |

**结论**：SwiftShader 在同一台机器上逐次、乱序、跨进程、跨 WebGL 版本都逐位一致。
seamcheck "同 t 可重复"没有障碍，skill 可用。
**未覆盖**：SwiftShader vs Metal 不一致（旧调研 2–35% 像素不同，本次未复测比例）；跨机器/跨 CPU 架构未测。

测试过程中的一次假阳性（已修，记下来防止再犯）：第一版 bench 在测"上传成本"时对源 canvas 逐帧
`fillRect`，污染了后面模板测试共用的源图，快测（3 帧）和全测（5 帧）污染程度不同 → 跨启动比对"不一致"。
不是 SwiftShader 不确定，是测试本身有跨步状态。改为在副本上测之后 12/12 一致。

## 4. 模板库（`bench.mjs` 的模板段，1080×1920）

| 模板 | 编译 | ms | 非零像素比 | 同 t 可重复 | 其它 |
|---|---|---:|---:|---|---|
| loop_fbm | ✓ | 9.7 | 1.0 | ✓ | **loopSeam ✓**（t=0 与 t=period 哈希相同） |
| curl_field | ✓ | 19.2 | 0.94 | ✓ | |
| displace | ✓ | 6.6 | 1.0 | ✓ | |
| chroma | ✓ | 7.1 | 1.0 | ✓ | |
| grade | ✓ | 6.3 | 1.0 | ✓ | |
| bright | ✓ | 4.1 | 0.239 | ✓ | 阈值后只剩亮部，符合预期 |

## 5. SVG 滤镜（`node skills/film-webfx/scripts/svgfilter-check.mjs`）

```
同参数两次截图一致: ✓
乱序 A→B→A 一致:   ✓
seed 改变输出:      ✓
小数 seed:          {"seed=1":"5409623ea753","seed=1.4":"5409623ea753","seed=1.6":"5409623ea753","seed=2":"6f147c5f00f5"}
seed=0 5409623ea753  seed=-1 6f147c5f00f5
baseFrequency 微调: 不同 ✓，可重复 ✓
跨两次独立启动:     a1=✓ seed2=✓ seed1_4=✓ f1=✓ cv1=✓ cv2=✓
2D ctx.filter=url(): 可重复 ✓，seed 生效 ✓，96 ms/次（含 getImageData）
成本: {"screenshotNoFilter_ms":51,"screenshotWithFilter_ms":64,"numOctaves8_ms":83}
```

结论：`feTurbulence` 完全确定；seed 截断取整（不能插值），≤0 按规范映射。

## 6. 预乘 alpha 往返

着色器输出 `vec4(.4,.2,.1,.5)` → `drawImage` 进 2D → `getImageData` = `[203,102,52,128]`，
证明 2D 把着色器输出当预乘色解释。文档据此要求着色器输出预乘色。

## 没测 / 没解决

- SwiftShader 跨机器、跨 CPU 架构的逐像素一致性。
- three / regl / ogl / pmndrs postprocessing：没装、没复测（选型判断引用旧 `motion-libraries` 调研）。
  决定不装的理由：全屏片元效果用 ~200 行的 `webfx.js` 就能做，且完全掌握时钟；库只在需要场景图/模型时才值得。
- 多遍 FBO 链（单 context 内多 pass）、浮点纹理 HDR：没做。
- `preserveDrawingBuffer:true` 的额外成本没单独量。
- compositing.md 里除 `destination-out` 外的混合模式配方是标准 Canvas 语义，没有逐个跑像素测试。
- 根目录 `scripts/capabilities.mjs` 没改（边界：不动根 `scripts/`）；性能与确定性探测放在本 skill 的 `bench.mjs`。

## 7. 数组 uniform / 只传一次 / mipmap（第 5 处补的三样）

夹具在 scratch（`FILMS_DIR` 指过去，seamcheck / texcache-check 都走 film-motion 的 `filmsDir()`）：
一支 2 秒 9x16 片，三个入口——`scene-ok`（`vec4 u_pts[8]` + `float u_w[8]` + `int u_n`、512² 纸纹 `{static:true, mipmap:true}`、
每帧重画的 256×456 动态层走默认上传）；`scene-stale`（纸纹按 t 重画却声明 static，"改了内容不 bump"）；
`scene-bucket`（纸纹按 t 重画，`key: Math.floor(t)`，"按时间分桶缓存"）。单元测试在页面里直接 import 新旧两份 webfx.js。

**数组 uniform**（`gl.getUniform` 逐元素回读，WebGL1 / WebGL2 各一遍）：vec4[5]、float[7]（Float32Array）、vec2[3]（扁平数组）、
vec3[2]（嵌套数组）、int[4]、mat2、mat3[2]、int、ivec2 —— 全部回读一致，`gl.getError()` 0。
`'u_v4[0]'` 与 `'u_v4'` 等价；`'u_v4[2]'` 只写第 2 个元素、第 3 个不动。三类错误都抛出、且抛之前不留 GL 错误：
少传元素（"没传到的元素会留着上一帧的值"）、分量数不整除、`[k]` 之后溢出。
只用常量下标 `u_a[0]+u_a[1]` 的 `vec4 u_a[8]`，SwiftShader 反射 size 仍是 8（没裁尾）。

**旧调用方式逐位不变**：同一着色器（float / vec2 / vec3 / vec4 / bool / mat3 / mat4 + 一张纹理），新旧 webfx.js 各渲 256×256，
全帧 SHA-256：gl1 clamp / gl2 clamp / gl2 repeat 三组**新旧完全相同**。`bench.mjs --quick` 新版跑完：6 档 + 6 模板确定性、跨启动 12/12、
WebGL1 vs 2 diffChannels 0，exit 0。

**只传一次**（包一层 `texImage2D` 计数）：

| 用法 | 30 次调用的上传次数 |
|---|---|
| `{static:true}` 同一源 | **1** |
| 默认（无选项） | **30**（行为不变） |
| `{key: Math.floor(i/10)}` | 3 |
| static 源改尺寸 / 换另一个源对象 / 改 filter 参数 / img 换 src | 各重传 1 次 |
| `globalThis.WEBFX_NOCACHE = true` 时 static 调 5 次 | 5 |

1080×1920 成本（WebGL2，中位数）：上传 2.0 ms、上传 + generateMipmap 4.6 ms、static 命中 0.1 ms。

**确定性与阴性对照**：

| 入口 | seamcheck（1a / 2 / 1b / 探针） | texcache-check（24 个时刻） |
|---|---|---|
| scene-ok | 全过，exit 0 | ✓ 24/24 一致；上传 缓存版 25 / 每次上传版 48，exit 0 |
| scene-stale（改了内容不 bump） | **全过，exit 0** ← 盲区 | ✗ 23/24 不同（最多 1913250 像素、100/255），exit 1 |
| scene-bucket（key 按秒分桶） | 门 2 ✗ 4/8（1812004 像素、102/255），exit 1 | ✗ 22/24 不同，exit 1 |

"改了内容不 bump"是冻结不是累积：同一页面里纹理每次都冻在第一次上传那一刻，同 t 两次、乱序、全新页面三种比法都比出同一个错的结果。
所以 seamcheck 对这一类是假门，单设了 texcache-check。

**mipmap 走样**（1024² 源上 1px 白线、间距 3px、略斜，缩到 128²；参照 = 源图在 CPU 上 8×8 面积平均）：

| | RMSE / 255 | 最大差 | 平移 0.25 源像素的帧间平均差（闪烁） |
|---|---:|---:|---:|
| LINEAR（旧行为） | 35.07 | 65 | 62.58 |
| `mipmap:true`（WebGL1 / WebGL2 相同） | **0.35** | 1 | **2.63** |

**斜看（1:8 足迹）**：1024² 源（横细线 + 4px 竖条）渲到 1024×128（纵向缩 8 倍、横向不缩），参照 = 1×8 面积平均：
LINEAR 39.09、只开 mipmap **64.87（比不开还差：按大方向选层，横向被糊掉）**、mipmap + `anisotropy:16` **0.29**。
`EXT_texture_filter_anisotropic` 本机 SwiftShader 可用，上限 16。
WebGL1 + 300×200 + mipmap → 抛错；WebGL2 + 300×200 + mipmap → 正常，`getError` 0。
`MAX_FRAGMENT_UNIFORM_VECTORS` 本机 WebGL1 / WebGL2 都是 4096。

**受影响的片子**：无。`_test-webfx`、`weiqi-intro`、`weiqi-ch1` 的 `runtime/webfx.js` 都与改前的 skill 版逐字节相同（各自钉着旧副本）。
weiqi-intro 里手写的 `getUniformLocation + uniform4fv`、只在加载期调一次 `texture('u_wood')` 正是这次补的两样的绕法，不改它。

没测：texcache-check 在真片子上（三支用 webfx 的片子都没用 static/key，跑了也是"门是空的"）；Metal 后端下的 mipmap / 各向异性结果。

## 8. 三维：three-film / stage3d / camrig / post3d / particles3d（2026-10-21）

环境同上（Chromium 156 headless shell，SwiftShader）。夹具 `tests/fixtures/_test-3d`（7 s，9x16 + 16x9），真片 `films/weiqi-fx-open`（24.4 s）。

**three-film 生成**（`node scripts/vendor-three.mjs --src <three@0.186.1 包>`）：

```
three 0.186.1 → skills/film-webfx/assets/runtime
  core   4× generateUUID 的 4 个 Math.random → 计数器 + 整数混洗
  core   17× 其余 Math.random（MathUtils.rand*、Vector*.random、Quaternion.random）→ 抛错
  core   2× probeAsync 的 setTimeout 轮询 → 抛错
  core   3× Loader 命中缓存时的 setTimeout(fn, 0) → 微任务
  core   1× yieldToMain 的 requestAnimationFrame 兜底 → 微任务
  core   5× Clock / Timer 的 performance.now → 抛错
  module 2× WebGLAnimation 的 rAF（setAnimationLoop）→ 抛错
  module 2× compileAsync 的 setTimeout 轮询 → 抛错
  module 2× import 路径 → ./three-film.core.js
  three-film.core.js 1427 KB, three-film.module.js 649 KB
```
被封的 17 个随机 API 在 three 内部没有调用方（grep 过），所以渲染路径不受影响。`node skills/selfcheck.mjs` 全过。

**seamcheck**（`node skills/film-motion/scripts/seamcheck.mjs --film _test-3d`，原始输出 `tests/fixtures/_test-3d/out/seamcheck*.txt`）：

| 入口 | 结果 |
|---|---|
| `scene.html`（正片：three 场景 + 样条推进/焦点切换/手持 + 两层 GPU 粒子 + 泛光/景深/色差/颗粒/暗角/故障） | 1a 8/8 ✓、2 8/8 ✓、1b 8/8 ✓、探针 ✓，exit 0 |
| `scene-bad-noreset.html`（`reset:false` + 只在 t>3.5 写 `visible=false`） | **只有门 2 红**：4/8 不同（24.6 万–49.6 万像素，最大 255/255）；1a、1b 全绿，exit 1 |
| `scene-sloppy-reset.html`（同样漏写，`reset:true`） | 全过，exit 0 |
| `scene-bad-integrate.html`（位置按 dt 带阻尼积分） | 1a、2、1b 都红（19.9 万–56.4 万像素），exit 1 |
| `scene-bad-clock.html`（seek 里 `THREE.Clock`） | 抛错退出：`three-film: Clock / Timer 读墙钟 违反帧契约…`，exit 1 |
| 第一版积分对照（`p += v·dt`，v 常数） | **全过**——Σdt 伸缩成 t − t0，碰巧是闭式（已换成阻尼版） |

`films/weiqi-fx-open`：accept 的 seamcheck 与 relaunch（门 5，跨启动按渲染拓扑逐帧比 md5）都 ✓。

**3D 锚点**：`window.anchors(t)` 在 5 个时刻顺序、倒序各取一遍，`_test-3d`（核心 / 光环 / 灵气）和 `weiqi-fx-open`（棋盘 / 悬子 / 文字）逐字节相同。
`weiqi-fx-open` 的 critique 块 `title-safe-1…6`（`inframe`，safe [0.06, 0.08]）：正片 6 条 PASS（每帧安全区内面积 100%）；
阴性对照 `scene-bad-top.html`（标题放回初稿位置）6 条 **FAIL**（最严重 58.2% 在安全区内），exit 1。

**fromCamera3d 等价**（film-motion `camera3d.project()` vs three `PerspectiveCamera` + `applyShot(fromCamera3d(...))`，200 个点 × 3 组参数 × 2 画幅）：
最大差 1.1e-12 px（含 yaw 0.4、近正俯视 elevation = π/2 − 1e-3、主点不在中心）。

**代价表**（`node scripts/bench3d.mjs`，原始输出 `tests/fixtures/_test-3d/out/bench3d.txt`；16:31 测，在 weiqi-ch1 的 accept 结束之后、本 agent 自己没有渲染在跑；
系统负载均值 53→45 但 top 显示主要是 macOS 的 mediaanalysisd 等后台；15:2x 负载 7 时的 `--quick` 单画幅结果与之相差 ≤ 0.6 ms，数字稳定）：

```
项目                                      9x16 ms  (+增量)      16x9 ms  (+增量)
基准（直接上屏）                                   8.7                 7.6
MSAA 4×（默认帧缓冲 antialias）            17.5 (+8.8)           16 (+8.4)
后期直通（HDR RT + 合成一遍，无效果）        19.7 (+11.0)        18.2 (+10.6)
后期直通 + MSAA 4×                        62.1 (+53.4)        60.8 (+53.2)
泛光（5 级）                              44.3 (+35.6)        43.2 (+35.6)
景深（1/2 分辨率，maxBlur 16）            86.4 (+77.7)        85.9 (+78.3)
体积光（48 步，1/4 分辨率）                 32 (+23.3)        30.8 (+23.2)
色差                                      24.3 (+15.6)        23.6 (+16.0)
胶片颗粒                                  19.4 (+10.7)        18.7 (+11.1)
暗角                                      19.6 (+10.9)        18.6 (+11.0)
扫描线                                    19.6 (+10.9)        18.7 (+11.1)
故障                                      25.4 (+16.7)        24.9 (+17.3)
色差+颗粒+暗角+扫描线+故障（合成一遍）        27.4 (+18.7)        26.4 (+18.8)
全部后期                                147.1 (+138.4)      146.3 (+138.7)
软阴影（PCF，2048² 阴影图）                14.2 (+5.5)         12.8 (+5.2)
GPU 粒子 1 万                               9.6 (+0.9)          8.6 (+1.0)
GPU 粒子 10 万                              20 (+11.3)        18.7 (+11.1)
CPU 粒子 1 万                                10 (+1.3)          8.8 (+1.2)
CPU 粒子 10 万                              24 (+15.3)        21.4 (+13.8)
复位 300 个对象（reset）                   10.8 (+2.1)           11 (+3.4)
reset() 单独（303 对象）                           0.4                 0.4
```

**整片**：

| 片子 | seek 中位（含 1px 读回） | seek + 截图 | 渲染 |
|---|---:|---:|---|
| `_test-3d` 9x16 | 131.8 ms | 383 ms | 210 帧，7 worker，24.3 s 墙钟 |
| `_test-3d` 16x9 | 137.0 ms | 337 ms | — |
| `weiqi-fx-open` 9x16 | 409 ms | 707 ms | 旧旁白 732 帧 189.9 s（第二次只重编改动的 3 片：151.5 s，改动泄漏报告 18.70–20.77s，正是改了数字画法的那一段）；新旁白（Vivi 2.0，25.43 s）763 帧，8 worker，175.7 s 墙钟 |

（前两行测于 15:2x 负载 18、第三行 15:3x 负载 10，有别的渲染在跑，偏高。）

**稀疏化**（scratch `test-thin.mjs`，没进夹具）：128×128 Gray-Scott rgba32f、120 步/秒、every 0.5 s、`maxCheckpoints: 3`，
按 9 / 2.3 / 7.7 / 0.4 / 9.9 / 5.1 / 1.0 / 8.2 / 3.3 / 6.6 s 求值，读回整张浮点状态做哈希，与 `FXCHAIN_NOCACHE` 下每次从第 0 步算的哈希比：**10/10 相同**；
稀疏化后检查点 3 张、间隔从 60 步翻到 480 步。

**静帧人眼看过**：`tests/fixtures/_test-3d/out/stills.png`（9x16 四张）、`out/stills-16x9.png`；`films/weiqi-fx-open/out/stills.png`、`out/compare-weiqi-ch1-vs-fx-open.mp4`。

**没测 / 没解决**：
- 景深看不见透明（加法、不写深度）粒子；GPU 粒子的锚点是闭式体积不是实际占位。
- AnimationMixer 带权重淡入淡出、SkinnedMesh、GLTF 模型加载：没有夹具。
- Metal 后端下的三维代价与 SwiftShader 的像素差：没测。跨机器：没测。
- MSAA RT + 深度纹理 + 景深的边缘正确性：能跑，没单独看。
- examples/jsm 插件没 vendor；用法写在 references/three.md 第 1 节，没跑过。

## 9. 世界文字可读性 `S.legible`（stage3d.js，2026-10-23）

夹具：scratchpad 里的 `legtest`（不进仓库；从 `_test-3d` 的写法缩出来，只拷 three-film / stage3d / anchors / layout / motion）。
1080×1920、相机在原点看 -z、fov 50；五个词各占一段阅读窗，`em: 0.5`（平面 2×0.5）。
`node <scratch>/probe.mjs --film legtest --films-dir <scratch>/films`（逐个 t 打 `window.legible(t)`）：

| 词 / 窗口 | 设置 | 实测 em（px） | 实测 squash | 对照 |
|---|---|---:|---:|---|
| 正面 0.5–1.5 | 正对，距离 4 | 257.34 | 1.00 | 理论 0.5 × (960 / tan25°) / 4 = 257.3 |
| 推远 1.5–3.0 | 距离 4 → 60 | 257.3 → 45.4（t=2.0）→ 17.16（t=3.0） | 1.00 | 257.34 × 4 / 60 = 17.16 |
| 斜看 3.0–4.5 | 绕竖轴 0 → 80° | 217.2（远端最小）/ emMax 315.6 | 0.825（t=3.5）→ 0.147（t=4.5） | 中心点 aspect 0.174 = cos80°；squash 取文字框上最差点，远端透视更扁 |
| 滚转 4.5–5.5 | 画面内转 0 → 90° | 257.34 | **1.00 全程** | 转角不算压扁（σmin/σmax 的设计目的） |
| 地面 5.5–6.9 | 平躺，相机下方 1.5、前方 4.1 | 92.2 | 0.354（aspect 2.72） | 视线仰角 20.1°，sin = 0.344 |

- 同 t 两次（2.2s）逐字节一致；12 个时刻顺序取 / 倒序取逐字节一致。
- `seamcheck --film legtest`：1a / 2 / 1b / 探针全过（测量在 render 之后，不改像素）。
- 阴性对照 `scene-leak.html`（推远的距离带上一帧的值）：critique 报 `legible.pure` FAIL @1.50s。
- 不登记时：`window.legible` 不存在，`render()` 多一次 `legReg.size` 判断，别的逐位不变。

**没测**：TextGeometry / troika 文字（夹具只用了贴图平面）；`rect` 不是默认值（舞台画进 2D 主画布的一块）的情况；
带后期（post3d）的场景（测量只依赖相机矩阵，按理无关，没跑）；`em` 写错时的后果只能靠人看证据帧。

## 从 skill 文档移出的实测叙事（2026-10 瘦身）

2026-10 装机 md 瘦身时从 `skills/film-webfx/` 的 SKILL.md 与 references 移出的来历、调研结论和推导。skill 里只留结论、判据、命令与代价数字。
SKILL.md 章节改号：合成细节（预乘、纹理只传一次、mipmap / 各向异性）并入 `references/compositing.md` §1–2；"没解决的"并入 SKILL.md 第 6 节末；三维是第 7 节。

**整片耗时的参照。** 验收片 `tests/fixtures/_test-webfx`（两遍着色器 + 两次合成）实测 seek 49.5 ms/帧。

**regl / ogl / pmndrs postprocessing（没装、没复测）。** 旧调研的结论是关掉自带循环后都能 seek：pmndrs `EffectPass` 内部累积 time，
要直接写 `fullscreenMaterial.time = t`；regl 要避开 `regl.frame()`。`post3d.js` 借了 pmndrs 的思路（效果合进一个着色器、MipmapBlur）但不依赖它，来历见 `docs/oss-borrowings.md` §7。

**three-film 补丁的效果。** 补丁后 `dev/selfcheck.mjs` 第 8 项（运行时不得含禁用 API）照常过；阴性对照 `tests/fixtures/_test-3d/scene-bad-clock.html` 在 seek 里用 `THREE.Clock`，
seamcheck 直接报 `three-film: Clock / Timer 读墙钟 违反帧契约……AnimationMixer 用 mixer.setTime(t)` 退出 1。

**舞台复位的语义来源。** "这一帧没写的属性回到静止值"即 Theatre.js 的"没上时间轴的属性取静态值"。
锚点实测（`_test-3d`、`weiqi-fx-open`）：5 个时刻顺序 / 倒序各取一遍 `window.anchors(t)`，逐字节相同。

**`S.legible` 的两个设计决定（第 9 节实测）。**
- 压扁比用奇异值比 σmin/σmax 而不是"投影后宽高比 / 原宽高比"：后者把横挤（<1）和竖挤（>1）报成两个方向、要两条阈值，还会把画面内转 90° 的字（roll）算成压扁。
- 独立的 `window.legible`，不并进 `anchors(t)` 的框字段：锚点表被遮挡门、出画门、continuity、音效声像按名字整表消费；可读性条目只在阅读窗内存在、字段完全不同，
  混进去会让那些消费者看到不是框的条目、和物体名撞名。它和锚点出自同一次绘制，满足锚点语义（film-core `references/runtime.md` §6）第 1 条。

**camrig `fromCamera3d` 的验证。** 2 种画幅 × 3 组参数（含 yaw、近正俯视）× 200 个点，两边投影最大差 1.1e-12 px。

**积分对照的教训（第 8 节）。** 第一版"积分"阴性对照是 `p += v·dt`、v 为常数——它过了全部门：匀速积分 Σdt 伸缩成 t − t0，碰巧就是闭式解；
只有速度依赖状态（阻尼、加速度依赖位置）的积分才会和求值顺序有关。所以对照改成带阻尼的积分，门 2 红。

**三维代价表的读法（bench3d，原 references/three.md §7 的展开）。**
- 合成一遍的边际成本很低：色差（三次取色）最贵；颗粒、暗角、扫描线各自几乎只是一遍全屏的固定成本。
- MSAA：默认帧缓冲 ×4 不贵；后期 HDR RT 开 ×4 很贵（多重采样 RT 的 resolve 在 SwiftShader 下慢）。
- 粒子：GPU 1 万个几乎免费、10 万个十几 ms；CPU 版 1 万同量级、10 万更贵（JS 计算 + 上传），多给"位置在 JS 侧"的能力。
- `weiqi-fx-open`（PBR + 软阴影 + 环境反射 + 景深 + 泛光 + 颗粒 + 暗角，1080×1920）seek 中位 ≈ 400 ms（负载 10 时），表里 409 ms。

**模型资产的来历（onetake 3D 笔记）。** onetake 的手机模型被否了三轮，第一个根因是做法：正反面各是一个大 n-gon，加倒角修改器、平滑着色；
导出 glTF 后大 n-gon 被三角化成扇形，平滑法线在扇形上插值出明暗条纹，倒角在圆角处的分段也不均匀——读起来像一张卡片。
重建改成一条截面轮廓沿超椭圆圆角路径扫掠、法线解析给出。本仓库没有复测这条路（references/models.md §7）。

## camrig.shots()（2026-11-05）

- 来历：xa-agent 九段各给关键帧再拼接，段交界两段同一时刻 → `track` 抛「关键帧时刻必须递增」；片内先写了 `shots()` 助手，收进 camrig。
- 测法：Node（`registerRuntimeResolver`）`track(shots([{t0:0,t1:1,a:0,b:10},{t0:1,t1:2,a:100,b:200,ease:'linear'}]))`
  在 t = 0 / 0.5 / 0.996 / 1 / 1.5 / 1.996 / 3 求值 → 0 / 5.045 / 10 / 100 / 150.15 / 199.9 / 200（镜内 a→b、t=1 硬切到 100、末尾保持）；
  镜头 ≤2ε、重叠、t0 为 NaN、缺 a 四种输入都抛错。
- 没测：浏览器里的 seamcheck（它不碰 t 以外的任何东西，求值仍走 track）；整片硬切的观感由片子自己的 shots.md 管。

## 后期 MSAA / 色差 / 颗粒对细边的影响（xa-agent，2026-11-05，肉眼对比，无数字）

- 同一帧（22.6s，细发光圆环 + 芯片）全分辨率对比：`samples 0, chroma 1.5, grain 0.05` 细环有阶梯和彩色重影；
  `samples 4, chroma 0.6, grain 0.025` 细环是干净实线。两项改动同时做，没拆开测各自贡献。
- 0.5x `--preset veryfast` 小样的同一帧放大后整体发糊，用户据此评「边缘不清晰」——判清晰度不能看缩小版。
- 逐帧增量未在本片单独测；参考 three.md §7 代价表（后期 RT MSAA 4× +53.4 ms @1080×1920）。

## fxchain：多 pass 管线、帧间反馈、风格化后期与调色（2026-11-10）

新增运行时 `assets/runtime/fxchain.js`（`createChain` / `createPass` / `parseCube` / `cubeCanvas` / `HEADER`）与 `assets/runtime/fxglsl.js`（`STYLIZE` 14 个、`FEEDBACK` 5 个片段；`templates.mjs` 转导出）、门脚本 `scripts/fxreplay-check.mjs`。
环境同上（Chromium 156 headless shell，SwiftShader）。夹具 `tests/fixtures/_test-fxchain`：`scene.html`（上半 Gray-Scott 270×240 rgba32f、240 步/仿真秒；下半墨晕 540×480 rgba16f、30 步/秒；12 s）、
`scene-stylize.html`（一条链 34 个 pass：12 种效果各写一个命名目标，mosaic pass 拼 3×4 宫格；6 s）、阴性对照 `scene-bad-noreplay.html`（`leak:'noreplay'` 往回 seek 不重放）、`scene-bad-ref.html`（`leak:'ref'` 检查点存引用）。

**能力探测**（本机 WebGL2）：`EXT_color_buffer_float`、`EXT_color_buffer_half_float`、`OES_texture_float_linear` 都有；RGBA16F / RGBA32F 帧缓冲 complete；MAX_TEXTURE_SIZE 8192，纹理单元 32。降级路径（`floatFallback:'rgba8'`）在本机没有触发条件，**没实测**。

**门**（`node skills/film-core/scripts/seamcheck.mjs --film _test-fxchain --films-dir tests/fixtures [--entry …]`）：

| 入口 | 1a | 2 | 1b | 探针 | 其它 | exit |
|---|---|---|---|---|---|---|
| scene.html | ✓ 8/8 | ✓ 8/8 | ✓ 8/8 | ✓ | `--parallel 2`：门 4 全片 360 帧 0 帧不同（墙钟 89.5 s，负载高时） | 0 |
| scene-stylize.html | ✓ | ✓ | ✓ | ✓ | Kuwahara 改写后复跑仍全过 | 0 |
| scene-bad-noreplay.html | ✓ | **✗ 7/8**（54–68 万像素，最大 229/255） | ✓ | ✓ | 「结果依赖求值顺序」 | 1 |
| scene-bad-ref.html | ✓ | **✗ 8/8**（64–85 万像素，最大 220/255） | ✓ | ✓ | 同上 | 1 |

两个阴性对照都**只有门 2 红**：同 t 两次（第二次 n == curN，不回退）和全新页面（同样的顺序）都看不出。

**fxreplay-check**（参照 = `FXCHAIN_NOCACHE`，每次 render 从第 0 步算；三个全新页面按顺序 / 倒序 / 乱序，各 12 个时刻）：

```
$ node skills/film-webfx/scripts/fxreplay-check.mjs --film _test-fxchain --films-dir tests/fixtures
反馈 rd / ink
  顺序  ✓ 12/12 与"从第 0 步算"逐像素一致（rd: 走 2872 步、回退 0 次、检查点 12 个；ink: 走 359 步、回退 0 次、检查点 12 个）
  倒序  ✓ 12/12 与"从第 0 步算"逐像素一致（rd: 走 4032 步、回退 11 次、检查点 12 个；ink: 走 504 步、回退 11 次、检查点 12 个）
  乱序  ✓ 12/12 与"从第 0 步算"逐像素一致（rd: 走 7432 步、回退 4 次、检查点 12 个；ink: 走 929 步、回退 4 次、检查点 12 个）
✓ 通过：检查点与重放在外部观测不到                                    (exit 0)
--entry scene-bad-noreplay.html：顺序 ✓ 12/12，倒序 ✗ 11/12，乱序 ✗ 9/12   (exit 1)
--entry scene-bad-ref.html：     顺序 ✓ 12/12，倒序 ✗ 11/12，乱序 ✗ 10/12  (exit 1)
```

`accept.mjs --deep --film _test-fxchain`：`seam✓ fontsrc✓ fxreplay✓ texcache✓ seam4✓`，其余 –（gates.json 的 uses 触发如预期）。
`texcache-check --entry scene-stylize.html`：两边上传次数 24 / 24，"没有命中过纹理缓存，门为空"（夹具每帧上传源画面，没用 static）。

**反馈耗时**（scratch 基准，页面内 `performance.now()` + `finish()`；8:28 测，1 分钟负载 3–8）：

| 状态 | 每步 |
|---|---:|
| 64×64 空步（一次取样） | 0.19 ms |
| 270×240 rgba32f 空步 | 0.25 ms |
| 270×240 rgba32f Gray-Scott | 0.58 ms |
| 270×240 rgba16f Gray-Scott | 1.10 ms（半精度反而慢一倍） |
| 540×960 rgba32f Gray-Scott | 2.65 ms |
| 540×480 rgba16f 墨晕 | 2.73 ms |
| 1080×1920 rgba16f 墨晕 | 19.1 ms |

夹具冷启动（全新页面第一次 seek）：1 s 396 ms、3 s 742 ms、5 s 1121 ms、**10 s 2119 ms、30 s 5945 ms**（线性，≈0.2 s/仿真秒）；
接着顺序下一帧 17 ms、往回半秒 107 ms、跳回 0.2 s 48 ms；全部目标与检查点显存 10 s 时 38.6 MB（22 张检查点）、30 s 时 97.9 MB（62 张）。
同样的测量在 8:20 负载 42 时：10 s 冷启动 11.4 s、30 s 34.4 s——同机并发渲染对 SwiftShader 的影响是 3–6 倍，换机器或并发渲染时先复测。

**单 pass 效果**（每项 7 次取中位，静态输入纹理，不含 2D 上传）：

```
效果           1080×1920 / 540×960 ms
halftone     27.6 / 7      dither       7.5 / 2       pixelate     8.7 / 2.4     outline      13.9 / 3.6
kuwahara_r2  60.9 / 15.5   kuwahara_r4  156.4 / 39    kuwahara_r6  301.1 / 73.2
ascii        6.5 / 1.8     lens         7.9 / 2.1     grade_lgg    7.4 / 1.9     lut3d        9 / 2.4
lut_strip(WebGL1 createShaderLayer) 7.7 / 2.1     extract 4.2 / 1.2     blur9 13.7 / 3.6
bloom 链 rgba16f 17.7 / 4.9   rgba8 11 / 3.2      streak 链 12.7 / 3.6
4 遍 blur9：fxchain 一个 context 54 / 13.8，4 个 createShaderLayer 经 2D 中转 83.6 / 22.5
lut3d vs lut_strip（256×256，17³ LUT）：逐通道最大差 1/255，平均 0.073/255
```

Kuwahara 第一版（−r..r 双重循环 + 四个 if 分象限）在负载 20–40 时 r=2 / 4 / 6 为 126.9 / 346.4 / 690.9 ms，改成每圈同时取 4 个对称点后（同一负载段）61.6 / 167.2 / 312.2 ms；表里是改后低负载的数。

**静帧人眼看过**（`stills.mjs`，`out/stills-feedback.png`、`out/stills-stylize.png`）：
- 反应扩散：t=0 是 24 个种子圆点，2 s 起开始分裂成成对的斑点，11.9 s 时长成大片分裂斑（f=0.0367、k=0.0649 的"mitosis"区）。墨晕：笔迹在流场里平流、晕开、按 0.996/步衰减，抬笔段留下渐淡的拖尾。
- 风格化宫格：12 格都不是全黑 / 全白。半调暗部点连成片、亮部点变小；抖动是 5 色调色板的棋盘过渡；Sobel 只剩圆和方块的轮廓线；ASCII 字形按亮度分级；镜头格是桶形（边缘外凸、四角黑）带 R/B 色边；halation 是亮圆外圈红晕；拉丝是横向光条。
- 细线放大（1px / 2px 线）：半调下并进点阵、抖动 3px 格把 1px 线打成虚线、像素化 12px 把六条线并成两条糊带、Sobel 把每条线变双线、Kuwahara r4 几乎抹掉、ASCII 变字符行、畸变弯曲带色边；LGG / LUT 不动线形。写进 references/stylize.md §5。

**没测 / 没解决**：
- `floatFallback:'rgba8'` 降级路径：本机浮点扩展全有，没有触发过。
- Metal 后端、跨机器的逐位一致性；GPU 后端下反馈重放的确定性。
- halation 链、down4 单独的耗时（只在宫格里看过画面、在泛光链里计过总时）。
- `maxCheckpoints` 稀疏化没有进夹具，fxreplay 覆盖不到；只在 scratch 测过一次（见上「稀疏化」）。
- 循环片 + 反馈：不支持（门 3 必红），没做淡回的配方。
- 反馈 step 读随时间变化的 2D 画面（按步号重画上传）没做。

### 2026-11-12 天空、表面与程序化建模

从 Claude 中断的阶段代码接续，完成 sky3d/surface3d 的浏览器夹具与 model3d 的实现。所有颜色仍由片子显式决定，技术能力不加入强制风格。

命令与结果：
- `node skills/film-core/scripts/seamcheck.mjs --film _test-sky --films-dir tests/fixtures --parallel 2`：1a/1b/2/4、禁用API探针全过；10帧，0帧不同。
- 同命令换 `_test-surface`：120帧，0帧不同，所有门与探针全过；湿度随t变化，UV/三平面对照，程序化法线图开mipmap。
- 同命令换 `_test-model`：10帧，0帧不同，所有门与探针全过。
- model unit：17441条数值断言通过；surface unit：12条断言通过。
- selfcheck通过，只有既有文档体积/触发词重合警告；最终全套回归由主代理统一执行。

静帧已实际查看：天空可见太阳盘、宽窄日晕、冷暖方位变化、上方受光云层、球的天空反射与接触硬化软影；整体是夹具自己选的低角度暖光，不能据此宣称适用于所有审美。材质左右对照可见表面纹理、贴地压暗、湿后粗糙度变化，无黑屏/NaN。模型右侧相机可见倒角高光、螺钉、镜筒、对焦环、管线与标牌，对照版轮廓生硬、缺细节；屏幕枢轴和相机运动通过乱序帧比，但不是完整成片美术验收。

1080×1920，seek + S.finish 同步读回，预热后5帧中位数（ms），并发开发负载下的小差异不作统计结论：
| 场景/特性 | SwiftShader | GPU Metal |
|---|---:|---:|
| 天空/云/8球/PCSS/雾全场景 |118.8|1.7|
| 地面裸材质 |109.9|1.5|
| 单开AA |111.5|1.5|
| 单开宏观 |109.9|1.7|
| 单开积垢 |111.1|1.7|
| 单开湿润 |115.2|2.2|
| 单开三平面 |138.8|1.3|
| 地面全部特性 |150.6|2.1|

天空PMREM 128面生成（含首编译和S.finish同步）：SW451.5ms/GPU28.2ms。这里包含first-use成本，不是稳态重拍的纯GPU计时。
相机模型45 mesh→6 mesh，19986三角形不变，顶点13065→58578（非索引展开）。1080×1920，6帧中位数：SW合批前57.0ms/后35.2ms，GPU前1.7ms/后1.6ms；场景仍同时包含左侧原始对照模型。
加载期Node基元50次均值：倒角盒384顶点0.174ms、车床体100顶点0.052ms、挤出36顶点0.044ms、扫掠36顶点0.082ms、管道585顶点0.286ms。

此次抓到两个具体问题：surface在加载期频率相等时错误共用噪声，逐帧改频率会失效，已移除该结构优化；three内置车床体某剖面末端法线未归一，新helper统一normalizeNormals。合批还处理了镜像绕向与投影开关保留。

局限：PCSS只保证同一主太阳视锥，多个不同视锥不共用该补丁；天空云是投影层非真三维云；镜面主体反射云时需自行预拍多个时刻；前景深度压缩会让景深/雾读到伪距离，需要单独合成。表面非均匀缩放/实例/蒙皮/位移尚无专门夹具。建模不含真布尔、孔洞挤出接口、CAD连续曲面、自动LOD、蒙皮或通用UV展开；急弯扫掠需要显式截面坐标架。只做了局部夹具，未制作完整片子。

### 2026-11-12 后期链接续验证

原阶段代码中的AO/volume shader尚未接入执行，镜头/显示/finish链尚缺。此次接完可选混合泛光、深度AO、太阳阴影步进高度雾、脏污/拉丝/当前帧眩光、曲线混合和显示线性调色、FXAA/锐化/三角颗粒/抖动；measure与exposureTrack提供离线曝光表流程。参数/代价与局限见 `post-chain.md`。

改前先跑 `_test-3d` seam 完全通过，再保存 9x16 四帧PNG SHA256。改后再次截图，**四个PNG字节完全一致**：

| 秒 | 改前 = 改后 SHA256 |
|---|---|
| 0 | 720a30afbe729d3cdb970fc6331987bb8df1b8930347719a85143de897eee316 |
| 0.8 | 546e4967367df20319abc99cd3b4b1775b1daf2fb24c83f1c5d663babf808c9b |
| 3.4 | d906f907417c4a314e0219d6f8b0b5eea2ef334a182f9829e71ea5dbd3cb913a |
| 6.6 | 776e97954cb1bb1b9db89d8b48456cb20afecda931784c9f20993979ce44fa3b |

`node skills/film-core/scripts/seamcheck.mjs --film _test-3d --films-dir tests/fixtures` 改前/改后均 exit0，全部通过。全回归三维阴性对照由主代理正在跑的完整dev/test覆盖。


- 新 `_test-post` 1080×1920，1.25s@12fps：seam1a/1b/2、parallel2的15帧、禁用API探针全部通过，0帧不同。
- 曝光数值125条通过；浏览器行为18条通过：AO零强度、雾零密度与不开效果均0像素不同，非零分别改变15360/129600像素（270×480）；当帧太阳深度遮挡改变11566像素。MSAA4深度链0.4→0.8→0.4逐像素相同，真实SKY_GLSL/rig.uniforms远景接口渲染无错；自定义output/measure的目标与曝光恢复、缺逐帧参数/缺horizon uniform槽报错均已实测。
- 额外HDR拷贝原在92像素产生1LSB差；零强度时改成旁路，所有下游源每帧更新，避免把“0”当作近似关闭。
- 已查看SW all/off与Metal全开静帧：柱廊/球/太阳/薄雾/幽灵可见，无黑白花屏。静帧不证明完整影片的运动质量。

1080×1920柱廊四球夹具，场景阴影1024²；预热后7次，同步readPixels阻塞后计时中位数。全部是**整帧**耗时而非效果增量。AO16采样、雾24步。并行开发竞争机器，数字用于量级比较。

| 模式 | SwiftShader半分辨率AO/雾 | SwiftShader全分辨率AO/雾 | Metal半分辨率 | Metal全分辨率 |
|---|---:|---:|---:|---:|
| 仅显示链 | 35.3 | 36.4 | 1.8 | 2.0 |
| 混合泛光 | 90.1 | — | 2.1 | — |
| AO | 86.4 | 142.0 | 2.8 | 3.1 |
| 步进雾 | 125.8 | 238.1 | 2.1 | 3.6 |
| 脏污（含泛光） | 80.4 | — | 2.5 | — |
| 横向拉丝（含泛光） | 124.9 | — | 2.9 | — |
| 眩光 | 52.5 | — | 2.0 | — |
| 调色 | 49.0 | — | 1.8 | — |
| finish全开 | 53.4 | — | 1.9 | — |
| 全开 | 269.7 | 447.9 | 5.0 | 6.4 |

注意：gl.finish()在Chromium未充分阻塞，会误量成0.3ms；最终数字全部改用readPixels。Metal测量时内存中的F.config.backend显式设gpu，确认没有被openScene自动改回SwiftShader；没有修改入库film.json的后端。


边界：AO亮度退让不是真正分离环境光，缺屏外几何；体积雾只支持透视、单平行光深度阴影，拒绝VSM，远景为密度梯形近似；眩光无时间平滑；透明覆盖、跨机器、H.264后颗粒保留未做完整片验证。没有TAA/SSR，运动模糊仍走子帧平均。没有独立测光CLI，文档化扫表流程和API已实测。

### 2026-11-12 贴图、湿地面与烟火花

新增 `texture3d.js`（周期米制高度/法线/共享分层破损与ORM、GPU烘焙框架）、`ground3d.js`（唯一地形遮罩、连续水位、平面HDR反射、周期涟漪）、`spritefx3d.js`（实例四边形火花/受光烟/火焰、深度软交界、周期雨盒），接口见 `world-surfaces.md`。

- `_test-worldfx/tests/unit.mjs`：周期噪声、纹理确定性、法线物理尺度、ORM、唯一遮罩、解析阻力对独立RK4、烟侵蚀、雨盒和非法参数断言通过。
- `tests/browser.mjs`：反射开关128008像素差、湿/干173779差、软交界803差；额外关闭反射的主视角对照仍有801像素差，证明软交界真的在主镜头生效。反射0/.6/0纹理变化且回退重现；深度软交界乱序一致、烘焙状态恢复通过。
- `tests/audit.mjs` 独立GPU对照：半透明sprite中心RGBA[66,44,28,255]与标准MeshBasicMaterial逐通道相同；纯纵深速度火花投影xy相关系数1；drag0与0.0001的可见质心相同；反射真实线性HDR峰值4.48046875；cube face3/mip1下烘焙后目标状态恢复。
- 最终 `dev/test.mjs --only _test-worldfx` 四项全部符合，25s；seam1a/1b/2、parallel2全片14帧0不同、探针通过。已打开最终4格静帧，破损盒、板缝、环倒影、火花、烟与衰退可见。
- 独立审查修复：直出sprite漏色调/编码后预乘、透视速度缺纵深项、小阻力float相消、像素最小尺寸少一维补偿、主相机深度误用于反射副相机、RT面/mip恢复、镜像up二次变换、遮罩A未用。
- 软交界原测试的2081像素差全来自错误的副相机采样，是假阳性；修复后将所有对照模式的烟几何统一切入地面，再用独立主镜头对照验证。

最终 `dev/film-webfx/worldfx-bench.mjs`：预热5帧，15次seek+同步readPixels，中位ms；包含整个场景，不是效果增量；并发回归竞争CPU，数值仅用于量级判断。

| 尺寸 | SW无反射 | SW含256²反射 | Metal无反射 | Metal含反射 |
|---|---:|---:|---:|---:|
|540×960|14.0|14.7|1.0|1.5|
|1080×1920|26.7|42.6|1.6|2.1|

局限：水平平面反射只支持透视单平面，不递归多面镜；水波是闭式周期扰动非水动力；烟是二维密度法线/厚度近似且实例不逐粒深度排序；反射副相机不使用主深度软交界；火花不含相机速度模糊，仍依赖子帧平均。没有完整片或跨机器验收。

### 2026-11-12 独立入口前向验收

从实际SKILL入口和七份参考页出发，独立代理按文档在仓库外新建两场景：天空+PMREM+混合泛光/映射/FXAA，以及共享破损贴图+湿地反射+烟图集。按[0,.5,0,.8,.5]求值，两个页面errors=[]、重复时刻PNG哈希相同、不同t画面变化；截图已查看。发现并修正events的applyShot对象/尺寸签名、合批后动画需引用返回组克隆节点、反射width/resolution像素单位歧义。没有依赖能力skill私有目录，也没有运行下载来的原HTML。

### 2026-11-13 webfx 修复线（审查 15 条）

环境：本机全新检出，`npm ci` + `npx playwright install chromium`（headless shell 1248 / Chromium 156.0.8078.4），SwiftShader。

**旧三维基线**：上面 11-12 记的四个 SHA256 是另一台机器的字节，本机同一提交截出来不同（PNG 字节依赖机器/浏览器构建）。改为 `dev/film-webfx/baseline3d.mjs --save/--against <json>`：改任何东西之前在本机 `--save`，之后 `--against`。本轮改 post3d（共享片段、fxSafe、黑纹理、曝光还原、前景、显示链）的每一步之后都跑过，`_test-3d` 9x16 的 0/0.8/3.4/6.6 s 四帧**逐字节相同**（9ba87d7f…/b3a19e99…/593e244e…/2fce310f…）。

**新运行时改前/改后截图对比**（scratchpad 脚本，各 3 帧）：sky、surface、model **0 像素不同**（patch3d 统一补丁、pcg/IGN 去重、surface 的批次网格、model3d 重排都不改像素）；post 全开约 99.8% 像素变化、最大 22/255——是拉丝修复：原来 mix 泛光的无阈值 mip 被横向抹满整幅；worldfx 约 62% 像素变化、最大 39/255（涟漪重写、哈希换 pcg、地面粗糙度改乘法、反照率改 sRGB 存储）。

**新断言（都先确认旧代码会红）**：
- `_test-post/tests/browser.mjs` 27 条：拉丝开/关在画面下部 30% 的 38880 像素里 0 个变化（>1/255）、太阳带 4683 个变化；太阳在画内挪 0.004 UV 最大差 12/255、跨画框边 13/255（旧实现跨边时 3/9 可见度采样直接判 0），出画 1.4 NDC 与关闭 0 像素不同；场景里放一个 1e6 的像素（SwiftShader 写进 HalfFloat 变 NaN，972 个分量），旧链泛光开时输出 1095 个 NaN 分量，现在开/关两帧都是 0，comp 链画完 `toneMappingExposure` 还原；`foreground:{depth:.05}` 时 pinForeground 物体内部 0/646 像素被景深改动（不开 267/646）。
- `_test-worldfx/tests/browser.mjs`：涟漪开/关 3650 像素不同，淡出区间 [0,0.01] m 时与不开 0 像素不同，乱序一致；ground+surface 两种顺序、再叠高度雾、InstancedMesh、BatchedMesh 全部编译渲染（旧代码 surface 替换 normal_fragment_maps 后 ground 注入直接抛错）。
- `_test-model/tests/unit.mjs` 17551 条：扫掠截面顺/逆时针 × 坐标架左/右手四种组合侧面与封口都朝外（旧代码顺时针截面侧面全部朝内，16/16）；extrude smooth 的封口法线保持 ±Z（旧代码 36/36 个法线被侧面混掉）。
- 阴性对照：`_test-worldfx/scene-bad-reflect-prevframe.html`（reset:false + 画完这一帧才更新反射）seamcheck 门 1a 8/8 时刻红、门 2 8/8 红、1b 绿；`_test-surface/scene-bad-noreset.html`（reset:false + 湿度只在 t>2 s set）只有门 2 红（4/4 时刻，约 33 万像素）。发现：默认 reset:true 时舞台把 `uGMatrix` 还原到 freeze 值，过期反射整个落到画外，门看不出来（画面上是"反射消失"），已写进 world-surfaces.md。

**没做 / 没测**：涟漪对照原游戏只到公式级，没有逐像素对照；`foreground` 只验证了景深（AO/体积雾对压缩深度的物体本来就几乎不起作用，开关差异测不出）；测光改为全像素降采样后没有和旧 32×18 点采样做数值对比；sky3d 云的明暗曲线常数（0.55+0.9r²、0.05+2.2r³）只写进文档没参数化。

## 小样少画像素：`window.FILM.scale` × stage3d（2026-11-14）
`render --scale k` 时内核注入 `FILM.scale = k`，stage3d 把绘制缓冲乘 k（画布在页面里且没写 CSS 尺寸时先钉住布局尺寸，锚点仍按原尺寸量）；scale 1 路径逐字不变。
forge 7–8 s、0.5x、veryfast、1 worker、4 核 SwiftShader：截图 82.0 s → 41.3 s（2.73 → 1.38 s/帧），总耗时 90 s → 50 s。不到 4 倍：阴影贴图、forge 自己按 L.width/3 写死的平面反射 RT、环境贴图不随 k 缩。
post3d / particles3d / spritefx3d 都按 `S.width/S.height` 取尺寸，跟着缩；fxchain 按自己的 `o.width × o.scale`，不读 FILM.scale（只用 fxchain 的片子小样不会变快）。

## 上手成本、"光从哪来"诊断、低机位倒影（2026-11-14）
起因：本仓库样例 forge（sky3d + ground3d + post3d 的第一个真实消费者）首次搭景要从夹具抄十几个无默认值的参数；湿地面上一个白斑查了 3 轮才定位到是月盘被积水平面反射镜进画面。
**改了什么**：sky.md / world-surfaces.md 各加一张"参数 · 单位/有效域 · 控制什么"表和一句明确标为**占位**的最小可跑写法（中性灰 + 区间中段），指向夹具；sky3d / ground3d 缺参数的报错带单位与有效域（`ground3d: 缺参数 layers.damp.lowBias（0–1，低处更潮的权重）`）。
`ground3d.reflectionOf(camera, planeY, 点|{dir}, size)`：镜像点、倒影在地面上的位置、屏幕坐标；`_test-worldfx/tests/unit.mjs` 对独立推导（视线与平面交点、针孔投影 `ndc.y = −tan(俯角)/tan(fov/2)`）断言到 1e-9，含相机/点在平面下、高仰角盘出画框。
`scripts/lightdebug.mjs`：加载前注入 `globalThis.WEBFX_DEBUG`；sky3d/ground3d/post3d 只在它存在时 `register()`（未注入 = 一次空可选链，着色器、uniform、绘制顺序都不变，所以门与成片不受影响）。注入实现包住 `S.renderer.render`，只在画 `S.scene` 时临时改值、画完还原（平面反射那次绘制也经过它，关日盘同时关倒影）。
实测：`_test-worldfx` t=0.6（540²，约 17 s）6 个源关掉都改像素（平行光 194771、反射 129556、涟漪 3631——涟漪区域平均 Δ=0.00000 而 |Δ| 0.00002，所以输出同时给 Δ 和 |Δ|），全开重拍 0 像素差；`_test-sky` t=1（1080p，约 65 s）日盘 199 像素、日晕/雾/环境都改像素；forge t=2.0 地面带 [0,760,1920,320]（14 个源，约 100 s）：最亮像素 (1196,766) 99% 来自加色网格（雨丝），区域 Δ 最大是自发光 36%、环境 12%、雾 10%，关反射区域反而亮 12%（积水退回更亮的环境镜面），月盘仰角 11.5°、倒影不在画面内（现行 forge 的光向已改过）。
**没做 / 没测**：没有"只开一个源"（solo）模式；不拆单个材质/单个网格；只用 stage3d 而不用 sky3d/ground3d/post3d 的片子拿不到舞台，脚本直接报错；色调映射后的线性亮度差不可加（输出里写明）；reflectionOf 不做遮挡（"贴地物体倒影被自己底座挡住"只写进文档，要射线检测时自己做）。
