// film-core 运行时 · 内容数据层（可选）：一份源 × 多份数据
//
// 片子目录里有 content.json 时，画面上的文字、素材路径、品牌色/字体 token、少量命名参数从它读，
// 动画代码只管"怎么画"。变体（hook 两版、CTA 两版、画幅各一版……）只覆盖这几样数据，不改动画代码，
// 所以一份 scene.html 能渲出整张变体矩阵，而不是 new-film --from 拷出 N 份会各自漂走的副本。
// schema 与语义：film-core references/content-json.md。
//
// 用法（场景加载期，一次）：
//   import { loadContent } from './runtime/content.js';
//   const C = await loadContent();          // 读片子根目录的 content.json，按 URL ?variant=<id>&format=<key> 合并
//   C.text('cta.url')  C.asset('logo')  C.color('orange')  C.font('sans')  C.param('hold')  C.id  C.picks
//   window.CONTENT === C                    // 评审、预检等外部工具读同一份
//
// 契约：合并在加载期一次做完（fetch 是唯一的异步，发生在 seek 之前）；seek 里只读 C，读的结果只取决于
// content.json 和 URL —— 和 layoutFromURL 一样，URL 是变体的唯一来源。C.text() 取不存在的槽位直接抛错
// （拼错的槽位名静默画出空串是最难发现的那种错）。
//
// 本文件同时被 Node 侧（render.mjs）import 来解析变体与矩阵：除 loadContent 外全是纯函数，不碰 DOM、不读时钟。

export const CONTENT_SCHEMA = 1;
const DIM = /^[a-z][a-z0-9]*$/;          // 维度名：hook、cta、format……（不含连字符，变体 id 才能无歧义地拆回去）
const OPT = /^[a-z0-9]+$/;               // 选项名：a、b、16x9……
const SLOT = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;   // 槽位 / 素材 / 参数 id
const OVERRIDABLE = ['text', 'assets', 'brand', 'params'];

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** 槽位的两种写法：'文本' 或 { text, maxChars?, box?, lang?, code?, locked?, note? } → 统一成对象 */
export function normalizeSlot(v) {
  if (typeof v === 'string') return { text: v };
  if (isObj(v) && typeof v.text === 'string') return { ...v };
  return null;
}

