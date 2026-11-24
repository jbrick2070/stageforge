import type { NativeStage } from './showFile';
import { makeShowFile } from './showFile';
import type { PlanPoint, RigConfig, TrussPodConfig } from '../types/show';
import { GRID_HEIGHT } from './stageEquipment';
import { INITIAL_SHOW_STATE } from './presets';
import {
  defaultSpeakerHangs,
  ensureNativeStage,
  isCustomMainWall,
  MAX_STAGE_HANGS,
  MAX_STAGE_WALLS,
  MAX_WALL_WIDTH,
  pruneNativeStage,
  removeStageWall,
  resolveWallFrame,
  setAuthoredHangs,
  upsertStageWall,
  type LayoutProp,
  type SpeakerHang,
  type StageWall,
  type WallFrame,
} from './studioGeometry';

/**
 * 2D plan authoring for the show's stage overlay (v3 `stage`: walls, speaker hangs, layout trusses and props).
 *
 * Plan coordinates are the world X/Z floor plane, audience toward +Z, drawn with +Z down the screen.
 * Yaw is a rotation about +Y (right-handed, Y up), so an object's front (+Z) faces
 * (sin yaw, cos yaw) on the plan and its local +X (a wall's width) runs along (cos yaw, −sin yaw).
 * StageEngine, StageScreens and stageDxf use the same convention, as does the v3 format.
 */

export type StageLayout = NonNullable<NativeStage['layout']>;
export type LayoutTruss = NonNullable<StageLayout['trusses']>[number];

/** Matches the schema's per-list maximum for layout trusses, hangs and props. */
export const MAX_LAYOUT_ITEMS = 128;
/** A layout truss needs its ends at least this far apart (the v3 format's authoring rule). */
export const MIN_LAYOUT_SPAN = 0.5;

const round3 = (n: number) => Number(n.toFixed(3));
const coord = (n: number) => round3(Math.max(-10000, Math.min(10000, n)));
const dimension = (n: number, min = 0.01, max = 1000) => round3(Math.max(min, Math.min(max, n)));
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Normalise an angle in degrees to −180 … 180. */
export function wrapDegrees(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return round3(wrapped === -180 && deg > 0 ? 180 : wrapped);
}

/** Unit vector a yawed front faces on the plan. */
export function facing(yawDeg: number): PlanPoint {
  return { x: Math.sin(toRad(yawDeg)), z: Math.cos(toRad(yawDeg)) };
}

/** Unit vector of a yawed object's local +X (a wall's width) on the plan. */
export function widthAxis(yawDeg: number): PlanPoint {
  return { x: Math.cos(toRad(yawDeg)), z: -Math.sin(toRad(yawDeg)) };
}

/** Yaw that turns an object at `from` to face `at`, optionally snapped to `stepDeg`. */
export function yawToward(from: PlanPoint, at: PlanPoint, stepDeg = 0): number {
  const deg = (Math.atan2(at.x - from.x, at.z - from.z) * 180) / Math.PI;
  return wrapDegrees(stepDeg > 0 ? Math.round(deg / stepDeg) * stepDeg : deg);
}

export interface PlanWall {
  wall: StageWall;
  frame: WallFrame;
  primary: boolean;
  /** main-led drawn from the rig's stock placement (no authored position or size). */
  stock: boolean;
}

/** Walls drawn on the plan: the rig's main LED wall (stock or custom) plus every secondary wall. */
export function planWalls(rig: RigConfig, stage?: NativeStage): PlanWall[] {
  const walls = stage?.walls ?? [];
  const main = walls.find(w => w.id === 'main-led') ?? { id: 'main-led' };
  const out: PlanWall[] = [];
  if (rig.ledWall.enabled || isCustomMainWall(main)) {
    out.push({ wall: main, frame: resolveWallFrame(rig, main), primary: true, stock: !isCustomMainWall(main) });
  }
  for (const wall of walls) {
    if (wall.id !== 'main-led') out.push({ wall, frame: resolveWallFrame(rig, wall), primary: false, stock: false });
  }
  return out;
}

/**
 * The wall entry to edit. Authoring the stock main wall pins its whole resolved frame,
 * so a later rig edit (stage depth, LED size) doesn't shift a wall the user placed.
 */
