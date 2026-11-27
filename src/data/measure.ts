import type { RigConfig, ShowState } from '../types/show';
import type { IldaClip } from './ilda';
import { getCatalogEntry, isFieldUnverified, type CatalogLaserSpec } from './equipmentCatalog';
import {
  beamZoomScale,
  createCalibratedFrustum,
  effectiveBeamAngleDeg,
  evaluateCalibratedZoom,
  fixtureOptics,
  resolveMovingFixtureOptics,
  type CalibratedFrustum,
} from './fixtureOptics';
import { placeFixtures } from './fixturePlacement';
import {
  LASER_APERTURE_Z_M,
  laserFanHalfAngles,
  laserPitchEnvelope,
} from './laserAim';
import { laserProjectorKey } from './laserProjectors';
import {
  evaluateLaserSafety,
  LASER_SAFETY_DISCLAIMER,
  laserRayWorldDirection,
  MIN_AUDIENCE_CLEARANCE_M,
  type ProjectorSafetyReport,
} from './laserSafety';
import type { NativeStage } from './showFile';
import { getPlatforms, stageSurfaceHeight } from './stageDesign';
import { resolveStudioGeometry } from './studioGeometry';
import {
  buildSceneRaySurfaces,
  castRayToScene,
  computeVenueBounds,
  intersectRayAudienceZone,
  type AudienceZoneBox,
  type RayHitKind,
  type SceneRaySurfaces,
  type Vec3Tuple,
  type VenueBounds,
} from './venueBounds';
import {
  aimAngles,
  aimTiltOnly,
  axisDmx,
  evaluateAimReachability,
  focusMarks,
  focusPoint,
  HEAD_PIVOT,
  PAN_LIMIT,
  TILT_LIMIT,
} from '../engine/focusAim';
import { movingZoomLens, resolveModelSpec, type FixtureMotion } from '../engine/fixtureModels';
import { headLook } from './movingGroups';

/** Visible-light 0.25 s aversion-response MPE (400–700 nm, IEC 60825-1 / ANSI Z136.1). */
export const NOHD_MPE_W_PER_M2 = 25.4;

/** Documented fallback beam diameter at aperture (mm) when catalogue omits `beamDiameterMm`. */
export const DEFAULT_ASSUMED_APERTURE_MM = 5;

/** Pan/tilt limit proximity warning margin (degrees). */
export const AIM_LIMIT_WARNING_DEG = 5;

export const LASER_LSO_NOTICE =
  'Guidance only — not certification; a qualified laser safety officer must assess the real installation.';

export const AIM_CALIBRATION_NOTE =
  'Hardware calibration deferred: simulated aim may not match real fixture aim.';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const PAN_LIMIT_DEG = PAN_LIMIT * RAD_TO_DEG; // 270
const TILT_LIMIT_DEG = TILT_LIMIT * RAD_TO_DEG; // 135

export type LaserNohdStatus = 'computed' | 'assumed' | 'within-aperture' | 'unknown';

export interface LaserNohdInput {
  opticalPowerW?: number | null;
  divergenceMrad?: number | null;
  beamDiameterMm?: number | null;
  /** Optional flags marking datasheet fields as unverified (treated as unknown per safety rules). */
  powerUnverified?: boolean;
  divergenceUnverified?: boolean;
  apertureUnverified?: boolean;
  /** When true (default), omitted `beamDiameterMm` uses 5 mm and returns `status: 'assumed'` with explicit provenance. */
  allowAssumedAperture?: boolean;
}

export interface LaserNohdResult {
  readonly status: LaserNohdStatus;
  /** Unclipped physical NOHD in metres, `0` when within aperture, or `null` when unknown. */
  readonly nohdM: number | null;
  /** Point-source (zero-aperture) upper bound in metres for transparency, or `null` when unknown. */
  readonly nohdPointSourceM: number | null;
  /** Beam diameter at aperture used (mm), or `null` when unknown. */
  readonly apertureMm: number | null;
  readonly assumedAperture: boolean;
  /** True only when a zone may be drawn (`computed` or `assumed`); strictly false for `unknown`. */
  readonly canDrawZone: boolean;
  readonly reason: string;
}

/**
 * Pure static-beam Nominal Ocular Hazard Distance (NOHD):
 *   NOHD = (1 / phi) * sqrt(4 * P / (pi * MPE) - a^2)
 * with P in watts, phi full-angle divergence in radians, a aperture diameter in metres,
 * and MPE = 25.4 W/m^2 (400–700 nm, 0.25 s aversion response).
 *
 * Unknown is never treated as safe: missing, non-finite, zero, negative, or unverified power or
 * divergence (or explicit invalid aperture) returns `status: 'unknown'` and draws no zone.
 */
export function computeLaserNohd(input: LaserNohdInput): LaserNohdResult {
  const {
    opticalPowerW,
    divergenceMrad,
    beamDiameterMm,
    powerUnverified = false,
    divergenceUnverified = false,
    apertureUnverified = false,
    allowAssumedAperture = true,
  } = input;

  if (powerUnverified || opticalPowerW === undefined || opticalPowerW === null || !Number.isFinite(opticalPowerW) || opticalPowerW <= 0) {
    return {
      status: 'unknown',
      nohdM: null,
      nohdPointSourceM: null,
      apertureMm: null,
      assumedAperture: false,
      canDrawZone: false,
      reason: 'Cannot assess: missing or invalid optical power.',
    };
  }

  if (
    divergenceUnverified ||
    divergenceMrad === undefined ||
    divergenceMrad === null ||
    !Number.isFinite(divergenceMrad) ||
    divergenceMrad <= 0
  ) {
    return {
      status: 'unknown',
      nohdM: null,
      nohdPointSourceM: null,
      apertureMm: null,
      assumedAperture: false,
      canDrawZone: false,
      reason: 'Cannot assess: missing or invalid beam divergence.',
    };
  }

  let apertureMm: number;
  let assumedAperture = false;
  if (apertureUnverified) {
    return {
      status: 'unknown',
      nohdM: null,
      nohdPointSourceM: null,
      apertureMm: null,
      assumedAperture: false,
      canDrawZone: false,
      reason: 'Cannot assess: unverified aperture beam diameter.',
    };
  } else if (beamDiameterMm === undefined) {
    if (!allowAssumedAperture) {
      return {
        status: 'unknown',
        nohdM: null,
        nohdPointSourceM: null,
        apertureMm: null,
        assumedAperture: false,
        canDrawZone: false,
        reason: 'Cannot assess: missing aperture beam diameter.',
      };
    }
    apertureMm = DEFAULT_ASSUMED_APERTURE_MM;
    assumedAperture = true;
  } else if (
    beamDiameterMm === null ||
    !Number.isFinite(beamDiameterMm) ||
    beamDiameterMm <= 0
  ) {
    return {
      status: 'unknown',
      nohdM: null,
      nohdPointSourceM: null,
      apertureMm: null,
      assumedAperture: false,
      canDrawZone: false,
      reason: 'Cannot assess: invalid or unverified aperture beam diameter.',
    };
  } else {
    apertureMm = beamDiameterMm;
  }

  const phiRad = divergenceMrad * 1e-3;
  const aM = apertureMm * 1e-3;
  const term = (4 * opticalPowerW) / (Math.PI * NOHD_MPE_W_PER_M2);
  const nohdPointSourceM = Math.sqrt(term) / phiRad;
  const radicand = term - aM * aM;

  if (radicand <= 0) {
    return {
      status: 'within-aperture',
      nohdM: 0,
      nohdPointSourceM,
      apertureMm,
      assumedAperture,
      canDrawZone: false,
      reason: assumedAperture
        ? `Cannot be assessed beyond assumed ${apertureMm} mm aperture (formula yields <= 0 m); LSO assessment required.`
        : 'Cannot be assessed beyond aperture (formula yields <= 0 m); LSO assessment required.',
    };
  }

  const nohdM = Math.sqrt(radicand) / phiRad;
  if (!Number.isFinite(nohdM)) {
    return {
      status: 'unknown',
      nohdM: null,
      nohdPointSourceM: null,
      apertureMm: null,
      assumedAperture: false,
      canDrawZone: false,
      reason: 'Cannot assess: non-finite NOHD calculation.',
    };
  }

  return {
    status: assumedAperture ? 'assumed' : 'computed',
    nohdM,
    nohdPointSourceM,
    apertureMm,
    assumedAperture,
    canDrawZone: true,
    reason: assumedAperture
      ? `Approx. ${Math.round(nohdM)} m (assumed ${apertureMm} mm aperture; static beam, 0.25 s MPE).`
      : `Approx. ${Math.round(nohdM)} m (static beam, ${apertureMm} mm aperture, 0.25 s MPE).`,
  };
}

