import type { CityController } from '../city/controller';
import { renameStation, setLineCars, setLineTrains } from '../city/commands';
import type { History } from '../city/history';
import type { Network } from '../city/network';
import type { MapRenderer } from '../render/MapRenderer';
import { saveCurrentState, type SaveStateProviders } from '../save/state';
import type { SavePayloadV2, SaveRecord, SaveStorage } from '../save/types';
import type { SimClient, SimStartOptions } from '../sim/client';
import type { SimSpeed } from '../sim/clock';
import type { SimState } from '../sim/core';
import type { TransitWorkerSnapshot } from '../sim/protocol';
import { createLineFlowsCache, planLineFlowRequests } from './line-flows-cache';
import { importSaveFile, triggerSaveDownload } from '../save/import-export';
import { createSimulationPanels, type SimulationPanels } from './panels';
import type { AppUi } from './app-shell';
import { createPassengerRequestHandler, nextPassengerStationId } from './passenger-request';

interface PanelControllerDeps {
  mount: HTMLElement;
  ui: AppUi;
  networkHistory: History;
  rendererState: { current?: MapRenderer };
  getMapRenderer: () => MapRenderer | undefined;
  restoredPayload?: SavePayloadV2;
  freshSimulation: SimState;
  saveStorage: SaveStorage;
  getSimulationClient: () => SimClient | undefined;
  getTransitClient: () => SimClient | undefined;
  getSelectedSimSpeed: () => SimSpeed;
  setSelectedSimSpeed: (speed: SimSpeed) => void;
  getSelectedNetworkItem: () => ReturnType<CityController['getSelectedNetworkItem']>;
  showStatus: (message: string) => void;
  updateRenderActivity: (running: boolean, hasVisibleTrains: boolean) => void;
}

interface PanelController {
  updatePanels(): void;
  setMetroViewActive(active: boolean): void;
  initializePanels(cityController: CityController): void;
  bindSaveControls(): void;
  bindSimulationControls(): void;
  updateSimulationUi(): void;
  setSpeedSelection(): void;
  saveLiveState(): Promise<SaveRecord>;
  getLatestTransitSnapshot(): TransitWorkerSnapshot | undefined;
  startTransit(
    transitClient: SimClient,
    createdRenderer: MapRenderer,
    seed: number,
    network: Network,
    continuation: SavePayloadV2['transit'],
    options: SimStartOptions,
  ): void;
}

