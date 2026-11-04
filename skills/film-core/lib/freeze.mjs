// film-core lib · 冻结计划（deliver 与 freeze.mjs 共用）：把这支片子实际加载的、片外来源的运行时拷进 films/<slug>/runtime/。
//
// 片外来源两种，一条路径：
//   套件运行时  runtime/<名字>               ← skills/film-*/assets/runtime/<名字>
//   kit 文件    runtime/kits/<kit>/<文件>    ← kits/<kit>/<文件>（另把 kit.json 一起拷进 runtime/kits/<kit>/，冻结后还知道是哪一版）
// 每个文件拷之前核对 sha256：和加载时记下的那份不同 = 加载之后源头改过，冻进去的就不是渲染用的那一份，直接报错。
// kit 另有一条：片内已冻结了某个 kit 的 A 版，这次又要从源头拷它的另一个文件、而源头已是 B 版 → 报错（一支片子里不许混两版 kit）。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { suiteRuntimeIndex } from './serve.mjs';
import { filmKits, locateKitFile, parseKitPath, frozenKitDir, frozenKitInfo } from './kits.mjs';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * list：加载清单 [{ name, from, sha256 }]（渲染清单的 runtime 或 serve 的 loaded()）。
 * 返回 { todo: [{ name, from, src, dest }], have: [名字], extra: [{ src, dest, why }] }；对不上直接抛错（消息带 what 前缀）。
 * strict：片内已有同名文件时核对 sha256（deliver 用；freeze 沿用旧行为，片内有就算已冻结）。
 * 不动磁盘；applyFreeze(plan) 才拷。
 */
export function planFreeze(filmDir, list, { what = '冻结', strict = true } = {}) {
  const suite = suiteRuntimeIndex();
  let fk = null;
  const kitsOf = () => (fk ??= filmKits(filmDir));
  const todo = [], have = [], extra = [];
  const seenKit = new Set();
  for (const r of list) {
    const dest = join(filmDir, 'runtime', r.name);
    if (r.from === 'film') { have.push(r.name); continue; }
    if (existsSync(dest)) {
      if (strict && sha256(dest) !== r.sha256) throw new Error(`${what} ${r.name}：片内已有同名文件且内容不同（不该发生：片内优先，加载时就该用它）`);
      have.push(r.name); continue;
    }
    const k = parseKitPath(r.name);
    let src;
    if (k) {
      const hit = locateKitFile(kitsOf(), r.name);
      if (!hit.path) throw new Error(`${what} ${r.name}：${hit.error}`);
      if (hit.from !== r.from) throw new Error(`${what} ${r.name}：加载时来自 ${r.from}，kits/ 里现在是 ${hit.from}（加载之后 kit 升过版本）。重新渲染/交付`);
      const frozen = frozenKitInfo(filmDir, k.kit);
      const now = kitsOf().kits.get(k.kit);
      if (frozen && frozen.version !== now.version) {
        throw new Error(`${what} ${r.name}：片内已冻结 ${k.kit}@${frozen.version}，这个文件要从 ${k.kit}@${now.version} 拷——一支片子里不许混两版 kit。`
          + `要升级就删掉 runtime/kits/${k.kit}/ 整个目录再交付；要留在旧版就把旧版缺的文件补进 runtime/kits/${k.kit}/`);
      }
      if (!frozen && !seenKit.has(k.kit)) { extra.push({ src: join(now.dir, 'kit.json'), dest: join(frozenKitDir(filmDir, k.kit), 'kit.json'), why: `${k.kit}@${now.version} 的 kit.json` }); }
      seenKit.add(k.kit);
      src = hit.path;
    } else {
      const s = suite.get(r.name);
      if (!s) throw new Error(`${what} ${r.name}：加载时它来自 ${r.from}，现在套件里没有了`);
      src = s.path;
    }
    if (sha256(src) !== r.sha256) throw new Error(`${what} ${r.name}：源头（${r.from}）这份和加载时的 sha256 不同（加载之后改过）。重新渲染/交付`);
    todo.push({ name: r.name, from: r.from, src, dest });
  }
  return { todo, have, extra };
}

/** 按计划拷文件；返回拷了的行（给人看） */
export function applyFreeze(plan) {
  const lines = [];
  for (const x of [...plan.todo, ...plan.extra]) {
    mkdirSync(dirname(x.dest), { recursive: true });
    copyFileSync(x.src, x.dest);
  }
  for (const x of plan.todo) lines.push(`${x.name} ← ${x.from}`);
  for (const x of plan.extra) lines.push(`（${x.why}）`);
  return lines;
}
