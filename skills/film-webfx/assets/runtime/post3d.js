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

import * as THREE from './three-film.module.js';

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
    vignette: want('vignette'), scanlines: want('scanlines'), glitch: want('glitch') };
  for (const k of Object.keys(cfg)) if (!['samples', 'hdr', 'output', 'seed', ...Object.keys(E)].includes(k)) throw new Error(`post3d: 不认识的效果 ${k}`);

  const mkRT = (w, h, extra = {}) => new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
    type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...extra,
  });
  const depthTex = (E.dof) ? new THREE.DepthTexture(W, H, THREE.UnsignedIntType) : null;
  const rtScene = mkRT(W, H, { depthBuffer: true, samples: cfg.samples ?? 0, ...(depthTex ? { depthTexture: depthTex } : {}) });

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

  // ---------- bloom ----------
  let bloom = null;
  if (E.bloom) {
    const o = opt('bloom'), L = o.levels ?? 5, res = o.resolution ?? 0.5;
    const down = [], up = [];
    for (let i = 0; i < L; i++) down.push(mkRT((W * res) / 2 ** i, (H * res) / 2 ** i));
    for (let i = 0; i < L - 1; i++) up.push(mkRT((W * res) / 2 ** i, (H * res) / 2 ** i));
    const pre = mat(`varying vec2 vUv; uniform sampler2D tIn; uniform vec2 texel; uniform float threshold, knee; ${LUMA}
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
      run(p) {
        pre.uniforms.tIn.value = rtScene.texture; pre.uniforms.texel.value.set(1 / W, 1 / H);
        pre.uniforms.threshold.value = p.threshold; pre.uniforms.knee.value = Math.max(1e-4, p.knee);
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
        u.tColor.value = rtScene.texture; u.tDepth.value = depthTex;
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
        pre.uniforms.tIn.value = rtScene.texture; pre.uniforms.threshold.value = p.threshold; pass(pre, rtA);
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
  c.rgb += texture2D(tBloom, uv).rgb * bloomStrength;
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
    tScene: { value: rtScene.texture }, tBloom: { value: null }, tDof: { value: null }, tRays: { value: null }, tDepth: { value: depthTex },
    res: { value: new THREE.Vector2(W, H) }, uTime: { value: 0 }, uSeed: { value: cfg.seed ?? 0 },
    bloomStrength: { value: 0 }, raysExposure: { value: 0 },
    dofFocus: { value: 1 }, dofBlur: { value: 0 }, dofMax: { value: 1 }, camNear: { value: 0.1 }, camFar: { value: 100 },
    chromaAmount: { value: 0 }, grainAmount: { value: 0 }, grainFrame: { value: 0 }, grainSize: { value: 1 },
    vigAmount: { value: 0 }, vigRadius: { value: 0.7 }, vigSoft: { value: 0.3 },
    scanCount: { value: 0 }, scanAmount: { value: 0 }, scanPhase: { value: 0 },
    glAmount: { value: 0 }, glBucket: { value: 0 }, glSlices: { value: 1 }, glShift: { value: 0 }, glSplit: { value: 0 },
  }, { toneMapped: true, transparent: false });

  const output = cfg.output ?? null;

  /** 每帧调（stage3d 的 render 会替你调）。params 全量，见文件头 */
  function render(t, P) {
    if (!P) throw new Error('post3d: render(t, params) 每帧要传全量参数');
    const u = comp.uniforms;
    // 场景
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(S.scene, S.camera);
    if (!Number.isFinite(P.exposure)) throw new Error('post3d: exposure 必填（色调映射前的曝光倍数，1 = 不变）');
    renderer.toneMappingExposure = P.exposure;
    // 强度为 0 的那一帧跳过整条子链（不是缓存：合成里它的权重恰好是 0，读到的旧纹理乘 0，输出与"跑了一遍"逐位相同）
    if (bloom) { const p = need(P.bloom, 'bloom', ['threshold', 'knee', 'strength', 'radius']); if (p.strength > 0) bloom.run(p); u.tBloom.value = bloom.out(); u.bloomStrength.value = Math.max(0, p.strength); }
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
    pass(comp, output);
  }

  const post = {
    render, effects: { ...E }, rtScene,
    dispose() { for (const x of [bloom, dof, rays]) if (x) { x.rts.forEach((r) => r.dispose()); x.mats.forEach((m) => m.dispose()); } comp.dispose(); rtScene.dispose(); },
  };
  S._attachPost(post);
  return post;
}
