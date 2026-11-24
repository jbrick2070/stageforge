import { getPlatforms } from '../data/stageDesign';
import type { RigConfig } from '../types/show';

/**
 * Focus points: named stage coordinates that moving heads solve pan/tilt onto, in the spirit of
 * ETC Eos Augment3d focus points and grandMA3 XYZ positions. Because a look references the point
 * (not raw pan/tilt), re-hanging a truss or moving a riser keeps every beam on its target.
 */

/** Moving-head geometry shared with StageEngine.createMovingFixture: root -> yoke -> head (metres along the hang axis). */
export const YOKE_OFFSET = 0.18;
export const HEAD_OFFSET = 0.28;
/** Distance from the clamp to the tilt pivot. The beam axis always passes through this point. */
export const HEAD_PIVOT = YOKE_OFFSET + HEAD_OFFSET;

/** Typical moving-head travel: 540 degrees pan, 270 degrees tilt (+/-135 degrees from the hang axis). */
export const TILT_LIMIT = (135 * Math.PI) / 180;
export const PAN_LIMIT = (270 * Math.PI) / 180;

/** Select the nearest equivalent pan angle the yoke can physically reach. */
export function reachablePan(target: number, current: number) {
  const turn = Math.PI * 2;
  let next = target + Math.round((current - target) / turn) * turn;
  if (next > PAN_LIMIT) next -= turn;
  if (next < -PAN_LIMIT) next += turn;
  return next;
}

export function axisDmx(angle: number, limit: number) {
  return Math.round(255 * Math.max(0, Math.min(1, (angle + limit) / (2 * limit))));
}

/** How far the focus offset faders move the spot from its point, in metres, at full travel. */
export const FOCUS_NUDGE_RANGE = 4;

export interface FocusMark {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Focus points derived from the stage plan so they move with it:
 * the centre of every deck module at its top surface, plus the audience at head height.
 */
export function focusMarks(rig: RigConfig): FocusMark[] {
  const platforms = getPlatforms(rig);
  const marks: FocusMark[] = platforms.map((p) => ({
    id: `platform:${p.id}`,
    name: p.name,
    x: p.x,
    y: p.height,
    z: p.z,
  }));
  const front = platforms.length ? Math.max(...platforms.map((p) => p.z + p.depth / 2)) : 0;
  marks.push({ id: 'audience', name: 'Audience', x: 0, y: 1.6, z: front + 6 });
  return marks;
}

/** The world point a look aims at: its focus point plus the operator's offset, or null when the point no longer exists. */
export function focusPoint(
  marks: FocusMark[],
  markId: string | null | undefined,
  nudgeX: number,
  nudgeZ: number,
): Vec3 | null {
  const mark = markId ? marks.find((m) => m.id === markId) : undefined;
  if (!mark) return null;
  return {
    x: mark.x + nudgeX * FOCUS_NUDGE_RANGE,
    y: mark.y,
    z: mark.z + nudgeZ * FOCUS_NUDGE_RANGE,
  };
}

const wrap = (a: number) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};

/**
 * Pan (yoke rotation.y) and tilt (head rotation.x) that point a moving head at `local`,
 * the target expressed in the fixture's root frame. A hung head emits along -Y, a floor head along +Y.
 * Of the two equivalent solutions, the one closest to the current position is chosen so heads don't flip.
 */
export function aimAngles(local: Vec3, isFloor: boolean, currentPan = 0, currentTilt = 0, pivot = HEAD_PIVOT) {
  const dir = isFloor ? 1 : -1;
  const vx = local.x,
    vy = local.y - dir * pivot,
    vz = local.z;
  const len = Math.hypot(vx, vy, vz) || 1;
  const tilt = Math.acos(Math.max(-1, Math.min(1, (dir * vy) / len)));
  const pan = Math.atan2(dir * vx, dir * vz);
  const alternate = { pan: wrap(pan + Math.PI), tilt: -tilt };
  const cost = (a: { pan: number; tilt: number }) =>
    Math.abs(reachablePan(a.pan, currentPan) - currentPan) + Math.abs(a.tilt - currentTilt);
  const primary = { pan, tilt };
  const best = cost(alternate) < cost(primary) ? alternate : primary;
  // A point beyond the tilt range (above the truss) gets the closest reachable angle.
  return { pan: best.pan, tilt: Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, best.tilt)) };
}

/**
 * Tilt angle for a single-axis motorized batten (fixed pan = 0): projects `local` onto the fixture's YZ plane
 * so the bar tilts toward the target without twisting its yoke.
 */
export function aimTiltOnly(local: Vec3, isFloor: boolean, pivot = HEAD_PIVOT): number {
  const dir = isFloor ? 1 : -1;
  const vy = local.y - dir * pivot;
  const vz = local.z;
  // Rotating head around +X maps local (0, dir, 0) -> (0, dir*cos(t), dir*sin(t)).
  const raw = Math.atan2(dir * vz, dir * vy);
  return Math.max(-TILT_LIMIT, Math.min(TILT_LIMIT, raw));
}
