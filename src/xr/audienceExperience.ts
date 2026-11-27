import type { RigConfig, VenueType } from '../types/show';
import { AUDIENCE_FRONT_RAILS, computeVenueBounds } from '../data/venueBounds';
import { theatreSeatAnchors, type TheatreSeatAnchor } from '../data/crowdPlacement';

export const XR_STANDING_EYE_HEIGHT_M = 1.6;
export const XR_SEATED_EYE_HEIGHT_M = 1.2;
export const XR_SNAP_TURN_DEG = 30;

export const XR_ARENA_EMULATOR_BUDGET = Object.freeze({
  calls: 270,
  triangles: 760_000,
  rendererTextures: 26,
  ownedTextures: 1,
});

export type XrEyeMode = 'standing' | 'seated';
export type XrQualityProfile = 'standalone-low' | 'pc-link-high';
export type XrViewpointId = 'stage-front' | 'floor' | 'mezzanine' | 'balcony' | 'foh';

export interface XrPoint3 {
  x: number;
  y: number;
  z: number;
}

export interface XrQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface XrPose {
  position: XrPoint3;
  orientation: XrQuaternion;
}

export interface XrFohFrame {
  position: XrPoint3;
  target: XrPoint3;
}

export interface XrViewpoint {
  id: XrViewpointId;
  label: string;
  x: number;
  z: number;
  floorY: number;
  yawRad: number;
  virtualTier: boolean;
  blocked?: boolean;
}

export interface XrMenuRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XrMenuHit {
  id: string;
  pixelX: number;
  pixelY: number;
  distance: number;
}

export interface XrInputEdgeState {
  held: Set<string>;
  claimedFrame: number;
}

type Landing = Pick<XrViewpoint, 'x' | 'z' | 'floorY'>;

