#!/usr/bin/env node
// 人眼预览：托管影片目录，打开 /__preview.html —— 一个用 rAF 驱动的播放器 + 拖动条，
// 在 iframe 里调场景的 seek(t)。场景本身仍是纯函数；rAF 只在播放器里。
// 只给人看，判据永远是 seamcheck 和渲出的帧。
//
//   node <film-core>/scripts/preview.mjs --film <slug> [--format 9x16] [--port 4321]
//   托管方式与渲染相同（lib/serve.mjs：./runtime/* 片内优先、否则套件），所以预览看到的就是会渲出来的。
import { resolveFilm, parseArgs, main, FILM_OPTS } from '../lib/film.mjs';
import { serve } from '../lib/serve.mjs';
import { FORMATS } from '../assets/runtime/layout.js';

const args = parseArgs({
  usage: 'node preview.mjs --film <slug> [--format 9x16] [--port 4321]',
  about: '人眼预览：起一个本地服务器托管影片目录，打开 /__preview.html（拖动条 + 播放器）。Ctrl-C 停止。',
  opts: { ...FILM_OPTS, entry: ['<x.html>', '临时换入口'], format: ['<9x16|1x1|16x9>', '画幅'], port: ['<N>', '端口（默认 4321）'] },
});
await main(async () => {
  const F = resolveFilm(args.film, args);
  const format = args.flag('format', F.config.format);
  const { width, height } = FORMATS[format] ?? (() => { throw new Error(`未知画幅 ${format}`); })();
  const fps = F.config.fps;
  const page = `<!doctype html><meta charset="utf-8"><title>preview ${F.slug}</title>
<style>body{margin:0;background:#222;color:#ddd;font:13px system-ui;display:grid;grid-template-rows:1fr auto;height:100vh}
#wrap{display:grid;place-items:center;overflow:hidden}iframe{border:0;width:${width}px;height:${height}px;transform-origin:center}
#bar{display:flex;gap:8px;align-items:center;padding:8px}#s{flex:1}</style>
<div id="wrap"><iframe id="f" src="${F.entryUrl}?format=${format}"></iframe></div>
<div id="bar"><button id="p">播放</button><input id="s" type="range" min="0" step="${1 / fps}" value="0"><span id="l">0.000s</span>
<label><input id="lp" type="checkbox" checked>循环</label></div>
<script>
const f=document.getElementById('f'),s=document.getElementById('s'),l=document.getElementById('l'),p=document.getElementById('p'),lp=document.getElementById('lp');
const fit=()=>{const k=Math.min(innerWidth/${width},(innerHeight-50)/${height});f.style.transform='scale('+k+')';};addEventListener('resize',fit);fit();
let D=1,playing=false,t=0,last=0,busy=false;
const go=async(x)=>{t=x;s.value=x;l.textContent=x.toFixed(3)+'s / '+D+'s';if(busy)return;busy=true;try{await f.contentWindow.seek(x);}finally{busy=false;}};
f.onload=async()=>{const w=f.contentWindow;for(let i=0;i<300&&typeof w.seek!=='function';i++)await new Promise(r=>setTimeout(r,50));await w.ready;D=w.DURATION||1;s.max=D;go(0);};
s.oninput=()=>go(+s.value);
p.onclick=()=>{playing=!playing;p.textContent=playing?'暂停':'播放';last=performance.now();};
const tick=(now)=>{if(playing){let x=t+(now-last)/1000;if(x>D)x=lp.checked?x%D:D;go(x);}last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
</script>`;
  const port = args.num('port', 4321);
  const srv = await serve(F.dir, { port, routes: { '/__preview.html': page } });
  console.log(`预览 ${F.slug}: http://127.0.0.1:${srv.port}/__preview.html   （画幅 ${format}，--format 切换）  Ctrl-C 停止`);
});
