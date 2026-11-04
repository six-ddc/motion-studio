// film-webfx 三维验收片（7 s）：three 场景 + 样条推进/焦点切换/手持 + 两层 GPU 闭式粒子 + 后期（泛光、景深、色差、颗粒、暗角、一段故障）。
// 配色、构图、强度都是这支夹具自己的选择（docs/style_guide.md），不是 skill 的推荐值。
import { layoutFromURL } from './runtime/layout.js';
import { seeded } from './runtime/motion.js';
import { createAnchors } from './runtime/anchors.js';
import { createStage3D, THREE } from './runtime/stage3d.js';
import { createPost } from './runtime/post3d.js';
import { createParticles, SPRITE } from './runtime/particles3d.js';
import { spline, track, blendTargets, shake, applyShot, ease } from './runtime/camrig.js';

const L = layoutFromURL();
const DURATION = 7;
window.DURATION = DURATION;
const canvas = document.getElementById('stage');
// 阴性对照用的变体开关（scene-bad-*.html 在加载前设 window.FX_VARIANT）。正片 = undefined
const VARIANT = window.FX_VARIANT;
const S = createStage3D({ canvas, width: L.width, height: L.height, clear: [0.004, 0.006, 0.01, 1], toneMapping: THREE.ACESFilmicToneMapping,
  reset: VARIANT !== 'noreset' });
const A = createAnchors(canvas);
const scene = S.scene;
const tall = L.height > L.width;

// ---------- 核心：一块多面体 + 发光棱 + 两道光环 ----------
const core = new THREE.Group(); core.name = '核心组'; scene.add(core);
const ico = new THREE.IcosahedronGeometry(1.1, 0);
const body = new THREE.Mesh(ico, new THREE.MeshStandardMaterial({ color: 0x1a2630, metalness: 0.85, roughness: 0.32, emissive: 0x05121a }));
body.name = '核心'; core.add(body);
const edges = new THREE.LineSegments(new THREE.EdgesGeometry(ico), new THREE.LineBasicMaterial({ color: new THREE.Color(0.35, 2.6, 2.2) }));
core.add(edges);
const rings = new THREE.Group(); rings.name = '光环'; core.add(rings);
const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.5, 0.45) });
for (const [r, tilt] of [[2.0, 0.35], [2.55, -0.6]]) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 220), ringMat);
  m.rotation.x = Math.PI / 2 + tilt; rings.add(m);
}
scene.add(new THREE.AmbientLight(0x223344, 0.6));
const key = new THREE.DirectionalLight(0xbfe9ff, 2.2); key.position.set(4, 6, 5); scene.add(key);
const glow = new THREE.PointLight(0xffb060, 30, 12, 2); glow.position.set(0, 0, 0); scene.add(glow);

