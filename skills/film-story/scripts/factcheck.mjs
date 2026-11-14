#!/usr/bin/env node
// factcheck.mjs — 旁白 / 屏幕文字里的每个数字，都要在 docs/facts.md 里有账。
//
// 用法：
//   node <film-story>/scripts/factcheck.mjs --film <slug>
//        [--films-dir <dir>] [--also docs/onscreen.txt ...] [--strict] [--json]
//   films/ 的位置：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录
//
// 检查三件事：
//   1. 结构：facts.md 总表能解析；每条非"待核/免核"的事实有带 URL 的来源段；
//      "争议"至少两个来源；"建构"必须列锚点且锚点存在。
//   2. 对账：script.json 每行 text（及 --also 文件）里抽出的每个数字
//      （阿拉伯数字、中文数字、逐位读的年份"六一八"、"125万6340"）
//      都要命中一条事实，且状态可上片。匹配词写了单位（"22辆" "230米" "30 km/h"）时，
//      值相等且旁白里数后面以同一单位开头才算命中；单位是开放集，不查白名单。
//   3. 承重：承重事实不能是"单源/待核"；--strict 下单源、争议也算错误。
//
// 退出码：0 通过；1 有错误；2 前置条件缺失（文件不存在、格式坏）。

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, filmsDir, listFilms, FILM_OPTS } from '../../film-core/lib/film.mjs';
import { noFilmsDirMessage } from '../../film-core/lib/env.mjs';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const args = parseArgs({
  usage: 'node factcheck.mjs --film <slug> [--films-dir <dir>] [--also <file>]... [--strict] [--json]',
  about: '旁白 / 屏幕文字里的每个数字都要在 docs/facts.md 里有账。退出码 0 通过 / 1 有错误 / 2 前置条件缺失',
  opts: {
    ...FILM_OPTS,
    also: ['<file>', '额外对账的文字文件（相对片子目录，可重复）'],
    strict: '单源、争议也算错误',
    json: '输出 JSON',
  },
}, argv);
const opt = { also: [], strict: args.has('strict'), json: args.has('json') };
for (let i = 0; i < argv.length; i++) if (argv[i] === '--also') opt.also.push(argv[++i]);

function die(msg, code = 2) {
  process.stderr.write(`factcheck: ${msg}\n`);
  process.exit(code);
}

// 只读文档（facts.md、script.json），不需要场景：找片只认 films/<slug>/film.json，不校验内核字段、不要求入口页存在
const rootDir = filmsDir(args);
if (!fs.existsSync(rootDir)) die(noFilmsDirMessage());
const films = listFilms(rootDir);
opt.film = args.film ?? (films.length === 1 ? films[0] : null);
if (!opt.film) die(`${rootDir} 下有 ${films.length} 部片子，必须用 --film <slug> 指定：${films.join(', ')}`);
if (!films.includes(opt.film)) die(`找不到 ${path.join(rootDir, opt.film, 'film.json')}。现有影片：${films.join(' / ') || '（无）'}`);
const filmDir = path.join(rootDir, opt.film);
const factsPath = path.join(filmDir, 'docs', 'facts.md');
const scriptPath = path.join(filmDir, 'script.json');
if (!fs.existsSync(factsPath)) die(`缺 ${factsPath} —— 先做调研（film-story），再写旁白`);
if (!fs.existsSync(scriptPath)) die(`缺 ${scriptPath} —— 没有旁白可对账（film-narration 产出 script.json）`);

