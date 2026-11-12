// sky3d.js —— 统一光照预设 + 程序化天空/云 + 由天空生成环境反射 + 解析高度雾 + PCSS 软阴影 + 前景层。按帧契约求值。
//
// 一条主线：**天、雾、反射、环境光同源**。片子传一份纯数据的光照预设，createLightRig 由它派生
// 平行光、天空着色器 uniform、雾色、环境光色，并导出一段 GLSL（SKY_GLSL：horizonColor() 等）给别的 pass 拼接。
// 远处的雾取"视线所在方位的地平线色"，金属球反射的是同一片天（PMREM 由同一个天空着色器拍出），色相从根上统一。
//
// **没有任何默认颜色**：预设缺一个色值就抛错并点名。形状类数字（幂次、过渡高度）有默认，文档里写明含义。
//
// 依赖：同目录 three-film.module.js、film-core 的 rand.js（噪声纹理用固定种子生成）。
// 契约：seek 里只改 uniform / 节点上的标量（stage3d 的复位会把它们还原到 freeze 时的值）；
// 云的运动 = 风速 × t（JS 里用 double 算偏移再交给 float32）；噪声是加载期按种子生成的纹理；PMREM 在加载期拍。
//
// 用法见 film-webfx references/sky.md。

import * as THREE from './three-film.module.js';
import { seeded } from './rand.js';
export { THREE };

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function color(v, name) {
  if (v == null) throw new Error(`sky3d: ${name} 必填（颜色由本片 style_guide 定，没有默认值）`);
  if (v.isColor) return v.clone();
  if (typeof v === 'string') return new THREE.Color(v);   // '#rrggbb' 按 sRGB 解释，转成线性
  if (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && x >= 0)) return new THREE.Color(v[0], v[1], v[2]);   // 线性，可 > 1（HDR）
  throw new Error(`sky3d: ${name} 要是线性 [r,g,b]（≥0，可 >1）、'#rrggbb' 或 THREE.Color，收到 ${JSON.stringify(v)}`);
}
function num(v, name, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(v)) throw new Error(`sky3d: ${name} 必填且是有限数（收到 ${v}）`);
  if (v < min || v > max) throw new Error(`sky3d: ${name} 要在 [${min}, ${max}]，收到 ${v}`);
  return v;
}
const opt = (v, d) => (v === undefined ? d : v);

// 同一材质可以叠几个补丁（雾 + PCSS + 前景）；保留材质原有的 onBeforeCompile
const PATCHES = new WeakMap();
function addPatch(mat, key, fn) {
  if (!mat || !mat.isMaterial) throw new Error(`sky3d: ${key} 要一个 three 材质`);
  let list = PATCHES.get(mat);
  if (!list) {
    list = [];
    PATCHES.set(mat, list);
    const prev = mat.onBeforeCompile, hadPrev = prev !== THREE.Material.prototype.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey, hadKey = prevKey !== THREE.Material.prototype.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, renderer) { if (hadPrev) prev.call(this, shader, renderer); for (const p of list) p.fn(shader, renderer); };
    mat.customProgramCacheKey = function () { return (hadKey ? prevKey.call(this) : '') + '|sky3d:' + list.map((p) => p.key).join(','); };
  }
  const kind = key.split(':')[0];
  if (list.some((p) => p.key.split(':')[0] === kind)) throw new Error(`sky3d: 材质「${mat.name || mat.type}」已经打过 ${kind} 补丁`);
  list.push({ key, fn });
  mat.needsUpdate = true;
}
function inject(src, anchor, text, where, who) {
  if (!src.includes(anchor)) throw new Error(`sky3d(${who}): 着色器里找不到 ${anchor}（这种材质不支持，或升级 three 后 chunk 变了）`);
  return src.replace(anchor, where === 'before' ? `${text}\n${anchor}` : `${anchor}\n${text}`);
}

