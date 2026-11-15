// particles3d.js —— 闭式粒子：粒子 i 在时刻 t 的位置/大小/颜色是 (i, 它的种子, t) 的函数，不积分、不存上一帧。
//
// 两种实现，同一套写法（参见 SKILL.md 的代价表，按实测选）：
//   createParticles     GPU：运动写成 GLSL 函数 particle(...)，顶点着色器里每帧对每个粒子求一次。JS 每帧只传一个 uTime。
//   createCPUParticles  CPU：运动写成 JS 函数，每帧算满整个数组再上传。可以用任意 JS（查表、样条、读 narration），
//                       粒子位置在 JS 侧拿得到（锚点可以逐个登记）；代价是 JS 计算 + 上传随粒子数线性涨。
//
// 为什么是闭式：粒子系统最常见的写法是 p += v*dt —— 结果依赖上一帧，乱序求值就错（seamcheck 门 2）。
// 闭式的代价是表达力：真正"沿 curl 场被平流"的轨迹没有闭式解。这里能做的是**位移场**
// （p = 出生点 + 速度·age + 噪声(出生点, age)·幅度），看起来像湍流，但不是平流；
// 真要积分，走 film-physics 的从 0 重放 / 检查点缓存，再把位置交给 createCPUParticles 画。
//
// 循环寿命：lifecycle(t, life, phase) 给出"第 k 次生命、生命内 age"，rebirth(id, k) 给每次重生一组新随机数——
// 粒子 i 在 t 的状态只依赖 (i, floor(t/life + phase))，任意 t 直接求值。
//
// 这里不给默认的形状、颜色、混合模式：sprite 形状从 SPRITE 里挑或自己写，blending 必填。

import * as THREE from './three-film.module.js';
import { GLSL } from './webfx.js';

import { seeded as mulberry32 } from './rand.js';   // film-core 的种子随机（全套件唯一一份）

/** 顶点着色器里可用的辅助函数（GLSL）：hash12/hash13/vnoise/vnoise3/fbm（来自 webfx.js）+ 下面三个 */
export const PARTICLE_GLSL = GLSL.hash + GLSL.noise + `
// 粒子的第 k 次生命：寿命 life（秒），相位 phase ∈ [0,1) 错开各粒子。返回 vec3(age 秒, age/life, k)
vec3 lifecycle(float t, float life, float phase){ float x = t / life + phase; float k = floor(x); float a = x - k; return vec3(a * life, a, k); }
// 第 k 次重生的 4 个随机数：只依赖 (id, k)，所以任意 t 直接求值
vec4 rebirth(float id, float k){ return vec4(hash13(vec3(id, k, 1.7)), hash13(vec3(id, k, 2.3)), hash13(vec3(id, k, 3.1)), hash13(vec3(id, k, 4.9))); }
// 平滑位移场（不是速度场积分）：三维值噪声在 (p·freq, s) 处的三个分量，范围约 [-1,1]
vec3 drift(vec3 p, float s){ return vec3(vnoise3(p + vec3(0., 0., s)), vnoise3(p + vec3(31.7, 0., s)), vnoise3(p + vec3(0., 57.3, s))) * 2. - 1.; }
`;

/** 片元着色器里的 sprite 形状。都是 `vec4 sprite(vec4 col, float aux)`，返回预乘前的颜色与 alpha */
export const SPRITE = {
  /** 实心圆，边缘 1px 抗锯齿 */
  disc: `vec4 sprite(vec4 col, float aux){ vec2 q = gl_PointCoord * 2. - 1.; float r = length(q); float e = 2. / max(vPx, 1.); return vec4(col.rgb, col.a * smoothstep(1., 1. - e, r)); }`,
  /** 高斯状软点（中心亮、向外衰减） */
  soft: `vec4 sprite(vec4 col, float aux){ vec2 q = gl_PointCoord * 2. - 1.; float d = dot(q, q); if (d > 1.) discard; return vec4(col.rgb, col.a * exp(-4. * d) * (1. - d)); }`,
  /** 方块（点精灵本身） */
  square: `vec4 sprite(vec4 col, float aux){ return col; }`,
  /** 图集：uAtlas 是 cols×cols 格的纹理，aux = 格号。字符、符号、贴图碎片都走这个 */
  atlas: (cols) => `uniform sampler2D uAtlas;
vec4 sprite(vec4 col, float aux){ float g = floor(aux + .5); vec2 cell = vec2(mod(g, ${cols.toFixed(1)}), floor(g / ${cols.toFixed(1)}));
  // gl_PointCoord 原点在左上、y 向下；纹理按 three 默认 flipY 上传，v=1 是画布顶边 → 格子从画布左上数起
  vec2 uv = vec2((cell.x + gl_PointCoord.x) / ${cols.toFixed(1)}, 1. - (cell.y + gl_PointCoord.y) / ${cols.toFixed(1)});
  vec4 a = texture2D(uAtlas, uv); return vec4(col.rgb * a.rgb, col.a * a.a); }`,
};

