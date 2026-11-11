// hook 夹具：VARIANT.start = 内容出现的时刻。0 = 首帧即有方块且立刻开始转动；3.2 = 前 3 秒全黑。
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 5;
const s0 = V.start || 0;
window.seek = (t) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
  if (t < s0) return;
  g.save(); g.translate(960, 540); g.rotate((t - s0) * 0.8);
  g.fillStyle = '#f0c040'; g.fillRect(-200, -200, 400, 400); g.restore();
};
