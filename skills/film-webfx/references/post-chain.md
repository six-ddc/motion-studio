# 显式三维后期链

目录：1 选链 · 2 结构与逐帧参数 · 3 最小接法 · 4 离线曝光 · 5 成本与局限

## 1. 选链

用 `post3d.js` 的 `createPost(S, cfg)`。结构在加载期确定；逐帧把已启用效果的参数传满，漏项报错。
旧接法见 `three.md`：不开下列扩展，旧输出保持逐像素一致。

```text
旧链：HDR 场景 → [阈值泛光 / 景深 / 径向光柱] → 故障/色差 → 相加泛光/光柱
    → three 的曝光/色调映射/sRGB → 暗角/扫描线/均匀颗粒 → 预乘 alpha
显示链：HDR 场景 → [深度 AO / 阴影步进雾] → [泛光 / 景深 / 径向光柱]
    → 故障/色差（场景） → 泛光/脏污/横向拉丝/太阳眩光 → 曝光
    → 映射曲线混合 → 显示线性域调色 → 精确分段 sRGB → 暗角/扫描线
    → [方向边缘 FXAA / 退让式锐化 / 三角颗粒 / 去色带抖动] → 预乘 alpha
```

打开 `tonemap:{curves:[...]}` 选显示链；`grade`、`finish` 和镜头三项依赖它。
AO、雾、混合泛光也能接旧链。两种泛光任选：`add` 用阈值提亮；`mix` 无阈值地扩散能量，最终混合而不加亮整幅。
相加的代价是高强度时整体发白；混合的代价是原亮点会失去部分峰值。Karis 加权会额外压低稀疏极亮点。

## 2. 结构与逐帧参数

所有颜色为线性 RGB 数组，长度必须正确；标有像素的半径按最终画面像素给出。下表的 P 是每帧参数。
结构的分辨率和采样数属于工程成本参数；颜色、幅度、时间常数由片子选择。

| 效果 | cfg（加载期） | P（逐帧） |
|---|---|---|
| 泛光 | `bloom:{mode:'mix',levels:5,resolution:.5,karis:.6,clamp:65504}` | `bloom:{strength,radius}`；`strength` 是最终混合量 0–1，`radius` 是上采样混合量 0–1；`add` 仍需 `threshold,knee,strength,radius` |
| AO | `ao:{samples:16,resolution:.5}` | `ao:{radius,intensity,strength,fade:[near,far],tolerance,lit:[low,high,suppress],tint:[r,g,b]}`；radius/fade 为米，tolerance 为相对深度差；亮度×曝光由 low→high 时，遮蔽按 suppress 退让；tint=1 的通道不被压暗 |
| 体积雾 | `volume:{steps:24,resolution:.5,light,horizonGLSL?,horizonUniforms?}` | 见下段；`light` 是已在场景中投阴影的平行光 |
| 脏污 | `dirt:{size:128,count:50,radius:[.004,.06],seed:72}` | `dirt:{amount,color}`；固定种子在加载期生成软圆斑纹理，radius 是纹理宽高比例，乘泛光再叠加 |
| 拉丝 | `streak:{samples:17,level:2}` | `streak:{amount,radius,color}`；从泛光第 level 级取样，radius 为横向像素半径，奇数采样数 3–65 |
| 眩光 | `flare:{ghosts:4}` | `flare:{light:[x,y,z]或lightUV:[u,v],amount,color,radius,haloRadius,haloStrength,haloWidth,spacing,ghostRadius,visibilityRadius,depthCutoff}` |
| 映射 | `tonemap:{curves:['aces','agx']}`，支持 `aces/agx/neutral` 的 1–2 条曲线 | `tonemap:{mix,agxLook:[power,saturation]}`；单曲线不需 mix，无 AgX 不需 agxLook；即使空也传 `tonemap:{}` |
| 调色 | `grade:true` | `grade:{shadow,highlight,lift,range:[low,high],contrast,saturation}`；亮度在 range 内把暗/亮部乘色平滑混合，contrast 混合 S 曲线，lift 按 `1−亮度` 抬黑，再按亮度调饱和度 |
| 收尾 | `finish:{fxaa:true,sharpen:true,grain:true,dither:true}`，可独立选项 | `finish:{fxaa:{edgeThreshold,subpixel},sharpen:{amount,edgeThreshold},grain:{amount,fps,size,darkWeight},dither:{amount}}`；只需已启用子项 |

体积雾的 P 全量为：

```js
volume: {
  sigma, maxDist, skyDistance, shadowBias, ambientShadow, sun:[r,g,b], ambient:[r,g,b],
  height:[baseY,scaleHeight,bottomFraction], far:[extinctionScale,horizonGain,ambientGain],
  phase:[gForward,gWide,forwardWeight,phaseCap], near:[nearWeight,farWeight,start,end],
  tolerance, farColor:[r,g,b] // 拼 horizonGLSL 时改用它的 horizonColor，不需 farColor
}
```

`sigma` 单位 1/米；密度为 `sigma·(bottomFraction+(1−bottomFraction)·exp(−max(y−baseY,0)/scaleHeight))`。
步进查太阳当帧阴影图，以 `acc+=T·source·(1−exp(−sigma·ds))` 积分；IGN 只由屏幕坐标决定。
`sun/ambient` 是散射源辐亮度；HG 的两个 g 必须在 (−1,1)，forwardWeight 混合两瓣。
`near` 的最后两项、`maxDist/skyDistance/scaleHeight` 都是米；超出 maxDist 的几何用高度密度梯形积分延续到远景。
`ambientShadow` 控制阴影内残留的环境光比例；shadowBias 是归一化阴影深度偏移。
接天空用 `volume:{...,horizonGLSL:SKY_GLSL,horizonUniforms:rig.uniforms()}`，`horizonColor(vec3 worldDir)` 与 uniform 约定见 `sky.md`；声明的 uniform 槽缺失/非有限数或与内部名字冲突会报错。

