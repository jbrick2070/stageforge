import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { hoistPoints } = await compiler.ssrLoadModule('/src/data/hoistPoints.ts');
const {
  TRUSS_PROFILES,
  HOIST_PROFILES,
  getTrussProfile,
  trussHalfHeight,
  trussChordRadius,
  trussMountY,
} = await compiler.ssrLoadModule('/src/data/rigCatalog.ts');
const {
  solveContinuousBeam,
  allowableMomentForSpan,
  evaluateRigLoads,
  CLAMP_ALLOWANCE_KG,
  CABLE_ALLOWANCE_FRACTION,
  RIG_CAUTION_THRESHOLD,
  RIG_OVERLOAD_THRESHOLD,
} = await compiler.ssrLoadModule('/src/data/rigLoads.ts');
const {
  computePowerReport,
  computeNeutralCurrent,
  riggingPowerCsv,
  POWER_SYSTEMS,
} = await compiler.ssrLoadModule('/src/data/powerReport.ts');
const { calculateProductionEstimate } = await compiler.ssrLoadModule('/src/data/productionEstimator.ts');
const { trussMounts } = await compiler.ssrLoadModule('/src/data/trussMounts.ts');
const { placeFixtures } = await compiler.ssrLoadModule('/src/data/fixturePlacement.ts');
const { createSharedMaterials, disposeSharedMaterials, buildTrussGeometry } =
  await compiler.ssrLoadModule('/src/engine/geometryBuilders.ts');
const { mulberry32 } = await compiler.ssrLoadModule('/src/engine/prng.ts');

test('hoistPoints matches buildTrussGeometry anchorPoints x/z for every shape, box count, and stock template', () => {
  const mats = createSharedMaterials({ tier: 'low' });
  try {
    // 1. Every stock template pod
    for (const [name, rig] of Object.entries(RIG_TEMPLATES)) {
      for (const pod of rig.trussPods) {
        const expected = hoistPoints(pod);
        const built = buildTrussGeometry(pod.shape, pod.width, mats, pod.path, 8, pod.trussProfileId, pod.hoistCount);
        assert.equal(built.anchorPoints.length, expected.length, `${name}/${pod.id} count`);
        expected.forEach((pt, i) => {
          assert.ok(Math.abs(built.anchorPoints[i].x - pt.x) < 1e-12, `${name}/${pod.id}[${i}].x`);
          assert.ok(Math.abs(built.anchorPoints[i].z - pt.z) < 1e-12, `${name}/${pod.id}[${i}].z`);
        });
      }
    }

    // 2. Explicit box hoist counts 2, 3, 4 + circle + chevron + open/closed paths
    const syntheticPods = [
      { shape: 'box', width: 10, hoistCount: 2 },
      { shape: 'box', width: 10, hoistCount: 3 },
      { shape: 'box', width: 16, hoistCount: 4 },
      { shape: 'circle', width: 8 },
      { shape: 'chevron', width: 12 },
      { shape: 'path', width: 10, path: [{ x: -4, z: 0 }, { x: 0, z: -3 }, { x: 4, z: 0 }] },
      { shape: 'path', width: 12, path: [{ x: -3, z: -2 }, { x: 3, z: -2 }, { x: 3, z: 2 }, { x: -3, z: -2 }] },
    ];
    for (const pod of syntheticPods) {
      const expected = hoistPoints(pod);
      const built = buildTrussGeometry(pod.shape, pod.width, mats, pod.path ?? [], 6, undefined, pod.hoistCount);
      assert.equal(built.anchorPoints.length, expected.length, `${pod.shape} count`);
      expected.forEach((pt, i) => {
        assert.ok(Math.abs(built.anchorPoints[i].x - pt.x) < 1e-12);
        assert.ok(Math.abs(built.anchorPoints[i].z - pt.z) < 1e-12);
      });
    }
  } finally {
    disposeSharedMaterials(mats);
  }
});

