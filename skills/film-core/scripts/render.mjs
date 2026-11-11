#!/usr/bin/env node
// 逐帧渲染：Playwright 调 seek(t) 截图 -> ffmpeg -> H.264 MP4（无声）
//
//   node <film-core>/scripts/render.mjs --film <slug>                 film.json 的默认设置
//   node <film-core>/scripts/render.mjs --film x --fps 30 --sub 1     迭代用，快很多
//   node <film-core>/scripts/render.mjs --film x --from 4 --to 7      只重渲 4-7 秒
//   node <film-core>/scripts/render.mjs --film x --all                film.json formats 全部
//   node <film-core>/scripts/render.mjs --film x --workers 1          串行（排查并行问题时用）
//
// 参数全集见 references/render.md。产出：films/<slug>/out/silent-<format>[-<from>-<to>].mp4
//
// 并行：seek(t) 是纯函数 → 帧间零依赖 → 可以多个页面同时渲。时间轴切成固定长度的分片，
// 每个 worker（一个页面）领一片，各自起一个 ffmpeg 编码，最后 concat -c copy 拼接。
// 编码也因此并行 —— 只并行截图的话 x264 会成为新瓶颈。
//
// 运动模糊：每个输出帧在 [k/fps, (k+shutter)/fps) 内均匀取 sub 个子帧，
// ffmpeg tmix 平均每 sub 个，select 取每组最后一个，setpts 重排时间戳。分片边界总在输出帧之间，所以不影响 tmix。
//
// 自适应子帧（页面定义了 window.MOTION(t0, t1) 且 sub>1 时；--no-adaptive 关掉）：
// 每个输出帧先问 MOTION 这段快门里最大位移多少像素，按 ~6px 一张取 4–48 张子帧；
// MOTION 返回 0 时只截快门两端，两张逐字节相同就用一张（静止帧≈零成本），不同就说明 MOTION 说错了，退回 4 张并警告。
// 有 window.CUTS（硬切时刻数组）时，跨切点的快门截到切点为止，只取帧起点那一侧的子帧。
// 这条路径子帧数逐帧不同，tmix 表达不了，改在 Node 里整数平均（lib/pngmix.mjs）后以原始像素喂 x264。
// 没定义 MOTION 的片子一行都不经过它：截图次数、tmix 流水线、缓存键、清单键都与改动前相同，输出逐字节不变。
// （为什么不对所有片子做"两端相同就跳过"：两端相同推不出中间相同——往返运动、闪烁、一帧内转一整圈都是反例。
//   能保证中间也不动的只有场景自己，所以静止判定只认场景声明的 MOTION = 0。）
//
// 逐帧哈希清单：每个输出帧的子帧 PNG 的 md5 写进 out/.render/<format>.frames.json。
// 下次渲染同样设置时对比上一份，打印"哪些时间段的像素变了" —— 改第 3 镜时一眼看出第 7 镜有没有被连带改动。
// 清单还记 key.png（截图 PNG 编码方式，只在 fast 时有这个字段；没有 = default）和 inputs（渲染输入指纹，
// lib/frames.mjs），seamcheck 门 5 按它们对账。
//
// 截图编码：默认 --png fast（CDP optimizeForSpeed，单帧约 5 倍快，解码后像素与 default 相同，字节不同，见 lib/browser.mjs）。
// 模式进分片缓存键和清单键（只在 fast 时加字段）：default 的旧缓存键、旧清单键因此不变，也不会被 fast 误复用。
//
// 运行时挂载：场景 import 的 ./runtime/* 由 lib/serve.mjs 解析（片内优先，否则套件）。第一个页面加载完之后，
// 实际加载的运行时（名字 + sha256）并进分片缓存键：运行时改了一个字节，分片全部重编——
// 逐帧哈希比对只能发现"像素变了"，挂载的运行时变了而像素碰巧没变时也不该沿用旧分片（成片对应的输入就不是这份了）。
// 同一份清单写进渲染清单的 runtime 字段，deliver 按它冻结。
//
// 变体（可选，片子有 content.json 时；schema 见 references/content-json.md）：
//   --variant <id>   同一份 scene.html 按 ?variant=<id> 换数据渲一版 → out/variants/<id>/silent-<fmt>.mp4（+ final-<fmt>.mp4）
//   --matrix         content.json matrix 里的每个组合 × 画幅各渲一版，写 out/variants/manifest.json
// 变体与主片共用分片缓存目录：分片键不含变体（像素一样就该复用），而同一分片的几份不同内容并存
// （主份 + 备份 ~<哈希>.mp4），所以 hook-a / hook-b 来回渲，只有开场那几片各编码一次，CTA 段之外的分片全部复用。
// 没有 content.json 的片子：分片缓存行为、清单路径、输出路径与改动前逐字节相同。
// 变体的逐帧清单另存 out/.render/variants/<id>/<fmt>.frames.json，不覆盖主片基线（seamcheck 门 5 只认主片那份）。
//
// 预检钩子：film.json checks 声明了 "preflight" 时，开渲之前跑 film-core scripts/preflight.mjs（每个要渲的变体 × 画幅一次，带 --format），非 0 不渲。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { join, dirname, isAbsolute, resolve, basename, relative } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { resolveFilm, parseArgs, main, fail, FILM_OPTS, readChecks } from '../lib/film.mjs';
import { CORE_DIR } from '../lib/env.mjs';
import { receiptInputs } from '../lib/receipt.mjs';
import { readContentDoc, parseVariant, expandMatrix, contentHash, variantDir, muxVariant, writeVariantManifest, templateDigest, fileSha256, CONTENT_FILE } from '../lib/content.mjs';
import { openScene, launchBrowser, rendererFingerprint, PNG_MODES, filmBackend, backendMismatch } from '../lib/browser.mjs';
import { frameShooter, inputsFingerprint } from '../lib/frames.mjs';
import { serve, runtimeDigest } from '../lib/serve.mjs';
import { mixPool } from '../lib/pngmix.mjs';

