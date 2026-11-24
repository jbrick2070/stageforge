import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BumpState, ShowCue } from '../types/show';
import { createLiveStore, type LiveStore } from '../state/liveTelemetry';
import {
  allows,
  CallerDedupe,
  ChaseEngine,
  resolveCallerCue,
  triggerToAction,
  type ChaseLockState,
  type ClockMode,
} from './clockOwner';
import {
  MidiShowControlClient,
  type MidiStatus,
  type TimecodeEvent,
} from './midiShowControl';
import {
  OscWebSocketClient,
  type NormalizedTriggerEvent,
  type OscWsState,
} from './oscCodec';
import {
  DAY_MS,
  formatSmpte,
  frameDurationMs,
  msToSmpte,
  type SmpteFrameRate,
} from './timecode';

export interface ShowControlSettings {
  oscPort: number;
  oscAllowAllInterfaces: boolean;
  oscTxEnabled: boolean;
  oscTxHost: string;
  oscTxPort: number;
  oscWsUrl: string;
  midiInputId: string;
  midiOutputId: string;
  midiDeviceId: number; // 0..111 or 127 (all-call)
  artnetTcTxHost: string;
  frameRate: SmpteFrameRate;
  timecodeOffsetMs: number;
  dropoutMs: number;
  freewheelMs: number;
}

export interface TimecodeReadout {
  formatted: string;
  ms: number;
  fps: SmpteFrameRate;
  lockState: ChaseLockState;
  source: 'none' | 'mtc' | 'artnetTC' | 'internal';
}

export interface ShowControlLogEntry {
  id: number;
  at: number;
  source: string;
  summary: string;
  ignored: boolean;
}

export interface ShowControlRuntime {
  oscRxEnabled: boolean;
  oscTxActive: boolean;
  oscWsState: OscWsState;
  oscWsError: string | null;
  oscWsRxCount: number;
  midiMtcRxEnabled: boolean;
  midiMscRxEnabled: boolean;
  midiMtcTxEnabled: boolean;
  artnetTcRxEnabled: boolean;
  artnetTcTxEnabled: boolean;
  desktopStatus: ShowControlStatusBridge | null;
  midiStatus: MidiStatus;
}

const STORAGE_KEY = 'stageforge.showControl.v1';
const MAX_LOG_ENTRIES = 30;

