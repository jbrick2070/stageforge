import type {
  FixtureType,
  FloorFxType,
  FloorFxUnit,
  MountedFixtureGroup,
  PhaseId,
  RigConfig,
  ShowCue,
  VenueType,
} from '../types/show';
import { formatSmpte, msToSmpte } from '../showControl/timecode';
import { formatCsv, type CsvValue } from './csv';
import { buildDmxPatch, formatDmxLabel } from './dmxPatch';
import { getCatalogEntry, isFieldUnverified } from './equipmentCatalog';
import { dxfBlockName } from './equipmentSymbols';
import { resolveOptics } from './fixtureOptics';
import { placeFixtures } from './fixturePlacement';
import { CROWD_SCAN_WARNING } from './laserSafety';
import { computePowerReport, unitCircuitIndex, unitCircuitPosKey, type PowerReport } from './powerReport';
import { HARDWARE_ALLOWANCE, KG_TO_LBS } from './productionEstimator';
import { getTrussProfile, LEGACY_TRUSS_PROFILE, trussDisplayName } from './rigCatalog';
import { evaluateRigLoads, type RigLoadsReport } from './rigLoads';
import type { NativeStage, ShowTimeline, SmpteFrameRate } from './showFile';
import { resolveStudioGeometry } from './studioGeometry';

export type PaperworkSheetId = 'patch' | 'instrument' | 'hookup' | 'power' | 'cues';
export type PaperworkUnitStatus = 'ok' | 'conflict' | 'overflow';

export const PAPERWORK_SIMULATED_MAP_NOTICE =
  'StageForge simulated channel map: verify against the GDTF mode.';

export const DEFAULT_PAPERWORK_FPS: SmpteFrameRate = 30;

/** Internal aggregation keys. Pods are prefixed, so no pod id (even "floor") can collide with the stage floor. */
const FLOOR_KEY = 'floor';
const podKey = (podId: string) => `pod:${podId}`;
const positionKey = (u: { floor: boolean; positionId: string }) => (u.floor ? FLOOR_KEY : podKey(u.positionId));

export interface PaperworkUnit {
  /** 1-based global index across `placeFixtures(resolvedRig)` — equals MVR FixtureID / FixtureIDNumeric / CustomId. */
  fixtureNumber: number;
  /** 1-based index within the fixture group — equals MVR UnitNumber. */
  unitNumber: number;
  /** 1-based placement order along its hanging position (truss pod or Stage floor). */
  mountOrder: number;
  /** Pod ID or `'floor'`. */
  positionId: string;
  /** Pod name or `'Stage floor'`. */
  positionName: string;
  floor: boolean;
  groupId: string;
  modelName: string;
  manufacturer: string;
  type: FixtureType | FloorFxType;
  catalogId?: string;
  universe: 1 | 2;
  address: number;
  dmxEnd: number;
  footprint: number;
  dmxMode?: string;
  /** Canonical DXF PATCH_TAGS label (`U1.001`). */
  dmxLabel: string;
  /** Compact range label (`U1.001–008` or `U1.001` for 1-ch). */
  dmxRangeLabel: string;
  /** Absolute 1-based MVR DMX address `(u-1)*512 + addr` when patched, or `null` when unpatched (MVR omits `<Addresses>`). */
  absoluteAddress: number | null;
  status: PaperworkUnitStatus;
  /** StageForge world coordinates in metres (Y up, +Z downstage; MVR multiplies ×1000 with axis swap). */
  x: number;
  y: number;
  z: number;
  /** Fixture yaw about +Y in radians, directly from `placeFixtures()`. */
  yaw: number;
  weightKg: number;
  weightEstimated: boolean;
  powerW: number;
  powerEstimated: boolean;
  circuitId: string | null;
  phase: PhaseId | null;
  /** Canonical DXF block name (`SF_*`), identical to `stageDxf.ts`. */
  dxfBlock: string;
  opticsNote: string;
}

export interface PositionSummary {
  positionId: string;
  positionName: string;
  floor: boolean;
  trussProfileName: string | null;
  trimHeightM: number | null;
  unitCount: number;
  totalWeightKg: number;
  totalPowerW: number;
}

