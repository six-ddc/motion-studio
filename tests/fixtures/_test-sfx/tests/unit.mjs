import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importRuntime } from '../../../../skills/film-core/lib/runtime-node.mjs';
const rt = await importRuntime('sfx.mjs'), dsp = await importRuntime('sfxdsp.mjs');
const { renderCues, renderStereo, SOUNDS, RATE, toWav } = rt;
const hash = (x) => createHash('sha256').update(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex');
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
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../out/recipes'); mkdirSync(out, { recursive: true });
const samples = {};
for (const name of Object.keys(dsp.RECIPES)) {
 const mats = name === 'impact' ? ['metal', 'concrete', 'wood', 'glass', 'water'] : [null];
 for (const material of mats) {
  const key = name + (material ? '-' + material : ''), opts = { params: material ? { material } : {}, variant: 0, seed: 73 };
  const a = dsp.renderRecipe(name, opts).samples, b = dsp.renderRecipe(name, opts).samples;
  test(`${key} 同种子逐样本确定、变体改变输出、无过载/NaN`, () => {
   assert.equal(hash(a), hash(b));
   assert.notEqual(hash(a), hash(dsp.renderRecipe(name, { ...opts, variant: 1 }).samples));
   const st = dsp.stats([a]); assert.equal(st.nan, 0); assert.equal(st.over, 0); assert(st.peak > .89 && st.peak <= .901);
   assert(Math.abs(st.dc) < .03);
  });
  writeFileSync(resolve(out, key + '.wav'), toWav(a)); samples[key] = a;
 }
}
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
test('连射每串只补一次末发尾音；both 可保留首发', () => {
 const c = [0,.1,.2,1].map(t => ({t,space:'outdoor'}));
 assert.deepEqual([...dsp.planTails(c).keys()],[2,3]);
 assert.deepEqual([...dsp.planTails(c,{edges:'both'}).keys()],[0,2,3]);
});
test('空间尾音完整保留，左右去相关，同输入确定', () => {
 const ir = dsp.makeIR('indoor'), c = [{ t: .1, samples: Float32Array.from([.4]), space: 'indoor' }];
 const a=renderStereo(c), b=renderStereo(c);
 assert(a.L.length >= Math.ceil((.1+ir.L.length/RATE)*RATE));
 assert.equal(hash(a.L),hash(b.L)); assert.notEqual(hash(ir.L),hash(ir.R));
 let tail=0; for(let n=RATE*.8;n<a.L.length;n++) tail+=a.L[n]**2; assert(tail>1e-5);
});
test('闷音压低高频，dry 总线保持原样，duck 指数恢复', () => {
 const a=renderStereo([{t:0,type:'shimmer',muffle:.9}]), b=renderStereo([{t:0,type:'shimmer',bus:'dry',muffle:.9}]);
 const plain=renderStereo([{t:0,type:'shimmer'}]); assert.equal(hash(b.L),hash(plain.L));
 const energy=x=>x.reduce((s,v)=>s+v*v,0); assert(energy(a.L)<energy(b.L)*.3);
 const g=dsp.duckCurve([{t:0,duck:{depth:.2,recover:.2}}], RATE*3); assert(Math.abs(g[0]-.2)<1e-6); assert(g[RATE]>.99);
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
});
console.log(`\nsfx 单测全部通过：${passed} 项；配方 WAV 在 ${out}`);
