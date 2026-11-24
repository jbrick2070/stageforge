import type { TrussShape } from '../types/show';

/** Kilograms to pounds conversion factor (shared with productionEstimator.ts). */
export const RIG_KG_TO_LBS = 2.20462;

/** Pattern for valid Show v7 trussProfileId / hoistId values (matches catalogId rules). */
export const RIG_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Pattern for valid Show v7 circuitGroup labels (1..32 chars, safe printable ASCII). */
export const CIRCUIT_GROUP_PATTERN = /^[A-Za-z0-9 _.-]{1,32}$/;

export interface TrussSpanPoint {
  spanM: number;
  /** Allowable uniformly distributed load in kg/m (payload if tableIncludesSelfWeight). */
  udlKgPerM: number;
  /** Allowable center point load in kg, when verified for this span. */
  cplKg?: number;
}

export interface TrussProfile {
  id: string;
  manufacturer: string;
  model: string;
  /** Outer section width/height in mm. */
  outerWidthMm: number;
  outerHeightMm: number;
  /** Main chord center-to-center spacing in mm (drives 3D truss height). */
  centerToCenterMm: number;
  /** Main chord tube outer diameter in mm. */
  chordOdMm: number;
  /** Main chord wall thickness in mm. */
  wallMm: number;
  /** Diagonal brace outer diameter in mm. */
  braceOdMm: number;
  /** Truss self-weight in kg/m. */
  kgPerMeter: number;
  /** True when the manufacturer span table gives net allowable payload (truss self-weight already deducted). */
  tableDeductsSelfWeight: boolean;
  /** Published static simple-span load table sorted ascending by spanM. */
  spanTable: readonly TrussSpanPoint[];
  /** Published maximum cantilever overhang in metres (if verified). */
  maxCantileverM?: number;
  /** Fields whose values could not be verified from primary datasheets. */
  unverified: readonly string[];
  /** Source identifiers documented in docs/rigging-power.md. */
  sources: readonly string[];
}

export type HoistSafetyClass = 'D8' | 'D8+' | 'deadhang';

export interface HoistProfile {
  id: string;
  manufacturer: string;
  model: string;
  /** Nominal Working Load Limit in kg. */
  wllKg: number;
  /** Hoist body weight excluding load chain in kg (or hardware weight for dead-hang). */
  bodyKg: number;
  /** Load chain (or steel) weight per metre of drop in kg/m. */
  chainKgPerM: number;
  /** Nominal motor electrical power in watts (0 for dead-hang). */
  motorW: number;
  /** Nominal lifting speed in m/min (0 for dead-hang). */
  liftMPerMin: number;
  /** IGVW SQP2 / DGUV V17 classification. */
  safetyClass: HoistSafetyClass;
  /** Fields whose values could not be verified from primary datasheets. */
  unverified: readonly string[];
  /** Source identifiers documented in docs/rigging-power.md. */
  sources: readonly string[];
}

/**
 * Curated touring truss profiles sourced from published manufacturer datasheets.
 * See docs/rigging-power.md for citations and standard conversion notes (Eurocode vs ANSI E1.2).
 */
