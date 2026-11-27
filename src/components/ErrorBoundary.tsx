import React from 'react';
import { downloadStageFile } from '../data/rigImport';
import { makeDesignRecoveryShow, readSavedDesign } from '../data/savedDesign';
import { isViewerUrlSearch } from '../viewer/capabilities';

interface ErrorBoundaryProps {
  label?: string;
  onReset?: () => void;
  onExportRig?: () => void;
  rigExportIssue?: string;
  onExportShow?: () => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  exportError?: string;
}

/**
 * React error boundary so a render-time error never blanks the entire workstation without recovery.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[StageForge:${this.props.label ?? 'app'}]`, error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, exportError: undefined });
    this.props.onReset?.();
  };

  private exportShow = () => {
    try {
      if (this.props.onExportShow) return this.props.onExportShow();
      const saved = readSavedDesign();
      if (saved.status !== 'ready') throw new Error('No readable local design is available for recovery.');
      const file = makeDesignRecoveryShow(saved.record.current);
      downloadStageFile(file.rig.name, 'stageforge.show.json', new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    } catch (error) {
      this.setState({ exportError: error instanceof Error ? error.message : 'Could not export the recovery show.' });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { label, onReset, onExportRig, rigExportIssue, onExportShow } = this.props;
    const canExportShow = onExportShow || (!label && !isViewerUrlSearch(window.location.search));
    return (
      <div
        role="alert"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6 text-zinc-100 font-mono-tech"
      >
        <div className="max-w-lg w-full rounded-xl border border-rose-500/60 bg-zinc-950 p-5 shadow-2xl space-y-3">
          <h2 className="font-display text-base font-bold text-rose-300 tracking-wide">
            {label ? `${label} hit an unexpected error` : 'StageForge hit an unexpected error'}
          </h2>
          <p className="text-xs text-zinc-300 break-words">
            {this.state.error.message || 'An unhandled render error occurred.'}
          </p>
          {rigExportIssue && <p className="text-xs text-zinc-300">{rigExportIssue}</p>}
          {this.state.exportError && <p className="text-xs text-rose-300">{this.state.exportError}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {onReset && (
              <button
                type="button"
                onClick={this.reset}
                className="px-3 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/35 border border-cyan-400/50 text-xs text-cyan-100 cursor-pointer"
              >
                Recover panel
              </button>
            )}
            {onExportRig && !rigExportIssue && (
              <button
                type="button"
                onClick={onExportRig}
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20 text-xs text-zinc-100 cursor-pointer"
              >
                Export rig JSON
              </button>
            )}
            {canExportShow && <button type="button" onClick={this.exportShow} className="transport-btn">Export recovery Show JSON</button>}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded bg-rose-500/25 hover:bg-rose-500/40 border border-rose-400/50 text-xs text-rose-100 cursor-pointer"
            >
              Reload StageForge
            </button>
          </div>
        </div>
      </div>
    );
  }
}
