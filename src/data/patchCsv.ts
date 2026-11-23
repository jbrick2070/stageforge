import { buildDmxPatch, DMX_CHANNELS } from './dmxPatch';
import type { RigConfig } from '../types/show';

export function patchCsv(rig: RigConfig) {
  const patch = buildDmxPatch(rig);
  const lines: (string | number)[][] = [['Location', 'Group ID', 'Fixture', 'Unit', 'Universe', 'Address', 'Offset', 'Function', 'Output']];
  for (const { group, location, width } of patch.rows) {
    for (let unit = 0; unit < group.count; unit++) {
      const enabled = Boolean(patch.unitStart(group, unit));
      for (let offset = 0; offset < width; offset++) {
        lines.push([location, group.id, group.modelName, unit + 1, group.dmxUniverse,
          group.dmxStartChannel + unit * width + offset, offset + 1, DMX_CHANNELS[group.type][offset] ?? 'Reserved', enabled ? 'Enabled' : 'Disabled']);
      }
    }
  }
  const cell = (v: string | number) => {
    const text = typeof v === 'string' && /^[=+@\-\t\r]/.test(v) ? "'" + v : String(v);
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return lines.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
