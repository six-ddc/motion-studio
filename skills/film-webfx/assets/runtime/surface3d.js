// surface3d.js —— 让 three 的标准材质不那么"塑料、干净、假"：可组合的表面注入 + 加载期顶点色风化。
//
// 依赖：同目录 three-film.module.js（three 的帧契约版）、film-core 的 rand.js（种子随机）。零 npm 依赖。
// 做法、参数含义、代价和材料配方菜单见 film-webfx/references/surfaces.md。
//
//   import { applySurface, weatherGeometry, subdivideGeometry, SURFACE_GLSL } from './runtime/surface3d.js';
//   const surf = applySurface(mat, { antiFlicker: {...}, macro: {...}, grime: {...}, wet: {...}, triplanar: {...} });
//   mesh.geometry = weatherGeometry(geo, { seed: 3, transform: mesh.matrixWorld, mottle: [...], hemi: {...}, contact: {...}, crease: null, rust: null });
//   S.freeze();
//   paint(t) { surf.set({ wet: { level: t / D } }); }      // 每帧把随 t 变的参数写满
//
// 约定（另一处注入、烘焙要复用时照这里来，见 surfaces.md「注入约定」）：
//   - GLSL 函数前缀 sf_，uniform 前缀 uSf，varying 前缀 vSf，define 前缀 SF_，main 里的局部/全局变量前缀 sf。
//   - uniform 对象同时挂在 material.uniforms 上：stage3d 的复位会把它们恢复到 S.freeze() 时的值，
//     所以 applySurface 必须在 freeze 之前调；这一帧没 set 的参数回到静止值，不会沿用上一帧。
//   - 结构（开了哪些特性、空间、AO 来源、可选子特性是否为 null）编进 customProgramCacheKey；数值都是 uniform，可以每帧变。
//
// 不做的事：不选颜色、不给参数默认值（缺参数抛错点名）、不读时钟、不在 seek 里生成任何东西。

import * as THREE from './three-film.module.js';
import { hash01 } from './rand.js';

// ───────────────────────── 噪声片段（GLSL ES 3.00：需要 WebGL2；webfx 的着色器层用 GLSL.header2）─────────────────────────
// 整数哈希（pcg3d，Jarzynski & Olano 2020）：只有整数运算，不依赖 sin/fract 的实现精度。
const G_HASH = `
uvec3 sf_pcg3(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 sf_hash33(vec3 p){ return vec3(sf_pcg3(uvec3(ivec3(floor(p))))) * (1.0 / 4294967296.0); }
float sf_hash13(vec3 p){ return sf_hash33(p).x; }
`;
// 3D 值噪声，输出 [0,1]，均值约 0.5。每次调用 8 次哈希。
const G_VNOISE = `
float sf_vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(sf_hash13(i), sf_hash13(i + vec3(1,0,0)), u.x), mix(sf_hash13(i + vec3(0,1,0)), sf_hash13(i + vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(sf_hash13(i + vec3(0,0,1)), sf_hash13(i + vec3(1,0,1)), u.x), mix(sf_hash13(i + vec3(0,1,1)), sf_hash13(i + vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z);
}
`;
// fbm：倍频 ×2、振幅 ×0.5，按振幅和归一，输出 [0,1]。oct ≤ 8。
const G_FBM = `
float sf_fbm3(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * sf_vnoise3(p); n += a; p = p * 2.0 + vec3(17.1, 31.7, 7.3); a *= 0.5; }
  return s / n;
}
`;
// 可平铺 2D 梯度噪声：格点先对 per 取模再哈希，p ∈ [0,per) 的一片在边界上无缝；五次插值。输出约 [−0.7,0.7]，均值 0。
// sf_fbmT：每层周期 ×2（保持可平铺），输出 clamp(0.5 + v/Σa, 0, 1)，均值 0.5、标准差约 0.18。
const G_GRADT = `
vec2 sf_grad2(vec2 c, float seed){ float a = 6.28318530718 * sf_hash13(vec3(c, seed)); return vec2(cos(a), sin(a)); }
float sf_gnoiseT(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  float a = dot(sf_grad2(i0, seed), f), b = dot(sf_grad2(vec2(i1.x, i0.y), seed), f - vec2(1,0));
  float c = dot(sf_grad2(vec2(i0.x, i1.y), seed), f - vec2(0,1)), d = dot(sf_grad2(i1, seed), f - vec2(1,1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float sf_fbmT(vec2 p, vec2 per, int oct, float seed){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * sf_gnoiseT(p, per, seed + float(i) * 7.0); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }
  return clamp(0.5 + s / n, 0.0, 1.0);
}
`;
// 可平铺 Worley（3×3 邻域）：返回 vec4(F1, F2, 最近格随机值, 最近格第二随机值)。距离以格为单位。
const G_WORLEYT = `
vec4 sf_worleyT(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y));
    vec3 h = sf_hash33(vec3(mod(i + o, per), seed));
    float d = length(o + h.xy - f);
    if (d < d1){ d2 = d1; d1 = d; id = h.yz; } else if (d < d2){ d2 = d; }
  }
  return vec4(d1, d2, id);
}
`;

/** 噪声片段。拼接顺序：hash 在最前；vnoise 需要 hash；fbm 需要 vnoise；gradT、worleyT 需要 hash。全部 GLSL ES 3.00。 */
export const SURFACE_GLSL = Object.freeze({ hash: G_HASH, vnoise: G_VNOISE, fbm: G_FBM, gradT: G_GRADT, worleyT: G_WORLEYT,
  /** 全部（按依赖顺序） */ all: G_HASH + G_VNOISE + G_FBM + G_GRADT + G_WORLEYT });

