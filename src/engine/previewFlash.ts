import * as THREE from 'three';
import { FLASH_REFRACTORY_MS, rawManualStrobeOscillator } from './audioModulation';
import {
  canAdmitFlashRise,
  createFlashBudgetClock,
  createRgbGovernorState,
  createScalarGovernorState,
  recordFlashFall,
  recordFlashRise,
  stepGovernedRgb,
  stepGovernedScalar,
  type FlashBudgetClock,
  type RgbGovernorState,
  type RgbStepResult,
  type ScalarGovernorState,
} from './flashGovernor';

export { rawManualStrobeOscillator };
export const PREVIEW_REFRACTORY_MS = 380;
export const PREVIEW_STROBE_HOLD_MS = 140;
/** Minimum scalar excursion considered a flash edge (strictly below WCAG 0.10 luminance step). */
export const PREVIEW_EDGE_THRESHOLD = 0.02;
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

export interface PreviewLaserGovernorEntry {
  intensityGov: ScalarGovernorState;
  colorAGov: RgbGovernorState;
  colorBGov: RgbGovernorState;
}

export interface PreviewFlashState {
  clockMs: number;
  lastGlobalEdgeMs: number;
  limitedUntilMs: number;
  budgetClock: FlashBudgetClock;
  // Unified preview-only delivered gates so strobe bars, beams, washes, lasers, and blinders share ONE refractory + 1 s reversal ring
  deliveredBeamBright: boolean;
  deliveredWashBright: boolean;
  deliveredBarBright: boolean;
  // Laser unmapped strobe preview gate (single global phase across all projectors)
  laserArmed: boolean;
  laserGateOn: boolean;
  laserOnUntilMs: number;
  // Ramp-safe excursion + rolling reversal scalar governors
  masterGov: ScalarGovernorState;
  blinderGov: ScalarGovernorState;
  ledBrightGov: ScalarGovernorState;
  beatPulseGov: ScalarGovernorState;
  bassGov: ScalarGovernorState;
  midGov: ScalarGovernorState;
  highGov: ScalarGovernorState;
  beamIntGov: ScalarGovernorState;
  washIntGov: ScalarGovernorState;
  beamColorMixGov: ScalarGovernorState;
  washColorMixGov: ScalarGovernorState;
  prismGov: ScalarGovernorState;
  // Ramp-safe RGB governors (global + movingGroups overrides)
  primaryGov: RgbGovernorState;
  accentGov: RgbGovernorState;
  beamPrimaryGov: RgbGovernorState;
  beamAccentGov: RgbGovernorState;
  washPrimaryGov: RgbGovernorState;
  washAccentGov: RgbGovernorState;
  // Per-fixture & per-laser-projector final preview emission governors (Codex review-06 R4 & R5)
  unitRgbGovernors: Map<string, RgbGovernorState>;
  laserProjectorGovernors: Map<string, PreviewLaserGovernorEntry>;
}

