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
  // 雨滴涟漪：开/关改变积水处像素；距离淡出区间整个落在镜头内侧（[0,0.01] 米）时与不开逐像素相同；同一 t 乱序重现
  const rip=[];for(const query of [{noripple:'1'},{ripfade:'0,0.01'}])rip.push(await openScene(F,'1x1',{browser,query}));scenes.push(...rip);
  const ripOff=await rip[0].shot(.6),ripGone=await rip[1].shot(.6);
  const ripOn=await cmp.compare(images[0],ripOff);assert.ok(ripOn.diff>200,`涟漪要改变积水像素：${JSON.stringify(ripOn)}`);
  assert.equal((await cmp.compare(ripOff,ripGone)).diff,0,'超过淡出距离的涟漪要完全消失');
  const r1=await scenes[0].shot(.37);await scenes[0].shot(1.1);await scenes[0].shot(.2);assert.equal((await cmp.compare(r1,await scenes[0].shot(.37))).diff,0,'涟漪乱序必须一致');
  console.log(`worldfx 涟漪：开/关 ${ripOn.diff} 像素不同；淡出距离外 0 像素不同；乱序一致`);
  // 叠补丁：ground3d + surface3d（两种顺序，surface 替换 normal_fragment_maps 之后 ground 仍能插在后面）+ sky3d 雾；实例与批次网格
  const stack=await scenes[0].page.evaluate(async()=>{
    const {createStage3D,THREE}=await import('./runtime/stage3d.js'),{applyGround}=await import('./runtime/ground3d.js');
    const {applySurface}=await import('./runtime/surface3d.js'),{createLightRig,createHeightFog}=await import('./runtime/sky3d.js'),{patchesOf}=await import('./runtime/patch3d.js');
    const {mask}=window.worldfx,W=96;
    const S=createStage3D({canvas:document.createElement('canvas'),width:W,height:W,clear:[0,0,0,1]});
    S.scene.add(new THREE.HemisphereLight(0xffffff,0x334455,2));const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(1,3,2);S.scene.add(sun);
    const rig=createLightRig({sun:{dir:[1,3,2],color:[1,1,1],intensity:3},sky:{zenith:[.1,.2,.4],horizonSun:[.8,.6,.4],horizonAway:[.3,.4,.6],ground:[.1,.1,.1],fog:[.4,.4,.45],azimuthPower:4,zenithHeight:.25,groundHeight:.2}});
    const fog=createHeightFog(rig,{density:.05,baseHeight:0,scaleHeight:3,maxOpacity:.8,sunStrength:0,sunPower:8});S.scene.add(fog.node);
    const G=m=>applyGround(m,{mask,reflection:null,dryColor:[.3,.3,.3],wetColor:[.1,.1,.12],roughness:[.8,.5,.2,.05],tileMeters:[3,.5],grain:{albedo:.1,roughness:.05,height:.002},seam:{spacing:1,width:.03,depth:.004,darken:.3},oil:{darken:.2,roughness:.08},wear:{roughness:.05},transition:{damp:.06,soak:.025,puddle:.015},ripple:{layers:[{cell:.5,rate:1,angle:0,weight:1}],density:.8,radius:[.1,.36],width:[.005,.025],amplitude:.3,fade:[10,34]}});
    const SF=m=>applySurface(m,{antiFlicker:{toksvig:0,minRoughness:.05,maxSpecular:null},macro:{space:'world',freq:4,albedo:.6,roughness:.2}});
    const recipes={ground:m=>[G(m)],surface:m=>[SF(m)],gs:m=>[G(m),SF(m)],sg:m=>[SF(m),G(m)],sgf:m=>[SF(m),G(m),fog.apply(m)]};
    const meshes={};let x=0;
    for(const [k,f] of Object.entries(recipes)){const m=new THREE.MeshStandardMaterial({roughness:1});const sets=f(m);const pl=new THREE.Mesh(new THREE.PlaneGeometry(2,2),m);pl.rotation.x=-Math.PI/2;pl.visible=false;S.scene.add(pl);meshes[k]={mesh:pl,sets,keys:patchesOf(m)};}
    // 实例 / 批次：同一组补丁（世界坐标取自 instanceMatrix / batchingMatrix）
    const im=new THREE.MeshStandardMaterial({roughness:1});const iset=[SF(im),G(im)];const inst=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),im,2);
    for(let i=0;i<2;i++)inst.setMatrixAt(i,new THREE.Matrix4().makeRotationX(-Math.PI/2).setPosition(i-.5,0,0));inst.visible=false;S.scene.add(inst);
    const bm=new THREE.MeshStandardMaterial({roughness:1});const bset=[SF(bm),G(bm)];const batch=new THREE.BatchedMesh(2,64,96,bm);const gid=batch.addGeometry(new THREE.PlaneGeometry(1,1));
    for(let i=0;i<2;i++){const id=batch.addInstance(gid);batch.setMatrixAt(id,new THREE.Matrix4().makeRotationX(-Math.PI/2).setPosition(i-.5,0,0));}batch.visible=false;S.scene.add(batch);
    S.camera.position.set(0,1.6,1.2);S.camera.lookAt(0,0,0);S.freeze();
    const shot=obj=>{S.frame(.5,()=>{S.camera.position.set(0,1.6,1.2);S.camera.lookAt(0,0,0);obj.visible=true;for(const v of Object.values(meshes))for(const st of v.sets)st?.set?.(st.uniforms.uGTime?{t:.5,waterLevel:.05,wetness:1}:{macro:{freq:4}});for(const st of [...iset,...bset])st.set(st.uniforms.uGTime?{t:.5,waterLevel:.05,wetness:1}:{macro:{freq:4}});});
      const d=new Uint8Array(W*W*4);S.renderer.getContext().readPixels(0,0,W,W,S.renderer.getContext().RGBA,S.renderer.getContext().UNSIGNED_BYTE,d);let h=0,sum=0;for(const v of d){h=Math.imul(h^v,16777619);sum+=v;}return {h,sum};};
    const out={};for(const [k,v] of Object.entries(meshes))out[k]=shot(v.mesh);out.instanced=shot(inst);out.batched=shot(batch);
    const prog=S.renderer.info.programs.map(p=>p.diagnostics).filter(Boolean).map(d=>d.fragmentShader?.log||d.vertexShader?.log||d.programLog);
    S.renderer.dispose();return {out,keys:Object.fromEntries(Object.entries(meshes).map(([k,v])=>[k,v.keys])),prog};
  });
  assert.deepEqual(stack.prog,[],`叠补丁的程序要编译通过：${JSON.stringify(stack.prog)}`);
  for(const [k,v] of Object.entries(stack.out))assert.ok(v.sum>96*96*20,`${k} 要画出东西：${JSON.stringify(v)}`);
  for(const k of ['gs','sg'])for(const one of ['ground','surface'])assert.notEqual(stack.out[k].h,stack.out[one].h,`${k} 应同时有两个补丁的效果（不同于只 ${one}）`);
  assert.notEqual(stack.out.sgf.h,stack.out.sg.h,'再叠雾要改变画面');
  assert.deepEqual(stack.keys.sgf.map(k=>k.split(':')[0]),['surface','ground','fog']);
  console.log('worldfx 叠补丁：ground+surface 两种顺序、再叠雾、实例与批次网格全部编译渲染通过',JSON.stringify(stack.keys));
  scenes.forEach(s=>assert.deepEqual(s.errors,[]));
  console.log('worldfx 浏览器全部通过：反射/湿润/软粒子分支、RT随当帧变化、烘焙状态恢复');
}finally{for(const p of scenes)await p.close();await cmp.close();await browser.close();}
