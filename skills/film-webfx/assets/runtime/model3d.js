// 加载期的硬表面建模工具。几何单位与 UV 单位均为米；场景动画仍由 t 求值。
import * as THREE from './three-film.module.js';
import { seeded } from './rand.js';
const vec = p => new THREE.Vector3(...p);
function positive(x,name){if(!Number.isFinite(x)||x<=0)throw new Error(`model3d: ${name} 要 > 0`);return x;}
function points(p,n,name){if(!Array.isArray(p)||p.length<n||p.some(v=>!Array.isArray(v)||v.some(x=>!Number.isFinite(x))))throw new Error(`model3d: ${name} 点列无效`);return p;}
function finish(g){g.computeBoundingBox();g.computeBoundingSphere();return g;}

/** 圆角盒；radius 显式以米给出，segments 为每个圆角区间的细分数。 */
export function bevelBox(width,height,depth,{radius,segments=1}={}){
 const size=[positive(width,'width'),positive(height,'height'),positive(depth,'depth')];
 if(!Number.isFinite(radius)||radius<0||radius>Math.min(...size)/2)throw new Error('model3d: radius 要在 [0,最小边/2]');
 if(!Number.isInteger(segments)||segments<1)throw new Error('model3d: segments 要为正整数');
 if(radius===0){const g=new THREE.BoxGeometry(...size);return metricBoxUV(g,size);}
 const pos=[],norm=[],uv=[],idx=[];
 const axes=[[0,1,2,1],[0,2,1,-1],[1,2,0,1],[1,0,2,-1],[2,0,1,1],[2,1,0,-1]];
 for(const [axis,u,v,sign]of axes){
  const line=d=>{const h=d/2,r=radius;const a=[];for(let k=0;k<=segments;k++)a.push(-h+r*k/segments);a.push(h-r);for(let k=1;k<=segments;k++)a.push(h-r+r*k/segments);return a;};
  const U=line(size[u]),V=line(size[v]),base=pos.length/3;
  for(const y of V)for(const x of U){
   const p=[0,0,0];p[axis]=sign*size[axis]/2;p[u]=x;p[v]=y;
   const q=p.map((c,i)=>Math.max(-size[i]/2+radius,Math.min(size[i]/2-radius,c)));
   const n=vec(p.map((c,i)=>c-q[i])).normalize();const r=q.map((c,i)=>c+radius*n.getComponent(i));
   pos.push(...r);norm.push(n.x,n.y,n.z);uv.push(x,y);
  }
  // 面的局部 u×v 朝向由 sign 决定；三个正面用了循环轴。
  for(let j=0;j<V.length-1;j++)for(let i=0;i<U.length-1;i++){
   const a=base+j*U.length+i,b=a+1,c=a+U.length,d=c+1;
   idx.push(a,b,c,b,d,c);
  }
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(norm,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);return finish(g);
}
export const roundedBox=(w,h,d,o)=>bevelBox(w,h,d,o);
function metricBoxUV(g,size){const uv=g.attributes.uv;for(let i=0;i<uv.count;i++){const f=Math.floor(i/4);const wh=f<2?[size[2],size[1]]:f<4?[size[0],size[2]]:[size[0],size[1]];uv.setXY(i,uv.getX(i)*wh[0],uv.getY(i)*wh[1]);}return finish(g);}

/** 闭合二维截面沿 sections 扫掠。sections 可为位置数组，或 {at,u,v,scale} 显式截面坐标架。 */
export function sweep(profile,sections,mapFn,{caps=true}={}){
 points(profile,3,'profile');points(sections.map(s=>Array.isArray(s)?s:s.at),2,'sections');
 const N=profile.length, K=sections.length, arc=[0],dist=[0], pos=[],uv=[],index=[];
 for(let i=1;i<=N;i++)arc.push(arc[i-1]+Math.hypot(profile[i%N][0]-profile[i-1][0],profile[i%N][1]-profile[i-1][1]));
 const center=sections.map(s=>vec(Array.isArray(s)?s:s.at));
 for(let j=1;j<K;j++)dist.push(dist[j-1]+center[j].distanceTo(center[j-1]));
 for(let j=0;j<K;j++){
  const s=sections[j],tangent=center[Math.min(K-1,j+1)].clone().sub(center[Math.max(0,j-1)]).normalize();
  if(tangent.lengthSq()===0)throw new Error('model3d.sweep: 重复的截面中心');
  const up=Math.abs(tangent.y)<0.9?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1);
  const u=s.u?vec(s.u).normalize():up.cross(tangent).normalize(),v=s.v?vec(s.v).normalize():tangent.clone().cross(u).normalize();
  const scale=s.scale??[1,1];
  for(let i=0;i<=N;i++){
   let p=center[j].clone().addScaledVector(u,profile[i%N][0]*scale[0]).addScaledVector(v,profile[i%N][1]*scale[1]);
   if(mapFn){const r=mapFn([p.x,p.y,p.z],{section:j,vertex:i%N,u:i/N,v:j/(K-1)});if(r)p=vec(r);}
   pos.push(p.x,p.y,p.z);uv.push(arc[i],dist[j]);
  }
 }
 for(let j=0;j<K-1;j++)for(let i=0;i<N;i++){const a=j*(N+1)+i,b=a+1,c=a+N+1,d=c+1;index.push(a,b,c,b,d,c);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();
 // 闭合接缝两端共享平均法线，不留高光接缝。
 const n=g.attributes.normal;for(let j=0;j<K;j++){const a=j*(N+1),b=a+N;const m=new THREE.Vector3().fromBufferAttribute(n,a).add(new THREE.Vector3().fromBufferAttribute(n,b)).normalize();n.setXYZ(a,m.x,m.y,m.z);n.setXYZ(b,m.x,m.y,m.z);}
 if(!caps)return finish(g);
 const side=g.toNonIndexed(), capPos=[],capUV=[];
 const tris=THREE.ShapeUtils.triangulateShape(profile.map(p=>new THREE.Vector2(...p)),[]);
 for(const end of [0,K-1])for(const tri of tris){for(const i of(end===0?[tri[2],tri[1],tri[0]]:tri)){capPos.push(...pos.slice((end*(N+1)+i)*3,(end*(N+1)+i)*3+3));capUV.push(...profile[i]);}}
 const cap=new THREE.BufferGeometry();cap.setAttribute('position',new THREE.Float32BufferAttribute(capPos,3));cap.setAttribute('uv',new THREE.Float32BufferAttribute(capUV,2));cap.computeVertexNormals();return mergeGeometries([side,cap]);
}

/** profile=[半径,高度]；UV.x=圆周弧长，UV.y=剖面弧长。 */
export function lathe(profile,{segments=32,arc=Math.PI*2,mapFn}={}){
 points(profile,2,'profile');if(profile.some(p=>p[0]<0))throw new Error('model3d.lathe: 半径要 ≥ 0');
 positive(arc,'arc');const g=new THREE.LatheGeometry(profile.map(p=>new THREE.Vector2(...p)),segments,0,arc);
 const dist=[0];for(let j=1;j<profile.length;j++)dist.push(dist[j-1]+Math.hypot(profile[j][0]-profile[j-1][0],profile[j][1]-profile[j-1][1]));
 const p=g.attributes.position,u=g.attributes.uv;
 for(let i=0;i<p.count;i++){const j=i%profile.length;u.setXY(i,u.getX(i)*arc*profile[j][0],dist[j]);if(mapFn){const r=mapFn([p.getX(i),p.getY(i),p.getZ(i)],i);p.setXYZ(i,...r);}}
 if(mapFn)g.computeVertexNormals();g.normalizeNormals();return finish(g);
}

/** 简单多边形挤出；bevel 为米制倒角半径，smooth 决定侧面是否平滑。 */
export function extrude(shape,depth,{bevel=0,segments=1,smooth=false}={}){
 points(shape,3,'shape');positive(depth,'depth');if(!Number.isFinite(bevel)||bevel<0||2*bevel>=depth)throw new Error('model3d.extrude: bevel 要 ≥ 0 且小于 depth/2');
 const s=new THREE.Shape(shape.map(p=>new THREE.Vector2(...p)));
 const g=new THREE.ExtrudeGeometry(s,{depth:depth-2*bevel,steps:1,bevelEnabled:bevel>0,bevelSize:bevel,bevelThickness:bevel,bevelSegments:segments,curveSegments:1});
 g.translate(0,0,bevel);if(smooth){const normals=new Map(),p=g.attributes.position,n=g.attributes.normal;for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>x.toFixed(6)).join(',');if(!normals.has(key))normals.set(key,new THREE.Vector3());normals.get(key).add(new THREE.Vector3().fromBufferAttribute(n,i));}for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>x.toFixed(6)).join(',');const v=normals.get(key).normalize();n.setXYZ(i,v.x,v.y,v.z);}}
 return finish(g);
}

