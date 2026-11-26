import * as THREE from 'three';
import type { RenderTier } from './hardwareMaterials';

/**
 * Locally beam-lit smoke & CO2 puffs (Sprint 20).
 *
 * Bounded slice of atmospheric illumination (experimental, default off):
 * - Zero-allocation CPU candidate selection (`8` beams on `low` tier, `16` on `high` tier)
 *   using separate smoke-cloud, cryo-cloud, and active-emitter proximity bounds plus
 *   `1.18x` retention hysteresis and deterministic ascending `fixture.index` tie-breaking.
 * - Evaluates at most `2` (`low` tier) or `4` (`high` tier) beam contributions per puff on CPU,
 *   splitting the strongest narrow beam into a world-space dominant localization lobe and
 *   accumulating remaining contributions as broad multi-beam scatter (zero fragment loops,
 *   zero dynamic uniform-array indexing, WebGL1 & WebGL2 compatible).
 * - Stereo-safe per-eye `modelViewMatrix` transformation in `VAPOR_VERT_LIT` for both the
 *   near-camera depth fade (`[0.35 m, 2.05 m]`) and the unrotated billboard UV lobe offset.
 * - Hue-preserving soft-knee clamp (`<= 0.62`) bounds added local beam radiance per puff
 *   (with distinct scatter gains for glycol smoke vs dense white CO2 cryo).
 * - Stable back-to-front depth ordering within each batch (`spawnSeq` tie-breaker) plus
 *   hysteresis-stabilised centroid ordering between the `smoke` and `cryo` batches.
 */

export const LIT_PUFFS_CANDIDATE_CAP_LOW = 8;
export const LIT_PUFFS_CANDIDATE_CAP_HIGH = 16;
export const LIT_PUFFS_PER_PUFF_LOW = 2;
export const LIT_PUFFS_PER_PUFF_HIGH = 4;
export const LIT_PUFFS_HYSTERESIS_BONUS = 1.18;
export const LIT_PUFFS_SMOOTH_TAU_S = 0.045;
export const LIT_PUFFS_NEAR_FADE_NEAR_M = 0.35;
export const LIT_PUFFS_NEAR_FADE_FAR_M = 2.05;
export const LIT_PUFFS_SMOKE_SCATTER_GAIN = 1.15;
export const LIT_PUFFS_CRYO_SCATTER_GAIN = 1.28;
export const LIT_PUFFS_SMOKE_AMBIENT_SCALE = 0.38;
export const LIT_PUFFS_CRYO_AMBIENT_SCALE = 0.55;
export const LIT_PUFFS_BROAD_SHARE = 0.38;
export const LIT_PUFFS_LOBE_SHARE = 0.62;
export const LIT_PUFFS_ADDED_KNEE = 0.48;
export const LIT_PUFFS_MAX_ADDED_RADIANCE = 0.68;
export const LIT_PUFFS_BATCH_ORDER_DEADBAND_M = 0.30;
/** Optional GPU attribute bytes per puff instance: broadLight (12 B) + lobeLight (12 B) + lobeOffset (16 B) = 40 B. */
export const LIT_PUFFS_BYTES_PER_INSTANCE = (3 + 3 + 4) * 4;
/** Application-buffer ceiling (`100 KiB < 0.1 MiB`). */
export const MAX_LIT_PUFFS_EXTRA_BYTES = 102_400;

const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

export function candidateCapForTier(tier: RenderTier): number {
  return tier === 'high' ? LIT_PUFFS_CANDIDATE_CAP_HIGH : LIT_PUFFS_CANDIDATE_CAP_LOW;
}

export function beamsPerPuffForTier(tier: RenderTier): number {
  return tier === 'high' ? LIT_PUFFS_PER_PUFF_HIGH : LIT_PUFFS_PER_PUFF_LOW;
}

export function litPuffsExtraBufferBytes(smokeCapacity: number, cryoCapacity: number): number {
  const s = Math.max(0, Math.floor(smokeCapacity));
  const c = Math.max(0, Math.floor(cryoCapacity));
  return (s + c) * LIT_PUFFS_BYTES_PER_INSTANCE;
}

export function canAdmitLitPuffsBuffers(smokeCapacity: number, cryoCapacity: number): boolean {
  const bytes = litPuffsExtraBufferBytes(smokeCapacity, cryoCapacity);
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_LIT_PUFFS_EXTRA_BYTES;
}

/**
 * Unchanged base particle vertex shader (`litPuffs === false`) for exact default parity.
 */
export const VAPOR_VERT_BASE = /* glsl */ `
  attribute vec3 center, shape;
  uniform float aspect;
  varying vec2 texUv;
  varying float density;
  void main() {
    texUv = position.xy + 0.5;
    density = shape.z;
    vec2 offset = position.xy * vec2(aspect, 1.0) * shape.x;
    float c = cos(shape.y), s = sin(shape.y);
    vec4 eye = modelViewMatrix * vec4(center, 1.0);
    eye.xy += mat2(c, s, -s, c) * offset;
    gl_Position = projectionMatrix * eye;
  }
`;

/**
 * Unchanged base particle fragment shader (`litPuffs === false`) for exact default parity.
 */
export const VAPOR_FRAG_BASE = /* glsl */ `
  uniform sampler2D vapor;
  uniform vec3 tint;
  varying vec2 texUv;
  varying float density;
  void main() {
    vec4 cloud = texture2D(vapor, texUv);
    float alpha = density * cloud.a;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(tint * cloud.r, alpha);
  }
`;