const args = parseArgs({
  usage: 'node render.mjs --film <slug> [选项]',
  about: '逐帧渲染：seek(t) 截图 → ffmpeg → H.264 MP4（无声）。产出 films/<slug>/out/silent-<format>[-<from>-<to>].mp4；参数细节见 references/render.md',
  opts: {
    ...FILM_OPTS,
    entry: ['<x.html>', '临时换入口（不改 film.json）'],
    format: ['<9x16|1x1|16x9>', '画幅（默认 film.json format）'],
    all: 'film.json formats 全部渲一遍',
    fps: ['<N>', '帧率'], sub: ['<N>', '每帧子帧数（运动模糊）'], shutter: ['<0-1>', '快门'],
    crf: ['<N>', 'x264 CRF'], preset: ['<slow|...>', 'x264 preset（默认 slow）'], 'x264-threads': ['<N>', '每个 x264 的线程数（默认 4）'],
    from: ['<s>', '起点秒'], to: ['<s>', '终点秒'], dur: ['<s>', '时长（与 --from 配合）'], out: ['<file.mp4>', '输出文件'],
    workers: ['<N>', '并行页面数（1 = 串行）'], 'pages-per-browser': ['<P>', '每个浏览器开几个页面（默认 2）'],
    'chunk-seconds': ['<S>', '分片秒数（默认 1）'], capture: ['<cdp|locator>', '截图方式（默认 cdp）'],
    png: ['<fast|default>', '截图 PNG 编码（默认 fast）'], 'pin-renderer': '把渲染环境指纹钉进 film.json',
    'no-cache': '不用分片缓存', 'clean-cache': '先清掉分片缓存', scale: ['<k>', '缩放（如 0.5 出小样）'],
    'no-adaptive': '关掉自适应子帧', 'motion-px': ['<px>', '自适应：每张子帧对应的位移（默认 6）'],
    'sub-min': ['<N>', '自适应子帧下限（默认 4）'], 'sub-max': ['<N>', '自适应子帧上限（默认 48）'],
    variant: ['<id>', '按 content.json 渲一个变体（如 hook-b.cta-a；base = 不覆盖）→ out/variants/<id>/'],
    matrix: '按 content.json matrix 渲全部组合 × 画幅 → out/variants/<id>/final-<fmt>.mp4 + manifest.json',
  },
  notes: '自适应子帧相关参数只对定义了 window.MOTION 的场景有效。--variant/--matrix 要片子根目录有 content.json（references/content-json.md）。',
});

// raw：自适应路径，喂已经平均好的原始像素，每个输出帧一张。write 收的是 Promise<{w,h,ch,data}>（线程池里正在平均的帧）：
// 按收到的顺序写，不等它算完就返回，截图因此和平均并行；最多积压 6 帧。第一帧到了才知道 RGB 还是 RGBA，所以晚启动 ffmpeg
function encoder({ outFile, fps, sub, crf, preset, threads, raw = false }) {
  if (raw === true) {
    let inner = null, chain = Promise.resolve();
    const inflight = [];
    return {
      write: async (fp) => {
        chain = chain.then(async () => {
          const f = await fp;
          inner ??= encoder({ outFile, fps, sub: 1, crf, preset, threads, raw: { w: f.w, h: f.h, pix: f.ch === 4 ? 'rgba' : 'rgb24' } });
          await inner.write(f.data);
        });
        chain.catch(() => {});   // 中途被 kill 时没人 await 它，先认领掉（理由同下面 kill 的注释）
        inflight.push(chain);
        if (inflight.length > 6) await inflight.shift();
      },
      end: async () => { await chain; if (!inner) throw new Error(`分片 ${outFile} 一帧都没写`); await inner.end(); },
      kill: () => inner?.kill(),
    };
  }
  const vf = sub > 1
    ? `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/${fps}/TB`
    : `setpts=N/${fps}/TB`;
  const input = raw
    ? ['-f', 'rawvideo', '-pix_fmt', raw.pix, '-s', `${raw.w}x${raw.h}`, '-framerate', String(fps), '-i', '-']
    : ['-f', 'image2pipe', '-framerate', String(fps * sub), '-i', '-'];
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...input,
    '-vf', vf, '-r', String(fps),
    // -threads 必须钉死：x264 默认按核数选线程，不同线程数的输出连解码像素都不同（实测最大差 59–61/255）
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-threads', String(threads),
    '-pix_fmt', 'yuv420p', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const done = new Promise((ok, no) => {
    ff.on('close', (code) => (code === 0 ? ok() : no(new Error(`ffmpeg 退出码 ${code}，输出文件 ${outFile}\n${err.trim()}`))));
    ff.on('error', no);
  });
  ff.stdin.on('error', () => {}); // ffmpeg 先挂时别把 EPIPE 抛成未捕获异常
  const write = async (buf) => { if (!ff.stdin.write(buf)) await new Promise((go) => ff.stdin.once('drain', go)); };
  // kill() 是我们因为别处出错而主动杀它：此时 done 必然以"退出码 null"拒绝，而没人 await 它——
  // 未处理的 rejection 会让 Node 直接崩掉，抢在调用方 `throw aborted` 之前，真正的场景报错一个字都打不出来
  // （film-webfx 三维那一路实测：页面里 seek 抛错，屏幕上只剩"ffmpeg 退出码 null"）。先把这个拒绝认领掉再杀。
  return { write, end: async () => { ff.stdin.end(); await done; }, kill: () => { done.catch(() => {}); ff.kill('SIGKILL'); } };
}

