// Tempo utilities, tap tempo, offline beat grid (web-audio-beat-detector),
// and live BPM stabilizer/adapter (realtime-bpm-analyzer).

export const BPM_MIN = 70;
export const BPM_MAX = 180;
export const MAX_OFFLINE_AUDIO_BYTES = 64 * 1024 * 1024; // 64 MiB cap before decode
export const MAX_OFFLINE_AUDIO_SECONDS = 15 * 60; // 15 min cap before decodeAudioData

export interface BeatGrid {
  bpm: number;
  offsetMs: number;
  source: 'offline' | 'manual';
}

export type BeatGridStatus =
  | { state: 'idle' }
  | { state: 'analyzing'; trackName: string }
  | { state: 'ready'; grid: BeatGrid }
  | { state: 'too_long'; reason: string }
  | { state: 'unavailable'; reason: string };

export type LiveBpmStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'listening'; candidateBpm: number | null }
  | { state: 'locked'; candidateBpm: number }
  | { state: 'unavailable'; reason: string };

/**
 * Fold any positive BPM into StageForge's schema range [70, 180] via octave halving/doubling.
 * Rounds to 1 decimal place.
 */
export function foldBpm(rawBpm: number): number | null {
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) return null;
  let bpm = rawBpm;
  let guard = 0;
  while (bpm < BPM_MIN && guard++ < 16) bpm *= 2;
  while (bpm > BPM_MAX && guard++ < 16) bpm /= 2;
  const rounded = Math.round(bpm * 10) / 10;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, rounded));
}

/** Half-time without folding: returns null if bpm / 2 would leave [70, 180]. */
export function halfTimeBpm(bpm: number): number | null {
  if (!Number.isFinite(bpm)) return null;
  const next = Math.round((bpm / 2) * 10) / 10;
  return next >= BPM_MIN && next <= BPM_MAX ? next : null;
}

/** Double-time without folding: returns null if bpm * 2 would leave [70, 180]. */
export function doubleTimeBpm(bpm: number): number | null {
  if (!Number.isFinite(bpm)) return null;
  const next = Math.round((bpm * 2) * 10) / 10;
  return next >= BPM_MIN && next <= BPM_MAX ? next : null;
}

/** Shift a beat grid's downbeat offset by `deltaMs` (e.g. ±10 ms or ±50 ms). */
export function nudgeBeatGrid(grid: BeatGrid, deltaMs: number): BeatGrid {
  const beatMs = 60000 / grid.bpm;
  const nextOffset = (((grid.offsetMs + deltaMs) % beatMs) + beatMs) % beatMs;
  return { ...grid, offsetMs: Math.round(nextOffset * 10) / 10 };
}

/** Anchor the beat grid so `playbackMs` becomes Beat 1 (downbeat). */
export function setBeatGridDownbeat(grid: BeatGrid, playbackMs: number): BeatGrid {
  const beatMs = 60000 / grid.bpm;
  const safeMs = Number.isFinite(playbackMs) ? playbackMs : 0;
  const nextOffset = ((safeMs % beatMs) + beatMs) % beatMs;
  return { ...grid, offsetMs: Math.round(nextOffset * 10) / 10 };
}

/** Compute continuous beat phase and integer beat index at `playbackMs`. */
export function beatGridPhase(grid: BeatGrid, playbackMs: number): { beatIndex: number; phase: number; isDownbeat: boolean } {
  const raw = ((playbackMs - grid.offsetMs) * grid.bpm) / 60000;
  const beatIndex = Math.floor(raw);
  const phase = raw - beatIndex;
  const isDownbeat = ((beatIndex % 4) + 4) % 4 === 0;
  return { beatIndex, phase, isDownbeat };
}

/**
 * Tap Tempo tracker: averages the last 4..8 intervals and resets after a 2-second gap.
 */
export class TapTempoTracker {
  private taps: number[] = [];
  private readonly resetGapMs: number;
  private readonly maxIntervals: number;

  constructor(resetGapMs = 2000, maxIntervals = 8) {
    this.resetGapMs = resetGapMs;
    this.maxIntervals = maxIntervals;
  }

  reset() {
    this.taps.length = 0;
  }

  tap(nowMs = performance.now()): { bpm: number | null; count: number } {
    if (this.taps.length > 0 && nowMs - this.taps[this.taps.length - 1] > this.resetGapMs) {
      this.taps.length = 0;
    }
    // Ignore duplicate taps closer than 80 ms (debounce).
    if (this.taps.length > 0 && nowMs - this.taps[this.taps.length - 1] < 80) {
      return { bpm: this.currentBpm(), count: this.taps.length };
    }
    this.taps.push(nowMs);
    if (this.taps.length > this.maxIntervals + 1) {
      this.taps.shift();
    }
    return { bpm: this.currentBpm(), count: this.taps.length };
  }

