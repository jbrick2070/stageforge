import type { PlanPoint, RigConfig, TrussPodConfig } from '../types/show';
import type { CatalogBodyFamily } from './equipmentCatalog';
import { bodyFamilyFor, symbolForHardware, type EquipmentSymbol } from './equipmentSymbols';
import type { NativeStage } from './showFile';
import { PAPERWORK_SIMULATED_MAP_NOTICE, type PaperworkUnitStatus, type ShowPaperwork } from './showPaperwork';
import { getPlatforms, podWorldPoint, trussCenterLine } from './stageDesign';
import { effectiveHangs, facing, hangAimHandle, planWalls, widthAxis } from './stagePlan';
import { resolveStudioGeometry } from './studioGeometry';

export type PlotPaperSize = 'a4' | 'letter';

export const STANDARD_PLOT_SCALES = [25, 50, 75, 100, 150, 200, 250] as const;
const OVERSIZE_PLOT_SCALES = [300, 400, 500, 750, 1000] as const;

export const PLOT_DISCLAIMER =
  'Design guidance: not for construction. Verify all dimensions, loads and power on site.';
export const PLOT_DENSE_NOTE =
  'Dense area: numbers only. See Patch Sheet (Sheet 2) for addresses.';
export const TITLE_BLOCK_STORAGE_KEY = 'stageforge.titleBlock';

export const PLOT_MARGIN_M = 0.5;
export const PLOT_LABEL_CLEARANCE_MM = 8;
export const PLOT_DENSE_THRESHOLD_MM = 4;

export interface PlotPaperGeometry {
  paper: PlotPaperSize;
  paperLabel: string;
  /** Full physical sheet size in mm (landscape). */
  paperW: number;
  paperH: number;
  /** Uniform page margin in mm (matches @page and printToPDF). */
  marginMm: number;
  /** Printable SVG outer box in mm (1 mm slack inside margins to avoid spill). */
  pageW: number;
  pageH: number;
  /** Plan viewport box inside outer SVG, in mm. */
  planX: number;
  planY: number;
  planW: number;
  planH: number;
  /** Top band height (upstage arrow + heading) and bottom band height (scale bar + multi-line notices), in mm. */
  topBandMm: number;
  bottomBandMm: number;
  /** Right sidebar (legend + title block) position and size, in mm. */
  sidebarX: number;
  sidebarW: number;
  legendY: number;
  legendH: number;
  titleBlockY: number;
  titleBlockH: number;
}

export const PLOT_PAPER_GEOMETRY: Readonly<Record<PlotPaperSize, PlotPaperGeometry>> = {
  a4: {
    paper: 'a4',
    paperLabel: 'A4',
    paperW: 297,
    paperH: 210,
    marginMm: 10,
    pageW: 276,
    pageH: 189,
    planX: 1,
    planY: 8,
    planW: 204,
    planH: 162,
    topBandMm: 7,
    bottomBandMm: 18,
    sidebarX: 209,
    sidebarW: 66,
    legendY: 1,
    legendH: 122,
    titleBlockY: 125,
    titleBlockH: 63,
  },
  letter: {
    paper: 'letter',
    paperLabel: 'Letter',
    paperW: 279.4,
    paperH: 215.9,
    marginMm: 10,
    pageW: 258,
    pageH: 194,
    planX: 1,
    planY: 8,
    planW: 186,
    planH: 167,
    topBandMm: 7,
    bottomBandMm: 18,
    sidebarX: 191,
    sidebarW: 66,
    legendY: 1,
    legendH: 127,
    titleBlockY: 130,
    titleBlockH: 63,
  },
};

export interface PlotTitleBlockState {
  paper: PlotPaperSize;
  venue: string;
  designer: string;
  revision: string;
  date: string;
}

export const DEFAULT_TITLE_BLOCK: Readonly<PlotTitleBlockState> = {
  paper: 'a4',
  venue: '',
  designer: '',
  revision: 'A',
  date: '',
};

const MAX_FIELD_LEN = 120;

// Strip C0/DEL, C1 controls, zero-width space/LRM/RLM, bidi overrides/isolates, and BOM (keep ZWNJ/ZWJ).
const UNSAFE_TEXT_RE = /[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function sanitizeField(value: unknown, maxChars = MAX_FIELD_LEN): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, maxChars).join('');
}

export function normalizeRevision(value: unknown): string {
  if (typeof value !== 'string') return 'A';
  const cleaned = value.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  return /^[A-Z]{1,2}$/.test(cleaned) ? cleaned : 'A';
}

export function parseTitleBlockState(raw: unknown): PlotTitleBlockState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_TITLE_BLOCK };
  const obj = raw as Record<string, unknown>;
  const get = (k: string) => (Object.hasOwn(obj, k) ? obj[k] : undefined);
  return {
    paper: get('paper') === 'letter' ? 'letter' : 'a4',
    venue: sanitizeField(get('venue')),
    designer: sanitizeField(get('designer')),
    revision: normalizeRevision(get('revision')),
    date: sanitizeField(get('date'), 32),
  };
}

export function loadTitleBlock(): PlotTitleBlockState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return { ...DEFAULT_TITLE_BLOCK };
    const stored = window.localStorage.getItem(TITLE_BLOCK_STORAGE_KEY);
    if (!stored || stored.length > 8192) return { ...DEFAULT_TITLE_BLOCK };
    return parseTitleBlockState(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_TITLE_BLOCK };
  }
}

export function saveTitleBlock(state: PlotTitleBlockState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const clean = parseTitleBlockState(state);
    window.localStorage.setItem(TITLE_BLOCK_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage errors (private mode, quota, disabled storage).
  }
}

