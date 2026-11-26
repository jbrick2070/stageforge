import * as THREE from 'three';
import type { RenderTier } from './hardwareMaterials';

/**
 * Restrained crowd show-light response model & material controller (Sprint 19).
 *
 * Artistic lighting approximation (not per-person beam tracing):
 * - Low tier (`#define CROWD_SHOW_LIGHTS 1`): one aggregate show-light direction & colour.
 * - High tier (`#define CROWD_SHOW_LIGHTS 2`): two spatially separated stage-hemisphere
 *   directions (house-left / house-right with smooth cross-fade across `x = 0`).
 * - Per-eye view-space transformation via Three.js's built-in `viewMatrix` and `vViewPosition`
 *   (stereo-safe for WebXR with zero CPU camera caching).
 * - Light-side and forward-scatter gated rim plus upper-body height mask prevent uniform
 *   glowing silhouette outlines around ankles, away-facing edges, or front-lit reverse views.
 * - Hue-preserving headroom clamp keeps crowd show-light additions strictly `<= 0.56`
 *   (below StageEngine's `0.66` bloom threshold); pre-existing direct/indirect lighting
 *   already above `0.56` is left untouched.
 */

export const CROWD_FILL_GAIN = 0.30;
export const CROWD_RIM_GAIN = 0.46;
export const CROWD_FRESNEL_POWER = 2.8;
export const CROWD_ADDED_KNEE = 0.24;
export const CROWD_MAX_ADDED_RADIANCE = 0.28;
export const CROWD_MAX_OUTGOING_RADIANCE = 0.56;
export const CROWD_HEIGHT_LO = 0.55;
export const CROWD_HEIGHT_HI = 1.45;
export const CROWD_HEMISPHERE_HALF_SPAN_M = 2.5;
export const CROWD_MIN_ELEVATION_Y = 0.18;

const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

export function crowdLightSlotsForTier(tier: RenderTier): 1 | 2 {
  return tier === 'high' ? 2 : 1;
}

export interface CrowdTransformPoint {
  x: number;
  y: number;
  z: number;
}

export interface CrowdHeadSample {
  lastPreviewIntensity: number;
  lastPreviewR: number;
  lastPreviewG: number;
  lastPreviewB: number;
  fluxRatio?: number;
  optics?: { fluxRatio: number };
  lastWorldX: number;
  lastWorldY: number;
  lastWorldZ: number;
  lastAimZ: number;
}

export interface CrowdFrameInputs {
  blackout: boolean;
  master: number;
  roomGain: number;
  blinder: number;
  strobeBarBright: number;
  ledBright: number;
  hasLedWalls: boolean;
  laserInt: number;
  hasLasers: boolean;
  primaryR: number;
  primaryG: number;
  primaryB: number;
  accentR: number;
  accentG: number;
  accentB: number;
  stageWidth: number;
  stageDepth: number;
}

export interface CrowdShowLightState {
  slotCount: 1 | 2;
  dir0: THREE.Vector3;
  color0: THREE.Color;
  dir1: THREE.Vector3;
  color1: THREE.Color;
}

export interface CrowdUniformBag {
  uCrowdLightDir0: { value: THREE.Vector3 };
  uCrowdLightColor0: { value: THREE.Color };
  uCrowdLightDir1: { value: THREE.Vector3 };
  uCrowdLightColor1: { value: THREE.Color };
}

export interface CrowdLightingStats {
  requested: boolean;
  active: boolean;
  tier: RenderTier;
  lightSlotCount: 0 | 1 | 2;
  spectatorCount: number;
  seated: boolean;
  phoneCount: number;
  phonesShareInstanceMatrix: boolean;
  crowdCenter: [number, number, number];
  lights: Array<{
    dir: [number, number, number];
    color: [number, number, number];
  }>;
}

export function createCrowdFrameInputs(): CrowdFrameInputs {
  return {
    blackout: false,
    master: 1,
    roomGain: 1,
    blinder: 0,
    strobeBarBright: 0,
    ledBright: 0,
    hasLedWalls: false,
    laserInt: 0,
    hasLasers: false,
    primaryR: 0,
    primaryG: 0,
    primaryB: 0,
    accentR: 0,
    accentG: 0,
    accentB: 0,
    stageWidth: 22,
    stageDepth: 11,
  };
}

const DEFAULT_DIR_SINGLE = new THREE.Vector3(0, 0.48, -0.877268).normalize();
const DEFAULT_DIR_LEFT = new THREE.Vector3(-0.38, 0.46, -0.802496).normalize();
const DEFAULT_DIR_RIGHT = new THREE.Vector3(0.38, 0.46, -0.802496).normalize();

