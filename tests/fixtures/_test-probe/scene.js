// 信号读数夹具：一个"镜头"（圆心 = 镜头偏移）在 1.6s 起震。
// VARIANT.onset = 'step'：震动从 sin 的波峰开始，1.6s 那一帧位置直接跳 A（被怀疑的"镜头跳了"）
//               'ease'：同样的震动乘一个 0.15s 的包络，从 0 长出来（不该被标）
// probe(t) 与 seek(t) 共用 state(t)，不画东西。
const V = window.VARIANT ?? {};
const ON = 1.6, A = 40, W = 2 * Math.PI * 2.5;   // 2.5 Hz：30 fps 下每周期 12 帧，采样本身是顺的
function state(t) {
  const dt = t - ON;
  let env = dt < 0 ? 0 : 1;
  if (V.onset === 'ease') env = dt < 0 ? 0 : Math.min(1, dt / 0.15) ** 2;
  const ph = V.onset === 'ease' ? 0 : Math.PI / 2;
  const decay = dt < 0 ? 0 : Math.exp(-dt * 1.5);
  return {
    cam_x: 120 * t + A * env * decay * Math.sin(W * Math.max(0, dt) + ph),   // 匀速摇镜 + 震动
    cam_y: A * 0.5 * env * decay * Math.sin(W * 1.3 * Math.max(0, dt) + ph),
    glow: Math.min(1, t / 3),                                               // 平滑量：不该被标
  };
}
const cv = document.getElementById('stage');
cv.width = FILM.width; cv.height = FILM.height;
const g = cv.getContext('2d');
window.DURATION = 3;
if (V.probe !== false) window.probe = (t) => state(t);
window.seek = (t) => {
  const s = state(t);
  g.fillStyle = '#101418'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = `rgb(${200 + 55 * s.glow},120,60)`;
  g.beginPath(); g.arc(300 + s.cam_x, cv.height / 2 + s.cam_y, 80, 0, 2 * Math.PI); g.fill();
};
