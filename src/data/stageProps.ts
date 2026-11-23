import type { StageProp, StagePropKind, VenueType } from '../types/show';

export const PROP_CATALOG = {
  tentacle: { label: 'Inflatable tentacle', color: '#c2d2ed' },
  star: { label: 'Foil star inflatable', color: '#ffb76f' },
  arch: { label: 'Inflatable arch', color: '#cca3cc' },
  marquee: { label: 'Marquee tower', color: '#ffc382' },
  riser: { label: 'Performance riser', color: '#8495b3' },
} satisfies Record<StagePropKind, { label: string; color: string }>;

export function createStageProp(kind: StagePropKind, id: string, x = 0, z = 0): StageProp {
  return { id, kind, x, z, scale: 1, rotation: 0, color: PROP_CATALOG[kind].color };
}

export function scenicPreset(venue: VenueType): StageProp[] {
  if (venue === 'arena') {
    return [
      { ...createStageProp('tentacle', 'wing-left', -8.1, 2.6), scale: 1.22, rotation: 165 },
      { ...createStageProp('tentacle', 'wing-right', 8.1, 2.6), scale: 1.22, rotation: 15 },
    ];
  }
  if (venue === 'festival') {
    return [
      { ...createStageProp('star', 'star-left', -10, 0.5), scale: 1.35, rotation: 14 },
      { ...createStageProp('star', 'star-right', 10, 0.5), scale: 1.35, rotation: -14 },
      { ...createStageProp('arch', 'upstage-arch', 0, -2.8), scale: 1.12 },
    ];
  }
  if (venue === 'warehouse') {
    return [
      createStageProp('marquee', 'tower-left', -6.35, 1.1),
      createStageProp('marquee', 'tower-right', 6.35, 1.1),
    ];
  }
  // Theatres and clubs start without scenery; the room itself is the look.
  return [];
}

export function isStageProp(value: unknown): value is StageProp {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<StageProp>;
  return typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.kind === 'string' && Object.hasOwn(PROP_CATALOG, p.kind) &&
    [p.x, p.z, p.rotation, p.scale].every(v => typeof v === 'number' && Number.isFinite(v)) &&
    p.scale! >= 0.35 && p.scale! <= 2 && typeof p.color === 'string' && /^#[\da-f]{6}$/i.test(p.color);
}
