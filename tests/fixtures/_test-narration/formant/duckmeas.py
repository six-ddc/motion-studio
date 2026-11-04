import json,sys,numpy as np,subprocess
def load(p):
    raw=subprocess.run(["ffmpeg","-v","error","-i",p,"-ac","1","-ar","48000","-f","f32le","-"],capture_output=True,check=True).stdout
    return np.frombuffer(raw,np.float32)
sr=48000;N=9600;H=2400;k=11
def tone(x):
    w=np.hanning(N); return np.array([((i+N/2)/sr,20*np.log10(2*np.abs(np.fft.rfft(x[i:i+N]*w)[k])/w.sum()+1e-12)) for i in range(0,len(x)-N,H)])
n=json.load(open("narration.json")); W=n["words"]
sp=lambda t: any(w["start"]+0.05<=t<=w["end"]-0.05 for w in W)
def gap(t):  # 片内停顿（> 0.6s 的字间空隙），离前一字结束 ≥ 0.45s（让 release=400ms 走完 + 半个分析窗）
    return any(b["start"]-a["end"]>0.6 and a["end"]+0.45<=t<=b["start"]-0.12 for a,b in zip(W,W[1:]))
tail=lambda t: W[-1]["end"]+0.45<=t<=10.3
R={}
for name in sys.argv[1:]:
    tr=tone(load(f"out/final-{name}.mp4")); R[name]=tr
    g=lambda f: np.array([d for t,d in tr if f(t)])
    a,b,c=g(sp),g(gap),g(tail)
    print(f"{name:10s} 55Hz  有旁白 中位 {np.median(a):6.1f} dBFS (n={len(a)})  片内停顿 中位 {np.median(b):6.1f} (n={len(b)})  片尾(旁白结束后) 中位 {np.median(c):7.1f} (n={len(c)})")
if len(sys.argv)>=3:
    x,y=R[sys.argv[-1]],R[sys.argv[-2]]; t=x[:,0]; d=x[:,1]-y[:,1]
    for lab,f in (("有旁白",sp),("片内停顿",gap),("片尾",tail)):
        m=np.array([f(q) for q in t]); print(f"  {sys.argv[-1]}−{sys.argv[-2]} {lab}: p10 {np.percentile(d[m],10):6.1f}  中位 {np.median(d[m]):6.1f}  p90 {np.percentile(d[m],90):6.1f} dB")
