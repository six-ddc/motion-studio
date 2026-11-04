#!/usr/bin/env bash
# 自检：把成片变成"模型和人都能看的静态图"。
# 不跑这一步，模型只能瞎猜自己渲出了什么 —— 闭环就断在这儿。
#
# 用法: bash <film-critique>/scripts/contact.sh --film <slug> [--films-dir <dir>] [特写起点秒]
#       bash <film-critique>/scripts/contact.sh films/<slug>/out/<片>.mp4 [特写起点秒]
#       [--strip-cut K] [--hold portrait|landscape] [--view-width N]
#
# 帧率从 film.json 读（MP4 在 films/<slug>/out/ 下时；不在就用 MP4 自己的），和 MP4 实测不一致时警告。
# 特写条起点：给了秒数用秒数；否则对准 out/transitions.png.meta.json 里第 K 个转场窗口（transitions.mjs 产出）；
#   都没有退回 时长×35% 并明说（可能落在平台期，12 帧全同）。
# 手机图在图头写明观看宽度假设：默认竖持 360px（横版片按手机竖持全宽 360 判，与 check.mjs readability 同口径）；
#   style_guide critique 块写了 view_width 就用它；--hold landscape = 横持（横版片 720，竖版片按 360 高折算）。
# 每张产物旁写 <产物>.meta.json（源 MP4、场景指纹、帧率、观看宽度假设），review_log.mjs / fresh.mjs 据此判过期。
#
# `--film <slug>` 是全套 Agent 工具的统一接口（film-core references/api.md §8）。
# 这里它会挑 films/<slug>/out/ 下的成片，规则和 align.py 的 pick_source 一致：
# 只认 final-* 和 silent-*，**跳过 *-loop.mp4**（那是本脚本自己产出的、首尾相接连播两遍
# 的版本，时长翻倍；曾经有工具自动挑中它，然后把一支好片子报成 38 处硬错误）。
set -euo pipefail

usage() {
  cat <<'EOF_USAGE'
用法: contact.sh --film <slug> [--films-dir <dir>] [选项] [特写起点秒]
      contact.sh <mp4> [选项] [特写起点秒]

把成片变成静态图：接触表 / 特写条 / 手机宽缩略 / 首尾相接连播 / 海报帧，产物写在 mp4 旁边。

参数：
  --film <slug>       挑 films/<slug>/out/ 下的成片（final-* 优先，其次 silent-*，跳过 *-loop.mp4）
  --films-dir <dir>   films/ 目录；不给时依次查 $FILMS_DIR、从 cwd 往上找含 films/ 的目录
  <mp4>               直接给成片路径
  [特写起点秒]         特写条从第几秒起（默认对准转场窗口，见 --strip-cut；没有转场信息时 时长×0.35）
  --strip-cut <K>     特写条对准 out/transitions.png.meta.json 的第 K 个窗口（默认 1；先跑 transitions.mjs）
  --hold <h>          手机图的观看假设：portrait（默认，竖持，宽 360）| landscape（横持，横版片 720）
  --view-width <N>    直接给手机图宽度（覆盖 --hold 与 style_guide view_width）
  -h, --help          打印本帮助后退出（不做任何事）
EOF_USAGE
}
bad() { echo "✗ $1" >&2; echo "  用 --help 查看参数表" >&2; exit 2; }

# films/ 的位置：--films-dir > $FILMS_DIR > 从 cwd 往上找含 films/ 的目录。不在 bash 里另写一份：调 film-core 的 lib/env.mjs。
# 不按脚本自己的位置推：skill 装到 ~/.claude/skills/ 后那会指到 ~/.claude/films。
CORE_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../film-core/lib" && pwd)/env.mjs"
find_films_dir() {
  node --input-type=module -e 'const { locateFilmsDir } = await import(process.argv[1]); process.stdout.write(locateFilmsDir(process.argv[2] || null) ?? "");' \
    "$CORE_ENV" "${FILMS_DIR_ARG:-}"
}

