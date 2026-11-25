import type { RigConfig, ShowState } from '../types/show';
import type { IldaClip } from './ilda';
import { getCatalogEntry, type CatalogLaserSpec } from './equipmentCatalog';
import { placeFixtures } from './fixturePlacement';
import {
  ildaScanTangents,
  LASER_APERTURE_Z_M,
  LASER_BEAM_LENGTH_M,
  LASER_ILDA_ROLL_SCALE,
  laserFanHalfAngles,
  laserPitchEnvelope,
} from './laserAim';
import { laserProjectorKey } from './laserProjectors';

/**
 * Commonly cited minimum vertical clearance above audience-accessible floor surfaces
 * (IEC 60825-3 / ANSI Z136.1 unattended/general guidance: 3.0 m vertical, 2.5 m lateral).
 */
export const MIN_AUDIENCE_CLEARANCE_M = 3.0;
export const LATERAL_SEPARATION_GUIDANCE_M = 2.5;
export const STATIONARY_SPREAD_THRESHOLD = 0.02;
export const STATIONARY_ILDA_SPAN_DEG = 0.5;
export const LASER_SAFETY_DISCLAIMER =
  'Design guidance only, not regulatory certification or Laser Safety Officer sign-off.';
export const CROWD_SCAN_WARNING =
  'Crowd scan is enabled (audience-scanning requires LSO oversight, MPE measurements & variance).';

export type LaserClass = '3B' | '4';
export type LaserSafetyLevel = 'ok' | 'caution' | 'danger';
export type LaserSafetyFindingCode =
  | 'audience_zone'
  | 'crowd_scan_enabled'
  | 'stationary_beam'
  | 'class_4_notice'
  | 'class_3b_notice';

export interface LaserSafetyFinding {
  readonly code: LaserSafetyFindingCode;
  readonly severity: LaserSafetyLevel;
  readonly message: string;
}

export interface ProjectorSafetyReport {
  readonly projectorKey: string;
  readonly label: string;
  readonly catalogId?: string;
  readonly laserClass: LaserClass;
  readonly opticalPowerW?: number;
  readonly level: LaserSafetyLevel;
  /** Minimum height (m) of the lowest ray above audience floor (y=0) over the audience zone, or null if beams never enter audience Z. */
  readonly minClearanceM: number | null;
  readonly entersAudienceBelowThreshold: boolean;
  readonly stationaryHazard: boolean;
  readonly findings: readonly LaserSafetyFinding[];
}

export interface RigLaserSafetySummary {
  readonly level: LaserSafetyLevel;
  readonly laserEnabled: boolean;
  readonly projectorCount: number;
  readonly minClearanceM: number | null;
  readonly hasClass4: boolean;
  readonly audienceHazardCount: number;
  readonly stationaryHazardCount: number;
  readonly projectors: readonly ProjectorSafetyReport[];
  readonly disclaimer: string;
  readonly lateralGuidanceM: number;
}

/** Format clearance conservatively (floor to 0.1 m when below threshold so 2.96 m never rounds to "3.0 m"). */
export function formatClearanceM(clearanceM: number): string {
  const clears = clearanceM >= MIN_AUDIENCE_CLEARANCE_M - 1e-6;
  return (clears ? clearanceM : Math.floor(clearanceM * 10) / 10).toFixed(1);
}

/**
 * IEC 60825-1 optical power class for visible show lasers (> 0.5 W = Class 4, <= 0.5 W = Class 3B).
 */
export function laserClassFor(opticalPowerW: number): LaserClass {
  return opticalPowerW > 0.5 ? '4' : '3B';
}

function venueAudienceEndZ(rig: Pick<RigConfig, 'venue' | 'stageDepth'>): number {
  const start = rig.stageDepth / 2;
  switch (rig.venue) {
    case 'club':
      return Math.max(start + 12, 22);
    case 'theatre':
      return Math.max(start + 18, 30);
    case 'warehouse':
      return Math.max(start + 26, 35);
    case 'festival':
      return Math.max(start + 40, 50);
    case 'arena':
    default:
      return Math.max(start + 35, 45);
  }
}

/**
 * Given a projector origin, yaw (rad), pitch (rad, + = down), and local ray elevation/azimuth offsets,
 * compute the lowest world Y reached by the ray over audience Z in [zStart, zEnd] (clamped at 0 floor).
 * Returns null if the ray never crosses z >= zStart within LASER_BEAM_LENGTH_M.
 */
