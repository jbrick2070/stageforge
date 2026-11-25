import type { FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import {
  catalogDisplayName,
  EQUIPMENT_CATALOG,
  getCatalogEntry,
  LEGACY_DEFAULTS,
  type CatalogCategory,
  type CatalogEntry,
  type HardwareType,
} from './equipmentCatalog';
import type { NativeStage } from './showFile';
import { authoredWallFrames, authoredWallSurface, resolveStudioGeometry } from './studioGeometry';
import { ledPlacement } from './stageEquipment';

export type ShopProfileId = 'unlimited' | 'club' | 'regional' | 'touring' | 'custom';

export interface ShopPresetMeta {
  readonly id: Exclude<ShopProfileId, 'custom'>;
  readonly name: string;
  readonly shortName: string;
  readonly description: string;
  readonly illustrative: boolean;
  /** Map from catalogId -> quantity in stock, or null for unlimited. */
  readonly stock: Readonly<Record<string, number>> | null;
}

export interface ShopStockState {
  profileId: ShopProfileId;
  /** When true, over-stock additions are allowed as soft sub-rental warnings instead of hard blocks. */
  allowOverStock: boolean;
  /** Custom per-model stock map used when profileId === 'custom'. */
  customStock: Record<string, number>;
}

export interface StockViolation {
  stockKey: string;
  model: string;
  inStock: number;
  prevNeed: number;
  nextNeed: number;
}

export const SHOP_STORAGE_KEY = 'stageforge.shop.v1';
export const MAX_STOCK_QTY = 9999;

const KNOWN_CATALOG_IDS = new Set<string>(EQUIPMENT_CATALOG.map((e) => e.id));

// Fictional, generic rental-house stock tiers (illustrative quantities only — not modelled on any real vendor).
const CLUB_STOCK: Readonly<Record<string, number>> = {
  // Moving beams / spots / profiles / followspots
  'claypaky-sharpy': 8,
  'robe-megapointe': 4,
  'robe-ledbeam-150': 8,
  'martin-mac-ultra-performance': 0,
  'robe-bmfl-spot': 0,
  'robe-t1-profile': 4,
  'ayrton-perseo-profile': 0,
  'robe-bmfl-followspot': 1,
  // Washes / PARs / battens
  'martin-mac-aura-xb': 8,
  'martin-mac-aura-xip': 4,
  'robe-spiider': 4,
  'chauvet-rogue-r1-beamwash': 12,
  'chauvet-colorado-1-quad-zoom': 16,
  'etc-colorsource-par': 16,
  'chauvet-colorado-pxl-bar-16': 6,
  'glp-impression-x4-bar-20': 4,
  // Strobes & blinders
  'glp-jdc1': 4,
  'martin-atomic-3000-led': 6,
  'mole-richardson-molefay-4lite': 4,
  'chauvet-strike-4': 4,
  // LED video panels (cabinets)
  'roe-bp2-v2': 48,
  'roe-cb5': 36,
  // Atmospherics & SFX
  'mdg-atme': 1,
  'mdg-theone': 0,
  'look-solutions-unique-21': 2,
  'martin-jem-zr45': 2,
  'look-solutions-viper-nt': 2,
  'magicfx-co2jet-ii': 4,
  // Lasers
  'laserworld-cs-500g': 2,
  'unity-raw-1-7': 2,
  'laserworld-ds-3000rgb': 1,
  'kvant-clubmax': 0,
  'laserworld-pl-10000rgb': 0,
  'kvant-spectrum': 0,
};

const REGIONAL_STOCK: Readonly<Record<string, number>> = {
  'claypaky-sharpy': 24,
  'robe-megapointe': 16,
  'robe-ledbeam-150': 24,
  'martin-mac-ultra-performance': 8,
  'robe-bmfl-spot': 12,
  'robe-t1-profile': 12,
  'ayrton-perseo-profile': 8,
  'robe-bmfl-followspot': 2,
  'martin-mac-aura-xb': 20,
  'martin-mac-aura-xip': 16,
  'robe-spiider': 12,
  'chauvet-rogue-r1-beamwash': 24,
  'chauvet-colorado-1-quad-zoom': 32,
  'etc-colorsource-par': 32,
  'chauvet-colorado-pxl-bar-16': 16,
  'glp-impression-x4-bar-20': 12,
  'glp-jdc1': 12,
  'martin-atomic-3000-led': 16,
  'mole-richardson-molefay-4lite': 12,
  'chauvet-strike-4': 12,
  'roe-bp2-v2': 140,
  'roe-cb5': 120,
  'mdg-atme': 4,
  'mdg-theone': 2,
  'look-solutions-unique-21': 4,
  'martin-jem-zr45': 4,
  'look-solutions-viper-nt': 4,
  'magicfx-co2jet-ii': 8,
  'laserworld-cs-500g': 4,
  'unity-raw-1-7': 4,
  'laserworld-ds-3000rgb': 4,
  'kvant-clubmax': 4,
  'laserworld-pl-10000rgb': 2,
  'kvant-spectrum': 0,
};

const TOURING_STOCK: Readonly<Record<string, number>> = {
  'claypaky-sharpy': 48,
  'robe-megapointe': 36,
  'robe-ledbeam-150': 48,
  'martin-mac-ultra-performance': 24,
  'robe-bmfl-spot': 32,
  'robe-t1-profile': 24,
  'ayrton-perseo-profile': 24,
  'robe-bmfl-followspot': 4,
  'martin-mac-aura-xb': 40,
  'martin-mac-aura-xip': 36,
  'robe-spiider': 28,
  'chauvet-rogue-r1-beamwash': 48,
  'chauvet-colorado-1-quad-zoom': 64,
  'etc-colorsource-par': 64,
  'chauvet-colorado-pxl-bar-16': 32,
  'glp-impression-x4-bar-20': 24,
  'glp-jdc1': 28,
  'martin-atomic-3000-led': 32,
  'mole-richardson-molefay-4lite': 24,
  'chauvet-strike-4': 24,
  'roe-bp2-v2': 320,
  'roe-cb5': 300,
  'mdg-atme': 8,
  'mdg-theone': 4,
  'look-solutions-unique-21': 8,
  'martin-jem-zr45': 8,
  'look-solutions-viper-nt': 8,
  'magicfx-co2jet-ii': 16,
  'laserworld-cs-500g': 6,
  'unity-raw-1-7': 8,
  'laserworld-ds-3000rgb': 8,
  'kvant-clubmax': 8,
  'laserworld-pl-10000rgb': 6,
  'kvant-spectrum': 4,
};

type StockTier = 'club' | 'regional' | 'touring';

const TIER_CATEGORY_DEFAULTS: Readonly<Record<StockTier, Readonly<Record<CatalogCategory, number>>>> = {
  club: {
    beam: 8,
    spot: 4,
    profile: 4,
    wash: 8,
    led_par: 16,
    led_batten: 6,
    strobe: 6,
    blinder: 4,
    followspot: 1,
    led_panel: 48,
    hazer: 2,
    fogger: 2,
    co2_jet: 4,
    laser: 2,
  },
  regional: {
    beam: 24,
    spot: 12,
    profile: 12,
    wash: 20,
    led_par: 32,
    led_batten: 16,
    strobe: 16,
    blinder: 12,
    followspot: 2,
    led_panel: 140,
    hazer: 4,
    fogger: 4,
    co2_jet: 8,
    laser: 4,
  },
  touring: {
    beam: 48,
    spot: 32,
    profile: 24,
    wash: 40,
    led_par: 64,
    led_batten: 32,
    strobe: 32,
    blinder: 24,
    followspot: 4,
    led_panel: 320,
    hazer: 8,
    fogger: 8,
    co2_jet: 16,
    laser: 8,
  },
};

function defaultStockForEntry(entry: CatalogEntry, tier: StockTier): number {
  if (entry.category === 'laser') {
    const powerW = entry.laser?.opticalPowerW ?? 0;
    if (tier === 'club') return powerW <= 3 ? 2 : 0;
    if (tier === 'regional') return powerW <= 15 ? 4 : 0;
    return powerW >= 25 ? 4 : 8;
  }
  return TIER_CATEGORY_DEFAULTS[tier][entry.category];
}

function mergeStockWithDefaults(
  overrides: Readonly<Record<string, number>>,
  tier: StockTier,
): Readonly<Record<string, number>> {
  const merged: Record<string, number> = {};
  for (const entry of EQUIPMENT_CATALOG) {
    merged[entry.id] = Object.hasOwn(overrides, entry.id)
      ? overrides[entry.id]
      : defaultStockForEntry(entry, tier);
  }
  return Object.freeze(merged);
}

const RESOLVED_CLUB_STOCK = mergeStockWithDefaults(CLUB_STOCK, 'club');
const RESOLVED_REGIONAL_STOCK = mergeStockWithDefaults(REGIONAL_STOCK, 'regional');
const RESOLVED_TOURING_STOCK = mergeStockWithDefaults(TOURING_STOCK, 'touring');

export const SHOP_PRESETS: readonly ShopPresetMeta[] = [
  {
    id: 'unlimited',
    name: 'Unlimited (free design)',
    shortName: 'Unlimited',
    description: 'No quantity limits — design freely without rental-shop caps.',
    illustrative: false,
    stock: null,
  },
  {
    id: 'club',
    name: 'Local Club Shop (illustrative)',
    shortName: 'Local Club Shop',
    description: 'Small-venue inventory: 4–12 fixtures per model, compact lasers only.',
    illustrative: true,
    stock: RESOLVED_CLUB_STOCK,
  },
  {
    id: 'regional',
    name: 'Regional Production House (illustrative)',
    shortName: 'Regional House',
    description: 'Mid-size theatre & festival inventory: 12–24 fixtures per model.',
    illustrative: true,
    stock: RESOLVED_REGIONAL_STOCK,
  },
  {
    id: 'touring',
    name: 'Arena Touring Vendor (illustrative)',
    shortName: 'Arena Vendor',
    description: 'Large touring inventory: 24–48 moving lights, 300+ LED tiles, Class 4 lasers.',
    illustrative: true,
    stock: RESOLVED_TOURING_STOCK,
  },
];

export const DEFAULT_SHOP_STATE: ShopStockState = {
  profileId: 'unlimited',
  allowOverStock: false,
  customStock: { ...RESOLVED_REGIONAL_STOCK },
};

export function getShopPreset(id: ShopProfileId): ShopPresetMeta | undefined {
  return SHOP_PRESETS.find((p) => p.id === id);
}

export function shopProfileLabel(state: ShopStockState): string {
  if (state.profileId === 'custom') return 'Custom Shop (editable)';
  return getShopPreset(state.profileId)?.name ?? 'Unlimited (free design)';
}

export function createCustomStockFrom(presetId: Exclude<ShopProfileId, 'unlimited' | 'custom'> = 'regional'): Record<string, number> {
  const source = getShopPreset(presetId)?.stock ?? RESOLVED_REGIONAL_STOCK;
  const out: Record<string, number> = Object.create(null);
  for (const entry of EQUIPMENT_CATALOG) {
    out[entry.id] = source[entry.id] ?? 0;
  }
  return out;
}

function clampStockInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_STOCK_QTY) return null;
  return value;
}

