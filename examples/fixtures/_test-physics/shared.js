// film-physics 测试片的共享装配代码。每个子目录的 scene.html 只调一个 mount*。
// ./runtime/*.js 由 film-core 的服务器挂载（套件里的现行版本，夹具不冻结副本）。
// 变体参数来自 window.CFG（入口 html 里设），其次 URL query。
import { makeLayout } from './runtime/layout.js';
import { seeded, wrap } from './runtime/motion.js';
import { ballistic, bounce, emitter, wobble, hitShake, flash, squash, trail, orbit, hitstop } from './runtime/closed.js';
import { createReplay } from './runtime/replay.js';
import { balls, cloth, boids, fluid } from './runtime/sims.js';
import { loadBake } from './runtime/baked.js';

const QS = new URLSearchParams(location.search);
const CFG = window.CFG || {};
const Q = { get: (k) => (k in CFG ? String(CFG[k]) : QS.get(k)) };
const FORMAT = Q.get('format') || '9x16';
const L = makeLayout(FORMAT);
const canvas = document.getElementById('stage');
canvas.width = L.width; canvas.height = L.height;
const ctx = canvas.getContext('2d', { alpha: false });
// 仿真单位：宽 1000，高按画幅比例。像素 = 单位 × U
const U = L.width / 1000, SW = 1000, SH = 1000 * L.height / L.width;
const BG = '#101418', FG = '#e8e2d4', ACC = '#e0603a';

function clear(cam) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, L.width, L.height);
  ctx.setTransform(U, 0, 0, U, (cam?.x ?? 0) * U, (cam?.y ?? 0) * U);
}
function dots(xs, ys, n, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < n; i++) { const rr = typeof r === 'number' ? r : r[i]; ctx.moveTo(xs[i] + rr, ys[i]); ctx.arc(xs[i], ys[i], rr, 0, Math.PI * 2); }
  ctx.fill();
}
const fps = Number(Q.get('fps') || 60);