/** 键序稳定的 JSON（内容哈希用：同一份内容不因键序不同而哈希不同） */
export function stableStringify(x) {
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** 变体维度（声明顺序，不含 format：画幅另由 ?format= 决定） */
export const variantDims = (doc) => Object.keys(doc?.variants ?? {}).filter((d) => d !== 'format');

/** 校验 content.json，返回错误字符串数组（空 = 合法）。只查结构，不查文件存在、不查字数（那是 preflight 的事） */
export function validateContent(doc) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (!isObj(doc)) return ['content.json 顶层要是对象'];
  if (doc.schema !== CONTENT_SCHEMA) bad(`schema 必须是 ${CONTENT_SCHEMA}（收到 ${JSON.stringify(doc.schema)}）`);
  const text = doc.text ?? {}, assets = doc.assets ?? {}, params = doc.params ?? {}, brand = doc.brand ?? {};
  if (!isObj(text)) bad('text 要是对象 { 槽位id: "文本" | {text, maxChars?, box?, lang?, code?, locked?} }');
  else for (const [k, v] of Object.entries(text)) {
    if (!SLOT.test(k)) bad(`text 槽位 id "${k}" 不合法（字母开头，[A-Za-z0-9_.-]）`);
    const s = normalizeSlot(v);
    if (!s) { bad(`text.${k} 要是字符串或含 text 字段的对象`); continue; }
    if (s.maxChars != null && !(Number.isInteger(s.maxChars) && s.maxChars > 0)) bad(`text.${k}.maxChars 要是正整数`);
    if (s.box != null && !isObj(s.box)) bad(`text.${k}.box 要是对象`);
  }
  if (!isObj(assets)) bad('assets 要是对象 { id: "相对片子目录的路径" }');
  else for (const [k, v] of Object.entries(assets)) if (!SLOT.test(k) || typeof v !== 'string') bad(`assets.${k} 要是路径字符串（id 字母开头，[A-Za-z0-9_.-]）`);
  if (!isObj(params)) bad('params 要是对象 { 名字: 值 }');
  if (!isObj(brand)) bad('brand 要是对象（colors / fonts / look）');
  if (doc.claims != null) {
    if (!Array.isArray(doc.claims)) bad('claims 要是数组 [{ text, source, slots? }]');
    else doc.claims.forEach((c, i) => {
      if (!isObj(c) || typeof c.text !== 'string' || typeof c.source !== 'string' || !c.source.trim()) bad(`claims[${i}] 要有 text 和非空 source（宣传数据必须有来源）`);
    });
  }
  const V = doc.variants ?? {};
  if (!isObj(V)) bad('variants 要是对象 { 维度: { 选项: 覆盖 } }');
  else for (const [dim, opts] of Object.entries(V)) {
    if (!DIM.test(dim)) bad(`变体维度名 "${dim}" 不合法（小写字母开头，只含 [a-z0-9]，不含连字符）`);
    if (!isObj(opts) || !Object.keys(opts).length) { bad(`variants.${dim} 要是非空对象 { 选项: 覆盖 }`); continue; }
    for (const [opt, ov] of Object.entries(opts)) {
      const where = `variants.${dim}.${opt}`;
      if (!OPT.test(opt)) bad(`${where}：选项名只含 [a-z0-9]`);
      if (dim === 'format' && !['9x16', '1x1', '16x9'].includes(opt)) bad(`${where}：format 维度的选项必须是画幅 key（9x16 / 1x1 / 16x9）`);
      if (!isObj(ov)) { bad(`${where} 要是对象（{} = 不覆盖）`); continue; }
      const extra = Object.keys(ov).filter((k) => !OVERRIDABLE.includes(k) && k !== 'note');
      if (extra.length) bad(`${where}：变体只能覆盖 ${OVERRIDABLE.join(' / ')}（不改动画代码），不认识 ${extra.join(', ')}`);
      for (const [k] of Object.entries(isObj(ov.text) ? ov.text : {})) {
        if (!Object.hasOwn(text, k)) bad(`${where}.text.${k}：基础 text 里没有这个槽位（变体只能改已有槽位，防拼错）`);
        else if (normalizeSlot(text[k])?.locked) bad(`${where}.text.${k}：槽位是 locked（与旁白/时间真相源绑定），变体不能改`);
      }
      for (const k of Object.keys(isObj(ov.assets) ? ov.assets : {})) if (!Object.hasOwn(assets, k)) bad(`${where}.assets.${k}：基础 assets 里没有这个 id`);
      for (const k of Object.keys(isObj(ov.params) ? ov.params : {})) if (!Object.hasOwn(params, k)) bad(`${where}.params.${k}：基础 params 里没有这个名字（命名参数要先在基础里声明）`);
    }
  }
  if (doc.matrix != null && !Array.isArray(doc.matrix) && !isObj(doc.matrix)) bad('matrix 要是组合数组，或 { product, exclude?, include?, formats? }');
  return errs;
}

// 一个变体选项叠到当前内容上（就地改 R）
function apply(R, ov) {
  for (const [k, v] of Object.entries(ov.text ?? {})) {
    const s = typeof v === 'string' ? { text: v } : v;
    R.text[k] = { ...R.text[k], ...s };
  }
  for (const [k, v] of Object.entries(ov.assets ?? {})) R.assets[k] = v;
  for (const [k, v] of Object.entries(ov.params ?? {})) R.params[k] = clone(v);
  const deep = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = isObj(v) && isObj(a[k]) ? deep({ ...a[k] }, v) : clone(v); return a; };
  if (ov.brand) R.brand = deep({ ...R.brand }, ov.brand);
}

/** 变体 id 规范写法：按维度声明顺序 "<维度>-<选项>" 用 "." 连接，例 "hook-b.cta-a"；什么都不选 = "base" */
export function variantId(doc, picks) {
  const parts = variantDims(doc).filter((d) => picks[d] != null).map((d) => `${d}-${picks[d]}`);
  return parts.length ? parts.join('.') : 'base';
}

