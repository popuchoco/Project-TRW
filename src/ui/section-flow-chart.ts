import { SIMULATION_BALANCE, type SimulationPeriodId } from '../city/modes';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export const SECTION_FLOW_THRESHOLDS = {
  light: 0.6,
  busy: 0.8,
  capacity: 1.0,
} as const;

export const SECTION_FLOW_COLORS = {
  light: '#67a88b',
  busy: '#d3a33d',
  nearCapacity: '#d47b3f',
  overCapacity: '#c84e52',
} as const;

// 可調：縮寫長度、負載圖表尺度與 SVG 邊界留白。
export const SECTION_FLOW_CHART_TUNING = {
  abbreviationLength: 2,
  maximumVisualLoadFactor: 1.2,
  leftMargin: 30,
  rightMargin: 8,
  topMargin: 25,
  bottomMargin: 20,
  directionGap: 7,
  barWidthRatio: 0.62,
} as const;

export type SectionFlowDirectionId = 1 | -1;
export type SectionFlowColorBand = keyof typeof SECTION_FLOW_COLORS;

export interface SectionFlowSegment {
  loadFactor: number;
}

export interface SectionFlowDirection {
  direction: SectionFlowDirectionId;
  segments: readonly SectionFlowSegment[];
}

export type SectionFlowByPeriod = Readonly<Record<SimulationPeriodId, readonly SectionFlowDirection[]>>;

export interface SectionFlowChartSize {
  width: number;
  height: number;
}

export interface SectionFlowChartBar {
  x: number;
  y: number;
  w: number;
  h: number;
  colorBand: SectionFlowColorBand;
  dir: SectionFlowDirectionId;
  segmentIndex: number;
}

export interface SectionFlowMaxSegment {
  dir: SectionFlowDirectionId;
  segmentIndex: number;
  loadFactor: number;
}

export interface SectionFlowChartModel {
  bars: SectionFlowChartBar[];
  labels: string[];
  maxSegment: SectionFlowMaxSegment | null;
}

export interface SectionFlowChartRenderer {
  element: HTMLElement;
  update(flow: SectionFlowByPeriod | undefined, stationNames: readonly string[]): void;
}

function loadColorBand(loadFactor: number): SectionFlowColorBand {
  if (loadFactor < SECTION_FLOW_THRESHOLDS.light) return 'light';
  if (loadFactor < SECTION_FLOW_THRESHOLDS.busy) return 'busy';
  if (loadFactor <= SECTION_FLOW_THRESHOLDS.capacity) return 'nearCapacity';
  return 'overCapacity';
}

function abbreviation(stationName: string): string {
  return stationName.slice(0, SECTION_FLOW_CHART_TUNING.abbreviationLength);
}

