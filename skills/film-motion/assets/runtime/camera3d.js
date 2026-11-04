// camera3d.js —— 针孔透视相机：斜着看一个平面（棋盘、桌面、地图、地面）。
//
// 为什么要它：film-core motion.js 的 camera()/applyCamera() 只做二维平移缩放，canvas 只有仿射变换。
// "斜着看"最省事的做法是 ctx.setTransform 纵向压扁（scale(1, sin俯角)）——那是**正交投影**：
// 平行线不收拢、远边和近边一样宽，一个斜放的正方形在画面上就是一个长方形，眼睛读不出"斜放"。
// 这里给的是透视：远处缩小、平行线向消失点收拢。提炼自 films/weiqi-intro（棋盘、厚度、影子、棋子、气泡共用一个投影）。
//
// 约定（世界坐标，单位随你：格、米、像素都行）：
//   x 向右，y 朝向观众（正俯视时 = 画面向下），z 离开平面向上。平面是 z = 0（或任一 z = h）。
//   elevation：视线与平面的夹角（弧度）。π/2 = 正俯视（此时 z=0 平面上透视量**精确为 0**，退化成等比缩放）。
//   distance：相机到注视点的距离（世界单位）。越小透视越强；→∞ 退化成正交（也就是纵向压扁）。
//   S：注视点处 1 个世界单位 = S 像素。look：注视的世界点 [x, y]。screen：注视点落在画面哪个像素 [X, Y]。
//   yaw：绕 z 轴转（弧度），正值 = 画面里的世界逆时针转。
//
// 全部是参数的纯函数：同样的参数 → 同样的结果，不存任何跨帧状态。每一帧按 t 算好参数再新建一个。
// JS 的 project/unproject 与 GLSL 片段里的 cam_project/cam_unproject 是同一组公式、互为精确逆
// （实测误差见仓库 docs/verified/film-motion.md §14）。棋子、影子、厚度、文字标签都走同一个 project()，
// 着色器画的平面走 cam_unproject——只有共用一个投影，画面上的东西才"贴"在同一个面上。

export function camera3d({ S, elevation, distance, look, screen, yaw = 0 }) {
  for (const [k, v] of Object.entries({ S, elevation, distance }))
    if (!Number.isFinite(v)) throw new Error(`camera3d: ${k} 必须是有限数（拿到 ${v}）`);
  if (!look || !screen) throw new Error('camera3d: look:[x,y] 与 screen:[X,Y] 必填（注视哪个世界点、它落在画面哪里）');
  if (!(distance > 0)) throw new Error('camera3d: distance 必须 > 0');
  const sn = Math.sin(elevation), cs = Math.cos(elevation), d = distance;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const [lx, ly] = look, [px, py] = screen;

  // 世界 (x, y, z) → 屏幕 { X, Y, k, depth, behind }。k = 该点的局部放大率（注视点处 k = 1），
  // 半径、线宽、字号乘 S*k 就和平面一起缩放。behind = 点在相机后面（depth <= 0），此时 X/Y 无意义。
  function project(x, y, z = 0) {
    const dx = x - lx, dy = y - ly;
    const u = cy * dx + sy * dy, v = -sy * dx + cy * dy;
    const depth = d - v * cs - z * sn;
    const k = d / depth;
    return { X: px + S * u * k, Y: py + S * (v * sn - z * cs) * k, k, depth, behind: depth <= 0 };
  }

  // 屏幕 (X, Y) → 平面 z = h 上的世界点 { x, y }。地平线以上（视线碰不到平面）返回 null。
  function unproject(X, Y, h = 0) {
    const Xp = (X - px) / S, Yp = (Y - py) / S;
    const den = d * sn + Yp * cs;
    if (den <= 1e-12) return null;
    const v = (Yp * (d - h * sn) + h * cs * d) / den;
    const depth = d - v * cs - h * sn;
    if (depth <= 0) return null;
    const u = (Xp * depth) / d;
    return { x: lx + cy * u - sy * v, y: ly + sy * u + cy * v };
  }

  // 平面 z = 0 的地平线在画面上的 Y（正俯视时没有地平线 → null）。画天空/雾的分界用它，不要另估。
  const horizonY = cs > 1e-9 ? py - (S * d * sn) / cs : null;

  // 给 GLSL 片段（CAMERA3D_GLSL）的 uniform。三个 vec4，用 film-webfx 的 render(t, {...uniforms()}) 直接传。
  const uniforms = () => ({ u_cam0: [S, sn, cs, d], u_cam1: [px, py, lx, ly], u_cam2: [cy, sy, 0, 0] });

  return { project, unproject, uniforms, horizonY, S, elevation, distance, sn, cs, yaw, look, screen };
}

