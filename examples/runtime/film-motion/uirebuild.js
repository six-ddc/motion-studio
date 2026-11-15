// ui-rebuild 的几个小函数：从截图重建产品界面时用。浏览器 ES module，不带任何长相（颜色、字体、尺寸全由调用方给）。
// 方法与代价见 film-motion references/ui-rebuild.md。复刻页 import './runtime/uirebuild.js'（挂载表提供，交付时冻结）。

// 元素在复刻根节点坐标系里的框（参考帧像素），沿 offsetParent 链累加。
// 不用 getBoundingClientRect：它已经乘进了根节点外面所有的 transform（复刻缩放、镜头变焦），
// 每帧都在变；offset 链只认布局，不认 transform。前提：root 是 el 的 offsetParent 链上的一环
// （root 设 position:relative/absolute 即可），且 el 与 root 之间没有自带 transform 的节点。
export function localRect(el, root) {
  let x = 0, y = 0, e = el;
  while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
  if (e !== root) throw new Error('localRect: root 不在 el 的 offsetParent 链上（root 要有 position）');
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

// 复刻放在画面上：参考帧点 (lx,ly) → 画面点；参考帧框 → 画面框。s = 复刻缩放，(x,y) = 复刻左上角在画面上的位置。
export function placeReplica({ x, y, s }) {
  return {
    point: (lx, ly) => ({ x: x + lx * s, y: y + ly * s }),
    box: (r) => ({ x: x + r.x * s, y: y + r.y * s, w: r.w * s, h: r.h * s }),
  };
}

// 可读性算术：屏幕上的字号 = 原字号 × 复刻缩放 × 镜头变焦。
export const screenPx = (fontPx, s, zoom) => fontPx * s * zoom;
// 反推：要让原字号 fontPx 的字在屏幕上有 targetPx 高，镜头要推到多少。targetPx 由片子自己定，这里不给默认值。
export function zoomFor(targetPx, fontPx, s) {
  if (!(targetPx > 0 && fontPx > 0 && s > 0)) throw new Error('zoomFor(targetPx, fontPx, s) 三个参数都要给正数');
  return targetPx / (fontPx * s);
}

// 文字表：STR = { zh: {...}, en: {...} }；缺的键回落到 base 语言，再缺就抛错（不让 undefined 上屏）。
export function strings(STR, lang, base = Object.keys(STR)[0]) {
  return (key) => {
    const v = STR[lang]?.[key] ?? STR[base]?.[key];
    if (v == null) throw new Error(`文字表缺 "${key}"（${lang} 与 ${base} 都没有）`);
    return v;
  };
}
