import type { RepresentativePassenger } from '../sim/transit/representative';

interface PassengerRequestClient {
  requestRepresentativePassenger(stationId: string): Promise<RepresentativePassenger | null>;
  getStatus(): { gameTimeMs: number };
}

interface PassengerRequestHandlerOptions {
  getNetworkVersion(): number;
  isMetroViewActive(): boolean;
  getMetroViewRevision(): number;
  followPassenger(trip: RepresentativePassenger, gameTime: number): boolean;
  getGameTime(client: PassengerRequestClient): number;
  showStatus(message: string): void;
}

const CANCELLED_MESSAGE = '路網或畫面已變更，已取消跟隨代表旅客。';

/** Returns the next distinct station in a representative trip, wrapping at the end. */
export function nextPassengerStationId(trip: RepresentativePassenger): string | undefined {
  const stationIds: string[] = [];
  const seenStationIds = new Set<string>();
  const addStation = (stationId: string | undefined): void => {
    if (stationId !== undefined && !seenStationIds.has(stationId)) {
      seenStationIds.add(stationId);
      stationIds.push(stationId);
    }
  };

  addStation(trip.startStationId);
  for (const leg of trip.legs) {
    addStation(leg.fromStationId);
    addStation(leg.toStationId);
  }
  addStation(trip.endStationId);

  if (stationIds.length < 2) return undefined;
  const selectedIndex = stationIds.indexOf(trip.selectedStationId);
  if (selectedIndex === -1) return undefined;
  return stationIds[(selectedIndex + 1) % stationIds.length];
}

/** Guards asynchronous representative-passenger responses against stale network, view, or request state. */
export function createPassengerRequestHandler({
  getNetworkVersion,
  isMetroViewActive,
  getMetroViewRevision,
  followPassenger,
  getGameTime,
  showStatus,
}: PassengerRequestHandlerOptions): (
  stationId: string,
  client: PassengerRequestClient,
) => Promise<void> {
  let latestRequestToken = 0;

  return async (stationId, client): Promise<void> => {
    const requestToken = ++latestRequestToken;
    const networkVersion = getNetworkVersion();
    const startedInMetroView = isMetroViewActive();
    const metroViewRevision = getMetroViewRevision();
    const isStale = (): boolean => requestToken !== latestRequestToken
      || networkVersion !== getNetworkVersion()
      || !startedInMetroView
      || !isMetroViewActive()
      || metroViewRevision !== getMetroViewRevision();

    try {
      const trip = await client.requestRepresentativePassenger(stationId);
      if (isStale()) {
        showStatus(CANCELLED_MESSAGE);
        return;
      }
      if (!trip) {
        showStatus('此站目前沒有代表旅客（尚無經過此站的乘客）。');
        return;
      }
      if (!followPassenger(trip, getGameTime(client))) {
        showStatus('無法跟隨代表旅客。');
      }
    } catch (error: unknown) {
      if (isStale()) {
        showStatus(CANCELLED_MESSAGE);
        return;
      }
      showStatus(error instanceof Error ? error.message : '無法取得代表旅客。');
    }
  };
}
