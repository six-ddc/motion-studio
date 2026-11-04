# 素材台账 — _test-3d

> 授权四问：能商用？要署名？能修改/子集化？能放进仓库/交付？

| 文件 | 来源 | 版本/下载日 | 授权 | 授权原文 | 署名要求 | 修改 | 可进仓库 | 查证日 | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| `runtime/three-film.core.js`、`runtime/three-film.module.js` | https://www.npmjs.com/package/three（`npm pack three@0.186.1`），经仓库开发工具 `dev/film-webfx/vendor-three.mjs` 打帧契约补丁 | 0.186.1 / 2026-10-21 | MIT | 两个文件头部全文 | MIT 要求随副本保留版权与许可声明（已在文件头） | 已修改（补丁表见文件头 / film-webfx references/three.md §1） | 是 | 2026-10-21 | OK |
| 字形图集 | 场景加载时用 `seeded(2026)` 生成的 5×7 点阵，无第三方素材 | — | 自制 | — | 无 | — | 是 | 2026-10-21 | OK |

## 片尾署名
- 无（MIT 只要求随代码保留声明，不要求成片署名）
