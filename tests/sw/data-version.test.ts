import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeDataVersion } from "../../src/sw/data-version";

describe("composeDataVersion", () => {
  it("composes the current town, village boundary and population versions", () => {
    const townManifest = JSON.parse(readFileSync(new URL("../../public/data/manifest.json", import.meta.url), "utf8")) as unknown;
    const villageManifest = JSON.parse(readFileSync(new URL("../../public/data/villages-manifest.json", import.meta.url), "utf8")) as unknown;

    expect(composeDataVersion(
      townManifest,
      villageManifest,
    )).toBe("1140318-v1150817-p11510");
  });

  it("throws when the town dataVersion is missing", () => {
    expect(() => composeDataVersion({}, { dataVersion: "1150817+11510" }))
      .toThrow("Town manifest dataVersion must be a non-empty numeric string");
  });

  it("throws when the village dataVersion is missing", () => {
    expect(() => composeDataVersion({ dataVersion: "1140318" }, {}))
      .toThrow("Village manifest dataVersion must contain boundary and population versions separated by '+'");
  });

  it("throws when the village dataVersion does not separate its versions with '+'", () => {
    expect(() => composeDataVersion(
      { dataVersion: "1140318" },
      { dataVersion: "1150817" },
    )).toThrow("Village manifest dataVersion must contain boundary and population versions separated by '+'");
  });
});