// ---------- 数字雨：三层幕布，每个格子是一个粒子 ----------
// 字形图集：8×8 格，每格一个 5×7 的种子化点阵符号（不依赖字体——字体回退会让两种浏览器构建渲出不同的字）
const ATLAS = 8, CELL = 64;
const atlasCv = document.createElement('canvas'); atlasCv.width = atlasCv.height = ATLAS * CELL;
{
  const g = atlasCv.getContext('2d'), rnd = seeded(2026);
  g.fillStyle = '#fff';
  for (let k = 0; k < ATLAS * ATLAS; k++) {
    const ox = (k % ATLAS) * CELL, oy = Math.floor(k / ATLAS) * CELL, px = CELL / 8;
    for (let y = 0; y < 7; y++) for (let x = 0; x < 3; x++) {
      if (rnd() < 0.46) { g.fillRect(ox + (1.5 + x) * px, oy + (0.5 + y) * px, px * 0.86, px * 0.86); if (rnd() < 0.7) g.fillRect(ox + (5.5 - x) * px, oy + (0.5 + y) * px, px * 0.86, px * 0.86); }
    }
  }
}
const atlasTex = new THREE.CanvasTexture(atlasCv); atlasTex.colorSpace = THREE.NoColorSpace;
const COLS = tall ? 34 : 60, ROWS = tall ? 70 : 40, LAYERS = 3;
const rain = createParticles(S, {
  count: COLS * ROWS * LAYERS, seed: 7, blending: 'add', sprite: SPRITE.atlas(ATLAS),
  uniforms: { uAtlas: atlasTex, uCols: COLS, uRows: ROWS, uAspect: L.width / L.height, uFade: 1 },
  kernel: `uniform float uCols, uRows, uAspect, uFade;
void particle(float id, vec4 rnd, vec4 rnd2, float t, inout vec3 pos, inout float size, inout vec4 col, inout float aux){
  float per = uCols * uRows;
  float layer = floor(id / per); float rem = id - layer * per;
  float c = floor(rem / uRows); float r = rem - c * uRows;
  float z = -5.0 - layer * 6.5;
  float height = 9.0 + (17.0 - z) * 0.9;           // 远层铺得更大，填满视锥
  float cell = height / uRows;
  float width = cell * uCols * 0.82;
  pos = vec3((c / (uCols - 1.) - .5) * width, (.5 - r / uRows) * height + 2.0, z);
  // 每列一个下落速度和起点（按列号哈希）；头部在第 head 行，身后拖尾按指数衰减
  float hc = hash12(vec2(c, layer * 31. + 7.));
  float speed = mix(5., 13., hash12(vec2(c + 3., layer)));
  float span = uRows * 1.6;
  float head = mod(t * speed + hc * span, span) - uRows * .3;
  float d = head - r;
  float trail = mix(6., 20., hash12(vec2(c, layer + 5.)));
  float b = d >= 0. ? exp(-d / trail) : 0.;
  float isHead = smoothstep(1.2, 0., abs(d));
  // 字形按格子自己的节奏换：(列, 行, floor(t·rate + 相位)) 取哈希
  float rate = mix(1.5, 8., rnd.x);
  aux = floor(hash13(vec3(c, r + layer * 101., floor(t * rate + rnd.y * 9.))) * 64.);
  size = cell * .92;
  vec3 tint = mix(vec3(.08, .9, .62), vec3(1.6, 3.2, 2.8), isHead);
  col = vec4(tint * (0.25 + 1.2 * b), clamp(b * 1.3 + isHead, 0., 1.) * uFade * (1. - .22 * layer));
}`,
});
rain.points.name = '数字雨'; scene.add(rain.points);

// ---------- 灵气：绕核心螺旋上升的星尘，循环寿命 ----------
const aura = createParticles(S, {
  count: 7000, seed: 11, blending: 'add', sprite: SPRITE.soft,
  uniforms: { uGain: 1 },
  kernel: `uniform float uGain;
void particle(float id, vec4 rnd, vec4 rnd2, float t, inout vec3 pos, inout float size, inout vec4 col, inout float aux){
  float life = mix(2.4, 4.8, rnd.x);
  vec3 L = lifecycle(t, life, rnd.y);                 // (age, age/life, 第几次生命)
  vec4 R = rebirth(id, L.z);                          // 每次重生换出生点
  float age = L.x;
  float ang = R.x * 6.2831853 + age * mix(.5, 1.5, R.w);
  float rad = mix(.9, 2.8, R.y) + .22 * age;
  float h = mix(-2.2, -.2, R.z) + age * mix(.45, 1.05, rnd2.y);
  vec3 p = vec3(cos(ang) * rad, h, sin(ang) * rad);
  p += drift(p * .7, age * .6 + R.x * 13.) * .32 * L.y;
  float fade = smoothstep(0., .12, L.y) * smoothstep(1., .55, L.y);
  pos = p; size = mix(.014, .045, rnd2.z) * (1. + .6 * L.y);
  col = vec4(vec3(2.6, 1.55, .55) * (.6 + 1.6 * rnd2.w), fade * uGain);
}`,
});
aura.points.name = '灵气'; scene.add(aura.points);
const AURA_BOUND = new THREE.Box3(new THREE.Vector3(-4.6, -2.4, -4.6), new THREE.Vector3(4.6, 3.6, 4.6));   // 闭式解保证的范围（半径 ≤ 2.8+.22·4.8+.32，高 ≤ -.2+4.8·1.05+.32）

