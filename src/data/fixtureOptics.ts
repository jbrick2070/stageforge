import type { BeamProfile, FixtureOptics, FixtureType, FloorFxType } from '../types/show';
import { getCatalogEntry, isFieldUnverified } from './equipmentCatalog';

export type MovingHeadKind = 'beam' | 'wash';

export const MAX_LUMENS = 10_000_000;
export const MIN_ANGLE = 0.1;
export const MAX_ANGLE = 179;
export const MAX_AERIAL_GAIN = 1_000_000_000;

function referenceFromCatalog(id: string, geometry: 'Narrow' | 'Wide'): BeamProfile {
  const entry = getCatalogEntry(id)!;
  return {
    source: 'datasheet',
    manufacturer: entry.manufacturer,
    fixture: entry.model,
    geometry,
    lumens: entry.optics?.lumens,
    beamAngle: entry.optics?.beamDeg,
  };
}

// Output lumens at the named zoom endpoint, derived directly from the equipment catalogue
// so reference optics and catalogue entries stay in sync. See docs/equipment.md & docs/stage-design.md.
export const REFERENCE_OPTICS: BeamProfile[] = [
  referenceFromCatalog('chauvet-rogue-r1-beamwash', 'Narrow'),
  referenceFromCatalog('martin-mac-aura-xip', 'Wide'),
];

// Generic preview references. The legacy rig used these cone dimensions.
const DEFAULTS = {
  beam: { length: 30, nearRadius: 0.12, farRadius: 1.75, lumens: 10000 },
  wash: { length: 21, nearRadius: 0.18, farRadius: 3.8, lumens: 10000 },
};

export function hasConfiguredOptics(settings?: FixtureOptics): boolean {
  return Boolean(settings && (settings.lumens !== undefined || settings.beamAngle !== undefined || settings.profile !== undefined));
}

/** Build default FixtureOptics from a catalogue entry for a moving-head render kind. */
export function catalogOptics(catalogId: string | undefined, kind: MovingHeadKind): FixtureOptics | undefined {
  const entry = getCatalogEntry(catalogId);
  if (!entry?.optics) return undefined;
  const spec = entry.optics;
  const verifiedZoom = !isFieldUnverified(entry, 'optics.zoomDeg') ? spec.zoomDeg : undefined;
  const verifiedBeam = !isFieldUnverified(entry, 'optics.beamDeg') ? spec.beamDeg : undefined;
  const verifiedLumens = !isFieldUnverified(entry, 'optics.lumens') ? spec.lumens : undefined;
  const beamAngle =
    kind === 'beam'
      ? verifiedZoom?.[0] ?? verifiedBeam
      : spec.lumensAt === 'wide' && verifiedBeam !== undefined
        ? verifiedBeam
        : verifiedZoom?.[1] ?? verifiedBeam;
  const lumens =
    verifiedLumens !== undefined &&
    (spec.lumensAt === undefined ||
      (kind === 'beam' && spec.lumensAt === 'narrow') ||
      (kind === 'wash' && spec.lumensAt === 'wide'))
      ? verifiedLumens
      : undefined;
  if (beamAngle === undefined && lumens === undefined) return undefined;
  const profile: BeamProfile = {
    source: 'datasheet',
    manufacturer: entry.manufacturer,
    fixture: entry.model,
    geometry: kind === 'beam' ? 'Narrow' : 'Wide',
    ...(lumens !== undefined ? { lumens } : {}),
    ...(beamAngle !== undefined ? { beamAngle } : {}),
  };
  return { profile };
}

/**
 * Resolve effective FixtureOptics for a fixture or floor-FX group.
 * Groups without `catalogId` return `group.optics` untouched so legacy rendering stays byte-identical.
 */
export function resolveOptics(group: {
  type: FixtureType | FloorFxType;
  catalogId?: string;
  optics?: FixtureOptics;
}): FixtureOptics | undefined {
  if (!group.catalogId) return group.optics;
  if (group.type !== 'beam' && group.type !== 'wash' && group.type !== 'floor_beam') return undefined;
  const kind: MovingHeadKind = group.type === 'wash' ? 'wash' : 'beam';
  const base = catalogOptics(group.catalogId, kind);
  if (!hasConfiguredOptics(group.optics)) return base;
  if (!base) return group.optics;
  return {
    profile: group.optics?.profile ?? base.profile,
    ...(group.optics?.lumens !== undefined ? { lumens: group.optics.lumens } : {}),
    ...(group.optics?.beamAngle !== undefined ? { beamAngle: group.optics.beamAngle } : {}),
  };
}