const BLEND = { add: THREE.AdditiveBlending, normal: THREE.NormalBlending, multiply: THREE.MultiplyBlending, subtract: THREE.SubtractiveBlending };

function common(S, o) {
  if (!(o.count > 0)) throw new Error('particles3d: count 必填且 > 0');
  if (!o.sprite) throw new Error('particles3d: sprite 必填（SPRITE.disc / soft / square / atlas(cols)，或自己写 vec4 sprite(vec4 col, float aux)）');
  if (!BLEND[o.blending]) throw new Error(`particles3d: blending 必填：${Object.keys(BLEND).join(' / ')}（叠加方式是风格，不给默认）`);
  const gl = S.renderer.getContext();
  const maxPx = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  return { maxPx, blending: BLEND[o.blending] };
}

const FRAG = (sprite) => `varying vec4 vCol; varying float vAux; varying float vPx;
${sprite}
void main(){ vec4 c = sprite(vCol, vAux); if (c.a <= 0.) discard; gl_FragColor = vec4(c.rgb * c.a, c.a); }`;
// 输出预乘色 + 预乘混合（premultipliedAlpha:true），和 stage 的预乘约定一致

const SIZE_TAIL = `
  vec4 mv = modelViewMatrix * vec4(pos, 1.);
  gl_Position = projectionMatrix * mv;
  float px = size * uFocal / max(-mv.z, 1e-4);
  // 小于 1px 的点不缩成 0（会闪），而是按面积降 alpha：亮度守恒、跨帧不闪
  float cov = clamp(px, 0., 1.);
  if (size <= 0. || col.a <= 0. || mv.z > 0.) { gl_Position = vec4(2., 2., 2., 1.); cov = 0.; }
  gl_PointSize = clamp(max(px, 1.), 1., uMaxPx);
  vCol = vec4(col.rgb, col.a * cov * cov); vAux = aux; vPx = gl_PointSize;
`;

/**
 * GPU 闭式粒子。
 * @param S  createStage3D 的返回
 * @param o.count    粒子数
 * @param o.seed     种子（每个粒子的 aRnd / aRnd2 两个 vec4 由它在加载期生成）
 * @param o.kernel   GLSL：`void particle(float id, vec4 rnd, vec4 rnd2, float t, inout vec3 pos, inout float size, inout vec4 col, inout float aux)`
 *                   pos 世界坐标、size 世界单位（0 = 不画）、col 线性 rgb + alpha、aux 交给 sprite（如图集格号）。
 *                   可以在 kernel 前面声明自己的 uniform，值经 o.uniforms 给（每帧要变的在 update 里传）。
 * @param o.sprite   SPRITE.* 或自己的片元函数
 * @param o.blending 'add' | 'normal' | 'multiply' | 'subtract'
 * @param o.period   >0 时 uTime = t mod period（JS 用 double 取模；长片避免 float32 抖动）
 * @param o.uniforms { 名: 初值 }（数、THREE.Vector*、Color、Texture）
 */
