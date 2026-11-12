// 唯一地形遮罩、连续湿润带、当帧平面反射。平面限定为世界 y=height，单位米。
import * as THREE from './three-film.module.js';
import { tileNoise, dataTexture } from './texture3d.js';
const sat = x => Math.max(0, Math.min(1, x));
function finite(v, name) { if (!Number.isFinite(v)) throw new Error(`ground3d: ${name} 必须有限`); return v; }

/** RGBA = 高度/潮湿/油污/磨损；一张覆盖指定区域的唯一遮罩，不 repeat。
 * pits: [{x,z,rx,rz,depth}]，相对 bounds 原点的米坐标；heightRange 为解码的米范围。
 */
export function bakeGroundMask({ size, seed, bounds, heightRange, pits, macroMeters }) {
  if (!Number.isInteger(size) || size < 2 || size > 4096 || !Number.isInteger(seed)) throw new Error('ground3d: size 2..4096 整数、seed 整数');
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(x => !Number.isFinite(x)) || bounds[2] <= 0 || bounds[3] <= 0) throw new Error('ground3d: bounds=[x0,z0,width,depth]');
  if (!Array.isArray(heightRange) || heightRange.length !== 2 || !heightRange.every(Number.isFinite) || !(heightRange[1] > heightRange[0])) throw new Error('ground3d: heightRange=[min,max] 有限米');
  if (!(Number.isFinite(macroMeters) && macroMeters > 0) || !Array.isArray(pits)) throw new Error('ground3d: macroMeters>0 且有限、pits 数组必填');
  for (const p of pits) { ['x','z','rx','rz','depth'].forEach(k => finite(p[k], `pit.${k}`)); if (p.rx <= 0 || p.rz <= 0 || p.depth < 0) throw new Error('ground3d: pit 半径>0，depth≥0'); }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const wx = x / (size - 1) * bounds[2], wz = y / (size - 1) * bounds[3];
    const n = (freq, s) => tileNoise(wx / freq, wz / freq, 1024, seed + s);
    let h = heightRange[0] + (heightRange[1] - heightRange[0]) * (.35 + .4 * n(macroMeters, 1));
    for (const p of pits) h -= Math.exp(-(((wx - p.x) / p.rx) ** 2 + ((wz - p.z) / p.rz) ** 2)) * p.depth;
    const i = (y * size + x) * 4;
    data[i] = Math.round(255 * sat((h - heightRange[0]) / (heightRange[1] - heightRange[0])));
    data[i + 1] = Math.round(255 * sat(.6 * n(macroMeters * .7, 2) + .4 * (1 - data[i] / 255)));
    data[i + 2] = Math.round(255 * sat((n(macroMeters * .2, 3) * n(macroMeters, 4) - .3) * 3));
    data[i + 3] = Math.round(255 * n(macroMeters * .4, 5));
  }
  return { texture: dataTexture(data, size, { repeat: false }), data, bounds: bounds.slice(), heightRange: heightRange.slice() };
}

/** 镜像相机 + 斜近平面。render() 放在 S.frame 的 paint 末尾，所有物体已按 t 设置之后。
 * hide 为反射接收面数组（加载期确定），每次隐藏→渲染→恢复，不保留上一帧。
 */
