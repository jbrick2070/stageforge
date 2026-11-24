import type { FixtureType, MountedFixtureGroup, PlanPoint, RigConfig, TrussPodConfig } from '../types/show';
import { getCatalogEntry, isFieldUnverified } from './equipmentCatalog';
import { hungUnits, mountSlotIndex } from './fixturePlacement';
import { hoistPoints } from './hoistPoints';
import {
  getHoistProfile,
  getTrussProfile,
  hoistDisplayName,
  LEGACY_HOIST_PROFILE,
  LEGACY_TRUSS_PROFILE,
  RIG_KG_TO_LBS,
  trussDisplayName,
  type HoistProfile,
  type TrussProfile,
} from './rigCatalog';
import { pathLength } from './stageDesign';
import { GRID_HEIGHT, ledPlacement } from './stageEquipment';
import type { NativeStage } from './showFile';
import { authoredWallFrames, authoredWallSurface, resolveStudioGeometry } from './studioGeometry';
import { trussMounts } from './trussMounts';

export const RIGGING_DISCLAIMER =
  'Simplified static guidance only — not structural engineering sign-off. Always verify spans, bridles, dynamic loads, and roof steel with a qualified rigger.';

/** Per-fixture clamp + safety bond allowance in kg (marked estimated). */
export const CLAMP_ALLOWANCE_KG = 1.0;

/** Cable loom allowance as a fraction of fixture weight (+10%, named explicitly). */
export const CABLE_ALLOWANCE_FRACTION = 0.1;

/** Dynamic multiplier shown separately for motorized kinetic pods. */
export const KINETIC_DYNAMIC_FACTOR = 1.2;

/** Caution and overload utilization thresholds (exact boundaries). */
export const RIG_CAUTION_THRESHOLD = 0.8;
export const RIG_OVERLOAD_THRESHOLD = 1.0;

/** Over-people static derate factor for single-brake D8 hoists (IGVW SQP2 / DGUV V17 guidance). */
export const D8_OVER_PEOPLE_FACTOR = 0.5;

/** Legacy per-type fixture weight allowances in lb (matching productionEstimator.ts). */
const LEGACY_FIXTURE_WEIGHT_LBS: Record<FixtureType, number> = {
  beam: 44,
  wash: 28,
  strobe: 26,
  blinder: 24,
  laser: 32,
};

export type LoadStatus = 'ok' | 'caution' | 'overload' | 'uplift' | 'unknown';

export type SolverKind =
  | 'continuous-beam'
  | 'moment-balance'
  | 'approximate-chevron'
  | 'approximate-path'
  | 'approximate-circle';

export interface BeamPointLoad {
  x: number;
  loadKg: number;
}

export interface ContinuousBeamResult {
  /** Support reactions in kg, ordered matching sorted support positions (negative = uplift). */
  reactionsKg: number[];
  /** Maximum absolute bending moment (kg·m) within each span [supports[i], supports[i+1]]. */
  spanMaxMomentsKgM: number[];
}

/** Solve A * x = b (small dense n x n system, n <= 8) via Gaussian elimination with partial pivoting. */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(a[r][col]);
      if (v > pivotAbs) {
        pivotAbs = v;
        pivotRow = r;
      }
    }
    if (pivotAbs < 1e-12) {
      throw new Error('Continuous-beam stiffness matrix is singular (coincident or degenerate support spacing).');
    }
    if (pivotRow !== col) {
      const tmp = a[col];
      a[col] = a[pivotRow];
      a[pivotRow] = tmp;
    }
    const diag = a[col][col];
    for (let r = col + 1; r < n; r++) {
      const factor = a[r][col] / diag;
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = a[r][n];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = sum / a[r][r];
  }
  return x;
}

/** Downward deflection (EI = 1) at u in [0, S] of a simply-supported beam on [0, S] under a downward point load P at c. */
function simpleBeamPointDeflection(S: number, u: number, c: number, P: number): number {
  if (P === 0 || S <= 0) return 0;
  if (c < 0) {
    // Left overhang e = -c creates hogging moment M0 = P * e at u = 0 (lifts span upward => negative downward deflection).
    const e = -c;
    return -(P * e * u * (S - u) * (2 * S - u)) / (6 * S);
  }
  if (c > S) {
    // Right overhang e = c - S creates hogging moment MS = P * e at u = S.
    const e = c - S;
    return -(P * e * (S - u) * u * (S + u)) / (6 * S);
  }
  const a = c;
  const b = S - c;
  if (u <= a) {
    return (P * b * u * (S * S - b * b - u * u)) / (6 * S);
  }
  const su = S - u;
  return (P * a * su * (S * S - a * a - su * su)) / (6 * S);
}

/** Downward deflection (EI = 1) at u in [0, S] under uniform load w over [beamStart, beamEnd] relative to supports [s0, sLast]. */
function simpleBeamUniformDeflection(
  s0: number,
  S: number,
  u: number,
  beamStart: number,
  beamEnd: number,
  wKgPerM: number,
): number {
  if (wKgPerM === 0 || S <= 0) return 0;
  let d = 0;
  // Interior uniform load across [s0, s0 + S] (clamped to beam extent).
  const intStart = Math.max(beamStart, s0);
  const intEnd = Math.min(beamEnd, s0 + S);
  if (intEnd > intStart) {
    // For full-span uniform load (always true since hoists lie inside [-L/2, L/2]): exact closed form.
    if (Math.abs(intStart - s0) < 1e-9 && Math.abs(intEnd - (s0 + S)) < 1e-9) {
      d += (wKgPerM * u * (S * S * S - 2 * S * u * u + u * u * u)) / 24;
    } else {
      // General fallback via midpoint quadrature for partial interior UDL.
      const steps = 32;
      const dx = (intEnd - intStart) / steps;
      const p = wKgPerM * dx;
      for (let i = 0; i < steps; i++) {
        d += simpleBeamPointDeflection(S, u, intStart + (i + 0.5) * dx - s0, p);
      }
    }
  }
  // Left overhang [beamStart, s0] creates hogging moment M0 = 0.5 * w * eL^2.
  if (beamStart < s0) {
    const eL = s0 - beamStart;
    const m0 = 0.5 * wKgPerM * eL * eL;
    d -= (m0 * u * (S - u) * (2 * S - u)) / (6 * S);
  }
  // Right overhang [s0 + S, beamEnd] creates hogging moment MS = 0.5 * w * eR^2.
  const sLast = s0 + S;
  if (beamEnd > sLast) {
    const eR = beamEnd - sLast;
    const mS = 0.5 * wKgPerM * eR * eR;
    d -= (mS * (S - u) * u * (S + u)) / (6 * S);
  }
  return d;
}

