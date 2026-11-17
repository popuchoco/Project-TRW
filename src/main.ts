import { Application } from 'pixi.js';
import { MapDataLoader } from './map/loader';
import { VillageGeometryClient } from './map/geometry-client';
import { scheduleOnceOnIdleOrTrigger, type LodId } from './map/lod';
import { DENSITY_PALETTE } from './map/village-density';
import type { VillageGeometryRecord } from './map/village-geometry';
import { MapRenderer } from './render/MapRenderer';
import { importSaveFile, triggerSaveDownload } from './save/import-export';
import { IndexedDbSaveStorage } from './save/storage';
import { loadSave } from './save/save';
import { requestPersistentStorage } from './save/persistence';
import { saveCurrentState, type SaveStateProviders } from './save/state';
import type { SavePayloadV2 } from './save/types';
import { registerServiceWorker } from './sw/register';
import { SimClient } from './sim/client';
import { createSim } from './sim/core';
import { createEmptyNetwork } from './city/network';
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
  enterMetroButton: HTMLButtonElement;
  returnIslandButton: HTMLButtonElement;
  densityLegend: HTMLElement;
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
  const sourceDetails = makeElement('p', '', '提供機關：內政部國土測繪中心\n資料名稱：鄉鎮市區界線(TWD97經緯度)，版本 1140318\n來源：https://data.gov.tw/dataset/7441\n\n提供機關：國土測繪中心\n資料名稱：村里界圖(TWD97經緯度)，版本 1150817\n來源：https://data.gov.tw/dataset/7438\n\n提供機關：內政部戶政司\n資料名稱：村里戶數、單一年齡人口（新增區域代碼），版本 11510\n來源：https://data.gov.tw/dataset/77132\n\n授權：政府資料開放授權條款第1版 https://data.gov.tw/license\n本專案已對原始資料進行簡化、拆分與格式轉換。');
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

  const enterMetroButton = makeElement('button', 'source-button', '北北都會');
  enterMetroButton.type = 'button';
  enterMetroButton.dataset.action = 'enter-metro-view';
  const returnIslandButton = makeElement('button', 'source-button', '返回全島');
  returnIslandButton.type = 'button';
  returnIslandButton.dataset.action = 'return-island-view';
  returnIslandButton.hidden = true;
  toolbar.insertBefore(enterMetroButton, sources);
  toolbar.insertBefore(returnIslandButton, sources);

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

  const densityLegend = makeElement('section', 'density-legend');
  densityLegend.hidden = true;
  densityLegend.setAttribute('aria-label', '村里人口密度圖例');

  mount.append(toolbar, status, updateBanner, sourceDialog, infoCard, densityLegend);
  return {
    infoCard,
    infoText,
    status,
    fpsSelect,
    simPauseButton,
    simSpeedSelect,
    enterMetroButton,
    returnIslandButton,
    densityLegend,
    updateBanner,
    updateButton,
    fileInput,
  };
}

