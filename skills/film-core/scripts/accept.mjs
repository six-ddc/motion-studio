#!/usr/bin/env node
// 全仓库验收：每支片子一行，给一个退出码。
//
//   node <film-core>/scripts/accept.mjs              有收据：重算输入哈希和收据比；没收据：记「未交付」，不计入退出码
//   node <film-core>/scripts/accept.mjs --deep       全跑：内核门 + uses 门 + film.json checks 声明的门（不渲染、不冻结、不写收据）
//   node <film-core>/scripts/accept.mjs --film x     只看一支
//   node <film-core>/scripts/accept.mjs --list       只列出会做什么（--verbose 打出每道门的真实命令）
//   node <film-core>/scripts/accept.mjs --fixtures   连夹具一起：<films 的父目录>/tests/fixtures/_test-*（--fixtures-dir 改位置），以及 films/ 里 _ 前缀的
//
// 判法（references/api.md「receipt.json」）：
//   ✓收据        收据记的输入摘要 = 现在重算的摘要：交付之后没人动过这支片子，交付时过的门仍然作数
//   ✓收据·免门   同上，但那份收据是 freeze --receipt 补的，没过门（收据里写了理由）
//   ✗改过        有收据，但输入变了，没重新交付：计入退出码（列出改了哪些文件）
//   ✗收据被删    git 跟踪着 receipt.json 但工作区里没有：计入退出码（删收据不能把交付过的片子变回「未交付」）
//   未交付       没有 receipt.json（也没入库）：只报告，不计入退出码（做到一半的片子、评测片都在这里）
// --deep 时每道门真跑一遍；红的门在已交付的片子上计入退出码，在未交付的片子上只报告。
//
// 门从哪来：已安装的每个 film-* skill 的 gates.json（lib/gates.mjs）。uses 门按 serve 的加载记录触发——
// 内核门 seam 先跑，它加载场景时就把记录写好了。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cli } from '../lib/cli.mjs';
import { locateFilmsDir } from '../lib/env.mjs';
import { readArgs } from '../lib/film.mjs';
import { loadGates, planGates, runGate, timeoutOf } from '../lib/gates.mjs';
import { receiptState } from '../lib/receipt.mjs';

const argv = process.argv.slice(2);
cli({
  usage: 'node accept.mjs [--deep] [--film <slug>] [--list [--verbose]] [--fixtures [--fixtures-dir <dir>]]',
  about: '全仓库验收。默认只对账收据（有收据重算输入哈希，变了为红；没收据记「未交付」不计入退出码）；--deep 把所有适用的门真跑一遍。退出码 0 通过 / 1 有红 / 2 用法错',
  opts: {
    film: ['<slug>', '只看一支'],
    'films-dir': ['<dir>', 'films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录'],
    deep: '全跑：内核门 + uses 门 + checks 声明的门',
    list: '只列出会做什么，不执行',
    verbose: '配 --list：打出每道门的真实命令',
    fixtures: '连夹具一起：tests/fixtures/ 下的 _test-*，以及 films/ 里 _ 前缀的（夹具的失败多是设计出来的阴性对照）',
    'fixtures-dir': ['<dir>', '夹具目录，默认 <films 的父目录>/tests/fixtures'],
    'relaunch-every': ['<N>', '--deep 时门 5 每 N 帧取一帧（仍和渲染清单对账）'],
    'gate-timeout': ['<分钟>', '--deep 时每道门的墙钟上限（默认 30，逐帧扫全片的门按帧数放宽）'],
  },
}, argv);
const A = readArgs(argv);
const DEEP = A.has('deep');

const FILMS = locateFilmsDir(A.flag('films-dir', null));
if (!FILMS || !existsSync(FILMS)) {
  console.log(`没找到 films/ 目录（从 ${process.cwd()} 往上找，或 --films-dir / $FILMS_DIR 指定）`);
  process.exit(A.has('list') ? 0 : 2);
}
const FIXDIR = A.flag('fixtures-dir', null) ?? join(dirname(FILMS), 'tests', 'fixtures');
// 每支片子带着自己所在的目录：夹具在 tests/fixtures/，门命令的 --films-dir 跟着它走
const scan = (dir) => (existsSync(dir) ? readdirSync(dir) : []).filter((s) => existsSync(join(dir, s, 'film.json'))).sort().map((slug) => ({ slug, films: dir }));
const only = A.flag('film', null);
const isFixture = (e) => e.films === FIXDIR || e.slug.startsWith('_');
let all;
if (only) {
  all = [FILMS, FIXDIR].filter((dir) => existsSync(join(dir, only, 'film.json'))).slice(0, 1).map((dir) => ({ slug: only, films: dir }));
  if (!all.length) { console.error(`✗ 找不到 ${join(FILMS, only, 'film.json')}（也不在 ${FIXDIR}）`); process.exit(2); }
} else all = [...scan(FILMS), ...(FIXDIR !== FILMS ? scan(FIXDIR) : [])];
const fixtures = only || A.has('fixtures') ? [] : all.filter(isFixture).map((e) => e.slug);
const films = A.has('fixtures') || only ? all : all.filter((e) => !isFixture(e));

const registry = loadGates();
if (registry.errors.length) {
  console.error(`✗ gates.json 有错（门的注册表不可信，先修）：\n  ${registry.errors.join('\n  ')}`);
  if (!A.has('list')) process.exit(1);
}
const W = Math.max(8, ...films.map((e) => e.slug.length));
const show = ([b, a]) => `${b === process.execPath ? 'node' : b} ${a.join(' ')}`;
const gtmo = A.flag('gate-timeout', null) != null ? Number(A.flag('gate-timeout')) : null;
const extraFor = (id) => (id === 'relaunch' && A.flag('relaunch-every', null) ? ['--every', A.flag('relaunch-every')] : []);
const withExtra = (p) => (p.cmd ? [p.cmd[0], [...p.cmd[1], ...extraFor(p.id)]] : null);

