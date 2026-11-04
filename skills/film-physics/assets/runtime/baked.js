// 策略 3：查预烘焙的轨迹表。由 scripts/bake.mjs 生成 <name>.json（头）+ <name>.bin（Float32）。
// 布局：frame-major，每帧 fields 个字段，每字段 n 个 float32。
//   data[(f * fields + k) * n + i] = 第 f 帧、第 k 个字段、第 i 个体
// 只读查表，没有任何可变状态 → 天然可乱序。

export async function loadBake(baseUrl) {
  const head = await (await fetch(baseUrl + '.json')).json();
  const buf = await (await fetch(baseUrl + '.bin')).arrayBuffer();
  const data = new Float32Array(buf);
  const per = head.fields.length * head.n;
  if (data.length !== head.frames * per) throw new Error(`bake 文件损坏：期望 ${head.frames * per} 个数，实际 ${data.length}`);
  return makeTrack(head, data);
}

export function makeTrack(head, data) {
  const { fps, frames, n, fields } = head;
  const per = fields.length * n;
  const clampF = (f) => (f < 0 ? 0 : f > frames - 1 ? frames - 1 : f);
  return {
    head, n, fps, frames, duration: (frames - 1) / fps,
    // 整帧：返回 { x: Float32Array(n), y: ... }（subarray，零拷贝；不要写）
    frame(t) {
      const f = clampF(Math.round(t * fps));
      const out = {};
      fields.forEach((name, k) => { out[name] = data.subarray(f * per + k * n, f * per + (k + 1) * n); });
      return out;
    },
    // 帧间线性插值：给运动模糊子帧或 fps 不同的片子用。返回新数组。
    // 代价：插值是直线，碰撞瞬间的折角会被切掉一点。
    lerp(t) {
      const ft = Math.min(Math.max(t * fps, 0), frames - 1);
      const f0 = Math.floor(ft), f1 = Math.min(f0 + 1, frames - 1), a = ft - f0;
      const out = {};
      fields.forEach((name, k) => {
        const o = new Float32Array(n), b0 = f0 * per + k * n, b1 = f1 * per + k * n;
        for (let i = 0; i < n; i++) o[i] = data[b0 + i] + (data[b1 + i] - data[b0 + i]) * a;
        out[name] = o;
      });
      return out;
    },
  };
}
