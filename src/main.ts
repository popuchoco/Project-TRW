import { Application } from 'pixi.js';
import { MapDataLoader } from './map/loader';
import { VillageGeometryClient } from './map/geometry-client';
import { scheduleOnceOnIdleOrTrigger, type LodId } from './map/lod';
import type { VillageGeometryRecord } from './map/village-geometry';
import { MapRenderer } from './render/MapRenderer';
import { RenderScheduler } from './render/RenderScheduler';
import { IndexedDbSaveStorage } from './save/storage';
import { loadSave, savePayload } from './save/save';
import { requestPersistentStorage } from './save/persistence';
import type { SavePayloadV2, SaveRecord } from './save/types';
import { registerServiceWorker } from './sw/register';
import { SimClient } from './sim/client';
import { createSim } from './sim/core';
import {
  combineCommands,
  createLine,
  insertStation,
  setLineTrains,
  type NetworkCommand,
} from './city/commands';
import { createCityController, type CityController } from './city/controller';
import { History } from './city/history';
import { createEmptyNetwork, type Network } from './city/network';
import { DEFAULT_REGION_ID, extendRegionPayload, REGIONS } from './city/regions';
import { type TransitModeId } from './city/modes';
import type { SimSpeed } from './sim/clock';
import type { TransitWorkerSnapshot } from './sim/protocol';
import type { TownFeature } from './map/hit';
import { createUi, renderDensityLegend } from './ui/app-shell';
import { createPanelController } from './ui/panel-controller';
import { createStatusController } from './ui/status';
import './style.css';

type FpsSetting = 'auto' | 30 | 60;
interface TrwStats {
  fps: number;
  renderCount: number;
  rendersPerSecond: number;
  lod: LodId | 'loading';
  visibleCounties: number;
  drawCalls?: number;
}

interface TrwDebug {
  ready: Promise<void>;
  firstMapMs?: number;
  readonly renderCount: number;
  readonly rendersPerSecond: number;
  getStats(): TrwStats;
  panBy(dx: number, dy: number): void;
  zoomAt(factor: number, x: number, y: number): void;
  setFpsCap(cap: FpsSetting): void;
  getSim(): { seq: number; gameTimeMs: number; paused: boolean; speed: SimSpeed };
}

interface TrwAutomationDebug {
  ready: Promise<void>;
  readonly renderCount: number;
  readonly rendersPerSecond: number;
  getState(): {
    network: Network;
    camera: { x: number; y: number; zoom: number };
    view: 'island' | 'metro';
    simulation: { seq: number; gameTimeMs: number; paused: boolean; speed: SimSpeed };
    summary?: TransitWorkerSnapshot;
  };
  buildTestLine(points: readonly (readonly [number, number])[], mode?: TransitModeId): string;
  setTrainCounts(lineId: string, peakTrains: number, offPeakTrains: number): void;
  selectStation(stationId: string | undefined): void;
}

declare global {
  interface Window {
    __TRW__?: TrwDebug;
    __trw?: TrwAutomationDebug;
  }
}

const FPS_STORAGE_KEY = 'trw:p0:fpsCap';
const startedAt = performance.now();
let app: Application | undefined;
let mapRenderer: MapRenderer | undefined;
let renderScheduler: RenderScheduler | undefined;
let selectedFpsSetting: FpsSetting = 'auto';
let resolveReady: (() => void) | undefined;
let currentLodForStats: LodId | 'loading' = 'loading';
let visibleCountyCount = 0;
let firstMapMs: number | undefined;
let simulationClient: SimClient | undefined;
let transitClient: SimClient | undefined;
let automaticPauseOnHide = false;
let selectedSimSpeed: SimSpeed = 1;

const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

function isSaveRecordV2(
  record: SaveRecord | undefined,
): record is SaveRecord & { schemaVersion: 2; payload: SavePayloadV2 } {
  return record?.schemaVersion === 2;
}

