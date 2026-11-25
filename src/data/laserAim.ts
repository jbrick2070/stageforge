import type { LaserColorMode, LaserPattern, ShowState } from '../types/show';
import type { CatalogDmxMode, CatalogLaserSpec, LaserChannelRole } from './equipmentCatalog';
import { DEFAULT_LASER_COLORS } from './laserProjectors';

/**
 * Single source of truth for procedural laser beam geometry and pitch math.
 * Shared by StageEngine, GLSL shaders (`shaders.ts`), and IEC 60825 safety guidance (`laserSafety.ts`)
 * so visual projections and safety calculations can never disagree.
 */
export const LASER_BEAM_LENGTH_M = 38;
export const LASER_APERTURE_Z_M = 0.31;
export const LASER_SHEET_FAR_HALF_WIDTH_M = 11; // sheet width at reach=1 is 22 m -> half-width 11 m
export const LASER_CONE_FAR_RADIUS_M = 7.8;

// Shader formula constants (interpolated directly into shaders.ts):
export const LASER_SHEET_WIDTH_BASE = 0.35;
export const LASER_SHEET_WIDTH_SCALE = 1.5;
export const LASER_SHEET_HEIGHT_BASE = 0.10;
export const LASER_SHEET_HEIGHT_SCALE = 4.2;
export const LASER_STARBURST_Y_BASE = 2.3;
export const LASER_STARBURST_Y_SCALE = 6.8;
export const LASER_STARBURST_MAX_RADIUS = 0.96; // 0.60 + 0.36
export const LASER_CONE_SPREAD_BASE = 0.35;
export const LASER_CONE_SPREAD_SCALE = 1.3;
export const LASER_CONE_MAX_MORPH = 1.17; // 1.0 + 0.09 + 0.08

// Pitch constants (radians). Sign convention: positive rotation.x pitches the +Z beam DOWNWARD (-Y).
export const LASER_PITCH_FLOOR_BASE = -0.18;
export const LASER_PITCH_OVERHEAD_SAFE = -0.02;
export const LASER_PITCH_OVERHEAD_AUDIENCE = 0.14;
export const LASER_PITCH_USER_SCALE = 0.34;
export const LASER_PITCH_HORIZON_SWAY = 0.18;
export const LASER_SHEET_ROLL_SCALE = 0.55;
export const LASER_ILDA_ROLL_SCALE = 0.6;

/**
 * Shared ILDA scan tangent mapping for both `ildaRenderer.ts` (`ildaMeshScale`) and `laserSafety.ts`.
 * Maps normalized ILDA coordinates `n in [-1, 1]` to `tan(angle) = n * tan(halfAngle) * spread`
 * with `maxScanAngleDeg` clamped to `[5, 80]`.
 */
export function ildaScanTangents(
  maxScanAngleDeg: number | undefined,
  spreadX: number,
  spreadY: number,
): { tanHalfX: number; tanHalfY: number; scaleX: number; scaleY: number } {
  const angleDeg = Math.max(5, Math.min(80, Number.isFinite(maxScanAngleDeg) ? maxScanAngleDeg! : 45));
  const halfTan = Math.tan(((angleDeg * Math.PI) / 180) * 0.5);
  const baseHalfTan = Math.tan(Math.PI / 8); // 45 deg reference baked into BakedIldaClip
  const sx = Math.max(0.05, Math.min(1, Number.isFinite(spreadX) ? spreadX : 0.7));
  const sy = Math.max(0.05, Math.min(1, Number.isFinite(spreadY) ? spreadY : 0.7));
  return {
    tanHalfX: halfTan * sx,
    tanHalfY: halfTan * sy,
    scaleX: (halfTan / baseHalfTan) * sx,
    scaleY: (halfTan / baseHalfTan) * sy,
  };
}

export interface LaserPitchRange {
  /** Base + user pitch (without time-varying animation). */
  readonly nominalRad: number;
  /** Most upward pitch reached during animation (smallest rotation.x). */
  readonly minPitchRad: number;
  /** Most downward pitch reached during animation (largest rotation.x). */
  readonly maxPitchRad: number;
}

/**
 * Compute laser root `rotation.x` at time `t` (for live rendering) or worst-case envelope (when `t` is omitted).
 * Sign convention: positive `rotation.x` pitches a +Z projector beam downward (negative world Y).
 */
