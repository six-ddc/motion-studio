#!/usr/bin/env node
// motionprint：运动的"速度指纹"——把一段视频（参考片或自己的成片）或一个场景的运动手感量成数字。
//
//   node <film-story>/scripts/motionprint.mjs <video.mp4> [--out <dir>] [--fps 30] [--width 320] [--json]
//   node <film-story>/scripts/motionprint.mjs --film <slug> [--format 9x16] [--fps <film.json fps>] [--from s] [--to s] [--out <dir>] [--json]
//   node <film-story>/scripts/motionprint.mjs --curves [--json]      # 缓动表 EASE（film-motion 的 choreo.js）/ 弹簧预设（film-core 的 motion.js）的 t80，运行时实算
//
// 只测量，不判定：没有阈值、没有 FAIL，退出码只表示"量没量成"。数字拿去和参考片对照，取舍由 style_guide 定。
//
// 量什么（视频模式，Node + ffmpeg，无其他依赖）：
//   energy      相邻帧灰度平均绝对差（0–255），每 1/12 s 一个字符 ' .:-=+*#%@'（v/3 取档），每行 4 s——哪里静、哪里动
//   still_ratio 能量 < 0.5 的帧占比；low_ratio < 2 的占比；longest_quiet_s 最长连续低能量
//   cuts        能量 > 18 的帧（硬切或整屏闪变；该帧不计速度）
//   speed       主导运动速度：变化区域里有纹理的点上做金字塔 Lucas-Kanade，取位移中位数，
//               单位 = 源分辨率 px / 采样帧（采样 fps 见 sampled_fps），另给"短边 % / 秒"便于跨画幅对照
//   moves       速度 ≥ vmin 的连续段：t0 t1 path（px）peak（px/帧）t80（走完 80% 行程所用时长占段长的比例）
//               t80 低 = 一下冲到位再慢慢收（expo.out ≈ 0.24），≈0.8 = 匀速，0.5–0.7 = 对称 S 曲线
//   t80_median  按行程加权的 t80 中位数
// 它是**主导运动**的指纹，不是逐元素轨迹：多个物体反向运动、淡入淡出、大面积色变都会让中位数偏；
// 小而快的物体速度会读低（金字塔 5 层；一段运动的第一帧若位移 > ~20 px@320 宽会读低）。要逐元素的准数，用 --film。
//
// 场景模式（--film）：在场景页里逐帧调 window.anchors(t)（film-core runtime/anchors.js 登记的锚点表），
// 用每个锚点中心的轨迹算同样的 moves / t80 / peak——是画的那一笔的坐标，不是从像素估的。
// 场景没装锚点就报清楚然后退出 2。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { cli, FILM_OPTS } from '../../film-core/lib/cli.mjs';
import { capability } from '../../film-core/lib/env.mjs';
import { importRuntime } from '../../film-core/lib/runtime-node.mjs';

const argv = process.argv.slice(2);
cli({
  usage: 'node motionprint.mjs <video.mp4> [选项]  |  --film <slug> [选项]  |  --curves [--json]',
  about: '运动的"速度指纹"：把视频或场景锚点轨迹的运动手感量成数字。只测量不判定，退出码只表示量没量成。',
  positional: '<video.mp4>', positionalHelp: '视频模式：要量的视频',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '场景模式：临时换入口'],
    curves: '打印缓动表 / 弹簧预设的 t80', format: ['<9x16|1x1|16x9>', '场景模式画幅'],
    fps: ['<N>', '采样帧率（视频默认 30；场景默认 film.json fps）'], width: ['<px>', '视频模式缩放宽度（默认 320）'],
    from: ['<s>', '场景模式起点'], to: ['<s>', '场景模式终点'], vmin: ['<v>', '运动段的速度下限（px/帧）'],
    out: ['<dir>', '另把 motionprint.json / energy.txt 写到这个目录'], json: '输出 JSON',
  },
}, argv);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n); if (v == null) return d; const x = Number(v); if (!Number.isFinite(x)) die(`--${n} 需要数字，收到 ${v}`); return x; };
const has = (n) => argv.includes(`--${n}`);
function die(msg, code = 1) { process.stderr.write(`✗ ${msg}\n`); process.exit(code); }

