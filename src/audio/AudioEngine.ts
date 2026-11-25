import type { AudioMetrics, MusicRef } from '../types/show';
import { DEMO_TOTAL_STEPS, getDemoPosition } from '../data/demoShow';
import { demoTrackStepAtMs, getDemoTrackPosition, type DemoTrackMap } from '../data/demoTrack';
import { DemoScore } from './demoScore';
import {
  beatGridPhase,
  createLiveBpmHandle,
  type BeatGrid,
  type LiveBpmHandle,
} from './tempoEngine';

interface ScheduledStep {
  step: number;
  time: number;
  duration: number;
}

interface FileSource {
  file: File;
  element: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  url: string;
  abort: AbortController;
  demoTrack?: DemoTrackMap;
}

function releaseFile(file: FileSource) {
  file.abort.abort();
  file.node.disconnect();
  file.element.pause();
  file.element.removeAttribute('src');
  file.element.load();
  URL.revokeObjectURL(file.url);
}

function seekLoop(element: HTMLMediaElement, offset: number) {
  const time = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const target = Number.isFinite(element.duration) && element.duration > 0 ? time % element.duration : time;
  if (Math.abs(element.currentTime - target) > 0.015) element.currentTime = target;
}

function fileMetadata(file: FileSource) {
  const { element, abort } = file;
  return new Promise<void>((resolve, reject) => {
    if (element.readyState >= 1) return resolve();
    const clean = () => {
      element.removeEventListener('loadedmetadata', ready);
      element.removeEventListener('error', failed);
      abort.signal.removeEventListener('abort', cancelled);
    };
    const ready = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error('The selected audio file could not be decoded.')); };
    const cancelled = () => { clean(); reject(new DOMException('Source changed', 'AbortError')); };
    element.addEventListener('loadedmetadata', ready);
    element.addEventListener('error', failed);
    abort.signal.addEventListener('abort', cancelled);
  });
}

// 46-byte silent 1-sample 8 kHz 16-bit mono PCM WAV for CSP-safe blob: media-element gesture unlock (iOS Safari).
const SILENT_WAV_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export interface PreparedPlaybackElement {
  element: HTMLAudioElement;
  cleanup: () => void;
}

