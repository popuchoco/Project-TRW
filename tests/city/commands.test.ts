import { describe, expect, it } from 'vitest';
import {
  createLine,
  deleteLine,
  deleteStation,
  extendLine,
  generateStationName,
  insertStation,
  moveStation,
  placeStation,
  renameStation,
  setLineCars,
  setLineTrains,
  type NetworkCommand,
  type VillageAt,
} from '../../src/city/commands';
import { History } from '../../src/city/history';
import { createEmptyNetwork, isTransferStation, type Network } from '../../src/city/network';

const villageAt: VillageAt = (lon) => lon < 121.5
  ? { name: '學府里', townName: '大安區' }
  : { name: '新生里', townName: '中正區' };

function apply(network: Network, command: NetworkCommand): Network {
  return command.apply(network);
}

function addStation(network: Network, lon: number, name?: string): Network {
  return apply(network, placeStation({ lon, lat: 25, villageAt, ...(name ? { name } : {}) }));
}

describe('network editing commands', () => {
  it('creates and disambiguates automatic village station names', () => {
    let network = createEmptyNetwork();
    network = addStation(network, 121.1);
    network = addStation(network, 121.2);
    network = addStation(network, 121.3);
    expect(network.stations.map(({ name }) => name)).toEqual([
      '學府里站',
      '大安區學府里站',
      '大安區學府里站 (2)',
    ]);
    expect(generateStationName(network, 122, 25, villageAt)).toBe('新生里站');
  });

  it('falls back to the town name for an unassigned village before applying duplicates', () => {
    const unassigned: VillageAt = () => ({ name: '', townName: '石門區' });
    let network = addStation(createEmptyNetwork(), 121.1);
    const first = placeStation({ lon: 121.2, lat: 25, villageAt: unassigned });
    network = apply(network, first);
    const second = placeStation({ lon: 121.3, lat: 25, villageAt: unassigned });
    network = apply(network, second);

    expect(network.stations.map(({ name }) => name)).toEqual(['學府里站', '石門區站', '石門區站 (2)']);
  });

  it('updates automatic names after moving and preserves manual names', () => {
    let network = addStation(createEmptyNetwork(), 121.1);
    const stationId = network.stations[0]!.id;
    network = apply(network, moveStation(stationId, 122, 25, villageAt));
    expect(network.stations[0]?.name).toBe('新生里站');

    network = apply(network, renameStation(stationId, '  市政府站  '));
    network = apply(network, moveStation(stationId, 121.1, 25.1, villageAt));
    expect(network.stations[0]).toMatchObject({ name: '市政府站', nameManual: true, lon: 121.1, lat: 25.1 });
  });

  it('extends and inserts existing or newly placed stations in the requested positions', () => {
    let network = createEmptyNetwork();
    network = addStation(network, 121.1);
    network = addStation(network, 121.2);
    network = addStation(network, 121.3);
    network = addStation(network, 121.4);
    const [a, b, c, d] = network.stations.map(({ id }) => id);
    network = apply(network, createLine(a!, b!, 'metro'));
    const lineId = network.lines[0]!.id;
    network = apply(network, extendLine(lineId, 'start', { stationId: c! }));
    network = apply(network, extendLine(lineId, 'end', { lon: 121.5, lat: 25, villageAt }));
    network = apply(network, insertStation(lineId, 1, { stationId: d! }));
    expect(network.lines[0]?.stationIds).toEqual([c, a, d, b, 's6']);
    expect(network.stations).toHaveLength(5);
  });

  it('deletes a station from every line and removes lines that fall below two stations', () => {
    let network = createEmptyNetwork();
    network = addStation(network, 121.1);
    network = addStation(network, 121.2);
    network = addStation(network, 121.3);
    network = addStation(network, 121.4);
    const [a, b, c, d] = network.stations.map(({ id }) => id);
    network = apply(network, createLine(a!, b!, 'brt', { name: 'First' }));
    network = apply(network, createLine(b!, c!, 'metro', { name: 'Second' }));
    network = apply(network, createLine(c!, d!, 'brt', { name: 'Third' }));
    const beforeDelete = network;
    network = apply(network, deleteStation(a!));
    expect(network.lines.map(({ name }) => name)).toEqual(['Second', 'Third']);
    network = apply(network, deleteStation(b!));
    expect(network.lines.map(({ name }) => name)).toEqual(['Third']);

    const restored = deleteStation(a!).inverse(beforeDelete).apply(deleteStation(a!).apply(beforeDelete));
    expect(restored).toEqual(beforeDelete);
  });

  it('recognizes a BRT and metro transfer station and removes lines directly', () => {
    let network = createEmptyNetwork();
    network = addStation(network, 121.1);
    network = addStation(network, 121.2);
    network = addStation(network, 121.3);
    const [a, b, c] = network.stations.map(({ id }) => id);
    network = apply(network, createLine(a!, b!, 'brt'));
    network = apply(network, createLine(b!, c!, 'metro'));
    expect(isTransferStation(network, b!)).toBe(true);
    expect(isTransferStation(network, a!)).toBe(false);
    network = apply(network, deleteLine(network.lines[1]!.id));
    expect(isTransferStation(network, b!)).toBe(false);
  });

  it('sets train counts and clamps car counts to each mode rule', () => {
    let network = createEmptyNetwork();
    network = addStation(network, 121.1);
    network = addStation(network, 121.2);
    const [a, b] = network.stations.map(({ id }) => id);
    network = apply(network, createLine(a!, b!, 'metro'));
    network = apply(network, setLineTrains(network.lines[0]!.id, 7, 3));
    network = apply(network, setLineCars(network.lines[0]!.id, 99));
    expect(network.lines[0]).toMatchObject({ peakTrains: 7, offPeakTrains: 3, cars: 6 });
    network = apply(network, createLine(a!, b!, 'brt'));
    network = apply(network, setLineCars(network.lines[1]!.id, 4));
    expect(network.lines[1]?.cars).toBe(1);
    expect(() => setLineTrains(network.lines[0]!.id, -1, 2)).toThrow(RangeError);
  });
});