export function createParticles(S, o) {
  const { maxPx, blending } = common(S, o);
  const N = o.count, rnd = mulberry32(o.seed ?? 1);
  const id = new Float32Array(N), r1 = new Float32Array(N * 4), r2 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { id[i] = i; for (let k = 0; k < 4; k++) { r1[i * 4 + k] = rnd(); r2[i * 4 + k] = rnd(); } }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));   // three 要它定绘制数量；位置在着色器里算
  geo.setAttribute('aId', new THREE.BufferAttribute(id, 1));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(r1, 4));
  geo.setAttribute('aRnd2', new THREE.BufferAttribute(r2, 4));
  const uniforms = { uTime: { value: 0 }, uFocal: { value: 1 }, uMaxPx: { value: maxPx } };
  for (const [k, v] of Object.entries(o.uniforms ?? {})) uniforms[k] = { value: v };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: o.depthWrite ?? false, depthTest: o.depthTest ?? true,
    blending, premultipliedAlpha: true,
    vertexShader: `attribute float aId; attribute vec4 aRnd; attribute vec4 aRnd2;
uniform float uTime, uFocal, uMaxPx;
varying vec4 vCol; varying float vAux; varying float vPx;
${PARTICLE_GLSL}
${o.kernel}
void main(){
  vec3 pos = vec3(0.); float size = 0.; vec4 col = vec4(1.); float aux = 0.;
  particle(aId, aRnd, aRnd2, uTime, pos, size, col, aux);
${SIZE_TAIL}
}`,
    fragmentShader: FRAG(o.sprite),
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;   // 位置在着色器里，CPU 侧的包围球不对
  const period = o.period ?? 0;
  return {
    points, material, geometry: geo, count: N,
    /** 每帧调：传 t 与这一帧要变的 uniform（没传的回到 freeze 时的值——stage 的复位管它） */
    update(t, values = {}) {
      uniforms.uTime.value = period > 0 ? ((t % period) + period) % period : t;
      uniforms.uFocal.value = (S.height / 2) * S.camera.projectionMatrix.elements[5];
      for (const [k, v] of Object.entries(values)) {
        if (!uniforms[k]) throw new Error(`particles3d: uniform ${k} 没在 o.uniforms 里声明`);
        if (v && v.isTexture) uniforms[k].value = v; else if (uniforms[k].value?.copy && typeof v === 'object') uniforms[k].value.copy(v); else uniforms[k].value = v;
      }
    },
  };
}

/**
 * CPU 闭式粒子：fn(i, rnd, t, out) 写 out.x/y/z、out.size、out.r/g/b/a、out.aux。rnd 是这个粒子的 8 个随机数（加载期定）。
 * 每帧算满 count 个、整块上传——没写到的粒子会被清成不可见（不会留着上一帧的值）。
 */
export function createCPUParticles(S, o) {
  const { maxPx, blending } = common(S, o);
  if (typeof o.fn !== 'function') throw new Error('particles3d: createCPUParticles 要 fn(i, rnd, t, out)');
  const N = o.count, rnd = mulberry32(o.seed ?? 1);
  const R = Array.from({ length: N }, () => Float64Array.from({ length: 8 }, () => rnd()));
  const pos = new Float32Array(N * 3), size = new Float32Array(N), col = new Float32Array(N * 4), aux = new Float32Array(N);
  const geo = new THREE.BufferGeometry();
  const A = (name, arr, k) => { const a = new THREE.BufferAttribute(arr, k); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; };
  const aPos = A('position', pos, 3), aSize = A('aSize', size, 1), aCol = A('aCol', col, 4), aAux = A('aAux', aux, 1);
  const uniforms = { uFocal: { value: 1 }, uMaxPx: { value: maxPx } };
  for (const [k, v] of Object.entries(o.uniforms ?? {})) uniforms[k] = { value: v };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: o.depthWrite ?? false, depthTest: o.depthTest ?? true, blending, premultipliedAlpha: true,
    vertexShader: `attribute float aSize; attribute vec4 aCol; attribute float aAux;
uniform float uFocal, uMaxPx;
varying vec4 vCol; varying float vAux; varying float vPx;
void main(){
  vec3 pos = position; float size = aSize; vec4 col = aCol; float aux = aAux;
${SIZE_TAIL}
}`,
    fragmentShader: FRAG(o.sprite),
  });
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  const out = { x: 0, y: 0, z: 0, size: 0, r: 1, g: 1, b: 1, a: 1, aux: 0 };
  return {
    points, material, geometry: geo, count: N,
    /** 每帧调：对每个粒子求一次 fn，整块上传。返回位置数组（Float32Array，x,y,z 交错）——JS 侧要用位置（锚点、碰撞）时读它 */
    update(t) {
      uniforms.uFocal.value = (S.height / 2) * S.camera.projectionMatrix.elements[5];
      for (let i = 0; i < N; i++) {
        out.x = out.y = out.z = 0; out.size = 0; out.r = out.g = out.b = out.a = 1; out.aux = 0;
        o.fn(i, R[i], t, out);
        pos[i * 3] = out.x; pos[i * 3 + 1] = out.y; pos[i * 3 + 2] = out.z;
        size[i] = out.size; col[i * 4] = out.r; col[i * 4 + 1] = out.g; col[i * 4 + 2] = out.b; col[i * 4 + 3] = out.a; aux[i] = out.aux;
      }
      aPos.needsUpdate = aSize.needsUpdate = aCol.needsUpdate = aAux.needsUpdate = true;
      return pos;
    },
  };
}
