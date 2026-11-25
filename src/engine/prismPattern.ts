import * as THREE from 'three';
import type { RenderTier } from './hardwareMaterials';

/**
 * Shared constants, pure geometry/projection math, CPU filtering oracle,
 * overlap-guard policy, and GLSL evaluation snippet for Sprint 16 prism floor projections.
 *
 * Constants mirror `VOLUMETRIC_BEAM_VERT` / `VOLUMETRIC_BEAM_FRAG` (`src/engine/shaders.ts`)
 * and are interpolated directly into `BeamPools` (`src/engine/beamPools.ts`) so CPU tests
 * and GPU shaders cannot drift.
 */

export const PRISM_SHAFT_COUNT = 8;
/** Matches `uTime * 0.48 + uSeed` in `VOLUMETRIC_BEAM_FRAG`. */
export const PRISM_ROTATION_RATE = 0.48;
/** Matches `0.71 * smoothstep(0.0, 0.16, reach)` in `VOLUMETRIC_BEAM_FRAG`. */
export const PRISM_RING_RADIUS = 0.71;
export const PRISM_REACH_RAMP_END = 0.16;
/** Matches `smoothstep(0.01, 0.14, reach)` in `VOLUMETRIC_BEAM_FRAG`. */
export const PRISM_MIX_REACH_START = 0.01;
export const PRISM_MIX_REACH_END = 0.14;
/** Matches `exp2(-125.0 * offset * offset)` in `VOLUMETRIC_BEAM_FRAG`. */
export const PRISM_AERIAL_EXP2_COEFF = 125.0;
/**
 * 2D Gaussian variance σ² whose 1D marginal projection equals `exp2(-125 * x^2)`:
 * `exp(-x^2 / (2 σ²)) = 2^(-125 x^2)  =>  σ² = 1 / (250 ln 2) ≈ 0.00577078`.
 */
export const PRISM_SIGMA_SQ = 1 / (2 * PRISM_AERIAL_EXP2_COEFF * Math.LN2);
/** Pixel box-filter variance factor: `Σ = σ² I + (Jx Jxᵀ + Jy Jyᵀ) / 12`. */
export const PRISM_FILTER_K = 1 / 12;
/** Soft residual fill share inside the cone, matching the aerial `0.055` base glow. */
export const PRISM_AMBIENT_SHARE = 0.08;
/** Smooth C¹ disk-edge roll-off starting past `R + 2.75σ ≈ 0.919` so spots stay cleanly inside `r < 1`. */
export const PRISM_OUTER_MASK_START = 0.92;
export const PRISM_OUTER_MASK_END = 1.0;
/** Minification blend window (on `sqrt(maxEigenvalue(Σ))`) back toward `P0(r)` to avoid edge-clip energy loss. */
export const PRISM_MINIFY_START = 0.35;
export const PRISM_MINIFY_END = 0.85;
/** Maximum Jacobian vector magnitude to keep `Σ` well-conditioned at near-parallel grazing angles. */
export const PRISM_MAX_JACOBIAN_LEN = 16.0;

/** Exact analytic integral of the beam-only (`wash = 0`) pool profile `P0(r)` over the unit disk: `3623π / 7000`. */
export const PRISM_BEAM_INTEGRAL_E0 = (3623 * Math.PI) / 7000;
/** Exact unbounded 2D integral of 8 unit-amplitude spots with variance `PRISM_SIGMA_SQ`: `8π / (125 ln 2)`. */
export const PRISM_UNCLIPPED_SPOTS_INTEGRAL = PRISM_SHAFT_COUNT * 2 * Math.PI * PRISM_SIGMA_SQ;

/**
 * Application-buffer ceiling (`100 KiB < 0.1 MiB`) for optional per-instance prism attributes
 * across all receivers. Driver-internal buffer alignment overhead is outside this application estimate.
 */
