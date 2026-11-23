import type { LedCabinets, RigConfig, VenueType } from '../types/show';
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

/** Width between side walls or festival tower centres, in stage coordinates. */
export function stageBayWidth(venue: VenueType, stageWidth: number) {
  switch (venue) {
    case 'warehouse': return 28;
    case 'arena': return 54;
    case 'club': return Math.max(15, stageWidth + 9);
    case 'theatre': return Math.max(Math.max(8, stageWidth - 1.2) + 9, stageWidth + 3);
    case 'festival': return stageWidth + 6.4;
  }
}

export interface LedSurface {
  width: number;
  height: number;
  columns: number;
  rows: number;
  pixelsWide: number;
  pixelsHigh: number;
}

export function requestedWallSize(cabinets: LedCabinets) {
  return { width: cabinets.columns * cabinets.widthMm / 1000, height: cabinets.rows * cabinets.heightMm / 1000 };
}

export function initialLedCabinets(wall: RigConfig['ledWall']): LedCabinets {
  return {
    columns: Math.max(1, Math.min(256, Math.round(wall.width / 0.5))),
    rows: Math.max(1, Math.min(256, Math.round(wall.height / 0.5))),
    widthMm: 500, heightMm: 500, pixelsWide: 128, pixelsHigh: 128,
  };
}

function cabinetSurface(panel: LedCabinets, columns: number, rows: number): LedSurface {
  if (columns === 0 || rows === 0) { columns = 0; rows = 0; }
  return {
    columns, rows, width: columns * panel.widthMm / 1000, height: rows * panel.heightMm / 1000,
    pixelsWide: columns * panel.pixelsWide, pixelsHigh: rows * panel.pixelsHigh,
  };
}

// Dimension-only shows retain the original smooth scaling and decorative grid.
function legacySurface(width: number, height: number): LedSurface {
  const aspect = height > 0 ? width / height : 0;
  return { width, height, columns: Math.max(1, Math.round(6 * aspect)), rows: 6,
    pixelsWide: 160 * aspect, pixelsHigh: 160 };
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
  const availableHeight = Math.max(0, GRID_HEIGHT[rig.venue] - bottom - 0.30);
  const panel = rig.ledWall.cabinets;
  if (!panel) {
    const height = Math.min(rig.ledWall.height, availableHeight);
    const scale = height / rig.ledWall.height;
    const main = legacySurface(rig.ledWall.width * scale, height);
    const wing = rig.ledWall.sideWings ? legacySurface(5.4 * scale, height * 0.82) : legacySurface(0, 0);
    return { ...main, x, y: bottom + height / 2, z, scale, wingGap: 2.2 * scale, wing };
  }

  // Keep the centred screen inside the bay, allowing for its housing and the side wall.
  const halfBay = Math.max(0, stageBayWidth(rig.venue, rig.stageWidth) / 2 - Math.abs(x) - 0.6);
  const fit = (metres: number, millimetres: number) => Math.max(0, Math.floor((metres * 1000 + 1e-7) / millimetres));
  const main = cabinetSurface(panel, Math.min(panel.columns, fit(2 * halfBay, panel.widthMm)),
    Math.min(panel.rows, fit(availableHeight, panel.heightMm)));
  const wingGap = 2.2;
  const sideSpace = halfBay - main.width / 2 - wingGap;
  const wing = cabinetSurface(panel,
    rig.ledWall.sideWings ? Math.min(Math.max(1, Math.round(5400 / panel.widthMm)), fit(sideSpace, panel.widthMm)) : 0,
    main.rows ? Math.max(1, Math.round(main.rows * 0.82)) : 0);
  return { ...main, x, y: bottom + main.height / 2, z,
    scale: Math.min(main.rows / panel.rows, main.columns / panel.columns), wingGap, wing };
}