// ---------- 数字抽取 ----------
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG = { 万: 1e4, 亿: 1e8 };
// 单位/量词不是白名单，是**开放集**：匹配词里写了 `22辆` `230米` `30 km/h`，"辆""米""km/h"就是本片的单位。
// 对账时旁白里的数要值相等，且数后面的文字（跳过空白、"多/余/来"）以匹配词的单位开头。
//
// 下面这张表只管一件事：**单个**中文数字字（三、五、十、两…）什么时候算数字断言。
// 多位中文数字（二十二）和阿拉伯数字（22）一律抽，不看后面是什么。
// 单字要闸，是因为它大量出现在非数量用法里（十分、四周、三心二意）；
// "一"单独出现一律不算（一点、一滴、第一、一辆车）。
// 闸 = 这张常用量词表 ∪ 本片匹配词里声明过的单位（initUnits），所以片子自己登记的单位会自动生效；
// 两边都没有的被跳过，但跳过的会列进"提示"，不静默。
const BUILTIN_UNITS = [
  '年', '月', '日', '天', '岁', '倍', '成', '户', '界', '次', '届', '位', '名', '人', '座', '万', '亿',
  '里', '斤', '石', '贯', '缗', '文', '两', '钱', '%',
  '辆', '台', '架', '艘', '张', '本', '部', '集', '票', '只', '条', '颗', '枚', '个', '层',
  '秒', '分钟', '小时', '公里', '公斤', '吨', '元', '块',
];
let UNITS = BUILTIN_UNITS;
function initUnits(declared) {
  UNITS = [...new Set([...BUILTIN_UNITS, ...declared.filter(Boolean)])].sort((a, b) => b.length - a.length);
}
const squash = s => s.replace(/\s+/g, '');
// 数后面的"尾巴"：%（阿拉伯数字自带）+ 后文，去掉空白和约数词"多/余/来"（"八十多年""44 米"）
function tailOf(pct, after) { return squash((pct || '') + after).replace(/^[多余来]/, ''); }
function unitIn(tail) { return UNITS.find(u => tail.startsWith(squash(u))) || ''; }

function cnToNumber(s) {
  if (![...s].some(c => c in CN_UNIT || c in CN_BIG)) {
    // 逐位读：六一八 → 618，九〇七 → 907
    return Number([...s].map(c => CN_DIGIT[c]).join(''));
  }
  // 口语省略末位单位：紧跟在 百/千/万/亿 后、中间没有"零"的单个数字是下一级单位的系数
  // （三百五 = 350，一万二 = 12000，十万八 = 108000，三百五万 = 350万）；有"零"才是末位（三百零五 = 305）。
  let total = 0, section = 0, num = 0, lastUnit = 0, elide = false;
  const flush = () => { const n = elide && lastUnit >= 100 ? num * lastUnit / 10 : num; num = 0; elide = false; return n; };
  for (const c of s) {
    if (c in CN_DIGIT) { num = CN_DIGIT[c]; if (c === '零' || c === '〇') { lastUnit = 0; elide = false; } }
    else if (c in CN_UNIT) { section += (num || 1) * CN_UNIT[c]; num = 0; lastUnit = CN_UNIT[c]; elide = true; }
    else if (c in CN_BIG) { section += flush(); total += section * CN_BIG[c]; section = 0; lastUnit = CN_BIG[c]; elide = true; }
  }
  return total + section + flush();
}

const NUM_RE = /([0-9０-９](?:[0-9０-９]|[,，](?=[0-9０-９]{3}))*(?:\.[0-9]+)?)(?:([万亿])([0-9]+)?)?(%?)|([零〇一二两三四五六七八九十百千万亿]+)/g;

function toHalf(s) { return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); }

function numValue(m) {
  if (m[1] !== undefined) {
    const v = Number(toHalf(m[1]).replace(/[,，]/g, ''));
    return m[2] ? v * CN_BIG[m[2]] + (m[3] ? Number(m[3]) : 0) : v;
  }
  return cnToNumber(m[5]);
}

// skipped：收集被单字闸挡掉、但后面紧跟汉字的单字数字（"三头""两端"），给提示用
function extractNumbers(text, skipped) {
  const out = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0];
    const after = text.slice(m.index + raw.length);
    const tail = tailOf(m[4], after);
    if (m[5] !== undefined && m[5].length === 1) {
      if (m[5] === '一') continue;
      if (!unitIn(tail)) {
        if (skipped && /^\p{Script=Han}/u.test(after)) skipped.push(raw + after.slice(0, 1));
        continue;
      }
    }
    const value = numValue(m);
    if (!Number.isFinite(value)) continue;
    const unit = unitIn(tail);
    const shown = raw + (m[4] ? unit.slice(1) : unit);  // "28.65%" 的 % 已在 raw 里
    out.push({ raw, value, unit, tail, shown, index: m.index, end: m.index + raw.length,
               year: unit === '年' && value >= 100 && value <= 2100 });
  }
  return out;
}

