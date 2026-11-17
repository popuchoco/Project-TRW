import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import mapshaper from 'mapshaper';
import {
  OPEN_DATA_LICENSE_NAME,
  OPEN_DATA_LICENSE_URL,
  POPULATION_SOURCE_BYTES,
  POPULATION_SOURCE_DOWNLOAD_URL,
  POPULATION_SOURCE_FILENAME,
  POPULATION_SOURCE_SHA256,
  POPULATION_SOURCE_URL,
  POPULATION_SOURCE_VERSION,
  SOURCE_VERSION,
  VILLAGE_SOURCE_BYTES,
  VILLAGE_SOURCE_DOWNLOAD_URL,
  VILLAGE_SOURCE_FILENAME,
  VILLAGE_SOURCE_SHA256,
  VILLAGE_SOURCE_URL,
  VILLAGE_SOURCE_VERSION,
} from './source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawDir = resolve(repoRoot, 'data/raw');
const outputDir = resolve(repoRoot, 'public/data');
const COUNTY_CODES = new Set(['63000', '65000']);
const SIMPLIFY_PERCENT = 3;
const TOPOLOGY_QUANTIZATION = 1_000_000;
const ATTRIBUTE_FILENAME = 'villages-6300065000.json';
const TOPOLOGY_FILENAME = 'villages-6300065000.topo.json';
const MANIFEST_FILENAME = 'villages-manifest.json';
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function verifyRaw(data, expectedBytes, expectedSha, filename) {
  const actualSha = sha256(data);
  assert(
    data.byteLength === expectedBytes && actualSha === expectedSha,
    `Raw source ${filename} does not match its pin ` +
      `(expected ${expectedBytes} bytes, SHA-256 ${expectedSha}; ` +
      `got ${data.byteLength} bytes, SHA-256 ${actualSha}). Run npm run data:download and verify the source pin.`,
  );
}

function parseCsv(text, onRow) {
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) onRow(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  assert(!inQuotes, 'Population CSV ends inside a quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    onRow(row);
  }
}

function readPopulation(csvText, villageByCode) {
  const rows = parseCsv;
  let headers;
  const populationByCode = new Map();
  rows(csvText.replace(/^\uFEFF/, ''), (fields) => {
    if (!headers) {
      headers = fields;
      return;
    }
    const codeIndex = headers.indexOf('區域別代碼');
    const nameIndex = headers.indexOf('村里');
    const householdsIndex = headers.indexOf('戶數');
    const populationIndex = headers.indexOf('人口數');
    assert(
      [codeIndex, nameIndex, householdsIndex, populationIndex].every((index) => index >= 0),
      'Population CSV is missing one of 區域別代碼、村里、戶數、人口數',
    );
    const code = fields[codeIndex] ?? '';
    if (!villageByCode.has(code)) return;
    assert(/^\d{11}$/.test(code), `Invalid population 区域別代碼: ${code}`);
    assert(!populationByCode.has(code), `Duplicate VILLCODE ${code} in population CSV`);
    const householdsText = fields[householdsIndex] ?? '';
    const populationText = fields[populationIndex] ?? '';
    assert(/^\d+$/.test(householdsText), `Invalid 戶數 for VILLCODE ${code}: ${householdsText}`);
    assert(/^\d+$/.test(populationText), `Invalid 人口數 for VILLCODE ${code}: ${populationText}`);
    // Read the named 村里 field to enforce the pinned CSV schema; boundary VILLNAME remains the display name.
    assert(fields[nameIndex] !== undefined, `Missing 村里 field for VILLCODE ${code}`);
    populationByCode.set(code, {
      households: Number(householdsText),
      population: Number(populationText),
    });
  });
  assert(headers, 'Population CSV is empty');
  return populationByCode;
}

