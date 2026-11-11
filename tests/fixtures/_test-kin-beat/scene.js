// beatsync 夹具：拍点 120bpm（beats.json，0, 0.5, … 4.0s）。每个事件 = 一个方块瞬间出现（之后不动）。
//   VARIANT.shift  所有事件相对拍点的偏移（秒）：0 = 卡在拍上；0.15 = 全部晚 150ms（成片帧格上第一帧在 +167ms）
//   VARIANT.miss   只把第 miss 个事件推后 0.15s（其余在拍上）："看得出在卡拍，差一点"的那一个
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 4;
const EV = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5].map((b, i) => b + (V.shift || 0) + (V.miss === i ? 0.15 : 0));
window.seek = (t) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
  EV.forEach((e, i) => { if (t >= e) { g.fillStyle = '#f0c040'; g.fillRect(120 + i * 250, 440, 200, 200); } });
};
