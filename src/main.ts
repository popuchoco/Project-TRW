import { Application } from 'pixi.js';
import { MapDataLoader } from './map/loader';
import type { LodId } from './map/lod';
import { MapRenderer } from './render/MapRenderer';
import { importSaveFile, triggerSaveDownload } from './save/import-export';
import { IndexedDbSaveStorage } from './save/storage';
import { loadSave, savePayload } from './save/save';
import { requestPersistentStorage } from './save/persistence';
import { registerServiceWorker } from './sw/register';
import { SimClient } from './sim/client';
import type { SimSpeed } from './sim/clock';
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
  getSim(): { seq: number; gameTimeMs: number; paused: boolean; speed: SimSpeed };
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
let simulationClient: SimClient | undefined;
let automaticPauseOnHide = false;
let selectedSimSpeed: SimSpeed = 1;

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
  getSim: () => simulationClient?.getStatus() ?? { seq: 0, gameTimeMs: 0, paused: true, speed: selectedSimSpeed },
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
  simPauseButton: HTMLButtonElement;
  simSpeedSelect: HTMLSelectElement;
  updateBanner: HTMLElement;
  updateButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
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

  const simPauseButton = makeElement('button', 'source-button', '暫停模擬');
  simPauseButton.type = 'button';
  simPauseButton.dataset.action = 'toggle-simulation';
  const simSpeedSetting = makeElement('label', 'fps-setting');
  simSpeedSetting.append(makeElement('span', '', '模擬速度'));
  const simSpeedSelect = makeElement('select', 'sim-speed-select');
  simSpeedSelect.setAttribute('aria-label', '模擬速度');
  for (const [value, label] of [[1, '1×'], [2, '2×'], [4, '4×']] as const) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = label;
    simSpeedSelect.append(option);
  }
  simSpeedSetting.append(simSpeedSelect);

  const sources = makeElement('button', 'source-button', '資料來源');
  sources.type = 'button';
  const sourceDialog = makeElement('dialog', 'source-dialog');
  sourceDialog.setAttribute('aria-labelledby', 'source-dialog-title');
  const sourceHeading = makeElement('h2', '', '資料來源');
  sourceHeading.id = 'source-dialog-title';
  const sourceDetails = makeElement('p', '', '提供機關：內政部國土測繪中心\n資料名稱：鄉鎮市區界線(TWD97經緯度)，版本 1140318\n來源：https://data.gov.tw/dataset/7441\n授權：政府資料開放授權條款－第1版 https://data.gov.tw/license\n本專案已對原始資料進行簡化、拆分與格式轉換。');
  const closeSources = makeElement('button', 'source-button', '關閉');
  closeSources.type = 'button';
  sources.addEventListener('click', () => sourceDialog.showModal());
  closeSources.addEventListener('click', () => sourceDialog.close());
  sourceDialog.append(sourceHeading, sourceDetails, closeSources);

  const exportButton = makeElement('button', 'source-button', '匯出存檔');
  exportButton.type = 'button';
  exportButton.dataset.action = 'export-save';
  const importButton = makeElement('button', 'source-button', '匯入存檔');
  importButton.type = 'button';
  importButton.dataset.action = 'import-save';
  const fileInput = makeElement('input', 'save-file-input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.setAttribute('aria-label', '選擇存檔 JSON 檔');
  toolbar.append(product, settings, simPauseButton, simSpeedSetting, sources, exportButton, importButton, fileInput);

  const status = makeElement('div', 'map-status', '載入地圖資料中…');
  status.setAttribute('role', 'status');
  const updateBanner = makeElement('section', 'update-banner');
  updateBanner.hidden = true;
  updateBanner.setAttribute('role', 'status');
  updateBanner.append(makeElement('span', '', '有新版本，重新載入以更新'));
  const updateButton = makeElement('button', 'source-button', '重新載入');
  updateButton.type = 'button';
  updateBanner.append(updateButton);
  const infoCard = makeElement('section', 'town-info');
  infoCard.hidden = true;
  infoCard.setAttribute('aria-live', 'polite');
  const infoText = makeElement('strong', 'town-info-text');
  infoCard.append(infoText);

  mount.append(toolbar, status, updateBanner, sourceDialog, infoCard);
  return { infoCard, infoText, status, fpsSelect, simPauseButton, simSpeedSelect, updateBanner, updateButton, fileInput };
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
  const saveStorage = new IndexedDbSaveStorage();
  const currentP0Payload = (): Record<string, unknown> => ({
    camera: { x: 0, y: 0, zoom: 1 },
    simulation: (() => {
      const sim = simulationClient?.getStatus() ?? { seq: 0, gameTimeMs: 0, paused: true, speed: selectedSimSpeed };
      return { tick: sim.seq, gameTimeMs: sim.gameTimeMs, running: !sim.paused };
    })(),
  });
  const showStatus = (message: string): void => {
    ui.status.textContent = message;
    ui.status.hidden = false;
  };
  const exportButton = mount.querySelector<HTMLButtonElement>('[data-action="export-save"]');
  const importButton = mount.querySelector<HTMLButtonElement>('[data-action="import-save"]');
  exportButton?.addEventListener('click', () => {
    void (async () => {
      const record = await loadSave(saveStorage) ?? await savePayload(saveStorage, currentP0Payload());
      triggerSaveDownload(record);
      showStatus('存檔已匯出。');
    })().catch((error: unknown) => {
      console.error('Unable to export save', error);
      showStatus('匯出存檔失敗，請稍後再試。');
    });
  });
  importButton?.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    void importSaveFile(file).then(async (record) => {
      await saveStorage.write(record);
      showStatus('存檔已匯入。');
    }).catch((error: unknown) => {
      showStatus(error instanceof Error ? error.message : '匯入存檔失敗。');
    }).finally(() => {
      ui.fileInput.value = '';
    });
  });
  registerServiceWorker((activateUpdate) => {
    ui.updateBanner.hidden = false;
    ui.updateButton.onclick = activateUpdate;
  });
  void requestPersistentStorage();
  selectedFpsSetting = initialFpsSetting();
  ui.fpsSelect.value = String(selectedFpsSetting);
  ui.fpsSelect.addEventListener('change', () => {
    const value = ui.fpsSelect.value;
    setFpsSetting(value === '30' ? 30 : value === '60' ? 60 : 'auto');
  });
  const updateSimulationUi = (): void => {
    const status = simulationClient?.getStatus();
    ui.simPauseButton.textContent = status?.paused ? '繼續模擬' : '暫停模擬';
    ui.simPauseButton.setAttribute('aria-pressed', String(Boolean(status?.paused)));
  };
  ui.simPauseButton.addEventListener('click', () => {
    if (!simulationClient) return;
    if (simulationClient.getStatus().paused) simulationClient.resume();
    else simulationClient.pause();
    updateSimulationUi();
  });
  ui.simSpeedSelect.value = String(selectedSimSpeed);
  ui.simSpeedSelect.addEventListener('change', () => {
    const value = Number(ui.simSpeedSelect.value);
    if (value !== 1 && value !== 2 && value !== 4) return;
    selectedSimSpeed = value;
    simulationClient?.setSpeed(value);
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
    if (document.hidden && simulationClient && !simulationClient.getStatus().paused) {
      automaticPauseOnHide = true;
      simulationClient.pause();
      updateSimulationUi();
    } else if (!document.hidden && automaticPauseOnHide) {
      automaticPauseOnHide = false;
      simulationClient?.resume();
      updateSimulationUi();
    }
    if (document.hidden) {
      void savePayload(saveStorage, currentP0Payload()).catch((error: unknown) => {
        console.info('Autosave could not be written.', error);
      });
    }
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

  simulationClient = new SimClient();
  simulationClient.start(0x545257);
  if (selectedSimSpeed !== 1) simulationClient.setSpeed(selectedSimSpeed);
  if (document.hidden) {
    automaticPauseOnHide = true;
    simulationClient.pause();
  }
  pixiApp.ticker.add(() => {
    const entity = simulationClient?.getInterpolatedEntities()[0];
    if (entity) renderer.setSimulationMarker(entity.lon, entity.lat);
  });
  updateSimulationUi();
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
