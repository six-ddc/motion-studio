import assert from 'node:assert/strict';
import { importRuntime } from '../../../../skills/film-core/lib/runtime-node.mjs';
const M=await importRuntime('model3d.js'),T=await importRuntime('three-film.module.js');
let checks=0;function ok(v){assert.ok(v);checks++;}
const shapes=[M.bevelBox(2,1,0.6,{radius:0.08,segments:3}),M.lathe([[0,0],[.3,0],[.3,1],[0,1]],{segments:24}),M.extrude([[0,0],[1,0],[1,1],[0,1]],.2),M.sweep([[-.2,-.1],[.2,-.1],[.2,.1],[-.2,.1]],[[0,0,0],[0,0,1]]),M.tube([[0,0,0],[.5,.4,0],[1,0,0]],.03),M.ring(.3,.02)];
for(const g of shapes){for(const a of Object.values(g.attributes))for(const x of a.array)ok(Number.isFinite(x));const n=g.attributes.normal;for(let i=0;i<n.count;i++)ok(Math.abs(Math.hypot(n.getX(i),n.getY(i),n.getZ(i))-1)<1e-5);}
const box=shapes[0].boundingBox.getSize(new T.Vector3());ok(Math.abs(box.x-2)<1e-6&&Math.abs(box.y-1)<1e-6&&Math.abs(box.z-.6)<1e-6);
// 几何绕向须与显式法线同向；倒角会影响高光，倒面会直接丢面。
for(const g0 of shapes){const g=g0.index?g0.toNonIndexed():g0,p=g.attributes.position,n=g.attributes.normal;for(let i=0;i<p.count;i+=3){const a=new T.Vector3().fromBufferAttribute(p,i),b=new T.Vector3().fromBufferAttribute(p,i+1),c=new T.Vector3().fromBufferAttribute(p,i+2),cross=b.sub(a).cross(c.sub(a));if(cross.lengthSq()>1e-14)ok(cross.dot(new T.Vector3().fromBufferAttribute(n,i))>=-1e-7);}}
const mat=new T.MeshStandardMaterial();const group=new T.Group();group.add(M.part('a',shapes[0],mat),M.part('b',shapes[1],mat,{at:[2,0,0]}),M.part('moving',shapes[2],mat,{movable:true}));
const merged=M.mergeByMaterial(group);ok(M.modelStats(group).triangles===M.modelStats(merged).triangles);ok(M.modelStats(merged).meshes===2);ok(merged.children.some(o=>o.name==='moving'));
assert.throws(()=>M.bevelBox(1,1,1,{}));assert.throws(()=>M.sweep([[0,0],[1,0],[0,1]],[[0,0,0],[0,0,0]]));checks+=2;
const reflected=new T.Group(),one=M.part('reflected',shapes[0],mat);one.scale.x=-1;one.children[0].castShadow=false;reflected.add(one);const batch=M.mergeByMaterial(reflected);ok(!batch.children[0].castShadow);const rp=batch.children[0].geometry.attributes.position,rn=batch.children[0].geometry.attributes.normal;
for(let i=0;i<rp.count;i+=3){const a=new T.Vector3().fromBufferAttribute(rp,i),b=new T.Vector3().fromBufferAttribute(rp,i+1),c=new T.Vector3().fromBufferAttribute(rp,i+2);ok(b.sub(a).cross(c.sub(a)).dot(new T.Vector3().fromBufferAttribute(rn,i))>=-1e-7);}
// 扫掠：截面顺/逆时针、坐标架左/右手，侧面与封口都朝外（几何法线指向远离截面中心 / 远离相邻截面）
const sq=[[-.2,-.1],[.2,-.1],[.2,.1],[-.2,.1]];
for(const prof of [sq,sq.slice().reverse()])for(const frame of [null,{u:[1,0,0],v:[0,-1,0]}]){
 const secs=[[0,0,0],[0,0,1]].map(at=>frame?{at,...frame}:at),g=M.sweep(prof,secs),p=g.attributes.position,n=g.attributes.normal;
 for(let i=0;i<p.count;i+=3){const a=new T.Vector3().fromBufferAttribute(p,i),b=new T.Vector3().fromBufferAttribute(p,i+1),c=new T.Vector3().fromBufferAttribute(p,i+2),m=a.clone().add(b).add(c).divideScalar(3);
  const f=b.clone().sub(a).cross(c.clone().sub(a));const cap=Math.abs(a.z-b.z)<1e-9&&Math.abs(a.z-c.z)<1e-9;
  const out=cap?new T.Vector3(0,0,a.z<.5?-1:1):new T.Vector3(m.x,m.y,0);ok(f.dot(out)>0);ok(new T.Vector3().fromBufferAttribute(n,i).dot(out)>0);}}
// 挤出 smooth：只平滑侧面，封口法线仍是 ±Z
{const e=M.extrude([[0,0],[1,0],[1,1],[0,1]],.4,{smooth:true}),n=e.attributes.normal;for(const gr of e.groups.filter(g=>g.materialIndex===0))for(let i=gr.start;i<gr.start+gr.count;i++)ok(Math.abs(Math.abs(n.getZ(i))-1)<1e-6);}
// 零件投影开关可关；贴花粗糙度必填
{const q=M.part('x',shapes[0],mat,{castShadow:false,receiveShadow:false});ok(!q.children[0].castShadow&&!q.children[0].receiveShadow);}
assert.throws(()=>M.decal({width:4,height:4,getContext(){return null}},{width:1,height:1}),/roughness/);checks++;
console.log(`✓ model3d ${checks} 条数值断言；基元顶点 ${shapes.map(g=>g.attributes.position.count).join('/')}；合批 3→2 mesh，三角形守恒`);
