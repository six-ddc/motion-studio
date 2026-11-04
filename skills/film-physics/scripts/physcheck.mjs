#!/usr/bin/env node
// 物理专用确定性探测 + 性能计时。比 film-core 的 seamcheck 更狠，专抓"缓存/检查点"类泄漏：
//   A 顺序扫  t = t0, t0+step, …, t1，记每帧像素哈希（canvas getImageData → SHA-1）
//   B 按种子打乱同一批时刻再扫，逐帧比哈希        ← 检查点存引用、外部 rng、不回退，都会在这里露馅
//   C 倒序扫一遍再比                              ← 每一帧都触发"回退到检查点"路径
//   D 冷启动：新页面直接 seek(t1)，与 A 比          ← 抓"只有顺序推进才对"的实现
//   E 时间映射（场景声明了 window.PHYS.timeMap 才跑；影片时间 ≠ 仿真时间时用，见 references/timemap.md）
//     E1 S(t) 是纯函数：同一批 t 顺序求一遍、打乱求一遍，逐值相等
//     E2 步号单调：stepsAt(S(t)) 不随 t 回退（声明 reverse 的倒放除外）
//     E3 不顿帧：相邻（子）帧 S 在走、步号却没动 → 仿真查询栅格太粗（慢镜头最常见），倍率 ≥ --dup-rate 时判红
//     E4 喂给 stateAt 的确实是 S(t)：seek(t) 后读 replay 的 stats.lastN，和 stepsAt(S(t)) 比
//        ← 抓"传反了 / 忘了映射 / 用了 S.inv"：这些写法完全确定，B/C/D 全过
//   F 断言（场景声明了 window.PHYS.claims 才跑）：在 [from, to] 的每一帧 seek(t) 后调 test(t)，
//     mode 'all'（默认，每帧都真）或 'any'（至少一帧真）。用来把"不撞""会堵""第 X 秒有车停住"这类
//     **仿真推出来的**事实对着真实画面验，而不是对着手写的意图曲线验。
// 计时（工具侧可以读时钟，场景侧不行）：
//   顺序 seek 单帧 ms、乱序 seek 单帧 ms（均值/最大）、冷启动 seek(t1) ms、整片顺序 seek 总耗时
//
// 用法: node physcheck.mjs --film <slug> --entry replay.html [--t0 0 --t1 3 --step 0.1] [--fps 60] [--seed 7]
//   --films-dir 覆盖 films/ 位置（不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录）。失败 exit 1，用法错 exit 2。
//   --sub N     E3 按 fps×N 的子帧栅格查顿帧（默认 film.json 的 sub；成片要开运动模糊就按渲染时的 sub 传）
//   --dup-rate  E3 判红的倍率下限（默认 0.2：倍率 < 0.2 的定格斜坡尾部只警告，那里每帧运动不到正常的 1/5）
import { parseArgs, resolveFilm, main, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { serve } from '../../film-core/lib/serve.mjs';
import { launchBrowser } from '../../film-core/lib/browser.mjs';
import { importRuntime } from '../../film-core/lib/runtime-node.mjs';

const args = parseArgs({
  usage: 'node physcheck.mjs --film <slug> [--entry replay.html] [--t0 0 --t1 3 --step 0.1] [--fps 60] [--seed 7]',
  about: '物理专用确定性探测 + 性能计时：顺序/打乱/倒序/冷启动逐帧像素哈希比对（A–D），'
    + '场景声明了 window.PHYS.timeMap 时查时间映射（E），声明了 window.PHYS.claims 时逐帧验断言（F）。失败 exit 1，用法错 exit 2。',
  opts: {
    ...FILM_OPTS,
    entry: ['<x.html>', '入口（默认 film.json entry）'], format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    fps: ['<N>', '帧率（默认 film.json fps）'], t0: ['<s>', '起点秒（默认 0）'], t1: ['<s>', '终点秒（默认 3）'],
    step: ['<s>', '采样步长秒（默认 0.1，落在帧栅格上）'], seed: ['<N>', '打乱顺序的种子（默认 7）'],
    sub: ['<N>', 'E3 按 fps×N 的子帧栅格查顿帧（默认 film.json sub）'],
    'dup-rate': ['<x>', 'E3 判红的倍率下限（默认 0.2）'],
  },
});

await main(async () => {
const Film = resolveFilm(args.film, args);
const slug = Film.slug, cfg = Film.config, entry = cfg.entry;
const fps = args.num('fps', cfg.fps);
const t0 = args.num('t0', 0), t1 = args.num('t1', 3), stepT = args.num('step', 0.1);
const seed = args.num('seed', 7);
const format = args.flag('format', cfg.format);
const sub = Math.max(1, args.num('sub', Film.raw.sub ?? 1));   // film.json 没写 sub 时按 1（不取内核默认 4）
const dupRate = args.num('dup-rate', 0.2);
if (!(stepT > 0) || !(fps > 0) || t1 < t0) fail('需要 fps > 0、step > 0、t1 ≥ t0', 2);

const server = await serve(Film.dir);
const url = `${server.url}${Film.entryUrl}?format=${format}`;

// 时刻落在帧栅格上
const times = [];
for (let f = Math.round(t0 * fps); f <= Math.round(t1 * fps) + 1e-9; f += Math.round(stepT * fps)) times.push(f / fps);
const rnd = (await importRuntime('rand.js')).seeded(seed);   // 打乱顺序用全套件同一个 mulberry32
const shuffled = [...times]; for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }

const browser = await launchBrowser();
const errors = [];
async function open() {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.seek === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.ready ?? null);
  await page.evaluate(() => {
    const c = document.querySelector('#stage'), g = c.getContext('2d');
    window.__shot = async (t) => {
      const a = performance.now(); window.seek(t); const ms = performance.now() - a;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const h = await crypto.subtle.digest('SHA-1', d);
      return { ms, h: Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('') };
    };
    window.__run = async (ts) => { const out = []; for (const t of ts) out.push(await window.__shot(t)); return out; };
  });
  return page;
}
const pass = (ts, res) => new Map(ts.map((t, i) => [t, res[i]]));
let bad = 0;
const page = await open();
const A = pass(times, await page.evaluate((ts) => window.__run(ts), times));
const B = pass(shuffled, await page.evaluate((ts) => window.__run(ts), shuffled));
const rev = [...times].reverse();
const C = pass(rev, await page.evaluate((ts) => window.__run(ts), rev));
const cmp = (X, label) => {
  const miss = times.filter((t) => X.get(t).h !== A.get(t).h);
  if (miss.length) bad++;
  console.log(`  ${miss.length ? '✗' : '✓'} ${label}: ${times.length - miss.length}/${times.length} 帧一致${miss.length ? '  首个不一致 t=' + miss[0].toFixed(3) + ' 共 ' + miss.length + ' 帧: ' + miss.slice(0, 8).map((t) => t.toFixed(2)).join(',') : ''}`);
};
console.log(`physcheck ${slug}/${entry}  ${format}  t=${t0}..${t1} 步长 ${stepT}s（${times.length} 帧）@${fps}fps  打乱种子 ${seed}`);
cmp(B, 'B 乱序 vs 顺序');
cmp(C, 'C 倒序 vs 顺序');
// E 时间映射
const E = await page.evaluate(({ fps, sub, times, dupRate }) => {
  const P = window.PHYS;
  if (!P || (!P.timeMap && !(P.parts || []).some((p) => p.timeMap))) return null;
  const D = window.DURATION;
  const fnOf = (m) => (typeof m === 'function' ? m : m && typeof m.S === 'function' ? m.S : null);
  const parts = (P.parts || []).map((p) => { const m = p.timeMap === undefined ? P.timeMap : p.timeMap; return { p, m, S: fnOf(m) }; }).filter((x) => x.S);
  const glob = fnOf(P.timeMap);
  const out = { lines: [], bad: 0, warn: 0 };
  const line = (ok, s, warn = false) => { out.lines.push(`  ${ok ? '✓' : warn ? '⚠' : '✗'} ${s}`); if (!ok && !warn) out.bad++; if (warn) out.warn++; };
  const G = []; for (let f = 0; f <= Math.round(D * fps * sub); f++) G.push(f / (fps * sub));
  // E1
  const maps = [...new Set([glob, ...parts.map((x) => x.S)].filter(Boolean))];
  let e1 = 0, e1t = null;
  for (const S of maps) {
    const a = G.map((t) => S(t));
    const idx = G.map((_, i) => i); let r = 0x9e3779b9; for (let i = idx.length - 1; i > 0; i--) { r = (Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; const j = (r >>> 0) % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const b = new Array(G.length); for (const i of idx) b[i] = S(G[i]);
    for (let i = 0; i < G.length; i++) if (!Object.is(a[i], b[i]) || !Number.isFinite(a[i])) { e1++; if (e1t == null) e1t = G[i]; }
  }
  line(!e1, `E1 S(t) 纯函数（${G.length} 个子帧时刻，顺序 vs 打乱）${e1 ? `：${e1} 处不等，首个 t=${e1t.toFixed(4)}——S 带了跨调用状态` : ''}`);
  if (!parts.length) { line(false, 'E2–E4 未判：PHYS.parts 里没有挂上时间映射的仿真（part.timeMap 或全局 PHYS.timeMap + part.stepsAt）'); return out; }
  for (const { p, m, S } of parts) {
    if (typeof p.stepsAt !== 'function') { line(false, `E2–E4 [${p.name}] 未判：part 缺 stepsAt（写 stepsAt: R.stepsAt），工具没法知道仿真的查询栅格`); continue; }
    const rev = !!(m && m.reverse);
    const N = G.map((t) => p.stepsAt(S(t)));
    let back = 0, backT = null, dupHard = 0, dupSoft = 0, dupT = null, dupR = null;
    for (let i = 1; i < G.length; i++) {
      if (N[i] < N[i - 1]) { back++; if (backT == null) backT = G[i]; }
      const dS = S(G[i]) - S(G[i - 1]);
      if (dS > 0 && N[i] === N[i - 1]) {
        const rate = dS * fps * sub;
        if (rate >= dupRate) { dupHard++; if (dupT == null || rate < dupR) { dupT = G[i]; dupR = rate; } } else dupSoft++;
      }
    }
    if (rev) line(true, `E2 [${p.name}] 声明了倒放（reverse），步号回退 ${back} 次，每次都走检查点重放`);
    else line(!back, `E2 [${p.name}] 步号随 t 单调不减${back ? `：回退 ${back} 次，首个 t=${backT.toFixed(4)}——S 不单调却没声明 reverse` : ''}`);
    const span = (N[N.length - 1] - N[0]);
    const per = p.stepsAt(1) - p.stepsAt(0);                       // 每仿真秒步数
    let q = Infinity; for (let k = 1; k <= 4000; k++) { const d = p.stepsAt(k / 4000) - p.stepsAt((k - 1) / 4000); if (d > 0 && d < q) q = d; }
    const grid = per / q;                                            // 查询栅格：每仿真秒多少个可区分的 stateAt 结果
    line(!dupHard, `E3 [${p.name}] 不顿帧（影片 ${fps}fps×${sub} 子帧，仿真查询栅格 ${grid}/仿真秒）${dupHard ? `：${dupHard} 对相邻子帧落在同一步；要求最高处 t=${dupT.toFixed(3)} 倍率 ${dupR.toFixed(2)}——查询栅格要 ≥ ${fps}×${sub}/${dupR.toFixed(2)} = ${Math.ceil(fps * sub / dupR - 1e-6)}/仿真秒，即 createReplay 的 fps ≥ ${Math.ceil(fps * sub / dupR - 1e-6)}（substeps 相应减小，保持 dt 不变则结果不变）` : ''}${dupSoft ? `（倍率 < ${dupRate} 处另有 ${dupSoft} 对，只警告）` : ''}`, false);
    if (dupSoft && !dupHard) out.warn++;
    if (p.stats.lastN === undefined) { line(false, `E4 [${p.name}] 未判：replay.js 版本太旧没有 stats.lastN（片内 runtime/replay.js 是旧冻结副本：删掉它改用套件那份再交付）`); continue; }
    let mis = 0, misT = null, exp = 0, got = 0;
    for (const t of times) { window.seek(t); const e = p.stepsAt(S(t)); if (p.stats.lastN !== e) { mis++; if (misT == null) { misT = t; exp = e; got = p.stats.lastN; } } }
    line(!mis, `E4 [${p.name}] seek(t) 喂给 stateAt 的步号 = stepsAt(S(t))（${times.length} 帧）${mis ? `：${mis} 帧不符，首个 t=${misT.toFixed(3)} 应为 ${exp} 步（${(exp / per).toFixed(3)} 仿真秒）、实际 ${got} 步（${(got / per).toFixed(3)} 仿真秒）——传反了、忘了映射，或映射声明与实际用的不是同一条` : ''}  总跨度 ${(span / per).toFixed(1)} 仿真秒`);
  }
  return out;
}, { fps, sub, times, dupRate });
if (E) { console.log('  E 时间映射：'); for (const l of E.lines) console.log('  ' + l); bad += E.bad; }
// D 冷启动
const page2 = await open();
const cold = await page2.evaluate((t) => window.__shot(t), times[times.length - 1]);
const coldOk = cold.h === A.get(times[times.length - 1]).h; if (!coldOk) bad++;
console.log(`  ${coldOk ? '✓' : '✗'} D 冷启动直接 seek(${t1}) vs 顺序`);
// 计时
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const seqMs = [...A.values()].map((r) => r.ms), shufMs = [...B.values()].map((r) => r.ms);
const D = await page2.evaluate(() => window.DURATION);
const full = await page2.evaluate(async ({ D, fps }) => {
  const n = Math.round(D * fps), a = performance.now();
  for (let f = 0; f < n; f++) window.seek(f / fps);
  return { n, ms: performance.now() - a };
}, { D, fps });
// F 断言
const F = await page2.evaluate(({ fps }) => {
  const cl = window.PHYS && window.PHYS.claims;
  if (!cl || !cl.length) return null;
  const D = window.DURATION;
  const st = cl.map((c) => ({ c, n: 0, yes: 0, firstNo: null, val: null }));
  for (let f = 0; f <= Math.round(D * fps); f++) {
    const t = f / fps;
    const live = st.filter((x) => t >= (x.c.from ?? 0) - 1e-9 && t <= (x.c.to ?? D) + 1e-9);
    if (!live.length) continue;
    window.seek(t);
    for (const x of live) {
      const r = x.c.test(t); const ok = typeof r === 'object' && r !== null ? !!r.ok : !!r;
      x.n++; if (ok) x.yes++; else if (x.firstNo == null) { x.firstNo = t; if (typeof r === 'object' && r) x.val = r.value; }
    }
  }
  return st.map((x) => { const mode = x.c.mode ?? 'all'; const ok = x.n > 0 && (mode === 'any' ? x.yes > 0 : x.yes === x.n);
    return { ok, s: `${x.c.what}  [${(x.c.from ?? 0).toFixed(2)}–${(x.c.to ?? D).toFixed(2)}s ${mode}]  ${x.yes}/${x.n} 帧为真${!ok && x.firstNo != null && mode === 'all' ? `，首个为假 t=${x.firstNo.toFixed(3)}${x.val != null ? ` 值=${typeof x.val === 'number' ? x.val.toFixed(3) : x.val}` : ''}` : ''}${x.n === 0 ? '（区间里没有帧）' : ''}` }; });
}, { fps });
if (F) { console.log('  F 断言（仿真推出的事实对着真实 seek 验）：'); for (const r of F) { console.log(`    ${r.ok ? '✓' : '✗'} ${r.s}`); if (!r.ok) bad++; } }
const info = await page2.evaluate(() => ({ particles: window.PARTICLES ?? null, phys: window.PHYS ? window.PHYS.parts.map((p) => ({ name: p.name, ...p.stats, cps: p.cps() })) : null }));
console.log();
console.log('计时（含 canvas 绘制，不含截图/哈希）：');
console.log(`  顺序 seek 单帧  均值 ${avg(seqMs).toFixed(2)} ms  最大 ${Math.max(...seqMs).toFixed(2)} ms   （第一帧含冷启动 ${seqMs[0].toFixed(2)} ms）`);
console.log(`  乱序 seek 单帧  均值 ${avg(shufMs).toFixed(2)} ms  最大 ${Math.max(...shufMs).toFixed(2)} ms`);
console.log(`  冷启动 seek(${t1})  ${cold.ms.toFixed(2)} ms`);
console.log(`  整片 ${D}s × ${fps}fps = ${full.n} 帧顺序 seek 总计 ${full.ms.toFixed(0)} ms（${(full.ms / full.n).toFixed(2)} ms/帧）`);
if (info.phys) console.log('  仿真统计: ' + info.phys.map((p) => `${p.name} 步数=${p.stepped} 回退=${p.restores} 检查点=${p.cps}`).join(' | '));
await browser.close(); server.close();
if (errors.length) { console.log(`⚠ 页面错误 ${errors.length} 条: ${errors.slice(0, 3).join(' / ')}`); bad++; }
console.log(bad ? `✗ ${bad} 项未通过` : '✓ 全部通过');
process.exitCode = bad ? 1 : 0;
});