// 匹配词 → { value, unit } 或 null（按原文子串匹配）。
//   "22辆" "二十二辆" "230米" "44 米" "30 km/h" "28.65%" "两年" → 数值 + 单位
//   "22" "125万" "八十"                                   → 数值，不带单位（命中任何单位的同值数）
//   "天圣二年" "一圈路" "一辆" "两年一界" "8f21ac0b"        → 原文（数字不在开头 / 开头是单独的"一" / 单位里夹数字）
const LEAD_RE = new RegExp('^(?:' + NUM_RE.source + ')');
function parseToken(tok) {
  const t = tok.trim();
  const m = t.match(LEAD_RE);
  if (!m || !m[0]) return null;
  if (m[5] === '一') return null;  // 旁白里单独的"一"从不当数字抽，匹配词也一致地按原文
  const unit = squash((m[4] || '') + t.slice(m[0].length));
  if (/[0-9０-９零〇一二三四五六七八九]/.test(unit)) return null;
  const value = numValue(m);
  return Number.isFinite(value) ? { value, unit } : null;
}

// ---------- facts.md 解析 ----------
// HTML 注释（含跨行）不是内容：模板里的示例 `### F02` / `锚点: F01, F03` 写在 <!-- --> 里，
// 不剥掉就会和用户真写的同名条目撞车。替换成等量换行，保留行号。
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, c => c.replace(/[^\n]/g, ''));
}
const md = stripComments(fs.readFileSync(factsPath, 'utf8'));
const KINDS = ['数字', '日期', '专名', '因果', '界面', '建构', '背景'];
const WEIGHTS = ['承重', '支撑', '点缀'];
const STATUSES = ['已核', '单源', '争议', '待核', '否决', '免核'];
const ONAIR_OK = new Set(['已核', '单源', '争议', '免核']);

const errors = [], warns = [], infos = [];

