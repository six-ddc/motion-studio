#!/usr/bin/env node
// 三维舞台 + 后期 + 粒子在 SwiftShader 下的每帧耗时（stage3d.js / post3d.js / particles3d.js）。
//
//   node dev/film-webfx/bench3d.mjs [--quick] [--json] [--formats 9x16,16x9]
//
// 计时：一次 S.frame(t) 之后 gl.readPixels(1px) 强制等 SwiftShader 画完，取中位数（--quick 3 次，否则 7 次）。
// 每一项都是"基准场景 + 这一样东西"，报**增量**（减去同画幅的基准）。基准场景：一个 MeshStandardMaterial 多面体 +
// 一块地面 + 方向光 + 环境光，直接上屏（不走后期）。增量是在这个场景上量的——你的场景面数多、灯多，基准会变，增量大致不变
// （后期的成本只和像素数有关，和场景内容无关）。
//
// 注意：这台机器上别的渲染在跑时数字会偏高（SwiftShader 是多线程 CPU 光栅），出表前看一眼 uptime 的负载。
// 退出码：0 正常；1 页面报错
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { serve } from '../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

cli({
  usage: 'node bench3d.mjs [--quick] [--json] [--formats 9x16,16x9]',
  about: '三维舞台 + 后期 + 粒子在 SwiftShader 下的每帧耗时（报相对基准场景的增量）。退出码 0 正常 / 1 页面报错 / 2 用法错',
  opts: { quick: '每项 3 次取中位数（默认 7 次）', json: '输出 JSON', formats: ['<9x16,16x9,1x1>', '画幅（逗号分隔，默认 9x16,16x9）'] },
});

const DEV = dirname(fileURLToPath(import.meta.url));
const SKILL = join(DEV, '../../skills/film-webfx');   // 被测的运行时
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const asJson = args.includes('--json');
const fi = args.indexOf('--formats');
const FORMATS = { '9x16': [1080, 1920], '16x9': [1920, 1080], '1x1': [1440, 1440] };
const formats = (fi >= 0 ? args[fi + 1] : '9x16,16x9').split(',');

// 页面：空白 '/'；/assets/runtime/* 来自 skill
const BLANK = '<!doctype html><body style="margin:0"></body>';
const serveBench = () => serve(SKILL, { routes: { '/': BLANK } });