export function tube(path,radius,{segments=64,radialSegments=8,closed=false}={}){
 points(path,2,'path');positive(radius,'radius');const curve=new THREE.CatmullRomCurve3(path.map(vec),closed,'centripetal');
 const g=new THREE.TubeGeometry(curve,segments,radius,radialSegments,closed),uv=g.attributes.uv,L=curve.getLength();
 for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*L,uv.getY(i)*2*Math.PI*radius);return finish(g);
}
export const ring=(radius,thickness,{segments=48,radialSegments=8}={})=>{
 positive(radius,'radius');positive(thickness,'thickness');const g=new THREE.TorusGeometry(radius,thickness,radialSegments,segments),uv=g.attributes.uv;
 for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*2*Math.PI*radius,uv.getY(i)*2*Math.PI*thickness);return finish(g);
};
export const plate=(shape,thickness,opts)=>extrude(shape,thickness,opts);

/** pivot 以父坐标系给出；mesh 在子层补偿，使 at 是静止姿态下几何中心位置。 */
export function part(name,geometry,material,{at=[0,0,0],rot=[0,0,0],pivot=at,movable=false}={}){
 const root=new THREE.Group();root.name=name;root.position.set(...pivot);root.rotation.set(...rot);root.userData.modelMovable=movable;
 const mesh=new THREE.Mesh(geometry,material);mesh.name=`${name}.mesh`;mesh.position.copy(vec(at).sub(vec(pivot)));mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);return root;
}