export const TRUSS_PROFILES: readonly TrussProfile[] = [
  {
    id: 'prolyte-h30v',
    manufacturer: 'Prolyte',
    model: 'H30V (29 cm box)',
    outerWidthMm: 287,
    outerHeightMm: 287,
    centerToCenterMm: 239,
    chordOdMm: 48,
    wallMm: 3,
    braceOdMm: 16,
    kgPerMeter: 7.0,
    tableDeductsSelfWeight: true,
    spanTable: [
      { spanM: 4, udlKgPerM: 491.3, cplKg: 1298.1 },
      { spanM: 6, udlKgPerM: 318.1, cplKg: 914.4 },
      { spanM: 8, udlKgPerM: 176.2, cplKg: 700.6 },
      { spanM: 10, udlKgPerM: 110.5, cplKg: 563.2 },
      { spanM: 12, udlKgPerM: 74.8, cplKg: 466.5 },
    ],
    unverified: ['maxCantileverM'],
    sources: ['prolyte-h30v'],
  },
  {
    id: 'prolyte-h40v',
    manufacturer: 'Prolyte',
    model: 'H40V (39 cm HD box)',
    outerWidthMm: 387,
    outerHeightMm: 387,
    centerToCenterMm: 339,
    chordOdMm: 48,
    wallMm: 3,
    braceOdMm: 20,
    kgPerMeter: 8.1,
    tableDeductsSelfWeight: true,
    spanTable: [
      { spanM: 6, udlKgPerM: 414.6, cplKg: 1234.4 },
      { spanM: 8, udlKgPerM: 277.5, cplKg: 959.8 },
      { spanM: 10, udlKgPerM: 175.4, cplKg: 780.4 },
      { spanM: 12, udlKgPerM: 119.9, cplKg: 653.1 },
      { spanM: 16, udlKgPerM: 64.7, cplKg: 482.5 },
      { spanM: 18, udlKgPerM: 49.8 },
    ],
    unverified: ['maxCantileverM'],
    sources: ['prolyte-h40v'],
  },
  {
    id: 'eurotruss-fd34',
    manufacturer: 'Eurotruss',
    model: 'FD34 (29 cm box)',
    outerWidthMm: 290,
    outerHeightMm: 290,
    centerToCenterMm: 240,
    chordOdMm: 50,
    wallMm: 2,
    braceOdMm: 20,
    kgPerMeter: 6.0,
    tableDeductsSelfWeight: true,
    spanTable: [
      { spanM: 4, udlKgPerM: 460, cplKg: 950 },
      { spanM: 6, udlKgPerM: 224, cplKg: 670 },
      { spanM: 8, udlKgPerM: 124, cplKg: 497 },
      { spanM: 10, udlKgPerM: 80, cplKg: 385 },
      { spanM: 12, udlKgPerM: 55, cplKg: 331 },
    ],
    unverified: ['maxCantileverM'],
    sources: ['eurotruss-fd34'],
  },
  {
    id: 'tomcat-12x12',
    manufacturer: 'Tomcat',
    model: '12"×12" Plated Box (LD)',
    outerWidthMm: 305,
    outerHeightMm: 305,
    centerToCenterMm: 254,
    chordOdMm: 50.8,
    wallMm: 3.18,
    braceOdMm: 25.4,
    kgPerMeter: 9.23,
    tableDeductsSelfWeight: true,
    spanTable: [
      { spanM: 3.05, udlKgPerM: 778.3, cplKg: 1185.2 },
      { spanM: 6.10, udlKgPerM: 187.5, cplKg: 572.0 },
      { spanM: 9.14, udlKgPerM: 64.0, cplKg: 294.8 },
      { spanM: 12.19, udlKgPerM: 31.3, cplKg: 193.2 },
    ],
    unverified: ['maxCantileverM'],
    sources: ['tomcat-12x12'],
  },
  {
    id: 'tomcat-20-5x20-5',
    manufacturer: 'Tomcat',
    model: '20.5"×20.5" Plated Box (MD)',
    outerWidthMm: 521,
    outerHeightMm: 521,
    centerToCenterMm: 470,
    chordOdMm: 50.8,
    wallMm: 3.18,
    braceOdMm: 25.4,
    kgPerMeter: 12.65,
    tableDeductsSelfWeight: true,
    spanTable: [
      { spanM: 3.05, udlKgPerM: 1293.2, cplKg: 3090.8 },
      { spanM: 6.10, udlKgPerM: 497.0, cplKg: 1516.4 },
      { spanM: 9.14, udlKgPerM: 214.3, cplKg: 978.9 },
      { spanM: 12.19, udlKgPerM: 114.6, cplKg: 700.3 },
      { spanM: 15.24, udlKgPerM: 68.5, cplKg: 525.7 },
      { spanM: 18.29, udlKgPerM: 44.6, cplKg: 402.8 },
      { spanM: 21.34, udlKgPerM: 28.3 },
    ],
    unverified: ['maxCantileverM'],
    sources: ['tomcat-20-5x20-5'],
  },
];

