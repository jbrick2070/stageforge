import type { FixtureType, FloorFxType, FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG } from './presets';

type Group = MountedFixtureGroup | FloorFxUnit;
type Hardware = FixtureType | FloorFxType;
type Universe = 1 | 2;
export type FootprintTarget = Hardware | { type: Hardware; dmxChannels?: number };

export type FixtureScope = readonly ['pod', string] | readonly ['floor'];
export const FLOOR_FIXTURE_SCOPE: FixtureScope = ['floor'];

export function fixtureScope(podId?: string | null): FixtureScope {
  return podId == null ? FLOOR_FIXTURE_SCOPE : ['pod', podId];
}

export function fixtureGroupKey(scope: FixtureScope, groupId: string): string {
  return JSON.stringify([...scope, groupId]);
}

export function fixtureUnitKey(scope: FixtureScope, groupId: string, ordinal: number): string {
  return JSON.stringify([...scope, groupId, ordinal]);
}

export interface FixturePatchUnit {
  readonly scope: FixtureScope;
  readonly groupId: string;
  readonly groupKey: string;
  readonly unitId: string;
  readonly ordinal: number;
  readonly universe: Universe;
  readonly start: number;
  readonly width: number;
  readonly end: number;
  readonly conflict: boolean;
  readonly overflow: boolean;
  readonly effectiveStart: number;
}

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

/** Format a DMX universe and 1-based channel as the canonical StageForge patch label (e.g. `U1.001`). */
export function formatDmxLabel(universe: 1 | 2, address: number): string {
  return `U${universe}.${String(address).padStart(3, '0')}`;
}

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
    groupFootprint(a) === groupFootprint(b) &&
    ('spread' in a) === ('spread' in b)
  );
}

export function buildDmxPatch(rig: RigConfig, exclude?: Group, excludeScope?: FixtureScope) {
  const all = [
    ...rig.trussPods.flatMap((p) => {
      const scope = fixtureScope(p.id);
      return p.fixtures.map((g) => ({ group: g as Group, location: p.name, scope }));
    }),
    ...rig.floorFx.map((g) => ({ group: g as Group, location: 'Stage floor', scope: FLOOR_FIXTURE_SCOPE })),
  ];
  let excluded: (typeof all)[number] | undefined;
  let exclusionIssue: string | undefined;
  if (exclude) {
    const candidates = excludeScope
      ? all.filter(({ scope }) => scope[0] === excludeScope[0] && scope[1] === excludeScope[1])
      : all;
    const exact = candidates.filter(({ group }) => group === exclude);
    // A known reference in a different scope is a caller error, not a request to exclude a clone.
    const knownOutsideScope = excludeScope && exact.length === 0 && all.some(({ group }) => group === exclude);
    const matches = exact.length || knownOutsideScope
      ? exact
      : candidates.filter(({ group }) => sameGroupSignature(group, exclude));
    if (matches.length === 1) excluded = matches[0];
    else if (matches.length > 1) exclusionIssue = 'Patch edit is ambiguous. Select the fixture group by truss or Stage floor.';
    else if (excludeScope) exclusionIssue = 'Fixture group not found in the selected patch scope.';
  }
  const groups = all
    .filter((entry) => entry !== excluded)
    .map(({ group, location, scope }) => {
      const width = groupFootprint(group);
      return {
        group,
        location,
        scope,
        width,
        start: group.dmxStartChannel,
        end: group.dmxStartChannel + width * group.count - 1,
      };
    });
  const claimed = { 1: new Uint16Array(513), 2: new Uint16Array(513) };
  for (const row of groups) {
    const slots = claimed[row.group.dmxUniverse];
    for (let n = Math.max(1, Math.ceil(row.start)); n <= Math.min(512, row.end); n++) slots[n]++;
  }
  const makeRows = () => groups.map((row) => {
    const slots = claimed[row.group.dmxUniverse];
    const conflicts: number[] = [];
    for (let n = Math.max(1, Math.ceil(row.start)); n <= Math.min(512, row.end); n++) if (slots[n] > 1) conflicts.push(n);
    return { ...row, groupKey: fixtureGroupKey(row.scope, row.group.id), conflicts };
  });
  let rows: ReturnType<typeof makeRows> | undefined;

  function occupancy(universe: Universe, start: number, end: number) {
    const overflow = !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > 512 || end < start;
    const slots = claimed[universe];
    let conflict = false;
    let unclaimed = false;
    for (let n = Math.max(1, Math.ceil(start)); n <= Math.min(512, end); n++) {
      if (slots[n] > 1) conflict = true;
      if (slots[n] === 0) unclaimed = true;
    }
    return { conflict, overflow, effectiveStart: overflow || conflict || unclaimed ? 0 : start };
  }

  type UnitsByScope = Map<string | null, FixturePatchUnit[]>;
  let records: { units: FixturePatchUnit[]; byGroup: Map<Group, UnitsByScope> } | undefined;
  function resolvedRecords() {
    if (records) return records;
    const units: FixturePatchUnit[] = [];
    const byGroup = new Map<Group, UnitsByScope>();
    const groupRows = rows ??= makeRows();
    for (const { group, scope, width, groupKey } of groupRows) {
      const members: FixturePatchUnit[] = [];
      let byScope = byGroup.get(group);
      if (!byScope) byGroup.set(group, byScope = new Map());
      byScope.set(scope[1] ?? null, members);
      for (let ordinal = 0; ordinal < group.count; ordinal++) {
        const start = group.dmxStartChannel + ordinal * width;
        const end = start + width - 1;
        const unit = {
          scope, groupKey, groupId: group.id, unitId: fixtureUnitKey(scope, group.id, ordinal), ordinal,
          universe: group.dmxUniverse, start, end, width, ...occupancy(group.dmxUniverse, start, end),
        };
        units.push(unit);
        members.push(unit);
      }
    }
    return records = { units, byGroup };
  }

  return {
    rig, claimed, exclusionIssue,
    get rows() { return rows ??= makeRows(); },
    get units(): readonly FixturePatchUnit[] { return resolvedRecords().units; },
    unitFor(group: Group, ordinal: number, scope?: FixtureScope): FixturePatchUnit | undefined {
      const byScope = resolvedRecords().byGroup.get(group);
      if (scope) return byScope?.get(scope[1] ?? null)?.[ordinal];
      return byScope?.size === 1 ? byScope.values().next().value?.[ordinal] : undefined;
    },
    unitStart(group: Group, ordinal: number): number {
      const width = groupFootprint(group);
      const start = group.dmxStartChannel + ordinal * width;
      return occupancy(group.dmxUniverse, start, start + width - 1).effectiveStart;
    },
  };
}

