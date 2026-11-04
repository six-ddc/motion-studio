// film-core lib · 门的注册表：读各已安装 skill 的 gates.json，算出某支片子该跑哪些门、怎么跑。
// accept（--deep）和 deliver 共用这一份，两边的"哪些门适用"才不会分叉。格式契约见 references/api.md「gates.json」。
//
// 三种触发（when）：
//   "always"                 内核门，永远开。只许 film-core 声明（别的 skill 声明 always 直接报错：内核之外没有拦路的门）
//   { "uses": [文件名…] }    用了才开：这支片子实际加载的运行时（serve 的加载记录 / 渲染清单）里有其中任一个
//   { "checks": [id…] }      声明才开：film.json checks 里有其中任一个 id。一个门可认领多个 id（例如评审脚本一次查完）
// 声明了而没有任何已安装 skill 认领的 id → 红（缺能力），不会静默不开。
//
// 共享门：同一个门可以由多个 skill 共同认领（例：film-motion 的转场和 film-webfx 的着色器层都要门 4）。
// 各自在 gates.json 写**同一个 id** 的 uses 门、同样的 run/needs/deliver/mp4/timeoutPerFrame（run 不许含 {skill}），
// 注册表把它们合成一道门、uses 取并集——一支片子同时用了两边的运行时也只跑一次。
// 另外 planGates 按展开后的命令去重：两道不同 id 的门命令完全相同，只跑先排到的那道，后一道记「同 X」。
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installedSkills, findVenvBin, CORE_DIR } from './env.mjs';
import { CHECK_ID, parseChecks } from './film.mjs';
import { readRuntimeRecord } from './serve.mjs';

const GATE_ID = /^[a-z][a-z0-9-]*$/;
const KEYS = new Set(['id', 'when', 'run', 'about', 'mp4', 'needs', 'cost', 'deliver', 'timeoutPerFrame']);

/** 读全部已安装 skill 的 gates.json → { gates: [...], claims: Map<checkId, gate>, errors: [字符串] } */
export function loadGates() {
  const gates = [], errors = [], claims = new Map(), ids = new Map();   // ids: 门 id → 已登记的 gate
  for (const { name: skill, dir } of installedSkills()) {
    const p = join(dir, 'gates.json');
    if (!existsSync(p)) continue;
    let j;
    try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { errors.push(`${skill}/gates.json 不是合法 JSON：${e.message}`); continue; }
    if (j.schema !== 1 || !Array.isArray(j.gates)) { errors.push(`${skill}/gates.json：要 { "schema": 1, "gates": [...] }`); continue; }
    for (const g of j.gates) {
      const where = `${skill}/gates.json 的门 ${JSON.stringify(g?.id)}`;
      const bad = (m) => errors.push(`${where}：${m}`);
      if (!g || typeof g !== 'object') { bad('不是对象'); continue; }
      const extra = Object.keys(g).filter((k) => !KEYS.has(k));
      if (extra.length) { bad(`不认识的字段 ${extra.join(', ')}`); continue; }
      if (!GATE_ID.test(g.id ?? '')) { bad('id 要小写字母开头、只含 [a-z0-9-]'); continue; }
      if (!Array.isArray(g.run) || !g.run.length || !g.run.every((x) => typeof x === 'string')) { bad('run 要是非空字符串数组'); continue; }
      if (ids.has(g.id)) {
        const prev = ids.get(g.id);
        const why = sharedMismatch(prev, g);
        if (why) { bad(`id 与 ${prev.skills.join('、')} 的门重复${why === true ? '' : `（共享门要求${why}）`}`); continue; }
        for (const u of g.when.uses) if (!prev.when.uses.includes(u)) prev.when.uses.push(u);
        prev.skills.push(skill);
        if (g.about && g.about !== prev.about) prev.about = prev.about ? `${prev.about} ｜ ${g.about}` : g.about;
        prev.cost = Math.max(prev.cost, g.cost ?? 1);
        continue;
      }
      let kind;
      if (g.when === 'always') {
        if (skill !== 'film-core') { bad('"always" 只许 film-core 声明（内核之外的门要么用了才开，要么声明才开）'); continue; }
        kind = 'kernel';
      } else if (g.when && Array.isArray(g.when.uses) && g.when.uses.length && g.when.uses.every((x) => typeof x === 'string')) kind = 'uses';
      else if (g.when && Array.isArray(g.when.checks) && g.when.checks.length && g.when.checks.every((x) => CHECK_ID.test(x))) kind = 'checks';
      else { bad('when 要是 "always" / {"uses": [文件名…]} / {"checks": [check id…]}'); continue; }
      if (g.mp4 != null && !['optional', 'required'].includes(g.mp4)) { bad('mp4 只能是 "optional" / "required"'); continue; }
      if (g.needs != null && !(Array.isArray(g.needs) && g.needs.every((x) => ['manifest', 'final', 'scene'].includes(x)))) { bad('needs 只能列 manifest / final / scene'); continue; }
      const gate = { ...g, when: kind === 'uses' ? { uses: [...g.when.uses] } : g.when, skill, skills: [skill], skillDir: dir, kind, cost: g.cost ?? 1 };
      if (kind === 'checks') {
        let clash = false;
        for (const c of g.when.checks) if (claims.has(c)) { bad(`check id "${c}" 已被 ${claims.get(c).skill} 的门 ${claims.get(c).id} 认领`); clash = true; }
        if (clash) continue;
        for (const c of g.when.checks) claims.set(c, gate);
      }
      ids.set(g.id, gate);
      gates.push(gate);
    }
  }
  return { gates, claims, errors };
}

