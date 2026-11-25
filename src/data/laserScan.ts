/**
 * Pure scanner-speed & refresh-rate calculations for galvo laser projectors.
 * Used for ILDA playback flicker simulation and UI warnings.
 */

export const LASER_FLICKER_THRESHOLD_HZ = 30;
export const DEFAULT_SCAN_SPEED_KPPS = 30;

export interface LaserScanMetrics {
  /** Published or default scanner speed in thousands of points per second (kpps @ 8°). */
  readonly scanSpeedKpps: number;
  /** Total points scanned per refresh cycle (lit + blanked). */
  readonly framePoints: number;
  /** Effective optical refresh rate (Hz) = kpps * 1000 / max(1, framePoints). */
  readonly refreshHz: number;
  /** True when the frame point count exceeds the scanner's 30 Hz flicker-free ceiling. */
  readonly flickering: boolean;
  /** Short warning banner text when flickering, or null when flicker-free. */
  readonly warning: string | null;
}

/** Allocation-free refresh-rate calculation for the 60 Hz render loop. */
export function laserRefreshHz(scanSpeedKpps: number | undefined, framePoints: number): number {
  const kpps = Number.isFinite(scanSpeedKpps) && (scanSpeedKpps ?? 0) > 0 ? scanSpeedKpps! : DEFAULT_SCAN_SPEED_KPPS;
  const pts = Math.max(1, Math.floor(Number.isFinite(framePoints) ? framePoints : 1));
  return (kpps * 1000) / pts;
}

/**
 * Compute effective laser frame refresh rate and flicker status from scanner kpps and frame point count.
 */
export function evaluateLaserScan(scanSpeedKpps: number | undefined, framePoints: number): LaserScanMetrics {
  const kpps = Number.isFinite(scanSpeedKpps) && (scanSpeedKpps ?? 0) > 0 ? scanSpeedKpps! : DEFAULT_SCAN_SPEED_KPPS;
  const pts = Math.max(1, Math.floor(Number.isFinite(framePoints) ? framePoints : 1));
  const refreshHz = (kpps * 1000) / pts;
  const flickering = refreshHz < LASER_FLICKER_THRESHOLD_HZ;
  return {
    scanSpeedKpps: kpps,
    framePoints: pts,
    refreshHz,
    flickering,
    warning: flickering
      ? `Flicker ~${Math.max(1, Math.round(refreshHz))} Hz: ${pts} pts exceeds ${kpps} kpps scan rate`
      : null,
  };
}

/**
 * Modulate preview intensity when a projector is flickering (< 30 Hz optical refresh).
 * Returns a multiplier in [0.45, 1.0]; returns 1.0 when refreshHz >= 30 Hz.
 * When `flashLimited` is true (default preview safety), returns the constant time-average
 * `1 - 0.275 * severity` so low-kpps ILDA shimmer does not strobe above 3 Hz while keeping
 * `evaluateLaserScan()` diagnostic refresh-rate warnings unchanged.
 */
export function flickerIntensityMultiplier(refreshHz: number, timeSec: number, flashLimited = false): number {
  if (!Number.isFinite(refreshHz) || refreshHz >= LASER_FLICKER_THRESHOLD_HZ) return 1.0;
  const hz = Math.max(2, refreshHz);
  // Subtle visible scan-rate shimmer proportional to how far below 30 Hz we are.
  const severity = Math.min(1, (LASER_FLICKER_THRESHOLD_HZ - hz) / LASER_FLICKER_THRESHOLD_HZ);
  if (flashLimited) return 1.0 - severity * 0.275;
  const wave = 0.5 + 0.5 * Math.sin(timeSec * hz * Math.PI * 2);
  return 1.0 - severity * 0.55 * (1.0 - wave);
}
