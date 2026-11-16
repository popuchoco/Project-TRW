import { describe, expect, it } from "vitest";
import { buildCacheNames, CACHE_MATCH_OPTIONS } from "../../src/sw/cache";
import { buildPrecacheList } from "../../src/sw/precache";
import { classifyRequest } from "../../src/sw/routes";

describe("service worker cache names", () => {
  it("includes the app and boundary data versions", () => {
    expect(buildCacheNames("0.0.0", "1140318")).toEqual({
      shell: "trw-shell-v0.0.0-d1140318",
      runtime: "trw-runtime-v0.0.0-d1140318",
    });
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