SLUG=""; FILMS_DIR_ARG=""; POS=(); STRIP_CUT=""; HOLD=""; VIEW_W="" 
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0;;
    --film) [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || bad "--film 需要一个值 <slug>"; SLUG="$2"; shift 2;;
    --films-dir) [ $# -ge 2 ] && [ "${2#--}" = "$2" ] || bad "--films-dir 需要一个值 <dir>"; FILMS_DIR_ARG="$2"; shift 2;;
    --strip-cut) [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || bad "--strip-cut 需要一个正整数 <K>"; STRIP_CUT="$2"; shift 2;;
    --hold) [ $# -ge 2 ] && { [ "$2" = portrait ] || [ "$2" = landscape ]; } || bad "--hold 只收 portrait / landscape"; HOLD="$2"; shift 2;;
    --view-width) [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || bad "--view-width 需要一个正整数 <N>"; VIEW_W="$2"; shift 2;;
    --*|-?*) case "$1" in -[0-9]*|-.[0-9]*) POS+=("$1"); shift;; *) bad "未知参数 $1";; esac;;
    *) POS+=("$1"); shift;;
  esac
done

if [ -n "$SLUG" ]; then
  [ ${#POS[@]} -le 1 ] || bad "多余的参数 ${POS[*]}（--film 之外只收一个特写起点秒）"
  STRIP_ARG="${POS[0]:-}"
  FD="$(find_films_dir)"
  [ -n "$FD" ] || { echo "✗ 从 $(pwd) 往上找不到 films/ 目录。在含 films/ 的目录下运行，或用 --films-dir / \$FILMS_DIR 指定" >&2; exit 1; }
  OUT="$FD/$SLUG/out"
  [ -d "$OUT" ] || { echo "✗ 找不到 $OUT —— slug 写对了吗？（films 目录：$FD）" >&2; exit 1; }
  # 正向匹配 + 排除本脚本的派生品，优先成片
  SRC=""
  for pat in "final-*.mp4" "silent-*.mp4"; do
    for f in "$OUT"/$pat; do
      case "$f" in *-loop.mp4) continue;; esac
      [ -f "$f" ] && { SRC="$f"; break; }
    done
    [ -n "$SRC" ] && break
  done
  [ -n "$SRC" ] || { echo "✗ $OUT 下没有 final-*.mp4 或 silent-*.mp4，先用 film-core 的 render.mjs 出 MP4" >&2; exit 1; }
  echo "--film $SLUG -> $SRC"
else
  [ ${#POS[@]} -ge 1 ] || { usage >&2; exit 2; }
  [ ${#POS[@]} -le 2 ] || bad "多余的参数 ${POS[*]:2}"
  [ -z "$FILMS_DIR_ARG" ] || bad "--films-dir 只和 --film 一起用"
  SRC="${POS[0]}"
  STRIP_ARG="${POS[1]:-}"
fi
[ -f "$SRC" ] || { echo "找不到 $SRC，先用 film-core 的 render.mjs 出 MP4" >&2; exit 1; }
# 产物落在源文件旁边，跟着项目走
OUTDIR="$(cd "$(dirname "$SRC")" && pwd)"
BASE="$OUTDIR/$(basename "${SRC%.*}")"
Q=(-hide_banner -loglevel error -y)

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC")

# ---- 片子信息：一次 node 调用读齐（film.json fps/尺寸、style_guide view_width、转场 meta），不在 bash 里另写解析 ----
# MP4 在 <films>/<slug>/out/ 下就认那部片；否则只有 MP4 自己的信息。
FILM_DIR=""
if [ -n "$SLUG" ]; then FILM_DIR="$FD/$SLUG"; elif [ -f "$(dirname "$OUTDIR")/film.json" ]; then FILM_DIR="$(dirname "$OUTDIR")"; fi
MP4_FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 "$SRC" | awk -F/ '{ if ($2 > 0) printf "%.4f", $1/$2; else print $1 }')
read -r FILM_FPS VW VW_WHY STRIP_AT STRIP_WHY < <(
  node --input-type=module -e '
    const [dir, outdir, dur, mp4fps, stripArg, stripCut, hold, vwArg] = process.argv.slice(1);
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const S = (x) => String(x).replace(/\s+/g, "_");
    let fps = +mp4fps, W = null, H = null, vwSG = null;
    if (dir) {
      const cfg = JSON.parse(readFileSync(join(dir, "film.json"), "utf8"));
      if (cfg.fps > 0) fps = cfg.fps;
      const m = /^(\d+)x(\d+)$/.exec(cfg.format ?? ""); if (m) { W = +m[1]; H = +m[2]; }
      const sg = join(dir, "docs/style_guide.md");
      if (existsSync(sg)) { const b = /```(?:json\s+)?critique\s*\n([\s\S]*?)```/.exec(readFileSync(sg, "utf8")); try { vwSG = b ? JSON.parse(b[1]).view_width ?? null : null; } catch {} }
    }
    // 观看宽度假设
    let vw, why;
    const land = W && H ? W > H : null;
    if (vwArg) { vw = +vwArg; why = `--view-width_${vw}`; }
    else if (hold === "landscape") { vw = land === false ? Math.round(360 * W / H) : 720; why = "--hold_landscape（横持）"; }
    else if (hold === "portrait") { vw = 360; why = "--hold_portrait（竖持）"; }
    else if (vwSG) { vw = vwSG; why = `style_guide_view_width=${vwSG}`; }
    else { vw = 360; why = "默认竖持_360（横版片也按手机竖持全宽判，同_check.mjs）"; }
    // 特写条起点：秒数 > 转场 meta 第 K 个窗口 > 35%
    let at, swhy;
    const D = +dur, metaP = join(outdir, "transitions.png.meta.json");
    if (stripArg) { at = +stripArg; swhy = "手给秒数"; }
    else if (existsSync(metaP)) {
      let meta = null; try { meta = JSON.parse(readFileSync(metaP, "utf8")); } catch {}
      const ws = meta?.windows ?? [], k = +(stripCut || 1);
      if (ws.length >= k) { const w = ws[k - 1], c = (w.t0 + w.t1) / 2; at = c - 6 / fps; swhy = `对准转场#${k}/${ws.length}（${w.kind}_${w.t0.toFixed(2)}–${w.t1.toFixed(2)}s，来源_${S(meta.source)}）`; }
      else if (ws.length) { at = D * 0.35; swhy = `--strip-cut_${k}_超出窗口数_${ws.length}，退回时长×35%`; }
      else { at = D * 0.35; swhy = "transitions_meta_里没有剪辑点（场景没声明），退回时长×35%，可能落在平台期"; }
    } else { at = D * 0.35; swhy = "没有_out/transitions.png.meta.json（先跑_transitions.mjs），退回时长×35%，可能落在平台期"; }
    at = Math.max(0, Math.min(at, D - 12 / fps));
    at = Math.round(at * fps) / fps;                                    // 对齐成片帧格
    process.stdout.write(`${fps} ${vw} ${S(why)} ${at.toFixed(4)} ${S(swhy)}\n`);
  ' "$FILM_DIR" "$OUTDIR" "$DUR" "$MP4_FPS" "${STRIP_ARG:-}" "$STRIP_CUT" "$HOLD" "$VIEW_W"
)
if awk -v a="$FILM_FPS" -v b="$MP4_FPS" 'BEGIN{ d=a-b; if (d<0) d=-d; exit !(d>0.01) }'; then
  echo "⚠ film.json fps=$FILM_FPS 与 MP4 实测 ${MP4_FPS}fps 不一致：成片可能不是按现在的 film.json 渲的。帧号按 film.json 标" >&2
fi

# 抽帧密度按时长自适应：目标 ~30 张缩略图，短片才不会铺出一堆黑格。
# 5 秒片 -> 6fps；60 秒片 -> 0.5fps。（这是接触表的抽帧率，不是片子帧率）
read -r CFPS COLS ROWS < <(
  awk -v d="$DUR" 'BEGIN{
    target=30;
    fps=target/d; if(fps>10)fps=10; if(fps<0.25)fps=0.25;
    n=int(d*fps+0.5); if(n<1)n=1;
    cols=6; if(n<6)cols=n;
    rows=int((n+cols-1)/cols); if(rows<1)rows=1;
    printf "%.4f %d %d\n", fps, cols, rows;
  }'
)
K0=$(awk -v a="$STRIP_AT" -v f="$FILM_FPS" 'BEGIN{ printf "%d", a*f+0.5 }')

echo "源: $SRC   时长 ${DUR}s   片子 ${FILM_FPS}fps   接触表 ${COLS}x${ROWS} @ ${CFPS}fps"
echo "特写条: 起点 ${STRIP_AT}s（f${K0}）—— ${STRIP_WHY//_/ }"
echo "手机图: 宽 ${VW}px —— ${VW_WHY//_/ }"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames,pix_fmt \
  -show_entries format=duration,size -of default=noprint_wrappers=1 "$SRC"
echo

# 1) 总览接触表 —— 看整体节奏、变化密度、有没有死拍
ffmpeg "${Q[@]}" -i "$SRC" -vf "fps=${CFPS},scale=270:-1,tile=${COLS}x${ROWS}" \
  -frames:v 1 "${BASE}-contact.png"

# 2) 特写条：从起点连续 12 帧（MP4 的帧）—— 抓文字重叠、单帧跳、转场中间态。每格标时刻（毫秒，按 MP4 帧率算）和对应的 film.json 帧号
ffmpeg "${Q[@]}" -ss "$STRIP_AT" -i "$SRC" -vf "scale=320:-2,drawtext=text='f%{eif\:(${STRIP_AT}+n/${MP4_FPS})*${FILM_FPS}+0.5\:d} %{eif\:(${STRIP_AT}+n/${MP4_FPS})*1000+0.5\:d}ms':x=6:y=h-th-6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3,tile=12x1" \
  -frames:v 1 "${BASE}-strip.png"

# 3) 手机尺寸：每秒一帧缩到观看宽度 —— 这个宽度读不出来的字就是没做对。图头写明观看宽度假设（ASCII：drawtext 没有可靠的中文字体）
PHONE_ROWS=$(awk -v d="$DUR" 'BEGIN{n=int(d+0.5); if(n<1)n=1; r=int((n+4)/5); if(r<1)r=1; print r}')
case "$VW_WHY" in --view-width*) HOLD_EN="--view-width";; --hold_landscape*) HOLD_EN="landscape hold (--hold landscape)";; --hold_portrait*) HOLD_EN="portrait hold (--hold portrait)";; style_guide*) HOLD_EN="style_guide view_width";; *) HOLD_EN="portrait hold (default; landscape films judged at 360 wide, same as check.mjs)";; esac
ffmpeg "${Q[@]}" -i "$SRC" -vf "fps=1,scale=${VW}:-2,tile=5x${PHONE_ROWS},pad=iw:ih+44:0:44:color=0x202020,drawtext=text='VIEW WIDTH ${VW}px - ${HOLD_EN} - 1 frame/s':x=10:y=12:fontsize=20:fontcolor=white" \
  -frames:v 1 "${BASE}-phone.png"

