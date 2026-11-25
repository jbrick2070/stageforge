import type { FixtureType, FloorFxType, FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';

export type HardwareType = FixtureType | FloorFxType;

export type CatalogCategory =
  | 'beam'
  | 'spot'
  | 'profile'
  | 'wash'
  | 'led_par'
  | 'led_batten'
  | 'strobe'
  | 'blinder'
  | 'followspot'
  | 'led_panel'
  | 'hazer'
  | 'fogger'
  | 'co2_jet'
  | 'laser';

export type CatalogBodyFamily =
  | 'moving-beam'
  | 'moving-spot'
  | 'moving-profile'
  | 'moving-wash'
  | 'followspot'
  | 'led-par'
  | 'led-batten'
  | 'strobe-panel'
  | 'blinder-4lite'
  | 'led-panel'
  | 'hazer-box'
  | 'fogger-box'
  | 'co2-jet'
  | 'laser-head';

export type LaserChannelRole =
  | 'unused'
  | 'fb4Access16'
  | 'fb4Mode39'
  | 'intensity'
  | 'pattern'
  | 'sizeX'
  | 'sizeY'
  | 'zoom'
  | 'speed'
  | 'rotation'
  | 'posX'
  | 'posY'
  | 'beamCount'
  | 'strobe'
  | 'red'
  | 'green'
  | 'blue'
  | 'colorScroll'
  | 'scanRate';

export interface CatalogDmxMode {
  readonly name: string;
  readonly channels: number;
  /** Hidden from EquipmentPicker for new selections; preserved so older v6 shows still load cleanly. */
  readonly legacy?: true;
  /** Optional channel role map (0-based index -> role) for laser DMX output; omitted uses simulator default. */
  readonly layout?: readonly LaserChannelRole[];
}

export interface CatalogOpticsSpec {
  readonly lumens?: number;
  readonly lumensAt?: 'narrow' | 'wide';
  readonly zoomDeg?: readonly [number, number];
  readonly beamDeg?: number;
}

export interface CatalogPanelSpec {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly pitchMm: number;
  readonly pixelsWide: number;
  readonly pixelsHigh: number;
}

export interface CatalogLaserSpec {
  readonly colorType: 'rgb' | 'single';
  /** Nominal wavelength in nm for single-color diode/DPSS lasers (e.g. 520 or 532). */
  readonly wavelengthNm?: number;
  /** Display hex color for single-color lasers (e.g. '#00ff3c'). */
  readonly singleColorHex?: string;
  /** Guaranteed optical output power at aperture in Watts. */
  readonly opticalPowerW: number;
  /** Maximum rated optical output power in Watts when higher than guaranteed (used conservatively for NOHD safety). */
  readonly maxOpticalPowerW?: number;
  /** Galvo scanner speed in kpps @ published ILDA test angle (typically 8 deg). */
  readonly scanSpeedKpps: number;
  /** Maximum optical scan angle in degrees (full angle), when stated in datasheet. */
  readonly maxScanAngleDeg?: number;
  /** Full-angle beam divergence in milliradians (mrad). */
  readonly divergenceMrad?: number;
  /** Beam diameter at aperture in millimetres (mm): number when stated, null when explicitly unstated/unknown, omitted for legacy 5 mm assumption. */
  readonly beamDiameterMm?: number | null;
  /** IEC 60825-1 laser hazard class ('3B' <= 0.5 W, '4' > 0.5 W). */
  readonly laserClass: '3B' | '4';
  /** Beam-only vs beam + vector graphics capability. */
  readonly capability: 'beam' | 'beam_graphic';
  /** Supported physical/network control interfaces. */
  readonly control: readonly ('dmx' | 'ilda' | 'fb4' | 'shownet')[];
}

export interface CatalogEntry {
  readonly id: string;
  readonly manufacturer: string;
  readonly model: string;
  /** Optional historical/short aliases matched by EquipmentPicker search. */
  readonly aliases?: readonly string[];
  readonly category: CatalogCategory;
  /** Compatible StageForge simulation/render types ([0] = default; empty for led_panel). */
  readonly renderTypes: readonly HardwareType[];
  /** Body geometry family hint for procedural 3D models. */
  readonly body: CatalogBodyFamily;
  /** Optional motion override when an entry differs from its body family's default (e.g. a static non-tilting LED batten). */
  readonly motion?: 'pan-tilt' | 'tilt' | 'fixed';
  readonly weightKg?: number;
  readonly powerW?: number;
  readonly ipRating?: string;
  readonly optics?: CatalogOpticsSpec;
  readonly laser?: CatalogLaserSpec;
  /** Published DMX modes ([0] = default real mode; empty for led_panel). */
  readonly modes: readonly CatalogDmxMode[];
  /** Optional note when hardware requires an additional separately addressed DMX safety channel not auto-patched. */
  readonly auxSafetyChannelNote?: string;
  readonly panel?: CatalogPanelSpec;
  /** True only for placeholder entries awaiting datasheet verification. */
  readonly placeholder?: true;
  /** Citation IDs documented with URLs and verification dates in docs/equipment.md. */
  readonly sources: readonly string[];
  /** Field paths whose values could not be independently verified from an official datasheet. */
  readonly unverified: readonly string[];
}

export const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const CATALOG_CATEGORY_LABELS: Record<CatalogCategory, string> = {
  beam: 'Beam',
  spot: 'Spot',
  profile: 'Profile',
  wash: 'Wash',
  led_par: 'LED PAR',
  led_batten: 'LED Batten',
  strobe: 'Strobe',
  blinder: 'Blinder',
  followspot: 'Followspot',
  led_panel: 'LED Panel',
  hazer: 'Hazer',
  fogger: 'Fogger',
  co2_jet: 'CO2 Jet',
  laser: 'Laser',
};

// Standard verified DMX channel role layouts for Pangolin FB4 & Laserworld ShowNET Pro.
const FB4_16_LAYOUT: readonly LaserChannelRole[] = [
  'fb4Access16', // Ch 1: DMX mode/access (235-255 = 16-ch mode, 0 = blackout)
  'unused',      // Ch 2: Page index
  'pattern',     // Ch 3: Cue index
  'speed',       // Ch 4: Cue speed
  'intensity',   // Ch 5: Master dimmer
  'zoom',        // Ch 6: Zoom
  'sizeX',       // Ch 7: Size X
  'sizeY',       // Ch 8: Size Y
  'rotation',    // Ch 9: Angle Z
  'posX',        // Ch 10: Position X (128 = center)
  'posY',        // Ch 11: Position Y (128 = center)
  'beamCount',   // Ch 12: Visible points
  'scanRate',    // Ch 13: Scan rate
  'unused',      // Ch 14: Cue release
  'colorScroll', // Ch 15: Color scroll
  'unused',      // Ch 16: Reserved
];

const FB4_39_LAYOUT: readonly LaserChannelRole[] = [
  'fb4Mode39',   // Ch 1: 251 = Playback mode, 0 = Blackout/Safe
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused',
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused', // Ch 2-13: Setup mode limits
  'unused',      // Ch 14: Page index
  'pattern',     // Ch 15: Cue index
  'speed',       // Ch 16: Cue speed
  'intensity',   // Ch 17: Dimmer
  'zoom',        // Ch 18: Zoom MSB
  'unused',      // Ch 19: Zoom LSB
  'sizeX',       // Ch 20: Size X MSB
  'unused',      // Ch 21: Size X LSB
  'sizeY',       // Ch 22: Size Y MSB
  'unused',      // Ch 23: Size Y LSB
  'rotation',    // Ch 24: Angle Z MSB
  'unused',      // Ch 25: Angle Z LSB
  'unused', 'unused', // Ch 26-27: Continuous Z-rot speed
  'posX',        // Ch 28: Pos X MSB
  'unused',      // Ch 29: Pos X LSB
  'posY',        // Ch 30: Pos Y MSB
  'unused',      // Ch 31: Pos Y LSB
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused', // Ch 32-39
];

const SHOWNET_PRO_34_LAYOUT: readonly LaserChannelRole[] = [
  'intensity',   // Ch 1: Intensity
  'pattern',     // Ch 2: Pattern select
  'sizeX',       // Ch 3: Size X / Zoom
  'sizeY',       // Ch 4: Size Y
  'rotation',    // Ch 5: Rotation
  'posX',        // Ch 6: Position X
  'posY',        // Ch 7: Position Y
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused', // Ch 8-13: Effects & Color mode
  'red',         // Ch 14: Red
  'green',       // Ch 15: Green
  'blue',        // Ch 16: Blue
  'strobe',      // Ch 17: Strobe
  'scanRate',    // Ch 18: Scan speed
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused',
  'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused', 'unused', // Ch 19-34
];

/**
 * Curated touring equipment catalogue grounded in manufacturer datasheets and Open Fixture Library.
 * Every numeric value is either backed by a citation in docs/equipment.md or explicitly listed in `unverified`.
 */
export const EQUIPMENT_CATALOG = [
  // ── Beam Moving Heads ───────────────────────────────────────────────────────
  {
    id: 'claypaky-sharpy',
    manufacturer: 'Claypaky',
    model: 'Sharpy',
    category: 'beam',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-beam',
    weightKg: 19,
    powerW: 350,
    ipRating: 'IP20',
    optics: { beamDeg: 3.8 },
    modes: [
      { name: 'Standard', channels: 16 },
      { name: 'Vector', channels: 20 },
    ],
    sources: ['claypaky-sharpy', 'ofl-claypaky-sharpy'],
    unverified: ['powerW'],
  },
  {
    id: 'robe-megapointe',
    manufacturer: 'Robe',
    model: 'MegaPointe',
    category: 'beam',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-beam',
    weightKg: 22,
    powerW: 670,
    ipRating: 'IP20',
    optics: { lumens: 20375, zoomDeg: [1.8, 42] },
    modes: [
      { name: 'Mode 1 (Standard 16-bit)', channels: 39 },
      { name: 'Mode 2 (Reduced 8-bit)', channels: 34 },
    ],
    sources: ['robe-megapointe'],
    unverified: ['ipRating'],
  },
  {
    id: 'robe-ledbeam-150',
    manufacturer: 'Robe',
    model: 'LEDBeam 150',
    category: 'beam',
    renderTypes: ['beam', 'wash', 'floor_beam'],
    body: 'moving-beam',
    weightKg: 5.7,
    powerW: 220,
    ipRating: 'IP20',
    optics: { lumens: 2842, zoomDeg: [3.8, 60] },
    modes: [
      { name: 'Mode 1 (Standard 16-bit)', channels: 22 },
      { name: 'Mode 2 (Reduced 8-bit)', channels: 16 },
    ],
    sources: ['robe-ledbeam-150'],
    unverified: ['ipRating'],
  },

  // ── Spot & Profile Moving Heads ─────────────────────────────────────────────
  {
    id: 'martin-mac-ultra-performance',
    manufacturer: 'Martin',
    model: 'MAC Ultra Performance',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 44,
    powerW: 1380,
    ipRating: 'IP20',
    optics: { lumens: 46500, zoomDeg: [8, 54] },
    modes: [
      { name: 'Standard', channels: 48 },
    ],
    sources: ['martin-mac-ultra-performance'],
    unverified: ['powerW', 'ipRating'],
  },
  {
    id: 'robe-bmfl-spot',
    manufacturer: 'Robe',
    model: 'BMFL Spot',
    category: 'spot',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-spot',
    weightKg: 36,
    powerW: 2000,
    ipRating: 'IP20',
    optics: { lumens: 40000, zoomDeg: [5, 55] },
    modes: [
      { name: 'Mode 1 (Standard)', channels: 41 },
      { name: 'Mode 2 (Reduced)', channels: 33 },
    ],
    sources: ['robe-bmfl-spot'],
    unverified: ['ipRating'],
  },
  {
    id: 'robe-t1-profile',
    manufacturer: 'Robe',
    model: 'T1 Profile',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 24.3,
    powerW: 650,
    ipRating: 'IP20',
    optics: { lumens: 10075, zoomDeg: [7, 49] },
    modes: [
      { name: 'Mode 1 (CMY/RGB)', channels: 49 },
      { name: 'Mode 2 (Reduced)', channels: 33 },
      { name: 'Mode 3 (RGBAL)', channels: 53 },
    ],
    sources: ['robe-t1-profile'],
    unverified: ['ipRating'],
  },
  {
    id: 'ayrton-perseo-profile',
    manufacturer: 'Ayrton',
    model: 'Perseo Profile',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 38.8,
    powerW: 800,
    ipRating: 'IP65',
    optics: { lumens: 27400, zoomDeg: [7, 58] },
    modes: [
      { name: 'Basic', channels: 38 },
      { name: 'Standard', channels: 40 },
      { name: 'Extended', channels: 58 },
      { name: 'Extended 540', channels: 61 },
    ],
    sources: ['ayrton-perseo-profile'],
    unverified: [],
  },

  // ── Followspot ──────────────────────────────────────────────────────────────
  {
    id: 'robe-bmfl-followspot',
    manufacturer: 'Robe',
    model: 'BMFL FollowSpot',
    category: 'followspot',
    renderTypes: ['beam'],
    body: 'followspot',
    weightKg: 35,
    powerW: 2000,
    ipRating: 'IP20',
    optics: { lumens: 39770, zoomDeg: [5, 45] },
    modes: [
      { name: 'Mode 1 (Standard)', channels: 33 },
      { name: 'Mode 2 (Reduced)', channels: 27 },
    ],
    sources: ['robe-bmfl-followspot'],
    unverified: ['ipRating'],
  },

  // ── Wash Moving Heads ───────────────────────────────────────────────────────
  {
    id: 'martin-mac-aura-xb',
    manufacturer: 'Martin',
    model: 'MAC Aura XB',
    category: 'wash',
    renderTypes: ['wash'],
    body: 'moving-wash',
    weightKg: 6.5,
    powerW: 359,
    ipRating: 'IP20',
    optics: { lumens: 6000, zoomDeg: [9, 59.1] },
    modes: [
      { name: 'Standard', channels: 14 },
      { name: 'Extended', channels: 25 },
    ],
    sources: ['martin-mac-aura-xb'],
    unverified: [],
  },
  {
    id: 'martin-mac-aura-xip',
    manufacturer: 'Martin',
    model: 'MAC Aura XIP',
    category: 'wash',
    renderTypes: ['wash'],
    body: 'moving-wash',
    weightKg: 8.95,
    powerW: 340,
    ipRating: 'IP54',
    optics: { lumens: 6000, lumensAt: 'wide', zoomDeg: [6.3, 50.4], beamDeg: 35.3 },
    modes: [
      { name: 'Compact', channels: 20 },
      { name: 'Basic', channels: 36 },
      { name: 'Extended', channels: 57 },
      { name: 'Ludicrous', channels: 93 },
      { name: 'XB Standard', channels: 14 },
      { name: 'XB Extended', channels: 25 },
    ],
    sources: ['martin-mac-aura-xip'],
    unverified: [],
  },
  {
    id: 'robe-spiider',
    manufacturer: 'Robe',
    model: 'Spiider',
    category: 'wash',
    renderTypes: ['wash'],
    body: 'moving-wash',
    weightKg: 13.3,
    powerW: 660,
    ipRating: 'IP20',
    optics: { lumens: 13700, zoomDeg: [4, 50] },
    modes: [
      { name: 'Mode 2 (Basic)', channels: 27 },
      { name: 'Mode 6 (Pattern)', channels: 47 },
      { name: 'Mode 4 (Full RGBW)', channels: 90 },
      { name: 'Mode 7 (Pixel RGB)', channels: 91 },
      { name: 'Mode 8 (Pixel RGBW)', channels: 110 },
      { name: 'Mode 10 (Pattern Full RGBW)', channels: 123 },
    ],
    sources: ['robe-spiider'],
    unverified: ['ipRating'],
  },
  {
    id: 'chauvet-rogue-r1-beamwash',
    manufacturer: 'CHAUVET Professional',
    model: 'Rogue R1 BeamWash',
    category: 'wash',
    renderTypes: ['beam', 'wash', 'floor_beam'],
    body: 'moving-wash',
    weightKg: 5.35,
    powerW: 285,
    ipRating: 'IP20',
    optics: { lumens: 1483, lumensAt: 'narrow', zoomDeg: [4, 37.8], beamDeg: 4 },
    modes: [
      { name: '14-Ch', channels: 14 },
      { name: '15-Ch', channels: 15 },
      { name: '19-Ch', channels: 19 },
      { name: '21-Ch', channels: 21 },
    ],
    sources: ['chauvet-rogue-r1-beamwash'],
    unverified: ['ipRating'],
  },

  // ── LED PARs & Battens ──────────────────────────────────────────────────────
  {
    id: 'chauvet-colorado-1-quad-zoom',
    manufacturer: 'CHAUVET Professional',
    model: 'COLORado 1-Quad Zoom',
    category: 'led_par',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 7,
    powerW: 108,
    ipRating: 'IP65',
    optics: { zoomDeg: [7, 32] },
    modes: [
      { name: 'Tour (12-Ch)', channels: 12 },
      { name: 'ARC2 (4-Ch)', channels: 4 },
      { name: 'ARC2+D (5-Ch)', channels: 5 },
      { name: 'TR16 (17-Ch)', channels: 17 },
      { name: 'STD.Y (25-Ch)', channels: 25 },
    ],
    sources: ['chauvet-colorado-1-quad-zoom'],
    unverified: [],
  },
  {
    id: 'etc-colorsource-par',
    manufacturer: 'ETC',
    model: 'ColorSource PAR',
    category: 'led_par',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 3.8,
    powerW: 90,
    ipRating: 'IP20',
    optics: { lumens: 3039, beamDeg: 14.5 },
    modes: [
      { name: '5-Ch (Default)', channels: 5 },
      { name: 'Direct (6-Ch)', channels: 6 },
      { name: 'RGB (3-Ch)', channels: 3 },
      { name: '1-Ch', channels: 1 },
    ],
    sources: ['etc-colorsource-par', 'ofl-etc-colorsource-par'],
    unverified: [],
  },
  {
    id: 'chauvet-colorado-pxl-bar-16',
    manufacturer: 'CHAUVET Professional',
    model: 'COLORado PXL Bar 16',
    category: 'led_batten',
    renderTypes: ['wash'],
    body: 'led-batten',
    weightKg: 20.7,
    powerW: 750,
    ipRating: 'IP65',
    optics: { lumens: 8959, lumensAt: 'wide', zoomDeg: [5.8, 47.9] },
    modes: [
      { name: 'Basic (20-Ch)', channels: 20 },
      { name: 'Basic2 (19-Ch)', channels: 19 },
      { name: 'Standard (84-Ch)', channels: 84 },
      { name: 'Advanced (154-Ch)', channels: 154 },
      { name: 'Full PXL (182-Ch)', channels: 182 },
      { name: 'Tour (186-Ch)', channels: 186 },
    ],
    sources: ['chauvet-colorado-pxl-bar-16'],
    unverified: ['powerW'],
  },
  {
    id: 'glp-impression-x4-bar-20',
    manufacturer: 'GLP',
    model: 'impression X4 Bar 20',
    category: 'led_batten',
    renderTypes: ['wash'],
    body: 'led-batten',
    weightKg: 14.5,
    powerW: 450,
    ipRating: 'IP20',
    optics: { lumens: 4300, zoomDeg: [7, 50] },
    modes: [
      { name: 'Normal', channels: 34 },
      { name: 'Compressed', channels: 20 },
      { name: 'High Res', channels: 35 },
      { name: 'Dual Pixel', channels: 48 },
      { name: 'Single Pixel', channels: 88 },
      { name: 'Single Pixel High Res', channels: 89 },
    ],
    sources: ['glp-impression-x4-bar-20'],
    unverified: [],
  },

  // ── Strobes & Blinders ──────────────────────────────────────────────────────
  {
    id: 'glp-jdc1',
    manufacturer: 'GLP',
    model: 'JDC1',
    category: 'strobe',
    renderTypes: ['strobe'],
    body: 'strobe-panel',
    weightKg: 11.6,
    powerW: 1200,
    ipRating: 'IP20',
    modes: [
      { name: 'Compressed', channels: 14 },
      { name: 'Normal', channels: 23 },
      { name: '1Pix Pro', channels: 17 },
      { name: 'SPix Pro', channels: 62 },
      { name: 'SPix Full', channels: 68 },
    ],
    sources: ['glp-jdc1'],
    unverified: [],
  },
  {
    id: 'martin-atomic-3000-led',
    manufacturer: 'Martin',
    model: 'Atomic 3000 LED',
    category: 'strobe',
    renderTypes: ['strobe'],
    body: 'strobe-panel',
    weightKg: 7.8,
    powerW: 1300,
    ipRating: 'IP20',
    optics: { lumens: 180000 },
    modes: [
      { name: '4-Ch (Classic)', channels: 4 },
      { name: '3-Ch', channels: 3 },
      { name: '14-Ch (Extended + Aura)', channels: 14 },
    ],
    sources: ['martin-atomic-3000-led'],
    unverified: ['powerW', 'ipRating'],
  },
  {
    id: 'mole-richardson-molefay-4lite',
    manufacturer: 'Mole-Richardson',
    model: '4-Light Molefay',
    category: 'blinder',
    renderTypes: ['blinder'],
    body: 'blinder-4lite',
    weightKg: 7.6,
    powerW: 2600,
    ipRating: 'IP20',
    modes: [
      { name: '1-Ch (External Dimmer)', channels: 1 },
      { name: '4-Ch (Per-Lamp Dimmer)', channels: 4 },
    ],
    sources: ['mole-richardson-molefay-4lite'],
    unverified: ['modes[0].channels', 'modes[1].channels'],
  },
  {
    id: 'chauvet-strike-4',
    manufacturer: 'CHAUVET Professional',
    model: 'STRIKE 4',
    category: 'blinder',
    renderTypes: ['blinder'],
    body: 'blinder-4lite',
    weightKg: 8.7,
    powerW: 301,
    ipRating: 'IP20',
    modes: [
      { name: '4-Ch', channels: 4 },
      { name: '1-Ch', channels: 1 },
      { name: '3-Ch', channels: 3 },
      { name: '9-Ch', channels: 9 },
    ],
    sources: ['chauvet-strike-4'],
    unverified: [],
  },

  // ── LED Video Panels ────────────────────────────────────────────────────────
  {
    id: 'roe-bp2-v2',
    manufacturer: 'ROE Visual',
    model: 'Black Pearl BP2 V2',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 9.35,
    powerW: 190,
    ipRating: 'IP20',
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 2.84, pixelsWide: 176, pixelsHigh: 176 },
    sources: ['roe-bp2-v2'],
    unverified: ['ipRating'],
  },
  {
    id: 'roe-cb5',
    manufacturer: 'ROE Visual',
    model: 'Carbon CB5',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 13.85,
    powerW: 500,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 600, heightMm: 1200, pitchMm: 5.77, pixelsWide: 104, pixelsHigh: 208 },
    sources: ['roe-cb5'],
    unverified: ['ipRating'],
  },

  // ── Hazers, Foggers & CO2 Jets ──────────────────────────────────────────────
  {
    id: 'mdg-atme',
    manufacturer: 'MDG',
    model: 'ATMe',
    category: 'hazer',
    renderTypes: ['hazer'],
    body: 'hazer-box',
    weightKg: 16.8,
    powerW: 715,
    modes: [
      { name: '3-Ch DMX/RDM', channels: 3 },
    ],
    sources: ['mdg-atme'],
    unverified: [],
  },
  {
    id: 'mdg-theone',
    manufacturer: 'MDG',
    model: 'theONE',
    category: 'hazer',
    renderTypes: ['hazer', 'smoke'],
    body: 'hazer-box',
    weightKg: 23,
    powerW: 1480,
    modes: [
      { name: '5-Ch DMX/RDM', channels: 5 },
    ],
    sources: ['mdg-theone', 'ofl-mdg-theone'],
    unverified: [],
  },
  {
    id: 'look-solutions-unique-21',
    manufacturer: 'Look Solutions',
    model: 'Unique 2.1',
    category: 'hazer',
    renderTypes: ['hazer'],
    body: 'hazer-box',
    weightKg: 8.7,
    powerW: 1500,
    modes: [
      { name: '2-Ch (Pump + Fan)', channels: 2 },
    ],
    sources: ['look-solutions-unique-21'],
    unverified: [],
  },
  {
    id: 'martin-jem-zr45',
    manufacturer: 'Martin',
    model: 'JEM ZR45',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 17.7,
    powerW: 2100,
    modes: [
      { name: '1-Ch', channels: 1 },
    ],
    sources: ['martin-jem-zr45'],
    unverified: [],
  },
  {
    id: 'look-solutions-viper-nt',
    manufacturer: 'Look Solutions',
    model: 'Viper NT',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 8.3,
    powerW: 1300,
    modes: [
      { name: '2-Ch (Fog + Heat)', channels: 2 },
    ],
    sources: ['look-solutions-viper-nt', 'ofl-look-solutions-viper-nt'],
    unverified: [],
  },
  {
    id: 'magicfx-co2jet-ii',
    manufacturer: 'MagicFX',
    model: 'CO2Jet II',
    category: 'co2_jet',
    renderTypes: ['co2'],
    body: 'co2-jet',
    weightKg: 4.29,
    powerW: 20,
    modes: [
      { name: '1-Ch (External DMX Switchpack)', channels: 1 },
    ],
    sources: ['magicfx-co2jet-ii'],
    unverified: ['modes[0].channels'],
  },

  // ── Real Show Laser Systems (Class 3B & Class 4 across power tiers) ─────────
  {
    id: 'laserworld-cs-500g',
    manufacturer: 'Laserworld',
    model: 'CS-500G',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 5,
    powerW: 50,
    ipRating: 'IP20',
    laser: {
      colorType: 'single',
      wavelengthNm: 532,
      singleColorHex: '#00ff44',
      opticalPowerW: 0.4,
      scanSpeedKpps: 25,
      maxScanAngleDeg: 40,
      laserClass: '3B',
      capability: 'beam',
      control: ['dmx', 'ilda'],
    },
    modes: [
      { name: '15-Ch DMX', channels: 15 },
      { name: '12-Ch DMX', channels: 12 },
    ],
    sources: ['laserworld-cs-500g'],
    unverified: ['weightKg', 'ipRating', 'laser.scanSpeedKpps'],
  },
  {
    id: 'unity-raw-1-7',
    manufacturer: 'Unity Lasers',
    model: 'Raw 1.7',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 5.3,
    powerW: 100,
    ipRating: 'IP20',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 1.7,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 45,
      divergenceMrad: 1.1,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda'],
    },
    modes: [
      { name: 'Normal (10-Ch)', channels: 10 },
      { name: 'Expert (34-Ch)', channels: 34 },
    ],
    sources: ['unity-raw-1-7'],
    unverified: ['ipRating'],
  },
  {
    id: 'laserworld-ds-3000rgb',
    manufacturer: 'Laserworld',
    model: 'DS-3000RGB MK5',
    aliases: ['DS-3000RGB'],
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 5.5,
    powerW: 80,
    ipRating: 'IP4X',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 3,
      scanSpeedKpps: 40,
      maxScanAngleDeg: 40,
      divergenceMrad: 1.0,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'shownet'],
    },
    modes: [
      { name: 'ShowNET DJ (19-Ch)', channels: 19 },
      { name: 'ShowNET Pro (34-Ch)', channels: 34, layout: SHOWNET_PRO_34_LAYOUT },
    ],
    sources: ['laserworld-ds-3000rgb', 'laserworld-shownet'],
    unverified: [],
  },
  {
    id: 'kvant-clubmax',
    manufacturer: 'KVANT',
    model: 'Clubmax 6000 FB4',
    aliases: ['Clubmax'],
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 11.6,
    powerW: 400,
    ipRating: 'IP20',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 6,
      scanSpeedKpps: 40,
      maxScanAngleDeg: 60,
      divergenceMrad: 1.0,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'fb4'],
    },
    modes: [
      { name: 'FB4 16-Ch (FB3 Profile)', channels: 16, layout: FB4_16_LAYOUT },
      { name: 'FB4 39-Ch (Extended)', channels: 39, layout: FB4_39_LAYOUT },
      { name: 'Placeholder DMX (18-Ch)', channels: 18, legacy: true },
    ],
    sources: ['kvant-clubmax-6000', 'pangolin-fb4-dmx'],
    unverified: ['powerW', 'ipRating', 'modes[2].channels'],
  },
  {
    id: 'laserworld-pl-10000rgb',
    manufacturer: 'Laserworld',
    model: 'PL-10.000RGB MK3',
    aliases: ['PL-10000RGB'],
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 14.6,
    powerW: 350,
    ipRating: 'IP54',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 10,
      scanSpeedKpps: 40,
      maxScanAngleDeg: 50,
      divergenceMrad: 1.0,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'shownet'],
    },
    modes: [
      { name: 'ShowNET DJ (19-Ch)', channels: 19 },
      { name: 'ShowNET Pro (34-Ch)', channels: 34, layout: SHOWNET_PRO_34_LAYOUT },
    ],
    sources: ['laserworld-pl-10000rgb', 'laserworld-shownet'],
    unverified: [],
  },
  {
    id: 'kvant-spectrum',
    manufacturer: 'KVANT',
    model: 'Spectrum 30',
    aliases: ['Spectrum', 'Spectrum 25'],
    category: 'laser',
    renderTypes: ['floor_laser', 'laser'],
    body: 'laser-head',
    weightKg: 36,
    powerW: 900,
    ipRating: 'IP65',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 30,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 60,
      divergenceMrad: 1.0,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'fb4'],
    },
    modes: [
      { name: 'FB4 16-Ch (FB3 Profile)', channels: 16, layout: FB4_16_LAYOUT },
      { name: 'FB4 39-Ch (Extended)', channels: 39, layout: FB4_39_LAYOUT },
      { name: 'Placeholder DMX (18-Ch)', channels: 18, legacy: true },
    ],
    sources: ['kvant-spectrum-30', 'pangolin-fb4-dmx'],
    unverified: ['powerW', 'modes[2].channels'],
  },

  // ── Sprint 14b Expanded Catalogue (50 researched real products, neutral IDs) ─

  // ── Expanded Atmospherics (Hazers, Foggers, Low-Fog & CO2 Jets) ─────────────
  {
    id: 'hazer-water-01',
    manufacturer: 'JEM Professional',
    model: 'Hazer Pro',
    category: 'hazer',
    renderTypes: ['hazer'],
    body: 'hazer-box',
    weightKg: 15,
    powerW: 675,
    modes: [
      { name: '3-channel (Haze, Fan, Control)', channels: 3 },
    ],
    sources: ['jem-hazer-pro'],
    unverified: [],
  },
  {
    id: 'fogger-tour-01',
    manufacturer: 'JEM Professional',
    model: 'ZR35',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 15.1,
    powerW: 1500,
    modes: [
      { name: '1-channel', channels: 1 },
    ],
    sources: ['jem-zr35'],
    unverified: [],
  },
  {
    id: 'lowfog-chilled-01',
    manufacturer: 'JEM Professional',
    model: 'Glaciator Dynamic',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 124,
    powerW: 3500,
    ipRating: 'IP20',
    modes: [
      { name: '1-channel', channels: 1 },
      { name: '2-channel', channels: 2 },
    ],
    sources: ['jem-glaciator-dynamic'],
    unverified: [],
  },
  {
    id: 'hazer-oil-01',
    manufacturer: 'Antari',
    model: 'HZ-500',
    category: 'hazer',
    renderTypes: ['hazer'],
    body: 'hazer-box',
    weightKg: 31.5,
    powerW: 480,
    modes: [
      { name: '1-channel', channels: 1 },
    ],
    sources: ['antari-hz-500'],
    unverified: ['weightKg'],
  },
  {
    id: 'lowfog-ice-01',
    manufacturer: 'Antari',
    model: 'ICE-101',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 24.4,
    powerW: 1130,
    modes: [
      { name: '1-channel', channels: 1 },
    ],
    sources: ['antari-ice-101'],
    unverified: [],
  },
  {
    id: 'hazer-stadium-01',
    manufacturer: 'CHAUVET Professional',
    model: 'Amhaze Stadium',
    category: 'hazer',
    renderTypes: ['hazer'],
    body: 'hazer-box',
    weightKg: 17.4,
    powerW: 1230,
    ipRating: 'IP20',
    modes: [
      { name: 'Standard (single personality)', channels: 2 },
    ],
    sources: ['chauvet-amhaze-stadium'],
    unverified: ['powerW'],
  },
  {
    id: 'fogger-tour-02',
    manufacturer: 'Look Solutions',
    model: 'Cobra 3.1',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 16,
    powerW: 3100,
    modes: [
      { name: '1 ch (Fog intensity)', channels: 1 },
      { name: '2 ch (Fog intensity, Fog curve)', channels: 2 },
      { name: '3 ch (Fog intensity, Fog curve, Control)', channels: 3 },
    ],
    sources: ['look-solutions-cobra-31'],
    unverified: [],
  },
  {
    id: 'lowfog-co2-01',
    manufacturer: 'Look Solutions',
    model: 'Cryo-Fog High Pressure',
    category: 'fogger',
    renderTypes: ['smoke'],
    body: 'fogger-box',
    weightKg: 33,
    powerW: 2300,
    modes: [
      { name: '3-channel (Fog Intensity, Fan, Cooling)', channels: 3 },
    ],
    sources: ['look-solutions-cryo-fog', 'ofl-look-cryofog'],
    unverified: ['modes[0].channels'],
  },
  {
    id: 'co2-jet-moving-01',
    manufacturer: 'MagicFX',
    model: 'PSYCO2JET',
    category: 'co2_jet',
    renderTypes: ['co2'],
    body: 'co2-jet',
    weightKg: 8.2,
    powerW: 35,
    ipRating: 'IP23',
    modes: [
      { name: 'Raw (Angle, Speed, Output)', channels: 3 },
      { name: 'Preset (Preset, Speed, Direction, Go)', channels: 4 },
    ],
    auxSafetyChannelNote: 'Requires an additional separately addressed DMX safety channel (not reserved by auto-patch; reserve manually on desk).',
    sources: ['magicfx-psyco2jet', 'ofl-magicfx-psyco2jet'],
    unverified: [],
  },
  {
    id: 'co2-jet-fixed-01',
    manufacturer: 'CryoFX',
    model: 'CO2 Jet DMX 512',
    category: 'co2_jet',
    renderTypes: ['co2'],
    body: 'co2-jet',
    weightKg: 8.1,
    powerW: 100,
    modes: [
      { name: 'DMX', channels: 1 },
    ],
    sources: ['cryofx-co2-jet-dmx'],
    unverified: ['modes[0].channels'],
  },

  // ── Expanded Show Lasers (Class 3B & Class 4) ───────────────────────────────
  {
    id: 'laser-club-01',
    manufacturer: 'Laserworld',
    model: 'EL-400RGB S',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 3,
    powerW: 30,
    laser: {
      colorType: 'rgb',
      opticalPowerW: 0.4,
      scanSpeedKpps: 15,
      divergenceMrad: 2,
      beamDiameterMm: 3,
      laserClass: '3B',
      capability: 'beam',
      control: ['dmx'],
    },
    modes: [
      { name: 'Standard', channels: 16 },
      { name: 'Pro', channels: 36 },
    ],
    sources: ['laserworld-el-400rgb-s'],
    unverified: ['laser.divergenceMrad'],
  },
  {
    id: 'laser-club-02',
    manufacturer: 'Laserworld',
    model: 'DS-1000RGB MK5',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 3.8,
    powerW: 40,
    laser: {
      colorType: 'rgb',
      opticalPowerW: 1,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 40,
      divergenceMrad: 0.9,
      beamDiameterMm: 3,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'shownet'],
    },
    modes: [
      { name: 'DJ Mode', channels: 19 },
      { name: 'Professional Mode', channels: 34 },
    ],
    sources: ['laserworld-ds-1000rgb-mk5', 'laserworld-shownet-dmx'],
    unverified: ['modes[0].channels', 'modes[1].channels'],
  },
  {
    id: 'laser-club-03',
    manufacturer: 'Stairville (Thomann)',
    model: 'DJ Lase RGB Pro Advanced 1000',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 3.6,
    powerW: 25,
    laser: {
      colorType: 'rgb',
      opticalPowerW: 1,
      scanSpeedKpps: 20,
      maxScanAngleDeg: 36,
      divergenceMrad: 2,
      beamDiameterMm: 5,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda'],
    },
    modes: [
      { name: '20ch', channels: 20 },
    ],
    sources: ['stairville-dj-lase-rgb-1000'],
    unverified: ['laser.divergenceMrad', 'laser.beamDiameterMm', 'laser.scanSpeedKpps'],
  },
  {
    id: 'laser-tour-01',
    manufacturer: 'Kvant',
    model: 'Clubmax 3000 FB4',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 8.8,
    powerW: 340,
    ipRating: 'IP20',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 3,
      maxOpticalPowerW: 3.48,
      scanSpeedKpps: 40,
      maxScanAngleDeg: 60,
      divergenceMrad: 0.6,
      beamDiameterMm: 4.5,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'fb4'],
    },
    modes: [
      { name: 'FB4 16-Ch (FB3 Profile)', channels: 16 },
      { name: 'FB4 39-Ch (Extended)', channels: 39 },
    ],
    sources: ['kvant-clubmax-3000-fb4', 'pangolin-fb4-dmx'],
    unverified: ['modes[0].channels', 'modes[1].channels'],
  },
  {
    id: 'laser-outdoor-01',
    manufacturer: 'X-Laser',
    model: 'Triton T-5',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 9.52,
    powerW: 200,
    ipRating: 'IP64',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 5,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 45,
      divergenceMrad: 1.4,
      beamDiameterMm: null,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx'],
    },
    modes: [
      { name: 'DMX', channels: 32 },
    ],
    sources: ['xlaser-triton-t5'],
    unverified: ['laser.divergenceMrad', 'laser.beamDiameterMm', 'modes[0].channels'],
  },
  {
    id: 'laser-tour-02',
    manufacturer: 'Kvant',
    model: 'Clubmax 10 FB4',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 13,
    powerW: 340,
    ipRating: 'IP20',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 9.7,
      maxOpticalPowerW: 10.4,
      scanSpeedKpps: 40,
      maxScanAngleDeg: 60,
      divergenceMrad: 0.9,
      beamDiameterMm: 5,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'fb4'],
    },
    modes: [
      { name: 'FB4 16-Ch (FB3 Profile)', channels: 16 },
      { name: 'FB4 39-Ch (Extended)', channels: 39 },
    ],
    sources: ['kvant-clubmax-10-fb4', 'pangolin-fb4-dmx'],
    unverified: ['laser.scanSpeedKpps', 'modes[0].channels', 'modes[1].channels'],
  },
  {
    id: 'laser-outdoor-02',
    manufacturer: 'Laserworld',
    model: 'DS-15.000 IP65',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 11.5,
    powerW: 120,
    ipRating: 'IP65',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 15,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 50,
      divergenceMrad: 1.1,
      beamDiameterMm: 5.5,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'shownet'],
    },
    modes: [
      { name: 'Professional Mode', channels: 34, layout: SHOWNET_PRO_34_LAYOUT },
      { name: 'DJ Mode', channels: 19 },
    ],
    sources: ['laserworld-ds-15000-ip65', 'laserworld-shownet-dmx'],
    unverified: ['laser.divergenceMrad', 'modes[1].channels'],
  },
  {
    id: 'laser-outdoor-03',
    manufacturer: 'Laserworld',
    model: 'DS-30.000 IP65',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 17.3,
    powerW: 350,
    ipRating: 'IP65',
    laser: {
      colorType: 'rgb',
      opticalPowerW: 30,
      scanSpeedKpps: 30,
      maxScanAngleDeg: 50,
      divergenceMrad: 1.1,
      beamDiameterMm: 5.5,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'shownet'],
    },
    modes: [
      { name: 'Professional Mode', channels: 34, layout: SHOWNET_PRO_34_LAYOUT },
      { name: 'DJ Mode', channels: 19 },
    ],
    sources: ['laserworld-ds-30000-ip65', 'laserworld-shownet-dmx'],
    unverified: ['laser.divergenceMrad', 'modes[1].channels'],
  },
  {
    id: 'laser-arena-01',
    manufacturer: 'Kvant',
    model: 'Clubmax 40 FB4',
    category: 'laser',
    renderTypes: ['floor_laser', 'laser'],
    body: 'laser-head',
    weightKg: 20,
    powerW: 1200,
    laser: {
      colorType: 'rgb',
      opticalPowerW: 36.7,
      scanSpeedKpps: 30,
      divergenceMrad: 1.1,
      beamDiameterMm: 7,
      laserClass: '4',
      capability: 'beam_graphic',
      control: ['dmx', 'ilda', 'fb4'],
    },
    modes: [
      { name: 'FB4 16-Ch (FB3 Profile)', channels: 16 },
      { name: 'FB4 39-Ch (Extended)', channels: 39 },
    ],
    sources: ['kvant-clubmax-40-fb4', 'pangolin-fb4-dmx'],
    unverified: ['laser.divergenceMrad', 'laser.laserClass', 'modes[0].channels', 'modes[1].channels'],
  },

  // ── Expanded LED Video Panels ───────────────────────────────────────────────
  {
    id: 'panel-mesh-01',
    manufacturer: 'ROE Visual',
    model: 'Vanish V8T',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 18.2,
    powerW: 480,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 1000, heightMm: 1000, pitchMm: 8.9, pixelsWide: 112, pixelsHigh: 112 },
    sources: ['roe-vanish-v8t'],
    unverified: [],
  },
  {
    id: 'panel-outdoor-01',
    manufacturer: 'ROE Visual',
    model: 'Black Quartz BQ3.9',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 17.8,
    powerW: 360,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 500, heightMm: 1000, pitchMm: 3.9, pixelsWide: 128, pixelsHigh: 256 },
    sources: ['roe-black-quartz-bq39'],
    unverified: [],
  },
  {
    id: 'panel-outdoor-02',
    manufacturer: 'ROE Visual',
    model: 'Vanish ST V3ST',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 27.5,
    powerW: 700,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 1000, heightMm: 1000, pitchMm: 3.9, pixelsWide: 256, pixelsHigh: 256 },
    sources: ['roe-vanish-st-v3st'],
    unverified: [],
  },
  {
    id: 'panel-floor-01',
    manufacturer: 'ROE Visual',
    model: 'Black Marble BM5',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 13.5,
    powerW: 270,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 600, heightMm: 600, pitchMm: 5.77, pixelsWide: 104, pixelsHigh: 104 },
    sources: ['roe-black-marble-bm5'],
    unverified: [],
  },
  {
    id: 'panel-indoor-01',
    manufacturer: 'ROE Visual',
    model: 'Ruby RB1.5F',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 8.16,
    powerW: 140,
    ipRating: 'IP40',
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 1.56, pixelsWide: 320, pixelsHigh: 320 },
    sources: ['roe-ruby-rb15f'],
    unverified: [],
  },
  {
    id: 'panel-outdoor-03',
    manufacturer: 'Absen',
    model: 'PL3.9 Pro V10',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 8.4,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 3.9, pixelsWide: 128, pixelsHigh: 128 },
    sources: ['absen-pl-pro-v10'],
    unverified: ['weightKg', 'ipRating', 'panel'],
  },
  {
    id: 'panel-outdoor-04',
    manufacturer: 'Absen',
    model: 'PL4.8 Pro V10',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 8.1,
    powerW: 180,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 4.8, pixelsWide: 104, pixelsHigh: 104 },
    sources: ['absen-pl-pro-v10'],
    unverified: ['weightKg', 'powerW', 'ipRating', 'panel'],
  },
  {
    id: 'panel-indoor-02',
    manufacturer: 'Absen',
    model: 'PL2.5 Pro V10',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 8.8,
    ipRating: 'IP40',
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 2.5, pixelsWide: 200, pixelsHigh: 200 },
    sources: ['absen-pl-pro-v10'],
    unverified: ['weightKg', 'ipRating', 'panel'],
  },
  {
    id: 'panel-mesh-02',
    manufacturer: 'Planar (Leyard)',
    model: 'CarbonLight CLM6.9',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 4.8,
    powerW: 300,
    ipRating: 'IP65',
    modes: [],
    panel: { widthMm: 1000, heightMm: 500, pitchMm: 6.9, pixelsWide: 144, pixelsHigh: 72 },
    sources: ['planar-clm69'],
    unverified: ['panel'],
  },
  {
    id: 'panel-floor-02',
    manufacturer: 'Planar (Leyard)',
    model: 'CarbonLight CLF VX2.6',
    category: 'led_panel',
    renderTypes: [],
    body: 'led-panel',
    weightKg: 8,
    powerW: 150,
    modes: [],
    panel: { widthMm: 500, heightMm: 500, pitchMm: 2.6, pixelsWide: 192, pixelsHigh: 192 },
    sources: ['planar-clf-vx26'],
    unverified: [],
  },

  // ── Expanded Moving Heads (Profiles, Spots, Hybrid, Beam & Wash) ────────────
  {
    id: 'profile-compact-01',
    manufacturer: 'Ayrton',
    model: 'Diablo Profile S',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 22,
    powerW: 550,
    ipRating: 'IP20',
    optics: { lumens: 19000, zoomDeg: [7, 53] },
    modes: [
      { name: 'Basic', channels: 34 },
      { name: 'Standard', channels: 36 },
      { name: 'Extended', channels: 56 },
    ],
    sources: ['ayrton-diablo-s', 'ofl-ayrton-diablo-s'],
    unverified: [],
  },
  {
    id: 'profile-tour-01',
    manufacturer: 'Ayrton',
    model: 'Khamsin S',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 39.8,
    powerW: 1150,
    ipRating: 'IP20',
    optics: { lumens: 40000, zoomDeg: [7, 58] },
    modes: [
      { name: 'Basic', channels: 40 },
      { name: 'Standard', channels: 42 },
      { name: 'Extended', channels: 64 },
    ],
    sources: ['ayrton-khamsin-s'],
    unverified: [],
  },
  {
    id: 'profile-tour-02',
    manufacturer: 'Robe',
    model: 'T2 Profile',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 36.9,
    powerW: 1150,
    ipRating: 'IP20',
    optics: { lumens: 22000, zoomDeg: [5, 55] },
    modes: [
      { name: 'Mode 1', channels: 52 },
      { name: 'Mode 2', channels: 36 },
      { name: 'Mode 3', channels: 56 },
    ],
    sources: ['robe-t2-profile'],
    unverified: [],
  },
  {
    id: 'profile-tour-03',
    manufacturer: 'Robe',
    model: 'ESPRITE',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 28.2,
    ipRating: 'IP20',
    optics: { zoomDeg: [5.5, 50] },
    modes: [
      { name: 'Mode 1 (Standard 16 bit)', channels: 49 },
      { name: 'Mode 2 (Reduced 8 bit)', channels: 42 },
      { name: 'Mode 3 (Standard 16 bit + green correction)', channels: 50 },
      { name: 'Mode 4 (Reduced 8 bit + green correction)', channels: 43 },
      { name: 'Mode 5 (Enhanced gobo control)', channels: 51 },
    ],
    sources: ['robe-esprite'],
    unverified: [],
  },
  {
    id: 'profile-tour-04',
    manufacturer: 'CHAUVET Professional',
    model: 'Maverick MK3 Profile',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 34.7,
    powerW: 1180,
    ipRating: 'IP20',
    optics: { lumens: 23000, zoomDeg: [5.9, 64.1] },
    modes: [
      { name: '38-channel', channels: 38 },
      { name: '54-channel', channels: 54 },
    ],
    sources: ['chauvet-maverick-mk3-profile'],
    unverified: [],
  },
  {
    id: 'profile-outdoor-01',
    manufacturer: 'CHAUVET Professional',
    model: 'Maverick Storm 3 Profile',
    category: 'profile',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-profile',
    weightKg: 31.3,
    powerW: 1010,
    ipRating: 'IP65',
    optics: { lumens: 34500, zoomDeg: [3.5, 57.7] },
    modes: [
      { name: '34-channel', channels: 34 },
      { name: '50-channel', channels: 50 },
    ],
    sources: ['chauvet-maverick-storm-3-profile'],
    unverified: [],
  },
  {
    id: 'spot-led-01',
    manufacturer: 'CHAUVET Professional',
    model: 'Rogue R2X Spot',
    category: 'spot',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-spot',
    weightKg: 21.7,
    powerW: 481,
    ipRating: 'IP20',
    optics: { lumens: 14789, beamDeg: 16 },
    modes: [
      { name: '18-channel', channels: 18 },
      { name: '21-channel', channels: 21 },
    ],
    sources: ['chauvet-rogue-r2x-spot'],
    unverified: [],
  },
  {
    id: 'spot-hybrid-01',
    manufacturer: 'Martin',
    model: 'RUSH MH 7 Hybrid',
    category: 'spot',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-spot',
    weightKg: 24,
    powerW: 372,
    ipRating: 'IP20',
    optics: { zoomDeg: [2.2, 45] },
    modes: [
      { name: '21-channel', channels: 21 },
    ],
    sources: ['martin-rush-mh-7-hybrid', 'ofl-martin-rush-mh-7-hybrid'],
    unverified: ['optics.zoomDeg'],
  },
  {
    id: 'spot-compact-01',
    manufacturer: 'Martin',
    model: 'RUSH MH 5 Profile',
    category: 'spot',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-spot',
    weightKg: 9,
    powerW: 165,
    ipRating: 'IP20',
    optics: { beamDeg: 14 },
    modes: [
      { name: '16-channel', channels: 16 },
    ],
    sources: ['martin-rush-mh-5-profile', 'ofl-martin-rush-mh-5-profile'],
    unverified: [],
  },
  {
    id: 'beam-compact-01',
    manufacturer: 'Martin',
    model: 'MAC One',
    category: 'beam',
    renderTypes: ['beam', 'wash', 'floor_beam'],
    body: 'moving-beam',
    weightKg: 4.4,
    powerW: 180,
    ipRating: 'IP20',
    optics: { lumens: 2500, zoomDeg: [4, 19] },
    modes: [
      { name: 'Compact', channels: 20 },
      { name: 'Basic', channels: 36 },
      { name: 'Ludicrous', channels: 108 },
      { name: 'Compact Direct', channels: 20 },
    ],
    sources: ['martin-mac-one'],
    unverified: [],
  },
  {
    id: 'spot-club-01',
    manufacturer: 'Showtec',
    model: 'Phantom 130 Spot',
    category: 'spot',
    renderTypes: ['beam', 'floor_beam'],
    body: 'moving-spot',
    weightKg: 13.1,
    powerW: 270,
    optics: { zoomDeg: [12, 21] },
    modes: [
      { name: '12-channel', channels: 12 },
      { name: '16-channel', channels: 16 },
    ],
    sources: ['showtec-phantom-130-spot'],
    unverified: [],
  },
  {
    id: 'wash-outdoor-01',
    manufacturer: 'CHAUVET Professional',
    model: 'Rogue Outcast 2X Wash',
    category: 'wash',
    renderTypes: ['wash'],
    body: 'moving-wash',
    weightKg: 9.6,
    powerW: 291,
    ipRating: 'IP65',
    optics: { lumens: 6258, zoomDeg: [8, 36.1] },
    modes: [
      { name: '56CH', channels: 56 },
      { name: '55CH', channels: 55 },
      { name: '54CH', channels: 54 },
      { name: '33CH', channels: 33 },
      { name: '23CH', channels: 23 },
      { name: '22CH', channels: 22 },
      { name: '17CH', channels: 17 },
      { name: '15CH', channels: 15 },
      { name: '54MS', channels: 54 },
      { name: '33MS', channels: 33 },
    ],
    sources: ['chauvet-rogue-outcast-2x-wash'],
    unverified: ['weightKg'],
  },

  // ── Expanded Battens, PARs, Ellipsoidals, Blinders & Strobes ────────────────
  {
    id: 'batten-tilt-01',
    manufacturer: 'Robe',
    model: 'Robin Tetra2',
    category: 'led_batten',
    renderTypes: ['wash'],
    body: 'led-batten',
    weightKg: 18.1,
    powerW: 600,
    ipRating: 'IP20',
    optics: { lumens: 10500, zoomDeg: [4, 45] },
    modes: [
      { name: 'Mode 1 - Wash', channels: 34 },
      { name: 'Mode 2 - Pattern', channels: 56 },
      { name: 'Mode 3 - Pixel RGB', channels: 97 },
      { name: 'Mode 4 - Pixel RGBW', channels: 115 },
      { name: 'Mode 5 - Pattern full RGB', channels: 110 },
      { name: 'Mode 6 - Pattern full RGBW', channels: 128 },
    ],
    sources: ['robe-robin-tetra2'],
    unverified: [
      'modes[0].name',
      'modes[1].name',
      'modes[2].name',
      'modes[3].name',
      'modes[4].name',
      'modes[5].name',
    ],
  },
  {
    id: 'batten-static-01',
    manufacturer: 'CHAUVET DJ',
    model: 'COLORband PiX IP',
    category: 'led_batten',
    renderTypes: ['wash'],
    body: 'led-batten',
    motion: 'fixed',
    weightKg: 6.1,
    powerW: 103,
    ipRating: 'IP65',
    optics: { beamDeg: 20 },
    modes: [
      { name: '3ch', channels: 3 },
      { name: '4ch', channels: 4 },
      { name: '6ch', channels: 6 },
      { name: '7ch', channels: 7 },
      { name: '9ch', channels: 9 },
      { name: '12ch', channels: 12 },
      { name: '18ch', channels: 18 },
      { name: '36ch', channels: 36 },
    ],
    sources: ['chauvet-dj-colorband-pix-ip', 'ofl-chauvet-dj-colorband-pix-ip'],
    unverified: [],
  },
  {
    id: 'par-zoom-01',
    manufacturer: 'CHAUVET Professional',
    model: 'COLORado 1 Solo',
    category: 'led_par',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 5.4,
    powerW: 65,
    ipRating: 'IP65',
    optics: { zoomDeg: [4, 40] },
    modes: [
      { name: 'Std. Y mode', channels: 17 },
      { name: 'TR16 mode', channels: 17 },
      { name: 'TOUR mode', channels: 12 },
      { name: 'SSP mode', channels: 9 },
      { name: 'HSIC mode', channels: 9 },
    ],
    sources: ['chauvet-colorado-1-solo', 'ofl-chauvet-colorado-1-solo'],
    unverified: [],
  },
  {
    id: 'par-zoom-02',
    manufacturer: 'Elation Professional',
    model: 'Fuze Par Z60 IP',
    category: 'led_par',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 4.5,
    powerW: 78,
    ipRating: 'IP65',
    optics: { zoomDeg: [7, 39] },
    modes: [
      { name: '4ch RGBW', channels: 4 },
      { name: '4ch HSI', channels: 4 },
      { name: '5ch HSI', channels: 5 },
      { name: '6ch RGBW', channels: 6 },
      { name: '7ch sRGBWI', channels: 7 },
      { name: '7ch RGBW', channels: 7 },
      { name: '8ch RGBW', channels: 8 },
      { name: '9ch RGBW', channels: 9 },
      { name: '10ch 16Bit', channels: 10 },
      { name: '10ch HSI', channels: 10 },
      { name: '12ch sRGBI', channels: 12 },
      { name: '13ch RGBW', channels: 13 },
    ],
    sources: ['elation-fuze-par-z60-ip', 'ofl-elation-fuze-par-z60ip'],
    unverified: [],
  },
  {
    id: 'par-zoom-03',
    manufacturer: 'Martin',
    model: 'RUSH PAR 2 RGBW Zoom',
    category: 'led_par',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 5.5,
    powerW: 151,
    ipRating: 'IP20',
    optics: { zoomDeg: [10, 60] },
    modes: [
      { name: '5-channel mode', channels: 5 },
      { name: '9-channel mode', channels: 9 },
    ],
    sources: ['martin-rush-par-2-rgbw-zoom', 'ofl-martin-rush-par-2-rgbw-zoom'],
    unverified: ['optics.zoomDeg'],
  },
  {
    id: 'ellipsoidal-led-01',
    manufacturer: 'ETC',
    model: 'Source Four LED Series 3 Lustr X8',
    category: 'profile',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 8.9,
    powerW: 307,
    ipRating: 'IP20',
    optics: { lumens: 10889, zoomDeg: [5, 90] },
    modes: [
      { name: 'Direct mode', channels: 12 },
      { name: 'Expanded mode', channels: 11 },
      { name: 'Studio mode', channels: 7 },
      { name: '3 Ch RGB mode', channels: 3 },
      { name: 'Intensity mode', channels: 1 },
    ],
    sources: ['etc-s4-led-s3-lustr-x8', 'ofl-etc-s4-led-s3-lustr-x8'],
    unverified: [],
  },
  {
    id: 'ellipsoidal-led-02',
    manufacturer: 'CHAUVET Professional',
    model: 'Ovation E-910FC',
    category: 'profile',
    renderTypes: ['wash'],
    body: 'led-par',
    weightKg: 7.1,
    powerW: 220,
    ipRating: 'IP20',
    optics: { lumens: 7263, zoomDeg: [7, 41] },
    modes: [
      { name: '1Ch', channels: 1 },
      { name: '3Ch', channels: 3 },
      { name: '5Ch', channels: 5 },
      { name: '7Ch', channels: 7 },
      { name: '10Ch', channels: 10 },
      { name: '12Ch', channels: 12 },
      { name: '13Ch', channels: 13 },
      { name: '16Ch', channels: 16 },
      { name: 'HSV', channels: 3 },
    ],
    sources: ['chauvet-ovation-e-910fc'],
    unverified: ['modes[8].channels'],
  },
  {
    id: 'blinder-single-01',
    manufacturer: 'CHAUVET Professional',
    model: 'STRIKE 1',
    category: 'blinder',
    renderTypes: ['blinder'],
    body: 'blinder-4lite',
    weightKg: 8.6,
    powerW: 265,
    ipRating: 'IP65',
    optics: { beamDeg: 30 },
    modes: [
      { name: '1Ch', channels: 1 },
      { name: '3Ch', channels: 3 },
      { name: '4Ch', channels: 4 },
      { name: '5Ch', channels: 5 },
      { name: '6Ch', channels: 6 },
      { name: '7Ch', channels: 7 },
    ],
    sources: ['chauvet-strike-1'],
    unverified: [],
  },
  {
    id: 'strobe-panel-01',
    manufacturer: 'ADJ',
    model: 'Jolt Panel FXIP',
    category: 'strobe',
    renderTypes: ['strobe'],
    body: 'strobe-panel',
    weightKg: 9.1,
    powerW: 214,
    ipRating: 'IP65',
    optics: { beamDeg: 73 },
    modes: [
      { name: '6Ch', channels: 6 },
      { name: '9Ch', channels: 9 },
      { name: '13Ch', channels: 13 },
      { name: '18Ch', channels: 18 },
      { name: '20Ch', channels: 20 },
      { name: '36Ch', channels: 36 },
      { name: '41Ch', channels: 41 },
      { name: '43Ch', channels: 43 },
      { name: '51Ch', channels: 51 },
      { name: '81Ch', channels: 81 },
      { name: '83Ch', channels: 83 },
      { name: '126Ch', channels: 126 },
      { name: '141Ch', channels: 141 },
      { name: '143Ch', channels: 143 },
    ],
    sources: ['adj-jolt-panel-fxip'],
    unverified: [
      'weightKg',
      'powerW',
      'ipRating',
      'optics.beamDeg',
      'modes[0].channels',
      'modes[1].channels',
      'modes[2].channels',
      'modes[3].channels',
      'modes[4].channels',
      'modes[5].channels',
      'modes[6].channels',
      'modes[7].channels',
      'modes[8].channels',
      'modes[9].channels',
      'modes[10].channels',
      'modes[11].channels',
      'modes[12].channels',
      'modes[13].channels',
    ],
  },
] as const satisfies readonly CatalogEntry[];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  EQUIPMENT_CATALOG.map((entry) => [entry.id, entry]),
);