export function createCrowdShowLightState(tier: RenderTier = 'high'): CrowdShowLightState {
  const slotCount = crowdLightSlotsForTier(tier);
  return {
    slotCount,
    dir0: (slotCount === 1 ? DEFAULT_DIR_SINGLE : DEFAULT_DIR_LEFT).clone(),
    color0: new THREE.Color(0, 0, 0),
    dir1: DEFAULT_DIR_RIGHT.clone(),
    color1: new THREE.Color(0, 0, 0),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(x) || edge1 === edge0) return 0.5;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Compute deterministic audience chest/shoulder reference centroid from `crowdBaseTransforms`.
 * Works across standing floors (Arena, Warehouse, Festival, Club) and raked Theatre stalls.
 */
export function computeCrowdCenter(
  transforms: readonly CrowdTransformPoint[],
  stageDepth = 11,
): { x: number; y: number; z: number } {
  if (!transforms || transforms.length === 0) {
    const safeDepth = Number.isFinite(stageDepth) && stageDepth > 0 ? stageDepth : 11;
    return { x: 0, y: 1.25, z: safeDepth * 0.5 + 10 };
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let count = 0;
  for (let i = 0; i < transforms.length; i++) {
    const p = transforms[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    sx += p.x;
    sy += p.y + 1.25;
    sz += p.z;
    count++;
  }
  if (count === 0) {
    return { x: 0, y: 1.25, z: 15.5 };
  }
  return { x: sx / count, y: sy / count, z: sz / count };
}

function writeNormalizedDirection(
  srcX: number,
  srcY: number,
  srcZ: number,
  center: { x: number; y: number; z: number },
  fallback: THREE.Vector3,
  out: THREE.Vector3,
): void {
  let dx = srcX - center.x;
  let dy = srcY - center.y;
  let dz = srcZ - center.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
    out.copy(fallback);
    return;
  }
  const horiz = Math.hypot(dx, dz);
  const minDy = Math.max(0.20, horiz * CROWD_MIN_ELEVATION_Y);
  if (dy < minDy) dy = minDy;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (!Number.isFinite(lenSq) || lenSq <= 1e-10) {
    out.copy(fallback);
    return;
  }
  const inv = 1 / Math.sqrt(lenSq);
  out.set(dx * inv, dy * inv, dz * inv);
}

/**
 * Zero-allocation aggregate show-light solver.
 * Every input in `heads` and `frame` must already be preview-flash-governed by `StageEngine`.
 * Preserves exact energy sum across 1-slot (`low`) and 2-slot (`high`) tiers before soft pre-compression.
 */
export function evaluateCrowdShowLights(
  tier: RenderTier,
  crowdCenter: { x: number; y: number; z: number },
  heads: readonly CrowdHeadSample[],
  frame: CrowdFrameInputs,
  out: CrowdShowLightState,
): CrowdShowLightState {
  const slotCount = crowdLightSlotsForTier(tier);
  out.slotCount = slotCount;

  if (
    frame.blackout ||
    !Number.isFinite(frame.master) ||
    frame.master <= 0.001 ||
    !Number.isFinite(frame.roomGain) ||
    frame.roomGain <= 0.001
  ) {
    out.color0.setRGB(0, 0, 0);
    out.color1.setRGB(0, 0, 0);
    out.dir0.copy(slotCount === 1 ? DEFAULT_DIR_SINGLE : DEFAULT_DIR_LEFT);
    out.dir1.copy(DEFAULT_DIR_RIGHT);
    return out;
  }

  const roomGain = clamp01(frame.roomGain);
  const stageW = Number.isFinite(frame.stageWidth) && frame.stageWidth > 1 ? frame.stageWidth : 22;
  const stageD = Number.isFinite(frame.stageDepth) && frame.stageDepth > 1 ? frame.stageDepth : 11;
  const pR = clamp01(frame.primaryR);
  const pG = clamp01(frame.primaryG);
  const pB = clamp01(frame.primaryB);
  const aR = clamp01(frame.accentR);
  const aG = clamp01(frame.accentG);
  const aB = clamp01(frame.accentB);

  let colLr = 0;
  let colLg = 0;
  let colLb = 0;
  let posLx = 0;
  let posLy = 0;
  let posLz = 0;
  let wPosL = 0;

  let colRr = 0;
  let colRg = 0;
  let colRb = 0;
  let posRx = 0;
  let posRy = 0;
  let posRz = 0;
  let wPosR = 0;

  const addSource = (
    sx: number,
    sy: number,
    sz: number,
    r: number,
    g: number,
    b: number,
    rightFraction?: number,
  ) => {
    if (r <= 1e-6 && g <= 1e-6 && b <= 1e-6) return;
    const wR = rightFraction !== undefined
      ? clamp01(rightFraction)
      : smoothstep(-CROWD_HEMISPHERE_HALF_SPAN_M, CROWD_HEMISPHERE_HALF_SPAN_M, sx);
    const wL = 1 - wR;
    const lum = Math.max(r, g, b, 1e-5);
    if (wL > 1e-6) {
      colLr += r * wL;
      colLg += g * wL;
      colLb += b * wL;
      const pw = lum * wL;
      posLx += sx * pw;
      posLy += sy * pw;
      posLz += sz * pw;
      wPosL += pw;
    }
    if (wR > 1e-6) {
      colRr += r * wR;
      colRg += g * wR;
      colRb += b * wR;
      const pw = lum * wR;
      posRx += sx * pw;
      posRy += sy * pw;
      posRz += sz * pw;
      wPosR += pw;
    }
  };

  // 1. Moving heads & washes (already governed per unit in StageEngine)
  const headNorm = 1.15 / Math.max(4, heads.length);
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!Number.isFinite(h.lastPreviewIntensity) || h.lastPreviewIntensity <= 0.001) continue;
    const rawFlux = h.optics ? h.optics.fluxRatio : (h.fluxRatio ?? 1.0);
    const flux = Number.isFinite(rawFlux) && rawFlux > 0 ? Math.min(2.0, rawFlux) : 1.0;
    const aimZ = Number.isFinite(h.lastAimZ) ? h.lastAimZ : 0;
    // Heads sweeping toward the audience (+Z) couple more strongly than heads aimed straight down at the deck.
    const aimFactor = 0.42 + 0.58 * clamp01((aimZ + 0.25) / 1.10);
    const e = Math.min(1.6, h.lastPreviewIntensity) * flux * aimFactor * headNorm * roomGain;
    const sx = Number.isFinite(h.lastWorldX) ? h.lastWorldX : 0;
    const sy = Number.isFinite(h.lastWorldY) ? h.lastWorldY : 8.5;
    const sz = Number.isFinite(h.lastWorldZ) ? h.lastWorldZ : 0;
    addSource(
      sx,
      sy,
      sz,
      clamp01(h.lastPreviewR) * e,
      clamp01(h.lastPreviewG) * e,
      clamp01(h.lastPreviewB) * e,
    );
  }

  // 2. Audience blinders (warm amber #ffbe55 facing directly into the house)
  if (Number.isFinite(frame.blinder) && frame.blinder > 0.001) {
    const blE = Math.min(1.2, frame.blinder) * 0.42 * roomGain;
    addSource(-stageW * 0.22, 8.8, stageD * 0.45, 1.0 * blE, 0.745 * blE, 0.333 * blE, 0);
    addSource(stageW * 0.22, 8.8, stageD * 0.45, 1.0 * blE, 0.745 * blE, 0.333 * blE, 1);
  }

  // 3. Governed strobe bars
  if (Number.isFinite(frame.strobeBarBright) && frame.strobeBarBright > 0.01) {
    const stE = Math.min(1.0, frame.strobeBarBright / 3.8) * 0.26 * roomGain;
    const sr = (0.65 + 0.35 * pR) * stE;
    const sg = (0.65 + 0.35 * pG) * stE;
    const sb = (0.65 + 0.35 * pB) * stE;
    addSource(-stageW * 0.20, 9.2, stageD * 0.35, sr, sg, sb, 0);
    addSource(stageW * 0.20, 9.2, stageD * 0.35, sr, sg, sb, 1);
  }

  // 4. LED video wall spill (primary left, accent right)
  if (frame.hasLedWalls && Number.isFinite(frame.ledBright) && frame.ledBright > 0.001) {
    const ledE = clamp01(frame.ledBright) * 0.22 * roomGain;
    addSource(-stageW * 0.24, 5.5, -stageD * 0.35, pR * ledE, pG * ledE, pB * ledE, 0);
    addSource(stageW * 0.24, 5.5, -stageD * 0.35, aR * ledE, aG * ledE, aB * ledE, 1);
  }

  // 5. Lasers (subtle aerial scatter contribution)
  if (frame.hasLasers && Number.isFinite(frame.laserInt) && frame.laserInt > 0.001) {
    const lzE = Math.min(1.5, frame.laserInt) * 0.08 * roomGain;
    addSource(-stageW * 0.18, 7.5, 0, pR * lzE, pG * lzE, pB * lzE, 0);
    addSource(stageW * 0.18, 7.5, 0, aR * lzE, aG * lzE, aB * lzE, 1);
  }

  // Shared pre-compression scale across total energy so 1-slot low tier and 2-slot high tier match total radiance.
  const totR = colLr + colRr;
  const totG = colLg + colRg;
  const totB = colLb + colRb;
  const totalPeak = Math.max(totR, totG, totB);
  const energyScale = totalPeak > 1e-6
    ? (1.20 * (totalPeak / (totalPeak + 0.45))) / totalPeak
    : 0;

  if (slotCount === 1) {
    out.color0.setRGB(totR * energyScale, totG * energyScale, totB * energyScale);
    out.color1.setRGB(0, 0, 0);
    const wTot = wPosL + wPosR;
    if (wTot > 1e-6) {
      writeNormalizedDirection(
        (posLx + posRx) / wTot,
        (posLy + posRy) / wTot,
        (posLz + posRz) / wTot,
        crowdCenter,
        DEFAULT_DIR_SINGLE,
        out.dir0,
      );
    } else {
      out.dir0.copy(DEFAULT_DIR_SINGLE);
    }
    out.dir1.copy(DEFAULT_DIR_RIGHT);
  } else {
    out.color0.setRGB(colLr * energyScale, colLg * energyScale, colLb * energyScale);
    out.color1.setRGB(colRr * energyScale, colRg * energyScale, colRb * energyScale);
    if (wPosL > 1e-6) {
      writeNormalizedDirection(posLx / wPosL, posLy / wPosL, posLz / wPosL, crowdCenter, DEFAULT_DIR_LEFT, out.dir0);
    } else {
      out.dir0.copy(DEFAULT_DIR_LEFT);
    }
    if (wPosR > 1e-6) {
      writeNormalizedDirection(posRx / wPosR, posRy / wPosR, posRz / wPosR, crowdCenter, DEFAULT_DIR_RIGHT, out.dir1);
    } else {
      out.dir1.copy(DEFAULT_DIR_RIGHT);
    }
  }

  return out;
}

