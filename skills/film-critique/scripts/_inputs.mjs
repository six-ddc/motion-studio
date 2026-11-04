// check.mjs 的输入指纹：运行开始时记一次，结束时再比一次，不一致 = 本次结果作废。
//
// 为什么要有：weiqi-ch1 的一次 28 分钟检查里，作者同时在改 scene.html——抽样读的是旧页面（加载时那一版），
// shotlist / style_guide 读的是新的（断言阶段才读），出了 2 条假 FAIL；check.mjs 没发现输入在运行中变了，
// 混合结果被当成了真结论。运行时间越长（并行之前一次半小时），这种事越容易撞上。
//
// 比什么（"本次读过的输入"）：
//   入口 html、film.json、narration.json、script.json、docs/**、runtime/**——无论加载与否都比；
//   其余文件（assets/、tools/、片子根下的 .js …）只比**本次真的被页面加载过的**（资源计时里出现过的）；
//   narration.json 指向的 wav（ffprobe 实测过）；--mp4 那个文件。
// 不比：out/（本脚本自己写的产物都在这里）；docs/review_log.md（review_log.mjs 从 checks.json 生成的，是这条流水线的下一步产物，不是输入）；
//   film.json 的 renderer 字段（render.mjs 渲完会改写它，本脚本不读它）——所以 film.json 按"去掉 renderer 后的内容"比，不看 mtime。
// 怎么比：内容 md5 + 大小 + mtime。内容一样而 mtime 变了也算：说明运行中被写过，中途可能读到过另一个版本
// （编辑器保存再撤销、touch）。不看 ctime：xattr 之类的元数据变动也会改它，会误报。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ALWAYS_DIRS = ['docs', 'runtime'];
const IGNORE = new Set(['docs/review_log.md']);
const md5 = (b) => createHash('md5').update(b).digest('hex');

function walk(dir, base, out) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name), rel = relative(base, p).split(sep).join('/');
    if (e.isDirectory()) { if (rel === 'out' || e.name === 'node_modules' || e.name === '.git') continue; walk(p, base, out); }
    else if (e.isFile()) out.push(rel);
  }
}

function fingerprint(abs, rel) {
  if (!existsSync(abs)) return null;
  const st = statSync(abs), buf = readFileSync(abs);
  if (rel === 'film.json') {
    // renderer 字段是 render.mjs 写的渲染环境记录，check.mjs 不读；按去掉它之后的内容比，mtime 不比
    let h; try { const j = JSON.parse(buf); delete j.renderer; h = md5(JSON.stringify(j)); } catch { h = md5(buf); }
    return { size: null, mtimeMs: null, md5: h };
  }
  return { size: st.size, mtimeMs: st.mtimeMs, md5: md5(buf) };
}

/** 开始时：片子目录里除 out/ 以外的每个文件 + 额外文件（wav、--mp4，绝对路径） */
export function snapshotInputs(F, extra = []) {
  const t0 = Date.now(), rels = [];
  walk(F.dir, F.dir, rels);
  const files = new Map();
  for (const rel of rels) files.set(rel, fingerprint(join(F.dir, rel), rel));
  for (const abs of extra) if (abs) files.set(abs, fingerprint(abs, abs));
  return { files, ms: Date.now() - t0 };
}

/** 结束时：比对本次读过的输入。loaded = 页面加载过的 URL 路径（/assets/x.png 形式）。返回 [{file, why}] */
export function verifyInputs(F, snap, { loaded = new Set(), extra = [] } = {}) {
  const t0 = Date.now();
  const entry = F.entry ?? F.config?.entry;
  const want = new Set([entry, 'film.json', 'narration.json', 'script.json']);
  for (const p of loaded) {
    const abs = resolve(F.dir, '.' + p);
    if (abs.startsWith(F.dir + sep)) want.add(relative(F.dir, abs).split(sep).join('/'));
  }
  // 常比的目录：开始时有的、结束时有的都算（运行中新加的文件也是"输入变了"）
  const now = [];
  for (const d of ALWAYS_DIRS) walk(join(F.dir, d), F.dir, now);
  for (const rel of [...snap.files.keys(), ...now]) if (ALWAYS_DIRS.some((d) => rel.startsWith(d + '/'))) want.add(rel);
  for (const abs of extra) if (abs) want.add(abs);
  const changed = [];
  for (const rel of want) {
    if (IGNORE.has(rel) || rel.startsWith('out/')) continue;
    const abs = rel.startsWith('/') ? rel : join(F.dir, rel);
    const a = snap.files.has(rel) ? snap.files.get(rel) : null, b = fingerprint(abs, rel);
    const name = rel.startsWith('/') ? relative(F.dir, rel) : rel;
    if (!a && !b) continue;
    if (!a) changed.push({ file: name, why: '运行中新出现' });
    else if (!b) changed.push({ file: name, why: '运行中被删了' });
    else if (a.md5 !== b.md5) changed.push({ file: name, why: '内容变了' });
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) changed.push({ file: name, why: '内容没变但运行中被写过（mtime 变了），中途可能读到过另一版' });
  }
  return { changed, checked: want.size, ms: Date.now() - t0 };
}
