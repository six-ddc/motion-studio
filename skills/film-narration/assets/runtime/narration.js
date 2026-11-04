// film-narration 运行时：读 narration.json，把「第几秒」换成「某个字被念到的那一刻」。只出时间数据，不画字。
// scene.html 里 import './runtime/narration.js'（套件挂载；交付时冻结进片子）。
// 字幕：本文件给 captionAt(t) 这块字幕的时间数据（哪些词、各词起止、正在念第几个）；
// 怎么画（字体、颜色、逐词填色）归 film-typography 的 runtime/text.js（把 cap 原样交给它的字幕绘制函数）。
//
// 动画事件不绑死在 3.2s，绑在 vo.at('纯函数')。旁白重录、语速一改，时间戳跟着变，
// 动画自动跟上，不用手改一个数。
//
// 纯函数：除了 loadNarration 的一次 fetch，所有方法只读数据，不带状态，可按任意 t 求值。

// 片头留白：film.json 的 narrationOffset（秒，缺省 0）= 旁白音频第 0 秒落在成片的第几秒。
// 这是全片唯一的真相源：本运行时、sfx.mjs、subs.py、mux.sh、align.py --verify、film-critique 的 check.mjs 都读它。
// loadNarration 自动读取并把**所有时刻平移成成片时间**——vo.at()/line()/captionAt(t) 的 t 都是成片秒，
// 场景里不要再自己加留白（加了就是两遍）。narration.json 本身的时刻始终是旁白音频内的秒，不平移。
export async function loadNarration(url = './narration.json', { offset, tail } = {}) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读不到 ${url}（先跑 film-narration 的 scripts/tts.py --film <slug>）`);
  const data = await res.json();
  if (offset == null) {
    // film.json 和 narration.json 同在片子根目录
    const fu = new URL('film.json', new URL(url, globalThis.location?.href));
    const fr = await fetch(fu, { cache: 'no-store' });
    if (!fr.ok) throw new Error(`读不到 ${fu.pathname}：片头留白 narrationOffset 记在那里。确实没有 film.json 时显式传 loadNarration(url, { offset: 0 })`);
    const film = await fr.json();
    offset = film.narrationOffset ?? 0;
    tail ??= film.narrationTail ?? 0;
  }
  return makeNarration(data, { offset, tail: tail ?? 0 });
}

const PUNCT = /[\s，。、；：！？,.;:!?"'“”‘’()（）《》—…·\-]/g;
const PUNCT_END = /[，。、；：！？,.;:!?]$/;
const key = (s) => String(s).replace(PUNCT, '').toLowerCase();
const wlen = (s) => [...s].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 0.55 : 1), 0);

/** 与 scripts/subs.py 的 chunk_words 同一算法：先按标点切意群，超长意群均分，再装箱。 */
export function chunkWords(words, maxChars) {
  const phrases = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (PUNCT_END.test(w.w)) { phrases.push(cur); cur = []; }
  }
  if (cur.length) phrases.push(cur);
  const pieces = [];
  for (const ph of phrases) {
    const total = ph.reduce((n, w) => n + wlen(w.w), 0);
    const n = Math.max(1, Math.ceil(Math.ceil(total - 1e-9) / maxChars));
    if (n === 1) { pieces.push(ph); continue; }
    const target = total / n;
    let part = [], acc = 0, k = 1;
    for (const w of ph) {
      part.push(w); acc += wlen(w.w);
      if (acc >= target * k - 1e-6 && k < n) { pieces.push(part); part = []; k++; }
    }
    if (part.length) pieces.push(part);
  }
  const chunks = [];
  let box = [], len = 0;
  for (const pc of pieces) {
    const L = pc.reduce((n, w) => n + wlen(w.w), 0);
    if (box.length && len + L > maxChars) { chunks.push(box); box = []; len = 0; }
    box = box.concat(pc); len += L;
  }
  if (box.length) chunks.push(box);
  return chunks;
}

const isLatin = (c) => /[A-Za-z0-9]/.test(c ?? '');
/** 拉丁词与相邻字之间补空格（接口返回的 token 不带空格）。返回每个词前面要不要空格。 */
export function spacing(words) {
  return words.map((w, i) => {
    if (!i) return '';
    const prev = words[i - 1].w;
    return (isLatin(prev.at(-1)) || isLatin(w.w[0])) && !PUNCT_END.test(prev) ? ' ' : '';
  });
}

/** 无状态便捷入口：findKeyword(narrationJson, '公开') -> { start, end, first, last }，查不到抛错。
 *  Node 里也能用：import { findKeyword } from '<film-narration>/assets/runtime/narration.js'。 */
export function findKeyword(data, keyword, nth = 1) {
  return makeNarration(data).locate(keyword, nth);
}

/** makeNarration(data, { offset, tail })：offset 缺省 0 = 旁白音频时间（Node 里给别的 skill 用的默认）；
 *  要成片时间就传 film.json 的 narrationOffset。 */
export function makeNarration(data, { offset = 0, tail = 0 } = {}) {
  if (!Array.isArray(data?.words) || !Array.isArray(data?.lines)) {
    throw new Error('narration.json 缺 words/lines，不是 film-narration 产出的格式');
  }
  for (const [k, v] of [['narrationOffset', offset], ['narrationTail', tail]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`film.json 的 ${k} 必须是 ≥ 0 的秒数，收到 ${JSON.stringify(v)}`);
    }
  }
  const sh = (w) => {
    const y = { ...w, start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3) };
    if (w.parts) y.parts = w.parts.map(sh);
    return y;
  };
  const words = data.words.map((w) => ({ ...sh(w), k: key(w.w) }));
  const lines = data.lines.map((l) => ({ ...l, ...sh(l), words: (l.words ?? []).map(sh) }));
  // 语义区间：script.json 台词里 [@id]…[@/id] 投影出的 {start, end, line, text}（tts.py 写；没写标记的片子没有这个键）
  const spans = Object.fromEntries(Object.entries(data.spans ?? {}).map(([id, v]) => [id, { ...v, ...sh(v) }]));

  // 把全部词的 key 拼成一条字符流，记住每个字属于哪个词。
  // 关键词在字符流里查，且必须**落在词边界上**——
  // 旧实现用 includes 双向模糊匹配，at('安史') 会命中「长安」的「安」，
  // 标点 token（key 为空串）会匹配任何词。
  let stream = '';
  const owner = [];       // 字符下标 -> 词下标
  const wordStart = new Set();
  words.forEach((w, i) => {
    wordStart.add(stream.length);
    for (const c of w.k) { owner.push(i); stream += c; }
  });
  const wordEndAt = (pos) => pos === stream.length || wordStart.has(pos);

  function find(keyword, nth) {
    const k = key(keyword);
    if (!k) throw new Error(`关键词「${keyword}」去掉标点后为空`);
    let from = 0, seen = 0;
    for (;;) {
      const pos = stream.indexOf(k, from);
      if (pos < 0) break;
      if (wordStart.has(pos) && wordEndAt(pos + k.length) && ++seen === nth) {
        return [owner[pos], owner[pos + k.length - 1]];
      }
      from = pos + 1;
    }
    // 静默返回 0 会让错位悄悄漂进成片 —— 宁可当场炸，让人在静帧闸门前就看见。
    throw new Error(`旁白里找不到「${keyword}」第 ${nth} 次出现（共见到 ${seen} 次）。` +
      `可能原因：脚本改了没重跑 tts.py；发音词典的文本转写改写了 token（看 alias 字段）；` +
      `关键词跨了词边界。narration.json 里有：${words.slice(0, 60).map((w) => w.w).join(' ')}`);
  }

  return {
    raw: data,
    /** 片头留白（秒），来自 film.json narrationOffset。所有时刻已经加过它 */
    offset,
    /** 片尾留白（秒），来自 film.json narrationTail */
    tail,
    /** 旁白在成片里念完的时刻 = offset + 旁白音频长度（即 shotlist 的 vo.end） */
    duration: offset + (data.duration ?? 0),
    /** 成片总长 = duration + tail；window.DURATION 通常取它 */
    filmDuration: offset + (data.duration ?? 0) + tail,
    words,
    lines,
    spans,

    /** 底层查找：{ start, end, first, last }（first/last 是 words 下标）。查不到抛错。
     *  其他 skill（film-critique 等）要判断「关键词在不在旁白里」时用它或 findKeyword()，
     *  不要按整词 token 自己实现——中文 token 通常是单字，「公开」是 公 + 开 两个 token。 */
    locate(keyword, nth = 1) {
      const [first, last] = find(keyword, nth);
      return { start: words[first].start, end: words[last].end, first, last };
    },

    /** 关键词开始被念出的时刻（秒）。nth 从 1 起，支持重复词。查不到就抛错。 */
    at(keyword, nth = 1) { return words[find(keyword, nth)[0]].start; },

    /** 关键词念完的时刻 */
    endOf(keyword, nth = 1) { return words[find(keyword, nth)[1]].end; },

    /** 某词开始之后 delta 秒（delta 可为负：提前量） */
    after(keyword, delta = 0, nth = 1) { return this.at(keyword, nth) + delta; },

    /** 两种写法：
     *  span('rule')         script.json 台词里 [@rule]…[@/rule] 标出的语义区间 { start, end, line, text }
     *  span('从', '到')      两个关键词之间：第一个开始念 → 第二个念完
     *  区间 id 查不到抛错（同 at()：静默给个 0 会让事件跑到片头）。 */
    span(fromWord, toWord) {
      if (toWord === undefined) {
        const v = Object.hasOwn(spans, fromWord) ? spans[fromWord] : null;
        if (!v) {
          const have = Object.keys(spans);
          throw new Error(`narration.json 里没有区间「${fromWord}」。` +
            (have.length ? `现有：${have.join(' ')}。` : '这支片子一个区间都没有：在 script.json 台词里写 [@id]…[@/id]，再跑 tts.py（只改了区间时 tts.py --spans 就够，不重新合成）。') +
            `要按两个关键词取区间写 vo.span('从', '到')`);
        }
        return v;
      }
      return { start: this.at(fromWord), end: this.endOf(toWord) };
    },

    /** 某一句（按 id）{ id, text, start, end, duration, words } —— 镜头边界由它定，不手填 */
    line(id) {
      const ln = lines.find((l) => l.id === id);
      if (!ln) throw new Error(`narration.json 里没有句子 ${id}，现有：${lines.map((l) => l.id).join(' ')}`);
      return ln;
    },

    /** t 时刻正在念的词；句间停顿返回 null */
    activeWord(t) { return words.find((w) => t >= w.start && t < w.end) ?? null; },

    /** t 时刻该显示的字幕块 { text, words, spaces, start, end, activeIndex, progress, t }（纯数据）。
     *  spaces[i] 是第 i 个词前要补的空格（拉丁词与相邻字之间）；progress 是当前词内的 0..1 进度。句间停顿返回 null。
     *  绘制交给 film-typography 的 runtime/text.js。 */
    captionAt(t, { maxChars = 16, hold = 0 } = {}) {
      const ln = lines.find((l) => t >= l.start && t < l.end + hold);
      if (!ln || !ln.words.length) return null;
      const chunks = chunkWords(ln.words, maxChars);
      const chunk = chunks.find((c, i) => t < (chunks[i + 1]?.[0].start ?? Infinity)) ?? chunks.at(-1);
      if (t < chunk[0].start) return null;
      const spaces = spacing(chunk);
      const activeIndex = chunk.findIndex((w) => t >= w.start && t < w.end);
      const aw = chunk[activeIndex];
      return {
        text: chunk.map((w, i) => spaces[i] + w.w).join(''),
        words: chunk, spaces,
        start: chunk[0].start, end: chunk.at(-1).end,
        activeIndex, t,
        progress: aw ? (t - aw.start) / (aw.end - aw.start) : 0,
      };
    },
  };
}
