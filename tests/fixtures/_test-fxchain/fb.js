// 反馈场景（scene.html 与两个阴性对照共用）：上半 Gray-Scott 反应扩散（270×480，rgba32f），
// 下半墨晕拖影（540×960，rgba16f，笔尖沿闭式轨迹走）。参数只是这支验收片的取值，不是推荐。
import { makeLayout } from './runtime/layout.js';
import { createChain, HEADER } from './runtime/fxchain.js';
import { GLSL } from './runtime/webfx.js';
import { FEEDBACK } from './runtime/fxglsl.js';

export function build(leak) {
  const L = makeLayout(new URLSearchParams(location.search).get('format') || '9x16');
  const DURATION = 12;
  window.DURATION = DURATION;
  const stage = document.getElementById('stage');
  stage.width = L.width; stage.height = L.height;
  const ctx = stage.getContext('2d', { alpha: false });
  const LIB = HEADER + GLSL.hash + GLSL.noise;
  const TAU = Math.PI * 2;

  const chain = createChain({
    width: L.width, height: L.height, seed: 3, leak,
    feedback: [
      { name: 'rd', scale: [0.25, 0.125], format: 'rgba32f', filter: 'linear', wrap: 'repeat',
        rate: 30, substeps: 8, every: 1,
        init: LIB + FEEDBACK.gs_init, frag: LIB + FEEDBACK.gs_step,
        uniforms: () => ({ u_spots: 24, u_radius: 4, u_da: 1.0, u_db: 0.5, u_feed: 0.0367, u_kill: 0.0649, u_rdt: 1.0 }) },
      { name: 'ink', scale: [0.5, 0.25], format: 'rgba16f', filter: 'linear', wrap: 'clamp',
        rate: 30, substeps: 1, every: 1,
        frag: LIB + FEEDBACK.ink_step,
        // 笔尖：s 的闭式函数（利萨如曲线），每 3 秒抬笔 0.8 秒
        uniforms: (k, s) => ({
          u_decay: 0.996, u_flow: 0.0025, u_scale: 2.0, u_bleed: 0.25,
          u_pen: [0.5 + 0.36 * Math.sin(TAU * s / 5.1), 0.5 + 0.34 * Math.sin(TAU * s / 3.7 + 0.6)],
          u_penr: 0.035, u_pen_on: (s % 3) < 2.2 ? 1 : 0,
          u_pencol: [0.12 + 0.1 * Math.sin(s), 0.10, 0.22],
        }) },
    ],
    passes: [
      { name: 'show', out: 'screen', in: { u_rd: 'rd', u_ink: 'ink' },
        frag: HEADER + `
uniform sampler2D u_rd; uniform sampler2D u_ink; uniform vec3 u_a; uniform vec3 u_b; uniform vec3 u_paper;
void main(){
  if (v_uv.y > 0.5) {
    float b = TEX(u_rd, vec2(v_uv.x, (v_uv.y - 0.5) * 2.0)).g;
    OUT = vec4(mix(u_a, u_b, smoothstep(0.12, 0.32, b)), 1.0);
  } else {
    vec4 s = TEX(u_ink, vec2(v_uv.x, v_uv.y * 2.0));
    OUT = vec4(u_paper * (1.0 - s.a) + s.rgb, 1.0);
  }
}` },
    ],
  });

  window.seek = (t) => {
    chain.render(t, { u_a: [0.06, 0.07, 0.09], u_b: [0.92, 0.78, 0.55], u_paper: [0.93, 0.91, 0.86] });
    chain.drawTo(ctx);
  };
  window.__chain = chain;   // 给 bench 脚本用
}