/**
 * Legacy generic truss matching existing productionEstimator (30 lb/m) and geometryBuilders (0.48 m chord spacing).
 */
export const LEGACY_TRUSS_PROFILE: TrussProfile = {
  id: 'legacy-generic',
  manufacturer: 'Generic',
  model: '20.5" touring truss (legacy)',
  outerWidthMm: 520,
  outerHeightMm: 520,
  centerToCenterMm: 480,
  chordOdMm: 76,
  wallMm: 3,
  braceOdMm: 46,
  kgPerMeter: 30 / RIG_KG_TO_LBS,
  tableDeductsSelfWeight: true,
  spanTable: [],
  unverified: ['kgPerMeter', 'spanTable', 'maxCantileverM'],
  sources: ['stageforge-legacy'],
};

/**
 * Curated entertainment chain hoists & dead-hang hardware sourced from published manufacturer specs.
 */
export const HOIST_PROFILES: readonly HoistProfile[] = [
  {
    id: 'cm-lodestar-05t',
    manufacturer: 'CM',
    model: 'Lodestar Model F (½-Ton / 500 kg)',
    wllKg: 500,
    bodyKg: 16.3,
    chainKgPerM: 0.89,
    motorW: 750,
    liftMPerMin: 4.88,
    safetyClass: 'D8',
    unverified: ['chainKgPerM'],
    sources: ['cm-lodestar'],
  },
  {
    id: 'cm-lodestar-1t',
    manufacturer: 'CM',
    model: 'Lodestar Model L (1-Ton / 1,000 kg)',
    wllKg: 1000,
    bodyKg: 27.2,
    chainKgPerM: 1.4,
    motorW: 1500,
    liftMPerMin: 4.88,
    safetyClass: 'D8',
    unverified: ['chainKgPerM'],
    sources: ['cm-lodestar'],
  },
  {
    id: 'cm-lodestar-2t',
    manufacturer: 'CM',
    model: 'Lodestar Model R (2-Ton / 2,000 kg)',
    wllKg: 2000,
    bodyKg: 56.7,
    chainKgPerM: 2.8,
    motorW: 1500,
    liftMPerMin: 2.44,
    safetyClass: 'D8',
    unverified: ['chainKgPerM'],
    sources: ['cm-lodestar'],
  },
  {
    id: 'chainmaster-d8plus-500',
    manufacturer: 'ChainMaster',
    model: 'D8Plus 500 kg',
    wllKg: 500,
    bodyKg: 17.0,
    chainKgPerM: 0.59,
    motorW: 700,
    liftMPerMin: 4.0,
    safetyClass: 'D8+',
    unverified: [],
    sources: ['chainmaster-d8plus'],
  },
  {
    id: 'chainmaster-d8plus-1000',
    manufacturer: 'ChainMaster',
    model: 'D8Plus 1000 kg',
    wllKg: 1000,
    bodyKg: 31.0,
    chainKgPerM: 1.3,
    motorW: 1100,
    liftMPerMin: 4.0,
    safetyClass: 'D8+',
    unverified: [],
    sources: ['chainmaster-d8plus'],
  },
  {
    id: 'dead-hang-1t',
    manufacturer: 'Rigging Hardware',
    model: 'Dead Hang (1-Ton Steel + Shackle)',
    wllKg: 1000,
    bodyKg: 3.5,
    chainKgPerM: 0.4,
    motorW: 0,
    liftMPerMin: 0,
    safetyClass: 'deadhang',
    unverified: ['bodyKg', 'chainKgPerM'],
    sources: ['rigging-practice'],
  },
];