// 连续帧号列表 -> "1.20–1.53s, 4.00–4.10s"
// 变体区间文件名/清单键里的秒数：吸附到帧栅格后最多 3 位小数（75.733 而不是 75.71900000000001）
const secs = (x) => String(+x.toFixed(3));

function ranges(idx, from, fps) {
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    out.push(`${(from + idx[i] / fps).toFixed(2)}–${(from + (idx[j] + 1) / fps).toFixed(2)}s`);
    i = j;
  }
  return out;
}

await main(async () => {
  const F = resolveFilm(args.film, args);
  const C = F.config;
  const fps = args.num('fps', C.fps);
  const sub = args.num('sub', C.sub);
  const shutter = args.num('shutter', C.shutter);
  const crf = args.num('crf', C.crf);
  const preset = args.flag('preset', 'slow');
  // 固定值，不随机器核数变：并行度来自多个 worker 各起一个 ffmpeg，单进程线程数不需要大
  const x264Threads = args.num('x264-threads', 4);
  if (!(Number.isInteger(x264Threads) && x264Threads >= 1)) fail(`x264-threads 必须是 ≥1 的整数，收到 ${x264Threads}`);
  const capture = args.flag('capture', 'cdp');
  // --scale：迭代用的缩小版。只在截图时降采样（见 lib/browser.mjs），产物进 out/draft/，名字带比例，
  // 不叫 silent-*/final-* —— 下游按名字挑成片的工具（mux.sh、contact.sh、align.py）因此挑不中它。
  const scale = args.num('scale', 1);
  const draft = scale !== 1;
  if (draft && capture !== 'cdp') fail('--scale 只支持 --capture cdp');
  const workers = args.num('workers', Math.max(1, Math.min(16, Math.floor(cpus().length / 2))));
  const perBrowser = args.num('pages-per-browser', 2);
  const chunkSeconds = args.num('chunk-seconds', 1);
  const formats = args.has('all') ? F.formats : [args.flag('format', C.format)];
  if (!(Number.isInteger(fps) && fps > 0)) fail(`fps 必须是正整数，收到 ${fps}`);
  if (!(Number.isInteger(sub) && sub >= 1)) fail(`sub 必须是 ≥1 的整数，收到 ${sub}`);
  if (!(shutter > 0 && shutter <= 1)) fail(`shutter 必须在 (0,1]，收到 ${shutter}`);
  if (!(Number.isInteger(workers) && workers >= 1)) fail(`workers 必须是 ≥1 的整数，收到 ${workers}`);
  if (!(Number.isInteger(perBrowser) && perBrowser >= 1)) fail(`pages-per-browser 必须是 ≥1 的整数，收到 ${perBrowser}`);
  if (!(chunkSeconds > 0)) fail(`chunk-seconds 必须 > 0，收到 ${chunkSeconds}`);
  if (!['cdp', 'locator'].includes(capture)) fail(`capture 只能是 cdp / locator，收到 ${capture}`);
  // locator 截图没有快速编码开关，只能是 default
  const pngArg = args.flag('png', 'fast');
  if (!PNG_MODES.includes(pngArg)) fail(`png 只能是 ${PNG_MODES.join(' / ')}，收到 ${pngArg}`);
  const png = capture === 'cdp' ? pngArg : 'default';
  const pngKey = png === 'fast' ? { png } : {};   // 只在 fast 时加字段：default 的键与改动前逐字节相同
  // 自适应子帧的参数（只在场景定义了 window.MOTION 时用到）
  const motionPx = args.num('motion-px', 6);
  const subMin = args.num('sub-min', 4);
  const subMax = args.num('sub-max', 48);
  if (!(motionPx > 0)) fail(`motion-px 必须 > 0，收到 ${motionPx}`);
  if (!(Number.isInteger(subMin) && Number.isInteger(subMax) && subMin >= 2 && subMax >= subMin)) fail(`sub-min/sub-max 必须是整数且 2 ≤ sub-min ≤ sub-max，收到 ${subMin}/${subMax}`);
  const ffv = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffv.status !== 0) fail('找不到 ffmpeg（需要在 PATH 上）');
  const FFMPEG = ffv.stdout.split('\n')[0];   // 进缓存键：换 ffmpeg/x264 版本后分片不复用

  // 渲染任务：(变体, 画幅)。没给 --variant/--matrix 时 variant = null，与改动前完全一样
  const doc = readContentDoc(F.dir);   // 没有 content.json → null
  if ((args.has('variant') || args.has('matrix')) && !doc) fail(`--variant/--matrix 要片子根目录有 ${CONTENT_FILE}（${F.dir}）。schema 见 film-core references/content-json.md`);
  if (args.has('variant') && args.has('matrix')) fail('--variant 和 --matrix 二选一');
  if (args.has('matrix') && args.has('out')) fail('--matrix 一次出多个文件，不能配 --out');
  let jobs;
  if (args.has('matrix')) {
    const fmtArg = args.flag('format', null);
    jobs = expandMatrix(doc).flatMap((v) => {
      const fs = v.formats ?? F.formats;
      return (fmtArg ? fs.filter((f) => f === fmtArg) : fs).map((format) => ({ variant: v, format }));
    });
    if (!jobs.length) fail(`matrix 展开后没有要渲的组合${args.flag('format', null) ? `（--format ${args.flag('format', null)} 不在任何组合的画幅里）` : ''}`);
    console.log(`矩阵 ${jobs.length} 个导出：${jobs.map((j) => `${j.variant.id}/${j.format}`).join('  ')}`);
  } else {
    const v = args.has('variant') ? parseVariant(doc, args.flag('variant', null)) : null;
    jobs = formats.map((format) => ({ variant: v, format }));
  }

  // 预检钩子：checks 声明了 preflight 才跑；脚本由 film-core 提供（不存在时提示并跳过，不拦渲染）
  let checks = null;
  try { checks = readChecks(F.dir); } catch (e) { process.stderr.write(`⚠ film.json checks 格式不对（${e.message}），渲染不读它，跳过预检钩子\n`); }
  if (checks?.has('preflight')) {
    const script = join(CORE_DIR, 'scripts', 'preflight.mjs');
    if (!existsSync(script)) console.log('⚠ film.json checks 声明了 preflight，但 film-core scripts/preflight.mjs 不存在：跳过预检');
    else {
      // 每个要渲的 (变体, 画幅) 各查一次，显式传 --format：content.json variants.format.<画幅> 可以改文案，按别的画幅查会漏
      const seen = new Set();
      for (const j of jobs) {
        const vid = j.variant?.id ?? null, key = `${vid}\u0000${j.format}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = [...(vid ? ['--variant', vid] : []), '--format', j.format];
        const pf = spawnSync(process.execPath, [script, '--film', F.slug, '--films-dir', F.films, ...a], { stdio: 'inherit' });
        if (pf.status !== 0) fail(`预检没过（preflight ${a.join(' ')} 退出码 ${pf.status}），不渲染。改 content.json / 文案后重跑`);
      }
    }
  }

  const srv = await serve(F.dir);
  const { port, close: closeServer } = srv;
  const nBrowsers = Math.ceil(workers / perBrowser);
  const browsers = await Promise.all(Array.from({ length: nBrowsers }, () => launchBrowser({ backend: filmBackend(F) })));
  console.log(`影片 ${F.slug}${C.title ? `  「${C.title}」` : ''}   ${F.dir}`);

  // 渲染器指纹：像素由 Chromium 光栅化决定。和 film.json 记录的不一致时警告（换了渲染器后重渲，像素可能与上次不再逐个相同）
  const fp = { ...(await rendererFingerprint(browsers[0])), ffmpeg: FFMPEG, x264Threads };
  const pinned = F.raw.renderer;
  const drift = pinned ? ['chromium', 'args', 'ffmpeg', 'x264Threads'].filter((k) => k in pinned && JSON.stringify(pinned[k]) !== JSON.stringify(fp[k])) : [];
  // 后端 / 显卡 / 驱动：记录里没有 = 软件后端（老记录与缺省片子不受影响）。硬件后端的像素随显卡和驱动变
  const bdrift = pinned ? backendMismatch(pinned, fp) : null;
  if (bdrift) drift.push(...['backend', 'gpu', 'gpuDriver'].filter((k) => JSON.stringify(pinned[k] ?? null) !== JSON.stringify(fp[k] ?? null)));
  if (drift.length) {
    process.stderr.write(`⚠ 本片记录的渲染环境与当前不同：${drift.map((k) => `${k} ${JSON.stringify(pinned[k] ?? null)} → ${JSON.stringify(fp[k] ?? null)}`).join('；')}。`
      + `像素可能与当初不同，重渲后重跑 seamcheck 并重看静帧（确认后 --pin-renderer 改记）。\n`);
  }
  // 记进 film.json 放在渲染成功之后：渲染中途失败（场景报错、ffmpeg 挂掉）时不该把"这个环境渲过本片"写下来
  const recordRenderer = () => {
    if (!pinned || args.has('pin-renderer')) {
      const raw = JSON.parse(readFileSync(join(F.dir, 'film.json'), 'utf8'));
      raw.renderer = fp;
      writeFileSync(join(F.dir, 'film.json'), JSON.stringify(raw, null, 2) + '\n');
      console.log(`  film.json renderer 记为 Chromium ${fp.chromium} / playwright ${fp.playwright}${fp.backend ? ` / 后端 ${fp.backend}：${fp.gpu}（驱动 ${fp.gpuDriver ?? '未知'}）` : ''}`);
    }
    else {
      // 旧记录缺字段（例如 x264Threads 是后加的）：只补缺的，不覆盖已有的 —— 已有的才是"当初渲它的环境"
      // 后端三项不补：记录是软件后端、现在声明了 gpu 时补上它们会拼出一份"args 是软件、backend 是 gpu"的假记录（上面已告警，--pin-renderer 改记）
      const missing = Object.keys(fp).filter((k) => !(k in pinned) && !['backend', 'gpu', 'gpuDriver'].includes(k));
      if (missing.length) {
        const raw = JSON.parse(readFileSync(join(F.dir, 'film.json'), 'utf8'));
        raw.renderer = { ...pinned, ...Object.fromEntries(missing.map((k) => [k, fp[k]])) };
        writeFileSync(join(F.dir, 'film.json'), JSON.stringify(raw, null, 2) + '\n');
        console.log(`  film.json renderer 补记 ${missing.join(', ')}`);
      }
    }
  };

  try {
    for (const { variant, format } of jobs) {
      const query = variant ? { variant: variant.id } : {};
      if (variant) console.log(`\n■ 变体 ${variant.id}  ${format}`);
      // 先开一个页面拿时长，它也作为 0 号 worker
      const first = await openScene(F, format, { browser: browsers[0], port, capture, scale, png, query });
      if (variant) {
        // 场景真的按这个变体合并了内容吗：没 import content.js 的场景会一声不吭地渲出基础版（"变体从没真渲过"）
        const got = await first.page.evaluate(() => globalThis.CONTENT?.id ?? null);
        if (got !== variant.id) { await first.close(); throw new Error(`场景没有按变体 ${variant.id} 加载内容（window.CONTENT.id = ${JSON.stringify(got)}）：scene 要在加载期 await loadContent()（runtime/content.js）`); }
      }
      // 第一个页面加载完 = 静态 import 的运行时都已经发出去了：此刻的加载清单进缓存键和输入指纹（开渲之前算）
      const rt = srv.loaded();
      const inputs = inputsFingerprint(F.dir, rt);
      const rtDigest = runtimeDigest(rt);
      const D = first.info.duration;
      const from = args.num('from', 0);
      const to = args.num('to', args.has('dur') ? from + args.num('dur', D) : D);
      if (!(from >= 0 && to > from)) fail(`时间区间不合法：--from ${from} --to ${to}（时长 ${D}s）`);
      if (to > D + 1e-9) process.stderr.write(`⚠ --to ${to} 超出 DURATION ${D}，超出部分照常 seek\n`);

      const ranged = from > 0 || Math.abs(to - D) > 1e-9;
      // --out：绝对路径原样用；相对路径解析到 films/<slug>/out/（不是 cwd —— 脚本可从任意 cwd 调用）。
      // 开头的 out/ 会被去掉，所以 --out partial.mp4 和 --out out/partial.mp4 都落在 films/<slug>/out/partial.mp4
      const outArg = args.flag('out', null);
      const outBase = variant ? variantDir(F, variant.id) : F.out;   // 变体产物进 out/variants/<id>/，不碰主片的 silent-*/final-*
      const outFile = outArg
        ? (isAbsolute(outArg) ? outArg : resolve(F.out, outArg.replace(/^(\.\/)?out[/\\]/, '')))
        : draft
          ? join(outBase, 'draft', `draft-${format}-${scale}x${ranged ? `-${from}-${to}` : ''}.mp4`)
          : join(outBase, ranged ? `silent-${format}-${variant ? `${secs(Math.round(from * fps) / fps)}-${secs(Math.round(to * fps) / fps)}` : `${from}-${to}`}.mp4` : `silent-${format}.mp4`);
      if (!outFile.endsWith('.mp4')) fail(`--out 必须是 .mp4 文件，收到 ${outArg}（解析为 ${outFile}）`);
      // 缩小版不许起成片的名字：mux.sh 认 silent-<format>.mp4，contact.sh 认 silent-*/final-*，会被当成定稿自动挑中
      if (draft && /^(silent|final)/.test(basename(outFile))) fail(`--scale ${scale} 是迭代产物，--out 不能叫 ${basename(outFile)}（silent-*/final-* 会被下游当成定稿挑中）`);
      try { mkdirSync(dirname(outFile), { recursive: true }); }
      catch (e) { fail(`无法创建输出目录 ${dirname(outFile)}：${e.message}`); }

      // 帧栅格是绝对的：第 K 帧在 K/fps（--from/--to 吸附到帧栅格）。分片边界在 N 的整数倍上，
      // 与 worker 数无关 —— 这样两次渲染（哪怕区间不同）的分片能对上，缓存才命中。
      const K0 = Math.round(from * fps), K1 = Math.round(to * fps);
      const frames = K1 - K0;
      const N = Math.max(1, Math.round(chunkSeconds * fps));
      const chunks = [];
      for (let a = K0; a < K1; a = (Math.floor(a / N) + 1) * N) chunks.push([a, Math.min(K1, (Math.floor(a / N) + 1) * N)]);
      const nWorkers = Math.min(workers, chunks.length);

      // 分片缓存：out/.render/cache/<format>/。键 = 编码参数 + 绝对帧区间；值 = 上次的逐帧哈希 + 分片 mp4。
      const cacheDir = join(F.out, '.render', 'cache', format);
      if (args.has('clean-cache')) rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      const indexFile = join(cacheDir, 'index.json');
      let index = {};
      try { if (existsSync(indexFile)) index = JSON.parse(readFileSync(indexFile, 'utf8')); } catch { index = {}; }
      // 自适应子帧：场景定义了 MOTION 且开了运动模糊（sub>1）。没定义的片子 adaptive=false，下面所有分支都回到原路径
      const scene = await first.page.evaluate(() => ({
        motion: typeof window.MOTION === 'function',
        cuts: Array.isArray(window.CUTS) ? window.CUTS.filter((x) => Number.isFinite(x)).sort((p, q) => p - q) : [],
      }));
      const adaptive = scene.motion && sub > 1 && !args.has('no-adaptive');
      const cuts = adaptive ? scene.cuts : [];
      const adapt = adaptive ? { motionPx, subMin, subMax, cuts } : null;
      // scale 进缓存键（只在 ≠1 时加字段，全分辨率的旧缓存键不变）：否则缩小版分片会被全分辨率渲染复用，拼出分辨率混搭的成片
      // adapt 同理：只在自适应时加字段，没定义 MOTION 的片子缓存键与改动前相同
      // png 同理：只在 fast 时加字段。default 的旧缓存键不变；fast 的分片另起一组键，旧 default 分片不会被 fast 复用（反之亦然）
      // runtime：挂载的运行时内容（名字 + sha256）。改一个字节就换一组键，旧分片不再复用
      const pkey = createHash('md5').update(JSON.stringify({ format, fps, sub, shutter, crf, preset, ffmpeg: FFMPEG, x264Threads, runtime: rtDigest, ...(draft ? { scale } : {}), ...(adapt ? { adapt } : {}), ...pngKey })).digest('hex').slice(0, 10);
      const useCache = !args.has('no-cache');

      const pages = [first];
      for (let w = 1; w < nWorkers; w++) pages.push(await openScene(F, format, { browser: browsers[w % nBrowsers], port, capture, scale, png, query }));
      if (first.info.usesWaapi) console.log('  场景声明 USES_WAAPI：每帧冻结 playbackRate=0');
      if (draft) console.log(`  ⚠ 迭代产物：--scale ${scale} → ${first.outWidth}×${first.outHeight}（定稿 ${first.width}×${first.height}），不是定稿，输出进 out/draft/`);
      if (scene.motion && !adaptive) console.log(`  场景定义了 MOTION，但${sub > 1 ? '传了 --no-adaptive' : ' sub=1（运动模糊关）'}：按固定 sub=${sub} 渲`);
      console.log(adaptive
        ? `▶ ${format} ${first.outWidth}×${first.outHeight}  ${K0 / fps}–${K1 / fps}s  ${fps}fps 自适应子帧（MOTION，≈${motionPx}px/张，${subMin}–${subMax} 张，静止帧 1 张）shutter=${shutter}`
          + `${cuts.length ? `  硬切 ${cuts.length} 处` : ''}   ${nWorkers} worker / ${nBrowsers} 浏览器 / ${chunks.length} 分片 / 截图 ${capture}${png === 'fast' ? '（PNG 快速编码）' : ''}`
        : `▶ ${format} ${first.outWidth}×${first.outHeight}  ${K0 / fps}–${K1 / fps}s  ${fps}fps ×${sub} 子帧 shutter=${shutter}`
          + `  = ${frames * sub} 次截图   ${nWorkers} worker / ${nBrowsers} 浏览器 / ${chunks.length} 分片 / 截图 ${capture}${png === 'fast' ? '（PNG 快速编码）' : ''}`);

      const hashes = new Array(frames);
      let next = 0, doneFrames = 0, aborted = null, nEncoded = 0, nReused = 0;
      const live = new Set();
      const t0 = Date.now(); // 只用于打印耗时 —— 禁令针对场景，不针对 Agent 工具
      // 怎么截一帧、帧哈希怎么算：lib/frames.mjs（seamcheck 门 5 对账用同一份）
      const pool = adaptive ? mixPool(Math.min(nWorkers, Math.max(1, cpus().length - 1))) : null;
      const st = { shots: 0, still: 0, maxN: 0, lied: [] };
      const shoot = frameShooter({ fps, sub, shutter, adapt, stats: st });
      const put = adaptive
        ? async (enc, f) => enc.write(pool.mix(f.pngs))
        : async (enc, f) => { for (const png of f.pngs) await enc.write(png); };
      // 有 content.json 的片子：同一分片可以有多份内容并存（主份 + 备份），变体之间按像素复用。没有的片子 share=false，
      // 候选只有主份一个，下面的逻辑与改动前逐行等价（主份被新内容覆盖、不留备份）
      const share = !!doc;
      const ALT_MAX = 6;
      const chosen = new Array(chunks.length);   // 每片最终拼进成片的文件
      const worker = async (S) => {
        while (!aborted && next < chunks.length) {
          const ci = next++;
          const [a, b] = chunks[ci];
          const key = `${pkey}:${a}-${b}`;
          const file = join(cacheDir, `${pkey}-${a}-${b}.mp4`);
          const entry = useCache ? index[key] : null;
          let cands = [];
          if (entry && existsSync(file)) cands.push({ hashes: entry.hashes, file });
          if (share && entry?.alts) for (const x of entry.alts) if (existsSync(join(cacheDir, x.file))) cands.push({ hashes: x.hashes, file: join(cacheDir, x.file) });
          let enc = null;
          // 开始编码：先把 [a, upto) 重新截一遍喂进去。seek 是纯函数，所以重截 = 原帧；顺手核对哈希，不一致说明场景非确定。
          const startEncoding = async (upto) => {
            enc = encoder({ outFile: file + '.tmp.mp4', fps, sub, crf, preset, threads: x264Threads, raw: adaptive });
            live.add(enc);
            for (let K = a; K < upto && !aborted; K++) {
              const f = await shoot(S, K);
              if (f.hash !== hashes[K - K0]) throw new Error(`t=${(K / fps).toFixed(3)}s 重截的帧与刚才不同 —— 场景非确定，先跑 seamcheck`);
              await put(enc, f);
            }
          };
          if (!cands.length) await startEncoding(a);
          for (let K = a; K < b && !aborted; K++) {
            const f = await shoot(S, K);
            hashes[K - K0] = f.hash;
            if (!enc) {
              cands = cands.filter((c) => c.hashes[K - a] === f.hash);
              if (!cands.length) await startEncoding(K);   // 没有一份候选还对得上：从片头重截
            }
            if (enc) await put(enc, f);
            if (++doneFrames % fps === 0) process.stdout.write(`\r  ${doneFrames}/${frames} 帧`);
          }
          if (enc) {
            await enc.end();
            live.delete(enc);
            const mine = hashes.slice(a - K0, b - K0);
            const old = index[key];
            if (share && old && existsSync(file) && old.hashes.join() !== mine.join()) {
              // 旧主份降为备份（别的变体回来还能复用），新内容做主份；备份按最近使用排，超过上限删最旧的
              const tag = createHash('md5').update(old.hashes.join()).digest('hex').slice(0, 10);
              const altName = `${pkey}-${a}-${b}~${tag}.mp4`;
              renameSync(file, join(cacheDir, altName));
              const alts = [{ hashes: old.hashes, file: altName }, ...(old.alts ?? []).filter((x) => x.file !== altName && x.hashes.join() !== mine.join())];
              for (const x of alts.slice(ALT_MAX)) rmSync(join(cacheDir, x.file), { force: true });
              renameSync(file + '.tmp.mp4', file);
              index[key] = { hashes: mine, alts: alts.slice(0, ALT_MAX) };
            } else {
              renameSync(file + '.tmp.mp4', file);
              index[key] = share && old?.alts ? { hashes: mine, alts: old.alts.filter((x) => x.hashes.join() !== mine.join()) } : { hashes: mine };
            }
            chosen[ci] = file;
            nEncoded++;
          } else { chosen[ci] = cands[0].file; nReused++; }
        }
      };
      try {
        await Promise.all(pages.map((S) => worker(S).catch((e) => { aborted ??= e; throw e; })));
      } catch (e) {
        for (const enc of live) enc.kill();
        // 报第一个错，并带上各页面收集到的页面错误：场景抛错时别的 worker 的 ffmpeg 被我们杀掉（退出码 null），
        // 那条是后果不是原因；页面错误才是原因，哪怕它是在别的页面上、晚一步才报出来的
        const first = aborted ?? e;
        const msg = String(first?.message ?? first);
        const pageErrs = [...new Set(pages.flatMap((S) => S.errors))].filter((x) => !msg.includes(x));
        throw pageErrs.length ? new Error(`${msg}\n  页面错误：\n  ${pageErrs.join('\n  ')}`) : first;
      } finally {
        await Promise.all(pages.map((S) => S.close()));
        await pool?.close();
      }
      writeFileSync(indexFile, JSON.stringify(index) + '\n');
      const tCap = (Date.now() - t0) / 1000;

      // 拼接：每片都是独立编码（首帧 IDR）且编码参数相同（pkey 保证），concat -c copy 不重编码
      const list = join(cacheDir, `list-${process.pid}.txt`);
      writeFileSync(list, chosen.map((f) => `file '${basename(f)}'`).join('\n') + '\n');
      const cat = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-c', 'copy', '-movflags', '+faststart', outFile], { encoding: 'utf8' });
      rmSync(list, { force: true });
      if (cat.status !== 0) fail(`拼接分片失败（${cacheDir}）：\n${cat.stderr}`);

      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames,width,height,r_frame_rate', '-of', 'csv=p=0', outFile], { encoding: 'utf8' });
      const got = probe.stdout.trim();
      const [gw, gh] = got.split(',').map(Number);
      const n = Number(got.split(',').pop());
      if (probe.status !== 0 || n !== frames) fail(`帧数不对：期望 ${frames}，ffprobe 读到 ${n}（${got || probe.stderr}）`);
      if (gw !== first.outWidth || gh !== first.outHeight) fail(`分辨率不对：期望 ${first.outWidth}×${first.outHeight}，ffprobe 读到 ${gw}×${gh}（分片缓存混进了别的尺寸？用 --clean-cache 重渲）`);

      // 逐帧哈希清单 + 与上一次同设置渲染的对比
      // 缩小版单独一份清单：不然迭代渲染会覆盖全分辨率的基线，下一次定稿渲染就没有"和上次比"可看了
      const manifestFile = join(F.out, '.render', ...(variant ? ['variants', variant.id] : []), draft ? `${format}@${scale}x.frames.json` : `${format}.frames.json`);
      mkdirSync(dirname(manifestFile), { recursive: true });
      const key = { entry: C.entry, fps, sub, shutter, from: K0 / fps, frames, ...(adapt ? { adapt } : {}), ...pngKey };
      if (existsSync(manifestFile)) {
        try {
          const prev = JSON.parse(readFileSync(manifestFile, 'utf8'));
          if (JSON.stringify(prev.key) === JSON.stringify(key)) {
            const changed = hashes.map((h, i) => (h !== prev.hashes[i] ? i : -1)).filter((i) => i >= 0);
            console.log(`\n  与上次渲染相比：${changed.length ? `${changed.length} 帧像素变了 → ${ranges(changed, K0 / fps, fps).join(', ')}` : '所有帧像素不变'}`);
            // 哈希是截图 PNG 的字节，不是解码后的像素。同一个浏览器构建下两者等价；换了构建，PNG 编码器本身可能变
            // （实测 Chromium 143 → 151/156：解码后像素全同，PNG 字节全变），这时"变了"只说明字节变了。
            const prevChromium = prev.renderer?.chromium;
            const prevBackend = backendMismatch(prev.renderer, fp);
            if (changed.length && prevBackend) console.log(`  注意：${prevBackend}——上次和这次不是同一个 WebGL 实现，着色器/三维像素本来就会变`);
            if (changed.length && prevChromium && prevChromium !== fp.chromium) {
              console.log(`  注意：上次是 Chromium ${prevChromium} 截的，这次是 ${fp.chromium}。上面比的是截图 PNG 字节，`
                + `换浏览器构建后 PNG 编码会变，"变了"不等于像素变了。要判断像素，解码后比（例如两个 mp4 各跑 ffmpeg -f framemd5）。`);
            }
          } else if (JSON.stringify({ ...prev.key, png: undefined }) === JSON.stringify({ ...key, png: undefined })) {
            console.log(`\n  与上次渲染相比：上次用 ${prev.key.png ?? 'default'} PNG 截的，这次 ${png}，PNG 字节不可比，这次不报改动范围（下次同模式再渲就有）`);
          }
        } catch {}
      }
      const runtime = srv.loaded().map(({ name, from, sha256 }) => ({ name, from, sha256 }));
      writeFileSync(manifestFile, JSON.stringify({ key, renderer: fp, inputs, runtime, hashes }) + '\n');

      if (adaptive) {
        console.log(`\n  自适应子帧：${frames} 帧共 ${st.shots} 次截图（固定 sub=${sub} 要 ${frames * sub} 次），静止帧 ${st.still}，单帧最多 ${st.maxN || 1} 张`);
        if (st.lied.length) process.stderr.write(`⚠ MOTION 返回 0 但快门两端画面不同（t=${st.lied.map((x) => x.toFixed(3)).join(', ')}${st.lied.length >= 5 ? ' …' : ''}）：这些帧退回 ${subMin} 张子帧。MOTION 低估了位移，检查它\n`);
      }
      console.log(`\r${draft ? `✓ [迭代 ${scale}x]` : '✓'} ${outFile}   ${frames} 帧   ${tCap.toFixed(1)}s   分片：编码 ${nEncoded} / 复用 ${nReused}   ffprobe: ${got}`);

      // 变体：配音轨（取主片成片的音轨 remux）+ 记进 out/variants/manifest.json。迭代小样（--scale）不记
      if (variant && !draft) {
        const finalFile = join(dirname(outFile), basename(outFile).replace(/^silent-/, 'final-'));
        const mx = finalFile !== outFile ? muxVariant(F, format, outFile, finalFile, ranged ? { from: K0 / fps, to: K1 / fps } : {}) : { ok: false, why: '--out 不叫 silent-*，不合流' };
        if (mx.ok) console.log(`  ✓ ${finalFile}   音轨取自 ${mx.from}`);
        else console.log(`  – 没合流：${mx.why}`);
        const ri = receiptInputs(F.dir);
        const rel = (p) => relative(F.dir, p).split('\\').join('/');
        const mkey = `${variant.id}/${format}${ranged ? `@${secs(K0 / fps)}-${secs(K1 / fps)}` : ''}`;
        const mf = writeVariantManifest(F, mkey, {
          variant: variant.id, picks: variant.picks, format, range: ranged ? { from: +(K0 / fps).toFixed(3), to: +(K1 / fps).toFixed(3) } : null,
          contentHash: contentHash(doc, variant.id, format),
          sources: { content: fileSha256(join(F.dir, CONTENT_FILE)), template: templateDigest(ri.files), inputs: ri.digest, runtime, runtimeDigest: rtDigest },
          settings: { fps, sub, shutter, crf, preset, png, capture, x264Threads, ...(adapt ? { adapt } : {}) },
          renderer: fp,
          width: first.outWidth, height: first.outHeight, frames, duration: frames / fps,
          framesDigest: createHash('md5').update(hashes.join()).digest('hex'),
          silent: { path: rel(outFile), sha256: fileSha256(outFile) },
          final: mx.ok ? { path: rel(finalFile), sha256: fileSha256(finalFile), audioFrom: mx.from } : null,
          ...(mx.ok ? {} : { finalWhy: mx.why }),
          at: new Date().toISOString(),   // 工具侧时间戳，不进任何哈希
        });
        console.log(`  清单 ${relative(F.dir, mf)} ← ${mkey}`);
      }
    }
    recordRenderer();
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    closeServer();
  }
});