function polygonParts(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Expected village polygon geometry; got ${geometry?.type ?? 'null'}`);
}

function ringContainsPoint(ring, x, y) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index];
    const prior = ring[previous];
    if (!current || !prior) continue;
    const [x1, y1] = prior;
    const [x2, y2] = current;
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    const dot = (x - x1) * (x - x2) + (y - y1) * (y - y2);
    if (Math.abs(cross) <= 1e-12 && dot <= 1e-12) return true;
    if ((y2 > y) !== (y1 > y) && x < ((x1 - x2) * (y - y2)) / (y1 - y2) + x2) inside = !inside;
  }
  return inside;
}

function pointInPolygon(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    if (ringContainsPoint(ring, x, y)) inside = !inside;
  }
  return inside;
}

function pointInMultiPolygon(polygons, x, y) {
  return polygons.some((rings) => pointInPolygon(rings, x, y));
}

function ringCentroid(ring) {
  let twiceArea = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (!current || !next) continue;
    const cross = current[0] * next[1] - next[0] * current[1];
    twiceArea += cross;
    xSum += (current[0] + next[0]) * cross;
    ySum += (current[1] + next[1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-20) return undefined;
  return {
    area: Math.abs(twiceArea / 2),
    x: xSum / (3 * twiceArea),
    y: ySum / (3 * twiceArea),
  };
}

function areaCentroid(polygons) {
  let area = 0;
  let xSum = 0;
  let ySum = 0;
  for (const rings of polygons) {
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const ring = rings[ringIndex];
      if (!ring) continue;
      const centroid = ringCentroid(ring);
      if (!centroid) continue;
      const weight = centroid.area * (ringIndex === 0 ? 1 : -1);
      area += weight;
      xSum += centroid.x * weight;
      ySum += centroid.y * weight;
    }
  }
  if (area <= 0) return undefined;
  return [xSum / area, ySum / area];
}

function pointSegmentDistanceSquared(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return (x - x1) ** 2 + (y - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return (x - (x1 + dx * t)) ** 2 + (y - (y1 + dy * t)) ** 2;
}

function signedDistanceToPolygon(rings, x, y) {
  let minimum = Infinity;
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index += 1) {
      const first = ring[index];
      const second = ring[index + 1];
      if (first && second) minimum = Math.min(minimum, pointSegmentDistanceSquared(x, y, first, second));
    }
  }
  const distance = Math.sqrt(minimum);
  return pointInPolygon(rings, x, y) ? distance : -distance;
}

class MaxHeap {
  #values = [];
  #sequence = 0;

  push(cell) {
    const value = { ...cell, sequence: this.#sequence++ };
    this.#values.push(value);
    let index = this.#values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#higher(this.#values[parent], value)) break;
      this.#values[index] = this.#values[parent];
      index = parent;
    }
    this.#values[index] = value;
  }

  pop() {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (!first) return undefined;
    if (this.#values.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.#values.length) break;
        let child = left;
        if (right < this.#values.length && this.#higher(this.#values[right], this.#values[left])) child = right;
        if (this.#higher(last, this.#values[child])) break;
        this.#values[index] = this.#values[child];
        index = child;
      }
      this.#values[index] = last;
    }
    return first;
  }

  get length() {
    return this.#values.length;
  }

  #higher(left, right) {
    return left.maximum > right.maximum || (left.maximum === right.maximum && left.sequence < right.sequence);
  }
}

function poleOfInaccessibility(rings) {
  const outer = rings[0];
  assert(outer?.length, 'Cannot find an interior point for an empty polygon');
  const xs = outer.map(([x]) => x);
  const ys = outer.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  let cellSize = Math.min(maxX - minX, maxY - minY);
  assert(cellSize > 0, 'Cannot find an interior point for a zero-area polygon');

  const makeCell = (x, y, halfSize) => {
    const distance = signedDistanceToPolygon(rings, x, y);
    return { x, y, halfSize, distance, maximum: distance + halfSize * Math.SQRT2 };
  };
  const heap = new MaxHeap();
  let best = makeCell(minX + (maxX - minX) / 2, minY + (maxY - minY) / 2, 0);
  const centroid = areaCentroid([rings]);
  if (centroid) {
    const candidate = makeCell(centroid[0], centroid[1], 0);
    if (candidate.distance > best.distance) best = candidate;
  }

  const half = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) heap.push(makeCell(x + half, y + half, half));
  }
  const precision = 0.00001;
  while (heap.length > 0) {
    const cell = heap.pop();
    if (!cell) break;
    if (cell.distance > best.distance) best = cell;
    if (cell.maximum - best.distance <= precision || cell.halfSize <= precision / 2) continue;
    cellSize = cell.halfSize;
    const nextHalf = cellSize / 2;
    heap.push(makeCell(cell.x - nextHalf, cell.y - nextHalf, nextHalf));
    heap.push(makeCell(cell.x + nextHalf, cell.y - nextHalf, nextHalf));
    heap.push(makeCell(cell.x - nextHalf, cell.y + nextHalf, nextHalf));
    heap.push(makeCell(cell.x + nextHalf, cell.y + nextHalf, nextHalf));
  }
  assert(best.distance > 0, 'Pole of inaccessibility search found no polygon interior');
  return [best.x, best.y];
}

function demandPoint(geometry) {
  const polygons = polygonParts(geometry);
  const centroid = areaCentroid(polygons);
  let candidate = centroid && pointInMultiPolygon(polygons, centroid[0], centroid[1]) ? centroid : undefined;
  if (!candidate) {
    let bestPoint;
    let bestClearance = -Infinity;
    for (const rings of polygons) {
      const point = poleOfInaccessibility(rings);
      const clearance = signedDistanceToPolygon(rings, point[0], point[1]);
      if (clearance > bestClearance) {
        bestPoint = point;
        bestClearance = clearance;
      }
    }
    candidate = bestPoint;
  }
  assert(candidate, 'No interior demand point found');
  const rounded = candidate.map((coordinate) => Number(coordinate.toFixed(8)));
  assert(
    pointInMultiPolygon(polygons, rounded[0], rounded[1]),
    `Rounded demand point [${rounded.join(',')}] is outside its village polygon`,
  );
  return rounded;
}

function decodeTopology(topology, objectName) {
  const object = topology.objects[objectName];
  assert(object, `Missing TopoJSON object ${objectName}`);
  function decodeArc(reference) {
    const reversed = reference < 0;
    const index = reversed ? ~reference : reference;
    const arc = topology.arcs[index];
    assert(arc, `Invalid TopoJSON arc index ${reference}`);
    let x = 0;
    let y = 0;
    const points = arc.map(([dx, dy]) => {
      if (topology.transform) {
        x += dx;
        y += dy;
        return [
          x * topology.transform.scale[0] + topology.transform.translate[0],
          y * topology.transform.scale[1] + topology.transform.translate[1],
        ];
      }
      return [dx, dy];
    });
    if (reversed) points.reverse();
    return points;
  }
  function decodeRing(references) {
    const positions = [];
    for (const reference of references) {
      const arc = decodeArc(reference);
      positions.push(...arc.slice(positions.length > 0 && arc.length > 0 ? 1 : 0));
    }
    return positions;
  }
  function decodePolygon(rings) {
    return rings.map((ring) => decodeRing(ring));
  }
  function visit(geometry, features) {
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) visit(child, features);
      return;
    }
    const coordinates = geometry.type === 'Polygon'
      ? [decodePolygon(geometry.arcs)]
      : geometry.arcs.map((polygon) => decodePolygon(polygon));
    features.push({
      VILLCODE: String(geometry.properties?.VILLCODE ?? geometry.id ?? ''),
      geometry: { type: 'MultiPolygon', coordinates },
    });
  }
  const features = [];
  visit(object, features);
  return features;
}

function topologyObjectName(topology) {
  const names = Object.keys(topology.objects);
  assert(names.length === 1, `Expected one village TopoJSON object; got ${names.join(', ')}`);
  return names[0];
}

function sortByCode(left, right) {
  return left.VILLCODE.localeCompare(right.VILLCODE);
}

async function readVillageLayer(archive) {
  const outputs = await mapshaper.applyCommands(
    ['-i', VILLAGE_SOURCE_FILENAME, '-o', 'format=geojson', 'extracted.json'],
    { [VILLAGE_SOURCE_FILENAME]: archive },
  );
  const collections = Object.values(outputs).map((value) => JSON.parse(value));
  const villages = collections.find((collection) => collection.features?.length === 7_986);
  const sanhe = collections.find((collection) => collection !== villages);
  assert(villages, 'Mapshaper could not read VILLAGE_NLSC_1150817 from village.zip');
  assert(sanhe?.features?.length > 0, 'Mapshaper could not read Village_Sanhe from village.zip');
  return villages;
}

const [villageArchive, populationBytes, townManifestBytes] = await Promise.all([
  readFile(resolve(rawDir, VILLAGE_SOURCE_FILENAME)),
  readFile(resolve(rawDir, POPULATION_SOURCE_FILENAME)),
  readFile(resolve(outputDir, 'manifest.json')),
]);
verifyRaw(villageArchive, VILLAGE_SOURCE_BYTES, VILLAGE_SOURCE_SHA256, VILLAGE_SOURCE_FILENAME);
verifyRaw(populationBytes, POPULATION_SOURCE_BYTES, POPULATION_SOURCE_SHA256, POPULATION_SOURCE_FILENAME);
const townManifest = JSON.parse(townManifestBytes.toString('utf8'));
assert(townManifest.dataVersion === SOURCE_VERSION, `Expected town boundary version ${SOURCE_VERSION}`);

const rawVillageCollection = await readVillageLayer(villageArchive);
const boundaryFeatures = rawVillageCollection.features.filter(({ properties }) =>
  COUNTY_CODES.has(String(properties.COUNTYCODE)),
);
assert(boundaryFeatures.length === 1_512, `Expected 1,512 Taipei/New Taipei villages; got ${boundaryFeatures.length}`);

const villages = boundaryFeatures.map(({ properties, geometry }) => {
  const code = String(properties.VILLCODE);
  const townCode = String(properties.TOWNCODE);
  assert(/^[A-Z0-9]{11}$/.test(code), `Invalid 11-character VILLCODE in boundary data: ${code}`);
  assert(COUNTY_CODES.has(String(properties.COUNTYCODE)), `Unexpected COUNTYCODE for ${code}`);
  assert(typeof properties.VILLNAME === 'string', `Missing VILLNAME for ${code}`);
  assert(properties.VILLNAME.length > 0 || properties.NOTE === '未編定村里', `Unexpected blank VILLNAME for ${code}`);
  assert(!PRIVATE_USE.test(properties.VILLNAME), `Boundary VILLNAME contains a private-use character for ${code}`);
  return {
    VILLCODE: code,
    name: String(properties.VILLNAME),
    TOWNCODE: townCode,
    note: String(properties.NOTE ?? ''),
    type: geometry.type,
    coordinates: geometry.coordinates,
    properties: { VILLCODE: code },
    geometry,
  };
}).sort(sortByCode);
const villageByCode = new Map(villages.map((village) => [village.VILLCODE, village]));
assert(villageByCode.size === villages.length, 'Boundary data contains duplicate VILLCODEs');

const boundaryTownCodes = [...new Set(villages.map(({ TOWNCODE }) => TOWNCODE))].sort();
const townRecords = townManifest.towns.filter(({ countyCode }) => COUNTY_CODES.has(countyCode));
const townAssetCodes = townRecords.map(({ code }) => code).sort();
const onlyInVillages = boundaryTownCodes.filter((code) => !townAssetCodes.includes(code));
const onlyInTownAssets = townAssetCodes.filter((code) => !boundaryTownCodes.includes(code));
assert(
  boundaryTownCodes.length === 41 && onlyInVillages.length === 0 && onlyInTownAssets.length === 0,
  `北北 TOWNCODE mismatch: only village boundary=${onlyInVillages.join(',') || '(none)'}; ` +
    `only town assets=${onlyInTownAssets.join(',') || '(none)'}`,
);
const townNames = new Map(townRecords.map(({ code, name }) => [code, name]));

const populationByCode = readPopulation(populationBytes.toString('utf8'), villageByCode);
const noteCodes = villages.filter(({ note }) => note === '未編定村里').map(({ VILLCODE }) => VILLCODE);
assert(noteCodes.length === 17, `Expected 17 NOTE=未編定村里 features; got ${noteCodes.length}`);
const unmatchedCodes = villages.filter(({ VILLCODE }) => !populationByCode.has(VILLCODE)).map(({ VILLCODE }) => VILLCODE);
assert(
  JSON.stringify(unmatchedCodes) === JSON.stringify(noteCodes.sort()),
  `Unmatched population codes must exactly equal NOTE=未編定村里; unmatched=${unmatchedCodes.join(',')}`,
);
assert(populationByCode.size === 1_495, `Expected 1,495 villages with population rows; got ${populationByCode.size}`);
const populationTotal = [...populationByCode.values()].reduce((total, row) => total + row.population, 0);
assert(populationTotal === 6_451_184, `Expected total population 6,451,184; got ${populationTotal}`);

const inputName = 'north-north.geojson';
const simplifiedName = 'north-north-simplified.geojson';
const selectedCollection = {
  type: 'FeatureCollection',
  features: villages.map(({ geometry, VILLCODE }) => ({
    type: 'Feature',
    properties: { VILLCODE },
    geometry,
  })),
};
const simplifiedOutput = await mapshaper.applyCommands(
  ['-i', inputName, '-simplify', `${SIMPLIFY_PERCENT}%`, 'keep-shapes', '-o', 'format=geojson', simplifiedName],
  { [inputName]: JSON.stringify(selectedCollection) },
);
assert(simplifiedOutput[simplifiedName], 'Mapshaper did not return simplified village geometries');
const simplifiedCollection = JSON.parse(simplifiedOutput[simplifiedName]);
assert(simplifiedCollection.features.length === 1_512, `Simplification changed village count to ${simplifiedCollection.features.length}`);
const simplifiedCodes = simplifiedCollection.features.map(({ properties }) => String(properties.VILLCODE)).sort();
assert(JSON.stringify(simplifiedCodes) === JSON.stringify([...villageByCode.keys()].sort()), 'Simplification changed the village VILLCODE set');

const topoName = 'north-north-topology.json';
const topologyOutput = await mapshaper.applyCommands(
  [
    '-i', simplifiedName,
    '-o', 'format=topojson', `quantization=${TOPOLOGY_QUANTIZATION}`, topoName,
  ],
  { [simplifiedName]: simplifiedOutput[simplifiedName] },
);
assert(topologyOutput[topoName], 'Mapshaper did not return village TopoJSON');
const topology = JSON.parse(topologyOutput[topoName]);
assert(topology.type === 'Topology' && Array.isArray(topology.arcs), 'Mapshaper produced an invalid village TopoJSON');
const objectName = topologyObjectName(topology);
const topoGeometries = topology.objects[objectName];
const propertyGeometries = topoGeometries.type === 'GeometryCollection' ? topoGeometries.geometries : [topoGeometries];
assert(propertyGeometries.length === 1_512, `Topology contains ${propertyGeometries.length} villages`);
const topologyCodes = propertyGeometries.map((geometry) => String(geometry.properties?.VILLCODE ?? geometry.id ?? ''));
assert(
  JSON.stringify(topologyCodes) === JSON.stringify([...topologyCodes].sort()),
  'Village TopoJSON features are not sorted by VILLCODE',
);
for (const geometry of propertyGeometries) {
  const keys = Object.keys(geometry.properties ?? {});
  assert(keys.length === 1 && keys[0] === 'VILLCODE', 'Village TopoJSON must keep only VILLCODE as a property');
}

const simplifiedGeometryByCode = new Map(simplifiedCollection.features.map(({ properties, geometry }) => [
  String(properties.VILLCODE), geometry,
]));
const decodedByCode = new Map(decodeTopology(topology, objectName).map((feature) => [feature.VILLCODE, feature.geometry]));
assert(decodedByCode.size === 1_512, `Decoded topology has ${decodedByCode.size} villages`);
const attributes = villages.map((village) => {
  const population = populationByCode.get(village.VILLCODE);
  const geometry = decodedByCode.get(village.VILLCODE);
  assert(geometry, `Missing simplified geometry for ${village.VILLCODE}`);
  const point = demandPoint(geometry);
  assert(pointInMultiPolygon(geometry.coordinates, point[0], point[1]), `Demand point is outside ${village.VILLCODE}`);
  assert(simplifiedGeometryByCode.has(village.VILLCODE), `Missing simplified source feature ${village.VILLCODE}`);
  const townName = townNames.get(village.TOWNCODE);
  assert(townName, `Missing town name for TOWNCODE ${village.TOWNCODE}`);
  return {
    VILLCODE: village.VILLCODE,
    name: village.name,
    TOWNCODE: village.TOWNCODE,
    townName,
    population: population?.population ?? 0,
    households: population?.households ?? 0,
    populationMatched: population !== undefined,
    demandPoint: point,
  };
});
assert(attributes.every(({ VILLCODE }, index) => index === 0 || attributes[index - 1].VILLCODE < VILLCODE), 'Village attributes are not sorted by VILLCODE');

const topologyText = JSON.stringify(topology);
const attributesText = JSON.stringify(attributes);
assert(!PRIVATE_USE.test(topologyText), 'Village TopoJSON contains a Unicode private-use character');
assert(!PRIVATE_USE.test(attributesText), 'Village attributes contain a Unicode private-use character');
const topologyBuffer = Buffer.from(topologyText);
const attributesBuffer = Buffer.from(attributesText);
const topologyAsset = {
  path: TOPOLOGY_FILENAME,
  bytes: topologyBuffer.byteLength,
  sha256: sha256(topologyBuffer),
  gzipBytes: gzipSync(topologyBuffer, { level: 9, mtime: 0 }).byteLength,
  quantization: TOPOLOGY_QUANTIZATION,
  objectName,
};
const attributesAsset = {
  path: ATTRIBUTE_FILENAME,
  bytes: attributesBuffer.byteLength,
  sha256: sha256(attributesBuffer),
  gzipBytes: gzipSync(attributesBuffer, { level: 9, mtime: 0 }).byteLength,
};
const manifest = {
  schemaVersion: 1,
  dataVersion: `${VILLAGE_SOURCE_VERSION}+${POPULATION_SOURCE_VERSION}`,
  countyCodes: [...COUNTY_CODES].sort(),
  villageCount: villages.length,
  populationMatchedCount: populationByCode.size,
  unmatchedCount: unmatchedCodes.length,
  unmatchedCodes,
  unmatchedReason: 'NOTE=未編定村里',
  populationTotal,
  townCodeCount: boundaryTownCodes.length,
  townCodes: boundaryTownCodes,
  townBoundaryVersion: SOURCE_VERSION,
  nameRule: 'Display names use boundary VILLNAME; square brackets are preserved exactly as supplied.',
  simplification: {
    method: 'Mapshaper simplify with keep-shapes; TopoJSON encodes shared boundaries as shared arcs.',
    retainedPercent: SIMPLIFY_PERCENT,
    rationale: '3% retains more village outline detail while the attribute data stays in a separate compact JSON file.',
  },
  license: { name: OPEN_DATA_LICENSE_NAME, url: OPEN_DATA_LICENSE_URL },
  sources: [
    {
      agency: '內政部國土測繪中心',
      name: '村里界圖(TWD97經緯度)',
      version: VILLAGE_SOURCE_VERSION,
      sourceUrl: VILLAGE_SOURCE_URL,
      downloadUrl: VILLAGE_SOURCE_DOWNLOAD_URL,
      license: { name: OPEN_DATA_LICENSE_NAME, url: OPEN_DATA_LICENSE_URL },
      rawFilename: VILLAGE_SOURCE_FILENAME,
      rawBytes: VILLAGE_SOURCE_BYTES,
      rawSha256: VILLAGE_SOURCE_SHA256,
    },
    {
      agency: '內政部戶政司',
      name: '村里戶數、單一年齡人口（新增區域代碼）',
      version: POPULATION_SOURCE_VERSION,
      sourceUrl: POPULATION_SOURCE_URL,
      downloadUrl: POPULATION_SOURCE_DOWNLOAD_URL,
      license: { name: OPEN_DATA_LICENSE_NAME, url: OPEN_DATA_LICENSE_URL },
      rawFilename: POPULATION_SOURCE_FILENAME,
      rawBytes: POPULATION_SOURCE_BYTES,
      rawSha256: POPULATION_SOURCE_SHA256,
      usedColumns: ['區域別代碼', '村里', '戶數', '人口數'],
    },
  ],
  files: { topology: topologyAsset, attributes: attributesAsset },
};
const manifestText = JSON.stringify(manifest);
assert(!PRIVATE_USE.test(manifestText), 'Village manifest contains a Unicode private-use character');
const manifestBuffer = Buffer.from(manifestText);

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, TOPOLOGY_FILENAME), topologyBuffer);
await writeFile(resolve(outputDir, ATTRIBUTE_FILENAME), attributesBuffer);
await writeFile(resolve(outputDir, MANIFEST_FILENAME), manifestBuffer);

process.stdout.write(
  `Built ${villages.length} villages (${populationByCode.size} with population, ${unmatchedCodes.length} unmatched; ` +
    `population ${populationTotal.toLocaleString()}).\n` +
    `Topology: ${topologyAsset.bytes} bytes raw, ${topologyAsset.gzipBytes} gzip.\n` +
    `Attributes: ${attributesAsset.bytes} bytes raw, ${attributesAsset.gzipBytes} gzip.\n` +
    `Manifest: ${manifestBuffer.byteLength} bytes raw, ${gzipSync(manifestBuffer, { level: 9, mtime: 0 }).byteLength} gzip.\n`,
);