/** 同 id 的第二份声明能不能并进第一份（共享门）。能 → null；不能 → true（干脆不是共享门）或缺的条件说明。 */
function sharedMismatch(prev, g) {
  if (prev.kind !== 'uses' || !(g.when && Array.isArray(g.when.uses) && g.when.uses.length && g.when.uses.every((x) => typeof x === 'string'))) return true;
  const same = (k) => JSON.stringify(prev[k] ?? null) === JSON.stringify(g[k] ?? null);
  if (prev.run.some((x) => x.includes('{skill}')) || g.run.some((x) => x.includes('{skill}'))) return ' run 不含 {skill}';
  const diff = ['run', 'needs', 'deliver', 'mp4', 'timeoutPerFrame'].filter((k) => !same(k));
  return diff.length ? ` ${diff.join(' / ')} 一致` : null;
}

// 片子上的前置条件
const filmJson = (dir) => { try { return JSON.parse(readFileSync(join(dir, 'film.json'), 'utf8')); } catch { return {}; } };
export function manifestOf(dir) {
  const fmt = filmJson(dir).format ?? '9x16';
  try { const m = JSON.parse(readFileSync(join(dir, 'out', '.render', `${fmt}.frames.json`), 'utf8')); return m.key ? m : null; } catch { return null; }
}
/** 交付的成片：out/final-<format>.mp4（合流后的那一个）；没有、或不新鲜（见 finalState）都返回 null */
export function finalOf(dir, fmt = null) {
  const st = finalState(dir, fmt);
  return st.state === 'fresh' ? st.path : null;
}

/** 合流记录 out/.render/final-<format>.mux.json 的路径（格式见 references/api.md「合流记录」） */
export const muxRecordPath = (dir, fmt) => join(dir, 'out', '.render', `final-${fmt}.mux.json`);
export function readMuxRecord(dir, fmt) { try { return JSON.parse(readFileSync(muxRecordPath(dir, fmt), 'utf8')); } catch { return null; } }
const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * 成片新不新鲜：out/final-<format>.mp4 是不是**现在这些输入**合出来的。门只拿新鲜的成片过，旧成片不许混过去。
 * → { state: 'none' | 'fresh' | 'stale', path, why, record }
 *   none   没有成片
 *   fresh  有合流记录，记录里的成片 sha 与输入（无声成片、旁白、音效、配乐）sha、片头偏移都与现在一致
 *   stale  没有合流记录，或成片/任一输入变了（典型：定稿重渲之后没重新合流）
 */
