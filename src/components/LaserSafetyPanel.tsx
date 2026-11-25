import React from 'react';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  formatClearanceM,
  MIN_AUDIENCE_CLEARANCE_M,
  type LaserSafetyLevel,
  type RigLaserSafetySummary,
} from '../data/laserSafety';

const LEVEL_META: Record<
  LaserSafetyLevel,
  { label: string; chipClass: string; panelClass: string }
> = {
  ok: {
    label: 'Overhead ≥ 3 m (est.)',
    chipClass: 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200',
    panelClass: 'bg-emerald-950/35 border-emerald-500/35 text-emerald-100',
  },
  caution: {
    label: 'Caution',
    chipClass: 'bg-amber-500/20 border-amber-400/50 text-amber-200',
    panelClass: 'bg-amber-950/40 border-amber-500/40 text-amber-100',
  },
  danger: {
    label: 'Danger',
    chipClass: 'bg-rose-500/25 border-rose-400/70 text-rose-200',
    panelClass: 'bg-rose-950/55 border-rose-500/60 text-rose-100',
  },
};

function okLabelForSummary(summary: RigLaserSafetySummary): string {
  return summary.minClearanceM === null ? 'No audience-zone hit (est.)' : 'Overhead ≥ 3 m (est.)';
}

function LevelIcon({ level, className }: { level: LaserSafetyLevel; className?: string }) {
  if (level === 'danger') return <ShieldAlert className={className} aria-hidden="true" />;
  if (level === 'caution') return <AlertTriangle className={className} aria-hidden="true" />;
  return <ShieldCheck className={className} aria-hidden="true" />;
}

/** Compact header status badge (never placed in the viewport corner where LiveDmxBadge/ClockBadge live). */
export const LaserSafetyChip: React.FC<{ summary: RigLaserSafetySummary }> = ({ summary }) => {
  if (summary.projectorCount === 0) return null;
  const meta = LEVEL_META[summary.level];
  const label = summary.level === 'ok' ? okLabelForSummary(summary) : meta.label;
  return (
    <span
      data-testid="laser-safety-chip"
      data-level={summary.level}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono-tech text-[9px] uppercase tracking-wider ${meta.chipClass}`}
    >
      <LevelIcon level={summary.level} className="w-3 h-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
};

interface LaserSafetyPanelProps {
  summary: RigLaserSafetySummary;
  flickerWarning?: string | null;
}

/**
 * IEC 60825 / ANSI Z136 design-guidance panel for the Laser tab.
 * Uses a calm `role="status"` live region that announces only discrete safety state transitions
 * (never numeric slider ticks), and communicates status via icon + text rather than color alone.
 */
export const LaserSafetyPanel: React.FC<LaserSafetyPanelProps> = ({ summary, flickerWarning }) => {
  if (summary.projectorCount === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[10px] text-zinc-400">
        No laser projectors patched in this rig.
      </div>
    );
  }

  const meta = LEVEL_META[summary.level];
  const statusLabel = summary.level === 'ok' ? okLabelForSummary(summary) : meta.label;
  const uniqueHazardMessages: string[] = [];
  const seen = new Set<string>();
  for (const p of summary.projectors) {
    for (const f of p.findings) {
      if (f.severity !== 'danger') continue;
      if (seen.has(f.code)) continue;
      seen.add(f.code);
      uniqueHazardMessages.push(f.message);
    }
  }

  // Discrete status text for assistive tech: only changes when level or hazard flags change.
  const statusAnnouncement =
    summary.level === 'danger'
      ? `Laser guidance danger: ${[
          summary.audienceHazardCount > 0 ? 'beam in audience zone' : null,
          summary.stationaryHazardCount > 0 ? 'stationary beam hazard' : null,
        ]
          .filter(Boolean)
          .join(', ') || 'audience scanning active'}`
      : summary.level === 'caution'
        ? 'Laser guidance caution'
        : summary.minClearanceM === null
          ? 'Laser guidance: no estimated audience-zone hit'
          : 'Laser guidance: estimated overhead clearance at least 3 meters';

  const clearsThreshold =
    summary.minClearanceM !== null && summary.minClearanceM >= MIN_AUDIENCE_CLEARANCE_M - 1e-6;
  const formattedClearance =
    summary.minClearanceM === null ? null : formatClearanceM(summary.minClearanceM);
  const clearanceText =
    formattedClearance === null
      ? 'No ray enters audience zone (est.)'
      : `Min. clearance ${formattedClearance} m (${
          clearsThreshold ? '≥' : 'needs ≥'
        } ${MIN_AUDIENCE_CLEARANCE_M.toFixed(1)} m · ${summary.lateralGuidanceM.toFixed(1)} m lateral guidance)`;

  return (
    <div
      data-testid="laser-safety-panel"
      data-level={summary.level}
      className={`rounded-lg border px-2.5 py-1.5 space-y-1 text-[10px] ${meta.panelClass}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="laser-safety-status"
          className="inline-flex items-center gap-1.5 font-mono-tech font-bold uppercase tracking-wider text-[10px]"
        >
          <LevelIcon level={summary.level} className="w-3.5 h-3.5 shrink-0" />
          <span>{statusLabel}</span>
          <span className="sr-only"> — {statusAnnouncement}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[9px] text-zinc-200">
          <span data-testid="laser-clearance-readout">{clearanceText}</span>
          <span className="px-1 py-0.5 rounded bg-black/40 border border-white/15">
            {summary.hasClass4 ? 'Class 4' : 'Class 3B'}
          </span>
        </div>
      </div>

      {uniqueHazardMessages.length > 0 && (
        <ul className="space-y-0.5 text-[10px] text-rose-100/95 leading-snug">
          {uniqueHazardMessages.map((msg) => (
            <li key={msg} className="flex items-start gap-1">
              <span aria-hidden="true">•</span>
              <span>{msg}</span>
            </li>
          ))}
        </ul>
      )}

      {flickerWarning && (
        <div
          data-testid="laser-flicker-warning"
          className="inline-flex items-center gap-1 rounded bg-amber-500/20 border border-amber-400/50 px-1.5 py-0.5 font-mono-tech text-[9px] text-amber-100"
        >
          <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span>{flickerWarning}</span>
        </div>
      )}

      <p className="text-[9px] text-zinc-300/85 leading-tight">
        IEC 60825-3 / ANSI Z136.1: {summary.disclaimer}
      </p>
    </div>
  );
};