export const PRISM_POOL_MAX_EXTRA_BYTES = 100 * 1024;
/** Two `vec4` `InstancedBufferAttribute` streams (`prismU`, `prismV`) = 8 floats = 32 bytes per instance slot. */
export const PRISM_POOL_BYTES_PER_INSTANCE = 32;

/**
 * Low-tier hysteresis thresholds on receiver-qualified active prism pools.
 * Sized so Arena World Tour Rig (32 hung beam heads across 2 receivers) stays active on low tier
 * while heavier multi-group/multi-platform overlap suppresses gracefully without boundary chatter.
 */
export const LOW_TIER_PRISM_SUPPRESS_HIGH = 36;
export const LOW_TIER_PRISM_SUPPRESS_LOW = 28;
export const LOW_TIER_PRISM_TOTAL_HIGH = 68;
export const LOW_TIER_PRISM_TOTAL_LOW = 52;

const TWO_PI = Math.PI * 2;
const INV_SQRT2 = Math.SQRT1_2;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Existing beam-only (`wash = 0`) receiver pool profile `P0(r)` on the unit disk `r ∈ [0, 1]`. */
export function baseBeamPoolProfile(r: number): number {
  if (!Number.isFinite(r) || r >= 1) return 0;
  const rr = Math.max(0, r);
  const edge = 1 - smoothstep(0.5, 1.0, rr);
  return edge * (1 - 0.32 * rr * rr);
}

/**
 * Compute the 8 prism shaft centers in normalized beam cross-section `(u, v)` coordinates
 * (`u = dot(radial, Tx) / radius`, `v = dot(radial, Tz) / radius`).
 * Uses the exact same `±d0..±d3` 45°-step rotation construction as `BeamPools` GLSL.
 */
export function prismShaftCenters(
  phase: number,
  reach: number,
  out?: [number, number][],
): [number, number][] {
  const clampedReach = Math.max(0, Math.min(1, Number.isFinite(reach) ? reach : 0));
  const safePhase = Number.isFinite(phase) ? phase : 0;
  const ringR = PRISM_RING_RADIUS * smoothstep(0, PRISM_REACH_RAMP_END, clampedReach);
  const d0x = Math.sin(safePhase) * ringR;
  const d0y = -Math.cos(safePhase) * ringR;
  const d2x = -d0y;
  const d2y = d0x;
  const d1x = (d0x + d2x) * INV_SQRT2;
  const d1y = (d0y + d2y) * INV_SQRT2;
  const d3x = (d2x - d0x) * INV_SQRT2;
  const d3y = (d2y - d0y) * INV_SQRT2;

  const target = out ?? new Array<[number, number]>(PRISM_SHAFT_COUNT);
  target[0] = [d0x, d0y];
  target[1] = [d1x, d1y];
  target[2] = [d2x, d2y];
  target[3] = [d3x, d3y];
  target[4] = [-d0x, -d0y];
  target[5] = [-d1x, -d1y];
  target[6] = [-d2x, -d2y];
  target[7] = [-d3x, -d3y];
  return target;
}

/**
 * Numerically integrate the complete clipped 8-spot profile (including pedestal and `outerMask`
 * over the unit disk `u² + v² < 1`) at full ring radius (`reach = 1`, `J = 0`) so
 * `∫_disk P_prism dA === PRISM_BEAM_INTEGRAL_E0`.
 */
