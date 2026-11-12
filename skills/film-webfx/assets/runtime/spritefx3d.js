// 实例四边形火花/烟/火焰。显式事件表与闭式阻力弹道，任何时刻直接求值。
import * as THREE from './three-film.module.js';
import { hash01 } from './rand.js';
import { tileNoise } from './texture3d.js';
const sat=x=>Math.max(0,Math.min(1,x));
function vector(v,name) { if(!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x)))throw new Error(`spritefx3d: ${name} 要三元有限数组`); }

/** 阻力 v' = gravity - drag*v 的解析积分；drag=0 为抛物线。 */
export function particleState(age, { origin, velocity, gravity, drag }) {
  vector(origin,'origin');vector(velocity,'velocity');vector(gravity,'gravity');
  if(!Number.isFinite(age)||!Number.isFinite(drag)||drag<0)throw new Error('spritefx3d: age 有限、drag≥0');
  const a=Math.max(0,age), e=Math.exp(-drag*a), f=drag>1e-7?-Math.expm1(-drag*a)/drag:a;
  const q=drag>1e-7?(a-f)/drag:a*a*.5;
  return { position:origin.map((p,k)=>p+velocity[k]*f+gravity[k]*q), velocity:velocity.map((v,k)=>v*e+gravity[k]*f) };
}

/** 加载期烟图集。RGBA 编码 xy 法线、厚度、alpha；格子带透明边防 mip 串格。
 * 每帧同一团噪声逐步侵蚀，不靠跨帧仿真。可同时给受光烟与 alpha 火焰使用。
 */
export function bakeSmokeAtlas({ cellSize, columns, seed, erosion, lobes }) {
  if(!Number.isInteger(cellSize)||cellSize<8||!Number.isInteger(columns)||columns<1||columns>16||cellSize*columns>4096||!Number.isInteger(seed)||!Number.isInteger(lobes)||lobes<1||lobes>32||!Number.isFinite(erosion)||erosion<0)throw new Error('spritefx3d: 图集参数无效');
  const size=cellSize*columns, data=new Uint8Array(size*size*4), frames=columns*columns;
  const centers=Array.from({length:lobes},(_,i)=>[(hash01(seed,i,1)-.5)*.9,(hash01(seed,i,2)-.5)*.9,.25+hash01(seed,i,3)*.45]);
  const density=(x,y,f)=>{
    let d=0;for(const [cx,cy,r]of centers)d+=Math.exp(-((x-cx)**2+(y-cy)**2)/(r*r)*2);
    const n=tileNoise((x+2)*3,(y+2)*3,64,seed+7);
    return sat((d*.55-(1-n)*.5-f*erosion)*2)*sat((.94-Math.hypot(x,y))/.2);
  };
  for(let f=0;f<frames;f++)for(let y=0;y<cellSize;y++)for(let x=0;x<cellSize;x++){
    const px=(x+.5)/cellSize*2-1,py=(y+.5)/cellSize*2-1,age=frames>1?f/(frames-1):0,eps=2/cellSize;
    const h=density(px,py,age),dx=(density(px+eps,py,age)-density(px-eps,py,age))*.8,dy=(density(px,py+eps,age)-density(px,py-eps,age))*.8;
    const i=(((Math.floor(f/columns)*cellSize+y)*size)+(f%columns)*cellSize+x)*4;
    const len=Math.hypot(dx,dy,1);data[i]=Math.round((.5-dx/len*.5)*255);data[i+1]=Math.round((.5-dy/len*.5)*255);data[i+2]=Math.round(h*255);data[i+3]=Math.round(h*255);
  }
  const texture=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);
  texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
  return {texture,data,size,columns,frames,dispose(){texture.dispose();}};
}

/** events: [{t,life,origin,velocity,size,seed}]；加载期固定容量，不 add/remove。
 * mode:'spark'|'smoke'|'flame'；colors=[热/初,冷/末]，线性 HDR；blend 必须显式。
 * softDepth 可接同一相机当前帧的深度 RT：{texture,width,height,near,far,distance}。
 */
