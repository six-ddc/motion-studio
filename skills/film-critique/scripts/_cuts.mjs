// 剪辑点 / 转场窗口从哪来，以及在每个窗口上取哪几帧。transitions.mjs 用；contact.sh 通过 transitions.png.meta.json 间接用。
//
// 来源（按优先级，取第一个有的；用了哪个写进输出，不静默混用）：
//   1. --cuts 3.2,8.0-8.4        命令行手给：单个数 = 硬切；a-b = 转场窗口
//   2. window.CUT_WINDOWS        场景声明的转场窗口 [{start, end, cut?, label?}]——film-motion timeline() 的 TL.transitionMarks() 原样给
//      window.CUTS               场景声明的硬切时刻 [t…]（film-core render.mjs 已经认它：快门不跨切点）；落在某个窗口里的不重复算
//   3. window.MARKS 的边界       MARKS 首尾相接（前一个 end ≈ 后一个 start，差 ≤ 1 帧）时，把接缝当硬切。**推测**：
//                                 只有 MARKS 是镜头分段（TL.marks()）时才是剪辑点；叙事事件表恰好首尾相接时，取到的是事件交接处
//   4. --scan                    逐帧差分找峰（要自己截图，慢，所以要显式开）。**推测**：测的是相邻采样的整体亮度变化，不是剪辑意图——
//                                 同底色切换（差分小）会漏，快速运动 / 闪白会被当成切点
//   都没有 → 返回空，调用方退回现行行为（MARKS 中点 / 均匀）并明说"转场中段没被专门采样"。
//
// 取帧（每个窗口 5 帧，全部对齐到成片帧格 k/fps——成片里只有这些时刻，取帧格之间的时刻会看到一张从不出现的画面）：
//   转场 [t0, t1]：前 = t0 − pad、入 = 25%、中 = 50%、出 = 75%、后 = t1 + pad（cut 只写进标题：align 不在中间时 cut 不是视觉上的半路）
//   硬切 c：       前 = c − pad、入 = 切点前最后一帧、中 = 切点后第一帧、出 = 再后一帧、后 = c + pad
//   pad 默认 max(0.3s, 3 帧)。已知缺陷多发生在转场中段（框中框、网格错位、甩镜残影、匹配剪辑露黑边），所以"中"必取。
import { decodePNG } from './_pixels.mjs';

export const POS = ['前', '入', '中', '出', '后'];

/** 校验并规范化窗口表；不合法直接抛错（调用方 exit 1）。门出问题时不能给"没有剪辑点"的绿灯。 */
export function normalizeWindows(raw, D, src) {
  const bad = (m) => { throw new Error(`${src} 不合法：${m}`); };
  const out = raw.map((w, i) => {
    const t0 = +w.t0, t1 = +w.t1, cut = w.cut == null ? null : +w.cut;
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) bad(`第 ${i + 1} 项不是有限数（${JSON.stringify(w.raw ?? w)}）`);
    if (t1 < t0) bad(`第 ${i + 1} 项结束早于开始（${t0}–${t1}）`);
    if (t0 < 0 || t1 > D + 1e-6) bad(`第 ${i + 1} 项 ${t0}–${t1} 超出片长 [0, ${D}]`);
    if (cut != null && (!Number.isFinite(cut) || cut < t0 - 1e-6 || cut > t1 + 1e-6)) bad(`第 ${i + 1} 项的 cut=${w.cut} 不在窗口 ${t0}–${t1} 里`);
    return { t0, t1, cut, label: w.label ?? null, kind: t1 - t0 < 1e-9 ? '硬切' : '转场' };
  }).sort((a, b) => a.t0 - b.t0);
  for (let k = 1; k < out.length; k++) if (out[k].t0 < out[k - 1].t1 - 1e-9) bad(`窗口 ${out[k - 1].t0}–${out[k - 1].t1} 与 ${out[k].t0}–${out[k].t1} 重叠`);
  return out;
}

/** "3.2,8.0-8.4" → 窗口表 */
export function parseCutsArg(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(-?[\d.]+)\s*-\s*([\d.]+)$/.exec(x);
    return m ? { t0: +m[1], t1: +m[2], raw: x } : { t0: +x, t1: +x, cut: +x, raw: x };
  });
}

