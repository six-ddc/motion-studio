// check.mjs 的空间锚点消费者（锚点语义见 film-core references/runtime.md §6）。
//
// 场景用 film-core 的 runtime/anchors.js 在**绘制路径上**登记"有名字的东西"的屏幕框，
// 暴露 window.anchors(t)：画第 t 秒那一帧，返回那一帧的表 { t, items: { 名: {x,y,w,h,cx,cy,n} } }（归一化、不裁剪）。
// 这里只读那张表，不推任何坐标——推了就是"另算一遍"，验的是自己。
//
// 三个消费者，全部"本片声明了才生效"：
//   law.<id> + occlude   遮挡门：承重锚点 与 文字框（fillText 拦截，同一次绘制）/ 别的锚点 不相交
//   law.<id> + inframe   出画门：旁白主语锚点在时间窗内留在画面（或安全区）里
//   claims.anchor        shotlist 曲线 source: "anchor"，取某锚点的 cx/cy/w/h 逐帧交回 check_shotlist 判定
// 没声明这些的片子，check.mjs 的行为与引入本模块之前逐字节相同（demo-tls 是对照）。
//
// 时间分辨率：逐帧（默认成片 fps），不是 check.mjs 的 10fps 采样——锚点只要 draw 不要截图，
// 一帧约几毫秒；10fps 会漏掉 0.07s 级的出画（"窗口恰好比缺陷短"）。
//
// 并行（ctx.pool，见 _pool.mjs）：帧序列切成连续分片分给多个页面，**每个分片在自己的页面里先顺序取、再倒序取**，
// 所以"同一个 t 换个求值顺序结果一样"在每个页面内部照样成立。没有 pool（或 --workers 1）= 单页面整段，与引入并行之前逐次相同。

export const isAnchorLaw = (l) => !!(l && (l.occlude || l.inframe));

const N6 = (v) => Math.round(v * 1e4) / 1e4;

/** 顺序取一遍、倒序取一遍，返回与 ts 对齐的 { fwd, rev, ms }。顺序那一遍可带文字框（texts），倒序那一遍只比锚点表。 */
export async function fwdRev(ctx, ts, { texts = false } = {}) {
  const t0 = Date.now();
  if (!ctx.pool) {
    const fwd = await sampleAnchors(ctx.S.page, ts, { texts });
    const ms = Date.now() - t0;
    const rev = (await sampleAnchors(ctx.S.page, [...ts].reverse())).reverse();
    return { fwd, rev, ms, revMs: Date.now() - t0 - ms };
  }
  const r = await ctx.pool.chunks(ts, async (w, part) => {
    const f = await sampleAnchors(w.S.page, part, { texts });
    const b = (await sampleAnchors(w.S.page, [...part].reverse())).reverse();
    return part.map((_, i) => [f[i], b[i]]);
  });
  return { fwd: r.map((x) => x[0]), rev: r.map((x) => x[1]), ms: Date.now() - t0, revMs: null };
}

/** 在场景页里逐帧求 window.anchors(t)。texts=true 时同时打开 check.mjs 的 fillText 探针，
 *  拿到**同一次绘制**里的文字框（canvas 文字 + 可见 DOM 文字），归一化到画面。 */
export async function sampleAnchors(page, ts, { texts = false } = {}) {
  return page.evaluate(async ([ts, texts]) => {
    const out = [];
    for (const t of ts) {
      if (texts && window.__crit) { window.__crit.length = 0; window.__critOn = true; }
      let a;
      try { a = await window.anchors(t); } finally { if (texts && window.__crit) window.__critOn = false; }
      let tx = null;
      if (texts) {
        tx = (window.__crit ?? []).filter((x) => x.box && x.alpha >= 0.05 && String(x.text).trim()).map((x) => ({ text: x.text, box: x.box }));
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = walk.nextNode());) {
          const s = n.textContent.trim(); if (!s || !n.parentElement) continue;
          const cs = getComputedStyle(n.parentElement), r = n.parentElement.getBoundingClientRect();
          if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || r.width === 0) continue;
          tx.push({ text: s, box: [r.left / innerWidth, r.top / innerHeight, r.right / innerWidth, r.bottom / innerHeight], dom: true });
        }
      }
      out.push({ t, items: a?.items ?? null, texts: tx });
    }
    return out;
  }, [ts, texts]);
}

