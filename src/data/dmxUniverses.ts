import type { RigConfig } from '../types/show';

export const PHYSICAL_DMX_UNIVERSES = [1, 2] as const;
export const LOGICAL_DMX_UNIVERSES = [...PHYSICAL_DMX_UNIVERSES, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
export const MAX_LOGICAL_DMX_UNIVERSE = LOGICAL_DMX_UNIVERSES[15];
export const MAX_RIG_FIXTURE_UNITS = 1024;
export type PhysicalDmxUniverse = typeof PHYSICAL_DMX_UNIVERSES[number];
export type LogicalDmxUniverse = typeof LOGICAL_DMX_UNIVERSES[number];

export const isLogicalDmxUniverse = (value: unknown): value is LogicalDmxUniverse =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LOGICAL_DMX_UNIVERSE;
export const isPhysicalDmxUniverse = (value: unknown): value is PhysicalDmxUniverse => value === 1 || value === 2;

export function hasExtendedDmx(rig: RigConfig): boolean {
  const extended = (fixture: { dmxUniverse: number }) => isLogicalDmxUniverse(fixture.dmxUniverse) && !isPhysicalDmxUniverse(fixture.dmxUniverse);
  return rig.floorFx.some(extended) || rig.trussPods.some(pod => pod.fixtures.some(extended));
}

export function countRigFixtureUnits(rig: RigConfig): number {
  let count = 0;
  for (const pod of rig.trussPods) for (const fixture of pod.fixtures) count += fixture.count;
  for (const fixture of rig.floorFx) count += fixture.count;
  return count;
}

export function absoluteDmxAddress(universe: LogicalDmxUniverse, channel: number): number {
  return (universe - 1) * 512 + channel;
}