export interface UniverseSummary {
  universe: 1 | 2;
  unitCount: number;
  usedChannels: number;
  freeChannels: number;
  conflictChannels: number;
  overflowUnits: number;
}

export interface UnplacedUnit {
  positionId: string;
  positionName: string;
  groupId: string;
  modelName: string;
  /** 0-based unit index within its group that was not placed by `placeFixtures()`. */
  index: number;
}

export interface CueSheetRow {
  cueNumber: number;
  id: string;
  name: string;
  tag: string;
  accent: string;
  followSeconds: number | null;
  followLabel: string;
  takeAtMs: number | null;
  takeTimecode: string | null;
  dimmerLabel: string;
  lightingSummary: string;
  laserSummary: string;
  audienceScanWarning: string | null;
  motorsSummary: string;
  atmoSummary: string;
  mediaSummary: string;
}

export interface ShowPaperwork {
  rigName: string;
  venue: VenueType;
  /** All placed physical fixture units in `fixtureNumber` (placement) order. */
  units: PaperworkUnit[];
  /** Units sorted by DMX universe → start address → fixtureNumber (Patch Sheet order). */
  patchRows: PaperworkUnit[];
  /** Units sorted by hanging position order (truss pods then Stage floor) → `mountOrder` (Instrument Schedule order). */
  instrumentRows: PaperworkUnit[];
  positions: PositionSummary[];
  universes: UniverseSummary[];
  power: PowerReport;
  loads: RigLoadsReport;
  cues: CueSheetRow[];
  timelineFrameRate: SmpteFrameRate | null;
  timelineOffsetMs: number;
  /** Units counted in `rig` groups that `placeFixtures()` could not place (e.g. empty mount slots). */
  unplaced: UnplacedUnit[];
  /** Total Σ `group.count` across resolved truss pods and floor FX; invariant: `units.length + unplaced.length === totalExpectedUnits`. */
  totalExpectedUnits: number;
  totals: {
    unitCount: number;
    patchedUnits: number;
    conflictUnits: number;
    overflowUnits: number;
    totalFixtureWeightKg: number;
    totalFixturePowerW: number;
    cueCount: number;
  };
}

export interface BuildPaperworkOptions {
  /** Reuse an already-computed RigLoadsReport so totals and objects stay identical with the Rigging tab. */
  loads?: RigLoadsReport;
  /** Reuse an already-computed PowerReport so circuits and totals stay identical with the Rigging tab. */
  power?: PowerReport;
  applyD8Derate?: boolean;
}

type HardwareKind = FixtureType | FloorFxType;
type AnyGroup = MountedFixtureGroup | FloorFxUnit;

function unitSpecs(group: AnyGroup): {
  manufacturer: string;
  weightKg: number;
  weightEstimated: boolean;
  powerW: number;
  powerEstimated: boolean;
} {
  const allowance = HARDWARE_ALLOWANCE[group.type as HardwareKind];
  const entry = group.catalogId ? getCatalogEntry(group.catalogId) : undefined;
  const hasWeight = Boolean(entry && entry.weightKg !== undefined && !isFieldUnverified(entry, 'weightKg'));
  const hasPower = Boolean(entry && entry.powerW !== undefined && !isFieldUnverified(entry, 'powerW'));
  return {
    manufacturer: entry?.manufacturer ?? 'Generic',
    weightKg: hasWeight ? entry!.weightKg! : allowance.weightLbs / KG_TO_LBS,
    weightEstimated: !hasWeight,
    powerW: hasPower ? entry!.powerW! : allowance.watts,
    powerEstimated: !hasPower,
  };
}