// 总表：表头必须含 id | 说法 | 匹配 | 类型 | 承重 | 状态
const lines = md.split('\n');
let header = null, facts = [];
for (let i = 0; i < lines.length; i++) {
  const L = lines[i].trim();
  if (!L.startsWith('|')) { if (header && facts.length) break; continue; }
  const cells = L.slice(1, L.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
  if (!header) {
    if (cells[0].toLowerCase() === 'id' && cells.includes('匹配') && cells.includes('状态')) header = cells;
    continue;
  }
  if (/^:?-{2,}/.test(cells[0])) continue;
  const row = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').replace(/`/g, '').trim()]));
  row._line = i + 1;
  facts.push(row);
}
if (!header) die(`${factsPath} 里找不到事实总表（表头需含 id | 说法 | 匹配 | 类型 | 承重 | 状态）。` +
  `从 film-story/assets/facts.template.md 拷表头`);
if (!facts.length) die(`${factsPath} 的事实总表是空的`);

// 详情段：### F01 ...  到下一个 ### 或 ## 为止
const sections = {}, dupSections = [];
{
  const re = /^###\s+([A-Za-z]+\d+)\b(.*)$/;
  let cur = null;
  for (const L of lines) {
    const m = L.match(re);
    if (m) {
      cur = m[1];
      if (cur in sections) dupSections.push(cur);
      sections[cur] = '';
      continue;
    }
    if (/^##\s/.test(L)) { cur = null; continue; }
    if (cur) sections[cur] += L + '\n';
  }
}

for (const id of new Set(dupSections))
  errors.push(`详情段 "### ${id}" 出现了不止一次 —— 后一段会覆盖前一段（模板里的占位段改掉，别另起一段）`);
const byId = {};
for (const f of facts) {
  const id = f.id;
  if (!/^[A-Za-z]+\d+$/.test(id)) { errors.push(`facts.md:${f._line} id "${id}" 不合法（用 F01 这种）`); continue; }
  if (byId[id]) errors.push(`facts.md:${f._line} id ${id} 重复`);
  byId[id] = f;
  if (!KINDS.includes(f['类型'])) errors.push(`${id} 类型 "${f['类型']}" 不在 ${KINDS.join('/')}`);
  if (!WEIGHTS.includes(f['承重'])) errors.push(`${id} 承重 "${f['承重']}" 不在 ${WEIGHTS.join('/')}`);
  if (!STATUSES.includes(f['状态'])) errors.push(`${id} 状态 "${f['状态']}" 不在 ${STATUSES.join('/')}`);

  const sec = sections[id];
  const urls = sec ? (sec.match(/https?:\/\/[^\s)>\]]+/g) || []) : [];
  f._urls = urls;
  const st = f['状态'];
  const deriv = (sec || '').match(/推导[:：]\s*(.*)/);
  if (deriv) f._derivedFrom = deriv[1].match(/[A-Za-z]+\d+/g) || [];
  if (['已核', '单源', '争议'].includes(st)) {
    if (!sec) errors.push(`${id} 状态是"${st}"，但没有 "### ${id}" 详情段写来源`);
    else if (!urls.length && !f._derivedFrom?.length) errors.push(`${id} 状态是"${st}"，详情段里既没有来源 URL 也没有"推导：<id>"`);
  }
  if (st === '已核' && !f._derivedFrom && urls.length < 2 && !/一手|原始|官方|primary/i.test(sec || ''))
    warns.push(`${id} 标"已核"但只有 ${urls.length} 个来源且未注明一手来源 —— 是不是该标"单源"？`);
  if (st === '争议' && urls.length < 2) errors.push(`${id} 标"争议"但来源少于 2 个 —— 分歧必须两边都有出处`);
  if (st === '争议' && !/片中措辞/.test(sec || '')) errors.push(`${id} 标"争议"但详情段没有"片中措辞"—— 20 秒里怎么说必须事先定`);
  if (st === '免核' && !/理由/.test(sec || '') && !f['说法']) errors.push(`${id} 标"免核"但没写理由`);
  if (f['类型'] === '建构') {
    const anchors = (sec || '').match(/锚点[:：]\s*(.*)/);
    if (!anchors) errors.push(`${id} 是"建构"但详情段没有"锚点："行`);
    else {
      const ids = anchors[1].match(/[A-Za-z]+\d+/g) || [];
      if (!ids.length) errors.push(`${id} 的锚点一条都没列`);
      f._anchors = ids;
    }
    if (!/呈现[:：]/.test(sec || '')) errors.push(`${id} 是"建构"但没写"呈现："（片中怎么避免被读成精确数据）`);
  }
  if (f['承重'] === '承重' && ['单源', '待核'].includes(st))
    (opt.strict ? errors : warns).push(`${id} 承重但状态是"${st}" —— 承重事实应至少两个独立来源或一手来源`);
  if (f['承重'] === '承重' && st === '否决') errors.push(`${id} 承重但已否决 —— 叙事骨架要改`);

  // 匹配词：数字值 + 文本词
  f._nums = []; f._terms = [];
  for (const tok of (f['匹配'] || '').split(/[;；]/).map(s => s.trim()).filter(Boolean)) {
    // 数字开头的词（"22辆" "230米" "两年" "1256340"）按数值 + 单位匹配，单位是数字后面的全部文字，
    // 不查任何白名单：旁白里的数值相等、且后文以这个单位开头才算命中（"二月"不命中"两年"，
    // "二十二米"不命中"22辆"）。不带单位的裸数字命中任何单位的同值数。
    // 其余（"天圣二年" "钱引" "一圈路"）按原文子串匹配，免得"二"误配所有的 2。
    const p = parseToken(tok);
    if (p) f._nums.push({ ...p, tok });
    else f._terms.push(tok);
  }
}
initUnits(facts.flatMap(f => (f._nums || []).map(n => n.unit)));
for (const f of facts) for (const a of f._derivedFrom || [])
  if (!byId[a]) errors.push(`${f.id} 推导自 ${a}，但总表里没有 ${a}`);
  else if (!['已核', '争议', '单源'].includes(byId[a]['状态'])) errors.push(`${f.id} 推导自 ${a}(${byId[a]['状态']})，推导基础必须有出处`);
for (const f of facts) for (const a of f._anchors || [])
  if (!byId[a]) errors.push(`${f.id} 的锚点 ${a} 在总表里不存在`);
  else if (!['已核', '争议', '单源'].includes(byId[a]['状态'])) errors.push(`${f.id} 的锚点 ${a} 状态是"${byId[a]['状态']}"，锚点必须有出处`);

