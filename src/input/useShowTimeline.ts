import { useEffect, useRef, useState } from 'react';
import type { ShowState } from '../types/show';
import type { ShowTimeline, TimelineEvent } from '../data/showFile';

export type DeskFrame = Required<Omit<TimelineEvent, 'atMs' | 'look'>> & { look: ShowState; cueModified: boolean };
type Mode = 'idle' | 'recording' | 'playing';

function changed(a: unknown, b: unknown) {
  return a !== b && JSON.stringify(a) !== JSON.stringify(b);
}

function mediaChanged(a: DeskFrame['music'] | DeskFrame['screen'], b: typeof a, elapsedMs: number, bpm: number) {
  if (a.name !== b.name || a.kind !== b.kind || a.playing !== b.playing) return true;
  const seconds = a.playing ? elapsedMs / 1000 : 0;
  if ('demoStep' in a && 'demoStep' in b && a.demoStep !== undefined && b.demoStep !== undefined) {
    return Math.abs(b.demoStep - a.demoStep - seconds * bpm / 15) > 1.5;
  }
  return a.offsetSeconds !== undefined && b.offsetSeconds !== undefined &&
    Math.abs(b.offsetSeconds - a.offsetSeconds - seconds) > 0.4;
}

export function frameDelta(before: DeskFrame, after: DeskFrame, atMs: number, elapsedMs: number) {
  const event: TimelineEvent = { atMs };
  if (before.look !== after.look) {
    const patch: Partial<ShowState> = {};
    for (const key of Object.keys(after.look) as (keyof ShowState)[]) {
      if (changed(before.look[key], after.look[key])) Object.assign(patch, { [key]: after.look[key] });
    }
    if (Object.keys(patch).length) event.look = patch;
  }
  // A refire can restore the current cue without changing its ID.
  if (before.cueId !== after.cueId || (before.cueModified && !after.cueModified)) event.cueId = after.cueId;
  if (before.camera !== after.camera) event.camera = after.camera;
  if (before.volume !== after.volume) event.volume = after.volume;
  if (changed(before.bump, after.bump)) event.bump = after.bump;
  if (mediaChanged(before.music, after.music, elapsedMs, after.look.bpm)) event.music = after.music;
  if (mediaChanged(before.screen, after.screen, elapsedMs, after.look.bpm)) event.screen = after.screen;
  return Object.keys(event).length > 1 ? event : null;
}

export function useShowTimeline(sample: () => DeskFrame, apply: (event: TimelineEvent, lateMs: number) => void, endReplay: () => void) {
  const live = useRef({ sample, apply, endReplay });
  live.current = { sample, apply, endReplay };
  const [timeline, setTimeline] = useState<ShowTimeline>();
  const [mode, setMode] = useState<Mode>('idle');
  const [timeMs, setTimeMs] = useState(0);
  const session = useRef<{ mode: 'recording' | 'playing'; started: number; events: TimelineEvent[]; durationMs: number; previous?: DeskFrame; sampledMs: number; index: number } | null>(null);
  const timer = useRef(0);
  const raf = useRef(0);
  const sampleChange = () => {
    const run = session.current;
    if (!run || run.mode !== 'recording' || !run.previous) return;
    const atMs = Math.max(run.sampledMs, Math.round(performance.now() - run.started));
    const current = live.current.sample();
    const delta = frameDelta(run.previous, current, atMs, atMs - run.sampledMs);
    if (delta) run.events.push(delta);
    run.previous = current;
    run.sampledMs = atMs;
  };
  const stop = () => {
    const run = session.current;
    if (!run) return;
    clearInterval(timer.current);
    cancelAnimationFrame(raf.current);
    if (run.mode === 'recording') {
      sampleChange();
      setTimeline({ durationMs: run.sampledMs, events: run.events });
      setTimeMs(run.sampledMs);
    }
    session.current = null;
    if (run.mode === 'playing') live.current.endReplay();
    setMode('idle');
  };
  const tick = () => {
    const run = session.current;
    if (!run) return;
    const atMs = Math.round(performance.now() - run.started);
    if (run.mode === 'recording') sampleChange();
    else {
      while (run.index < run.events.length && run.events[run.index].atMs <= atMs) {
        const event = run.events[run.index++];
        live.current.apply(event, atMs - event.atMs);
      }
      if (atMs >= run.durationMs) {
        setTimeMs(run.durationMs);
        stop();
        return;
      }
    }
    raf.current = requestAnimationFrame(tick);
  };
  const startClock = () => {
    setTimeMs(0);
    tick();
    if (session.current) timer.current = window.setInterval(() => {
      const run = session.current;
      if (run) setTimeMs(Math.round(performance.now() - run.started));
    }, 150);
  };
  const record = () => {
    if (session.current) return;
    const frame = live.current.sample();
    const { cueModified: _modified, ...snapshot } = frame;
    session.current = { mode: 'recording', started: performance.now(), events: [{ atMs: 0, ...snapshot }],
      durationMs: 0, sampledMs: 0, previous: frame, index: 0 };
    setMode('recording');
    startClock();
  };
  const play = () => {
    if (!timeline?.events.length || session.current) return;
    session.current = { mode: 'playing', started: performance.now(), ...timeline, sampledMs: 0, index: 0 };
    setMode('playing');
    startClock();
  };
  const replace = (next?: ShowTimeline) => {
    stop();
    setTimeline(next);
    setTimeMs(0);
  };
  // React commits can occur between animation frames, including short button holds.
  useEffect(() => { sampleChange(); });
  useEffect(() => () => { cancelAnimationFrame(raf.current); clearInterval(timer.current); }, []);
  const snapshot = () => {
    const run = session.current;
    if (!run || run.mode !== 'recording') return timeline;
    sampleChange();
    return { durationMs: run.sampledMs, events: [...run.events] };
  };
  return { timeline, mode, timeMs, record, play, stop, replace, snapshot };
}
