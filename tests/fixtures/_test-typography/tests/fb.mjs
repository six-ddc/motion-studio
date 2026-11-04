// 运行：node tests/fixtures/_test-typography/tests/fb.mjs（任意 cwd）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const FILM = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(FILM, '..', '..', '..', 'skills', 'film-core', 'lib');
const { launchBrowser } = await import(join(LIB, 'browser.mjs'));
const { serve } = await import(join(LIB, 'serve.mjs'));
const { port, close } = await serve(FILM, { record: false });
const b = await launchBrowser(); const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/scene.html`); await p.evaluate(() => window.ready);
const r = await p.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 96; c.height = 96; document.body.append(c);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const out = { hasLang: 'lang' in ctx };
  const sig = (font, ch) => { ctx.clearRect(0,0,96,96); ctx.font = font; ctx.fillText(ch, 8, 72); const d = ctx.getImageData(0,0,96,96).data; let h = 0; for (let i=3;i<d.length;i+=4) h = (h*31 + d[i]) >>> 0; return h + ':' + ctx.measureText(ch).width.toFixed(1); };
  for (const lang of ['inherit', 'zh-CN', 'ja']) {
    if ('lang' in ctx) ctx.lang = lang;
    const row = {};
    for (const fb of ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']) row[fb] = sig(`64px "Inter Variable", ${fb}`, '画') ;
    row.notdef = sig('64px "Inter Variable", serif', '￿');
    out[lang] = row;
  }
  return out;
});
console.log(JSON.stringify(r, null, 1)); await b.close(); close();
