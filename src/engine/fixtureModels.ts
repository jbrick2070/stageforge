import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  getCatalogEntry,
  LEGACY_DEFAULTS,
  type CatalogBodyFamily,
  type HardwareType,
} from '../data/equipmentCatalog';
import { HEAD_PIVOT, YOKE_OFFSET } from './focusAim';
import {
  HardwareAtlasBand,
  mapGeometryUvToBand,
  type RenderTier,
} from './hardwareMaterials';

export type FixtureMotion = 'pan-tilt' | 'tilt' | 'fixed';

export interface ModelSpec {
  readonly id: string;
  readonly family: CatalogBodyFamily;
  /** Nominal outer envelope in metres (width, height, depth) for proportions & tests. */
  readonly envelope: { readonly w: number; readonly h: number; readonly d: number };
  /** Distance from clamp/base root to tilt pivot axis in metres (moving/tilting fixtures). */
  readonly pivotY: number;
  readonly motion: FixtureMotion;
  readonly base: {
    readonly w: number;
    readonly h: number;
    readonly d: number;
    readonly lcd?: boolean;
    readonly handles?: 'side' | 'dual-touring';
    readonly dualClamps?: boolean;
  };
  readonly yoke?: {
    readonly armH: number;
    readonly armW: number;
    readonly armD: number;
    readonly gap: number;
  };
  readonly head: {
    readonly kind:
      | 'barrel'
      | 'taper'
      | 'snout'
      | 'stub-cells'
      | 'par-can'
      | 'bar-cells'
      | 'panel'
      | 'pod2x2'
      | 'box';
    readonly len: number;
    readonly dia: number;
    readonly width?: number;
    readonly cells?: readonly [number, number];
    readonly fins?: boolean;
    readonly ip65Fins?: boolean;
    readonly rearHandles?: boolean;
    readonly jdcAuraPlates?: boolean;
  };
}

/**
 * Per-model physical specifications for all 30 catalogue entries.
 * Dimensions are nominal touring hardware envelopes in metres.
 */
