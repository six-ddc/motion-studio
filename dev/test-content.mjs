#!/usr/bin/env node
// content.json 内容数据层的回归测试（dev/test.mjs 的 unit 项调它）：
//   1. 纯函数：校验（变体改 locked 槽位 / 不存在的槽位 / 动画字段 → 报错）、合并顺序、变体 id、矩阵展开、内容哈希不含组合名
//   2. 端到端：临时片子（out/test/content-selftest/，仓库根 out/ 已忽略）render --matrix 两个变体 ×1 秒，
//      核对：页面真按变体合并了（画面不同）、像素相同的分片跨变体复用、清单字段齐、主片基线不被变体覆盖
// 退出码 0 = 全部通过。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContent, resolveContent, parseVariant, expandMatrix } from '../skills/film-core/assets/runtime/content.js';
import { contentHash, validateSlotMeta } from '../skills/film-core/lib/content.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (cond, what) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) fails++; };

// ── 1. 纯函数 ──
const DOC = {
  schema: 1,
  text: { title: { text: '基础', maxChars: 6 }, tag: { text: '锁住', locked: true }, cta: '' },
  assets: { bg: 'assets/bg.png' }, params: { hold: 1 },
  variants: {
    hook: { a: {}, b: { text: { title: '第二版' } } },
    cta: { a: {}, b: { text: { cta: '来' }, params: { hold: 2 } } },
    format: { '9x16': { text: { title: '竖' } } },
  },
  matrix: { product: ['hook', 'cta'], exclude: [{ hook: 'b', cta: 'b' }] },
};
ok(validateContent(DOC).length === 0, '合法文档校验通过');
const bad = (ov, what) => ok(validateContent({ ...DOC, variants: { x: { a: ov } } }).length > 0, `阴性：${what} → 报错`);
bad({ text: { tag: '改' } }, '变体改 locked 槽位');
bad({ text: { titel: '拼错' } }, '变体改不存在的槽位');
bad({ seek: 'x' }, '变体带动画字段');
bad({ params: { speed: 2 } }, '变体改没声明的参数');
ok(validateContent({ ...DOC, claims: [{ text: '数字', source: '' }] }).length > 0, '阴性：claims 没有 source → 报错');
{ // 槽位语义声明（lib/content.mjs validateSlotMeta）：identity 槽位取不到就问、不许编
  const ID = { ...DOC, text: { ...DOC.text, brand: { text: 'Acme', kind: 'identity', description: '本片推广的产品名' } } };
  ok(validateContent(ID).length === 0 && validateSlotMeta(ID).length === 0, 'identity 槽位带 description 与值：两道校验都过（运行时不受新字段影响）');
  const meta = (t, what) => ok(validateSlotMeta({ ...DOC, text: { ...DOC.text, brand: t } }).length > 0, `阴性：${what} → 报错`);
  meta({ text: 'Acme', kind: 'identity' }, 'identity 槽位没写 description');
  meta({ text: '', kind: 'identity', description: '产品名' }, 'identity 槽位值为空（没问到）');
  meta({ text: 'x', kind: 'brand' }, 'kind 不在 content/identity/style 里');
  ok(validateSlotMeta({ ...ID, variants: { hook: { a: { text: { brand: '' } } } } }).length > 0, '阴性：变体把 identity 槽位覆盖成空串 → 报错');
}
ok(parseVariant(DOC, 'cta-b.hook-b').id === 'hook-b.cta-b', '变体 id 按维度声明顺序规范化');
let threw = false; try { parseVariant(DOC, 'hook-c'); } catch { threw = true; }
ok(threw, '阴性：不存在的选项 → 抛错');
const R = resolveContent(DOC, { variant: 'hook-b.cta-b', format: '9x16' });
ok(R.text.title.text === '竖' && R.text.title.maxChars === 6 && R.text.cta.text === '来' && R.params.hold === 2, '合并顺序：基础 → 维度 → format，对象槽位保留字段');
ok(expandMatrix(DOC).map((e) => e.id).join() === 'hook-a.cta-a,hook-a.cta-b,hook-b.cta-a', '矩阵：笛卡尔积 − exclude');
{ // matrix.exclude 校验：拼错的维度/选项、被剥成空对象的条目要报错——不能静默"一个都不排除"或"排除全部"
  const ex = (matrix, re, what) => {
    let m = ''; try { expandMatrix({ ...DOC, matrix }); } catch (e) { m = e.message; }
    ok(re.test(m), `阴性：matrix.exclude ${what} → 报错${m ? `（${m}）` : '（没报错）'}`);
  };
  ex({ product: ['hook', 'cta'], exclude: [{ hok: 'b' }] }, /exclude.*hok/, '拼错维度 {hok:"b"}');
  ex({ product: ['hook', 'cta'], exclude: [{ hook: 'z' }] }, /exclude.*没有选项 z/, '不存在的选项 {hook:"z"}');
  ex({ product: ['hook', 'cta'], exclude: [{ format: '16x9' }] }, /exclude.*format/, '{format:"16x9"}（format 不参与组合）');
  ex({ product: ['hook', 'cta'], exclude: [{}] }, /exclude.*空/, '空条目 {}');
  ex({ product: ['hook'], exclude: [{ cta: 'b' }] }, /exclude.*cta.*product/, '{cta:"b"}（cta 不在 product 里）');
}
{ // 查表不能命中原型链：hook-constructor / toString 这类名字要按"不存在"处理
  let m = ''; try { parseVariant(DOC, 'hook-constructor'); } catch (e) { m = e.message; }
  ok(/没有选项 constructor/.test(m), `阴性：--variant hook-constructor → 报变体不存在${m ? `（${m}）` : '（没报错）'}`);
  m = ''; try { parseVariant(DOC, 'constructor-a'); } catch (e) { m = e.message; }
  ok(/没有维度 constructor/.test(m), `阴性：--variant constructor-a → 报维度不存在${m ? `（${m}）` : '（没报错）'}`);
  ok(validateContent({ ...DOC, variants: { x: { a: { text: { toString: '改' } } } } }).some((e) => /toString/.test(e)), '阴性：变体改 text.toString（原型链上的名字）→ 报错');
}
ok(contentHash(DOC, null, '16x9') === contentHash(DOC, 'hook-a.cta-a', '16x9') && contentHash(DOC, null, '16x9') !== contentHash(DOC, 'hook-b', '16x9'),
  '内容哈希只看内容：空覆盖的组合 = 基础，换文案的不同');

