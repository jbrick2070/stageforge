import * as THREE from 'three';
import { mulberry32 } from './prng';

export type RenderTier = 'high' | 'low';

/** Deterministic PRNG seeds documented in docs/assets.md. */
export const HARDWARE_ATLAS_SEED = 0x5f2a8c1d;
export const STAGE_DECK_SEED = 0x71b3e905;

/** Canonical stage marley deck PBR parameters shared across live renderer, Sprint 18 sheen, and GLB export. */
export const STAGE_DECK_BASE_ROUGHNESS = 0.55;
export const STAGE_DECK_BASE_METALNESS = 0.08;
export const STAGE_DECK_REPEAT_X = 6;
export const STAGE_DECK_REPEAT_Y = 3;
export const STAGE_DECK_SHEEN_NORMAL_SCALE = 0.16;

/** Sprint 18 optional deck-sheen texture payload ceilings (0.10 MiB low tier, 0.70 MiB high tier). */
export const DECK_SHEEN_LOW_MAX_BYTES = 104_857;
export const DECK_SHEEN_HIGH_MAX_BYTES = 734_003;

/**
 * Horizontal UV bands in the shared hardware PBR trim-sheet atlas.
 * Band 0 sits at v = [0, 1/8) and band 7 at v = [7/8, 1].
 */
export const HARDWARE_ATLAS_BAND_COUNT = 8;

export const enum HardwareAtlasBand {
  /** Matte/satin black powder-coat chassis paint. */
  PowderCoat = 0,
  /** Brushed dark anodised aluminium (yokes, trims, barrels). */
  AnodizedMetal = 1,
  /** Cast/milled mid-dark alloy (clamps, latches, rigging hardware). */
  CastAlloy = 2,
  /** Matte rubber feet, bumpers, and grip handles. */
  Rubber = 3,
  /** High-contrast vertical cooling/heat-sink ribs. */
  HeatSinkFins = 4,
  /** Recessed connector bay (powerCON blue/grey + 5-pin XLR + labels). */
  ConnectorPlate = 5,
  /** Symmetric recessed LCD readout + menu keys (safe when flipped for floor rigs). */
  LcdStrip = 6,
  /** Left half (u: 0..0.48): IEC laser/rigging caution stripe. Right half (u: 0.52..1): multi-cell optic bezel. */
  HazardAndCells = 7,
}

export interface GeneratedHardwareAtlas {
  size: number;
  normalSize: number;
  /** RGBA sRGB albedo bytes (size * size * 4). */
  albedo: Uint8ClampedArray;
  /** RGBA linear bytes: R=AO, G=roughness, B=metalness, A=255 (size * size * 4). */
  roughMetal: Uint8ClampedArray;
  /** RGBA tangent-space normal map bytes (normalSize * normalSize * 4). */
  normal: Uint8ClampedArray;
}

export interface RenderTierEnv {
  width: number;
  height: number;
  coarsePointer: boolean;
  cores?: number;
  deviceMemory?: number;
}

/** Pure tier selector: never demotes standard desktop windows (e.g. 1366×768 fine-pointer laptops). */
export function resolveRenderTier(env: RenderTierEnv): RenderTier {
  const minDim = Math.min(env.width, env.height);
  if (env.coarsePointer) {
    if (minDim <= 820) return 'low';
    if (env.cores !== undefined && env.cores <= 6) return 'low';
    if (env.deviceMemory !== undefined && env.deviceMemory <= 4) return 'low';
  }
  if (env.width <= 640) return 'low';
  if (env.deviceMemory !== undefined && env.deviceMemory <= 2) return 'low';
  return 'high';
}

/** Detect an appropriate default GPU render tier for the current device/viewport. */
export function detectRenderTier(): RenderTier {
  if (typeof window === 'undefined') return 'high';
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number })
    : undefined;
  return resolveRenderTier({
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
    coarsePointer: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    deviceMemory: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
  });
}

export function atlasSizeForTier(tier: RenderTier): number {
  return tier === 'low' ? 256 : 512;
}

export function deckSheenSizeForTier(tier: RenderTier): number {
  return tier === 'low' ? 128 : 256;
}

