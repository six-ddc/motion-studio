# 按效果检索：效果 → 运行时函数

目录：转场与镜头 · 文字 · 2D 动效与编排 · 矢量形状 · 三维与后期 · 物理与粒子 · 声音与时间
用途：从「想要的效果」反查套件里已有的实现。手写任何有名字的效果（转场、擦除、乱码解码、数字滚动、粒子、景深、辉光……）之前，先查这张表；表里已经有的就直接用或在它的基础上修改，不要重写。
这张表只是索引，不排优劣，也不给默认选择；代价一列摘自各 skill 的代价表（ms 为 SwiftShader 下的实测值）。文件列的格式为 `skill（省略 film-）· 运行时文件`。

| 效果（常见叫法） | 函数 / 调用形状 | skill · 文件 | 代价 |
|---|---|---|---|
| **转场与镜头** | | | |
| 硬切、叠化、闪黑/闪白 | `S.mix('cut'\|'crossfade'\|'dip', a, b, pe, opts)`，`S = createStage(canvas)`；全部 kind 在 `TRANSITIONS` | motion · transitions.js | 约 0–3 ms；每个剪辑点都用叠化，片子就没有骨架 |
| 擦除、划像、圆形开合（iris）、时钟擦、百叶窗 | `S.mix('wipe', …, {shape:'linear'\|'iris'\|'clock'\|'box'\|'bars'\|'custom'})` | motion · transitions.js | 5–10 ms；从主体出发时会被读成世界的一部分，从画面中心无缘无故打开则像幻灯片 |
| 噪点溶解、亮度图溶解、烧边 | `S.mix('luma', …)` | motion · transitions.js | 50 ms；粗颗粒加上宽软边和亮烧边，会变成满屏黑白斑块 |
| 推、滑入、缩放转场、钻进去 | `push` `slide` `zoom` `zoomThrough` | motion · transitions.js | 13–15 ms；推移方向要和画内运动方向一致 |
| 甩镜、故障转场、漏光 | `whip` `glitch` `leak` | motion · transitions.js | 34–100 ms，是最贵的一组；和题材无关时只起装饰作用 |
| 匹配剪辑、共享元素、Magic Move | `match` `magicMove`（在镜头里用 `sh.el(name, rect, draw)` 登记） | motion · transitions.js | 6–12 ms；同时移动的元素太多会乱成一团 |
| 颜色/属性渐变插值 | `mixColor(a, b, q, space)` `mixProps(a, b, q, space)` | motion · transitions.js | 见 `references/transitions.md` |
| 2D 推拉摇、镜头缩放 | `camera(t, [[t, zoom, x, y], …], sp)` + `applyCamera(ctx, cam, w, h)` | core · motion.js | 相机运动和画内运动都用弹簧时，观众容易晕 |
| 透视斜看平面、2.5D 斜俯视 | `camera3d({S, elevation, distance, look, screen, yaw})` `distanceForFov` `CAMERA3D_GLSL` | motion · camera3d.js | 见 `references/camera3d.md`（用正交代替的代价是平行线不收拢） |
| 3D 环绕、推轨、样条运镜、跟拍、手持抖、镜头切换混合；2D 标注贴 3D | `orbit` `dolly` `spline` `track` `follow` `aim` `shake` `blendTargets` → `applyShot(camera, shot, size)`；`fromCamera3d(cam, W, H)` | webfx · camrig.js | 都是 t 的纯函数；见 webfx three.md §3 |
| 产品界面重建、放大到可读 | `placeReplica` `localRect` `zoomFor` `screenPx` `strings` | motion · uirebuild.js | 见 `references/ui-rebuild.md` |
| 柱状图竞赛、排名交换 | `barRace(frames, {top, ease, swap, fade, fill})` → `R.at(t)`（`pos` 喂 `scaleBand().at`）、`R.maxAt(t)` | motion · chart.js | 加载期建表 20 条×30 s 约 50–70 ms；交换密集（每秒几十次）时观众跟不上任何一条 |
| 折线/面积生长、末端跟标签 | `curvePoints(pts, 'monotone', {samples})` + `lineGrower(pts).at(p, 'x'\|'length')` → `{points, end, angle}` | motion · chart.js | monotone 要求 x 递增；按 x 推进时陡坡段笔尖变快 |
| 坐标轴随数据伸缩、刻度淡入淡出 | `axisTicks(scale(t), n, {blend, edge})`；静态刻度 `ticks` `nice`；数值格式 `grouped si cjk percent` | motion · chart.js | 只支持 linear/pow；blend 大则同屏刻度多、标签易挤 |
| 地图、地球自转、航线 | `projection(kind, …)` + `fit` + `geoShapes` + `greatCircle(a, b).points(n, p)` | motion · chart.js | 正射 2000 点含裁剪约 1–2 ms/帧；mercator 高纬面积放大约 1/cos²φ |
| 关系图、力导向布局展开 | `forceLayout(nodes, links, {seed, iterations, distance, charge, record})` → `G.at(k)` + `fitPoints` | motion · chart.js | O(n²)：n=500 300 步 150–230 ms，上千个节点离线算好写成 JSON |
| **文字** | | | |
| 逐字交错入场/出场、kinetic typography | `layoutText` + `drawUnits` + `IN.fade/rise/drop/scale/spin/skew/track`（出场 `OUT(IN.xxx({…}))`）+ `unitProgress` | typography · textfx.js | 0.4 ms；每一句都交错的话，观众会一直在等字出完 |
| 遮罩升起 | `drawRiseIn(ctx, glyphs, t, {progress, rise, …})` | typography · text.js | 需要行遮罩；中文超过 15 个字逐字升起会显得拖沓 |
| 按行升起；切分揭示、切片拼合 | `drawLineReveal(ctx, lay, x, y, {progress, rise})`；`drawSliceReveal(ctx, text, x, y, {slices, progress, dist})` | typography · textfx.js | 各 0.3 ms；行数多时总时长会变长；切片条数多再加上交替方向，就是典型的 MG 预设效果 |
| 乱码解码、破译、scramble | `scramble(t, us, {start, settle, rate, pool, seed})` | typography · textfx.js | 0.2 ms；pool 里的每个字都要加进 `loadFonts` |
| 打字机、光标闪烁 | `typeSchedule` → `typedAt(t, sched)` / `cursorOn(t, sched, {blink, hold})` | typography · textfx.js | 0.2 ms；匀速打字像机器，加上标点停顿和 jitter 才像人 |
| 沿路径排字、文字绕弧 | `pathSampler(spec)` + `drawOnPath(ctx, lay, path, …)` | typography · textfx.js | 0.7 ms；曲率大的地方中文字会挤在一起 |
| 数字滚动、里程表、老虎机 | `odometer(value, digits)` + `drawDigits` / `digitAdvance` | typography · textfx.js | 0.3 ms；滚动时间太长，数值早就读不清了 |
| 翻牌、逐字 3D 翻转 | `glyphSprites` + `drawFlip(ctx, sprite, cx, cy, angle, {mode:'strips'\|'affine'})`、`IN.flipAffine` | typography · textfx.js | 3.1 ms；条数少时竖笔画会出现台阶，仿射模式没有近大远小 |
| 波浪、脉冲、抖动强调 | `EMPHASIS.wave` `EMPHASIS.pulse` `EMPHASIS.jitter` | typography · textfx.js | 0.3 ms；整句一直波动，看起来就是字在抖 |
| 文字 Magic Move、词序重排 | `matchUnits(a, b)` + `drawMorphText` | typography · textfx.js | 0.2 ms；前后没有共享的字时，退化成交叉淡化 |
| 模糊对焦（blur → sharp） | `IN.blur({radius})` | typography · textfx.js | `ctx.filter` 在软件渲染下很慢 |
| 字重 / 可变轴动画（wght、wdth、opsz） | `ctx.font` 改字重；任意轴用 `setAxes(ctx, axes, font)` / `clearAxes` | typography · text.js | 【非标准】依赖 Chromium；advance 变化会把整行推开 |
| 字幕、逐词高亮、卡拉 OK | `drawCaption(ctx, vo.captionAt(t), opts)` / `layoutCaption` | typography · text.js | 时间轴必须来自 narration.json |
| 中文断行、标点挤压 | `wrapCJK(ctx, text, maxW)` `layoutCJK(ctx, text, size, {punct})` | typography · text.js | 见 typography SKILL.md |
| **2D 动效与编排** | | | |
| 缓动曲线、区间进度、进出场包络 | `EASE` `easeOf` `resolveEase` `easeInfo` `envelope(t, enter, exit)`；`win(t, start, dur, ease)` 在 core · motion.js | motion · choreo.js | 纯算术；缓动表见 `references/transitions.md` |
| 交错（从中心/网格/随机） | `stagger(n, {each\|amount, from, grid\|positions, axis, ease, seed})` | motion · choreo.js | 参数表见 `references/transitions.md` §8 |
| 时间轴编排、剪辑点；卡节拍 | `timeline(items, {start, end})` `cutsFrom(start, durations)`；`beatGrid(bpm, offset, beatsPerBar)` 在 core · motion.js | motion · choreo.js | 见 `references/transitions.md` |
| 弹簧、回弹、过冲；弹簧跟随、中途改目标、胶囊拉伸 | `spring({duration, overshoot})` `SPRING` `settle` `zetaForOvershoot`；`follow(t, stops, sp)` `pill(t, stops, …)` `labelAlpha` | core · motion.js | 过冲用在正文上显得廉价；`follow` 每次求值的开销为 O(关键帧数) |
| 跟随某个元素的位置（锚点） | `createAnchors(canvas)` | core · anchors.js | 见 core SKILL.md |
| 确定性随机、抖动取值 | `seeded(seed)` `hash01(...keys)` `hashRange` | core · rand.js | 纯函数 |
| 多画幅自适应布局 | `makeLayout(formatKey)` / `layoutFromURL` → `L.size()` `L.place()` | core · layout.js | 多一层坐标换算 |
| **矢量形状** | | | |
| 描边生长、线条描出来、路径动画（trim path）、两端收、跑动光段 | `trim(path, start, end, offset, {each})` + `tracePath(ctx, shape)`；采样器 `pathSampler(d)` | motion · shapes.js | 每次 < 0.01 ms（Node）；整条路径匀速生长时，弧长短的子路径一闪就过 |
| 形状变形、图形变成另一个图形（flubber 式 morph）、一个分裂成几个 | `morph(a, b, {samples, align, winding, pair, orphans})` → `m(p)` | motion · shapes.js | 建表 0.2–2.4 ms，每帧 < 0.01 ms（Node，32–1000 点）；只是逐点直线插值，差异大的形状中段会"揉"，见 `references/shapes.md` |
| 沿路径运动并自动朝向 | `along(path, p, {orient, lookahead})` | motion · shapes.js | 纯查表；lookahead 平滑拐角的代价是急弯里切内道 |
| 圆、圆角矩形、正多边形、星形（给 morph 当起止） | `circle` `ellipse` `roundRect` `polygon` `star` → d 字符串 | motion · shapes.js | 只给几何 |
| **三维与后期** | | | |
| 着色器背景、烟/云/墨流、置换、色差、调色颗粒 | `createShaderLayer(o)` + `GLSL.noise/hash`；模板 `TEMPLATES.t1_fbm/t2_warp/displace/chroma/grade/bright` | webfx · webfx.js、templates.mjs | 1080×1920 下：T0 3.6 / T1 5.3 / T2 21 / T3 40 / T5 144 ms |
| 2D 大半径模糊、2D 景深 | `ctx.filter='blur(Npx)'` 或 `TEMPLATES.t4_blur25` | webfx · templates.mjs | 13–16 ms / 41 ms |
| 3D 场景、PBR、模型 | `createStage3D(o)` | webfx · stage3d.js | 基准场景约 8 ms 起 |
| 泛光、辉光（bloom）；体积光、god rays | `createPost(S, {bloom})`；`createPost(S, {godrays})` | webfx · post3d.js | +35.6 ms，只想让画面「柔一点」时用不着；体积光 +23 ms |
| 景深、拉焦、背景虚化 | `createPost(S, {dof})` | webfx · post3d.js | +78 ms，是最贵的一项；blur=0 的帧会整条跳过 |
| 色差、颗粒、暗角、扫描线、故障 | `createPost(S, {chroma, grain, vignette, scanlines, glitch})` | webfx · post3d.js | 合并成一遍为 +18.7 ms（在直通的 +11 之上几乎不额外花钱） |
| 3D 粒子 | `createParticles(S, o)`（GPU 闭式）/ `createCPUParticles(S, o)` | webfx · particles3d.js | 1 万个粒子分别为 +0.9 / +1.3 ms |
| **物理与粒子** | | | |
| 抛物线、落地弹跳、物理弹簧、摆、轨道 | `ballistic` `bounce` `spring(t, x0, v0, target)` `pendulum` `orbit` | physics · closed.js | 闭式解：2000 个粒子 0.5 ms；做不了物体之间的相互作用 |
| 粒子发射、爆发、飘散 | `emitter({seed, rate, life, loop})` `burst(t, {at, count})` | physics · closed.js | 开销为 O(rate × life)，与片长无关；循环不额外花钱 |
| 屏震、顿帧、闪白、压扁、拖尾、噪声晃动 | `hitShake(t, hits, {amp, decay, freq})` `hitstop` `flash` `squash` `trail(pos, t, n, dt)` `wobble` | physics · closed.js | 震得多了字幕读不清；顿帧会占用时间轴；闪白有光敏风险；拖尾在定步重放下开销大 |
| 碰撞小球、布料/绳、鸟群、流体 | `balls` `cloth` `boids` `fluid` + `createReplay({fps, init, step, clone})`；预烘焙回放 `loadBake(baseUrl)` → `makeTrack` | physics · sims.js、replay.js、baked.js | 每步 0.03–13 ms，fluid 超过 1000 个粒子基本只能预烘焙；烘焙后 300 个球 0.04 ms/帧，改参数要重新烘焙 |
| 跟车、堵车、排队链式传播 | `chain` `chainDesign` `chainProbe` | physics · chain.js | 每步 0.03–0.17 ms |
| 快进、慢镜头、定格、倒放 | `timeMap(keys, {reverse})` `fitRate` | physics · timemap.js | 见 physics timemap.md |
| **声音与时间** | | | |
| 画面卡旁白某个词 | `makeNarration(data)` / `loadNarration` → `vo.at(kw)` `vo.endOf(kw)` `vo.after(kw, d)` | narration · narration.js | 见 narration SKILL.md §四 |
| 合成音效（click pop thump whoosh tick chime sweep noise） | `SOUNDS` + `renderCues` / `renderStereo` → `toWav` / `toWavStereo` | narration · sfx.mjs | 没有授权风险；模仿真实物件的声音听起来廉价 |
