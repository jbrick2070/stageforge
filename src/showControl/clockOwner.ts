// Single Clock Owner gate, Chase External state machine, and Caller deduplication/cue resolver.
// Structurally prevents cue double-firing across internal transport, cue follows, Auto-LD,
// external timecode (MTC / Art-Net TC), and external cue callers (OSC / MSC).

import type { ShowCue } from '../types/show';
import type { NormalizedTriggerEvent } from './oscCodec';
import { frameDurationMs, type SmpteFrameRate } from './timecode';

export type ClockMode = 'master' | 'chase' | 'caller';

export type ClockSource =
  | 'internal'
  | 'follow'
  | 'autoLD'
  | 'take'
  | 'manual'
  | 'osc'
  | 'msc'
  | 'mtc'
  | 'artnetTC';

export type ClockAction =
  | 'take_play'
  | 'take_record'
  | 'cue_follow'
  | 'auto_ld'
  | 'go'
  | 'back'
  | 'cue_pad'
  | 'stop'
  | 'resume'
  | 'reset'
  | 'blackout'
  | 'master'
  | 'bump'
  | 'tempo'
  | 'audio'
  | 'timecode_transport'
  | 'outbound_timecode'
  | 'outbound_osc_feedback'
  | 'remote_clock_mode';

/**
 * Pure single-source-of-truth authorization table for StageForge's clock owner.
 */
export function allows(mode: ClockMode, source: ClockSource, action: ClockAction): boolean {
  // Clock ownership can never be changed remotely in any mode.
  if (action === 'remote_clock_mode') return false;

  // Outbound emission rules: never re-emit timecode while chasing; OSC feedback allowed in master & caller.
  if (action === 'outbound_timecode') return mode === 'master' && source === 'internal';
  if (action === 'outbound_osc_feedback') return (mode === 'master' || mode === 'caller') && source === 'internal';

  // Safety controls: manual blackout and master dimmer always work in every mode.
  if (source === 'manual' && (action === 'blackout' || action === 'master')) return true;

  // Recording is allowed in all modes (stamps TC in chase, records external calls in caller).
  if (action === 'take_record') return source === 'manual' || source === 'internal';

  if (mode === 'master') {
    if (source === 'osc' || source === 'msc' || source === 'mtc' || source === 'artnetTC') {
      return false;
    }
    return action !== 'timecode_transport';
  }

  if (mode === 'chase') {
    if (action === 'timecode_transport') {
      return source === 'mtc' || source === 'artnetTC';
    }
    // External ALL_OFF / blackout emergency safety allowed even during chase.
    if (action === 'blackout' && (source === 'osc' || source === 'msc')) {
      return true;
    }
    // Tempo adjustments, manual audio toggle, & manual bumps remain usable; internal take play, follows, Auto-LD, and GO are blocked.
    if (source === 'manual' && (action === 'bump' || action === 'tempo' || action === 'audio')) {
      return true;
    }
    return false;
  }

  // mode === 'caller'
  if (action === 'take_play' || action === 'cue_follow' || action === 'auto_ld' || action === 'timecode_transport') {
    return false;
  }
  if (source === 'osc' || source === 'msc' || source === 'manual') {
    return true;
  }
  return false;
}

// --- Chase External State Machine ---

export type ChaseLockState = 'UNLOCKED' | 'LOCKING' | 'LOCKED' | 'FREEWHEEL' | 'STOPPED';

export interface ChaseConfig {
  dropoutMs: number; // 250..500 ms before entering FREEWHEEL
  freewheelMs: number; // 0..2000 ms before entering STOPPED
  timecodeOffsetMs: number; // e.g. 3600000 for 01:00:00:00 start
}

export interface ChaseStepResult {
  lockState: ChaseLockState;
  action: 'none' | 'seek' | 'advance' | 'hold' | 'stop';
  rawTcMs: number;
  takeMs: number;
  fps: SmpteFrameRate;
  resyncMusic: boolean;
  resumedFromHold?: boolean;
}