test('continuous-beam solver: exact 2-point moment balance, exact 3-point 5/8 wL center reaction, and uplift preservation', () => {
  // 1. 2-point exact static moment balance: 100 kg at x = -2 on supports at [-4, +4] -> R0 = 75, R1 = 25.
  const twoPt = solveContinuousBeam([-4, 4], -5, 5, 0, [{ x: -2, loadKg: 100 }]);
  assert.ok(Math.abs(twoPt.reactionsKg[0] - 75) < 1e-9);
  assert.ok(Math.abs(twoPt.reactionsKg[1] - 25) < 1e-9);

  // 2. 3-point uniform beam with no overhang: classic 3/16, 5/8 (0.625), 3/16 wL result!
  const w = 10; // kg/m
  const L = 12; // m -> total load = 120 kg, center = 75 kg, outer = 22.5 kg each
  const threePt = solveContinuousBeam([-6, 0, 6], -6, 6, w, []);
  assert.ok(Math.abs(threePt.reactionsKg[0] - (3 / 16) * w * L) < 1e-9, `R0=${threePt.reactionsKg[0]}`);
  assert.ok(Math.abs(threePt.reactionsKg[1] - 0.625 * w * L) < 1e-9, `R1=${threePt.reactionsKg[1]}`);
  assert.ok(Math.abs(threePt.reactionsKg[2] - (3 / 16) * w * L) < 1e-9, `R2=${threePt.reactionsKg[2]}`);

  // 3. Off-center overhang past outer hoist triggers negative uplift reaction (never clamped to 0!).
  const uplift2 = solveContinuousBeam([-3, 3], -5, 5, 0, [{ x: -4.5, loadKg: 100 }]);
  // Moment about s0 (-3): R1 * 6 = 100 * (-1.5) => R1 = -25 kg (uplift!), R0 = 125 kg.
  assert.ok(Math.abs(uplift2.reactionsKg[0] - 125) < 1e-9);
  assert.ok(Math.abs(uplift2.reactionsKg[1] - -25) < 1e-9);

  // 4. 3-point overhang uplift matches Clapeyron's three-moment theorem: 100 kg at x=-5 on [-4, 0, 4] -> [131.25, -37.5, 6.25].
  const uplift3 = solveContinuousBeam([-4, 0, 4], -5, 5, 0, [{ x: -5, loadKg: 100 }]);
  assert.ok(Math.abs(uplift3.reactionsKg[0] - 131.25) < 1e-9);
  assert.ok(Math.abs(uplift3.reactionsKg[1] - -37.5) < 1e-9);
  assert.ok(Math.abs(uplift3.reactionsKg[2] - 6.25) < 1e-9);
});

test('equilibrium invariant: sum of reactions equals total suspended load within 1e-9 for all templates and fuzz cases', () => {
  // All stock templates
  for (const [name, rig] of Object.entries(RIG_TEMPLATES)) {
    const report = evaluateRigLoads(rig);
    for (const pod of report.pods) {
      const sumR = pod.points.reduce((s, p) => s + p.hoistLoadKg, 0);
      assert.ok(
        Math.abs(sumR - pod.totalSuspendedKg) < 1e-9,
        `${name}/${pod.podName}: sumR=${sumR} vs total=${pod.totalSuspendedKg}`,
      );
      // Verify explicit clamp & +10% cable allowances
      assert.ok(Math.abs(pod.clampAllowanceKg - pod.fixtureCount * CLAMP_ALLOWANCE_KG) < 1e-9);
      assert.ok(Math.abs(pod.cableAllowanceKg - pod.fixtureWeightKg * CABLE_ALLOWANCE_FRACTION) < 1e-9);
    }
  }

  // Deterministic fuzz test across 100 random 2..4-point beams with arbitrary overhangs and loads
  const rng = mulberry32(0x5f4b3a21);
  for (let trial = 0; trial < 100; trial++) {
    const n = 2 + Math.floor(rng() * 3); // 2, 3, or 4 supports
    const width = 4 + rng() * 18;
    const half = width / 2;
    const spanFraction = 0.65 + rng() * 0.25;
    const supports = Array.from({ length: n }, (_, i) => -half * spanFraction + (2 * half * spanFraction * i) / (n - 1));
    const w = 5 + rng() * 15;
    const count = 1 + Math.floor(rng() * 12);
    const loads = Array.from({ length: count }, () => ({
      x: (rng() * 2 - 1) * half,
      loadKg: 5 + rng() * 60,
    }));
    const expectedTotal = w * width + loads.reduce((s, l) => s + l.loadKg, 0);
    const sol = solveContinuousBeam(supports, -half, half, w, loads);
    const sumR = sol.reactionsKg.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sumR - expectedTotal) < 1e-9, `trial ${trial}: sumR=${sumR} vs ${expectedTotal}`);
  }
});