// ───────────────────────── 参数表 ─────────────────────────
// 叶子：['uniform名', 分量] 数值参数；{ enum:[...] } 结构参数（进程序键）；{ sub:{...}, define } 可为 null 的子特性。
const POS = (p) => ['finite', p];
const SPEC = {
  antiFlicker: {
    define: 'SF_AA',
    fields: {
      toksvig: ['uSfAA', 0, '≥0'],         // 法线变短量 → 粗糙度² 增量的系数
      minRoughness: ['uSfAA', 1, '0..1'],   // 粗糙度下限
      maxSpecular: { nullable: true, define: 'SF_SPECMAX', leaf: ['uSfAA', 2, '>0'] },   // 直接高光上限（线性辐亮度）；null = 不钳
    },
  },
  macro: {
    define: 'SF_MACRO',
    fields: {
      space: { enum: ['world', 'object'] },
      freq: ['uSfMacro', 0, '>0'],          // 每米多少个噪声格
      albedo: ['uSfMacro', 1, '≥0'],        // 反照率相对变化幅度
      roughness: ['uSfMacro', 2, 'finite'], // 粗糙度绝对变化幅度
    },
  },
  grime: {
    define: 'SF_GRIME',
    fields: {
      space: { enum: ['world', 'object'] },
      ao: { enum: ['aoMap', 'vertexColor', 'none'] },
      freq: ['uSfGrime2', 0, '>0'],
      amount: ['uSfGrime', 0, '0..1'],
      ramp: [['uSfGrime', 1], ['uSfGrime', 2], 'ramp'],   // [lo, hi]：遮罩 smoothstep 的两端
      aoWeight: ['uSfGrime', 3, '≥0'],
      darken: ['uSfGrime2', 1, '0..1'],
      roughen: ['uSfGrime2', 2, 'finite'],
    },
  },
  wet: {
    define: 'SF_WET',
    fields: {
      level: ['uSfWet', 0, '0..1'],         // 全局湿度（每帧可由 t 驱动）
      darken: ['uSfWet', 1, '0..1'],        // 湿透时反照率压暗量（多孔大、封闭小）
      roughnessMul: ['uSfWet', 2, '≥0'],    // 湿透时粗糙度倍率
      vertical: ['uSfWet', 3, '≥0'],        // 竖面湿量（相对朝上面）
      saturate: ['uSfWet2', 0, '≥0'],       // 每单位变暗带来的饱和度增益
      flatten: ['uSfWet2', 1, '0..1'],      // 朝上湿面法线贴图压平比例
      streakFreq: [['uSfWet2', 2], ['uSfWet2', 3], 'pos2'],  // [水平, 竖直] 每米
      patch: { sub: { freq: ['uSfWetP', 0, '>0'], amount: ['uSfWetP', 1, '0..1'] } },
      splash: { nullable: true, define: 'SF_SPLASH',
        sub: { groundY: ['uSfSplash', 0, 'finite'], height: ['uSfSplash', 1, '>0'], amount: ['uSfSplash', 2, '≥0'], darken: ['uSfSplash', 3, '0..1'] } },
      beads: { nullable: true, define: 'SF_BEADS',
        sub: { amount: ['uSfBead', 0, '≥0'], size: ['uSfBead', 1, '>0'], fadePx: ['uSfBead', 2, '>0'], roughness: ['uSfBead', 3, '0..1'] } },
    },
  },
  triplanar: {
    define: 'SF_TRI',
    fields: {
      scale: ['uSfTri', 0, '>0'],           // 每（物体空间）米重复几次贴图
      sharpness: ['uSfTri', 1, '≥1'],       // 三向权重 |n|^k 的 k
    },
  },
};
const UNIFORM_DIM = { uSfAA: 3, uSfMacro: 3, uSfGrime: 4, uSfGrime2: 3, uSfWet: 4, uSfWet2: 4, uSfWetP: 2, uSfSplash: 4, uSfBead: 4, uSfTri: 2 };
const FEATURE_UNIFORMS = {
  antiFlicker: ['uSfAA'], macro: ['uSfMacro'], grime: ['uSfGrime', 'uSfGrime2'],
  wet: ['uSfWet', 'uSfWet2', 'uSfWetP', 'uSfSplash', 'uSfBead'], triplanar: ['uSfTri'],
};

function checkNum(v, rule, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`surface3d: ${where} 必须是有限数（收到 ${JSON.stringify(v)}）`);
  const bad = (rule === '>0' && !(v > 0)) || (rule === '≥0' && !(v >= 0)) || (rule === '≥1' && !(v >= 1)) || (rule === '0..1' && !(v >= 0 && v <= 1));
  if (bad) throw new Error(`surface3d: ${where} 要求 ${rule}（收到 ${v}）`);
}
const isLeaf = (d) => Array.isArray(d);

// 走一遍参数树：partial=false 时要求全部字段都在；回调 write(uniform, comp, value)、struct(path, value)
function walk(fields, val, path, { partial, write, struct, nullSub }) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) throw new Error(`surface3d: ${path} 要是对象（收到 ${JSON.stringify(val)}）`);
  for (const k of Object.keys(val)) if (!(k in fields)) throw new Error(`surface3d: ${path} 没有参数 "${k}"（有：${Object.keys(fields).join(', ')}）`);
  for (const [k, d] of Object.entries(fields)) {
    const p = `${path}.${k}`;
    if (!(k in val)) { if (partial) continue; throw new Error(`surface3d: 缺参数 ${p}。所有参数都要显式给（没有审美默认值），含义见 film-webfx/references/surfaces.md`); }
    const v = val[k];
    if (isLeaf(d)) {
      if (Array.isArray(d[0])) {     // 两分量参数
        if (!Array.isArray(v) || v.length !== 2) throw new Error(`surface3d: ${p} 要是 [a, b] 两个数`);
        v.forEach((x, i) => checkNum(x, 'finite', `${p}[${i}]`));
        if (d[2] === 'ramp' && !(v[1] > v[0])) throw new Error(`surface3d: ${p} 要求 lo < hi（smoothstep 两端相等或颠倒时结果未定义）`);
        if (d[2] === 'pos2' && !(v[0] > 0 && v[1] > 0)) throw new Error(`surface3d: ${p} 两个频率都要 > 0`);
        write(d[0][0], d[0][1], v[0]); write(d[1][0], d[1][1], v[1]);
      } else { checkNum(v, d[2], p); write(d[0], d[1], v); }
    } else if (d.enum) {
      if (!d.enum.includes(v)) throw new Error(`surface3d: ${p} 只能是 ${d.enum.map((x) => `'${x}'`).join(' / ')}（收到 ${JSON.stringify(v)}）`);
      struct(p, v);
    } else if (d.leaf) {             // 可为 null 的单值
      if (v === null) { struct(p, null); continue; }
      checkNum(v, d.leaf[2], p); struct(p, 'on'); write(d.leaf[0], d.leaf[1], v);
    } else if (d.sub) {
      if (v === null) { if (!d.nullable) throw new Error(`surface3d: ${p} 不能是 null`); struct(p, null); continue; }
      if (d.nullable) struct(p, 'on');
      walk(d.sub, v, p, { partial, write, struct, nullSub });
    }
  }
}

