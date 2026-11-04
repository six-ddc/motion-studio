// 把 check.mjs 的 checks.json 变成 docs/review_log.md 的一节。
//
// 用法:
//   node <film-critique>/scripts/review_log.mjs --film <slug> [--seen-by 名字] [--note "一句话"]
//
// 没有 --seen-by：视为无人在场。所有主观项写成"未经人眼确认"，不生成分数。
// 有 --seen-by：只记录谁看过，主观项留空格让人填 —— 脚本永远不替人打分。
// review_log.md 不存在时从 assets/review_log.md 模板建（与 new-film --recipe 写的同一份）。
//
// 每一轮系统化写：检查过的时间点（来源：切点 / MARKS / 均匀 / 发现处，各带帧路径）、每点脚本结论、
// 发现的问题 → 修法 → 遗留、HUMAN 行"看哪一帧"。要人填的地方是**结构化空项**（表格空格、"字段："后留空），
// 不写"（待填）"之类要手工替换的占位：空着 = 没人填，一眼可数，也不会被误读成已经填过。
// 派生品（stills / transitions / contact / strip / phone / checks.json）过期时在本轮开头醒目提示（_fresh.mjs），不拦。
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, resolveFilm, readLaws, die, FILM_OPTS } from './_film.mjs';
import { scanProducts, describeFreshness, readMeta } from './_fresh.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { flag } = args({
  usage: 'node review_log.mjs --film <slug> [--seen-by 名字] [--note "一句话"]',
  about: '把 check.mjs 的 out/critique/checks.json 变成 docs/review_log.md 的一节（追加写入）。脚本永远不替人打分。',
  opts: { ...FILM_OPTS, 'seen-by': ['<名字>', '谁看过（不给 = 无人在场，主观项写"未经人眼确认"）'], note: ['<文字>', '一句话备注'] },
});
const F = resolveFilm(flag('film'));
const checksPath = join(F.out, 'critique', 'checks.json');
if (!existsSync(checksPath)) die(`没有 ${checksPath}，先跑 check.mjs`);
const C = JSON.parse(readFileSync(checksPath, 'utf8'));
const laws = readLaws(F);
const seen = flag('seen-by', null);
const UNSEEN = '未经人眼确认';

