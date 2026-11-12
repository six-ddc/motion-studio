// _test-events 的装配代码：十几个"撞击"事件同时驱动 闪白 / 屏震 / 粒子爆发 / 弹簧下沉的方块 / 累积贴花。
// 颜色与幅度只是夹具的取值，不是建议。./runtime/*.js 由 film-core 服务器挂载套件现行版本（夹具不冻结）。
import { makeLayout } from './runtime/layout.js';
import { hash01 } from './runtime/rand.js';
import { burst, ballistic } from './runtime/closed.js';
import { eventTrack, channel, flashDecay, holdFrames, throttle, snapToFrames, traumaOf, countRing, toSceneEvents } from './runtime/events.js';
import { traumaShake, shakeTermsFromSeed, springDip, recoil } from './runtime/feel.js';

export function mount({ bad = false } = {}) {
  const L = makeLayout('9x16');
  const W = L.width, H = L.height, FPS = 30, D = 6;
  const canvas = document.getElementById('stage');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const U = W / 1000;

  // 事件表：14 次撞击，x 位置与力度按 hash 取；前 8 次是一串密集连击
  const raw = [];
  for (let i = 0; i < 8; i++) raw.push({ t: 0.6 + i * 0.11 + 0.02 * hash01(4, i, 0), type: 'hit', x: 250 + 500 * hash01(4, i, 1), power: 0.4 + 0.4 * hash01(4, i, 2) });
  for (let i = 8; i < 14; i++) raw.push({ t: 2.2 + (i - 8) * 0.55 + 0.1 * hash01(4, i, 0), type: 'hit', x: 250 + 500 * hash01(4, i, 1), power: 0.5 + 0.5 * hash01(4, i, 2) });
  const hits = snapToFrames(eventTrack(raw), FPS, { minFrames: 2 });            // 闪光峰值落在帧上
  const flashes = throttle(hits, { on: 'hit', minGap: 0.09 });                    // 闪白至少隔 0.09 s
  const flash = channel(flashes, { name: 'flash', response: holdFrames(flashDecay(0.05), { fps: FPS, minFrames: 2 }), combine: 'max' });
  const T = traumaOf(hits, { on: 'hit', add: (e) => 0.18 * e.power + 0.1, decay: 1.2, max: 1 });
  const terms = shakeTermsFromSeed(21, { band: [4, 13], second: 0.6 });
  const dip = springDip(hits, { on: 'hit', impulse: (e) => 900 * e.power, k: 150, c: 11, min: -60, max: 25 });
  const tilt = recoil(hits, { on: 'hit', amount: (e) => 0.03 * (e.x < 500 ? -1 : 1) * e.power, keep: 0.25, rise: 0.03, hold: 0.09, fall: 0.25 });
  const sparks = channel(hits, { name: 'sparks', on: 'hit', response: () => 1, support: 0.9 });
  window.events = () => toSceneEvents(hits, { v: (e) => e.power });

  let accT = 0, lastT = 0; // 只给阴性对照用：跨帧累加的创伤值
  window.DURATION = D;
  window.seek = (t) => {
    let tr = T(t);
    if (bad) { accT = Math.max(0, accT - 1.2 * Math.abs(t - lastT)) + (flash(t) > 0.99 ? 0.3 : 0); lastT = t; tr = Math.min(1, accT); }
    const sh = traumaShake(t, tr, { amp: { pitch: 40, yaw: 40, roll: 0.05 }, terms });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#14171c'; ctx.fillRect(0, 0, W, H);
    ctx.setTransform(U, 0, 0, U, 0, 0);
    ctx.translate(500 + sh.yaw, 900 + sh.pitch); ctx.rotate(sh.roll); ctx.translate(-500, -900);
    // 墙与贴花（最多 10 个，最老 4 个渐隐）
    ctx.fillStyle = '#262b33'; ctx.fillRect(120, 300, 760, 520);
    for (const { e, alpha } of countRing(hits, t, { on: 'hit', size: 10, fade: 4 })) {
      ctx.globalAlpha = alpha; ctx.fillStyle = '#0b0c0e';
      ctx.beginPath(); ctx.arc(e.x, 380 + 360 * hash01(e.key, 3), 10 + 14 * e.power, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 弹簧下沉的方块（位置受撞击冲量）+ 后坐式倾斜
    const by = 1180 + dip(t), r = tilt(t);
    ctx.save(); ctx.translate(500, by); ctx.rotate(r.total);
    ctx.fillStyle = '#c9b48a'; ctx.fillRect(-160, -80, 320, 160); ctx.restore();
    ctx.fillStyle = '#3a3f48'; ctx.fillRect(0, 1300, 1000, 30);
    // 粒子爆发：每个活着的撞击自己一团 burst（closed.js）
    ctx.fillStyle = '#ffd08a';
    for (const { e } of sparks.active(t)) {
      for (const p of burst(t, { at: e.t, count: 26, life: 0.9, seed: e.key })) {
        const a = -Math.PI * (0.1 + 0.8 * p.r(0)), sp = 300 + 700 * p.r(1) * e.power;
        const q = ballistic(p.age, { x: e.x, y: by - 80 }, { x: Math.cos(a) * sp, y: Math.sin(a) * sp }, { x: 0, y: 1400 }, 2.5);
        const s = 7 * (1 - p.u);
        ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      }
    }
    // 闪白
    const f = flash(t);
    if (f > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.85 * f; ctx.fillStyle = '#fff7ea'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  };
}