/**
 * Exact continuous-beam flexibility solver for N collinear rigid supports (2 <= N <= 8)
 * on a uniform beam spanning [beamStart, beamEnd] with uniform load wKgPerM and discrete point loads.
 * Preserves negative reactions (uplift) without clamping.
 */
export function solveContinuousBeam(
  supportXs: readonly number[],
  beamStart: number,
  beamEnd: number,
  wKgPerM: number,
  pointLoads: readonly BeamPointLoad[],
): ContinuousBeamResult {
  const n = supportXs.length;
  if (n < 2) return { reactionsKg: [], spanMaxMomentsKgM: [] };
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(supportXs[i])) {
      throw new Error('Support coordinates must be finite numbers.');
    }
    if (i > 0 && supportXs[i] <= supportXs[i - 1] + 1e-9) {
      throw new Error('Support coordinates must be strictly ascending without duplicates.');
    }
  }

  const s0 = supportXs[0];
  const sLast = supportXs[n - 1];
  const S = sLast - s0;
  const beamLen = Math.max(0, beamEnd - beamStart);
  const totalUniformKg = wKgPerM * beamLen;
  const uniformCg = (beamStart + beamEnd) * 0.5;
  const totalPointKg = pointLoads.reduce((sum, p) => sum + p.loadKg, 0);
  const totalLoadKg = totalUniformKg + totalPointKg;

  if (S <= 1e-9) {
    const share = totalLoadKg / n;
    return {
      reactionsKg: new Array<number>(n).fill(share),
      spanMaxMomentsKgM: new Array<number>(n - 1).fill(0),
    };
  }

  const reactions = new Array<number>(n).fill(0);
  const m = n - 2; // Number of redundant interior supports.

  if (m > 0) {
    const flex: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const rhs = new Array<number>(m).fill(0);

    for (let i = 0; i < m; i++) {
      const ui = supportXs[i + 1] - s0;
      let d0 = simpleBeamUniformDeflection(s0, S, ui, beamStart, beamEnd, wKgPerM);
      for (const pl of pointLoads) {
        d0 += simpleBeamPointDeflection(S, ui, pl.x - s0, pl.loadKg);
      }
      rhs[i] = d0;
      for (let j = 0; j < m; j++) {
        const cj = supportXs[j + 1] - s0;
        flex[i][j] = simpleBeamPointDeflection(S, ui, cj, 1);
      }
    }

    const rInt = solveLinearSystem(flex, rhs);
    for (let i = 0; i < m; i++) reactions[i + 1] = rInt[i];
  }

  // Exact global moment & force equilibrium for outer reactions R[0] and R[n-1].
  let momentAboutS0 = totalUniformKg * (uniformCg - s0);
  for (const pl of pointLoads) momentAboutS0 += pl.loadKg * (pl.x - s0);
  for (let i = 1; i < n - 1; i++) momentAboutS0 -= reactions[i] * (supportXs[i] - s0);

  reactions[n - 1] = momentAboutS0 / S;
  let otherSum = reactions[n - 1];
  for (let i = 1; i < n - 1; i++) otherSum += reactions[i];
  reactions[0] = totalLoadKg - otherSum;

  // Compute exact piecewise-quadratic max |M(x)| on each span [supportXs[i], supportXs[i+1]].
  const momentAt = (x: number): number => {
    let mVal = 0;
    for (let i = 0; i < n; i++) {
      if (supportXs[i] < x) mVal += reactions[i] * (x - supportXs[i]);
    }
    for (const pl of pointLoads) {
      if (pl.x < x) mVal -= pl.loadKg * (x - pl.x);
    }
    if (wKgPerM !== 0 && x > beamStart) {
      const len = Math.min(x, beamEnd) - beamStart;
      if (len > 0) {
        const cg = beamStart + len * 0.5;
        mVal -= wKgPerM * len * (x - cg);
      }
    }
    return mVal;
  };

  const shearJustRight = (x: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (supportXs[i] <= x) v += reactions[i];
    }
    for (const pl of pointLoads) {
      if (pl.x <= x) v -= pl.loadKg;
    }
    if (wKgPerM !== 0 && x > beamStart) {
      const len = Math.min(x, beamEnd) - beamStart;
      if (len > 0) v -= wKgPerM * len;
    }
    return v;
  };

  const spanMaxMomentsKgM: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = supportXs[i];
    const b = supportXs[i + 1];
    const breakpoints = [a, b];
    for (const pl of pointLoads) {
      if (pl.x > a && pl.x < b) breakpoints.push(pl.x);
    }
    breakpoints.sort((p, q) => p - q);
    let maxAbs = 0;
    for (let k = 0; k < breakpoints.length; k++) {
      const xk = breakpoints[k];
      maxAbs = Math.max(maxAbs, Math.abs(momentAt(xk)));
      if (k + 1 < breakpoints.length && wKgPerM > 1e-12) {
        const xNext = breakpoints[k + 1];
        if (xNext - xk > 1e-9) {
          // Inside (xk, xNext) there are no point loads/supports, so V(x) = V(xk+) - w*(x - xk).
          const vStart = shearJustRight(xk);
          const xZero = xk + vStart / wKgPerM;
          if (xZero > xk && xZero < xNext) {
            maxAbs = Math.max(maxAbs, Math.abs(momentAt(xZero)));
          }
        }
      }
    }
    spanMaxMomentsKgM.push(maxAbs);
  }

  return { reactionsKg: reactions, spanMaxMomentsKgM };
}

/**
 * Interpolate allowable bending moment M_allow(L) = min(UDL * L^2 / 8, CPL * L / 4) in kg·m
 * from a truss profile's published span table.
 * Returns outOfTable: true when spanM exceeds the table's maximum span.
 */