export function createPreviewFlashState(): PreviewFlashState {
  const spacing = Math.max(FLASH_REFRACTORY_MS, PREVIEW_REFRACTORY_MS);
  return {
    clockMs: 0,
    lastGlobalEdgeMs: -Infinity,
    limitedUntilMs: -Infinity,
    budgetClock: createFlashBudgetClock(spacing, PREVIEW_FLASH_LIMITED_HOLD_MS),
    deliveredBeamBright: true,
    deliveredWashBright: true,
    deliveredBarBright: false,
    laserArmed: true,
    laserGateOn: false,
    laserOnUntilMs: -Infinity,
    masterGov: createScalarGovernorState(),
    blinderGov: createScalarGovernorState(),
    ledBrightGov: createScalarGovernorState(),
    beatPulseGov: createScalarGovernorState(),
    bassGov: createScalarGovernorState(),
    midGov: createScalarGovernorState(),
    highGov: createScalarGovernorState(),
    beamIntGov: createScalarGovernorState(),
    washIntGov: createScalarGovernorState(),
    beamColorMixGov: createScalarGovernorState(),
    washColorMixGov: createScalarGovernorState(),
    prismGov: createScalarGovernorState(),
    primaryGov: createRgbGovernorState(),
    accentGov: createRgbGovernorState(),
    beamPrimaryGov: createRgbGovernorState(),
    beamAccentGov: createRgbGovernorState(),
    washPrimaryGov: createRgbGovernorState(),
    washAccentGov: createRgbGovernorState(),
    unitRgbGovernors: new Map(),
    laserProjectorGovernors: new Map(),
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
  blinderVisible?: boolean;
  ledBright: number;
  beatPulse: number;
  bass?: number;
  mid?: number;
  high?: number;
  beamIntensity: number;
  washIntensity: number;
  beamColorMix?: number;
  washColorMix?: number;
  goboPrism?: boolean | number;
  laserStrobe: number;
  primaryColor: THREE.Color;
  accentColor: THREE.Color;
  beamPrimaryColor?: THREE.Color;
  beamAccentColor?: THREE.Color;
  washPrimaryColor?: THREE.Color;
  washAccentColor?: THREE.Color;
}

export interface PreviewFlashOutput {
  master: number;
  blinder: number;
  ledBright: number;
  beatPulse: number;
  bass: number;
  mid: number;
  high: number;
  beamIntensity: number;
  washIntensity: number;
  beamColorMix: number;
  washColorMix: number;
  /** Preview-governed prism mix in [0, 1] so rapid goboPrism toggling stays <= 3 reversals/s. */
  prismMix: number;
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
  beamPrimaryColor: THREE.Color;
  beamAccentColor: THREE.Color;
  washPrimaryColor: THREE.Color;
  washAccentColor: THREE.Color;
}

export function createPreviewFlashOutput(): PreviewFlashOutput {
  return {
    master: 1,
    blinder: 0,
    ledBright: 0,
    beatPulse: 0,
    bass: 0,
    mid: 0,
    high: 0,
    beamIntensity: 0,
    washIntensity: 0,
    beamColorMix: 0,
    washColorMix: 0,
    prismMix: 0,
    laserStrobeMultiplier: 1,
    bypassLaserShaderStrobe: false,
    ledFlashLimited: false,
    activeLimiting: false,
    primaryColor: new THREE.Color(),
    accentColor: new THREE.Color(),
    beamPrimaryColor: new THREE.Color(),
    beamAccentColor: new THREE.Color(),
    washPrimaryColor: new THREE.Color(),
    washAccentColor: new THREE.Color(),
  };
}

function syncPreviewClockEdges(state: PreviewFlashState): void {
  if (state.budgetClock.lastAdmittedRiseMs > state.lastGlobalEdgeMs) {
    state.lastGlobalEdgeMs = state.budgetClock.lastAdmittedRiseMs;
  } else if (state.lastGlobalEdgeMs > state.budgetClock.lastAdmittedRiseMs) {
    state.budgetClock.lastAdmittedRiseMs = state.lastGlobalEdgeMs;
  }
}

function canAdmitPreviewEdge(state: PreviewFlashState): boolean {
  syncPreviewClockEdges(state);
  return canAdmitFlashRise(state.budgetClock, state.clockMs);
}

/**
 * Unified preview-only strobe gate arbiter for beams, washes, and strobe bars.
 * Shares the exact same spacing + rolling 1,000 ms reversal ring as laser blanking,
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
    const prevWasBright =
      channel === 'beam'
        ? state.deliveredBeamBright
        : channel === 'wash'
          ? state.deliveredWashBright
            : state.deliveredBarBright;
    if (prevWasBright) {
      recordFlashFall(state.budgetClock, state.clockMs);
    }
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
      recordFlashRise(state.budgetClock, state.clockMs);
      state.lastGlobalEdgeMs = state.clockMs;
    } else {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, state.clockMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
      delivered = 0.06;
    }
  } else if (prevBright && !desiredBright) {
    recordFlashFall(state.budgetClock, state.clockMs);
  }
  const nextBright = delivered >= 0.5;
  if (channel === 'beam') state.deliveredBeamBright = nextBright;
  else if (channel === 'wash') state.deliveredWashBright = nextBright;
  else state.deliveredBarBright = nextBright;
  return delivered;
}

const RGB_OUT_SCRATCH: RgbStepResult = { r: 0, g: 0, b: 0, limited: false };

function syncScalarPassthrough(gov: ScalarGovernorState, v: number): void {
  const sv = Number.isFinite(v) ? Math.max(0, v) : 0;
  gov.initialized = true;
  gov.delivered = sv;
  gov.anchor = sv;
  gov.peak = sv;
  gov.edgeStep = sv;
}

function syncRgbPassthrough(gov: RgbGovernorState, c: THREE.Color): void {
  const r = Math.max(0, c.r);
  const g = Math.max(0, c.g);
  const b = Math.max(0, c.b);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sum = r + g + b;
  const redRatio = sum > 1e-6 ? r / sum : 0;
  const redMetric = Math.max(0, (r - g - b) * 320);
  gov.initialized = true;
  gov.r = r;
  gov.g = g;
  gov.b = b;
  gov.genAnchorR = r;
  gov.genAnchorG = g;
  gov.genAnchorB = b;
  gov.genAnchorY = y;
  gov.peakR = r;
  gov.peakG = g;
  gov.peakB = b;
  gov.stepR = r;
  gov.stepG = g;
  gov.stepB = b;
  gov.redAnchorRatio = redRatio;
  gov.redAnchorMetric = redMetric;
  gov.peakRedMetric = redMetric;
  gov.stepRedMetric = redMetric;
}

export function getOrCreatePreviewFixtureGov(
  state: PreviewFlashState,
  unitKey: string,
): RgbGovernorState {
  let gov = state.unitRgbGovernors.get(unitKey);
  if (!gov) {
    if (state.unitRgbGovernors.size > 512) state.unitRgbGovernors.clear();
    gov = createRgbGovernorState();
    state.unitRgbGovernors.set(unitKey, gov);
  }
  return gov;
}

export function getOrCreatePreviewLaserGov(
  state: PreviewFlashState,
  projectorKey: string,
): PreviewLaserGovernorEntry {
  let entry = state.laserProjectorGovernors.get(projectorKey);
  if (!entry) {
    if (state.laserProjectorGovernors.size > 128) state.laserProjectorGovernors.clear();
    entry = {
      intensityGov: createScalarGovernorState(),
      colorAGov: createRgbGovernorState(),
      colorBGov: createRgbGovernorState(),
    };
    state.laserProjectorGovernors.set(projectorKey, entry);
  }
  return entry;
}

/**
 * Per-fixture final preview RGB/intensity clamp (Codex review-06 R4).
 * Catches per-fixture `colorSplitMode` flips (`solid` <-> `alternate` / `rainbow`) and demo fades
 * without coupling slow per-fixture rainbow hue phases onto the global clock.
 */
export function stepPreviewFixtureUnit(
  state: PreviewFlashState,
  unitKeyOrGov: string | RgbGovernorState,
  limited: boolean,
  blackout: boolean,
  rawIntensity: number,
  rawColor: THREE.Color,
  outColor: THREE.Color,
): number {
  const safeInt = Number.isFinite(rawIntensity) && rawIntensity > 0 ? rawIntensity : 0;
  const gov =
    typeof unitKeyOrGov === 'string'
      ? getOrCreatePreviewFixtureGov(state, unitKeyOrGov)
      : unitKeyOrGov;
  if (!limited) {
    gov.initialized = true;
    gov.r = rawColor.r * safeInt;
    gov.g = rawColor.g * safeInt;
    gov.b = rawColor.b * safeInt;
    outColor.copy(rawColor);
    return safeInt;
  }
  const er = rawColor.r * safeInt;
  const eg = rawColor.g * safeInt;
  const eb = rawColor.b * safeInt;
  const res = stepGovernedRgb(
    gov,
    null,
    state.clockMs,
    er,
    eg,
    eb,
    blackout,
    PREVIEW_EDGE_THRESHOLD,
    undefined,
    undefined,
    PREVIEW_REFRACTORY_MS,
    RGB_OUT_SCRATCH,
  );
  if (res.limited) {
    state.limitedUntilMs = Math.max(state.limitedUntilMs, state.clockMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
  }
  const maxComp = Math.max(res.r, res.g, res.b);
  if (maxComp <= 1e-6) {
    outColor.setRGB(0, 0, 0);
    return 0;
  }
  const rawMax = Math.max(rawColor.r, rawColor.g, rawColor.b);
  if (rawMax > 1e-6 && safeInt > 1e-6) {
    // Preserve >1.0 HDR intensity scaling while keeping hue & brightness strictly governed.
    const nextInt = maxComp / rawMax;
    const inv = 1 / Math.max(1e-6, nextInt);
    outColor.setRGB(Math.min(1, res.r * inv), Math.min(1, res.g * inv), Math.min(1, res.b * inv));
    return nextInt;
  }
  outColor.setRGB(res.r / maxComp, res.g / maxComp, res.b / maxComp);
  return maxComp;
}

export interface PreviewLaserUnitResult {
  intensity: number;
  limited: boolean;
}

const LASER_UNIT_SCRATCH: PreviewLaserUnitResult = { intensity: 0, limited: false };

/**
 * Per-projector preview laser emission governor (Codex review-06 R5).
 * Governs final per-projector preview intensity (after `s.laser.enabled`, `b.laser`, `s.laser.intensity`,
 * audio modulation, and strobe gates) plus resolved `colorA` and `colorB` (including custom colours)
 * through the shared preview `budgetClock`, keeping blackout / laser-off immediate.
 */
export function stepPreviewLaserUnit(
  state: PreviewFlashState,
  projectorKeyOrGov: string | PreviewLaserGovernorEntry,
  limited: boolean,
  blackout: boolean,
  rawIntensity: number,
  rawColorA: THREE.Color,
  rawColorB: THREE.Color,
  outColorA: THREE.Color,
  outColorB: THREE.Color,
  out: PreviewLaserUnitResult = LASER_UNIT_SCRATCH,
): PreviewLaserUnitResult {
  const safeInt = Number.isFinite(rawIntensity) && rawIntensity > 0 ? rawIntensity : 0;
  const entry =
    typeof projectorKeyOrGov === 'string'
      ? getOrCreatePreviewLaserGov(state, projectorKeyOrGov)
      : projectorKeyOrGov;

  if (!limited) {
    syncScalarPassthrough(entry.intensityGov, safeInt);
    syncRgbPassthrough(entry.colorAGov, rawColorA);
    syncRgbPassthrough(entry.colorBGov, rawColorB);
    outColorA.copy(rawColorA);
    outColorB.copy(rawColorB);
    out.intensity = safeInt;
    out.limited = false;
    return out;
  }

  syncPreviewClockEdges(state);
  const tMs = state.clockMs;
  const isOff = blackout || safeInt <= 1e-4;

  const intStep = stepGovernedScalar(
    entry.intensityGov,
    state.budgetClock,
    tMs,
    isOff ? 0 : safeInt,
    isOff,
    true,
    PREVIEW_EDGE_THRESHOLD,
    PREVIEW_REFRACTORY_MS,
  );
  syncPreviewClockEdges(state);
  const nextInt = intStep.value;

  const colAStep = stepGovernedRgb(
    entry.colorAGov,
    state.budgetClock,
    tMs,
    rawColorA.r,
    rawColorA.g,
    rawColorA.b,
    blackout,
    PREVIEW_EDGE_THRESHOLD,
    undefined,
    undefined,
    PREVIEW_REFRACTORY_MS,
    RGB_OUT_SCRATCH,
  );
  outColorA.setRGB(colAStep.r, colAStep.g, colAStep.b);
  syncPreviewClockEdges(state);

  const colBStep = stepGovernedRgb(
    entry.colorBGov,
    state.budgetClock,
    tMs,
    rawColorB.r,
    rawColorB.g,
    rawColorB.b,
    blackout,
    PREVIEW_EDGE_THRESHOLD,
    undefined,
    undefined,
    PREVIEW_REFRACTORY_MS,
    RGB_OUT_SCRATCH,
  );
  outColorB.setRGB(colBStep.r, colBStep.g, colBStep.b);
  syncPreviewClockEdges(state);

  const anyLimited = intStep.limited || colAStep.limited || colBStep.limited;
  if (anyLimited) {
    state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
  }
  out.intensity = nextInt;
  out.limited = anyLimited;
  return out;
}

/**
 * Zero-allocation preview-only flash governor (Sprint 15 + Sprint 24 hardening).
 * Operates exclusively on preview state and never mutates `AudioModulationState` or DMX buffers.
 */
export function evaluatePreviewFlash(
  state: PreviewFlashState,
  input: PreviewFlashInput,
  out: PreviewFlashOutput,
): PreviewFlashOutput {
  const safeDt = Number.isFinite(input.dtSec) && input.dtSec > 0 ? input.dtSec : 0;
  state.clockMs += safeDt * 1000;
  state.budgetClock.clockMs = state.clockMs;
  syncPreviewClockEdges(state);
  const tMs = state.clockMs;

  const beamPrimaryIn = input.beamPrimaryColor ?? input.primaryColor;
  const beamAccentIn = input.beamAccentColor ?? input.accentColor;
  const washPrimaryIn = input.washPrimaryColor ?? input.primaryColor;
  const washAccentIn = input.washAccentColor ?? input.accentColor;
  const bassIn = input.bass ?? 0;
  const midIn = input.mid ?? 0;
  const highIn = input.high ?? 0;
  const beamMixIn = input.beamColorMix ?? 0;
  const washMixIn = input.washColorMix ?? 0;
  const prismIn = typeof input.goboPrism === 'boolean'
    ? (input.goboPrism ? 1 : 0)
    : (Number.isFinite(input.goboPrism) ? Math.max(0, Math.min(1, Number(input.goboPrism))) : 0);

  if (!input.limited) {
    syncScalarPassthrough(state.masterGov, input.master);
    if (input.blinderVisible !== false) syncScalarPassthrough(state.blinderGov, input.blinder);
    syncScalarPassthrough(state.ledBrightGov, input.ledBright);
    syncScalarPassthrough(state.beatPulseGov, input.beatPulse);
    syncScalarPassthrough(state.bassGov, bassIn);
    syncScalarPassthrough(state.midGov, midIn);
    syncScalarPassthrough(state.highGov, highIn);
    syncScalarPassthrough(state.beamIntGov, input.beamIntensity);
    syncScalarPassthrough(state.washIntGov, input.washIntensity);
    syncScalarPassthrough(state.beamColorMixGov, beamMixIn);
    syncScalarPassthrough(state.washColorMixGov, washMixIn);
    syncScalarPassthrough(state.prismGov, prismIn);
    syncRgbPassthrough(state.primaryGov, input.primaryColor);
    syncRgbPassthrough(state.accentGov, input.accentColor);
    syncRgbPassthrough(state.beamPrimaryGov, beamPrimaryIn);
    syncRgbPassthrough(state.beamAccentGov, beamAccentIn);
    syncRgbPassthrough(state.washPrimaryGov, washPrimaryIn);
    syncRgbPassthrough(state.washAccentGov, washAccentIn);
    state.laserArmed = true;
    state.laserGateOn = false;
    state.laserOnUntilMs = -Infinity;

    out.master = input.master;
    out.blinder = input.blinderVisible === false ? 0 : input.blinder;
    out.ledBright = input.ledBright;
    out.beatPulse = input.beatPulse;
    out.bass = bassIn;
    out.mid = midIn;
    out.high = highIn;
    out.beamIntensity = input.beamIntensity;
    out.washIntensity = input.washIntensity;
    out.beamColorMix = beamMixIn;
    out.washColorMix = washMixIn;
    out.prismMix = prismIn;
    out.laserStrobeMultiplier = 1;
    out.bypassLaserShaderStrobe = false;
    out.ledFlashLimited = false;
    out.activeLimiting = false;
    out.primaryColor.copy(input.primaryColor);
    out.accentColor.copy(input.accentColor);
    out.beamPrimaryColor.copy(beamPrimaryIn);
    out.beamAccentColor.copy(beamAccentIn);
    out.washPrimaryColor.copy(washPrimaryIn);
    out.washAccentColor.copy(washAccentIn);
    return out;
  }

  const runScalar = (gov: ScalarGovernorState, target: number, instantFall: boolean): number => {
    const r = stepGovernedScalar(
      gov,
      state.budgetClock,
      tMs,
      target,
      input.blackout,
      instantFall,
      PREVIEW_EDGE_THRESHOLD,
      PREVIEW_REFRACTORY_MS,
    );
    syncPreviewClockEdges(state);
    if (r.limited) {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
    }
    return r.value;
  };

  const runColor = (gov: RgbGovernorState, src: THREE.Color, dst: THREE.Color): void => {
    const r = stepGovernedRgb(
      gov,
      state.budgetClock,
      tMs,
      src.r,
      src.g,
      src.b,
      input.blackout,
      PREVIEW_EDGE_THRESHOLD,
      undefined,
      undefined,
      PREVIEW_REFRACTORY_MS,
      RGB_OUT_SCRATCH,
    );
    syncPreviewClockEdges(state);
    if (r.limited) {
      state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
    }
    dst.setRGB(r.r, r.g, r.b);
  };

  const nextMaster = runScalar(state.masterGov, input.master, true);
  const nextBlinder = input.blinderVisible === false ? 0 : runScalar(state.blinderGov, input.blinder, true);
  const nextLedBright = runScalar(state.ledBrightGov, input.ledBright, true);
  const nextBeatPulse = runScalar(state.beatPulseGov, input.beatPulse, false);
  const nextBass = runScalar(state.bassGov, bassIn, false);
  const nextMid = runScalar(state.midGov, midIn, false);
  const nextHigh = runScalar(state.highGov, highIn, false);
  const nextBeamInt = runScalar(state.beamIntGov, input.beamIntensity, true);
  const nextWashInt = runScalar(state.washIntGov, input.washIntensity, true);
  const nextBeamMix = runScalar(state.beamColorMixGov, beamMixIn, false);
  const nextWashMix = runScalar(state.washColorMixGov, washMixIn, false);

  // Govern goboPrism spatial redistribution symmetrically (`blackout = false`, `instantFall = false`)
  // so the first toggle applies immediately while rapid 8–10 Hz toggling shares the room budgetClock.
  const prevPrism = state.prismGov.initialized ? state.prismGov.delivered : prismIn;
  const prismStep = stepGovernedScalar(
    state.prismGov,
    state.budgetClock,
    tMs,
    prismIn,
    false,
    false,
    PREVIEW_EDGE_THRESHOLD,
    PREVIEW_REFRACTORY_MS,
  );
  if (prevPrism - prismStep.value >= PREVIEW_EDGE_THRESHOLD) {
    // Unsplitting a prism brightens the central axis, so advance the global rise refractory too.
    state.budgetClock.lastAdmittedRiseMs = tMs;
    state.lastGlobalEdgeMs = tMs;
  }
  syncPreviewClockEdges(state);
  if (prismStep.limited) {
    state.limitedUntilMs = Math.max(state.limitedUntilMs, tMs + PREVIEW_FLASH_LIMITED_HOLD_MS);
  }
  const nextPrismMix = prismStep.value;

  runColor(state.primaryGov, input.primaryColor, out.primaryColor);
  runColor(state.accentGov, input.accentColor, out.accentColor);

  if (beamPrimaryIn === input.primaryColor) {
    syncRgbPassthrough(state.beamPrimaryGov, out.primaryColor);
    out.beamPrimaryColor.copy(out.primaryColor);
  } else {
    runColor(state.beamPrimaryGov, beamPrimaryIn, out.beamPrimaryColor);
  }

  if (beamAccentIn === input.accentColor) {
    syncRgbPassthrough(state.beamAccentGov, out.accentColor);
    out.beamAccentColor.copy(out.accentColor);
  } else {
    runColor(state.beamAccentGov, beamAccentIn, out.beamAccentColor);
  }

  if (washPrimaryIn === input.primaryColor) {
    syncRgbPassthrough(state.washPrimaryGov, out.primaryColor);
    out.washPrimaryColor.copy(out.primaryColor);
  } else {
    runColor(state.washPrimaryGov, washPrimaryIn, out.washPrimaryColor);
  }

  if (washAccentIn === input.accentColor) {
    syncRgbPassthrough(state.washAccentGov, out.accentColor);
    out.washAccentColor.copy(out.accentColor);
  } else {
    runColor(state.washAccentGov, washAccentIn, out.washAccentColor);
  }

  // Unmapped laser shader strobe (single global phase admitted through the shared preview budgetClock).
  let laserStrobeMultiplier = 1;
  if (input.laserStrobe > 0.02 && !input.blackout) {
    const rawLit = rawLaserStrobeOscillator(input.laserStrobe, input.tSec);
    if (state.laserGateOn) {
      if (tMs >= state.laserOnUntilMs && !rawLit) {
        state.laserGateOn = false;
        recordFlashFall(state.budgetClock, tMs);
      } else if (tMs >= state.laserOnUntilMs) {
        state.laserGateOn = false;
        state.laserArmed = false;
        recordFlashFall(state.budgetClock, tMs);
      }
    }
    if (!rawLit) {
      state.laserArmed = true;
    } else if (state.laserArmed && !state.laserGateOn) {
      if (canAdmitPreviewEdge(state)) {
        recordFlashRise(state.budgetClock, tMs);
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
    if (state.laserGateOn) {
      recordFlashFall(state.budgetClock, tMs);
    }
    state.laserArmed = true;
    state.laserGateOn = false;
    state.laserOnUntilMs = -Infinity;
  }

  out.master = nextMaster;
  out.blinder = nextBlinder;
  out.ledBright = nextLedBright;
  out.beatPulse = nextBeatPulse;
  out.bass = nextBass;
  out.mid = nextMid;
  out.high = nextHigh;
  out.beamIntensity = nextBeamInt;
  out.washIntensity = nextWashInt;
  out.beamColorMix = nextBeamMix;
  out.washColorMix = nextWashMix;
  out.prismMix = nextPrismMix;
  out.laserStrobeMultiplier = laserStrobeMultiplier;
  out.bypassLaserShaderStrobe = true;
  out.ledFlashLimited = true;
  out.activeLimiting = tMs < state.limitedUntilMs;
  return out;
}
