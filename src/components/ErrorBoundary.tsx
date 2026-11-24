import React from 'react';

interface ErrorBoundaryProps {
  label?: string;
  onReset?: () => void;
  onExportRig?: () => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
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
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { label, onReset, onExportRig } = this.props;
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
            {onExportRig && (
              <button
                type="button"
                onClick={onExportRig}
                className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/20 text-xs text-zinc-100 cursor-pointer"
              >
                Export rig JSON
              </button>
            )}
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