function renderDensityLegend(container: HTMLElement, breaks: readonly number[]): void {
  const heading = makeElement('strong', 'density-legend-title', '人口密度（人/km²）');
  const list = makeElement('div', 'density-legend-list');
  const format = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
  for (let classIndex = 0; classIndex < DENSITY_PALETTE.length; classIndex += 1) {
    const first = classIndex === 0 ? undefined : breaks[classIndex - 1];
    const last = classIndex < breaks.length ? breaks[classIndex] : undefined;
    const label = first === undefined
      ? `≤ ${format.format(Math.round(last ?? 0))}`
      : last === undefined
        ? `> ${format.format(Math.round(first))}`
        : `${format.format(Math.round(first))}–${format.format(Math.round(last))}`;
    const row = makeElement('div', 'density-legend-item');
    const swatch = makeElement('span', 'density-legend-swatch');
    swatch.style.backgroundColor = `#${DENSITY_PALETTE[classIndex]!.toString(16).padStart(6, '0')}`;
    row.append(swatch, makeElement('span', '', label));
    list.append(row);
  }
  const unmatched = makeElement('div', 'density-legend-item');
  const unmatchedSwatch = makeElement('span', 'density-legend-swatch density-legend-unmatched');
  unmatched.append(unmatchedSwatch, makeElement('span', '', '未編定村里'));
  list.append(unmatched);
  container.replaceChildren(heading, list);
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
  let restoredPayload: SavePayloadV2 | undefined;
  try {
    const savedRecord = await loadSave(saveStorage);
    restoredPayload = savedRecord?.payload as SavePayloadV2 | undefined;
  } catch (error) {
    console.info('Saved game could not be loaded; starting with a fresh session.', error);
  }
  if (restoredPayload) selectedSimSpeed = restoredPayload.simulation.speed;
  const currentNetwork = restoredPayload?.network ?? createEmptyNetwork();
  const freshSimulation = createSim(0x545257);
  const saveStateProviders: SaveStateProviders = {
    getNetwork: () => currentNetwork,
    getCamera: () => {
      const camera = mapRenderer?.camera;
      return camera
        ? { x: camera.center.x, y: camera.center.y, zoom: camera.zoom }
        : restoredPayload?.camera ?? { x: 0, y: 0, zoom: 1 };
    },
    getView: () => 'island',
    getSimulation: () => simulationClient?.getSaveState() ?? restoredPayload?.simulation ?? {
      gameTimeMs: freshSimulation.gameTimeMs,
      speed: selectedSimSpeed,
      paused: true,
      seed: freshSimulation.seed,
      rngState: freshSimulation.rngState,
      seq: freshSimulation.seq,
      routeProgress: freshSimulation.routeProgress,
    },
    getStats: () => restoredPayload?.stats ?? {},
  };
  const showStatus = (message: string): void => {
    ui.status.textContent = message;
    ui.status.hidden = false;
  };
  const exportButton = mount.querySelector<HTMLButtonElement>('[data-action="export-save"]');
  const importButton = mount.querySelector<HTMLButtonElement>('[data-action="import-save"]');
  exportButton?.addEventListener('click', () => {
    void (async () => {
      const record = await saveCurrentState(saveStorage, saveStateProviders);
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
      void saveCurrentState(saveStorage, saveStateProviders).catch((error: unknown) => {
        console.info('Autosave could not be written.', error);
      });
    }
  });

  const loader = new MapDataLoader(import.meta.env.BASE_URL);
  const rendererState: { current?: MapRenderer } = {};
  let villageGeometryClient: VillageGeometryClient | undefined;
  let villageGeometryPromise: Promise<void> | undefined;
  let hasVillageGeometry = false;
  const ensureVillageGeometry = (): void => {
    if (villageGeometryPromise) return;
    ui.status.textContent = '載入北北村里資料中…';
    ui.status.hidden = false;
    villageGeometryClient ??= new VillageGeometryClient();
    const dataBase = new URL(import.meta.env.BASE_URL, document.baseURI);
    villageGeometryPromise = villageGeometryClient.load(
      new URL('data/villages-6300065000.topo.json', dataBase).href,
      new URL('data/villages-6300065000.json', dataBase).href,
    ).then((geometry) => {
      const breaks = rendererState.current?.setVillageGeometry(geometry);
      if (breaks) renderDensityLegend(ui.densityLegend, breaks);
      hasVillageGeometry = true;
      ui.densityLegend.hidden = !rendererState.current?.isMetroView;
      ui.status.hidden = true;
    }).catch((error: unknown) => {
      console.error('Unable to load North–North village geometry', error);
      ui.status.textContent = '北北村里資料載入失敗，請返回全島後再試。';
      ui.status.hidden = false;
      villageGeometryPromise = undefined;
    });
  };
  const manifest = await loader.loadManifest();
  const [initialFeatures, insetFeatures] = await Promise.all([
    loader.loadLod('lod0'),
    loader.loadInsets(),
  ]);
  const loadedLods = new Set<LodId>(['lod0']);
  const pendingLods = new Map<Exclude<LodId, 'lod3'>, Promise<void>>();
  const pendingCounties = new Map<string, Promise<void>>();
  const loadedCountyLods = new Set<string>();
  let triggerLod1Preload = (): void => {};
  let previousZoom: number | undefined;
  const ensureLod = (lod: Exclude<LodId, 'lod3'>): Promise<void> => {
    if (loadedLods.has(lod)) return Promise.resolve();
    const existing = pendingLods.get(lod);
    if (existing) return existing;
    const request = loader.loadLod(lod).then((features) => {
      rendererState.current?.setLodFeatures(lod, features);
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
      rendererState.current?.setLod3County(countyCode, features);
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

  const createdRenderer = new MapRenderer(
    pixiApp,
    manifest,
    initialFeatures,
    insetFeatures,
    (feature: TownFeature) => {
      ui.infoText.textContent = `${feature.properties.COUNTYNAME} ${feature.properties.TOWNNAME}（${feature.properties.TOWNCODE}）`;
      ui.infoCard.hidden = false;
    },
    (lod, counties, zoom) => {
      if (previousZoom !== undefined && zoom !== previousZoom) triggerLod1Preload();
      previousZoom = zoom;
      currentLodForStats = lod;
      visibleCountyCount = counties.length;
      syncMapData(lod, counties);
    },
    (village: VillageGeometryRecord | undefined) => {
      if (!village) {
        ui.infoCard.hidden = true;
        return;
      }
      const name = village.populationMatched && village.name.length > 0 ? village.name : '未編定村里';
      ui.infoText.textContent = `${name}｜人口 ${village.population.toLocaleString('zh-TW')} 人｜${village.townName}`;
      ui.infoCard.hidden = false;
    },
    (active: boolean) => {
      ui.enterMetroButton.hidden = active;
      ui.returnIslandButton.hidden = !active;
      ui.infoCard.hidden = true;
      ui.densityLegend.hidden = !active || !hasVillageGeometry;
      if (active) ensureVillageGeometry();
      else if (ui.status.textContent === '載入北北村里資料中…') ui.status.hidden = true;
    },
  );
  rendererState.current = createdRenderer;
  mapRenderer = createdRenderer;
  ui.enterMetroButton.addEventListener('click', () => createdRenderer.enterMetroView());
  ui.returnIslandButton.addEventListener('click', () => createdRenderer.returnToIslandView());
  if (restoredPayload) {
    createdRenderer.setCameraView(restoredPayload.camera.x, restoredPayload.camera.y, restoredPayload.camera.zoom);
  }

  currentLodForStats = createdRenderer.currentLod;
  visibleCountyCount = createdRenderer.countiesInView.length;

  // Initial full-island frame is drawn synchronously before signaling ready.
  pixiApp.renderer.render(pixiApp.stage);
  firstMapMs = performance.now() - startedAt;
  resolveReady?.();

  simulationClient = new SimClient(undefined, () => performance.now());
  const restoredSimulation = restoredPayload?.simulation;
  simulationClient.start(restoredSimulation?.seed ?? 0x545257, restoredSimulation, {
    speed: restoredSimulation?.speed ?? selectedSimSpeed,
    paused: restoredSimulation?.paused ?? false,
  });
  ui.simSpeedSelect.value = String(selectedSimSpeed);
  if (document.hidden) {
    automaticPauseOnHide = true;
    simulationClient.pause();
  }
  pixiApp.ticker.add(() => {
    const entity = simulationClient?.getInterpolatedEntities()[0];
    if (entity) createdRenderer.setSimulationMarker(entity.lon, entity.lat);
  });
  updateSimulationUi();
  pixiApp.ticker.start();
  ui.status.hidden = true;

  // Keep a finer hit-test topology warm after startup, or as soon as the user zooms.
  triggerLod1Preload = scheduleOnceOnIdleOrTrigger(() => { void ensureLod('lod1'); });
}

void startApp().catch((error: unknown) => {
  console.error('Project-TRW failed to start', error);
  const status = document.querySelector<HTMLElement>('.map-status');
  if (status) {
    status.textContent = '地圖載入失敗，請重新整理頁面。';
    status.hidden = false;
  }
});
