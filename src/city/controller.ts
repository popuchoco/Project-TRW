import {
  combineCommands,
  createLine,
  deleteLine,
  deleteStation,
  extendLine,
  insertStation,
  moveStation,
  placeStation,
  type NetworkCommand,
  type VillageAt,
} from './commands';
import { History } from './history';
import { lineSpacingWarnings, type Network } from './network';
import { followReducer, type FollowEvent, type FollowState } from './follow';
import type { TransitModeId } from './modes';
import { MapRenderer, type NetworkEditorPointer, type NetworkSelection } from '../render/MapRenderer';
import type { RepresentativePassenger } from '../sim/transit/representative';

export type EditorTool = 'select' | 'place' | 'line' | 'insert';

export type PendingEdit =
  | { kind: 'place'; occupied: boolean; startScreen: NetworkEditorPointer['screen'] }
  | { kind: 'move'; stationId: string; startScreen: NetworkEditorPointer['screen'] }
  | { kind: 'line'; stationId: string; start: [number, number]; extend?: LineExtension }
  | { kind: 'insert'; lineId: string; segmentIndex: number };

export type LineExtension = { lineId: string; end: 'start' | 'end' };

export interface CityEditorUi {
  editorSelection: HTMLElement;
  deleteStationButton: HTMLButtonElement;
  deleteLineButton: HTMLButtonElement;
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  editorToolButtons: Map<EditorTool, HTMLButtonElement>;
  lineModeSelect: HTMLSelectElement;
  enterMetroButton: HTMLButtonElement;
  returnIslandButton: HTMLButtonElement;
  spacingHint: HTMLElement;
}

interface CityRestoreState {
  view: 'island' | 'metro';
  camera: { x: number; y: number; zoom: number };
}

interface CityControllerDeps {
  ui: CityEditorUi;
  networkHistory: History;
  rendererState: { current?: MapRenderer };
  getCanvas: () => HTMLCanvasElement | undefined;
  setTransitNetwork: (network: Network) => void;
  updatePanels: () => void;
  showStatus: (message: string) => void;
}

export interface CityController {
  getNetworkVersion(): number;
  getSelectedNetworkItem(): NetworkSelection;
  updateEditorControls(): void;
  updateSpacingHint(network: Network): void;
  syncNetwork(network: Network): void;
  executeNetworkCommand(command: NetworkCommand, selection?: NetworkSelection): Network;
  selectNetworkItem(selection?: NetworkSelection): void;
  followLine(lineId: string): boolean;
  followPassenger(trip: RepresentativePassenger, startGameTime: number): boolean;
  replayPassenger(startGameTime: number): boolean;
  closePassengerFollow(): void;
  bindControls(): void;
  attachRenderer(
    createdRenderer: MapRenderer,
    hasVillageGeometry: () => boolean,
    restoredPayload?: CityRestoreState,
  ): (point: readonly [number, number]) => NetworkCommand;
}