// ---------- 对账 ----------
let script;
try { script = JSON.parse(fs.readFileSync(scriptPath, 'utf8')); }
catch (e) { die(`${scriptPath} 不是合法 JSON：${e.message}`); }
if (!Array.isArray(script.lines)) die(`${scriptPath} 没有 lines[] 数组`);

// Strip film-narration inline control markup ([#...], [停顿 0.6], [pause 600ms], [@id]...[@/id], and 【...】)
// before extracting numbers/terms from script.json, matching film-narration/scripts/_markup.py.
const INLINE_MARK = /\[([^\[\]]*)\]|【([^【】]*)】/g;
const INLINE_SPAN = /^[@＠]\/?\s*[0-9A-Za-z_.\-\u4e00-\u9fff]+$/;
const INLINE_PAUSE = /^(?:停顿|停|pause)\s*(?:[0-9]*\.?[0-9]+)\s*(?:ms|s|秒|毫秒)?$/i;
function stripInlineMarkup(s) {
  return String(s ?? '').replace(INLINE_MARK, (full, a, b) => {
    const body = (a ?? b).trim();
    if (body.startsWith('#') || body.startsWith('＃') || INLINE_SPAN.test(body) || INLINE_PAUSE.test(body)) return '';
    return full;
  });
}

const texts = script.lines.map((l, i) => ({ where: `script.json ${l.id ?? '#' + (i + 1)}`, text: stripInlineMarkup(l.text) }));
for (const f of opt.also) {
  const p = path.resolve(filmDir, f);
  if (!fs.existsSync(p)) die(`--also 指定的文件不存在：${p}`);
  stripComments(fs.readFileSync(p, 'utf8')).split('\n').forEach((t, i) => t.trim() && texts.push({ where: `${f}:${i + 1}`, text: t }));
}

const used = new Set();
const report = [];
const skipped = [];
const unitMatches = (v, n) => !v.unit || n.tail.startsWith(v.unit);
const scriptEmpty = !texts.some(t => t.text.trim());
for (const { where, text } of texts) {
  // 已被专名/说法匹配覆盖的区间（"天圣二年"）里的数字不再单独对账
  const covered = [];
  for (const f of facts) for (const t of f._terms) {
    let k = text.indexOf(t);
    while (k >= 0) { covered.push([k, k + t.length]); k = text.indexOf(t, k + 1); }
  }
  const sk = [];
  for (const n of extractNumbers(text, sk)) {
    if (covered.some(([a, b]) => n.index >= a && n.end <= b)) continue;
    const sameValue = v => Math.abs(v.value - n.value) < 1e-9;
    const hits = facts.filter(f => f._nums.some(v => sameValue(v) && unitMatches(v, n)));
    const entry = { where, text, raw: n.shown, value: n.value, unit: n.unit, year: n.year, facts: hits.map(h => h.id), level: 'ok', msg: '' };
    if (!hits.length) {
      entry.level = 'error';
      const shown = n.unit ? n.shown : n.raw + ((n.tail.match(/^[^，。、；：！？,.;:!?·()（）\-—]{0,3}/) || [''])[0]);
      const near = facts.flatMap(f => f._nums.filter(sameValue).map(v => `${f.id} 的"${v.tok}"要求单位"${v.unit}"`));
      entry.msg = `"${shown}"（=${n.value}${n.year ? '，年份或年数' : ''}）在 facts.md 里没有条目` +
        (near.length ? `（同值但单位对不上：${near.join('；')}）` : '') + ` —— 查出处，或登记为"免核"并写理由`;
    } else {
      hits.forEach(h => used.add(h.id));
      const bad = hits.filter(h => !ONAIR_OK.has(h['状态']));
      const cons = hits.filter(h => h['类型'] === '建构');
      const disp = hits.filter(h => h['状态'] === '争议');
      const single = hits.filter(h => h['状态'] === '单源');
      if (bad.length) { entry.level = 'error'; entry.msg = `命中 ${bad.map(h => `${h.id}(${h['状态']})`).join(',')}，状态不允许上片`; }
      else if (cons.length) { entry.level = 'error'; entry.msg = `命中建构 ${cons.map(h => h.id).join(',')}：解释性数值不能作为精确数字念出来/打出来`; }
      else if (disp.length) { entry.level = opt.strict ? 'error' : 'warn'; entry.msg = `命中争议条目 ${disp.map(h => h.id).join(',')}：确认措辞符合该条"片中措辞"`; }
      else if (single.length) { entry.level = opt.strict ? 'error' : 'warn'; entry.msg = `命中单源条目 ${single.map(h => h.id).join(',')}`; }
      else entry.msg = `→ ${hits.map(h => `${h.id}(${h['状态']})`).join(',')}`;
    }
    report.push(entry);
  }
  for (const f of facts) for (const t of f._terms) if (text.includes(t)) {
    used.add(f.id);
    if (!ONAIR_OK.has(f['状态'])) report.push({ where, text, raw: t, facts: [f.id], level: 'error', msg: `专名/说法"${t}"命中 ${f.id}(${f['状态']})，状态不允许上片` });
    else report.push({ where, text, raw: t, facts: [f.id], level: 'ok', msg: `→ ${f.id}(${f['状态']})` });
  }
  // 被术语覆盖的区间里的单字数字不算漏（"两年一界"里的"一"）
  for (const s of sk) { const k = text.indexOf(s); if (!covered.some(([a, b]) => k >= a && k < b)) skipped.push(`${s}(${where.replace(/^script\.json /, '')})`); }
}
if (scriptEmpty)
  infos.push('旁白和 --also 文本都是空的：只验了 facts.md 结构，没有对账（旁白写完再跑一次）');
