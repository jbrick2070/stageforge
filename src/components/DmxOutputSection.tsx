import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Search, ShieldAlert, ShieldCheck, Square, Zap } from 'lucide-react';
import type { LiveDmxControllerApi } from '../dmx/useLiveDmxOutput';
import { formatArtNetAddress, parseTargetList, type DmxOutputMode } from '../dmx/liveDmx';
import { GENERIC_SIMULATED_LABEL, summarizePhysicalDrive } from '../dmx/physicalDmx';
import type { PreflightReport } from '../data/preflight';
import type { RigConfig } from '../types/show';

export const DMX_ADVANCED_OPEN_STORAGE_KEY = 'stageforge.dmxAdvancedOpen.v1';

function readAdvancedOpen(): boolean {
  try {
    return window.localStorage.getItem(DMX_ADVANCED_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveAdvancedOpen(open: boolean): void {
  try {
    window.localStorage.setItem(DMX_ADVANCED_OPEN_STORAGE_KEY, open ? 'true' : 'false');
  } catch {
    // Ignore storage errors in private browsing or restricted contexts.
  }
}

interface DmxOutputSectionProps {
  output: LiveDmxControllerApi;
  rig?: RigConfig;
  hasCatalogFixtures?: boolean;
  preflight?: PreflightReport;
  liveViolationMessage?: string | null;
  aiBridgeBlocking?: boolean;
  onOpenPreflight?: () => void;
}

export const DmxOutputSection: React.FC<DmxOutputSectionProps> = ({
  output,
  rig,
  hasCatalogFixtures,
  preflight,
  liveViolationMessage,
  aiBridgeBlocking = false,
  onOpenPreflight,
}) => {
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(readAdvancedOpen);
  const physicalSummary = useMemo(() => (rig ? summarizePhysicalDrive(rig) : null), [rig]);

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
    armed,
    arm,
    disarm,
    isLive,
    enable,
    disable,
  } = output;

  // Fetch local network interfaces when Advanced is opened in Electron.
  useEffect(() => {
    if (advancedOpen && hasDesktopBridge) {
      void refreshInterfaces();
    }
  }, [advancedOpen, hasDesktopBridge, refreshInterfaces]);

  // Automatically disarm if output goes live, Advanced collapses, AI bridge activates, or pre-flight stops allowing arming.
  const canArmByPreflight = (preflight ? preflight.canArm : true) && !aiBridgeBlocking;
  useEffect(() => {
    if (isLive || !advancedOpen || !canArmByPreflight) disarm();
  }, [isLive, advancedOpen, canArmByPreflight, disarm]);

  // Disarm cleanly if the DMX drawer unmounts while armed.
  useEffect(() => () => disarm(), [disarm]);

  const patchSettings = (patch: Parameters<typeof updateSettings>[0]) => {
    disarm();
    updateSettings(patch);
  };

  const selectedIface = interfaces.find((item) => item.address === settings.iface);
  const loopbackSelected = !selectedIface ? settings.iface === '127.0.0.1' : selectedIface.internal;

  const addDiscoveredNode = (ip: string) => {
    const existing = parseTargetList(settings.artnetTargets);
    if (existing.includes(ip) || existing.length >= 8) return;
    patchSettings({ artnetTargets: [...existing, ip].join(', ') });
  };

  const preflightLabel = preflight?.badgeLabel ?? 'Not checked';
  const preflightStatus = preflight?.overallStatus ?? 'not_checked';
  const preflightBadgeClass =
    preflightStatus === 'passed'
      ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
      : preflightStatus === 'blocked'
        ? 'border-rose-400/60 bg-rose-500/25 text-rose-100'
        : preflightStatus === 'warnings'
          ? 'border-amber-400/55 bg-amber-500/20 text-amber-100'
          : 'border-white/20 bg-white/10 text-zinc-200';

  return (
    <section
      aria-label="Live output"
      data-testid="dmx-output-section"
      className="border-b border-white/10 bg-black/50"
    >
      {/* Always-visible header bar OUTSIDE the collapsed Advanced section: LIVE status, pre-flight badge, & Blackout & stop */}
      <div className="px-3 py-2 space-y-1.5 font-mono-tech text-[10px]">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="flex items-center gap-1.5 font-semibold tracking-wider text-zinc-200">
            OUTPUT
            <span
              data-testid="dmx-output-status-pill"
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                isLive ? 'bg-rose-600/80 text-white' : 'bg-white/10 text-zinc-400'
              }`}
            >
              {isLive ? 'LIVE' : 'OFF'}
            </span>
          </span>

          {onOpenPreflight && (
            <button
              type="button"
              data-testid="dmx-preflight-badge"
              data-preflight-status={preflightStatus}
              onClick={onOpenPreflight}
              title={`Open pre-flight check · ${preflight?.calibrationNote ?? 'Hardware calibration deferred.'}`}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold cursor-pointer ${preflightBadgeClass}`}
            >
              <ShieldCheck className="w-3 h-3" aria-hidden="true" />
              <span>{preflightLabel}</span>
            </button>
          )}
        </div>

        {isLive && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] text-rose-200">
              <span>{output.banner.detail}</span>
              <span>
                {desktopStatus?.enabled ? desktopStatus.measuredHz : serialStatus.measuredHz} Hz ·{' '}
                {desktopStatus?.enabled ? desktopStatus.packetsSent : serialStatus.packetsSent} pkts
              </span>
            </div>
            {desktopStatus?.enabled && desktopStatus.degraded && desktopStatus.lastError && (
              <div className="text-[9px] text-amber-300">Degraded: {desktopStatus.lastError}</div>
            )}
            <button
              type="button"
              disabled={busy}
              data-testid="dmx-output-stop"
              onClick={() => void disable()}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold cursor-pointer disabled:opacity-50"
            >
              <Square className="w-3 h-3 fill-current" aria-hidden="true" />
              Blackout &amp; stop
            </button>
          </div>
        )}

        {liveViolationMessage && isLive && (
          <p
            role="alert"
            data-testid="dmx-output-live-violation"
            className="flex items-start gap-1.5 rounded border border-amber-400/70 bg-amber-950/60 px-2 py-1 text-[9px] text-amber-100"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300" aria-hidden="true" />
            <span>{liveViolationMessage}</span>
          </p>
        )}

        {output.banner.stoppedNotice && !isLive && (
          <p
            role="alert"
            data-testid="dmx-output-stopped-notice"
            className="rounded border border-amber-400/60 bg-amber-950/60 px-2 py-1 text-[9px] text-amber-100"
          >
            {output.banner.stoppedNotice}. Re-arm and click Go live to resume output.
          </p>
        )}
      </div>

      {/* Collapsed Advanced section holding transport settings, experimental note, and Arm / Go live */}
      <details
        data-testid="dmx-advanced-details"
        open={advancedOpen}
        onToggle={(e) => {
          const next = e.currentTarget.open;
          setAdvancedOpen(next);
          saveAdvancedOpen(next);
          if (!next) disarm();
        }}
        className="border-t border-white/10"
      >
        <summary
          data-testid="dmx-advanced-summary"
          className="px-3 py-1.5 font-mono-tech text-[10px] font-semibold text-zinc-300 hover:bg-white/5 cursor-pointer select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          Advanced: live output to real lights (experimental)
        </summary>

        {advancedOpen && (
        <div className="px-3 pb-2.5 pt-1.5 space-y-2 font-mono-tech text-[10px] border-t border-white/5 max-h-[300px] overflow-y-auto">
          {/* Verbatim experimental & open contribution invitation note */}
          <p
            data-testid="dmx-experimental-note"
            className="rounded border border-amber-400/45 bg-amber-950/35 px-2 py-1.5 text-[9px] text-amber-100/95 leading-snug"
          >
            Live output to real lights is experimental. It has only been tested against a local DMX receiver, not real
            fixtures, and its checks are guidance, not certification. If you like StageForge, want to try it on a real
            rig, or can improve it, get in touch or open an issue or pull request at{' '}
            <a
              href="https://github.com/jbrick2070/stageforge"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-cyan-300 hover:text-cyan-200"
            >
              github.com/jbrick2070/stageforge
            </a>
            . Contributions are welcome.
          </p>

          {physicalSummary ? (
            <div data-testid="dmx-physical-coverage" className="space-y-1">
              {physicalSummary.hasSimulationOnly && (
                <div role="note" className="rounded border border-amber-400/40 bg-amber-950/40 px-2 py-1 text-[9px] text-amber-100 space-y-0.5">
                  <div className="font-semibold">
                    {physicalSummary.simulationOnly.length} fixture {physicalSummary.simulationOnly.length === 1 ? 'group' : 'groups'} not driven (simulation only) — neutral zeros sent:
                  </div>
                  <ul className="list-disc pl-3.5 text-amber-200/90 space-y-0.5">
                    {physicalSummary.simulationOnly.slice(0, 6).map((item) => (
                      <li key={`${item.location}:${item.id}`}>
                        {item.modelName}{item.dmxMode ? ` (${item.dmxMode})` : ''} ×{item.count} — not driven (simulation only)
                      </li>
                    ))}
                    {physicalSummary.simulationOnly.length > 6 && (
                      <li>+{physicalSummary.simulationOnly.length - 6} more groups</li>
                    )}
                  </ul>
                </div>
              )}
              {physicalSummary.hasGeneric && (
                <p role="note" className="rounded border border-cyan-400/40 bg-cyan-950/40 px-2 py-1 text-[9px] text-cyan-100">
                  Generic fixtures use {GENERIC_SIMULATED_LABEL}.
                </p>
              )}
              {physicalSummary.hasImplemented && (
                <p role="note" className="rounded border border-emerald-400/35 bg-emerald-950/35 px-2 py-1 text-[9px] text-emerald-100">
                  Implemented personalities ({physicalSummary.implemented.length}):{' '}
                  {physicalSummary.implemented.map((item) => `${item.modelName} (${item.dmxMode ?? 'default'})`).join(', ')}.
                </p>
              )}
            </div>
          ) : hasCatalogFixtures ? (
            <p role="note" className="rounded border border-cyan-400/40 bg-cyan-950/40 px-2 py-1 text-[9px] text-cyan-100">
              Unimplemented catalogue fixtures are not driven (simulation only) and output neutral zeros.
            </p>
          ) : null}

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

          {error && (
            <p role="alert" data-testid="dmx-output-error" className="text-[9px] text-rose-300">
              {error}
            </p>
          )}

          {/* Pre-flight gate status + two-step Safety Arm -> Go live */}
          {!isLive && (
            <div className="space-y-1.5">
              {aiBridgeBlocking && (
                <div
                  data-testid="dmx-ai-bridge-blocked"
                  className="rounded border border-violet-400/50 bg-violet-950/40 px-2 py-1.5 text-[9px] text-violet-100"
                >
                  AI bridge is enabled (or has pending proposals). Disable the AI bridge in Show Control &amp; Sync before arming live DMX output.
                </div>
              )}

              {!aiBridgeBlocking && preflight && !preflight.canArm && (
                <div className="rounded border border-amber-400/40 bg-amber-950/35 px-2 py-1.5 space-y-1 text-[9px] text-amber-100">
                  <p>{preflight.blockingReasons[0] ?? 'Complete pre-flight checks before arming output.'}</p>
                  {onOpenPreflight && (
                    <button
                      type="button"
                      data-testid="dmx-open-preflight"
                      onClick={onOpenPreflight}
                      className="rounded border border-cyan-400/50 bg-cyan-500/20 hover:bg-cyan-500/30 px-2 py-0.5 text-[9px] font-bold text-cyan-100 cursor-pointer"
                    >
                      Open pre-flight check ({preflightLabel})
                    </button>
                  )}
                </div>
              )}

              {armed ? (
                <div className="rounded border border-amber-400/50 bg-amber-950/40 p-2 space-y-1.5">
                  <p className="flex items-start gap-1.5 text-[9px] text-amber-200 leading-snug">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    Live output drives physical lighting rigs. Confirm to start sending frames.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy || !canArmByPreflight}
                      data-testid="dmx-output-go-live"
                      onClick={() => void enable()}
                      className="flex-1 flex items-center justify-center gap-1 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold cursor-pointer disabled:opacity-50"
                    >
                      <Zap className="w-3 h-3" aria-hidden="true" />
                      {busy ? 'Starting…' : 'Go live'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => disarm()}
                      className="px-2.5 py-1 rounded bg-white/10 hover:bg-white/15 text-zinc-200 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy || !canArmByPreflight || (settings.mode === 'serial' && !hasWebSerial)}
                  data-testid="dmx-output-arm"
                  onClick={() => void arm()}
                  className="w-full py-1.5 rounded border border-amber-400/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-100 font-semibold cursor-pointer disabled:opacity-40"
                >
                  Arm output · {aiBridgeBlocking ? 'AI bridge active' : preflightLabel}
                </button>
              )}
            </div>
          )}
        </div>
        )}
      </details>
    </section>
  );
};
