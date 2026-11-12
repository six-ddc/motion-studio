// post3d.js —— stage3d 的后期链：泛光、景深、体积光、色差、颗粒、暗角、扫描线、故障。全部按 t 求值。
//
// 结构（哪些效果存在、多少级、多少采样）在 createPost 时定死、着色器只编译一次；
// **强度类参数每帧全量传**：post.render(t, params) 里缺一个就抛错——不缺省成上一帧的值（那是跨帧状态），
// 也不缺省成某个"好看的默认"（那是审美）。所有风格参数（阈值、强度、半径、颗粒量、暗角形状……）都没有默认值。
//
// 管线（单个 WebGL2 context 里用 render target 串，不经 2D 中转）：
//   场景 → rtScene（HalfFloat 线性 HDR，可选 MSAA、深度纹理）
//     ├ bloom   ：亮部提取(1/2) → 下采样链（13 tap，Jimenez 2014 / UnrealBloom / pmndrs MipmapBlur）→ 帐篷上采样回 1/2
//     ├ dof     ：单遍散射式聚集（Gustafsson 2018 的螺旋采样），分辨率可调；CoC = blur·|1 − focus/z|
//     ├ godrays ：亮部提取(1/4) → 朝光源屏幕位置的径向模糊（GPU Gems 3 第 13 章）
//     └ 合成一遍（pmndrs EffectPass 的思路：逐像素效果合进一个着色器，只付一次全屏）：
//         故障位移 → 色差（三次取色）→ 叠泛光/体积光 → 曝光 + 色调映射 → sRGB → 暗角 → 扫描线 → 颗粒
//
// 为什么合成要合成一遍：SwiftShader 下每个全屏遍至少几 ms（1080×1920 最便宜的一遍 ≈3–4 ms，见 bench3d.mjs），
// 色差/颗粒/暗角/扫描线各开一遍要多付 3–4 遍；合进一遍几乎只剩采样本身的成本。
//
// 用法：
//   import { createPost } from './runtime/post3d.js';
//   const post = createPost(S, { bloom: { levels: 5 }, dof: {}, chroma: true, grain: true, vignette: true });
//   S.frame(t, paint, {               // 每帧全量
//     exposure: 1,
//     bloom: { threshold: .8, knee: .2, strength: .9, radius: .7 },
//     dof: { focus: 6.5, blur: 14, maxBlur: 18 },
//     chroma: { amount: 2.5 }, grain: { amount: .06, fps: 24 }, vignette: { amount: .5, radius: .75, softness: .45 },
//   });
// 这些数只是示例，不是推荐值——它们由本片 style_guide 定。
//
// 显式开启的扩展（不开 = 上面那条链逐像素不变；参数、两条链的顺序图、实测代价见 film-webfx references/post-chain.md）：
//   bloom: { mode:'mix', karis, clamp? }   能量守恒泛光：无阈值、逐级 mix 上采样、最终 mix(col, bloom, strength)
//   ao: { samples, resolution }            屏幕空间 AO（深度重建法线、螺旋采样、深度感知模糊、联合双边上采样、只压环境光区域）
//   volume: { steps, light, resolution, horizonGLSL?, horizonUniforms? }   步进体积雾（太阳阴影图、高度介质、双瓣 HG、解析远景）
//   dirt / streak / flare                  镜头脏污（加载期按种子生成）/ 变形镜头拉丝 / 太阳眩光与幽灵（可见度取当帧深度）
//   tonemap: { curves:[a, b?] } + grade    显示链：曝光 → 两条曲线按比例混合 → 显示线性域调色 → 分段 sRGB 编码
//   finish: { fxaa, sharpen, grain, dither }  编码之后一遍：FXAA（luma 存 alpha）、反锐化、三角颗粒、去色带抖动
//   post.measure() / exposureTrack()       离线测光表 → exposure(t)（流程见 post-chain.md）

import * as THREE from './three-film.module.js';
import { seeded } from './rand.js';

const VERT = `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// 与 webfx.js GLSL.hash 同一个 hash（Dave Hoskins，不依赖 sin 的实现精度）
const HASH = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`;
const LUMA = `float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;
const VIEWZ = `float viewDepth(float d, float n, float f){ return (n * f) / (f - d * (f - n)); }`;   // 深度缓冲 → 到相机平面的距离

function need(p, effect, keys) {
  if (!p) throw new Error(`post3d: 这一帧没传 ${effect} 的参数。每帧全量传（不传 = 上一帧的值或某个默认，两种都不行）；关掉就把强度传 0`);
  for (const k of keys) if (p[k] == null || (typeof p[k] === 'number' && !Number.isFinite(p[k])))
    throw new Error(`post3d: ${effect}.${k} 必填（风格参数，由本片 style_guide 定）`);
  return p;
}
// 定长数组参数（颜色、区间……）：长度不对或含非有限数就抛错
function vec(p, effect, k, n) {
  const v = p[k];
  if (!Array.isArray(v) || v.length !== n || v.some((x) => !Number.isFinite(x))) throw new Error(`post3d: ${effect}.${k} 必填，${n} 个有限数（风格参数，由本片 style_guide 定）`);
  return v;
}

// 交错梯度噪声（Jimenez 2014）：屏幕坐标的纯函数，逐帧不变——抖动步进起点、旋转采样圈
const IGN = `float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

// 显示链的色调映射曲线（输入：曝光后的线性 sRGB；输出：显示线性 0–1）
const TONEMAP = {
  // Hill 的 ACES 拟合（RRT+ODT 有理式）
  aces: `vec3 tmAces(vec3 c){
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  vec3 v = inM * c; vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(outM * (a / b), 0., 1.); }`,
  // AgX（Filament / Blender 拟合，与 three 的 AgXToneMapping 同一组矩阵），look 段：pow(power) + 以 luma 为中心的饱和度 sat（1,1 = 不加 look）
  agx: `uniform vec2 tmAgxLook;
vec3 tmAgx(vec3 color){
  const mat3 toR = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 fromR = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  color = inset * (toR * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.500999, 0., 1.);
  vec3 x2 = color * color, x4 = x2 * x2;
  color = 15.5 * x4 * x2 - 40.14 * x4 * color + 31.96 * x4 - 6.868 * x2 * color + 0.4298 * x2 + 0.1191 * color - 0.00232;
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color, vec3(0.)), vec3(tmAgxLook.x));
  color = l + (color - l) * tmAgxLook.y;
  color = pow(max(outset * color, vec3(0.)), vec3(2.2));
  return clamp(fromR * color, 0., 1.); }`,
  // Khronos PBR Neutral（色相基本不动，只压高光）
  neutral: `vec3 tmNeutral(vec3 c){
  float x = min(c.r, min(c.g, c.b)); float off = x < 0.08 ? x - 6.25 * x * x : 0.04; c -= off;
  float pk = max(c.r, max(c.g, c.b)); if (pk < 0.76) return c;
  float np = 1. - 0.0576 / (pk + 0.24 - 0.76); c *= np / pk;
  float g = 1. - 1. / (0.15 * (pk - np) + 1.); return clamp(mix(c, vec3(np), g), 0., 1.); }`,
};
const TM_FN = { aces: 'tmAces', agx: 'tmAgx', neutral: 'tmNeutral' };

/**
 * 离线测光表 → exposure(t)。纯函数：表在加载期读进来，平滑在这里一次算完，求值只是查表插值。
 *   table   离线扫片写的 JSON：{ fps, logAvg: [每个采样点的对数平均亮度（自然对数，曝光前的 HDR）] }
 *   key     目标中灰（曝光后的平均亮度）
 *   power   补偿指数：1 = 完全补偿到 key，<1 = 只补一部分（暗场仍偏暗）
 *   min,max 曝光倍数的上下限
 *   tau     因果平滑时间常数（秒，0 = 不平滑）；在对数域做一阶指数平滑，只看过去，所以亮度突变后曝光"慢慢跟上"
 * 返回 (t) => 曝光倍数；表外按两端取值。这几项都是风格参数，没有默认值。
 */
export function exposureTrack(table, o = {}) {
  if (!table || !Number.isFinite(table.fps) || !(table.fps > 0) || !Array.isArray(table.logAvg) || !table.logAvg.length || table.logAvg.some((x) => !Number.isFinite(x)))
    throw new Error('post3d.exposureTrack: table 要是 离线扫片写的 { fps, logAvg:[有限数…] }');
  for (const k of ['key', 'power', 'min', 'max', 'tau']) if (!Number.isFinite(o[k])) throw new Error(`post3d.exposureTrack: ${k} 必填（风格参数）`);
  if (!(o.key > 0) || !(o.min > 0) || o.max < o.min || o.tau < 0) throw new Error('post3d.exposureTrack: 要求 key>0、0<min≤max、tau≥0');
  const dt = 1 / table.fps, rate = o.tau > 0 ? 1 - Math.exp(-dt / o.tau) : 1;
  const e = new Float64Array(table.logAvg.length);
  let a = table.logAvg[0];
  for (let i = 0; i < e.length; i++) {
    a += rate * (table.logAvg[i] - a);
    e[i] = Math.min(o.max, Math.max(o.min, Math.pow(o.key / Math.exp(a), o.power)));
  }
  return (t) => {
    if(!Number.isFinite(t)) throw new Error('post3d.exposureTrack: t 要是有限数');
    const u = Math.min(e.length - 1, Math.max(0, t * table.fps)), i = Math.floor(u), f = u - i;
    return i + 1 < e.length ? e[i] + (e[i + 1] - e[i]) * f : e[i];
  };
}