export class ChaseEngine {
  public lockState: ChaseLockState = 'UNLOCKED';
  public activeSource: 'mtc' | 'artnetTC' | null = null;
  public fps: SmpteFrameRate = 30;
  public lastTcMs = 0;
  public lastRxAt = 0;
  public playheadMs = 0;
  private consistentCount = 0;
  private stationaryCount = 0;
  private stationarySince = 0;
  private paused = false;
  private lastMusicSyncMs = 0;
  private freewheelStartedAt = 0;
  private config: ChaseConfig;

  constructor(config: Partial<ChaseConfig> = {}) {
    this.config = {
      dropoutMs: Math.max(250, Math.min(500, config.dropoutMs ?? 300)),
      freewheelMs: Math.max(0, Math.min(2000, config.freewheelMs ?? 1000)),
      timecodeOffsetMs: Math.max(0, Math.min(86_399_999, Math.round(config.timecodeOffsetMs ?? 0))),
    };
  }

  setConfig(patch: Partial<ChaseConfig>) {
    if (patch.dropoutMs !== undefined) {
      this.config.dropoutMs = Math.max(250, Math.min(500, patch.dropoutMs));
    }
    if (patch.freewheelMs !== undefined) {
      this.config.freewheelMs = Math.max(0, Math.min(2000, patch.freewheelMs));
    }
    if (patch.timecodeOffsetMs !== undefined) {
      this.config.timecodeOffsetMs = Math.max(0, Math.min(86_399_999, Math.round(patch.timecodeOffsetMs)));
    }
  }

  reset() {
    this.lockState = 'UNLOCKED';
    this.activeSource = null;
    this.consistentCount = 0;
    this.stationaryCount = 0;
    this.stationarySince = 0;
    this.paused = false;
    this.lastRxAt = 0;
    this.freewheelStartedAt = 0;
  }

  private toTakeMs(tcMs: number): number {
    return Math.max(0, Math.round(tcMs - this.config.timecodeOffsetMs));
  }

