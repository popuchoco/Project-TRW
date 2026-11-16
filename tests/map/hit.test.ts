import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bboxForGeometry } from '../../src/map/geo';
import { buildTownIndex, lookupInset, lookupTownIndexed } from '../../src/map/hit';
import { decodeTopology } from '../../src/map/topology';
import type { DataManifest, GeoFeature, Topology, TownProperties } from '../../src/map/types';

const dataDir = resolve(process.cwd(), 'public/data');
const manifest = JSON.parse(readFileSync(resolve(dataDir, 'manifest.json'), 'utf8')) as DataManifest;

function loadLod(id: 'lod1' | 'lod2'): GeoFeature<TownProperties>[] {
  const lod = manifest.lods.find((entry) => entry.id === id);
  if (!lod) throw new Error(`Missing ${id}`);
  return lod.files.flatMap(({ path }) => {
    const topology = JSON.parse(readFileSync(resolve(dataDir, path), 'utf8')) as Topology;
    return decodeTopology(topology);
  });
}

function loadInsets(): GeoFeature<TownProperties>[] {
  const topology = JSON.parse(readFileSync(resolve(dataDir, manifest.insetAsset.path), 'utf8')) as Topology;
  return decodeTopology(topology);
}

function findInsetPoint(feature: GeoFeature<TownProperties>): [number, number] | undefined {
  const [minLon, minLat, maxLon, maxLat] = bboxForGeometry(feature.geometry);
  const step = 0.01;
  for (let lat = minLat + step / 2; lat < maxLat; lat += step) {
    for (let lon = minLon + step / 2; lon < maxLon; lon += step) {
      if (lookupInset([feature], String(feature.properties.inset), lon, lat)) return [lon, lat];
    }
  }
  return undefined;
}

describe('spatially indexed town hit tests', () => {
  const lod1 = loadLod('lod1');
  const insets = loadInsets();
  const index = buildTownIndex(lod1);

  it('hits Taipei Main Station, Magong and Jincheng from LOD1', () => {
    expect(lookupTownIndexed(index, 121.517, 25.0478)?.properties.TOWNCODE).toBe('63000050');
    expect(lookupTownIndexed(index, 119.566, 23.566)?.properties.TOWNCODE).toBe('10016010');
    expect(lookupTownIndexed(index, 118.317, 24.432)?.properties.TOWNCODE).toBe('09020010');
  });

  it('hits the owning towns inside Diaoyutai and Dongsha inset geometry', () => {
    const diaoyutai = insets.find(({ properties }) => properties.inset === 'diaoyutai');
    const dongsha = insets.find(({ properties }) => properties.inset === 'dongsha');
    expect(diaoyutai).toBeDefined();
    expect(dongsha).toBeDefined();

    const diaoyutaiPoint = findInsetPoint(diaoyutai!);
    const dongshaPoint = findInsetPoint(dongsha!);
    expect(diaoyutaiPoint).toBeDefined();
    expect(dongshaPoint).toBeDefined();
    expect(lookupInset(insets, 'diaoyutai', ...diaoyutaiPoint!)?.properties.TOWNCODE).toBe('10002040');
    expect(lookupInset(insets, 'dongsha', ...dongshaPoint!)?.properties.TOWNCODE).toBe('64000100');
  });
});