// 镜头感 ↔ distance：画面高 H 像素、注视点处 S 像素/单位时，竖直视场角 fovY（弧度）对应的相机距离。
export const distanceForFov = (fovY, S, H) => (H / 2) / (S * Math.tan(fovY / 2));

// 纵向压扁（正交）和透视差多少像素：同一组点，透视投影 vs "同 S、纵向乘 sin(elevation)" 的压扁版。
// 返回最大偏差（px）与远近边宽度比。用它判断"这一镜用压扁够不够"——偏差 < 1px 时两者画出来没有区别。
export function orthoDeviation(cam, pts) {
  let max = 0;
  for (const [x, y, z = 0] of pts) {
    const p = cam.project(x, y, z);
    const dx = x - cam.look[0], dy = y - cam.look[1];
    const u = Math.cos(cam.yaw) * dx + Math.sin(cam.yaw) * dy, v = -Math.sin(cam.yaw) * dx + Math.cos(cam.yaw) * dy;
    const oX = cam.screen[0] + cam.S * u, oY = cam.screen[1] + cam.S * (v * cam.sn - z * cam.cs);
    max = Math.max(max, Math.hypot(p.X - oX, p.Y - oY));
  }
  return max;
}

// 一块 w × h 的矩形平面（中心在注视点、不转）远边 / 近边的屏幕宽度比。1 = 没有透视（正俯视或压扁）。
export function edgeRatio(cam, w, h) {
  const [lx, ly] = cam.look;
  const far = cam.project(lx + w / 2, ly - h / 2).X - cam.project(lx - w / 2, ly - h / 2).X;
  const near = cam.project(lx + w / 2, ly + h / 2).X - cam.project(lx - w / 2, ly + h / 2).X;
  return far / near;
}

// GLSL ES 1.00 / 3.00 通用片段（不含 precision / varying，接在 film-webfx 的 GLSL.header 之后）。
//   cam_unproject(px)      画面像素（左上原点、Y 向下）→ 平面 z=0 上的世界 xy。地平线以上返回 vec2(1e9)
//   cam_unprojectZ(px, h)  同上，平面 z=h
//   cam_project(w)         世界 xyz → vec3(X, Y, k)
//   cam_footprint(px)      这个像素在平面上有多宽（世界单位）——线宽抗锯齿用：cov = clamp((hw - dist)/fp + 0.5, 0, 1)
//   cam_px()               当前片元的画面像素坐标（film-webfx 的 v_uv 原点在左下，这里翻成左上）
export const CAMERA3D_GLSL = `
uniform vec4 u_cam0;   // S, sin(elev), cos(elev), distance
uniform vec4 u_cam1;   // 注视点屏幕 X, Y；注视点世界 x, y
uniform vec4 u_cam2;   // cos(yaw), sin(yaw), 0, 0
vec2 cam_px(){ return vec2(v_uv.x * u_res.x, (1.0 - v_uv.y) * u_res.y); }
vec2 cam_unprojectZ(vec2 px, float h){
  float S = u_cam0.x, sn = u_cam0.y, cs = u_cam0.z, d = u_cam0.w;
  float Xp = (px.x - u_cam1.x) / S, Yp = (px.y - u_cam1.y) / S;
  float den = d * sn + Yp * cs;
  if (den <= 1e-6) return vec2(1e9);
  float v = (Yp * (d - h * sn) + h * cs * d) / den;
  float depth = d - v * cs - h * sn;
  if (depth <= 0.0) return vec2(1e9);
  float u = Xp * depth / d;
  return vec2(u_cam1.z + u_cam2.x * u - u_cam2.y * v, u_cam1.w + u_cam2.y * u + u_cam2.x * v);
}
vec2 cam_unproject(vec2 px){ return cam_unprojectZ(px, 0.0); }
vec3 cam_project(vec3 w){
  float S = u_cam0.x, sn = u_cam0.y, cs = u_cam0.z, d = u_cam0.w;
  vec2 dw = w.xy - u_cam1.zw;
  float u = u_cam2.x * dw.x + u_cam2.y * dw.y, v = -u_cam2.y * dw.x + u_cam2.x * dw.y;
  float k = d / (d - v * cs - w.z * sn);
  return vec3(u_cam1.x + S * u * k, u_cam1.y + S * (v * sn - w.z * cs) * k, k);
}
float cam_footprint(vec2 px){
  vec2 w = cam_unproject(px);
  return max(length(cam_unproject(px + vec2(1.0, 0.0)) - w), length(cam_unproject(px + vec2(0.0, 1.0)) - w));
}
`;