// ---------------------------------------------------------------------------
// GLSL：天空模型（别的 pass #include 式拼接）。名字与 uniform 约定写死，见 sky.md §1
// ---------------------------------------------------------------------------
export const SKY_GLSL = /* glsl */`
#ifndef SKY_GLSL_INCLUDED
#define SKY_GLSL_INCLUDED
uniform vec3 uSkySunDir;        // 指向太阳的世界单位向量
uniform vec3 uSkySunColor;      // 太阳颜色（线性，未乘强度）
uniform float uSkySunIntensity; // 平行光强度（与 DirectionalLight.intensity 同值）
uniform vec3 uSkyZenith;        // 天顶
uniform vec3 uSkyHorizonSun;    // 向阳地平线
uniform vec3 uSkyHorizonAway;   // 背阳地平线
uniform vec3 uSkyGround;        // 地平线以下
uniform vec3 uSkyFog;           // 雾 / 环境光色
uniform vec3 uSkyShape;         // x 方位幂次, y 天顶过渡高度(sin 仰角), z 地面过渡高度(sin 俯角)
// 0 = 背阳 … 1 = 向阳（只看水平方位）
float skyToSun(vec3 d){
  vec2 s = uSkySunDir.xz; float ls = length(s), ld = length(d.xz);
  if (ls < 1e-5 || ld < 1e-5) return 0.5;
  return clamp(dot(d.xz / ld, s / ls) * 0.5 + 0.5, 0.0, 1.0);
}
// 视线 d（单位向量）所在方位的地平线色，线性 HDR
vec3 horizonColor(vec3 d){ return mix(uSkyHorizonAway, uSkyHorizonSun, pow(skyToSun(d), uSkyShape.x)); }
// 晴空渐变（不含日晕、太阳、云）：地平线 → 天顶；d.y < 0 → 地面色
vec3 skyGradient(vec3 d){
  vec3 hc = horizonColor(d);
  if (d.y < 0.0) return mix(hc, uSkyGround, smoothstep(0.0, 1.0, clamp(-d.y / max(uSkyShape.z, 1e-4), 0.0, 1.0)));
  float ts = skyToSun(d);
  float k = 1.0 - exp(-d.y / max(uSkyShape.y * (1.0 + ts * ts * ts), 1e-4));   // 向阳侧地平线色带更高
  return mix(hc, uSkyZenith, k);
}
#endif
`;

// 解析高度雾（需要先拼 SKY_GLSL）。密度 σ(y) = σ0·exp(−(y − y0)/H)
export const HEIGHT_FOG_GLSL = /* glsl */`
#ifndef SKY_FOG_GLSL_INCLUDED
#define SKY_FOG_GLSL_INCLUDED
uniform vec4 uFogMedium;   // x σ0（1/米，在基准高度）, y 基准高度 y0（米）, z 标高 H（米）, w 雾量上限（0–1）
uniform vec2 uFogSun;      // x 向阳前向散射强度（× 太阳色 × 强度）, y 瓣的幂次
// 两点之间的光学厚度（闭式积分，端点高度写法，俯视远处也不溢出）
float heightFogDepth(vec3 ro, vec3 p){
  float H = max(uFogMedium.z, 1e-3), L = length(p - ro);
  float a0 = clamp(-(ro.y - uFogMedium.y) / H, -60.0, 30.0), a1 = clamp(-(p.y - uFogMedium.y) / H, -60.0, 30.0);
  float dy = p.y - ro.y;
  if (abs(dy) < 1e-3 * H) return uFogMedium.x * L * exp(0.5 * (a0 + a1));
  return uFogMedium.x * L * H * (exp(a0) - exp(a1)) / dy;
}
// 雾的散射色：该视线方位的地平线色 + 向阳瓣
vec3 heightFogColor(vec3 rd){ return horizonColor(rd) + uSkySunColor * uSkySunIntensity * uFogSun.x * pow(max(dot(rd, uSkySunDir), 0.0), uFogSun.y); }
vec3 applyHeightFog(vec3 col, vec3 ro, vec3 p){
  vec3 v = p - ro; float L = length(v);
  if (L < 1e-6) return col;
  vec3 rd = v / L;
  float a = min(1.0 - exp(-heightFogDepth(ro, p)), uFogMedium.w);
  return mix(col, heightFogColor(rd), a);
}
#endif
`;

export const SKY_UNIFORMS = ['uSkySunDir', 'uSkySunColor', 'uSkySunIntensity', 'uSkyZenith', 'uSkyHorizonSun', 'uSkyHorizonAway', 'uSkyGround', 'uSkyFog', 'uSkyShape'];
export const FOG_UNIFORMS = ['uFogMedium', 'uFogSun'];

// ---------------------------------------------------------------------------
// 1. 光照预设
// ---------------------------------------------------------------------------
/**
 * @param {object} p  纯数据预设（所有颜色必填）：
 *   sun: { dir:[x,y,z] | elevation(度)+azimuth(度，0=-Z 北，90=+X 东), color, intensity }
 *   sky: { zenith, horizonSun, horizonAway, ground, fog, azimuthPower?=4, zenithHeight?=0.25, groundHeight?=0.2 }
 */
