#!/usr/bin/env bash
# 音画合流 + 响度归一（两遍 loudnorm）。视频流 -c:v copy 不重编码。
#
# 用法（任意 cwd）:
#   bash mux.sh --film <slug> [--video out/silent-9x16.mp4] [--vo out/vo.wav] [--sfx out/sfx.wav]
#               [--music assets/music.wav] [--music-gain -18] [--duck 1] [--lufs -14] [--limit auto|<dBFS>] [--lra 11]
#               [--out out/final-9x16.mp4] [--films-dir <dir>]
#   films/：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录；--film 也可以直接给片子目录路径。
#
# 默认：--video 取 out/silent-<film.json format>.mp4（只正向匹配，不通配）；--vo out/vo.wav；--sfx 存在就混；--music 不给就没有。
# 片头留白：读 film.json 的 narrationOffset（秒），旁白 adelay 这么多；音效 out/sfx.wav 已经是成片时间，不再延迟。
#   偏移链路（分镜 / 场景运行时 / 音效）有一环对不上就报错退出，不静默合流（见 _offset.py offset_links）。
# --limit：loudnorm 前先过 alimiter，把峰值压到能让第二遍保持线性的位置。auto = 按第一遍实测算
#   （天花板 = -1.5 dBTP − 所需增益 − 0.5 dB 余量；alimiter 只看采样峰值、不看 true peak，余量就是补这个的）；
#   给数字 = 直接用这个 dBFS 当天花板。
# 线性归一有**两个**前提，缺一个 ffmpeg 就退回动态模式（实测，ffmpeg 8.0）：
#   (1) 所需增益 + 实测 true peak ≤ -1.5 dBTP  → 不满足用 --limit
#   (2) 实测 LRA ≤ 目标 LRA（--lra，默认 11）   → 不满足就调高 --lra，或接受动态模式
#   ghost-jam 两条都不满足（TP 余量差 2.0 dB，输入 LRA 15.4 > 11），只加 --limit 仍是 dynamic。
# **旁白片慎用 --limit：它会压掉人声细节，代价能大到让念读核验直接红。** ghost-jam 实测，
#   两组各复现两次（同一段音频 Whisper 是确定的，差异只来自混音）：
#     --lufs -14 --lra 16              → dynamic、TP -1.0 dBTP、`align --verify` **98.9%** ✓
#     --lufs -14 --lra 16 --limit auto → linear、TP -1.4 dBTP、`align --verify` **96.7%** ✗（阈值 97%）
#   即：用 **2.2 个百分点的念读准确率**换 **0.4 dB 的峰值余量**。多出来的错是 `事故→试过`、漏「的」。
#   而 -1.0 dBTP 本来就满足常见发布规范（YouTube/Spotify 的天花板就是 -1.0），
#   -1.5 只是本套件更紧的内部目标。所以下面第一遍测完后、线性条件不满足时打印的那条"……或加 --limit auto"提示（true peak 一项），
#   **在旁白片上是个陷阱**：加完一定要重跑 `align.py --verify`，别只看峰值数字变好了。
# 成片 true peak 闸门（weiqi-intro：动态模式下成片 -0.5 dBTP，高于 -1.5 目标却没标红）：
#   合流后按交付的 mp4（AAC 解码后）用 loudnorm 实测 true peak（两位小数；ebur128 只给一位，-1.01 会显示成 -1.0）。
#   > -1.0 dBTP  ✗ 退出 5：超过常见发布规范的天花板（YouTube / Spotify 都是 -1.0），平台转码后会削顶。文件照写，供对比
#   > -1.5 dBTP  ⚠ 只警告：满足发布规范，但没达到本套件 -1.5 的内部目标
#   修法优先降 --lufs（脚本会算出保持线性的上限）；--limit auto 在旁白片上会压坏人声（见上），加了必须重跑 --verify。
#   align.py --verify 对成片做同一道检查（deliver / accept --deep 的 verify 门因此也会红）。
# 合流记录：成功写出后记 out/.render/<输出名>.mux.json（film-core references/api.md「合流记录」）——输入文件与成片的 sha256、
#   片头偏移、重放用的参数。film-core 凭它判成片是不是本次渲染合出来的（不是就不拿它过门），deliver 定稿渲染后按它重放本脚本。
# 无旁白片：没给 --vo 且没有 out/vo.wav 时不再退出，直接用音效 / 配乐合流（--vo 显式给了却不存在仍然报错）。
#   没有人声就没有闪避的触发源，--duck 不起作用（会打一行说明）；合流后的下一步提示也不再指向 align.py --verify。
#   有 out/vo.wav 的片子（包括用静音 vo.wav 占位的，如 tencent-5y）走原路径，滤镜图一字不变。
# --duck 1：人声起处用 sidechaincompress 压低配乐（实测有旁白时比 --duck 0 低 9.6 dB，停顿里完全恢复，见仓库 docs/verified/film-narration.md）。--lufs 是目标响度，按发布平台定（常见 -14）。
set -euo pipefail
die() { echo "✗ $*" >&2; exit 1; }

