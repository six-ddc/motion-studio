#!/usr/bin/env node
// 图片 / 音频批处理（ffmpeg）。
//   node <film-assets>/scripts/media.mjs image --film <slug> --size 1080x1920 [--fit cover|contain] [--format webp|png|jpg] [--outdir assets/img] files...
//   node <film-assets>/scripts/media.mjs audio --film <slug> [--rate 48000] [--outdir assets/audio] files...
//   node <film-assets>/scripts/media.mjs tiles [--film <slug>] <视频> [--count 24 | --every <秒>] [--cols 6] [--width 320]
//        [--words <narration.json>] [--offset <秒>] [--cuts [--scene 0.3]] [--font <字体文件>] [--out <png>] [--keep]
//     拆片用的帧网格：均匀抽帧（或 --cuts 时每个镜头取中点一帧）拼成一张图，每格标时刻；
//     给 --words 时再标"这一刻在念哪个词"。--cuts 用 ffmpeg 的 scene 分数找剪切点，并把列表写进旁边的 .json。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { FILM_OPTS, parseArgs, resolveFilm, fail } from '../../film-core/lib/film.mjs';

const A = parseArgs({
  usage: 'node media.mjs image|audio|tiles [--film <slug>] [选项] <文件...>',
  about: '图片 / 音频批处理（ffmpeg），以及拆片用的帧网格。\n'
    + '  image --film <slug> --size WxH [--fit cover|contain] [--format webp|png|jpg] [--outdir assets/img] 文件...\n'
    + '  audio --film <slug> [--rate 48000] [--outdir assets/audio] 文件...\n'
    + '  tiles [--film <slug>] <视频> [--count 24 | --every 秒] [--cols 6] [--width 320] [--max 60]\n'
    + '        [--words narration.json] [--offset 秒] [--cuts [--scene 0.3]] [--font 字体文件] [--out png] [--keep]',
  positional: '<image|audio|tiles> <文件...>',
  positionalHelp: '子命令 + 输入文件（相对片子目录；tiles 不给 --film 时相对 cwd）',
  opts: {
    ...FILM_OPTS,
    size: ['<WxH>', 'image：输出尺寸'], fit: ['<cover|contain>', 'image：适配方式（默认 cover）'],
    format: ['<webp|png|jpg>', 'image：输出格式（默认 webp）'], outdir: ['<dir>', 'image/audio：输出目录（相对片子目录）'],
    rate: ['<Hz>', 'audio：采样率（默认 48000）'],
    count: ['<N>', 'tiles：均匀抽几帧（默认 24）'], every: ['<秒>', 'tiles：每隔几秒抽一帧'],
    cols: ['<N>', 'tiles：列数（默认 6）'], width: ['<px>', 'tiles：每格宽（默认 320）'], max: ['<N>', 'tiles：最多几格（默认 60）'],
    words: ['<narration.json>', 'tiles：标注这一刻在念哪个词'], offset: ['<秒>', 'tiles：--words 的时间偏移'],
    cuts: 'tiles：按剪切点（scene 分数）每个镜头取中点一帧', scene: ['<阈值>', 'tiles：--cuts 的 scene 阈值（默认 0.3）'],
    font: ['<字体文件>', 'tiles：标注字体'], out: ['<png>', 'tiles：输出图'], keep: 'tiles：保留中间帧',
  },
});
const die = (m, code = 2) => fail(m, code);
/** 解析片子；返回 { slug, dir, config, path(p) }（p 相对片子目录，绝对路径原样） */
const film = () => {
  let F;
  try { F = resolveFilm(A.flag('film'), A); } catch (e) { die(e.message); }
  return { ...F, path: (p) => (isAbsolute(p) ? p : join(F.dir, p)) };
};
const mode = A.argv[0];
if (!['image', 'audio', 'tiles'].includes(mode)) die('第一个参数必须是 image / audio / tiles');
if (mode === 'tiles') { tiles(); process.exit(0); }
const F = film();
const valueFlags = new Set(['--film', '--films-dir', '--size', '--fit', '--format', '--outdir', '--rate']);
const files = A.argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !valueFlags.has(arr[i - 1]));
if (!files.length) die('没给输入文件');
if (spawnSync('ffmpeg', ['-version']).status !== 0) die('找不到 ffmpeg');

const outdir = F.path(A.flag('outdir', mode === 'image' ? 'assets/img' : 'assets/audio'));
mkdirSync(outdir, { recursive: true });
let failed = 0;
const kb = (p) => `${(statSync(p).size / 1024).toFixed(1)} KB`;

