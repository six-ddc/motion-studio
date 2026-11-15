// shapes.js（film-motion）与镜头组合子（film-core motion.js）的 Node 数值断言。运行：node tests/fixtures/_test-shapes/tests/unit.mjs
// 两个运行时都零依赖或只依赖 rand.js 的相对路径，直接按文件路径 import，不需要 registerRuntimeResolver。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const R = join(ROOT, 'skills') + '/';
const S = await import('file://' + R + 'film-motion/assets/runtime/shapes.js');
const M = await import('file://' + R + 'film-core/assets/runtime/motion.js');
let pass = 0, failN = 0;
const ok = (c, msg, extra = '') => { if (c) pass++; else failN++; console.log(`${c ? '✓' : '✗'} ${msg} ${extra}`); };
const near = (a, b, e) => Math.abs(a - b) <= e;
const maxDev = (A, B) => { // A,B shapes; max distance from each point of A to nearest seg of B
  let m = 0; const segs = []; for (const p of B) { const P = p.closed ? [...p.pts, p.pts[0]] : p.pts; for (let i = 1; i < P.length; i++) segs.push([P[i-1], P[i]]); }
  for (const p of A) for (const q of p.pts) { let best = Infinity; for (const [a, b] of segs) { const dx=b[0]-a[0], dy=b[1]-a[1], L=dx*dx+dy*dy; let u = L?((q[0]-a[0])*dx+(q[1]-a[1])*dy)/L:0; u=Math.max(0,Math.min(1,u)); best=Math.min(best, Math.hypot(a[0]+u*dx-q[0], a[1]+u*dy-q[1])); } m = Math.max(m, best); }
  return m; };

// 弧长
const sq = S.pathSampler('M0 0 H100 V100 H0 Z'); ok(near(sq.length, 400, 1e-9), '正方形弧长 = 400', sq.length);
const rel = S.pathSampler('m10 10 l30 40 h-30 z'); ok(near(rel.length, 50 + 30 + 40, 1e-9), '相对命令 m l h z 弧长 = 120', rel.length);
const ci = S.pathSampler(S.circle(0, 0, 100)); ok(Math.abs(ci.length / (200 * Math.PI) - 1) < 1e-3, '圆弧长 ≈ 2πr（tolerance 0.25：相对误差 < 0.1%）', (ci.length - 200 * Math.PI).toFixed(4));
const ci2 = S.pathSampler(S.circle(0, 0, 100), { tolerance: 0.01 }); ok(Math.abs(ci2.length - 200 * Math.PI) < 0.05, 'tolerance 0.01 时误差 < 0.05px', (ci2.length - 200 * Math.PI).toFixed(4));
const cub = S.pathSampler('M0 0 C0 0 100 0 100 0'); ok(near(cub.length, 100, 1e-6), '退化三次曲线 = 直线 100', cub.length);
const q = S.pathSampler('M0 0 Q50 100 100 0'); ok(Math.abs(q.length / 147.894 - 1) < 1e-3, '二次曲线弧长 ≈ 147.894（解析值，相对误差 < 0.1%）', q.length.toFixed(3));
const q2 = S.pathSampler('M0 0 Q50 100 100 0', { tolerance: 0.01 }); ok(Math.abs(q2.length - 147.894) < 0.01, 'tolerance 0.01 时 < 0.01px', q2.length.toFixed(4));
const T = S.pathSampler('M0 0 Q25 50 50 0 T100 0'); ok(near(T.length, 2 * S.pathSampler('M0 0 Q25 50 50 0').length, 1e-6), 'T 反射控制点：两段等长', T.length.toFixed(3));
const arcF = S.pathSampler('M0 0 a50 50 0 01100 0'); ok(Math.abs(arcF.length / (Math.PI * 50) - 1) < 0.25 / (3 * 50) * 1.05, '紧凑弧标志位 a50 50 0 01100 0 = 半圆', arcF.length.toFixed(3));
const multi = S.pathSampler('M0 0 H10 M100 0 H130'); ok(multi.subpaths.length === 2 && near(multi.length, 40, 1e-9), '多子路径：2 段，总长 40（空跳不计）');
ok(near(multi.at(15).x, 105, 1e-9), 'at(15) 落在第二子路径 x=105', multi.at(15).x);
const ns = S.pathSampler('M1.5.5L-1-2e1'); ok(near(ns.length, Math.hypot(2.5, 20.5), 1e-9), '数字粘连写法 1.5.5 / -1-2e1');
ok(near(sq.at(150).x, 100, 1e-9) && near(sq.at(150).y, 50, 1e-9) && near(sq.at(150).angle, Math.PI / 2, 1e-9), 'at(150) = (100,50) 朝下');

