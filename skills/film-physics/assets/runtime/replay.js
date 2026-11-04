// 策略 2：确定性定步重放 + 单调缓存 + 检查点。
//
// 观测语义：stateAt(t) ≡ "从 init() 起以固定 dt 走 round(t·fps)·substeps 步后的状态"。
// 缓存只是加速这个定义的手段：
//   请求步数 n ≥ 当前步数  → 从当前位置往前推（顺序渲染时每帧 O(substeps)）
//   n < 当前步数           → 从 ≤ n 的最近检查点恢复，再往前推（最多 checkpoint 间隔步）
// 合法的前提（违反任何一条，乱序求值就会和顺序求值不一致）：
//   1. 全部状态都在 state 里，clone(state) 能完整复制它。step 读写的东西不许在外面。
//   2. 随机数用 hash01(seed, stepIndex, k)——step 的第三个参数就是步号。
//      不要在 step 外面放一个 seeded() 闭包：恢复检查点时它不会跟着回退。
//   3. 检查点存的是 clone，不是引用。
//   4. 调用方不修改 stateAt() 的返回值（它就是缓存本体；要改先 clone）。
//   5. 步数由整数帧号算：n = round(t·fps)·substeps。floor(t/dt) 会因浮点误差差一步。
//
// 参数 t 是**仿真时间**，fps 是**仿真时间里的查询栅格**（每仿真秒多少个可查询点），不是影片帧率。
// 影片时间 ≠ 仿真时间时（时间加速、慢镜头、定格）调用 stateAt(S(t))，S 见 timemap.js。
// stats.lastN 记最近一次 stateAt 用的步号——只给 physcheck E4 核对"喂进来的是不是 S(t)"，不影响结果。
//
// leak 参数只给确定性探测脚本用，用来证明测试能抓到缓存 bug。正常使用不要传。

export function createReplay({ fps = 60, substeps = 4, init, step, clone, checkpointEvery = 1, leak = null }) {
  const dt = 1 / (fps * substeps);
  const every = Math.max(1, Math.round(checkpointEvery * fps * substeps));
  const snap = leak === 'ref' ? (s) => s : clone; // 故意的 bug：检查点存引用
  let cur = init();
  let curN = 0;
  const cps = new Map([[0, snap(cur)]]);
  const stats = { stepped: 0, restores: 0, lastN: -1 };

  function advanceTo(n) {
    while (curN < n) {
      step(cur, dt, curN);
      curN++;
      stats.stepped++;
      if (curN % every === 0 && !cps.has(curN)) cps.set(curN, snap(cur));
    }
  }

  return {
    dt, fps, substeps, stats,
    stepsAt: (t) => Math.round(t * fps) * substeps,
    stateAt(t) {
      const n = Math.max(0, Math.round(t * fps) * substeps);
      stats.lastN = n;
      if (n < curN) {
        if (leak === 'nocp') { /* 故意的 bug：不回退，直接返回"未来"的状态 */ return cur; }
        const k = Math.floor(n / every) * every; // 一定存在：顺序推进时每个整倍数都存过
        cur = clone(cps.get(k));
        curN = k;
        stats.restores++;
      }
      advanceTo(n);
      return cur;
    },
    checkpoints: () => cps.size,
  };
}

// 事件日志：定步仿真里发生的碰撞/死亡等事件，记成 (步号, 数据)，
// 供命中反馈（屏震、闪白）在任意 t 查询"t 之前最近的 k 次命中"。
// 事件必须存进 state 才能随检查点回退；这里给一个定长环形缓冲的写法。
export function eventRing(size = 64) {
  return { t: new Float64Array(size).fill(-1e9), v: new Float64Array(size), head: 0 };
}
export function pushEvent(ring, time, value = 1) {
  ring.t[ring.head] = time; ring.v[ring.head] = value; ring.head = (ring.head + 1) % ring.t.length;
}
export function cloneRing(r) { return { t: r.t.slice(), v: r.v.slice(), head: r.head }; }
export function eventTimes(ring) { return Array.from(ring.t).filter((x) => x > -1e8).sort((a, b) => a - b); }
