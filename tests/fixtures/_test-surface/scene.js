// film-webfx surface3d.js 验收片（4 s）：同一组物体（盒子、球、圆柱 + 地面）左右各一份。
//   左 = 裸 MeshStandardMaterial（物体用自带 UV）；右 = applySurface 全部特性 + weatherGeometry 顶点色风化（物体删掉 UV，走三平面）。
//   湿度 = t / DURATION，从 0 到 1；球绕竖轴转（看三平面纹理会不会"游泳"）。
// 配色、参数都是这支夹具自己的选择，不是 skill 的推荐值（材料配方菜单见 film-webfx/references/surfaces.md）。
//
// 只给计时脚本用的 URL 参数（加载期常量）：?sf=aa,macro,grime,wet,tri,weather（右侧开哪些，默认全开；sf=none 全关）
//   ?view=fill（俯看右侧大地面，让处理过的材质铺满画面，量每像素代价）
import { layoutFromURL } from './runtime/layout.js';
import { hash01, seeded } from './runtime/rand.js';
import { createStage3D, THREE } from './runtime/stage3d.js';
import { applySurface, weatherGeometry } from './runtime/surface3d.js';

const L = layoutFromURL();
const DURATION = 4;
window.DURATION = DURATION;
const q = new URLSearchParams(location.search);
const SF = new Set((q.get('sf') ?? 'aa,macro,grime,wet,tri,weather').split(',').filter((x) => x && x !== 'none'));
const FILL = q.get('view') === 'fill';
const tall = L.height > L.width;

const canvas = document.getElementById('stage');
// 阴性对照 scene-bad-noreset.html：reset:false + 只在后半段写湿度（前半段沿用上一次 seek 留下的 uniform）→ 门 2 红
const BAD_NORESET = window.SF_VARIANT === 'noreset';
const S = createStage3D({ canvas, width: L.width, height: L.height, clear: [0.02, 0.022, 0.026, 1],
  toneMapping: THREE.ACESFilmicToneMapping, shadows: true, shadowType: THREE.PCFSoftShadowMap, ...(BAD_NORESET ? { reset: false } : {}) });
const scene = S.scene;

// ---------- 程序化贴图（加载期、种子化）：可平铺高度 → 反照率 / 粗糙度 / 法线 ----------
function makeTextures(seed, N) {
  const H = new Float32Array(N * N);
  const octs = [[8, 0.5], [16, 0.25], [32, 0.15], [64, 0.1]];
  for (const [P, amp] of octs) {
    const lat = new Float32Array(P * P);
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) lat[j * P + i] = hash01(seed, P, i, j);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * P, fy = (y / N) * P, ix = Math.floor(fx), iy = Math.floor(fy);
      let ux = fx - ix, uy = fy - iy; ux = ux * ux * (3 - 2 * ux); uy = uy * uy * (3 - 2 * uy);
      const a = lat[iy * P + ix], b = lat[iy * P + (ix + 1) % P], c = lat[((iy + 1) % P) * P + ix], d = lat[((iy + 1) % P) * P + (ix + 1) % P];
      H[y * N + x] += amp * ((a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy);
    }
  }
  const rnd = seeded(seed + 1), pit = new Float32Array(N * N);
  for (let k = 0; k < 90; k++) {      // 气孔：可平铺的小凹坑
    const cx = rnd() * N, cy = rnd() * N, r = 1.5 + rnd() * 4;
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      const d = Math.hypot(dx, dy) / r; if (d >= 1) continue;
      const x = (Math.floor(cx) + dx + N) % N, y = (Math.floor(cy) + dy + N) % N;
      pit[y * N + x] = Math.max(pit[y * N + x], 1 - d * d);
    }
  }
  for (let i = 0; i < N * N; i++) H[i] -= 0.35 * pit[i];
  const alb = new Uint8Array(N * N * 4), orm = new Uint8Array(N * N * 4), nrm = new Uint8Array(N * N * 4);
  const h = (x, y) => H[((y + N) % N) * N + (x + N) % N];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, v = H[i], p = pit[i];
    const l = (0.55 + 0.35 * v) * (1 - 0.35 * p);
    alb[i * 4] = 255 * Math.min(1, l * 0.98); alb[i * 4 + 1] = 255 * Math.min(1, l * 0.95); alb[i * 4 + 2] = 255 * Math.min(1, l * 0.9); alb[i * 4 + 3] = 255;
    const r = 0.55 + 0.35 * (1 - v) * (0.8 + 0.4 * hash01(seed + 7, x, y)) + 0.1 * p;
    orm[i * 4] = 255; orm[i * 4 + 1] = 255 * Math.min(1, Math.max(0, r)); orm[i * 4 + 2] = 255; orm[i * 4 + 3] = 255;
    const k = 24, dx = (h(x + 1, y) - h(x - 1, y)) * 0.5 * k, dy = (h(x, y + 1) - h(x, y - 1)) * 0.5 * k;
    const ln = Math.hypot(dx, dy, 1);
    nrm[i * 4] = 255 * (0.5 - 0.5 * dx / ln); nrm[i * 4 + 1] = 255 * (0.5 - 0.5 * dy / ln); nrm[i * 4 + 2] = 255 * (0.5 + 0.5 / ln); nrm[i * 4 + 3] = 255;
  }
  const tex = (data, srgb) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true;
    return t;
  };
  return { map: tex(alb, true), roughnessMap: tex(orm, false), normalMap: tex(nrm, false) };
}
const TX = makeTextures(2026, 256);
const withRepeat = (set, r) => Object.fromEntries(Object.entries(set).map(([k, t]) => { const c = t.clone(); c.repeat.set(r, r); c.needsUpdate = true; return [k, c]; }));
const TX_OBJ = withRepeat(TX, 2);       // 左侧物体：UV 1 m → 每 0.5 m 一片，与右侧三平面 scale 2 同密度
const TX_GND = withRepeat(TX, FILL ? 20 : 2);

