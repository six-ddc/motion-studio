#!/usr/bin/env node
// cues.json -> out/sfx.wav。音效事件可以绑在旁白关键词上（四条保证的第 3 条同样适用于音效）。
//
// 用法（任意 cwd）: node sfx.mjs --film <slug> [--cues cues.json] [--out out/sfx.wav]
//
// films/<slug>/cues.json:
//   [{ "t": 1.25, "type": "pop", "gain": 0.8 },                 // 写死秒数：只用于和旁白无关的事件
//    { "at": "纯函数", "offset": -0.04, "type": "thump" },      // 绑关键词：重录旁白自动跟
//    { "at": "帧", "nth": 2, "file": "assets/sfx/shutter.wav" }, // 素材：ffmpeg 解码，任何格式
//    { "beat": 8, "type": "tick" }]                             // 绑节拍：读 out/beats.json 的 beats[8]
//   节拍来源：out/beats.json（beats.py 测的）优先；没有就读 out/music.json、再没有读片子根的 music.json（music.py 写的，字段同义，
//   是精确值不是估计）。grid：beats（默认）| downbeats | hits（起音/冲击点）| sections（music.json 的段落切点，第 n 段）
//
// 时间一律是**成片时间**：at 绑定的时刻 = 旁白时间 + film.json 的 narrationOffset（片头留白）；
// t 和 beat 本来就是成片时间。mux.sh 因此不再给音效加延迟。用的偏移记在 out/sfx.json，
// mux.sh 合流前核对——偏移改了没重跑 sfx.mjs 会直接报错，而不是让音效整体早/晚半秒。
//
// 合成音色（type）来自运行时 sfx.mjs，解析规则与场景的 /runtime/ 挂载表相同：片内 `runtime/sfx.mjs`（冻结副本，
// 或片子自己加了音色的那份）优先，没有就用套件的（film-narration/assets/runtime/sfx.mjs）。
//   片内加音色：拷一份到 films/<slug>/runtime/sfx.mjs，在 SOUNDS 里加 `名字: [时长秒, (t, rnd) => 样本]`，cues 里写 "type": "名字"；
//   场景 import './runtime/sfx.mjs' 做预听时听到的也是同一组音色。代价：那份从此不跟套件更新。
//
// ── 可选能力（都不写 = 单声道 renderCues / toWav）──────────────────────
// cues.json 可以是数组，也可以是对象 { cues: [...], 配置... }。配置键：
//   panWidth   anchor 声像的幅度：pan = panWidth·(2·cx − 1)，cx 是锚点中心的归一化横坐标。**没有默认值**，用 anchor 就必须写
//   room       { size: 0..1, damp: 0..1, width?: 0..1 } 共享房间（Freeverb）。任何 cue 的 send > 0 时必须写；没有默认房间
//   dedupe     秒。按时间排序后，离上一个保留的 cue 不到这么久的 cue 丢掉（同 stack 值的叠层不算撞车）。不写 = 不去重
//   curveRate  probe 曲线的采样率，默认 240 Hz（控制量的采样率，不是音色选择：线性插值后 4 ms 一步，听不出台阶）
//   fromScene  { map: { kind: cue模板 | null }, format? } 从场景 window.events() 读事件生成 cue；map 没写到的 kind 直接报错，
//              写 null = 明确不出声。套件不给默认映射
//   stereo     true = 即使没有用到新字段也出立体声
// cue 新字段（任一出现就走立体声路径 renderStereo；pan=0 时成片里与单声道一样响，见 runtime/sfx.mjs 文件中段）：
//   pan        -1..1，或参数式（见下）
//   anchor     "锚点名"：声像取场景 window.anchors(t).items[名].cx；"follow": true 时整个 cue 期间按 film.json fps 跟着走
//   send       共享房间送量，默认 0
//   rate       播放速率 = 音高倍数；lowpass 一阶低通 Hz；dur 连续层时长（循环音色/素材）；stack 去重时的叠层组名
// 参数式：gain / pan / send / rate / lowpass 都可以写成对象 —— 读场景曲线或事件强度，再映射
//   { "probe": "曲线名", "scale": 1, "add": 0, "pow": 1, "min": -Inf, "max": Inf }   y = clamp(add + scale·sign(x)|x|^pow)
//   { "v": true, ... }  同上，x 取事件的 v（只在 fromScene 模板里有意义）
// 需要场景（anchor / probe / fromScene）时用 film-core 的 openScene 开一次页面（Playwright）。
// --dump-events 只打印场景事件；--emit <path> 把场景事件生成的 cue 写成普通 cue 数组（定稿留痕/手改用）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { FILM_OPTS, parseArgs, resolveFilm, fail as die } from '../../film-core/lib/film.mjs';
import { importRuntime } from '../../film-core/lib/runtime-node.mjs';