/**
 * Locally beam-lit particle vertex shader (`litPuffs === true`).
 * Uses Three.js's per-eye `modelViewMatrix` (WebXR stereo-safe) and inverts the billboard's
 * 2D rotation `mat2(c, s, -s, c)` via `mat2(c, -s, s, c)` so the world-space dominant beam
 * offset maps accurately into rotated quad UV coordinates without shader loops.
 */
export const VAPOR_VERT_LIT = /* glsl */ `
  attribute vec3 center, shape;
  attribute vec3 broadLight, lobeLight;
  attribute vec4 lobeOffset;
  uniform float aspect;
  varying vec2 texUv;
  varying float density;
  varying vec3 vBroadLight;
  varying vec3 vLobeLight;
  varying vec3 vLobeUvAndConc;
  void main() {
    texUv = position.xy + 0.5;
    float safeDiam = max(shape.x, 0.05);
    vec2 quadScale = vec2(aspect, 1.0) * safeDiam;
    vec2 offset = position.xy * quadScale;
    float c = cos(shape.y), s = sin(shape.y);
    vec4 eye = modelViewMatrix * vec4(center, 1.0);
    float nearFade = smoothstep(${glslFloat(LIT_PUFFS_NEAR_FADE_NEAR_M)}, ${glslFloat(LIT_PUFFS_NEAR_FADE_FAR_M)}, -eye.z);
    density = shape.z * nearFade;
    vBroadLight = broadLight;
    vLobeLight = lobeLight;
    vec2 lobeEye = (modelViewMatrix * vec4(lobeOffset.xyz, 0.0)).xy;
    vec2 unrot = mat2(c, -s, s, c) * lobeEye;
    vec2 lobeUv = clamp(unrot / quadScale, vec2(-0.65), vec2(0.65));
    vLobeUvAndConc = vec3(lobeUv, max(0.0, lobeOffset.w));
    eye.xy += mat2(c, s, -s, c) * offset;
    gl_Position = projectionMatrix * eye;
  }
`;

/**
 * Locally beam-lit particle fragment shader (`litPuffs === true`).
 * Evaluates broad multi-beam scatter plus one localized dominant shaft lobe in 0 loops,
 * followed by a hue-preserving max-channel soft knee (`<= 0.62` added radiance).
 */
export const VAPOR_FRAG_LIT = /* glsl */ `
  uniform sampler2D vapor;
  uniform vec3 tint;
  varying vec2 texUv;
  varying float density;
  varying vec3 vBroadLight;
  varying vec3 vLobeLight;
  varying vec3 vLobeUvAndConc;
  void main() {
    vec4 cloud = texture2D(vapor, texUv);
    float alpha = density * cloud.a;
    if (alpha < 0.001) discard;
    vec3 baseCol = tint * cloud.r;
    vec2 uvDelta = (texUv - 0.5) - vLobeUvAndConc.xy;
    float lobeMask = exp(-vLobeUvAndConc.z * dot(uvDelta, uvDelta));
    float cloudBody = 0.42 + 0.78 * cloud.r;
    vec3 added = (vBroadLight + vLobeLight * lobeMask) * cloudBody;
    float peak = max(added.r, max(added.g, added.b));
    if (peak > 1e-5) {
      float comp = ${glslFloat(LIT_PUFFS_MAX_ADDED_RADIANCE)} * (peak / (peak + ${glslFloat(LIT_PUFFS_ADDED_KNEE)}));
      added *= min(1.0, comp / peak);
    }
    gl_FragColor = vec4(baseCol + added, alpha);
  }
`;

export interface LitBeamOpticsSample {
  length: number;
  nearRadius: number;
  farRadius: number;
  fluxRatio: number;
}

export interface LitBeamSource {
  index: number;
  lastPreviewIntensity: number;
  lastPreviewR: number;
  lastPreviewG: number;
  lastPreviewB: number;
  lastZoomScale: number;
  lensOffsetY: number;
  optics: LitBeamOpticsSample;
  lastWorldX: number;
  lastWorldY: number;
  lastWorldZ: number;
  lastAimX?: number;
  lastAimY?: number;
  lastAimZ: number;
}

export interface CloudSphereRegion {
  active: boolean;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
}

export interface LitPuffsFrameContext {
  blackout: boolean;
  master: number;
  roomGain: number;
  camPosX: number;
  camPosY: number;
  camPosZ: number;
  camFwdX: number;
  camFwdY: number;
  camFwdZ: number;
}

export interface LitPuffsStats {
  requested: boolean;
  allocated: boolean;
  active: boolean;
  suppressedReason: 'disabled' | 'memory-budget' | null;
  tier: RenderTier;
  candidateCap: number;
  selectedCandidateCount: number;
  beamsPerPuffCap: number;
  litSmokePuffs: number;
  litCryoPuffs: number;
  smokeRenderOrder: number;
  cryoRenderOrder: number;
  extraBufferBytes: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(x) || edge1 === edge0) return 0.5;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Compute a bounding sphere for a puff pool's interpolated world positions (zero allocations).
 */