export interface BeamFootprint {
  /** Circular diameter at normal incidence, including the aperture for a calibrated head. */
  readonly normalDiameterM: number;
  /** Minor ellipse diameter on the hit surface (m), or `null` when clipped or grazing. */
  readonly minorDiameterM: number | null;
  /** Stretched major ellipse diameter on an oblique surface (m), or `null` when clipped or grazing. */
  readonly majorDiameterM: number | null;
  /** True when the cone edge is parallel/past the hit plane (`alpha + beta >= 90°`) or near-grazing blow-up. */
  readonly grazing: boolean;
  /** True when a calibrated ellipse extends beyond the lens or the finite end plane. */
  readonly clipped?: boolean;
}

const MAX_OBLIQUE_ELONGATION_RATIO = 50;

/**
 * Compute beam footprint on a plane at throw distance `throwM`, full beam angle `beamAngleDeg`,
 * and incidence angle `incidenceDeg` (`0°` = normal, `90°` = parallel).
 * Uses exact point-cone / plane conic section geometry when `alpha + beta < 90°`.
 */
export function computeBeamFootprint(
  throwM: number,
  beamAngleDeg: number,
  incidenceDeg: number,
): BeamFootprint {
  const d = Number.isFinite(throwM) && throwM > 0 ? throwM : 0;
  const halfRad = Math.max(1e-4, Math.min((89.5 * Math.PI) / 180, (beamAngleDeg * DEG_TO_RAD) / 2));
  const k = Math.tan(halfRad);
  return coneSection(2 * d * k, k, incidenceDeg);
}

function coneSection(normalDiameterM: number, k: number, incidenceDeg: number): BeamFootprint {
  const alphaRad = incidenceRadians(incidenceDeg);
  const c = Math.cos(alphaRad);
  const q = c * c - k * k * (1 - c * c);
  if (q <= 1e-3 || c < 0.05) {
    return {
      normalDiameterM,
      minorDiameterM: null,
      majorDiameterM: null,
      grazing: true,
    };
  }

  const minorDiameterM = (normalDiameterM * c) / Math.sqrt(q);
  const majorDiameterM = (normalDiameterM * c) / q;
  if (
    !Number.isFinite(majorDiameterM) ||
    !Number.isFinite(minorDiameterM) ||
    (normalDiameterM > 0 && majorDiameterM > normalDiameterM * MAX_OBLIQUE_ELONGATION_RATIO)
  ) {
    return {
      normalDiameterM,
      minorDiameterM: null,
      majorDiameterM: null,
      grazing: true,
    };
  }

  return {
    normalDiameterM,
    minorDiameterM,
    majorDiameterM,
    grazing: false,
  };
}

function incidenceRadians(degrees: number): number {
  return Math.max(0, Math.min(Math.PI / 2, (Number.isFinite(degrees) ? degrees : 0) * DEG_TO_RAD));
}

export function computeCalibratedBeamFootprint(
  throwM: number,
  incidenceDeg: number,
  frustum: Pick<CalibratedFrustum, 'length' | 'nearRadius' | 'slope'>,
): BeamFootprint {
  const { nearRadius, slope, length } = frustum;
  const throwFromLens = Number.isFinite(throwM) ? Math.max(0, throwM) : 0;
  // The equivalent apex is nearRadius / slope behind the lens. Use that shift
  // only in the section geometry, while throw and lux are measured from the lens.
  const section = coneSection(2 * (nearRadius + throwFromLens * slope), slope, incidenceDeg);
  if (section.grazing) return section;
  const t = Math.tan(incidenceRadians(incidenceDeg));
  const start = (throwFromLens - nearRadius * t) / (1 + slope * t);
  const end = (throwFromLens + nearRadius * t) / (1 - slope * t);
  if (start < -1e-9 || end > length + 1e-9) {
    return { ...section, minorDiameterM: null, majorDiameterM: null, clipped: true };
  }
  return section;
}

/**
 * Uniform-cone photometric illuminance estimate (lux) using spherical-cap solid angle
 * `Omega = 2 * pi * (1 - cos(beta))` (matching `fixtureOptics.ts`).
 * Returns `null` whenever photometric lumens are absent/invalid, throw < 0.5 m, or incidence is grazing (`cos(alpha) < 0.05`).
 */
export function estimateIlluminanceLux(
  lumens: number | null | undefined,
  beamAngleDeg: number,
  throwM: number,
  incidenceDeg: number,
  dimmer = 1,
): number | null {
  if (lumens === null || lumens === undefined || !Number.isFinite(lumens) || lumens <= 0) return null;
  if (!Number.isFinite(throwM) || throwM < 0.5) return null;
  if (!Number.isFinite(beamAngleDeg) || beamAngleDeg <= 0 || beamAngleDeg >= 180) return null;
  if (!Number.isFinite(dimmer) || dimmer < 0) return null;

  const alphaRad = Math.max(0, Math.min(Math.PI / 2, (Number.isFinite(incidenceDeg) ? incidenceDeg : 0) * DEG_TO_RAD));
  const cosAlpha = Math.cos(alphaRad);
  if (cosAlpha < 0.05) return null;

  const halfRad = (beamAngleDeg * DEG_TO_RAD) / 2;
  const t = Math.tan(halfRad);
  const hyp = Math.hypot(1, t);
  // Rationalized `1 - cos(beta) = t^2 / (hyp * (hyp + 1))` preserves precision on narrow beams.
  const oneMinusCos = (t * t) / (hyp * (hyp + 1));
  const solidAngleSr = 2 * Math.PI * oneMinusCos;
  if (solidAngleSr <= 1e-12) return null;

  const intensityCd = (lumens * Math.min(1, dimmer)) / solidAngleSr;
  const lux = (intensityCd * cosAlpha) / (throwM * throwM);
  return Number.isFinite(lux) ? lux : null;
}