const VEC = { 2: THREE.Vector2, 3: THREE.Vector3, 4: THREE.Vector4 };
const COMP = ['x', 'y', 'z', 'w'];

// ───────────────────────── 注入代码 ─────────────────────────
const V_DECL = `
varying vec3 vSfPosW;
varying vec3 vSfPosO;
#ifdef SF_TRI
varying vec3 vSfNrmO;
varying mat3 vSfN2V;
#endif
`;
const V_MAIN = `
{
  vSfPosO = transformed;
  vec4 sfW4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    sfW4 = instanceMatrix * sfW4;
  #endif
  vSfPosW = (modelMatrix * sfW4).xyz;
  #ifdef SF_TRI
    vSfNrmO = objectNormal;
    mat3 sfM = normalMatrix;
    #ifdef USE_INSTANCING
      mat3 sfIm = mat3(instanceMatrix);
      sfM = normalMatrix * sfIm * mat3(1.0 / dot(sfIm[0], sfIm[0]), 0.0, 0.0, 0.0, 1.0 / dot(sfIm[1], sfIm[1]), 0.0, 0.0, 0.0, 1.0 / dot(sfIm[2], sfIm[2]));
    #endif
    #ifdef FLIP_SIDED
      sfM = -sfM;
    #endif
    vSfN2V = sfM;
  #endif
}
`;
const F_DECL = `
varying vec3 vSfPosW;
varying vec3 vSfPosO;
uniform vec3 uSfAA; uniform vec3 uSfMacro; uniform vec4 uSfGrime; uniform vec3 uSfGrime2;
uniform vec4 uSfWet; uniform vec4 uSfWet2; uniform vec2 uSfWetP; uniform vec4 uSfSplash; uniform vec4 uSfBead; uniform vec2 uSfTri;
float sfMac = 0.5; float sfMac2 = 0.5; float sfGrime = 0.0; float sfWetK = 0.0; float sfUp = 0.0; float sfBead = 0.0; float sfStreak = 0.0;
vec3 sfNmT = vec3(0.0, 0.0, 1.0);
#ifdef SF_TRI
varying vec3 vSfNrmO;
varying mat3 vSfN2V;
vec3 sfTw = vec3(0.0, 1.0, 0.0); vec2 sfUx = vec2(0.0); vec2 sfUy = vec2(0.0); vec2 sfUz = vec2(0.0);
vec3 sfNx = vec3(0.0, 0.0, 1.0); vec3 sfNy = vec3(0.0, 0.0, 1.0); vec3 sfNz = vec3(0.0, 0.0, 1.0);
vec4 sf_tri(sampler2D t){ return texture(t, sfUx) * sfTw.x + texture(t, sfUy) * sfTw.y + texture(t, sfUz) * sfTw.z; }
#endif
${G_HASH}${G_VNOISE}
`;
// map_fragment 的替换（只在三平面时替换）：先算三向权重和三组 UV，再采样反照率
const F_MAP_TRI = `
{
  vec3 sfOn = normalize(vSfNrmO); vec3 sfW3 = pow(abs(sfOn), vec3(uSfTri.y)); sfTw = sfW3 / (sfW3.x + sfW3.y + sfW3.z);
  vec3 sfQ = vSfPosO * uSfTri.x; sfUx = sfQ.zy; sfUy = sfQ.xz; sfUz = sfQ.xy;
}
#ifdef USE_MAP
  vec4 sampledDiffuseColor = sf_tri(map);
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`;
// color_fragment 之后：宏观、积垢、湿润对反照率的作用（顶点色已乘进 diffuseColor）
const F_ALBEDO = `
{
  #ifdef FLAT_SHADED
    vec3 sfVN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  #else
    vec3 sfVN = normalize(vNormal);
    #ifdef DOUBLE_SIDED
      sfVN *= gl_FrontFacing ? 1.0 : -1.0;
    #endif
  #endif
  vec3 sfWN = inverseTransformDirection(sfVN, viewMatrix);
  #ifdef SF_MACRO
    vec3 sfMp = SF_MACRO_POS * uSfMacro.x;
    sfMac = sf_vnoise3(sfMp); sfMac2 = sf_vnoise3(sfMp * 3.7 + 11.3);
    diffuseColor.rgb *= max(0.0, 1.0 + uSfMacro.y * (sfMac * 0.65 + sfMac2 * 0.35 - 0.5) * 2.0);
  #endif
  #ifdef SF_GRIME
    #ifdef SF_GRIME_SHARE
      float sfG1 = sfMac, sfG2 = sfMac2;
    #else
      vec3 sfGp = SF_GRIME_POS * uSfGrime2.x;
      float sfG1 = sf_vnoise3(sfGp), sfG2 = sf_vnoise3(sfGp * 3.7 + 11.3);
    #endif
    float sfAo = 1.0;
    #if SF_GRIME_AO == 1 && defined( USE_AOMAP )
      #ifdef SF_TRI
        sfAo = sf_tri(aoMap).r;
      #else
        sfAo = texture(aoMap, vAoMapUv).r;
      #endif
    #elif SF_GRIME_AO == 2 && ( defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) )
      sfAo = dot(vColor.rgb, vec3(0.3333));
    #endif
    sfGrime = smoothstep(uSfGrime.y, uSfGrime.z, sfG1 * 0.6 + sfG2 * 0.4 + (1.0 - sfAo) * uSfGrime.w) * uSfGrime.x;
    diffuseColor.rgb *= 1.0 - uSfGrime2.y * sfGrime;
  #endif
  #ifdef SF_WET
    sfUp = smoothstep(0.15, 0.85, sfWN.y);                 // 朝上
    float sfExpo = smoothstep(-0.4, -0.05, sfWN.y);        // 朝下的面淋不到
    vec3 sfS = vSfPosW * vec3(uSfWet2.z, uSfWet2.w, uSfWet2.z);
    sfStreak = sf_vnoise3(sfS) * sf_vnoise3(sfS * vec3(3.2, 2.0, 3.2) + 7.0);
    sfStreak = smoothstep(0.12, 0.42, sfStreak) * smoothstep(0.3, 0.7, sf_vnoise3(sfS * vec3(0.12, 0.45, 0.12) + 1.7));
    float sfPatch = 1.0 + uSfWetP.y * (2.0 * sf_vnoise3(vSfPosW * uSfWetP.x + 5.1) - 1.0);
    float sfW = uSfWet.x * sfExpo;
    sfWetK = sfW * mix(uSfWet.w * (0.55 + 0.9 * sfStreak), sfPatch, sfUp);
    #ifdef SF_SPLASH
    {
      float sfLow = (1.0 - smoothstep(0.0, uSfSplash.y, vSfPosW.y - uSfSplash.x)) * (1.0 - sfUp) * sfExpo;
      sfWetK += sfW * sfLow * uSfSplash.z;
      diffuseColor.rgb *= 1.0 - sfLow * uSfSplash.w * uSfWet.x;
    }
    #endif
    sfWetK = clamp(sfWetK, 0.0, 1.0);
    #ifdef SF_BEADS
    {
      float sfBf = clamp(1.0 - length(fwidth(vSfPosW)) / uSfBead.z, 0.0, 1.0);   // 像素足迹（米/像素）大于 fadePx 时没有水珠
      if (sfBf > 0.0 && uSfBead.x > 0.0) {
        vec3 sfBp = vSfPosW / uSfBead.y;
        float sfB = sf_vnoise3(sfBp) * 0.6 + sf_vnoise3(sfBp * 2.4 + 5.0) * 0.4;
        sfBead = clamp(smoothstep(0.6, 0.68, sfB) * uSfBead.x * sfW * sfBf * (0.4 + 0.6 * sfUp + 0.5 * sfStreak), 0.0, 1.0);
      }
    }
    #endif
    float sfLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = max(vec3(0.0), mix(vec3(sfLum), diffuseColor.rgb, 1.0 + uSfWet2.x * uSfWet.y * sfWetK));
    diffuseColor.rgb *= 1.0 - uSfWet.y * sfWetK;
  #endif
}
`;
const F_ROUGH_TRI = `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = sf_tri(roughnessMap);
  roughnessFactor *= texelRoughness.g;
#endif
`;
const F_ROUGH = `
#ifdef SF_MACRO
  roughnessFactor += uSfMacro.z * ((sfMac2 - 0.5) * 1.4 + (sfMac - 0.5) * 0.8);
#endif
#ifdef SF_GRIME
  roughnessFactor += uSfGrime2.z * sfGrime;
#endif
#ifdef SF_WET
  roughnessFactor = mix(roughnessFactor, roughnessFactor * uSfWet.z, sfWetK);
  #ifdef SF_BEADS
    roughnessFactor = mix(roughnessFactor, uSfBead.w, sfBead);
  #endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) && defined( SF_NM )
  #ifdef SF_TRI
    sfNx = texture(normalMap, sfUx).xyz * 2.0 - 1.0; sfNy = texture(normalMap, sfUy).xyz * 2.0 - 1.0; sfNz = texture(normalMap, sfUz).xyz * 2.0 - 1.0;
    float sfNl = length(sfNx) * sfTw.x + length(sfNy) * sfTw.y + length(sfNz) * sfTw.z;
  #else
    sfNmT = texture(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
    float sfNl = length(sfNmT);
  #endif
  #if defined( SF_AA ) && !defined( USE_PACKED_NORMALMAP )
    roughnessFactor = sqrt(roughnessFactor * roughnessFactor + clamp(1.0 - sfNl, 0.0, 1.0) * uSfAA.x);   // mip 后法线变短 → 粗糙度变大（Toksvig 式）
  #endif
#endif
#ifdef SF_AA
  roughnessFactor = clamp(roughnessFactor, uSfAA.y, 1.0);
#else
  roughnessFactor = clamp(roughnessFactor, 0.0, 1.0);
#endif
`;
const F_METAL_TRI = `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = sf_tri(metalnessMap);
  metalnessFactor *= texelMetalness.b;
#endif
`;
// normal_fragment_maps 的替换（三平面、湿润压平、或抗闪烁已经采过法线贴图时）
const F_NORMAL = `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize(normalMatrix * normal);
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  {
    float sfFl = 1.0;
    #ifdef SF_WET
      sfFl = 1.0 - uSfWet2.y * sfWetK * sfUp;
    #endif
    #ifdef SF_TRI
      // whiteout 混合（UDN 的改进）：每个投影面的切线法线加上物体法线的对应分量，再按投影轴换位
      vec3 sfOn = normalize(vSfNrmO);
      vec3 sfTx = sfNx, sfTy = sfNy, sfTz = sfNz;
      sfTx.xy *= normalScale * sfFl; sfTy.xy *= normalScale * sfFl; sfTz.xy *= normalScale * sfFl;
      sfTx = vec3(sfTx.xy + sfOn.zy, abs(sfTx.z) * sfOn.x);
      sfTy = vec3(sfTy.xy + sfOn.xz, abs(sfTy.z) * sfOn.y);
      sfTz = vec3(sfTz.xy + sfOn.xy, abs(sfTz.z) * sfOn.z);
      vec3 sfNo = normalize(sfTx.zyx * sfTw.x + sfTy.xzy * sfTw.y + sfTz.xyz * sfTw.z);
      normal = normalize(vSfN2V * sfNo);
      #ifdef DOUBLE_SIDED
        normal *= faceDirection;
      #endif
    #else
      vec3 mapN = sfNmT;
      #if defined( USE_PACKED_NORMALMAP )
        mapN = vec3(mapN.xy, sqrt(saturate(1.0 - dot(mapN.xy, mapN.xy))));
      #endif
      mapN.xy *= normalScale * sfFl;
      normal = normalize(tbn * mapN);
    #endif
  }
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`;
const F_SPECMAX = `
#ifdef SF_SPECMAX
  reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(uSfAA.z));
#endif
`;

