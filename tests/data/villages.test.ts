import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pointInMultiPolygon } from '../../src/map/geo';
import { decodeTopology } from '../../src/map/topology';
import type { DataManifest, MultiPolygonGeometry, Topology } from '../../src/map/types';

interface VillageAttribute {
  VILLCODE: string;
  name: string;
  TOWNCODE: string;
  townName: string;
  population: number;
  households: number;
  populationMatched: boolean;
  demandPoint: [number, number];
}

interface VillageFileEntry {
  path: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
}

interface VillageManifest {
  dataVersion: string;
  villageCount: number;
  populationMatchedCount: number;
  unmatchedCount: number;
  unmatchedCodes: string[];
  unmatchedReason: string;
  populationTotal: number;
  townCodeCount: number;
  townCodes: string[];
  nameRule: string;
  sources: Array<{
    agency: string;
    name: string;
    version: string;
    rawFilename: string;
    rawBytes: number;
    rawSha256: string;
    license: { name: string; url: string };
  }>;
  files: { topology: VillageFileEntry & { objectName: string }; attributes: VillageFileEntry };
}

const dataDir = resolve(process.cwd(), 'public/data');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'villages-manifest.json'), 'utf8')) as VillageManifest;
const townManifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as DataManifest;
const attributes = JSON.parse(
  readFileSync(resolve(dataDir, manifest.files.attributes.path), 'utf8'),
) as VillageAttribute[];
const topologyText = readFileSync(resolve(dataDir, manifest.files.topology.path), 'utf8');
const topology = JSON.parse(topologyText) as Topology;
const features = decodeTopology(topology, manifest.files.topology.objectName);
const geometryByCode = new Map(
  features.map(({ properties, geometry }) => [String((properties as Record<string, unknown>).VILLCODE), geometry]),
);
const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