export type FixtureMeasureWarningCode =
  | 'pan_limit'
  | 'tilt_limit'
  | 'no_hit'
  | 'audience_clearance';

export interface FixtureMeasureWarning {
  readonly code: FixtureMeasureWarningCode;
  readonly severity: 'warn' | 'danger';
  readonly message: string;
}

/** Live per-head input supplied directly by `StageEngine` (never recomputes placement or aim). */
export interface EngineHeadSample {
  readonly unitId: string;
  readonly fixtureNumber: number;
  readonly groupId: string;
  readonly podId: string | null;
  readonly positionName: string;
  readonly label: string;
  readonly modelName: string;
  readonly type: 'beam' | 'wash';
  readonly motion: FixtureMotion;
  readonly isFloor: boolean;
  readonly mountPosition: Vec3Tuple;
  readonly lensOrigin: Vec3Tuple;
  readonly direction: Vec3Tuple;
  readonly panRad: number;
  readonly tiltRad: number;
  readonly zoomScale: number;
  readonly optics: Pick<ReturnType<typeof fixtureOptics>, 'length' | 'nearRadius' | 'farRadius'>;
  readonly frustum?: CalibratedFrustum;
  readonly hasAuthoredLumens?: boolean;
  /** Explicitly configured/verified lumens, or `null` when photometric data is unavailable. */
  readonly configuredLumens: number | null;
  /** Live applied dimmer in `[0, 1]` (post-master/blackout, without render gain). */
  readonly appliedDimmer: number;
  /** True when the fixture is emitting visible output this frame. */
  readonly emittedVisible: boolean;
  /** Optional screen-space projection of hit/origin in normalized viewport `[0..1]`, filled by StageEngine. */
  readonly screenX?: number | null;
  readonly screenY?: number | null;
  readonly inView?: boolean;
}

export interface FixtureMeasurement {
  readonly unitId: string;
  readonly fixtureNumber: number;
  readonly groupId: string;
  readonly podId: string | null;
  readonly positionName: string;
  readonly label: string;
  readonly modelName: string;
  readonly type: 'beam' | 'wash';
  readonly motion: FixtureMotion;
  readonly isFloor: boolean;
  readonly lensOrigin: Vec3Tuple;
  readonly direction: Vec3Tuple;
  /** Trim height above the stage deck directly underneath (m). */
  readonly trimAboveDeckM: number;
  /** Trim height above venue floor `y = 0` (m). */
  readonly trimAboveFloorM: number;
  readonly panDeg: number;
  readonly tiltDeg: number;
  readonly panDmx: number;
  readonly tiltDmx: number;
  readonly beamAngleDeg: number;
  readonly hitKind: RayHitKind;
  readonly hitSurfaceLabel: string | null;
  readonly hitPoint: Vec3Tuple | null;
  readonly throwM: number | null;
  readonly incidenceDeg: number | null;
  readonly footprint: BeamFootprint | null;
  readonly calibratedOptics?: {
    readonly apertureRadiusM: number;
    readonly maxThrowM: number;
    readonly nominalPreviewLumens: number;
    readonly photometricLumens: number | null;
    readonly fluxSource: 'authored' | 'catalogue' | 'preview fallback';
  };
  /** Estimated illuminance (lux) at full fixture output, or `null` (`n/a`) when no photometric data exists. */
  readonly luxFullEst: number | null;
  /** Estimated illuminance (lux) at live applied dimmer, or `null` (`n/a`) when no photometric data exists. */
  readonly luxLiveEst: number | null;
  readonly entersAudienceBelowThreshold: boolean;
  readonly audienceEnterT: number | null;
  readonly audienceExitT: number | null;
  readonly minAudienceClearanceM: number | null;
  readonly nearPanLimit: boolean;
  readonly nearTiltLimit: boolean;
  readonly emittedVisible: boolean;
  readonly warnings: readonly FixtureMeasureWarning[];
  /** Highest warning rank (`0 = ok`, `1 = warn`, `2 = danger`) for worst-offender sorting. */
  readonly severityRank: 0 | 1 | 2;
  readonly screenX?: number | null;
  readonly screenY?: number | null;
  readonly inView?: boolean;
}

/**
 * Compute the lowest ray direction on a circular beam cone of half-angle `halfAngleRad`
 * in the vertical plane containing the beam axis `dir`.
 * Returns `null` when the beam axis is already vertical (`hypot(dx, dz) < 1e-6`).
 */
export function lowerConeEdgeDirection(dir: Vec3Tuple, halfAngleRad: number): Vec3Tuple | null {
  const horiz = Math.hypot(dir.x, dir.z);
  if (horiz < 1e-6 || !Number.isFinite(halfAngleRad) || halfAngleRad <= 1e-5) return null;
  const elev = Math.atan2(dir.y, horiz);
  const lowerElev = Math.max(-Math.PI / 2 + 1e-5, elev - halfAngleRad);
  const cosE = Math.cos(lowerElev);
  return {
    x: (dir.x / horiz) * cosE,
    y: Math.sin(lowerElev),
    z: (dir.z / horiz) * cosE,
  };
}

/** The lowest aperture rim, or for a vertical axis the rim facing the nearest audience point. */
function apertureRimDirection(axis: Vec3Tuple, origin: Vec3Tuple, zone: AudienceZoneBox): Vec3Tuple | null {
  const horizontal = Math.hypot(axis.x, axis.z);
  if (horizontal >= 1e-6) {
    return { x: axis.x * axis.y / horizontal, y: -horizontal, z: axis.z * axis.y / horizontal };
  }
  const dx = Math.max(zone.minX, Math.min(zone.maxX, origin.x)) - origin.x;
  const dz = Math.max(zone.minZ, Math.min(zone.maxZ, origin.z)) - origin.z;
  const along = dx * axis.x + dz * axis.z;
  const x = dx - along * axis.x;
  const y = -along * axis.y;
  const z = dz - along * axis.z;
  const norm = Math.hypot(x, y, z);
  return norm >= 1e-6 ? { x: x / norm, y: y / norm, z: z / norm } : null;
}

/**
 * Pure per-unit measurement from live engine aim data + pre-built scene surfaces.
 * Checks audience keep-out clearance for both the beam center axis and the lower cone edge
 * so wide washes whose axis clears 3.0 m still flag when their lower cone edge dips into the crowd.
 */