export function computePoolCloudSphere(
  alive: number,
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  size: Float32Array,
  alpha: number,
  out: CloudSphereRegion,
): CloudSphereRegion {
  if (alive <= 0) {
    out.active = false;
    out.cx = 0;
    out.cy = 2;
    out.cz = 0;
    out.radius = 2.5;
    return out;
  }
  const a = clamp01(alpha);
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < alive; i++) {
    sx += px[i] + (x[i] - px[i]) * a;
    sy += py[i] + (y[i] - py[i]) * a;
    sz += pz[i] + (z[i] - pz[i]) * a;
  }
  const inv = 1 / alive;
  const cx = sx * inv;
  const cy = sy * inv;
  const cz = sz * inv;
  let maxR = 1.8;
  for (let i = 0; i < alive; i++) {
    const ix = px[i] + (x[i] - px[i]) * a - cx;
    const iy = py[i] + (y[i] - py[i]) * a - cy;
    const iz = pz[i] + (z[i] - pz[i]) * a - cz;
    const d = Math.sqrt(ix * ix + iy * iy + iz * iz) + Math.max(0.25, size[i]);
    if (d > maxR) maxR = d;
  }
  out.active = true;
  out.cx = cx;
  out.cy = cy;
  out.cz = cz;
  out.radius = Math.min(22, maxR);
  return out;
}

function raySphereProximity(
  ox: number,
  oy: number,
  oz: number,
  ax: number,
  ay: number,
  az: number,
  len: number,
  rNear: number,
  slope: number,
  cx: number,
  cy: number,
  cz: number,
  regionRadius: number,
): number {
  const vx = cx - ox;
  const vy = cy - oy;
  const vz = cz - oz;
  const t = clamp(vx * ax + vy * ay + vz * az, 0, len);
  const dx = ox + ax * t - cx;
  const dy = oy + ay * t - cy;
  const dz = oz + az * t - cz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const rBeam = Math.max(0.05, rNear + slope * t);
  const reach = regionRadius + rBeam;
  return smoothstep(reach + 6.5, Math.max(0.15, reach * 0.55), dist);
}

/**
 * Preallocated Struct-of-Arrays container for the frame's capped candidate beam set.
 * Allocated only while `litPuffs` is enabled (`0 B` when disabled).
 */
export class LitCandidateSet {
  readonly capacity: number;
  count = 0;
  readonly fixtureIndex: Int32Array;
  readonly ox: Float32Array;
  readonly oy: Float32Array;
  readonly oz: Float32Array;
  readonly ax: Float32Array;
  readonly ay: Float32Array;
  readonly az: Float32Array;
  readonly rNear: Float32Array;
  readonly slope: Float32Array;
  readonly length: Float32Array;
  readonly power: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly score: Float32Array;
  private readonly prevSelected = new Set<number>();
  private readonly nextSelected = new Set<number>();

  constructor(capacity: number) {
    const cap = Math.max(1, Math.floor(capacity));
    this.capacity = cap;
    this.fixtureIndex = new Int32Array(cap);
    this.ox = new Float32Array(cap);
    this.oy = new Float32Array(cap);
    this.oz = new Float32Array(cap);
    this.ax = new Float32Array(cap);
    this.ay = new Float32Array(cap);
    this.az = new Float32Array(cap);
    this.rNear = new Float32Array(cap);
    this.slope = new Float32Array(cap);
    this.length = new Float32Array(cap);
    this.power = new Float32Array(cap);
    this.r = new Float32Array(cap);
    this.g = new Float32Array(cap);
    this.b = new Float32Array(cap);
    this.score = new Float32Array(cap);
  }

  clear(): void {
    this.count = 0;
    this.prevSelected.clear();
    this.nextSelected.clear();
  }