/**
 * Exported for unit parity testing against THREE.Euler(pitchRad, yaw, 0, 'YXZ').
 * Applies pitch around local X first, then yaw around world Y — matching StageEngine's `root.rotation.order = 'YXZ'`.
 */
export function laserRayWorldDirection(
  yaw: number,
  pitchRad: number,
  localAzimuthRad: number,
  localElevationRad: number,
): { dx: number; dy: number; dz: number } {
  const lx = Math.sin(localAzimuthRad) * Math.cos(localElevationRad);
  const ly = Math.sin(localElevationRad);
  const lz = Math.cos(localAzimuthRad) * Math.cos(localElevationRad);

  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const py = ly * cp - lz * sp;
  const pz = ly * sp + lz * cp;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    dx: lx * cy + pz * sy,
    dy: py,
    dz: -lx * sy + pz * cy,
  };
}

function lowestAudienceHeightForRay(
  originY: number,
  originZ: number,
  yaw: number,
  pitchRad: number,
  localAzimuthRad: number,
  localElevationRad: number,
  audienceStartZ: number,
  audienceEndZ: number,
): number | null {
  const { dy, dz } = laserRayWorldDirection(yaw, pitchRad, localAzimuthRad, localElevationRad);

  // Aperture sits at local (0, 0, LASER_APERTURE_Z_M) rotated by Euler(pitchRad, yaw, 0, 'YXZ').
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const cy = Math.cos(yaw);
  const apY = originY - LASER_APERTURE_Z_M * sp;
  const apZ = originZ + LASER_APERTURE_Z_M * cp * cy;

  if (!Number.isFinite(dy) || !Number.isFinite(dz)) return null;
  return computeSegmentMinY(apY, apZ, dy, dz, audienceStartZ, audienceEndZ);
}

function computeSegmentMinY(
  apY: number,
  apZ: number,
  dy: number,
  dz: number,
  audienceStartZ: number,
  audienceEndZ: number,
): number | null {
  // Ray parameterized by s in [0, LASER_BEAM_LENGTH_M]: y(s) = apY + s*dy, z(s) = apZ + s*dz.
  // Find interval of s where z(s) in [audienceStartZ, audienceEndZ].
  let sMin = 0;
  let sMax = LASER_BEAM_LENGTH_M;

  if (Math.abs(dz) < 1e-6) {
    if (apZ < audienceStartZ || apZ > audienceEndZ) return null;
  } else {
    const sA = (audienceStartZ - apZ) / dz;
    const sB = (audienceEndZ - apZ) / dz;
    const lo = Math.min(sA, sB);
    const hi = Math.max(sA, sB);
    sMin = Math.max(sMin, lo);
    sMax = Math.min(sMax, hi);
    if (sMin > sMax) return null;
  }

  // Linear function on [sMin, sMax] achieves its minimum at an endpoint; floor is at y = 0.
  const yStart = apY + sMin * dy;
  const yEnd = apY + sMax * dy;
  return Math.max(0, Math.min(yStart, yEnd));
}

function worstLevel(a: LaserSafetyLevel, b: LaserSafetyLevel): LaserSafetyLevel {
  const rank: Record<LaserSafetyLevel, number> = { ok: 0, caution: 1, danger: 2 };
  return rank[b] > rank[a] ? b : a;
}

export interface EvaluateLaserSafetyOptions {
  /** Active ILDA clip if ILDA playback is enabled. */
  ildaClip?: IldaClip | null;
  /** Current ILDA scan size multiplier (0.1..1), defaults to spreadX / spreadY independently. */
  ildaScanScale?: number;
  /** True when momentary Laser bump is held. */
  bumpLaser?: boolean;
}

/**
 * Pure IEC 60825 / ANSI Z136 audience-scanning safety evaluator across every laser projector in the rig.
 * Evaluates worst-case animation angles (including roll) so indicators are stable and testable in Node.
 */
