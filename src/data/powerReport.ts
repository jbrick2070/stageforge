import type {
  FixtureType,
  FloorFxType,
  FloorFxUnit,
  MountedFixtureGroup,
  PhaseId,
  PowerPinTarget,
  PowerSystemId,
  RigConfig,
} from '../types/show';
import { formatCsv, type CsvValue } from './csv';
import { getCatalogEntry, isFieldUnverified } from './equipmentCatalog';
import { calculateProductionEstimate, HARDWARE_ALLOWANCE } from './productionEstimator';
import { evaluateRigLoads, RIGGING_DISCLAIMER, statusLabelText, type RigLoadsReport } from './rigLoads';
import type { NativeStage } from './showFile';
import { resolveStudioGeometry } from './studioGeometry';

export interface PowerSystemSpec {
  id: PowerSystemId;
  label: string;
  shortLabel: string;
  phases: 1 | 3;
  voltageLN: number;
  voltageLL: number;
  frequencyHz: number;
  branchBreakerA: number;
  continuousFactor: number;
  continuousNote: string;
  standardFeedersA: readonly number[];
  feederUnitLabel: string;
}

export const POWER_SYSTEMS: Record<PowerSystemId, PowerSystemSpec> = {
  us_208_3p: {
    id: 'us_208_3p',
    label: 'US 120/208 V 3-Phase Wye (60 Hz)',
    shortLabel: 'US 120/208V 3φ',
    phases: 3,
    voltageLN: 120,
    voltageLL: 208,
    frequencyHz: 60,
    branchBreakerA: 20,
    continuousFactor: 0.8,
    continuousNote: 'NEC 210.20 (80% continuous load = 16 A / 1,920 VA per 20 A circuit)',
    standardFeedersA: [60, 100, 200, 400],
    feederUnitLabel: 'Camlok / distro',
  },
  eu_400_3p: {
    id: 'eu_400_3p',
    label: 'EU 230/400 V 3-Phase Wye (50 Hz)',
    shortLabel: 'EU 230/400V 3φ',
    phases: 3,
    voltageLN: 230,
    voltageLL: 400,
    frequencyHz: 50,
    branchBreakerA: 16,
    continuousFactor: 0.8,
    continuousNote: '80% practice guidance (12.8 A / 2,944 VA per 16 A circuit)',
    standardFeedersA: [32, 63, 125, 250, 400],
    feederUnitLabel: 'CEEform',
  },
  us_120_1p: {
    id: 'us_120_1p',
    label: 'US 120 V Single-Phase (60 Hz)',
    shortLabel: 'US 120V 1φ',
    phases: 1,
    voltageLN: 120,
    voltageLL: 120,
    frequencyHz: 60,
    branchBreakerA: 20,
    continuousFactor: 0.8,
    continuousNote: 'NEC 210.20 (80% continuous load = 16 A / 1,920 VA per 20 A circuit)',
    standardFeedersA: [20, 30, 50, 60, 100],
    feederUnitLabel: 'single-phase feed',
  },
  eu_230_1p: {
    id: 'eu_230_1p',
    label: 'EU 230 V Single-Phase (50 Hz)',
    shortLabel: 'EU 230V 1φ',
    phases: 1,
    voltageLN: 230,
    voltageLL: 230,
    frequencyHz: 50,
    branchBreakerA: 16,
    continuousFactor: 0.8,
    continuousNote: '80% practice guidance (12.8 A / 2,944 VA per 16 A circuit)',
    standardFeedersA: [16, 32, 63],
    feederUnitLabel: 'CEEform 1φ',
  },
};

export const POWER_SYSTEM_IDS: readonly PowerSystemId[] = [
  'us_208_3p',
  'eu_400_3p',
  'us_120_1p',
  'eu_230_1p',
];

export const DEFAULT_POWER_SYSTEM: PowerSystemId = 'us_208_3p';

export const PHASE_IDS: readonly PhaseId[] = ['L1', 'L2', 'L3'];

export type CircuitStatus = 'ok' | 'caution' | 'overload';

