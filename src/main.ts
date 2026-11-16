import { Application } from 'pixi.js';
import { MapDataLoader } from './map/loader';
import type { LodId } from './map/lod';
import { MapRenderer } from './render/MapRenderer';
import type { TownFeature } from './map/hit';
import './style.css';

type FpsSetting = 'auto' | 30 | 60;

interface TrwStats {
  fps: number;
  lod: LodId | 'loading';
  visibleCounties: number;
  drawCalls?: number;
}

interface TrwDebug {
  ready: Promise<void>;
  firstMapMs?: number;
  getStats(): TrwStats;
  panBy(dx: number, dy: number): void;
  zoomAt(factor: number, x: number, y: number): void;
  setFpsCap(cap: FpsSetting): void;
}

declare global {
  interface Window {
    __TRW__?: TrwDebug;
  }
}

const FPS_STORAGE_KEY = 'trw:p0:fpsCap';
const startedAt = performance.now();
let app: Application | undefined;
let mapRenderer: MapRenderer | undefined;
let selectedFpsSetting: FpsSetting = 'auto';
let resolveReady: (() => void) | undefined;
let currentLodForStats: LodId | 'loading' = 'loading';
let visibleCountyCount = 0;
let firstMapMs: number | undefined;

const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
window.__TRW__ = {
  ready,
  get firstMapMs() { return firstMapMs; },
  getStats: () => ({
    fps: app?.ticker.FPS ?? 0,
    lod: currentLodForStats,
    visibleCounties: visibleCountyCount,
  }),
  panBy: (dx, dy) => mapRenderer?.panBy(dx, dy),
  zoomAt: (factor, x, y) => mapRenderer?.zoomAt(factor, x, y),
  setFpsCap: (cap) => setFpsSetting(cap),
};