/** Exact RGBA8 base + full mip-chain payload bytes for a square power-of-two CanvasTexture. */
export function estimateMipmappedRgbaBytes(size: number): number {
  let s = Math.max(0, Math.floor(size));
  if (s === 0) return 0;
  let total = 0;
  while (s >= 1) {
    total += s * s * 4;
    if (s === 1) break;
    s = Math.max(1, s >> 1);
  }
  return total;
}

/** Application texture payload bytes added when Sprint 18 deck sheen is enabled (excludes driver alignment overhead). */
export function estimateDeckSheenTextureBytes(tier: RenderTier, enabled: boolean): number {
  if (!enabled) return 0;
  const perMap = estimateMipmappedRgbaBytes(deckSheenSizeForTier(tier));
  return tier === 'high' ? perMap * 2 : perMap;
}

export function maxPixelRatioForTier(tier: RenderTier): number {
  return tier === 'low' ? 1.5 : 2;
}

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Generate byte-deterministic trim-sheet PBR maps (albedo, packed roughness/metalness, normal)
 * purely into typed arrays so both browsers and Node unit tests execute the exact same pixels.
 */
export function generateHardwareAtlasPixels(
  size: number,
  seed: number = HARDWARE_ATLAS_SEED,
): GeneratedHardwareAtlas {
  const rand = mulberry32(seed);
  const albedo = new Uint8ClampedArray(size * size * 4);
  const roughMetal = new Uint8ClampedArray(size * size * 4);
  const heightField = new Float32Array(size * size);
  const bandH = size / HARDWARE_ATLAS_BAND_COUNT;

  // Pre-generate deterministic brushed-metal horizontal streak profile
  const rowStreaks = new Float32Array(size);
  for (let y = 0; y < size; y++) rowStreaks[y] = (rand() - 0.5) * 14;

  for (let y = 0; y < size; y++) {
    // Flip V to match CanvasTexture flipY = true (row 0 = top of image = v = 1)
    const v = 1 - (y + 0.5) / size;
    const bandFloat = v * HARDWARE_ATLAS_BAND_COUNT;
    const band = Math.min(HARDWARE_ATLAS_BAND_COUNT - 1, Math.max(0, Math.floor(bandFloat)));
    const localV = bandFloat - band; // 0..1 within band

    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const idx = (y * size + x) * 4;
      const noise = rand() - 0.5;

      let r = 24;
      let g = 26;
      let b = 32;
      let rough = 0.45;
      let metal = 0.5;
      let h = 0.5;

      switch (band) {
        case HardwareAtlasBand.PowderCoat: {
          // Fine orange-peel touring black powder-coat
          const grain = noise * 10 + Math.sin(u * 180 + v * 90) * 1.5;
          r = 25 + grain;
          g = 27 + grain;
          b = 33 + grain;
          rough = 0.48 + noise * 0.08;
          metal = 0.24;
          h = 0.5 + noise * 0.16;
          break;
        }
        case HardwareAtlasBand.AnodizedMetal: {
          // Horizontal brushed dark anodised aluminium
          const streak = rowStreaks[y] * 0.8 + noise * 5;
          r = 46 + streak;
          g = 51 + streak;
          b = 60 + streak;
          rough = 0.28 + Math.abs(streak) * 0.006;
          metal = 0.84;
          h = 0.5 + streak * 0.012;
          break;
        }
        case HardwareAtlasBand.CastAlloy: {
          // Cast/milled light-gunmetal clamp & rigging steel
          const stipple = noise * 14;
          r = 128 + stipple;
          g = 136 + stipple;
          b = 148 + stipple;
          rough = 0.34 + noise * 0.08;
          metal = 0.88;
          h = 0.5 + noise * 0.14;
          break;
        }
        case HardwareAtlasBand.Rubber: {
          // Matte vulcanised rubber feet/bumpers with subtle grip tread
          const rib = Math.sin(u * Math.PI * 32) * 0.5 + 0.5;
          r = 18 + noise * 4;
          g = 19 + noise * 4;
          b = 21 + noise * 4;
          rough = 0.88 + noise * 0.06;
          metal = 0.04;
          h = 0.45 + rib * 0.12 + noise * 0.06;
          break;
        }
        case HardwareAtlasBand.HeatSinkFins: {
          // Crisp vertical extruded heat-sink cooling fins
          const finPhase = (u * 28) % 1;
          const crest = finPhase < 0.45 ? 1 : 0;
          const baseTone = crest ? 52 : 14;
          r = baseTone + noise * 4;
          g = baseTone + 3 + noise * 4;
          b = baseTone + 7 + noise * 4;
          rough = crest ? 0.32 : 0.68;
          metal = crest ? 0.78 : 0.35;
          h = crest ? 0.85 : 0.15;
          break;
        }
        case HardwareAtlasBand.ConnectorPlate: {
          // Recessed dark steel rear I/O bay with blue/white powerCON & 5-pin XLR sockets
          const border = u < 0.04 || u > 0.96 || localV < 0.12 || localV > 0.88;
          r = border ? 48 : 20;
          g = border ? 52 : 22;
          b = border ? 58 : 26;
          rough = 0.42;
          metal = 0.65;
          h = border ? 0.7 : 0.35;

          // 4 symmetric connector circles: powerCON IN (blue), OUT (light grey), DMX IN/OUT (silver XLR)
          const sockets: readonly [number, number, number, number, number, number][] = [
            [0.20, 0.5, 0.055, 32, 118, 224],   // blue powerCON
            [0.38, 0.5, 0.055, 195, 202, 210],  // grey powerCON out
            [0.62, 0.5, 0.055, 140, 148, 158],  // 5-pin XLR in
            [0.80, 0.5, 0.055, 140, 148, 158],  // 5-pin XLR out
          ];
          for (const [cx, cy, rad, sr, sg, sb] of sockets) {
            const dx = (u - cx);
            const dy = (localV - cy) / HARDWARE_ATLAS_BAND_COUNT;
            const dist = Math.hypot(dx, dy);
            if (dist < rad * 1.15) {
              if (dist < rad * 0.55) {
                r = 10; g = 12; b = 15; rough = 0.6; metal = 0.2; h = 0.15;
              } else if (dist < rad * 0.92) {
                r = sr; g = sg; b = sb; rough = 0.35; metal = 0.55; h = 0.72;
              } else {
                r = 72; g = 78; b = 88; rough = 0.3; metal = 0.85; h = 0.82;
              }
            }
          }
          break;
        }
        case HardwareAtlasBand.LcdStrip: {
          // Symmetric base UI panel: recessed OLED display centered with 4 tactile buttons
          const inScreen = Math.abs(u - 0.5) < 0.18 && localV > 0.22 && localV < 0.78;
          const inFrame = Math.abs(u - 0.5) < 0.21 && localV > 0.16 && localV < 0.84;
          if (inScreen) {
            // Subtle symmetric pixel readout bars
            const bar = Math.abs(u - 0.5) < 0.12 && (Math.abs(localV - 0.58) < 0.06 || Math.abs(localV - 0.38) < 0.05);
            r = bar ? 78 : 16;
            g = bar ? 196 : 42;
            b = bar ? 232 : 66;
            rough = 0.14;
            metal = 0.1;
            h = 0.32;
          } else if (inFrame) {
            r = 46; g = 50; b = 58; rough = 0.35; metal = 0.72; h = 0.68;
          } else {
            r = 24 + noise * 6;
            g = 26 + noise * 6;
            b = 32 + noise * 6;
            rough = 0.46;
            metal = 0.32;
            h = 0.5;
            // Symmetric menu buttons left & right of display
            for (const bx of [0.16, 0.24, 0.76, 0.84]) {
              const dist = Math.hypot(u - bx, (localV - 0.5) / HARDWARE_ATLAS_BAND_COUNT);
              if (dist < 0.025) {
                r = 95; g = 104; b = 114; rough = 0.38; metal = 0.5; h = 0.78;
              }
            }
          }
          break;
        }
        case HardwareAtlasBand.HazardAndCells: {
          if (u < 0.5) {
            // Left half: IEC laser / rigging diagonal yellow-black hazard stripe
            const stripe = ((u * 18 + localV * 1.4) % 1) < 0.5;
            if (stripe) {
              r = 228; g = 178; b = 22; rough = 0.42; metal = 0.12; h = 0.55;
            } else {
              r = 20; g = 21; b = 24; rough = 0.52; metal = 0.18; h = 0.48;
            }
          } else {
            // Right half: multi-cell hexagonal/grid optical lens baffle array
            const cellU = ((u - 0.5) * 16) % 1;
            const cellV = (localV * 4) % 1;
            const dist = Math.hypot(cellU - 0.5, cellV - 0.5);
            if (dist < 0.34) {
              // Dark glossy optic cell recess
              r = 34; g = 42; b = 56; rough = 0.16; metal = 0.25; h = 0.22;
            } else if (dist < 0.43) {
              // Metallic reflector bevel ring
              r = 120; g = 128; b = 140; rough = 0.22; metal = 0.90; h = 0.78;
            } else {
              // Matte black baffle webbing
              r = 18; g = 19; b = 22; rough = 0.65; metal = 0.2; h = 0.62;
            }
          }
          break;
        }
      }

      albedo[idx] = clampByte(r);
      albedo[idx + 1] = clampByte(g);
      albedo[idx + 2] = clampByte(b);
      albedo[idx + 3] = 255;

      roughMetal[idx] = 255;
      roughMetal[idx + 1] = clampByte(rough * 255);
      roughMetal[idx + 2] = clampByte(metal * 255);
      roughMetal[idx + 3] = 255;

      heightField[y * size + x] = h;
    }
  }

  // Downsample height field to half-resolution tangent-space normal map (256² on high, 128² on low).
  const normalSize = Math.max(64, size >> 1);
  const normal = new Uint8ClampedArray(normalSize * normalSize * 4);
  const scale = size / normalSize;
  const strength = 2.6;

  const sampleH = (nx: number, ny: number) => {
    const sx = ((Math.floor(nx * scale) % size) + size) % size;
    const sy = Math.min(size - 1, Math.max(0, Math.floor(ny * scale)));
    return heightField[sy * size + sx];
  };

  for (let y = 0; y < normalSize; y++) {
    for (let x = 0; x < normalSize; x++) {
      // Prevent Sobel kernel from sampling across band borders
      const rowBand = Math.floor((y / normalSize) * HARDWARE_ATLAS_BAND_COUNT);
      const yUp = Math.floor(((y - 1) / normalSize) * HARDWARE_ATLAS_BAND_COUNT) === rowBand ? y - 1 : y;
      const yDn = Math.floor(((y + 1) / normalSize) * HARDWARE_ATLAS_BAND_COUNT) === rowBand ? y + 1 : y;

      const dx = (sampleH(x + 1, y) - sampleH(x - 1, y)) * strength;
      const dy = (sampleH(x, yDn) - sampleH(x, yUp)) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const idx = (y * normalSize + x) * 4;
      normal[idx] = clampByte((-dx * invLen * 0.5 + 0.5) * 255);
      normal[idx + 1] = clampByte((dy * invLen * 0.5 + 0.5) * 255);
      normal[idx + 2] = clampByte((invLen * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;
    }
  }

  return { size, normalSize, albedo, roughMetal, normal };
}

/**
 * Generate byte-deterministic stage marley deck texture pixels (with panel seams and seeded scuffs).
 */
export function generateDeckPixels(size: number, seed: number = STAGE_DECK_SEED): Uint8ClampedArray {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(size * size * 4);
  const half = size >> 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const seam = x === 0 || y === 0 || Math.abs(x - half) <= 1 || Math.abs(y - half) <= 1;
      const grain = (rand() - 0.5) * 4;
      if (seam) {
        data[idx] = 34;
        data[idx + 1] = 36;
        data[idx + 2] = 41;
      } else {
        data[idx] = clampByte(55 + grain);
        data[idx + 1] = clampByte(59 + grain);
        data[idx + 2] = clampByte(64 + grain);
      }
      data[idx + 3] = 255;
    }
  }

  // Deterministic subtle scuffs (Bresenham-style strokes into pixel buffer)
  const scuffCount = Math.round((size / 512) * 650);
  for (let i = 0; i < scuffCount; i++) {
    const x0 = rand() * size;
    const y0 = rand() * size;
    const len = (8 + rand() * 24) * (size / 512);
    const dx = (rand() - 0.5) * len;
    const dy = (rand() - 0.5) * len;
    const alpha = 0.012 + rand() * 0.025;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    for (let s = 0; s <= steps; s++) {
      const px = Math.floor(x0 + (dx * s) / steps);
      const py = Math.floor(y0 + (dy * s) / steps);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      const idx = (py * size + px) * 4;
      data[idx] = clampByte(data[idx] + (255 - data[idx]) * alpha);
      data[idx + 1] = clampByte(data[idx + 1] + (255 - data[idx + 1]) * alpha);
      data[idx + 2] = clampByte(data[idx + 2] + (255 - data[idx + 2]) * alpha);
    }
  }

  return data;
}

