import type { RigConfig, ShowState } from '../types/show';
import type { IldaClip } from './ilda';
import { getCatalogEntry, type CatalogLaserSpec } from './equipmentCatalog';
import { placeFixtures } from './fixturePlacement';
import {
  ildaScanTangents,
  LASER_APERTURE_Z_M,
  LASER_ILDA_ROLL_SCALE,
  laserFanHalfAngles,
  laserPitchEnvelope,
} from './laserAim';
import { laserProjectorKey } from './laserProjectors';
import { computeVenueBounds, intersectRayAudienceZone, venueAudienceEndZ } from './venueBounds';

export { venueAudienceEndZ };

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
  originX: number,
  originY: number,
  originZ: number,
  yaw: number,
  pitchRad: number,
  localAzimuthRad: number,
  localElevationRad: number,
  zone: ReturnType<typeof computeVenueBounds>['audienceZone'],
  maxRayLengthM: number,
): number | null {
  const { dx, dy, dz } = laserRayWorldDirection(yaw, pitchRad, localAzimuthRad, localElevationRad);

  // Aperture sits at local (0, 0, LASER_APERTURE_Z_M) rotated by Euler(pitchRad, yaw, 0, 'YXZ').
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const apX = originX + LASER_APERTURE_Z_M * cp * sy;
  const apY = originY - LASER_APERTURE_Z_M * sp;
  const apZ = originZ + LASER_APERTURE_Z_M * cp * cy;

  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;
  const crossing = intersectRayAudienceZone(
    { x: apX, y: apY, z: apZ },
    { x: dx, y: dy, z: dz },
    zone,
    maxRayLengthM,
  );
  return crossing.minClearanceM;
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
  /** Maximum ray distance in metres; defaults to Infinity (clipped strictly to venue audience bounds). */
  maxRayLengthM?: number;
}

/**
 * Pure IEC 60825 / ANSI Z136 audience-scanning safety evaluator across every laser projector in the rig.
 * Evaluates worst-case animation angles (including roll) over the venue's full audience zone
 * using the shared `venueBounds.ts` ray-crossing kernel so 3D overlays, plan zones, and pre-flight agree.
 */
