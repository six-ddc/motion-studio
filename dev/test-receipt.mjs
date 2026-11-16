#!/usr/bin/env node
// 收据输入范围的阴性/阳性对照（film-core lib/receipt.mjs 的 NOT_INPUT）。
//   阳性：交付后改 docs/PROGRESS.md、docs/review_log.md、look/ 下的比稿页 → 仍是 ok
//   阴性：改 scene.html、docs/style_guide.md（门会读它）→ changed，且说出改了哪个文件
//   旧收据（files 里还含工作笔记）：改笔记仍 ok，改输入仍 changed；手改过 files 清单 → changed
// 不起浏览器、不渲染，只在临时目录里造一支假片子。birthday 交付后记一笔笔记就让 accept 变红，为此重跑了一遍 25 分钟的 deliver。
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptInputs, receiptState, writeReceipt, NOT_INPUT } from '../skills/film-core/lib/receipt.mjs';

const root = mkdtempSync(join(tmpdir(), 'receipt-test-'));
let failed = 0;
const check = (name, got, want, extra = '') => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}：${got}${ok ? '' : `（期望 ${want}）`}${extra ? '  ' + extra : ''}`);
};

function film(name) {
  const d = join(root, name);
  mkdirSync(join(d, 'docs'), { recursive: true }); mkdirSync(join(d, 'look'), { recursive: true });
  writeFileSync(join(d, 'film.json'), JSON.stringify({ format: '9x16' }));
  writeFileSync(join(d, 'scene.html'), '<canvas id="stage"></canvas>');
  writeFileSync(join(d, 'docs/style_guide.md'), '# law\n');
  writeFileSync(join(d, 'docs/PROGRESS.md'), '# progress\n');
  writeFileSync(join(d, 'docs/review_log.md'), '# log\n');
  writeFileSync(join(d, 'look/a.html'), '<p>a</p>');
  return d;
}
const deliver = (d, inputs) => writeReceipt(d, { schema: 1, slug: 'x', inputs: inputs ?? receiptInputs(d) });

try {
  // 新收据
  const a = film('new');
  deliver(a);
  const files = Object.keys(receiptInputs(a).files);
  check('新收据不含工作笔记', NOT_INPUT.some((x) => files.some((f) => (x.endsWith('/') ? f.startsWith(x) : f === x))), false, files.join(' '));
  appendFileSync(join(a, 'docs/PROGRESS.md'), '- 交付后记一笔\n');
  appendFileSync(join(a, 'docs/review_log.md'), '- 第 N 轮\n');
  writeFileSync(join(a, 'look/b.html'), '<p>b</p>');
  check('改笔记 / 加比稿页之后', receiptState(a).state, 'ok');
  appendFileSync(join(a, 'docs/style_guide.md'), '- 新法律\n');
  const s1 = receiptState(a);
  check('改 style_guide 之后', s1.state, 'changed', s1.why);

  // 旧收据：files 里含笔记（NOT_INPUT 之前写的，例如 reuleaux）
  const b = film('old');
  const all = receiptInputs(b);
  const withNotes = { ...all.files, 'docs/PROGRESS.md': 'aa', 'docs/review_log.md': 'bb', 'look/a.html': 'cc' };
  const { createHash } = await import('node:crypto');
  const sorted = Object.fromEntries(Object.entries(withNotes).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  const h = createHash('sha256'); for (const [r, s] of Object.entries(sorted)) h.update(`${r}\0${s}\0`);
  deliver(b, { algo: 'sha256', digest: h.digest('hex'), files: sorted });
  check('旧收据 + 笔记和当时不同', receiptState(b).state, 'ok');
  writeFileSync(join(b, 'scene.html'), '<canvas id="stage"></canvas><!-- 改 -->');
  const s2 = receiptState(b);
  check('旧收据 + 改 scene.html', s2.state, 'changed', s2.why);

  // 手改收据：files 清单与 digest 对不上 → 不走旧收据的宽松口径
  const c = film('forged');
  const good = receiptInputs(c);
  deliver(c, { ...good, files: { ...good.files, 'docs/review_log.md': 'zz' }, digest: 'f'.repeat(64) });
  check('收据 digest 被手改', receiptState(c).state, 'changed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `✗ ${failed} 项失败` : '✓ 收据输入范围 全部通过');
process.exit(failed ? 1 : 0);