// 收据一列
const cellOf = (st) => ({ ok: st.receipt?.via === 'freeze' ? '✓收据·免门' : '✓收据', changed: '✗改过', broken: '✗收据坏', deleted: '✗收据被删', none: '未交付' }[st.state]);

if (A.has('list')) {
  console.log(`films/ = ${FILMS}${A.has('fixtures') ? `\n夹具 = ${FIXDIR}` : ''}\n片子 ${films.length} 支；已安装 skill 的门 ${registry.gates.map((g) => `${g.id}${g.kind === 'kernel' ? '*' : g.kind === 'uses' ? '(uses)' : '(checks)'}`).join(' ') || '（无）'}`);
  console.log('  * = 内核门，永远开；(uses) = 用了那个运行时才开；(checks) = film.json checks 声明了才开\n');
  for (const { slug: s, films: FD } of films) {
    const d = join(FD, s);
    const st = receiptState(d);
    console.log(`${s.padEnd(W)}  ${cellOf(st)}${st.why ? `  ${st.why}` : ''}`);
    if (!DEEP && !A.has('verbose')) continue;
    for (const p of planGates(d, { mode: 'deep', filmsDir: FD, slug: s, registry })) {
      const tag = { run: '跑', na: '–', missing: '✗', pending: '…' }[p.state];
      console.log(`    ${tag} ${p.id.padEnd(12)} ${p.state === 'run' && A.has('verbose') ? show(withExtra(p)) : p.why ?? ''}`);
    }
  }
  if (fixtures.length) console.log(`\n夹具已排除（--fixtures 一起看）：${fixtures.join(' ')}`);
  process.exit(0);
}

if (!films.length) { console.error('films/ 下没有带 film.json 的片子'); process.exit(2); }

let bad = 0, undelivered = 0, quietBad = 0;
const fails = [];
console.log(`全仓库验收  ${films.length} 支片子${DEEP ? '  --deep：门全跑' : '  （收据对账；--deep 全跑门）'}\n`);
for (const { slug: s, films: FD } of films) {
  const d = join(FD, s);
  const st = receiptState(d);
  const delivered = st.state !== 'none';
  if (!delivered) undelivered++;
  if (st.state === 'changed' || st.state === 'broken' || st.state === 'deleted') { bad++; fails.push(`  ${s} · 收据：${st.why}`); }
  let line = `${s.padEnd(W)}  ${cellOf(st).padEnd(8)}`;
  if (!DEEP) {
    const r = st.receipt;
    if (st.state === 'ok') line += `  ${r.deliveredAt?.slice(0, 10) ?? ''}  ${r.via === 'freeze' ? `免门：${r.note ?? ''}` : `门 ${(r.gates ?? []).filter((g) => g.result === 'pass').map((g) => g.id).join(' ')}`}`;
    console.log(line);
    continue;
  }
  // --deep：内核门先跑（seam 写加载记录），再按新记录算 uses 门，最后 checks 门
  const cells = [];
  const run = (p) => {
    if (p.state === 'na') { cells.push(`${p.id}–`); return; }
    if (p.state === 'pending') { cells.push(`${p.id}?`); return; }   // 没有加载记录（内核门没能加载场景，它自己已经红了）
    if (p.state === 'missing') { cells.push(`${p.id}✗`); (delivered ? (bad++, fails) : (quietBad++, fails)).push(`  ${s} · ${p.id}：${p.why}${delivered ? '' : '（未交付，不计入）'}`); return; }
    const r = runGate(withExtra(p), { cwd: process.cwd(), timeoutMs: timeoutOf(p.gate, d, gtmo) });
    cells.push(`${p.id}${r.ok ? '✓' : '✗'}`);
    if (!r.ok) { if (delivered) bad++; else quietBad++; fails.push(`  ${s} · ${p.id}：${r.timedOut ? '超时被杀（门没跑完，不是判了不合格；--gate-timeout 放宽）' : r.tail}${delivered ? '' : '（未交付，不计入）'}`); }
  };
  const first = planGates(d, { mode: 'deep', filmsDir: FD, slug: s, registry });
  for (const p of first.filter((x) => x.kind === 'kernel')) run(p);
  const again = planGates(d, { mode: 'deep', filmsDir: FD, slug: s, registry });   // 内核门跑完，加载记录是新的
  for (const p of again.filter((x) => x.kind !== 'kernel')) run(p);
  console.log(`${line}  ${cells.join(' ')}`);
}

if (fails.length) { console.log('\n不通过：'); fails.forEach((f) => console.log(f)); }
if (fixtures.length) console.log(`\n夹具已排除（它们的失败是设计出来的阴性对照；要一起看用 --fixtures）：${fixtures.join(' ')}`);
console.log(`\n未交付 ${undelivered} 支（没有 receipt.json，不计入退出码；交付用 deliver.mjs）`);
console.log(bad ? `✗ ${bad} 项不通过${quietBad ? `（另有 ${quietBad} 项在未交付的片子上，不计入）` : ''}` : `✓ 通过${quietBad ? `（未交付的片子上有 ${quietBad} 项不通过，不计入）` : ''}`);
process.exit(bad ? 1 : 0);