// ---------- 环境光照（PMREM，从一个程序化小场景生成；加载期一次） ----------
{
  const env = new THREE.Scene();
  const sky = new THREE.SphereGeometry(20, 32, 16);
  const cols = [];
  const p = sky.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i) / 20; const c = y > 0 ? [0.5 + 0.4 * y, 0.6 + 0.4 * y, 0.75 + 0.5 * y] : [0.12, 0.11, 0.1]; cols.push(...c); }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.6, 5), side: THREE.DoubleSide }));
  panel.position.set(-6, 9, 4); panel.lookAt(0, 0, 0); env.add(panel);
  const pm = new THREE.PMREMGenerator(S.renderer);
  scene.environment = pm.fromScene(env, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pm.dispose();
}
scene.add(new THREE.HemisphereLight(0x9fb2c8, 0x2a2622, 0.25));
const sun = new THREE.DirectionalLight(0xfff1e0, 2.6);
sun.position.set(-4, 7, 5); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -2e-4; sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6, near: 0.5, far: 30 });
scene.add(sun); scene.add(sun.target);

// ---------- 材料配方（本夹具的取值；含义见 surfaces.md） ----------
const AA = { toksvig: 0.6, minRoughness: 0.045, maxSpecular: 40 };
const WET_BASE = { level: 0, saturate: 0.5, flatten: 0.45, streakFreq: [9, 0.55], patch: { freq: 0.8, amount: 0.25 } };
const SPLASH = { groundY: 0, height: 0.3, amount: 0.6, darken: 0.25 };
const BEADS = (amount) => ({ amount, size: 1 / 170, maxFootprint: 1 / 120, roughness: 0.05 });
const RECIPE = {
  porous: { color: 0xd8d2c8, rough: 1, metal: 0,
    wet: { ...WET_BASE, darken: 0.42, roughnessMul: 0.38, vertical: 0.5, splash: SPLASH, beads: null },
    macro: { albedo: 0.18, roughness: 0.12, freq: 0.8 }, grime: { amount: 0.6, ramp: [0.5, 0.85], aoWeight: 0.6, darken: 0.35, roughen: 0.2, freq: 0.8 } },
  sealed: { color: 0x8a2a22, rough: 0.55, metal: 0,
    wet: { ...WET_BASE, darken: 0.05, roughnessMul: 0.62, vertical: 0.65, splash: SPLASH, beads: BEADS(0.7) },
    macro: { albedo: 0.12, roughness: 0.16, freq: 1.5 }, grime: { amount: 0.45, ramp: [0.5, 0.85], aoWeight: 0.8, darken: 0.3, roughen: 0.25, freq: 1.5 } },
  metal: { color: 0xa9adb1, rough: 0.5, metal: 1,
    wet: { ...WET_BASE, darken: 0, roughnessMul: 0.7, vertical: 0.55, splash: SPLASH, beads: BEADS(0.5) },
    macro: { albedo: 0.07, roughness: 0.1, freq: 3 }, grime: { amount: 0.4, ramp: [0.5, 0.85], aoWeight: 0.8, darken: 0.3, roughen: 0.15, freq: 3 } },
};
const surfs = [];
function material(kind, tx, treated, { space, ao, tri }) {
  const R = RECIPE[kind];
  const m = new THREE.MeshStandardMaterial({ color: R.color, roughness: R.rough, metalness: R.metal, ...tx,
    vertexColors: treated && SF.has('weather') && ao === 'vertexColor' });
  if (!treated) return m;
  const f = {};
  if (SF.has('aa')) f.antiFlicker = AA;
  if (SF.has('macro')) f.macro = { space, ...R.macro };
  if (SF.has('grime')) f.grime = { space, ao: m.vertexColors ? ao : 'none', ...R.grime };
  if (SF.has('wet')) f.wet = R.wet;
  if (SF.has('tri') && tri) f.triplanar = { scale: 2, sharpness: 6 };
  if (Object.keys(f).length) surfs.push(applySurface(m, f));
  return m;
}