  /**
   * Process an incoming timecode sample (MTC or Art-Net TC).
   * - Pins to the first active source while LOCKING/LOCKED/FREEWHEEL so two enabled sources cannot fight (M5).
   * - Computes predicted time from `lastTcMs + elapsed` (never double-counting tick interpolation: H2/M2).
   * - Detects stationary/repeating timecode frames and holds cleanly without creeping or re-firing (H2).
   */
  onTimecode(
    sample: { ms: number; fps: SmpteFrameRate; source?: 'mtc' | 'artnetTC'; locate?: boolean; reverse?: boolean },
    now = Date.now(),
  ): ChaseStepResult {
    const frameMs = frameDurationMs(sample.fps);
    const src = sample.source ?? null;

    // Ignore competing TC source while locked/locking/freewheeling on another source (M5).
    if (
      src &&
      this.activeSource &&
      this.activeSource !== src &&
      this.lockState !== 'UNLOCKED' &&
      this.lockState !== 'STOPPED'
    ) {
      return {
        lockState: this.lockState,
        action: 'none',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: this.fps,
        resyncMusic: false,
      };
    }
    if (src) this.activeSource = src;
    this.fps = sample.fps;

    // Full-Frame locate or reverse MTC: seek silently, never fire skipped events.
    if (sample.locate || sample.reverse) {
      this.lastTcMs = sample.ms;
      this.lastRxAt = now;
      this.playheadMs = sample.ms;
      this.consistentCount = sample.locate ? 2 : 0;
      this.stationaryCount = 0;
      this.stationarySince = 0;
      this.paused = Boolean(sample.locate);
      this.lockState = sample.locate ? 'LOCKED' : 'LOCKING';
      this.freewheelStartedAt = 0;
      const takeMs = this.toTakeMs(sample.ms);
      this.lastMusicSyncMs = takeMs;
      return {
        lockState: this.lockState,
        action: 'seek',
        rawTcMs: sample.ms,
        takeMs,
        fps: sample.fps,
        resyncMusic: true,
      };
    }

    const wasRelocking = this.lockState === 'FREEWHEEL';

    if (this.lockState === 'UNLOCKED' || this.lockState === 'STOPPED') {
      this.lastTcMs = sample.ms;
      this.lastRxAt = now;
      this.playheadMs = sample.ms;
      this.consistentCount = 1;
      this.stationaryCount = 0;
      this.stationarySince = 0;
      this.paused = false;
      this.lockState = 'LOCKING';
      return {
        lockState: this.lockState,
        action: 'none',
        rawTcMs: sample.ms,
        takeMs: this.toTakeMs(sample.ms),
        fps: sample.fps,
        resyncMusic: false,
      };
    }

    const elapsed = Math.max(0, now - this.lastRxAt);
    const predictedMs = this.lastTcMs + elapsed;
    const rawStep = sample.ms - this.lastTcMs;

    if (this.lockState === 'LOCKING') {
      // Require strictly progressing forward step (0 < step <= 10 frames) to lock cleanly.
      if (rawStep > 0 && rawStep <= frameMs * 10) {
        this.consistentCount++;
        this.lastTcMs = sample.ms;
        this.lastRxAt = now;
        this.playheadMs = sample.ms;
        if (this.consistentCount >= 2) {
          this.lockState = 'LOCKED';
          this.paused = false;
          this.stationaryCount = 0;
          this.stationarySince = 0;
          const takeMs = this.toTakeMs(sample.ms);
          this.lastMusicSyncMs = takeMs;
          return {
            lockState: 'LOCKED',
            action: 'seek',
            rawTcMs: sample.ms,
            takeMs,
            fps: sample.fps,
            resyncMusic: true,
          };
        }
      } else {
        this.consistentCount = 1;
        this.lastTcMs = sample.ms;
        this.lastRxAt = now;
        this.playheadMs = sample.ms;
      }
      return {
        lockState: this.lockState,
        action: 'none',
        rawTcMs: sample.ms,
        takeMs: this.toTakeMs(sample.ms),
        fps: sample.fps,
        resyncMusic: false,
      };
    }

    // Re-lock from FREEWHEEL always goes through the jump/seek rule.
    if (wasRelocking) {
      this.lockState = 'LOCKED';
      this.freewheelStartedAt = 0;
      this.stationaryCount = 0;
      this.stationarySince = 0;
      this.paused = false;
      this.lastTcMs = sample.ms;
      this.lastRxAt = now;
      this.playheadMs = sample.ms;
      const takeMs = this.toTakeMs(sample.ms);
      const resyncMusic = Math.abs(takeMs - this.lastMusicSyncMs) > 40;
      if (resyncMusic) this.lastMusicSyncMs = takeMs;
      return {
        lockState: 'LOCKED',
        action: 'seek',
        rawTcMs: sample.ms,
        takeMs,
        fps: sample.fps,
        resyncMusic,
      };
    }

    // LOCKED state: detect stationary / repeating identical timecode (paused generator) so playhead
    // never creeps forward and media clocks actually pause (M3). Require both >= 2 repeats AND at
    // least max(3 frames, 120 ms) of stationary wall time so high-rate duplicate Art-Net packets never stutter audio.
    if (Math.abs(rawStep) < 1) {
      if (this.stationaryCount === 0) {
        this.stationarySince = now;
      }
      this.stationaryCount++;
      this.lastRxAt = now;
      const stationaryElapsed = Math.max(0, now - this.stationarySince);
      const holdThresholdMs = Math.max(frameMs * 3, 120);
      if (!this.paused && this.stationaryCount >= 2 && stationaryElapsed >= holdThresholdMs) {
        this.paused = true;
        this.playheadMs = this.lastTcMs;
        return {
          lockState: 'LOCKED',
          action: 'hold',
          rawTcMs: this.playheadMs,
          takeMs: this.toTakeMs(this.playheadMs),
          fps: sample.fps,
          resyncMusic: false,
        };
      }
      if (this.paused) {
        this.playheadMs = this.lastTcMs;
      }
      return {
        lockState: 'LOCKED',
        action: 'none',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: sample.fps,
        resyncMusic: false,
      };
    }

    this.stationaryCount = 0;
    this.stationarySince = 0;
    const wasPaused = this.paused;
    this.paused = false;
    const prevTcMs = this.lastTcMs;
    this.lastTcMs = sample.ms;
    this.lastRxAt = now;

    // Jump detection: forward > 10 frames past predicted (or past prevTcMs if resuming from pause)
    // OR genuinely backward > 2 frames relative to previous TC sample -> silent seek.
    const forwardRef = wasPaused ? prevTcMs : predictedMs;
    const deltaMs = sample.ms - forwardRef;
    if (sample.ms < prevTcMs - frameMs * 2 || deltaMs > frameMs * 10) {
      this.playheadMs = sample.ms;
      const takeMs = this.toTakeMs(sample.ms);
      this.lastMusicSyncMs = takeMs;
      return {
        lockState: 'LOCKED',
        action: 'seek',
        rawTcMs: sample.ms,
        takeMs,
        fps: sample.fps,
        resyncMusic: true,
        ...(wasPaused ? { resumedFromHold: true } : {}),
      };
    }

    // Normal progression or small jitter (<= 2 frames): keep playhead aligned to authoritative TC
    // without double-counting elapsed time or ratcheting early (H2/M2).
    this.playheadMs = Math.max(this.playheadMs, sample.ms);
    const takeMs = this.toTakeMs(this.playheadMs);
    const driftFromSync = Math.abs(takeMs - this.lastMusicSyncMs);
    const resyncMusic = wasPaused || driftFromSync > 40;
    if (resyncMusic) this.lastMusicSyncMs = takeMs;

    return {
      lockState: 'LOCKED',
      action: 'advance',
      rawTcMs: this.playheadMs,
      takeMs,
      fps: sample.fps,
      resyncMusic,
      ...(wasPaused ? { resumedFromHold: true } : {}),
    };
  }