// trim
const t1 = S.trim(sq, 0, 0.25); const e1 = t1[0].pts.at(-1);
ok(t1.length === 1 && near(e1[0], 100, 1e-9) && near(e1[1], 0, 1e-9), 'trim(0,0.25) 终点 = (100,0)');
const t2 = S.trim(sq, 0.125, 0.375); ok(near(t2[0].pts[0][0], 50, 1e-9) && near(t2[0].pts.at(-1)[1], 50, 1e-9), 'trim(0.125,0.375) 端点 (50,0)→(100,50)');
const t3 = S.trim(sq, 0, 0.25, 0.875); ok(t3.length === 1 && near(t3[0].pts[0][1], 50, 1e-9) && near(t3[0].pts.at(-1)[0], 50, 1e-9), '闭合路径 offset 绕过起点接成一条：(0,50)→(50,0)', JSON.stringify([t3[0].pts[0], t3[0].pts.at(-1)]));
const tl = (sh) => sh.reduce((a, p) => a + S.pathSampler(p.pts).length, 0);
ok(near(tl(t3), 100, 1e-9), '绕回段长度 = 100');
const op = S.pathSampler('M0 0 H100'); const t4 = S.trim(op, 0, 0.3, 0.8); ok(t4.length === 2 && near(tl(t4), 30, 1e-9), '开放路径 offset 绕回 = 两段，共 30');
ok(S.trim(sq, 0.4, 0.4).length === 0, 'start=end 返回空');
const tf = S.trim(sq, 0, 1); ok(tf.length === 1 && tf[0].closed, '0→1 返回闭合整条');
const tm = S.trim(multi, 0, 0.5); ok(near(tl(tm), 20, 1e-9) && tm.length === 2, '多子路径整体模式 0..0.5 = 20px，跨两段');
const te = S.trim(multi, 0, 0.5, 0, { each: true }); ok(near(tl(te), 5 + 15, 1e-9), 'each 模式：各裁一半 = 5+15');

// along
const al = S.along(sq, 0.625); ok(near(al.x, 50, 1e-9) && near(al.y, 100, 1e-9) && near(Math.abs(al.angle), Math.PI, 1e-9), 'along(0.625) = (50,100) 朝左');
const aw = S.along(sq, 1.125); ok(near(aw.x, 50, 1e-9) && near(aw.y, 0, 1e-9), '闭合路径 along 绕回 1.125 = 0.125');
const ac = S.along(sq, 0.25, { lookahead: 20 }); ok(near(ac.angle, Math.PI / 4, 1e-9), 'lookahead 在直角处给 45°', ac.angle.toFixed(4));
ok(S.along(sq, 0.1, { orient: false }).angle === 0, 'orient:false → 0');