const CHARS = ' .:-=+*#%@';
const CUT = 18, STILL = 0.5, LOW = 2;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ───────────────────────── 段切分与 t80（两种模式共用） ─────────────────────────
// speed[i] = 第 i-1 → i 帧的位移（px/帧）；null = 不可测（切点）。
function cutMoves(speed, fps, vmin, minFrames, minPath) {
  const moves = [];
  let k = 0;
  while (k < speed.length) {
    if (!(speed[k] >= vmin)) { k++; continue; }
    const a = k;
    while (k < speed.length && speed[k] >= vmin) k++;
    const path = speed.slice(a, k);
    const L = path.reduce((s, v) => s + v, 0);
    if (k - a < minFrames || L < minPath) continue;
    let acc = 0, k80 = path.length;
    for (let j = 0; j < path.length; j++) { acc += path[j]; if (acc >= 0.8 * L) { k80 = j + 1; break; } }
    moves.push({ t0: r2((a - 1) / fps), t1: r2(k / fps), frames: k - a, path: Math.round(L), peak: r2(Math.max(...path)), t80: r2(k80 / (k - a)) });
  }
  return moves;
}
function t80Median(moves) {
  const total = moves.reduce((s, m) => s + m.path, 0);
  if (!total) return null;
  let acc = 0;
  for (const m of [...moves].sort((x, y) => x.t80 - y.t80)) { acc += m.path; if (acc >= total / 2) return m.t80; }
  return null;
}
function energyMap(e, fps, binFps = 12, rowS = 4) {
  // 把采样 fps 的能量按 1/12 s 取均值，一字符一格
  const bins = [];
  const per = fps / binFps;
  for (let b = 0; b * per < e.length; b++) {
    const s = e.slice(Math.floor(b * per), Math.max(Math.floor((b + 1) * per), Math.floor(b * per) + 1));
    bins.push(s.reduce((x, y) => x + y, 0) / s.length);
  }
  const lines = [];
  for (let r = 0; r < bins.length; r += binFps * rowS) {
    lines.push(`${(r / binFps).toFixed(1).padStart(5)}s |` + bins.slice(r, r + binFps * rowS).map((v) => CHARS[Math.min(9, Math.floor(v / 3))]).join('') + '|');
  }
  return lines.join('\n');
}