/** "hook-b.cta-a" / "base" / null → { picks, id }；维度或选项不存在直接抛错 */
export function parseVariant(doc, spec) {
  const picks = {};
  if (spec != null && spec !== '' && spec !== 'base') {
    for (const part of String(spec).split('.')) {
      const i = part.indexOf('-');
      const dim = i > 0 ? part.slice(0, i) : '', opt = i > 0 ? part.slice(i + 1) : '';
      if (!dim || dim === 'format') throw new Error(`变体 "${spec}" 里的 "${part}" 不是 <维度>-<选项>（画幅不进变体 id，用 --format / ?format=）`);
      // 查表一律 Object.hasOwn：hook-constructor、constructor-a 这类名字不能命中原型链
      const opts = isObj(doc?.variants) && Object.hasOwn(doc.variants, dim) ? doc.variants[dim] : null;
      if (!opts) throw new Error(`变体 "${spec}"：没有维度 ${dim}（有 ${variantDims(doc).join(' / ') || '（无）'}）`);
      if (!Object.hasOwn(opts, opt)) throw new Error(`变体 "${spec}"：维度 ${dim} 没有选项 ${opt}（有 ${Object.keys(opts).join(' / ')}）`);
      if (Object.hasOwn(picks, dim)) throw new Error(`变体 "${spec}"：维度 ${dim} 出现了两次`);
      picks[dim] = opt;
    }
  }
  return { picks, id: variantId(doc, picks) };
}

/**
 * 合并出生效内容：基础 → 各维度选项（按 variants 声明顺序）→ format 维度（有 format 且声明了该画幅时）。
 * variant 可以是 id 字符串或 picks 对象。返回纯数据（可 JSON 化、可哈希）。
 */
export function resolveContent(doc, { variant = null, format = null } = {}) {
  const errs = validateContent(doc);
  if (errs.length) throw new Error(`content.json 不合法：\n  - ${errs.join('\n  - ')}`);
  const { picks, id } = isObj(variant) ? { picks: variant, id: variantId(doc, variant) } : parseVariant(doc, variant);
  const R = {
    id, picks: { ...picks }, format: format ?? null,
    brand: clone(doc.brand ?? {}),
    assets: { ...(doc.assets ?? {}) },
    text: Object.fromEntries(Object.entries(doc.text ?? {}).map(([k, v]) => [k, normalizeSlot(v)])),
    params: clone(doc.params ?? {}),
    claims: clone(doc.claims ?? []),
  };
  for (const d of variantDims(doc)) if (picks[d] != null) apply(R, doc.variants[d][picks[d]]);
  if (format && isObj(doc.variants?.format) && Object.hasOwn(doc.variants.format, format)) apply(R, doc.variants.format[format]);
  return R;
}

/**
 * 要导出的组合 → [{ id, picks, formats }]（formats = null 表示"按 film.json 的画幅"）。
 *   matrix 缺省              全部维度的笛卡尔积
 *   matrix: [ {hook:"a", cta:"b", format?: "16x9" | ["16x9","9x16"]}, … ]    显式列表（缺的维度 = 基础）
 *   matrix: { product: ["hook","cta"], exclude: [{hook:"b", cta:"b"}], include: [ … ], formats: [ … ] }
 * 画幅：组合自带 format(s) > matrix.formats > variants.format 的全部选项 > null。
 */
