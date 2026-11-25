import React from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert, ShieldCheck, X, XCircle } from 'lucide-react';
import type { PreflightAcknowledgementState, PreflightReport, PreflightRow } from '../data/preflight';

interface PreflightPanelProps {
  open: boolean;
  report: PreflightReport;
  acks: PreflightAcknowledgementState;
  liveViolationMessage?: string | null;
  onRunCheck: () => void;
  onToggleRowAck: (row: PreflightRow, checked: boolean) => void;
  onToggleLaserAck: (projectorKey: string, checked: boolean) => void;
  onToggleLaserInhibit: (projectorKey: string, inhibited: boolean) => void;
  onClose: () => void;
}

function OutcomeBadge({ row }: { row: PreflightRow }) {
  if (row.outcome === 'pass') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded border border-emerald-400/45 bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">
        <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />
        PASS
      </span>
    );
  }
  if (row.outcome === 'warn') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded border border-amber-400/50 bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-200">
        <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
        WARN
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-rose-400/60 bg-rose-500/25 px-1.5 py-0.5 text-[9px] font-bold text-rose-200">
      <XCircle className="w-2.5 h-2.5" aria-hidden="true" />
      FAIL
    </span>
  );
}

/**
 * Visible pre-flight gate panel evaluating every fixture group, laser projector,
 * rigging load, and power circuit. Enforces explicit acknowledgements (never skipping lasers)
 * and blocks arming on hard failures or stale configuration revisions.
 */
