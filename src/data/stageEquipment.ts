import type { RigConfig, VenueType } from '../types/show';
import { getPlatforms, stageSurfaceHeight } from './stageDesign';
import { SPEAKER_PROFILES } from './speakerProfiles';

/** Elevation of the overhead steel above the stage, including the theatre fly tower. */
export const GRID_HEIGHT: Record<VenueType, number> = {
  arena: 15.8, warehouse: 11.2, festival: 16.5, theatre: 17, club: 5.2,
};

export function monitorPositions(rig: RigConfig) {
  const count = Math.min(8, Math.max(0, Math.floor(rig.audioRig.monitorCount ?? 0)));
  if (!count) return [];
  const decks = getPlatforms(rig);
  const monitor = SPEAKER_PROFILES[rig.audioRig.speakerProfile ?? 'touring'].monitor;
  const left = decks.length ? Math.min(...decks.map(d => d.x - d.width / 2)) : -rig.stageWidth / 2;
  const right = decks.length ? Math.max(...decks.map(d => d.x + d.width / 2)) : rig.stageWidth / 2;
  return Array.from({ length: count }, (_, index) => {
    const fraction = count === 1 ? 0.5 : 0.16 + 0.68 * index / (count - 1);
    const targetX = left + (right - left) * fraction;
    // At the requested X, prefer the downstage edge. In an aisle, use the closest deck.
    let x = targetX, z = rig.stageDepth / 2 - 0.65, nearest = Infinity;
    for (const deck of decks) {
      const halfSpan = Math.max(0, (deck.width - monitor.width) / 2);
      const candidate = Math.max(deck.x - halfSpan, Math.min(deck.x + halfSpan, targetX));
      const distance = Math.abs(candidate - targetX);
      const front = deck.z + deck.depth / 2 - Math.min(deck.depth / 2, Math.max(0.65, monitor.depth / 2));
      if (distance < nearest || (distance === nearest && front > z)) {
        x = candidate; z = front; nearest = distance;
      }
    }
    const rotationY = Math.max(-0.45, Math.min(0.45, (x - (left + right) / 2) * 0.032));
    return { x, y: stageSurfaceHeight(rig, x, z), z, rotationY };
  });
}

export function ledPlacement(rig: RigConfig) {
  const decks = getPlatforms(rig);
  const rear = decks.length ? Math.min(...decks.map(d => d.z - d.depth / 2)) : -rig.stageDepth / 2;
  const rearDecks = decks.filter(d => Math.abs(d.z - d.depth / 2 - rear) < 0.001);
  const left = Math.min(...rearDecks.map(d => d.x - d.width / 2));
  const right = Math.max(...rearDecks.map(d => d.x + d.width / 2));
  const x = rearDecks.length ? (left + right) / 2 : 0;
  const z = rear + (rearDecks.length ? Math.min(0.4, ...rearDecks.map(d => d.depth / 2)) : 0.4);
  // A wall can span two rear deck modules with a centre gap.
  const deckY = Math.max(stageSurfaceHeight(rig, x, z), ...rearDecks.map(d => d.height));
  const bottom = deckY + 0.35;
  const height = Math.min(rig.ledWall.height, Math.max(0, GRID_HEIGHT[rig.venue] - bottom - 0.30));
  const scale = height / rig.ledWall.height;
  return { x, y: bottom + height / 2, z, width: rig.ledWall.width * scale, height, scale };
}
