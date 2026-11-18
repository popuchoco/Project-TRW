function getRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} manifest must be an object`);
  }

  return value as Record<string, unknown>;
}

function getTownDataVersion(manifest: unknown): string {
  const version = getRecord(manifest, "Town").dataVersion;
  if (typeof version !== "string" || !/^\d+$/.test(version)) {
    throw new Error("Town manifest dataVersion must be a non-empty numeric string");
  }

  return version;
}

function getVillageDataVersions(manifest: unknown): { boundary: string; population: string } {
  const version = getRecord(manifest, "Village").dataVersion;
  if (typeof version !== "string") {
    throw new Error("Village manifest dataVersion must contain boundary and population versions separated by '+'");
  }

  const match = /^(\d+)\+(\d+)$/.exec(version);
  if (!match?.[1] || !match[2]) {
    throw new Error("Village manifest dataVersion must contain boundary and population versions separated by '+'");
  }

  return { boundary: match[1], population: match[2] };
}

export function composeDataVersion(townManifest: unknown, villageManifest: unknown): string {
  const townVersion = getTownDataVersion(townManifest);
  const villageVersions = getVillageDataVersions(villageManifest);
  return `${townVersion}-v${villageVersions.boundary}-p${villageVersions.population}`;
}
