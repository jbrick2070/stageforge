import { buildDmxPatch, DMX_CHANNELS } from './dmxPatch';
import { formatCsv } from './csv';
import type { RigConfig } from '../types/show';

export function patchCsv(rig: RigConfig) {
  const patch = buildDmxPatch(rig);
  const lines: (string | number)[][] = [['Location', 'Group ID', 'Fixture', 'Unit', 'Universe', 'Address', 'Offset', 'Function', 'Output']];
  for (const { group, location, width, scope } of patch.rows) {
    for (let unit = 0; unit < group.count; unit++) {
      const record = patch.unitFor(group, unit, scope)!;
      for (let offset = 0; offset < width; offset++) {
        lines.push([location, group.id, group.modelName, unit + 1, record.universe,
          record.start + offset, offset + 1, DMX_CHANNELS[group.type][offset] ?? 'Reserved', record.effectiveStart ? 'Enabled' : 'Disabled']);
      }
    }
  }
  return formatCsv(lines, { quoteAll: true });
}
