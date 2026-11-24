import type { NativeStage } from './showFile';
import type { RigConfig, TrussPodConfig } from '../types/show';
import { GRID_HEIGHT, ledPlacement, type LedSurface } from './stageEquipment';

type StageLayout = NonNullable<NativeStage['layout']>;
export type SpeakerHang = NonNullable<StageLayout['hangs']>[number];
export type LayoutProp = NonNullable<StageLayout['props']>[number];
export type StageWall = NativeStage['walls'][number];
export type SecondaryScreenEvent = NativeStage['screenEvents'][number];

export const MAX_STAGE_WALLS = 8;
export const MAX_STAGE_HANGS = 128;
/** Maximum authored wall-cue timestamp (24 hours in ms). */
export const MAX_WALL_CUE_MS = 24 * 60 * 60 * 1000;
/** Rendered walls clamp to these sizes (inherited from the retired native-v0.1.0 prototype, so its v3 files look the same). */
export const MAX_WALL_WIDTH = 40;
export const MAX_WALL_HEIGHT = 25;

const round3 = (n: number) => Number(n.toFixed(3));
const clamp = (n: number, min: number, max: number) => Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;

/** True when an authored main-led entry moves or resizes the rig's stock wall. */
export function isCustomMainWall(wall?: StageWall): boolean {
  return !!wall && wall.id === 'main-led' && (
    wall.x !== undefined || wall.y !== undefined || wall.z !== undefined ||
    wall.width !== undefined || wall.height !== undefined || wall.yaw !== undefined
  );
}

export interface WallFrame { id: string; label?: string; x: number; y: number; z: number; width: number; height: number; yaw: number }

/**
 * Resolve the physical frame of an authored wall. Secondary walls use the
 * v3 format defaults (0, 2, -2, 3 × 2 m). A partially specified main-led
 * inherits the remaining fields from the rig's stock LED placement.
 */
export function resolveWallFrame(rig: RigConfig, wall: StageWall): WallFrame {
  const primary = wall.id === 'main-led';
  const stock = primary ? ledPlacement(rig) : undefined;
  const sized = !!stock && stock.width > 0 && stock.height > 0;
  return {
    id: wall.id,
    ...(wall.label ? { label: wall.label } : {}),
    x: wall.x ?? (stock ? stock.x : 0),
    y: wall.y ?? (sized ? stock!.y : 2),
    z: wall.z ?? (stock ? stock.z : -2),
    // Clamp so imported oversize walls render, plot and price alike.
    width: clamp(wall.width ?? (sized ? stock!.width : 3), 0.2, MAX_WALL_WIDTH),
    height: clamp(wall.height ?? (sized ? stock!.height : 2), 0.2, MAX_WALL_HEIGHT),
    yaw: wall.yaw ?? 0,
  };
}

/**
 * Pixel/cabinet surface for an authored wall. A custom main-led on a cabinet rig
 * keeps the authored size and counts the cabinets that cover it, so the shader
 * grid, the estimator and the inventory agree.
 */
export function authoredWallSurface(rig: RigConfig, frame: WallFrame): LedSurface & { cabinets: boolean } {
  const panel = frame.id === 'main-led' ? rig.ledWall.cabinets : undefined;
  if (panel) {
    const columns = Math.max(1, Math.round(frame.width * 1000 / panel.widthMm));
    const rows = Math.max(1, Math.round(frame.height * 1000 / panel.heightMm));
    return { width: frame.width, height: frame.height, columns, rows,
      pixelsWide: columns * panel.pixelsWide, pixelsHigh: rows * panel.pixelsHigh, cabinets: true };
  }
  const aspect = frame.width / frame.height;
  return { width: frame.width, height: frame.height, columns: Math.max(1, Math.round(6 * aspect)), rows: 6,
    pixelsWide: 160 * aspect, pixelsHigh: 160, cabinets: false };
}

/** Walls that replace or add physical screens: every secondary wall plus a custom main-led. */
export function authoredWallFrames(rig: RigConfig, stage?: NativeStage): WallFrame[] {
  return (stage?.walls ?? []).filter(w => w.id !== 'main-led' || isCustomMainWall(w)).map(w => resolveWallFrame(rig, w));
}

