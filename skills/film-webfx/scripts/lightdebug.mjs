#!/usr/bin/env node
// 光从哪来：同一帧逐个关掉一个光贡献源重渲，报区域/最亮点的亮度差。诊断工具，不是门。
//
//   node <film-webfx>/scripts/lightdebug.mjs --film <slug> --at 2.0 [--rect x,y,w,h] [--px x,y] [--only a,b] [--save]
//
// 做法：加载前注入 globalThis.WEBFX_DEBUG。sky3d / ground3d / post3d 只在它存在时登记自己（平时是一次可选链空操作，
// 着色器、uniform、渲染顺序都不变，所以不影响门和成片）。注入的实现把 S.renderer.render 包一层：画 S.scene 之前
// 按"本次关掉的源"临时改值（灯强度 0、环境强度 0、日盘/日晕权重 0、反射矩阵置零、涟漪幅度 0、雾量上限 0、
// 自发光 0、加色网格隐藏），画完原样还原；泛光是把那一帧后期参数的 bloom.strength 换成 0。平面反射的那次绘制也走
// 同一个包装，所以"关日盘"同时关掉它在积水里的倒影。
// 读数：截图（色调映射后的显示值）解码成线性亮度 Y = .2126R + .7152G + .0722B（0–1），Δ = 原图 − 关掉后。
// 色调映射、泛光、雾都不是线性的，各项 Δ 之和不等于总亮度；Δ 为负表示关掉它反而更亮（例如雾或遮挡）。
//
// 前提：片子用了 stage3d + 至少 sky3d / ground3d / post3d 之一（它们把舞台 S 交给钩子）；都没用时直接报错。
// 退出码：0 出了报告；1 页面报错 / 没有可关的源；2 用法错。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene, launchBrowser, filmBackend } from '../../film-core/lib/browser.mjs';
import { serve } from '../../film-core/lib/serve.mjs';

const args = parseArgs({
  usage: 'node lightdebug.mjs --film <slug> --at <t> [--rect x,y,w,h] [--px x,y] [--only a,b] [--save] [--entry x.html] [--format 16x9]',
  about: '同一帧逐个关掉一个光贡献源（每盏灯、环境/IBL、日盘、日晕、天空、雾、平面反射、涟漪、自发光、加色粒子、泛光）重渲，报亮度差',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    at: ['<t>', '时刻（秒，必填）'], rect: ['<x,y,w,h>', '测量区域（#stage 截图的像素坐标；默认整帧）'],
    px: ['<x,y>', '另报这个像素（3×3 平均）；不给就报区域里最亮的那个'],
    only: ['<id,id>', '只试这些源（id 见输出第一段）'], save: '把每种关法的截图写到 out/lightdebug/',
  },
});