mkdirSync(F.docs, { recursive: true });
const logPath = join(F.docs, 'review_log.md');
if (!existsSync(logPath)) {
  const tpl = readFileSync(join(HERE, '..', 'assets', 'review_log.md'), 'utf8');
  writeFileSync(logPath, tpl.replace('{{title}}', F.config.title ?? F.slug));
}
const prev = readFileSync(logPath, 'utf8');
const round = (prev.match(/^## 第 (\d+) 轮/gm) ?? []).length + 1;
const today = new Date().toLocaleDateString('sv-SE'); // 本地日期（toISOString 是 UTC，东八区早上会差一天）
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const row = (f) => `| ${f.level} | ${f.id} | ${f.t != null ? f.t.toFixed(2) + 's' : '—'} | ${esc(f.msg)} |`;
const by = (layer) => C.findings.filter((f) => f.layer === layer);

const rel = (p) => (p ? relative(F.dir, p) : null);
const human = by('本片法律').filter((f) => f.level === 'HUMAN');
const weak = C.findings.filter((f) => f.level === 'FAIL' || f.level === 'LOOK')
  .sort((a, b) => (a.level === b.level ? (a.t ?? 0) - (b.t ?? 0) : a.level === 'FAIL' ? -1 : 1));
const lawIds = new Set(by('本片法律').map((f) => f.id));
const HUMAN_CELL = seen ? '' : UNSEEN;   // 有人在场：空格 = 等人填；无人在场：明写未经人眼确认

// ---- 派生品新鲜度 ----
const fresh = scanProducts(F);
const stale = fresh.filter((x) => x.status === 'stale');

// ---- 检查过的时间点：transitions（切点）、stills（MARKS / 均匀 / --at）、发现处（证据帧）----
const points = [];
const trMeta = readMeta(join(F.out, 'transitions.png')), stMeta = readMeta(join(F.out, 'stills.png'));
if (trMeta?.points) for (const p of trMeta.points) points.push({ t: p.t, frame: p.file, src: trMeta.source ? `切点 ${p.pos}（${trMeta.source}）` : `${trMeta.fallback ?? '退回'}（无剪辑点）`, row: p.row });
if (stMeta?.points) for (const p of stMeta.points) points.push({ t: p.t, frame: p.file, src: `静帧（${stMeta.source}）` });
for (const f of C.findings) if (f.t != null && f.ev && ['FAIL', 'LOOK', 'HUMAN'].includes(f.level)) points.push({ t: f.t, frame: rel(f.ev), src: `发现处 ${f.id}` });
points.sort((a, b) => a.t - b.t);
const NEAR = Math.max(0.5, 1 / (C.sampleFps || 10));
const scriptSays = (t) => {
  const hit = C.findings.filter((f) => f.t != null && ['FAIL', 'LOOK'].includes(f.level) && Math.abs(f.t - t) <= NEAR);
  return hit.length ? hit.map((f) => `${f.level} ${f.id}`).join('、') : '脚本无发现';
};
// HUMAN 行"看哪一帧"：check.mjs 存了时间窗帧就用它；否则指向现有拼图
let outFiles = []; try { outFiles = readdirSync(F.out); } catch { /* 没有 out/ */ }
const overview = ['transitions.png', 'stills.png', ...outFiles.filter((n) => /-(strip|contact|phone)\.png$/.test(n)).sort()]
  .filter((n) => existsSync(join(F.out, n))).map((n) => `out/${n}`);
const lookAt = (f) => (f.ev ? `\`${rel(f.ev)}\`` : overview.length ? overview.map((x) => `\`${x}\``).join(' / ') : '（还没有拼图：先跑 stills.mjs / transitions.mjs）');

const out = [];
out.push(`\n## 第 ${round} 轮`);
out.push(`日期：${today}　入口：${C.entry ?? F.entry}　时长 ${C.duration}s　采样 ${C.sampleFps}fps`);
out.push(`人眼：${seen ? `${seen} 看过 stills / transitions / contact / phone` : `无人在场。下面所有主观项均为「${UNSEEN}」，没有分数`}`);
if (flag('note')) out.push(`备注：${flag('note')}`);
if (stale.length) {
  out.push(`\n> **⚠ 派生品过期（${stale.length} 个）**：下面引用的图可能是旧时间轴的，结论按旧图下的要重看。重跑对应工具后再写一轮。`);
  describeFreshness(stale).forEach((l) => out.push(`> ${l.trim()}`));
}
out.push('\n### 派生品新鲜度\n');
out.push(fresh.length ? describeFreshness(fresh).map((l) => `- ${l.trim()}`).join('\n') : '- 没有派生品（stills / transitions / contact 都还没跑）');

out.push('\n### 检查过的时间点\n');
out.push(`check.mjs 逐帧采样全片 ${Math.round((C.duration ?? 0) * (C.sampleFps ?? 0))} 帧 @${C.sampleFps}fps（脚本判，下表不重复列）。下表是给眼睛看的点：来源、帧、脚本在 ±${NEAR}s 内的结论、人判。`);
if (!trMeta) out.push('\n没有 transitions 拼图：转场中段没被专门看过（`transitions.mjs --film <slug>`）。');
else if (!trMeta.source) out.push('\ntransitions 拼图没找到剪辑点（场景没声明 CUTS / CUT_WINDOWS），取的是退回点：转场中段没被专门看过。');
if (points.length) {
  out.push('\n| 时刻 | 来源 | 帧 | 脚本结论 | 人判 |\n|---|---|---|---|---|');
  points.forEach((p) => out.push(`| ${p.t.toFixed(3)}s | ${esc(p.src)} | \`${p.frame}\` | ${esc(scriptSays(p.t))} | ${HUMAN_CELL} |`));
} else out.push('\n无。');

out.push('\n### 客观项（脚本判定）\n\n| 结论 | 项 | 时刻 | 说明 |\n|---|---|---|---|');
by('客观').forEach((f) => out.push(row(f)));
out.push('\n### 本片项（来自 docs/style_guide.md）\n');
if (laws._missing || laws._noBlock) out.push(`style_guide ${laws._missing ? '不存在' : '没有 critique 块'}：本片没有可机器读的法律。片子没声明的事不打分。\n`);
out.push('| 结论 | 法律 | 时刻 | 说明 |\n|---|---|---|---|');
by('本片法律').filter((f) => f.level !== 'HUMAN').forEach((f) => out.push(row(f)));
if (!lawIds.size) out.push('| — | — | — | 无 |');
if (human.length) {
  out.push('\nHUMAN（机器判不了，人看；结论填 守住 / 破了 / 故意）：\n\n| 结论 | 法律 | 看哪一帧 | 说明 |\n|---|---|---|---|');
  human.forEach((f) => out.push(`| ${HUMAN_CELL} | ${f.id} | ${lookAt(f)} | ${esc(f.msg)} |`));
}
out.push('\n### 疑点（测得到，是不是问题看本片意图）\n');
const looks = by('疑点').filter((f) => f.level !== 'HOLD');
if (looks.length) { out.push('| 结论 | 项 | 时刻 | 说明 | 判定（故意/失误） |\n|---|---|---|---|---|'); looks.forEach((f) => out.push(`${row(f)} ${HUMAN_CELL} |`)); }
else out.push('无。');
// 故意保留：check.mjs 把落在 MARKS hold 区间里的 LOOK 记成 HOLD，理由来自场景声明。交付说明照抄这一节。
const held = C.findings.filter((f) => f.level === 'HOLD');
out.push('\n### 故意保留（MARKS hold，作者写了理由）\n');
if (held.length) { out.push('| 项 | 时刻 | 保留的区间 | 理由 |\n|---|---|---|---|'); held.forEach((f) => out.push(`| ${f.id} | ${f.t != null ? f.t.toFixed(2) + 's' : '—'} | ${esc(f.hold?.label ?? '')} | ${esc(f.hold?.reason ?? '')} |`)); }
else out.push('无。');
out.push('\n### 倾向性提醒（references/tendencies.md，值得看一眼，不是扣分项）\n');
if (seen) {
  out.push('判定填 故意（依据写 style_guide / mechanism.md 哪句）/ 偷懒，改 / 没看。\n\n| 条 | 判定 | 依据 / 看的哪一帧 |\n|---|---|---|');
  ['T1 同一种入场', 'T2 同一种退场', 'T3 平台期', 'T4 均匀映射吃掉事件', 'T5 音画各说各的', 'T6 没设计过的中间态', 'T7 构图读成别的', 'T8 质感读成别的', 'T9 镜头没设计过'].forEach((x) => out.push(`| ${x} |  |  |`));
} else out.push(`无人在场时整节为「${UNSEEN}」。`);
out.push('\n### 静帧上看到的（模型描述，不作结论）\n');
// 无人在场时这一节**必须填**，不能只写"未经人眼确认"：
// "没人看过"和"模型看过、看到了这些事实、仍需人确认"是两种信息量。
// 只写可复述的事实（画面上有什么、在哪、什么颜色、文字内容），不写判断。
// 一条检验：写的每句话，另一个人对着同一张图能判断对错吗？不能就是判断，删掉。
if (seen) out.push('- 意外语义：\n- 像什么：\n- 哪里读不懂：');
else out.push('<!-- 必填：真的用 Read 打开 transitions.png / stills.png / *-phone.png / *-contact.png 看，写可复述的事实（有什么、在哪、相对关系、文字内容、有没有某个颜色），'
  + '每条注明看的哪张图哪一格；不写"好看""协调"。第二项写靠看图给不出、必须人看的（意外语义、质感联想、故意还是偷懒、一切和声音有关的）。 -->\n'
  + '- 模型描述：\n- 模型描述给不出、必须人看的：\n'
  + `- 以上**不是打分**。主观项仍然 ${UNSEEN}。`);
out.push('\n### 发现的问题 → 修法 → 遗留（FAIL 在前、按时间）\n');
if (weak.length) {
  out.push('修法写改哪份产物（见 references/attribution.md）；遗留写这轮不修的理由，空着 = 还没处理。\n\n| # | 级别 | 时刻 | 问题 | 证据帧 | 修法 | 遗留 |\n|---|---|---|---|---|---|---|');
  weak.forEach((f, i) => out.push(`| ${i + 1} | ${f.level} | ${f.t != null ? f.t.toFixed(2) + 's' : '—'} | ${f.id}：${esc(f.msg)} | ${f.ev ? `\`${rel(f.ev)}\`` : '—'} |  |  |`));
} else out.push('脚本没找到。不代表片子好，只代表机器能查的都过了。');
out.push('\n### 改了什么 / 重渲区间\n\n<!-- 改了再写：改法见对应能力 skill；只重渲改动的秒数，参见 film-core render.mjs --from/--to -->\n- 改动：\n- 重渲区间：');
// 交接：下一轮（可能是另一个会话、另一个 agent）动手前先读这一节，不从头猜。
out.push('\n### 下一轮先读（交接）\n\n<!-- 写给下一轮动手的人：先读这节再改。每项一两句，空着 = 没交代 -->'
  + '\n- 本轮做了哪些创作决定、放弃了哪些备选：'
  + '\n- 测过的 / 只看过的 / 没人查的（例：声音测了响度没人听过）：'
  + '\n- 最弱的一镜：'
  + '\n- 本轮点名、写进 style_guide「本片拒绝」的默认：'
  + '\n- 用户在对话外手改过的文件（下一轮当作用户意图，不覆盖）：'
  + '\n- 渲染状态（只出过预览 / 小样 / 用户已批准终稿）：');

appendFileSync(logPath, out.join('\n') + '\n');
console.log(`✓ 追加第 ${round} 轮 → ${logPath}${seen ? '' : `（无人在场，主观项标「${UNSEEN}」）`}`);
console.log(`  检查过的时间点 ${points.length} 个${trMeta ? '' : '（没有 transitions 拼图：转场中段没被专门看过）'}`);
if (stale.length) { console.warn(`⚠ ${stale.length} 个派生品过期（只提示，不拦）：`); describeFreshness(stale).forEach((l) => console.warn(l)); }