export function authorWall(entry: PlanWall): StageWall {
  if (!entry.primary || !entry.stock) return entry.wall;
  const { frame } = entry;
  return { id: 'main-led', ...(entry.wall.label ? { label: entry.wall.label } : {}), x: frame.x, y: frame.y, z: frame.z,
    width: frame.width, height: frame.height, yaw: frame.yaw };
}

const WALL_GEOMETRY = ['x', 'y', 'z', 'width', 'height', 'yaw'] as const;

/**
 * Apply a patch to a plan wall. Only geometry edits pin the stock main wall's frame;
 * a label-only edit keeps it following the rig's LED placement.
 */
export function patchWall(entry: PlanWall, patch: Partial<StageWall>): StageWall {
  const moves = WALL_GEOMETRY.some(key => key in patch);
  return { ...(moves ? authorWall(entry) : entry.wall), ...patch };
}

/** The schema caps a stage at 8 wall entries, so a stock main wall can only be authored while there is room for its entry. */
export function canAuthorWall(entry: PlanWall, stage?: NativeStage): boolean {
  return !entry.primary || stage?.walls.some(w => w.id === 'main-led') === true || (stage?.walls.length ?? 0) < MAX_STAGE_WALLS;
}

/** Width handle (node 0) at the wall's right edge and aim handle (node 1) in front of it. */
export function wallHandles(frame: WallFrame): [PlanPoint, PlanPoint] {
  const axis = widthAxis(frame.yaw), front = facing(frame.yaw);
  const reach = Math.max(1.2, frame.width * 0.35);
  return [
    { x: frame.x + axis.x * frame.width / 2, z: frame.z + axis.z * frame.width / 2 },
    { x: frame.x + front.x * reach, z: frame.z + front.z * reach },
  ];
}

/** Hangs in effect: authored layout hangs, or the rig's stock flown arrays (none when the layout replaces the rig). */
export function effectiveHangs(rig: RigConfig, stage?: NativeStage): { hangs: SpeakerHang[]; authored: boolean } {
  const layout = stage?.layout;
  if (layout?.hangs) return { hangs: layout.hangs, authored: true };
  return { hangs: layout?.replace ? [] : defaultSpeakerHangs(rig), authored: false };
}

export const HANG_AIM_REACH = 1.5;
/** Nominal horizontal coverage drawn for a line array (±45°, i.e. a 90° box). */
export const HANG_COVERAGE_DEG = 90;

export function hangAimHandle(hang: SpeakerHang): PlanPoint {
  const f = facing(hang.yaw);
  return { x: hang.x + f.x * HANG_AIM_REACH, z: hang.z + f.z * HANG_AIM_REACH };
}

function withLayout(rig: RigConfig, stage: NativeStage | undefined, edit: (layout: StageLayout) => StageLayout): NativeStage {
  const next = ensureNativeStage(rig, stage);
  const layout = edit({ ...next.layout });
  if (!layout.trusses?.length) delete layout.trusses;
  if (!layout.props?.length) delete layout.props;
  if (layout.replace !== true) delete layout.replace;
  if (layout.replace === true || layout.hangs !== undefined || layout.trusses || layout.props) next.layout = layout;
  else delete next.layout;
  return next;
}

/** Toggle native `layout.replace`: hide the rig's decks, trusses, floor effects and stock arrays. */
export function setLayoutReplace(rig: RigConfig, stage: NativeStage | undefined, replace: boolean): NativeStage {
  return withLayout(rig, stage, layout => ({ ...layout, replace: replace || undefined }));
}

export function setHangs(rig: RigConfig, stage: NativeStage | undefined, hangs: SpeakerHang[] | undefined): NativeStage {
  return setAuthoredHangs(rig, stage, hangs) ?? ensureNativeStage(rig);
}

export function newHang(rig: RigConfig, at: PlanPoint): SpeakerHang {
  const y = round3(Math.max(2, Math.min(GRID_HEIGHT[rig.venue] - 1.65, 11.65)));
  const count = Math.max(1, Math.min(16, Math.round(rig.audioRig.boxesPerSide ?? 4)));
  return { x: coord(at.x), y, z: coord(at.z), yaw: 0, tilt: 0, count, splay: 4 };
}