export interface CrowdFragmentEvalInput {
  baseOutgoing: { r: number; g: number; b: number };
  diffuseColor: { r: number; g: number; b: number };
  viewNormal: { x: number; y: number; z: number };
  viewDir: { x: number; y: number; z: number };
  localY: number;
  lights: ReadonlyArray<{
    viewLightDir: { x: number; y: number; z: number };
    color: { r: number; g: number; b: number };
  }>;
}

/**
 * Exact CPU reference oracle matching the injected `MeshStandardMaterial` fragment shader.
 */
export function evaluateCrowdFragmentShading(input: CrowdFragmentEvalInput): {
  outgoing: { r: number; g: number; b: number };
  added: { r: number; g: number; b: number };
} {
  const baseR = Math.max(0, Number.isFinite(input.baseOutgoing.r) ? input.baseOutgoing.r : 0);
  const baseG = Math.max(0, Number.isFinite(input.baseOutgoing.g) ? input.baseOutgoing.g : 0);
  const baseB = Math.max(0, Number.isFinite(input.baseOutgoing.b) ? input.baseOutgoing.b : 0);

  const nLen = Math.hypot(input.viewNormal.x, input.viewNormal.y, input.viewNormal.z);
  const vLen = Math.hypot(input.viewDir.x, input.viewDir.y, input.viewDir.z);
  if (!Number.isFinite(nLen) || !Number.isFinite(vLen) || nLen <= 1e-8 || vLen <= 1e-8) {
    return { outgoing: { r: baseR, g: baseG, b: baseB }, added: { r: 0, g: 0, b: 0 } };
  }

  const nx = input.viewNormal.x / nLen;
  const ny = input.viewNormal.y / nLen;
  const nz = input.viewNormal.z / nLen;
  const vx = input.viewDir.x / vLen;
  const vy = input.viewDir.y / vLen;
  const vz = input.viewDir.z / vLen;

  const heightMask = smoothstep(CROWD_HEIGHT_LO, CROWD_HEIGHT_HI, input.localY);
  const ndv = clamp01(nx * vx + ny * vy + nz * vz);
  const fresnel = (1 - ndv) ** CROWD_FRESNEL_POWER;

  const albR = 0.36 + 0.72 * (clamp01(input.diffuseColor.r) - 0.36);
  const albG = 0.36 + 0.72 * (clamp01(input.diffuseColor.g) - 0.36);
  const albB = 0.36 + 0.72 * (clamp01(input.diffuseColor.b) - 0.36);

  let addR = 0;
  let addG = 0;
  let addB = 0;

  for (let i = 0; i < input.lights.length; i++) {
    const l = input.lights[i];
    const lr = Math.max(0, Number.isFinite(l.color.r) ? l.color.r : 0);
    const lg = Math.max(0, Number.isFinite(l.color.g) ? l.color.g : 0);
    const lb = Math.max(0, Number.isFinite(l.color.b) ? l.color.b : 0);
    if (lr <= 1e-6 && lg <= 1e-6 && lb <= 1e-6) continue;
    const lLen = Math.hypot(l.viewLightDir.x, l.viewLightDir.y, l.viewLightDir.z);
    if (!Number.isFinite(lLen) || lLen <= 1e-8) continue;
    const lx = l.viewLightDir.x / lLen;
    const ly = l.viewLightDir.y / lLen;
    const lz = l.viewLightDir.z / lLen;

    const ndl = nx * lx + ny * ly + nz * lz;
    const wrap = clamp01((ndl + 0.30) / 1.30);
    const fillFactor = CROWD_FILL_GAIN * wrap * wrap * (0.25 + 0.75 * heightMask);

    const lightAlign = smoothstep(-0.32, 0.42, ndl);
    const negVdotL = (-vx) * lx + (-vy) * ly + (-vz) * lz;
    const backScatter = smoothstep(-0.15, 0.65, negVdotL);
    const rimFactor =
      CROWD_RIM_GAIN * fresnel * lightAlign * backScatter * (0.20 + 0.80 * heightMask);

    const rimTintR = lr * (0.75 + 0.25 * albR);
    const rimTintG = lg * (0.75 + 0.25 * albG);
    const rimTintB = lb * (0.75 + 0.25 * albB);

    addR += lr * albR * fillFactor + rimTintR * rimFactor;
    addG += lg * albG * fillFactor + rimTintG * rimFactor;
    addB += lb * albB * fillFactor + rimTintB * rimFactor;
  }

  // Soft-knee compress added radiance while preserving RGB hue ratios.
  const rawPeak = Math.max(addR, addG, addB);
  if (rawPeak > 1e-6) {
    const compressed = CROWD_MAX_ADDED_RADIANCE * (rawPeak / (rawPeak + CROWD_ADDED_KNEE));
    const kneeScale = Math.min(1, compressed / rawPeak);
    addR *= kneeScale;
    addG *= kneeScale;
    addB *= kneeScale;
  }

  // Hue-preserving headroom clamp: crowd show-light additions cannot push any channel above 0.56,
  // while pre-existing lighting above 0.56 is left untouched.
  const basePeak = Math.max(baseR, baseG, baseB);
  const headroom = Math.max(0, CROWD_MAX_OUTGOING_RADIANCE - basePeak);
  const postPeak = Math.max(addR, addG, addB);
  if (postPeak > headroom) {
    const headScale = postPeak > 1e-6 ? headroom / postPeak : 0;
    addR *= headScale;
    addG *= headScale;
    addB *= headScale;
  }

  return {
    outgoing: { r: baseR + addR, g: baseG + addG, b: baseB + addB },
    added: { r: addR, g: addG, b: addB },
  };
}

