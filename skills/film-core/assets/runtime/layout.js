// film-core 运行时 · 三画幅布局
// 一条时间线，三个画幅。场景里的位置走 place()/size()，不写死像素：
// 9:16 / 1:1 / 16:9 并排渲染时各自重新构图，而不是把 16:9 裁成竖版（裁剪会毁掉排版）。
//
// 渲染器（render.mjs）按 film.json 的 format 设 viewport，并在 URL 上带 ?format=<key>。
// 场景用 layoutFromURL() 读它 —— 画幅的唯一来源是 URL，不要自己再判断窗口尺寸。

export const FORMATS = {
  '9x16': { width: 1080, height: 1920 },
  '1x1':  { width: 1440, height: 1440 },
  '16x9': { width: 1920, height: 1080 },
};

export function makeLayout(formatKey) {
  const fmt = FORMATS[formatKey];
  if (!fmt) throw new Error(`未知画幅 ${formatKey}，可选：${Object.keys(FORMATS).join(' / ')}`);
  const { width, height } = fmt;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const tall = height > width;

  return {
    key: formatKey, width, height, short, long,
    tall, wide: width > height, square: width === height,
    // 归一化坐标 -> 像素，x,y ∈ [0,1]（可越界，用于出画/入画）
    place: (x, y) => ({ x: x * width, y: y * height }),
    // 尺寸按短边缩放并取整：同一个 size(0.05) 在三个画幅里视觉重量一致
    // 要亚像素（例如很慢的缩放动画）用 sizeExact
    size: (n) => Math.round(short * n),
    sizeExact: (n) => short * n,
    cx: width / 2,
    cy: height / 2,
    // 安全边距：短边 6%（与旧版 lib/layout.js 兼容的数值）；别的比例用 padBy(r)
    pad: Math.round(short * 0.06),
    padBy: (ratio) => Math.round(short * ratio),
  };
}

// 场景入口用这个：?format=9x16 -> layout。缺省值只用于在浏览器里手开调试。
export function layoutFromURL(fallback = '9x16') {
  const key = new URLSearchParams(globalThis.location?.search ?? '').get('format') || fallback;
  return makeLayout(key);
}

// 按画幅挑值：pick(L, { tall: 0.3, wide: 0.46, square: 0.4 })
// 三画幅"各自构图"的最小工具 —— 竖版和横版要的是不同的构图，不是同一个构图缩放。
export function pick(L, by) {
  if (L.key in by) return by[L.key];
  if (L.square && 'square' in by) return by.square;
  if (L.tall && 'tall' in by) return by.tall;
  if (L.wide && 'wide' in by) return by.wide;
  if ('default' in by) return by.default;
  throw new Error(`pick(): 画幅 ${L.key} 没有对应的值，给了 ${Object.keys(by).join(' / ')}`);
}
