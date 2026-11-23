import type { PlanPoint, RigConfig, StagePlatform, TrussPodConfig } from '../types/show';
import { RIG_TEMPLATES } from './presets';

export const MAX_PLATFORMS = 24;
export const MAX_PATH_POINTS = 64;
export const MIN_TRUSS_SPAN = 0.25;

export function createBlankDesign(room: RigConfig = RIG_TEMPLATES.blank_stage): RigConfig {
  const rig = structuredClone(RIG_TEMPLATES.blank_stage);
  return {
    ...rig,
    schemaVersion: 1,
    name: 'Untitled stage',
    venue: room.venue,
    stageWidth: room.stageWidth,
    stageDepth: room.stageDepth,
    stageHeight: room.stageHeight,
    platforms: [],
    trussPods: [],
    floorFx: [],
    props: [],
    audioRig: {
      ...rig.audioRig,
      lineArrays: false,
      subWall: false,
      djBooth: false,
      monitorCount: 0,
      crowdDensity: 0,
    },
    ledWall: { ...rig.ledWall, enabled: false },
  };
}

export function getPlatforms(rig: RigConfig): StagePlatform[] {
  return (
    rig.platforms ?? [
      {
        id: 'main-deck',
        name: 'Main deck',
        x: 0,
        z: 0,
        width: rig.stageWidth,
        depth: rig.stageDepth,
        height: rig.stageHeight,
      },
    ]
  );
}

export function stageSurfaceHeight(rig: RigConfig, x: number, z: number) {
  if (!rig.platforms)
    return Math.abs(x) <= rig.stageWidth / 2 && Math.abs(z) <= rig.stageDepth / 2 ? rig.stageHeight : 0;
  let height = 0;
  for (const p of rig.platforms) {
    if (Math.abs(x - p.x) <= p.width / 2 && Math.abs(z - p.z) <= p.depth / 2)
      height = Math.max(height, p.height);
  }
  return height;
}

export function withPlatforms(rig: RigConfig, platforms: StagePlatform[]): RigConfig {
  if (!platforms.length) return { ...rig, schemaVersion: 1, platforms };
  // The venue and default equipment use a centred envelope. Geometry uses the actual modules.
  const stageWidth = Math.max(...platforms.map((p) => 2 * Math.abs(p.x) + p.width));
  const stageDepth = Math.max(...platforms.map((p) => 2 * Math.abs(p.z) + p.depth));
  const stageHeight = Math.max(...platforms.map((p) => p.height));
  return { ...rig, platforms, schemaVersion: 1, stageWidth, stageDepth, stageHeight };
}

export function pathLength(points: PlanPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return length;
}

export function podWorldPoint(pod: TrussPodConfig, point: PlanPoint): PlanPoint {
  const c = Math.cos(pod.rotationY),
    s = Math.sin(pod.rotationY);
  return { x: pod.x + c * point.x + s * point.z, z: pod.z - s * point.x + c * point.z };
}

export function podLocalPoint(pod: TrussPodConfig, point: PlanPoint): PlanPoint {
  const c = Math.cos(pod.rotationY),
    s = Math.sin(pod.rotationY);
  const x = point.x - pod.x,
    z = point.z - pod.z;
  return { x: c * x - s * z, z: s * x + c * z };
}

export function makeTrussPath(points: PlanPoint[], elevation: number): TrussPodConfig {
  if (
    points.length < 2 ||
    points.length > MAX_PATH_POINTS ||
    points.some(
      (p, i) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.z) ||
        (i > 0 && Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) < MIN_TRUSS_SPAN),
    )
  ) {
    throw new Error('Draw at least two points with 0.25 m or more between adjacent points.');
  }
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  const x = (Math.max(...xs) + Math.min(...xs)) / 2,
    z = (Math.max(...zs) + Math.min(...zs)) / 2;
  return {
    id: crypto.randomUUID(),
    name: 'Custom truss',
    shape: 'path',
    x,
    z,
    baseY: elevation,
    rotationY: 0,
    path: points.map((p) => ({ x: p.x - x, z: p.z - z })),
    width: pathLength(points),
    motorized: false,
    motorMinY: Math.max(0, elevation - 2),
    motorMaxY: elevation + 2,
    fixtures: [],
  };
}

export function normalizeDesign(rig: RigConfig): RigConfig {
  const next = rig.platforms ? withPlatforms(rig, rig.platforms) : rig;
  return {
    ...next,
    schemaVersion: 1,
    trussPods: next.trussPods.map((pod) =>
      pod.shape === 'path' && pod.path ? { ...pod, width: pathLength(pod.path) } : pod,
    ),
  };
}