usage() {
  cat <<'EOF_USAGE'
用法: bash mux.sh --film <slug> [选项]

音画合流 + 响度归一（两遍 loudnorm），视频流不重编码。产出默认 out/final-<format>.mp4。

参数：
  --film <slug|目录>     片子（films/<slug>/，或直接给片子目录）；只有一部时可省略
  --films-dir <dir>      films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录
  --video <mp4>          无声成片（默认 out/silent-<film.json format>.mp4）
  --vo <wav>             旁白（默认 out/vo.wav；没有就按无旁白片合流）
  --sfx <wav>            音效（默认 out/sfx.wav 存在就混）
  --music <file>         配乐（不给就没有）
  --music-gain <dB>      配乐增益（默认 -18）
  --duck <0|1>           人声起处压低配乐（默认 1）
  --lufs <LUFS>          目标响度（默认 -14）
  --limit <auto|dBFS>    loudnorm 前先过 alimiter（旁白片慎用，见文件头注释）
  --lra <LU>             目标 LRA（默认 11）
  --out <mp4>            输出（默认 out/final-<format>.mp4）
  -h, --help             打印本帮助后退出（不做任何事）

退出码：0 成功；1 前置条件缺失 / 偏移链路没接住；2 用法错；5 成片 true peak > -1.0 dBTP。
EOF_USAGE
}
bad() { echo "✗ $*" >&2; echo "  用 --help 查看参数表" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 重放参数：原样记下除 --film / --films-dir 以外的参数（相对路径都相对片子目录，本脚本会 cd 进去）
REPLAY=(); _a=("$@"); _i=0
while [ $_i -lt ${#_a[@]} ]; do
  case "${_a[$_i]}" in --film|--films-dir) _i=$((_i+2));; *) REPLAY+=("${_a[$_i]}"); _i=$((_i+1));; esac
done
FILM="" VIDEO="" VO="" SFX="" MUSIC="" MUSIC_GAIN="-18" DUCK=1 LUFS="-14" OUT="" LIMIT="" LRA="11" FILMS_DIR_ARG=""
need() { [ $# -ge 2 ] && { [ "${2#--}" = "$2" ] || [ "${2#-[0-9]}" != "$2" ]; } || bad "$1 需要一个值"; }
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0;;
  esac
  case "$1" in
    --film|--video|--vo|--sfx|--music|--music-gain|--duck|--lufs|--out|--limit|--lra|--films-dir) need "$@";;
  esac
  case "$1" in
    --film) FILM="$2"; shift 2;; --video) VIDEO="$2"; shift 2;; --vo) VO="$2"; shift 2;;
    --sfx) SFX="$2"; shift 2;; --music) MUSIC="$2"; shift 2;; --music-gain) MUSIC_GAIN="$2"; shift 2;;
    --duck) DUCK="$2"; shift 2;; --lufs) LUFS="$2"; shift 2;; --out) OUT="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;; --lra) LRA="$2"; shift 2;; --films-dir) FILMS_DIR_ARG="$2"; shift 2;;
    *) bad "未知参数 $1";;
  esac
