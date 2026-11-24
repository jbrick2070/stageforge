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

export interface CatalogDmxMode {
  readonly name: string;
  readonly channels: number;
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

export interface CatalogEntry {
  readonly id: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly category: CatalogCategory;
  /** Compatible StageForge simulation/render types ([0] = default; empty for led_panel). */
  readonly renderTypes: readonly HardwareType[];
  /** Body geometry family hint for Round 2 procedural 3D models. */
  readonly body: CatalogBodyFamily;
  readonly weightKg?: number;
  readonly powerW?: number;
  readonly ipRating?: string;
  readonly optics?: CatalogOpticsSpec;
  /** Published DMX modes ([0] = default; empty for led_panel). */
  readonly modes: readonly CatalogDmxMode[];
  readonly panel?: CatalogPanelSpec;
  /** True for laser entries until Realism item 2 expands laser specifications and ILDA support. */
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

  // ── Lasers (Placeholders until Realism Item 2) ──────────────────────────────
  {
    id: 'kvant-clubmax',
    manufacturer: 'KVANT',
    model: 'Clubmax',
    category: 'laser',
    renderTypes: ['laser', 'floor_laser'],
    body: 'laser-head',
    weightKg: 14.5,
    powerW: 350,
    modes: [
      { name: 'Placeholder DMX (18-Ch)', channels: 18 },
    ],
    placeholder: true,
    sources: [],
    unverified: ['weightKg', 'powerW', 'modes[0].channels'],
  },
  {
    id: 'kvant-spectrum',
    manufacturer: 'KVANT',
    model: 'Spectrum',
    category: 'laser',
    renderTypes: ['floor_laser', 'laser'],
    body: 'laser-head',
    weightKg: 24.5,
    powerW: 650,
    modes: [
      { name: 'Placeholder DMX (18-Ch)', channels: 18 },
    ],
    placeholder: true,
    sources: [],
    unverified: ['weightKg', 'powerW', 'modes[0].channels'],
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
