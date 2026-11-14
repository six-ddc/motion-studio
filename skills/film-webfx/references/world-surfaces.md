# 程序化贴图、湿地面与事件特效

目录：分层与尺度 · 贴图烘焙 · 湿地面与反射 · 火花烟火 · 代价与验证

## 1. 按形成原因分层

颜色、粗糙度、法线分开控制：漆脱落时同时露出底层的颜色、金属度、粗糙度与高度，只换颜色像印花。低频簇管破损分布、高频噪声管边界；均匀撒点的代价是物体失去干净的主形。
地面先做覆盖全场的唯一遮罩，再叠两个不整比尺度的细节；湿润按积水→浸湿→潮湿→干燥连续变化。所有色值、尺度、幅度从本片传入，缺了报错。
外形见 `modeling.md`，物体表面湿度/污垢/抗闪烁见 `surfaces.md`，天与环境光同源见 `sky.md`。

## 2. 加载期烘焙：texture3d.js

```js
import { bakePaint } from './runtime/texture3d.js';
const T = bakePaint({size:256, seed:13, tileMeters:1,
  palette:{paint:{color:[.04,.12,.2],roughness:.4,metalness:.1}, primer:{color:[.2,.16,.13],roughness:.7,metalness:0},
           rust:{color:[.19,.06,.02],roughness:.9,metalness:0}, metal:{color:[.3,.31,.33],roughness:.3,metalness:1}},
  layers:[{period:8, amplitude:.001}, {period:32, amplitude:.0004}],
  damage:{amount:.52, softness:.4, depth:.001, period:4, detail:.2, stages:[[0,.25],[.25,.5],[.8,.2]], ao:.2}});
// 示例物体自己的色板（线性 RGB），不是套件默认
const material = new THREE.MeshStandardMaterial({map:T.map, normalMap:T.normalMap, aoMap:T.aoMap,
  roughnessMap:T.roughnessMap, metalnessMap:T.metalnessMap, roughness:1, metalness:1});
```

破损度 `d = sat((amount − (簇·(1−detail) + 细·detail)) / softness)`；`stages` 依次是 primer/rust/metal 露出的 `[起点, 宽度]`（窄 = 层间硬边，宽 = 糊成一片）；`ao` 是完全露底处的 AO 减弱（凹陷近似，不是几何遮挡）；`depth` 漆层厚度米；`period` 每周期簇数；`layers.amplitude` 米。
输出共享 ORM（R=AO，G=粗糙度，B=金属度）、法线、`height` 米数组、`masks`。反照率按 sRGB 编码存 8 位（`SRGBColorSpace`，硬件解码回线性）：线性 8 位存暗部会出色带。把十六进制 sRGB 色直接除 255 当线性传入会高估反照率。
单独可用：`bakeHeight`、`normalFromHeight(height,size,tileMeters)`（按米制采样间距差分，换分辨率不改凹凸强度）、`tileNoise`、`dataTexture(rgba,size,{repeat,colorSpace})`。CPU 时间随 `size² × 层数`；`T.dispose()` 释放共享纹理。
`bakeShader(renderer,{size,fragmentShader,uniforms,type})` 是 GPU 加载期烘焙：输入 `varying vec2 vUv`，返回 RT（调用方释放），恢复目标/面/mip/viewport/scissor；不内置 MRT。

## 3. 湿地面与当帧反射：ground3d.js

```js
const mask = bakeGroundMask({size:256, seed:7, bounds:[-6,-6,12,12], heightRange:[-.08,.08],
  pits:[{x:6,z:6,rx:3,rz:2,depth:.06}],
  layers:{height:{meters:3,range:[.35,.75]}, damp:{meters:2.1,lowBias:.4},
          oil:{meters:3,detailMeters:.6,bias:.3,gain:3}, wear:{meters:1.2}}});
const reflection = createPlanarReflection(S, {planeY:0, size:[512,512], clipBias:.001, hide:[ground]});
const wet = applyGround(ground.material, {mask, reflection,           // 材质 roughness:1 时下面的粗糙度就是绝对值
  dryColor:[.22,.24,.27], wetColor:[.07,.09,.12], roughness:[.8,.5,.2,.045], tileMeters:[3.7,.61],
  grain:{albedo:.12,roughness:.05,height:.002}, seam:{spacing:2,width:.035,depth:.005,darken:.3},
  oil:{darken:.2,roughness:.08}, wear:{roughness:.05}, transition:{damp:.06,soak:.025,puddle:.015},
  ripple:{layers:[{cell:.83,rate:1,angle:0,weight:1},{cell:1.31,rate:.87,angle:.64,weight:.9},{cell:.57,rate:1.13,angle:1.57,weight:.6}],
    density:.66, radius:[.1,.36], width:[.005,.025], amplitude:.3, fade:[10,34]}});
// freeze 前建好；paint 最后：
wet.set({t, waterLevel:0, wetness:1}); reflection.render(); // 相机、物体、天空都已按 t 设好
```

