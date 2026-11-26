export const MAX_CUE_FADE_SECONDS = 3600;
export const MAX_CUE_FADE_MS = MAX_CUE_FADE_SECONDS * 1000;

export interface CueFadeLevels {
  beamIntensity: number;
  washIntensity: number;
}

/** One recorded cue transition. Physical output continues to use the authored destination. */
export interface CueFadeDescriptor {
  durationMs: number;
  from: CueFadeLevels;
  to: CueFadeLevels;
}

export interface ResolvedCuePreview {
  levels: CueFadeLevels;
  target: CueFadeLevels;
  remainingMs: number;
  running: boolean;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

export function cueFadeLevels(look: CueFadeLevels): CueFadeLevels {
  return {
    beamIntensity: clampUnit(look.beamIntensity),
    washIntensity: clampUnit(look.washIntensity),
  };
}

export function makeCueFadeDescriptor(
  from: CueFadeLevels,
  to: CueFadeLevels,
  durationMs: number,
): CueFadeDescriptor {
  return {
    durationMs: Math.max(0, Math.min(MAX_CUE_FADE_MS, Math.round(Number.isFinite(durationMs) ? durationMs : 0))),
    from: cueFadeLevels(from),
    to: cueFadeLevels(to),
  };
}

export function evaluateCueFade(descriptor: CueFadeDescriptor, elapsedMs: number): CueFadeLevels {
  const duration = Math.max(0, descriptor.durationMs);
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : duration);
  const mix = duration <= 0 ? 1 : Math.min(1, elapsed / duration);
  return {
    beamIntensity: descriptor.from.beamIntensity + (descriptor.to.beamIntensity - descriptor.from.beamIntensity) * mix,
    washIntensity: descriptor.from.washIntensity + (descriptor.to.washIntensity - descriptor.from.washIntensity) * mix,
  };
}

export function resolveCuePreview(
  descriptor: CueFadeDescriptor,
  elapsedMs: number,
  running: boolean,
): ResolvedCuePreview | undefined {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : descriptor.durationMs);
  const remainingMs = Math.max(0, descriptor.durationMs - elapsed);
  if (remainingMs <= 0) return undefined;
  return {
    levels: evaluateCueFade(descriptor, elapsed),
    target: cueFadeLevels(descriptor.to),
    remainingMs,
    running,
  };
}
