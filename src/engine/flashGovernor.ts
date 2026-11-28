/**
 * Sprint 24 unified zero-allocation flash governor (scalar & linear emitted RGB).
 *
 * Enforces <= 3 general and <= 3 saturated-red flashes in ANY rolling 1,000 ms window
 * (matching `analyzeRollingFlashRate` in `renderProbe.ts`), including:
 * - multi-frame 60/120 Hz sawtooth & staircase ramps (Codex review-06 R2),
 * - variable-width long pulses + short gaps (reserving reversal capacity for an immediate fall/blackout),
 * - plateau-then-small-step-then-jump sequences,
 * - opposing RGB & sub-threshold saturated-red oscillations (Codex review-06 R4),
 * - late fixture/rig-rebuild initialization during an active refractory window,
 * while keeping emergency blackout / pure downward dimming 100% immediate.
 */

/** Sliding reversal-window length (ms), matching `analyzeRollingFlashRate`'s `< 1000 ms` half-open window. */
export const FLASH_ROLLING_WINDOW_MS = 1000;
const WINDOW_EVICT_MS = FLASH_ROLLING_WINDOW_MS - 1e-6;

/**
 * Maximum opposing reversals permitted inside the active 1,000 ms window BEFORE admitting a new
 * rising/opposing transition: admitting adds +1 reversal now (<= 5) and reserves +1 slot for a
 * potential immediate subsequent blackout/fall (<= 6 reversals -> ceil(6 / 2) = 3 flashes/s).
 */
export const MAX_REVERSALS_BEFORE_ADMIT = 4;

/** Excursion threshold in linear [0, 1] space (strictly below WCAG 0.10 luminance step & <= 5 DMX counts). */
export const DEFAULT_SCALAR_EXCURSION = 0.02;

/** Saturated-red ratio & metric thresholds (strictly tighter than WCAG's 0.80 ratio and >20 metric). */
export const DEFAULT_RED_RATIO_THRESHOLD = 0.65;
export const DEFAULT_RED_METRIC_THRESHOLD = 8;

const REV_CAP = 16;

function pruneTimestamps(buf: Float64Array, count: number, nowMs: number): number {
  let drop = 0;
  while (drop < count && nowMs - buf[drop] >= WINDOW_EVICT_MS) {
    drop++;
  }
  if (drop === 0) return count;
  const rem = count - drop;
  for (let i = 0; i < rem; i++) {
    buf[i] = buf[i + drop];
  }
  return rem;
}

function pushTimestamp(buf: Float64Array, count: number, tMs: number): number {
  if (count < buf.length) {
    buf[count] = tMs;
    return count + 1;
  }
  for (let i = 1; i < buf.length; i++) {
    buf[i - 1] = buf[i];
  }
  buf[buf.length - 1] = tMs;
  return buf.length;
}

export interface FlashBudgetClock {
  clockMs: number;
  minSpacingMs: number;
  holdMs: number;
  lastAdmittedRiseMs: number;
  lastDir: -1 | 0 | 1;
  lastDirMs: number;
  revTimes: Float64Array;
  revCount: number;
}

export function createFlashBudgetClock(minSpacingMs: number, holdMs = 650): FlashBudgetClock {
  return {
    clockMs: 0,
    minSpacingMs,
    holdMs,
    lastAdmittedRiseMs: -Infinity,
    lastDir: 0,
    lastDirMs: -Infinity,
    revTimes: new Float64Array(REV_CAP),
    revCount: 0,
  };
}

export function cloneFlashBudgetClock(src: FlashBudgetClock): FlashBudgetClock {
  const copy = createFlashBudgetClock(src.minSpacingMs, src.holdMs);
  copy.clockMs = src.clockMs;
  copy.lastAdmittedRiseMs = src.lastAdmittedRiseMs;
  copy.lastDir = src.lastDir;
  copy.lastDirMs = src.lastDirMs;
  copy.revCount = src.revCount;
  copy.revTimes.set(src.revTimes);
  return copy;
}

