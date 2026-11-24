import type { PlanPoint, TrussPodConfig } from '../types/show';

export type HoistPodInput = Pick<TrussPodConfig, 'shape' | 'width' | 'hoistCount'> & {
  path?: readonly PlanPoint[];
};

/**
 * Single source of truth for hoist / suspension anchor points in a truss pod's local XZ frame.
 * Shared by geometryBuilders.ts (3D hoists), productionEstimator.ts (hoist counts), and rigLoads.ts (load solver).
 */
export function hoistPoints(pod: HoistPodInput): PlanPoint[] {
  const { shape, width, path, hoistCount } = pod;
  if (shape === 'box') {
    const half = width / 2;
    const count =
      hoistCount !== undefined && Number.isInteger(hoistCount) && hoistCount >= 2 && hoistCount <= 4
        ? hoistCount
        : width >= 14
          ? 3
          : 2;
    if (count === 2) {
      return [
        { x: -half * 0.72, z: 0 },
        { x: half * 0.72, z: 0 },
      ];
    }
    if (count === 3) {
      return [
        { x: -half * 0.78, z: 0 },
        { x: 0, z: 0 },
        { x: half * 0.78, z: 0 },
      ];
    }
    // 4 evenly spaced points spanning ±0.84·half (matching touring box truss spacing)
    return [
      { x: -half * 0.84, z: 0 },
      { x: -half * 0.28, z: 0 },
      { x: half * 0.28, z: 0 },
      { x: half * 0.84, z: 0 },
    ];
  }

  if (shape === 'circle') {
    const radius = width / 2;
    const out: PlanPoint[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      out.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
    }
    return out;
  }

  if (shape === 'chevron') {
    const angle = 0.36;
    const armLen = width / (2 * Math.cos(angle));
    const armDepth = Math.sin(angle) * armLen;
    return [
      { x: -width * 0.42, z: -armDepth * 0.84 },
      { x: 0, z: 0.05 },
      { x: width * 0.42, z: -armDepth * 0.84 },
    ];
  }

  // shape === 'path': deduplicate consecutive and coincident vertices within 1e-8 squared metres
  // (matching buildTrussPath geometry exactly).
  const raw = path ?? [];
  const filtered: PlanPoint[] = [];
  for (const p of raw) {
    if (
      filtered.length === 0 ||
      (filtered[filtered.length - 1].x - p.x) ** 2 + (filtered[filtered.length - 1].z - p.z) ** 2 > 1e-8
    ) {
      filtered.push({ x: p.x, z: p.z });
    }
  }
  if (filtered.length < 2) return [];

  const unique: PlanPoint[] = [];
  for (const p of filtered) {
    const dup = unique.some((u) => (u.x - p.x) ** 2 + (u.z - p.z) ** 2 <= 1e-8);
    if (!dup) unique.push(p);
  }
  return unique;
}