export function createLightRig(p) {
  if (!p || !p.sun || !p.sky) throw new Error('sky3d.createLightRig: 预设要有 sun 和 sky 两段（颜色全部由片子传入）');
  const s = p.sun, k = p.sky;
  let dir;
  if (s.dir) {
    if (!Array.isArray(s.dir) || s.dir.length !== 3 || !s.dir.every(Number.isFinite)) throw new Error('sky3d: sun.dir 要是 [x,y,z]');
    dir = new THREE.Vector3(...s.dir);
    if (dir.lengthSq() < 1e-12) throw new Error('sky3d: sun.dir 不能是零向量');
    dir.normalize();
  } else {
    const el = num(s.elevation, 'sun.elevation（度）', { min: -90, max: 90 }) * DEG, az = num(s.azimuth, 'sun.azimuth（度）') * DEG;
    dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  }
  const rig = {
    sunDir: dir,
    sunColor: color(s.color, 'sun.color'),
    sunIntensity: num(s.intensity, 'sun.intensity', { min: 0 }),
    zenith: color(k.zenith, 'sky.zenith'),
    horizonSun: color(k.horizonSun, 'sky.horizonSun'),
    horizonAway: color(k.horizonAway, 'sky.horizonAway'),
    ground: color(k.ground, 'sky.ground'),
    fogColor: color(k.fog, 'sky.fog'),
    shape: new THREE.Vector3(num(opt(k.azimuthPower, 4), 'sky.azimuthPower', { min: 0.01 }),
      num(opt(k.zenithHeight, 0.25), 'sky.zenithHeight', { min: 1e-3 }), num(opt(k.groundHeight, 0.2), 'sky.groundHeight', { min: 1e-3 })),
  };
  rig.ambientColor = rig.fogColor;   // 环境光色 = 雾色（同源）

  /** 往一张 uniform 表（{name:{value}}）里填 SKY_GLSL 的全部 uniform；没有的槽会新建。返回同一张表 */
  rig.fill = (u) => {
    const put = (n, v) => { if (u[n]) { if (u[n].value && u[n].value.copy && v.isVector3 !== undefined || (u[n].value && u[n].value.copy && v.isColor)) u[n].value.copy(v); else u[n].value = typeof v === 'number' ? v : v.clone(); } else u[n] = { value: typeof v === 'number' ? v : v.clone() }; };
    put('uSkySunDir', rig.sunDir); put('uSkySunColor', rig.sunColor); put('uSkySunIntensity', rig.sunIntensity);
    put('uSkyZenith', rig.zenith); put('uSkyHorizonSun', rig.horizonSun); put('uSkyHorizonAway', rig.horizonAway);
    put('uSkyGround', rig.ground); put('uSkyFog', rig.fogColor); put('uSkyShape', rig.shape);
    return u;
  };
  rig.uniforms = () => rig.fill({});

  /** 平行光：颜色与强度取自预设，方向 = 太阳方向。返回的灯要和 light.target 一起加进场景 */
  rig.createSun = ({ castShadow = false, mapSize = 2048, bias = 0, normalBias = 0 } = {}) => {
    const L = new THREE.DirectionalLight(rig.sunColor.clone(), rig.sunIntensity);
    L.position.copy(rig.sunDir); L.target.position.set(0, 0, 0);
    L.castShadow = castShadow;
    L.shadow.mapSize.set(mapSize, mapSize); L.shadow.bias = bias; L.shadow.normalBias = normalBias;
    return L;
  };

  /** 阴影相机按包围盒拟合：灯沿太阳方向退到盒子外，正交视锥恰好罩住盒子（+margin 米）。返回 {width,height,depth}（米） */
  rig.fitShadow = (light, box, { margin = 0 } = {}) => {
    if (!box || !box.isBox3 || box.isEmpty()) throw new Error('sky3d.fitShadow: 要一个非空 THREE.Box3（受影和投影物体的世界包围盒）');
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 + margin;
    light.position.copy(c).addScaledVector(rig.sunDir, r * 2 + 1);
    light.target.position.copy(c);
    const cam = light.shadow.camera;
    const m = new THREE.Matrix4().lookAt(light.position, c, cam.up).setPosition(light.position).invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(m);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); z0 = Math.min(z0, -v.z); z1 = Math.max(z1, -v.z);
    }
    cam.left = x0 - margin; cam.right = x1 + margin; cam.bottom = y0 - margin; cam.top = y1 + margin;
    cam.near = Math.max(0.01, z0 - margin); cam.far = z1 + margin;
    cam.updateProjectionMatrix();
    return { width: cam.right - cam.left, height: cam.top - cam.bottom, depth: cam.far - cam.near };
  };

  /** 半球环境光（天 = 雾色，地 = 地面色），强度由片子定。有 PMREM 环境时它会和环境反射叠加，按需取舍 */
  rig.createAmbient = (intensity) => new THREE.HemisphereLight(rig.fogColor.clone(), rig.ground.clone(), num(intensity, 'createAmbient(intensity)', { min: 0 }));
  return rig;
}

// ---------------------------------------------------------------------------
// 2. 程序化天空与云
// ---------------------------------------------------------------------------
const SKY_VERT = /* glsl */`
varying vec3 vSkyDir;
void main(){
  vSkyDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;   // 深度钉在远平面：只取相机旋转，任何几何都挡在它前面
}`;

