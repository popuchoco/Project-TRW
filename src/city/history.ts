import { createEmptyNetwork, type Network } from './network';
import type { NetworkCommand } from './commands';

const MIN_HISTORY_CAPACITY = 50;
const DEFAULT_HISTORY_CAPACITY = 200;

function cloneNetwork(network: Network): Network {
  return {
    stations: network.stations.map((station) => ({ ...station })),
    lines: network.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })),
    nextId: network.nextId,
  };
}

interface HistoryEntry {
  undo: NetworkCommand;
  redo: NetworkCommand;
}

/** Immutable network command history with bounded undo and redo stacks. */
export class History {
  private current: Network;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  constructor(initialNetwork: Network = createEmptyNetwork(), readonly capacity = DEFAULT_HISTORY_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < MIN_HISTORY_CAPACITY) {
      throw new RangeError(`History capacity must be at least ${MIN_HISTORY_CAPACITY}`);
    }
    this.current = cloneNetwork(initialNetwork);
  }

  get network(): Network {
    return cloneNetwork(this.current);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  execute(command: NetworkCommand): Network {
    const before = cloneNetwork(this.current);
    const inverse = command.inverse(before);
    const after = command.apply(cloneNetwork(before));
    this.current = cloneNetwork(after);
    this.undoStack.push({ undo: inverse, redo: command });
    if (this.undoStack.length > this.capacity) this.undoStack.shift();
    this.redoStack.length = 0;
    return this.network;
  }

  undo(): Network {
    const entry = this.undoStack.pop();
    if (!entry) return this.network;
    this.current = cloneNetwork(entry.undo.apply(cloneNetwork(this.current)));
    this.redoStack.push(entry);
    return this.network;
  }

  redo(): Network {
    const entry = this.redoStack.pop();
    if (!entry) return this.network;
    this.current = cloneNetwork(entry.redo.apply(cloneNetwork(this.current)));
    this.undoStack.push(entry);
    return this.network;
  }
}
