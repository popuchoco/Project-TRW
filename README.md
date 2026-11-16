# Project-TRW

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

## Project status

This repository's software license is undecided; no `LICENSE` file is provided.