  currentBpm(): number | null {
    if (this.taps.length < 2) return null;
    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push(this.taps[i] - this.taps[i - 1]);
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const kept = intervals.filter((dt) => dt >= median * 0.5 && dt <= median * 2.0);
    const use = kept.length > 0 ? kept : intervals;
    const avgMs = use.reduce((sum, dt) => sum + dt, 0) / use.length;
    if (avgMs <= 0) return null;
    return foldBpm(60000 / avgMs);
  }
}

/**
 * Live BPM stabilizer: computes rolling median of recent candidates and only emits an
 * auto-apply BPM when stable within ±1.5 BPM for >= 4 s and differing from current BPM by > 1 BPM.
 */
export class LiveBpmStabilizer {
  private samples: number[] = [];
  private stableSince: number | null = null;
  private stableAnchor: number | null = null;
  private readonly windowSize: number;
  private readonly holdMs: number;
  private readonly toleranceBpm: number;

  constructor(windowSize = 7, holdMs = 4000, toleranceBpm = 1.5) {
    this.windowSize = windowSize;
    this.holdMs = holdMs;
    this.toleranceBpm = toleranceBpm;
  }

  reset() {
    this.samples.length = 0;
    this.stableSince = null;
    this.stableAnchor = null;
  }

  observe(
    rawBpm: number,
    currentDeskBpm: number,
    followEnabled: boolean,
    nowMs = Date.now(),
  ): { medianBpm: number | null; applyBpm: number | null } {
    const folded = foldBpm(rawBpm);
    if (folded === null) return { medianBpm: null, applyBpm: null };

    this.samples.push(folded);
    if (this.samples.length > this.windowSize) this.samples.shift();

    const sorted = [...this.samples].sort((a, b) => a - b);
    const medianBpm = sorted[Math.floor(sorted.length / 2)];

    if (this.stableAnchor === null || Math.abs(medianBpm - this.stableAnchor) > this.toleranceBpm) {
      this.stableAnchor = medianBpm;
      this.stableSince = nowMs;
      return { medianBpm, applyBpm: null };
    }

    if (followEnabled && this.stableSince !== null && nowMs - this.stableSince >= this.holdMs) {
      if (Math.abs(medianBpm - currentDeskBpm) > 1.0) {
        // Reset hold timer after applying so we don't spam updates every frame.
        this.stableSince = nowMs;
        this.stableAnchor = medianBpm;
        return { medianBpm, applyBpm: Math.round(medianBpm) };
      }
    }

    return { medianBpm, applyBpm: null };
  }
}

// --- Offline Beat Grid Analysis (web-audio-beat-detector) ---

const gridCache = new Map<string, BeatGrid>();
const MAX_GRID_CACHE = 32;

function cacheKeyForFile(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function probeAudioDurationSeconds(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const onLoaded = () => {
      const dur = audio.duration;
      cleanup();
      resolve(dur);
    };
    const onError = () => {
      cleanup();
      reject(new Error('Could not read audio duration.'));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
    audio.src = url;
  });
}

/**
 * Compute an offline beat grid (`{ bpm, offsetMs }`) for an uploaded audio File using
 * `web-audio-beat-detector`. Enforces 64 MiB and 15-minute caps BEFORE `decodeAudioData`
 * and decodes into a mono 22.05 kHz OfflineAudioContext to limit PCM memory usage.
 */
