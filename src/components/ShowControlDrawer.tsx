import React, { useEffect, useState } from 'react';
import { Clock, Plug, Radio, RefreshCw, Trash2, Unplug, X } from 'lucide-react';
import { useLive } from '../state/liveTelemetry';
import type { ClockMode } from '../showControl/clockOwner';
import { formatSmpte, msToSmpte, parseSmpteString, SMPTE_RATES, type SmpteFrameRate } from '../showControl/timecode';
import type { ShowControlApi } from '../showControl/useShowControl';

interface ShowControlDrawerProps {
  open: boolean;
  control: ShowControlApi;
  onClose: () => void;
}

const CLOCK_MODES: Array<{ id: ClockMode; label: string; desc: string }> = [
  { id: 'master', label: 'Master', desc: 'StageForge owns cues, follows, Auto-LD & takes (optional TC/OSC out).' },
  { id: 'chase', label: 'Chase TC', desc: 'External MTC or Art-Net TC drives the take. Follows & Auto-LD suppressed.' },
  { id: 'caller', label: 'Cue Caller', desc: 'External OSC or MIDI MSC calls cues. Follows & Auto-LD suppressed.' },
];

export const ShowControlDrawer: React.FC<ShowControlDrawerProps> = ({ open, control, onClose }) => {
  const tc = useLive(control.tcStore);
  const [offsetDraft, setOffsetDraft] = useState(() =>
    formatSmpte(msToSmpte(control.settings.timecodeOffsetMs, control.settings.frameRate)),
  );
  const [offsetError, setOffsetError] = useState<string | null>(null);
  // Local draft inputs so typing ports/IPs/numbers never tears down live sockets or clamps mid-keystroke (M1/M-B/M-C).
  const [oscPortDraft, setOscPortDraft] = useState(() => String(control.settings.oscPort));
  const [oscTxHostDraft, setOscTxHostDraft] = useState(() => control.settings.oscTxHost);
  const [oscTxPortDraft, setOscTxPortDraft] = useState(() => String(control.settings.oscTxPort));
  const [artnetTcTxHostDraft, setArtnetTcTxHostDraft] = useState(() => control.settings.artnetTcTxHost);
  const [midiDeviceIdDraft, setMidiDeviceIdDraft] = useState(() => String(control.settings.midiDeviceId));
  const [dropoutDraft, setDropoutDraft] = useState(() => String(control.settings.dropoutMs));
  const [freewheelDraft, setFreewheelDraft] = useState(() => String(control.settings.freewheelMs));

  useEffect(() => {
    if (!open) return;
    setOffsetDraft(formatSmpte(msToSmpte(control.settings.timecodeOffsetMs, control.settings.frameRate)));
    setOffsetError(null);
    setOscPortDraft(String(control.settings.oscPort));
    setOscTxHostDraft(control.settings.oscTxHost);
    setOscTxPortDraft(String(control.settings.oscTxPort));
    setArtnetTcTxHostDraft(control.settings.artnetTcTxHost);
    setMidiDeviceIdDraft(String(control.settings.midiDeviceId));
    setDropoutDraft(String(control.settings.dropoutMs));
    setFreewheelDraft(String(control.settings.freewheelMs));
  }, [
    open,
    control.settings.timecodeOffsetMs,
    control.settings.frameRate,
    control.settings.oscPort,
    control.settings.oscTxHost,
    control.settings.oscTxPort,
    control.settings.artnetTcTxHost,
    control.settings.midiDeviceId,
    control.settings.dropoutMs,
    control.settings.freewheelMs,
  ]);

  if (!open) return null;

  const isValidUnicastIpv4 = (ip: string) => {
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const nums = m.slice(1).map(Number);
    if (nums.some((n) => n < 0 || n > 255)) return false;
    return nums[0] !== 0 && nums[0] < 224;
  };
  const commitPort = (raw: string, fallback: number, field: 'oscPort' | 'oscTxPort', resetDraft: (v: string) => void) => {
    const n = Number(raw);
    const valid = Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
    resetDraft(String(valid));
    if (valid !== control.settings[field]) control.updateSettings({ [field]: valid });
  };
  const commitHost = (raw: string, field: 'oscTxHost' | 'artnetTcTxHost', resetDraft: (v: string) => void) => {
    const trimmed = raw.trim();
    const valid = isValidUnicastIpv4(trimmed) ? trimmed : '127.0.0.1';
    resetDraft(valid);
    if (valid !== control.settings[field]) control.updateSettings({ [field]: valid });
  };
  const commitIntRange = (
    raw: string,
    min: number,
    max: number,
    fallback: number,
    field: 'midiDeviceId' | 'dropoutMs' | 'freewheelMs',
    resetDraft: (v: string) => void,
  ) => {
    const n = Number(raw);
    const valid = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
    resetDraft(String(valid));
    if (valid !== control.settings[field]) control.updateSettings({ [field]: valid });
  };

  const {
    hasDesktopBridge,
    hasWebMidi,
    clockMode,
    setClockMode,
    lockState,
    settings,
    updateSettings,
    runtime,
    eventLog,
    clearLog,
  } = control;

  const commitOffset = (raw: string, fps: SmpteFrameRate = settings.frameRate) => {
    const parsed = parseSmpteString(raw, fps);
    if (parsed === null) {
      setOffsetError(`Enter HH:MM:SS${fps === 29.97 ? ';' : ':'}FF valid for ${fps} fps.`);
      return;
    }
    setOffsetError(null);
    updateSettings({ timecodeOffsetMs: parsed });
    setOffsetDraft(formatSmpte(msToSmpte(parsed, fps)));
  };

  return (
    <aside
      aria-label="Show control"
      data-testid="show-control-drawer"
      className="dmx-monitor-panel fixed top-16 bottom-[270px] left-2.5 w-[380px] z-35 glass-panel rounded-xl shadow-2xl flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 bg-black/60 border-b border-white/10">
        <div>
          <h2 className="font-display font-bold text-sm text-white tracking-wide flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-cyan-400" />
            SHOW CONTROL &amp; SYNC
          </h2>
          <p className="font-mono-tech text-[9px] text-zinc-400">
            OSC · WEB MIDI (MTC / MSC) · ART-NET TIMECODE
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close show control"
          className="p-1.5 rounded bg-white/5 hover:bg-rose-500/30 text-zinc-300 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 font-mono-tech text-[10px]">
        {/* Clock Owner */}
        <section aria-label="Clock owner" className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-cyan-300 uppercase">Clock owner</span>
            <span
              data-testid="sc-tc-readout"
              className="rounded bg-black/70 border border-white/10 px-2 py-0.5 text-[11px] tabular-nums text-white"
            >
              {tc.formatted} <span className="text-zinc-400 text-[9px]">{tc.fps}fps</span>
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1" role="group" aria-label="Clock owner mode">
            {CLOCK_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                data-testid={`clock-mode-${m.id}`}
                aria-pressed={clockMode === m.id}
                onClick={() => setClockMode(m.id)}
                className={`py-1 px-1.5 rounded border text-[10px] font-semibold cursor-pointer transition ${
                  clockMode === m.id
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                    : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <p className="text-[9px] text-zinc-400 leading-snug">
            {CLOCK_MODES.find((m) => m.id === clockMode)?.desc}
            {clockMode === 'chase' && (
              <span className="ml-1.5 text-cyan-300 font-semibold">State: {lockState}</span>
            )}
          </p>

          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/10">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-zinc-400">Take frame rate</span>
              <select
                aria-label="Take frame rate"
                data-testid="sc-frame-rate"
                value={settings.frameRate}
                onChange={(e) => {
                  const fps = Number(e.target.value) as SmpteFrameRate;
                  updateSettings({ frameRate: fps });
                  setOffsetDraft(formatSmpte(msToSmpte(settings.timecodeOffsetMs, fps)));
                  setOffsetError(null);
                }}
                className="bg-black/70 border border-white/15 rounded px-1.5 py-1 text-white"
              >
                {SMPTE_RATES.map((r) => (
                  <option key={r} value={r}>{r === 29.97 ? '29.97 DF' : `${r} fps`}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-zinc-400">TC start offset</span>
              <input
                type="text"
                aria-label="Timecode start offset"
                data-testid="sc-tc-offset"
                value={offsetDraft}
                onChange={(e) => setOffsetDraft(e.target.value)}
                onBlur={() => commitOffset(offsetDraft)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitOffset(offsetDraft); }}
                placeholder="00:00:00:00"
                className="bg-black/70 border border-white/15 rounded px-1.5 py-1 text-white tabular-nums"
              />
            </label>
          </div>
          {offsetError && <p role="alert" className="text-[9px] text-rose-300">{offsetError}</p>}
        </section>

        {/* OSC */}
        <section aria-label="OSC control" className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-violet-300 uppercase flex items-center gap-1">
              <Radio className="w-3 h-3" /> OSC {hasDesktopBridge ? '(UDP)' : '(WebSocket)'}
            </span>
            <span className="text-[9px] text-zinc-400">
              {hasDesktopBridge
                ? (runtime.desktopStatus?.oscRxListening
                  ? `Listening ${runtime.desktopStatus.oscRxAddress}:${runtime.desktopStatus.oscRxPort} (${runtime.desktopStatus.oscRxCount} rx)`
                  : 'Off')
                : `${runtime.oscWsState} (${runtime.oscWsRxCount} rx)`}
            </span>
          </div>

          {hasDesktopBridge ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="sc-osc-rx-toggle"
                    checked={runtime.oscRxEnabled}
                    onChange={(e) => void control.setOscRxEnabled(e.target.checked)}
                  />
                  Listen UDP
                </label>
                <label className="flex items-center gap-1 ml-auto">
                  <span className="text-[9px] text-zinc-400">Port</span>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    aria-label="OSC receive port"
                    data-testid="sc-osc-port"
                    value={oscPortDraft}
                    onChange={(e) => setOscPortDraft(e.target.value)}
                    onBlur={() => commitPort(oscPortDraft, settings.oscPort, 'oscPort', setOscPortDraft)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitPort(oscPortDraft, settings.oscPort, 'oscPort', setOscPortDraft); }}
                    className="w-20 bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  />
                </label>
              </div>
              <label className="flex items-center gap-1.5 text-[9px] text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.oscAllowAllInterfaces}
                  onChange={(e) => updateSettings({ oscAllowAllInterfaces: e.target.checked })}
                />
                Listen on all interfaces (0.0.0.0) instead of 127.0.0.1
              </label>
              <div className="pt-1 border-t border-white/10 space-y-1">
                <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runtime.oscTxActive}
                    onChange={(e) => void control.setOscTxEnabled(e.target.checked)}
                  />
                  Send OSC state feedback (Master / Caller)
                </label>
                <div className="grid grid-cols-[1fr_76px] gap-1.5">
                  <input
                    type="text"
                    aria-label="OSC feedback host"
                    value={oscTxHostDraft}
                    onChange={(e) => setOscTxHostDraft(e.target.value)}
                    onBlur={() => commitHost(oscTxHostDraft, 'oscTxHost', setOscTxHostDraft)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitHost(oscTxHostDraft, 'oscTxHost', setOscTxHostDraft); }}
                    placeholder="127.0.0.1"
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  />
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    aria-label="OSC feedback port"
                    value={oscTxPortDraft}
                    onChange={(e) => setOscTxPortDraft(e.target.value)}
                    onBlur={() => commitPort(oscTxPortDraft, settings.oscTxPort, 'oscTxPort', setOscTxPortDraft)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitPort(oscTxPortDraft, settings.oscTxPort, 'oscTxPort', setOscTxPortDraft); }}
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  />
                </div>
              </div>
              {runtime.desktopStatus?.oscError && (
                <p role="alert" className="text-[9px] text-rose-300">{runtime.desktopStatus.oscError}</p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  aria-label="OSC WebSocket URL"
                  data-testid="sc-osc-ws-url"
                  value={settings.oscWsUrl}
                  onChange={(e) => updateSettings({ oscWsUrl: e.target.value })}
                  placeholder="ws://127.0.0.1:8080"
                  className="flex-1 bg-black/70 border border-white/15 rounded px-1.5 py-1 text-white"
                />
                {runtime.oscWsState === 'connected' || runtime.oscWsState === 'connecting' ? (
                  <button
                    type="button"
                    onClick={control.disconnectOscWs}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-rose-600/80 hover:bg-rose-500 text-white cursor-pointer"
                  >
                    <Unplug className="w-3 h-3" /> Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="sc-osc-ws-connect"
                    onClick={control.connectOscWs}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-violet-500/30 border border-violet-400/50 hover:bg-violet-500/40 text-violet-100 cursor-pointer"
                  >
                    <Plug className="w-3 h-3" /> Connect
                  </button>
                )}
              </div>
              {runtime.oscWsError && <p role="alert" className="text-[9px] text-rose-300">{runtime.oscWsError}</p>}
            </div>
          )}
          <p className="text-[9px] text-zinc-500 leading-snug">
            Addresses: <code>/stageforge/go</code>, <code>/back</code>, <code>/stop</code>, <code>/resume</code>,{' '}
            <code>/blackout</code>, <code>/master</code>, <code>/bump/1–6</code>, <code>/tempo/tap|bpm|half|double</code>
          </p>
        </section>

        {/* Web MIDI (MTC & MSC) */}
        <section aria-label="Web MIDI MTC and MSC" className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-emerald-300 uppercase">Web MIDI (MTC &amp; MSC)</span>
            {hasWebMidi && (
              <button
                type="button"
                data-testid="sc-midi-connect"
                onClick={() => void control.connectMidi()}
                className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/10 hover:bg-white/15 text-zinc-100 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" /> {runtime.midiStatus.connected ? 'Refresh' : 'Enable MIDI'}
              </button>
            )}
          </div>

          {!hasWebMidi ? (
            <p className="text-[9px] text-amber-300">Web MIDI is not supported in this browser.</p>
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-zinc-400">MIDI Input</span>
                  <select
                    aria-label="MIDI input device"
                    value={settings.midiInputId}
                    onChange={(e) => updateSettings({ midiInputId: e.target.value })}
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  >
                    <option value="all">All inputs ({runtime.midiStatus.inputs.length})</option>
                    {runtime.midiStatus.inputs.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-zinc-400">MSC Device ID</span>
                  <input
                    type="number"
                    min={0}
                    max={127}
                    aria-label="MSC Device ID"
                    value={midiDeviceIdDraft}
                    onChange={(e) => setMidiDeviceIdDraft(e.target.value)}
                    onBlur={() => commitIntRange(midiDeviceIdDraft, 0, 127, settings.midiDeviceId, 'midiDeviceId', setMidiDeviceIdDraft)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitIntRange(midiDeviceIdDraft, 0, 127, settings.midiDeviceId, 'midiDeviceId', setMidiDeviceIdDraft); }}
                    title="0–111 specific device, 127 = All-Call (0x7F)"
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runtime.midiMtcRxEnabled}
                    onChange={(e) => control.setMidiMtcRxEnabled(e.target.checked)}
                  />
                  MTC in
                </label>
                <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={runtime.midiMscRxEnabled}
                    onChange={(e) => control.setMidiMscRxEnabled(e.target.checked)}
                  />
                  MSC in
                </label>
                <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={clockMode !== 'master'}
                    checked={runtime.midiMtcTxEnabled && clockMode === 'master'}
                    onChange={(e) => control.setMidiMtcTxEnabled(e.target.checked)}
                  />
                  MTC out (Master)
                </label>
              </div>
              {runtime.midiStatus.outputs.length > 0 && (
                <label className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-zinc-400">MIDI Output (for Master MTC out)</span>
                  <select
                    aria-label="MIDI output device"
                    value={settings.midiOutputId}
                    onChange={(e) => updateSettings({ midiOutputId: e.target.value })}
                    className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                  >
                    <option value="">None</option>
                    {runtime.midiStatus.outputs.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {runtime.midiStatus.error && <p role="status" className="text-[9px] text-amber-300">{runtime.midiStatus.error}</p>}
            </div>
          )}
        </section>

        {/* Art-Net Timecode (Desktop) */}
        {hasDesktopBridge && (
          <section aria-label="Art-Net timecode" className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold tracking-wider text-amber-300 uppercase">Art-Net Timecode (UDP 6454)</span>
              <span className="text-[9px] text-zinc-400">
                {runtime.desktopStatus?.artnetTcRxListening
                  ? `Listening :${runtime.desktopStatus.artnetTcRxPort} (${runtime.desktopStatus.artnetTcRxCount} rx)`
                  : 'Off'}
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="sc-artnet-tc-rx"
                  checked={runtime.artnetTcRxEnabled}
                  onChange={(e) => void control.setArtnetTcRxEnabled(e.target.checked)}
                />
                Receive OpTimeCode
              </label>
              <label className="flex items-center gap-1.5 text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={clockMode !== 'master'}
                  checked={runtime.artnetTcTxEnabled && clockMode === 'master'}
                  onChange={(e) => void control.setArtnetTcTxEnabled(e.target.checked)}
                />
                Send (Master)
              </label>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] text-zinc-400">TX target IP</span>
                <input
                  type="text"
                  aria-label="Art-Net TC target IP"
                  value={artnetTcTxHostDraft}
                  onChange={(e) => setArtnetTcTxHostDraft(e.target.value)}
                  onBlur={() => commitHost(artnetTcTxHostDraft, 'artnetTcTxHost', setArtnetTcTxHostDraft)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitHost(artnetTcTxHostDraft, 'artnetTcTxHost', setArtnetTcTxHostDraft); }}
                  className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] text-zinc-400">Dropout ms</span>
                <input
                  type="number"
                  min={250}
                  max={500}
                  value={dropoutDraft}
                  onChange={(e) => setDropoutDraft(e.target.value)}
                  onBlur={() => commitIntRange(dropoutDraft, 250, 500, settings.dropoutMs, 'dropoutMs', setDropoutDraft)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitIntRange(dropoutDraft, 250, 500, settings.dropoutMs, 'dropoutMs', setDropoutDraft); }}
                  className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[9px] text-zinc-400">Freewheel ms</span>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  value={freewheelDraft}
                  onChange={(e) => setFreewheelDraft(e.target.value)}
                  onBlur={() => commitIntRange(freewheelDraft, 0, 2000, settings.freewheelMs, 'freewheelMs', setFreewheelDraft)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitIntRange(freewheelDraft, 0, 2000, settings.freewheelMs, 'freewheelMs', setFreewheelDraft); }}
                  className="bg-black/70 border border-white/15 rounded px-1.5 py-0.5 text-white"
                />
              </label>
            </div>
            {runtime.desktopStatus?.artnetTcError && (
              <p role="alert" className="text-[9px] text-rose-300">{runtime.desktopStatus.artnetTcError}</p>
            )}
          </section>
        )}

        {/* Activity & Ignored Event Log */}
        <section aria-label="Show control event log" className="rounded-lg border border-white/10 bg-black/45 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-zinc-300 uppercase">Event log</span>
            {eventLog.length > 0 && (
              <button
                type="button"
                onClick={clearLog}
                className="flex items-center gap-1 text-[9px] text-zinc-400 hover:text-white cursor-pointer"
              >
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
          {eventLog.length === 0 ? (
            <p className="text-[9px] text-zinc-500">No show-control events yet.</p>
          ) : (
            <ul data-testid="sc-event-log" className="space-y-1 max-h-36 overflow-y-auto">
              {eventLog.map((entry) => (
                <li
                  key={entry.id}
                  className={`flex items-center justify-between gap-2 text-[9px] px-1.5 py-0.5 rounded ${
                    entry.ignored ? 'bg-amber-950/35 text-amber-200/90' : 'bg-white/5 text-zinc-200'
                  }`}
                >
                  <span className="font-bold shrink-0">{entry.source}</span>
                  <span className="truncate flex-1">{entry.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
};