const A = parseArgs({
  usage: 'node sfx.mjs --film <slug> [--cues cues.json] [--out out/sfx.wav] [--format 9x16] [--dump-events] [--emit <path>]',
  about: 'cues.json → out/sfx.wav（成片时间；at 绑旁白关键词时自动加 film.json narrationOffset）。cues 格式见文件头注释。',
  opts: {
    ...FILM_OPTS,
    cues: ['<file>', 'cue 表（相对片子目录，默认 cues.json）'], out: ['<file>', '输出 wav（相对片子目录，默认 out/sfx.wav）'],
    format: ['<9x16|1x1|16x9>', '需要开场景（anchor / probe / fromScene）时用的画幅'],
    'dump-events': '只打印场景 window.events() 的事件', emit: ['<path>', '把场景事件生成的 cue 写成普通 cue 数组'],
  },
});
const arg = (k) => A.flag(k, undefined);

let F;
try { F = resolveFilm(A.film, A); } catch (e) { die(e.message); }
const film = F.dir;
const { makeNarration } = await importRuntime('narration.js', { film });
// 音色运行时：片内优先，否则套件的（见文件头；与 serve 挂载表同语义）
const filmRuntime = join(film, 'runtime', 'sfx.mjs');
const own = existsSync(filmRuntime);
const sfxRuntimeLabel = own ? 'runtime/sfx.mjs（片内）' : 'sfx.mjs（套件 film-narration）';
let renderCues, toWav, RATE, SOUNDS, filmRt;
try {
  filmRt = await importRuntime('sfx.mjs', { film });
  ({ renderCues, toWav, RATE, SOUNDS } = filmRt);
} catch (e) { die(`加载音色运行时 ${sfxRuntimeLabel} 失败：${e.message}`); }
if (typeof renderCues !== 'function' || typeof toWav !== 'function' || !RATE || !SOUNDS)
  die(`${sfxRuntimeLabel} 缺少导出（要有 renderCues / toWav / RATE / SOUNDS）`);
const cuesPath = resolve(film, arg('cues') ?? 'cues.json');
if (!existsSync(cuesPath)) die(`缺少 ${cuesPath}`);
const rawFile = JSON.parse(readFileSync(cuesPath, 'utf8'));
const cfg = Array.isArray(rawFile) ? {} : rawFile;
const raw = Array.isArray(rawFile) ? rawFile : (rawFile.cues ?? []);
if (!Array.isArray(raw)) die(`${cuesPath}：要么是 cue 数组，要么是 { cues: [...], 配置 }`);
const narPath = join(film, 'narration.json');
const offset = F.raw.narrationOffset ?? 0;
const narData = existsSync(narPath) ? JSON.parse(readFileSync(narPath, 'utf8')) : null;
const vo = narData ? makeNarration(narData, { offset }) : null;   // offset 非法会抛错
const beatsPath = [join(film, 'out', 'beats.json'), join(film, 'out', 'music.json'), join(film, 'music.json')].find((p) => existsSync(p));
const beats = beatsPath ? JSON.parse(readFileSync(beatsPath, 'utf8')) : null;
const GRIDS = { beats: (b) => b.beats, downbeats: (b) => b.downbeats, hits: (b) => b.hits,
  sections: (b) => b.sections?.map((s) => s.t) };

// ---------- 场景（只在用到 anchor / probe / fromScene 时打开） ----------
const PARAMS = ['gain', 'pan', 'send', 'rate', 'lowpass'];
const NEW_KEYS = ['pan', 'anchor', 'send', 'rate', 'lowpass', 'dur', 'stack'];
const isSpec = (p) => p != null && typeof p === 'object' && !Array.isArray(p);
const usesProbe = (c) => PARAMS.some((k) => isSpec(c[k]) && c[k].probe != null);
const needScene = !!cfg.fromScene || raw.some((c) => c.anchor != null || usesProbe(c))
  || Object.values(cfg.fromScene?.map ?? {}).some((c) => c && (c.anchor != null || usesProbe(c)));
