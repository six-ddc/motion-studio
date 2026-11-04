#!/usr/bin/env node
// selftest.mjs — factcheck.mjs 的回归测试。
//
//   node dev/film-story/selftest.mjs --dir <工作目录>
//        [--real <片子目录>]...      真实片子的 facts.md + script.json 原样拷进来跑，期望 exit 0
//        [--ghost-jam <片子目录>]    在幽灵堵车真实 facts.md 上做"自然写法 / 改坏"变体
//        [--fc <factcheck.mjs>]      换一份 factcheck 跑同一套用例（拿旧逻辑做对照）
//
// 在 <工作目录>/films/ 下用 assets/facts.template.md **原样**（只替换占位符，和脚手架一样）
// 建用例，逐个跑 factcheck，核对退出码（和可选的输出片段）。任何一个不符合预期就 exit 1。
// 用例目录留着不删，失败时可以直接进去看。--real / --ghost-jam 只读源目录，不写回。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cli } from '../../skills/film-core/lib/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORY = path.join(here, '..', '..', 'skills', 'film-story');
const TEMPLATE = path.join(STORY, 'assets', 'facts.template.md');

const argv = process.argv.slice(2);
cli({
  usage: 'node selftest.mjs --dir <工作目录> [--real <片子目录>]... [--ghost-jam <片子目录>] [--fc <factcheck.mjs>]',
  about: 'factcheck.mjs 的回归测试：在 <dir>/films/ 下建用例逐个跑 factcheck、核对退出码。用例目录不自动删。',
  opts: {
    dir: ['<工作目录>', '用例建在 <dir>/films/ 下（必填）'],
    real: ['<片子目录>', '真实片子的 facts.md + script.json 原样拷进来跑，期望 exit 0（可重复）'],
    'ghost-jam': ['<片子目录>', '在幽灵堵车真实 facts.md 上做变体'],
    fc: ['<factcheck.mjs>', '换一份 factcheck 跑同一套用例'],
  },
}, argv);
const opt = { dir: null, real: [], ghost: null, fc: path.join(STORY, 'scripts', 'factcheck.mjs') };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') opt.dir = argv[++i];
  else if (argv[i] === '--real') opt.real.push(argv[++i]);
  else if (argv[i] === '--ghost-jam') opt.ghost = argv[++i];
  else if (argv[i] === '--fc') opt.fc = path.resolve(argv[++i]);
  else { process.stderr.write(`selftest: 未知参数 ${argv[i]}\n`); process.exit(2); }
}
if (!opt.dir) {
  process.stderr.write('selftest: 需要 --dir <工作目录>（用例会建在 <dir>/films/ 下，不会自动删除）\n');
  process.exit(2);
}
const root = path.resolve(opt.dir, 'films');
const FC = opt.fc;

const tpl = fs.readFileSync(TEMPLATE, 'utf8').replace(/<片名>/g, '回归');