/**
 * @param {object} S  createStage3D 的返回
 * @param {object} cfg 结构参数（加载期定死）：
 *   samples        场景 MSAA 采样数（0 = 关；WebGL2 多重采样 RT）
 *   hdr            场景缓冲用 HalfFloat（默认 true；false = 8 位，泛光阈值只能 < 1）
 *   bloom: { levels=5, resolution=0.5 }
 *   dof:   { resolution=0.5, step=0.5 }   step 越小采样越多越贵（Gustafsson 的 RAD_SCALE）
 *   godrays: { samples=48, resolution=0.25 }
 *   chroma / grain / vignette / scanlines / glitch: true 或 {}
 *   output: THREE.WebGLRenderTarget —— 不直接上屏，渲进这里（还要再处理时）
 */
export function createPost(S, cfg = {}) {
  const { renderer, width: W, height: H } = S;
  const gl = renderer.getContext();
  const hdr = cfg.hdr ?? true;
  const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const want = (k) => cfg[k] !== undefined && cfg[k] !== false;
  const opt = (k) => (typeof cfg[k] === 'object' && cfg[k] ? cfg[k] : {});
  const E = { bloom: want('bloom'), dof: want('dof'), godrays: want('godrays'), chroma: want('chroma'), grain: want('grain'),
    vignette: want('vignette'), scanlines: want('scanlines'), glitch: want('glitch'),
    // 以下是显式开启的扩展（references/post-chain.md）；都不开时上面那条链逐像素不变
    ao: want('ao'), volume: want('volume'), dirt: want('dirt'), streak: want('streak'), flare: want('flare'),
    tonemap: want('tonemap'), grade: want('grade'), finish: want('finish') };
  for (const k of Object.keys(cfg)) if (!['samples', 'hdr', 'output', 'seed', ...Object.keys(E)].includes(k)) throw new Error(`post3d: 不认识的效果 ${k}`);
  for (const k of ['ao', 'volume', 'bloom', 'dof', 'godrays']) {
    const r = opt(k).resolution;
    if (E[k] && r != null && !(Number.isFinite(r) && r > 0 && r <= 1)) throw new Error(`post3d: ${k}.resolution 要在 (0,1]`);
  }
  if ((E.ao || E.volume) && !S.camera.isPerspectiveCamera) throw new Error('post3d: AO / volume 的深度重建需要透视相机');
  const bloomMix = E.bloom && opt('bloom').mode === 'mix';
  if (E.bloom && opt('bloom').mode !== undefined && !['add', 'mix'].includes(opt('bloom').mode)) throw new Error(`post3d: bloom.mode 只能是 'add' 或 'mix'，收到 ${opt('bloom').mode}`);
  if (bloomMix && !(Number.isFinite(opt('bloom').karis) && opt('bloom').karis >= 0)) throw new Error('post3d: bloom.mode=\'mix\' 时 karis 必填（首级部分 Karis 平均的系数，0 = 不做）');
  if (bloomMix && opt('bloom').clamp != null && !(Number.isFinite(opt('bloom').clamp) && opt('bloom').clamp > 0)) throw new Error('post3d: bloom.clamp 要是正的有限数');
  if (E.streak && opt('streak').level != null && !(Number.isInteger(opt('streak').level) && opt('streak').level >= 0)) throw new Error('post3d: streak.level 要是非负整数');
  if ((E.grade || E.finish) && !E.tonemap) throw new Error('post3d: grade / finish 属于显示链，要同时开 tonemap: { curves: [...] }');
  if (E.finish && E.grain) throw new Error('post3d: 开了 finish 就用 finish.grain（编码之后、FXAA 之后加颗粒）；旧的 grain 会被 FXAA 抹掉');
  if ((E.dirt || E.streak) && !E.bloom) throw new Error('post3d: dirt / streak 要从泛光链取光（dirt = 泛光 × 脏污，streak 取泛光的低级 mip），先开 bloom');
  const curves = E.tonemap ? opt('tonemap').curves : null;
  if (E.tonemap && (!Array.isArray(curves) || curves.length < 1 || curves.length > 2 || curves.some((c) => !TM_FN[c])))
    throw new Error(`post3d: tonemap.curves 要是 1–2 条曲线（${Object.keys(TM_FN).join(' / ')}），两条时每帧传 tonemap.mix`);

  const mkRT = (w, h, extra = {}) => new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...extra,
  });
  const depthTex = (E.dof || E.ao || E.volume || E.flare) ? new THREE.DepthTexture(W, H, THREE.UnsignedIntType) : null;
  const rtScene = mkRT(W, H, { depthBuffer: true, samples: cfg.samples ?? 0, ...(depthTex ? { depthTexture: depthTex } : {}) });
  // AO / 体积雾合成之后的 HDR 缓冲：之后的泛光、景深、体积光、合成都从它取。不开这两样就是 rtScene 本身
  const rtLit = (E.ao || E.volume) ? mkRT(W, H) : null;
  let litActive=!!rtLit;
  const src={get texture(){return litActive?rtLit.texture:rtScene.texture;}};

  // 全屏三角形
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(quadGeo, null); quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra,
  });
  const pass = (m, target) => { quad.material = m; renderer.setRenderTarget(target); renderer.render(qScene, qCam); };

  // ---------- AO / 体积雾（显式开启） ----------
  // 线性深度：按各自分辨率从全分辨率深度 texelFetch 点采样（落在 texel 角上双线性取会挑错行，掠射地面上出条带），R32F
  const zRTs = new Map();
  const zMat = (E.ao || E.volume) ? mat(`varying vec2 vUv; uniform sampler2D tDepth; uniform float near, far, scale; ${VIEWZ}
void main(){
  ivec2 sz = textureSize(tDepth, 0);
  ivec2 p = min(ivec2((floor(gl_FragCoord.xy) + 0.5) * scale), sz - 1);
  gl_FragColor = vec4(viewDepth(texelFetch(tDepth, p, 0).r, near, far), 0., 0., 1.);
}`, { tDepth: { value: depthTex }, near: { value: 0.1 }, far: { value: 100 }, scale: { value: 1 } }) : null;
  const zFor = (res) => {
    if (!zRTs.has(res)) zRTs.set(res, mkRT(W * res, H * res, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
    return zRTs.get(res);
  };
  // 深度感知的 7 tap 可分离模糊（AO 与体积雾共用）：权重随 |Δz|/z 超过容差线性降到 0
  const blurM = (E.ao || E.volume) ? mat(`varying vec2 vUv; uniform sampler2D tSrc, tZ; uniform vec2 dir; uniform float tol;
void main(){
  float zc = texture2D(tZ, vUv).r; vec4 acc = vec4(0.); float ws = 0.;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + dir * float(i);
    float z = texture2D(tZ, uv).r;
    float w = (1. - abs(float(i)) * .22) * max(0., 1. - abs(z - zc) / (tol * zc + .02));
    acc += texture2D(tSrc, uv) * w; ws += w;
  }
  gl_FragColor = ws > 1e-4 ? acc / ws : texture2D(tSrc, vUv);
}`, { tSrc: { value: null }, tZ: { value: null }, dir: { value: new THREE.Vector2() }, tol: { value: 0.1 } }) : null;
  const blur2 = (a, b, z, tol) => {   // a → b（横）→ a（竖），结果留在 a
    blurM.uniforms.tZ.value = z.texture; blurM.uniforms.tol.value = tol;
    blurM.uniforms.tSrc.value = a.texture; blurM.uniforms.dir.value.set(1 / a.width, 0); pass(blurM, b);
    blurM.uniforms.tSrc.value = b.texture; blurM.uniforms.dir.value.set(0, 1 / a.height); pass(blurM, a);
  };
  // 视线：透视相机下 ray(uv) 在 ndc 上是仿射的（含 setViewOffset 的主点偏移），由两个角上的射线插出来，z 分量归一到 −1
  const _r = new THREE.Vector4();
  const rayCorners = (out) => {
    const inv = S.camera.projectionMatrixInverse;
    _r.set(-1, -1, 1, 1).applyMatrix4(inv); const ax = _r.x / -_r.z, ay = _r.y / -_r.z;
    _r.set(1, 1, 1, 1).applyMatrix4(inv); out.set(ax, ay, _r.x / -_r.z, _r.y / -_r.z);
  };
  const RAY = `uniform vec4 uRay; vec3 rayAt(vec2 uv){ return vec3(mix(uRay.x, uRay.z, uv.x), mix(uRay.y, uRay.w, uv.y), -1.); }`;

  let ao = null;
  if (E.ao) {
    const o = opt('ao'), res = o.resolution ?? 0.5, N = o.samples;
    if (!(Number.isInteger(N) && N >= 1 && N <= 64)) throw new Error('post3d: ao.samples 必填（1–64 的整数；采样数是成本与噪声的取舍，不给默认）');
    const rtA = mkRT(W * res, H * res), rtB = mkRT(W * res, H * res);
    // 由深度重建法线（左右、上下各取深度差小的一侧，不跨边缘）；3 圈螺旋 N 个采样，起始角按 IGN 旋转；
    // 每个采样的贡献 (R²−|v|²)³·max((v·n − bias)/(|v|²+ε), 0)；70%–100% 远处淡出由 fade 给
    const m = mat(`varying vec2 vUv; uniform sampler2D tZ; uniform vec2 texel; uniform float radius, intensity, aspect, fadeNear, fadeFar, skyZ;
${IGN} ${RAY}
void main(){
  float z0 = texture2D(tZ, vUv).r;
  if (z0 >= skyZ) { gl_FragColor = vec4(1.); return; }
  vec3 P = rayAt(vUv) * z0;
  vec2 ox = vec2(texel.x, 0.), oy = vec2(0., texel.y);
  float zl = texture2D(tZ, vUv - ox).r, zr = texture2D(tZ, vUv + ox).r, zd = texture2D(tZ, vUv - oy).r, zu = texture2D(tZ, vUv + oy).r;
  vec3 dx = abs(zl - z0) < abs(zr - z0) ? P - rayAt(vUv - ox) * zl : rayAt(vUv + ox) * zr - P;
  vec3 dy = abs(zd - z0) < abs(zu - z0) ? P - rayAt(vUv - oy) * zd : rayAt(vUv + oy) * zu - P;
  vec3 n = normalize(cross(dx, dy));
  float R = radius, R2 = R * R;
  float rUv = clamp(R / (z0 * (uRay.w - uRay.y)), 3. * texel.y, .14);
  float rot = ign(gl_FragCoord.xy) * 6.2831853, sum = 0.;
  for (int i = 0; i < ${N}; i++) {
    float a = (float(i) + .5) / float(${N});
    float th = a * 6.2831853 * 3. + rot;
    vec2 o = vec2(cos(th), sin(th)) * a * rUv; o.x /= aspect;
    vec2 uv2 = vUv + o;
    vec3 v = rayAt(uv2) * texture2D(tZ, uv2).r - P;
    float vv = dot(v, v), f = max(R2 - vv, 0.);
    sum += f * f * f * max((dot(v, n) - (.015 + .004 * z0)) / (vv + .004), 0.);
  }
  float occ = max(0., 1. - intensity * sum * 5. / (R2 * R2 * R2 * float(${N})));
  occ = mix(occ, 1., smoothstep(fadeNear, fadeFar, z0));
  gl_FragColor = vec4(vec3(occ), 1.);
}`, { tZ: { value: null }, texel: { value: new THREE.Vector2() }, uRay: { value: new THREE.Vector4() }, radius: { value: 1 }, intensity: { value: 1 },
      aspect: { value: W / H }, fadeNear: { value: 50 }, fadeFar: { value: 100 }, skyZ: { value: 1e9 } });
    ao = {
      res, out: () => rtA.texture,
      run(p, z) {
        const u = m.uniforms;
        u.tZ.value = z.texture; u.texel.value.set(1 / rtA.width, 1 / rtA.height); rayCorners(u.uRay.value);
        u.radius.value = p.radius; u.intensity.value = p.intensity; u.fadeNear.value = p.fade[0]; u.fadeFar.value = Math.max(p.fade[0] + 1e-3, p.fade[1]);
        u.skyZ.value = S.camera.far * 0.97;
        pass(m, rtA); blur2(rtA, rtB, z, p.tolerance);
      },
      rts: [rtA, rtB], mats: [m],
    };
  }

  let vol = null;
  if (E.volume) {
    const o = opt('volume'), res = o.resolution ?? 0.5, N = o.steps, light = o.light;
    if(renderer.shadowMap.type === THREE.VSMShadowMap)throw new Error('post3d: volume 要读深度阴影，不支持 VSM 方差阴影');
    if (!(Number.isInteger(N) && N >= 2 && N <= 256)) throw new Error('post3d: volume.steps 必填（2–256 的整数；离线可以 64+，成本与步数成正比）');
    if (!light || !light.isDirectionalLight) throw new Error('post3d: volume.light 必填：投阴影的 THREE.DirectionalLight（castShadow，renderer.shadowMap.enabled）');
    if (o.horizonGLSL != null && (typeof o.horizonGLSL !== 'string' || !/vec3\s+horizonColor\s*\(/.test(o.horizonGLSL)))
      throw new Error('post3d: volume.horizonGLSL 要是一段定义了 vec3 horizonColor(vec3 dir) 的 GLSL 字符串（连同它的 uniform 声明）');
    const hasHorizon = typeof o.horizonGLSL === 'string';
    if(hasHorizon){
      const reserved=new Set(['tZ','tShadow','shadowMatrix','camRot','camPos','uRay','skyZ']);
      for(const m of o.horizonGLSL.matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)){
        const name=m[1],slot=o.horizonUniforms?.[name];
        if(reserved.has(name)||name.startsWith('pv'))throw new Error(`post3d: horizon uniform ${name} 与体积雾内部名字冲突`);
        if(!slot||slot.value==null||(typeof slot.value==='number'&&!Number.isFinite(slot.value)))throw new Error(`post3d: volume.horizonUniforms.${name} 要有有效的 {value}`);
      }
    }
    const rtA = mkRT(W * res, H * res), rtB = mkRT(W * res, H * res);
    let m = null;
    // 材质在第一次 run 时建：要等阴影图建出来，才知道它是比较采样（PCF → sampler2DShadow，硬件 2×2 PCF）还是原始深度
    const build = (cmp) => mat(`${cmp ? '#define SHADOW_CMP\n' : ''}varying vec2 vUv; uniform sampler2D tZ;
#ifdef SHADOW_CMP
uniform sampler2DShadow tShadow;
#else
uniform sampler2D tShadow;
#endif
uniform mat4 shadowMatrix; uniform mat3 camRot; uniform vec3 camPos;
uniform float skyZ, pvShadowBias, pvSigma, pvMaxDist, pvSkyDist, pvAmbShadow;
uniform vec3 pvSunDir, pvSun, pvAmb, pvHeight, pvFar; uniform vec4 pvPhase, pvNear;
${hasHorizon ? o.horizonGLSL : 'uniform vec3 pvFarColor; vec3 horizonColor(vec3 d){ return pvFarColor; }'}
${IGN} ${RAY}
float shape(float y){ return pvHeight.z + (1. - pvHeight.z) * exp(-max(y - pvHeight.x, 0.) / pvHeight.y); }
float hg(float mu, float g){ float g2 = g * g; return (1. - g2) / (12.566371 * pow(max(1. + g2 - 2. * g * mu, 1e-4), 1.5)); }
float sunVis(vec3 p){
  vec4 sc = shadowMatrix * vec4(p, 1.); sc.xyz /= sc.w;
  if (sc.x < 0. || sc.x > 1. || sc.y < 0. || sc.y > 1. || sc.z < 0. || sc.z > 1.) return 1.;
#ifdef SHADOW_CMP
  return texture(tShadow, vec3(sc.xy, sc.z - pvShadowBias));
#else
  return step(sc.z - pvShadowBias, texture2D(tShadow, sc.xy).r);
#endif
}
void main(){
  float z = texture2D(tZ, vUv).r;
  vec3 vd = rayAt(vUv); float rl = length(vd);
  vec3 rd = normalize(camRot * vd);
  float dist = z * rl;
  bool sky = z >= skyZ;
  float maxD = sky ? pvSkyDist : min(dist, pvMaxDist);
  float mu = dot(rd, pvSunDir);
  float ph = min(hg(mu, pvPhase.x) * pvPhase.z + hg(mu, pvPhase.y) * (1. - pvPhase.z), pvPhase.w);
  float j = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.); float T = 1., tPrev = 0.;
  for (int i = 0; i < ${N}; i++) {
    float f = (float(i) + 1.) / float(${N});
    float t1 = maxD * f * (.35 + .65 * f);            // 近处步子密
    float ds = t1 - tPrev, tj = tPrev + ds * j;
    vec3 p = camPos + rd * tj;
    float sh = sunVis(p);
    float Ti = exp(-pvSigma * shape(p.y) * ds);
    float nearW = mix(pvNear.x, pvNear.y, smoothstep(pvNear.z, pvNear.w, tj));
    vec3 srcL = pvSun * (ph * sh * nearW) + pvAmb * (pvAmbShadow + (1. - pvAmbShadow) * sh);
    acc += T * srcL * (1. - Ti);                       // 每段按 (1−透射) 积分：能量守恒，不随步数整体变亮
    T *= Ti; tPrev = t1;
  }
  // 超出 maxDist 的几何：梯形近似光学厚度，散射色取这个方向的地平线色（与天空同源）
  if (!sky && dist > pvMaxDist) {
    float h1 = camPos.y + rd.y * pvMaxDist, h2 = camPos.y + rd.y * dist;
    float Tf = exp(-pvSigma * pvFar.x * (dist - pvMaxDist) * .5 * (shape(h1) + shape(h2)));
    acc += T * (horizonColor(rd) * pvFar.y + pvAmb * pvFar.z) * (1. - Tf);
    T *= Tf;
  }
  gl_FragColor = vec4(acc, T);
}`, Object.assign({
      tZ: { value: null }, tShadow: { value: null }, shadowMatrix: { value: new THREE.Matrix4() }, camRot: { value: new THREE.Matrix3() },
      camPos: { value: new THREE.Vector3() }, uRay: { value: new THREE.Vector4() }, skyZ: { value: 1e9 },
      pvShadowBias: { value: 0 }, pvSigma: { value: 0 }, pvMaxDist: { value: 1 }, pvSkyDist: { value: 1 }, pvAmbShadow: { value: 0 },
      pvSunDir: { value: new THREE.Vector3() }, pvSun: { value: new THREE.Vector3() }, pvAmb: { value: new THREE.Vector3() },
      pvHeight: { value: new THREE.Vector3() }, pvFar: { value: new THREE.Vector3() }, pvPhase: { value: new THREE.Vector4() },
      pvNear: { value: new THREE.Vector4() }, pvFarColor: { value: new THREE.Vector3() },
    }, hasHorizon ? (o.horizonUniforms ?? {}) : {}));   // 天空的 uniform 槽按引用并进来：天空那边每帧写的值这里同时生效
    const _a = new THREE.Vector3(), _b = new THREE.Vector3();
    vol = {
      res, hasHorizon, out: () => rtA.texture,
      run(p, z) {
        const sm = light.shadow && light.shadow.map;
        if (!renderer.shadowMap.enabled || !light.castShadow || !sm || !sm.depthTexture)
          throw new Error('post3d: volume 要读太阳阴影图：renderer.shadowMap.enabled（createStage3D shadows:true）、volume.light.castShadow = true，且这盏灯在场景里');
        if (!m) { m = build(sm.depthTexture.compareFunction != null); vol.mats.push(m); }
        const u = m.uniforms;
        u.tZ.value = z.texture; u.tShadow.value = sm.depthTexture; u.shadowMatrix.value.copy(light.shadow.matrix);
        u.camRot.value.setFromMatrix4(S.camera.matrixWorld); S.camera.getWorldPosition(u.camPos.value); rayCorners(u.uRay.value);
        u.skyZ.value = S.camera.far * 0.97;
        light.getWorldPosition(_a); light.target.getWorldPosition(_b); u.pvSunDir.value.copy(_a).sub(_b).normalize();
        u.pvShadowBias.value = p.shadowBias; u.pvSigma.value = p.sigma; u.pvMaxDist.value = p.maxDist; u.pvSkyDist.value = p.skyDistance;
        u.pvAmbShadow.value = p.ambientShadow; u.pvSun.value.fromArray(p.sun); u.pvAmb.value.fromArray(p.ambient);
        u.pvHeight.value.set(p.height[0], Math.max(1e-3, p.height[1]), p.height[2]); u.pvFar.value.fromArray(p.far);
        u.pvPhase.value.fromArray(p.phase); u.pvNear.value.set(p.near[0], p.near[1], p.near[2], Math.max(p.near[2] + 1e-3, p.near[3]));
        if (!this.hasHorizon) u.pvFarColor.value.fromArray(p.farColor);
        pass(m, rtA); blur2(rtA, rtB, z, p.tolerance);
      },
      rts: [rtA, rtB], mats: [],
    };
  }

  // HDR 合成：联合双边上采样（双线性权重 × 1/(0.015 + |Δz|/z)）→ AO 只压"环境光区域" → col·T + 散射
  const litM = rtLit ? mat(`${E.ao ? '#define AO\n' : ''}${E.volume ? '#define VOL\n' : ''}varying vec2 vUv;
uniform sampler2D tColor, tDepth, tAO, tZA, tVol, tZV; uniform vec2 resA, resV; uniform float near, far, exposure;
uniform float aoStrength; uniform vec3 aoLit, aoTint; ${VIEWZ} ${LUMA}
vec4 upsample(sampler2D tex, sampler2D tz, vec2 hres, float zc){
  vec2 hp = vUv * hres - .5, f = fract(hp), base = (floor(hp) + .5) / hres, tx = 1. / hres;
  vec4 acc = vec4(0.); float ws = 0.;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k - (k / 2) * 2), float(k / 2));
    vec2 uv = base + o * tx;
    float w = (o.x > .5 ? f.x : 1. - f.x) * (o.y > .5 ? f.y : 1. - f.y);
    w = max(w / (.015 + abs(texture2D(tz, uv).r - zc) / zc), 1e-5);
    acc += texture2D(tex, uv) * w; ws += w;
  }
  return acc / ws;
}
void main(){
  vec4 s = texture2D(tColor, vUv);
  vec3 col = max(s.rgb, vec3(0.));
  float d = texture2D(tDepth, vUv).r;
  float zc = viewDepth(d, near, far);
#ifdef AO
  if (d < 0.99999) {
    float occ = upsample(tAO, tZA, resA, zc).r;
    float lit = smoothstep(aoLit.x, aoLit.y, luma(col) * exposure);   // 被直射光照亮的像素 AO 退让：遮蔽属于环境光
    float a = mix(1., occ, aoStrength * (1. - aoLit.z * lit));
    col *= mix(vec3(a), vec3(1.), aoTint);
  }
#endif
#ifdef VOL
  vec4 v = upsample(tVol, tZV, resV, zc);
  col = col * v.a + v.rgb;
#endif
  gl_FragColor = vec4(col, s.a);
}`, { tColor: { value: rtScene.texture }, tDepth: { value: depthTex }, tAO: { value: null }, tZA: { value: null }, tVol: { value: null }, tZV: { value: null },
    resA: { value: new THREE.Vector2(1, 1) }, resV: { value: new THREE.Vector2(1, 1) }, near: { value: 0.1 }, far: { value: 100 }, exposure: { value: 1 },
    aoStrength: { value: 0 }, aoLit: { value: new THREE.Vector3() }, aoTint: { value: new THREE.Vector3() } }) : null;

  if (ao) zFor(ao.res);
  if (vol) zFor(vol.res);

  // ---------- bloom ----------
  let bloom = null;
  if (E.bloom) {
    const o = opt('bloom'), L = o.levels ?? 5, res = o.resolution ?? 0.5;
    if (!(Number.isInteger(L) && L >= 1 && L <= 12)) throw new Error('post3d: bloom.levels 要是 1–12 的整数');
    const down = [], up = [];
    for (let i = 0; i < L; i++) down.push(mkRT((W * res) / 2 ** i, (H * res) / 2 ** i));
    for (let i = 0; i < L - 1; i++) up.push(mkRT((W * res) / 2 ** i, (H * res) / 2 ** i));
    const pre = bloomMix ? mat(`varying vec2 vUv; uniform sampler2D tIn; uniform vec2 texel; uniform float karis, cap; ${LUMA}
vec3 tap(vec2 o){ return min(max(texture2D(tIn, vUv + texel * o).rgb, vec3(0.)), vec3(cap)); }
vec4 box(vec3 a, vec3 b, vec3 c, vec3 d){
  vec4 w = 1. / (1. + karis * vec4(luma(a), luma(b), luma(c), luma(d)));
  return vec4((a*w.x+b*w.y+c*w.z+d*w.w)/dot(w,vec4(1.)),1.);
}
void main(){
  vec3 a=tap(vec2(-2,2)), b=tap(vec2(0,2)), c=tap(vec2(2,2));
  vec3 d=tap(vec2(-2,0)), e=tap(vec2(0)), f=tap(vec2(2,0));
  vec3 g=tap(vec2(-2,-2)), h=tap(vec2(0,-2)), i=tap(vec2(2,-2));
  vec3 j=tap(vec2(-1,1)), k=tap(vec2(1,1)), l=tap(vec2(-1,-1)), m=tap(vec2(1,-1));
  vec3 o=box(j,k,l,m).rgb*.5+(box(a,b,d,e).rgb+box(b,c,e,f).rgb+box(d,e,g,h).rgb+box(e,f,h,i).rgb)*.125;
  gl_FragColor=vec4(o,1.);
}`, { tIn:{value:null}, texel:{value:new THREE.Vector2()}, karis:{value:opt('bloom').karis}, cap:{value:opt('bloom').clamp ?? 65504} }) : mat(`varying vec2 vUv; uniform sampler2D tIn; uniform vec2 texel; uniform float threshold, knee; ${LUMA}
void main(){
  // 4 个双线性 tap = 源的 4×4 盒子；阈值用软膝（knee）避免亮部边缘闪
  vec3 c = .25 * (texture2D(tIn, vUv + texel * vec2(-1,-1)).rgb + texture2D(tIn, vUv + texel * vec2(1,-1)).rgb
                + texture2D(tIn, vUv + texel * vec2(-1, 1)).rgb + texture2D(tIn, vUv + texel * vec2(1, 1)).rgb);
  float l = luma(c);
  float s = clamp(l - threshold + knee, 0., 2. * knee); s = s * s / (4. * knee + 1e-5);
  float w = max(s, l - threshold) / max(l, 1e-5);
  gl_FragColor = vec4(c * max(w, 0.), 1.);
}`, { tIn: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, knee: { value: 0.1 } });
    // Jimenez 2014（COD:AW）13 tap 下采样：中心 4 个 0.5 权重的盒子 + 四角 4 个 0.125 的盒子
    const dn = mat(`varying vec2 vUv; uniform sampler2D tIn; uniform vec2 texel;
void main(){
  vec2 t = texel;
  vec3 a = texture2D(tIn, vUv + t * vec2(-2, 2)).rgb, b = texture2D(tIn, vUv + t * vec2(0, 2)).rgb, c = texture2D(tIn, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture2D(tIn, vUv + t * vec2(-2, 0)).rgb, e = texture2D(tIn, vUv).rgb, f = texture2D(tIn, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture2D(tIn, vUv + t * vec2(-2,-2)).rgb, h = texture2D(tIn, vUv + t * vec2(0,-2)).rgb, i = texture2D(tIn, vUv + t * vec2(2,-2)).rgb;
  vec3 j = texture2D(tIn, vUv + t * vec2(-1, 1)).rgb, k = texture2D(tIn, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture2D(tIn, vUv + t * vec2(-1,-1)).rgb, m = texture2D(tIn, vUv + t * vec2(1,-1)).rgb;
  vec3 o = e * .125 + (a + c + g + i) * .03125 + (b + d + f + h) * .0625 + (j + k + l + m) * .125;
  gl_FragColor = vec4(o, 1.);
}`, { tIn: { value: null }, texel: { value: new THREE.Vector2() } });
    // 3×3 帐篷上采样，与本级混合：radius 越大，越远的级（越宽的光晕）占比越高
    const upM = mat(`varying vec2 vUv; uniform sampler2D tLow, tHigh; uniform vec2 texel; uniform float radius;
void main(){
  vec2 t = texel;
  vec3 s = texture2D(tLow, vUv).rgb * 4.
    + (texture2D(tLow, vUv + t * vec2(1,0)).rgb + texture2D(tLow, vUv + t * vec2(-1,0)).rgb + texture2D(tLow, vUv + t * vec2(0,1)).rgb + texture2D(tLow, vUv + t * vec2(0,-1)).rgb) * 2.
    + texture2D(tLow, vUv + t * vec2(1,1)).rgb + texture2D(tLow, vUv + t * vec2(-1,1)).rgb + texture2D(tLow, vUv + t * vec2(1,-1)).rgb + texture2D(tLow, vUv + t * vec2(-1,-1)).rgb;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, s / 16., radius), 1.);
}`, { tLow: { value: null }, tHigh: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 0.5 } });
    bloom = {
      out: () => (L > 1 ? up[0].texture : down[0].texture),
      mip: (i) => down[Math.min(L - 1, Math.max(0, i))],
      run(p) {
        pre.uniforms.tIn.value = src.texture; pre.uniforms.texel.value.set(1 / W, 1 / H);
        if (!bloomMix) { pre.uniforms.threshold.value = p.threshold; pre.uniforms.knee.value = Math.max(1e-4, p.knee); }
        pass(pre, down[0]);
        for (let i = 1; i < L; i++) { dn.uniforms.tIn.value = down[i - 1].texture; dn.uniforms.texel.value.set(1 / down[i - 1].width, 1 / down[i - 1].height); pass(dn, down[i]); }
        for (let i = L - 2; i >= 0; i--) {
          const low = i === L - 2 ? down[L - 1] : up[i + 1];
          upM.uniforms.tLow.value = low.texture; upM.uniforms.tHigh.value = down[i].texture;
          upM.uniforms.texel.value.set(1 / low.width, 1 / low.height); upM.uniforms.radius.value = p.radius;
          pass(upM, up[i]);
        }
      },
      rts: [...down, ...up], mats: [pre, dn, upM],
    };
  }

  // ---------- dof ----------
  let dof = null;
  if (E.dof) {
    const o = opt('dof'), res = o.resolution ?? 0.5, step = o.step ?? 0.5;
    const rt = mkRT(W * res, H * res);
    // Gustafsson 2018 "Bokeh depth of field in a single pass"：沿黄金角螺旋采样，半径随采样增长（步长 step/r），
    // 每个采样按它自己的 CoC 是否覆盖到中心来决定贡献——近处的大模糊能盖到焦内物体上，焦内物体不会糊到背景里。
    const m = mat(`varying vec2 vUv; uniform sampler2D tColor, tDepth; uniform vec2 px; uniform float focus, blur, maxBlur, near, far, step, cocScale;
${VIEWZ}
// CoC 换算到本 RT 的像素（cocScale = 分辨率倍率）：采样数 ≈ (maxBlur·res)² / (2·step)，降分辨率直接省平方
float coc(vec2 uv){ float z = viewDepth(texture2D(tDepth, uv).x, near, far); return cocScale * min(maxBlur, blur * abs(1. - focus / max(z, 1e-4))); }
void main(){
  float cz = viewDepth(texture2D(tDepth, vUv).x, near, far);
  float cc = coc(vUv);
  vec3 col = texture2D(tColor, vUv).rgb; float tot = 1.;
  float r = step;
  float mb = maxBlur * cocScale;
  for (float ang = 0.; ang < 4000.; ang += 2.39996323) {
    if (r >= mb) break;
    vec2 uv = vUv + vec2(cos(ang), sin(ang)) * px * r;
    vec3 sc = texture2D(tColor, uv).rgb;
    float sz = viewDepth(texture2D(tDepth, uv).x, near, far);
    float scc = cocScale * min(maxBlur, blur * abs(1. - focus / max(sz, 1e-4)));
    if (sz > cz) scc = clamp(scc, 0., cc * 2.);
    float m = smoothstep(r - .5, r + .5, scc);
    col += mix(col / tot, sc, m); tot += 1.;
    r += step / r;
  }
  gl_FragColor = vec4(col / tot, 1.);
}`, { tColor: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2() }, focus: { value: 1 }, blur: { value: 0 },
      maxBlur: { value: 1 }, near: { value: 0.1 }, far: { value: 100 }, step: { value: step }, cocScale: { value: res } });
    dof = {
      out: () => rt.texture,
      run(p) {
        const u = m.uniforms;
        u.tColor.value = src.texture; u.tDepth.value = depthTex;
        // CoC 参数以全分辨率像素给出，着色器里乘 cocScale 换到本 RT 的像素
        u.px.value.set(1 / rt.width, 1 / rt.height); u.focus.value = p.focus; u.blur.value = p.blur; u.maxBlur.value = Math.max(1, p.maxBlur);
        u.near.value = S.camera.near; u.far.value = S.camera.far;
        pass(m, rt);
      },
      rts: [rt], mats: [m],
    };
  }

  // ---------- godrays ----------
  let rays = null;
  if (E.godrays) {
    const o = opt('godrays'), N = o.samples ?? 48, res = o.resolution ?? 0.25;
    const rtA = mkRT(W * res, H * res), rtB = mkRT(W * res, H * res);
    const pre = mat(`varying vec2 vUv; uniform sampler2D tIn; uniform float threshold; ${LUMA}
void main(){ vec3 c = texture2D(tIn, vUv).rgb; gl_FragColor = vec4(c * step(threshold, luma(c)), 1.); }`,
    { tIn: { value: null }, threshold: { value: 1 } });
    // GPU Gems 3 ch.13：从像素向光源屏幕位置走 N 步，逐步衰减累加
    const m = mat(`varying vec2 vUv; uniform sampler2D tIn; uniform vec2 light; uniform float density, decay, weight, aspect;
void main(){
  vec2 d = (vUv - light) * density / float(${N});
  vec2 uv = vUv; float ill = 1.; vec3 acc = vec3(0.);
  for (int i = 0; i < ${N}; i++) { uv -= d; acc += texture2D(tIn, uv).rgb * ill * weight; ill *= decay; }
  gl_FragColor = vec4(acc, 1.);
}`, { tIn: { value: null }, light: { value: new THREE.Vector2() }, density: { value: 1 }, decay: { value: 0.95 }, weight: { value: 0.05 }, aspect: { value: 1 } });
    rays = {
      out: () => rtB.texture, fade: 1,
      run(p) {
        pre.uniforms.tIn.value = src.texture; pre.uniforms.threshold.value = p.threshold; pass(pre, rtA);
        this.fade = 1;   // 每帧重设：只在本帧内有意义，不带到下一帧
        let lu;
        if (p.lightUV) lu = p.lightUV;
        else {
          const q = S.project(p.light, { x: 0, y: 0, w: 1, h: 1 });
          lu = [q.x, 1 - q.y];
          this.fade = q.behind ? 0 : 1;   // 光源在相机后面时径向模糊方向是反的，不画
        }
        m.uniforms.tIn.value = rtA.texture; m.uniforms.light.value.set(lu[0], lu[1]);
        m.uniforms.density.value = p.density; m.uniforms.decay.value = p.decay; m.uniforms.weight.value = p.weight;
        pass(m, rtB);
      },
      rts: [rtA, rtB], mats: [pre, m],
    };
  }

  // ---------- 合成一遍 ----------
  const defs = Object.entries(E).filter(([, v]) => v).map(([k]) => `#define FX_${k.toUpperCase()}\n`).join('');
  const comp = mat(defs + `varying vec2 vUv;
uniform sampler2D tScene, tBloom, tDof, tRays, tDepth;
uniform vec2 res; uniform float uTime, uSeed;
uniform float bloomStrength, raysExposure;
uniform float dofFocus, dofBlur, dofMax, camNear, camFar;
uniform float chromaAmount;
uniform float grainAmount, grainFrame, grainSize;
uniform float vigAmount, vigRadius, vigSoft;
uniform float scanCount, scanAmount, scanPhase;
uniform float glAmount, glBucket, glSlices, glShift, glSplit;
${HASH} ${VIEWZ}
vec4 colorAt(vec2 uv){
  vec4 c = texture2D(tScene, uv);
#ifdef FX_DOF
  float z = viewDepth(texture2D(tDepth, uv).x, camNear, camFar);
  float cc = min(dofMax, dofBlur * abs(1. - dofFocus / max(z, 1e-4)));
  c.rgb = mix(c.rgb, texture2D(tDof, uv).rgb, smoothstep(.5, 1.5, cc));
#endif
#ifdef FX_BLOOM
  ${bloomMix ? 'c.rgb = mix(c.rgb, texture2D(tBloom, uv).rgb, clamp(bloomStrength, 0., 1.));' : 'c.rgb += texture2D(tBloom, uv).rgb * bloomStrength;'}
#endif
#ifdef FX_GODRAYS
  c.rgb += texture2D(tRays, uv).rgb * raysExposure;
#endif
  return c;
}
void main(){
  vec2 uv = vUv;
  vec2 split = vec2(0.);
#ifdef FX_GLITCH
  // 横向切片按 (切片号, 时间桶) 取哈希：被选中的切片整体错位、通道再拉开。时间桶 = floor(t·rate)，任意 t 直接求值
  float row = floor(uv.y * glSlices);
  float h = hash12(vec2(row, glBucket) + uSeed);
  float on = step(1. - glAmount, h);
  uv.x += on * (hash12(vec2(row * 1.7, glBucket + 3.1) + uSeed) - .5) * 2. * glShift;
  split = on * vec2(glSplit, 0.);
#endif
  vec4 c;
#ifdef FX_CHROMA
  vec2 dir = (uv - .5) * chromaAmount / res.y + split;
  c = colorAt(uv);
  c.r = colorAt(uv + dir).r; c.b = colorAt(uv - dir).b;
#else
  c = colorAt(uv);
  #ifdef FX_GLITCH
    c.r = colorAt(uv + split).r; c.b = colorAt(uv - split).b;
  #endif
#endif
  float a = c.a;
#ifdef FX_BLOOM
  a = max(a, clamp(dot(texture2D(tBloom, uv).rgb * bloomStrength, vec3(.333)), 0., 1.));
#endif
  gl_FragColor = vec4(c.rgb, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec3 o = gl_FragColor.rgb;
#ifdef FX_VIGNETTE
  vec2 q = (vUv - .5) * vec2(res.x / res.y, 1.) * 2.;
  o *= mix(1., smoothstep(vigRadius + vigSoft, vigRadius - vigSoft, length(q) / length(vec2(res.x / res.y, 1.))), vigAmount);
#endif
#ifdef FX_SCANLINES
  o *= 1. - scanAmount * (.5 + .5 * cos(6.28318530718 * (vUv.y * scanCount + scanPhase)));
#endif
#ifdef FX_GRAIN
  // 颗粒按帧号播种：同一个 t → 同一帧颗粒；运动模糊的子帧落在同一帧里，颗粒相同
  vec2 cell = floor(gl_FragCoord.xy / grainSize);
  o += (hash13(vec3(cell, grainFrame) + uSeed) - .5) * grainAmount;
#endif
  gl_FragColor = vec4(o * a, a);
}`, {
    tScene: { value: src.texture }, tBloom: { value: null }, tDof: { value: null }, tRays: { value: null }, tDepth: { value: depthTex },
    res: { value: new THREE.Vector2(W, H) }, uTime: { value: 0 }, uSeed: { value: cfg.seed ?? 0 },
    bloomStrength: { value: 0 }, raysExposure: { value: 0 },
    dofFocus: { value: 1 }, dofBlur: { value: 0 }, dofMax: { value: 1 }, camNear: { value: 0.1 }, camFar: { value: 100 },
    chromaAmount: { value: 0 }, grainAmount: { value: 0 }, grainFrame: { value: 0 }, grainSize: { value: 1 },
    vigAmount: { value: 0 }, vigRadius: { value: 0.7 }, vigSoft: { value: 0.3 },
    scanCount: { value: 0 }, scanAmount: { value: 0 }, scanPhase: { value: 0 },
    glAmount: { value: 0 }, glBucket: { value: 0 }, glSlices: { value: 1 }, glShift: { value: 0 }, glSplit: { value: 0 },
  }, { toneMapped: true, transparent: false });

  // 显式显示链单独编译；旧 comp 的 shader 和旧参数路径保留。
  if ((E.dirt || E.streak || E.flare) && !E.tonemap) throw new Error('post3d: dirt / streak / flare 要同时开 tonemap 显示链');
  const dirtTex = E.dirt ? (() => {
    const o=opt('dirt'), n=o.size ?? 128, count=o.count;
    if (!(Number.isInteger(n)&&n>=8&&n<=1024&&Number.isInteger(count)&&count>0&&count<=4096)) throw new Error('post3d: dirt.size 要是 8–1024 整数，count 必填（1–4096）');
    const rr=vec(o,'dirt','radius',2); if (!(rr[0]>0&&rr[1]>=rr[0])) throw new Error('post3d: dirt.radius 为归一化半径正区间');
    const rnd=seeded(o.seed??cfg.seed??0), dots=Array.from({length:count},()=>[rnd(),rnd(),rr[0]+rnd()*(rr[1]-rr[0]),rnd()]);
    const data=new Uint8Array(n*n*4);
    for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
      let v=0;for(const [cx,cy,r,a] of dots){const d=((x+.5)/n-cx)**2+((y+.5)/n-cy)**2;v+=a*Math.exp(-d/(r*r));}
      const at=(y*n+x)*4;data[at]=data[at+1]=data[at+2]=Math.round(255*Math.min(1,v));data[at+3]=255;
    }
    const t=new THREE.DataTexture(data,n,n);t.minFilter=t.magFilter=THREE.LinearFilter;t.needsUpdate=true;return t;
  })() : null;
  const streakN=E.streak?(opt('streak').samples??17):0;
  if(E.streak&&!(Number.isInteger(streakN)&&streakN>=3&&streakN<=65&&streakN%2===1))throw new Error('post3d: streak.samples 为 3–65 奇数');
  const ghostN=E.flare?opt('flare').ghosts:0;
  if(E.flare&&!(Number.isInteger(ghostN)&&ghostN>=0&&ghostN<=12))throw new Error('post3d: flare.ghosts 必填（0–12 整数）');
  const F=opt('finish');
  for(const k of Object.keys(F))if(!['fxaa','sharpen','grain','dither'].includes(k))throw new Error(`post3d: finish 不认识 ${k}`);
  const rtDisplay=E.finish?mkRT(W,H,{type:THREE.UnsignedByteType}):null;
  const display=E.tonemap?mat(`${defs}${bloomMix?'#define BLOOM_MIX\n':''}
varying vec2 vUv;
uniform sampler2D tScene,tBloom,tDof,tRays,tDepth,tDirt,tStreak;
uniform vec2 res, flareUV; uniform float exposure,tmMix,bloomStrength,raysExposure,chromaAmount;
uniform float dofFocus,dofBlur,dofMax,camNear,camFar;
uniform vec3 gradeShadow,gradeHighlight,gradeLift; uniform vec4 gradeShape;
uniform float dirtAmount,streakAmount,streakRadius; uniform vec3 dirtColor,streakColor;
uniform vec3 flareColor; uniform vec4 flareShape,flareGhost; uniform float flareAmount,flareFacing;
uniform float vigAmount,vigRadius,vigSoft,scanCount,scanAmount,scanPhase;
uniform float uSeed,glAmount,glBucket,glSlices,glShift,glSplit,grainAmount,grainFrame,grainSize;
${HASH} ${VIEWZ} ${LUMA}
${[...new Set(curves??[])].map(c=>TONEMAP[c]).join('\n')}
vec3 srgb(vec3 c){c=max(c,vec3(0.));return mix(1.055*pow(c,vec3(1./2.4))-.055,12.92*c,lessThanEqual(c,vec3(.0031308)));}
vec4 sceneAt(vec2 uv){
  vec4 c=texture2D(tScene,uv);
#ifdef FX_DOF
  float z=viewDepth(texture2D(tDepth,uv).r,camNear,camFar);
  float cc=min(dofMax,dofBlur*abs(1.-dofFocus/max(z,1e-4)));
  c.rgb=mix(c.rgb,texture2D(tDof,uv).rgb,smoothstep(.5,1.5,cc));
#endif
  return c;
}
void main(){
  vec2 uv=vUv,split=vec2(0.);
#ifdef FX_GLITCH
  float row=floor(uv.y*glSlices);float on=step(1.-glAmount,hash12(vec2(row,glBucket)+uSeed));
  uv.x+=on*(hash12(vec2(row*1.7,glBucket+3.1)+uSeed)-.5)*2.*glShift;split=on*vec2(glSplit,0.);
#endif
  vec4 c=sceneAt(uv);float a=c.a;
#ifdef FX_CHROMA
  vec2 dir=(uv-.5)*chromaAmount/res.y+split;c.r=sceneAt(uv+dir).r;c.b=sceneAt(uv-dir).b;
#else
  c.r=sceneAt(uv+split).r;c.b=sceneAt(uv-split).b;
#endif
#ifdef FX_BLOOM
  vec3 b=texture2D(tBloom,uv).rgb;
  #ifdef BLOOM_MIX
  c.rgb=mix(c.rgb,b,clamp(bloomStrength,0.,1.));
  #else
  c.rgb+=b*bloomStrength;
  #endif
  a=max(a,clamp(luma(b)*bloomStrength,0.,1.));
#endif
#ifdef FX_GODRAYS
  c.rgb+=texture2D(tRays,uv).rgb*raysExposure;
#endif
#ifdef FX_DIRT
  c.rgb+=texture2D(tBloom,uv).rgb*texture2D(tDirt,vUv).r*dirtColor*dirtAmount;
#endif
#ifdef FX_STREAK
  vec3 st=vec3(0.);float sw=0.;
  for(int i=0;i<${Math.max(1,streakN)};i++){
    float q=(float(i)-float(${Math.max(1,streakN)}-1)*.5)/max(float(${Math.max(1,streakN)}-1)*.5,1.);
    float w=exp(-q*q*4.5);st+=texture2D(tStreak,uv+vec2(q*streakRadius/res.x,0.)).rgb*w;sw+=w;
  }
  c.rgb+=st/max(sw,1e-5)*streakColor*streakAmount;
#endif
#ifdef FX_FLARE
  float vis=0.;
  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
    vec2 q=flareUV+vec2(float(i),float(j))*flareGhost.z/res;
    float inside=step(0.,q.x)*step(q.x,1.)*step(0.,q.y)*step(q.y,1.);
    vis+=inside*step(flareGhost.w,texture2D(tDepth,clamp(q,0.,1.)).r)/9.;
  }
  vis*=flareFacing;
  vec2 aspect=vec2(res.x/res.y,1.);float r=length((uv-flareUV)*aspect);
  float glare=exp(-r*r/max(flareShape.x*flareShape.x,1e-8));
  glare+=flareShape.z*exp(-pow((r-flareShape.y)/max(flareShape.w,1e-5),2.));
  for(int i=0;i<${Math.max(1,ghostN)};i++){
    ${ghostN?'':'if(i==0)break;'}
    vec2 center=flareUV+(.5-flareUV)*(float(i)+1.)*flareGhost.x;
    float d=length((uv-center)*aspect)/max(flareGhost.y,1e-5);
    glare+=pow(max(0.,1.-d*d),3.)/(float(i)+2.);
  }
  c.rgb+=flareColor*glare*flareAmount*vis;
#endif
  vec3 o=max(c.rgb,vec3(0.))*exposure;
  o=${curves?.length===2?`mix(${TM_FN[curves[0]]}(o),${TM_FN[curves[1]]}(o),clamp(tmMix,0.,1.))`:curves?`${TM_FN[curves[0]]}(o)`:'o'};
#ifdef FX_GRADE
  float l=luma(o),w=smoothstep(gradeShape.x,gradeShape.y,l);
  o*=mix(gradeShadow,gradeHighlight,w);
  o=mix(o,o*o*(3.-2.*o),gradeShape.z);
  o+=gradeLift*(1.-clamp(l,0.,1.));
  o=mix(vec3(luma(o)),o,gradeShape.w);
#endif
  o=srgb(clamp(o,0.,1.));
#ifdef FX_VIGNETTE
  vec2 q=(vUv-.5)*vec2(res.x/res.y,1.)*2.;o*=mix(1.,smoothstep(vigRadius+vigSoft,vigRadius-vigSoft,length(q)/length(vec2(res.x/res.y,1.))),vigAmount);
#endif
#ifdef FX_SCANLINES
  o*=1.-scanAmount*(.5+.5*cos(6.28318530718*(vUv.y*scanCount+scanPhase)));
#endif
#ifdef FX_GRAIN
  o+=(hash13(vec3(floor(gl_FragCoord.xy/grainSize),grainFrame)+uSeed)-.5)*grainAmount;
#endif
  gl_FragColor=${E.finish?'vec4(o,luma(o))':'vec4(o*a,a)'};
}`,{
    ...comp.uniforms,tDirt:{value:dirtTex},tStreak:{value:null},exposure:{value:1},tmMix:{value:0},tmAgxLook:{value:new THREE.Vector2(1,1)},
    gradeShadow:{value:new THREE.Vector3()},gradeHighlight:{value:new THREE.Vector3()},gradeLift:{value:new THREE.Vector3()},gradeShape:{value:new THREE.Vector4()},
    dirtAmount:{value:0},dirtColor:{value:new THREE.Vector3()},streakAmount:{value:0},streakRadius:{value:0},streakColor:{value:new THREE.Vector3()},
    flareUV:{value:new THREE.Vector2()},flareShape:{value:new THREE.Vector4()},flareGhost:{value:new THREE.Vector4()},flareAmount:{value:0},flareFacing:{value:0},flareColor:{value:new THREE.Vector3()},
  }):null;
  const finish=E.finish?mat(`varying vec2 vUv;uniform sampler2D tIn,tAlpha,tBloom;uniform vec2 px;
uniform float edgeThreshold,subpixel,sharpAmount,sharpEdge,grainAmount,grainFrame,grainSize,grainDark,ditherAmount,uSeed,bloomStrength;
${HASH} ${LUMA}
vec3 readAA(vec2 uv){
  vec4 c=texture2D(tIn,uv);
${F.fxaa?`float n=texture2D(tIn,uv+vec2(0.,px.y)).a,s=texture2D(tIn,uv-vec2(0.,px.y)).a,e=texture2D(tIn,uv+vec2(px.x,0.)).a,w=texture2D(tIn,uv-vec2(px.x,0.)).a;
  float lo=min(c.a,min(min(n,s),min(e,w))),hi=max(c.a,max(max(n,s),max(e,w)));
  if(hi-lo<edgeThreshold*max(hi,.05))return c.rgb;
  vec2 dir=vec2(-(n-s),e-w);dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+.05),-4.,4.)*px;
  vec3 q=.5*(texture2D(tIn,uv+dir/6.).rgb+texture2D(tIn,uv-dir/6.).rgb);
  vec3 r=q*.5+.25*(texture2D(tIn,uv+dir*.5).rgb+texture2D(tIn,uv-dir*.5).rgb);
  return mix(c.rgb,(luma(r)<lo||luma(r)>hi)?q:r,subpixel);`:'return c.rgb;'}
}
void main(){
  vec3 c=readAA(vUv);
${F.sharpen?`vec3 n=texture2D(tIn,vUv+vec2(0.,px.y)).rgb,s=texture2D(tIn,vUv-vec2(0.,px.y)).rgb,e=texture2D(tIn,vUv+vec2(px.x,0.)).rgb,w=texture2D(tIn,vUv-vec2(px.x,0.)).rgb;
  float edge=max(max(abs(luma(n)-luma(s)),abs(luma(e)-luma(w))),abs(luma(c)-luma((n+s+e+w)*.25)));
  c+=(c-(n+s+e+w)*.25)*sharpAmount*(1.-smoothstep(sharpEdge,sharpEdge*2.,edge));`:''}
${F.grain?`vec2 cell=floor(gl_FragCoord.xy/grainSize);float g=hash13(vec3(cell,grainFrame)+uSeed)-hash13(vec3(cell+71.31,grainFrame+19.3)+uSeed);c+=g*grainAmount*mix(grainDark,1.,sqrt(clamp(luma(c),0.,1.)));`:''}
${F.dither?`c+=(hash12(gl_FragCoord.xy+uSeed)-hash12(gl_FragCoord.yx+43.7+uSeed))*ditherAmount/255.;`:''}
  float a=texture2D(tAlpha,vUv).a;
${E.bloom?'a=max(a,clamp(luma(texture2D(tBloom,vUv).rgb)*bloomStrength,0.,1.));':''}
  gl_FragColor=vec4(clamp(c,0.,1.)*a,a);
}`,{tIn:{value:rtDisplay.texture},tAlpha:{value:src.texture},tBloom:{value:null},px:{value:new THREE.Vector2(1/W,1/H)},
    edgeThreshold:{value:0},subpixel:{value:0},sharpAmount:{value:0},sharpEdge:{value:0},grainAmount:{value:0},grainFrame:{value:0},grainSize:{value:1},grainDark:{value:0},ditherAmount:{value:0},uSeed:{value:cfg.seed??0},bloomStrength:{value:0}}):null;

  // 低分辨率 HDR 读回只给离线扫片使用；每次读的是当前帧，求值不依赖历史。
  const measureRT=mkRT(32,18,{type:THREE.FloatType});
  const measureM=mat(`varying vec2 vUv;uniform sampler2D tIn;${LUMA}void main(){gl_FragColor=vec4(log(max(luma(texture2D(tIn,vUv).rgb),1e-6)),0.,0.,1.);}`,{tIn:{value:rtScene.texture}});
  function measure(){
    const old=renderer.getRenderTarget();pass(measureM,measureRT);const data=new Float32Array(32*18*4);
    renderer.readRenderTargetPixels(measureRT,0,0,32,18,data);renderer.setRenderTarget(old);
    let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i];return sum/(32*18);
  }

  const output = cfg.output ?? null;

  /** 每帧调（stage3d 的 render 会替你调）。params 全量，见文件头 */
  function render(t, P) {
    if (!P) throw new Error('post3d: render(t, params) 每帧要传全量参数');
    const u = comp.uniforms;
    // 场景
    if (!Number.isFinite(P.exposure) || P.exposure < 0) throw new Error('post3d: exposure 必填且≥0');
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(S.scene, S.camera);
    if (!Number.isFinite(P.exposure)) throw new Error('post3d: exposure 必填（色调映射前的曝光倍数，1 = 不变）');
    renderer.toneMappingExposure = P.exposure;
    if (rtLit) {
      for (const [r, z] of zRTs) { zMat.uniforms.near.value=S.camera.near; zMat.uniforms.far.value=S.camera.far; zMat.uniforms.scale.value=1/r; pass(zMat,z); }
      if (ao) {
        const p=need(P.ao,'ao',['radius','intensity','strength','fade','tolerance','lit','tint']);
        vec(p,'ao','fade',2); vec(p,'ao','lit',3); vec(p,'ao','tint',3);
        if (!(p.radius>0 && p.intensity>=0 && p.strength>=0 && p.tolerance>0 && p.lit[1]>p.lit[0])) throw new Error('post3d: ao 要求 radius/tolerance>0、intensity/strength≥0、lit[1]>lit[0]');
        ao.run(p,zFor(ao.res)); const l=litM.uniforms;
        l.tAO.value=ao.out(); l.tZA.value=zFor(ao.res).texture; l.resA.value.set(zFor(ao.res).width,zFor(ao.res).height);
        l.aoStrength.value=p.strength; l.aoLit.value.fromArray(p.lit); l.aoTint.value.fromArray(p.tint);
      }
      if (vol) {
        const p=need(P.volume,'volume',['shadowBias','sigma','maxDist','skyDistance','ambientShadow','sun','ambient','height','far','phase','near','tolerance',...(vol.hasHorizon?[]:['farColor'])]);
        for(const [k,n] of [['sun',3],['ambient',3],['height',3],['far',3],['phase',4],['near',4],...(vol.hasHorizon?[]:[['farColor',3]])]) vec(p,'volume',k,n);
        if (!(p.sigma>=0 && p.maxDist>0 && p.skyDistance>0 && p.height[1]>0 && p.tolerance>0 && Math.abs(p.phase[0])<1 && Math.abs(p.phase[1])<1 && p.phase[2]>=0 && p.phase[2]<=1 && p.phase[3]>0 && p.height[2]>=0 && p.height[2]<=1 && p.far[0]>=0)) throw new Error('post3d: volume 密度/远景消光≥0、距离/标高/容差/phaseCap>0、HG 的 |g|<1、混合权重/底层比例在 0–1');
        vol.run(p,zFor(vol.res)); const l=litM.uniforms;
        l.tVol.value=vol.out(); l.tZV.value=zFor(vol.res).texture; l.resV.value.set(zFor(vol.res).width,zFor(vol.res).height);
      }
      litM.uniforms.near.value=S.camera.near;litM.uniforms.far.value=S.camera.far;litM.uniforms.exposure.value=P.exposure;
      litActive=!!((ao && P.ao.strength>0 && P.ao.intensity>0) || (vol && P.volume.sigma>0));
      if(litActive)pass(litM,rtLit);
    }
    u.tScene.value=src.texture;
    if(finish)finish.uniforms.tAlpha.value=src.texture;
    // 强度为 0 的那一帧跳过整条子链（不是缓存：合成里它的权重恰好是 0，读到的旧纹理乘 0，输出与"跑了一遍"逐位相同）
    if (bloom) { const p = need(P.bloom, 'bloom', bloomMix ? ['strength','radius'] : ['threshold', 'knee', 'strength', 'radius']); if (p.strength > 0 || E.dirt || E.streak) bloom.run(p); u.tBloom.value = bloom.out(); u.bloomStrength.value = Math.max(0, p.strength); }
    if (dof) {
      const p = need(P.dof, 'dof', ['focus', 'blur', 'maxBlur']); if (p.blur > 0) dof.run(p);
      u.tDof.value = dof.out(); u.dofFocus.value = p.focus; u.dofBlur.value = Math.max(0, p.blur); u.dofMax.value = Math.max(1, p.maxBlur);
      u.camNear.value = S.camera.near; u.camFar.value = S.camera.far;
    }
    if (rays) {
      const p = need(P.godrays, 'godrays', ['threshold', 'density', 'decay', 'weight', 'exposure']);
      if (!p.light && !p.lightUV) throw new Error('post3d: godrays.light（世界坐标）或 godrays.lightUV（屏幕 0–1）必填');
      if (p.exposure > 0) rays.run(p); else rays.fade = 0;
      u.tRays.value = rays.out(); u.raysExposure.value = Math.max(0, p.exposure) * rays.fade;
    }
    if (E.chroma) u.chromaAmount.value = need(P.chroma, 'chroma', ['amount']).amount;
    if (E.grain) {
      const p = need(P.grain, 'grain', ['amount', 'fps']);
      u.grainAmount.value = p.amount; u.grainSize.value = p.size ?? 1;
      u.grainFrame.value = Math.floor(t * p.fps + 1e-6) % 4096;   // 颗粒的刷新率是风格（24 / 12 / 每帧），所以必填
    }
    if (E.vignette) { const p = need(P.vignette, 'vignette', ['amount', 'radius', 'softness']); u.vigAmount.value = p.amount; u.vigRadius.value = p.radius; u.vigSoft.value = Math.max(1e-3, p.softness); }
    if (E.scanlines) { const p = need(P.scanlines, 'scanlines', ['count', 'amount']); u.scanCount.value = p.count; u.scanAmount.value = p.amount; u.scanPhase.value = p.phase ?? 0; }
    if (E.glitch) {
      const p = need(P.glitch, 'glitch', ['amount', 'rate', 'slices', 'shift']);
      u.glAmount.value = p.amount; u.glBucket.value = Math.floor(t * p.rate + 1e-6) % 4096; u.glSlices.value = p.slices;
      u.glShift.value = p.shift; u.glSplit.value = p.split ?? 0;
    }
    u.uTime.value = t;
    if (!display) { pass(comp, output); return; }
    const d=display.uniforms; d.exposure.value=P.exposure;
    const tm=need(P.tonemap,'tonemap',curves.length===2?['mix']:[]);d.tmMix.value=tm.mix??0;
    if(curves.includes('agx')){vec(tm,'tonemap','agxLook',2);d.tmAgxLook.value.fromArray(tm.agxLook);}
    if(E.grade){
      const p=need(P.grade,'grade',['shadow','highlight','lift','range','contrast','saturation']);
      vec(p,'grade','shadow',3);vec(p,'grade','highlight',3);vec(p,'grade','lift',3);vec(p,'grade','range',2);
      if(!(p.range[1]>p.range[0]))throw new Error('post3d: grade.range 递增');
      d.gradeShadow.value.fromArray(p.shadow);d.gradeHighlight.value.fromArray(p.highlight);d.gradeLift.value.fromArray(p.lift);
      d.gradeShape.value.set(...p.range,p.contrast,p.saturation);
    }
    if(E.dirt){const p=need(P.dirt,'dirt',['amount','color']);vec(p,'dirt','color',3);d.dirtAmount.value=p.amount;d.dirtColor.value.fromArray(p.color);}
    if(E.streak){const p=need(P.streak,'streak',['amount','radius','color']);vec(p,'streak','color',3);d.streakAmount.value=p.amount;d.streakRadius.value=p.radius;d.streakColor.value.fromArray(p.color);d.tStreak.value=bloom.mip(opt('streak').level??2).texture;}
    if(E.flare){
      const p=need(P.flare,'flare',['amount','color','radius','haloRadius','haloStrength','haloWidth','spacing','ghostRadius','visibilityRadius','depthCutoff']);vec(p,'flare','color',3);
      let uv=p.lightUV,facing=1;
      if(!uv){if(!p.light)throw new Error('post3d: flare.light（世界坐标）或 flare.lightUV 必填');const q=S.project(p.light,{x:0,y:0,w:1,h:1});uv=[q.x,1-q.y];facing=q.behind?0:1;}
      vec({uv},'flare','uv',2);d.flareUV.value.fromArray(uv);d.flareFacing.value=facing;
      d.flareShape.value.set(p.radius,p.haloRadius,p.haloStrength,p.haloWidth);d.flareGhost.value.set(p.spacing,p.ghostRadius,p.visibilityRadius,p.depthCutoff);
      d.flareAmount.value=p.amount;d.flareColor.value.fromArray(p.color);
    }
    pass(display,rtDisplay??output);
    if(finish){
      const p=need(P.finish,'finish',[]),f=finish.uniforms;
      if(F.fxaa){const v=need(p.fxaa,'finish.fxaa',['edgeThreshold','subpixel']);f.edgeThreshold.value=v.edgeThreshold;f.subpixel.value=v.subpixel;}
      if(F.sharpen){const v=need(p.sharpen,'finish.sharpen',['amount','edgeThreshold']);if(!(v.edgeThreshold>0))throw new Error('post3d: finish.sharpen.edgeThreshold>0');f.sharpAmount.value=v.amount;f.sharpEdge.value=v.edgeThreshold;}
      if(F.grain){const v=need(p.grain,'finish.grain',['amount','fps','size','darkWeight']);if(!(v.fps>0&&v.size>0))throw new Error('post3d: finish.grain fps/size>0');f.grainAmount.value=v.amount;f.grainFrame.value=Math.floor(t*v.fps+1e-6)%4096;f.grainSize.value=v.size;f.grainDark.value=v.darkWeight;}
      if(F.dither){f.ditherAmount.value=need(p.dither,'finish.dither',['amount']).amount;}
      if(bloom){f.tBloom.value=bloom.out();f.bloomStrength.value=P.bloom.strength;}
      pass(finish,output);
    }

  }

  const post = {
    render, measure, effects: { ...E }, rtScene,
    dispose() { for (const r of zRTs.values()) r.dispose(); for (const x of [zMat,blurM,litM,display,finish,measureM]) x?.dispose(); for(const r of [rtLit,rtDisplay,measureRT]) r?.dispose(); dirtTex?.dispose(); quadGeo.dispose(); for (const x of [bloom, dof, rays, ao, vol]) if (x) { x.rts.forEach((r) => r.dispose()); x.mats.forEach((m) => m.dispose()); } comp.dispose(); rtScene.dispose(); },
  };
  S._attachPost(post);
  return post;
}