// 加载前注入：调试钩子的全部实现。运行时只调 register()。
const HOOK = () => {
  const off = new Set(), stages = new Set(), wrapped = new WeakSet();
  const reg = { sky: [], fog: [], ground: [], reflection: [], post: [] };
  const lights = (scene) => { const a = []; scene.traverse((o) => { if (o.isLight) a.push(o); }); return a; };
  const lid = (l, i) => `light${i}:${l.type}${l.name ? `(${l.name})` : ''}`;
  const mats = (o) => (o.material ? [].concat(o.material) : []);
  function apply(scene) {
    const undo = [];
    const set = (o, k, v) => { undo.push([o, k, o[k]]); o[k] = v; };
    lights(scene).forEach((l, i) => { if (off.has(lid(l, i))) set(l, 'intensity', 0); });
    if (off.has('environment')) set(scene, 'environmentIntensity', 0);
    if (off.has('emissive') || off.has('additive')) scene.traverse((o) => {
      for (const m of mats(o)) {
        if (off.has('emissive') && m.emissive && m.emissiveIntensity > 0) set(m, 'emissiveIntensity', 0);
        if (off.has('additive') && m.blending === 2 && o.visible) set(o, 'visible', false);   // THREE.AdditiveBlending
      }
    });
    for (const s of reg.sky) {
      const U = s.material.uniforms;
      if (off.has('sky.disk')) set(U.uDisk.value, 'z', 0);
      if (off.has('sky.halo')) for (const k of ['x', 'y', 'z', 'w']) set(U.uHaloW.value, k, 0);
      if (off.has('sky')) set(s.mesh, 'visible', false);
    }
    if (off.has('fog')) for (const f of reg.fog) set(f.node, 'maxOpacity', 0);
    if (off.has('ripple')) for (const g of reg.ground) if (g.uniforms.uGRipShape) set(g.uniforms.uGRipShape.value, 'w', 0);
    if (off.has('reflection')) for (const r of reg.reflection) for (let i = 0; i < 16; i++) set(r.matrix.elements, i, 0);   // w=0 → 着色器跳过反射
    return () => { for (let i = undo.length - 1; i >= 0; i--) { const [o, k, v] = undo[i]; o[k] = v; } };
  }
  function hook(S) {
    if (!S?.renderer || wrapped.has(S.renderer)) return;
    wrapped.add(S.renderer); stages.add(S);
    const r = S.renderer, orig = r.render;
    r.render = function (scene, camera) {
      if (!off.size || scene !== S.scene) return orig.call(this, scene, camera);
      const undo = apply(scene);
      try { return orig.call(this, scene, camera); } finally { undo(); }
    };
  }
  globalThis.WEBFX_DEBUG = {
    register(kind, p) {
      if (!reg[kind]) return;
      reg[kind].push(p); if (p.S) hook(p.S);
      if (kind === 'post') {
        const orig = p.post.render;
        p.post.render = (t, P) => orig(t, off.has('bloom') && P?.bloom ? { ...P, bloom: { ...P.bloom, strength: 0 } } : P);
      }
    },
    setOff(ids) { off.clear(); for (const x of ids) off.add(x); },
    list() {
      const out = [];
      for (const S of stages) {
        lights(S.scene).forEach((l, i) => out.push({ id: lid(l, i), what: `强度 ${+l.intensity.toFixed(3)}，色 #${l.color.getHexString()}${l.castShadow ? '，投影' : ''}` }));
        if (S.scene.environment) out.push({ id: 'environment', what: `scene.environment（IBL）强度 ${S.scene.environmentIntensity}` });
        let em = 0, add = 0;
        S.scene.traverse((o) => { for (const m of mats(o)) { if (m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) em++; if (m.blending === 2) add++; } });
        if (em) out.push({ id: 'emissive', what: `${em} 个自发光材质（emissiveIntensity → 0）` });
        if (add) out.push({ id: 'additive', what: `${add} 个加色混合网格（火花/雨/光斑，隐藏）` });
      }
      if (reg.sky.length) out.push({ id: 'sky.disk', what: '日/月盘（含它在反射里的倒影）' }, { id: 'sky.halo', what: '日晕' }, { id: 'sky', what: '整片天空网格（露出清屏色）' });
      if (reg.fog.length) out.push({ id: 'fog', what: '解析高度雾（maxOpacity → 0）' });
      if (reg.reflection.length) out.push({ id: 'reflection', what: '平面反射（积水处退回环境镜面）' });
      if (reg.ground.some((g) => g.uniforms.uGRipShape)) out.push({ id: 'ripple', what: '雨滴涟漪法线（amplitude → 0）' });
      if (reg.post.some((p) => p.post.effects?.bloom)) out.push({ id: 'bloom', what: '泛光（bloom.strength → 0）' });
      return out;
    },
    reg,
  };
};

// 解码截图并量亮度（在一张空白页里做，不碰场景页）。keep = 这张是全开的原图：记下区域亮度，之后的各张与它逐像素比
const MEASURE = async ([b64, rect, px, keep]) => {
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data, W = bmp.width, H = bmp.height;
  const [rx, ry, rw, rh] = rect ?? [0, 0, W, H];
  if (rx < 0 || ry < 0 || rw < 1 || rh < 1 || rx + rw > W || ry + rh > H || (px && (px[0] < 0 || px[1] < 0 || px[0] >= W || px[1] >= H)))
    return { error: `--rect / --px 超出截图 ${W}×${H}（坐标是 #stage 截图的像素）` };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const Y = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]); };
  const box = (x, y) => { let s = 0, n = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const u = x + i, v = y + j; if (u >= 0 && v >= 0 && u < W && v < H) { s += Y(u, v); n++; } } return s / n; };
  const ys = new Float64Array(rw * rh), ref = keep ? null : globalThis.__lightBase;
  let sum = 0, abs = 0, changed = 0, best = -1, bx = rx, by = ry, k = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++, k++) {
    const v = (ys[k] = Y(x, y)); sum += v;
    if (ref) { const e = Math.abs(ref[k] - v); abs += e; if (e > 0) changed++; }
    if (!px && v > best) { best = v; bx = x; by = y; }
  }
  if (keep) globalThis.__lightBase = ys;
  const p = px ?? [bx, by];
  return { mean: sum / ys.length, abs: abs / ys.length, changed, px: p, at: box(p[0], p[1]) };
};