for (const rel of files) {
  const src = F.path(rel);
  if (!existsSync(src)) { console.error(`✗ 不存在：${src}`); failed++; continue; }
  const stem = basename(src).replace(/\.[^.]+$/, '');
  let out, ff;
  if (mode === 'image') {
    const m = /^(\d+)x(\d+)$/.exec(A.flag('size', '') || '');
    if (!m) die('image 需要 --size WxH');
    const [w, h] = [m[1], m[2]], fit = A.flag('fit', 'cover'), fmt = A.flag('format', 'webp');
    const vf = fit === 'cover'
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
      : fit === 'contain'
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        : die(`--fit 只能是 cover / contain，收到 ${fit}`);
    out = join(outdir, `${stem}.${fmt}`);
    const enc = fmt === 'webp' ? ['-c:v', 'libwebp', '-quality', '90'] : fmt === 'jpg' ? ['-q:v', '2'] : [];
    ff = ['-y', '-v', 'error', '-i', src, '-vf', vf, '-frames:v', '1', ...enc, out];
  } else {
    out = join(outdir, `${stem}.wav`);
    ff = ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '2', '-ar', A.flag('rate', '48000'), '-c:a', 'pcm_s16le', out];
  }
  const r = spawnSync('ffmpeg', ff, { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`✗ ${rel}: ${r.stderr.trim()}`); failed++; continue; }
  console.log(`✓ ${rel} (${kb(src)}) -> ${out} (${kb(out)})`);
}
if (failed) die(`${failed} 个文件失败`, 1);