const CROWD_VERTEX_PARS_GLSL = (slotCount: 1 | 2) => /* glsl */ `
#define CROWD_SHOW_LIGHTS ${slotCount}
uniform vec3 uCrowdLightDir0;
varying vec3 vCrowdViewLightDir0;
#if CROWD_SHOW_LIGHTS > 1
uniform vec3 uCrowdLightDir1;
varying vec3 vCrowdViewLightDir1;
#endif
varying float vCrowdHeight;
`;

const CROWD_VERTEX_BODY_GLSL = /* glsl */ `
	vCrowdHeight = smoothstep(${glslFloat(CROWD_HEIGHT_LO)}, ${glslFloat(CROWD_HEIGHT_HI)}, transformed.y);
	vCrowdViewLightDir0 = (viewMatrix * vec4(uCrowdLightDir0, 0.0)).xyz;
	#if CROWD_SHOW_LIGHTS > 1
	vCrowdViewLightDir1 = (viewMatrix * vec4(uCrowdLightDir1, 0.0)).xyz;
	#endif
`;

const CROWD_FRAGMENT_PARS_GLSL = (slotCount: 1 | 2) => /* glsl */ `
#define CROWD_SHOW_LIGHTS ${slotCount}
uniform vec3 uCrowdLightColor0;
varying vec3 vCrowdViewLightDir0;
#if CROWD_SHOW_LIGHTS > 1
uniform vec3 uCrowdLightColor1;
varying vec3 vCrowdViewLightDir1;
#endif
varying float vCrowdHeight;

vec3 evaluateSingleCrowdShowLight(
	vec3 viewNormal,
	vec3 viewDir,
	vec3 rawViewLightDir,
	vec3 lightColor,
	vec3 tintAlbedo,
	float fresnel,
	float heightMask
) {
	float cPeak = max(lightColor.r, max(lightColor.g, lightColor.b));
	float lLenSq = dot(rawViewLightDir, rawViewLightDir);
	if (cPeak <= 1e-6 || lLenSq <= 1e-10) {
		return vec3(0.0);
	}
	vec3 L = rawViewLightDir * inversesqrt(lLenSq);
	float ndl = dot(viewNormal, L);
	float wrap = clamp((ndl + 0.30) / 1.30, 0.0, 1.0);
	float fillFactor = ${glslFloat(CROWD_FILL_GAIN)} * wrap * wrap * (0.25 + 0.75 * heightMask);
	float lightAlign = smoothstep(-0.32, 0.42, ndl);
	float backScatter = smoothstep(-0.15, 0.65, dot(-viewDir, L));
	float rimFactor = ${glslFloat(CROWD_RIM_GAIN)} * fresnel * lightAlign * backScatter * (0.20 + 0.80 * heightMask);
	vec3 rimTint = lightColor * (vec3(0.75) + 0.25 * tintAlbedo);
	return lightColor * tintAlbedo * fillFactor + rimTint * rimFactor;
}
`;

