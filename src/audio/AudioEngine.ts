import { AudioMetrics } from '../types/show';

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

  // Built-in concert synth sequencer
  private synthTimer: number | null = null;
  private synthStep = 0;
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

    if (!this.analyser || !this.playing) {
      // Gentle simulated clock beat when no live audio is playing so beat-reactive effects can still breathe if desired
      this.spectrum32.fill(0);
      return {
        playing: false,
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

    // Adaptive beat onset detector
    this.bassHistory.push(bass);
    if (this.bassHistory.length > 42) this.bassHistory.shift();
    const avgBass =
      this.bassHistory.reduce((a, b) => a + b, 0) / Math.max(1, this.bassHistory.length);

    const now = performance.now();
    let beat = false;
    if (bass > 0.36 && bass > avgBass * 1.24 && now - this.lastBeatTime > 260) {
      beat = true;
      this.lastBeatTime = now;
      this.beatPulse = 1.0;
    }

    const drop = bass > 0.72 && energy > 0.52;

    return {
      playing: this.playing,
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
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
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
    this.bpm = Math.max(70, Math.min(180, bpm));
    if (this.source === 'synth' && this.playing) {
      this.restartSynthClock();
    }
  }

  public stopAll() {
    this.sourceGeneration++;
    this.playing = false;
    this.source = 'none';
    this.trackName = 'No Audio Loaded';
    this.bassHistory.length = 0;
    this.lastBeatTime = 0;
    this.beatPulse = 0;
    if (this.synthTimer !== null) {
      window.clearInterval(this.synthTimer);
      this.synthTimer = null;
    }
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

  public startDemoSynth(bpm = 128) {
    this.stopAll();
    this.ensureContext();
    this.bpm = bpm;
    this.source = 'synth';
    this.trackName = 'Arena Anthem (Live Synth)';
    this.playing = true;
    this.synthStep = 0;
    this.restartSynthClock();
  }

  private restartSynthClock() {
    if (this.synthTimer !== null) window.clearInterval(this.synthTimer);
    const sixteenthMs = (60 / this.bpm / 4) * 1000;
    this.playSynthStep();
    this.synthTimer = window.setInterval(() => {
      if (!this.playing || this.source !== 'synth') return;
      this.playSynthStep();
    }, sixteenthMs);
  }

  private playSynthStep() {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const step = this.synthStep % 64;
    const bar = Math.floor(step / 16); // 0..3
    const beatStep = step % 16;

    // 4-on-the-floor arena kick
    if (beatStep % 4 === 0) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(145, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
      gain.gain.setValueAtTime(0.95, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.26);
    }

    // Offbeat open hi-hat
    if (beatStep % 4 === 2) {
      const bufSize = Math.floor(this.ctx.sampleRate * 0.08);
      const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.35));
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6800;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      noise.connect(hp);
      hp.connect(gain);
      gain.connect(this.masterGain);
      noise.start(t);
    }

    // Clap on 4 & 12
    if (beatStep === 4 || beatStep === 12) {
      const bufSize = Math.floor(this.ctx.sampleRate * 0.13);
      const buffer = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.25));
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400;
      bp.Q.value = 1.2;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.32, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      noise.connect(bp);
      bp.connect(gain);
      gain.connect(this.masterGain);
      noise.start(t);
    }

    // Rolling festival bassline (F minor / D# / C# / C progression)
    const bassRoots = [43.65, 38.89, 34.65, 32.70]; // F1, Eb1, Db1, C1
    const root = bassRoots[bar];
    if (beatStep % 2 === 1 || beatStep % 4 === 2) {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(root * (beatStep % 4 === 2 ? 2 : 1), t);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(480, t);
      filter.frequency.exponentialRampToValueAtTime(140, t + 0.12);
      filter.Q.value = 4.5;
      gain.gain.setValueAtTime(0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.16);
    }

    // Euphoric laser-trance arp lead
    const arpNotes = [
      [349.23, 415.30, 523.25, 622.25, 523.25, 415.30, 698.46, 523.25],
      [311.13, 392.00, 466.16, 622.25, 466.16, 392.00, 622.25, 466.16],
      [277.18, 349.23, 415.30, 554.37, 415.30, 349.23, 554.37, 415.30],
      [261.63, 329.63, 392.00, 523.25, 659.25, 523.25, 392.00, 329.63],
    ];
    if (beatStep % 2 === 0) {
      const note = arpNotes[bar][(beatStep / 2) % 8];
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';
      osc1.frequency.setValueAtTime(note, t);
      osc2.frequency.setValueAtTime(note * 1.005, t); // supersaw detune

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2400 + (bar === 3 ? 1600 : 0), t);
      filter.frequency.exponentialRampToValueAtTime(520, t + 0.18);

      gain.gain.setValueAtTime(0.11, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.19);

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);

      osc1.start(t);
      osc2.start(t);
      osc1.stop(t + 0.2);
      osc2.stop(t + 0.2);
    }

    this.synthStep++;
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
        this.playing = false;
        if (this.synthTimer !== null) {
          window.clearInterval(this.synthTimer);
          this.synthTimer = null;
        }
      } else {
        this.ensureContext();
        this.playing = true;
        this.restartSynthClock();
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
