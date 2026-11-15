import assert from 'node:assert/strict';
import {importRuntime} from '../../../../skills/film-core/lib/runtime-node.mjs';
const {tileNoise,bakeHeight,normalFromHeight,bakePaint}=await importRuntime('texture3d.js');
const {bakeGroundMask,reflectionOf}=await importRuntime('ground3d.js');
const THREE=await importRuntime('three-film.module.js');
const {particleState,bakeSmokeAtlas,rainPosition,createSpriteFX}=await importRuntime('spritefx3d.js');
assert.throws(()=>bakeGroundMask({size:8,seed:1,bounds:[0,0,1,1],heightRange:[0,Infinity],pits:[],layers:{height:{meters:2,range:[.35,.75]},damp:{meters:1.4,lowBias:.4},oil:null,wear:null}}),/heightRange/);
assert.throws(()=>bakeSmokeAtlas({cellSize:8,columns:1,seed:1,erosion:Infinity,lobes:1}),/参数/);
assert.throws(()=>createSpriteFX({}, {events:[{t:0,life:Infinity,size:1,seed:1,origin:[0,0,0],velocity:[0,0,0]}],mode:'spark',gravity:[0,0,0],drag:0,colors:[[1,1,1],[0,0,0]],opacity:1,stretch:0,minPixels:1,maxPixels:10,blending:'add'}),/有限/);
for(let i=0;i<100;i++){const x=i*.137,y=i*.171;assert.ok(Math.abs(tileNoise(x,y,8,7)-tileNoise(x+8,y-8,8,7))<1e-14);}
const h=bakeHeight({size:32,seed:3,layers:[{period:4,amplitude:.003}]});assert.deepEqual(h,bakeHeight({size:32,seed:3,layers:[{period:4,amplitude:.003}]}));
const flat=normalFromHeight(new Float32Array(16),4,1);for(let i=0;i<flat.length;i+=4)assert.deepEqual([...flat.slice(i,i+4)],[128,128,255,255]);
// 正弦高度的法线斜率随物理尺寸、采样分辨率保持一致。
const normals=[64,128].map(n=>{const a=Float32Array.from({length:n*n},(_,i)=>Math.sin((i%n)/n*2*Math.PI)*.01);return normalFromHeight(a,n,1);});
assert.ok(Math.abs(normals[0][0]-normals[1][0])<=1);
const options={size:32,seed:4,tileMeters:1,layers:[{period:4,amplitude:.001}],damage:{amount:.7,softness:.3,depth:.001,period:4,detail:.2,stages:[[0,.25],[.25,.5],[.8,.2]],ao:.2},palette:Object.fromEntries(['paint','primer','rust','metal'].map((n,k)=>[n,{color:[k*.1,.1,.2],roughness:.3+k*.15,metalness:k===3?1:0}]))};
const a=bakePaint(options),b=bakePaint(options);assert.deepEqual(a.albedo,b.albedo);assert.deepEqual(a.orm,b.orm);assert.ok(a.masks.some(x=>x>0&&x<255));assert.ok(a.height.every(Number.isFinite));a.dispose();b.dispose();
assert.throws(()=>bakePaint({...options,palette:{}}),/palette.paint/);
assert.throws(()=>bakePaint({...options,damage:{...options.damage,stages:undefined}}),/stages/);
// 反照率按 sRGB 编码存 8 位：暗部 0.002 线性不再被量化成 0/1
assert.ok(a.map.colorSpace==='srgb');
const g={size:32,seed:5,bounds:[-5,-5,10,10],heightRange:[-.1,.1],pits:[{x:5,z:5,rx:2,rz:2,depth:.1}],layers:{height:{meters:2,range:[.35,.75]},damp:{meters:1.4,lowBias:.4},oil:null,wear:null}};
const mask=bakeGroundMask(g);assert.throws(()=>bakeGroundMask({...g,layers:{...g.layers,damp:undefined}}),/layers.damp/);
assert.deepEqual(mask.data,bakeGroundMask(g).data);assert.ok(mask.data[(16*32+16)*4]<mask.data[0]);
// reflectionOf：对独立的几何推导（镜像点、视线与平面交点、针孔投影）
{const cam=new THREE.PerspectiveCamera(50,1,.1,100);cam.position.set(0,1,5);cam.lookAt(0,1,-1);cam.updateProjectionMatrix();
const k=1/Math.tan(25*Math.PI/180),near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a} ≠ ${b}`);
let r=reflectionOf(cam,0,[0,1,-5],[100,100]);r.ground.forEach((v,i)=>near(v,[0,0,0][i]));near(r.ndc[1],-.2*k);near(r.px[1],50+50*.2*k);assert.ok(r.onScreen);assert.deepEqual(r.mirror,[0,-1,-5,1]);
const e=10*Math.PI/180;r=reflectionOf(cam,0,{dir:[0,Math.sin(e),-Math.cos(e)]});near(r.ground[2],5-1/Math.tan(e));near(r.ndc[1],-Math.tan(e)*k);assert.ok(r.onScreen);
assert.equal(reflectionOf(cam,0,[0,-1,-5]).ground,null);assert.equal(reflectionOf(cam,0,{dir:[0,-.2,-1]}).onScreen,false);
r=reflectionOf(cam,0,{dir:[0,Math.sin(40*Math.PI/180),-Math.cos(40*Math.PI/180)]});assert.ok(r.ground&&!r.onScreen);   // 高仰角的盘：倒影在画框下方之外
cam.position.set(0,-1,5);cam.updateMatrixWorld();assert.equal(reflectionOf(cam,0,[0,1,-5]).ground,null);
assert.throws(()=>reflectionOf(cam,0,[0,1]),/point/);}
// 缺参数的报错要写单位/取值范围（不用读夹具就能填）
assert.throws(()=>bakeGroundMask({...g,layers:{...g.layers,damp:{meters:1}}}),/layers\.damp\.lowBias（0–1/);
// 解析阻力弹道与独立 RK4 对照，而非复述实现。
for(const drag of [0,.3,3]){const opts={origin:[1,2,3],velocity:[4,5,6],gravity:[0,-9.8,0],drag};let p=opts.origin.slice(),v=opts.velocity.slice();const dt=.0001;
for(let i=0;i<10000;i++)for(let k=0;k<3;k++){const f=x=>opts.gravity[k]-drag*x;const k1=f(v[k]),k2=f(v[k]+k1*dt/2),k3=f(v[k]+k2*dt/2),k4=f(v[k]+k3*dt);p[k]+=dt*(v[k]+(v[k]+k1*dt/2)*2+(v[k]+k2*dt/2)*2+(v[k]+k3*dt))/6;v[k]+=dt*(k1+2*k2+2*k3+k4)/6;}
const r=particleState(1,opts);r.position.forEach((x,k)=>assert.ok(Math.abs(x-p[k])<1e-9));r.velocity.forEach((x,k)=>assert.ok(Math.abs(x-v[k])<1e-9));}
const atlas=bakeSmokeAtlas({cellSize:16,columns:4,seed:9,erosion:.7,lobes:5});assert.deepEqual(atlas.data,bakeSmokeAtlas({cellSize:16,columns:4,seed:9,erosion:.7,lobes:5}).data);
let start=0,end=0;for(let y=0;y<16;y++)for(let x=0;x<16;x++){start+=atlas.data[(y*64+x)*4+3];end+=atlas.data[((y+48)*64+x+48)*4+3];}assert.ok(start>end);
const rain={seed:3,box:[4,8,4],velocity:[1,-5,0],center:[0,1,0]};for(const t of [0,.9,30,-2]){const p=rainPosition(0,t,rain);assert.deepEqual(p,rainPosition(0,t,rain));p.forEach((x,k)=>assert.ok(x>=rain.center[k]-rain.box[k]/2&&x<rain.center[k]+rain.box[k]/2));}
console.log('worldfx 单测全部通过：周期/法线尺度/破损ORM/唯一遮罩/倒影预检/解析阻力/烟侵蚀/雨盒');
