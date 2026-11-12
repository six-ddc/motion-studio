# 分层音效、空间尾音与事件处理

目录：1 分层方法 · 2 配方菜单 · 3 cue与总线 · 4 程序接口 · 5 代价与验证

## 1. 按频带与时间分层

把一个声音拆成瞬态、低频身体、空气、机械细节和空间尾音。每层占不同频带/时间，避免所有层同时抢中频。
尾音与本体分开，空间可以切换；连续触发按变体轮换，避免完全相同的样本造成机械重复。
保留落地、碎响等余韵，代价是占用更多混音余量。闷音与音乐压低能突出事件，代价是遮蔽同期信息。
这里的声音是可调的合成配方，不是对真实材料声的听感保证；需要实录质感时使用带授权的 `file` 素材。

## 2. 配方菜单

cue 的 `type` 可以是原有 `SOUNDS`，也可以是以下 `RECIPES`。参数写进 `params`，工程采样率为48kHz。
每个配方默认峰值归一到0.9，绝对响度由 cue.gain 决定；叠加仍可能过载。
下列频段与时长是基于游戏拆解重写的配方选择，可改参数，不是影片统一音色。

| type | 分层/时间 | params与取舍 |
|---|---|---|
| `crack` | >2.6kHz瞬态12ms，160→45Hz身体，300–2500Hz爆压220ms，>4.8kHz空气，35/62ms机械点击 | body/mech/air/drive；0.32s，近距离短爆裂，机械层可能抢台词 |
| `boom` | >1.5kHz爆裂30ms，96→27Hz亚低频，LP2800→260Hz冲击，<120Hz隆隆，碎响与金属叮 | size/debris/pings/drive；3√size秒，小喇叭会丢低频 |
| `impact` | metal非谐模态640Hz×[1,1.58,2.24…]；concrete低通950Hz+碎屑；wood低阶模态；glass高频散点；water带通泼溅 | material必填 metal/concrete/wood/glass/water；ring/debris；几何声学的简化 |
| `zing` | 3300→820Hz带颤音正弦+同频带通噪声+点击 | vibrato；0.75s，突出滑落/弹开的声音 |
| `passby` | 5200→1300Hz带通噪声，高斯峰在50ms，前沿18ms后沿50ms | peak/from/to；0.3s，未模拟真正多普勒传播 |
| `clatter` | 高频非谐金属多次碰撞，间隔与增益递减 | hits/size；0.55s，体现小物件弹跳 |
| `step` / `land` | 112→58Hz身体+低通噪声+高频砂砾；land另有22/50/88ms装备碰响 | grit / gear；0.3/0.45s，不包含鞋底/地面录音细节 |
| `rub` | 1.7→3.4kHz带通噪声，190Hz随机调幅，拱形包络 | dur/from/to/rate/q；0.17s，摩擦和拉链的抽象表达 |
| `riser` | 带通噪声上扫300→6000Hz+失谐啁啾+逐渐密集颗粒，尾部30ms收住 | dur/from/to/tone/sparkle；2s，持续张力会盖住语言 |
| `sub` | 70→30Hz下滑+低通起音，软削波补谐波 | dur/from/to/drive；1.2s，手机主要听到谐波 |
| `shimmer` | 2–9kHz非谐模态，60ms淡入+稀疏高频碎响 | dur/partials/sparkle；1.5s，高频层叠容易刺耳 |
| `hum` | f0的整数谐波+窄带噪声，等功率首尾交叉 | f0/harmonics/dur/noise；2s可循环，持续嗡声会积累低频 |

`variant` 固定变体序号；省略时按同名配方的时间顺序轮换。`seed` 固定噪声，`pitch` 乘音高。
`jitter: .035` 抖动音高±3.5%，或 `{pitch:.035,gain:.08}` 同时减小最多8%增益；只对新配方生效。
把同一种配方插进表里会改变后续自动变体序号；需锁住声音时显式写 variant 和 seed。

## 3. cue与总线