/**
 * Cautious deterministic text width estimate in mm (Node-safe, no DOM font metrics required).
 * Accounts for wide Latin glyphs (M, W, m, w), bold weight, and full-width/non-Latin code points (> U+024F).
 */
export function estimateTextWidthMm(text: string, fontMm: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x024f) {
      // CJK, emoji, em-dash, full-width symbols, non-Latin scripts.
      em += 1.05;
    } else if ("il.,'|!:;()[]".includes(ch)) {
      em += 0.34;
    } else if ('MWmw@%&'.includes(ch)) {
      em += 0.92;
    } else if ((ch >= 'A' && ch <= 'Z') || ch !== ch.toLowerCase()) {
      em += 0.72;
    } else {
      em += 0.58;
    }
  }
  return em * fontMm * (bold ? 1.08 : 1.0);
}

/** Truncate text with a trailing ellipsis so its estimated width never exceeds `maxMm`. */
export function truncateToWidth(text: string, maxMm: number, fontMm: number, bold = false): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (estimateTextWidthMm(clean, fontMm, bold) <= maxMm) return clean;
  const ellipsis = '…';
  const ellipsisW = estimateTextWidthMm(ellipsis, fontMm, bold);
  if (ellipsisW >= maxMm) return ellipsis;
  // Slice by Unicode code points so surrogate pairs (emoji) are never split.
  const chars = Array.from(clean);
  let end = chars.length;
  while (
    end > 1 &&
    estimateTextWidthMm(chars.slice(0, end).join('').trimEnd(), fontMm, bold) + ellipsisW > maxMm
  ) {
    end--;
  }
  const prefix = chars.slice(0, end).join('').trimEnd();
  return prefix ? `${prefix}${ellipsis}` : ellipsis;
}

/** Word-wrap text into lines that each fit inside `maxMm` without dropping or truncating words. */
export function wrapTextToLines(text: string, maxMm: number, fontMm: number, bold = false): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || estimateTextWidthMm(candidate, fontMm, bold) <= maxMm) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlotDeck {
  id: string;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

export interface PlotTruss {
  id: string;
  name: string;
  shape: TrussPodConfig['shape'];
  baseY: number;
  /** Present for circle pods. */
  circle?: { cx: number; cz: number; r: number };
  /** World-space polyline points for box, chevron, and path trusses. */
  points: PlanPoint[];
  closed: boolean;
  labelPoint: PlanPoint;
}

export interface PlotWall {
  id: string;
  label: string;
  stock: boolean;
  /** Four world-space corner points of the wall plan bar. */
  quad: PlanPoint[];
  /** Midpoint and front-facing tick tip in world metres. */
  center: PlanPoint;
  frontTip: PlanPoint;
}

export interface PlotHang {
  index: number;
  label: string;
  count: number;
  authored: boolean;
  /** Four world-space corner points of the speaker array box. */
  quad: PlanPoint[];
  center: PlanPoint;
  aimTip: PlanPoint;
}

export interface PlotCaption {
  id: string;
  kind: 'truss' | 'wall' | 'hang';
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle';
  fontSize: number;
  box: RectMm;
}

export type PlotLabelMode = 'inside' | 'adjacent' | 'leader' | 'number-only';

export interface PlotFixtureLabel {
  mode: PlotLabelMode;
  /** Primary bold line: fixture number (`"12"`, or `"12!"` for conflict/overflow units). */
  primaryText: string;
  /** Secondary line: DMX address (`"U1.001"`), or null in number-only mode. */
  secondaryText: string | null;
  /** Label bounding box in outer SVG page mm. */
  box: RectMm;
  /** Text center X/Y in outer SVG page mm. */
  textX: number;
  textY: number;
  /** Leader line endpoints in outer SVG page mm when offset from symbol. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
  /** True when dense collisions forced the number onto the symbol itself with a white halo. */
  forcedInside: boolean;
}

export interface PlotFixture {
  fixtureNumber: number;
  unitNumber: number;
  mountOrder: number;
  positionId: string;
  positionName: string;
  floor: boolean;
  dmxLabel: string;
  status: PaperworkUnitStatus;
  /** World metres (from `ShowPaperwork` unit; never recomputed). */
  x: number;
  y: number;
  z: number;
  /** Radians about +Y (from `ShowPaperwork` unit). */
  yaw: number;
  /** Symbol centre in outer SVG page mm. */
  pageX: number;
  pageY: number;
  /** Approximate symbol bounding box in outer SVG page mm. */
  symbolBox: RectMm;
  family: CatalogBodyFamily;
  symbol: EquipmentSymbol;
  dense: boolean;
  label: PlotFixtureLabel;
}

export interface PlotLegendRow {
  key: string;
  family: CatalogBodyFamily;
  symbol: EquipmentSymbol;
  manufacturer: string;
  modelName: string;
  displayName: string;
  count: number;
  wattsEach: number;
  wattsEstimated: boolean;
}

export interface PlotScaleBarTick {
  metres: number;
  widthMm: number;
  label: string;
}

export interface PlotTitleBlockResolved {
  rigName: string;
  rigNameFull: string;
  venue: string;
  designer: string;
  revision: string;
  date: string;
  scaleLabel: string;
  sheetLabel: string;
  disclaimer: string;
}

export interface BuildPlotPlanOptions {
  paper?: PlotPaperSize;
  titleBlock?: Partial<PlotTitleBlockState>;
  /** Local YYYY-MM-DD date string supplied by the caller so the builder stays pure. */
  generatedDate?: string;
  sheetNumber?: number;
  totalSheets?: number;
}

export interface PlotPlanModel {
  paper: PlotPaperSize;
  geometry: PlotPaperGeometry;
  scale: number;
  oversize: boolean;
  oversizeNote: string | null;
  rigBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    width: number;
    depth: number;
  };
  /** Inner plan `<svg>` viewBox in world metres (`width = planW * scale / 1000`, `height = planH * scale / 1000`). */
  viewBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  decks: PlotDeck[];
  trusses: PlotTruss[];
  walls: PlotWall[];
  hangs: PlotHang[];
  /** Structure captions (trusses, walls, hangs) placed inside the plan area and treated as label obstacles. */
  captions: PlotCaption[];
  fixtures: PlotFixture[];
  numberOnlyCount: number;
  denseNote: string | null;
  simulatedMapNotice: string;
  /** Complete, never-truncated footer notice lines (simulated map + optional dense & oversize notes). */
  bottomNoticeLines: string[];
  unplacedCount: number;
  scaleBar: {
    maxMetres: number;
    totalWidthMm: number;
    ticks: PlotScaleBarTick[];
    checkText: string;
  };
  legend: {
    /** Full model list (sums to `paperwork.instrumentRows.length`). */
    models: PlotLegendRow[];
    /** Rows fitted into the legend height, with overflow rolled into `overflowRow` if needed. */
    visibleModels: PlotLegendRow[];
    overflowRow: { hiddenModels: number; totalCount: number } | null;
    totalFixtures: number;
    hasIssues: boolean;
  };
  titleBlock: PlotTitleBlockResolved;
}

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function rectsOverlap(a: RectMm, b: RectMm, eps = 0.05): boolean {
  return !(
    a.x + a.w + eps <= b.x ||
    b.x + b.w + eps <= a.x ||
    a.y + a.h + eps <= b.y ||
    b.y + b.h + eps <= a.y
  );
}

