import type { BeamProfile, FixtureOptics } from '../types/show';

export type MovingHeadKind = 'beam' | 'wash';

// Output lumens at the named zoom endpoint. See the manufacturer's sheet
// in docs/stage-design.md. These references do not change the patch.
export const REFERENCE_OPTICS: BeamProfile[] = [
  { source: 'datasheet', manufacturer: 'CHAUVET Professional', fixture: 'Rogue R1 BeamWash', geometry: 'Narrow',
    lumens: 1483, beamAngle: 4 },
  { source: 'datasheet', manufacturer: 'Martin', fixture: 'MAC Aura XIP', geometry: 'Wide',
    lumens: 6000, beamAngle: 35.3 },
];

// Generic preview references. The legacy rig used these cone dimensions.
const DEFAULTS = {
  beam: { length: 30, nearRadius: 0.12, farRadius: 1.75, lumens: 10000 },
  wash: { length: 21, nearRadius: 0.18, farRadius: 3.8, lumens: 10000 },
};

export function fixtureOptics(kind: MovingHeadKind, settings?: FixtureOptics) {
  const base = DEFAULTS[kind];
  const slope = (base.farRadius - base.nearRadius) / base.length;
  const referenceAngle = 2 * Math.atan(slope);
  const angle = settings?.beamAngle ?? settings?.profile?.beamAngle;
  const angleRadians = angle === undefined ? referenceAngle : angle * Math.PI / 180;
  const lumens = settings?.lumens ?? settings?.profile?.lumens ?? base.lumens;
  const fluxRatio = lumens / base.lumens;
  // A uniform cone's solid angle is 4π sin²(half-angle / 2). Keep the
  // legacy class exposure and scale the preview by flux per solid angle.
  const gain = fluxRatio * (Math.sin(referenceAngle / 4) / Math.sin(angleRadians / 4)) ** 2;
  return { length: base.length, nearRadius: base.nearRadius,
    farRadius: angle === undefined ? base.farRadius : base.nearRadius + base.length * Math.tan(angleRadians / 2),
    lumens, beamAngle: angleRadians * 180 / Math.PI, gain, fluxRatio,
    zoomSlope: settings ? Math.tan(angleRadians / 2) : 0 };
}

export function aerialGain(optics: ReturnType<typeof fixtureOptics>, zoom: number) {
  if (!optics.zoomSlope || zoom === 1) return optics.gain;
  // Ω / (2π) = 1 − cos(halfAngle). Rationalize before division to
  // preserve precision on narrow beams. The projected cone slope scales with zoom.
  const base = Math.hypot(1, optics.zoomSlope);
  const live = Math.hypot(1, optics.zoomSlope * zoom);
  return optics.gain * live * (live + 1) / (zoom * zoom * base * (base + 1));
}

export const MAX_LUMENS = 10_000_000;
export const MIN_ANGLE = 0.1;
export const MAX_ANGLE = 179;