export interface PowerCircuitSource {
  /** Index into resolved `rig.trussPods`, or `null` for `rig.floorFx`. */
  podIndex: number | null;
  /** Index into `pod.fixtures` or `rig.floorFx`. */
  groupIndex: number;
  /** 0-based first unit index in the fixture group served by this circuit. */
  firstUnit: number;
  /** Number of units from the fixture group served by this circuit. */
  unitCount: number;
}

export interface PowerCircuit {
  id: string;
  groupLabel: string;
  department: 'Lighting' | 'Lasers' | 'Smoke & FX' | 'LED Video' | 'Audio' | 'Stage & FOH' | 'Scenery';
  description: string;
  units: number;
  watts: number;
  powerFactor: number;
  va: number;
  amps: number;
  breakerA: number;
  utilization: number;
  phase: PhaseId;
  pinned: boolean;
  status: CircuitStatus;
  note?: string;
  /** Optional unit-range provenance for per-unit paperwork lookup (not emitted in riggingPowerCsv). */
  source?: PowerCircuitSource;
}

export interface PhaseLoadSummary {
  phase: PhaseId;
  circuitCount: number;
  watts: number;
  kw: number;
  va: number;
  kva: number;
  amps: number;
}

export interface IntermittentMotorLoad {
  hoistCount: number;
  watts: number;
  powerFactor: number;
  va: number;
  ampsPerPhase: number;
  note: string;
}

export interface PowerReport {
  system: PowerSystemSpec;
  circuits: PowerCircuit[];
  phases: PhaseLoadSummary[];
  intermittent: IntermittentMotorLoad;
  totals: {
    /** Continuous steady-state nameplate watts (excluding intermittent chain hoists). */
    continuousW: number;
    continuousVa: number;
    continuousKva: number;
    /** Intermittent hoist motor watts. */
    intermittentW: number;
    /** Grand total W — strictly equal to productionEstimator.totalWatts. */
    totalW: number;
    /** Informational estimated typical audio draw at 1/8 rated amplifier power. */
    audioTypicalEighthW: number;
    maxPhaseAmps: number;
    minPhaseAmps: number;
    avgPhaseAmps: number;
    imbalancePct: number;
    /** Linear Wye neutral current estimate in Amps (0 when balanced; equal to phase I on 1-phase). */
    neutralAmps: number;
    /** Max phase Amps with all chain hoists moving simultaneously. */
    maxPhaseWithHoistsAmps: number;
    recommendedFeederA: number;
    configuredFeederA: number | null;
    feederUtilization: number;
    feederWithHoistsUtilization: number;
    feederStatus: CircuitStatus;
    recommendedGeneratorKva: number;
    overloadedCircuits: number;
    cautionCircuits: number;
  };
  harmonicNote: string;
  disclaimer: string;
}

type HardwareKind = FixtureType | FloorFxType;

function groupUnitWattsAndPf(group: MountedFixtureGroup | FloorFxUnit): { watts: number; pf: number } {
  const allowance = HARDWARE_ALLOWANCE[group.type as HardwareKind];
  const entry = group.catalogId ? getCatalogEntry(group.catalogId) : undefined;
  const hasPower = Boolean(entry && entry.powerW !== undefined && !isFieldUnverified(entry, 'powerW'));
  const watts = hasPower ? entry!.powerW! : allowance.watts;
  // Tungsten blinders behave as resistive PF ~1.0; modern PFC switch-mode movers/LEDs/lasers default to PF 0.95.
  const pf =
    group.type === 'blinder' && !group.catalogId
      ? 1.0
      : entry?.id === 'mole-richardson-molefay-4lite'
        ? 1.0
        : 0.95;
  return { watts, pf };
}

function departmentForHardware(type: HardwareKind): PowerCircuit['department'] {
  const cat = HARDWARE_ALLOWANCE[type].category;
  if (cat === 'Lasers') return 'Lasers';
  if (cat === 'Smoke & FX') return 'Smoke & FX';
  return 'Lighting';
}

interface PendingCircuit {
  id: string;
  groupLabel: string;
  department: PowerCircuit['department'];
  description: string;
  units: number;
  watts: number;
  powerFactor: number;
  va: number;
  amps: number;
  breakerA: number;
  utilization: number;
  pinnedPhase?: PhaseId;
  status: CircuitStatus;
  note?: string;
  source?: PowerCircuitSource;
}

function cmpAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function worseCircuitStatus(a: CircuitStatus, b: CircuitStatus): CircuitStatus {
  const rank: Record<CircuitStatus, number> = { ok: 0, caution: 1, overload: 2 };
  return rank[b] > rank[a] ? b : a;
}

export function circuitStatusFor(amps: number, breakerA: number, continuousFactor: number): CircuitStatus {
  const util = breakerA > 0 ? amps / breakerA : 0;
  if (util > 1.0 + 1e-9) return 'overload';
  if (util > continuousFactor + 1e-9) return 'caution';
  return 'ok';
}

/**
 * Pack `count` identical units into branch circuits without exceeding the 80% continuous VA limit
 * (or placing 1 unit per circuit when a single unit exceeds the continuous rating).
 */
function packUnitsIntoCircuits(
  baseLabel: string,
  department: PowerCircuit['department'],
  description: string,
  count: number,
  unitWatts: number,
  pf: number,
  spec: PowerSystemSpec,
  pinnedPhase?: PhaseId,
  note?: string,
  sourceGroup?: { podIndex: number | null; groupIndex: number },
): PendingCircuit[] {
  if (count <= 0 || unitWatts <= 0) return [];
  const unitVa = unitWatts / pf;
  const usableVa = spec.branchBreakerA * spec.voltageLN * spec.continuousFactor;
  const maxUnitsPerCircuit = Math.max(1, Math.floor((usableVa + 1e-9) / unitVa));
  const circuitCount = Math.ceil(count / maxUnitsPerCircuit);
  const out: PendingCircuit[] = [];
  let remaining = count;
  let firstUnit = 0;
  for (let i = 0; i < circuitCount; i++) {
    const units = Math.min(remaining, maxUnitsPerCircuit);
    remaining -= units;
    const watts = Math.round(units * unitWatts);
    const va = watts / pf;
    const amps = va / spec.voltageLN;
    const id = circuitCount === 1 ? baseLabel : `${baseLabel}-${String(i + 1).padStart(2, '0')}`;
    const status = circuitStatusFor(amps, spec.branchBreakerA, spec.continuousFactor);
    out.push({
      id,
      groupLabel: baseLabel,
      department,
      description,
      units,
      watts,
      powerFactor: pf,
      va,
      amps,
      breakerA: spec.branchBreakerA,
      utilization: amps / spec.branchBreakerA,
      pinnedPhase,
      status,
      note:
        status === 'overload'
          ? `Single unit exceeds ${spec.branchBreakerA} A breaker — requires dedicated high-current circuit`
          : note,
      source: sourceGroup
        ? {
            podIndex: sourceGroup.podIndex,
            groupIndex: sourceGroup.groupIndex,
            firstUnit,
            unitCount: units,
          }
        : undefined,
    });
    firstUnit += units;
  }
  return out;
}

/** Split an aggregate wattage block (e.g. LED wall, Audio, FOH, Scenery) into circuits under 80% continuous VA. */
function splitAggregateIntoCircuits(
  baseLabel: string,
  department: PowerCircuit['department'],
  description: string,
  totalWatts: number,
  pf: number,
  spec: PowerSystemSpec,
  pinnedPhase?: PhaseId,
  note?: string,
): PendingCircuit[] {
  if (totalWatts <= 0) return [];
  const totalVa = totalWatts / pf;
  const usableVa = spec.branchBreakerA * spec.voltageLN * spec.continuousFactor;
  const circuitCount = Math.max(1, Math.ceil(totalVa / usableVa));
  const baseW = Math.floor(totalWatts / circuitCount);
  const remW = totalWatts - baseW * circuitCount;
  const out: PendingCircuit[] = [];
  for (let i = 0; i < circuitCount; i++) {
    const watts = baseW + (i < remW ? 1 : 0);
    const va = watts / pf;
    const amps = va / spec.voltageLN;
    const id = circuitCount === 1 ? baseLabel : `${baseLabel}-${String(i + 1).padStart(2, '0')}`;
    out.push({
      id,
      groupLabel: baseLabel,
      department,
      description,
      units: 1,
      watts,
      powerFactor: pf,
      va,
      amps,
      breakerA: spec.branchBreakerA,
      utilization: amps / spec.branchBreakerA,
      pinnedPhase,
      status: circuitStatusFor(amps, spec.branchBreakerA, spec.continuousFactor),
      note,
    });
  }
  return out;
}

