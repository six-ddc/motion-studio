// mute 夹具：旁白 0.5–2.8s、3.0–5.5s（narration.json）。画面是一个不动的方块。
//   VARIANT.caption true：旁白在说时画一行字幕（canvas fillText，探针截得到）；false：无字也不动
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 6;
const LINES = [[0.5, 2.8, 'line one'], [3.0, 5.5, 'line two']];
window.seek = (t) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
  g.fillStyle = '#f0c040'; g.fillRect(760, 300, 400, 400);
  if (!V.caption) return;
  const l = LINES.find(([a, b]) => t >= a && t < b);
  if (l) { g.fillStyle = '#fff'; g.font = '64px sans-serif'; g.textAlign = 'center'; g.fillText(l[2], 960, 900); }
};
