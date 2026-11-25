import { useEffect, useRef, useState } from 'react';
import type { ShowState } from '../types/show';
import type { ShowTimeline, SmpteFrameRate, TimelineEvent } from '../data/showFile';
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
    // Preserve explicit removal of the last audio mapping as `{ mappings: [] }` so replay & seek clear it.
    const hadAudioMap = (before.look.audioMap?.mappings?.length ?? 0) > 0;
    const hasAudioMap = (after.look.audioMap?.mappings?.length ?? 0) > 0;
    if (hadAudioMap && !hasAudioMap) {
      patch.audioMap = { mappings: [] };
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
  const chaseIndex = useRef(0);
  const chaseNeedsSeek = useRef(true);
  const chaseLastUiMs = useRef(0);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const session = useRef<{ mode: 'recording' | 'playing'; started: number; events: TimelineEvent[]; durationMs: number; previous?: DeskFrame; sampledMs: number; index: number; frameRate?: SmpteFrameRate; timecodeOffsetMs?: number } | null>(null);
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
      setTimeline({
        durationMs: Math.max(run.sampledMs, Math.round(live.current.minDurationMs())),
        events: run.events,
        ...(run.frameRate !== undefined ? { frameRate: run.frameRate } : {}),
        ...(run.timecodeOffsetMs !== undefined ? { timecodeOffsetMs: run.timecodeOffsetMs } : {}),
      });
      heldPosition.current = run.sampledMs;
      chaseIndex.current = 0;
      chaseNeedsSeek.current = true;
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
  const record = (meta?: { frameRate?: SmpteFrameRate; timecodeOffsetMs?: number }) => {
    if (session.current) return;
    const frame = live.current.sample();
    baseline.current = frame;
    heldPosition.current = 0;
    const { cueModified: _modified, ...snapshot } = frame;
    session.current = {
      mode: 'recording', started: performance.now(), events: [{ atMs: 0, ...snapshot }],
      durationMs: 0, sampledMs: 0, previous: frame, index: 0,
      frameRate: meta?.frameRate,
      timecodeOffsetMs: meta?.timecodeOffsetMs,
    };
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
    chaseIndex.current = 0;
    chaseNeedsSeek.current = true;
    setCanResume(false);
    setTimeline(next);
    setTimeMs(0);
  };
  /** Seek silently for external timecode chase/locate: applies resolved look without firing skipped events. */
  const chaseSeek = (requestedMs: number, running: boolean) => {
    const take = timelineRef.current;
    if (!playable(take) || session.current?.mode === 'recording') return;
    if (session.current) stop();
    const ms = Math.max(0, Math.min(take.durationMs, Math.round(requestedMs)));
    baseline.current ??= live.current.sample();
    if (take.events.length) {
      live.current.apply(resolveTakeFrame(take, ms, baseline.current, running && ms < take.durationMs), 0);
    }
    let idx = 0;
    while (idx < take.events.length && take.events[idx].atMs <= ms) idx++;
    chaseIndex.current = idx;
    chaseNeedsSeek.current = false;
    heldPosition.current = ms;
    setTimeMs(ms);
    setCanResume(false);
  };
  /** Advance monotonically along external timecode: fires only events in (cursor, ms] and never re-fires on jitter. */
  const chaseAdvance = (requestedMs: number) => {
    const take = timelineRef.current;
    if (!playable(take) || session.current?.mode === 'recording') return;
    if (chaseNeedsSeek.current) {
      chaseSeek(requestedMs, true);
      return;
    }
    if (session.current) stop();
    const ms = Math.max(0, Math.min(take.durationMs, Math.round(requestedMs)));
    while (chaseIndex.current < take.events.length && take.events[chaseIndex.current].atMs <= ms) {
      const event = take.events[chaseIndex.current++];
      live.current.apply(event, Math.max(0, ms - event.atMs));
    }
    heldPosition.current = ms;
    const now = performance.now();
    if (now - chaseLastUiMs.current >= 100 || ms >= take.durationMs) {
      chaseLastUiMs.current = now;
      setTimeMs(ms);
    }
  };
  /** Resolve the timeline state at `requestedMs` without mutating chase cursor or applying events. */
  const resolveFrameAt = (requestedMs: number, running: boolean): TimelineEvent | null => {
    const take = timelineRef.current;
    if (!playable(take) || !take.events.length) return null;
    const ms = Math.max(0, Math.min(take.durationMs, Math.round(requestedMs)));
    baseline.current ??= live.current.sample();
    return resolveTakeFrame(take, ms, baseline.current, running && ms < take.durationMs);
  };
  /** Reset chase cursor cleanly (e.g. on leaving Chase mode or replacing a take). */
  const resetChase = () => {
    chaseIndex.current = 0;
    chaseNeedsSeek.current = true;
  };
  /** Update SMPTE frame rate / offset metadata on the active take (or pending recording). */
  const setMetadata = (meta: { frameRate?: SmpteFrameRate; timecodeOffsetMs?: number }) => {
    const run = session.current;
    if (run?.mode === 'recording') {
      if ('frameRate' in meta) run.frameRate = meta.frameRate;
      if ('timecodeOffsetMs' in meta) run.timecodeOffsetMs = meta.timecodeOffsetMs;
    }
    setTimeline(prev => {
      if (!prev) return prev;
      const next: ShowTimeline = { durationMs: prev.durationMs, events: prev.events };
      const fr = 'frameRate' in meta ? meta.frameRate : prev.frameRate;
      const off = 'timecodeOffsetMs' in meta ? meta.timecodeOffsetMs : prev.timecodeOffsetMs;
      if (fr !== undefined) next.frameRate = fr;
      if (off !== undefined) next.timecodeOffsetMs = off;
      return next;
    });
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
      chaseIndex.current = 0;
      chaseNeedsSeek.current = true;
      setTimeline(nextDuration > 0 ? {
        durationMs: nextDuration,
        events: [],
        ...(current?.frameRate !== undefined ? { frameRate: current.frameRate } : {}),
        ...(current?.timecodeOffsetMs !== undefined ? { timecodeOffsetMs: current.timecodeOffsetMs } : {}),
      } : undefined);
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
    return {
      durationMs: run.sampledMs,
      events: [...run.events],
      ...(run.frameRate !== undefined ? { frameRate: run.frameRate } : {}),
      ...(run.timecodeOffsetMs !== undefined ? { timecodeOffsetMs: run.timecodeOffsetMs } : {}),
    };
  };
  return { timeline, mode, timeMs, canResume, record, play, pause, seek, playhead, stop, replace, syncWallDuration, snapshot, chaseSeek, chaseAdvance, resolveFrameAt, resetChase, setMetadata };
}
