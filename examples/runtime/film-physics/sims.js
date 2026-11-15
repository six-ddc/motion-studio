// 策略 2/3 用的定步仿真体。每个工厂返回 { init, step, clone, draw? }，交给 createReplay()
// 或 scripts/bake.mjs。全部零依赖、Node 与浏览器都能跑（bake 在 Node 里跑同一份代码）。
//
// 约定：
//   - 全部可变量都在 state 里（Float64Array），clone 用 slice()——便宜且完整。
//   - 随机只用 hash01(seed, stepIndex, k)。
//   - "草稿"缓冲（网格 head/next）放在闭包里是允许的：每一步开头全部重写，不跨步携带信息。
//   - 只读参数（半径、出生步号）放在闭包里也允许：从不被写。
//   - 坐标是"仿真单位"，scene 用 layout 的 size()/place() 换算成像素，不写死。
import { hash01 } from './rand.js';
// 一维跟随链（跟车/排队/沿一串单元传回去的波）单独成文件，这里转出，bake.mjs / bench.mjs 的 --sim chain 走这条。
export { chain } from './chain.js';

// 均匀网格邻居查询（草稿缓冲，每步重建）
function makeGrid(cell, W, H, N) {
  const gw = Math.max(1, Math.ceil(W / cell) + 2), gh = Math.max(1, Math.ceil(H / cell) + 2);
  const head = new Int32Array(gw * gh), next = new Int32Array(N);
  const cx = (x) => Math.min(gw - 1, Math.max(0, Math.floor(x / cell) + 1));
  const cy = (y) => Math.min(gh - 1, Math.max(0, Math.floor(y / cell) + 1));
  return {
    build(xs, ys, active) {
      head.fill(-1);
      for (let i = 0; i < N; i++) {
        if (active && !active(i)) continue;
        const c = cy(ys[i]) * gw + cx(xs[i]);
        next[i] = head[c]; head[c] = i;
      }
    },
    // 对 i 的 3×3 邻域中每个 j > i 调 fn(i, j)；顺序由数组下标决定 → 确定性
    pairs(i, xs, ys, fn) {
      const gx = cx(xs[i]), gy = cy(ys[i]);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const x = gx + ox, y = gy + oy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        for (let j = head[y * gw + x]; j !== -1; j = next[j]) if (j > i) fn(i, j);
      }
    },
    neighbors(i, xs, ys, fn) {
      const gx = cx(xs[i]), gy = cy(ys[i]);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const x = gx + ox, y = gy + oy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        for (let j = head[y * gw + x]; j !== -1; j = next[j]) if (j !== i) fn(j);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 刚体圆：重力 + 墙 + 两两碰撞（位置修正 + 冲量）。分批出生，记录强碰撞事件。
// ---------------------------------------------------------------------------
export function balls({ seed = 1, n = 300, W = 1000, H = 1600, g = 2400, rMin = 10, rMax = 22, e = 0.5, spawnOver = 2, fps = 60, substeps = 4, hitSpeed = 900 }) {
  const r = new Float64Array(n), born = new Int32Array(n);
  const stepsPerSec = fps * substeps;
  for (let i = 0; i < n; i++) {
    r[i] = rMin + (rMax - rMin) * hash01(seed, i, 1);
    born[i] = Math.floor(hash01(seed, i, 2) * spawnOver * stepsPerSec);
  }
  const grid = makeGrid(rMax * 2, W, H, n);
  return {
    r, born,
    init() {
      const s = { x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
        hitT: new Float64Array(8).fill(-1e9), hitHead: new Float64Array(1) };
      for (let i = 0; i < n; i++) {
        s.x[i] = rMax + (W - 2 * rMax) * hash01(seed, i, 3);
        s.y[i] = -rMax - H * 0.2 * hash01(seed, i, 4);
        s.vx[i] = (hash01(seed, i, 5) - 0.5) * 600;
        s.vy[i] = 0;
      }
      return s;
    },
    clone: (s) => ({ x: s.x.slice(), y: s.y.slice(), vx: s.vx.slice(), vy: s.vy.slice(), hitT: s.hitT.slice(), hitHead: s.hitHead.slice() }),
    step(s, dt, k) {
      const { x, y, vx, vy } = s;
      const alive = (i) => k >= born[i];
      for (let i = 0; i < n; i++) {
        if (!alive(i)) continue;
        vy[i] += g * dt; x[i] += vx[i] * dt; y[i] += vy[i] * dt;
        if (x[i] < r[i]) { x[i] = r[i]; vx[i] = -vx[i] * e; }
        if (x[i] > W - r[i]) { x[i] = W - r[i]; vx[i] = -vx[i] * e; }
        if (y[i] > H - r[i]) {
          if (vy[i] > hitSpeed) { s.hitT[s.hitHead[0] % 8] = k * dt; s.hitHead[0]++; }
          y[i] = H - r[i]; vy[i] = -vy[i] * e; vx[i] *= 0.98;
        }
      }
      grid.build(x, y, alive);
      for (let i = 0; i < n; i++) {
        if (!alive(i)) continue;
        grid.pairs(i, x, y, (a, b) => {
          const dx = x[b] - x[a], dy = y[b] - y[a], rr = r[a] + r[b], d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 === 0) return;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = (rr - d) * 0.5;
          x[a] -= nx * pen; y[a] -= ny * pen; x[b] += nx * pen; y[b] += ny * pen;
          const rv = (vx[b] - vx[a]) * nx + (vy[b] - vy[a]) * ny;
          if (rv < 0) { const j = -(1 + e) * rv * 0.5; vx[a] -= j * nx; vy[a] -= j * ny; vx[b] += j * nx; vy[b] += j * ny; }
        });
      }
    },
    // 给 bake 用：每帧导出的字段
    pack: (s) => [s.x, s.y],
  };
}

// ---------------------------------------------------------------------------
// 布料 / 绳索：Verlet 积分 + 距离约束迭代。顶排钉住，风来自 hash(步号)。
// cols=1 就是一根绳。
// ---------------------------------------------------------------------------
export function cloth({ seed = 3, cols = 24, rows = 16, spacing = 20, ox = 100, oy = 100, g = 1800, wind = 900, iters = 8, damping = 0.995 }) {
  const n = cols * rows;
  const links = [];
  const id = (c, r) => r * cols + c;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c + 1 < cols) links.push(id(c, r), id(c + 1, r));
    if (r + 1 < rows) links.push(id(c, r), id(c, r + 1));
  }
  const L = Int32Array.from(links);
  const pinned = (i) => i < cols && (i % 4 === 0 || i === cols - 1);
  return {
    n, cols, rows, links: L,
    init() {
      const s = { x: new Float64Array(n), y: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n) };
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = id(c, r); s.x[i] = s.px[i] = ox + c * spacing; s.y[i] = s.py[i] = oy + r * spacing;
      }
      return s;
    },
    clone: (s) => ({ x: s.x.slice(), y: s.y.slice(), px: s.px.slice(), py: s.py.slice() }),
    step(s, dt, k) {
      const { x, y, px, py } = s;
      // 阵风：每 0.25 秒换一个强度，用步号 hash，不用顺序 rng
      const gust = Math.floor(k * dt * 4);
      const wx = wind * (0.4 + hash01(seed, gust, 0)) * Math.sin(k * dt * 1.7);
      for (let i = 0; i < n; i++) {
        if (pinned(i)) continue;
        const vx = (x[i] - px[i]) * damping, vy = (y[i] - py[i]) * damping;
        px[i] = x[i]; py[i] = y[i];
        const flutter = 0.5 + hash01(seed, i, 1);
        x[i] += vx + wx * flutter * dt * dt;
        y[i] += vy + g * dt * dt;
      }
      for (let it = 0; it < iters; it++) {
        for (let l = 0; l < L.length; l += 2) {
          const a = L[l], b = L[l + 1];
          const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
          const diff = (d - spacing) / d;
          const pa = pinned(a), pb = pinned(b);
          const wa = pa ? 0 : pb ? 1 : 0.5, wb = pb ? 0 : pa ? 1 : 0.5;
          x[a] += dx * diff * wa; y[a] += dy * diff * wa;
          x[b] -= dx * diff * wb; y[b] -= dy * diff * wb;
        }
      }
    },
    pack: (s) => [s.x, s.y],
  };
}

