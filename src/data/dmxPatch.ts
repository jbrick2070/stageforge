import type { FixtureType, FloorFxType, FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG } from './presets';

type Group = MountedFixtureGroup | FloorFxUnit;
type Hardware = FixtureType | FloorFxType;
type Universe = 1 | 2;
export type FootprintTarget = Hardware | { type: Hardware; dmxChannels?: number };

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

/** Write simulated control channel values clamped strictly to the unit's patched DMX footprint (1..512). */
export function writeDmxChannels(
  buffer: Uint8Array,
  start: number,
  width: number,
  values: readonly number[],
): void {
  const ch = start - 1;
  if (ch < 0 || width <= 0) return;
  const limit = Math.min(width, values.length, buffer.length - ch);
  for (let i = 0; i < limit; i++) {
    buffer[ch + i] = values[i];
  }
}

/** Effective DMX channel footprint per fixture unit for a group or target spec. */
export function groupFootprint(group: Pick<Group, 'type' | 'dmxChannels'>): number {
  return group.dmxChannels ?? equipment[group.type].dmxFootprint;
}

function sameGroupSignature(a: Group, b: Group): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.dmxUniverse === b.dmxUniverse &&
    a.dmxStartChannel === b.dmxStartChannel &&
    a.count === b.count &&
    ('spread' in a) === ('spread' in b)
  );
}

export function buildDmxPatch(rig: RigConfig, exclude?: Group) {
  const all = [
    ...rig.trussPods.flatMap((p) => p.fixtures.map((g) => ({ group: g as Group, location: p.name }))),
    ...rig.floorFx.map((g) => ({ group: g as Group, location: 'Stage floor' })),
  ];
  const hasExactExclude = exclude !== undefined && all.some(({ group }) => group === exclude);
  let excludedClone = false;
  const groups = all
    .filter(({ group }) => {
      if (!exclude) return true;
      if (hasExactExclude) return group !== exclude;
      if (!excludedClone && sameGroupSignature(group, exclude)) {
        excludedClone = true;
        return false;
      }
      return true;
    })
    .map(({ group, location }) => {
      const width = groupFootprint(group);
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
    const width = groupFootprint(group);
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
  target: FootprintTarget,
  count: number,
  preferred: Universe,
  extend?: Group,
  exclude?: Group,
) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  const type = typeof target === 'string' ? target : target.type;
  const width = typeof target === 'string' ? equipment[target].dmxFootprint : groupFootprint(target);
  if (!Number.isSafeInteger(width) || width < 1 || width > 512) return;
  const needed = count * width;
  if (needed > 512) return;
  const { claimed } = buildDmxPatch(rig, exclude);
  const canExtend =
    extend &&
    extend !== exclude &&
    extend.type === type &&
    groupFootprint(extend) === width &&
    extend.dmxUniverse === preferred;
  const next = canExtend ? extend.dmxStartChannel + extend.count * groupFootprint(extend) : undefined;
  if (next && next >= 1 && next + needed <= 513 && !claimed[preferred].subarray(next, next + needed).some(Boolean)) {
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
  const compatibleExtend =
    extend &&
    extend.type === addition.type &&
    extend.catalogId === addition.catalogId &&
    extend.dmxMode === addition.dmxMode &&
    extend.dmxChannels === addition.dmxChannels
      ? extend
      : undefined;
  const patch = allocateDmx(
    rig,
    { type: addition.type, dmxChannels: addition.dmxChannels },
    addition.count,
    compatibleExtend?.dmxUniverse ?? addition.dmxUniverse,
    compatibleExtend,
  );
  if (!patch) return;
  if (patch.extendsGroup && compatibleExtend) {
    return groups.map((g) => {
      if (g !== compatibleExtend) return g;
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
  if (compatibleExtend && 'spread' in compatibleExtend && 'spread' in next) {
    // A split address block still occupies the same evenly spaced row on the deck.
    const spacing = compatibleExtend.spread / (compatibleExtend.count + next.count - 1) || Math.min(rig.stageWidth / 6, 2);
    const left = compatibleExtend.x - compatibleExtend.spread / 2;
    const span = spacing * (compatibleExtend.count - 1);
    next.spread = spacing * (next.count - 1);
    next.x = left + spacing * compatibleExtend.count + next.spread / 2;
    return [...groups.map((g) => (g === compatibleExtend ? { ...g, x: left + span / 2, spread: span } : g)), next];
  }
  return [...groups, next];
}

export interface GroupModelUpdate {
  modelName: string;
  catalogId?: string;
  dmxMode?: string;
  dmxChannels?: number;
}

export type RepatchResult<G extends Group> =
  | { ok: true; moved: boolean; group: G; width: number }
  | { ok: false; reason: string };

function withModelUpdate<G extends Group>(group: G, update: GroupModelUpdate): G {
  const next: G = { ...group, modelName: update.modelName };
  const modelChanged = update.catalogId !== group.catalogId;
  if (update.catalogId !== undefined) next.catalogId = update.catalogId;
  else delete next.catalogId;
  if (update.dmxMode !== undefined) next.dmxMode = update.dmxMode;
  else delete next.dmxMode;
  if (update.dmxChannels !== undefined) next.dmxChannels = update.dmxChannels;
  else delete next.dmxChannels;
  // Switching to a different model clears stale per-model optics overrides so the new model's optics apply.
  if (modelChanged) delete next.optics;
  return next;
}

/**
 * Apply a catalogue model / DMX mode change to an existing group without creating conflicts or overflows.
 * Keeps the current address if the new span fits; otherwise relocates cleanly (same universe first, then other).
 */
export function repatchGroup<G extends Group>(
  rig: RigConfig,
  group: G,
  update: GroupModelUpdate,
): RepatchResult<G> {
  const width = groupFootprint({ type: group.type, dmxChannels: update.dmxChannels });
  if (!Number.isSafeInteger(width) || width < 1 || width > 512) {
    return { ok: false, reason: 'Invalid DMX channel footprint.' };
  }
  const needed = width * group.count;
  if (needed > 512) {
    return { ok: false, reason: `Not enough free channels in U1–U2 (${width} ch × ${group.count} exceeds 512).` };
  }
  const { claimed } = buildDmxPatch(rig, group);
  const start = group.dmxStartChannel;
  const end = start + needed - 1;
  if (start >= 1 && end <= 512 && !claimed[group.dmxUniverse].subarray(start, end + 1).some(Boolean)) {
    return { ok: true, moved: false, group: withModelUpdate(group, update), width };
  }
  const relocated = allocateDmx(rig, { type: group.type, dmxChannels: update.dmxChannels }, group.count, group.dmxUniverse, undefined, group);
  if (!relocated) {
    return { ok: false, reason: 'Not enough free channels in U1–U2.' };
  }
  return {
    ok: true,
    moved: true,
    group: {
      ...withModelUpdate(group, update),
      dmxUniverse: relocated.dmxUniverse,
      dmxStartChannel: relocated.dmxStartChannel,
    },
    width,
  };
}