/** True when the shared room clock can admit a rising/opposing flash transition at `tMs`. */
export function canAdmitFlashRise(clock: FlashBudgetClock, tMs: number): boolean {
  // Synchronized multi-fixture hits on the exact same frame count as one room flash.
  if (tMs === clock.lastAdmittedRiseMs) return true;
  if (tMs - clock.lastAdmittedRiseMs < clock.minSpacingMs) return false;
  clock.revCount = pruneTimestamps(clock.revTimes, clock.revCount, tMs);
  if (clock.lastDir === -1 && clock.revCount > MAX_REVERSALS_BEFORE_ADMIT) {
    return false;
  }
  return true;
}

/** Record an admitted rising/opposing room transition at `tMs` (deduped within the same frame). */
export function recordFlashRise(clock: FlashBudgetClock, tMs: number): void {
  if (tMs === clock.lastAdmittedRiseMs) return;
  clock.revCount = pruneTimestamps(clock.revTimes, clock.revCount, tMs);
  if (clock.lastDir === -1) {
    clock.revCount = pushTimestamp(clock.revTimes, clock.revCount, tMs);
  }
  clock.lastDir = 1;
  clock.lastDirMs = tMs;
  clock.lastAdmittedRiseMs = tMs;
}

/** Record a downward room transition at `tMs` (deduped against consecutive falls). */
export function recordFlashFall(clock: FlashBudgetClock, tMs: number): void {
  if (tMs === clock.lastAdmittedRiseMs) {
    // Another group rose earlier on this exact frame; keep the rising state for this frame.
    return;
  }
  clock.revCount = pruneTimestamps(clock.revTimes, clock.revCount, tMs);
  if (clock.lastDir === 1) {
    clock.revCount = pushTimestamp(clock.revTimes, clock.revCount, tMs);
  }
  clock.lastDir = -1;
  clock.lastDirMs = tMs;
}

export interface ScalarGovernorState {
  initialized: boolean;
  delivered: number;
  anchor: number;
  peak: number;
  edgeStep: number;
  lastDir: -1 | 0 | 1;
  lastRiseMs: number;
  limitedUntilMs: number;
  revTimes: Float64Array;
  revCount: number;
}

export function createScalarGovernorState(): ScalarGovernorState {
  return {
    initialized: false,
    delivered: 0,
    anchor: 0,
    peak: 0,
    edgeStep: 0,
    lastDir: 0,
    lastRiseMs: -Infinity,
    limitedUntilMs: -Infinity,
    revTimes: new Float64Array(REV_CAP),
    revCount: 0,
  };
}

export function cloneScalarGovernorState(src: ScalarGovernorState): ScalarGovernorState {
  const copy = createScalarGovernorState();
  return copyScalarGovernorState(copy, src);
}

export function copyScalarGovernorState(copy: ScalarGovernorState, src: ScalarGovernorState): ScalarGovernorState {
  copy.initialized = src.initialized;
  copy.delivered = src.delivered;
  copy.anchor = src.anchor;
  copy.peak = src.peak;
  copy.edgeStep = src.edgeStep;
  copy.lastDir = src.lastDir;
  copy.lastRiseMs = src.lastRiseMs;
  copy.limitedUntilMs = src.limitedUntilMs;
  copy.revCount = src.revCount;
  copy.revTimes.set(src.revTimes);
  return copy;
}

export interface ScalarStepResult {
  value: number;
  limited: boolean;
}

const SCALAR_SCRATCH: ScalarStepResult = { value: 0, limited: false };

/**
 * Advance one scalar channel with exact excursion + rolling 1,000 ms reversal accounting.
 * - `blackout`: always drops to `0` immediately and records darkness.
 * - `instantFall = true`: downward moves apply immediately; upward reversals check spacing + reversal budget.
 * - `instantFall = false`: both upward and downward excursions check spacing + reversal budget (e.g. symmetric beat pulses).
 */
