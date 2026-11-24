import type { NativeStage, ScreenRef } from './showFile';
import { secondaryScreensAt } from './showClock';

/** Desk transport timecode, m:ss.t (tenths are truncated, never rounded up). */
export const timecode = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000 / 100))}`;
};

/** The Take position slider's step. */
export const SCRUB_STEP_MS = 50;

/**
 * Slider range and controlled value for a take. The range rounds up so the end stays reachable;
 * the value stays on the step grid, because the browser snaps an off-grid value (common after a
 * pause or replay) and React would then read the trailing `change` of a click or drag as a seek
 * back to the stale snapped position.
 */
export function scrubPosition(timeMs: number, durationMs: number) {
  const max = Math.ceil(Math.max(0, durationMs) / SCRUB_STEP_MS) * SCRUB_STEP_MS;
  const value = Math.min(max, Math.round(Math.max(0, Math.min(timeMs, durationMs)) / SCRUB_STEP_MS) * SCRUB_STEP_MS);
  return { max, value };
}

export type MarkerKind = 'cue' | 'wall';
export interface TakeMarker { atMs: number; kind: MarkerKind; label: string }
/** One drawn tick. `count` > 1 when nearby markers of the same kind were merged into it. */
export interface TakeTick extends TakeMarker { key: string; position: number; count: number }

/** Upper bound of ticks drawn per lane (lighting cues, wall events). */
export const MAX_TICKS_PER_LANE = 96;

export function cueMarkers(cues: ReadonlyArray<{ atMs: number; name: string }>): TakeMarker[] {
  return cues.map(cue => ({ atMs: cue.atMs, kind: 'cue', label: `Cue ${cue.name} at ${timecode(cue.atMs)}` }));
}

export function wallMarkers(stage?: NativeStage): TakeMarker[] {
  if (!stage) return [];
  const walls = new Map(stage.walls.map(wall => [wall.id, wall.label || wall.id]));
  return stage.screenEvents.map(event => {
    const what = event.kind === 'none' ? 'clear'
      : `${event.name} (${event.kind === 'image' ? 'image' : event.playing ? 'play' : 'hold'})`;
    return { atMs: event.atMs, kind: 'wall', label: `${walls.get(event.target) ?? event.target}: ${what} at ${timecode(event.atMs)}` };
  });
}

/**
 * Place markers along a scrubber of `durationMs`. `position` is 0..1 of `rangeMs`
 * (the slider's max, which may round up past the duration). Markers outside the
 * take clamp to its ends but keep their own time in the label. Within a lane,
 * markers closer than one tick slot merge into the first so a dense take stays
 * legible and never draws more than `maxPerLane` ticks per lane.
 */
export function layoutTicks(markers: readonly TakeMarker[], durationMs: number,
  { rangeMs = durationMs, maxPerLane = MAX_TICKS_PER_LANE }: { rangeMs?: number; maxPerLane?: number } = {}): TakeTick[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const range = Number.isFinite(rangeMs) ? Math.max(durationMs, rangeMs) : durationMs;
  const slot = maxPerLane > 1 ? 1 / (maxPerLane - 1) : Infinity;
  const ticks: TakeTick[] = [];
  for (const kind of ['cue', 'wall'] as const) {
    const lane = markers
      .map((marker, index) => ({ marker, index }))
      .filter(({ marker }) => marker.kind === kind && Number.isFinite(marker.atMs))
      .map(({ marker, index }) => ({ marker, index, position: Math.max(0, Math.min(durationMs, marker.atMs)) / range }))
      .sort((a, b) => a.position - b.position || a.index - b.index);
    let open: TakeTick | undefined;
    for (const { marker, position } of lane) {
      if (open && position - open.position < slot) {
        open.count++;
        continue;
      }
      open = { ...marker, key: `${kind}-${ticks.length}`, position, count: 1 };
      ticks.push(open);
    }
  }
  for (const tick of ticks) if (tick.count > 1) tick.label += ` (+${tick.count - 1} more)`;
  return ticks.sort((a, b) => a.position - b.position || (a.kind === b.kind ? 0 : a.kind === 'cue' ? -1 : 1));
}

export type ScreenGlanceState = 'play' | 'hold' | 'missing' | 'none';
export interface ScreenGlance { id: string; label: string; kind: ScreenRef['kind']; name: string; state: ScreenGlanceState }
type ScreenLike = Pick<ScreenRef, 'kind' | 'name' | 'playing'>;

function glance(id: string, label: string, ref: ScreenLike | undefined, linked: boolean): ScreenGlance {
  if (!ref || ref.kind === 'none' || !ref.name) return { id, label, kind: 'none', name: '', state: 'none' };
  const state = !linked ? 'missing' : ref.kind === 'video' && ref.playing ? 'play' : 'hold';
  return { id, label, kind: ref.kind, name: ref.name, state };
}

/** The main LED as App resolves it (replayed or live screen plus the engine's transport). */
export function mainScreenGlance(screen: ScreenLike | undefined, missing: Iterable<string>, label = 'Main LED'): ScreenGlance {
  return glance('main-led', label, screen, !new Set(missing).has(screen?.name ?? ''));
}

/**
 * What each secondary wall shows at `timeMs`, resolved by the renderer's own
 * `secondaryScreensAt` so the badges and the 3D walls cannot disagree.
 * `running` mirrors the wall clock: true while a take records or replays.
 */
export function wallGlancesAt(stage: NativeStage | undefined, timeMs: number, running: boolean, missing: Iterable<string>): ScreenGlance[] {
  if (!stage) return [];
  const missingNames = new Set(missing);
  const states = secondaryScreensAt(stage, timeMs, running, (_kind, name) => missingNames.has(name) ? undefined : 'linked');
  return stage.walls.filter(wall => wall.id !== 'main-led').map(wall => {
    const state = states[wall.id];
    return glance(wall.id, wall.label || wall.id, state, state?.url !== undefined);
  });
}

/** Main LED first, then every secondary wall in stage order. */
export function screenGlances(stage: NativeStage | undefined, timeMs: number, running: boolean,
  main: ScreenLike | undefined, missing: Iterable<string>): ScreenGlance[] {
  const names = [...missing];
  const mainLabel = stage?.walls.find(wall => wall.id === 'main-led')?.label || 'Main LED';
  return [mainScreenGlance(main, names, mainLabel), ...wallGlancesAt(stage, timeMs, running, names)];
}
