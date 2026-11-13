// ground3d.js —— 湿地面：一张覆盖全场的唯一遮罩 + 连续湿润带 + 当帧平面反射 + 闭式雨滴涟漪。按帧契约求值。
//
// 平面限定为世界 y = planeY（米）。所有颜色、幅度、尺度由片子传入；没有观感默认值，缺参数抛错点名。
// 做法、参数含义、代价见 film-webfx references/world-surfaces.md。
//
//   const mask = bakeGroundMask({ size, seed, bounds, heightRange, pits, layers });
//   const refl = createPlanarReflection(S, { planeY: 0, size: [512, 512], clipBias, hide: [ground] });
//   const wet  = applyGround(ground.material, { mask, reflection: refl, dryColor, wetColor, roughness, tileMeters,
//                                               grain, seam, oil, wear, transition, ripple });
//   S.frame(t, () => { …相机与物体按 t… ; wet.set({ t, waterLevel, wetness }); refl.render(); });
//
// 与 surface3d / sky3d 叠在同一材质上：补丁经 patch3d 按调用顺序串起来（见 applyGround 的说明）。

import * as THREE from './three-film.module.js';
import { tileNoise, dataTexture } from './texture3d.js';
import { addPatch, inject, WORLD_POS } from './patch3d.js';
import { GLSL } from './webfx.js';

const sat = (x) => Math.max(0, Math.min(1, x));

function finite(v, name) {
  if (!Number.isFinite(v)) throw new Error(`ground3d: ${name} 必须是有限数（收到 ${v}）`);
  return v;
}
function need(obj, name, keys) {
  if (!obj || typeof obj !== 'object') throw new Error(`ground3d: ${name} 必填，要是 { ${keys.join(', ')} }`);
  for (const k of keys) if (!(k in obj)) throw new Error(`ground3d: 缺参数 ${name}.${k}（没有观感默认值，含义见 world-surfaces.md）`);
  return obj;
}
function range2(v, name, { lo = -Infinity, increasing = true } = {}) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite) || v[0] < lo || (increasing && !(v[1] > v[0])))
    throw new Error(`ground3d: ${name} 要是 [a, b] 两个有限数${increasing ? '且 a < b' : ''}`);
  return v;
}

/**
 * 唯一地形遮罩（加载期，CPU）：RGBA = 高度 / 潮湿 / 油污 / 磨损，覆盖 bounds，不 repeat。
 *   bounds       [x0, z0, width, depth] 米
 *   heightRange  [min, max] 米：R 通道 8 位编码的范围
 *   pits         [{ x, z, rx, rz, depth }]：相对 bounds 原点的高斯凹坑（米），积水先在这里出现
 *   layers       每个通道的噪声配方（米为噪声格尺寸）：
 *     height { meters, range:[lo, hi] }        宏观起伏占 heightRange 的哪一段（0–1）
 *     damp   { meters, lowBias }               潮湿 = (1−lowBias)·噪声 + lowBias·(1−高度)：低处更潮
 *     oil    null | { meters, detailMeters, bias, gain }   油污 = sat((噪声·细噪声 − bias)·gain)
 *     wear   null | { meters }                 磨损分布
 */
