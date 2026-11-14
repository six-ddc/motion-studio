import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { importRuntime } from '../../../../skills/film-core/lib/runtime-node.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const F = resolve(root, 'tests/fixtures/_test-sfx'), out = resolve(F, 'out'); mkdirSync(out,{recursive:true});
const script = resolve(root,'skills/film-narration/scripts/sfx.mjs');
const run = args => spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'});
const film = ['--film','_test-sfx','--films-dir','tests/fixtures'];
const json = (p) => JSON.parse(readFileSync(resolve(out, p), 'utf8'));
assert.equal(run(['--help']).status,0);
assert.equal(run(['--no-such-option']).status,2);
const list=run(['--list-sounds']); assert.equal(list.status,0); assert.match(list.stdout,/crack.*冲击/);
const {RATE,toWavStereo}=await importRuntime('sfx.mjs');
// 中间 WAV 是 32 位浮点：fmt 格式码 3，样本 >1 原样保留（不在 sfx.mjs 削顶，响度归一交给 mux.sh）
function readFloatWav(p) {
 const b = readFileSync(p); assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt16LE(20), 3, `${p} 不是浮点 WAV`);
 const ch = b.readUInt16LE(22); let o = 12; while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
 const n = b.readUInt32LE(o + 4) / 4, d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = b.readFloatLE(o + 8 + i * 4);
 return { ch, rate: b.readUInt32LE(24), d };
}
let n = 0; const ok = (m) => { n++; console.log(`✓ ${m}`); };

// ── 事件表 → cues.json（film-core events.js 的 toCues），不需要 ffmpeg ──
const ev = await importRuntime('events.js');
const shots = [
 ...[.5,.57,.64,.71,.78].map(t => ({ t, type: 'shot', pan: -.4, power: .8 })),
 { t: 1.4, type: 'land', id: 'land-hero', pan: 0, power: 1 },
 ...[2,2.07,2.14].map(t => ({ t, type: 'shot', pan: .3, power: .6 })),
];
function eventCues(src) {
 const snapped = ev.snapToFrames(ev.eventTrack(src), 30);
 const fired = ev.merge(ev.throttle(snapped, { on: 'shot', minGap: .06 }), snapped.only('land'));
 const ends = ev.burstEnds(fired, { on: 'shot', gap: .15 });
 return ev.toCues(fired, { shot: { type: 'crack', gain: (e) => e.power * .5, jitter: { pitch: .03, gain: .1 }, space: { preset: 'outdoor', gain: .12 } },
  land: { type: 'land', gain: .5 } }, { tails: ends });
}
writeFileSync(resolve(out,'cues-events.json'), JSON.stringify(eventCues(shots), null, 1));
let r = run([...film,'--cues','out/cues-events.json','--out','out/sfx-events.wav','--stats']);
assert.equal(r.status,0,r.stdout+r.stderr);
const m1 = json('sfx-events.json');
assert.equal(m1.tailMode,'explicit'); assert.equal(m1.spaceRule,null);
assert.deepEqual(m1.tails.map(x=>x.id),['shot:4','shot:7'],'尾音只挂在每串末发（toCues 写的 tail: true），不靠 spaceRule 判串');
assert.deepEqual(m1.cues.map(c=>c.id),['shot:0','shot:1','shot:2','shot:3','shot:4','land-hero','shot:5','shot:6','shot:7']);
assert(m1.cues.every(c=>Math.abs(c.t*30-Math.round(c.t*30))<.02),'cue 时刻是对齐到帧之后的（sfx.json 记到毫秒）');
assert.equal(m1.stats.nan,0);
const w = readFloatWav(resolve(out,'sfx-events.wav')); assert.equal(w.ch,2); assert.equal(w.rate,RATE);
ok('事件表 → toCues → cues.json：id/pan 透传，显式 tail 决定尾音，浮点 WAV');
// 在表尾追加一发更早的枪（默认 id 按原表序号，旧的 id 不变）：已有事件的变体与抖动不变
writeFileSync(resolve(out,'cues-events2.json'), JSON.stringify(eventCues([...shots, { t: .2, type: 'shot', pan: 0, power: .5 }]), null, 1));
r = run([...film,'--cues','out/cues-events2.json','--out','out/sfx-events2.wav']);
assert.equal(r.status,0,r.stdout+r.stderr);
const m2 = json('sfx-events2.json'), byId = Object.fromEntries(m2.cues.map(c=>[c.id,c]));
for (const c of m1.cues) assert.deepEqual([byId[c.id].variant,byId[c.id].pitch],[c.variant,c.pitch],`插入别的事件后 ${c.id} 的声音变了`);
ok('插入一个事件不改其他事件的变体/抖动（按 id 取种子）');

