// fxchain.js —— 单个 WebGL2 context 里的多 pass 着色器管线 + 可任意 seek 的帧间反馈（ping-pong）。零依赖。
//
// 契约（违反就是 bug）：
//   - 时间只来自 render(t) 的参数；本文件不读时钟、不开 rAF、不用 Math.random。
//   - 普通 pass 的输出只取决于 (t, 这一帧传入的 uniform, 这一帧上传的纹理)。
//   - 反馈状态的定义：S(0) = init，S(k) = step(S(k-1), k)；render(t) 用的是 S(n)，n = round(time(t)·rate)·substeps。
//     检查点和"从当前位置往前推"只是这个定义的加速：往回 seek 从 ≤ n 的最近检查点重放到 n，
//     所以顺序、乱序、倒序、全新页面求值结果逐位相同（判据是门：seamcheck 1a/1b/2 和 fxreplay-check）。
//   - step 只能读 (上一步状态, 步号, 加载期确定的纹理, uniforms(k, s) 的返回值)。它读不到 render(t) 的 uniform：
//     那些是"第 t 秒"的值，重放第 k 步时用它们，结果就依赖这次 seek 的 t（跨帧状态）。
//   - 每个 pass 里着色器用到的非内置 uniform 每帧都必须传（缺一个就抛错）：GL 的 uniform 留着上一次设的值，
//     少传 = 用上一帧的值（跨帧状态），本文件也不替你补任何"默认值"（那是审美）。
//
// 用法见 references/fxchain.md。