const wantDump = process.argv.includes('--dump-events');
let scene = null;
async function openFilmScene() {
  const { openScene } = await import('../../film-core/lib/browser.mjs');
  const fmt = cfg.fromScene?.format ?? arg('format') ?? F.config.format;
  const S = await openScene(F, fmt);
  return { S, fps: F.config.fps, fmt };
}
if (needScene || wantDump) {
  try { scene = await openFilmScene(); } catch (e) { die(`打开场景失败（anchor / probe / fromScene 都要读场景）：${e.message}`); }
}
const closeScene = async () => { if (scene) await scene.S.close(); scene = null; };
const sceneDie = async (m) => { await closeScene(); die(m); };

// ---------- 场景事件 -> cue ----------
let sceneEvents = [];
if (cfg.fromScene || wantDump) {
  const has = await scene.S.page.evaluate(() => typeof window.events === 'function');
  if (!has) await sceneDie('cues.json 写了 fromScene，但场景没有暴露 window.events()（返回 [{t, kind, anchor?, v?, pan?}]）');
  sceneEvents = await scene.S.page.evaluate(async () => await window.events());
  if (!Array.isArray(sceneEvents)) await sceneDie(`window.events() 要返回数组，收到 ${typeof sceneEvents}`);
  for (const [i, e] of sceneEvents.entries())
    if (!Number.isFinite(e?.t) || typeof e?.kind !== 'string') await sceneDie(`window.events()[${i}] 要有有限的 t 和字符串 kind：${JSON.stringify(e)}`);
  if (wantDump) {
    console.log(JSON.stringify(sceneEvents, null, 1));
    await closeScene(); process.exit(0);
  }
}
const eventCues = [];
if (cfg.fromScene) {
  const map = cfg.fromScene.map ?? {};
  const unknown = [...new Set(sceneEvents.map((e) => e.kind))].filter((k) => !Object.hasOwn(map, k));
  if (unknown.length) await sceneDie(`场景事件的 kind 没有映射：${unknown.join('、')}。在 cues.json fromScene.map 里给每个 kind 写一个 cue 模板，`
    + `不要声音就写 null（套件不给默认映射：哪种事件发什么声是片子的选择）`);
  for (const e of sceneEvents) {
    const tpl = map[e.kind];
    if (tpl == null) continue;
    const c = { ...tpl, t: e.t + (tpl.offset ?? 0), _event: e };
    delete c.offset;
    if (c.pan == null && c.anchor == null) { if (e.pan != null) c.pan = e.pan; else if (e.anchor != null) c.anchor = e.anchor; }
    eventCues.push(c);
  }
}

// ---------- 时刻 ----------
const timed = raw.map((c, i) => {
  let t = c.t;
  if (c.at != null) {
    if (!vo) die(`cue #${i} 绑了关键词「${c.at}」但没有 narration.json（音频先行：先跑 tts.py）`);
    t = vo.at(c.at, c.nth ?? 1);          // 查不到会抛错，不会静默变 0
  } else if (c.beat != null) {
    if (!beats) die(`cue #${i} 绑了节拍但没有 out/beats.json / out/music.json（先跑 beats.py 测曲子，或 music.py 合成）`);
    const grid = c.grid ?? 'beats';
    if (!GRIDS[grid]) die(`cue #${i}: grid 只认 ${Object.keys(GRIDS).join(' / ')}，收到 ${grid}`);
    const arr = GRIDS[grid](beats);
    if (!arr) die(`cue #${i}: ${beatsPath} 里没有 ${grid}（sections 只有 music.py 写的 music.json 才有）`);
    t = arr[c.beat];
    if (t == null) die(`cue #${i}: ${beatsPath} 的 ${grid} 里没有第 ${c.beat} 项（共 ${arr.length} 项）`);
  }
  if (typeof t !== 'number') die(`cue #${i} 需要 t / at / beat 之一`);
  t += c.offset ?? 0;
  return { ...c, t };
}).concat(eventCues);

const stereo = !!cfg.stereo || eventCues.length > 0 || timed.some((c) => NEW_KEYS.some((k) => c[k] != null) || PARAMS.some((k) => isSpec(c[k])));

