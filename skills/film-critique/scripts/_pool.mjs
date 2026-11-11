// check.mjs 的并行抽样：多个场景页面（分布在几个浏览器进程上）同时 seek + 截图 + 量。
//
// 为什么能并行：seek(t) 是 t 的纯函数，帧与帧之间零依赖——film-core 的 render.mjs 就是靠这一条
// 把 7507 帧切给 8 个 worker 的。拓扑照抄它：W 个 worker、每个浏览器 P 个页面（默认 2，
// SwiftShader 的 GPU 进程是按浏览器算的，一个浏览器塞太多页面它会先成为瓶颈）。
// 每个 worker = 一个场景页 + 一个分析页（同一个浏览器里）：分析页做 PNG 解码 / 180px 缩略统计（原生分辨率数像素在 Node 端线程里，_pixels.mjs），
// 和场景页互不干扰。0 号 worker 的场景页就是 check.mjs 的主页面 S（读 MARKS、probe、出证据帧都用它）。
//
// 结论与串行逐项相同靠两条：
//   1. 每帧做的事和串行完全一样（同一个探针、同一个 shot、同一个分析函数），只是换了页面；
//      有状态的部分（静止判定的"锚点帧"、motion 统计的"上一帧"）不放在分析页里，
//      要么在 Node 端按时间顺序算（静止），要么每个分片把它前面那一帧一起交给像素线程（motion，_pixels.mjs）。
//   2. 分片是**连续的时间段**，按时间顺序派发；结果按原顺序拼回去。
//      纯函数检查（顺序取一遍、倒序取一遍）在**每个分片自己的页面里**做，所以"同一个 t 换个求值顺序"
//      这件事在并行下照样成立；--workers 1 时只有一个分片，和改之前的串行逐次相同。
import { cpus } from 'node:os';
import { launchBrowser, filmBackend } from '../../film-core/lib/browser.mjs';
import { serve } from '../../film-core/lib/serve.mjs';
import { openScene } from './_film.mjs';

// 默认值与 film-core render.mjs 同一个公式（16 核 → 8 worker / 4 浏览器）。
export const defaultWorkers = () => Math.max(1, Math.min(16, Math.floor(cpus().length / 2)));

// 每个页面加载前注入：资源计时缓冲开大，结束时据此列出"本次真的加载过的文件"（输入哈希用，_inputs.mjs）
const RESOURCE_LOG = () => { try { performance.setResourceTimingBufferSize(1e6); } catch { /* */ } };

/**
 * 开一个并行池。返回 { S, ap, workers:[{S, ap, i}], chunks(items, fn, {size}), errors(), loaded(), runtime(), close(), info }
 *   fn(worker, part, i0) → 与 part 等长的结果数组；chunks() 按原顺序拼回
 */
export async function openPool(F, { workers: W, perBrowser: P, initScript, analysis }) {
  const srv = await serve(F.dir);
  const nB = Math.ceil(W / P);
  let browsers = [];
  const close = async () => { await Promise.allSettled(browsers.map((b) => b.close())); srv.close(); };
  try {
    browsers = await Promise.all(Array.from({ length: nB }, () => launchBrowser({ backend: filmBackend(F) })));   // 和渲染器同一个后端，否则每页都要另起浏览器
    // 0 号先开：拿时长、做加载期检查；其余并行开（长片加载期要渲木纹、字体，串行开 8 个也要十几秒）
    const open = async (i) => {
      const b = browsers[i % nB];
      const S = await openScene(F, { initScripts: [initScript, RESOURCE_LOG], browser: b, port: srv.port });
      const ap = await b.newPage();
      await ap.goto('about:blank');
      await ap.evaluate(analysis);
      return { S, ap, i };
    };
    const first = await open(0);
    const rest = await Promise.all(Array.from({ length: W - 1 }, (_, k) => open(k + 1)));
    const ws = [first, ...rest];
    return {
      S: first.S, ap: first.ap, workers: ws,
      info: { workers: W, browsers: nB, pagesPerBrowser: P, cpus: cpus().length },
      /** 连续分片、按时间顺序派发给空闲的 worker（谁先空谁领下一片），结果按原顺序拼回。
       *  size 缺省 = 平均分成 W×4 片（W=1 时整段一片：与串行逐次相同）。 */
      async chunks(items, fn, { size, onChunk } = {}) {
        if (!items.length) return [];
        const sz = Math.max(1, size ?? (W === 1 ? items.length : Math.ceil(items.length / (W * 4))));
        const parts = [];
        for (let a = 0; a < items.length; a += sz) parts.push(a);
        const out = new Array(parts.length);
        let next = 0, failed = null;
        await Promise.all(ws.slice(0, Math.min(W, parts.length)).map(async (w) => {
          while (!failed && next < parts.length) {
            const k = next++, a = parts[k], part = items.slice(a, a + sz);
            try { out[k] = await fn(w, part, a); } catch (e) { failed = e; throw e; }
            if (out[k]?.length !== part.length) { failed = new Error(`并行分片 ${a}+${part.length} 返回了 ${out[k]?.length} 个结果`); throw failed; }
            onChunk?.(k, a, out[k]);
          }
        }));
        return out.flat();
      },
      errors: () => ws.flatMap((w) => w.S.errors),
      /** 服务器记下的本次实际加载的运行时：[{ name, from, sha256, bytes, path }]（from = 'film' 或提供它的 skill） */
      runtime: () => srv.loaded(),
      /** 所有场景页实际加载过的 URL 路径（入口页 + 资源计时里的每一项），给输入哈希用 */
      async loaded() {
        const lists = await Promise.all(ws.map((w) => w.S.page.evaluate(() => [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]).catch(() => [])));
        const paths = new Set();
        for (const u of lists.flat()) {
          try { const x = new URL(u); if (x.hostname === '127.0.0.1' && +x.port === srv.port) paths.add(decodeURIComponent(x.pathname)); } catch { /* data:/blob: */ }
        }
        return paths;
      },
      close: async () => { for (const w of ws) { await w.ap.close().catch(() => {}); await w.S.close().catch(() => {}); } await close(); },
    };
  } catch (e) { await close(); throw e; }
}