export interface GeneratedDeckSheenMaps {
  tier: RenderTier;
  size: number;
  /** RGBA8 linear bytes (R=G=B=roughness, A=255), size * size * 4. */
  roughness: Uint8ClampedArray;
  /** RGBA8 linear tangent-space normal bytes on 'high' tier (size * size * 4), or null on 'low' tier. */
  normal: Uint8ClampedArray | null;
  textureCount: 1 | 2;
  estimatedBytes: number;
}

/**
 * Generate byte-deterministic stage marley roughness (128² low / 256² high) and weak normal (256² high only)
 * maps registered 1:1 with `generateDeckPixels(atlasSizeForTier(tier), seed)` by replaying its exact PRNG stream
 * and 2×2 box-downsampling so panel seams and scuffs interrupt specular highlights cleanly without shimmer.
 */
export function generateDeckSheenMaps(
  tier: RenderTier,
  seed: number = STAGE_DECK_SEED,
): GeneratedDeckSheenMaps {
  const albedoSize = atlasSizeForTier(tier);
  const size = deckSheenSizeForTier(tier);
  const rand = mulberry32(seed);
  const half = albedoSize >> 1;

  const roughHi = new Float32Array(albedoSize * albedoSize);
  const heightHi = tier === 'high' ? new Float32Array(albedoSize * albedoSize) : null;

  // 1. Replay exact per-pixel grain loop (albedoSize * albedoSize rand() draws).
  for (let y = 0; y < albedoSize; y++) {
    const v = (y + 0.5) / albedoSize;
    const distBorderY = Math.min(y, albedoSize - y);
    const distMidY = Math.abs(y - half);
    const seamDistY = Math.min(distBorderY, distMidY);
    const rollY = Math.cos(v * Math.PI * 2) * 0.011;

    for (let x = 0; x < albedoSize; x++) {
      const r0 = rand();
      const u = (x + 0.5) / albedoSize;
      const distBorderX = Math.min(x, albedoSize - x);
      const distMidX = Math.abs(x - half);
      const seamDist = Math.min(distBorderX, distMidX, seamDistY);

      const roll = Math.sin(u * Math.PI * 2) * 0.014 + rollY + Math.sin((u + v) * Math.PI * 4) * 0.007;
      const micro = (r0 - 0.5) * 0.020;

      let rough = STAGE_DECK_BASE_ROUGHNESS + roll + micro;
      let h = 0.5 + roll * 0.55 + micro * 0.30;

      if (seamDist === 0) {
        rough = 0.72;
        h = 0.34;
      } else if (seamDist === 1) {
        rough = 0.65;
        h = 0.42;
      } else if (seamDist === 2) {
        rough = Math.min(0.62, rough + 0.022);
        h += 0.022;
      }

      const idx = y * albedoSize + x;
      roughHi[idx] = rough;
      if (heightHi) heightHi[idx] = h;
    }
  }

  // 2. Replay exact scuff stroke loop (6 rand() draws per scuff: x0, y0, len, dx, dy, alpha).
  const scuffCount = Math.round((albedoSize / 512) * 650);
  const stampScuff = (px: number, py: number, deltaRough: number, deltaH: number, weight: number) => {
    if (px < 0 || px >= albedoSize || py < 0 || py >= albedoSize) return;
    const idx = py * albedoSize + px;
    const nextR = roughHi[idx] + deltaRough * weight;
    roughHi[idx] = nextR < 0.44 ? 0.44 : nextR > 0.74 ? 0.74 : nextR;
    if (heightHi) {
      const nextH = heightHi[idx] + deltaH * weight;
      heightHi[idx] = nextH < 0.25 ? 0.25 : nextH > 0.75 ? 0.75 : nextH;
    }
  };

  for (let i = 0; i < scuffCount; i++) {
    const x0 = rand() * albedoSize;
    const y0 = rand() * albedoSize;
    const len = (8 + rand() * 24) * (albedoSize / 512);
    const dx = (rand() - 0.5) * len;
    const dy = (rand() - 0.5) * len;
    const alpha = 0.012 + rand() * 0.025;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
    const strength = (alpha - 0.012) / 0.025; // 0..1
    // Deterministic mix: burnished heel marks (smoother) vs abraded scuff marks (matte).
    const burnished = i % 3 !== 0;
    const deltaRough = burnished ? -(0.055 + strength * 0.045) : (0.048 + strength * 0.042);
    const deltaH = burnished ? -(0.024 + strength * 0.020) : (0.018 + strength * 0.016);

    for (let s = 0; s <= steps; s++) {
      const px = Math.floor(x0 + (dx * s) / steps);
      const py = Math.floor(y0 + (dy * s) / steps);
      stampScuff(px, py, deltaRough, deltaH, 1.0);
      stampScuff(px - 1, py, deltaRough, deltaH, 0.45);
      stampScuff(px + 1, py, deltaRough, deltaH, 0.45);
      stampScuff(px, py - 1, deltaRough, deltaH, 0.45);
      stampScuff(px, py + 1, deltaRough, deltaH, 0.45);
    }
  }

  // 3. 2×2 box-filter downsample from albedoSize (512/256) to size (256/128) to suppress sub-texel shimmer.
  const roughness = new Uint8ClampedArray(size * size * 4);
  const heightDown = heightHi ? new Float32Array(size * size) : null;

  for (let y = 0; y < size; y++) {
    const y0 = y * 2;
    const y1 = y0 + 1;
    for (let x = 0; x < size; x++) {
      const x0 = x * 2;
      const x1 = x0 + 1;
      const i00 = y0 * albedoSize + x0;
      const i10 = y0 * albedoSize + x1;
      const i01 = y1 * albedoSize + x0;
      const i11 = y1 * albedoSize + x1;

      const avgRough = 0.25 * (roughHi[i00] + roughHi[i10] + roughHi[i01] + roughHi[i11]);
      const clampedRough = avgRough < 0.44 ? 0.44 : avgRough > 0.74 ? 0.74 : avgRough;
      const rByte = clampByte(clampedRough * 255);
      const outIdx = (y * size + x) * 4;
      roughness[outIdx] = rByte;
      roughness[outIdx + 1] = rByte;
      roughness[outIdx + 2] = rByte;
      roughness[outIdx + 3] = 255;

      if (heightDown && heightHi) {
        heightDown[y * size + x] = 0.25 * (heightHi[i00] + heightHi[i10] + heightHi[i01] + heightHi[i11]);
      }
    }
  }

  // 4. High tier only: weak periodic tangent-space normal map (flipY = true sign convention matching atlas).
  let normal: Uint8ClampedArray | null = null;
  if (tier === 'high' && heightDown) {
    normal = new Uint8ClampedArray(size * size * 4);
    const slopeStrength = 1.15;
    for (let y = 0; y < size; y++) {
      const yUp = (y - 1 + size) % size;
      const yDn = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xLt = (x - 1 + size) % size;
        const xRt = (x + 1) % size;
        const dx = (heightDown[y * size + xRt] - heightDown[y * size + xLt]) * slopeStrength;
        const dy = (heightDown[yDn * size + x] - heightDown[yUp * size + x]) * slopeStrength;
        const invLen = 1 / Math.hypot(dx, dy, 1);
        const idx = (y * size + x) * 4;
        normal[idx] = clampByte((-dx * invLen * 0.5 + 0.5) * 255);
        normal[idx + 1] = clampByte((dy * invLen * 0.5 + 0.5) * 255);
        normal[idx + 2] = clampByte((invLen * 0.5 + 0.5) * 255);
        normal[idx + 3] = 255;
      }
    }
  }

  const textureCount: 1 | 2 = tier === 'high' ? 2 : 1;
  return {
    tier,
    size,
    roughness,
    normal,
    textureCount,
    estimatedBytes: estimateDeckSheenTextureBytes(tier, true),
  };
}

