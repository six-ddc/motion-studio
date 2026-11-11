// motion 夹具：方块 0.5–2.0s 从左走到右，之后停住。变体由入口页 window.VARIANT 决定：
//   ease: 'linear'（硬起硬停 + 1.5s 匀速）| 'inout'（cubic 缓入缓出）
//   n:    同时在动的方块数（默认 1；swarm 变体 6 个，错开纵向位置，互不相连）
//   cut:  有值时在该时刻整屏换底色并声明 window.CUTS（切点处的整屏变化不算突变）
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 4;
if (V.cut != null) window.CUTS = [V.cut];
const ease = V.ease === 'linear' ? (p) => p : (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const n = V.n || 1;
window.seek = (t) => {
  g.fillStyle = V.cut != null && t >= V.cut ? '#1d2a44' : '#000'; g.fillRect(0, 0, 1920, 1080);
  const p = ease(Math.min(1, Math.max(0, (t - 0.5) / 1.5)));
  const h = n === 1 ? 300 : 110;
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 390 : 40 + i * 175;
    g.fillStyle = '#f0c040'; g.fillRect(200 + 1200 * p, y, h, h);
  }
};
