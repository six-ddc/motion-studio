# 用代码装配硬表面模型

目录：拆件方法 · 造型 API · 装配与合批 · 细节与 UV · 游戏拆解示例 · 代价与边界

## 从实物到零件

先用参考图和一个真实尺寸定比例，再做剪影。只凭记忆补细节，常把比例错的模型做得更复杂；具体量法见本 skill `references/models.md`。
把主体拆到每件能选一个基元：盒体、剖面挤出、扫掠、车床体、管线。优先让几何描述接缝、倒角和轮廓，颜色不能替代真正的高光带。
根据镜头距离分配预算：会改变剪影、接到掠射光、被推近的细节值得用几何；小铭文、污点和远景孔槽交给贴花/法线。真布尔代价高时，可改剖面设计、分件留缝或内衬暗面；近景透视会揭穿假孔，届时值得做真洞。
按运动关系建层级和枢轴，而非按颜色建层级。先拆件→造型/倒角→装配→米制 UV→材质→顶点风化→静态合批→统一光照。
`surface3d.js` 的 `weatherGeometry` 和 `applySurface` 可接在造型之后；天空与材质共用光源时，反射更容易读成同一物体。

## 造型 API

```js
import {bevelBox,lathe,sweep,extrude,tube,part,mergeByMaterial} from './runtime/model3d.js';
const body=part('body',bevelBox(1.5,0.9,0.5,{radius:0.08,segments:3}),metal);
const lens=part('lens',lathe([[0.27,-0.04],[0.31,-0.04],[0.31,0.04],[0.27,0.04]],
  {segments:48}),rubber,{at:[-0.15,0,0.3],rot:[Math.PI/2,0,0]});
const hinge=part('screen',bevelBox(0.7,0.48,0.035,{radius:0.016,segments:3}),metal,
  {at:[0,-0.02,-0.28],pivot:[-0.35,-0.02,-0.28],movable:true});
root.add(body,lens,hinge);
const model=mergeByMaterial(root);
S.scene.add(model); // root 只用于加载期装配，不再同时挂进场景
const screen=model.getObjectByName('screen'); // 合批保留的是克隆，不继续动画原 hinge 引用
// S.freeze() 后，在每帧 paint 中写 screen.rotation.y=f(t)，避免积分。
```

| 函数 | 数据与单位 | 代价 |
|---|---|---|
| `bevelBox(w,h,d,{radius,segments})` / `roundedBox` | 米；radius 显式，segments≥1；0 为原始盒 | 六面分段后投影到圆角表面，法线连续；更多分段增加顶点 |
| `sweep(profile,sections,mapFn?,{caps:true})` | profile 是闭合二维点列（不重复首点，顺/逆时针都行）；sections 是中心 `[x,y,z]` 或 `{at,u,v,scale}` | 侧面与封口恒朝外，与截面绕向、坐标架手性无关；默认架在急转和竖直切换时会翻转，复杂路径显式给 u/v |
| `lathe(profile,{segments:32,arc:2π,mapFn?})` | profile 是 `[半径,高度]`；以 Y 为轴，arc 为弧度 | 封口由 profile 的零半径端点/闭合剖面表达；mapFn 可制造加载期凹痕 |
| `extrude(shape,depth,{bevel:0,segments:1,smooth:false})` / `plate` | 简单二维点列，Z 向挤出；depth、bevel 为米且 bevel<depth/2 | 凹多边形可三角化；本接口不接孔洞，复杂孔形用分件或外部资产 |
| `tube(path,radius,{segments:64,radialSegments:8,closed:false})` | 世界/物体局部米制点列，Catmull-Rom 路径 | 适合线缆、焊缝；细管离镜头远时会闪，需要降细节或像素覆盖补偿 |
| `ring(radius,thickness,opts)` | 圆环主半径和管半径为米 | 更多细分使反射连续，也增加面数 |

`sweep` 的 mapFn 收到 `([x,y,z],{section,vertex,u,v})` 并返回位移后的点，保持同一截面闭合接缝一致；`lathe` 的 mapFn 收到 `(point,index)`。
所有几何有 position/normal/uv 与包围盒。UV 尺度以米表达，纹理 `repeat=1/tileMeters`；车床的 U 是各半径处圆周弧长、V 是轮廓弧长，锥面强烈变径时纹理会扇形变形。圆角面投影 UV 在曲面处有轻微压缩，三平面可作为替代。
`extrude({smooth:true})` 只在侧面（含倒角）内按位置焊接平均法线，封口保持平面；侧面里要保留的硬边，拆成不同几何或保持 `smooth:false`。

## 装配与静态合批

