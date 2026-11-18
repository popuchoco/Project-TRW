import type { QualityRawStats, QualityScore } from '../sim/transit/quality';

export interface QualityViewRow {
  label: string;
  value0to100: number;
  barPercent: number;
  valueText: string;
  detailText: string;
}

export interface QualityViewModel {
  totalText: string;
  rows: QualityViewRow[];
  badge: '模擬值';
}

export interface QualityPanelRenderer {
  element: HTMLElement;
  update(score: QualityScore | null, rawStats?: QualityRawStats | null): void;
}

function oneDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

function loadPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const percent = value * 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

function scoreRow(label: string, value: number, detailText: string): QualityViewRow {
  return {
    label,
    value0to100: value,
    barPercent: Math.max(0, Math.min(100, value)),
    valueText: `${Math.round(value)} 分`,
    detailText,
  };
}

export function qualityViewModel(
  score: QualityScore | null,
  rawStats: QualityRawStats | null = score?.metrics ?? null,
): QualityViewModel {
  if (!score) return { totalText: '—', rows: [], badge: '模擬值' };

  const metrics = rawStats;
  return {
    totalText: `${oneDecimal(score.total)} 分`,
    badge: '模擬值',
    rows: [
      scoreRow('候車', score.wait, `候車：平均 ${metrics ? oneDecimal(metrics.averageWaitMinutes) : '—'} 分鐘`),
      scoreRow('轉乘', score.transfer, `轉乘：每趟 ${metrics ? oneDecimal(metrics.averageTransfers) : '—'} 次`),
      scoreRow('擁擠', score.crowding, `擁擠：平均負載 ${metrics ? loadPercent(metrics.averageLoadFactor) : '—'}`),
      scoreRow('擠不上車', score.denied, `擠不上車：${metrics ? oneDecimal(metrics.deniedRatio * 100) : '—'}%`),
    ],
  };
}

function textElement(documentRef: Document, tag: string, className: string, text: string): HTMLElement {
  const result = documentRef.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

export function createQualityPanel(documentRef: Document = document): QualityPanelRenderer {
  const panel = documentRef.createElement('section');
  panel.className = 'quality-panel';
  const header = documentRef.createElement('div');
  header.className = 'quality-panel-header';
  header.append(
    textElement(documentRef, 'h3', 'quality-panel-title', '品質分'),
    textElement(documentRef, 'span', 'simulation-value-label', '模擬值'),
  );
  const totalRow = documentRef.createElement('div');
  totalRow.className = 'quality-total-row';
  totalRow.append(
    textElement(documentRef, 'span', 'quality-total-label', '總分'),
    textElement(documentRef, 'strong', 'quality-total-value', '—'),
  );
  const total = totalRow.lastElementChild as HTMLElement;
  const rows = documentRef.createElement('div');
  rows.className = 'quality-rows';
  panel.append(header, totalRow, rows);

  return {
    element: panel,
    update(score, rawStats) {
      const model = qualityViewModel(score, rawStats ?? score?.metrics ?? null);
      total.textContent = model.totalText;
      rows.replaceChildren(...model.rows.map((rowModel) => {
        const row = documentRef.createElement('div');
        row.className = 'quality-row';
        const rowHeading = documentRef.createElement('div');
        rowHeading.className = 'quality-row-heading';
        rowHeading.append(
          textElement(documentRef, 'span', 'quality-row-label', rowModel.label),
          textElement(documentRef, 'span', 'quality-row-value', rowModel.valueText),
        );
        const track = documentRef.createElement('div');
        track.className = 'quality-bar-track';
        track.setAttribute('role', 'img');
        track.setAttribute('aria-label', `${rowModel.label}品質分 ${rowModel.valueText}`);
        const bar = documentRef.createElement('span');
        bar.className = 'quality-bar';
        bar.style.width = `${rowModel.barPercent}%`;
        track.append(bar);
        const detail = textElement(documentRef, 'p', 'quality-detail', rowModel.detailText);
        row.append(rowHeading, track, detail);
        return row;
      }));
    },
  };
}
