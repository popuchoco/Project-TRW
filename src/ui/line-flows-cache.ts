import type { LineFlowsMessage } from '../sim/protocol';
import type { LineFlowsData } from '../sim/transit/TransitSim';

export interface LineFlowsCache {
  apply(message: LineFlowsMessage): boolean;
  get(lineId: string): LineFlowsData | undefined;
  networkVersion(): number | undefined;
  clear(): void;
}

export function createLineFlowsCache(): LineFlowsCache {
  let version: number | undefined;
  const lines = new Map<string, LineFlowsData>();

  return {
    apply(message) {
      if (version !== undefined && message.networkVersion < version) return false;

      if (version !== message.networkVersion) {
        lines.clear();
        version = message.networkVersion;
      }

      // Single-line replies contain one item; full replies contain all lines (or none).
      if (message.lines.length === 1) {
        const line = message.lines[0];
        if (line) lines.set(line.lineId, line);
      } else {
        lines.clear();
        for (const line of message.lines) lines.set(line.lineId, line);
      }
      return true;
    },
    get(lineId) {
      return lines.get(lineId);
    },
    networkVersion() {
      return version;
    },
    clear() {
      lines.clear();
      version = undefined;
    },
  };
}