`part(name,geometry,material,{at,rot,pivot,movable,castShadow,receiveShadow})` 返回 Group，内部 mesh 补偿 pivot；`at/pivot` 在父坐标系中，rot 是 XYZ 欧拉弧度。投影两项默认开：细小零件（螺钉、齿）的投影几乎看不见却要进阴影图，远景可关。
`repeat(object,count,(clone,i,count)=>{})`、`mirror(object,'x'|'y'|'z')`、`boltCircle(object,count,radius)`、`alongPath(object,path,count)` 生成重复件；材质和几何引用共享。
`mergeByMaterial(root)` 返回新 Group：以材质对象身份合并静态网格，保留 `userData.modelMovable` 子树与世界相对根的姿态；输出 position/normal/uv/color，补缺色为白、补缺 UV 为零。镜像网格会翻三角形绕向。
合批会增加非索引顶点数，但减少 draw call。静态层的局部变换、可见性、投影开关视为加载期常量；需要动画的层标记 movable，合批后从返回组找同名节点再动画。
蒙皮、实例与形变网格要保留在 movable 子树。`modelStats(root)` 返回 meshes/vertices/triangles；`mergeGeometries(array)` 仅合并几何。
stage3d 每帧复位位置/旋转/缩放/可见性和普通材质值，随 t 改变的属性每帧写满；它不替模型修改顶点缓冲区。

## 贴花与表面细节

`decal(canvas,{width,height,roughness,offset:0.001})` 建带透明贴图、polygonOffset 和 `depthWrite:false` 的标准材质平面，尺寸为米；`roughness` 必填（印刷纸、漆、金属箔的高光完全不同）。深度偏移避免共面闪烁；强弯曲面应拆小贴花或使用同一个曲面映射函数投影。
`wearCanvas(canvas,{seed,scratches,spots,amount})` 在加载期 destination-out 擦除划痕与斑点；随机由种子控制。
`stencilText(ctx,text,x,y,{gap})` 画字后切模板桥缝；先等随片字体加载再设置 ctx.font 并画字，普通系统字体会被字体来源门判红。
螺栓圈、导轨齿、散热片可用 repeat/boltCircle；焊缝与软管可用 tube。数组装配比逐件建 Mesh 简单，但最终仍要按材质合批或实例化。

## 游戏拆解：两个结构例子

**步枪/近景物件**（源码第 5928 行 `w_()` 造型、6054 行 `dm()` 装配）：按 ano/gun/poly/plain/bolt/mag/round 等材质与可动块合并，每组含许多零件。
上下机匣、握把、护木（8 块 2.8 mm 薄板，孔槽画在剖面里）、瞄具外框都是二维剖面挤出；顶导轨是截面扫掠 + 49 个 10 mm 节距的齿；枪管/枪口是 20 段车床体（半径约 8.6–11.5 mm）；
枪托开口剖面挤出、肩垫另分橡胶 9 道肋；弹匣、枪机按枢轴独立运动（装卸、沿 z 往复）；螺钉、控件是小旋转体与倒角盒，铭文是投影贴花。

**四足机械体**（6054 行 `$v/Z_()`）：root→body→neck/head、turret/gun，四腿各 abd→thigh→shin，是刚体层级装配而非蒙皮。
主机身倒角盒 0.27×0.20×0.98（倒角 0.02）外叠面板；散热器 10 片 7 mm 薄盒（节距 28 mm）；头部倒角盒 + 镜片；大腿长 0.40、小腿 0.42，外壳 + 液压杆/线缆 + 软脚球；
天线、信标独立节点；螺栓阵列、管线曲线、编号贴花按 shell/metal/glow/lens 分组合批。尺寸是其代码里的值，不宣称符合真实产品；外观是游戏的选择。

方法上真正可迁移的是：用真实零件的功能组织形体，用倒角承接高光，用少数材质组统一表面，用枢轴隔离运动。模型里的一次性细节密度并不等于每帧重建成本。

## 实测与适用边界

加载期基准（50次均值）：倒角盒384顶点0.174ms，车床体100顶点0.052ms，挤出36顶点0.044ms，扫掠36顶点0.082ms，管道585顶点0.286ms。此数受机器负载影响。
本仓库 `_test-model` 夹具是一台左右对照的相机：右侧有45个 mesh（对焦环、螺钉、标牌、管线、镜筒与可动屏幕），静态合批后6个 mesh，19986个三角形不变；顶点13065→58578（非索引展开的代价）。1080×1920整场景seek+同步读回实测，6帧中位数：SW合批前57.0ms/后35.2ms，GPU前1.7ms/后1.6ms；并发负载下不解读微小差异。
17551 条断言覆盖有限数、法线单位长度、面绕向（含扫掠截面顺/逆时针 × 坐标架左/右手）、挤出封口法线、盒尺寸、三角形守恒与可动子树；帧契约另由 seamcheck 验证。
适合产品、设备、建筑、载具和机械。人物皮肤、动物和复杂布褶需要连续有机曲面、重拓扑与变形系统，逐零件拼装的人工成本很高；这类主体可走 `references/models.md` 的 GLB 路线，加载器与许可仍需单独准备。
这些工具没有真布尔、曲率连续的 CAD 曲面、自动 LOD、骨骼蒙皮或通用自动 UV 展开；相机近到能读出法线误差时，显式截面与外部建模资产通常更值得。