export function allowableMomentForSpan(
  profile: TrussProfile,
  spanM: number,
): {
  allowableMomentKgM: number | null;
  outOfTable: boolean;
  shortSpanClamped: boolean;
} {
  const table = profile.spanTable;
  if (table.length === 0) {
    return { allowableMomentKgM: null, outOfTable: false, shortSpanClamped: false };
  }
  const maxSpan = table[table.length - 1].spanM;
  if (spanM > maxSpan + 1e-6) {
    return { allowableMomentKgM: null, outOfTable: true, shortSpanClamped: false };
  }

  const momentAtEntry = (entry: (typeof table)[number], L: number): number => {
    const mUdl = (entry.udlKgPerM * L * L) / 8;
    if (entry.cplKg === undefined) return mUdl;
    const mCpl = (entry.cplKg * L) / 4;
    return Math.min(mUdl, mCpl);
  };

  if (spanM <= table[0].spanM) {
    // Shorter than the shortest table entry: use shortest entry's UDL/CPL rates at actual span L.
    return {
      allowableMomentKgM: momentAtEntry(table[0], spanM),
      outOfTable: false,
      shortSpanClamped: spanM < table[0].spanM - 1e-6,
    };
  }

  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i];
    const hi = table[i + 1];
    if (spanM >= lo.spanM && spanM <= hi.spanM + 1e-6) {
      const t = hi.spanM > lo.spanM ? (spanM - lo.spanM) / (hi.spanM - lo.spanM) : 0;
      const udl = lo.udlKgPerM + t * (hi.udlKgPerM - lo.udlKgPerM);
      const mUdl = (udl * spanM * spanM) / 8;
      let mAllow = mUdl;
      if (lo.cplKg !== undefined && hi.cplKg !== undefined) {
        const cpl = lo.cplKg + t * (hi.cplKg - lo.cplKg);
        mAllow = Math.min(mAllow, (cpl * spanM) / 4);
      } else if (lo.cplKg !== undefined && t < 1e-6) {
        mAllow = Math.min(mAllow, (lo.cplKg * spanM) / 4);
      }
      return { allowableMomentKgM: mAllow, outOfTable: false, shortSpanClamped: false };
    }
  }
  return { allowableMomentKgM: null, outOfTable: true, shortSpanClamped: false };
}

export interface HoistPointLoadReport {
  pointIndex: number;
  label: string;
  localX: number;
  localZ: number;
  /** Static load carried by the hoist hook (truss share + fixtures + clamps + cables) in kg. Negative = uplift! */
  hoistLoadKg: number;
  /** Dynamic ×1.2 figure for motorized pods (null for static pods). */
  kineticLoadKg: number | null;
  /** Total load on roof steel (hoistLoadKg + hoist body + chain weight) in kg. */
  roofLoadKg: number;
  /** Hoist + chain self-weight added above hook in kg. */
  hoistHardwareKg: number;
  /** Nominal WLL of the selected hoist in kg. */
  nominalWllKg: number;
  /** Effective static WLL after D8 over-people guidance derate in kg (null if unknown hoist). */
  effectiveWllKg: number | null;
  /** Static utilization = hoistLoadKg / effectiveWllKg (null if unknown hoist). */
  utilization: number | null;
  /** Kinetic utilization = kineticLoadKg / effectiveWllKg (null if static or unknown hoist). */
  kineticUtilization: number | null;
  uplift: boolean;
  status: LoadStatus;
}

export interface SpanCheckReport {
  spanIndex: number;
  fromLabel: string;
  toLabel: string;
  spanM: number;
  maxMomentKgM: number;
  allowableMomentKgM: number | null;
  utilization: number | null;
  outOfTable: boolean;
  status: LoadStatus;
  note?: string;
}

export interface PodRiggingReport {
  podId: string;
  podName: string;
  shape: TrussPodConfig['shape'];
  motorized: boolean;
  lengthM: number;
  trussProfileId: string | undefined;
  trussProfileName: string;
  trussProfileUnknown: boolean;
  hoistId: string | undefined;
  hoistName: string;
  hoistUnknown: boolean;
  hoistClass: HoistProfile['safetyClass'] | 'unknown';
  d8Derated: boolean;
  solver: SolverKind;
  solverNote: string;
  fixtureCount: number;
  hasEstimatedFixtureWeight: boolean;
  trussSelfWeightKg: number;
  fixtureWeightKg: number;
  clampAllowanceKg: number;
  cableAllowanceKg: number;
  /** Total suspended load under the hoist hooks in kg. */
  totalSuspendedKg: number;
  /** Total roof load including hoist bodies + chain drops in kg. */
  totalRoofLoadKg: number;
  points: HoistPointLoadReport[];
  spans: SpanCheckReport[];
  /** Verified cantilever limit warnings (affect status) or unverified ¼-span guidance notes. */
  cantileverWarnings: string[];
  cantileverNotes: string[];
  maxPointLoadKg: number;
  maxPointUtilization: number | null;
  maxSpanUtilization: number | null;
  status: LoadStatus;
  summaryText: string;
  warnings: string[];
}

export interface OtherFlownLoad {
  id: string;
  category: 'Audio' | 'LED Video';
  label: string;
  detail: string;
  totalWeightKg: number;
  totalWeightLb: number;
  recommendedPoints: number;
  perPointEstimateKg: number;
  estimated: boolean;
}

export interface RigLoadsReport {
  pods: PodRiggingReport[];
  otherFlown: OtherFlownLoad[];
  totals: {
    podCount: number;
    hoistPointCount: number;
    trussSelfWeightKg: number;
    fixtureWeightKg: number;
    clampAllowanceKg: number;
    cableAllowanceKg: number;
    totalSuspendedKg: number;
    totalRoofLoadKg: number;
    otherFlownKg: number;
    grandTotalFlownKg: number;
    overloadPods: number;
    cautionPods: number;
    upliftPods: number;
  };
  worstStatus: LoadStatus;
  disclaimer: string;
}

function fixtureUnitWeightKg(group: MountedFixtureGroup): { kg: number; estimated: boolean } {
  if (group.catalogId) {
    const entry = getCatalogEntry(group.catalogId);
    if (entry && entry.weightKg !== undefined && !isFieldUnverified(entry, 'weightKg')) {
      return { kg: entry.weightKg, estimated: false };
    }
  }
  const lbs = LEGACY_FIXTURE_WEIGHT_LBS[group.type] ?? 30;
  return { kg: lbs / RIG_KG_TO_LBS, estimated: true };
}

function statusFromUtilization(util: number | null, uplift: boolean, outOfTable = false): LoadStatus {
  if (uplift) return 'uplift';
  if (outOfTable) return 'overload';
  if (util === null) return 'unknown';
  if (util > RIG_OVERLOAD_THRESHOLD) return 'overload';
  if (util >= RIG_CAUTION_THRESHOLD) return 'caution';
  return 'ok';
}

