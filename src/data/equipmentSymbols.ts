import {
  DEFAULT_LED_PANEL_ID,
  getCatalogEntry,
  LEGACY_DEFAULTS,
  type CatalogBodyFamily,
  type HardwareType,
} from './equipmentCatalog';

/**
 * Pure 2D vector primitive in fixture-local metres (plan: X right, Z downstage; elevation: X right, Y up).
 * Shared by the 2D SVG Stage Designer plan, DXF CAD blocks, and picker/inventory thumbnails.
 */
export type Path2DSpec =
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly fill?: 'body' | 'lens' | 'accent' | 'none';
    }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly fill?: 'body' | 'lens' | 'accent' | 'none';
    }
  | {
      readonly kind: 'poly';
      readonly pts: readonly (readonly [number, number])[];
      readonly closed: boolean;
      readonly fill?: 'body' | 'lens' | 'accent' | 'none';
    };

export interface EquipmentSymbol {
  readonly family: CatalogBodyFamily;
  /** Top-down plan primitives in metres (origin at mount centre, front facing +Y in SVG / -Y in CAD). */
  readonly plan: readonly Path2DSpec[];
  /** Front/side elevation silhouette in normalized thumbnail coordinates (viewBox -1..1 × -1..1). */
  readonly elevation: readonly Path2DSpec[];
  /** Nominal outer envelope in metres (width, depth, height). */
  readonly size: { readonly w: number; readonly d: number; readonly h: number };
}

export const ALL_BODY_FAMILIES: readonly CatalogBodyFamily[] = [
  'moving-beam',
  'moving-spot',
  'moving-profile',
  'moving-wash',
  'followspot',
  'led-par',
  'led-batten',
  'strobe-panel',
  'blinder-4lite',
  'led-panel',
  'hazer-box',
  'fogger-box',
  'co2-jet',
  'laser-head',
];