/** 场景声明的来源（2、3）。page = film-core openScene 的页面。返回 { source, note, raw } 或 null。 */
export async function sceneCuts(page, fps) {
  const g = await page.evaluate(() => ({
    windows: Array.isArray(window.CUT_WINDOWS) ? JSON.parse(JSON.stringify(window.CUT_WINDOWS)) : null,
    cuts: Array.isArray(window.CUTS) ? [...window.CUTS] : null,
    marks: Array.isArray(window.MARKS) ? window.MARKS.map((m) => ({ label: m.label, start: m.start, end: m.end })) : null,
  }));
  if (g.windows?.length || g.cuts?.length) {
    const raw = (g.windows ?? []).map((w) => ({ t0: w.start, t1: w.end, cut: w.cut ?? null, label: w.label ?? null, raw: w }));
    for (const c of g.cuts ?? []) {
      if (raw.some((w) => c >= w.t0 - 1e-9 && c <= w.t1 + 1e-9)) continue;
      raw.push({ t0: c, t1: c, cut: c, label: null, raw: c });
    }
    const src = [g.windows?.length && 'window.CUT_WINDOWS', g.cuts?.length && 'window.CUTS'].filter(Boolean).join(' + ');
    return { source: src, note: '场景声明的剪辑点（与画面同源）', raw };
  }
  if (g.marks?.length > 1) {
    const ms = g.marks.filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end)).sort((a, b) => a.start - b.start);
    const raw = [];
    for (let k = 1; k < ms.length; k++) {
      if (Math.abs(ms[k].start - ms[k - 1].end) <= 1 / fps + 1e-9) raw.push({ t0: ms[k].start, t1: ms[k].start, cut: ms[k].start, label: `${ms[k - 1].label}→${ms[k].label}` });
    }
    if (raw.length) return { source: 'window.MARKS 边界', note: '推测：MARKS 首尾相接处当硬切——只有 MARKS 是镜头分段时才是剪辑点；转场窗口宽度未知，按硬切取帧', raw };
  }
  return null;
}

/** 来源 4：逐帧差分找峰。shot(t) → PNG。返回 { source, note, raw, curve }。 */
export async function scanCuts(shot, D, sfps, fps, { onTick } = {}) {
  const N = Math.floor(D * sfps - 1e-9) + 1, G = 48;
  // 48×48 块均值亮度：对噪点/细纹不敏感，对整屏换景敏感
  const lum = async (t) => {
    const { W, H, d } = decodePNG(await shot(t));
    const L = new Float32Array(G * G), n = new Float32Array(G * G);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const k = Math.min(G - 1, (y * G / H) | 0) * G + Math.min(G - 1, (x * G / W) | 0), q = (y * W + x) * 4;
      L[k] += 0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2]; n[k]++;
    }
    for (let k = 0; k < L.length; k++) L[k] /= n[k] || 1;
    return L;
  };
  const dist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length / 255; };
  const curve = [];
  let prev = null;
  for (let i = 0; i < N; i++) {
    const t = +(i / sfps).toFixed(4), L = await lum(t);
    curve.push({ t, diff: prev ? dist(L, prev) : null, L }); prev = L;
    onTick?.(i, N);
  }
  const ds = curve.map((c) => c.diff).filter((x) => x != null).sort((a, b) => a - b);
  const med = ds.length ? ds[ds.length >> 1] : 0;
  const th = Math.max(0.04, med * 6);   // 经验阈值：整屏平均亮度变化 ≥4%，且远高于本片的典型帧间变化
  const raw = [];
  for (let i = 1; i < curve.length; i++) {
    if (!(curve[i].diff >= th)) continue;
    let j = i; while (j + 1 < curve.length && curve[j + 1].diff >= th) j++;
    const peak = curve.slice(i, j + 1).reduce((a, b) => (b.diff > a.diff ? b : a));
    const lab = `差分峰 ${(peak.diff * 100).toFixed(1)}%`;
    if (j > i) raw.push({ t0: curve[i - 1].t, t1: curve[j].t, cut: null, label: lab });   // 连续几个采样都在变：渐变式转场
    else {
      // 只跨一个采样间隔：当硬切，在成片帧格上二分出切点（离后一采样更近的第一帧），每个峰多截 ~log2(fps/sfps) 帧
      const A = curve[i - 1].L, B = curve[i].L;
      let lo = Math.round(curve[i - 1].t * fps), hi = Math.round(curve[i].t * fps);
      while (hi - lo > 1) { const m = (lo + hi) >> 1, L = await lum(m / fps); if (dist(L, A) < dist(L, B)) lo = m; else hi = m; }
      const c = +(hi / fps).toFixed(4);
      raw.push({ t0: c, t1: c, cut: c, label: lab });
    }
    i = j;
  }
  for (const c of curve) delete c.L;
  return { source: `--scan ${sfps}fps 差分峰`, note: `推测：阈值 ${(th * 100).toFixed(1)}%（中位帧间差 ×6，下限 4%）。测的是整屏亮度变化，不是剪辑意图——同底色切换会漏，快动作/闪白会误报`, raw, curve };
}

/** 一个窗口的 5 个取帧时刻（帧格对齐，夹在 [0, 最后一帧]） */
export function samplePoints(w, fps, D, pad) {
  const last = Math.max(0, Math.round(D * fps) - 1);
  const f = (k) => { k = Math.max(0, Math.min(last, k)); return { frame: k, t: +(k / fps).toFixed(4) }; };
  const near = (t) => f(Math.round(t * fps));
  const P = pad ?? Math.max(0.3, 3 / fps);
  if (w.kind === '硬切') {
    const kc = Math.ceil(w.cut * fps - 1e-6);   // 切点后第一帧
    return [near(w.cut - P), f(kc - 1), f(kc), f(kc + 1), near(w.cut + P)];
  }
  const L = w.t1 - w.t0;
  return [near(w.t0 - P), near(w.t0 + 0.25 * L), near(w.t0 + 0.5 * L), near(w.t0 + 0.75 * L), near(w.t1 + P)];
}