// ---------- 去重（可选） ----------
const dropped = [];
let cues0 = timed;
if (cfg.dedupe != null) {
  if (!(cfg.dedupe > 0)) die(`dedupe 要是正的秒数，收到 ${cfg.dedupe}`);
  const order = timed.map((c, i) => [c, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]);
  const kept = [];
  for (const [c] of order) {
    const k = kept.findLast((x) => c.t - x.t < cfg.dedupe);
    if (k && !(c.stack != null && c.stack === k.stack)) { dropped.push({ t: +c.t.toFixed(3), type: c.type ?? c.file, kind: c._event?.kind, near: +k.t.toFixed(3) }); continue; }
    kept.push(c);
  }
  cues0 = kept;
}

// ---------- 音色 / 素材 ----------
const cues = cues0.map((c, i) => {
  if (!c.file && !Object.hasOwn(SOUNDS, c.type))
    die(`cue #${i}: 未知音效类型 ${c.type}。${sfxRuntimeLabel} 里有：${Object.keys(SOUNDS).join(' ')}。` +
        (own ? '要新音色就在这份的 SOUNDS 里加一项（名字: [时长秒, (t, rnd) => 样本]），或写 "file" 用素材'
          : `要新音色：把套件的 film-narration/assets/runtime/sfx.mjs 拷到 ${filmRuntime}，在它的 SOUNDS 里加；或写 "file" 用素材`));
  const out = { ...c };
  if (c.file) {
    const f = isAbsolute(c.file) ? c.file : join(film, c.file);
    if (!existsSync(f)) die(`cue #${i}: 素材不存在 ${f}`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'],
      { maxBuffer: 1 << 30 });
    if (r.status !== 0) die(`cue #${i}: ffmpeg 解码失败 ${r.stderr}`);
    out.samples = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  }
  return out;
});

const outPath = resolve(film, arg('out') ?? 'out/sfx.wav');
const metaPath = outPath.replace(/\.[^./]+$/, '') + '.json';
mkdirSync(dirname(outPath), { recursive: true });

if (!stereo) {
  await closeScene();   // fromScene 的事件全映射成 null 时会走到这里
  // 单声道路径（与立体声路径的差别见仓库 docs/verified/film-narration.md §29）
  const mix = renderCues(cues, { length: vo?.duration ?? 0 });
  writeFileSync(outPath, toWav(mix));
  writeFileSync(metaPath, JSON.stringify({ narrationOffset: offset, script_hash: narData?.script_hash ?? null,
    cues: cues.map((c) => ({ t: +c.t.toFixed(3), at: c.at, type: c.type ?? c.file })) }, null, 1) + '\n');
  console.log(`✓ ${outPath.replace(film + '/', '')}  ${cues.length} 个事件  ${(mix.length / RATE).toFixed(2)}s  （成片时间，片头偏移 +${offset}s，记在 ${metaPath.replace(film + '/', '')}）`);
  console.log(`  音色来自 ${sfxRuntimeLabel}`);
  for (const c of cues) console.log(`  ${c.t.toFixed(3)}s  ${c.file ?? c.type}${c.at ? `  ← 「${c.at}」` : ''}`);
  process.exit(0);
}

