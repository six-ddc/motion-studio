#!/usr/bin/env node
// 套件回归测试的统一入口：一条命令跑完散落在各 skill 里的自测、语法冒烟和阴性对照，打一张表，给一个退出码。
//
//   node dev/test.mjs              全部
//   node dev/test.mjs --quick      跳过慢项（test-fixtures.json 里 slow:true 的三维夹具）
//   node dev/test.mjs --syntax     只跑语法冒烟（selfcheck 调的就是这一段）
//   node dev/test.mjs --only <词>  只跑 id 里含这个词的项（如 --only _test-3d、--only selftest）
//   node dev/test.mjs --list       只列出会跑什么
//
// 为什么要有它：阴性对照（tests/fixtures/_test-*/bad-*.html、scene-bad*.html）此前没有任何脚本引用，
// "门能抓到这类违约"只活在 docs/verified/ 的手跑记录里——门的判据哪天被改松了，没人会知道。
// 阴性对照的价值全在"它现在还是红的"，所以要机器每次重跑。
//
// 判红不只看退出码：脚本崩溃（import 写错、参数表改了）也是退出码 1，只看退出码的话，
// 门坏了反而让阴性对照"按期望变红"。所以 red 还要求输出里出现那道门自己的判词（期望表的 match），
// 且没有 Node 侧的崩溃栈。期望表在 test-fixtures.json，加夹具不用改这个文件。
//
// 退出码 0 全部符合期望，1 有不符合的，2 用法错。
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEV = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEV, '..');
const SKILLS = join(ROOT, 'skills');
const FIXTURES = join(ROOT, 'tests', 'fixtures');   // 夹具不在 films/：它们测现行代码，不冻结运行时、不交付
const PY = existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3';

// 子进程：收集 stdout+stderr，不抛异常
function run(bin, args, { cwd = ROOT, timeout = 10 * 60_000, input } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const k = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(k); res({ code: 127, out, err: err + String(e.message), ms: Date.now() - t0, timedOut }); });
    p.on('close', (code) => { clearTimeout(k); res({ code: code ?? 1, out, err, ms: Date.now() - t0, timedOut }); });
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ── 语法冒烟 ──────────────────────────────────────────────────
// skills/、dev/、tests/fixtures/ 下全部 .mjs/.js（node --check）、.py（compile()，不写 __pycache__）、.sh（bash -n）。
// 只证明"能被解析"，不证明能跑；但"改完一个脚本连语法都是坏的"这一类它两秒内抓完。
export async function syntaxSmoke() {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'out', '__pycache__', '.git'].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(mjs|cjs|js|py|sh)$/.test(e.name)) files.push(p);
  } };
  walk(SKILLS); walk(DEV); if (existsSync(FIXTURES)) walk(FIXTURES);   // 夹具里的小脚本（tests/*.mjs、node-vs-browser.mjs……）也要能解析
  const rel = (p) => relative(ROOT, p);
  const res = [];
  const js = files.filter((f) => /\.(mjs|cjs|js)$/.test(f));
  const jsr = await pool(js, Math.max(2, cpus().length), (f) => run(process.execPath, ['--check', f]));
  const jsBad = js.map((f, i) => [f, jsr[i]]).filter(([, r]) => r.code !== 0);
  res.push({ id: `syntax/js (${js.length})`, ok: !jsBad.length, expect: 'node --check 全过',
    got: jsBad.length ? `${jsBad.length} 个坏：${jsBad.map(([f, r]) => `${rel(f)} ${(r.err.split('\n').find((l) => /Error/.test(l)) ?? '').trim()}`).join('；')}` : '全过',
    ms: jsr.reduce((a, r) => Math.max(a, r.ms), 0) });
  const py = files.filter((f) => f.endsWith('.py'));
  if (py.length) {
    const code = 'import sys,json\nbad=[]\nfor f in sys.argv[1:]:\n  try: compile(open(f,"rb").read(), f, "exec")\n  except SyntaxError as e: bad.append(f"{f}:{e.lineno} {e.msg}")\nprint(json.dumps(bad))';
    const r = await run(PY, ['-c', code, ...py]);
    let bad; try { bad = JSON.parse(r.out.trim().split('\n').pop()); } catch { bad = [`解释器没跑起来（${PY}）：${(r.err || r.out).trim().split('\n').pop()}`]; }
    res.push({ id: `syntax/py (${py.length})`, ok: !bad.length, expect: 'compile() 全过', got: bad.length ? bad.map((b) => b.replace(ROOT + '/', '')).join('；') : '全过', ms: r.ms });
  }
  const sh = files.filter((f) => f.endsWith('.sh'));
  if (sh.length) {
    const shr = await pool(sh, 4, (f) => run('bash', ['-n', f]));
    const bad = sh.map((f, i) => [f, shr[i]]).filter(([, r]) => r.code !== 0);
    res.push({ id: `syntax/sh (${sh.length})`, ok: !bad.length, expect: 'bash -n 全过', got: bad.length ? bad.map(([f, r]) => `${rel(f)} ${r.err.trim().split('\n')[0]}`).join('；') : '全过', ms: shr.reduce((a, r) => Math.max(a, r.ms), 0) });
  }
  return res;
}

