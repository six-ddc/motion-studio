# 程序化贴图、湿地面与事件特效

目录：分层与尺度 · 贴图烘焙 · 湿地面与反射 · 火花烟火 · 代价与局限

## 1. 按形成原因分层

把颜色、粗糙度、法线分开控制。漆脱落时同时露出底层的颜色、金属度、粗糙度与高度，只换颜色会像印花。用低频簇控制破损分布，高频噪声控制边界；均匀撒点会让整件物体失去干净的主形。
地面先做覆盖整个场景的唯一遮罩，再叠两个不整比尺度的细节。湿润按积水→浸湿→潮湿→干燥连续变化，硬阈值会露出遮罩像素。所有色值和尺度从本片传入。
模型的外形见 `modeling.md`，物体表面的湿度/污垢/抗闪烁见 `surfaces.md`，天与环境光同源见 `sky.md`。

## 2. 加载期烘焙：texture3d.js

```js
import { bakePaint } from './runtime/texture3d.js';
// 这是示例物体自己的色板，线性 RGB；不作为套件默认。
const palette = {
  paint:  {color:[.04,.12,.2], roughness:.4, metalness:.1},
  primer: {color:[.2,.16,.13], roughness:.7, metalness:0},
  rust:   {color:[.19,.06,.02], roughness:.9, metalness:0},
  metal:  {color:[.3,.31,.33], roughness:.3, metalness:1}
};
const T = bakePaint({size:256, seed:13, tileMeters:1, palette,
  layers:[{period:8, amplitude:.001}, {period:32, amplitude:.0004}],
  damage:{amount:.52, softness:.4, depth:.001, period:4}});
const material = new THREE.MeshStandardMaterial({map:T.map, normalMap:T.normalMap,
  aoMap:T.aoMap, roughnessMap:T.roughnessMap, metalnessMap:T.metalnessMap,
  roughness:1, metalness:1});
```

`bakePaint` 输出共享 ORM（R=AO，G=粗糙度，B=金属度）、法线、反照率、`height` 米数组与破损遮罩 `masks`。`damage.amount` 控制覆盖，`softness` 控制层间过渡，`depth` 是漆层厚度米；`period` 是每个贴图周期里的簇数。`layers` 为可平铺高度噪声，`amplitude` 单位米。
色板使用线性数据，贴图设 `NoColorSpace`；若把十六进制 sRGB 色直接除255传入，会高估反照率。ORM 与法线也不做 sRGB 解码。AO 的减弱量只是脱漆凹陷的近似，不是几何遮挡烘焙。

单独使用 `bakeHeight({size,seed,layers})`、`normalFromHeight(height,size,tileMeters)`、`tileNoise(x,y,period,seed)` 与 `dataTexture(rgba,size,{repeat})`。中心差分除以实际米制采样间距，换纹理分辨率时不会改变凹凸强度。
CPU 烘焙时间随 `size² × 层数` 增长；加载期付一次，seek 只采样。`T.dispose()` 释放共享纹理，不要分别释放同一张 ORM 多次。

自定义 GPU 烘焙用 `bakeShader(renderer,{size,fragmentShader,uniforms,type}) → WebGLRenderTarget`。片元输入 `varying vec2 vUv`；输出线性数据。返回目标由调用方释放。函数恢复目标、viewport、scissor；在加载期调用，避免 seek 中创建资源。多个输出通道可分次烘焙，不内置 MRT。

## 3. 湿地面与当帧反射：ground3d.js

```js
const mask = bakeGroundMask({size:256, seed:7, bounds:[-6,-6,12,12],
  heightRange:[-.08,.08], macroMeters:3,
  pits:[{x:6,z:6,rx:3,rz:2,depth:.06}]});
const reflection = createPlanarReflection(S,
  {height:0,width:512,resolution:512,clipBias:.001,hide:[ground]});
const wet = applyGround(ground.material, {mask,reflection,
  dryColor:[.22,.24,.27],wetColor:[.07,.09,.12],roughness:[.8,.5,.2,.045],
  tileMeters:[3.7,.61],seam:{spacing:2,width:.035,depth:.005},
  transition:{damp:.06,soak:.025,puddle:.015},
  ripple:{scale:2,speed:6,amplitude:.015}});
// 在 freeze 前建立上述资源；在 S.frame(t, paint) 的 paint 最后执行：
wet.set({t,waterLevel:0,wetness:1});
reflection.render(); // 此时相机、物体、天空都已按 t 设置
```

