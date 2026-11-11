#!/usr/bin/env node
// kit 自检（声明才开的门：film.json checks 写 "kits"）：这支片子声明的每个 kit，跑它 kit.json 里登记的检查。契约见 references/kits.md。
//
//   node <film-core>/scripts/kitcheck.mjs --film <slug>             跑本片声明的 kit 的检查（标准帧比对 + kit 自带命令）
//   node <film-core>/scripts/kitcheck.mjs --film <slug> --entry x   换入口（阴性对照、单镜头调试）
//   node <film-core>/scripts/kitcheck.mjs --list                    列出 kits/ 下全部 kit，以及哪些片子用了哪一版（片内冻结的 / 在线挂的）
//
// kit.json 的 check（都可选）：
//   std  { png, at = [0, "end"], format? }   片子在这些时刻的 #stage 截图要和 kit 里的标准帧 PNG 逐像素相同（RGB 通道）。
//        系列片"首尾帧是同一个画面"这类约定由它守：主题改了一处、某一课又自己画了一笔，都会在这里红。
//   cmd  ["node", "{kit}/tools/x.mjs", "{film}"]   kit 自带的检查命令，退出码非 0 = 红。占位符 {kit} {film} {slug} {films}。
// 没登记 check 的 kit 记「–」。这不是必过门：只有片子在 checks 里声明了 "kits" 才跑。
//
// 退出码：0 全过（或无可查）/ 1 有红 / 2 用法错
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFilm, parseArgs, main, fail, FILM_OPTS, filmsDir, listFilms } from '../lib/film.mjs';
import { serve } from '../lib/serve.mjs';
import { launchBrowser, openScene, filmBackend } from '../lib/browser.mjs';
import { decodePng } from '../lib/pngmix.mjs';
import { filmKits, kitsRoot, listKits, declaredKits, frozenKitInfo } from '../lib/kits.mjs';

const args = parseArgs({
  usage: 'node kitcheck.mjs --film <slug> [--entry <html>] | --list',
  about: 'kit 自检：片子声明的每个 kit，跑 kit.json check 登记的标准帧比对与自带命令。退出码 0 通过 / 1 有红 / 2 用法错',
  opts: {
    ...FILM_OPTS,
    entry: ['<html>', '换入口页（默认 film.json entry）'],
    list: '列出 kits/ 下全部 kit 与各片子用的版本',
  },
});

/** 两张 PNG 的 RGB 通道差几个 → { n }；尺寸不同或标准帧读不了 → { why: 说明 } */
function diffRGB(a, b) {
  const A = decodePng(a);
  let B;
  try { B = decodePng(b); } catch (e) { return { why: `标准帧 PNG 读不了（${e.message}）` }; }
  if (A.w !== B.w || A.h !== B.h) return { why: `尺寸不同 ${A.w}×${A.h} vs ${B.w}×${B.h}` };
  let n = 0;
  const ca = A.ch, cb = B.ch;
  for (let i = 0, j = 0, k = 0; k < A.w * A.h; k++, i += ca, j += cb) {
    if (A.data[i] !== B.data[j]) n++;
    if (A.data[i + 1] !== B.data[j + 1]) n++;
    if (A.data[i + 2] !== B.data[j + 2]) n++;
  }
  return { n };
}

