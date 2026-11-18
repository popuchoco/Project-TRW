import { DENSITY_PALETTE } from '../map/village-density';
import type { EditorTool } from '../city/controller';
import { TRANSIT_MODES } from '../city/modes';

function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createUi(mount: HTMLElement): {
  infoCard: HTMLElement;
  infoText: HTMLElement;
  status: HTMLElement;
  fpsSelect: HTMLSelectElement;
  simPauseButton: HTMLButtonElement;
  simSpeedSelect: HTMLSelectElement;
  enterMetroButton: HTMLButtonElement;
  returnIslandButton: HTMLButtonElement;
  extendRegionButton: HTMLButtonElement;
  editorToolbar: HTMLElement;
  editorToolButtons: Map<EditorTool, HTMLButtonElement>;
  lineModeSelect: HTMLSelectElement;
  deleteStationButton: HTMLButtonElement;
  deleteLineButton: HTMLButtonElement;
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  editorSelection: HTMLElement;
  spacingHint: HTMLElement;
  densityLegend: HTMLElement;
  updateBanner: HTMLElement;
  updateButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
} {
  const toolbar = makeElement('section', 'map-toolbar');
  const product = makeElement('div', 'map-brand');
  product.append(makeElement('strong', 'map-title', 'Project-TRW'), makeElement('span', 'map-subtitle', '全島行政區地圖'));

  const settings = makeElement('label', 'fps-setting');
  settings.append(makeElement('span', '', 'FPS'));
  const fpsSelect = makeElement('select', 'fps-select');
  fpsSelect.setAttribute('aria-label', 'FPS 上限');
  for (const [value, label] of [['auto', '自動'], ['30', '30'], ['60', '60']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    fpsSelect.append(option);
  }
  settings.append(fpsSelect);

  const simPauseButton = makeElement('button', 'source-button', '暫停模擬');
  simPauseButton.type = 'button';
  simPauseButton.dataset.action = 'toggle-simulation';
  const simSpeedSetting = makeElement('label', 'fps-setting');
  simSpeedSetting.append(makeElement('span', '', '模擬速度'));
  const simSpeedSelect = makeElement('select', 'sim-speed-select');
  simSpeedSelect.setAttribute('aria-label', '模擬速度');
  for (const [value, label] of [[1, '1×'], [2, '2×'], [4, '4×']] as const) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = label;
    simSpeedSelect.append(option);
  }
  simSpeedSetting.append(simSpeedSelect);

  const sources = makeElement('button', 'source-button', '資料來源');
  sources.type = 'button';
  const sourceDialog = makeElement('dialog', 'source-dialog');
  sourceDialog.setAttribute('aria-labelledby', 'source-dialog-title');
  const sourceHeading = makeElement('h2', '', '資料來源');
  sourceHeading.id = 'source-dialog-title';
  const sourceDetails = makeElement('p', '', '提供機關：內政部國土測繪中心\n資料名稱：鄉鎮市區界線(TWD97經緯度)，版本 1140318\n來源：https://data.gov.tw/dataset/7441\n\n提供機關：內政部國土測繪中心\n資料名稱：村里界圖(TWD97經緯度)，版本 1150817\n來源：https://data.gov.tw/dataset/7438\n\n提供機關：內政部戶政司\n資料名稱：村里戶數、單一年齡人口（新增區域代碼），版本 11510\n來源：https://data.gov.tw/dataset/77132\n\n授權：政府資料開放授權條款第1版 https://data.gov.tw/license\n本專案已對原始資料進行簡化、拆分與格式轉換。');
  const closeSources = makeElement('button', 'source-button', '關閉');
  closeSources.type = 'button';
  sources.addEventListener('click', () => sourceDialog.showModal());
  closeSources.addEventListener('click', () => sourceDialog.close());
  sourceDialog.append(sourceHeading, sourceDetails, closeSources);

  const exportButton = makeElement('button', 'source-button', '匯出存檔');
  exportButton.type = 'button';
  exportButton.dataset.action = 'export-save';
  const importButton = makeElement('button', 'source-button', '匯入存檔');
  importButton.type = 'button';
  importButton.dataset.action = 'import-save';
  const fileInput = makeElement('input', 'save-file-input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.setAttribute('aria-label', '選擇存檔 JSON 檔');
  toolbar.append(product, settings, simPauseButton, simSpeedSetting, sources, exportButton, importButton, fileInput);

  const enterMetroButton = makeElement('button', 'source-button', '北北都會');
  enterMetroButton.type = 'button';
  enterMetroButton.dataset.action = 'enter-metro-view';
  const returnIslandButton = makeElement('button', 'source-button', '返回全島');
  returnIslandButton.type = 'button';
  returnIslandButton.dataset.action = 'return-island-view';
  returnIslandButton.hidden = true;
  const extendRegionButton = makeElement('button', 'source-button', '延伸到桃園');
  extendRegionButton.type = 'button';
  extendRegionButton.dataset.action = 'extend-region';
  toolbar.insertBefore(enterMetroButton, sources);
  toolbar.insertBefore(returnIslandButton, sources);
  toolbar.insertBefore(extendRegionButton, sources);

  const editorToolbar = makeElement('section', 'network-editor-toolbar');
  editorToolbar.hidden = true;
  editorToolbar.setAttribute('aria-label', '路網編輯工具');
  const editorToolButtons = new Map<EditorTool, HTMLButtonElement>();
  for (const [tool, label] of [
    ['select', '選取／移站'],
    ['place', '放站'],
    ['line', '拉線／延伸'],
    ['insert', '插站'],
  ] as const) {
    const button = makeElement('button', 'source-button editor-tool-button', label);
    button.type = 'button';
    button.dataset.editorTool = tool;
    button.setAttribute('aria-pressed', String(tool === 'select'));
    editorToolButtons.set(tool, button);
    editorToolbar.append(button);
  }
  const lineModeSetting = makeElement('label', 'fps-setting editor-line-mode');
  lineModeSetting.append(makeElement('span', '', '新線運具'));
  const lineModeSelect = makeElement('select', 'sim-speed-select');
  lineModeSelect.setAttribute('aria-label', '新線運具');
  for (const [value, label] of [['brt', TRANSIT_MODES.brt.name], ['metro', TRANSIT_MODES.metro.name]] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lineModeSelect.append(option);
  }
  lineModeSetting.append(lineModeSelect);
  const deleteStationButton = makeElement('button', 'source-button', '刪除選取站');
  deleteStationButton.type = 'button';
  deleteStationButton.disabled = true;
  const deleteLineButton = makeElement('button', 'source-button', '刪除選取線');
  deleteLineButton.type = 'button';
  deleteLineButton.disabled = true;
  const undoButton = makeElement('button', 'source-button', '復原');
  undoButton.type = 'button';
  undoButton.disabled = true;
  const redoButton = makeElement('button', 'source-button', '重做');
  redoButton.type = 'button';
  redoButton.disabled = true;
  const editorSelection = makeElement('span', 'editor-selection', '尚未選取路網項目');
  const spacingHint = makeElement('div', 'spacing-hint');
  spacingHint.hidden = true;
  spacingHint.setAttribute('role', 'status');
  editorToolbar.append(
    lineModeSetting,
    deleteStationButton,
    deleteLineButton,
    undoButton,
    redoButton,
    editorSelection,
    spacingHint,
  );

  const status = makeElement('div', 'map-status', '載入地圖資料中…');
  status.setAttribute('role', 'status');
  const updateBanner = makeElement('section', 'update-banner');
  updateBanner.hidden = true;
  updateBanner.setAttribute('role', 'status');
  updateBanner.append(makeElement('span', '', '有新版本，重新載入以更新'));
  const updateButton = makeElement('button', 'source-button', '重新載入');
  updateButton.type = 'button';
  updateBanner.append(updateButton);
  const infoCard = makeElement('section', 'town-info');
  infoCard.hidden = true;
  infoCard.setAttribute('aria-live', 'polite');
  const infoText = makeElement('strong', 'town-info-text');
  infoCard.append(infoText);

  const densityLegend = makeElement('section', 'density-legend');
  densityLegend.hidden = true;
  densityLegend.setAttribute('aria-label', '村里人口密度圖例');

  mount.append(toolbar, editorToolbar, status, updateBanner, sourceDialog, infoCard, densityLegend);
  return {
    infoCard,
    infoText,
    status,
    fpsSelect,
    simPauseButton,
    simSpeedSelect,
    enterMetroButton,
    returnIslandButton,
    extendRegionButton,
    editorToolbar,
    editorToolButtons,
    lineModeSelect,
    deleteStationButton,
    deleteLineButton,
    undoButton,
    redoButton,
    editorSelection,
    spacingHint,
    densityLegend,
    updateBanner,
    updateButton,
    fileInput,
  };
}

export function renderDensityLegend(container: HTMLElement, breaks: readonly number[]): void {
  const heading = makeElement('strong', 'density-legend-title', '人口密度（人/km²）');
  const list = makeElement('div', 'density-legend-list');
  const format = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
  for (let classIndex = 0; classIndex < DENSITY_PALETTE.length; classIndex += 1) {
    const first = classIndex === 0 ? undefined : breaks[classIndex - 1];
    const last = classIndex < breaks.length ? breaks[classIndex] : undefined;
    const label = first === undefined
      ? `≤ ${format.format(Math.round(last ?? 0))}`
      : last === undefined
        ? `> ${format.format(Math.round(first))}`
        : `${format.format(Math.round(first))}–${format.format(Math.round(last))}`;
    const row = makeElement('div', 'density-legend-item');
    const swatch = makeElement('span', 'density-legend-swatch');
    swatch.style.backgroundColor = `#${DENSITY_PALETTE[classIndex]!.toString(16).padStart(6, '0')}`;
    row.append(swatch, makeElement('span', '', label));
    list.append(row);
  }
  const unmatched = makeElement('div', 'density-legend-item');
  const unmatchedSwatch = makeElement('span', 'density-legend-swatch density-legend-unmatched');
  unmatched.append(unmatchedSwatch, makeElement('span', '', '未編定村里'));
  list.append(unmatched);
  container.replaceChildren(heading, list);
}

export type AppUi = ReturnType<typeof createUi>;
