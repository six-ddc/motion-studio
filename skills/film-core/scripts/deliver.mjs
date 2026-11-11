#!/usr/bin/env node
// 交付：定稿渲染 → 全部的门 → 冻结运行时 → 写收据。一支片子"做完了"的唯一定义是它有一份和当前输入对得上的 receipt.json。
//
//   node <film-core>/scripts/deliver.mjs --film <slug>
//   node <film-core>/scripts/deliver.mjs --film <slug> --list          只打印会跑什么，不执行
//
// 步骤（任何一步红就停，不冻结、不写收据）：
//   1. 定稿渲染：render.mjs 按 film.json 的设置（fps/sub/shutter，formats 有几个渲几个）。分片缓存照用——缓存键含运行时哈希。
//   1b. 重新合流：片子合流过（有 out/.render/final-<format>.mux.json），而成片因为这次渲染（或旁白/音效改了）过期，
//      就按记录里的参数经 capability(记录的 skill) 重放合流脚本（film-narration 的 mux.sh）。没装那个 skill → 不合流、记「–」，
//      旧成片照样过期，读成片的门因此红（lib/gates.mjs finalState）。从没合流过的片子只交付无声成片，不替作者选混音参数。
//   2. 内核门全开：seamcheck --parallel 4（门 4）--relaunch 2（门 5，和第 1 步的渲染清单对账）+ 1a/1b/2/3 + 探针。
//   3. fontsrc 等其余内核门。
//   4. uses 门：gates.json 里 uses 列的运行时，这次渲染真的加载了就跑（physcheck、texcache…）。
//   5. checks 门：film.json checks 声明的每个 id 交给认领它的 skill 的门；没人认领 = 缺能力，红。
//   6. 冻结：渲染清单里记的、从套件挂载来的运行时（以及 film.json kits 声明的 kit 文件 → runtime/kits/<kit>/），逐个核对 sha256 后拷进 films/<slug>/runtime/。
//      之后这支片子不再依赖套件的运行时：套件升级不会改它的像素，也不会修它的 bug（要修就改了再 deliver 一次）。
//   7. 写 films/<slug>/receipt.json：输入文件哈希、运行时哈希与来源、通过的门、环境指纹、时间。accept 只认它。
//
// 平台档位（只转码：不渲染、不过门、不写收据；拿现有的成片转，先 deliver 一次）：
//   --phone                产出 out/phone-<format>.mp4：720p、≤ --max-mb（默认 30）MB。码率按时长反算、两遍编码，编完复核文件大小，
//                          超了按比例降码率重编（最多两次），仍超就红。历史坑：手机上传上限 30MB，原片 1080p 四十几 MB 传不上去。
//   --compare <旧.mp4>     产出 out/compare-<format>.mp4：旧版在左/上、新版在右/下（横版默认上下、竖版和方版默认左右，--layout 改），
//                          **只带新版音轨**——手机只放默认音轨，两条都带时放出来的多半是旧版的声音。和 --phone 一起给 = 对比片也压进手机档。
//   源：新鲜的成片 out/final-<format>.mp4；没有或过期就用无声成片 out/silent-<format>.mp4 并明说。
//
// 退出码：0 交付成功；1 某一步红（或缺能力）；2 用法错误 / film.json checks 写错
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveFilm, parseArgs, main, fail, FILM_OPTS, parseChecks } from '../lib/film.mjs';
import { loadGates, planGates, runGate, timeoutOf, manifestOf, finalState } from '../lib/gates.mjs';
import { hasCapability, capability, findVenvBin } from '../lib/env.mjs';
import { readRuntimeRecord } from '../lib/serve.mjs';
import { planFreeze, applyFreeze } from '../lib/freeze.mjs';
import { kitsReceipt } from '../lib/kits.mjs';
import { receiptInputs, writeReceipt, envFingerprint, portableCmd, receiptState } from '../lib/receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs({
  usage: 'node deliver.mjs --film <slug> [选项]',
  about: '交付：定稿渲染 → 门 4/5 全开 → 内核门 → uses 门 → film.json checks 声明的门 → 冻结运行时进 runtime/ → 写 receipt.json。退出码 0 交付成功 / 1 有门红 / 2 用法错',
  opts: {
    ...FILM_OPTS,
    list: '只打印会跑的步骤和命令，不执行',
    'relaunch-every': ['<N>', '门 5 每 N 帧取一帧（长片控成本，仍和渲染清单对账）'],
    'gate-timeout': ['<分钟>', '每道门的墙钟上限（默认 30，逐帧扫全片的门按帧数放宽）'],
    phone: '平台档位：只转码出 ≤30MB 的 720p 手机预览 out/phone-<format>.mp4（不渲染、不过门、不写收据）',
    compare: ['<旧.mp4>', '平台档位：旧版/新版对比片 out/compare-<format>.mp4，只带新版音轨（可与 --phone 同用）'],
    layout: ['<side|stack>', '--compare 的排法：side 左右 / stack 上下（默认横版上下、其余左右）'],
    'max-mb': ['<MB>', '--phone 的体积上限（默认 30，按 1MB = 10^6 字节算，偏保守）'],
    format: ['<9x16|1x1|16x9>', '平台档位用哪个画幅的成片（默认 film.json format）'],
  },
});

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

