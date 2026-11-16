import { decodeTopology } from './topology';
import type { LodId } from './lod';
import type { DataManifest, GeoFeature, Topology, TownProperties } from './types';

type Features = GeoFeature<TownProperties>[];

/** Same-origin static data loader with one in-flight request/cache per topology file. */
export class MapDataLoader {
  private readonly files = new Map<string, Promise<Features>>();
  private manifestPromise?: Promise<DataManifest>;

  constructor(private readonly baseUrl: string = import.meta.env.BASE_URL) {}

  loadManifest(): Promise<DataManifest> {
    this.manifestPromise ??= this.fetchJson<DataManifest>('data/manifest.json');
    return this.manifestPromise;
  }

  async loadLod(id: Exclude<LodId, 'lod3'>): Promise<Features> {
    const manifest = await this.loadManifest();
    const lod = manifest.lods.find((entry) => entry.id === id);
    if (!lod) throw new Error(`Missing ${id} in map manifest`);
    const files = await Promise.all(lod.files.map(({ path }) => this.loadFeatures(path)));
    return files.flat();
  }

  async loadInsets(): Promise<Features> {
    const manifest = await this.loadManifest();
    return this.loadFeatures(manifest.insetAsset.path);
  }

  async loadCountyLod3(countyCode: string): Promise<Features> {
    const manifest = await this.loadManifest();
    const lod = manifest.lods.find((entry) => entry.id === 'lod3');
    const file = lod?.files.find(({ path }) => path.endsWith(`/${countyCode}.topo.json`));
    if (!file) throw new Error(`Missing LOD3 topology for county ${countyCode}`);
    return this.loadFeatures(file.path);
  }

  private loadFeatures(path: string): Promise<Features> {
    let cached = this.files.get(path);
    if (!cached) {
      cached = this.fetchJson<Topology>(`data/${path}`).then((topology) => decodeTopology(topology));
      this.files.set(path, cached);
      void cached.catch(() => this.files.delete(path));
    }
    return cached;
  }

  private async fetchJson<T>(relativePath: string): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const response = await fetch(`${base}${relativePath}`);
    if (!response.ok) throw new Error(`Map data request failed (${response.status}): ${relativePath}`);
    return await response.json() as T;
  }
}
