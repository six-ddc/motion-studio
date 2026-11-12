# 表面分层与顶点色风化

目录：成因分层 · 材质注入 · 参数 · 顶点色风化 · 注入约定 · 代价与局限

## 按成因分层

先分清材料本体、湿润、积垢、磨损和尺度，再把它们写进不同通道。同一张均匀噪声同时染色和改粗糙度会掩盖材料的因果关系。
粗糙度变化决定高光是否像塑料；仅增加颜色细节，受光时仍会是一块均匀亮斑。让湿度、积水和污垢用连续斜坡，硬阈值的代价是出现贴纸般的分界。
低频成簇噪声负责“哪里发生”，细噪声负责“局部是什么”；均匀撒斑点会消掉受力、接触和流淌方向。

## 材质注入

```js
import {applySurface,weatherGeometry,subdivideGeometry} from './runtime/surface3d.js';
const surface=applySurface(material,{
  antiFlicker:{toksvig:0.6,minRoughness:0.045,maxSpecular:40},
  macro:{space:'object',freq:1.5,albedo:0.12,roughness:0.16},
  grime:{space:'object',ao:'none',freq:1.5,amount:0.45,ramp:[0.5,0.85],
    aoWeight:0.8,darken:0.3,roughen:0.25},
  wet:{level:0,darken:0.05,roughnessMul:0.62,vertical:0.65,saturate:0.5,
    flatten:0.45,streakFreq:[9,0.55],patch:{freq:0.8,amount:0.25},
    splash:{groundY:0,height:0.3,amount:0.6,darken:0.25},
    beads:{amount:0.7,size:1/170,fadePx:1/120,roughness:0.05}},
  triplanar:{scale:2,sharpness:6}
}); // 此例为封闭表面的配方，数值由片子的材料与镜头决定
// 在 S.frame(t, paint) 的 paint 里：
surface.set({wet:{level:t/duration}});
```

仅列出的特性会启用；启用后该特性的全部字段显式传入，可关闭子项用 `null`。`set` 只接受已启用的数值参数，空间/AO 来源等结构参数已编入缓存键，变更时创建新材质。
材质必须是 `MeshStandardMaterial` 或 `MeshPhysicalMaterial`。uniform 同时挂在 `material.uniforms`，舞台会复位；每帧写回所有随 t 变化的数值。

## 参数含义

| 特性 | 字段与单位 | 代价或选择依据 |
|---|---|---|
| antiFlicker | `toksvig` 法线 mip 变短量对粗糙度² 的增量；`minRoughness` 0–1；`maxSpecular` 线性高光上限或 null | 法线贴图需 mipmap。压闪烁也会钝化刻意锋利的高光 |
| macro | `space:'world'/'object'`；`freq` 每米；`albedo` 相对幅度；`roughness` 绝对幅度 | 两层 3D 值噪声，合计 16 次整数哈希；world 空间会在移动物体上游移 |
| grime | `freq/space` 同上；`ao:'aoMap'/'vertexColor'/'none'`；`amount`、`ramp:[lo,hi]`、`aoWeight`、`darken`、`roughen` | AO 只能提示遮蔽，不能推断真正的积垢过程；颜色很暗的顶点色也会被当成 AO |
| wet | `level` 全局湿度，`darken` 变暗量，`roughnessMul` 湿后倍率，`vertical` 竖面相对湿量；`saturate/flatten` 饱和度增量与法线压平 | 朝上比朝下湿；多孔表面可增大 darken，封闭表面主要调粗糙度。它不是液体仿真 |
| wet.patch | `freq` 每米，`amount` 斑驳量 | 低频噪声让湿度有聚集，增加每像素计算 |
| wet.streakFreq | `[水平频率,竖直频率]` 每米 | 竖面流痕的拉长由两轴频率比决定 |
| wet.splash | `groundY/height` 米，`amount/darken` 或整个 null | 溅湿带位置固定在世界地面，物体搬走后不会保留历史水痕 |
| wet.beads | `amount`，`size` 米，`fadePx` 表面足迹阈值，`roughness` 或整个 null | 用像素导数消退亚像素水珠；水珠不是额外几何，不改变剪影 |
| triplanar | `scale` 每物体米重复数，`sharpness≥1` 方向权重幂 | 三向采样，贴图读取近三倍；贴图须 RepeatWrapping。物体空间映射随物体一起动 |

`macro.freq` 和 `grime.freq` 可独立动画；即使加载期相等也分别求值，避免数值更改后错误复用同一遮罩。
三平面支持 map、normalMap、roughnessMap、metalnessMap、aoMap；切线空间法线做正确方向混合，物体空间法线贴图不走此路径。

## 加载期风化

```js
const dense=subdivideGeometry(geometry,{maxEdge:0.08,maxTriangles:200000});
mesh.geometry=weatherGeometry(dense,{
  seed:11,transform:mesh.matrixWorld,
  mottle:[{freq:1.9,amount:0.12}],hemi:{down:0.72,side:0.9},
  contact:{groundY:0,height:0.2,darken:0.45,warm:[1,0.95,0.86],noise:{freq:9,amount:0.45}},
  crease:null,rust:null
});
material.vertexColors=true;
```

先 `mesh.updateWorldMatrix(true,false)`，再传几何→世界的 `Matrix4`；返回新几何，不改输入。
所有选项必需，关闭项传 null：`mottle` 低频亮度层；`hemi` 朝下和侧面的亮度倍率；`contact` 离地污垢带。
`crease:{weld,ramp,concave,convex}` 用焊接邻接点估计凹凸；`weld` 米、`ramp` 为归一化曲率区间，`convex` 允许负值以提亮棱边。
`rust:{color,amount,freq,ramp,where:'crease'/'all'}` 决定成簇锈色；`where:'crease'` 需要 crease。
顶点色是廉价的 AO/接触阴影近似；不跟踪物体间遮挡，也不会随物体移动重新计算。大三角形会把窄污垢带抹成整面渐变，因此接触带跨距不足时抛错并提示细分。
`subdivideGeometry` 用一致的 n×n 重心网格保留法线/UV/颜色及 groups；受 `maxTriangles` 限制，避免几何爆增。

## 注入约定与局限

片段 `SURFACE_GLSL` 包含 `hash/vnoise/fbm/gradT/worleyT/all`：分别导出 `sf_pcg3/sf_hash33/sf_hash13`、`sf_vnoise3`、`sf_fbm3`、`sf_gnoiseT/sf_fbmT`、`sf_worleyT`。
手动拼接时先 hash，再 vnoise/fbm 或 gradT/worleyT；全部是 GLSL ES 3.00。函数前缀 `sf_`，uniform `uSf`，varying `vSf`，define `SF_`。
注入点为顶点 `common/project_vertex`，片元 `common/map_fragment/color_fragment/roughnessmap_fragment/metalnessmap_fragment/aomap_fragment/normal_fragment_maps/lights_fragment_end`。
程序缓存键包含特性集合、空间和可选子项，原有补丁回调及自定义键保留；同一材质只应用一次。
夹具覆盖 UV/三平面、mip 法线、全部特性与湿度动画；非均匀缩放、实例、蒙皮、位移和外部自定义法线补丁尚未做专门验证。
1080×1920大地面逐项开关实测（5帧中位数，seek+同步读回；单位ms）：SW 裸109.9、AA111.5、宏观109.9、积垢111.1、湿润115.2、三平面138.8、全开150.6；GPU依次1.5/1.5/1.7/1.7/2.2/1.3/2.1。并发开发下数字有噪声，微小差异不作加速结论；风化只占加载时间，渲染时是普通顶点色乘法。