```json
{
 "spaceRule":{"burstGap":0.15},
 "master":{"comp":{"threshold":-12,"ratio":4,"attack":0.002,"release":0.14},"trim":0.7,"clip":{"knee":0.6}},
 "music":{"src":"out/music.wav","out":"out/music-sfx.wav","muffle":false},
 "cues":[
  {"t":1.2,"type":"impact","params":{"material":"metal"},"gain":0.4,"variant":1,"space":{"preset":"indoor","gain":0.15}},
  {"t":2,"type":"boom","gain":0.3,"muffle":{"amount":0.7,"recover":0.6},"duck":{"depth":0.25,"recover":0.3}}
 ]
}
```

| 字段 | 作用 |
|---|---|
| cue.space | `outdoor/indoor` 或 `{preset,gain?,scale?,bright?,seed?}`，左右去相关的程序化IR卷积；scale拉伸时间，bright乘截止频率 |
| cfg.spaceRule | burstGap内相邻事件算一串，默认只在最后一发挂尾音；`edges:'both'`保留首发，throttle秒允许串中补尾音 |
| cue.muffle | amount∈[0,1]，强度按recover秒指数恢复；截止频率=`20000·0.03^Z` |
| cue.bus | `main`默认经过闷音，`dry`绕过闷音；最终都经过master |
| cue.duck | depth∈[0,1]为压到的线性增益，按recover秒恢复；多事件取最深压低 |
| cfg.music | 先读src生成out，不覆盖src；duck作用于整首配乐，muffle可选择跟随 |
| cfg.master | comp阈值dB/ratio/attack秒/release秒/knee dB/makeup dB，随后trim线性增益，最后clip软削波；默认全关闭 |

IR室外为早反射+扫频变暗扩散尾巴+低频隆隆，室内另有驻波与颤动回声。默认长度1.55/2.3s。
IR每声道归一到单位能量，不保证卷积后的峰值；用space.gain留出余量。
Freeverb是共享房间送量，IR是单个事件的空间响应，两者叠加会加重混响。
尾音会延长sfx.wav，但最终mux按画面长度截取；需要完整余韵时在镜头/片尾预算中留时间。

事件duck在sfx脚本先处理配乐，合流用 `mux.sh --music out/music-sfx.wav`。
mux现有旁白sidechain继续乘在其上；两种闪避叠加可能过深，参见 `mix.md`。
不写music时只记录duck曲线并提示，音效自身不会被duck压低；muffle只作用于本次生成的音效和显式处理的配乐，不改旁白。

## 4. 程序接口

从 `runtime/sfx.mjs` 读 `RECIPES/renderRecipe/expandRecipes/stats/makeIR/planTails/muffleCurve/duckCurve/applyMuffle`。
`renderRecipe(name,{params,variant,seed,pitch,jitter})` 返回 `{samples,variant,seed,pitch,gain}`。
`renderCues(cues,opts)` 自动展开配方，`renderStereo(cues,{spaceRule,master,...})` 还处理空间和总线。
DSP低层在 `runtime/sfxdsp.mjs`：`noiseHit/glide/modal/chirp/grains/filter/sweep/softclip/loopXfade/convolve/compress`。
DSP数组是48kHz mono Float32Array；filter/shape/softclip等原地修改，跨声部共享前先复制。

## 5. 代价与验证

原有7音色、单声道混音、等功率声像和Freeverb路径与扩展前逐样本相同。
新配方的归一化会改变层间参数调整后的绝对峰值，音量变化交给gain；跨JS引擎不承诺最后一位相同。
FFT卷积在加载期一次算整段，长素材/长IR需要较多内存，目前未实现分区卷积；渲染时不会读时钟或播放音频。
时变滤波每32个样本更新系数；大幅快速扫频可能产生调制音，声音真实与否仍需人听。

```bash
node <film-narration>/scripts/sfx.mjs --film <slug> --stats
node <film-narration>/scripts/sfx.mjs --list-sounds
```

`--stats`报告峰值、过载数、NaN/Inf、直流、每0.5s RMS；NaN退出1。它检查PCM，不能替代audiocheck对最终成片的真峰/响度检查。
本仓库样例 `_test-sfx/tests/unit.mjs` 有27项回归与确定性测试，`measure.py`验证17种配方/材质的频谱与包络。
只验证客观量；合成材质是否像实物、冲击是否悦耳、混响是否合适，尚未经过人耳评审。