export async function analyzeFileBeatGrid(file: File, signal?: AbortSignal): Promise<BeatGridStatus> {
  const key = cacheKeyForFile(file);
  const cached = gridCache.get(key);
  if (cached) return { state: 'ready', grid: { ...cached } };

  if (file.size > MAX_OFFLINE_AUDIO_BYTES) {
    return { state: 'too_long', reason: 'Track exceeds 64 MiB beat-grid limit.' };
  }

  let durationSec: number;
  try {
    durationSec = await probeAudioDurationSeconds(file, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { state: 'unavailable', reason: 'Could not read track metadata for beat grid.' };
  }

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { state: 'unavailable', reason: 'Track duration is unavailable.' };
  }
  if (durationSec > MAX_OFFLINE_AUDIO_SECONDS) {
    return { state: 'too_long', reason: 'Track exceeds 15-minute beat-grid limit.' };
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  if (typeof OfflineAudioContext === 'undefined') {
    return { state: 'unavailable', reason: 'OfflineAudioContext unavailable in this browser.' };
  }

  let buffer: AudioBuffer | null = null;
  try {
    const raw = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Mono 22.05 kHz decode cuts peak PCM memory by ~4x compared to stereo 48 kHz.
    const decoderCtx = new OfflineAudioContext(1, 1, 22050);
    buffer = await decoderCtx.decodeAudioData(raw);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Re-check decoded duration in case container metadata header lied (L3).
    if (!Number.isFinite(buffer.duration) || buffer.duration > MAX_OFFLINE_AUDIO_SECONDS) {
      buffer = null;
      return { state: 'too_long', reason: 'Decoded audio exceeds 15-minute beat-grid limit.' };
    }

    const { guess } = await import('web-audio-beat-detector');
    const result = await guess(buffer, { minTempo: 90, maxTempo: 180 });
    buffer = null; // Release PCM reference immediately.

    const folded = foldBpm(result.bpm);
    if (folded === null) {
      return { state: 'unavailable', reason: 'Could not determine a stable tempo.' };
    }
    const beatMs = 60000 / folded;
    const rawOffsetMs = Number.isFinite(result.offset) ? result.offset * 1000 : 0;
    const offsetMs = Math.round((((rawOffsetMs % beatMs) + beatMs) % beatMs) * 10) / 10;
    const grid: BeatGrid = { bpm: folded, offsetMs, source: 'offline' };

    if (gridCache.size >= MAX_GRID_CACHE) {
      const oldest = gridCache.keys().next().value;
      if (oldest !== undefined) gridCache.delete(oldest);
    }
    gridCache.set(key, grid);
    return { state: 'ready', grid };
  } catch (err) {
    buffer = null;
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { state: 'unavailable', reason: 'No clear beat grid detected in this track.' };
  }
}

// --- Live Tempo Analyzer Adapter (realtime-bpm-analyzer) ---

export interface LiveBpmHandle {
  input: AudioNode;
  reset(): void;
  stop(): void;
}

/**
 * Create a live AudioWorklet BPM analyzer using `realtime-bpm-analyzer` with an explicit
 * Vite `?url` processor URL so it complies with Electron's strict `script-src 'self'` CSP.
 * Never throws; calls `onUnavailable` if AudioWorklet is unsupported or blocked.
 */
export async function createLiveBpmHandle(
  audioContext: AudioContext,
  opts: {
    liveTrack?: MediaStreamTrack;
    onReading: (bpm: number, locked: boolean) => void;
    onUnavailable: (reason: string) => void;
  },
): Promise<LiveBpmHandle | null> {
  if (typeof AudioContext === 'undefined' || !('audioWorklet' in AudioContext.prototype) || !audioContext.audioWorklet) {
    opts.onUnavailable('Live BPM unavailable (AudioWorklet unsupported).');
    return null;
  }
  try {
    const [{ createRealtimeBpmAnalyzer }, { default: processorUrl }] = await Promise.all([
      import('realtime-bpm-analyzer'),
      import('realtime-bpm-analyzer/processor?url'),
    ]);
    const analyzer = await createRealtimeBpmAnalyzer(audioContext, {
      processorUrl,
      tempoRange: { min: 90, max: 180 },
      ...(opts.liveTrack ? { liveInput: opts.liveTrack } : {}),
    });
    const unsubReading = analyzer.on('reading', (reading) => {
      if (Number.isFinite(reading.bpm) && reading.bpm > 0) {
        opts.onReading(reading.bpm, analyzer.state.status === 'locked');
      }
    });
    const unsubState = analyzer.on('statechange', ({ to }) => {
      if (to.status === 'locked' && Number.isFinite(to.reading.bpm) && to.reading.bpm > 0) {
        opts.onReading(to.reading.bpm, true);
      }
    });
    const unsubError = analyzer.on('error', () => {
      opts.onUnavailable('Live BPM analyzer stopped due to an audio error.');
    });
    return {
      input: analyzer.input,
      reset: () => {
        try { analyzer.reset(); } catch { /* ignore if stopped */ }
      },
      stop: () => {
        unsubReading();
        unsubState();
        unsubError();
        try { analyzer.stop(); } catch { /* ignore */ }
      },
    };
  } catch {
    opts.onUnavailable('Live BPM unavailable in this environment.');
    return null;
  }
}
