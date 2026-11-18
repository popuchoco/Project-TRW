import {
  lineHeadwaySeconds,
  lineHourlyCapacity,
  lineLengthKm,
  lineRoundTripTimeSeconds,
  type Line,
  type Network,
} from '../city/network';
import { MAX_NAME_LENGTH } from '../city/limits';
import type { FollowTrainInfo } from '../city/follow';
import { SIMULATION_BALANCE, TRANSIT_MODES, type SimulationPeriodId } from '../city/modes';
import type { TransitWireSummary } from '../sim/protocol';
import type { LineFlowsData } from '../sim/transit/TransitSim';
import type { RepresentativePassenger } from '../sim/transit/representative';
import { createQualityPanel, type QualityPanelRenderer } from './quality-view';
import {
  buildPassengerViewModel,
  createPassengerView,
  type PassengerLineNames,
  type PassengerStationNames,
} from './passenger-view';
import {
  createSectionFlowChart,
  sectionFlowFromSnapshot,
  type SectionFlowChartRenderer,
} from './section-flow-chart';

const numberFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  maximumFractionDigits: 0,
});

export function formatPanelCount(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function formatPanelKm(value: number): string {
  return `${value.toFixed(2)} 公里`;
}

export function formatPanelDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours} 小時 ${remainingMinutes} 分` : `${minutes} 分`;
}

export function formatPanelHeadway(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '無班次';
  const minutes = seconds / 60;
  return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分`;
}

