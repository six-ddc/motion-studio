// 故意保留夹具：0–0.5s 黑场（首帧空 → cover.empty），0.5–1.5s 一个方块横移，1.5–4.0s 方块停住（2.5s 静止 → still）。
// 变体由入口页的 window.VARIANT 决定：MARKS 里有没有 hold、hold 有没有理由。
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 4;
if (V.marks) window.MARKS = V.marks;
window.seek = (t) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
  if (t < 0.5) return;
  const p = Math.min(1, (t - 0.5) / 1.0);
  g.fillStyle = '#f0c040'; g.fillRect(200 + 1200 * p, 390, 300, 300);
};
