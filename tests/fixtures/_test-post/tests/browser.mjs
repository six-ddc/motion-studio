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
  const stat=await a.page.evaluate(()=>{const {post,params}=postTest;const m=post.measure();window.seek(.8);window.seek(.4);const n=post.measure();const p=params(.4);delete p.volume.sun;let error='';try{post.render(.4,p)}catch(e){error=e.message}return {m,n,error}});
  assert.ok(Number.isFinite(stat.m));tests++;assert.ok(Number.isFinite(stat.n));tests++;assert.match(stat.error,/volume.sun/);tests++;
  assert.deepEqual(a.errors,[]);tests++;
  const edge=await a.page.evaluate(async()=>{
   const {S}=postTest,{createPost}=await import('/runtime/post3d.js'),{THREE}=await import('/runtime/stage3d.js');
   let missing='';try{createPost(S,{volume:{steps:2,light:S.scene.children.find(x=>x.isDirectionalLight),horizonGLSL:'uniform vec3 customHorizon; vec3 horizonColor(vec3 d){return customHorizon;}'}})}catch(e){missing=e.message}
   const target=new THREE.WebGLRenderTarget(S.width,S.height),p=createPost(S,{output:target,tonemap:{curves:['neutral']}});
   S.frame(.4,()=>({exposure:1,tonemap:{}}));const before=S.renderer.getRenderTarget()===target,exposure=S.renderer.toneMappingExposure;
   const value=p.measure(),after=S.renderer.getRenderTarget()===target,exposureUnchanged=exposure===S.renderer.toneMappingExposure;
   S.frame(.1,()=>({exposure:.5,tonemap:{}}));const pixels=new Uint8Array(4);S.renderer.readRenderTargetPixels(target,10,10,1,1,pixels);
   const rendered=Array.from(pixels).some(x=>x>0);p.dispose();target.dispose();return {missing,before,after,exposureUnchanged,value,rendered};
  });
  assert.match(edge.missing,/horizonUniforms.customHorizon/);tests++;
  for(const k of ['before','after','exposureUnchanged','rendered']){assert.equal(edge[k],true,k);tests++;}
  assert.ok(Number.isFinite(edge.value));tests++;
  console.log('✓ 自定义 output RT / measure 状态恢复 / horizon 漏槽校验通过');
 }finally{await a.close()}
 console.log(`✓ post 浏览器 ${tests} 条断言通过：AO/雾零强度恒等、开关有效、当前帧眩光遮挡、测光、漏参报错`);
}finally{await cmp.close();await b.close()}
