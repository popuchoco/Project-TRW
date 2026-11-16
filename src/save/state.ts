import type { Network } from "../city/network";
import type { SaveCamera, SavePayloadV2, SaveSimulationState, SaveView } from "./types";
import { savePayload } from "./save";
import type { SaveRecord, SaveStorage } from "./types";

/** Live application getters used to take a synchronous, consistent save snapshot. */
export interface SaveStateProviders {
  getNetwork(): Network;
  getCamera(): SaveCamera;
  getView(): SaveView;
  getSimulation(): SaveSimulationState;
  getStats(): Record<string, number>;
}

export function collectSavePayload(providers: SaveStateProviders): SavePayloadV2 {
  const network = providers.getNetwork();
  const simulation = providers.getSimulation();
  return {
    network: {
      stations: network.stations.map((station) => ({ ...station })),
      lines: network.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })),
      nextId: network.nextId,
    },
    camera: { ...providers.getCamera() },
    view: providers.getView(),
    simulation: { ...simulation },
    stats: { ...providers.getStats() },
  };
}

/** Persist the current providers and return the exact record callers should export. */
export function saveCurrentState(
  storage: SaveStorage,
  providers: SaveStateProviders,
  savedAt = Date.now(),
): Promise<SaveRecord> {
  return savePayload(storage, collectSavePayload(providers), savedAt);
}
