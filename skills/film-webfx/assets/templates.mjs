// 着色器模板 + 性能分档（随 film-webfx 安装；纯字符串导出，不是运行时）。仓库开发工具 dev/film-webfx/bench.mjs 逐个编译、计时、做确定性校验，
// references/shaders.md 里的每个模板都在这里有一份真跑过的源码。
//
// 每个模板只用 u_time / u_res / u_seed 和自己声明的 uniform；
// 拼接顺序：GLSL.header + GLSL.hash + GLSL.noise + GLSL.loop + body

export const TIERS = {
  // T0：几乎没有算术。代表"整屏调色 / 渐变 / 晕影"这类
  t0_gradient: `
void main(){
  vec2 uv = v_uv;
  float v = 0.5 + 0.5 * sin(6.2831 * (uv.y + 0.1 * u_time));
  float vig = smoothstep(1.2, 0.3, length(uv - 0.5) * 1.6);
  OUT = vec4(vec3(v * vig, uv.x * vig, 0.4 * vig), 1.0);
}`,
  // T1：5 层 value noise fbm（≈20 次 hash）。代表"烟、云、纸纹"
  t1_fbm: `
void main(){
  vec2 p = v_uv * vec2(u_res.x / u_res.y, 1.0) * 4.0;
  float n = fbm(p + vec2(0.0, 0.3 * u_time) + u_seed);
  OUT = vec4(vec3(n), 1.0);
}`,
  // T2：三重 domain warp（3 次 fbm = 15 次 noise ≈ 60 次 hash）。代表"流体、大理石、墨流"
  t2_warp: `
void main(){
  vec2 p = v_uv * vec2(u_res.x / u_res.y, 1.0) * 3.0 + u_seed;
  vec2 q = vec2(fbm(p + 0.05 * u_time), fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.12 * u_time), fbm(p + 4.0 * q + vec2(8.3, 2.8)));
  float f = fbm(p + 4.0 * r);
  vec3 col = mix(vec3(0.1, 0.2, 0.3), vec3(0.9, 0.8, 0.6), f);
  col = mix(col, vec3(0.0, 0.05, 0.1), dot(q, q) * 0.5);
  OUT = vec4(col, 1.0);
}`,
  // T3：光线步进 64 步 SDF + 法线（6 次额外求值）+ 简单光照。代表"3D 程序化场景"
  t3_raymarch: `
float sdf(vec3 p){
  vec3 q = p; q.xz = mod(q.xz + 1.0, 2.0) - 1.0;
  float s = length(q - vec3(0.0, 0.3 * sin(u_time + floor(p.x * 0.5) * 1.7), 0.0)) - 0.45;
  return min(s, p.y + 0.6);
}
vec3 nrm(vec3 p){ vec2 e = vec2(1e-3, 0.0);
  return normalize(vec3(sdf(p + e.xyy) - sdf(p - e.xyy), sdf(p + e.yxy) - sdf(p - e.yxy), sdf(p + e.yyx) - sdf(p - e.yyx))); }
void main(){
  vec2 uv = (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.0;
  vec3 ro = vec3(0.0, 0.8, -3.0 + 0.5 * u_time), rd = normalize(vec3(uv, 1.6));
  float d = 0.0; vec3 p = ro;
  for (int i = 0; i < 64; i++){ p = ro + rd * d; float h = sdf(p); if (h < 1e-3 || d > 30.0) break; d += h; }
  vec3 col = vec3(0.02);
  if (d < 30.0){ vec3 n = nrm(p); col = vec3(0.8, 0.7, 0.6) * max(dot(n, normalize(vec3(0.5, 0.8, -0.4))), 0.0) + 0.05; }
  col = mix(col, vec3(0.02), 1.0 - exp(-0.04 * d * d));
  OUT = vec4(pow(col, vec3(0.4545)), 1.0);
}`,
  // T5：fbm 地形光线步进（每步 1 次 5 层 fbm，最多 96 步 ≈ 2000 次 hash/像素）。用来找性能悬崖
  t5_terrain: `
float H(vec2 p){ return fbm(p * 0.4) * 2.0; }
void main(){
  vec2 uv = (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.0;
  vec3 ro = vec3(0.0, 2.2, u_time), rd = normalize(vec3(uv.x, uv.y - 0.25, 1.4));
  float d = 0.1;
  for (int i = 0; i < 96; i++){ vec3 p = ro + rd * d; float h = p.y - H(p.xz); if (h < 0.002 * d || d > 40.0) break; d += 0.5 * h; }
  vec3 col = d < 40.0 ? vec3(0.4, 0.35, 0.3) * (1.0 - d / 40.0) : vec3(0.6, 0.7, 0.8);
  OUT = vec4(col, 1.0);
}`,
  // T4：25 次纹理采样（5×5 模糊）。代表"后期：泛光/景深/模糊"——测纹理采样成本
  t4_blur25: `
uniform sampler2D u_src;
void main(){
  vec2 px = 1.0 / u_res; vec4 acc = vec4(0.0);
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) acc += TEX(u_src, v_uv + vec2(x, y) * px * 3.0);
  OUT = acc / 25.0;
}`,
};

