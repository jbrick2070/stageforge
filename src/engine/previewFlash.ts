import * as THREE from 'three';
import { FLASH_REFRACTORY_MS, rawManualStrobeOscillator } from './audioModulation';

export { rawManualStrobeOscillator };
export const PREVIEW_REFRACTORY_MS = 380;
export const PREVIEW_STROBE_HOLD_MS = 140;
/** Minimum scalar delta considered a flash edge (strictly below WCAG 0.10 luminance step). */
export const PREVIEW_EDGE_THRESHOLD = 0.06;
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
  // Unified preview-only delivered gates so strobe bars, beams, washes, lasers, and blinders share ONE refractory clock
  deliveredBeamBright: boolean;
  deliveredWashBright: boolean;
  deliveredBarBright: boolean;
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
    deliveredBeamBright: true,
    deliveredWashBright: true,
    deliveredBarBright: false,
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
  /** True when the preview governor suppressed or held any rapid transition recently. */
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
    tMs - state.lastGlobalEdgeMs >= Math.max(FLASH_REFRACTORY_MS, PREVIEW_REFRACTORY_MS)
  );
}

/**
 * Unified preview-only strobe gate arbiter for beams, washes, and strobe bars.
 * Ensures preview strobe gates share the exact same refractory clock as laser blanking,
 * blinders, blackout recovery, and rapid cue flips so two sources can never interleave above 3/s.
 * Never touches `AudioModulationState` or DMX buffers.
 */
export function stepPreviewDeliveredGate(
  state: PreviewFlashState,
  channel: 'beam' | 'wash' | 'bar',
  desiredGate: number,
  blackout: boolean,
  limited: boolean,
): number {
  const desiredBright = desiredGate >= 0.5;
  if (!limited) {
    if (channel === 'beam') state.deliveredBeamBright = desiredBright;
    else if (channel === 'wash') state.deliveredWashBright = desiredBright;
    else state.deliveredBarBright = desiredBright;
    return desiredGate;
  }
  if (blackout) {
    return desiredGate;
  }
  const prevBright =
    channel === 'beam'
      ? state.deliveredBeamBright
      : channel === 'wash'
        ? state.deliveredWashBright
        : state.deliveredBarBright;

  let delivered = desiredGate;
  if (!prevBright && desiredBright) {
    if (canAdmitPreviewEdge(state)) {
      state.lastGlobalEdgeMs = state.clockMs;
    } else {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, state.clockMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
      delivered = 0.06;
    }
  }
  const nextBright = delivered >= 0.5;
  if (channel === 'beam') state.deliveredBeamBright = nextBright;
  else if (channel === 'wash') state.deliveredWashBright = nextBright;
  else state.deliveredBarBright = nextBright;
  return delivered;
}

function stepScalarPreview(
  state: PreviewFlashState,
  initialized: boolean,
  prev: number,
  target: number,
  instantFall: boolean,
  edgeThreshold: number,
): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  if (!initialized) return safeTarget;
  const delta = safeTarget - prev;
  if (Math.abs(delta) <= 1e-6) return safeTarget;

  // Blackout / downward transitions are immediate when instantFall is set.
  if (delta < 0 && instantFall) return safeTarget;

  // Tiny frame-to-frame changes below flash threshold follow smoothly (e.g., slow fades).
  if (Math.abs(delta) < edgeThreshold) return safeTarget;

  if (canAdmitPreviewEdge(state)) {
    state.lastGlobalEdgeMs = state.clockMs;
    return safeTarget;
  }

  // Hold the last delivered value inside the refractory window so rapid on/off cycling
  // cannot leak a high-frequency sawtooth above the WCAG 0.10 luminance step.
  state.limitedUntilMs = Math.max(state.limitedUntilMs, state.clockMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
  return prev;
}

/**
 * Zero-allocation preview-only flash governor (Sprint 15).
 * Operates exclusively on preview state and never mutates `AudioModulationState` or DMX buffers.
 */