export function evaluateLaserSafety(
  rig: RigConfig,
  laser: ShowState['laser'],
  options: EvaluateLaserSafetyOptions = {},
): RigLaserSafetySummary {
  const placements = placeFixtures(rig).filter(
    (p) => p.group.type === 'laser' || p.group.type === 'floor_laser',
  );

  const bounds = computeVenueBounds(rig);
  const maxRayLengthM =
    options.maxRayLengthM !== undefined && Number.isFinite(options.maxRayLengthM) && options.maxRayLengthM > 0
      ? options.maxRayLengthM
      : Infinity;

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

    // Determine worst-case downward/upward elevation and horizontal fan half-angles.
    let lowestElevationRad: number;
    let highestElevationRad: number;
    let halfAzimuthRad: number;
    let stationaryByIlda = false;

    if (clip && clip.bounds.hasLitPoints) {
      const sx = options.ildaScanScale ?? laser.spreadX;
      const sy = options.ildaScanScale ?? laser.spreadY;
      // When a catalogue laser datasheet omits maxScanAngleDeg, evaluate ILDA clearance conservatively
      // at 60° (matching the widest catalogued galvo scanners) rather than narrowing to the 45° preview default.
      const safetyScanAngleDeg = spec ? (spec.maxScanAngleDeg ?? 60) : undefined;
      const { tanHalfX, tanHalfY } = ildaScanTangents(safetyScanAngleDeg, sx, sy);
      const maxRoll = Math.min(Math.PI / 2, Math.max(0, Number.isFinite(laser.rotation) ? laser.rotation : 0) * LASER_ILDA_ROLL_SCALE);

      // Compute worst-case lowest & highest normalized Y tangent across ILDA bounding corners rotated by [-maxRoll, +maxRoll].
      const bxMin = clip.bounds.minX * tanHalfX;
      const bxMax = clip.bounds.maxX * tanHalfX;
      const byMin = clip.bounds.minY * tanHalfY;
      const byMax = clip.bounds.maxY * tanHalfY;
      let worstTanY = byMin;
      let bestTanY = byMax;
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
          bestTanY = Math.max(bestTanY, yNeg, yPos);
          // Minimum of cx*sin(a) + cy*cos(a) occurs at a* = atan2(-cx, -cy).
          const aMin = Math.atan2(-cx, -cy);
          if (Math.abs(aMin) <= maxRoll) worstTanY = Math.min(worstTanY, -r);
          const aMax = Math.atan2(cx, cy);
          if (Math.abs(aMax) <= maxRoll) bestTanY = Math.max(bestTanY, r);
          maxAbsTanX = Math.max(maxAbsTanX, Math.abs(cx * cosR - cy * sinR), Math.abs(cx * cosR + cy * sinR));
        }
      }

      lowestElevationRad = Math.atan(worstTanY);
      highestElevationRad = Math.atan(bestTanY);
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
      highestElevationRad = fan.halfYRad;
      halfAzimuthRad = fan.halfXRad;
    }

    // Assess the full pitch x elevation envelope against finite floor-clipped audience geometry (Codex R3):
    // steepest downward rays can hit the floor before the audience while shallower phases enter below 3.0 m.
    let minClearanceM: number | null = null;
    const pitchSamples: number[] = [];
    const PITCH_STEPS = 8;
    const pitchSpan = pitchEnv.maxPitchRad - pitchEnv.minPitchRad;
    if (pitchSpan <= 1e-6) {
      pitchSamples.push(pitchEnv.maxPitchRad);
    } else {
      for (let i = 0; i <= PITCH_STEPS; i++) {
        pitchSamples.push(pitchEnv.minPitchRad + (pitchSpan * i) / PITCH_STEPS);
      }
    }
    const elevSamples: number[] = [];
    const ELEV_STEPS = 4;
    const elevSpan = highestElevationRad - lowestElevationRad;
    if (elevSpan <= 1e-6) {
      elevSamples.push(lowestElevationRad);
    } else {
      for (let i = 0; i <= ELEV_STEPS; i++) {
        elevSamples.push(lowestElevationRad + (elevSpan * i) / ELEV_STEPS);
      }
      if (lowestElevationRad < 0 && highestElevationRad > 0) elevSamples.push(0);
    }

    // Add exact analytical pitch angles aimed at the front edge of the audience floor (y=0) and 3 m plane,
    // so even narrow pitch windows that clear the stage floor and enter the audience cannot slip between samples.
    const distToAudienceFront = bounds.audienceZone.minZ - unit.position.z;
    if (distToAudienceFront > 0.1 && originY > 0) {
      for (const targetY of [0.05, 1.5, MIN_AUDIENCE_CLEARANCE_M - 0.1]) {
        const critDownRad = Math.atan2(originY - targetY, distToAudienceFront);
        if (critDownRad >= pitchEnv.minPitchRad && critDownRad <= pitchEnv.maxPitchRad) {
          pitchSamples.push(critDownRad);
        }
        // Also test at lowestElevationRad (effective downward angle = pitch - elev)
        const pitchWithLowElev = critDownRad + lowestElevationRad;
        if (pitchWithLowElev >= pitchEnv.minPitchRad && pitchWithLowElev <= pitchEnv.maxPitchRad) {
          pitchSamples.push(pitchWithLowElev);
        }
      }
    }

    const azSamples = halfAzimuthRad > 1e-6 ? [-halfAzimuthRad, 0, halfAzimuthRad] : [0];
    for (const az of azSamples) {
      for (const pitch of pitchSamples) {
        for (const elev of elevSamples) {
          const clearance = lowestAudienceHeightForRay(
            unit.position.x,
            originY,
            unit.position.z,
            unit.yaw,
            pitch,
            az,
            elev,
            bounds.audienceZone,
            maxRayLengthM,
          );
          if (clearance !== null) {
            minClearanceM = minClearanceM === null ? clearance : Math.min(minClearanceM, clearance);
          }
        }
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