export function createPlanarReflection(S, { height, width, resolution, clipBias, hide }) {
  finite(height, 'height'); finite(clipBias, 'clipBias');
  if (![width, resolution].every(x => Number.isInteger(x) && x > 0) || !Array.isArray(hide)) throw new Error('ground3d: width/resolution 正整数，hide 数组必填');
  const target = new THREE.WebGLRenderTarget(width, resolution, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const camera = new THREE.PerspectiveCamera(), matrix = new THREE.Matrix4();
  const bias = new THREE.Matrix4().set(.5,0,0,.5, 0,.5,0,.5, 0,0,.5,.5, 0,0,0,1);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -height);
  function render() {
    const source = S.camera, r = S.renderer;
    if (!source.isPerspectiveCamera) throw new Error('ground3d: 平面反射只支持透视相机');
    source.updateProjectionMatrix(); S.scene.updateMatrixWorld(true);
    const eye = source.getWorldPosition(new THREE.Vector3()), look = source.getWorldDirection(new THREE.Vector3()).add(eye);
    camera.copy(source, false); camera.parent = null;
    camera.position.set(eye.x, 2 * height - eye.y, eye.z);
    look.y = 2 * height - look.y;
    camera.up.set(0,1,0).transformDirection(source.matrixWorld); camera.up.y *= -1;
    camera.lookAt(look); camera.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.copy(source.projectionMatrix);
    matrix.copy(bias).multiply(camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    // Eric Lengyel 的斜近平面：剪掉水面下几何，消除穿帮。
    const cp = plane.clone().applyMatrix4(camera.matrixWorldInverse), v = new THREE.Vector4(cp.normal.x,cp.normal.y,cp.normal.z,cp.constant);
    const e = camera.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(v.x) + e[8]) / e[0], (Math.sign(v.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    const dot = v.dot(q); if (Math.abs(dot) < 1e-8) throw new Error('ground3d: 相机与反射裁面退化');
    v.multiplyScalar(2 / dot); e[2] = v.x; e[6] = v.y; e[10] = v.z + 1 - clipBias; e[14] = v.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const old = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel(), viewport = r.getViewport(new THREE.Vector4()), scissor = r.getScissor(new THREE.Vector4()), test = r.getScissorTest();
    const tone = r.toneMapping, colorSpace = r.outputColorSpace, xr = r.xr.enabled, visible = hide.map(o => o.visible);
    try {
      hide.forEach(o => { o.visible = false; }); r.xr.enabled = false; r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
      r.setRenderTarget(target); r.setScissorTest(false); r.clear(); r.render(S.scene, camera);
    } finally {
      hide.forEach((o,i) => { o.visible = visible[i]; }); r.xr.enabled = xr; r.toneMapping = tone; r.outputColorSpace = colorSpace;
      r.setRenderTarget(old,face,mip); r.setViewport(viewport); r.setScissor(scissor); r.setScissorTest(test);
    }
  }
  return { target, texture: target.texture, matrix, camera, render, dispose() { target.dispose(); } };
}

/** 标准 PBR 注入：唯一遮罩 + 双尺度颗粒 + 板缝 + 连续水位 + 闭式涟漪。
 * 颜色、粗糙度、湿润斜坡全部显式。反射替换 radiance（环境镜面输入），保留 three BRDF。
 */
export function applyGround(material, { mask, reflection, dryColor, wetColor, roughness, tileMeters, seam, transition, ripple }) {
  if (!material?.isMeshStandardMaterial || !mask?.texture) throw new Error('ground3d: 要标准 PBR 材质与 bakeGroundMask 结果');
  for (const [name,c] of Object.entries({dryColor,wetColor})) if (!Array.isArray(c) || c.length !== 3 || c.some(x => !Number.isFinite(x) || x < 0)) throw new Error(`ground3d: ${name} 要线性 RGB`);
  if (!Array.isArray(roughness) || roughness.length !== 4 || roughness.some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('ground3d: roughness=[干,潮,浸湿,积水] [0,1]');
  if (!Array.isArray(tileMeters) || tileMeters.length !== 2 || tileMeters.some(x => !(x > 0))) throw new Error('ground3d: tileMeters=[粗,细] 米');
  for (const [name,obj,keys] of [['seam',seam,['spacing','width','depth']],['transition',transition,['damp','soak','puddle']],['ripple',ripple,['scale','speed','amplitude']]]) {
    for (const k of keys) { finite(obj?.[k], `${name}.${k}`); if (obj[k] < 0 || (name !== 'ripple' && obj[k] === 0)) throw new Error(`ground3d: ${name}.${k} 无效`); }
  }
  const u = {
    uGMask:{value:mask.texture}, uGBounds:{value:new THREE.Vector4(...mask.bounds)}, uGRange:{value:new THREE.Vector2(...mask.heightRange)},
    uGDry:{value:new THREE.Color(...dryColor)}, uGWet:{value:new THREE.Color(...wetColor)}, uGRough:{value:new THREE.Vector4(...roughness)},
    uGTile:{value:new THREE.Vector2(...tileMeters)}, uGSeam:{value:new THREE.Vector3(seam.spacing,seam.width,seam.depth)},
    uGTransition:{value:new THREE.Vector3(transition.damp,transition.soak,transition.puddle)}, uGRipple:{value:new THREE.Vector3(ripple.scale,ripple.speed,ripple.amplitude)},
    uGTime:{value:0},uGWater:{value:0},uGWetness:{value:0},uGReflection:{value:reflection?.texture ?? null}, uGMatrix:{value:reflection?.matrix ?? new THREE.Matrix4()}
  };
  const prev = material.onBeforeCompile, prevKey = material.customProgramCacheKey, had = Object.hasOwn(material,'onBeforeCompile'), hadKey = Object.hasOwn(material,'customProgramCacheKey');
  const key = `ground1:${!!reflection}`;
  const inject = (s, token, code) => { if (!s.includes(token)) throw new Error(`ground3d: three chunk 缺失 ${token}`); return s.replace(token,`${token}\n${code}`); };
  material.onBeforeCompile = function(shader, renderer) {
    if (had) prev.call(this,shader,renderer); Object.assign(shader.uniforms,u);
    shader.vertexShader = inject(shader.vertexShader,'#include <common>','varying vec3 vGWorld; varying vec4 vGReflect; uniform mat4 uGMatrix;');
    shader.vertexShader = inject(shader.vertexShader,'#include <project_vertex>','vGWorld=(modelMatrix*vec4(transformed,1.)).xyz; vGReflect=uGMatrix*vec4(vGWorld,1.);');
    shader.fragmentShader = inject(shader.fragmentShader,'#include <common>',`
varying vec3 vGWorld; varying vec4 vGReflect;
uniform sampler2D uGMask,uGReflection; uniform vec4 uGBounds,uGRough;
uniform vec2 uGRange,uGTile; uniform vec3 uGDry,uGWet,uGSeam,uGTransition,uGRipple;
uniform float uGTime,uGWater,uGWetness;
float ghash(vec2 p){uvec2 v=uvec2(ivec2(p)); uint n=v.x*1664525u+v.y*1013904223u; n^=n>>16u;n*=2246822519u;n^=n>>13u;return float(n)/4294967296.;}
float gn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(ghash(i),ghash(i+vec2(1,0)),f.x),mix(ghash(i+vec2(0,1)),ghash(i+1.),f.x),f.y);}
float gpuddle,gdamp,gsoak,ggrain;
`);
    shader.fragmentShader = inject(shader.fragmentShader,'#include <color_fragment>',`
vec2 guv=(vGWorld.xz-uGBounds.xy)/uGBounds.zw;
vec4 gm=texture2D(uGMask,clamp(guv,0.,1.));
float gedge=smoothstep(0.,.05,min(min(guv.x,guv.y),min(1.-guv.x,1.-guv.y)));
gm=mix(vec4(1.,0.,0.,.5),gm,gedge);
ggrain=gn(vGWorld.xz/uGTile.x)+gn(vGWorld.xz/uGTile.y+17.3)-1.;
vec2 gs=abs(fract(vGWorld.xz/uGSeam.x+.5)-.5)*uGSeam.x;
float groove=1.-smoothstep(uGSeam.y*.4,uGSeam.y*.6,min(gs.x,gs.y));
float depth=uGWater-mix(uGRange.x,uGRange.y,gm.r)+groove*uGSeam.z+ggrain*.002;
gpuddle=smoothstep(0.,uGTransition.z,depth)*uGWetness;
gsoak=smoothstep(-uGTransition.y,0.,depth)*uGWetness;
gdamp=clamp((gm.g+smoothstep(-uGTransition.x,0.,depth))*.5*uGWetness,0.,1.);
diffuseColor.rgb*=mix(uGDry,uGWet,clamp(gdamp*.5+gsoak*.5,0.,1.))*(1.+ggrain*.12)*(1.-groove*.3)*(1.-gm.b*.2);
`);
    shader.fragmentShader = inject(shader.fragmentShader,'#include <roughnessmap_fragment>',`
roughnessFactor=mix(mix(mix(uGRough.x,uGRough.y,gdamp),uGRough.z,gsoak),uGRough.w,gpuddle);
// A 为唯一磨损分布；在非积水区对粗糙度做小幅调制，不把宏观磨损重复平铺。
roughnessFactor=clamp(roughnessFactor+(ggrain+gm.a-.5)*.05*(1.-gpuddle)-gm.b*.08, .02,1.);
`);
    shader.fragmentShader = inject(shader.fragmentShader,'#include <normal_fragment_maps>',`
vec2 rp=vGWorld.xz*uGRipple.x;
float phase=length(fract(rp)-.5)*28.-uGTime*uGRipple.y;
vec2 rn=normalize(fract(rp)-.5+vec2(.0001))*sin(phase)*uGRipple.z*gpuddle;
normal=normalize(normal+mat3(viewMatrix)*vec3(-rn.x,0.,-rn.y));
`);
    if (reflection) shader.fragmentShader = inject(shader.fragmentShader,'#include <lights_fragment_maps>',`
vec2 ruv=vGReflect.xy/vGReflect.w;
if(vGReflect.w>0. && all(greaterThanEqual(ruv,vec2(0.))) && all(lessThanEqual(ruv,vec2(1.)))){
  float lod=clamp(roughnessFactor*7.,0.,7.);
  radiance=mix(radiance,textureLod(uGReflection,ruv,lod).rgb,gpuddle);
}
`);
  };
  material.customProgramCacheKey=function(){return key+(hadKey?'|'+prevKey.call(this):'');};
  material.uniforms=Object.assign(material.uniforms??{},u); material.needsUpdate=true;
  return { uniforms:u, set({t,waterLevel,wetness}) { finite(t,'t');finite(waterLevel,'waterLevel');finite(wetness,'wetness'); if(wetness<0||wetness>1)throw new Error('ground3d: wetness 要 [0,1]'); u.uGTime.value=t;u.uGWater.value=waterLevel;u.uGWetness.value=wetness; } };
}