  /**
   * Select up to `this.capacity` candidate beams using max proximity across separate
   * smoke-cloud, cryo-cloud, and emitter bounds, `1.18x` hysteresis retention, and
   * deterministic ascending `fixture.index` tie-breaking.
   */
  select(
    beams: readonly LitBeamSource[],
    frame: LitPuffsFrameContext,
    smokeRegion: CloudSphereRegion,
    cryoRegion: CloudSphereRegion,
    smokeEmitters: readonly THREE.Vector3[],
    co2Emitters: readonly THREE.Vector3[],
  ): number {
    this.count = 0;
    if (
      frame.blackout ||
      !Number.isFinite(frame.master) ||
      frame.master <= 0.001 ||
      !Number.isFinite(frame.roomGain) ||
      frame.roomGain <= 0.001 ||
      beams.length === 0
    ) {
      this.prevSelected.clear();
      return 0;
    }

    const hasAnyRegion =
      smokeRegion.active ||
      cryoRegion.active ||
      smokeEmitters.length > 0 ||
      co2Emitters.length > 0;
    const smokeEmLimit = Math.min(8, smokeEmitters.length);
    const co2EmLimit = Math.min(8, co2Emitters.length);

    for (let i = 0; i < beams.length; i++) {
      const fx = beams[i];
      if (!Number.isFinite(fx.lastPreviewIntensity) || fx.lastPreviewIntensity <= 0.002) continue;
      const cr = clamp01(fx.lastPreviewR);
      const cg = clamp01(fx.lastPreviewG);
      const cb = clamp01(fx.lastPreviewB);
      if (cr <= 1e-4 && cg <= 1e-4 && cb <= 1e-4) continue;

      let ax = Number.isFinite(fx.lastAimX) ? fx.lastAimX! : 0;
      let ay = Number.isFinite(fx.lastAimY) ? fx.lastAimY! : -1;
      let az = Number.isFinite(fx.lastAimZ) ? fx.lastAimZ : 0;
      const aLen = Math.hypot(ax, ay, az);
      if (!Number.isFinite(aLen) || aLen <= 1e-8) continue;
      ax /= aLen;
      ay /= aLen;
      az /= aLen;

      const lensOff = Number.isFinite(fx.lensOffsetY) ? fx.lensOffsetY : 0.16;
      const wx = Number.isFinite(fx.lastWorldX) ? fx.lastWorldX : 0;
      const wy = Number.isFinite(fx.lastWorldY) ? fx.lastWorldY : 8.5;
      const wz = Number.isFinite(fx.lastWorldZ) ? fx.lastWorldZ : 0;
      const ox = wx + ax * lensOff;
      const oy = wy + ay * lensOff;
      const oz = wz + az * lensOff;

      const zoom = Number.isFinite(fx.lastZoomScale) && fx.lastZoomScale > 0 ? fx.lastZoomScale : 1;
      const len = Number.isFinite(fx.optics.length) && fx.optics.length > 0.2 ? fx.optics.length : 24;
      const rNear = Math.max(0.03, (Number.isFinite(fx.optics.nearRadius) ? fx.optics.nearRadius : 0.12) * zoom);
      const rFar = Math.max(rNear, (Number.isFinite(fx.optics.farRadius) ? fx.optics.farRadius : 1.75) * zoom);
      const slope = (rFar - rNear) / len;
      const flux = Number.isFinite(fx.optics.fluxRatio) && fx.optics.fluxRatio > 0
        ? Math.min(2.5, fx.optics.fluxRatio)
        : 1.0;
      const power = Math.min(1.6, fx.lastPreviewIntensity) * flux;

      let bestProx = hasAnyRegion ? 0 : 1;
      if (smokeRegion.active) {
        const p = raySphereProximity(
          ox, oy, oz, ax, ay, az, len, rNear, slope,
          smokeRegion.cx, smokeRegion.cy, smokeRegion.cz, smokeRegion.radius,
        );
        if (p > bestProx) bestProx = p;
      }
      if (cryoRegion.active) {
        const p = raySphereProximity(
          ox, oy, oz, ax, ay, az, len, rNear, slope,
          cryoRegion.cx, cryoRegion.cy, cryoRegion.cz, cryoRegion.radius,
        );
        if (p > bestProx) bestProx = p;
      }
      for (let e = 0; e < smokeEmLimit; e++) {
        const em = smokeEmitters[e];
        const p = raySphereProximity(ox, oy, oz, ax, ay, az, len, rNear, slope, em.x, em.y + 1.4, em.z, 3.2);
        if (p > bestProx) bestProx = p;
      }
      for (let e = 0; e < co2EmLimit; e++) {
        const em = co2Emitters[e];
        const p = raySphereProximity(ox, oy, oz, ax, ay, az, len, rNear, slope, em.x, em.y + 1.4, em.z, 3.2);
        if (p > bestProx) bestProx = p;
      }

      const proxWeight = 0.22 + 0.78 * bestProx;
      const hysteresis = this.prevSelected.has(fx.index) ? LIT_PUFFS_HYSTERESIS_BONUS : 1.0;
      const candScore = power * Math.max(cr, cg, cb) * proxWeight * hysteresis;
      const fxIdx = Number.isFinite(fx.index) ? Math.trunc(fx.index) : i;

      // Insert into descending-score bounded array (N <= 16 -> tiny linear shift, 0 allocations).
      let pos = this.count;
      while (pos > 0) {
        const prevScore = this.score[pos - 1];
        const prevIdx = this.fixtureIndex[pos - 1];
        const beatsPrev =
          candScore > prevScore + 1e-9 ||
          (Math.abs(candScore - prevScore) <= 1e-9 && fxIdx < prevIdx);
        if (!beatsPrev) break;
        pos--;
      }
      if (pos >= this.capacity) continue;

      const limit = Math.min(this.count, this.capacity - 1);
      for (let k = limit; k > pos; k--) {
        this.fixtureIndex[k] = this.fixtureIndex[k - 1];
        this.ox[k] = this.ox[k - 1];
        this.oy[k] = this.oy[k - 1];
        this.oz[k] = this.oz[k - 1];
        this.ax[k] = this.ax[k - 1];
        this.ay[k] = this.ay[k - 1];
        this.az[k] = this.az[k - 1];
        this.rNear[k] = this.rNear[k - 1];
        this.slope[k] = this.slope[k - 1];
        this.length[k] = this.length[k - 1];
        this.power[k] = this.power[k - 1];
        this.r[k] = this.r[k - 1];
        this.g[k] = this.g[k - 1];
        this.b[k] = this.b[k - 1];
        this.score[k] = this.score[k - 1];
      }
      this.fixtureIndex[pos] = fxIdx;
      this.ox[pos] = ox;
      this.oy[pos] = oy;
      this.oz[pos] = oz;
      this.ax[pos] = ax;
      this.ay[pos] = ay;
      this.az[pos] = az;
      this.rNear[pos] = rNear;
      this.slope[pos] = slope;
      this.length[pos] = len;
      this.power[pos] = power;
      this.r[pos] = cr;
      this.g[pos] = cg;
      this.b[pos] = cb;
      this.score[pos] = candScore;
      if (this.count < this.capacity) this.count++;
    }

    this.nextSelected.clear();
    for (let i = 0; i < this.count; i++) {
      this.nextSelected.add(this.fixtureIndex[i]);
    }
    this.prevSelected.clear();
    for (const idx of this.nextSelected) {
      this.prevSelected.add(idx);
    }
    return this.count;
  }
}

/**
 * Per-pool state arrays allocated lazily ONLY when `litPuffs` is enabled (`0 B` when disabled).
 */
export class LitPuffPoolState {
  readonly capacity: number;
  readonly spawnSeq: Uint32Array;
  readonly broadR: Float32Array;
  readonly broadG: Float32Array;
  readonly broadB: Float32Array;
  readonly lobeR: Float32Array;
  readonly lobeG: Float32Array;
  readonly lobeB: Float32Array;
  readonly offX: Float32Array;
  readonly offY: Float32Array;
  readonly offZ: Float32Array;
  readonly conc: Float32Array;
  readonly initialized: Uint8Array;
  readonly sortOrder: Uint16Array;
  readonly sortDepth: Float32Array;
  readonly scratchX: Float32Array;
  readonly scratchY: Float32Array;
  readonly scratchZ: Float32Array;
  readonly scratchDiam: Float32Array;
  readonly scratchOpac: Float32Array;