export type DmxPatch = ReturnType<typeof buildDmxPatch>;

export function allocateDmx(
  rig: RigConfig,
  target: FootprintTarget,
  count: number,
  preferred: Universe,
  extend?: Group,
  exclude?: Group,
  excludeScope?: FixtureScope,
) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  const type = typeof target === 'string' ? target : target.type;
  const width = typeof target === 'string' ? equipment[target].dmxFootprint : groupFootprint(target);
  if (!Number.isSafeInteger(width) || width < 1 || width > 512) return;
  const needed = count * width;
  if (needed > 512) return;
  const { claimed, exclusionIssue } = buildDmxPatch(rig, exclude, excludeScope);
  if (exclusionIssue) return;
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
  return firstFreePatch(claimed, preferred, needed);
}

function firstFreePatch(claimed: DmxPatch['claimed'], preferred: Universe, needed: number) {
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
  scope?: FixtureScope,
): RepatchResult<G> {
  const width = groupFootprint({ type: group.type, dmxChannels: update.dmxChannels });
  if (!Number.isSafeInteger(width) || width < 1 || width > 512) {
    return { ok: false, reason: 'Invalid DMX channel footprint.' };
  }
  const needed = width * group.count;
  if (needed > 512) {
    return { ok: false, reason: `Not enough free channels in U1–U2 (${width} ch × ${group.count} exceeds 512).` };
  }
  const { claimed, exclusionIssue } = buildDmxPatch(rig, group, scope);
  if (exclusionIssue) return { ok: false, reason: exclusionIssue };
  const start = group.dmxStartChannel;
  const end = start + needed - 1;
  if (start >= 1 && end <= 512 && !claimed[group.dmxUniverse].subarray(start, end + 1).some(Boolean)) {
    return { ok: true, moved: false, group: withModelUpdate(group, update), width };
  }
  const relocated = firstFreePatch(claimed, group.dmxUniverse, needed);
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
