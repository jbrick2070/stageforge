import { useSyncExternalStore } from 'react';

export interface LiveStore<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Lightweight external store for high-frequency HUD telemetry (FPS, audio spectrum, DMX frames).
 * Subscribers re-render independently of App so 20 Hz updates never re-render the whole desk.
 */
export function createLiveStore<T>(initial: T): LiveStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useLive<T>(store: LiveStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
