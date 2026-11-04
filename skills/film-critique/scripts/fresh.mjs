// 派生品新鲜度：列出 out/ 下 critique 派生品（stills / transitions / contact / strip / phone / poster / checks.json）
// 是不是基于现在的场景与成片。**只提示，不拦**：默认 exit 0；--strict 时有过期的 exit 1。
//
// 它测的量 vs 你可能以为它测的量（详见 _fresh.mjs 头注释）：
//   测的是：产物旁 <产物>.meta.json 记下的场景输入 md5（除 out/ docs/ tools/）与现在逐文件比；contact 类再比源 MP4 大小与 mtime。
//   不是：  "画面变没变"（改注释也判过期），也不是"MP4 是不是最新场景渲的"（那归 film-core accept / 收据）。
//   没有 meta 的产物（旧版工具产出）报"未知"，不当成新鲜。
//
// 用法:
//   node <film-critique>/scripts/fresh.mjs --film <slug> [--strict]
//   node <film-critique>/scripts/fresh.mjs --film <slug> --selftest   阴性/阳性对照：把片子拷到临时目录，改入口、改 MP4，看它报不报过期
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { args, resolveFilm, FILM_OPTS } from './_film.mjs';
import { scanProducts, describeFreshness, writeMeta, checkProduct } from './_fresh.mjs';

const { has, flag } = args({
  usage: 'node fresh.mjs --film <slug> [--strict] [--selftest]',
  about: '派生品新鲜度：out/ 下 stills / transitions / contact / strip / phone / checks.json 是否基于现在的场景与成片。只提示不拦（--strict 才 exit 1）。',
  opts: { ...FILM_OPTS, entry: ['<x.html>', '（不用：新鲜度按整个片子目录算，与入口无关；收下只为与其它脚本同一参数表）'],
    strict: '有过期的派生品时 exit 1', selftest: '对照自测：临时拷贝片子，验证"没改 → 新鲜、改了入口 / 重写了 MP4 → 过期、没 meta → 未知"' },
});
const F = resolveFilm(flag('film'));

if (has('selftest')) {
  const tmp = mkdtempSync(join(tmpdir(), 'film-fresh-'));
  const dir = join(tmp, F.slug);
  cpSync(F.dir, dir, { recursive: true, filter: (p) => !p.startsWith(join(F.dir, 'out')) });
  const product = join(tmp, 'p.png'), contactP = join(tmp, 'c.png'), mp4 = join(tmp, 'x.mp4'), orphan = join(tmp, 'old.png');
  for (const f of [product, contactP, mp4, orphan]) writeFileSync(f, 'x');
  writeMeta(product, { tool: 'selftest', dir, entry: F.config.entry });
  writeMeta(contactP, { tool: 'selftest', dir, mp4 });
  const results = [];
  const expect = (what, got, want, note) => { const ok = got.status === want; results.push(ok);
    console.log(`  ${ok ? '✓' : '✗'} ${what}：判${{ fresh: '新鲜', stale: '过期', nometa: '未知' }[got.status]}（期望${{ fresh: '新鲜', stale: '过期', nometa: '未知' }[want]}）${got.reasons.length ? ' —— ' + got.reasons.join('；') : ''}${note ? ` ${note}` : ''}`); };
  expect('阳性对照：什么都没改', checkProduct(product, dir), 'fresh');
  expect('阴性对照：没有 meta', checkProduct(orphan, dir), 'nometa');
  const entry = join(dir, F.config.entry), before = readFileSync(entry, 'utf8');
  appendFileSync(entry, '\n<!-- fresh selftest -->\n');
  const st = checkProduct(product, dir);
  expect('阴性对照：改了入口页', st, 'stale');
  if (!st.reasons.join('').includes(F.config.entry)) { results.push(false); console.log(`  ✗ 过期原因没点名 ${F.config.entry}`); }
  writeFileSync(entry, before);
  expect('阳性对照：改回原样', checkProduct(product, dir), 'fresh', '（按内容比，不按 mtime）');
  writeFileSync(mp4, 'xy'); utimesSync(mp4, new Date(), new Date(Date.now() + 5000));
  expect('阴性对照：源 MP4 被重写', checkProduct(contactP, dir), 'stale');
  rmSync(tmp, { recursive: true, force: true });
  const ok = results.every(Boolean);
  console.log(ok ? `自测通过：${results.length} 项对照全部符合期望` : '✗ 自测失败：新鲜度判据和期望不符');
  process.exit(ok ? 0 : 1);
}

const list = scanProducts(F);
if (!list.length) { console.log(`${F.out} 下没有 critique 派生品。`); process.exit(0); }
describeFreshness(list).forEach((l) => console.log(l));
const stale = list.filter((x) => x.status === 'stale').length, unknown = list.filter((x) => x.status === 'nometa').length;
console.log(`\n${list.length} 个派生品：过期 ${stale}、未知 ${unknown}。${stale ? '过期的图是旧时间轴的，重跑对应工具（stills.mjs / transitions.mjs / contact.sh / check.mjs）后再评。' : ''}`);
process.exit(stale && has('strict') ? 1 : 0);
