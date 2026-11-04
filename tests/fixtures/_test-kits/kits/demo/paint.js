// 夹具 kit demo：标准帧 = 深底 + 居中一块橙色方块。纯函数，只看参数。
export const INK = '#141925', ACCENT = '#F06A2C';
export function std(c, W, H) {
  c.fillStyle = INK; c.fillRect(0, 0, W, H);
  c.fillStyle = ACCENT; c.fillRect(W / 2 - 120, H / 2 - 120, 240, 240);
}
