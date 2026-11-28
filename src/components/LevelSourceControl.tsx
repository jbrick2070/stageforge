import { useCallback, useSyncExternalStore } from 'react';
import type { ArtNetInputApi } from '../dmx/useArtNetInput';

const TIMING_UNAVAILABLE = 'Preview timing unavailable. Stop and restart Art-Net input.';

export function LevelSourceControl({ input }: { input: ArtNetInputApi }) {
  const { store, preview, setLevelSource } = input;
  const subscribe = useCallback((notify: () => void) => {
    const off = store.subscribe(notify);
    const timer = window.setInterval(notify, 200);
    return () => { off(); window.clearInterval(timer); };
  }, [store]);
  const read = useCallback(() => {
    const { phase, error, config } = store.get();
    const locked = preview.timing === 'unavailable' || (phase !== 'starting' && phase !== 'listening');
    let status = 'Art-Net stopped';
    if (preview.timing === 'unavailable') status = TIMING_UNAVAILABLE;
    else if (phase === 'starting') status = 'Art-Net starting';
    else if (phase === 'stopping') status = 'Art-Net stopping';
    else if (phase === 'listening') {
      const now = performance.now();
      let active = false;
      let stale = false;
      for (const row of config?.mappings ?? []) {
        if (preview.read(row.universe, now)) active = true;
        else if (preview.latestSequence(row.universe) > 0) stale = true;
      }
      status = active ? (stale ? 'Art-Net receiving · some universes stale' : 'Art-Net receiving')
        : stale ? 'Art-Net stale' : 'Art-Net listening · awaiting first frame';
    } else if (error) status = 'Art-Net stopped · receiver error';
    else if (preview.source === 'desk') status = 'Art-Net off · start in DMX monitor';
    return `${preview.source}|${locked ? 1 : 0}|${status}`;
  }, [preview, store]);
  const [source, locked, status] = useSyncExternalStore(subscribe, read, read).split('|');

  return (
    <section aria-label="Preview level source" className="rounded-lg border border-white/20 bg-zinc-950/90 px-2.5 py-1.5 text-xs">
      <label className="flex items-center justify-between gap-2 text-zinc-200">
        <span>Level source</span>
        <select value={source} className="rounded border border-white/20 bg-zinc-900 px-1 py-0.5"
          onChange={event => setLevelSource(event.target.value === 'external' ? 'external' : 'desk')}>
          <option value="desk">Desk</option>
          <option value="external" disabled={locked === '1' && source !== 'external'}>External Levels</option>
        </select>
      </label>
      <p role="status" data-testid="level-source-status" className="max-w-52 text-[10px] text-zinc-300">{status}</p>
    </section>
  );
}
