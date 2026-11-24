import type { FixtureType, FloorFxType, FloorFxUnit, MountedFixtureGroup, RigConfig } from '../types/show';
import {
  catalogDisplayName,
  getCatalogEntry,
  isFieldUnverified,
  LEGACY_DEFAULTS,
  type CatalogBodyFamily,
  type CatalogCategory,
  type HardwareType,
} from './equipmentCatalog';
import { bodyFamilyFor } from './equipmentSymbols';
import { buildDmxPatch } from './dmxPatch';
import { formatCsv, type CsvValue } from './csv';
import {
  calculateProductionEstimate,
  HARDWARE_ALLOWANCE,
  KG_TO_LBS,
  type CostItemKind,
} from './productionEstimator';
import type { NativeStage } from './showFile';
import {
  computeFixtureDemand,
  computeLedCabinetDemand,
  DEFAULT_SHOP_STATE,
  resolveShopStock,
  stockDisplayName,
  stockKeyForGroup,
  type ShopStockState,
} from './shopStock';
import { resolveStudioGeometry } from './studioGeometry';

export type SpecSource = 'datasheet' | 'unverified' | 'allowance';

export type InventoryCategory =
  | 'Moving lights'
  | 'Wash/PAR'
  | 'Strobe/blinder'
  | 'Lasers'
  | 'Atmospherics'
  | 'SFX';

export interface InventoryModelRow {
  key: string;
  /** Stock pool key: catalogId, or LEGACY_DEFAULTS[type] for generic groups. */
  stockKey: string;
  /** True when this row comes from legacy fixture/FX groups without catalogId. */
  generic: boolean;
  /** Present when this row represents an explicit catalogue model. */
  catalogId?: string;
  body: CatalogBodyFamily;
  category: InventoryCategory;
  manufacturer?: string;
  model: string;
  /** Optional display subtitle (e.g. "filled from Clay Paky Sharpy stock"). */
  stockPoolNote?: string;
  dmxMode?: string;
  footprint: number;
  qty: number;
  unitWeightKg: number;
  unitPowerW: number;
  weightSource: SpecSource;
  powerSource: SpecSource;
  totalWeightKg: number;
  totalWeightLb: number;
  totalPowerW: number;
  universes: number[];
  addresses: string;
  unpatchedUnits: number;
}

export interface InventoryOtherRow {
  kind: Exclude<CostItemKind, 'fixture'>;
  category: string;
  label: string;
  qtyLabel: string;
  totalWeightKg: number;
  totalWeightLb: number;
  totalPowerW: number;
  specSource: SpecSource;
  body?: CatalogBodyFamily;
  catalogId?: string;
}

export interface UniverseUsage {
  universe: number;
  usedSlots: number;
  freeSlots: number;
  conflictSlots: number;
  overflowChannels: number;
  utilization: number;
}

export interface StockLine {
  stockKey: string;
  model: string;
  need: number;
  inStock: number | null;
  subRent: number;
  /** True for LED cabinets (soft warning only in editor, never blocks sliders). */
  softOnly?: boolean;
}

export interface EquipmentInventory {
  models: InventoryModelRow[];
  other: InventoryOtherRow[];
  universes: UniverseUsage[];
  stock: StockLine[];
  shortages: StockLine[];
  totals: {
    units: number;
    modelRows: number;
    weightKg: number;
    weightLb: number;
    powerW: number;
    verifiedWeightShare: number;
    channelsUsed: number;
    channelsCapacity: number;
    unpatchedUnits: number;
  };
}

type Group = MountedFixtureGroup | FloorFxUnit;
type HardwareKind = FixtureType | FloorFxType;

function inventoryCategoryFor(catalogCategory: CatalogCategory | undefined, hardwareType: HardwareKind): InventoryCategory {
  if (catalogCategory) {
    switch (catalogCategory) {
      case 'beam':
      case 'spot':
      case 'profile':
      case 'followspot':
        return 'Moving lights';
      case 'wash':
      case 'led_par':
      case 'led_batten':
        return 'Wash/PAR';
      case 'strobe':
      case 'blinder':
        return 'Strobe/blinder';
      case 'laser':
        return 'Lasers';
      case 'hazer':
      case 'fogger':
        return 'Atmospherics';
      case 'co2_jet':
        return 'SFX';
      default:
        break;
    }
  }
  switch (hardwareType) {
    case 'beam':
    case 'floor_beam':
      return 'Moving lights';
    case 'wash':
      return 'Wash/PAR';
    case 'strobe':
    case 'blinder':
      return 'Strobe/blinder';
    case 'laser':
    case 'floor_laser':
      return 'Lasers';
    case 'hazer':
    case 'smoke':
      return 'Atmospherics';
    case 'co2':
      return 'SFX';
  }
}