function inject(src, token, mode, code, what) {
  const n = src.split(token).length - 1;
  if (n !== 1) throw new Error(`surface3d: ${what} 里找不到恰好一处 "${token}"（找到 ${n} 处）。three 的着色器结构变了，注入点要跟着改`);
  return src.replace(token, mode === 'after' ? `${token}\n${code}` : code);
}

/**
 * 给 MeshStandardMaterial / MeshPhysicalMaterial 注入表面特性。features 里出现的键 = 开启；每个特性的参数要全给。
 *   antiFlicker { toksvig, minRoughness, maxSpecular|null }
 *   macro       { space:'world'|'object', freq, albedo, roughness }
 *   grime       { space, ao:'aoMap'|'vertexColor'|'none', freq, amount, ramp:[lo,hi], aoWeight, darken, roughen }
 *   wet         { level, darken, roughnessMul, vertical, saturate, flatten, streakFreq:[h,v], patch:{freq, amount},
 *                 splash: null|{groundY, height, amount, darken}, beads: null|{amount, size, fadePx, roughness} }
 *   triplanar   { scale, sharpness }
 * 返回 { uniforms, set(patch), key, features }。set 只改数值；结构（空间、AO 来源、子特性开关）要换就新建材质。
 * 必须在 S.freeze() 之前调（uniform 挂在 material.uniforms 上，由舞台复位）。
 */
