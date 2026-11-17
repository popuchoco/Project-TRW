import { Application } from 'pixi.js';
import { MapDataLoader } from './map/loader';
import { VillageGeometryClient } from './map/geometry-client';
import { scheduleOnceOnIdleOrTrigger, type LodId } from './map/lod';
import { DENSITY_PALETTE } from './map/village-density';
import type { VillageGeometryRecord } from './map/village-geometry';
import { MapRenderer, type NetworkEditorPointer, type NetworkSelection } from './render/MapRenderer';
import { RenderScheduler } from './render/RenderScheduler';
import { importSaveFile, triggerSaveDownload } from './save/import-export';
import { IndexedDbSaveStorage } from './save/storage';
import { loadSave } from './save/save';
import { requestPersistentStorage } from './save/persistence';
import { saveCurrentState, type SaveStateProviders } from './save/state';
import type { SavePayloadV2 } from './save/types';
import { registerServiceWorker } from './sw/register';
import { SimClient } from './sim/client';
import { createSim } from './sim/core';
import {
  combineCommands,
  createLine,
  deleteLine,
  deleteStation,
  extendLine,
  insertStation,
  moveStation,
  placeStation,
  renameStation,
  setLineCars,
  setLineTrains,
  type NetworkCommand,
  type VillageAt,
} from './city/commands';
import { History } from './city/history';
import { createEmptyNetwork, lineSpacingWarnings, type Network } from './city/network';
import { TRANSIT_MODES, type TransitModeId } from './city/modes';
import type { SimSpeed } from './sim/clock';
import type { TransitWorkerSnapshot } from './sim/protocol';
import type { TownFeature } from './map/hit';
import { createSimulationPanels, type SimulationPanels } from './ui/panels';
import './style.css';

