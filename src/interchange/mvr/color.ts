/**
 * CIE 1931 xyY colour helpers for MVR 1.6 (<Color>) and GDTF 1.2 (Color attributes).
 *
 * MVR and GDTF encode colours as "x,y,Y" where x and y are chromaticity coordinates in [0, 1]
 * (with y > 0 and x + y <= 1) and Y is luminance in [0, 100]. Conversion to/from sRGB uses the
 * standard D65 white point (x = 0.3127, y = 0.3290) and IEC 61966-2-1 sRGB transfer curve.
 */

export interface CieXyY {
  x: number;
  y: number;
  /** Luminance in 0..100 (GDTF/MVR percentage scale). */
  Y: number;
}

export interface SrgbColor {
  /** Gamma-encoded sRGB channels in 0..1. */
  r: number;
  g: number;
  b: number;
  /** Upper-case #RRGGBB hex string. */
  hex: string;
}

const STRICT_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const EPS = 1e-6;
const D65_X = 0.3127;
const D65_Y = 0.329;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const byteHex = (c: number) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0').toUpperCase();

/** Parse an MVR/GDTF CIE xyY triple ("x,y,Y" or "{x,y,Y}"). Throws a readable Error on invalid text. */
export function parseCieXyY(source: string): CieXyY {
  if (typeof source !== 'string') throw new Error('Invalid CIE xyY colour.');
  let trimmed = source.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) trimmed = trimmed.slice(1, -1).trim();
  const parts = trimmed.split(',').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !STRICT_NUMBER.test(p))) {
    throw new Error('Invalid CIE xyY colour.');
  }
  const [x, y, Y] = parts.map(Number);
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(Y) ||
    x < -EPS || x > 1 + EPS ||
    y <= EPS || y > 1 + EPS ||
    x + y > 1 + EPS ||
    Y < -EPS || Y > 100 + EPS
  ) {
    throw new Error('Invalid CIE xyY colour.');
  }
  const cx = clamp01(x);
  const cy = Math.max(EPS, Math.min(1, y));
  const cY = Math.max(0, Math.min(100, Y));
  return { x: cx, y: cy, Y: cY };
}

/** Convert CIE 1931 xyY (Y in 0..100) to D65 sRGB, preserving hue when out of sRGB gamut. */
export function cieXyYToSrgb(xyY: CieXyY): SrgbColor {
  const { x, y, Y } = xyY;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(Y) || y <= EPS || Y < -EPS) {
    throw new Error('Invalid CIE xyY colour.');
  }
  const Yn = Math.max(0, Math.min(100, Y)) / 100;
  if (Yn === 0) return { r: 0, g: 0, b: 0, hex: '#000000' };

  const X = (x * Yn) / y;
  const Z = ((1 - x - y) * Yn) / y;

  let r = 3.2404542 * X - 1.5371385 * Yn - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Yn + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Yn + 1.0572252 * Z;

  // Hue-preserving desaturation toward the equal-luminance neutral axis (Yn, Yn, Yn)
  // when a saturated spectral/gel colour has a negative linear sRGB component.
  const minChannel = Math.min(r, g, b);
  if (minChannel < 0) {
    const denom = Yn - minChannel;
    if (denom > EPS) {
      const t = Yn / denom;
      r = Yn + (r - Yn) * t;
      g = Yn + (g - Yn) * t;
      b = Yn + (b - Yn) * t;
    }
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
  }

  // Scale down proportionally if peak exceeds 1 so hue is preserved at full gamut.
  const peak = Math.max(r, g, b);
  if (peak > 1) {
    r /= peak;
    g /= peak;
    b /= peak;
  }

  const sr = clamp01(toGamma(r));
  const sg = clamp01(toGamma(g));
  const sb = clamp01(toGamma(b));
  return { r: sr, g: sg, b: sb, hex: `#${byteHex(sr)}${byteHex(sg)}${byteHex(sb)}` };
}

/** Convert sRGB (#RRGGBB or 0..1 channels) to CIE 1931 xyY (Y in 0..100). */
export function srgbToCieXyY(color: string | { r: number; g: number; b: number }): CieXyY {
  let r: number, g: number, b: number;
  if (typeof color === 'string') {
    const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
    if (!m) throw new Error('Invalid sRGB colour.');
    const n = parseInt(m[1], 16);
    r = ((n >> 16) & 0xff) / 255;
    g = ((n >> 8) & 0xff) / 255;
    b = (n & 0xff) / 255;
  } else {
    ({ r, g, b } = color);
    if (![r, g, b].every((c) => Number.isFinite(c) && c >= 0 && c <= 1)) {
      throw new Error('Invalid sRGB colour.');
    }
  }
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const X = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const Y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const Z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const sum = X + Y + Z;
  if (sum <= 1e-12) return { x: D65_X, y: D65_Y, Y: 0 };
  return { x: X / sum, y: Y / sum, Y: Y * 100 };
}

const fmt = (n: number) => {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** Format a CIE xyY triple as MVR/GDTF "x,y,Y" text. */
export function formatCieXyY(xyY: CieXyY): string {
  return `${fmt(xyY.x)},${fmt(xyY.y)},${fmt(xyY.Y)}`;
}