// ── 2. 端到端 ──
const FILMS = join(ROOT, 'out', 'test', 'content-selftest');
rmSync(FILMS, { recursive: true, force: true });
const dir = join(FILMS, 'ctest');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'film.json'), JSON.stringify({ slug: 'ctest', format: '9x16', fps: 10, sub: 1, entry: 'scene.html', formats: null, duration: null, loop: false, checks: [] }));
writeFileSync(join(dir, 'content.json'), JSON.stringify({
  schema: 1, text: { badge: '' },
  variants: { cta: { a: {}, b: { text: { badge: 'B' } } } },
}));
// 前 1 秒两个变体像素相同，第 2 秒 b 多画一块：缓存应复用第 1 片、只为 b 重编第 2 片
writeFileSync(join(dir, 'scene.html'), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>
<canvas id="stage" width="1080" height="1920"></canvas>
<script type="module">
import { loadContent } from './runtime/content.js';
const C = await loadContent();
const g = document.getElementById('stage').getContext('2d');
window.DURATION = 2;
window.seek = (t) => {
  g.fillStyle = '#123'; g.fillRect(0, 0, 1080, 1920);
  g.fillStyle = '#e84'; g.fillRect(100 + t * 300, 800, 200, 200);
  if (t >= 1 && C.text('badge')) { g.fillStyle = '#fff'; g.fillRect(400, 1400, 280, 280); }
};
window.ready = true;
</script>`);
const render = (...a) => spawnSync(process.execPath, [join(ROOT, 'skills/film-core/scripts/render.mjs'), '--film', 'ctest', '--films-dir', FILMS, '--preset', 'ultrafast', '--workers', '2', ...a], { encoding: 'utf8' });
const r0 = render();
ok(r0.status === 0, `主片渲染 exit ${r0.status}${r0.status ? `：${(r0.stderr || r0.stdout).trim().split('\n').pop()}` : ''}`);
const r1 = render('--matrix');
const out1 = (r1.stdout + r1.stderr).replace(/\r/g, '\n');
ok(r1.status === 0, `render --matrix exit ${r1.status}${r1.status ? `：${out1.trim().split('\n').pop()}` : ''}`);
ok(/cta-a[^\n]*\n(?:[^\n]*\n)*?[^\n]*分片：编码 0 \/ 复用 2/.test(out1), 'cta-a（空覆盖）的两片全部复用主片分片');
ok(/分片：编码 1 \/ 复用 1/.test(out1), 'cta-b 只重编像素变了的第 2 片');
const man = existsSync(join(dir, 'out/variants/manifest.json')) ? JSON.parse(readFileSync(join(dir, 'out/variants/manifest.json'), 'utf8')) : null;
const ea = man?.exports?.['cta-a/9x16'], eb = man?.exports?.['cta-b/9x16'];
ok(!!(ea && eb), 'manifest.json 有两个导出');
ok(!!(ea && eb && ea.contentHash !== eb.contentHash && ea.sources?.template === eb.sources?.template && ea.silent?.sha256 && ea.renderer && ea.settings?.fps === 10 && ea.duration === 2),
  '清单字段：内容哈希不同、模板哈希相同、产物哈希/渲染器/设置/时长齐');
ok(ea?.framesDigest !== eb?.framesDigest, '两个变体的逐帧清单不同（页面真的按 ?variant= 合并了）');
ok(existsSync(join(dir, 'out/.render/variants/cta-b/9x16.frames.json')) && JSON.parse(readFileSync(join(dir, 'out/.render/9x16.frames.json'), 'utf8')).key.frames === 20,
  '变体清单另存，主片基线不被覆盖');
const r2 = render('--matrix');
ok(r2.status === 0 && ((r2.stdout.match(/编码 0 \/ 复用 2/g) || []).length === 2), '再渲一遍矩阵：两个变体都全部复用（同一分片两份内容并存，不互相冲掉）');
// 场景不接 content.js 时 --variant 要报错，不能悄悄渲出基础版
writeFileSync(join(dir, 'scene.html'), readFileSync(join(dir, 'scene.html'), 'utf8').replace("const C = await loadContent();", "const C = { text: () => '' };"));
const r3 = render('--variant', 'cta-b');
ok(r3.status !== 0 && /没有按变体 cta-b 加载内容/.test(r3.stderr), '阴性：场景没接 content.js 时 --variant 报错');

// ── 3. render 的预检钩子按画幅查：只有 9x16 的 format 变体把标题撑超 maxChars ──
{
  const pdir = join(FILMS, 'pfmt');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'film.json'), JSON.stringify({ slug: 'pfmt', format: '16x9', fps: 10, sub: 1, entry: 'scene.html', formats: ['16x9', '9x16'], duration: null, loop: false, checks: ['preflight'] }));
  writeFileSync(join(pdir, 'content.json'), JSON.stringify({
    schema: 1, text: { title: { text: '短标题', maxChars: 20 } },
    variants: { format: { '9x16': { text: { title: '这是一个被竖版画幅覆盖得非常非常长的标题，总共四十四个字，远远超出了二十字的上限啊啊啊啊' } } } },
  }));
  writeFileSync(join(pdir, 'scene.html'), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}#stage{width:100vw;height:100vh;background:#123}</style><div id="stage"></div>
<script type="module">window.DURATION = 1; window.seek = () => {}; window.ready = true;</script>`);
  const rp = (...a) => spawnSync(process.execPath, [join(ROOT, 'skills/film-core/scripts/render.mjs'), '--film', 'pfmt', '--films-dir', FILMS, '--preset', 'ultrafast', '--workers', '1', ...a], { encoding: 'utf8' });
  const q9 = rp('--format', '9x16');
  ok(q9.status !== 0 && /预检没过[^\n]*--format 9x16/.test(q9.stderr), `render --format 9x16：钩子按 9x16 预检、判红不渲（exit ${q9.status}）`);
  const q16 = rp('--format', '16x9');
  ok(q16.status === 0, `render --format 16x9：钩子只查 16x9，不被 9x16 的超长标题拦下（exit ${q16.status}${q16.status ? `：${(q16.stderr || q16.stdout).trim().split('\n').pop()}` : ''}）`);
}

