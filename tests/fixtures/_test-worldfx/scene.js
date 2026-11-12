import {createStage3D,THREE} from './runtime/stage3d.js';
import {bakePaint,bakeShader} from './runtime/texture3d.js';
import {bakeGroundMask,createPlanarReflection,applyGround} from './runtime/ground3d.js';
import {bakeSmokeAtlas,createSpriteFX} from './runtime/spritefx3d.js';
import {hash01} from './runtime/rand.js';
const q=new URLSearchParams(location.search),size=Number(q.get('size')??540),width=Number(q.get('width')??size),height=Number(q.get('height')??size);
const S=createStage3D({canvas:document.querySelector('canvas'),width,height,clear:[.025,.045,.08,1],toneMapping:THREE.ACESFilmicToneMapping,shadows:true});
window.DURATION=1.2;
const hemi=new THREE.HemisphereLight(0xb6c9ee,0x27303a,2);S.scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffdbab,4);sun.position.set(2,5,3);sun.castShadow=true;sun.shadow.mapSize.set(512,512);sun.shadow.camera.left=-5;sun.shadow.camera.right=5;sun.shadow.camera.top=5;sun.shadow.camera.bottom=-5;S.scene.add(sun);
const paint=bakePaint({size:128,seed:13,tileMeters:1,layers:[{period:8,amplitude:.001},{period:32,amplitude:.0004}],damage:{amount:.52,softness:.4,depth:.001,period:4},palette:{paint:{color:[.045,.12,.21],roughness:.4,metalness:.1},primer:{color:[.2,.16,.13],roughness:.7,metalness:0},rust:{color:[.19,.06,.018],roughness:.9,metalness:0},metal:{color:[.3,.31,.33],roughness:.3,metalness:1}}});
const mat=new THREE.MeshStandardMaterial({map:paint.map,normalMap:paint.normalMap,aoMap:paint.aoMap,roughnessMap:paint.roughnessMap,metalnessMap:paint.metalnessMap,roughness:1,metalness:1});
const box=new THREE.Mesh(new THREE.BoxGeometry(1.3,1.6,1.1),mat);box.position.set(-.9,.8,-.5);box.castShadow=true;S.scene.add(box);
const hot=new THREE.Mesh(new THREE.TorusGeometry(.55,.1,12,48),new THREE.MeshStandardMaterial({color:0xffb361,emissive:0xff7820,emissiveIntensity:3}));hot.position.set(1,.8,-1);S.scene.add(hot);
const gm=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.5,metalness:0});
const ground=new THREE.Mesh(new THREE.PlaneGeometry(12,12),gm);ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;S.scene.add(ground);
const mask=bakeGroundMask({size:128,seed:7,bounds:[-6,-6,12,12],heightRange:[-.08,.08],pits:[{x:6,z:6,rx:3,rz:2,depth:.06},{x:8,z:5,rx:1,rz:2,depth:.04}],macroMeters:3});
const reflection=createPlanarReflection(S,{height:0,width:256,resolution:256,clipBias:.001,hide:[ground]});
const wet=applyGround(gm,{mask,reflection:q.has('noreflect')?null:reflection,dryColor:[.22,.24,.27],wetColor:[.07,.09,.12],roughness:[.8,.5,.2,.045],tileMeters:[3.7,.61],seam:{spacing:2,width:.035,depth:.005},transition:{damp:.06,soak:.025,puddle:.015},ripple:{scale:2,speed:6,amplitude:.015}});
const depthTarget=new THREE.WebGLRenderTarget(width,height);depthTarget.depthTexture=new THREE.DepthTexture(width,height);
const softDepth=q.has('soft')?{texture:depthTarget.depthTexture,width,height,near:S.camera.near,far:S.camera.far,distance:.3}:null;
const atlas=bakeSmokeAtlas({cellSize:48,columns:4,seed:9,erosion:.7,lobes:7});
const sparks=Array.from({length:50},(_,i)=>({t:.2+hash01(11,i)*.15,life:.6,origin:[.8,.8,.2],velocity:[(hash01(12,i)-.5)*5,hash01(13,i)*4,(hash01(14,i)-.5)*3],size:.018,seed:i}));
const spark=createSpriteFX(S,{events:sparks,mode:'spark',gravity:[0,-6,0],drag:1.5,colors:[[14,7,1],[1,.1,.01]],opacity:1,stretch:.04,minPixels:1,maxPixels:60,blending:'add'});S.scene.add(spark.mesh);
const smoke=createSpriteFX(S,{events:Array.from({length:12},(_,i)=>({t:i*.04,life:1.4,origin:[.8,.05,.2],velocity:[(hash01(20,i)-.5)*.4,.6+hash01(21,i)*.3,0],size:.6,seed:i})),mode:'smoke',gravity:[0,.1,0],drag:.3,colors:[[.55,.59,.65],[.18,.22,.28]],opacity:.5,stretch:0,minPixels:1,maxPixels:200,blending:'normal',atlas,softDepth,light:{direction:[2,5,3],color:[1.2,1.05,.8],ambient:[.25,.3,.4],wrap:.5,backscatter:.7}});S.scene.add(smoke.mesh);
const flame=createSpriteFX(S,{events:[{t:.2,life:.4,origin:[.8,.8,.2],velocity:[0,.1,0],size:.65,seed:8}],mode:'flame',gravity:[0,0,0],drag:0,colors:[[8,2,.1],[1,.05,.01]],opacity:.7,stretch:0,minPixels:1,maxPixels:160,blending:'normal',atlas});S.scene.add(flame.mesh);
// GPU 烘焙框架也实际接入一张可见地面标记，防止只测不使用。
const baked=bakeShader(S.renderer,{size:32,fragmentShader:'varying vec2 vUv; void main(){gl_FragColor=vec4(vUv,.2,1.);}'});
const tag=new THREE.Mesh(new THREE.PlaneGeometry(.5,.5),new THREE.MeshBasicMaterial({map:baked.texture}));tag.rotation.x=-Math.PI/2;tag.position.set(-2,.006,1);S.scene.add(tag);
S.freeze();
window.seek=t=>S.frame(t,()=>{
  S.camera.position.set(4+Math.sin(t)*.2,3.3,5);S.camera.lookAt(0,.4,0);box.rotation.y=t*.2;hot.rotation.y=-t*.4;
  wet.set({t,waterLevel:0,wetness:q.has('dry')?0:1});spark.update(t);smoke.update(t);flame.update(t);
  if(softDepth){
    const old=S.renderer.getRenderTarget();const particles=[spark.mesh,smoke.mesh,flame.mesh];const vis=particles.map(o=>o.visible);
    try{particles.forEach(o=>{o.visible=false;});S.camera.updateMatrixWorld();S.renderer.setRenderTarget(depthTarget);S.renderer.clear();S.renderer.render(S.scene,S.camera);}
    finally{particles.forEach((o,i)=>{o.visible=vis[i];});S.renderer.setRenderTarget(old);}
  }
  if(!q.has('noreflect'))reflection.render();
});
window.ready=Promise.resolve().then(()=>window.seek(0));
window.worldfx={S,mask,reflection,paint,atlas};