// ---------- 两组物体 ----------
const spheres = [];
function build(side, treated) {
  const g = new THREE.Group(); g.position.x = side; scene.add(g);
  const gnd = new THREE.Mesh(new THREE.PlaneGeometry(FILL ? 40 : 4.2, FILL ? 40 : 4), material('porous', TX_GND, treated, { space: 'world', ao: 'none', tri: FILL }));
  gnd.rotation.x = -Math.PI / 2; gnd.receiveShadow = true; g.add(gnd);
  if (FILL) return;
  const useTri = treated && SF.has('tri');
  const items = [
    ['box', 'porous', new THREE.BoxGeometry(1, 1, 1, 10, 10, 10), [-1.0, 0.5, -0.3], 'world'],
    ['cyl', 'metal', new THREE.CylinderGeometry(0.35, 0.35, 1.3, 48, 16), [0.15, 0.65, -0.9], 'world'],
    ['sph', 'sealed', new THREE.SphereGeometry(0.5, 64, 40), [0.95, 0.5, 0.35], 'object'],
  ];
  for (const [name, kind, geo0, p, space] of items) {
    const mesh = new THREE.Mesh(geo0, null);
    mesh.position.set(...p); mesh.castShadow = mesh.receiveShadow = true; g.add(mesh);
    let geo = geo0;
    if (treated && SF.has('weather')) {
      g.updateMatrixWorld(true);
      geo = weatherGeometry(geo0, { seed: 11, transform: mesh.matrixWorld,
        mottle: [{ freq: 1.9, amount: 0.12 }, { freq: 9, amount: 0.05 }],
        hemi: { down: 0.72, side: 0.9 },
        contact: { groundY: 0, height: 0.2, darken: 0.45, warm: [1, 0.95, 0.86], noise: { freq: 9, amount: 0.45 } },
        crease: name === 'box' ? { weld: 1e-4, ramp: [0.05, 0.4], concave: 0.3, convex: 0.12 } : null,
        rust: name === 'cyl' ? { color: [1.25, 0.8, 0.55], amount: 0.6, freq: 2.2, ramp: [0.62, 0.75], where: 'all' } : null });
    }
    if (useTri) { geo = geo === geo0 ? geo0.clone() : geo; geo.deleteAttribute('uv'); }
    mesh.geometry = geo;
    mesh.material = material(kind, useTri ? TX : TX_OBJ, treated, { space, ao: 'vertexColor', tri: true });
    if (name === 'sph') spheres.push(mesh);
  }
}
build(-2.25, false);
build(2.25, true);

function paint(t) {
  const w = t / DURATION;
  if (!BAD_NORESET || t > DURATION / 2) for (const s of surfs) if (s.features.wet) s.set({ wet: { level: w } });
  for (const m of spheres) m.rotation.y = 0.6 * t;
  if (FILL) {
    S.camera.fov = 40; S.camera.position.set(2.25, 3.2, 0.8); S.camera.lookAt(2.25, 0, -0.4);
  } else {
    S.camera.fov = tall ? 62 : 34;
    S.camera.position.set(0.1 * Math.sin(t * 0.5), tall ? 3.0 : 2.1, tall ? 9.5 : 7.4);
    S.camera.lookAt(0, 0.45, -0.2);
  }
}

window.__finish = () => S.finish();   // 只给计时脚本用：读回 1 像素等画完（seek 里不调）
window.seek = (t) => { S.frame(t, paint); };
window.ready = (async () => {
  S.freeze();
  window.seek(0);                     // 预热：编译着色器
})();