const FAMILY_SYMBOLS: Readonly<Record<CatalogBodyFamily, EquipmentSymbol>> = {
  'moving-beam': {
    family: 'moving-beam',
    size: { w: 0.36, d: 0.36, h: 0.56 },
    plan: [
      { kind: 'rect', x: -0.17, y: -0.16, w: 0.34, h: 0.32, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0, r: 0.11, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.04], [0, 0.24]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.46, y: -0.78, w: 0.92, h: 0.28, fill: 'body' },
      { kind: 'rect', x: -0.42, y: -0.50, w: 0.14, h: 0.72, fill: 'body' },
      { kind: 'rect', x: 0.28, y: -0.50, w: 0.14, h: 0.72, fill: 'body' },
      { kind: 'poly', pts: [[-0.26, -0.34], [0.26, -0.34], [0.22, 0.52], [-0.22, 0.52]], closed: true, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0.52, r: 0.17, fill: 'lens' },
    ],
  },
  'moving-spot': {
    family: 'moving-spot',
    size: { w: 0.48, d: 0.48, h: 0.76 },
    plan: [
      { kind: 'rect', x: -0.23, y: -0.21, w: 0.46, h: 0.42, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0, r: 0.15, fill: 'lens' },
      { kind: 'circle', cx: 0, cy: 0, r: 0.08, fill: 'none' },
      { kind: 'poly', pts: [[0, 0.06], [0, 0.30]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.58, y: -0.82, w: 1.16, h: 0.30, fill: 'body' },
      { kind: 'rect', x: -0.50, y: -0.52, w: 0.16, h: 0.80, fill: 'body' },
      { kind: 'rect', x: 0.34, y: -0.52, w: 0.16, h: 0.80, fill: 'body' },
      { kind: 'rect', x: -0.31, y: -0.34, w: 0.62, h: 0.90, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0.56, r: 0.22, fill: 'lens' },
    ],
  },
  'moving-profile': {
    family: 'moving-profile',
    size: { w: 0.50, d: 0.52, h: 0.80 },
    plan: [
      { kind: 'rect', x: -0.24, y: -0.22, w: 0.48, h: 0.44, fill: 'body' },
      { kind: 'poly', pts: [[-0.14, -0.06], [0.14, -0.06], [0.11, 0.24], [-0.11, 0.24]], closed: true, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.12], [0, 0.34]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.58, y: -0.84, w: 1.16, h: 0.30, fill: 'body' },
      { kind: 'rect', x: -0.50, y: -0.54, w: 0.15, h: 0.78, fill: 'body' },
      { kind: 'rect', x: 0.35, y: -0.54, w: 0.15, h: 0.78, fill: 'body' },
      { kind: 'poly', pts: [[-0.32, -0.38], [0.32, -0.38], [0.24, 0.68], [-0.24, 0.68]], closed: true, fill: 'body' },
      { kind: 'rect', x: -0.20, y: 0.56, w: 0.40, h: 0.14, fill: 'lens' },
    ],
  },
  'moving-wash': {
    family: 'moving-wash',
    size: { w: 0.34, d: 0.32, h: 0.44 },
    plan: [
      { kind: 'circle', cx: 0, cy: 0, r: 0.17, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0, r: 0.11, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.05], [0, 0.24]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.44, y: -0.74, w: 0.88, h: 0.26, fill: 'body' },
      { kind: 'rect', x: -0.40, y: -0.48, w: 0.13, h: 0.58, fill: 'body' },
      { kind: 'rect', x: 0.27, y: -0.48, w: 0.13, h: 0.58, fill: 'body' },
      { kind: 'rect', x: -0.26, y: -0.24, w: 0.52, h: 0.54, fill: 'body' },
      { kind: 'circle', cx: -0.10, cy: 0.30, r: 0.08, fill: 'lens' },
      { kind: 'circle', cx: 0.10, cy: 0.30, r: 0.08, fill: 'lens' },
      { kind: 'circle', cx: 0, cy: 0.18, r: 0.09, fill: 'lens' },
    ],
  },
  followspot: {
    family: 'followspot',
    size: { w: 0.48, d: 0.72, h: 0.78 },
    plan: [
      { kind: 'rect', x: -0.22, y: -0.26, w: 0.44, h: 0.48, fill: 'body' },
      { kind: 'rect', x: -0.14, y: 0.14, w: 0.28, h: 0.22, fill: 'lens' },
      { kind: 'poly', pts: [[-0.24, -0.34], [0.24, -0.34]], closed: false, fill: 'accent' },
      { kind: 'poly', pts: [[0, 0.20], [0, 0.44]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.54, y: -0.82, w: 1.08, h: 0.26, fill: 'body' },
      { kind: 'rect', x: -0.44, y: -0.56, w: 0.14, h: 0.74, fill: 'body' },
      { kind: 'rect', x: 0.30, y: -0.56, w: 0.14, h: 0.74, fill: 'body' },
      { kind: 'rect', x: -0.28, y: -0.36, w: 0.56, h: 1.02, fill: 'body' },
      { kind: 'rect', x: -0.38, y: -0.46, w: 0.76, h: 0.10, fill: 'accent' },
      { kind: 'circle', cx: 0, cy: 0.66, r: 0.20, fill: 'lens' },
    ],
  },
  'led-par': {
    family: 'led-par',
    size: { w: 0.26, d: 0.28, h: 0.30 },
    plan: [
      { kind: 'circle', cx: 0, cy: 0, r: 0.13, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0, r: 0.085, fill: 'lens' },
      { kind: 'poly', pts: [[-0.16, -0.02], [-0.16, 0.06], [0.16, 0.06], [0.16, -0.02]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'poly', pts: [[-0.44, -0.70], [-0.44, 0.06], [0.44, 0.06], [0.44, -0.70]], closed: false, fill: 'none' },
      { kind: 'circle', cx: 0, cy: 0.06, r: 0.40, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0.06, r: 0.26, fill: 'lens' },
      { kind: 'rect', x: -0.14, y: -0.82, w: 0.28, h: 0.14, fill: 'accent' },
    ],
  },
  'led-batten': {
    family: 'led-batten',
    size: { w: 1.0, d: 0.18, h: 0.26 },
    plan: [
      { kind: 'rect', x: -0.48, y: -0.08, w: 0.96, h: 0.16, fill: 'body' },
      { kind: 'rect', x: -0.42, y: -0.04, w: 0.84, h: 0.08, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.04], [0, 0.20]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.84, y: -0.62, w: 1.68, h: 0.22, fill: 'body' },
      { kind: 'rect', x: -0.80, y: -0.40, w: 0.12, h: 0.44, fill: 'body' },
      { kind: 'rect', x: 0.68, y: -0.40, w: 0.12, h: 0.44, fill: 'body' },
      { kind: 'rect', x: -0.78, y: 0.0, w: 1.56, h: 0.34, fill: 'body' },
      { kind: 'rect', x: -0.70, y: 0.10, w: 1.40, h: 0.14, fill: 'lens' },
    ],
  },
  'strobe-panel': {
    family: 'strobe-panel',
    size: { w: 0.42, d: 0.22, h: 0.30 },
    plan: [
      { kind: 'rect', x: -0.26, y: -0.10, w: 0.52, h: 0.20, fill: 'body' },
      { kind: 'rect', x: -0.22, y: -0.03, w: 0.44, h: 0.06, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.04], [0, 0.20]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'poly', pts: [[-0.78, -0.72], [-0.78, 0.05], [0.78, 0.05], [0.78, -0.72]], closed: false, fill: 'none' },
      { kind: 'rect', x: -0.68, y: -0.34, w: 1.36, h: 0.78, fill: 'body' },
      { kind: 'rect', x: -0.58, y: -0.06, w: 1.16, h: 0.18, fill: 'lens' },
      { kind: 'rect', x: -0.58, y: 0.20, w: 1.16, h: 0.14, fill: 'accent' },
      { kind: 'rect', x: -0.58, y: -0.26, w: 1.16, h: 0.14, fill: 'accent' },
    ],
  },
  'blinder-4lite': {
    family: 'blinder-4lite',
    size: { w: 0.48, d: 0.20, h: 0.46 },
    plan: [
      { kind: 'rect', x: -0.24, y: -0.10, w: 0.48, h: 0.20, fill: 'body' },
      { kind: 'circle', cx: -0.11, cy: 0.02, r: 0.07, fill: 'lens' },
      { kind: 'circle', cx: 0.11, cy: 0.02, r: 0.07, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.04], [0, 0.20]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.58, y: -0.58, w: 1.16, h: 1.16, fill: 'body' },
      { kind: 'circle', cx: -0.26, cy: -0.24, r: 0.20, fill: 'lens' },
      { kind: 'circle', cx: 0.26, cy: -0.24, r: 0.20, fill: 'lens' },
      { kind: 'circle', cx: -0.26, cy: 0.24, r: 0.20, fill: 'lens' },
      { kind: 'circle', cx: 0.26, cy: 0.24, r: 0.20, fill: 'lens' },
    ],
  },
  'led-panel': {
    family: 'led-panel',
    size: { w: 0.50, d: 0.09, h: 0.50 },
    plan: [
      { kind: 'rect', x: -0.25, y: -0.045, w: 0.50, h: 0.09, fill: 'body' },
      { kind: 'rect', x: -0.23, y: 0.02, w: 0.46, h: 0.025, fill: 'lens' },
    ],
    elevation: [
      { kind: 'rect', x: -0.64, y: -0.64, w: 1.28, h: 1.28, fill: 'body' },
      { kind: 'rect', x: -0.54, y: -0.54, w: 1.08, h: 1.08, fill: 'lens' },
      { kind: 'poly', pts: [[-0.54, 0], [0.54, 0]], closed: false, fill: 'none' },
      { kind: 'poly', pts: [[0, -0.54], [0, 0.54]], closed: false, fill: 'none' },
    ],
  },
  'hazer-box': {
    family: 'hazer-box',
    size: { w: 0.62, d: 0.54, h: 0.42 },
    plan: [
      { kind: 'rect', x: -0.28, y: -0.24, w: 0.56, h: 0.48, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0.16, r: 0.07, fill: 'accent' },
      { kind: 'poly', pts: [[-0.16, -0.14], [0.16, -0.14]], closed: false, fill: 'none' },
    ],
    elevation: [
      { kind: 'rect', x: -0.68, y: -0.56, w: 1.36, h: 0.96, fill: 'body' },
      { kind: 'rect', x: -0.72, y: 0.28, w: 1.44, h: 0.14, fill: 'accent' },
      { kind: 'circle', cx: -0.28, cy: -0.06, r: 0.18, fill: 'lens' },
      { kind: 'rect', x: 0.06, y: -0.28, w: 0.48, h: 0.42, fill: 'none' },
    ],
  },
  'fogger-box': {
    family: 'fogger-box',
    size: { w: 0.44, d: 0.58, h: 0.30 },
    plan: [
      { kind: 'rect', x: -0.20, y: -0.26, w: 0.40, h: 0.52, fill: 'body' },
      { kind: 'rect', x: -0.06, y: 0.22, w: 0.12, h: 0.12, fill: 'accent' },
    ],
    elevation: [
      { kind: 'rect', x: -0.64, y: -0.52, w: 1.28, h: 0.72, fill: 'body' },
      { kind: 'poly', pts: [[-0.32, 0.20], [-0.24, 0.46], [0.24, 0.46], [0.32, 0.20]], closed: false, fill: 'none' },
      { kind: 'circle', cx: 0.34, cy: -0.12, r: 0.16, fill: 'accent' },
    ],
  },
  'co2-jet': {
    family: 'co2-jet',
    size: { w: 0.24, d: 0.28, h: 0.38 },
    plan: [
      { kind: 'rect', x: -0.12, y: -0.14, w: 0.24, h: 0.28, fill: 'body' },
      { kind: 'circle', cx: 0, cy: 0.02, r: 0.065, fill: 'accent' },
    ],
    elevation: [
      { kind: 'rect', x: -0.44, y: -0.74, w: 0.88, h: 0.24, fill: 'body' },
      { kind: 'rect', x: -0.16, y: -0.50, w: 0.32, h: 1.16, fill: 'accent' },
      { kind: 'rect', x: -0.22, y: 0.52, w: 0.44, h: 0.16, fill: 'lens' },
    ],
  },
  'laser-head': {
    family: 'laser-head',
    size: { w: 0.44, d: 0.52, h: 0.28 },
    plan: [
      { kind: 'poly', pts: [[-0.20, -0.20], [0.20, -0.20], [0.16, 0.22], [-0.16, 0.22]], closed: true, fill: 'body' },
      { kind: 'rect', x: -0.09, y: 0.16, w: 0.18, h: 0.06, fill: 'lens' },
      { kind: 'poly', pts: [[0, 0.18], [0, 0.34]], closed: false, fill: 'accent' },
    ],
    elevation: [
      { kind: 'rect', x: -0.66, y: -0.44, w: 1.32, h: 0.78, fill: 'body' },
      { kind: 'rect', x: -0.68, y: 0.20, w: 1.36, h: 0.12, fill: 'accent' },
      { kind: 'rect', x: -0.26, y: -0.14, w: 0.52, h: 0.22, fill: 'lens' },
    ],
  },
};