const GENERIC_TYPE_LABELS: Record<HardwareKind, string> = {
  beam: 'Generic beam',
  floor_beam: 'Generic floor beam',
  wash: 'Generic wash',
  strobe: 'Generic strobe',
  blinder: 'Generic blinder',
  laser: 'Generic overhead laser',
  floor_laser: 'Generic floor laser',
  hazer: 'Generic hazer',
  smoke: 'Generic fogger',
  co2: 'Generic CO2 jet',
};

const CATEGORY_ORDER: readonly InventoryCategory[] = [
  'Moving lights',
  'Wash/PAR',
  'Strobe/blinder',
  'Lasers',
  'Atmospherics',
  'SFX',
];

function formatAddressSpan(universe: number, start: number, end: number): string {
  const s = String(start).padStart(3, '0');
  const e = String(end).padStart(3, '0');
  return start === end ? `U${universe}.${s}` : `U${universe}.${s}–U${universe}.${e}`;
}

export function computeInventory(
  sourceRig: RigConfig,
  stage?: NativeStage,
  shopState: ShopStockState = DEFAULT_SHOP_STATE,
): EquipmentInventory {
  const { rig } = resolveStudioGeometry(sourceRig, stage?.layout);
  const estimate = calculateProductionEstimate(sourceRig, stage);
  const patch = buildDmxPatch(rig);

  // 1. Aggregate fixture & floor FX groups by model + DMX mode (+ generic type for allowance accuracy).
  interface Bucket {
    key: string;
    stockKey: string;
    generic: boolean;
    catalogId?: string;
    type: HardwareKind;
    body: CatalogBodyFamily;
    category: InventoryCategory;
    manufacturer?: string;
    model: string;
    stockPoolNote?: string;
    dmxMode?: string;
    footprint: number;
    qty: number;
    unitWeightKg: number;
    unitWeightLb: number;
    unitPowerW: number;
    weightSource: SpecSource;
    powerSource: SpecSource;
    universes: Set<number>;
    addressRanges: Array<{ universe: number; start: number; end: number }>;
    unpatchedUnits: number;
  }

  const buckets = new Map<string, Bucket>();

  for (const row of patch.rows) {
    const group: Group = row.group;
    const generic = !group.catalogId;
    const stockKey = stockKeyForGroup(group);
    const entry = group.catalogId ? getCatalogEntry(group.catalogId) : undefined;
    const allowance = HARDWARE_ALLOWANCE[group.type];

    // Weight & power match productionEstimator.ts rules exactly:
    // verified datasheet value when present & verified; otherwise HARDWARE_ALLOWANCE fallback.
    const hasVerifiedWeight = Boolean(
      !generic && entry && entry.weightKg !== undefined && !isFieldUnverified(entry, 'weightKg'),
    );
    const hasVerifiedPower = Boolean(
      !generic && entry && entry.powerW !== undefined && !isFieldUnverified(entry, 'powerW'),
    );
    const weightSource: SpecSource = hasVerifiedWeight
      ? 'datasheet'
      : !generic && entry?.weightKg !== undefined
        ? 'unverified'
        : 'allowance';
    const powerSource: SpecSource = hasVerifiedPower
      ? 'datasheet'
      : !generic && entry?.powerW !== undefined
        ? 'unverified'
        : 'allowance';

    const unitWeightKg = hasVerifiedWeight ? entry!.weightKg! : allowance.weightLbs / KG_TO_LBS;
    const unitWeightLb = hasVerifiedWeight ? entry!.weightKg! * KG_TO_LBS : allowance.weightLbs;
    const unitPowerW = hasVerifiedPower ? entry!.powerW! : allowance.watts;

    const modeKey = group.dmxMode ?? '';
    const bucketKey = generic
      ? `generic:${group.type}::${row.width}`
      : `${group.catalogId}::${modeKey}::${row.width}::${hasVerifiedWeight ? 'w' : allowance.weightLbs}::${hasVerifiedPower ? 'p' : allowance.watts}`;

    let unpatched = 0;
    for (let u = 0; u < group.count; u++) {
      if (patch.unitStart(group, u) === 0) unpatched++;
    }

    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.qty += group.count;
      existing.universes.add(group.dmxUniverse);
      existing.addressRanges.push({ universe: group.dmxUniverse, start: row.start, end: row.end });
      existing.unpatchedUnits += unpatched;
    } else {
      const defaultEntry = getCatalogEntry(LEGACY_DEFAULTS[group.type as HardwareType]);
      const model = generic
        ? GENERIC_TYPE_LABELS[group.type]
        : entry
          ? entry.model
          : group.modelName;
      const manufacturer = generic ? undefined : entry?.manufacturer;
      const stockPoolNote = generic && defaultEntry
        ? `filled from ${catalogDisplayName(defaultEntry)} stock`
        : undefined;
      buckets.set(bucketKey, {
        key: bucketKey,
        stockKey,
        generic,
        catalogId: group.catalogId,
        type: group.type,
        body: entry?.body ?? bodyFamilyFor(group.type),
        category: inventoryCategoryFor(entry?.category, group.type),
        manufacturer,
        model,
        stockPoolNote,
        dmxMode: group.dmxMode,
        footprint: row.width,
        qty: group.count,
        unitWeightKg,
        unitWeightLb,
        unitPowerW,
        weightSource,
        powerSource,
        universes: new Set([group.dmxUniverse]),
        addressRanges: [{ universe: group.dmxUniverse, start: row.start, end: row.end }],
        unpatchedUnits: unpatched,
      });
    }
  }

  const models: InventoryModelRow[] = [...buckets.values()]
    .map((b) => {
      const sortedRanges = [...b.addressRanges].sort((a, c) => a.universe - c.universe || a.start - c.start);
      const addresses = sortedRanges.map((r) => formatAddressSpan(r.universe, r.start, r.end)).join('; ');
      const totalWeightLb = Math.round(b.qty * b.unitWeightLb);
      const totalWeightKg = b.weightSource === 'datasheet'
        ? Number((b.qty * b.unitWeightKg).toFixed(2))
        : Number((totalWeightLb / KG_TO_LBS).toFixed(2));
      const totalPowerW = Math.round(b.qty * b.unitPowerW);
      return {
        key: b.key,
        stockKey: b.stockKey,
        generic: b.generic,
        catalogId: b.catalogId,
        body: b.body,
        category: b.category,
        manufacturer: b.manufacturer,
        model: b.model,
        stockPoolNote: b.stockPoolNote,
        dmxMode: b.dmxMode,
        footprint: b.footprint,
        qty: b.qty,
        unitWeightKg: Number(b.unitWeightKg.toFixed(2)),
        unitPowerW: Math.round(b.unitPowerW),
        weightSource: b.weightSource,
        powerSource: b.powerSource,
        totalWeightKg,
        totalWeightLb,
        totalPowerW,
        universes: [...b.universes].sort((a, c) => a - c),
        addresses,
        unpatchedUnits: b.unpatchedUnits,
      };
    })
    .sort((a, b) => {
      const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      if (catDiff !== 0) return catDiff;
      const nameA = `${a.manufacturer ?? ''} ${a.model}`.trim();
      const nameB = `${b.manufacturer ?? ''} ${b.model}`.trim();
      return nameA.localeCompare(nameB) || (a.dmxMode ?? '').localeCompare(b.dmxMode ?? '');
    });

  // 2. Non-fixture production gear reused directly from productionEstimator so both tabs never disagree.
  const panelEntry = getCatalogEntry(rig.ledWall.cabinets?.cabinetId);
  const panelVerified = Boolean(
    panelEntry &&
      panelEntry.category === 'led_panel' &&
      panelEntry.weightKg !== undefined &&
      panelEntry.powerW !== undefined &&
      !isFieldUnverified(panelEntry, 'weightKg') &&
      !isFieldUnverified(panelEntry, 'powerW'),
  );

  const other: InventoryOtherRow[] = estimate.equipmentItems
    .filter((item) => item.kind !== 'fixture')
    .map((item) => {
      const kind = (item.kind ?? 'deck') as Exclude<CostItemKind, 'fixture'>;
      const isVerifiedPanel = kind === 'led' && Boolean(item.catalogId) && Boolean(rig.ledWall.cabinets) && panelVerified;
      return {
        kind,
        category: item.category,
        label: item.label,
        qtyLabel: item.qty,
        totalWeightKg: Number((item.weightLbs / KG_TO_LBS).toFixed(2)),
        totalWeightLb: item.weightLbs,
        totalPowerW: item.watts,
        specSource: isVerifiedPanel ? 'datasheet' : 'allowance',
        body: item.body,
        catalogId: item.catalogId,
      };
    });

  // 3. Per-universe DMX channel usage (uses number universe IDs so R6 can widen past U2 cleanly).
  const universeIds = [1, 2] as const;
  const universes: UniverseUsage[] = universeIds.map((u) => {
    const slots = patch.claimed[u];
    let usedSlots = 0;
    let conflictSlots = 0;
    for (let ch = 1; ch <= 512; ch++) {
      if (slots[ch] >= 1) usedSlots++;
      if (slots[ch] > 1) conflictSlots++;
    }
    let overflowChannels = 0;
    for (const row of patch.rows) {
      if (row.group.dmxUniverse === u && row.end > 512) {
        overflowChannels += row.end - Math.max(512, row.start - 1);
      }
    }
    return {
      universe: u,
      usedSlots,
      freeSlots: 512 - usedSlots,
      conflictSlots,
      overflowChannels,
      utilization: usedSlots / 512,
    };
  });

  // 4. Stock comparison (aggregated by stockKey across fixture models + optional LED panel cabinets).
  const shopMap = resolveShopStock(shopState);
  const fixtureDemand = computeFixtureDemand(rig);
  const stock: StockLine[] = [];

  for (const [stockKey, need] of fixtureDemand.entries()) {
    const inStock = shopMap ? (shopMap.has(stockKey) ? shopMap.get(stockKey)! : null) : null;
    const subRent = inStock !== null ? Math.max(0, need - inStock) : 0;
    stock.push({
      stockKey,
      model: stockDisplayName(stockKey),
      need,
      inStock,
      subRent,
    });
  }

  const ledDemand = computeLedCabinetDemand(sourceRig, stage);
  if (ledDemand && ledDemand.cabinets > 0) {
    const inStock = shopMap ? (shopMap.has(ledDemand.catalogId) ? shopMap.get(ledDemand.catalogId)! : null) : null;
    const subRent = inStock !== null ? Math.max(0, ledDemand.cabinets - inStock) : 0;
    stock.push({
      stockKey: ledDemand.catalogId,
      model: `${ledDemand.model} (LED cabinets)`,
      need: ledDemand.cabinets,
      inStock,
      subRent,
      softOnly: true,
    });
  }

  stock.sort((a, b) => b.subRent - a.subRent || a.model.localeCompare(b.model));
  const shortages = stock.filter((s) => s.subRent > 0);

  // 5. Totals (derived from exact unrounded sums + estimate so Inventory and Cost & crew never drift,
  // even when one catalogue model is split across multiple DMX modes with fractional unit weight/power).
  const units = models.reduce((sum, r) => sum + r.qty, 0);
  const weightLb = Math.round(estimate.totalWeightLbs);
  const weightKg = Number((estimate.totalWeightLbs / KG_TO_LBS).toFixed(2));
  const powerW = Math.round(estimate.totalWatts);

  const verifiedWeightKg =
    models.filter((r) => r.weightSource === 'datasheet').reduce((sum, r) => sum + r.totalWeightKg, 0) +
    other.filter((r) => r.specSource === 'datasheet').reduce((sum, r) => sum + r.totalWeightKg, 0);
  const verifiedWeightShare = weightKg > 0 ? Math.min(1, verifiedWeightKg / weightKg) : 0;

  const channelsUsed = universes.reduce((sum, u) => sum + u.usedSlots, 0);
  const channelsCapacity = universes.length * 512;
  const unpatchedUnits = models.reduce((sum, r) => sum + r.unpatchedUnits, 0);

  return {
    models,
    other,
    universes,
    stock,
    shortages,
    totals: {
      units,
      modelRows: models.length,
      weightKg,
      weightLb,
      powerW,
      verifiedWeightShare,
      channelsUsed,
      channelsCapacity,
      unpatchedUnits,
    },
  };
}