/**
 * Parse a persisted shop state JSON string defensively (treats localStorage as untrusted).
 * Drops prototype-polluting keys and unknown catalogue IDs; falls back to Unlimited on any error.
 */
export function parseShopStockState(raw: string | null | undefined): ShopStockState {
  const fallback: ShopStockState = {
    profileId: 'unlimited',
    allowOverStock: false,
    customStock: createCustomStockFrom('regional'),
  };
  if (!raw || typeof raw !== 'string' || raw.length > 65536) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const obj = parsed as Record<string, unknown>;
    const rawProfile = obj.profileId;
    const profileId: ShopProfileId =
      rawProfile === 'unlimited' ||
      rawProfile === 'club' ||
      rawProfile === 'regional' ||
      rawProfile === 'touring' ||
      rawProfile === 'custom'
        ? rawProfile
        : 'unlimited';
    const allowOverStock = obj.allowOverStock === true;
    const customStock = createCustomStockFrom('regional');
    if (obj.customStock && typeof obj.customStock === 'object' && !Array.isArray(obj.customStock)) {
      const rawMap = obj.customStock as Record<string, unknown>;
      for (const key of Object.keys(rawMap)) {
        if (!KNOWN_CATALOG_IDS.has(key)) continue;
        const qty = clampStockInt(rawMap[key]);
        if (qty !== null) customStock[key] = qty;
      }
    }
    return { profileId, allowOverStock, customStock };
  } catch {
    return fallback;
  }
}