// ───────────────────────── 视频：金字塔 Lucas-Kanade ─────────────────────────
function down(img, w, h) {
  const W = w >> 1, H = h >> 1, o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * W + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1]) / 4;
  }
  return { d: o, w: W, h: H };
}
function pyramid(g, w, h, n) {
  const P = [{ d: g, w, h }];
  for (let i = 1; i < n; i++) { const p = P[i - 1]; P.push(down(p.d, p.w, p.h)); }
  for (const p of P) {                       // 中心差分梯度
    p.gx = new Float32Array(p.w * p.h); p.gy = new Float32Array(p.w * p.h);
    for (let y = 1; y < p.h - 1; y++) for (let x = 1; x < p.w - 1; x++) {
      const i = y * p.w + x;
      p.gx[i] = (p.d[i + 1] - p.d[i - 1]) / 2; p.gy[i] = (p.d[i + p.w] - p.d[i - p.w]) / 2;
    }
  }
  return P;
}
function bil(p, x, y) {
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > p.w - 1.001) x = p.w - 1.001; if (y > p.h - 1.001) y = p.h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * p.w + x0, d = p.d;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + p.w] * (1 - fx) + d[i + p.w + 1] * fx) * fy;
}
const RW = 6;                                 // LK 窗口半径（13×13）
function lk(PA, PB, x, y) {
  let u = 0, v = 0;
  for (let L = PA.length - 1; L >= 0; L--) {
    const A = PA[L], B = PB[L], s = 2 ** L, cx = x / s, cy = y / s;
    u *= 2; v *= 2;
    if (L === PA.length - 1) { u = 0; v = 0; }
    const x0 = Math.round(cx), y0 = Math.round(cy);
    if (x0 < RW + 1 || y0 < RW + 1 || x0 > A.w - RW - 2 || y0 > A.h - RW - 2) continue;
    let gxx = 0, gxy = 0, gyy = 0;
    for (let j = -RW; j <= RW; j++) for (let i = -RW; i <= RW; i++) {
      const k = (y0 + j) * A.w + x0 + i; gxx += A.gx[k] ** 2; gxy += A.gx[k] * A.gy[k]; gyy += A.gy[k] ** 2;
    }
    const det = gxx * gyy - gxy * gxy;
    if (det < 1e-3) continue;
    for (let it = 0; it < 12; it++) {
      let bx = 0, by = 0;
      for (let j = -RW; j <= RW; j++) for (let i = -RW; i <= RW; i++) {
        const k = (y0 + j) * A.w + x0 + i;
        const dI = bil(B, x0 + i + u, y0 + j + v) - A.d[k];
        bx += dI * A.gx[k]; by += dI * A.gy[k];
      }
      const du = -(gyy * bx - gxy * by) / det, dv = -(gxx * by - gxy * bx) / det;
      u += du; v += dv;
      if (du * du + dv * dv < 1e-4) break;
    }
  }
  // 残差：位移后窗口里还对不上多少（灰度均差）。对不上 = 不是平移（出现/消失、淡变、形变），不计入速度
  const A = PA[0], B = PB[0], x0 = Math.round(x), y0 = Math.round(y);
  let res = 0;
  for (let j = -RW; j <= RW; j++) for (let i = -RW; i <= RW; i++) res += Math.abs(bil(B, x0 + i + u, y0 + j + v) - A.d[(y0 + j) * A.w + x0 + i]);
  return [u, v, res / (2 * RW + 1) ** 2];
}
const RES_MAX = 8, MAG_MAX = 64;               // 残差上限（灰度）、单帧位移上限（px@分析宽度，超过即金字塔追不上，按失败算）
function frameSpeed(a, b, w, h, PA, PB) {
  // 候选点：网格步长 4，像素变化 > 6 且结构张量最小特征值够大（有纹理可追）
  const pts = [];
  let changed = 0, cells = 0;
  for (let y = 8; y < h - 8; y += 4) for (let x = 8; x < w - 8; x += 4) {
    cells++;
    const i = y * w + x;
    if (Math.abs(b[i] - a[i]) <= 6) continue;
    changed++;
    let gxx = 0, gxy = 0, gyy = 0;
    for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) {
      const q = i + j * w + k; const gx = PA[0].gx[q], gy = PA[0].gy[q];
      gxx += gx * gx; gxy += gx * gy; gyy += gy * gy;
    }
    const tr = gxx + gyy, mn = tr / 2 - Math.sqrt(Math.max(0, (gxx - gyy) ** 2 / 4 + gxy * gxy));
    if (mn > 50) pts.push([x, y, mn]);
  }
  if (changed / cells < 0.002 || pts.length < 4) return 0;
  pts.sort((p, q) => q[2] - p[2]);
  const use = pts.slice(0, 300);
  const mags = [];
  for (const [x, y] of use) {
    const [u, v, res] = lk(PA, PB, x, y);
    const m = Math.hypot(u, v);
    if (res <= RES_MAX && m <= MAG_MAX) mags.push(m);
  }
  if (mags.length < Math.max(4, use.length * 0.25)) return 0;   // 多数点对不上：这帧的变化不是平移
  mags.sort((p, q) => p - q);
  return mags[mags.length >> 1];
}

