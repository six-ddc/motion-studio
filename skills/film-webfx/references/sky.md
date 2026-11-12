# 天空、环境反射与空气透视

目录：同源光照 · 天空与云 · 环境反射 · 解析高度雾 · 软阴影 · 前景层 · 代价与局限

## 同源光照

让天、雾、环境反射来自同一份 `rig`，避免反射与背景的光向不一致。所有色值由片子给出；数组是线性 RGB（可大于 1），字符串按 sRGB 转换。

```js
import { createLightRig, createSky, createHeightFog, enablePCSS } from './runtime/sky3d.js';
const rig = createLightRig({
  sun: { dir: [-0.55, 0.27, -0.8], color: [1, 0.76, 0.5], intensity: 3 },
  sky: { zenith: [0.08, 0.16, 0.3], horizonSun: [1.5, 0.7, 0.3],
    horizonAway: [0.24, 0.38, 0.62], ground: [0.12, 0.09, 0.06], fog: [0.35, 0.36, 0.4] }
}); // 本例是暖色低角度光的配方，代价是暖色占据大面积；按本片参照调整。
const sun = rig.createSun({castShadow:true,mapSize:1024,bias:-0.0002,normalBias:0.02});
S.scene.add(sun, sun.target, rig.createAmbient(0.25));
rig.fitShadow(sun, bounds, {margin:1}); // bounds 是含投影物/接收面的世界 Box3；margin 单位米
```

太阳方向也可写 `elevation`、`azimuth`（度，0 指 −Z，90 指 +X），替代 `dir`。`createAmbient(intensity)` 的天色取雾色、地色取 ground；与 PMREM 叠加会增加总体照明，强度由片子权衡。

`SKY_GLSL` 导出 `skyToSun(vec3 dir)`、`horizonColor(vec3 dir)`、`skyGradient(vec3 dir)`，输入为世界单位方向，输出在线性域。先拼此片段，再拼引用它的雾代码。
`rig.uniforms()` 返回新的 `{name:{value}}` 表；`rig.fill(table)` 更新已有槽，保留槽身份。
固定 uniform 名为 `uSkySunDir/Color/Intensity`（实际是 `uSkySunDir`、`uSkySunColor`、`uSkySunIntensity`）、`uSkyZenith`、`uSkyHorizonSun`、`uSkyHorizonAway`、`uSkyGround`、`uSkyFog`、`uSkyShape`。
共享给后期时传 `horizonGLSL: SKY_GLSL, horizonUniforms: rig.uniforms()`，供该 pass 调用 `horizonColor`。

## 天空与云

```js
const sky = createSky(S, rig, {
  halo:[[8,0.1],[64,0.4],[600,1.2],[6000,4]],
  disk:{angle:0.8,intensity:60}, // 视直径为度，intensity 为线性太阳色的倍数
  clouds:{altitude:900,featureSize:1200,wind:[20,4],coverage:0.72,softness:0.12,
    base:[0.25,0.29,0.4],dark:[0.04,0.06,0.09],light:0.8,rim:1.2,seed:17,
    octaves:4,shadowSteps:2,hole:{radius:5,feather:6,strength:0.9},
    gap:{away:2,sun:12,ragged:0.6}}
});
// 在 S.frame 的 paint 里每帧调用：
sky.update(t); // 可给第二参数 {coverage}；偏移精确由 wind*t/featureSize 求得
```

`halo` 为 1–4 组 `[幂次,权重]`；宽晕和窄核分开调，单一宽晕的代价是整片天发白。`clouds:false` 去掉云计算。
云的 `altitude/featureSize` 和 `wind` 使用米、米/秒；这是平面投影云层，云底有体积感来自域扭曲与向光密度差，并非三维云光线步进。
`coverage` 为 0–1，`softness` 为密度过渡带；`aniso:[x,z]` 控制拉伸；`warp/detail` 控制域扭曲和脊状细节。
`octaves`（1–9）与 `shadowSteps`（1–8）控制质量；每增加一阴影步会重算一组 fbm，软件渲染代价明显。
`hole` 为太阳周围开洞（度），`gap` 为背阳/向阳云底仰角（度）；它们是构图选择，留空就不做这项。

## 环境反射

加载期、`S.freeze()` 前调用 `sky.environment({at:0,clamp:5,intensity:0.8,size:128})`。
返回 `{texture,renderTarget}` 并设置 `S.scene.environment`。捕获时移除太阳圆盘、限制 HDR 亮度，避免太阳由 IBL 与平行光重复计算。
`apply:false` 只生成、不赋给场景，可按镜头预拍多张；在 paint 里按 t 选 texture 与强度。
云移动但环境静止会有反射误差；镜面主体近景值得预拍多个时刻，粗糙材质通常不敏感。使用完后由片子释放 `renderTarget`。

## 解析高度雾

```js
const fog = createHeightFog(rig, {density:0.012,baseHeight:0,scaleHeight:4,
  maxOpacity:0.85,sunStrength:0.04,sunPower:8});
S.scene.add(fog.node);
fog.apply(material); // 标准材质，先雾后色调映射
```

密度是 `density*exp(-(y-baseHeight)/scaleHeight)`（每米）；沿相机到表面的视线做闭式积分，颜色取该方向的地平线色。它没有遮挡光柱；需要有阴影的介质用后期体积雾。
`HEIGHT_FOG_GLSL` 导出 `heightFogDepth(ro,p)`、`heightFogColor(rd)`、`applyHeightFog(col,ro,p)`；uniform 为 `uFogMedium`（density/baseHeight/scaleHeight/maxOpacity）、`uFogSun`（sunStrength/sunPower）。`fog.fill(table)` 可同步给自写 pass。
把 `fog.node` 加进场景后，舞台会复位它的数值；随 t 变动的参数在每帧 paint 中写回。

## 软阴影

```js
enablePCSS(S, sun, materials, {sunAngle:3,maxRadius:0.5,samples:12,blockerSamples:8});
```

舞台需显式 `shadows:true, shadowType:THREE.BasicShadowMap`，先拟合 sun 的阴影视锥。
`sunAngle` 是太阳视直径（度）；`maxRadius` 为遮挡搜索半径（米）；`minPenumbra` 为最小半影宽（米）；`slope` 限制接收面梯度偏移。
补丁在材质 `onBeforeCompile` 内替换阴影采样 chunk，不修改 three 打包文件。它对同材质里所有方向/聚光阴影共用同一视锥尺寸，适合一盏主太阳的场景；多盏不同阴影视锥应拆分材质或使用原生 PCF。
成本约为每个受影像素 `blockerSamples + samples` 次深度读取。静态 IGN 旋转抑制规则条纹，软影仍可能有颗粒；提高采样或渲染分辨率会更贵。

## 前景层与代价

`pinForeground(object,{range:0.05})` 把专用材质的 NDC 深度压到 [0,range]，仍写深度；共享材质会让其他物体也前移。景深与体积雾会把此深度读成极近距离，前景需要独立合成或关闭对应后期。
在 `S.freeze()` 之前创建天空、雾与补丁；seek 里只更新值。按 t 求值不需要任何历史帧。
1080×1920 局部实测（5帧中位数，seek+同步读回）：天空/云/球/PCSS 场景 SW 118.8ms、GPU 1.7ms；128面环境捕获含首次编译和同步读回 SW 451.5ms、GPU 28.2ms。这是整场景成本，不是天空单项增量；并发开发造成负载波动。