export function defaultShowControlSettings(): ShowControlSettings {
  return {
    oscPort: 8000,
    oscAllowAllInterfaces: false,
    oscTxEnabled: false,
    oscTxHost: '127.0.0.1',
    oscTxPort: 9000,
    oscWsUrl: 'ws://127.0.0.1:8080',
    midiInputId: 'all',
    midiOutputId: '',
    midiDeviceId: 127,
    artnetTcTxHost: '127.0.0.1',
    frameRate: 30,
    timecodeOffsetMs: 0,
    dropoutMs: 300,
    freewheelMs: 1000,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function loadShowControlSettings(): ShowControlSettings {
  const defaults = defaultShowControlSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ShowControlSettings>;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const validRates: SmpteFrameRate[] = [24, 25, 29.97, 30];
    const frameRate = validRates.includes(parsed.frameRate as SmpteFrameRate)
      ? (parsed.frameRate as SmpteFrameRate)
      : defaults.frameRate;
    return {
      oscPort: clampInt(parsed.oscPort, 1024, 65535, defaults.oscPort),
      oscAllowAllInterfaces: Boolean(parsed.oscAllowAllInterfaces),
      oscTxEnabled: Boolean(parsed.oscTxEnabled),
      oscTxHost: typeof parsed.oscTxHost === 'string' && parsed.oscTxHost.length <= 64 ? parsed.oscTxHost : defaults.oscTxHost,
      oscTxPort: clampInt(parsed.oscTxPort, 1024, 65535, defaults.oscTxPort),
      oscWsUrl: typeof parsed.oscWsUrl === 'string' && parsed.oscWsUrl.length <= 256 ? parsed.oscWsUrl : defaults.oscWsUrl,
      midiInputId: typeof parsed.midiInputId === 'string' && parsed.midiInputId.length <= 128 ? parsed.midiInputId : defaults.midiInputId,
      midiOutputId: typeof parsed.midiOutputId === 'string' && parsed.midiOutputId.length <= 128 ? parsed.midiOutputId : defaults.midiOutputId,
      midiDeviceId: clampInt(parsed.midiDeviceId, 0, 127, defaults.midiDeviceId),
      artnetTcTxHost: typeof parsed.artnetTcTxHost === 'string' && parsed.artnetTcTxHost.length <= 64 ? parsed.artnetTcTxHost : defaults.artnetTcTxHost,
      frameRate,
      timecodeOffsetMs: clampInt(parsed.timecodeOffsetMs, 0, 86_399_999, defaults.timecodeOffsetMs),
      dropoutMs: clampInt(parsed.dropoutMs, 250, 500, defaults.dropoutMs),
      freewheelMs: clampInt(parsed.freewheelMs, 0, 2000, defaults.freewheelMs),
    };
  } catch {
    return defaults;
  }
}

export interface ShowControlCallbacks {
  getCues: () => readonly ShowCue[];
  getActiveCueId: () => string | null;
  getTakePlayheadMs: () => number;
  isTakePlaying: () => boolean;
  onModeReset: (nextMode: ClockMode) => void;
  onTriggerCue: (cue: ShowCue) => void;
  onNextCue: () => void;
  onPrevCue: () => void;
  onResetCue: () => void;
  onStopPlayback: () => void;
  onResumePlayback: () => void;
  onSetBlackout: (active: boolean) => void;
  onSetMaster: (value: number) => void;
  onSetBump: (key: keyof BumpState, active: boolean) => void;
  onTempoTap: () => void;
  onTempoSetBpm: (bpm: number) => void;
  onTempoHalf: () => void;
  onTempoDouble: () => void;
  onChaseSeek: (takeMs: number, running: boolean, resyncMusic: boolean) => void;
  onChaseAdvance: (takeMs: number) => void;
  onChaseStop: () => void;
  onUpdateTakeMeta: (meta: { frameRate: SmpteFrameRate; timecodeOffsetMs: number }) => void;
  onToast: (msg: string) => void;
}

export interface ShowControlApi {
  hasDesktopBridge: boolean;
  hasWebMidi: boolean;
  clockMode: ClockMode;
  setClockMode: (mode: ClockMode) => void;
  lockState: ChaseLockState;
  tcStore: LiveStore<TimecodeReadout>;
  settings: ShowControlSettings;
  updateSettings: (patch: Partial<ShowControlSettings>) => void;
  runtime: ShowControlRuntime;
  eventLog: readonly ShowControlLogEntry[];
  clearLog: () => void;
  setOscRxEnabled: (enabled: boolean) => Promise<void>;
  setOscTxEnabled: (enabled: boolean) => Promise<void>;
  setArtnetTcRxEnabled: (enabled: boolean) => Promise<void>;
  setArtnetTcTxEnabled: (enabled: boolean) => Promise<void>;
  connectOscWs: () => void;
  disconnectOscWs: () => void;
  connectMidi: () => Promise<void>;
  setMidiMtcRxEnabled: (enabled: boolean) => void;
  setMidiMscRxEnabled: (enabled: boolean) => void;
  setMidiMtcTxEnabled: (enabled: boolean) => void;
  sendFeedback: (payload: { cue?: string; timecode?: string; bpm?: number; clock?: ClockMode }) => void;
  syncFromShowTimeline: (meta?: { frameRate?: SmpteFrameRate; timecodeOffsetMs?: number }) => void;
}

export function useShowControl(callbacks: ShowControlCallbacks): ShowControlApi {
  const hasDesktopBridge = typeof window !== 'undefined' && typeof window.stageforgeDesktop?.showControl === 'function';
  const hasWebMidi = MidiShowControlClient.isSupported();

  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  // Always boots in 'master' with all listeners OFF.
  const [clockMode, setClockModeState] = useState<ClockMode>('master');
  const clockModeRef = useRef<ClockMode>('master');
  clockModeRef.current = clockMode;

  const [settings, setSettings] = useState<ShowControlSettings>(loadShowControlSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [lockState, setLockState] = useState<ChaseLockState>('UNLOCKED');
  const lockStateRef = useRef<ChaseLockState>('UNLOCKED');

  const tcStore = useMemo(() => createLiveStore<TimecodeReadout>({
    formatted: '00:00:00:00',
    ms: 0,
    fps: 30,
    lockState: 'UNLOCKED',
    source: 'none',
  }), []);

  const [eventLog, setEventLog] = useState<ShowControlLogEntry[]>([]);
  const logIdRef = useRef(0);
  const appendLog = useCallback((source: string, summary: string, ignored = false) => {
    const entry: ShowControlLogEntry = {
      id: ++logIdRef.current,
      at: Date.now(),
      source,
      summary,
      ignored,
    };
    setEventLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  const [oscRxEnabled, setOscRxState] = useState(false);
  const [oscTxActive, setOscTxActive] = useState(false);
  const [artnetTcRxEnabled, setArtnetTcRxState] = useState(false);
  const [artnetTcTxEnabled, setArtnetTcTxState] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<ShowControlStatusBridge | null>(null);

  const [oscWsState, setOscWsState] = useState<OscWsState>('disconnected');
  const [oscWsError, setOscWsError] = useState<string | null>(null);
  const [oscWsRxCount, setOscWsRxCount] = useState(0);

  const [midiMtcRxEnabled, setMidiMtcRxState] = useState(false);
  const [midiMscRxEnabled, setMidiMscRxState] = useState(false);
  const [midiMtcTxEnabled, setMidiMtcTxState] = useState(false);
  const [midiStatus, setMidiStatus] = useState<MidiStatus>({
    supported: hasWebMidi,
    connected: false,
    sysexEnabled: false,
    inputs: [],
    outputs: [],
    error: null,
  });

  const chaseRef = useRef(new ChaseEngine({
    dropoutMs: settings.dropoutMs,
    freewheelMs: settings.freewheelMs,
    timecodeOffsetMs: settings.timecodeOffsetMs,
  }));
  const dedupeRef = useRef(new CallerDedupe());
  const oscWsRef = useRef<OscWebSocketClient | null>(null);
  const midiRef = useRef<MidiShowControlClient | null>(null);
  const flagsRef = useRef({ oscRxEnabled, oscTxActive, artnetTcRxEnabled, artnetTcTxEnabled });
  flagsRef.current = { oscRxEnabled, oscTxActive, artnetTcRxEnabled, artnetTcTxEnabled };

  const syncLockState = useCallback((next: ChaseLockState) => {
    if (lockStateRef.current !== next) {
      lockStateRef.current = next;
      setLockState(next);
    }
  }, []);

  const handleIncomingEvent = useCallback((event: NormalizedTriggerEvent | TimecodeEvent) => {
    const mode = clockModeRef.current;

    if (event.kind === 'timecode') {
      const formatted = formatSmpte(msToSmpte(event.ms, event.fps));
      if (!allows(mode, event.source, 'timecode_transport')) {
        tcStore.set({
          formatted,
          ms: event.ms,
          fps: event.fps,
          lockState: 'UNLOCKED',
          source: event.source,
        });
        return;
      }
      const step = chaseRef.current.onTimecode({
        ms: event.ms,
        fps: event.fps,
        source: event.source,
        locate: event.locate,
        reverse: event.reverse,
      }, performance.now());
      syncLockState(step.lockState);
      tcStore.set({
        formatted: formatSmpte(msToSmpte(step.rawTcMs, step.fps)),
        ms: step.rawTcMs,
        fps: step.fps,
        lockState: step.lockState,
        source: event.source,
      });
      if (step.action === 'seek') {
        cbRef.current.onChaseSeek(step.takeMs, !event.locate && !event.reverse, step.resyncMusic);
      } else if (step.action === 'advance') {
        cbRef.current.onChaseAdvance(step.takeMs);
      } else if (step.action === 'stop') {
        cbRef.current.onChaseStop();
      }
      return;
    }

    // Trigger event (OSC or MSC)
    const action = triggerToAction(event);
    if (!allows(mode, event.source, action)) {
      appendLog(event.source.toUpperCase(), `${event.command} (ignored: ${mode})`, true);
      return;
    }

    const cb = cbRef.current;
    switch (event.command) {
      case 'go': {
        const cues = cb.getCues();
        if (event.cue) {
          const target = resolveCallerCue(cues, event.cue, event.source);
          if (!target) {
            appendLog(event.source.toUpperCase(), `GO ${event.cue.index ?? event.cue.ref ?? ''} (unknown cue)`, true);
            return;
          }
          if (!dedupeRef.current.acceptGo(target.id, false, cb.getActiveCueId(), event.at)) {
            appendLog(event.source.toUpperCase(), `GO ${target.name} (deduped)`, true);
            return;
          }
          cb.onTriggerCue(target);
          appendLog(event.source.toUpperCase(), `GO → ${target.name}`);
        } else {
          if (!dedupeRef.current.acceptGo(null, true, cb.getActiveCueId(), event.at)) {
            appendLog(event.source.toUpperCase(), 'GO (coalesced)', true);
            return;
          }
          cb.onNextCue();
          appendLog(event.source.toUpperCase(), 'GO (next cue)');
        }
        break;
      }
      case 'back':
        cb.onPrevCue();
        appendLog(event.source.toUpperCase(), 'BACK');
        break;
      case 'stop':
        cb.onStopPlayback();
        appendLog(event.source.toUpperCase(), 'STOP');
        break;
      case 'resume':
        cb.onResumePlayback();
        appendLog(event.source.toUpperCase(), 'RESUME');
        break;
      case 'reset':
        cb.onResetCue();
        appendLog(event.source.toUpperCase(), 'RESET');
        break;
      case 'blackout':
        cb.onSetBlackout((event.value ?? 1) >= 0.5);
        appendLog(event.source.toUpperCase(), (event.value ?? 1) >= 0.5 ? 'BLACKOUT ON' : 'BLACKOUT OFF');
        break;
      case 'master':
        if (event.value !== undefined) {
          cb.onSetMaster(event.value);
          appendLog(event.source.toUpperCase(), `MASTER ${Math.round(event.value * 100)}%`);
        }
        break;
      case 'bump':
        if (event.bumpKey) {
          const active = (event.value ?? 1) >= 0.5;
          cb.onSetBump(event.bumpKey, active);
          appendLog(event.source.toUpperCase(), `BUMP ${event.bumpKey} ${active ? 'ON' : 'OFF'}`);
        }
        break;
      case 'tempo_tap':
        cb.onTempoTap();
        appendLog(event.source.toUpperCase(), 'TAP');
        break;
      case 'tempo_bpm':
        if (event.value !== undefined) {
          cb.onTempoSetBpm(event.value);
          appendLog(event.source.toUpperCase(), `BPM ${event.value}`);
        }
        break;
      case 'tempo_half':
        cb.onTempoHalf();
        appendLog(event.source.toUpperCase(), 'BPM ½×');
        break;
      case 'tempo_double':
        cb.onTempoDouble();
        appendLog(event.source.toUpperCase(), 'BPM 2×');
        break;
    }
  }, [appendLog, syncLockState, tcStore]);

  // Subscribe to Electron main-process show control events & status.
  useEffect(() => {
    if (!hasDesktopBridge) return;
    const bridge = window.stageforgeDesktop!;
    const unsubEvents = bridge.onShowControlEvent((ev) => {
      if (ev.kind === 'timecode') {
        handleIncomingEvent({
          source: ev.source,
          kind: 'timecode',
          ms: ev.ms,
          fps: ev.fps,
          hours: ev.hours ?? 0,
          minutes: ev.minutes ?? 0,
          seconds: ev.seconds ?? 0,
          frames: ev.frames ?? 0,
          locate: ev.locate,
          reverse: ev.reverse,
          at: ev.at,
        });
      } else {
        handleIncomingEvent(ev);
      }
    });
    const unsubStatus = bridge.onShowControlStatus((st) => {
      setDesktopStatus(st);
    });
    void bridge.showControl({ type: 'getStatus' }).then(setDesktopStatus).catch(() => {});
    return () => {
      unsubEvents();
      unsubStatus();
      void bridge.showControl({ type: 'stop' }).catch(() => {});
    };
  }, [hasDesktopBridge, handleIncomingEvent]);

  // Instantiate browser WS OSC and Web MIDI clients once.
  useEffect(() => {
    const wsClient = new OscWebSocketClient(
      (ev) => handleIncomingEvent(ev),
      (st) => {
        setOscWsState(st.state);
        setOscWsError(st.error);
        setOscWsRxCount(st.rxCount);
      },
    );
    oscWsRef.current = wsClient;
    const midiClient = new MidiShowControlClient(
      (ev) => handleIncomingEvent(ev),
      (st) => setMidiStatus(st),
    );
    midiRef.current = midiClient;
    return () => {
      wsClient.disconnect();
      midiClient.dispose();
      oscWsRef.current = null;
      midiRef.current = null;
    };
  }, [handleIncomingEvent]);

  // Keep ChaseEngine parameters in sync with settings.
  useEffect(() => {
    chaseRef.current.setConfig({
      dropoutMs: settings.dropoutMs,
      freewheelMs: settings.freewheelMs,
      timecodeOffsetMs: settings.timecodeOffsetMs,
    });
  }, [settings.dropoutMs, settings.freewheelMs, settings.timecodeOffsetMs]);

  // Keep MIDI client filter/port configuration synced.
  useEffect(() => {
    midiRef.current?.configure({
      mtcEnabled: midiMtcRxEnabled,
      mscEnabled: midiMscRxEnabled,
      inputId: settings.midiInputId,
      outputId: settings.midiOutputId,
      deviceId: settings.midiDeviceId,
    });
  }, [midiMtcRxEnabled, midiMscRxEnabled, settings.midiInputId, settings.midiOutputId, settings.midiDeviceId]);

  // Periodic chase interpolation + dropout/freewheel timer (only while in chase mode).
  useEffect(() => {
    if (clockMode !== 'chase') return;
    const timer = window.setInterval(() => {
      const step = chaseRef.current.tick(performance.now());
      syncLockState(step.lockState);
      if (step.action === 'advance') {
        tcStore.set({
          formatted: formatSmpte(msToSmpte(step.rawTcMs, step.fps)),
          ms: step.rawTcMs,
          fps: step.fps,
          lockState: step.lockState,
          source: tcStore.get().source,
        });
        cbRef.current.onChaseAdvance(step.takeMs);
      } else if (step.action === 'stop') {
        tcStore.set({ ...tcStore.get(), lockState: 'STOPPED' });
        cbRef.current.onChaseStop();
      }
    }, 33);
    return () => window.clearInterval(timer);
  }, [clockMode, syncLockState, tcStore]);

  // Optional outbound MTC / Art-Net TC in Master mode only (never re-emit in chase/caller).
  useEffect(() => {
    const canEmitTc = allows(clockMode, 'internal', 'outbound_timecode');
    if (!canEmitTc) {
      midiRef.current?.stopMtcOutput();
      return;
    }
    const fps = settings.frameRate;
    const offset = settings.timecodeOffsetMs;
    if (midiMtcTxEnabled) {
      midiRef.current?.startMtcOutput(
        () => cbRef.current.getTakePlayheadMs() + offset,
        fps,
        () => cbRef.current.isTakePlaying(),
      );
    } else {
      midiRef.current?.stopMtcOutput();
    }
    let artnetTimer: number | null = null;
    if (hasDesktopBridge && artnetTcTxEnabled) {
      const interval = Math.max(16, Math.round(frameDurationMs(fps)));
      artnetTimer = window.setInterval(() => {
        if (!cbRef.current.isTakePlaying()) return;
        const raw = cbRef.current.getTakePlayheadMs() + offset;
        const ms = ((raw % DAY_MS) + DAY_MS) % DAY_MS;
        void window.stageforgeDesktop?.showControl({ type: 'send', payload: { kind: 'timecode', ms, fps } }).catch(() => {});
      }, interval);
    }
    return () => {
      midiRef.current?.stopMtcOutput();
      if (artnetTimer !== null) window.clearInterval(artnetTimer);
    };
  }, [clockMode, midiMtcTxEnabled, midiStatus.connected, settings.midiOutputId, artnetTcTxEnabled, settings.frameRate, settings.timecodeOffsetMs, hasDesktopBridge]);

  const applyDesktopConfig = useCallback(async (
    nextFlags: { oscRxEnabled: boolean; oscTxActive: boolean; artnetTcRxEnabled: boolean; artnetTcTxEnabled: boolean },
    nextSettings: ShowControlSettings,
  ) => {
    if (!hasDesktopBridge) return;
    try {
      const st = await window.stageforgeDesktop!.showControl({
        type: 'configure',
        config: {
          oscRxEnabled: nextFlags.oscRxEnabled,
          oscPort: nextSettings.oscPort,
          oscAllowAllInterfaces: nextSettings.oscAllowAllInterfaces,
          oscTxEnabled: nextFlags.oscTxActive,
          oscTxHost: nextSettings.oscTxHost,
          oscTxPort: nextSettings.oscTxPort,
          artnetTcRxEnabled: nextFlags.artnetTcRxEnabled,
          artnetTcTxEnabled: nextFlags.artnetTcTxEnabled,
          artnetTcTxHost: nextSettings.artnetTcTxHost,
        },
      });
      setDesktopStatus(st);
      if (st.oscError) cbRef.current.onToast(st.oscError);
      else if (st.artnetTcError) cbRef.current.onToast(st.artnetTcError);
    } catch (err) {
      cbRef.current.onToast(err instanceof Error ? err.message : 'Show control configuration failed.');
    }
  }, [hasDesktopBridge]);

  const setClockMode = useCallback((nextMode: ClockMode) => {
    if (nextMode === clockModeRef.current) return;
    // Switching clock mode cancels every timer, stops take playback, resets chase/dedupe, and fires nothing.
    chaseRef.current.reset();
    dedupeRef.current.reset();
    syncLockState('UNLOCKED');
    midiRef.current?.stopMtcOutput();
    clockModeRef.current = nextMode;
    setClockModeState(nextMode);
    cbRef.current.onModeReset(nextMode);
    appendLog('CLOCK', `Switched to ${nextMode}`);
  }, [appendLog, syncLockState]);

  const updateSettings = useCallback((patch: Partial<ShowControlSettings>) => {
    // Compute next settings outside setState updater so StrictMode never runs side effects twice (H1/M13).
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    if ('frameRate' in patch || 'timecodeOffsetMs' in patch) {
      cbRef.current.onUpdateTakeMeta({ frameRate: next.frameRate, timecodeOffsetMs: next.timecodeOffsetMs });
    }
    // Only rebind desktop UDP sockets when a desktop network field actually changed (M-B).
    const touchesDesktopNet =
      'oscPort' in patch ||
      'oscAllowAllInterfaces' in patch ||
      'oscTxHost' in patch ||
      'oscTxPort' in patch ||
      'artnetTcTxHost' in patch;
    const f = flagsRef.current;
    if (hasDesktopBridge && touchesDesktopNet && (f.oscRxEnabled || f.oscTxActive || f.artnetTcRxEnabled || f.artnetTcTxEnabled)) {
      void applyDesktopConfig(f, next);
    }
  }, [applyDesktopConfig, hasDesktopBridge]);

  const setOscRxEnabled = useCallback(async (enabled: boolean) => {
    const nextFlags = { ...flagsRef.current, oscRxEnabled: enabled };
    flagsRef.current = nextFlags;
    setOscRxState(enabled);
    await applyDesktopConfig(nextFlags, settingsRef.current);
  }, [applyDesktopConfig]);

  const setOscTxEnabled = useCallback(async (enabled: boolean) => {
    const nextFlags = { ...flagsRef.current, oscTxActive: enabled };
    flagsRef.current = nextFlags;
    setOscTxActive(enabled);
    await applyDesktopConfig(nextFlags, settingsRef.current);
  }, [applyDesktopConfig]);

  const setArtnetTcRxEnabled = useCallback(async (enabled: boolean) => {
    const nextFlags = { ...flagsRef.current, artnetTcRxEnabled: enabled };
    flagsRef.current = nextFlags;
    setArtnetTcRxState(enabled);
    await applyDesktopConfig(nextFlags, settingsRef.current);
  }, [applyDesktopConfig]);

  const setArtnetTcTxEnabled = useCallback(async (enabled: boolean) => {
    const nextFlags = { ...flagsRef.current, artnetTcTxEnabled: enabled };
    flagsRef.current = nextFlags;
    setArtnetTcTxState(enabled);
    await applyDesktopConfig(nextFlags, settingsRef.current);
  }, [applyDesktopConfig]);

  const connectOscWs = useCallback(() => {
    if (hasDesktopBridge) return;
    try {
      oscWsRef.current?.connect(settingsRef.current.oscWsUrl);
    } catch (err) {
      setOscWsError(err instanceof Error ? err.message : 'Invalid WebSocket URL.');
    }
  }, [hasDesktopBridge]);

  const disconnectOscWs = useCallback(() => {
    oscWsRef.current?.disconnect();
  }, []);

  const connectMidi = useCallback(async () => {
    await midiRef.current?.connect();
  }, []);

  const sendFeedback = useCallback((payload: { cue?: string; timecode?: string; bpm?: number; clock?: ClockMode }) => {
    if (!allows(clockModeRef.current, 'internal', 'outbound_osc_feedback')) return;
    if (hasDesktopBridge && flagsRef.current.oscTxActive) {
      void window.stageforgeDesktop?.showControl({
        type: 'send',
        payload: { kind: 'feedback', ...payload },
      }).catch(() => {});
    } else if (!hasDesktopBridge && oscWsRef.current) {
      if (payload.cue !== undefined) oscWsRef.current.sendMessage('/stageforge/state/cue', [{ type: 's', value: payload.cue }]);
      if (payload.timecode !== undefined) oscWsRef.current.sendMessage('/stageforge/state/timecode', [{ type: 's', value: payload.timecode }]);
      if (payload.bpm !== undefined) oscWsRef.current.sendMessage('/stageforge/state/bpm', [{ type: 'f', value: payload.bpm }]);
      if (payload.clock !== undefined) oscWsRef.current.sendMessage('/stageforge/state/clock', [{ type: 's', value: payload.clock }]);
    }
  }, [hasDesktopBridge]);

  const syncFromShowTimeline = useCallback((meta?: { frameRate?: SmpteFrameRate; timecodeOffsetMs?: number }) => {
    // Reset to clean defaults when opening a v1-v4 show without TC metadata so prior offsets never leak (M12).
    const defaults = defaultShowControlSettings();
    const next: ShowControlSettings = {
      ...settingsRef.current,
      frameRate: meta?.frameRate ?? defaults.frameRate,
      timecodeOffsetMs: meta?.timecodeOffsetMs ?? defaults.timecodeOffsetMs,
    };
    settingsRef.current = next;
    setSettings(next);
  }, []);

  return {
    hasDesktopBridge,
    hasWebMidi,
    clockMode,
    setClockMode,
    lockState,
    tcStore,
    settings,
    updateSettings,
    runtime: {
      oscRxEnabled,
      oscTxActive,
      oscWsState,
      oscWsError,
      oscWsRxCount,
      midiMtcRxEnabled,
      midiMscRxEnabled,
      midiMtcTxEnabled,
      artnetTcRxEnabled,
      artnetTcTxEnabled,
      desktopStatus,
      midiStatus,
    },
    eventLog,
    clearLog: () => setEventLog([]),
    setOscRxEnabled,
    setOscTxEnabled,
    setArtnetTcRxEnabled,
    setArtnetTcTxEnabled,
    connectOscWs,
    disconnectOscWs,
    connectMidi,
    setMidiMtcRxEnabled: setMidiMtcRxState,
    setMidiMscRxEnabled: setMidiMscRxState,
    setMidiMtcTxEnabled: setMidiMtcTxState,
    sendFeedback,
    syncFromShowTimeline,
  };
}