export function bakeGroundMask({ size, seed, bounds, heightRange, pits, layers } = {}) {
  if (!Number.isInteger(size) || size < 2 || size > 4096 || !Number.isInteger(seed)) throw new Error('ground3d: size 2..4096 整数、seed 整数');
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some((x) => !Number.isFinite(x)) || bounds[2] <= 0 || bounds[3] <= 0)
    throw new Error('ground3d: bounds=[x0,z0,width,depth]');
  range2(heightRange, 'heightRange=[min,max] 有限米');
  if (!Array.isArray(pits)) throw new Error('ground3d: pits 数组必填（没有凹坑就传 []）');
  for (const p of pits) {
    ['x', 'z', 'rx', 'rz', 'depth'].forEach((k) => finite(p[k], `pit.${k}`));
    if (p.rx <= 0 || p.rz <= 0 || p.depth < 0) throw new Error('ground3d: pit 半径>0，depth≥0');
  }
  need(layers, 'layers', ['height', 'damp', 'oil', 'wear']);
  const L = layers;
  need(L.height, 'layers.height', ['meters', 'range']); range2(L.height.range, 'layers.height.range', { lo: 0 });
  need(L.damp, 'layers.damp', ['meters', 'lowBias']); finite(L.damp.lowBias, 'layers.damp.lowBias');
  if (L.oil !== null) { need(L.oil, 'layers.oil', ['meters', 'detailMeters', 'bias', 'gain']); finite(L.oil.bias, 'layers.oil.bias'); finite(L.oil.gain, 'layers.oil.gain'); }
  if (L.wear !== null) need(L.wear, 'layers.wear', ['meters']);
  for (const [n, o] of [['height', L.height], ['damp', L.damp], ['oil', L.oil], ['wear', L.wear]]) {
    if (!o) continue;
    for (const k of ['meters', 'detailMeters']) if (k in o && !(Number.isFinite(o[k]) && o[k] > 0)) throw new Error(`ground3d: layers.${n}.${k} 要 > 0（米）`);
  }

  const data = new Uint8Array(size * size * 4);
  const [h0, h1] = heightRange, span = h1 - h0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = (x / (size - 1)) * bounds[2], wz = (y / (size - 1)) * bounds[3];
    const n = (meters, s) => tileNoise(wx / meters, wz / meters, 1024, seed + s);
    let h = h0 + span * (L.height.range[0] + (L.height.range[1] - L.height.range[0]) * n(L.height.meters, 1));
    for (const p of pits) h -= Math.exp(-(((wx - p.x) / p.rx) ** 2 + ((wz - p.z) / p.rz) ** 2)) * p.depth;
    const i = (y * size + x) * 4, hn = sat((h - h0) / span);
    data[i] = Math.round(255 * hn);
    data[i + 1] = Math.round(255 * sat((1 - L.damp.lowBias) * n(L.damp.meters, 2) + L.damp.lowBias * (1 - Math.round(255 * hn) / 255)));
    data[i + 2] = L.oil ? Math.round(255 * sat((n(L.oil.detailMeters, 3) * n(L.oil.meters, 4) - L.oil.bias) * L.oil.gain)) : 0;
    data[i + 3] = L.wear ? Math.round(255 * n(L.wear.meters, 5)) : 128;
  }
  return { texture: dataTexture(data, size, { repeat: false }), data, bounds: bounds.slice(), heightRange: heightRange.slice() };
}

/**
 * 当帧平面反射：镜像相机 + 斜近平面。render() 放在 S.frame 的 paint 末尾（所有物体已按 t 设置之后），不保留上一帧。
 *   planeY     反射平面的世界高度（米）
 *   size       [宽, 高] 反射纹理的像素数
 *   clipBias   斜近平面的偏移（防平面上的几何被裁掉/漏进来）
 *   hide       反射接收面数组（加载期确定）：每次隐藏 → 渲染 → 恢复
 */