export function loadShopStockState(): ShopStockState {
  try {
    return parseShopStockState(window.localStorage.getItem(SHOP_STORAGE_KEY));
  } catch {
    return parseShopStockState(null);
  }
}

export function saveShopStockState(state: ShopStockState): void {
  try {
    const cleanCustom: Record<string, number> = {};
    for (const entry of EQUIPMENT_CATALOG) {
      const qty = clampStockInt(state.customStock[entry.id]);
      if (qty !== null) cleanCustom[entry.id] = qty;
    }
    window.localStorage.setItem(
      SHOP_STORAGE_KEY,
      JSON.stringify({
        profileId: state.profileId,
        allowOverStock: Boolean(state.allowOverStock),
        customStock: cleanCustom,
      }),
    );
  } catch {
    // Storage quota or private browsing — silently keep in-memory state.
  }
}

/** Resolve the active stock map (catalogId -> qty), or null when Unlimited. */
export function resolveShopStock(state: ShopStockState): Map<string, number> | null {
  if (state.profileId === 'unlimited') return null;
  const map = new Map<string, number>();
  const source =
    state.profileId === 'custom'
      ? state.customStock
      : getShopPreset(state.profileId)?.stock ?? RESOLVED_REGIONAL_STOCK;
  for (const entry of EQUIPMENT_CATALOG) {
    const qty = clampStockInt(source[entry.id]);
    map.set(entry.id, qty ?? 0);
  }
  return map;
}

