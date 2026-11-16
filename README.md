# Project-TRW

## Administrative map data

Regenerate the offline map assets with:

```bash
npm run data:build
```

The command downloads the pinned `1140318` archive when it is not already present, verifies its byte size and SHA-256, then creates the four TopoJSON LODs and `public/data/manifest.json`. The source archive and extracted raw data belong under `data/raw/`, which is gitignored. If the provider publishes a replacement archive, verify it before changing the pinned constants in `scripts/data/source.mjs`.

LOD0–LOD2 each use one island-wide file. LOD3 uses one file per county, with that county's inset features included. The manifest records source attribution, license, split audit, per-file hashes and sizes, town and county metadata, and the vertex-count method. The current generated assets including the manifest total about 1.6 MB.

Source data: 內政部國土測繪中心, 鄉鎮市區界線(TWD97經緯度), version 1140318, [data.gov.tw dataset 7441](https://data.gov.tw/dataset/7441). License: [政府資料開放授權條款－第1版](https://data.gov.tw/license). This project simplifies, splits, and converts the source data.