  constructor(capacity: number) {
    const cap = Math.max(1, Math.floor(capacity));
    this.capacity = cap;
    this.spawnSeq = new Uint32Array(cap);
    this.broadR = new Float32Array(cap);
    this.broadG = new Float32Array(cap);
    this.broadB = new Float32Array(cap);
    this.lobeR = new Float32Array(cap);
    this.lobeG = new Float32Array(cap);
    this.lobeB = new Float32Array(cap);
    this.offX = new Float32Array(cap);
    this.offY = new Float32Array(cap);
    this.offZ = new Float32Array(cap);
    this.conc = new Float32Array(cap);
    this.initialized = new Uint8Array(cap);
    this.sortOrder = new Uint16Array(cap);
    this.sortDepth = new Float32Array(cap);
    this.scratchX = new Float32Array(cap);
    this.scratchY = new Float32Array(cap);
    this.scratchZ = new Float32Array(cap);
    this.scratchDiam = new Float32Array(cap);
    this.scratchOpac = new Float32Array(cap);
  }

  seedAliveSequential(alive: number, startSeq: number): number {
    let seq = startSeq >>> 0;
    const n = Math.min(this.capacity, Math.max(0, alive));
    this.initialized.fill(0);
    for (let i = 0; i < n; i++) {
      seq = (seq + 1) >>> 0;
      this.spawnSeq[i] = seq;
    }
    return seq;
  }

  initSlot(slot: number, seq: number): void {
    if (slot < 0 || slot >= this.capacity) return;
    this.spawnSeq[slot] = seq >>> 0;
    this.broadR[slot] = 0;
    this.broadG[slot] = 0;
    this.broadB[slot] = 0;
    this.lobeR[slot] = 0;
    this.lobeG[slot] = 0;
    this.lobeB[slot] = 0;
    this.offX[slot] = 0;
    this.offY[slot] = 0;
    this.offZ[slot] = 0;
    this.conc[slot] = 0;
    this.initialized[slot] = 0;
  }

  copySlot(dst: number, src: number): void {
    if (dst === src || dst < 0 || src < 0 || dst >= this.capacity || src >= this.capacity) return;
    this.spawnSeq[dst] = this.spawnSeq[src];
    this.broadR[dst] = this.broadR[src];
    this.broadG[dst] = this.broadG[src];
    this.broadB[dst] = this.broadB[src];
    this.lobeR[dst] = this.lobeR[src];
    this.lobeG[dst] = this.lobeG[src];
    this.lobeB[dst] = this.lobeB[src];
    this.offX[dst] = this.offX[src];
    this.offY[dst] = this.offY[src];
    this.offZ[dst] = this.offZ[src];
    this.conc[dst] = this.conc[src];
    this.initialized[dst] = this.initialized[src];
  }

  zeroLighting(alive: number): void {
    const n = Math.min(this.capacity, Math.max(0, alive));
    for (let i = 0; i < n; i++) {
      this.broadR[i] = 0;
      this.broadG[i] = 0;
      this.broadB[i] = 0;
      this.lobeR[i] = 0;
      this.lobeG[i] = 0;
      this.lobeB[i] = 0;
      this.offX[i] = 0;
      this.offY[i] = 0;
      this.offZ[i] = 0;
      this.conc[i] = 0;
      this.initialized[i] = 0;
    }
  }
}

// Module-private fixed-size top-4 registers (synchronous single-threaded evaluation -> 0 allocations).
const topW = new Float32Array(4);
const topIdx = new Int32Array(4);
const topOffX = new Float32Array(4);
const topOffY = new Float32Array(4);
const topOffZ = new Float32Array(4);
const topRCone = new Float32Array(4);

/**
 * Evaluate at most `maxBeamsPerPuff` (`2` on `low`, `4` on `high`) beam contributions
 * for puff `slot` against the frame's selected `candidates`, updating `poolState` in place.
 * Returns `true` when the puff receives non-zero local beam illumination.
 */
