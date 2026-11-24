import type { FixtureType, FloorFxType, RigConfig, StagePropKind } from '../types/show';
import { catalogDisplayName, getCatalogEntry, isFieldUnverified, type CatalogBodyFamily } from './equipmentCatalog';
import { bodyFamilyFor } from './equipmentSymbols';
import { hoistPoints } from './hoistPoints';
import { getHoistProfile, getTrussProfile, hoistDisplayName, trussDisplayName } from './rigCatalog';
import { PROP_CATALOG } from './stageProps';
import { pathLength } from './stageDesign';
import { GRID_HEIGHT, ledPlacement } from './stageEquipment';
import type { NativeStage } from './showFile';
import { authoredWallFrames, authoredWallSurface, resolveStudioGeometry } from './studioGeometry';

export const KG_TO_LBS = 2.20462;

export type CostItemKind = 'fixture' | 'truss' | 'motor' | 'led' | 'audio' | 'prop' | 'deck';

export interface CostLineItem {
  category: 'Rigging & Motors' | 'Lighting' | 'Lasers' | 'LED Video' | 'Audio / Speakers' | 'Smoke & FX' | 'Stage & FOH' | 'Scenery (simulation allowance)';
  kind?: CostItemKind;
  label: string;
  qty: string;
  /** Optional numeric unit count (e.g. hoist point count) so consumers don't regex-parse qty. */
  unitCount?: number;
  buyCost: number;
  rentalCost: number;
  weightLbs: number;
  watts: number;
  body?: CatalogBodyFamily;
  catalogId?: string;
}

export interface LaborLineItem {
  role: string;
  crewCount: number;
  hours: number;
  ratePerHr: number;
  total: number;
}

export interface ProductionEstimate {
  equipmentItems: CostLineItem[];
  laborItems: LaborLineItem[];
  totalBuyCost: number;
  totalRentalCost: number;
  totalLaborCost: number;
  trucksNeeded: number;
  truckingCost: number;
  oneNightShowTotal: number;
  totalWeightLbs: number;
  totalWatts: number;
  totalCrewHeadcount: number;
  loadInHours: number;
}

type HardwareKind = FixtureType | FloorFxType;

export const HARDWARE_ALLOWANCE: Record<
  HardwareKind,
  {
    category: CostLineItem['category'];
    unitLabel: string;
    buyCost: number;
    rentalCost: number;
    weightLbs: number;
    watts: number;
  }
> = {
  beam: { category: 'Lighting', unitLabel: 'units', buyCost: 7100, rentalCost: 195, weightLbs: 44, watts: 520 },
  floor_beam: { category: 'Lighting', unitLabel: 'units', buyCost: 7100, rentalCost: 195, weightLbs: 44, watts: 520 },
  wash: { category: 'Lighting', unitLabel: 'units', buyCost: 5400, rentalCost: 145, weightLbs: 28, watts: 400 },
  strobe: { category: 'Lighting', unitLabel: 'units', buyCost: 4900, rentalCost: 135, weightLbs: 26, watts: 1200 },
  blinder: { category: 'Lighting', unitLabel: 'units', buyCost: 1450, rentalCost: 48, weightLbs: 24, watts: 2600 },
  laser: { category: 'Lasers', unitLabel: 'units', buyCost: 14500, rentalCost: 560, weightLbs: 32, watts: 350 },
  floor_laser: { category: 'Lasers', unitLabel: 'units', buyCost: 28000, rentalCost: 950, weightLbs: 54, watts: 650 },
  hazer: { category: 'Smoke & FX', unitLabel: 'units', buyCost: 7200, rentalCost: 240, weightLbs: 79, watts: 1400 },
  smoke: { category: 'Smoke & FX', unitLabel: 'units', buyCost: 2100, rentalCost: 75, weightLbs: 48, watts: 2000 },
  co2: { category: 'Smoke & FX', unitLabel: 'jets', buyCost: 1450, rentalCost: 180, weightLbs: 95, watts: 80 },
};

