// check.mjs 的"世界文字读不读得出"消费者（legible）。
//
// 场景用 film-webfx 的 stage3d.js `S.legible(name, obj, {from, to, em})` 在加载期登记关键词和它的阅读时间窗，
// 运行时在每次渲染之后用渲染用的矩阵量投影：em（一个 em 方块投影后的高，片子原生像素）和
// squash（em 方块投影雅可比的奇异值比 σmin/σmax，1 = 没变形）。暴露：
//   window.legible(t)          画第 t 秒那一帧（= 一次 seek），返回 { t, items: { 名: {em, emMax, squash, aspect, cx, cy, depth, behind, shown, opacity} } }
//   window.legible.windows()   [{ name, from, to }]（登记表，常量）
// 这里只读那张表，不推坐标。
//
// 阈值没有套件默认：片子在 film.json checks 里写了才判，
//   { "legible": { "min_px": 24, "min_squash": 0.6 } }   // 两个可只写一个；min_px 是片子原生像素
// 只写 "legible"（不给阈值）直接 FAIL 并说明——"读得出"的下限取决于字体、字重、画幅缩放和观看设备，套件给不出一个对所有片都对的数。
// 配方不替片子声明它（没有能写进配方的默认阈值）。
//
// 逐帧（成片 fps），并行走 _pool.mjs：每个分片在自己的页面里先顺序取、再倒序取，比 JSON 查纯函数（与 _anchors.mjs 的 fwdRev 同一做法）。

const fix = (v, d = 1) => (v == null ? '—' : v.toFixed(d));