window.__TRW__ = {
  ready,
  get renderCount() { return renderScheduler?.renderCount ?? 0; },
  get rendersPerSecond() { return renderScheduler?.getRendersPerSecond() ?? 0; },
  get firstMapMs() { return firstMapMs; },
  getStats: () => ({
    fps: renderScheduler?.getRendersPerSecond() ?? 0,
    renderCount: renderScheduler?.renderCount ?? 0,
    rendersPerSecond: renderScheduler?.getRendersPerSecond() ?? 0,
    lod: currentLodForStats,
    visibleCounties: visibleCountyCount,
  }),
  panBy: (dx, dy) => mapRenderer?.panBy(dx, dy),
  zoomAt: (factor, x, y) => mapRenderer?.zoomAt(factor, x, y),
  setFpsCap: (cap) => setFpsSetting(cap),
  getSim: () => simulationClient?.getStatus() ?? { seq: 0, gameTimeMs: 0, paused: true, speed: selectedSimSpeed },
};

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
  renderScheduler?.setMaxFPS(resolveFps(setting));
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
    if (isSaveRecordV2(savedRecord)) {
      restoredPayload = savedRecord.payload;
    } else if (savedRecord) {
      console.warn(`存檔版本 ${savedRecord.schemaVersion} 不受支援，將以新遊戲開始。`);
    }
  } catch (error) {
    console.info('Saved game could not be loaded; starting with a fresh session.', error);
  }
  const region = REGIONS[restoredPayload?.region ?? DEFAULT_REGION_ID];
  ui.enterMetroButton.textContent = `${region.name}都會`;
  ui.extendRegionButton.hidden = true;
  const villageLoadingStatus = `載入${region.name}村里資料中…`;
  if (restoredPayload) selectedSimSpeed = restoredPayload.simulation.speed;
  const networkHistory = new History(restoredPayload?.network ?? createEmptyNetwork());
  const rendererState: { current?: MapRenderer } = {};
  const freshSimulation = createSim(0x545257);
  const cityControllerRef: { current?: CityController } = {};
  const statusController = createStatusController(ui.status);
  const { show: showStatus, showSticky: showStickyStatus, hide: hideStatus } = statusController;
  const panelController = createPanelController({
    mount,
    ui,
    networkHistory,
    rendererState,
    getMapRenderer: () => mapRenderer,
    getRegion: () => region.id,
    restoredPayload,
    freshSimulation,
    saveStorage,
    getSimulationClient: () => simulationClient,
    getTransitClient: () => transitClient,
    getSelectedSimSpeed: () => selectedSimSpeed,
    setSelectedSimSpeed: (speed) => { selectedSimSpeed = speed; },
    getSelectedNetworkItem: () => cityControllerRef.current?.getSelectedNetworkItem(),
    showStatus,
    showStickyStatus,
    updateRenderActivity: (running, hasVisibleTrains) => renderScheduler?.setSimulationActivity(running, hasVisibleTrains),
  });
  let regionExtensionConfirmationTimer: number | undefined;
  let regionExtensionInProgress = false;
  ui.extendRegionButton.addEventListener('click', () => {
    const button = ui.extendRegionButton;
    if (regionExtensionConfirmationTimer === undefined) {
      button.textContent = '確定延伸？模擬時鐘與乘客習慣會重新開始';
      regionExtensionConfirmationTimer = window.setTimeout(() => {
        regionExtensionConfirmationTimer = undefined;
        button.textContent = '延伸到桃園';
      }, 5000);
      return;
    }

    window.clearTimeout(regionExtensionConfirmationTimer);
    regionExtensionConfirmationTimer = undefined;
    regionExtensionInProgress = true;
    button.disabled = true;
    void (async () => {
      try {
        await panelController.saveLiveState();
        const savedRecord = await loadSave(saveStorage);
        if (!isSaveRecordV2(savedRecord)) {
          if (savedRecord) {
            console.warn(`存檔版本 ${savedRecord.schemaVersion} 不受支援，無法延伸到桃園。`);
          }
          throw new Error('找不到存檔。');
        }
        const extendedPayload = extendRegionPayload(
          savedRecord.payload,
          'northNorthTaoyuan',
        );
        await savePayload(saveStorage, extendedPayload);
        window.location.reload();
      } catch (error) {
        console.error('延伸到桃園失敗。', error);
        showStatus('延伸到桃園失敗，請稍後再試。');
        regionExtensionInProgress = false;
        button.textContent = '延伸到桃園';
        button.disabled = false;
      }
    })();
  });
  const cityController = createCityController({
    ui,
    networkHistory,
    rendererState,
    getCanvas: () => app?.canvas,
    setTransitNetwork: (network) => transitClient?.setNetwork(network),
    updatePanels: panelController.updatePanels,
    showStatus,
  });
  cityControllerRef.current = cityController;
  panelController.initializePanels(cityController);
  cityController.bindControls();
  panelController.bindSaveControls();
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
  panelController.bindSimulationControls();

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
  pixiApp.ticker.stop();
  pixiApp.canvas.setAttribute('aria-label', 'Project-TRW 全島地圖');
  mount.prepend(pixiApp.canvas);
  let firstRenderResolved = false;
  renderScheduler = new RenderScheduler({
    render: () => pixiApp.renderer.render(pixiApp.stage),
    maxFPS: resolveFps(selectedFpsSetting),
    afterRender: () => {
      if (firstRenderResolved) return;
      firstRenderResolved = true;
      firstMapMs = performance.now() - startedAt;
      resolveReady?.();
    },
  });
  renderScheduler.setEnabled(!document.hidden);

  document.addEventListener('visibilitychange', () => {
    renderScheduler?.setEnabled(!document.hidden);
    if (document.hidden && simulationClient && !simulationClient.getStatus().paused) {
      automaticPauseOnHide = true;
      simulationClient.pause();
      transitClient?.pause();
      panelController.updateSimulationUi();
    } else if (!document.hidden && automaticPauseOnHide) {
      automaticPauseOnHide = false;
      simulationClient?.resume();
      transitClient?.resume();
      panelController.updateSimulationUi();
    }
    if (!document.hidden) renderScheduler?.invalidate();
    renderScheduler?.setSimulationActivity(
      Boolean(transitClient && !transitClient.getStatus().paused),
      mapRenderer?.hasVisibleTrains ?? false,
    );
    if (document.hidden && !regionExtensionInProgress) {
      void panelController.saveLiveState().catch((error: unknown) => {
        console.info('Autosave could not be written.', error);
      });
    }
  });

  const loader = new MapDataLoader(import.meta.env.BASE_URL);
  let villageGeometryClient: VillageGeometryClient | undefined;
  let villageGeometryPromise: Promise<void> | undefined;
  let hasVillageGeometry = false;
  const ensureVillageGeometry = (): void => {
    if (villageGeometryPromise) return;
    ui.status.textContent = villageLoadingStatus;
    ui.status.hidden = false;
    villageGeometryClient ??= new VillageGeometryClient();
    const dataBase = new URL(import.meta.env.BASE_URL, document.baseURI);
    const parts = region.villageAssets.map((asset) => ({
      topologyUrl: new URL(asset.topology, dataBase).href,
      attributesUrl: new URL(asset.attributes, dataBase).href,
    }));
    villageGeometryPromise = villageGeometryClient.loadParts(parts).then((geometry) => {
      const breaks = rendererState.current?.setVillageGeometry(geometry);
      if (breaks) renderDensityLegend(ui.densityLegend, breaks);
      hasVillageGeometry = true;
      ui.densityLegend.hidden = !rendererState.current?.isMetroView;
      ui.editorToolbar.hidden = !rendererState.current?.isMetroView;
      cityController.updateEditorControls();
      hideStatus();
    }).catch((error: unknown) => {
      console.error(`Unable to load ${region.name} village geometry`, error);
      const geometryFailure = `${region.name}村里資料載入失敗，請返回全島後再試。`;
      const stickyMessage = statusController.getStickyMessage();
      showStatus(stickyMessage ? `${stickyMessage}${geometryFailure}` : geometryFailure);
      ui.editorToolbar.hidden = true;
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
      hideStatus();
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
      renderScheduler?.setSimulationActivity(
        Boolean(transitClient && !transitClient.getStatus().paused),
        rendererState.current?.hasVisibleTrains ?? false,
      );
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
      ui.extendRegionButton.hidden = region.id !== 'northNorth' || !active;
      ui.infoCard.hidden = true;
      ui.densityLegend.hidden = !active || !hasVillageGeometry;
      ui.editorToolbar.hidden = !active || !hasVillageGeometry;
      panelController.setMetroViewActive(active);
      if (active) ensureVillageGeometry();
      else if (ui.status.textContent === villageLoadingStatus) hideStatus();
    },
    () => renderScheduler?.invalidate(),
  );
  createdRenderer.setRegion(region);
  rendererState.current = createdRenderer;
  mapRenderer = createdRenderer;
  const stationCommandAt = cityController.attachRenderer(createdRenderer, () => hasVillageGeometry, restoredPayload);

  currentLodForStats = createdRenderer.currentLod;
  visibleCountyCount = createdRenderer.countiesInView.length;

  simulationClient = new SimClient(undefined, () => performance.now());
  const restoredSimulation = restoredPayload?.simulation;
  simulationClient.start(restoredSimulation?.seed ?? 0x545257, restoredSimulation, {
    speed: restoredSimulation?.speed ?? selectedSimSpeed,
    paused: restoredSimulation?.paused ?? false,
  });
  transitClient = new SimClient(undefined, () => performance.now());
  panelController.startTransit(
    transitClient,
    createdRenderer,
    restoredSimulation?.seed ?? 0x545257,
    networkHistory.network,
    restoredPayload?.transit,
    {
      speed: restoredSimulation?.speed ?? selectedSimSpeed,
      paused: restoredSimulation?.paused ?? false,
    },
  );
  window.__trw = {
    ready,
    get renderCount() { return renderScheduler?.renderCount ?? 0; },
    get rendersPerSecond() { return renderScheduler?.getRendersPerSecond() ?? 0; },
    getState: () => ({
      network: {
        stations: networkHistory.network.stations.map((station) => ({ ...station })),
        lines: networkHistory.network.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })),
        nextId: networkHistory.network.nextId,
      },
      camera: {
        x: createdRenderer.camera.center.x,
        y: createdRenderer.camera.center.y,
        zoom: createdRenderer.camera.zoom,
      },
      view: createdRenderer.isMetroView ? 'metro' : 'island',
      simulation: transitClient?.getStatus() ?? { seq: 0, gameTimeMs: 0, paused: true, speed: selectedSimSpeed },
      ...(panelController.getLatestTransitSnapshot()
        ? { summary: structuredClone(panelController.getLatestTransitSnapshot()!) }
        : {}),
    }),
    buildTestLine: (points, mode = 'metro') => {
      if (points.length < 2) throw new RangeError('A test line needs at least two lon/lat points.');
      if (mode !== 'brt' && mode !== 'metro') throw new RangeError('Unknown test line mode.');
      const current = networkHistory.network;
      const stationIds = points.map((point, index) => {
        if (point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
          throw new RangeError(`Invalid lon/lat test point at index ${index}.`);
        }
        return `s${current.nextId + index}`;
      });
      const lineId = `l${current.nextId + points.length}`;
      const commands: NetworkCommand[] = [
        ...points.map((point) => stationCommandAt(point)),
        createLine(stationIds[0]!, stationIds[stationIds.length - 1]!, mode),
        ...stationIds.slice(1, -1).map((_stationId, index) =>
          insertStation(lineId, index, { stationId: stationIds[index + 1]! })),
      ];
      cityController.executeNetworkCommand(combineCommands(commands, 'debugBuildTestLine'), { type: 'line', id: lineId });
      return lineId;
    },
    setTrainCounts: (lineId, peakTrains, offPeakTrains) => {
      cityController.executeNetworkCommand(setLineTrains(lineId, peakTrains, offPeakTrains), { type: 'line', id: lineId });
    },
    selectStation: (stationId) => {
      if (stationId !== undefined && !networkHistory.network.stations.some(({ id }) => id === stationId)) {
        throw new RangeError(`Unknown station id: ${stationId}`);
      }
      cityController.selectNetworkItem(stationId === undefined ? undefined : { type: 'station', id: stationId });
    },
  };
  panelController.setSpeedSelection();
  if (document.hidden) {
    automaticPauseOnHide = true;
    simulationClient.pause();
    transitClient.pause();
  }
  renderScheduler.setBeforeFrame((timestamp) => {
    createdRenderer.setTrainPositions(transitClient?.getInterpolatedTrainPositions(timestamp) ?? []);
    renderScheduler?.setSimulationActivity(
      Boolean(transitClient && !transitClient.getStatus().paused),
      createdRenderer.hasVisibleTrains,
    );
  });
  renderScheduler.setSimulationActivity(
    Boolean(transitClient && !transitClient.getStatus().paused),
    createdRenderer.hasVisibleTrains,
  );
  panelController.updateSimulationUi();
  hideStatus();

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
