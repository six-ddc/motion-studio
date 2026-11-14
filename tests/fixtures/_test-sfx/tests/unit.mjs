import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importRuntime } from '../../../../skills/film-core/lib/runtime-node.mjs';
// node unit.mjs                 全部断言
// node unit.mjs --hash-only     只打印一段综合混音的 PCM 哈希（跨进程确定性用例会起两个子进程跑它）
// node unit.mjs --update-pins   重写 recipe-pcm.json（改了配方、确认是有意的之后才用）
const rt = await importRuntime('sfx.mjs'), dsp = await importRuntime('sfxdsp.mjs');
const { renderCues, renderStereo, SOUNDS, RATE, toWav } = rt;
const hash = (x) => createHash('sha256').update(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex');
const HERE = dirname(fileURLToPath(import.meta.url));
// 立体声配方（rain）：samplesR 存在时哈希两路；必填参数（density/hard）在这里给，单声道配方仍是 {}
const pcm = (o) => o.samplesR ? createHash('sha256').update(Buffer.from(o.samples.buffer)).update(Buffer.from(o.samplesR.buffer)).digest('hex') : hash(o.samples);
const REQ = { rain: { density: 300, hard: 0.5 } };

// 综合混音：配方（有 id / 无 id、jitter）、空间尾音（两种 IR、显式 tail）、闷音、duck、master
function composite() {
  const cues = [
    { t: 0.1, id: 'shot:0', type: 'crack', gain: 0.4, jitter: { pitch: 0.04, gain: 0.1 }, space: { preset: 'outdoor', gain: 0.12 } },
    { t: 0.2, id: 'shot:1', type: 'crack', gain: 0.4, jitter: { pitch: 0.04, gain: 0.1 }, space: { preset: 'outdoor', gain: 0.12 }, tail: true },
    { t: 0.6, type: 'impact', params: { material: 'glass', ring: 2 }, pan: 0.5, space: { gain: 0.2, preset: 'indoor' }, tail: true },
    { t: 1.0, type: 'boom', gain: 0.3, muffle: { amount: 0.6, recover: 0.5 }, duck: { depth: 0.3, recover: 0.3 } },
    { t: 1.5, type: 'clatter', params: { hits: 5 }, bus: 'dry' },
  ];
  const r = renderStereo(cues, { master: { comp: { threshold: -12, ratio: 4, attack: 0.002, release: 0.1 }, clip: true } });
  return createHash('sha256').update(Buffer.from(r.L.buffer)).update(Buffer.from(r.R.buffer)).digest('hex');
}
if (process.argv.includes('--hash-only')) { console.log(composite()); process.exit(0); }

let passed = 0;
function test(name, f) { f(); passed++; console.log(`✓ ${name}`); }
const cues = Object.keys(SOUNDS).map((type, i) => ({ type, t: i * .8, gain: .7, seed: 1234 + i }));
// 基线来自扩展前 HEAD^ 的运行时；覆盖原7音色和已有 noise 连续层。
test('旧音色单声道 PCM 与扩展前 SHA256 相同', () => assert.equal(hash(renderCues(cues)), '27681f0fa290072d76cef383e11ac81fd5194aff00a73e5e5d1d5c061438879a'));
test('旧音色等功率声像 PCM 逐样本不变', () => {
 const { L, R } = renderStereo(cues.map((c, i) => ({ ...c, pan: (i % 3 - 1) * .5 })));
 assert.equal(hash(L), '22b27eb53368999b9dea93d4713f9793b930e07dfcea964e50536c5c8b6b7446');
 assert.equal(hash(R), 'f0df1aa38e0d78fe6dbe9ee67a37afd1bc012b1111b2b1fb8c3b71a7eedc5ef1');
});
test('旧 Freeverb PCM 逐样本不变', () => {
 const { L, R } = renderStereo(cues.map((c, i) => ({ ...c, send: .3, pan: (i % 3 - 1) * .5 })), { room: { size: .6, damp: .4 } });
 assert.equal(hash(L), '879b3c8b39ba98ec82d72d5df943347ca22815d109ce76eda00373757291639c');
 assert.equal(hash(R), '4f18b7f72be15bbbe6289430a4282a3e23eea12516e67ea4fdab8c5aa085a946');
});
test('采样率只有一个来源：RATE === SR', () => { assert.equal(RATE, dsp.SR); assert.equal(rt.SR, dsp.SR); });

const out = resolve(HERE, '../out/recipes'); mkdirSync(out, { recursive: true });
const samples = {};
for (const name of Object.keys(dsp.RECIPES)) {
 const mats = name === 'impact' ? ['metal', 'concrete', 'wood', 'glass', 'water'] : [null];
 for (const material of mats) {
  const key = name + (material ? '-' + material : ''), opts = { params: material ? { material } : (REQ[name] ?? {}), variant: 0, seed: 73 };
  const A = dsp.renderRecipe(name, opts), a = A.samples, b = dsp.renderRecipe(name, opts);
  test(`${key} 同种子逐样本确定、变体改变输出、无过载/NaN、去直流`, () => {
   assert.equal(pcm(A), pcm(b));
   assert.notEqual(pcm(A), pcm(dsp.renderRecipe(name, { ...opts, variant: 1 })));
   const st = dsp.stats(A.samplesR ? [a, A.samplesR] : [a]); assert.equal(st.nan, 0); assert.equal(st.over, 0); assert(st.peak > .89 && st.peak <= .901);
   assert(Math.abs(st.dc) < 1e-3, `${key} 直流 ${st.dc}`);   // 旧 boom 约 0.009；20 Hz 高通后 < 1e-4
  });
  writeFileSync(resolve(out, key + '.wav'), A.samplesR ? rt.toWavStereo(a, A.samplesR) : toWav(a)); samples[key] = a; if (A.samplesR) samples[key + ':R'] = A.samplesR;
 }
}

// 每个配方（impact 每种材质）× 每个变体的 PCM 钉死：默认种子，就是片子里不写 seed 时得到的声音
const PINS = resolve(HERE, 'recipe-pcm.json');
const pinsNow = {};
for (const [name, R] of Object.entries(dsp.RECIPES)) for (const material of name === 'impact' ? ['metal', 'concrete', 'wood', 'glass', 'water'] : [null])
 for (let v = 0; v < R.variants.length; v++) pinsNow[`${name}${material ? '-' + material : ''}/v${v}`] = pcm(dsp.renderRecipe(name, { params: material ? { material } : (REQ[name] ?? {}), variant: v }));
if (process.argv.includes('--update-pins')) { writeFileSync(PINS, JSON.stringify(pinsNow, null, 1) + '\n'); console.log(`已重写 ${PINS}（${Object.keys(pinsNow).length} 条）`); }
test(`配方 PCM 钉死（${Object.keys(pinsNow).length} 个 配方×材质×变体，recipe-pcm.json）`, () => {
 assert(existsSync(PINS), '没有 recipe-pcm.json：确认配方是有意改的之后跑 --update-pins');
 const pins = JSON.parse(readFileSync(PINS, 'utf8'));
 assert.deepEqual(Object.keys(pinsNow).sort(), Object.keys(pins).sort(), '配方/变体集合变了');
 const diff = Object.keys(pins).filter((k) => pins[k] !== pinsNow[k]);
 assert.equal(diff.length, 0, `这些配方的 PCM 变了：${diff.join(' ')}（有意改的就 --update-pins）`);
});
test('跨进程确定：两个独立 node 进程的综合混音 PCM 与本进程逐位相同', () => {
 const me = composite();
 for (let i = 0; i < 2; i++) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--hash-only'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), me);
 }
});

