import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bboxForTowns,
  chooseInitialMetroBounds,
  TAIPEI_CORE_TOWNCODES,
  villageBoundsFromGeometry,
} from '../../src/city/metro-focus';
import {
  decodeVillageGeometry,
  type VillageGeometryAttribute,
} from '../../src/map/village-geometry';
import type { BBox, Topology } from '../../src/map/types';

interface VillageManifest {
  files: {
    topology: { path: string; objectName: string };
    attributes: { path: string };
  };
}

const villageManifest = JSON.parse(
  readFileSync(new URL('../../public/data/villages-manifest.json', import.meta.url), 'utf8'),
) as VillageManifest;
const attributes = JSON.parse(
  readFileSync(new URL(`../../public/data/${villageManifest.files.attributes.path}`, import.meta.url), 'utf8'),
) as VillageGeometryAttribute[];
const topology = JSON.parse(
  readFileSync(new URL(`../../public/data/${villageManifest.files.topology.path}`, import.meta.url), 'utf8'),
) as Topology;
const geometry = decodeVillageGeometry(topology, attributes);
const villageBounds = villageBoundsFromGeometry(geometry);

function contains(bounds: BBox, longitude: number, latitude: number): boolean {
  return longitude >= bounds[0] && longitude <= bounds[2]
    && latitude >= bounds[1] && latitude <= bounds[3];
}

describe('North–North metro focus bounds', () => {
  it('includes every Taipei City village bbox in the core union', () => {
    const core = bboxForTowns(villageBounds, TAIPEI_CORE_TOWNCODES)!;
    const taipeiVillages = villageBounds.filter(({ TOWNCODE }) => TOWNCODE.startsWith('63000'));

    expect(taipeiVillages.length).toBeGreaterThan(0);
    for (const { bbox } of taipeiVillages) {
      expect(bbox[0]).toBeGreaterThanOrEqual(core[0]);
      expect(bbox[1]).toBeGreaterThanOrEqual(core[1]);
      expect(bbox[2]).toBeLessThanOrEqual(core[2]);
      expect(bbox[3]).toBeLessThanOrEqual(core[3]);
    }
  });

  it('excludes the bbox centers of Wulai, Shimen and Gongliao', () => {
    const core = bboxForTowns(villageBounds, TAIPEI_CORE_TOWNCODES)!;
    const outerTownCodes = new Set(['65000290', '65000220', '65000260']);
    const outerVillages = villageBounds.filter(({ TOWNCODE }) => outerTownCodes.has(TOWNCODE));

    expect(new Set(outerVillages.map(({ TOWNCODE }) => TOWNCODE))).toEqual(outerTownCodes);
    for (const { bbox } of outerVillages) {
      expect(contains(core, (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)).toBe(false);
    }
  });

  it('keeps a saved metro camera ahead of the initial core bounds', () => {
    const core = bboxForTowns(villageBounds, TAIPEI_CORE_TOWNCODES)!;
    const all = bboxForTowns(villageBounds, villageBounds.map(({ TOWNCODE }) => TOWNCODE))!;
    const savedCamera = { x: 12, y: 34, zoom: 2.5 };

    expect(chooseInitialMetroBounds({ savedCamera, core, all })).toBeUndefined();
    expect(chooseInitialMetroBounds({ core, all })).toEqual(core);
  });
});
