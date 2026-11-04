// 2D canvas ctx.filter='blur(Npx)' 在 1080×1920 下的成本与可重复性。用法: node dev/film-webfx/blur2d-check.mjs
import { cli } from '../../skills/film-core/lib/cli.mjs';
import { launchBrowser } from '../../skills/film-core/lib/browser.mjs';

cli({
  usage: 'node blur2d-check.mjs',
  about: '2D canvas ctx.filter=\'blur(Npx)\' 在 1080×1920 下的成本与可重复性，输出一行 JSON。无参数。',
  opts: {},
});
const b = await launchBrowser(); const p = await b.newPage();
const r = await p.evaluate(() => {
  const W = 1080, H = 1920, mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const src = mk(), s = src.getContext('2d'); s.fillStyle = '#246'; s.fillRect(0, 0, W, H); s.fillStyle = '#fc8'; s.beginPath(); s.arc(540, 900, 300, 0, 7); s.fill();
  const dst = mk(), d = dst.getContext('2d');
  const out = {};
  for (const px of [4, 16, 48]) {
    const ts = []; let h0 = null, same = true;
    for (let i = 0; i < 5; i++) { const a = performance.now(); d.filter = `blur(${px}px)`; d.clearRect(0,0,W,H); d.drawImage(src, 0, 0); d.filter = 'none';
      const data = d.getImageData(0, 0, W, H).data; ts.push(performance.now() - a);
      let h = 0; for (let k = 0; k < data.length; k += 13) h = (h * 31 + data[k]) | 0; if (h0 === null) h0 = h; else if (h !== h0) same = false; }
    out['blur' + px] = { ms_incl_getImageData: +ts.sort((x, y) => x - y)[2].toFixed(1), repeatable: same };
  }
  const g = performance.now(); for (let i = 0; i < 5; i++) d.getImageData(0, 0, W, H); out.getImageData_only_ms = +((performance.now() - g) / 5).toFixed(1);
  return out;
});
console.log(JSON.stringify(r)); await b.close();