export function measureFixtureUnit(
  sample: EngineHeadSample,
  rig: RigConfig,
  surfaces: SceneRaySurfaces,
): FixtureMeasurement {
  const deckY = stageSurfaceHeight(rig, sample.mountPosition.x, sample.mountPosition.z);
  const trimAboveFloorM = sample.mountPosition.y;
  const trimAboveDeckM = sample.mountPosition.y - deckY;

  const panDeg = sample.panRad * RAD_TO_DEG;
  const tiltDeg = sample.tiltRad * RAD_TO_DEG;
  const panDmx = axisDmx(sample.panRad, PAN_LIMIT);
  const tiltDmx = axisDmx(sample.tiltRad, TILT_LIMIT);
  const frustum = sample.frustum;
  const beamAngleDeg = frustum?.beamAngleDeg ?? effectiveBeamAngleDeg(sample.optics, sample.zoomScale);

  const hit = castRayToScene(sample.lensOrigin, sample.direction, surfaces);
  const maxAudienceT = Math.min(hit.distanceM ?? Infinity, frustum?.length ?? Infinity);
  const axisAudience = intersectRayAudienceZone(
    sample.lensOrigin,
    sample.direction,
    surfaces.bounds.audienceZone,
    maxAudienceT,
  );

  // Check the lens rim and cone edge as well as the centreline for audience spill.
  const axis = sample.direction;
  const rim = frustum ? apertureRimDirection(axis, sample.lensOrigin, surfaces.bounds.audienceZone) : null;
  let edgeOrigin = sample.lensOrigin;
  let lowerDir: Vec3Tuple | null;
  let edgeLength = Infinity;
  if (frustum && rim) {
    edgeOrigin = {
      x: edgeOrigin.x + frustum.nearRadius * rim.x,
      y: edgeOrigin.y + frustum.nearRadius * rim.y,
      z: edgeOrigin.z + frustum.nearRadius * rim.z,
    };
    const k = frustum.slope;
    const norm = Math.hypot(1, k);
    lowerDir = {
      x: (axis.x + k * rim.x) / norm,
      y: (axis.y + k * rim.y) / norm,
      z: (axis.z + k * rim.z) / norm,
    };
    edgeLength = frustum.length * norm;
  } else {
    lowerDir = frustum ? null : lowerConeEdgeDirection(axis, (beamAngleDeg * DEG_TO_RAD) / 2);
  }
  let edgeAudience: ReturnType<typeof intersectRayAudienceZone> | null = null;
  if (lowerDir) {
    const edgeHit = castRayToScene(edgeOrigin, lowerDir, surfaces);
    const maxEdgeT = Math.min(edgeHit.distanceM ?? Infinity, edgeLength);
    edgeAudience = intersectRayAudienceZone(
      edgeOrigin,
      lowerDir,
      surfaces.bounds.audienceZone,
      maxEdgeT,
    );
  }

  let minAudienceClearanceM = axisAudience.minClearanceM;
  if (edgeAudience && edgeAudience.minClearanceM !== null) {
    minAudienceClearanceM =
      minAudienceClearanceM === null
        ? edgeAudience.minClearanceM
        : Math.min(minAudienceClearanceM, edgeAudience.minClearanceM);
  }
  const audienceEnters = axisAudience.enters || Boolean(edgeAudience?.enters);

  const footprint =
    hit.distanceM !== null && hit.incidenceDeg !== null
      ? frustum
        ? computeCalibratedBeamFootprint(hit.distanceM, hit.incidenceDeg, frustum)
        : computeBeamFootprint(hit.distanceM, beamAngleDeg, hit.incidenceDeg)
      : null;

  const luxFullEst =
    hit.distanceM !== null && hit.incidenceDeg !== null && hit.distanceM <= (frustum?.length ?? Infinity)
      ? estimateIlluminanceLux(sample.configuredLumens, beamAngleDeg, hit.distanceM, hit.incidenceDeg, 1)
      : null;
  const luxLiveEst =
    hit.distanceM !== null && hit.incidenceDeg !== null && hit.distanceM <= (frustum?.length ?? Infinity)
      ? estimateIlluminanceLux(
          sample.configuredLumens,
          beamAngleDeg,
          hit.distanceM,
          hit.incidenceDeg,
          sample.appliedDimmer,
        )
      : null;

  const nearPanLimit = sample.motion === 'pan-tilt' && Math.abs(panDeg) >= PAN_LIMIT_DEG - AIM_LIMIT_WARNING_DEG - 1e-6;
  const nearTiltLimit = sample.motion !== 'fixed' && Math.abs(tiltDeg) >= TILT_LIMIT_DEG - AIM_LIMIT_WARNING_DEG - 1e-6;
  const entersAudienceBelowThreshold =
    audienceEnters || (minAudienceClearanceM !== null && minAudienceClearanceM < MIN_AUDIENCE_CLEARANCE_M - 1e-6);
  const calibratedOptics: FixtureMeasurement['calibratedOptics'] = frustum ? {
    apertureRadiusM: frustum.nearRadius,
    maxThrowM: frustum.length,
    nominalPreviewLumens: frustum.nominalLumens,
    photometricLumens: sample.configuredLumens,
    fluxSource: sample.hasAuthoredLumens ? 'authored' : sample.configuredLumens !== null ? 'catalogue' : 'preview fallback',
  } : undefined;

  const warnings: FixtureMeasureWarning[] = [];
  let severityRank: 0 | 1 | 2 = 0;

  if (entersAudienceBelowThreshold) {
    const clr = minAudienceClearanceM !== null ? `${minAudienceClearanceM.toFixed(1)} m` : `< ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m`;
    const edgeOnly = !axisAudience.enters && Boolean(edgeAudience?.enters);
    warnings.push({
      code: 'audience_clearance',
      severity: 'danger',
      message: edgeOnly
        ? `Beam lower cone edge enters audience zone below ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m (clearance ${clr}).`
        : `Beam enters audience zone below ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m (clearance ${clr}).`,
    });
    severityRank = 2;
  }

  if (nearPanLimit) {
    warnings.push({
      code: 'pan_limit',
      severity: 'warn',
      message: `Pan ${panDeg.toFixed(1)}° is within ${AIM_LIMIT_WARNING_DEG}° of ±${PAN_LIMIT_DEG}° limit.`,
    });
    if (severityRank < 1) severityRank = 1;
  }

  if (nearTiltLimit) {
    warnings.push({
      code: 'tilt_limit',
      severity: 'warn',
      message: `Tilt ${tiltDeg.toFixed(1)}° is within ${AIM_LIMIT_WARNING_DEG}° of ±${TILT_LIMIT_DEG}° limit.`,
    });
    if (severityRank < 1) severityRank = 1;
  }

  if (hit.kind === 'none') {
    warnings.push({
      code: 'no_hit',
      severity: 'warn',
      message: 'Beam hits no stage or venue surface.',
    });
    if (severityRank < 1) severityRank = 1;
  }

  return {
    unitId: sample.unitId,
    fixtureNumber: sample.fixtureNumber,
    groupId: sample.groupId,
    podId: sample.podId,
    positionName: sample.positionName,
    label: sample.label,
    modelName: sample.modelName,
    type: sample.type,
    motion: sample.motion,
    isFloor: sample.isFloor,
    lensOrigin: sample.lensOrigin,
    direction: sample.direction,
    trimAboveDeckM,
    trimAboveFloorM,
    panDeg,
    tiltDeg,
    panDmx,
    tiltDmx,
    beamAngleDeg,
    hitKind: hit.kind,
    hitSurfaceLabel: hit.surfaceLabel,
    hitPoint: hit.point,
    throwM: hit.distanceM,
    incidenceDeg: hit.incidenceDeg,
    footprint,
    ...(calibratedOptics && { calibratedOptics }),
    luxFullEst,
    luxLiveEst,
    entersAudienceBelowThreshold,
    audienceEnterT: axisAudience.enterT,
    audienceExitT: axisAudience.exitT,
    minAudienceClearanceM,
    nearPanLimit,
    nearTiltLimit,
    emittedVisible: sample.emittedVisible,
    warnings,
    severityRank,
    screenX: sample.screenX,
    screenY: sample.screenY,
    inView: sample.inView,
  };
}

