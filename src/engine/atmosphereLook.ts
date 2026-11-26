const EPSILON = 1e-4;

export const ATMOSPHERE_TIME_CONSTANT_SEC = 2;
export const ATMOSPHERE_MAX_MIX = 0.075;
export const ATMOSPHERE_MAX_LUMINANCE = 0.025;
export const ATMOSPHERE_MAX_CHANNEL = 0.06;

export type AtmosphereSuppressedReason =
  | 'disabled'
  | 'true-colour'
  | 'reduced-effects'
  | 'blackout'
  | 'master-dimmer'
  | 'zero-haze'
  | 'no-active-fixtures'
  | null;

export interface AtmospherePolicy {
  requested: boolean;
  active: boolean;
  suppressedReason: Exclude<AtmosphereSuppressedReason, 'blackout' | 'master-dimmer' | 'zero-haze' | 'no-active-fixtures'>;
}

export interface AtmosphereLookStats {
  requested: boolean;
  active: boolean;
  suppressedReason: AtmosphereSuppressedReason;
  sumWeight: number;
  palette: [number, number, number];
  target: [number, number, number];
  current: [number, number, number];
  applied: [number, number, number];
  timeConstantSec: number;
  extraGpuBytes: 0;
  addedDraws: 0;
  addedPasses: 0;
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const luminance709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** CPU-only, allocation-free per-frame controller for the existing scene FogExp2 colour. */
export class AtmosphereLookController {
  private policy: AtmospherePolicy = { requested: false, active: false, suppressedReason: 'disabled' };
  private sumR = 0;
  private sumG = 0;
  private sumB = 0;
  private sumWeight = 0;
  private paletteR = 0;
  private paletteG = 0;
  private paletteB = 0;
  private targetR: number;
  private targetG: number;
  private targetB: number;
  private currentR: number;
  private currentG: number;
  private currentB: number;
  private appliedR: number;
  private appliedG: number;
  private appliedB: number;
  private suppressedReason: AtmosphereSuppressedReason = 'disabled';

  constructor(
    private readonly baseR: number,
    private readonly baseG: number,
    private readonly baseB: number,
  ) {
    this.targetR = this.currentR = this.appliedR = baseR;
    this.targetG = this.currentG = this.appliedG = baseG;
    this.targetB = this.currentB = this.appliedB = baseB;
  }

  setPolicy(policy: AtmospherePolicy) {
    this.policy = policy;
  }

  beginFrame() {
    this.sumR = 0;
    this.sumG = 0;
    this.sumB = 0;
    this.sumWeight = 0;
  }

  addFixture(r: number, g: number, b: number, ungatedDimmer: number, master: number) {
    const weight = clamp(ungatedDimmer, 0, 1.6) * clamp(master, 0, 1);
    if (weight <= EPSILON) return;
    this.sumR += clamp(r, 0, 1) * weight;
    this.sumG += clamp(g, 0, 1) * weight;
    this.sumB += clamp(b, 0, 1) * weight;
    this.sumWeight += weight;
  }

  step(dt: number, hazeInput: number, masterInput: number, roomGainInput: number, blackout: boolean, darkOpening: boolean) {
    const roomGain = clamp(roomGainInput, 0, 1);
    const master = clamp(masterInput, 0, 1);
    const haze = clamp(hazeInput, 0, 1);
    this.paletteR = this.sumWeight > EPSILON ? this.sumR / this.sumWeight : 0;
    this.paletteG = this.sumWeight > EPSILON ? this.sumG / this.sumWeight : 0;
    this.paletteB = this.sumWeight > EPSILON ? this.sumB / this.sumWeight : 0;

    this.suppressedReason = this.policy.suppressedReason;
    if (!this.suppressedReason && (blackout || darkOpening)) this.suppressedReason = 'blackout';
    if (!this.suppressedReason && master <= EPSILON) this.suppressedReason = 'master-dimmer';
    if (!this.suppressedReason && haze <= EPSILON) this.suppressedReason = 'zero-haze';
    if (!this.suppressedReason && this.sumWeight <= EPSILON) this.suppressedReason = 'no-active-fixtures';

    if (this.suppressedReason) {
      this.targetR = this.currentR = this.baseR;
      this.targetG = this.currentG = this.baseG;
      this.targetB = this.currentB = this.baseB;
    } else {
      const activity = clamp(this.sumWeight / 2, 0, 1);
      const mix = ATMOSPHERE_MAX_MIX * haze * activity;
      let r = this.baseR + (this.paletteR - this.baseR) * mix;
      let g = this.baseG + (this.paletteG - this.baseG) * mix;
      let b = this.baseB + (this.paletteB - this.baseB) * mix;
      const lumaScale = Math.min(1, ATMOSPHERE_MAX_LUMINANCE / Math.max(EPSILON, luminance709(r, g, b)));
      r *= lumaScale;
      g *= lumaScale;
      b *= lumaScale;
      const channelScale = Math.min(1, ATMOSPHERE_MAX_CHANNEL / Math.max(EPSILON, r, g, b));
      this.targetR = r * channelScale;
      this.targetG = g * channelScale;
      this.targetB = b * channelScale;
      const alpha = 1 - Math.exp(-clamp(dt, 0, 0.25) / ATMOSPHERE_TIME_CONSTANT_SEC);
      this.currentR += (this.targetR - this.currentR) * alpha;
      this.currentG += (this.targetG - this.currentG) * alpha;
      this.currentB += (this.targetB - this.currentB) * alpha;
    }

    this.appliedR = this.currentR * roomGain;
    this.appliedG = this.currentG * roomGain;
    this.appliedB = this.currentB * roomGain;
  }

  getAppliedR() { return this.appliedR; }
  getAppliedG() { return this.appliedG; }
  getAppliedB() { return this.appliedB; }

  getStats(): AtmosphereLookStats {
    return {
      requested: this.policy.requested,
      active: this.policy.active && this.suppressedReason === null,
      suppressedReason: this.suppressedReason,
      sumWeight: this.sumWeight,
      palette: [this.paletteR, this.paletteG, this.paletteB],
      target: [this.targetR, this.targetG, this.targetB],
      current: [this.currentR, this.currentG, this.currentB],
      applied: [this.appliedR, this.appliedG, this.appliedB],
      timeConstantSec: ATMOSPHERE_TIME_CONSTANT_SEC,
      extraGpuBytes: 0,
      addedDraws: 0,
      addedPasses: 0,
    };
  }
}