眩光的 UV 以左下为原点。除 visibilityRadius 是像素外，半径以画面高度为单位；spacing 控制太阳到画面中心这条线上幽灵的间隔。
每帧对太阳周围 3×3 深度采样，深度达到 depthCutoff 才算可见，太阳在镜头后或屏幕外自动退让。
作为天空显示的太阳圆盘设 `depthWrite:false`，否则其自身深度会挡住眩光；真正的前景遮挡物继续写深度。
finish 的 FXAA 在编码域按亮度边缘方向取样（亮度存在中间 RT 的 alpha）；锐化是四邻域反锐化，强边缘按阈值退让。
三角颗粒为两个独立均匀哈希之差，按 `floor(t·fps)` 播种；size 是像素格，darkWeight 控制暗处相对权重。
抖动与帧号无关，幅度为 `±amount/255`。H.264 yuv420 会吃掉细颗粒和小抖动，判断效果要同时看编码成片。

## 3. 最小接法

```js
import { createPost } from './runtime/post3d.js';
const post=createPost(S, {bloom:{mode:'mix',karis:.6},tonemap:{curves:['aces','agx']},
  finish:{fxaa:true,dither:true}});
S.freeze();
window.seek=t=>S.frame(t,()=>{ /* 从 t 设置相机与物体 */ },{
  exposure:1,bloom:{strength:.12,radius:.7},tonemap:{mix:.35,agxLook:[1,1]},
  finish:{fxaa:{edgeThreshold:.12,subpixel:.75},dither:{amount:1}}
});
```

以上数值只是示例，不是套件默认审美。完整的逐项/全开对照是本仓库夹具 `_test-post`，不随安装。
粒子高光、几何遮挡、粗糙度梯度先在 HDR 场景里成立，再选镜头层；泛光没法恢复被截成 1 的亮部信息。

## 4. 离线曝光

固定曝光直接传 `P.exposure`。需要适应亮暗场时，先离线扫一次，不在 seek 里累积平均值：

```js
// 在开发测量脚本中跑；seek 自身仍然只从 t 求值。measure 是当前帧曝光前 HDR 的 32×18 对数平均亮度。
const table={fps:4,logAvg:[]};
for(let i=0;i<=Math.ceil(DURATION*table.fps);i++){
  await window.seek(Math.min(DURATION,i/table.fps));table.logAvg.push(post.measure());
}
// 将 table 保存成片内 JSON，正式页面在 ready 里读取，然后加载期一次完成平滑。
const exposure=exposureTrack(table,{key:.2,power:.5,min:.25,max:4,tau:.6});
// 每帧传 exposure(t)。表外钳到两端；tau 秒的因果指数平滑在对数亮度域完成。
```

`exposureTrack` 从 `post3d.js` 导入，power=1 完全补偿到 key，较小值保留场景亮暗差。查表线性插值，乱序调用不改变结果。
measure() 会同步读回 GPU，代价只在扫片阶段付；它量的是场景，未包含 AO/雾/镜头层。测光布局固定，先确认采样能覆盖主体。

## 5. 成本与局限

1080×1920、本仓库简单柱廊/四球夹具，预热后 7 次读回阻塞计时的中位数，单位 ms/帧（整帧，含场景/阴影/显示链）。
并行开发会竞争资源，以下用于比较量级；SwiftShader 与 Metal 不是相同像素。

| 配置 | SwiftShader，AO/雾半分辨率 | SwiftShader，AO/雾全分辨率 | Metal，AO/雾半分辨率 / 全分辨率 |
|---|---:|---:|---:|
| 仅显示链 | 35.3 | 36.4 | 1.8 / 2.0 |
| 加混合泛光 | 90.1 | — | 2.1 / — |
| 加 AO 16 采样 | 86.4 | 142.0 | 2.8 / 3.1 |
| 加体积雾 24 步 | 125.8 | 238.1 | 2.1 / 3.6 |
| 全开 | 269.7 | 447.9 | 5.0 / 6.4 |

- AO 只见屏幕内深度；轮廓会有光环，透明物体缺遮挡。按亮度退让只是环境光近似，不能真正分离直射/自发光/间接光。缩半分辨率会丢掉细接触；增大 tolerance 会跨边缘漏遮蔽。
- 雾使用透视相机与单个平行光的深度阴影，不支持正交相机/VSM/彩色透明遮挡。阴影相机范围外视为受光，扩大拟合范围的代价是阴影精度下降；步数低时可能出现条带，提升步数/分辨率会直接增加成本。
- 解析远景是高度密度梯形近似，不继续追踪阴影；镜头里很长的低空斜视线需要更多步进距离。天空/环境反射同步问题见 `sky.md`。
- 眩光无帧间平滑，遮挡边界可能跳变；增加采样半径让遮挡更柔，代价是细遮挡物被淡化。横向拉丝取低 mip，细光源会变宽。
- 显示链的 RGB 在映射后钳到 0–1；FXAA 不能恢复亚像素几何，退让锐化不替代更高采样。镜头层主要面向有背景的画面，透明画面的覆盖度仍由场景/泛光决定。
- 时间运动模糊仍由 film-core 的子帧平均完成，不在这里重复做相机速度模糊。无自动曝光积分、TAA、SSR；曝光表方案不引入历史状态。