遮罩 RGBA = 高度/潮湿/油污/磨损，米制 `bounds=[x0,z0,width,depth]`，坑坐标相对原点；`layers.*.meters` 是噪声格尺寸，`oil/wear` 可为 null。高度按 `heightRange` 编 8 位，提分辨率不提高度位深。区域外按"最高、干、无油"处理并在边缘 5% 渐变。

| `applyGround` / `createPlanarReflection` 参数 | 单位 / 有效域 | 控制什么 |
|---|---|---|
| `dryColor`、`wetColor` | 线性 RGB ≥0，乘在材质 color 上 | 干处 / 浸湿处反照率（积水再叠反射） |
| `roughness` | 4 个 0–1：干/潮/浸湿/积水 | **乘**到材质已有粗糙度上（叠 surface3d 时按补丁顺序）；积水档小 = 镜面 |
| `tileMeters` | `[粗, 细]` 米 | 两层颗粒噪声的格尺寸，取不整比防重复 |
| `grain` | `albedo` ±比例、`roughness` ±量、`height` ±米 | 颗粒对反照率、粗糙度、水深的扰动 |
| `seam` | `null` 或 `spacing/width` 米、`depth` 米、`darken` 0–1 | 方格板缝 |
| `oil`、`wear` | `darken` 0–1、`roughness` 0–1 | 遮罩 B/A 通道处的压暗与粗糙度调制（A 0.5 为中性） |
| `transition` | `damp/soak/puddle` 米高差 >0 | 三段湿润斜坡宽度；窄 = 水边硬 |
| `set({t, waterLevel, wetness})` | 秒、米（世界 y）、0–1 | 每帧：涟漪时间、水位、总湿度 |
| 反射 `planeY`、`size`、`clipBias`、`hide` | 米、`[宽,高]` 像素、斜近平面偏移（≈0.001）、接收面数组 | 镜面高度、反射分辨率（大 = 倒影更锐，代价按像素数）、防平面上几何漏裁 |

最小可跑：`pits:[]`、`layers.oil/wear:null`、`seam:null`、`ripple:null`，颜色填同一中性灰、其余取上表区间中段——是**占位**不是观感；全参数例子见本仓库夹具 `tests/fixtures/_test-worldfx/scene.js`。
`ripple` 是闭式雨滴：每层按 `cell` 米分格，每格每个周期 `floor(t·rate·抖动)` 换一滴（位置、大小、强度），寿命 = 小数部分；环剖面是高斯导数，宽度从 `width[0]` 长到 `width[1]`（米），振幅 (1−寿命)² 衰减，`density` 是每格每周期出滴的概率，`radius` 是环最大半径占格的比例（≤ 0.45，环整个落在格内所以没有格缝）。层的 `angle` 旋转网格（打破对齐），`weight` 加权。每格速率抖动 ±50%、单滴强度 0.3–1 是模型常数。
`fade:[近,远]` 米外淡出：远处的环小于一像素，不淡出的代价是闪烁。`amplitude` 是法线斜率。`ripple:null` 关掉；它不是水动力模拟。
平面反射：镜像相机 + 斜近平面，只支持透视相机、单平面、不递归；采集线性 HDR、按粗糙度取 mip，替换环境镜面输入（保留 three 的菲涅耳）。多一次场景绘制。反射不是 SSR，能看见画外物体。
**低机位倒影的几何**：镜面里看到的是"镜像相机"看见的东西——近地平线的天（低仰角的日/月盘会被镜成地上一个亮斑）、物体的底面与背面；贴地物体（砧上的钢坯）的倒影常被它自己的底座挡掉。
写镜头时先用 `reflectionOf(camera, planeY, [x,y,z] | {dir}, [宽,高])` 查：返回倒影的屏幕位置 `px`、`onScreen` 和它"看上去"所在的地面点 `ground`（拿去对积水遮罩）。
画面里出现说不清来源的亮斑时，跑 `scripts/lightdebug.mjs --film <slug> --at <t> --rect x,y,w,h`：逐个关掉每盏灯、环境/IBL、日盘、日晕、天空、雾、平面反射、涟漪、自发光、加色粒子、泛光，报区域/最亮像素的线性亮度差，并打印日盘倒影的落点。每个源多渲一帧（1080p SwiftShader 约 6 s/帧），`--only` 缩小范围。未注入钩子时运行时只做一次空的可选链调用，输出不变。
**反射必须在 paint 里、相机与物体按 t 设好之后渲染**：画完这一帧再更新、下一帧再用（游戏的常见做法）会读到上一帧的 RT。默认 `reset:true` 时舞台把反射矩阵还原到 freeze 值，过期反射整个落到画外（看起来是"反射消失"）；`reset:false` 时就是门 1a/2 红（本仓库阴性对照 `_test-worldfx/scene-bad-reflect-prevframe.html`）。

