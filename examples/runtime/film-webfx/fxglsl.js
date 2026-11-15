// fxglsl.js —— 风格化后期、调色、多 pass 积木、帧间反馈的 GLSL 片段（纯字符串，零依赖，不读时钟不碰随机）。
// 片子里直接 import { STYLIZE, FEEDBACK } from './runtime/fxglsl.js'，按名字取模板体拼在 header 之后。
// 每个效果是什么、参数、实测代价见 film-webfx 的 references/stylize.md 与 references/fxchain.md。

// ---------------------------------------------------------------------------
// 风格化后期与调色（references/stylize.md 的可运行版本）。
// 单 pass 的模板体只用 TEX / OUT 宏和 GLSL ES 1.00 语法：拼 GLSL.header（createShaderLayer）或 GLSL.header2 / fxchain 的 HEADER 都能编译。
// 例外：lut3d 只能 WebGL2（sampler3D）。模板里没有任何参数的默认值——全部是 uniform，由片子每帧全量传。
// 用 fxchain（createPass / createChain）时缺传会直接抛错；用 createShaderLayer 时 GL 会静默沿用上一次设的值，要自己传满。
// 需要 hash 的（dither）拼 GLSL.hash；其余只要 header。
// 约定：u_src 是预乘色输入（2D canvas 上传后就是预乘的），输出也是预乘色。
// ---------------------------------------------------------------------------
export const STYLIZE = {
  // 半调：旋转网格上每格一个圆点，面积 ∝ 1 − 亮度。查本格和 8 邻格，暗部大点跨格时不被格边截平。9 次取样
  halftone: `
uniform sampler2D u_src; uniform float u_cell; uniform float u_angle; uniform float u_soft;
uniform vec3 u_ink; uniform vec3 u_paper; uniform float u_color;
void main(){
  float cs = cos(u_angle), sn = sin(u_angle);
  vec2 px = v_uv * u_res;
  vec2 q = vec2(cs * px.x + sn * px.y, -sn * px.x + cs * px.y) / u_cell;   // 像素 → 旋转后的网格坐标
  vec2 base = floor(q);
  float cover = 0.0; vec3 dotc = u_ink; float sf = max(u_soft, 1e-3);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = base + vec2(float(i), float(j)) + 0.5;
    vec2 cp = vec2(cs * cc.x - sn * cc.y, sn * cc.x + cs * cc.y) * u_cell;  // 格心回到像素坐标
    vec4 s = TEX(u_src, cp / u_res);
    vec3 c = s.rgb / max(s.a, 1e-5);
    float r = sqrt(clamp(1.0 - dot(c * s.a + (1.0 - s.a) * u_paper, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0)) * 0.7072 * u_cell;
    float d = length(q - cc) * u_cell;
    float a = clamp(0.5 + (r - d) / sf, 0.0, 1.0) * clamp(r / sf, 0.0, 1.0);
    if (a > cover) { cover = a; dotc = c; }
  }
  OUT = vec4(mix(u_paper, mix(u_ink, dotc, u_color), cover), 1.0);
}`,
  // 有序抖动 + 调色板量化：每 u_pixel 像素一格，阈值取 8×8 Bayer（u_noise 往白噪声混，噪声按 u_frame 播种），
  // 加 (阈值 − .5)·u_spread 后取调色板里最近的颜色（sRGB 欧氏距离）。u_pal 是 8 个 vec3 的数组，每帧传满 8 个，u_npal 指明用前几个
  dither: `
uniform sampler2D u_src; uniform float u_pixel; uniform float u_spread; uniform float u_noise; uniform float u_frame;
uniform vec3 u_pal[8]; uniform float u_npal;
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a){ return bayer4(0.5 * a) * 0.25 + bayer2(a); }
void main(){
  vec2 cell = floor(gl_FragCoord.xy / u_pixel);
  vec4 s = TEX(u_src, (cell + 0.5) * u_pixel / u_res);
  vec3 c = s.rgb / max(s.a, 1e-5);
  float th = mix(bayer8(cell), hash12(cell + 17.0 * u_frame + u_seed), u_noise) - 0.5;
  c += th * u_spread;
  float best = 1e9; vec3 o = u_pal[0];
  for (int i = 0; i < 8; i++) { if (float(i) >= u_npal) break; vec3 d = c - u_pal[i]; float e = dot(d, d); if (e < best) { best = e; o = u_pal[i]; } }
  OUT = vec4(o, 1.0);
}`,
  // 像素化：u_cell 像素一格，格原点 u_origin（像素）。u_avg = 0 取格心一点（1 次取样，细线可能整格消失）；1 = 格内 4 点平均
  pixelate: `
uniform sampler2D u_src; uniform float u_cell; uniform vec2 u_origin; uniform float u_avg;
void main(){
  vec2 c = (floor((gl_FragCoord.xy - u_origin) / u_cell) + 0.5) * u_cell + u_origin;
  vec4 one = TEX(u_src, c / u_res);
  float q = 0.25 * u_cell;
  vec4 four = 0.25 * (TEX(u_src, (c + vec2(-q, -q)) / u_res) + TEX(u_src, (c + vec2(q, -q)) / u_res)
                    + TEX(u_src, (c + vec2(-q, q)) / u_res) + TEX(u_src, (c + vec2(q, q)) / u_res));
  OUT = mix(one, four, u_avg);
}`,
  // Sobel 描边：亮度梯度 → smoothstep(u_thresh, u_thresh + u_soft) → 线色。u_width 是取样间距（像素，越大线越粗也越"晕"）；
  // u_keep = 0 线画在纸色上，1 叠在原图上。9 次取样
  outline: `
uniform sampler2D u_src; uniform float u_width; uniform float u_thresh; uniform float u_soft;
uniform vec3 u_line; uniform vec3 u_paper; uniform float u_keep;
float Lm(vec2 o){ vec4 s = TEX(u_src, v_uv + o * u_width / u_res); return dot(s.rgb, vec3(0.2126, 0.7152, 0.0722)); }
void main(){
  float tl = Lm(vec2(-1, 1)), t = Lm(vec2(0, 1)), tr = Lm(vec2(1, 1));
  float l = Lm(vec2(-1, 0)), r = Lm(vec2(1, 0));
  float bl = Lm(vec2(-1, -1)), b = Lm(vec2(0, -1)), br = Lm(vec2(1, -1));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  float e = smoothstep(u_thresh, u_thresh + max(u_soft, 1e-4), length(vec2(gx, gy)));
  vec4 s = TEX(u_src, v_uv);
  vec3 base = mix(u_paper, s.rgb / max(s.a, 1e-5), u_keep);
  OUT = vec4(mix(base, u_line, e), 1.0);
}`,
  // Kuwahara（经典四象限）：每个像素在 4 个 (r+1)² 的象限里各算均值和方差，取方差最小的那个的均值 → 平涂、保边的油画感。
  // 每圈同时取 4 个象限的对称点（4·(r+1)² 次取样，轴上的点被相邻象限共用）。循环上界是编译期常量 KMAX
  // （GLSL ES 1.00 不许 uniform 做循环上界）：拼接时在模板前写 `#define KMAX 4` 编出更便宜的版本；u_radius 取整后 > KMAX 时按 KMAX 算。
  // 假定输入不透明（alpha 输出 1）
  kuwahara: `
#ifndef KMAX
#define KMAX 6
#endif
uniform sampler2D u_src; uniform float u_radius;
void main(){
  vec2 px = 1.0 / u_res;
  float R = min(floor(u_radius + 0.5), float(KMAX));
  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  for (int j = 0; j <= KMAX; j++) {
    if (float(j) > R) break;
    for (int i = 0; i <= KMAX; i++) {
      if (float(i) > R) break;
      vec2 o = vec2(float(i), float(j)) * px;
      vec3 a = TEX(u_src, v_uv - o).rgb, b = TEX(u_src, v_uv + vec2(o.x, -o.y)).rgb;
      vec3 c = TEX(u_src, v_uv + vec2(-o.x, o.y)).rgb, d = TEX(u_src, v_uv + o).rgb;
      m0 += a; s0 += a * a; m1 += b; s1 += b * b; m2 += c; s2 += c * c; m3 += d; s3 += d * d;
    }
  }
  float n = (R + 1.0) * (R + 1.0);
  m0 /= n; m1 /= n; m2 /= n; m3 /= n;
  float v0 = dot(s0 / n - m0 * m0, vec3(1.0)), v1 = dot(s1 / n - m1 * m1, vec3(1.0));
  float v2 = dot(s2 / n - m2 * m2, vec3(1.0)), v3 = dot(s3 / n - m3 * m3, vec3(1.0));
  vec3 o = m0; float v = v0;
  if (v1 < v) { v = v1; o = m1; } if (v2 < v) { v = v2; o = m2; } if (v3 < v) { v = v3; o = m3; }
  OUT = vec4(o, 1.0);
}`,
  // ASCII / 字符化：u_cell 像素一格，取格心亮度挑 10 个程序化 5×5 字形之一（' . : - + x = @ # █'，按墨量排），
  // 字形编码在着色器里，不依赖字体文件（所以不经过字体来源门，也不受随片字体约束）。格宽取 6 的倍数时字形像素对齐。
  // u_color = 0 字用 u_ink，1 用格内原色。1 次取样 + 至多 15 次循环解码
  ascii: `
uniform sampler2D u_src; uniform float u_cell; uniform vec3 u_ink; uniform vec3 u_paper; uniform float u_color;
vec2 glyph(float i){
  if (i < 0.5) return vec2(0.0, 0.0);       if (i < 1.5) return vec2(0.0, 128.0);
  if (i < 2.5) return vec2(128.0, 4.0);     if (i < 3.5) return vec2(14336.0, 0.0);
  if (i < 4.5) return vec2(14464.0, 4.0);   if (i < 5.5) return vec2(4433.0, 554.0);
  if (i < 6.5) return vec2(992.0, 31.0);    if (i < 7.5) return vec2(30254.0, 961.0);
  if (i < 8.5) return vec2(11242.0, 351.0); return vec2(32767.0, 1023.0);
}
float gbit(vec2 g, float col, float row){   // row 0 = 顶行；前 3 行在 g.x，后 2 行在 g.y，每行 5 位、左列是低位
  float v = row < 2.5 ? g.x : g.y;
  float idx = (row < 2.5 ? row : row - 3.0) * 5.0 + col;
  for (int k = 0; k < 15; k++) { if (float(k) >= idx) break; v = floor(v * 0.5); }
  return mod(v, 2.0);
}
void main(){
  vec2 cell = floor(gl_FragCoord.xy / u_cell);
  vec4 s = TEX(u_src, (cell + 0.5) * u_cell / u_res);
  vec3 c = s.rgb / max(s.a, 1e-5);
  float l = clamp(dot(s.rgb + (1.0 - s.a) * u_paper, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float gi = floor(l * 9.999);
  vec2 sub = floor((gl_FragCoord.xy - cell * u_cell) / u_cell * 6.0);   // 6×6 子格：右列、底行留空当字距
  float on = (sub.x < 4.5 && sub.y > 0.5) ? gbit(glyph(gi), sub.x, 5.0 - sub.y) : 0.0;
  OUT = vec4(mix(u_paper, mix(u_ink, c, u_color), on), 1.0);
}`,
  // 镜头畸变：r²（角上 = 1）的多项式 f = 1 + k1 r² + k2 r⁴，按 f 缩放取样坐标。k1 > 0 桶形、k1 < 0 枕形；
  // u_zoom 补偿缩放（桶形会把画面边缘推出去，zoom > 1 把它拉回来）；u_disp ≠ 0 时 R / B 用 (1 ∓ disp) 的 f → 边缘色散。
  // 取样出界的地方填 u_edge（预乘 vec4）。3 次取样
  lens: `
uniform sampler2D u_src; uniform float u_k1; uniform float u_k2; uniform float u_zoom; uniform float u_disp; uniform vec4 u_edge;
vec4 tap(vec2 uv, float k){
  vec2 a = vec2(u_res.x / u_res.y, 1.0);
  vec2 c = (uv - 0.5) * a;
  float r2 = dot(c, c) / dot(0.5 * a, 0.5 * a);
  float f = 1.0 + u_k1 * r2 + u_k2 * r2 * r2;
  vec2 q = 0.5 + c * f * k / u_zoom / a;
  float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
  return mix(u_edge, TEX(u_src, q), inside);
}
void main(){
  vec4 g = tap(v_uv, 1.0);
  OUT = vec4(tap(v_uv, 1.0 - u_disp).r, g.g, tap(v_uv, 1.0 + u_disp).b, g.a);
}`,
  // lift / gamma / gain + 曝光 + 饱和度（在反预乘后的颜色上做，再乘回 alpha）：
  //   c = 2^exposure · c;  c = gain · (c + lift · (1 − c));  c = c^(1/gamma);  c = mix(luma, c, sat)
  // 恒等值是 lift 0、gamma 1、gain 1、exposure 0、sat 1（那是数学上的"不变"，不是推荐值）
  grade_lgg: `
uniform sampler2D u_src; uniform vec3 u_lift; uniform vec3 u_gamma; uniform vec3 u_gain; uniform float u_exposure; uniform float u_sat;
void main(){
  vec4 s = TEX(u_src, v_uv);
  vec3 c = s.rgb / max(s.a, 1e-5) * exp2(u_exposure);
  c = u_gain * (c + u_lift * (1.0 - c));
  c = pow(max(c, 0.0), 1.0 / max(u_gamma, vec3(1e-3)));
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, u_sat);
  OUT = vec4(c * s.a, s.a);
}`,
  // 3D LUT，2D 条带版（WebGL1 也能用）：u_lut 是 fxchain.js 的 cubeCanvas(parseCube(text)) 上传成的纹理（宽 n²、高 n，8 位），
  // 手工在 b 方向两片之间插值、片内靠硬件双线性。u_mix 0..1 混回原图
  lut_strip: `
uniform sampler2D u_src; uniform sampler2D u_lut; uniform float u_lutn; uniform float u_mix;
vec3 lutS(vec3 c){
  float n = u_lutn; c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0), b0 = floor(b), b1 = min(b0 + 1.0, n - 1.0);
  float x = c.r * (n - 1.0) + 0.5, y = (c.g * (n - 1.0) + 0.5) / n;
  vec3 a0 = TEX(u_lut, vec2((b0 * n + x) / (n * n), y)).rgb;
  vec3 a1 = TEX(u_lut, vec2((b1 * n + x) / (n * n), y)).rgb;
  return mix(a0, a1, b - b0);
}
void main(){
  vec4 s = TEX(u_src, v_uv); vec3 c = s.rgb / max(s.a, 1e-5);
  OUT = vec4(mix(c, lutS(c), u_mix) * s.a, s.a);
}`,
  // 3D LUT，WebGL2 sampler3D 版：u_lut 由 fxchain 的 chain.lut('lut', parseCube(text)) 建（RGBA16F，硬件三线性）。1 次 3D 取样
  lut3d: `
uniform sampler2D u_src; uniform highp sampler3D u_lut; uniform float u_mix;
void main(){
  vec4 s = TEX(u_src, v_uv); vec3 c = clamp(s.rgb / max(s.a, 1e-5), 0.0, 1.0);
  vec3 n = vec3(textureSize(u_lut, 0));
  vec3 g = texture(u_lut, (c * (n - 1.0) + 0.5) / n).rgb;
  OUT = vec4(mix(c, g, u_mix) * s.a, s.a);
}`,

  // ---- 多 pass 的积木（泛光 / halation / 变形镜头拉丝都由它们拼出来，接法见 references/stylize.md） ----
  // 亮部提取：按 max(r,g,b) 过 smoothstep(u_thresh, u_thresh + u_knee)。输出不透明
  extract: `
uniform sampler2D u_src; uniform float u_thresh; uniform float u_knee;
void main(){ vec3 c = TEX(u_src, v_uv).rgb; float l = max(c.r, max(c.g, c.b));
  OUT = vec4(c * smoothstep(u_thresh, u_thresh + max(u_knee, 1e-4), l), 1.0); }`,
  // 4 点双线性降采样（每点落在源纹理 4 个像素的交点 → 等于 4×4 盒式平均）。u_src_size 是源纹理尺寸（fxchain 自动传）
  down4: `
uniform sampler2D u_src; uniform vec2 u_src_size;
void main(){ vec2 h = 1.0 / u_src_size;
  OUT = 0.25 * (TEX(u_src, v_uv + vec2(-h.x, -h.y)) + TEX(u_src, v_uv + vec2(h.x, -h.y)) + TEX(u_src, v_uv + vec2(-h.x, h.y)) + TEX(u_src, v_uv + h)); }`,
  // 9 tap 二项式（≈高斯 σ=2 tap）一维模糊。u_dir 是每个 tap 的步长（本 pass 输出像素）：(s,0) 横、(0,s) 竖。
  // 分离高斯 = 横一遍 + 竖一遍；拉丝 = 只横、步长逐遍放大（1, 3, 9…）
  blur9: `
uniform sampler2D u_src; uniform vec2 u_dir;
void main(){ vec2 d = u_dir / u_res;
  vec4 a = TEX(u_src, v_uv) * 0.2734375;
  a += (TEX(u_src, v_uv + d) + TEX(u_src, v_uv - d)) * 0.21875;
  a += (TEX(u_src, v_uv + 2.0 * d) + TEX(u_src, v_uv - 2.0 * d)) * 0.109375;
  a += (TEX(u_src, v_uv + 3.0 * d) + TEX(u_src, v_uv - 3.0 * d)) * 0.03125;
  a += (TEX(u_src, v_uv + 4.0 * d) + TEX(u_src, v_uv - 4.0 * d)) * 0.00390625;
  OUT = a; }`,
  // 光晕合成：src + amount · tint · mix(glow, luma(glow), mono)，其中 glow = max(blur − ring · mask, 0)。
  // 泛光：ring 0、mono 0；halation：mono 1 + 偏红 tint + ring > 0（扣掉亮部本身，只留外圈红晕）；拉丝：glow 接横向模糊链。
  // 加法合成假定 src 不透明
  glow_mix: `
uniform sampler2D u_src; uniform sampler2D u_glow; uniform sampler2D u_mask;
uniform vec3 u_tint; uniform float u_amount; uniform float u_ring; uniform float u_mono;
void main(){
  vec4 s = TEX(u_src, v_uv);
  vec3 g = max(TEX(u_glow, v_uv).rgb - u_ring * TEX(u_mask, v_uv).rgb, 0.0);
  g = mix(g, vec3(dot(g, vec3(0.2126, 0.7152, 0.0722))), u_mono);
  OUT = vec4(s.rgb + u_amount * u_tint * g, s.a);
}`,
};

