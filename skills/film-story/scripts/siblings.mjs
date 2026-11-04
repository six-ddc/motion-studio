#!/usr/bin/env node
// siblings.mjs —— 近作对照：新片定视觉方向之前，看一眼仓库里其他片子长什么样。
//
//   node <film-story>/scripts/siblings.mjs --film <slug> [--films-dir d] [--out path] [--no-render] [--tile 420]
//
// 打印一张表（片子 / 画幅 / 选定的视觉方向 / 代表帧来源），并把每支片子的一张代表帧并排拼成
// films/<slug>/out/siblings.png（第一格是本片自己，有画面就放，没有就标"尚无画面"）。
//
// 为什么要它：模型不记得上一支片子长什么样。"跨次生成不要收敛到同一套选择"靠自觉做不到，
// 只能把上一次生成变成一个看得见的文件。方法见 references/divergence.md 第 3 节。
//
// 取数规则（取不到就如实说，不静默跳过）：
//   画幅        film.json format；没有 → 未声明
//   视觉方向    该片 style_guide 里选定的那一行，用 check_shotlist.py --divergence 解析——和门同一份解析，
//               两处各写一份迟早给出相反结论；取不到 → 未声明（并说为什么）
//   代表帧      out/ 下的 final-*-poster.png > silent-*-poster.png > 其他 *-poster.png
//               > 成片 final-*/silent-*.mp4（跳过 -loop）取 40% 处一帧 > 现渲 scene.html 40% 处一帧（--no-render 关掉）
//               都没有 → 图上画一个标了原因的空格
//   现渲不往兄弟片子的目录写任何文件（stills.mjs 会写 out/stills/，所以这里直接用同一个截帧实现取内存里的 PNG）。
//
// 只读其他片子；只写 --out（默认 films/<slug>/out/siblings.png）。
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, filmsDir, resolveFilm, fail, main, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene, launchBrowser } from '../../film-core/lib/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_PY = join(HERE, 'check_shotlist.py');
const RATIO = { '9x16': 9 / 16, '16x9': 16 / 9, '1x1': 1 };
// new-film.mjs 写进 scene.html 的占位段落标记（film-core/scripts/new-film.mjs）
const SCAFFOLD = /占位内容：只为让脚手架立刻能渲通/;
// 表和图上只显示"选定："之后的内容（补记里那句括号说明留在 style_guide 里，不进对照表）
const shortDir = (x) => (x ?? '').replace(/^选定[^：:]{0,40}[：:]\s*/, '');

const args = parseArgs({
  usage: 'node siblings.mjs --film <slug> [--films-dir d] [--out path] [--no-render] [--tile 420]',
  about: '近作对照：把其他片子的代表帧和视觉方向并排拼成 films/<slug>/out/siblings.png。只读其他片子，只写 --out。',
  opts: {
    ...FILM_OPTS, film: ['<slug>', '本片（必填；其他片子都是它的近作）'],
    out: ['<path>', '输出图（默认 films/<slug>/out/siblings.png）'], 'no-render': '没有现成画面时不现渲 scene.html',
    tile: ['<px>', '每格宽度（默认 420）'],
  },
});

