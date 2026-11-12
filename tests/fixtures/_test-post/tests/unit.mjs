import assert from 'node:assert/strict';
import { importRuntime } from '../../../../skills/film-core/lib/runtime-node.mjs';
const {exposureTrack}=await importRuntime('post3d.js');
let checks=0;const close=(a,b,eps=1e-12)=>{assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);checks++};
const table={fps:2,logAvg:[Math.log(.1),Math.log(.4),Math.log(.8),Math.log(.2)]};
const e=exposureTrack(table,{key:.2,power:1,min:.3,max:4,tau:0});
for(const [t,v] of [[-1,2],[0,2],[.5,.5],[1,.3],[1.5,1],[4,1],[.25,1.25]])close(e(t),v);
const smooth=exposureTrack(table,{key:.2,power:.5,min:.01,max:10,tau:.4});
const rate=1-Math.exp(-.5/.4);let l=table.logAvg[0];
for(let i=0;i<table.logAvg.length;i++){l+=rate*(table.logAvg[i]-l);close(smooth(i*.5),Math.pow(.2/Math.exp(l),.5));}
const xs=Array.from({length:101},(_,i)=>i/50);const ref=xs.map(smooth);
for(const i of Array.from({length:101},(_,j)=>(j*37)%101))close(smooth(xs[i]),ref[i],0);
for(const input of [null,{fps:0,logAvg:[0]},{fps:2,logAvg:[]},{fps:2,logAvg:[NaN]},{fps:Infinity,logAvg:[0]}]){assert.throws(()=>exposureTrack(input,{}));checks++;}
for(const t of [NaN,Infinity,-Infinity]){assert.throws(()=>e(t),/t 要是有限数/);checks++;}
for(const k of ['key','power','min','max','tau']){const o={key:.2,power:1,min:.1,max:4,tau:0};delete o[k];assert.throws(()=>exposureTrack(table,o),new RegExp(k));checks++;}
console.log(`✓ post exposure ${checks} 条断言：限幅、因果对数平滑、插值、乱序逐位相同、非法输入`);
