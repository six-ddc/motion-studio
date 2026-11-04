// film-core lib · 一个输出帧怎么截、帧哈希怎么算 —— render.mjs 写渲染清单、seamcheck 门 5 和清单对账，共用这一份。
// 两边各写一份的话，哪天改了一边（子帧时刻、自适应规则），门 5 就会把好片报成"那次渲染坏了"，或者反过来。
//
// 帧哈希 = 这一帧所有子帧 PNG 字节依次 update 的 md5。PNG 字节取决于截图编码方式（openScene 的 png 选项），
// 所以对账时必须按清单记录的模式截（browser.mjs PNG_MODES）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 渲染输入指纹：片子目录里 out/ 以外的文件（场景、素材、narration.json、film.json）+ 本次实际加载的运行时（名字 + sha256）。
// 运行时按"实际加载的那一份"算，不按片内 runtime/ 目录算：同一份字节无论是从套件挂载的还是冻结进片子的，指纹相同，
// 所以 deliver 冻结之后，渲染清单不会被误判成"输入改过"。loaded 不给（null）时退回把片内 runtime/ 当普通文件算。
// 写进渲染清单（inputs 字段），门 5 拿它区分"那次渲染坏了"和"渲染之后改过输入、成片过期"。
// film.json 去掉 renderer 再算（render 在写完清单之后才记 renderer）；receipt.json 不算（它是交付的产物）。
export function inputsFingerprint(dir, loaded = null) {
  const h = createHash('md5'), files = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || e.name === '__pycache__' || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'out' || r === 'receipt.json' || (loaded && r === 'runtime')) continue;
      let st = e;
      if (e.isSymbolicLink()) { try { st = statSync(join(d, e.name)); } catch { continue; } }   // 跟随链接：链到的内容也是输入
      if (st.isDirectory()) walk(join(d, e.name), r);
      else if (st.isFile()) files.push(r);
    }
  };
  walk(dir, '');
  for (const r of files.sort()) {
    let buf = readFileSync(join(dir, r));
    if (r === 'film.json') { try { const j = JSON.parse(buf); delete j.renderer; buf = Buffer.from(JSON.stringify(j)); } catch {} }
    h.update(r + '\0'); h.update(buf); h.update('\0');
  }
  if (loaded) for (const x of [...loaded].sort((a, b) => a.name.localeCompare(b.name))) h.update(`runtime/${x.name}\0${x.sha256}\0`);
  return h.digest('hex');
}

/**
 * 返回 shoot(S, K) → { pngs, hash }，S 是 openScene 的返回，K 是绝对帧号。
 *   fps sub shutter  与 render.mjs 同义
 *   adapt            null = 固定 sub 个子帧；{ motionPx, subMin, subMax, cuts } = 自适应子帧（场景定义了 window.MOTION）
 *   stats            可选，自适应路径往里累计 { shots, still, maxN, lied }
 */
export function frameShooter({ fps, sub, shutter, adapt = null, stats = null }) {
  const tOf = (K, j) => (K + (sub > 1 ? (shutter * j) / sub : 0)) / fps;
  const digest = (pngs) => { const h = createHash('md5'); for (const p of pngs) h.update(p); return h.digest('hex'); };
  const pageError = (S, t) => {
    if (S.errors.length) throw new Error(`渲染中页面报错（t≈${t.toFixed(3)}s），已中止：\n  ${S.errors.join('\n  ')}`);
  };

  const fixed = async (S, K) => {
    const pngs = [];
    for (let j = 0; j < sub; j++) pngs.push(await S.shot(tOf(K, j)));
    pageError(S, K / fps);
    return { pngs, hash: digest(pngs) };
  };
  if (!adapt) return fixed;

  // 自适应路径：子帧数由 MOTION 决定；静止帧（MOTION=0 且快门两端逐字节相同）只留一张
  const { motionPx, subMin, subMax, cuts } = adapt;
  const st = stats ?? { shots: 0, still: 0, maxN: 0, lied: [] };
  return async (S, K) => {
    const ta = K / fps;
    let tb = (K + shutter) / fps;
    const cut = cuts.find((c) => c > ta + 1e-9 && c < tb - 1e-9);   // 快门跨硬切：只取帧起点那一侧
    if (cut !== undefined) tb = cut;
    const px = await S.page.evaluate(([x, y]) => window.MOTION(x, y), [ta, tb]);
    if (!(Number.isFinite(px) && px >= 0)) throw new Error(`window.MOTION(${ta.toFixed(4)}, ${tb.toFixed(4)}) 返回 ${px}，要求 ≥0 的有限数（像素）`);
    const at = (j, n) => ta + ((tb - ta) * j) / n;
    let pngs = null, n;
    if (px === 0) {
      const p0 = await S.shot(ta), p1 = await S.shot(at(subMax - 1, subMax));
      if (p0.equals(p1)) { pngs = [p0]; st.still++; st.shots += 2; }
      else { n = subMin; pngs = [p0]; st.shots += 2; if (st.lied.length < 5) st.lied.push(ta); }   // MOTION 说不动，两端却不同
    } else n = Math.min(subMax, Math.max(subMin, Math.ceil(px / motionPx)));
    if (n) {
      pngs ??= [];
      for (let j = pngs.length; j < n; j++) pngs.push(await S.shot(at(j, n)));
      st.shots += n - (px === 0 ? 1 : 0);
      st.maxN = Math.max(st.maxN, n);
    }
    pageError(S, ta);
    return { pngs, hash: digest(pngs) };
  };
}
