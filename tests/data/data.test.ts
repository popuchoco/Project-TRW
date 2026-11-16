import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bboxForGeometry, pointInMultiPolygon } from '../../src/map/geo';
import { lookupTown } from '../../src/map/hit';
import { decodeTopology } from '../../src/map/topology';
import type { DataManifest, GeoFeature, Topology, TownProperties } from '../../src/map/types';

const dataDir = resolve(process.cwd(), 'public/data');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as DataManifest;

function readTopology(path: string): Topology {
  return JSON.parse(readFileSync(resolve(dataDir, path), 'utf8')) as Topology;
}

function readLodFeatures(lodId: DataManifest['lods'][number]['id']): GeoFeature<TownProperties>[] {
  const lod = manifest.lods.find(({ id }) => id === lodId);
  if (!lod) throw new Error(`Missing ${lodId} from manifest`);
  return lod.files.flatMap(({ path }) => decodeTopology(readTopology(path)));
}

function countArcPositions(topology: Topology): number {
  return topology.arcs.reduce((count, arc) => count + arc.length, 0);
}

function inRange(bbox: number[], minLon: number, maxLon: number, minLat: number, maxLat: number): boolean {
  return bbox[0]! >= minLon && bbox[2]! <= maxLon && bbox[1]! >= minLat && bbox[3]! <= maxLat;
}

