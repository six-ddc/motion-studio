import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolveFilm} from '../../../../skills/film-core/lib/film.mjs';
import {openScene,launchBrowser,makeComparer} from '../../../../skills/film-core/lib/browser.mjs';
const F=resolveFilm(fileURLToPath(new URL('..',import.meta.url)));
const b=await launchBrowser(),cmp=await makeComparer(b);let tests=0;
const scene=mode=>openScene(F,'9x16',{browser:b,query:{mode,scale:.25},record:false});
try{
 const s0=await scene('off');let reference;
 try{reference=await s0.shot(.4);}finally{await s0.close()}
 for(const mode of ['ao','volume']){
  const s=await scene(mode);
  try{
   const on=await s.shot(.4);
   await s.page.evaluate(mode=>{const post=postTest.post,render=post.render;post.render=(t,p)=>render(t,{...p,[mode]:{...p[mode],...(mode==='ao'?{strength:0}:{sigma:0})}})},mode);
   const off=await s.shot(.4);
   const noop=await cmp.compare(reference,off);assert.equal(noop.diff,0,`${mode} 的零强度不应改变画面`);tests++;
   const effect=await cmp.compare(on,off);assert.ok(effect.diff>100,`${mode} 应实际改变图像`);tests++;
   console.log(`✓ ${mode}: 零强度 ${noop.diff} 像素不同，开启 ${effect.diff} 像素不同`);
  }finally{await s.close()}
 }
 const s=await scene('flare');
 try{
  const visible=await s.shot(.4);
  await s.page.evaluate(()=>{const post=postTest.post,render=post.render;post.render=(t,p)=>render(t,{...p,flare:{...p.flare,depthCutoff:1.1}})});
  const hidden=await s.shot(.4),diff=await cmp.compare(visible,hidden);assert.ok(diff.diff>50,'眩光要响应当前深度可见度');tests++;
  console.log(`✓ flare: 深度遮挡关闭 ${diff.diff} 像素不同`);
 }finally{await s.close()}
 const sky=await openScene(F,'9x16',{browser:b,query:{mode:'volume',scale:.25,horizon:1},record:false});
 try{await sky.shot(.4);assert.deepEqual(sky.errors,[]);tests++;console.log('✓ volume: SKY_GLSL 与 rig.uniforms() 同源远景接口编译/渲染通过');}finally{await sky.close()}
 const msaa=await openScene(F,'9x16',{browser:b,query:{mode:'all',scale:.25,samples:4},record:false});
 try{
  const before=await msaa.shot(.4);await msaa.shot(.8);const after=await msaa.shot(.4);
  const d=await cmp.compare(before,after);assert.equal(d.diff,0);tests++;assert.deepEqual(msaa.errors,[]);tests++;
  console.log('✓ MSAA4 + 深度 AO/雾/眩光: 乱序回到同帧 0 像素不同');
 }finally{await msaa.close()}
 const a=await scene('all');try{
  const stat=await a.page.evaluate(()=>{const {post,params}=postTest;const M={center:[.75,.1,.55],clamp:[.002,40]};const m=post.measure(M);window.seek(.8);window.seek(.4);const n=post.measure(M);const p=params(.4);delete p.volume.sun;let error='';try{post.render(.4,p)}catch(e){error=e.message}return {m,n,error}});
  assert.ok(Number.isFinite(stat.m));tests++;assert.ok(Number.isFinite(stat.n));tests++;assert.match(stat.error,/volume.sun/);tests++;
  assert.deepEqual(a.errors,[]);tests++;
  const edge=await a.page.evaluate(async()=>{
   const {S}=postTest,{createPost}=await import('/runtime/post3d.js'),{THREE}=await import('/runtime/stage3d.js');
   let missing='';try{createPost(S,{volume:{steps:2,light:S.scene.children.find(x=>x.isDirectionalLight),horizonGLSL:'uniform vec3 customHorizon; vec3 horizonColor(vec3 d){return customHorizon;}'}})}catch(e){missing=e.message}
   const target=new THREE.WebGLRenderTarget(S.width,S.height),p=createPost(S,{output:target,tonemap:{curves:['neutral']}});
   S.frame(.4,()=>({exposure:1,tonemap:{}}));const before=S.renderer.getRenderTarget()===target,exposure=S.renderer.toneMappingExposure;
   const value=p.measure({center:null,clamp:[1e-4,1e4]}),after=S.renderer.getRenderTarget()===target,exposureUnchanged=exposure===S.renderer.toneMappingExposure;
   S.frame(.1,()=>({exposure:.5,tonemap:{}}));const pixels=new Uint8Array(4);S.renderer.readRenderTargetPixels(target,10,10,1,1,pixels);
   const rendered=Array.from(pixels).some(x=>x>0);p.dispose();target.dispose();return {missing,before,after,exposureUnchanged,value,rendered};
  });
  assert.match(edge.missing,/horizonUniforms.customHorizon/);tests++;
  for(const k of ['before','after','exposureUnchanged','rendered']){assert.equal(edge[k],true,k);tests++;}
  assert.ok(Number.isFinite(edge.value));tests++;
  console.log('✓ 自定义 output RT / measure 状态恢复 / horizon 漏槽校验通过');
 }finally{await a.close()}
 // 拉丝只作用于亮部：mix 泛光的 mip 不带阈值，拉丝要自己提取。画面下部 30%（地面，远离太阳/发光球）应不变
 const dec=await b.newPage();
 const rows=async(png,y0,y1)=>dec.evaluate(async([s,y0,y1])=>{const bm=await createImageBitmap(await (await fetch('data:image/png;base64,'+s)).blob());
   const c=new OffscreenCanvas(bm.width,bm.height),g=c.getContext('2d');g.drawImage(bm,0,0);const a=Math.floor(bm.height*y0),h=Math.floor(bm.height*y1)-a;return Array.from(g.getImageData(0,a,bm.width,h).data);},[png.toString('base64'),y0,y1]);
 const region=async(A,B,y0,y1)=>{const a=await rows(A,y0,y1),c=await rows(B,y0,y1);let n=0,mx=0;for(let i=0;i<a.length;i+=4){const d=Math.max(Math.abs(a[i]-c[i]),Math.abs(a[i+1]-c[i+1]),Math.abs(a[i+2]-c[i+2]));if(d>1)n++;mx=Math.max(mx,d);}return {n,mx,total:a.length/4};};
 const st=await scene('streak');
 try{
  const on=await st.shot(.4);
  await st.page.evaluate(()=>{const post=postTest.post,render=post.render;post.render=(t,p)=>render(t,{...p,streak:{...p.streak,amount:0}})});
  const off=await st.shot(.4);
  const dark=await region(on,off,.7,1),bright=await region(on,off,0,.25);
  assert.equal(dark.n,0,`拉丝不该改动远离亮部的地面：${JSON.stringify(dark)}`);tests++;
  assert.ok(bright.n>100,`拉丝应作用在太阳附近：${JSON.stringify(bright)}`);tests++;
  console.log(`✓ streak: 下部 30% ${dark.n}/${dark.total} 像素变化（>1/255），太阳带 ${bright.n} 像素变化`);
 }finally{await st.close()}
 // 眩光出画淡出：太阳从画内跨到画外不跳变；超过 offscreen[1] 归零
 const fl=await scene('flare');
 try{
  const at=async uv=>{await fl.page.evaluate(uv=>{const post=postTest.post;post.__r??=post.render;post.render=(t,p)=>post.__r(t,{...p,flare:{...p.flare,light:undefined,lightUV:uv}})},uv);return fl.shot(.4);};
  const in0=await at([.994,.85]),inA=await at([.998,.85]),inB=await at([1.002,.85]),far=await at([1.2,.85]);
  const off=await (async()=>{await fl.page.evaluate(()=>{const post=postTest.post;post.render=(t,p)=>post.__r(t,{...p,flare:{...p.flare,amount:0}})});return fl.shot(.4);})();
  const move=await cmp.compare(in0,inA),jump=await cmp.compare(inA,inB),gone=await cmp.compare(far,off);
  // 同样挪 0.004：画内挪动的变化量是基准，跨边那一步不能比它大出一截（旧实现跨边时 3/9 的可见度采样直接判 0）
  assert.ok(jump.max<=move.max+2,`太阳跨出画框边时眩光不能跳变：画内 ${JSON.stringify(move)}，跨边 ${JSON.stringify(jump)}`);tests++;
  assert.equal(gone.diff,0,'NDC 超过 offscreen[1] 时眩光为 0');tests++;
  console.log(`✓ flare: 画内挪 0.004 最大差 ${move.max}/255、跨画框边 ${jump.max}/255，出画 1.4 NDC 与关闭 0 像素不同`);
 }finally{await fl.close()}
 // 半精度溢出：场景里一个 1e6 的像素（写进 HalfFloat 变 Inf）不能经泛光变成整片 NaN；强度 0 的一帧不读上一帧的 RT；comp 链还原全局曝光
 const nan=await scene('off');
 try{
  const r=await nan.page.evaluate(async()=>{
   const {createPost}=await import('/runtime/post3d.js'),{createStage3D,THREE}=await import('/runtime/stage3d.js');
   const S=createStage3D({canvas:document.createElement('canvas'),width:96,height:96,clear:[0,0,0,1]});
   const hot=new THREE.Mesh(new THREE.SphereGeometry(.3,12,8),new THREE.MeshBasicMaterial({color:new THREE.Color(1e6,1e6,1e6)}));hot.position.set(0,0,-3);S.scene.add(hot);
   const target=new THREE.WebGLRenderTarget(S.width,S.height,{type:THREE.HalfFloatType});
   const p=createPost(S,{output:target,bloom:{levels:4},dof:{}});
   const ex=S.renderer.toneMappingExposure;
   const bad=()=>{const d=new Uint16Array(S.width*S.height*4);S.renderer.readRenderTargetPixels(target,0,0,S.width,S.height,d);let n=0;for(const x of d)if((x&0x7c00)===0x7c00&&(x&0x3ff))n++;return n;};
   const P=s=>({exposure:.7,bloom:{threshold:1,knee:.5,strength:s,radius:.6},dof:{focus:8,blur:s*10,maxBlur:12}});
   S.freeze();S.frame(.4,()=>{},P(1));const a=bad();S.frame(.4,()=>{},P(0));const b=bad();const keep=S.renderer.toneMappingExposure===ex;
   p.dispose();target.dispose();S.renderer.dispose();return {a,b,keep};
  });
  assert.equal(r.a,0,`泛光/景深开着时不应出现 NaN：${JSON.stringify(r)}`);tests++;
  assert.equal(r.b,0,`强度 0 的一帧不应读到旧 RT：${JSON.stringify(r)}`);tests++;
  assert.ok(r.keep,'comp 链画完要还原 renderer.toneMappingExposure');tests++;
  console.log('✓ 半精度溢出：泛光/景深开与关两帧都没有 NaN，全局曝光已还原');
 }finally{await nan.close();await dec.close()}
 // 前景层：pinForeground 压过深度的物体被景深读成贴脸近处、整块糊掉；foreground:{depth} 时恒在焦内
 const fgs=await scene('off');
 try{
  const r=await fgs.page.evaluate(async()=>{
   const {createPost}=await import('/runtime/post3d.js'),{createStage3D,THREE}=await import('/runtime/stage3d.js'),{pinForeground}=await import('/runtime/sky3d.js');
   const run=fg=>{
    const S=createStage3D({canvas:document.createElement('canvas'),width:96,height:96,clear:[0,0,0,1]});
    S.scene.add(new THREE.HemisphereLight(0xffffff,0x444444,3));
    const floor=new THREE.Mesh(new THREE.BoxGeometry(6,.2,6),new THREE.MeshStandardMaterial({color:0x888888}));floor.position.y=-1;S.scene.add(floor);
    const gun=new THREE.Mesh(new THREE.BoxGeometry(.6,.6,.6),new THREE.MeshStandardMaterial({color:0x888888}));gun.position.set(0,-.55,-2.2);S.scene.add(gun);pinForeground(gun,{range:.05});
    const target=new THREE.WebGLRenderTarget(96,96);
    const p=createPost(S,{output:target,dof:{resolution:1},...(fg?{foreground:{depth:.05}}:{})});
    S.camera.position.set(0,.3,0);S.camera.lookAt(0,-1,-3);S.freeze();
    const shot=(st,vis)=>{S.frame(0,()=>{S.camera.position.set(0,.3,0);S.camera.lookAt(0,-1,-3);gun.visible=vis;},{exposure:1,dof:{focus:3.5,blur:st*12,maxBlur:12}});
      const d=new Uint8Array(96*96*4);S.renderer.readRenderTargetPixels(target,0,0,96,96,d);return d;};
    const a=shot(0,true),b=shot(1,true),bg=shot(0,false);p.dispose();target.dispose();S.renderer.dispose();
    // 前景块 = 有无前景差别大的像素，再向内收 3 像素（边缘本来就会被背景的散景盖到）
    const m=new Uint8Array(96*96);for(let i=0;i<96*96;i++)m[i]=Math.abs(a[i*4]-bg[i*4])+Math.abs(a[i*4+1]-bg[i*4+1])>20?1:0;
    let n=0,area=0;
    for(let y=3;y<93;y++)for(let x=3;x<93;x++){let inner=1;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)inner&=m[(y+dy)*96+x+dx];if(!inner)continue;area++;const i=(y*96+x)*4;if(Math.abs(a[i]-b[i])>2)n++;}
    return {n,area};
   };
   return {plain:run(false),fg:run(true)};
  });
  assert.ok(r.plain.area>20&&r.plain.n>50,`不开 foreground 时前景被景深糊掉（对照）：${JSON.stringify(r)}`);tests++;
  assert.ok(r.fg.area>20&&r.fg.n===0,`foreground 时前景恒在焦内：${JSON.stringify(r)}`);tests++;
  console.log(`✓ foreground: 前景块内部景深改变 ${r.plain.n}/${r.plain.area} 像素（不开）→ ${r.fg.n}/${r.fg.area}（开）`);
 }finally{await fgs.close()}
 console.log(`✓ post 浏览器 ${tests} 条断言通过：AO/雾零强度恒等、开关有效、当前帧眩光遮挡、测光、漏参报错`);
}finally{await cmp.close();await b.close()}