export function evaluatePreviewFlash(
  state: PreviewFlashState,
  input: PreviewFlashInput,
  out: PreviewFlashOutput,
): PreviewFlashOutput {
  const safeDt = Number.isFinite(input.dtSec) && input.dtSec > 0 ? input.dtSec : 0;
  state.clockMs += safeDt * 1000;
  // Preview emitters (beams, washes, strobe bars, lasers, blinders, cues) share state.lastGlobalEdgeMs
  // exclusively via evaluatePreviewFlash & stepPreviewDeliveredGate so no two sources can interleave above 3/s.
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

  // 1. Master / blackout: blackout drops immediately; rapid restoration holds until refractory expires.
  const nextMaster = input.blackout
    ? 0
    : stepScalarPreview(state, state.masterInitialized, state.masterValue, input.master, true, PREVIEW_EDGE_THRESHOLD);
  state.masterInitialized = true;
  state.masterValue = nextMaster;

  // 2. Blinder: immediate fall; rapid taps hold until refractory expires.
  const nextBlinder = input.blackout
    ? 0
    : stepScalarPreview(state, state.blinderInitialized, state.blinderValue, input.blinder, true, PREVIEW_EDGE_THRESHOLD);
  state.blinderInitialized = true;
  state.blinderValue = nextBlinder;

  // 3. LED wall brightness: immediate on blackout; rapid restore/cue flips hold until refractory expires.
  const nextLedBright = input.blackout
    ? 0
    : stepScalarPreview(state, state.ledBrightInitialized, state.ledBrightValue, input.ledBright, true, PREVIEW_EDGE_THRESHOLD);
  state.ledBrightInitialized = true;
  state.ledBrightValue = nextLedBright;

  // 4. LED beat pulse: both rises and falls gated by the refractory window so high-BPM audio beats cannot flash LED wall > 3/s.
  const nextBeatPulse = input.blackout
    ? 0
    : stepScalarPreview(state, state.beatPulseInitialized, state.beatPulseValue, input.beatPulse, false, PREVIEW_EDGE_THRESHOLD);
  state.beatPulseInitialized = true;
  state.beatPulseValue = nextBeatPulse;

  // 5. Beam & wash base intensities (covers rapid cue flips and ducking dimmer toggles).
  const nextBeamInt = input.blackout
    ? 0
    : stepScalarPreview(state, state.beamIntInitialized, state.beamIntValue, input.beamIntensity, true, PREVIEW_EDGE_THRESHOLD);
  state.beamIntInitialized = true;
  state.beamIntValue = nextBeamInt;

  const nextWashInt = input.blackout
    ? 0
    : stepScalarPreview(state, state.washIntInitialized, state.washIntValue, input.washIntensity, true, PREVIEW_EDGE_THRESHOLD);
  state.washIntInitialized = true;
  state.washIntValue = nextWashInt;

  // 6. Primary & accent color transitions (inlined, zero-allocation): hold the last admitted color
  // during the refractory window so rapid red<->cyan cue flips cannot oscillate WCAG saturated red > 3/s.
  if (!state.primaryInitialized) {
    state.primaryInitialized = true;
    state.primaryR = input.primaryColor.r;
    state.primaryG = input.primaryColor.g;
    state.primaryB = input.primaryColor.b;
    out.primaryColor.copy(input.primaryColor);
  } else {
    const pMag =
      Math.abs(input.primaryColor.r - state.primaryR) +
      Math.abs(input.primaryColor.g - state.primaryG) +
      Math.abs(input.primaryColor.b - state.primaryB);
    if (pMag < 0.15) {
      state.primaryR = input.primaryColor.r;
      state.primaryG = input.primaryColor.g;
      state.primaryB = input.primaryColor.b;
      out.primaryColor.copy(input.primaryColor);
    } else if (canAdmitPreviewEdge(state)) {
      state.lastGlobalEdgeMs = tMs;
      state.primaryR = input.primaryColor.r;
      state.primaryG = input.primaryColor.g;
      state.primaryB = input.primaryColor.b;
      out.primaryColor.copy(input.primaryColor);
    } else {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
      out.primaryColor.setRGB(state.primaryR, state.primaryG, state.primaryB);
    }
  }

  if (!state.accentInitialized) {
    state.accentInitialized = true;
    state.accentR = input.accentColor.r;
    state.accentG = input.accentColor.g;
    state.accentB = input.accentColor.b;
    out.accentColor.copy(input.accentColor);
  } else {
    const aMag =
      Math.abs(input.accentColor.r - state.accentR) +
      Math.abs(input.accentColor.g - state.accentG) +
      Math.abs(input.accentColor.b - state.accentB);
    if (aMag < 0.15) {
      state.accentR = input.accentColor.r;
      state.accentG = input.accentColor.g;
      state.accentB = input.accentColor.b;
      out.accentColor.copy(input.accentColor);
    } else if (canAdmitPreviewEdge(state)) {
      state.lastGlobalEdgeMs = tMs;
      state.accentR = input.accentColor.r;
      state.accentG = input.accentColor.g;
      state.accentB = input.accentColor.b;
      out.accentColor.copy(input.accentColor);
    } else {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
      out.accentColor.setRGB(state.accentR, state.accentG, state.accentB);
    }
  }

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