export function expandMatrix(doc) {
  const M = doc.matrix;
  const dims = variantDims(doc);
  const fmtAll = doc.variants?.format ? Object.keys(doc.variants.format) : null;
  const fmtsOf = (e) => (e?.format ? [].concat(e.format) : e?.formats ? [].concat(e.formats) : null);
  const product = (ds) => ds.reduce((acc, d) => acc.flatMap((p) => Object.keys(doc.variants[d]).map((o) => ({ ...p, [d]: o }))), [{}]);
  const pickOnly = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'format' && k !== 'formats'));
  let entries;
  if (M == null) entries = product(dims).map((p) => ({ picks: p, formats: null }));
  else if (Array.isArray(M)) entries = M.map((e) => ({ picks: pickOnly(e), formats: fmtsOf(e) }));
  else {
    const ds = M.product ?? dims;
    for (const d of ds) if (!dims.includes(d)) throw new Error(`matrix.product 里的维度 ${d} 不在 variants 里`);
    // exclude 每条都要能命中组合：拼错的维度/选项会静默一个都不排除，剥成空对象的条目会排除全部——都直接报错
    const ex = (M.exclude ?? []).map((x, i) => {
      const where = `matrix.exclude[${i}] ${JSON.stringify(x)}`;
      if (!isObj(x)) throw new Error(`${where} 要是对象 { 维度: 选项 }`);
      for (const [k, v] of Object.entries(x)) {
        if (k === 'format' || k === 'formats') throw new Error(`${where}：format 不参与组合（画幅由 matrix.formats / 组合自带的 format 决定），exclude 不能按画幅排除`);
        if (!ds.includes(k)) throw new Error(`${where}：维度 ${k} ${dims.includes(k) ? '不在 matrix.product 里' : '不在 variants 里'}（product：${ds.join(' / ') || '（无）'}）`);
        if (!Object.hasOwn(doc.variants[k], v)) throw new Error(`${where}：维度 ${k} 没有选项 ${v}（有 ${Object.keys(doc.variants[k]).join(' / ')}）`);
      }
      if (!Object.keys(x).length) throw new Error(`${where}：空条目会排除全部组合，写明要排除的 { 维度: 选项 }`);
      return x;
    });
    const hit = (p) => ex.some((x) => Object.entries(x).every(([k, v]) => p[k] === v));
    entries = product(ds).filter((p) => !hit(p)).map((p) => ({ picks: p, formats: fmtsOf(M) }))
      .concat((M.include ?? []).map((e) => ({ picks: pickOnly(e), formats: fmtsOf(e) ?? fmtsOf(M) })));
  }
  const seen = new Map();
  for (const e of entries) {
    const { picks, id } = parseVariant(doc, variantId(doc, e.picks));   // 顺带校验维度与选项
    for (const f of e.formats ?? []) if (!['9x16', '1x1', '16x9'].includes(f)) throw new Error(`matrix 组合 ${id} 的画幅 ${f} 不认识`);
    const formats = e.formats ?? fmtAll;
    if (seen.has(id)) { const s = seen.get(id); if (formats && s.formats) s.formats = [...new Set([...s.formats, ...formats])]; else s.formats = null; }
    else seen.set(id, { id, picks, formats });
  }
  return [...seen.values()];
}

/** 生效内容里出现在画面上的全部文字（预加载字体分片、子集化收字用） */
export const contentStrings = (R) => Object.values(R.text).map((s) => s.text).join('');

/** 包一层取值器。取不存在的 id 一律抛错 */
export function contentApi(R) {
  const need = (table, kind, k) => {
    if (!Object.hasOwn(table, k)) throw new Error(`content.json 没有${kind} "${k}"（有 ${Object.keys(table).join(' / ') || '（无）'}）`);
    return table[k];
  };
  return Object.freeze({
    id: R.id, picks: Object.freeze({ ...R.picks }), format: R.format, data: R,
    text: (k) => need(R.text, '文本槽位', k).text,
    slot: (k) => ({ ...need(R.text, '文本槽位', k) }),
    asset: (k) => need(R.assets, '素材', k),
    param: (k) => need(R.params, '参数', k),
    color: (k) => need(R.brand.colors ?? {}, ' brand.colors', k),
    font: (k) => need(R.brand.fonts ?? {}, ' brand.fonts', k),
    strings: () => contentStrings(R),
  });
}

const loading = new Map();
/**
 * 加载期调用一次：fetch 片子根目录的 content.json（运行时挂在 /runtime/，所以默认是 ../content.json），
 * 按 URL 的 ?variant= 与 ?format= 合并，返回取值器并挂到 window.CONTENT。同一个 URL 多处调用只取一次。
 */
export function loadContent({ url = new URL('../content.json', import.meta.url).href, search = globalThis.location?.search ?? '' } = {}) {
  const q = new URLSearchParams(search);
  const key = `${url}?${q.get('variant') ?? ''}&${q.get('format') ?? ''}`;
  if (!loading.has(key)) {
    loading.set(key, (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`读不到 ${url}（HTTP ${res.status}）：用 loadContent 的片子要在根目录放 content.json`);
      const C = contentApi(resolveContent(await res.json(), { variant: q.get('variant'), format: q.get('format') }));
      globalThis.CONTENT = C;
      return C;
    })());
  }
  return loading.get(key);
}