// ---------- 立体声路径：把参数式解析成数字或曲线 ----------
// 混音器与音色同一份运行时
if (typeof filmRt.renderStereo !== 'function') die(`${sfxRuntimeLabel} 没有 renderStereo：立体声路径要它。删掉片内这份改用套件的，或从套件那份合并过来`);
const mixer = filmRt;
const mixerLabel = sfxRuntimeLabel;
const curveRate = cfg.curveRate ?? 240;
if (!(curveRate > 0)) die(`curveRate 要是正数，收到 ${cfg.curveRate}`);
const mapVal = (x, s) => {
  const pw = s.pow ?? 1, y = (s.add ?? 0) + (s.scale ?? 1) * Math.sign(x) * Math.abs(x) ** pw;
  return Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, y));
};
const evalProbe = (ts) => scene.S.page.evaluate((ts) => ts.map((t) => window.probe(t)), ts);
const evalAnchors = (ts) => scene.S.page.evaluate(async (ts) => { const o = []; for (const t of ts) o.push(await window.anchors(t)); return o; }, ts);
if (needScene) {
  const has = await scene.S.page.evaluate(() => ({ probe: typeof window.probe === 'function', anchors: typeof window.anchors === 'function' }));
  if (cues.some(usesProbe) && !has.probe) await sceneDie('cue 写了 {"probe": …}，但场景没有暴露 window.probe(t)');
  if (cues.some((c) => c.anchor != null) && !has.anchors) await sceneDie('cue 写了 "anchor"，但场景没有暴露 window.anchors(t)（film-core runtime/anchors.js）');
}
const report = [];
for (const [i, c] of cues.entries()) {
  const who = `cue #${i}（${c.type ?? c.file} @${c.t.toFixed(3)}s${c._event ? `，场景事件 ${c._event.kind}` : ''}）`;
  // 事件强度 v
  for (const k of PARAMS) if (isSpec(c[k]) && c[k].v != null && c[k].probe == null) {
    const v = c._event?.v;
    if (!Number.isFinite(v)) await sceneDie(`${who}：${k} 写了 {"v": …}，但这个 cue 不是来自带 v 的场景事件`);
    c[k] = mapVal(v, c[k]);
  }
  // probe 曲线：在 cue 期间按 curveRate 采样（rate 本身是曲线时 span 推不出来，要写 dur）
  if (usesProbe(c)) {
    if (isSpec(c.rate) && c.dur == null) await sceneDie(`${who}：rate 读 probe 曲线时要写 dur（曲线音高下这个声音多长推不出来）`);
    const span = c.dur ?? (c.samples ? c.samples.length / RATE : SOUNDS[c.type][0]) / (typeof c.rate === 'number' ? c.rate : 1);
    const n = Math.max(2, Math.ceil(span * curveRate) + 1);
    const ts = Array.from({ length: n }, (_, j) => c.t + j / curveRate);
    const vals = await evalProbe(ts);
    for (const k of PARAMS) if (isSpec(c[k]) && c[k].probe != null) {
      const name = c[k].probe, spec = c[k];
      const v = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const x = vals[j]?.[name];
        if (!Number.isFinite(x)) await sceneDie(`${who}：${k} 读 probe 曲线「${name}」，window.probe(${ts[j].toFixed(3)}).${name} = ${JSON.stringify(x)}，不是有限数（probe 返回了：${Object.keys(vals[j] ?? {}).join('、')}）`);
        v[j] = mapVal(x, spec);
      }
      c[k] = { t0: c.t, rate: curveRate, v };
      report.push(`${who}  ${k} ← probe「${name}」 ${n} 点 @${curveRate}Hz  范围 ${Math.min(...v).toFixed(3)}..${Math.max(...v).toFixed(3)}`);
    }
  }
  // 锚点声像
  if (c.anchor != null) {
    if (c.pan != null) await sceneDie(`${who}：pan 和 anchor 只能写一个`);
    const width = c.panWidth ?? cfg.panWidth;
    if (!Number.isFinite(width)) await sceneDie(`${who}：用 anchor 定声像必须写 panWidth（cue 上或 cues.json 顶层）。`
      + `pan = panWidth·(2·cx − 1)：1 = 画面左右边缘对应硬左/硬右，0.6 = onetake 和 tencent-5y 的取值，0 = 不跟画面。`
      + `幅度越大越"跟手"，代价是手机外放/单声道下听不出、耳机里边缘的声音只在一只耳朵；套件不替你选`);
    const span = c.dur ?? (c.samples ? c.samples.length / RATE : SOUNDS[c.type][0]) / (typeof c.rate === 'number' ? c.rate : 1);
    const fps = scene.fps;
    const ts = c.follow ? Array.from({ length: Math.max(2, Math.ceil(span * fps) + 1) }, (_, j) => c.t + j / fps) : [c.t];
    const fr = await evalAnchors(ts);
    const cx = fr.map((f) => f?.items?.[c.anchor]?.cx);
    const known = cx.filter(Number.isFinite);
    if (!known.length) await sceneDie(`${who}：锚点「${c.anchor}」在 ${c.follow ? `${ts[0].toFixed(3)}–${ts.at(-1).toFixed(3)}s` : `t=${c.t.toFixed(3)}s`} 没登记（这一帧有：${Object.keys(fr[0]?.items ?? {}).join('、') || '无'}）`);
    // follow 期间某几帧没登记（出画/还没画）：沿用最近一次登记到的位置
    let lastK = known[0];
    const pans = cx.map((x) => { if (Number.isFinite(x)) lastK = x; return Math.max(-1, Math.min(1, width * (2 * lastK - 1))); });
    c.pan = c.follow ? { t0: c.t, rate: fps, v: Float32Array.from(pans) } : pans[0];
    report.push(`${who}  pan ← 锚点「${c.anchor}」${c.follow ? ` 跟随 ${ts.length} 帧 @${fps}fps 范围 ${Math.min(...pans).toFixed(2)}..${Math.max(...pans).toFixed(2)}` : ` cx=${cx[0].toFixed(3)} → ${pans[0].toFixed(2)}`}（panWidth ${width}）`);
  }
}
const emitPath = arg('emit');
if (emitPath) {
  const plain = cues.filter((c) => c._event).map((c) => {
    const o = { t: +c.t.toFixed(4) }; for (const [k, v] of Object.entries(c)) if (!['t', '_event', 'samples', 'anchor', 'follow', 'panWidth'].includes(k)) o[k] = v;
    for (const k of PARAMS) if (o[k]?.v instanceof Float32Array) o[k] = { probe: '（已采样，见 out/sfx.json）' };
    if (typeof o.pan === 'number') o.pan = +o.pan.toFixed(3);
    o._from = `场景事件 ${c._event.kind}`; return o;
  });
  writeFileSync(resolve(film, emitPath), JSON.stringify(plain, null, 1) + '\n');
  console.log(`✓ ${emitPath}  ${plain.length} 个由场景事件生成的 cue`);
}
await closeScene();