function formatOpticsNote(group: AnyGroup): string {
  const entry = group.catalogId ? getCatalogEntry(group.catalogId) : undefined;
  const resolved = resolveOptics(group);
  const parts: string[] = [];

  const angle = resolved?.beamAngle ?? resolved?.profile?.beamAngle;
  const lumens = resolved?.lumens ?? resolved?.profile?.lumens;
  if (angle !== undefined) {
    parts.push(`${Number(angle.toFixed(1))}°`);
  } else if (entry?.optics?.zoomDeg && !isFieldUnverified(entry, 'optics.zoomDeg')) {
    parts.push(`${entry.optics.zoomDeg[0]}–${entry.optics.zoomDeg[1]}°`);
  } else if (entry?.optics?.beamDeg !== undefined && !isFieldUnverified(entry, 'optics.beamDeg')) {
    parts.push(`${entry.optics.beamDeg}°`);
  }

  if (lumens !== undefined) {
    parts.push(`${Math.round(lumens).toLocaleString('en-US')} lm`);
  }

  if (entry?.laser) {
    const powerLabel =
      entry.laser.opticalPowerW < 1
        ? `${Math.round(entry.laser.opticalPowerW * 1000)} mW`
        : `${entry.laser.opticalPowerW} W`;
    parts.push(`${powerLabel} ${entry.laser.colorType === 'single' ? `${entry.laser.wavelengthNm ?? ''}nm` : 'RGB'}`);
    if (entry.laser.scanSpeedKpps) parts.push(`${entry.laser.scanSpeedKpps} kpps`);
  }

  if (entry?.auxSafetyChannelNote) {
    parts.push(`+1 aux safety DMX ch (reserve manually)`);
  }

  return parts.length ? parts.join(' · ') : '—';
}

function formatDmxRange(universe: 1 | 2, address: number, footprint: number): string {
  const start = formatDmxLabel(universe, address);
  if (footprint <= 1) return start;
  const end = address + footprint - 1;
  return `${start}–${String(end).padStart(3, '0')}`;
}

function statusForUnit(
  universe: 1 | 2,
  address: number,
  footprint: number,
  claimed: { 1: Uint16Array; 2: Uint16Array },
): PaperworkUnitStatus {
  const end = address + footprint - 1;
  if (address < 1 || end > 512) return 'overflow';
  const slots = claimed[universe];
  for (let ch = address; ch <= end; ch++) {
    if (slots[ch] > 1) return 'conflict';
  }
  return 'ok';
}

function formatCueLighting(cue: ShowCue): string {
  const s = cue.state;
  const parts: string[] = [];
  if (s.beamIntensity !== undefined) parts.push(`Beam ${Math.round(s.beamIntensity * 100)}%`);
  if (s.washIntensity !== undefined) parts.push(`Wash ${Math.round(s.washIntensity * 100)}%`);
  if (s.movementMode) parts.push(s.movementMode.replaceAll('_', ' '));
  if (s.focusMarkId) parts.push(`Focus: ${s.focusMarkId}`);
  if (s.primaryColor) {
    parts.push(s.accentColor && s.accentColor !== s.primaryColor ? `${s.primaryColor}/${s.accentColor}` : s.primaryColor);
  }
  if (s.goboPrism) parts.push('Prism');
  if (s.strobeRate && s.strobeRate > 0) parts.push(`Strobe ${Math.round(s.strobeRate * 100)}%`);
  if (s.blinderLevel && s.blinderLevel > 0) parts.push(`Blinder ${Math.round(s.blinderLevel * 100)}%`);
  return parts.length ? parts.join(' · ') : '—';
}

function formatCueLasers(cue: ShowCue): { summary: string; audienceScanWarning: string | null } {
  const laser = cue.state.laser;
  if (!laser) return { summary: '—', audienceScanWarning: null };
  if (!laser.enabled) return { summary: 'Off', audienceScanWarning: null };
  const parts = [`${laser.pattern.replaceAll('_', ' ')} (${Math.round(laser.intensity * 100)}%)`];
  if (laser.audienceScan) parts.push('CROWD SCAN ON');
  return {
    summary: parts.join(' · '),
    audienceScanWarning: laser.audienceScan ? CROWD_SCAN_WARNING : null,
  };
}

function formatCueMotors(cue: ShowCue): string {
  const motors = cue.state.motors;
  if (!motors) return '—';
  return `${motors.mode.replaceAll('_', ' ')} (spd ${Math.round(motors.speed * 100)}%)`;
}

