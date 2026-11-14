# 分层音效、空间尾音与事件处理

目录：1 分层方法 · 2 配方菜单 · 3 cue与总线 · 4 程序接口 · 5 代价与验证

## 1. 按频带与时间分层

把一个声音拆成瞬态、低频身体、空气、机械细节和空间尾音，每层占不同频带/时间；尾音与本体分开，连续触发换变体避免机械重复。
余韵占混音余量，闷音与压低遮蔽同期信息。这是可调的合成配方，不保证像实物；要实录质感用带授权的 `file` 素材。

## 2. 配方菜单

cue 的 `type` 可以是原有 `SOUNDS`，也可以是以下 `RECIPES`。参数写进 `params`；采样率只有一个来源 `sfxdsp.mjs` 的 `SR`（48kHz，`RATE` 就是它）。
每个配方先过20Hz二阶高通去直流（旧 boom 直流约0.009；30Hz处约-0.8dB，boom/sub 最低频略弱），再峰值归一到0.9，绝对响度由 cue.gain 决定；叠加仍可能过载。
缓冲长度随参数变：impact 的 ring>1 按比例拉长，boom 取 max(3√size, 1.9·size+0.2)，clatter 按 hits 算；默认参数下长度不变。
下列频段与时长是基于游戏拆解重写的配方选择，可改参数，不是影片统一音色。

| type | 分层/时间 | params与取舍 |
|---|---|---|
| `crack` | >2.6kHz瞬态12ms，160→45Hz身体，300–2500Hz爆压220ms，>4.8kHz空气，35/62ms机械点击 | body/mech/air/drive；0.32s，近距离短爆裂，机械层可能抢台词 |
| `boom` | >1.5kHz爆裂30ms，96→27Hz亚低频，LP2800→260Hz冲击，<120Hz隆隆，碎响与金属叮 | size/debris/pings/drive；size≤1.7时3√size秒，小喇叭会丢低频 |
| `impact` | metal非谐模态640Hz×[1,1.58,2.24…]；concrete低通950Hz+碎屑；wood低阶模态；glass高频散点；water带通泼溅 | material必填 metal/concrete/wood/glass/water；ring/debris；几何声学的简化 |
| `zing` | 3300→820Hz带颤音正弦+同频带通噪声+点击 | vibrato；0.75s，突出滑落/弹开的声音 |
| `passby` | 5200→1300Hz带通噪声，高斯峰在50ms，前沿18ms后沿50ms | peak/from/to；0.3s，未模拟真正多普勒传播 |
| `clatter` | 高频非谐金属多次碰撞，间隔与增益递减 | hits/size；默认0.55s，hits多则更长 |
| `step` / `land` | 112→58Hz身体+低通噪声+高频砂砾；land另有22/50/88ms装备碰响 | grit / gear；0.3/0.45s，不包含鞋底/地面录音细节 |
| `rub` | 1.7→3.4kHz带通噪声，190Hz随机调幅，拱形包络 | dur/from/to/rate/q；0.17s，摩擦和拉链的抽象表达 |
| `riser` | 带通噪声上扫300→6000Hz+失谐啁啾+逐渐密集颗粒，尾部30ms收住 | dur/from/to/tone/sparkle；2s，持续张力会盖住语言 |
| `sub` | 70→30Hz下滑+低通起音，软削波补谐波 | dur/from/to/drive；1.2s，手机主要听到谐波 |
| `shimmer` | 2–9kHz非谐模态，60ms淡入+稀疏高频碎响 | dur/partials/sparkle；1.5s，高频层叠容易刺耳 |
| `hum` | f0的整数谐波+窄带噪声，等功率首尾交叉 | f0/harmonics/dur/noise；2s可循环，持续嗡声会积累低频 |
| `rain` | 立体声床：u^2.5 大小分布的雨滴（带通噪声激励，hard 大时加振铃，pool 比例落水气泡上扬啁啾）+ 300Hz–5.2kHz 噪声底 + 1.3s 阵风起伏；按落点等功率声像、噪声底两路独立，首尾交叉可循环 | **density（滴/秒，参考 30/300/2000+）与 hard（0 泥土树叶–1 铁皮石板）必填**；dur 6 / size / bright / distance（1 ≈ 1.9kHz 低通）/ pool / wash / width。宽带连续床正好盖在辅音频段，对白下要压 gain 或 lowpass；峰值归一按最大一滴算，响度随 density 变，用 gain 定；是抽象，没有屋檐滴水、排水、远近层次；dur 短于约 6s 能听出循环 |