export function repeat(object,count,transform){if(!Number.isInteger(count)||count<1)throw new Error('model3d.repeat: count 要为正整数');const g=new THREE.Group();for(let i=0;i<count;i++){const c=object.clone(true);transform(c,i,count);g.add(c);}return g;}
export function mirror(object,axis='x'){if(!['x','y','z'].includes(axis))throw new Error('model3d.mirror: axis 要 x/y/z');const c=object.clone(true);c.scale[axis]*=-1;return c;}
export function alongPath(object,path,count){const c=new THREE.CatmullRomCurve3(points(path,2,'path').map(vec));return repeat(object,count,(o,i)=>{const t=count===1?0:i/(count-1);o.position.copy(c.getPointAt(t));o.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),c.getTangentAt(t));});}
export function boltCircle(object,count,radius){return repeat(object,count,(o,i)=>{const a=2*Math.PI*i/count;o.position.set(radius*Math.cos(a),0,radius*Math.sin(a));o.rotation.y=-a;});}

/** 合并到非索引几何；缺失 color 用白色，缺失 UV 用零。保留 position/normal/uv/color。 */
export function mergeGeometries(geometries){
 const fields={position:3,normal:3,uv:2,color:geometries.some(g=>g.attributes.color?.itemSize===4)?4:3},out=Object.fromEntries(Object.keys(fields).map(k=>[k,[]]));
 for(let g of geometries){g=g.index?g.toNonIndexed():g.clone();if(!g.attributes.normal)g.computeVertexNormals();for(let i=0;i<g.attributes.position.count;i++)for(const[k,n]of Object.entries(fields)){const a=g.attributes[k];for(let c=0;c<n;c++)out[k].push(a&&c<a.itemSize?a.getComponent(i,c):k==='color'?1:0);}}
 const g=new THREE.BufferGeometry();for(const[k,n]of Object.entries(fields))g.setAttribute(k,new THREE.Float32BufferAttribute(out[k],n));return finish(g);
}