export function evaluateLaserSafety(
  rig: RigConfig,
  laser: ShowState['laser'],
  options: EvaluateLaserSafetyOptions = {},
): RigLaserSafetySummary {
  const placements = placeFixtures(rig).filter(
    (p) => p.group.type === 'laser' || p.group.type === 'floor_laser',
  );

  const audienceStartZ = rig.stageDepth / 2;
  const audienceEndZ = venueAudienceEndZ(rig);

  const laserEnabled = Boolean(options.bumpLaser || (laser.enabled && laser.intensity > 0.01));
  const clip = options.ildaClip ?? null;
  const projectors: ProjectorSafetyReport[] = [];

  let overallLevel: LaserSafetyLevel = 'ok';
  let overallMinClearance: number | null = null;
  let hasClass4 = false;
  let audienceHazardCount = 0;
  let stationaryHazardCount = 0;

  for (const [globalLaserIndex, unit] of placements.entries()) {
    const key = laserProjectorKey(unit.podId ?? null, unit.group.id, unit.index + 1);
    const entry = getCatalogEntry(unit.group.catalogId);
    const spec: CatalogLaserSpec | undefined = entry?.laser;
    const opticalPowerW = spec?.opticalPowerW;
    const laserClass: LaserClass = spec ? spec.laserClass : '4';
    if (laserClass === '4') hasClass4 = true;

    const override = laser.projectors?.[key];
    const beamCount = override?.beamCount ?? laser.beamCount;
    const pitchEnv = laserPitchEnvelope(unit.floor, laser);
    // Floor lasers sit above deck by half chassis height (~0.16 m); overhead lasers hang below truss mount (~0.24 m).
    const originY = unit.floor ? unit.position.y + 0.16 : unit.position.y - 0.24;

    // Determine worst-case downward elevation and horizontal fan half-angles.
    let lowestElevationRad: number;
    let halfAzimuthRad: number;
    let stationaryByIlda = false;

    if (clip && clip.bounds.hasLitPoints) {
      const sx = options.ildaScanScale ?? laser.spreadX;
      const sy = options.ildaScanScale ?? laser.spreadY;
      const { tanHalfX, tanHalfY } = ildaScanTangents(spec?.maxScanAngleDeg, sx, sy);
      const maxRoll = Math.min(Math.PI / 2, Math.max(0, Number.isFinite(laser.rotation) ? laser.rotation : 0) * LASER_ILDA_ROLL_SCALE);

      // Compute worst-case lowest normalized Y tangent across ILDA bounding corners rotated by [-maxRoll, +maxRoll].
      const bxMin = clip.bounds.minX * tanHalfX;
      const bxMax = clip.bounds.maxX * tanHalfX;
      const byMin = clip.bounds.minY * tanHalfY;
      const byMax = clip.bounds.maxY * tanHalfY;
      let worstTanY = byMin;
      let maxAbsTanX = Math.max(Math.abs(bxMin), Math.abs(bxMax));

      if (maxRoll > 0) {
        const corners: Array<[number, number]> = [
          [bxMin, byMin],
          [bxMax, byMin],
          [bxMin, byMax],
          [bxMax, byMax],
        ];
        const sinR = Math.sin(maxRoll);
        const cosR = Math.cos(maxRoll);
        for (const [cx, cy] of corners) {
          const r = Math.hypot(cx, cy);
          // Evaluate y(a) = cx*sin(a) + cy*cos(a) over a in [-maxRoll, +maxRoll].
          const yNeg = -cx * sinR + cy * cosR;
          const yPos = cx * sinR + cy * cosR;
          worstTanY = Math.min(worstTanY, yNeg, yPos);
          // Minimum of cx*sin(a) + cy*cos(a) occurs at a* = atan2(-cx, -cy).
          const aMin = Math.atan2(-cx, -cy);
          if (Math.abs(aMin) <= maxRoll) worstTanY = Math.min(worstTanY, -r);
          maxAbsTanX = Math.max(maxAbsTanX, Math.abs(cx * cosR - cy * sinR), Math.abs(cx * cosR + cy * sinR));
        }
      }

      lowestElevationRad = Math.atan(worstTanY);
      halfAzimuthRad = Math.atan(maxAbsTanX);

      // Exact angular span per frame in degrees (never overstating by 2x).
      const RAD_TO_DEG = 180 / Math.PI;
      stationaryByIlda = clip.frames.some((f) => {
        if (f.litCount === 0) return false;
        const spanDegX = (Math.atan(f.maxLitX * tanHalfX) - Math.atan(f.minLitX * tanHalfX)) * RAD_TO_DEG;
        const spanDegY = (Math.atan(f.maxLitY * tanHalfY) - Math.atan(f.minLitY * tanHalfY)) * RAD_TO_DEG;
        return spanDegX < STATIONARY_ILDA_SPAN_DEG && spanDegY < STATIONARY_ILDA_SPAN_DEG;
      });
    } else {
      const fan = laserFanHalfAngles(laser.pattern, laser.spreadX, laser.spreadY, laser.rotation, globalLaserIndex);
      lowestElevationRad = -fan.halfYRad;
      halfAzimuthRad = fan.halfXRad;
    }

    // Evaluate worst-case (most downward pitch = pitchEnv.maxPitchRad) across center + both lateral fan edges.
    let minClearanceM: number | null = null;
    for (const az of [-halfAzimuthRad, 0, halfAzimuthRad]) {
      const clearance = lowestAudienceHeightForRay(
        originY,
        unit.position.z,
        unit.yaw,
        pitchEnv.maxPitchRad,
        az,
        lowestElevationRad,
        audienceStartZ,
        audienceEndZ,
      );
      if (clearance !== null) {
        minClearanceM = minClearanceM === null ? clearance : Math.min(minClearanceM, clearance);
      }
    }

    const entersAudienceBelowThreshold =
      minClearanceM !== null && minClearanceM < MIN_AUDIENCE_CLEARANCE_M - 1e-6;

    const stationaryByProcedural =
      !clip &&
      ((laser.spreadX <= STATIONARY_SPREAD_THRESHOLD && laser.spreadY <= STATIONARY_SPREAD_THRESHOLD) ||
        (beamCount <= 1 && laser.speed <= 0.001));

    const stationaryHazard = laserEnabled && (stationaryByIlda || stationaryByProcedural);

    const findings: LaserSafetyFinding[] = [];
    let unitLevel: LaserSafetyLevel = 'ok';

    if (laser.audienceScan) {
      findings.push({
        code: 'crowd_scan_enabled',
        severity: 'danger',
        message: CROWD_SCAN_WARNING,
      });
      unitLevel = worstLevel(unitLevel, 'danger');
    }

    if (entersAudienceBelowThreshold && minClearanceM !== null) {
      findings.push({
        code: 'audience_zone',
        severity: 'danger',
        message: `Beam enters audience zone below ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m (min. clearance ${formatClearanceM(minClearanceM)} m).`,
      });
      unitLevel = worstLevel(unitLevel, 'danger');
    }

    if (stationaryHazard) {
      findings.push({
        code: 'stationary_beam',
        severity: 'danger',
        message: 'Stationary beam: no scan-failure protection in preview.',
      });
      unitLevel = worstLevel(unitLevel, 'danger');
    }

    if (laserClass === '4') {
      findings.push({
        code: 'class_4_notice',
        severity: 'caution',
        message: opticalPowerW !== undefined
          ? `Class 4 laser (${opticalPowerW} W optical) — eye & skin hazard.`
          : 'Class 4 show laser — eye & skin hazard.',
      });
    } else {
      findings.push({
        code: 'class_3b_notice',
        severity: 'caution',
        message: opticalPowerW !== undefined
          ? `Class 3B laser (${opticalPowerW} W optical) — direct eye hazard.`
          : 'Class 3B laser — direct eye hazard.',
      });
    }

    if (entersAudienceBelowThreshold || laser.audienceScan) audienceHazardCount++;
    if (stationaryHazard) stationaryHazardCount++;
    if (minClearanceM !== null) {
      overallMinClearance = overallMinClearance === null ? minClearanceM : Math.min(overallMinClearance, minClearanceM);
    }
    overallLevel = worstLevel(overallLevel, unitLevel);

    const location = unit.podId ? rig.trussPods.find((p) => p.id === unit.podId)?.name ?? 'Truss' : 'Floor';
    projectors.push({
      projectorKey: key,
      label: `${location} · ${unit.group.modelName} #${unit.index + 1}`,
      catalogId: unit.group.catalogId,
      laserClass,
      opticalPowerW,
      level: unitLevel,
      minClearanceM,
      entersAudienceBelowThreshold,
      stationaryHazard,
      findings,
    });
  }

  return {
    level: overallLevel,
    laserEnabled,
    projectorCount: projectors.length,
    minClearanceM: overallMinClearance,
    hasClass4,
    audienceHazardCount,
    stationaryHazardCount,
    projectors,
    disclaimer: LASER_SAFETY_DISCLAIMER,
    lateralGuidanceM: LATERAL_SEPARATION_GUIDANCE_M,
  };
}