import { GLSL } from './webfx.js';

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.,1.); }`;

// 逐位拷贝（texelFetch，不过滤）：检查点存取用。RGBA16F / RGBA32F / RGBA8 都是原值写回
const COPY = `#version 300 es
precision highp float;
uniform highp sampler2D u_src; out vec4 o;
void main(){ o = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

const BUILTIN = new Set(['u_time', 'u_res', 'u_seed']);
const STEP_BUILTIN = new Set(['u_time', 'u_res', 'u_seed', 'u_step', 'u_dt', 'u_prev', 'u_prev_size']);

/** WebGL2 片元头：与 webfx.js 的 GLSL.header2 相同（OUT / TEX 宏、u_time / u_res / u_seed）。 */
export const HEADER = GLSL.header2;

/**
 * @param {object} o
 * @param {number} o.width  目标宽（主画布像素）
 * @param {number} o.height 目标高
 * @param {number} [o.scale=1]  输出 canvas（screen pass）的分辨率倍率
 * @param {number} [o.seed=1]   → u_seed
 * @param {number} [o.period=0] >0 时普通 pass 的 u_time = t mod period（反馈不受影响，见 fxchain.md）
 * @param {'error'|'rgba8'} [o.floatFallback='error'] 浮点目标不可渲染时：抛错，或降成 rgba8 并记进 chain.formats
 * @param {Array}  o.passes   [{ name, frag, out='screen'|目标名, scale=1|[sx,sy], format='rgba8'|'rgba16f'|'rgba32f',
 *                              filter='linear'|'nearest', wrap='clamp'|'repeat'|'mirror', in:{u_x: 来源名}, uniforms:{常量} }]
 * @param {Array}  [o.feedback] [{ name, frag(step), init(frag，可省=全 0), scale, format, filter, wrap,
 *                              rate(每仿真秒几次查询), substeps=1, every(检查点间隔，仿真秒), maxCheckpoints=Infinity,
 *                              time:(t)=>仿真秒（默认 t）, in:{u_x: 加载期纹理名}, uniforms:(k, s)=>({...}) 或常量对象 }]
 * @param {string} [o.leak] 只给阴性对照用：'noreplay'（往回 seek 不重放，直接用上次留下的纹理）/ 'ref'（检查点存引用）
 */
export function createChain(o) {
  const scale = o.scale ?? 1;
  const W = o.width, H = o.height;
  const cw = Math.max(1, Math.round(W * scale)), ch = Math.max(1, Math.round(H * scale));
  const canvas = document.createElement('canvas');   // 每种 context 一个新 canvas
  canvas.width = cw; canvas.height = ch;
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('fxchain: 取不到 webgl2 context（fxchain 只支持 WebGL2；同一个 canvas 取过 webgl 也会这样）');

  // ---- 能力探测 ----
  const caps = {
    float32: !!gl.getExtension('EXT_color_buffer_float'),
    float16: false,
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    units: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
  };
  caps.float16 = caps.float32 || !!gl.getExtension('EXT_color_buffer_half_float');
  const FMT = {
    rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
    rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
  };
  const formats = {};   // 名字 → { asked, got, filter, note }
  const fallback = o.floatFallback ?? 'error';
  function pickFormat(name, asked = 'rgba8', filter = 'linear') {
    if (!FMT[asked]) throw new Error(`fxchain: ${name} 的 format "${asked}" 不认识（rgba8 / rgba16f / rgba32f）`);
    let got = asked, note = null;
    const ok = asked === 'rgba8' || (asked === 'rgba16f' ? caps.float16 : caps.float32);
    if (!ok) {
      const why = `${asked} 不可渲染（缺 ${asked === 'rgba16f' ? 'EXT_color_buffer_half_float / EXT_color_buffer_float' : 'EXT_color_buffer_float'}）`;
      if (fallback !== 'rgba8') throw new Error(`fxchain: ${name} 要 ${why}。传 floatFallback:'rgba8' 才降级（降级后 HDR 截断到 [0,1]、每通道 8 位，反应扩散这类小增量迭代会停住）`);
      got = 'rgba8'; note = `${why}，已降为 rgba8`;
    }
    let f = filter;
    if (got === 'rgba32f' && f === 'linear' && !caps.floatLinear) { f = 'nearest'; note = (note ? note + '；' : '') + 'rgba32f 不可线性过滤（缺 OES_texture_float_linear），已改 nearest'; }
    formats[name] = { asked, got, filter: f, note };
    return [got, f];
  }

  // ---- 编译 ----
  const compile = (type, src, label) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      throw new Error(`fxchain: ${label} 着色器编译失败\n${gl.getShaderInfoLog(s)}\n${numbered}`);
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT, 'vertex');
  function program(frag, label) {
    if (!/^\s*#version 300 es/.test(frag)) throw new Error(`fxchain: ${label} 的着色器要以 #version 300 es 开头（拼 HEADER）`);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag, label));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`fxchain: ${label} link 失败 ${gl.getProgramInfoLog(p)}`);
    const uni = new Map();   // 名字 → { loc, type, size, isArray, sampler }
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const a = gl.getActiveUniform(p, i); if (!a) continue;
      const isArray = a.name.endsWith('[0]');
      const name = isArray ? a.name.slice(0, -3) : a.name;
      uni.set(name, { loc: gl.getUniformLocation(p, a.name), type: a.type, size: a.size, isArray, sampler: SAMPLERS.has(a.type) });
    }
    return { p, uni, label };
  }
  const SAMPLERS = new Set(['SAMPLER_2D', 'SAMPLER_3D', 'SAMPLER_CUBE', 'SAMPLER_2D_ARRAY', 'INT_SAMPLER_2D', 'UNSIGNED_INT_SAMPLER_2D'].map((k) => gl[k]));
  const SET = new Map([
    [gl.FLOAT, [1, 'uniform1fv']], [gl.FLOAT_VEC2, [2, 'uniform2fv']], [gl.FLOAT_VEC3, [3, 'uniform3fv']], [gl.FLOAT_VEC4, [4, 'uniform4fv']],
    [gl.INT, [1, 'uniform1iv']], [gl.INT_VEC2, [2, 'uniform2iv']], [gl.INT_VEC3, [3, 'uniform3iv']], [gl.INT_VEC4, [4, 'uniform4iv']],
    [gl.BOOL, [1, 'uniform1iv']], [gl.BOOL_VEC2, [2, 'uniform2iv']], [gl.BOOL_VEC3, [3, 'uniform3iv']], [gl.BOOL_VEC4, [4, 'uniform4iv']],
    [gl.UNSIGNED_INT, [1, 'uniform1uiv']],
    [gl.FLOAT_MAT2, [4, 'uniformMatrix2fv']], [gl.FLOAT_MAT3, [9, 'uniformMatrix3fv']], [gl.FLOAT_MAT4, [16, 'uniformMatrix4fv']],
  ]);
  const flat = (v, name) => {
    if (typeof v === 'number' || typeof v === 'boolean') return [+v];
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (Array.isArray(v)) return v.flatMap((e) => (Array.isArray(e) || ArrayBuffer.isView(e) ? Array.from(e, Number) : [+e]));
    throw new Error(`fxchain: uniform ${name} 的值不认识：${String(v)}`);
  };
  function setU(P, name, v) {
    const u = P.uni.get(name);
    if (!u) return false;
    const s = SET.get(u.type);
    if (!s) throw new Error(`fxchain: ${P.label} 的 uniform ${name} 类型 0x${u.type.toString(16)} 不支持直接设置`);
    const [comp, fn] = s, a = flat(v, name);
    if (a.some((x) => !Number.isFinite(x))) throw new Error(`fxchain: ${P.label} 的 uniform ${name} 收到非有限数 ${JSON.stringify(v)}`);
    if (a.length !== comp * u.size) throw new Error(`fxchain: ${P.label} 的 uniform ${name} 要 ${u.size} 个元素×${comp} 分量 = ${comp * u.size} 个数，收到 ${a.length} 个`
      + (u.size > 1 ? '（数组每帧传满：没传到的元素会留着上一帧的值）' : ''));
    const buf = fn.includes('ui') ? new Uint32Array(a) : fn.endsWith('iv') ? new Int32Array(a) : new Float32Array(a);
    if (fn.startsWith('uniformMatrix')) gl[fn](u.loc, false, buf); else gl[fn](u.loc, buf);
    return true;
  }

  // ---- 几何：一个盖满屏幕的大三角形 ----
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ---- 渲染目标 ----
  const WRAP = { clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT };
  const dims = (sc) => {
    const [sx, sy] = Array.isArray(sc) ? sc : [sc ?? 1, sc ?? 1];
    return [Math.max(1, Math.round(W * sx)), Math.max(1, Math.round(H * sy))];
  };
  let bytes = 0;
  const BPP = { rgba8: 4, rgba16f: 8, rgba32f: 16 };
  function makeTarget(w, h, fmt, filter, wrap) {
    if (w > caps.maxTexture || h > caps.maxTexture) throw new Error(`fxchain: 目标 ${w}×${h} 超过 MAX_TEXTURE_SIZE ${caps.maxTexture}`);
    const [ifmt] = FMT[fmt];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, WRAP[wrap] ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, WRAP[wrap] ?? gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`fxchain: ${fmt} ${w}×${h} 的帧缓冲不完整（0x${st.toString(16)}）`);
    bytes += w * h * BPP[fmt];
    return { tex, fbo, w, h, fmt };
  }
  const freeTarget = (T) => { gl.deleteTexture(T.tex); gl.deleteFramebuffer(T.fbo); bytes -= T.w * T.h * BPP[T.fmt]; };

  // ---- 外部纹理（2D canvas / 图片 / 数据 / 3D LUT） ----
  const ext = new Map();   // 名字 → { tex, target: TEXTURE_2D|TEXTURE_3D, w, h, ident, loadTime, uploadedThisFrame }
  const noCache = () => globalThis.WEBFX_NOCACHE === true;   // 与 webfx.js 同一个开关：texcache-check 用它
  const srcSize = (s) => [s.naturalWidth || s.videoWidth || s.width || 0, s.naturalHeight || s.videoHeight || s.height || 0];
  const ident = (s, key) => { const [w, h] = srcSize(s); return [s, key, w, h, s.currentSrc ?? s.src ?? null, typeof s.currentTime === 'number' ? s.currentTime : null]; };
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  let frameNo = 0;   // 第几次 render：只用来判断"这张纹理是不是本次 render 前刚上传的"，不进任何像素

  /** 把 2D canvas / 图片 / video 上传成名字为 name 的输入。语义与 webfx.js 的 texture() 相同（static / key / WEBFX_NOCACHE）。
   *  没有 static/key 的纹理是"这一帧的内容"：每次 render 前都要重新调，否则 render 抛错（防止读到上一帧的画面）。 */
  function texture(name, source, opts = {}) {
    const { filter = 'linear', wrap = 'clamp', key } = opts;
    const cacheable = opts.static === true || key !== undefined;
    let r = ext.get(name);
    if (r && r.kind !== 'image') throw new Error(`fxchain: 纹理名 ${name} 已用于 ${r.kind}`);
    if (!r) { r = { kind: 'image', tex: gl.createTexture(), target: gl.TEXTURE_2D, ident: null, params: null }; ext.set(name, r); }
    gl.bindTexture(gl.TEXTURE_2D, r.tex);
    const params = `${filter}|${wrap}`;
    if (r.params !== params) {
      const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, WRAP[wrap]); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, WRAP[wrap]);
      r.params = params; r.ident = null;
    }
    const id = cacheable ? ident(source, key) : null;
    if (!(cacheable && !noCache() && same(r.ident, id))) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // 2D canvas 是预乘的
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);              // v_uv 原点在左下
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      r.ident = id;
    }
    [r.w, r.h] = srcSize(source);
    r.loadTime = cacheable;            // 声明了 static/key 的才算"加载期确定"，反馈 step 只许读这类
    r.stamp = frameNo + 1;   // 供下一次 render 用
    return r;
  }

  /** 浮点/整数数据纹理（加载期确定）：data 长度 = width·height·4，第 0 行在 v=0（下边）。format 'rgba32f' | 'rgba16f' | 'rgba8' */
  function data(name, { width, height, data: arr, format = 'rgba32f', filter = 'nearest', wrap = 'clamp' }) {
    if (ext.has(name)) throw new Error(`fxchain: 纹理名 ${name} 已存在（数据纹理加载期只建一次）`);
    if (arr.length !== width * height * 4) throw new Error(`fxchain: data(${name}) 长度 ${arr.length} ≠ ${width}×${height}×4`);
    const [ifmt, f] = FMT[format];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const fl = filter === 'nearest' || (format === 'rgba32f' && !caps.floatLinear) ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fl); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, WRAP[wrap]); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, WRAP[wrap]);
    const buf = format === 'rgba8' ? Uint8Array.from(arr, (x) => Math.max(0, Math.min(255, Math.round(x * 255)))) : new Float32Array(arr);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, width, height, 0, f, format === 'rgba8' ? gl.UNSIGNED_BYTE : gl.FLOAT, buf);
    ext.set(name, { kind: 'data', tex, target: gl.TEXTURE_2D, w: width, h: height, loadTime: true });
  }

  /** 3D LUT（parseCube 的结果）→ RGBA16F 3D 纹理，硬件三线性插值。着色器里 `uniform highp sampler3D u_lut;` */
  function lut(name, cube) {
    if (ext.has(name)) throw new Error(`fxchain: 纹理名 ${name} 已存在`);
    const n = cube.size, src = cube.data, rgba = new Float32Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) { rgba[i * 4] = src[i * 3]; rgba[i * 4 + 1] = src[i * 3 + 1]; rgba[i * 4 + 2] = src[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // .cube 的数据顺序是 r 最快、b 最慢 → 正好是 3D 纹理的 x / y / z
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, rgba);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    ext.set(name, { kind: 'lut', tex, target: gl.TEXTURE_3D, w: n, h: n, loadTime: true, size: n });
  }

  // ---- 普通 pass ----
  const targets = new Map();   // 目标名 → target
  const passes = (o.passes ?? []).map((p, i) => {
    const name = p.name ?? `pass${i}`;
    const out = p.out ?? 'screen';
    const P = program(p.frag, name);
    for (const [u, src] of Object.entries(p.in ?? {})) {
      if (!P.uni.has(u)) throw new Error(`fxchain: pass ${name} 的 in.${u} 在着色器里没有（或被编译器优化掉了）`);
      if (src === out) throw new Error(`fxchain: pass ${name} 同时读写 ${out}。要"读上一帧的自己"就是反馈：放进 feedback（会定步重放），不要在 passes 里做`);
    }
    if (out !== 'screen') {
      const [w, h] = dims(p.scale);
      if (targets.has(out)) {
        const T = targets.get(out);
        if (T.w !== w || T.h !== h) throw new Error(`fxchain: 目标 ${out} 被两个 pass 以不同尺寸写`);
      } else {
        const [fmt, filter] = pickFormat(out, p.format, p.filter);
        targets.set(out, makeTarget(w, h, fmt, filter, p.wrap));
      }
    }
    return { name, out, P, in: p.in ?? {}, uniforms: p.uniforms ?? {} };
  });
  const names = new Set(passes.map((p) => p.name));
  if (names.size !== passes.length) throw new Error('fxchain: pass 名字重复');

  // ---- 反馈 ----
  const fbs = new Map();
  const copyP = program(COPY, 'copy');
  for (const f of o.feedback ?? []) {
    const name = f.name;
    if (!name) throw new Error('fxchain: feedback 要有 name');
    if (targets.has(name) || fbs.has(name)) throw new Error(`fxchain: 名字 ${name} 重复`);
    if (!(f.rate > 0)) throw new Error(`fxchain: feedback ${name} 要给 rate（每仿真秒几次查询，与影片 fps 无关）`);
    if (!(f.every > 0)) throw new Error(`fxchain: feedback ${name} 要给 every（检查点间隔，仿真秒）`);
    const [w, h] = dims(f.scale);
    const [fmt, filter] = pickFormat(name, f.format, f.filter ?? 'nearest');
    const substeps = f.substeps ?? 1;
    const S = {
      name, w, h, fmt, filter, wrap: f.wrap ?? 'clamp', rate: f.rate, substeps,
      dt: 1 / (f.rate * substeps),
      every: Math.max(1, Math.round(f.every * f.rate * substeps)),
      maxCp: f.maxCheckpoints ?? Infinity,
      time: f.time ?? ((t) => t),
      step: program(f.frag, `${name}.step`),
      init: f.init ? program(f.init, `${name}.init`) : null,
      in: f.in ?? {}, uniforms: f.uniforms ?? {},
      ping: [makeTarget(w, h, fmt, filter, f.wrap), makeTarget(w, h, fmt, filter, f.wrap)],
      cur: 0, curN: -1, cps: new Map(),
      stats: { steps: 0, restores: 0, inits: 0, lastN: -1 },
    };
    if (!S.step.uni.has('u_prev')) throw new Error(`fxchain: feedback ${name} 的 step 着色器没用 u_prev（上一步的状态），那就不是反馈`);
    fbs.set(name, S);
  }
  if (o.leak && !['noreplay', 'ref'].includes(o.leak)) throw new Error(`fxchain: leak "${o.leak}" 不认识`);
  const noReplayCache = () => globalThis.FXCHAIN_NOCACHE === true;   // fxreplay-check 用：每次都从第 0 步算（定义本身）

  // 绑定一个 pass 的输入。返回实际用的纹理单元数
  function bindInputs(P, inputs, ctx) {
    let unit = 0;
    for (const [u, srcName] of Object.entries(inputs)) {
      const info = P.uni.get(u);
      let tex, target = gl.TEXTURE_2D, w, h;
      if (fbs.has(srcName)) {
        if (ctx.step) throw new Error(`fxchain: ${P.label} 读另一路反馈 ${srcName}：不支持（两路反馈要合成一路的 RGBA 通道）`);
        const S = fbs.get(srcName), T = S.ping[S.cur]; tex = T.tex; w = T.w; h = T.h;
      } else if (targets.has(srcName)) {
        if (ctx.step) throw new Error(`fxchain: 反馈 step ${P.label} 读了 pass 目标 ${srcName}：那是"第 t 秒"的画面，重放第 k 步时会用错（跨帧状态）。step 只能读加载期确定的纹理`);
        if (!ctx.written.has(srcName)) throw new Error(`fxchain: ${P.label} 读 ${srcName}，但这次 render 里还没有 pass 写它：会读到上一帧留下的内容（跨帧状态）。调整 passes 顺序`);
        const T = targets.get(srcName); tex = T.tex; w = T.w; h = T.h;
      } else if (ext.has(srcName)) {
        const r = ext.get(srcName);
        if (ctx.step && !r.loadTime) throw new Error(`fxchain: 反馈 step ${P.label} 读了每帧上传的纹理 ${srcName}：重放时它是"这次 seek 的画面"不是"第 k 步的画面"。只读 static/key/data/lut 纹理，随时间变的输入算进 uniforms(k, s)`);
        if (!ctx.step && !r.loadTime && r.stamp !== frameNo) throw new Error(`fxchain: 纹理 ${srcName} 不是本次 render 前上传的（没声明 static/key 的纹理每帧都要重新 texture()，否则是上一帧的画面）`);
        tex = r.tex; target = r.target; w = r.w; h = r.h;
      } else throw new Error(`fxchain: ${P.label} 的输入 ${u} ← "${srcName}" 不存在（不是目标、反馈，也没有 texture()/data()/lut() 过）`);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
      gl.uniform1i(info.loc, unit);
      setU(P, `${u}_size`, [w, h]);
      unit++;
    }
    return unit;
  }

  // 强制全量：着色器里用到的非内置、非 sampler uniform 必须在 given 里
  function requireAll(P, given, builtin, inputs, where) {
    const miss = [];
    for (const [n, u] of P.uni) {
      if (builtin.has(n) || u.sampler || n in given) continue;
      const base = n.endsWith('_size') ? n.slice(0, -5) : null;
      if (base && base in inputs) continue;
      miss.push(n);
    }
    if (miss.length) throw new Error(`fxchain: ${P.label} 这一帧没传 ${miss.join(', ')}（${where}）。`
      + `每帧全量传：不传 = 沿用上一帧的值（跨帧状态）；本运行时不提供默认值，它们由本片 style_guide 定`);
    for (const [n, u] of P.uni) if (u.sampler && !builtin.has(n) && !(n in inputs)) throw new Error(`fxchain: ${P.label} 的 sampler ${n} 没在 in 里接来源`);
  }

  function draw(P, T, u, inputs, ctx, builtin, where) {
    gl.useProgram(P.p);
    if (T) { gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo); gl.viewport(0, 0, T.w, T.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch); }
    requireAll(P, u, builtin, inputs, where);
    for (const k in u) setU(P, k, u[k]);
    bindInputs(P, inputs, ctx);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // copy 走一条专用的绑定（不经名字表）
  function copy(src, dst) {
    gl.useProgram(copyP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(copyP.uni.get('u_src').loc, 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function stepUniforms(S, k) {
    const s = k * S.dt;
    const u = typeof S.uniforms === 'function' ? S.uniforms(k, s) : S.uniforms;
    return { ...u, u_time: s, u_step: k, u_dt: S.dt, u_res: [S.w, S.h], u_seed: seed };
  }
  function doInit(S) {
    const T = S.ping[S.cur];
    if (S.init) draw(S.init, T, stepUniforms(S, 0), S.in, { step: true }, STEP_BUILTIN, `${S.name}.init`);
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    S.curN = 0; S.stats.inits++;
  }
  // 一步：u_prev 接上一步的状态（单元号排在 in 之后），画进另一张 ping-pong
  function stepOnce(S) {
    const k = S.curN + 1;
    const src = S.ping[S.cur], dst = S.ping[1 - S.cur];
    const P = S.step, u = stepUniforms(S, k);
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
    requireAll(P, u, STEP_BUILTIN, S.in, `${S.name} 的 uniforms(k, s)`);
    for (const key in u) setU(P, key, u[key]);
    const unit = bindInputs(P, S.in, { step: true });
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(P.uni.get('u_prev').loc, unit);
    setU(P, 'u_prev_size', [src.w, src.h]);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    S.cur = 1 - S.cur; S.curN = k; S.stats.steps++;
    if (!noReplayCache() && k % S.every === 0 && !S.cps.has(k)) saveCp(S, k);
  }
  function saveCp(S, k) {
    if (o.leak === 'ref') { S.cps.set(k, S.ping[S.cur]); return; }   // 故意的 bug：存引用，下一步就被覆盖
    const T = makeTarget(S.w, S.h, S.fmt, S.filter, S.wrap);
    copy(S.ping[S.cur], T);
    S.cps.set(k, T);
    // 稀疏化：超过上限就把间隔翻倍、丢掉不在新间隔上的检查点（第 0 步永远留着）。
    // 留哪些检查点取决于走过哪些步，但每个检查点都是 S(k) 的逐位副本，所以只影响重放快慢，不影响像素。
    while (S.cps.size > S.maxCp) {
      S.every *= 2;
      for (const [kk, TT] of S.cps) if (kk !== 0 && kk % S.every !== 0) { if (TT !== S.ping[0] && TT !== S.ping[1]) freeTarget(TT); S.cps.delete(kk); }
    }
  }
  function stateTo(S, n) {
    S.stats.lastN = n;
    if (noReplayCache()) { S.cur = 0; doInit(S); while (S.curN < n) stepOnce(S); return; }
    if (S.curN < 0) {
      doInit(S);
      if (o.leak === 'ref') S.cps.set(0, S.ping[S.cur]);
      else { const T = makeTarget(S.w, S.h, S.fmt, S.filter, S.wrap); copy(S.ping[S.cur], T); S.cps.set(0, T); }
    }
    if (n < S.curN) {
      if (o.leak === 'noreplay') return;   // 故意的 bug：往回跳时不回退，直接用上一次 seek 留下的状态
      let k = 0;
      for (const kk of S.cps.keys()) if (kk <= n && kk > k) k = kk;
      copy(S.cps.get(k), S.ping[S.cur]);
      S.curN = k; S.stats.restores++;
    }
    while (S.curN < n) stepOnce(S);
  }

  const seed = o.seed ?? 1;
  const period = o.period ?? 0;
  const stepAt = (name, t) => { const S = fbs.get(name); return Math.max(0, Math.round(S.time(t) * S.rate)) * S.substeps; };

  /** 画第 t 秒：先把每路反馈推进/重放到 n(t)，再按顺序跑 passes。uniforms 每帧全量；值为普通对象且键是 pass 名时只给那个 pass */
  function render(t, uniforms = {}) {
    if (!Number.isFinite(t)) throw new Error(`fxchain: render(t) 收到非法 t=${t}`);
    frameNo++;
    for (const S of fbs.values()) stateTo(S, stepAt(S.name, t));
    const ut = period > 0 ? ((t % period) + period) % period : t;
    const global = {}, scoped = {};
    for (const k in uniforms) {
      const v = uniforms[k];
      if (names.has(k) && v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) scoped[k] = v;
      else global[k] = v;
    }
    const ctx = { step: false, written: new Set() };
    let screen = false;
    for (const p of passes) {
      const T = p.out === 'screen' ? null : targets.get(p.out);
      const u = { ...p.uniforms, ...global, ...(scoped[p.name] ?? {}), u_time: ut, u_res: T ? [T.w, T.h] : [cw, ch], u_seed: seed };
      // 只设这个 pass 用得到的：global 里别的 pass 的参数不算缺
      const own = {};
      for (const k in u) if (p.P.uni.has(k)) own[k] = u[k];
      draw(p.P, T, own, p.in, ctx, BUILTIN, `pass ${p.name}`);
      if (T) ctx.written.add(p.out); else screen = true;
    }
    if (!screen && passes.length) throw new Error('fxchain: 没有 out:"screen" 的 pass，canvas 上什么都没画');
    return canvas;
  }

  function drawTo(c2d, { x = 0, y = 0, width = W, height = H, smoothing = true } = {}) {
    const prev = c2d.imageSmoothingEnabled;
    c2d.imageSmoothingEnabled = smoothing;
    if (smoothing) c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(canvas, x, y, width, height);
    c2d.imageSmoothingEnabled = prev;
  }

  /** 读回像素（调试用，慢）：不给 name 读 canvas（Uint8）；给目标/反馈名读那张纹理（浮点目标返回 Float32Array） */
  function pixels(name) {
    let T = null;
    if (name) T = targets.get(name) ?? (fbs.has(name) ? fbs.get(name).ping[fbs.get(name).cur] : null);
    if (name && !T) throw new Error(`fxchain: pixels(${name})：没有这个目标`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T ? T.fbo : null);
    const w = T ? T.w : cw, h = T ? T.h : ch;
    const isF = T && T.fmt !== 'rgba8';
    const out = isF ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, isF ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
  function finish() { const p = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); }

  const stats = () => ({
    bytes,
    feedback: Object.fromEntries([...fbs].map(([n, S]) => [n, { ...S.stats, curN: S.curN, checkpoints: S.cps.size, every: S.every, dt: S.dt }])),
  });

  // 给 fxreplay-check 看"这一页有几路反馈、走了多少步"（只读统计，不进像素）
  if (fbs.size) (globalThis.__FXCHAIN__ ??= []).push(stats);
  return { canvas, gl, width: cw, height: ch, caps, formats, render, drawTo, texture, data, lut, pixels, finish, stats, stepAt };
}

/** 单 pass 便捷封装：与 createShaderLayer 同形（render / drawTo / texture），但走 fxchain 的"每帧全量传参"检查。
 *  in 写法同 passes：{ u_src: 'src' }，再在 render 前 fx.texture('src', canvas)。 */
export function createPass(o) {
  return createChain({ ...o, passes: [{ name: 'main', frag: o.frag, in: o.in ?? {}, uniforms: o.uniforms ?? {} }] });
}

/** 解析 .cube（Adobe/Resolve 3D LUT 文本）。只支持 LUT_3D_SIZE 与 [0,1] 定义域；1D LUT 和别的定义域抛错。
 *  返回 { title, size, data: Float32Array(size³·3) }，r 变化最快（与文件顺序相同） */
export function parseCube(text) {
  let size = 0, title = '';
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([A-Z_0-9]+)\s+(.*)$/.exec(line);
    if (m && /^[A-Z]/.test(m[1])) {
      const [, k, v] = m;
      if (k === 'TITLE') title = v.replace(/^"|"$/g, '');
      else if (k === 'LUT_3D_SIZE') size = parseInt(v, 10);
      else if (k === 'LUT_1D_SIZE') throw new Error('parseCube: 1D LUT 不支持（只做 3D）');
      else if (k === 'DOMAIN_MIN' || k === 'DOMAIN_MAX') {
        const d = v.split(/\s+/).map(Number), want = k === 'DOMAIN_MIN' ? 0 : 1;
        if (d.some((x) => x !== want)) throw new Error(`parseCube: ${k} ${v} 不支持（只支持 [0,1] 定义域）`);
      }
      continue;
    }
    const nums = line.split(/\s+/).map(Number);
    if (nums.length !== 3 || nums.some((x) => !Number.isFinite(x))) throw new Error(`parseCube: 看不懂这一行 "${raw}"`);
    vals.push(...nums);
  }
  if (!(size >= 2)) throw new Error('parseCube: 没有 LUT_3D_SIZE');
  if (vals.length !== size ** 3 * 3) throw new Error(`parseCube: LUT_3D_SIZE ${size} 要 ${size ** 3} 行，读到 ${vals.length / 3}`);
  return { title, size, data: new Float32Array(vals) };
}

/** 3D LUT 摊平成 2D 条带 canvas（宽 size²、高 size，8 位），给 WebGL1 / createShaderLayer 用（模板 lut_strip）。
 *  按 webfx texture() 会做 FLIP_Y 的约定摆：g=0 在最底一行。8 位条带的代价见 references/stylize.md */
export function cubeCanvas(cube) {
  const n = cube.size, c = document.createElement('canvas');
  c.width = n * n; c.height = n;
  const x = c.getContext('2d'), img = x.createImageData(n * n, n);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const i = ((b * n + g) * n + r) * 3, px = ((n - 1 - g) * n * n + b * n + r) * 4;
    img.data[px] = Math.round(cube.data[i] * 255); img.data[px + 1] = Math.round(cube.data[i + 1] * 255);
    img.data[px + 2] = Math.round(cube.data[i + 2] * 255); img.data[px + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}