# 4) 接缝检查：首尾相接播两遍 —— 循环卡顿一眼可见
ffmpeg "${Q[@]}" -stream_loop 1 -i "$SRC" -c copy "${BASE}-loop.mp4"

# 5) 海报帧
ffmpeg "${Q[@]}" -ss "$(awk -v d="$DUR" 'BEGIN{printf "%.3f", d*0.12}')" \
  -i "$SRC" -frames:v 1 "${BASE}-poster.png"

# 6) 新鲜度 meta：每张图旁一份（源 MP4 大小/mtime、场景指纹、本图的假设）
FRESH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_fresh.mjs"
node --input-type=module -e '
  const [fresh, base, mp4, dir, fps, mp4fps, vw, vwWhy, at, k0, sWhy] = process.argv.slice(1);
  const { writeMeta } = await import(fresh);
  const u = (s) => s.replace(/_/g, " ");
  const common = { tool: "contact", dir: dir || null, mp4, extra: { fps: +fps, mp4Fps: +mp4fps } };
  const w = (suf, extra) => writeMeta(`${base}-${suf}.png`, { ...common, extra: { ...common.extra, ...extra } });
  w("contact", {});
  w("strip", { strip: { start: +at, frame: +k0, frames: 12, why: u(sWhy) } });
  w("phone", { view: { width: +vw, why: u(vwWhy) } });
  w("poster", {});
' "$FRESH" "$BASE" "$OUTDIR/$(basename "$SRC")" "$FILM_DIR" "$FILM_FPS" "$MP4_FPS" "$VW" "$VW_WHY" "$STRIP_AT" "$K0" "$STRIP_WHY"

echo "产出："
ls -lh "${BASE}"-*.png "${BASE}-loop.mp4" | awk '{print "  " $9 "  " $5}'
echo
echo "下一步：真的打开 contact / strip / phone 三张图看，然后按 film-critique SKILL.md 的三层评判填 review_log"