done

# 解析片子目录：与全套件同一份实现（film-core lib/film.py：--films-dir > $FILMS_DIR > 从 cwd 往上找）
CORE_LIB="$HERE/../../film-core/lib"
[ -f "$CORE_LIB/film.py" ] || die "缺能力 film-core：找不到 $CORE_LIB/film.py（film-* skill 要装在同一层）"
F="$("${PYTHON:-python3}" -c 'import sys; sys.path.insert(0, sys.argv[1]); import film; print(film.resolve_film(sys.argv[2] or None, sys.argv[3] or None))' "$CORE_LIB" "$FILM" "$FILMS_DIR_ARG")" || exit $?
cd "$F"

# 自动挑只正向匹配 silent-<film.json 的 format>.mp4 / silent-<格式>.mp4 / silent.mp4，
# 不用 silent*.mp4 通配——同目录可能有别的 skill 产出的派生品（*-loop.mp4 等）
if [ -z "$VIDEO" ]; then
  FMT="$(sed -n 's/.*"format" *: *"\([^"]*\)".*/\1/p' film.json 2>/dev/null | head -1)"
  for c in ${FMT:+out/silent-$FMT.mp4} out/silent-9x16.mp4 out/silent-16x9.mp4 out/silent-1x1.mp4 out/silent.mp4; do
    [ -f "$c" ] && { VIDEO="$c"; break; }
  done
fi
[ -n "$VIDEO" ] && [ -f "$VIDEO" ] || die "找不到无声成片 out/silent*.mp4（先用 film-core 的 render.mjs 渲染），或 --video 指定"
if [ -n "$VO" ]; then [ -f "$VO" ] || die "找不到旁白 ${VO}（--vo 指定的）"
elif [ -f out/vo.wav ]; then VO=out/vo.wav
else VO=""; fi      # 无旁白片
[ -n "$SFX" ] || { [ -f out/sfx.wav ] && SFX=out/sfx.wav || true; }
[ -n "$VO$SFX$MUSIC" ] || die "没有旁白 out/vo.wav、音效 out/sfx.wav，也没给 --music：没有可合流的音频（有旁白的片子先跑 tts.py）"
[ -n "$OUT" ] || OUT="out/final-$(basename "${VIDEO%.*}" | sed 's/^silent-\{0,1\}//').mp4"
[ "$OUT" = "out/final-.mp4" ] && OUT="out/final.mp4"

# 混音长度以视频为准。旧版用 amix duration=first（跟旁白走）：旁白一结束配乐和音效就被截掉，
# 片尾只剩第 3 步 apad 补的数字静音（实测 demo-tls 的旁白 9.52s / 视频 10.43s，片尾 0.91s 配乐 -240 dBFS）。
# 现在给旁白 apad 补到无限长，混音输出用 -t 截到视频时长；响度也就按交付的那一段测。
VDUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")"
[ -n "$VDUR" ] || die "ffprobe 读不出 $VIDEO 的时长"

# 片头留白：唯一真相源 film.json narrationOffset。顺带查分镜/场景运行时/音效三环是否按同一个数
OFF="$("${PYTHON:-python3}" "$HERE/_offset.py" "$F" ${SFX:+--sfx "$SFX"})" \
  || die "片头留白 narrationOffset 有一环没接住（见上），不合流——否则画面和声音会差这么多秒，而且后面的检查都不报"
if [ -n "$VO" ]; then
VODUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VO")"
awk -v o="$OFF" -v a="$VODUR" -v v="$VDUR" 'BEGIN{exit !(o + a > v + 0.05)}' && \
  echo "⚠ 旁白偏移 ${OFF}s + 旁白 ${VODUR}s 超过视频 ${VDUR}s：结尾会被截掉" >&2
fi
OFF_MS="$(awk -v o="$OFF" 'BEGIN{printf "%d", o * 1000 + 0.5}')"

# 第 1 步：只混音频（不带视频，输入下标从 0 起）
if [ -n "$VO" ]; then
inputs=(-i "$VO"); n=1; count=1
DELAY=""; [ "$OFF_MS" -gt 0 ] && DELAY=",adelay=delays=${OFF_MS}:all=1"
graph="[0:a]aformat=sample_rates=48000:channel_layouts=stereo${DELAY},apad[vo0];"
mixin=""
if [ -n "$MUSIC" ] && [ "$DUCK" = "1" ]; then graph+="[vo0]asplit=2[vo][vokey];"; else graph+="[vo0]anull[vo];"; fi
mixin="[vo]"
if [ -n "$SFX" ]; then
  [ -f "$SFX" ] || die "找不到音效 $SFX"
  inputs+=(-i "$SFX"); graph+="[$n:a]aformat=sample_rates=48000:channel_layouts=stereo[sfx];"
  mixin+="[sfx]"; n=$((n+1)); count=$((count+1))
fi
if [ -n "$MUSIC" ]; then
  [ -f "$MUSIC" ] || die "找不到配乐 $MUSIC"
  inputs+=(-i "$MUSIC")
  graph+="[$n:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${MUSIC_GAIN}dB[m0];"
  if [ "$DUCK" = "1" ]; then
    graph+="[m0][vokey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[mus];"
  else graph+="[m0]anull[mus];"; fi
  mixin+="[mus]"; count=$((count+1))
fi
# normalize=0：amix 默认按输入数等比压低电平，会把旁白也砍掉
graph+="${mixin}amix=inputs=${count}:duration=first:normalize=0[mix]"
else
  # 无旁白：每路 apad 补到无限长，-t 截到视频时长（与有旁白时"旁白 apad + duration=first"等价）。没有人声，闪避不适用
  inputs=(); n=0; count=0; graph=""; mixin=""
  [ -n "$MUSIC" ] && [ "$DUCK" = "1" ] && echo "  无旁白：--duck 没有触发源（闪避跟人声走），配乐按 --music-gain 恒定电平" >&2
  if [ -n "$SFX" ]; then
    [ -f "$SFX" ] || die "找不到音效 $SFX"
    inputs+=(-i "$SFX"); graph+="[$n:a]aformat=sample_rates=48000:channel_layouts=stereo,apad[sfx];"
    mixin+="[sfx]"; n=$((n+1)); count=$((count+1))
  fi
  if [ -n "$MUSIC" ]; then
    [ -f "$MUSIC" ] || die "找不到配乐 $MUSIC"
    inputs+=(-i "$MUSIC"); graph+="[$n:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${MUSIC_GAIN}dB,apad[mus];"
    mixin+="[mus]"; n=$((n+1)); count=$((count+1))
  fi
  if [ "$count" -eq 1 ]; then graph+="${mixin}anull[mix]"
  else graph+="${mixin}amix=inputs=${count}:duration=first:normalize=0[mix]"; fi
fi
TMP="out/_mux"; mkdir -p "$TMP"
ffmpeg -hide_banner -loglevel error -y "${inputs[@]}" -filter_complex "$graph" -map "[mix]" \
  -t "$VDUR" -c:a pcm_s24le "$TMP/mix.wav" || die "混音失败（filter: $graph）"

# 第 2 步：两遍 loudnorm。第一遍测，第二遍请求线性归一（linear=true，整段一个增益，不会「抽」）。
# 但 linear 只在「需要的增益 + 实测 true peak ≤ TP 上限」时成立；不成立时 ffmpeg 会**自动退回动态模式**
# （逐段变增益，会压动态）。实测 demo-tls：要 +6.4 dB、true peak 只有 5.3 dB 余量 → 退回 dynamic。
# 所以第二遍要把 normalization_type 读回来报出来，不能假设是线性。
measure() { ffmpeg -hide_banner -nostats -i "$1" -af "loudnorm=I=$LUFS:TP=-1.5:LRA=$LRA:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p'; }
M="$(measure "$TMP/mix.wav")"
val() { echo "$M" | sed -n "s/.*\"$1\" : \"\(.*\)\".*/\1/p"; }
[ -n "$(val input_i)" ] || die "loudnorm 第一遍没测出数值"
PRE_I="$(val input_i)" PRE_TP="$(val input_tp)" LIMIT_NOTE=""
if [ -n "$LIMIT" ]; then
  if [ "$LIMIT" = "auto" ]; then
    CEIL="$(awk -v t="$LUFS" -v i="$PRE_I" 'BEGIN{printf "%.2f", -1.5 - (t - i) - 0.5}')"
  else
    CEIL="$LIMIT"
  fi
  if awk -v c="$CEIL" -v p="$PRE_TP" 'BEGIN{exit !(c >= p)}'; then
    LIMIT_NOTE="限幅：天花板 ${CEIL} dBFS ≥ 实测峰值 ${PRE_TP} dBTP，不需要限幅"
  else
    LIN="$(awk -v c="$CEIL" 'BEGIN{x = exp(c / 20 * log(10)); if (x < 0.0625) x = 0.0625; printf "%.5f", x}')"
    ffmpeg -hide_banner -loglevel error -y -i "$TMP/mix.wav" \
      -af "alimiter=limit=$LIN:level=false:attack=5:release=50" -c:a pcm_s24le "$TMP/mix_lim.wav" || die "限幅失败"
    mv "$TMP/mix_lim.wav" "$TMP/mix.wav"
    M="$(measure "$TMP/mix.wav")"
    LIMIT_NOTE="限幅：天花板 ${CEIL} dBFS（alimiter limit=${LIN}），峰值 ${PRE_TP} -> $(val input_tp) dBTP，响度 ${PRE_I} -> $(val input_i) LUFS"
  fi
fi
M2="$(ffmpeg -hide_banner -nostats -y -i "$TMP/mix.wav" -af \
  "loudnorm=I=$LUFS:TP=-1.5:LRA=$LRA:measured_I=$(val input_i):measured_TP=$(val input_tp):measured_LRA=$(val input_lra):measured_thresh=$(val input_thresh):offset=$(val target_offset):linear=true:print_format=json" \
  -ar 48000 "$TMP/norm.wav" 2>&1 | sed -n '/^{/,/^}/p')" || die "loudnorm 第二遍失败"
NORM_TYPE="$(echo "$M2" | sed -n 's/.*"normalization_type" : "\(.*\)".*/\1/p')"

# 第 3 步：合流。以视频时长为准（-t），音频短了自动补静音
ffmpeg -hide_banner -loglevel error -y -i "$VIDEO" -i "$TMP/norm.wav" \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -af apad -t "$VDUR" -movflags +faststart "$OUT"
rm -rf "$TMP"

# 合流记录（见文件头）。true peak 超标（退出 5）也照写：成片确实是这些输入合出来的，过不过门另说
"${PYTHON:-python3}" - "$OUT" "$OFF" "$VIDEO" "$VO" "$SFX" "$MUSIC" ${REPLAY[@]+"${REPLAY[@]}"} <<'PY' || die "写合流记录失败"
import hashlib, json, os, sys, time
out, off, video, vo, sfx, music, *args = sys.argv[1:]
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
inputs = {role: {"path": p, "sha256": sha(p)} for role, p in (("video", video), ("vo", vo), ("sfx", sfx), ("music", music)) if p}
name = os.path.splitext(os.path.basename(out))[0]
os.makedirs("out/.render", exist_ok=True)
rec = {"schema": 1, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "skill": "film-narration", "script": "scripts/mux.sh",
       "args": args, "narrationOffset": float(off), "inputs": inputs, "output": {"path": out, "sha256": sha(out)}}
json.dump(rec, open(f"out/.render/{name}.mux.json", "w"), ensure_ascii=False, indent=1)
PY

if [ -n "$VO" ]; then
echo "✓ $OUT   视频 ${VDUR}s   旁白 ${VO}（片头偏移 +${OFF}s，film.json narrationOffset）${SFX:+ + $SFX}${MUSIC:+ + $MUSIC(${MUSIC_GAIN}dB, duck=$DUCK)}"
else
echo "✓ $OUT   视频 ${VDUR}s   无旁白   ${SFX:+$SFX}${SFX:+${MUSIC:+ + }}${MUSIC:+$MUSIC(${MUSIC_GAIN}dB)}"
fi
echo "  混音前响度 ${PRE_I} LUFS（true peak ${PRE_TP} dBTP）-> 目标 $LUFS   归一模式 ${NORM_TYPE:-未知}"
[ -n "$LIMIT_NOTE" ] && echo "  $LIMIT_NOTE"
if [ "$NORM_TYPE" = "dynamic" ]; then
  echo "  ⚠ loudnorm 退回了动态模式：整段不是单一增益，动态被压了。原因（按 loudnorm 第二遍用的实测值）：" >&2
  awk -v t="$LUFS" -v i="$(val input_i)" -v p="$(val input_tp)" 'BEGIN{x = (t - i) + p; if (x > -1.5)
    printf "    - true peak：要 %+.1f dB，峰值会到 %.1f dBTP > -1.5。降低 --lufs（≤ %.1f 能保持线性），或加 --limit auto\n", t - i, x, i - 1.5 - p
    printf "      （旁白片：--limit 会压人声，ghost-jam 实测让 align --verify 从 98.9%% 掉到 96.7%%。加了就重跑 --verify）\n"}' >&2
  awk -v l="$(val input_lra)" -v L="$LRA" 'BEGIN{if (l > L)
    printf "    - LRA：输入 %.1f LU > 目标 %s LU。调高 --lra（≥ %.0f），或接受动态模式\n", l, L, l + 0.5}' >&2
  echo "    接受动态模式就忽略这条。" >&2
fi
ffmpeg -hide_banner -nostats -i "$OUT" -af ebur128=peak=true:framelog=quiet -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | sed "s/^ */  实测 /; s/Peak:\(.*\)dBFS/True peak:\1dBTP/"
# 成片 true peak 闸门（见文件头）。量的是交付的那个文件，不是 loudnorm 的内部估计
FINAL_TP="$(ffmpeg -hide_banner -nostats -i "$OUT" -af loudnorm=print_format=json -f null - 2>&1 | sed -n 's/.*"input_tp" : "\(.*\)".*/\1/p')"
TP_RC=0
if [ -z "$FINAL_TP" ]; then
  echo "✗ 量不出成片的 true peak（loudnorm 没输出），没法判是否超标" >&2; TP_RC=5
elif awk -v p="$FINAL_TP" 'BEGIN{exit !(p > -1.0)}'; then
  echo "✗ 成片 true peak ${FINAL_TP} dBTP > -1.0：超过常见发布规范的天花板（YouTube / Spotify 都是 -1.0 dBTP），平台转码后会削顶。" >&2
  echo "    修法：降 --lufs（上面给了保持线性的上限；动态模式下也按它降），重跑后再跑 align.py --verify。" >&2
  echo "    旁白片不要先上 --limit auto：它会压坏人声（ghost-jam 实测 --verify 98.9% → 96.7%）。$OUT 已写出，仅供对比，不能交付" >&2
  TP_RC=5
elif awk -v p="$FINAL_TP" 'BEGIN{exit !(p > -1.5)}'; then
  echo "  ⚠ 成片 true peak ${FINAL_TP} dBTP：满足发布规范（≤ -1.0），但高于本套件 -1.5 的目标。降 --lufs 可以收回余量" >&2
else
  echo "  成片 true peak ${FINAL_TP} dBTP（≤ -1.5 ✓）"
fi
[ -n "$VO" ] && echo "  下一步：python align.py --film $(basename "$F") --verify $OUT"
exit $TP_RC