export function createSpriteFX(S,{events,mode,gravity,drag,colors,opacity,stretch,minPixels,maxPixels,blending,atlas,light,softDepth=null}){
  if(!Array.isArray(events)||!events.length||!['spark','smoke','flame'].includes(mode))throw new Error('spritefx3d: events 和 mode 必填');
  vector(gravity,'gravity');if(!Array.isArray(colors)||colors.length!==2)throw new Error('spritefx3d: colors 两个线性 RGB');colors.forEach(c=>vector(c,'color'));
  for(const[n,v]of Object.entries({drag,opacity,stretch,minPixels,maxPixels}))if(!Number.isFinite(v)||v<0)throw new Error(`spritefx3d: ${n} 必填且≥0`);
  if(maxPixels<minPixels||maxPixels===0||!['add','normal'].includes(blending))throw new Error('spritefx3d: 像素范围/blending 无效');
  if(mode!=='spark'&&!atlas?.texture)throw new Error('spritefx3d: 烟/火需要 bakeSmokeAtlas');
  if(mode==='smoke'){vector(light?.direction,'light.direction');vector(light?.color,'light.color');vector(light?.ambient,'light.ambient');if(Math.hypot(...light.direction)===0)throw new Error('spritefx3d: light.direction 不能为零向量');for(const k of ['wrap','backscatter'])if(!Number.isFinite(light[k])||light[k]<0)throw new Error(`spritefx3d: light.${k} 无效`);}
  if(softDepth){for(const k of ['width','height','near','far','distance'])if(!(Number.isFinite(softDepth[k])&&softDepth[k]>0))throw new Error(`spritefx3d: softDepth.${k}>0 且有限`);if(softDepth.far<=softDepth.near||!softDepth.texture)throw new Error('spritefx3d: softDepth 无效');}
  const count=events.length,geo=new THREE.InstancedBufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));geo.setIndex([0,1,2,0,2,3]);
  const p=new Float32Array(count*3),v=p.slice(),meta=new Float32Array(count*4);
  events.forEach((e,i)=>{
    vector(e.origin,'event.origin');vector(e.velocity,'event.velocity');
    if(!Number.isFinite(e.t)||!Number.isFinite(e.life)||!(e.life>0)||!Number.isFinite(e.size)||!(e.size>0)||!Number.isInteger(e.seed))throw new Error('spritefx3d: event 要有限 t/life/size 与整数 seed');
    p.set(e.origin,i*3);v.set(e.velocity,i*3);meta.set([e.t,e.life,e.size,hash01(e.seed,i)],i*4);
  });
  geo.setAttribute('aOrigin',new THREE.InstancedBufferAttribute(p,3));geo.setAttribute('aVelocity',new THREE.InstancedBufferAttribute(v,3));geo.setAttribute('aMeta',new THREE.InstancedBufferAttribute(meta,4));geo.instanceCount=count;
  const uniforms={uTime:{value:0},uFocal:{value:1},uGravity:{value:new THREE.Vector3(...gravity)},uDrag:{value:drag},uCold:{value:new THREE.Color(...colors[1])},uHot:{value:new THREE.Color(...colors[0])},uOpacity:{value:opacity},uStretch:{value:stretch},uPx:{value:new THREE.Vector2(minPixels,maxPixels)},uAtlas:{value:atlas?.texture??null},uColumns:{value:atlas?.columns??1},uFrames:{value:atlas?.frames??1},uLight:{value:new THREE.Vector3(...(light?.direction??[0,1,0])).normalize()},uLightColor:{value:new THREE.Color(...(light?.color??[0,0,0]))},uAmbient:{value:new THREE.Color(...(light?.ambient??[0,0,0]))},uWrap:{value:light?.wrap??0},uBack:{value:light?.backscatter??0}};
  if(softDepth)Object.assign(uniforms,{uDepth:{value:softDepth.texture},uDepthSize:{value:new THREE.Vector2(softDepth.width,softDepth.height)},uNearFar:{value:new THREE.Vector2(softDepth.near,softDepth.far)},uSoft:{value:softDepth.distance},uSoftEnabled:{value:1}});
  const material=new THREE.ShaderMaterial({uniforms,defines:{FX_MODE:{spark:0,smoke:1,flame:2}[mode],...(softDepth?{FX_SOFT:1}:{})},transparent:true,depthWrite:false,depthTest:true,premultipliedAlpha:true,blending:blending==='add'?THREE.AdditiveBlending:THREE.NormalBlending,side:THREE.DoubleSide,
    vertexShader:`
attribute vec3 aOrigin,aVelocity;attribute vec4 aMeta;
uniform float uTime,uFocal,uDrag,uStretch;uniform vec3 uGravity;uniform vec2 uPx;
varying vec2 vUv;varying float vAge,vAlpha,vDepth;varying mat3 vCamera;
void main(){
float age=uTime-aMeta.x;float a=max(age,0.);float e=exp(-uDrag*a);
// 小 drag*age 下用级数，避免 float32 的 (1-exp(-x)) 与 (age-f) 相消把重力项放大。
float x=uDrag*a;float x2=x*x;float f,q;
if(x<.05){f=a*(1.-x*.5+x2/6.-x*x2/24.+x2*x2/120.);q=a*a*(.5-x/6.+x2/24.-x*x2/120.+x2*x2/720.);}
else{f=(1.-e)/uDrag;q=(a-f)/uDrag;}
vec3 pos=aOrigin+aVelocity*f+uGravity*q;vec3 vel=aVelocity*e+uGravity*f;
vec4 mv=modelViewMatrix*vec4(pos,1.);vDepth=-mv.z;vAge=clamp(a/aMeta.y,0.,1.);vUv=position.xy*.5+.5;
vAlpha=(age>=0.&&age<aMeta.y&&mv.z<0.)?1.:0.;
float size=aMeta.z;
#if FX_MODE != 0
size*=mix(1.,2.4,vAge);vAlpha*=smoothstep(0.,.12,vAge)*(1.-vAge);
#else
vAlpha*=1.-vAge;
#endif
float px=size*uFocal/max(-mv.z,1.e-4);float clamped=clamp(px,uPx.x,uPx.y);
float sz=clamped*max(-mv.z,1.e-4)/uFocal;
vec2 dir=vec2(1.,0.);float len=sz,rawLen=size;
#if FX_MODE == 0
// d(x/-z)/dt 包含纵深速度产生的径向投影；只用 vel.xy 会把朝镜头飞来的火花画横。
vec3 vv=(modelViewMatrix*vec4(vel,0.)).xyz;vec2 screenVelocity=vv.xy+mv.xy*vv.z/max(-mv.z,1.e-4);
if(length(screenVelocity)>1.e-5)dir=normalize(screenVelocity);rawLen=max(size,length(screenVelocity)*uStretch);
len=max(sz,min(uPx.y*max(-mv.z,1.e-4)/uFocal,rawLen));
#endif
// 最小像素尺寸扩大了几何覆盖面积，用两轴面积比补偿 alpha。
vAlpha*=min(1.,size*rawLen/max(sz*len,1.e-8));
vec2 side=vec2(-dir.y,dir.x);mv.xy+=(dir*position.x*len+side*position.y*sz)*.5;
gl_Position=projectionMatrix*mv;vCamera=mat3(cameraMatrixWorld);
}`.replace('cameraMatrixWorld','inverse(viewMatrix)'),
    fragmentShader:`
uniform vec3 uHot,uCold,uLight,uLightColor,uAmbient;uniform float uOpacity,uColumns,uFrames,uWrap,uBack;uniform sampler2D uAtlas;
varying vec2 vUv;varying float vAge,vAlpha,vDepth;varying mat3 vCamera;
#ifdef FX_SOFT
uniform sampler2D uDepth;uniform vec2 uDepthSize,uNearFar;uniform float uSoft,uSoftEnabled;
#endif
void main(){
float alpha=vAlpha*uOpacity;vec3 color=mix(uHot,uCold,vAge);
#if FX_MODE == 0
vec2 q=vUv*2.-1.;alpha*=exp(-q.y*q.y*5.)*max(0.,1.-q.x*q.x);
#else
float frame=floor(vAge*(uFrames-1.));vec2 cell=vec2(mod(frame,uColumns),floor(frame/uColumns));vec4 tex=texture2D(uAtlas,(cell+vUv)/uColumns);alpha*=tex.a;
#if FX_MODE == 1
vec2 xy=tex.rg*2.-1.;vec3 n=normalize(vCamera*vec3(xy,sqrt(max(.01,1.-dot(xy,xy)))));
float wrap=max(0.,(dot(n,normalize(uLight))+uWrap)/(1.+uWrap));float back=pow(max(0.,dot(-n,normalize(uLight))),3.)*uBack*tex.b;
color*=uAmbient+uLightColor*(wrap+back);
#else
color*=tex.b;
#endif
#endif
#ifdef FX_SOFT
if(uSoftEnabled>.5){float z=texture2D(uDepth,gl_FragCoord.xy/uDepthSize).x;float sceneDepth=uNearFar.x*uNearFar.y/(uNearFar.y-z*(uNearFar.y-uNearFar.x));alpha*=clamp((sceneDepth-vDepth)/uSoft,0.,1.);}
#endif
if(alpha<.001)discard;gl_FragColor=vec4(color,alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
// 先做输出变换再预乘。HDR RT 为线性输出，直出屏幕走对应的 tone/sRGB 变换。
gl_FragColor.rgb*=gl_FragColor.a;
}`});
  const mesh=new THREE.Mesh(geo,material);mesh.frustumCulled=false;
  const viewport=new THREE.Vector4();
  mesh.onBeforeRender=(renderer,scene,camera)=>{
    // 反射/低分辨率 RT 的像素尺度也由当前 camera 与 viewport 求值，不复用主屏尺寸。
    renderer.getCurrentViewport(viewport);uniforms.uFocal.value=viewport.w*.5*camera.projectionMatrix.elements[5];
    // 主相机深度不能投到镜像相机上；副视角需要它自己的不含粒子深度图。
    if(softDepth)uniforms.uSoftEnabled.value=camera===S.camera?1:0;
  };
  return {mesh,material,geometry:geo,update(t){if(!Number.isFinite(t))throw new Error('spritefx3d: t 必须有限');uniforms.uTime.value=t;S.camera.updateProjectionMatrix();uniforms.uFocal.value=S.height*.5*S.camera.projectionMatrix.elements[5];},dispose(){geo.dispose();material.dispose();}};
}

/** 周期雨的位置，随相机移动包围盒；world position=f(i,t)，不积分。 */
export function rainPosition(i,t,{seed,box,velocity,center}){
  vector(box,'box');vector(velocity,'velocity');vector(center,'center');if(box.some(x=>x<=0)||!Number.isFinite(t)||!Number.isInteger(i)||!Number.isInteger(seed))throw new Error('spritefx3d: 雨参数无效');
  return box.map((b,k)=>{const p=hash01(seed,i,k)*b+velocity[k]*t-center[k];return ((p%b)+b)%b-b*.5+center[k];});
}