describe('generated Taipei/New Taipei village data', () => {
  it('contains the expected village, population, unassigned and population totals', () => {
    expect(attributes).toHaveLength(1_512);
    expect(new Set(attributes.map(({ VILLCODE }) => VILLCODE)).size).toBe(1_512);
    expect(attributes.filter(({ populationMatched }) => populationMatched)).toHaveLength(1_495);
    expect(attributes.filter(({ populationMatched }) => !populationMatched)).toHaveLength(17);
    expect(attributes.filter(({ populationMatched, population, households }) =>
      !populationMatched && population === 0 && households === 0,
    )).toHaveLength(17);
    expect(manifest.unmatchedCount).toBe(17);
    expect(manifest.unmatchedCodes).toHaveLength(17);
    expect(manifest.unmatchedReason).toBe('NOTE=未編定村里');
    expect(attributes.reduce((total, { population }) => total + population, 0)).toBe(6_451_184);
    expect(manifest.populationTotal).toBe(6_451_184);
  });

  it('matches exactly the 41 Taipei/New Taipei TOWNCODEs in the town assets', () => {
    const villageCodes = [...new Set(attributes.map(({ TOWNCODE }) => TOWNCODE))].sort();
    const townCodes = townManifest.towns
      .filter(({ countyCode }) => ['63000', '65000'].includes(countyCode))
      .map(({ code }) => code)
      .sort();
    expect(villageCodes).toHaveLength(41);
    expect(manifest.townCodeCount).toBe(41);
    expect(villageCodes).toEqual(townCodes);
    expect(manifest.townCodes).toEqual(townCodes);
  });

  it('keeps every demand point inside its decoded village polygon', () => {
    expect(geometryByCode.size).toBe(1_512);
    for (const village of attributes) {
      const geometry = geometryByCode.get(village.VILLCODE) as MultiPolygonGeometry | undefined;
      expect(geometry, village.VILLCODE).toBeDefined();
      expect(
        pointInMultiPolygon(geometry!.coordinates, village.demandPoint[0], village.demandPoint[1]),
        village.VILLCODE,
      ).toBe(true);
      expect(village.demandPoint.map((coordinate) => Number(coordinate.toFixed(8)))).toEqual(village.demandPoint);
    }
  });

  it('preserves boundary square brackets in display names', () => {
    expect(manifest.nameRule).toContain('square brackets are preserved');
    expect(attributes.find(({ VILLCODE }) => VILLCODE === '65000030017')?.name).toBe('瓦[磘]里');
    expect(attributes.some(({ name }) => name.includes('[') && name.includes(']'))).toBe(true);
  });

  it('contains no private-use characters and excludes age columns from attributes', () => {
    const attributesText = JSON.stringify(attributes);
    const manifestText = readFileSync(resolve(dataDir, 'villages-manifest.json'), 'utf8');
    expect(PRIVATE_USE.test(attributesText)).toBe(false);
    expect(PRIVATE_USE.test(topologyText)).toBe(false);
    expect(PRIVATE_USE.test(manifestText)).toBe(false);
    expect(Object.keys(attributes[0] ?? {})).toEqual([
      'VILLCODE',
      'name',
      'TOWNCODE',
      'townName',
      'population',
      'households',
      'populationMatched',
      'demandPoint',
    ]);
    expect(attributes.some((village) => Object.keys(village).some((key) => key.includes('歲')))).toBe(false);
  });

  it('pins both sources and records the generated asset sizes and hashes', () => {
    expect(manifest.dataVersion).toBe('1150817+11510');
    expect(manifest.sources.map(({ version }) => version)).toEqual(['1150817', '11510']);
    expect(manifest.sources.map(({ rawFilename, rawBytes, rawSha256 }) => [rawFilename, rawBytes, rawSha256])).toEqual([
      ['village.zip', 21_618_481, 'c6cc09589cfdc073df6ca85b84be5f76a92c268774a44744fda341766479ef62'],
      ['pop11510.csv', 4_409_830, 'd3a334b52aa2ac2d887ae263368999efa108905ded90f09dd728a5d738455c98'],
    ]);
    expect(manifest.sources.every(({ license }) => license.name === '政府資料開放授權條款第1版')).toBe(true);

    for (const asset of [manifest.files.topology, manifest.files.attributes]) {
      const bytes = readFileSync(resolve(dataDir, asset.path));
      expect(bytes.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
      expect(gzipSync(bytes, { level: 9 }).byteLength).toBe(asset.gzipBytes);
    }
  });

  it('stores only VILLCODE on shared-boundary topology features', () => {
    const object = topology.objects[manifest.files.topology.objectName];
    expect(object?.type).toBe('GeometryCollection');
    if (!object || object.type !== 'GeometryCollection') return;
    expect(object.geometries).toHaveLength(1_512);
    const featureCodes: string[] = [];
    for (const geometry of object.geometries) {
      if (geometry.type === 'GeometryCollection') throw new Error('Village features must be polygons');
      expect(Object.keys(geometry.properties ?? {})).toEqual(['VILLCODE']);
      featureCodes.push(String(geometry.properties?.VILLCODE ?? ''));
    }
    expect(featureCodes).toEqual([...featureCodes].sort());

    const arcReferences = new Map<number, Set<string>>();
    for (const geometry of object.geometries) {
      if (geometry.type === 'GeometryCollection') continue;
      const references = geometry.type === 'Polygon'
        ? geometry.arcs.flat(1)
        : geometry.type === 'MultiPolygon'
          ? geometry.arcs.flat(2)
          : [];
      for (const reference of references) {
        const arcIndex = reference < 0 ? ~reference : reference;
        const villagesUsingArc = arcReferences.get(arcIndex) ?? new Set<string>();
        villagesUsingArc.add(String(geometry.properties?.VILLCODE ?? ''));
        arcReferences.set(arcIndex, villagesUsingArc);
      }
    }
    expect([...arcReferences.values()].some((codes) => codes.size > 1)).toBe(true);
  });
});
