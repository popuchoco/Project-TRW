import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import {
  SOURCE_BYTES,
  SOURCE_DOWNLOAD_URL,
  SOURCE_FILENAME,
  SOURCE_SHA256,
  SOURCE_VERSION,
} from './source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = resolve(repoRoot, 'data/raw', SOURCE_FILENAME);
const outputDir = resolve(repoRoot, 'public/data');
const LODS = [
  { id: 'lod0', simplifyPct: 0.3 },
  { id: 'lod1', simplifyPct: 1 },
  { id: 'lod2', simplifyPct: 3 },
  { id: 'lod3', simplifyPct: 10 },
];
const INSET_SIMPLIFY_PCT = 20;
const EXPECTED_INSETS = {
  diaoyutai: { townCode: '10002040' },
  dongsha: { townCode: '64000100' },
  nansha: { townCode: '64000100' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function propertiesFor(sourceProperties, inset) {
  const properties = {
    TOWNCODE: String(sourceProperties.TOWNCODE),
    COUNTYCODE: String(sourceProperties.COUNTYCODE),
    COUNTYNAME: String(sourceProperties.COUNTYNAME),
    TOWNNAME: String(sourceProperties.TOWNNAME),
    TOWNENG: String(sourceProperties.TOWNENG),
  };
  if (inset) properties.inset = inset;
  return properties;
}

function polygonParts(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Expected polygon geometry; got ${geometry?.type ?? 'null'}`);
}

function geometryFromParts(parts) {
  return { type: 'MultiPolygon', coordinates: parts };
}

function eachPosition(geometry, callback) {
  for (const polygon of polygonParts(geometry)) {
    for (const ring of polygon) {
      for (const position of ring) callback(position);
    }
  }
}

function bboxForGeometry(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  eachPosition(geometry, ([lon, lat]) => {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  });
  assert(Number.isFinite(minLon), 'Cannot calculate bbox for empty geometry');
  return [minLon, minLat, maxLon, maxLat];
}

function countsForGeometry(geometry) {
  let ringCount = 0;
  let vertexCount = 0;
  const parts = polygonParts(geometry);
  for (const polygon of parts) {
    ringCount += polygon.length;
    for (const ring of polygon) vertexCount += ring.length;
  }
  return { partCount: parts.length, ringCount, vertexCount };
}

function addCounts(left, right) {
  return {
    partCount: left.partCount + right.partCount,
    ringCount: left.ringCount + right.ringCount,
    vertexCount: left.vertexCount + right.vertexCount,
  };
}

function emptyCounts() {
  return { partCount: 0, ringCount: 0, vertexCount: 0 };
}

function partInset(townCode, part) {
  const bbox = bboxForGeometry(geometryFromParts([part]));
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (townCode === '10002040' && minLon > 123) return 'diaoyutai';
  if (townCode === '64000100' && minLon > 116 && maxLon < 118 && minLat > 20 && maxLat < 22) {
    return 'dongsha';
  }
  if (townCode === '64000100' && minLon > 113 && maxLon < 116 && minLat > 9 && maxLat < 12) {
    return 'nansha';
  }
  return undefined;
}

async function readZipLayers(archive) {
  const outputs = await mapshaper.applyCommands(
    ['-i', SOURCE_FILENAME, '-o', 'format=geojson', 'extracted.json'],
    { [SOURCE_FILENAME]: archive },
  );
  const collections = Object.values(outputs).map((value) => JSON.parse(value));
  const townCollection = collections.find((collection) => collection.features?.length === 368);
  const specialCollection = collections.find((collection) => collection !== townCollection);
  assert(townCollection, 'Mapshaper could not read TOWN_MOI_1140318 from the source ZIP');
  assert(specialCollection, 'Mapshaper could not read Town_Majia_Sanhe from the source ZIP');
  return { townCollection, specialCollection };
}

async function simplifyCollection(collection, simplifyPct) {
  const inputName = 'combined.geojson';
  const outputName = 'simplified.geojson';
  const partFeatures = collection.features.flatMap((feature) =>
    polygonParts(feature.geometry).map((part) => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: { type: 'Polygon', coordinates: part },
    })),
  );
  const expectedGroups = new Map();
  for (const feature of collection.features) {
    const key = `${feature.properties.TOWNCODE}|${feature.properties.inset ?? ''}`;
    expectedGroups.set(key, {
      partCount: polygonParts(feature.geometry).length,
      ringCount: countsForGeometry(feature.geometry).ringCount,
    });
  }
  const output = await mapshaper.applyCommands(
    [
      '-i', inputName,
      '-simplify', `${simplifyPct}%`, 'keep-shapes',
      '-o', 'format=geojson', outputName,
    ],
    { [inputName]: JSON.stringify({ type: 'FeatureCollection', features: partFeatures }) },
  );
  assert(output[outputName], `Mapshaper did not return ${outputName}`);
  const simplifiedParts = JSON.parse(output[outputName]);
  const groups = new Map();
  for (const feature of simplifiedParts.features) {
    const key = `${feature.properties.TOWNCODE}|${feature.properties.inset ?? ''}`;
    const group = groups.get(key) ?? { properties: feature.properties, parts: [] };
    group.parts.push(...polygonParts(feature.geometry));
    groups.set(key, group);
  }
  assert(groups.size === expectedGroups.size, 'Simplification changed the number of town/inset feature groups');
  const features = [];
  for (const [key, expected] of expectedGroups) {
    const group = groups.get(key);
    assert(group, `Simplification removed feature group ${key}`);
    const geometry = geometryFromParts(group.parts);
    const actual = countsForGeometry(geometry);
    assert(
      actual.partCount === expected.partCount && actual.ringCount === expected.ringCount,
      `Simplification dropped a polygon part or ring from ${key} ` +
        `(parts ${actual.partCount}/${expected.partCount}, rings ${actual.ringCount}/${expected.ringCount})`,
    );
    features.push({ type: 'Feature', properties: group.properties, geometry });
  }
  return { type: 'FeatureCollection', features };
}

async function toTopology(collection, inputName = 'simplified.geojson', outputOptions = []) {
  const outputName = 'topology.json';
  const output = await mapshaper.applyCommands(
    ['-i', inputName, '-o', 'format=topojson', 'quantization=100000', ...outputOptions, outputName],
    { [inputName]: JSON.stringify(collection) },
  );
  assert(output[outputName], `Mapshaper did not return ${outputName}`);
  const topology = JSON.parse(output[outputName]);
  assert(topology.type === 'Topology' && topology.objects, 'Mapshaper produced an invalid TopoJSON topology');
  return topology;
}

function quantizeTopology(topology, quantization) {
  for (const arc of topology.arcs) {
    let previousX = 0;
    let previousY = 0;
    for (const position of arc) {
      const x = Math.round(position[0] * quantization);
      const y = Math.round(position[1] * quantization);
      position[0] = x - previousX;
      position[1] = y - previousY;
      previousX = x;
      previousY = y;
    }
  }
  topology.transform = {
    scale: [1 / quantization, 1 / quantization],
    translate: [0, 0],
  };
  return topology;
}

function topologyVertexCount(topology) {
  return (topology.arcs ?? []).reduce((sum, arc) => sum + arc.length, 0);
}

function topologyTownCodes(topology) {
  const codes = [];
  const visit = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) visit(child);
    } else if (geometry.properties?.TOWNCODE) {
      codes.push(geometry.properties.TOWNCODE);
    }
  };
  for (const object of Object.values(topology.objects)) visit(object);
  return codes;
}

function topologyInsetIds(topology) {
  const ids = [];
  const visit = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) visit(child);
    } else if (geometry.properties?.inset) {
      ids.push(geometry.properties.inset);
    }
  };
  for (const object of Object.values(topology.objects)) visit(object);
  return ids;
}

function topologyInsetCounts(topology) {
  const counts = new Map();
  const visit = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) visit(child);
      return;
    }
    const inset = geometry.properties?.inset;
    if (!inset) return;
    const current = counts.get(inset) ?? emptyCounts();
    if (geometry.type === 'Polygon') {
      current.partCount += 1;
      current.ringCount += geometry.arcs.length;
    } else if (geometry.type === 'MultiPolygon') {
      current.partCount += geometry.arcs.length;
      current.ringCount += geometry.arcs.reduce((sum, polygon) => sum + polygon.length, 0);
    }
    counts.set(inset, current);
  };
  for (const object of Object.values(topology.objects)) visit(object);
  return counts;
}

async function writeTopology(path, topology) {
  const text = JSON.stringify(topology);
  const buffer = Buffer.from(text);
  const fullPath = resolve(outputDir, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buffer);
  return {
    path,
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
    gzipBytes: gzipSync(buffer, { level: 9, mtime: 0 }).byteLength,
  };
}

function sortByCode(a, b) {
  return a.code.localeCompare(b.code);
}

const rawArchive = await readFile(sourcePath);
const actualRawSha = sha256(rawArchive);
assert(
  rawArchive.byteLength === SOURCE_BYTES && actualRawSha === SOURCE_SHA256,
  `Raw source archive hash/size mismatch (bytes ${rawArchive.byteLength}, SHA-256 ${actualRawSha}); ` +
    'verify the source and update SOURCE_BYTES and SOURCE_SHA256 in scripts/data/source.mjs if the pinned release changed.',
);

const { townCollection, specialCollection } = await readZipLayers(rawArchive);
assert(townCollection.features.length === 368, `Expected 368 raw towns; got ${townCollection.features.length}`);
assert(specialCollection.features.length > 0, 'Town_Majia_Sanhe contains no features');

const rawTownFeatures = townCollection.features;
const rawByCode = new Map();
for (const feature of rawTownFeatures) {
  const code = String(feature.properties.TOWNCODE);
  assert(!rawByCode.has(code), `Duplicate raw TOWNCODE ${code}`);
  rawByCode.set(code, feature);
}

const mainFeatures = [];
const insetParts = new Map(Object.keys(EXPECTED_INSETS).map((id) => [id, []]));
const towns = [];
const splitAudit = {};
let rawTotals = emptyCounts();
let mainTotals = emptyCounts();
let insetTotals = emptyCounts();

for (const rawFeature of rawTownFeatures) {
  const properties = rawFeature.properties;
  const townCode = String(properties.TOWNCODE);
  const countyCode = String(properties.COUNTYCODE);
  const mainParts = [];
  const townInsets = new Map();
  const rawCounts = countsForGeometry(rawFeature.geometry);
  rawTotals = addCounts(rawTotals, rawCounts);

  for (const part of polygonParts(rawFeature.geometry)) {
    const inset = partInset(townCode, part);
    if (inset) {
      townInsets.set(inset, [...(townInsets.get(inset) ?? []), part]);
      insetParts.set(inset, [...insetParts.get(inset), { feature: rawFeature, part }]);
    } else {
      mainParts.push(part);
    }
  }

  assert(mainParts.length > 0, `Split removed all main geometry from TOWNCODE ${townCode}`);
  const mainGeometry = geometryFromParts(mainParts);
  const mainCounts = countsForGeometry(mainGeometry);
  mainTotals = addCounts(mainTotals, mainCounts);
  mainFeatures.push({
    type: 'Feature',
    properties: propertiesFor(properties),
    geometry: mainGeometry,
  });

  const insetAudit = {};
  for (const [id, parts] of townInsets) {
    insetAudit[id] = countsForGeometry(geometryFromParts(parts));
  }

  const insetBboxes = [];
  const relevantInsetIds = Object.keys(EXPECTED_INSETS).filter((id) => EXPECTED_INSETS[id].townCode === townCode);
  for (const id of relevantInsetIds) {
    const parts = townInsets.get(id) ?? [];
    assert(parts.length > 0, `Expected inset ${id} parts in TOWNCODE ${townCode}`);
    const geometry = geometryFromParts(parts);
    insetTotals = addCounts(insetTotals, countsForGeometry(geometry));
    insetBboxes.push({ id, bbox: bboxForGeometry(geometry) });
  }

  const town = {
    code: townCode,
    countyCode,
    county: String(properties.COUNTYNAME),
    name: String(properties.TOWNNAME),
    eng: String(properties.TOWNENG),
    bbox: bboxForGeometry(mainGeometry),
  };
  if (insetBboxes.length) town.insetBboxes = insetBboxes;
  towns.push(town);

  if (townCode === '10002040' || townCode === '64000100') {
    const combined = Object.values(insetAudit).reduce(addCounts, mainCounts);
    const preserved =
      combined.partCount === rawCounts.partCount &&
      combined.ringCount === rawCounts.ringCount &&
      combined.vertexCount === rawCounts.vertexCount;
    assert(preserved, `Inset split dropped geometry from TOWNCODE ${townCode}`);
    splitAudit[townCode] = {
      raw: rawCounts,
      main: mainCounts,
      insets: insetAudit,
      mainPlusInsets: combined,
      preserved,
    };
  }
}

for (const [id, expected] of Object.entries(EXPECTED_INSETS)) {
  const parts = insetParts.get(id);
  assert(parts.length > 0, `Required inset ${id} is empty`);
  assert(parts.every(({ feature }) => String(feature.properties.TOWNCODE) === expected.townCode), `Inset ${id} has incorrect TOWNCODE ownership`);
}
assert(mainFeatures.length === 368, `Expected 368 main features; got ${mainFeatures.length}`);
assert(Object.keys(splitAudit).length === 2, 'Expected split audits for 頭城鎮 and 旗津區');
assert(
  rawTotals.partCount === mainTotals.partCount + insetTotals.partCount &&
    rawTotals.ringCount === mainTotals.ringCount + insetTotals.ringCount &&
    rawTotals.vertexCount === mainTotals.vertexCount + insetTotals.vertexCount,
  'Global split part/ring/vertex counts do not reconcile',
);

const insetFeatures = [];
const insets = [];
for (const [id, entries] of insetParts) {
  const first = entries[0].feature;
  const geometry = geometryFromParts(entries.map(({ part }) => part));
  const properties = propertiesFor(first.properties, id);
  insetFeatures.push({ type: 'Feature', properties, geometry });
  insets.push({
    id,
    townCode: String(first.properties.TOWNCODE),
    bbox: bboxForGeometry(geometry),
    partCount: entries.length,
  });
}
towns.sort(sortByCode);
insets.sort((a, b) => a.id.localeCompare(b.id));
mainFeatures.sort((a, b) => a.properties.TOWNCODE.localeCompare(b.properties.TOWNCODE));
insetFeatures.sort((a, b) => a.properties.inset.localeCompare(b.properties.inset));

const countyMap = new Map();
for (const town of towns) {
  const current = countyMap.get(town.countyCode) ?? {
    code: town.countyCode,
    name: town.county,
    bbox: [...town.bbox],
    townCount: 0,
  };
  current.townCount += 1;
  current.bbox = [
    Math.min(current.bbox[0], town.bbox[0]),
    Math.min(current.bbox[1], town.bbox[1]),
    Math.max(current.bbox[2], town.bbox[2]),
    Math.max(current.bbox[3], town.bbox[3]),
  ];
  countyMap.set(town.countyCode, current);
}
const counties = [...countyMap.values()].sort(sortByCode);
assert(counties.length === 22, `Expected 22 counties; got ${counties.length}`);

const combinedCollection = {
  type: 'FeatureCollection',
  features: [...mainFeatures, ...insetFeatures],
};
const specialArea = {
  id: 'majia-sanhe',
  name: '瑪家鄉三和',
  featureCount: specialCollection.features.length,
  attributes: Object.keys(specialCollection.features[0].properties ?? {}).sort(),
  bbox: bboxForGeometry(specialCollection.features[0].geometry),
  note: '已讀取並記錄 metadata；本階段不繪製此特別註記圖形。',
};

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const lodEntries = [];

const simplifiedInsets = await simplifyCollection(
  { type: 'FeatureCollection', features: insetFeatures },
  INSET_SIMPLIFY_PCT,
);
// A dataset-wide 100,000-step transform collapses some of these tiny islands.
// Round the inset-only coordinates to a 1e-5 degree grid to retain every part.
const insetTopology = quantizeTopology(await toTopology(simplifiedInsets, 'insets.geojson', [
  'no-quantization',
  'precision=0.00001',
  'fix-geometry',
]), 100000);
assert(
  JSON.stringify(topologyInsetIds(insetTopology).sort()) === JSON.stringify(Object.keys(EXPECTED_INSETS).sort()) &&
    topologyTownCodes(insetTopology).length === 3,
  'Inset topology must contain exactly the three inset features',
);
const topologyInsetAudit = topologyInsetCounts(insetTopology);
for (const [id, expected] of Object.entries(EXPECTED_INSETS)) {
  const actual = topologyInsetAudit.get(id);
  const expectedCounts = splitAudit[expected.townCode]?.insets[id];
  assert(
    actual && expectedCounts && actual.partCount === expectedCounts.partCount && actual.ringCount === expectedCounts.ringCount,
    `Inset topology ${id} changed part/ring counts from the split audit`,
  );
}
for (const feature of simplifiedInsets.features) {
  const insetId = feature.properties.inset;
  const expected = splitAudit[feature.properties.TOWNCODE]?.insets[insetId];
  assert(expected, `Missing split audit for inset ${insetId}`);
  const actual = countsForGeometry(feature.geometry);
  assert(
    actual.partCount === expected.partCount && actual.ringCount === expected.ringCount,
    `Inset ${insetId} changed part/ring counts from the split audit ` +
      `(parts ${actual.partCount}/${expected.partCount}, rings ${actual.ringCount}/${expected.ringCount})`,
  );
}
const insetAsset = {
  ...await writeTopology('trw-1140318-insets.topo.json', insetTopology),
  vertexCount: topologyVertexCount(insetTopology),
  simplifyPct: INSET_SIMPLIFY_PCT,
  quantization: 100000,
};

for (const lod of LODS) {
  const simplified = await simplifyCollection(combinedCollection, lod.simplifyPct);
  const files = [];
  let vertexCount = 0;

  if (lod.id !== 'lod3') {
    const topology = await toTopology(simplified);
    vertexCount = topologyVertexCount(topology);
    const asset = await writeTopology(`trw-1140318-${lod.id}.topo.json`, topology);
    files.push(asset);
    const codes = topologyTownCodes(topology);
    assert(codes.length === 371, `${lod.id} topology should contain 368 main towns and 3 inset features; got ${codes.length}`);
    assert(new Set(codes).size === 368, `${lod.id} topology does not contain all 368 unique town codes`);
    assert(towns.every((town) => codes.includes(town.code)), `${lod.id} topology lost a TOWNCODE`);
    assert(
      JSON.stringify(topologyInsetIds(topology).sort()) === JSON.stringify(Object.keys(EXPECTED_INSETS).sort()),
      `${lod.id} topology lost an inset feature`,
    );
  } else {
    const countyCodes = counties.map(({ code }) => code);
    for (const countyCode of countyCodes) {
      const features = simplified.features.filter((feature) => feature.properties.COUNTYCODE === countyCode);
      const townCodes = features.filter((feature) => !feature.properties.inset).map((feature) => feature.properties.TOWNCODE);
      const expectedTownCount = towns.filter((town) => town.countyCode === countyCode).length;
      assert(townCodes.length === expectedTownCount, `LOD3 ${countyCode} has ${townCodes.length}/${expectedTownCount} towns`);
      const topology = await toTopology({ type: 'FeatureCollection', features }, `county-${countyCode}.geojson`);
      const actualCodes = topologyTownCodes(topology);
      assert(actualCodes.length === features.length, `LOD3 ${countyCode} lost features during TopoJSON export`);
      const asset = await writeTopology(`lod3/${countyCode}.topo.json`, topology);
      files.push(asset);
      vertexCount += topologyVertexCount(topology);
    }
    const allCountyTownCodes = [];
    const allCountyInsetIds = [];
    for (const countyCode of countyCodes) {
      const features = simplified.features.filter((feature) => feature.properties.COUNTYCODE === countyCode && !feature.properties.inset);
      allCountyTownCodes.push(...features.map((feature) => feature.properties.TOWNCODE));
      allCountyInsetIds.push(...simplified.features
        .filter((feature) => feature.properties.COUNTYCODE === countyCode && feature.properties.inset)
        .map((feature) => feature.properties.inset));
    }
    assert(allCountyTownCodes.length === 368 && new Set(allCountyTownCodes).size === 368, 'LOD3 files do not contain all 368 unique towns');
    assert(
      JSON.stringify(allCountyInsetIds.sort()) === JSON.stringify(Object.keys(EXPECTED_INSETS).sort()),
      'LOD3 files do not contain all three inset features',
    );
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  lodEntries.push({ id: lod.id, simplifyPct: lod.simplifyPct, files, vertexCount });
  process.stdout.write(`${lod.id} simplified (${lod.simplifyPct}%): ${vertexCount.toLocaleString()} arc positions\n`);
}

for (let index = lodEntries.length - 1; index > 0; index -= 1) {
  assert(
    lodEntries[index].vertexCount > lodEntries[index - 1].vertexCount,
    `Vertex counts must be LOD3 > LOD2 > LOD1 > LOD0: ${lodEntries[index].id}=${lodEntries[index].vertexCount}, ${lodEntries[index - 1].id}=${lodEntries[index - 1].vertexCount}`,
  );
}

const manifest = {
  schemaVersion: 1,
  dataVersion: SOURCE_VERSION,
  source: {
    agency: '內政部國土測繪中心',
    name: '鄉鎮市區界線(TWD97經緯度)',
    version: SOURCE_VERSION,
    sourceUrl: 'https://data.gov.tw/dataset/7441',
    downloadUrl: SOURCE_DOWNLOAD_URL,
    licenseName: '政府資料開放授權條款－第1版',
    licenseUrl: 'https://data.gov.tw/license',
    rawSha256: SOURCE_SHA256,
    rawBytes: SOURCE_BYTES,
    note: '本專案已對原始資料進行簡化、拆分與格式轉換。',
  },
  vertexCountMethod: 'sum of stored TopoJSON arc positions across the listed files; county-split LOD3 counts each county file topology independently.',
  lod3Layout: '每個縣市各一個 TopoJSON 檔，該縣市的 inset feature 一併放入。',
  insetAsset,
  lods: lodEntries,
  totals: {
    townCount: mainFeatures.length,
    countyCount: counties.length,
    insetCount: insets.length,
    rawPartCount: rawTotals.partCount,
    rawRingCount: rawTotals.ringCount,
    rawVertexCount: rawTotals.vertexCount,
    mainPartCount: mainTotals.partCount,
    insetPartCount: insetTotals.partCount,
  },
  towns,
  counties,
  insets,
  specialAreas: [specialArea],
  splitAudit: {
    comparison: 'For each affected town, raw polygon-part, ring and coordinate-position totals equal main geometry plus all inset geometry.',
    towns: splitAudit,
    rawTotals,
    mainTotals,
    insetTotals,
  },
};

const manifestBuffer = Buffer.from(JSON.stringify(manifest));
await writeFile(resolve(outputDir, 'manifest.json'), manifestBuffer);

process.stdout.write('\nLOD summary (LOD3 byte counts are the sum of the county files):\n');
process.stdout.write('LOD   Vertices     Raw bytes   Gzip bytes\n');
for (const lod of lodEntries) {
  const bytes = lod.files.reduce((sum, file) => sum + file.bytes, 0);
  const gzipBytes = lod.files.reduce((sum, file) => sum + file.gzipBytes, 0);
  process.stdout.write(
    `${lod.id.padEnd(5)} ${String(lod.vertexCount).padStart(10)} ${String(bytes).padStart(12)} ${String(gzipBytes).padStart(12)}\n`,
  );
}
process.stdout.write(`\nSplit audit (parts / rings / vertices):\n`);
for (const [code, audit] of Object.entries(splitAudit)) {
  const name = rawByCode.get(code).properties.TOWNNAME;
  process.stdout.write(
    `${name} ${code}: raw ${audit.raw.partCount}/${audit.raw.ringCount}/${audit.raw.vertexCount}; ` +
      `main ${audit.main.partCount}/${audit.main.ringCount}/${audit.main.vertexCount}; ` +
      `insets ${Object.values(audit.insets).reduce(addCounts, emptyCounts()).partCount}/` +
      `${Object.values(audit.insets).reduce(addCounts, emptyCounts()).ringCount}/` +
      `${Object.values(audit.insets).reduce(addCounts, emptyCounts()).vertexCount}\n`,
  );
}
const totalBytes = lodEntries.flatMap((lod) => lod.files).reduce(
  (sum, file) => sum + file.bytes,
  manifestBuffer.byteLength + insetAsset.bytes,
);
process.stdout.write(`Total generated data size including manifest: ${totalBytes.toLocaleString()} bytes.\n`);