const post = createPost(S, { samples: 0, bloom: { levels: 5 }, dof: { resolution: 0.5 }, chroma: true, grain: true, vignette: true, glitch: true, seed: 3 });

// ---------- 镜头：样条推进 + 焦点从雨幕切到核心 + 手持 ----------
const path = spline(tall
  ? [[0.4, 4.6, 18], [1.8, 2.6, 13], [3.6, 1.1, 9.6], [1.4, 0.5, 8.0], [-2.8, 0.8, 7.4]]
  : [[0.8, 3.6, 16], [2.6, 2.0, 11.5], [3.8, 0.9, 8.4], [1.2, 0.4, 7.0], [-3.0, 0.6, 6.4]]);
const progress = track([[0, 0, ease.inOut(2.4)], [6.6, 1]]);
const rainLook = [0.0, 3.2, -11.5];
const lookAt = blendTargets([[0, rainLook], [2.4, [0, 0.05, 0]]], { dur: 1.5, ease: 'smoother' });
const fov = track([[0, tall ? 44 : 34, 'smooth'], [6.8, tall ? 36 : 28]]);
const roll = track([[0, -0.06, 'smooth'], [3.5, 0.03, 'smooth'], [7, -0.015]]);
const hand = shake({ amp: [0.035, 0.025, 0.02], freq: 0.9, seed: 5 });
const glitchAmt = track([[4.35, 0, 'out'], [4.45, 0.42, 'linear'], [4.7, 0.18, 'in'], [4.95, 0]]);
const ringSpin = (t) => 0.35 * t;

function shot(t) {
  const p = path.at(progress(t)), h = hand(t);
  return { pos: [p[0] + h[0], p[1] + h[1], p[2] + h[2]], target: lookAt(t), fov: fov(t), roll: roll(t), near: 0.1, far: 80 };
}

function paint(t) {
  const focus = applyShot(S.camera, shot(t), S);
  core.rotation.set(0.3 * Math.sin(t * 0.7), 0.42 * t, 0.12 * Math.cos(t * 0.5));
  rings.rotation.y = ringSpin(t); rings.children[1].rotation.z = -0.8 * t;
  glow.intensity = 22 + 10 * Math.sin(t * 2.1);
  // 阴性对照：只在 t>3.5 写 visible，从不写回。reset:true 时下一帧复位，reset:false 时它会漏进之后求值的每一帧
  if ((VARIANT === 'noreset' || VARIANT === 'sloppy') && t > 3.5) rings.visible = false;
  if (VARIANT === 'clock') core.rotation.y = new THREE.Clock().getElapsedTime();
  if (VARIANT === 'integrate') { const dt = t - (window.__lastT ?? 0); window.__lastT = t; window.__drift = (window.__drift ?? 0) * 0.8 + 0.3 * dt;   /* 带阻尼的逐帧积分：结果依赖上一次求值是哪一帧（匀速积分 Σdt 会伸缩成 t−t0，碰巧是闭式，抓不到） */ core.position.y = window.__drift; }
  rain.update(t);
  aura.update(t, { uGain: Math.min(1, t / 1.2) });
  // 锚点：渲染完由 stage 用渲染用的矩阵投影
  S.anchor(A, '核心', body);
  S.anchor(A, '光环', rings);
  S.anchorBox(A, '灵气', AURA_BOUND);
  const g = glitchAmt(t);
  return {
    exposure: 1.0,
    bloom: { threshold: 1.0, knee: 0.35, strength: 0.85, radius: 0.72 },
    dof: { focus, blur: 11, maxBlur: 16 },
    chroma: { amount: 2.2 + 40 * g },
    grain: { amount: 0.045, fps: 24 },
    vignette: { amount: 0.6, radius: 0.62, softness: 0.48 },
    glitch: { amount: g, rate: 24, slices: 46, shift: 0.035 * (g > 0 ? 1 : 0), split: 0.004 },
  };
}

window.seek = A.install((t) => { S.frame(t, paint); });
window.ready = (async () => {
  S.freeze();
  S.renderer.compile(scene, S.camera);
  window.seek(0);                  // 预热：首帧着色器编译（走 seek，锚点表才是开着的）
})();
