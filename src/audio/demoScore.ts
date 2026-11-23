import { getDemoPosition } from '../data/demoShow';

// Open voicings leave the bottom octave to the kick and bass.
const D_MINOR = { bass: 38, notes: [53, 57, 62, 64] };
const B_FLAT = { bass: 34, notes: [53, 57, 58, 62] };
const F_MAJOR = { bass: 41, notes: [53, 57, 60, 67] };
const C_MAJOR = { bass: 36, notes: [52, 55, 62, 64] };
const A_SEVENTH = { bass: 33, notes: [52, 55, 61, 64] };
const CHANGES = [D_MINOR, B_FLAT, F_MAJOR, C_MAJOR];
const BREAK_CHANGES = [B_FLAT, F_MAJOR, C_MAJOR, D_MINOR];
const REBUILD_CHANGES = [B_FLAT, C_MAJOR, D_MINOR, A_SEVENTH];

// The pickup and the falling answer return throughout the set.
// Each entry gives the sixteenth, MIDI pitch and length in sixteenths.
type Note = readonly [number, number, number];
const HOOK: readonly (readonly Note[])[] = [
  [[0, 74, 3.5], [5, 69, 1.5], [7, 72, 1], [8, 74, 3], [12, 77, 3]],
  [[0, 77, 4.5], [6, 74, 2.5], [10, 72, 1.5], [12, 69, 3]],
  [[0, 69, 3], [4, 72, 2], [7, 77, 4], [13, 79, 2]],
  [[0, 76, 4], [6, 74, 2], [10, 72, 3.5], [15, 69, 1]],
];

const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
type Voice = 'pad' | 'keys' | 'lead' | 'bass';

export class DemoScore {
  private readonly mix: DynamicsCompressorNode;
  private readonly echo: DelayNode;
  private readonly repeat: GainNode;
  private readonly echoTone: BiquadFilterNode;
  private readonly echoPan: StereoPannerNode;
  private readonly noise: AudioBuffer;
  private readonly voices = new Map<AudioScheduledSourceNode, () => void>();
  private lastSubdivision = 0;
  private disposed = false;