const SKY_FRAG = /* glsl */`
varying vec3 vSkyDir;
uniform vec4 uHaloPow, uHaloW;   // 日晕：pow(max(dot(d,sun),0), 幂次) × 权重 × 太阳色，最多四组
uniform vec3 uDisk;              // x cos(外沿半角), y cos(内沿半角), z 强度（× 太阳色）
uniform float uEnvClamp;
${SKY_GLSL}
#ifdef SKY_CLOUDS
uniform sampler2D uSkyNoise;
uniform vec2 uCloudOff;          // 风 × t / 特征尺度（噪声单位）
uniform vec4 uCloudProj;         // x 云高/特征尺度, y 地平线抬升, zw 各向异性
uniform vec4 uCloudShape;        // x 覆盖阈值, y 软边, z 域扭曲, w 脊状细节
uniform vec3 uCloudBase, uCloudDark;
uniform vec4 uCloudLit;          // x 侧光增益, y 亮边增益, z 大气透视系数, w 自阴影对比
uniform vec4 uCloudHole;         // x cos(外), y cos(内), z 强度
uniform vec4 uCloudGap;          // x sin(背阳云底仰角), y sin(向阳云底仰角), z 撕碎幅度, w 启用
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return texture2D(uSkyNoise, (i + f + 0.5) / 256.0).r; }
float fbmN(vec2 p){ float a = 0.5, s = 0.0, n = 0.0; for (int i = 0; i < SKY_OCT; i++){ s += a * n2(p); n += a; p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / n; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.875; }
#endif
void main(){
  vec3 d = normalize(vSkyDir);
  float h = max(d.y, 0.0), mu = dot(d, uSkySunDir), s = max(mu, 0.0), ts = skyToSun(d);
  vec3 hc = horizonColor(d);
  vec3 clear = skyGradient(d);
  vec3 col = clear + uSkySunColor * dot(pow(vec4(s), uHaloPow), uHaloW);
  float veil = 1.0;
#ifdef SKY_CLOUDS
  if (d.y > 0.0) {
    vec2 q = d.xz / (h + uCloudProj.y) * uCloudProj.x * uCloudProj.zw + uCloudOff;
    float warp = fbm3(q * 0.45 + 7.1);
    vec2 qq = q + (warp - 0.5) * uCloudShape.z;
    float dens = fbmN(qq);
    float ridg = 1.0 - abs(2.0 * fbm3(qq * 3.1 + 5.0) - 1.0);
    dens = dens * (1.0 - 0.875 * uCloudShape.w) + (ridg - 0.6) * uCloudShape.w * smoothstep(0.03, 0.25, h);   // 近地平线淡出防走样
    float body = dens * 0.74 + n2(q * 0.19 + 3.7) * 0.36;
    float cov = smoothstep(uCloudShape.x, uCloudShape.x + uCloudShape.y, body);
    float edge = mix(uCloudGap.x, uCloudGap.y, pow(ts, 1.7));
    float rag = (n2(q * 0.9 + 11.0) - 0.5) * 0.16 + (dens - 0.5) * 0.10;
    cov *= mix(1.0, smoothstep(edge - 0.035, edge + 0.11, h + rag * uCloudGap.z * (0.35 + ts)), uCloudGap.w);
    float hole = uCloudHole.z * smoothstep(uCloudHole.x, uCloudHole.y, mu + (dens - 0.5) * 0.012);
    cov *= 1.0 - hole;
    // 自阴影近似：朝太阳方向的密度差（步数 = SKY_SHADOW_STEPS）
    vec2 sd = length(uSkySunDir.xz) > 1e-5 ? normalize(uSkySunDir.xz) : vec2(0.0);
    float densS = 0.0;
    for (int k = 1; k <= SKY_SHADOW_STEPS; k++) densS += fbmN(qq + sd * (0.22 * float(k) / float(SKY_SHADOW_STEPS)));
    densS /= float(SKY_SHADOW_STEPS);
    float relief = clamp((dens - densS) * uCloudLit.w + 0.5, 0.0, 1.0);
    float thick = smoothstep(uCloudShape.x + 0.09, uCloudShape.x + 0.41, body);
    vec3 cool = mix(uCloudBase, uCloudDark, thick) * (0.55 + 0.9 * relief * relief);
    cool += clear * 0.5 * pow(1.0 - thick, 3.0);                                   // 薄处透天光
    float nearSun = pow(ts, 5.0) * exp(-max(h - edge * uCloudGap.w, 0.0) * 4.5) * 0.9 + pow(s, 7.0) * 0.9;
    vec3 warm = uSkyHorizonSun * nearSun * (0.05 + 2.2 * relief * relief * relief) * uCloudLit.x;   // 侧光
    warm += uSkySunColor * cov * (1.0 - cov) * 4.0 * pow(ts, 4.0) * (0.5 + 1.6 * pow(s, 6.0)) * (1.0 - hole) * uCloudLit.y;   // 亮边
    vec3 cloudC = cool + warm;
    cloudC = mix(cloudC, hc * 0.55 + cloudC * 0.45, exp(-h * uCloudLit.z));      // 大气透视
    col = mix(col, cloudC, cov * 0.985);
    veil = 1.0 - cov * 0.92;
  }
#endif
#ifndef SKY_ENV
  col += uSkySunColor * smoothstep(uDisk.x, uDisk.y, mu) * uDisk.z * veil;
#else
  col = min(col, vec3(uEnvClamp));   // 环境捕获：不画日盘（平行光就是太阳），钳上限防萤火虫
#endif
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function noiseTexture(seed) {
  const r = seeded(seed), N = 256, data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) { data[i * 4] = Math.floor(r() * 256); data[i * 4 + 1] = Math.floor(r() * 256); data[i * 4 + 2] = Math.floor(r() * 256); data[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

/**
 * @param S    createStage3D 的返回（天空网格会加进 S.scene，必须在 S.freeze() 之前调）
 * @param rig  createLightRig 的返回
 * @param o    { halo:[[幂次,权重]…1–4 组], disk:{angle 视直径(度), intensity}, clouds:false|{…} }（halo、disk 必填）
 */
export function createSky(S, rig, o = {}) {
  if (!S || !S.scene) throw new Error('sky3d.createSky: 第一个参数是 createStage3D 的返回');
  if (!rig || !rig.fill) throw new Error('sky3d.createSky: 第二个参数是 createLightRig 的返回');
  if (!Array.isArray(o.halo) || o.halo.length < 1 || o.halo.length > 4) throw new Error('sky3d.createSky: halo 必填，1–4 组 [幂次, 权重]（日晕由宽到窄叠加；权重 0 = 不要这一层）');
  const hp = [1, 1, 1, 1], hw = [0, 0, 0, 0];
  o.halo.forEach(([pw, w], i) => { hp[i] = num(pw, `halo[${i}][0] 幂次`, { min: 0.01 }); hw[i] = num(w, `halo[${i}][1] 权重`, { min: 0 }); });
  if (!o.disk) throw new Error('sky3d.createSky: disk 必填 { angle: 视直径（度，真实太阳≈0.53）, intensity: 亮度倍数（× 太阳色） }');
  const da = num(o.disk.angle, 'disk.angle（度）', { min: 0.01, max: 20 }) * DEG / 2;
  const disk = new THREE.Vector3(Math.cos(da), Math.cos(da * 0.7), num(o.disk.intensity, 'disk.intensity', { min: 0 }));

  const c = o.clouds || null;
  let cloud = null;
  if (c) {
    const altitude = num(c.altitude, 'clouds.altitude（米）', { min: 1 }), feature = num(c.featureSize, 'clouds.featureSize（米）', { min: 1 });
    if (!Array.isArray(c.wind) || c.wind.length !== 2 || !c.wind.every(Number.isFinite)) throw new Error('sky3d: clouds.wind 必填 [vx, vz]（米/秒，世界 x、z 方向）');
    const aniso = opt(c.aniso, [1, 1]);
    const hole = c.hole ? { r: num(c.hole.radius, 'clouds.hole.radius（度）', { min: 0 }), f: num(opt(c.hole.feather, c.hole.radius * 0.5), 'clouds.hole.feather（度）', { min: 0 }), k: num(opt(c.hole.strength, 1), 'clouds.hole.strength', { min: 0, max: 1 }) } : null;
    const gap = c.gap ? { a: num(c.gap.away, 'clouds.gap.away（度）', { min: -10, max: 90 }), s: num(c.gap.sun, 'clouds.gap.sun（度）', { min: -10, max: 90 }), r: num(opt(c.gap.ragged, 1), 'clouds.gap.ragged', { min: 0 }) } : null;
    cloud = {
      wind: c.wind, feature,
      octaves: Math.round(num(opt(c.octaves, 5), 'clouds.octaves', { min: 1, max: 9 })),
      steps: Math.round(num(opt(c.shadowSteps, 1), 'clouds.shadowSteps', { min: 1, max: 8 })),
      seed: opt(c.seed, 1),
      proj: new THREE.Vector4(altitude / feature, num(opt(c.horizonLift, 0.1), 'clouds.horizonLift', { min: 1e-3 }), aniso[0], aniso[1]),
      shape: new THREE.Vector4(THREE.MathUtils.lerp(0.82, 0.28, num(c.coverage, 'clouds.coverage（0–1）', { min: 0, max: 1 })),
        num(c.softness, 'clouds.softness', { min: 1e-3 }), num(opt(c.warp, 1.3), 'clouds.warp', { min: 0 }), num(opt(c.detail, 0.16), 'clouds.detail', { min: 0, max: 1 })),
      base: color(c.base, 'clouds.base（背光的云色）'), dark: color(c.dark, 'clouds.dark（厚云芯）'),
      lit: new THREE.Vector4(num(c.light, 'clouds.light（侧光增益）', { min: 0 }), num(c.rim, 'clouds.rim（亮边增益）', { min: 0 }),
        num(opt(c.aerial, 11), 'clouds.aerial', { min: 0 }), num(opt(c.relief, 4.5), 'clouds.relief', { min: 0 })),
      hole: hole ? new THREE.Vector4(Math.cos((hole.r + hole.f) * DEG), Math.cos(hole.r * DEG), hole.k, 0) : new THREE.Vector4(0, 1, 0, 0),
      gap: gap ? new THREE.Vector4(Math.sin(gap.a * DEG), Math.sin(gap.s * DEG), gap.r, 1) : new THREE.Vector4(0, 0, 0, 0),
    };
  }
  const noise = cloud ? noiseTexture(cloud.seed) : null;
  const offAt = (t) => (cloud ? new THREE.Vector2((cloud.wind[0] * t) / cloud.feature, (cloud.wind[1] * t) / cloud.feature) : new THREE.Vector2());

  function makeMaterial(env) {
    const u = rig.fill({
      uHaloPow: { value: new THREE.Vector4(...hp) }, uHaloW: { value: new THREE.Vector4(...hw) },
      uDisk: { value: disk.clone() }, uEnvClamp: { value: 1e9 },
    });
    const defines = {};
    if (cloud) {
      Object.assign(u, {
        uSkyNoise: { value: noise }, uCloudOff: { value: new THREE.Vector2() }, uCloudProj: { value: cloud.proj.clone() },
        uCloudShape: { value: cloud.shape.clone() }, uCloudBase: { value: cloud.base.clone() }, uCloudDark: { value: cloud.dark.clone() },
        uCloudLit: { value: cloud.lit.clone() }, uCloudHole: { value: cloud.hole.clone() }, uCloudGap: { value: cloud.gap.clone() },
      });
      Object.assign(defines, { SKY_CLOUDS: '', SKY_OCT: cloud.octaves, SKY_SHADOW_STEPS: cloud.steps });
    }
    if (env) defines.SKY_ENV = '';
    return new THREE.ShaderMaterial({
      name: env ? 'sky3d.envSky' : 'sky3d.sky', vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: u, defines,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: true,
    });
  }
  const geo = new THREE.BoxGeometry(2, 2, 2);
  const material = makeMaterial(false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sky3d.sky'; mesh.frustumCulled = false;
  mesh.renderOrder = 1e6;   // 不透明队列最后画：被物体挡住的像素靠深度测试跳过昂贵的云
  S.scene.add(mesh);

  /** paint 里每帧调：云偏移 = 风 × t。partial 可临时改 coverage（复位会还原，不写就回到加载时的值） */
  function update(t, partial = {}) {
    if (!Number.isFinite(t)) throw new Error(`sky3d: update(t) 收到非法 t=${t}`);
    if (!cloud) return;
    material.uniforms.uCloudOff.value.copy(offAt(t));
    if (partial.coverage !== undefined) material.uniforms.uCloudShape.value.x = THREE.MathUtils.lerp(0.82, 0.28, num(partial.coverage, 'coverage', { min: 0, max: 1 }));
  }

  /**
   * 3. 由这片天生成环境反射（PMREM）。加载期调（S.freeze() 之前）。
   *   at       拍哪一刻的云（秒）
   *   clamp    天空亮度上限（线性），防萤火虫；日盘始终不拍（太阳由平行光负责，避免双重高光）
   *   intensity  scene.environmentIntensity
   *   size     PMREM 立方面边长（默认 256）
   *   apply    false = 只返回纹理，不写 S.scene（按镜头预拍多张时用）
   */
  function environment({ at = 0, clamp, intensity, size = 256, apply = true } = {}) {
    num(clamp, 'environment({clamp}) 天空亮度上限', { min: 0 });
    if (apply) num(intensity, 'environment({intensity}) 即 scene.environmentIntensity', { min: 0 });
    const em = makeMaterial(true);
    em.uniforms.uEnvClamp.value = clamp;
    if (cloud) em.uniforms.uCloudOff.value.copy(offAt(at));
    const es = new THREE.Scene();
    const m = new THREE.Mesh(geo, em); m.frustumCulled = false; es.add(m);
    const gen = new THREE.PMREMGenerator(S.renderer);
    const rt = gen.fromScene(es, 0, 0.1, 10, { size });
    gen.dispose(); em.dispose();
    if (apply) { S.scene.environment = rt.texture; S.scene.environmentIntensity = intensity; }
    return { texture: rt.texture, renderTarget: rt };
  }

  return { mesh, material, update, environment, offsetAt: offAt, noise };
}

// ---------------------------------------------------------------------------
// 4. 解析高度雾：注入标准材质（onBeforeCompile），也导出 GLSL 给后期用
// ---------------------------------------------------------------------------
/**
 * @param rig  createLightRig 的返回
 * @param p    { density 1/米, baseHeight 米, scaleHeight 米, maxOpacity 0–1, sunStrength, sunPower }（全部必填）
 * 返回 { node, apply(material), fill(uniforms) }。node 要加进场景（freeze 之前）：雾参数是它身上的标量，
 * 由 stage3d 的复位管着；paint 里写 fog.node.density = … 就是动画，不写就回到加载时的值。
 */
export function createHeightFog(rig, p = {}) {
  const node = new THREE.Object3D();
  node.name = 'sky3d.fog';
  for (const [k, lim] of [['density', { min: 0 }], ['baseHeight', {}], ['scaleHeight', { min: 1e-3 }], ['maxOpacity', { min: 0, max: 1 }], ['sunStrength', { min: 0 }], ['sunPower', { min: 0.01 }]])
    node[k] = num(p[k], `createHeightFog.${k}`, lim);
  const medium = new THREE.Vector4(), sun = new THREE.Vector2();
  const live = {
    uFogMedium: { get value() { return medium.set(node.density, node.baseHeight, node.scaleHeight, node.maxOpacity); } },
    uFogSun: { get value() { return sun.set(node.sunStrength, node.sunPower); } },
  };
  const rigU = rig.uniforms();
  function apply(mat) {
    addPatch(mat, 'fog', (shader) => {
      Object.assign(shader.uniforms, rigU, live);
      shader.vertexShader = inject(shader.vertexShader, '#include <common>', 'varying vec3 vSkyFogWorld;', 'after', 'fog');
      shader.vertexShader = inject(shader.vertexShader, '#include <fog_vertex>', `{
  vec4 skyWp = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
  skyWp = batchingMatrix * skyWp;
  #endif
  #ifdef USE_INSTANCING
  skyWp = instanceMatrix * skyWp;
  #endif
  vSkyFogWorld = (modelMatrix * skyWp).xyz;
}`, 'after', 'fog');
      shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `varying vec3 vSkyFogWorld;\n${SKY_GLSL}\n${HEIGHT_FOG_GLSL}`, 'after', 'fog');
      // 在色调映射之前、线性 HDR 里融色（three 自带雾在 tonemapping 之后，HDR 地平线色会被算错）
      shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', 'outgoingLight = applyHeightFog(outgoingLight, cameraPosition, vSkyFogWorld);', 'before', 'fog');
    });
    return mat;
  }
  /** 给自写的后期着色器：把当前雾参数与天空 uniform 写进它的 uniform 表（动画时每帧调） */
  function fill(u) {
    rig.fill(u);
    const put = (n, v) => { if (u[n] && u[n].value && u[n].value.copy) u[n].value.copy(v); else u[n] = { value: v.clone() }; };
    put('uFogMedium', live.uFogMedium.value); put('uFogSun', live.uFogSun.value);
    return u;
  }
  return { node, apply, fill };
}

// ---------------------------------------------------------------------------
// 5. 接触硬化软阴影（PCSS）：替换 three 的基础阴影采样（BasicShadowMap 才能读到原始深度）
// ---------------------------------------------------------------------------
const PCSS_START = '\t#else\n\t\tfloat getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {';
const PCSS_END = '\t#endif\n\t#if NUM_SUN_LIGHT_SHADOWS > 0';
function pcssChunk(samples, blockers) {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  const a = src.indexOf(PCSS_START), b = src.indexOf(PCSS_END, a);
  if (a < 0 || b < 0 || src.indexOf(PCSS_START, a + 1) >= 0) throw new Error('sky3d.enablePCSS: three 的 shadowmap_pars_fragment 和预期文本对不上（升级了 three？），PCSS 补丁不能静默套用');
  const body = `\t#else
