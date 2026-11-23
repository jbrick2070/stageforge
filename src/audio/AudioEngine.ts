import type { AudioMetrics, MusicRef } from '../types/show';
import { DEMO_TOTAL_STEPS, getDemoPosition } from '../data/demoShow';
import { DemoScore } from './demoScore';

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

  public getMetrics(dt: number): AudioMetrics {
    this.beatPulse = Math.max(0, this.beatPulse - dt * 3.8);

    const audibleStep = this.source === 'synth' ? this.currentDemoStep() : undefined;
    if (audibleStep === DEMO_TOTAL_STEPS && this.playing) this.finishDemo();
    const demo = audibleStep === undefined ? undefined : getDemoPosition(audibleStep);

    if (!this.analyser || !this.playing) {
      this.spectrum32.fill(0);
      return {
        playing: false,
        demo,
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
    this.playing = false;
    this.source = 'none';
    this.trackName = 'No Audio Loaded';
    this.bassHistory.length = 0;
    this.lastBeatTime = 0;
    this.beatPulse = 0;
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

  public async loadAudioFile(file: File): Promise<string> {
    return this.openAudioFile(file, true);
  }

  private async openAudioFile(file: File, playing: boolean, position?: () => number): Promise<string> {
    const generation = this.cancelPendingSource();
    const ctx = this.ensureContext(playing && (this.source !== 'synth' || this.playing));
    const element = new Audio();
    element.loop = true;
    element.preload = 'auto';
    const node = ctx.createMediaElementSource(element);
    const candidate = { file, element, node, url: URL.createObjectURL(file), abort: new AbortController() };
    this.pendingFile = candidate;
    try {
      // The disconnected source stays silent until the browser accepts the file.
      element.src = candidate.url;
      if (position) {
        await fileMetadata(candidate);
        if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
        seekLoop(element, position());
      }
      if (playing) await element.play();
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
    this.trackName = file.name.replace(/\.[^/.]+$/, '');
    this.playing = playing;
    if (playing) this.ensureContext();
    return this.trackName;
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

  public async restoreTimelineMusic(ref: MusicRef, file: File | undefined, bpm: number, lateMs: number) {
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
    if (active?.file !== selected) {
      this.stopAll();
      await this.openAudioFile(selected, ref.playing, position);
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
      const { element } = this.activeFile;
      if (this.playing) {
        element.pause();
        this.playing = false;
      } else {
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  }

  public getStatus() {
    return {
      demoFinished: this.source === 'synth' && !this.playing && this.heldStep >= DEMO_TOTAL_STEPS,
      playing: this.playing,
      source: this.source,
      trackName: this.trackName,
      volume: this.volume,
    };
  }

  public dispose() {
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