/** Maps every legacy StageForge fixture / floor-FX type to its closest catalogue default. */
export const LEGACY_DEFAULTS: Readonly<Record<HardwareType, string>> = {
  beam: 'claypaky-sharpy',
  wash: 'martin-mac-aura-xb',
  laser: 'kvant-clubmax',
  strobe: 'glp-jdc1',
  blinder: 'mole-richardson-molefay-4lite',
  hazer: 'mdg-atme',
  smoke: 'martin-jem-zr45',
  co2: 'magicfx-co2jet-ii',
  floor_laser: 'kvant-spectrum',
  floor_beam: 'robe-megapointe',
};

export const DEFAULT_LED_PANEL_ID = 'roe-bp2-v2';

export function getCatalogEntry(id: string | undefined): CatalogEntry | undefined {
  return id ? CATALOG_BY_ID.get(id) : undefined;
}

export function getCatalogMode(entry: CatalogEntry, modeName?: string): CatalogDmxMode | undefined {
  if (!entry.modes.length) return undefined;
  if (!modeName) return entry.modes[0];
  return entry.modes.find((m) => m.name === modeName);
}

/** Non-legacy DMX modes shown for new selections in EquipmentPicker. */
export function getSelectableModes(entry: CatalogEntry): readonly CatalogDmxMode[] {
  return entry.modes.filter((m) => !m.legacy);
}