export function stepGovernedScalar(
  ch: ScalarGovernorState,
  sharedClock: FlashBudgetClock | null,
  tMs: number,
  desired: number,
  blackout: boolean,
  instantFall = true,
  threshold = DEFAULT_SCALAR_EXCURSION,
  minSpacingFallbackMs = 334,
  out: ScalarStepResult = SCALAR_SCRATCH,
  observeDelivered = false,
): ScalarStepResult {
  const safeDesired = Number.isFinite(desired) ? Math.max(0, desired) : 0;
  const minSpacing = sharedClock ? sharedClock.minSpacingMs : minSpacingFallbackMs;
  const holdMs = sharedClock ? sharedClock.holdMs : 650;

  if (blackout) {
    if (ch.initialized) {
      if (ch.anchor >= threshold || ch.delivered >= threshold) {
        ch.revCount = pruneTimestamps(ch.revTimes, ch.revCount, tMs);
        if (ch.lastDir === 1) {
          ch.revCount = pushTimestamp(ch.revTimes, ch.revCount, tMs);
          if (sharedClock) recordFlashFall(sharedClock, tMs);
        }
        ch.lastDir = -1;
      }
      ch.delivered = 0;
      ch.anchor = 0;
    } else {
      ch.initialized = true;
      ch.delivered = 0;
      ch.anchor = 0;
      ch.peak = 0;
      ch.edgeStep = 0;
      ch.lastDir = 0;
    }
    out.value = 0;
    out.limited = false;
    return out;
  }

  if (!ch.initialized) {
    ch.initialized = true;
    // Late initialization mid-session (e.g., rig rebuild while strobing): do not bypass active refractory!
    if (
      sharedClock &&
      sharedClock.clockMs > 0 &&
      sharedClock.lastAdmittedRiseMs > -Infinity &&
      safeDesired >= threshold &&
      !canAdmitFlashRise(sharedClock, tMs)
    ) {
      ch.delivered = 0;
      ch.anchor = 0;
      ch.peak = 0;
      ch.edgeStep = 0;
      ch.lastDir = -1;
      ch.limitedUntilMs = Math.max(ch.limitedUntilMs, tMs + holdMs);
      out.value = 0;
      out.limited = true;
      return out;
    }
    ch.delivered = safeDesired;
    ch.anchor = safeDesired;
    ch.peak = safeDesired;
    ch.edgeStep = safeDesired;
    ch.lastDir = 0;
    out.value = safeDesired;
    out.limited = false;
    return out;
  }

  const deltaFromDelivered = safeDesired - ch.delivered;
  if (Math.abs(deltaFromDelivered) <= 1e-6) {
    out.value = safeDesired;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  // Downward move
  if (deltaFromDelivered < 0) {
    if (instantFall) {
      ch.delivered = safeDesired;
      if (ch.anchor - safeDesired >= threshold) {
        ch.revCount = pruneTimestamps(ch.revTimes, ch.revCount, tMs);
        if (ch.lastDir === 1) {
          ch.revCount = pushTimestamp(ch.revTimes, ch.revCount, tMs);
          if (sharedClock) recordFlashFall(sharedClock, tMs);
        }
        ch.lastDir = -1;
        ch.anchor = safeDesired;
      } else if (ch.lastDir === -1 && safeDesired < ch.anchor) {
        ch.anchor = safeDesired;
      }
      out.value = safeDesired;
      out.limited = tMs < ch.limitedUntilMs;
      return out;
    }

    // Symmetric channel (`instantFall = false`, e.g. beatPulse / LED audio): gate steep drops too.
    if (ch.lastDir === -1 && safeDesired <= ch.anchor + threshold) {
      ch.delivered = safeDesired;
      if (safeDesired < ch.anchor) ch.anchor = safeDesired;
      if (ch.edgeStep - safeDesired >= threshold) {
        ch.lastRiseMs = tMs;
        ch.edgeStep = safeDesired;
      }
      out.value = safeDesired;
      out.limited = tMs < ch.limitedUntilMs;
      return out;
    }
    if (ch.anchor - safeDesired < threshold) {
      ch.delivered = safeDesired;
      out.value = safeDesired;
      out.limited = tMs < ch.limitedUntilMs;
      return out;
    }
    ch.revCount = pruneTimestamps(ch.revTimes, ch.revCount, tMs);
    const localFallOk = tMs - ch.lastRiseMs >= minSpacing && (ch.lastDir !== 1 || ch.revCount <= MAX_REVERSALS_BEFORE_ADMIT);
    const globalFallOk = sharedClock ? canAdmitFlashRise(sharedClock, tMs) : true;
    if (localFallOk && globalFallOk) {
      if (ch.lastDir === 1) {
        ch.revCount = pushTimestamp(ch.revTimes, ch.revCount, tMs);
        if (sharedClock) recordFlashFall(sharedClock, tMs);
      }
      ch.lastDir = -1;
      ch.lastRiseMs = tMs;
      ch.delivered = safeDesired;
      ch.anchor = safeDesired;
      ch.edgeStep = safeDesired;
      out.value = safeDesired;
      out.limited = tMs < ch.limitedUntilMs;
      return out;
    }
    ch.limitedUntilMs = Math.max(ch.limitedUntilMs, tMs + holdMs);
    out.value = ch.delivered;
    out.limited = true;
    return out;
  }

  // Upward move (`safeDesired > ch.delivered`)
  if (ch.lastDir === 1 && safeDesired >= ch.peak - threshold) {
    // Monotonic upward continuation of an already-admitted rise (smooth fade / ramp).
    ch.delivered = safeDesired;
    if (safeDesired > ch.peak) ch.peak = safeDesired;
    if (safeDesired > ch.anchor) ch.anchor = safeDesired;
    if (safeDesired - ch.edgeStep >= threshold) {
      ch.lastRiseMs = tMs;
      ch.edgeStep = safeDesired;
    }
    out.value = safeDesired;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  if (safeDesired - ch.anchor < threshold) {
    // Sub-threshold upward drift (< threshold above trough anchor); anchor stays pinned at trough!
    ch.delivered = safeDesired;
    out.value = safeDesired;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  // Significant rise from trough (`safeDesired - ch.anchor >= threshold`)
  ch.revCount = pruneTimestamps(ch.revTimes, ch.revCount, tMs);
  const localOk =
    tMs - ch.lastRiseMs >= minSpacing &&
    (ch.lastDir !== -1 || ch.revCount <= MAX_REVERSALS_BEFORE_ADMIT);
  const globalOk = sharedClock ? canAdmitFlashRise(sharedClock, tMs) : true;

  if (observeDelivered || (localOk && globalOk)) {
    if (ch.lastDir === -1) {
      ch.revCount = pushTimestamp(ch.revTimes, ch.revCount, tMs);
    }
    if (sharedClock) recordFlashRise(sharedClock, tMs);
    ch.lastDir = 1;
    ch.lastRiseMs = tMs;
    ch.delivered = safeDesired;
    ch.anchor = safeDesired;
    ch.peak = safeDesired;
    ch.edgeStep = safeDesired;
    out.value = safeDesired;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  // Suppress rise inside refractory / rolling reversal ceiling: hold below `anchor + threshold`.
  ch.limitedUntilMs = Math.max(ch.limitedUntilMs, tMs + holdMs);
  out.value = ch.delivered;
  out.limited = true;
  return out;
}

/** Account for a value already delivered by another path without applying a second clamp. */
export function observeScalarDelivery(ch: ScalarGovernorState, clock: FlashBudgetClock | null, tMs: number, delivered: number): void {
  stepGovernedScalar(ch, clock, tMs, delivered, false, true, DEFAULT_SCALAR_EXCURSION, undefined, SCALAR_SCRATCH, true);
}

/** Check both the local and room refractory before handing a lens back to passthrough. */
export function canReleaseScalarHandoff(ch: ScalarGovernorState, clock: FlashBudgetClock, tMs: number): boolean {
  ch.revCount = pruneTimestamps(ch.revTimes, ch.revCount, tMs);
  return tMs >= ch.limitedUntilMs && tMs - ch.lastRiseMs >= clock.minSpacingMs &&
    tMs - clock.lastAdmittedRiseMs >= clock.minSpacingMs &&
    (ch.lastDir !== -1 || ch.revCount <= MAX_REVERSALS_BEFORE_ADMIT) && canAdmitFlashRise(clock, tMs);
}

export interface RgbGovernorState {
  initialized: boolean;
  r: number;
  g: number;
  b: number;
  genAnchorR: number;
  genAnchorG: number;
  genAnchorB: number;
  genAnchorY: number;
  peakR: number;
  peakG: number;
  peakB: number;
  stepR: number;
  stepG: number;
  stepB: number;
  genLastDir: -1 | 0 | 1;
  redAnchorRatio: number;
  redAnchorMetric: number;
  peakRedMetric: number;
  stepRedMetric: number;
  redLastDir: -1 | 0 | 1;
  lastRiseMs: number;
  limitedUntilMs: number;
  genRevTimes: Float64Array;
  genRevCount: number;
  redRevTimes: Float64Array;
  redRevCount: number;
}

export function createRgbGovernorState(): RgbGovernorState {
  return {
    initialized: false,
    r: 0,
    g: 0,
    b: 0,
    genAnchorR: 0,
    genAnchorG: 0,
    genAnchorB: 0,
    genAnchorY: 0,
    peakR: 0,
    peakG: 0,
    peakB: 0,
    stepR: 0,
    stepG: 0,
    stepB: 0,
    genLastDir: 0,
    redAnchorRatio: 0,
    redAnchorMetric: 0,
    peakRedMetric: 0,
    stepRedMetric: 0,
    redLastDir: 0,
    lastRiseMs: -Infinity,
    limitedUntilMs: -Infinity,
    genRevTimes: new Float64Array(REV_CAP),
    genRevCount: 0,
    redRevTimes: new Float64Array(REV_CAP),
    redRevCount: 0,
  };
}

export function cloneRgbGovernorState(src: RgbGovernorState): RgbGovernorState {
  const copy = createRgbGovernorState();
  copy.initialized = src.initialized;
  copy.r = src.r;
  copy.g = src.g;
  copy.b = src.b;
  copy.genAnchorR = src.genAnchorR;
  copy.genAnchorG = src.genAnchorG;
  copy.genAnchorB = src.genAnchorB;
  copy.genAnchorY = src.genAnchorY;
  copy.peakR = src.peakR;
  copy.peakG = src.peakG;
  copy.peakB = src.peakB;
  copy.stepR = src.stepR;
  copy.stepG = src.stepG;
  copy.stepB = src.stepB;
  copy.genLastDir = src.genLastDir;
  copy.redAnchorRatio = src.redAnchorRatio;
  copy.redAnchorMetric = src.redAnchorMetric;
  copy.peakRedMetric = src.peakRedMetric;
  copy.stepRedMetric = src.stepRedMetric;
  copy.redLastDir = src.redLastDir;
  copy.lastRiseMs = src.lastRiseMs;
  copy.limitedUntilMs = src.limitedUntilMs;
  copy.genRevCount = src.genRevCount;
  copy.genRevTimes.set(src.genRevTimes);
  copy.redRevCount = src.redRevCount;
  copy.redRevTimes.set(src.redRevTimes);
  return copy;
}

export interface RgbStepResult {
  r: number;
  g: number;
  b: number;
  limited: boolean;
}

const RGB_SCRATCH: RgbStepResult = { r: 0, g: 0, b: 0, limited: false };

function sanitizeNonNeg(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Govern linear emitted RGB `(r, g, b)` together across luminance, per-component, and WCAG
 * saturated-red metrics (`R/(R+G+B)` & `(R-G-B)*320`), enforcing <= 3 general and <= 3 red flashes/s.
 * Pure downward dimming toward black always acts immediately; any rising component or opposing
 * colour swap respects spacing and both rolling 1,000 ms reversal budgets.
 */
export function stepGovernedRgb(
  ch: RgbGovernorState,
  sharedClock: FlashBudgetClock | null,
  tMs: number,
  rawR: number,
  rawG: number,
  rawB: number,
  blackout: boolean,
  threshold = DEFAULT_SCALAR_EXCURSION,
  redRatioThreshold = DEFAULT_RED_RATIO_THRESHOLD,
  redMetricThreshold = DEFAULT_RED_METRIC_THRESHOLD,
  minSpacingFallbackMs = 334,
  out: RgbStepResult = RGB_SCRATCH,
): RgbStepResult {
  const dr = sanitizeNonNeg(rawR);
  const dg = sanitizeNonNeg(rawG);
  const db = sanitizeNonNeg(rawB);
  const minSpacing = sharedClock ? sharedClock.minSpacingMs : minSpacingFallbackMs;
  const holdMs = sharedClock ? sharedClock.holdMs : 650;

  if (blackout) {
    if (ch.initialized) {
      if (
        ch.genAnchorY >= threshold ||
        Math.max(ch.genAnchorR, ch.genAnchorG, ch.genAnchorB) >= threshold
      ) {
        ch.genRevCount = pruneTimestamps(ch.genRevTimes, ch.genRevCount, tMs);
        if (ch.genLastDir === 1) {
          ch.genRevCount = pushTimestamp(ch.genRevTimes, ch.genRevCount, tMs);
          if (sharedClock) recordFlashFall(sharedClock, tMs);
        }
        ch.genLastDir = -1;
      }
      if (ch.redAnchorRatio >= redRatioThreshold && ch.redAnchorMetric >= redMetricThreshold) {
        ch.redRevCount = pruneTimestamps(ch.redRevTimes, ch.redRevCount, tMs);
        if (ch.redLastDir === 1) {
          ch.redRevCount = pushTimestamp(ch.redRevTimes, ch.redRevCount, tMs);
        }
        ch.redLastDir = -1;
      }
      ch.r = 0;
      ch.g = 0;
      ch.b = 0;
      ch.genAnchorR = 0;
      ch.genAnchorG = 0;
      ch.genAnchorB = 0;
      ch.genAnchorY = 0;
      ch.redAnchorRatio = 0;
      ch.redAnchorMetric = 0;
    } else {
      ch.initialized = true;
      ch.r = 0;
      ch.g = 0;
      ch.b = 0;
    }
    out.r = 0;
    out.g = 0;
    out.b = 0;
    out.limited = false;
    return out;
  }

  const dy = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
  const dSum = dr + dg + db;
  const dRedRatio = dSum > 1e-6 ? dr / dSum : 0;
  const dRedMetric = Math.max(0, (dr - dg - db) * 320);

  if (!ch.initialized) {
    ch.initialized = true;
    const nonZeroInit = dy >= threshold || Math.max(dr, dg, db) >= threshold;
    if (
      sharedClock &&
      sharedClock.clockMs > 0 &&
      sharedClock.lastAdmittedRiseMs > -Infinity &&
      nonZeroInit &&
      !canAdmitFlashRise(sharedClock, tMs)
    ) {
      ch.r = 0;
      ch.g = 0;
      ch.b = 0;
      ch.genLastDir = -1;
      ch.redLastDir = dRedRatio >= redRatioThreshold && dRedMetric >= redMetricThreshold ? -1 : 0;
      ch.limitedUntilMs = Math.max(ch.limitedUntilMs, tMs + holdMs);
      out.r = 0;
      out.g = 0;
      out.b = 0;
      out.limited = true;
      return out;
    }
    ch.r = dr;
    ch.g = dg;
    ch.b = db;
    ch.genAnchorR = dr;
    ch.genAnchorG = dg;
    ch.genAnchorB = db;
    ch.genAnchorY = dy;
    ch.peakR = dr;
    ch.peakG = dg;
    ch.peakB = db;
    ch.stepR = dr;
    ch.stepG = dg;
    ch.stepB = db;
    ch.genLastDir = 0;
    ch.redAnchorRatio = dRedRatio;
    ch.redAnchorMetric = dRedMetric;
    ch.peakRedMetric = dRedMetric;
    ch.stepRedMetric = dRedMetric;
    ch.redLastDir = 0;
    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = false;
    return out;
  }

  if (
    Math.abs(dr - ch.r) <= 1e-6 &&
    Math.abs(dg - ch.g) <= 1e-6 &&
    Math.abs(db - ch.b) <= 1e-6
  ) {
    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  const redEligible = dRedRatio >= redRatioThreshold || ch.redAnchorRatio >= redRatioThreshold;
  const redDelta = dRedMetric - ch.redAnchorMetric;

  // Pure downward dimming toward black: every channel decreasing/flat AND saturated red not rising.
  const isPureDownward =
    dr <= ch.r + 1e-5 &&
    dg <= ch.g + 1e-5 &&
    db <= ch.b + 1e-5 &&
    !(redEligible && redDelta >= redMetricThreshold);

  if (isPureDownward) {
    ch.r = dr;
    ch.g = dg;
    ch.b = db;
    if (
      ch.genAnchorY - dy >= threshold ||
      Math.max(ch.genAnchorR - dr, ch.genAnchorG - dg, ch.genAnchorB - db) >= threshold
    ) {
      ch.genRevCount = pruneTimestamps(ch.genRevTimes, ch.genRevCount, tMs);
      if (ch.genLastDir === 1) {
        ch.genRevCount = pushTimestamp(ch.genRevTimes, ch.genRevCount, tMs);
        if (sharedClock) recordFlashFall(sharedClock, tMs);
      }
      ch.genLastDir = -1;
      ch.genAnchorR = dr;
      ch.genAnchorG = dg;
      ch.genAnchorB = db;
      ch.genAnchorY = dy;
    } else if (ch.genLastDir === -1) {
      if (dr < ch.genAnchorR) ch.genAnchorR = dr;
      if (dg < ch.genAnchorG) ch.genAnchorG = dg;
      if (db < ch.genAnchorB) ch.genAnchorB = db;
      if (dy < ch.genAnchorY) ch.genAnchorY = dy;
    }

    if (redEligible && ch.redAnchorMetric - dRedMetric >= redMetricThreshold) {
      ch.redRevCount = pruneTimestamps(ch.redRevTimes, ch.redRevCount, tMs);
      if (ch.redLastDir === 1) {
        ch.redRevCount = pushTimestamp(ch.redRevTimes, ch.redRevCount, tMs);
      }
      ch.redLastDir = -1;
      ch.redAnchorRatio = dRedRatio;
      ch.redAnchorMetric = dRedMetric;
    } else if (ch.redLastDir === -1 && dRedMetric < ch.redAnchorMetric) {
      ch.redAnchorRatio = dRedRatio;
      ch.redAnchorMetric = dRedMetric;
    }

    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  const genExcursion =
    Math.abs(dy - ch.genAnchorY) >= threshold ||
    Math.max(
      Math.abs(dr - ch.genAnchorR),
      Math.abs(dg - ch.genAnchorG),
      Math.abs(db - ch.genAnchorB),
    ) >= threshold;
  const redExcursion = redEligible && Math.abs(redDelta) >= redMetricThreshold;

  if (!genExcursion && !redExcursion) {
    // Sub-threshold micro-adjustment; keep anchors pinned so cumulative drift hits excursion.
    ch.r = dr;
    ch.g = dg;
    ch.b = db;
    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  // Monotonic upward continuation in the same colour direction (no component fell below peak - threshold).
  const redContinuesUp =
    !redExcursion ||
    (redDelta > 0 && ch.redLastDir === 1 && dRedMetric >= ch.peakRedMetric - redMetricThreshold);
  const isMonotonicUp =
    ch.genLastDir === 1 &&
    dr >= ch.peakR - threshold &&
    dg >= ch.peakG - threshold &&
    db >= ch.peakB - threshold &&
    redContinuesUp;

  if (isMonotonicUp) {
    ch.r = dr;
    ch.g = dg;
    ch.b = db;
    if (dr > ch.peakR) ch.peakR = dr;
    if (dg > ch.peakG) ch.peakG = dg;
    if (db > ch.peakB) ch.peakB = db;
    ch.genAnchorR = Math.max(ch.genAnchorR, dr);
    ch.genAnchorG = Math.max(ch.genAnchorG, dg);
    ch.genAnchorB = Math.max(ch.genAnchorB, db);
    ch.genAnchorY = Math.max(ch.genAnchorY, dy);
    if (redExcursion && redDelta > 0) {
      ch.redAnchorRatio = dRedRatio;
      ch.redAnchorMetric = dRedMetric;
      if (dRedMetric > ch.peakRedMetric) ch.peakRedMetric = dRedMetric;
    }
    if (
      Math.max(dr - ch.stepR, dg - ch.stepG, db - ch.stepB) >= threshold ||
      (redExcursion && dRedMetric - ch.stepRedMetric >= redMetricThreshold)
    ) {
      ch.lastRiseMs = tMs;
      ch.stepR = dr;
      ch.stepG = dg;
      ch.stepB = db;
      ch.stepRedMetric = dRedMetric;
    }
    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  // New rise from trough OR opposing colour / saturated-red swap: enforce spacing + both 1,000 ms reversal rings.
  ch.genRevCount = pruneTimestamps(ch.genRevTimes, ch.genRevCount, tMs);
  ch.redRevCount = pruneTimestamps(ch.redRevTimes, ch.redRevCount, tMs);

  const spacingOk = tMs - ch.lastRiseMs >= minSpacing;
  const genBudgetOk = !genExcursion || ch.genLastDir === 0 || ch.genRevCount <= MAX_REVERSALS_BEFORE_ADMIT;
  const redBudgetOk = !redExcursion || ch.redLastDir === 0 || ch.redRevCount <= MAX_REVERSALS_BEFORE_ADMIT;
  const globalOk = sharedClock ? canAdmitFlashRise(sharedClock, tMs) : true;

  if (spacingOk && genBudgetOk && redBudgetOk && globalOk) {
    if (genExcursion) {
      if (ch.genLastDir !== 0) {
        ch.genRevCount = pushTimestamp(ch.genRevTimes, ch.genRevCount, tMs);
      }
      // Because `isPureDownward` was false, at least one channel rose or swapped to an active state;
      // marking `genLastDir = 1` ensures any subsequent drop to black is also counted as a reversal.
      ch.genLastDir = 1;
      ch.genAnchorR = dr;
      ch.genAnchorG = dg;
      ch.genAnchorB = db;
      ch.genAnchorY = dy;
      ch.peakR = dr;
      ch.peakG = dg;
      ch.peakB = db;
      ch.stepR = dr;
      ch.stepG = dg;
      ch.stepB = db;
    }
    if (redExcursion) {
      const nextRedDir: -1 | 1 = redDelta >= 0 ? 1 : -1;
      if (ch.redLastDir !== 0 && ch.redLastDir !== nextRedDir) {
        ch.redRevCount = pushTimestamp(ch.redRevTimes, ch.redRevCount, tMs);
      }
      ch.redLastDir = nextRedDir;
      ch.redAnchorRatio = dRedRatio;
      ch.redAnchorMetric = dRedMetric;
      ch.peakRedMetric = dRedMetric;
      ch.stepRedMetric = dRedMetric;
    }
    ch.lastRiseMs = tMs;
    if (sharedClock) recordFlashRise(sharedClock, tMs);
    ch.r = dr;
    ch.g = dg;
    ch.b = db;
    out.r = dr;
    out.g = dg;
    out.b = db;
    out.limited = tMs < ch.limitedUntilMs;
    return out;
  }

  ch.limitedUntilMs = Math.max(ch.limitedUntilMs, tMs + holdMs);
  out.r = ch.r;
  out.g = ch.g;
  out.b = ch.b;
  out.limited = true;
  return out;
}

/**
 * Factorize a governed emitted RGB vector `(er, eg, eb)` into `(dimmer, r, g, b)` in `[0, 1]`
 * such that `dimmer * (r, g, b) === (er, eg, eb)` without RGB > 1 or double-multiplying dimmer.
 * Used for RGB 3-Ch (`E = dim * C`) and 5-Ch (`[D, Cr, Cg, Cb, 0]`) physical DMX personalities.
 */
export interface FactorizedEmission {
  dimmer: number;
  r: number;
  g: number;
  b: number;
}

export function factorizeEmittedRgb(
  er: number,
  eg: number,
  eb: number,
  out: FactorizedEmission,
): FactorizedEmission {
  const cr = Math.max(0, Math.min(1, Number.isFinite(er) ? er : 0));
  const cg = Math.max(0, Math.min(1, Number.isFinite(eg) ? eg : 0));
  const cb = Math.max(0, Math.min(1, Number.isFinite(eb) ? eb : 0));
  const d = Math.max(cr, cg, cb);
  if (d <= 1e-6) {
    out.dimmer = 0;
    out.r = 0;
    out.g = 0;
    out.b = 0;
    return out;
  }
  out.dimmer = d;
  out.r = cr / d;
  out.g = cg / d;
  out.b = cb / d;
  return out;
}
