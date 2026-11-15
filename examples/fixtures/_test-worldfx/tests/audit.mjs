import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {resolveFilm} from '../../../../skills/film-core/lib/film.mjs';
import {openScene} from '../../../../skills/film-core/lib/browser.mjs';
const F=resolveFilm(fileURLToPath(new URL('..',import.meta.url))),p=await openScene(F,'1x1');
try {
 const result=await p.page.evaluate(async()=>{
  const {createStage3D,THREE}=await import('./runtime/stage3d.js');
  const {createSpriteFX}=await import('./runtime/spritefx3d.js');
  const {bakeShader}=await import('./runtime/texture3d.js');
  const canvas=document.createElement('canvas');
  const S=createStage3D({canvas,width:65,height:65,clear:[0,0,0,1],toneMapping:THREE.ACESFilmicToneMapping});
  const {renderer:r,camera}=S; camera.position.set(0,0,0);camera.lookAt(0,0,-1);camera.near=.1;camera.far=10;camera.updateProjectionMatrix();
  const spec={events:[{t:0,life:10,origin:[0,0,-2],velocity:[0,0,0],size:1,seed:3}],mode:'spark',gravity:[0,0,0],drag:0,colors:[[.2,.1,.05],[.2,.1,.05]],opacity:.5,stretch:0,minPixels:0,maxPixels:200,blending:'normal'};
  const fx=createSpriteFX(S,spec),scene=new THREE.Scene();scene.add(fx.mesh);fx.update(0);
  const read=()=>{const data=new Uint8Array(65*65*4);r.getContext().readPixels(0,0,65,65,r.getContext().RGBA,r.getContext().UNSIGNED_BYTE,data);return data;};
  r.render(scene,camera);const a=Array.from(read().slice((32*65+32)*4,(32*65+32)*4+4));
  scene.remove(fx.mesh);
  const ref=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:new THREE.Color(.2,.1,.05),transparent:true,opacity:.5,premultipliedAlpha:true}));ref.position.z=-2;scene.add(ref);r.render(scene,camera);
  const b=Array.from(read().slice((32*65+32)*4,(32*65+32)*4+4));scene.remove(ref);
  // 纵深方向速度会产生径向屏幕运动，应呈对角拉伸，而非固定水平线。
  const radial=createSpriteFX(S,{...spec,opacity:1,stretch:.6,minPixels:1,maxPixels:100,events:[{t:0,life:10,origin:[.5,.5,-3],velocity:[0,0,2],size:.01,seed:3}]});scene.add(radial.mesh);radial.update(.3);r.render(scene,camera);const pixels=read();
  let w=0,mx=0,my=0;const pts=[];
  for(let y=0;y<65;y++)for(let x=0;x<65;x++){const v=pixels[(y*65+x)*4];if(v>0){pts.push([x,y,v]);w+=v;mx+=x*v;my+=y*v;}}mx/=w;my/=w;
  let xy=0,xx=0,yy=0;for(const[x,y,v]of pts){xy+=(x-mx)*(y-my)*v;xx+=(x-mx)**2*v;yy+=(y-my)**2*v;}
  const corr=xy/Math.sqrt(xx*yy);
  scene.remove(radial.mesh);
  // 极小阻力与零阻力的可见位置应连续，避免GPU相消把重力位移放大。
  const centers=[];
  for(const drag of [0,.0001]){
    const q=createSpriteFX(S,{...spec,drag,opacity:1,minPixels:4,maxPixels:4,gravity:[0,-1,0],events:[{t:0,life:10,origin:[0,.5,-3],velocity:[.1,.5,0],size:.05,seed:3}]});
    scene.add(q.mesh);q.update(1);r.render(scene,camera);const data=read();let sum=0,cx=0,cy=0;
    for(let y=0;y<65;y++)for(let x=0;x<65;x++){const w=data[(y*65+x)*4];sum+=w;cx+=x*w;cy+=y*w;}
    centers.push([cx/sum,cy/sum]);scene.remove(q.mesh);q.dispose();
  }
  // 平面反射保持线性HDR值，没有提前tone-map或夹到1。
  const {S:main,reflection}=window.worldfx;window.seek(.6);const half=new Uint16Array(256*256*4);main.renderer.readRenderTargetPixels(reflection.target,0,0,256,256,half);
  let hdrMax=0;for(let i=0;i<half.length;i++)if(i%4!==3)hdrMax=Math.max(hdrMax,THREE.DataUtils.fromHalfFloat(half[i]));
  // 恢复的不只是 RT 身份，还包括立方图面与 mip 层。
  const cube=new THREE.WebGLCubeRenderTarget(32);r.setRenderTarget(cube,3,1);const baked=bakeShader(r,{size:8,fragmentShader:'void main(){gl_FragColor=vec4(1.);}'});
  const restored=r.getRenderTarget()===cube&&r.getActiveCubeFace()===3&&r.getActiveMipmapLevel()===1;
  r.setRenderTarget(null);baked.dispose();cube.dispose();radial.dispose();fx.dispose();ref.geometry.dispose();ref.material.dispose();r.dispose();
  return{sprite:a,reference:b,corr,restored,centers,hdrMax};
 });
 assert(result.sprite.every((x,i)=>Math.abs(x-result.reference[i])<=2),JSON.stringify(result));
 assert(result.corr>.7,JSON.stringify(result));assert(result.restored);assert(result.hdrMax>1);
 assert(Math.hypot(result.centers[0][0]-result.centers[1][0],result.centers[0][1]-result.centers[1][1])<.1,JSON.stringify(result));
 assert.deepEqual(p.errors,[]);console.log('worldfx 独立审查通过：预乘输出与标准材质一致、透视径向火花拉伸、RT面/mip恢复',JSON.stringify(result));
}finally{await p.close();}