export function evaluateSinglePuffLighting(
  slot: number,
  px: number,
  py: number,
  pz: number,
  diameter: number,
  isCryo: boolean,
  dt: number,
  maxBeamsPerPuff: number,
  candidates: LitCandidateSet,
  frame: LitPuffsFrameContext,
  poolState: LitPuffPoolState,
): boolean {
  if (
    frame.blackout ||
    !Number.isFinite(frame.master) ||
    frame.master <= 0.001 ||
    !Number.isFinite(frame.roomGain) ||
    frame.roomGain <= 0.001
  ) {
    poolState.broadR[slot] = 0;
    poolState.broadG[slot] = 0;
    poolState.broadB[slot] = 0;
    poolState.lobeR[slot] = 0;
    poolState.lobeG[slot] = 0;
    poolState.lobeB[slot] = 0;
    poolState.offX[slot] = 0;
    poolState.offY[slot] = 0;
    poolState.offZ[slot] = 0;
    poolState.conc[slot] = 0;
    poolState.initialized[slot] = 0;
    return false;
  }

  const kCap = Math.max(1, Math.min(4, Math.floor(maxBeamsPerPuff)));
  const rPuff = Math.max(0.12, 0.5 * (Number.isFinite(diameter) ? diameter : 0.5));
  const axialPad = rPuff * 0.65;
  const puffReach = 0.62 * rPuff;
  let vx = frame.camPosX - px;
  let vy = frame.camPosY - py;
  let vz = frame.camPosZ - pz;
  const vLenSq = vx * vx + vy * vy + vz * vz;
  if (Number.isFinite(vLenSq) && vLenSq > 1e-12) {
    const invV = 1 / Math.sqrt(vLenSq);
    vx *= invV;
    vy *= invV;
    vz *= invV;
  } else {
    vx = 0;
    vy = 0;
    vz = 1;
  }

  let hitCount = 0;
  const candCount = candidates.count;
  const cOx = candidates.ox;
  const cOy = candidates.oy;
  const cOz = candidates.oz;
  const cAx = candidates.ax;
  const cAy = candidates.ay;
  const cAz = candidates.az;
  const cLen = candidates.length;
  const cRNear = candidates.rNear;
  const cSlope = candidates.slope;
  const cPower = candidates.power;
  const cFxIdx = candidates.fixtureIndex;

  for (let c = 0; c < candCount; c++) {
    const ox = cOx[c];
    const oy = cOy[c];
    const oz = cOz[c];
    const ax = cAx[c];
    const ay = cAy[c];
    const az = cAz[c];
    const throwLen = cLen[c];

    const dx = px - ox;
    const dy = py - oy;
    const dz = pz - oz;
    const t = dx * ax + dy * ay + dz * az;
    if (t <= -axialPad || t >= throwLen + axialPad) continue;

    const tClamped = t < 0 ? 0 : t > throwLen ? throwLen : t;
    const rCone = Math.max(0.06, cRNear[c] + cSlope[c] * tClamped);
    const rEff = rCone + puffReach;
    // Vector from puff center toward the closest point on the beam axis segment:
    const offX = ox + ax * tClamped - px;
    const offY = oy + ay * tClamped - py;
    const offZ = oz + az * tClamped - pz;
    const dPerpSq = offX * offX + offY * offY + offZ * offZ;
    if (dPerpSq >= rEff * rEff) continue;

    const dPerp = Math.sqrt(dPerpSq);
    const radial = 1 - smoothstep(0.12 * rEff, rEff, dPerp);
    if (radial <= 1e-4) continue;

    const axialIn = t >= 0.30 ? 1 : smoothstep(-axialPad, 0.30, t);
    const axialOut = t <= throwLen * 0.85 ? 1 : 1 - smoothstep(throwLen * 0.85, throwLen + axialPad, t);
    const axial = axialIn * axialOut;
    if (axial <= 1e-4) continue;

    const areaGain = 1.28 / (1 + 0.42 * rCone * rCone);
    // Forward scatter when beam travels toward the camera (`dot(A, V)` > 0 since V points puff -> camera).
    const cosForward = ax * vx + ay * vy + az * vz;
    const phaseGain = 0.90 + 0.38 * smoothstep(-0.35, 0.85, cosForward);
    const w = cPower[c] * radial * axial * areaGain * phaseGain;
    if (w <= 1e-4) continue;

    let pos = hitCount;
    const candFxIdx = cFxIdx[c];
    while (pos > 0) {
      const prevW = topW[pos - 1];
      const prevFxIdx = cFxIdx[topIdx[pos - 1]];
      const beats = w > prevW + 1e-9 || (Math.abs(w - prevW) <= 1e-9 && candFxIdx < prevFxIdx);
      if (!beats) break;
      pos--;
    }
    if (pos >= kCap) continue;

    const lim = Math.min(hitCount, kCap - 1);
    for (let k = lim; k > pos; k--) {
      topW[k] = topW[k - 1];
      topIdx[k] = topIdx[k - 1];
      topOffX[k] = topOffX[k - 1];
      topOffY[k] = topOffY[k - 1];
      topOffZ[k] = topOffZ[k - 1];
      topRCone[k] = topRCone[k - 1];
    }
    topW[pos] = w;
    topIdx[pos] = c;
    topOffX[pos] = offX;
    topOffY[pos] = offY;
    topOffZ[pos] = offZ;
    topRCone[pos] = rCone;
    if (hitCount < kCap) hitCount++;
  }

  const scatterGain =
    (isCryo ? LIT_PUFFS_CRYO_SCATTER_GAIN : LIT_PUFFS_SMOKE_SCATTER_GAIN) *
    clamp01(frame.roomGain);

  let targetBroadR = 0;
  let targetBroadG = 0;
  let targetBroadB = 0;
  let targetLobeR = 0;
  let targetLobeG = 0;
  let targetLobeB = 0;
  let targetOffX = 0;
  let targetOffY = 0;
  let targetOffZ = 0;
  let targetConc = 0;

  if (hitCount > 0) {
    // Dominant beam (#0): localize into shaft lobe when narrower than the puff, otherwise broad scatter.
    const c0 = topIdx[0];
    const w0 = topW[0] * scatterGain;
    const r0 = candidates.r[c0] * w0;
    const g0 = candidates.g[c0] * w0;
    const b0 = candidates.b[c0] * w0;
    const rCone0 = topRCone[0];
    if (rCone0 < rPuff * 1.15) {
      const lobeFrac = LIT_PUFFS_LOBE_SHARE * clamp01((rPuff * 1.25 - rCone0) / Math.max(0.15, rPuff));
      const broadFrac = 1 - lobeFrac;
      targetBroadR = r0 * broadFrac;
      targetBroadG = g0 * broadFrac;
      targetBroadB = b0 * broadFrac;
      targetLobeR = r0 * lobeFrac;
      targetLobeG = g0 * lobeFrac;
      targetLobeB = b0 * lobeFrac;
      let ox0 = topOffX[0];
      let oy0 = topOffY[0];
      let oz0 = topOffZ[0];
      const oLenSq = ox0 * ox0 + oy0 * oy0 + oz0 * oz0;
      const maxOff = 0.62 * rPuff;
      if (oLenSq > maxOff * maxOff && oLenSq > 1e-12) {
        const s = maxOff / Math.sqrt(oLenSq);
        ox0 *= s;
        oy0 *= s;
        oz0 *= s;
      }
      targetOffX = ox0;
      targetOffY = oy0;
      targetOffZ = oz0;
      targetConc = clamp((0.75 * rPuff) / Math.max(0.10, rCone0), 1.2, 6.0);
    } else {
      targetBroadR = r0;
      targetBroadG = g0;
      targetBroadB = b0;
    }

    // Remaining beams (1 .. hitCount - 1, strictly <= K - 1): broad scatter so multi-colour crossings mix cleanly.
    for (let j = 1; j < hitCount; j++) {
      const cj = topIdx[j];
      const wj = topW[j] * scatterGain;
      targetBroadR += candidates.r[cj] * wj;
      targetBroadG += candidates.g[cj] * wj;
      targetBroadB += candidates.b[cj] * wj;
    }
  }

  if (poolState.initialized[slot] === 0 || !Number.isFinite(dt) || dt <= 0) {
    poolState.broadR[slot] = targetBroadR;
    poolState.broadG[slot] = targetBroadG;
    poolState.broadB[slot] = targetBroadB;
    poolState.lobeR[slot] = targetLobeR;
    poolState.lobeG[slot] = targetLobeG;
    poolState.lobeB[slot] = targetLobeB;
    poolState.offX[slot] = targetOffX;
    poolState.offY[slot] = targetOffY;
    poolState.offZ[slot] = targetOffZ;
    poolState.conc[slot] = targetConc;
    poolState.initialized[slot] = 1;
  } else {
    const a = 1 - Math.exp(-Math.min(0.25, dt) / LIT_PUFFS_SMOOTH_TAU_S);
    poolState.broadR[slot] += (targetBroadR - poolState.broadR[slot]) * a;
    poolState.broadG[slot] += (targetBroadG - poolState.broadG[slot]) * a;
    poolState.broadB[slot] += (targetBroadB - poolState.broadB[slot]) * a;
    poolState.lobeR[slot] += (targetLobeR - poolState.lobeR[slot]) * a;
    poolState.lobeG[slot] += (targetLobeG - poolState.lobeG[slot]) * a;
    poolState.lobeB[slot] += (targetLobeB - poolState.lobeB[slot]) * a;
    if (targetConc > 1e-3) {
      poolState.offX[slot] += (targetOffX - poolState.offX[slot]) * a;
      poolState.offY[slot] += (targetOffY - poolState.offY[slot]) * a;
      poolState.offZ[slot] += (targetOffZ - poolState.offZ[slot]) * a;
      poolState.conc[slot] += (targetConc - poolState.conc[slot]) * a;
    } else {
      poolState.conc[slot] += (0 - poolState.conc[slot]) * a;
    }
  }

  const totalPeak = Math.max(
    poolState.broadR[slot] + poolState.lobeR[slot],
    poolState.broadG[slot] + poolState.lobeG[slot],
    poolState.broadB[slot] + poolState.lobeB[slot],
  );
  return totalPeak > 0.002;
}

