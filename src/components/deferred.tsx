import { useEffect, useState, type ComponentType, type ReactElement } from 'react';

/**
 * A component whose code loads in its own chunk, outside the first download.
 *
 * Unlike React.lazy + Suspense, nothing here waits on timers: React reveals suspended content on a
 * throttle timer, which never fires when time is frozen (Playwright's clock, a paused tab). The panel
 * simply renders nothing until its code arrives on demand when mounted, then renders normally. A failed
 * load is retried once, then thrown from render so the surrounding ErrorBoundary shows its fallback.
 */
export interface DeferredComponent<P extends object> {
  (props: P): ReactElement | null;
  preload(): Promise<ComponentType<P>>;
}

export function deferredComponent<P extends object>(load: () => Promise<ComponentType<P>>): DeferredComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () => {
    pending ??= load()
      .catch(() => load()) // one retry: a dropped connection or a deploy mid-session
      .then((component) => (loaded = component))
      .catch((error: unknown) => {
        pending = null; // allow a later attempt (e.g. after the ErrorBoundary resets)
        throw error;
      });
    return pending;
  };

  function Deferred(props: P) {
    const [component, setComponent] = useState<ComponentType<P> | null>(() => loaded);
    const [error, setError] = useState<unknown>(null);
    useEffect(() => {
      if (component) return;
      let live = true;
      preload().then(
        (next) => { if (live) setComponent(() => next); },
        (failure: unknown) => { if (live) setError(failure ?? new Error('A panel failed to load.')); },
      );
      return () => { live = false; };
    }, [component]);
    if (error) throw error;
    const Component = component;
    return Component ? <Component {...props} /> : null;
  }
  Deferred.preload = preload;
  return Deferred as DeferredComponent<P>;
}