export const MODEL_SPECS: Readonly<Record<string, ModelSpec>> = {
  // ── Beam Moving Heads ───────────────────────────────────────────────────────
  'claypaky-sharpy': {
    id: 'claypaky-sharpy',
    family: 'moving-beam',
    envelope: { w: 0.40, h: 0.56, d: 0.33 },
    pivotY: 0.42,
    motion: 'pan-tilt',
    base: { w: 0.36, h: 0.13, d: 0.32, lcd: true, handles: 'side' },
    yoke: { armH: 0.31, armW: 0.055, armD: 0.11, gap: 0.27 },
    head: { kind: 'taper', len: 0.32, dia: 0.23, fins: true },
  },
  'robe-megapointe': {
    id: 'robe-megapointe',
    family: 'moving-beam',
    envelope: { w: 0.42, h: 0.64, d: 0.38 },
    pivotY: 0.48,
    motion: 'pan-tilt',
    base: { w: 0.40, h: 0.15, d: 0.35, lcd: true, handles: 'side' },
    yoke: { armH: 0.35, armW: 0.06, armD: 0.13, gap: 0.30 },
    head: { kind: 'barrel', len: 0.38, dia: 0.26, fins: true },
  },
  'robe-ledbeam-150': {
    id: 'robe-ledbeam-150',
    family: 'moving-beam',
    envelope: { w: 0.25, h: 0.35, d: 0.20 },
    pivotY: 0.28,
    motion: 'pan-tilt',
    base: { w: 0.24, h: 0.10, d: 0.20, lcd: true },
    yoke: { armH: 0.20, armW: 0.04, armD: 0.08, gap: 0.17 },
    head: { kind: 'stub-cells', len: 0.17, dia: 0.15, cells: [3, 1], fins: false },
  },

  // ── Spot & Profile Moving Heads ─────────────────────────────────────────────
  'martin-mac-ultra-performance': {
    id: 'martin-mac-ultra-performance',
    family: 'moving-profile',
    envelope: { w: 0.56, h: 0.81, d: 0.50 },
    pivotY: 0.56,
    motion: 'pan-tilt',
    base: { w: 0.50, h: 0.18, d: 0.44, lcd: true, handles: 'dual-touring', dualClamps: true },
    yoke: { armH: 0.42, armW: 0.08, armD: 0.16, gap: 0.39 },
    head: { kind: 'snout', len: 0.50, dia: 0.34, fins: true },
  },
  'robe-bmfl-spot': {
    id: 'robe-bmfl-spot',
    family: 'moving-spot',
    envelope: { w: 0.54, h: 0.81, d: 0.48 },
    pivotY: 0.56,
    motion: 'pan-tilt',
    base: { w: 0.48, h: 0.17, d: 0.42, lcd: true, handles: 'dual-touring', dualClamps: true },
    yoke: { armH: 0.42, armW: 0.075, armD: 0.15, gap: 0.38 },
    head: { kind: 'barrel', len: 0.48, dia: 0.34, fins: true },
  },
  'robe-t1-profile': {
    id: 'robe-t1-profile',
    family: 'moving-profile',
    envelope: { w: 0.46, h: 0.72, d: 0.40 },
    pivotY: 0.50,
    motion: 'pan-tilt',
    base: { w: 0.42, h: 0.15, d: 0.36, lcd: true, handles: 'side', dualClamps: true },
    yoke: { armH: 0.38, armW: 0.065, armD: 0.14, gap: 0.32 },
    head: { kind: 'snout', len: 0.44, dia: 0.28, fins: true },
  },
  'ayrton-perseo-profile': {
    id: 'ayrton-perseo-profile',
    family: 'moving-profile',
    envelope: { w: 0.52, h: 0.78, d: 0.44 },
    pivotY: 0.54,
    motion: 'pan-tilt',
    base: { w: 0.46, h: 0.16, d: 0.40, lcd: true, handles: 'dual-touring', dualClamps: true },
    yoke: { armH: 0.41, armW: 0.072, armD: 0.15, gap: 0.36 },
    head: { kind: 'snout', len: 0.47, dia: 0.31, fins: true, ip65Fins: true },
  },

  // ── Followspot ──────────────────────────────────────────────────────────────
  'robe-bmfl-followspot': {
    id: 'robe-bmfl-followspot',
    family: 'followspot',
    envelope: { w: 0.54, h: 0.82, d: 0.56 },
    pivotY: 0.56,
    motion: 'pan-tilt',
    base: { w: 0.48, h: 0.17, d: 0.42, lcd: true, handles: 'dual-touring', dualClamps: true },
    yoke: { armH: 0.42, armW: 0.075, armD: 0.15, gap: 0.38 },
    head: { kind: 'snout', len: 0.54, dia: 0.33, fins: true, rearHandles: true },
  },

  // ── Wash Moving Heads ───────────────────────────────────────────────────────
  'martin-mac-aura-xb': {
    id: 'martin-mac-aura-xb',
    family: 'moving-wash',
    envelope: { w: 0.31, h: 0.36, d: 0.28 },
    pivotY: 0.31,
    motion: 'pan-tilt',
    base: { w: 0.29, h: 0.11, d: 0.25, lcd: true },
    yoke: { armH: 0.22, armW: 0.048, armD: 0.095, gap: 0.22 },
    head: { kind: 'stub-cells', len: 0.19, dia: 0.21, cells: [4, 4], fins: false },
  },
  'martin-mac-aura-xip': {
    id: 'martin-mac-aura-xip',
    family: 'moving-wash',
    envelope: { w: 0.34, h: 0.40, d: 0.30 },
    pivotY: 0.34,
    motion: 'pan-tilt',
    base: { w: 0.32, h: 0.12, d: 0.27, lcd: true },
    yoke: { armH: 0.24, armW: 0.052, armD: 0.105, gap: 0.24 },
    head: { kind: 'stub-cells', len: 0.21, dia: 0.23, cells: [4, 4], fins: true, ip65Fins: true },
  },
  'robe-spiider': {
    id: 'robe-spiider',
    family: 'moving-wash',
    envelope: { w: 0.42, h: 0.48, d: 0.34 },
    pivotY: 0.40,
    motion: 'pan-tilt',
    base: { w: 0.38, h: 0.13, d: 0.32, lcd: true, handles: 'side' },
    yoke: { armH: 0.29, armW: 0.06, armD: 0.12, gap: 0.30 },
    head: { kind: 'stub-cells', len: 0.22, dia: 0.29, cells: [5, 4], fins: true },
  },
  'chauvet-rogue-r1-beamwash': {
    id: 'chauvet-rogue-r1-beamwash',
    family: 'moving-wash',
    envelope: { w: 0.28, h: 0.36, d: 0.24 },
    pivotY: 0.30,
    motion: 'pan-tilt',
    base: { w: 0.26, h: 0.10, d: 0.22, lcd: true },
    yoke: { armH: 0.22, armW: 0.045, armD: 0.09, gap: 0.20 },
    head: { kind: 'stub-cells', len: 0.18, dia: 0.19, cells: [3, 3], fins: false },
  },

  // ── LED PARs & Battens ──────────────────────────────────────────────────────
  'chauvet-colorado-1-quad-zoom': {
    id: 'chauvet-colorado-1-quad-zoom',
    family: 'led-par',
    envelope: { w: 0.28, h: 0.34, d: 0.30 },
    pivotY: 0.22,
    motion: 'fixed',
    base: { w: 0.09, h: 0.04, d: 0.09 },
    yoke: { armH: 0.20, armW: 0.025, armD: 0.04, gap: 0.25 },
    head: { kind: 'par-can', len: 0.26, dia: 0.22, fins: true, ip65Fins: true },
  },
  'etc-colorsource-par': {
    id: 'etc-colorsource-par',
    family: 'led-par',
    envelope: { w: 0.24, h: 0.29, d: 0.24 },
    pivotY: 0.19,
    motion: 'fixed',
    base: { w: 0.08, h: 0.035, d: 0.08 },
    yoke: { armH: 0.17, armW: 0.022, armD: 0.036, gap: 0.21 },
    head: { kind: 'par-can', len: 0.20, dia: 0.18, fins: true },
  },
  'chauvet-colorado-pxl-bar-16': {
    id: 'chauvet-colorado-pxl-bar-16',
    family: 'led-batten',
    envelope: { w: 1.00, h: 0.28, d: 0.18 },
    pivotY: 0.22,
    motion: 'tilt',
    base: { w: 0.96, h: 0.09, d: 0.14, lcd: true, dualClamps: true },
    yoke: { armH: 0.15, armW: 0.04, armD: 0.08, gap: 0.96 },
    head: { kind: 'bar-cells', len: 0.15, dia: 0.11, width: 0.92, cells: [16, 1], fins: true, ip65Fins: true },
  },
  'glp-impression-x4-bar-20': {
    id: 'glp-impression-x4-bar-20',
    family: 'led-batten',
    envelope: { w: 1.00, h: 0.25, d: 0.16 },
    pivotY: 0.20,
    motion: 'tilt',
    base: { w: 0.98, h: 0.08, d: 0.13, lcd: true, dualClamps: true },
    yoke: { armH: 0.14, armW: 0.035, armD: 0.075, gap: 0.98 },
    head: { kind: 'bar-cells', len: 0.13, dia: 0.095, width: 0.96, cells: [20, 1], fins: false },
  },

  // ── Strobes & Blinders ──────────────────────────────────────────────────────
  'glp-jdc1': {
    id: 'glp-jdc1',
    family: 'strobe-panel',
    envelope: { w: 0.46, h: 0.32, d: 0.22 },
    pivotY: 0.22,
    motion: 'fixed',
    base: { w: 0.42, h: 0.08, d: 0.16, lcd: true, dualClamps: true },
    yoke: { armH: 0.18, armW: 0.04, armD: 0.09, gap: 0.40 },
    head: { kind: 'panel', len: 0.24, dia: 0.14, width: 0.39, fins: true, jdcAuraPlates: true },
  },
  'martin-atomic-3000-led': {
    id: 'martin-atomic-3000-led',
    family: 'strobe-panel',
    envelope: { w: 0.44, h: 0.26, d: 0.24 },
    pivotY: 0.19,
    motion: 'fixed',
    base: { w: 0.36, h: 0.04, d: 0.12 },
    yoke: { armH: 0.16, armW: 0.03, armD: 0.06, gap: 0.42 },
    head: { kind: 'panel', len: 0.23, dia: 0.21, width: 0.40, fins: true, jdcAuraPlates: false },
  },
  'mole-richardson-molefay-4lite': {
    id: 'mole-richardson-molefay-4lite',
    family: 'blinder-4lite',
    envelope: { w: 0.46, h: 0.46, d: 0.22 },
    pivotY: 0.28,
    motion: 'fixed',
    base: { w: 0.34, h: 0.04, d: 0.10 },
    yoke: { armH: 0.24, armW: 0.03, armD: 0.055, gap: 0.46 },
    head: { kind: 'pod2x2', len: 0.40, dia: 0.18, width: 0.42, cells: [2, 2], fins: false },
  },
  'chauvet-strike-4': {
    id: 'chauvet-strike-4',
    family: 'blinder-4lite',
    envelope: { w: 0.48, h: 0.48, d: 0.24 },
    pivotY: 0.29,
    motion: 'fixed',
    base: { w: 0.38, h: 0.045, d: 0.12, dualClamps: true },
    yoke: { armH: 0.25, armW: 0.035, armD: 0.065, gap: 0.47 },
    head: { kind: 'pod2x2', len: 0.42, dia: 0.20, width: 0.44, cells: [2, 2], fins: true },
  },

  // ── LED Video Panels (used for instanced rear cabinet tiles) ────────────────
  'roe-bp2-v2': {
    id: 'roe-bp2-v2',
    family: 'led-panel',
    envelope: { w: 0.50, h: 0.50, d: 0.085 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.50, h: 0.50, d: 0.085 },
    head: { kind: 'box', len: 0.085, dia: 0.50 },
  },
  'roe-cb5': {
    id: 'roe-cb5',
    family: 'led-panel',
    envelope: { w: 0.60, h: 1.20, d: 0.095 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.60, h: 1.20, d: 0.095 },
    head: { kind: 'box', len: 0.095, dia: 0.60 },
  },

  // ── Hazers, Foggers & CO2 Jets ──────────────────────────────────────────────
  'mdg-atme': {
    id: 'mdg-atme',
    family: 'hazer-box',
    envelope: { w: 0.30, h: 0.30, d: 0.68 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.32, h: 0.30, d: 0.66, lcd: true, handles: 'side' },
    head: { kind: 'box', len: 0.66, dia: 0.30 },
  },
  'mdg-theone': {
    id: 'mdg-theone',
    family: 'hazer-box',
    envelope: { w: 0.64, h: 0.46, d: 0.60 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.64, h: 0.44, d: 0.58, lcd: true, handles: 'dual-touring' },
    head: { kind: 'box', len: 0.58, dia: 0.44 },
  },
  'look-solutions-unique-21': {
    id: 'look-solutions-unique-21',
    family: 'hazer-box',
    envelope: { w: 0.25, h: 0.25, d: 0.47 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.26, h: 0.25, d: 0.47, lcd: true },
    head: { kind: 'box', len: 0.47, dia: 0.25 },
  },
  'martin-jem-zr45': {
    id: 'martin-jem-zr45',
    family: 'fogger-box',
    envelope: { w: 0.40, h: 0.32, d: 0.68 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.40, h: 0.28, d: 0.66, lcd: true, handles: 'side' },
    head: { kind: 'box', len: 0.66, dia: 0.28 },
  },
  'look-solutions-viper-nt': {
    id: 'look-solutions-viper-nt',
    family: 'fogger-box',
    envelope: { w: 0.24, h: 0.25, d: 0.52 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.24, h: 0.22, d: 0.50, lcd: true },
    head: { kind: 'box', len: 0.50, dia: 0.22 },
  },
  'magicfx-co2jet-ii': {
    id: 'magicfx-co2jet-ii',
    family: 'co2-jet',
    envelope: { w: 0.20, h: 0.38, d: 0.24 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.20, h: 0.08, d: 0.22 },
    head: { kind: 'box', len: 0.32, dia: 0.09 },
  },

  // ── Lasers (distinct chassis proportions across Class 3B -> 30 W arena tiers) ──
  'laserworld-cs-500g': {
    id: 'laserworld-cs-500g',
    family: 'laser-head',
    envelope: { w: 0.24, h: 0.14, d: 0.24 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.23, h: 0.13, d: 0.24 },
    head: { kind: 'box', len: 0.24, dia: 0.13, fins: false },
  },
  'unity-raw-1-7': {
    id: 'unity-raw-1-7',
    family: 'laser-head',
    envelope: { w: 0.26, h: 0.16, d: 0.28 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.25, h: 0.15, d: 0.27 },
    head: { kind: 'box', len: 0.27, dia: 0.15, fins: false },
  },
  'laserworld-ds-3000rgb': {
    id: 'laserworld-ds-3000rgb',
    family: 'laser-head',
    envelope: { w: 0.22, h: 0.15, d: 0.23 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.21, h: 0.145, d: 0.22 },
    head: { kind: 'box', len: 0.22, dia: 0.145, fins: false },
  },
  'kvant-clubmax': {
    id: 'kvant-clubmax',
    family: 'laser-head',
    envelope: { w: 0.36, h: 0.18, d: 0.28 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.36, h: 0.17, d: 0.26, handles: 'side' },
    head: { kind: 'box', len: 0.26, dia: 0.17, fins: false },
  },
  'laserworld-pl-10000rgb': {
    id: 'laserworld-pl-10000rgb',
    family: 'laser-head',
    envelope: { w: 0.35, h: 0.22, d: 0.36 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.35, h: 0.21, d: 0.34, handles: 'side' },
    head: { kind: 'box', len: 0.34, dia: 0.21, fins: true },
  },
  'kvant-spectrum': {
    id: 'kvant-spectrum',
    family: 'laser-head',
    envelope: { w: 0.50, h: 0.32, d: 0.58 },
    pivotY: 0,
    motion: 'fixed',
    base: { w: 0.50, h: 0.28, d: 0.56, handles: 'dual-touring', dualClamps: true },
    head: { kind: 'box', len: 0.56, dia: 0.28, fins: true },
  },
};