/** Ensure unique deterministic circuit IDs across all groups sharing a custom label. */
function deduplicateCircuitIds(items: PendingCircuit[]): PendingCircuit[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return items.map((item) => {
    if ((counts.get(item.id) ?? 0) <= 1) return item;
    const n = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, n);
    return { ...item, id: `${item.id}#${n}` };
  });
}

/**
 * Compute linear 3-phase Wye neutral current from phase currents Ia, Ib, Ic (120° apart).
 * Returns 0 when balanced (Ia == Ib == Ic) and I when only one phase is loaded.
 */
export function computeNeutralCurrent(ia: number, ib: number, ic: number): number {
  const rad = ia * ia + ib * ib + ic * ic - ia * ib - ib * ic - ic * ia;
  return Math.sqrt(Math.max(0, rad));
}

function pickRecommendedFeeder(standardFeeders: readonly number[], requiredA: number): number {
  for (const f of standardFeeders) {
    if (f >= requiredA - 1e-9) return f;
  }
  return standardFeeders[standardFeeders.length - 1];
}

/**
 * Compute dimmer/power circuits, deterministic LPT three-phase balance, neutral current,
 * feeder/generator sizing, and intermittent hoist headroom.
 * Invariant: `totals.totalW === calculateProductionEstimate(rig, stage).totalWatts`.
 */
