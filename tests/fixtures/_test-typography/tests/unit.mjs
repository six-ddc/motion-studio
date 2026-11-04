// 运行：node tests/fixtures/_test-typography/tests/unit.mjs（任意 cwd；路径按本文件位置算，服务器与浏览器走 film-core lib）
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
  const T = await import('./runtime/text.js');
  const out = {};
  const tryLoad = async (specs) => { try { await T.loadFonts(specs); return 'ok'; } catch (e) { return e.message.split('\n').slice(1).join(' | '); } };
  out.good = await tryLoad([['400 40px "Noto Sans SC Variable"', '画面必须']]);
  out.typo = await tryLoad([['400 40px "Noto Sans SC Varable"', '画面']]);
  out.missingGlyph = await tryLoad([['400 40px "Noto Sans SC Variable"', '画面龘']]);
  out.latinInCJK = await tryLoad([['400 40px "Inter Variable"', 'Motion画']]);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '400 40px "Noto Sans SC Variable"';
  out.wrap1 = T.wrapCJK(ctx, '一二三四五，六七', 200);       // 5 字一行，逗号不能行首
  out.wrap2 = T.wrapCJK(ctx, '一二三四「五六七', 200);       // 「 不能行尾
  out.wrap3 = T.wrapCJK(ctx, '一二三seek(t)四五', 200);
  out.wrap4 = T.wrapCJK(ctx, '一二三四五。」六', 200);       // 连续两个避头
  const lay = T.layoutCJK(ctx, '「好」，。啊', 40, { punct: 'adjacent' });
  out.layAdjacent = lay.map((g) => g.ch + '@' + g.x).join(' ') + ' total=' + lay.totalWidth;
  out.layNone = T.layoutCJK(ctx, '「好」，。啊', 40, { punct: 'none' }).totalWidth;
  out.layHalf = T.layoutCJK(ctx, '「好」，。啊', 40, { punct: 'half' }).totalWidth;
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close(); close();