function formatCueAtmo(cue: ShowCue): string {
  const atmo = cue.state.atmo;
  if (!atmo) return '—';
  const parts: string[] = [];
  if (atmo.hazeLevel > 0) parts.push(`Haze ${Math.round(atmo.hazeLevel * 100)}%`);
  if (atmo.smokeOutput > 0) parts.push(`Smoke ${Math.round(atmo.smokeOutput * 100)}%`);
  if (atmo.co2Active) parts.push('CO2 ON');
  else if (atmo.co2AutoOnDrop) parts.push('CO2 auto-drop');
  return parts.length ? parts.join(' · ') : 'Clear';
}

function formatCueMedia(cue: ShowCue): string {
  const parts: string[] = [];
  if (cue.screen) {
    if (cue.screen.kind === 'none') {
      parts.push('Screen clear');
    } else {
      const mode = cue.screen.kind === 'image' ? 'image' : cue.screen.playing ? 'play' : 'pause';
      const off = cue.screen.kind === 'video' && cue.screen.offsetSeconds ? ` @${cue.screen.offsetSeconds}s` : '';
      parts.push(`${cue.screen.name} (${mode}${off})`);
    }
  }
  const led = cue.state.led;
  if (led) {
    if (!led.enabled) {
      parts.push('LED off');
    } else {
      const modeLabel = led.visualMode.replaceAll('_', ' ');
      const textSuffix = led.visualMode === 'tour_text' && led.tourText ? ` "${led.tourText}"` : '';
      parts.push(`LED ${modeLabel}${textSuffix} ${Math.round(led.brightness * 100)}%`);
    }
  }
  return parts.length ? parts.join(' · ') : '—';
}

function buildCueSheet(cues: readonly ShowCue[], timeline?: ShowTimeline): {
  rows: CueSheetRow[];
  frameRate: SmpteFrameRate | null;
  offsetMs: number;
} {
  const hasTimeline = Boolean(timeline && timeline.events.length > 0);
  const frameRate: SmpteFrameRate | null = timeline?.frameRate ?? (hasTimeline ? DEFAULT_PAPERWORK_FPS : null);
  const offsetMs = timeline?.timecodeOffsetMs ?? 0;

  // First recorded event wins for each cueId (matching Opus 5.5 §2.5).
  const firstEventMs = new Map<string, number>();
  for (const ev of timeline?.events ?? []) {
    if (ev.cueId && !firstEventMs.has(ev.cueId)) {
      firstEventMs.set(ev.cueId, ev.atMs);
    }
  }

  const rows: CueSheetRow[] = cues.map((cue, idx) => {
    const atMs = firstEventMs.has(cue.id) ? firstEventMs.get(cue.id)! : null;
    const takeTimecode =
      atMs !== null && frameRate !== null ? formatSmpte(msToSmpte(atMs + offsetMs, frameRate)) : null;
    const followSeconds = cue.followSeconds !== undefined && Number.isFinite(cue.followSeconds) ? cue.followSeconds : null;
    const followLabel = followSeconds !== null ? `${followSeconds}s` : 'Manual GO';
    const dimmerLabel = cue.state.blackout
      ? 'BLACKOUT'
      : cue.state.masterDimmer !== undefined
        ? `${Math.round(cue.state.masterDimmer * 100)}%`
        : '—';
    const { summary: laserSummary, audienceScanWarning } = formatCueLasers(cue);

    return {
      cueNumber: idx + 1,
      id: cue.id,
      name: cue.name,
      tag: cue.tag,
      accent: cue.accent,
      followSeconds,
      followLabel,
      takeAtMs: atMs,
      takeTimecode,
      dimmerLabel,
      lightingSummary: formatCueLighting(cue),
      laserSummary,
      audienceScanWarning,
      motorsSummary: formatCueMotors(cue),
      atmoSummary: formatCueAtmo(cue),
      mediaSummary: formatCueMedia(cue),
    };
  });

  return { rows, frameRate, offsetMs };
}

