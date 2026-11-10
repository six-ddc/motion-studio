// 静帧闸门：渲若干关键时刻的静帧，拼成一张带时间戳的对照图。
//
// 写完代码不要直接渲整片，先出 3-5 张关键静帧给人看。方向错了只损失几十秒，不是半小时。
//
// 用法:
//   node <film-critique>/scripts/stills.mjs --film tang --at 1.2,8.8,9.8,22
//   node <film-critique>/scripts/stills.mjs --film tang            不给 --at：
//        场景若暴露 window.MARKS 就取每个标记的中点，否则均匀取 5 个时刻
//   --cols 4   --label stills   --tile 420（每格宽度）
//   --entries look/a.html,look/b.html,look/c.html   比稿：每个入口一行、同一组时刻，拼成 out/lookdev.png
//        （不给 --at 时每个入口取自己时长的中点；入口是片子目录下任意暴露 seek 的页面，不必是完整的片子）
// 产出：films/<slug>/out/stills/still-<t>s.png 与 out/<label>.png
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { args, resolveFilm, openScene, die, FILM_OPTS } from './_film.mjs';
import { writeMeta } from './_fresh.mjs';

const { flag, num } = args({
  usage: 'node stills.mjs --film <slug> [--at 1.2,8.8] [--entries a.html,b.html] [--cols 4] [--label stills] [--tile 420]',
  about: '静帧闸门：渲若干关键时刻的静帧拼成对照图。产出 films/<slug>/out/stills/still-<t>s.png 与 out/<label>.png',
  opts: {
    ...FILM_OPTS, entry: ['<x.html>', '临时换入口'],
    entries: ['<a.html,b.html,...>', '比稿：多个入口各出一行静帧，拼成一张图（默认 label 为 lookdev）'],
    at: ['<t1,t2,...>', '时刻（秒，逗号分隔）；不给时取 window.MARKS 中点，否则均匀 5 个'],
    cols: ['<N>', '对照图列数'], label: ['<name>', '对照图文件名（默认 stills）'], tile: ['<px>', '每格宽度（默认 420）'],
  },
});
const F = resolveFilm(flag('film'));
const entriesRaw = flag('entries', null);
const entries = entriesRaw ? entriesRaw.split(',').map((e) => e.trim()).filter(Boolean) : null;
if (entries && !entries.length) die('--entries 里没有入口');
const label = flag('label', entries ? 'lookdev' : 'stills');
const tileW = num('tile', 420);
const atRaw = flag('at', null);
const atTimes = atRaw ? atRaw.split(',').map(Number).filter(Number.isFinite) : null;
if (atRaw && !atTimes.length) die('--at 里没有合法的时刻');

const dir = join(F.out, 'stills');
mkdirSync(dir, { recursive: true });
const files = [], labels = [], points = [];
let lateErrors = [], source, duration = null, perRow = 0;