test('span table interpolation, out-of-table spans, exact 80%/100% thresholds, D8 derate, and unknown IDs', () => {
  const h30v = getTrussProfile('prolyte-h30v');
  assert.ok(h30v);

  // Midpoint interpolation between 8 m and 10 m
  const mid = allowableMomentForSpan(h30v, 9);
  assert.equal(mid.outOfTable, false);
  const expectedUdl = (176.2 + 110.5) / 2;
  const expectedCpl = (700.6 + 563.2) / 2;
  const expectedM = Math.min((expectedUdl * 81) / 8, (expectedCpl * 9) / 4);
  assert.ok(Math.abs(mid.allowableMomentKgM - expectedM) < 1e-9);

  // Beyond max span (12 m) -> out of table
  const tooLong = allowableMomentForSpan(h30v, 14);
  assert.equal(tooLong.outOfTable, true);
  assert.equal(tooLong.allowableMomentKgM, null);

  // Exact 80% caution & 100% overload boundaries + D8 derate vs D8+ no derate
  const makeTestRig = (fixtureCount, hoistId, motorized = false) => {
    const rig = structuredClone(RIG_TEMPLATES.club_stage);
    rig.trussPods = [
      {
        id: 'pod-test',
        name: 'Test Box',
        shape: 'box',
        width: 8,
        x: 0,
        baseY: 8,
        z: 0,
        rotationY: 0,
        motorized,
        motorMinY: 5,
        motorMaxY: 10,
        trussProfileId: 'prolyte-h30v',
        hoistId,
        hoistCount: 2,
        fixtures: [
          {
            id: 'fg-1',
            type: 'beam',
            modelName: 'Martin MAC Ultra Performance',
            catalogId: 'martin-mac-ultra-performance', // 44 kg each
            dmxMode: '48-Ch Extended',
            dmxChannels: 48,
            count: fixtureCount,
            dmxUniverse: 1,
            dmxStartChannel: 1,
          },
        ],
      },
    ];
    rig.floorFx = [];
    return rig;
  };

  // D8 500 kg hoist derated 50% -> effective WLL = 250 kg; D8+ 500 kg -> effective WLL = 500 kg.
  const d8Report = evaluateRigLoads(makeTestRig(4, 'cm-lodestar-05t'));
  const d8PlusReport = evaluateRigLoads(makeTestRig(4, 'chainmaster-d8plus-500'));
  assert.equal(d8Report.pods[0].d8Derated, true);
  assert.equal(d8Report.pods[0].points[0].effectiveWllKg, 250);
  assert.equal(d8PlusReport.pods[0].d8Derated, false);
  assert.equal(d8PlusReport.pods[0].points[0].effectiveWllKg, 500);

  // Exact boundary check: craft load so point utilization is 0.80 vs 1.00 vs 1.01
  // 8m H30V self-weight = 56 kg (28 kg/pt). With D8+ 500 kg (eff WLL = 500):
  // Need 16 units of 44 kg = 704 kg + 16 clamps + 70.4 cables + 56 truss = 846.4 kg -> 423.2 kg/pt = 84.6% (caution)
  const cautionRep = evaluateRigLoads(makeTestRig(16, 'chainmaster-d8plus-500'));
  assert.ok(cautionRep.pods[0].maxPointUtilization >= RIG_CAUTION_THRESHOLD);
  assert.ok(cautionRep.pods[0].maxPointUtilization <= RIG_OVERLOAD_THRESHOLD);
  assert.equal(cautionRep.pods[0].status, 'caution');

  // 20 units -> ~522 kg/pt > 500 kg -> overload!
  const overloadRep = evaluateRigLoads(makeTestRig(20, 'chainmaster-d8plus-500'));
  assert.ok(overloadRep.pods[0].maxPointUtilization > RIG_OVERLOAD_THRESHOLD);
  assert.equal(overloadRep.pods[0].status, 'overload');

  // Unknown future truss/hoist IDs stay safe and report unknown
  const unknownRig = makeTestRig(2, 'future-hoist-3t');
  unknownRig.trussPods[0].trussProfileId = 'future-truss-x90';
  const unkRep = evaluateRigLoads(unknownRig);
  assert.equal(unkRep.pods[0].trussProfileUnknown, true);
  assert.equal(unkRep.pods[0].hoistUnknown, true);
  assert.equal(unkRep.pods[0].status, 'unknown');
});

