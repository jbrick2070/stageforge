import type { RenderTier } from './hardwareMaterials';

export type BloomMode = 'auto' | 'full' | 'half' | 'off';
export type AaMode = 'auto' | 'msaa' | 'fxaa' | 'none';

/**
 * Device-local renderer preferences (Sprint 15).
 * Stored exclusively in localStorage (`stageforge.render.v1`); never serialized into show files or bundles.
 * All non-parity visual features default to off (`auto` preserves existing behavior on both tiers).
 */
export interface RenderSettings {
  bloom: BloomMode;
  aa: AaMode;
  /** Flag-gated falling dense-vapour CO2 plume approximation (default off). */
  fallingCo2: boolean;
  /** Flag-gated conditional sRGB EOTF decode for HTMLVideoElement textures in LED_WALL_FRAG (default off). */
  videoSrgbDecode: boolean;
  /** Flag-gated 8-facet prism floor projections in BeamPools (Sprint 16, default off). */
  prismPools: boolean;
  /** Flag-gated bounded viewing-angle emissivity response on LED walls (Sprint 17, default off). */
  ledAngularResponse: boolean;
  /** Flag-gated stage-deck PBR roughness & weak normal response (Sprint 18, default off). */
  deckSheen: boolean;
  /** Flag-gated restrained directional & rim show-light response on instanced crowd (Sprint 19, default off). */
  crowdLighting: boolean;
}

export const RENDER_SETTINGS_STORAGE_KEY = 'stageforge.render.v1';

export const DEFAULT_RENDER_SETTINGS: Readonly<RenderSettings> = Object.freeze({
  bloom: 'auto',
  aa: 'auto',
  fallingCo2: false,
  videoSrgbDecode: false,
  prismPools: false,
  ledAngularResponse: false,
  deckSheen: false,
  crowdLighting: false,
});

const VALID_BLOOM_MODES: ReadonlySet<string> = new Set<BloomMode>(['auto', 'full', 'half', 'off']);
const VALID_AA_MODES: ReadonlySet<string> = new Set<AaMode>(['auto', 'msaa', 'fxaa', 'none']);

export function parseRenderSettings(raw: unknown): RenderSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_RENDER_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const bloom = Object.hasOwn(obj, 'bloom') && typeof obj.bloom === 'string' && VALID_BLOOM_MODES.has(obj.bloom)
    ? (obj.bloom as BloomMode)
    : DEFAULT_RENDER_SETTINGS.bloom;
  const aa = Object.hasOwn(obj, 'aa') && typeof obj.aa === 'string' && VALID_AA_MODES.has(obj.aa)
    ? (obj.aa as AaMode)
    : DEFAULT_RENDER_SETTINGS.aa;
  const fallingCo2 = Object.hasOwn(obj, 'fallingCo2') && typeof obj.fallingCo2 === 'boolean'
    ? obj.fallingCo2
    : DEFAULT_RENDER_SETTINGS.fallingCo2;
  const videoSrgbDecode = Object.hasOwn(obj, 'videoSrgbDecode') && typeof obj.videoSrgbDecode === 'boolean'
    ? obj.videoSrgbDecode
    : DEFAULT_RENDER_SETTINGS.videoSrgbDecode;
  const prismPools = Object.hasOwn(obj, 'prismPools') && typeof obj.prismPools === 'boolean'
    ? obj.prismPools
    : DEFAULT_RENDER_SETTINGS.prismPools;
  const ledAngularResponse = Object.hasOwn(obj, 'ledAngularResponse') && typeof obj.ledAngularResponse === 'boolean'
    ? obj.ledAngularResponse
    : DEFAULT_RENDER_SETTINGS.ledAngularResponse;
  const deckSheen = Object.hasOwn(obj, 'deckSheen') && typeof obj.deckSheen === 'boolean'
    ? obj.deckSheen
    : DEFAULT_RENDER_SETTINGS.deckSheen;
  const crowdLighting = Object.hasOwn(obj, 'crowdLighting') && typeof obj.crowdLighting === 'boolean'
    ? obj.crowdLighting
    : DEFAULT_RENDER_SETTINGS.crowdLighting;
  return { bloom, aa, fallingCo2, videoSrgbDecode, prismPools, ledAngularResponse, deckSheen, crowdLighting };
}

