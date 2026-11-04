# 素材台账 — <slug>

> 从 film-assets skill 的 `assets/LICENSES.md` 拷到 `films/<slug>/assets/LICENSES.md`。
> 每个进 `assets/` 的文件一行（`_incoming/`、`*.subset.json`、`text/` 不用记）。
> `node <film-assets>/scripts/audit.mjs --film <slug>` 会核对：没入账的文件、残留的"待确认"。
>
> 授权四问：能商用？要署名（署在哪）？能修改/子集化？能放进仓库/交付给别人？
> 任何一条答不上来，"状态"写 `待确认`，并写清卡在哪。

| 文件 | 来源（具体页面 URL） | 版本/下载日 | 授权 | 授权原文链接 | 署名要求 | 修改/子集化 | 可进仓库 | 查证日 | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| `assets/fonts/src/Example-Regular.ttf` | https://github.com/<org>/<repo>/releases/tag/v1.0 | v1.0 / 2026-01-01 | SIL OFL 1.1（RFN "Example"） | 仓库根 `OFL.txt` | 无 | 允许；公开分发子集需改名 | 是 | 2026-01-01 | OK |
| `assets/fonts/example.subset.woff2` | 由上一行子集化（`subset_font.py`） | — | 同上 | 同上 | 无 | — | 是（已改名） | 2026-01-01 | OK |
| `assets/audio/music.wav` | https://… | … | … | … | 片尾署："曲名" 作者 (站点) / License 名 + 链接 | … | … | … | 待确认：平台 Content ID 是否登记 |
| `assets/models/example.glb`（3D 模型） | https://…（素材站页面 / 厂商发布页；自建写"自建，参考 <官方图 URL>"） | … | … | … | … | 是否允许改面数/重导出 | **文件本身可否再分发**（很多模型站只许可渲染进作品） | … | 待确认：是否含商标外形 / Logo |

## 片尾署名（需要署名的条目汇总，原样上片尾）

- 

## 仅参考、不进成片

| 文件 | 来源 | 用途 |
|---|---|---|
| `assets/_incoming/refs/…` | … | film-story 拆解用 |
