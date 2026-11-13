// webfx.js —— 可 seek 的 WebGL 片元着色器层。零依赖。
//
// 契约（违反就是 bug）：
//   - 着色器里的时间只来自 u_time，由 fx.render(t) 每次显式传入。本文件不读任何时钟，
//     不开 rAF 循环。
//   - 随机只来自 u_seed + 着色器内 hash（见 GLSL.hash），不用 Math.random。
//   - render() 是同步的：返回时像素已经可以被 drawImage / readPixels 拿到。
//
// 典型用法（片元层画在离屏 WebGL canvas，再 drawImage 合成进 2D 主画布）：
//   import { createShaderLayer, GLSL } from './runtime/webfx.js';
//   const fx = createShaderLayer({ width: L.width, height: L.height, scale: 0.5,
//     frag: GLSL.header + GLSL.hash + GLSL.noise + `void main(){ ... }` });
//   function seek(t) { ctx.clearRect(...); fx.render(t, { u_amp: 0.3 }); fx.drawTo(ctx); ... }
//
// 为什么默认 scale<1：SwiftShader 软件渲染的成本 ≈ 像素数 × 每像素指令数，
// 半分辨率 = 1/4 成本。见 SKILL.md 的性能表。

const VERT1 = `attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.,1.); }`;
const VERT2 = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.,1.); }`;

/**
 * @param {object} o
 * @param {number} o.width  目标（主画布）宽，像素
 * @param {number} o.height 目标高
 * @param {string} o.frag   片元着色器源码。WebGL1 写法用 gl_FragColor；webgl2:true 时须以 `#version 300 es` 开头
 * @param {number} [o.scale=1]   着色器层的渲染分辨率倍率。0.5 = 宽高各一半
 * @param {boolean} [o.webgl2=false]
 * @param {boolean} [o.premultipliedAlpha=true] 输出是否预乘。和 2D canvas 合成时保持 true，并在着色器里输出预乘色
 * @param {number} [o.seed=1]  注入 u_seed
 * @param {number} [o.period=0] >0 时 u_time = t mod period（长片避免 float32 精度抖动）；0 表示原样传 t
 */
