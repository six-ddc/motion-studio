// 派生品新鲜度：stills / transitions / contact / strip / phone / checks.json 旁边写一个 <产物>.meta.json，
// review 时比一下"生成时的场景输入"和"现在的场景输入"，过期就醒目提示。**只提示，不拦**（不改任何退出码，除非 fresh.mjs --strict）。
//
// 为什么要有：critique 自己的派生品（stills.png、*-contact.png、strip）放在 out/ 里不会自己消失，
// 改了 scene.html / shots/*.js / narration.json 之后，旧图还在原地、文件名不变——评审对着旧时间轴的图下结论，
// 和"门出问题时给绿灯"是同一类事故：工具没说谎，只是没说它看的是哪一版。
//
// 它测的量 vs 你可能以为它测的量：
//   测的是：生成那一刻片子目录里（除 out/ docs/ tools/ receipt.json）每个文件的 md5，与现在逐个比；contact 类再比源 MP4 的大小与 mtime。
//   不是：  "画面变了没有"。改了一行注释也会判过期（宁可多报）；反过来，场景从网络/片外读的东西变了它看不见。
//           contact 类判"新鲜"只说明它和那个 MP4 一致——MP4 本身是不是用最新场景渲的，归 film-core 的收据 / accept 管。
//   docs/ 不算输入：style_guide 改了不让静帧过期（静帧不读它）；checks.json 读 style_guide，但 check.mjs 自己每次重跑，过期只提示。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['out', 'docs', 'tools', 'node_modules', '.git']);
const SKIP_FILES = new Set(['receipt.json', '.DS_Store']);
const md5 = (b) => createHash('md5').update(b).digest('hex');

function walk(dir, base, out) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name), rel = relative(base, p).split(sep).join('/');
    // 顶层的 out/ docs/ tools/ 不算输入；node_modules / .git 哪层都跳
    if (e.isDirectory()) { if (!((dir === base && SKIP_DIRS.has(e.name)) || e.name === 'node_modules' || e.name === '.git')) walk(p, base, out); }
    else if (e.isFile() && !SKIP_FILES.has(e.name)) out.push(rel);
  }
}

/** 片子目录的场景输入指纹：{ hash, files: {rel: md5} }。film.json 去掉 renderer 字段再算（render.mjs 渲完会改写它）。 */
export function sceneFingerprint(dir) {
  const rels = [];
  walk(dir, dir, rels);
  rels.sort();
  const files = {};
  for (const rel of rels) {
    const buf = readFileSync(join(dir, rel));
    if (rel === 'film.json') { try { const j = JSON.parse(buf); delete j.renderer; files[rel] = md5(JSON.stringify(j)); continue; } catch { /* 坏 JSON 按原文算 */ } }
    files[rel] = md5(buf);
  }
  return { hash: md5(JSON.stringify(files)).slice(0, 12), files };
}

const metaPath = (product) => `${product}.meta.json`;
const fileStamp = (p) => { if (!p || !existsSync(p)) return null; const st = statSync(p); return { path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) }; };

/**
 * 在产物旁写 <产物>.meta.json。
 * dir：片子目录（不知道就 null，只记源 MP4）；extra：工具自己的时间轴信息（时刻表、剪辑点、观看宽度假设……）。
 */
export function writeMeta(product, { tool, dir = null, entry = null, mp4 = null, extra = {} }) {
  const meta = {
    schema: 1, tool, product: basename(product), createdAt: new Date().toISOString(),
    film: dir, entry, scene: dir ? sceneFingerprint(dir) : null, mp4: fileStamp(mp4), ...extra,
  };
  writeFileSync(metaPath(product), JSON.stringify(meta, null, 1));
  return meta;
}

export function readMeta(product) {
  const p = metaPath(product);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { _bad: true }; }
}

/**
 * 判一个产物新不新鲜：{ status: 'fresh' | 'stale' | 'nometa', reasons: [...], meta }。
 * nometa = 旧版工具产出、或 meta 坏了：新鲜度未知（不当成新鲜）。
 */
export function checkProduct(product, dir) {
  const meta = readMeta(product);
  if (!meta || meta._bad) return { status: 'nometa', reasons: [meta?._bad ? 'meta 不是合法 JSON' : '没有 meta（旧版工具产出），新鲜度未知'], meta: null };
  const reasons = [];
  if (meta.mp4) {
    const now = fileStamp(meta.mp4.path);
    if (!now) reasons.push(`源 MP4 已不存在：${meta.mp4.path}`);
    else if (now.size !== meta.mp4.size || now.mtimeMs !== meta.mp4.mtimeMs) reasons.push(`源 MP4 在生成之后被重渲/改写过：${basename(meta.mp4.path)}`);
  }
  if (meta.scene && dir) {
    const cur = sceneFingerprint(dir);
    if (cur.hash !== meta.scene.hash) {
      const a = meta.scene.files, b = cur.files, diff = [];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(k in a)) diff.push(`${k}（新增）`); else if (!(k in b)) diff.push(`${k}（删了）`); else if (a[k] !== b[k]) diff.push(k);
      }
      reasons.push(`场景输入在生成之后变了：${diff.slice(0, 6).join('、')}${diff.length > 6 ? ` 等 ${diff.length} 个` : ''}`
        + (meta.mp4 ? '（MP4 可能也是旧场景渲的，重渲后再出）' : ''));
    }
  }
  return { status: reasons.length ? 'stale' : 'fresh', reasons, meta };
}

/** out/ 下所有带 meta 的产物 + 已知文件名但没 meta 的产物（旧版产出）。返回 [{product, rel, ...checkProduct}] */
export function scanProducts(F) {
  const out = F.out, found = new Map();
  const add = (p) => { if (existsSync(p) && !found.has(p)) found.set(p, checkProduct(p, F.dir)); };
  const scan = (d) => { let ents = []; try { ents = readdirSync(d); } catch { return; }
    for (const n of ents) if (n.endsWith('.meta.json')) add(join(d, n.slice(0, -'.meta.json'.length))); };
  scan(out); scan(join(out, 'critique'));
  // 已知产物名：没有 meta 也列出来（旧版工具产出），免得"没 meta"被读成"没问题"
  let ents = []; try { ents = readdirSync(out); } catch { /* 没有 out/ */ }
  for (const n of ents) if (/^(stills|transitions)\.png$|-(contact|strip|phone)\.png$/.test(n)) add(join(out, n));
  add(join(out, 'critique', 'checks.json'));
  return [...found].map(([product, r]) => ({ product, rel: relative(F.dir, product), ...r }));
}

/** 给终端 / review_log 用的几行。stale 用 ⚠ 打头。 */
export function describeFreshness(list) {
  return list.map((x) => x.status === 'fresh' ? `  ✓ 新鲜  ${x.rel}`
    : x.status === 'stale' ? `  ⚠ 过期  ${x.rel} —— ${x.reasons.join('；')}`
      : `  ? 未知  ${x.rel} —— ${x.reasons.join('；')}`);
}