export function buildSectionFlowChart(
  flow: SectionFlowByPeriod,
  stationNames: readonly string[],
  periodId: SimulationPeriodId,
  size: SectionFlowChartSize,
): SectionFlowChartModel {
  const segmentCount = Math.max(0, stationNames.length - 1);
  const labels = stationNames.map(abbreviation);
  const plotWidth = Math.max(0, size.width - SECTION_FLOW_CHART_TUNING.leftMargin - SECTION_FLOW_CHART_TUNING.rightMargin);
  const plotHeight = Math.max(0, size.height - SECTION_FLOW_CHART_TUNING.topMargin - SECTION_FLOW_CHART_TUNING.bottomMargin);
  const directionHeight = Math.max(0, (plotHeight - SECTION_FLOW_CHART_TUNING.directionGap) / 2);
  const columnWidth = segmentCount > 0 ? plotWidth / segmentCount : 0;
  const barWidth = columnWidth * SECTION_FLOW_CHART_TUNING.barWidthRatio;
  const maximumVisualLoadFactor = SECTION_FLOW_CHART_TUNING.maximumVisualLoadFactor;
  const directions = flow[periodId];
  const bars: SectionFlowChartBar[] = [];
  let maxSegment: SectionFlowMaxSegment | null = null;

  for (const [directionRow, dir] of ([1, -1] as const).entries()) {
    const directionFlow = directions.find((candidate) => candidate.direction === dir);
    const rowY = SECTION_FLOW_CHART_TUNING.topMargin
      + directionRow * (directionHeight + SECTION_FLOW_CHART_TUNING.directionGap);
    const baselineY = rowY + directionHeight;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const rawLoadFactor = directionFlow?.segments[segmentIndex]?.loadFactor ?? 0;
      const loadFactor = Number.isFinite(rawLoadFactor) ? Math.max(0, rawLoadFactor) : 0;
      const barHeight = directionHeight * Math.min(1, loadFactor / maximumVisualLoadFactor);
      bars.push({
        x: SECTION_FLOW_CHART_TUNING.leftMargin + (segmentIndex + 0.5) * columnWidth - barWidth / 2,
        y: baselineY - barHeight,
        w: barWidth,
        h: barHeight,
        colorBand: loadColorBand(loadFactor),
        dir,
        segmentIndex,
      });

      if (!maxSegment || loadFactor > maxSegment.loadFactor
        || (loadFactor === maxSegment.loadFactor && segmentIndex < maxSegment.segmentIndex)) {
        maxSegment = { dir, segmentIndex, loadFactor };
      }
    }
  }

  return { bars, labels, maxSegment };
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  documentRef: Document,
  tag: K,
  className: string,
  text?: string,
): SVGElementTagNameMap[K] {
  const result = documentRef.createElementNS(SVG_NAMESPACE, tag);
  result.setAttribute('class', className);
  if (text !== undefined) result.textContent = text;
  return result;
}

export function renderSectionFlowChartSvg(
  documentRef: Document,
  model: SectionFlowChartModel,
  size: SectionFlowChartSize,
): SVGSVGElement {
  const svg = documentRef.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'section-flow-svg');
  svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '各站區間雙向負載率圖（模擬值）');

  const segmentCount = model.labels.length > 0 ? model.labels.length - 1 : 0;
  const plotWidth = Math.max(0, size.width - SECTION_FLOW_CHART_TUNING.leftMargin - SECTION_FLOW_CHART_TUNING.rightMargin);
  const plotHeight = Math.max(0, size.height - SECTION_FLOW_CHART_TUNING.topMargin - SECTION_FLOW_CHART_TUNING.bottomMargin);
  const directionHeight = Math.max(0, (plotHeight - SECTION_FLOW_CHART_TUNING.directionGap) / 2);

  for (const [directionRow, dir] of ([1, -1] as const).entries()) {
    const rowY = SECTION_FLOW_CHART_TUNING.topMargin
      + directionRow * (directionHeight + SECTION_FLOW_CHART_TUNING.directionGap);
    const baseline = rowY + directionHeight;
    const directionLabel = svgElement(documentRef, 'text', 'section-flow-direction', dir === 1 ? '往' : '返');
    directionLabel.setAttribute('x', '2');
    directionLabel.setAttribute('y', String(rowY + 10));
    svg.append(directionLabel);
    const line = svgElement(documentRef, 'line', 'section-flow-baseline');
    line.setAttribute('x1', String(SECTION_FLOW_CHART_TUNING.leftMargin));
    line.setAttribute('x2', String(SECTION_FLOW_CHART_TUNING.leftMargin + plotWidth));
    line.setAttribute('y1', String(baseline));
    line.setAttribute('y2', String(baseline));
    svg.append(line);
  }

  for (const bar of model.bars) {
    const rect = svgElement(documentRef, 'rect', `section-flow-bar section-flow-bar-${bar.colorBand}`);
    rect.setAttribute('x', String(bar.x));
    rect.setAttribute('y', String(bar.y));
    rect.setAttribute('width', String(bar.w));
    rect.setAttribute('height', String(bar.h));
    rect.setAttribute('rx', '1.5');
    rect.setAttribute('data-direction', String(bar.dir));
    rect.setAttribute('data-segment-index', String(bar.segmentIndex));
    const title = svgElement(documentRef, 'title', '', `${bar.dir === 1 ? '往' : '返'}向第 ${bar.segmentIndex + 1} 區間`);
    rect.append(title);
    svg.append(rect);
  }

  for (const [index, label] of model.labels.entries()) {
    const x = segmentCount > 0
      ? SECTION_FLOW_CHART_TUNING.leftMargin + (index / segmentCount) * plotWidth
      : SECTION_FLOW_CHART_TUNING.leftMargin;
    const stationLabel = svgElement(documentRef, 'text', 'section-flow-station-label', label);
    stationLabel.setAttribute('x', String(x));
    stationLabel.setAttribute('y', String(size.height - 3));
    stationLabel.setAttribute('text-anchor', index === 0 ? 'start' : index === segmentCount ? 'end' : 'middle');
    svg.append(stationLabel);
  }

  return svg;
}