test('power report: neutral current math, deterministic LPT stability, 80% circuit packing, and exact total W parity', () => {
  // 1. Neutral current: 0 when balanced, I when single phase loaded.
  assert.ok(Math.abs(computeNeutralCurrent(42, 42, 42)) < 1e-12);
  assert.ok(Math.abs(computeNeutralCurrent(37.5, 0, 0) - 37.5) < 1e-12);
  assert.ok(Math.abs(computeNeutralCurrent(0, 19.2, 0) - 19.2) < 1e-12);

  // 2. Circuit packing at exact 80% continuous rating:
  // US 120V 20A -> 80% = 1,920 VA. With PF 1.0 (blinder 960 W or two 960 W = 1,920 VA -> 1 circuit; three -> 2 circuits).
  // Use 3 × Molefay (2600 W each, PF 1.0): each unit is 21.67 A > 20 A -> 3 overloaded single-unit circuits on US 120V,
  // but on EU 230V 16A (11.3 A < 12.8 A continuous) -> 3 OK circuits!
  const blinderRig = structuredClone(RIG_TEMPLATES.club_stage);
  blinderRig.ledWall.enabled = false;
  blinderRig.audioRig.lineArrays = false;
  blinderRig.audioRig.subWall = false;
  blinderRig.floorFx = [];
  blinderRig.trussPods = [
    {
      ...blinderRig.trussPods[0],
      motorized: false,
      fixtures: [
        {
          id: 'bl-1',
          type: 'blinder',
          modelName: 'Molefay 4-Lite',
          catalogId: 'mole-richardson-molefay-4lite',
          dmxMode: '1-Ch Dimmer',
          dmxChannels: 1,
          count: 3,
          dmxUniverse: 1,
          dmxStartChannel: 1,
          circuitGroup: 'DIM-A',
        },
      ],
    },
  ];
  const usRep = computePowerReport({ ...blinderRig, power: { system: 'us_208_3p' } });
  const usBlinderCircuits = usRep.circuits.filter((c) => c.groupLabel === 'DIM-A');
  assert.equal(usBlinderCircuits.length, 3);
  assert.ok(usBlinderCircuits.every((c) => c.status === 'overload'));

  const euRep = computePowerReport({ ...blinderRig, power: { system: 'eu_400_3p' } });
  const euBlinderCircuits = euRep.circuits.filter((c) => c.groupLabel === 'DIM-A');
  assert.equal(euBlinderCircuits.length, 3);
  assert.ok(euBlinderCircuits.every((c) => c.status === 'ok'));

  // 3. Deterministic LPT phase assignment under pod reordering (same circuit labels -> identical phase loads).
  const rigA = structuredClone(RIG_TEMPLATES.arena_mainstage);
  rigA.trussPods.forEach((p, idx) => {
    p.fixtures.forEach((f, fi) => {
      f.circuitGroup = `G${idx}-${fi}`;
    });
  });
  const rigB = structuredClone(rigA);
  rigB.trussPods.reverse();
  const repA = computePowerReport(rigA);
  const repB = computePowerReport(rigB);
  assert.deepEqual(
    repA.phases.map((p) => Number(p.amps.toFixed(4))),
    repB.phases.map((p) => Number(p.amps.toFixed(4))),
  );

  // 4. Strict total W invariant: powerReport.totals.totalW === productionEstimator.totalWatts across ALL templates & profiled rigs.
  for (const [name, rig] of Object.entries(RIG_TEMPLATES)) {
    const est = calculateProductionEstimate(rig);
    const pwr = computePowerReport(rig);
    assert.equal(pwr.totals.totalW, Math.round(est.totalWatts), `${name} totalW parity`);
    assert.equal(pwr.totals.continuousW + pwr.totals.intermittentW, pwr.totals.totalW, `${name} cont+int=total`);
  }

  // Also test with profiled trusses & hoists (including dead-hang 0W & ChainMaster 1100W).
  const profiled = structuredClone(RIG_TEMPLATES.arena_mainstage);
  profiled.trussPods[0].trussProfileId = 'prolyte-h40v';
  profiled.trussPods[0].hoistId = 'chainmaster-d8plus-1000';
  profiled.trussPods[1].hoistId = 'dead-hang-1t';
  const estProf = calculateProductionEstimate(profiled);
  const pwrProf = computePowerReport(profiled);
  assert.equal(pwrProf.totals.totalW, Math.round(estProf.totalWatts), 'profiled totalW parity');
  assert.equal(pwrProf.totals.continuousW + pwrProf.totals.intermittentW, pwrProf.totals.totalW);

  // 5. CSV export includes BOM, guidance disclaimer, all sections, and neutralizes formula injection.
  const hostile = structuredClone(RIG_TEMPLATES.club_stage);
  hostile.name = '=CMD|attack';
  const csv = riggingPowerCsv(hostile);
  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.ok(csv.includes('section,pod_or_group,item'));
  assert.ok(csv.includes('disclaimer,'));
  assert.ok(csv.includes('point,'));
  assert.ok(csv.includes('circuit,'));
  assert.ok(csv.includes('phase,'));
  assert.ok(csv.includes('summary,'));
  assert.ok(csv.includes("'=CMD|attack"));
  assert.ok(POWER_SYSTEMS.us_208_3p.voltageLL === 208);
});

