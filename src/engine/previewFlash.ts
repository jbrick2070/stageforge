import * as THREE from 'three';
import { FLASH_REFRACTORY_MS, rawManualStrobeOscillator } from './audioModulation';

export { rawManualStrobeOscillator };
export const PREVIEW_STROBE_HOLD_MS = 140;
/** Max preview slew rate when inside the 334 ms refractory window (~606 ms full 0->1 ramp, strictly < 3 flashes/s). */
export const PREVIEW_SLEW_PER_SEC = 1.65;
export const PREVIEW_FLASH_LIMITED_HOLD_MS = 650;

/**
 * Shared raw laser shader blanking oscillator (4..30 Hz, matching `LASER_GLSL.blanked()`).
 * Uses a single global phase across projectors when preview-limited so N projectors cannot interleave above 3 Hz.
 */
export function rawLaserStrobeOscillator(laserStrobe: number, tSec: number): boolean {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(laserStrobe) ? laserStrobe : 0));
  if (clamped <= 0.02) return true;
  const phase = (tSec * (4.0 + clamped * 26.0)) % 1;
  const frac = phase < 0 ? phase + 1 : phase;
  return frac >= 0.45;
}

export interface PreviewFlashState {
  clockMs: number;
  lastGlobalEdgeMs: number;
  limitedUntilMs: number;
  // Laser unmapped strobe preview gate (single global phase across all projectors)
  laserArmed: boolean;
  laserGateOn: boolean;
  laserOnUntilMs: number;
  // Full-frame & look slew followers
  masterInitialized: boolean;
  masterValue: number;
  blinderInitialized: boolean;
  blinderValue: number;
  ledBrightInitialized: boolean;
  ledBrightValue: number;
  beatPulseInitialized: boolean;
  beatPulseValue: number;
  beamIntInitialized: boolean;
  beamIntValue: number;
  washIntInitialized: boolean;
  washIntValue: number;
  primaryInitialized: boolean;
  primaryR: number;
  primaryG: number;
  primaryB: number;
  accentInitialized: boolean;
  accentR: number;
  accentG: number;
  accentB: number;
}

export function createPreviewFlashState(): PreviewFlashState {
  return {
    clockMs: 0,
    lastGlobalEdgeMs: -Infinity,
    limitedUntilMs: -Infinity,
    laserArmed: true,
    laserGateOn: false,
    laserOnUntilMs: -Infinity,
    masterInitialized: false,
    masterValue: 0,
    blinderInitialized: false,
    blinderValue: 0,
    ledBrightInitialized: false,
    ledBrightValue: 0,
    beatPulseInitialized: false,
    beatPulseValue: 0,
    beamIntInitialized: false,
    beamIntValue: 0,
    washIntInitialized: false,
    washIntValue: 0,
    primaryInitialized: false,
    primaryR: 0,
    primaryG: 0,
    primaryB: 0,
    accentInitialized: false,
    accentR: 0,
    accentG: 0,
    accentB: 0,
  };
}

export interface PreviewFlashInput {
  dtSec: number;
  tSec: number;
  /** Read-only mirror of `audioModState.lastGlobalStrobeEdgeMs`; never written back. */
  audioGlobalEdgeMs: number;
  /** True when the preview flash limiter is active (default true; false only on explicit full-rate opt-in). */
  limited: boolean;
  blackout: boolean;
  master: number;
  blinder: number;
  ledBright: number;
  beatPulse: number;
  beamIntensity: number;
  washIntensity: number;
  laserStrobe: number;
  primaryColor: THREE.Color;
  accentColor: THREE.Color;
}

export interface PreviewFlashOutput {
  master: number;
  blinder: number;
  ledBright: number;
  beatPulse: number;
  beamIntensity: number;
  washIntensity: number;
  /** Preview multiplier for unmapped laser strobe (1 = lit, 0 = blanked). Shader uStrobe is set to 0 when limited. */
  laserStrobeMultiplier: number;
  /** True when shader `uStrobe` should be bypassed in favor of `laserStrobeMultiplier`. */
  bypassLaserShaderStrobe: boolean;
  /** True when `LED_WALL_FRAG` should slow/dampen high-contrast `strobe_bars` motion. */
  ledFlashLimited: boolean;
  /** True when the preview governor suppressed or slewed any rapid transition recently. */
  activeLimiting: boolean;
  primaryColor: THREE.Color;
  accentColor: THREE.Color;
}

export function createPreviewFlashOutput(): PreviewFlashOutput {
  return {
    master: 1,
    blinder: 0,
    ledBright: 0,
    beatPulse: 0,
    beamIntensity: 0,
    washIntensity: 0,
    laserStrobeMultiplier: 1,
    bypassLaserShaderStrobe: false,
    ledFlashLimited: false,
    activeLimiting: false,
    primaryColor: new THREE.Color(),
    accentColor: new THREE.Color(),
  };
}

