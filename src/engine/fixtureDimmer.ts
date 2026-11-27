import type { FixtureType, FloorFxType } from '../types/show';

/** The documented factory setting for explicitly selected MegaPointe beams. */
export function usesSquareLawPreviewDimmer(type: FixtureType | FloorFxType, authoredCatalogId?: string): boolean {
  return authoredCatalogId === 'robe-megapointe' && (type === 'beam' || type === 'floor_beam');
}

/** Curve the normalized lamp command; StageForge effect overdrive stays above it. */
export function applyPreviewDimmerCurve(level: number, squareLaw: boolean): number {
  return squareLaw && level > 0 && level < 1 ? level * level : level;
}