describe('generated Taiwan administrative map data', () => {
  const lod0Features = readLodFeatures('lod0');
  const lod1Features = readLodFeatures('lod1');
  const mainTowns = lod0Features.filter(({ properties }) => !properties.inset);
  const lod1MainTowns = lod1Features.filter(({ properties }) => !properties.inset);
  const insetFeatures = lod0Features.filter(({ properties }) => properties.inset);

  it('contains 368 unique towns, 22 counties and the required town suffix totals', () => {
    expect(mainTowns).toHaveLength(368);
    expect(new Set(mainTowns.map(({ properties }) => properties.TOWNCODE)).size).toBe(368);
    expect(manifest.towns).toHaveLength(368);
    expect(manifest.counties).toHaveLength(22);

    const suffixCounts = { 區: 0, 鄉: 0, 鎮: 0, 市: 0 };
    for (const town of manifest.towns) {
      const suffix = town.name.at(-1) as keyof typeof suffixCounts;
      if (suffix in suffixCounts) suffixCounts[suffix] += 1;
    }
    expect(suffixCounts).toEqual({ 區: 170, 鄉: 146, 鎮: 38, 市: 14 });

    expect(manifest.towns.some(({ code, name }) => code === '09020060' && name === '烏坵鄉')).toBe(true);
    expect(manifest.counties.find(({ name }) => name === '金門縣')?.townCount).toBe(6);
    expect(manifest.counties.find(({ name }) => name === '連江縣')?.townCount).toBe(4);
    expect(manifest.counties.find(({ name }) => name === '澎湖縣')?.townCount).toBe(6);
  });

  it('keeps the three inset features with the correct town ownership and locations', () => {
    expect(insetFeatures).toHaveLength(3);
    expect(manifest.insets).toHaveLength(3);
    const expected = new Map([
      ['diaoyutai', '10002040'],
      ['dongsha', '64000100'],
      ['nansha', '64000100'],
    ]);
    for (const [id, code] of expected) {
      const feature = insetFeatures.find(({ properties }) => properties.inset === id);
      const inset = manifest.insets.find((entry) => entry.id === id);
      expect(feature?.properties.TOWNCODE).toBe(code);
      expect(inset?.townCode).toBe(code);
      expect(inset?.partCount).toBeGreaterThan(0);
      expect(feature).toBeDefined();
      expect(bboxForGeometry(feature!.geometry)[0]).toBeGreaterThan(inset!.bbox[0] - 0.02);
      expect(bboxForGeometry(feature!.geometry)[2]).toBeLessThan(inset!.bbox[2] + 0.02);
    }
    expect(inRange(manifest.insets.find(({ id }) => id === 'diaoyutai')!.bbox, 123, 125, 24, 27)).toBe(true);
    expect(inRange(manifest.insets.find(({ id }) => id === 'dongsha')!.bbox, 116, 118, 20, 22)).toBe(true);
    expect(inRange(manifest.insets.find(({ id }) => id === 'nansha')!.bbox, 113, 116, 9, 12)).toBe(true);
  });

  it('keeps Diaoyutai and the South China Sea parts out of the two main town geometries', () => {
    const head = mainTowns.find(({ properties }) => properties.TOWNCODE === '10002040');
    const cijin = mainTowns.find(({ properties }) => properties.TOWNCODE === '64000100');
    expect(head).toBeDefined();
    expect(cijin).toBeDefined();
    expect(bboxForGeometry(head!.geometry)[2]).toBeLessThanOrEqual(123);
    expect(bboxForGeometry(head!.geometry)[0]).toBeGreaterThanOrEqual(118);
    expect(bboxForGeometry(cijin!.geometry)[2]).toBeLessThanOrEqual(123);
    expect(bboxForGeometry(cijin!.geometry)[0]).toBeGreaterThanOrEqual(118);
    expect(pointInMultiPolygon(head!.geometry.coordinates, 121.95, 24.84)).toBe(true);

    for (const audit of Object.values(manifest.splitAudit.towns) as Array<{
      raw: { partCount: number; ringCount: number; vertexCount: number };
      mainPlusInsets: { partCount: number; ringCount: number; vertexCount: number };
      preserved: boolean;
    }>) {
      expect(audit.preserved).toBe(true);
      expect(audit.mainPlusInsets).toEqual(audit.raw);
    }
  });

  it('records the source and the Majia Sanhe layer metadata', () => {
    expect(manifest.dataVersion).toBe('1140318');
    expect(manifest.source.agency).toBe('內政部國土測繪中心');
    expect(manifest.source.rawBytes).toBe(12_801_023);
    expect(manifest.source.rawSha256).toBe('c5dc6c0f9a8cc1aad6758a0a6fb81b203718b37f42c5aa8e684262ca24a7d9dd');
    expect(manifest.specialAreas).toHaveLength(1);
    expect(manifest.specialAreas[0]?.id).toBe('majia-sanhe');
    expect(manifest.specialAreas[0]?.featureCount).toBeGreaterThan(0);
    expect(manifest.specialAreas[0]?.attributes.length).toBeGreaterThan(0);
  });

  it('has strictly increasing detail from LOD0 through LOD3 and all 368 towns in every LOD', () => {
    const lods = manifest.lods;
    expect(lods.map(({ id }) => id)).toEqual(['lod0', 'lod1', 'lod2', 'lod3']);
    expect(lods[3]!.vertexCount).toBeGreaterThan(lods[2]!.vertexCount);
    expect(lods[2]!.vertexCount).toBeGreaterThan(lods[1]!.vertexCount);
    expect(lods[1]!.vertexCount).toBeGreaterThan(lods[0]!.vertexCount);

    for (const lod of lods) {
      const features = readLodFeatures(lod.id);
      const towns = features.filter(({ properties }) => !properties.inset);
      const insets = features.filter(({ properties }) => properties.inset);
      expect(towns).toHaveLength(368);
      expect(new Set(towns.map(({ properties }) => properties.TOWNCODE)).size).toBe(368);
      expect(insets.map(({ properties }) => [properties.inset, properties.TOWNCODE]).sort()).toEqual([
        ['diaoyutai', '10002040'],
        ['dongsha', '64000100'],
        ['nansha', '64000100'],
      ]);
      const actualVertices = lod.files.reduce((sum, { path }) => sum + countArcPositions(readTopology(path)), 0);
      expect(actualVertices).toBe(lod.vertexCount);
    }
  });

  it('matches every LOD manifest byte count and SHA-256 to the committed file', () => {
    for (const lod of manifest.lods) {
      for (const file of lod.files) {
        const bytes = readFileSync(resolve(dataDir, file.path));
        expect(bytes.byteLength).toBe(file.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      }
    }
  });

  it('looks up the expected towns for Taipei Main Station, Magong and Jincheng', () => {
    expect(lookupTown(lod1MainTowns, 121.517, 25.0478)?.properties.TOWNCODE).toBe('63000050');
    expect(lookupTown(lod1MainTowns, 119.566, 23.566)?.properties.TOWNCODE).toBe('10016010');
    expect(lookupTown(lod1MainTowns, 118.317, 24.432)?.properties.TOWNCODE).toBe('09020010');
  });
});
