export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];
export type Position = [longitude: number, latitude: number];
export type PolygonCoordinates = Position[][][];

export interface TownProperties extends Record<string, string | number | boolean | null | undefined> {
  TOWNCODE: string;
  COUNTYCODE: string;
  COUNTYNAME: string;
  TOWNNAME: string;
  TOWNENG: string;
  inset?: string;
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: PolygonCoordinates;
}

export interface GeoFeature<P extends Record<string, unknown> = TownProperties> {
  type: 'Feature';
  id?: string | number;
  properties: P;
  geometry: MultiPolygonGeometry;
}

export interface Transform {
  scale: [number, number];
  translate: [number, number];
}

export interface TopologyPolygon {
  type: 'Polygon';
  arcs: number[][];
  properties?: Record<string, string | number | boolean | null>;
  id?: string | number;
}

export interface TopologyMultiPolygon {
  type: 'MultiPolygon';
  arcs: number[][][];
  properties?: Record<string, string | number | boolean | null>;
  id?: string | number;
}

export interface TopologyGeometryCollection {
  type: 'GeometryCollection';
  geometries: TopologyGeometry[];
}

export type TopologyGeometry = TopologyPolygon | TopologyMultiPolygon | TopologyGeometryCollection;

export interface Topology {
  type: 'Topology';
  arcs: Position[][];
  transform?: Transform;
  objects: Record<string, TopologyGeometry>;
}

export interface AssetFile {
  path: string;
  bytes: number;
  sha256: string;
  gzipBytes: number;
}

export interface LodManifest {
  id: 'lod0' | 'lod1' | 'lod2' | 'lod3';
  simplifyPct: number;
  files: AssetFile[];
  vertexCount: number;
}

export interface InsetAssetManifestEntry extends AssetFile {
  vertexCount: number;
  simplifyPct: number;
  quantization: number;
}

export interface TownManifestEntry {
  code: string;
  countyCode: string;
  county: string;
  name: string;
  eng: string;
  bbox: BBox;
  insetBboxes?: Array<{ id: string; bbox: BBox }>;
}

export interface CountyManifestEntry {
  code: string;
  name: string;
  bbox: BBox;
  townCount: number;
}

export interface InsetManifestEntry {
  id: string;
  townCode: string;
  bbox: BBox;
  partCount: number;
}

export interface GeometryCounts {
  partCount: number;
  ringCount: number;
  vertexCount: number;
}

export interface DataManifest {
  schemaVersion: number;
  dataVersion: string;
  source: {
    agency: string;
    name: string;
    version: string;
    sourceUrl: string;
    downloadUrl: string;
    licenseName: string;
    licenseUrl: string;
    rawSha256: string;
    rawBytes: number;
    note: string;
  };
  vertexCountMethod: string;
  lod3Layout: string;
  insetAsset: InsetAssetManifestEntry;
  lods: LodManifest[];
  totals: Record<string, number>;
  towns: TownManifestEntry[];
  counties: CountyManifestEntry[];
  insets: InsetManifestEntry[];
  specialAreas: Array<{
    id: string;
    name: string;
    featureCount: number;
    attributes: string[];
    bbox: BBox;
    note: string;
  }>;
  splitAudit: {
    comparison: string;
    towns: Record<string, {
      raw: GeometryCounts;
      main: GeometryCounts;
      insets: Record<string, GeometryCounts>;
      mainPlusInsets: GeometryCounts;
      preserved: boolean;
    }>;
    rawTotals: GeometryCounts;
    mainTotals: GeometryCounts;
    insetTotals: GeometryCounts;
  };
}
