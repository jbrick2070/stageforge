import type {
  AudioMapConfig,
  AudioMapping,
  AudioMappingCurve,
  AudioMappingSource,
  AudioMetrics,
  AudioTargetGroup,
  AudioTargetParam,
  ShowState,
} from '../types/show';
import { headLook } from '../data/movingGroups';

export const MAX_AUDIO_MAPPINGS = 16;
export const HAZE_MIN_ATTACK_MS = 1000;
export const HAZE_MIN_RELEASE_MS = 2000;

/**
 * Photosensitivity guidance: <= 3 full-intensity flashes per second.
 * - Triggered strobes enforce >= 334 ms between rising edges (at most 3 flashes in any 1000 ms window).
 * - Continuous blinder/strobe dimmer targets cap downward slew at 1.75 / s so a full flash
 *   (<= 0.2 -> >= 0.8 -> <= 0.2, delta >= 0.6) takes >= 343 ms (<= 2.91 full flashes / s).
 */
export const FLASH_REFRACTORY_MS = 334;
export const FLASH_ON_MS = 50;
export const FLASH_TRIGGER_ON = 0.2;
export const FLASH_TRIGGER_REARM = 0.1;
export const FLASH_SLEW_FALL_PER_SEC = 1.75;
export const FLASH_LIMITED_HOLD_MS = 1000;

export const LASER_MIN_SPREAD = 0.1;
export const TILT_OFFSET_SCALE_RAD = 0.35;

export const AUDIO_SOURCES: readonly AudioMappingSource[] = [
  'bass',
  'mid',
  'high',
  'energy',
  'beat',
  'drop',
  'band',
];

export const AUDIO_CURVES: readonly AudioMappingCurve[] = ['linear', 'square', 'sqrt'];

export const AUDIO_TARGET_GROUPS: readonly AudioTargetGroup[] = [
  'beam',
  'wash',
  'blinder',
  'strobe',
  'ledWall',
  'laser',
  'haze',
];

export const AUDIO_TARGET_PARAMS: Readonly<Record<AudioTargetGroup, readonly AudioTargetParam[]>> = {
  beam: ['dimmer', 'zoom', 'colorMix', 'strobe', 'speed', 'tilt'],
  wash: ['dimmer', 'zoom', 'colorMix', 'strobe', 'speed', 'tilt'],
  blinder: ['dimmer'],
  strobe: ['strobe', 'dimmer'],
  ledWall: ['brightness', 'speed'],
  laser: ['intensity', 'speed', 'rotation', 'spread', 'strobe'],
  haze: ['dimmer'],
};

export function isValidAudioTargetParam(group: AudioTargetGroup, param: AudioTargetParam): boolean {
  const list = AUDIO_TARGET_PARAMS[group];
  return Array.isArray(list) && list.includes(param);
}

/** Strobe trigger gates and laser scan speed do not allow negative amounts (laser speed must never slow below base). */
export function allowsNegativeAmount(group: AudioTargetGroup, param: AudioTargetParam): boolean {
  if (param === 'strobe') return false;
  if (group === 'laser' && param === 'speed') return false;
  return true;
}

export const AUDIO_MAPPING_PRESETS: readonly AudioMapping[] = [
  {
    id: 'preset-kick-wash',
    name: 'Kick → wash dimmer',
    enabled: true,
    source: 'band',
    bands: [0, 0],
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.85,
    attackMs: 10,
    releaseMs: 140,
    threshold: 0.08,
    curve: 'linear',
  },
  {
    id: 'preset-hats-strobe',
    name: 'Hats → beam strobe',
    enabled: true,
    source: 'band',
    bands: [24, 31],
    target: { group: 'beam', param: 'strobe' },
    amount: 0.85,
    attackMs: 5,
    releaseMs: 80,
    threshold: 0.12,
    curve: 'linear',
  },
  {
    id: 'preset-bass-led',
    name: 'Bass → LED wall',
    enabled: true,
    source: 'bass',
    target: { group: 'ledWall', param: 'brightness' },
    amount: 0.5,
    attackMs: 20,
    releaseMs: 180,
    threshold: 0.08,
    curve: 'sqrt',
  },
  {
    id: 'preset-energy-zoom',
    name: 'Energy → beam zoom',
    enabled: true,
    source: 'energy',
    target: { group: 'beam', param: 'zoom' },
    amount: 0.65,
    attackMs: 30,
    releaseMs: 220,
    threshold: 0.1,
    curve: 'linear',
  },
];

export interface StrobeGateState {
  armed: boolean;
  lastEdgeMs: number;
  onUntilMs: number;
  limitedUntilMs: number;
  gateOn: boolean;
  limited: boolean;
}

export interface SlewLimiterState {
  value: number;
  initialized: boolean;
  limitedUntilMs: number;
  limited: boolean;
}

export interface AudioFollowerSlot {
  id: string;
  envelope: number;
}

export interface AudioModulationState {
  clockMs: number;
  lastGlobalStrobeEdgeMs: number;
  manualStrobeGate: number;
  deliveredBeamGate: number;
  deliveredWashGate: number;
  deliveredBarGate: number;
  slots: AudioFollowerSlot[];
  manualStrobe: StrobeGateState;
  beamStrobe: StrobeGateState;
  washStrobe: StrobeGateState;
  barStrobe: StrobeGateState;
  laserStrobe: StrobeGateState;
  beamDimmerSlew: SlewLimiterState;
  washDimmerSlew: SlewLimiterState;
  blinderSlew: SlewLimiterState;
  strobeDimmerSlew: SlewLimiterState;
  ledBrightSlew: SlewLimiterState;
  laserIntSlew: SlewLimiterState;
  laserProjectorStrobes: Record<string, StrobeGateState>;
  laserProjectorIntSlews: Record<string, SlewLimiterState>;
  // Pre-allocated zero-allocation scratch buffers for per-projector laser overrides.
  projKeys: string[];
  projKeyCount: number;
  prevProjKeys: string[];
  prevProjKeyCount: number;
  projPool: LaserModValues[];
  projFlags: Record<string, number>;
  projIntFactors: Record<string, number>;
  projSpreadFactors: Record<string, number>;
  projRotFactors: Record<string, number>;
  projSpeedDeltas: Record<string, number>;
  projStrobeSigs: Record<string, number>;
}

export interface StrobeModResult {
  mapped: boolean;
  envelope: number;
  gateOn: boolean;
  lastFlashMs: number;
  limited: boolean;
}

export interface HeadGroupModResult {
  dimmer: number;
  dimmerMapped: boolean;
  zoom: number;
  zoomMapped: boolean;
  colorMix: number;
  colorMixMapped: boolean;
  speed: number;
  speedMapped: boolean;
  tiltOffset: number;
  tiltMapped: boolean;
  strobe: StrobeModResult;
}