function rectInside(inner: RectMm, outer: RectMm): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function clampRectInside(r: RectMm, outer: RectMm): RectMm {
  const x = Math.max(outer.x, Math.min(outer.x + outer.w - r.w, r.x));
  const y = Math.max(outer.y, Math.min(outer.y + outer.h - r.h, r.y));
  return { x, y, w: r.w, h: r.h };
}

/** Lightweight 2D spatial hash grid for O(1) average rect-overlap and nearest-neighbour queries. */
class SpatialRectGrid {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Array<{ id: number; rect: RectMm }>>();

  constructor(cellSize = 8) {
    this.cellSize = cellSize;
  }

  private range(min: number, max: number): [number, number] {
    return [Math.floor(min / this.cellSize), Math.floor(max / this.cellSize)];
  }

  insert(id: number, rect: RectMm): void {
    const [x0, x1] = this.range(rect.x, rect.x + rect.w);
    const [y0, y1] = this.range(rect.y, rect.y + rect.h);
    const entry = { id, rect };
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
  }

  overlapsAny(rect: RectMm, eps = 0.05, ignoreId = -1): boolean {
    const [x0, x1] = this.range(rect.x - eps, rect.x + rect.w + eps);
    const [y0, y1] = this.range(rect.y - eps, rect.y + rect.h + eps);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (item.id === ignoreId) continue;
          if (rectsOverlap(rect, item.rect, eps)) return true;
        }
      }
    }
    return false;
  }
}

/** Distance squared from point P to segment AB, plus normalized segment tangent. */
function nearestSegmentInfo(
  px: number,
  pz: number,
  points: readonly PlanPoint[],
): { distSq: number; tx: number; tz: number } | null {
  let best: { distSq: number; tx: number; tz: number } | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lenSq));
    const cx = a.x + t * dx;
    const cz = a.z + t * dz;
    const distSq = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    if (!best || distSq < best.distSq) {
      const len = Math.sqrt(lenSq);
      best = { distSq, tx: dx / len, tz: dz / len };
    }
  }
  return best;
}

/** Deterministic truss normal & tangent in plan coordinates (+X right, +Z downstage). */
function fixtureFrameAxes(
  unit: { x: number; z: number; floor: boolean; positionId: string },
  trussById: ReadonlyMap<string, PlotTruss>,
): { nx: number; nz: number; tx: number; tz: number } {
  if (unit.floor) return { nx: 0, nz: 1, tx: 1, tz: 0 };
  const truss = trussById.get(unit.positionId);
  if (!truss) return { nx: 0, nz: 1, tx: 1, tz: 0 };

  if (truss.circle) {
    const dx = unit.x - truss.circle.cx;
    const dz = unit.z - truss.circle.cz;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      const nx = dx / len;
      const nz = dz / len;
      return { nx, nz, tx: -nz, tz: nx };
    }
    return { nx: 0, nz: 1, tx: 1, tz: 0 };
  }

  const seg = nearestSegmentInfo(unit.x, unit.z, truss.points);
  if (!seg) return { nx: 0, nz: 1, tx: 1, tz: 0 };
  // Candidate normal perpendicular to segment; orient toward +Z (or +X when segment runs along Z).
  let nx = -seg.tz;
  let nz = seg.tx;
  if (Math.abs(nz) > 1e-6 ? nz < 0 : nx < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { nx, nz, tx: seg.tx, tz: seg.tz };
}