function canAdmitPreviewEdge(state: PreviewFlashState): boolean {
  const tMs = state.clockMs;
  return (
    tMs === state.lastGlobalEdgeMs ||
    tMs - state.lastGlobalEdgeMs >= FLASH_REFRACTORY_MS
  );
}

function stepScalarPreview(
  state: PreviewFlashState,
  initialized: boolean,
  prev: number,
  target: number,
  dtSec: number,
  instantFall: boolean,
  edgeThreshold: number,
): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  if (!initialized) return safeTarget;
  const delta = safeTarget - prev;
  if (Math.abs(delta) <= 1e-6) return safeTarget;

  // Blackout / downward transitions are immediate when instantFall is set.
  if (delta < 0 && instantFall) return safeTarget;

  const maxStep = PREVIEW_SLEW_PER_SEC * Math.max(0, dtSec);
  if (Math.abs(delta) <= maxStep) return safeTarget;

  // Small changes below flash threshold follow immediately.
  if (Math.abs(delta) < edgeThreshold) return safeTarget;

  if (canAdmitPreviewEdge(state)) {
    state.lastGlobalEdgeMs = state.clockMs;
    return safeTarget;
  }

  state.limitedUntilMs = Math.max(state.limitedUntilMs, state.clockMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
  return prev + Math.sign(delta) * maxStep;
}

/**
 * Zero-allocation preview-only flash governor (Sprint 15).
 * Reads `audioGlobalEdgeMs` monotonically without ever mutating `AudioModulationState` or DMX buffers.
 */
