import type { RigConfig, VenueType } from '../types/show';
import { computeVenueBounds } from '../data/venueBounds';

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
}

export interface XrMenuRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XrInputEdgeState {
  held: Set<string>;
  claimedFrame: number;
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
export function deriveAudienceViewpoints(rig: Pick<RigConfig, 'venue' | 'stageWidth' | 'stageDepth'>, foh?: XrFohFrame): XrViewpoint[] {
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
  const viewpoints: XrViewpoint[] = [
    make('stage-front', 'Stage front', 0, minZ, 0, false),
    make('floor', 'Audience floor', -Math.min(2.2, Math.max(0, maxX * 0.2)), zAt(0.34), 0, false),
    make('mezzanine', 'Mezzanine preview', side, zAt(0.62), mezzFloor, rig.venue !== 'arena'),
    make('balcony', 'Balcony preview', -side, zAt(0.82), balconyFloor, rig.venue !== 'arena'),
  ];
  const defaultFoh = { x: 0, y: XR_STANDING_EYE_HEIGHT_M, z: zAt(0.74) };
  const fohPosition = foh?.position ?? defaultFoh;
  const fohTarget = foh?.target ?? { x: 0, y: rig.stageDepth * 0.1, z: 0 };
  const fohX = clamp(fohPosition.x, minX, maxX);
  const fohZ = clamp(fohPosition.z, minZ, maxZ);
  const maxFohFloor = bounds.ceilingY === null
    ? Math.max(0, fohPosition.y - XR_STANDING_EYE_HEIGHT_M)
    : Math.max(0, bounds.ceilingY - XR_STANDING_EYE_HEIGHT_M - 0.25);
  viewpoints.push({
    id: 'foh',
    label: 'Front of house',
    x: fohX,
    z: fohZ,
    floorY: clamp(fohPosition.y - XR_STANDING_EYE_HEIGHT_M, 0, maxFohFloor),
    yawRad: yawToward({ x: fohX, z: fohZ }, fohTarget),
    virtualTier: false,
  });
  return viewpoints;
}

export function viewpointHeadPose(viewpoint: XrViewpoint, mode: XrEyeMode, yawOffsetRad = 0): XrPose {
  const yaw = normalizeYaw(viewpoint.yawRad + yawOffsetRad);
  const half = yaw / 2;
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
): { id: string; pixelX: number; pixelY: number; distance: number } | null {
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
  return rect ? { id: rect.id, pixelX, pixelY, distance } : null;
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