/** Nearest existing 3D model spec reused by expanded catalogue entries for each body family. */
export const FAMILY_DEFAULT_MODEL_ID: Readonly<Record<CatalogBodyFamily, string>> = {
  'moving-beam': 'claypaky-sharpy',
  'moving-spot': 'robe-bmfl-spot',
  'moving-profile': 'robe-t1-profile',
  'moving-wash': 'martin-mac-aura-xb',
  followspot: 'robe-bmfl-followspot',
  'led-par': 'etc-colorsource-par',
  'led-batten': 'glp-impression-x4-bar-20',
  'strobe-panel': 'glp-jdc1',
  'blinder-4lite': 'chauvet-strike-4',
  'led-panel': 'roe-bp2-v2',
  'hazer-box': 'mdg-atme',
  'fogger-box': 'martin-jem-zr45',
  'co2-jet': 'magicfx-co2jet-ii',
  'laser-head': 'kvant-clubmax',
};

/** Resolve the physical ModelSpec for a fixture/FX group. Legacy groups keep HEAD_PIVOT for exact aim compatibility. */
export function resolveModelSpec(type: HardwareType, catalogId?: string): ModelSpec {
  const known = catalogId && Object.hasOwn(MODEL_SPECS, catalogId) ? MODEL_SPECS[catalogId] : undefined;
  if (known) return known;

  const entry = getCatalogEntry(catalogId);
  if (entry) {
    const familyModelId = FAMILY_DEFAULT_MODEL_ID[entry.body];
    if (Object.hasOwn(MODEL_SPECS, familyModelId)) {
      const base = MODEL_SPECS[familyModelId];
      return entry.motion && entry.motion !== base.motion
        ? { ...base, motion: entry.motion }
        : base;
    }
  }

  const fallbackId = LEGACY_DEFAULTS[type];
  const baseSpec = Object.hasOwn(MODEL_SPECS, fallbackId) ? MODEL_SPECS[fallbackId] : MODEL_SPECS['claypaky-sharpy'];
  if (!catalogId && (type === 'beam' || type === 'wash' || type === 'floor_beam')) {
    // Preserve exact legacy pivotY & pan-tilt motion so v1-v5 shows and focus-point tests remain bit-identical.
    return {
      ...baseSpec,
      id: `legacy:${type}`,
      pivotY: HEAD_PIVOT,
      motion: 'pan-tilt',
    };
  }
  return baseSpec;
}

/** Count triangles in a BufferGeometry (works for both indexed and non-indexed). */
export function countTriangles(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return geometry.index.count / 3;
  const pos = geometry.getAttribute('position');
  return pos ? pos.count / 3 : 0;
}

/** Normalize attributes to position/normal/uv, merge cleanly, and dispose input parts. */
function mergeNormalized(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!parts.length) return new THREE.BufferGeometry();
  const normalized: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const g = part.index ? part.toNonIndexed() : part.clone();
    // Ensure only standard attributes exist so mergeGeometries never fails on mismatches.
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    normalized.push(g);
    part.dispose();
  }
  const merged = mergeGeometries(normalized, false);
  for (const g of normalized) g.dispose();
  if (!merged) throw new Error('Failed to merge procedural fixture geometry parts.');
  merged.computeBoundingSphere();
  return merged;
}