function buildScaleBar(scale: number): PlotPlanModel['scaleBar'] {
  // Choose the standard tick set whose total width fits cleanly inside the bottom band (<= 138 mm).
  // Scales >= 1:75 always show 1, 5, and 10 m ticks (10 m = 133.3 mm at 1:75, 66.7 mm at 1:150, 50 mm at 1:200).
  // At 1:50 (10 m = 200 mm) and 1:25 (10 m = 400 mm), a shorter metric bar fits cleanly inside the plan column.
  const maxBarMm = 138;
  const candidateSets: readonly (readonly number[])[] = [
    [1, 5, 10],
    [1, 2, 5],
    [1, 2],
    [1],
  ];
  let chosen: readonly number[] = [1];
  for (const set of candidateSets) {
    const maxM = set[set.length - 1];
    if ((maxM * 1000) / scale <= maxBarMm) {
      chosen = set;
      break;
    }
  }
  const ticks: PlotScaleBarTick[] = chosen.map((m) => ({
    metres: m,
    widthMm: (m * 1000) / scale,
    label: `${m} m`,
  }));
  const maxMetres = chosen[chosen.length - 1];
  const totalWidthMm = (maxMetres * 1000) / scale;
  const checkMm = Number(totalWidthMm.toFixed(1));
  return {
    maxMetres,
    totalWidthMm,
    ticks,
    checkText: `Print at 100% (Actual size). Check: ${maxMetres} m = ${checkMm} mm`,
  };
}

/**
 * Pure builder for the true-scale vector lighting plot plan (Sheet 1 of the production book).
 * Takes every fixture position, yaw, number and status directly from `ShowPaperwork` without
 * recomputing placement, so the plot, patch sheet, instrument schedule, MVR and DXF cannot drift.
 */