// ── 各 skill 自带的回归测试 ────────────────────────────────────
const UNITS = [
  { id: 'unit/film-story selftest', why: 'factcheck 的红/绿用例（含幽灵堵车真实 facts.md 变体）',
    async go() {
      const dir = join(ROOT, 'out', 'test', 'research-selftest');   // 仓库根 out/ 已忽略；用例留着，失败时进去看
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const a = [join(DEV, 'film-story/selftest.mjs'), '--dir', dir];
      if (existsSync(join(ROOT, 'films/ghost-jam/docs/facts.md'))) a.push('--ghost-jam', join(ROOT, 'films/ghost-jam'));
      const r = await run(process.execPath, a);
      const tail = (r.out + r.err).trim().split('\n').filter((l) => /通过|FAIL|失败/.test(l)).pop() ?? '';
      return { ok: r.code === 0, expect: 'exit 0', got: `exit ${r.code}  ${tail.slice(0, 60)}`, r };
    } },
  { id: 'unit/film-narration align.py --selftest', why: '数字/标点归一 + 与 factcheck 的交叉校验',
    async go() {
      const r = await run(PY, [join(SKILLS, 'film-narration/scripts/align.py'), '--selftest']);
      const tail = (r.out + r.err).trim().split('\n').filter((l) => /通过|一致|失败/.test(l)).slice(0, 2).join(' / ');
      return { ok: r.code === 0, expect: 'exit 0', got: `exit ${r.code}  ${tail.slice(0, 70)}`, r };
    } },
  { id: 'unit/_test-typography tests/unit.mjs', why: 'text.js 的字体加载报错（拼错族名、缺字）与断行',
    async go() {
      const r = await run(process.execPath, [join(FIXTURES, '_test-typography/tests/unit.mjs')]);
      let j = null; try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch {}
      // 脚本只打印不断言；这里断言三条不依赖字体细节的：正确族名能加载，拼错族名、缺字都报错
      const ok = r.code === 0 && j && j.good === 'ok' && j.typo !== 'ok' && j.missingGlyph !== 'ok';
      const got = r.code !== 0 ? `exit ${r.code}  ${(r.err.split('\n').find((l) => /Error/.test(l)) ?? '').trim().slice(0, 80)}`
        : !j ? '输出不是 JSON' : `good=${j.good} typo=${j.typo === 'ok' ? 'ok(应报错)' : '报错'} 缺字=${j.missingGlyph === 'ok' ? 'ok(应报错)' : '报错'}`;
      return { ok, expect: 'exit 0；good 能加载，拼错/缺字报错', got, r };
    } },
  { id: 'unit/film-core content.json 变体', why: 'content.js 校验与合并的阴/阳性对照 + render --matrix 端到端（跨变体复用分片、清单、未接 content.js 报错）',
    async go() {
      const r = await run(process.execPath, [join(DEV, 'test-content.mjs')]);
      const tail = (r.out + r.err).trim().split('\n').filter((l) => /^✗|自测通过|项失败/.test(l)).slice(0, 2).join(' / ');
      return { ok: r.code === 0, expect: 'exit 0', got: `exit ${r.code}  ${tail.slice(0, 80)}`, r };
    } },
];

// ── 阴性 / 阳性对照 ───────────────────────────────────────────
const CRASH = /\n\s+at .*(file:\/\/|node:internal)|Traceback \(most recent call last\)/;
function fixtureCases() {
  const spec = JSON.parse(readFileSync(join(DEV, 'test-fixtures.json'), 'utf-8'));
  return spec.cases.map((c) => {
    const [bin, script] = spec.gates[c.gate] ?? [];
    if (!bin) throw new Error(`test-fixtures.json：未知的门 ${c.gate}`);
    // dir：夹具在 tests/fixtures/ 下的子目录（如 _test-storyboard，里面每个子目录是一支"片子"）；entry 可省（不看入口页的门）
    const fdir = join(FIXTURES, c.dir ?? '');
    const where = [c.dir, c.film, c.entry].filter(Boolean).join('/');
    const id = `${c.expect === 'red' ? 'neg' : 'pos'}/${where} · ${c.gate}${c.args?.length ? ' ' + c.args.join(' ') : ''}`;
    return { id, slow: !!c.slow, why: c.why ?? '', source: c.source,
      async go() {
        if (!existsSync(join(fdir, c.film, c.entry ?? 'film.json'))) return { ok: false, expect: c.expect, got: `夹具不存在：tests/fixtures/${where}` };
        const exe = bin === 'node' ? process.execPath : bin === 'python' ? PY : bin;
        const r = await run(exe, [join(SKILLS, script), '--films-dir', fdir, '--film', c.film, ...(c.entry ? ['--entry', c.entry] : []), ...(c.args ?? [])]);
        const text = r.out + r.err;
        const missing = (c.match ?? []).filter((m) => !new RegExp(m).test(text));
        const present = (c.absent ?? []).filter((m) => new RegExp(m).test(text));
        const crashed = CRASH.test(text);
        let ok, got;
        if (r.timedOut) { ok = false; got = '超时被杀'; }
        else if (crashed) { ok = false; got = `exit ${r.code}，脚本崩溃（不是门判的）：${(text.split('\n').find((l) => /Error/.test(l)) ?? '').trim().slice(0, 90)}`; }
        else if (c.expect === 'red') {
          const wrongCode = c.code != null && r.code !== c.code;   // code：期望的确切退出码（区分"判红"1 和"输入不全"2）
          ok = r.code !== 0 && !wrongCode && !missing.length && !present.length;
          got = r.code === 0 ? 'exit 0（门没抓到！）' : `exit ${r.code}${wrongCode ? `（期望 ${c.code}）` : ''}${missing.length ? `，缺判词 ${missing.join(' | ')}` : ''}${present.length ? `，多出 ${present.join(' | ')}` : ''}`;
        } else {
          ok = r.code === 0 && !missing.length;
          got = `exit ${r.code}${missing.length ? `，缺 ${missing.join(' | ')}` : ''}`;
          if (r.code !== 0) got += `：${(text.split('\n').find((l) => /✗|FAIL/.test(l)) ?? '').trim().slice(0, 80)}`;
        }
        return { ok, expect: c.expect === 'red' ? `exit ${c.code ?? '≠0'} + 判词` : 'exit 0', got, r };
      } };
  });
}