// ── 非有限数：一律退出 1、不写文件 ──
writeFileSync(resolve(out,'cues-inf.json'), JSON.stringify([{ t: 0, type: 'click', gain: 1e39 }]));
writeFileSync(resolve(out,'sfx-inf.wav'), 'stale');
r = run([...film,'--cues','out/cues-inf.json','--out','out/sfx-inf.wav']);
assert.equal(r.status,1,r.stdout+r.stderr); assert.match(r.stderr,/NaN\/Inf/); assert(!existsSync(resolve(out,'sfx-inf.wav')),'旧的输出文件没删');
writeFileSync(resolve(out,'cues-drive.json'), JSON.stringify([{ t: 0, type: 'crack', params: { drive: 0 } }]));
r = run([...film,'--cues','out/cues-drive.json','--out','out/sfx-drive.wav']);
assert.equal(r.status,1); assert.match(r.stderr,/drive/);
ok('阴性：Inf 增益 / drive 0 不加 --stats 也退出 1（旧代码写成静音、退出 0）');

// ── 立体声配方（rain）只用 params 也走立体声路径（单声道路径会把去相关的两路折成一路）──
writeFileSync(resolve(out,'cues-rain.json'), JSON.stringify([{ t: 0, type: 'rain', params: { density: 150, hard: .4, dur: 1.5 }, gain: .5 }]));
r = run([...film,'--cues','out/cues-rain.json','--out','out/sfx-rain.wav']);
assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/立体声/);
const rw = readFloatWav(resolve(out,'sfx-rain.wav')); assert.equal(rw.ch,2);
let dLR=0; for (let i=0;i<rw.d.length;i+=2) dLR=Math.max(dLR,Math.abs(rw.d[i]-rw.d[i+1])); assert(dLR>.01,'rain 左右应去相关');
writeFileSync(resolve(out,'cues-rain-bad.json'), JSON.stringify([{ t: 0, type: 'rain', params: { density: 150 } }]));
r = run([...film,'--cues','out/cues-rain-bad.json','--out','out/sfx-rain-bad.wav']);
assert.equal(r.status,1); assert.match(r.stderr,/hard/);
ok('rain 配方自动走立体声路径、左右去相关；缺 hard 退出 1');

const bad=run([...film,'--cues','out/cues-bad.json']);
assert.notEqual(bad.status,0);   // 文件不存在也是明确输入错误，不要求一个特定退出码。

// ── 配乐 duck 全长恢复：要 ffmpeg 解码 ──
const ff = spawnSync('ffmpeg',['-version']);
if (ff.error) {
 console.log(`✗ 配乐段没跑：PATH 上没有 ffmpeg（${ff.error.code}）。sfx.mjs 解码 music.src / file 素材要它；装 ffmpeg 后重跑`);
 process.exit(1);
}
const x=Float32Array.from({length:RATE*6},(_,n)=>.15*Math.sin(2*Math.PI*600*n/RATE));
writeFileSync(resolve(out,'music.wav'),toWavStereo(x,x));
writeFileSync(resolve(out,'cues-music.json'),JSON.stringify({music:{src:'out/music.wav',out:'out/music-sfx.wav'},cues:[{t:0,type:'click',duck:{depth:.1,recover:2}}]}));
rmSync(resolve(out,'music-sfx.wav'),{force:true});
r=run([...film,'--cues','out/cues-music.json','--out','out/sfx-cli.wav','--stats']);
assert.equal(r.status,0,r.stdout+r.stderr);
const mw=readFloatWav(resolve(out,'music-sfx.wav'));
const at=Math.round(4*RATE)+17, got=mw.d[at*2];
const expected=Math.round(x[at]*32767)/32768*(1-.9*Math.exp(-at/RATE/2));   // 源是 16 位 WAV，ffmpeg 解成浮点按 1/32768
assert(Math.abs(got-expected)<1e-5,`长配乐恢复曲线 ${got} vs ${expected}`);
const meta=json('sfx-cli.json');
assert.equal(meta.stats.nan,0); assert.equal(meta.music.duck,true);
ok('配乐 duck 全长恢复（浮点 WAV）');
console.log(`sfx CLI 全部通过：${n} 组（help/未知参数/音色列表/事件表 cues/非有限数/配乐全长恢复/统计）`);