export interface LaserHazardZone {
  readonly projectorKey: string;
  readonly label: string;
  readonly groupId: string;
  readonly podId: string | null;
  readonly catalogId?: string;
  readonly origin: Vec3Tuple;
  readonly yaw: number;
  readonly maxDownPitchRad: number;
  readonly halfAzimuthRad: number;
  readonly halfElevationRad: number;
  readonly nohd: LaserNohdResult;
  /** Distance clipped to the venue extents for drawing (m), or `null` when zone cannot be drawn. */
  readonly displayDistanceM: number | null;
  /** True when the audience zone falls inside the projector's NOHD hazard envelope. */
  readonly audienceInsideNohd: boolean;
  /** Shared clearance report from `evaluateLaserSafety` (same venue-bound kernel). */
  readonly safety: ProjectorSafetyReport;
  /** 2D plan wedge polygon `[{x, z}, ...]` clipped to venue bounds for StageDesigner SVG. */
  readonly planPolygon: readonly { readonly x: number; readonly z: number }[];
}

function clipRayHorizontalToBounds(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
  bounds: VenueBounds,
): number {
  let t = maxDist;
  const minX = -bounds.halfWidth;
  const maxX = bounds.halfWidth;
  const minZ = bounds.backZ;
  const maxZ = bounds.rearZ;

  if (Math.abs(dx) > 1e-6) {
    const tx = dx > 0 ? (maxX - ox) / dx : (minX - ox) / dx;
    if (tx > 0 && tx < t) t = tx;
  }
  if (Math.abs(dz) > 1e-6) {
    const tz = dz > 0 ? (maxZ - oz) / dz : (minZ - oz) / dz;
    if (tz > 0 && tz < t) t = tz;
  }
  return Math.max(0, t);
}

/**
 * Evaluate laser NOHD zones and audience-zone overlap for every laser projector in the rig.
 * Reuses `evaluateLaserSafety()` so clearance numbers agree identically across all UI surfaces.
 */
export function evaluateLaserZones(
  sourceRig: RigConfig,
  laser: ShowState['laser'],
  options: {
    stage?: NativeStage;
    ildaClip?: IldaClip | null;
    bumpLaser?: boolean;
    allowAssumedAperture?: boolean;
  } = {},
): {
  readonly bounds: VenueBounds;
  readonly zones: readonly LaserHazardZone[];
  readonly disclaimer: string;
  readonly lsoNotice: string;
} {
  const { rig } = resolveStudioGeometry(sourceRig, options.stage?.layout);
  const bounds = computeVenueBounds(rig);
  const safetySummary = evaluateLaserSafety(rig, laser, {
    ildaClip: options.ildaClip,
    bumpLaser: options.bumpLaser,
  });
  const safetyByKey = new Map(safetySummary.projectors.map((p) => [p.projectorKey, p]));
  const placements = placeFixtures(rig).filter(
    (p) => p.group.type === 'laser' || p.group.type === 'floor_laser',
  );

  const zones: LaserHazardZone[] = [];
  for (const [globalIdx, unit] of placements.entries()) {
    const key = laserProjectorKey(unit.podId ?? null, unit.group.id, unit.index + 1);
    const safety = safetyByKey.get(key);
    if (!safety) continue;

    const entry = getCatalogEntry(unit.group.catalogId);
    const spec: CatalogLaserSpec | undefined = entry?.laser;
    // Use conservative maximum rated optical power for NOHD safety when datasheet states a higher max than guaranteed (Codex review-05 R2).
    const safetyOpticalPowerW = spec
      ? Math.max(spec.opticalPowerW, spec.maxOpticalPowerW ?? spec.opticalPowerW)
      : undefined;
    const nohd = computeLaserNohd({
      opticalPowerW: safetyOpticalPowerW,
      divergenceMrad: spec?.divergenceMrad,
      beamDiameterMm: spec?.beamDiameterMm,
      powerUnverified: entry ? isFieldUnverified(entry, 'laser.opticalPowerW') : false,
      divergenceUnverified: entry ? isFieldUnverified(entry, 'laser.divergenceMrad') : false,
      apertureUnverified: entry ? isFieldUnverified(entry, 'laser.beamDiameterMm') : false,
      allowAssumedAperture: options.allowAssumedAperture ?? true,
    });

    const pitchEnv = laserPitchEnvelope(unit.floor, laser);
    const originY = unit.floor ? unit.position.y + 0.16 : unit.position.y - 0.24;
    const cp = Math.cos(pitchEnv.maxPitchRad);
    const sp = Math.sin(pitchEnv.maxPitchRad);
    const cy = Math.cos(unit.yaw);
    const sy = Math.sin(unit.yaw);
    const origin: Vec3Tuple = {
      x: unit.position.x + LASER_APERTURE_Z_M * cp * sy,
      y: originY - LASER_APERTURE_Z_M * sp,
      z: unit.position.z + LASER_APERTURE_Z_M * cp * cy,
    };

    const fan = laserFanHalfAngles(laser.pattern, laser.spreadX, laser.spreadY, laser.rotation, globalIdx);
    const halfAzimuthRad = Math.max(0.08, fan.halfXRad);
    const halfElevationRad = Math.max(0.05, fan.halfYRad);

    let displayDistanceM: number | null = null;
    let audienceInsideNohd = false;
    const planPolygon: Array<{ x: number; z: number }> = [];

    if (nohd.canDrawZone && nohd.nohdM !== null && nohd.nohdM > 0) {
      // Clip to venue horizontal extent along forward + fan edges.
      const centerDir = laserRayWorldDirection(unit.yaw, pitchEnv.maxPitchRad, 0, 0);
      const horizLen = Math.hypot(centerDir.dx, centerDir.dz);
      const centerClip =
        horizLen > 1e-4
          ? clipRayHorizontalToBounds(origin.x, origin.z, centerDir.dx / horizLen, centerDir.dz / horizLen, nohd.nohdM, bounds)
          : Math.min(nohd.nohdM, 30);
      displayDistanceM = Math.min(nohd.nohdM, Math.max(1, centerClip));

      // Check whether any point in the audience zone lies within NOHD distance AND inside the forward fan/sphere.
      const az = bounds.audienceZone;
      const clampedX = Math.max(az.minX, Math.min(az.maxX, origin.x));
      const clampedY = Math.max(az.minY, Math.min(az.maxY, origin.y));
      const clampedZ = Math.max(az.minZ, Math.min(az.maxZ, origin.z));
      const nearestAudDist = Math.hypot(clampedX - origin.x, clampedY - origin.y, clampedZ - origin.z);
      const fanReachesAudience = safety.minClearanceM !== null;
      audienceInsideNohd =
        nearestAudDist <= nohd.nohdM &&
        (safety.entersAudienceBelowThreshold || (fanReachesAudience && nearestAudDist <= nohd.nohdM));

      // Build 2D plan wedge polygon clipped to venue bounds.
      planPolygon.push({ x: origin.x, z: origin.z });
      const steps = 12;
      for (let s = 0; s <= steps; s++) {
        const frac = -1 + (2 * s) / steps;
        const angle = unit.yaw + frac * halfAzimuthRad;
        const dx = Math.sin(angle);
        const dz = Math.cos(angle);
        const r = clipRayHorizontalToBounds(origin.x, origin.z, dx, dz, nohd.nohdM, bounds);
        planPolygon.push({ x: origin.x + dx * r, z: origin.z + dz * r });
      }
    }

    zones.push({
      projectorKey: key,
      label: safety.label,
      groupId: unit.group.id,
      podId: unit.podId ?? null,
      catalogId: unit.group.catalogId,
      origin,
      yaw: unit.yaw,
      maxDownPitchRad: pitchEnv.maxPitchRad,
      halfAzimuthRad,
      halfElevationRad,
      nohd,
      displayDistanceM,
      audienceInsideNohd,
      safety,
      planPolygon,
    });
  }

  return {
    bounds,
    zones,
    disclaimer: LASER_SAFETY_DISCLAIMER,
    lsoNotice: LASER_LSO_NOTICE,
  };
}