export function createPanelController({
  mount,
  ui,
  networkHistory,
  rendererState,
  getMapRenderer,
  restoredPayload,
  freshSimulation,
  saveStorage,
  getSimulationClient,
  getTransitClient,
  getSelectedSimSpeed,
  setSelectedSimSpeed,
  getSelectedNetworkItem,
  showStatus,
  updateRenderActivity,
}: PanelControllerDeps): PanelController {
  let latestTransitSnapshot: TransitWorkerSnapshot | undefined;
  const lineFlowsCache = createLineFlowsCache();
  const requestedLineFlows = new Set<string>();
  let lineFlowsFailureNotified = false;
  const panelControllerRef: { current?: SimulationPanels } = {};
  let metroViewActive = Boolean(rendererState.current?.isMetroView);
  let metroViewRevision = 0;
  const updatePanels = (): void => {
    const selectedNetworkItem = getSelectedNetworkItem();
    panelControllerRef.current?.update(
      networkHistory.network,
      latestTransitSnapshot,
      selectedNetworkItem?.type === 'station' ? selectedNetworkItem.id : undefined,
      (lineId) => lineFlowsCache.get(lineId),
    );
    const transitClient = getTransitClient();
    if (transitClient) {
      const lineIds = networkHistory.network.lines.map(({ id }) => id);
      for (const lineId of planLineFlowRequests(lineFlowsCache, lineIds, requestedLineFlows)) {
        requestedLineFlows.add(lineId);
        void transitClient.requestLineFlows(lineId).catch(() => {
          if (lineFlowsFailureNotified) return;
          lineFlowsFailureNotified = true;
          showStatus('路線斷面流量載入失敗。');
        });
      }
    }
    const followDisplay = getMapRenderer()?.getFollowDisplayInfo();
    const lineStats = followDisplay
      ? latestTransitSnapshot?.lines.find(({ lineId }) => lineId === followDisplay.lineId)
      : undefined;
    const loadFactor = lineStats?.periods.find(({ periodId }) =>
      periodId === latestTransitSnapshot?.currentPeriodId)?.maxLoadFactor;
    const followedPassenger = getMapRenderer()?.getFollowPassengerTrip();
    const network = networkHistory.network;
    const stationNames = new Map(network.stations.map(({ id, name }) => [id, name]));
    const lineNames = new Map(network.lines.map(({ id, name }) => [id, name]));
    panelControllerRef.current?.updateFollowInfo(
      followDisplay ? { ...followDisplay, loadFactor } : undefined,
      followedPassenger,
      stationNames,
      lineNames,
      getMapRenderer()?.isPassengerTripEnded() ?? false,
    );
  };
  const saveStateProviders: SaveStateProviders = {
    getNetwork: () => networkHistory.network,
    getCamera: () => {
      const camera = getMapRenderer()?.camera;
      return camera
        ? { x: camera.center.x, y: camera.center.y, zoom: camera.zoom }
        : restoredPayload?.camera ?? { x: 0, y: 0, zoom: 1 };
    },
    getView: () => rendererState.current?.isMetroView ? 'metro' : 'island',
    getSimulation: () => getSimulationClient()?.getSaveState() ?? restoredPayload?.simulation ?? {
      gameTimeMs: freshSimulation.gameTimeMs,
      speed: getSelectedSimSpeed(),
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
  const saveLiveState = async (): Promise<SaveRecord> => {
    const transitClient = getTransitClient();
    const transitState = transitClient
      ? await transitClient.requestSaveState()
      : restoredPayload?.transit;
    return saveCurrentState(saveStorage, saveStateProviders, Date.now(), transitState);
  };
  const updateSimulationUi = (): void => {
    const status = getSimulationClient()?.getStatus();
    ui.simPauseButton.textContent = status?.paused ? '繼續模擬' : '暫停模擬';
    ui.simPauseButton.setAttribute('aria-pressed', String(Boolean(status?.paused)));
  };

  const initializePanels = (cityController: CityController): void => {
    let followAnotherBaseline: ReturnType<MapRenderer['getFollowPassengerTrip']>;
    const requestPassenger = createPassengerRequestHandler({
      getNetworkVersion: () => cityController.getNetworkVersion(),
      isMetroViewActive: () => Boolean(rendererState.current?.isMetroView),
      getMetroViewRevision: () => metroViewRevision,
      followPassenger: (trip, gameTime) => {
        const baseline = followAnotherBaseline;
        followAnotherBaseline = undefined;
        if (baseline?.odKey === trip.odKey && baseline.pathSignature === trip.pathSignature) {
          showStatus('這條路線上沒有其他代表旅客');
          return true;
        }
        return cityController.followPassenger(trip, gameTime);
      },
      getGameTime: (client) => client.getStatus().gameTimeMs,
      showStatus,
    });
    panelControllerRef.current = createSimulationPanels(mount, {
      renameStation: (stationId, name) => {
        try {
          cityController.executeNetworkCommand(renameStation(stationId, name), { type: 'station', id: stationId });
        } catch (error) {
          showStatus(error instanceof Error ? error.message : '無法更改車站名稱。');
        }
      },
      setLineTrains: (lineId, peakTrains, offPeakTrains) => {
        try {
          cityController.executeNetworkCommand(setLineTrains(lineId, peakTrains, offPeakTrains), { type: 'line', id: lineId });
        } catch (error) {
          showStatus(error instanceof Error ? error.message : '無法調整列車數。');
        }
      },
      setLineCars: (lineId, cars) => {
        try {
          cityController.executeNetworkCommand(setLineCars(lineId, cars), { type: 'line', id: lineId });
        } catch (error) {
          showStatus(error instanceof Error ? error.message : '無法調整列車節數。');
        }
      },
      followLine: (lineId) => { cityController.followLine(lineId); },
      followPassenger: (stationId) => {
        followAnotherBaseline = undefined;
        const transitClient = getTransitClient();
        if (!transitClient) {
          showStatus('模擬尚未啟動，無法跟隨代表旅客。');
          return;
        }
        void requestPassenger(stationId, transitClient);
      },
      replayPassenger: () => {
        const gameTime = getTransitClient()?.getStatus().gameTimeMs;
        if (gameTime === undefined) {
          showStatus('模擬尚未啟動，無法重播。');
          return;
        }
        if (!cityController.replayPassenger(gameTime)) showStatus('無法重播代表旅客。');
      },
      followAnotherPassenger: () => {
        const currentPassenger = getMapRenderer()?.getFollowPassengerTrip();
        const stationId = currentPassenger ? nextPassengerStationId(currentPassenger) : undefined;
        if (!currentPassenger || !stationId) {
          showStatus('這條路線上沒有其他代表旅客');
          return;
        }
        const transitClient = getTransitClient();
        if (!transitClient) {
          showStatus('模擬尚未啟動，無法選擇另一位代表旅客。');
          return;
        }
        followAnotherBaseline = currentPassenger;
        void requestPassenger(stationId, transitClient);
      },
      closePassengerFollow: () => cityController.closePassengerFollow(),
    });
    metroViewActive = Boolean(rendererState.current?.isMetroView);
    panelControllerRef.current.element.hidden = !metroViewActive;
    updatePanels();
  };
  const setMetroViewActive = (active: boolean): void => {
    if (metroViewActive !== active) {
      metroViewActive = active;
      metroViewRevision += 1;
    }
    if (panelControllerRef.current) panelControllerRef.current.element.hidden = !active;
  };
  const bindSaveControls = (): void => {
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
  };
  const bindSimulationControls = (): void => {
    ui.simPauseButton.addEventListener('click', () => {
      const simulationClient = getSimulationClient();
      if (!simulationClient) return;
      if (simulationClient.getStatus().paused) {
        simulationClient.resume();
        getTransitClient()?.resume();
      } else {
        simulationClient.pause();
        getTransitClient()?.pause();
      }
      updateSimulationUi();
    });
    ui.simSpeedSelect.value = String(getSelectedSimSpeed());
    ui.simSpeedSelect.addEventListener('change', () => {
      const value = Number(ui.simSpeedSelect.value);
      if (value !== 1 && value !== 2 && value !== 4) return;
      setSelectedSimSpeed(value);
      getSimulationClient()?.setSpeed(value);
      getTransitClient()?.setSpeed(value);
    });
  };
  const setSpeedSelection = (): void => {
    ui.simSpeedSelect.value = String(getSelectedSimSpeed());
  };
  const startTransit = (
    transitClient: SimClient,
    createdRenderer: MapRenderer,
    seed: number,
    network: Network,
    continuation: SavePayloadV2['transit'],
    options: SimStartOptions,
  ): void => {
    lineFlowsCache.clear();
    requestedLineFlows.clear();
    transitClient.subscribe((snapshot) => {
      if ('trains' in snapshot) {
        latestTransitSnapshot = snapshot;
        createdRenderer.setTrainPositions(snapshot.trains);
        const currentTransitClient = getTransitClient();
        updateRenderActivity(
          Boolean(currentTransitClient && !currentTransitClient.getStatus().paused),
          createdRenderer.hasVisibleTrains,
        );
        updatePanels();
      }
    });
    transitClient.subscribeLineFlows((message) => {
      const previousVersion = lineFlowsCache.networkVersion();
      if (!lineFlowsCache.apply(message)) return;
      if (previousVersion !== message.networkVersion) {
        requestedLineFlows.clear();
        lineFlowsFailureNotified = false;
      }
      for (const line of message.lines) requestedLineFlows.delete(line.lineId);
      updatePanels();
    });
    const dataBase = new URL(import.meta.env.BASE_URL, document.baseURI);
    transitClient.startTransit(
      seed,
      { kind: 'url', url: new URL('data/villages-6300065000.json', dataBase).href },
      network,
      continuation,
      options,
    );
  };

  return {
    updatePanels,
    setMetroViewActive,
    initializePanels,
    bindSaveControls,
    bindSimulationControls,
    updateSimulationUi,
    setSpeedSelection,
    saveLiveState,
    getLatestTransitSnapshot: () => latestTransitSnapshot,
    startTransit,
  };
}
