import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { buildPrecacheList } from "./src/sw/precache.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string };
const appVersion = packageJson.version ?? "0.0.0";
const dataVersion = "1140318-v1150817-p11510";

function serviceWorkerPlugin(): Plugin {
  return {
    name: "trw-service-worker-precache",
    apply: "build",
    generateBundle(_options, bundle) {
      const worker = Object.values(bundle).find((output) => output.type === "chunk" && output.name === "sw");
      if (!worker || worker.type !== "chunk") throw new Error("Service worker entry was not emitted");

      const generatedAssets = Object.values(bundle)
        .filter((output) => (output.type === "chunk" && output.name !== "sw") || (output.type === "asset" && /\.(?:css|js)$/i.test(output.fileName)))
        .map((output) => `./${output.fileName}`);
      const precache = buildPrecacheList(generatedAssets);
      const buildHash = createHash("sha256").update(JSON.stringify(precache)).digest("hex").slice(0, 8);
      worker.code = worker.code.replace(
        /(["'`])__TRW_PRECACHE_JSON__\1/,
        JSON.stringify(JSON.stringify(precache)),
      );
      worker.code = worker.code.replace(
        /(["'`])__TRW_APP_CACHE_VERSION__\1/,
        JSON.stringify(appVersion),
      );
      worker.code = worker.code.replace(
        /(["'`])__TRW_DATA_CACHE_VERSION__\1/,
        JSON.stringify(dataVersion),
      );
      worker.code = worker.code.replace(
        /(["'`])__TRW_BUILD_HASH__\1/,
        JSON.stringify(buildHash),
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [serviceWorkerPlugin()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        sw: resolve(root, "src/sw/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: {
    format: "es",
  },
});
