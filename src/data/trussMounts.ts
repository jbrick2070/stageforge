import type { PlanPoint, TrussShape } from '../types/show';

interface Mount extends PlanPoint {
  y: number;
  rotY: number;
}

/** Mount points in the truss's local frame, shared by the renderer and drafting exports. */
export function trussMounts(shape: TrussShape, width: number, path: readonly PlanPoint[] = [], fixtureCount?: number): Mount[] {
  const half = width / 2;
  if (shape === 'circle') {
    const count = Math.max(24, fixtureCount ?? 0);
    const y = -Math.min(0.24, width * 0.14) - 0.04;
    return Array.from({ length: count }, (_, i) => {
      const a = 2 * Math.PI * i / count;
      return { x: half * Math.cos(a), z: half * Math.sin(a), y, rotY: Math.PI / 2 - a };
    });
  }
  if (shape === 'box') {
    const count = Math.max(32, fixtureCount ?? 0);
    const inset = Math.min(0.65, half * 0.2);
    return Array.from({ length: count }, (_, i) => ({
      x: (half - inset) * (2 * i / (count - 1) - 1), z: 0, y: -0.28, rotY: 0,
    }));
  }
  if (shape === 'chevron') {
    const perSide = Math.max(8, Math.ceil((fixtureCount ?? 0) / 2));
    return Array.from({ length: 2 * perSide }, (_, i) => {
      const left = i < perSide;
      const t = ((i % perSide) + 0.5) / perSide;
      const x = width * ((left ? -0.46 : 0.04) + 0.42 * t);
      return { x, z: -Math.abs(x) * Math.tan(0.36), y: -0.28, rotY: left ? -0.36 : 0.36 };
    });
  }
  // Space along cumulative path length, including the closing segment of a loop.
  const segments: { start: PlanPoint; offset: number; span: number; dx: number; dz: number }[] = [];
  let start = path[0], length = 0;
  for (const end of path.slice(1)) {
    const dx = end.x - start.x, dz = end.z - start.z;
    const span = Math.hypot(dx, dz);
    if (span <= 0.0001) continue;
    segments.push({ start, offset: length, span, dx, dz });
    start = end;
    length += span;
  }
  if (!segments.length) return [];
  const count = fixtureCount ?? 32;
  let segmentIndex = 0;
  return Array.from({ length: count }, (_, i) => {
    const distance = (i + 0.5) * length / count;
    while (segmentIndex + 1 < segments.length && distance > segments[segmentIndex + 1].offset) segmentIndex++;
    const segment = segments[segmentIndex];
    const t = (distance - segment.offset) / segment.span;
    return { x: segment.start.x + t * segment.dx, z: segment.start.z + t * segment.dz,
      y: -0.28, rotY: -Math.atan2(segment.dz, segment.dx) };
  });
}
