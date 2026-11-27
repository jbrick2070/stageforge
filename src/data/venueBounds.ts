import type { RigConfig, VenueType } from '../types/show';
import type { NativeStage } from './showFile';
import { getPlatforms } from './stageDesign';
import { GRID_HEIGHT, ledPlacement, stageBayWidth } from './stageEquipment';
import { authoredWallFrames, isCustomMainWall, resolveStudioGeometry } from './studioGeometry';

/** Minimum vertical clearance above audience-accessible floor surfaces (IEC 60825-3 / ANSI Z136.1 guidance). */
export const AUDIENCE_KEEPOUT_HEIGHT_M = 3.0;

/** Floor plane half-extent matching `geometryBuilders.ts` (`PlaneGeometry(140, 140)`). */
export const VENUE_FLOOR_HALF_EXTENT_M = 70;

export const AUDIENCE_FRONT_RAILS = {
  concert: { offset: 2.4, depth: 0.45, height: 1.12 },
  theatre: { offset: 2.1, depth: 0.25, height: 1 },
} as const;

export interface Vec3Tuple {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AudienceZoneBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface VenueBounds {
  readonly venue: VenueType;
  /** Physical hall/room half-width (or floor half-extent for open-air festival). */
  readonly halfWidth: number;
  /** Upstage physical wall Z (or floor extent for open-air festival). */
  readonly backZ: number;
  /** Downstage rear wall Z (or floor extent for open-air festival). */
  readonly rearZ: number;
  /** Physical ceiling/soffit height in metres, or `null` for open-air festival. */
  readonly ceilingY: number | null;
  /** True when side/rear walls physically enclose the venue (false for open-air festival). */
  readonly hasPhysicalWalls: boolean;
  /** Floor plane half-extent (always `<= 70 m`). */
  readonly floorHalfExtent: number;
  /** Flat-floor audience keep-out volume (`y in [0, 3.0 m]`, `z in [audienceStartZ, audienceEndZ]`). */
  readonly audienceZone: AudienceZoneBox;
}

export interface DeckRectSurface {
  readonly id: string;
  readonly name: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number;
}

export interface WallQuadSurface {
  readonly id: string;
  readonly label: string;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly halfW: number;
  readonly halfH: number;
  /** Unit normal facing outward from the screen surface. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Unit right axis along wall width. */
  readonly ux: number;
  readonly uz: number;
}

export interface SceneRaySurfaces {
  readonly bounds: VenueBounds;
  readonly decks: readonly DeckRectSurface[];
  readonly walls: readonly WallQuadSurface[];
}

export type RayHitKind = 'deck' | 'floor' | 'wall' | 'ceiling' | 'none';

export interface RayHitResult {
  readonly kind: RayHitKind;
  readonly surfaceLabel: string | null;
  /** Positive distance from ray origin along unit direction, or `null` when no surface hit. */
  readonly distanceM: number | null;
  readonly point: Vec3Tuple | null;
  readonly normal: Vec3Tuple | null;
  /** Incidence angle in degrees (`0` = perpendicular to surface, `90` = parallel/grazing), or `null`. */
  readonly incidenceDeg: number | null;
}

export interface RayAudienceCrossing {
  readonly enters: boolean;
  /** Distance along ray where it enters the audience keep-out box (`y <= 3.0 m`), clamped to `[0, maxT]`. */
  readonly enterT: number | null;
  /** Distance along ray where it exits the audience keep-out box, clamped to `[0, maxT]`. */
  readonly exitT: number | null;
  /** Lowest ray Y (m, >= 0) while over the audience X/Z footprint, or `null` if the ray never crosses audience X/Z. */
  readonly minClearanceM: number | null;
}

/** Audience downstage end Z used by both `laserSafety.ts` and `measure.ts`. */
export function venueAudienceEndZ(rig: Pick<RigConfig, 'venue' | 'stageDepth'>): number {
  const start = rig.stageDepth / 2;
  switch (rig.venue) {
    case 'club':
      return Math.max(start + 12, 22);
    case 'theatre':
      return Math.max(start + 18, 30);
    case 'warehouse':
      return Math.max(start + 26, 35);
    case 'festival':
      return Math.max(start + 40, 50);
    case 'arena':
    default:
      return Math.max(start + 35, 45);
  }
}

/**
 * Pure dimensional specification shared across `geometryBuilders.ts` and `measure.ts`.
 * Distinguishes physical enclosing walls/ceilings (theatre, club, arena, warehouse) from
 * open-air venues (festival: `hasPhysicalWalls: false, ceilingY: null`).
 */
export function computeVenueBounds(rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>): VenueBounds {
  const { venue, stageWidth, stageDepth } = rig;
  const front = stageDepth / 2;
  const roofY = GRID_HEIGHT[venue];
  const audienceEndZ = venueAudienceEndZ(rig);

  if (venue === 'theatre') {
    const openW = Math.max(8, stageWidth - 1.2);
    const houseW = Math.max(18, openW + 8);
    const halfWidth = houseW / 2;
    const backZ = -stageDepth / 2 - 1.2;
    const rearZ = front + 3.2 + 14 * 0.95 + 2.0; // firstZ + rows * pitch + 2.0
    const ceilingY = 10.5;
    return {
      venue,
      halfWidth,
      backZ,
      rearZ,
      ceilingY,
      hasPhysicalWalls: true,
      floorHalfExtent: VENUE_FLOOR_HALF_EXTENT_M,
      audienceZone: {
        minX: -halfWidth,
        maxX: halfWidth,
        minY: 0,
        maxY: AUDIENCE_KEEPOUT_HEIGHT_M,
        minZ: front,
        maxZ: Math.min(rearZ, audienceEndZ),
      },
    };
  }

  if (venue === 'club') {
    const halfWidth = stageBayWidth('club', stageWidth) / 2;
    const backZ = -stageDepth / 2 - 0.9;
    const rearZ = front + 19;
    return {
      venue,
      halfWidth,
      backZ,
      rearZ,
      ceilingY: roofY + 0.35,
      hasPhysicalWalls: true,
      floorHalfExtent: VENUE_FLOOR_HALF_EXTENT_M,
      audienceZone: {
        minX: -halfWidth,
        maxX: halfWidth,
        minY: 0,
        maxY: AUDIENCE_KEEPOUT_HEIGHT_M,
        minZ: front,
        maxZ: Math.min(rearZ, audienceEndZ),
      },
    };
  }

  if (venue === 'arena' || venue === 'warehouse') {
    const hallW = stageBayWidth(venue, stageWidth);
    const hallD = venue === 'warehouse' ? 46 : 78;
    const halfWidth = hallW / 2;
    const backZ = 12 - hallD / 2;
    const rearZ = 12 + hallD / 2;
    return {
      venue,
      halfWidth,
      backZ,
      rearZ,
      ceilingY: roofY + 1.2,
      hasPhysicalWalls: true,
      floorHalfExtent: VENUE_FLOOR_HALF_EXTENT_M,
      audienceZone: {
        minX: -halfWidth,
        maxX: halfWidth,
        minY: 0,
        maxY: AUDIENCE_KEEPOUT_HEIGHT_M,
        minZ: front,
        maxZ: Math.min(rearZ, audienceEndZ),
      },
    };
  }

  // Open-air festival: physical floor plane only, no enclosing walls or ceiling.
  // Use the full open-air floor extent (±70 m) so lateral rays over the festival ground are never missed.
  return {
    venue: 'festival',
    halfWidth: VENUE_FLOOR_HALF_EXTENT_M,
    backZ: -VENUE_FLOOR_HALF_EXTENT_M,
    rearZ: VENUE_FLOOR_HALF_EXTENT_M,
    ceilingY: null,
    hasPhysicalWalls: false,
    floorHalfExtent: VENUE_FLOOR_HALF_EXTENT_M,
    audienceZone: {
      minX: -VENUE_FLOOR_HALF_EXTENT_M,
      maxX: VENUE_FLOOR_HALF_EXTENT_M,
      minY: 0,
      maxY: AUDIENCE_KEEPOUT_HEIGHT_M,
      minZ: front,
      maxZ: audienceEndZ,
    },
  };
}

/** Build the pure physical surface list (decks, LED walls, venue bounds) for ray intersection. */
export function buildSceneRaySurfaces(sourceRig: RigConfig, stage?: NativeStage): SceneRaySurfaces {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const bounds = computeVenueBounds(rig);

  const decks: DeckRectSurface[] = getPlatforms(rig).map((p) => ({
    id: p.id,
    name: p.name,
    minX: p.x - p.width / 2,
    maxX: p.x + p.width / 2,
    minZ: p.z - p.depth / 2,
    maxZ: p.z + p.depth / 2,
    y: p.height,
  }));

  const walls: WallQuadSurface[] = [];
  const authored = authoredWallFrames(rig, stage);
  const authoredMain = (stage?.walls ?? []).find((w) => w.id === 'main-led');
  const hasCustomMain = isCustomMainWall(authoredMain);

  for (const frame of authored) {
    const yawRad = (frame.yaw * Math.PI) / 180;
    const sinY = Math.sin(yawRad);
    const cosY = Math.cos(yawRad);
    walls.push({
      id: frame.id,
      label: frame.label || frame.id,
      cx: frame.x,
      cy: frame.y,
      cz: frame.z,
      halfW: frame.width / 2,
      halfH: frame.height / 2,
      nx: sinY,
      ny: 0,
      nz: cosY,
      ux: cosY,
      uz: -sinY,
    });
  }

  if (rig.ledWall.enabled && !hasCustomMain) {
    const stock = ledPlacement(rig);
    if (stock.width > 0 && stock.height > 0) {
      walls.push({
        id: 'main-led',
        label: 'Main LED wall',
        cx: stock.x,
        cy: stock.y,
        cz: stock.z,
        halfW: stock.width / 2,
        halfH: stock.height / 2,
        nx: 0,
        ny: 0,
        nz: 1,
        ux: 1,
        uz: 0,
      });
    }
    if (rig.ledWall.sideWings && stock.wing.width > 0 && stock.wing.height > 0) {
      const wingOffset = stock.width / 2 + stock.wingGap + stock.wing.width / 2;
      for (const side of [-1, 1] as const) {
        const yawRad = side * -0.22;
        const sinY = Math.sin(yawRad);
        const cosY = Math.cos(yawRad);
        walls.push({
          id: side < 0 ? 'wing-left' : 'wing-right',
          label: side < 0 ? 'IMAG Wing L' : 'IMAG Wing R',
          cx: stock.x + side * wingOffset,
          cy: stock.y,
          cz: stock.z + 1.0,
          halfW: stock.wing.width / 2,
          halfH: stock.wing.height / 2,
          nx: sinY,
          ny: 0,
          nz: cosY,
          ux: cosY,
          uz: -sinY,
        });
      }
    }
  }

  return { bounds, decks, walls };
}

const EPS = 1e-6;

/**
 * Pure normalized-ray intersection against physical scene surfaces (stage decks, venue floor,
 * LED walls, and physical venue walls/ceiling). Returns the nearest positive hit.
 * Never invents a ceiling or enclosing wall for open-air festival venues.
 */
export function castRayToScene(
  origin: Vec3Tuple,
  rawDir: Vec3Tuple,
  surfaces: SceneRaySurfaces,
  maxDistance = Infinity,
): RayHitResult {
  const len = Math.hypot(rawDir.x, rawDir.y, rawDir.z);
  if (!Number.isFinite(len) || len < EPS) {
    return { kind: 'none', surfaceLabel: null, distanceM: null, point: null, normal: null, incidenceDeg: null };
  }
  const dx = rawDir.x / len;
  const dy = rawDir.y / len;
  const dz = rawDir.z / len;

  let bestT = maxDistance;
  let bestKind: RayHitKind = 'none';
  let bestLabel: string | null = null;
  let bestNormalX = 0;
  let bestNormalY = 0;
  let bestNormalZ = 0;
  let hasHit = false;

  const consider = (t: number, kind: RayHitKind, label: string, nx: number, ny: number, nz: number) => {
    if (t > EPS && t < bestT) {
      bestT = t;
      bestKind = kind;
      bestLabel = label;
      hasHit = true;
      // Orient normal against incoming ray so incidence angle lies in [0, 90] deg.
      const dot = dx * nx + dy * ny + dz * nz;
      if (dot <= 0) {
        bestNormalX = nx;
        bestNormalY = ny;
        bestNormalZ = nz;
      } else {
        bestNormalX = -nx;
        bestNormalY = -ny;
        bestNormalZ = -nz;
      }
    }
  };

  // 1. Stage deck top rectangles
  if (Math.abs(dy) > EPS) {
    for (const deck of surfaces.decks) {
      const t = (deck.y - origin.y) / dy;
      if (t <= EPS || t >= bestT) continue;
      const hx = origin.x + t * dx;
      const hz = origin.z + t * dz;
      if (hx >= deck.minX - 1e-5 && hx <= deck.maxX + 1e-5 && hz >= deck.minZ - 1e-5 && hz <= deck.maxZ + 1e-5) {
        consider(t, 'deck', deck.name, 0, 1, 0);
      }
    }
  }

  // 2. Venue floor (y = 0)
  if (Math.abs(dy) > EPS) {
    const t = -origin.y / dy;
    if (t > EPS && t < bestT) {
      const hx = origin.x + t * dx;
      const hz = origin.z + t * dz;
      const lim = surfaces.bounds.floorHalfExtent;
      const minX = surfaces.bounds.hasPhysicalWalls ? -surfaces.bounds.halfWidth : -lim;
      const maxX = surfaces.bounds.hasPhysicalWalls ? surfaces.bounds.halfWidth : lim;
      const minZ = surfaces.bounds.hasPhysicalWalls ? surfaces.bounds.backZ : -lim;
      const maxZ = surfaces.bounds.hasPhysicalWalls ? surfaces.bounds.rearZ : lim;
      if (hx >= minX - 1e-4 && hx <= maxX + 1e-4 && hz >= minZ - 1e-4 && hz <= maxZ + 1e-4) {
        consider(t, 'floor', 'Venue floor', 0, 1, 0);
      }
    }
  }

  // 3. Authored & stock LED walls (finite vertical quads)
  for (const wall of surfaces.walls) {
    const denom = dx * wall.nx + dy * wall.ny + dz * wall.nz;
    if (Math.abs(denom) < EPS) continue;
    const t = ((wall.cx - origin.x) * wall.nx + (wall.cy - origin.y) * wall.ny + (wall.cz - origin.z) * wall.nz) / denom;
    if (t <= EPS || t >= bestT) continue;
    const rx = origin.x + t * dx - wall.cx;
    const ry = origin.y + t * dy - wall.cy;
    const rz = origin.z + t * dz - wall.cz;
    const localU = rx * wall.ux + rz * wall.uz;
    if (Math.abs(localU) <= wall.halfW + 1e-4 && Math.abs(ry) <= wall.halfH + 1e-4) {
      consider(t, 'wall', wall.label, wall.nx, wall.ny, wall.nz);
    }
  }

  // 4. Physical venue walls & ceiling (theatre, club, arena, warehouse — never open-air festival)
  const b = surfaces.bounds;
  if (b.hasPhysicalWalls) {
    const wallTop = b.ceilingY ?? 40;
    if (Math.abs(dx) > EPS) {
      for (const side of [-1, 1] as const) {
        const planeX = side * b.halfWidth;
        const t = (planeX - origin.x) / dx;
        if (t <= EPS || t >= bestT) continue;
        const hy = origin.y + t * dy;
        const hz = origin.z + t * dz;
        if (hy >= -1e-4 && hy <= wallTop + 1e-4 && hz >= b.backZ - 1e-4 && hz <= b.rearZ + 1e-4) {
          consider(t, 'wall', side < 0 ? 'House-right wall' : 'House-left wall', -side, 0, 0);
        }
      }
    }
    if (Math.abs(dz) > EPS) {
      for (const [planeZ, label, nz] of [
        [b.backZ, 'Upstage wall', 1],
        [b.rearZ, 'Rear wall', -1],
      ] as const) {
        const t = (planeZ - origin.z) / dz;
        if (t <= EPS || t >= bestT) continue;
        const hx = origin.x + t * dx;
        const hy = origin.y + t * dy;
        if (hy >= -1e-4 && hy <= wallTop + 1e-4 && hx >= -b.halfWidth - 1e-4 && hx <= b.halfWidth + 1e-4) {
          consider(t, 'wall', label, 0, 0, nz);
        }
      }
    }
  }

  if (b.ceilingY !== null && Math.abs(dy) > EPS) {
    const t = (b.ceilingY - origin.y) / dy;
    if (t > EPS && t < bestT) {
      const hx = origin.x + t * dx;
      const hz = origin.z + t * dz;
      if (hx >= -b.halfWidth - 1e-4 && hx <= b.halfWidth + 1e-4 && hz >= b.backZ - 1e-4 && hz <= b.rearZ + 1e-4) {
        consider(t, 'ceiling', 'Venue ceiling', 0, -1, 0);
      }
    }
  }

  if (!hasHit || bestKind === 'none') {
    return { kind: 'none', surfaceLabel: null, distanceM: null, point: null, normal: null, incidenceDeg: null };
  }

  const cosAlpha = Math.min(1, Math.max(0, -(dx * bestNormalX + dy * bestNormalY + dz * bestNormalZ)));
  const incidenceDeg = (Math.acos(cosAlpha) * 180) / Math.PI;
  return {
    kind: bestKind,
    surfaceLabel: bestLabel,
    distanceM: bestT,
    point: {
      x: origin.x + bestT * dx,
      y: origin.y + bestT * dy,
      z: origin.z + bestT * dz,
    },
    normal: { x: bestNormalX, y: bestNormalY, z: bestNormalZ },
    incidenceDeg,
  };
}

/**
 * Pure diagnostic crossing of a ray against the flat-floor audience keep-out volume
 * (`[minX, maxX] × [0, maxY] × [minZ, maxZ]`), truncated at `maxT` (e.g., an earlier physical hit).
 * Computes both the red-segment `[enterT, exitT]` inside the keep-out box AND the lowest
 * clearance `minClearanceM` over the audience X/Z footprint.
 */
export function intersectRayAudienceZone(
  origin: Vec3Tuple,
  rawDir: Vec3Tuple,
  zone: AudienceZoneBox,
  maxT = Infinity,
): RayAudienceCrossing {
  const len = Math.hypot(rawDir.x, rawDir.y, rawDir.z);
  if (!Number.isFinite(len) || len < EPS || maxT <= 0) {
    return { enters: false, enterT: null, exitT: null, minClearanceM: null };
  }
  const dx = rawDir.x / len;
  const dy = rawDir.y / len;
  const dz = rawDir.z / len;

  // Clip ray against floor y = 0 first (if travelling downward into floor from above y = 0).
  let effectiveMaxT = maxT;
  if (dy < -EPS && origin.y >= 0) {
    const floorT = -origin.y / dy;
    if (floorT >= 0 && floorT < effectiveMaxT) effectiveMaxT = floorT;
  }

  // 1. Over-audience horizontal slab [minX, maxX] × [minZ, maxZ]
  let xzMin = 0;
  let xzMax = effectiveMaxT;

  const clipAxis = (o: number, d: number, lo: number, hi: number, tMin: number, tMax: number): [number, number] | null => {
    if (Math.abs(d) < EPS) {
      return o >= lo - 1e-6 && o <= hi + 1e-6 ? [tMin, tMax] : null;
    }
    const tA = (lo - o) / d;
    const tB = (hi - o) / d;
    const a = Math.min(tA, tB);
    const b = Math.max(tA, tB);
    const nMin = Math.max(tMin, a);
    const nMax = Math.min(tMax, b);
    return nMin <= nMax + 1e-7 ? [nMin, nMax] : null;
  };

  const xClip = clipAxis(origin.x, dx, zone.minX, zone.maxX, xzMin, xzMax);
  if (!xClip) return { enters: false, enterT: null, exitT: null, minClearanceM: null };
  const zClip = clipAxis(origin.z, dz, zone.minZ, zone.maxZ, xClip[0], xClip[1]);
  if (!zClip) return { enters: false, enterT: null, exitT: null, minClearanceM: null };

  xzMin = zClip[0];
  xzMax = zClip[1];

  // Lowest clearance above audience floor (y = 0) across [xzMin, xzMax]
  const yStart = origin.y + xzMin * dy;
  const yEnd = origin.y + xzMax * dy;
  const minClearanceM = Math.max(0, Math.min(yStart, yEnd));

  // 2. Intersect with vertical keep-out height [zone.minY, zone.maxY] (0..3.0 m)
  const yClip = clipAxis(origin.y, dy, zone.minY, zone.maxY, xzMin, xzMax);
  if (!yClip || yClip[1] - yClip[0] <= 1e-6) {
    return {
      enters: minClearanceM < zone.maxY - 1e-6,
      enterT: yClip ? yClip[0] : null,
      exitT: yClip ? yClip[1] : null,
      minClearanceM,
    };
  }

  return {
    enters: true,
    enterT: yClip[0],
    exitT: yClip[1],
    minClearanceM,
  };
}