function specStatusLabel(weightSource: SpecSource, powerSource: SpecSource): string {
  if (weightSource === 'datasheet' && powerSource === 'datasheet') return 'datasheet';
  if (weightSource === 'unverified' || powerSource === 'unverified') return 'unverified';
  if (weightSource === 'datasheet' || powerSource === 'datasheet') return 'partial datasheet';
  return 'estimate';
}

export const EQUIPMENT_CSV_HEADERS = [
  'Category',
  'Manufacturer',
  'Model',
  'Catalogue ID',
  'DMX mode',
  'Footprint (ch)',
  'Qty',
  'In stock',
  'Sub-rent',
  'Unit weight (kg)',
  'Total weight (kg)',
  'Total weight (lb)',
  'Unit power (W)',
  'Total power (W)',
  'Addresses',
  'Unpatched units',
  'Spec status',
  'Notes',
] as const;

/**
 * Generate an Excel-friendly (UTF-8 BOM, CRLF) RFC 4180 CSV equipment & rental list
 * with formula-injection neutralization and a trailing Total row.
 */
export function equipmentInventoryCsv(
  rig: RigConfig,
  stage?: NativeStage,
  shopState: ShopStockState = DEFAULT_SHOP_STATE,
): string {
  const inv = computeInventory(rig, stage, shopState);
  const stockByKey = new Map(inv.stock.map((s) => [s.stockKey, s]));
  // Emit pool-level In stock / Sub-rent once per stockKey so summing Sub-rent matches the Total row.
  const emittedStockKeys = new Set<string>();
  const rows: CsvValue[][] = [[...EQUIPMENT_CSV_HEADERS]];

  for (const row of inv.models) {
    const stockLine = stockByKey.get(row.stockKey);
    const firstInPool = !emittedStockKeys.has(row.stockKey);
    if (firstInPool) emittedStockKeys.add(row.stockKey);
    const notesParts: string[] = [];
    if (row.stockPoolNote) notesParts.push(row.stockPoolNote);
    if (!firstInPool && stockLine && stockLine.inStock !== null) {
      notesParts.push('shared stock pool (counted above)');
    }
    if (row.unpatchedUnits > 0) notesParts.push(`${row.unpatchedUnits} unpatched`);
    if (row.weightSource === 'unverified' || row.powerSource === 'unverified') {
      notesParts.push('unverified spec — using allowance');
    }
    rows.push([
      row.category,
      row.manufacturer ?? '',
      row.model,
      row.catalogId ?? '',
      row.dmxMode ?? '',
      row.footprint,
      row.qty,
      firstInPool ? (stockLine?.inStock ?? '') : '',
      firstInPool && stockLine && stockLine.inStock !== null ? stockLine.subRent : '',
      row.unitWeightKg,
      row.totalWeightKg,
      row.totalWeightLb,
      row.unitPowerW,
      row.totalPowerW,
      row.addresses,
      row.unpatchedUnits,
      specStatusLabel(row.weightSource, row.powerSource),
      notesParts.join('; '),
    ]);
  }

  for (const item of inv.other) {
    const stockLine = item.catalogId ? stockByKey.get(item.catalogId) : undefined;
    const firstInPool = item.catalogId ? !emittedStockKeys.has(item.catalogId) : true;
    if (item.catalogId && firstInPool) emittedStockKeys.add(item.catalogId);
    rows.push([
      item.category,
      '',
      item.label,
      item.catalogId ?? '',
      '',
      '',
      item.qtyLabel,
      firstInPool ? (stockLine?.inStock ?? '') : '',
      firstInPool && stockLine && stockLine.inStock !== null ? stockLine.subRent : '',
      '',
      item.totalWeightKg,
      Math.round(item.totalWeightLb),
      '',
      Math.round(item.totalPowerW),
      '',
      '',
      item.specSource === 'datasheet' ? 'datasheet' : 'estimate',
      item.kind === 'led' && stockLine?.subRent ? 'LED cabinet soft warning' : '',
    ]);
  }

  const totalSubRent = inv.shortages.reduce((sum, s) => sum + s.subRent, 0);
  rows.push([
    'Total',
    '',
    rig.name,
    '',
    '',
    '',
    inv.totals.units,
    '',
    shopState.profileId === 'unlimited' ? '' : totalSubRent,
    '',
    inv.totals.weightKg,
    Math.round(inv.totals.weightLb),
    '',
    Math.round(inv.totals.powerW),
    `${inv.totals.channelsUsed}/${inv.totals.channelsCapacity} ch`,
    inv.totals.unpatchedUnits,
    `${Math.round(inv.totals.verifiedWeightShare * 100)}% verified wt`,
    'Nameplate max power; illustrative allowances where noted',
  ]);

  return formatCsv(rows, { bom: true });
}
