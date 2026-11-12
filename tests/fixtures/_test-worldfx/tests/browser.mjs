import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolveFilm} from '../../../../skills/film-core/lib/film.mjs';
import {launchBrowser,openScene,makeComparer} from '../../../../skills/film-core/lib/browser.mjs';
const F=resolveFilm(fileURLToPath(new URL('..',import.meta.url)));
const browser=await launchBrowser(),cmp=await makeComparer(browser);
const scenes=[];
try{
  for(const query of [{},{noreflect:'1'},{dry:'1'},{soft:'1'},{noreflect:'1',soft:'1'}])scenes.push(await openScene(F,'1x1',{browser,query}));
  const images=[];for(const p of scenes)images.push(await p.shot(.6));
  for(let i=1;i<images.length;i++){const diff=await cmp.compare(images[0],images[i]);assert.ok(diff.diff>10,`分支 ${i} 没改变可见像素`);console.log(`worldfx 分支 ${i}：${diff.diff} 像素不同`);}
  const mainSoft=await cmp.compare(images[1],images[4]);assert.ok(mainSoft.diff>10,'关闭反射后的主镜头软交界必须改变像素');console.log(`worldfx 主镜头 softDepth（关闭反射）：${mainSoft.diff} 像素不同`);
  const p=scenes[3],first=await p.shot(.6);await p.shot(0);await p.shot(1);assert.equal((await cmp.compare(first,await p.shot(.6))).diff,0,'softDepth 乱序必须一致');
  // 当帧反射纹理确实随被反射物体变化，不复用前一帧；读回线性 RT。
  const hashes=[];
  for(const t of [0,.6,0])hashes.push(await scenes[0].page.evaluate(t=>{window.seek(t);const {S,reflection}=window.worldfx;const data=new Uint16Array(256*256*4);S.renderer.readRenderTargetPixels(reflection.target,0,0,256,256,data);let h=0;for(const x of data)h=Math.imul(h^x,16777619);return h;},t));
  assert.notEqual(hashes[0],hashes[1]);assert.equal(hashes[0],hashes[2]);
  // bakeShader 在非默认 viewport/scissor/目标下也必须恢复渲染器状态。
  assert.equal(await scenes[0].page.evaluate(async()=>{
    const {bakeShader}=await import('./runtime/texture3d.js'),{Vector4}=await import('./runtime/three-film.module.js'),{S,reflection}=window.worldfx,r=S.renderer;
    r.setRenderTarget(reflection.target);r.setViewport(3,4,50,60);r.setScissor(2,3,40,45);r.setScissorTest(true);
    const vp=r.getViewport(new Vector4()).toArray();
    const rt=bakeShader(r,{size:16,fragmentShader:'void main(){gl_FragColor=vec4(1.);}'});
    const v=r.getViewport(new Vector4()).toArray();
    const ok=r.getRenderTarget()===reflection.target&&r.getScissorTest()&&vp.every((x,i)=>x===v[i]);rt.dispose();r.setRenderTarget(null);r.setScissorTest(false);return ok;
  }),true);
  scenes.forEach(s=>assert.deepEqual(s.errors,[]));
  console.log('worldfx 浏览器全部通过：反射/湿润/软粒子分支、RT随当帧变化、烘焙状态恢复');
}finally{for(const p of scenes)await p.close();await cmp.close();await browser.close();}
