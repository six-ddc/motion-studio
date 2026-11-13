// film-core lib · 唯一的本地静态服务器（全套件的 createServer 只在这里出现）。
//
// 为什么必须有它：
//   1) file:// 下 ES module import 被 CORS 挡死，scene.html 没法 import ./runtime/*.js
//   2) 支持 Range 请求 —— 逐帧 seek <video> 素材要 206 分片
//   3) **运行时挂载**：片子不再拷运行时。/runtime/<name> 先找 films/<slug>/runtime/<name>（片内优先，
//      冻结副本和片子自己写的运行时都在这里），没有再到已安装的 skills/film-*/assets/runtime/<name> 里找。
//      套件运行时是**扁平命名**：两个 skill 提供同名文件时启动即报错（不按安装顺序悄悄挑一个）。
//   3b) **kit 挂载**（references/kits.md）：film.json 声明了 "kits": ["x"] 的片子，/runtime/kits/x/<文件> 在片内没有时
//      取仓库顶层 kits/x/ 里 kit.json exports 列出的那份，来源记成 kit:x@<版本>。没声明 kits 的片子不走这一支。
//   4) **加载记录**：本次服务实际发出去的每个运行时文件（名字、来源、sha256）记下来，
//      写到 <片子>/out/.render/runtime.json。accept/deliver 按它触发 gates.json 的 uses 门，deliver/freeze 按它冻结。
//
// 用法：
//   const S = await serve(F.dir)                                   托管片子目录（自动挂运行时、写加载记录）
//   const S = await serve(dir, { port: 4321, routes: { '/__preview.html': html } })   额外的内存页面
//   const S = await serve(dir, { mounts: { '/vendor/': absDir } }) 额外挂一个目录（开发基准用）
//   S.port  S.url  S.close()  S.loaded()  →  [{ name, from, sha256, bytes, path }]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { installedSkills } from './env.mjs';
import { filmKits, locateKitFile, KIT_PREFIX } from './kits.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glsl': 'text/plain; charset=utf-8',
};

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 套件运行时索引：Map<文件名, { skill, path }>，扫描已安装的每个 skills/film-<x>/assets/runtime/ 的顶层文件。
 * 同名文件出现在两个 skill 里 → 抛错（扁平命名是挂载表成立的前提）。
 */
export function suiteRuntimeIndex() {
  const idx = new Map(), dup = [];
  for (const { name: skill, dir } of installedSkills()) {
    const rt = join(dir, 'assets', 'runtime');
    let names = [];
    try { names = readdirSync(rt); } catch { continue; }
    for (const n of names.sort()) {
      const p = join(rt, n);
      if (!isFile(p) || n.startsWith('.')) continue;
      if (idx.has(n)) dup.push(`${n}：${idx.get(n).skill} 与 ${skill}`);
      else idx.set(n, { skill, path: p });
    }
  }
  if (dup.length) throw new Error(`套件运行时重名（/runtime/<名字> 是扁平命名，挂载表没法决定用哪个）：\n  ${dup.join('\n  ')}\n  改名其中一个`);
  return idx;
}

/** 片子的加载记录文件（serve 写、accept/deliver/freeze 读） */
export const runtimeRecordPath = (filmDir) => join(filmDir, 'out', '.render', 'runtime.json');

/** 读加载记录：{ at, files: { 名字: { from, sha256, bytes } } }；没有返回 null */
export function readRuntimeRecord(filmDir) {
  try { return JSON.parse(readFileSync(runtimeRecordPath(filmDir), 'utf8')); } catch { return null; }
}

/**
 * root：托管的目录（web 根）。
 * opts.port      0 = 随机端口
 * opts.routes    { '/path': 字符串 | () → 字符串 } 内存页面（函数每次请求现算）
 * opts.mounts    { '/prefix/': 绝对目录 } 额外挂载（前缀以 / 结尾）
 * opts.runtime   'auto'（默认：root 下有 film.json 才挂运行时）| true | false
 * opts.record    默认 true：挂了运行时就写 <root>/out/.render/runtime.json
 */