export interface HeadReachArea {
  readonly unitId: string;
  readonly fixtureNumber: number;
  readonly groupId: string;
  readonly label: string;
  readonly motion: FixtureMotion;
  readonly kind: 'polygon' | 'locus' | 'fixed';
  /** World-space `(x, y, z)` boundary points on the stage deck plane. */
  readonly points: readonly Vec3Tuple[];
}

export interface ReachMapResult {
  readonly deckY: number;
  readonly areas: readonly HeadReachArea[];
  /** Union bounding box of all pan-tilt reachable points on the deck plane. */
  readonly unionPolygon: readonly Vec3Tuple[];
}

/**
 * Compute the stage-deck reachability envelope for moving heads within `PAN_LIMIT`/`TILT_LIMIT`.
 * Pan-tilt heads produce a reach polygon on the deck plane; tilt-only battens produce a line locus;
 * fixed fixtures produce no motorized reach polygon.
 */
export function computeReachMap(sourceRig: RigConfig, stage?: NativeStage): ReachMapResult {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const placements = placeFixtures(rig);
  const platforms = getPlatforms(rig);
  const deckY = platforms.length ? Math.max(...platforms.map((p) => p.height)) : rig.stageHeight;

  const minStageX = platforms.length ? Math.min(...platforms.map((p) => p.x - p.width / 2)) - 2 : -rig.stageWidth / 2 - 2;
  const maxStageX = platforms.length ? Math.max(...platforms.map((p) => p.x + p.width / 2)) + 2 : rig.stageWidth / 2 + 2;
  const minStageZ = platforms.length ? Math.min(...platforms.map((p) => p.z - p.depth / 2)) - 2 : -rig.stageDepth / 2 - 2;
  const maxStageZ = platforms.length ? Math.max(...platforms.map((p) => p.z + p.depth / 2)) + 2 : rig.stageDepth / 2 + 2;

  const areas: HeadReachArea[] = [];
  let unionMinX = Infinity;
  let unionMaxX = -Infinity;
  let unionMinZ = Infinity;
  let unionMaxZ = -Infinity;

  let movingHeadNumber = 0;
  for (let i = 0; i < placements.length; i++) {
    const unit = placements[i];
    if (unit.group.type !== 'beam' && unit.group.type !== 'wash' && unit.group.type !== 'floor_beam') continue;
    movingHeadNumber++;
    const spec = resolveModelSpec(unit.group.type, unit.group.catalogId);
    const pivotY = unit.group.catalogId ? spec.pivotY : HEAD_PIVOT;
    const dir = unit.floor ? 1 : -1;
    const pivotWorldY = unit.position.y + dir * pivotY;
    const unitId = `${unit.podId ?? 'floor'}:${unit.group.id}:${unit.index}`;
    const label = `${unit.group.modelName} #${unit.index + 1}`;

    if (spec.motion === 'fixed') {
      areas.push({
        unitId,
        fixtureNumber: movingHeadNumber,
        groupId: unit.group.id,
        label,
        motion: 'fixed',
        kind: 'fixed',
        points: [],
      });
      continue;
    }

    if (spec.motion === 'tilt') {
      // Single-axis batten sweeps in its local YZ plane (`sin(yaw), cos(yaw)` direction).
      const dy = deckY - pivotWorldY;
      const forwardX = Math.sin(unit.yaw);
      const forwardZ = Math.cos(unit.yaw);
      const maxReach = Math.min(20, Math.abs(dy) * Math.tan(Math.min(TILT_LIMIT, (82 * Math.PI) / 180)));
      const pts: Vec3Tuple[] = [];
      for (const s of [-maxReach, maxReach]) {
        const wx = Math.max(minStageX, Math.min(maxStageX, unit.position.x + forwardX * s));
        const wz = Math.max(minStageZ, Math.min(maxStageZ, unit.position.z + forwardZ * s));
        pts.push({ x: wx, y: deckY + 0.03, z: wz });
      }
      areas.push({
        unitId,
        fixtureNumber: movingHeadNumber,
        groupId: unit.group.id,
        label,
        motion: 'tilt',
        kind: 'locus',
        points: pts,
      });
      continue;
    }

    // Approximate stage-deck reach envelope for pan-tilt moving heads (±135° tilt exceeds 90°).
    // Both hung heads above deckY (`dy > 0`) and upright floor heads sitting on deckY (`dy > 0`,
    // tilting past 90° up to 135° = 45° below horizontal) can sweep out across the stage deck.
    const dy = pivotWorldY - deckY;
    if (!unit.floor && dy <= 0) {
      // Hung fixture below deck plane cannot aim downward onto deckY.
      areas.push({
        unitId,
        fixtureNumber: movingHeadNumber,
        groupId: unit.group.id,
        label,
        motion: 'pan-tilt',
        kind: 'fixed',
        points: [],
      });
      continue;
    }

    // Approximate horizontal reach on deckY clipped to the stage envelope.
    // Hung heads reach from directly beneath out to `dy * tan(min(TILT_LIMIT, 85°))`;
    // upright floor heads reach outward past `rMin = dy / tan(TILT_LIMIT - 90°)` to the stage bounds.
    const stageDiag = Math.hypot(maxStageX - minStageX, maxStageZ - minStageZ);
    const radius = unit.floor
      ? Math.max(4, stageDiag)
      : Math.min(stageDiag, Math.abs(dy) * Math.tan(Math.min(TILT_LIMIT, (85 * Math.PI) / 180)));
    const pts: Vec3Tuple[] = [];
    const segs = 20;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const wx = Math.max(minStageX, Math.min(maxStageX, unit.position.x + Math.cos(a) * radius));
      const wz = Math.max(minStageZ, Math.min(maxStageZ, unit.position.z + Math.sin(a) * radius));
      pts.push({ x: wx, y: deckY + 0.03, z: wz });
      if (wx < unionMinX) unionMinX = wx;
      if (wx > unionMaxX) unionMaxX = wx;
      if (wz < unionMinZ) unionMinZ = wz;
      if (wz > unionMaxZ) unionMaxZ = wz;
    }
    areas.push({
      unitId,
      fixtureNumber: movingHeadNumber,
      groupId: unit.group.id,
      label,
      motion: 'pan-tilt',
      kind: 'polygon',
      points: pts,
    });
  }

  const unionPolygon: Vec3Tuple[] =
    Number.isFinite(unionMinX) && Number.isFinite(unionMaxX)
      ? [
          { x: unionMinX, y: deckY + 0.03, z: unionMinZ },
          { x: unionMaxX, y: deckY + 0.03, z: unionMinZ },
          { x: unionMaxX, y: deckY + 0.03, z: unionMaxZ },
          { x: unionMinX, y: deckY + 0.03, z: unionMaxZ },
        ]
      : [];

  return { deckY, areas, unionPolygon };
}