export function applySurface(material, features) {
  if (!material || !material.isMeshStandardMaterial) throw new Error('surface3d.applySurface: 只支持 MeshStandardMaterial / MeshPhysicalMaterial');
  if (material.userData && material.userData.__sfApplied) throw new Error('surface3d.applySurface: 这个材质已经注入过了；要换特性组合就 new 一个材质');
  if (!features || typeof features !== 'object') throw new Error('surface3d.applySurface: features 要是对象');
  const names = Object.keys(features);
  if (!names.length) throw new Error('surface3d.applySurface: features 是空的（至少开一个特性）');
  for (const k of names) if (!SPEC[k]) throw new Error(`surface3d.applySurface: 没有特性 "${k}"（有：${Object.keys(SPEC).join(', ')}）`);

  const uniforms = {};
  for (const k of names) for (const u of FEATURE_UNIFORMS[k]) uniforms[u] = { value: new VEC[UNIFORM_DIM[u]]() };
  const write = (u, c, v) => { uniforms[u].value[COMP[c]] = v; };
  const struct = {};
  for (const k of names) walk(SPEC[k].fields, features[k], k, { partial: false, write, struct: (p, v) => { struct[p] = v; } });

  // ---- 结构检查：贴图条件 ----
  const mips = (tx) => tx.generateMipmaps !== false && (tx.minFilter === THREE.LinearMipmapLinearFilter || tx.minFilter === THREE.NearestMipmapLinearFilter
    || tx.minFilter === THREE.LinearMipmapNearestFilter || tx.minFilter === THREE.NearestMipmapNearestFilter);
  if (features.antiFlicker && features.antiFlicker.toksvig > 0 && material.normalMap && !mips(material.normalMap)) {
    throw new Error('surface3d: antiFlicker.toksvig 靠法线贴图的 mip 变短来量"这一像素里法线有多乱"——normalMap 要开 mipmap（generateMipmaps 且 minFilter 为 *Mipmap* 过滤）');
  }
  if (features.triplanar) {
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const tx = material[key];
      if (tx && (tx.wrapS !== THREE.RepeatWrapping || tx.wrapT !== THREE.RepeatWrapping)) throw new Error(`surface3d: triplanar 按物体坐标连续采样，${key} 要设 wrapS = wrapT = RepeatWrapping`);
    }
    if (material.normalMap && material.normalMapType === THREE.ObjectSpaceNormalMap) throw new Error('surface3d: triplanar 只处理切线空间法线贴图（物体空间法线贴图本来就不需要 UV 切线）');
  }
  if (features.grime) {
    if (features.grime.ao === 'aoMap' && !material.aoMap) throw new Error('surface3d: grime.ao = "aoMap" 但材质没有 aoMap');
    if (features.grime.ao === 'vertexColor' && !material.vertexColors) throw new Error('surface3d: grime.ao = "vertexColor" 但材质没开 vertexColors（先 weatherGeometry 再设 vertexColors: true）');
  }

  // ---- 程序结构 → defines + 缓存键 ----
  const defs = [];
  for (const k of names) defs.push(SPEC[k].define);
  if (struct['antiFlicker.maxSpecular'] === 'on') defs.push('SF_SPECMAX');
  if (features.macro) defs.push(`SF_MACRO_POS ${features.macro.space === 'world' ? 'vSfPosW' : 'vSfPosO'}`);
  if (features.grime) {
    defs.push(`SF_GRIME_POS ${features.grime.space === 'world' ? 'vSfPosW' : 'vSfPosO'}`);
    defs.push(`SF_GRIME_AO ${{ aoMap: 1, vertexColor: 2, none: 0 }[features.grime.ao]}`);
    // 频率可逐帧独立修改：加载时碰巧相等不代表同一条噪声通道，保持分开求值。
  }
  if (struct['wet.splash'] === 'on') defs.push('SF_SPLASH');
  if (struct['wet.beads'] === 'on') defs.push('SF_BEADS');
  const needNormal = !!(features.triplanar || features.wet || features.antiFlicker);
  if (needNormal) defs.push('SF_NM');
  const defBlock = defs.map((d) => `#define ${d}`).join('\n');
  const key = `sf1|${defs.join(',')}`;

  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const hadCustom = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
  material.onBeforeCompile = function (shader, renderer) {
    if (hadCustom) prevCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    vs = inject(vs, '#include <common>', 'after', `${defBlock}\n${V_DECL}`, '顶点着色器');
    vs = inject(vs, '#include <project_vertex>', 'after', V_MAIN, '顶点着色器');
    fs = inject(fs, '#include <common>', 'after', `${defBlock}\n${F_DECL}`, '片元着色器');
    if (features.triplanar) fs = inject(fs, '#include <map_fragment>', 'replace', F_MAP_TRI, '片元着色器');
    fs = inject(fs, '#include <color_fragment>', 'after', F_ALBEDO, '片元着色器');
    if (features.triplanar) {
      fs = inject(fs, '#include <roughnessmap_fragment>', 'replace', F_ROUGH_TRI + F_ROUGH, '片元着色器');
      fs = inject(fs, '#include <metalnessmap_fragment>', 'replace', F_METAL_TRI, '片元着色器');
      const ao = THREE.ShaderChunk.aomap_fragment;
      const tok = 'texture2D( aoMap, vAoMapUv ).r';
      if (ao.split(tok).length !== 2) throw new Error('surface3d: three 的 aomap_fragment 变了，三平面 AO 的替换点要跟着改');
      fs = inject(fs, '#include <aomap_fragment>', 'replace', ao.replace(tok, 'sf_tri(aoMap).r'), '片元着色器');
    } else {
      fs = inject(fs, '#include <roughnessmap_fragment>', 'after', F_ROUGH, '片元着色器');
    }
    if (needNormal) fs = inject(fs, '#include <normal_fragment_maps>', 'replace', F_NORMAL, '片元着色器');
    fs = inject(fs, '#include <lights_fragment_end>', 'after', F_SPECMAX, '片元着色器');
    shader.vertexShader = vs; shader.fragmentShader = fs;
  };
  // 默认的 customProgramCacheKey 返回 onBeforeCompile.toString()：所有特性组合共用同一段函数源码 → 会串程序，必须覆盖。
  // 材质原先自己设过键（别的注入）就串在后面。
  const hadKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
  material.customProgramCacheKey = function () { return hadKey ? `${key}|${prevKey.call(this)}` : key; };
  if (material.uniforms) {
    for (const u of Object.keys(uniforms)) if (u in material.uniforms) throw new Error(`surface3d: material.uniforms 里已经有 ${u}`);
    Object.assign(material.uniforms, uniforms);
  } else material.uniforms = uniforms;   // stage3d 的 freeze/reset 认 material.uniforms：复位到 freeze 时的值
  material.userData.__sfApplied = key;
  material.needsUpdate = true;

  const frozen = JSON.parse(JSON.stringify(features));
  return {
    uniforms, key, features: frozen,
    /** 改数值参数（部分即可，例如 { wet: { level: 0.4 } }）。在 S.frame 的 paint 里每帧写满随 t 变的那几个 */
    set(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('surface3d.set: 要传对象');
      for (const k of Object.keys(patch)) {
        if (!features[k]) throw new Error(`surface3d.set: 这个材质没开 ${k}（开了：${names.join(', ')}）`);
        walk(SPEC[k].fields, patch[k], k, {
          partial: true, write,
          struct: (p, v) => { if (struct[p] !== v) throw new Error(`surface3d.set: ${p} 是结构参数（编进着色器程序），不能每帧改；要换就新建材质`); },
        });
      }
      return this;
    },
  };
}

