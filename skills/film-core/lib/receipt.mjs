// film-core lib · 交付收据 films/<slug>/receipt.json：deliver 写、accept 读。格式契约见 references/api.md「receipt.json」。
//
// accept 对有收据的片子只做一件事：重算输入哈希，和收据比。一样 = 交付之后没人动过它（✓收据）；
// 不一样 = 改过却没重新交付（红）。所以"输入"要包含一切会影响成片或检查结论的东西：
// 片子目录里 out/ 以外的全部文件（场景、冻结的运行时、素材、narration.json、docs/、film.json）。
// 不含：out/（产物）、receipt.json 自己、film.json 的 renderer 字段（render 渲完才记）、.DS_Store 之类。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { playwrightVersion, SKILLS_ROOT } from './env.mjs';

export const RECEIPT = 'receipt.json';
export const receiptPath = (dir) => join(dir, RECEIPT);

export function readReceipt(dir) {
  const p = receiptPath(dir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return { _error: `receipt.json 不是合法 JSON：${e.message}` }; }
}

export function writeReceipt(dir, r) {
  writeFileSync(receiptPath(dir), JSON.stringify(r, null, 2) + '\n');
}

const SKIP = new Set(['.DS_Store', '__pycache__', 'node_modules', '.git']);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 输入清单：{ algo, digest, files: { 相对路径: sha256 } } */
export function receiptInputs(dir) {
  const files = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'out' || r === RECEIPT) continue;
      let st = e;
      if (e.isSymbolicLink()) { try { st = statSync(join(d, e.name)); } catch { continue; } }
      if (st.isDirectory()) walk(join(d, e.name), r);
      else if (st.isFile()) {
        let buf = readFileSync(join(d, e.name));
        if (r === 'film.json') { try { const j = JSON.parse(buf); delete j.renderer; buf = Buffer.from(JSON.stringify(j)); } catch {} }
        files[r] = sha256(buf);
      }
    }
  };
  walk(dir, '');
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const h = createHash('sha256');
  for (const [r, s] of Object.entries(sorted)) h.update(`${r}\0${s}\0`);
  return { algo: 'sha256', digest: h.digest('hex'), files: sorted };
}

/** 两份输入清单的差别：{ changed, added, removed }（相对路径数组） */
export function diffInputs(was = {}, now = {}) {
  const changed = [], added = [], removed = [];
  for (const [r, s] of Object.entries(now)) { if (!(r in was)) added.push(r); else if (was[r] !== s) changed.push(r); }
  for (const r of Object.keys(was)) if (!(r in now)) removed.push(r);
  return { changed, added, removed };
}

/** 一句话说清改了哪些文件 */
export function describeDiff(d, max = 4) {
  const parts = [];
  const list = (xs) => xs.slice(0, max).join(' ') + (xs.length > max ? ` …共 ${xs.length} 个` : '');
  if (d.changed.length) parts.push(`改了 ${list(d.changed)}`);
  if (d.added.length) parts.push(`新增 ${list(d.added)}`);
  if (d.removed.length) parts.push(`删了 ${list(d.removed)}`);
  return parts.join('；') || '（文件列表相同，但摘要不同：收据被手改过？）';
}

/** git 跟踪着 dir/receipt.json 吗（索引或 HEAD 里有）。不是 git 仓库、没装 git → false */
export function receiptTracked(dir) {
  const git = (args) => { const x = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); return x.status === 0 ? x.stdout.trim() : ''; };
  return !!(git(['ls-files', '--', RECEIPT]) || git(['ls-tree', '--name-only', 'HEAD', '--', RECEIPT]));
}

/** 收据状态：{ state: 'none' | 'ok' | 'changed' | 'broken' | 'deleted', why, receipt } */
export function receiptState(dir) {
  const r = readReceipt(dir);
  // 收据入库：工作区里删掉它不能让一支交付过的片子退回「未交付」（那样改了也不红）。不是 git 仓库时退化为「未交付」
  if (!r && receiptTracked(dir)) return { state: 'deleted', why: '入库的收据被删（git 跟踪着 receipt.json，工作区里没有）：恢复它（git checkout -- receipt.json）或重新 deliver' };
  if (!r) return { state: 'none', why: '未交付（没有 receipt.json）' };
  if (r._error) return { state: 'broken', why: r._error, receipt: r };
  if (r.schema !== 1 || !r.inputs?.digest) return { state: 'broken', why: 'receipt.json 缺 schema/inputs.digest', receipt: r };
  const now = receiptInputs(dir);
  if (now.digest === r.inputs.digest) return { state: 'ok', why: '', receipt: r };
  return { state: 'changed', why: `交付后改过、没重新交付：${describeDiff(diffInputs(r.inputs.files, now.files))}`, receipt: r };
}

/**
 * 收据里不写本机绝对路径（收据入库，换台机器、换个用户名不该变）。
 * root（仓库根 = films/ 的父目录）下的 → 相对 root；装 skill 的那层下的 → {skills}/…；家目录下的 → ~/…；其余（/usr/bin/…）原样。
 */
export function portablePath(p, root) {
  if (typeof p !== 'string' || !isAbsolute(p)) return p;
  const under = (base) => { if (!base) return null; const r = relative(base, p); return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : r === '' ? '.' : null; };
  const r = under(root);
  if (r != null) return r;
  const s = under(SKILLS_ROOT);
  if (s != null) return `{skills}/${s}`;
  const h = under(homedir());
  return h != null ? `~/${h}` : p;
}

/** 门命令 [bin, args] → 收据里的一行字符串（node 写成 node，路径按 portablePath） */
export const portableCmd = ([bin, args], root) =>
  [bin === process.execPath ? 'node' : portablePath(bin, root), ...args.map((a) => portablePath(a, root))].join(' ');

/** 环境指纹（写进收据）。browserFp = browser.mjs rendererFingerprint() 的结果，可不给 */
export function envFingerprint(browserFp = null) {
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return {
    ...(browserFp ?? { playwright: playwrightVersion() }),
    ffmpeg: ff.status === 0 ? ff.stdout.split('\n')[0] : null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}
