// film-core 运行时 · 可复现随机（全套件唯一的一份实现）
// motion / physics / camrig / textfx 等需要随机的运行时都从这里 import，不各写一份：
// 三份互不相同的 hash01 会让"同一个种子"在不同模块里给出不同的数，换个模块调用像素就变。
//
// 两种用法，各管一类场景：
//   seeded(seed)       顺序流（mulberry32）。在模块顶层或 seek 内部**用固定种子新建**再取数；
//                      在 seek 之间共享同一个生成器往下取 = 跨帧状态（seamcheck 门 2 抓得到）。
//   hash01(...keys)    无状态、按索引随机访问 → [0,1)。粒子、网格、逐帧抖动（hash01(seed, i, frame)）用它：
//                      不依赖取数顺序，增删元素不会让其他元素的随机值整体错位。

export function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash01(...keys) {
  let h = 0x9e3779b9;
  for (const k of keys) h = Math.imul(h ^ (k | 0), 0x85ebca6b) ^ (h >>> 13);
  return seeded(h)();
}

/** hash01 映射到 [lo, hi)：hashRange(lo, hi, ...keys) */
export const hashRange = (lo, hi, ...keys) => lo + (hi - lo) * hash01(...keys);