await main(async () => {
  if (args.has('list')) return list();
  const F = resolveFilm(args.film, args);
  const names = declaredKits(F.raw, `${F.slug}/film.json`);
  if (!names.length) fail(`${F.slug} 的 film.json 没有声明 kits，却要跑 kit 检查（checks 里的 "kits" 多写了？）`);
  const fk = filmKits(F.dir, F.raw);
  let bad = 0;
  const rows = [];
  for (const name of names) {
    const kit = fk.kits.get(name);
    if (!kit) { rows.push(`– ${name}：kits/ 里没有这个 kit（只有片内冻结副本），没有可跑的检查`); continue; }
    const frozen = frozenKitInfo(F.dir, name);
    const tag = `${name}@${frozen?.version ?? kit.version}${frozen ? '（片内冻结）' : ''}`;
    if (!kit.check) { rows.push(`– ${tag}：kit.json 没有登记 check`); continue; }
    if (frozen && frozen.version !== kit.version) rows.push(`⚠ ${tag}：kits/ 里已是 ${kit.version}，检查按 kits/ 当前版本的标准帧与命令跑`);

    if (kit.check.std) {
      const s = kit.check.std;
      const want = readFileSync(join(kit.dir, s.png));
      const fmt = s.format ?? F.config.format;
      const srv = await serve(F.dir, { record: false });
      const browser = await launchBrowser({ backend: filmBackend(F) });
      try {
        const S = await openScene(F, fmt, { browser, port: srv.port, record: false });
        try {
          for (const at of s.at ?? [0, 'end']) {
            const t = at === 'end' ? S.info.duration : at;
            const got = await S.shot(t);
            const d = diffRGB(got, want);
            const lab = `t=${at === 'end' ? `末（${t.toFixed(3)}s）` : at}`;
            if (d.why || d.n) {
              bad++;
              const dir = join(F.dir, 'out', 'kitcheck');
              mkdirSync(dir, { recursive: true });
              const p = join(dir, `${name}-${at === 'end' ? 'end' : at}.png`);
              writeFileSync(p, got);
              rows.push(`✗ ${tag} 标准帧 ${lab}：${d.why ? `${d.why}（画幅 ${fmt}）` : `${d.n} 个通道与 ${s.png} 不同`}（截图存 ${p}）`);
            } else rows.push(`✓ ${tag} 标准帧 ${lab}：逐像素等于 ${s.png}`);
          }
        } finally { await S.close(); }
      } finally { await browser.close(); srv.close(); }
    }

    if (kit.check.cmd) {
      const sub = (x) => x.replaceAll('{kit}', kit.dir).replaceAll('{film}', F.dir).replaceAll('{slug}', F.slug).replaceAll('{films}', F.films);
      const [bin, ...rest] = kit.check.cmd.map(sub);
      const r = spawnSync(bin === 'node' ? process.execPath : bin, rest, { encoding: 'utf8', cwd: kit.dir });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      if (r.status === 0) rows.push(`✓ ${tag} 自带检查 ${kit.check.cmd.join(' ')}${out ? `\n    ${out.split('\n').join('\n    ')}` : ''}`);
      else { bad++; rows.push(`✗ ${tag} 自带检查（退出码 ${r.status}）${out ? `\n    ${out.split('\n').slice(-15).join('\n    ')}` : ''}`); }
    }
  }
  console.log(`kit 检查 ${F.slug}（${F.config.entry}）：\n  ${rows.join('\n  ')}`);
  if (bad) { console.log(`✗ ${bad} 项不通过`); process.exit(1); }
  console.log('✓ kit 检查全部通过');
});

function list() {
  const FD = filmsDir(args);
  const root = kitsRoot(FD);
  const kits = listKits(root);
  if (!kits.length) { console.log(`没有 kit（kits/ = ${root ?? '找不到'}）`); return; }
  // 谁在用：扫 films/ 下每支片子的 film.json kits
  const users = new Map();
  for (const slug of listFilms(FD)) {
    let raw; try { raw = JSON.parse(readFileSync(join(FD, slug, 'film.json'), 'utf8')); } catch { continue; }
    let names; try { names = declaredKits(raw); } catch { continue; }
    for (const n of names) {
      const fr = frozenKitInfo(join(FD, slug), n);
      if (!users.has(n)) users.set(n, []);
      users.get(n).push(fr ? `${slug}（冻结 ${fr.version}）` : `${slug}（在线）`);
    }
  }
  console.log(`kits/ = ${root}`);
  for (const k of kits) {
    if (k.error) { console.log(`✗ ${k.name}：${k.error}`); continue; }
    const chk = [k.check?.std ? '标准帧' : null, k.check?.cmd ? '自带命令' : null].filter(Boolean).join('+') || '无检查';
    console.log(`${k.name}@${k.version}  导出 ${[...k.exports.keys()].join(' ')}  ·  ${chk}\n  ${k.about}\n  使用：${(users.get(k.name) ?? []).join(' ') || '（无）'}`);
  }
}