const boxOf = (b) => [b.x, b.y, b.x + b.w, b.y + b.h];
// 有符号间距（原生像素）：>0 = 两框分开这么多，<=0 = 相交（绝对值 = 较小那一维的重叠深度）
const sep = (a, b, W, H) => {
  const gx = Math.max(a[0] - b[2], b[0] - a[2]) * W, gy = Math.max(a[1] - b[3], b[1] - a[3]) * H;
  return Math.max(gx, gy);
};
// 只算画面里看得见的那部分：锚点和文字框都是"未裁剪"的（锚点语义第 3 条，出画门要靠它知道切掉了多少），
// 但遮挡门问的是"观众看见的东西有没有被压"——画面外的那截既看不见、也压不到任何字（被裁到画面外的锚点
// 曾被算成压字）。完全在画面外的框返回 null，不参与比较。
const visiblePart = (b) => (b[2] < 0 || b[0] > 1 || b[3] < 0 || b[1] > 1 ? null : [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(1, b[2]), Math.min(1, b[3])]);
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** 证据帧：在截图上画出出事的框（红 = 承重/主语锚点，黄 = 遮挡物 / 安全区）。在分析页里画，不碰场景页。 */
async function overlay(ap, png, rects) {
  const b64 = await ap.evaluate(async ([b64, rects]) => {
    const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d');
    x.drawImage(bm, 0, 0);
    for (const r of rects) {
      x.strokeStyle = r.color; x.lineWidth = 4; x.setLineDash(r.dash ? [14, 10] : []);
      x.strokeRect(r.box[0] * bm.width, r.box[1] * bm.height, (r.box[2] - r.box[0]) * bm.width, (r.box[3] - r.box[1]) * bm.height);
      if (r.label) { x.font = '600 28px sans-serif'; x.fillStyle = r.color; x.fillText(r.label, Math.min(bm.width - 200, Math.max(6, r.box[0] * bm.width + 6)), Math.min(bm.height - 8, Math.max(30, r.box[1] * bm.height - 8))); }
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  }, [png.toString('base64'), rects]);
  return Buffer.from(b64, 'base64');
}

/**
 * 一条 occlude / inframe 法律。ctx 由 check.mjs 传入（都是它已有的东西，本模块不另造）：
 *   { S, ap, F, D, add, fmt, markRef, outDir, writeFileSync, join, fps }
 */
export async function runAnchorLaw(l, ctx) {
  const { S, ap, F, add, fmt, markRef, outDir, writeFileSync, join } = ctx;
  const id = `law.${l.id}`, W = F.width, H = F.height;
  const has = await S.page.evaluate(() => typeof window.anchors === 'function');
  if (!has) { add('FAIL', '本片法律', id, `${l.text}：这条法律要读空间锚点，但场景没有暴露 window.anchors(t)（film-core 的 runtime/anchors.js，A.install(seek)）`); return; }
  let a, b;
  try { a = markRef(l.from, 0) + (l.grace ?? 0); b = markRef(l.to, ctx.D); } catch (e) { add('FAIL', '本片法律', id, `${l.text}：${e.message}`); return; }
  const fps = ctx.fps, lastT = (Math.round(ctx.D * F.fps) - 1) / F.fps;
  let ts = []; for (let k = Math.ceil(a * fps - 1e-6); k <= Math.floor(b * fps + 1e-6); k++) if (k / fps <= lastT + 1e-9) ts.push(+(k / fps).toFixed(6));
  if (!ts.length) { add('FAIL', '本片法律', id, `${l.text}：时间窗 ${fmt(a)}–${fmt(b)} 里一帧都没有`); return; }
  // 局部运行（--from/--to）：只量窗口里的帧；一帧都不在窗口里就不判（不是 FAIL：这条法律本身没毛病）
  if (ctx.clip) { ts = ctx.clip(ts); if (!ts.length) { add('SKIP', '本片法律', id, `${l.text}：时间窗 ${fmt(a)}–${fmt(b)} 不在本次 --from/--to 窗口里`); return; } }
  const range = `${ctx.clip ? `${fmt(ts[0])}–${fmt(ts.at(-1))}（--from/--to 截取自 ${fmt(a)}–${fmt(b)}）` : `${fmt(a)}–${fmt(b)}`} 的 ${ts.length} 帧（${fps}fps，window.anchors 逐帧）`;
  // 纯函数：倒序再取一遍。法律门逐帧按时间顺序读表，跨帧泄漏会让它读到"上一帧的位置"而不报错
  // （阴性对照 nc-pure：把上一帧的黄车框并进本帧，两道法律门照常 PASS——加这一步之前）。
  // 并行时顺序/倒序在每个分片自己的页面里做（fwdRev）。
  const sample = async (opt) => { const r = await fwdRev(ctx, ts, opt); (ctx.cost ??= {}); ctx.cost[`law_${l.id}_ms`] = r.ms; ctx.cost[`law_${l.id}_frames`] = ts.length; return r; };
  const pure = async ({ fwd: fr, rev }) => {
    const k = fr.findIndex((f, i) => JSON.stringify(f.items) !== JSON.stringify(rev[i].items));
    if (k < 0) return true;
    add('FAIL', '本片法律', id, `${l.text}：window.anchors(${fr[k].t}) 顺序取与倒序取不同——锚点表不是 t 的纯函数（跨帧状态，或 seek 开头没清表），这条法律的判定不可信`, { t: fr[k].t });
    return false;
  };
  const evidence = async (tag, t, rects) => {
    const f = join(outDir, `evidence-law-${l.id}-${tag}-${t.toFixed(2)}s.png`);
    writeFileSync(f, await overlay(ap, await S.shot(t), rects)); return f;
  };

  if (l.occlude) {
    const O = l.occlude, subj = [].concat(O.anchors ?? O.anchor ?? []), against = [].concat(O.against ?? ['text']);
    if (!subj.length) { add('FAIL', '本片法律', id, `${l.text}：occlude 要写 anchors（承重锚点名）`); return; }
    const pad = O.pad ?? 0;                                   // 原生像素：遮挡物外扩多少才算"贴着"
    const both = await sample({ texts: against.includes('text') }), fr = both.fwd;
    if (!(await pure(both))) return;
    let worst = null, minSep = Infinity, nBad = 0, missing = null, seenText = 0;
    for (const f of fr) {
      const items = f.items ?? {};
      const occ = [];
      for (const g of against) {
        if (g === 'text') { for (const x of f.texts ?? []) occ.push({ name: `文字「${String(x.text).slice(0, 8)}」`, box: visiblePart(x.box) }); seenText += (f.texts ?? []).length; }
        else if (items[g]) occ.push({ name: g, box: visiblePart(boxOf(items[g])) });
      }
      for (let i = occ.length - 1; i >= 0; i--) if (!occ[i].box) occ.splice(i, 1);
      let bad = false;
      for (const s of subj) {
        if (!items[s]) { missing ??= { t: f.t, s, have: Object.keys(items) }; continue; }
        const sb = visiblePart(boxOf(items[s]));
        if (!sb) continue;                                    // 整个在画面外：看不见，也就谈不上被压
        for (const o of occ) {
          const d = sep(sb, o.box, W, H) - pad;
          if (d < minSep) minSep = d;
          if (d <= 0) { bad = true; if (!worst || d < worst.d) worst = { t: f.t, d, s, o, sb }; }
        }
      }
      if (bad) nBad++;
    }
    const who = `${subj.join('、')} × ${against.map((g) => (g === 'text' ? '文字' : g)).join('、')}`;
    if (missing) add('FAIL', '本片法律', id, `${l.text}：承重锚点「${missing.s}」在 ${fmt(missing.t)} 没有登记（这一帧登记了：${missing.have.join('、') || '无'}）——承重的东西要么没画，要么画了没登记，两种都没法证明它没被挡`, { t: missing.t });
    else if (worst) {
      const ev = await evidence('overlap', worst.t, [{ box: worst.sb, color: '#ff3030', label: worst.s }, { box: worst.o.box, color: '#ffd400', dash: true, label: worst.o.name }]);
      add('FAIL', '本片法律', id, `${l.text}：${nBad}/${fr.length} 帧相交，最深在 ${fmt(worst.t)}「${worst.s}」与 ${worst.o.name} 重叠 ${(-worst.d).toFixed(1)}px${pad ? `（含 pad ${pad}px）` : ''}（${who}，${range}）`, { t: worst.t, ev });
    } else if (against.includes('text') && !seenText && against.length === 1) add('FAIL', '本片法律', id, `${l.text}：${range}里一段文字都没截到——遮挡门没有可比的对象，绿了也不算数（文字若是位图/路径，把它作为锚点登记再写进 against）`);
    else add('PASS', '本片法律', id, `${l.text}：${range}里 ${who} 从不相交，最近时相距 ${minSep === Infinity ? '—（遮挡物一直不在场）' : `${minSep.toFixed(1)}px`}${pad ? `（已扣 pad ${pad}px）` : ''}（锚点判据，机器判）`);
    return;
  }

  // inframe：主语锚点的框落在安全区里的面积占比 >= min
  const I = l.inframe, subj = [].concat(I.anchors ?? I.anchor ?? []);
  if (!subj.length) { add('FAIL', '本片法律', id, `${l.text}：inframe 要写 anchor（旁白主语的锚点名）`); return; }
  const [sx, sy] = Array.isArray(I.safe) ? I.safe : [I.safe ?? 0, I.safe ?? 0];
  const safe = [sx, sy, 1 - sx, 1 - sy], min = I.min ?? 1;
  const both = await sample({}), fr = both.fwd;
  if (!(await pure(both))) return;
  let worst = null, low = Infinity, nBad = 0, missing = null;
  for (const f of fr) {
    const items = f.items ?? {};
    for (const s of subj) {
      if (!items[s]) { missing ??= { t: f.t, s, have: Object.keys(items) }; continue; }
      const sb = boxOf(items[s]), A = area(sb);
      const frac = A > 0 ? area(inter(sb, safe)) / A : (sb[0] >= safe[0] && sb[2] <= safe[2] && sb[1] >= safe[1] && sb[3] <= safe[3] ? 1 : 0);
      low = Math.min(low, frac);
      if (frac < min - 1e-9) { nBad++; if (!worst || frac < worst.frac) worst = { t: f.t, s, sb, frac }; }
    }
  }
  const zone = sx || sy ? `安全区（四边各内缩 ${N6(sx * 100)}% 宽 / ${N6(sy * 100)}% 高）` : '画面';
  if (missing) {
    add('FAIL', '本片法律', id, `${l.text}：旁白主语「${missing.s}」在 ${fmt(missing.t)} 没有登记（这一帧登记了：${missing.have.join('、') || '无'}）——旁白在说它，画面上没有画它`, { t: missing.t });
  } else if (worst) {
    const b = worst.sb, edge = [b[0] < safe[0] && `左 ${((safe[0] - b[0]) * W).toFixed(0)}px`, b[2] > safe[2] && `右 ${((b[2] - safe[2]) * W).toFixed(0)}px`,
      b[1] < safe[1] && `上 ${((safe[1] - b[1]) * H).toFixed(0)}px`, b[3] > safe[3] && `下 ${((b[3] - safe[3]) * H).toFixed(0)}px`].filter(Boolean).join('、');
    const ev = await evidence('out', worst.t, [{ box: b, color: '#ff3030', label: worst.s }, ...(sx || sy ? [{ box: safe, color: '#ffd400', dash: true }] : [])]);
    add('FAIL', '本片法律', id, `${l.text}：${nBad} 帧次主语出${zone}，最严重 ${fmt(worst.t)}「${worst.s}」只有 ${(worst.frac * 100).toFixed(1)}% 在${zone}内（要求 ≥ ${(min * 100).toFixed(0)}%；越界 ${edge}）（${range}）`, { t: worst.t, ev });
  } else add('PASS', '本片法律', id, `${l.text}：${range}里「${subj.join('、')}」在${zone}内的面积占比最低 ${(low * 100).toFixed(1)}%（要求 ≥ ${(min * 100).toFixed(0)}%；锚点判据，机器判）`);
}

/**
 * shotlist 的 source: "anchor" 断言：逐帧取锚点统计量，顺序一遍、倒序一遍查纯函数。
 * 返回 { sampled: [{idx, via:'anchor', ts, vals}], impure, cost }；问题直接 add()。
 */
export async function anchorClaims(claims, ctx) {
  const { S, add, frameTs } = ctx; // ctx.pool 可选（并行）
  const out = { sampled: [], impure: false, cost: {} };
  if (!claims.length) return out;
  const has = await S.page.evaluate(() => typeof window.anchors === 'function');
  if (!has) { add('FAIL', '客观', 'claims.anchor', `shotlist 声明 ${[...new Set(claims.map((c) => c.curve))].join('、')} 取自空间锚点（source: anchor），但场景没有暴露 window.anchors(t)：这 ${claims.length} 条断言没人验过`); return out; }
  const ts = [...new Set(claims.flatMap((c) => frameTs(c.span)))].sort((x, y) => x - y);
  // 并行时 anchor_ms 是顺序 + 倒序两遍的总墙钟（两遍在每个分片的页面里连着做，分不开）；串行时只是顺序那一遍（旧口径）
  const { fwd, rev, ms } = await fwdRev(ctx, ts);
  out.cost.anchor_ms = ms;
  out.cost.anchor_frames = ts.length;
  const k = ts.findIndex((_, i) => JSON.stringify(fwd[i].items) !== JSON.stringify(rev[i].items));
  if (k >= 0) { out.impure = true; add('FAIL', '客观', 'anchors.pure', `window.anchors(${ts[k]}) 顺序取与倒序取结果不同：锚点表不是 t 的纯函数（有跨帧状态，或 seek 开头没清表），锚点断言实测不可信`, { t: ts[k] }); }
  const at = new Map(ts.map((t, i) => [t, fwd[i].items ?? {}]));
  const STATS = ['cx', 'cy', 'w', 'h'];
  for (const c of claims) {
    const sp = c.anchor ?? {};
    if (!STATS.includes(sp.stat)) { add('FAIL', '客观', 'claims.anchor', `「${c.says}」的曲线 ${c.curve} 是 source: anchor，anchor.stat 只能是 ${STATS.join(' / ')}`); continue; }
    const cts = frameTs(c.span);
    out.sampled.push({ idx: c.idx, via: 'anchor', ts: cts, vals: cts.map((t) => { const b = at.get(t)?.[sp.name]; return b && Number.isFinite(b[sp.stat]) ? b[sp.stat] : null; }) });
  }
  return out;
}
