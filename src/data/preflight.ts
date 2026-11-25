import type { RigConfig, ShowCue, ShowState } from '../types/show';
import type { IldaClip } from './ilda';
import type { NativeStage } from './showFile';
import { formatCsv, type CsvValue } from './csv';
import { buildDmxPatch } from './dmxPatch';
import { getCatalogEntry } from './equipmentCatalog';
import {
  classifyPhysicalGroup,
  GENERIC_SIMULATED_LABEL,
  isSerialBlockedFixtureGroup,
  SIMULATION_ONLY_LABEL,
} from '../dmx/physicalDmx';
import { computePowerReport, type PowerReport } from './powerReport';
import { evaluateRigLoads, RIGGING_DISCLAIMER, type RigLoadsReport } from './rigLoads';
import { resolveStudioGeometry } from './studioGeometry';
import { placeFixtures } from './fixturePlacement';
import {
  CROWD_SCAN_WARNING,
  formatClearanceM,
  LASER_SAFETY_DISCLAIMER,
  MIN_AUDIENCE_CLEARANCE_M,
} from './laserSafety';
import {
  AIM_CALIBRATION_NOTE,
  checkRigAimReachability,
  evaluateLaserZones,
  evaluateStaticHeadMeasures,
  LASER_LSO_NOTICE,
  type FixtureMeasurement,
  type LaserHazardZone,
} from './measure';
import type { DmxOutputSettings } from '../dmx/liveDmx';

export const PREFLIGHT_EVALUATOR_VERSION = 'stageforge-preflight-v1';

export type PreflightOutcome = 'pass' | 'warn' | 'fail';

export type PreflightRowKind = 'fixture' | 'laser' | 'rigging' | 'power';

export type PreflightOverallStatus = 'not_checked' | 'blocked' | 'warnings' | 'passed';

export interface PreflightFinding {
  readonly code: string;
  readonly outcome: PreflightOutcome;
  readonly message: string;
}

export interface PreflightRow {
  readonly id: string;
  readonly kind: PreflightRowKind;
  readonly label: string;
  readonly location: string;
  readonly groupId?: string;
  readonly projectorKey?: string;
  readonly outcome: PreflightOutcome;
  /** True for hard failures that block arming and cannot be acknowledged away. */
  readonly hardBlock: boolean;
  /** True when the user can satisfy this warning row via an explicit acknowledgement checkbox. */
  readonly canAcknowledge: boolean;
  /** True for laser projector rows (never skippable — each requires explicit ack or physical DMX inhibit). */
  readonly isLaser: boolean;
  /** True when this laser projector has an unresolved hazard/unknown assessment and must be inhibited to 0 to arm. */
  readonly requiresLaserInhibit: boolean;
  /** True when the user can inhibit this laser projector's physical DMX channels to 0 for the session. */
  readonly canInhibitLaser: boolean;
  /** Stable fingerprint of this row's inputs so edits invalidate stale acknowledgements. */
  readonly rowFingerprint: string;
  readonly summary: string;
  readonly findings: readonly PreflightFinding[];
}

export interface PreflightAcknowledgementState {
  /** Whether the user has explicitly run/confirmed pre-flight for `checkedRevision`. */
  readonly checked: boolean;
  /** The `configRevision` at the time the user ran/reviewed pre-flight. */
  readonly checkedRevision: string | null;
  /** Non-laser warning row acknowledgements: `rowId -> rowFingerprint`. */
  readonly acknowledgedRows: Readonly<Record<string, string>>;
  /** Assessed & clear laser projector acknowledgements: `projectorKey -> configRevision`. */
  readonly acknowledgedLasers: Readonly<Record<string, string>>;
  /** Laser projectors explicitly inhibited to physical DMX 0 for this session: `projectorKey -> configRevision`. */
  readonly inhibitedLasers: Readonly<Record<string, string>>;
}

export const EMPTY_PREFLIGHT_ACKS: PreflightAcknowledgementState = Object.freeze({
  checked: false,
  checkedRevision: null,
  acknowledgedRows: Object.freeze({}),
  acknowledgedLasers: Object.freeze({}),
  inhibitedLasers: Object.freeze({}),
});

export interface PreflightReport {
  readonly evaluatorVersion: string;
  readonly configRevision: string;
  readonly evaluatedAtIso: string;
  readonly stale: boolean;
  readonly checked: boolean;
  readonly overallStatus: PreflightOverallStatus;
  /** Visible badge label: "Not checked", "Blocked (N)", "N warnings", or "Checks passed" (never "Ready"/"safe"). */
  readonly badgeLabel: string;
  readonly calibrationNote: string;
  readonly disclaimer: string;
  readonly lsoNotice: string;
  readonly crowdScanWarning: string | null;
  readonly rows: readonly PreflightRow[];
  readonly laserZones: readonly LaserHazardZone[];
  readonly counts: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly unacknowledgedWarnings: number;
    readonly laserTotal: number;
    readonly laserAddressed: number;
    readonly laserInhibited: number;
  };
  /** True ONLY when checked, not stale, zero hard blocks, all warnings acknowledged, and every laser addressed. */
  readonly canArm: boolean;
  /** Reasons preventing arming right now (empty iff `canArm` is true). */
  readonly blockingReasons: readonly string[];
  /** Projector keys whose physical DMX channels must be forced to neutral 0 for this session. */
  readonly inhibitedLaserKeys: readonly string[];
}