export interface LaserModValues {
  intensity: number;
  intensityMapped: boolean;
  speed: number;
  speedMapped: boolean;
  rotation: number;
  rotationMapped: boolean;
  spreadX: number;
  spreadY: number;
  spreadMapped: boolean;
  strobe: StrobeModResult;
}

export interface AudioModulationEntry {
  id: string;
  name: string;
  enabled: boolean;
  group: AudioTargetGroup;
  param: AudioTargetParam;
  projectorKey?: string;
  raw: number;
  envelope: number;
  modulatedValue: number;
}

export interface AudioModulationFrame {
  active: boolean;
  flashLimited: boolean;
  beam: HeadGroupModResult;
  wash: HeadGroupModResult;
  blinder: { dimmer: number; mapped: boolean; limited: boolean };
  strobeBar: {
    dimmer: number;
    dimmerMapped: boolean;
    dimmerLimited: boolean;
    strobe: StrobeModResult;
  };
  ledWall: {
    brightness: number;
    brightnessMapped: boolean;
    speed: number;
    speedMapped: boolean;
  };
  laser: LaserModValues & {
    projectors: Record<string, LaserModValues>;
  };
  haze: { level: number; mapped: boolean };
  entryCount: number;
  entries: AudioModulationEntry[];
}

function createStrobeGateState(): StrobeGateState {
  return {
    armed: true,
    lastEdgeMs: -Infinity,
    onUntilMs: -Infinity,
    limitedUntilMs: -Infinity,
    gateOn: false,
    limited: false,
  };
}

function disarmStrobeGate(g: StrobeGateState) {
  // Preserve lastEdgeMs & limitedUntilMs monotonically so disabling/re-enabling never bypasses the 334 ms refractory gate.
  g.armed = true;
  g.onUntilMs = -Infinity;
  g.gateOn = false;
  g.limited = false;
}

function createSlewLimiterState(): SlewLimiterState {
  return { value: 0, initialized: false, limitedUntilMs: -Infinity, limited: false };
}

function disarmSlewLimiter(s: SlewLimiterState) {
  s.value = 0;
  s.initialized = false;
  s.limited = false;
}

function createStrobeModResult(): StrobeModResult {
  return { mapped: false, envelope: 0, gateOn: false, lastFlashMs: -Infinity, limited: false };
}

function createHeadGroupModResult(): HeadGroupModResult {
  return {
    dimmer: 0,
    dimmerMapped: false,
    zoom: 0,
    zoomMapped: false,
    colorMix: 0,
    colorMixMapped: false,
    speed: 0,
    speedMapped: false,
    tiltOffset: 0,
    tiltMapped: false,
    strobe: createStrobeModResult(),
  };
}

function createLaserModValues(): LaserModValues {
  return {
    intensity: 0,
    intensityMapped: false,
    speed: 0,
    speedMapped: false,
    rotation: 0,
    rotationMapped: false,
    spreadX: 0.1,
    spreadY: 0.1,
    spreadMapped: false,
    strobe: createStrobeModResult(),
  };
}

export function createAudioModulationState(): AudioModulationState {
  const slots: AudioFollowerSlot[] = [];
  const projPool: LaserModValues[] = [];
  const projKeys: string[] = [];
  const prevProjKeys: string[] = [];
  for (let i = 0; i < MAX_AUDIO_MAPPINGS; i++) {
    slots.push({ id: '', envelope: 0 });
    projPool.push(createLaserModValues());
    projKeys.push('');
    prevProjKeys.push('');
  }
  return {
    clockMs: 0,
    lastGlobalStrobeEdgeMs: -Infinity,
    manualStrobeGate: 1.0,
    deliveredBeamGate: 1.0,
    deliveredWashGate: 1.0,
    deliveredBarGate: 1.0,
    slots,
    manualStrobe: createStrobeGateState(),
    beamStrobe: createStrobeGateState(),
    washStrobe: createStrobeGateState(),
    barStrobe: createStrobeGateState(),
    laserStrobe: createStrobeGateState(),
    beamDimmerSlew: createSlewLimiterState(),
    washDimmerSlew: createSlewLimiterState(),
    blinderSlew: createSlewLimiterState(),
    strobeDimmerSlew: createSlewLimiterState(),
    ledBrightSlew: createSlewLimiterState(),
    laserIntSlew: createSlewLimiterState(),
    laserProjectorStrobes: Object.create(null) as Record<string, StrobeGateState>,
    laserProjectorIntSlews: Object.create(null) as Record<string, SlewLimiterState>,
    projKeys,
    projKeyCount: 0,
    prevProjKeys,
    prevProjKeyCount: 0,
    projPool,
    projFlags: Object.create(null) as Record<string, number>,
    projIntFactors: Object.create(null) as Record<string, number>,
    projSpreadFactors: Object.create(null) as Record<string, number>,
    projRotFactors: Object.create(null) as Record<string, number>,
    projSpeedDeltas: Object.create(null) as Record<string, number>,
    projStrobeSigs: Object.create(null) as Record<string, number>,
  };
}

export function cloneAudioModulationState(src: AudioModulationState): AudioModulationState {
  const copy = createAudioModulationState();
  copy.clockMs = src.clockMs;
  copy.lastGlobalStrobeEdgeMs = src.lastGlobalStrobeEdgeMs;
  copy.manualStrobeGate = src.manualStrobeGate;
  copy.deliveredBeamGate = src.deliveredBeamGate;
  copy.deliveredWashGate = src.deliveredWashGate;
  copy.deliveredBarGate = src.deliveredBarGate;
  for (let i = 0; i < MAX_AUDIO_MAPPINGS; i++) {
    copy.slots[i].id = src.slots[i]?.id ?? '';
    copy.slots[i].envelope = src.slots[i]?.envelope ?? 0;
  }
  Object.assign(copy.manualStrobe, src.manualStrobe);
  Object.assign(copy.beamStrobe, src.beamStrobe);
  Object.assign(copy.washStrobe, src.washStrobe);
  Object.assign(copy.barStrobe, src.barStrobe);
  Object.assign(copy.laserStrobe, src.laserStrobe);
  Object.assign(copy.beamDimmerSlew, src.beamDimmerSlew);
  Object.assign(copy.washDimmerSlew, src.washDimmerSlew);
  Object.assign(copy.blinderSlew, src.blinderSlew);
  Object.assign(copy.strobeDimmerSlew, src.strobeDimmerSlew);
  Object.assign(copy.ledBrightSlew, src.ledBrightSlew);
  Object.assign(copy.laserIntSlew, src.laserIntSlew);
  for (const key of Object.keys(src.laserProjectorStrobes)) {
    copy.laserProjectorStrobes[key] = { ...src.laserProjectorStrobes[key] };
  }
  for (const key of Object.keys(src.laserProjectorIntSlews)) {
    copy.laserProjectorIntSlews[key] = { ...src.laserProjectorIntSlews[key] };
  }
  return copy;
}

