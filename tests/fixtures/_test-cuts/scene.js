// 转场取帧夹具：三个纯色镜头。A(蓝)→B(橙) 是 1.0–1.6s 的擦除转场（cut 1.3），B→C(绿) 是 3.0s 的硬切。
// 擦除的中段画一个只在 1.25–1.35s 出现的品红框（"框中框"类缺陷的替身）：只看定型帧和均匀 5 点都看不到它，
// transitions.mjs 的"中"那一格必须正好落在它上面（帧格对齐后 1.300s = f39）。
// 变体由入口页的 window.VARIANT 决定：声明方式（CUT_WINDOWS / CUTS / MARKS / 都不声明 / 坏声明）。
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 4;
if (V.windows) window.CUT_WINDOWS = V.windows;
if (V.cuts) window.CUTS = V.cuts;
if (V.marks) window.MARKS = V.marks;
const fill = (c, x0 = 0, x1 = 1920) => { g.fillStyle = c; g.fillRect(x0, 0, x1 - x0, 1080); };
window.seek = (t) => {
  if (t < 1.0) fill('#2f5fd0');
  else if (t < 1.6) {
    const p = (t - 1.0) / 0.6, x = Math.round(1920 * p);
    fill('#2f5fd0'); fill('#f08a2c', 0, x);
    if (t >= 1.25 && t < 1.35) { g.strokeStyle = '#ff00ff'; g.lineWidth = 24; g.strokeRect(560, 300, 800, 480); }
  } else if (t < 3.0) fill('#f08a2c');
  else fill('#2fa860');
};
