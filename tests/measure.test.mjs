import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const measureMod = await vite.ssrLoadModule('/src/data/measure.ts');
const venueMod = await vite.ssrLoadModule('/src/data/venueBounds.ts');
const preflightMod = await vite.ssrLoadModule('/src/data/preflight.ts');
const laserSafetyMod = await vite.ssrLoadModule('/src/data/laserSafety.ts');
const focusAimMod = await vite.ssrLoadModule('/src/engine/focusAim.ts');
const opticsMod = await vite.ssrLoadModule('/src/data/fixtureOptics.ts');
const presetsMod = await vite.ssrLoadModule('/src/data/presets.ts');

const {
  computeLaserNohd,
  computeBeamFootprint,
  estimateIlluminanceLux,
  measureFixtureUnit,
  evaluateLaserZones,
  evaluateStaticHeadMeasures,
  computeReachMap,
  buildSceneRaySurfaces,
  castRayToScene,
  computeVenueBounds,
  intersectRayAudienceZone,
} = measureMod;
const { venueAudienceEndZ } = venueMod;
const {
  EMPTY_PREFLIGHT_ACKS,
  computePreflightRevision,
  hashIldaClipContent,
  evaluatePreflight,
  commissioningActionLabel,
  commissioningRecordCsv,
} = preflightMod;
const { evaluateLaserSafety, MIN_AUDIENCE_CLEARANCE_M } = laserSafetyMod;
const { aimAngles, axisDmx, HEAD_PIVOT, PAN_LIMIT, TILT_LIMIT } = focusAimMod;
const { beamZoomScale, fixtureOptics, resolvedPhotometricLumens } = opticsMod;
const { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } = presetsMod;

test.after(async () => {
  await vite.close();
});

test('beam footprint: normal 10 m / 10° pin (~1.75 m), oblique conic ellipse, and grazing unbounded guard', () => {
  const normal = computeBeamFootprint(10, 10, 0);
  // Exact point-cone: 2 * 10 * tan(5 deg) = 1.749773... m
  assert.ok(Math.abs(normal.normalDiameterM - 1.749773) < 1e-4, `got ${normal.normalDiameterM}`);
  assert.ok(Math.abs(normal.minorDiameterM - normal.normalDiameterM) < 1e-6);
  assert.ok(Math.abs(normal.majorDiameterM - normal.normalDiameterM) < 1e-6);
  assert.equal(normal.grazing, false);

  // Oblique 45° incidence stretches major axis well beyond minor axis
  const oblique = computeBeamFootprint(10, 10, 45);
  assert.equal(oblique.grazing, false);
  assert.ok(oblique.majorDiameterM !== null && oblique.majorDiameterM > oblique.minorDiameterM * 1.35);
  assert.ok(oblique.majorDiameterM > 2.4 && oblique.majorDiameterM < 2.6, `expected ~2.50 m, got ${oblique.majorDiameterM}`);

  // Grazing: alpha + beta >= 90° (86° + 5° = 91°) must mark grazing & null major axis (never invent a capped value)
  const grazing = computeBeamFootprint(10, 10, 86);
  assert.equal(grazing.grazing, true);
  assert.equal(grazing.majorDiameterM, null);
});