export function resetAudioModulationState(state: AudioModulationState) {
  // Keep clockMs, lastGlobalStrobeEdgeMs and gate lastEdgeMs monotonic so toggling Beat sync or cues
  // can never bypass the photosensitivity <= 3/s refractory window.
  for (let i = 0; i < state.slots.length; i++) {
    state.slots[i].id = '';
    state.slots[i].envelope = 0;
  }
  disarmStrobeGate(state.manualStrobe);
  disarmStrobeGate(state.beamStrobe);
  disarmStrobeGate(state.washStrobe);
  disarmStrobeGate(state.barStrobe);
  disarmStrobeGate(state.laserStrobe);
  disarmSlewLimiter(state.beamDimmerSlew);
  disarmSlewLimiter(state.washDimmerSlew);
  disarmSlewLimiter(state.blinderSlew);
  disarmSlewLimiter(state.strobeDimmerSlew);
  disarmSlewLimiter(state.ledBrightSlew);
  disarmSlewLimiter(state.laserIntSlew);
  for (const key in state.laserProjectorStrobes) {
    disarmStrobeGate(state.laserProjectorStrobes[key]);
  }
  for (const key in state.laserProjectorIntSlews) {
    disarmSlewLimiter(state.laserProjectorIntSlews[key]);
  }
}

