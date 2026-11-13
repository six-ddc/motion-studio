// _test-events 在真浏览器里按不同帧率打开：内核注入的 window.FILM 与这次的 fps 一致、只读，
// 场景不写死帧率时（snapToFrames / holdFrames 读 FILM.fps）每个闪白在这个帧率下至少亮 2 帧、峰值帧画面确实变亮。
// 运行：node tests/fixtures/_test-events/tests/browser.mjs
import { fileURLToPath } from 'node:url';
import { resolveFilm } from '../../../../skills/film-core/lib/film.mjs';
import { openScene, launchBrowser } from '../../../../skills/film-core/lib/browser.mjs';

const F = resolveFilm(fileURLToPath(new URL('..', import.meta.url)));
const b = await launchBrowser();
let pass = 0, failN = 0;
const ok = (c, msg, extra = '') => { if (c) pass++; else failN++; console.log(`${c ? '✓' : '✗'} ${msg} ${extra}`); };
try {
  for (const fps of [24, 30, 60]) {
    const S = await openScene(F, '9x16', { browser: b, fps, record: false });
    try {
      const r = await S.page.evaluate((fps) => {
        const g = window.FILM;
        let frozen = Object.isFrozen(g);
        try { window.FILM = { fps: 1 }; } catch {}
        try { g.fps = 1; } catch {}
        frozen = frozen && window.FILM === g && g.fps === fps;
        const X = window.__eventsFixture;
        // 每个闪白事件：数第 K 帧（t = K/fps）上 flash > 0 的帧数
        const lit = X.flashTimes.map((te) => { let c = 0; for (let K = Math.floor(te * fps) - 2; K < te * fps + 12; K++) if (X.flash(K / fps) > 0) c++; return c; });
        return { g: { ...g }, frozen, alignedFps: X.fps, lit, times: X.flashTimes };
      }, fps);
      ok(r.g.fps === fps && r.g.width === S.width && r.g.height === S.height && r.g.format === '9x16' && r.frozen,
        `fps=${fps}：window.FILM = ${JSON.stringify(r.g)}，只读（赋值无效）`);
      ok(r.alignedFps === fps && Math.min(...r.lit) >= 2, `fps=${fps}：场景按 FILM.fps 对齐；${r.lit.length} 个闪白每个至少 2 帧（最少 ${Math.min(...r.lit)}）`);
      // 画面：第一个闪白的峰值帧与它前一帧，左上角像素亮度
      const K = Math.round(r.times[0] * fps);
      const lum = async (t) => { await S.advance(t); return S.page.evaluate(() => { const d = document.getElementById('stage').getContext('2d').getImageData(4, 4, 1, 1).data; return d[0] + d[1] + d[2]; }); };
      const before = await lum((K - 1) / fps), peak = await lum(K / fps), next = await lum((K + 1) / fps);
      ok(peak > before + 300 && next > before, `fps=${fps}：闪白峰值帧真的变亮（前一帧 ${before} → 峰值 ${peak} → 下一帧 ${next}）`);
    } finally { await S.close(); }
  }
} finally { await b.close(); }
console.log(`\nevents 浏览器：${pass} 通过，${failN} 失败`);
process.exit(failN ? 1 : 0);