await main(async () => {
  const F = resolveFilm(args.film, args);
  const films = F.films;
  try { parseChecks(F.raw.checks); } catch (e) { fail(`${F.slug}/film.json：${e.message}`, 2); }
  const registry = loadGates();
  if (registry.errors.length) fail(`gates.json 有错，先修：\n  ${registry.errors.join('\n  ')}`);
  const every = args.flag('relaunch-every', null);
  const gtmo = args.flag('gate-timeout', null) != null ? args.num('gate-timeout', 30) : null;
  const node = process.execPath;
  const base = ['--film', F.slug, '--films-dir', films];
  const renderCmd = [node, [join(HERE, 'render.mjs'), ...base, ...(F.formats.length > 1 ? ['--all'] : [])]];
  const seamCmd = [node, [join(HERE, 'seamcheck.mjs'), ...base, '--parallel', '4', '--relaunch', '2', ...(every ? ['--every', every] : [])]];
  const show = ([b, a]) => `${b === node ? 'node' : b} ${a.join(' ')}`;
  // 硬件 GPU 后端（film.json backend）：代价在交付输出里看得见（references/render.md「渲染后端」）
  const backendNote = F.config.backend === 'gpu'
    ? '⚠ 本片声明 "backend": "gpu"：WebGL 跑在本机硬件 GPU 上。像素与软件后端不同，换显卡 / 驱动 / 系统就可能不同；'
      + '没有硬件 GPU 的机器（Linux CI、无 GPU 的容器）渲不了这支片子；收据只在同款显卡、同驱动上可复现（accept 只对账输入哈希，不重渲）\n'
    : '';

  if (args.has('phone') || args.has('compare')) { platform(F); return; }

  if (backendNote) process.stdout.write(backendNote);
  if (args.has('list')) {
    console.log(`交付 ${F.slug} 会依次跑：`);
    console.log(`  1 渲染     ${show(renderCmd)}`);
    for (const fmt of F.formats) {
      const st = finalState(F.dir, fmt);
      if (st.record) console.log(`  1b 合流 ${fmt}  按 out/.render/final-${fmt}.mux.json 重放 ${st.record.skill} ${st.record.script}（渲染后成片过期才跑）${hasCapability(st.record.skill) ? '' : `——缺能力 ${st.record.skill}，不会跑`}`);
      else if (st.state === 'stale') console.log(`  ✗ 合流 ${fmt}  ${st.why}`);
    }
    console.log(`  2 门 1–5   ${show(seamCmd)}`);
    for (const p of planGates(F.dir, { mode: 'deliver', filmsDir: films, slug: F.slug, registry })) {
      const tag = { run: '跑', na: '–', missing: '✗', pending: '…' }[p.state];
      console.log(`  ${tag} ${p.id.padEnd(10)} ${p.state === 'run' ? show(p.cmd) : p.why}${p.state === 'run' && p.why ? `   （${p.why}）` : ''}`);
    }
    console.log('  …uses 门按第 1 步渲染实际加载的运行时重新判定；全过后冻结运行时、写 receipt.json');
    return;
  }

  const results = [];
  const step = (id, kind, cmd, timeoutMs) => {
    process.stdout.write(`▶ ${id}  ${show(cmd)}\n`);
    const r = id === 'render' || id === 'seam'
      ? (() => { const t0 = Date.now(); const x = spawnSync(cmd[0], cmd[1], { stdio: 'inherit', timeout: timeoutMs }); return { ok: x.status === 0, code: x.status, ms: Date.now() - t0, tail: `退出码 ${x.status}` }; })()
      : runGate(cmd, { cwd: process.cwd(), timeoutMs });
    if (id !== 'render' && id !== 'seam' && !r.ok) process.stdout.write(r.out.split('\n').slice(-25).join('\n') + '\n');
    results.push({ id, kind, result: r.ok ? 'pass' : 'fail', ms: r.ms, cmd: portableCmd(cmd, dirname(films)), ...(r.ok ? {} : { why: r.timedOut ? '超时被杀' : r.tail }) });
    console.log(`${r.ok ? '✓' : '✗'} ${id}${r.ok ? '' : `：${r.timedOut ? '超时被杀（--gate-timeout 放宽）' : r.tail}`}\n`);
    return r.ok;
  };
  const stop = () => {
    console.log('\n交付未完成（没有冻结、没有写收据）：');
    for (const x of results) console.log(`  ${x.result === 'pass' ? '✓' : x.result === 'na' ? '–' : '✗'} ${x.id}${x.why ? `  ${x.why}` : ''}`);
    process.exit(1);
  };

  // 1. 定稿渲染
  if (!step('render', 'render', renderCmd, 6 * 3600_000)) stop();
  const m = manifestOf(F.dir);
  if (!m || m.key?.from !== 0) fail('渲染之后找不到整片渲染清单 out/.render/<format>.frames.json（render 出错了？）');
  if (!Array.isArray(m.runtime)) fail('渲染清单里没有 runtime 字段：清单不是这一版 render.mjs 写的');

  // 1b. 重新合流（定稿渲染让成片过期时）
  for (const fmt of F.formats) {
    const st = finalState(F.dir, fmt);
    if (st.state !== 'stale') continue;                         // 没成片（无声交付）或成片仍是现在这些输入合的
    const rec = st.record;
    if (!rec) { console.log(`⚠ ${st.why}\n  读成片的门会因此红；用 film-narration 的 mux.sh 合流一次（会写合流记录），之后 deliver 自动重合流\n`); continue; }
    if (!hasCapability(rec.skill)) {
      results.push({ id: `mux-${fmt}`, kind: 'render', result: 'na', why: `缺能力 ${rec.skill}：没重新合流，out/final-${fmt}.mp4 过期，读成片的门会红` });
      console.log(`– mux-${fmt}：缺能力 ${rec.skill}，没重新合流（只交付无声成片；声明了读成片的检查会红）\n`);
      continue;
    }
    const script = capability(rec.skill).path(rec.script);
    const cmd = [script.endsWith('.sh') ? 'bash' : script.endsWith('.py') ? (findVenvBin('python', { filmsDir: films }) ?? 'python3') : node, [script, ...base, ...(rec.args ?? [])]];
    if (!step(`mux-${fmt}`, 'render', cmd, 30 * 60_000)) stop();
    const after = finalState(F.dir, fmt);
    if (after.state !== 'fresh') fail(`重新合流之后成片仍不新鲜：${after.why}`);
  }

  // 2. 门 1–5 全开
  if (!step('seam', 'kernel', seamCmd, timeoutOf({ timeoutPerFrame: 2000 }, F.dir, gtmo))) stop();

  // 3–5. 其余内核门、uses 门（按这次渲染实际加载的运行时）、checks 门
  const loaded = new Set(m.runtime.map((r) => r.name));
  for (const n of Object.keys(readRuntimeRecord(F.dir)?.files ?? {})) loaded.add(n);
  const plan = planGates(F.dir, { mode: 'deliver', filmsDir: films, slug: F.slug, loaded, registry });
  let bad = false;
  for (const p of plan) {
    if (p.state === 'na') { results.push({ id: p.id, kind: p.kind, result: 'na', why: p.why }); continue; }
    if (p.state !== 'run') { results.push({ id: p.id, kind: p.kind, result: 'fail', why: p.why }); console.log(`✗ ${p.id}：${p.why}\n`); bad = true; continue; }
    if (!step(p.id, p.kind, p.cmd, timeoutOf(p.gate, F.dir, gtmo))) bad = true;
  }
  if (bad) stop();

  // 6. 冻结：套件挂载来的运行时、kit 文件拷进片子（lib/freeze.mjs）。先核对 sha：交付途中源头的文件变了，就不知道冻的是哪一份
  mkdirSync(join(F.dir, 'runtime'), { recursive: true });
  let frozen;
  try { frozen = applyFreeze(planFreeze(F.dir, m.runtime)); } catch (e) { fail(`${e.message}。重跑 deliver`); }
  console.log(frozen.length ? `冻结进 runtime/：\n  ${frozen.join('\n  ')}` : '冻结：渲染用到的运行时都已在片内 runtime/');

  // 7. 收据
  const outputs = {};
  for (const fmt of F.formats) {
    const p = join(F.dir, 'out', `silent-${fmt}.mp4`);
    if (existsSync(p)) outputs[`out/silent-${fmt}.mp4`] = sha256(p);
    const fin = finalState(F.dir, fmt);
    if (fin.state === 'fresh') outputs[`out/final-${fmt}.mp4`] = fin.record.output.sha256;   // 过期的成片不记：它不是这次交付的产物
  }
  const kitsOut = kitsReceipt(F.dir, m.runtime, F.raw);
  const receipt = {
    schema: 1,
    slug: F.slug,
    deliveredAt: new Date().toISOString(),
    via: 'deliver',
    inputs: receiptInputs(F.dir),
    runtime: Object.fromEntries(m.runtime.map((r) => [r.name, { from: r.from, sha256: r.sha256 }])),
    ...(kitsOut ? { kits: kitsOut } : {}),       // 只有声明了 kits 的片子才有这个键（references/kits.md）
    render: { format: F.config.format, formats: F.formats, fps: m.key.fps, sub: m.key.sub, shutter: m.key.shutter, frames: m.key.frames,
      manifest: `out/.render/${F.config.format}.frames.json`, outputs },
    gates: results.map(({ id, kind, result, ms, cmd, why }) => ({ id, kind, result, ...(ms != null ? { ms } : {}), ...(cmd ? { cmd } : {}), ...(why ? { why } : {}) })),
    checks: F.raw.checks ?? [],
    // 硬件后端多记 backend / gpu / gpuDriver（软件后端的收据形状与改动前相同）：收据只在同款显卡、同驱动上可对账
    env: envFingerprint(m.renderer ? { chromium: m.renderer.chromium, playwright: m.renderer.playwright, args: m.renderer.args, x264Threads: m.renderer.x264Threads,
      ...(m.renderer.backend ? { backend: m.renderer.backend, gpu: m.renderer.gpu, gpuDriver: m.renderer.gpuDriver } : {}) } : null),
  };
  writeReceipt(F.dir, receipt);
  const ran = results.filter((x) => x.result === 'pass').map((x) => x.id);
  console.log(`\n✓ 交付 ${F.slug}：通过 ${ran.join(' ')}；收据 ${join(F.dir, 'receipt.json')}（输入 ${Object.keys(receipt.inputs.files).length} 个文件）`);
});

