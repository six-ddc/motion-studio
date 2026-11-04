#!/usr/bin/env node
// 压扁扫描：找"斜着看的平面被纵向压扁画成了正交投影"的疑点（逻辑在 lib/tiltscan.mjs）。
//
//   node <film-motion>/scripts/tiltcheck.mjs --film <slug> [--sample-fps 4] [--entry x.html] [--strict]
//
// 报的是**疑点**，不是失败：斜放正方形的正交像与正俯视长方形的像逐像素相同，
// 挤压拉伸、等轴测、图解风格也都是正当的非等比变换——是不是问题只有作者知道。
// 有意用正交投影的片子在 style_guide 的 critique 块写 "ortho_ok": "<理由>"，这里就只报告不提示。
//
// 退出码：0 = 没有疑点，或有疑点但不是 --strict；1 = --strict 下有疑点 / 页面报错；2 = 用法错误
import { resolveFilm, parseArgs, main, fail, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { openScene } from '../../film-core/lib/browser.mjs';
import { tiltScan, tiltRuns, describeRun, AREA_MIN, RATIO_MAX } from './lib/tiltscan.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = parseArgs({
  usage: 'node tiltcheck.mjs --film <slug> [--format 9x16] [--sample-fps 4] [--entry x.html] [--strict]',
  about: '压扁扫描：找"斜着看的平面被画成正交投影"的疑点。退出码 0 无疑点或非 --strict / 1 --strict 下有疑点或页面报错 / 2 用法错',
  opts: { ...FILM_OPTS, entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅'], 'sample-fps': ['<N>', '采样帧率（默认 4）'], strict: '有疑点就 exit 1' },
});

await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const sfps = args.num('sample-fps', 4);
  if (!(sfps > 0)) fail('--sample-fps 必须 > 0', 2);
  let orthoOk = null;
  const sg = join(F.dir, 'docs/style_guide.md');
  if (existsSync(sg)) {
    const m = /```(?:json\s+)?critique\s*\n([\s\S]*?)```/.exec(readFileSync(sg, 'utf-8'));
    if (m) try { orthoOk = JSON.parse(m[1]).ortho_ok ?? null; } catch { /* 坏 JSON 由 check.mjs 报 */ }
  }
  const S = await openScene(F, format, {});
  try {
    const D = S.info.duration;
    const N = Math.floor(D * sfps - 1e-9) + 1;
    const ts = Array.from({ length: N }, (_, i) => +(i / sfps).toFixed(4));
    const t0 = process.hrtime.bigint();
    const samples = await tiltScan(S.page, ts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (S.errors.length) fail(`页面报错：\n  ${S.errors.join('\n  ')}`);
    const runs = tiltRuns(samples, { step: 1 / sfps });
    const peak = samples.reduce((a, s) => (s.hit && (!a || s.hit.frac > a.frac) ? s.hit : a), null);
    console.log(`压扁扫描 ${F.slug}：${N} 帧 @${sfps}fps，${ms.toFixed(0)}ms（判据：同一变换下外包 ≥ ${AREA_MIN * 100}% 画布，σ2/σ1 < ${RATIO_MAX}）`);
    if (peak) console.log(`  全片最大非等比组：${(peak.frac * 100).toFixed(1)}% 面积，短/长轴 ${peak.ratio.toFixed(3)}`);
    if (!runs.length) { console.log('✓ 没有大面积非等比仿射绘制'); return; }
    for (const r of runs) console.log(`${orthoOk ? '  ·' : '  ?'} ${describeRun(r)}`);
    if (orthoOk) { console.log(`本片声明 ortho_ok：${orthoOk}（只报告）`); return; }
    console.log('如果这是"斜着看的平面"，它是正交投影：平行线不收拢、远近边一样宽，读成长方形而不是斜放的方形。\n'
      + '要透视用 film-motion 的 runtime/camera3d.js；有意的平面/图解风格就在 style_guide critique 块写 "ortho_ok": "<理由>"。');
    if (args.has('strict')) process.exitCode = 1;
  } finally { await S.close(); }
});