test('3D geometry invariance: legacy trussMounts returns exact -0.28 and profiled clamps seat on bottom chord within 1 mm', () => {
  // Legacy literal -0.28 (not IEEE-754 -(0.24 + 0.04) = -0.27999999999999997)
  const legacyBox = trussMounts('box', 12);
  assert.equal(legacyBox[0].y, -0.28);
  assert.equal(trussMountY(undefined, 'box', 12), -0.28);

  // Profiled truss: bottom of bottom chord is at -(halfHeight + chordRadius); mountY must match within 1 mm.
  for (const profile of TRUSS_PROFILES) {
    const h = trussHalfHeight(profile.id, 'box', 10);
    const r = trussChordRadius(profile.id);
    const expectedBottomChord = -(h + r);
    const y = trussMountY(profile.id, 'box', 10);
    assert.ok(Math.abs(y - expectedBottomChord) < 0.001, `${profile.id}: mountY=${y} vs ${expectedBottomChord}`);

    const rig = structuredClone(RIG_TEMPLATES.club_stage);
    rig.trussPods[0].shape = 'box';
    rig.trussPods[0].trussProfileId = profile.id;
    const placements = placeFixtures(rig).filter((p) => !p.floor && p.podId === rig.trussPods[0].id);
    assert.ok(placements.length > 0);
    assert.ok(Math.abs(placements[0].position.y - (rig.trussPods[0].baseY + expectedBottomChord)) < 0.001);
  }
});