export function buildPlotPlan(
  paperwork: ShowPaperwork,
  sourceRig: RigConfig,
  stage?: NativeStage,
  options: BuildPlotPlanOptions = {},
): PlotPlanModel {
  const paper: PlotPaperSize = options.paper === 'letter' ? 'letter' : 'a4';
  const geom = PLOT_PAPER_GEOMETRY[paper];
  const { rig: resolvedRig } = resolveStudioGeometry(sourceRig, stage?.layout);

  // 1. Outlines: decks & trusses from resolveStudioGeometry, walls from planWalls, hangs from effectiveHangs.
  const decks: PlotDeck[] = getPlatforms(resolvedRig).map((d) => ({
    id: d.id,
    name: d.name,
    x: d.x,
    z: d.z,
    width: d.width,
    depth: d.depth,
    height: d.height,
  }));

  const trusses: PlotTruss[] = [];
  for (const pod of resolvedRig.trussPods) {
    if (pod.shape === 'circle') {
      const r = pod.width / 2;
      if (!finite(pod.x) || !finite(pod.z) || !finite(r) || r <= 0) continue;
      trusses.push({
        id: pod.id,
        name: pod.name,
        shape: pod.shape,
        baseY: pod.baseY,
        circle: { cx: pod.x, cz: pod.z, r },
        points: [],
        closed: true,
        labelPoint: { x: pod.x, z: pod.z - r },
      });
    } else {
      const pts = trussCenterLine(pod)
        .map((p) => podWorldPoint(pod, p))
        .filter((p) => finite(p.x) && finite(p.z));
      if (pts.length < 2) continue;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const closed = pts.length > 2 && Math.hypot(first.x - last.x, first.z - last.z) < 0.0001;
      trusses.push({
        id: pod.id,
        name: pod.name,
        shape: pod.shape,
        baseY: pod.baseY,
        points: closed ? pts.slice(0, -1) : pts,
        closed,
        labelPoint: first,
      });
    }
  }
  const trussById = new Map(trusses.map((t) => [t.id, t]));

  const walls: PlotWall[] = planWalls(resolvedRig, stage).map(({ wall, frame, primary, stock }) => {
    const axis = widthAxis(frame.yaw);
    const front = facing(frame.yaw);
    const halfD = 0.14;
    const quad: PlanPoint[] = [
      { x: frame.x - axis.x * (frame.width / 2) - front.x * halfD, z: frame.z - axis.z * (frame.width / 2) - front.z * halfD },
      { x: frame.x + axis.x * (frame.width / 2) - front.x * halfD, z: frame.z + axis.z * (frame.width / 2) - front.z * halfD },
      { x: frame.x + axis.x * (frame.width / 2) + front.x * halfD, z: frame.z + axis.z * (frame.width / 2) + front.z * halfD },
      { x: frame.x - axis.x * (frame.width / 2) + front.x * halfD, z: frame.z - axis.z * (frame.width / 2) + front.z * halfD },
    ];
    const baseName = wall.label ?? (primary ? 'Main LED wall' : wall.id);
    return {
      id: wall.id,
      label: stock ? `${baseName} (stock)` : baseName,
      stock,
      quad,
      center: { x: frame.x, z: frame.z },
      frontTip: { x: frame.x + front.x * 0.75, z: frame.z + front.z * 0.75 },
    };
  });

  const hangInfo = effectiveHangs(sourceRig, stage);
  const hangs: PlotHang[] = hangInfo.hangs.map((h, i) => {
    const front = facing(h.yaw);
    const side = widthAxis(h.yaw);
    const quad: PlanPoint[] = [
      [-0.45, -0.25],
      [0.45, -0.25],
      [0.45, 0.25],
      [-0.45, 0.25],
    ].map(([s, d]) => ({
      x: h.x + side.x * s + front.x * d,
      z: h.z + side.z * s + front.z * d,
    }));
    const aimTip = hangAimHandle(h);
    return {
      index: i,
      label: `PA ${i + 1} (${h.count}x)${hangInfo.authored ? '' : ' (stock)'}`,
      count: h.count,
      authored: hangInfo.authored,
      quad,
      center: { x: h.x, z: h.z },
      aimTip,
    };
  });

  // 2. Rig world bounds (metres).
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const include = (x: number, z: number, r = 0) => {
    if (!finite(x) || !finite(z) || !finite(r)) return;
    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minZ = Math.min(minZ, z - r);
    maxZ = Math.max(maxZ, z + r);
  };

  for (const d of decks) {
    include(d.x - d.width / 2, d.z - d.depth / 2);
    include(d.x + d.width / 2, d.z + d.depth / 2);
  }
  for (const t of trusses) {
    if (t.circle) {
      include(t.circle.cx, t.circle.cz, t.circle.r);
    } else {
      for (const p of t.points) include(p.x, p.z);
    }
  }
  for (const w of walls) {
    for (const p of w.quad) include(p.x, p.z);
    include(w.frontTip.x, w.frontTip.z);
  }
  for (const h of hangs) {
    for (const p of h.quad) include(p.x, p.z);
    include(h.aimTip.x, h.aimTip.z);
  }

  const unitSymbols = paperwork.units.map((u) => {
    const family = bodyFamilyFor(u.type, u.catalogId);
    const symbol = symbolForHardware(u.type, u.catalogId);
    const radius = Math.hypot(symbol.size.w / 2, symbol.size.d / 2);
    include(u.x, u.z, radius);
    return { u, family, symbol, radius };
  });

  // Fallback for empty rigs: use stage rectangle, or a 10 x 8 m box at the origin.
  if (!finite(minX) || !finite(maxX) || !finite(minZ) || !finite(maxZ)) {
    const sw = finite(sourceRig.stageWidth) && sourceRig.stageWidth > 0 ? sourceRig.stageWidth : 10;
    const sd = finite(sourceRig.stageDepth) && sourceRig.stageDepth > 0 ? sourceRig.stageDepth : 8;
    minX = -sw / 2;
    maxX = sw / 2;
    minZ = -sd / 2;
    maxZ = sd / 2;
  }

  // Enforce a sensible 3.0 x 2.2 m minimum extent so tiny rigs land cleanly on 1:25 on both A4 and Letter.
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const rawW = Math.max(3, maxX - minX);
  const rawD = Math.max(2.2, maxZ - minZ);
  minX = cx - rawW / 2;
  maxX = cx + rawW / 2;
  minZ = cz - rawD / 2;
  maxZ = cz + rawD / 2;

  // 3. Pick largest standard scale (1:25..1:250) that fits rig bounds + 0.5 m margin + 8 mm label room on each side.
  const neededW = rawW + 2 * PLOT_MARGIN_M;
  const neededD = rawD + 2 * PLOT_MARGIN_M;
  const availW = geom.planW - 2 * PLOT_LABEL_CLEARANCE_MM;
  const availH = geom.planH - 2 * PLOT_LABEL_CLEARANCE_MM;

  const fitsAt = (s: number) =>
    (neededW * 1000) / s <= availW && (neededD * 1000) / s <= availH;

  let scale: number | null = null;
  let oversize = false;
  for (const s of STANDARD_PLOT_SCALES) {
    if (fitsAt(s)) {
      scale = s;
      break;
    }
  }
  if (scale === null) {
    oversize = true;
    for (const s of OVERSIZE_PLOT_SCALES) {
      if (fitsAt(s)) {
        scale = s;
        break;
      }
    }
  }
  if (scale === null) {
    oversize = true;
    const reqW = (neededW * 1000) / Math.max(1, availW);
    const reqH = (neededD * 1000) / Math.max(1, availH);
    scale = Math.max(100, Math.ceil(Math.max(reqW, reqH) / 100) * 100);
  }

  // Inner SVG viewBox in world metres matching planW:planH aspect ratio exactly.
  const vbW = (geom.planW * scale) / 1000;
  const vbH = (geom.planH * scale) / 1000;
  const vbX = cx - vbW / 2;
  const vbY = cz - vbH / 2;

  const toPageX = (wx: number) => geom.planX + ((wx - vbX) * 1000) / scale;
  const toPageY = (wz: number) => geom.planY + ((wz - vbY) * 1000) / scale;
  const planRect: RectMm = {
    x: geom.planX + 0.6,
    y: geom.planY + 0.6,
    w: geom.planW - 1.2,
    h: geom.planH - 1.2,
  };

  // 4. Precompute symbol positions & bounding boxes in page mm and index into spatial grids.
  const symbolGrid = new SpatialRectGrid(8);
  const labelGrid = new SpatialRectGrid(8);
  const pointGrid = new Map<string, Array<{ idx: number; x: number; y: number }>>();
  const denseCell = PLOT_DENSE_THRESHOLD_MM;

  const preFixtures = unitSymbols.map(({ u, family, symbol }, idx) => {
    const pageX = toPageX(u.x);
    const pageY = toPageY(u.z);
    // Symbol plan envelope rotated by -u.yaw and scaled to mm, padded by 0.3 mm.
    const cos = Math.abs(Math.cos(u.yaw));
    const sin = Math.abs(Math.sin(u.yaw));
    const rotW = symbol.size.w * cos + symbol.size.d * sin;
    const rotD = symbol.size.w * sin + symbol.size.d * cos;
    const halfW = Math.max(0.6, ((rotW * 1000) / scale) / 2 + 0.3);
    const halfH = Math.max(0.6, ((rotD * 1000) / scale) / 2 + 0.3);
    const symbolBox: RectMm = {
      x: pageX - halfW,
      y: pageY - halfH,
      w: halfW * 2,
      h: halfH * 2,
    };
    symbolGrid.insert(idx, symbolBox);
    const gx = Math.floor(pageX / denseCell);
    const gy = Math.floor(pageY / denseCell);
    const pKey = `${gx},${gy}`;
    const bucket = pointGrid.get(pKey);
    if (bucket) bucket.push({ idx, x: pageX, y: pageY });
    else pointGrid.set(pKey, [{ idx, x: pageX, y: pageY }]);
    return { u, family, symbol, pageX, pageY, symbolBox };
  });

  // Nearest-neighbour distance in page mm via 3x3 spatial cell lookup (O(n) average).
  const denseSq = PLOT_DENSE_THRESHOLD_MM * PLOT_DENSE_THRESHOLD_MM;
  const denseFlags: boolean[] = preFixtures.map((a, i) => {
    const gx = Math.floor(a.pageX / denseCell);
    const gy = Math.floor(a.pageY / denseCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = pointGrid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const b = bucket[k];
          if (b.idx === i) continue;
          const ddx = a.pageX - b.x;
          const ddy = a.pageY - b.y;
          if (ddx * ddx + ddy * ddy < denseSq) return true;
        }
      }
    }
    return false;
  });

  // 5. Place structure captions strictly inside `planRect` and reserve them in `labelGrid`
  //    so fixture labels never overprint truss, wall or PA hang names.
  let obstacleId = 1;
  const captions: PlotCaption[] = [];
  const placeCaption = (
    id: string,
    kind: PlotCaption['kind'],
    rawText: string,
    anchorX: number,
    anchorY: number,
    anchor: 'start' | 'middle',
    maxWidthMm: number,
    fontSize: number,
  ) => {
    const text = truncateToWidth(rawText, maxWidthMm, fontSize, true);
    if (!text) return;
    const textW = estimateTextWidthMm(text, fontSize, true) + 0.6;
    const textH = fontSize + 0.8;

    const makeBox = (bx: number, by: number): RectMm => {
      const clampedX = Math.max(planRect.x, Math.min(planRect.x + planRect.w - textW, bx));
      const clampedY = Math.max(planRect.y, Math.min(planRect.y + planRect.h - textH, by));
      return { x: clampedX, y: clampedY, w: textW, h: textH };
    };

    const rawBoxX = anchor === 'middle' ? anchorX - textW / 2 : anchorX;
    // Try above the feature first, then below, then shifted further up/down to avoid symbols and other captions.
    const yOffsets = [anchorY - textH - 1.2, anchorY + 1.4, anchorY - textH - 4.2, anchorY + 4.4];
    let chosenBox = makeBox(rawBoxX, yOffsets[0]);
    for (const candidateY of yOffsets) {
      const box = makeBox(rawBoxX, candidateY);
      if (!labelGrid.overlapsAny(box, 0.1) && !symbolGrid.overlapsAny(box, 0.1)) {
        chosenBox = box;
        break;
      }
    }

    labelGrid.insert(obstacleId++, chosenBox);
    captions.push({
      id,
      kind,
      text,
      x: anchor === 'middle' ? chosenBox.x + chosenBox.w / 2 : chosenBox.x + 0.3,
      y: chosenBox.y + textH - 0.55,
      anchor,
      fontSize,
      box: chosenBox,
    });
  };

  for (const t of trusses) {
    placeCaption(
      `tl-${t.id}`,
      'truss',
      `${t.name} (${t.baseY.toFixed(1)} m)`,
      toPageX(t.labelPoint.x),
      toPageY(t.labelPoint.z),
      'start',
      34,
      1.7,
    );
  }
  for (const w of walls) {
    placeCaption(
      `wl-${w.id}`,
      'wall',
      w.label,
      toPageX(w.center.x),
      toPageY(w.center.z),
      'middle',
      30,
      1.7,
    );
  }
  for (const h of hangs) {
    placeCaption(
      `hl-${h.index}`,
      'hang',
      h.label,
      toPageX(h.center.x),
      toPageY(h.center.z),
      'middle',
      22,
      1.65,
    );
  }

  // 6. Place fixture labels using spatial grid obstacle checks.
  let numberOnlyCount = 0;
  const largeRigFastPath = preFixtures.length > 400;

  const canPlace = (box: RectMm, allowOwnSymbolIdx = -1): boolean => {
    if (!rectInside(box, planRect)) return false;
    if (labelGrid.overlapsAny(box, 0.05)) return false;
    if (symbolGrid.overlapsAny(box, 0.05, allowOwnSymbolIdx)) return false;
    return true;
  };

  const makeBoxAt = (cxMm: number, cyMm: number, w: number, h: number): RectMm => ({
    x: cxMm - w / 2,
    y: cyMm - h / 2,
    w,
    h,
  });

  const leaderToBox = (sx: number, sy: number, box: RectMm) => {
    const bx = box.x + box.w / 2;
    const by = box.y + box.h / 2;
    const dx = bx - sx;
    const dy = by - sy;
    if (Math.hypot(dx, dy) < 1e-3) return undefined;
    const tx = Math.abs(dx) > 1e-6 ? (box.w / 2) / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-6 ? (box.h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(1, Math.min(tx, ty));
    return {
      x1: sx,
      y1: sy,
      x2: bx - dx * t,
      y2: by - dy * t,
    };
  };

  const fixtures: PlotFixture[] = preFixtures.map((item, idx) => {
    const { u, family, symbol, pageX, pageY, symbolBox } = item;
    const dense = denseFlags[idx];
    const axes = fixtureFrameAxes(u, trussById);
    const isIssue = u.status !== 'ok';
    const primaryStr = isIssue ? `${u.fixtureNumber}!` : String(u.fixtureNumber);

    const fullW =
      Math.max(estimateTextWidthMm(primaryStr, 2.0, true), estimateTextWidthMm(u.dmxLabel, 1.45, false)) + 0.9;
    const fullH = 4.1;
    const numOnlyW = estimateTextWidthMm(primaryStr, 1.8, true) + 0.8;
    const numOnlyH = 2.4;

    const firstSign = u.mountOrder % 2 === 1 ? 1 : -1;
    const signs = [firstSign, -firstSign] as const;
    const symNormalReach =
      (symbolBox.w / 2) * Math.abs(axes.nx) + (symbolBox.h / 2) * Math.abs(axes.nz);
    const fullNormalHalf = (fullW / 2) * Math.abs(axes.nx) + (fullH / 2) * Math.abs(axes.nz);
    const numNormalHalf = (numOnlyW / 2) * Math.abs(axes.nx) + (numOnlyH / 2) * Math.abs(axes.nz);

    let chosen: PlotFixtureLabel | null = null;

    const tryCandidate = (
      cxMm: number,
      cyMm: number,
      w: number,
      h: number,
      mode: PlotLabelMode,
      withLeader: boolean,
      allowOwnIdx = -1,
    ): boolean => {
      const box = makeBoxAt(cxMm, cyMm, w, h);
      if (!canPlace(box, allowOwnIdx)) return false;
      labelGrid.insert(obstacleId++, box);
      const leader = withLeader ? leaderToBox(pageX, pageY, box) : undefined;
      chosen = {
        mode,
        primaryText: primaryStr,
        secondaryText: mode === 'number-only' ? null : u.dmxLabel,
        box,
        textX: box.x + box.w / 2,
        textY: box.y + box.h / 2,
        ...(leader ? { leader } : {}),
        forcedInside: false,
      };
      return true;
    };

    if (!dense) {
      if (symbolBox.w >= 6.5 && symbolBox.h >= 5.0) {
        tryCandidate(pageX, pageY, fullW, fullH, 'inside', false, idx);
      }
      if (!chosen) {
        const adjDist = symNormalReach + fullNormalHalf + 0.5;
        for (const s of signs) {
          if (tryCandidate(pageX + s * axes.nx * adjDist, pageY + s * axes.nz * adjDist, fullW, fullH, 'adjacent', false)) {
            break;
          }
        }
      }
      if (!chosen && !largeRigFastPath) {
        const dists = [
          symNormalReach + fullNormalHalf + 3.2,
          symNormalReach + fullNormalHalf + 6.8,
          symNormalReach + fullNormalHalf + 10.6,
        ];
        const shifts = [0, fullW * 0.85, -fullW * 0.85, fullW * 1.7, -fullW * 1.7];
        outerNonDense: for (const d of dists) {
          for (const s of signs) {
            for (const sh of shifts) {
              const lx = pageX + s * axes.nx * d + axes.tx * sh;
              const ly = pageY + s * axes.nz * d + axes.tz * sh;
              if (tryCandidate(lx, ly, fullW, fullH, 'leader', true)) break outerNonDense;
            }
          }
        }
      }
    } else if (!largeRigFastPath) {
      // Dense area (< 4 mm spacing): offset along truss normal with leader line first.
      const dists = [
        Math.max(5.5, symNormalReach + fullNormalHalf + 2.8),
        Math.max(10.0, symNormalReach + fullNormalHalf + 7.2),
        Math.max(14.5, symNormalReach + fullNormalHalf + 11.6),
      ];
      const shifts = [0, fullW * 0.9, -fullW * 0.9, fullW * 1.8, -fullW * 1.8];
      outerDenseFull: for (const d of dists) {
        for (const s of signs) {
          for (const sh of shifts) {
            const lx = pageX + s * axes.nx * d + axes.tx * sh;
            const ly = pageY + s * axes.nz * d + axes.tz * sh;
            if (tryCandidate(lx, ly, fullW, fullH, 'leader', true)) break outerDenseFull;
          }
        }
      }
    }

    // If full label collided everywhere (or large rig fast-path), fall back to compact number-only placement.
    if (!chosen) {
      const dists = largeRigFastPath
        ? [Math.max(3.2, symNormalReach + numNormalHalf + 1.2)]
        : [
            Math.max(3.2, symNormalReach + numNormalHalf + 1.2),
            Math.max(6.2, symNormalReach + numNormalHalf + 4.2),
            Math.max(9.4, symNormalReach + numNormalHalf + 7.4),
            Math.max(12.6, symNormalReach + numNormalHalf + 10.6),
          ];
      const shifts = largeRigFastPath
        ? [0]
        : [0, numOnlyW * 1.05, -numOnlyW * 1.05, numOnlyW * 2.1, -numOnlyW * 2.1];
      outerNum: for (const d of dists) {
        for (const s of signs) {
          for (const sh of shifts) {
            const lx = pageX + s * axes.nx * d + axes.tx * sh;
            const ly = pageY + s * axes.nz * d + axes.tz * sh;
            if (tryCandidate(lx, ly, numOnlyW, numOnlyH, 'number-only', true)) break outerNum;
          }
        }
      }
    }

    // Ultimate fallback: force number-only centered on symbol (clamped inside plan area) with white halo.
    if (!chosen) {
      const box = clampRectInside(makeBoxAt(pageX, pageY, numOnlyW, numOnlyH), planRect);
      chosen = {
        mode: 'number-only',
        primaryText: primaryStr,
        secondaryText: null,
        box,
        textX: box.x + box.w / 2,
        textY: box.y + box.h / 2,
        forcedInside: true,
      };
    }

    if (chosen.mode === 'number-only') numberOnlyCount++;

    return {
      fixtureNumber: u.fixtureNumber,
      unitNumber: u.unitNumber,
      mountOrder: u.mountOrder,
      positionId: u.positionId,
      positionName: u.positionName,
      floor: u.floor,
      dmxLabel: u.dmxLabel,
      status: u.status,
      x: u.x,
      y: u.y,
      z: u.z,
      yaw: u.yaw,
      pageX,
      pageY,
      symbolBox,
      family,
      symbol,
      dense,
      label: chosen,
    };
  });

  // 7. Legend aggregation (exact parity with paperwork.instrumentRows; sums inventory rows across DMX modes).
  const legendMap = new Map<string, PlotLegendRow>();
  for (const u of paperwork.units) {
    const key = `${u.type}::${u.catalogId ?? ''}::${u.manufacturer}::${u.modelName}::${u.powerW}::${u.powerEstimated ? 1 : 0}`;
    const existing = legendMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const displayName = u.manufacturer !== 'Generic' ? `${u.manufacturer} ${u.modelName}` : u.modelName;
      legendMap.set(key, {
        key,
        family: bodyFamilyFor(u.type, u.catalogId),
        symbol: symbolForHardware(u.type, u.catalogId),
        manufacturer: u.manufacturer,
        modelName: u.modelName,
        displayName,
        count: 1,
        wattsEach: u.powerW,
        wattsEstimated: u.powerEstimated,
      });
    }
  }
  const models = [...legendMap.values()].sort(
    (a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName),
  );

  const hasIssues = paperwork.totals.conflictUnits + paperwork.totals.overflowUnits > 0;
  const lineStylesH = hasIssues ? 27 : 22;
  const unplacedH = paperwork.unplaced.length > 0 ? 6 : 0;
  const availModelH = geom.legendH - 9 - lineStylesH - unplacedH;
  const rowH = 7.2;
  const maxVisibleRows = Math.max(1, Math.floor(availModelH / rowH));

  let visibleModels = models;
  let overflowRow: PlotPlanModel['legend']['overflowRow'] = null;
  if (models.length > maxVisibleRows) {
    const keep = Math.max(1, maxVisibleRows - 1);
    visibleModels = models.slice(0, keep);
    const hidden = models.slice(keep);
    overflowRow = {
      hiddenModels: hidden.length,
      totalCount: hidden.reduce((sum, r) => sum + r.count, 0),
    };
  }

  // 8. Title block (bottom right of sidebar) — bold widths accounted for so nothing clips.
  const tbInput = parseTitleBlockState({ ...DEFAULT_TITLE_BLOCK, ...options.titleBlock, paper });
  const sheetNumber = options.sheetNumber ?? 1;
  const totalSheets = options.totalSheets ?? 6;
  const titleMaxMm = geom.sidebarW - 4.5;
  const rigNameFull = sanitizeField(paperwork.rigName) || 'Untitled Stage';
  const venueRaw = tbInput.venue || sanitizeField(paperwork.venue.toUpperCase());
  const designerRaw = tbInput.designer || '—';
  const dateRaw = tbInput.date || sanitizeField(options.generatedDate, 32) || '—';
  const scaleRaw = `1:${scale}${oversize ? ' (fit)' : ''}`;

  const titleBlock: PlotTitleBlockResolved = {
    rigName: truncateToWidth(rigNameFull, titleMaxMm, 3.3, true),
    rigNameFull,
    venue: truncateToWidth(venueRaw, titleMaxMm, 2.25, true),
    designer: truncateToWidth(designerRaw, titleMaxMm, 2.25, true),
    revision: tbInput.revision,
    date: truncateToWidth(dateRaw, 38, 2.2, true),
    scaleLabel: truncateToWidth(scaleRaw, 18.5, 2.3, true),
    sheetLabel: `Sheet ${sheetNumber} of ${totalSheets}`,
    disclaimer: PLOT_DISCLAIMER,
  };

  // 9. Mandatory footer notices (wrapped, never truncated with ellipsis).
  const oversizeNote = oversize
    ? `Rig exceeds 1:250 on one sheet; printed at 1:${scale}. Multi-sheet tiling is not supported.`
    : null;
  const denseNote = numberOnlyCount > 0 ? PLOT_DENSE_NOTE : null;
  const noticeSegments = [PAPERWORK_SIMULATED_MAP_NOTICE];
  if (denseNote) noticeSegments.push(denseNote);
  if (oversizeNote) noticeSegments.push(oversizeNote);
  const bottomNoticeLines = wrapTextToLines(noticeSegments.join('  ·  '), geom.planW - 3, 1.65, false);

  return {
    paper,
    geometry: geom,
    scale,
    oversize,
    oversizeNote,
    rigBounds: {
      minX,
      maxX,
      minZ,
      maxZ,
      width: rawW,
      depth: rawD,
    },
    viewBox: {
      x: vbX,
      y: vbY,
      width: vbW,
      height: vbH,
    },
    decks,
    trusses,
    walls,
    hangs,
    captions,
    fixtures,
    numberOnlyCount,
    denseNote,
    simulatedMapNotice: PAPERWORK_SIMULATED_MAP_NOTICE,
    bottomNoticeLines,
    unplacedCount: paperwork.unplaced.length,
    scaleBar: buildScaleBar(scale),
    legend: {
      models,
      visibleModels,
      overflowRow,
      totalFixtures: paperwork.units.length,
      hasIssues,
    },
    titleBlock,
  };
}