/**
 * Legacy generic hoist matching existing productionEstimator (124 lb total, 1500 W).
 */
export const LEGACY_HOIST_PROFILE: HoistProfile = {
  id: 'legacy-generic',
  manufacturer: 'Generic',
  model: '1-Ton Chain Hoist (legacy)',
  wllKg: 1000,
  bodyKg: 124 / RIG_KG_TO_LBS,
  chainKgPerM: 0,
  motorW: 1500,
  liftMPerMin: 4.88,
  safetyClass: 'D8',
  unverified: ['bodyKg', 'chainKgPerM', 'motorW'],
  sources: ['stageforge-legacy'],
};

const TRUSS_BY_ID = new Map<string, TrussProfile>(TRUSS_PROFILES.map((p) => [p.id, p]));
const HOIST_BY_ID = new Map<string, HoistProfile>(HOIST_PROFILES.map((h) => [h.id, h]));

export function getTrussProfile(id?: string): TrussProfile | undefined {
  return id ? TRUSS_BY_ID.get(id) : undefined;
}

export function getHoistProfile(id?: string): HoistProfile | undefined {
  return id ? HOIST_BY_ID.get(id) : undefined;
}

export function trussDisplayName(profile: TrussProfile): string {
  return `${profile.manufacturer} ${profile.model}`;
}

export function hoistDisplayName(hoist: HoistProfile): string {
  return `${hoist.manufacturer} ${hoist.model}`;
}

/**
 * Local chord half-height in metres.
 * Returns exact legacy `0.24` (or `min(0.24, width * 0.14)` for circle) when no known profile is set.
 */
export function trussHalfHeight(profileId?: string, shape?: TrussShape, width?: number): number {
  const profile = getTrussProfile(profileId);
  if (!profile) {
    return shape === 'circle' && width !== undefined ? Math.min(0.24, width * 0.14) : 0.24;
  }
  const base = profile.centerToCenterMm / 2000;
  return shape === 'circle' && width !== undefined ? Math.min(base, width * 0.14) : base;
}

/**
 * Main chord tube radius in metres. Returns exact legacy `0.038` when no known profile is set.
 */
export function trussChordRadius(profileId?: string): number {
  const profile = getTrussProfile(profileId);
  return profile ? profile.chordOdMm / 2000 : 0.038;
}

/**
 * Diagonal brace tube radius in metres. Returns exact legacy `0.023` when no known profile is set.
 */
export function trussBraceRadius(profileId?: string): number {
  const profile = getTrussProfile(profileId);
  return profile ? profile.braceOdMm / 2000 : 0.023;
}

/**
 * Underside fixture mount Y offset in the truss's local frame.
 * IMPORTANT: when no known profile is set, returns exact legacy literal `-0.28`
 * (avoiding IEEE-754 `-(0.24 + 0.04) === -0.27999999999999997` snapshot drift).
 */
export function trussMountY(profileId?: string, shape?: TrussShape, width?: number): number {
  const profile = getTrussProfile(profileId);
  if (!profile) {
    if (shape === 'circle' && width !== undefined) {
      return -Math.min(0.24, width * 0.14) - 0.04;
    }
    return -0.28;
  }
  return -(trussHalfHeight(profileId, shape, width) + trussChordRadius(profileId));
}

/**
 * Hoist anchor Y offset above truss center in metres.
 * Returns exact legacy `hSize + 0.05` (0.29 for non-circle) when no known profile is set.
 */
export function trussAnchorY(profileId?: string, shape?: TrussShape, width?: number): number {
  const profile = getTrussProfile(profileId);
  if (!profile) {
    if (shape === 'path') return 0.29;
    return trussHalfHeight(undefined, shape, width) + 0.05;
  }
  return trussHalfHeight(profileId, shape, width) + trussChordRadius(profileId) + 0.012;
}
