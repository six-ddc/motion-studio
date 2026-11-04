// 在真实浏览器里加载 scene.html，读 window.DURATION / window.MARKS（不经任何 Node 侧重算）
// 用法（仓库根）: node tests/fixtures/_test-narration/formant/marks.mjs films/<slug>
import { serve } from '../../../../skills/film-core/lib/serve.mjs';
import { launchBrowser } from '../../../../skills/film-core/lib/browser.mjs';
const dir = process.argv[2];
const { port, close } = await serve(dir, { record: false });
const b = await launchBrowser();
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/scene.html`);
await p.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const r = await p.evaluate(() => ({ DURATION: window.DURATION, MARKS: window.MARKS }));
console.log(JSON.stringify(r));
await b.close(); close();