export function createShaderLayer(o) {
  const scale = o.scale ?? 1;
  const w = Math.max(1, Math.round(o.width * scale));
  const h = Math.max(1, Math.round(o.height * scale));
  // 每种 context 一个新 canvas：同一个 canvas 取过 webgl 再取 webgl2 必为 null
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const attrs = {
    alpha: true, premultipliedAlpha: o.premultipliedAlpha ?? true,
    antialias: false, depth: false, stencil: false,
    // true：render() 之后任意时刻 drawImage 都拿得到像素，代价见 compositing.md
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  };
  const gl = canvas.getContext(o.webgl2 ? 'webgl2' : 'webgl', attrs);
  if (!gl) throw new Error(`webfx: 取不到 ${o.webgl2 ? 'webgl2' : 'webgl'} context（是不是在同一个 canvas 上取过另一种？）`);

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      throw new Error(`webfx: 着色器编译失败\n${log}\n${numbered}`);
    }
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, o.webgl2 ? VERT2 : VERT1));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, o.frag));
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('webfx: link 失败 ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  // 一个盖满屏幕的大三角形（比两个三角形的 quad 少一条对角线上的重复着色）
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // uniform 位置缓存 + 按值类型自动选 setter
  const locs = new Map();
  const loc = (name) => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
    return locs.get(name);
  };

  // 反射：link 之后一次读出每个 active uniform 的类型和长度。数组的名字形如 `u_pts[0]`，size 是
  // 编译器保留下来的长度（只用常量下标时，没用到的尾部元素可能被裁掉，size 会比声明的小）。
  const uinfo = new Map();
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const a = gl.getActiveUniform(prog, i);
    if (!a) continue;
    const arr = a.name.endsWith('[0]');
    uinfo.set(arr ? a.name.slice(0, -3) : a.name, { type: a.type, size: a.size, isArray: arr });
  }
  // 类型 → [每个元素几个分量, setter 名, 数组类]
  const F = Float32Array, I = Int32Array, U = typeof Uint32Array !== 'undefined' ? Uint32Array : I;
  const SET = new Map();
  const put = (k, v) => { if (k !== undefined) SET.set(k, v); };
  put(gl.FLOAT, [1, 'uniform1fv', F]); put(gl.FLOAT_VEC2, [2, 'uniform2fv', F]);
  put(gl.FLOAT_VEC3, [3, 'uniform3fv', F]); put(gl.FLOAT_VEC4, [4, 'uniform4fv', F]);
  for (const [k, c] of [['INT', 1], ['INT_VEC2', 2], ['INT_VEC3', 3], ['INT_VEC4', 4], ['BOOL', 1], ['BOOL_VEC2', 2], ['BOOL_VEC3', 3], ['BOOL_VEC4', 4]])
    put(gl[k], [c, `uniform${c}iv`, I]);
  put(gl.FLOAT_MAT2, [4, 'uniformMatrix2fv', F]); put(gl.FLOAT_MAT3, [9, 'uniformMatrix3fv', F]); put(gl.FLOAT_MAT4, [16, 'uniformMatrix4fv', F]);
  for (const k of ['SAMPLER_2D', 'SAMPLER_CUBE', 'SAMPLER_3D', 'SAMPLER_2D_SHADOW', 'SAMPLER_2D_ARRAY', 'SAMPLER_2D_ARRAY_SHADOW',
    'SAMPLER_CUBE_SHADOW', 'INT_SAMPLER_2D', 'INT_SAMPLER_3D', 'INT_SAMPLER_CUBE', 'INT_SAMPLER_2D_ARRAY',
    'UNSIGNED_INT_SAMPLER_2D', 'UNSIGNED_INT_SAMPLER_3D', 'UNSIGNED_INT_SAMPLER_CUBE', 'UNSIGNED_INT_SAMPLER_2D_ARRAY'])
    put(gl[k], [1, 'uniform1iv', I]);
  if (o.webgl2) {   // WebGL2 才有的类型
    for (const [k, c] of [['UNSIGNED_INT', 1], ['UNSIGNED_INT_VEC2', 2], ['UNSIGNED_INT_VEC3', 3], ['UNSIGNED_INT_VEC4', 4]])
      put(gl[k], [c, `uniform${c}uiv`, U]);
    for (const [k, c, f] of [['FLOAT_MAT2x3', 6, '2x3'], ['FLOAT_MAT2x4', 8, '2x4'], ['FLOAT_MAT3x2', 6, '3x2'],
      ['FLOAT_MAT3x4', 12, '3x4'], ['FLOAT_MAT4x2', 8, '4x2'], ['FLOAT_MAT4x3', 12, '4x3']])
      put(gl[k], [c, `uniformMatrix${f}fv`, F]);
  }
  // 旧路径（按值的形状选 setter）对这几种类型本来就是对的；保留它，旧调用方式的行为逐位不变
  const LEGACY = new Set([gl.FLOAT, gl.FLOAT_VEC2, gl.FLOAT_VEC3, gl.FLOAT_VEC4, gl.FLOAT_MAT3, gl.FLOAT_MAT4]);

  // 把数 / 数组 / 嵌套数组 / TypedArray 摊平成一维
  const flat = (v) => {
    if (typeof v === 'number' || typeof v === 'boolean') return [+v];
    if (ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) {
      const out = [];
      for (const e of v) {
        if (typeof e === 'number' || typeof e === 'boolean') out.push(+e);
        else if (Array.isArray(e) || ArrayBuffer.isView(e)) for (const x of e) out.push(+x);
        else throw new Error('webfx: uniform 数组里有不认识的元素 ' + String(e));
      }
      return out;
    }
    throw new Error('webfx: uniform 值类型不认识 ' + String(v));
  };

  // 按反射类型写。full=true（整个数组）时元素数必须 ≥ 反射 size：
  // 少传会让没传到的元素保留上一帧的值——那是跨帧状态，所以直接报错。多传的尾部是编译器裁掉的，截掉。
  const setTyped = (name, l, info, v, full, remain) => {
    const s = SET.get(info.type);
    if (!s) throw new Error(`webfx: uniform ${name} 的类型 0x${info.type.toString(16)} 不认识`);
    const [comp, fn, Arr] = s;
    const a = flat(v);
    if (a.length === 0 || a.length % comp) throw new Error(`webfx: uniform ${name} 每个元素 ${comp} 个分量，收到 ${a.length} 个数`);
    let count = a.length / comp;
    if (full && count < remain) throw new Error(`webfx: uniform ${name} 是长度 ${remain} 的数组，只收到 ${count} 个元素。`
      + `没传到的元素会留着上一帧的值（跨帧状态）；每帧传满，或用 '${name}[k]' 显式只写某几个`);
    if (count > remain) { if (full) count = remain; else throw new Error(`webfx: ${name} 之后只剩 ${remain} 个元素，收到 ${count} 个`); }
    const buf = (a instanceof Arr && a.length === count * comp) ? a : Arr.from(a.length === count * comp ? a : Array.prototype.slice.call(a, 0, count * comp));
    if (fn.startsWith('uniformMatrix')) gl[fn](l, false, buf); else gl[fn](l, buf);
  };

  const setUniform = (name, v) => {
    const l = loc(name);
    if (l == null) return; // 着色器里没用到（会被编译器优化掉），静默跳过
    // 数组 uniform（`u_pts` 写整个数组，`u_pts[3]` 从第 3 个元素起写）以及旧路径不认识的类型（int / ivec / mat2 / uint / sampler）走反射
    const m = /^(.*)\[(\d+)\]$/.exec(name);
    const info = uinfo.get(m ? m[1] : name);
    if (info && (info.isArray || m)) return setTyped(name, l, info, v, !m, info.size - (m ? +m[2] : 0));
    if (info && !LEGACY.has(info.type) && info.type !== gl.BOOL) return setTyped(name, l, info, v, true, 1);
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (typeof v === 'boolean') gl.uniform1i(l, v ? 1 : 0);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    else if (v.length === 9) gl.uniformMatrix3fv(l, false, v);
    else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
    else throw new Error(`webfx: uniform ${name} 的值类型不认识`);
  };

  // 纹理：把 2D canvas / 图片喂给着色器。unit 按名字分配
  const textures = new Map();
  const isPOT = (n) => n > 0 && (n & (n - 1)) === 0;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const srcSize = (s) => [s.naturalWidth || s.videoWidth || s.width || 0, s.naturalHeight || s.videoHeight || s.height || 0];
  // "同一份内容"的判据：同一个源对象 + 同一个 key + 同尺寸 + 同 URL（img/video 换了 src 是同一个对象、不同内容）
  // + 同 currentTime（video）。与帧号、t 无关——所以命中与否只取决于内容来源，不取决于求值顺序。
  const ident = (s, key) => {
    const [w, h] = srcSize(s);
    return [s, key, w, h, s.currentSrc ?? s.src ?? null, typeof s.currentTime === 'number' ? s.currentTime : null];
  };
  const sameIdent = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  // 调试 / 验收开关：页面加载前设 globalThis.WEBFX_NOCACHE = true，所有声明了缓存的纹理改回每次都上传。
  // film-webfx 的 texcache-check.mjs 用它比"缓存版 vs 每次上传版"逐像素是否一致——缓存键漏了内容变化时只有这样抓得到。
  const noCache = () => globalThis.WEBFX_NOCACHE === true;

  /** 上传一张纹理。source 可以是 canvas / ImageBitmap / img / video。
   *  默认每次调用都上传（每帧内容变了就每帧调——上传是同步拷贝，代价见 compositing.md）。
   *  opts.static: true  —— 同一个源对象、尺寸/URL 没变就不再上传（内容在加载后不变的源：纸纹、预渲的底图、贴图）
   *  opts.key: 任意原始值 —— 同上，另外 key 变了才重传（调用方改了源的内容就 bump key；key 必须来自内容，不能来自 t）
   *  opts.mipmap: true  —— 上传后生成 mipmap，缩小采样走 LINEAR_MIPMAP_LINEAR（WebGL1 要求宽高都是 2 的幂）
   *  opts.anisotropy: n —— 各向异性过滤（EXT_texture_filter_anisotropic，斜看的平面用；没有扩展时忽略） */
  function texture(name, source, opts = {}) {
    const { filter = 'linear', wrap = 'clamp', mipmap = false, key, anisotropy = 0 } = opts;
    const cacheable = opts.static === true || key !== undefined;
    const params = `${filter}|${wrap}|${mipmap ? 1 : 0}|${anisotropy}`;
    let rec = textures.get(name);
    if (!rec) {
      rec = { tex: gl.createTexture(), unit: textures.size, params: null, ident: null };
      textures.set(name, rec);
    }
    gl.activeTexture(gl.TEXTURE0 + rec.unit);
    gl.bindTexture(gl.TEXTURE_2D, rec.tex);
    if (rec.params !== params) {
      const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      const minf = !mipmap ? f : filter === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR;
      const wr = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minf);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
      if (aniso && anisotropy > 0) {
        const mx = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropy, mx));
      }
      rec.params = params;
      rec.ident = null; // 参数变了（尤其是打开 mipmap）必须重传，才有 mip 层
    }
    const id = cacheable ? ident(source, key) : null;
    if (!(cacheable && !noCache() && sameIdent(rec.ident, id))) {
      if (mipmap && !o.webgl2) {
        const [sw, sh] = srcSize(source);
        if (!isPOT(sw) || !isPOT(sh)) throw new Error(`webfx: 纹理 ${name} 是 ${sw}×${sh}，WebGL1 只能给宽高都是 2 的幂的纹理生成 mipmap`
          + `（否则纹理不完整，采样全黑且不报错）。改用 webgl2:true，或把源画进 2 的幂尺寸的 canvas 再传`);
      }
      // 2D canvas 内部是预乘的；让驱动按预乘上传，着色器里拿到的就是预乘色，和输出约定一致
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      // 纹理坐标 v_uv 的原点在左下，canvas 的原点在左上：上传时翻转，着色器里就不用管
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
      rec.ident = id;
    }
    gl.useProgram(prog);
    const l = loc(name); // sampler 必须用 uniform1i，不能走 setUniform 的 1f 分支
    if (l != null) gl.uniform1i(l, rec.unit);
    return rec;
  }

  const seed = o.seed ?? 1;
  const period = o.period ?? 0;

  /** 画第 t 秒。uniforms 里的值每次都重新设，不依赖上一次调用留下的状态 */
  function render(t, uniforms = {}) {
    if (!Number.isFinite(t)) throw new Error(`webfx: render(t) 收到非法 t=${t}`);
    // 在 JS 里用 double 做取模，再交给 float32
    const ut = period > 0 ? ((t % period) + period) % period : t;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    setUniform('u_time', ut);
    setUniform('u_res', [w, h]);
    setUniform('u_seed', seed);
    for (const k in uniforms) setUniform(k, uniforms[k]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  /** 把着色器层合成进 2D context。尺寸不同就拉伸（scale<1 时即放大） */
  function drawTo(ctx, { x = 0, y = 0, width = o.width, height = o.height, smoothing = true } = {}) {
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = smoothing;
    if (smoothing) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x, y, width, height);
    ctx.imageSmoothingEnabled = prev;
  }

  /** 读回整层像素（调试 / 确定性测试用）。很慢：一次全帧拷贝 */
  function pixels() {
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  /** 阻塞到 GPU（这里是 SwiftShader 线程）真正画完。计时必须用它，否则只量到了提交命令的时间 */
  function finish() { const p = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); }

  return { canvas, gl, width: w, height: h, render, drawTo, texture, pixels, finish, setUniform };
}