export function finalState(dir, fmt = null) {
  const f = fmt ?? filmJson(dir).format ?? '9x16';
  const path = join(dir, 'out', `final-${f}.mp4`);
  if (!existsSync(path)) return { state: 'none', path: null, why: `没有成片 out/final-${f}.mp4` };
  const rec = readMuxRecord(dir, f);
  const stale = (why) => ({ state: 'stale', path, why: `成片 out/final-${f}.mp4 过期：${why}`, record: rec });
  if (!rec) return stale(`没有合流记录 out/.render/final-${f}.mux.json，不知道它是不是现在的无声成片合出来的（重新合流一次）`);
  if (rec.output?.sha256 !== shaOf(path)) return stale('成片不是合流记录里的那一份（被别的东西覆盖了）');
  for (const [role, inp] of Object.entries(rec.inputs ?? {})) {
    const p = join(dir, inp.path);
    if (!existsSync(p)) return stale(`合流用的${role} ${inp.path} 不在了`);
    if (shaOf(p) !== inp.sha256) return stale(`合流之后 ${inp.path} 变了${role === 'video' ? '（重渲过）' : ''}，要重新合流`);
  }
  const off = filmJson(dir).narrationOffset ?? 0;
  if (rec.narrationOffset != null && Math.abs(rec.narrationOffset - off) > 1e-9) return stale(`film.json narrationOffset ${off} ≠ 合流时的 ${rec.narrationOffset}`);
  return { state: 'fresh', path, why: null, record: rec };
}

/** 这支片子实际加载过的运行时名字：渲染清单里记的 ∪ serve 的最新加载记录。都没有返回 null（还没加载过）。 */
export function loadedRuntimeNames(dir) {
  const names = new Set();
  let any = false;
  const m = manifestOf(dir);
  if (Array.isArray(m?.runtime)) { any = true; for (const r of m.runtime) names.add(r.name); }
  const rec = readRuntimeRecord(dir);
  if (rec?.files) { any = true; for (const n of Object.keys(rec.files)) names.add(n); }
  return any ? names : null;
}

/**
 * 算出一支片子的门计划。返回 [{ id, gate|null, kind, state, why, cmd }]：
 *   state 'run'      要跑（cmd = [bin, args]）
 *   state 'na'       不适用（前置条件不在、没用到那个运行时），不算失败也不算通过
 *   state 'missing'  声明了却跑不了（没人认领的 check id、缺成片），算失败
 *   state 'pending'  uses 门：还没有加载记录，要等内核门跑完再算（调用方跑完 seam 后重算）
 * opts.mode       'deep' | 'deliver'（deliver 跳过 deliver:false 的门）
 * opts.filmsDir   films/ 绝对路径
 * opts.slug
 * opts.loaded     Set<运行时名> | null（不给就从片子目录读）
 */