/**
 * Zero-allocation back-to-front Shell sort of `sortOrder[0 .. count - 1]` descending by
 * signed camera view depth `dot(pos - camPos, camFwd)`.
 * Ties within `1e-4 m` break deterministically by ascending `spawnSeq` so pool slot
 * compaction (`copySlot`) and `overwriteOldest` eviction never flip surviving puff order.
 */
export function sortPuffsBackToFront(
  count: number,
  depths: Float32Array,
  spawnSeq: Uint32Array,
  sortOrder: Uint16Array,
): void {
  const n = Math.min(sortOrder.length, Math.max(0, Math.floor(count)));
  for (let i = 0; i < n; i++) {
    sortOrder[i] = i;
  }
  if (n <= 1) return;

  // Ciura gap sequence covering particle capacities <= 420 with zero recursion or heap allocation.
  const gaps = [301, 132, 57, 23, 10, 4, 1];
  for (let gi = 0; gi < gaps.length; gi++) {
    const gap = gaps[gi];
    if (gap >= n) continue;
    for (let i = gap; i < n; i++) {
      const idx = sortOrder[i];
      const d = depths[idx];
      const seq = spawnSeq[idx];
      let j = i;
      while (j >= gap) {
        const prevIdx = sortOrder[j - gap];
        const prevD = depths[prevIdx];
        const diff = d - prevD;
        // Back-to-front: larger depth draws first; near-ties break by smaller (older) spawnSeq.
        const comesBefore =
          diff > 1e-4 ||
          (Math.abs(diff) <= 1e-4 && seq < spawnSeq[prevIdx]);
        if (!comesBefore) break;
        sortOrder[j] = prevIdx;
        j -= gap;
      }
      sortOrder[j] = idx;
    }
  }
}

/**
 * Resolve inter-batch `renderOrder` (`1` farther, `2` nearer) between `smoke` and `cryo`
 * from opacity-weighted mean camera depth with a `0.30 m` hysteresis deadband.
 * Note: orders whole batches rather than interleaving individual smoke/cryo puffs.
 */