/**
 * Build complete show paperwork from a single resolved rig geometry and placement pass,
 * guaranteeing exact fixture ID, unit number, DMX address, DXF block, and circuit/phase parity
 * with MVR export, DXF export, RigLoadsReport, and PowerReport.
 */
export function buildShowPaperwork(
  sourceRig: RigConfig,
  stage?: NativeStage,
  cues: readonly ShowCue[] = [],
  timeline?: ShowTimeline,
  options: BuildPaperworkOptions = {},
): ShowPaperwork {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const loads = options.loads ?? evaluateRigLoads(sourceRig, stage, { applyD8Derate: options.applyD8Derate });
  const power = options.power ?? computePowerReport(sourceRig, stage);
  const lookupCircuit = unitCircuitIndex(power);
  const patch = buildDmxPatch(rig);

  // Index every resolved group by object reference -> position key and display metadata.
  interface GroupMeta {
    posKey: string;
    positionId: string;
    positionName: string;
    positionRank: number;
    group: AnyGroup;
  }
  const groupMeta = new Map<AnyGroup, GroupMeta>();
  const podById = new Map<string, { name: string; trussProfileName: string; trimHeightM: number; rank: number }>();
  const allGroups: GroupMeta[] = [];
  let totalExpectedUnits = 0;

  rig.trussPods.forEach((pod, podIdx) => {
    podById.set(pod.id, {
      name: pod.name,
      trussProfileName: trussDisplayName(getTrussProfile(pod.trussProfileId) ?? LEGACY_TRUSS_PROFILE),
      trimHeightM: pod.baseY,
      rank: podIdx,
    });
    pod.fixtures.forEach((fg, groupIdx) => {
      const meta: GroupMeta = {
        posKey: unitCircuitPosKey(podIdx, groupIdx),
        positionId: pod.id,
        positionName: pod.name,
        positionRank: podIdx,
        group: fg,
      };
      groupMeta.set(fg, meta);
      allGroups.push(meta);
      totalExpectedUnits += Math.max(0, fg.count);
    });
  });

  const floorRank = rig.trussPods.length;
  rig.floorFx.forEach((fx, fxIdx) => {
    const meta: GroupMeta = {
      posKey: unitCircuitPosKey(null, fxIdx),
      positionId: 'floor',
      positionName: 'Stage floor',
      positionRank: floorRank,
      group: fx,
    };
    groupMeta.set(fx, meta);
    allGroups.push(meta);
    totalExpectedUnits += Math.max(0, fx.count);
  });

  const placements = placeFixtures(rig);
  const mountCounter = new Map<string, number>();
  const placedUnitKeys = new Set<string>();
  const unitRankByFixture = new Map<number, number>();

  const units: PaperworkUnit[] = placements.map((p, n) => {
    const meta = groupMeta.get(p.group);
    const positionId = p.floor ? 'floor' : (p.podId ?? meta?.positionId ?? 'unknown');
    const positionName = p.floor ? 'Stage floor' : (podById.get(positionId)?.name ?? meta?.positionName ?? positionId);
    const mountKey = p.floor ? FLOOR_KEY : podKey(positionId);
    const mountOrder = (mountCounter.get(mountKey) ?? 0) + 1;
    mountCounter.set(mountKey, mountOrder);

    if (meta) {
      placedUnitKeys.add(`${meta.posKey}:${p.index}`);
      unitRankByFixture.set(n + 1, meta.positionRank);
    } else {
      unitRankByFixture.set(n + 1, floorRank + 1);
    }

    const specs = unitSpecs(p.group);
    const circuit = meta ? lookupCircuit(meta.posKey, p.index) : undefined;
    const dmxEnd = p.address + p.footprint - 1;
    const status = statusForUnit(p.universe, p.address, p.footprint, patch.claimed);
    const absoluteAddress = p.patched ? (p.universe - 1) * 512 + p.address : null;

    return {
      fixtureNumber: n + 1,
      unitNumber: p.index + 1,
      mountOrder,
      positionId,
      positionName,
      floor: p.floor,
      groupId: p.group.id,
      modelName: p.group.modelName,
      manufacturer: specs.manufacturer,
      type: p.group.type,
      catalogId: p.group.catalogId,
      universe: p.universe,
      address: p.address,
      dmxEnd,
      footprint: p.footprint,
      dmxMode: p.group.dmxMode,
      dmxLabel: formatDmxLabel(p.universe, p.address),
      dmxRangeLabel: formatDmxRange(p.universe, p.address, p.footprint),
      absoluteAddress,
      status,
      x: p.position.x,
      y: p.position.y,
      z: p.position.z,
      yaw: p.yaw,
      weightKg: specs.weightKg,
      weightEstimated: specs.weightEstimated,
      powerW: specs.powerW,
      powerEstimated: specs.powerEstimated,
      circuitId: circuit?.circuitId ?? null,
      phase: circuit?.phase ?? null,
      dxfBlock: dxfBlockName(p.group.type, p.group.catalogId),
      opticsNote: formatOpticsNote(p.group),
    };
  });

  // Detect any unit counted in rig groups that placeFixtures() could not mount.
  const unplaced: UnplacedUnit[] = [];
  for (const meta of allGroups) {
    const count = Math.max(0, meta.group.count);
    for (let i = 0; i < count; i++) {
      if (!placedUnitKeys.has(`${meta.posKey}:${i}`)) {
        unplaced.push({
          positionId: meta.positionId,
          positionName: meta.positionName,
          groupId: meta.group.id,
          modelName: meta.group.modelName,
          index: i,
        });
      }
    }
  }

  // Patch Sheet sort: Universe -> Start Address -> Fixture #.
  const patchRows = [...units].sort(
    (a, b) => a.universe - b.universe || a.address - b.address || a.fixtureNumber - b.fixtureNumber,
  );

  // Instrument Schedule sort: Hanging position order (truss pods, then Stage floor) -> mountOrder.
  const instrumentRows = [...units].sort(
    (a, b) =>
      (unitRankByFixture.get(a.fixtureNumber) ?? 0) - (unitRankByFixture.get(b.fixtureNumber) ?? 0) ||
      a.mountOrder - b.mountOrder ||
      a.fixtureNumber - b.fixtureNumber,
  );

  // Position summaries in canonical rig order (truss pods, then Stage floor if populated).
  const posAgg = new Map<string, { count: number; kg: number; watts: number }>();
  for (const u of units) {
    const prev = posAgg.get(positionKey(u)) ?? { count: 0, kg: 0, watts: 0 };
    prev.count += 1;
    prev.kg += u.weightKg;
    prev.watts += u.powerW;
    posAgg.set(positionKey(u), prev);
  }
  const positions: PositionSummary[] = [];
  for (const pod of rig.trussPods) {
    const agg = posAgg.get(podKey(pod.id)) ?? { count: 0, kg: 0, watts: 0 };
    positions.push({
      positionId: pod.id,
      positionName: pod.name,
      floor: false,
      trussProfileName: trussDisplayName(getTrussProfile(pod.trussProfileId) ?? LEGACY_TRUSS_PROFILE),
      trimHeightM: pod.baseY,
      unitCount: agg.count,
      totalWeightKg: agg.kg,
      totalPowerW: agg.watts,
    });
  }
  const floorAgg = posAgg.get(FLOOR_KEY);
  if (floorAgg && floorAgg.count > 0) {
    positions.push({
      positionId: 'floor',
      positionName: 'Stage floor',
      floor: true,
      trussProfileName: null,
      trimHeightM: null,
      unitCount: floorAgg.count,
      totalWeightKg: floorAgg.kg,
      totalPowerW: floorAgg.watts,
    });
  }

  // Universe summaries (U1, U2).
  const universes: UniverseSummary[] = ([1, 2] as const).map((u) => {
    const slots = patch.claimed[u];
    let usedChannels = 0;
    let conflictChannels = 0;
    for (let ch = 1; ch <= 512; ch++) {
      if (slots[ch] > 0) usedChannels++;
      if (slots[ch] > 1) conflictChannels++;
    }
    const uUnits = units.filter((item) => item.universe === u);
    const overflowUnits = uUnits.filter((item) => item.status === 'overflow').length;
    return {
      universe: u,
      unitCount: uUnits.length,
      usedChannels,
      freeChannels: 512 - usedChannels,
      conflictChannels,
      overflowUnits,
    };
  });

  const cueSheet = buildCueSheet(cues, timeline);
  const patchedUnits = units.filter((u) => u.status === 'ok').length;
  const conflictUnits = units.filter((u) => u.status === 'conflict').length;
  const overflowUnits = units.filter((u) => u.status === 'overflow').length;
  const totalFixtureWeightKg = units.reduce((sum, u) => sum + u.weightKg, 0);
  const totalFixturePowerW = units.reduce((sum, u) => sum + u.powerW, 0);

  return {
    rigName: rig.name,
    venue: rig.venue,
    units,
    patchRows,
    instrumentRows,
    positions,
    universes,
    power,
    loads,
    cues: cueSheet.rows,
    timelineFrameRate: cueSheet.frameRate,
    timelineOffsetMs: cueSheet.offsetMs,
    unplaced,
    totalExpectedUnits,
    totals: {
      unitCount: units.length,
      patchedUnits,
      conflictUnits,
      overflowUnits,
      totalFixtureWeightKg,
      totalFixturePowerW,
      cueCount: cueSheet.rows.length,
    },
  };
}