if (entries) {
  // 比稿：每个入口一行。入口各有各的 DURATION，所以不给 --at 时取各自的中点。
  for (const e of entries) if (!existsSync(join(F.dir, e))) die(`--entries：${join(F.dir, e)} 不存在`);
  source = atTimes ? '--at' : '各入口时长的中点';
  for (const e of entries) {
    const Fe = { ...F, entry: e, entryUrl: '/' + e.split('/').map(encodeURIComponent).join('/') };
    const S = await openScene(Fe);
    if (S.errors.length) { await S.close(); die(`${e} 报错：\n  ` + S.errors.join('\n  '), 1); }
    const ts = atTimes ?? (S.duration ? [+(S.duration * 0.5).toFixed(2)] : [0]);
    if (perRow && ts.length !== perRow) { await S.close(); die('内部错误：各入口的时刻数不一致'); }
    perRow = ts.length;
    const tag = basename(e, '.html');
    for (const t of ts) {
      const file = join(dir, `look-${tag}-${String(t).replace('.', 'p')}s.png`);
      writeFileSync(file, await S.shot(t));
      files.push(file); labels.push(`${tag} ${t}s`); points.push({ entry: e, t, file: relative(F.dir, file) });
      console.log(`  ${e}  t=${t}s  ->  ${file}`);
    }
    lateErrors = lateErrors.concat(S.errors.map((x) => `${e}: ${x}`));
    await S.close();
  }
  console.log(`时刻来源：${source}`);
} else {
  const S = await openScene(F);
  if (S.errors.length) { await S.close(); die('场景报错：\n  ' + S.errors.join('\n  '), 1); }
  let times;
  if (atTimes) { times = atTimes; source = '--at'; }
  else {
    const marks = await S.page.evaluate(() => window.MARKS ?? null);
    if (marks?.length) { times = marks.map((m) => +(((m.start + m.end) / 2).toFixed(2))); source = 'MARKS 中点'; }
    else if (S.duration) { times = [0.08, 0.3, 0.5, 0.7, 0.92].map((p) => +(S.duration * p).toFixed(2)); source = '均匀 5 点'; }
    else { await S.close(); die('没给 --at，场景也没有 window.DURATION / window.MARKS'); }
  }
  // 中点 / 均匀点很少正好落在转场中段：转场另跑 transitions.mjs
  console.log(`时刻来源：${source}${source === '--at' ? '' : '（不对准转场中段；转场用 transitions.mjs）'}`);
  for (const t of times) {
    const file = join(dir, `still-${String(t).replace('.', 'p')}s.png`);
    writeFileSync(file, await S.shot(t));
    files.push(file); labels.push(`${t}s`); points.push({ t, file: relative(F.dir, file) });
    console.log(`  t=${t}s  ->  ${file}`);
  }
  duration = S.duration ?? null;
  lateErrors = S.errors.slice();
  await S.close();
}

// 拼图。xstack 的 grid= 要求所有输入等大，所以每格显式缩到同一尺寸，
// 补位格也用同一尺寸（旧版用 Math.round(h/w) 估高度，9:16 时补位格比真格高 100px）。
const cols = Math.min(num('cols', entries ? perRow : Math.min(5, files.length)), files.length);
const rows = Math.ceil(files.length / cols);
const tileH = 2 * Math.round((tileW * F.height) / F.width / 2);
const pad = cols * rows - files.length;
const fs = Math.round(tileW / 14);
// 时间戳写在每格下方的边条里，不压在画面上 —— 压在左上角会挡住场景自己的角落内容（实测挡住过一个小字注释）
const band = 2 * Math.round(fs * 0.9);
const drawn = files.map((_, i) =>
  `[${i}:v]scale=${tileW}:${tileH},pad=iw+8:ih+8+${band}:4:4:color=0x808080,` +
  `drawtext=text='${labels[i].replace(/[^\w.\- \u4e00-\u9fff]/g, '_')}':x=10:y=h-${band}+(${band}-th)/2-2:fontsize=${fs}:fontcolor=white[v${i}]`);
const fillers = Array.from({ length: pad }, (_, k) => `color=c=0x808080:s=${tileW + 8}x${tileH + 8 + band}:d=1[f${k}]`);
const inputs = files.map((_, i) => `[v${i}]`).join('') + fillers.map((_, k) => `[f${k}]`).join('');
const sheet = join(F.out, `${label}.png`);
const ff = ['-hide_banner', '-loglevel', 'error', '-y'];
files.forEach((f) => ff.push('-i', f));
const stack = cols * rows === 1 ? `${inputs}null[out]` : `${inputs}xstack=inputs=${cols * rows}:grid=${cols}x${rows}:fill=0x808080[out]`;
ff.push('-filter_complex', [...drawn, ...fillers, stack].join(';'), '-map', '[out]', '-frames:v', '1', sheet);

await new Promise((ok, no) => {
  const p = spawn('ffmpeg', ff, { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('close', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg 退出码 ${c}`))));
});

writeMeta(sheet, { tool: 'stills', dir: F.dir, entry: F.entry, extra: {
  duration, source, ...(entries ? { entries } : {}), points } });
console.log(`\n✓ ${sheet}   ${files.length} 张 / ${cols}×${rows}   meta → ${sheet}.meta.json`);
console.log(entries ? '下一步：用 Read 打开这张图真的看，再交给用户挑方向。每行是一个入口。'
  : '下一步：用 Read 打开这张图真的看。看什么见 SKILL.md「静帧闸门」。');
if (lateErrors.length) { console.warn(`⚠ 页面有 ${lateErrors.length} 条错误`); process.exit(1); }