export function computeNormalizedPrismSpotGain(gridSamples = 128): number {
  const n = Math.max(16, Math.round(gridSamples));
  const step = 2 / n;
  const cellArea = step * step;
  const inv2SigmaSq = 0.5 / PRISM_SIGMA_SQ;
  const centers = prismShaftCenters(0, 1);
  let pedestalIntegral = 0;
  let spotsIntegral = 0;
  for (let iy = 0; iy < n; iy++) {
    const v = -1 + (iy + 0.5) * step;
    for (let ix = 0; ix < n; ix++) {
      const u = -1 + (ix + 0.5) * step;
      const rSq = u * u + v * v;
      if (rSq >= 1) continue;
      const r = Math.sqrt(rSq);
      pedestalIntegral += PRISM_AMBIENT_SHARE * baseBeamPoolProfile(r) * cellArea;
      const outerMask = 1 - smoothstep(PRISM_OUTER_MASK_START, PRISM_OUTER_MASK_END, r);
      let s = 0;
      for (let k = 0; k < PRISM_SHAFT_COUNT; k++) {
        const du = u - centers[k][0];
        const dv = v - centers[k][1];
        s += Math.exp(-(du * du + dv * dv) * inv2SigmaSq);
      }
      spotsIntegral += s * outerMask * cellArea;
    }
  }
  const targetSpotsEnergy = Math.max(0, PRISM_BEAM_INTEGRAL_E0 - pedestalIntegral);
  return spotsIntegral > 0
    ? targetSpotsEnergy / spotsIntegral
    : ((1 - PRISM_AMBIENT_SHARE) * PRISM_BEAM_INTEGRAL_E0) / PRISM_UNCLIPPED_SPOTS_INTEGRAL;
}

/** Disk-integrated spot gain shared by CPU oracle and `BeamPools` GLSL shader. */
export const PRISM_SPOT_GAIN = computeNormalizedPrismSpotGain(128);

/** Wrap prism phase `(timeSec * 0.48 + seed)` into `[0, 2π)` without precision drift. */
export function prismPhase(timeSec: number, seed: number): number {
  const t = Number.isFinite(timeSec) ? timeSec : 0;
  const s = Number.isFinite(seed) ? seed : 0;
  const raw = (t * PRISM_ROTATION_RATE + s) % TWO_PI;
  return raw < 0 ? raw + TWO_PI : raw;
}

/**
 * Construct a strictly orthonormal `(outU, outAxis, outV)` frame from `beamMesh.matrixWorld`
 * and local emission `sign` (`-1` for hung heads, `+1` for floor heads) with zero heap allocations:
 * 1. Normalize signed beam axis `A = normalize(sign * m[1].xyz)`.
 * 2. Project `m[0].xyz` orthogonal to `A` and normalize as `Tx`.
 * 3. Derive `Tz = ±cross(A, Tx)` oriented to agree with `m[2].xyz` projected off `A`.
 *
 * For orthogonal StageEngine transforms (hung or floor, pan/tilt, uniform zoom), `(Tx, Tz)`
 * equals `(normalize(m[0].xyz), normalize(m[2].xyz))` identically; for synthetic sheared matrices,
 * it guarantees an orthonormal receiver basis while rejecting rank-deficient/non-finite inputs.
 */