// 模板原样 + 在总表末尾追加行 + 在"## 详情"后追加详情段。
// 故意用 F01 / F02 / C01 —— 和模板注释里的示例 id 相同（回归：注释不能被当成内容解析）。
function build(rows, sections) {
  let s = tpl.replace(/^\| F01 \|.*$/m, rows.join('\n'));
  // 用户的做法：改写模板里的 F01 占位详情段（到第一个注释块之前），注释块原样保留
  s = s.replace(/^### F01 <短标题>[\s\S]*?(?=^<!--)/m, sections.join('\n\n') + '\n\n');
  return s;
}
const SRC = '- 来源: [甲](https://example.org/a) — "原文"\n- 来源: [乙](https://example.org/b) — "原文"';
const goodRows = [
  '| F01 | 某事发生于 1023 年 | 1023 | 日期 | 承重 | 已核 | 高 |',
  '| F02 | 此后八十多年 | 八十; 80 | 数字 | 支撑 | 已核 | 高 |',
  '| C01 | 某种定性曲线 |  | 建构 | 点缀 | 免核 | 低 |',
];
const goodSecs = [
  `### F01 年份\n${SRC}`,
  '### F02 间隔\n- 推导: F01 —— 示例',
  '### C01 曲线（解释性建构）\n- 性质: 作者解释\n- 锚点: F01\n- 呈现: 浓淡，不画刻度',
];
const goodLines = [{ id: 's1', text: '一〇二三年，事情开始。' }, { id: 's2', text: '八十多年后，它结束了。' }];

// ---- 单位：按文档的自然写法（数字 + 单位），不在任何白名单里的单位也要认 ----
// 行和 films/ghost-jam/docs/facts.md 同形；"44 米"带空格、"30 km/h"英文单位。
const unitRows = [
  '| F01 | 实验车辆数 22 辆 | 22辆; 二十二辆 | 数字 | 支撑 | 已核 | 高 |',
  '| F02 | 环形路周长 230 米 | 230米 | 数字 | 支撑 | 已核 | 高 |',
  '| F03 | 平均车头间距约 10 米 | 44 米 | 数字 | 支撑 | 已核 | 高 |',
  '| F04 | 巡航约 30 km/h | 30公里; 30 km/h | 数字 | 支撑 | 已核 | 高 |',
  '| F05 | 3 分钟快照里堵已成形 | 三分钟 | 数字 | 支撑 | 已核 | 高 |',
  '| F06 | 投稿 2007 年 | 2007年 | 日期 | 点缀 | 已核 | 高 |',
  '| X01 | 泛指 | 一辆 | 背景 | 点缀 | 免核 |  |',
  '| R01 | "2008 年做的实验" | 2008年做 | 日期 | 点缀 | 否决 | 高 |',
  '| R02 | "实验在名古屋巨蛋做的" | 名古屋巨蛋 | 专名 | 点缀 | 否决 | 高 |',
];
const unitSecs = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'].map(id => `### ${id} x\n${SRC}`)
  .concat(['### X01 泛指\n- 理由: 泛指', `### R01 否决\n${SRC}\n- 理由: 发表年不是实验年`, `### R02 否决\n${SRC}\n- 理由: 地点记错`]);
const unitFacts = build(unitRows, unitSecs);
const L = text => [{ id: 's1', text }];

const cases = [
  { name: 'dup-section', expect: 1, why: '同一 id 两个详情段应报错（不能静默覆盖）',
    facts: tpl.replace(/^## 详情\n/m, `## 详情\n\n### F01 年份\n${SRC}\n`).replace(/^\| F01 \|.*$/m, goodRows[0]),
    lines: [{ id: 's1', text: '一〇二三年。' }] },
  { name: 'template-plus-ids', expect: 0, why: '模板原样 + F01/F02/C01（与注释示例同 id）应通过',
    facts: build(goodRows, goodSecs), lines: goodLines },
  { name: 'broken-number', expect: 1, why: '旁白数字改坏应被抓到',
    facts: build(goodRows, goodSecs), lines: [{ id: 's1', text: '一〇二四年，事情开始。' }, goodLines[1]] },
  { name: 'construct-no-anchor', expect: 1, why: '建构缺锚点应报错',
    facts: build(goodRows, [goodSecs[0], goodSecs[1], '### C01 曲线\n- 性质: 作者解释\n- 呈现: 浓淡']), lines: goodLines },
  { name: 'template-untouched', expect: 0, why: '模板一字不改 + 空旁白应通过（注释里的 F02/C01 不能被解析出来）',
    facts: tpl, lines: [{ id: 's1', text: '' }] },
  { name: 'also-comment', expect: 0, why: '--also 文件里注释中的数字不应参与对账',
    facts: build(goodRows, goodSecs), lines: goodLines,
    also: ['onscreen.txt', '一〇二三\n<!-- 草稿：1999 年\n还有 42 -->\n'] },

  // ---- 单位：该过的 ----
  { name: 'unit-natural', expect: 0, why: '"22辆/230米/44 米/30 km/h/三分钟"按自然写法登记，中文数字、空格、英文单位都应命中',
    facts: unitFacts,
    lines: [{ id: 's1', text: '一圈两百三十米的路，二十二辆车。' },
            { id: 's2', text: '车头之间 44 米，时速三十公里。' },
            { id: 's3', text: '可只要一辆车慢了一下，三分钟后就堵了。' },
            { id: 's4', text: '论文 2007 年投稿。' }],
    also: ['onscreen.txt', '22辆 · 230 米 · 30 km/h · 四十四米\n'],
    out: [/0 错误/] },
  { name: 'unit-cn-numeral', expect: 0, why: '匹配词写中文"二十二辆"、旁白写阿拉伯"22 辆"也应命中（按数值）',
    facts: build([unitRows[0].replace('22辆; 二十二辆', '二十二辆')], [unitSecs[0]]), lines: L('22 辆车。') },
  { name: 'empty-script', expect: 0, why: '旁白全空时只验结构，不报"承重没出现"',
    facts: build(goodRows, goodSecs), lines: L(''), out: [/只验了 facts\.md 结构/], notOut: [/承重但旁白里没出现/] },

  // ---- 单位：必须红的（数字错、单位错、否决条目回写） ----
  { name: 'red-wrong-count', expect: 1, why: '"二十三辆"：数字错应被抓到',
    facts: unitFacts, lines: L('二十三辆车。'), err: [/二十三辆/] },
  { name: 'red-wrong-unit', expect: 1, why: '"二十二米"：数对、单位错（F01 要"辆"）应被抓到，并指出同值条目',
    facts: unitFacts, lines: L('二十二米长。'), err: [/单位对不上.*F01/] },
  { name: 'red-wrong-unit-2', expect: 1, why: '"230公里"：周长单位错应被抓到',
    facts: unitFacts, lines: L('周长 230 公里。') },
  { name: 'red-wrong-unit-en', expect: 1, why: '"30 mph"：英文单位不同应被抓到',
    facts: unitFacts, lines: [], also: ['onscreen.txt', '30 mph\n'] },
  { name: 'red-single-digit', expect: 1, why: '"五分钟"：单字数字 + 本片登记过的单位应进入对账（旧逻辑静默跳过）',
    facts: unitFacts, lines: L('五分钟后就堵了。'), err: [/五分钟/] },
  { name: 'red-rejected-number', expect: 1, why: '记忆错误登记为否决后，旁白里回写"二〇〇八年做的"应被抓到',
    facts: unitFacts, lines: L('这是二〇〇八年做的实验。'), err: [/R01\(否决\)/] },
  { name: 'red-rejected-term', expect: 1, why: '否决的专名"名古屋巨蛋"回写应被抓到',
    facts: unitFacts, lines: L('实验在名古屋巨蛋。'), err: [/R02\(否决\)/] },
  { name: 'red-prefix-guard', expect: 1, why: '"二月""千年"不能命中"两年""1000文"（旧回归保持）',
    facts: build(['| F01 | 两年一界 | 两年 | 数字 | 支撑 | 已核 | 高 |', '| F02 | 面值 | 1000文 | 数字 | 支撑 | 已核 | 高 |'],
                 [`### F01 x\n${SRC}`, `### F02 x\n${SRC}`]),
    lines: L('二月，千年。'), err: [/二月/, /千年/] },

  // ---- 已知的放过（不是 bug，是代价）：断言它们会在提示里露出来，而不是静默 ----
  { name: 'gap-bare-number', expect: 0, why: '裸数字"22"会放过"二十二米"——已知代价；必须在提示里点名',
    facts: build([unitRows[0].replace('22辆; 二十二辆', '22')], [unitSecs[0]]), lines: L('二十二米。'),
    out: [/裸数字匹配词.*F01\(22\)/] },
  { name: 'gap-single-undeclared', expect: 0, why: '"三头"：单字数字 + 没人登记的量词不对账——已知代价；必须在提示里点名',
    facts: unitFacts, lines: L('三头大象。'), out: [/没有对账：三头/] },
];

// ---- 真实片子：原样跑 ----
for (const d of opt.real) {
  const src = path.resolve(d);
  cases.push({ name: `real-${path.basename(src)}`, expect: 0, why: `真实片子 ${path.basename(src)} 原样（只读拷贝）不退化`,
    facts: fs.readFileSync(path.join(src, 'docs', 'facts.md'), 'utf8'),
    script: fs.readFileSync(path.join(src, 'script.json'), 'utf8'),
    snapshot: fs.existsSync(path.join(src, 'docs', 'memory-snapshot.md')) });
}

// ---- 幽灵堵车：在真实 facts.md 上改成文档的自然写法，再逐个改坏 ----
if (opt.ghost) {
  const src = path.resolve(opt.ghost);
  const realFacts = fs.readFileSync(path.join(src, 'docs', 'facts.md'), 'utf8');
  const realScript = JSON.parse(fs.readFileSync(path.join(src, 'script.json'), 'utf8'));
  // F-014 的原话：按文档写 `22辆`。真实文件里是绕过写法 `22; 二十二辆`。
  const natural = realFacts.replace(/^(\| F01 \|[^|]*\|)[^|]*\|/m, '$1 22辆 |');
  if (natural === realFacts) { process.stderr.write('selftest: ghost-jam 的 F01 行格式变了，改写失败\n'); process.exit(2); }
  const extra = { id: 's8', text: '周长两百三十米，司机按三十公里开，堵外的车能到四十公里，堵往后跑大约二十公里。' };
  const withLine = (patch) => JSON.stringify({ ...realScript, lines: [...realScript.lines.map(l => ({ ...l, text: patch(l) })), extra] });
  const keep = l => l.text;
  cases.push(
    { name: 'gj-natural', expect: 0, why: 'ghost-jam：F01 按文档写"22辆"，旁白加一句念出 230米/30/40/20公里，应通过',
      facts: natural, script: withLine(keep), snapshot: true },
    { name: 'gj-red-count', expect: 1, why: 'ghost-jam：旁白"二十三辆车"应红',
      facts: natural, script: withLine(l => l.id === 's1' ? l.text.replace('二十二', '二十三') : l.text), snapshot: true },
    { name: 'gj-red-unit', expect: 1, why: 'ghost-jam：周长念成"两百三十公里"应红',
      facts: natural, script: JSON.stringify({ ...realScript, lines: [...realScript.lines, { id: 's8', text: '周长两百三十公里。' }] }), snapshot: true },
    { name: 'gj-red-minutes', expect: 1, why: 'ghost-jam：F05 匹配"三分钟"，旁白说"五分钟"应红',
      facts: natural, script: withLine(l => l.id === 's5' ? '五分钟后，有车被逼停了。' : l.text), snapshot: true },
    { name: 'gj-red-rejected', expect: 1, why: 'ghost-jam：记忆错误 R02"名古屋巨蛋"回写进旁白应红',
      facts: natural, script: withLine(l => l.id === 's7' ? '这是在名古屋巨蛋做的实验。' : l.text), snapshot: true },
  );
}

let failed = 0;

// ---- 中文数字解析：直接抽出 FC 里的 CN_* 常量和 cnToNumber 求值（--fc 换旧版时同样适用） ----
// 口语省略末位单位：三百五 = 350、一万二 = 12000；有"零"才是末位：三百零五 = 305。
const CN_CASES = [
  ['三百五', 350], ['两千三', 2300], ['一万二', 12000], ['四万四', 44000],          // 省略末位单位
  ['两万五', 25000], ['一千二百三', 1230], ['十五万八', 158000], ['十万八', 108000],
  ['三亿五', 350000000], ['两千三百五', 2350], ['三百五万', 3500000],
  ['三百零五', 305], ['三百五十', 350], ['两千三百', 2300], ['一百零五', 105],      // 不能退化的对照
  ['二十二', 22], ['十万', 100000], ['三亿五千万', 350000000], ['一万零五百', 10500],
  ['三百五十万', 3500000], ['五十五', 55], ['十', 10], ['一〇二三', 1023], ['六一八', 618],
  ['一百二十五万', 1250000], ['二百八十九', 289],
];
{
  const src = fs.readFileSync(FC, 'utf8');
  const consts = src.match(/^const CN_[A-Z_]+ = .*$/gm) || [];
  const fn = src.match(/^function cnToNumber[\s\S]*?^}/m);
  let cn = null;
  try { cn = new Function(`${consts.join('\n')}\n${fn[0]}\nreturn cnToNumber;`)(); } catch (e) { console.log(`FAIL  cn-parse  抽不出 cnToNumber：${e.message}`); failed++; }
  if (cn) {
    const bad = CN_CASES.filter(([s, v]) => cn(s) !== v).map(([s, v]) => `${s} 得 ${cn(s)} 应 ${v}`);
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${'cn-parse'.padEnd(22)} ${CN_CASES.length - bad.length}/${CN_CASES.length}  中文数字解析（含口语省略末位单位）`);
    if (bad.length) console.log(bad.map(b => '      ✗ ' + b).join('\n'));
  }
}
// 端到端：省略写法后面直接跟量词
cases.push(
  { name: 'cn-elided-unit', expect: 0, why: '"三百五米"应 = 350米，命中匹配词 350米',
    facts: build(['| F01 | 长 350 米 | 350米 | 数字 | 支撑 | 已核 | 高 |'], [`### F01 x\n${SRC}`]), lines: L('全长三百五米。') },
  { name: 'red-cn-elided', expect: 1, why: '"三百五米"不能命中 305米（旧解析会放过）',
    facts: build(['| F01 | 长 305 米 | 305米 | 数字 | 支撑 | 已核 | 高 |'], [`### F01 x\n${SRC}`]), lines: L('全长三百五米。'),
    err: [/三百五米.*=350/] },
);

for (const c of cases) {
  const dir = path.join(root, c.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'film.json'), '{ "schema": 1 }\n');   // 片子的身份是 film.json；factcheck 只读文档，不要场景
  fs.writeFileSync(path.join(dir, 'docs', 'facts.md'), c.facts);
  // 合成用例都带一份记忆快照，免得提示里混进"缺快照"
  if (c.snapshot !== false) fs.writeFileSync(path.join(dir, 'docs', 'memory-snapshot.md'), '# 记忆快照（回归用例）\n');
  fs.writeFileSync(path.join(dir, 'script.json'), c.script ?? JSON.stringify({ lines: c.lines }, null, 2));
  const args = [FC, '--films-dir', root, '--film', c.name];
  if (c.also) { fs.writeFileSync(path.join(dir, c.also[0]), c.also[1]); args.push('--also', c.also[0]); }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const problems = [];
  if (r.status !== c.expect) problems.push(`exit=${r.status}，期望 ${c.expect}`);
  for (const re of c.out || []) if (!re.test(r.stdout)) problems.push(`stdout 里没有 ${re}`);
  for (const re of c.notOut || []) if (re.test(r.stdout)) problems.push(`stdout 里不该有 ${re}`);
  for (const re of c.err || []) if (!re.test(r.stderr)) problems.push(`stderr 里没有 ${re}`);
  const ok = !problems.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(22)} exit=${r.status} (期望 ${c.expect})  ${c.why}`);
  if (!ok) {
    console.log(`      ${problems.join('；')}`);
    console.log((r.stderr || r.stdout).trim().split('\n').slice(0, 8).map(l => '      ' + l).join('\n'));
  }
}
console.log(`\n${cases.length + 1 - failed}/${cases.length + 1} 通过（含 cn-parse）   factcheck: ${FC}   用例目录: ${root}`);
if (failed) { process.stderr.write(`selftest: ${failed} 个用例不符合预期\n`); process.exit(1); }