const CROWD_FRAGMENT_APPLY_GLSL = /* glsl */ `
	{
		float crowdViewLenSq = dot(vViewPosition, vViewPosition);
		if (crowdViewLenSq > 1e-10) {
			vec3 crowdV = vViewPosition * inversesqrt(crowdViewLenSq);
			vec3 crowdN = normal;
			float crowdNdv = clamp(dot(crowdN, crowdV), 0.0, 1.0);
			float crowdFresnel = pow(1.0 - crowdNdv, ${glslFloat(CROWD_FRESNEL_POWER)});
			float crowdH = clamp(vCrowdHeight, 0.0, 1.0);
			vec3 crowdAlbedo = mix(vec3(0.36), clamp(diffuseColor.rgb, vec3(0.0), vec3(1.0)), 0.72);
			vec3 crowdAdded = evaluateSingleCrowdShowLight(
				crowdN, crowdV, vCrowdViewLightDir0, uCrowdLightColor0, crowdAlbedo, crowdFresnel, crowdH
			);
			#if CROWD_SHOW_LIGHTS > 1
			crowdAdded += evaluateSingleCrowdShowLight(
				crowdN, crowdV, vCrowdViewLightDir1, uCrowdLightColor1, crowdAlbedo, crowdFresnel, crowdH
			);
			#endif
			float crowdRawPeak = max(crowdAdded.r, max(crowdAdded.g, crowdAdded.b));
			if (crowdRawPeak > 1e-6) {
				float crowdCompressed = ${glslFloat(CROWD_MAX_ADDED_RADIANCE)} * (crowdRawPeak / (crowdRawPeak + ${glslFloat(CROWD_ADDED_KNEE)}));
				crowdAdded *= min(1.0, crowdCompressed / crowdRawPeak);
			}
			float crowdBasePeak = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
			float crowdHeadroom = max(0.0, ${glslFloat(CROWD_MAX_OUTGOING_RADIANCE)} - crowdBasePeak);
			float crowdPostPeak = max(crowdAdded.r, max(crowdAdded.g, crowdAdded.b));
			if (crowdPostPeak > crowdHeadroom) {
				crowdAdded *= crowdPostPeak > 1e-6 ? (crowdHeadroom / crowdPostPeak) : 0.0;
			}
			outgoingLight += crowdAdded;
		}
	}
`;

