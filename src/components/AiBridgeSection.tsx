import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Copy, Eye, EyeOff, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import type { AiBridgeApi } from '../aiBridge/useAiBridge';
import { buildAiClientSnippets } from '../aiBridge/aiBridgeProtocol';

interface AiBridgeSectionProps {
  bridge: AiBridgeApi;
}

export const AiBridgeSection: React.FC<AiBridgeSectionProps> = ({ bridge }) => {
  const [portDraft, setPortDraft] = useState(() => String(bridge.port));
  const [showToken, setShowToken] = useState(false);
  const [snippetTab, setSnippetTab] = useState<'claude' | 'codex' | 'cursor'>('claude');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    setPortDraft(String(bridge.port));
  }, [bridge.port]);

  useEffect(() => {
    if (!bridge.enabled) setShowToken(false);
  }, [bridge.enabled]);

  const snippets = useMemo(() => {
    if (!bridge.enabled || !bridge.status.url || !bridge.status.token) return null;
    return buildAiClientSnippets(bridge.status.url, bridge.status.token);
  }, [bridge.enabled, bridge.status.token, bridge.status.url]);

  const copyText = (key: string, text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
      setCopiedField(key);
      window.setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      // Ignore clipboard failures in headless/restricted contexts.
    }
  };

  const commitPort = (raw: string) => {
    const n = Number(raw);
    const valid = Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : bridge.port;
    setPortDraft(String(valid));
    if (valid !== bridge.port) bridge.setPort(valid);
  };

  const activeSnippet = snippets
    ? (snippetTab === 'claude' ? snippets.claudeCode : snippetTab === 'codex' ? snippets.codexCli : snippets.cursorJson)
    : '';

  return (
    <section
      aria-label="AI bridge"
      data-testid="ai-bridge-section"
      className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-wider text-fuchsia-300 uppercase flex items-center gap-1">
          <Bot className="w-3 h-3" aria-hidden="true" /> AI Bridge (Local MCP)
        </span>
        <span
          data-testid="ai-bridge-status"
          className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
            bridge.enabled ? 'bg-fuchsia-500/30 text-fuchsia-100 border border-fuchsia-400/50' : 'bg-white/10 text-zinc-400'
          }`}
        >
          {bridge.enabled ? `ON · 127.0.0.1:${bridge.status.port}` : 'OFF'}
        </span>
      </div>

      {!bridge.hasDesktopBridge ? (
        <p className="text-[9px] text-zinc-400 leading-snug">
          Local MCP server (<code>http://127.0.0.1:&lt;port&gt;/mcp</code>) is available in the StageForge desktop app.
          Always off by default; loopback only; mutually exclusive with live DMX output.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-[9px] text-zinc-400 leading-snug">
            Bring your own local MCP client (Claude Code, Codex, Cursor). Binds strictly to{' '}
            <code>127.0.0.1</code> with a fresh token on every enable. Live DMX output and outbound OSC/TC feedback are disabled while on.
          </p>

          {bridge.blockedByOutput && !bridge.enabled && (
            <p
              role="status"
              data-testid="ai-bridge-output-blocked"
              className="rounded border border-amber-400/45 bg-amber-950/35 px-2 py-1 text-[9px] text-amber-100 flex items-start gap-1.5"
            >
              <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
              <span>Disarm or stop live DMX output before enabling the AI bridge.</span>
            </p>
          )}

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="text-[9px] text-zinc-400">Port</span>
              <input
                type="number"
                min={1024}
                max={65535}
                disabled={bridge.enabled || bridge.busy}
                aria-label="AI bridge port"
                data-testid="ai-bridge-port"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={() => commitPort(portDraft)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitPort(portDraft); }}
                className="w-20 bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white disabled:opacity-50"
              />
            </label>

            {bridge.enabled ? (
              <button
                type="button"
                disabled={bridge.busy}
                data-testid="ai-bridge-disable"
                onClick={() => void bridge.disable()}
                className="ml-auto px-2.5 py-1 rounded bg-rose-600/85 hover:bg-rose-500 text-white font-semibold cursor-pointer disabled:opacity-50"
              >
                {bridge.busy ? 'Stopping…' : 'Disable AI bridge'}
              </button>
            ) : (
              <button
                type="button"
                disabled={bridge.busy || bridge.blockedByOutput}
                data-testid="ai-bridge-enable"
                onClick={() => {
                  const n = Number(portDraft);
                  const valid = Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : bridge.port;
                  if (valid !== bridge.port) bridge.setPort(valid);
                  void bridge.enable(valid);
                }}
                className="ml-auto px-2.5 py-1 rounded bg-fuchsia-500/30 border border-fuchsia-400/50 hover:bg-fuchsia-500/40 text-fuchsia-100 font-semibold cursor-pointer disabled:opacity-40"
              >
                {bridge.busy ? 'Starting…' : 'Enable AI bridge'}
              </button>
            )}
          </div>

          {bridge.error && (
            <p role="alert" data-testid="ai-bridge-error" className="text-[9px] text-rose-300">
              {bridge.error}
            </p>
          )}

          {bridge.enabled && bridge.status.url && bridge.status.token && (
            <div className="space-y-1.5 pt-1.5 border-t border-white/10">
              <div className="flex items-center justify-between gap-1 text-[9px]">
                <span className="text-zinc-400">Endpoint:</span>
                <code data-testid="ai-bridge-url" className="text-fuchsia-200 select-all">{bridge.status.url}</code>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-zinc-400 shrink-0">Token:</span>
                <code
                  data-testid="ai-bridge-token"
                  data-token={bridge.status.token}
                  className="flex-1 truncate rounded bg-black/70 border border-white/10 px-1.5 py-0.5 text-[9px] text-zinc-200"
                >
                  {showToken ? bridge.status.token : '••••••••••••••••••••••••••••'}
                </code>
                <button
                  type="button"
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  onClick={() => setShowToken((v) => !v)}
                  className="p-1 rounded bg-white/10 hover:bg-white/15 text-zinc-200 cursor-pointer"
                >
                  {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                  type="button"
                  aria-label="Copy bearer token"
                  onClick={() => copyText('token', bridge.status.token!)}
                  className="p-1 rounded bg-white/10 hover:bg-white/15 text-zinc-200 cursor-pointer"
                >
                  {copiedField === 'token' ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>

              {/* Copy-ready client config snippets */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex gap-1" role="tablist" aria-label="MCP client config snippets">
                    {(['claude', 'codex', 'cursor'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={snippetTab === tab}
                        onClick={() => setSnippetTab(tab)}
                        className={`px-1.5 py-0.5 rounded text-[9px] cursor-pointer ${
                          snippetTab === tab
                            ? 'bg-fuchsia-500/30 text-fuchsia-100 border border-fuchsia-400/40'
                            : 'bg-white/5 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {tab === 'claude' ? 'Claude Code' : tab === 'codex' ? 'Codex' : 'Cursor'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText('snippet', activeSnippet)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/15 text-[9px] text-zinc-200 cursor-pointer"
                  >
                    {copiedField === 'snippet' ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                    {copiedField === 'snippet' ? 'Copied' : 'Copy snippet'}
                  </button>
                </div>
                <pre className="rounded bg-black/80 border border-white/10 p-1.5 text-[8.5px] text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all select-all">
                  {activeSnippet}
                </pre>
              </div>

              {/* Human-only session auto-accept toggle (off by default, cleared on disable) */}
              <label className="flex items-center gap-1.5 text-[9px] text-zinc-200 cursor-pointer pt-0.5">
                <input
                  type="checkbox"
                  data-testid="ai-bridge-auto-accept"
                  checked={bridge.autoAccept}
                  onChange={(e) => bridge.setAutoAccept(e.target.checked)}
                />
                Auto-accept proposals for this session (reset when disabled)
              </label>
            </div>
          )}

          {/* Whole-desk Revert button (persists after disable until reverted or new show opened) */}
          {bridge.hasRevertSnapshot && (
            <div className="pt-1.5 border-t border-white/10 space-y-1">
              <button
                type="button"
                data-testid="ai-bridge-revert"
                onClick={() => bridge.revertAiChanges()}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded border border-amber-400/50 bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-semibold cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                Revert AI changes
              </button>
              <p className="text-[8.5px] text-zinc-400 leading-snug">
                Restores the full desk snapshot captured before the first AI change (also discards manual edits made since).
              </p>
            </div>
          )}

          {/* In-app tool call log (capped at 500 entries, zero telemetry) */}
          <div className="pt-1.5 border-t border-white/10 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold text-zinc-400 uppercase tracking-wider">
                AI tool log ({bridge.toolLog.length}/500)
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={bridge.toolLog.length === 0}
                  data-testid="ai-bridge-copy-log"
                  onClick={() => copyText('log', bridge.copyToolLogText())}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/15 text-[9px] text-zinc-200 cursor-pointer disabled:opacity-40"
                >
                  {copiedField === 'log' ? <Check className="w-2.5 h-2.5 text-emerald-300" /> : <Copy className="w-2.5 h-2.5" />}
                  Copy log
                </button>
                <button
                  type="button"
                  disabled={bridge.toolLog.length === 0}
                  aria-label="Clear AI tool log"
                  onClick={bridge.clearToolLog}
                  className="p-0.5 rounded bg-white/5 hover:bg-white/15 text-zinc-400 hover:text-white cursor-pointer disabled:opacity-40"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
            <div
              data-testid="ai-bridge-tool-log"
              className="max-h-28 overflow-y-auto space-y-0.5 bg-black/60 rounded border border-white/10 p-1.5 text-[8.5px]"
            >
              {bridge.toolLog.length === 0 ? (
                <div className="text-zinc-500">No AI tool calls yet.</div>
              ) : (
                bridge.toolLog.map((entry) => (
                  <div
                    key={entry.id}
                    className={`flex items-start justify-between gap-1.5 ${entry.ok ? 'text-zinc-200' : 'text-rose-300'}`}
                  >
                    <span className="truncate">
                      <span className="text-fuchsia-300">{entry.tool}</span> {entry.resultSummary}
                    </span>
                    <span className="text-zinc-500 shrink-0 tabular-nums">
                      {new Date(entry.at).toLocaleTimeString([], { hour12: false })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