// 模板库（references/shaders.md 的可运行版本）。key 与文档小节同名
export const TEMPLATES = {
  // 循环 fbm：PERIOD 秒一圈，首尾帧逐像素一致
  loop_fbm: `
uniform float u_period;
void main(){
  vec2 p = v_uv * vec2(u_res.x / u_res.y, 1.0) * 3.0 + u_seed;
  float n = loopFbm(p, u_time / u_period, 0.8);
  OUT = vec4(vec3(n), 1.0);
}`,
  // 流场可视化（curl noise 方向 → 条纹）。粒子沿流场的运动积分参见 film-physics
  curl_field: `
vec2 curl(vec2 p){ float e = 0.01;
  float a = fbm(p + vec2(0.0, e)), b = fbm(p - vec2(0.0, e)), c = fbm(p + vec2(e, 0.0)), d = fbm(p - vec2(e, 0.0));
  return vec2(a - b, -(c - d)) / (2.0 * e); }
void main(){
  vec2 p = v_uv * vec2(u_res.x / u_res.y, 1.0) * 2.5 + u_seed;
  vec2 v = curl(p + 0.1 * u_time);
  float ang = atan(v.y, v.x);
  float stripes = 0.5 + 0.5 * sin(40.0 * dot(v_uv, vec2(cos(ang), sin(ang))) + 2.0 * u_time);
  OUT = vec4(vec3(stripes) * clamp(length(v) * 0.5, 0.0, 1.0), 1.0);
}`,
  // 置换：拿 2D 层当纹理，用噪声推 uv（水波/热浪/玻璃）
  displace: `
uniform sampler2D u_src; uniform float u_amp;
void main(){
  vec2 p = v_uv * 6.0;
  vec2 off = vec2(vnoise(p + vec2(0.0, u_time)), vnoise(p + vec2(7.3, -u_time))) - 0.5;
  OUT = TEX(u_src, v_uv + off * u_amp);
}`,
  // 色差：RGB 三通道分别偏移
  chroma: `
uniform sampler2D u_src; uniform float u_amt;
void main(){
  vec2 d = (v_uv - 0.5) * u_amt;
  vec4 c = TEX(u_src, v_uv);
  OUT = vec4(TEX(u_src, v_uv + d).r, c.g, TEX(u_src, v_uv - d).b, c.a);
}`,
  // 颗粒 + 晕影 + 色调映射：一遍完成的"胶片终端"。颗粒按帧号换种子 → 可 seek
  grade: `
uniform sampler2D u_src; uniform float u_frame; uniform float u_grain; uniform float u_vig;
void main(){
  vec3 c = TEX(u_src, v_uv).rgb;
  c = c / (1.0 + c);                       // Reinhard
  c *= 2.0;                                // 补回中灰
  float g = hash12(gl_FragCoord.xy + 17.0 * u_frame + u_seed) - 0.5;
  c += g * u_grain;
  c *= mix(1.0, smoothstep(0.9, 0.2, length(v_uv - 0.5)), u_vig);
  OUT = vec4(c, 1.0);
}`,
  // 阈值泛光的"亮部提取"步（真泛光要多遍：提取 → 降采样模糊 → 叠加，见 compositing.md）
  bright: `
uniform sampler2D u_src; uniform float u_thresh;
void main(){ vec4 c = TEX(u_src, v_uv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  OUT = vec4(c.rgb * smoothstep(u_thresh, u_thresh + 0.1, l), 1.0); }`,
};
