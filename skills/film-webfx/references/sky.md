# 天空、环境反射与空气透视

目录：同源光照 · 天空与云 · 环境反射 · 解析高度雾 · 软阴影 · 前景层与代价

## 同源光照

天、雾、环境反射、环境光来自同一份 `rig`，反射与背景的光向才一致。色值和形状数字全部由片子给，缺一个报错（报错里写参考量级）；数组是线性 RGB（可 > 1），字符串按 sRGB 转换。

```js
import { createLightRig, createSky, createHeightFog, enablePCSS, pinForeground } from './runtime/sky3d.js';
const rig = createLightRig({
  sun: { dir: [-0.55, 0.27, -0.8], color: [1, 0.76, 0.5], intensity: 3 },
  sky: { zenith: [0.08, 0.16, 0.3], horizonSun: [1.5, 0.7, 0.3], horizonAway: [0.24, 0.38, 0.62],
    ground: [0.12, 0.09, 0.06], fog: [0.35, 0.36, 0.4], azimuthPower: 4, zenithHeight: 0.25, groundHeight: 0.2 }
}); // 暖色低角度光的一种配方，代价是暖色占大面积；数值按本片参照调
const sun = rig.createSun({castShadow:true,mapSize:1024,bias:-0.0002,normalBias:0.02});
S.scene.add(sun, sun.target, rig.createAmbient(0.25));
rig.fitShadow(sun, bounds, {margin:1}); // bounds：含投影物/接收面的世界 Box3；margin 米
```

| 参数 | 单位 / 有效域 | 控制什么 |
|---|---|---|
| `sun.dir` 或 `elevation`+`azimuth` | 向量 / 度（方位 0 指 −Z，90 指 +X） | 平行光、日盘、日晕、雾向阳瓣的方向。仰角低 + 低机位 = 日盘会被积水镜进画面（world-surfaces.md §3） |
| `sun.color`、`sun.intensity` | 线性 RGB；≥0（即 DirectionalLight.intensity） | 平行光；也乘日盘、日晕、雾向阳瓣 |
| `sky.zenith/horizonSun/horizonAway/ground/fog` | 线性 RGB ≥0（>1 为 HDR）或 sRGB `'#rrggbb'` | 天顶、向阳/背阳地平线、地平线以下；`fog` 也是雾色和 `createAmbient` 的天色 |
| `azimuthPower` | >0，常见 1–8 | 大 = 向阳地平线色集中在太阳方位；小 = 整圈地平线都是向阳色 |
| `zenithHeight`、`groundHeight` | sin(仰/俯角)，常见 0.1–0.5 | 地平线色带向天顶/地面过渡的高度；小 = 色带窄 |
| `halo` | 1–4 组 `[幂次 >0, 权重 ≥0]` | 日晕，幂次大 = 窄，权重 × 太阳色 × 强度 |
| `disk` | `angle` 视直径度（真实太阳 ≈0.53）、`intensity` ≥0 | 日/月盘，× 太阳色 × 强度；0 = 不画 |

最小可跑：颜色全填同一个中性灰 `[0.5,0.5,0.5]`、数字取上表区间中段、`clouds:false`——这是让几何和镜头先跑通的**占位**，观感为零，之后按 style_guide 逐项替换；缺什么报错会写单位和有效域。全部参数一起跑的例子：本仓库夹具 `tests/fixtures/_test-sky`。
`createAmbient(intensity)` 天色取雾色、地色取 ground；和 PMREM 叠加会抬高整体照明。
`SKY_GLSL` 导出 `skyToSun/horizonColor/skyGradient(vec3 worldDir)`（线性域）；uniform 名固定为 `uSkySunDir/uSkySunColor/uSkySunIntensity/uSkyZenith/uSkyHorizonSun/uSkyHorizonAway/uSkyGround/uSkyFog/uSkyShape`。
`rig.uniforms()` 返回新表，`rig.fill(table)` 更新已有槽。共享给后期：`horizonGLSL: SKY_GLSL, horizonUniforms: rig.uniforms()`。

## 天空与云

```js
const sky = createSky(S, rig, {
  halo:[[8,0.1],[64,0.4],[600,1.2],[6000,4]], disk:{angle:0.8,intensity:60},
  clouds:{altitude:900,featureSize:1200,wind:[20,4],coverage:0.72,softness:0.12,
    base:[0.25,0.29,0.4],dark:[0.04,0.06,0.09],light:0.8,rim:1.2,seed:17,octaves:4,shadowSteps:2,
    horizonLift:0.1,warp:1.3,detail:0.16,aerial:11,relief:4.5,opacity:0.985,veil:0.92,
    hole:{radius:5,feather:6,strength:0.9},gap:{away:2,sun:12,ragged:0.6}}
});
sky.update(t); // paint 里每帧；偏移 = wind·t/featureSize。第二参数可临时改 {coverage}
```

