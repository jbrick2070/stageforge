import type { FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import { buildDmxPatch, fixtureScope, FLOOR_FIXTURE_SCOPE, type DmxPatch, type FixturePatchUnit, type FixtureScope } from './dmxPatch';
import { getTrussProfile, trussMountY } from './rigCatalog';
import { podWorldPoint, stageSurfaceHeight } from './stageDesign';
import { trussMounts } from './trussMounts';

/** One installed fixture unit with its world placement and patch address. */
export interface FixturePlacement {
  group: MountedFixtureGroup | FloorFxUnit;
  /** Unit index within its group. */
  index: number;
  /** Truss pod the unit hangs on, or undefined for a floor unit. */
  podId?: string;
  /** World position in metres (Y up, +Z toward the audience). */
  position: { x: number; y: number; z: number };
  /** Rotation about +Y in radians, as StageEngine sets it (pod rotation plus mount bearing). */
  yaw: number;
  floor: boolean;
  universe: 1 | 2;
  /** First DMX channel of this unit within its universe. */
  address: number;
  /** DMX footprint in channels. */
  footprint: number;
  /** False when the unit's channels fall outside the universe or collide with another group. */
  patched: boolean;
  /** Scoped patch record from the same resolved rig. */
  patch: FixturePatchUnit;
}

/**
 * Mount slot for the n-th of `units` hung units across `slots` slots. This is StageEngine's exact
 * expression (same operation order, so the same floating-point result); keep the two in step.
 */
export function mountSlotIndex(n: number, units: number, slots: number): number {
  return Math.min(slots - 1, Math.floor((n + 0.5) / units * slots));
}

/** Interleaved hung units across a truss pod, shared by StageEngine, CAD export and MVR export. */
export function hungUnits(fixtures: readonly MountedFixtureGroup[]): Array<{ group: MountedFixtureGroup; index: number; fraction: number }> {
  return fixtures
    .flatMap((group) => Array.from({ length: Math.max(0, group.count) }, (_, index) => ({
      group, index, fraction: (index + 0.5) / group.count,
    })))
    .sort((a, b) => a.fraction - b.fraction);
}

/** World X position of the i-th emitter in a floor FX row, shared by StageEngine and exports. */
export function floorUnitX(group: Pick<FloorFxUnit, 'x' | 'spread' | 'count'>, index: number): number {
  return group.x + (group.count <= 1 ? 0 : group.spread * (index / (group.count - 1) - 0.5));
}

/**
 * Where every fixture unit of a rig sits, using the same mount distribution StageEngine and the
 * CAD export use: hung units interleave across a pod's mount slots in DMX order; floor units
 * spread evenly across their row on the deck surface.
 */
export function placeFixtures(rig: RigConfig, patch = buildDmxPatch(rig)): FixturePlacement[] {
  if (patch.rig !== rig) throw new Error('Fixture placement needs the patch for the same resolved rig.');
  const out: FixturePlacement[] = [];
  const unit = (group: FixturePlacement['group'], index: number, scope: FixtureScope) => {
    const record = patch.unitFor(group, index, scope)!;
    return {
      universe: record.universe,
      address: record.start,
      footprint: record.width,
      patched: record.effectiveStart !== 0,
      patch: record,
    };
  };
  for (const pod of rig.trussPods) {
    const scope = fixtureScope(pod.id);
    const hung = hungUnits(pod.fixtures);
    const mountY = getTrussProfile(pod.trussProfileId)
      ? trussMountY(pod.trussProfileId, pod.shape, pod.width)
      : undefined;
    const slots = trussMounts(pod.shape, pod.width, pod.path, hung.length, mountY);
    hung.forEach(({ group, index }, n) => {
      const mount = slots[mountSlotIndex(n, hung.length, slots.length)];
      if (!mount) return;
      const at = podWorldPoint(pod, mount);
      // Projectors on rings and paths face downstage regardless of truss bearing.
      const frontFacing = group.type === 'laser' && (pod.shape === 'circle' || pod.shape === 'path');
      out.push({
        group, index, podId: pod.id, floor: false,
        position: { x: at.x, y: pod.baseY + mount.y, z: at.z },
        yaw: frontFacing ? 0 : pod.rotationY + mount.rotY,
        ...unit(group, index, scope),
      });
    });
  }
  for (const group of rig.floorFx) {
    for (let i = 0; i < group.count; i++) {
      const x = floorUnitX(group, i);
      out.push({
        group, index: i, floor: true,
        position: { x, y: stageSurfaceHeight(rig, x, group.z), z: group.z },
        yaw: 0,
        ...unit(group, i, FLOOR_FIXTURE_SCOPE),
      });
    }
  }
  return out;
}

export function resolvedPatchSnapshot(patch: DmxPatch) {
  const placed = new Set(placeFixtures(patch.rig, patch).map(({ patch: unit }) => unit.unitId));
  return patch.units.map((unit) => ({ ...unit, scope: [...unit.scope], placed: placed.has(unit.unitId) }));
}