export interface XrAudienceObstacle {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

const LANDING_RADIUS_M = 0.25;
const LANDING_HEIGHT_M = XR_STANDING_EYE_HEIGHT_M + 0.25;

function landingClear(landing: Landing, obstacles: readonly XrAudienceObstacle[]): boolean {
  return obstacles.every(obstacle => {
    if (obstacle.y + obstacle.height <= landing.floorY || obstacle.y >= landing.floorY + LANDING_HEIGHT_M) return true;
    const separation = obstacle.radius + LANDING_RADIUS_M;
    return (obstacle.x - landing.x) ** 2 + (obstacle.z - landing.z) ** 2 >= separation ** 2;
  });
}

const LANDING_OFFSETS = (() => {
  const points: Array<{ x: number; z: number }> = [];
  for (let z = -6; z <= 6; z++) for (let x = -8; x <= 8; x++) {
    points.push({ x: x * 0.5, z: z * 0.5 });
  }
  points.sort((a, b) => (a.x ** 2 + a.z ** 2) - (b.x ** 2 + b.z ** 2) || a.z - b.z || a.x - b.x);
  return points;
})();

function findLanding(
  preferred: Landing,
  limits: { minX: number; maxX: number; minZ: number; maxZ: number },
  obstacles: readonly XrAudienceObstacle[],
): Landing | undefined {
  for (const offset of LANDING_OFFSETS) {
    const x = preferred.x + offset.x, z = preferred.z + offset.z;
    if (x < limits.minX || x > limits.maxX || z < limits.minZ || z > limits.maxZ) continue;
    const candidate = { x, z, floorY: preferred.floorY };
    if (landingClear(candidate, obstacles)) return candidate;
  }
  return undefined;
}

function theatreAisleLandings(seats: readonly TheatreSeatAnchor[], preferred: Landing): Landing[] {
  const spots: Landing[] = [];
  for (let index = 1; index < seats.length; index++) {
    const left = seats[index - 1], right = seats[index];
    if (left.row === right.row && right.x - left.x >= 1.03) {
      spots.push({ x: (left.x + right.x) / 2, z: left.z - 0.05, floorY: left.y });
    }
  }
  return spots.sort((a, b) =>
    (a.x - preferred.x) ** 2 + (a.z - preferred.z) ** 2
    - (b.x - preferred.x) ** 2 - (b.z - preferred.z) ** 2
    || a.z - b.z || a.x - b.x);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function eyeHeightForMode(mode: XrEyeMode): number {
  return mode === 'seated' ? XR_SEATED_EYE_HEIGHT_M : XR_STANDING_EYE_HEIGHT_M;
}

export function normalizeYaw(yawRad: number): number {
  if (!Number.isFinite(yawRad)) return 0;
  const twoPi = Math.PI * 2;
  return ((yawRad + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

export function yawToward(from: Pick<XrPoint3, 'x' | 'z'>, target: Pick<XrPoint3, 'x' | 'z'>): number {
  return normalizeYaw(Math.atan2(target.x - from.x, from.z - target.z));
}

function tierFloorYs(venue: VenueType, ceilingY: number | null): [number, number] {
  const authored: Record<VenueType, [number, number]> = {
    arena: [2.57, 4.29],
    theatre: [1.7, 3.4],
    club: [0.65, 1.3],
    warehouse: [1.4, 2.8],
    festival: [1.2, 2.4],
  };
  const [mezz, balcony] = authored[venue];
  if (ceilingY === null) return [mezz, balcony];
  const maxFloor = Math.max(0, ceilingY - XR_STANDING_EYE_HEIGHT_M - 0.25);
  return [Math.min(mezz, maxFloor), Math.min(balcony, maxFloor)];
}

/**
 * Derive bounded audience preview viewpoints from the venue envelope. Arena tier heights match
 * the authored five-step bleachers; other mezzanine/balcony entries are explicitly virtual previews.
 */
export function deriveAudienceViewpoints(
  rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>,
  foh?: XrFohFrame,
  obstacles: readonly XrAudienceObstacle[] = [],
): XrViewpoint[] {
  const bounds = computeVenueBounds(rig);
  const zone = bounds.audienceZone;
  const minX = -bounds.halfWidth + 0.75;
  const maxX = bounds.halfWidth - 0.75;
  const minZ = zone.minZ + 1.25;
  const maxZ = Math.min(zone.maxZ, bounds.rearZ) - 1.25;
  if (!(minX < maxX) || !(minZ < maxZ)) throw new Error('Venue has no usable audience preview area.');
  const zAt = (ratio: number) => minZ + (maxZ - minZ) * ratio;
  const [mezzFloor, balconyFloor] = tierFloorYs(rig.venue, bounds.ceilingY);
  const stageTarget = { x: 0, z: -Math.max(0.5, rig.stageDepth * 0.15) };
  const make = (
    id: XrViewpointId,
    label: string,
    x: number,
    z: number,
    floorY: number,
    virtualTier: boolean,
  ): XrViewpoint => {
    const cx = clamp(x, minX, maxX);
    const cz = clamp(z, minZ, maxZ);
    return { id, label, x: cx, z: cz, floorY, yawRad: yawToward({ x: cx, z: cz }, stageTarget), virtualTier };
  };
  const side = Math.min(maxX * 0.68, Math.max(0, bounds.halfWidth * 0.55));
  const limits = { minX, maxX, minZ, maxZ };
  const rail = rig.venue === 'theatre' ? AUDIENCE_FRONT_RAILS.theatre
    : rig.venue === 'club' ? undefined : AUDIENCE_FRONT_RAILS.concert;
  const frontMinZ = rail ? Math.max(minZ, zone.minZ + rail.offset + rail.depth / 2 + LANDING_RADIUS_M) : minZ;
  // Keep the rail in sight from the standing eye position. Theatre has a much narrower pit aisle.
  const sightlineMinZ = rail === AUDIENCE_FRONT_RAILS.concert ? frontMinZ + 0.75 : frontMinZ;
  const front = { x: 0, z: Math.min(maxZ, sightlineMinZ + 0.08), floorY: 0 };
  const floor = { x: -Math.min(2.2, Math.max(0, maxX * 0.2)), z: zAt(0.34), floorY: 0 };
  const frontLimits = { ...limits, minZ: sightlineMinZ, maxZ: Math.min(maxZ, frontMinZ + (rig.venue === 'theatre' ? 0.3 : 3)) };
  const theatreSeats = theatreSeatAnchors(rig);
  // The existing chair cushion and back occupy x ±0.235, z −0.28 to +0.25 and y up to 1.02 from the seat anchor.
  const landingObstacles = theatreSeats.length ? [
    ...obstacles,
    ...theatreSeats.map(seat => ({ x: seat.x, y: seat.y, z: seat.z - 0.015, radius: 0.36, height: 1.02 })),
  ] : obstacles;
  const clearAisle = (preferred: Landing) => theatreAisleLandings(theatreSeats, preferred)
    .find(spot => spot.x >= minX && spot.x <= maxX && spot.z >= minZ && spot.z <= maxZ && landingClear(spot, landingObstacles));
  const frontLanding = findLanding(front, frontLimits, landingObstacles);
  const floorLanding = theatreSeats.length
    ? clearAisle(floor)
    : findLanding(floor, { ...limits, minZ: frontMinZ }, landingObstacles);
  const fromLanding = (id: XrViewpointId, label: string, preferred: Landing, found?: Landing, virtualTier = false): XrViewpoint => {
    const point = found ?? preferred;
    return { ...make(id, label, point.x, point.z, point.floorY, virtualTier), ...(found ? {} : { blocked: true }) };
  };
  const mezzanine = { x: side, z: zAt(0.62), floorY: mezzFloor };
  const balcony = { x: -side, z: zAt(0.82), floorY: balconyFloor };
  const virtualTier = rig.venue !== 'arena';
  const viewpoints: XrViewpoint[] = [
    fromLanding('stage-front', 'Stage front', front, frontLanding),
    fromLanding('floor', 'Audience floor', floor, floorLanding),
    fromLanding('mezzanine', 'Mezzanine preview', mezzanine, landingClear(mezzanine, landingObstacles) ? mezzanine : undefined, virtualTier),
    fromLanding('balcony', 'Balcony preview', balcony, landingClear(balcony, landingObstacles) ? balcony : undefined, virtualTier),
  ];
  const defaultFoh = { x: 0, y: XR_STANDING_EYE_HEIGHT_M, z: zAt(0.74) };
  const fohPosition = foh?.position ?? defaultFoh;
  const fohTarget = foh?.target ?? { x: 0, y: rig.stageDepth * 0.1, z: 0 };
  const fohX = clamp(fohPosition.x, minX, maxX);
  const fohZ = clamp(fohPosition.z, minZ, maxZ);
  const maxFohFloor = bounds.ceilingY === null
    ? Math.max(0, fohPosition.y - XR_STANDING_EYE_HEIGHT_M)
    : Math.max(0, bounds.ceilingY - XR_STANDING_EYE_HEIGHT_M - 0.25);
  const preferredFoh = {
    x: fohX, z: fohZ,
    floorY: clamp(fohPosition.y - XR_STANDING_EYE_HEIGHT_M, 0, maxFohFloor),
  };
  const rearSeat = theatreSeats.at(-1);
  let fohLanding: Landing | undefined;
  if (rearSeat && preferredFoh.floorY < rearSeat.y + 1.02) {
    // Use a supported row aisle or the flat space behind the last riser at low Theatre FOH positions.
    const rearFloorMinZ = rearSeat.z - 0.05 + 0.95 / 2 + LANDING_RADIUS_M;
    const rearPreferred = { ...preferredFoh, z: Math.max(preferredFoh.z, rearFloorMinZ), floorY: 0 };
    const rearFloor = findLanding(rearPreferred, { ...limits, minZ: rearFloorMinZ }, landingObstacles);
    const aisle = clearAisle(preferredFoh);
    fohLanding = preferredFoh.z < rearFloorMinZ ? aisle ?? rearFloor : rearFloor ?? aisle;
  } else {
    fohLanding = findLanding(preferredFoh, { ...limits, minZ: frontMinZ }, landingObstacles);
  }
  const fohViewpoint = fromLanding('foh', 'Front of house', preferredFoh, fohLanding);
  fohViewpoint.yawRad = yawToward(fohViewpoint, fohTarget);
  viewpoints.push(fohViewpoint);
  return viewpoints;
}

export function viewpointHeadPose(viewpoint: XrViewpoint, mode: XrEyeMode, yawOffsetRad = 0): XrPose {
  const yaw = normalizeYaw(viewpoint.yawRad + yawOffsetRad);
  // Menu yaw is positive to the viewer's right. With Three's -Z forward, that is a negative Y rotation.
  const half = -yaw / 2;
  return {
    position: { x: viewpoint.x, y: viewpoint.floorY + eyeHeightForMode(mode), z: viewpoint.z },
    orientation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
  };
}

function multiplyQuat(a: XrQuaternion, b: XrQuaternion): XrQuaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function inverseQuat(q: XrQuaternion): XrQuaternion {
  const d = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w || 1;
  return { x: -q.x / d, y: -q.y / d, z: -q.z / d, w: q.w / d };
}

function rotatePoint(q: XrQuaternion, p: XrPoint3): XrPoint3 {
  const v = multiplyQuat(multiplyQuat(q, { ...p, w: 0 }), inverseQuat(q));
  return { x: v.x, y: v.y, z: v.z };
}

function composePose(a: XrPose, b: XrPose): XrPose {
  const p = rotatePoint(a.orientation, b.position);
  return {
    position: { x: a.position.x + p.x, y: a.position.y + p.y, z: a.position.z + p.z },
    orientation: multiplyQuat(a.orientation, b.orientation),
  };
}

function inversePose(pose: XrPose): XrPose {
  const orientation = inverseQuat(pose.orientation);
  const position = rotatePoint(orientation, {
    x: -pose.position.x,
    y: -pose.position.y,
    z: -pose.position.z,
  });
  return { position, orientation };
}

/** Offset transform from derived StageForge space to the base local-floor space. */
export function offsetPoseForDesiredHead(baseHead: XrPose, desiredHead: XrPose): XrPose {
  return composePose(baseHead, inversePose(desiredHead));
}

/** Resolve a base-space pose into the derived StageForge reference space. */
export function resolvePoseInOffsetSpace(basePose: XrPose, offset: XrPose): XrPose {
  return composePose(inversePose(offset), basePose);
}

export function snapYaw(currentOffsetRad: number, direction: -1 | 1): number {
  return normalizeYaw(currentOffsetRad + direction * XR_SNAP_TURN_DEG * Math.PI / 180);
}

export function menuHitTest(
  origin: XrPoint3,
  direction: XrPoint3,
  canvasWidth: number,
  canvasHeight: number,
  rects: readonly XrMenuRect[],
  out?: XrMenuHit,
): XrMenuHit | null {
  if (!Number.isFinite(direction.z) || direction.z >= -1e-6) return null;
  const distance = -origin.z / direction.z;
  if (!(distance > 0)) return null;
  const x = origin.x + direction.x * distance;
  const y = origin.y + direction.y * distance;
  if (x < -0.5 || x >= 0.5 || y <= -0.5 || y > 0.5) return null;
  const pixelX = (x + 0.5) * canvasWidth;
  const pixelY = (0.5 - y) * canvasHeight;
  const rect = rects.find((item) =>
    pixelX >= item.x && pixelX < item.x + item.width && pixelY >= item.y && pixelY < item.y + item.height);
  if (!rect) return null;
  const hit = out ?? { id: rect.id, pixelX, pixelY, distance };
  hit.id = rect.id;
  hit.pixelX = pixelX;
  hit.pixelY = pixelY;
  hit.distance = distance;
  return hit;
}

export function createInputEdgeState(): XrInputEdgeState {
  return { held: new Set(), claimedFrame: -1 };
}

export function consumeInputEdge(
  state: XrInputEdgeState,
  sourceId: string,
  kind: 'select' | 'squeeze',
  pressed: boolean,
  frame: number,
): boolean {
  const key = `${sourceId}:${kind}`;
  if (!pressed) {
    state.held.delete(key);
    return false;
  }
  if (state.held.has(key)) return false;
  state.held.add(key);
  if (state.claimedFrame === frame) return false;
  state.claimedFrame = frame;
  return true;
}

export const XR_PROFILE_STORAGE_KEY = 'stageforge.webxr.profile.v1';

export function xrSessionQuality(profile: XrQualityProfile): { framebufferScale: number; foveation: number } {
  return profile === 'standalone-low'
    ? { framebufferScale: 0.75, foveation: 0.65 }
    : { framebufferScale: 1, foveation: 0.25 };
}

export function defaultXrQualityProfile(userAgent = ''): XrQualityProfile {
  return /OculusBrowser/i.test(userAgent) ? 'standalone-low' : 'pc-link-high';
}

export function loadXrQualityProfile(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): XrQualityProfile {
  try {
    const value = localStorage.getItem(XR_PROFILE_STORAGE_KEY);
    return value === 'standalone-low' || value === 'pc-link-high' ? value : defaultXrQualityProfile(userAgent);
  } catch {
    return defaultXrQualityProfile(userAgent);
  }
}

export function saveXrQualityProfile(profile: XrQualityProfile): void {
  try {
    localStorage.setItem(XR_PROFILE_STORAGE_KEY, profile);
  } catch {
    // Private browsing/quota failures must never block XR preview.
  }
}