const { port, close } = await serveBench();
const browser = await launchBrowser();
const results = {};
const load0 = loadavg()[0];
let failed = false;
try {
  for (const fmt of formats) {
    const [W, H] = FORMATS[fmt];
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    results[fmt] = await page.evaluate(async ({ W, H, N }) => {
      const { createStage3D, THREE } = await import('/assets/runtime/stage3d.js');
      const { createPost } = await import('/assets/runtime/post3d.js');
      const { createParticles, createCPUParticles, SPRITE } = await import('/assets/runtime/particles3d.js');
      const now = () => performance.now();   // 只在测量脚本里读时钟
      const P = {   // 后期参数（只为计时；数值不代表推荐）
        exposure: 1, bloom: { threshold: 0.8, knee: 0.3, strength: 0.8, radius: 0.7 }, dof: { focus: 6, blur: 10, maxBlur: 16 },
        godrays: { light: [0, 3, -4], threshold: 0.9, density: 0.9, decay: 0.96, weight: 0.04, exposure: 0.6 },
        chroma: { amount: 3 }, grain: { amount: 0.05, fps: 24 }, vignette: { amount: 0.5, radius: 0.6, softness: 0.4 },
        scanlines: { count: 480, amount: 0.15 }, glitch: { amount: 0.3, rate: 24, slices: 40, shift: 0.03, split: 0.004 },
      };
      const build = (o = {}) => {
        const cv = document.createElement('canvas');
        const S = createStage3D({ canvas: cv, width: W, height: H, clear: [0.02, 0.02, 0.03, 1], toneMapping: THREE.ACESFilmicToneMapping, shadows: !!o.shadows });
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 2), new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6, roughness: 0.35, emissive: 0x332211 }));
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x404040, roughness: 0.8 }));
        ground.rotation.x = -Math.PI / 2; ground.position.y = -1.3;
        const dl = new THREE.DirectionalLight(0xffffff, 2.5); dl.position.set(3, 6, 4);
        if (o.shadows) { m.castShadow = true; ground.receiveShadow = true; dl.castShadow = true; dl.shadow.mapSize.set(2048, 2048); }
        S.scene.add(m, ground, dl, new THREE.AmbientLight(0x404050, 0.5));
        for (let i = 0; i < (o.extraObjects ?? 0); i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff })); b.position.set((i % 20) - 10, -1.2, -Math.floor(i / 20) - 3); S.scene.add(b); }
        if (o.post) createPost(S, o.post);
        let parts = null;
        if (o.gpu) { parts = createParticles(S, { count: o.gpu, seed: 3, blending: 'add', sprite: SPRITE.soft,
          kernel: `void particle(float id, vec4 rnd, vec4 rnd2, float t, inout vec3 pos, inout float size, inout vec4 col, inout float aux){
            vec3 L = lifecycle(t, mix(2., 4., rnd.x), rnd.y); vec4 R = rebirth(id, L.z);
            float a = R.x * 6.283 + L.x; float r = mix(1.5, 4., R.y);
            pos = vec3(cos(a) * r, -1. + L.x * .8, sin(a) * r) + drift(vec3(R.xyz) * 3., L.x) * .3; size = .04; col = vec4(1.5, 1.1, .6, 1. - L.y); }` });
          S.scene.add(parts.points); }
        if (o.cpu) { parts = createCPUParticles(S, { count: o.cpu, seed: 3, blending: 'add', sprite: SPRITE.soft,
          fn: (i, R, t, out) => { const life = 2 + 2 * R[0], x = t / life + R[1], k = Math.floor(x), age = (x - k) * life; const a = R[2] * 6.283 + age + k, r = 1.5 + 2.5 * R[3];
            out.x = Math.cos(a) * r; out.y = -1 + age * 0.8; out.z = Math.sin(a) * r; out.size = 0.04; out.r = 1.5; out.g = 1.1; out.b = 0.6; out.a = 1 - (x - k); } });
          S.scene.add(parts.points); }
        S.freeze();
        S.camera.position.set(0, 1.2, 7); S.camera.lookAt(0, 0, 0);
        const paint = (t) => { S.camera.position.set(Math.sin(t * 0.3) * 7, 1.2, Math.cos(t * 0.3) * 7); S.camera.lookAt(0, 0, 0); S.camera.updateMatrixWorld(); m.rotation.y = t; if (parts) parts.update(t); return o.post ? P : undefined; };
        return { S, paint };
      };
      const time = (o) => {
        const { S, paint } = build(o);
        const t0 = now(); S.renderer.compile(S.scene, S.camera); S.frame(0, paint); S.finish(); const first = now() - t0;
        const ts = [];
        for (let i = 0; i < N; i++) { const a = now(); S.frame(1 + i * 0.37, paint); S.finish(); ts.push(now() - a); }
        ts.sort((a, b) => a - b);
        const r = { ms: +ts[N >> 1].toFixed(1), min: +ts[0].toFixed(1), firstMs: +first.toFixed(0) };
        S.renderer.dispose(); S.renderer.forceContextLoss();
        return r;
      };
      const out = {};
      const items = [
        ['基准（直接上屏）', {}],
        ['MSAA 4×（默认帧缓冲 antialias）', null],
        ['后期直通（HDR RT + 合成一遍，无效果）', { post: {} }],
        ['后期直通 + MSAA 4×', { post: { samples: 4 } }],
        ['泛光（5 级）', { post: { bloom: { levels: 5 } } }],
        ['景深（1/2 分辨率，maxBlur 16）', { post: { dof: {} } }],
        ['体积光（48 步，1/4 分辨率）', { post: { godrays: {} } }],
        ['色差', { post: { chroma: true } }],
        ['胶片颗粒', { post: { grain: true } }],
        ['暗角', { post: { vignette: true } }],
        ['扫描线', { post: { scanlines: true } }],
        ['故障', { post: { glitch: true } }],
        ['色差+颗粒+暗角+扫描线+故障（合成一遍）', { post: { chroma: true, grain: true, vignette: true, scanlines: true, glitch: true } }],
        ['全部后期', { post: { bloom: {}, dof: {}, godrays: {}, chroma: true, grain: true, vignette: true, scanlines: true, glitch: true } }],
        ['软阴影（PCF，2048² 阴影图）', { shadows: true }],
        ['GPU 粒子 1 万', { gpu: 10000 }],
        ['GPU 粒子 10 万', { gpu: 100000 }],
        ['CPU 粒子 1 万', { cpu: 10000 }],
        ['CPU 粒子 10 万', { cpu: 100000 }],
        ['复位 300 个对象（reset）', { extraObjects: 300 }],
      ];
      for (const [name, o] of items) {
        if (o === null) {   // 默认帧缓冲 MSAA：单独建
          const cv = document.createElement('canvas');
          const S = createStage3D({ canvas: cv, width: W, height: H, antialias: true, toneMapping: THREE.ACESFilmicToneMapping });
          S.scene.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 2), new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6, roughness: 0.35 })));
          const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x404040 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -1.3;
          const dl = new THREE.DirectionalLight(0xffffff, 2.5); dl.position.set(3, 6, 4); S.scene.add(ground, dl, new THREE.AmbientLight(0x404050, 0.5));
          S.freeze(); const paint = (t) => { S.camera.position.set(Math.sin(t * 0.3) * 7, 1.2, Math.cos(t * 0.3) * 7); S.camera.lookAt(0, 0, 0); };
          S.frame(0, paint); S.finish(); const ts = [];
          for (let i = 0; i < N; i++) { const a = now(); S.frame(1 + i * 0.37, paint); S.finish(); ts.push(now() - a); }
          ts.sort((a, b) => a - b); out[name] = { ms: +ts[N >> 1].toFixed(1), min: +ts[0].toFixed(1) };
          S.renderer.dispose(); S.renderer.forceContextLoss(); continue;
        }
        out[name] = time(o);
      }
      // 复位本身：同一个 300 对象场景，reset() 单独计时
      { const { S } = build({ extraObjects: 300 }); const ts = []; for (let i = 0; i < 50; i++) { const a = now(); S.reset(); ts.push(now() - a); } ts.sort((a, b) => a - b); out['reset() 单独（303 对象）'] = { ms: +ts[25].toFixed(3) }; }
      return out;
    }, { W, H, N: quick ? 3 : 7 });
    if (errs.length) { failed = true; console.error(errs.join('\n')); }
    await page.close();
  }
} finally { await browser.close(); close(); }

const load1 = loadavg()[0];
if (asJson) console.log(JSON.stringify({ load: [load0, load1], results }, null, 1));
else {
  console.log(`SwiftShader · stage3d / post3d / particles3d 每帧耗时（中位数 ms，含 readPixels 1px 同步）  负载 ${load0.toFixed(1)} → ${load1.toFixed(1)}`);
  const names = Object.keys(results[formats[0]]);
  console.log(['项目'.padEnd(34), ...formats.map((f) => `${f} ms  (+增量)`.padStart(20))].join(''));
  for (const n of names) {
    const cells = formats.map((f) => {
      const r = results[f][n], base = results[f]['基准（直接上屏）'].ms;
      const inc = n.startsWith('基准') || n.startsWith('reset()') ? '' : ` (${r.ms - base >= 0 ? '+' : ''}${(r.ms - base).toFixed(1)})`;
      return `${r.ms}${inc}`.padStart(20);
    });
    console.log(n.padEnd(34 - [...n].filter((c) => c.charCodeAt(0) > 255).length) + cells.join(''));
  }
}
process.exit(failed ? 1 : 0);