else for (const f of facts) if (f['承重'] === '承重' && !used.has(f.id) && f['类型'] !== '建构')
  infos.push(`${f.id} 承重但旁白里没出现 —— 若只在画面里出现，用 --also 把屏幕文字也纳入对账`);
if (skipped.length)
  infos.push(`这些单字中文数字后面的字不是已知量词，没有对账：${[...new Set(skipped)].join('、')} —— ` +
    `若是数字断言，把它写进某条事实的匹配词（如"三头"），这个量词就被登记，之后自动对账`);
const bare = facts.filter(f => f['类型'] === '数字' && ['已核', '单源', '争议'].includes(f['状态']))
  .map(f => [f.id, f._nums.filter(v => !v.unit).map(v => v.tok)]).filter(([, t]) => t.length)
  .map(([id, t]) => `${id}(${t.join(' / ')})`);
if (bare.length)
  infos.push(`裸数字匹配词会命中任何单位的同值数（"22"也放过"22米"）：${bare.join('、')} —— 写上单位（"22辆"）能收紧`);
if (!fs.existsSync(path.join(filmDir, 'docs', 'memory-snapshot.md')))
  infos.push('没有 docs/memory-snapshot.md —— 搜索前的记忆快照是这道门之外唯一能抓"记错了"的环节，见 SKILL.md「调研与事实对账」');

for (const r of report) if (r.level === 'error') errors.push(`${r.where}: ${r.msg}`); else if (r.level === 'warn') warns.push(`${r.where}: "${r.raw}" ${r.msg}`);

// ---------- 输出 ----------
if (opt.json) {
  console.log(JSON.stringify({ film: opt.film, facts: facts.length, report, errors, warns, infos }, null, 2));
} else {
  console.log(`factcheck  ${path.relative(process.cwd(), filmDir) || filmDir}`);
  console.log(`  facts.md: ${facts.length} 条（${STATUSES.map(s => `${s} ${facts.filter(f => f['状态'] === s).length}`).join(' / ')}）`);
  console.log(`  对账文本: ${texts.length} 行，抽出数字/专名 ${report.length} 处\n`);
  let last = null;
  for (const r of report) {
    if (r.where !== last) { console.log(`  [${r.where}] ${r.text}`); last = r.where; }
    const tag = { ok: '  ok  ', warn: ' WARN ', error: ' FAIL ' }[r.level];
    console.log(`   ${tag} ${r.raw.padEnd(10)} ${r.msg}`);
  }
  if (infos.length) { console.log('\n  提示:'); infos.forEach(s => console.log(`   - ${s}`)); }
  if (warns.length) { console.log('\n  警告:'); warns.forEach(s => console.log(`   - ${s}`)); }
  console.log(`\n  结果: ${errors.length} 错误, ${warns.length} 警告`);
}
if (errors.length) {
  process.stderr.write(`factcheck: ${errors.length} 处错误\n` + errors.map(e => `  - ${e}`).join('\n') + '\n');
  process.exit(1);
}