export interface GroupAimReachability {
  readonly groupId: string;
  readonly unreachableCount: number;
  readonly reasons: readonly string[];
}

/**
 * Evaluate static aim reachability per fixture group against active focus targets (`focusMarkId`).
 * Used by pre-flight so every fixture is checked regardless of whether Measure overlay is open.
 */
export function checkRigAimReachability(
  sourceRig: RigConfig,
  showState: Pick<ShowState, 'focusMarkId' | 'manualPan' | 'manualTilt' | 'movementMode' | 'movingGroups'>,
  stage?: NativeStage,
): Map<string, GroupAimReachability> {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const marks = focusMarks(rig);
  const placements = placeFixtures(rig);
  const byGroup = new Map<string, { unreachableCount: number; reasons: Set<string> }>();

  const ensure = (groupId: string) => {
    let rec = byGroup.get(groupId);
    if (!rec) {
      rec = { unreachableCount: 0, reasons: new Set<string>() };
      byGroup.set(groupId, rec);
    }
    return rec;
  };

  for (const unit of placements) {
    if (unit.group.type !== 'beam' && unit.group.type !== 'wash' && unit.group.type !== 'floor_beam') continue;
    const headType = unit.group.type === 'wash' ? 'wash' : 'beam';
    const look = headLook(showState as ShowState, headType);
    const target = focusPoint(marks, look.focusMarkId, look.manualPan, look.manualTilt);
    const spec = resolveModelSpec(unit.group.type, unit.group.catalogId);
    const pivotY = unit.group.catalogId ? spec.pivotY : HEAD_PIVOT;

    if (look.focusMarkId && !target) {
      const rec = ensure(unit.group.id);
      rec.unreachableCount++;
      rec.reasons.add(`Focus mark "${look.focusMarkId}" does not exist on this stage.`);
      continue;
    }

    if (target) {
      // Transform world target into fixture root local frame (inverse Y rotation by unit.yaw).
      const dx = target.x - unit.position.x;
      const dy = target.y - unit.position.y;
      const dz = target.z - unit.position.z;
      const cy = Math.cos(-unit.yaw);
      const sy = Math.sin(-unit.yaw);
      const local = {
        x: dx * cy + dz * sy,
        y: dy,
        z: -dx * sy + dz * cy,
      };
      const check = evaluateAimReachability(local, unit.floor, spec.motion, pivotY);
      if (!check.reachable) {
        const rec = ensure(unit.group.id);
        rec.unreachableCount++;
        if (check.clampedTilt) {
          rec.reasons.add(
            `Focus target exceeds ±${TILT_LIMIT_DEG}° tilt limit (${(Math.abs(check.unclampedTiltRad) * RAD_TO_DEG).toFixed(0)}° required).`,
          );
        } else if (check.offAxisFixed) {
          rec.reasons.add('Single-axis tilt batten cannot pan laterally onto focus target.');
        }
      }
    }
  }

  const out = new Map<string, GroupAimReachability>();
  for (const [groupId, rec] of byGroup) {
    out.set(groupId, { groupId, unreachableCount: rec.unreachableCount, reasons: Array.from(rec.reasons) });
  }
  return out;
}

/**
 * Pure static moving-head measurement evaluator (mirrors `StageEngine` forward kinematics).
 * Runs for EVERY moving head / PAR regardless of whether the 3D Measure overlay is active,
 * ensuring pre-flight always receives beam audience-clearance and pan/tilt limit warnings.
 */
