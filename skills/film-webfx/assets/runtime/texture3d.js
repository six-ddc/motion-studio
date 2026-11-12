// 加载期程序化纹理。颜色是线性 RGB；不隐含色板，不在 seek 中烘焙。
import * as THREE from './three-film.module.js';
import { hash01 } from './rand.js';

const sat = x => Math.max(0, Math.min(1, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = x => x * x * (3 - 2 * x);
const mod = (x, n) => ((x % n) + n) % n;
function positive(x, name) { if (!(Number.isFinite(x) && x > 0)) throw new Error(`texture3d: ${name} 必须 > 0`); return x; }
function rgb(c, name) { if (!Array.isArray(c) || c.length !== 3 || c.some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error(`texture3d: ${name} 要线性 RGB [0,1]`); }

/** 周期格点值噪声：period 为整数，x/y 以格点计；跨边界值及一阶导数连续。 */
export function tileNoise(x, y, period, seed) {
  if (!Number.isInteger(period) || period < 1) throw new Error('texture3d: period 要正整数');
  const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy);
  const h = (a, b) => hash01(seed, mod(a, period), mod(b, period));
  return mix(mix(h(ix, iy), h(ix + 1, iy), u), mix(h(ix, iy + 1), h(ix + 1, iy + 1), u), v);
}

/** 可平铺高度图（米）。layers: [{period: 整数, amplitude: 米}]。 */
export function bakeHeight({ size, seed, layers }) {
  if (!Number.isInteger(size) || size < 2 || size > 4096) throw new Error('texture3d: size 要 2..4096 整数');
  if (!Number.isInteger(seed) || !Array.isArray(layers) || !layers.length) throw new Error('texture3d: seed/layers 必填');
  for (const l of layers) { if (!Number.isInteger(l.period) || l.period < 1 || !Number.isFinite(l.amplitude)) throw new Error('texture3d: layer 要 period 正整数和 amplitude 米'); }
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let h = 0;
    layers.forEach((l, k) => { h += (tileNoise(x / size * l.period, y / size * l.period, l.period, seed + k) - .5) * l.amplitude; });
    height[y * size + x] = h;
  }
  return height;
}

/** 高度图 → 法线，周期中心差分；tileMeters 控制物理斜率，不随纹理分辨率改变。 */
export function normalFromHeight(height, size, tileMeters) {
  positive(tileMeters, 'tileMeters');
  if (!Number.isInteger(size) || size < 2 || height.length !== size * size) throw new Error('texture3d: height 尺寸不匹配');
  const out = new Uint8Array(size * size * 4), step = tileMeters / size;
  const at = (x, y) => height[mod(y, size) * size + mod(x, size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * step), dy = (at(x, y + 1) - at(x, y - 1)) / (2 * step);
    const len = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
    out[i] = Math.round((.5 - dx / len * .5) * 255); out[i + 1] = Math.round((.5 - dy / len * .5) * 255);
    out[i + 2] = Math.round((.5 + .5 / len) * 255); out[i + 3] = 255;
  }
  return out;
}

/** 数据贴图，无 sRGB 转换；所有贴图共享线性数据约定。 */
export function dataTexture(data, size, { repeat = true } = {}) {
  if (data.length !== size * size * 4) throw new Error('texture3d: RGBA 数据尺寸不匹配');
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

/** 共享的成簇破损模型：paint → primer → rust → metal，各层同时输出颜色/ORM/高度。
 * palette 每项 {color:[r,g,b], roughness, metalness}；比例/尺度由片子传入。
 */
export function bakePaint({ size, seed, tileMeters, layers, damage, palette }) {
  positive(tileMeters, 'tileMeters');
  for (const name of ['paint', 'primer', 'rust', 'metal']) {
    const p = palette?.[name]; if (!p) throw new Error(`texture3d: palette.${name} 必填`);
    rgb(p.color, `palette.${name}.color`);
    for (const k of ['roughness', 'metalness']) if (!Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1) throw new Error(`texture3d: ${name}.${k} 要 [0,1]`);
  }
  for (const k of ['amount', 'softness', 'depth']) if (!Number.isFinite(damage?.[k]) || damage[k] < 0) throw new Error(`texture3d: damage.${k} 必填且 ≥0`);
  if (damage.amount > 1 || damage.softness <= 0 || !Number.isInteger(damage.period) || damage.period < 1) throw new Error('texture3d: damage amount≤1、softness>0、period 正整数');
  const height = bakeHeight({ size, seed, layers }), albedo = new Uint8Array(size * size * 4), orm = albedo.slice(), masks = albedo.slice();
  const p = damage.period;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, j = i * 4;
    const cluster = tileNoise(x / size * p, y / size * p, p, seed + 100);
    const detail = tileNoise(x / size * p * 4, y / size * p * 4, p * 4, seed + 101);
    const d = sat((damage.amount - (cluster * .8 + detail * .2)) / damage.softness);
    const primer = smooth(sat(d * 4)), rust = smooth(sat((d - .25) * 2)), metal = smooth(sat((d - .8) * 5));
    const weights = [1 - primer, primer * (1 - rust), primer * rust * (1 - metal), primer * rust * metal];
    const names = ['paint', 'primer', 'rust', 'metal']; let rough = 0, m = 0;
    for (let c = 0; c < 3; c++) albedo[j + c] = Math.round(255 * names.reduce((s, n, k) => s + weights[k] * palette[n].color[c], 0));
    names.forEach((n, k) => { rough += weights[k] * palette[n].roughness; m += weights[k] * palette[n].metalness; });
    height[i] -= primer * damage.depth;
    albedo[j + 3] = orm[j + 3] = masks[j + 3] = 255;
    orm[j] = Math.round(255 * (1 - primer * .2)); orm[j + 1] = Math.round(255 * rough); orm[j + 2] = Math.round(255 * m);
    masks[j] = Math.round(primer * 255); masks[j + 1] = Math.round(rust * 255); masks[j + 2] = Math.round(metal * 255);
  }
  const maps = { map: dataTexture(albedo, size), normalMap: dataTexture(normalFromHeight(height, size, tileMeters), size),
    aoMap: dataTexture(orm, size), roughnessMap: null, metalnessMap: null };
  maps.roughnessMap = maps.metalnessMap = maps.aoMap;
  return { ...maps, height, albedo, orm, masks, dispose() { new Set(Object.values(maps)).forEach(t => t?.dispose()); } };
}

/** GPU 加载期烘焙框架：调用者给 GLSL，返回独立 RT；状态在 finally 完整恢复。 */
export function bakeShader(renderer, { size, fragmentShader, uniforms = {}, type = THREE.UnsignedByteType }) {
  if (!Number.isInteger(size) || size < 2 || size > 4096) throw new Error('texture3d: size 要 2..4096');
  const rt = new THREE.WebGLRenderTarget(size, size, { type, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const mat = new THREE.ShaderMaterial({ uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){vUv=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.);}', fragmentShader });
  const geo = new THREE.PlaneGeometry(2, 2); scene.add(new THREE.Mesh(geo, mat));
  const old = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel(), viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), test = renderer.getScissorTest();
  try { renderer.setRenderTarget(rt); renderer.setScissorTest(false); renderer.clear(); renderer.render(scene, camera); }
  catch (e) { rt.dispose(); throw e; }
  finally { renderer.setRenderTarget(old,face,mip); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(test); mat.dispose(); geo.dispose(); }
  return rt;
}