// ---------------------------------------------------------------------------
// GLSL 片段库。都是纯函数，不碰时间——时间由调用方经 u_time 传入后自己组合。
// 写 WebGL1（GLSL ES 1.00）语法，WebGL2 下把 header 换成 GLSL.header2 即可共用。
// ---------------------------------------------------------------------------
export const GLSL = {
  header: `precision highp float;
varying vec2 v_uv;
uniform float u_time; uniform vec2 u_res; uniform float u_seed;
#define OUT gl_FragColor
#define TEX texture2D
`,
  header2: `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform float u_time; uniform vec2 u_res; uniform float u_seed;
#define OUT fragColor
#define TEX texture
`,

  // 整数风格的 hash 在 GLSL ES 1.00 里没有 uint，这里用 Dave Hoskins 的 hash without sine：
  // 不依赖 sin 的实现精度（sin 大参数在不同后端结果不同，是跨后端不一致的常见来源）
  hash: `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`,

  // 交错梯度噪声（Jimenez 2014）：屏幕坐标的纯函数、逐帧不变——抖动步进起点、旋转采样圈。带 include 守卫，可重复拼接
  ign: `
#ifndef FX_IGN
#define FX_IGN
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
#endif
`,

  // 整数哈希 pcg3d（Jarzynski & Olano 2020），只有整数运算。**GLSL ES 3.00**（three 的材质与 ShaderMaterial 都是）。
  // pcgHash33(p)：按 floor(p) 的格点取 [0,1)³。带 include 守卫：同一材质上叠几个补丁各自拼一次也不重定义
  pcg: `
#ifndef FX_PCG3D
#define FX_PCG3D
uvec3 pcg3d(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 pcgHash33(vec3 p){ return vec3(pcg3d(uvec3(ivec3(floor(p))))) * (1.0 / 4294967296.0); }
#endif
`,

  // value noise + fbm。需要 hash
  noise: `
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float vnoise3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.-2.*f);
  float a = mix(mix(hash13(i), hash13(i+vec3(1,0,0)), u.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y);
  return mix(a, b, u.z); }
float fbm(vec2 p){ float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = m * p; a *= .5; } return s; }
`,

  // 循环噪声：时间映射成圆上一点，t 走完 period 正好回到起点 → 首尾帧逐像素一致
  // 用法：loopNoise(p, u_time / PERIOD, 0.6)，phase ∈ [0,1)。r 越大一圈里变化越多。需要 noise
  loop: `
#define TAU 6.28318530718
float loopNoise(vec2 p, float phase, float r){ float a = TAU * phase; return vnoise3(vec3(p.x, p.y + r*sin(a), r*cos(a))); }
float loopFbm(vec2 p, float phase, float r){ float s = 0., amp = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){ s += amp * loopNoise(p, phase, r); p = m * p; amp *= .5; } return s; }
`,
};
