# render.mjs / seamcheck.mjs / preview.mjs 参数与渲染细节

目录：render.mjs 参数 · seamcheck.mjs · preview.mjs · lib/browser.mjs · 渲染细节（小样/并行/缓存/自适应子帧）· 渲染器钉版本 · 渲染后端（软件/硬件 GPU）

所有脚本任意 cwd 可调，按 `--films-dir` > `$FILMS_DIR` > 向上找 `films/` 定位；只有一部片子时可省 `--film`。命令行参数优先于 `film.json`。

## render.mjs

| 参数 | 默认 | 说明 |
|---|---|---|
| `--film <slug>` | 唯一那部 | 影片 |
| `--format <key>` / `--all` | film.json `format` | `9x16` / `1x1` / `16x9`；`--all` 渲 `formats` 全部 |
| `--draft` | — | **迭代小样快捷档**：等价 `--scale 0.5 --sub 1 --preset veryfast`（显式参数可覆盖），产物进 `out/draft/` |
| `--scale <s>` | 1 | CDP 降采样（0.5/0.25/0.75，需宽高均为偶数），产出 `out/draft/draft-<fmt>-<s>x.mp4`，清单另存 `<fmt>@<s>x.frames.json` |
| `--fps` / `--sub` / `--shutter` | film.json | 帧率 / 运动模糊子帧（1=关）/ 快门比例（1=360°、0.5=180°） |
| `--crf` / `--preset` / `--x264-threads` | film.json / `slow` / `4` | 编码质量；线程数固定以保确定性 |
| `--from <s>` / `--to <s>` / `--dur <s>` | 0 / DURATION | 局部重渲（对齐帧栅格） |
| `--out <file>` / `--entry <x.html>` | `out/silent-<fmt>.mp4` / film.json | 覆盖输出（相对路径归 `out/`）或临时换入口 |
| `--workers` / `--pages-per-browser` / `--chunk-seconds` | 核数/2（≤16）/ 2 / 1 | 并行度与分片秒数 |
| `--capture cdp\|locator` / `--png fast\|default` | `cdp` / `fast` | CDP fast PNG 快 ~4×、解码逐像素一致 |
| `--no-cache` / `--clean-cache` / `--pin-renderer` | — | 跳过/清空分片缓存；覆盖写入 `film.json renderer` 指纹 |
| `--no-adaptive` / `--motion-px` / `--sub-min` / `--sub-max` | 开 / 6 / 4 / 48 | 场景定义 `window.MOTION(t0,t1)` 时自适应子帧 |
| `--variant <id>` / `--matrix` | — | 按 `content.json` 渲单变体或全矩阵 → `out/variants/`（跨变体复用分片） |

- **产出与校验**：H.264 / `yuv420p` / `+faststart` 无声成片，渲完用 ffprobe 核对分辨率与帧数 `round((to-from)·fps)`。区间重渲后清单会被区间覆盖，整片门 5 对账需重渲整片。
- **帧时刻**：第 k 帧子帧 j 位于 `from + (k + shutter·j/sub)/fps`。

## seamcheck.mjs & preview.mjs

- **seamcheck.mjs**：`--film` `--entry` `--format` `--fps` `--samples`（默认 8）`--loop`/`--no-loop` `--probe-warn` `--parallel <n>`（门 4）`--relaunch <n>`（门 5）`--scale` `--every` `--sub` `--workers`。
  - **门 1a**：同页同 t 求两次（抓 seek 内时钟/随机/累加）。
  - **门 1b**：全新页面重载（抓加载期随机与未就绪资源）。
  - **门 2**：种子乱序求值（抓跨帧状态与缓存泄漏）。
  - **门 3**：`loop:true` 时判首尾一致与速度连续（跳变 ≤4× 相邻帧中位）。
  - **门 4（`--parallel N`）**：顺序全片 vs N 页并发倒序交错逐帧比 md5。
  - **门 5（`--relaunch N`）**：全新启动浏览器与上次整片渲染清单对账（抓首次启动白帧或输入过期）。
  - **探针**：统计 seek 期间禁用 API 调用次数。
- **preview.mjs**：`--film` `--format` `--port`（默认 4321）`--entry`，浏览器打开 `http://127.0.0.1:<port>/__preview.html` 拖动预览。

## lib/browser.mjs（跨 skill 复用，完整签名见 `api.md`）

```js
import { openScene, makeComparer, launchBrowser } from '<film-core>/lib/browser.mjs';
import { resolveFilm, parseArgs } from '<film-core>/lib/film.mjs';
const S = await openScene(resolveFilm(slug, parseArgs()), '9x16', { initScripts: [] });
const png = await S.shot(1.25); await S.close();
```

## 渲染细节（小样、并行、缓存与自适应子帧）

- **小样（`--draft` / `--scale`）**：页面全分辨率光栅化、CDP 降采样（2D 为定稿真降采样；读 `window.FILM.scale` 的 `stage3d` 三维层会按比例省光栅时间）。速度约快 2.3×；产物进 `out/draft/` 避免被下游误选。小样只看构图、节奏和运镜，清晰度与细字看全分辨率静帧或定稿。
- **并行与分片缓存**：每 worker 领 1 秒分片独立截图+x264 编码，最后 `concat -c copy`。缓存放 `out/.render/cache/<fmt>/`，键含画幅/fps/sub/shutter/crf/preset/ffmpeg/x264Threads/挂载运行时 sha256/scale/png；变体场景同一分片位保留主份 + 最多 6 份 `~<hash>` 备份供跨变体复用。逐帧 md5 清单 `out/.render/<fmt>.frames.json` 会在重渲时打印改动影响的时间区间。
- **自适应子帧（`window.MOTION` + `window.CUTS`）**：返回快门内最大像素位移，`sub>1` 时按 `--motion-px` 取 4–48 子帧在 Node 平均（`lib/pngmix.mjs`）；`MOTION=0` 只截两端一致即省掉子帧；跨硬切 `CUTS` 只截切点前侧。

## 渲染器钉版本与硬件 GPU 后端

- **钉版本**：首次渲染把 `{chromium, playwright, args, ffmpeg, x264Threads}` 记入 `film.json renderer`，变动即告警（确认后 `--pin-renderer` 更新）。`--font-render-hinting=none` 防跨平台 hinting 漂移；环境变量 `FILM_CHROMIUM` 仅作验证换构建口子。headless shell 与完整 Chrome 像素差异主要来自未打包系统字体回退，随片打包字体后降至亚像素级。
- **硬件 GPU 后端（`film.json` 写 `"backend": "gpu"`）**：仅将 WebGL/WebGL2 切到本机 ANGLE Metal，2D 光栅与合成仍走软件（`--use-angle=metal --disable-gpu-rasterization --disable-accelerated-2d-canvas --disable-gpu-compositing`——避免 2D GPU 光栅非确定性）。
  - **收益**（Apple M3 Max 实测）：`_test-3d` 20.1s → 5.9s，`weiqi-fx-open` 149.9s → 21.9s，三维门 4/5 从 165s → 40s；纯 2D 片无收益。
  - **代价**：与 SwiftShader 逐像素不同（着色器差 3.6–7.5%、三维差 8–46%），仅在同款显卡与驱动上可复现；无可用硬件 GPU 的机器直接报「缺能力」退出，不静默回退。