export function createAudioModulationFrame(): AudioModulationFrame {
  const entries: AudioModulationEntry[] = [];
  for (let i = 0; i < MAX_AUDIO_MAPPINGS; i++) {
    entries.push({
      id: '',
      name: '',
      enabled: false,
      group: 'wash',
      param: 'dimmer',
      raw: 0,
      envelope: 0,
      modulatedValue: 0,
    });
  }
  return {
    active: false,
    flashLimited: false,
    beam: createHeadGroupModResult(),
    wash: createHeadGroupModResult(),
    blinder: { dimmer: 0, mapped: false, limited: false },
    strobeBar: {
      dimmer: 0,
      dimmerMapped: false,
      dimmerLimited: false,
      strobe: createStrobeModResult(),
    },
    ledWall: {
      brightness: 0,
      brightnessMapped: false,
      speed: 0,
      speedMapped: false,
    },
    laser: {
      ...createLaserModValues(),
      projectors: Object.create(null) as Record<string, LaserModValues>,
    },
    haze: { level: 0, mapped: false },
    entryCount: 0,
    entries,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Read the normalized 0..1 audio source value from live AudioMetrics. */
export function readAudioSource(
  metrics: AudioMetrics,
  source: AudioMappingSource,
  bands?: [number, number],
): number {
  if (!metrics.playing) return 0;
  switch (source) {
    case 'bass':
      return clamp01(metrics.bass);
    case 'mid':
      return clamp01(metrics.mid);
    case 'high':
      return clamp01(metrics.high);
    case 'energy':
      return clamp01(metrics.energy);
    case 'beat':
      return metrics.beat ? 1 : clamp01(metrics.beatPulse);
    case 'drop':
      return metrics.drop ? 1 : 0;
    case 'band': {
      const spec = metrics.spectrum;
      if (!spec || spec.length === 0) return 0;
      const maxIdx = spec.length - 1;
      const rawLo = bands ? Math.round(bands[0]) : 0;
      const rawHi = bands ? Math.round(bands[1]) : rawLo;
      const lo = clamp(rawLo, 0, maxIdx);
      const hi = clamp(Math.max(lo, rawHi), 0, maxIdx);
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += clamp01(spec[i]);
      return sum / (hi - lo + 1);
    }
  }
}

/** Apply threshold gate and curve shaping to a raw 0..1 reading. */
export function shapeAudioSignal(raw: number, threshold: number, curve: AudioMappingCurve): number {
  const thr = clamp01(threshold);
  const val = clamp01(raw);
  if (val <= thr || thr >= 1) return 0;
  const gated = (val - thr) / (1 - thr);
  if (curve === 'square') return gated * gated;
  if (curve === 'sqrt') return Math.sqrt(gated);
  return gated;
}

/** Advance one exponential envelope follower by `dt` seconds. */
export function stepEnvelope(
  prev: number,
  target: number,
  attackMs: number,
  releaseMs: number,
  dt: number,
): number {
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const clampedTarget = clamp01(target);
  const clampedPrev = clamp01(prev);
  if (safeDt <= 0) return clampedPrev;
  const tauMs = clampedTarget > clampedPrev ? Math.max(0, attackMs) : Math.max(0, releaseMs);
  if (tauMs <= 0) return clampedTarget;
  const alpha = 1 - Math.exp((-safeDt * 1000) / tauMs);
  return clamp01(clampedPrev + (clampedTarget - clampedPrev) * alpha);
}

/** Scaling factor strictly in [0, 1] for safety-capped laser parameters (always <= base). */
function safetyScaleFactor(amount: number, env: number): number {
  const a = clamp(amount, -1, 1);
  const e = clamp01(env);
  if (a >= 0) return (1 - a) + a * e;
  return clamp01(1 + a * e);
}

function stepStrobeGate(
  gate: StrobeGateState,
  signal: number,
  tMs: number,
  out: StrobeModResult,
  state: AudioModulationState,
): boolean {
  const env = clamp01(signal);
  if (env >= FLASH_TRIGGER_ON && gate.armed) {
    const gateReady = tMs - gate.lastEdgeMs >= FLASH_REFRACTORY_MS;
    const globalReady =
      tMs === state.lastGlobalStrobeEdgeMs ||
      tMs - state.lastGlobalStrobeEdgeMs >= FLASH_REFRACTORY_MS;
    if (gateReady && globalReady) {
      gate.lastEdgeMs = tMs;
      state.lastGlobalStrobeEdgeMs = tMs;
      gate.onUntilMs = tMs + FLASH_ON_MS;
    } else {
      gate.limitedUntilMs = tMs + FLASH_LIMITED_HOLD_MS;
    }
    gate.armed = false;
  } else if (env < FLASH_TRIGGER_REARM) {
    gate.armed = true;
  }
  gate.gateOn = tMs < gate.onUntilMs;
  gate.limited = tMs < gate.limitedUntilMs;

  out.mapped = true;
  out.envelope = env;
  out.gateOn = gate.gateOn;
  out.lastFlashMs = gate.lastEdgeMs;
  out.limited = gate.limited;
  return gate.limited;
}

function stepSlewLimiter(
  slew: SlewLimiterState,
  target: number,
  dt: number,
  tMs: number,
): { value: number; limited: boolean } {
  const clampedTarget = clamp01(target);
  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (!slew.initialized) {
    slew.value = clampedTarget;
    slew.initialized = true;
    slew.limited = false;
    return { value: clampedTarget, limited: false };
  }
  const minNext = Math.max(0, slew.value - safeDt * FLASH_SLEW_FALL_PER_SEC);
  const next = Math.max(clampedTarget, minNext);
  if (next > clampedTarget + 0.02) {
    slew.limitedUntilMs = tMs + FLASH_LIMITED_HOLD_MS;
  }
  slew.value = next;
  slew.limited = tMs < slew.limitedUntilMs;
  return { value: next, limited: slew.limited };
}

function clearStrobeOut(out: StrobeModResult) {
  out.mapped = false;
  out.envelope = 0;
  out.gateOn = false;
  out.lastFlashMs = -Infinity;
  out.limited = false;
}

export interface CombinedStrobeGateResult {
  gate: number;
  flashOn: boolean;
  limited: boolean;
}

const MANUAL_STROBE_SCRATCH: StrobeModResult = createStrobeModResult();

/**
 * Enforce the photosensitivity <= 3 flashes/s ceiling on manual `strobeRate` and `bump.strobe`
 * combined with audio-mapped strobes via the shared monotonic `state.lastGlobalStrobeEdgeMs` clock.
 * Runs before both rendering and physical DMX encoding so strobe bumps cannot inject > 3 Hz dimmer flashes.
 */
export function stepCombinedStrobeGate(
  state: AudioModulationState,
  effectiveStrobe: number,
  tSec: number,
  blackout: boolean,
  out?: CombinedStrobeGateResult,
): CombinedStrobeGateResult {
  const res: CombinedStrobeGateResult = out ?? { gate: 1.0, flashOn: false, limited: false };
  const tMs = state.clockMs;
  if (blackout) {
    disarmStrobeGate(state.manualStrobe);
    // Preserve manualStrobeGate across blackout (do not reset 0.06 -> 1.0) so toggling blackout
    // on/off inside a strobe trough cannot bypass the <= 3 flashes/s refractory window (QA M3).
    res.gate = 1.0;
    res.flashOn = false;
    res.limited = tMs < state.manualStrobe.limitedUntilMs;
    return res;
  }
  if (!Number.isFinite(effectiveStrobe) || effectiveStrobe <= 0.03) {
    disarmStrobeGate(state.manualStrobe);
    // Restoring from a strobe dark trough (< 0.5) back to full brightness (1.0) is a bright
    // rising edge; hold dark until the shared <= 3 flashes/s refractory window has elapsed so
    // rapid strobe press/release cycles cannot bypass the photosensitivity ceiling (Codex R1).
    if (state.manualStrobeGate < 0.5) {
      const gateReady = tMs - state.manualStrobe.lastEdgeMs >= FLASH_REFRACTORY_MS;
      // Allow restoration on an already-admitted same-frame global edge (matching stepStrobeGate)
      // so another audio-mapped group pulsing every ~340 ms cannot starve manual release forever (Codex review-04 R2).
      const globalReady =
        tMs === state.lastGlobalStrobeEdgeMs ||
        tMs - state.lastGlobalStrobeEdgeMs >= FLASH_REFRACTORY_MS;
      if (!gateReady || !globalReady) {
        state.manualStrobe.limitedUntilMs = tMs + FLASH_LIMITED_HOLD_MS;
        res.gate = 0.06;
        res.flashOn = false;
        res.limited = true;
        return res;
      }
      state.manualStrobe.lastEdgeMs = tMs;
      state.lastGlobalStrobeEdgeMs = tMs;
    }
    state.manualStrobeGate = 1.0;
    res.gate = 1.0;
    res.flashOn = false;
    res.limited = tMs < state.manualStrobe.limitedUntilMs;
    return res;
  }
  const freq = 3.5 + clamp01(effectiveStrobe) * 24.0;
  const oscSignal = Math.sin(tSec * freq * Math.PI * 2) > 0.25 ? 1 : 0;
  const limited = stepStrobeGate(state.manualStrobe, oscSignal, tMs, MANUAL_STROBE_SCRATCH, state);
  res.flashOn = state.manualStrobe.gateOn;
  res.gate = res.flashOn ? 1.35 : 0.06;
  state.manualStrobeGate = res.gate;
  res.limited = limited;
  return res;
}

/**
 * Post-composition strobe transition limiter enforcing <= 3 bright rising edges/s across ANY source
 * switch (toggling `audioReactive`, switching cues between mapped and unmapped strobes, releasing
 * bumps, or mixing audio + manual gates). Zero per-frame allocations (Codex review-04 R1).
 */
export function stepDeliveredStrobeGate(
  state: AudioModulationState,
  channel: 'beam' | 'wash' | 'bar',
  desiredGate: number,
  blackout: boolean,
): number {
  if (blackout) {
    // Preserve delivered gate across blackout so toggling blackout in a trough cannot bypass refractory.
    return desiredGate;
  }
  const tMs = state.clockMs;
  const prev =
    channel === 'beam'
      ? state.deliveredBeamGate
      : channel === 'wash'
        ? state.deliveredWashGate
        : state.deliveredBarGate;
  let delivered = desiredGate;
  if (prev < 0.5 && desiredGate >= 0.5) {
    // Relies on state.clockMs advancing once per frame in evaluateAudioModulation before all
    // strobe-limiter calls in that frame, so equal timestamps represent one synchronized room edge.
    const globalReady =
      tMs === state.lastGlobalStrobeEdgeMs ||
      tMs - state.lastGlobalStrobeEdgeMs >= FLASH_REFRACTORY_MS;
    if (!globalReady) {
      state.manualStrobe.limitedUntilMs = Math.max(
        state.manualStrobe.limitedUntilMs,
        tMs + FLASH_LIMITED_HOLD_MS,
      );
      delivered = 0.06;
    } else {
      state.lastGlobalStrobeEdgeMs = tMs;
    }
  }
  if (channel === 'beam') state.deliveredBeamGate = delivered;
  else if (channel === 'wash') state.deliveredWashGate = delivered;
  else state.deliveredBarGate = delivered;
  return delivered;
}

/**
 * Zero-allocation per-frame audio modulation evaluator used directly by `StageEngine.updateScene`.
 * Mutates `state` and `out` in place and returns `out`.
 * When `audioReactive` is false or there are no enabled mappings, resets followers and sets `out.active = false`.
 */
export function evaluateAudioModulation(
  look: ShowState,
  metrics: AudioMetrics,
  state: AudioModulationState,
  dt: number,
  out: AudioModulationFrame,
): AudioModulationFrame {
  const mappings = look.audioMap?.mappings;
  const count = mappings ? Math.min(mappings.length, MAX_AUDIO_MAPPINGS) : 0;

  let anyEnabled = false;
  if (look.audioReactive && count > 0) {
    for (let i = 0; i < count; i++) {
      if (mappings![i].enabled) {
        anyEnabled = true;
        break;
      }
    }
  }

  const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
  // Advance monotonic limiter clock even while inactive so toggling Beat sync or cues
  // never resets or freezes the <= 3/s refractory window.
  state.clockMs += safeDt * 1000;
  const tMs = state.clockMs;

  if (!anyEnabled) {
    if (out.active) {
      resetAudioModulationState(state);
    }
    if (state.prevProjKeyCount > 0) {
      for (let i = 0; i < state.prevProjKeyCount; i++) {
        const k = state.prevProjKeys[i];
        delete out.laser.projectors[k];
        state.projFlags[k] = 0;
      }
      state.prevProjKeyCount = 0;
    }
    out.active = false;
    out.flashLimited = false;
    out.entryCount = 0;
    return out;
  }

  // Initialize base values from the current look.
  const beamLook = headLook(look, 'beam');
  const washLook = headLook(look, 'wash');
  const master = look.blackout ? 0 : clamp01(look.masterDimmer);

  out.active = true;
  out.flashLimited = false;
  out.entryCount = count;

  // Reset per-frame accumulators.
  let beamDimDelta = 0, beamDimMapped = false;
  let beamZoomDelta = 0, beamZoomMapped = false;
  let beamColorDelta = 0, beamColorMapped = false;
  let beamSpeedDelta = 0, beamSpeedMapped = false;
  let beamTiltDelta = 0, beamTiltMapped = false;
  let beamStrobeSig = 0, beamStrobeMapped = false;

  let washDimDelta = 0, washDimMapped = false;
  let washZoomDelta = 0, washZoomMapped = false;
  let washColorDelta = 0, washColorMapped = false;
  let washSpeedDelta = 0, washSpeedMapped = false;
  let washTiltDelta = 0, washTiltMapped = false;
  let washStrobeSig = 0, washStrobeMapped = false;

  let blinderDelta = 0, blinderMapped = false;
  let strobeDimDelta = 0, strobeDimMapped = false;
  let barStrobeSig = 0, barStrobeMapped = false;

  let ledBrightDelta = 0, ledBrightMapped = false;
  let ledSpeedDelta = 0, ledSpeedMapped = false;

  let laserIntFactor = 1, laserIntMapped = false;
  let laserSpreadFactor = 1, laserSpreadMapped = false;
  let laserRotFactor = 1, laserRotMapped = false;
  let laserSpeedDelta = 0, laserSpeedMapped = false;
  let laserStrobeSig = 0, laserStrobeMapped = false;

  let hazeDelta = 0, hazeMapped = false;

  // Zero-allocation per-projector scratch reset (only touches keys used on the previous frame).
  const projOut = out.laser.projectors;
  for (let i = 0; i < state.prevProjKeyCount; i++) {
    const k = state.prevProjKeys[i];
    delete projOut[k];
    state.projFlags[k] = 0;
  }
  state.projKeyCount = 0;

  const PF_INT = 1;
  const PF_SPREAD = 2;
  const PF_ROT = 4;
  const PF_SPEED = 8;
  const PF_STROBE = 16;

  // Clear unused follower slots so removed mappings don't retain stale envelopes.
  for (let i = count; i < MAX_AUDIO_MAPPINGS; i++) {
    state.slots[i].id = '';
    state.slots[i].envelope = 0;
  }

  for (let i = 0; i < count; i++) {
    const m = mappings![i];
    const slot = state.slots[i];
    if (slot.id !== m.id) {
      slot.id = m.id;
      slot.envelope = 0;
    }

    const entry = out.entries[i];
    entry.id = m.id;
    entry.name = m.name;
    entry.enabled = m.enabled;
    entry.group = m.target.group;
    entry.param = m.target.param;
    entry.projectorKey = m.target.projectorKey;

    if (!m.enabled || !isValidAudioTargetParam(m.target.group, m.target.param)) {
      slot.envelope = 0;
      entry.raw = 0;
      entry.envelope = 0;
      entry.modulatedValue = 0;
      continue;
    }

    const raw = readAudioSource(metrics, m.source, m.bands);
    const shaped = shapeAudioSignal(raw, m.threshold, m.curve);
    const minAtk = m.target.group === 'haze' ? HAZE_MIN_ATTACK_MS : 0;
    const minRel = m.target.group === 'haze' ? HAZE_MIN_RELEASE_MS : 0;
    const attackMs = Math.max(minAtk, Number.isFinite(m.attackMs) ? m.attackMs : 0);
    const releaseMs = Math.max(minRel, Number.isFinite(m.releaseMs) ? m.releaseMs : 0);
    const env = stepEnvelope(slot.envelope, shaped, attackMs, releaseMs, safeDt);
    slot.envelope = env;

    const rawAmount = clamp(m.amount, -1, 1);
    const amount = allowsNegativeAmount(m.target.group, m.target.param) ? rawAmount : Math.max(0, rawAmount);
    const delta = amount * env;

    entry.raw = raw;
    entry.envelope = env;
    entry.modulatedValue = 0;

    const { group, param, projectorKey } = m.target;
    if (group === 'beam') {
      if (param === 'dimmer') { beamDimDelta += delta; beamDimMapped = true; }
      else if (param === 'zoom') { beamZoomDelta += delta; beamZoomMapped = true; }
      else if (param === 'colorMix') { beamColorDelta += delta; beamColorMapped = true; }
      else if (param === 'speed') { beamSpeedDelta += delta; beamSpeedMapped = true; }
      else if (param === 'tilt') { beamTiltDelta += delta; beamTiltMapped = true; }
      else if (param === 'strobe') { beamStrobeSig += Math.max(0, delta); beamStrobeMapped = true; }
    } else if (group === 'wash') {
      if (param === 'dimmer') { washDimDelta += delta; washDimMapped = true; }
      else if (param === 'zoom') { washZoomDelta += delta; washZoomMapped = true; }
      else if (param === 'colorMix') { washColorDelta += delta; washColorMapped = true; }
      else if (param === 'speed') { washSpeedDelta += delta; washSpeedMapped = true; }
      else if (param === 'tilt') { washTiltDelta += delta; washTiltMapped = true; }
      else if (param === 'strobe') { washStrobeSig += Math.max(0, delta); washStrobeMapped = true; }
    } else if (group === 'blinder') {
      if (param === 'dimmer') { blinderDelta += delta; blinderMapped = true; }
    } else if (group === 'strobe') {
      if (param === 'dimmer') { strobeDimDelta += delta; strobeDimMapped = true; }
      else if (param === 'strobe') { barStrobeSig += Math.max(0, delta); barStrobeMapped = true; }
    } else if (group === 'ledWall') {
      if (param === 'brightness') { ledBrightDelta += delta; ledBrightMapped = true; }
      else if (param === 'speed') { ledSpeedDelta += delta; ledSpeedMapped = true; }
    } else if (group === 'haze') {
      if (param === 'dimmer') { hazeDelta += delta; hazeMapped = true; }
    } else if (group === 'laser') {
      if (projectorKey) {
        let flags = state.projFlags[projectorKey] ?? 0;
        if (flags === 0) {
          state.projKeys[state.projKeyCount++] = projectorKey;
          state.projIntFactors[projectorKey] = 1;
          state.projSpreadFactors[projectorKey] = 1;
          state.projRotFactors[projectorKey] = 1;
          state.projSpeedDeltas[projectorKey] = 0;
          state.projStrobeSigs[projectorKey] = 0;
        }
        if (param === 'intensity') {
          state.projIntFactors[projectorKey] *= safetyScaleFactor(amount, env);
          flags |= PF_INT;
        } else if (param === 'spread') {
          state.projSpreadFactors[projectorKey] *= safetyScaleFactor(amount, env);
          flags |= PF_SPREAD;
        } else if (param === 'rotation') {
          state.projRotFactors[projectorKey] *= safetyScaleFactor(amount, env);
          flags |= PF_ROT;
        } else if (param === 'speed') {
          state.projSpeedDeltas[projectorKey] += Math.max(0, delta);
          flags |= PF_SPEED;
        } else if (param === 'strobe') {
          state.projStrobeSigs[projectorKey] += Math.max(0, delta);
          flags |= PF_STROBE;
        }
        state.projFlags[projectorKey] = flags;
      } else {
        if (param === 'intensity') { laserIntFactor *= safetyScaleFactor(amount, env); laserIntMapped = true; }
        else if (param === 'spread') { laserSpreadFactor *= safetyScaleFactor(amount, env); laserSpreadMapped = true; }
        else if (param === 'rotation') { laserRotFactor *= safetyScaleFactor(amount, env); laserRotMapped = true; }
        else if (param === 'speed') { laserSpeedDelta += Math.max(0, delta); laserSpeedMapped = true; }
        else if (param === 'strobe') { laserStrobeSig += Math.max(0, delta); laserStrobeMapped = true; }
      }
    }
  }

  let anyFlashLimited = false;

  // --- Beam (dimmer slew-limited + shared strobe refractory) ---
  out.beam.dimmerMapped = beamDimMapped;
  if (beamDimMapped) {
    const rawBeamDim = clamp01(look.beamIntensity + beamDimDelta);
    const slewed = stepSlewLimiter(state.beamDimmerSlew, rawBeamDim, safeDt, tMs);
    out.beam.dimmer = slewed.value;
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.beamDimmerSlew);
    out.beam.dimmer = look.beamIntensity;
  }
  out.beam.zoomMapped = beamZoomMapped;
  out.beam.zoom = clamp01(look.beamZoom + beamZoomDelta);
  out.beam.colorMixMapped = beamColorMapped;
  out.beam.colorMix = clamp01(beamColorDelta);
  out.beam.speedMapped = beamSpeedMapped;
  out.beam.speed = clamp01(beamLook.movementSpeed + beamSpeedDelta);
  out.beam.tiltMapped = beamTiltMapped;
  out.beam.tiltOffset = clamp(beamTiltDelta, -1, 1) * TILT_OFFSET_SCALE_RAD;
  if (beamStrobeMapped) {
    if (stepStrobeGate(state.beamStrobe, beamStrobeSig, tMs, out.beam.strobe, state)) anyFlashLimited = true;
  } else {
    disarmStrobeGate(state.beamStrobe);
    clearStrobeOut(out.beam.strobe);
  }

  // --- Wash (dimmer slew-limited + shared strobe refractory) ---
  out.wash.dimmerMapped = washDimMapped;
  if (washDimMapped) {
    const rawWashDim = clamp01(look.washIntensity + washDimDelta);
    const slewed = stepSlewLimiter(state.washDimmerSlew, rawWashDim, safeDt, tMs);
    out.wash.dimmer = slewed.value;
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.washDimmerSlew);
    out.wash.dimmer = look.washIntensity;
  }
  out.wash.zoomMapped = washZoomMapped;
  out.wash.zoom = clamp01(look.beamZoom + washZoomDelta);
  out.wash.colorMixMapped = washColorMapped;
  out.wash.colorMix = clamp01(washColorDelta);
  out.wash.speedMapped = washSpeedMapped;
  out.wash.speed = clamp01(washLook.movementSpeed + washSpeedDelta);
  out.wash.tiltMapped = washTiltMapped;
  out.wash.tiltOffset = clamp(washTiltDelta, -1, 1) * TILT_OFFSET_SCALE_RAD;
  if (washStrobeMapped) {
    if (stepStrobeGate(state.washStrobe, washStrobeSig, tMs, out.wash.strobe, state)) anyFlashLimited = true;
  } else {
    disarmStrobeGate(state.washStrobe);
    clearStrobeOut(out.wash.strobe);
  }

  // --- Blinder (with fall-rate flash limiter before master) ---
  out.blinder.mapped = blinderMapped;
  if (blinderMapped) {
    const rawBlinder = clamp01(look.blinderLevel + blinderDelta);
    const slewed = stepSlewLimiter(state.blinderSlew, rawBlinder, safeDt, tMs);
    out.blinder.dimmer = slewed.value;
    out.blinder.limited = slewed.limited;
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.blinderSlew);
    out.blinder.dimmer = look.blinderLevel;
    out.blinder.limited = false;
  }

  // --- Strobe Bars ---
  out.strobeBar.dimmerMapped = strobeDimMapped;
  if (strobeDimMapped) {
    const rawStrobeDim = clamp01(strobeDimDelta);
    const slewed = stepSlewLimiter(state.strobeDimmerSlew, rawStrobeDim, safeDt, tMs);
    out.strobeBar.dimmer = slewed.value;
    out.strobeBar.dimmerLimited = slewed.limited;
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.strobeDimmerSlew);
    out.strobeBar.dimmer = 0;
    out.strobeBar.dimmerLimited = false;
  }
  if (barStrobeMapped) {
    if (stepStrobeGate(state.barStrobe, barStrobeSig, tMs, out.strobeBar.strobe, state)) anyFlashLimited = true;
  } else {
    disarmStrobeGate(state.barStrobe);
    clearStrobeOut(out.strobeBar.strobe);
  }

  // --- LED Wall (brightness slew-limited) ---
  out.ledWall.brightnessMapped = ledBrightMapped;
  if (ledBrightMapped && look.led.enabled) {
    const rawLed = clamp01(look.led.brightness + ledBrightDelta);
    const slewed = stepSlewLimiter(state.ledBrightSlew, rawLed, safeDt, tMs);
    out.ledWall.brightness = slewed.value;
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.ledBrightSlew);
    out.ledWall.brightness = look.led.enabled ? look.led.brightness : 0;
  }
  out.ledWall.speedMapped = ledSpeedMapped;
  out.ledWall.speed = clamp01(look.led.speed + ledSpeedDelta);

  // --- Haze ---
  out.haze.mapped = hazeMapped;
  out.haze.level = clamp01(look.atmo.hazeLevel + hazeDelta);

  // --- Laser (global + optional per-projector; strictly obeys safety ceilings & flash limits) ---
  const baseLaserInt = look.laser.enabled ? clamp01(look.laser.intensity) : 0;
  const baseSpreadX = clamp01(look.laser.spreadX);
  const baseSpreadY = clamp01(look.laser.spreadY);
  const minSpreadX = Math.min(baseSpreadX, LASER_MIN_SPREAD);
  const minSpreadY = Math.min(baseSpreadY, LASER_MIN_SPREAD);
  const baseLaserRot = clamp01(look.laser.rotation);
  const baseLaserSpd = clamp01(look.laser.speed);

  out.laser.intensityMapped = laserIntMapped;
  if (laserIntMapped && look.laser.enabled) {
    const rawLaserInt = clamp(baseLaserInt * laserIntFactor, 0, baseLaserInt);
    const slewed = stepSlewLimiter(state.laserIntSlew, rawLaserInt, safeDt, tMs);
    out.laser.intensity = Math.min(baseLaserInt, slewed.value);
    if (slewed.limited) anyFlashLimited = true;
  } else {
    disarmSlewLimiter(state.laserIntSlew);
    out.laser.intensity = baseLaserInt;
  }
  out.laser.spreadMapped = laserSpreadMapped;
  out.laser.spreadX = laserSpreadMapped ? clamp(baseSpreadX * laserSpreadFactor, minSpreadX, baseSpreadX) : baseSpreadX;
  out.laser.spreadY = laserSpreadMapped ? clamp(baseSpreadY * laserSpreadFactor, minSpreadY, baseSpreadY) : baseSpreadY;
  out.laser.rotationMapped = laserRotMapped;
  out.laser.rotation = laserRotMapped ? clamp(baseLaserRot * laserRotFactor, 0, baseLaserRot) : baseLaserRot;
  out.laser.speedMapped = laserSpeedMapped;
  out.laser.speed = laserSpeedMapped ? clamp(baseLaserSpd + laserSpeedDelta, baseLaserSpd, 1) : baseLaserSpd;
  if (laserStrobeMapped) {
    if (stepStrobeGate(state.laserStrobe, laserStrobeSig, tMs, out.laser.strobe, state)) anyFlashLimited = true;
  } else {
    disarmStrobeGate(state.laserStrobe);
    clearStrobeOut(out.laser.strobe);
  }

  // Per-projector laser overrides (composed on top of global laser modulation, zero-allocation pooled).
  if (state.projKeyCount > 0) {
    for (let pi = 0; pi < state.projKeyCount; pi++) {
      const key = state.projKeys[pi];
      const flags = state.projFlags[key];
      const pv = state.projPool[pi];
      const pIntFactor = state.projIntFactors[key] * laserIntFactor;
      const pSpreadFactor = state.projSpreadFactors[key] * laserSpreadFactor;
      const pRotFactor = state.projRotFactors[key] * laserRotFactor;
      const pSpeedDelta = state.projSpeedDeltas[key] + laserSpeedDelta;

      pv.intensityMapped = (flags & PF_INT) !== 0 || laserIntMapped;
      if (pv.intensityMapped && look.laser.enabled) {
        const rawPInt = clamp(baseLaserInt * pIntFactor, 0, baseLaserInt);
        let pSlew = state.laserProjectorIntSlews[key];
        if (!pSlew) {
          pSlew = createSlewLimiterState();
          state.laserProjectorIntSlews[key] = pSlew;
        }
        const slewed = stepSlewLimiter(pSlew, rawPInt, safeDt, tMs);
        pv.intensity = Math.min(baseLaserInt, slewed.value);
        if (slewed.limited) anyFlashLimited = true;
      } else {
        const existingSlew = state.laserProjectorIntSlews[key];
        if (existingSlew) disarmSlewLimiter(existingSlew);
        pv.intensity = baseLaserInt;
      }

      pv.spreadMapped = (flags & PF_SPREAD) !== 0 || laserSpreadMapped;
      pv.spreadX = pv.spreadMapped ? clamp(baseSpreadX * pSpreadFactor, minSpreadX, baseSpreadX) : baseSpreadX;
      pv.spreadY = pv.spreadMapped ? clamp(baseSpreadY * pSpreadFactor, minSpreadY, baseSpreadY) : baseSpreadY;
      pv.rotationMapped = (flags & PF_ROT) !== 0 || laserRotMapped;
      pv.rotation = pv.rotationMapped ? clamp(baseLaserRot * pRotFactor, 0, baseLaserRot) : baseLaserRot;
      pv.speedMapped = (flags & PF_SPEED) !== 0 || laserSpeedMapped;
      pv.speed = pv.speedMapped ? clamp(baseLaserSpd + pSpeedDelta, baseLaserSpd, 1) : baseLaserSpd;

      if ((flags & PF_STROBE) !== 0) {
        let gate = state.laserProjectorStrobes[key];
        if (!gate) {
          gate = createStrobeGateState();
          state.laserProjectorStrobes[key] = gate;
        }
        if (stepStrobeGate(gate, state.projStrobeSigs[key] + laserStrobeSig, tMs, pv.strobe, state)) anyFlashLimited = true;
      } else {
        const existingGate = state.laserProjectorStrobes[key];
        if (existingGate) disarmStrobeGate(existingGate);
        if (laserStrobeMapped) {
          pv.strobe.mapped = out.laser.strobe.mapped;
          pv.strobe.envelope = out.laser.strobe.envelope;
          pv.strobe.gateOn = out.laser.strobe.gateOn;
          pv.strobe.lastFlashMs = out.laser.strobe.lastFlashMs;
          pv.strobe.limited = out.laser.strobe.limited;
        } else {
          clearStrobeOut(pv.strobe);
        }
      }
      projOut[key] = pv;
      state.prevProjKeys[pi] = key;
    }
    state.prevProjKeyCount = state.projKeyCount;
  } else if (state.prevProjKeyCount > 0) {
    // Disarm any previously active per-projector strobe gates while keeping lastEdgeMs monotonic.
    for (let pi = 0; pi < state.prevProjKeyCount; pi++) {
      const k = state.prevProjKeys[pi];
      const g = state.laserProjectorStrobes[k];
      if (g) disarmStrobeGate(g);
      const sl = state.laserProjectorIntSlews[k];
      if (sl) disarmSlewLimiter(sl);
    }
    state.prevProjKeyCount = 0;
  }

  out.flashLimited = anyFlashLimited;

  // Populate per-entry effective modulated value for UI & `?probe` reporting.
  for (let i = 0; i < count; i++) {
    const entry = out.entries[i];
    if (!entry.enabled) continue;
    const { group, param, projectorKey } = entry;
    if (group === 'beam' || group === 'wash') {
      const g = group === 'beam' ? out.beam : out.wash;
      if (param === 'dimmer') entry.modulatedValue = g.dimmer * master;
      else if (param === 'zoom') entry.modulatedValue = g.zoom;
      else if (param === 'colorMix') entry.modulatedValue = g.colorMix;
      else if (param === 'speed') entry.modulatedValue = g.speed;
      else if (param === 'tilt') entry.modulatedValue = g.tiltOffset;
      else if (param === 'strobe') entry.modulatedValue = g.strobe.gateOn && master > 0 ? 1 : 0;
    } else if (group === 'blinder') {
      entry.modulatedValue = out.blinder.dimmer * master;
    } else if (group === 'strobe') {
      entry.modulatedValue = param === 'strobe'
        ? (out.strobeBar.strobe.gateOn && master > 0 ? 1 : 0)
        : out.strobeBar.dimmer * master;
    } else if (group === 'ledWall') {
      entry.modulatedValue = param === 'brightness'
        ? out.ledWall.brightness * master
        : out.ledWall.speed;
    } else if (group === 'haze') {
      entry.modulatedValue = out.haze.level;
    } else if (group === 'laser') {
      const lv = projectorKey && projOut[projectorKey] ? projOut[projectorKey] : out.laser;
      const strobeMult = lv.strobe.mapped ? (lv.strobe.gateOn ? 1 : 0) : 1;
      if (param === 'intensity') entry.modulatedValue = lv.intensity * master * strobeMult;
      else if (param === 'spread') entry.modulatedValue = lv.spreadX;
      else if (param === 'rotation') entry.modulatedValue = lv.rotation;
      else if (param === 'speed') entry.modulatedValue = lv.speed;
      else if (param === 'strobe') entry.modulatedValue = look.laser.enabled && lv.strobe.gateOn && master > 0 ? 1 : 0;
    }
  }

  return out;
}

