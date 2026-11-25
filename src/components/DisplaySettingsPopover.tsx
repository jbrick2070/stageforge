import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Monitor, ShieldAlert } from 'lucide-react';
import type { AaMode, BloomMode, RenderSettings } from '../engine/renderSettings';

export interface DisplaySettingsPopoverProps {
  settings: RenderSettings;
  onChangeSettings: (patch: Partial<RenderSettings>) => void;
  fullRateOptIn: boolean;
  effectiveFullRate: boolean;
  prefersReducedMotion: boolean;
  viewerMode: boolean;
  onSetFullRateOptIn: (enabled: boolean) => void;
}

/**
 * Accessible device-local Display & safety controls (Sprint 15).
 * Available in both the editor TopBar and Pitch Viewer without mutating show files.
 * Full-rate strobe preview is strictly session-only, blocked under prefers-reduced-motion
 * and Pitch Viewer, and requires explicit confirmation with Cancel focused first.
 */
export const DisplaySettingsPopover: React.FC<DisplaySettingsPopoverProps> = ({
  settings,
  onChangeSettings,
  fullRateOptIn,
  effectiveFullRate,
  prefersReducedMotion,
  viewerMode,
  onSetFullRateOptIn,
}) => {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);
  const warningId = useId();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (confirmOpen) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmOpen) {
          setConfirmOpen(false);
        } else {
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, confirmOpen]);

  useEffect(() => {
    if (confirmOpen) {
      cancelConfirmRef.current?.focus();
    }
  }, [confirmOpen]);

  const fullRateDisabled = prefersReducedMotion || viewerMode;
  const fullRateDisabledReason = prefersReducedMotion
    ? 'Disabled because your device has reduced motion enabled.'
    : viewerMode
      ? 'Disabled in read-only Pitch Viewer.'
      : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`transport-btn${effectiveFullRate ? ' border-amber-400/70 text-amber-200' : ''}`}
        data-testid="display-settings-toggle"
        aria-label="Display and safety settings"
        title="Display quality & preview flash safety"
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Monitor />
        <span className="tool-name-detail">Display</span>
      </button>

      {open && (
        <section
          id={panelId}
          role="dialog"
          aria-label="Display and safety settings"
          data-testid="display-settings-panel"
          className="audio-popover"
          style={{ right: 0, left: 'auto', minWidth: 'min(320px, calc(100vw - 24px))', maxWidth: 'min(360px, calc(100vw - 24px))' }}
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-1.5 mb-2">
            <strong className="text-xs font-mono-tech text-zinc-100">Display &amp; safety</strong>
            <span className="text-[10px] font-mono-tech text-zinc-400">Device only</span>
          </div>

          <div className="space-y-2 text-[11px]">
            <label className="flex items-center justify-between gap-2 min-h-[36px]">
              <span className="text-zinc-300 font-mono-tech">Bloom</span>
              <select
                aria-label="Bloom quality"
                data-testid="render-bloom-select"
                value={settings.bloom}
                onChange={(e) => onChangeSettings({ bloom: e.target.value as BloomMode })}
                className="rounded border border-white/15 bg-black/70 px-2 py-1 text-[11px] text-zinc-100"
              >
                <option value="auto">Auto (default)</option>
                <option value="full">Full resolution</option>
                <option value="half">Half resolution</option>
                <option value="off">Off (bypass)</option>
              </select>
            </label>

            <label className="flex items-center justify-between gap-2 min-h-[36px]">
              <span className="text-zinc-300 font-mono-tech">Antialiasing</span>
              <select
                aria-label="Antialiasing mode"
                data-testid="render-aa-select"
                value={settings.aa}
                onChange={(e) => onChangeSettings({ aa: e.target.value as AaMode })}
                className="rounded border border-white/15 bg-black/70 px-2 py-1 text-[11px] text-zinc-100"
              >
                <option value="auto">Auto (MSAA 2×)</option>
                <option value="msaa">MSAA 2×</option>
                <option value="fxaa">FXAA (post-output)</option>
                <option value="none">Off</option>
              </select>
            </label>

            <label className="flex items-center gap-2 min-h-[44px] cursor-pointer text-zinc-200">
              <input
                type="checkbox"
                data-testid="render-falling-co2-checkbox"
                checked={settings.fallingCo2}
                onChange={(e) => onChangeSettings({ fallingCo2: e.target.checked })}
                className="h-4 w-4 accent-cyan-400"
              />
              <span>
                Falling CO2 plume <span className="text-zinc-400">(stylised approximation)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 min-h-[44px] cursor-pointer text-zinc-200">
              <input
                type="checkbox"
                data-testid="render-video-srgb-checkbox"
                checked={settings.videoSrgbDecode}
                onChange={(e) => onChangeSettings({ videoSrgbDecode: e.target.checked })}
                className="h-4 w-4 accent-cyan-400"
              />
              <span>
                Decode video sRGB on LED walls <span className="text-zinc-400">(experimental)</span>
              </span>
            </label>
          </div>

          <div className="mt-3 border-t border-white/10 pt-2.5 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-mono-tech">
              <ShieldAlert className={`w-3.5 h-3.5 shrink-0 ${effectiveFullRate ? 'text-amber-300' : 'text-emerald-300'}`} aria-hidden="true" />
              <span className={effectiveFullRate ? 'text-amber-200 font-bold' : 'text-emerald-200'}>
                {effectiveFullRate
                  ? 'Full-rate strobe preview active (session only)'
                  : 'Preview flash limiter active (≤ 3 flashes/s)'}
              </span>
            </div>

            <label className={`flex items-start gap-2 min-h-[44px] text-[11px] ${fullRateDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                data-testid="full-rate-strobe-checkbox"
                checked={fullRateOptIn && !fullRateDisabled}
                disabled={fullRateDisabled}
                aria-describedby={warningId}
                onChange={(e) => {
                  if (e.target.checked) {
                    setConfirmOpen(true);
                  } else {
                    onSetFullRateOptIn(false);
                  }
                }}
                className="mt-0.5 h-4 w-4 accent-amber-400 shrink-0"
              />
              <span className="text-zinc-100 font-medium">
                Full-rate strobe preview <span className="text-zinc-400 font-normal">(session only)</span>
              </span>
            </label>

            {fullRateDisabledReason && (
              <p className="text-[10px] text-amber-200/90 font-mono-tech" role="status">
                {fullRateDisabledReason}
              </p>
            )}

            <p id={warningId} className="text-[10px] leading-relaxed text-zinc-400">
              Full-rate preview can produce rapid flashing (above 3 flashes per second) that may trigger
              seizures or other symptoms in people with photosensitive epilepsy. This changes the on-screen
              preview only; physical DMX output is unaffected. Source-event limiting covers StageForge
              strobes, laser blanking, ILDA shimmer, LED beat/bar flashes, blinders, and rapid cue changes;
              uploaded video, animated ILDA clips, and camera motion are outside source-event limiting.
            </p>
          </div>
        </section>
      )}

      {confirmOpen && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="full-rate-strobe-title"
          aria-describedby="full-rate-strobe-desc"
          data-testid="full-rate-strobe-confirm"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-amber-400/70 bg-zinc-950 p-4 shadow-2xl space-y-3">
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
              <h2 id="full-rate-strobe-title" className="text-sm font-bold">
                Enable full-rate strobe preview?
              </h2>
            </div>
            <p id="full-rate-strobe-desc" className="text-xs leading-relaxed text-zinc-200">
              Shows strobes and laser flicker at their real rate (above 3 flashes per second).
              This can trigger seizures or other symptoms in people with photosensitive epilepsy.
              This setting applies to the on-screen preview for this session only and resets on reload.
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                ref={cancelConfirmRef}
                type="button"
                data-testid="full-rate-strobe-cancel"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-white/20 bg-white/10 hover:bg-white/20 px-3 py-2 text-xs font-medium text-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="full-rate-strobe-enable"
                onClick={() => {
                  setConfirmOpen(false);
                  onSetFullRateOptIn(true);
                }}
                className="rounded-lg border border-amber-400/80 bg-amber-600 hover:bg-amber-500 px-3 py-2 text-xs font-bold text-black cursor-pointer"
              >
                Enable for this session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
