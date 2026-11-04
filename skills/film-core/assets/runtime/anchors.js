// film-core 运行时 · 空间锚点（契约见 film-core references/runtime.md「空间锚点」）
//
// 场景在**画**某个有名字的东西的那一行，顺手把它的屏幕框登记进"本帧的表"。
// 其他层（字幕、特效、音效、评审、分镜断言）读同一张表，于是大家看到的是同一个位置。
//
// 为什么必须在绘制路径上登记，而不是另写一个函数按状态推屏幕坐标：
// 另算一遍且自洽的断言，验的是它自己（仓库开发台账的盲区推论）。probe 报 0 盏灯而画面上
// 有 140 个红像素，就是"另算一遍"的代价。所以这里的 API 是"画完这一笔，登记这一笔"，
// 推荐写法是 ctxRect()：直接取 ctx 的**当前变换**把局部矩形映射到屏幕——画用的就是这个变换。
//
// 只暴露数据，不做布局：这里没有"避让""默认位置""吸附"。放在哪是每支片 style_guide 的事。
//
// 坐标：归一化到画面宽高（x/W, y/H），**不裁剪**——出画的部分照样是 <0 或 >1，
// 出画门要靠它知道"切掉了多少"。换画幅、截图缩放都不失效。
// 纯函数：每次 seek 开头清空；在 seek 之外登记会直接抛错（那等于跨帧状态）。
//
// 用法：
//   import { createAnchors } from './runtime/anchors.js';
//   const A = createAnchors(canvas);
//   ... 在画车身那一行之后： A.ctxRect('黄车', ctx, -len / 2, -wid / 2, len, wid);
//   ... 屏幕像素已知时：     A.box('字幕底条', x, y, w, h);
//   window.seek = A.install((t) => { ...整帧绘制... });   // 同时装上 window.anchors
//
//   同名多次登记 = 取外包（一辆车分上下车身、车顶几笔画，最后是一个框；"灯团" = 所有亮灯车的外包）。
//   同一帧里后画的层可以 A.get(name) 读先画的层登记的框（例如字幕层读主体的位置自己决定放哪）——
//   这是同一帧内的数据流，不是跨帧状态。

const R6 = (v) => Math.round(v * 1e6) / 1e6;

export function createAnchors(canvas) {
  let frame = null;          // { t, items: Map<name, {x0,y0,x1,y1,n,meta}> }
  let open = false;          // 只在 seek 进行中为 true

  const need = (what) => {
    if (!open) throw new Error(`anchors.${what}() 在 seek(t) 之外调用：锚点只能在绘制路径上登记/读取（否则就是跨帧状态）`);
  };
  const put = (name, x0, y0, x1, y1, meta) => {
    need('登记');
    if (typeof name !== 'string' || !name) throw new Error('锚点名必须是非空字符串');
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;          // NaN 框不登记（画不出来的东西没有框）
    const W = canvas.width, H = canvas.height;
    const b = { x0: Math.min(x0, x1) / W, y0: Math.min(y0, y1) / H, x1: Math.max(x0, x1) / W, y1: Math.max(y0, y1) / H };
    const o = frame.items.get(name);
    if (!o) { frame.items.set(name, { ...b, n: 1, meta: meta ? { ...meta } : null }); return; }
    o.x0 = Math.min(o.x0, b.x0); o.y0 = Math.min(o.y0, b.y0); o.x1 = Math.max(o.x1, b.x1); o.y1 = Math.max(o.y1, b.y1);
    o.n++; if (meta) o.meta = { ...(o.meta ?? {}), ...meta };
  };
  const out = (o) => {
    const r = { x: R6(o.x0), y: R6(o.y0), w: R6(o.x1 - o.x0), h: R6(o.y1 - o.y0),
      cx: R6((o.x0 + o.x1) / 2), cy: R6((o.y0 + o.y1) / 2), n: o.n };
    return o.meta ? { ...r, ...o.meta } : r;
  };

  const A = {
    /** seek 开头：清空本帧的表。install() 会替你调。 */
    begin(t) { frame = { t, items: new Map() }; open = true; },
    /** seek 结尾：封表。之后再登记会抛错。 */
    end() { open = false; },
    /** 屏幕像素框（canvas 像素坐标，与当前 ctx 变换无关）。 */
    box(name, x, y, w, h, meta) { put(name, x, y, x + w, y + h, meta); },
    /** 以 (x,y) 为中心、半径 r 的框（辉光、粒子、灯点）。 */
    disc(name, x, y, r, meta) { put(name, x - r, y - r, x + r, y + r, meta); },
    /** ctx 当前变换下的局部矩形 → 四角映射到屏幕取外包。画和登记用的是同一个变换。 */
    ctxRect(name, ctx, x, y, w, h, meta) {
      const m = ctx.getTransform();
      const xs = [], ys = [];
      for (const [u, v] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        xs.push(m.a * u + m.c * v + m.e); ys.push(m.b * u + m.d * v + m.f);
      }
      put(name, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), meta);
    },
    /** 本帧到目前为止登记的框（归一化）；没登记过 = null。只能在 seek 里读。 */
    get(name) { need('get'); const o = frame.items.get(name); return o ? out(o) : null; },
    /** 最近一次 seek 的整张表：{ t, items: { 名: {x,y,w,h,cx,cy,n,...meta} } }。 */
    snapshot() {
      if (!frame) return null;
      const items = {};
      for (const [k, o] of [...frame.items.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) items[k] = out(o);
      return { t: frame.t, items };
    },
    /**
     * 包一层 seek：开头清表、结尾封表；同时装上
     *   window.anchors(t)       画第 t 秒这一帧，返回这一帧的表（画布会被改写——它就是 seek）
     *   window.anchors.last()   最近一次 seek 的表，不重画（截图之后读：保证和截到的像素是同一次绘制）
     * draw 可以是 async（返回 Promise）。
     */
    install(draw) {
      const seek = (t) => {
        A.begin(t);
        let r;
        try { r = draw(t); } catch (e) { A.end(); throw e; }
        if (r && typeof r.then === 'function') return r.then((v) => { A.end(); return v; }, (e) => { A.end(); throw e; });
        A.end(); return r;
      };
      const anchors = (t) => {
        const r = seek(t);
        return r && typeof r.then === 'function' ? r.then(() => A.snapshot()) : A.snapshot();
      };
      anchors.last = () => A.snapshot();
      if (typeof window !== 'undefined') window.anchors = anchors;
      return seek;
    },
  };
  return A;
}