export function laserPitch(
  isFloor: boolean,
  laser: Pick<ShowState['laser'], 'audienceScan' | 'tilt' | 'pattern' | 'speed'>,
  t?: number,
  unitIndex = 0,
): number {
  const basePitch = isFloor
    ? LASER_PITCH_FLOOR_BASE
    : laser.audienceScan
      ? LASER_PITCH_OVERHEAD_AUDIENCE
      : LASER_PITCH_OVERHEAD_SAFE;
  const userPitch = -laser.tilt * LASER_PITCH_USER_SCALE;
  if (t === undefined || laser.pattern !== 'horizon') {
    return basePitch + userPitch;
  }
  const animPitch = Math.sin(t * (0.8 + laser.speed * 2.2) + unitIndex * 0.5) * LASER_PITCH_HORIZON_SWAY;
  return basePitch + userPitch + animPitch;
}

/**
 * Time-independent pitch envelope (worst-case upward and downward pitch across animation cycle).
 * Used by laserSafety.ts so warnings never flicker with animation phase.
 */
export function laserPitchEnvelope(
  isFloor: boolean,
  laser: Pick<ShowState['laser'], 'audienceScan' | 'tilt' | 'pattern'>,
): LaserPitchRange {
  const nominalRad = laserPitch(isFloor, { ...laser, speed: 0 });
  const sway = laser.pattern === 'horizon' ? LASER_PITCH_HORIZON_SWAY : 0;
  return {
    nominalRad,
    minPitchRad: nominalRad - sway,
    maxPitchRad: nominalRad + sway,
  };
}

export interface LaserFanHalfAngles {
  /** Half-angle horizontal spread (radians) at full throw. */
  readonly halfXRad: number;
  /** Half-angle vertical spread (radians) at full throw (worst-case peak across animation). */
  readonly halfYRad: number;
}

/**
 * Worst-case half-angles of the procedural laser projection matching `LASER_SHEET_VERT` & `LASER_CONE_VERT`,
 * accounting for sheet roll (`rotation`) and `matrix` 90° / continuous spin.
 */
export function laserFanHalfAngles(
  pattern: LaserPattern,
  spreadX: number,
  spreadY: number,
  rotation = 0,
  unitIndex = 0,
): LaserFanHalfAngles {
  const sx = Math.max(0, Math.min(1, Number.isFinite(spreadX) ? spreadX : 0));
  const sy = Math.max(0, Math.min(1, Number.isFinite(spreadY) ? spreadY : 0));
  const rot = Math.max(0, Math.min(1, Number.isFinite(rotation) ? rotation : 0));

  if (pattern === 'tunnel' || pattern === 'dual_cones') {
    const farX = LASER_CONE_FAR_RADIUS_M * (LASER_CONE_SPREAD_BASE + sx * LASER_CONE_SPREAD_SCALE) * LASER_CONE_MAX_MORPH;
    const farY = LASER_CONE_FAR_RADIUS_M * (LASER_CONE_SPREAD_BASE + sy * LASER_CONE_SPREAD_SCALE) * LASER_CONE_MAX_MORPH;
    return {
      halfXRad: Math.atan2(farX, LASER_BEAM_LENGTH_M),
      halfYRad: Math.atan2(farY, LASER_BEAM_LENGTH_M),
    };
  }

  const width = LASER_SHEET_WIDTH_BASE + sx * LASER_SHEET_WIDTH_SCALE;
  const height = LASER_SHEET_HEIGHT_BASE + sy * LASER_SHEET_HEIGHT_SCALE;

  let farX: number;
  let farY: number;

  if (pattern === 'starburst') {
    farX = width * (0.07 + LASER_SHEET_FAR_HALF_WIDTH_M) * LASER_STARBURST_MAX_RADIUS;
    farY = (0.05 + LASER_STARBURST_Y_BASE + sy * LASER_STARBURST_Y_SCALE) * LASER_STARBURST_MAX_RADIUS;
  } else {
    // Peak vertical amplitude factor per sheet pattern in LASER_SHEET_VERT:
    let yFactor = 0.15; // horizon
    if (pattern === 'liquid_sky') yFactor = 0.82; // 0.64 + 0.18
    else if (pattern === 'fan') yFactor = 0.28;
    else if (pattern === 'wave') yFactor = 1.18; // 1.0 + 0.18 audioPulse
    else if (pattern === 'matrix') yFactor = 0.32;

    farX = LASER_SHEET_FAR_HALF_WIDTH_M * width;
    farY = height * yFactor;
  }

  // Account for sheetMesh.rotation.z roll in StageEngine:
  // - matrix: rotates continuously 0..2π when rot > 0, and odd units sit at π/2 even when rot === 0.
  // - other sheet patterns: oscillate ±rot * LASER_SHEET_ROLL_SCALE rad.
  let rolledFarX = farX;
  let rolledFarY = farY;
  if (pattern === 'matrix') {
    if (rot > 0) {
      const maxR = Math.hypot(farX, farY);
      rolledFarX = maxR;
      rolledFarY = maxR;
    } else if (unitIndex % 2 === 1) {
      rolledFarX = farY;
      rolledFarY = farX;
    }
  } else if (rot > 0) {
    const maxRoll = Math.min(Math.PI / 2, rot * LASER_SHEET_ROLL_SCALE);
    const sinR = Math.sin(maxRoll);
    const cosR = Math.cos(maxRoll);
    // Worst-case vertical extent of corner (farX, farY) rotated by angle in [-maxRoll, +maxRoll]:
    // maximizes farX*sin(a) + farY*cos(a) over a in [0, maxRoll].
    const peakAngle = Math.atan2(farX, Math.max(1e-6, farY));
    rolledFarY = peakAngle <= maxRoll ? Math.hypot(farX, farY) : farX * sinR + farY * cosR;
    const peakAngleX = Math.atan2(farY, Math.max(1e-6, farX));
    rolledFarX = peakAngleX <= maxRoll ? Math.hypot(farX, farY) : farX * cosR + farY * sinR;
  }

  return {
    halfXRad: Math.atan2(rolledFarX, LASER_BEAM_LENGTH_M),
    halfYRad: Math.atan2(rolledFarY, LASER_BEAM_LENGTH_M),
  };
}

