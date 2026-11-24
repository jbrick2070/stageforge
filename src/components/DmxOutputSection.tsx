import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Search, ShieldAlert, Square, Zap } from 'lucide-react';
import type { LiveDmxControllerApi } from '../dmx/useLiveDmxOutput';
import { formatArtNetAddress, parseTargetList, type DmxOutputMode } from '../dmx/liveDmx';

interface DmxOutputSectionProps {
  output: LiveDmxControllerApi;
  hasCatalogFixtures?: boolean;
}

export const DmxOutputSection: React.FC<DmxOutputSectionProps> = ({ output, hasCatalogFixtures }) => {
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState(false);

  const {
    hasDesktopBridge,
    hasWebSerial,
    settings,
    updateSettings,
    interfaces,
    refreshInterfaces,
    desktopStatus,
    serialStatus,
    discoveredNodes,
    discovering,
    discoveryWarning,
    discoverArtNet,
    busy,
    error,
    isLive,
    enable,
    disable,
  } = output;

  // Fetch local network interfaces when the output panel is opened in Electron.
  useEffect(() => {
    if (expanded && hasDesktopBridge) {
      void refreshInterfaces();
    }
  }, [expanded, hasDesktopBridge, refreshInterfaces]);

  // Automatically disarm if output goes live or panel collapses.
  useEffect(() => {
    if (isLive || !expanded) setArmed(false);
  }, [isLive, expanded]);

  const patchSettings = (patch: Parameters<typeof updateSettings>[0]) => {
    setArmed(false);
    updateSettings(patch);
  };

  const selectedIface = interfaces.find((item) => item.address === settings.iface);
  const loopbackSelected = !selectedIface ? settings.iface === '127.0.0.1' : selectedIface.internal;

  const addDiscoveredNode = (ip: string) => {
    const existing = parseTargetList(settings.artnetTargets);
    if (existing.includes(ip) || existing.length >= 8) return;
    patchSettings({ artnetTargets: [...existing, ip].join(', ') });
  };

  return (
    <section
      aria-label="Live output"
      data-testid="dmx-output-section"
      className="border-b border-white/10 bg-black/50"
    >
      <button
        type="button"
        data-testid="dmx-output-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-white/5 cursor-pointer"
      >
        <span className="flex items-center gap-1.5 font-mono-tech text-[10px] font-semibold tracking-wider text-zinc-200">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          OUTPUT
          <span
            data-testid="dmx-output-status-pill"
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
              isLive
                ? 'bg-rose-600/80 text-white'
                : 'bg-white/10 text-zinc-400'
            }`}
          >
            {isLive ? 'LIVE' : 'OFF'}
          </span>
        </span>
        <span className="font-mono-tech text-[9px] text-zinc-400">
          {isLive
            ? output.banner.detail
            : hasDesktopBridge
              ? 'sACN · Art-Net 4 · USB Pro'
              : 'USB Pro (Web Serial)'}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 pt-1 space-y-2 font-mono-tech text-[10px] border-t border-white/5 max-h-[300px] overflow-y-auto">
          {hasCatalogFixtures && (
            <p role="note" className="rounded border border-cyan-400/40 bg-cyan-950/40 px-2 py-1 text-[9px] text-cyan-100">
              Simulated control layout, not the fixture&apos;s real channel map.
            </p>
          )}
          {/* Protocol / transport selector */}
          <div className="flex gap-1" role="group" aria-label="Output transport">
            {([
              ...(hasDesktopBridge
                ? [
                    { id: 'sacn' as DmxOutputMode, label: 'sACN' },
                    { id: 'artnet' as DmxOutputMode, label: 'Art-Net 4' },
                  ]
                : []),
              { id: 'serial' as DmxOutputMode, label: 'USB Pro' },
            ]).map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={isLive}
                data-testid={`dmx-output-mode-${item.id}`}
                aria-pressed={settings.mode === item.id}
                onClick={() => patchSettings({ mode: item.id })}
                className={`flex-1 py-1 rounded border text-[10px] cursor-pointer disabled:opacity-50 ${
                  settings.mode === item.id
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                    : 'bg-white/5 border-white/10 text-zinc-400'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {!hasDesktopBridge && (
            <p className="text-[9px] text-zinc-400 leading-snug">
              Browser builds support Enttec DMX USB Pro over Web Serial. Use the StageForge desktop app for sACN (E1.31) and Art-Net 4 UDP output.
            </p>
          )}

          {/* Network interface & protocol settings (Electron main) */}
          {settings.mode !== 'serial' && hasDesktopBridge && (
            <>
              <div className="flex items-center gap-1.5">
                <label className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[9px] text-zinc-400">Network interface</span>
                  <select
                    data-testid="dmx-output-iface"
                    disabled={isLive}
                    value={settings.iface}
                    onChange={(e) => {
                      const nextIface = e.target.value;
                      const info = interfaces.find((item) => item.address === nextIface);
                      patchSettings({
                        iface: nextIface,
                        artnetBroadcast: info?.internal ? false : settings.artnetBroadcast,
                      });
                    }}
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-1 text-[10px] text-white disabled:opacity-50"
                  >
                    {interfaces.length === 0 && <option value={settings.iface}>{settings.iface}</option>}
                    {interfaces.map((iface) => (
                      <option key={iface.address} value={iface.address}>
                        {iface.address} — {iface.name}{iface.internal ? ' (local)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={isLive}
                  title="Refresh network interfaces"
                  aria-label="Refresh network interfaces"
                  onClick={() => void refreshInterfaces()}
                  className="mt-3.5 p-1.5 rounded bg-white/5 border border-white/10 text-zinc-300 hover:bg-white/10 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>

              {settings.mode === 'sacn' ? (
                <div className="space-y-1.5">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={isLive}
                      data-testid="dmx-output-sacn-multicast"
                      aria-pressed={settings.sacnMode === 'multicast'}
                      onClick={() => patchSettings({ sacnMode: 'multicast' })}
                      className={`flex-1 py-0.5 rounded border cursor-pointer disabled:opacity-50 ${
                        settings.sacnMode === 'multicast'
                          ? 'bg-white/15 border-white/30 text-white'
                          : 'bg-white/5 border-white/10 text-zinc-400'
                      }`}
                    >
                      Multicast
                    </button>
                    <button
                      type="button"
                      disabled={isLive}
                      data-testid="dmx-output-sacn-unicast"
                      aria-pressed={settings.sacnMode === 'unicast'}
                      onClick={() => patchSettings({ sacnMode: 'unicast' })}
                      className={`flex-1 py-0.5 rounded border cursor-pointer disabled:opacity-50 ${
                        settings.sacnMode === 'unicast'
                          ? 'bg-white/15 border-white/30 text-white'
                          : 'bg-white/5 border-white/10 text-zinc-400'
                      }`}
                    >
                      Unicast
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] text-zinc-400">SF U1 →</span>
                      <input
                        type="number"
                        min={1}
                        max={63999}
                        disabled={isLive}
                        data-testid="dmx-output-sacn-u1"
                        value={settings.sacnUniverse1}
                        onChange={(e) => patchSettings({ sacnUniverse1: Math.max(1, Math.min(63999, Number(e.target.value) || 1)) })}
                        className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white disabled:opacity-50"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] text-zinc-400">SF U2 →</span>
                      <input
                        type="number"
                        min={1}
                        max={63999}
                        disabled={isLive}
                        data-testid="dmx-output-sacn-u2"
                        value={settings.sacnUniverse2}
                        onChange={(e) => patchSettings({ sacnUniverse2: Math.max(1, Math.min(63999, Number(e.target.value) || 2)) })}
                        className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white disabled:opacity-50"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] text-zinc-400">Priority</span>
                      <input
                        type="number"
                        min={0}
                        max={200}
                        disabled={isLive}
                        data-testid="dmx-output-sacn-priority"
                        value={settings.sacnPriority}
                        onChange={(e) => patchSettings({ sacnPriority: Math.max(0, Math.min(200, Number(e.target.value) || 0)) })}
                        className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white disabled:opacity-50"
                      />
                    </label>
                  </div>
                  {settings.sacnMode === 'unicast' && (
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] text-zinc-400">Unicast target IPs (comma-separated, max 8)</span>
                      <input
                        type="text"
                        disabled={isLive}
                        data-testid="dmx-output-sacn-targets"
                        placeholder="127.0.0.1"
                        value={settings.sacnTargets}
                        onChange={(e) => patchSettings({ sacnTargets: e.target.value })}
                        className="bg-black/70 border border-white/15 rounded px-1.5 py-1 text-white disabled:opacity-50"
                      />
                    </label>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-zinc-400">Base Port-Address (0-based, 0–32766)</span>
                    <input
                      type="number"
                      min={0}
                      max={32766}
                      disabled={isLive}
                      data-testid="dmx-output-artnet-base"
                      value={settings.artnetBase}
                      onChange={(e) => patchSettings({ artnetBase: Math.max(0, Math.min(32766, Number(e.target.value) || 0)) })}
                      className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white disabled:opacity-50"
                    />
                  </label>
                  <p className="text-[9px] text-zinc-400">
                    U1 → {formatArtNetAddress(settings.artnetBase)} · U2 → {formatArtNetAddress(settings.artnetBase + 1)}
                  </p>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] text-zinc-400">Unicast node IPs (max 8)</span>
                    <div className="flex gap-1">
                      <input
                        type="text"
                        disabled={isLive}
                        data-testid="dmx-output-artnet-targets"
                        placeholder="127.0.0.1"
                        value={settings.artnetTargets}
                        onChange={(e) => patchSettings({ artnetTargets: e.target.value })}
                        className="flex-1 bg-black/70 border border-white/15 rounded px-1.5 py-1 text-white disabled:opacity-50"
                      />
                      <button
                        type="button"
                        disabled={discovering}
                        data-testid="dmx-output-artnet-scan"
                        onClick={() => void discoverArtNet()}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/15 text-zinc-100 cursor-pointer disabled:opacity-50"
                      >
                        <Search className="w-3 h-3" />
                        {discovering ? 'Scanning…' : 'Scan'}
                      </button>
                    </div>
                  </label>
                  <label className="flex items-center gap-1.5 text-[9px] text-zinc-300">
                    <input
                      type="checkbox"
                      disabled={isLive || loopbackSelected}
                      checked={!loopbackSelected && settings.artnetBroadcast}
                      onChange={(e) => patchSettings({ artnetBroadcast: e.target.checked })}
                    />
                    Directed broadcast{selectedIface?.broadcast ? ` (${selectedIface.broadcast})` : ' (unavailable on loopback)'}
                  </label>
                  {discoveryWarning && (
                    <p role="status" className="text-[9px] text-amber-300">{discoveryWarning}</p>
                  )}
                  {discoveredNodes.length > 0 && (
                    <div className="space-y-1 bg-black/40 border border-white/10 rounded p-1.5">
                      <div className="text-[9px] text-zinc-400">Discovered nodes ({discoveredNodes.length})</div>
                      {discoveredNodes.map((node) => (
                        <div key={`${node.ip}:${node.bindIndex}`} className="flex items-center justify-between gap-1 text-[9px]">
                          <span className="truncate text-zinc-200" title={node.longName}>
                            {node.shortName} ({node.ip})
                          </span>
                          <button
                            type="button"
                            disabled={isLive}
                            onClick={() => addDiscoveredNode(node.ip)}
                            className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 cursor-pointer disabled:opacity-50"
                          >
                            + Use
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Web Serial Enttec DMX USB Pro settings */}
          {settings.mode === 'serial' && (
            <div className="space-y-1.5">
              {!hasWebSerial ? (
                <p role="status" className="text-[9px] text-amber-300">
                  Web Serial is not supported in this browser. Open StageForge in Chromium/Edge or the desktop app to drive an Enttec DMX USB Pro.
                </p>
              ) : (
                <>
                  <div className="flex gap-1">
                    {([1, 2] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        disabled={isLive}
                        aria-pressed={settings.serialUniverse === u}
                        onClick={() => patchSettings({ serialUniverse: u })}
                        className={`flex-1 py-0.5 rounded border cursor-pointer disabled:opacity-50 ${
                          settings.serialUniverse === u
                            ? 'bg-white/15 border-white/30 text-white'
                            : 'bg-white/5 border-white/10 text-zinc-400'
                        }`}
                      >
                        Send Universe {u}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-[9px] text-zinc-300">
                    <input
                      type="checkbox"
                      disabled={isLive}
                      checked={settings.serialAllowAll}
                      onChange={(e) => patchSettings({ serialAllowAll: e.target.checked })}
                    />
                    Show all serial devices (non-FTDI clones)
                  </label>
                  <p className="text-[9px] text-zinc-400 leading-snug">
                    USB Pro holds the last frame if the window reloads, closes abruptly or crashes. Click Blackout &amp; stop before closing.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Frame rate cap (<= 44 Hz) */}
          <label className="flex items-center justify-between gap-2">
            <span className="text-[9px] text-zinc-400">Rate cap (max 44 Hz)</span>
            <div className="flex items-center gap-1.5">
              <input
                type="range"
                min={1}
                max={44}
                disabled={isLive}
                aria-label="Output refresh rate"
                value={settings.rateHz}
                onChange={(e) => patchSettings({ rateHz: Math.max(1, Math.min(44, Number(e.target.value) || 40)) })}
                className="w-24 accent-cyan-400"
              />
              <span className="w-10 text-right text-zinc-200">{settings.rateHz} Hz</span>
            </div>
          </label>

          {/* Live stats */}
          {isLive && (
            <div className="rounded bg-rose-950/40 border border-rose-500/40 px-2 py-1 text-[9px] text-rose-100 space-y-0.5">
              <div className="flex justify-between">
                <span>Measured rate</span>
                <span>
                  {desktopStatus?.enabled ? desktopStatus.measuredHz : serialStatus.measuredHz} Hz ·{' '}
                  {desktopStatus?.enabled ? desktopStatus.packetsSent : serialStatus.packetsSent} pkts
                </span>
              </div>
              {desktopStatus?.enabled && desktopStatus.degraded && desktopStatus.lastError && (
                <div className="text-amber-300">Degraded: {desktopStatus.lastError}</div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" data-testid="dmx-output-error" className="text-[9px] text-rose-300">
              {error}
            </p>
          )}

          {/* Safety arm -> Go live / Blackout & stop */}
          {isLive ? (
            <button
              type="button"
              disabled={busy}
              data-testid="dmx-output-stop"
              onClick={() => void disable()}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold cursor-pointer disabled:opacity-50"
            >
              <Square className="w-3 h-3 fill-current" />
              Blackout &amp; stop
            </button>
          ) : armed ? (
            <div className="rounded border border-amber-400/50 bg-amber-950/40 p-2 space-y-1.5">
              <p className="flex items-start gap-1.5 text-[9px] text-amber-200 leading-snug">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Live output drives physical lighting rigs. Confirm to start sending frames.
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  data-testid="dmx-output-go-live"
                  onClick={() => void enable()}
                  className="flex-1 flex items-center justify-center gap-1 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold cursor-pointer disabled:opacity-50"
                >
                  <Zap className="w-3 h-3" />
                  {busy ? 'Starting…' : 'Go live'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setArmed(false)}
                  className="px-2.5 py-1 rounded bg-white/10 hover:bg-white/15 text-zinc-200 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy || (settings.mode === 'serial' && !hasWebSerial)}
              data-testid="dmx-output-arm"
              onClick={() => setArmed(true)}
              className="w-full py-1.5 rounded border border-amber-400/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-100 font-semibold cursor-pointer disabled:opacity-40"
            >
              Arm output
            </button>
          )}
        </div>
      )}
    </section>
  );
};