\t\tuniform vec3 uPcssFrustum;   // 阴影相机 宽、高、深（米）
\t\tuniform vec4 uPcssParams;    // x 半影/遮挡距离（=2tan(太阳半角)）, y 搜索半径(米), z 最小半影(米), w 最大半影(米)
\t\tuniform float uPcssSlope;    // 接收面深度梯度上限（每 texel）
\t\tfloat pcssIGN(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
\t\tvec2 pcssVogel(int i, int n, float phi){ float r = sqrt((float(i) + 0.5) / float(n)); float th = float(i) * 2.399963229728653 + phi; return vec2(cos(th), sin(th)) * r; }
\t\tfloat getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
\t\t\tfloat shadow = 1.0;
\t\t\tshadowCoord.xyz /= shadowCoord.w;
\t\t\tshadowCoord.z += shadowBias;
\t\t\t// 接收面深度偏移（receiver plane depth bias）：在分支前取导数
\t\t\tvec3 dx = dFdx(shadowCoord.xyz), dy = dFdy(shadowCoord.xyz);
\t\t\tfloat det = dx.x * dy.y - dx.y * dy.x;
\t\t\tvec2 texel = 1.0 / shadowMapSize;
\t\t\tvec2 dz = abs(det) > 1e-14 ? vec2(dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z) / det : vec2(0.0);
\t\t\tdz = clamp(dz, -uPcssSlope / texel, uPcssSlope / texel);
\t\t\tbool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
\t\t\tif ( inFrustum && shadowCoord.z <= 1.0 ) {
\t\t\t\tvec2 m2uv = 1.0 / uPcssFrustum.xy;
\t\t\t\tfloat phi = pcssIGN(gl_FragCoord.xy) * PI2;
\t\t\t\tfloat zr = shadowCoord.z, sum = 0.0, nb = 0.0;
\t\t\t\tfor (int i = 0; i < ${blockers}; i++) {
\t\t\t\t\tvec2 o = pcssVogel(i, ${blockers}, phi) * uPcssParams.y * m2uv;
\t\t\t\t\tfloat d = texture2D(shadowMap, shadowCoord.xy + o).r;
\t\t\t\t\tif (d < zr + dot(dz, o)) { sum += d; nb += 1.0; }
\t\t\t\t}
\t\t\t\tif (nb > 0.0) {
\t\t\t\t\tfloat dist = max(zr - sum / nb, 0.0) * uPcssFrustum.z;                       // 遮挡物到接收面（米）
\t\t\t\t\tfloat pen = clamp(dist * uPcssParams.x, uPcssParams.z, uPcssParams.w);     // 半影宽（米）
\t\t\t\t\tvec2 rad = max(0.5 * pen * m2uv, 1.25 * texel);
\t\t\t\t\tfloat lit = 0.0;
\t\t\t\t\tfor (int i = 0; i < ${samples}; i++) {
\t\t\t\t\t\tvec2 o = pcssVogel(i, ${samples}, phi + 1.7) * rad;
\t\t\t\t\t\tlit += step(zr + dot(dz, o), texture2D(shadowMap, shadowCoord.xy + o).r);
\t\t\t\t\t}
\t\t\t\t\tshadow = lit / float(${samples});
\t\t\t\t}
\t\t\t\tvec2 e = min(shadowCoord.xy, 1.0 - shadowCoord.xy);
\t\t\t\tshadow = mix(1.0, shadow, smoothstep(0.0, 0.02, min(e.x, e.y)));   // 视锥边缘渐变为受光
\t\t\t}
\t\t\treturn mix( 1.0, shadow, shadowIntensity );
\t\t}
`;
  return src.slice(0, a) + body + src.slice(b);
}

/**
 * @param S          createStage3D 的返回（要 shadows:true, shadowType: THREE.BasicShadowMap）
 * @param light      投影的 DirectionalLight（先 rig.fitShadow；材质里只认这一盏的视锥尺寸）
 * @param materials  受影材质数组
 * @param o          { sunAngle 视直径(度), maxRadius 米, samples, blockerSamples, slope?=0.003, minPenumbra? 米 }
 */
export function enablePCSS(S, light, materials, o = {}) {
  if (S.renderer.shadowMap.type !== THREE.BasicShadowMap) throw new Error('sky3d.enablePCSS: 要 createStage3D({ shadows:true, shadowType: THREE.BasicShadowMap })。'
    + 'three r186 的 PCF 阴影图是比较采样器（sampler2DShadow），读不到遮挡物深度，做不了遮挡物搜索；基础阴影图是原始深度');
  if (!light || !light.isDirectionalLight || !light.castShadow) throw new Error('sky3d.enablePCSS: light 要是 castShadow 的 DirectionalLight');
  const ang = num(o.sunAngle, 'enablePCSS.sunAngle（太阳视直径，度；真实≈0.53，放大 = 更软）', { min: 0 }) * DEG;
  const R = num(o.maxRadius, 'enablePCSS.maxRadius（米，遮挡物搜索半径与半影上限的一半）', { min: 1e-4 });
  const ns = Math.round(num(o.samples, 'enablePCSS.samples', { min: 1, max: 128 })), nb = Math.round(num(o.blockerSamples, 'enablePCSS.blockerSamples', { min: 1, max: 64 }));
  const fr = new THREE.Vector3();
  const U = {
    uPcssFrustum: { get value() { const c = light.shadow.camera; return fr.set((c.right - c.left) / c.zoom, (c.top - c.bottom) / c.zoom, c.far - c.near); } },
    uPcssParams: { value: new THREE.Vector4(2 * Math.tan(ang / 2), R, num(opt(o.minPenumbra, 0), 'enablePCSS.minPenumbra（米）', { min: 0 }), 2 * R) },
    uPcssSlope: { value: num(opt(o.slope, 0.003), 'enablePCSS.slope', { min: 0 }) },
  };
  const chunk = pcssChunk(ns, nb);
  for (const m of materials) addPatch(m, `pcss:${ns}:${nb}`, (shader) => {
    Object.assign(shader.uniforms, U);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <shadowmap_pars_fragment>', '', 'after', 'pcss').replace('#include <shadowmap_pars_fragment>', chunk);
  });
  return { uniforms: U };
}

// ---------------------------------------------------------------------------
// 6. 前景层：深度压进 [0, range]，永远在最前、仍写深度
// ---------------------------------------------------------------------------
/**
 * 对 obj 子树里每个网格的材质打补丁：顶点着色器把 NDC 深度线性压到 [0, range]（等价 gl.depthRange(0, range)）。
 * 材质要专用（共享材质的别的物体也会被压到前面）。阴影图走深度材质，不受影响。
 */
export function pinForeground(obj, { range = 0.05 } = {}) {
  num(range, 'pinForeground.range', { min: 1e-4, max: 1 });
  const seen = new Set();
  obj.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (seen.has(m)) continue;
      seen.add(m);
      addPatch(m, `fg:${range}`, (shader) => {
        shader.vertexShader = inject(shader.vertexShader, '#include <project_vertex>',
          `gl_Position.z = ${range.toFixed(6)} * (gl_Position.z + gl_Position.w) - gl_Position.w;`, 'after', 'pinForeground');
      });
    }
  });
  return { range, materials: [...seen] };
}