test('crack 最大瞬态落在前15ms，boom 含长余韵', () => {
 const x = samples.crack; let peak = 0;
 for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[peak])) peak = i;
 assert(peak / RATE < .015); assert(samples.boom.length >= 3 * RATE);
});
test('FFT 卷积与朴素卷积一致（最大误差 < 1e-7）', () => {
 const x = Float32Array.from([1,.2,-.4,.7]), h = Float32Array.from([.2,1,-.1]); const y = dsp.convolve(x,h);
 const ref = new Float32Array(6); x.forEach((a,i)=>h.forEach((b,j)=>{ref[i+j]+=a*b;}));
 assert(Math.max(...y.map((v,i)=>Math.abs(v-ref[i]))) < 1e-7);
});
test('分块双声道卷积与逐路整段卷积一致（含全零块跳过、奇数块数）', () => {
 const ir = dsp.makeIR({ preset: 'outdoor', gain: 1 }), x = new Float32Array(RATE * 9);
 x.set(samples.crack, RATE * 0.5); x.set(samples.boom, Math.round(RATE * 5.3));
 const [yl, yr] = dsp.convolveStereo(x, ir.L, ir.R), rl = dsp.convolve(x, ir.L), rr = dsp.convolve(x, ir.R);
 let m = 0, p = 0; for (let n = 0; n < rl.length; n++) { m = Math.max(m, Math.abs(yl[n] - rl[n]), Math.abs(yr[n] - rr[n])); p = Math.max(p, Math.abs(rl[n])); }
 assert.equal(yl.length, rl.length); assert(m / p < 1e-6, `相对误差 ${m / p}`);
});
test('连射每串只补一次末发尾音；both 可保留首发；burstGap 必须显式给', () => {
 const c = [0,.1,.2,1].map(t => ({t,space:'outdoor'}));
 assert.deepEqual([...dsp.planTails(c,{burstGap:.15}).keys()],[2,3]);
 assert.deepEqual([...dsp.planTails(c,{burstGap:.15,edges:'both'}).keys()],[0,2,3]);
 assert.throws(()=>dsp.planTails(c),/burstGap/);
 assert.equal(dsp.planTails([{t:0,type:'click'}]).size,0);   // 没有 space 就不需要 burstGap
});
test('阴性：space 键序不同仍是同一个空间（旧代码按 JSON.stringify 分组，把一串拆成两串）', () => {
 const b=[0,.05,.1].map((t,i)=>({t,space:i%2?{gain:.1,preset:'outdoor'}:{preset:'outdoor',gain:.1}}));
 assert.deepEqual([...dsp.planTails(b,{burstGap:.15}).keys()],[2]);
 assert.equal(dsp.spaceKey('outdoor', false), dsp.spaceKey({ scale: 1, preset: 'outdoor', gain: .3 }, false));
});
test('显式 tail 优先：有 tail 字段就严格按它挂，spaceRule 不参与；tail:true 缺 space 报错', () => {
 const sp={preset:'indoor',gain:.1};
 const c=[{t:0,space:sp},{t:.1,space:sp,tail:true},{t:.2,space:sp},{t:3,space:sp,tail:false}];
 assert.deepEqual([...dsp.planTails(c).keys()],[1]);
 assert.deepEqual([...dsp.planTails(c,{burstGap:.15,edges:'both'}).keys()],[1]);
 assert.throws(()=>dsp.planTails([{t:0,tail:true}]),/space/);
 assert.throws(()=>dsp.planTails([{t:0,space:sp,tail:'yes'}]),/tail/);
});
test('空间尾音完整保留，左右去相关，同输入确定；space.gain 必填', () => {
 const ir = dsp.makeIR('indoor'), c = [{ t: .1, samples: Float32Array.from([.4]), space: { preset: 'indoor', gain: 1 }, tail: true }];
 const a=renderStereo(c), b=renderStereo(c);
 assert(a.L.length >= Math.ceil((.1+ir.L.length/RATE)*RATE));
 assert.equal(hash(a.L),hash(b.L)); assert.notEqual(hash(ir.L),hash(ir.R));
 let tail=0; for(let n=RATE*.8;n<a.L.length;n++) tail+=a.L[n]**2; assert(tail>1e-5);
 assert.equal(a.tailMode,'explicit');
 assert.throws(()=>renderStereo([{ t: 0, type: 'click', space: 'indoor', tail: true }]),/gain/);
});
test('闷音压低高频，dry 总线保持原样，duck 指数恢复；recover 必填', () => {
 const mf={amount:.9,recover:1.1};
 const a=renderStereo([{t:0,type:'shimmer',muffle:mf}]), b=renderStereo([{t:0,type:'shimmer',bus:'dry',muffle:mf}]);
 const plain=renderStereo([{t:0,type:'shimmer'}]); assert.equal(hash(b.L),hash(plain.L));
 const energy=x=>x.reduce((s,v)=>s+v*v,0); assert(energy(a.L)<energy(b.L)*.3);
 const g=dsp.duckCurve([{t:0,duck:{depth:.2,recover:.2}}], RATE*3); assert(Math.abs(g[0]-.2)<1e-6); assert(g[RATE]>.99);
 assert.throws(()=>dsp.duckCurve([{t:0,duck:.2}], RATE),/recover/);
 assert.throws(()=>dsp.muffleCurve([{t:0,muffle:.5}], RATE),/recover/);
});
test('可选总线压缩/软削波控制过载且立体声联动', () => {
 const L=new Float32Array(4800).fill(2),R=new Float32Array(4800).fill(1);
 const info=dsp.applyMaster(L,R,{comp:{threshold:-12,ratio:8,attack:.001,release:.1},clip:true});
 assert(info.comp.maxReductionDb>10); assert(dsp.stats([L,R]).over===0);
 assert(Math.abs(L.at(-1)/R.at(-1)-2)<1e-5);
});
test('无效音高、时长、空间尺寸与滤波 Q 明确报错', () => {
 assert.throws(()=>dsp.renderRecipe('riser',{params:{dur:0}}),/dur/);
 assert.throws(()=>dsp.renderRecipe('boom',{params:{size:-1}}),/size/);
 assert.throws(()=>dsp.renderRecipe('crack',{pitch:0}),/pitch/);
 assert.throws(()=>dsp.makeIR({preset:'indoor',scale:0}),/scale/);
 assert.throws(()=>dsp.biquad('lp',500,0),/q/);
 assert.throws(()=>dsp.renderRecipe('crack',{params:{drive:'2'}}),/数字/);
 assert.throws(()=>dsp.renderRecipe('boom',{params:{pings:1.5}}),/pings/);
});
// ── 阴性对照：旧代码在这些输入上静默出错 ──
test('阴性：drive 0 报错（旧代码 1/tanh(0)=∞，整段 NaN 写成静音、退出 0）', () => {
 for (const n of ['crack', 'boom', 'sub']) assert.throws(()=>dsp.renderRecipe(n,{params:{drive:0}}),/drive/);
 assert.throws(()=>dsp.softclip(new Float32Array(4),0),/drive/);
});
test('阴性：jitter 每次出现各抖各的（旧代码按变体取种子，每 4 发重复一次）', () => {
 const ex=dsp.expandRecipes([0,1,2,3,4,5,6,7].map(t=>({t,type:'crack',jitter:{pitch:.05,gain:.1}})));
 assert.equal(new Set(ex.map(c=>c._recipe.pitch)).size, 8);
 assert.equal(new Set(ex.map(c=>hash(c.samples))).size, 8);
});
test('有 id 时变体/抖动跟着 id 走：在前面插一个同名事件，后面的声音不变', () => {
 const mk=(ts)=>ts.map(([t,id])=>({t,id,type:'step',jitter:.03}));
 const a=dsp.expandRecipes(mk([[1,'s:a'],[2,'s:b'],[3,'s:c']])), b=dsp.expandRecipes(mk([[.5,'s:new'],[1,'s:a'],[2,'s:b'],[3,'s:c']]));
 for (let i=0;i<3;i++) { assert.equal(hash(a[i].samples),hash(b[i+1].samples)); assert.deepEqual(a[i]._recipe,b[i+1]._recipe); }
 const vs=dsp.expandRecipes(Array.from({length:40},(_,i)=>({t:i,id:`x${i}`,type:'step'}))).map(c=>c._recipe.variant);
 assert.equal(new Set(vs).size, dsp.RECIPES.step.variants.length);   // 按 id 哈希也用得到全部变体
 // 没有 id：仍按出现序号轮换（插入会改后面的，这是文档里写明的代价）
 const n=dsp.expandRecipes([0,1,2,3].map(t=>({t,type:'step'}))).map(c=>c._recipe.variant); assert.deepEqual(n,[0,1,2,3]);
});
test('同参数配方在一张表里只渲一次（缓存），结果与单独渲染逐位相同', () => {
 const ex=dsp.expandRecipes([0,1,2,3,4].map(t=>({t,type:'crack',variant:1})));
 assert(ex.every(c=>c.samples===ex[0].samples));
 assert.equal(hash(ex[0].samples), hash(dsp.renderRecipe('crack',{variant:1}).samples));
});
test('阴性：缓冲随参数变长（旧代码 metal 0.5 s、boom 3√size、clatter 0.55 s 固定，余振/后几次撞击被截掉）', () => {
 const tailRatio=(x)=>{ let e=0,p=0; for(let n=0;n<x.length;n++){p=Math.max(p,Math.abs(x[n]));} for(let n=x.length-Math.round(.06*RATE);n<x.length-Math.round(.012*RATE);n++) e=Math.max(e,Math.abs(x[n])); return e/p; };
 const m1=dsp.renderRecipe('impact',{params:{material:'metal'}}).samples, m4=dsp.renderRecipe('impact',{params:{material:'metal',ring:4}}).samples;
 assert(m4.length>=2*RATE); assert(tailRatio(m4)<2*tailRatio(m1)+1e-3, `ring 4 截断处仍有 ${tailRatio(m4)}`);
 const c8=dsp.renderRecipe('clatter',{params:{hits:8}}).samples; let late=0; for(let n=Math.round(.6*RATE);n<c8.length;n++) late=Math.max(late,Math.abs(c8[n]));
 assert(c8.length>.9*RATE && late>.005, `clatter 第 6 次以后的撞击 ${late}`);
 assert(dsp.renderRecipe('boom',{params:{size:4}}).samples.length>=(1.9*4+.2)*RATE-1);
 assert.equal(dsp.renderRecipe('boom').samples.length, 3*RATE);   // 默认长度不变
 assert.equal(dsp.renderRecipe('clatter').samples.length, Math.round(.55*RATE));
});
test('rain：density/hard 必填且报出参考量级；范围外参数报错', () => {
 assert.throws(()=>dsp.renderRecipe('rain'),/density/);
 assert.throws(()=>dsp.renderRecipe('rain',{params:{density:300}}),/hard/);
 assert.throws(()=>dsp.renderRecipe('rain',{params:{density:300,hard:'1'}}),/hard/);
 assert.throws(()=>dsp.renderRecipe('rain',{params:{density:0,hard:.5}}),/density/);
 for (const k of ['distance','pool','width']) assert.throws(()=>dsp.renderRecipe('rain',{params:{density:300,hard:.5,[k]:1.5}}),new RegExp(k));
});
test('rain：立体声去相关（width 1 相关系数 < 0.3，width 0 左右逐位相同），长度 = dur，首尾无跳变', () => {
 const corr=(x,y)=>{let a=0,b=0,c=0;for(let n=0;n<x.length;n++){a+=x[n]*y[n];b+=x[n]*x[n];c+=y[n]*y[n];}return a/Math.sqrt(b*c);};
 const L=samples.rain, R=samples['rain:R'];
 assert.equal(L.length, 6*RATE); assert(Math.abs(corr(L,R))<.3, `相关 ${corr(L,R)}`);
 const m=dsp.renderRecipe('rain',{params:{density:300,hard:.5,width:0}}); assert(m.samples.every((v,i)=>v===m.samplesR[i]));
 // 循环接缝：末样本 → 首样本的跳变不超过缓冲内相邻样本差的 99.9 分位
 for (const x of [L,R]) { const d=[]; for(let n=1;n<x.length;n++) d.push(Math.abs(x[n]-x[n-1])); d.sort((a,b)=>a-b);
  assert(Math.abs(x[0]-x[x.length-1]) <= d[Math.floor(d.length*.999)], `接缝跳变 ${Math.abs(x[0]-x[x.length-1])}`); }
});
test('rain：renderStereo 用 cue.dur 循环成长床，左右各读各的；单声道路径取 (L+R)/√2', () => {
 const c={t:0,type:'rain',params:{density:200,hard:.3,dur:2},dur:5,gain:.5};
 const {L,R}=renderStereo([c]); assert(L.length>=5*RATE); assert.notEqual(hash(L),hash(R));
 const e=dsp.expandRecipes([c])[0], n=Math.round(2.5*RATE), src=n%e.samples.length;   // 2.5 s 处读的是第二圈的 0.5 s
 assert(Math.abs(L[n]-.5*Math.SQRT1_2*e.samples[src])<1e-6 && Math.abs(R[n]-.5*Math.SQRT1_2*e.samplesR[src])<1e-6);
 const mono=renderCues([{t:0,type:'rain',params:{density:200,hard:.3,dur:2}}]); assert(Math.abs(mono[100]-(e.samples[100]+e.samplesR[100])*Math.SQRT1_2)<1e-6);
});
console.log(`\nsfx 单测全部通过：${passed} 项；配方 WAV 在 ${out}`);