物理长度以米计，`bounds=[x0,z0,width,depth]`；坑的 x/z 是相对该原点的米坐标。反射目标的 `width/resolution` 分别是纹理宽/高的像素数，烘焙 `size` 也是像素数。遮罩 RGBA 分别为高度/潮湿/油污/磨损，clamp 到区域并平滑淡出。`heightRange` 用于8位高度编码，微小水位变化会受量化影响，提高纹理分辨率不能提高高度位深。
粗糙度四项依次为干/潮/浸湿/积水，A通道磨损在非积水区作 ±.025 的粗糙度调制。斜坡宽度 `transition` 单位米（高度差）；粗细颗粒尺度 `tileMeters` 单位米；`ripple.scale` 每米周期数、`speed` 弧度/秒，`amplitude` 为法线斜率。这里涟漪是闭式周期扰动，不是真实水动力或逐滴冲击模拟。

平面限定世界 y=`height`，只支持透视相机。镜像相机用斜近平面剔除水面下几何，采集线性 HDR，mip 模糊后的反射替换环境镜面输入，保留标准 PBR 菲涅耳。一次额外场景绘制；反射接收面全部放进 `hide`，避免反射自己；不递归支持多面镜。`reflection:null` 可关闭。反射不是 SSR，能看见主镜头画外的物体。
平面下看、穿过平面的镜头、透明物体的排序和多个互相反射面需要单独设计；通用地形/倾斜水面不在此工具范围。反射应与主画面共用后期映射，反射目标里不先做色调映射。

## 4. 烟火花：spritefx3d.js

`bakeSmokeAtlas({cellSize,columns,seed,erosion,lobes})` 在加载期生成 `columns²` 格 RGBA 图集（法线XY/厚度/透明度）。同一团成簇密度随寿命侵蚀，边缘透明留缝；关闭 mip 防串格。法线是二维密度导数近似，厚度不是实际体积积分。

```js
const atlas = bakeSmokeAtlas({cellSize:64,columns:4,seed:9,erosion:.7,lobes:7});
const smoke = createSpriteFX(S, {mode:'smoke',atlas,
  events:[{t:.2,life:1.4,origin:[0,.5,0],velocity:[0,.8,0],size:.4,seed:3}],
  gravity:[0,.1,0],drag:.3,colors:[[.55,.59,.65],[.18,.22,.28]],opacity:.5,
  stretch:0,minPixels:1,maxPixels:200,blending:'normal',
  light:{direction:[2,5,3],color:[1.2,1.05,.8],ambient:[.25,.3,.4],wrap:.5,backscatter:.7}});
S.scene.add(smoke.mesh); // 加载期
// 每帧在相机更新后调 smoke.update(t)
```

`mode:'spark'` 用瞬时透视投影速度方向拉长的实例四边形，`stretch` 为拖影秒数，不要套用点精灵的最大点尺寸；像素宽度下限配透明度补偿避免远景闪烁。这里不含相机运动的速度模糊，完整运动模糊仍用子帧平均。`colors` 是初/末线性 HDR，降温随寿命插值。直出时先色调映射/编码再预乘，HDR目标保持线性。
`mode:'flame'` 使用同一图集的厚度与寿命色，不要求光照表；用 normal 混合时，前景烟可以遮挡火焰。add 的代价是亮度不断相加且不能遮挡。
烟使用包裹漫反射与逆光近似；重叠烟团仍依赖透明排序，不是体积多次散射。GPU 内实例不能逐粒深度排序；需要时在加载期按镜头分组，或使用较低不透明度。
`softDepth:{texture,width,height,near,far,distance}` 可接同一相机**当帧**不含粒子的深度图；distance 为淡交界宽度米，解决烟切入地面的硬边。反射副相机不使用主相机这张图，副视角的软交界需独立深度。深度图用前一帧会破坏乱序确定性，见本仓库 `_test-worldfx` 的不含粒子预绘制示例。
`particleState(age,{origin,velocity,gravity,drag})` 提供 CPU 侧同类解析弹道，`rainPosition(i,t,{seed,box,velocity,center})` 提供跟随相机的周期雨盒位置。碰撞与力场积分仍走 film-physics。

## 5. 代价与验证

本仓库 `_test-worldfx`：128²破损贴图/唯一遮罩、256²平面反射、50火花+12烟+1火焰。`tests/unit.mjs` 检查周期、米制法线、ORM、解析弹道对 RK4、侵蚀与雨盒；`tests/browser.mjs` 检查反射/湿度/软粒子开关真的改变画面、反射随当帧改变、乱序重现与烘焙状态恢复。
运行 `dev/film-webfx/worldfx-bench.mjs` 测预热后 `seek + readPixels` 的真实完成耗时；设备、分辨率、场景成本会改变结果，数字见仓库 `docs/verified/film-webfx.md`。
本页能力均可选，不引入交付门。色板、材质参数和烟火花配方应按本片意图调试；局部验证不等于整片观感已经验收。