`halo` 1–4 组 `[幂次,权重]`：只有一层宽晕的代价是整片天发白。`clouds:false` 不算云。平面投影云层，体积感来自域扭曲与向光密度差，不是三维光线步进。

| 云参数 | 含义 | 代价 / 什么时候改 |
|---|---|---|
| `altitude/featureSize`（米）、`wind`（米/秒）、`aniso:[x,z]` | 投影高度、团块尺度、风、拉伸 | 尺度小 = 碎云多，近地平线更易走样 |
| `coverage` 0–1、`softness` | 覆盖率、边缘过渡带 | softness 小边缘硬，运动时闪 |
| `horizonLift` | 投影分母抬升 | 小 = 近地平线的云压扁成一条密带 |
| `warp`、`detail` | 域扭曲幅度、脊状细节比例 | 0/0 是规整软团；大了像卷积云，也更费 |
| `relief`、`light`、`rim` | 自阴影对比、侧光与亮边增益 | relief 0 = 平涂；高了云底发黑 |
| `aerial` | 近地平线向地平线色淡化的速度 | 大 = 淡化带窄、远云更"实" |
| `opacity`、`veil` | 最厚处不透明度、对日盘的遮挡 | 1/1 = 厚云完全挡天和太阳 |
| `hole`、`gap` | 太阳周围开洞、背/向阳云底仰角（度） | 构图选择，留空就不做 |
| `octaves` 1–9、`shadowSteps` 1–8 | 质量（默认 5 / 1） | 每多一步阴影重算一组 fbm，软件渲染明显变慢 |

云的明暗曲线（基色 × (0.55 + 0.9·relief²)、侧光 × (0.05 + 2.2·relief³)）是模型常数：它决定"背光处有多亮"，要整体更亮/更暗调 `base/dark/light`。

## 环境反射

加载期（`S.freeze()` 前）`sky.environment({at:0,clamp:5,intensity:0.8,size:128})`：返回 `{texture,renderTarget}` 并设 `S.scene.environment`。捕获时不画日盘、钳 HDR 上限，太阳只由平行光负责。
`apply:false` 只生成不赋值，可按镜头预拍多张、paint 里按 t 选。云在动而环境静止会有反射误差：镜面主体近景值得预拍几个时刻。

## 解析高度雾

```js
const fog = createHeightFog(rig, {density:0.012,baseHeight:0,scaleHeight:4,maxOpacity:0.85,sunStrength:0.04,sunPower:8});
S.scene.add(fog.node); fog.apply(material); // 标准材质；色调映射之前融色
```

密度 `density·exp(−(y−baseHeight)/scaleHeight)`（1/米；高度米，`maxOpacity` 0–1 是雾量上限，`sunStrength` ≥0 × 太阳色、`sunPower` 越大向阳瓣越窄），视线闭式积分，颜色取该方向地平线色；没有光柱遮挡（要有阴影的介质用后期体积雾）。
`HEIGHT_FOG_GLSL` 导出 `heightFogDepth/heightFogColor/applyHeightFog`，`fog.fill(table)` 同步给自写 pass。`fog.node` 上的数值由舞台复位，随 t 变的每帧写回。

## 软阴影

`enablePCSS(S, sun, materials, {sunAngle:3,maxRadius:0.5,samples:12,blockerSamples:8})`，舞台要 `shadows:true, shadowType:THREE.BasicShadowMap`，先 fitShadow。
`sunAngle` 太阳视直径（度），`maxRadius` 遮挡搜索半径（米），`minPenumbra`（米，默认 0）、`slope`（接收面梯度偏移上限，默认 0.003）。同一材质的所有阴影共用一个视锥尺寸：多盏不同视锥要拆材质或用原生 PCF。
每个受影像素 `blockerSamples + samples` 次深度读取；静态 IGN 旋转防规则条纹，软影仍可能有颗粒。

## 前景层与代价

`pinForeground(object,{range:0.05})` 把专用材质的深度压进 [0,range]，永远在最前、仍写深度；共享材质的别的物体也会被压前。
后期会把前景读成贴脸近处：景深把它整块糊掉，AO/体积雾按极近距离算。`createPost(S,{…, foreground:{depth:0.05}})`（同一个 range）让前景不吃 AO/雾、景深恒在焦内（post-chain.md）。
所有补丁（雾、PCSS、前景，以及 surface3d/ground3d）经 `patch3d.js` 按调用顺序串在同一材质上，可以叠；同一种补丁一材质一次。
1080×1920 实测（5 帧中位数，seek+同步读回）：天空/云/球/PCSS 场景 SW 118.8 ms、GPU 1.7 ms；128 面环境捕获（含首次编译）SW 451.5 ms、GPU 28.2 ms。整场景成本，不是天空单项增量。
