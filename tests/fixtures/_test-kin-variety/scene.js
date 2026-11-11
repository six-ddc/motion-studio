// variety 夹具：6 个 1s 的镜头，window.CUTS = [1..5] 硬切。每个镜头换底色和主体颜色。
//   VARIANT.layout 'same'：六个镜头构图完全相同（同位置、同大小的主体 + 标题条）
//   VARIANT.layout 'varied'：远景小主体 / 特写大主体 / 偏左 / 偏右上 / 中景 / 远景偏下，相邻两个都不同
const V = window.VARIANT || {};
const cv = document.getElementById('stage'); cv.width = 1920; cv.height = 1080;
const g = cv.getContext('2d');
window.DURATION = 6;
window.CUTS = [1, 2, 3, 4, 5];
const BG = ['#10131c', '#1c1410', '#101c14', '#1c101a', '#14141c', '#1a1a10'];
const FG = ['#f0c040', '#40c0f0', '#f06040', '#80f060', '#c080f0', '#f0f0f0'];
// [cx, cy, 半边长]（像素）
const SAME = Array(6).fill([960, 600, 220]);
const VARIED = [[960, 540, 90], [960, 540, 460], [480, 560, 200], [1500, 300, 160], [960, 560, 260], [700, 850, 70]];
window.seek = (t) => {
  const k = Math.min(5, Math.floor(t));
  const [cx, cy, r] = (V.layout === 'varied' ? VARIED : SAME)[k];
  g.fillStyle = BG[k]; g.fillRect(0, 0, 1920, 1080);
  g.fillStyle = FG[k]; g.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  if (V.layout !== 'varied') { g.fillRect(560, 160, 800, 90); }
};
