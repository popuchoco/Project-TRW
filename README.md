# Project-TRW

台灣全島交通規劃放置遊戲 — **P0 技術驗證＋PWA 殼層**（TypeScript strict、Vite、PixiJS v8）。目前只有全島 368 鄉鎮市區地圖（含釣魚臺列嶼／東沙／南沙插圖）、PWA 殼層、IndexedDB 存檔骨架與 Web Worker 模擬骨架；沒有遊戲玩法。

## 重現步驟

需要 Node.js 24（見 `.nvmrc`；`>=20` 可用）。

```bash
npm ci
npm run data:build     # 選用：需網路，下載固定版本並驗證 SHA-256，再重建 public/data/
npm run typecheck && npm run lint && npm test
npm run build && npm run preview
```

`public/data/` 已 commit 全部簡化資產（約 1.6 MB），所以不跑 `data:build` 也能測試與建置。重跑 `data:build` 的產出與已 commit 的檔案逐位元組相同。

| Script | 用途 |
| --- | --- |
| `dev` / `build` / `preview` | Vite 開發伺服器、正式建置（含 `dist/sw.js`）、預覽 |
| `test` | Vitest 單元測試（Node 環境，不需瀏覽器） |
| `typecheck` / `lint` | `tsc --noEmit`（app 與 node 設定）、ESLint |
| `data:download` / `data:build` | 下載並驗證原始 zip 到 `data/raw/`（gitignored）、產生 LOD0–LOD3 與 manifest |

## CI

`.github/workflows/ci.yml`：

- `check` job 在每次 push／PR 執行：`npm ci` → `typecheck` → `lint` → `test` → `build`。用已 commit 的 LOD 資產，不連外。
- `data` job 只在每週排程、手動觸發，或 `scripts/data/` 有變更時執行。原始 zip 依 `scripts/data/source.mjs` 的雜湊快取，所以平常不會連 TGOS。重建後的資產必須與 commit 版一致。下載失敗時改用已 commit 的資產跑測試並發出警告。

## Simulation worker

`src/sim/` 是純 TypeScript（不依賴 DOM 或 PixiJS），可在 Node 測試。`sim.worker.ts` 以固定 10 Hz（每 tick 100 ms 遊戲時間）推進，支援暫停與 1×／2×／4×，並以 `postMessage` 傳送快照（序號、遊戲時間、實體）。主執行緒在兩個快照之間內插，P0 只有一個沿假路線移動的 dummy 標記。同 seed＋同輸入序列會得到同樣的快照序列。分頁隱藏時會暫停模擬與繪製。

## Administrative map data

Regenerate the offline map assets with:

```bash
npm run data:build
```

The command downloads the pinned `1140318` archive when it is not already present, verifies its byte size and SHA-256, then creates the four TopoJSON LODs and `public/data/manifest.json`. The source archive and extracted raw data belong under `data/raw/`, which is gitignored. If the provider publishes a replacement archive, verify it before changing the pinned constants in `scripts/data/source.mjs`.

LOD0–LOD2 each use one island-wide file. LOD3 uses one file per county, with that county's inset features included. The manifest records source attribution, license, split audit, per-file hashes and sizes, town and county metadata, and the vertex-count method. The current generated assets including the manifest total about 1.6 MB.

Source data: 內政部國土測繪中心, 鄉鎮市區界線(TWD97經緯度), version 1140318, [data.gov.tw dataset 7441](https://data.gov.tw/dataset/7441). License: [政府資料開放授權條款－第1版](https://data.gov.tw/license). This project simplifies, splits, and converts the source data.

## PWA and saves

The app uses a hand-written service worker bundled from `src/sw/` to `dist/sw.js`. This avoids adding a PWA runtime or build dependency and keeps cache names and update behavior explicit. Cache names include the package version and boundary-data version (`1140318`); the shell precaches the app bundle, manifest, icons, data manifest, LOD0, LOD1, and inset topology. LOD2, LOD3, and other same-origin GET assets use a cache-first runtime cache. When a new worker is ready, the app offers a reload button and waits for the player to choose it.

Generate the two PNG install icons with the Node built-in-only script:

```bash
node scripts/generate-icons.mjs
```

Save records use one IndexedDB database/store and schema version 1. The current P0 payload is a camera and simulation placeholder. Saves can be exported/imported as JSON (maximum 1 MiB); save migration steps are registered in `src/save/migrations.ts`.

## 授權

**授權待定**：本 repo 的程式碼授權由專案擁有者之後決定，目前不提供 `LICENSE` 檔（`package.json` 為 `"license": "UNLICENSED"`）。地圖資料依政府資料開放授權條款－第1版使用，顯名資訊見 `NOTICE` 與 App 內「資料來源」。
