import { layoutFromURL } from './runtime/layout.js';
import { createStage3D, THREE } from './runtime/stage3d.js';
import { createLightRig, createSky, createHeightFog, enablePCSS } from './runtime/sky3d.js';
const L = layoutFromURL();
const S = createStage3D({ canvas: document.querySelector('#stage'), width: L.width, height: L.height,
  clear: [0,0,0,1], shadows: true, shadowType: THREE.BasicShadowMap, toneMapping: THREE.ACESFilmicToneMapping });
const rig = createLightRig({sun:{dir:[-0.55,0.27,-0.8],color:[1,0.76,0.5],intensity:3},
  sky:{zenith:[0.08,0.16,0.3],horizonSun:[1.5,0.7,0.3],horizonAway:[0.24,0.38,0.62],ground:[0.12,0.09,0.06],fog:[0.35,0.36,0.4],azimuthPower:4,zenithHeight:0.25,groundHeight:0.2}});
const sky = createSky(S,rig,{halo:[[8,0.1],[64,0.4],[600,1.2],[6000,4]],disk:{angle:0.8,intensity:60},
  clouds:{altitude:900,featureSize:1200,wind:[20,4],coverage:0.72,softness:0.12,base:[0.25,0.29,0.4],dark:[0.04,0.06,0.09],light:0.8,rim:1.2,seed:17,
    octaves:4,shadowSteps:2,horizonLift:0.1,warp:1.3,detail:0.16,aerial:11,relief:4.5,opacity:0.985,veil:0.92,hole:{radius:5,feather:6,strength:0.9},gap:{away:2,sun:12,ragged:0.6}}});
const envStart=performance.now(); const env=sky.environment({at:0,clamp:5,intensity:0.8,size:128});S.finish();
window.skyBench={pmremMs:performance.now()-envStart};
const sun=rig.createSun({castShadow:true,mapSize:1024,bias:-0.0002,normalBias:0.02});S.scene.add(sun,sun.target,rig.createAmbient(0.25));
const fog=createHeightFog(rig,{density:0.012,baseHeight:0,scaleHeight:4,maxOpacity:0.85,sunStrength:0.04,sunPower:8});S.scene.add(fog.node);
const mats=[];
function mat(c,r,m){const a=new THREE.MeshStandardMaterial({color:c,roughness:r,metalness:m});fog.apply(a);mats.push(a);return a;}
const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),mat(0x55514a,0.8,0));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;S.scene.add(ground);
for(let j=0;j<2;j++)for(let i=0;i<4;i++){
 const ball=new THREE.Mesh(new THREE.SphereGeometry(0.6,32,20),mat(j?0xb9b5ae:0xa39378,0.08+i*0.27,j));
 ball.position.set((i-1.5)*1.6,0.6,j*-2);ball.castShadow=ball.receiveShadow=true;S.scene.add(ball);
}
const dims=rig.fitShadow(sun,new THREE.Box3(new THREE.Vector3(-6,-0.1,-6),new THREE.Vector3(6,4,4)),{margin:1});
enablePCSS(S,sun,mats,{sunAngle:3,maxRadius:0.5,samples:12,blockerSamples:8});
window.skyBench.shadow=dims;
window.DURATION=1;
window.seek=t=>S.frame(t,()=>{sky.update(t);S.camera.fov=55;S.camera.position.set(4,1.8,6);S.camera.lookAt(0,1.2,-2);});
window.__finish=()=>S.finish();
window.ready=Promise.resolve().then(()=>{S.freeze();window.seek(0);});