export function bodyFamilyFor(type: HardwareType, catalogId?: string): CatalogBodyFamily {
  const entry = getCatalogEntry(catalogId) ?? getCatalogEntry(LEGACY_DEFAULTS[type]);
  if (entry) return entry.body;
  switch (type) {
    case 'beam':
    case 'floor_beam':
      return 'moving-beam';
    case 'wash':
      return 'moving-wash';
    case 'strobe':
      return 'strobe-panel';
    case 'blinder':
      return 'blinder-4lite';
    case 'laser':
    case 'floor_laser':
      return 'laser-head';
    case 'hazer':
      return 'hazer-box';
    case 'smoke':
      return 'fogger-box';
    case 'co2':
      return 'co2-jet';
  }
}

export function symbolFor(family: CatalogBodyFamily, catalogId?: string): EquipmentSymbol {
  const base = Object.hasOwn(FAMILY_SYMBOLS, family) ? FAMILY_SYMBOLS[family] : FAMILY_SYMBOLS['moving-beam'];
  const entry = getCatalogEntry(catalogId);
  if (!entry) return base;

  // Apply catalogue LED panel aspect proportions when available (e.g. ROE CB5 600×1200 mm vs BP2 500×500 mm)
  if (family === 'led-panel' && entry.panel) {
    const w = entry.panel.widthMm / 1000;
    const h = entry.panel.heightMm / 1000;
    const tall = h > w * 1.25;
    return {
      ...base,
      size: { w, d: 0.09, h },
      plan: [
        { kind: 'rect', x: -w / 2, y: -0.045, w, h: 0.09, fill: 'body' },
        { kind: 'rect', x: -w * 0.46, y: 0.02, w: w * 0.92, h: 0.025, fill: 'lens' },
      ],
      elevation: tall
        ? [
            { kind: 'rect', x: -0.44, y: -0.82, w: 0.88, h: 1.64, fill: 'body' },
            { kind: 'rect', x: -0.36, y: -0.74, w: 0.72, h: 1.48, fill: 'lens' },
            { kind: 'poly', pts: [[-0.36, 0], [0.36, 0]], closed: false, fill: 'none' },
          ]
        : base.elevation,
    };
  }

  return base;
}

export function symbolForHardware(type: HardwareType, catalogId?: string): EquipmentSymbol {
  return symbolFor(bodyFamilyFor(type, catalogId), catalogId);
}

export function symbolForLedPanel(cabinetId?: string): EquipmentSymbol {
  return symbolFor('led-panel', cabinetId ?? DEFAULT_LED_PANEL_ID);
}

/** Convert a Path2DSpec to an SVG path `d` attribute string (works for both plan and elevation). */
export function specToSvgPath(spec: Path2DSpec, flipY = false): string {
  const fy = (y: number) => (flipY ? -y : y);
  if (spec.kind === 'rect') {
    const top = flipY ? -(spec.y + spec.h) : spec.y;
    return `M${spec.x} ${top}h${spec.w}v${spec.h}h${-spec.w}Z`;
  }
  if (spec.kind === 'circle') {
    const cy = fy(spec.cy);
    const r = spec.r;
    return `M${spec.cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
  if (!spec.pts.length) return '';
  const head = spec.pts[0];
  const rest = spec.pts.slice(1).map(([x, y]) => `L${x} ${fy(y)}`).join('');
  return `M${head[0]} ${fy(head[1])}${rest}${spec.closed ? 'Z' : ''}`;
}
