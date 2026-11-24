import type { NativeStage, ShowTimeline, TimelineEvent } from './showFile';
import { DEMO_TOTAL_STEPS } from './demoShow';
import type { BumpState, CameraPreset, MusicRef, ScreenRef, ShowState } from '../types/show';

export interface TransportFrame {
  look: ShowState;
  cueId: string | null;
  camera: CameraPreset;
  volume: number;
  bump: BumpState;
  music: MusicRef;
  screen: ScreenRef;
}

function advanceMusic(music: MusicRef, seconds: number, bpm: number): MusicRef {
  if (!music.playing || seconds <= 0) return music;
  if (music.kind === 'demo') return { ...music, demoStep: Math.min(DEMO_TOTAL_STEPS, (music.demoStep ?? 0) + seconds * bpm / 15) };
  if (music.kind === 'file') return { ...music, offsetSeconds: (music.offsetSeconds ?? 0) + seconds };
  return music;
}

// Reconstruct from the saved starting frame. Repeated cue IDs and simultaneous
// events retain their recorded order, regardless of the previous playhead position.
export function resolveTakeFrame(take: ShowTimeline, requestedMs: number, base: TransportFrame, running: boolean): TimelineEvent {
  const atMs = Math.round(Math.max(0, Math.min(requestedMs, take.durationMs)));
  const frame = { ...base, look: { ...base.look } };
  let musicAt = 0;
  let screenAt = 0;
  for (const event of take.events) {
    if (event.atMs > atMs) break;
    if (event.music || event.look?.bpm !== undefined) {
      frame.music = event.music ?? advanceMusic(frame.music, (event.atMs - musicAt) / 1000, frame.look.bpm);
      musicAt = event.atMs;
    }
    if (event.screen) { frame.screen = event.screen; screenAt = event.atMs; }
    if (event.look) Object.assign(frame.look, event.look);
    if (event.cueId !== undefined) frame.cueId = event.cueId;
    if (event.camera !== undefined) frame.camera = event.camera;
    if (event.bump !== undefined) frame.bump = event.bump;
    if (event.volume !== undefined) frame.volume = event.volume;
  }
  const music = advanceMusic(frame.music, (atMs - musicAt) / 1000, frame.look.bpm);
  const screen = { ...frame.screen };
  if (screen.kind === 'video' && screen.playing) screen.offsetSeconds = (screen.offsetSeconds ?? 0) + (atMs - screenAt) / 1000;
  screen.playing = running && screen.playing;
  return { ...frame, atMs, music: { ...music, playing: running && music.playing }, screen };
}

export function secondaryScreensAt(stage: NativeStage, timeMs: number, running: boolean,
  findUrl: (kind: string, name: string) => string | undefined) {
  const refs = new Map<string, NativeStage['screenEvents'][number]>();
  for (const event of stage.screenEvents) {
    if (event.atMs > timeMs) break;
    refs.set(event.target, event);
  }
  return Object.fromEntries([...refs].map(([id, ref]) => [id, {
    kind: ref.kind, name: ref.name, playing: running && ref.playing,
    url: findUrl(ref.kind, ref.name),
    offsetSeconds: (ref.offsetSeconds ?? 0) + (ref.playing ? (timeMs - ref.atMs) / 1000 : 0),
  }]));
}