立体声配方（rain）多出 `samplesR`：`sfx.mjs` 自动走立体声路径，`pan` 当平衡，尾音/共享房间送 (L+R)/2；`renderCues` 单声道路径取 (L+R)/√2。
`variant` 固定变体序号。省略时：cue 有 `id`（事件表 toCues 透传的）按 hash(配方名, id) 取，插入别的事件不改它，代价是相邻两发可能同变体；
没有 id 按同名配方的时间顺序轮换，插入一个同名 cue 会让后面的全部换变体。`seed` 固定噪声，`pitch` 乘音高。`drive` 等正参数写 0 直接报错。
`jitter: .035` 抖动音高±3.5%，或 `{pitch:.035,gain:.08}` 同时减小最多8%增益；种子与变体同规则（id 或出现序号），每发各不相同；只对新配方生效。
同一张表里参数完全相同的配方 cue 只渲一次，共享同一个 samples 数组。

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
| cue.space | `{preset:outdoor/indoor,gain,scale?,bright?,seed?}`，左右去相关的程序化IR卷积；**gain 必填**（参考0.08–0.2；IR单位能量，1时尾音与干声等能量），scale拉伸时间，bright乘截止频率。键序无关 |
| cue.tail | `true/false`。表里任一 cue 写了 tail，就严格按它挂尾音（tail:true 必须有 space），spaceRule 不参与；事件表 `toCues(…,{tails: burstEnds(…)})` 自动给每串末发写 |
| cfg.spaceRule | 整张表没有 tail 字段时才用：**burstGap 必填**（秒，参考连射0.1–0.2、脚步0.3–0.5；大了吞尾音，小了每发都挂会糊），默认只在串尾挂；`edges:'both'`保留首发，throttle秒允许串中补尾音 |
| cue.muffle | `{amount∈[0,1], recover}`，**recover 必填**（秒，参考0.6–1.5；越长遮蔽后续信息越久）；截止频率=`20000·0.03^Z` |
| cue.bus | `main`默认经过闷音，`dry`绕过闷音；最终都经过master |
| cue.duck | `{depth∈[0,1], recover}`，depth为压到的线性增益，**recover 必填**（秒，参考0.2–0.4；短了配乐"泵"，长了配乐空掉）；多事件取最深压低 |
| cfg.music | 先读src生成out，不覆盖src；duck作用于整首配乐，muffle可选择跟随 |
| cfg.master | comp阈值dB/ratio/attack秒/release秒/knee dB/makeup dB，随后trim线性增益，最后clip软削波；默认全关闭。`comp:true` 用 -10dB/6:1/2ms/140ms、`clip:true` 用 knee 0.6：快攻重压缩，对白片里听得出，用时写具体数 |

IR室外为早反射+扫频变暗扩散尾巴+低频隆隆，室内另有驻波与颤动回声。默认长度1.55/2.3s。IR每声道单位能量，不保证卷积后的峰值。
Freeverb是共享房间送量，IR是单个事件的空间响应，两者叠加会加重混响。尾音延长sfx.wav，但mux按画面长度截取，要完整余韵就在片尾留时间。

事件duck在sfx脚本先处理配乐，合流用 `mux.sh --music out/music-sfx.wav`；mux的旁白sidechain继续乘在其上，两种闪避叠加可能过深（`mix.md`）。
不写music时只记录duck曲线并提示；muffle只作用于本次生成的音效和显式处理的配乐，不改旁白。

## 4. 程序接口

从 `runtime/sfx.mjs` 读 `SR/RECIPES/renderRecipe/expandRecipes/stats/makeIR/planTails/spaceKey/muffleCurve/duckCurve/applyMuffle`。
`renderRecipe(name,{params,variant,seed,pitch,jitter,jitterSeed})` 返回 `{samples,samplesR?,variant,seed,pitch,gain}`；输出有 NaN/Inf 直接抛错。
`renderCues(cues,opts)` 自动展开配方，`renderStereo(cues,{spaceRule,master,...})` 还处理空间和总线。
DSP低层在 `runtime/sfxdsp.mjs`：`noiseHit/glide/modal/chirp/grains/filter/sweep/softclip/dcBlock/loopXfade/convolve/convolveStereo/compress`。
DSP数组是48kHz mono Float32Array；filter/shape/softclip等原地修改，跨声部共享前先复制。

## 5. 代价与验证

原有7音色、单声道混音、等功率声像和Freeverb路径与扩展前逐样本相同。配方同一 Node 版本跨进程逐位相同，跨JS引擎不承诺最后一位相同。
尾音：同一IR、同一总线的干声先叠成一条，每组只卷一次（分块重叠相加，FFT ≤2^18，全零块跳过，IR频谱缓存），与逐 cue 卷积差在 float32 舍入（相对1.5e-7）。
`out/sfx.wav` 与处理后的配乐写32位浮点WAV（不在这里削顶，mux.sh 归一后才定电平）；输出有 NaN/Inf 一律退出1且不写文件。
时变滤波每32个样本更新系数；大幅快速扫频可能产生调制音，声音真实与否仍需人听。

```bash
node <film-narration>/scripts/sfx.mjs --film <slug> --stats
node <film-narration>/scripts/sfx.mjs --list-sounds
```

`--stats`报告峰值、过载数、NaN/Inf、直流、每0.5s RMS。它检查PCM，不能替代audiocheck对最终成片的真峰/响度检查。
回归在仓库 `tests/fixtures/_test-sfx/tests/`（unit 钉死各配方×变体的PCM，cli 跑事件表生成的 cues.json，measure.py 测频谱）。
只验证客观量；合成材质是否像实物、冲击是否悦耳、混响是否合适，尚未经过人耳评审。