describe('network command history', () => {
  it('supports at least 50 undo steps and clears redo after a new command', () => {
    const history = new History(createEmptyNetwork(), 64);
    const checkpoints: Network[] = [history.network];
    for (let index = 0; index < 80; index += 1) {
      history.execute(placeStation({ lon: 121 + index / 1_000, lat: 25, villageAt }));
      checkpoints.push(history.network);
    }
    expect(history.undoDepth).toBe(64);
    for (let index = 0; index < 64; index += 1) history.undo();
    expect(history.network).toEqual(checkpoints[16]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    history.undo();
    expect(history.redoDepth).toBe(64);
    history.execute(placeStation({ lon: 123, lat: 25, villageAt }));
    expect(history.canRedo).toBe(false);
  });

  it('undoes and redoes a fixed-seed sequence of 220 commands exactly', () => {
    // Xorshift32 PRNG: keep seeded randomness in the test, never in simulation code.
    let seed = 0x51a7c0de;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const chooseStationInput = (network: Network, lineStationIds: readonly string[] = []) => {
      const available = network.stations.filter(({ id }) => !lineStationIds.includes(id));
      if (available.length > 0 && random() < 0.45) return { stationId: pick(available).id };
      const lon = 121 + random();
      return { lon, lat: 24.5 + random(), villageAt };
    };

    let network = createEmptyNetwork();
    const initial = network;
    const commands: NetworkCommand[] = [];
    const history = new History(initial, 256);

    for (let index = 0; index < 220; index += 1) {
      let nextCommand: NetworkCommand;
      const operation = Math.floor(random() * 10);
      const line = network.lines.length > 0 ? pick(network.lines) : undefined;
      const station = network.stations.length > 0 ? pick(network.stations) : undefined;

      if (operation <= 1 || network.stations.length < 2) {
        nextCommand = placeStation({ lon: 121 + random(), lat: 24.5 + random(), villageAt });
      } else if (operation === 2 || !line) {
        const candidates = network.stations;
        const first = pick(candidates);
        let second = pick(candidates);
        while (second.id === first.id) second = pick(candidates);
        nextCommand = createLine(first.id, second.id, random() < 0.5 ? 'brt' : 'metro');
      } else if (operation === 3) {
        nextCommand = extendLine(
          line.id,
          random() < 0.5 ? 'start' : 'end',
          chooseStationInput(network, line.stationIds),
        );
      } else if (operation === 4 && line.stationIds.length >= 2) {
        nextCommand = insertStation(
          line.id,
          Math.floor(random() * (line.stationIds.length - 1)),
          chooseStationInput(network, line.stationIds),
        );
      } else if (operation === 5 && station) {
        nextCommand = moveStation(station.id, 121 + random(), 24.5 + random(), villageAt);
      } else if (operation === 6 && network.stations.length > 2 && station) {
        nextCommand = deleteStation(station.id);
      } else if (operation === 7 && station) {
        nextCommand = renameStation(station.id, `Station ${index}`);
      } else if (operation === 8) {
        nextCommand = setLineTrains(line.id, Math.floor(random() * 12), Math.floor(random() * 8));
      } else if (operation === 9 && random() < 0.5) {
        nextCommand = setLineCars(line.id, Math.floor(random() * 10));
      } else if (operation === 9) {
        nextCommand = deleteLine(line.id);
      } else {
        nextCommand = placeStation({ lon: 121 + random(), lat: 24.5 + random(), villageAt });
      }

      const before = network;
      const after = nextCommand.apply(before);
      expect(nextCommand.inverse(before).apply(after)).toEqual(before);
      network = after;
      commands.push(nextCommand);
      history.execute(nextCommand);
    }

    const final = network;
    expect(commands).toHaveLength(220);
    expect(history.network).toEqual(final);
    for (let index = 0; index < commands.length; index += 1) history.undo();
    expect(history.network).toEqual(initial);
    for (let index = 0; index < commands.length; index += 1) history.redo();
    expect(history.network).toEqual(final);
  });
});