export interface DemoTrackLoadResult {
  trackName: string;
  playing: boolean;
  autoplayBlocked: boolean;
}
const SCHEDULE_AHEAD = 0.15; // Audio seconds; covers main-thread rendering jitter.
const PUMP_INTERVAL_MS = 25;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256));

  private activeFile: FileSource | null = null;
  private pendingFile: FileSource | null = null;
  private micStream: MediaStream | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private sourceGeneration = 0;

  private score: DemoScore | null = null;
  private synthTimer: number | null = null;
  private nextStep = 0;
  private nextStepTime = 0;
  private scheduled: ScheduledStep[] = [];
  private heldStep = 0;
  private lastDemoBeat = -1;
  private pendingSuspend: Promise<void> | null = null;
  private bpm = 128;

  private source: 'none' | 'synth' | 'file' | 'mic' = 'none';
  private playing = false;
  private trackName = 'No Audio Loaded';
  private volume = 0.72;

  // Beat detection state
  private bassHistory: number[] = [];
  private lastBeatTime = 0;
  private beatPulse = 0;
  private spectrum32 = new Float32Array(32);

  // Offline beat grid (loaded file path only) & live BPM analyzer
  private beatGrid: BeatGrid | null = null;
  private lastGridBeatIndex: number | null = null;
  private liveBpmEnabled = false;
  private liveBpmGen = 0;
  private liveBpmHandle: LiveBpmHandle | null = null;
  private liveBpmSourceNode: AudioNode | null = null;
  private liveBpmCallbacks: {
    onReading: (bpm: number, locked: boolean) => void;
    onUnavailable: (reason: string) => void;
  } | null = null;

  public getMetrics(dt: number): AudioMetrics {
    this.beatPulse = Math.max(0, this.beatPulse - dt * 3.8);

    const audibleStep = this.source === 'synth' ? this.currentDemoStep() : undefined;
    if (audibleStep === DEMO_TOTAL_STEPS && this.playing) this.finishDemo();
    const trackMap = this.source === 'file' ? this.activeFile?.demoTrack : undefined;
    const demo = audibleStep !== undefined
      ? getDemoPosition(audibleStep)
      : trackMap && this.activeFile
        ? getDemoTrackPosition(trackMap, this.activeFile.element.currentTime * 1000, this.activeFile.element.ended)
        : undefined;
    const demoTrackTitle = trackMap?.title;

    if (!this.analyser || !this.playing) {
      this.spectrum32.fill(0);
      return {
        playing: false,
        demo,
        demoTrackTitle,
        source: this.source,
        trackName: this.trackName,
        energy: 0,
        bass: 0,
        mid: 0,
        high: 0,
        beat: false,
        beatPulse: this.beatPulse,
        drop: false,
        spectrum: this.spectrum32,
      };
    }

    // Keep AnalyserNode decay consistent in real time across variable frame rates (exact 0.78 at 60 fps).
    const smoothFrames = Number.isFinite(dt) && dt > 0 ? Math.max(0.5, dt * 60) : 1;
    this.analyser.smoothingTimeConstant = Math.max(0.05, Math.min(0.9, Math.pow(0.78, smoothFrames)));
    this.analyser.getByteFrequencyData(this.freqData);
    const len = this.freqData.length;

    let bassSum = 0;
    const bassEnd = Math.min(10, len);
    for (let i = 0; i < bassEnd; i++) bassSum += this.freqData[i];
    const bass = bassSum / (bassEnd * 255);

    let midSum = 0;
    const midEnd = Math.min(55, len);
    for (let i = bassEnd; i < midEnd; i++) midSum += this.freqData[i];
    const mid = midSum / (Math.max(1, midEnd - bassEnd) * 255);

    let highSum = 0;
    const highEnd = Math.min(150, len);
    for (let i = midEnd; i < highEnd; i++) highSum += this.freqData[i];
    const high = highSum / (Math.max(1, highEnd - midEnd) * 255);

    const energy = bass * 0.5 + mid * 0.35 + high * 0.15;

    // 32-band spectrum downsampling
    const step = Math.max(1, Math.floor(128 / 32));
    for (let b = 0; b < 32; b++) {
      let acc = 0;
      for (let j = 0; j < step; j++) {
        acc += this.freqData[b * step + j] || 0;
      }
      this.spectrum32[b] = acc / (step * 255);
    }

    let beat = false;
    let drop = false;
    if (demo && audibleStep !== undefined) {
      const beatIndex = Math.floor(audibleStep / 4);
      const started = this.scheduled.length > 0 && this.outputTime() >= this.scheduled[0].time;
      beat = started && beatIndex !== this.lastDemoBeat;
      if (beat) {
        this.lastDemoBeat = beatIndex;
        // Keep the musical pulse even on a soft opening; let louder attacks carry more light.
        this.beatPulse = Math.min(1, 0.22 + bass * 1.15);
      }
      drop = (demo.sectionId === 'drop' || demo.sectionId === 'finale') &&
        demo.barInSection === 0 && demo.stepInBar < 4;
    } else if (this.source === 'file' && this.activeFile && this.beatGrid) {
      // Phase-locked beat pulse driven by the analyzed / nudged offline beat grid or authoritative track map.
      const playbackMs = this.activeFile.element.currentTime * 1000;
      if (demo?.beforeDownbeat) {
        this.lastGridBeatIndex = null;
        beat = false;
        drop = false;
      } else {
        const { beatIndex, isDownbeat } = beatGridPhase(this.beatGrid, playbackMs);
        if (this.lastGridBeatIndex !== null && beatIndex !== this.lastGridBeatIndex) {
          beat = true;
          this.beatPulse = isDownbeat ? 1 : Math.min(1, 0.55 + bass * 0.45);
        }
        this.lastGridBeatIndex = beatIndex;
        drop = demo
          ? (demo.sectionId === 'drop' || demo.sectionId === 'finale') && demo.barInSection === 0 && demo.stepInBar < 4
          : bass > 0.72 && energy > 0.52;
      }
    } else {
      this.bassHistory.push(bass);
      if (this.bassHistory.length > 42) this.bassHistory.shift();
      const avgBass = this.bassHistory.reduce((a, b) => a + b, 0) / this.bassHistory.length;
      const now = performance.now();
      if (bass > 0.36 && bass > avgBass * 1.24 && now - this.lastBeatTime > 260) {
        beat = true;
        this.lastBeatTime = now;
        this.beatPulse = 1;
      }
      drop = bass > 0.72 && energy > 0.52;
    }

    return {
      playing: this.playing,
      demo,
      demoTrackTitle,
      source: this.source,
      trackName: this.trackName,
      energy,
      bass,
      mid,
      high,
      beat,
      beatPulse: this.beatPulse,
      drop,
      spectrum: this.spectrum32,
    };
  }

  private ensureContext(resume = true): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.78;
      this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.analyser);
      this.masterGain.connect(this.ctx.destination);
    }
    const ctx = this.ctx;
    if (resume && (ctx.state === 'suspended' || this.pendingSuspend)) {
      void ctx.resume().catch(() => {});
      // A rapid pause/resume or source change can race a queued suspend command.
      void this.pendingSuspend?.then(() => {
        if (this.ctx === ctx && ctx.state === 'suspended' && (this.source !== 'synth' || this.playing)) {
          void ctx.resume().catch(() => {});
        }
      });
    }
    return this.ctx;
  }

  public setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
  }

  public setBpm(bpm: number) {
    if (Number.isFinite(bpm)) this.bpm = Math.max(70, Math.min(180, bpm));
  }

  public stopAll() {
    this.cancelPendingSource();
    this.releaseActiveSource();
  }

  private cancelPendingSource() {
    if (this.pendingFile) releaseFile(this.pendingFile);
    this.pendingFile = null;
    return ++this.sourceGeneration;
  }

  private releaseActiveSource() {
    this.detachLiveBpm();
    this.playing = false;
    this.source = 'none';
    this.trackName = 'No Audio Loaded';
    this.bassHistory.length = 0;
    this.lastBeatTime = 0;
    this.beatPulse = 0;
    this.beatGrid = null;
    this.lastGridBeatIndex = null;
    this.releaseScore();
    this.heldStep = 0;
    this.lastDemoBeat = -1;
    if (this.activeFile) releaseFile(this.activeFile);
    this.activeFile = null;
    if (this.micSrc) {
      this.micSrc.disconnect();
      this.micSrc = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  public startDemoSynth(bpm = this.bpm) {
    this.restoreDemo(0, bpm, true);
  }

  private restoreDemo(step: number, bpm: number, playing: boolean) {
    this.stopAll();
    this.setBpm(bpm);
    this.source = 'synth';
    this.trackName = 'Arena Anthem';
    this.heldStep = Math.max(0, Math.min(DEMO_TOTAL_STEPS, step));
    this.playing = playing && this.heldStep < DEMO_TOTAL_STEPS;
    if (!this.playing) return;
    const ctx = this.ensureContext();
    this.score = new DemoScore(ctx, this.masterGain!);
    const duration = 15 / this.bpm;
    const origin = ctx.currentTime + 0.025;
    this.nextStep = Math.ceil(this.heldStep);
    this.nextStepTime = origin + (this.nextStep - this.heldStep) * duration;
    this.scheduled.push({ step: this.heldStep, time: origin, duration });
    this.startPump();
    if (this.liveBpmEnabled) void this.attachLiveBpm();
  }

  private outputTime() {
    const ctx = this.ctx!;
    const stamp = ctx.getOutputTimestamp?.();
    if (stamp?.contextTime !== undefined && stamp.performanceTime) {
      return Math.min(ctx.currentTime, stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000);
    }
    return Math.max(0, ctx.currentTime - (ctx.outputLatency || 0));
  }

  private currentDemoStep() {
    if (!this.playing || this.scheduled.length === 0) return this.heldStep;
    const now = this.outputTime();
    // Keep the currently audible sixteenth even when a tempo change is already queued.
    while (this.scheduled.length > 1 && this.scheduled[1].time <= now) this.scheduled.shift();
    const event = this.scheduled[0];
    return Math.max(this.heldStep, Math.min(DEMO_TOTAL_STEPS, event.step + (now - event.time) / event.duration));
  }

  private startPump() {
    this.stopPump();
    this.scheduleAhead();
    if (this.playing) this.synthTimer = window.setInterval(() => this.scheduleAhead(), PUMP_INTERVAL_MS);
  }

  private stopPump() {
    if (this.synthTimer !== null) window.clearInterval(this.synthTimer);
    this.synthTimer = null;
  }

  private scheduleAhead() {
    if (!this.ctx || !this.score || !this.playing) return;
    const now = this.ctx.currentTime;
    const stepSeconds = 15 / this.bpm;
    // When a tab wakes late, catch the next sixteenth rather than firing missed notes together.
    if (this.nextStepTime < now - 0.025) {
      const missed = Math.min(DEMO_TOTAL_STEPS - this.nextStep, Math.ceil((now - this.nextStepTime) / stepSeconds));
      this.nextStep += missed;
      this.nextStepTime += missed * stepSeconds;
    }
    while (this.nextStep < DEMO_TOTAL_STEPS && this.nextStepTime < now + SCHEDULE_AHEAD) {
      this.score.schedule(this.nextStep, this.nextStepTime, stepSeconds);
      this.scheduled.push({ step: this.nextStep, time: this.nextStepTime, duration: stepSeconds });
      this.nextStep++;
      this.nextStepTime += stepSeconds;
    }
    this.currentDemoStep();
    if (this.nextStep === DEMO_TOTAL_STEPS && this.outputTime() >= this.nextStepTime) this.finishDemo();
  }

  private releaseScore() {
    this.stopPump();
    this.score?.dispose();
    this.score = null;
    this.scheduled.length = 0;
  }

  private finishDemo() {
    this.playing = false;
    this.heldStep = DEMO_TOTAL_STEPS;
    this.beatPulse = 0;
    this.releaseScore();
  }

  /**
   * Synchronously unlock an Audio element inside a user gesture via a tiny silent blob: WAV
   * (compatible with Electron's `media-src 'self' blob:` CSP) without resuming a paused synth context.
   */
  public preparePlaybackGesture(): PreparedPlaybackElement {
    this.ensureContext(this.source !== 'synth' || this.playing);
    const element = new Audio();
    element.preload = 'auto';
    element.muted = true;
    const silentUrl = URL.createObjectURL(new Blob([SILENT_WAV_BYTES], { type: 'audio/wav' }));
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      URL.revokeObjectURL(silentUrl);
    };
    element.src = silentUrl;
    try {
      const p = element.play();
      if (p && typeof p.then === 'function') {
        void p.then(() => {
          if (element.src === silentUrl) {
            element.pause();
            element.muted = false;
          }
          cleanup();
        }).catch(() => {
          if (element.src === silentUrl) element.muted = false;
          cleanup();
        });
      }
    } catch {
      element.muted = false;
      cleanup();
    }
    return { element, cleanup };
  }

  public async loadAudioFile(file: File): Promise<string> {
    return this.openAudioFile(file, true);
  }

  public async loadDemoTrack(
    file: File,
    demoTrack: DemoTrackMap,
    prepared?: PreparedPlaybackElement,
  ): Promise<DemoTrackLoadResult> {
    if (prepared) {
      prepared.element.muted = false;
      prepared.cleanup();
    }
    try {
      const trackName = await this.openAudioFile(file, true, undefined, {
        demoTrack,
        element: prepared?.element,
        allowAutoplayFallback: true,
      });
      return {
        trackName,
        playing: this.playing,
        autoplayBlocked: !this.playing,
      };
    } catch (error) {
      prepared?.cleanup();
      throw error;
    }
  }

  public isDemoTrackActive(): boolean {
    return this.source === 'file' && !!this.activeFile?.demoTrack;
  }

  public getActiveDemoTrackMap(): DemoTrackMap | null {
    return this.source === 'file' ? (this.activeFile?.demoTrack ?? null) : null;
  }

  private async openAudioFile(
    file: File,
    playing: boolean,
    position?: () => number,
    options?: { demoTrack?: DemoTrackMap; element?: HTMLAudioElement; allowAutoplayFallback?: boolean },
  ): Promise<string> {
    const generation = this.cancelPendingSource();
    const ctx = this.ensureContext(playing && (this.source !== 'synth' || this.playing));
    const demoTrack = options?.demoTrack;
    const element = options?.element ?? new Audio();
    element.muted = false;
    element.loop = !demoTrack;
    element.preload = 'auto';
    const node = ctx.createMediaElementSource(element);
    const candidate: FileSource = {
      file,
      element,
      node,
      url: URL.createObjectURL(file),
      abort: new AbortController(),
      demoTrack,
    };
    if (demoTrack) {
      element.addEventListener('ended', () => {
        if (this.activeFile === candidate) {
          this.playing = false;
          this.beatPulse = 0;
        }
      }, { signal: candidate.abort.signal });
    }
    this.pendingFile = candidate;
    let actuallyPlaying = playing;
    try {
      // The disconnected source stays silent until the browser accepts the file.
      element.src = candidate.url;
      if (position) {
        await fileMetadata(candidate);
        if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
        seekLoop(element, position());
      }
      if (playing) {
        try {
          await element.play();
        } catch (playErr) {
          if (
            options?.allowAutoplayFallback &&
            playErr instanceof DOMException &&
            playErr.name === 'NotAllowedError'
          ) {
            // Keep the decoded track loaded in paused state so a single tap plays immediately without re-fetching.
            await fileMetadata(candidate);
            if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
            actuallyPlaying = false;
          } else {
            throw playErr;
          }
        }
      }
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      if (position) seekLoop(element, position());
      node.connect(this.masterGain!);
    } catch (error) {
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      this.cancelPendingSource();
      throw error;
    }
    this.pendingFile = null;
    this.releaseActiveSource();
    this.activeFile = candidate;
    this.source = 'file';
    this.trackName = demoTrack ? demoTrack.title : file.name.replace(/\.[^/.]+$/, '');
    this.playing = actuallyPlaying;
    if (demoTrack) {
      this.setBpm(demoTrack.bpm);
      this.setBeatGrid({ bpm: demoTrack.bpm, offsetMs: demoTrack.firstDownbeatMs, source: 'manual' });
    }
    if (actuallyPlaying) this.ensureContext();
    if (this.liveBpmEnabled) void this.attachLiveBpm();
    return this.trackName;
  }

  public setBeatGrid(grid: BeatGrid | null) {
    this.beatGrid = grid;
    this.lastGridBeatIndex = null;
  }

  public getBeatGrid(): BeatGrid | null {
    return this.beatGrid;
  }

  public getPlaybackMs(): number {
    if (this.source === 'file' && this.activeFile) {
      return this.activeFile.element.currentTime * 1000;
    }
    return 0;
  }

  private detachLiveBpm() {
    this.liveBpmGen++;
    if (this.liveBpmSourceNode && this.liveBpmHandle) {
      try { this.liveBpmSourceNode.disconnect(this.liveBpmHandle.input); } catch { /* ignore */ }
    }
    this.liveBpmSourceNode = null;
    if (this.liveBpmHandle) {
      this.liveBpmHandle.stop();
      this.liveBpmHandle = null;
    }
  }

  private async attachLiveBpm() {
    this.detachLiveBpm();
    if (!this.liveBpmEnabled || !this.liveBpmCallbacks || !this.ctx) return;
    const sourceNode = this.source === 'mic' ? this.micSrc : this.masterGain;
    if (!sourceNode) return;
    const liveTrack = this.source === 'mic' ? this.micStream?.getAudioTracks()[0] : undefined;
    const gen = ++this.liveBpmGen;
    const handle = await createLiveBpmHandle(this.ctx, {
      liveTrack,
      onReading: this.liveBpmCallbacks.onReading,
      onUnavailable: this.liveBpmCallbacks.onUnavailable,
    });
    if (!handle) return;
    if (gen !== this.liveBpmGen || !this.liveBpmEnabled || !this.ctx) {
      handle.stop();
      return;
    }
    try {
      sourceNode.connect(handle.input);
      this.liveBpmSourceNode = sourceNode;
      this.liveBpmHandle = handle;
    } catch {
      handle.stop();
      this.liveBpmCallbacks.onUnavailable('Could not connect audio source to live BPM analyzer.');
    }
  }

  public setLiveBpmAnalysis(
    enabled: boolean,
    callbacks?: {
      onReading: (bpm: number, locked: boolean) => void;
      onUnavailable: (reason: string) => void;
    },
  ) {
    this.liveBpmEnabled = enabled;
    this.liveBpmCallbacks = callbacks ?? null;
    if (!enabled) {
      this.detachLiveBpm();
      return;
    }
    if (this.ctx && (this.source === 'mic' || this.source === 'file' || this.source === 'synth')) {
      void this.attachLiveBpm();
    }
  }

  public trackDuration() {
    const duration = this.activeFile?.element.duration;
    return duration !== undefined && Number.isFinite(duration) ? duration : 0;
  }

  public seekTrack(seconds: number) {
    if (this.activeFile && Number.isFinite(seconds)) {
      this.activeFile.element.currentTime = Math.max(0, Math.min(seconds, this.trackDuration()));
      this.lastGridBeatIndex = null;
    }
  }

  public timelineMusic(): MusicRef {
    if (this.source === 'file' && this.activeFile) {
      return { kind: 'file', name: this.activeFile.file.name, playing: this.playing,
        offsetSeconds: this.activeFile.element.currentTime };
    }
    if (this.source === 'synth') return { kind: 'demo', name: this.trackName, playing: this.playing, demoStep: this.currentDemoStep() };
    if (this.source === 'mic') return { kind: 'live', name: 'Live input', playing: this.playing };
    return { kind: 'none', name: '', playing: false };
  }

  public async restoreTimelineMusic(
    ref: MusicRef,
    file: File | undefined,
    bpm: number,
    lateMs: number,
    demoTrack?: DemoTrackMap,
  ) {
    this.setBpm(bpm);
    const late = Number.isFinite(lateMs) ? Math.max(0, lateMs) / 1000 : 0;
    if (ref.kind === 'live' || ref.kind === 'none') {
      if (ref.kind === 'live' && ref.playing && this.source === 'mic') this.cancelPendingSource();
      else this.stopAll();
      return;
    }
    if (ref.kind === 'demo') {
      const step = Math.min(DEMO_TOTAL_STEPS, (ref.demoStep ?? 0) + (ref.playing ? late * this.bpm / 15 : 0));
      if (this.source === 'synth' && this.playing === ref.playing && Math.abs(this.currentDemoStep() - step) < 0.15) {
        this.cancelPendingSource();
        return;
      }
      this.restoreDemo(step, this.bpm, ref.playing);
      return;
    }
    const active = this.activeFile;
    const selected = file ?? (active?.file.name === ref.name ? active.file : undefined);
    if (!selected) {
      this.stopAll();
      throw new Error(`Relink “${ref.name}” to play the recorded music.`);
    }
    const started = performance.now();
    const position = () => (ref.offsetSeconds ?? 0) + (ref.playing ? late + (performance.now() - started) / 1000 : 0);
    if (active?.file !== selected || active?.demoTrack !== demoTrack) {
      this.stopAll();
      await this.openAudioFile(selected, ref.playing, position, demoTrack ? { demoTrack } : undefined);
      return;
    }
    const generation = this.cancelPendingSource();
    const element = active.element;
    seekLoop(element, position());
    this.playing = ref.playing;
    if (!ref.playing) element.pause();
    else {
      this.ensureContext();
      if (element.paused) {
        try {
          await element.play();
          if (generation === this.sourceGeneration) seekLoop(element, position());
        } catch (error) {
          if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
          this.playing = false;
          throw error;
        }
      }
    }
  }

  public togglePlayPause(): boolean {
    if (this.source === 'none') {
      this.startDemoSynth(this.bpm);
      return true;
    }
    if (this.source === 'synth') {
      if (this.playing) {
        this.heldStep = this.currentDemoStep();
        this.playing = false;
        this.beatPulse = 0;
        this.stopPump();
        // Suspending keeps sustained chords, delay tails and pre-scheduled attacks in place.
        const suspended = this.ctx!.suspend().catch(() => {});
        this.pendingSuspend = suspended;
        void suspended.then(() => {
          if (this.pendingSuspend === suspended) this.pendingSuspend = null;
        });
      } else if (this.heldStep >= DEMO_TOTAL_STEPS) {
        this.startDemoSynth(this.bpm);
      } else if (!this.score) {
        this.restoreDemo(this.heldStep, this.bpm, true);
      } else {
        this.playing = true;
        this.ensureContext();
        this.startPump();
      }
      return this.playing;
    }
    if (this.source === 'file' && this.activeFile) {
      const { element, demoTrack } = this.activeFile;
      if (this.playing) {
        element.pause();
        this.playing = false;
      } else {
        if (element.ended || (demoTrack && demoTrackStepAtMs(demoTrack, element.currentTime * 1000) >= demoTrack.timeline.totalSteps)) {
          element.currentTime = 0;
          this.lastGridBeatIndex = null;
        }
        this.ensureContext();
        this.playing = true;
        void element.play().catch(() => {
          if (this.activeFile?.element === element && element.paused) this.playing = false;
        });
      }
      return this.playing;
    }
    if (this.source === 'mic') {
      this.stopAll();
      return false;
    }
    return this.playing;
  }

  public async startMicInput(): Promise<void> {
    const generation = this.cancelPendingSource();
    const ctx = this.ensureContext(this.source !== 'synth' || this.playing);
    let stream: MediaStream | undefined;
    let node: MediaStreamAudioSourceNode | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      if (!stream.getAudioTracks().some(track => track.readyState === 'live')) {
        throw new DOMException('Microphone disconnected', 'NotReadableError');
      }
      node = ctx.createMediaStreamSource(stream);
      node.connect(this.analyser!);
    } catch (error) {
      node?.disconnect();
      stream?.getTracks().forEach(track => track.stop());
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      throw error;
    }
    this.releaseActiveSource();
    this.micStream = stream;
    this.micSrc = node;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (stream === this.micStream) this.releaseActiveSource();
      }, { once: true });
    }
    this.source = 'mic';
    this.trackName = 'Live Mic / Line-In';
    this.playing = true;
    this.ensureContext();
    if (this.liveBpmEnabled) void this.attachLiveBpm();
  }

  public getStatus() {
    const activeTrack = this.source === 'file' ? this.activeFile?.demoTrack : undefined;
    const demoTrackFinished = !!activeTrack && !this.playing && !!this.activeFile && (
      this.activeFile.element.ended ||
      demoTrackStepAtMs(activeTrack, this.activeFile.element.currentTime * 1000) >= activeTrack.timeline.totalSteps
    );
    return {
      demoFinished: this.source === 'synth' && !this.playing && this.heldStep >= DEMO_TOTAL_STEPS,
      demoTrackActive: !!activeTrack,
      demoTrackFinished,
      playing: this.playing,
      source: this.source,
      trackName: this.trackName,
      volume: this.volume,
    };
  }

  public dispose() {
    this.liveBpmEnabled = false;
    this.detachLiveBpm();
    this.stopAll();
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
