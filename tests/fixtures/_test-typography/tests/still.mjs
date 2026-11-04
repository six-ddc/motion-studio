// 运行：node tests/fixtures/_test-typography/tests/still.mjs（任意 cwd）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const FILM = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(FILM, '..', '..', '..', 'skills', 'film-core', 'lib');
const { launchBrowser } = await import(join(LIB, 'browser.mjs'));
const { serve } = await import(join(LIB, 'serve.mjs'));
const { port, close } = await serve(FILM, { record: false });
const b = await launchBrowser(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.goto(`http://127.0.0.1:${port}/scene.html?format=9x16`); await p.evaluate(() => window.ready);
await p.evaluate(() => window.seek(2.8));
await p.locator('#stage').screenshot({ path: join(FILM, 'out', 'still-2.8.png') });
await b.close(); close();