// ── 4. new-film --from：--title 里的 $ 原样写入（不能被 replaceAll 当成替换模式）──
{
  const src = join(FILMS, 'nf-src');
  mkdirSync(join(src, 'docs'), { recursive: true });
  writeFileSync(join(src, 'film.json'), JSON.stringify({ slug: 'nf-src', title: '旧片名', format: '9x16', fps: 30, sub: 1, entry: 'scene.html', checks: [] }));
  writeFileSync(join(src, 'scene.html'), '<!doctype html>');
  writeFileSync(join(src, 'docs', 'brief.md'), '# {{title}}\n');
  writeFileSync(join(src, 'docs', 'review_log.md'), '# 旧片名 评审记录\n');
  const r = spawnSync(process.execPath, [join(ROOT, 'skills/film-core/scripts/new-film.mjs'), 'nf-dst', '--from', 'nf-src', '--title', 'A$&B$1', '--films-dir', FILMS], { encoding: 'utf8' });
  const rd = (p) => { try { return readFileSync(join(FILMS, 'nf-dst', p), 'utf8'); } catch { return ''; } };
  ok(r.status === 0 && rd('docs/brief.md') === '# A$&B$1\n' && rd('docs/review_log.md').startsWith('# A$&B$1 评审记录'),
    `new-film --from --title 'A$&B$1'：占位与 review_log 标题原样写入（brief「${rd('docs/brief.md').trim()}」 log「${rd('docs/review_log.md').split('\n')[0]}」）`);
}