/** Convert an RGBA pixel buffer into a CanvasTexture in browsers, or null in headless Node. */
export function pixelsToCanvasTexture(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  colorSpace: THREE.ColorSpace,
  anisotropy = 1,
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

export interface HardwareMaterialSet {
  hardwareBody: THREE.MeshStandardMaterial;
  hardwareGlass: THREE.MeshStandardMaterial;
  textures: THREE.Texture[];
}

/**
 * Create the shared hardware PBR materials (one trim-sheet body material + one glossy glass bezel).
 * Runs cleanly in Node (no `document`) by returning matching unmapped MeshStandardMaterials.
 */
export function createHardwareMaterials(
  tier: RenderTier = 'high',
  maxAnisotropy = 1,
): HardwareMaterialSet {
  const size = atlasSizeForTier(tier);
  const aniso = tier === 'high' ? Math.max(1, Math.min(4, maxAnisotropy)) : 1;
  const textures: THREE.Texture[] = [];

  let map: THREE.CanvasTexture | null = null;
  let roughMetalMap: THREE.CanvasTexture | null = null;
  let normalMap: THREE.CanvasTexture | null = null;

  if (typeof document !== 'undefined') {
    const atlas = generateHardwareAtlasPixels(size, HARDWARE_ATLAS_SEED);
    map = pixelsToCanvasTexture(atlas.albedo, atlas.size, atlas.size, THREE.SRGBColorSpace, aniso);
    roughMetalMap = pixelsToCanvasTexture(atlas.roughMetal, atlas.size, atlas.size, THREE.NoColorSpace, aniso);
    normalMap = pixelsToCanvasTexture(atlas.normal, atlas.normalSize, atlas.normalSize, THREE.NoColorSpace, aniso);
    if (map) {
      map.name = 'hardware-atlas-albedo';
      textures.push(map);
    }
    if (roughMetalMap) {
      roughMetalMap.name = 'hardware-atlas-rough-metal';
      textures.push(roughMetalMap);
    }
    if (normalMap) {
      normalMap.name = 'hardware-atlas-normal';
      textures.push(normalMap);
    }
  }

  const hardwareBody = new THREE.MeshStandardMaterial({
    name: 'hardwareBody',
    color: map ? 0xffffff : 0x22262e,
    map,
    roughnessMap: roughMetalMap,
    metalnessMap: roughMetalMap,
    normalMap,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: roughMetalMap ? 1.0 : 0.42,
    metalness: roughMetalMap ? 1.0 : 0.62,
  });

  const hardwareGlass = new THREE.MeshStandardMaterial({
    name: 'hardwareGlass',
    color: 0x101824,
    roughness: 0.12,
    metalness: 0.18,
    envMapIntensity: 1.4,
  });

  return { hardwareBody, hardwareGlass, textures };
}

/**
 * Remap a BufferGeometry's UVs into a single horizontal band of the hardware trim-sheet atlas,
 * with a small vertical inset to prevent mipmap bleeding across band boundaries.
 */
export function mapGeometryUvToBand(
  geometry: THREE.BufferGeometry,
  band: HardwareAtlasBand,
  uMin = 0.02,
  uMax = 0.98,
): THREE.BufferGeometry {
  let uv = geometry.getAttribute('uv');
  const pos = geometry.getAttribute('position');
  if (!uv && pos) {
    // Synthesise planar UVs when a geometry lacks them so mergeGeometries never returns null.
    const arr = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      arr[i * 2] = pos.getX(i) + 0.5;
      arr[i * 2 + 1] = pos.getY(i) + 0.5;
    }
    uv = new THREE.BufferAttribute(arr, 2);
    geometry.setAttribute('uv', uv);
  }
  if (!uv) return geometry;

  const bandSpan = 1 / HARDWARE_ATLAS_BAND_COUNT;
  const pad = bandSpan * 0.12; // mip-safe vertical margin inside each band (prevents mip-level bleed)
  const v0 = band * bandSpan + pad;
  const v1 = (band + 1) * bandSpan - pad;
  const uSpan = uMax - uMin;
  const vSpan = v1 - v0;

  for (let i = 0; i < uv.count; i++) {
    const rawU = uv.getX(i);
    const rawV = uv.getY(i);
    // Preserve exact [0, 1] endpoints so BoxGeometry faces & cylinder seams never collapse to a single texel.
    const nu = rawU < 0 || rawU > 1 ? rawU - Math.floor(rawU) : rawU;
    const nv = rawV < 0 || rawV > 1 ? rawV - Math.floor(rawV) : rawV;
    uv.setXY(i, uMin + nu * uSpan, v0 + nv * vSpan);
  }
  uv.needsUpdate = true;
  return geometry;
}
