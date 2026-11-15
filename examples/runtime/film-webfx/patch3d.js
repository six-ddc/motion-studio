// patch3d.js —— 给 three 的内置材质叠着色器补丁的唯一一套做法（sky3d / surface3d / ground3d 共用）。
//
// 同一材质可以叠多个补丁（雾 + PCSS + 前景 + 表面 + 地面……）：
//   - addPatch 把补丁按调用顺序挂在一张表上，材质只有一个 onBeforeCompile，依次调用；原有回调（片子自己写的）最先跑。
//   - customProgramCacheKey 由各补丁的 key 拼成：不同组合不会串程序。
//   - 同一种（key 冒号前的部分）补丁在一个材质上只能打一次。
//   - inject 的 'replace' 模式在替换处留一个标记，之后别的补丁仍能 'after' 插到同一个位置：
//     先替换后插入、先插入后替换，得到的代码顺序相同（替换的代码在前，插入的在后）。
//
//   import { addPatch, inject, WORLD_POS } from './runtime/patch3d.js';
//   addPatch(mat, 'mything', (shader) => { shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', 'after', code, 'mything'); });

import * as THREE from './three-film.module.js';

const PATCHES = new WeakMap();

/**
 * 给材质挂一个补丁。key 形如 'kind:结构参数'：kind 判重，整个 key 进程序缓存键。
 * fn(shader, renderer) 在编译前被调用，只做字符串注入与 uniform 挂接。
 */
export function addPatch(mat, key, fn) {
  if (!mat || !mat.isMaterial) throw new Error(`patch3d: ${key} 要一个 three 材质`);
  let list = PATCHES.get(mat);
  if (!list) {
    list = [];
    PATCHES.set(mat, list);
    const prev = mat.onBeforeCompile, hadPrev = prev !== THREE.Material.prototype.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey, hadKey = prevKey !== THREE.Material.prototype.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, renderer) { if (hadPrev) prev.call(this, shader, renderer); for (const p of list) p.fn(shader, renderer); };
    mat.customProgramCacheKey = function () { return (hadKey ? prevKey.call(this) : '') + '|fx:' + list.map((p) => p.key).join(','); };
  }
  const kind = key.split(':')[0];
  if (list.some((p) => p.key.split(':')[0] === kind)) throw new Error(`patch3d: 材质「${mat.name || mat.type}」已经打过 ${kind} 补丁（要换组合就 new 一个材质）`);
  list.push({ key, fn });
  mat.needsUpdate = true;
}

/** 材质上已经挂了哪些补丁（按顺序的 key 列表） */
export const patchesOf = (mat) => (PATCHES.get(mat) ?? []).map((p) => p.key);

// 标记里不能含 token 原文（否则计数时会把标记也当成 token）
const mark = (token) => `// fx-patch-anchor[${token.replace(/[#<>\s]/g, '')}]`;

/**
 * 在 three 着色器源码的 token 处注入。mode：'after' | 'before' | 'replace'。
 * token 必须恰好出现一次（或之前被 'replace' 留下的标记恰好一次），否则抛错点名 who——three 升级改了 chunk 时不静默套用。
 */
export function inject(src, token, mode, code, who) {
  const m = mark(token);
  const nTok = src.split(token).length - 1, nMark = src.split(m).length - 1;
  if (nTok + nMark !== 1) throw new Error(`${who}: 着色器里找不到恰好一处 ${token}（找到 ${nTok + nMark} 处）。这种材质不支持，或 three 的 chunk 变了，注入点要跟着改`);
  const at = nTok ? token : m;
  if (mode === 'after') return src.replace(at, () => `${at}\n${code}`);
  if (mode === 'before') return src.replace(at, () => `${code}\n${at}`);
  if (mode === 'replace') {
    if (!nTok) throw new Error(`${who}: ${token} 已被别的补丁替换过，两个补丁不能都替换同一个 chunk`);
    return src.replace(at, () => `${code}\n${m}`);
  }
  throw new Error(`patch3d.inject: mode 只能是 after / before / replace`);
}

/**
 * 顶点着色器里（project_vertex 之后）取世界坐标的代码块：处理 BatchedMesh 与 InstancedMesh。
 * out 是已声明的 vec3 变量名，local 是物体空间 vec3 表达式（通常 'transformed'）。
 */
export const WORLD_POS = (out, local = 'transformed') => `{
  vec4 fxWp = vec4(${local}, 1.0);
  #ifdef USE_BATCHING
    fxWp = batchingMatrix * fxWp;
  #endif
  #ifdef USE_INSTANCING
    fxWp = instanceMatrix * fxWp;
  #endif
  ${out} = (modelMatrix * fxWp).xyz;
}`;

/**
 * 物体空间法线 → 视空间的 mat3（含批次/实例矩阵与非均匀缩放的逆转置近似，与 three 的 defaultnormal_vertex 同一做法）。
 * out 是已声明的 mat3 变量名。
 */
export const NORMAL_MAT = (out) => `{
  mat3 fxNm = normalMatrix;
  #ifdef USE_INSTANCING
    mat3 fxIm = mat3(instanceMatrix);
    fxNm = fxNm * fxIm * mat3(1.0 / dot(fxIm[0], fxIm[0]), 0.0, 0.0, 0.0, 1.0 / dot(fxIm[1], fxIm[1]), 0.0, 0.0, 0.0, 1.0 / dot(fxIm[2], fxIm[2]));
  #endif
  #ifdef USE_BATCHING
    mat3 fxBm = mat3(batchingMatrix);
    fxNm = fxNm * fxBm * mat3(1.0 / dot(fxBm[0], fxBm[0]), 0.0, 0.0, 0.0, 1.0 / dot(fxBm[1], fxBm[1]), 0.0, 0.0, 0.0, 1.0 / dot(fxBm[2], fxBm[2]));
  #endif
  #ifdef FLIP_SIDED
    fxNm = -fxNm;
  #endif
  ${out} = fxNm;
}`;