export function formatPanelPercent(value: number): string {
  const percent = value * 100;
  // Small non-zero shares (e.g. early transit share) would otherwise read as 0%.
  if (percent !== 0 && Math.abs(percent) < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function formatPanelMoney(value: number): string {
  return moneyFormat.format(Math.round(value));
}

export interface PanelCallbacks {
  renameStation(stationId: string, name: string): void;
  setLineTrains(lineId: string, peakTrains: number, offPeakTrains: number): void;
  setLineCars(lineId: string, cars: number): void;
  followLine(lineId: string): void;
  followPassenger(stationId: string): void;
  replayPassenger(): void;
  closePassengerFollow(): void;
}

export interface SimulationPanels {
  element: HTMLElement;
  update(
    network: Network,
    snapshot: TransitWireSummary | undefined,
    selectedStationId?: string,
    getLineFlows?: (lineId: string) => LineFlowsData | undefined,
  ): void;
  updateFollowInfo(
    info: FollowTrainInfo | undefined,
    passenger?: RepresentativePassenger,
    stationNames?: PassengerStationNames,
    lineNames?: PassengerLineNames,
    tripEnded?: boolean,
  ): void;
}

interface PeriodRow {
  headway: HTMLElement;
  capacity: HTMLElement;
  load: HTMLElement;
  cost: HTMLElement;
}

interface LineCard {
  element: HTMLElement;
  title: HTMLElement;
  mode: HTMLElement;
  stationCount: HTMLElement;
  length: HTMLElement;
  roundTrip: HTMLElement;
  peakInput: HTMLInputElement;
  peakOutput: HTMLElement;
  offPeakInput: HTMLInputElement;
  offPeakOutput: HTMLElement;
  carsControl: HTMLElement;
  carsInput?: HTMLInputElement;
  carsOutput?: HTMLElement;
  totalCost: HTMLElement;
  qualityPanel: QualityPanelRenderer;
  sectionFlowChart: SectionFlowChartRenderer;
  periodRows: Map<SimulationPeriodId, PeriodRow>;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function makeValueRow(label: string): { row: HTMLElement; value: HTMLElement } {
  const row = element('div', 'panel-value-row');
  row.append(element('dt', '', label));
  const value = element('dd', '');
  row.append(value);
  return { row, value };
}

function makeSection(title: string): { section: HTMLElement; content: HTMLElement } {
  const section = element('section', 'operation-panel');
  const heading = element('h2', 'operation-panel-title', title);
  const badge = element('span', 'simulation-value-label', '模擬值');
  const header = element('div', 'operation-panel-header');
  header.append(heading, badge);
  const content = element('div', 'operation-panel-content');
  section.append(header, content);
  return { section, content };
}

function makeLineCard(line: Line, callbacks: PanelCallbacks): LineCard {
  const card = element('article', 'line-card');
  card.dataset.lineId = line.id;
  const heading = element('div', 'line-card-heading');
  const title = element('h3', 'line-card-title');
  const mode = element('span', 'line-card-mode');
  heading.append(title, mode);
  card.append(heading);

  const facts = element('dl', 'line-card-facts');
  const stationCount = makeValueRow('車站數');
  const length = makeValueRow('路線長度');
  const roundTrip = makeValueRow('來回一趟');
  facts.append(stationCount.row, length.row, roundTrip.row);
  card.append(facts);
  const qualityPanel = createQualityPanel();
  card.append(qualityPanel.element);
  const sectionFlowChart = createSectionFlowChart();
  card.append(sectionFlowChart.element);

  const controls = element('div', 'line-card-controls');
  const followButton = element('button', 'source-button', '跟隨列車');
  followButton.type = 'button';
  followButton.addEventListener('click', () => callbacks.followLine(line.id));
  const peakInput = element('input', 'panel-range');
  peakInput.type = 'range';
  peakInput.min = '0';
  peakInput.max = '60';
  peakInput.step = '1';
  peakInput.setAttribute('aria-label', `${line.name} 尖峰列車數`);
  const peakOutput = element('output', 'panel-control-value');
  const peakLabel = element('label', 'panel-control');
  peakLabel.append(element('span', '', '尖峰列車'), peakInput, peakOutput);

  const offPeakInput = element('input', 'panel-range');
  offPeakInput.type = 'range';
  offPeakInput.min = '0';
  offPeakInput.max = '60';
  offPeakInput.step = '1';
  offPeakInput.setAttribute('aria-label', `${line.name} 離峰列車數`);
  const offPeakOutput = element('output', 'panel-control-value');
  const offPeakLabel = element('label', 'panel-control');
  offPeakLabel.append(element('span', '', '離峰列車'), offPeakInput, offPeakOutput);
  controls.append(peakLabel, offPeakLabel);

  const carsControl = element('div', 'panel-control cars-control');
  let carsInput: HTMLInputElement | undefined;
  let carsOutput: HTMLElement | undefined;
  if (line.mode === 'metro') {
    carsInput = element('input', 'panel-range');
    carsInput.type = 'range';
    carsInput.min = String(TRANSIT_MODES.metro.carsMin);
    carsInput.max = String(TRANSIT_MODES.metro.carsMax);
    carsInput.step = '1';
    carsInput.setAttribute('aria-label', `${line.name} 列車節數`);
    carsOutput = element('output', 'panel-control-value');
    carsControl.append(element('span', '', '列車節數'), carsInput, carsOutput);
    carsInput.addEventListener('input', () => callbacks.setLineCars(line.id, Number(carsInput?.value)));
  } else {
    carsControl.append(element('span', '', '列車節數'), element('strong', '', '1 輛（固定）'));
  }
  cardsSetLineInputs(line, peakInput, peakOutput, offPeakInput, offPeakOutput, carsInput, carsOutput);
  peakInput.addEventListener('input', () => callbacks.setLineTrains(line.id, Number(peakInput.value), Number(offPeakInput.value)));
  offPeakInput.addEventListener('input', () => callbacks.setLineTrains(line.id, Number(peakInput.value), Number(offPeakInput.value)));
  controls.append(carsControl, followButton);
  card.append(controls);

  const periodTable = element('div', 'line-periods');
  periodTable.setAttribute('aria-label', `${line.name} 各時段模擬運能與成本`);
  const periodRows = new Map<SimulationPeriodId, PeriodRow>();
  for (const period of SIMULATION_BALANCE.periods) {
    const row = element('div', 'line-period-row');
    const name = element('strong', 'line-period-name', period.name);
    const headway = element('span', '');
    const capacity = element('span', '');
    const load = element('span', '');
    const cost = element('span', 'line-period-cost');
    row.append(name, headway, capacity, load, cost);
    periodTable.append(row);
    periodRows.set(period.id, { headway, capacity, load, cost });
  }
  const totalCost = element('p', 'line-total-cost');
  card.append(periodTable, totalCost);

  return {
    element: card,
    title,
    mode,
    stationCount: stationCount.value,
    length: length.value,
    roundTrip: roundTrip.value,
    peakInput,
    peakOutput,
    offPeakInput,
    offPeakOutput,
    carsControl,
    carsInput,
    carsOutput,
    totalCost,
    qualityPanel,
    sectionFlowChart,
    periodRows,
  };
}

function cardsSetLineInputs(
  line: Line,
  peakInput: HTMLInputElement,
  peakOutput: HTMLElement,
  offPeakInput: HTMLInputElement,
  offPeakOutput: HTMLElement,
  carsInput: HTMLInputElement | undefined,
  carsOutput: HTMLElement | undefined,
): void {
  const active = document.activeElement;
  peakInput.max = String(Math.max(60, line.peakTrains));
  offPeakInput.max = String(Math.max(60, line.offPeakTrains));
  if (active !== peakInput) peakInput.value = String(line.peakTrains);
  if (active !== offPeakInput) offPeakInput.value = String(line.offPeakTrains);
  peakOutput.textContent = `${formatPanelCount(line.peakTrains)} 列`;
  offPeakOutput.textContent = `${formatPanelCount(line.offPeakTrains)} 列`;
  if (carsInput && carsOutput) {
    if (active !== carsInput) carsInput.value = String(line.cars);
    carsOutput.textContent = `${line.cars} 節`;
  }
}

function updateLineCard(
  card: LineCard,
  line: Line,
  network: Network,
  snapshot: TransitWireSummary | undefined,
  getLineFlows?: (lineId: string) => LineFlowsData | undefined,
): void {
  const modeDefinition = TRANSIT_MODES[line.mode];
  const lineStats = snapshot?.lines.find((candidate) => candidate.lineId === line.id);
  card.title.textContent = line.name;
  card.mode.textContent = modeDefinition.name;
  card.stationCount.textContent = `${formatPanelCount(line.stationIds.length)} 站`;
  card.length.textContent = formatPanelKm(lineLengthKm(line, network.stations));
  card.roundTrip.textContent = formatPanelDuration(lineRoundTripTimeSeconds(line, network.stations));
  cardsSetLineInputs(line, card.peakInput, card.peakOutput, card.offPeakInput, card.offPeakOutput, card.carsInput, card.carsOutput);

  let totalOperatingCost = 0;
  for (const period of SIMULATION_BALANCE.periods) {
    const row = card.periodRows.get(period.id);
    if (!row) continue;
    const simulatedPeriod = lineStats?.periods.find((candidate) => candidate.periodId === period.id);
    const headwaySeconds = lineHeadwaySeconds(line, network.stations, period.id);
    const capacity = lineHourlyCapacity(line, network.stations, period.id);
    const hourlyCapacity = Number.isFinite(capacity) ? capacity : 0;
    const operatingCost = simulatedPeriod?.operatingCost ?? 0;
    totalOperatingCost += operatingCost;
    row.headway.textContent = `班距 ${formatPanelHeadway(Number.isFinite(headwaySeconds) ? headwaySeconds : null)}`;
    row.capacity.textContent = `運能 ${formatPanelCount(hourlyCapacity)} 人/時`;
    row.load.textContent = `最高負載 ${formatPanelPercent(simulatedPeriod?.maxLoadFactor ?? 0)}`;
    row.cost.textContent = formatPanelMoney(operatingCost);
  }
  card.totalCost.textContent = `每日營運成本（模擬值）：${formatPanelMoney(lineStats
    ? totalOperatingCost
    : 0)}`;
  card.qualityPanel.update(lineStats?.quality ?? null, lineStats?.quality?.metrics ?? null);
  const sectionFlow = sectionFlowFromSnapshot(getLineFlows?.(line.id)?.sectionFlow);
  const stationNames = line.stationIds.map((stationId) => network.stations.find(({ id }) => id === stationId)?.name ?? stationId);
  card.sectionFlowChart.update(sectionFlow, stationNames);
}

export function createSimulationPanels(container: HTMLElement, callbacks: PanelCallbacks): SimulationPanels {
  const root = element('aside', 'simulation-panels');
  root.setAttribute('aria-label', '營運概況面板');

  const city = makeSection('全市概況');
  const cityFacts = element('dl', 'panel-values');
  const cityRidership = makeValueRow('每日運量');
  const cityShare = makeValueRow('捷運＋BRT 佔有率');
  const cityProfit = makeValueRow('盈虧率');
  cityFacts.append(cityRidership.row, cityShare.row, cityProfit.row);
  const cityQualityPanel = createQualityPanel();
  city.content.append(cityFacts, cityQualityPanel.element);

  const station = makeSection('車站營運概況');
  const stationPlaceholder = element('p', 'panel-placeholder', '選取車站後查看營運概況。');
  const stationDetails = element('div', 'station-details');
  const stationName = element('h3', 'station-panel-name');
  const stationFacts = element('dl', 'panel-values');
  const entries = makeValueRow('每日進站');
  const exits = makeValueRow('每日出站');
  const waiting = makeValueRow('尖峰月台等候最高');
  const denied = makeValueRow('擠不上車人次');
  const transfers = makeValueRow('轉乘人次');
  const servedLines = makeValueRow('所屬路線');
  stationFacts.append(entries.row, exits.row, waiting.row, denied.row, transfers.row, servedLines.row);
  const sparklineHeading = element('p', 'sparkline-title', '近 7 遊戲日進出量');
  const sparkline = element('div', 'station-sparkline');
  sparkline.setAttribute('role', 'img');
  sparkline.setAttribute('aria-label', '近 7 遊戲日進出量小走勢（模擬值）');
  const renameForm = element('form', 'station-rename-form');
  const renameInput = element('input', 'station-rename-input');
  renameInput.type = 'text';
  renameInput.maxLength = MAX_NAME_LENGTH;
  renameInput.required = true;
  renameInput.setAttribute('aria-label', '車站名稱');
  const renameButton = element('button', 'source-button', '更名');
  renameButton.type = 'submit';
  renameForm.append(renameInput, renameButton);
  renameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const stationId = renameForm.dataset.stationId;
    if (stationId && renameInput.value.trim()) callbacks.renameStation(stationId, renameInput.value);
  });
  stationDetails.append(stationName, stationFacts, sparklineHeading, sparkline, renameForm);
  const followPassengerButton = element('button', 'source-button', '跟隨代表旅客');
  followPassengerButton.type = 'button';
  followPassengerButton.addEventListener('click', () => {
    const stationId = renameForm.dataset.stationId;
    if (stationId) callbacks.followPassenger(stationId);
  });
  stationDetails.append(followPassengerButton);
  station.content.append(stationPlaceholder, stationDetails);

  const routes = makeSection('路線卡');
  const lineCardsContainer = element('div', 'line-cards');
  routes.content.append(lineCardsContainer);
  const follow = makeSection('跟隨列車／旅客');
  const followDetails = element('p', 'panel-placeholder');
  const passengerDetails = element('div', 'passenger-follow-details');
  const followActions = element('div', 'passenger-follow-actions');
  const replayPassengerButton = element('button', 'source-button', '重播');
  replayPassengerButton.type = 'button';
  replayPassengerButton.addEventListener('click', callbacks.replayPassenger);
  const closePassengerFollowButton = element('button', 'source-button', '關閉');
  closePassengerFollowButton.type = 'button';
  closePassengerFollowButton.addEventListener('click', callbacks.closePassengerFollow);
  followActions.append(replayPassengerButton, closePassengerFollowButton);
  follow.content.append(followDetails, passengerDetails, followActions);
  follow.section.hidden = true;
  root.append(city.section, station.section, routes.section, follow.section);
  container.append(root);

  const lineCards = new Map<string, LineCard>();
  const update = (
    network: Network,
    snapshot: TransitWireSummary | undefined,
    selectedStationId?: string,
    getLineFlows?: (lineId: string) => LineFlowsData | undefined,
  ): void => {
    const cityStats = snapshot?.city;
    cityRidership.value.textContent = `${formatPanelCount(cityStats?.dailyRidership ?? 0)} 人`;
    cityShare.value.textContent = formatPanelPercent(cityStats?.transitShare ?? 0);
    cityProfit.value.textContent = formatPanelPercent(cityStats?.profitLossRatio ?? 0);
    cityQualityPanel.update(cityStats?.quality ?? null, cityStats?.quality?.metrics ?? null);

    const selectedStation = selectedStationId
      ? network.stations.find((candidate) => candidate.id === selectedStationId)
      : undefined;
    stationPlaceholder.hidden = Boolean(selectedStation);
    stationDetails.hidden = !selectedStation;
    if (selectedStation) {
      const stats = snapshot?.stations.find((candidate) => candidate.stationId === selectedStation.id);
      stationName.textContent = selectedStation.name;
      if (document.activeElement !== renameInput) renameInput.value = selectedStation.name;
      renameForm.dataset.stationId = selectedStation.id;
      entries.value.textContent = `${formatPanelCount(stats?.entries ?? 0)} 人`;
      exits.value.textContent = `${formatPanelCount(stats?.exits ?? 0)} 人`;
      waiting.value.textContent = `${formatPanelCount(stats?.peakPlatformWaiting ?? 0)} 人`;
      denied.value.textContent = `${formatPanelCount(stats?.deniedBoardings ?? 0)} 人次`;
      transfers.value.textContent = `${formatPanelCount(stats?.transfers ?? 0)} 人次`;
      const stationLineIds = stats?.lineIds ?? network.lines
        .filter((line) => line.stationIds.includes(selectedStation.id))
        .map((line) => line.id);
      const stationLineNames = network.lines
        .filter((line) => stationLineIds.includes(line.id))
        .map((line) => line.name);
      servedLines.value.textContent = stationLineNames.length ? stationLineNames.join('、') : '無';
      const values = stats?.last7DaysEntriesExits ?? [];
      const lastSeven = [...Array(Math.max(0, 7 - values.length)).fill(0), ...values].slice(-7);
      const maxValue = Math.max(1, ...lastSeven);
      sparkline.replaceChildren(...lastSeven.map((value, index) => {
        const bar = element('span', 'station-sparkline-bar');
        const dayNumber = index + 1;
        bar.style.height = `${Math.max(3, Math.round((value / maxValue) * 32))}px`;
        bar.title = `第 ${dayNumber} 日：${formatPanelCount(value)} 人次`;
        return bar;
      }));
    }

    const currentLineIds = new Set(network.lines.map(({ id }) => id));
    for (const [lineId, card] of lineCards) {
      if (!currentLineIds.has(lineId)) {
        card.element.remove();
        lineCards.delete(lineId);
      }
    }
    for (const line of network.lines) {
      let card = lineCards.get(line.id);
      if (!card) {
        card = makeLineCard(line, callbacks);
        lineCards.set(line.id, card);
        lineCardsContainer.append(card.element);
      }
      updateLineCard(card, line, network, snapshot, getLineFlows);
    }
    routes.section.hidden = network.lines.length === 0;
  };

  const updateFollowInfo = (
    info: FollowTrainInfo | undefined,
    passenger?: RepresentativePassenger,
    stationNames: PassengerStationNames = new Map(),
    lineNames: PassengerLineNames = new Map(),
    tripEnded = false,
  ): void => {
    follow.section.hidden = !info && !passenger;
    followDetails.hidden = !info && !(passenger && tripEnded);
    replayPassengerButton.hidden = !passenger || !tripEnded;
    closePassengerFollowButton.hidden = !info && !passenger;
    passengerDetails.replaceChildren();
    if (passenger) {
      passengerDetails.append(createPassengerView(
        document,
        buildPassengerViewModel(passenger, stationNames, lineNames),
      ));
    }
    if (!info) {
      followDetails.textContent = passenger && tripEnded ? '行程已結束' : '';
      return;
    }
    const loadFactor = info.loadFactor !== undefined && Number.isFinite(info.loadFactor)
      ? formatPanelPercent(info.loadFactor)
      : '—';
    followDetails.textContent = `線名：${info.lineName}　方向：${info.direction}　下一站：${info.nextStationName}　估計負載率：${loadFactor}（模擬值）`;
  };

  return { element: root, update, updateFollowInfo };
}