// ---------------------------------------------------------------------------
// 群集 boids：分离 / 对齐 / 聚合 + 限速，环面边界。
// ---------------------------------------------------------------------------
export function boids({ seed = 5, n = 300, W = 1000, H = 1600, view = 60, sep = 22, maxSpeed = 320, wSep = 1.6, wAli = 1.0, wCoh = 0.7 }) {
  const grid = makeGrid(view, W, H, n);
  return {
    init() {
      const s = { x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        s.x[i] = W * hash01(seed, i, 0); s.y[i] = H * hash01(seed, i, 1);
        const a = hash01(seed, i, 2) * Math.PI * 2; s.vx[i] = Math.cos(a) * maxSpeed * 0.6; s.vy[i] = Math.sin(a) * maxSpeed * 0.6;
      }
      return s;
    },
    clone: (s) => ({ x: s.x.slice(), y: s.y.slice(), vx: s.vx.slice(), vy: s.vy.slice() }),
    step(s, dt) {
      const { x, y, vx, vy } = s;
      grid.build(x, y);
      const ax = new Float64Array(n), ay = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let cnt = 0, cxs = 0, cys = 0, avx = 0, avy = 0, sx = 0, sy = 0;
        grid.neighbors(i, x, y, (j) => {
          const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy;
          if (d2 > view * view) return;
          cnt++; cxs += dx; cys += dy; avx += vx[j]; avy += vy[j];
          if (d2 < sep * sep && d2 > 0) { const d = Math.sqrt(d2); sx -= dx / d * (sep - d); sy -= dy / d * (sep - d); }
        });
        if (cnt) {
          ax[i] = wCoh * cxs / cnt + wAli * (avx / cnt - vx[i]) * 0.5 + wSep * sx * 4;
          ay[i] = wCoh * cys / cnt + wAli * (avy / cnt - vy[i]) * 0.5 + wSep * sy * 4;
        }
      }
      for (let i = 0; i < n; i++) {
        vx[i] += ax[i] * dt * 3; vy[i] += ay[i] * dt * 3;
        const sp = Math.hypot(vx[i], vy[i]);
        if (sp > maxSpeed) { vx[i] *= maxSpeed / sp; vy[i] *= maxSpeed / sp; }
        if (sp < maxSpeed * 0.3 && sp > 0) { vx[i] *= maxSpeed * 0.3 / sp; vy[i] *= maxSpeed * 0.3 / sp; }
        x[i] = ((x[i] + vx[i] * dt) % W + W) % W; y[i] = ((y[i] + vy[i] * dt) % H + H) % H;
      }
    },
    pack: (s) => [s.x, s.y],
  };
}