function maxSegmentText(maxSegment: SectionFlowMaxSegment | null, stationNames: readonly string[]): string {
  if (!maxSegment) return '最高負載區間：—';
  const start = stationNames[maxSegment.segmentIndex] ?? `第 ${maxSegment.segmentIndex + 1} 站`;
  const end = stationNames[maxSegment.segmentIndex + 1] ?? `第 ${maxSegment.segmentIndex + 2} 站`;
  return `最高負載區間：${start}－${end}（${maxSegment.dir === 1 ? '往' : '返'}向，${(maxSegment.loadFactor * 100).toFixed(1)}%）`;
}

export function createSectionFlowChart(documentRef: Document = document): SectionFlowChartRenderer {
  const root = documentRef.createElement('section');
  root.className = 'section-flow-chart';
  const header = documentRef.createElement('div');
  header.className = 'section-flow-chart-header';
  const title = documentRef.createElement('h4');
  title.className = 'section-flow-chart-title';
  title.textContent = '斷面流量';
  const badge = documentRef.createElement('span');
  badge.className = 'simulation-value-label';
  badge.textContent = '模擬值';
  header.append(title, badge);

  const periodSelect = documentRef.createElement('select');
  periodSelect.className = 'section-flow-period-select';
  periodSelect.setAttribute('aria-label', '斷面流量時段');
  for (const period of SIMULATION_BALANCE.periods) {
    const option = documentRef.createElement('option');
    option.value = period.id;
    option.textContent = period.name;
    periodSelect.append(option);
  }

  const maximum = documentRef.createElement('p');
  maximum.className = 'section-flow-maximum';
  const emptyState = documentRef.createElement('p');
  emptyState.className = 'section-flow-empty';
  emptyState.textContent = '目前沒有斷面流量資料。';
  const graphic = documentRef.createElement('div');
  graphic.className = 'section-flow-graphic';
  const legend = documentRef.createElement('div');
  legend.className = 'section-flow-legend';
  const legendItems: Array<[SectionFlowColorBand, string]> = [
    ['light', '< 0.6'],
    ['busy', '0.6–0.8'],
    ['nearCapacity', '0.8–1.0'],
    ['overCapacity', '> 1.0'],
  ];
  for (const [band, label] of legendItems) {
    const item = documentRef.createElement('span');
    item.className = 'section-flow-legend-item';
    const swatch = documentRef.createElement('span');
    swatch.className = `section-flow-swatch section-flow-bar-${band}`;
    swatch.setAttribute('aria-hidden', 'true');
    const text = documentRef.createElement('span');
    text.textContent = label;
    item.append(swatch, text);
    legend.append(item);
  }
  root.append(header, periodSelect, maximum, emptyState, graphic, legend);

  let currentFlow: SectionFlowByPeriod | undefined;
  let currentStationNames: readonly string[] = [];
  const size = { width: 306, height: 142 };
  const render = (): void => {
    if (!currentFlow) {
      maximum.textContent = '最高負載區間：—';
      emptyState.hidden = false;
      graphic.replaceChildren();
      return;
    }
    const model = buildSectionFlowChart(currentFlow, currentStationNames, periodSelect.value as SimulationPeriodId, size);
    maximum.textContent = maxSegmentText(model.maxSegment, currentStationNames);
    emptyState.hidden = true;
    graphic.replaceChildren(renderSectionFlowChartSvg(documentRef, model, size));
  };
  periodSelect.addEventListener('change', render);

  return {
    element: root,
    update(flow, stationNames) {
      currentFlow = flow;
      currentStationNames = stationNames;
      render();
    },
  };
}