/** Deterministic 32-bit FNV-1a hex hash (pure, allocation-light, Node + browser safe). */
function fnv1aHex(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic JSON serializer with sorted object keys for stable revision hashing. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(Math.round(value * 1e4) / 1e4);
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (obj[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Hash EVERY ILDA frame point coordinate & blanking flag (never filename alone, never strided). */
export function hashIldaClipContent(clip: IldaClip | null | undefined): string {
  if (!clip) return 'none';
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(clip.frames.length);
  mix(clip.totalPoints);
  for (let f = 0; f < clip.frames.length; f++) {
    const frame = clip.frames[f];
    mix(frame.count);
    mix(frame.litCount);
    for (let i = 0; i < frame.count; i++) {
      const idx = frame.offset + i;
      mix(clip.xy[idx * 2] | 0);
      mix(clip.xy[idx * 2 + 1] | 0);
      mix(clip.blank[idx] | 0);
    }
  }
  return `${clip.frames.length}:${clip.totalPoints}:${h.toString(16).padStart(8, '0')}`;
}

export interface PreflightInput {
  readonly rig: RigConfig;
  readonly stage?: NativeStage;
  readonly cues: readonly ShowCue[];
  readonly showState: ShowState;
  readonly ildaClip?: IldaClip | null;
  readonly dmxSettings?: Pick<
    DmxOutputSettings,
    'mode' | 'iface' | 'sacnMode' | 'sacnUniverse1' | 'sacnUniverse2' | 'sacnTargets' | 'artnetBase' | 'artnetTargets' | 'artnetBroadcast' | 'serialUniverse' | 'rateHz'
  >;
  readonly applyD8Derate?: boolean;
  readonly loads?: RigLoadsReport;
  readonly power?: PowerReport;
  /** Optional live measurements for continuous monitoring (never required for static safety evaluation). */
  readonly liveMeasurements?: readonly FixtureMeasurement[];
  readonly acks?: PreflightAcknowledgementState;
  /** Optional override for deterministic testing. */
  readonly evaluatedAtIso?: string;
}

/**
 * Deterministic authored-configuration revision fingerprint covering everything pre-flight depends on:
 * rig geometry/trusses/hoists/fixtures/patch/models/floorFx/power/audio/led, stage layout/walls,
 * EVERY cue's full authored state (including manualPan, manualTilt, movingGroups, beamZoom, laser,
 * motors, atmo, audioMap), full ILDA clip point data, DMX routing, and D8 derate mode.
 *
 * Intentionally excludes volatile runtime playback state (active `showState` during cue Go,
 * camera, overlay toggles, selection, elapsed clock) — runtime `showState` hazards are evaluated
 * continuously on every render/tick without falsely marking an already-checked show stale on cue Go.
 */
export function computePreflightRevision(input: Pick<
  PreflightInput,
  'rig' | 'stage' | 'cues' | 'ildaClip' | 'dmxSettings' | 'applyD8Derate'
> & { readonly showState?: ShowState }): string {
  const payload = stableStringify({
    v: PREFLIGHT_EVALUATOR_VERSION,
    rig: {
      venue: input.rig.venue,
      stageWidth: input.rig.stageWidth,
      stageDepth: input.rig.stageDepth,
      stageHeight: input.rig.stageHeight,
      platforms: input.rig.platforms ?? null,
      ledWall: input.rig.ledWall,
      audioRig: {
        lineArrays: input.rig.audioRig.lineArrays,
        boxesPerSide: input.rig.audioRig.boxesPerSide ?? null,
        monitorCount: input.rig.audioRig.monitorCount ?? null,
        subWall: input.rig.audioRig.subWall,
        subCount: input.rig.audioRig.subCount,
        djBooth: input.rig.audioRig.djBooth,
      },
      power: input.rig.power ?? null,
      trussPods: input.rig.trussPods,
      floorFx: input.rig.floorFx,
    },
    stage: input.stage ? { walls: input.stage.walls, layout: input.stage.layout ?? null } : null,
    cues: input.cues.map((c) => ({
      id: c.id,
      state: c.state,
    })),
    ilda: hashIldaClipContent(input.ildaClip),
    dmx: input.dmxSettings ?? null,
    d8: input.applyD8Derate ?? true,
  });
  return `${fnv1aHex(payload)}-${payload.length}`;
}

function worstOutcome(a: PreflightOutcome, b: PreflightOutcome): PreflightOutcome {
  const rank: Record<PreflightOutcome, number> = { pass: 0, warn: 1, fail: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Pure pre-flight safety evaluator. Evaluates EVERY fixture group, laser projector, rigging point,
 * and electrical circuit regardless of whether the Measure overlay or hit labels are visible.
 *
 * Three outcomes:
 * - Hard `fail` (patch conflict/overflow, rigging overload/uplift, electrical circuit/feeder overload,
 *   laser `audienceScan: true`): blocks arming, cannot be acknowledged away.
 * - `warn` / `unknown` (non-laser): requires explicit per-row acknowledgement.
 * - Lasers: every projector always gets its own row and can never be skipped. An unassessed
 *   (`unknown` NOHD) or audience-breaching (< 3.0 m) laser blocks arming unless explicitly inhibited
 *   to physical DMX 0 for the session; an assessed clear laser still requires explicit per-projector ack.
 */
export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const acks = input.acks ?? EMPTY_PREFLIGHT_ACKS;
  const configRevision = computePreflightRevision(input);
  const evaluatedAtIso = input.evaluatedAtIso ?? new Date().toISOString();
  const applyD8Derate = input.applyD8Derate ?? true;

  const { rig } = resolveStudioGeometry(input.rig, input.stage?.layout);
  const patch = buildDmxPatch(rig);
  const loads = input.loads ?? evaluateRigLoads(input.rig, input.stage, { applyD8Derate });
  const power = input.power ?? computePowerReport(input.rig, input.stage);
  const placements = placeFixtures(rig);

  // Count placed units per (podId, groupId) to detect unplaced units (empty mount slots).
  const placedCounts = new Map<string, number>();
  for (const unit of placements) {
    const key = `${unit.podId ?? 'floor'}:${unit.group.id}`;
    placedCounts.set(key, (placedCounts.get(key) ?? 0) + 1);
  }

  // Clone rig at lowest motorized trim (`motorMinY`) when any truss pod is motorized so kinetic drops
  // can never hide a laser or moving-head clearance breach.
  const hasLowerMotorTrim = input.rig.trussPods.some((p) => p.motorized && p.motorMinY < p.baseY - 1e-3);
  const lowestTrimRig: RigConfig | null = hasLowerMotorTrim
    ? {
        ...input.rig,
        trussPods: input.rig.trussPods.map((p) =>
          p.motorized && p.motorMinY < p.baseY ? { ...p, baseY: p.motorMinY } : p,
        ),
      }
    : null;

  // Always evaluate worst-case laser geometry across current showState AND every stored cue's laser state,
  // at both nominal trim and lowest motorized trim (`motorMinY`), with enabled:true so nothing hides a hazard.
  const worstCaseLaser: ShowState['laser'] = {
    ...input.showState.laser,
    enabled: true,
    intensity: Math.max(1, input.showState.laser.intensity),
  };
  const baseLaserEval = evaluateLaserZones(input.rig, worstCaseLaser, {
    stage: input.stage,
    ildaClip: input.ildaClip,
  });
  const cueBreachByProjector = new Map<string, { cueName: string; minClearanceM: number | null; stationary: boolean }>();
  const mergedLaserZones: LaserHazardZone[] = baseLaserEval.zones.map((z) => ({
    ...z,
    safety: { ...z.safety },
  }));
  const zoneByKey = new Map<string, number>();
  mergedLaserZones.forEach((z, idx) => zoneByKey.set(z.projectorKey, idx));

  const mergeLaserEval = (evalRes: ReturnType<typeof evaluateLaserZones>, sourceLabel?: string) => {
    for (const cz of evalRes.zones) {
      const idx = zoneByKey.get(cz.projectorKey);
      if (idx === undefined) continue;
      const cur = mergedLaserZones[idx];
      const worseClearance =
        cz.safety.minClearanceM !== null &&
        (cur.safety.minClearanceM === null || cz.safety.minClearanceM < cur.safety.minClearanceM);
      const nextMinClearance = worseClearance ? cz.safety.minClearanceM : cur.safety.minClearanceM;
      const nextEnters = cur.safety.entersAudienceBelowThreshold || cz.safety.entersAudienceBelowThreshold;
      const nextStationary = cur.safety.stationaryHazard || cz.safety.stationaryHazard;
      const nextAudienceInsideNohd = cur.audienceInsideNohd || cz.audienceInsideNohd;
      if (sourceLabel && (cz.safety.entersAudienceBelowThreshold || cz.safety.stationaryHazard)) {
        const prevCue = cueBreachByProjector.get(cz.projectorKey);
        if (
          !prevCue ||
          (cz.safety.minClearanceM !== null &&
            (prevCue.minClearanceM === null || cz.safety.minClearanceM < prevCue.minClearanceM))
        ) {
          cueBreachByProjector.set(cz.projectorKey, {
            cueName: sourceLabel,
            minClearanceM: cz.safety.minClearanceM,
            stationary: cz.safety.stationaryHazard,
          });
        }
      }
      mergedLaserZones[idx] = {
        ...cur,
        audienceInsideNohd: nextAudienceInsideNohd,
        safety: {
          ...cur.safety,
          minClearanceM: nextMinClearance,
          entersAudienceBelowThreshold: nextEnters,
          stationaryHazard: nextStationary,
        },
      };
    }
  };

  if (lowestTrimRig) {
    mergeLaserEval(
      evaluateLaserZones(lowestTrimRig, worstCaseLaser, { stage: input.stage, ildaClip: input.ildaClip }),
      'lowest motor trim',
    );
  }

  for (const cue of input.cues) {
    if (!cue.state.laser) continue;
    const mergedCueLaser: ShowState['laser'] = {
      ...worstCaseLaser,
      ...cue.state.laser,
      enabled: true,
      intensity: Math.max(1, cue.state.laser.intensity ?? 1),
    };
    mergeLaserEval(
      evaluateLaserZones(input.rig, mergedCueLaser, { stage: input.stage, ildaClip: input.ildaClip }),
      `cue "${cue.name}"`,
    );
    if (lowestTrimRig) {
      mergeLaserEval(
        evaluateLaserZones(lowestTrimRig, mergedCueLaser, { stage: input.stage, ildaClip: input.ildaClip }),
        `cue "${cue.name}" at lowest motor trim`,
      );
    }
  }
  const laserEval = { ...baseLaserEval, zones: mergedLaserZones };

  // Also check if any stored cue turns on audienceScan!
  const cueWithAudienceScan = input.cues.find((c) => c.state.laser?.audienceScan === true);
  const activeAudienceScan = input.showState.laser.audienceScan === true;

  const aimReachByGroup = checkRigAimReachability(input.rig, input.showState, input.stage);

  // Always evaluate static moving-head aim & audience clearance (axis + lower cone edge)
  // across current showState, lowest motorized trim, and cue-authored head aims regardless of overlay visibility.
  const combinedHeadMeasures: FixtureMeasurement[] = [
    ...evaluateStaticHeadMeasures(input.rig, input.showState, input.stage),
  ];
  if (lowestTrimRig) {
    combinedHeadMeasures.push(...evaluateStaticHeadMeasures(lowestTrimRig, input.showState, input.stage));
  }
  for (const cue of input.cues) {
    const cs = cue.state;
    if (
      cs.focusMarkId !== undefined ||
      cs.manualPan !== undefined ||
      cs.manualTilt !== undefined ||
      cs.movingGroups !== undefined ||
      cs.movementMode === 'manual' ||
      cs.movementMode === 'crowd_scan'
    ) {
      const cueHeadLook = {
        ...input.showState,
        focusMarkId: cs.focusMarkId ?? input.showState.focusMarkId,
        movementMode: cs.movementMode ?? input.showState.movementMode,
        manualPan: cs.manualPan ?? input.showState.manualPan,
        manualTilt: cs.manualTilt ?? input.showState.manualTilt,
        beamZoom: cs.beamZoom ?? input.showState.beamZoom,
        movingGroups: cs.movingGroups ?? input.showState.movingGroups,
      };
      combinedHeadMeasures.push(...evaluateStaticHeadMeasures(input.rig, cueHeadLook, input.stage));
      if (lowestTrimRig) {
        combinedHeadMeasures.push(...evaluateStaticHeadMeasures(lowestTrimRig, cueHeadLook, input.stage));
      }
    }
  }
  if (input.liveMeasurements && input.liveMeasurements.length > 0) {
    combinedHeadMeasures.push(...input.liveMeasurements);
  }

  const liveByGroup = new Map<string, { audienceBreach: number; limitWarn: number; noHit: number; worstClearanceM: number | null; seenBreachUnits: Set<string>; seenLimitUnits: Set<string> }>();
  for (const m of combinedHeadMeasures) {
    let rec = liveByGroup.get(m.groupId);
    if (!rec) {
      rec = {
        audienceBreach: 0,
        limitWarn: 0,
        noHit: 0,
        worstClearanceM: null,
        seenBreachUnits: new Set(),
        seenLimitUnits: new Set(),
      };
      liveByGroup.set(m.groupId, rec);
    }
    if (m.entersAudienceBelowThreshold) {
      if (!rec.seenBreachUnits.has(m.unitId)) {
        rec.seenBreachUnits.add(m.unitId);
        rec.audienceBreach++;
      }
      if (m.minAudienceClearanceM !== null) {
        rec.worstClearanceM =
          rec.worstClearanceM === null
            ? m.minAudienceClearanceM
            : Math.min(rec.worstClearanceM, m.minAudienceClearanceM);
      }
    }
    if ((m.nearPanLimit || m.nearTiltLimit) && !rec.seenLimitUnits.has(m.unitId)) {
      rec.seenLimitUnits.add(m.unitId);
      rec.limitWarn++;
    }
    if (m.hitKind === 'none') rec.noHit++;
  }

  const rows: PreflightRow[] = [];

  // Map each group object reference back to its podId (or null for floorFx).
  const podIdByGroup = new WeakMap<object, string | null>();
  for (const pod of rig.trussPods) {
    for (const fg of pod.fixtures) podIdByGroup.set(fg, pod.id);
  }
  for (const fx of rig.floorFx) podIdByGroup.set(fx, null);

  // 1. Per-fixture-group rows (non-laser groups; lasers get dedicated per-projector rows below)
  for (const row of patch.rows) {
    const isLaserGroup = row.group.type === 'laser' || row.group.type === 'floor_laser';
    const podId = podIdByGroup.get(row.group) ?? null;
    const placeKey = `${podId ?? 'floor'}:${row.group.id}`;
    const placedCount = placedCounts.get(placeKey) ?? 0;
    const unplacedCount = Math.max(0, row.group.count - placedCount);
    const phys = classifyPhysicalGroup(row.group);

    if (isLaserGroup) {
      // Check group-level DMX patch failures for laser groups so patch conflicts still hard-block!
      if (row.conflicts.length > 0 || row.end > 512 || unplacedCount > 0) {
        const findings: PreflightFinding[] = [];
        let outcome: PreflightOutcome = 'pass';
        let hardBlock = false;
        if (row.conflicts.length > 0) {
          findings.push({
            code: 'dmx_conflict',
            outcome: 'fail',
            message: `DMX address conflict on U${row.group.dmxUniverse} channels ${row.conflicts.slice(0, 6).join(', ')}.`,
          });
          outcome = 'fail';
          hardBlock = true;
        }
        if (row.end > 512) {
          findings.push({
            code: 'dmx_overflow',
            outcome: 'fail',
            message: `DMX footprint U${row.group.dmxUniverse}.${row.start}–${row.end} overflows universe 512.`,
          });
          outcome = 'fail';
          hardBlock = true;
        }
        if (unplacedCount > 0) {
          findings.push({
            code: 'unplaced_units',
            outcome: 'warn',
            message: `${unplacedCount} of ${row.group.count} unit(s) could not be placed on truss mount slots.`,
          });
          outcome = worstOutcome(outcome, 'warn');
        }
        const rowId = `group-patch:${placeKey}`;
        rows.push({
          id: rowId,
          kind: 'fixture',
          label: `${row.group.modelName} ×${row.group.count} (DMX patch)`,
          location: row.location,
          groupId: row.group.id,
          outcome,
          hardBlock,
          canAcknowledge: outcome === 'warn' && !hardBlock,
          isLaser: false,
          requiresLaserInhibit: false,
          canInhibitLaser: false,
          rowFingerprint: fnv1aHex(JSON.stringify({ rowId, findings })),
          summary: findings.map((f) => f.message).join(' '),
          findings,
        });
      }
      continue;
    }

    const findings: PreflightFinding[] = [];
    let outcome: PreflightOutcome = 'pass';
    let hardBlock = false;

    if (row.conflicts.length > 0) {
      findings.push({
        code: 'dmx_conflict',
        outcome: 'fail',
        message: `DMX conflict on U${row.group.dmxUniverse} (${row.conflicts.length} overlapping ch).`,
      });
      outcome = 'fail';
      hardBlock = true;
    }
    if (row.end > 512 || row.start < 1) {
      findings.push({
        code: 'dmx_overflow',
        outcome: 'fail',
        message: `DMX range U${row.group.dmxUniverse}.${row.start}–${row.end} exceeds 512 channels.`,
      });
      outcome = 'fail';
      hardBlock = true;
    }
    if (input.dmxSettings?.mode === 'serial' && isSerialBlockedFixtureGroup(row.group)) {
      findings.push({
        code: 'serial_watchdog_unsupported',
        outcome: 'fail',
        message:
          'USB Serial DMX lacks an out-of-process crash watchdog and is blocked when blinders, strobes, or atmospheric effects (smoke, haze, CO2) are patched. Switch transport to desktop sACN / Art-Net 4.',
      });
      outcome = 'fail';
      hardBlock = true;
    }
    if (unplacedCount > 0) {
      findings.push({
        code: 'unplaced_units',
        outcome: 'warn',
        message: `${unplacedCount} of ${row.group.count} unit(s) unplaced (no mount slot).`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }

    // Physical DMX personality status (Sprint 13 H1)
    if (phys.status === 'simulation-only') {
      findings.push({
        code: 'physical_sim_only',
        outcome: 'warn',
        message: `${SIMULATION_ONLY_LABEL} — physical DMX outputs neutral zeros.`,
      });
      outcome = worstOutcome(outcome, 'warn');
    } else if (phys.status === 'generic-simulated') {
      findings.push({
        code: 'physical_generic',
        outcome: 'warn',
        message: `${GENERIC_SIMULATED_LABEL}.`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }

    // Auxiliary safety-channel warning for fixtures whose hardware requires a separate safety DMX address (Codex review-05 R3).
    const catEntry = row.group.catalogId ? getCatalogEntry(row.group.catalogId) : undefined;
    if (catEntry?.auxSafetyChannelNote) {
      findings.push({
        code: 'aux_safety_channel_unreserved',
        outcome: 'warn',
        message: `Incomplete DMX patch: ${catEntry.auxSafetyChannelNote}`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }

    // Static aim reachability
    const reach = aimReachByGroup.get(row.group.id);
    if (reach && reach.unreachableCount > 0) {
      findings.push({
        code: 'aim_unreachable',
        outcome: 'warn',
        message: `${reach.unreachableCount} unit(s) cannot reach focus target: ${reach.reasons.join(' ')}`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }

    // Live runtime aim / audience clearance warnings (when live measurements supplied)
    const liveRec = liveByGroup.get(row.group.id);
    if (liveRec) {
      if (liveRec.audienceBreach > 0) {
        const clr = liveRec.worstClearanceM !== null ? `${liveRec.worstClearanceM.toFixed(1)} m` : `< ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m`;
        findings.push({
          code: 'beam_audience_clearance',
          outcome: 'warn',
          message: `${liveRec.audienceBreach} beam(s) enter audience zone below ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m (${clr}).`,
        });
        outcome = worstOutcome(outcome, 'warn');
      }
      if (liveRec.limitWarn > 0) {
        findings.push({
          code: 'aim_near_limit',
          outcome: 'warn',
          message: `${liveRec.limitWarn} head(s) within 5° of pan/tilt travel limit.`,
        });
        outcome = worstOutcome(outcome, 'warn');
      }
    }

    const rowId = `fixture:${placeKey}`;
    const summary =
      findings.length === 0
        ? `U${row.group.dmxUniverse}.${String(row.start).padStart(3, '0')}–${String(row.end).padStart(3, '0')} · Implemented personality · Checks passed`
        : findings.map((f) => f.message).join(' ');

    rows.push({
      id: rowId,
      kind: 'fixture',
      label: `${row.group.modelName} ×${row.group.count}`,
      location: row.location,
      groupId: row.group.id,
      outcome,
      hardBlock,
      canAcknowledge: outcome === 'warn' && !hardBlock,
      isLaser: false,
      requiresLaserInhibit: false,
      canInhibitLaser: false,
      // Bind fingerprint to patch + static aim reach/clearance/limit findings so changing aim invalidates prior acks.
      rowFingerprint: fnv1aHex(
        JSON.stringify({
          rowId,
          start: row.start,
          end: row.end,
          u: row.group.dmxUniverse,
          catalogId: row.group.catalogId ?? null,
          dmxMode: row.group.dmxMode ?? null,
          phys: phys.status,
          unplacedCount,
          reach: reach ?? null,
          audienceBreach: liveRec?.audienceBreach ?? 0,
          limitWarn: liveRec?.limitWarn ?? 0,
          conflicts: row.conflicts,
        }),
      ),
      summary,
      findings,
    });
  }

  // 2. Per-projector laser rows (NEVER skippable!)
  for (const zone of laserEval.zones) {
    const findings: PreflightFinding[] = [];
    let outcome: PreflightOutcome = 'warn';
    let hardBlock = false;
    let requiresLaserInhibit = false;

    if (input.dmxSettings?.mode === 'serial') {
      findings.push({
        code: 'serial_laser_blocked',
        outcome: 'fail',
        message:
          'USB Serial DMX lacks an out-of-process crash watchdog and is blocked when laser projectors are patched. Switch transport to desktop sACN / Art-Net 4.',
      });
      outcome = 'fail';
      hardBlock = true;
    }

    if (activeAudienceScan) {
      findings.push({
        code: 'laser_audience_scan',
        outcome: 'fail',
        message: CROWD_SCAN_WARNING,
      });
      outcome = 'fail';
      hardBlock = true;
    } else if (cueWithAudienceScan) {
      findings.push({
        code: 'cue_audience_scan',
        outcome: 'fail',
        message: `Cue "${cueWithAudienceScan.name}" enables audience scanning — ${CROWD_SCAN_WARNING} Disable audienceScan in cues or inhibit this projector to DMX 0.`,
      });
      outcome = 'fail';
      requiresLaserInhibit = true;
    }

    const cueBreach = cueBreachByProjector.get(zone.projectorKey);

    if (zone.nohd.status === 'unknown') {
      findings.push({
        code: 'laser_nohd_unknown',
        outcome: 'fail',
        message: `NOHD cannot assess (${zone.nohd.reason}) — inhibit laser DMX or select a verified catalogue laser.`,
      });
      outcome = 'fail';
      requiresLaserInhibit = true;
    } else if (zone.nohd.status === 'assumed') {
      findings.push({
        code: 'laser_nohd_assumed',
        outcome: 'warn',
        message: `NOHD ${zone.nohd.reason}`,
      });
    } else if (zone.nohd.status === 'within-aperture') {
      findings.push({
        code: 'laser_nohd_aperture',
        outcome: 'warn',
        message: zone.nohd.reason,
      });
    } else if (zone.nohd.nohdM !== null) {
      findings.push({
        code: 'laser_nohd_computed',
        outcome: 'warn',
        message: `NOHD ${zone.nohd.reason}`,
      });
    }

    if (zone.safety.entersAudienceBelowThreshold && zone.safety.minClearanceM !== null) {
      const cueSuffix = cueBreach ? ` (${cueBreach.cueName})` : '';
      findings.push({
        code: 'laser_audience_clearance',
        outcome: 'fail',
        message: `Beam enters audience zone below ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m (min clearance ${formatClearanceM(zone.safety.minClearanceM)} m)${cueSuffix} — raise pitch/trim or inhibit laser DMX.`,
      });
      outcome = 'fail';
      requiresLaserInhibit = true;
    } else if (zone.audienceInsideNohd && zone.nohd.nohdM !== null) {
      findings.push({
        code: 'laser_nohd_audience_overlap',
        outcome: 'warn',
        message: `Audience zone lies within ${Math.round(zone.nohd.nohdM)} m static NOHD envelope (vertical clearance ${
          zone.safety.minClearanceM !== null ? `${formatClearanceM(zone.safety.minClearanceM)} m` : 'clear'
        }).`,
      });
    }

    if (zone.safety.stationaryHazard) {
      findings.push({
        code: 'laser_stationary',
        outcome: 'fail',
        message: 'Stationary beam hazard: no scan-failure interlock in preview.',
      });
      outcome = 'fail';
      requiresLaserInhibit = true;
    }

    const laserEntry = getCatalogEntry(zone.catalogId);
    if (laserEntry?.laser && laserEntry.laser.maxScanAngleDeg === undefined) {
      findings.push({
        code: 'laser_scan_angle_unknown',
        outcome: 'warn',
        message: 'Maximum scan angle is not stated on the datasheet; ILDA audience clearance is evaluated conservatively at 60°.',
      });
    }

    // Physical DMX status for this laser group
    const groupRow = patch.rows.find((r) => (podIdByGroup.get(r.group) ?? null) === zone.podId && r.group.id === zone.groupId);
    if (groupRow) {
      const phys = classifyPhysicalGroup(groupRow.group);
      if (phys.status === 'simulation-only') {
        findings.push({
          code: 'laser_physical_sim_only',
          outcome: 'warn',
          message: `Physical DMX: ${SIMULATION_ONLY_LABEL} (neutral zeros sent).`,
        });
      } else if (phys.status === 'generic-simulated') {
        findings.push({
          code: 'laser_physical_generic',
          outcome: 'warn',
          message: `Physical DMX: ${GENERIC_SIMULATED_LABEL}.`,
        });
      }
    }

    const rowId = `laser:${zone.projectorKey}`;
    const laserRowFingerprint = fnv1aHex(
      JSON.stringify({
        configRevision,
        projectorKey: zone.projectorKey,
        outcome,
        hardBlock,
        requiresLaserInhibit,
        findings: findings.map((f) => [f.code, f.outcome, f.message]),
      }),
    );
    rows.push({
      id: rowId,
      kind: 'laser',
      label: zone.label,
      location: zone.podId ? rig.trussPods.find((p) => p.id === zone.podId)?.name ?? 'Truss' : 'Stage floor',
      groupId: zone.groupId,
      projectorKey: zone.projectorKey,
      outcome,
      hardBlock,
      canAcknowledge: !hardBlock && !requiresLaserInhibit,
      isLaser: true,
      requiresLaserInhibit,
      canInhibitLaser: !hardBlock,
      rowFingerprint: laserRowFingerprint, // Binds to authored revision + runtime laser findings
      summary: findings.map((f) => f.message).join(' '),
      findings,
    });
  }

  // 3. Rigging loads row
  {
    const findings: PreflightFinding[] = [];
    let outcome: PreflightOutcome = 'pass';
    let hardBlock = false;
    if (loads.totals.upliftPods > 0) {
      findings.push({
        code: 'rigging_uplift',
        outcome: 'fail',
        message: `${loads.totals.upliftPods} truss pod(s) have negative hoist uplift reaction.`,
      });
      outcome = 'fail';
      hardBlock = true;
    }
    if (loads.totals.overloadPods > 0) {
      findings.push({
        code: 'rigging_overload',
        outcome: 'fail',
        message: `${loads.totals.overloadPods} truss pod(s) exceed rated hoist or truss span capacity.`,
      });
      outcome = 'fail';
      hardBlock = true;
    }
    if (loads.totals.cautionPods > 0) {
      findings.push({
        code: 'rigging_caution',
        outcome: 'warn',
        message: `${loads.totals.cautionPods} truss pod(s) between 80% and 100% static rating.`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }
    const unknownPods = loads.pods.filter((p) => p.status === 'unknown');
    const unknownReasons = unknownPods.flatMap((p) =>
      p.warnings.length > 0 ? p.warnings.map((w) => `${p.podName}: ${w}`) : [`${p.podName}: rigging capacity cannot be assessed`],
    );
    if (unknownPods.length > 0) {
      findings.push({
        code: 'rigging_unknown',
        outcome: 'warn',
        message: `${unknownPods.length} truss pod(s) have unknown rigging capacity (${unknownReasons.slice(0, 2).join('; ')}). Verify profiles and hoist ratings on site.`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }
    const rowId = 'rigging:summary';
    rows.push({
      id: rowId,
      kind: 'rigging',
      label: 'Rigging & hoist loads',
      location: `${loads.pods.length} truss pod(s)`,
      outcome,
      hardBlock,
      canAcknowledge: outcome === 'warn' && !hardBlock,
      isLaser: false,
      requiresLaserInhibit: false,
      canInhibitLaser: false,
      rowFingerprint: fnv1aHex(
        JSON.stringify({
          rowId,
          uplift: loads.totals.upliftPods,
          overload: loads.totals.overloadPods,
          caution: loads.totals.cautionPods,
          unknown: unknownPods.length,
          unknownReasons,
          roofKg: Math.round(loads.totals.totalRoofLoadKg),
          d8: applyD8Derate,
        }),
      ),
      summary:
        findings.length === 0
          ? `Static roof load ${Math.round(loads.totals.totalRoofLoadKg)} kg · Checks passed (static guidance only)`
          : findings.map((f) => f.message).join(' '),
      findings,
    });
  }

  // 4. Power & feeder row
  {
    const findings: PreflightFinding[] = [];
    let outcome: PreflightOutcome = 'pass';
    let hardBlock = false;
    const hasConfiguredFeeder = power.totals.configuredFeederA !== null;
    const feederCapA = power.totals.configuredFeederA ?? power.totals.recommendedFeederA;
    if (power.totals.overloadedCircuits > 0) {
      findings.push({
        code: 'power_circuit_overload',
        outcome: hasConfiguredFeeder ? 'fail' : 'warn',
        message: hasConfiguredFeeder
          ? `${power.totals.overloadedCircuits} branch circuit(s) exceed configured ${power.system.branchBreakerA} A breaker capacity.`
          : `${power.totals.overloadedCircuits} estimated branch circuit(s) exceed single ${power.system.branchBreakerA} A / ${power.system.voltageLN} V breaker — verify site dimmer racks / 208 V distro.`,
      });
      if (hasConfiguredFeeder) {
        outcome = 'fail';
        hardBlock = true;
      } else {
        outcome = worstOutcome(outcome, 'warn');
      }
    }
    if (power.totals.feederStatus === 'overload') {
      findings.push({
        code: 'power_feeder_overload',
        outcome: hasConfiguredFeeder ? 'fail' : 'warn',
        message: hasConfiguredFeeder
          ? `Configured feeder (${feederCapA} A) overloaded by peak phase current (${power.totals.maxPhaseWithHoistsAmps.toFixed(1)} A incl. hoists).`
          : `Estimated whole-show load (${power.totals.maxPhaseWithHoistsAmps.toFixed(1)} A incl. hoists) exceeds single ${feederCapA} A distro — verify multi-distro site power.`,
      });
      if (hasConfiguredFeeder) {
        outcome = 'fail';
        hardBlock = true;
      } else {
        outcome = worstOutcome(outcome, 'warn');
      }
    } else if (power.totals.feederStatus === 'caution') {
      findings.push({
        code: 'power_feeder_caution',
        outcome: 'warn',
        message: `Feeder utilization ≥ 80% (${power.totals.maxPhaseWithHoistsAmps.toFixed(1)} A / ${feederCapA} A).`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }
    if (power.totals.cautionCircuits > 0) {
      findings.push({
        code: 'power_circuit_caution',
        outcome: 'warn',
        message: `${power.totals.cautionCircuits} branch circuit(s) in 80% continuous caution band.`,
      });
      outcome = worstOutcome(outcome, 'warn');
    }
    const rowId = 'power:summary';
    rows.push({
      id: rowId,
      kind: 'power',
      label: 'Electrical power & circuits',
      location: power.system.shortLabel,
      outcome,
      hardBlock,
      canAcknowledge: outcome === 'warn' && !hardBlock,
      isLaser: false,
      requiresLaserInhibit: false,
      canInhibitLaser: false,
      rowFingerprint: fnv1aHex(
        JSON.stringify({
          rowId,
          system: power.system.id,
          overloadedCircuits: power.totals.overloadedCircuits,
          cautionCircuits: power.totals.cautionCircuits,
          feederStatus: power.totals.feederStatus,
          feederAmps: feederCapA,
          totalW: Math.round(power.totals.totalW),
        }),
      ),
      summary:
        findings.length === 0
          ? `${Math.round(power.totals.totalW).toLocaleString()} W · ${power.circuits.length} circuits · Checks passed`
          : findings.map((f) => f.message).join(' '),
      findings,
    });
  }

  // Evaluate stale / ack / inhibit status
  const stale = acks.checked && acks.checkedRevision !== configRevision;
  const checkedCurrent = acks.checked && acks.checkedRevision === configRevision;

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let hardFailCount = 0;
  let unacknowledgedWarnings = 0;
  let laserTotal = 0;
  let laserAddressed = 0;
  const inhibitedLaserKeys: string[] = [];
  const blockingReasons: string[] = [];

  for (const row of rows) {
    if (row.outcome === 'pass') passCount++;
    else if (row.outcome === 'warn') warnCount++;
    else failCount++;

    if (row.hardBlock) {
      hardFailCount++;
      blockingReasons.push(`${row.label}: ${row.summary}`);
      continue;
    }

    if (row.isLaser && row.projectorKey) {
      laserTotal++;
      // Session-sticky laser inhibit: once inhibited by the operator, physical DMX stays forced to 0
      // across config edits and cue Go until explicitly un-inhibited (never silently dropped on stale revision).
      const isInhibited = Boolean(acks.inhibitedLasers[row.projectorKey]);
      const isAcked = checkedCurrent && acks.acknowledgedLasers[row.projectorKey] === row.rowFingerprint;
      if (isInhibited) {
        inhibitedLaserKeys.push(row.projectorKey);
        laserAddressed++;
      } else if (!row.requiresLaserInhibit && isAcked) {
        laserAddressed++;
      } else if (row.requiresLaserInhibit) {
        blockingReasons.push(`${row.label}: unassessed or audience-breaching laser must be fixed or inhibited to DMX 0.`);
      } else {
        blockingReasons.push(`${row.label}: requires explicit laser projector acknowledgement.`);
      }
      continue;
    }

    if (row.outcome === 'warn') {
      const acked = checkedCurrent && acks.acknowledgedRows[row.id] === row.rowFingerprint;
      if (!acked) {
        unacknowledgedWarnings++;
        blockingReasons.push(`${row.label}: warning not yet acknowledged.`);
      }
    }
  }

  // Also preserve any explicitly inhibited projector keys even if currently absent/hard-blocked
  // so an active physical DMX 0 inhibit is never silently cleared on config edits.
  for (const key of Object.keys(acks.inhibitedLasers)) {
    if (acks.inhibitedLasers[key] && !inhibitedLaserKeys.includes(key)) {
      inhibitedLaserKeys.push(key);
    }
  }

  if (!acks.checked) {
    blockingReasons.unshift('Run pre-flight check before arming live DMX output.');
  } else if (stale) {
    blockingReasons.unshift('Rig, patch, look, or aim changed since last check — re-run pre-flight.');
  }

  const canArm =
    checkedCurrent &&
    !stale &&
    hardFailCount === 0 &&
    unacknowledgedWarnings === 0 &&
    laserAddressed === laserTotal;

  let overallStatus: PreflightOverallStatus;
  let badgeLabel: string;
  if (!acks.checked || stale) {
    overallStatus = 'not_checked';
    badgeLabel = stale ? 'Not checked (stale)' : 'Not checked';
  } else if (hardFailCount > 0 || (laserTotal > laserAddressed && rows.some((r) => r.isLaser && r.requiresLaserInhibit && !inhibitedLaserKeys.includes(r.projectorKey!)))) {
    overallStatus = 'blocked';
    const blockCount = hardFailCount + rows.filter((r) => r.isLaser && r.requiresLaserInhibit && !inhibitedLaserKeys.includes(r.projectorKey!)).length;
    badgeLabel = `Blocked (${blockCount})`;
  } else if (warnCount > 0 || laserTotal > 0) {
    // Acknowledged warnings stay reported as "N warnings", never promoted to "Checks passed".
    const totalAttention = warnCount + rows.filter((r) => r.isLaser && r.outcome !== 'warn').length;
    overallStatus = 'warnings';
    badgeLabel = `${totalAttention} ${totalAttention === 1 ? 'warning' : 'warnings'}`;
  } else {
    overallStatus = 'passed';
    badgeLabel = 'Checks passed';
  }

  const crowdScanWarning =
    laserTotal > 0 || activeAudienceScan || cueWithAudienceScan
      ? activeAudienceScan
        ? CROWD_SCAN_WARNING
        : cueWithAudienceScan
          ? `Cue "${cueWithAudienceScan.name}" enables audience scanning. ${CROWD_SCAN_WARNING}`
          : `Audience scanning is OFF. ${CROWD_SCAN_WARNING}`
      : null;

  return {
    evaluatorVersion: PREFLIGHT_EVALUATOR_VERSION,
    configRevision,
    evaluatedAtIso,
    stale,
    checked: acks.checked,
    overallStatus,
    badgeLabel,
    calibrationNote: AIM_CALIBRATION_NOTE,
    disclaimer: `${LASER_SAFETY_DISCLAIMER} ${RIGGING_DISCLAIMER}`,
    lsoNotice: LASER_LSO_NOTICE,
    crowdScanWarning,
    rows,
    laserZones: laserEval.zones,
    counts: {
      pass: passCount,
      warn: warnCount,
      fail: failCount,
      unacknowledgedWarnings,
      laserTotal,
      laserAddressed,
      laserInhibited: inhibitedLaserKeys.length,
    },
    canArm,
    blockingReasons,
    inhibitedLaserKeys,
  };
}

export interface CommissioningRecordMeta {
  readonly rigName: string;
  readonly venue: string;
  readonly testerName: string;
  readonly date: string;
}

/**
 * Single source of truth for the Commissioning Record operator-action string,
 * shared identically across the in-app sheet, printable sheet, and CSV export.
 */
export function commissioningActionLabel(
  row: PreflightRow,
  report: PreflightReport,
  acks: PreflightAcknowledgementState,
): string {
  if (row.hardBlock) return 'BLOCKED (must resolve)';
  if (row.isLaser && row.projectorKey) {
    if (acks.inhibitedLasers[row.projectorKey]) {
      return 'Inhibited (physical DMX forced to 0)';
    }
    if (
      report.checked &&
      !report.stale &&
      !row.requiresLaserInhibit &&
      acks.acknowledgedLasers[row.projectorKey] === row.rowFingerprint
    ) {
      return 'Laser acknowledged';
    }
    if (row.requiresLaserInhibit) {
      return 'BLOCKED (inhibit or resolve hazard)';
    }
    return 'Pending laser acknowledgement';
  }
  if (row.outcome === 'warn') {
    return report.checked && !report.stale && acks.acknowledgedRows[row.id] === row.rowFingerprint
      ? 'Acknowledged'
      : 'Pending acknowledgement';
  }
  return 'None required';
}

/**
 * Deterministic RFC 4180 + formula-safe CSV for the Commissioning Record sheet.
 * Consumes the exact same frozen `PreflightReport` snapshot and action labels as the printable sheet.
 */
export function commissioningRecordCsv(
  report: PreflightReport,
  acks: PreflightAcknowledgementState,
  meta: CommissioningRecordMeta,
): string {
  const headers: CsvValue[] = [
    'Row ID',
    'Category',
    'Item',
    'Location',
    'Outcome',
    'Hard Block',
    'Operator Action',
    'Summary',
    'Config Revision',
    'Evaluator Version',
    'Checked At',
    'Tester',
    'Date',
  ];

  const dataRows: CsvValue[][] = report.rows.map((row) => [
    row.id,
    row.kind,
    row.label,
    row.location,
    row.outcome.toUpperCase(),
    row.hardBlock ? 'YES' : 'NO',
    commissioningActionLabel(row, report, acks),
    row.summary,
    report.configRevision,
    report.evaluatorVersion,
    report.evaluatedAtIso,
    meta.testerName || '',
    meta.date,
  ]);

  const hasHardBlock = report.rows.some((r) => r.hardBlock);
  // Trailing summary/disclaimer row so CSV stands alone when opened in a spreadsheet.
  dataRows.push([
    'SUMMARY',
    'commissioning',
    meta.rigName,
    meta.venue.toUpperCase(),
    report.badgeLabel,
    hasHardBlock ? 'YES' : 'NO',
    report.canArm ? 'Eligible to arm (two-step confirmation still required)' : 'Arming disabled',
    `${report.calibrationNote} ${report.disclaimer}`,
    report.configRevision,
    report.evaluatorVersion,
    report.evaluatedAtIso,
    meta.testerName || '',
    meta.date,
  ]);

  return formatCsv([headers, ...dataRows], { bom: true });
}