export function extractPrismFrame(
  matrixWorld: THREE.Matrix4,
  sign: 1 | -1,
  outAxis: THREE.Vector3,
  outU: THREE.Vector3,
  outV: THREE.Vector3,
): boolean {
  const e = matrixWorld.elements;
  const s = sign >= 0 ? 1 : -1;
  const axRaw = e[4] * s;
  const ayRaw = e[5] * s;
  const azRaw = e[6] * s;
  const aLenSq = axRaw * axRaw + ayRaw * ayRaw + azRaw * azRaw;
  if (!Number.isFinite(aLenSq) || aLenSq <= 1e-12) {
    outAxis.set(0, s, 0);
    outU.set(1, 0, 0);
    outV.set(0, 0, 1);
    return false;
  }
  const invALen = 1 / Math.sqrt(aLenSq);
  const ax = axRaw * invALen;
  const ay = ayRaw * invALen;
  const az = azRaw * invALen;

  const m0x = e[0];
  const m0y = e[1];
  const m0z = e[2];
  const dot0A = m0x * ax + m0y * ay + m0z * az;
  const uxRaw = m0x - dot0A * ax;
  const uyRaw = m0y - dot0A * ay;
  const uzRaw = m0z - dot0A * az;
  const uLenSq = uxRaw * uxRaw + uyRaw * uyRaw + uzRaw * uzRaw;
  if (!Number.isFinite(uLenSq) || uLenSq <= 1e-12) {
    outAxis.set(ax, ay, az);
    outU.set(1, 0, 0);
    outV.set(0, 0, 1);
    return false;
  }
  const invULen = 1 / Math.sqrt(uLenSq);
  const ux = uxRaw * invULen;
  const uy = uyRaw * invULen;
  const uz = uzRaw * invULen;

  const m2x = e[8];
  const m2y = e[9];
  const m2z = e[10];
  const dot2A = m2x * ax + m2y * ay + m2z * az;
  const vProjX = m2x - dot2A * ax;
  const vProjY = m2y - dot2A * ay;
  const vProjZ = m2z - dot2A * az;
  const vProjLenSq = vProjX * vProjX + vProjY * vProjY + vProjZ * vProjZ;
  // Also reject collinear m[0] and m[2] in the transverse plane.
  const cx = ay * uz - az * uy;
  const cy = az * ux - ax * uz;
  const cz = ax * uy - ay * ux;
  const align = cx * vProjX + cy * vProjY + cz * vProjZ;
  if (!Number.isFinite(vProjLenSq) || vProjLenSq <= 1e-12 || !Number.isFinite(align) || Math.abs(align) <= 1e-6 * Math.sqrt(vProjLenSq)) {
    outAxis.set(ax, ay, az);
    outU.set(1, 0, 0);
    outV.set(0, 0, 1);
    return false;
  }
  const flip = align >= 0 ? 1 : -1;
  outAxis.set(ax, ay, az);
  outU.set(ux, uy, uz);
  outV.set(cx * flip, cy * flip, cz * flip);
  return true;
}

/**
 * Exact JavaScript mirror of `VOLUMETRIC_BEAM_VERT`'s camera transverse axis (`across`)
 * and `azimuth` computation, used by unit tests to verify aerial-to-floor shaft alignment.
 */
export function aerialPrismAzimuth(
  matrixWorld: THREE.Matrix4,
  lensOffsetY: number,
  cameraPosition: THREE.Vector3,
  isFloor: boolean,
): {
  lens: THREE.Vector3;
  axis: THREE.Vector3;
  tx: THREE.Vector3;
  tz: THREE.Vector3;
  across: THREE.Vector3;
  azimuth: number;
  collinear: boolean;
} {
  const sign: 1 | -1 = isFloor ? 1 : -1;
  const axis = new THREE.Vector3();
  const tx = new THREE.Vector3();
  const tz = new THREE.Vector3();
  extractPrismFrame(matrixWorld, sign, axis, tx, tz);
  const lens = new THREE.Vector3(0, sign * lensOffsetY, 0).applyMatrix4(matrixWorld);
  const toCam = new THREE.Vector3().subVectors(cameraPosition, lens);
  const rawAcross = new THREE.Vector3().crossVectors(axis, toCam);
  const rawLen = rawAcross.length();
  const collinear = rawLen <= 1e-4;
  const across = rawAcross.clone().divideScalar(Math.max(rawLen, 1e-4));
  const bx = across.dot(tx);
  const bz = across.dot(tz);
  const azimuth = bx * bx + bz * bz > 1e-4 ? Math.atan2(bz, bx) : 0;
  return { lens, axis, tx, tz, across, azimuth, collinear };
}

/**
 * Pure CPU helper computing normalized beam coordinates `(u, v, r)` and the analytic
 * 2×2 screen-space Jacobian `(jx, jy)` from world-space pixel derivatives `(dWx, dWy)`,
 * matching `POOL_FRAGMENT_PRISM` in `src/engine/beamPools.ts`.
 */
