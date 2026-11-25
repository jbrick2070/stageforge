import React from 'react';
import { Bot, Check, RotateCcw, X } from 'lucide-react';
import type { AiBridgeApi } from '../aiBridge/useAiBridge';

interface AiProposalBannerProps {
  bridge: AiBridgeApi;
}

export const AiProposalBanner: React.FC<AiProposalBannerProps> = ({ bridge }) => {
  const pending = bridge.pendingProposals;
  if (pending.length === 0) return null;

  const current = pending[0];
  const stale = bridge.isProposalStale(current);

  return (
    <div
      role="region"
      aria-label="Pending AI proposal"
      data-testid="ai-proposal-banner"
      className="fixed top-16 left-1/2 -translate-x-1/2 z-40 w-[min(540px,calc(100vw-24px))] rounded-xl border border-fuchsia-400/50 bg-[#0d0d14] shadow-2xl p-3 font-mono-tech text-[11px] text-zinc-100 space-y-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="w-4 h-4 text-fuchsia-300 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-fuchsia-200 uppercase tracking-wider text-[10px]">
                AI Proposal ({current.tool})
              </span>
              {pending.length > 1 && (
                <span className="rounded bg-fuchsia-500/25 px-1.5 py-0.5 text-[9px] text-fuchsia-100">
                  1 of {pending.length}
                </span>
              )}
            </div>
            <p data-testid="ai-proposal-summary" className="text-white font-semibold truncate">
              {current.summary}
            </p>
          </div>
        </div>
        {bridge.hasRevertSnapshot && (
          <button
            type="button"
            onClick={() => bridge.revertAiChanges()}
            className="flex items-center gap-1 px-2 py-1 rounded border border-amber-400/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-100 text-[10px] shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" />
            Revert AI
          </button>
        )}
      </div>

      <ul
        data-testid="ai-proposal-diff"
        className="max-h-28 overflow-y-auto rounded bg-black/60 border border-white/10 px-2.5 py-1.5 space-y-0.5 text-[10px] text-zinc-300"
      >
        {current.diffLines.map((line, idx) => (
          <li key={idx} className="break-words">{line}</li>
        ))}
      </ul>

      {stale && (
        <p role="alert" className="text-[10px] text-amber-300">
          Desk changed since this proposal was created. Reject it and ask the AI to re-propose against the current state.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="ai-proposal-reject"
          onClick={() => bridge.rejectProposal(current.id)}
          className="flex items-center gap-1 px-3 py-1.5 rounded bg-white/10 hover:bg-white/15 text-zinc-200 font-semibold cursor-pointer"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
          Reject
        </button>
        <button
          type="button"
          disabled={stale || bridge.blockedByOutput}
          data-testid="ai-proposal-accept"
          onClick={() => bridge.acceptProposal(current.id)}
          className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" aria-hidden="true" />
          Accept
        </button>
      </div>
    </div>
  );
};