async function videoMode(video) {
  const fpsCap = num('fps', 30), width = num('width', 320);
  let meta;
  try {
    meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', video], { encoding: 'utf8' }));
  } catch (e) { die(`ffprobe 读不了 ${video}：${e.message.split('\n')[0]}`); }
  const st = meta.streams?.[0];
  if (!st) die(`${video} 里没有视频流`);
  const [n, d] = st.avg_frame_rate.split('/').map(Number);
  const src = d ? n / d : 0;
  const sfps = src > 0 && src < fpsCap ? src : fpsCap;        // 慢源不上采样：重复帧会读成 0 速度把运动切碎
  const W = width, H = Math.round((st.height * W) / st.width / 2) * 2;
  const scale = st.width / W, short = Math.min(st.width, st.height);
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${sfps},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (c) => { err += c; });
  const FS = W * H;
  let buf = Buffer.alloc(0), prev = null, PA = null;
  const energy = [], speed = [], cuts = [];
  const t0 = Date.now();
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= FS) {
      const g = new Float32Array(FS);
      for (let i = 0; i < FS; i++) g[i] = buf[i];
      buf = buf.subarray(FS);
      const PB = pyramid(g, W, H, 5);
      if (!prev) { energy.push(0); speed.push(0); }
      else {
        let s = 0; for (let i = 0; i < FS; i++) s += Math.abs(g[i] - prev[i]);
        const e = s / FS; energy.push(e);
        if (e > CUT) { cuts.push((energy.length - 1) / sfps); speed.push(null); }
        else speed.push(frameSpeed(prev, g, W, H, PA, PB) * scale);
      }
      prev = g; PA = PB;
    }
  }
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0 || !energy.length) die(`ffmpeg 解码失败（退出 ${code}）：${err.trim().split('\n')[0] ?? ''}`);

  const vmin = num('vmin', 0.0015 * short);                       // 默认 = 短边的 0.15% / 帧（1080 短边 ≈ 1.6 px）
  const moves = cutMoves(speed, sfps, vmin, 3, 0.03 * short);
  let best = 0, cur = 0;
  for (const v of energy) { cur = v < LOW ? cur + 1 : 0; if (cur > best) best = cur; }
  const sp = speed.filter((v) => v != null);
  const moving = sp.filter((v) => v >= vmin);
  const pct = (v) => r2((v * sfps / short) * 100);
  const total = moves.reduce((s, m) => s + m.path, 0);
  const summary = {
    source: resolve(video), width: st.width, height: st.height, source_fps: r3(src), sampled_fps: r3(sfps),
    duration_s: r2(energy.length / sfps), analysed_width: W, ms: Date.now() - t0,
    still_ratio: r3(energy.filter((v) => v < STILL).length / energy.length),
    low_ratio: r3(energy.filter((v) => v < LOW).length / energy.length),
    longest_quiet_s: r2(best / sfps), mean_energy: r3(energy.reduce((s, v) => s + v, 0) / energy.length),
    cuts: cuts.map(r2),
    speed: {
      unit: `px/frame（源分辨率 ${st.width}×${st.height}，每 1/${r3(sfps)} s）`, vmin: r2(vmin),
      moving_ratio: r3(moving.length / sp.length),
      median_moving: moving.length ? r2(moving.sort((a, b) => a - b)[moving.length >> 1]) : 0,
      peak: r2(Math.max(0, ...sp)),
      median_moving_pct_short_per_s: moving.length ? pct(moving[moving.length >> 1]) : 0,
      peak_pct_short_per_s: pct(Math.max(0, ...sp)),
    },
    moves, t80_median: t80Median(moves),
    soft_share: total ? r2(moves.filter((m) => m.t80 >= 0.55).reduce((s, m) => s + m.path, 0) / total) : 0,
    energy_series: energy.map(r2),
    speed_series: speed.map((v) => (v == null ? null : r2(v))),
  };
  const map = energyMap(energy, sfps);
  emit(summary, map, () => {
    const s = summary.speed;
    return [
      `${basename(video)}  ${st.width}×${st.height} @${r3(src)}fps，${summary.duration_s}s，采样 ${r3(sfps)}fps × ${W}px 宽（${summary.ms} ms）`,
      '', map, '',
      `静止帧(<${STILL}) ${pct0(summary.still_ratio)}   低能量(<${LOW}) ${pct0(summary.low_ratio)}   最长安静 ${summary.longest_quiet_s}s   切点 ${cuts.length} 个${cuts.length ? '：' + summary.cuts.slice(0, 12).join(' ') + (cuts.length > 12 ? ' …' : '') : ''}`,
      `主导速度：在动的帧占 ${pct0(s.moving_ratio)}，中位 ${s.median_moving} px/帧（${s.median_moving_pct_short_per_s}% 短边/s），峰值 ${s.peak} px/帧（${s.peak_pct_short_per_s}% 短边/s）`,
      `运动段 ${moves.length} 个 · 行程加权 t80 中位 ${summary.t80_median ?? '—'} · t80≥0.55 的软曲线占行程 ${Math.round(summary.soft_share * 100)}%`,
      ...moves.slice(0, 15).map((m) => `   ${String(m.t0).padStart(6)}–${String(m.t1).padEnd(6)} 行程 ${String(m.path).padStart(5)}px  峰 ${String(m.peak).padStart(6)}px/帧  t80 ${m.t80}`),
      moves.length > 15 ? `   …其余 ${moves.length - 15} 段见 summary.json` : null,
    ].filter((x) => x != null).join('\n');
  });
}
const pct0 = (r) => `${Math.round(r * 100)}%`;

