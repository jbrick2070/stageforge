import { useEffect, useRef, useState } from 'react';
import type { ShowState } from '../types/show';
import type { ShowTimeline, TimelineEvent } from '../data/showFile';
import { resolveTakeFrame, type TransportFrame } from '../data/showClock';

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

// A take is playable when it has recorded events or spans secondary-wall cues alone.
const playable = (take?: ShowTimeline): take is ShowTimeline => !!take && (take.events.length > 0 || take.durationMs > 0);

/**
 * `minDurationMs` reports the last secondary-wall cue so a new recording never
 * ends before cues the show already schedules (the v3 reader rejects those).
 */
export function useShowTimeline(sample: () => DeskFrame, apply: (event: TimelineEvent, lateMs: number) => void, endReplay: () => void,
  minDurationMs: () => number = () => 0) {
  const live = useRef({ sample, apply, endReplay, minDurationMs });
  live.current = { sample, apply, endReplay, minDurationMs };
  const [timeline, setTimeline] = useState<ShowTimeline>();
  const [mode, setMode] = useState<Mode>('idle');
  const [timeMs, setTimeMs] = useState(0);
  const [canResume, setCanResume] = useState(false);
  const baseline = useRef<TransportFrame | undefined>(undefined);
  const heldPosition = useRef(0);
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
    heldPosition.current = Math.min(run.mode === 'recording' ? Infinity : run.durationMs, Math.round(performance.now() - run.started));
    setTimeMs(heldPosition.current);
    setCanResume(false);
    if (run.mode === 'recording') {
      sampleChange();
      setTimeline({ durationMs: Math.max(run.sampledMs, Math.round(live.current.minDurationMs())), events: run.events });
      heldPosition.current = run.sampledMs;
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
  const startClock = (startMs = 0) => {
    setTimeMs(startMs);
    setCanResume(false);
    tick();
    if (session.current) timer.current = window.setInterval(() => {
      const run = session.current;
      if (run) setTimeMs(Math.round(performance.now() - run.started));
    }, 150);
  };
  const record = () => {
    if (session.current) return;
    const frame = live.current.sample();
    baseline.current = frame;
    heldPosition.current = 0;
    const { cueModified: _modified, ...snapshot } = frame;
    session.current = { mode: 'recording', started: performance.now(), events: [{ atMs: 0, ...snapshot }],
      durationMs: 0, sampledMs: 0, previous: frame, index: 0 };
    setMode('recording');
    startClock();
  };
  const play = (resume = false) => {
    if (!playable(timeline) || session.current) return;
    baseline.current ??= live.current.sample();
    const startMs = resume ? Math.min(heldPosition.current, timeline.durationMs) : 0;
    let index = 0;
    if (timeline.events.length) {
      live.current.apply(resolveTakeFrame(timeline, startMs, baseline.current, true), 0);
      while (index < timeline.events.length && timeline.events[index].atMs <= startMs) index++;
    }
    session.current = { mode: 'playing', started: performance.now() - startMs, ...timeline, sampledMs: startMs, index };
    setMode('playing');
    startClock(startMs);
  };
  const seek = (requestedMs: number, hold = false) => {
    if (!playable(timeline) || session.current?.mode === 'recording') return;
    const ms = Math.max(0, Math.min(timeline.durationMs, Math.round(requestedMs)));
    const run = session.current;
    const running = !!run && !hold && ms < timeline.durationMs;
    baseline.current ??= live.current.sample();
    if (run && !running) stop();
    if (timeline.events.length) live.current.apply(resolveTakeFrame(timeline, ms, baseline.current, running), 0);
    if (run && running) {
      run.started = performance.now() - ms;
      run.index = timeline.events.findIndex(event => event.atMs > ms);
      if (run.index < 0) run.index = timeline.events.length;
    }
    heldPosition.current = ms;
    setTimeMs(ms);
    setCanResume(!running && ms < timeline.durationMs);
  };
  const pause = () => {
    const run = session.current;
    if (run?.mode === 'playing') seek(performance.now() - run.started, true);
  };
  const playhead = () => {
    const run = session.current;
    return run ? Math.min(run.mode === 'recording' ? Infinity : run.durationMs, Math.max(0, performance.now() - run.started)) : heldPosition.current;
  };
  const replace = (next?: ShowTimeline, base?: TransportFrame) => {
    stop();
    baseline.current = base;
    heldPosition.current = 0;
    setCanResume(false);
    setTimeline(next);
    setTimeMs(0);
  };
  // Wall cues may start, extend or clean up a wall-only take; a recorded lighting take is never shortened.
  const syncWallDuration = (ms: number, hasWallEvents: boolean, allowShrink = false) => {
    const target = Math.max(0, Math.round(ms));
    const current = timeline;
    if (!current || current.events.length === 0) {
      if (!hasWallEvents) {
        if (allowShrink) {
          if (session.current?.mode === 'playing') stop();
          heldPosition.current = 0;
          setCanResume(false);
          setTimeMs(0);
          setTimeline(undefined);
        }
        return;
      }
      const nextDuration = allowShrink ? target : Math.max(current?.durationMs ?? 0, target);
      if (nextDuration < heldPosition.current) {
        heldPosition.current = nextDuration;
        setTimeMs(nextDuration);
        setCanResume(false);
      }
      setTimeline(nextDuration > 0 ? { durationMs: nextDuration, events: [] } : undefined);
      const run = session.current;
      if (run?.mode === 'playing') run.durationMs = nextDuration;
      return;
    }
    if (target > current.durationMs) {
      setTimeline({ ...current, durationMs: target });
      const run = session.current;
      if (run?.mode === 'playing') run.durationMs = target;
    }
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
  return { timeline, mode, timeMs, canResume, record, play, pause, seek, playhead, stop, replace, syncWallDuration, snapshot };
}
