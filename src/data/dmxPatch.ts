import type { FixtureType, FloorFxType, FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG } from './presets';

type Group = MountedFixtureGroup | FloorFxUnit;
type Hardware = FixtureType | FloorFxType;
type Universe = 1 | 2;
const equipment = { ...FIXTURE_CATALOG, ...FLOOR_FX_CATALOG };
const moving = ['Pan', 'Tilt', 'Dimmer', 'Red', 'Green', 'Blue', 'Zoom', 'Strobe rate'];
const laser = [
  'Intensity',
  'Pattern',
  'Spread X',
  'Spread Y',
  'Speed',
  'Rotation',
  'Beam count',
  'Strobe rate',
];
export const DMX_CHANNELS: Record<Hardware, string[]> = {
  beam: moving,
  wash: moving,
  floor_beam: moving,
  laser,
  floor_laser: laser,
  strobe: ['Dimmer', 'Strobe rate'],
  blinder: ['Dimmer'],
  co2: ['Jet output'],
  smoke: ['Smoke output'],
  hazer: ['Haze output'],
};

export function buildDmxPatch(rig: RigConfig) {
  const groups = [
    ...rig.trussPods.flatMap((p) => p.fixtures.map((g) => ({ group: g as Group, location: p.name }))),
    ...rig.floorFx.map((g) => ({ group: g as Group, location: 'Stage floor' })),
  ].map(({ group, location }) => {
    const width = equipment[group.type].dmxFootprint;
    return {
      group,
      location,
      width,
      start: group.dmxStartChannel,
      end: group.dmxStartChannel + width * group.count - 1,
    };
  });
  const claimed = { 1: new Uint16Array(513), 2: new Uint16Array(513) };
  for (const row of groups) {
    const slots = claimed[row.group.dmxUniverse];
    for (let n = row.start; n <= Math.min(512, row.end); n++) slots[n]++;
  }
  const rows = groups.map((row) => {
    const slots = claimed[row.group.dmxUniverse];
    const conflicts: number[] = [];
    for (let n = row.start; n <= Math.min(512, row.end); n++) if (slots[n] > 1) conflicts.push(n);
    return { ...row, conflicts };
  });
  function unitStart(group: Group, index: number) {
    const width = equipment[group.type].dmxFootprint;
    const start = group.dmxStartChannel + index * width;
    const slots = claimed[group.dmxUniverse];
    if (start < 1 || start + width - 1 > 512) return 0;
    for (let n = start; n < start + width; n++) if (slots[n] !== 1) return 0;
    return start;
  }
  return { rows, claimed, unitStart };
}

export function allocateDmx(
  rig: RigConfig,
  type: Hardware,
  count: number,
  preferred: Universe,
  extend?: Group,
) {
  const { claimed } = buildDmxPatch(rig);
  const width = equipment[type].dmxFootprint;
  const needed = count * width;
  const next = extend && extend.dmxStartChannel + extend.count * width;
  if (next && next + needed <= 513 && !claimed[preferred].subarray(next, next + needed).some(Boolean)) {
    return { dmxUniverse: preferred, dmxStartChannel: next, extendsGroup: true };
  }
  const order: Universe[] = [preferred, preferred === 1 ? 2 : 1];
  for (const dmxUniverse of order) {
    let consecutive = 0;
    for (let n = 1; n <= 512; n++) {
      consecutive = claimed[dmxUniverse][n] ? 0 : consecutive + 1;
      if (consecutive === needed)
        return { dmxUniverse, dmxStartChannel: n - needed + 1, extendsGroup: false };
    }
  }
}

export function addPatchedUnits<G extends Group>(
  rig: RigConfig,
  groups: G[],
  addition: G,
  extend?: G,
): G[] | undefined {
  const patch = allocateDmx(
    rig,
    addition.type,
    addition.count,
    extend?.dmxUniverse ?? addition.dmxUniverse,
    extend,
  );
  if (!patch) return;
  if (patch.extendsGroup && extend) {
    return groups.map((g) => {
      if (g !== extend) return g;
      const count = g.count + addition.count;
      if ('spread' in g && g.count === 1 && g.spread === 0) {
        // Leave the first emitter where the split placed it and grow to its right.
        const spread = Math.min(rig.stageWidth / 6, 2) * (count - 1);
        return { ...g, count, spread, x: g.x + spread / 2 };
      }
      return { ...g, count };
    });
  }
  const next = { ...addition, dmxUniverse: patch.dmxUniverse, dmxStartChannel: patch.dmxStartChannel };
  if (extend && 'spread' in extend && 'spread' in next) {
    // A split address block still occupies the same evenly spaced row on the deck.
    const spacing = extend.spread / (extend.count + next.count - 1) || Math.min(rig.stageWidth / 6, 2);
    const left = extend.x - extend.spread / 2;
    const span = spacing * (extend.count - 1);
    next.spread = spacing * (next.count - 1);
    next.x = left + spacing * extend.count + next.spread / 2;
    return [...groups.map((g) => (g === extend ? { ...g, x: left + span / 2, spread: span } : g)), next];
  }
  return [...groups, next];
}