/** Build default L/R speaker hangs matching StageEngine's stock flown arrays. */
export function defaultSpeakerHangs(rig: RigConfig): SpeakerHang[] {
  if (!rig.audioRig.lineArrays) return [];
  const roofY = GRID_HEIGHT[rig.venue];
  const y = round3(Math.min(roofY - 1.65, 11.65));
  const z = round3(rig.stageDepth / 2 - 0.4);
  const count = clamp(Math.round(rig.audioRig.boxesPerSide ?? 9), 1, 16);
  const halfX = round3(rig.stageWidth / 2 + 1.35);
  return [-1, 1].map(side => ({ x: side * halfX, y, z, yaw: 0, tilt: 0, count, splay: 4 }));
}

export function ensureNativeStage(rig: RigConfig, stage?: NativeStage): NativeStage {
  if (stage) return structuredClone(stage);
  const walls: StageWall[] = rig.ledWall.enabled ? [{ id: 'main-led' }] : [];
  return { format: 'stageforge-native-stage', version: 1, walls, screenEvents: [] };
}

/** Drop an empty stage wrapper so plain v1/v2 rigs stay minimal on export. */
export function pruneNativeStage(stage?: NativeStage): NativeStage | undefined {
  if (!stage) return undefined;
  const hasSecondaryWalls = stage.walls.some(wall => wall.id !== 'main-led');
  const mainWall = stage.walls.find(wall => wall.id === 'main-led');
  const hasCustomMain = isCustomMainWall(mainWall) || mainWall?.label !== undefined;
  const layout = stage.layout;
  const hasLayout = !!layout && (
    layout.replace === true ||
    layout.hangs !== undefined ||
    !!layout.trusses?.length ||
    !!layout.props?.length
  );
  if (!hasSecondaryWalls && !hasCustomMain && !stage.screenEvents.length && !hasLayout) return undefined;
  return stage;
}

export function setAuthoredHangs(rig: RigConfig, stage: NativeStage | undefined, hangs: SpeakerHang[] | undefined): NativeStage | undefined {
  const next = ensureNativeStage(rig, stage);
  const layout: StageLayout = { ...next.layout };
  if (hangs === undefined) delete layout.hangs;
  else layout.hangs = hangs.slice(0, MAX_STAGE_HANGS).map(h => ({
    x: round3(clamp(h.x, -10000, 10000)),
    y: round3(clamp(h.y, -10000, 10000)),
    z: round3(clamp(h.z, -10000, 10000)),
    yaw: round3(clamp(h.yaw, -360, 360)),
    tilt: round3(clamp(h.tilt, -360, 360)),
    count: clamp(Math.round(h.count), 1, 16),
    splay: round3(clamp(h.splay, -360, 360)),
  }));
  const hasLayoutFields = layout.replace === true || layout.hangs !== undefined || !!layout.trusses?.length || !!layout.props?.length;
  if (hasLayoutFields) next.layout = layout;
  else delete next.layout;
  return pruneNativeStage(next);
}

export function createSecondaryWall(rig: RigConfig, stage?: NativeStage): StageWall {
  const existing = new Set((stage?.walls ?? []).map(w => w.id));
  let id = 'side-led';
  let n = 2;
  while (existing.has(id)) id = `wall-${n++}`;
  const secondaryCount = (stage?.walls ?? []).filter(w => w.id !== 'main-led').length;
  const side = secondaryCount % 2 === 0 ? 1 : -1;
  const wall = ledPlacement(rig);
  const x = round3(side * Math.max(wall.width / 2 + 1.4, rig.stageWidth / 2 + 0.25));
  const y = round3(Math.min(GRID_HEIGHT[rig.venue] - 1.3, Math.max(1.8, wall.y)));
  const z = round3(wall.z + 0.9);
  const label = side > 0 ? (secondaryCount === 0 ? 'Stage right' : `Stage right ${Math.floor(secondaryCount / 2) + 1}`)
    : (secondaryCount === 1 ? 'Stage left' : `Stage left ${Math.floor(secondaryCount / 2) + 1}`);
  return { id, label, x, y, z, width: 1.5, height: 2.05, yaw: side * -18 };
}