// ---- tiles：拆片帧网格 ----
// 只读输入，不改任何东西。图是给人（和模型）看的诊断图，不进成片，所以标注用系统字体即可。
function tiles() {
  const valued = new Set(['--film', '--films-dir', '--count', '--every', '--cols', '--width', '--words', '--offset',
    '--scene', '--font', '--out', '--max']);
  const pos = A.argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !valued.has(arr[i - 1]));
  if (pos.length !== 1) die('tiles 要且只要一个输入视频');
  // 不给 --film 时路径相对 cwd；给了就相对片子目录，默认输出进该片 out/tiles/
  const F = A.flag('film') ? film() : null;
  const at = (p) => (F ? F.path(p) : resolve(p));
  const src = at(pos[0]);
  if (!existsSync(src)) die(`不存在：${src}`);
  for (const bin of ['ffmpeg', 'ffprobe']) if (spawnSync(bin, ['-version']).status !== 0) die(`找不到 ${bin}`);
  const num = (n, d) => { const v = A.flag(n); if (v == null) return d; const x = Number(v); if (!Number.isFinite(x) || x <= 0) die(`--${n} 要是正数，拿到 ${v}`); return x; };

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' });
  const dur = Number(probe.stdout.trim());
  if (!(dur > 0)) die(`读不出时长：${src}\n${probe.stderr}`);

  // 剪切点：scene 分数 > 阈值的帧。缩到 320 宽再算，快且对"硬切"足够；渐变/叠化分数低，常常漏，这是它的边界。
  let cuts = null;
  if (A.has('cuts')) {
    const th = num('scene', 0.3);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-an', '-vf', `scale=320:-2,select='gt(scene,${th})',showinfo`, '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) die(`剪切点检测失败：${r.stderr.slice(-500)}`);
    cuts = [...r.stderr.matchAll(/Parsed_showinfo[^\n]*pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.05);
  }

  // 转写：film-narration 的 narration.json（align.py / tts.py 的产物，顶层 words 或 lines[].words，字段 w/start/end），
  // 或者裸的 [{w|word|text, start, end}]。只读。时刻是旁白音频时间，成片时间 = 它 + film.json narrationOffset。
  let words = null, offset = 0;
  if (A.flag('words')) {
    const wp = at(A.flag('words'));
    if (!existsSync(wp)) die(`--words 不存在：${wp}`);
    let j; try { j = JSON.parse(readFileSync(wp, 'utf8')); } catch (e) { die(`--words 不是合法 JSON：${e.message}`); }
    const raw = Array.isArray(j) ? j : j.words ?? (j.lines ?? []).flatMap((l) => l.words ?? []);
    words = raw.map((w) => ({ w: String(w.w ?? w.word ?? w.text ?? ''), start: Number(w.start), end: Number(w.end) }))
      .filter((w) => w.w && Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
    if (!words.length) die(`--words 里没读到 {w,start,end}：${wp}`);
    if (A.flag('offset') != null) offset = Number(A.flag('offset'));
    else if (F && existsSync(F.path('film.json'))) offset = Number(JSON.parse(readFileSync(F.path('film.json'), 'utf8')).narrationOffset ?? 0);
    if (!Number.isFinite(offset)) die('--offset 要是数');
  }

  // 取样时刻
  let shots;
  if (cuts) {
    const edges = [0, ...cuts, dur];
    shots = edges.slice(0, -1).map((a, i) => ({ a, b: edges[i + 1], t: (a + edges[i + 1]) / 2, k: i + 1 }));
    const max = Math.floor(num('max', 60));
    if (shots.length > max) {
      console.log(`⚠ ${shots.length} 个镜头，网格只放均匀挑出的 ${max} 个（--max 调）；完整列表在 .json 里`);
      shots = Array.from({ length: max }, (_, i) => shots[Math.floor((i * shots.length) / max)]);
    }
  } else {
    const every = A.flag('every') != null ? num('every') : null;
    const n = every ? Math.max(1, Math.floor(dur / every)) : Math.floor(num('count', 24));
    const step = every ?? dur / n;
    shots = Array.from({ length: n }, (_, i) => ({ t: Math.min(dur - 0.001, (i + 0.5) * step) }));
  }

  const isWide = (s) => /^[\x21-\x7e]+$/.test(s);       // 拉丁词之间要空格，中文逐字不要
  const wordsAt = (t) => {
    if (!words) return '';
    const tt = t - offset, win = 0.6;
    const near = words.filter((w) => w.end >= tt - win && w.start <= tt + win);
    return near.map((w, i) => {
      const s = w.start <= tt && tt < w.end ? `【${w.w}】` : w.w;
      return i && (isWide(w.w) || isWide(near[i - 1].w)) ? ` ${s}` : s;
    }).join('');
  };

  const W = Math.floor(num('width', 320)), cols = Math.floor(num('cols', 6));
  const fs = Math.max(12, Math.round(W / 16)), bar = Math.round(fs * 3.4);
  const fontfile = A.flag('font') ?? findFont();
  const outPng = A.flag('out') ? at(A.flag('out'))
    : F ? F.path(`out/tiles/${basename(src).replace(/\.[^.]+$/, '')}.png`) : src.replace(/\.[^.]+$/, '') + '.tiles.png';
  const tmp = join(dirname(outPng), `.${basename(outPng)}.frames`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;   // filtergraph 里的路径加引号（字体路径常带空格）

  const fmt = (x) => x.toFixed(2);
  const rows = [];
  shots.forEach((s, i) => {
    const head = s.k ? `#${s.k}  ${fmt(s.a)}–${fmt(s.b)}s` : `${fmt(s.t)}s`;
    let said = wordsAt(s.t);
    const maxChars = Math.floor((W - 12) / fs) * (said && isWide(said.replace(/[【】 ]/g, '')) ? 2 : 1);
    if ([...said].length > maxChars) {                      // 截断时保住【当前词】
      const k = said.indexOf('【');
      const chars = [...said];
      const c = k < 0 ? 0 : [...said.slice(0, k)].length;
      const from = Math.max(0, Math.min(chars.length - maxChars, c - Math.floor(maxChars / 3)));
      said = chars.slice(from, from + maxChars).join('');
    }
    const label = join(tmp, `l${i}.txt`);
    writeFileSync(label, said ? `${head}\n${said}` : head);
    const vf = `scale=${W}:-2,pad=iw:ih+${bar}:0:0:color=black,`
      + `drawtext=fontfile=${q(fontfile)}:textfile=${q(label)}:fontsize=${fs}:fontcolor=white:x=6:y=h-${bar}+${Math.round(fs * 0.35)}:line_spacing=${Math.round(fs * 0.3)}`;
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(s.t), '-i', src, '-frames:v', '1', '-vf', vf, join(tmp, `f${String(i).padStart(4, '0')}.png`)], { encoding: 'utf8' });
    if (r.status !== 0) die(`抽帧失败 t=${fmt(s.t)}：${r.stderr.trim()}`);
    rows.push({ t: +fmt(s.t), ...(s.k ? { shot: s.k, from: +fmt(s.a), to: +fmt(s.b) } : {}), ...(words ? { words: wordsAt(s.t) } : {}) });
  });

  const gridRows = Math.ceil(shots.length / cols);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', '1', '-i', join(tmp, 'f%04d.png'),
    '-vf', `tile=${cols}x${gridRows}:padding=4:margin=4:color=0x202020`, '-frames:v', '1', outPng], { encoding: 'utf8' });
  if (r.status !== 0) die(`拼网格失败：${r.stderr.trim()}`);
  if (!A.has('keep')) rmSync(tmp, { recursive: true, force: true });
  const side = outPng.replace(/\.png$/i, '') + '.json';
  writeFileSync(side, JSON.stringify({ video: src, duration: +fmt(dur), offset, tiles: rows, cuts: cuts?.map((c) => +c.toFixed(3)) ?? null }, null, 1) + '\n');

  console.log(`✓ ${shots.length} 格（${cols}×${gridRows}），${fmt(dur)}s -> ${outPng} (${(statSync(outPng).size / 1024).toFixed(1)} KB)`);
  if (cuts) console.log(`  剪切点 ${cuts.length} 个（scene > ${A.flag('scene', '0.3')}）：${cuts.slice(0, 40).map(fmt).join(' ')}${cuts.length > 40 ? ' …' : ''}`);
  if (words) console.log(`  词标注：${words.length} 个词，offset ${offset}s（【】= 该时刻正在念）`);
  console.log(`  明细 -> ${side}`);
}

function findFont() {
  // 标注里有中文，要一个带 CJK 的字体文件。先问 fontconfig，再试几个常见位置；都没有就让用户 --font。
  const fc = spawnSync('fc-match', ['-f', '%{file}', 'sans-serif:lang=zh-cn'], { encoding: 'utf8' });
  if (fc.status === 0 && fc.stdout && existsSync(fc.stdout.trim())) return fc.stdout.trim();
  for (const p of ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc'])
    if (existsSync(p)) return p;
  die('找不到带中文的字体文件，用 --font <字体文件> 指定');
}