await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const t = args.num('at', null);
  if (t == null) fail('--at <t> 必填', 2);
  const ints = (n, k) => { const v = args.flag(n, null); if (v == null) return null; const a = v.split(',').map(Number); if (a.length !== k || !a.every(Number.isInteger)) fail(`--${n} 要 ${k} 个整数（逗号分隔）`, 2); return a; };
  const rectArg = ints('rect', 4), pxArg = ints('px', 2);
  const { port, close: closeServer } = await serve(F.dir, { record: false });
  const browser = await launchBrowser({ backend: filmBackend(F) });
  try {
    const P = await openScene(F, format, { browser, port, initScripts: [HOOK], record: false });
    await P.advance(t);
    const [W, H] = await P.page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }, F.config.stage);
    let ids = await P.page.evaluate(() => globalThis.WEBFX_DEBUG.list());
    if (!ids.length) { await P.close(); fail('没有可关的光源：片子没用 stage3d + sky3d/ground3d/post3d（钩子拿不到舞台）'); }
    const only = args.flag('only', null)?.split(',').map((s) => s.trim()).filter(Boolean);
    if (only) {
      const miss = only.filter((x) => !ids.some((c) => c.id === x));
      if (miss.length) fail(`--only 里有不存在的源：${miss.join(', ')}（现有：${ids.map((c) => c.id).join(', ')}）`, 2);
      ids = ids.filter((c) => only.includes(c.id));
    }
    console.log(`影片 ${F.slug}  入口 ${F.config.entry}  ${format}  #stage ${W}×${H}  t=${t}s  区域 [${(rectArg ?? [0, 0, W, H]).join(',')}]`);
    console.log('光贡献源：');
    for (const c of ids) console.log(`  ${c.id.padEnd(28)} ${c.what}`);

    // 日/月盘方向的镜面倒影落在哪（ground3d.reflectionOf）：低机位时近地平线的盘常被积水镜成一个亮斑
    const mirror = await P.page.evaluate(async (size) => {
      const D = globalThis.WEBFX_DEBUG, sky = D.reg.sky[0], refl = D.reg.reflection[0];
      if (!sky || !refl) return null;
      const { reflectionOf } = await import('/runtime/ground3d.js');
      return { elev: Math.asin(sky.rig.sunDir.y) * 180 / Math.PI, ...reflectionOf(refl.S.camera, refl.planeY, { dir: sky.rig.sunDir.toArray() }, size) };
    }, [W, H]);
    if (mirror) {
      const where = mirror.onScreen ? `落在画面 (${mirror.px.map(Math.round).join(',')})，地面点 (${mirror.ground.map((v) => v.toFixed(2)).join(', ')})` : '不在画面内';
      console.log(`日/月盘仰角 ${mirror.elev.toFixed(1)}°，它在反射平面里的倒影${where}`);
    }

    const dec = await browser.newPage();
    const save = args.has('save');
    const dir = join(F.out, 'lightdebug');
    if (save) mkdirSync(dir, { recursive: true });
    let at = pxArg;   // 第一张（全开）定下最亮像素，之后各张都量同一点
    const shoot = async (offIds, tag) => {
      await P.page.evaluate((x) => globalThis.WEBFX_DEBUG.setOff(x), offIds);
      const png = await P.shot(t);
      if (save) writeFileSync(join(dir, `${String(t).replace('.', 'p')}s-${tag.replace(/[^\w.-]+/g, '_')}.png`), png);
      const m = await dec.evaluate(MEASURE, [png.toString('base64'), rectArg, at, tag === 'base']);
      if (m.error) fail(m.error, 2);
      return m;
    };
    const base = await shoot([], 'base');
    at = base.px;
    const rows = [];
    for (const c of ids) {
      const m = await shoot([c.id], `off-${c.id}`);
      rows.push({ id: c.id, dMean: base.mean - m.mean, abs: m.abs, changed: m.changed, dAt: base.at - m.at });
    }
    const again = await shoot([], 'base-again');
    const pct = (d, b) => (b > 1e-9 ? `${(100 * d / b).toFixed(1).padStart(6)}%` : '     —');
    console.log(`\n原图：区域平均线性亮度 ${base.mean.toFixed(5)}；${pxArg ? '指定像素' : '区域最亮像素'} (${at.join(',')}) 3×3 = ${base.at.toFixed(5)}`);
    console.log(`关掉后变暗多少（Δ = 原图 − 关掉；正 = 它在给这里加光），按${pxArg ? '该像素' : '最亮像素'} |Δ| 排序：`);
    console.log(`  ${'源'.padEnd(26)} ${'像素 Δ'.padStart(9)} ${'占比'.padStart(7)}  ${'区域 Δ'.padStart(9)} ${'占比'.padStart(7)}  ${'区域|Δ|'.padStart(9)}  变了的像素`);
    rows.sort((a, b) => Math.abs(b.dAt) - Math.abs(a.dAt) || b.abs - a.abs);
    const n = (rectArg ? rectArg[2] * rectArg[3] : W * H);
    for (const r of rows) console.log(`  ${r.id.padEnd(26)} ${r.dAt.toFixed(5).padStart(9)} ${pct(r.dAt, base.at)}  ${r.dMean.toFixed(5).padStart(9)} ${pct(r.dMean, base.mean)}  ${r.abs.toFixed(5).padStart(9)}  ${r.changed}/${n}`);
    console.log('  （色调映射/泛光/雾非线性：各项之和不等于总量；负值 = 关掉反而更亮；Δ≈0 而 |Δ| 不为 0 = 只改了分布不改总量，如涟漪）');
    if (again.changed)
      console.log(`⚠ 全开重拍与第一次有 ${again.changed} 个像素不同：钩子没还原干净或场景本身不确定，上面的数字不可信`);
    else console.log('✓ 全开重拍与第一次一致（钩子已还原）');
    if (save) console.log(`截图：${relative(process.cwd(), dir)}/`);
    await dec.close(); await P.close();
  } finally { await browser.close(); closeServer(); }
});