if (!cfg.room && cues.some((c) => c.send != null && c.send !== 0))
  die('有 cue 写了 send，但 cues.json 顶层没有 room（{ size: 0..1, damp: 0..1 }）。房间多大是这支片的选择，套件不给默认；不要房间就去掉 send');
let L, R;
try { ({ L, R } = mixer.renderStereo(cues, { sounds: SOUNDS, length: vo?.duration ?? 0, room: cfg.room ?? null })); }
catch (e) { die(`混音失败：${e.message}`); }
writeFileSync(outPath, mixer.toWavStereo(L, R));
let peak = 0; for (let n = 0; n < L.length; n++) peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
const curveInfo = (p) => (p?.v instanceof Float32Array ? { t0: +p.t0.toFixed(3), rate: p.rate, n: p.v.length } : p);
writeFileSync(metaPath, JSON.stringify({ narrationOffset: offset, script_hash: narData?.script_hash ?? null, channels: 2,
  panLaw: mixer.PAN_LAW ?? 'equal-power', mixer: mixerLabel, room: cfg.room ?? null, dedupe: cfg.dedupe ?? null, dropped,
  sceneEvents: cfg.fromScene ? sceneEvents.length : undefined,
  cues: cues.map((c) => ({ t: +c.t.toFixed(3), at: c.at, type: c.type ?? c.file, event: c._event?.kind,
    ...Object.fromEntries(PARAMS.filter((k) => c[k] != null).map((k) => [k, curveInfo(c[k])])),
    ...(c.anchor ? { anchor: c.anchor } : {}), ...(c.dur != null ? { dur: c.dur } : {}) })) }, null, 1) + '\n');
console.log(`✓ ${outPath.replace(film + '/', '')}  立体声  ${cues.length} 个事件${eventCues.length ? `（其中 ${cues.filter((c) => c._event).length} 个来自场景 window.events()）` : ''}${dropped.length ? `  去重丢掉 ${dropped.length} 个（dedupe ${cfg.dedupe}s）` : ''}  ${(L.length / RATE).toFixed(2)}s  峰值 ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS${peak > 1 ? '  ⚠ 超过 0 dBFS，写 WAV 时削顶了：降 gain' : ''}`);
console.log(`  音色来自 ${sfxRuntimeLabel}；混音器 ${mixerLabel}${cfg.room ? `；房间 ${JSON.stringify(cfg.room)}` : ''}`);
for (const r of report) console.log(`  ${r}`);
for (const c of cues) console.log(`  ${c.t.toFixed(3)}s  ${c.file ?? c.type}${c.at ? `  ← 「${c.at}」` : ''}${c._event ? `  ← 事件 ${c._event.kind}` : ''}`);