export function getModelStock(state: ShopStockState, stockKey: string): number | null {
  const map = resolveShopStock(state);
  if (!map) return null;
  return map.has(stockKey) ? map.get(stockKey)! : null;
}

/** Stock pool key for a fixture or floor FX group (generic groups draw from LEGACY_DEFAULTS[type]). */
export function stockKeyForGroup(group: Pick<MountedFixtureGroup | FloorFxUnit, 'type' | 'catalogId'>): string {
  return group.catalogId ?? LEGACY_DEFAULTS[group.type as HardwareType];
}

export function stockDisplayName(stockKey: string): string {
  const entry = getCatalogEntry(stockKey);
  return entry ? catalogDisplayName(entry) : stockKey;
}

/** Total fixture/FX demand per stockKey across all truss pods and stage floor FX. */
export function computeFixtureDemand(rig: RigConfig): Map<string, number> {
  const demand = new Map<string, number>();
  const add = (key: string, count: number) => {
    demand.set(key, (demand.get(key) ?? 0) + count);
  };
  for (const pod of rig.trussPods) {
    for (const fg of pod.fixtures) {
      add(stockKeyForGroup(fg), fg.count);
    }
  }
  for (const fx of rig.floorFx) {
    add(stockKeyForGroup(fx), fx.count);
  }
  return demand;
}

/** Total installed LED cabinet demand when a real catalogue LED panel model is selected. */
export function computeLedCabinetDemand(
  sourceRig: RigConfig,
  stage?: NativeStage,
): { catalogId: string; model: string; cabinets: number } | null {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const cabinetId = rig.ledWall.cabinets?.cabinetId;
  if (!cabinetId) return null;
  const entry = getCatalogEntry(cabinetId);
  if (!entry || entry.category !== 'led_panel') return null;

  const frames = authoredWallFrames(rig, stage);
  const customMain = frames.find((f) => f.id === 'main-led');
  if (customMain) {
    const surface = authoredWallSurface(rig, customMain);
    if (!surface.cabinets) return null;
    return {
      catalogId: entry.id,
      model: catalogDisplayName(entry),
      cabinets: surface.columns * surface.rows,
    };
  }
  if (!rig.ledWall.enabled) return null;
  const wall = ledPlacement(rig);
  if (wall.height <= 0) return null;
  const cabinets = wall.columns * wall.rows + 2 * wall.wing.columns * wall.wing.rows;
  return {
    catalogId: entry.id,
    model: catalogDisplayName(entry),
    cabinets,
  };
}