type FpsSetting = 'auto' | 30 | 60;
type EditorTool = 'select' | 'place' | 'line' | 'insert';

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
  editorToolbar: HTMLElement;
  editorToolButtons: Map<EditorTool, HTMLButtonElement>;
  lineModeSelect: HTMLSelectElement;
  deleteStationButton: HTMLButtonElement;
  deleteLineButton: HTMLButtonElement;
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  editorSelection: HTMLElement;
  spacingHint: HTMLElement;
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

  const editorToolbar = makeElement('section', 'network-editor-toolbar');
  editorToolbar.hidden = true;
  editorToolbar.setAttribute('aria-label', '路網編輯工具');
  const editorToolButtons = new Map<EditorTool, HTMLButtonElement>();
  for (const [tool, label] of [
    ['select', '選取／移站'],
    ['place', '放站'],
    ['line', '拉線／延伸'],
    ['insert', '插站'],
  ] as const) {
    const button = makeElement('button', 'source-button editor-tool-button', label);
    button.type = 'button';
    button.dataset.editorTool = tool;
    button.setAttribute('aria-pressed', String(tool === 'select'));
    editorToolButtons.set(tool, button);
    editorToolbar.append(button);
  }
  const lineModeSetting = makeElement('label', 'fps-setting editor-line-mode');
  lineModeSetting.append(makeElement('span', '', '新線運具'));
  const lineModeSelect = makeElement('select', 'sim-speed-select');
  lineModeSelect.setAttribute('aria-label', '新線運具');
  for (const [value, label] of [['brt', TRANSIT_MODES.brt.name], ['metro', TRANSIT_MODES.metro.name]] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lineModeSelect.append(option);
  }
  lineModeSetting.append(lineModeSelect);
  const deleteStationButton = makeElement('button', 'source-button', '刪除選取站');
  deleteStationButton.type = 'button';
  deleteStationButton.disabled = true;
  const deleteLineButton = makeElement('button', 'source-button', '刪除選取線');
  deleteLineButton.type = 'button';
  deleteLineButton.disabled = true;
  const undoButton = makeElement('button', 'source-button', '復原');
  undoButton.type = 'button';
  undoButton.disabled = true;
  const redoButton = makeElement('button', 'source-button', '重做');
  redoButton.type = 'button';
  redoButton.disabled = true;
  const editorSelection = makeElement('span', 'editor-selection', '尚未選取路網項目');
  const spacingHint = makeElement('div', 'spacing-hint');
  spacingHint.hidden = true;
  spacingHint.setAttribute('role', 'status');
  editorToolbar.append(
    lineModeSetting,
    deleteStationButton,
    deleteLineButton,
    undoButton,
    redoButton,
    editorSelection,
    spacingHint,
  );

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

  mount.append(toolbar, editorToolbar, status, updateBanner, sourceDialog, infoCard, densityLegend);
  return {
    infoCard,
    infoText,
    status,
    fpsSelect,
    simPauseButton,
    simSpeedSelect,
    enterMetroButton,
    returnIslandButton,
    editorToolbar,
    editorToolButtons,
    lineModeSelect,
    deleteStationButton,
    deleteLineButton,
    undoButton,
    redoButton,
    editorSelection,
    spacingHint,
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
    restoredPayload = savedRecord?.payload as SavePayloadV2 | undefined;
  } catch (error) {
    console.info('Saved game could not be loaded; starting with a fresh session.', error);
  }
  if (restoredPayload) selectedSimSpeed = restoredPayload.simulation.speed;
  const networkHistory = new History(restoredPayload?.network ?? createEmptyNetwork());
  const rendererState: { current?: MapRenderer } = {};
  const freshSimulation = createSim(0x545257);
  let selectedNetworkItem: NetworkSelection;
  let activeEditorTool: EditorTool = 'select';
  let newLineMode: TransitModeId = 'brt';
  let latestTransitSnapshot: TransitWorkerSnapshot | undefined;
  const panelControllerRef: { current?: SimulationPanels } = {};
  const updatePanels = (): void => {
    panelControllerRef.current?.update(
      networkHistory.network,
      latestTransitSnapshot,
      selectedNetworkItem?.type === 'station' ? selectedNetworkItem.id : undefined,
    );
  };
  const saveStateProviders: SaveStateProviders = {
    getNetwork: () => networkHistory.network,
    getCamera: () => {
      const camera = mapRenderer?.camera;
      return camera
        ? { x: camera.center.x, y: camera.center.y, zoom: camera.zoom }
        : restoredPayload?.camera ?? { x: 0, y: 0, zoom: 1 };
    },
    getView: () => rendererState.current?.isMetroView ? 'metro' : 'island',
    getSimulation: () => simulationClient?.getSaveState() ?? restoredPayload?.simulation ?? {
      gameTimeMs: freshSimulation.gameTimeMs,
      speed: selectedSimSpeed,
      paused: true,
      seed: freshSimulation.seed,
      rngState: freshSimulation.rngState,
      seq: freshSimulation.seq,
      routeProgress: freshSimulation.routeProgress,
    },
    getStats: () => {
      const city = latestTransitSnapshot?.city;
      if (!city || !latestTransitSnapshot) return restoredPayload?.stats ?? {};
      return {
        gameDay: latestTransitSnapshot.gameDay,
        dailyRidership: city.dailyRidership,
        transitShare: city.transitShare,
        profitLossRatio: city.profitLossRatio,
        deniedBoardings: city.deniedBoardings,
        transfers: city.transfers,
        fareRevenue: city.fareRevenue,
        operatingCost: city.operatingCost,
        pathRecomputeCount: latestTransitSnapshot.pathRecomputeCount,
        demandPairCount: latestTransitSnapshot.demandPairCount,
      };
    },
  };
  const saveLiveState = async () => {
    const transitState = transitClient
      ? await transitClient.requestSaveState()
      : restoredPayload?.transit;
    return saveCurrentState(saveStorage, saveStateProviders, Date.now(), transitState);
  };
  const showStatus = (message: string): void => {
    ui.status.textContent = message;
    ui.status.hidden = false;
  };
  const updateEditorControls = (): void => {
    const network = networkHistory.network;
    const station = selectedNetworkItem?.type === 'station'
      ? network.stations.find(({ id }) => id === selectedNetworkItem?.id)
      : undefined;
    const line = selectedNetworkItem?.type === 'line'
      ? network.lines.find(({ id }) => id === selectedNetworkItem?.id)
      : undefined;
    ui.editorSelection.textContent = station
      ? `車站：${station.name}`
      : line ? `路線：${line.name}` : '尚未選取路網項目';
    ui.deleteStationButton.disabled = !station;
    ui.deleteLineButton.disabled = !line;
    ui.undoButton.disabled = !networkHistory.canUndo;
    ui.redoButton.disabled = !networkHistory.canRedo;
    for (const [tool, button] of ui.editorToolButtons) {
      button.setAttribute('aria-pressed', String(tool === activeEditorTool));
    }
    const canvas = app?.canvas;
    if (canvas) canvas.dataset.editorTool = activeEditorTool;
  };
  const updateSpacingHint = (network: Network): void => {
    const warnings = network.lines.flatMap((line) => lineSpacingWarnings(line, network.stations));
    ui.spacingHint.hidden = warnings.length === 0;
    ui.spacingHint.textContent = warnings.length > 0
      ? `站距提示：${warnings.length} 個路段超出建議範圍（只提示，不限制建線）。`
      : '';
  };
  const syncNetwork = (network: Network): void => {
    if (selectedNetworkItem?.type === 'station'
      && !network.stations.some(({ id }) => id === selectedNetworkItem?.id)) selectedNetworkItem = undefined;
    if (selectedNetworkItem?.type === 'line'
      && !network.lines.some(({ id }) => id === selectedNetworkItem?.id)) selectedNetworkItem = undefined;
    rendererState.current?.setNetwork(network);
    rendererState.current?.setNetworkSelection(selectedNetworkItem);
    transitClient?.setNetwork(network);
    updateSpacingHint(network);
    updateEditorControls();
    updatePanels();
  };
  const executeNetworkCommand = (command: NetworkCommand, selection?: NetworkSelection): Network => {
    const network = networkHistory.execute(command);
    if (selection !== undefined) selectedNetworkItem = selection;
    syncNetwork(network);
    return network;
  };
  const selectNetworkItem = (selection?: NetworkSelection): void => {
    selectedNetworkItem = selection;
    rendererState.current?.setNetworkSelection(selection);
    updateEditorControls();
    updatePanels();
  };
  panelControllerRef.current = createSimulationPanels(mount, {
    renameStation: (stationId, name) => {
      try {
        executeNetworkCommand(renameStation(stationId, name), { type: 'station', id: stationId });
      } catch (error) {
        showStatus(error instanceof Error ? error.message : '無法更改車站名稱。');
      }
    },
    setLineTrains: (lineId, peakTrains, offPeakTrains) => {
      try {
        executeNetworkCommand(setLineTrains(lineId, peakTrains, offPeakTrains), { type: 'line', id: lineId });
      } catch (error) {
        showStatus(error instanceof Error ? error.message : '無法調整列車數。');
      }
    },
    setLineCars: (lineId, cars) => {
      try {
        executeNetworkCommand(setLineCars(lineId, cars), { type: 'line', id: lineId });
      } catch (error) {
        showStatus(error instanceof Error ? error.message : '無法調整列車節數。');
      }
    },
  });
  panelControllerRef.current.element.hidden = !rendererState.current?.isMetroView;
  updatePanels();
  for (const [tool, button] of ui.editorToolButtons) {
    button.addEventListener('click', () => {
      activeEditorTool = tool;
      updateEditorControls();
    });
  }
  ui.lineModeSelect.addEventListener('change', () => {
    newLineMode = ui.lineModeSelect.value === 'metro' ? 'metro' : 'brt';
  });
  ui.deleteStationButton.addEventListener('click', () => {
    if (selectedNetworkItem?.type !== 'station') return;
    executeNetworkCommand(deleteStation(selectedNetworkItem.id));
  });
  ui.deleteLineButton.addEventListener('click', () => {
    if (selectedNetworkItem?.type !== 'line') return;
    executeNetworkCommand(deleteLine(selectedNetworkItem.id));
  });
  ui.undoButton.addEventListener('click', () => syncNetwork(networkHistory.undo()));
  ui.redoButton.addEventListener('click', () => syncNetwork(networkHistory.redo()));
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      syncNetwork(event.shiftKey ? networkHistory.redo() : networkHistory.undo());
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      syncNetwork(networkHistory.redo());
    }
  });
  const exportButton = mount.querySelector<HTMLButtonElement>('[data-action="export-save"]');
  const importButton = mount.querySelector<HTMLButtonElement>('[data-action="import-save"]');
  exportButton?.addEventListener('click', () => {
    void (async () => {
      const record = await saveLiveState();
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
    if (simulationClient.getStatus().paused) {
      simulationClient.resume();
      transitClient?.resume();
    } else {
      simulationClient.pause();
      transitClient?.pause();
    }
    updateSimulationUi();
  });
  ui.simSpeedSelect.value = String(selectedSimSpeed);
  ui.simSpeedSelect.addEventListener('change', () => {
    const value = Number(ui.simSpeedSelect.value);
    if (value !== 1 && value !== 2 && value !== 4) return;
    selectedSimSpeed = value;
    simulationClient?.setSpeed(value);
    transitClient?.setSpeed(value);
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
      updateSimulationUi();
    } else if (!document.hidden && automaticPauseOnHide) {
      automaticPauseOnHide = false;
      simulationClient?.resume();
      transitClient?.resume();
      updateSimulationUi();
    }
    if (!document.hidden) renderScheduler?.invalidate();
    renderScheduler?.setSimulationActivity(
      Boolean(transitClient && !transitClient.getStatus().paused),
      mapRenderer?.hasVisibleTrains ?? false,
    );
    if (document.hidden) {
      void saveLiveState().catch((error: unknown) => {
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
      ui.editorToolbar.hidden = !rendererState.current?.isMetroView;
      updateEditorControls();
      ui.status.hidden = true;
    }).catch((error: unknown) => {
      console.error('Unable to load North–North village geometry', error);
      ui.status.textContent = '北北村里資料載入失敗，請返回全島後再試。';
      ui.status.hidden = false;
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
      ui.infoCard.hidden = true;
      ui.densityLegend.hidden = !active || !hasVillageGeometry;
      ui.editorToolbar.hidden = !active || !hasVillageGeometry;
      if (panelControllerRef.current) panelControllerRef.current.element.hidden = !active;
      if (active) ensureVillageGeometry();
      else if (ui.status.textContent === '載入北北村里資料中…') ui.status.hidden = true;
    },
    () => renderScheduler?.invalidate(),
  );
  rendererState.current = createdRenderer;
  mapRenderer = createdRenderer;
  ui.enterMetroButton.addEventListener('click', () => createdRenderer.enterMetroView());
  ui.returnIslandButton.addEventListener('click', () => createdRenderer.returnToIslandView());

  type PendingEdit =
    | { kind: 'place'; occupied: boolean; startScreen: NetworkEditorPointer['screen'] }
    | { kind: 'move'; stationId: string; startScreen: NetworkEditorPointer['screen'] }
    | { kind: 'line'; stationId: string; start: [number, number]; extend?: LineExtension }
    | { kind: 'insert'; lineId: string; segmentIndex: number };
  type LineExtension = { lineId: string; end: 'start' | 'end' };
  let pendingEdit: PendingEdit | undefined;
  const villageAt: VillageAt = (lon, lat) => createdRenderer.villageNameAt(lon, lat);
  const endpointLineForStation = (stationId: string): { lineId: string; end: 'start' | 'end' } | undefined => {
    const network = networkHistory.network;
    const selectedLine = selectedNetworkItem?.type === 'line'
      ? network.lines.find(({ id }) => id === selectedNetworkItem?.id)
      : undefined;
    const preferred = selectedLine ? [selectedLine, ...network.lines.filter(({ id }) => id !== selectedLine.id)] : network.lines;
    for (const line of preferred) {
      if (line.stationIds[0] === stationId) return { lineId: line.id, end: 'start' };
      if (line.stationIds[line.stationIds.length - 1] === stationId) return { lineId: line.id, end: 'end' };
    }
    return undefined;
  };
  const stationCommandAt = (point: readonly [number, number]): NetworkCommand =>
    placeStation({ lon: point[0], lat: point[1], villageAt });
  const showPreviewStation = (point: readonly [number, number]): void => {
    createdRenderer.setNetworkPreview(stationCommandAt(point).apply(networkHistory.network));
  };
  const clearEditPreview = (): void => {
    pendingEdit = undefined;
    createdRenderer.setNetworkPreview(undefined);
    createdRenderer.setEditPreviewLine();
  };
  const insertAtPoint = (lineId: string, segmentIndex: number, point: readonly [number, number]): void => {
    const network = networkHistory.network;
    const stationId = `s${network.nextId}`;
    const addStation = stationCommandAt(point);
    const insert = insertStation(lineId, segmentIndex, { stationId });
    executeNetworkCommand(combineCommands([addStation, insert], 'insertStationAtPoint'), { type: 'station', id: stationId });
  };
  const drawLineFromStation = (startStationId: string, pointer: NetworkEditorPointer, extension?: LineExtension): void => {
    const network = networkHistory.network;
    const targetStationId = pointer.hit?.type === 'station' ? pointer.hit.stationId : undefined;
    if (targetStationId === startStationId) return;
    if (extension) {
      if (targetStationId) {
        const line = network.lines.find(({ id }) => id === extension.lineId);
        if (!line || line.stationIds.includes(targetStationId)) {
          showStatus('不能把已在線上的車站再次延伸到同一路線。');
          return;
        }
        executeNetworkCommand(extendLine(extension.lineId, extension.end, { stationId: targetStationId }), {
          type: 'line', id: extension.lineId,
        });
        return;
      }
      const stationId = `s${network.nextId}`;
      const addStation = stationCommandAt(pointer.lonLat);
      const extend = extendLine(extension.lineId, extension.end, { stationId });
      executeNetworkCommand(combineCommands([addStation, extend], 'extendLineToPoint'), {
        type: 'line', id: extension.lineId,
      });
      return;
    }
    if (targetStationId) {
      const lineId = `l${network.nextId}`;
      executeNetworkCommand(createLine(startStationId, targetStationId, newLineMode), { type: 'line', id: lineId });
      return;
    }
    const stationId = `s${network.nextId}`;
    const lineId = `l${network.nextId + 1}`;
    const addStation = stationCommandAt(pointer.lonLat);
    const line = createLine(startStationId, stationId, newLineMode);
    executeNetworkCommand(combineCommands([addStation, line], 'createLineToPoint'), { type: 'line', id: lineId });
  };

  createdRenderer.setEditorPointerHandler({
    pointerDown(pointer) {
      if (!hasVillageGeometry) return false;
      if (activeEditorTool === 'place') {
        pendingEdit = {
          kind: 'place',
          occupied: pointer.hit?.type === 'station',
          startScreen: pointer.screen,
        };
        return true;
      }
      if (activeEditorTool === 'line' && pointer.hit?.type === 'station') {
        const stationId = pointer.hit.stationId;
        const station = networkHistory.network.stations.find(({ id }) => id === stationId);
        if (!station) return false;
        pendingEdit = {
          kind: 'line',
          stationId,
          start: [station.lon, station.lat],
          extend: endpointLineForStation(stationId),
        };
        selectNetworkItem({ type: 'station', id: stationId });
        return true;
      }
      if (activeEditorTool === 'insert' && pointer.hit?.type === 'line') {
        pendingEdit = { kind: 'insert', lineId: pointer.hit.lineId, segmentIndex: pointer.hit.segmentIndex };
        selectNetworkItem({ type: 'line', id: pointer.hit.lineId });
        return true;
      }
      if (activeEditorTool === 'select' && pointer.hit?.type === 'station') {
        pendingEdit = { kind: 'move', stationId: pointer.hit.stationId, startScreen: pointer.screen };
        selectNetworkItem({ type: 'station', id: pointer.hit.stationId });
        return true;
      }
      if (activeEditorTool === 'select' && pointer.hit?.type === 'line') {
        selectNetworkItem({ type: 'line', id: pointer.hit.lineId });
        return true;
      }
      return false;
    },
    pointerMove(pointer) {
      if (!pendingEdit) return;
      if ('startScreen' in pendingEdit
        && Math.hypot(pointer.screen.x - pendingEdit.startScreen.x, pointer.screen.y - pendingEdit.startScreen.y) <= 4) return;
      if (pendingEdit.kind === 'place' && !pendingEdit.occupied) {
        showPreviewStation(pointer.lonLat);
      } else if (pendingEdit.kind === 'move') {
        const preview = moveStation(pendingEdit.stationId, pointer.lonLat[0], pointer.lonLat[1], villageAt)
          .apply(networkHistory.network);
        createdRenderer.setNetworkPreview(preview);
      } else if (pendingEdit.kind === 'line') {
        createdRenderer.setEditPreviewLine(pendingEdit.start, pointer.lonLat);
      } else if (pendingEdit.kind === 'insert') {
        const network = networkHistory.network;
        const stationId = `s${network.nextId}`;
        const preview = combineCommands([
          stationCommandAt(pointer.lonLat),
          insertStation(pendingEdit.lineId, pendingEdit.segmentIndex, { stationId }),
        ], 'previewInsertStation').apply(network);
        createdRenderer.setNetworkPreview(preview);
      }
    },
    pointerUp(pointer, dragged) {
      const edit = pendingEdit;
      clearEditPreview();
      if (!edit) return;
      if (edit.kind === 'place') {
        if (!dragged && !edit.occupied) {
          const stationId = `s${networkHistory.network.nextId}`;
          executeNetworkCommand(stationCommandAt(pointer.lonLat), { type: 'station', id: stationId });
        }
      } else if (edit.kind === 'move' && dragged) {
        executeNetworkCommand(moveStation(edit.stationId, pointer.lonLat[0], pointer.lonLat[1], villageAt), {
          type: 'station', id: edit.stationId,
        });
      } else if (edit.kind === 'line' && dragged) {
        drawLineFromStation(edit.stationId, pointer, edit.extend);
      } else if (edit.kind === 'insert') {
        insertAtPoint(edit.lineId, edit.segmentIndex, pointer.lonLat);
      }
    },
    pointerCancel() {
      clearEditPreview();
    },
  });

  createdRenderer.setNetwork(networkHistory.network);
  updateSpacingHint(networkHistory.network);
  updateEditorControls();
  if (restoredPayload?.view === 'metro') createdRenderer.enterMetroView();
  if (restoredPayload) createdRenderer.setCameraView(restoredPayload.camera.x, restoredPayload.camera.y, restoredPayload.camera.zoom);

  currentLodForStats = createdRenderer.currentLod;
  visibleCountyCount = createdRenderer.countiesInView.length;

  simulationClient = new SimClient(undefined, () => performance.now());
  const restoredSimulation = restoredPayload?.simulation;
  simulationClient.start(restoredSimulation?.seed ?? 0x545257, restoredSimulation, {
    speed: restoredSimulation?.speed ?? selectedSimSpeed,
    paused: restoredSimulation?.paused ?? false,
  });
  transitClient = new SimClient(undefined, () => performance.now());
  transitClient.subscribe((snapshot) => {
    if ('trains' in snapshot) {
      latestTransitSnapshot = snapshot;
      createdRenderer.setTrainPositions(snapshot.trains);
      renderScheduler?.setSimulationActivity(
        Boolean(transitClient && !transitClient.getStatus().paused),
        createdRenderer.hasVisibleTrains,
      );
      updatePanels();
    }
  });
  const dataBase = new URL(import.meta.env.BASE_URL, document.baseURI);
  transitClient.startTransit(
    restoredSimulation?.seed ?? 0x545257,
    { kind: 'url', url: new URL('data/villages-6300065000.json', dataBase).href },
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
      ...(latestTransitSnapshot ? { summary: structuredClone(latestTransitSnapshot) } : {}),
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
      executeNetworkCommand(combineCommands(commands, 'debugBuildTestLine'), { type: 'line', id: lineId });
      return lineId;
    },
    setTrainCounts: (lineId, peakTrains, offPeakTrains) => {
      executeNetworkCommand(setLineTrains(lineId, peakTrains, offPeakTrains), { type: 'line', id: lineId });
    },
  };
  ui.simSpeedSelect.value = String(selectedSimSpeed);
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
  updateSimulationUi();
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
