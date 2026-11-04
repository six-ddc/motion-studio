// 运行：node tests/fixtures/_test-narration/seamcheck-lite.mjs（任意 cwd）
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../../skills/film-core/lib/browser.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
const { port, close } = await serve(ROOT, { record: false });
const b = await launchBrowser(); const page = await b.newPage({ viewport: { width: 1080, height: 1920 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/scene.html`);
await page.waitForFunction(() => typeof window.seek === 'function', null, { timeout: 15000 });
const D = await page.evaluate(() => window.DURATION);
const md5 = (x) => createHash('md5').update(x).digest('hex');
const shot = async (t) => { await page.evaluate((x) => window.seek(x), t); return md5(await page.locator('#stage').screenshot()); };
const ts = [0, 2.4, 4.7, 8.6, 9.0, 13.8, D - 0.01];
let ok1 = true; for (const t of ts) { if ((await shot(t)) !== (await shot(t))) ok1 = false; }
const seq = []; for (const t of ts) seq.push(await shot(t));
const order = [...ts.keys()].sort((a, b) => ((a * 7919) % 11) - ((b * 7919) % 11));
const shuf = []; for (const i of order) shuf[i] = await shot(ts[i]);
const ok2 = seq.every((h, i) => h === shuf[i]);
const cap = await page.evaluate(() => [2.5, 4.8, 8.7, 6.7].map((t) => { const vo = null; return t; }));
await page.evaluate((x) => window.seek(x), 8.7); await page.locator('#stage').screenshot({ path: ROOT + '/out/_still-8.7s.png' });
console.log(JSON.stringify({ duration: D, sameT: ok1, shuffled: ok2, distinctFrames: new Set(seq).size, errors: errs }));
await b.close(); close();
