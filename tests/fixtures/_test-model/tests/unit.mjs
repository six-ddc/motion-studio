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
console.log(`✓ model3d ${checks} 条数值断言；基元顶点 ${shapes.map(g=>g.attributes.position.count).join('/')}；合批 3→2 mesh，三角形守恒`);