const sourceLabel = (estimated: boolean) => (estimated ? 'Estimate' : 'Datasheet');

/** One CSV row for a unit that rig groups count but `placeFixtures()` could not mount. */
function unplacedCsvRow(header: readonly string[], u: UnplacedUnit): CsvValue[] {
  const cells: Record<string, CsvValue> = {
    Position: u.positionName,
    'Unit #': u.index + 1,
    Model: u.modelName,
    'Group ID': u.groupId,
    Status: 'UNPLACED',
    Notes: 'Counted in the rig but not placed on a truss or the floor. It has no position, patch or circuit on this sheet.',
  };
  return header.map((h) => cells[h] ?? '');
}

/** Per-unit Patch Sheet CSV sorted by DMX Universe and Start Address (BOM + RFC 4180 + formula-safe). */
export function patchSheetCsv(paperwork: ShowPaperwork): string {
  const rows: CsvValue[][] = [
    [
      'Universe',
      'DMX Address',
      'DMX Range',
      'Absolute Address',
      'Footprint (ch)',
      'Fixture #',
      'Position',
      'Unit #',
      'Manufacturer',
      'Model',
      'Catalogue ID',
      'DMX Mode',
      'Group ID',
      'Status',
      'Notes',
    ],
  ];
  for (const u of paperwork.patchRows) {
    rows.push([
      u.universe,
      u.dmxLabel,
      u.dmxRangeLabel,
      u.absoluteAddress,
      u.footprint,
      u.fixtureNumber,
      u.positionName,
      u.unitNumber,
      u.manufacturer,
      u.modelName,
      u.catalogId ?? '',
      u.dmxMode ?? '',
      u.groupId,
      u.status.toUpperCase(),
      PAPERWORK_SIMULATED_MAP_NOTICE,
    ]);
  }
  for (const u of paperwork.unplaced) rows.push(unplacedCsvRow(rows[0] as string[], u));
  return formatCsv(rows, { bom: true });
}