export function createCrowdUniformBag(): CrowdUniformBag {
  return {
    uCrowdLightDir0: { value: DEFAULT_DIR_LEFT.clone() },
    uCrowdLightColor0: { value: new THREE.Color(0, 0, 0) },
    uCrowdLightDir1: { value: DEFAULT_DIR_RIGHT.clone() },
    uCrowdLightColor1: { value: new THREE.Color(0, 0, 0) },
  };
}

/**
 * Patch a Three.js `MeshStandardMaterial` shader parameter object (`onBeforeCompile`)
 * with `CROWD_SHOW_LIGHTS` (`1` on low tier, `2` on high tier).
 */
export function patchCrowdStandardShader(
  shader: {
    uniforms: Record<string, THREE.IUniform>;
    vertexShader: string;
    fragmentShader: string;
  },
  slotCount: 1 | 2,
  uniforms: CrowdUniformBag,
): void {
  shader.uniforms.uCrowdLightDir0 = uniforms.uCrowdLightDir0;
  shader.uniforms.uCrowdLightColor0 = uniforms.uCrowdLightColor0;
  if (slotCount > 1) {
    shader.uniforms.uCrowdLightDir1 = uniforms.uCrowdLightDir1;
    shader.uniforms.uCrowdLightColor1 = uniforms.uCrowdLightColor1;
  }

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>\n${CROWD_VERTEX_PARS_GLSL(slotCount)}`,
    )
    .replace(
      '#include <morphtarget_vertex>',
      `#include <morphtarget_vertex>\n${CROWD_VERTEX_BODY_GLSL}`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\n${CROWD_FRAGMENT_PARS_GLSL(slotCount)}`,
    )
    .replace(
      '#include <opaque_fragment>',
      `${CROWD_FRAGMENT_APPLY_GLSL}\n\t#include <opaque_fragment>`,
    );
}

