import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { StageEngine } from '../engine/StageEngine';
import type { NativeStage } from '../data/showFile';
import { secondaryScreensAt } from '../data/showClock';

export function useWallClock(engine: RefObject<StageEngine | null>, stage: RefObject<NativeStage | undefined>,
  assets: RefObject<Map<string, { file: File; url?: string }>>) {
  const anchor = useRef({ offsetMs: 0, started: 0, running: false, endMs: Infinity });
  const wake = useRef(0);
  const position = useCallback(() => {
    const a = anchor.current;
    return Math.min(a.endMs, a.offsetMs + (a.running ? performance.now() - a.started : 0));
  }, []);
  const refresh = useCallback(function sync() {
    window.clearTimeout(wake.current);
    if (!stage.current || !engine.current) return;
    const at = position();
    const playing = anchor.current.running && at < anchor.current.endMs;
    const states = secondaryScreensAt(stage.current, at, playing, (kind, name) => assets.current.get(kind + ':' + name)?.url);
    engine.current.syncSecondaryScreens(states);
    if (!playing) return;
    const next = stage.current.screenEvents.find(event => event.atMs > at)?.atMs ?? Infinity;
    const nextMs = Math.min(next, anchor.current.endMs);
    if (Number.isFinite(nextMs)) wake.current = window.setTimeout(sync, Math.max(1, Math.ceil(nextMs - at)));
  }, [position, engine, stage, assets]);
  const set = useCallback((offsetMs: number, running: boolean, endMs = Infinity) => {
    anchor.current = { offsetMs, started: performance.now(), running, endMs };
    refresh();
  }, [refresh]);
  useEffect(() => () => window.clearTimeout(wake.current), []);
  return { set, refresh, position };
}