/**
 * Delta-based hard-enforcement gate for fixture/floor FX edits.
 * A model violates only if need(nextRig) > need(prevRig) AND need(nextRig) > inStock.
 * Never blocks Unlimited, allowOverStock mode, decreases, or switches into models with available stock.
 */
export function stockViolations(
  prevRig: RigConfig,
  nextRig: RigConfig,
  state: ShopStockState,
): StockViolation[] {
  if (state.profileId === 'unlimited' || state.allowOverStock) return [];
  const stock = resolveShopStock(state);
  if (!stock) return [];

  const prevDemand = computeFixtureDemand(prevRig);
  const nextDemand = computeFixtureDemand(nextRig);
  const violations: StockViolation[] = [];

  for (const [key, nextNeed] of nextDemand.entries()) {
    const prevNeed = prevDemand.get(key) ?? 0;
    if (nextNeed <= prevNeed) continue;
    const inStock = stock.get(key);
    if (inStock === undefined) continue; // Unknown forward-compatible catalogId is not stock-capped.
    if (nextNeed > inStock) {
      violations.push({
        stockKey: key,
        model: stockDisplayName(key),
        inStock,
        prevNeed,
        nextNeed,
      });
    }
  }
  return violations;
}

export function formatStockBlockMessage(violations: readonly StockViolation[]): string {
  if (!violations.length) return '';
  const v = violations[0];
  if (v.inStock === 0) {
    return `Shop has 0 ${v.model} in stock. Choose another model, switch to Unlimited, or allow a sub-rental.`;
  }
  const available = Math.max(0, v.inStock - v.prevNeed);
  if (available === 0) {
    return `Shop has ${v.inStock} ${v.model} and all ${v.inStock} are in the rig. Remove one, choose another model, or allow a sub-rental.`;
  }
  return `Shop has ${v.inStock} ${v.model} (${available} free, need ${v.nextNeed - v.prevNeed} more). Reduce count, choose another model, or allow a sub-rental.`;
}

export interface PickerStockAvailability {
  /** Shop total stock for target model, or null when Unlimited / untracked. */
  inStock: number | null;
  /** Remaining free units available for this group (accounts for current group's own allocation if same model). */
  free: number | null;
  /** Group's unit count required. */
  needed: number;
  /** True when selecting this model is permitted (either fits in stock, Unlimited, or allowOverStock). */
  allowed: boolean;
  /** True when the switch exceeds shop stock even if allowOverStock permits it as a sub-rental. */
  overStock: boolean;
  /** Extra units that would require sub-rental if selected. */
  subRent: number;
}

export function pickerStockAvailability(
  rig: RigConfig,
  group: Pick<MountedFixtureGroup | FloorFxUnit, 'type' | 'catalogId' | 'count'>,
  targetStockKey: string,
  state: ShopStockState,
): PickerStockAvailability {
  const inStock = getModelStock(state, targetStockKey);
  if (inStock === null) {
    return { inStock: null, free: null, needed: group.count, allowed: true, overStock: false, subRent: 0 };
  }
  const demand = computeFixtureDemand(rig);
  const currentDemand = demand.get(targetStockKey) ?? 0;
  const currentKey = stockKeyForGroup(group);
  const alreadyHeldByGroup = currentKey === targetStockKey ? group.count : 0;
  const free = inStock - currentDemand + alreadyHeldByGroup;
  const newDemand = currentDemand - alreadyHeldByGroup + group.count;
  const overStock = newDemand > inStock;
  const subRent = Math.max(0, newDemand - inStock);
  // Staying on the same model (delta === 0) is always allowed even if already over-stock.
  const allowed = !overStock || currentKey === targetStockKey || state.allowOverStock;
  return { inStock, free, needed: group.count, allowed, overStock, subRent };
}
