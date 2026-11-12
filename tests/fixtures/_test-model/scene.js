import { layoutFromURL } from './runtime/layout.js';
import { createStage3D, THREE } from './runtime/stage3d.js';
import { bevelBox, lathe, tube, part, repeat, decal, wearCanvas, mergeByMaterial, modelStats } from './runtime/model3d.js';
const L=layoutFromURL(),S=createStage3D({canvas:document.querySelector('#stage'),width:L.width,height:L.height,clear:[.055,.065,.08,1],shadows:true,toneMapping:THREE.ACESFilmicToneMapping});
const dark=new THREE.MeshStandardMaterial({color:0x20242b,metalness:.35,roughness:.4}),silver=new THREE.MeshStandardMaterial({color:0xb0b8c1,metalness:.8,roughness:.27}),rubber=new THREE.MeshStandardMaterial({color:0x141618,roughness:.85}),glass=new THREE.MeshPhysicalMaterial({color:0x19334c,metalness:.4,roughness:.08,clearcoat:1});
S.scene.add(new THREE.HemisphereLight(0xc5ddff,0x51453b,2));const sun=new THREE.DirectionalLight(0xffead3,5);sun.position.set(-3,5,4);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-4,right:4,top:4,bottom:-4,near:.1,far:20});sun.shadow.normalBias=.015;S.scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:0x606770,roughness:.7}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;S.scene.add(floor);
const lids=[];
function camera(x,detail){
 const body=new THREE.Group();body.position.set(x,.64,0);S.scene.add(body);
 const box=(w,h,d,r)=>detail?bevelBox(w,h,d,{radius:r,segments:3}):new THREE.BoxGeometry(w,h,d);
 body.add(part('body',box(1.5,.9,.5,.08),dark),part('top',box(1.48,.1,.49,.03),silver,{at:[0,.42,0]}),part('grip',box(.24,.82,.58,.06),rubber,{at:[.63,-.01,.04]}));
 // 六层旋转体镜筒与玻璃，米制 UV；细节版增加凸起的对焦环。
 for(let i=0;i<6;i++){
  const r=.31-(i===5?.05:0),d=.08;
  const g=detail?lathe([[r-.04,-d/2],[r,-d/2],[r,d/2],[r-.04,d/2]],{segments:48}):new THREE.CylinderGeometry(r,r,d,24);
  const p=part(`lens${i}`,g,i===5?glass:i%2?rubber:silver,{at:[-.15,0,.3+i*.075],rot:[Math.PI/2,0,0]});body.add(p);
 }
 const dial=part('dial',detail?lathe([[0,0],[.115,0],[.115,.08],[0,.08]],{segments:32}):new THREE.CylinderGeometry(.115,.115,.08,16),silver,{at:[.47,.5,0]});body.add(dial);
 if(detail){
  const bolt=part('screw',lathe([[0,0],[.021,0],[.021,.012],[0,.012]],{segments:12}),silver);
  body.add(repeat(bolt,8,(o,i)=>{o.position.set(i%4*.38-.57,Math.floor(i/4)*.6-.3,.26);o.rotation.x=Math.PI/2;}));
  const cable=tube([[-.63,.1,.1],[-.84,.25,.1],[-.88,.65,.12],[-.61,.67,.12]],.025);body.add(part('strap',cable,rubber));
  body.add(repeat(part('focus-ridge',box(.018,.035,.08,.004),rubber),24,(o,i)=>{const a=i/24*Math.PI*2;o.position.set(-.15+.316*Math.cos(a),.316*Math.sin(a),.5);o.rotation.z=a-Math.PI/2;}));
  const cn=document.createElement('canvas');cn.width=128;cn.height=32;const c=cn.getContext('2d');c.fillStyle='#ded8ca';c.fillRect(0,0,128,32);c.fillStyle='#233244';for(let i=0;i<10;i++)c.fillRect(8+i*11,7,5,18);
  wearCanvas(cn,{seed:3,scratches:8,spots:30,amount:.5});const label=decal(cn,{width:.32,height:.08});label.position.set(.32,.22,.257);body.add(label);
 }
 const lid=part('screen',box(.7,.48,.035,.016),dark,{at:[0,-.02,-.28],pivot:[-.35,-.02,-.28],movable:true});body.add(lid);lids.push(lid);
 return body;
}
const A=camera(-1.2,false),B=camera(1.2,true);window.modelBench={before:modelStats(B)};
// 可动部件保留；加载期合批后以相同外部变换替换原组。
if(new URLSearchParams(location.search).get('merge')!=='off'){
 const batch=mergeByMaterial(B);batch.position.copy(B.position);S.scene.remove(B);S.scene.add(batch);lids[1]=batch.children.find(o=>o.name==='screen');window.modelBench.after=modelStats(batch);
}else window.modelBench.after=modelStats(B);
window.DURATION=1;window.__finish=()=>S.finish();
window.seek=t=>S.frame(t,()=>{for(const lid of lids)lid.rotation.y=-.7*t;S.camera.fov=39;S.camera.position.set(Math.sin(t*.5)*.8,2.1,6);S.camera.lookAt(0,.65,.1);});
window.ready=Promise.resolve().then(()=>{S.freeze();window.seek(0);});