const STATUS_SEVERITY: Record<LoadStatus, number> = {
  ok: 0,
  unknown: 1,
  caution: 2,
  overload: 3,
  uplift: 4,
};

function worseStatus(a: LoadStatus, b: LoadStatus): LoadStatus {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

export function statusLabelText(status: LoadStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'caution':
      return 'Caution';
    case 'overload':
      return 'Overload';
    case 'uplift':
      return 'Uplift';
    case 'unknown':
      return 'Unverified';
  }
}

export function podTrussLengthM(pod: Pick<TrussPodConfig, 'shape' | 'width' | 'path'>): number {
  if (pod.shape === 'path' && pod.path) return pathLength(pod.path);
  if (pod.shape === 'circle') return Math.PI * pod.width;
  if (pod.shape === 'chevron') return pod.width / Math.cos(0.36);
  return pod.width;
}

export interface EvaluateRigLoadsOptions {
  /** Apply 50% IGVW SQP2 / DGUV V17 over-people guidance derate to D8 hoists (default true). */
  applyD8Derate?: boolean;
}

/**
 * Evaluate static rigging loads, hoist utilizations, truss span bending moments, and other flown loads.
 */
export function evaluateRigLoads(
  sourceRig: RigConfig,
  stage?: NativeStage,
  options: EvaluateRigLoadsOptions = {},
): RigLoadsReport {
  const applyD8Derate = options.applyD8Derate ?? true;
  const { rig, hangs } = resolveStudioGeometry(sourceRig, stage?.layout);
  const gridHeight = GRID_HEIGHT[rig.venue] ?? 14;

  const pods: PodRiggingReport[] = rig.trussPods.map((pod) => {
    const knownTruss = pod.trussProfileId ? getTrussProfile(pod.trussProfileId) : undefined;
    const trussProfileUnknown = Boolean(pod.trussProfileId && !knownTruss);
    const trussProfile = knownTruss ?? LEGACY_TRUSS_PROFILE;

    const knownHoist = pod.hoistId ? getHoistProfile(pod.hoistId) : undefined;
    const hoistUnknown = Boolean(pod.hoistId && !knownHoist);
    const hoistProfile = knownHoist ?? LEGACY_HOIST_PROFILE;

    const anchors = hoistPoints(pod);
    const lengthM = podTrussLengthM(pod);
    const trussSelfWeightKg = trussProfileUnknown ? 0 : trussProfile.kgPerMeter * lengthM;

    const hung = hungUnits(pod.fixtures);
    const slots = trussMounts(pod.shape, pod.width, pod.path, hung.length);

    let fixtureWeightKg = 0;
    let hasEstimatedFixtureWeight = false;
    const mountedLoads: Array<{ x: number; z: number; payloadKg: number }> = [];

    hung.forEach(({ group }, idx) => {
      const slot = slots[mountSlotIndex(idx, hung.length, slots.length)];
      if (!slot) return;
      const { kg, estimated } = fixtureUnitWeightKg(group);
      if (estimated) hasEstimatedFixtureWeight = true;
      fixtureWeightKg += kg;
      const payloadKg = kg + CLAMP_ALLOWANCE_KG + kg * CABLE_ALLOWANCE_FRACTION;
      mountedLoads.push({ x: slot.x, z: slot.z, payloadKg });
    });

    const clampAllowanceKg = mountedLoads.length * CLAMP_ALLOWANCE_KG;
    const cableAllowanceKg = fixtureWeightKg * CABLE_ALLOWANCE_FRACTION;
    const totalSuspendedKg = trussSelfWeightKg + fixtureWeightKg + clampAllowanceKg + cableAllowanceKg;

    const chainDropM = Math.max(0.5, gridHeight - pod.baseY);
    const hoistHardwareKg = hoistUnknown
      ? 0
      : hoistProfile.bodyKg + hoistProfile.chainKgPerM * chainDropM;

    const d8Derated = !hoistUnknown && applyD8Derate && hoistProfile.safetyClass === 'D8';
    const effectiveWllKg = hoistUnknown
      ? null
      : d8Derated
        ? hoistProfile.wllKg * D8_OVER_PEOPLE_FACTOR
        : hoistProfile.wllKg;

    let reactionsKg: number[] = new Array<number>(anchors.length).fill(0);
    let solver: SolverKind = 'continuous-beam';
    let solverNote = '';
    const spans: SpanCheckReport[] = [];
    const cantileverWarnings: string[] = [];
    const cantileverNotes: string[] = [];
    const warnings: string[] = [];

    if (trussProfileUnknown) {
      warnings.push(`Unknown truss profile "${pod.trussProfileId}" — truss self-weight and span check unavailable.`);
    }
    if (hoistUnknown) {
      warnings.push(`Unknown hoist profile "${pod.hoistId}" — hoist WLL check unavailable.`);
    }

    let solverDegenerate = false;

    if (pod.shape === 'box' && anchors.length >= 2) {
      const supportXs = anchors.map((a) => a.x);
      const half = pod.width / 2;
      const wSelf = trussProfileUnknown ? 0 : trussProfile.kgPerMeter;
      const pointLoads: BeamPointLoad[] = mountedLoads.map((m) => ({ x: m.x, loadKg: m.payloadKg }));

      solver = anchors.length === 2 ? 'moment-balance' : 'continuous-beam';
      solverNote =
        anchors.length === 2
          ? 'Exact 2-point static moment equilibrium (includes overhang).'
          : `Continuous uniform beam (${anchors.length} rigid supports, flexibility method).`;

      let fullSol: ContinuousBeamResult;
      try {
        if (!Number.isFinite(pod.width) || pod.width <= 1e-6) {
          throw new Error('Truss width must be positive to evaluate hoist reactions.');
        }
        fullSol = solveContinuousBeam(supportXs, -half, half, wSelf, pointLoads);
      } catch (err) {
        solverDegenerate = true;
        warnings.push(
          err instanceof Error
            ? `Degenerate truss geometry (${err.message}) — static load check unavailable.`
            : 'Degenerate truss geometry — static load check unavailable.',
        );
        fullSol = {
          reactionsKg: new Array<number>(anchors.length).fill(totalSuspendedKg / anchors.length),
          spanMaxMomentsKgM: new Array<number>(anchors.length - 1).fill(0),
        };
      }
      reactionsKg = fullSol.reactionsKg;

      // Span bending moment check: when the manufacturer table already deducts truss self-weight (net payload table),
      // evaluate payload-only moment; otherwise evaluate total moment including truss self-weight.
      const momentSol =
        !solverDegenerate && !trussProfileUnknown && trussProfile.tableDeductsSelfWeight
          ? solveContinuousBeam(supportXs, -half, half, 0, pointLoads)
          : fullSol;

      for (let i = 0; i < supportXs.length - 1; i++) {
        const spanM = supportXs[i + 1] - supportXs[i];
        const maxMomentKgM = momentSol.spanMaxMomentsKgM[i] ?? 0;
        if (trussProfileUnknown || trussProfile.spanTable.length === 0) {
          spans.push({
            spanIndex: i,
            fromLabel: `P${i + 1}`,
            toLabel: `P${i + 2}`,
            spanM,
            maxMomentKgM,
            allowableMomentKgM: null,
            utilization: null,
            outOfTable: false,
            status: 'unknown',
            note: trussProfileUnknown
              ? 'Unknown truss profile — span check unavailable'
              : 'Generic legacy truss — pick a real truss profile for span moment check',
          });
        } else {
          const check = allowableMomentForSpan(trussProfile, spanM);
          const util =
            check.allowableMomentKgM && check.allowableMomentKgM > 0
              ? maxMomentKgM / check.allowableMomentKgM
              : null;
          const st = statusFromUtilization(util, false, check.outOfTable);
          spans.push({
            spanIndex: i,
            fromLabel: `P${i + 1}`,
            toLabel: `P${i + 2}`,
            spanM,
            maxMomentKgM,
            allowableMomentKgM: check.allowableMomentKgM,
            utilization: util,
            outOfTable: check.outOfTable,
            status: st,
            note: check.outOfTable
              ? `Span ${spanM.toFixed(1)} m exceeds manufacturer load table (max ${trussProfile.spanTable[trussProfile.spanTable.length - 1].spanM} m)`
              : check.shortSpanClamped
                ? 'Short span evaluated at shortest published table rate'
                : undefined,
          });
        }
      }

      // Cantilever overhang checks on left and right ends.
      // Only a verified published maxCantileverM raises status to Caution; the unverified ¼-span
      // rule of thumb is surfaced as an informational note so stock 3- and 4-point trusses do not false-alarm.
      const leftOverhang = supportXs[0] - -half;
      const rightOverhang = half - supportXs[supportXs.length - 1];
      const leftSpan = supportXs[1] - supportXs[0];
      const rightSpan = supportXs[supportXs.length - 1] - supportXs[supportXs.length - 2];
      const hasVerifiedLimit = trussProfile.maxCantileverM !== undefined;
      const maxCantLeft = trussProfile.maxCantileverM ?? leftSpan / 4;
      const maxCantRight = trussProfile.maxCantileverM ?? rightSpan / 4;
      const cantNote = hasVerifiedLimit ? 'published limit' : '¼ back-span guidance, unverified';
      const targetList = hasVerifiedLimit ? cantileverWarnings : cantileverNotes;
      if (leftOverhang > maxCantLeft + 1e-6) {
        targetList.push(
          `Left overhang ${leftOverhang.toFixed(2)} m exceeds ${maxCantLeft.toFixed(2)} m (${cantNote}).`,
        );
      }
      if (rightOverhang > maxCantRight + 1e-6) {
        targetList.push(
          `Right overhang ${rightOverhang.toFixed(2)} m exceeds ${maxCantRight.toFixed(2)} m (${cantNote}).`,
        );
      }
    } else if (pod.shape === 'chevron' && anchors.length === 3) {
      solver = 'approximate-chevron';
      solverNote = 'Approximate (statically indeterminate): two simply-supported arms meeting at apex, overhang included.';
      const angle = 0.36;
      const armLen = pod.width / (2 * Math.cos(angle));
      const outerArmDist = (pod.width * 0.42) / Math.cos(angle);
      const wSelf = trussProfileUnknown ? 0 : trussProfile.kgPerMeter;

      const leftLoads: BeamPointLoad[] = [];
      const rightLoads: BeamPointLoad[] = [];
      for (const m of mountedLoads) {
        const dist = Math.abs(m.x) / Math.cos(angle);
        if (m.x < 0) leftLoads.push({ x: dist, loadKg: m.payloadKg });
        else rightLoads.push({ x: dist, loadKg: m.payloadKg });
      }
      // Each arm runs from s=0 (apex) to s=armLen, supported at s=0 and s=outerArmDist.
      const leftSol = solveContinuousBeam([0, outerArmDist], 0, armLen, wSelf, leftLoads);
      const rightSol = solveContinuousBeam([0, outerArmDist], 0, armLen, wSelf, rightLoads);
      // Anchor order in hoistPoints: [0] = left outer, [1] = apex, [2] = right outer.
      reactionsKg = [
        leftSol.reactionsKg[1],
        leftSol.reactionsKg[0] + rightSol.reactionsKg[0],
        rightSol.reactionsKg[1],
      ];

      // Check each arm's span moment against truss profile table when profiled.
      if (!trussProfileUnknown && trussProfile.spanTable.length > 0) {
        const leftMomentSol = trussProfile.tableDeductsSelfWeight
          ? solveContinuousBeam([0, outerArmDist], 0, armLen, 0, leftLoads)
          : leftSol;
        const rightMomentSol = trussProfile.tableDeductsSelfWeight
          ? solveContinuousBeam([0, outerArmDist], 0, armLen, 0, rightLoads)
          : rightSol;
        [
          { label: 'P1', to: 'P2', m: leftMomentSol.spanMaxMomentsKgM[0] ?? 0 },
          { label: 'P2', to: 'P3', m: rightMomentSol.spanMaxMomentsKgM[0] ?? 0 },
        ].forEach((arm, idx) => {
          const check = allowableMomentForSpan(trussProfile, outerArmDist);
          const util =
            check.allowableMomentKgM && check.allowableMomentKgM > 0 ? arm.m / check.allowableMomentKgM : null;
          spans.push({
            spanIndex: idx,
            fromLabel: arm.label,
            toLabel: arm.to,
            spanM: outerArmDist,
            maxMomentKgM: arm.m,
            allowableMomentKgM: check.allowableMomentKgM,
            utilization: util,
            outOfTable: check.outOfTable,
            status: statusFromUtilization(util, false, check.outOfTable),
            note: check.outOfTable
              ? `Arm span ${outerArmDist.toFixed(1)} m exceeds manufacturer load table`
              : 'Approximate arm span check',
          });
        });
      }
    } else if (pod.shape === 'circle' && anchors.length === 4) {
      solver = 'approximate-circle';
      solverNote = 'Approximate (ring torsion ignored): angular split between adjacent hoists; no ring span table — verify with manufacturer.';
      const ringSelfShare = trussSelfWeightKg / 4;
      reactionsKg = [ringSelfShare, ringSelfShare, ringSelfShare, ringSelfShare];
      const anchorAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

      for (const m of mountedLoads) {
        let theta = Math.atan2(m.z, m.x);
        if (theta < 0) theta += Math.PI * 2;
        // Find adjacent hoist pair bracketing theta (each sector is pi/2).
        const shifted = (theta - Math.PI / 4 + Math.PI * 2) % (Math.PI * 2);
        const idx0 = Math.floor(shifted / (Math.PI / 2)) % 4;
        const idx1 = (idx0 + 1) % 4;
        const frac = (shifted - idx0 * (Math.PI / 2)) / (Math.PI / 2);
        // Verify ordering matches anchorAngles.
        void anchorAngles;
        reactionsKg[idx0] += m.payloadKg * (1 - frac);
        reactionsKg[idx1] += m.payloadKg * frac;
      }
      spans.push({
        spanIndex: 0,
        fromLabel: 'P1',
        toLabel: 'P4',
        spanM: (Math.PI * pod.width) / 4,
        maxMomentKgM: 0,
        allowableMomentKgM: null,
        utilization: null,
        outOfTable: false,
        status: 'unknown',
        note: 'Circle truss — no ring span table; verify torsion & curvature with manufacturer.',
      });
    } else if (pod.shape === 'path' && anchors.length >= 2) {
      solver = 'approximate-path';
      solverNote = 'Approximate (statically indeterminate): each segment treated as simply supported between its end hoists.';
      const rawPath = pod.path ?? [];
      const segs: Array<{ aIdx: number; bIdx: number; ax: number; az: number; dx: number; dz: number; len: number }> = [];
      const findAnchorIdx = (p: PlanPoint): number => {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < anchors.length; i++) {
          const d = (anchors[i].x - p.x) ** 2 + (anchors[i].z - p.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        return best;
      };
      for (let i = 1; i < rawPath.length; i++) {
        const p0 = rawPath[i - 1];
        const p1 = rawPath[i];
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const len = Math.hypot(dx, dz);
        if (len <= 0.0001) continue;
        segs.push({ aIdx: findAnchorIdx(p0), bIdx: findAnchorIdx(p1), ax: p0.x, az: p0.z, dx, dz, len });
      }
      const wSelf = trussProfileUnknown ? 0 : trussProfile.kgPerMeter;
      const segPointLoads: BeamPointLoad[][] = segs.map(() => []);
      for (const seg of segs) {
        const halfSelf = (wSelf * seg.len) * 0.5;
        reactionsKg[seg.aIdx] += halfSelf;
        reactionsKg[seg.bIdx] += halfSelf;
      }
      for (const m of mountedLoads) {
        // Project onto nearest segment.
        let bestSeg = 0;
        let bestT = 0;
        let bestDistSq = Infinity;
        for (let s = 0; s < segs.length; s++) {
          const seg = segs[s];
          const tRaw = ((m.x - seg.ax) * seg.dx + (m.z - seg.az) * seg.dz) / (seg.len * seg.len);
          const t = Math.max(0, Math.min(1, tRaw));
          const px = seg.ax + t * seg.dx;
          const pz = seg.az + t * seg.dz;
          const dSq = (m.x - px) ** 2 + (m.z - pz) ** 2;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestSeg = s;
            bestT = t;
          }
        }
        if (segs.length > 0) {
          const seg = segs[bestSeg];
          reactionsKg[seg.aIdx] += m.payloadKg * (1 - bestT);
          reactionsKg[seg.bIdx] += m.payloadKg * bestT;
          segPointLoads[bestSeg].push({ x: bestT * seg.len, loadKg: m.payloadKg });
        }
      }
      if (!trussProfileUnknown && trussProfile.spanTable.length > 0) {
        segs.forEach((seg, sIdx) => {
          const wForMoment = trussProfile.tableDeductsSelfWeight ? 0 : wSelf;
          const sol = solveContinuousBeam([0, seg.len], 0, seg.len, wForMoment, segPointLoads[sIdx]);
          const mMax = sol.spanMaxMomentsKgM[0] ?? 0;
          const check = allowableMomentForSpan(trussProfile, seg.len);
          const util =
            check.allowableMomentKgM && check.allowableMomentKgM > 0 ? mMax / check.allowableMomentKgM : null;
          spans.push({
            spanIndex: sIdx,
            fromLabel: `P${seg.aIdx + 1}`,
            toLabel: `P${seg.bIdx + 1}`,
            spanM: seg.len,
            maxMomentKgM: mMax,
            allowableMomentKgM: check.allowableMomentKgM,
            utilization: util,
            outOfTable: check.outOfTable,
            status: statusFromUtilization(util, false, check.outOfTable),
            note: check.outOfTable ? `Segment ${seg.len.toFixed(1)} m exceeds manufacturer load table` : undefined,
          });
        });
      }
    }

    const points: HoistPointLoadReport[] = anchors.map((pt, idx) => {
      const hoistLoadKg = reactionsKg[idx] ?? 0;
      const uplift = hoistLoadKg < -1e-6;
      const kineticLoadKg = pod.motorized ? hoistLoadKg * KINETIC_DYNAMIC_FACTOR : null;
      const roofLoadKg = hoistLoadKg + hoistHardwareKg;
      const utilization = effectiveWllKg && effectiveWllKg > 0 ? hoistLoadKg / effectiveWllKg : null;
      const kineticUtilization =
        kineticLoadKg !== null && effectiveWllKg && effectiveWllKg > 0 ? kineticLoadKg / effectiveWllKg : null;
      const worstUtil =
        utilization === null
          ? null
          : kineticUtilization !== null
            ? Math.max(utilization, kineticUtilization)
            : utilization;
      const status = statusFromUtilization(worstUtil, uplift, false);
      return {
        pointIndex: idx,
        label: `P${idx + 1}`,
        localX: pt.x,
        localZ: pt.z,
        hoistLoadKg,
        kineticLoadKg,
        roofLoadKg,
        hoistHardwareKg,
        nominalWllKg: hoistProfile.wllKg,
        effectiveWllKg,
        utilization,
        kineticUtilization,
        uplift,
        status,
      };
    });

    const totalRoofLoadKg = points.reduce((sum, p) => sum + p.roofLoadKg, 0);
    const maxPointLoadKg = points.reduce((max, p) => Math.max(max, p.hoistLoadKg), 0);
    const pointUtils = points
      .map((p) => (p.kineticUtilization !== null && p.utilization !== null ? Math.max(p.utilization, p.kineticUtilization) : p.utilization))
      .filter((u): u is number => u !== null);
    const maxPointUtilization = pointUtils.length > 0 ? Math.max(...pointUtils) : null;
    const spanUtils = spans.map((s) => s.utilization).filter((u): u is number => u !== null);
    const maxSpanUtilization = spanUtils.length > 0 ? Math.max(...spanUtils) : null;

    let status: LoadStatus = 'ok';
    for (const p of points) status = worseStatus(status, p.status);
    for (const s of spans) {
      if (s.status === 'overload' || s.status === 'caution') status = worseStatus(status, s.status);
    }
    if (cantileverWarnings.length > 0 && status === 'ok') status = 'caution';
    if (hoistUnknown || trussProfileUnknown || solverDegenerate) {
      if (status === 'ok') status = 'unknown';
    }

    if (points.some((p) => p.uplift)) {
      warnings.push('Uplift detected: an overhang load lifts a hoist point into negative reaction.');
    }
    if (d8Derated) {
      warnings.push(
        `D8 single-brake hoist guidance: static WLL derated 50% to ${Math.round(effectiveWllKg!)} kg for overhead use (or use secondary safety steels / D8+ dual-brake hoist).`,
      );
    }
    for (const s of spans) {
      if (s.outOfTable && s.note) warnings.push(s.note);
      else if (s.status === 'overload') {
        warnings.push(`Span ${s.fromLabel}–${s.toLabel} (${s.spanM.toFixed(1)} m) exceeds allowable bending moment.`);
      }
    }
    warnings.push(...cantileverWarnings);

    const staticUtils = points.map((p) => p.utilization).filter((u): u is number => u !== null);
    const maxStaticUtil = staticUtils.length > 0 ? Math.max(...staticUtils) : null;
    const kineticUtils = points.map((p) => p.kineticUtilization).filter((u): u is number => u !== null);
    const maxKineticUtil = kineticUtils.length > 0 ? Math.max(...kineticUtils) : null;
    const wllLabel = hoistUnknown
      ? 'unknown hoist'
      : effectiveWllKg! >= 1000
        ? `${Number((effectiveWllKg! / 1000).toFixed(2))} t`
        : `${Math.round(effectiveWllKg!)} kg`;
    const pctText =
      maxStaticUtil !== null
        ? maxKineticUtil !== null
          ? ` · ${Math.round(maxStaticUtil * 100)}% (${Math.round(maxKineticUtil * 100)}% dyn)`
          : ` · ${Math.round(maxStaticUtil * 100)}%`
        : '';
    const summaryText = `${statusLabelText(status)} · Max pt ${Math.round(maxPointLoadKg)} kg / ${wllLabel}${pctText}`;

    return {
      podId: pod.id,
      podName: pod.name,
      shape: pod.shape,
      motorized: pod.motorized,
      lengthM,
      trussProfileId: pod.trussProfileId,
      trussProfileName: trussProfileUnknown
        ? `Unknown (${pod.trussProfileId})`
        : trussDisplayName(trussProfile),
      trussProfileUnknown,
      hoistId: pod.hoistId,
      hoistName: hoistUnknown ? `Unknown (${pod.hoistId})` : hoistDisplayName(hoistProfile),
      hoistUnknown,
      hoistClass: hoistUnknown ? 'unknown' : hoistProfile.safetyClass,
      d8Derated,
      solver,
      solverNote,
      fixtureCount: mountedLoads.length,
      hasEstimatedFixtureWeight,
      trussSelfWeightKg,
      fixtureWeightKg,
      clampAllowanceKg,
      cableAllowanceKg,
      totalSuspendedKg,
      totalRoofLoadKg,
      points,
      spans,
      cantileverWarnings,
      cantileverNotes,
      maxPointLoadKg,
      maxPointUtilization,
      maxSpanUtilization,
      status,
      summaryText,
      warnings,
    };
  });

  // Separate "Other flown loads" section (flown PA line arrays & flown LED walls; never mixed into truss pods).
  const otherFlown: OtherFlownLoad[] = [];
  const k2 = rig.audioRig.speakerProfile === 'k2';
  const boxWeightLbs = k2 ? 123 : 200;
  const bumperWeightLbs = 150; // Flybar / bumper allowance per hang

  if (hangs !== undefined) {
    hangs.forEach((h, idx) => {
      const boxes = Math.max(1, Math.min(16, Math.round(h.count)));
      const weightLb = boxes * boxWeightLbs + bumperWeightLbs;
      const weightKg = weightLb / RIG_KG_TO_LBS;
      otherFlown.push({
        id: `pa-hang-${idx}`,
        category: 'Audio',
        label: k2 ? `K2 flown array #${idx + 1}` : `Flown PA array #${idx + 1}`,
        detail: `${boxes} boxes + flybar (front/rear bridle)`,
        totalWeightKg: weightKg,
        totalWeightLb: weightLb,
        recommendedPoints: 2,
        perPointEstimateKg: weightKg / 2,
        estimated: !k2,
      });
    });
  } else if (rig.audioRig.lineArrays) {
    const boxesPerSide = Math.max(4, Math.min(12, Math.round(rig.audioRig.boxesPerSide ?? 9)));
    for (const side of ['L', 'R'] as const) {
      const weightLb = boxesPerSide * boxWeightLbs + bumperWeightLbs;
      const weightKg = weightLb / RIG_KG_TO_LBS;
      otherFlown.push({
        id: `pa-${side.toLowerCase()}`,
        category: 'Audio',
        label: k2 ? `K2 flown line array (${side})` : `Flown line array (${side})`,
        detail: `${boxesPerSide} boxes + flybar (front/rear bridle)`,
        totalWeightKg: weightKg,
        totalWeightLb: weightLb,
        recommendedPoints: 2,
        perPointEstimateKg: weightKg / 2,
        estimated: !k2,
      });
    }
  }

  const panelEntry = getCatalogEntry(rig.ledWall.cabinets?.cabinetId);
  const usePanelSpecs = Boolean(
    panelEntry &&
      panelEntry.category === 'led_panel' &&
      panelEntry.weightKg !== undefined &&
      !isFieldUnverified(panelEntry, 'weightKg'),
  );
  const frames = authoredWallFrames(rig, stage);
  const customMain = frames.find((f) => f.id === 'main-led');
  const stockWall = rig.ledWall.enabled && !customMain ? ledPlacement(rig) : undefined;
  const secondaryWalls = frames.filter((f) => f.id !== 'main-led');

  if (customMain) {
    const surface = authoredWallSurface(rig, customMain);
    const area = customMain.width * customMain.height;
    const cabs = surface.columns * surface.rows;
    const weightLb = surface.cabinets && usePanelSpecs ? cabs * panelEntry!.weightKg! * RIG_KG_TO_LBS : area * 62;
    const weightKg = weightLb / RIG_KG_TO_LBS;
    const pts = Math.max(2, Math.ceil(customMain.width / 3));
    otherFlown.push({
      id: 'led-main',
      category: 'LED Video',
      label: 'Main LED wall (authored)',
      detail: surface.cabinets ? `${cabs} cabinets · ${customMain.width.toFixed(1)} × ${customMain.height.toFixed(1)} m` : `${area.toFixed(1)} m²`,
      totalWeightKg: weightKg,
      totalWeightLb: weightLb,
      recommendedPoints: pts,
      perPointEstimateKg: weightKg / pts,
      estimated: !(surface.cabinets && usePanelSpecs),
    });
  } else if (stockWall && stockWall.height > 0) {
    const mainArea = stockWall.width * stockWall.height;
    const mainCabs = stockWall.columns * stockWall.rows;
    const mainLb = rig.ledWall.cabinets && usePanelSpecs ? mainCabs * panelEntry!.weightKg! * RIG_KG_TO_LBS : mainArea * 62;
    const mainKg = mainLb / RIG_KG_TO_LBS;
    const mainPts = Math.max(2, Math.ceil(stockWall.width / 3));
    otherFlown.push({
      id: 'led-main',
      category: 'LED Video',
      label: `Main LED wall${rig.ledWall.curved ? ' (curved)' : ''}`,
      detail: rig.ledWall.cabinets ? `${mainCabs} cabinets · ${stockWall.width.toFixed(1)} × ${stockWall.height.toFixed(1)} m` : `${mainArea.toFixed(1)} m²`,
      totalWeightKg: mainKg,
      totalWeightLb: mainLb,
      recommendedPoints: mainPts,
      perPointEstimateKg: mainKg / mainPts,
      estimated: !(rig.ledWall.cabinets && usePanelSpecs),
    });
    if (stockWall.wing.width > 0 && stockWall.wing.height > 0) {
      const wingArea = stockWall.wing.width * stockWall.wing.height;
      const wingCabs = stockWall.wing.columns * stockWall.wing.rows;
      const wingLb = rig.ledWall.cabinets && usePanelSpecs ? wingCabs * panelEntry!.weightKg! * RIG_KG_TO_LBS : wingArea * 62;
      const wingKg = wingLb / RIG_KG_TO_LBS;
      const wingPts = Math.max(2, Math.ceil(stockWall.wing.width / 3));
      for (const side of ['L', 'R'] as const) {
        otherFlown.push({
          id: `led-wing-${side.toLowerCase()}`,
          category: 'LED Video',
          label: `IMAG LED wing (${side})`,
          detail: rig.ledWall.cabinets ? `${wingCabs} cabinets · ${stockWall.wing.width.toFixed(1)} × ${stockWall.wing.height.toFixed(1)} m` : `${wingArea.toFixed(1)} m²`,
          totalWeightKg: wingKg,
          totalWeightLb: wingLb,
          recommendedPoints: wingPts,
          perPointEstimateKg: wingKg / wingPts,
          estimated: !(rig.ledWall.cabinets && usePanelSpecs),
        });
      }
    }
  }

  secondaryWalls.forEach((w, idx) => {
    const area = w.width * w.height;
    const weightLb = area * 62;
    const weightKg = weightLb / RIG_KG_TO_LBS;
    const pts = Math.max(2, Math.ceil(w.width / 3));
    otherFlown.push({
      id: `led-sec-${idx}`,
      category: 'LED Video',
      label: w.label || `Secondary LED wall #${idx + 1}`,
      detail: `${w.width.toFixed(1)} × ${w.height.toFixed(1)} m (${area.toFixed(1)} m²)`,
      totalWeightKg: weightKg,
      totalWeightLb: weightLb,
      recommendedPoints: pts,
      perPointEstimateKg: weightKg / pts,
      estimated: true,
    });
  });

  const hoistPointCount = pods.reduce((s, p) => s + p.points.length, 0);
  const trussSelfWeightKg = pods.reduce((s, p) => s + p.trussSelfWeightKg, 0);
  const fixtureWeightKg = pods.reduce((s, p) => s + p.fixtureWeightKg, 0);
  const clampAllowanceKg = pods.reduce((s, p) => s + p.clampAllowanceKg, 0);
  const cableAllowanceKg = pods.reduce((s, p) => s + p.cableAllowanceKg, 0);
  const totalSuspendedKg = pods.reduce((s, p) => s + p.totalSuspendedKg, 0);
  const totalRoofLoadKg = pods.reduce((s, p) => s + p.totalRoofLoadKg, 0);
  const otherFlownKg = otherFlown.reduce((s, o) => s + o.totalWeightKg, 0);

  let worstStatus: LoadStatus = 'ok';
  let overloadPods = 0;
  let cautionPods = 0;
  let upliftPods = 0;
  for (const p of pods) {
    worstStatus = worseStatus(worstStatus, p.status);
    if (p.status === 'uplift') upliftPods++;
    else if (p.status === 'overload') overloadPods++;
    else if (p.status === 'caution') cautionPods++;
  }

  return {
    pods,
    otherFlown,
    totals: {
      podCount: pods.length,
      hoistPointCount,
      trussSelfWeightKg,
      fixtureWeightKg,
      clampAllowanceKg,
      cableAllowanceKg,
      totalSuspendedKg,
      totalRoofLoadKg,
      otherFlownKg,
      grandTotalFlownKg: totalRoofLoadKg + otherFlownKg,
      overloadPods,
      cautionPods,
      upliftPods,
    },
    worstStatus,
    disclaimer: RIGGING_DISCLAIMER,
  };
}