  /**
   * Periodic tick (~30–60 Hz) to interpolate playhead between TC packets and detect dropouts.
   */
  tick(now = Date.now()): ChaseStepResult {
    if (this.lockState === 'LOCKING') {
      // Clear stale source pin if a LOCKING source goes silent past dropoutMs (M-A).
      if (this.lastRxAt > 0 && Math.max(0, now - this.lastRxAt) > this.config.dropoutMs) {
        this.lockState = 'UNLOCKED';
        this.activeSource = null;
        this.consistentCount = 0;
      }
      return {
        lockState: this.lockState,
        action: 'none',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: this.fps,
        resyncMusic: false,
      };
    }
    if (this.lockState === 'UNLOCKED' || this.lockState === 'STOPPED') {
      return {
        lockState: this.lockState,
        action: 'none',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: this.fps,
        resyncMusic: false,
      };
    }

    const sinceRx = Math.max(0, now - this.lastRxAt);

    if (this.lockState === 'LOCKED') {
      if (sinceRx > this.config.dropoutMs) {
        if (this.paused || this.config.freewheelMs <= 0) {
          this.lockState = 'STOPPED';
          this.activeSource = null;
          return {
            lockState: 'STOPPED',
            action: 'stop',
            rawTcMs: this.playheadMs,
            takeMs: this.toTakeMs(this.playheadMs),
            fps: this.fps,
            resyncMusic: false,
          };
        }
        this.lockState = 'FREEWHEEL';
        this.freewheelStartedAt = now;
      }
      if (this.paused) {
        return {
          lockState: 'LOCKED',
          action: 'none',
          rawTcMs: this.playheadMs,
          takeMs: this.toTakeMs(this.playheadMs),
          fps: this.fps,
          resyncMusic: false,
        };
      }
      // Cap inter-frame interpolation to 1 frame during LOCKED so a stalled sender cannot creep ahead (H2).
      const maxInterp = this.lockState === 'FREEWHEEL' ? sinceRx : Math.min(sinceRx, frameDurationMs(this.fps));
      this.playheadMs = Math.max(this.playheadMs, this.lastTcMs + maxInterp);
      return {
        lockState: this.lockState,
        action: 'advance',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: this.fps,
        resyncMusic: false,
      };
    }

    // FREEWHEEL state
    const fwElapsed = Math.max(0, now - this.freewheelStartedAt);
    if (fwElapsed >= this.config.freewheelMs) {
      this.lockState = 'STOPPED';
      this.activeSource = null;
      return {
        lockState: 'STOPPED',
        action: 'stop',
        rawTcMs: this.playheadMs,
        takeMs: this.toTakeMs(this.playheadMs),
        fps: this.fps,
        resyncMusic: false,
      };
    }
    this.playheadMs = Math.max(this.playheadMs, this.lastTcMs + sinceRx);
    return {
      lockState: 'FREEWHEEL',
      action: 'advance',
      rawTcMs: this.playheadMs,
      takeMs: this.toTakeMs(this.playheadMs),
      fps: this.fps,
      resyncMusic: false,
    };
  }
}