## 4. 火花烟火：spritefx3d.js

和 `particles3d.js` 的分工：那边是点精灵 + 片子自写的闭式运动，适合大量同质粒子；这里是实例四边形 + 事件表 + 闭式阻力弹道，自带速度拉长、受光烟图集、深度软交界。

```js
const atlas = bakeSmokeAtlas({cellSize:64,columns:4,seed:9,erosion:.7,lobes:7});
const smoke = createSpriteFX(S, {mode:'smoke', atlas,
  events:[{t:.2,life:1.4,origin:[0,.5,0],velocity:[0,.8,0],size:.4,seed:3}],
  gravity:[0,.1,0], drag:.3, colors:[[.55,.59,.65],[.18,.22,.28]], opacity:.5, stretch:0, minPixels:1, maxPixels:200,
  blending:'normal', grow:{size:2.4,fadeIn:.12},
  light:{direction:[2,5,3],color:[1.2,1.05,.8],ambient:[.25,.3,.4],wrap:.5,backscatter:.7}});
S.scene.add(smoke.mesh);  // 加载期；paint 里相机更新之后 smoke.update(t)
```

图集 `columns²` 格（法线 xy/厚度/alpha），同一团密度随寿命侵蚀；格边留透明、不生成 mip。法线是二维密度导数近似。`grow`（烟/火必填）= 寿命末尺寸倍数与淡入占寿命比例：倍数大 = 烟团散得开，淡入短 = 出现时有硬跳。
`spark` 按透视屏幕速度拉长，`stretch` 为拖影秒数；像素下限配面积比补偿 alpha 防远景闪；不含相机速度模糊（用子帧平均）。`colors` 初/末线性 HDR；直出时先映射/编码再预乘。`flame` 用同一图集的厚度；`add` 的代价是只会变亮、不能遮挡。
烟是包裹漫反射 + 逆光近似；实例不逐粒深度排序，重叠烟团的顺序靠加载期分组或降低不透明度。`softDepth:{texture,width,height,near,far,distance}` 接同一相机**当帧**不含粒子的深度（distance 米），解决烟切地面的硬边；用上一帧的深度会破坏乱序一致；反射副相机不用它。
`particleState(age,{origin,velocity,gravity,drag})` 是 CPU 侧同一条弹道，`rainPosition(i,t,{seed,box,velocity,center})` 是跟随相机的周期雨盒。碰撞与力场积分走 film-physics。

## 5. 代价与验证

本仓库 `_test-worldfx` 覆盖贴图、遮罩、反射、涟漪、火花烟火（`tests/` 下单测与浏览器断言），`dev/film-webfx/worldfx-bench.mjs` 测耗时，数字见仓库 `docs/verified/film-webfx.md`。全部是可选能力，不引入交付门；局部验证不等于整片观感已验收。
