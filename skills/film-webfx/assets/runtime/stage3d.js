// stage3d.js —— three.js 场景按帧契约求值：seek(t) 从 t 算出全部状态，renderer.render() 一次。
//
// 依赖同目录的 three-film.module.js（three.js 的帧契约版，见 film-webfx/scripts/vendor-three.mjs：
// Clock / Timer / setAnimationLoop / Math.random 系列用到就抛错）。
//
// three 是**保留式**场景图：对象的属性一旦改了就一直留着。这正是跨帧状态最容易溜进来的地方——
// seek(5) 把某个物体 visible=false，seek(2) 没写 visible，它在 t=2 就也是隐藏的，取决于上一帧是谁。
// 所以舞台默认做一件事：**每帧开头把整棵树复位到 freeze() 那一刻的样子**（位置/朝向/缩放/可见性/
// 渲染顺序/形变权重、灯光与相机的标量和颜色、材质的标量/颜色/贴图引用/uniform 值、雾、背景）。
// 这一帧没写的属性就回到静止值，不会继承上一帧——和 Theatre.js "没上时间轴的属性取静态值" 是同一个思路。
// 代价：每帧遍历一次场景（几百个对象 < 0.1 ms，见 bench3d.mjs）。关掉：createStage3D({ reset:false })，
// 那就得自己保证每个动画属性每帧都写。
//
// 用法：
//   import { createStage3D, THREE } from './runtime/stage3d.js';
//   const S = createStage3D({ canvas: stage, width: L.width, height: L.height });
//   S.scene.add(mesh); ...                      // 加载期搭场景
//   S.freeze();                                  // 记下静止姿态（之后不许再 add/remove）
//   window.seek = A.install((t) => S.frame(t, () => {
//     applyShot(S.camera, rig(t), S);            // 相机（camrig.js）
//     mesh.rotation.y = 0.4 * t;                 // 一切从 t 算
//     S.anchor(A, '主体', mesh);                  // 登记锚点：渲染之后按渲染用的矩阵投影
//   }, post && post.params(t)));
//
// 不做的事：不选材质、不打光、不给背景色。舞台只保证"同一个 t 画出同一帧"。

import * as THREE from './three-film.module.js';
export { THREE };

const SKIP_OBJ = new Set(['id', 'uuid', 'name', 'type', 'parent', 'children', 'matrix', 'matrixWorld', 'matrixWorldInverse',
  'projectionMatrix', 'projectionMatrixInverse', 'position', 'quaternion', 'rotation', 'scale', 'up', 'modelViewMatrix',
  'normalMatrix', 'layers', 'userData', 'animations', 'geometry', 'material', 'morphTargetInfluences', 'morphTargetDictionary',
  'shadow', 'target', 'view', 'skeleton', 'instanceMatrix', 'instanceColor', 'coordinateSystem', 'matrixWorldNeedsUpdate']);
const SKIP_MAT = new Set(['uuid', 'id', 'name', 'type', 'version', 'userData', 'defines', 'uniforms', 'uniformsGroups',
  'vertexShader', 'fragmentShader', 'extensions', 'glslVersion', 'defaultAttributeValues', 'index0AttributeName', 'clippingPlanes']);

const isMath = (v) => v && (v.isColor || v.isVector2 || v.isVector3 || v.isVector4 || v.isMatrix3 || v.isMatrix4 || v.isQuaternion || v.isEuler);