export function catalogDisplayName(entry: Pick<CatalogEntry, 'manufacturer' | 'model'>): string {
  return `${entry.manufacturer} ${entry.model}`;
}

export function catalogForRenderType(type: HardwareType): readonly CatalogEntry[] {
  return EQUIPMENT_CATALOG.filter((entry) => (entry.renderTypes as readonly HardwareType[]).includes(type));
}

export function catalogLedPanels(): readonly CatalogEntry[] {
  return EQUIPMENT_CATALOG.filter((entry) => entry.category === 'led_panel' && entry.panel !== undefined);
}

export function isFieldUnverified(entry: CatalogEntry, fieldPath: string): boolean {
  return (entry.unverified as readonly string[]).includes(fieldPath);
}

export function hasCatalogFixtures(rig: Pick<RigConfig, 'trussPods' | 'floorFx'>): boolean {
  for (const pod of rig.trussPods) {
    if (pod.fixtures.some((f) => f.catalogId !== undefined)) return true;
  }
  return rig.floorFx.some((f) => f.catalogId !== undefined);
}

export function checkCatalogChannelDrift(
  group: Pick<MountedFixtureGroup | FloorFxUnit, 'catalogId' | 'dmxMode' | 'dmxChannels'>,
): { expectedChannels: number; actualChannels: number } | undefined {
  if (!group.catalogId || !group.dmxMode || group.dmxChannels === undefined) return undefined;
  const entry = getCatalogEntry(group.catalogId);
  if (!entry) return undefined;
  const mode = getCatalogMode(entry, group.dmxMode);
  if (!mode || mode.channels === group.dmxChannels) return undefined;
  return { expectedChannels: mode.channels, actualChannels: group.dmxChannels };
}

