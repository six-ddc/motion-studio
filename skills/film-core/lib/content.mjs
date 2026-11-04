// film-core lib · 内容数据层的 Node 侧：读 content.json、解析变体与矩阵、内容哈希、变体合流、变体清单。
// 合并规则只在 assets/runtime/content.js 写一遍（浏览器和这里 import 同一份），两边不会对"变体 b 长什么样"各说各话。
// content.json 是可选的：没有它的片子，render 一行都不经过这里（resolveFilmContent 返回 null）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { resolveContent, parseVariant, expandMatrix, stableStringify, validateContent } from '../assets/runtime/content.js';
import { readMuxRecord } from './gates.mjs';

export { resolveContent, parseVariant, expandMatrix, stableStringify, validateContent };

export const CONTENT_FILE = 'content.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const fileSha256 = (p) => sha256(readFileSync(p));

/** 读片子的 content.json；没有 → null；坏了 → 抛错（带路径） */
export function readContentDoc(dir) {
  const p = join(dir, CONTENT_FILE);
  if (!existsSync(p)) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${p} 不是合法 JSON：${e.message}`); }
  const errs = [...validateContent(doc), ...validateSlotMeta(doc)];
  if (errs.length) throw new Error(`${p} 不合法：\n  - ${errs.join('\n  - ')}`);
  return doc;
}

// 槽位的语义声明（可选，content-json.md §2）：description 说"这个槽代表什么"（给接手的 agent 读，不写位置），
// kind 说它属于哪类：content（文案）/ identity（品牌名、产品名、logo、网址、背书方——换品牌时最容易被现编）/ style。
// identity 槽位取不到就停下来问人，不许编：所以它必须有 description（不然问不清要什么），值不许是空串（空 = 还没问到，不能渲）。
// 只在 Node 侧（render 读 content.json 时）查；浏览器运行时 content.js 不变，页面照旧只认 text。
export const SLOT_KINDS = ['content', 'identity', 'style'];
export function validateSlotMeta(doc) {
  const errs = [];
  const text = doc && typeof doc.text === 'object' && doc.text ? doc.text : {};
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const valOf = (v) => (typeof v === 'string' ? v : obj(v) ? v.text : undefined);
  const identity = new Set();
  for (const [k, v] of Object.entries(text)) {
    if (!obj(v)) continue;
    if (v.description != null && (typeof v.description !== 'string' || !v.description.trim())) errs.push(`text.${k}.description 要是非空字符串：写这个槽代表什么（"本片推广的产品名"），不写它在画面哪里`);
    if (v.kind == null) continue;
    if (!SLOT_KINDS.includes(v.kind)) { errs.push(`text.${k}.kind 只能是 ${SLOT_KINDS.join(' / ')}，收到 ${JSON.stringify(v.kind)}`); continue; }
    if (v.kind !== 'identity') continue;
    identity.add(k);
    if (typeof v.description !== 'string' || !v.description.trim()) errs.push(`text.${k} 是 identity 槽位，要写 description（它代表谁 / 什么）：取不到值时要拿它去问人`);
    if (typeof v.text === 'string' && !v.text.trim()) errs.push(`text.${k} 是 identity 槽位但值为空：身份信息取不到就问用户，不许编，也不能空着渲`);
  }
  for (const [dim, opts] of Object.entries(obj(doc?.variants) ? doc.variants : {})) {
    for (const [opt, ov] of Object.entries(obj(opts) ? opts : {})) {
      for (const [k, v] of Object.entries(obj(ov?.text) ? ov.text : {})) {
        if (!identity.has(k)) continue;
        const t = valOf(v);
        if (typeof t === 'string' && !t.trim()) errs.push(`variants.${dim}.${opt}.text.${k}：identity 槽位不能被覆盖成空串（身份信息取不到就问，不许编）`);
      }
    }
  }
  return errs;
}

/** 生效内容的哈希（键序无关、不含组合名）：内容没变，哈希就不变 */
export function contentHash(doc, variant, format) {
  const { id, picks, ...data } = resolveContent(doc, { variant, format });   // 只哈希内容本身：两个组合内容相同（如 cta-a = 基础），哈希相同
  return sha256(stableStringify(data));
}

/** 变体产物目录 out/variants/<id>/ */
export const variantDir = (F, id) => join(F.out, 'variants', id);

/**
 * 给变体配音轨：音轨与画面变体无关（旁白、音效、配乐都不随文案变），所以直接取主片成片 out/final-<fmt>.mp4 的音轨，
 * 和变体的无声片 remux（视频 -c copy）。不重放混音：重放 mux.sh 会把合流记录写到主片的 out/.render/final-<fmt>.mux.json 上。
 * 前提：主片合流记录在、记录里的旁白/音效/配乐与现在的文件一致、主片成片就是记录里那份。不满足 → 不合流，返回原因。
 * from/to 给了（区间小样）就从主片音轨的同一段截（音频重编码 AAC，截点精确到采样）。
 */
export function muxVariant(F, fmt, silent, out, { from = 0, to = null } = {}) {
  const rec = readMuxRecord(F.dir, fmt);
  if (!rec) return { ok: false, why: `主片没有合流记录 out/.render/final-${fmt}.mux.json（先给主片合流一次），变体只出无声片` };
  const main = join(F.dir, rec.output?.path ?? `out/final-${fmt}.mp4`);
  if (!existsSync(main) || fileSha256(main) !== rec.output?.sha256) return { ok: false, why: `主片成片 ${relative(F.dir, main)} 不是合流记录里那份（重渲或改过），变体只出无声片` };
  for (const role of ['vo', 'sfx', 'music']) {
    const r = rec.inputs?.[role];
    if (!r) continue;
    const p = join(F.dir, r.path);
    if (!existsSync(p) || fileSha256(p) !== r.sha256) return { ok: false, why: `主片音轨过期：${r.path} 合流之后改过（先重新合流主片），变体只出无声片` };
  }
  const ranged = from > 0 || to != null;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent,
    ...(ranged ? ['-ss', String(from)] : []), '-i', main,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...(ranged ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']),
    '-shortest', '-movflags', '+faststart', out];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, why: `remux 失败：${r.stderr.trim().split('\n').pop()}` };
  return { ok: true, from: relative(F.dir, main) };
}

/** ffprobe 时长（秒） */
export function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number(r.stdout.trim());
  return Number.isFinite(d) ? d : null;
}

/**
 * 变体清单 out/variants/manifest.json：每个导出一条，键 "<变体id>/<画幅>[@<from>-<to>]"，重渲同一导出覆盖那一条。
 * 一条记：组合、内容哈希、来源（content.json / 模板 / 全部输入的 sha256、挂载的运行时）、渲染设置、渲染器、产物哈希、时长、画幅。
 */
export function writeVariantManifest(F, key, entry) {
  const p = join(F.out, 'variants', 'manifest.json');
  let m = { schema: 1, film: F.slug, exports: {} };
  try { if (existsSync(p)) m = { ...m, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch {}
  m.exports = { ...(m.exports ?? {}), [key]: entry };
  m.exports = Object.fromEntries(Object.entries(m.exports).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 1) + '\n');
  return p;
}

/** 模板哈希：输入清单里除 content.json 以外的文件（同一模板换数据，这个不变） */
export function templateDigest(files) {
  const h = createHash('sha256');
  for (const [r, s] of Object.entries(files)) if (r !== CONTENT_FILE) h.update(`${r}\0${s}\0`);
  return h.digest('hex');
}