// ── 5. kit.json exports 规范化：./a.js、sub/../sub/b.js 与请求同一口径；越出 kit 目录的拒收 ──
{
  const { loadKit, locateKitFile } = await import('../skills/film-core/lib/kits.mjs');
  const kroot = join(FILMS, 'kits');
  const mk = (name, exports, files) => {
    mkdirSync(join(kroot, name), { recursive: true });
    for (const f of files) { mkdirSync(dirname(join(kroot, name, f)), { recursive: true }); writeFileSync(join(kroot, name, f), 'export {};\n'); }
    writeFileSync(join(kroot, name, 'kit.json'), JSON.stringify({ schema: 1, name, version: '1.0.0', exports }));
  };
  mk('norm', ['./a.js', 'sub/../sub/b.js'], ['a.js', 'sub/b.js']);
  writeFileSync(join(kroot, 'x.js'), 'export {};\n');
  mk('esc', ['../x.js'], []);
  let kit = null, m = '';
  try { kit = loadKit(kroot, 'norm'); } catch (e) { m = e.message; }
  ok(kit && [...kit.exports.keys()].sort().join() === 'a.js,sub/b.js', `kit exports 规范化成 a.js / sub/b.js（${kit ? [...kit.exports.keys()].join(' ') : m}）`);
  const fk = { names: ['norm'], kits: new Map(kit ? [['norm', kit]] : []) };
  ok(!!kit && !!locateKitFile(fk, 'kits/norm/a.js').path && !!locateKitFile(fk, 'kits/norm/./a.js').path && !!locateKitFile(fk, 'kits/norm/sub/x/../b.js').path,
    '请求侧同一规范化：kits/norm/a.js、./a.js、sub/x/../b.js 都命中');
  ok(!!kit && !!locateKitFile(fk, 'kits/norm/../esc/x.js').error, '阴性：请求越出 kit 目录 → 不伺服');
  m = ''; try { loadKit(kroot, 'esc'); } catch (e) { m = e.message; }
  ok(/\.\.\/x\.js/.test(m), `阴性：exports 里 ../x.js（越出 kit 目录）→ 校验报错${m ? '' : '（没报错）'}`);
}

console.log(fails ? `\n✗ ${fails} 项失败` : '\n自测通过');
process.exit(fails ? 1 : 0);