export function resolveSmokeCryoRenderOrder(
  smokeAlive: number,
  smokeMeanDepth: number,
  cryoAlive: number,
  cryoMeanDepth: number,
  prevSmokeFirst: boolean,
): { smokeOrder: 1 | 2; cryoOrder: 1 | 2; smokeFirst: boolean } {
  if (smokeAlive <= 0 || cryoAlive <= 0 || !Number.isFinite(smokeMeanDepth) || !Number.isFinite(cryoMeanDepth)) {
    return prevSmokeFirst
      ? { smokeOrder: 1, cryoOrder: 2, smokeFirst: true }
      : { smokeOrder: 2, cryoOrder: 1, smokeFirst: false };
  }
  const delta = smokeMeanDepth - cryoMeanDepth;
  let smokeFirst = prevSmokeFirst;
  if (delta > LIT_PUFFS_BATCH_ORDER_DEADBAND_M) {
    // Smoke is farther from camera -> draw smoke first (1), cryo second (2).
    smokeFirst = true;
  } else if (delta < -LIT_PUFFS_BATCH_ORDER_DEADBAND_M) {
    // Cryo is farther from camera -> draw cryo first (1), smoke second (2).
    smokeFirst = false;
  }
  return smokeFirst
    ? { smokeOrder: 1, cryoOrder: 2, smokeFirst: true }
    : { smokeOrder: 2, cryoOrder: 1, smokeFirst: false };
}

export interface LitPuffFragmentOracleInput {
  texUv: { u: number; v: number };
  vaporSample: { r: number; a: number };
  tint: { r: number; g: number; b: number };
  centerWorld: { x: number; y: number; z: number };
  diameter: number;
  rotationRad: number;
  opacity: number;
  aspect: number;
  broadLight: { r: number; g: number; b: number };
  lobeLight: { r: number; g: number; b: number };
  lobeWorldOffset: { x: number; y: number; z: number; conc: number };
  viewMatrix: THREE.Matrix4;
}

/**
 * Exact CPU reference oracle matching `VAPOR_VERT_LIT` + `VAPOR_FRAG_LIT`
 * (near-camera fade, billboard rotation inverse, dominant lobe mask, and hue-preserving soft knee).
 */
export function evaluateLitPuffFragmentOracle(input: LitPuffFragmentOracleInput): {
  discarded: boolean;
  r: number;
  g: number;
  b: number;
  alpha: number;
  added: { r: number; g: number; b: number };
  lobeUv: { u: number; v: number };
  nearFade: number;
} {
  const m = input.viewMatrix.elements;
  const cx = input.centerWorld.x;
  const cy = input.centerWorld.y;
  const cz = input.centerWorld.z;
  const eyeZ = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
  const nearFade = smoothstep(LIT_PUFFS_NEAR_FADE_NEAR_M, LIT_PUFFS_NEAR_FADE_FAR_M, -eyeZ);
  const density = input.opacity * nearFade;
  const alpha = density * input.vaporSample.a;

  const safeDiam = Math.max(input.diameter, 0.05);
  const qx = input.aspect * safeDiam;
  const qy = safeDiam;
  const c = Math.cos(input.rotationRad);
  const s = Math.sin(input.rotationRad);

  const ox = input.lobeWorldOffset.x;
  const oy = input.lobeWorldOffset.y;
  const oz = input.lobeWorldOffset.z;
  const lobeEyeX = m[0] * ox + m[4] * oy + m[8] * oz;
  const lobeEyeY = m[1] * ox + m[5] * oy + m[9] * oz;
  // GLSL `mat2(c, -s, s, c) * lobeEye` (column 0 = (c, -s), column 1 = (s, c)):
  const unrotX = c * lobeEyeX + s * lobeEyeY;
  const unrotY = -s * lobeEyeX + c * lobeEyeY;
  const lobeU = clamp(unrotX / qx, -0.65, 0.65);
  const lobeV = clamp(unrotY / qy, -0.65, 0.65);

  if (alpha < 0.001) {
    return {
      discarded: true,
      r: 0,
      g: 0,
      b: 0,
      alpha: 0,
      added: { r: 0, g: 0, b: 0 },
      lobeUv: { u: lobeU, v: lobeV },
      nearFade,
    };
  }

  const baseR = input.tint.r * input.vaporSample.r;
  const baseG = input.tint.g * input.vaporSample.r;
  const baseB = input.tint.b * input.vaporSample.r;

  const du = input.texUv.u - 0.5 - lobeU;
  const dv = input.texUv.v - 0.5 - lobeV;
  const conc = Math.max(0, input.lobeWorldOffset.conc);
  const lobeMask = Math.exp(-conc * (du * du + dv * dv));
  const cloudBody = 0.42 + 0.78 * input.vaporSample.r;

  let addR = (input.broadLight.r + input.lobeLight.r * lobeMask) * cloudBody;
  let addG = (input.broadLight.g + input.lobeLight.g * lobeMask) * cloudBody;
  let addB = (input.broadLight.b + input.lobeLight.b * lobeMask) * cloudBody;

  const peak = Math.max(addR, addG, addB);
  if (peak > 1e-5) {
    const comp = LIT_PUFFS_MAX_ADDED_RADIANCE * (peak / (peak + LIT_PUFFS_ADDED_KNEE));
    const scale = Math.min(1, comp / peak);
    addR *= scale;
    addG *= scale;
    addB *= scale;
  }

  return {
    discarded: false,
    r: baseR + addR,
    g: baseG + addG,
    b: baseB + addB,
    alpha,
    added: { r: addR, g: addG, b: addB },
    lobeUv: { u: lobeU, v: lobeV },
    nearFade,
  };
}
