// 开发基准：固定场景、预热后 seek + 1 像素 readPixels 阻塞，测真实完成时间。
import {resolveFilm} from '../../skills/film-core/lib/film.mjs';
import {openScene,launchBrowser} from '../../skills/film-core/lib/browser.mjs';
const base=resolveFilm('tests/fixtures/_test-worldfx');
for(const backend of ['swiftshader','gpu']){
  let browser;
  try{
    browser=await launchBrowser({backend});
    for(const [width,height] of [[540,960],[1080,1920]]){
      for(const extra of [{noreflect:'1',noripple:'1'},{noreflect:'1'},{}]){
        const F={...base,config:{...base.config,backend}};
        const p=await openScene(F,'1x1',{browser,query:{width:String(width),height:String(height),...extra},record:false});
        try{
          const result=await p.page.evaluate(()=>{
            const {S}=window.worldfx;for(let i=0;i<5;i++){window.seek(.6+i*.01);S.finish();}
            const samples=[];for(let i=0;i<15;i++){const start=performance.now();window.seek(.6+i*.01);S.finish();samples.push(performance.now()-start);}
            samples.sort((a,b)=>a-b);return{median:samples[7],p95:samples[14]};
          });
          console.log(JSON.stringify({backend,width,height,reflection:!extra.noreflect,ripple:!extra.noripple,...result}));
          if(p.errors.length)throw new Error(p.errors.join('\n'));
        }finally{await p.close();}
      }
    }
  }catch(e){console.log(JSON.stringify({backend,error:e.message}));process.exitCode=1;}
  finally{await browser?.close();}
}
