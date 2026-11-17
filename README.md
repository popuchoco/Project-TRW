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
| `data:download` / `data:build` | 下載並驗證三份固定版本原始資料到 `data/raw/`（gitignored）、產生鄉鎮與北北村里資產 |

## CI

`.github/workflows/ci.yml`：

- `check` job 在每次 push／PR 執行：`npm ci` → `typecheck` → `lint` → `test` → `build`。用已 commit 的 LOD 資產，不連外。
- `data` job 只在每週排程、手動觸發，或 `scripts/data/` 有變更時執行。原始 zip 依 `scripts/data/source.mjs` 的雜湊快取，所以平常不會連 TGOS。重建後的資產必須與 commit 版一致。下載失敗時改用已 commit 的資產跑測試並發出警告。

已知 CI／開發依賴現況（記錄，不處理）：L6 的 `data` job `if` 只檢查 push commit，PR 事件不會執行該 job，此行為目前接受。L7 的 `mapshaper` 開發依賴樹有 `better-sqlite3` peer mismatch，且 `geographiclib` 已 deprecated；兩者只在開發工具依賴中，持續追蹤。

## Simulation worker

`src/sim/` 的模擬邏輯是純 TypeScript，可在 Node 測試。Transit worker 支援暫停與 1×／2×／4×；每個模擬 tick 推進一個遊戲分鐘，因此一個遊戲日為 24 小時、共 1,440 ticks。依名目 10 ticks／秒計算，1× 一個遊戲日約 2 分 24 秒，2× 約 1 分 12 秒，4× 約 36 秒。TransitSim 由可測試的 worker runtime 持有；網路變更與存檔讀寫都在 worker 處理，主執行緒可在快照間內插列車位置。同 seed＋同 tick 與指令序列會得到相同模擬統計；分頁隱藏時會暫停模擬與繪製。

開發與自動化測試可使用 `window.__trw`：`ready` 等待地圖啟動，`getState()` 回傳路網、相機、視圖、模擬狀態與最新統計；`buildTestLine([[經度, 緯度], ...], 'metro' | 'brt')` 建立測試路線，`setTrainCounts(lineId, peak, offPeak)` 設定尖峰與離峰列車數。此介面只讀取狀態，另提供這兩個腳本操作。

## Administrative map data

Regenerate the offline map assets with:

```bash
npm run data:build
```

The command downloads the pinned `1140318`, `1150817`, and `11510` sources when missing or mismatched, verifies each byte size and SHA-256, then creates the four town TopoJSON LODs and the Taipei/New Taipei village assets. Raw archives and CSV belong under `data/raw/`, which is gitignored. If a provider publishes a replacement source, verify it before changing the pinned constants in `scripts/data/source.mjs`.

LOD0–LOD2 each use one island-wide file. LOD3 uses one file per county, with that county's inset features included. `manifest.json` records town source attribution, license, split audit, per-file hashes and sizes, and town/county metadata. `villages-manifest.json` records the village and population source pins, join totals, town-code consistency, and village asset hashes. The village TopoJSON uses 3% Mapshaper simplification with `keep-shapes`; this retains more boundary detail for neighborhood selection while the population and demand-point attributes stay in a separate JSON file. The generated village names come from boundary `VILLNAME`, and square brackets are preserved.

Village data sources: 國土測繪中心「村里界圖(TWD97經緯度)」version 1150817, [data.gov.tw dataset 7438](https://data.gov.tw/dataset/7438); 內政部戶政司「村里戶數、單一年齡人口（新增區域代碼）」version 11510, [data.gov.tw dataset 77132](https://data.gov.tw/dataset/77132). License: [政府資料開放授權條款第1版](https://data.gov.tw/license). Population rows join by exact VILLCODE; the 17 `未編定村里` boundary records have alphanumeric 11-character codes and no population row, so they remain mapped with zero households and population. Display names come from boundary `VILLNAME`.

Source data: 內政部國土測繪中心, 鄉鎮市區界線(TWD97經緯度), version 1140318, [data.gov.tw dataset 7441](https://data.gov.tw/dataset/7441). License: [政府資料開放授權條款－第1版](https://data.gov.tw/license). This project simplifies, splits, and converts the source data.

## PWA and saves

The app uses a hand-written service worker bundled from `src/sw/` to `dist/sw.js`. This avoids adding a PWA runtime or build dependency and keeps cache names and update behavior explicit. Shell and runtime cache names include the package version, town boundary version (`1140318`), village boundary and population versions (`1150817` and `11510`), and the first eight hex characters of SHA-256 over the build's precache URL list. Changing that list creates new cache names. The shell precaches the app bundle, manifest, icons, data manifest, LOD0, LOD1, and inset topology. LOD2, LOD3, the Taipei/New Taipei village topology and population JSON, and other same-origin GET assets enter a cache-first runtime cache when first requested; the village assets stay on-demand to avoid adding roughly 612 KiB to every initial shell download. On activation, the worker deletes other caches whose names start with `trw-` and keeps the current shell/runtime pair. When a new worker is ready, the app offers a reload button and waits for the player to choose it.

Generate the two PNG install icons with the Node built-in-only script:

```bash
node scripts/generate-icons.mjs
```

Save records use one IndexedDB database/store and schema version 2. The payload stores the network, camera, island/metro view, simulation controls and summary, plus the transit worker continuation state used to resume daily demand history. Saves can be exported/imported as JSON (maximum 4 MiB); v1 saves migrate to an empty v2 network, and migration steps are registered in `src/save/migrations.ts`.

## 授權

**授權待定**：本 repo 的程式碼授權由專案擁有者之後決定，目前不提供 `LICENSE` 檔（`package.json` 為 `"license": "UNLICENSED"`）。地圖資料依政府資料開放授權條款－第1版使用，顯名資訊見 `NOTICE` 與 App 內「資料來源」。