/**
 * Visual presence multiplier from optical power (W), gently bounded to [0.6, 1.25].
 * Legacy / unknown lasers return 1.0 so existing scenes stay visually identical.
 */
export function laserPowerPresence(spec?: Pick<CatalogLaserSpec, 'opticalPowerW'>): number {
  if (!spec || !Number.isFinite(spec.opticalPowerW) || spec.opticalPowerW <= 0) return 1.0;
  const raw = 0.55 + 0.15 * Math.log2(spec.opticalPowerW);
  return Math.max(0.6, Math.min(1.25, raw));
}

export interface ResolvedLaserColor {
  /** Shader uColorMode value: 0 = solid, 1 = dual, 2 = rainbow. */
  readonly shaderMode: 0 | 1 | 2;
  /** Hex color A (e.g. '#00ff3c'). */
  readonly colorA: string;
  /** Hex color B. */
  readonly colorB: string;
  /** True when the projector forced monochrome output due to a single-color diode spec. */
  readonly forcedSingleColor: boolean;
}

/**
 * Pure laser color resolution honoring single-color diode hardware constraints.
 * Applied in StageEngine (and UI) so presets/cues cannot force RGB onto a monochrome green laser.
 */
export function resolveLaserColor(
  spec: Pick<CatalogLaserSpec, 'colorType' | 'singleColorHex'> | undefined,
  mode: LaserColorMode,
  primaryHex: string,
  accentHex: string,
  customA?: string,
  customB?: string,
): ResolvedLaserColor {
  if (spec?.colorType === 'single') {
    const mono = spec.singleColorHex ?? '#00ff3c';
    return { shaderMode: 0, colorA: mono, colorB: mono, forcedSingleColor: true };
  }

  switch (mode) {
    case 'custom': {
      const a = customA ?? DEFAULT_LASER_COLORS[0];
      return { shaderMode: 0, colorA: a, colorB: a, forcedSingleColor: false };
    }
    case 'custom_dual': {
      return {
        shaderMode: 1,
        colorA: customA ?? DEFAULT_LASER_COLORS[0],
        colorB: customB ?? DEFAULT_LASER_COLORS[1],
        forcedSingleColor: false,
      };
    }
    case 'primary':
      return { shaderMode: 0, colorA: primaryHex, colorB: primaryHex, forcedSingleColor: false };
    case 'dual':
      return { shaderMode: 1, colorA: primaryHex, colorB: accentHex, forcedSingleColor: false };
    case 'rainbow':
      return { shaderMode: 2, colorA: primaryHex, colorB: accentHex, forcedSingleColor: false };
    case 'cyan_magenta':
      return { shaderMode: 1, colorA: '#00f0ff', colorB: '#ff00aa', forcedSingleColor: false };
    case 'emerald_gold':
      return { shaderMode: 1, colorA: '#00ff66', colorB: '#ffcc00', forcedSingleColor: false };
    case 'crimson_ice':
      return { shaderMode: 1, colorA: '#ff0044', colorB: '#55d8ff', forcedSingleColor: false };
  }
}