export function computePrismPoolJacobian(params: {
  delta: THREE.Vector3;
  nearRadius: number;
  slope: number;
  axis: THREE.Vector3;
  tx: THREE.Vector3;
  tz: THREE.Vector3;
  dWx: THREE.Vector3;
  dWy: THREE.Vector3;
}): {
  throwDist: number;
  radius: number;
  u: number;
  v: number;
  r: number;
  jxX: number;
  jxY: number;
  jyX: number;
  jyY: number;
} | null {
  const { delta, nearRadius, slope, axis, tx, tz, dWx, dWy } = params;
  const throwDist = delta.dot(axis);
  if (!Number.isFinite(throwDist) || throwDist <= 0) return null;
  const radius = nearRadius + slope * throwDist;
  if (!Number.isFinite(radius) || radius <= 1e-4) return null;
  const invR = 1 / radius;
  const rx = delta.x - throwDist * axis.x;
  const ry = delta.y - throwDist * axis.y;
  const rz = delta.z - throwDist * axis.z;
  const r = Math.hypot(rx, ry, rz) * invR;
  const u = (rx * tx.x + ry * tx.y + rz * tx.z) * invR;
  const v = (rx * tz.x + ry * tz.y + rz * tz.z) * invR;
  const drx = slope * dWx.dot(axis);
  const dry = slope * dWy.dot(axis);
  const jxX = (dWx.dot(tx) - u * drx) * invR;
  const jxY = (dWx.dot(tz) - v * drx) * invR;
  const jyX = (dWy.dot(tx) - u * dry) * invR;
  const jyY = (dWy.dot(tz) - v * dry) * invR;
  return { throwDist, radius, u, v, r, jxX, jxY, jyX, jyY };
}

/**
 * Pure CPU oracle matching `PRISM_POOL_EVAL_GLSL` in `src/engine/beamPools.ts`.
 * Evaluates the derivative-filtered 8-facet prism pool profile at normalized beam coordinate `(u, v)`.
 */