// ---------------------------------------------------------------------------
// 帧间反馈（fxchain.js 的 feedback）。step 着色器读 u_prev（上一步状态），内置 u_time = 仿真秒 k·dt、u_step = k、u_dt。
// 拼接：fxchain HEADER + GLSL.hash + GLSL.noise + 模板体。参数全部来自 feedback.uniforms(k, s)（每步全量）。
// ---------------------------------------------------------------------------
export const FEEDBACK = {
  // Gray-Scott 反应扩散：state.r = A、state.g = B。初值 A=1，u_spots 个半径 u_radius 像素的 B 种子（位置由 u_seed hash 出）
  gs_init: `
uniform float u_spots; uniform float u_radius;
void main(){
  vec2 px = v_uv * u_res; float b = 0.0;
  for (int i = 0; i < 64; i++) { if (float(i) >= u_spots) break;
    vec2 c = hash22(vec2(float(i) * 7.13, u_seed)) * u_res;
    b = max(b, 1.0 - step(u_radius, length(px - c))); }
  OUT = vec4(1.0, b, 0.0, 1.0);
}`,
  // 一步：9 点拉普拉斯（中心 −1、邻 .2、角 .05），u_rdt 是反应扩散自己的时间步（与 u_dt 无关）。状态要 rgba32f（半精度在 A≈1 附近的增量会被舍掉）
  gs_step: `
uniform sampler2D u_prev; uniform float u_da; uniform float u_db; uniform float u_feed; uniform float u_kill; uniform float u_rdt;
vec2 S(vec2 o){ return TEX(u_prev, v_uv + o / u_res).rg; }
void main(){
  vec2 c = S(vec2(0.0));
  vec2 lap = -c + 0.2 * (S(vec2(1, 0)) + S(vec2(-1, 0)) + S(vec2(0, 1)) + S(vec2(0, -1)))
               + 0.05 * (S(vec2(1, 1)) + S(vec2(-1, 1)) + S(vec2(1, -1)) + S(vec2(-1, -1)));
  float a = c.x, b = c.y, abb = a * b * b;
  a += u_rdt * (u_da * lap.x - abb + u_feed * (1.0 - a));
  b += u_rdt * (u_db * lap.y + abb - (u_kill + u_feed) * b);
  OUT = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
}`,
  // 显示：B 浓度过 smoothstep(u_lo, u_hi) 映射到两色之间
  gs_show: `
uniform sampler2D u_state; uniform vec3 u_ink; uniform vec3 u_paper; uniform float u_lo; uniform float u_hi;
void main(){ float b = TEX(u_state, v_uv).g; OUT = vec4(mix(u_paper, u_ink, smoothstep(u_lo, u_hi, b)), 1.0); }`,
  // 墨晕 / 拖影：上一步的状态沿 curl noise 流场平流（u_flow：每步位移，uv 单位）、和 4 邻平均混（u_bleed）、乘 u_decay 衰减，
  // 再在笔尖 u_pen（uv）处按 u_penr 半径盖上 u_pencol（预乘，alpha 1）。笔尖轨迹由 uniforms(k, s) 闭式给出。
  // u_decay = 1、u_flow = 0、u_bleed = 0 就是纯拖影（笔迹永不消失）
  ink_step: `
uniform sampler2D u_prev; uniform float u_decay; uniform float u_flow; uniform float u_scale; uniform float u_bleed;
uniform vec2 u_pen; uniform float u_penr; uniform float u_pen_on; uniform vec3 u_pencol;
void main(){
  vec2 asp = vec2(u_res.x / u_res.y, 1.0);
  vec2 p = v_uv * asp * u_scale + u_seed;
  float e = 0.05, tt = 0.1 * u_time;
  float n1 = vnoise3(vec3(p + vec2(0.0, e), tt)), n2 = vnoise3(vec3(p - vec2(0.0, e), tt));
  float n3 = vnoise3(vec3(p + vec2(e, 0.0), tt)), n4 = vnoise3(vec3(p - vec2(e, 0.0), tt));
  vec2 vel = vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
  vec2 uv = v_uv - vel * u_flow / asp;
  vec2 px = 1.0 / u_res;
  vec4 c = TEX(u_prev, uv);
  vec4 nb = 0.25 * (TEX(u_prev, uv + vec2(px.x, 0.0)) + TEX(u_prev, uv - vec2(px.x, 0.0)) + TEX(u_prev, uv + vec2(0.0, px.y)) + TEX(u_prev, uv - vec2(0.0, px.y)));
  c = mix(c, nb, u_bleed) * u_decay;
  float st = u_pen_on * (1.0 - smoothstep(0.6 * u_penr, u_penr, length((v_uv - u_pen) * asp)));
  OUT = mix(c, vec4(u_pencol, 1.0), st);
}`,
  // 显示：预乘状态叠在纸色上
  ink_show: `
uniform sampler2D u_state; uniform vec3 u_paper;
void main(){ vec4 s = TEX(u_state, v_uv); OUT = vec4(u_paper * (1.0 - s.a) + s.rgb, 1.0); }`,
};