export function computePowerReport(sourceRig: RigConfig, stage?: NativeStage): PowerReport {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const estimate = calculateProductionEstimate(sourceRig, stage);

  const systemId: PowerSystemId =
    rig.power?.system && Object.hasOwn(POWER_SYSTEMS, rig.power.system)
      ? rig.power.system
      : DEFAULT_POWER_SYSTEM;
  const spec = POWER_SYSTEMS[systemId];

  const pinByTarget = new Map<PowerPinTarget, PhaseId>();
  for (const pin of rig.power?.pins ?? []) {
    if (!pinByTarget.has(pin.target)) pinByTarget.set(pin.target, pin.phase);
  }

  const pending: PendingCircuit[] = [];

  // 1. Overhead truss fixtures (exact match to productionEstimator fixture wattage).
  rig.trussPods.forEach((pod, podIdx) => {
    const defaultLabel = `LX${podIdx + 1}`;
    pod.fixtures.forEach((fg, groupIdx) => {
      const { watts, pf } = groupUnitWattsAndPf(fg);
      const label = fg.circuitGroup?.trim() || defaultLabel;
      const items = packUnitsIntoCircuits(
        label,
        departmentForHardware(fg.type),
        `${pod.name}: ${fg.modelName}`,
        fg.count,
        watts,
        pf,
        spec,
        fg.phase,
        undefined,
        { podIndex: podIdx, groupIndex: groupIdx },
      );
      pending.push(...items);
    });
  });

  // 2. Floor FX & floor beams/lasers.
  rig.floorFx.forEach((fx, fxIdx) => {
    const { watts, pf } = groupUnitWattsAndPf(fx);
    const label = fx.circuitGroup?.trim() || `FX${fxIdx + 1}`;
    const items = packUnitsIntoCircuits(
      label,
      departmentForHardware(fx.type),
      `Floor: ${fx.modelName}`,
      fx.count,
      watts,
      pf,
      spec,
      fx.phase,
      undefined,
      { podIndex: null, groupIndex: fxIdx },
    );
    pending.push(...items);
  });

  // 3. Non-fixture continuous loads derived directly from estimate.equipmentItems so totalW parity is guaranteed.
  const ledWatts = estimate.equipmentItems
    .filter((i) => i.kind === 'led')
    .reduce((sum, i) => sum + i.watts, 0);
  if (ledWatts > 0) {
    pending.push(
      ...splitAggregateIntoCircuits(
        'LED',
        'LED Video',
        'LED video walls (max white nameplate)',
        Math.round(ledWatts),
        0.95,
        spec,
        pinByTarget.get('ledWall'),
      ),
    );
  }

  const audioWatts = estimate.equipmentItems
    .filter((i) => i.kind === 'audio')
    .reduce((sum, i) => sum + i.watts, 0);
  if (audioWatts > 0) {
    pending.push(
      ...splitAggregateIntoCircuits(
        'AUD',
        'Audio',
        'Audio racks, PA & subs (nameplate; est. ⅛-power typical)',
        Math.round(audioWatts),
        0.95,
        spec,
        pinByTarget.get('audio'),
        'Audio amplifiers typically draw ~⅛ of rated nameplate power during program material.',
      ),
    );
  }

  const fohWatts = estimate.equipmentItems
    .filter((i) => i.kind === 'deck')
    .reduce((sum, i) => sum + i.watts, 0);
  if (fohWatts > 0) {
    pending.push(
      ...splitAggregateIntoCircuits(
        'FOH',
        'Stage & FOH',
        'FOH control & stage utility',
        Math.round(fohWatts),
        0.95,
        spec,
        pinByTarget.get('foh'),
      ),
    );
  }

  const propWatts = estimate.equipmentItems
    .filter((i) => i.kind === 'prop')
    .reduce((sum, i) => sum + i.watts, 0);
  if (propWatts > 0) {
    pending.push(
      ...splitAggregateIntoCircuits(
        'SCN',
        'Scenery',
        'Scenic blowers & practicals',
        Math.round(propWatts),
        0.95,
        spec,
      ),
    );
  }

  // 4. Chain hoists — intermittent load (not part of continuous 3-phase balance, checked against feeder headroom).
  const motorItems = estimate.equipmentItems.filter((i) => i.kind === 'motor');
  const motorWatts = Math.round(motorItems.reduce((sum, i) => sum + i.watts, 0));
  const hoistCount = motorItems.reduce((sum, i) => sum + (i.unitCount ?? 0), 0);
  const motorPf = 0.8;
  const motorVa = motorWatts / motorPf;
  const motorAmpsPerPhase =
    motorVa > 0
      ? spec.phases === 3
        ? motorVa / (Math.sqrt(3) * spec.voltageLL)
        : motorVa / spec.voltageLN
      : 0;
  const intermittent: IntermittentMotorLoad = {
    hoistCount,
    watts: motorWatts,
    powerFactor: motorPf,
    va: motorVa,
    ampsPerPhase: motorAmpsPerPhase,
    note:
      hoistCount > 0
        ? `Intermittent 3-phase motor load (PF ${motorPf}; starting inrush can reach 4–6× running current). Excluded from continuous balance; checked against feeder & generator headroom.`
        : 'No motorized chain hoists in this rig.',
  };

  // 5. Phase assignment: pinned loads first, then deterministic LPT (largest VA first, tie-break L1 < L2 < L3 then code-unit circuit ID).
  const deduped = deduplicateCircuitIds(pending);
  const activePhases: readonly PhaseId[] = spec.phases === 3 ? PHASE_IDS : ['L1'];
  const phaseVa: Record<PhaseId, number> = { L1: 0, L2: 0, L3: 0 };

  const pinnedItems = deduped
    .filter((c) => c.pinnedPhase !== undefined)
    .sort((a, b) => cmpAscii(a.id, b.id));
  const autoItems = deduped
    .filter((c) => c.pinnedPhase === undefined)
    .sort((a, b) => b.va - a.va || cmpAscii(a.id, b.id));

  const assigned: PowerCircuit[] = [];

  for (const item of pinnedItems) {
    const phase: PhaseId = spec.phases === 3 ? item.pinnedPhase! : 'L1';
    phaseVa[phase] += item.va;
    assigned.push({
      id: item.id,
      groupLabel: item.groupLabel,
      department: item.department,
      description: item.description,
      units: item.units,
      watts: item.watts,
      powerFactor: item.powerFactor,
      va: item.va,
      amps: item.amps,
      breakerA: item.breakerA,
      utilization: item.utilization,
      phase,
      pinned: true,
      status: item.status,
      note: item.note,
      ...(item.source ? { source: item.source } : {}),
    });
  }

  for (const item of autoItems) {
    let bestPhase: PhaseId = activePhases[0];
    let bestLoad = phaseVa[bestPhase];
    for (let i = 1; i < activePhases.length; i++) {
      const p = activePhases[i];
      if (phaseVa[p] < bestLoad - 1e-9) {
        bestLoad = phaseVa[p];
        bestPhase = p;
      }
    }
    phaseVa[bestPhase] += item.va;
    assigned.push({
      id: item.id,
      groupLabel: item.groupLabel,
      department: item.department,
      description: item.description,
      units: item.units,
      watts: item.watts,
      powerFactor: item.powerFactor,
      va: item.va,
      amps: item.amps,
      breakerA: item.breakerA,
      utilization: item.utilization,
      phase: bestPhase,
      pinned: false,
      status: item.status,
      note: item.note,
      ...(item.source ? { source: item.source } : {}),
    });
  }

  assigned.sort((a, b) => cmpAscii(a.phase, b.phase) || cmpAscii(a.id, b.id));

  const phases: PhaseLoadSummary[] = activePhases.map((phase) => {
    const group = assigned.filter((c) => c.phase === phase);
    const watts = group.reduce((s, c) => s + c.watts, 0);
    const va = group.reduce((s, c) => s + c.va, 0);
    const amps = va / spec.voltageLN;
    return {
      phase,
      circuitCount: group.length,
      watts,
      kw: watts / 1000,
      va,
      kva: va / 1000,
      amps,
    };
  });

  const continuousW = assigned.reduce((s, c) => s + c.watts, 0);
  const continuousVa = assigned.reduce((s, c) => s + c.va, 0);
  const continuousKva = continuousVa / 1000;
  // Computed directly from circuits + intermittent motors (equals estimate.totalWatts).
  const totalW = continuousW + motorWatts;

  const phaseAmps = phases.map((p) => p.amps);
  const maxPhaseAmps = phaseAmps.length ? Math.max(...phaseAmps) : 0;
  const minPhaseAmps = phaseAmps.length ? Math.min(...phaseAmps) : 0;
  const avgPhaseAmps = phaseAmps.length ? phaseAmps.reduce((a, b) => a + b, 0) / phaseAmps.length : 0;
  const imbalancePct =
    spec.phases === 3 && avgPhaseAmps > 1e-9 ? ((maxPhaseAmps - minPhaseAmps) / avgPhaseAmps) * 100 : 0;

  const neutralAmps =
    spec.phases === 3
      ? computeNeutralCurrent(phases[0]?.amps ?? 0, phases[1]?.amps ?? 0, phases[2]?.amps ?? 0)
      : maxPhaseAmps;

  const maxPhaseWithHoistsAmps = maxPhaseAmps + intermittent.ampsPerPhase;
  const recommendedFeederA = pickRecommendedFeeder(
    spec.standardFeedersA,
    Math.max(maxPhaseAmps / spec.continuousFactor, maxPhaseWithHoistsAmps),
  );
  const configuredFeederA =
    rig.power?.feederA !== undefined && Number.isFinite(rig.power.feederA) && rig.power.feederA > 0
      ? rig.power.feederA
      : null;
  const activeFeederA = configuredFeederA ?? recommendedFeederA;
  const feederUtilization = activeFeederA > 0 ? maxPhaseAmps / activeFeederA : 0;
  const feederWithHoistsUtilization = activeFeederA > 0 ? maxPhaseWithHoistsAmps / activeFeederA : 0;
  const continuousFeederStatus = circuitStatusFor(maxPhaseAmps, activeFeederA, spec.continuousFactor);
  const hoistHeadroomStatus: CircuitStatus =
    activeFeederA > 0 && maxPhaseWithHoistsAmps > activeFeederA + 1e-9 ? 'overload' : 'ok';
  const feederStatus = worseCircuitStatus(continuousFeederStatus, hoistHeadroomStatus);
  const peakKvaWithHoists = continuousKva + motorVa / 1000;
  const recommendedGeneratorKva =
    Math.ceil((peakKvaWithHoists * 1.25) / 5) * 5 || (peakKvaWithHoists > 0 ? 5 : 0);

  const overloadedCircuits = assigned.filter((c) => c.status === 'overload').length;
  const cautionCircuits = assigned.filter((c) => c.status === 'caution').length;

  return {
    system: spec,
    circuits: assigned,
    phases,
    intermittent,
    totals: {
      continuousW,
      continuousVa,
      continuousKva,
      intermittentW: motorWatts,
      totalW,
      audioTypicalEighthW: Math.round(audioWatts / 8),
      maxPhaseAmps,
      minPhaseAmps,
      avgPhaseAmps,
      imbalancePct,
      neutralAmps,
      maxPhaseWithHoistsAmps,
      recommendedFeederA,
      configuredFeederA,
      feederUtilization,
      feederWithHoistsUtilization,
      feederStatus,
      recommendedGeneratorKva,
      overloadedCircuits,
      cautionCircuits,
    },
    harmonicNote:
      'Linear Wye neutral estimate only. Switch-mode power supplies (LED walls, moving lights) generate triplen harmonics that can push neutral current toward √3× phase current — specify a 200% rated neutral on 3-phase touring feeders.',
    disclaimer: RIGGING_DISCLAIMER,
  };
}