// --- Cue Caller Deduplication & Strict Resolution ---

/**
 * Strictly resolve a cue reference without fuzzy matching (ambiguity is a double-fire risk).
 * - Integer `index`: 1-based cue list index.
 * - `ref` from MSC: exact trimmed cue name (for dotted Q_numbers like "1.5").
 * - `ref` from OSC: exact cue ID first, then exact trimmed cue name.
 */
export function resolveCallerCue(
  cues: readonly ShowCue[],
  cueRef: { index?: number; ref?: string },
  source: 'osc' | 'msc',
): ShowCue | null {
  if (cueRef.index !== undefined) {
    const idx = cueRef.index - 1;
    return idx >= 0 && idx < cues.length ? cues[idx] : null;
  }
  if (cueRef.ref !== undefined) {
    const target = cueRef.ref.trim();
    if (!target) return null;
    if (source === 'osc') {
      const byId = cues.find((c) => c.id === target);
      if (byId) return byId;
    }
    return cues.find((c) => c.name.trim() === target) ?? null;
  }
  return null;
}

export class CallerDedupe {
  private lastBareGoAt = -Infinity;
  private lastCueId: string | null = null;
  private lastCueAt = -Infinity;

  reset() {
    this.lastBareGoAt = -Infinity;
    this.lastCueId = null;
    this.lastCueAt = -Infinity;
  }

  /** Returns true if this GO call should fire, or false if deduplicated/coalesced. */
  acceptGo(targetCueId: string | null, isBareGo: boolean, activeCueId: string | null, now = Date.now()): boolean {
    if (isBareGo) {
      if (now - this.lastBareGoAt < 100) return false;
      this.lastBareGoAt = now;
      if (targetCueId) {
        this.lastCueId = targetCueId;
        this.lastCueAt = now;
      }
      return true;
    }
    // Suppress duplicate GO for the same cue within 250 ms even if two packets arrive
    // before React commits activeCueId (or while that cue is already active).
    if (targetCueId && targetCueId === this.lastCueId && now - this.lastCueAt < 250) {
      if (activeCueId === null || activeCueId === targetCueId) return false;
    }
    if (targetCueId) {
      this.lastCueId = targetCueId;
      this.lastCueAt = now;
    }
    return true;
  }
}

export function triggerToAction(ev: NormalizedTriggerEvent): ClockAction {
  switch (ev.command) {
    case 'go': return 'go';
    case 'back': return 'back';
    case 'stop': return 'stop';
    case 'resume': return 'resume';
    case 'reset': return 'reset';
    case 'blackout': return 'blackout';
    case 'master': return 'master';
    case 'bump': return 'bump';
    case 'tempo_tap':
    case 'tempo_bpm':
    case 'tempo_half':
    case 'tempo_double':
      return 'tempo';
    case 'audio_reactive':
    case 'audio_mapping_amount':
      return 'audio';
  }
}

export interface ChaseHeldMediaState {
  audio: boolean;
  screen: boolean;
}