export interface LaserDmxValues {
  enabled: boolean;
  intensity: number; // 0..1.5
  patternIndex: number; // 0..7
  spreadX: number; // 0..1
  spreadY: number; // 0..1
  speed: number; // 0..1
  rotation: number; // 0..1
  tilt: number; // -1..1
  beamCount: number; // 1..32
  strobe: number; // 0..1
  colorR: number; // 0..1
  colorG: number; // 0..1
  colorB: number; // 0..1
  colorModeIndex: 0 | 1 | 2;
  scanRateNorm?: number; // 0..1
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function roleByte(role: LaserChannelRole, v: LaserDmxValues): number {
  const intByte = clampByte(Math.min(1, v.intensity) * 255);
  switch (role) {
    case 'unused':
      return 0;
    case 'fb4Access16':
      // Pangolin FB4 16-Ch (FB3 profile): 0..31 = blackout, 235..255 = 16-ch active.
      return v.enabled && v.intensity > 0.01 ? 255 : 0;
    case 'fb4Mode39':
      // Pangolin FB4 39-Ch: 0..239 = blackout/safe, 251 = live Playback Mode.
      return v.enabled && v.intensity > 0.01 ? 251 : 0;
    case 'intensity':
      return intByte;
    case 'pattern':
      return clampByte(v.patternIndex * 32);
    case 'sizeX':
      return clampByte(v.spreadX * 255);
    case 'sizeY':
      return clampByte(v.spreadY * 255);
    case 'zoom':
      return clampByte(Math.max(v.spreadX, v.spreadY) * 255);
    case 'speed':
      return clampByte(v.speed * 255);
    case 'rotation':
      return clampByte(v.rotation * 255);
    case 'posX':
      return 128;
    case 'posY':
      return clampByte((v.tilt * 0.5 + 0.5) * 255);
    case 'beamCount':
      return clampByte((v.beamCount / 32) * 255);
    case 'strobe':
      return clampByte(v.strobe * 255);
    case 'red':
      return clampByte(v.colorR * 255);
    case 'green':
      return clampByte(v.colorG * 255);
    case 'blue':
      return clampByte(v.colorB * 255);
    case 'colorScroll':
      return v.colorModeIndex === 2 ? 160 : 0;
    case 'scanRate':
      return clampByte((v.scanRateNorm ?? 0) * 255);
  }
}

/**
 * Encode DMX channels for a laser projector according to its selected mode's role layout.
 * - Verified role-mapped modes (`mode.layout`) write their real channel roles.
 * - Uncatalogued legacy lasers (`mode === undefined`) and `mode.legacy` placeholder modes
 *   keep StageForge's original 8-channel simulator byte order (byte-identical to Round 2).
 * - Real catalogue laser modes without a verified channel map output safe blackout zeros
 *   so unverified channel layouts never accidentally activate a physical Class 3B/4 laser.
 */
export function encodeLaserDmxChannels(
  mode: Pick<CatalogDmxMode, 'layout' | 'legacy' | 'channels'> | undefined,
  v: LaserDmxValues,
  out?: number[],
): number[] {
  const layout = mode?.layout;
  if (!mode || mode.legacy) {
    const legacy = out ?? [];
    legacy.length = 8;
    legacy[0] = clampByte(Math.min(1, v.intensity) * 255);
    legacy[1] = clampByte(v.patternIndex * 32);
    legacy[2] = clampByte(v.spreadX * 255);
    legacy[3] = clampByte(v.spreadY * 255);
    legacy[4] = clampByte(v.speed * 255);
    legacy[5] = clampByte(v.rotation * 255);
    legacy[6] = clampByte((v.beamCount / 32) * 255);
    legacy[7] = clampByte(v.strobe * 255);
    return legacy;
  }

  if (!layout || layout.length === 0) {
    const safeZeros = out ?? [];
    safeZeros.length = Math.max(0, Math.min(512, mode.channels));
    safeZeros.fill(0);
    return safeZeros;
  }

  const bytes = out ?? [];
  bytes.length = layout.length;
  // Disabled or blacked-out laser must emit neutral zeros across its entire footprint (never posX=128).
  if (!v.enabled || v.intensity <= 0.01) {
    bytes.fill(0);
    return bytes;
  }
  for (let i = 0; i < layout.length; i++) {
    bytes[i] = roleByte(layout[i], v);
  }
  return bytes;
}