export interface SpecBadge {
  text: string;
  unverified: boolean;
}

export function formatCatalogSpecBadges(entry: CatalogEntry, modeName?: string): SpecBadge[] {
  const badges: SpecBadge[] = [];
  if (entry.weightKg !== undefined) {
    badges.push({ text: `${entry.weightKg} kg`, unverified: isFieldUnverified(entry, 'weightKg') });
  }
  if (entry.powerW !== undefined) {
    badges.push({ text: `${entry.powerW} W`, unverified: isFieldUnverified(entry, 'powerW') });
  }
  if (entry.ipRating) {
    badges.push({ text: entry.ipRating, unverified: isFieldUnverified(entry, 'ipRating') });
  }
  if (entry.optics?.zoomDeg) {
    badges.push({
      text: `${entry.optics.zoomDeg[0]}–${entry.optics.zoomDeg[1]}°`,
      unverified: isFieldUnverified(entry, 'optics.zoomDeg'),
    });
  } else if (entry.optics?.beamDeg !== undefined) {
    badges.push({
      text: `${entry.optics.beamDeg}°`,
      unverified: isFieldUnverified(entry, 'optics.beamDeg'),
    });
  }
  if (entry.optics?.lumens !== undefined) {
    badges.push({
      text: `${entry.optics.lumens.toLocaleString()} lm`,
      unverified: isFieldUnverified(entry, 'optics.lumens'),
    });
  }
  if (entry.laser) {
    const powerLabel = entry.laser.opticalPowerW < 1
      ? `${Math.round(entry.laser.opticalPowerW * 1000)} mW`
      : `${entry.laser.opticalPowerW} W`;
    const colorLabel = entry.laser.colorType === 'single'
      ? `${entry.laser.wavelengthNm ?? 520} nm`
      : 'RGB';
    badges.push({
      text: `${powerLabel} ${colorLabel}`,
      unverified: isFieldUnverified(entry, 'laser.opticalPowerW'),
    });
    badges.push({
      text: `${entry.laser.scanSpeedKpps} kpps`,
      unverified: isFieldUnverified(entry, 'laser.scanSpeedKpps'),
    });
    badges.push({
      text: `Class ${entry.laser.laserClass}`,
      unverified: isFieldUnverified(entry, 'laser.laserClass'),
    });
  }
  if (entry.panel) {
    badges.push({
      text: `${entry.panel.pitchMm} mm · ${entry.panel.widthMm}×${entry.panel.heightMm} mm`,
      unverified: isFieldUnverified(entry, 'panel'),
    });
  }
  const modeIdx = modeName ? entry.modes.findIndex((m) => m.name === modeName) : 0;
  const mode = modeIdx >= 0 ? entry.modes[modeIdx] : entry.modes[0];
  if (mode) {
    const idx = modeIdx >= 0 ? modeIdx : 0;
    badges.push({
      text: `${mode.channels} ch`,
      unverified: isFieldUnverified(entry, `modes[${idx}].channels`),
    });
  }
  return badges;
}