/** Per-unit Instrument Schedule CSV sorted by Hanging Position and mount order (BOM + RFC 4180 + formula-safe). */
export function instrumentScheduleCsv(paperwork: ShowPaperwork): string {
  const rows: CsvValue[][] = [
    [
      'Position',
      'Mount #',
      'Fixture #',
      'Unit #',
      'Manufacturer',
      'Model',
      'Type',
      'Catalogue ID',
      'DMX Address',
      'DMX Mode',
      'Footprint (ch)',
      'Weight (kg)',
      'Weight source',
      'Power (W)',
      'Power source',
      'Circuit',
      'Phase',
      'X (m)',
      'Y (m)',
      'Z (m)',
      'Optics',
      'DXF Block',
      'Status',
      'Notes',
    ],
  ];
  for (const u of paperwork.instrumentRows) {
    rows.push([
      u.positionName,
      u.mountOrder,
      u.fixtureNumber,
      u.unitNumber,
      u.manufacturer,
      u.modelName,
      u.type,
      u.catalogId ?? '',
      u.dmxLabel,
      u.dmxMode ?? '',
      u.footprint,
      Number(u.weightKg.toFixed(2)),
      sourceLabel(u.weightEstimated),
      u.powerW,
      sourceLabel(u.powerEstimated),
      u.circuitId ?? '',
      u.phase ?? '',
      Number(u.x.toFixed(3)),
      Number(u.y.toFixed(3)),
      Number(u.z.toFixed(3)),
      u.opticsNote === '—' ? '' : u.opticsNote,
      u.dxfBlock,
      u.status.toUpperCase(),
      PAPERWORK_SIMULATED_MAP_NOTICE,
    ]);
  }
  for (const u of paperwork.unplaced) rows.push(unplacedCsvRow(rows[0] as string[], u));
  return formatCsv(rows, { bom: true });
}