export function createPlanarReflection(S, { planeY, size, clipBias, hide } = {}) {
  finite(planeY, 'planeY'); finite(clipBias, 'clipBias');
  if (!Array.isArray(size) || size.length !== 2 || !size.every((x) => Number.isInteger(x) && x > 0) || !Array.isArray(hide))
    throw new Error('ground3d: size=[宽,高] 正整数像素、hide 数组必填');
  const target = new THREE.WebGLRenderTarget(size[0], size[1], { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const camera = new THREE.PerspectiveCamera(), matrix = new THREE.Matrix4();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);

  function render() {
    const source = S.camera, r = S.renderer;
    if (!source.isPerspectiveCamera) throw new Error('ground3d: 平面反射只支持透视相机');
    source.updateProjectionMatrix(); S.scene.updateMatrixWorld(true);
    const eye = source.getWorldPosition(new THREE.Vector3()), look = source.getWorldDirection(new THREE.Vector3()).add(eye);
    camera.copy(source, false); camera.parent = null;
    camera.position.set(eye.x, 2 * planeY - eye.y, eye.z);
    look.y = 2 * planeY - look.y;
    camera.up.set(0, 1, 0).transformDirection(source.matrixWorld); camera.up.y *= -1;
    camera.lookAt(look); camera.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.copy(source.projectionMatrix);
    matrix.copy(bias).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    // Eric Lengyel 的斜近平面：剪掉水面下几何，消除穿帮
    const cp = plane.clone().applyMatrix4(camera.matrixWorldInverse);
    const v = new THREE.Vector4(cp.normal.x, cp.normal.y, cp.normal.z, cp.constant);
    const e = camera.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(v.x) + e[8]) / e[0], (Math.sign(v.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    const dot = v.dot(q);
    if (Math.abs(dot) < 1e-8) throw new Error('ground3d: 相机与反射裁面退化');
    v.multiplyScalar(2 / dot); e[2] = v.x; e[6] = v.y; e[10] = v.z + 1 - clipBias; e[14] = v.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    // 渲染器状态全部存下来，画完原样还原（RT、立方面、mip、viewport、scissor、色调映射、输出色彩空间、XR）
    const old = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const viewport = r.getViewport(new THREE.Vector4()), scissor = r.getScissor(new THREE.Vector4()), test = r.getScissorTest();
    const tone = r.toneMapping, colorSpace = r.outputColorSpace, xr = r.xr.enabled, visible = hide.map((o) => o.visible);
    try {
      hide.forEach((o) => { o.visible = false; });
      r.xr.enabled = false; r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
      r.setRenderTarget(target); r.setScissorTest(false); r.clear(); r.render(S.scene, camera);
    } finally {
      hide.forEach((o, i) => { o.visible = visible[i]; });
      r.xr.enabled = xr; r.toneMapping = tone; r.outputColorSpace = colorSpace;
      r.setRenderTarget(old, face, mip); r.setViewport(viewport); r.setScissor(scissor); r.setScissorTest(test);
    }
  }
  return { target, texture: target.texture, matrix, camera, render, dispose() { target.dispose(); } };
}

// ---- 片元着色器：值噪声（共享 pcg 哈希）与雨滴涟漪 ----
const F_DECL = (rippleLayers) => `
varying vec3 vGWorld; varying vec4 vGReflect;
uniform sampler2D uGMask, uGReflection; uniform vec4 uGBounds, uGRough;
uniform vec2 uGRange, uGTile; uniform vec3 uGDry, uGWet, uGTransition;
uniform vec4 uGSeam; uniform vec3 uGGrain; uniform vec2 uGOil; uniform float uGWear;
uniform float uGTime, uGWater, uGWetness;
${GLSL.pcg}
float g_n(vec2 p, float s){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(pcgHash33(vec3(i, s)).x, pcgHash33(vec3(i + vec2(1, 0), s)).x, f.x),
             mix(pcgHash33(vec3(i + vec2(0, 1), s)).x, pcgHash33(vec3(i + 1., s)).x, f.x), f.y); }
float gpuddle, gdamp, gsoak, ggrain;
${rippleLayers ? `
uniform vec4 uGRipL[${rippleLayers}];   // 每层：x 格尺寸(米), y 速率(次/秒), z 角度(弧度), w 权重
uniform vec4 uGRipShape;                // x 出现概率, y 环半径下限(格比例), z 上限, w 法线斜率幅度
uniform vec4 uGRipWF;                   // xy 环宽 [出生, 消失]（米）, zw 距离淡出 [开始, 结束]（米）
// 一层稀疏雨滴：每个格子每个周期 floor(tt) 换一滴新雨（位置、大小、强度），life = fract(tt)。
// 环剖面是高斯的导数 x·exp(−x²)（×2.3 归一到峰值约 1），随寿命变宽、振幅 (1−life)² 衰减。返回 xz 斜率。
vec2 g_ripple(vec2 p, float t, float cell, float layer){
  vec2 q = p / cell; vec2 id = floor(q); vec2 f = fract(q);
  vec3 h0 = pcgHash33(vec3(id, -1. - layer));                      // 每格常数：速率抖动、相位
  float tt = t * (0.5 + 0.55 * h0.x) + h0.y * 9.;
  float cyc = floor(tt), life = tt - cyc;
  vec3 h = pcgHash33(vec3(id, cyc * 8. + layer));
  vec3 hc = pcgHash33(vec3(id.yx, -cyc * 8. - layer - 100.));
  float on = step(h.z, uGRipShape.x);
  float rmax = mix(uGRipShape.y, uGRipShape.z, h.x * h.x);
  vec2 c = mix(vec2(rmax + .05), vec2(.95 - rmax), hc.xy);           // 环整个落在格内：相邻格的环不跨格，不出接缝
  vec2 dv = (f - c) * cell; float d = length(dv);
  float x = (d - life * rmax * cell) / mix(uGRipWF.x, uGRipWF.y, life);
  float amp = (1. - life); amp = amp * amp * on * mix(.3, 1., h.y) * smoothstep(0., .06, life);
  return dv / max(d, 1e-4) * x * exp(-x * x) * 2.3 * amp;
}
vec2 g_rain(vec2 p, float t){
  vec2 s = vec2(0.);
  for (int i = 0; i < ${rippleLayers}; i++){
    vec4 L = uGRipL[i]; float ca = cos(L.z), sa = sin(L.z);
    vec2 r = g_ripple(mat2(ca, sa, -sa, ca) * p, t * L.y, L.x, float(i));
    s += mat2(ca, -sa, sa, ca) * r * L.w;                              // 斜率转回世界轴
  }
  return s;
}` : ''}
`;

const F_COLOR = `
vec2 guv = (vGWorld.xz - uGBounds.xy) / uGBounds.zw;
vec4 gm = texture2D(uGMask, clamp(guv, 0., 1.));
// 遮罩区域外按"最高处、干燥、无油、中性磨损"处理，边缘 5% 平滑过渡（不出硬边）
float gedge = smoothstep(0., .05, min(min(guv.x, guv.y), min(1. - guv.x, 1. - guv.y)));
gm = mix(vec4(1., 0., 0., .5), gm, gedge);
ggrain = g_n(vGWorld.xz / uGTile.x, 1.) + g_n(vGWorld.xz / uGTile.y + 17.3, 2.) - 1.;
float groove = 0.;
#ifdef G_SEAM
  vec2 gs = abs(fract(vGWorld.xz / uGSeam.x + .5) - .5) * uGSeam.x;
  groove = 1. - smoothstep(uGSeam.y * .4, uGSeam.y * .6, min(gs.x, gs.y));
#endif
float depth = uGWater - mix(uGRange.x, uGRange.y, gm.r) + groove * uGSeam.z + ggrain * uGGrain.z;
gpuddle = smoothstep(0., uGTransition.z, depth) * uGWetness;
gsoak = smoothstep(-uGTransition.y, 0., depth) * uGWetness;
gdamp = clamp((gm.g + smoothstep(-uGTransition.x, 0., depth)) * .5 * uGWetness, 0., 1.);
diffuseColor.rgb *= mix(uGDry, uGWet, clamp(gdamp * .5 + gsoak * .5, 0., 1.)) * (1. + ggrain * uGGrain.x)
  * (1. - groove * uGSeam.w) * (1. - gm.b * uGOil.x);
`;

// 粗糙度：地面四档（干/潮/浸湿/积水）× 颗粒/磨损/油污调制，再**乘**到已有的 roughnessFactor 上
// （材质 roughness = 1 且没有别的补丁时就是绝对值；叠了 surface3d 时按补丁调用顺序依次作用）
const F_ROUGH = `
{
  float gr = mix(mix(mix(uGRough.x, uGRough.y, gdamp), uGRough.z, gsoak), uGRough.w, gpuddle);
  gr += (ggrain * uGGrain.y + (gm.a - .5) * uGWear) * (1. - gpuddle) - gm.b * uGOil.y;
  roughnessFactor = clamp(roughnessFactor * clamp(gr, .02, 1.), 0., 1.);
}
`;

const F_NORMAL = `
#ifdef G_RIPPLE
{
  float grf = 1. - smoothstep(uGRipWF.z, uGRipWF.w, length(cameraPosition - vGWorld));   // 远处淡出：亚像素的环只会闪
  if (grf > 0. && gpuddle > 0.) {
    vec2 rn = g_rain(vGWorld.xz, uGTime) * uGRipShape.w * gpuddle * grf;
    normal = normalize(normal + mat3(viewMatrix) * vec3(-rn.x, 0., -rn.y));
  }
}
#endif
`;

const F_REFLECT = `
vec2 ruv = vGReflect.xy / vGReflect.w;
if (vGReflect.w > 0. && all(greaterThanEqual(ruv, vec2(0.))) && all(lessThanEqual(ruv, vec2(1.)))) {
  float lod = clamp(roughnessFactor * 7., 0., 7.);
  radiance = mix(radiance, textureLod(uGReflection, ruv, lod).rgb, gpuddle);
}
`;

/**
 * 标准 PBR 注入：唯一遮罩 + 双尺度颗粒 + 板缝 + 连续水位 + 闭式雨滴涟漪；反射替换环境镜面输入（保留 three 的 BRDF）。
 *   dryColor / wetColor   线性 RGB 乘数
 *   roughness             [干, 潮, 浸湿, 积水] 0–1
 *   tileMeters            [粗, 细] 颗粒噪声格尺寸（米）
 *   grain                 { albedo, roughness, height }：颗粒对反照率的 ±比例、对粗糙度的 ±量、对水深的 ±米
 *   seam                  null | { spacing, width, depth, darken }：方格板缝（米）与缝里压暗比例
 *   oil                   { darken, roughness }：遮罩 B 通道处反照率压暗比例、粗糙度减量
 *   wear                  { roughness }：遮罩 A 通道（0.5 为中性）对非积水区粗糙度的调制量
 *   transition            { damp, soak, puddle }：三段湿润斜坡宽度（米，高度差）
 *   ripple                null | { layers:[{cell, rate, angle, weight}]（1–4 层）, density, radius:[lo,hi], width:[出生,消失], amplitude, fade:[近,远] }
 * 返回 { uniforms, set({ t, waterLevel, wetness }) }。在 S.freeze() 之前调。
 */
export function applyGround(material, o = {}) {
  const { mask, reflection, dryColor, wetColor, roughness, tileMeters, grain, seam, oil, wear, transition, ripple } = o;
  if (!material?.isMeshStandardMaterial || !mask?.texture) throw new Error('ground3d: 要标准 PBR 材质与 bakeGroundMask 结果');
  for (const k of ['reflection', 'seam', 'ripple']) if (!(k in o)) throw new Error(`ground3d: ${k} 必填（不要就显式传 null）`);
  for (const [name, c] of Object.entries({ dryColor, wetColor }))
    if (!Array.isArray(c) || c.length !== 3 || c.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(`ground3d: ${name} 要线性 RGB`);
  if (!Array.isArray(roughness) || roughness.length !== 4 || roughness.some((x) => !Number.isFinite(x) || x < 0 || x > 1))
    throw new Error('ground3d: roughness=[干,潮,浸湿,积水] [0,1]');
  if (!Array.isArray(tileMeters) || tileMeters.length !== 2 || tileMeters.some((x) => !(x > 0))) throw new Error('ground3d: tileMeters=[粗,细] 米');
  need(grain, 'grain', ['albedo', 'roughness', 'height']); ['albedo', 'roughness', 'height'].forEach((k) => finite(grain[k], `grain.${k}`));
  need(oil, 'oil', ['darken', 'roughness']); finite(oil.darken, 'oil.darken'); finite(oil.roughness, 'oil.roughness');
  need(wear, 'wear', ['roughness']); finite(wear.roughness, 'wear.roughness');
  need(transition, 'transition', ['damp', 'soak', 'puddle']);
  for (const k of ['damp', 'soak', 'puddle']) if (!(finite(transition[k], `transition.${k}`) > 0)) throw new Error(`ground3d: transition.${k} 要 > 0（米）`);
  if (seam !== null) {
    need(seam, 'seam', ['spacing', 'width', 'depth', 'darken']);
    for (const k of ['spacing', 'width']) if (!(finite(seam[k], `seam.${k}`) > 0)) throw new Error(`ground3d: seam.${k} 要 > 0（米）`);
    finite(seam.depth, 'seam.depth'); finite(seam.darken, 'seam.darken');
  }
  let rip = null;
  if (ripple !== null) {
    need(ripple, 'ripple', ['layers', 'density', 'radius', 'width', 'amplitude', 'fade']);
    if (!Array.isArray(ripple.layers) || ripple.layers.length < 1 || ripple.layers.length > 4) throw new Error('ground3d: ripple.layers 要 1–4 层 [{cell, rate, angle, weight}]');
    ripple.layers.forEach((l, i) => {
      need(l, `ripple.layers[${i}]`, ['cell', 'rate', 'angle', 'weight']);
      if (!(finite(l.cell, `ripple.layers[${i}].cell`) > 0) || !(finite(l.rate, `ripple.layers[${i}].rate`) >= 0)) throw new Error('ground3d: ripple 层的 cell>0（米）、rate≥0（次/秒）');
      finite(l.angle, `ripple.layers[${i}].angle`); finite(l.weight, `ripple.layers[${i}].weight`);
    });
    if (!(finite(ripple.density, 'ripple.density') >= 0 && ripple.density <= 1)) throw new Error('ground3d: ripple.density 要在 [0,1]（每格每周期出一滴的概率）');
    range2(ripple.radius, 'ripple.radius（环最大半径占格的比例）', { lo: 0 });
    if (ripple.radius[1] > 0.45) throw new Error('ground3d: ripple.radius 上限 ≤ 0.45（环要整个落在格内，否则跨格处出接缝）');
    range2(ripple.width, 'ripple.width（环宽，米）', { lo: 1e-5, increasing: false });
    range2(ripple.fade, 'ripple.fade（距离淡出，米）', { lo: 0 });
    finite(ripple.amplitude, 'ripple.amplitude');
    rip = ripple;
  }

  const u = {
    uGMask: { value: mask.texture }, uGBounds: { value: new THREE.Vector4(...mask.bounds) }, uGRange: { value: new THREE.Vector2(...mask.heightRange) },
    uGDry: { value: new THREE.Color(...dryColor) }, uGWet: { value: new THREE.Color(...wetColor) }, uGRough: { value: new THREE.Vector4(...roughness) },
    uGTile: { value: new THREE.Vector2(...tileMeters) },
    uGSeam: { value: seam ? new THREE.Vector4(seam.spacing, seam.width, seam.depth, seam.darken) : new THREE.Vector4(1, 0, 0, 0) },
    uGGrain: { value: new THREE.Vector3(grain.albedo, grain.roughness, grain.height) },
    uGOil: { value: new THREE.Vector2(oil.darken, oil.roughness) }, uGWear: { value: wear.roughness },
    uGTransition: { value: new THREE.Vector3(transition.damp, transition.soak, transition.puddle) },
    uGTime: { value: 0 }, uGWater: { value: 0 }, uGWetness: { value: 0 },
    uGReflection: { value: reflection?.texture ?? null }, uGMatrix: { value: reflection?.matrix ?? new THREE.Matrix4() },
  };
  if (rip) Object.assign(u, {
    uGRipL: { value: rip.layers.map((l) => new THREE.Vector4(l.cell, l.rate, l.angle, l.weight)) },
    uGRipShape: { value: new THREE.Vector4(rip.density, rip.radius[0], rip.radius[1], rip.amplitude) },
    uGRipWF: { value: new THREE.Vector4(rip.width[0], rip.width[1], rip.fade[0], Math.max(rip.fade[0] + 1e-3, rip.fade[1])) },
  });
  const nRip = rip ? rip.layers.length : 0;
  const defs = `${seam ? '#define G_SEAM\n' : ''}${rip ? '#define G_RIPPLE\n' : ''}`;
  const who = 'ground3d';
  addPatch(material, `ground:${!!reflection}:${!!seam}:${nRip}`, (shader) => {
    Object.assign(shader.uniforms, u);
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = inject(vs, '#include <common>', 'after', 'varying vec3 vGWorld; varying vec4 vGReflect; uniform mat4 uGMatrix;', who);
    vs = inject(vs, '#include <project_vertex>', 'after', `${WORLD_POS('vGWorld')}\nvGReflect = uGMatrix * vec4(vGWorld, 1.);`, who);
    fs = inject(fs, '#include <common>', 'after', defs + F_DECL(nRip), who);
    fs = inject(fs, '#include <color_fragment>', 'after', F_COLOR, who);
    fs = inject(fs, '#include <roughnessmap_fragment>', 'after', F_ROUGH, who);
    fs = inject(fs, '#include <normal_fragment_maps>', 'after', F_NORMAL, who);
    if (reflection) fs = inject(fs, '#include <lights_fragment_maps>', 'after', F_REFLECT, who);
    shader.vertexShader = vs; shader.fragmentShader = fs;
  });
  material.uniforms = Object.assign(material.uniforms ?? {}, u);
  return {
    uniforms: u,
    /** paint 里每帧调：t 驱动涟漪，水位（米）与总湿度 0–1 */
    set({ t, waterLevel, wetness }) {
      finite(t, 't'); finite(waterLevel, 'waterLevel'); finite(wetness, 'wetness');
      if (wetness < 0 || wetness > 1) throw new Error('ground3d: wetness 要 [0,1]');
      u.uGTime.value = t; u.uGWater.value = waterLevel; u.uGWetness.value = wetness;
    },
  };
}