// ── 主程序 ────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  const VALUED = new Set(['--only']);
  const FLAGS = new Set(['--quick', '--syntax', '--list', '--verbose', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) { if (argv[i + 1] == null) { console.error(`test: ${argv[i]} 要一个值`); process.exit(2); } i++; continue; }
    if (!FLAGS.has(argv[i])) { console.error(`test: 未知参数 ${argv[i]}（--help 看用法）`); process.exit(2); }
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(2, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  const QUICK = argv.includes('--quick'), ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

  let items = [];
  if (!argv.includes('--syntax')) items = [...UNITS, ...fixtureCases()];
  const skipped = items.filter((t) => QUICK && t.slow);
  items = items.filter((t) => !(QUICK && t.slow)).filter((t) => !ONLY || t.id.includes(ONLY));
  const withSyntax = !ONLY || 'syntax'.includes(ONLY) || ONLY.startsWith('syntax');

  if (argv.includes('--list')) {
    if (withSyntax) console.log('  syntax/js · syntax/py · syntax/sh');
    for (const t of items) console.log(`  ${t.id}${t.slow ? '  (slow)' : ''}${t.why ? `  — ${t.why}` : ''}`);
    if (skipped.length) console.log(`\n--quick 跳过：${skipped.map((t) => t.id).join('、')}`);
    process.exit(0);
  }

  const rows = [];
  const t0 = Date.now();
  if (withSyntax) rows.push(...(await syntaxSmoke()));
  // 夹具顺序跑：都要起浏览器，并发会让慢的那几支互相抢 CPU、计时失真
  for (const t of items) {
    process.stderr.write(`  … ${t.id}\r`);
    const r = await t.go();
    rows.push({ id: t.id, ok: r.ok, expect: r.expect, got: r.got, ms: r.r?.ms ?? 0, detail: r.ok ? null : r.r, source: t.source });
    process.stderr.write(' '.repeat(Math.min(120, t.id.length + 6)) + '\r');
  }

  // 按显示宽度对齐（中文占两格），不然期望一列和实际一列粘在一起
  const width = (x) => [...String(x)].reduce((a, ch) => a + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
  const pad = (x, n) => String(x) + ' '.repeat(Math.max(1, n - width(x)));
  const W = Math.min(64, Math.max(...rows.map((r) => width(r.id))) + 2);
  const E = Math.max(...rows.map((r) => width(r.expect))) + 2;
  console.log(`套件回归测试  ${rows.length} 项${QUICK ? '（--quick）' : ''}\n`);
  console.log(`   ${pad('项', W)}${pad('期望', E)}实际`);
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'}  ${pad(r.id, W)}${pad(r.expect, E)}${r.got}${r.ms > 3000 ? `  (${(r.ms / 1000).toFixed(0)}s)` : ''}`);
  const bad = rows.filter((r) => !r.ok);
  if (skipped.length) console.log(`\n--quick 跳过 ${skipped.length} 项慢的：${skipped.map((t) => t.id.split(' · ')[0]).join('  ')}`);
  if (bad.length && argv.includes('--verbose')) for (const r of bad) if (r.detail) {
    console.log(`\n── ${r.id}${r.source ? `（期望出处：${r.source}）` : ''}\n${(r.detail.out + r.detail.err).trim().split('\n').slice(-25).join('\n')}`);
  }
  console.log(`\n${bad.length ? `✗ ${bad.length} 项不符合期望${argv.includes('--verbose') ? '' : '（--verbose 看输出尾部）'}` : '✓ 全部符合期望'}   ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(bad.length ? 1 : 0);
}