/** Per-unit Channel Hookup CSV sorted by Fixture # / Console Channel (BOM + RFC 4180 + formula-safe). */
export function channelHookupCsv(paperwork: ShowPaperwork): string {
  const rows: CsvValue[][] = [
    [
      'Fixture #',
      'Position',
      'Unit #',
      'Manufacturer',
      'Model',
      'DMX Address',
      'Absolute Address',
      'Footprint (ch)',
      'DMX Mode',
      'Circuit',
      'Phase',
      'Weight (kg)',
      'Weight source',
      'Power (W)',
      'Power source',
      'Optics',
      'DXF Block',
      'Status',
      'Notes',
    ],
  ];
  for (const u of paperwork.units) {
    rows.push([
      u.fixtureNumber,
      u.positionName,
      u.unitNumber,
      u.manufacturer,
      u.modelName,
      u.dmxLabel,
      u.absoluteAddress,
      u.footprint,
      u.dmxMode ?? '',
      u.circuitId ?? '',
      u.phase ?? '',
      Number(u.weightKg.toFixed(2)),
      sourceLabel(u.weightEstimated),
      u.powerW,
      sourceLabel(u.powerEstimated),
      u.opticsNote === '—' ? '' : u.opticsNote,
      u.dxfBlock,
      u.status.toUpperCase(),
      PAPERWORK_SIMULATED_MAP_NOTICE,
    ]);
  }
  for (const u of paperwork.unplaced) rows.push(unplacedCsvRow(rows[0] as string[], u));
  return formatCsv(rows, { bom: true });
}

/** Cue Sheet CSV in stack order with SMPTE take timecode and safety notes (BOM + RFC 4180 + formula-safe). */
export function cueSheetCsv(paperwork: ShowPaperwork): string {
  const rows: CsvValue[][] = [
    [
      'Cue #',
      'Name',
      'Tag',
      'Follow',
      'Take Timecode',
      'Dimmer',
      'Lighting',
      'Lasers',
      'Motors',
      'Atmospherics',
      'LED / Media',
      'Safety Warning',
    ],
  ];
  for (const c of paperwork.cues) {
    rows.push([
      c.cueNumber,
      c.name,
      c.tag,
      c.followLabel,
      c.takeTimecode ?? '',
      c.dimmerLabel === '—' ? '' : c.dimmerLabel,
      c.lightingSummary === '—' ? '' : c.lightingSummary,
      c.laserSummary === '—' ? '' : c.laserSummary,
      c.motorsSummary === '—' ? '' : c.motorsSummary,
      c.atmoSummary === '—' ? '' : c.atmoSummary,
      c.mediaSummary === '—' ? '' : c.mediaSummary,
      c.audienceScanWarning ?? '',
    ]);
  }
  return formatCsv(rows, { bom: true });
}