// ───────────────────────── 顶点色风化（加载期，一次性）─────────────────────────
const sstep = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function vnoise3js(seed, x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => hash01(seed, ix + a, iy + b, iz + c);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h(0, 0, 0), h(1, 0, 0), ux), L(h(0, 1, 0), h(1, 1, 0), ux), uy),
    L(L(h(0, 0, 1), h(1, 0, 1), ux), L(h(0, 1, 1), h(1, 1, 1), ux), uy), uz);
}
function need(o, path, keys) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error(`surface3d.weatherGeometry: ${path} 要是对象或 null`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`surface3d.weatherGeometry: ${path} 没有参数 "${k}"（有：${keys.join(', ')}）`);
  for (const k of keys) if (!(k in o)) throw new Error(`surface3d.weatherGeometry: 缺参数 ${path}.${k}（所有参数显式给，没有默认值）`);
}
const num = (v, where, rule = 'finite') => { checkNum(v, rule, `weatherGeometry ${where}`); return v; };
const rgb = (v, where) => { if (!Array.isArray(v) || v.length !== 3) throw new Error(`surface3d.weatherGeometry: ${where} 要是 [r, g, b] 乘数`); v.forEach((x, i) => num(x, `${where}[${i}]`, '≥0')); return v; };

/**
 * 加载期给几何体写顶点色（纯函数：返回新几何体，不改输入）。材质要开 vertexColors: true。
 *   seed        整数种子（rand.js 的 hash01）
 *   transform   Matrix4：几何体 → 世界（接触带的高度、噪声坐标按世界算）。几何体已在世界坐标时传 new THREE.Matrix4()
 *   mottle      null | [{ freq(每米), amount }]：低频亮度变化，每层乘 1 + amount·(2n−1)
 *   hemi        null | { down, side }：朝下（N.y=−1）和水平（N.y=0）面的乘数，朝上 = 1，中间线性
 *   contact     null | { groundY(米), height(米), darken, warm: null|[r,g,b], noise: null|{freq, amount} }：离地接触污垢带
 *   crease      null | { weld(米), ramp:[lo,hi], concave, convex }：凹处/凸棱压暗（曲率 = 邻点均值偏离切平面 / 平均边长；convex 可为负 = 提亮）
 *   rust        null | { color:[r,g,b], amount, freq, ramp:[lo,hi], where:'crease'|'all' }
 * 已有 color 属性时乘在它上面。接触带比三角形竖向跨度还窄时抛错（插值会把带抹成整面渐变）：先 subdivideGeometry 或多给分段。
 */
