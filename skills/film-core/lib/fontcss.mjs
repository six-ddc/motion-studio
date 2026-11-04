// film-core lib · 解析 @font-face CSS、字体栈、系统字体名（内核门 font_source 用；film-assets 的字体工具经 '../../film-core/lib/fontcss.mjs' 复用）。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const prop = (body, name) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'))?.[1].trim() ?? null;

/** 解析 CSS 文件里的 @font-face。path = url() 相对 CSS 解析后的本地路径（外链/data: 为 null）。 */
export function parseFontFaceCss(cssPath) {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map((m, index) => {
    const body = m[1], src = prop(body, 'src') ?? '';
    const urls = [...src.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)].map((u) => u[1]);
    const url = urls.find((u) => /\.woff2(?:[?#]|$)/i.test(u)) ?? urls[0] ?? null;
    const local = url && !/^[a-z][a-z0-9+.-]*:/i.test(url);
    return {
      index,
      family: (prop(body, 'font-family') ?? '').replace(/^['"]|['"]$/g, ''),
      style: prop(body, 'font-style') ?? 'normal',
      weight: prop(body, 'font-weight') ?? 'normal',
      unicodeRange: prop(body, 'unicode-range'),
      url,
      path: local ? resolve(dirname(cssPath), url.split(/[?#]/)[0]) : null,
      hasLocal: /local\(/i.test(src),
    };
  });
}

export const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset']);

// 各平台随系统带的字体族名。用途是**认出来**并说清楚"这是哪台机器上的字"——
// 判定本身不靠这张表：不在随片声明里的族名一律不合格，表只决定报错措辞。
// 这张表不可能列全；漏掉的名字照样会被判不合格（"未随片打包"），只是少一句"它是系统字体"。
export const SYSTEM_FONT_RE = new RegExp('^(?:' + [
  // macOS / iOS
  'PingFang(?: (?:SC|TC|HK|MO))?', '苹方(?:-简|-繁|-港)?', 'Hiragino.*', '冬青黑体.*', 'Heiti(?: SC| TC)?', 'STHeiti.*',
  'ST(?:Song|Kaiti|Fangsong|Xihei|Zhongsong|Hei|Kai)', '华文.*', 'Songti(?: SC| TC)?', 'Kaiti(?: SC| TC)?', 'Lantinghei.*',
  'Yuanti.*', 'Baoli.*', 'Libian.*', 'Weibei.*', 'Wawati.*', 'Hannotate.*', 'Hanzipen.*', 'Xingkai.*', 'Apple .*',
  '-apple-system', 'BlinkMacSystemFont', 'SF Pro.*', 'SF Mono', 'SF Compact.*', 'New York', 'San Francisco',
  'Helvetica(?: Neue)?', 'Menlo', 'Monaco', 'Avenir.*', 'Futura', 'Geneva', 'Lucida Grande', 'Osaka.*',
  // Windows
  'Microsoft YaHei(?: UI)?', '微软雅黑', 'Microsoft JhengHei(?: UI)?', '微軟正黑體', 'SimSun(?:-ExtB)?', 'NSimSun', '宋体', '新宋体',
  'SimHei', '黑体', 'KaiTi(?:_GB2312)?', '楷体(?:_GB2312)?', 'FangSong(?:_GB2312)?', '仿宋(?:_GB2312)?', 'DengXian', '等线',
  'MingLiU.*', 'PMingLiU.*', '新細明體', 'Microsoft Sans Serif', 'Segoe UI.*', 'Yu Gothic.*', 'Meiryo.*', 'MS (?:P?Gothic|P?Mincho)',
  'Malgun Gothic', 'Arial.*', 'Times New Roman', 'Times', 'Calibri', 'Cambria', 'Consolas', 'Tahoma', 'Verdana', 'Georgia',
  'Courier(?: New)?', 'Trebuchet MS', 'Impact', 'Comic Sans MS',
  // Linux / Android 常见预装（同名字体也可能随片打包——那就在随片声明里，不会走到这张表）
  'Noto (?:Sans|Serif)(?: Mono)? CJK.*', 'Noto Color Emoji', 'Droid Sans.*', 'WenQuanYi.*', '文泉驿.*', 'AR PL .*',
  'DejaVu.*', 'Liberation.*', 'Ubuntu.*', 'Cantarell', 'Roboto', 'Source Han (?:Sans|Serif).*', '思源(?:黑体|宋体).*',
].join('|') + ')$', 'i');

/** 'italic 600 58px "A B", C, sans-serif' -> { head: 'italic 600 ', size: 58, families: ['A B','C','sans-serif'] } */
export function parseFontShorthand(font) {
  const m = /^(.*?)(\d+(?:\.\d+)?)px(?:\s*\/\s*\S+)?\s+(.+)$/.exec(font.trim());
  if (!m) return null;
  return { head: m[1], size: Number(m[2]), families: splitFamilies(m[3]) };
}

export function splitFamilies(list) {
  const out = []; let cur = '', q = null;
  for (const ch of list) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}
