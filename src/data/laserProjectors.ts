import type { LaserResolution, RigConfig } from '../types/show';
import { buildDmxPatch } from './dmxPatch';

export const LASER_RESOLUTIONS: LaserResolution[] = [8, 16, 48, 96];
export const DEFAULT_LASER_RESOLUTION: LaserResolution = 48;
export const DEFAULT_LASER_COLORS = ['#00f0ff', '#ff00aa'] as const;

/** Physical patch addresses may change and group IDs are local to a truss. */
export function laserProjectorKey(podId: string | null, groupId: string, unit: number) {
  return JSON.stringify([podId, groupId, unit]);
}

export function laserProjectors(rig: RigConfig) {
  const patch = buildDmxPatch(rig);
  const groups = [
    ...rig.trussPods.flatMap(pod => pod.fixtures.filter(g => g.type === 'laser')
      .map(group => ({ podId: pod.id as string | null, location: pod.name, group }))),
    ...rig.floorFx.filter(g => g.type === 'floor_laser').map(group => ({ podId: null, location: 'Floor', group })),
  ];
  return groups.flatMap(({ podId, location, group }) => Array.from({ length: group.count }, (_, i) => {
    const address = patch.unitStart(group, i);
    const patchLabel = address ? `U${group.dmxUniverse}.${String(address).padStart(3, '0')}` : 'Unpatched';
    return {
      key: laserProjectorKey(podId, group.id, i + 1),
      label: `${location} · ${group.modelName} #${i + 1} · ${patchLabel}`,
    };
  }));
}