function boxPart(
  w: number,
  h: number,
  d: number,
  band: HardwareAtlasBand,
  x = 0,
  y = 0,
  z = 0,
  uMin = 0.02,
  uMax = 0.98,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  mapGeometryUvToBand(g, band, uMin, uMax);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

function cylPart(
  rTop: number,
  rBot: number,
  h: number,
  segs: number,
  band: HardwareAtlasBand,
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  uMin = 0.02,
  uMax = 0.98,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, segs);
  mapGeometryUvToBand(g, band, uMin, uMax);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

function addClampParts(
  out: THREE.BufferGeometry[],
  dual: boolean,
  spacingX: number,
  dir: 1 | -1,
  tier: RenderTier,
  yOffset = 0,
) {
  // Hung fixtures hang along -Y (dir === -1), so clamps sit at y >= yOffset gripping the truss chord above.
  const clampY = yOffset - dir * 0.032;
  const xs = dual ? [-spacingX, spacingX] : [0];
  const segs = tier === 'low' ? 6 : 8;
  for (const x of xs) {
    // Omega bracket bar
    out.push(boxPart(0.11, 0.016, 0.04, HardwareAtlasBand.CastAlloy, x, yOffset - dir * 0.008, 0));
    // Half-coupler collar
    out.push(cylPart(0.032, 0.032, 0.038, segs, HardwareAtlasBand.CastAlloy, x, clampY, 0, 0, 0, Math.PI / 2));
    // Wing-bolt latch
    if (tier === 'high') {
      out.push(boxPart(0.014, 0.04, 0.022, HardwareAtlasBand.AnodizedMetal, x, clampY - dir * 0.032, 0.028));
    }
  }
}

function addRubberFeetParts(
  out: THREE.BufferGeometry[],
  w: number,
  d: number,
  dir: 1 | -1,
  tier: RenderTier,
) {
  const fx = Math.max(0.05, w * 0.40);
  const fz = Math.max(0.05, d * 0.40);
  const footH = 0.018;
  for (const sx of [-fx, fx]) {
    for (const sz of [-fz, fz]) {
      if (tier === 'low') {
        out.push(boxPart(0.036, footH, 0.036, HardwareAtlasBand.Rubber, sx, dir * (footH / 2), sz));
      } else {
        out.push(cylPart(0.018, 0.02, footH, 8, HardwareAtlasBand.Rubber, sx, dir * (footH / 2), sz));
      }
    }
  }
}

export interface MovingModelParts {
  spec: ModelSpec;
  yokeY: number;
  headY: number;
  lensOffsetY: number;
  lensShape: { kind: 'circle'; radius: number } | { kind: 'rect'; width: number; height: number };
  baseGeo: THREE.BufferGeometry;
  mountGeo: THREE.BufferGeometry;
  yokeGeo: THREE.BufferGeometry;
  headGeo: THREE.BufferGeometry;
  glassGeo: THREE.BufferGeometry;
}

/** Lens face on the compact cell heads and the barrel or tapered moving heads. */
export function movingZoomLens(spec: ModelSpec) {
  const { kind, len, dia } = spec.head;
  const r = dia / 2;
  if (kind === 'stub-cells') return { offsetY: len * 0.46, radius: r * 0.86 };
  const frontR = kind === 'taper' ? r * 0.90 : r * 0.96;
  return { offsetY: len * 0.47, radius: frontR * 0.82 };
}

export function buildMovingModelParts(
  spec: ModelSpec,
  isFloor: boolean,
  tier: RenderTier,
): MovingModelParts {
  const dir: 1 | -1 = isFloor ? 1 : -1;
  const radialSegs = tier === 'low' ? 8 : 14;
  const footLift = isFloor ? 0.018 : 0;

  // Base housing sits along dir * Y starting from mount root (y = 0)
  const baseParts: THREE.BufferGeometry[] = [];
  const bw = spec.base.w;
  const bh = spec.base.h;
  const bd = spec.base.d;
  const baseCenterY = dir * (footLift + bh / 2);

  baseParts.push(boxPart(bw, bh, bd, HardwareAtlasBand.PowderCoat, 0, baseCenterY, 0));
  // Chamfered top/bottom shoulder collar (high tier or moving heads)
  if (tier === 'high' && spec.family !== 'led-par') {
    baseParts.push(
      boxPart(bw * 0.88, bh * 0.22, bd * 0.88, HardwareAtlasBand.AnodizedMetal, 0, dir * (footLift + bh + bh * 0.06), 0),
    );
  }
  // Symmetric LCD readout on front (+Z) and connector plate on rear (-Z)
  if (spec.base.lcd) {
    baseParts.push(
      boxPart(Math.min(0.18, bw * 0.56), Math.min(0.055, bh * 0.52), 0.008, HardwareAtlasBand.LcdStrip, 0, baseCenterY, bd / 2 + 0.003),
    );
  }
  baseParts.push(
    boxPart(Math.min(0.22, bw * 0.68), Math.min(0.06, bh * 0.58), 0.008, HardwareAtlasBand.ConnectorPlate, 0, baseCenterY, -(bd / 2 + 0.003)),
  );
  // Carry handles
  if (spec.base.handles) {
    const handleDepth = spec.base.handles === 'dual-touring' ? bd * 0.58 : bd * 0.42;
    for (const side of [-1, 1]) {
      baseParts.push(
        boxPart(0.022, 0.024, handleDepth, HardwareAtlasBand.Rubber, side * (bw / 2 + 0.014), baseCenterY, 0),
      );
      if (tier === 'high') {
        for (const end of [-1, 1]) {
          baseParts.push(
            boxPart(0.024, 0.026, 0.024, HardwareAtlasBand.CastAlloy, side * (bw / 2 + 0.006), baseCenterY, end * (handleDepth * 0.44)),
          );
        }
      }
    }
  }

  // Separate clamp (hung) vs rubber feet (floor)
  const mountParts: THREE.BufferGeometry[] = [];
  if (isFloor) {
    addRubberFeetParts(mountParts, bw, bd, dir, tier);
  } else {
    const dual = Boolean(spec.base.dualClamps || bw >= 0.44);
    addClampParts(mountParts, dual, Math.min(0.36, bw * 0.34), dir, tier);
  }

  // Yoke & tilt pivot positioning: guarantee yokeY + headY === spec.pivotY strictly!
  const yokeY = Math.min(spec.pivotY * 0.42, Math.max(footLift + bh, spec.family === 'led-par' ? 0.04 : YOKE_OFFSET));
  const headY = spec.pivotY - yokeY;
  const yokeSpec = spec.yoke ?? { armH: Math.max(0.14, headY + 0.04), armW: 0.05, armD: 0.10, gap: bw * 0.78 };

  const yokeParts: THREE.BufferGeometry[] = [];
  const bridgeH = Math.min(0.042, Math.max(0.022, yokeSpec.armW * 0.65));
  yokeParts.push(
    boxPart(yokeSpec.gap + yokeSpec.armW * 2, bridgeH, yokeSpec.armD, HardwareAtlasBand.AnodizedMetal, 0, dir * (bridgeH / 2), 0),
  );
  const armSpan = Math.max(headY + 0.02, yokeSpec.armH);
  for (const side of [-1, 1]) {
    const ax = side * (yokeSpec.gap / 2 + yokeSpec.armW / 2);
    yokeParts.push(
      boxPart(yokeSpec.armW, armSpan, yokeSpec.armD, HardwareAtlasBand.PowderCoat, ax, dir * (armSpan / 2), 0),
    );
    // Tilt bearing boss / lock knob at exact tilt pivot height (dir * headY)
    if (tier === 'high' || spec.family !== 'led-par') {
      yokeParts.push(
        cylPart(
          yokeSpec.armD * 0.42,
          yokeSpec.armD * 0.42,
          yokeSpec.armW * 1.35,
          tier === 'low' ? 6 : 10,
          HardwareAtlasBand.AnodizedMetal,
          ax,
          dir * headY,
          0,
          0,
          0,
          Math.PI / 2,
        ),
      );
    }
  }

  // Head geometry centered around the tilt axis (0, 0, 0 in head local space; emission face along dir * Y)
  const headParts: THREE.BufferGeometry[] = [];
  const glassParts: THREE.BufferGeometry[] = [];
  const hl = spec.head.len;
  const r = spec.head.dia / 2;
  let lensOffsetY = hl * 0.5;
  let lensShape: MovingModelParts['lensShape'] = { kind: 'circle', radius: r * 0.80 };

  if (spec.head.kind === 'bar-cells') {
    const barW = spec.head.width ?? 0.94;
    const barD = spec.head.dia;
    headParts.push(boxPart(barW, hl * 0.84, barD, HardwareAtlasBand.PowderCoat, 0, -dir * hl * 0.04, 0));
    // Rear heat-sink spine
    headParts.push(boxPart(barW * 0.96, hl * 0.24, barD * 0.82, HardwareAtlasBand.HeatSinkFins, 0, -dir * hl * 0.40, 0));
    // End cheek plates
    for (const side of [-1, 1]) {
      headParts.push(boxPart(0.022, hl * 0.94, barD * 1.08, HardwareAtlasBand.AnodizedMetal, side * (barW / 2 + 0.011), 0, 0));
    }
    // Cell bezel rings on high tier (glossy glass) vs textured cell strip on low tier (mapped onto textured headParts)
    const cellCount = spec.head.cells?.[0] ?? 16;
    if (tier === 'high') {
      const pitch = (barW - 0.06) / cellCount;
      const cellR = Math.min(pitch * 0.42, barD * 0.40);
      for (let c = 0; c < cellCount; c++) {
        const cx = -((cellCount - 1) / 2) * pitch + c * pitch;
        glassParts.push(
          cylPart(cellR, cellR * 0.92, 0.016, 6, HardwareAtlasBand.AnodizedMetal, cx, dir * (hl * 0.41), 0),
        );
      }
    } else {
      headParts.push(boxPart(barW * 0.92, 0.014, barD * 0.72, HardwareAtlasBand.HazardAndCells, 0, dir * (hl * 0.41), 0, 0.52, 0.98));
      glassParts.push(boxPart(barW * 0.94, 0.008, barD * 0.76, HardwareAtlasBand.AnodizedMetal, 0, dir * (hl * 0.39), 0));
    }
    lensOffsetY = hl * 0.43;
    lensShape = { kind: 'rect', width: barW * 0.90, height: barD * 0.62 };
  } else if (spec.head.kind === 'par-can') {
    // Classic finned LED PAR can
    headParts.push(cylPart(r, r * 0.86, hl * 0.84, radialSegs, HardwareAtlasBand.PowderCoat, 0, 0, 0));
    // Rear cooling heat-sink cap
    headParts.push(cylPart(r * 0.84, r * 0.74, hl * 0.24, radialSegs, HardwareAtlasBand.HeatSinkFins, 0, -dir * hl * 0.42, 0));
    // Front gel-frame / lens bezel collar
    glassParts.push(cylPart(r * 1.04, r * 1.02, hl * 0.14, radialSegs, HardwareAtlasBand.AnodizedMetal, 0, dir * hl * 0.44, 0));
    lensOffsetY = hl * 0.51;
    lensShape = { kind: 'circle', radius: r * 0.82 };
  } else if (spec.head.kind === 'stub-cells') {
    // Compact wash head (MAC Aura XB/XIP, Spiider, Rogue R1) with textured multi-cell optic face + glossy bezel rim
    headParts.push(cylPart(isFloor ? r * 1.04 : r * 0.84, isFloor ? r * 0.84 : r * 1.04, hl * 0.86, radialSegs, HardwareAtlasBand.PowderCoat, 0, 0, 0));
    headParts.push(
      cylPart(r * 0.80, r * 0.72, hl * 0.24, radialSegs, spec.head.fins ? HardwareAtlasBand.HeatSinkFins : HardwareAtlasBand.AnodizedMetal, 0, -dir * hl * 0.44, 0),
    );
    // Textured multi-cell baffle face rendered with textured hardwareBody
    headParts.push(cylPart(r * 0.95, r * 0.95, 0.018, radialSegs, HardwareAtlasBand.HazardAndCells, 0, dir * hl * 0.43, 0, 0, 0, 0, 0.52, 0.98));
    // Glossy outer optic trim ring
    glassParts.push(cylPart(r * 1.02, r * 1.00, 0.022, radialSegs, HardwareAtlasBand.AnodizedMetal, 0, dir * hl * 0.44, 0));
    const lens = movingZoomLens(spec);
    lensOffsetY = lens.offsetY;
    lensShape = { kind: 'circle', radius: lens.radius };
  } else if (spec.head.kind === 'snout') {
    // Profile / Followspot head: rear lamp house + tapered optical snout + shutter barrel
    const rearLen = hl * 0.54;
    const snoutLen = hl * 0.46;
    headParts.push(
      boxPart(r * 1.85, rearLen, r * 1.72, spec.head.ip65Fins ? HardwareAtlasBand.HeatSinkFins : HardwareAtlasBand.PowderCoat, 0, -dir * (snoutLen * 0.42), 0),
    );
    headParts.push(
      cylPart(
        isFloor ? r * 0.88 : r * 0.98,
        isFloor ? r * 0.98 : r * 0.88,
        snoutLen,
        radialSegs,
        HardwareAtlasBand.AnodizedMetal,
        0,
        dir * (rearLen * 0.46),
        0,
      ),
    );
    // Side heat-sink louvers on high tier
    if (spec.head.fins && tier === 'high') {
      for (const side of [-1, 1]) {
        headParts.push(
          boxPart(0.026, rearLen * 0.78, r * 1.25, HardwareAtlasBand.HeatSinkFins, side * (r * 0.96), -dir * (snoutLen * 0.40), 0),
        );
      }
    }
    // Followspot rear grab handles & side sight rail
    if (spec.head.rearHandles) {
      const backY = -dir * (hl * 0.50);
      headParts.push(boxPart(r * 2.15, 0.028, 0.028, HardwareAtlasBand.Rubber, 0, backY, 0));
      headParts.push(boxPart(0.022, hl * 0.65, 0.022, HardwareAtlasBand.CastAlloy, r * 1.05, 0, r * 0.55));
    }
    glassParts.push(cylPart(r * 0.86, r * 0.86, 0.024, radialSegs, HardwareAtlasBand.AnodizedMetal, 0, dir * (hl * 0.48), 0));
    lensOffsetY = hl * 0.50;
    lensShape = { kind: 'circle', radius: r * 0.76 };
  } else {
    // 'barrel' or 'taper' beam / spot moving head
    const frontR = spec.head.kind === 'taper' ? r * 0.90 : r * 0.96;
    const backR = spec.head.kind === 'taper' ? r * 1.06 : r * 0.92;
    headParts.push(
      cylPart(isFloor ? frontR : backR, isFloor ? backR : frontR, hl * 0.88, radialSegs, HardwareAtlasBand.PowderCoat, 0, 0, 0),
    );
    if (spec.head.fins) {
      headParts.push(
        cylPart(backR * 0.94, backR * 0.82, hl * 0.24, radialSegs, HardwareAtlasBand.HeatSinkFins, 0, -dir * hl * 0.42, 0),
      );
    }
    // Prominent front collimator bezel
    glassParts.push(cylPart(frontR * 0.96, frontR * 0.98, 0.026, radialSegs, HardwareAtlasBand.AnodizedMetal, 0, dir * hl * 0.45, 0));
    const lens = movingZoomLens(spec);
    lensOffsetY = lens.offsetY;
    lensShape = { kind: 'circle', radius: lens.radius };
  }

  return {
    spec,
    yokeY,
    headY,
    lensOffsetY,
    lensShape,
    baseGeo: mergeNormalized(baseParts),
    mountGeo: mergeNormalized(mountParts),
    yokeGeo: mergeNormalized(yokeParts),
    headGeo: mergeNormalized(headParts),
    glassGeo: mergeNormalized(glassParts),
  };
}

export interface StaticModelParts {
  spec: ModelSpec;
  bodyGeo: THREE.BufferGeometry;
  glassGeo: THREE.BufferGeometry | null;
  /** Vertical offset from body centre to the top of the hung yoke (where the truss clamp grips). */
  mountOffsetY: number;
  lenses: ReadonlyArray<
    | { kind: 'rect'; x: number; y: number; z: number; w: number; h: number }
    | { kind: 'circle'; x: number; y: number; z: number; r: number }
  >;
}

export function buildStaticModelParts(
  spec: ModelSpec,
  isFloor: boolean,
  tier: RenderTier,
): StaticModelParts {
  const bodyParts: THREE.BufferGeometry[] = [];
  const glassParts: THREE.BufferGeometry[] = [];
  const lenses: Array<
    | { kind: 'rect'; x: number; y: number; z: number; w: number; h: number }
    | { kind: 'circle'; x: number; y: number; z: number; r: number }
  > = [];
  let mountOffsetY = 0;
  const segs = tier === 'low' ? 8 : 12;

  switch (spec.family) {
    case 'strobe-panel': {
      const w = spec.head.width ?? 0.42;
      const h = spec.head.len;
      const d = spec.head.dia;
      // Main panel housing + rear heat-sink fins
      bodyParts.push(boxPart(w, h, d, HardwareAtlasBand.PowderCoat, 0, 0, 0));
      bodyParts.push(boxPart(w * 0.92, h * 0.82, 0.032, HardwareAtlasBand.HeatSinkFins, 0, 0, -(d / 2 + 0.014)));
      // Yoke bracket & clamp seated cleanly on top of yoke bar
      const yokeSpan = w + 0.06;
      const yokeCenterY = h / 2 + 0.075;
      const yokeTopY = yokeCenterY + 0.016;
      mountOffsetY = yokeTopY;
      bodyParts.push(boxPart(yokeSpan, 0.032, 0.05, HardwareAtlasBand.AnodizedMetal, 0, yokeCenterY, 0));
      for (const side of [-1, 1]) {
        bodyParts.push(boxPart(0.03, h * 0.55 + 0.075, 0.05, HardwareAtlasBand.AnodizedMetal, side * (yokeSpan / 2 - 0.015), h * 0.25 + 0.03, 0));
      }
      if (!isFloor) addClampParts(bodyParts, Boolean(spec.base.dualClamps), w * 0.30, -1, tier, yokeTopY);

      // Front glass diffuser bezel + strobe tube lens
      glassParts.push(boxPart(w * 0.94, h * 0.88, 0.012, HardwareAtlasBand.AnodizedMetal, 0, 0, d / 2 + 0.004));
      if (spec.head.jdcAuraPlates) {
        // GLP JDC1: prominent central strobe tube + upper/lower RGB aura plates
        lenses.push({ kind: 'rect', x: 0, y: 0, z: d / 2 + 0.013, w: w * 0.86, h: h * 0.22 });
        lenses.push({ kind: 'rect', x: 0, y: h * 0.27, z: d / 2 + 0.012, w: w * 0.86, h: h * 0.24 });
        lenses.push({ kind: 'rect', x: 0, y: -h * 0.27, z: d / 2 + 0.012, w: w * 0.86, h: h * 0.24 });
      } else {
        // Martin Atomic 3000 LED: single deep horizontal reflector tube
        lenses.push({ kind: 'rect', x: 0, y: 0, z: d / 2 + 0.013, w: w * 0.84, h: h * 0.44 });
      }
      break;
    }

    case 'blinder-4lite': {
      const w = spec.head.width ?? 0.44;
      const h = spec.head.len;
      const d = spec.head.dia;
      bodyParts.push(boxPart(w, h, d, HardwareAtlasBand.PowderCoat, 0, 0, 0));
      // Yoke & clamp seated cleanly on top of yoke bar
      const yokeCenterY = h / 2 + 0.07;
      const yokeTopY = yokeCenterY + 0.015;
      mountOffsetY = yokeTopY;
      bodyParts.push(boxPart(w + 0.06, 0.03, 0.05, HardwareAtlasBand.AnodizedMetal, 0, yokeCenterY, 0));
      for (const side of [-1, 1]) {
        bodyParts.push(boxPart(0.028, h * 0.52 + 0.07, 0.05, HardwareAtlasBand.AnodizedMetal, side * (w / 2 + 0.016), h * 0.26 + 0.03, 0));
      }
      if (!isFloor) addClampParts(bodyParts, Boolean(spec.base.dualClamps), w * 0.28, -1, tier, yokeTopY);

      // 2×2 parabolic reflector pods with safety bezels
      const ox = w * 0.24;
      const oy = h * 0.24;
      const podR = Math.min(w, h) * 0.21;
      for (const bx of [-ox, ox]) {
        for (const by of [-oy, oy]) {
          glassParts.push(
            cylPart(podR * 1.06, podR * 0.92, 0.04, segs, HardwareAtlasBand.AnodizedMetal, bx, by, d / 2 + 0.01, Math.PI / 2, 0, 0),
          );
          lenses.push({ kind: 'circle', x: bx, y: by, z: d / 2 + 0.032, r: podR * 0.86 });
        }
      }
      break;
    }

    case 'laser-head': {
      const w = spec.base.w;
      const h = spec.base.h;
      const d = spec.base.d;
      bodyParts.push(boxPart(w, h, d, HardwareAtlasBand.PowderCoat, 0, 0, 0));
      // Side extruded heat-sink fins on high-power (>= 10 W) lasers
      if (spec.head.fins) {
        for (const side of [-1, 1]) {
          bodyParts.push(boxPart(0.022, h * 0.78, d * 0.84, HardwareAtlasBand.HeatSinkFins, side * (w / 2 + 0.010), 0, 0));
        }
      }
      // Touring carry handles on heavier (>= 20 W) chassis
      if (spec.base.handles === 'dual-touring') {
        for (const side of [-1, 1]) {
          bodyParts.push(boxPart(0.024, 0.036, d * 0.36, HardwareAtlasBand.Rubber, side * (w / 2 + 0.026), h * 0.14, 0));
        }
      }
      // Front optical bezel + IEC laser hazard stripe
      bodyParts.push(boxPart(w * 0.92, h * 0.84, 0.025, HardwareAtlasBand.AnodizedMetal, 0, 0, d / 2 + 0.010));
      bodyParts.push(
        boxPart(w + 0.012, 0.026, d * 0.78, HardwareAtlasBand.HazardAndCells, 0, h / 2 - 0.024, 0, 0.02, 0.48),
      );
      // Rear interlock / ILDA / DMX connector bay
      bodyParts.push(boxPart(w * 0.74, h * 0.56, 0.010, HardwareAtlasBand.ConnectorPlate, 0, 0, -(d / 2 + 0.005)));
      // Hung yoke & clamp seated cleanly on top of yoke bar vs floor rubber feet
      if (!isFloor) {
        const yokeCenterY = h / 2 + 0.08;
        const yokeTopY = yokeCenterY + 0.014;
        mountOffsetY = yokeTopY;
        bodyParts.push(boxPart(w + 0.08, 0.028, 0.05, HardwareAtlasBand.AnodizedMetal, 0, yokeCenterY, 0));
        for (const side of [-1, 1]) {
          bodyParts.push(boxPart(0.028, h * 0.52 + 0.08, 0.05, HardwareAtlasBand.AnodizedMetal, side * (w / 2 + 0.028), h * 0.26 + 0.04, 0));
        }
        addClampParts(bodyParts, Boolean(spec.base.dualClamps), w * 0.28, -1, tier, yokeTopY);
      } else {
        // Rubber feet sit below -h/2
        const fx = w * 0.38;
        const fz = d * 0.38;
        for (const sx of [-fx, fx]) {
          for (const sz of [-fz, fz]) {
            bodyParts.push(cylPart(0.02, 0.022, 0.02, 6, HardwareAtlasBand.Rubber, sx, -(h / 2 + 0.01), sz));
          }
        }
      }
      const apW = Math.min(0.18, w * 0.58);
      const apH = Math.min(0.072, h * 0.42);
      glassParts.push(boxPart(apW, apH, 0.016, HardwareAtlasBand.AnodizedMetal, 0, 0, d / 2 + 0.024));
      lenses.push({ kind: 'rect', x: 0, y: 0, z: d / 2 + 0.034, w: apW * 0.84, h: apH * 0.72 });
      break;
    }

    case 'hazer-box': {
      const w = spec.base.w;
      const h = spec.base.h;
      const d = spec.base.d;
      const lift = 0.022;
      // Flight-case / touring rack chassis
      bodyParts.push(boxPart(w, h, d, HardwareAtlasBand.PowderCoat, 0, lift + h / 2, 0));
      // Aluminium extrusion edge trim around top & bottom
      bodyParts.push(boxPart(w + 0.02, 0.032, d + 0.02, HardwareAtlasBand.CastAlloy, 0, lift + h - 0.016, 0));
      bodyParts.push(boxPart(w + 0.02, 0.024, d + 0.02, HardwareAtlasBand.CastAlloy, 0, lift + 0.012, 0));
      // Front haze output nozzle + protective grille
      bodyParts.push(cylPart(0.055, 0.062, 0.07, segs, HardwareAtlasBand.CastAlloy, -w * 0.16, lift + h * 0.56, d / 2 + 0.025, Math.PI / 2, 0, 0));
      bodyParts.push(boxPart(w * 0.38, h * 0.44, 0.012, HardwareAtlasBand.HeatSinkFins, w * 0.18, lift + h * 0.50, d / 2 + 0.004));
      // Rear control/DMX plate + side carry handles + feet
      bodyParts.push(boxPart(w * 0.68, h * 0.34, 0.010, HardwareAtlasBand.ConnectorPlate, 0, lift + h * 0.48, -(d / 2 + 0.004)));
      if (spec.base.handles) {
        for (const side of [-1, 1]) {
          bodyParts.push(boxPart(0.026, 0.04, d * 0.32, HardwareAtlasBand.Rubber, side * (w / 2 + 0.016), lift + h * 0.58, 0));
        }
      }
      addRubberFeetParts(bodyParts, w, d, 1, tier);
      break;
    }

    case 'fogger-box': {
      const w = spec.base.w;
      const h = spec.base.h;
      const d = spec.base.d;
      const lift = 0.02;
      bodyParts.push(boxPart(w, h, d, HardwareAtlasBand.PowderCoat, 0, lift + h / 2, 0));
      // Recessed fluid tank bay on rear half
      bodyParts.push(boxPart(w * 0.72, h * 0.62, d * 0.34, HardwareAtlasBand.AnodizedMetal, 0, lift + h * 0.60, -d * 0.24));
      // Top carry handle
      bodyParts.push(boxPart(0.026, 0.024, d * 0.42, HardwareAtlasBand.Rubber, 0, lift + h + 0.055, 0.04));
      for (const ez of [-d * 0.19, d * 0.19]) {
        bodyParts.push(boxPart(0.028, 0.055, 0.026, HardwareAtlasBand.CastAlloy, 0, lift + h + 0.028, 0.04 + ez));
      }
      // Angled front heat-exchanger nozzle
      bodyParts.push(cylPart(0.048, 0.068, 0.15, segs, HardwareAtlasBand.CastAlloy, 0, lift + h * 0.64, d / 2 + 0.05, Math.PI / 2 - 0.28, 0, 0));
      bodyParts.push(boxPart(w * 0.62, h * 0.36, 0.010, HardwareAtlasBand.ConnectorPlate, 0, lift + h * 0.42, -(d / 2 + 0.004)));
      addRubberFeetParts(bodyParts, w, d, 1, tier);
      break;
    }

    case 'co2-jet':
    default: {
      const w = spec.base.w;
      const h = spec.base.h;
      const d = spec.base.d;
      // Heavy steel base plate with mounting tabs + rubber feet
      bodyParts.push(boxPart(w + 0.04, 0.018, d + 0.04, HardwareAtlasBand.AnodizedMetal, 0, 0.018, 0));
      bodyParts.push(boxPart(w * 0.85, h, d * 0.82, HardwareAtlasBand.PowderCoat, 0, 0.026 + h / 2, 0));
      // Swivel yoke cheeks
      for (const side of [-1, 1]) {
        bodyParts.push(boxPart(0.018, 0.14, 0.055, HardwareAtlasBand.CastAlloy, side * 0.065, 0.14, 0.02));
      }
      // High-pressure quick-lock hose fitting at rear
      bodyParts.push(cylPart(0.018, 0.018, 0.07, 6, HardwareAtlasBand.CastAlloy, 0, 0.065, -(d * 0.48), Math.PI / 2, 0, 0));
      // Cryo nozzle barrel (silenced alloy shroud + inner stainless nozzle)
      bodyParts.push(cylPart(0.044, 0.052, 0.28, segs, HardwareAtlasBand.CastAlloy, 0, 0.26, 0.03, 0.08, 0, 0));
      bodyParts.push(cylPart(0.050, 0.050, 0.04, segs, HardwareAtlasBand.AnodizedMetal, 0, 0.39, 0.042, 0.08, 0, 0));
      addRubberFeetParts(bodyParts, w, d, 1, tier);
      break;
    }
  }

  return {
    spec,
    bodyGeo: mergeNormalized(bodyParts),
    glassGeo: glassParts.length ? mergeNormalized(glassParts) : null,
    mountOffsetY,
    lenses,
  };
}

/**
 * Build one merged LED video cabinet rear tile geometry (for GPU InstancedMesh across a wall).
 * Stays within <= 150 triangles (high tier) and <= 60 triangles (low tier).
 * Origin sits at the tile centre on the front face (Z = 0); geometry extends behind into -Z.
 */
export function buildLedCabinetBackGeometry(
  widthM: number,
  heightM: number,
  tier: RenderTier,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const depth = 0.085;
  const rail = Math.max(0.022, Math.min(0.045, Math.min(widthM, heightM) * 0.07));
  const zBack = -depth / 2;

  // Perimeter frame (4 bars = 48 tris)
  parts.push(boxPart(widthM - 0.004, rail, depth, HardwareAtlasBand.AnodizedMetal, 0, heightM / 2 - rail / 2, zBack));
  parts.push(boxPart(widthM - 0.004, rail, depth, HardwareAtlasBand.AnodizedMetal, 0, -heightM / 2 + rail / 2, zBack));
  parts.push(boxPart(rail, heightM - rail * 2, depth, HardwareAtlasBand.AnodizedMetal, -widthM / 2 + rail / 2, 0, zBack));
  parts.push(boxPart(rail, heightM - rail * 2, depth, HardwareAtlasBand.AnodizedMetal, widthM / 2 - rail / 2, 0, zBack));

  // Center PSU & receiving-card electronics box (12 tris) -> total 60 tris on low tier!
  const psuW = Math.min(0.24, widthM * 0.44);
  const psuH = Math.min(0.32, heightM * 0.44);
  parts.push(boxPart(psuW, psuH, depth * 0.72, HardwareAtlasBand.PowderCoat, 0, 0, -depth * 0.56));

  if (tier === 'high') {
    // Horizontal & vertical internal carbon-frame cross ribs (24 tris)
    parts.push(boxPart(widthM - rail * 2, rail * 0.65, depth * 0.42, HardwareAtlasBand.PowderCoat, 0, 0, -depth * 0.25));
    parts.push(boxPart(rail * 0.65, heightM - rail * 2, depth * 0.42, HardwareAtlasBand.PowderCoat, 0, 0, -depth * 0.25));
    // Rear power/data connector plate on PSU box (12 tris)
    parts.push(boxPart(psuW * 0.72, psuH * 0.34, 0.010, HardwareAtlasBand.ConnectorPlate, 0, -psuH * 0.22, -(depth * 0.94)));
    // Top/side rigging handles (24 tris)
    parts.push(boxPart(psuW * 0.65, 0.018, 0.024, HardwareAtlasBand.Rubber, 0, heightM * 0.34, -(depth * 0.85)));
    parts.push(boxPart(0.018, psuH * 0.55, 0.024, HardwareAtlasBand.Rubber, -widthM * 0.34, 0, -(depth * 0.85)));
    // Top & right quick-lock cam latches (24 tris) -> grand total 144 tris <= 150!
    parts.push(boxPart(0.036, 0.024, 0.026, HardwareAtlasBand.CastAlloy, -widthM * 0.25, heightM / 2 - 0.012, -(depth * 0.78)));
    parts.push(boxPart(0.024, 0.036, 0.026, HardwareAtlasBand.CastAlloy, widthM / 2 - 0.012, heightM * 0.22, -(depth * 0.78)));
  }

  return mergeNormalized(parts);
}

/**
 * Shared geometry cache per StageEngine instance so repeated fixtures reuse identical BufferGeometries
 * across rebuilds without premature disposal in releaseGroup().
 */
export class FixtureModelCache {
  private moving = new Map<string, MovingModelParts>();
  private staticModels = new Map<string, StaticModelParts>();
  private cabinetBacks = new Map<string, THREE.BufferGeometry>();
  private activeCabinetKeys: Set<string> | null = null;
  public readonly sharedResources = new WeakSet<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  private readonly tier: RenderTier;

  constructor(tier: RenderTier = 'high') {
    this.tier = tier;
  }

  public getTier(): RenderTier {
    return this.tier;
  }

  public get cabinetBackCount(): number {
    return this.cabinetBacks.size;
  }

  public beginRebuild() {
    this.activeCabinetKeys = new Set();
  }

  public endRebuild() {
    const active = this.activeCabinetKeys;
    this.activeCabinetKeys = null;
    if (!active) return;
    for (const [key, geo] of this.cabinetBacks) {
      if (!active.has(key)) {
        geo.dispose();
        this.cabinetBacks.delete(key);
      }
    }
  }

  public register<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(resource: T): T {
    this.sharedResources.add(resource);
    return resource;
  }

  public getMoving(type: HardwareType, catalogId: string | undefined, isFloor: boolean): MovingModelParts {
    const spec = resolveModelSpec(type, catalogId);
    const key = `${spec.id}|${spec.motion}|${isFloor ? 1 : 0}|${this.tier}`;
    let entry = this.moving.get(key);
    if (!entry) {
      entry = buildMovingModelParts(spec, isFloor, this.tier);
      this.sharedResources.add(entry.baseGeo);
      this.sharedResources.add(entry.mountGeo);
      this.sharedResources.add(entry.yokeGeo);
      this.sharedResources.add(entry.headGeo);
      this.sharedResources.add(entry.glassGeo);
      this.moving.set(key, entry);
    }
    return entry;
  }

  public getStatic(type: HardwareType, catalogId: string | undefined, isFloor: boolean): StaticModelParts {
    const spec = resolveModelSpec(type, catalogId);
    const key = `${spec.id}|${isFloor ? 1 : 0}|${this.tier}`;
    let entry = this.staticModels.get(key);
    if (!entry) {
      entry = buildStaticModelParts(spec, isFloor, this.tier);
      this.sharedResources.add(entry.bodyGeo);
      if (entry.glassGeo) this.sharedResources.add(entry.glassGeo);
      this.staticModels.set(key, entry);
    }
    return entry;
  }

  public getLedCabinetBack(widthM: number, heightM: number): THREE.BufferGeometry {
    const key = `${Math.round(widthM * 1000)}x${Math.round(heightM * 1000)}|${this.tier}`;
    this.activeCabinetKeys?.add(key);
    let geo = this.cabinetBacks.get(key);
    if (!geo) {
      geo = buildLedCabinetBackGeometry(widthM, heightM, this.tier);
      this.sharedResources.add(geo);
      this.cabinetBacks.set(key, geo);
    }
    return geo;
  }

  public forEachGeometry(visit: (geometry: THREE.BufferGeometry) => void): void {
    for (const entry of this.moving.values()) {
      visit(entry.baseGeo);
      visit(entry.mountGeo);
      visit(entry.yokeGeo);
      visit(entry.headGeo);
      visit(entry.glassGeo);
    }
    for (const entry of this.staticModels.values()) {
      visit(entry.bodyGeo);
      if (entry.glassGeo) visit(entry.glassGeo);
    }
    this.cabinetBacks.forEach(visit);
  }

  public dispose() {
    this.forEachGeometry(geometry => geometry.dispose());
    this.moving.clear();
    this.staticModels.clear();
    this.cabinetBacks.clear();
    this.activeCabinetKeys = null;
  }
}

/** Verify every catalogId resolves cleanly (either directly in MODEL_SPECS or via its body-family default). */
export function hasModelSpecForCatalogId(id: string): boolean {
  const entry = getCatalogEntry(id);
  if (!entry) return false;
  if (Object.hasOwn(MODEL_SPECS, id)) return true;
  const familyModelId = FAMILY_DEFAULT_MODEL_ID[entry.body];
  return Boolean(familyModelId && Object.hasOwn(MODEL_SPECS, familyModelId));
}