// 一个对象的"可复位属性"快照：原始值、数学对象（clone）、贴图/对象引用（只记引用）
function snapProps(obj, skip) {
  const rec = [];
  for (const k of Object.keys(obj)) {
    if (skip.has(k) || k.startsWith('_')) continue;
    const v = obj[k];
    if (v == null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') rec.push([k, 0, v]);
    else if (isMath(v)) rec.push([k, 1, v.clone()]);
    else if (v.isTexture || v.isFog || v.isObject3D) rec.push([k, 0, v]);   // 引用：换贴图/换雾会被复位
  }
  return rec;
}
function restoreProps(obj, rec) {
  for (const [k, kind, v] of rec) {
    if (kind === 1) { if (obj[k] && obj[k].copy) obj[k].copy(v); else obj[k] = v.clone(); }
    else obj[k] = v;
  }
}
function snapUniforms(u) {
  const rec = [];
  for (const k of Object.keys(u)) {
    const v = u[k].value;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') rec.push([k, 0, v]);
    else if (isMath(v)) rec.push([k, 1, v.clone()]);
    else if (v.isTexture) rec.push([k, 0, v]);
    else if (Array.isArray(v)) rec.push([k, 2, v.map((e) => (isMath(e) ? e.clone() : e))]);
    else if (ArrayBuffer.isView(v)) rec.push([k, 3, v.slice()]);
  }
  return rec;
}
function restoreUniforms(u, rec) {
  for (const [k, kind, v] of rec) {
    const slot = u[k];
    if (kind === 1) slot.value.copy(v);
    else if (kind === 2) { slot.value.length = v.length; v.forEach((e, i) => { if (isMath(e)) { if (slot.value[i]?.copy) slot.value[i].copy(e); else slot.value[i] = e.clone(); } else slot.value[i] = e; }); }
    else if (kind === 3) slot.value.set(v);
    else slot.value = v;
  }
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} [o.canvas]  画到哪个 canvas（不给就新建一个离屏的）。必须没取过别的 context
 * @param {number} o.width   目标宽（主画布像素）
 * @param {number} o.height  目标高
 * @param {number} [o.scale=1]       渲染分辨率倍率（软件渲染成本 ≈ 像素数，0.5 → 约 1/4）
 * @param {boolean} [o.antialias=false]  默认帧缓冲的 MSAA（不走后期时才有用；走后期用 createPost 的 samples）
 * @param {number[]} [o.clear=[0,0,0,0]]  清屏色 rgba（0–1）。透明 = 交给下面的 2D 层
 * @param {number} [o.toneMapping]   THREE.*ToneMapping，默认 NoToneMapping（不走后期时生效；走后期由 post 的最后一遍做）
 * @param {boolean} [o.shadows=false]
 * @param {boolean} [o.reset=true]   每帧开头复位到 freeze() 的静止姿态（见文件头）
 */
export function createStage3D(o) {
  for (const k of ['width', 'height']) if (!(o[k] > 0)) throw new Error(`stage3d: ${k} 必填且 > 0`);
  // 迭代小样（render --scale k）时内核注入 FILM.scale = k < 1：三维层跟着少画像素（SwiftShader 成本 ≈ 像素数）。
  // 定稿、seamcheck 门 1–4、deliver 永远是 1，这里与改动前逐字相同。锚点、legible 仍按不乘 k 的尺寸量（baseW/H）。
  const draftK = typeof FILM === 'object' && FILM && FILM.scale > 0 && FILM.scale < 1 ? FILM.scale : 1;
  const scale = (o.scale ?? 1) * draftK;
  const baseW = Math.max(1, Math.round(o.width * (o.scale ?? 1))), baseH = Math.max(1, Math.round(o.height * (o.scale ?? 1)));
  const w = Math.max(1, Math.round(o.width * scale)), h = Math.max(1, Math.round(o.height * scale));
  const canvas = o.canvas ?? document.createElement('canvas');
  canvas.width = baseW; canvas.height = baseH;
  // 画布在页面里且没写 CSS 尺寸时，布局尺寸 = 像素尺寸：缩像素前先钉住布局，否则截图框跟着缩一半
  const box = draftK < 1 && canvas.isConnected ? canvas.getBoundingClientRect() : null;
  canvas.width = w; canvas.height = h;
  if (box) {
    const b = canvas.getBoundingClientRect();
    if (Math.abs(b.width - box.width) > 0.5 || Math.abs(b.height - box.height) > 0.5) { canvas.style.width = `${box.width}px`; canvas.style.height = `${box.height}px`; }
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: !!o.antialias, alpha: true, premultipliedAlpha: true, depth: true, stencil: false,
      // 截图（CDP 从合成器取）和 drawImage 都要在 render 之后任意时刻拿得到这一帧
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
  } catch (e) {
    throw new Error(`stage3d: 取不到 webgl2 context（同一个 canvas 取过 2d / webgl 了吗？每种 context 要各自的 canvas）：${e.message}`);
  }
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = o.colorSpace ?? THREE.SRGBColorSpace;
  renderer.toneMapping = o.toneMapping ?? THREE.NoToneMapping;
  const clear = o.clear ?? [0, 0, 0, 0];
  renderer.setClearColor(new THREE.Color(clear[0], clear[1], clear[2]), clear[3] ?? 1);
  if (o.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = o.shadowType ?? THREE.PCFShadowMap; }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
  scene.add(camera);   // 相机进树：随 freeze 一起复位
  const resetOn = o.reset ?? true;

  let frozen = null;   // { objs:[{o,p,q,s,v,ro,up,mti,props,view}], mats:[{m,props,uni}], geos:[{g,dr}], count }
  let post = null;
  let inFrame = false;
  const queue = [];    // 本帧待登记的锚点（渲染之后用渲染用的矩阵投影）

  function collect() {
    const objs = [], mats = new Set(), geos = new Set();
    scene.traverse((ob) => {
      objs.push(ob);
      const m = ob.material;
      if (Array.isArray(m)) m.forEach((x) => mats.add(x)); else if (m) mats.add(m);
      if (ob.geometry) geos.add(ob.geometry);
    });
    return { objs, mats: [...mats], geos: [...geos] };
  }

  /** 记下静止姿态。加载期搭完场景后调一次；之后 seek 里不许 add/remove（会抛错）。 */
  function freeze() {
    const { objs, mats, geos } = collect();
    frozen = {
      count: objs.length, set: new Set(objs),
      objs: objs.map((ob) => ({
        o: ob, p: ob.position.clone(), q: ob.quaternion.clone(), s: ob.scale.clone(), up: ob.up.clone(),
        v: ob.visible, ro: ob.renderOrder, mti: ob.morphTargetInfluences ? ob.morphTargetInfluences.slice() : null,
        props: snapProps(ob, SKIP_OBJ), view: ob.isCamera && ob.view ? { ...ob.view } : null,
        tgt: ob.target && ob.target.isObject3D && !frozenHas(objs, ob.target) ? ob.target.position.clone() : null,
      })),
      mats: mats.map((m) => ({ m, props: snapProps(m, SKIP_MAT), uni: m.uniforms ? snapUniforms(m.uniforms) : null })),
      geos: geos.map((g) => ({ g, dr: { ...g.drawRange } })),
    };
    return frozen;
  }
  const frozenHas = (objs, x) => objs.includes(x);

  /** 复位到静止姿态。frame() 开头会替你调。 */
  function reset() {
    if (!frozen) throw new Error('stage3d: 还没 freeze()。加载期搭完场景后调 S.freeze()，记下静止姿态');
    for (const r of frozen.objs) {
      const ob = r.o;
      ob.position.copy(r.p); ob.quaternion.copy(r.q); ob.scale.copy(r.s); ob.up.copy(r.up);
      ob.visible = r.v; ob.renderOrder = r.ro;
      if (r.mti) { ob.morphTargetInfluences.length = r.mti.length; for (let i = 0; i < r.mti.length; i++) ob.morphTargetInfluences[i] = r.mti[i]; }
      restoreProps(ob, r.props);
      if (ob.isCamera) { ob.view = r.view ? { ...r.view } : null; }
      if (r.tgt) ob.target.position.copy(r.tgt);
    }
    for (const r of frozen.mats) { restoreProps(r.m, r.props); if (r.uni) restoreUniforms(r.m.uniforms, r.uni); }
    for (const r of frozen.geos) { r.g.drawRange.start = r.dr.start; r.g.drawRange.count = r.dr.count; }
  }

  function checkStructure() {
    let n = 0, stranger = null;
    scene.traverse((ob) => { n++; if (!stranger && !frozen.set.has(ob)) stranger = ob; });
    if (n !== frozen.count || stranger) {
      throw new Error(`stage3d: seek 里场景结构变了（freeze 时 ${frozen.count} 个对象，现在 ${n} 个${stranger ? `，多出 "${stranger.name || stranger.type}"` : ''}）。`
        + '在 seek 里 add/remove 是跨帧状态：下一帧还带着它。要出现/消失就在加载期加好，seek 里改 visible');
    }
  }

  /** 画一帧：渲染（有后期就走后期），然后处理本帧排队的锚点。postParams 是 createPost 那一帧的参数。 */
  function render(t, postParams) {
    if (!Number.isFinite(t)) throw new Error(`stage3d: render(t) 收到非法 t=${t}`);
    if (resetOn && frozen) checkStructure();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    scene.updateMatrixWorld();
    if (post) post.render(t, postParams);
    else {
      if (postParams !== undefined) throw new Error('stage3d: 没有 createPost 却传了后期参数');
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(scene, camera);
    }
    flushAnchors();
    if (legReg.size) measureLegible(t);
    return canvas;
  }

  /** seek 的标准形状：复位 → paint(t) 设置这一帧的一切 → 渲染 → 登记锚点。 */
  function frame(t, paint, postParams) {
    if (inFrame) throw new Error('stage3d: frame() 嵌套调用');
    inFrame = true;
    try {
      if (resetOn) reset();
      queue.length = 0;
      const pp = paint ? paint(t) : undefined;
      return render(t, postParams !== undefined ? postParams : pp);
    } finally { inFrame = false; queue.length = 0; }
  }

  // ---- 投影（和 renderer 用同一组矩阵：camera.projectionMatrix × matrixWorldInverse）----
  const _v = new THREE.Vector3(), _box = new THREE.Box3();
  const defRect = () => ({ x: 0, y: 0, w: baseW, h: baseH });   // 小样缩了像素也按原尺寸量：锚点坐标不随 --scale 变

  /** 世界点 → 屏幕（rect 坐标系的像素）。返回 { x, y, depth, behind }；depth = 到相机平面的距离 */
  function project(p, rect = defRect()) {
    camera.updateMatrixWorld();
    _v.set(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_v.z;
    _v.applyMatrix4(camera.projectionMatrix);
    return { x: rect.x + (_v.x * 0.5 + 0.5) * rect.w, y: rect.y + (0.5 - _v.y * 0.5) * rect.h, depth, behind: depth <= camera.near };
  }

  // 视空间里一组点（一个盒子的 8 角）→ 先对近平面裁剪（沿 12 条棱求交），再投影取外包
  const EDGES = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
  function boxScreen(corners, rect, acc) {
    const zn = -camera.near * (1 + 1e-6);
    const pts = corners.filter((c) => c.z <= zn);
    for (const [a, b] of EDGES) {
      const A = corners[a], B = corners[b];
      if ((A.z <= zn) !== (B.z <= zn)) { const s = (zn - A.z) / (B.z - A.z); pts.push(A.clone().lerp(B, s)); }
    }
    for (const q of pts) {
      _v.copy(q).applyMatrix4(camera.projectionMatrix);
      const X = rect.x + (_v.x * 0.5 + 0.5) * rect.w, Y = rect.y + (0.5 - _v.y * 0.5) * rect.h;
      acc.x0 = Math.min(acc.x0, X); acc.y0 = Math.min(acc.y0, Y); acc.x1 = Math.max(acc.x1, X); acc.y1 = Math.max(acc.y1, Y);
      acc.n++; acc.depth = Math.min(acc.depth, -q.z);
    }
  }
  const corners8 = (b, m) => {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m));
    return out;
  };

  /** 物体（含子树）在屏幕上的外包：各网格的包围盒 8 角 → 视空间 → 近平面裁剪 → 投影。
   *  mode:'vertices' 改为逐顶点投影（更贴身，O(顶点数)）。完全在相机后面 = 不登记（画不出来的东西没有框）。 */
  function screenBox(obj, { mode = 'box', rect = defRect() } = {}) {
    obj.updateWorldMatrix(true, true);
    camera.updateMatrixWorld();
    const acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, depth: Infinity };
    const view = new THREE.Matrix4();
    obj.traverseVisible((ob) => {
      const g = ob.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      view.multiplyMatrices(camera.matrixWorldInverse, ob.matrixWorld);
      if (mode === 'vertices' && !ob.isInstancedMesh && !ob.isPoints) {
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          _v.fromBufferAttribute(pos, i).applyMatrix4(view);
          if (_v.z > -camera.near) continue;
          const d = -_v.z;
          _v.applyMatrix4(camera.projectionMatrix);
          const X = rect.x + (_v.x * 0.5 + 0.5) * rect.w, Y = rect.y + (0.5 - _v.y * 0.5) * rect.h;
          acc.x0 = Math.min(acc.x0, X); acc.y0 = Math.min(acc.y0, Y); acc.x1 = Math.max(acc.x1, X); acc.y1 = Math.max(acc.y1, Y);
          acc.n++; acc.depth = Math.min(acc.depth, d);
        }
        return;
      }
      if (!g.boundingBox) g.computeBoundingBox();
      _box.copy(g.boundingBox);
      if (ob.isInstancedMesh) { if (!ob.boundingBox) ob.computeBoundingBox(); _box.copy(ob.boundingBox); }
      boxScreen(corners8(_box, view), rect, acc);
    });
    return acc.n ? acc : null;
  }

  function flushAnchors() {
    for (const q of queue) {
      if (q.kind === 'obj') {
        const b = screenBox(q.obj, q.opts);
        if (b) q.A.box(q.name, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, q.opts.meta);
      } else if (q.kind === 'box') {
        const acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0, depth: Infinity };
        boxScreen(corners8(q.box, camera.matrixWorldInverse), q.opts.rect ?? defRect(), acc);
        if (acc.n) q.A.box(q.name, acc.x0, acc.y0, acc.x1 - acc.x0, acc.y1 - acc.y0, q.opts.meta);
      } else {
        const p = project(q.p, q.opts.rect ?? defRect());
        if (p.behind) continue;
        const f = (q.opts.rect ?? defRect()).h * camera.projectionMatrix.elements[5] / 2;   // 焦距（像素）
        q.A.disc(q.name, p.x, p.y, Math.max(0.5, (q.r * f) / p.depth), q.opts.meta);
      }
    }
    queue.length = 0;
  }

  // 锚点：在 frame() 的 paint 里登记，渲染完成后用渲染用的矩阵投影进 film-core anchors.js 的锚点表（A）。
  // rect：舞台画布在锚点画布上占的矩形（像素）。舞台就是锚点画布时不用给。
  const needFrame = (what) => { if (!inFrame) throw new Error(`stage3d.${what}() 只能在 frame() 的 paint 里调（锚点出自这一次绘制）`); };
  /** 物体的屏幕外包 → A.box(name) */
  function anchor(A, name, obj, opts = {}) { needFrame('anchor'); queue.push({ kind: 'obj', A, name, obj, opts }); }
  /** 世界坐标的轴对齐盒子（粒子云在着色器里算位置时，登记闭式解保证它们待在里面的那个体积） */
  function anchorBox(A, name, box3, opts = {}) { needFrame('anchorBox'); queue.push({ kind: 'box', A, name, box: box3.clone(), opts }); }
  /** 世界点 + 世界半径 → A.disc(name) */
  function anchorPoint(A, name, p, r = 0, opts = {}) { needFrame('anchorPoint'); queue.push({ kind: 'pt', A, name, p: new THREE.Vector3(p.x ?? p[0], p.y ?? p[1], p.z ?? p[2]), r, opts }); }

  // ---- 世界里的字读不读得出（可选；不登记 = 不测、不装 window.legible，行为与没有这段时逐位相同）----
  // 字印在斜放的平面上、离相机远，投影后的字高 ≈ 字高 × sin(仰角) / 距离，还会沿基线被压扁。
  // 画面上"看得见"不等于"读得出"：锚点框照样在，字号拦截（fillText）抓不到贴图/几何里的字。
  // 所以在关键词的阅读时间窗里，用**渲染用的那组矩阵**量它投影后的样子：
  //   em      一个 em 方块在屏幕上的高（像素，rect 坐标系，默认 = 片子原生像素）。文字框上取样点，报最小的那个
  //   squash  em 方块投影的雅可比矩阵 [u v] 的奇异值之比 σmin/σmax ∈ (0,1]：1 = 没变形；
  //           只看比值、不看朝向，所以字在画面内转了个角度（roll）不算压扁，横着挤（yaw）和竖着挤（俯仰）同样算，切变也算。
  //           "投影后宽高比 / 原宽高比"会把竖挤（<1）和横挤（>1）报成两个方向，还会把 90° 转角算成压扁，所以没用它；aspect 照样报，供人看方向。
  // 登记在加载期做一次（登记表是常量，不是跨帧状态）；测量在每次 render 之后，只测 t 落在 [from, to] 里的字。
  const legReg = new Map();          // name -> { obj, from, to, box:[x0,y0,x1,y1] 局部, em 局部, rect }
  let legTable = null;               // 最近一次 render 的测量表 { t, items }
  const R4 = (v) => Math.round(v * 1e4) / 1e4;
  const _a = new THREE.Vector3(), _m = new THREE.Matrix4();
  function measureLegible(t) {
    const items = {};
    const P = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    for (const [name, r] of legReg) {
      if (!(t >= r.from - 1e-9 && t <= r.to + 1e-9)) continue;
      const ob = r.obj;
      let shown = true;
      for (let o = ob; o; o = o.parent) if (!o.visible) { shown = false; break; }
      const mat = Array.isArray(ob.material) ? ob.material[0] : ob.material;
      const opacity = mat && mat.transparent ? mat.opacity : 1;
      ob.updateWorldMatrix(true, false);
      _m.multiplyMatrices(camera.matrixWorldInverse, ob.matrixWorld);
      const rect = r.rect ?? { x: 0, y: 0, w: o.width, h: o.height };
      const near = -camera.near * (1 + 1e-6);
      const proj = (x, y) => {          // 局部 (x, y, 0) → 屏幕像素；在近平面后 = null
        _a.set(x, y, 0).applyMatrix4(_m);
        if (_a.z > near) return null;
        const d = -_a.z;
        _a.applyMatrix4(camera.projectionMatrix);
        return [rect.x + (_a.x * 0.5 + 0.5) * rect.w, rect.y + (0.5 - _a.y * 0.5) * rect.h, d];
      };
      const [x0, y0, x1, y1] = r.box, h = r.em / 2;
      const xs = [x0 + h, (x0 + x1) / 2, x1 - h].map((v) => Math.min(Math.max(v, x0), x1));
      const ys = y1 - y0 > r.em * 1.5 ? [y0 + h, (y0 + y1) / 2, y1 - h] : [(y0 + y1) / 2];
      let em = Infinity, emMax = 0, squash = Infinity, aspect = null, behind = 0, n = 0, depth = Infinity;
      for (const y of ys) for (const x of xs) {
        n++;
        const L = proj(x - h, y), R = proj(x + h, y), D = proj(x, y - h), U = proj(x, y + h);
        if (!L || !R || !D || !U) { behind++; continue; }
        const u = [R[0] - L[0], R[1] - L[1]], v = [U[0] - D[0], U[1] - D[1]];
        const lu = Math.hypot(...u), lv = Math.hypot(...v);
        const a = lu * lu + lv * lv, det = Math.abs(u[0] * v[1] - u[1] * v[0]);
        const disc = Math.sqrt(Math.max(0, a * a - 4 * det * det));
        const s1 = Math.sqrt((a + disc) / 2), s2 = Math.sqrt(Math.max(0, (a - disc) / 2));
        em = Math.min(em, lv); emMax = Math.max(emMax, lv);
        squash = Math.min(squash, s1 > 0 ? s2 / s1 : 0);
        depth = Math.min(depth, (L[2] + R[2] + D[2] + U[2]) / 4);
        if (x === xs[1] && y === ys[Math.floor(ys.length / 2)]) aspect = lv > 0 ? lu / lv : null;
      }
      const c = proj((x0 + x1) / 2, (y0 + y1) / 2);
      const all = behind === n;
      items[name] = {
        em: all ? 0 : R4(em), emMax: all ? 0 : R4(emMax), squash: all ? 0 : R4(squash), aspect: aspect == null ? null : R4(aspect),
        cx: c ? R4((c[0] - rect.x) / rect.w) : null, cy: c ? R4((c[1] - rect.y) / rect.h) : null,
        depth: all ? null : R4(depth), behind: R4(behind / n), shown, opacity: R4(opacity),
      };
    }
    legTable = { t, items };
  }

  /**
   * 登记一段要"读得出"的世界文字（加载期调，一次）。
   *   name      关键词（报告里用它）
   *   obj       画这段字的 Object3D（平面贴图、TextGeometry、troika 的 mesh……）。字在它的局部 XY 平面上，
   *             +x = 阅读方向，+y = 字的上方（PlaneGeometry / TextGeometry 的约定；不是的话包一层 Group 转过来）
   *   from, to  阅读时间窗（秒，S.frame 收到的那个 t），通常取 vo.span(id) / vo.at('词') 算出来
   *   em        一个 em 在局部坐标里多高。贴图字 = 字号px / 贴图高px × 平面高；不给 = 文字框高（单行字）
   *   box       [x0,y0,x1,y1] 局部文字框；不给 = obj.geometry 的包围盒
   *   rect      测量用的屏幕坐标系（同 anchor 的 rect）；不给 = {0,0,createStage3D 的 width,height}，即片子原生像素
   * 同时装上 window.legible(t)（画第 t 秒那一帧 = 一次 seek，返回这一帧的测量表）、.last()、.windows()。
   */
  function legible(name, obj, opts = {}) {
    if (inFrame) throw new Error('stage3d.legible() 在加载期登记一次，不要在 paint 里调（登记表要是常量）');
    if (typeof name !== 'string' || !name) throw new Error('stage3d.legible: name 必须是非空字符串');
    if (legReg.has(name)) throw new Error(`stage3d.legible: 「${name}」登记过了`);
    if (!obj || !obj.isObject3D) throw new Error(`stage3d.legible(「${name}」): obj 要是 Object3D`);
    const { from, to } = opts;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error(`stage3d.legible(「${name}」): from/to 必须是秒数且 from ≤ to（收到 ${from}, ${to}）`);
    let box = opts.box;
    if (!box) {
      const g = obj.geometry;
      if (!g) throw new Error(`stage3d.legible(「${name}」): obj 没有 geometry，要给 box: [x0,y0,x1,y1]（局部坐标）`);
      if (!g.boundingBox) g.computeBoundingBox();
      box = [g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.max.x, g.boundingBox.max.y];
    }
    const em = opts.em ?? box[3] - box[1];
    if (!(em > 0)) throw new Error(`stage3d.legible(「${name}」): em 必须 > 0`);
    legReg.set(name, { obj, from, to, box: [...box], em, rect: opts.rect ?? null });
    if (typeof window !== 'undefined' && !window.legible) {
      const read = () => legTable ?? { t: null, items: {} };
      const fn = (t) => {
        legTable = null;                       // 这一帧没走到 render（例如这段不画三维）= 空表，不留上一帧的
        const r = window.seek(t);
        return r && typeof r.then === 'function' ? r.then(read) : read();
      };
      fn.last = read;
      fn.windows = () => [...legReg].map(([n, x]) => ({ name: n, from: x.from, to: x.to }));
      window.legible = fn;
    }
  }

  /** 预热：编译所有材质 + 渲一帧（首帧 JIT 几十到几百 ms，放在 window.ready 里付掉） */
  function warm(t = 0, paint, postParams) {
    if (!frozen && resetOn) freeze();
    renderer.compile(scene, camera);
    return frame(t, paint, postParams);
  }

  /** 读回一个像素强制等 SwiftShader 画完（计时用） */
  function finish() { const gl = renderer.getContext(); const p = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); }

  const S = {
    THREE, renderer, scene, camera, canvas, width: w, height: h, scale,
    freeze, reset, render, frame, warm, finish, project, screenBox, anchor, anchorBox, anchorPoint, legible,
    /** 挂上后期链（post3d.js 的 createPost 会调） */
    _attachPost(p) { post = p; },
    get post() { return post; },
    /** 把舞台画进一个 2D context（舞台不是主画布时）。默认铺满 */
    drawTo(ctx, { x = 0, y = 0, width = o.width, height = o.height } = {}) { ctx.drawImage(canvas, x, y, width, height); },
  };
  return S;
}
