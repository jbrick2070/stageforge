import React from 'react';
import { AlertTriangle, ShieldCheck, Square, X } from 'lucide-react';
import type { LiveDmxBannerState } from '../dmx/liveDmx';
import type { PreflightOverallStatus } from '../data/preflight';

interface LiveDmxBadgeProps {
  banner: LiveDmxBannerState;
  busy: boolean;
  hasCatalogFixtures?: boolean;
  hasSimulationOnly?: boolean;
  preflightLabel?: string;
  preflightStatus?: PreflightOverallStatus;
  liveViolationMessage?: string | null;
  onOpenPreflight?: () => void;
  onStop: () => void;
  onDismissNotice?: () => void;
  onOpenOutput: () => void;
}

/**
 * Always-visible safety indicator rendered at the App root (including in cinema mode)
 * whenever live physical DMX output (sACN, Art-Net 4, or Enttec USB Pro) is active,
 * or when main-process output stopped automatically due to heartbeat loss.
 * Always keeps the pre-flight status badge, any live safety violation banner, and
 * Blackout & stop visible outside any collapsed drawer or Advanced section.
 */
export const LiveDmxBadge: React.FC<LiveDmxBadgeProps> = ({
  banner,
  busy,
  hasCatalogFixtures,
  hasSimulationOnly,
  preflightLabel,
  preflightStatus = 'not_checked',
  liveViolationMessage,
  onOpenPreflight,
  onStop,
  onDismissNotice,
  onOpenOutput,
}) => {
  if (!banner.active) {
    if (!banner.stoppedNotice) return null;
    return (
      <div
        role="alert"
        data-testid="live-dmx-stopped-badge"
        className="stage-output-status flex max-w-full items-center gap-2 rounded-lg border border-amber-400/80 bg-amber-950/95 px-2.5 py-1.5 shadow-2xl backdrop-blur-md font-mono-tech text-[11px] text-amber-100"
      >
        <button
          type="button"
          onClick={onOpenOutput}
          className="flex items-center gap-1.5 text-left cursor-pointer"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />
          <span className="font-bold">{banner.stoppedNotice}</span>
        </button>
        {onDismissNotice && (
          <button
            type="button"
            aria-label="Dismiss output stopped notice"
            data-testid="live-dmx-stopped-dismiss"
            onClick={onDismissNotice}
            className="p-0.5 rounded hover:bg-amber-800/60 text-amber-200 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
  const baseTitle = banner.error ? `Output degraded: ${banner.error}` : 'Open output settings';
  const simNote = hasSimulationOnly
    ? 'Some catalogue fixtures are simulation-only (neutral zeros on physical DMX)'
    : hasCatalogFixtures
      ? 'Check DMX Output for per-fixture personality status'
      : 'Generic non-catalogue fixtures output neutral zeros on physical DMX';
  const tooltip = `${baseTitle} · ${simNote}`;

  const preflightTone =
    preflightStatus === 'passed'
      ? 'border-emerald-400/60 bg-emerald-950/80 text-emerald-100'
      : preflightStatus === 'blocked'
        ? 'border-rose-300/80 bg-rose-900/90 text-rose-50'
        : preflightStatus === 'warnings'
          ? 'border-amber-300/70 bg-amber-950/85 text-amber-100'
          : 'border-white/30 bg-black/60 text-zinc-200';

  return (
    <div className="stage-output-status flex max-w-full flex-col items-end gap-1.5">
      <div
        role="status"
        aria-live="polite"
        aria-label="Live DMX output active"
        data-testid="live-dmx-badge"
        className={`flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 shadow-2xl backdrop-blur-md font-mono-tech text-[11px] ${
          banner.degraded
            ? 'bg-amber-950/90 border-amber-400/80 text-amber-100'
            : 'bg-rose-950/90 border-rose-500/80 text-rose-100'
        }`}
      >
        <button
          type="button"
          onClick={onOpenOutput}
          title={tooltip}
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
          {hasSimulationOnly && (
            <span className="rounded border border-cyan-300/50 bg-cyan-950/70 px-1.5 py-0.5 text-[9px] text-cyan-100">
              <span aria-hidden="true">Sim-only units</span>
              <span className="sr-only"> (Unimplemented catalogue fixtures output neutral zeros on physical DMX)</span>
            </span>
          )}
          {banner.degraded && <AlertTriangle className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />}
        </button>

        {preflightLabel && onOpenPreflight && (
          <button
            type="button"
            data-testid="live-preflight-badge"
            data-preflight-status={preflightStatus}
            onClick={onOpenPreflight}
            title={`Pre-flight status: ${preflightLabel} · Hardware calibration deferred: simulated aim may not match real fixture aim.`}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold cursor-pointer ${preflightTone}`}
          >
            <ShieldCheck className="w-3 h-3" aria-hidden="true" />
            <span>{preflightLabel}</span>
          </button>
        )}

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

      {/* Persistent live safety warning if a check starts failing while output is active */}
      {liveViolationMessage && (
        <div
          role="alert"
          data-testid="live-safety-warning"
          className="max-w-md flex items-center gap-1.5 rounded-lg border border-amber-400/85 bg-amber-950/95 px-2.5 py-1.5 shadow-2xl backdrop-blur-md font-mono-tech text-[10px] text-amber-100"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />
          <span>{liveViolationMessage}</span>
        </div>
      )}
    </div>
  );
};