export async function runLegible({ S, pool, F, D, add, fmt, outDir, writeFileSync, join, cfg, fps }) {
  const cost = {};
  const ok = cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg.min_px != null || cfg.min_squash != null);
  if (!ok) {
    add('FAIL', '客观', 'legible', `film.json checks 里 legible 要写阈值：{ "legible": { "min_px": <原生像素>, "min_squash": <0–1> } }（至少一个）。套件不给默认值——下限取决于本片的字体、字重、画幅和观看设备，参考 film-typography 的实测表和本片 style_guide`);
    return cost;
  }
  const minPx = cfg.min_px ?? null, minSq = cfg.min_squash ?? null;
  for (const [k, v] of [['min_px', minPx], ['min_squash', minSq]]) if (v != null && !(typeof v === 'number' && v >= 0)) { add('FAIL', '客观', 'legible', `checks 里 legible.${k} 必须是非负数，收到 ${JSON.stringify(v)}`); return cost; }
  const has = await S.page.evaluate(() => typeof window.legible === 'function' && typeof window.legible.windows === 'function');
  if (!has) {
    add('FAIL', '客观', 'legible', '本片声明了 legible 阈值，但场景没有登记任何世界文字（film-webfx stage3d.js 的 S.legible(name, obj, {from, to})，会装上 window.legible）：没有可量的对象，绿了也不算数');
    return cost;
  }
  const wins = await S.page.evaluate(() => window.legible.windows());
  if (!wins.length) { add('FAIL', '客观', 'legible', '场景装了 window.legible 但登记表是空的'); return cost; }
  const lastT = (Math.round(D * F.fps) - 1) / F.fps;
  const tsOf = (a, b) => { const out = []; for (let k = Math.ceil(a * fps - 1e-6); k <= Math.floor(b * fps + 1e-6); k++) if (k / fps <= lastT + 1e-9 && k >= 0) out.push(+(k / fps).toFixed(6)); return out; };
  const ts = [...new Set(wins.flatMap((w) => tsOf(w.from, w.to)))].sort((x, y) => x - y);
  if (!ts.length) { add('FAIL', '客观', 'legible', `登记的阅读窗（${wins.map((w) => `${w.name} ${fmt(w.from)}–${fmt(w.to)}`).join('、')}）里一帧都没有`); return cost; }

  const grab = (page, part) => page.evaluate(async (ts) => { const out = []; for (const t of ts) out.push(await window.legible(t)); return out; }, part);
  const t0 = Date.now();
  const r = await pool.chunks(ts, async (w, part) => {
    const f = await grab(w.S.page, part);
    const b = (await grab(w.S.page, [...part].reverse())).reverse();
    return part.map((_, i) => [f[i], b[i]]);
  });
  cost.legible_ms = Date.now() - t0; cost.legible_frames = ts.length;
  const k = r.findIndex(([f, b]) => JSON.stringify(f) !== JSON.stringify(b));
  if (k >= 0) { add('FAIL', '客观', 'legible.pure', `window.legible(${ts[k]}) 顺序取与倒序取不同：测量表不是 t 的纯函数（跨帧状态，或这一帧没走到渲染却留着上一帧的表），可读性判定不可信`, { t: ts[k] }); return cost; }
  const at = new Map(ts.map((t, i) => [t, r[i][0]]));

  const lim = [minPx != null && `em ≥ ${minPx}px`, minSq != null && `squash ≥ ${minSq}`].filter(Boolean).join('、');
  for (const w of wins) {
    const wts = tsOf(w.from, w.to);
    let worstPx = null, worstSq = null, bad = 0, hidden = 0, missing = 0, lo = Infinity, hi = -Infinity, sqLo = Infinity, sqHi = -Infinity;
    for (const t of wts) {
      const it = at.get(t)?.items?.[w.name];
      if (!it) { missing++; continue; }
      if (!it.shown || it.opacity < 0.05) { hidden++; continue; }
      lo = Math.min(lo, it.em); hi = Math.max(hi, it.em); sqLo = Math.min(sqLo, it.squash); sqHi = Math.max(sqHi, it.squash);
      const bp = minPx != null && it.em < minPx, bs = minSq != null && it.squash < minSq;
      if (bp || bs) bad++;
      if (bp && (!worstPx || it.em < worstPx.it.em)) worstPx = { t, it };
      if (bs && (!worstSq || it.squash < worstSq.it.squash)) worstSq = { t, it };
    }
    const range = `${fmt(w.from)}–${fmt(w.to)} 的 ${wts.length} 帧（${fps}fps，window.legible 逐帧）`;
    const extra = [hidden && `${hidden} 帧不可见（visible=false 或透明度 <0.05），不计`, missing && `${missing} 帧这一帧没渲三维舞台`].filter(Boolean).join('；');
    const measured = wts.length - hidden - missing;
    if (!measured) { add('FAIL', '客观', 'legible', `「${w.name}」在阅读窗 ${range}里一帧都没量到（${extra}）：登记的窗口和它真正出现的时候对不上`); continue; }
    if (worstPx || worstSq) {
      const worst = worstPx ?? worstSq, f = join(outDir, `evidence-legible-${w.name.replace(/[^\p{L}\p{N}_-]/gu, '_')}-${worst.t.toFixed(2)}s.png`);
      writeFileSync(f, await S.shot(worst.t));
      const parts = [worstPx && `最小字高 ${fix(worstPx.it.em)}px @${fmt(worstPx.t)}（要求 ≥ ${minPx}）`, worstSq && `最扁 squash ${fix(worstSq.it.squash, 2)} @${fmt(worstSq.t)}（要求 ≥ ${minSq}；aspect ${fix(worstSq.it.aspect, 2)}）`].filter(Boolean).join('，');
      add('FAIL', '客观', 'legible', `「${w.name}」${bad}/${measured} 帧读不出：${parts}（${range}${extra ? `；${extra}` : ''}）。改镜头让它在这段时间被正面、够近地看到，或把字放大——怎么改是本片的事`, { t: worst.t, ev: f });
    } else add('PASS', '客观', 'legible', `「${w.name}」${range}里字高 ${fix(lo)}–${fix(hi)}px、squash ${fix(sqLo, 2)}–${fix(sqHi, 2)}，满足 ${lim}${extra ? `（${extra}）` : ''}`);
  }
  return cost;
}
