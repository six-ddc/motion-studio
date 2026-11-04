// 转场拼图：在每个剪辑点 / 转场窗口上取"前、入、中、出、后"5 帧，拼成一张每格标时间戳和帧号的图。
//
// 为什么要有：stills.mjs 只取 MARKS 中点或均匀 5 张，contact 表按固定间隔抽，strip 起点固定 35%——
// 三者都很少正好落在转场中段，而已知缺陷多发生在那里（zoomThrough 框中框、网格错位、甩镜残影、匹配剪辑露黑边），
// 历史上都是人碰巧看图才发现的。这张图专门对准它们。
//
// 它测的量 vs 你可能以为它测的量：
//   它只**取帧**，不判任何东西；"中"那一格是窗口中点（或声明的 cut），不是"最坏的一帧"。
//   剪辑点来源写在图头和 meta 里：场景声明的（与画面同源）可信；MARKS 边界 / --scan 差分峰是推测，会漏、会多。
//   没有任何来源时退回 stills.mjs 的现行做法（MARKS 中点 / 均匀 5 点）并在图头写明"转场中段没被专门采样"。
//
// 用法:
//   node <film-critique>/scripts/transitions.mjs --film <slug>
//   --cuts 3.2,8.0-8.4    手给剪辑点（单个数 = 硬切；a-b = 转场窗口），优先于场景声明
//   --scan [--scan-fps 5] 场景没声明时逐帧差分找峰（推测性来源；慢，要显式开）
//   --pad 0.3             "前/后"离窗口边的秒数（默认 max(0.3s, 3 帧)）
//   --entry x.html  --tile <px>  --label transitions
// 产出：films/<slug>/out/<label>.png、out/<label>/tr<k>-<位置>-<t>s.png、out/<label>.png.meta.json（剪辑点、取帧表、场景指纹）
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, resolveFilm, openScene, die, FILM_OPTS } from './_film.mjs';
import { POS, normalizeWindows, parseCutsArg, sceneCuts, scanCuts, samplePoints } from './_cuts.mjs';
import { writeMeta } from './_fresh.mjs';

const { flag, num, has } = args({
  usage: 'node transitions.mjs --film <slug> [--cuts 3.2,8.0-8.4] [--scan [--scan-fps 5]] [--pad 0.3] [--tile 360] [--label transitions]',
  about: '转场拼图：每个剪辑点/转场窗口取"前、入、中、出、后"5 帧，拼成带时间戳与帧号的图。只取帧，不判。\n'
    + '剪辑点来源：--cuts > window.CUT_WINDOWS / window.CUTS > window.MARKS 边界（推测）> --scan 差分峰（推测）；都没有时退回 MARKS 中点 / 均匀 5 点并明说。',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'],
    cuts: ['<t,a-b,...>', '手给剪辑点：单个数 = 硬切，a-b = 转场窗口（秒）'],
    scan: '场景没声明剪辑点时逐帧差分找峰（推测性来源，慢，要显式开）',
    'scan-fps': ['<fps>', '--scan 的采样帧率（默认 5）'],
    pad: ['<秒>', '"前/后"两格离窗口边多远（默认 max(0.3s, 3 帧)）'],
    tile: ['<px>', '每格宽度（默认 横版 360 / 竖版 220）'], label: ['<name>', '产物名（默认 transitions）'],
  },
});
const F = resolveFilm(flag('film'));
const label = flag('label', 'transitions');
const fps = F.fps || 30;
const S = await openScene(F);
if (S.errors.length) { await S.close(); die('场景报错：\n  ' + S.errors.join('\n  '), 1); }
const D = S.duration;
if (!(D > 0)) { await S.close(); die('场景没有 window.DURATION，film.json 也没写 duration', 1); }

// ---- 剪辑点 ----
let found = null;
try {
  if (flag('cuts', null)) found = { source: '--cuts', note: '命令行手给', raw: parseCutsArg(flag('cuts')) };
  else found = await sceneCuts(S.page, fps);
  if (!found && has('scan')) {
    const sfps = num('scan-fps', 5);
    process.stdout.write(`--scan：${sfps}fps 逐帧差分`);
    found = await scanCuts(S.shot, D, sfps, fps, { onTick: (i) => { if (i % 20 === 0) process.stdout.write('.'); } });
    console.log(' 完成');
  }
} catch (e) { await S.close(); die(e.message, 1); }
let windows = [];
if (found) {
  try { windows = normalizeWindows(found.raw, D, found.source); } catch (e) { await S.close(); die(e.message, 1); }
}

// ---- 取帧表 ----
const rows = [];
let fallback = null;
if (windows.length) {
  const pad = flag('pad', null) != null ? num('pad') : undefined;
  windows.forEach((w, k) => rows.push({
    k: k + 1, w, title: `#${k + 1} ${w.kind} ${w.kind === '硬切' ? `${w.cut.toFixed(3)}s` : `${w.t0.toFixed(3)}–${w.t1.toFixed(3)}s${w.cut != null ? `（cut ${w.cut.toFixed(3)}s）` : ''}`}${w.label ? ` · ${w.label}` : ''}`,
    points: samplePoints(w, fps, D, pad).map((p, i) => ({ ...p, pos: POS[i] })),
  }));
} else {
  // 退回现行行为：与 stills.mjs 同一套规则（MARKS 中点，否则均匀 5 个）
  const marks = await S.page.evaluate(() => (Array.isArray(window.MARKS) ? window.MARKS : null));
  const last = Math.max(0, Math.round(D * fps) - 1);
  const ts = marks?.length ? marks.map((m) => (m.start + m.end) / 2) : [0.08, 0.3, 0.5, 0.7, 0.92].map((p) => D * p);
  fallback = marks?.length ? 'MARKS 中点' : '均匀 5 点';
  const points = ts.map((t, i) => { const k = Math.max(0, Math.min(last, Math.round(t * fps))); return { frame: k, t: +(k / fps).toFixed(4), pos: `点${i + 1}` }; });
  for (let a = 0; a < points.length; a += 5) rows.push({ k: rows.length + 1, w: null, title: `退回${fallback}（${a + 1}–${Math.min(points.length, a + 5)}）`, points: points.slice(a, a + 5) });
}
const sourceLine = windows.length
  ? `剪辑点来源：${found.source}（${found.note}）· ${windows.length} 个窗口`
  : `没有剪辑点（--cuts / window.CUT_WINDOWS / window.CUTS / MARKS 边界都没有${has('scan') ? '，--scan 也没找到峰' : '，没开 --scan'}）：退回现行行为——${fallback}。转场中段没被专门采样`;