export function weatherGeometry(geometry, opts) {
  if (!geometry || !geometry.isBufferGeometry) throw new Error('surface3d.weatherGeometry: geometry 要是 BufferGeometry');
  need(opts, 'opts', ['seed', 'transform', 'mottle', 'hemi', 'contact', 'crease', 'rust']);
  const seed = opts.seed;
  if (!Number.isInteger(seed)) throw new Error('surface3d.weatherGeometry: seed 要是整数');
  if (!opts.transform || !opts.transform.isMatrix4) throw new Error('surface3d.weatherGeometry: transform 要是 THREE.Matrix4（几何体 → 世界）');
  const mottle = opts.mottle;
  if (mottle !== null) {
    if (!Array.isArray(mottle) || !mottle.length) throw new Error('surface3d.weatherGeometry: mottle 要是非空数组或 null');
    mottle.forEach((l, i) => { need(l, `mottle[${i}]`, ['freq', 'amount']); num(l.freq, `mottle[${i}].freq`, '>0'); num(l.amount, `mottle[${i}].amount`, '0..1'); });
  }
  const hemi = opts.hemi;
  if (hemi !== null) { need(hemi, 'hemi', ['down', 'side']); num(hemi.down, 'hemi.down', '≥0'); num(hemi.side, 'hemi.side', '≥0'); }
  const contact = opts.contact;
  if (contact !== null) {
    need(contact, 'contact', ['groundY', 'height', 'darken', 'warm', 'noise']);
    num(contact.groundY, 'contact.groundY'); num(contact.height, 'contact.height', '>0'); num(contact.darken, 'contact.darken', '0..1');
    if (contact.warm !== null) rgb(contact.warm, 'contact.warm');
    if (contact.noise !== null) { need(contact.noise, 'contact.noise', ['freq', 'amount']); num(contact.noise.freq, 'contact.noise.freq', '>0'); num(contact.noise.amount, 'contact.noise.amount', '0..1'); }
  }
  const crease = opts.crease;
  if (crease !== null) {
    need(crease, 'crease', ['weld', 'ramp', 'concave', 'convex']);
    num(crease.weld, 'crease.weld', '>0'); num(crease.concave, 'crease.concave', '0..1'); num(crease.convex, 'crease.convex');
    if (!Array.isArray(crease.ramp) || crease.ramp.length !== 2 || !(crease.ramp[1] > crease.ramp[0])) throw new Error('surface3d.weatherGeometry: crease.ramp 要是 [lo, hi] 且 lo < hi');
  }
  const rust = opts.rust;
  if (rust !== null) {
    need(rust, 'rust', ['color', 'amount', 'freq', 'ramp', 'where']);
    rgb(rust.color, 'rust.color'); num(rust.amount, 'rust.amount', '0..1'); num(rust.freq, 'rust.freq', '>0');
    if (!Array.isArray(rust.ramp) || rust.ramp.length !== 2 || !(rust.ramp[1] > rust.ramp[0])) throw new Error('surface3d.weatherGeometry: rust.ramp 要是 [lo, hi] 且 lo < hi');
    if (rust.where !== 'crease' && rust.where !== 'all') throw new Error("surface3d.weatherGeometry: rust.where 只能是 'crease' / 'all'");
    if (rust.where === 'crease' && crease === null) throw new Error("surface3d.weatherGeometry: rust.where = 'crease' 需要同时给 crease");
  }

  const g = geometry.clone();
  const pos = g.attributes.position;
  if (!pos) throw new Error('surface3d.weatherGeometry: 几何体没有 position');
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal;
  const n = pos.count;
  const M = opts.transform, NM = new THREE.Matrix3().getNormalMatrix(M);
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(M); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    v.fromBufferAttribute(nor, i).applyMatrix3(NM).normalize(); N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z;
  }
  const idx = g.index ? g.index.array : null;
  const triCount = idx ? idx.length / 3 : n / 3;
  const tri = (t, k) => (idx ? idx[t * 3 + k] : t * 3 + k);

  if (contact !== null) {   // 顶点密度检查：跨过接触带的三角形竖向跨度不能大于带高
    const top = contact.groundY + contact.height;
    for (let t = 0; t < triCount; t++) {
      const ys = [0, 1, 2].map((k) => P[tri(t, k) * 3 + 1]);
      const lo = Math.min(...ys), hi = Math.max(...ys);
      if (lo < top && hi > contact.groundY && hi - lo > contact.height * 1.0001) {
        throw new Error(`surface3d.weatherGeometry: 顶点太稀——第 ${t} 个三角形竖向跨 ${(hi - lo).toFixed(3)} m，比接触带高 ${contact.height} m 还大，`
          + `插值会把接触带抹成整面渐变。先 subdivideGeometry(geo, { maxEdge: ${(contact.height / 2).toPrecision(2)}, maxTriangles }) 或给几何体更多竖向分段`);
      }
    }
  }

  // 凹凸：按位置焊接 → 邻点表 → 邻点均值偏离（焊接后平均法线的）切平面的距离 / 平均边长
  let curv = null;
  if (crease !== null) {
    const q = 1 / crease.weld, keyOf = (i) => `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    const wid = new Int32Array(n); const map = new Map(); let W = 0;
    for (let i = 0; i < n; i++) { const k = keyOf(i); let w = map.get(k); if (w === undefined) { w = W++; map.set(k, w); } wid[i] = w; }
    const wp = new Float64Array(W * 3), wn = new Float64Array(W * 3), wc = new Float64Array(W);
    for (let i = 0; i < n; i++) { const w = wid[i]; for (let c = 0; c < 3; c++) wp[w * 3 + c] += P[i * 3 + c]; wc[w]++; }
    for (let w = 0; w < W; w++) for (let c = 0; c < 3; c++) wp[w * 3 + c] /= wc[w];
    const nb = Array.from({ length: W }, () => new Set());
    for (let t = 0; t < triCount; t++) {
      const a = wid[tri(t, 0)], b = wid[tri(t, 1)], c = wid[tri(t, 2)];
      if (a === b || b === c || a === c) continue;
      nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
      // 面法线（面积加权）累加到焊接点
      const ax = wp[a * 3], ay = wp[a * 3 + 1], az = wp[a * 3 + 2];
      const ux = wp[b * 3] - ax, uy = wp[b * 3 + 1] - ay, uz = wp[b * 3 + 2] - az;
      const vx = wp[c * 3] - ax, vy = wp[c * 3 + 1] - ay, vz = wp[c * 3 + 2] - az;
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      for (const w of [a, b, c]) { wn[w * 3] += fx; wn[w * 3 + 1] += fy; wn[w * 3 + 2] += fz; }
    }
    const wcurv = new Float64Array(W);
    for (let w = 0; w < W; w++) {
      if (!nb[w].size) continue;
      let mx = 0, my = 0, mz = 0, el = 0;
      for (const o of nb[w]) { mx += wp[o * 3]; my += wp[o * 3 + 1]; mz += wp[o * 3 + 2]; el += Math.hypot(wp[o * 3] - wp[w * 3], wp[o * 3 + 1] - wp[w * 3 + 1], wp[o * 3 + 2] - wp[w * 3 + 2]); }
      const k = nb[w].size; mx = mx / k - wp[w * 3]; my = my / k - wp[w * 3 + 1]; mz = mz / k - wp[w * 3 + 2]; el /= k;
      const ln = Math.hypot(wn[w * 3], wn[w * 3 + 1], wn[w * 3 + 2]) || 1;
      wcurv[w] = el > 0 ? (mx * wn[w * 3] + my * wn[w * 3 + 1] + mz * wn[w * 3 + 2]) / ln / el : 0;   // > 0 凹，< 0 凸
    }
    curv = new Float64Array(n); for (let i = 0; i < n; i++) curv[i] = wcurv[wid[i]];
  }

  const old = g.attributes.color;
  const col = new Float32Array(n * 3);
  let cmin = Infinity, cmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], ny = N[i * 3 + 1];
    let m = 1, r = 1, gg = 1, b = 1;
    if (mottle) for (let l = 0; l < mottle.length; l++) { const f = mottle[l].freq; m *= 1 + mottle[l].amount * (2 * vnoise3js(seed * 31 + l, x * f, y * f, z * f) - 1); }
    if (hemi) m *= ny >= 0 ? hemi.side + (1 - hemi.side) * ny : hemi.side + (hemi.down - hemi.side) * -ny;
    if (contact) {
      const k = clamp01(1 - (y - contact.groundY) / contact.height), k2 = k * k;
      let nz = 1;
      if (contact.noise) { const f = contact.noise.freq; nz = 1 - contact.noise.amount + contact.noise.amount * vnoise3js(seed * 31 + 101, x * f, y * f, z * f); }
      m *= 1 - contact.darken * k2 * nz;
      if (contact.warm) { r *= 1 + (contact.warm[0] - 1) * k; gg *= 1 + (contact.warm[1] - 1) * k; b *= 1 + (contact.warm[2] - 1) * k; }
    }
    let cmask = 0;
    if (crease) {
      const c = curv[i]; cmin = Math.min(cmin, c); cmax = Math.max(cmax, c);
      const cc = sstep(crease.ramp[0], crease.ramp[1], c), cv = sstep(crease.ramp[0], crease.ramp[1], -c);
      m *= Math.max(0, 1 - crease.concave * cc - crease.convex * cv);
      cmask = Math.max(cc, cv);
    }
    if (rust) {
      const f = rust.freq;
      const k = sstep(rust.ramp[0], rust.ramp[1], vnoise3js(seed * 31 + 202, x * f, y * f, z * f)) * rust.amount * (rust.where === 'crease' ? cmask : 1);
      r *= 1 + (rust.color[0] - 1) * k; gg *= 1 + (rust.color[1] - 1) * k; b *= 1 + (rust.color[2] - 1) * k;
    }
    const o0 = old ? old.getX(i) : 1, o1 = old ? old.getY(i) : 1, o2 = old ? old.getZ(i) : 1;
    col[i * 3] = o0 * m * r; col[i * 3 + 1] = o1 * m * gg; col[i * 3 + 2] = o2 * m * b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.userData = { ...g.userData, weather: { vertices: n, triangles: triCount, curvature: crease ? [cmin, cmax] : null } };
  return g;
}

/**
 * 均匀细分（加载期）：每个三角形按 n×n 的重心网格切开，n = ceil(最长边 / maxEdge)，全体用同一个 n（相邻三角形共享边切法相同，不产生 T 形裂缝）。
 * 输出非索引几何体；所有属性按重心线性插值，normal 重新归一；groups 按比例放大。三角形数超过 maxTriangles 抛错。
 */
export function subdivideGeometry(geometry, { maxEdge, maxTriangles } = {}) {
  if (!geometry || !geometry.isBufferGeometry) throw new Error('surface3d.subdivideGeometry: geometry 要是 BufferGeometry');
  checkNum(maxEdge, '>0', 'subdivideGeometry maxEdge'); checkNum(maxTriangles, '>0', 'subdivideGeometry maxTriangles');
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.attributes.position, T = pos.count / 3;
  let longest = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let t = 0; t < T; t++) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
    a.fromBufferAttribute(pos, t * 3 + i); b.fromBufferAttribute(pos, t * 3 + j); longest = Math.max(longest, a.distanceTo(b));
  }
  const k = Math.max(1, Math.ceil(longest / maxEdge));
  const outT = T * k * k;
  if (outT > maxTriangles) throw new Error(`surface3d.subdivideGeometry: 细分后 ${outT} 个三角形，超过 maxTriangles ${maxTriangles}（最长边 ${longest.toFixed(3)} m，n=${k}）。换成分段数更多的原始几何体，或放宽 maxEdge`);
  const out = new THREE.BufferGeometry();
  // 一个三角形内的 n×n 小三角形（重心坐标）
  const bary = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
    bary.push([i, j], [i + 1, j], [i, j + 1]);
    if (i + j < k - 1) bary.push([i + 1, j], [i + 1, j + 1], [i, j + 1]);
  }
  for (const [name, attr] of Object.entries(src.attributes)) {
    const s = attr.itemSize, arr = new Float32Array(outT * 3 * s);
    let o = 0;
    for (let t = 0; t < T; t++) {
      for (const [i, j] of bary) {
        const u = i / k, w = j / k, z = 1 - u - w;
        for (let c = 0; c < s; c++) arr[o++] = z * attr.getComponent(t * 3, c) + u * attr.getComponent(t * 3 + 1, c) + w * attr.getComponent(t * 3 + 2, c);
      }
    }
    if (name === 'normal') for (let q = 0; q < arr.length; q += 3) { const l = Math.hypot(arr[q], arr[q + 1], arr[q + 2]) || 1; arr[q] /= l; arr[q + 1] /= l; arr[q + 2] /= l; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  for (const gr of src.groups) out.addGroup(gr.start * k * k, gr.count * k * k, gr.materialIndex);
  return out;
}