export function createCityController({
  ui,
  networkHistory,
  rendererState,
  getCanvas,
  setTransitNetwork,
  updatePanels,
  showStatus,
}: CityControllerDeps): CityController {
  let selectedNetworkItem: NetworkSelection;
  let activeEditorTool: EditorTool = 'select';
  let newLineMode: TransitModeId = 'brt';
  let followState: FollowState = { kind: 'idle' };
  let networkVersion = 0;

  const transitionFollow = (event: FollowEvent): void => {
    const next = followReducer(followState, event);
    if (next === followState) return;
    followState = next;
    rendererState.current?.setFollowState(followState);
    updatePanels();
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
    const canvas = getCanvas();
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
    networkVersion += 1;
    const followedLineId = followState.kind === 'followingTrain' ? followState.lineId : undefined;
    if (followedLineId && !network.lines.some(({ id }) => id === followedLineId)) {
      transitionFollow({ type: 'lineDeleted', lineId: followedLineId });
    }
    if (followState.kind === 'followingPassenger' || followState.kind === 'passengerTripEnded') {
      const trip = followState.trip;
      const tripStationIds = [trip.selectedStationId, trip.startStationId, trip.endStationId];
      for (const leg of trip.legs) {
        if (leg.fromStationId) tripStationIds.push(leg.fromStationId);
        if (leg.toStationId) tripStationIds.push(leg.toStationId);
      }
      const deletedStationId = tripStationIds.find((stationId) =>
        !network.stations.some((station) => station.id === stationId));
      if (deletedStationId) transitionFollow({ type: 'stationDeleted', stationId: deletedStationId });
    }
    if (selectedNetworkItem?.type === 'station'
      && !network.stations.some(({ id }) => id === selectedNetworkItem?.id)) selectedNetworkItem = undefined;
    if (selectedNetworkItem?.type === 'line'
      && !network.lines.some(({ id }) => id === selectedNetworkItem?.id)) selectedNetworkItem = undefined;
    rendererState.current?.setNetwork(network);
    rendererState.current?.setNetworkSelection(selectedNetworkItem);
    setTransitNetwork(network);
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

  const bindControls = (): void => {
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
      if (event.key === 'Escape') {
        transitionFollow({ type: 'escape' });
        return;
      }
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
  };

  const followLine = (lineId: string): boolean => {
    const line = networkHistory.network.lines.find(({ id }) => id === lineId);
    const train = rendererState.current?.getTrainOnLine(lineId);
    if (!line || !train) {
      showStatus('目前沒有可跟隨的列車。');
      return false;
    }
    transitionFollow({ type: 'start', trainId: train.id, lineId: line.id });
    return true;
  };

  const followPassenger = (trip: RepresentativePassenger, startGameTime: number): boolean => {
    if (!Number.isFinite(startGameTime)
      || !networkHistory.network.stations.some(({ id }) => id === trip.selectedStationId)) return false;
    transitionFollow({ type: 'startPassenger', trip, startGameTime });
    return true;
  };

  const replayPassenger = (startGameTime: number): boolean => {
    if (followState.kind !== 'passengerTripEnded' || !Number.isFinite(startGameTime)) return false;
    transitionFollow({ type: 'replay', startGameTime });
    return true;
  };

  const closePassengerFollow = (): void => transitionFollow({ type: 'close' });

  const attachRenderer = (
    createdRenderer: MapRenderer,
    hasVillageGeometry: () => boolean,
    restoredPayload?: CityRestoreState,
  ): ((point: readonly [number, number]) => NetworkCommand) => {
    createdRenderer.setFollowState(followState);
    createdRenderer.setFollowHandlers({
      start: (trainId, lineId) => transitionFollow({ type: 'start', trainId, lineId }),
      drag: () => transitionFollow({ type: 'drag' }),
      trainGone: (trainId) => transitionFollow({ type: 'trainGone', trainId }),
      tripFinished: () => transitionFollow({ type: 'tripFinished' }),
    });
    const showAllNorthNorthButton = document.createElement('button');
    showAllNorthNorthButton.type = 'button';
    showAllNorthNorthButton.className = ui.returnIslandButton.className;
    showAllNorthNorthButton.textContent = '顯示全北北';
    ui.returnIslandButton.parentElement?.insertBefore(showAllNorthNorthButton, ui.returnIslandButton);
    showAllNorthNorthButton.addEventListener('click', () => createdRenderer.showAllNorthNorth());
    ui.enterMetroButton.addEventListener('click', () => createdRenderer.enterMetroView());
    ui.returnIslandButton.addEventListener('click', () => createdRenderer.returnToIslandView());

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
        if (!hasVillageGeometry()) return false;
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
    if (restoredPayload?.view === 'metro') {
      createdRenderer.enterMetroView({ savedCamera: restoredPayload.camera });
    }
    if (restoredPayload) createdRenderer.setCameraView(restoredPayload.camera.x, restoredPayload.camera.y, restoredPayload.camera.zoom);
    return stationCommandAt;
  };

  return {
    getNetworkVersion: () => networkVersion,
    getSelectedNetworkItem: () => selectedNetworkItem,
    updateEditorControls,
    updateSpacingHint,
    syncNetwork,
    executeNetworkCommand,
    selectNetworkItem,
    followLine,
    followPassenger,
    replayPassenger,
    closePassengerFollow,
    bindControls,
    attachRenderer,
  };
}