// ───────────────────────── 场景：window.anchors(t) 轨迹 ─────────────────────────
async function filmMode(slug) {
  const { resolveFilm } = await import('../../film-core/lib/film.mjs');
  const { openScene } = await import('../../film-core/lib/browser.mjs');
  const args = { flag: (n, d) => flag(n, d) };
  const film = resolveFilm(slug, args);
  const format = flag('format', film.formats[0]);
  const S = await openScene(film, format);
  try {
    const has = await S.page.evaluate(() => typeof window.anchors === 'function');
    if (!has) die(`${slug} 的场景没有 window.anchors(t)（film-core runtime/anchors.js 的 install()）；改用视频模式：motionprint.mjs ${film.out}/<成片>.mp4`, 2);
    const fps = num('fps', film.config.fps), from = num('from', 0), to = num('to', S.info.duration);
    const ts = [];
    for (let i = Math.ceil(from * fps); i / fps <= to + 1e-9; i++) ts.push(i / fps);
    const t0 = Date.now();
    const tables = await S.page.evaluate(async (ts) => {
      const out = [];
      for (const t of ts) { const r = await window.anchors(t); const o = {}; for (const [k, v] of Object.entries(r?.items ?? {})) o[k] = [v.cx, v.cy, v.n]; out.push(o); }
      return out;
    }, ts);
    const W = S.width, H = S.height, short = Math.min(W, H);
    const names = [...new Set(tables.flatMap((o) => Object.keys(o)))].sort();
    const vmin = num('vmin', 0.5);                                  // 坐标是精确的，0.5 px/帧只滤掉亚像素抖动
    const anchors = {};
    for (const n of names) {
      // 同名多次登记取外包：登记笔数 n 变了（一颗子落下、一笔出画），中心跳的是"外包换了成员"，不是运动——记为跳变，不计速度
      let jumps = 0;
      const sp = tables.map((o, i) => {
        const p = tables[i - 1]?.[n], c = o[n];
        if (i === 0 || !p || !c) return 0;
        if (p[2] !== c[2]) { jumps++; return null; }
        return Math.hypot((c[0] - p[0]) * W, (c[1] - p[1]) * H);
      });
      const moves = cutMoves(sp, fps, vmin, 3, 0.02 * short).map((m) => ({ ...m, t0: r2(m.t0 + from), t1: r2(m.t1 + from) }));
      const present = tables.filter((o) => o[n]).length;
      anchors[n] = { present_ratio: r3(present / tables.length), peak: r2(Math.max(0, ...sp.filter((v) => v != null))), still_ratio: r3(sp.filter((v, i) => tables[i][n] && v != null && v < vmin).length / Math.max(1, present)), regroup_frames: jumps, moves, t80_median: t80Median(moves) };
    }
    const all = Object.values(anchors).flatMap((a) => a.moves);
    const summary = { film: slug, format, width: W, height: H, fps, from, to: r2(to), frames: ts.length, ms: Date.now() - t0,
      unit: `px/frame（${W}×${H}，每 1/${fps} s）`, vmin, anchors, t80_median: t80Median(all), moves_total: all.length };
    emit(summary, null, () => [
      `${slug} [${format}] 锚点轨迹 ${r2(from)}–${r2(to)}s，${ts.length} 帧 @${fps}fps，${names.length} 个锚点（${summary.ms} ms）`,
      `全部运动段 ${all.length} 个 · 行程加权 t80 中位 ${summary.t80_median ?? '—'}`,
      ...names.map((n) => {
        const a = anchors[n];
        const ms = a.moves.map((m) => `${m.t0}–${m.t1}s t80 ${m.t80} 峰 ${m.peak}`);
        return `  ${n}: 在场 ${pct0(a.present_ratio)} 峰值 ${a.peak}px/帧 静止 ${pct0(a.still_ratio)}${a.regroup_frames ? ` 换成员 ${a.regroup_frames} 帧` : ''} · ${a.moves.length} 段${a.moves.length ? ' · t80 中位 ' + a.t80_median : ''}${ms.length ? '\n      ' + ms.slice(0, 6).join('；') + (ms.length > 6 ? ' …' : '') : ''}`;
      }),
    ].join('\n'));
  } finally { await S.close(); }
}

