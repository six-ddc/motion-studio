#!/usr/bin/env node
// 只冻结、不跑门：把这支片子实际加载的、来自套件的运行时（和 film.json kits 声明的 kit 文件）拷进 films/<slug>/runtime/。
//
//   node <film-core>/scripts/freeze.mjs --film <slug>                 开一次场景，按实际加载冻结
//   node <film-core>/scripts/freeze.mjs --film <slug> --from-record   不开浏览器：按渲染清单 + serve 加载记录冻结
//   node <film-core>/scripts/freeze.mjs --film <slug> --dry-run       只列出会拷什么
//   node <film-core>/scripts/freeze.mjs --film <slug> --receipt "<为什么不过门>"   冻结后写一份不过门的收据
//
// 什么时候用：要拿外部 dev server（只会托管片子目录的那种）打开片子时——它不懂挂载表，./runtime/* 必须真的在片子里。
// 交付不要用它：deliver 会先跑门再冻结。冻结之后片内文件优先，套件升级不再影响这支片子（也不再修好它）。
//
// --receipt：给"成片早就渲好、runtime/ 就是当时那一份"的片子补收据，不重渲、不过门。收据里 gates 为空、via = "freeze"、
// 记下你写的理由；accept 把它显示成「✓收据·免门」，和过了门的收据分得开。之后改任何输入，accept 照样报红。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../lib/film.mjs';
import { serve, readRuntimeRecord } from '../lib/serve.mjs';
import { planFreeze, applyFreeze } from '../lib/freeze.mjs';
import { kitsReceipt } from '../lib/kits.mjs';
import { openScene, launchBrowser, filmBackend } from '../lib/browser.mjs';
import { manifestOf } from '../lib/gates.mjs';
import { receiptInputs, writeReceipt, envFingerprint } from '../lib/receipt.mjs';

const args = parseArgs({
  usage: 'node freeze.mjs --film <slug> [--from-record] [--dry-run] [--receipt <理由>]',
  about: '只冻结不跑门：把片子实际加载的、来自套件的运行时拷进 films/<slug>/runtime/（给外部 dev server 用）。退出码 0 成功 / 1 失败 / 2 用法错',
  opts: {
    ...FILM_OPTS,
    'from-record': '不开浏览器，按渲染清单 + serve 加载记录（out/.render/）冻结',
    'dry-run': '只列出会拷什么',
    receipt: ['<理由>', '冻结后写一份不过门的收据（via: freeze），理由写进收据'],
  },
});

await main(async () => {
  const F = resolveFilm(args.film, args);
  const why = args.flag('receipt', null);
  if (args.has('receipt') && !(why && why.trim())) fail('--receipt 要写理由（为什么这支片子不过门就算交付）', 2);

  // 要冻结的清单：[{ name, from, sha256 }]
  let list;
  if (args.has('from-record')) {
    const m = new Map();
    for (const r of manifestOf(F.dir)?.runtime ?? []) m.set(r.name, r);
    for (const [name, r] of Object.entries(readRuntimeRecord(F.dir)?.files ?? {})) if (!m.has(name)) m.set(name, { name, ...r });
    if (!m.size) fail('没有渲染清单也没有 serve 加载记录（out/.render/）：先 render / preview 一次，或去掉 --from-record 让我开一次场景');
    list = [...m.values()];
  } else {
    const srv = await serve(F.dir);
    const browser = await launchBrowser({ backend: filmBackend(F) });
    try {
      const S = await openScene(F, F.config.format, { browser, port: srv.port });
      await S.shot(0);
      await S.close();
    } finally { await browser.close(); srv.close(); }
    list = srv.loaded();
  }

  // 套件运行时与 kit 文件同一条冻结路径（lib/freeze.mjs）；片内已有同名文件就算已冻结（不核对，沿用旧行为）
  let plan;
  try { plan = planFreeze(F.dir, list, { what: '', strict: false }); }
  catch (e) { fail(`${e.message.trim()}${args.has('from-record') ? '。去掉 --from-record 重新按实际加载冻结' : ''}`); }
  const rows = [...plan.todo.map((r) => `${r.name} ← ${r.from}`), ...plan.extra.map((x) => `（${x.why}）`)];
  if (args.has('dry-run')) {
    console.log(rows.length ? `会冻结进 ${F.slug}/runtime/：\n  ${rows.join('\n  ')}` : '没有要冻结的：用到的运行时都已在片内');
    if (plan.have.length) console.log(`已在片内：${plan.have.join(' ')}`);
    return;
  }
  mkdirSync(join(F.dir, 'runtime'), { recursive: true });
  const done = applyFreeze(plan);
  console.log(done.length ? `✓ 冻结进 ${F.slug}/runtime/：\n  ${done.join('\n  ')}` : '✓ 没有要冻结的：用到的运行时都已在片内');

  if (why) {
    const all = list.map((r) => [r.name, { from: r.from, sha256: r.sha256 }]);
    writeReceipt(F.dir, {
      schema: 1, slug: F.slug, deliveredAt: new Date().toISOString(), via: 'freeze', note: why.trim(),
      inputs: receiptInputs(F.dir),
      runtime: Object.fromEntries(all),
      ...(kitsReceipt(F.dir, list, F.raw) ? { kits: kitsReceipt(F.dir, list, F.raw) } : {}),
      render: null, gates: [], checks: F.raw.checks ?? [],
      env: envFingerprint(F.raw.renderer ?? null),
    });
    console.log(`✓ 写了不过门的收据 ${join(F.dir, 'receipt.json')}（accept 显示为「✓收据·免门」）`);
  }
});