// ---------------------------------------------------------------------------
// 策略 1：闭式。循环雪 + 12 个弹跳球（压扁、屏震、闪白、拖尾、顿帧）+ 轨道
// ---------------------------------------------------------------------------
export function mountClosed() {
  const LOOP = 4;
  const RATE = Number(Q.get('rate') || 500); // 500/s × 4s 寿命 = 2000 个在场
  const snow = emitter({ seed: 11, rate: RATE, life: LOOP, loop: LOOP });
  const BALLS = 12;
  const ballHits = []; // 每个球的触地时刻（闭式算出，与 t 无关 → 预计算是常量，不是状态）
  for (let b = 0; b < BALLS; b++) {
    for (let tt = 0; tt < LOOP; tt += 1 / 240) {
      const s = bounce(tt - b * 0.12, -40, 0, 2400, SH * 0.82, 0.55);
      if (s.hits > 0 && s.hits < 4 && !ballHits.some((h) => Math.abs(h - s.lastHit - b * 0.12) < 1e-6)) ballHits.push(s.lastHit + b * 0.12);
    }
  }
  ballHits.sort((a, b) => a - b);
  const bigHits = ballHits.filter((_, i) => i % 3 === 0);
  function frame(tRaw) {
    const t = wrap(tRaw, LOOP);
    const tw = hitstop(t, bigHits, 0.03);
    const cam = hitShake(t, bigHits, { amp: 10, decay: 14, freq: 35 });
    clear(cam);
    // 雪：弹道 + 线性阻力 + 位移噪声摇摆
    const ps = snow(t);
    ctx.fillStyle = FG; ctx.beginPath();
    for (const p of ps) {
      const x0 = p.r(0) * SW, v0 = { x: (p.r(1) - 0.5) * 40, y: 30 + p.r(2) * 60 };
      const q = ballistic(p.age, { x: x0, y: -20 }, v0, { x: 0, y: 260 }, 1.6);
      const x = q.x + 18 * wobble(p.age * 1.3 + p.r(3) * 10, 3);
      const y = -20 + (q.y + 20) % (SH + 40);
      const r = 1.5 + 2.5 * p.r(4);
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    // 弹跳球 + 拖尾 + 压扁
    for (let b = 0; b < BALLS; b++) {
      const x = SW * (0.1 + 0.8 * b / (BALLS - 1));
      const pos = (tt) => bounce(tt - b * 0.12, -40, 0, 2400, SH * 0.82, 0.55).y;
      const pts = trail((tt) => pos(tt), tw, 6, 1 / 60);
      ctx.fillStyle = ACC;
      pts.forEach((y, k) => { ctx.globalAlpha = 0.15 * (6 - k) / 6; ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1;
      const s = bounce(tw - b * 0.12, -40, 0, 2400, SH * 0.82, 0.55);
      const sq = squash(tw - b * 0.12, s.lastHit, Math.min(0.45, s.impactSpeed / 4000));
      ctx.beginPath(); ctx.ellipse(x, s.y + 24 * (1 - sq.sy), 24 * sq.sx, 24 * sq.sy, 0, 0, Math.PI * 2); ctx.fill();
    }
    // 轨道
    const c = { x: SW / 2, y: SH * 0.35 };
    ctx.fillStyle = FG;
    for (let k = 0; k < 5; k++) {
      const o = orbit(t, { a: 80 + k * 55, e: 0.3, period: LOOP / (k + 1), phase: k, rot: k * 0.7 });
      ctx.beginPath(); ctx.arc(c.x + o.x, c.y + o.y, 8, 0, Math.PI * 2); ctx.fill();
    }
    const fl = flash(t, bigHits, 0.08);
    if (fl > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = fl * 0.25; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, L.width, L.height); ctx.globalAlpha = 1; }
  }
  // film-motion seamcheck 门 3a 比 frame(DURATION) 与 frame(0)：DURATION 就是周期
  window.DURATION = LOOP;
  window.seek = (t) => { frame(t); return true; };
  window.ready = Promise.resolve();
  window.PARTICLES = RATE * LOOP + BALLS + 5;
}

// ---------------------------------------------------------------------------
// 策略 2：定步重放。碰撞球 + 布料 + boids + 流体，四个 Replay 并存。
// leak: 'ref' 检查点存引用 / 'rng' 外部顺序随机 / 'nocp' 不回退 —— 都是故意的 bug
// ---------------------------------------------------------------------------
export function mountReplay({ leak = Q.get('leak'), which = Q.get('which') || 'balls,cloth,boids,fluid', duration = Number(Q.get('dur') || 6) } = {}) {
  const want = new Set(which.split(','));
  const nBalls = Number(Q.get('n') || 300);
  const parts = [];
  if (want.has('balls')) {
    const sim = balls({ n: nBalls, W: SW, H: SH * 0.95, fps });
    let step = sim.step;
    if (leak === 'rng') {
      const rng = seeded(42); // ✗ 闭包里的顺序 rng：恢复检查点时它不回退
      step = (s, dt, k) => { sim.step(s, dt, k); for (let i = 0; i < 8; i++) s.vx[i] += (rng() - 0.5) * 30; };
    }
    const R = createReplay({ fps, substeps: 4, init: sim.init, step, clone: sim.clone, checkpointEvery: 1, leak: leak === 'rng' ? null : leak });
    parts.push({ name: 'balls', R, draw(s, t) {
      const hits = Array.from(s.hitT).filter((h) => h > -1e8);
      return { cam: hitShake(t, hits, { amp: 6, decay: 16 }), paint: () => dots(s.x, s.y, nBalls, sim.r, ACC) };
    } });
  }
  if (want.has('cloth')) {
    const sim = cloth({ cols: 26, rows: 16, spacing: 22, ox: SW / 2 - 13 * 22, oy: SH * 0.06 });
    const R = createReplay({ fps, substeps: 4, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1, leak: leak === 'rng' ? null : leak });
    parts.push({ name: 'cloth', R, draw: (s) => ({ paint: () => {
      ctx.strokeStyle = FG; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let l = 0; l < sim.links.length; l += 2) { const a = sim.links[l], b = sim.links[l + 1]; ctx.moveTo(s.x[a], s.y[a]); ctx.lineTo(s.x[b], s.y[b]); }
      ctx.stroke();
    } }) });
  }
  if (want.has('boids')) {
    const sim = boids({ n: 250, W: SW, H: SH });
    const R = createReplay({ fps, substeps: 1, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1, leak: leak === 'rng' ? null : leak });
    parts.push({ name: 'boids', R, draw: (s) => ({ paint: () => {
      ctx.strokeStyle = '#7fb0c8'; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < 250; i++) { const sp = Math.hypot(s.vx[i], s.vy[i]) || 1; ctx.moveTo(s.x[i], s.y[i]); ctx.lineTo(s.x[i] - s.vx[i] / sp * 14, s.y[i] - s.vy[i] / sp * 14); }
      ctx.stroke();
    } }) });
  }
  if (want.has('fluid')) {
    const sim = fluid({ n: 400, W: SW * 0.5, H: SH * 0.4 });
    const R = createReplay({ fps, substeps: 2, init: sim.init, step: sim.step, clone: sim.clone, checkpointEvery: 1, leak: leak === 'rng' ? null : leak });
    parts.push({ name: 'fluid', R, draw: (s) => ({ paint: () => {
      ctx.save(); ctx.translate(SW * 0.25, SH * 0.58); dots(s.x, s.y, 400, 7, 'rgba(90,160,230,0.8)'); ctx.restore();
    } }) });
  }
  function frame(t) {
    const drawn = parts.map((p) => p.draw(p.R.stateAt(t), t));
    clear(drawn.find((d) => d.cam)?.cam);
    for (const d of drawn) d.paint();
  }
  window.DURATION = duration;
  window.seek = (t) => { frame(t); return true; };
  window.ready = Promise.resolve();
  window.PHYS = { parts: parts.map((p) => ({ name: p.name, stats: p.R.stats, cps: p.R.checkpoints })) };
  window.PARTICLES = parts.length;
}

// ---------------------------------------------------------------------------
// 策略 3：查表。烘焙文件由 skills/film-physics/scripts/bake.mjs 生成。
// ---------------------------------------------------------------------------
export function mountBaked({ base = Q.get('bake') || './assets/balls', n = Number(Q.get('n') || 300) } = {}) {
  let track = null;
  const sim = balls({ n, W: SW, H: SH * 0.95, fps }); // 只用来拿半径（只读常量）
  window.ready = (async () => {
    track = await loadBake(base);
    window.DURATION = track.duration;
  })();
  window.seek = (t) => { const f = track.frame(t); clear(); dots(f.x, f.y, track.n, sim.r, ACC); return true; };
}