function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createUi(mount: HTMLElement): {
  infoCard: HTMLElement;
  infoText: HTMLElement;
  status: HTMLElement;
  fpsSelect: HTMLSelectElement;
} {
  const toolbar = makeElement('section', 'map-toolbar');
  const product = makeElement('div', 'map-brand');
  product.append(makeElement('strong', 'map-title', 'Project-TRW'), makeElement('span', 'map-subtitle', '全島行政區地圖'));

  const settings = makeElement('label', 'fps-setting');
  settings.append(makeElement('span', '', 'FPS'));
  const fpsSelect = makeElement('select', 'fps-select');
  fpsSelect.setAttribute('aria-label', 'FPS 上限');
  for (const [value, label] of [['auto', '自動'], ['30', '30'], ['60', '60']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fpsSelect.append(option);
  }
  settings.append(fpsSelect);

  const sources = makeElement('button', 'source-button', '資料來源');
  sources.type = 'button';
  sources.title = '資料來源說明將於後續階段加入';
  sources.addEventListener('click', () => {
    status.textContent = '資料來源說明將於後續階段加入。';
    status.hidden = false;
  });
  toolbar.append(product, settings, sources);

  const status = makeElement('div', 'map-status', '載入地圖資料中…');
  status.setAttribute('role', 'status');
  const infoCard = makeElement('section', 'town-info');
  infoCard.hidden = true;
  infoCard.setAttribute('aria-live', 'polite');
  const infoText = makeElement('strong', 'town-info-text');
  infoCard.append(infoText);

  mount.append(toolbar, status, infoCard);
  return { infoCard, infoText, status, fpsSelect };
}

function initialFpsSetting(): FpsSetting {
  try {
    const stored = localStorage.getItem(FPS_STORAGE_KEY);
    if (stored === '30') return 30;
    if (stored === '60') return 60;
    if (stored === 'auto') return 'auto';
  } catch {
    // Storage may be disabled; keep the device-based default.
  }
  return 'auto';
}

function resolveFps(setting: FpsSetting): number {
  if (setting === 30 || setting === 60) return setting;
  return matchMedia('(pointer: coarse)').matches ? 30 : 60;
}

function setFpsSetting(setting: FpsSetting): void {
  selectedFpsSetting = setting;
  if (app) app.ticker.maxFPS = resolveFps(setting);
  const select = document.querySelector<HTMLSelectElement>('.fps-select');
  if (select) select.value = String(setting);
  try {
    localStorage.setItem(FPS_STORAGE_KEY, String(setting));
  } catch {
    // The setting remains active for this session when storage is unavailable.
  }
}

async function startApp(): Promise<void> {
  const mount = document.querySelector<HTMLElement>('#app');
  if (!mount) throw new Error('Missing #app mount element');
  const ui = createUi(mount);
  selectedFpsSetting = initialFpsSetting();
  ui.fpsSelect.value = String(selectedFpsSetting);
  ui.fpsSelect.addEventListener('change', () => {
    const value = ui.fpsSelect.value;
    setFpsSetting(value === '30' ? 30 : value === '60' ? 60 : 'auto');
  });

  const pixiApp = new Application();
  app = pixiApp;
  await pixiApp.init({
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    backgroundColor: 0xf4f6f8,
    preference: 'webgl',
    powerPreference: 'high-performance',
    autoStart: false,
    sharedTicker: false,
  });
  pixiApp.canvas.setAttribute('aria-label', 'Project-TRW 全島地圖');
  mount.prepend(pixiApp.canvas);
  pixiApp.ticker.maxFPS = resolveFps(selectedFpsSetting);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pixiApp.ticker.stop();
    else pixiApp.ticker.start();
  });

  const loader = new MapDataLoader(import.meta.env.BASE_URL);
  const manifest = await loader.loadManifest();
  const [initialFeatures, insetFeatures] = await Promise.all([
    loader.loadLod('lod0'),
    loader.loadInsets(),
  ]);
  const loadedLods = new Set<LodId>(['lod0']);
  const pendingLods = new Map<Exclude<LodId, 'lod3'>, Promise<void>>();
  const pendingCounties = new Map<string, Promise<void>>();
  const loadedCountyLods = new Set<string>();
  const ensureLod = (lod: Exclude<LodId, 'lod3'>): Promise<void> => {
    if (loadedLods.has(lod)) return Promise.resolve();
    const existing = pendingLods.get(lod);
    if (existing) return existing;
    const request = loader.loadLod(lod).then((features) => {
      renderer.setLodFeatures(lod, features);
      loadedLods.add(lod);
      ui.status.hidden = true;
    }).catch((error: unknown) => {
      console.error(`Unable to load ${lod}`, error);
      ui.status.textContent = '地圖細節載入失敗，請確認資料檔案可讀取。';
      ui.status.hidden = false;
      pendingLods.delete(lod);
    });
    pendingLods.set(lod, request);
    return request;
  };

  const ensureCountyLod3 = (countyCode: string): Promise<void> => {
    if (rendererHasLod3(countyCode)) return Promise.resolve();
    const existing = pendingCounties.get(countyCode);
    if (existing) return existing;
    const request = loader.loadCountyLod3(countyCode).then((features) => {
      renderer.setLod3County(countyCode, features);
      loadedCountyLods.add(countyCode);
    }).catch((error: unknown) => {
      console.error(`Unable to load LOD3 county ${countyCode}`, error);
      pendingCounties.delete(countyCode);
    });
    pendingCounties.set(countyCode, request);
    return request;
  };

  function rendererHasLod3(countyCode: string): boolean {
    return loadedCountyLods.has(countyCode);
  }

  const syncMapData = (lod: LodId, counties: string[]): void => {
    if (lod === 'lod3') {
      void ensureLod('lod2');
      const lod3Files = manifest.lods.find((entry) => entry.id === 'lod3')?.files ?? [];
      for (const countyCode of counties) {
        if (lod3Files.some(({ path }) => path.endsWith(`/${countyCode}.topo.json`)) && !loadedCountyLods.has(countyCode)) {
          void ensureCountyLod3(countyCode);
        }
      }
    } else if (lod !== 'lod0') {
      void ensureLod(lod);
    }
  };

  const renderer = new MapRenderer(
    pixiApp,
    manifest,
    initialFeatures,
    insetFeatures,
    (feature: TownFeature) => {
      ui.infoText.textContent = `${feature.properties.COUNTYNAME} ${feature.properties.TOWNNAME}（${feature.properties.TOWNCODE}）`;
      ui.infoCard.hidden = false;
    },
    (lod, counties) => {
      currentLodForStats = lod;
      visibleCountyCount = counties.length;
      syncMapData(lod, counties);
    },
  );
  mapRenderer = renderer;

  currentLodForStats = renderer.currentLod;
  visibleCountyCount = renderer.countiesInView.length;

  // Initial full-island frame is drawn synchronously before signaling ready.
  pixiApp.renderer.render(pixiApp.stage);
  firstMapMs = performance.now() - startedAt;
  resolveReady?.();
  pixiApp.ticker.start();
  ui.status.hidden = true;

  // Keep a finer hit-test topology warm without changing the initial overview LOD.
  void ensureLod('lod1');
}

void startApp().catch((error: unknown) => {
  console.error('Project-TRW failed to start', error);
  const status = document.querySelector<HTMLElement>('.map-status');
  if (status) {
    status.textContent = '地圖載入失敗，請重新整理頁面。';
    status.hidden = false;
  }
});