// morph
const A = S.polygon(200, 200, 100, 4, Math.PI / 4), B = S.star(260, 220, 120, 50, 5, -Math.PI / 2);
const m = S.morph(A, B, { samples: 200 });
ok(maxDev(m(0), S.toShape(A)) < 1e-9 && maxDev(m(1), S.toShape(B)) < 1e-9, 'morph(0)/morph(1) 回到两端形状（原样）');
const devA = maxDev(m(1e-9), S.toShape(A)), devB = maxDev(m(1 - 1e-9), S.toShape(B));
ok(devA < 0.01 && devB < 0.01, 'p→0⁺/1⁻ 与端点形状偏差 < 0.01px（角点吸附）', `${devA.toExponential(2)} / ${devB.toExponential(2)}`);
let xs = 0; for (let k = 1; k < 20; k++) xs += S.selfCrossings(m(k / 20)); ok(xs === 0, '方→五角星 19 个中间态自交 = 0', xs);
const mn = S.morph(A, B, { samples: 200, align: 'none', winding: 'keep' }); let xn = 0; for (let k = 1; k < 20; k++) xn += S.selfCrossings(mn(k / 20));
console.log(`  对照：align:none + winding:keep 的中间态自交 = ${xn}（对齐后 ${xs}），平均位移² ${mn.pairs[0].cost.toFixed(0)} vs ${m.pairs[0].cost.toFixed(0)}`);
const ccw = 'M300 100 L100 100 L100 300 L300 300 Z'; const mw = S.morph(S.circle(200, 200, 100), ccw); ok(mw.pairs[0].reversed, '绕向相反时反转 b');
let xw = 0; for (let k = 1; k < 20; k++) xw += S.selfCrossings(mw(k / 20)); ok(xw === 0, '圆→逆时针方：中间态自交 0', xw);
// 多子路径
const two = S.circle(100, 100, 40) + S.circle(300, 100, 40), three = S.circle(100, 300, 40) + S.circle(200, 300, 40) + S.circle(300, 300, 40);
let threw = false; try { S.morph(two, three); } catch (e) { threw = /orphans/.test(e.message); } ok(threw, '子路径数不同又没给 orphans → 抛错');
const mo = S.morph(two, three, { orphans: 'self' }); ok(mo.pairs.length === 3 && mo.pairs.filter((p) => p.a === null).length === 1, 'orphans:self → 2 对 + 1 个长出', JSON.stringify(mo.pairs.map((p) => [p.a, p.b])));
const mid = mo.pairs.findIndex((p) => p.a === null); const g = mo(0.5)[mid]; const cx = g.pts.reduce((a, p) => a + p[0], 0) / g.pts.length;
const rr = Math.max(...g.pts.map((p) => Math.hypot(p[0] - 200, p[1] - 300)));
ok(near(cx, 200, 0.01) && near(rr, 20, 0.05), '孤儿在 p=0.5 时是以自己质心为心、半径一半的圆', `cx=${cx.toFixed(3)} r=${rr.toFixed(3)}`);
const mN = S.morph(two, three, { orphans: 'nearest' }); const oi = mN.pairs.findIndex((p) => p.a === null); const pN = mN(1e-9)[oi].pts;
const tgt = mN.pairs.filter((p) => p.a !== null).map((p) => S.toShape(two)[p.a]); 
ok(pN.every((q) => near(q[0], pN[0][0], 1e-6) && near(q[1], pN[0][1], 1e-6)) && (near(pN[0][0], 100, 1e-3) || near(pN[0][0], 300, 1e-3)) && near(pN[0][1], 100, 1e-3), "orphans:'nearest' 孤儿从对面最近子路径的质心长出", JSON.stringify(pN[0].map((v) => +v.toFixed(3))));
// 孔洞
const ring = 'M0 0 H200 V200 H0 Z M50 50 V150 H150 V50 Z', ring2 = S.circle(100, 100, 100) + 'M100 60 A40 40 0 1 0 100 140 A40 40 0 1 0 100 60 Z';
const mh = S.morph(ring, ring2); ok(mh.pairs.every((p) => p.a === p.b), '外框配外框、孔配孔', JSON.stringify(mh.pairs.map((p) => [p.a, p.b])));
// 开放
const mo2 = S.morph('M0 0 L100 0', 'M100 50 L0 50'); ok(mo2.pairs[0].reversed, '开放路径：反向位移更小时反转');
// 耗时
for (const N of [64, 256, 1000]) {
  let t0 = process.hrtime.bigint(); const mm = S.morph(S.circle(500, 500, 300), S.star(500, 500, 400, 150, 7), { samples: N }); const build = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint(); for (let k = 0; k < 200; k++) mm(k / 200); const per = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  t0 = process.hrtime.bigint(); for (let k = 0; k < 200; k++) S.trim(S.circle(500, 500, 300), 0, k / 200, 0.1); const tr = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  console.log(`  耗时 N=${N}: morph 建表 ${build.toFixed(2)} ms，m(p) ${per.toFixed(4)} ms/次；trim(circle r=300) ${tr.toFixed(4)} ms/次`);
}
let t0 = process.hrtime.bigint(); for (let k = 0; k < 100; k++) S.pathSampler(S.circle(500, 500, 300 + k * 1e-3)); console.log(`  pathSampler(circle r=300) 建表 ${(Number(process.hrtime.bigint() - t0) / 1e6 / 100).toFixed(3)} ms，点数 ${S.toShape(S.circle(500,500,300))[0].pts.length}`);

