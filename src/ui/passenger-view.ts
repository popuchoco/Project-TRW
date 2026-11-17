import type { RepresentativePassenger, RepresentativePassengerLeg } from '../sim/transit/representative';

export interface PassengerViewModel {
  label: string;
  legs: readonly string[];
  totalText: string;
  whyText: string;
}

export type PassengerStationNames = ReadonlyMap<string, string>;

const minuteFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 });

function formatMinutes(minutes: number): string {
  return `${minuteFormat.format(Math.max(0, minutes))} 分`;
}

function stationName(stationId: string | undefined, names: PassengerStationNames): string {
  if (!stationId) return '未知車站';
  return names.get(stationId) ?? stationId;
}

function legDescription(leg: RepresentativePassengerLeg, names: PassengerStationNames): string {
  const from = stationName(leg.fromStationId, names);
  const to = stationName(leg.toStationId, names);
  const description = leg.kind === 'walkIn'
    ? `步行至 ${to}`
    : leg.kind === 'wait'
      ? `等候${leg.lineId ? ` ${leg.lineId}` : ''}（${from}）`
      : leg.kind === 'ride'
        ? `${leg.lineId ? `${leg.lineId}：` : ''}${from} → ${to}`
        : leg.kind === 'transfer'
          ? `於 ${from} 轉乘`
          : `步行離開 ${from}`;
  return `${description}・${formatMinutes(leg.minutes)}`;
}

/** Builds Traditional Chinese text for a representative passenger trip. */
export function buildPassengerViewModel(
  trip: RepresentativePassenger,
  stationNames: PassengerStationNames = new Map(),
): PassengerViewModel {
  const chosen = trip.doorToDoorMinutes;
  let whyText: string;
  if (trip.alternativeMinutes === null) {
    whyText = `為什麼選這條：沒有可比較的替代方案；此行程需 ${formatMinutes(chosen)}。`;
  } else {
    const alternative = trip.alternativeMinutes;
    const difference = Math.abs(chosen - alternative);
    const comparison = difference === 0
      ? '時間相同'
      : chosen < alternative ? `此行程較快 ${formatMinutes(difference)}` : `替代方案較快 ${formatMinutes(difference)}`;
    whyText = `為什麼選這條：此行程 ${formatMinutes(chosen)}；替代方案 ${formatMinutes(alternative)}（${comparison}）。`;
  }

  return {
    label: '模擬值／代表旅客',
    legs: trip.legs.map((leg) => legDescription(leg, stationNames)),
    totalText: `門到門時間：${formatMinutes(chosen)}`,
    whyText,
  };
}

/** Creates a DOM view using textContent only; documentRef can be a tiny test double. */
export function createPassengerView(
  documentRef: Pick<Document, 'createElement'>,
  model: PassengerViewModel,
): HTMLElement {
  const section = documentRef.createElement('section');
  section.className = 'representative-passenger';
  const heading = documentRef.createElement('h3');
  heading.textContent = '代表旅客行程';
  const label = documentRef.createElement('span');
  label.className = 'simulation-value-label';
  label.textContent = model.label;
  const legs = documentRef.createElement('ul');
  for (const leg of model.legs) {
    const item = documentRef.createElement('li');
    item.textContent = leg;
    legs.append(item);
  }
  const total = documentRef.createElement('p');
  total.textContent = model.totalText;
  const why = documentRef.createElement('p');
  why.textContent = model.whyText;
  section.append(heading, label, legs, total, why);
  return section;
}