export function evaluateStaticHeadMeasures(
  sourceRig: RigConfig,
  showState: Pick<
    ShowState,
    'focusMarkId' | 'manualPan' | 'manualTilt' | 'movementMode' | 'movingGroups' | 'beamZoom' | 'beamIntensity' | 'washIntensity' | 'masterDimmer' | 'blackout'
  >,
  stage?: NativeStage,
  surfaces?: SceneRaySurfaces,
): FixtureMeasurement[] {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const raySurfaces = surfaces ?? buildSceneRaySurfaces(sourceRig, stage);
  const marks = focusMarks(rig);
  const placements = placeFixtures(rig);
  const podNames = new Map<string, string>();
  for (const pod of rig.trussPods) podNames.set(pod.id, pod.name);

  const out: FixtureMeasurement[] = [];
  let movingHeadNumber = 0;

  for (const unit of placements) {
    if (unit.group.type !== 'beam' && unit.group.type !== 'wash' && unit.group.type !== 'floor_beam') continue;
    movingHeadNumber++;
    const headType: 'beam' | 'wash' = unit.group.type === 'wash' ? 'wash' : 'beam';
    const look = headLook(showState as ShowState, headType);
    const target = focusPoint(marks, look.focusMarkId, look.manualPan, look.manualTilt);
    const spec = resolveModelSpec(unit.group.type, unit.group.catalogId);
    const pivotY = unit.group.catalogId ? spec.pivotY : HEAD_PIVOT;
    const { optics, calibration, configuredLumens, hasAuthoredLumens } = resolveMovingFixtureOptics(unit.group);
    const lens = calibration ? movingZoomLens(spec) : undefined;
    const lensOffsetY = lens?.offsetY ?? spec.head.len / 2;
    const dir = unit.floor ? 1 : -1;

    let panRad = 0;
    let tiltRad = 0;
    if (target) {
      const dx = target.x - unit.position.x;
      const dy = target.y - unit.position.y;
      const dz = target.z - unit.position.z;
      const cy = Math.cos(-unit.yaw);
      const sy = Math.sin(-unit.yaw);
      const local = {
        x: dx * cy + dz * sy,
        y: dy,
        z: -dx * sy + dz * cy,
      };
      if (spec.motion === 'tilt') {
        panRad = 0;
        tiltRad = aimTiltOnly(local, unit.floor, pivotY);
      } else {
        ({ pan: panRad, tilt: tiltRad } = aimAngles(local, unit.floor, 0, 0, pivotY));
      }
    } else if (spec.motion === 'fixed') {
      if (look.movementMode === 'manual') {
        panRad = look.manualPan * 1.45 - unit.yaw;
        tiltRad = dir * look.manualTilt * 1.15;
      } else {
        panRad = 0;
        tiltRad = 0;
      }
    } else if (look.movementMode === 'manual') {
      panRad = spec.motion === 'tilt' ? 0 : look.manualPan * 1.45 - unit.yaw;
      tiltRad = dir * look.manualTilt * 1.15;
    } else if (look.movementMode === 'crowd_scan') {
      panRad = spec.motion === 'tilt' ? 0 : -unit.yaw;
      tiltRad = unit.floor ? 0.72 * 0.65 + 0.15 : -0.72;
    } else {
      // Static neutral aim for automated patterns (live runtime motion is continuously monitored at <=10 Hz).
      panRad = 0;
      tiltRad = 0;
    }

    panRad = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, panRad));
    tiltRad = Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, tiltRad));

    // Exact StageEngine forward kinematics: R_y(unit.yaw + pan) * R_x(tilt) * (0, dir, 0)
    const totalYaw = unit.yaw + panRad;
    const sinT = Math.sin(tiltRad);
    const cosT = Math.cos(tiltRad);
    const localY = dir * cosT;
    const localZ = dir * sinT;
    const dirVec: Vec3Tuple = {
      x: localZ * Math.sin(totalYaw),
      y: localY,
      z: localZ * Math.cos(totalYaw),
    };
    const pivotWorld: Vec3Tuple = {
      x: unit.position.x,
      y: unit.position.y + dir * pivotY,
      z: unit.position.z,
    };
    const lensOrigin: Vec3Tuple = {
      x: pivotWorld.x + dirVec.x * lensOffsetY,
      y: pivotWorld.y + dirVec.y * lensOffsetY,
      z: pivotWorld.z + dirVec.z * lensOffsetY,
    };

    const frustum = calibration && lens
      ? evaluateCalibratedZoom(calibration, optics, showState.beamZoom, createCalibratedFrustum(optics, lens.radius))
      : undefined;
    const zoomScale = frustum ? 1 : beamZoomScale(headType, showState.beamZoom);
    const baseInt = headType === 'wash' ? showState.washIntensity : showState.beamIntensity;
    const appliedDimmer = showState.blackout ? 0 : Math.max(0, Math.min(1, baseInt * showState.masterDimmer));

    const sample: EngineHeadSample = {
      unitId: `${unit.podId ?? 'floor'}:${unit.group.id}:${unit.index}`,
      fixtureNumber: movingHeadNumber,
      groupId: unit.group.id,
      podId: unit.podId ?? null,
      positionName: unit.podId ? podNames.get(unit.podId) ?? 'Truss' : 'Stage floor',
      label: `${unit.group.modelName} #${unit.index + 1}`,
      modelName: unit.group.modelName,
      type: headType,
      motion: spec.motion,
      isFloor: unit.floor,
      mountPosition: unit.position,
      lensOrigin,
      direction: dirVec,
      panRad,
      tiltRad,
      zoomScale,
      optics,
      configuredLumens,
      hasAuthoredLumens,
      frustum,
      appliedDimmer,
      emittedVisible: frustum ? appliedDimmer * frustum.gain > 0.001 : appliedDimmer > 0.01,
    };
    out.push(measureFixtureUnit(sample, rig, raySurfaces));
  }

  return out;
}

export interface MeasureSnapshot {
  readonly timestampMs: number;
  readonly bounds: VenueBounds;
  readonly units: readonly FixtureMeasurement[];
  /** Units with warnings, sorted worst-first (audience clearance -> limit proximity -> no hit). */
  readonly worstOffenders: readonly FixtureMeasurement[];
  readonly audienceBreachCount: number;
  readonly limitWarningCount: number;
  readonly noHitCount: number;
}

/** Build an immutable `MeasureSnapshot` from engine head samples. */
export function buildMeasureSnapshot(
  samples: readonly EngineHeadSample[],
  rig: RigConfig,
  surfaces: SceneRaySurfaces,
  timestampMs: number,
): MeasureSnapshot {
  const units: FixtureMeasurement[] = [];
  const worst: FixtureMeasurement[] = [];
  let audienceBreachCount = 0;
  let limitWarningCount = 0;
  let noHitCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const m = measureFixtureUnit(samples[i], rig, surfaces);
    units.push(m);
    if (m.entersAudienceBelowThreshold) audienceBreachCount++;
    if (m.nearPanLimit || m.nearTiltLimit) limitWarningCount++;
    if (m.hitKind === 'none') noHitCount++;
    if (m.warnings.length > 0) worst.push(m);
  }

  worst.sort((a, b) => {
    if (b.severityRank !== a.severityRank) return b.severityRank - a.severityRank;
    const aClr = a.minAudienceClearanceM ?? Infinity;
    const bClr = b.minAudienceClearanceM ?? Infinity;
    if (aClr !== bClr) return aClr - bClr;
    return a.fixtureNumber - b.fixtureNumber;
  });

  return {
    timestampMs,
    bounds: surfaces.bounds,
    units,
    worstOffenders: worst,
    audienceBreachCount,
    limitWarningCount,
    noHitCount,
  };
}

export { buildSceneRaySurfaces, castRayToScene, computeVenueBounds, intersectRayAudienceZone };
export type { AudienceZoneBox, RayHitKind, SceneRaySurfaces, Vec3Tuple, VenueBounds };