export function setLayoutTrusses(rig: RigConfig, stage: NativeStage | undefined, trusses: LayoutTruss[]): NativeStage {
  return withLayout(rig, stage, layout => ({
    ...layout,
    trusses: trusses.slice(0, MAX_LAYOUT_ITEMS).map(t => ({
      x: coord(t.x), z: coord(t.z), endX: coord(t.endX), endZ: coord(t.endZ), height: dimension(t.height),
    })),
  }));
}

export function setLayoutProps(rig: RigConfig, stage: NativeStage | undefined, props: LayoutProp[]): NativeStage {
  return withLayout(rig, stage, layout => ({
    ...layout,
    props: props.slice(0, MAX_LAYOUT_ITEMS).map(p => ({
      x: coord(p.x), z: coord(p.z), type: p.type === 'scenic' ? 'scenic' : 'inflatable', height: dimension(p.height),
    })),
  }));
}

export function spanLength(t: LayoutTruss): number {
  return Math.hypot(t.endX - t.x, t.endZ - t.z);
}

/**
 * Turn a native layout truss into an editable rig truss pod with the same world geometry
 * resolveStudioGeometry renders (box truss, rotationY = −atan2(dz, dx), fixed height).
 */
export function convertLayoutTruss(rig: RigConfig, stage: NativeStage | undefined, index: number): { rig: RigConfig; stage: NativeStage } | null {
  const span = stage?.layout?.trusses?.[index];
  if (!span || stage?.layout?.replace) return null;
  const dx = span.endX - span.x, dz = span.endZ - span.z;
  const width = Math.hypot(dx, dz);
  if (width < MIN_LAYOUT_SPAN) return null;
  const ids = new Set(rig.trussPods.map(p => p.id));
  let n = rig.trussPods.length + 1, id = `truss-${n}`;
  while (ids.has(id)) id = `truss-${++n}`;
  const pod: TrussPodConfig = {
    id, name: `Converted truss ${n}`, shape: 'box', width: round3(width),
    x: round3((span.x + span.endX) / 2), z: round3((span.z + span.endZ) / 2), rotationY: -Math.atan2(dz, dx),
    baseY: span.height, motorized: false, motorMinY: span.height, motorMaxY: span.height, fixtures: [],
  };
  const trusses = stage!.layout!.trusses!.filter((_, i) => i !== index);
  return { rig: { ...rig, trussPods: [...rig.trussPods, pod] }, stage: setLayoutTrusses(rig, stage, trusses) };
}

export type PlanItemKind = 'wall' | 'hang' | 'span' | 'prop';
export interface PlanItem { kind: PlanItemKind; id: string; node?: number }

/**
 * Move a stage overlay item on the plan (whole item, or one of its handles).
 * Walls: node 0 resizes the width about the centre, node 1 aims the front.
 * Hangs: node 0 aims the array. Layout trusses: nodes 0/1 move the start/end.
 */
export function moveStageItem(
  rig: RigConfig, stage: NativeStage | undefined, item: PlanItem, from: PlanPoint, at: PlanPoint, angleStep = 0,
): NativeStage | undefined {
  const dx = at.x - from.x, dz = at.z - from.z;
  if (item.kind === 'wall') {
    const entry = planWalls(rig, stage).find(w => w.wall.id === item.id);
    if (!entry) return stage;
    const { frame } = entry;
    let patch: Partial<StageWall>;
    if (item.node === 0) {
      const axis = widthAxis(frame.yaw);
      const half = Math.abs((at.x - frame.x) * axis.x + (at.z - frame.z) * axis.z);
      patch = { width: Math.max(0.2, Math.min(MAX_WALL_WIDTH, 2 * half)) };
    } else if (item.node === 1) {
      patch = { yaw: yawToward(frame, at, angleStep) };
    } else {
      patch = { x: frame.x + dx, z: frame.z + dz };
    }
    return upsertStageWall(rig, stage, patchWall(entry, patch));
  }
  const index = Number(item.id);
  if (item.kind === 'hang') {
    const { hangs } = effectiveHangs(rig, stage);
    const hang = hangs[index];
    if (!hang) return stage;
    const moved = item.node === 0
      ? { ...hang, yaw: yawToward(hang, at, angleStep) }
      : { ...hang, x: hang.x + dx, z: hang.z + dz };
    return setHangs(rig, stage, hangs.map((h, i) => (i === index ? moved : h)));
  }
  if (item.kind === 'span') {
    const trusses = stage?.layout?.trusses ?? [];
    const span = trusses[index];
    if (!span) return stage;
    const moved = item.node === 0 ? { ...span, x: at.x, z: at.z }
      : item.node === 1 ? { ...span, endX: at.x, endZ: at.z }
      : { ...span, x: span.x + dx, z: span.z + dz, endX: span.endX + dx, endZ: span.endZ + dz };
    if (spanLength(moved) < MIN_LAYOUT_SPAN) return stage;
    return setLayoutTrusses(rig, stage, trusses.map((t, i) => (i === index ? moved : t)));
  }
  const props = stage?.layout?.props ?? [];
  const prop = props[index];
  if (!prop) return stage;
  return setLayoutProps(rig, stage, props.map((p, i) => (i === index ? { ...p, x: p.x + dx, z: p.z + dz } : p)));
}