export function loadRenderSettings(): RenderSettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_RENDER_SETTINGS };
    const text = localStorage.getItem(RENDER_SETTINGS_STORAGE_KEY);
    if (!text || text.length > 4096) return { ...DEFAULT_RENDER_SETTINGS };
    return parseRenderSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_RENDER_SETTINGS };
  }
}

export function saveRenderSettings(settings: RenderSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const clean = parseRenderSettings(settings);
    localStorage.setItem(RENDER_SETTINGS_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage quota / private-browsing failures.
  }
}

export function resolveBloomScale(mode: BloomMode, _tier: RenderTier): 1 | 0.5 | 0 {
  if (mode === 'off') return 0;
  if (mode === 'half') return 0.5;
  // 'auto' preserves existing full-resolution bloom until measured A/B evidence justifies promotion.
  return 1;
}

export function shouldRunBloom(mode: BloomMode, strength: number, tier: RenderTier): boolean {
  if (!Number.isFinite(strength) || strength <= 0.001) return false;
  return resolveBloomScale(mode, tier) > 0;
}

export function resolveEffectiveAa(mode: AaMode): 'msaa' | 'fxaa' | 'none' {
  if (mode === 'fxaa') return 'fxaa';
  if (mode === 'none') return 'none';
  // 'auto' preserves existing 2x composer MSAA without stacking FXAA.
  return 'msaa';
}

export interface FullRateStrobePolicyInput {
  userOptIn: boolean;
  prefersReducedMotion: boolean;
  xrPresenting: boolean;
  viewerMode: boolean;
}

/**
 * Preview-only full-rate strobe opt-in policy.
 * Always disabled under prefers-reduced-motion, WebXR sessions, or read-only pitch viewer mode.
 * Never persisted across page reloads and never affects physical DMX output.
 */
export function resolveEffectiveFullRateStrobe(input: FullRateStrobePolicyInput): boolean {
  return Boolean(
    input.userOptIn &&
    !input.prefersReducedMotion &&
    !input.xrPresenting &&
    !input.viewerMode
  );
}

/**
 * Deterministic estimate of offscreen render-target GPU memory in bytes:
 * - EffectComposer RT1 + RT2: RGBA16F (8 B/px) × 2 targets; with MSAA samples > 0 WebGL2 allocates
 *   both the multisampled renderbuffer (8 B/px × samples) and the single-sample resolved texture (8 B/px),
 *   plus a 32-bit depth/stencil renderbuffer (4 B/px × max(1, samples)).
 * - UnrealBloomPass (when active): bright RT at (w*scale/2, h*scale/2) + 5 horizontal/vertical RGBA16F mip pairs.
 */
export function estimateRenderTargetBytes(params: {
  drawingWidth: number;
  drawingHeight: number;
  samples: number;
  bloomScale: 1 | 0.5 | 0;
  bloomAllocated: boolean;
}): number {
  const w = Math.max(1, Math.round(params.drawingWidth));
  const h = Math.max(1, Math.round(params.drawingHeight));
  const samples = Math.max(0, Math.round(params.samples));

  // Two composer targets (renderTarget1 + renderTarget2).
  const colorPerPixel = samples > 0 ? 8 * (samples + 1) : 8;
  const depthPerPixel = 4 * Math.max(1, samples);
  let bytes = 2 * w * h * (colorPerPixel + depthPerPixel);

  if (params.bloomAllocated && params.bloomScale > 0) {
    let rx = Math.max(1, Math.round((w * params.bloomScale) / 2));
    let ry = Math.max(1, Math.round((h * params.bloomScale) / 2));
    // Bright pass RT (RGBA16F, no depth).
    bytes += rx * ry * 8;
    for (let i = 0; i < 5; i++) {
      // Horizontal + vertical blur RTs (RGBA16F, no depth).
      bytes += 2 * rx * ry * 8;
      rx = Math.max(1, Math.round(rx / 2));
      ry = Math.max(1, Math.round(ry / 2));
    }
  }
  return bytes;
}