/**
 * StageEngine-owned lifecycle controller for Sprint 19's optional crowd show-light response.
 *
 * Keeps the venue's base `MeshStandardMaterial` 100% untouched while `crowdLighting` is `false`.
 * When enabled, binds a dedicated cloned `MeshStandardMaterial` variant onto `crowdMesh.material`
 * (avoiding Three.js `materialProperties` uniform-bag overwrite across repeated toggles on a single
 * material instance) and disposes the variant immediately on disable, rig rebuild, or engine teardown.
 */
export class CrowdLightingController {
  private requested = false;
  private disposed = false;
  private crowdMesh: THREE.InstancedMesh | null = null;
  private phonesMesh: THREE.InstancedMesh | null = null;
  private baseMaterial: THREE.MeshStandardMaterial | null = null;
  private litMaterial: THREE.MeshStandardMaterial | null = null;
  private origRenderOrder = 0;
  private seated = false;
  private crowdCenter = { x: 0, y: 1.25, z: 15.5 };
  private readonly state: CrowdShowLightState;
  private readonly uniforms: CrowdUniformBag = createCrowdUniformBag();

  constructor(private readonly tier: RenderTier) {
    this.state = createCrowdShowLightState(tier);
  }

  public bindVenue(params: {
    crowdMesh: THREE.InstancedMesh | null;
    phonesMesh: THREE.InstancedMesh | null;
    transforms: readonly CrowdTransformPoint[];
    seated: boolean;
    stageDepth: number;
  }): void {
    if (this.disposed) return;
    this.unbindVenue();
    this.crowdMesh = params.crowdMesh;
    this.phonesMesh = params.phonesMesh;
    this.origRenderOrder = params.crowdMesh ? params.crowdMesh.renderOrder : 0;
    this.seated = Boolean(params.seated);
    this.crowdCenter = computeCrowdCenter(params.transforms, params.stageDepth);
    if (params.crowdMesh && params.crowdMesh.material instanceof THREE.MeshStandardMaterial) {
      this.baseMaterial = params.crowdMesh.material;
    } else {
      this.baseMaterial = null;
    }
    if (this.requested) {
      this.activateLitMaterial();
    }
  }

  public unbindVenue(): void {
    if (this.crowdMesh && this.baseMaterial) {
      this.crowdMesh.material = this.baseMaterial;
      this.crowdMesh.renderOrder = this.origRenderOrder;
    }
    this.releaseLitMaterial();
    this.crowdMesh = null;
    this.phonesMesh = null;
    this.baseMaterial = null;
    this.origRenderOrder = 0;
  }