export const RIGGING_POWER_CSV_HEADERS = [
  'section',
  'pod_or_group',
  'item',
  'detail',
  'load_or_watts',
  'unit',
  'secondary_metric',
  'limit_or_rating',
  'utilization_pct',
  'status',
  'notes',
] as const;

/**
 * Generate a unified, Excel-friendly (UTF-8 BOM, CRLF) RFC 4180 CSV rigging & power report
 * with `section` values: `disclaimer | point | span | flown | circuit | phase | summary`.
 */
export function riggingPowerCsv(
  rig: RigConfig,
  stage?: NativeStage,
  precomputedLoads?: RigLoadsReport,
  precomputedPower?: PowerReport,
): string {
  const loads = precomputedLoads ?? evaluateRigLoads(rig, stage);
  const power = precomputedPower ?? computePowerReport(rig, stage);
  const activeFeederA = power.totals.configuredFeederA ?? power.totals.recommendedFeederA;
  const rows: CsvValue[][] = [
    [...RIGGING_POWER_CSV_HEADERS],
    ['disclaimer', rig.name, 'Guidance only', power.system.label, '', '', '', '', '', 'INFO', RIGGING_DISCLAIMER],
  ];

  for (const pod of loads.pods) {
    for (const pt of pod.points) {
      rows.push([
        'point',
        pod.podName,
        `${pt.label} (${pod.hoistName})`,
        `x=${pt.localX.toFixed(2)}m z=${pt.localZ.toFixed(2)}m`,
        Number(pt.hoistLoadKg.toFixed(1)),
        'kg',
        Number(pt.roofLoadKg.toFixed(1)),
        pt.effectiveWllKg !== null ? Math.round(pt.effectiveWllKg) : '',
        pt.utilization !== null ? Math.round(pt.utilization * 100) : '',
        statusLabelText(pt.status),
        [
          pt.kineticLoadKg !== null ? `kinetic x1.2=${pt.kineticLoadKg.toFixed(1)}kg` : '',
          pod.d8Derated ? '50% D8 over-people guidance' : '',
          pt.uplift ? 'UPLIFT (negative reaction)' : '',
        ]
          .filter(Boolean)
          .join('; '),
      ]);
    }
    for (const sp of pod.spans) {
      rows.push([
        'span',
        pod.podName,
        `${sp.fromLabel}-${sp.toLabel} (${pod.trussProfileName})`,
        `${sp.spanM.toFixed(2)} m span`,
        Number(sp.maxMomentKgM.toFixed(1)),
        'kg*m',
        '',
        sp.allowableMomentKgM !== null ? Number(sp.allowableMomentKgM.toFixed(1)) : '',
        sp.utilization !== null ? Math.round(sp.utilization * 100) : '',
        statusLabelText(sp.status),
        sp.note ?? '',
      ]);
    }
  }

  for (const other of loads.otherFlown) {
    rows.push([
      'flown',
      other.category,
      other.label,
      other.detail,
      Number(other.totalWeightKg.toFixed(1)),
      'kg',
      Number(other.perPointEstimateKg.toFixed(1)),
      `${other.recommendedPoints} pts`,
      '',
      other.estimated ? 'Estimate' : 'Datasheet',
      'Separate flown load (not included in truss pod solver)',
    ]);
  }

  for (const c of power.circuits) {
    rows.push([
      'circuit',
      c.groupLabel,
      c.id,
      `${c.department} — ${c.description} (${c.units})`,
      c.watts,
      'W',
      Number(c.amps.toFixed(2)),
      `${c.breakerA}A ${c.phase}${c.pinned ? ' (pinned)' : ''}`,
      Math.round(c.utilization * 100),
      c.status.toUpperCase(),
      c.note ?? '',
    ]);
  }

  for (const p of power.phases) {
    const phaseStatus = circuitStatusFor(p.amps, activeFeederA, power.system.continuousFactor);
    rows.push([
      'phase',
      power.system.shortLabel,
      p.phase,
      `${p.circuitCount} circuits`,
      p.watts,
      'W',
      Number(p.amps.toFixed(2)),
      `${activeFeederA}A feeder`,
      Math.round((p.amps / activeFeederA) * 100),
      phaseStatus.toUpperCase(),
      `${p.kva.toFixed(2)} kVA`,
    ]);
  }

  rows.push([
    'summary',
    rig.name,
    'Rigging totals',
    `${loads.totals.podCount} pods / ${loads.totals.hoistPointCount} points`,
    Number(loads.totals.totalSuspendedKg.toFixed(1)),
    'kg',
    Number(loads.totals.totalRoofLoadKg.toFixed(1)),
    `Other flown ${loads.totals.otherFlownKg.toFixed(1)} kg`,
    '',
    statusLabelText(loads.worstStatus),
    `Clamps ${loads.totals.clampAllowanceKg.toFixed(1)} kg; Cables +10% ${loads.totals.cableAllowanceKg.toFixed(1)} kg`,
  ]);

  rows.push([
    'summary',
    rig.name,
    'Power totals',
    `${power.system.shortLabel} · Imbalance ${power.totals.imbalancePct.toFixed(1)}% · Neutral ${power.totals.neutralAmps.toFixed(1)} A`,
    power.totals.totalW,
    'W',
    Number(power.totals.maxPhaseAmps.toFixed(2)),
    `${power.totals.recommendedFeederA}A rec feeder / ${power.totals.recommendedGeneratorKva} kVA gen`,
    Math.round(power.totals.feederUtilization * 100),
    power.totals.feederStatus.toUpperCase(),
    `Continuous ${power.totals.continuousW} W + intermittent hoists ${power.totals.intermittentW} W; ${power.harmonicNote}`,
  ]);

  return formatCsv(rows, { bom: true });
}