export function planGates(dir, { mode = 'deep', filmsDir, slug, loaded, registry = loadGates() } = {}) {
  const plan = [];
  let declared;
  try { declared = parseChecks(filmJson(dir).checks); }
  catch (e) { plan.push({ id: 'checks', gate: null, kind: 'checks', state: 'missing', why: `film.json checks 写错了：${e.message}` }); declared = new Map(); }
  const names = loaded === undefined ? loadedRuntimeNames(dir) : loaded;
  const hasScene = existsSync(join(dir, filmJson(dir).entry ?? 'scene.html'));
  const ctx = { dir, filmsDir, slug };
  const ran = new Map();   // 展开后的命令 → 先排到的门 id（命令相同只跑一次）
  for (const g of [...registry.gates].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.cost - b.cost || a.id.localeCompare(b.id))) {
    if (mode === 'deliver' && g.deliver === false) continue;
    const item = { id: g.id, gate: g, kind: g.kind };
    if (g.kind === 'uses') {
      if (names == null) { plan.push({ ...item, state: 'pending', why: '还没有运行时加载记录（内核门跑过一次就有）' }); continue; }
      const hit = g.when.uses.filter((u) => names.has(u));
      if (!hit.length) { plan.push({ ...item, state: 'na', why: `没加载 ${g.when.uses.join(' / ')}` }); continue; }
      item.why = `加载了 ${hit.join(' ')}`;
    } else if (g.kind === 'checks') {
      const on = g.when.checks.filter((c) => declared.has(c));
      if (!on.length) { plan.push({ ...item, state: 'na', why: '本片没声明' }); continue; }
      item.why = `声明了 ${on.join(' ')}`;
    }
    const needs = g.needs ?? [];
    const fin = needs.includes('final') || g.mp4 ? finalState(dir) : null;
    const lack = needs.filter((n) => (n === 'manifest' && !manifestOf(dir)) || (n === 'final' && fin.state !== 'fresh') || (n === 'scene' && !hasScene));
    if (lack.length) {
      const say = { manifest: '没有整片渲染清单（out/.render/<format>.frames.json）', final: fin?.why, scene: '没有入口页' };
      // 声明了的检查缺前置 = 红；内核门 / uses 门缺前置 = 不适用；成片在但过期 = 红（不管哪类门）
      const red = g.kind === 'checks' || (lack.includes('final') && fin.state === 'stale');
      plan.push({ ...item, state: red ? 'missing' : 'na', why: lack.map((n) => say[n]).join('；') });
      continue;
    }
    // 旧成片（定稿重渲之后没重新合流）：拿它过门等于拿上一版的声音和时长过门，红；optional 也一样——不能悄悄当"没成片"跳过
    if (fin?.state === 'stale') { plan.push({ ...item, state: 'missing', why: fin.why }); continue; }
    const mp4 = g.mp4 && fin?.state === 'fresh' ? fin.path : null;
    if (g.mp4 === 'required' && !mp4) { plan.push({ ...item, state: 'missing', why: '要成片 out/final-<format>.mp4（先合流）' }); continue; }
    const cmd = commandOf(g, ctx, mp4);
    const key = JSON.stringify(cmd);
    if (ran.has(key)) { plan.push({ ...item, state: 'na', why: `与 ${ran.get(key)} 同一条命令，不重复跑` }); continue; }
    ran.set(key, g.id);
    plan.push({ ...item, state: 'run', cmd });
  }
  for (const id of declared.keys()) {
    if (!registry.claims.has(id)) plan.push({ id: `check:${id}`, gate: null, kind: 'checks', state: 'missing', why: `缺能力：check id "${id}" 没有已安装的 skill 认领（装上提供它的 film-* skill，或从 film.json checks 删掉）` });
  }
  return plan;
}
const kindOrder = (k) => ({ kernel: 0, uses: 1, checks: 2 }[k] ?? 3);

/** 把 run 模板展开成 [bin, args] */
export function commandOf(g, { dir, filmsDir, slug }, mp4 = null) {
  const sub = (s) => s.replaceAll('{skill}', g.skillDir).replaceAll('{core}', CORE_DIR)
    .replaceAll('{slug}', slug).replaceAll('{films}', filmsDir).replaceAll('{film}', dir);
  let [bin, ...args] = g.run.map(sub);
  if (bin === 'node') bin = process.execPath;
  else if (bin === 'python') bin = findVenvBin('python', { filmsDir }) ?? 'python3';
  if (mp4) args.push('--mp4', mp4);
  return [bin, args];
}

/** 跑一道门。返回 { ok, code, timedOut, ms, tail }（tail = 输出里像结论的几行） */
export function runGate([bin, args], { cwd, timeoutMs }) {
  const t0 = Date.now();   // 只用于打印耗时
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal && r.status == null);
  const tail = out.split('\n').filter((l) => /失败|错误|FAIL|✗|不合格|缺能力/.test(l)).slice(0, 3).join(' / ').slice(0, 240)
    || (r.error ? String(r.error.message) : `退出码 ${r.status}`);
  return { ok: r.status === 0 && !timedOut, code: r.status, timedOut, ms: Date.now() - t0, tail, out };
}

/** 一道门的墙钟上限：默认 30 分钟；逐帧扫全片的门（timeoutPerFrame 毫秒/帧）按帧数放宽 */
export function timeoutOf(g, dir, overrideMin = null) {
  if (overrideMin != null) return overrideMin * 60_000;
  const base = 30 * 60_000;
  const per = g?.timeoutPerFrame ?? 0;
  if (!per) return base;
  const m = manifestOf(dir);
  let frames = m?.hashes?.length ?? 0;
  if (!frames) {
    const c = filmJson(dir);
    try { const n = JSON.parse(readFileSync(join(dir, 'narration.json'), 'utf8')); frames = Math.ceil(((c.narrationOffset ?? 0) + (n.duration ?? 0) + (c.narrationTail ?? 0)) * (c.fps ?? 60)); } catch {}
  }
  return Math.max(base, frames * per + 10 * 60_000);
}