/** Remove a stage overlay item. Removing a wall also drops its screen events; main-led only resets. */
export function removeStageItem(rig: RigConfig, stage: NativeStage | undefined, item: PlanItem): NativeStage | undefined {
  if (item.kind === 'wall') {
    if (item.id !== 'main-led') return removeStageWall(rig, stage, item.id) ?? ensureNativeStage(rig);
    const label = stage?.walls.find(w => w.id === 'main-led')?.label;
    return upsertStageWall(rig, stage, { id: 'main-led', ...(label ? { label } : {}) });
  }
  const index = Number(item.id);
  if (item.kind === 'hang') return setHangs(rig, stage, effectiveHangs(rig, stage).hangs.filter((_, i) => i !== index));
  if (item.kind === 'span') return setLayoutTrusses(rig, stage, (stage?.layout?.trusses ?? []).filter((_, i) => i !== index));
  return setLayoutProps(rig, stage, (stage?.layout?.props ?? []).filter((_, i) => i !== index));
}

/**
 * Room for another secondary screen. The rig's LED wall reserves its entry while it is shown,
 * so the main wall can still be authored once all secondary screens are placed.
 */
export function canAddWall(rig: RigConfig, stage?: NativeStage): boolean {
  const entries = stage?.walls.length ?? 0;
  const reserved = rig.ledWall.enabled && !stage?.walls.some(w => w.id === 'main-led') ? 1 : 0;
  return entries + reserved < MAX_STAGE_WALLS;
}

export function canAddHang(rig: RigConfig, stage?: NativeStage): boolean {
  return effectiveHangs(rig, stage).hangs.length < MAX_STAGE_HANGS;
}

/** Plan points worth framing: every wall edge, hang, layout truss end and prop. */
export function stagePlanPoints(rig: RigConfig, stage?: NativeStage): PlanPoint[] {
  const points: PlanPoint[] = [];
  for (const { frame } of planWalls(rig, stage)) {
    const axis = widthAxis(frame.yaw);
    for (const s of [-1, 1]) points.push({ x: frame.x + s * axis.x * frame.width / 2, z: frame.z + s * axis.z * frame.width / 2 });
  }
  for (const h of effectiveHangs(rig, stage).hangs) points.push(h, hangAimHandle(h));
  for (const t of stage?.layout?.trusses ?? []) points.push({ x: t.x, z: t.z }, { x: t.endX, z: t.endZ });
  for (const p of stage?.layout?.props ?? []) points.push(p);
  return points;
}

/**
 * Prepare the stage for Apply: drop an empty overlay, and prove it round-trips through the
 * v3 show schema with this rig (throws with the schema reader's message otherwise).
 */
export function finalizeStage(rig: RigConfig, stage: NativeStage | undefined): NativeStage | undefined {
  const pruned = pruneNativeStage(stage && structuredClone(stage));
  if (!pruned) return undefined;
  const ids = new Set<string>();
  for (const wall of pruned.walls) {
    if (ids.has(wall.id)) throw new Error(`Two screens share the ID "${wall.id}".`);
    ids.add(wall.id);
  }
  makeShowFile(rig, [], INITIAL_SHOW_STATE, null, undefined, undefined, undefined, pruned);
  return pruned;
}
