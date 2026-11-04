#!/usr/bin/env node
// SVG 图标 -> canvas 可用的 path 数据（JSON）。不执行 SVG 里的任何东西，只读几何属性。
//
//   node <film-assets>/scripts/svg2path.mjs --film <slug> a.svg b.svg ... [--out assets/icons/icons.json]
//        [--allow-transform]
//   不给 --out 时打印到 stdout。
//
// 输出：{ "<文件名>": { viewBox:[x,y,w,h], fill, stroke, strokeWidth, paths:[{d, fill?, stroke?, transform?}] } }
// 浏览器里：new Path2D(paths[i].d)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { FILM_OPTS, parseArgs, resolveFilm, fail } from '../../film-core/lib/film.mjs';

const A = parseArgs({
  usage: 'node svg2path.mjs --film <slug> a.svg b.svg ... [--out assets/icons/icons.json] [--allow-transform]',
  about: 'SVG 图标 → canvas 可用的 path 数据（JSON）。不给 --out 时打印到 stdout。',
  positional: '<a.svg ...>',
  positionalHelp: 'SVG 文件（相对片子目录）',
  opts: { ...FILM_OPTS, out: ['<json>', '输出文件（相对片子目录）'], 'allow-transform': '允许带 transform 的元素（原样记下 transform）' },
});
const die = (m, code = 2) => fail(m, code);
/** 解析片子；返回 { slug, dir, config, path(p) }（p 相对片子目录，绝对路径原样） */
const film = () => {
  let F;
  try { F = resolveFilm(A.flag('film'), A); } catch (e) { die(e.message); }
  return { ...F, path: (p) => (isAbsolute(p) ? p : join(F.dir, p)) };
};
const F = film();
const valueFlags = new Set(['--film', '--films-dir', '--out']);
const files = A.argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(A.argv[i - 1]));
if (!files.length) die('没给 SVG 文件');
const allowTransform = A.has('allow-transform');

const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) o[m[1]] = m[3] ?? m[4];
  // style="stroke:none;fill:..." 也算
  if (o.style) for (const kv of o.style.split(';')) { const [k, v] = kv.split(':').map((x) => x?.trim()); if (k && v) o[k] = v; }
  return o;
};
const n = (v, d = 0) => (v === undefined ? d : Number.parseFloat(v));
const pts = (s) => (s || '').trim().split(/[\s,]+/).map(Number);

function toD(tag, a) {
  switch (tag) {
    case 'path': return a.d;
    case 'circle': { const cx = n(a.cx), cy = n(a.cy), r = n(a.r);
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`; }
    case 'ellipse': { const cx = n(a.cx), cy = n(a.cy), rx = n(a.rx), ry = n(a.ry);
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`; }
    case 'line': return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case 'rect': {
      const x = n(a.x), y = n(a.y), w = n(a.width), h = n(a.height);
      let rx = a.rx !== undefined ? n(a.rx) : (a.ry !== undefined ? n(a.ry) : 0);
      let ry = a.ry !== undefined ? n(a.ry) : rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx && !ry) return `M${x} ${y}h${w}v${h}h${-w}z`;
      return `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${h - 2 * ry}a${rx} ${ry} 0 0 1 ${-rx} ${ry}`
        + `h${-(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}v${-(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`;
    }
    case 'polyline': case 'polygon': {
      const p = pts(a.points); if (p.length < 4 || p.some(Number.isNaN)) return null;
      let d = `M${p[0]} ${p[1]}`; for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return tag === 'polygon' ? d + 'z' : d;
    }
    default: return null;
  }
}

const result = {};
let failed = 0;
for (const rel of files) {
  const p = F.path(rel);
  if (!existsSync(p)) { console.error(`✗ 不存在：${p}`); failed++; continue; }
  const src = readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const root = /<svg\b([^>]*)>/i.exec(src);
  if (!root) { console.error(`✗ ${rel} 不是 SVG`); failed++; continue; }
  const ra = attrs(root[1]);
  const vb = ra.viewBox ? pts(ra.viewBox) : [0, 0, n(ra.width, 24), n(ra.height, 24)];
  const name = basename(p).replace(/\.svg$/i, '');
  const paths = [];
  const skipped = [];
  let bad = null;
  if (/<(script|foreignObject|use|image)\b/i.test(src)) skipped.push('script/foreignObject/use/image（已忽略）');
  if (/<g\b[^>]*\btransform\s*=/i.test(src) && !allowTransform) bad = '<g transform> 未展开';
  for (const m of src.matchAll(/<(path|circle|ellipse|line|rect|polyline|polygon)\b([^>]*?)\/?>/gi)) {
    const tag = m[1].toLowerCase(), a = attrs(m[2]);
    // Tabler 等图标库的占位框：stroke="none" 且铺满 viewBox
    if (a.stroke === 'none' && (a.fill === undefined || a.fill === 'none')) { skipped.push(`占位 ${tag}`); continue; }
    if (a.transform && !allowTransform) { bad = `<${tag} transform="${a.transform}">`; break; }
    const d = toD(tag, a);
    if (!d) { skipped.push(`空 ${tag}`); continue; }
    const e = { d };
    for (const k of ['fill', 'stroke', 'stroke-width', 'fill-rule', 'transform']) if (a[k] !== undefined) e[k] = a[k];
    paths.push(e);
  }
  if (bad) { console.error(`✗ ${rel}: ${bad}。忽略 transform 会画歪；加 --allow-transform 则原样记入 JSON 由 canvas 端处理`); failed++; continue; }
  if (!paths.length) { console.error(`✗ ${rel}: 没有可用几何`); failed++; continue; }
  result[name] = {
    viewBox: vb, fill: ra.fill ?? null, stroke: ra.stroke ?? null,
    strokeWidth: ra['stroke-width'] !== undefined ? n(ra['stroke-width']) : null,
    linecap: ra['stroke-linecap'] ?? null, linejoin: ra['stroke-linejoin'] ?? null,
    paths,
  };
  console.error(`✓ ${name}: ${paths.length} 段${skipped.length ? `（跳过 ${skipped.join('、')}）` : ''}`);
}

const json = JSON.stringify(result, null, 2);
const out = A.flag('out');
if (out) { const o = F.path(out); mkdirSync(dirname(o), { recursive: true }); writeFileSync(o, json); console.error(`-> ${o}`); }
else console.log(json);
if (failed) die(`${failed} 个文件失败`, 1);
