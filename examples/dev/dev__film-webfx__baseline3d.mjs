#!/usr/bin/env node
// 旧三维后期链的像素基线：_test-3d 9x16 四帧（0 / 0.8 / 3.4 / 6.6 s）PNG 的 SHA-256。
// PNG 字节依赖机器与浏览器构建，所以基线存成本机文件：改 post3d / stage3d / particles3d 之前 --save，之后 --against，四帧必须逐字节相同。
//   node dev/film-webfx/baseline3d.mjs --save <json>
//   node dev/film-webfx/baseline3d.mjs --against <json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveFilm } from '../../skills/film-core/lib/film.mjs';
import { openScene, launchBrowser } from '../../skills/film-core/lib/browser.mjs';

const TIMES = [0, 0.8, 3.4, 6.6];
const args = process.argv.slice(2);
const val = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
if (args.includes('--help')) { console.log('node dev/film-webfx/baseline3d.mjs --save <json> | --against <json>'); process.exit(0); }
for (const a of args) if (a.startsWith('--') && !['--save', '--against'].includes(a)) { console.error(`未知参数 ${a}`); process.exit(2); }
const save = val('--save'), against = val('--against');
if (!save === !against) { console.error('要 --save <json> 或 --against <json> 二选一'); process.exit(2); }
const F = resolveFilm(fileURLToPath(new URL('../../tests/fixtures/_test-3d', import.meta.url)));
const b = await launchBrowser();
const got = {};
let errors = [];
try {
  const s = await openScene(F, '9x16', { browser: b, record: false, png: 'default' });
  try { for (const t of TIMES) got[t] = createHash('sha256').update(await s.shot(t)).digest('hex'); errors = s.errors; }
  finally { await s.close(); }
} finally { await b.close(); }
if (errors.length) { console.log('✗ 页面报错', errors); process.exit(1); }
if (save) { writeFileSync(save, JSON.stringify(got, null, 1)); for (const t of TIMES) console.log(`t=${t} ${got[t]}`); console.log(`✓ 基线写入 ${save}`); process.exit(0); }
const want = JSON.parse(readFileSync(against, 'utf8'));
let bad = 0;
for (const t of TIMES) { const ok = got[t] === want[t]; if (!ok) bad++; console.log(`${ok ? '✓' : '✗'} t=${t} ${got[t]}`); }
console.log(bad ? `✗ ${bad} 帧与基线不同` : '✓ 四帧与基线逐字节相同');
process.exit(bad ? 1 : 0);