export interface ModulateLookResult {
  look: ShowState;
  followers: AudioModulationState;
  frame: AudioModulationFrame;
}

/**
 * Pure functional entry point: computes the modulated ShowState (pre-master channel values so
 * passing it to a renderer never double-applies `masterDimmer`, with `strobeRate = 0` when
 * strobe is audio-mapped so physical/shader strobes never self-oscillate above 3 Hz) and the
 * next follower state without mutating either `look` or `followers`.
 * With no enabled mappings (or `audioReactive === false`), returns the input `look` unchanged.
 */
export function modulateLook(
  look: ShowState,
  metrics: AudioMetrics,
  followers: AudioModulationState = createAudioModulationState(),
  dt = 1 / 60,
): ModulateLookResult {
  const nextFollowers = cloneAudioModulationState(followers);
  const frame = createAudioModulationFrame();
  evaluateAudioModulation(look, metrics, nextFollowers, dt, frame);

  if (!frame.active) {
    return { look, followers: nextFollowers, frame };
  }

  const laserGate = frame.laser.strobe.mapped ? (frame.laser.strobe.gateOn ? 1 : 0) : 1;

  const modulated: ShowState = {
    ...look,
    beamIntensity: frame.beam.dimmerMapped ? frame.beam.dimmer : look.beamIntensity,
    washIntensity: frame.wash.dimmerMapped ? frame.wash.dimmer : look.washIntensity,
    beamZoom: frame.beam.zoomMapped ? frame.beam.zoom : (frame.wash.zoomMapped ? frame.wash.zoom : look.beamZoom),
    movementSpeed: frame.beam.speedMapped ? frame.beam.speed : (frame.wash.speedMapped ? frame.wash.speed : look.movementSpeed),
    blinderLevel: frame.blinder.mapped ? frame.blinder.dimmer : look.blinderLevel,
    // Keep strobeRate = 0 when audio-mapped so the legacy 4–27.5 Hz strobe oscillator never fires;
    // the gated <= 3/s flash state is carried on `frame.strobeBar.strobe.gateOn`.
    strobeRate: frame.strobeBar.strobe.mapped ? 0 : look.strobeRate,
    atmo: frame.haze.mapped
      ? { ...look.atmo, hazeLevel: frame.haze.level }
      : look.atmo,
    led: (frame.ledWall.brightnessMapped || frame.ledWall.speedMapped)
      ? {
          ...look.led,
          brightness: frame.ledWall.brightnessMapped ? frame.ledWall.brightness : look.led.brightness,
          speed: frame.ledWall.speedMapped ? frame.ledWall.speed : look.led.speed,
        }
      : look.led,
    laser: (frame.laser.intensityMapped || frame.laser.spreadMapped || frame.laser.rotationMapped || frame.laser.speedMapped || frame.laser.strobe.mapped)
      ? {
          ...look.laser,
          // Never enable a disabled laser, never enable audienceScan, never exceed look.laser.intensity.
          enabled: look.laser.enabled,
          audienceScan: look.laser.audienceScan,
          intensity: look.laser.enabled
            ? Math.min(look.laser.intensity, frame.laser.intensity * laserGate)
            : 0,
          strobe: frame.laser.strobe.mapped ? 0 : look.laser.strobe,
          spreadX: frame.laser.spreadMapped ? frame.laser.spreadX : look.laser.spreadX,
          spreadY: frame.laser.spreadMapped ? frame.laser.spreadY : look.laser.spreadY,
          rotation: frame.laser.rotationMapped ? frame.laser.rotation : look.laser.rotation,
          speed: frame.laser.speedMapped ? frame.laser.speed : look.laser.speed,
        }
      : look.laser,
  };

  return { look: modulated, followers: nextFollowers, frame };
}

/** Normalize an optional AudioMapConfig so empty mapping arrays omit the key cleanly. */
export function normalizeAudioMap(audioMap?: AudioMapConfig): AudioMapConfig | undefined {
  if (!audioMap || !Array.isArray(audioMap.mappings) || audioMap.mappings.length === 0) return undefined;
  return { mappings: audioMap.mappings.slice(0, MAX_AUDIO_MAPPINGS) };
}