test('ray intersections hit stage deck, venue floor, LED walls, indoor ceiling, and report none on open-air festival sky', () => {
  const arenaRig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const arenaSurfaces = buildSceneRaySurfaces(arenaRig);

  // Straight down onto center of stage deck (height 1.8 m) from y = 10 m -> throw = 8.2 m
  const deckHit = castRayToScene({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, arenaSurfaces);
  assert.equal(deckHit.kind, 'deck');
  assert.ok(Math.abs(deckHit.distanceM - 8.2) < 1e-4);
  assert.ok(Math.abs(deckHit.incidenceDeg - 0) < 1e-4);

  // Straight down onto audience floor (z = 12, past stageDepth/2 = 5.5) from y = 10 m -> throw = 10.0 m
  const floorHit = castRayToScene({ x: 0, y: 10, z: 12 }, { x: 0, y: -1, z: 0 }, arenaSurfaces);
  assert.equal(floorHit.kind, 'floor');
  assert.ok(Math.abs(floorHit.distanceM - 10.0) < 1e-4);
  assert.ok(Math.abs(floorHit.point.y) < 1e-6);

  // Horizontal ray toward upstage main LED wall (z = -5.1) from z = 0, y = 5 -> hits wall
  const wallHit = castRayToScene({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: -1 }, arenaSurfaces);
  assert.equal(wallHit.kind, 'wall');
  assert.equal(wallHit.surfaceLabel, 'Main LED wall');
  assert.ok(wallHit.distanceM > 4 && wallHit.distanceM < 6);
  assert.ok(Math.abs(wallHit.incidenceDeg - 0) < 1e-4);

  // Upward ray in indoor arena hits ceiling; upward ray in open-air festival hits nothing ('none')
  const arenaUp = castRayToScene({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, arenaSurfaces);
  assert.equal(arenaUp.kind, 'ceiling');

  const festivalRig = structuredClone(RIG_TEMPLATES.festival_mainstage ?? arenaRig);
  festivalRig.venue = 'festival';
  const festSurfaces = buildSceneRaySurfaces(festivalRig);
  assert.equal(festSurfaces.bounds.ceilingY, null);
  assert.equal(festSurfaces.bounds.hasPhysicalWalls, false);
  const festUp = castRayToScene({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, festSurfaces);
  assert.equal(festUp.kind, 'none');
  assert.equal(festUp.distanceM, null);
  assert.equal(festUp.point, null);
});

test('NOHD formula pins, aperture monotonicity, assumed 5 mm provenance, and unknown-is-not-safe validation', () => {
  // Exact arithmetic pins: MPE = 25.4 W/m^2
  // 5 W, 1 mrad, 5 mm -> (1/0.001)*sqrt(4*5/(pi*25.4) - 0.005^2) = 500.612 m
  const pin5w = computeLaserNohd({ opticalPowerW: 5, divergenceMrad: 1.0, beamDiameterMm: 5 });
  assert.equal(pin5w.status, 'computed');
  assert.equal(pin5w.assumedAperture, false);
  assert.equal(pin5w.canDrawZone, true);
  assert.ok(Math.abs(pin5w.nohdM - 500.612) < 0.05, `expected ~500.61 m, got ${pin5w.nohdM}`);

  // 0.5 W, 1 mrad (omitted beamDiameterMm -> assumed 5 mm): 158.236 m (and point-source bound ~158.315 m)
  const pin05wAssumed = computeLaserNohd({ opticalPowerW: 0.5, divergenceMrad: 1.0 });
  assert.equal(pin05wAssumed.status, 'assumed');
  assert.equal(pin05wAssumed.assumedAperture, true);
  assert.equal(pin05wAssumed.apertureMm, 5);
  assert.equal(pin05wAssumed.canDrawZone, true);
  assert.ok(Math.abs(pin05wAssumed.nohdM - 158.236) < 0.05, `expected ~158.24 m, got ${pin05wAssumed.nohdM}`);
  assert.ok(Math.abs(pin05wAssumed.nohdPointSourceM - 158.315) < 0.05);

  // Larger beam diameter shortens NOHD
  const wideAperture = computeLaserNohd({ opticalPowerW: 0.5, divergenceMrad: 1.0, beamDiameterMm: 100 });
  assert.equal(wideAperture.status, 'computed');
  assert.ok(wideAperture.nohdM < pin05wAssumed.nohdM - 20, `expected shorter NOHD, got ${wideAperture.nohdM}`);

  // Strict mode with omitted beam diameter returns unknown & draws no zone
  const strictMissing = computeLaserNohd({ opticalPowerW: 0.5, divergenceMrad: 1.0, allowAssumedAperture: false });
  assert.equal(strictMissing.status, 'unknown');
  assert.equal(strictMissing.nohdM, null);
  assert.equal(strictMissing.canDrawZone, false);

  // Zero, negative, missing, NaN, or unverified inputs -> unknown (never "no hazard", draws no zone)
  for (const bad of [
    { opticalPowerW: 0, divergenceMrad: 1.0, beamDiameterMm: 5 },
    { opticalPowerW: -2, divergenceMrad: 1.0, beamDiameterMm: 5 },
    { opticalPowerW: undefined, divergenceMrad: 1.0, beamDiameterMm: 5 },
    { opticalPowerW: 5, divergenceMrad: 0, beamDiameterMm: 5 },
    { opticalPowerW: 5, divergenceMrad: -1, beamDiameterMm: 5 },
    { opticalPowerW: 5, divergenceMrad: undefined, beamDiameterMm: 5 },
    { opticalPowerW: 5, divergenceMrad: 1.0, beamDiameterMm: 0 },
    { opticalPowerW: 5, divergenceMrad: 1.0, beamDiameterMm: -5 },
    { opticalPowerW: 5, divergenceMrad: 1.0, beamDiameterMm: 5, powerUnverified: true },
    { opticalPowerW: 5, divergenceMrad: 1.0, beamDiameterMm: 5, divergenceUnverified: true },
    { opticalPowerW: Number.NaN, divergenceMrad: 1.0, beamDiameterMm: 5 },
  ]) {
    const res = computeLaserNohd(bad);
    assert.equal(res.status, 'unknown', `expected unknown for ${JSON.stringify(bad)}`);
    assert.equal(res.nohdM, null);
    assert.equal(res.canDrawZone, false);
  }

  // Negative radicand (beam irradiance already below MPE at aperture) -> within-aperture, nohdM = 0, never "safe"
  const within = computeLaserNohd({ opticalPowerW: 0.001, divergenceMrad: 1.0, beamDiameterMm: 20 });
  assert.equal(within.status, 'within-aperture');
  assert.equal(within.nohdM, 0);
  assert.equal(within.canDrawZone, false);
  assert.doesNotMatch(within.reason, /\bsafe\b/i);
});

test('audience keep-out volume matches laserSafety.ts minClearanceM and validates hand-computed >38 m geometry', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const laserState = { ...INITIAL_SHOW_STATE.laser, enabled: true, intensity: 1 };
  const safety = evaluateLaserSafety(rig, laserState);
  const zones = evaluateLaserZones(rig, laserState);

  assert.equal(zones.zones.length, safety.projectors.length);
  for (let i = 0; i < safety.projectors.length; i++) {
    assert.equal(
      zones.zones[i].safety.minClearanceM,
      safety.projectors[i].minClearanceM,
      `projector ${safety.projectors[i].projectorKey} clearance parity`,
    );
  }

  // Hand-computed long-throw geometry past 38 m shader length:
  // Ray y(z) = 5 - 0.05 * z starting at (0, 5, 0) heading +Z with slope dy/dz = -0.05:
  // At z = 38 m, y = 3.10 m (> 3.0 m!), but at z = 45 m (arena audience end), y = 2.75 m (< 3.0 m!).
  const bounds = computeVenueBounds(rig);
  assert.equal(venueAudienceEndZ(rig), 45);
  assert.equal(bounds.audienceZone.maxZ, 45);
  const longThrow = intersectRayAudienceZone(
    { x: 0, y: 5, z: 0 },
    { x: 0, y: -0.05, z: 1 },
    bounds.audienceZone,
  );
  assert.equal(longThrow.enters, true);
  assert.ok(Math.abs(longThrow.minClearanceM - 2.75) < 1e-4, `expected 2.75 m at z=45, got ${longThrow.minClearanceM}`);

  // Lateral miss (outside audience X bounds) returns null clearance & enters = false
  const lateralMiss = intersectRayAudienceZone(
    { x: 50, y: 2, z: 0 },
    { x: 0, y: 0, z: 1 },
    bounds.audienceZone,
  );
  assert.equal(lateralMiss.enters, false);
  assert.equal(lateralMiss.minClearanceM, null);

  // Ray that hits the floor BEFORE reaching audienceStartZ (z = 5.5) never enters audience zone
  const earlyFloor = intersectRayAudienceZone(
    { x: 0, y: 2, z: 0 },
    { x: 0, y: -1, z: 1 }, // hits floor at z = 2.0 < 5.5
    bounds.audienceZone,
  );
  assert.equal(earlyFloor.enters, false);
  assert.equal(earlyFloor.minClearanceM, null);
});

test('measureFixtureUnit matches focusAim angles/DMX, warns within 5° of limits, and returns lux=null without photometrics', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const surfaces = buildSceneRaySurfaces(rig);

  // Compare solved pan/tilt against focusAim.aimAngles & axisDmx
  const targetLocal = { x: 2, y: -8, z: 4 };
  const solved = aimAngles(targetLocal, false, 0, 0, HEAD_PIVOT);
  const dirLen = Math.hypot(targetLocal.x, targetLocal.y + HEAD_PIVOT, targetLocal.z);
  const optics = fixtureOptics('beam');

  const sampleLegacy = {
    unitId: 'pod-front:f-ds-beams:0',
    fixtureNumber: 1,
    groupId: 'f-ds-beams',
    podId: 'pod-front',
    positionName: 'Front Truss (DS)',
    label: 'Front Truss · Beam #1',
    modelName: 'Sharpy X-Beam 350',
    type: 'beam',
    motion: 'pan-tilt',
    isFloor: false,
    mountPosition: { x: 0, y: 11.2, z: 4.5 },
    lensOrigin: { x: 0, y: 10.6, z: 4.5 },
    direction: {
      x: targetLocal.x / dirLen,
      y: (targetLocal.y + HEAD_PIVOT) / dirLen,
      z: targetLocal.z / dirLen,
    },
    panRad: solved.pan,
    tiltRad: solved.tilt,
    zoomScale: beamZoomScale('beam', 0.25),
    optics,
    configuredLumens: resolvedPhotometricLumens({ type: 'beam' }), // legacy -> null!
    appliedDimmer: 1,
    emittedVisible: true,
  };

  assert.equal(sampleLegacy.configuredLumens, null);
  const mLegacy = measureFixtureUnit(sampleLegacy, rig, surfaces);
  assert.ok(Math.abs(mLegacy.panDeg - (solved.pan * 180) / Math.PI) < 1e-6);
  assert.ok(Math.abs(mLegacy.tiltDeg - (solved.tilt * 180) / Math.PI) < 1e-6);
  assert.equal(mLegacy.panDmx, axisDmx(solved.pan, PAN_LIMIT));
  assert.equal(mLegacy.tiltDmx, axisDmx(solved.tilt, TILT_LIMIT));
  assert.equal(mLegacy.luxFullEst, null, 'legacy fixture with no photometrics must report null (n/a)');
  assert.equal(mLegacy.luxLiveEst, null);

  // Fixture with configured lumens reports positive finite lux estimate
  const mWithLux = measureFixtureUnit(
    {
      ...sampleLegacy,
      direction: { x: 0, y: -1, z: 0 },
      configuredLumens: 20375, // Robe MegaPointe verified lumens
    },
    rig,
    surfaces,
  );
  assert.ok(mWithLux.luxFullEst !== null && mWithLux.luxFullEst > 100);
  assert.equal(mWithLux.luxLiveEst, mWithLux.luxFullEst);
  assert.equal(estimateIlluminanceLux(null, 10, 10, 0, 1), null);
  assert.equal(estimateIlluminanceLux(10000, 10, 0.2, 0, 1), null);

  // Limit-proximity warnings within 5° of ±270° pan and ±135° tilt
  const mLimit = measureFixtureUnit(
    {
      ...sampleLegacy,
      panRad: (266 * Math.PI) / 180,
      tiltRad: (-131 * Math.PI) / 180,
    },
    rig,
    surfaces,
  );
  assert.equal(mLimit.nearPanLimit, true);
  assert.equal(mLimit.nearTiltLimit, true);
  assert.ok(mLimit.warnings.some((w) => w.code === 'pan_limit'));
  assert.ok(mLimit.warnings.some((w) => w.code === 'tilt_limit'));
});

test('pre-flight gate: hard blocks cannot be acked, lasers cannot be skipped, edits mark stale, and CSV matches snapshot', () => {
  // 1. Clean single-ETC-PAR rig with zero lasers and verified implemented personality -> Checks passed!
  const cleanRig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  cleanRig.floorFx = [];
  cleanRig.ledWall = { enabled: false, width: 8, height: 4, curved: false, sideWings: false };
  cleanRig.audioRig = { lineArrays: false, boxesPerSide: 0, monitorCount: 0, subWall: false, subCount: 0, djBooth: false, crowdDensity: 0.5 };
  cleanRig.trussPods = [
    {
      ...cleanRig.trussPods[0],
      width: 8,
      trussProfileId: 'prolyte-h30v',
      hoistProfileId: 'cm-lodestar-1t',
      hoistCount: 2,
      fixtures: [
        {
          id: 'par-1',
          type: 'wash',
          modelName: 'ETC ColorSource PAR',
          catalogId: 'etc-colorsource-par',
          dmxMode: '5-Ch (Default)',
          dmxChannels: 5,
          count: 2,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
      ],
    },
  ];
  const cleanShow = {
    ...INITIAL_SHOW_STATE,
    laser: { ...INITIAL_SHOW_STATE.laser, enabled: false, audienceScan: false },
  };

  // Before running check -> Not checked, cannot arm
  const unchecked = evaluatePreflight({ rig: cleanRig, cues: [], showState: cleanShow, acks: EMPTY_PREFLIGHT_ACKS });
  assert.equal(unchecked.overallStatus, 'not_checked');
  assert.equal(unchecked.badgeLabel, 'Not checked');
  assert.equal(unchecked.canArm, false);

  // After running check -> Checks passed, canArm true (never says "Ready" or "safe")
  const checkedAcks = { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: unchecked.configRevision };
  const passed = evaluatePreflight({ rig: cleanRig, cues: [], showState: cleanShow, acks: checkedAcks });
  assert.equal(passed.overallStatus, 'passed');
  assert.equal(passed.badgeLabel, 'Checks passed');
  assert.equal(passed.canArm, true);

  // 2. Moving a fixture invalidates revision -> stale & canArm false
  const movedRig = structuredClone(cleanRig);
  movedRig.trussPods[0].z += 1.5;
  const stale = evaluatePreflight({ rig: movedRig, cues: [], showState: cleanShow, acks: checkedAcks });
  assert.equal(stale.stale, true);
  assert.equal(stale.canArm, false);
  assert.notEqual(stale.configRevision, passed.configRevision);

  // 3. Patch conflict -> hard block, cannot be acknowledged away
  const conflictRig = structuredClone(cleanRig);
  conflictRig.trussPods[0].fixtures.push({
    ...conflictRig.trussPods[0].fixtures[0],
    id: 'par-2',
    dmxStartChannel: 2, // overlaps ch 1..5
  });
  const conflictRev = computePreflightRevision({ rig: conflictRig, cues: [], showState: cleanShow });
  const conflictReport = evaluatePreflight({
    rig: conflictRig,
    cues: [],
    showState: cleanShow,
    acks: { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: conflictRev },
  });
  assert.equal(conflictReport.overallStatus, 'blocked');
  assert.equal(conflictReport.canArm, false);
  assert.ok(conflictReport.rows.some((r) => r.hardBlock && r.outcome === 'fail'));

  // 3b. Explicitly configured undersized electrical feeder -> hard block!
  const feederOverloadRig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  feederOverloadRig.power = { system: 'us_208_3p', feederA: 60 };
  const revFeeder = computePreflightRevision({ rig: feederOverloadRig, cues: [], showState: cleanShow });
  const feederReport = evaluatePreflight({
    rig: feederOverloadRig,
    cues: [],
    showState: cleanShow,
    acks: { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: revFeeder },
  });
  assert.equal(feederReport.overallStatus, 'blocked');
  assert.equal(feederReport.canArm, false);
  assert.ok(feederReport.rows.some((r) => r.id === 'power:summary' && r.hardBlock && r.outcome === 'fail'));

  // 4. Laser projector cannot be skipped; unknown laser must be inhibited; audienceScan is always a hard fail
  const laserRig = structuredClone(cleanRig);
  laserRig.trussPods[0].fixtures.push({
    id: 'las-1',
    type: 'laser',
    modelName: 'KVANT Clubmax 6000 FB4',
    catalogId: 'kvant-clubmax',
    dmxMode: 'FB4 16-Ch (FB3 Profile)',
    dmxChannels: 16,
    count: 1,
    dmxUniverse: 2,
    dmxStartChannel: 1,
  });
  const revLaser = computePreflightRevision({ rig: laserRig, cues: [], showState: cleanShow });
  const laserUnacked = evaluatePreflight({
    rig: laserRig,
    cues: [],
    showState: cleanShow,
    acks: { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: revLaser },
  });
  assert.equal(laserUnacked.canArm, false, 'laser projector cannot be skipped');
  const laserRow = laserUnacked.rows.find((r) => r.isLaser);
  assert.ok(laserRow && laserRow.projectorKey);
  assert.equal(laserRow.requiresLaserInhibit, false, 'overhead KVANT Clubmax at 11.2m clears 3m with assumed aperture');

  // Explicitly acknowledging the laser unlocks arming, while status remains "N warnings" (never "Checks passed")
  const laserAcked = evaluatePreflight({
    rig: laserRig,
    cues: [],
    showState: cleanShow,
    acks: {
      ...EMPTY_PREFLIGHT_ACKS,
      checked: true,
      checkedRevision: revLaser,
      acknowledgedLasers: { [laserRow.projectorKey]: laserRow.rowFingerprint },
    },
  });
  assert.equal(laserAcked.canArm, true);
  assert.equal(laserAcked.overallStatus, 'warnings');
  assert.match(laserAcked.badgeLabel, /warning/);

  // Enabling audienceScan is a hard block even if laser was previously acknowledged or inhibited
  const crowdScanShow = { ...cleanShow, laser: { ...cleanShow.laser, audienceScan: true } };
  const revCrowd = computePreflightRevision({ rig: laserRig, cues: [], showState: crowdScanShow });
  const crowdBlocked = evaluatePreflight({
    rig: laserRig,
    cues: [],
    showState: crowdScanShow,
    acks: {
      ...EMPTY_PREFLIGHT_ACKS,
      checked: true,
      checkedRevision: revCrowd,
      inhibitedLasers: { [laserRow.projectorKey]: revCrowd },
    },
  });
  assert.equal(crowdBlocked.overallStatus, 'blocked');
  assert.equal(crowdBlocked.canArm, false);

  // 5. Commissioning record CSV consistency + formula neutralization
  const csv = commissioningRecordCsv(laserAcked, {
    ...EMPTY_PREFLIGHT_ACKS,
    checked: true,
    checkedRevision: revLaser,
    acknowledgedLasers: { [laserRow.projectorKey]: laserRow.rowFingerprint },
  }, {
    rigName: '=cmd|test',
    venue: 'arena',
    testerName: '+Tester',
    date: '2026-11-25',
  });
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('Row ID,Category,Item,Location,Outcome,Hard Block,Operator Action,Summary'));
  assert.ok(csv.includes('Laser acknowledged'));
  assert.ok(csv.includes("'=cmd|test"), 'formula-like rig name must be neutralized');
  assert.ok(csv.includes("'+Tester"), 'formula-like tester name must be neutralized');

  // 6. Reach map distinguishes pan-tilt polygons from fixed PARs
  const reach = computeReachMap(cleanRig);
  assert.ok(reach.areas.some((a) => a.motion === 'fixed' && a.points.length === 0));
  const arenaReach = computeReachMap(RIG_TEMPLATES.arena_mainstage);
  assert.ok(arenaReach.unionPolygon.length === 4);
});

test('QA Pass 1 regressions: C1 sticky inhibit, H1 static beam clearance, H2 cue lasers, H3 revision split, M1/M2/M4/M7/L1/L2/L6', () => {
  const cleanRig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  cleanRig.floorFx = [];
  cleanRig.ledWall = { enabled: false, width: 8, height: 4, curved: false, sideWings: false };
  cleanRig.audioRig = { lineArrays: false, boxesPerSide: 0, monitorCount: 0, subWall: false, subCount: 0, djBooth: false, crowdDensity: 0.5 };
  cleanRig.trussPods = [
    {
      ...cleanRig.trussPods[0],
      width: 10,
      z: 3.5,
      baseY: 11.2,
      trussProfileId: 'prolyte-h30v',
      hoistProfileId: 'cm-lodestar-1t',
      hoistCount: 2,
      fixtures: [
        {
          id: 'beam-1',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 1 (Standard 16-bit)',
          dmxChannels: 39,
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
        {
          id: 'las-1',
          type: 'laser',
          modelName: 'KVANT Clubmax 6000 FB4',
          catalogId: 'kvant-clubmax',
          dmxMode: 'FB4 16-Ch (FB3 Profile)',
          dmxChannels: 16,
          count: 1,
          dmxUniverse: 2,
          dmxStartChannel: 1,
        },
      ],
    },
  ];
  const baseShow = {
    ...INITIAL_SHOW_STATE,
    focusMarkId: undefined,
    movementMode: 'manual',
    manualPan: 0,
    manualTilt: 0,
    laser: { ...INITIAL_SHOW_STATE.laser, enabled: false, audienceScan: false, tilt: 0.25, spreadY: 0.1 },
  };

  // C1: Session-sticky laser inhibit survives rig edits and cue Go (never silently dropped on stale revision)
  const rev0 = computePreflightRevision({ rig: cleanRig, cues: [], showState: baseShow });
  const initRep = evaluatePreflight({ rig: cleanRig, cues: [], showState: baseShow, acks: EMPTY_PREFLIGHT_ACKS });
  const lasKey = initRep.rows.find((r) => r.isLaser)?.projectorKey;
  assert.ok(lasKey);
  const acksWithInhibit = {
    ...EMPTY_PREFLIGHT_ACKS,
    checked: true,
    checkedRevision: rev0,
    inhibitedLasers: { [lasKey]: rev0 },
  };
  const movedRig = structuredClone(cleanRig);
  movedRig.trussPods[0].z += 1.0;
  const staleRep = evaluatePreflight({ rig: movedRig, cues: [], showState: baseShow, acks: acksWithInhibit });
  assert.equal(staleRep.stale, true);
  assert.equal(staleRep.canArm, false);
  assert.ok(staleRep.inhibitedLaserKeys.includes(lasKey), 'C1: inhibited laser must remain inhibited across stale config revision');

  // H1: Static moving-head audience clearance reaches pre-flight WITHOUT liveMeasurements or Measure overlay
  const crowdAimShow = { ...baseShow, focusMarkId: 'audience' };
  const staticMeasures = evaluateStaticHeadMeasures(cleanRig, crowdAimShow);
  assert.ok(staticMeasures.some((m) => m.entersAudienceBelowThreshold), 'H1: static head aimed at audience must flag clearance');
  const h1Rep = evaluatePreflight({ rig: cleanRig, cues: [], showState: crowdAimShow, acks: EMPTY_PREFLIGHT_ACKS });
  const beamRow = h1Rep.rows.find((r) => r.groupId === 'beam-1');
  assert.ok(beamRow, 'beam fixture row present');
  assert.ok(
    beamRow.findings.some((f) => f.code === 'beam_audience_clearance'),
    'H1: pre-flight fixture row must include beam_audience_clearance statically without Measure overlay',
  );

  // H2: Cue with low laser tilt or audienceScan blocks arming unless laser is inhibited (never mere acknowledgeable warn)
  const lowTiltCue = {
    id: 'cue-low',
    name: 'Low Laser Dip',
    tag: 'TEST',
    accent: '#ff0000',
    state: { laser: { ...baseShow.laser, enabled: true, tilt: -0.65, spreadY: 0.9, audienceScan: false } },
  };
  const revH2Tilt = computePreflightRevision({ rig: cleanRig, cues: [lowTiltCue], showState: baseShow });
  const h2TiltRep = evaluatePreflight({
    rig: cleanRig,
    cues: [lowTiltCue],
    showState: baseShow,
    acks: { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: revH2Tilt, acknowledgedLasers: { [lasKey]: revH2Tilt } },
  });
  const h2TiltLaser = h2TiltRep.rows.find((r) => r.isLaser);
  assert.equal(h2TiltLaser?.outcome, 'fail');
  assert.equal(h2TiltLaser?.requiresLaserInhibit, true, 'H2: cue dipping laser below 3m must require inhibit or fix');
  assert.equal(h2TiltRep.canArm, false);

  const crowdScanCue = {
    id: 'cue-cs',
    name: 'Crowd Scan Cue',
    tag: 'TEST',
    accent: '#ff0000',
    state: { laser: { ...baseShow.laser, enabled: true, audienceScan: true } },
  };
  const revH2Cs = computePreflightRevision({ rig: cleanRig, cues: [crowdScanCue], showState: baseShow });
  const h2CsRep = evaluatePreflight({
    rig: cleanRig,
    cues: [crowdScanCue],
    showState: baseShow,
    acks: { ...EMPTY_PREFLIGHT_ACKS, checked: true, checkedRevision: revH2Cs, acknowledgedLasers: { [lasKey]: revH2Cs } },
  });
  const h2CsLaser = h2CsRep.rows.find((r) => r.isLaser);
  assert.equal(h2CsLaser?.outcome, 'fail');
  assert.equal(h2CsLaser?.requiresLaserInhibit, true, 'H2: cue audienceScan must block ack and require fix or inhibit');
  assert.equal(h2CsRep.canArm, false);

  // H3: Editing a cue's manualPan or movingGroups marks pre-flight stale, while cue Go (changing showState only) does NOT
  const cueA = {
    id: 'cue-a',
    name: 'Cue A',
    tag: 'A',
    accent: '#00ffff',
    state: { manualPan: 0.1, manualTilt: 0.1, movingGroups: { beam: { manualPan: 0.2 } } },
  };
  const revCueA = computePreflightRevision({ rig: cleanRig, cues: [cueA], showState: baseShow });
  const cueAEdited = {
    ...cueA,
    state: { ...cueA.state, manualPan: 0.45, movingGroups: { beam: { manualPan: 0.7 } } },
  };
  const revCueAEdited = computePreflightRevision({ rig: cleanRig, cues: [cueAEdited], showState: baseShow });
  assert.notEqual(revCueAEdited, revCueA, 'H3: editing cue manualPan/movingGroups must change configRevision');
  const revAfterGo = computePreflightRevision({
    rig: cleanRig,
    cues: [cueA],
    showState: { ...baseShow, manualPan: 0.1, movementMode: 'sweep' },
  });
  assert.equal(revAfterGo, revCueA, 'H3: runtime showState change on cue Go must not falsely mark authored revision stale');

  // M1: Festival lateral ray at x = 45 m, z = 20..40 m, y = 1 m is caught over full ±70 m open-air floor
  const festBounds = computeVenueBounds(RIG_TEMPLATES.festival_mega);
  assert.equal(festBounds.audienceZone.minX, -70);
  assert.equal(festBounds.audienceZone.maxX, 70);
  const lateralHit = intersectRayAudienceZone(
    { x: 45, y: 1.0, z: 15 },
    { x: 0, y: 0, z: 1 },
    festBounds.audienceZone,
    Infinity,
  );
  assert.equal(lateralHit.enters, true, 'M1: festival ray at x=45, y=1 over z=20..40 must enter audience zone');
  assert.ok(lateralHit.minClearanceM !== null && lateralHit.minClearanceM < 1.1);

  // M2: 40° wash whose center axis crosses audience at 3.2 m still flags lower cone edge (< 3.0 m)
  const surfaces = buildSceneRaySurfaces(RIG_TEMPLATES.arena_mainstage);
  const dirLen = Math.hypot(0, -6.8, 12);
  const washSample = {
    unitId: 'pod-mid:wash-test:0',
    fixtureNumber: 1,
    groupId: 'wash-test',
    podId: 'pod-mid',
    positionName: 'Center',
    label: 'Wide Wash #1',
    modelName: 'Wide Wash',
    type: 'wash',
    motion: 'pan-tilt',
    isFloor: false,
    mountPosition: { x: 0, y: 10.0, z: 0 },
    lensOrigin: { x: 0, y: 10.0, z: 0 },
    // Axis passes through (0, 3.2, 12) and hits floor at z = 17.65; wait — make axis horizontal at y = 3.2 m over audience!
    direction: { x: 0, y: 0, z: 1 },
    panRad: 0,
    tiltRad: -Math.PI / 2,
    zoomScale: 1,
    optics: { length: 10, nearRadius: 0.1, farRadius: 0.1 + 10 * Math.tan((20 * Math.PI) / 180) }, // 40° full beam angle
    configuredLumens: null,
    appliedDimmer: 1,
    emittedVisible: true,
  };
  // Horizontal axis at y = 3.2 m clears 3.0 m, but 40° cone (20° half-angle) dips well below 3.0 m over audience!
  const mWash = measureFixtureUnit(
    { ...washSample, lensOrigin: { x: 0, y: 3.2, z: 4.0 }, mountPosition: { x: 0, y: 3.5, z: 4.0 } },
    RIG_TEMPLATES.arena_mainstage,
    surfaces,
  );
  assert.equal(mWash.entersAudienceBelowThreshold, true, 'M2: 40° wash with axis at 3.2 m must flag lower cone edge < 3.0 m');
  assert.ok(mWash.warnings.some((w) => w.code === 'audience_clearance'));
  void dirLen;

  // M4 + L4: Floor moving head has valid stage-deck reach polygon in unionPolygon, and sequential fixtureNumber excludes lasers
  const floorReachRig = structuredClone(cleanRig);
  floorReachRig.trussPods[0].fixtures = [
    floorReachRig.trussPods[0].fixtures[1], // laser first in placements
    floorReachRig.trussPods[0].fixtures[0], // moving head second in placements
  ];
  floorReachRig.floorFx = [
    { id: 'fx-fb', type: 'floor_beam', modelName: 'MegaPointe Floor Beam', count: 1, x: 0, z: -2, spread: 4, dmxUniverse: 2, dmxStartChannel: 50 },
  ];
  const floorReach = computeReachMap(floorReachRig);
  assert.equal(floorReach.areas.length, 2);
  assert.equal(floorReach.areas[0].fixtureNumber, 1, 'L4: fixtureNumber must count moving heads sequentially, skipping lasers');
  assert.equal(floorReach.areas[1].fixtureNumber, 2);
  assert.equal(floorReach.areas[1].kind, 'polygon', 'M4: floor moving head must produce a stage-deck reach polygon');
  assert.ok(floorReach.areas[1].points.length >= 16);

  // M7: CSV action strings match commissioningActionLabel 1:1 and CSV summary Hard Block is NO when only warnings are pending
  const warnOnlyRep = evaluatePreflight({ rig: cleanRig, cues: [], showState: baseShow, acks: EMPTY_PREFLIGHT_ACKS });
  assert.equal(warnOnlyRep.rows.some((r) => r.hardBlock), false);
  const warnCsv = commissioningRecordCsv(warnOnlyRep, EMPTY_PREFLIGHT_ACKS, {
    rigName: 'Test Rig',
    venue: 'arena',
    testerName: 'Pat Tech',
    date: '2026-11-25',
  });
  for (const row of warnOnlyRep.rows) {
    assert.ok(
      warnCsv.includes(commissioningActionLabel(row, warnOnlyRep, EMPTY_PREFLIGHT_ACKS)),
      `M7: CSV must match commissioningActionLabel for ${row.id}`,
    );
  }
  const summaryLine = warnCsv.trim().split(/\r?\n/).at(-1) ?? '';
  assert.ok(summaryLine.includes(',NO,Arming disabled'), `M7: summary Hard Block must be NO when no hard blocks exist; got ${summaryLine}`);

  // L1: Near-grazing blow-up returns grazing:true with minorDiameterM = null and majorDiameterM = null
  const nearGrazing = computeBeamFootprint(10, 10, 84.99);
  assert.equal(nearGrazing.grazing, true);
  assert.equal(nearGrazing.majorDiameterM, null);
  assert.equal(nearGrazing.minorDiameterM, null);

  // L2: hashIldaClipContent detects single-point edits beyond index 256 (no striding)
  const xy1 = new Float32Array(600 * 2);
  const blank1 = new Uint8Array(600);
  const clip1 = {
    name: 'dense.ild',
    frames: [{ offset: 0, count: 600, litCount: 600 }],
    totalPoints: 600,
    xy: xy1,
    rgb: new Uint8Array(600 * 3),
    blank: blank1,
    warnings: [],
  };
  const xy2 = new Float32Array(xy1);
  xy2[257 * 2] = 1234;
  const clip2 = { ...clip1, xy: xy2 };
  assert.notEqual(hashIldaClipContent(clip1), hashIldaClipContent(clip2), 'L2: unsampled point edit >256 must change ILDA hash');

  // L6: within-aperture NOHD wording avoids "threshold not exceeded" / "safe" and mandates LSO assessment
  const within = computeLaserNohd({ opticalPowerW: 0.0001, divergenceMrad: 1, beamDiameterMm: 10 });
  assert.equal(within.status, 'within-aperture');
  assert.doesNotMatch(within.reason, /threshold not exceeded|safe/i);
  assert.match(within.reason, /LSO/i);

  // QA Pass 2 regressions:
  // P2-H1: Motorized pod lowest trim (`motorMinY`) is included in worst-case laser evaluation
  const motorDropRig = structuredClone(cleanRig);
  motorDropRig.trussPods[0].motorized = true;
  motorDropRig.trussPods[0].baseY = 11.2;
  motorDropRig.trussPods[0].motorMinY = 2.6; // drops below 3.0 m!
  const motorDropRep = evaluatePreflight({ rig: motorDropRig, cues: [], showState: baseShow, acks: EMPTY_PREFLIGHT_ACKS });
  const motorLaserRow = motorDropRep.rows.find((r) => r.isLaser);
  assert.equal(motorLaserRow?.outcome, 'fail');
  assert.equal(motorLaserRow?.requiresLaserInhibit, true, 'P2-H1: motorized pod dropping to motorMinY < 3m must require laser inhibit');

  // P2-M1: Runtime laser look change that alters findings invalidates prior laser rowFingerprint ack
  const revClean = computePreflightRevision({ rig: cleanRig, cues: [], showState: baseShow });
  const repHighTilt = evaluatePreflight({
    rig: cleanRig,
    cues: [],
    showState: { ...baseShow, laser: { ...baseShow.laser, tilt: 0.85, spreadY: 0.05 } },
    acks: EMPTY_PREFLIGHT_ACKS,
  });
  const highRow = repHighTilt.rows.find((r) => r.isLaser);
  assert.ok(highRow && highRow.projectorKey);
  const repChangedLook = evaluatePreflight({
    rig: cleanRig,
    cues: [],
    showState: { ...baseShow, laser: { ...baseShow.laser, tilt: 0.15, spreadY: 0.4 } },
    acks: {
      ...EMPTY_PREFLIGHT_ACKS,
      checked: true,
      checkedRevision: revClean,
      acknowledgedLasers: { [highRow.projectorKey]: highRow.rowFingerprint },
    },
  });
  const changedRow = repChangedLook.rows.find((r) => r.isLaser);
  assert.notEqual(changedRow?.rowFingerprint, highRow.rowFingerprint, 'P2-M1: runtime laser finding change must change rowFingerprint');
  assert.equal(repChangedLook.canArm, false, 'P2-M1: stale laser rowFingerprint ack must not allow arming');

  // P2-L5: Cue-authored moving-head focus/aim reaches pre-flight statically
  const crowdHeadCue = {
    id: 'cue-head-crowd',
    name: 'Crowd Spot',
    tag: 'SPOT',
    accent: '#ffffff',
    state: { focusMarkId: 'audience' },
  };
  const cueHeadRep = evaluatePreflight({ rig: cleanRig, cues: [crowdHeadCue], showState: baseShow, acks: EMPTY_PREFLIGHT_ACKS });
  const cueBeamRow = cueHeadRep.rows.find((r) => r.groupId === 'beam-1');
  assert.ok(
    cueBeamRow?.findings.some((f) => f.code === 'beam_audience_clearance'),
    'P2-L5: cue-authored audience focus must raise beam_audience_clearance statically in pre-flight',
  );
});
