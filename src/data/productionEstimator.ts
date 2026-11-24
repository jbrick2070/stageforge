import type { RigConfig, StagePropKind } from '../types/show';
import { PROP_CATALOG } from './stageProps';
import { pathLength } from './stageDesign';
import { ledPlacement } from './stageEquipment';
import type { NativeStage } from './showFile';
import { authoredWallFrames, authoredWallSurface, resolveStudioGeometry } from './studioGeometry';

export interface CostLineItem {
  category: 'Rigging & Motors' | 'Lighting' | 'Lasers' | 'LED Video' | 'Audio / Speakers' | 'Smoke & FX' | 'Stage & FOH' | 'Scenery (simulation allowance)';
  label: string;
  qty: string;
  buyCost: number;
  rentalCost: number;
  weightLbs: number;
  watts: number;
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
    label: 'FOH Control (DMX Console + Laser Server + Audio Desk)',
    qty: '1 pkg',
    buyCost: 94000,
    rentalCost: 2900,
    weightLbs: 680,
    watts: 2200,
  });

  // 2. Trusses & Kinetic Chain Hoist Motors
  let totalTrussMeters = 0;
  let totalMotors = 0;
  let beamCount = 0;
  let washCount = 0;
  let laserCount = 0;
  let strobeCount = 0;
  let blinderCount = 0;

  for (const pod of rig.trussPods) {
    const path = pod.shape === 'path' ? pod.path : undefined;
    const meters = path ? pathLength(path) : pod.shape === 'circle' ? Math.PI * pod.width : pod.width;
    totalTrussMeters += meters;
    const anchors = path ? new Set(path.map(p => p.x + ',' + p.z)).size :
      pod.shape === 'circle' ? 4 : pod.shape === 'chevron' ? 3 : pod.width >= 14 ? 3 : 2;
    if (pod.motorized) totalMotors += anchors;

    for (const fg of pod.fixtures) {
      if (fg.type === 'beam') beamCount += fg.count;
      else if (fg.type === 'wash') washCount += fg.count;
      else if (fg.type === 'laser') laserCount += fg.count;
      else if (fg.type === 'strobe') strobeCount += fg.count;
      else if (fg.type === 'blinder') blinderCount += fg.count;
    }
  }

  if (totalTrussMeters > 0) {
    equipmentItems.push({
      category: 'Rigging & Motors',
      label: 'Aluminum truss sections',
      qty: `${Math.round(totalTrussMeters)} m`,
      buyCost: Math.round(totalTrussMeters * 460),
      rentalCost: Math.round(totalTrussMeters * 26),
      weightLbs: Math.round(totalTrussMeters * 30),
      watts: 0,
    });
  }

  if (totalMotors > 0) {
    equipmentItems.push({
      category: 'Rigging & Motors',
      label: 'Kinesys / CM Lodestar 1-Ton Kinetic Chain Motors',
      qty: `${totalMotors} hoists`,
      buyCost: totalMotors * 7800,
      rentalCost: totalMotors * 275,
      weightLbs: totalMotors * 124,
      watts: totalMotors * 1500,
    });
  }

  // 3. Overhead & Floor Lighting + Lasers + Smoke/CO2
  let floorLaserCount = 0;
  let floorBeamCount = 0;
  let co2Count = 0;
  let smokeCount = 0;
  let hazerCount = 0;

  for (const fx of rig.floorFx) {
    if (fx.type === 'floor_laser') floorLaserCount += fx.count;
    else if (fx.type === 'floor_beam') floorBeamCount += fx.count;
    else if (fx.type === 'co2') co2Count += fx.count;
    else if (fx.type === 'smoke') smokeCount += fx.count;
    else if (fx.type === 'hazer') hazerCount += fx.count;
  }

  const allBeams = beamCount + floorBeamCount;
  if (allBeams > 0) {
    equipmentItems.push({
      category: 'Lighting',
      label: 'Sharpy X-Beam / MegaPointe Moving Heads',
      qty: `${allBeams} units`,
      buyCost: allBeams * 7100,
      rentalCost: allBeams * 195,
      weightLbs: allBeams * 44,
      watts: allBeams * 520,
    });
  }
  if (washCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      label: 'MAC Aura Pro RGBW Moving Washes',
      qty: `${washCount} units`,
      buyCost: washCount * 5400,
      rentalCost: washCount * 145,
      weightLbs: washCount * 28,
      watts: washCount * 400,
    });
  }
  if (strobeCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      label: 'Atomic Pro JDC-1 Arena Strobe Bars',
      qty: `${strobeCount} units`,
      buyCost: strobeCount * 4900,
      rentalCost: strobeCount * 135,
      weightLbs: strobeCount * 26,
      watts: strobeCount * 1200,
    });
  }
  if (blinderCount > 0) {
    equipmentItems.push({
      category: 'Lighting',
      label: 'Molefay 4-Lite Warm Audience Blinders',
      qty: `${blinderCount} units`,
      buyCost: blinderCount * 1450,
      rentalCost: blinderCount * 48,
      weightLbs: blinderCount * 24,
      watts: blinderCount * 2600,
    });
  }

  if (laserCount > 0) {
    equipmentItems.push({
      category: 'Lasers',
      label: 'KVANT Clubmax 12W RGB Overhead Lasers',
      qty: `${laserCount} units`,
      buyCost: laserCount * 14500,
      rentalCost: laserCount * 560,
      weightLbs: laserCount * 32,
      watts: laserCount * 350,
    });
  }
  if (floorLaserCount > 0) {
    equipmentItems.push({
      category: 'Lasers',
      label: 'KVANT Spectrum 25W Stage Deck Lasers',
      qty: `${floorLaserCount} units`,
      buyCost: floorLaserCount * 28000,
      rentalCost: floorLaserCount * 950,
      weightLbs: floorLaserCount * 54,
      watts: floorLaserCount * 650,
    });
  }

  // 4. Giant LED Video Wall + IMAG Side Wings + Authored Secondary Walls
  // A custom main-led replaces the stock wall and its wings (StageEngine builds one panel).
  const frames = authoredWallFrames(rig, stage);
  const customMain = frames.find(frame => frame.id === 'main-led');
  const wall = rig.ledWall.enabled && !customMain ? ledPlacement(rig) : undefined;
  const secondaryWalls = frames.filter(frame => frame.id !== 'main-led');
  const secondaryArea = secondaryWalls.reduce((sum, w) => sum + w.width * w.height, 0);
  if (customMain) {
    const surface = authoredWallSurface(rig, customMain);
    const area = customMain.width * customMain.height;
    equipmentItems.push({
      category: 'LED Video',
      label: 'LED wall (authored placement)',
      qty: surface.cabinets ? `${surface.columns * surface.rows} cabinets · ${Number(area.toFixed(2))} m²` : `${Number(area.toFixed(2))} m²`,
      buyCost: Math.round(area * 3800),
      rentalCost: Math.round(area * 185),
      weightLbs: Math.round(area * 62),
      watts: Math.round(area * 580),
    });
  } else if (wall && wall.height > 0) {
    const totalLedArea = wall.width * wall.height + 2 * wall.wing.width * wall.wing.height;
    const cabinetCount = wall.columns * wall.rows + 2 * wall.wing.columns * wall.wing.rows;
    equipmentItems.push({
      category: 'LED Video',
      label: `LED wall${rig.ledWall.curved ? ' (curved)' : ''}${wall.wing.width > 0 ? ' + IMAG wings' : ''}`,
      qty: rig.ledWall.cabinets ? `${cabinetCount} cabinets · ${Number(totalLedArea.toFixed(2))} m²` : `${Number(totalLedArea.toFixed(2))} m²`,
      buyCost: Math.round(totalLedArea * 3800),
      rentalCost: Math.round(totalLedArea * 185),
      weightLbs: Math.round(totalLedArea * 62),
      watts: Math.round(totalLedArea * 580),
    });
  }
  if (secondaryArea > 0) {
    equipmentItems.push({
      category: 'LED Video',
      label: `Secondary LED walls (${secondaryWalls.length})`,
      qty: `${Number(secondaryArea.toFixed(2))} m²`,
      buyCost: Math.round(secondaryArea * 3800),
      rentalCost: Math.round(secondaryArea * 185),
      weightLbs: Math.round(secondaryArea * 62),
      watts: Math.round(secondaryArea * 580),
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
      label,
      qty: `${qty} ${qty === 1 ? 'piece' : 'pieces'}`,
      buyCost: qty * unit.buyCost,
      rentalCost: qty * unit.rentalCost,
      weightLbs: qty * unit.weightLbs,
      watts: qty * unit.watts,
    });
  }

  // 6. Smoke, Hazers & CO2 Cryo
  if (hazerCount > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      label: 'MDG ATMe Touring Hazers + CO2 Fluid',
      qty: `${hazerCount} units`,
      buyCost: hazerCount * 7200,
      rentalCost: hazerCount * 240,
      weightLbs: hazerCount * 79,
      watts: hazerCount * 1400,
    });
  }
  if (smokeCount > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      label: 'JEM ZR45 High-Output Smoke Machines',
      qty: `${smokeCount} units`,
      buyCost: smokeCount * 2100,
      rentalCost: smokeCount * 75,
      weightLbs: smokeCount * 48,
      watts: smokeCount * 2000,
    });
  }
  if (co2Count > 0) {
    equipmentItems.push({
      category: 'Smoke & FX',
      label: 'MagicFX CO2Jet II + Liquid CO2 Dewar Tanks',
      qty: `${co2Count} jets`,
      buyCost: co2Count * 1450,
      rentalCost: co2Count * 180,
      weightLbs: co2Count * 95,
      watts: co2Count * 80,
    });
  }

  // Totals for Equipment
  const totalBuyCost = equipmentItems.reduce((a, b) => a + b.buyCost, 0);
  const totalRentalCost = equipmentItems.reduce((a, b) => a + b.rentalCost, 0);
  const totalWeightLbs = equipmentItems.reduce((a, b) => a + b.weightLbs, 0);
  const totalWatts = equipmentItems.reduce((a, b) => a + b.watts, 0);

  // 7. Real-World Union Crew & Labor Estimate (Load-In + Show Call + Load-Out)
  const totalFixtures = allBeams + washCount + strobeCount + blinderCount;
  const totalLasers = laserCount + floorLaserCount;
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

  if (co2Count > 0 || smokeCount > 0) {
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