console.log(sourceLine);

// ---- 截帧 ----
const dir = join(F.out, label);
mkdirSync(dir, { recursive: true });
for (const n of readdirSync(dir)) if (/^tr\d+-.*\.png$/.test(n)) rmSync(join(dir, n));   // 旧时间轴的帧不留：文件名带时刻，留着会混进新一轮
const EN = { 前: 'before', 入: 'in', 中: 'mid', 出: 'out', 后: 'after' };
for (const r of rows) for (const p of r.points) {
  const png = await S.shot(p.t);
  p.file = join(dir, `tr${r.k}-${EN[p.pos] ?? p.pos.replace('点', 'p')}-${String(p.t.toFixed(3)).replace('.', 'p')}s.png`);
  writeFileSync(p.file, png);
}

// ---- 拼图：在同一个浏览器里排版截图（中文标注要系统字体，ffmpeg drawtext 没有可靠的中文字体）----
const tileW = num('tile', F.width >= F.height ? 360 : 220);
const tileH = Math.round((tileW * F.height) / F.width);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const html = `<!doctype html><meta charset="utf-8"><style>
 body{margin:0;background:#2b2b2b;color:#eee;font:14px/1.35 -apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
 .wrap{padding:14px;display:inline-block} h1{font-size:17px;margin:0 0 4px} .meta{color:#bbb;margin:0 0 10px;max-width:${5 * (tileW + 10)}px}
 .warn{color:#ffcf5c} .row{margin:10px 0 0} .rt{font-weight:600;margin:0 0 4px} .tiles{display:flex;gap:10px}
 .tile{width:${tileW}px} .tile img{display:block;width:${tileW}px;height:${tileH}px;outline:1px solid #555}
 .cap{font:12px/1.3 ui-monospace,Menlo,monospace;padding:3px 0 0;color:#ddd} .cap b{color:#fff;font-family:inherit}
 .mid img{outline:3px solid #ff7a3d}
</style><div class="wrap" id="sheet">
<h1>${esc(F.slug)} · 转场拼图</h1>
<p class="meta">入口 ${esc(F.entry)} · 时长 ${D}s · ${fps}fps · 生成 ${new Date().toLocaleString('sv-SE')}<br>
<span class="${windows.length && !/推测/.test(found.note) ? '' : 'warn'}">${esc(sourceLine)}</span><br>
每格：位置 · 时刻 · 成片帧号（帧格对齐）。橙框 = "中"（转场 = 窗口中点；硬切 = 切后第一帧）。只取帧，不判；看 T6 中间态、框中框、错位、残影、露边。</p>
${rows.map((r) => `<div class="row"><div class="rt">${esc(r.title)}</div><div class="tiles">${r.points.map((p) =>
    `<div class="tile ${p.pos === '中' ? 'mid' : ''}"><img src="${esc(relative(F.out, p.file))}"><div class="cap"><b>${esc(p.pos)}</b> ${p.t.toFixed(3)}s · f${p.frame}</div></div>`).join('')}</div></div>`).join('\n')}
</div>`;
// 排版页写成文件、按 file:// 打开，图按相对路径引用：内嵌 base64 时几十张原生分辨率帧会撑爆 setContent（100 格实测崩过）
const htmlPath = join(F.out, `.${label}-sheet.html`);
writeFileSync(htmlPath, html);
const ctx = await S.browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
const pg = await ctx.newPage();
await pg.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
const sheet = join(F.out, `${label}.png`);
await (await pg.$('#sheet')).screenshot({ path: sheet });
await ctx.close();
rmSync(htmlPath);
const lateErrors = S.errors.slice();
await S.close();

writeMeta(sheet, { tool: 'transitions', dir: F.dir, entry: F.entry, extra: {
  duration: D, fps, source: windows.length ? found.source : null, sourceNote: windows.length ? found.note : null, fallback,
  windows, points: rows.flatMap((r) => r.points.map((p) => ({ row: r.k, title: r.title, pos: p.pos, t: p.t, frame: p.frame, file: relative(F.dir, p.file) }))),
} });

for (const r of rows) console.log(`  ${r.title}\n    ${r.points.map((p) => `${p.pos} ${p.t.toFixed(3)}s(f${p.frame})`).join('  ')}`);
console.log(`\n✓ ${sheet}   ${rows.length} 行 × ${rows[0]?.points.length ?? 0}   meta → ${sheet}.meta.json`);
console.log('下一步：用 Read 打开这张图真的看，尤其橙框那一格。看什么见 SKILL.md「转场拼图」。');
if (lateErrors.length) { console.warn(`⚠ 页面有 ${lateErrors.length} 条错误`); process.exit(1); }