// ---------------------------------------------------------------------------
// 流体近似：Clavet 2005 "双密度松弛"（粒子流体，不是网格 NS）。
// 观感是"一盆水/一摊浆"，不是精确流体；不可压缩性靠松弛次数，粒子多了会慢。
// ---------------------------------------------------------------------------
export function fluid({ seed = 9, n = 600, W = 1000, H = 1600, h = 36, g = 1800, k = 0.004, kNear = 0.01, rest = 6, visc = 0.1 }) {
  const grid = makeGrid(h, W, H, n);
  return {
    init() {
      const s = { x: new Float64Array(n), y: new Float64Array(n), px: new Float64Array(n), py: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n) };
      const cols = Math.ceil(Math.sqrt(n * 0.6));
      for (let i = 0; i < n; i++) {
        s.x[i] = W * 0.1 + (i % cols) * h * 0.45 + hash01(seed, i, 0);
        s.y[i] = H * 0.15 + Math.floor(i / cols) * h * 0.45 + hash01(seed, i, 1);
      }
      return s;
    },
    clone: (s) => ({ x: s.x.slice(), y: s.y.slice(), px: s.px.slice(), py: s.py.slice(), vx: s.vx.slice(), vy: s.vy.slice() }),
    step(s, dt) {
      const { x, y, px, py, vx, vy } = s;
      for (let i = 0; i < n; i++) { vy[i] += g * dt; px[i] = x[i]; py[i] = y[i]; x[i] += vx[i] * dt; y[i] += vy[i] * dt; }
      grid.build(x, y);
      for (let i = 0; i < n; i++) {
        let rho = 0, rhoN = 0;
        grid.neighbors(i, x, y, (j) => { const q = 1 - Math.hypot(x[j] - x[i], y[j] - y[i]) / h; if (q > 0) { rho += q * q; rhoN += q * q * q; } });
        const P = k * (rho - rest) / (dt * dt * 3600), PN = kNear * rhoN / (dt * dt * 3600);
        let dx = 0, dy = 0;
        grid.neighbors(i, x, y, (j) => {
          const rx = x[j] - x[i], ry = y[j] - y[i], d = Math.hypot(rx, ry), q = 1 - d / h;
          if (q <= 0 || d === 0) return;
          const D = (dt * dt * 3600) * (P * q + PN * q * q) * 0.5, ux = rx / d * D, uy = ry / d * D;
          x[j] += ux; y[j] += uy; dx -= ux; dy -= uy;
          // 简化粘性：向邻居速度靠拢
          const mvx = (vx[j] - vx[i]) * visc * q, mvy = (vy[j] - vy[i]) * visc * q;
          vx[i] += mvx * 0.5; vy[i] += mvy * 0.5; vx[j] -= mvx * 0.5; vy[j] -= mvy * 0.5;
        });
        x[i] += dx; y[i] += dy;
      }
      for (let i = 0; i < n; i++) {
        if (x[i] < 4) x[i] = 4; if (x[i] > W - 4) x[i] = W - 4;
        if (y[i] > H - 4) y[i] = H - 4; if (y[i] < 4) y[i] = 4;
        vx[i] = (x[i] - px[i]) / dt; vy[i] = (y[i] - py[i]) / dt;
      }
    },
    pack: (s) => [s.x, s.y],
  };
}
