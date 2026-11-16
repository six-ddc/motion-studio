// 可读性/对比度夹具。VARIANT 决定两件事：
//   capWeight  字幕「周长」的字重（标题巨字「周长」恒为 900、190px）
//   red        分色那行里朱红那遍的颜色
// 阳性（scene.html）：字幕 400、60px；朱红在纸色上大字对比度 > 3，但朱红那遍**后画**，框里已有墨色那遍的字。
//   旧版按字串合并（900 + 60px）判 readability.size 红；按"框内已有像素"取底色把墨字算进底，判 contrast 红。
// 阴性（bad.html）：字幕真的是 900、60px（低于 cjk_900 下限）；朱红真的太浅。两条都必须照样红。
const V = window.VARIANT || {};
const W = 1080, H = 1920;
const cv = document.getElementById('stage'); cv.width = W; cv.height = H;
const c = cv.getContext('2d');
const PAPER = '#f4efe4', INK = '#1a1a1a', RED = V.red || '#e0503a';
const FAM = '"Noto Sans SC", "Noto Sans CJK SC", sans-serif';
window.DURATION = 2;
window.seek = (t) => {
  c.fillStyle = PAPER; c.fillRect(0, 0, W, H);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  // 标题巨字
  c.font = `900 190px ${FAM}`; c.fillStyle = INK; c.fillText('周长', 120, 500);
  // 一行分两色：整行同一串字画两遍，各用裁剪露出一段。墨色那遍先画、朱红那遍后画
  const line = '黑黑黑黑黑红', x0 = 120, y = 900;
  c.font = `900 150px ${FAM}`;
  const wInk = c.measureText('黑黑黑黑黑').width, wAll = c.measureText(line).width;
  for (const [col, a, b] of [[INK, x0 - 40, x0 + wInk], [RED, x0 + wInk, x0 + wAll + 40]]) {
    c.save(); c.beginPath(); c.rect(a, y - 200, b - a, 260); c.clip();
    c.fillStyle = col; c.fillText(line, x0, y); c.restore();
  }
  // 字幕：逐词画（像 drawCaption），其中一词与标题同串「周长」，常规字重、60px
  c.font = `${V.capWeight || 400} 60px ${FAM}`; c.fillStyle = INK;
  c.fillText('周长', 120, 1500); c.fillText('全都一样', 120 + c.measureText('周长').width, 1500);
};
window.ready = document.fonts.ready;