export function evaluatePreviewFlash(
  state: PreviewFlashState,
  input: PreviewFlashInput,
  out: PreviewFlashOutput,
): PreviewFlashOutput {
  const safeDt = Number.isFinite(input.dtSec) && input.dtSec > 0 ? input.dtSec : 0;
  state.clockMs += safeDt * 1000;
  // Sync monotonically with any physical/audio strobe edge so preview-only flashes yield to fixture strobes.
  if (Number.isFinite(input.audioGlobalEdgeMs) && input.audioGlobalEdgeMs > state.lastGlobalEdgeMs) {
    state.lastGlobalEdgeMs = input.audioGlobalEdgeMs;
  }
  const tMs = state.clockMs;

  if (!input.limited) {
    // Full-rate visual preview opted in: pass visual values through untouched while tracking followers
    // so re-enabling the limiter never causes a jump or loses refractory history.
    state.masterInitialized = true;
    state.masterValue = input.master;
    state.blinderInitialized = true;
    state.blinderValue = input.blinder;
    state.ledBrightInitialized = true;
    state.ledBrightValue = input.ledBright;
    state.beatPulseInitialized = true;
    state.beatPulseValue = input.beatPulse;
    state.beamIntInitialized = true;
    state.beamIntValue = input.beamIntensity;
    state.washIntInitialized = true;
    state.washIntValue = input.washIntensity;
    state.primaryInitialized = true;
    state.primaryR = input.primaryColor.r;
    state.primaryG = input.primaryColor.g;
    state.primaryB = input.primaryColor.b;
    state.accentInitialized = true;
    state.accentR = input.accentColor.r;
    state.accentG = input.accentColor.g;
    state.accentB = input.accentColor.b;
    state.laserArmed = true;
    state.laserGateOn = false;
    state.laserOnUntilMs = -Infinity;

    out.master = input.master;
    out.blinder = input.blinder;
    out.ledBright = input.ledBright;
    out.beatPulse = input.beatPulse;
    out.beamIntensity = input.beamIntensity;
    out.washIntensity = input.washIntensity;
    out.laserStrobeMultiplier = 1;
    out.bypassLaserShaderStrobe = false;
    out.ledFlashLimited = false;
    out.activeLimiting = false;
    out.primaryColor.copy(input.primaryColor);
    out.accentColor.copy(input.accentColor);
    return out;
  }

  // 1. Master / blackout: blackout drops immediately; rapid restoration slews if inside refractory window.
  const nextMaster = input.blackout
    ? 0
    : stepScalarPreview(state, state.masterInitialized, state.masterValue, input.master, safeDt, true, 0.2);
  state.masterInitialized = true;
  state.masterValue = nextMaster;

  // 2. Blinder: immediate on blackout, otherwise slew-limited when mashing faster than 3 Hz.
  const nextBlinder = input.blackout
    ? 0
    : stepScalarPreview(state, state.blinderInitialized, state.blinderValue, input.blinder, safeDt, true, 0.2);
  state.blinderInitialized = true;
  state.blinderValue = nextBlinder;

  // 3. LED wall brightness: immediate on blackout, slew-limited on rapid restore/cue flips.
  const nextLedBright = input.blackout
    ? 0
    : stepScalarPreview(state, state.ledBrightInitialized, state.ledBrightValue, input.ledBright, safeDt, true, 0.2);
  state.ledBrightInitialized = true;
  state.ledBrightValue = nextLedBright;

  // 4. LED beat pulse: always smoothly slewed so high-BPM audio beats cannot flash LED wall > 3/s.
  const nextBeatPulse = input.blackout
    ? 0
    : stepScalarPreview(state, state.beatPulseInitialized, state.beatPulseValue, input.beatPulse, safeDt, false, 0.25);
  state.beatPulseInitialized = true;
  state.beatPulseValue = nextBeatPulse;

  // 5. Beam & wash base intensities (covers rapid cue flips).
  const nextBeamInt = input.blackout
    ? 0
    : stepScalarPreview(state, state.beamIntInitialized, state.beamIntValue, input.beamIntensity, safeDt, true, 0.25);
  state.beamIntInitialized = true;
  state.beamIntValue = nextBeamInt;

  const nextWashInt = input.blackout
    ? 0
    : stepScalarPreview(state, state.washIntInitialized, state.washIntValue, input.washIntensity, safeDt, true, 0.25);
  state.washIntInitialized = true;
  state.washIntValue = nextWashInt;

  // 6. Primary & accent color transitions (prevents rapid red<->cyan / saturated-red cue flip flashes).
  const stepColor = (
    initialized: boolean,
    pr: number,
    pg: number,
    pb: number,
    target: THREE.Color,
    dest: THREE.Color,
  ): [number, number, number] => {
    if (!initialized) {
      dest.copy(target);
      return [target.r, target.g, target.b];
    }
    const dr = target.r - pr;
    const dg = target.g - pg;
    const db = target.b - pb;
    const mag = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
    if (mag < 0.45) {
      dest.copy(target);
      return [target.r, target.g, target.b];
    }
    if (canAdmitPreviewEdge(state)) {
      state.lastGlobalEdgeMs = tMs;
      dest.copy(target);
      return [target.r, target.g, target.b];
    }
    state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
    const maxStep = PREVIEW_SLEW_PER_SEC * safeDt;
    const nr = pr + Math.sign(dr) * Math.min(Math.abs(dr), maxStep);
    const ng = pg + Math.sign(dg) * Math.min(Math.abs(dg), maxStep);
    const nb = pb + Math.sign(db) * Math.min(Math.abs(db), maxStep);
    dest.setRGB(nr, ng, nb);
    return [nr, ng, nb];
  };

  const [pR, pG, pB] = stepColor(
    state.primaryInitialized,
    state.primaryR,
    state.primaryG,
    state.primaryB,
    input.primaryColor,
    out.primaryColor,
  );
  state.primaryInitialized = true;
  state.primaryR = pR;
  state.primaryG = pG;
  state.primaryB = pB;

  const [aR, aG, aB] = stepColor(
    state.accentInitialized,
    state.accentR,
    state.accentG,
    state.accentB,
    input.accentColor,
    out.accentColor,
  );
  state.accentInitialized = true;
  state.accentR = aR;
  state.accentG = aG;
  state.accentB = aB;

  // 7. Unmapped laser shader strobe (single global phase admitted through the shared 334 ms refractory).
  let laserStrobeMultiplier = 1;
  if (input.laserStrobe > 0.02 && !input.blackout) {
    const rawLit = rawLaserStrobeOscillator(input.laserStrobe, input.tSec);
    if (state.laserGateOn) {
      if (tMs >= state.laserOnUntilMs && !rawLit) {
        state.laserGateOn = false;
      } else if (tMs >= state.laserOnUntilMs) {
        // End pulse after hold window so it cycles cleanly without sticking solid.
        state.laserGateOn = false;
        state.laserArmed = false;
      }
    }
    if (!rawLit) {
      state.laserArmed = true;
    } else if (state.laserArmed && !state.laserGateOn) {
      if (canAdmitPreviewEdge(state)) {
        state.lastGlobalEdgeMs = tMs;
        state.laserGateOn = true;
        state.laserOnUntilMs = tMs + PREVIEW_STROBE_HOLD_MS;
        state.laserArmed = false;
      } else {
        state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
      }
    }
    laserStrobeMultiplier = state.laserGateOn ? 1 : 0;
  } else {
    state.laserArmed = true;
    state.laserGateOn = false;
    state.laserOnUntilMs = -Infinity;
  }

  out.master = nextMaster;
  out.blinder = nextBlinder;
  out.ledBright = nextLedBright;
  out.beatPulse = nextBeatPulse;
  out.beamIntensity = nextBeamInt;
  out.washIntensity = nextWashInt;
  out.laserStrobeMultiplier = laserStrobeMultiplier;
  out.bypassLaserShaderStrobe = true;
  out.ledFlashLimited = true;
  out.activeLimiting = tMs < state.limitedUntilMs;
  return out;
}