/** 返回新 Group；静态部件按 material identity 合并，可动子树保留层级与枢轴。 */
export function mergeByMaterial(root){
 root.updateMatrixWorld(true);const result=new THREE.Group(),inverse=root.matrixWorld.clone().invert(),buckets=new Map();
 function visit(o){
  if(o!==root&&o.userData.modelMovable){const c=o.clone(true),m=inverse.clone().multiply(o.matrixWorld);m.decompose(c.position,c.quaternion,c.scale);result.add(c);return;}
  if(!o.visible)return;
  if(o.isMesh){
   if(o.isSkinnedMesh||o.isInstancedMesh||o.geometry.morphAttributes.position)throw new Error('model3d.mergeByMaterial: 蒙皮/实例/形变应保留为可动部件');
   const matrix=inverse.clone().multiply(o.matrixWorld);let source=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone();source.applyMatrix4(matrix);
   if(matrix.determinant()<0)for(const a of Object.values(source.attributes))for(let i=0;i<a.count;i+=3)for(let c=0;c<a.itemSize;c++){const k=(i+1)*a.itemSize+c,l=(i+2)*a.itemSize+c,t=a.array[k];a.array[k]=a.array[l];a.array[l]=t;}
   const groups=Array.isArray(o.material)?source.groups:[{start:0,count:source.attributes.position.count,materialIndex:0}];
   for(const group of groups){const m=Array.isArray(o.material)?o.material[group.materialIndex]:o.material;if(!m)continue;const g=new THREE.BufferGeometry();for(const[k,a]of Object.entries(source.attributes)){if(!['position','normal','uv','color'].includes(k))continue;g.setAttribute(k,new THREE.BufferAttribute(a.array.slice(group.start*a.itemSize,(group.start+group.count)*a.itemSize),a.itemSize,a.normalized));}if(!buckets.has(m))buckets.set(m,new Map());const key=[o.castShadow,o.receiveShadow,o.layers.mask,o.renderOrder].join(':');const byFlags=buckets.get(m);if(!byFlags.has(key))byFlags.set(key,{geos:[],cast:o.castShadow,receive:o.receiveShadow,layers:o.layers.mask,order:o.renderOrder});byFlags.get(key).geos.push(g);}
  }
  for(const child of o.children)visit(child);
 }
 visit(root);for(const[m,byFlags]of buckets)for(const f of byFlags.values()){const mesh=new THREE.Mesh(mergeGeometries(f.geos),m);mesh.name='model3d.batch';mesh.castShadow=f.cast;mesh.receiveShadow=f.receive;mesh.layers.mask=f.layers;mesh.renderOrder=f.order;result.add(mesh);}return result;
}
export function modelStats(root){let meshes=0,vertices=0,triangles=0;root.traverse(o=>{if(!o.isMesh)return;meshes++;vertices+=o.geometry.attributes.position.count;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});return{meshes,vertices,triangles};}

/** 给调用方已经加载字体的 canvas 做种子化磨损；不读取字体或时钟。 */
export function wearCanvas(canvas,{seed,scratches,spots,amount}){
 const r=seeded(seed),ctx=canvas.getContext('2d');ctx.save();ctx.globalCompositeOperation='destination-out';ctx.globalAlpha=amount;
 for(let i=0;i<scratches;i++){ctx.beginPath();const x=r()*canvas.width,y=r()*canvas.height;ctx.moveTo(x,y);ctx.lineTo(x+(r()-.5)*canvas.width*.3,y+(r()-.5)*canvas.height*.1);ctx.lineWidth=.3+r()*2;ctx.stroke();}
 for(let i=0;i<spots;i++){ctx.beginPath();ctx.arc(r()*canvas.width,r()*canvas.height,.3+r()*canvas.width*.015,0,Math.PI*2);ctx.fill();}ctx.restore();return canvas;
}
export function stencilText(ctx,text,x,y,{gap}){ctx.fillText(text,x,y);const w=ctx.measureText(text).width;ctx.save();ctx.globalCompositeOperation='destination-out';ctx.fillRect(x,y-2,gap,4);for(let a=x+gap*8;a<x+w;a+=gap*8)ctx.fillRect(a,y-ctx.measureText(text).actualBoundingBoxAscent,gap,ctx.measureText(text).actualBoundingBoxAscent+2);ctx.restore();}
export function decal(canvas,{width,height,offset=0.001}){
 const tx=new THREE.CanvasTexture(canvas);tx.colorSpace=THREE.SRGBColorSpace;
 const mat=new THREE.MeshStandardMaterial({map:tx,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,roughness:1});
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(positive(width,'width'),positive(height,'height')),mat);mesh.position.z=offset;return mesh;
}
