import { createStage3D, THREE } from './runtime/stage3d.js';
import { createPost, exposureTrack } from './runtime/post3d.js';
import { SKY_GLSL, createLightRig } from './runtime/sky3d.js';
import { layoutFromURL } from './runtime/layout.js';
const L=layoutFromURL(), Q=new URLSearchParams(location.search), mode=Q.get('mode')??window.POST_MODE??'all';
const all=mode==='all', enabled=k=>all||mode===k;
const S=createStage3D({canvas:document.querySelector('#stage'),width:L.width,height:L.height,scale:Number(Q.get('scale')??1),clear:[.025,.035,.055,1],shadows:true});
S.scene.background=new THREE.Color(.025,.035,.055);S.camera.near=.1;S.camera.far=80;
const light=new THREE.DirectionalLight(new THREE.Color(1,.8,.55),6);light.position.set(-4,8,-5);light.castShadow=true;
light.shadow.mapSize.set(1024,1024);Object.assign(light.shadow.camera,{left:-8,right:8,top:8,bottom:-8,near:.5,far:30});
light.shadow.normalBias=.015;light.shadow.bias=-.0001;S.scene.add(light,light.target);
S.scene.add(new THREE.HemisphereLight(new THREE.Color(.35,.5,.8),new THREE.Color(.07,.05,.03),1.5));
const floor=new THREE.Mesh(new THREE.PlaneGeometry(50,50),new THREE.MeshStandardMaterial({color:new THREE.Color(.23,.25,.28),roughness:.85}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;S.scene.add(floor);
const metal=new THREE.MeshStandardMaterial({color:new THREE.Color(.2,.23,.28),metalness:.5,roughness:.35});
for(let i=-2;i<=2;i++){
 const bar=new THREE.Mesh(new THREE.BoxGeometry(.23,5.7,.3),metal);bar.position.set(i*1.2,2.85,-1.8);bar.castShadow=true;bar.receiveShadow=true;S.scene.add(bar);
 const roof=new THREE.Mesh(new THREE.BoxGeometry(.25,.25,4.5),metal);roof.position.set(i*1.2,5.6,-2);roof.castShadow=true;roof.receiveShadow=true;S.scene.add(roof);
}
for(let i=0;i<4;i++){
 const ball=new THREE.Mesh(new THREE.SphereGeometry(.65,32,20),new THREE.MeshStandardMaterial({color:new THREE.Color(.4-i*.06,.23+i*.045,.12+i*.08),metalness:i%2?.75:0,roughness:.12+i*.23}));
 ball.position.set((i-1.5)*1.3,.65,.8);ball.castShadow=true;ball.receiveShadow=true;S.scene.add(ball);
}
const emitter=new THREE.Mesh(new THREE.SphereGeometry(.17,20,12),new THREE.MeshBasicMaterial({color:new THREE.Color(18,9,3)}));emitter.position.set(-2.1,2.5,-.5);S.scene.add(emitter);
const sun=new THREE.Mesh(new THREE.SphereGeometry(.3,24,16),new THREE.MeshBasicMaterial({color:new THREE.Color(35,25,12),depthWrite:false}));sun.position.copy(light.position);S.scene.add(sun);
const horizon=Q.has('horizon')?createLightRig({sun:{dir:[-4,8,-5],color:[1,.8,.55],intensity:6},sky:{zenith:[.025,.035,.055],horizonSun:[.2,.3,.5],horizonAway:[.1,.18,.3],ground:[.02,.02,.025],fog:[.08,.1,.16]}}).uniforms():null;
const cfg={seed:173,samples:Number(Q.get('samples')??0),tonemap:{curves:['aces','agx']},
 ...(enabled('bloom')||enabled('dirt')||enabled('streak')?{bloom:{mode:'mix',levels:5,resolution:.5,karis:.6}}:{}),
 ...(enabled('ao')?{ao:{samples:16,resolution:Number(Q.get('half')??.5)}}:{}),
 ...(enabled('volume')?{volume:{steps:24,resolution:Number(Q.get('half')??.5),light,...(horizon?{horizonGLSL:SKY_GLSL,horizonUniforms:horizon}:{})}}:{}),
 ...(enabled('dirt')?{dirt:{size:128,count:50,radius:[.004,.06],seed:72}}:{}),
 ...(enabled('streak')?{streak:{samples:17,level:2}}:{}),
 ...(enabled('flare')?{flare:{ghosts:4}}:{}),
 ...(enabled('grade')?{grade:true}:{}),
 ...(enabled('chroma')?{chroma:true}:{}),
 ...(enabled('finish')?{finish:{fxaa:true,sharpen:true,grain:true,dither:true}}:{})};
const post=createPost(S,cfg), exposure=exposureTrack({fps:1,logAvg:[-1.3,-1.2,-1.4]},{key:.2,power:.1,min:.8,max:1.2,tau:.6});
S.freeze();
function params(t){return {exposure:exposure(t),tonemap:{mix:.35,agxLook:[1,1]},
 bloom:{strength:.12,radius:.7},ao:{radius:1.2,intensity:1.1,strength:.8,fade:[30,60],tolerance:.15,lit:[.3,2,.85],tint:[0,0,0]},
 volume:{sigma:.032,maxDist:horizon?4:35,skyDistance:35,shadowBias:.001,ambientShadow:.25,sun:[3,2,.9],ambient:[.08,.1,.16],height:[0,5,.2],far:[.4,.5,.6],phase:[.65,.15,.6,1.5],near:[1.8,.5,1,25],tolerance:.18,farColor:[.2,.3,.5]},
 dirt:{amount:.3,color:[1,.9,.7]},streak:{amount:.08,radius:90,color:[.8,.9,1]},flare:{light:[-4,8,-5],amount:1.1,color:[1,.7,.35],radius:.025,haloRadius:.07,haloStrength:.05,haloWidth:.018,spacing:.7,ghostRadius:.035,visibilityRadius:6,depthCutoff:.999},
 grade:{shadow:[.94,.98,1.04],highlight:[1.03,1,.95],lift:[.001,.001,.002],range:[.03,.7],contrast:.1,saturation:.95},chroma:{amount:.6},
 finish:{fxaa:{edgeThreshold:.12,subpixel:.75},sharpen:{amount:.2,edgeThreshold:.12},grain:{amount:.004,fps:12,size:1,darkWeight:.5},dither:{amount:1}}};}
window.DURATION=1.25;
window.seek=t=>S.frame(t,()=>{S.camera.position.set(7+Math.sin(t*.6)*.3,4.2,11);S.camera.lookAt(0,2,0);},params(t));
window.postTest={S,post,params,mode};
window.ready=Promise.resolve();window.seek(0);