// 组合子
const vo = { 起: 1.2, 落: 3.0 };
const Q = M.sequence([{ name: 'a', until: '起' }, { name: 'b', until: '落', overlap: 0.4 }, { name: 'c', dur: 2 }], { marks: vo });
ok(Q.end === 5 && JSON.stringify(Q.boundaries) === '[1.2,3]', 'sequence 边界来自具名时刻：[1.2, 3]，end 5');
ok(JSON.stringify(Q.cuts) === '[1.2]', 'cuts 只含硬切 [1.2]', JSON.stringify(Q.cuts));
ok(Q.windows.length === 1 && near(Q.windows[0].start, 2.8, 1e-12) && near(Q.windows[0].end, 3.2, 1e-12) && Q.windows[0].label === 'b→c', '交棒窗口 b→c [2.8, 3.2]');
ok(Q.at(1.1999)[0].name === 'a' && Q.at(1.2).length === 1 && Q.at(1.2)[0].name === 'b' && Q.at(1.2)[0].local === 0, '硬切：1.2 那一帧只有 b，local=0');
const h = Q.at(3.0); ok(h.length === 2 && h[0].name === 'b' && near(h[0].exit, 0.5, 1e-12) && h[1].name === 'c' && near(h[1].enter, 0.5, 1e-12) && near(h[1].local, 0.2, 1e-12), '交棒中点：b.exit=0.5，c.enter=0.5，c.local=0.2');
ok(Q.at(3.2).length === 1 && Q.at(3.2)[0].name === 'c', '窗口右端开：3.2 只有 c');
ok(Q.at(-1)[0].name === 'a' && Q.at(99)[0].name === 'c', '片外夹到首/末镜头');
ok(near(Q.at(2.1)[0].progress, 0.5, 1e-12), 'progress 是名义区间进度');
let bad = 0; for (const f of [() => M.sequence([{ name: 'a', dur: 1 }, { name: 'b', until: 0.5 }]), () => M.sequence([{ name: 'a', until: 'x' }], { marks: {} }), () => M.sequence([{ name: 'a', dur: 1, overlap: 3 }, { name: 'b', dur: 1 }]), () => M.sequence([{ name: 'a', dur: 1 }, { name: 'a', dur: 1 }])]) { try { f(); } catch { bad++; } }
ok(bad === 4, '非递增 / 找不到具名时刻 / 窗口越界 / 重名 都抛错');
const bg = M.beatGrid(120, 0.5); const Qb = M.sequence([{ name: 'x', until: bg.bar(1) }, { name: 'y', until: bg.bar(2) }]); ok(JSON.stringify(Qb.cuts) === '[2.5]' && Qb.end === 4.5, '边界直接用节拍栅格');
const C = M.series([1, 2, 0.5], 1); ok(JSON.stringify(C.cuts) === '[2,4]' && C.end === 4.5 && C.at(3).index === 1 && near(C.at(3).local, 1, 1e-12), 'series：cuts [2,4]，at(3) 第 1 段 local 1');
ok(M.loopT(2.5, 1) === 0.5 && M.loopT(-1, 1) === 0 && M.loopT(5, 1, { times: 2 }) === 1 && M.loopT(1.25, 1, { from: 0.5 }) === 0.75, 'loopT');
ok(M.rate(3, 2, 1) === 5 && M.rate(3, -1, 2) === 1, 'rate');
ok(M.freeze(1, 2, 1) === 1 && M.freeze(2.5, 2, 1) === 2 && M.freeze(4, 2, 1) === 3 && M.freeze(9, 2) === 2, 'freeze');
console.log(`\n${pass} 通过，${failN} 失败`); process.exit(failN ? 1 : 0);
