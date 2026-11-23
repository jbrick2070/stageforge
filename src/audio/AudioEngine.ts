import { AudioMetrics } from '../types/show';
import { DEMO_TOTAL_STEPS, getDemoPosition } from '../data/demoShow';
import { DemoScore } from './demoScore';

interface ScheduledStep {
  step: number;
  time: number;
  duration: number;
}

const SCHEDULE_AHEAD = 0.15; // Audio seconds; covers main-thread rendering jitter.
const PUMP_INTERVAL_MS = 25;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(256));

  private audioEl: HTMLAudioElement | null = null;
  private mediaSrc: MediaElementAudioSourceNode | null = null;
  private fileUrl: string | null = null;
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

  private ensureContext(): AudioContext {
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
    if (ctx.state === 'suspended' || this.pendingSuspend) {
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
    this.sourceGeneration++;
    this.playing = false;
    this.source = 'none';
    this.trackName = 'No Audio Loaded';
    this.bassHistory.length = 0;
    this.lastBeatTime = 0;
    this.beatPulse = 0;
    this.releaseScore();
    this.heldStep = 0;
    this.lastDemoBeat = -1;
    if (this.audioEl && this.fileUrl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
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
    this.stopAll();
    const ctx = this.ensureContext();
    this.setBpm(bpm);
    this.source = 'synth';
    this.trackName = 'Arena Anthem';
    this.playing = true;
    this.score = new DemoScore(ctx, this.masterGain!);
    this.nextStep = 0;
    this.nextStepTime = ctx.currentTime + 0.025;
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
    return Math.max(0, Math.min(DEMO_TOTAL_STEPS, event.step + (now - event.time) / event.duration));
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
    this.stopAll();
    const ctx = this.ensureContext();
    const generation = this.sourceGeneration;

    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.loop = true;
      this.audioEl.crossOrigin = 'anonymous';
      this.mediaSrc = ctx.createMediaElementSource(this.audioEl);
      this.mediaSrc.connect(this.masterGain!);
    }

    this.fileUrl = URL.createObjectURL(file);
    this.audioEl.src = this.fileUrl;
    try {
      await this.audioEl.play();
    } catch (error) {
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      this.stopAll();
      throw error;
    }
    if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
    this.source = 'file';
    this.trackName = file.name.replace(/\.[^/.]+$/, '');
    this.playing = true;
    return this.trackName;
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
      } else {
        this.playing = true;
        this.ensureContext();
        this.startPump();
      }
      return this.playing;
    }
    if (this.source === 'file' && this.audioEl) {
      const generation = ++this.sourceGeneration;
      if (this.playing) {
        this.audioEl.pause();
        this.playing = false;
      } else {
        this.ensureContext();
        this.playing = true;
        void this.audioEl.play().catch(() => {
          if (generation === this.sourceGeneration) this.playing = false;
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
    this.stopAll();
    const ctx = this.ensureContext();
    const generation = this.sourceGeneration;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (generation !== this.sourceGeneration) throw new DOMException('Source changed', 'AbortError');
      throw error;
    }
    if (generation !== this.sourceGeneration) {
      stream.getTracks().forEach(track => track.stop());
      throw new DOMException('Source changed', 'AbortError');
    }
    this.micStream = stream;
    try {
      this.micSrc = ctx.createMediaStreamSource(stream);
      this.micSrc.connect(this.analyser!);
    } catch (error) {
      this.stopAll();
      throw error;
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (stream === this.micStream) this.stopAll();
      }, { once: true });
    }
    this.source = 'mic';
    this.trackName = 'Live Mic / Line-In';
    this.playing = true;
  }

  public getStatus() {
    return {
      playing: this.playing,
      source: this.source,
      trackName: this.trackName,
      volume: this.volume,
    };
  }

  public dispose() {
    this.stopAll();
    this.mediaSrc?.disconnect();
    this.mediaSrc = null;
    this.audioEl = null;
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
