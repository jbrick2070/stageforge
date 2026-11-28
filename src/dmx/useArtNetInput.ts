import { useCallback, useEffect, useRef, useState } from 'react';
import { createLiveStore, type LiveStore } from '../state/liveTelemetry';

interface ArtNetInputSnapshot {
  phase: ArtNetInputStatusBridge['phase'];
  port: number | null;
  error: string | null;
  config: ArtNetInputConfigBridge | null;
  batch: ArtNetInputBatchBridge | null;
  batchAt: number;
}

export interface ArtNetInputApi {
  available: boolean;
  store: LiveStore<ArtNetInputSnapshot>;
  start: (config: ArtNetInputConfigBridge) => void;
  stop: () => void;
  invalidateDocument: () => void;
}

const OFF: ArtNetInputSnapshot = { phase: 'off', port: null, error: null, config: null, batch: null, batchAt: 0 };
let generation = 0;
let documentRevision = 'document-0';
const sameAuthority = (a: DmxAuthorityBridge, b: DmxAuthorityBridge) =>
  a.revision === b.revision && a.generation === b.generation;

export function useArtNetInput(enabled: boolean): ArtNetInputApi {
  const bridge = window.stageforgeDesktop;
  const available = enabled && typeof bridge?.artNetInput === 'function' &&
    typeof bridge?.onArtNetInputStatus === 'function' && typeof bridge?.onArtNetInputBatch === 'function' &&
    typeof bridge?.ackArtNetInput === 'function';
  const [store] = useState(() => createLiveStore<ArtNetInputSnapshot>(OFF));
  const owner = useRef<{ authority: DmxAuthorityBridge; stopping: boolean; lastBatch: number } | null>(null);

  const reset = useCallback((error: string | null = null) => {
    owner.current = null;
    store.set(error ? { ...OFF, error } : OFF);
  }, [store]);

  const receiveStatus = useCallback((status: ArtNetInputStatusBridge) => {
    const current = owner.current;
    if (!current || !sameAuthority(current.authority, status.authority)) return;
    if (status.phase === 'off') {
      reset(status.error);
      return;
    }
    const before = store.get();
    if ((current.stopping && status.phase !== 'stopping') ||
        (before.phase !== 'starting' && status.phase === 'starting')) return;
    if (status.phase === 'stopping') current.stopping = true;
    store.set({ ...before, phase: status.phase, port: status.port, error: status.error,
      batch: current.stopping ? null : before.batch });
  }, [reset, store]);

  useEffect(() => {
    if (!available || !bridge) return;
    const offStatus = bridge.onArtNetInputStatus(receiveStatus);
    const offBatch = bridge.onArtNetInputBatch(batch => {
      const current = owner.current;
      if (!current || current.stopping || !sameAuthority(current.authority, batch.authority) ||
          batch.batchId <= current.lastBatch || store.get().phase !== 'listening') return;
      current.lastBatch = batch.batchId;
      store.set({ ...store.get(), batch, batchAt: performance.now() });
      bridge.ackArtNetInput({ authority: batch.authority, batchId: batch.batchId });
    });
    const onPageHide = () => {
      const current = owner.current;
      if (current) void bridge.artNetInput({ type: 'stop', authority: current.authority }).catch(() => {});
      reset();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      offStatus();
      offBatch();
      onPageHide();
    };
  }, [available, bridge, receiveStatus, reset, store]);

  const start = useCallback((config: ArtNetInputConfigBridge) => {
    if (!available || !bridge || owner.current) return;
    const authority = { revision: documentRevision, generation: ++generation };
    const attempt = { authority, stopping: false, lastBatch: 0 };
    owner.current = attempt;
    store.set({ ...OFF, config, phase: 'starting' });
    void bridge.artNetInput({ type: 'start', authority, config }).then(receiveStatus, error => {
      if (owner.current === attempt && !attempt.stopping) reset(String(error?.message ?? error));
    });
  }, [available, bridge, receiveStatus, reset, store]);

  const stop = useCallback(() => {
    const current = owner.current;
    if (!available || !bridge || !current || current.stopping) return;
    current.stopping = true;
    store.set({ ...store.get(), phase: 'stopping', port: null, batch: null });
    void bridge.artNetInput({ type: 'stop', authority: current.authority }).then(
      () => { if (owner.current === current) reset(); },
      error => { if (owner.current === current) reset(String(error?.message ?? error)); },
    );
  }, [available, bridge, reset, store]);

  const invalidateDocument = useCallback(() => {
    if (!available || !bridge) return;
    documentRevision = `document-${++generation}`;
    reset();
    void bridge.artNetInput({ type: 'document', authority: { revision: documentRevision, generation } }).catch(() => {});
  }, [available, bridge, reset]);

  return { available, store, start, stop, invalidateDocument };
}