export function upsertStageWall(rig: RigConfig, stage: NativeStage | undefined, wall: StageWall): NativeStage {
  const next = ensureNativeStage(rig, stage);
  const clean: StageWall = {
    id: wall.id.trim(),
    ...(wall.label?.trim() ? { label: wall.label.trim() } : {}),
    ...(wall.x !== undefined ? { x: round3(clamp(wall.x, -10000, 10000)) } : {}),
    ...(wall.y !== undefined ? { y: round3(clamp(wall.y, -10000, 10000)) } : {}),
    ...(wall.z !== undefined ? { z: round3(clamp(wall.z, -10000, 10000)) } : {}),
    ...(wall.width !== undefined ? { width: round3(clamp(wall.width, 0.2, MAX_WALL_WIDTH)) } : {}),
    ...(wall.height !== undefined ? { height: round3(clamp(wall.height, 0.2, MAX_WALL_HEIGHT)) } : {}),
    ...(wall.yaw !== undefined ? { yaw: round3(clamp(wall.yaw, -360, 360)) } : {}),
  };
  const index = next.walls.findIndex(w => w.id === clean.id);
  if (index >= 0) next.walls[index] = clean;
  else if (next.walls.length < MAX_STAGE_WALLS) next.walls.push(clean);
  return next;
}

export function removeStageWall(rig: RigConfig, stage: NativeStage | undefined, wallId: string): NativeStage | undefined {
  if (!stage || wallId === 'main-led') return stage;
  const next = ensureNativeStage(rig, stage);
  next.walls = next.walls.filter(w => w.id !== wallId);
  next.screenEvents = next.screenEvents.filter(e => e.target !== wallId);
  return pruneNativeStage(next);
}

export function upsertSecondaryScreenEvent(rig: RigConfig, stage: NativeStage | undefined, event: SecondaryScreenEvent): NativeStage {
  const next = ensureNativeStage(rig, stage);
  if (event.target === 'main-led' || !next.walls.some(w => w.id === event.target) || !Number.isFinite(event.atMs)) return next;
  const atMs = Math.max(0, Math.min(MAX_WALL_CUE_MS, Math.round(event.atMs)));
  const name = event.name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 512);
  if (event.kind !== 'none' && !name) return next;
  const safeOffset = Number.isFinite(event.offsetSeconds) ? Math.max(0, Math.min(MAX_WALL_CUE_MS / 1000, event.offsetSeconds!)) : 0;
  const clean: SecondaryScreenEvent = event.kind === 'none'
    ? { atMs, target: event.target, kind: 'none', name: '', playing: false }
    : {
      atMs,
      target: event.target,
      kind: event.kind,
      name,
      playing: event.kind === 'video' ? !!event.playing : false,
      ...(event.kind === 'video' ? { offsetSeconds: round3(safeOffset) } : {}),
    };
  next.screenEvents = [
    ...next.screenEvents.filter(e => !(e.target === clean.target && e.atMs === clean.atMs)),
    clean,
  ].sort((a, b) => a.atMs - b.atMs);
  return next;
}

export function removeSecondaryScreenEvent(rig: RigConfig, stage: NativeStage | undefined, target: string, atMs: number): NativeStage | undefined {
  if (!stage) return stage;
  const next = ensureNativeStage(rig, stage);
  next.screenEvents = next.screenEvents.filter(e => !(e.target === target && e.atMs === atMs));
  return pruneNativeStage(next);
}

/** Resolve v3 overlays without changing the source rig or allocating new legacy rigs. */
export function resolveStudioGeometry(source: RigConfig, layout?: StageLayout) {
  const empty = layout?.replace === true;
  const hangs = layout?.hangs ?? (empty ? [] : undefined);
  const props = layout?.props ?? [];
  if (!empty && !layout?.trusses?.length && hangs === undefined) return { rig: source, hangs, props };
  const rig: RigConfig = empty ? {
    ...source, platforms: [], trussPods: [], floorFx: [], props: [],
    audioRig: { ...source.audioRig, subWall: false, djBooth: false, monitorCount: 0 },
  } : { ...source };
  if (hangs) rig.audioRig = { ...rig.audioRig, lineArrays: hangs.length > 0 };
  if (layout?.trusses?.length) {
    const ids = new Set(rig.trussPods.map(pod => pod.id));
    const added = layout.trusses.flatMap((span, index): TrussPodConfig[] => {
      const dx = span.endX - span.x, dz = span.endZ - span.z;
      const width = Math.hypot(dx, dz);
      if (width === 0) return [];
      let id = `layout-truss-${index + 1}`;
      while (ids.has(id)) id += '-';
      ids.add(id);
      return [{ id, name: `Authored truss ${index + 1}`, shape: 'box', width,
        x: (span.x + span.endX) / 2, z: (span.z + span.endZ) / 2, rotationY: -Math.atan2(dz, dx),
        baseY: span.height, motorized: false, motorMinY: span.height, motorMaxY: span.height, fixtures: [] }];
    });
    rig.trussPods = [...rig.trussPods, ...added];
  }
  return { rig, hangs, props };
}
