import type {
  GeoFeature,
  MultiPolygonGeometry,
  PolygonCoordinates,
  Position,
  Topology,
  TopologyGeometry,
  TownProperties,
} from './types';

function decodeArc(topology: Topology, arcIndex: number): Position[] {
  const reversed = arcIndex < 0;
  const index = reversed ? ~arcIndex : arcIndex;
  const arc = topology.arcs[index];
  if (!arc) throw new Error(`TopoJSON arc index ${arcIndex} is out of range`);

  let x = 0;
  let y = 0;
  const positions = arc.map(([first, second]) => {
    if (topology.transform) {
      x += first;
      y += second;
      return [
        x * topology.transform.scale[0] + topology.transform.translate[0],
        y * topology.transform.scale[1] + topology.transform.translate[1],
      ] as Position;
    }
    return [first, second] as Position;
  });
  return reversed ? positions.reverse() : positions;
}

function joinArcs(topology: Topology, arcIndexes: number[]): Position[] {
  const ring: Position[] = [];
  for (const arcIndex of arcIndexes) {
    const arc = decodeArc(topology, arcIndex);
    const start = ring.length > 0 && arc.length > 0 ? 1 : 0;
    ring.push(...arc.slice(start));
  }
  return ring;
}

function decodePolygon(topology: Topology, rings: number[][]): PolygonCoordinates[number] {
  return rings.map((ring) => joinArcs(topology, ring));
}

function decodeGeometry(topology: Topology, geometry: TopologyGeometry): MultiPolygonGeometry {
  if (geometry.type === 'Polygon') {
    return { type: 'MultiPolygon', coordinates: [decodePolygon(topology, geometry.arcs)] };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.arcs.map((polygon) => decodePolygon(topology, polygon)),
    };
  }
  throw new Error('Expected polygon geometry in administrative boundary topology');
}

function collectGeometries(
  topology: Topology,
  geometry: TopologyGeometry,
  features: GeoFeature<TownProperties>[],
): void {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) collectGeometries(topology, child, features);
    return;
  }
  features.push({
    type: 'Feature',
    ...(geometry.id === undefined ? {} : { id: geometry.id }),
    properties: (geometry.properties ?? {}) as TownProperties,
    geometry: decodeGeometry(topology, geometry),
  });
}

/** Decode one named object, or every object when omitted, into polygon features. */
export function decodeTopology(
  topology: Topology,
  objectName?: string,
): GeoFeature<TownProperties>[] {
  if (topology.type !== 'Topology') throw new Error('Invalid TopoJSON: expected a Topology');
  const selected = objectName ? topology.objects[objectName] : undefined;
  if (objectName && !selected) throw new Error(`TopoJSON object "${objectName}" was not found`);
  const objects = selected ? [selected] : Object.values(topology.objects);
  const features: GeoFeature<TownProperties>[] = [];
  for (const object of objects) collectGeometries(topology, object, features);
  return features;
}