// ═════════════════════════ 平台档位 ═════════════════════════
function probe(p) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', p], { encoding: 'utf8' });
  if (r.status !== 0) fail(`ffprobe 读不了 ${p}：${(r.stderr || '').trim().split('\n').pop()}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((x) => x.codec_type === 'video');
  if (!v) fail(`${p} 没有视频轨`);
  const [a, b] = String(v.r_frame_rate).split('/').map(Number);
  return { duration: Number(j.format.duration), width: v.width, height: v.height, fps: b ? a / b : a, audio: j.streams.some((x) => x.codec_type === 'audio') };
}
function even(x) { return Math.max(2, Math.round(x / 2) * 2); }   // 函数声明：main 在文件顶部就 await，const 还没初始化
/** 720p 档：短边 720，长边按比例（取偶数） */
function phoneSize(w, h) { return w >= h ? { w: even((w * 720) / h), h: 720 } : { w: 720, h: even((h * 720) / w) }; }

function platform(F) {
  const fmt = args.flag('format', null) ?? F.config.format;
  if (!F.formats.includes(fmt) && fmt !== F.config.format) fail(`这支片子没有画幅 ${fmt}（film.json formats：${F.formats.join(' ')}）`, 2);
  const out = join(F.dir, 'out');
  const fin = finalState(F.dir, fmt);
  let src = fin.state === 'fresh' ? fin.path : join(out, `silent-${fmt}.mp4`);
  if (!existsSync(src)) fail(`没有可转的成片：${fin.why ?? ''}${fin.why ? '；' : ''}也没有 out/silent-${fmt}.mp4。先 deliver（或 render）一次`);
  if (fin.state !== 'fresh') console.log(`⚠ ${fin.why}——改用无声成片 out/silent-${fmt}.mp4，出来的档位没有声音`);
  const rs = receiptState(F.dir);
  if (rs.state !== 'ok') console.log(`⚠ 收据状态「${rs.state}」${rs.why ? `：${rs.why}` : ''}——这份档位不是"交付过的那一版"，只能当预览`);
  const threads = F.raw.renderer?.x264Threads ?? 4;    // x264 线程数会改输出字节（pitfalls.md），跟渲染钉同一个数
  const phone = args.has('phone');
  const maxMB = args.num('max-mb', 30);
  if (!(maxMB > 1)) fail(`--max-mb 要大于 1，收到 ${maxMB}`, 2);
  const N = probe(src);
  const passlog = join(out, '.render', `platform-${fmt}`);
  mkdirSync(dirname(passlog), { recursive: true });

  let inputs, filter, dest, w, h;
  if (args.has('compare')) {
    const old = resolve(args.flag('compare'));
    if (!existsSync(old)) fail(`--compare 的旧片不存在：${old}`, 2);
    const O = probe(old);
    const layout = args.flag('layout', null) ?? (N.width > N.height ? 'stack' : 'side');
    if (!['side', 'stack'].includes(layout)) fail(`--layout 只能是 side / stack，收到 ${layout}`, 2);
    const pane = phone ? phoneSize(N.width, N.height) : { w: even(N.width), h: even(N.height) };
    const fit = `scale=${pane.w}:${pane.h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${pane.w}:${pane.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${N.fps}`;
    // 输入 0 = 旧、1 = 新；短的那条在结尾定格（framesync 默认 repeat），总长以新版为准
    filter = `[0:v]${fit}[a];[1:v]${fit}[b];[a][b]${layout === 'side' ? 'hstack' : 'vstack'}=inputs=2[v]`;
    inputs = ['-i', old, '-i', src];
    w = layout === 'side' ? pane.w * 2 : pane.w; h = layout === 'side' ? pane.h : pane.h * 2;
    dest = join(out, `compare-${fmt}${phone ? '-phone' : ''}.mp4`);
    console.log(`对比片：${layout === 'side' ? '左' : '上'} = 旧（${old}，${O.duration.toFixed(1)}s）· ${layout === 'side' ? '右' : '下'} = 新（${relative(F.dir, src)}，${N.duration.toFixed(1)}s）· 音轨只带新版${N.audio ? '' : '（新版本身无声）'}`);
    encode({ inputs, filter, audioMap: N.audio ? ['-map', '1:a:0'] : [], dur: N.duration, dest, w, h, phone, maxMB, threads, passlog });
  } else {
    const size = phoneSize(N.width, N.height);
    encode({ inputs: ['-i', src], filter: `[0:v]scale=${size.w}:${size.h}:flags=lanczos,setsar=1[v]`, audioMap: N.audio ? ['-map', '0:a:0'] : [],
      dur: N.duration, dest: join(out, `phone-${fmt}.mp4`), w: size.w, h: size.h, phone: true, maxMB, threads, passlog });
  }
}

function encode({ inputs, filter, audioMap, dur, dest, w, h, phone, maxMB, threads, passlog }) {
  const ff = (a) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { encoding: 'utf8' });
    if (r.status !== 0) fail(`ffmpeg 失败：${(r.stderr || '').trim().split('\n').slice(-3).join(' / ')}`);
  };
  const common = [...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-threads', String(threads), '-preset', 'medium', '-pix_fmt', 'yuv420p'];
  const tail = [...audioMap, ...(audioMap.length ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : []), '-t', dur.toFixed(3), '-movflags', '+faststart', dest];
  const mb = (b) => (b / 1e6).toFixed(1);
  if (!phone) {
    ff([...common, '-crf', '18', ...tail]);
    console.log(`✓ ${dest}  ${w}×${h}  ${mb(statSync(dest).size)} MB  ${dur.toFixed(1)}s`);
    return;
  }
  // 码率按时长反算：总预算 = 上限 × 0.92（留给容器和码率波动），减去音频；720p 再高也看不出来，封顶 8 Mbps
  const limit = maxMB * 1e6;
  const audioK = audioMap.length ? 128 : 0;
  let videoK = Math.min(8000, Math.floor((limit * 0.92 * 8) / dur / 1000 - audioK));
  if (videoK < 250) fail(`片长 ${dur.toFixed(1)}s 塞进 ${maxMB}MB 只剩 ${videoK} kbps 视频码率，720p 会糊成一片：加大 --max-mb 或剪短`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rate = ['-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.5)}k`, '-bufsize', `${videoK * 2}k`, '-passlogfile', passlog];
    ff([...common, ...rate, '-pass', '1', '-an', '-t', dur.toFixed(3), '-f', 'null', '/dev/null']);
    ff([...common, ...rate, '-pass', '2', ...tail]);
    const size = statSync(dest).size;
    if (size <= limit) {
      for (const ext of ['-0.log', '-0.log.mbtree']) rmSync(passlog + ext, { force: true });
      console.log(`✓ ${dest}  ${w}×${h}  ${mb(size)} MB ≤ ${maxMB} MB（复核过文件大小）  视频 ${videoK}k${audioK ? ` + 音频 ${audioK}k` : '，无音轨'}  ${dur.toFixed(1)}s`);
      return;
    }
    console.log(`⚠ 第 ${attempt} 次编出 ${mb(size)} MB > ${maxMB} MB，按比例降码率重编`);
    videoK = Math.floor(videoK * (limit * 0.9) / size);
  }
  fail(`三次都没压到 ${maxMB} MB 以内：${dest} 不能当手机档用`);
}
