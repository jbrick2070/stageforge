import React from 'react';
import { AlertTriangle, Square } from 'lucide-react';
import type { LiveDmxBannerState } from '../dmx/liveDmx';

interface LiveDmxBadgeProps {
  banner: LiveDmxBannerState;
  busy: boolean;
  onStop: () => void;
  onOpenOutput: () => void;
}

/**
 * Always-visible safety indicator rendered at the App root (including in cinema mode)
 * whenever live physical DMX output (sACN, Art-Net 4, or Enttec USB Pro) is active.
 */
export const LiveDmxBadge: React.FC<LiveDmxBadgeProps> = ({
  banner,
  busy,
  onStop,
  onOpenOutput,
}) => {
  if (!banner.active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Live DMX output active"
      data-testid="live-dmx-badge"
      className={`fixed top-14 right-3 z-50 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 shadow-2xl backdrop-blur-md font-mono-tech text-[11px] ${
        banner.degraded
          ? 'bg-amber-950/90 border-amber-400/80 text-amber-100'
          : 'bg-rose-950/90 border-rose-500/80 text-rose-100'
      }`}
    >
      <button
        type="button"
        onClick={onOpenOutput}
        title={banner.error ? `Output degraded: ${banner.error}` : 'Open output settings'}
        className="flex items-center gap-2 text-left cursor-pointer"
      >
        <span
          aria-hidden="true"
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            banner.degraded ? 'bg-amber-400 animate-pulse' : 'bg-rose-500 animate-pulse shadow-[0_0_8px_#f43f5e]'
          }`}
        />
        <span className="font-bold tracking-wider">{banner.label}</span>
        {banner.detail && <span className="text-[10px] opacity-85">{banner.detail}</span>}
        {banner.degraded && <AlertTriangle className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />}
      </button>
      <button
        type="button"
        disabled={busy}
        data-testid="live-dmx-stop"
        onClick={onStop}
        className="flex items-center gap-1 rounded border border-rose-300/60 bg-rose-600/85 hover:bg-rose-500 px-2 py-0.5 text-[10px] font-bold text-white cursor-pointer disabled:opacity-50"
      >
        <Square className="w-2.5 h-2.5 fill-current" aria-hidden="true" />
        Blackout &amp; stop
      </button>
    </div>
  );
};
