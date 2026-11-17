/** Shared visual colours for the map renderer. */
export const RENDER_PALETTE = {
  lineCasing: 0xf7f7f3,
  stationOuter: 0xffffff,
  stationFill: 0x215c72,
  stationSelected: 0xd57435,
  transferRing: 0xb98236,
  countyLabel: 0x48535a,
  stationLabel: 0x26363d,
  labelHalo: 0xf7f7f3,
} as const;

// 可調：捷運較粗且有淺色外框；BRT 細線搭配分段虛線外框。
export const LINE_STYLES = {
  metro: { width: 5, selectedWidth: 6.2, casingWidth: 8 },
  brt: {
    width: 2.8,
    selectedWidth: 3.8,
    casingWidth: 5.2,
    casingDashLength: 0.006,
    casingGapLength: 0.004,
  },
} as const;

// 可調：站點圓點和轉乘環的像素尺寸。
export const STATION_MARKERS = {
  radius: 7,
  selectedRadius: 9,
  coreRadius: 4.8,
  selectedCoreRadius: 6.2,
  transferRingRadius: 10.3,
  transferRingWidth: 1.2,
} as const;

// 可調：地名和站名文字尺寸，以及文字描邊寬度。
export const LABEL_FONT_SIZES = {
  county: 12,
  station: 11,
  haloWidth: 3,
} as const;