  constructor(private readonly ctx: AudioContext, output: AudioNode) {
    this.mix = ctx.createDynamicsCompressor();
    this.mix.threshold.value = -12;
    this.mix.knee.value = 10;
    this.mix.ratio.value = 4;
    this.mix.attack.value = 0.004;
    this.mix.release.value = 0.13;
    this.mix.connect(output);

    // A single dark dotted-eighth echo ties the quiet signature to the full hook.
    this.echo = ctx.createDelay(1);
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = 2700;
    this.repeat = ctx.createGain();
    this.repeat.gain.value = 0.23;
    this.echoPan = ctx.createStereoPanner();
    this.echoPan.pan.value = 0.41;
    this.echo.connect(this.echoTone).connect(this.repeat);
    this.repeat.connect(this.echo);
    this.repeat.connect(this.echoPan).connect(this.mix);

    this.noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 1.37), ctx.sampleRate);
    const samples = this.noise.getChannelData(0);
    let seed = 14993;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = seed / 2147483648 - 1;
    }
  }

  private play(source: OscillatorNode | AudioBufferSourceNode, at: number, duration: number, nodes: AudioNode[]) {
    const release = () => {
      source.onended = null;
      source.disconnect();
      for (const node of nodes) node.disconnect();
      this.voices.delete(source);
    };
    this.voices.set(source, release);
    source.onended = release;
    if (source instanceof AudioBufferSourceNode) source.start(at, (at * 0.73) % this.noise.duration);
    else source.start(at);
    source.stop(at + duration);
  }

  private note(voice: Voice, midi: number, at: number, length: number,
    level: number, cutoff: number, pan = 0) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const stereo = this.ctx.createStereoPanner();
    const pad = voice === 'pad';
    const pluck = voice === 'keys';
    const bass = voice === 'bass';
    const attack = Math.min(length * 0.25, pad ? 0.27 : pluck ? 0.008 : 0.012);
    osc.type = pad ? 'sawtooth' : pluck ? 'triangle' : bass ? 'triangle' : 'sawtooth';
    osc.frequency.value = frequency(midi);
    osc.detune.value = pad ? pan * 9 : 0;
    filter.type = 'lowpass';
    filter.Q.value = pad ? 0.55 : 1.05;
    filter.frequency.setValueAtTime(cutoff, at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(120, cutoff * (pad ? 0.70 : 0.37)), at + length);
    stereo.pan.value = pan;
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(level, at + attack);
    amp.gain.exponentialRampToValueAtTime(level * (pad ? 0.79 : pluck ? 0.14 : 0.56), at + length * 0.77);
    amp.gain.linearRampToValueAtTime(0, at + length);
    osc.connect(filter).connect(amp).connect(stereo).connect(this.mix);
    if (pluck || voice === 'lead') stereo.connect(this.echo);
    this.play(osc, at, length + 0.005, [filter, amp, stereo]);
  }

  private drum(at: number, startHz: number, endHz: number, length: number, level: number) {
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.frequency.setValueAtTime(startHz, at);
    osc.frequency.exponentialRampToValueAtTime(endHz, at + length * 0.52);
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(level, at + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0002, at + length);
    osc.connect(amp).connect(this.mix);
    this.play(osc, at, length + 0.003, [amp]);
  }

  private air(at: number, length: number, level: number, startHz: number, endHz: number,
    kind: BiquadFilterType, swell = false, pan = 0) {
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const amp = this.ctx.createGain();
    const stereo = this.ctx.createStereoPanner();
    source.buffer = this.noise;
    source.loop = true;
    filter.type = kind;
    filter.Q.value = swell ? 1.1 : 0.67;
    filter.frequency.setValueAtTime(startHz, at);
    filter.frequency.exponentialRampToValueAtTime(endHz, at + length);
    amp.gain.setValueAtTime(0.0001, at);
    if (swell) amp.gain.exponentialRampToValueAtTime(level, at + length * 0.95);
    else amp.gain.linearRampToValueAtTime(level, at + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
    stereo.pan.value = pan;
    source.connect(filter).connect(amp).connect(stereo).connect(this.mix);
    this.play(source, at, length + 0.003, [filter, amp, stereo]);
  }

  private walkOn(bar: number, step: number, at: number, unit: number) {
    // Two empty bars give the blackout a downbeat of its own.
    if (bar < 2) return;

    const measure = bar % 4;
    const hook = HOOK[measure].find(([onset]) => onset === step);
    if (hook && (step === 0 || bar >= 4 || (bar === 3 && step === 10))) {
      this.note('keys', hook[1], at, (hook[2] + 2) * unit,
        0.034 + 0.016 * (bar - 2), 1200 + 260 * (bar - 2), -0.18);
    }

    // The first key rings alone. Harmony fills in one voice at a time.
    if (step === 0 && bar >= 3) {
      const notes = CHANGES[measure].notes.slice(0, bar - 2);
      notes.forEach((midi, i) => {
        this.note('pad', midi, at + i * 0.014, 14.9 * unit,
          0.012 + 0.006 * (bar - 3), 640 + 120 * (bar - 3), [-0.56, 0.28, -0.19, 0.59][i]);
      });
    }
    if (bar >= 6 && (step === 0 || (bar === 7 && step === 8))) {
      this.drum(at, 100, 48, 0.22, bar === 6 ? 0.19 : 0.28);
    }
    if (bar === 7 && (step === 4 || step === 12)) {
      this.air(at, 0.065, 0.08, 2500, 1400, 'bandpass', false, -0.13);
    }
  }

  schedule(step: number, at: number, unit: number) {
    if (this.disposed) return;
    const { sectionId, barInSection: bar, sectionBars, stepInBar: s, sectionProgress } = getDemoPosition(step);
    if (unit !== this.lastSubdivision) {
      this.echo.delayTime.setTargetAtTime(3 * unit, at, 0.015);
      this.lastSubdivision = unit;
    }
    if (sectionId === 'intro') {
      this.walkOn(bar, s, at, unit);
      return;
    }
    const breakdown = sectionId === 'breakdown';
    const outro = sectionId === 'outro';
    const rebuild = sectionId === 'rebuild';
    const build = sectionId === 'build' || rebuild;
    const peak = sectionId === 'drop' || sectionId === 'finale';
    const finale = sectionId === 'finale';
    const lastBar = bar === sectionBars - 1;
    const measure = bar % 4;
    const chord = outro ? [B_FLAT, A_SEVENTH, D_MINOR, D_MINOR][bar] :
      build && lastBar ? A_SEVENTH : (breakdown ? BREAK_CHANGES : rebuild ? REBUILD_CHANGES : CHANGES)[measure];

    // Pull the band out before both downbeats. Let the resolving chord ring through curtain.
    if ((build && lastBar && s >= 12) || (outro && bar >= 2 && (bar !== 2 || s !== 0))) return;

    if (s === 0) {
      const hold = outro && bar === 2 ? 30 : build && lastBar ? 10 : peak ? 6.3 : 14.9;
      chord.notes.forEach((midi, i) => {
        const spread = [-0.56, 0.28, -0.19, 0.59][i];
        this.note('pad', midi, at + i * 0.014, hold * unit,
          peak ? 0.077 : 0.052,
          breakdown ? 1400 : build ? 1200 + sectionProgress * 2200 : 2400, spread);
      });
      if (outro && bar === 2) {
        this.note('bass', 38, at, 23 * unit, 0.18, 590);
        this.note('keys', 74, at, 24 * unit, 0.14, 2600, -0.24);
      }
      if (peak && (bar === 0 || (finale && bar === 8))) {
        this.air(at, 9 * unit, 0.32, 6900, 1600, 'highpass', false, 0.30);
      }
    }

    if (breakdown || outro) {
      const phrase = HOOK[measure].find(([onset]) => onset === s);
      if (phrase && ((breakdown && (s === 0 || s >= 8 || bar >= 4)) || (outro && bar < 2 && s === 0))) {
        this.note('keys', phrase[1] - (breakdown ? 12 : 0), at, (phrase[2] + 2) * unit,
          0.17, breakdown ? 2100 : 3000, -0.18);
      }
      if (breakdown && bar >= 6 && (s === 4 || s === 12)) {
        this.air(at, 0.065, 0.095, 2500, 1400, 'bandpass', false, -0.13);
      }
      if (outro && bar === 0 && s === 0) this.drum(at, 116, 45, 0.28, 0.51);
      return;
    }

    const energy = peak ? 1 : build ? 0.68 + sectionProgress * 0.3 : 0.68;
    const halfTime = (rebuild && bar < 4) || (sectionId === 'groove' && bar < 2);
    if (s % (halfTime ? 8 : 4) === 0) {
      this.drum(at, 149, 44, Math.min(0.26, unit * 2.1), 0.79 * energy);
    }
    if (s === 4 || s === 12) {
      this.drum(at, 214, 158, 0.091, 0.19 * energy);
      this.air(at + 0.006, 0.16, 0.44 * energy, 2700, 1350, 'bandpass');
    }
    if (s % 4 === 2 || (peak && s % 4 === 3 && measure % 2 === 1)) {
      const ghost = s % 2 === 1;
      this.air(at + (ghost ? unit * 0.09 : 0), ghost ? 0.045 : 0.105,
        (ghost ? 0.068 : 0.18) * energy, 7500, 5850, 'highpass', false, ghost ? -0.26 : 0.24);
    }
    if (build && bar >= 4) {
      const subdivision = bar < 6 ? 4 : bar < 7 ? 2 : 1;
      if (s % subdivision === 0 && s !== 4 && s !== 12) {
        this.air(at, unit * 0.85, (0.16 + sectionProgress * 0.14) * (s % 2 ? 0.67 : 1),
          1800 + sectionProgress * 2100, 1400, 'bandpass');
      }
      if (bar === 6 && s === 0) this.air(at, unit * 27.5, 0.35, 350, 7900, 'bandpass', true, 0.12);
    }
    if (rebuild && bar < 4 && s === 11) this.drum(at, 137, 88, 0.16, 0.20);
    if (peak && measure === 3 && s >= 12 && s % 2 === 0) {
      this.drum(at, s === 12 ? 210 : 145, s === 12 ? 112 : 82, 0.17, 0.28);
    }

    const bassPattern = peak ? [0, 3, 6, 8, 10, 14] : halfTime ? [0, 8, 14] : [0, 6, 8, 14];
    if (bassPattern.includes(s)) {
      const octave = s === 14 || (s === 6 && measure === 2) ? 12 : 0;
      this.note('bass', chord.bass + octave, at + (s % 4 === 0 ? 0.022 : 0),
        unit * (s % 4 === 0 ? 2.65 : 1.65), 0.34 * energy, peak ? 1250 : 680);
    }

    const hook = HOOK[measure].find(([onset]) => onset === s);
    if (hook && (peak || (build ? s === 0 || bar >= 4 : bar >= 2 && (s === 0 || s >= 10)))) {
      const register = build && bar < 4 ? -12 : 0;
      const length = Math.min(hook[2], build && lastBar ? 11.6 - s : 16 - s);
      this.note(peak ? 'lead' : 'keys', hook[1] + register, at, length * unit,
        peak ? 0.17 : 0.14, peak ? 4300 : 1900 + sectionProgress * 2400, -0.11);
      if (finale && bar >= 4 && hook[2] >= 3) {
        this.note('keys', hook[1] + (bar >= 8 ? 12 : 0), at + 0.012, length * unit,
          0.095, 4800, 0.36);
      }
    }
    if ((build && bar >= 2 || finale) && s % 2 === 0 && !(lastBar && s >= 12)) {
      const arp = chord.notes[[0, 2, 1, 3, 1, 2, 3, 2][s / 2]];
      this.note('keys', arp + 12, at, unit * 0.91, 0.065 + sectionProgress * 0.025,
        1600 + 2500 * sectionProgress, s % 4 ? -0.38 : 0.35);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mix.disconnect();
    for (const [source, release] of this.voices) {
      source.stop();
      release();
    }
    for (const node of [this.echo, this.echoTone, this.repeat, this.echoPan]) node.disconnect();
  }
}