export function serve(root, { port = 0, routes = {}, mounts = {}, runtime = 'auto', record = true } = {}) {
  const base = resolve(root);
  const isFilm = existsSync(join(base, 'film.json'));
  const mountRuntime = runtime === 'auto' ? isFilm : !!runtime;
  let suite, kits = null;
  try {
    suite = mountRuntime ? suiteRuntimeIndex() : new Map();
    if (mountRuntime && isFilm) { kits = filmKits(base); if (!kits.names.length) kits = null; }   // 没声明 kits = null，下面整支不走
  } catch (e) { return Promise.reject(e); }
  const writeRecord = mountRuntime && record && isFilm;
  const loaded = new Map();   // 名字 → { name, from, sha256, bytes, path }
  const mountList = Object.entries(mounts).map(([pre, dir]) => [pre.endsWith('/') ? pre : pre + '/', resolve(dir)]);

  const note = (name, from, path) => {
    if (loaded.has(name)) return;
    const buf = readFileSync(path);
    loaded.set(name, { name, from, sha256: sha256(buf), bytes: buf.length, path });
    if (writeRecord) {
      try {
        const p = runtimeRecordPath(base);
        mkdirSync(join(base, 'out', '.render'), { recursive: true });
        const files = Object.fromEntries([...loaded.values()].sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => [r.name, { from: r.from, sha256: r.sha256, bytes: r.bytes }]));
        writeFileSync(p, JSON.stringify({ schema: 1, at: new Date().toISOString(), files }, null, 1) + '\n');
      } catch { /* 记录写不了不影响服务；accept/deliver 读不到记录时会说 */ }
    }
  };

  // 把 URL 路径解析成磁盘文件；返回 { file } 或 { status }
  const locate = (path) => {
    const inside = (dir, rel) => {
      const f = resolve(join(dir, normalize(rel)));
      return f === dir || f.startsWith(dir + sep) ? f : null;
    };
    if (mountRuntime && path.startsWith('/runtime/')) {
      const rel = path.slice('/runtime/'.length);
      const own = inside(join(base, 'runtime'), rel);
      if (!own) return { status: 403 };
      if (isFile(own)) { note(rel, 'film', own); return { file: own }; }
      const s = !rel.includes('/') ? suite.get(rel) : null;
      if (s) { note(rel, s.skill, s.path); return { file: s.path }; }
      if (rel.startsWith(KIT_PREFIX)) {
        // 没声明 kits 的片子也到这里说一句（不然只看得到浏览器里一条 404）
        const k = kits ? locateKitFile(kits, rel) : { error: `/runtime/${rel}：这支片子的 film.json 没有声明 kits（声明了才挂 kit 文件）` };
        if (k.path) { note(rel, k.from, k.path); return { file: k.path }; }
        process.stderr.write(`⚠ ${k.error}\n`);
        return { status: 404, why: k.error };
      }
      return { status: 404 };
    }
    for (const [pre, dir] of mountList) {
      if (path.startsWith(pre)) {
        const f = inside(dir, path.slice(pre.length));
        return f ? { file: f } : { status: 403 };
      }
    }
    const f = inside(base, path);
    return f ? { file: f } : { status: 403 };
  };

  const server = createServer((req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('bad url'); return; }
    if (routes[path] != null) {
      let body;
      try { body = typeof routes[path] === 'function' ? routes[path]() : routes[path]; }   // 函数：每次请求现算（preview 改写入口页）
      catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(e.message ?? e)); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    const loc = locate(path);
    if (loc.status) { res.writeHead(loc.status, loc.why ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}).end(loc.why ?? (loc.status === 403 ? 'forbidden' : 'not found')); return; }
    const file = loc.file;
    let info;
    try {
      info = statSync(file);
      if (info.isDirectory()) throw new Error('dir');
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      // 206 分片：视频逐帧 seek 必需
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-store',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      ok({
        server, port: p, url: `http://127.0.0.1:${p}`,
        close: () => server.close(),
        /** 本次服务实际发出的运行时文件，按名字排序 */
        loaded: () => [...loaded.values()].sort((a, b) => a.name.localeCompare(b.name)),
        /** 挂载表里套件一侧的全部文件（freeze --all 用） */
        suite: () => new Map(suite),
        /** 这支片子的 kit 挂载表（filmKits 的返回；没声明 kits 为 null） */
        kits: () => kits,
      });
    });
  });
}

/** 运行时哈希（分片缓存键、渲染输入指纹用）：已加载运行时的 名字+sha256 拼起来的 sha256 */
export function runtimeDigest(list) {
  const h = createHash('sha256');
  for (const r of [...list].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${r.name}\0${r.sha256}\0`);
  return h.digest('hex');
}