  public setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const next = Boolean(enabled);
    if (this.requested === next) {
      if (next && this.baseMaterial && !this.litMaterial) {
        this.activateLitMaterial();
      }
      return;
    }
    this.requested = next;
    if (next) {
      this.activateLitMaterial();
    } else {
      if (this.crowdMesh && this.baseMaterial) {
        this.crowdMesh.material = this.baseMaterial;
        this.crowdMesh.renderOrder = this.origRenderOrder;
      }
      this.releaseLitMaterial();
      this.state.color0.setRGB(0, 0, 0);
      this.state.color1.setRGB(0, 0, 0);
      this.syncUniformValues();
    }
  }

  public isActive(): boolean {
    return !this.disposed && this.requested && this.litMaterial !== null && this.crowdMesh !== null;
  }

  public updateFromScene(heads: readonly CrowdHeadSample[], frame: CrowdFrameInputs): void {
    if (!this.isActive()) return;
    evaluateCrowdShowLights(this.tier, this.crowdCenter, heads, frame, this.state);
    this.syncUniformValues();
  }

  public onContextRestored(): void {
    if (this.disposed || !this.litMaterial) return;
    this.litMaterial.needsUpdate = true;
    this.syncUniformValues();
  }

  public getStats(): CrowdLightingStats {
    const slotCount = crowdLightSlotsForTier(this.tier);
    const active = this.isActive();
    const spectatorCount = this.crowdMesh ? this.crowdMesh.count : 0;
    const phoneCount = this.phonesMesh ? this.phonesMesh.count : 0;
    const phonesShareInstanceMatrix =
      this.crowdMesh === null
        ? true
        : this.phonesMesh === null
          ? phoneCount === 0
          : this.phonesMesh.instanceMatrix === this.crowdMesh.instanceMatrix;

    const lights: CrowdLightingStats['lights'] = [];
    if (active) {
      lights.push({
        dir: [+this.state.dir0.x.toFixed(5), +this.state.dir0.y.toFixed(5), +this.state.dir0.z.toFixed(5)],
        color: [+this.state.color0.r.toFixed(5), +this.state.color0.g.toFixed(5), +this.state.color0.b.toFixed(5)],
      });
      if (slotCount > 1) {
        lights.push({
          dir: [+this.state.dir1.x.toFixed(5), +this.state.dir1.y.toFixed(5), +this.state.dir1.z.toFixed(5)],
          color: [+this.state.color1.r.toFixed(5), +this.state.color1.g.toFixed(5), +this.state.color1.b.toFixed(5)],
        });
      }
    }

    return {
      requested: this.requested,
      active,
      tier: this.tier,
      lightSlotCount: active ? slotCount : 0,
      spectatorCount,
      seated: this.seated,
      phoneCount,
      phonesShareInstanceMatrix,
      crowdCenter: [
        +this.crowdCenter.x.toFixed(3),
        +this.crowdCenter.y.toFixed(3),
        +this.crowdCenter.z.toFixed(3),
      ],
      lights,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.unbindVenue();
    this.requested = false;
    this.disposed = true;
  }

  private activateLitMaterial(): void {
    if (!this.crowdMesh || !this.baseMaterial) return;
    if (this.litMaterial && this.crowdMesh.material === this.litMaterial) return;
    this.releaseLitMaterial();

    const slotCount = crowdLightSlotsForTier(this.tier);
    const base = this.baseMaterial;
    const origBeforeCompile = base.onBeforeCompile;
    const origCacheKey = base.customProgramCacheKey;
    const lit = base.clone();
    const uniforms = this.uniforms;

    lit.onBeforeCompile = (shader, renderer) => {
      origBeforeCompile.call(lit, shader, renderer);
      patchCrowdStandardShader(shader, slotCount, uniforms);
    };
    lit.customProgramCacheKey = () => `${origCacheKey.call(lit)}|crowd-show-v1-${slotCount}`;
    lit.needsUpdate = true;

    this.litMaterial = lit;
    this.crowdMesh.material = lit;
    // Preserve baseMaterial-before-phonesMesh opaque sort order (cloned lit.id > phonesMesh.material.id).
    if (this.phonesMesh && this.origRenderOrder >= this.phonesMesh.renderOrder) {
      this.crowdMesh.renderOrder = this.phonesMesh.renderOrder - 1;
    }
    this.syncUniformValues();
  }

  private syncUniformValues(): void {
    this.uniforms.uCrowdLightDir0.value.copy(this.state.dir0);
    this.uniforms.uCrowdLightColor0.value.copy(this.state.color0);
    this.uniforms.uCrowdLightDir1.value.copy(this.state.dir1);
    this.uniforms.uCrowdLightColor1.value.copy(this.state.color1);
  }

  private releaseLitMaterial(): void {
    if (this.litMaterial) {
      this.litMaterial.dispose();
      this.litMaterial = null;
    }
  }
}