// These per-piece allowances represent the touring package, including a blower
// for air-filled scenic pieces. A visual scale change leaves the package count intact.
const scenicAllowance = {
  tentacle: { buyCost: 3200, rentalCost: 180, weightLbs: 80, watts: 550 },
  star: { buyCost: 1800, rentalCost: 115, weightLbs: 34, watts: 0 },
  arch: { buyCost: 5400, rentalCost: 285, weightLbs: 145, watts: 900 },
  marquee: { buyCost: 2900, rentalCost: 145, weightLbs: 115, watts: 320 },
  riser: { buyCost: 1600, rentalCost: 90, weightLbs: 175, watts: 0 },
} satisfies Record<StagePropKind, Pick<CostLineItem, 'buyCost' | 'rentalCost' | 'weightLbs' | 'watts'>>;

export function calculateProductionEstimate(sourceRig: RigConfig, stage?: NativeStage): ProductionEstimate {
  const { rig, hangs, props: authoredProps } = resolveStudioGeometry(sourceRig, stage?.layout);
  const equipmentItems: CostLineItem[] = [];

  // 1. Stage deck & FOH control
  const stageArea = rig.platforms ? rig.platforms.reduce((area, p) => area + p.width * p.depth, 0) : rig.stageWidth * rig.stageDepth;
  if (stageArea > 0) equipmentItems.push({
    category: 'Stage & FOH',
    kind: 'deck',
    label: rig.platforms ? `Custom stage deck (${rig.platforms.length} modules)` :
      `${rig.venue.toUpperCase()} Stage Deck & Barricade (${rig.stageWidth}m × ${rig.stageDepth}m)`,
    qty: `${Math.round(stageArea)} m²`,
    buyCost: stageArea * 680,
    rentalCost: stageArea * 38,
    weightLbs: stageArea * 55,
    watts: 1500,
  });

  equipmentItems.push({
    category: 'Stage & FOH',
    kind: 'deck',
    label: 'FOH Control (DMX Console + Laser Server + Audio Desk)',
    qty: '1 pkg',
    buyCost: 94000,
    rentalCost: 2900,
    weightLbs: 680,
    watts: 2200,
  });

  // 2. Trusses & Kinetic Chain Hoist Motors
  let legacyTrussMeters = 0;
  let legacyMotors = 0;
  let totalMotors = 0;
  const profiledTrusses = new Map<string, { meters: number }>();
  const profiledHoists = new Map<string, { count: number; weightLbs: number; watts: number }>();
  const gridHeight = GRID_HEIGHT[rig.venue] ?? 14;
  // Totals across BOTH legacy and catalogue groups (drive crew, LSO and SFX counts).
  let totalBeamCount = 0;
  let totalWashCount = 0;
  let totalLaserCount = 0;
  let totalStrobeCount = 0;
  let totalBlinderCount = 0;
  let totalFloorLaserCount = 0;
  let totalFloorBeamCount = 0;
  let totalCo2Count = 0;
  let totalSmokeCount = 0;
  let totalHazerCount = 0;

  // Legacy-only counts (groups without catalogId keep exact legacy per-type rows).
  let legacyBeamCount = 0;
  let legacyWashCount = 0;
  let legacyLaserCount = 0;
  let legacyStrobeCount = 0;
  let legacyBlinderCount = 0;
  let legacyFloorLaserCount = 0;
  let legacyFloorBeamCount = 0;
  let legacyCo2Count = 0;
  let legacySmokeCount = 0;
  let legacyHazerCount = 0;

  interface CatalogBucket {
    catalogId: string;
    modelName: string;
    type: HardwareKind;
    count: number;
  }
  const catalogBuckets = new Map<string, CatalogBucket>();
  const addCatalogUnit = (catalogId: string, modelName: string, type: HardwareKind, count: number) => {
    const entry = getCatalogEntry(catalogId);
    const allowance = HARDWARE_ALLOWANCE[type];
    const key = entry
      ? `${catalogId}::${allowance.category}::${allowance.buyCost}::${allowance.rentalCost}`
      : `unknown:${catalogId}::${type}::${modelName}`;
    const existing = catalogBuckets.get(key);
    if (existing) existing.count += count;
    else catalogBuckets.set(key, { catalogId, modelName, type, count });
  };

  for (const pod of rig.trussPods) {
    const path = pod.shape === 'path' ? pod.path : undefined;
    const meters = path ? pathLength(path) : pod.shape === 'circle' ? Math.PI * pod.width : pod.width;
    const trussProfile = getTrussProfile(pod.trussProfileId);
    if (trussProfile) {
      const existing = profiledTrusses.get(trussProfile.id);
      if (existing) existing.meters += meters;
      else profiledTrusses.set(trussProfile.id, { meters });
    } else {
      legacyTrussMeters += meters;
    }

    const anchors = hoistPoints(pod).length;
    if (pod.motorized) {
      totalMotors += anchors;
      const hoistProfile = getHoistProfile(pod.hoistId);
      if (hoistProfile) {
        const dropM = Math.max(0.5, gridHeight - pod.baseY);
        const unitKg = hoistProfile.bodyKg + hoistProfile.chainKgPerM * dropM;
        const weightLbs = anchors * unitKg * KG_TO_LBS;
        const watts = anchors * hoistProfile.motorW;
        const existing = profiledHoists.get(hoistProfile.id);
        if (existing) {
          existing.count += anchors;
          existing.weightLbs += weightLbs;
          existing.watts += watts;
        } else {
          profiledHoists.set(hoistProfile.id, { count: anchors, weightLbs, watts });
        }
      } else {
        legacyMotors += anchors;
      }
    }

    for (const fg of pod.fixtures) {
      if (fg.type === 'beam') totalBeamCount += fg.count;
      else if (fg.type === 'wash') totalWashCount += fg.count;
      else if (fg.type === 'laser') totalLaserCount += fg.count;
      else if (fg.type === 'strobe') totalStrobeCount += fg.count;
      else if (fg.type === 'blinder') totalBlinderCount += fg.count;

      if (fg.catalogId) {
        addCatalogUnit(fg.catalogId, fg.modelName, fg.type, fg.count);
      } else {
        if (fg.type === 'beam') legacyBeamCount += fg.count;
        else if (fg.type === 'wash') legacyWashCount += fg.count;
        else if (fg.type === 'laser') legacyLaserCount += fg.count;
        else if (fg.type === 'strobe') legacyStrobeCount += fg.count;
        else if (fg.type === 'blinder') legacyBlinderCount += fg.count;
      }
    }
  }

  if (legacyTrussMeters > 0) {
    equipmentItems.push({
      category: 'Rigging & Motors',
      kind: 'truss',
      label: 'Aluminum truss sections',
      qty: `${Math.round(legacyTrussMeters)} m`,
      buyCost: Math.round(legacyTrussMeters * 460),
      rentalCost: Math.round(legacyTrussMeters * 26),
      weightLbs: Math.round(legacyTrussMeters * 30),
      watts: 0,
    });
  }
  for (const [profileId, bucket] of profiledTrusses.entries()) {
    const profile = getTrussProfile(profileId)!;
    equipmentItems.push({
      category: 'Rigging & Motors',
      kind: 'truss',
      label: trussDisplayName(profile),
      qty: `${Math.round(bucket.meters)} m`,
      buyCost: Math.round(bucket.meters * 460),
      rentalCost: Math.round(bucket.meters * 26),
      weightLbs: Math.round(bucket.meters * profile.kgPerMeter * KG_TO_LBS),
      watts: 0,
    });
  }

  if (legacyMotors > 0) {
    equipmentItems.push({
      category: 'Rigging & Motors',
      kind: 'motor',
      label: 'Kinesys / CM Lodestar 1-Ton Kinetic Chain Motors',
      qty: `${legacyMotors} hoists`,
      unitCount: legacyMotors,
      buyCost: legacyMotors * 7800,
      rentalCost: legacyMotors * 275,
      weightLbs: legacyMotors * 124,
      watts: legacyMotors * 1500,
    });
  }
  for (const [hoistId, bucket] of profiledHoists.entries()) {
    const hoist = getHoistProfile(hoistId)!;
    equipmentItems.push({
      category: 'Rigging & Motors',
      kind: 'motor',
      label: hoistDisplayName(hoist),
      qty: `${bucket.count} ${hoist.safetyClass === 'deadhang' ? 'points' : 'hoists'}`,
      unitCount: bucket.count,
      buyCost: hoist.safetyClass === 'deadhang' ? bucket.count * 250 : bucket.count * 7800,
      rentalCost: hoist.safetyClass === 'deadhang' ? bucket.count * 25 : bucket.count * 275,
      weightLbs: Math.round(bucket.weightLbs),
      watts: Math.round(bucket.watts),
    });
  }

  // 3. Overhead & Floor Lighting + Lasers + Smoke/CO2
  for (const fx of rig.floorFx) {
    if (fx.type === 'floor_laser') totalFloorLaserCount += fx.count;
    else if (fx.type === 'floor_beam') totalFloorBeamCount += fx.count;
    else if (fx.type === 'co2') totalCo2Count += fx.count;
    else if (fx.type === 'smoke') totalSmokeCount += fx.count;
    else if (fx.type === 'hazer') totalHazerCount += fx.count;

    if (fx.catalogId) {
      addCatalogUnit(fx.catalogId, fx.modelName, fx.type, fx.count);
    } else {
      if (fx.type === 'floor_laser') legacyFloorLaserCount += fx.count;
      else if (fx.type === 'floor_beam') legacyFloorBeamCount += fx.count;
      else if (fx.type === 'co2') legacyCo2Count += fx.count;
      else if (fx.type === 'smoke') legacySmokeCount += fx.count;
      else if (fx.type === 'hazer') legacyHazerCount += fx.count;
    }
  }

  // Legacy generic rows (unchanged for rigs without catalogId)
  const legacyAllBeams = legacyBeamCount + legacyFloorBeamCount;
  if (legacyAllBeams > 0) {
    equipmentItems.push({
      category: 'Lighting',
      kind: 'fixture',
      label: 'Sharpy X-Beam / MegaPointe Moving Heads',
      qty: `${legacyAllBeams} units`,
      buyCost: legacyAllBeams * 7100,
      rentalCost: legacyAllBeams * 195,
      weightLbs: legacyAllBeams * 44,
      watts: legacyAllBeams * 520,
      body: 'moving-beam',
    });
  }
  if (legacyWashCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      kind: 'fixture',
      label: 'MAC Aura Pro RGBW Moving Washes',
      qty: `${legacyWashCount} units`,
      buyCost: legacyWashCount * 5400,
      rentalCost: legacyWashCount * 145,
      weightLbs: legacyWashCount * 28,
      watts: legacyWashCount * 400,
      body: 'moving-wash',
    });
  }
  if (legacyStrobeCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      kind: 'fixture',
      label: 'Atomic Pro JDC-1 Arena Strobe Bars',
      qty: `${legacyStrobeCount} units`,
      buyCost: legacyStrobeCount * 4900,
      rentalCost: legacyStrobeCount * 135,
      weightLbs: legacyStrobeCount * 26,
      watts: legacyStrobeCount * 1200,
      body: 'strobe-panel',
    });
  }
  if (legacyBlinderCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      kind: 'fixture',
      label: 'Molefay 4-Lite Warm Audience Blinders',
      qty: `${legacyBlinderCount} units`,
      buyCost: legacyBlinderCount * 1450,
      rentalCost: legacyBlinderCount * 48,
      weightLbs: legacyBlinderCount * 24,
      watts: legacyBlinderCount * 2600,
      body: 'blinder-4lite',
    });
  }

  if (legacyLaserCount > 0) {
    equipmentItems.push({
      category: 'Lasers',
      kind: 'fixture',
      label: 'KVANT Clubmax 12W RGB Overhead Lasers',
      qty: `${legacyLaserCount} units`,
      buyCost: legacyLaserCount * 14500,
      rentalCost: legacyLaserCount * 560,
      weightLbs: legacyLaserCount * 32,
      watts: legacyLaserCount * 350,
      body: 'laser-head',
    });
  }
  if (legacyFloorLaserCount > 0) {
    equipmentItems.push({
      category: 'Lasers',
      kind: 'fixture',
      label: 'KVANT Spectrum 25W Stage Deck Lasers',
      qty: `${legacyFloorLaserCount} units`,
      buyCost: legacyFloorLaserCount * 28000,
      rentalCost: legacyFloorLaserCount * 950,
      weightLbs: legacyFloorLaserCount * 54,
      watts: legacyFloorLaserCount * 650,
      body: 'laser-head',
    });
  }

  // Catalogue model rows (grouped by model; uses verified catalogue weightKg and powerW when available)
  const fxCatalogRows: CostLineItem[] = [];
  for (const bucket of catalogBuckets.values()) {
    const allowance = HARDWARE_ALLOWANCE[bucket.type];
    const entry = getCatalogEntry(bucket.catalogId);
    const hasWeight = Boolean(entry && entry.weightKg !== undefined && !isFieldUnverified(entry, 'weightKg'));
    const hasPower = Boolean(entry && entry.powerW !== undefined && !isFieldUnverified(entry, 'powerW'));
    const estNotes: string[] = [];
    if (!hasWeight) estNotes.push('est. weight');
    if (!hasPower) estNotes.push('est. power');
    const baseLabel = entry ? catalogDisplayName(entry) : bucket.modelName;
    const label = estNotes.length ? `${baseLabel} (${estNotes.join(', ')})` : baseLabel;
    const row: CostLineItem = {
      category: allowance.category,
      kind: 'fixture',
      label,
      qty: `${bucket.count} ${allowance.unitLabel}`,
      buyCost: bucket.count * allowance.buyCost,
      rentalCost: bucket.count * allowance.rentalCost,
      weightLbs: Math.round(bucket.count * (hasWeight ? entry!.weightKg! * KG_TO_LBS : allowance.weightLbs)),
      watts: Math.round(bucket.count * (hasPower ? entry!.powerW! : allowance.watts)),
      body: entry?.body ?? bodyFamilyFor(bucket.type),
      catalogId: bucket.catalogId,
    };
    if (allowance.category === 'Smoke & FX') fxCatalogRows.push(row);
    else equipmentItems.push(row);
  }

  // 4. Giant LED Video Wall + IMAG Side Wings + Authored Secondary Walls
  // A custom main-led replaces the stock wall and its wings (StageEngine builds one panel).
  const panelEntry = getCatalogEntry(rig.ledWall.cabinets?.cabinetId);
  const usePanelSpecs = Boolean(
    panelEntry &&
      panelEntry.category === 'led_panel' &&
      panelEntry.weightKg !== undefined &&
      panelEntry.powerW !== undefined &&
      !isFieldUnverified(panelEntry, 'weightKg') &&
      !isFieldUnverified(panelEntry, 'powerW'),
  );
  const panelPrefix = panelEntry && panelEntry.category === 'led_panel' ? `${catalogDisplayName(panelEntry)} ` : '';

  const frames = authoredWallFrames(rig, stage);
  const customMain = frames.find(frame => frame.id === 'main-led');
  const wall = rig.ledWall.enabled && !customMain ? ledPlacement(rig) : undefined;
  const secondaryWalls = frames.filter(frame => frame.id !== 'main-led');
  const secondaryArea = secondaryWalls.reduce((sum, w) => sum + w.width * w.height, 0);
  if (customMain) {
    const surface = authoredWallSurface(rig, customMain);
    const area = customMain.width * customMain.height;
    const cabinetCount = surface.columns * surface.rows;
    equipmentItems.push({
      category: 'LED Video',
      kind: 'led',
      label: `${panelPrefix}LED wall (authored placement)`,
      qty: surface.cabinets ? `${cabinetCount} cabinets · ${Number(area.toFixed(2))} m²` : `${Number(area.toFixed(2))} m²`,
      buyCost: Math.round(area * 3800),
      rentalCost: Math.round(area * 185),
      weightLbs: surface.cabinets && usePanelSpecs ? Math.round(cabinetCount * panelEntry!.weightKg! * KG_TO_LBS) : Math.round(area * 62),
      watts: surface.cabinets && usePanelSpecs ? Math.round(cabinetCount * panelEntry!.powerW!) : Math.round(area * 580),
      body: 'led-panel',
      catalogId: panelEntry?.id,
    });
  } else if (wall && wall.height > 0) {
    const totalLedArea = wall.width * wall.height + 2 * wall.wing.width * wall.wing.height;
    const cabinetCount = wall.columns * wall.rows + 2 * wall.wing.columns * wall.wing.rows;
    equipmentItems.push({
      category: 'LED Video',
      kind: 'led',
      label: `${panelPrefix}LED wall${rig.ledWall.curved ? ' (curved)' : ''}${wall.wing.width > 0 ? ' + IMAG wings' : ''}`,
      qty: rig.ledWall.cabinets ? `${cabinetCount} cabinets · ${Number(totalLedArea.toFixed(2))} m²` : `${Number(totalLedArea.toFixed(2))} m²`,
      buyCost: Math.round(totalLedArea * 3800),
      rentalCost: Math.round(totalLedArea * 185),
      weightLbs: rig.ledWall.cabinets && usePanelSpecs ? Math.round(cabinetCount * panelEntry!.weightKg! * KG_TO_LBS) : Math.round(totalLedArea * 62),
      watts: rig.ledWall.cabinets && usePanelSpecs ? Math.round(cabinetCount * panelEntry!.powerW!) : Math.round(totalLedArea * 580),
      body: 'led-panel',
      catalogId: panelEntry?.id,
    });
  }
  if (secondaryArea > 0) {
    equipmentItems.push({
      category: 'LED Video',
      kind: 'led',
      label: `Secondary LED walls (${secondaryWalls.length})`,
      qty: `${Number(secondaryArea.toFixed(2))} m²`,
      buyCost: Math.round(secondaryArea * 3800),
      rentalCost: Math.round(secondaryArea * 185),
      weightLbs: Math.round(secondaryArea * 62),
      watts: Math.round(secondaryArea * 580),
      body: 'led-panel',
    });
  }

  // Each hang keeps its amplifier rack. The 9-box configuration retains the
  // original rental, purchase, weight and power assumptions for saved rigs.
  const k2 = rig.audioRig.speakerProfile === 'k2';
  if (hangs !== undefined) {
    const boxes = hangs.reduce((sum, h) => sum + Math.max(1, Math.min(16, Math.round(h.count))), 0);
    if (boxes > 0) {
      const racks = hangs.length;
      equipmentItems.push({
        category: 'Audio / Speakers',
        kind: 'audio',
        label: k2 ? `K2 flown speaker hangs (${racks} arrays)` : `Flown speaker hangs (${racks} arrays)`,
        qty: `${boxes} boxes + ${racks} ${racks === 1 ? 'rack' : 'racks'}`,
        buyCost: racks * 17000 + boxes * 14500,
        rentalCost: racks * 650 + boxes * 350,
        weightLbs: racks * 300 + boxes * (k2 ? 123 : 200),
        watts: racks * 1200 + boxes * 1200,
      });
    }
  } else if (rig.audioRig.lineArrays) {
    const boxes = 2 * Math.max(4, Math.min(12, Math.round(rig.audioRig.boxesPerSide ?? 9)));
    equipmentItems.push({
      category: 'Audio / Speakers',
      kind: 'audio',
      label: k2 ? 'K2 flown line arrays and amplifier racks (L/R)' : 'Flown line arrays and amplifier racks (L/R)',
      qty: `${boxes} boxes + 2 racks`,
      buyCost: 34000 + boxes * 14500,
      rentalCost: 1300 + boxes * 350,
      weightLbs: 600 + boxes * (k2 ? 123 : 200),
      watts: 2400 + boxes * 1200,
    });
  }
  if (rig.audioRig.subWall && rig.audioRig.subCount > 0) {
    equipmentItems.push({
      category: 'Audio / Speakers',
      kind: 'audio',
      label: k2 ? 'KS28 dual-18″ subwoofer wall' : 'Dual-18″ subwoofer wall',
      qty: `${rig.audioRig.subCount} subs`,
      buyCost: rig.audioRig.subCount * 7800,
      rentalCost: rig.audioRig.subCount * 195,
      weightLbs: rig.audioRig.subCount * (k2 ? 174 : 205),
      watts: rig.audioRig.subCount * 2400,
    });
  }

  const monitors = Math.max(0, Math.min(8, Math.round(rig.audioRig.monitorCount ?? 0)));
  if (monitors > 0) {
    equipmentItems.push({
      category: 'Audio / Speakers',
      kind: 'audio',
      label: k2 ? 'X12 coaxial floor monitors' : 'Coaxial floor monitors',
      qty: `${monitors} ${monitors === 1 ? 'wedge' : 'wedges'}`,
      buyCost: monitors * 2400,
      rentalCost: monitors * 85,
      weightLbs: monitors * (k2 ? 44.1 : 52),
      watts: monitors * 650,
    });
  }

  for (const kind of Object.keys(PROP_CATALOG) as StagePropKind[]) {
    const qty = rig.props?.filter(prop => prop.kind === kind).length ?? 0;
    if (qty === 0) continue;
    const unit = scenicAllowance[kind];
    equipmentItems.push({
      category: 'Scenery (simulation allowance)',
      kind: 'prop',
      label: PROP_CATALOG[kind].label,
      qty: `${qty} ${qty === 1 ? 'piece' : 'pieces'}`,
      buyCost: qty * unit.buyCost,
      rentalCost: qty * unit.rentalCost,
      weightLbs: qty * unit.weightLbs,
      watts: qty * unit.watts,
    });
  }

  // Native-authored layout props: air-filled pieces carry the tentacle (blower)
  // allowance; rigid scenic flats carry the riser allowance.
  for (const [type, label, unit] of [
    ['inflatable', 'Authored inflatables', scenicAllowance.tentacle],
    ['scenic', 'Authored scenic pieces', scenicAllowance.riser],
  ] as const) {
    const qty = authoredProps.filter(prop => prop.type === type).length;
    if (qty === 0) continue;
    equipmentItems.push({
      category: 'Scenery (simulation allowance)',
      kind: 'prop',
      label,
      qty: `${qty} ${qty === 1 ? 'piece' : 'pieces'}`,
      buyCost: qty * unit.buyCost,
      rentalCost: qty * unit.rentalCost,
      weightLbs: qty * unit.weightLbs,
      watts: qty * unit.watts,
    });
  }

  // 6. Smoke, Hazers & CO2 Cryo
  if (legacyHazerCount > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      kind: 'fixture',
      label: 'MDG ATMe Touring Hazers + CO2 Fluid',
      qty: `${legacyHazerCount} units`,
      buyCost: legacyHazerCount * 7200,
      rentalCost: legacyHazerCount * 240,
      weightLbs: legacyHazerCount * 79,
      watts: legacyHazerCount * 1400,
      body: 'hazer-box',
    });
  }
  if (legacySmokeCount > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      kind: 'fixture',
      label: 'JEM ZR45 High-Output Smoke Machines',
      qty: `${legacySmokeCount} units`,
      buyCost: legacySmokeCount * 2100,
      rentalCost: legacySmokeCount * 75,
      weightLbs: legacySmokeCount * 48,
      watts: legacySmokeCount * 2000,
      body: 'fogger-box',
    });
  }
  if (legacyCo2Count > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      kind: 'fixture',
      label: 'MagicFX CO2Jet II + Liquid CO2 Dewar Tanks',
      qty: `${legacyCo2Count} jets`,
      buyCost: legacyCo2Count * 1450,
      rentalCost: legacyCo2Count * 180,
      weightLbs: legacyCo2Count * 95,
      watts: legacyCo2Count * 80,
      body: 'co2-jet',
    });
  }
  equipmentItems.push(...fxCatalogRows);

  // Totals for Equipment
  const totalBuyCost = equipmentItems.reduce((a, b) => a + b.buyCost, 0);
  const totalRentalCost = equipmentItems.reduce((a, b) => a + b.rentalCost, 0);
  const totalWeightLbs = equipmentItems.reduce((a, b) => a + b.weightLbs, 0);
  const totalWatts = equipmentItems.reduce((a, b) => a + b.watts, 0);

  // 7. Real-World Union Crew & Labor Estimate (Load-In + Show Call + Load-Out)
  const totalFixtures = totalBeamCount + totalFloorBeamCount + totalWashCount + totalStrobeCount + totalBlinderCount;
  const totalLasers = totalLaserCount + totalFloorLaserCount;
  const shiftHours = rig.venue === 'festival' ? 16 : rig.venue === 'arena' ? 14 : rig.venue === 'club' ? 8 : 10;

  const paPoints = hangs !== undefined ? hangs.length * 2 : (rig.audioRig.lineArrays ? 4 : 0);
  const riggerCount = Math.max(2, Math.ceil((totalMotors + paPoints) / 3));
  const lightingCrew = Math.max(2, Math.ceil(totalFixtures / 10));
  const audioCrew = (rig.audioRig.lineArrays ? 4 : 1) + (rig.audioRig.subWall ? 2 : 0);
  const videoCrew = wall && wall.height > 0 ? (wall.wing.width > 0 ? 4 : 2) : (customMain || secondaryWalls.length ? 2 : 0);
  const stageHands = Math.max(4, Math.ceil(totalWeightLbs / 4500));

  const laborItems: LaborLineItem[] = [
    {
      role: 'Head Rigger & High-Steel Up-Riggers (Chain Hoists)',
      crewCount: riggerCount,
      hours: shiftHours,
      ratePerHr: 115,
      total: riggerCount * shiftHours * 115,
    },
    {
      role: 'Lighting Director (LD), Master Electrician & Techs',
      crewCount: lightingCrew,
      hours: shiftHours,
      ratePerHr: 88,
      total: lightingCrew * shiftHours * 88,
    },
    {
      role: 'Audio A1 Engineer & PA Line-Array Techs',
      crewCount: audioCrew,
      hours: shiftHours,
      ratePerHr: 85,
      total: audioCrew * shiftHours * 85,
    },
    {
      role: 'Local Union Stagehands (Load-In / Push / Strike)',
      crewCount: stageHands,
      hours: shiftHours,
      ratePerHr: 62,
      total: stageHands * shiftHours * 62,
    },
  ];

  if (videoCrew > 0) {
    laborItems.push({
      role: 'LED Wall Video Engineers & Media Server Op',
      crewCount: videoCrew,
      hours: shiftHours,
      ratePerHr: 92,
      total: videoCrew * shiftHours * 92,
    });
  }

  if (totalLasers > 0) {
    const lsoCount = Math.max(1, Math.ceil(totalLasers / 6));
    laborItems.push({
      role: 'Certified Laser Safety Officer (LSO) & ILDA Tech + FDA Variance',
      crewCount: lsoCount,
      hours: shiftHours,
      ratePerHr: 145,
      total: lsoCount * shiftHours * 145 + 650,
    });
  }

  if (totalCo2Count > 0 || totalSmokeCount > 0) {
    laborItems.push({
      role: 'SFX / Cryo & Atmospheric Tech',
      crewCount: 1,
      hours: shiftHours,
      ratePerHr: 85,
      total: shiftHours * 85,
    });
  }

  const totalLaborCost = laborItems.reduce((a, b) => a + b.total, 0);
  const totalCrewHeadcount = laborItems.reduce((a, b) => a + b.crewCount, 0);
  const trucksNeeded = Math.max(1, Math.ceil(totalWeightLbs / 11500));
  const truckingCost = trucksNeeded * 2650;
  const oneNightShowTotal = totalRentalCost + totalLaborCost + truckingCost;
  const loadInHours = Math.max(3, Math.round(4 + totalWeightLbs / 7500));

  return {
    equipmentItems,
    laborItems,
    totalBuyCost,
    totalRentalCost,
    totalLaborCost,
    trucksNeeded,
    truckingCost,
    oneNightShowTotal,
    totalWeightLbs,
    totalWatts,
    totalCrewHeadcount,
    loadInHours,
  };
}

export function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}