await main(async () => {
  const slug = args.flag('film', null);
  if (!slug) fail('要 --film <slug>（本片；其他片子都是它的近作）', 2);
  const FD = filmsDir(args);
  if (!existsSync(join(FD, slug))) fail(`${join(FD, slug)} 不存在（films 目录：${FD}；可用 --films-dir / $FILMS_DIR）`, 2);
  const outPath = resolve(args.flag('out', join(FD, slug, 'out', 'siblings.png')));
  const tile = args.num('tile', 420);
  const render = !args.has('no-render');

  const others = readdirSync(FD)
    .filter((d) => !d.startsWith('_') && !d.startsWith('.') && d !== slug && statSync(join(FD, d)).isDirectory())
    .sort();
  const tmp = mkdtempSync(join(tmpdir(), 'siblings-'));
  const rows = [];
  let browser = null;
  try {
    for (const s of [slug, ...others]) {
      const d = join(FD, s);
      const r = { slug: s, self: s === slug, ...meta(d) };
      const f = await frame(d, s, FD, tmp, { self: s === slug, render }, () => (browser ??= launchBrowser()));
      Object.assign(r, f);
      rows.push(r);
    }
    printTable(rows);
    mkdirSync(dirname(outPath), { recursive: true });
    browser = await (browser ?? launchBrowser());
    await composite(await browser, rows, tile, outPath);
    console.log(`\n对照图：${outPath}`);
    console.log('打开它看一遍——表里的方向是作者自己声明的，图是实际长出来的样子，两者常常不一致。');
    const miss = rows.filter((r) => !r.self && !r.png);
    if (miss.length) console.log(`没有代表帧的片子（图上已标出）：${miss.map((r) => r.slug).join('、')}`);
  } finally {
    if (browser) await (await browser).close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 画幅 + 选定的视觉方向 ─────────────────────────────────────
function meta(d) {
  const readJ = (f) => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return null; } };
  const format = readJ('film.json')?.format ?? null;
  let direction = null, why = null;
  if (!existsSync(join(d, 'docs', 'style_guide.md'))) why = '没有 docs/style_guide.md';
  else {
    try {
      const j = JSON.parse(execFileSync('python3', [CHECK_PY, '--film', d, '--divergence'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      direction = j.direction;
      if (direction && j.direction_detail && !direction.includes(j.direction_detail)) direction += ` — ${j.direction_detail}`;
      if (!direction) why = 'style_guide 里没有标明选定的视觉方向';
    } catch (e) { why = `解析失败：${String(e.stderr || e.message).trim().split('\n').at(-1)}`; }
  }
  return { format, direction, why };
}

// ── 代表帧 ─────────────────────────────────────────────────────
async function frame(d, s, FD, tmp, { self, render }, getBrowser) {
  const out = join(d, 'out');
  const files = existsSync(out) ? readdirSync(out) : [];
  const poster = ['final-', 'silent-', ''].map((p) => files.filter((f) => f.startsWith(p) && f.endsWith('-poster.png')).sort()[0]).find(Boolean);
  if (poster) return { png: readFileSync(join(out, poster)), src: `out/${poster}` };

  const video = files.filter((f) => /^(final|silent)-.*\.mp4$/.test(f) && !f.endsWith('-loop.mp4')).sort()[0];
  if (video) {
    try {
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(out, video)], { encoding: 'utf8' }).trim());
      const t = (dur * 0.4).toFixed(2);
      const png = join(tmp, `${s}.png`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', t, '-i', join(out, video), '-frames:v', '1', png]);
      return { png: readFileSync(png), src: `out/${video} @ ${t}s` };
    } catch (e) { return { png: null, src: null, frameWhy: `成片 ${video} 取帧失败：${String(e.message).split('\n')[0]}` }; }
  }

  const reasons = ['没有 out/*-poster.png', '没有成片 mp4'];
  if (!existsSync(join(d, 'scene.html'))) return { png: null, src: null, frameWhy: [...reasons, '没有 scene.html'].join('；') };
  if (!existsSync(join(d, 'film.json'))) return { png: null, src: null, frameWhy: [...reasons, '没有 film.json，渲不了 scene.html'].join('；') };
  // 本片在定视觉方向时 scene.html 多半还是脚手架的占位，现渲出来的不是"本片的样子"，不渲
  if (self) return { png: null, src: null, frameWhy: '还没有海报或成片（定方向时本来就没有）' };
  if (!render) return { png: null, src: null, frameWhy: [...reasons, '没现渲（--no-render）'].join('；') };
  // new-film.mjs 的脚手架占位（一颗落下的球）：渲出来也不代表这支片子的长相，标出来而不是拿它当代表帧
  const sceneSrc = existsSync(join(d, 'scene.html')) ? readFileSync(join(d, 'scene.html'), 'utf8') : '';
  if (SCAFFOLD.test(sceneSrc)) return { png: null, src: null, frameWhy: [...reasons, 'scene.html 还是 new-film.mjs 的脚手架占位，没有可代表的画面'].join('；') };
  let S;
  try {
    const film = resolveFilm(join(FD, s));   // 只读：resolveFilm 不建目录，openScene record:false 不写加载记录
    S = await openScene(film, film.config.format, { browser: await getBrowser(), scale: 0.5, record: false });
    const t = +(S.info.duration * 0.4).toFixed(2);
    const png = await S.shot(t);
    return { png, src: `现渲 scene.html @ ${t}s（不是定稿帧）` };
  } catch (e) {
    return { png: null, src: null, frameWhy: [...reasons, `现渲 scene.html 失败：${String(e.message).split('\n')[0]}`].join('；') };
  } finally { if (S) await S.close().catch(() => {}); }
}

// ── 输出 ──────────────────────────────────────────────────────
function printTable(rows) {
  const cell = (x) => String(x ?? '').replace(/\|/g, '\\|');
  console.log('| 片子 | 画幅 | 选定的视觉方向（取自它的 style_guide） | 代表帧 |');
  console.log('|---|---|---|---|');
  for (const r of rows) {
    const fmt = r.format ?? '未声明';
    const dir = r.direction ? shortDir(r.direction).slice(0, 90) : `未声明（${r.why}）`;
    const fr = r.png ? r.src : `**无**：${r.frameWhy}`;
    console.log(`| ${cell(r.slug)}${r.self ? '（本片）' : ''} | ${cell(fmt)} | ${cell(dir)} | ${cell(fr)} |`);
  }
}

async function composite(browser, rows, tile, outPath) {
  const H = tile;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = rows.map((r) => {
    const w = Math.round(H * (RATIO[r.format] ?? 9 / 16));
    const img = r.png
      ? `<img src="data:image/png;base64,${Buffer.from(r.png).toString('base64')}" style="width:${w}px;height:${H}px">`
      : `<div class="miss" style="width:${w - 6}px;height:${H - 6}px"><b>${r.self ? '本片尚无画面' : '无代表帧'}</b><span>${esc(r.frameWhy)}</span></div>`;
    const dir = r.direction ? esc(shortDir(r.direction).slice(0, 70)) : `<i>未声明（${esc(r.why)}）</i>`;
    return `<figure style="width:${Math.max(w, 260)}px" class="${r.self ? 'self' : ''}${r.png ? '' : ' nofr'}">${img}
      <figcaption><b>${esc(r.slug)}${r.self ? '（本片）' : ''}</b> · ${esc(r.format ?? '画幅未声明')}<br>${dir}<br><small>${esc(r.png ? r.src : '无代表帧')}</small></figcaption></figure>`;
  }).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px;background:#ececec;font:15px/1.4 "PingFang SC","Noto Sans SC",sans-serif;color:#222;width:max-content;max-width:2400px}
    h1{font-size:18px;margin:0 0 14px}
    .wrap{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}
    figure{margin:0;background:#fff;padding:8px;box-shadow:0 1px 3px #0003}
    figure.self{outline:3px solid #2a6df4}
    figure img{display:block;object-fit:cover;background:#000}
    .miss{border:3px dashed #d33;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0;color:#b22;background:#fbeaea}
    .miss b{font-size:20px;margin-bottom:8px}.miss span{font-size:13px;padding:0 10px}
    figcaption{margin-top:6px;font-size:13px}figcaption i{color:#b22}figcaption small{color:#777}
  </style><h1>近作对照 · ${esc(rows[0].slug)}　（蓝框 = 本片；红色虚线 = 取不到代表帧）</h1><div class="wrap">${cards}</div>`;
  const page = await browser.newPage({ viewport: { width: 2400, height: 800 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const box = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; });
    await page.setViewportSize({ width: box.w, height: box.h });
    writeFileSync(outPath, await page.screenshot({ type: 'png', fullPage: true }));
  } finally { await page.close(); }
}