export interface ChaseTransportDeps {
  held: ChaseHeldMediaState;
  getEndMs: () => number;
  setReplaying: (running: boolean) => void;
  clearFollow: () => void;
  prepareSeek: () => void;
  chaseSeekTimeline: (takeMs: number, running: boolean) => void;
  chaseAdvanceTimeline: (takeMs: number) => void;
  resolveTimelineFrame: (takeMs: number) => {
    music?: { playing?: boolean };
    screen?: { kind?: string; playing?: boolean; offsetSeconds?: number };
  } | null;
  restoreTimelineMusic: (music: { playing?: boolean }) => void;
  restoreTimelineScreen: (screen: { kind?: string; playing?: boolean; offsetSeconds?: number }) => void;
  isAudioPlaying: () => boolean;
  pauseAudio: () => void;
  resumeAudio: () => void;
  stopAudio: () => void;
  isScreenVideoPlaying: () => boolean;
  setScreenPlaying: (playing: boolean) => void;
  setWallClock: (posMs: number, running: boolean, endMs?: number) => void;
  getWallClockPos: () => number;
  clearReplayBumps: () => void;
}

/**
 * Shared timecode-chase transport coordinator used by App.tsx and unit tests.
 * - Clears replay-owned hazardous bumps on chase hold, chase stop, and non-running seek (R2).
 * - Preserves and resumes held audio/video on both advance and forward-jump seek paths when no timeline exists (R4).
 */
export function createChaseTransportHandlers(deps: ChaseTransportDeps) {
  function resumeHeldWithoutTimeline(held: ChaseHeldMediaState) {
    if (held.audio && !deps.isAudioPlaying()) {
      deps.resumeAudio();
    }
    if (held.screen) {
      deps.setScreenPlaying(true);
    }
  }

  return {
    onChaseSeek(
      takeMs: number,
      running: boolean,
      _resyncMusic: boolean,
      opts?: { resumedFromHold?: boolean },
    ) {
      const endMs = deps.getEndMs();
      const held: ChaseHeldMediaState = { audio: deps.held.audio, screen: deps.held.screen };
      deps.held.audio = false;
      deps.held.screen = false;
      deps.clearFollow();
      deps.setReplaying(running);
      deps.prepareSeek();
      deps.chaseSeekTimeline(takeMs, running);
      if (!running) {
        deps.clearReplayBumps();
      } else if (opts?.resumedFromHold && !deps.resolveTimelineFrame(takeMs)) {
        resumeHeldWithoutTimeline(held);
      }
      deps.setWallClock(Math.min(takeMs, endMs), running && takeMs < endMs, endMs);
    },
    onChaseAdvance(takeMs: number, opts?: { resumedFromHold?: boolean; resyncMusic?: boolean }) {
      const endMs = deps.getEndMs();
      deps.setReplaying(true);
      deps.chaseAdvanceTimeline(takeMs);
      if (opts?.resumedFromHold) {
        const held: ChaseHeldMediaState = { audio: deps.held.audio, screen: deps.held.screen };
        deps.held.audio = false;
        deps.held.screen = false;
        const resolved = deps.resolveTimelineFrame(takeMs);
        if (resolved) {
          if (resolved.music && resolved.music.playing) {
            deps.restoreTimelineMusic(resolved.music);
          }
          if (resolved.screen && resolved.screen.kind === 'video' && resolved.screen.playing) {
            deps.restoreTimelineScreen(resolved.screen);
          }
        } else {
          resumeHeldWithoutTimeline(held);
        }
        deps.setWallClock(Math.min(takeMs, endMs), takeMs < endMs, endMs);
      }
    },
    onChaseHold(takeMs: number) {
      const endMs = deps.getEndMs();
      deps.setReplaying(false);
      deps.clearReplayBumps();
      if (deps.isAudioPlaying()) {
        deps.pauseAudio();
        deps.held.audio = true;
      }
      if (deps.isScreenVideoPlaying()) {
        deps.setScreenPlaying(false);
        deps.held.screen = true;
      }
      deps.setWallClock(Math.min(takeMs, endMs), false, endMs);
    },
    onChaseStop() {
      deps.held.audio = false;
      deps.held.screen = false;
      deps.setReplaying(false);
      deps.clearReplayBumps();
      deps.setWallClock(deps.getWallClockPos(), false);
      deps.setScreenPlaying(false);
      deps.stopAudio();
    },
  };
}