export function prismPoolProfile(
  u: number,
  v: number,
  reach: number,
  phase: number,
  jxX = 0,
  jxY = 0,
  jyX = 0,
  jyY = 0,
  prismMix = 1,
): number {
  const rSq = u * u + v * v;
  if (!Number.isFinite(rSq) || rSq >= 1) return 0;
  const r = Math.sqrt(Math.max(0, rSq));
  const baseProfile = baseBeamPoolProfile(r);
  const clampedMix = Math.max(0, Math.min(1, Number.isFinite(prismMix) ? prismMix : 0));
  const clampedReach = Math.max(0, Math.min(1, Number.isFinite(reach) ? reach : 0));
  const reachMix = smoothstep(PRISM_MIX_REACH_START, PRISM_MIX_REACH_END, clampedReach);
  if (clampedMix <= 0.001 || reachMix <= 0.001) return baseProfile;

  let cJxX = Number.isFinite(jxX) ? jxX : 0;
  let cJxY = Number.isFinite(jxY) ? jxY : 0;
  let cJyX = Number.isFinite(jyX) ? jyX : 0;
  let cJyY = Number.isFinite(jyY) ? jyY : 0;
  const jxLen = Math.hypot(cJxX, cJxY);
  if (jxLen > PRISM_MAX_JACOBIAN_LEN) {
    const s = PRISM_MAX_JACOBIAN_LEN / jxLen;
    cJxX *= s;
    cJxY *= s;
  }
  const jyLen = Math.hypot(cJyX, cJyY);
  if (jyLen > PRISM_MAX_JACOBIAN_LEN) {
    const s = PRISM_MAX_JACOBIAN_LEN / jyLen;
    cJyX *= s;
    cJyY *= s;
  }

  const sxx = PRISM_SIGMA_SQ + PRISM_FILTER_K * (cJxX * cJxX + cJyX * cJyX);
  const syy = PRISM_SIGMA_SQ + PRISM_FILTER_K * (cJxY * cJxY + cJyY * cJyY);
  const sxy = PRISM_FILTER_K * (cJxX * cJxY + cJyX * cJyY);
  const det = Math.max(sxx * syy - sxy * sxy, PRISM_SIGMA_SQ * PRISM_SIGMA_SQ);
  const invDet = 1 / det;
  const m00 = 0.5 * syy * invDet;
  const m11 = 0.5 * sxx * invDet;
  const m01 = -0.5 * sxy * invDet;
  const normAmp = PRISM_SIGMA_SQ / Math.sqrt(det);

  const safePhase = Number.isFinite(phase) ? phase : 0;
  const ringR = PRISM_RING_RADIUS * smoothstep(0, PRISM_REACH_RAMP_END, clampedReach);
  const d0x = Math.sin(safePhase) * ringR;
  const d0y = -Math.cos(safePhase) * ringR;
  const d2x = -d0y;
  const d2y = d0x;
  const d1x = (d0x + d2x) * INV_SQRT2;
  const d1y = (d0y + d2y) * INV_SQRT2;
  const d3x = (d2x - d0x) * INV_SQRT2;
  const d3y = (d2y - d0y) * INV_SQRT2;

  const evalSpot = (dx: number, dy: number) => Math.exp(-(m00 * dx * dx + 2 * m01 * dx * dy + m11 * dy * dy));
  const spots =
    evalSpot(u - d0x, v - d0y) + evalSpot(u + d0x, v + d0y) +
    evalSpot(u - d1x, v - d1y) + evalSpot(u + d1x, v + d1y) +
    evalSpot(u - d2x, v - d2y) + evalSpot(u + d2x, v + d2y) +
    evalSpot(u - d3x, v - d3y) + evalSpot(u + d3x, v + d3y);

  const outerMask = 1 - smoothstep(PRISM_OUTER_MASK_START, PRISM_OUTER_MASK_END, r);
  const prismVal = PRISM_AMBIENT_SHARE * baseProfile + (PRISM_SPOT_GAIN * normAmp * spots) * outerMask;

  const tr = sxx + syy;
  const df = sxx - syy;
  const maxEig = 0.5 * (tr + Math.sqrt(Math.max(0, df * df + 4 * sxy * sxy)));
  const minifyMix = 1 - smoothstep(PRISM_MINIFY_START, PRISM_MINIFY_END, Math.sqrt(Math.max(maxEig, PRISM_SIGMA_SQ)));
  const blend = clampedMix * reachMix * minifyMix;
  const out = baseProfile * (1 - blend) + prismVal * blend;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

/** Total additional application-buffer bytes required for prism attributes across all receivers. */
export function prismExtraBufferBytes(capacity: number, receiverCount: number): number {
  const cap = Math.max(0, Math.floor(Number.isFinite(capacity) ? capacity : 0));
  const rec = Math.max(0, Math.floor(Number.isFinite(receiverCount) ? receiverCount : 0));
  return cap * rec * PRISM_POOL_BYTES_PER_INSTANCE;
}

/** Explicit `< 0.1 MiB` application-buffer admission check before allocating prism receiver attributes. */
export function canAdmitPrismBuffers(capacity: number, receiverCount: number): boolean {
  return prismExtraBufferBytes(capacity, receiverCount) <= PRISM_POOL_MAX_EXTRA_BYTES;
}

/**
 * Pure hysteresis guard for low-tier overlapping prism pools.
 * High tier is never overlap-suppressed. Low tier suppresses above the high-water threshold
 * and resumes once overlap drops to or below the low-water threshold, preventing boundary flicker.
 */
export function stepPrismOverlapGuard(
  prevSuppressed: boolean,
  maxReceiverPrismCount: number,
  totalPrismCount: number,
  tier: RenderTier,
): boolean {
  if (tier !== 'low') return false;
  if (prevSuppressed) {
    return maxReceiverPrismCount > LOW_TIER_PRISM_SUPPRESS_LOW || totalPrismCount > LOW_TIER_PRISM_TOTAL_LOW;
  }
  return maxReceiverPrismCount > LOW_TIER_PRISM_SUPPRESS_HIGH || totalPrismCount > LOW_TIER_PRISM_TOTAL_HIGH;
}

const glslNum = (n: number) => {
  const s = n.toFixed(9).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
};

/**
 * GLSL snippet interpolated directly from the exported TypeScript constants so CPU tests
 * and GPU fragment evaluation share identical math and constants.
 */
export const PRISM_POOL_EVAL_GLSL = /* glsl */ `
  float evalPrismPoolProfile(
    float baseProfile,
    vec2 q,
    float r,
    float reach,
    vec2 dir0,
    vec2 jx,
    vec2 jy,
    float prismMix
  ) {
    float clampedMix = clamp(prismMix, 0.0, 1.0);
    float reachMix = smoothstep(${glslNum(PRISM_MIX_REACH_START)}, ${glslNum(PRISM_MIX_REACH_END)}, reach);
    if (clampedMix <= 0.001 || reachMix <= 0.001) return baseProfile;
    float jxLen = length(jx);
    if (jxLen > ${glslNum(PRISM_MAX_JACOBIAN_LEN)}) jx *= ${glslNum(PRISM_MAX_JACOBIAN_LEN)} / jxLen;
    float jyLen = length(jy);
    if (jyLen > ${glslNum(PRISM_MAX_JACOBIAN_LEN)}) jy *= ${glslNum(PRISM_MAX_JACOBIAN_LEN)} / jyLen;
    float sxx = ${glslNum(PRISM_SIGMA_SQ)} + ${glslNum(PRISM_FILTER_K)} * (jx.x * jx.x + jy.x * jy.x);
    float syy = ${glslNum(PRISM_SIGMA_SQ)} + ${glslNum(PRISM_FILTER_K)} * (jx.y * jx.y + jy.y * jy.y);
    float sxy = ${glslNum(PRISM_FILTER_K)} * (jx.x * jx.y + jy.x * jy.y);
    float det = max(sxx * syy - sxy * sxy, ${glslNum(PRISM_SIGMA_SQ * PRISM_SIGMA_SQ)});
    float invDet = 1.0 / det;
    float m00 = 0.5 * syy * invDet;
    float m11 = 0.5 * sxx * invDet;
    float m01 = -0.5 * sxy * invDet;
    float normAmp = ${glslNum(PRISM_SIGMA_SQ)} * inversesqrt(det);
    float ringR = ${glslNum(PRISM_RING_RADIUS)} * smoothstep(0.0, ${glslNum(PRISM_REACH_RAMP_END)}, reach);
    vec2 d0 = dir0 * ringR;
    vec2 d2 = vec2(-d0.y, d0.x);
    vec2 d1 = (d0 + d2) * 0.707106781;
    vec2 d3 = (d2 - d0) * 0.707106781;
    float spots = 0.0;
    vec2 p;
    p = q - d0; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q + d0; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q - d1; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q + d1; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q - d2; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q + d2; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q - d3; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    p = q + d3; spots += exp(-(m00 * p.x * p.x + 2.0 * m01 * p.x * p.y + m11 * p.y * p.y));
    float outerMask = 1.0 - smoothstep(${glslNum(PRISM_OUTER_MASK_START)}, ${glslNum(PRISM_OUTER_MASK_END)}, r);
    float prismVal = ${glslNum(PRISM_AMBIENT_SHARE)} * baseProfile + (${glslNum(PRISM_SPOT_GAIN)} * normAmp * spots) * outerMask;
    float tr = sxx + syy;
    float df = sxx - syy;
    float maxEig = 0.5 * (tr + sqrt(max(0.0, df * df + 4.0 * sxy * sxy)));
    float minifyMix = 1.0 - smoothstep(${glslNum(PRISM_MINIFY_START)}, ${glslNum(PRISM_MINIFY_END)}, sqrt(max(maxEig, ${glslNum(PRISM_SIGMA_SQ)})));
    return mix(baseProfile, prismVal, clampedMix * reachMix * minifyMix);
  }
`;