// ───────────────────────── 缓动 / 弹簧的 t80（运行时实算） ─────────────────────────
async function curvesMode() {
  capability('film-motion');                                            // 缓动表在 film-motion：没装 → 「缺能力 film-motion」exit 1
  const { EASE, easeOf, resolveEase } = await importRuntime('choreo.js');
  const { SPRING, settle, springInfo, spring } = await importRuntime('motion.js');
  const N = 100000;
  const first = (f, y) => { for (let i = 0; i <= N; i++) if (f(i / N) >= y) return i / N; return null; };
  const rows = [];
  for (const [fam, v] of Object.entries(EASE)) {
    if (typeof v === 'function') rows.push({ name: fam, t80: first(v, 0.8), t50: first(v, 0.5) });
    else for (const dir of ['in', 'out', 'inOut', 'outIn']) rows.push({ name: `${fam}.${dir}`, t80: first(v[dir], 0.8), t50: first(v[dir], 0.5) });
  }
  const extra = {
    "easeOf.anticipate({pull:.12, at:.3, release:'expo.out'})": easeOf.anticipate({ pull: 0.12, at: 0.3, release: 'expo.out' }),
    'easeOf.cubicBezier(.25,.1,.25,1)': easeOf.cubicBezier(0.25, 0.1, 0.25, 1),
    'easeOf.cubicBezier(.68,-.55,.27,1.55)': easeOf.cubicBezier(0.68, -0.55, 0.27, 1.55),
    'easeOf.spring(spring({duration:.5, overshoot:.08}))': easeOf.spring(spring({ duration: 0.5, overshoot: 0.08 })),
    'easeOf.steps(4)': easeOf.steps(4),
  };
  for (const [k, f] of Object.entries(extra)) rows.push({ name: k, t80: first(resolveEase(f), 0.8), t50: first(f, 0.5) });
  const springs = Object.entries(SPRING).map(([k, sp]) => {
    const { duration } = springInfo(sp);
    const M = 200000; let t80s = null;
    for (let i = 0; i <= M; i++) { const t = (duration * i) / M; if (settle(t, sp.stiffness, sp.damping) >= 0.8) { t80s = t; break; } }
    return { name: k, stiffness: sp.stiffness, damping: sp.damping, duration_s: r3(duration), t80_s: r3(t80s), t80: r3(t80s / duration) };
  });
  const out = { eases: rows.map((r) => ({ ...r, t80: r.t80 == null ? null : r3(r.t80), t50: r.t50 == null ? null : r3(r.t50) })), springs,
    note: 't80 = 第一次达到 80% 行程的 p（缓动）/ 秒数与占停止时长的比例（弹簧，停止时长 ε=0.5%）' };
  emit(out, null, () => [
    '缓动 t80（第一次到 0.8 的 p）',
    ...out.eases.map((r) => `  ${r.name.padEnd(56)} ${String(r.t80).padStart(6)}`),
    '弹簧预设 t80（秒 / 占停止时长）',
    ...springs.map((s) => `  ${s.name.padEnd(8)} ${s.stiffness}/${s.damping}  停止 ${s.duration_s}s  t80 ${s.t80_s}s = ${s.t80}`),
  ].join('\n'));
}

function emit(obj, map, text) {
  const out = flag('out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'motionprint.json'), JSON.stringify(obj, null, 1) + '\n');
    if (map) writeFileSync(join(out, 'energy.txt'), map + '\n');
  }
  if (has('json')) process.stdout.write(JSON.stringify(obj, null, 1) + '\n');
  else process.stdout.write(text() + (out ? `\n\n→ ${join(out, 'motionprint.json')}${map ? ' + energy.txt' : ''}` : '') + '\n');
}

const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--json', '--curves'].includes(argv[i - 1])));
try {
  if (has('curves')) await curvesMode();
  else if (flag('film')) await filmMode(flag('film'));
  else if (pos[0]) await videoMode(pos[0]);
  else die('用法：motionprint.mjs <video.mp4> | --film <slug> | --curves   （见文件头注释）');
} catch (e) { die(e?.message ?? String(e)); }