/**
 * Stable position key for a resolved rig fixture group (pod index or `'floor'`, plus group index).
 * Used with `unitCircuitIndex()` so paperwork lookups stay exact even when group IDs repeat or
 * colliding circuit labels are deduplicated (`LX1#1`, `LX1#2`).
 */
export function unitCircuitPosKey(podIndex: number | null, groupIndex: number): string {
  return podIndex === null ? `floor:${groupIndex}` : `pod:${podIndex}:${groupIndex}`;
}

/**
 * Build a unit-level circuit and phase lookup directly from a `PowerReport`'s emitted circuits.
 * Never recomputes circuit packing outside `computePowerReport()`, preserving deduped IDs and phases.
 */
export function unitCircuitIndex(
  report: PowerReport,
): (posKey: string, unitIndex: number) => { circuitId: string; phase: PhaseId } | undefined {
  const byPos = new Map<
    string,
    Array<{ firstUnit: number; endUnit: number; circuitId: string; phase: PhaseId }>
  >();
  for (const c of report.circuits) {
    if (!c.source) continue;
    const key = unitCircuitPosKey(c.source.podIndex, c.source.groupIndex);
    let spans = byPos.get(key);
    if (!spans) {
      spans = [];
      byPos.set(key, spans);
    }
    spans.push({
      firstUnit: c.source.firstUnit,
      endUnit: c.source.firstUnit + c.source.unitCount,
      circuitId: c.id,
      phase: c.phase,
    });
  }
  return (posKey: string, unitIndex: number) => {
    const spans = byPos.get(posKey);
    if (!spans) return undefined;
    for (const s of spans) {
      if (unitIndex >= s.firstUnit && unitIndex < s.endUnit) {
        return { circuitId: s.circuitId, phase: s.phase };
      }
    }
    return undefined;
  };
}