export function fixtureOptics(kind: MovingHeadKind, settings?: FixtureOptics) {
  const base = DEFAULTS[kind];
  const slope = (base.farRadius - base.nearRadius) / base.length;
  const referenceAngle = 2 * Math.atan(slope);
  const configured = hasConfiguredOptics(settings);
  const rawAngle = configured ? settings?.beamAngle ?? settings?.profile?.beamAngle : undefined;
  const angle =
    rawAngle !== undefined && Number.isFinite(rawAngle)
      ? Math.min(MAX_ANGLE, Math.max(MIN_ANGLE, rawAngle))
      : undefined;
  const angleRadians = angle === undefined ? referenceAngle : (angle * Math.PI) / 180;
  const rawLumens = configured ? settings?.lumens ?? settings?.profile?.lumens : undefined;
  const lumens =
    rawLumens !== undefined && Number.isFinite(rawLumens)
      ? Math.min(MAX_LUMENS, Math.max(0, rawLumens))
      : base.lumens;
  const fluxRatio = lumens / base.lumens;
  // A uniform cone's solid angle is 4π sin²(half-angle / 2). Keep the
  // legacy class exposure and scale the preview by flux per solid angle.
  const rawGain = fluxRatio * (Math.sin(referenceAngle / 4) / Math.sin(angleRadians / 4)) ** 2;
  const gain = Number.isFinite(rawGain) ? Math.min(MAX_AERIAL_GAIN, Math.max(0, rawGain)) : 0;
  return {
    length: base.length,
    nearRadius: base.nearRadius,
    farRadius: angle === undefined ? base.farRadius : base.nearRadius + base.length * Math.tan(angleRadians / 2),
    lumens,
    beamAngle: (angleRadians * 180) / Math.PI,
    gain,
    fluxRatio,
    zoomSlope: configured ? Math.tan(angleRadians / 2) : 0,
  };
}

export function aerialGain(optics: ReturnType<typeof fixtureOptics>, zoom: number) {
  if (!optics.zoomSlope || zoom === 1) return optics.gain;
  if (!Number.isFinite(zoom) || zoom <= 0) return optics.gain;
  // Ω / (2π) = 1 − cos(halfAngle). Rationalize before division to
  // preserve precision on narrow beams. The projected cone slope scales with zoom.
  const base = Math.hypot(1, optics.zoomSlope);
  const live = Math.hypot(1, optics.zoomSlope * zoom);
  const scaled = (optics.gain * live * (live + 1)) / (zoom * zoom * base * (base + 1));
  return Number.isFinite(scaled) ? Math.min(MAX_AERIAL_GAIN, Math.max(0, scaled)) : optics.gain;
}

/**
 * Shared mesh zoom scale factor used by both `StageEngine.updateScene` and `measure.ts`
 * so reported beam angles always match the rendered volumetric cone.
 */
export function beamZoomScale(kind: MovingHeadKind, effZoom: number): number {
  const z = Number.isFinite(effZoom) ? Math.max(0, Math.min(1, effZoom)) : 0;
  return kind === 'wash' ? 0.75 + z * 0.85 : 0.42 + z * 1.35;
}

/**
 * Effective full beam angle in degrees for a moving head given its `fixtureOptics()` result
 * and live `zoomScale` (`beamMesh.scale.x`). Works for both configured and legacy optics.
 */
export function effectiveBeamAngleDeg(
  optics: Pick<ReturnType<typeof fixtureOptics>, 'length' | 'nearRadius' | 'farRadius'>,
  zoomScale: number,
): number {
  const safeZoom = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  const slope = ((optics.farRadius - optics.nearRadius) / Math.max(1e-6, optics.length)) * safeZoom;
  return (2 * Math.atan(Math.max(1e-6, slope)) * 180) / Math.PI;
}

/**
 * Return explicitly configured or verified catalogue luminous flux (lumens), or `null` when
 * photometric data is absent (never falls back to the 10,000 lm legacy preview default).
 */
export function resolvedPhotometricLumens(group: {
  type: FixtureType | FloorFxType;
  catalogId?: string;
  optics?: FixtureOptics;
}): number | null {
  const resolved = resolveOptics(group);
  const raw = resolved?.lumens ?? resolved?.profile?.lumens;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(MAX_LUMENS, raw);
}