test('docs/rigging-power.md documents every source ID referenced by TRUSS_PROFILES and HOIST_PROFILES', async () => {
  const doc = await readFile(new URL('../docs/rigging-power.md', import.meta.url), 'utf8');
  for (const tp of TRUSS_PROFILES) {
    assert.ok(doc.includes(`\`${tp.id}\``), `docs/rigging-power.md missing truss ID ${tp.id}`);
    for (const src of tp.sources) {
      assert.ok(doc.includes(`\`${src}\``), `docs/rigging-power.md missing source ${src}`);
    }
  }
  for (const hp of HOIST_PROFILES) {
    assert.ok(doc.includes(`\`${hp.id}\``), `docs/rigging-power.md missing hoist ID ${hp.id}`);
    for (const src of hp.sources) {
      assert.ok(doc.includes(`\`${src}\``), `docs/rigging-power.md missing source ${src}`);
    }
  }
});

test('QA regressions: H1 tableDeductsSelfWeight semantics, M2 stock template no-cantilever-caution, M8 singular/unsorted supports, M3/M4/M6/M7/M9', () => {
  // H1: Verify tableDeductsSelfWeight: true (payload-only moment) vs false (gross moment incl. self-weight)
  const h30v = getTrussProfile('prolyte-h30v');
  assert.equal(h30v.tableDeductsSelfWeight, true);
  const netSol = solveContinuousBeam([-4, 4], -5, 5, 0, [{ x: 0, loadKg: 100 }]);
  const grossSol = solveContinuousBeam([-4, 4], -5, 5, h30v.kgPerMeter, [{ x: 0, loadKg: 100 }]);
  assert.ok(grossSol.spanMaxMomentsKgM[0] > netSol.spanMaxMomentsKgM[0] + 40, 'gross moment strictly exceeds payload-only moment');

  // M2: No stock template pod should drop to Caution due to unverified cantilever warnings.
  for (const [name, rig] of Object.entries(RIG_TEMPLATES)) {
    const rep = evaluateRigLoads(rig);
    for (const pod of rep.pods) {
      assert.equal(pod.cantileverWarnings.length, 0, `${name}/${pod.podName} has no verified cantilever warning`);
      if (pod.maxPointUtilization !== null && pod.maxPointUtilization < RIG_CAUTION_THRESHOLD) {
        assert.notEqual(pod.status, 'caution', `${name}/${pod.podName} not falsely demoted to caution`);
      }
    }
  }

  // M8: solveContinuousBeam rejects unsorted, duplicate, and non-finite supports with readable Error,
  // while evaluateRigLoads catches degenerate box pod width safely and marks status 'unknown' without crashing UI.
  assert.throws(() => solveContinuousBeam([4, -4], -5, 5, 10, []), /strictly ascending/);
  assert.throws(() => solveContinuousBeam([-4, 0, 0, 4], -5, 5, 10, []), /strictly ascending/);
  assert.throws(() => solveContinuousBeam([-4, Number.NaN, 4], -5, 5, 10, []), /finite/);
  const degenRig = structuredClone(RIG_TEMPLATES.club_stage);
  degenRig.trussPods = [{ ...degenRig.trussPods[0], shape: 'box', width: 0, fixtures: [] }];
  const degenRep = evaluateRigLoads(degenRig);
  assert.equal(degenRep.pods[0].status, 'unknown');
  assert.ok(degenRep.pods[0].warnings.some((w) => /Degenerate truss geometry/.test(w)));

  // M3 + M4 + M6 + M9: Custom feederA (80 A), hoist-headroom overload, generator includes hoists, CSV phase CAUTION + unit column.
  const rig = structuredClone(RIG_TEMPLATES.club_stage);
  rig.ledWall.enabled = false;
  rig.audioRig.lineArrays = false;
  rig.audioRig.subWall = false;
  rig.floorFx = [];
  // Craft ~27 A continuous on each phase (9.6 kW) + 12 hoists @ 1500 W (18 kW -> ~62.5 A/phase on 208V 3ph!)
  // On an 80 A custom feeder: continuous = 27 A (OK), with hoists = 89.5 A (> 80 A -> OVERLOAD!)
  rig.trussPods = Array.from({ length: 4 }, (_, i) => ({
    id: `pod-${i}`,
    name: `Truss ${i + 1}`,
    shape: 'box',
    width: 14,
    x: 0,
    baseY: 8,
    z: i * 2,
    rotationY: 0,
    motorized: true,
    motorMinY: 5,
    motorMaxY: 10,
    hoistCount: 3, // 4 pods x 3 hoists = 12 hoists x 1500 W = 18,000 W intermittent
    fixtures: [
      {
        id: `fg-${i}`,
        type: 'wash',
        modelName: 'Martin MAC Aura XB',
        catalogId: 'martin-mac-aura-xb', // 359 W each
        dmxMode: '14-Ch Standard',
        dmxChannels: 14,
        count: 6,
        dmxUniverse: 1,
        dmxStartChannel: 1 + i * 84,
      },
    ],
  }));
  rig.power = { system: 'us_208_3p', feederA: 80 };
  const pwr = computePowerReport(rig);
  const est = calculateProductionEstimate(rig);
  // M9: computed totalW strictly matches estimator
  assert.equal(pwr.totals.totalW, Math.round(est.totalWatts));
  assert.equal(pwr.totals.continuousW + pwr.totals.intermittentW, pwr.totals.totalW);
  // M4: custom 80 A preserved
  assert.equal(pwr.totals.configuredFeederA, 80);
  // M3: hoists push peak phase over 80 A -> feederStatus is overload, and generator kVA includes intermittent hoists
  assert.ok(pwr.totals.maxPhaseWithHoistsAmps > 80);
  assert.equal(pwr.totals.feederStatus, 'overload');
  const continuousOnlyGen = Math.ceil((pwr.totals.continuousKva * 1.25) / 5) * 5;
  assert.ok(pwr.totals.recommendedGeneratorKva > continuousOnlyGen, 'generator includes intermittent hoists');

  // M6: CSV phase row at 85% feeder utilization shows CAUTION (matching circuitStatusFor) and includes unit column.
  const cautionFeederA = Math.ceil(pwr.totals.maxPhaseAmps / 0.88);
  const cautionRig = { ...rig, power: { system: 'us_208_3p', feederA: cautionFeederA } };
  const csv = riggingPowerCsv(cautionRig);
  assert.ok(csv.includes('section,pod_or_group,item,detail,load_or_watts,unit,'));
  const phaseLines = csv.split('\r\n').filter((line) => line.startsWith('phase,'));
  assert.ok(phaseLines.some((line) => line.includes(',CAUTION,')), `expected CAUTION on phase row: ${phaseLines.join(' | ')}`);

  // M7: Closed-loop & near-coincident path vertices match between hoistPoints and productionEstimator.
  const loopRig = structuredClone(RIG_TEMPLATES.club_stage);
  loopRig.trussPods = [
    {
      id: 'loop-1',
      name: 'Loop',
      shape: 'path',
      width: 12,
      path: [
        { x: -3, z: -2 },
        { x: 3, z: -2 },
        { x: 3, z: 2 },
        { x: -3 + 1e-5, z: -2 },
      ],
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: true,
      motorMinY: 4,
      motorMaxY: 9,
      fixtures: [],
    },
  ];
  assert.equal(hoistPoints(loopRig.trussPods[0]).length, 3);
  const loopEst = calculateProductionEstimate(loopRig);
  const motorLine = loopEst.equipmentItems.find((i) => i.kind === 'motor');
  assert.equal(motorLine.unitCount, 3);
});
