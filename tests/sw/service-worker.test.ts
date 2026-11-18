import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCacheNames, CACHE_MATCH_OPTIONS, deleteObsoleteTrwCaches, type CacheStorageKeys } from "../../src/sw/cache";
import { buildPrecacheList } from "../../src/sw/precache";
import { classifyRequest } from "../../src/sw/routes";

describe("service worker cache names", () => {
  it("includes the app, town and village data versions, and precache build hash", () => {
    expect(buildCacheNames("0.0.0", "1140318-v1150817-p11510", "12ab34cd")).toEqual({
      shell: "trw-shell-v0.0.0-d1140318-v1150817-p11510-b12ab34cd",
      runtime: "trw-runtime-v0.0.0-d1140318-v1150817-p11510-b12ab34cd",
    });
  });

  it("creates different cache names when the precache list changes", async () => {
    const hashList = async (paths: readonly string[]): Promise<string> => {
      const { createHash } = await import("node:crypto");
      return createHash("sha256").update(JSON.stringify(paths)).digest("hex").slice(0, 8);
    };
    const first = buildCacheNames("0.0.0", "1140318-v1150817-p11510", await hashList(["./index.html", "./assets/app-a.js"]));
    const second = buildCacheNames("0.0.0", "1140318-v1150817-p11510", await hashList(["./index.html", "./assets/app-b.js"]));

    expect(first).not.toEqual(second);
    expect(first.shell).not.toBe(second.shell);
    expect(first.runtime).not.toBe(second.runtime);
  });

  it("deletes obsolete trw caches and keeps current and unrelated caches", async () => {
    const names = buildCacheNames("0.0.0", "1140318-v1150817-p11510", "12ab34cd");
    const existing = [names.shell, names.runtime, "trw-shell-old", "trw-runtime-old", "other-app-cache"];
    const deleted: string[] = [];
    const storage: CacheStorageKeys = {
      async keys() { return existing; },
      async delete(name) {
        deleted.push(name);
        return true;
      },
    };

    await deleteObsoleteTrwCaches(storage, names);

    expect(deleted.sort()).toEqual(["trw-runtime-old", "trw-shell-old"]);
  });
});

describe("service worker cache matching", () => {
  it("ignores Vary so precached crossorigin module scripts match offline", () => {
    expect(CACHE_MATCH_OPTIONS).toEqual({ ignoreVary: true });
  });
});

describe("service worker routes", () => {
  const scope = "https://example.test/game/";

  it("classifies same-origin navigations for the offline app shell", () => {
    expect(classifyRequest({ method: "GET", mode: "navigate", url: `${scope}route/` }, scope)).toBe("navigation");
  });

  it("uses the runtime cache for same-origin GET assets", () => {
    expect(classifyRequest({ method: "GET", url: `${scope}data/lod2.topo.json` }, scope)).toBe("runtime");
  });

  it("ignores writes and cross-origin requests", () => {
    expect(classifyRequest({ method: "POST", url: `${scope}save` }, scope)).toBe("ignore");
    expect(classifyRequest({ method: "GET", url: "https://other.test/data.json" }, scope)).toBe("ignore");
  });
});

describe("precache list", () => {
  it("includes the Taipei/New Taipei village manifest, population and topology files", () => {
    const list = buildPrecacheList([]);
    expect(list).toContain("./data/villages-manifest.json");
    expect(list).toContain("./data/villages-6300065000.json");
    expect(list).toContain("./data/villages-6300065000.topo.json");
  });

  it("includes the Taoyuan village manifest, population and topology files", () => {
    const list = buildPrecacheList([]);
    expect(list).toContain("./data/villages-68000-manifest.json");
    expect(list).toContain("./data/villages-68000.json");
    expect(list).toContain("./data/villages-68000.topo.json");
  });

  it("includes LOD2 and the LOD3 counties the 北北 metro view loads, so offline 北北 has map detail", () => {
    const list = buildPrecacheList([]);
    expect(list).toContain("./data/trw-1140318-lod2.topo.json");
    for (const county of ["63000", "65000", "10017", "68000", "10002", "10004", "10005", "10018"]) {
      expect(list).toContain(`./data/lod3/${county}.topo.json`);
    }
    expect(list).not.toContain("./data/lod3/64000.topo.json");
  });

  it("only lists data files that exist in public/", () => {
    for (const path of buildPrecacheList([]).filter((entry) => entry.startsWith("./data/"))) {
      expect(existsSync(resolve(process.cwd(), "public", path)), path).toBe(true);
    }
  });

  it("includes the shell, generated scripts/styles, data manifest, LOD0/LOD1, and insets", () => {
    const list = buildPrecacheList(["./assets/index-abcd.js", "./assets/index-1234.css"]);
    expect(list).toContain("./index.html");
    expect(list).toContain("./assets/index-abcd.js");
    expect(list).toContain("./assets/index-1234.css");
    expect(list).toContain("./manifest.webmanifest");
    expect(list).toContain("./icons/icon-192.png");
    expect(list).toContain("./icons/icon-512.png");
    expect(list).toContain("./data/manifest.json");
    expect(list).toContain("./data/trw-1140318-lod0.topo.json");
    expect(list).toContain("./data/trw-1140318-lod1.topo.json");
    expect(list).toContain("./data/trw-1140318-insets.topo.json");
  });

  it("deduplicates generated paths", () => {
    const list = buildPrecacheList(["./index.html", "./assets/app.js", "./assets/app.js"]);
    expect(list.filter((path) => path === "./assets/app.js")).toHaveLength(1);
  });

  it("precaches emitted JavaScript worker assets", () => {
    const list = buildPrecacheList(["./assets/index-abcd.js", "./assets/sim.worker-1234.js"]);
    expect(list).toContain("./assets/sim.worker-1234.js");
  });
});