export const PreflightPanel: React.FC<PreflightPanelProps> = ({
  open,
  report,
  acks,
  liveViolationMessage,
  onRunCheck,
  onToggleRowAck,
  onToggleLaserAck,
  onToggleLaserInhibit,
  onClose,
}) => {
  if (!open) return null;

  const checkedCurrent = report.checked && !report.stale;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="preflight-panel-title"
      data-testid="preflight-panel"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3"
    >
      <div className="bg-zinc-950/95 w-full max-w-2xl max-h-[86vh] rounded-xl border border-white/15 shadow-2xl flex flex-col overflow-hidden font-mono-tech text-[11px] text-zinc-100">
        <header className="flex items-center justify-between gap-2 px-4 py-3 bg-black/65 border-b border-white/10">
          <div className="min-w-0">
            <h2 id="preflight-panel-title" className="font-display font-bold text-sm text-white flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" aria-hidden="true" />
              <span>PRE-FLIGHT SAFETY CHECK</span>
              <span
                data-testid="preflight-panel-status"
                className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                  report.overallStatus === 'passed'
                    ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
                    : report.overallStatus === 'blocked'
                      ? 'border-rose-400/60 bg-rose-500/25 text-rose-100'
                      : report.overallStatus === 'warnings'
                        ? 'border-amber-400/55 bg-amber-500/20 text-amber-100'
                        : 'border-white/20 bg-white/10 text-zinc-200'
                }`}
              >
                {report.badgeLabel}
              </span>
            </h2>
            <p className="text-[10px] text-zinc-400 mt-0.5">{report.calibrationNote}</p>
          </div>
          <button
            type="button"
            aria-label="Close pre-flight check"
            onClick={onClose}
            className="p-1.5 rounded bg-white/5 hover:bg-rose-500/25 text-zinc-300 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <div className="px-4 py-2.5 bg-black/40 border-b border-white/10 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] text-zinc-300">
              <span>Rev <code className="text-cyan-300">{report.configRevision}</code></span>
              <span className="mx-1.5 text-zinc-600">·</span>
              <span>{report.counts.pass} pass · {report.counts.warn} warn · {report.counts.fail} fail</span>
              {report.counts.laserTotal > 0 && (
                <>
                  <span className="mx-1.5 text-zinc-600">·</span>
                  <span>Lasers {report.counts.laserAddressed}/{report.counts.laserTotal} addressed</span>
                </>
              )}
            </div>
            <button
              type="button"
              data-testid="preflight-run-check"
              onClick={onRunCheck}
              className="inline-flex items-center gap-1.5 rounded border border-cyan-400/60 bg-cyan-500/20 hover:bg-cyan-500/30 px-2.5 py-1 text-[10px] font-bold text-cyan-100 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              {checkedCurrent ? 'Re-run check' : 'Run pre-flight check'}
            </button>
          </div>

          {report.stale && (
            <p role="alert" data-testid="preflight-stale-notice" className="rounded border border-amber-400/60 bg-amber-950/50 px-2.5 py-1.5 text-[10px] text-amber-100">
              Rig, patch, look, or aim changed since the last check. Re-run pre-flight and review any updated rows before arming output.
            </p>
          )}

          {liveViolationMessage && (
            <p role="alert" data-testid="preflight-live-violation" className="rounded border border-rose-400/70 bg-rose-950/60 px-2.5 py-1.5 text-[10px] text-rose-100">
              Live safety warning: {liveViolationMessage}
            </p>
          )}

          {report.crowdScanWarning && (
            <p role="note" data-testid="preflight-crowd-scan-warning" className="rounded border border-amber-400/50 bg-amber-950/40 px-2.5 py-1.5 text-[10px] text-amber-100 flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300" aria-hidden="true" />
              <span>{report.crowdScanWarning} {report.lsoNotice}</span>
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {report.rows.map((row) => {
            const rowAcked = checkedCurrent && acks.acknowledgedRows[row.id] === row.rowFingerprint;
            const laserAcked =
              Boolean(row.projectorKey) &&
              checkedCurrent &&
              acks.acknowledgedLasers[row.projectorKey!] === row.rowFingerprint;
            const laserInhibited =
              Boolean(row.projectorKey) &&
              Boolean(acks.inhibitedLasers[row.projectorKey!]);

            return (
              <div
                key={row.id}
                data-testid={`preflight-row-${row.id}`}
                data-outcome={row.outcome}
                className={`rounded-lg border p-2.5 space-y-1.5 ${
                  row.hardBlock
                    ? 'border-rose-500/60 bg-rose-950/35'
                    : row.outcome === 'fail'
                      ? 'border-rose-400/45 bg-rose-950/25'
                      : row.outcome === 'warn'
                        ? 'border-amber-400/35 bg-amber-950/20'
                        : 'border-white/10 bg-black/35'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-white">
                      {row.label}
                      <span className="ml-1.5 font-normal text-zinc-400">· {row.location}</span>
                    </div>
                    <p className="text-[10px] text-zinc-300 leading-snug mt-0.5">{row.summary}</p>
                  </div>
                  <OutcomeBadge row={row} />
                </div>

                {row.hardBlock && (
                  <p className="text-[10px] font-semibold text-rose-200">
                    Hard block: resolve this issue on the rig/desk before arming output (cannot be acknowledged away).
                  </p>
                )}

                {!row.hardBlock && !row.isLaser && row.canAcknowledge && (
                  <label className="inline-flex items-center gap-2 text-[10px] text-amber-100 cursor-pointer pt-0.5">
                    <input
                      type="checkbox"
                      disabled={!checkedCurrent}
                      data-testid={`preflight-ack-${row.id}`}
                      checked={rowAcked}
                      onChange={(e) => onToggleRowAck(row, e.target.checked)}
                    />
                    <span>Acknowledge warning for this session</span>
                  </label>
                )}

                {!row.hardBlock && row.isLaser && row.projectorKey && (
                  <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-white/10">
                    {row.canAcknowledge && (
                      <label className="inline-flex items-center gap-2 text-[10px] text-amber-100 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={!checkedCurrent || laserInhibited}
                          data-testid={`preflight-laser-ack-${row.projectorKey}`}
                          checked={laserAcked}
                          onChange={(e) => onToggleLaserAck(row.projectorKey!, e.target.checked)}
                        />
                        <span>Acknowledge laser projector (LSO site-verified)</span>
                      </label>
                    )}
                    {row.canInhibitLaser && (
                      <label className="inline-flex items-center gap-2 text-[10px] text-cyan-100 cursor-pointer">
                        <input
                          type="checkbox"
                          data-testid={`preflight-laser-inhibit-${row.projectorKey}`}
                          checked={laserInhibited}
                          onChange={(e) => onToggleLaserInhibit(row.projectorKey!, e.target.checked)}
                        />
                        <span>Inhibit physical DMX (force 0 for this session)</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <footer className="px-4 py-2.5 bg-black/65 border-t border-white/10 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span
              data-testid="preflight-eligibility"
              className={`text-[10px] font-bold ${report.canArm ? 'text-emerald-300' : 'text-amber-200'}`}
            >
              {report.canArm
                ? 'Eligible to arm live output (fresh two-step confirmation still required in DMX Output).'
                : report.blockingReasons[0] ?? 'Complete all required checks and acknowledgements to arm output.'}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-white/15 bg-white/10 hover:bg-white/15 px-3 py-1 text-[10px] font-semibold text-white cursor-pointer"
            >
              Done
            </button>
          </div>
          <p className="text-[9px] text-zinc-400 leading-snug">{report.disclaimer}</p>
        </footer>
      </div>
    </div>
  );
};
