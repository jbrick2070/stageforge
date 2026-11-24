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

const {
  CATALOG_BY_ID,
  CATALOG_ID_PATTERN,
  DEFAULT_LED_PANEL_ID,
  EQUIPMENT_CATALOG,
  LEGACY_DEFAULTS,
  catalogForRenderType,
  catalogLedPanels,
  checkCatalogChannelDrift,
  formatCatalogSpecBadges,
  getCatalogEntry,
  getCatalogMode,
  hasCatalogFixtures,
} = await compiler.ssrLoadModule('/src/data/equipmentCatalog.ts');
const { addPatchedUnits, allocateDmx, buildDmxPatch, groupFootprint, repatchGroup, writeDmxChannels } =
  await compiler.ssrLoadModule('/src/data/dmxPatch.ts');
const { aerialGain, catalogOptics, fixtureOptics, MAX_AERIAL_GAIN, REFERENCE_OPTICS, resolveOptics } =
  await compiler.ssrLoadModule('/src/data/fixtureOptics.ts');
const { calculateProductionEstimate } = await compiler.ssrLoadModule('/src/data/productionEstimator.ts');
const { FIXTURE_CATALOG, FLOOR_FX_CATALOG, RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { pruneInterchangeFixtureSpecs } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');

const ALL_HARDWARE_TYPES = new Set([...Object.keys(FIXTURE_CATALOG), ...Object.keys(FLOOR_FX_CATALOG)]);

function getByPath(obj, path) {
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const token of tokens) {
    if (cur === undefined || cur === null || !(token in cur)) return { exists: false, value: undefined };
    cur = cur[token];
  }
  return { exists: true, value: cur };
}

function rigWith(fixtures = [], floorFx = []) {
  const rig = createBlankDesign();
  rig.trussPods = [
    {
      id: 'p1',
      name: 'Front truss',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 6,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 6,
      motorMaxY: 6,
      fixtures,
    },
  ];
  rig.floorFx = floorFx;
  return rig;
}

test('equipment catalogue entries are unique, well-formed, sourced in docs/equipment.md, and cover all legacy defaults', async () => {
  const docs = await readFile(new URL('../docs/equipment.md', import.meta.url), 'utf8');
  const seen = new Set();

  for (const entry of EQUIPMENT_CATALOG) {
    assert.match(entry.id, CATALOG_ID_PATTERN, `${entry.id} matches catalogId pattern`);
    assert.ok(!seen.has(entry.id), `duplicate catalogId ${entry.id}`);
    seen.add(entry.id);
    assert.equal(CATALOG_BY_ID.get(entry.id), entry);
    assert.ok(entry.manufacturer.trim().length > 0, `${entry.id} manufacturer`);
    assert.ok(entry.model.trim().length > 0, `${entry.id} model`);
    assert.ok(docs.includes(`\`${entry.id}\``), `${entry.id} documented in docs/equipment.md`);

    if (entry.category === 'led_panel') {
      assert.equal(entry.renderTypes.length, 0, `${entry.id} led_panel has no renderTypes`);
      assert.equal(entry.modes.length, 0, `${entry.id} led_panel has no DMX modes`);
      assert.ok(entry.panel, `${entry.id} led_panel defines panel geometry`);
      assert.ok(entry.panel.widthMm >= 50 && entry.panel.widthMm <= 2000);
      assert.ok(entry.panel.heightMm >= 50 && entry.panel.heightMm <= 2000);
      assert.ok(entry.panel.pixelsWide >= 1 && entry.panel.pixelsHigh >= 1);
    } else {
      assert.ok(entry.renderTypes.length >= 1, `${entry.id} has renderTypes`);
      for (const rt of entry.renderTypes) {
        assert.ok(ALL_HARDWARE_TYPES.has(rt), `${entry.id} valid renderType ${rt}`);
      }
      assert.ok(entry.modes.length >= 1, `${entry.id} has >= 1 DMX mode`);
      const modeNames = new Set();
      entry.modes.forEach((m, idx) => {
        assert.ok(m.name.trim().length > 0 && m.name.length <= 64, `${entry.id} mode[${idx}] name`);
        assert.ok(!modeNames.has(m.name), `${entry.id} unique mode name ${m.name}`);
        modeNames.add(m.name);
        assert.ok(Number.isInteger(m.channels) && m.channels >= 1 && m.channels <= 512, `${entry.id} mode[${idx}] channels`);
      });
    }

    // Every source ID must be cited in docs/equipment.md.
    for (const src of entry.sources) {
      assert.ok(docs.includes(`- \`${src}\`:`), `source ${src} cited in docs/equipment.md`);
    }

    // Every unverified path must point to a real existing field on the entry and appear in docs/equipment.md.
    const unverifiedSet = new Set(entry.unverified);
    assert.equal(unverifiedSet.size, entry.unverified.length, `${entry.id} duplicate unverified path`);
    for (const fieldPath of entry.unverified) {
      const resolved = getByPath(entry, fieldPath);
      assert.ok(resolved.exists && resolved.value !== undefined, `${entry.id} unverified path "${fieldPath}" must exist`);
      assert.ok(docs.includes(`\`${fieldPath}\``), `${entry.id} unverified path "${fieldPath}" listed in docs/equipment.md`);
    }

    // Every numeric field present must either have at least one source or be flagged in unverified.
    const numericPaths = [];
    if (entry.weightKg !== undefined) numericPaths.push('weightKg');
    if (entry.powerW !== undefined) numericPaths.push('powerW');
    if (entry.optics?.lumens !== undefined) numericPaths.push('optics.lumens');
    if (entry.optics?.zoomDeg !== undefined) numericPaths.push('optics.zoomDeg');
    if (entry.optics?.beamDeg !== undefined) numericPaths.push('optics.beamDeg');
    entry.modes.forEach((_m, idx) => numericPaths.push(`modes[${idx}].channels`));
    for (const path of numericPaths) {
      const backed = entry.sources.length > 0 || unverifiedSet.has(path);
      assert.ok(backed, `${entry.id}.${path} must be backed by a source or marked unverified`);
    }

    // Smoke check spec badge formatter.
    const badges = formatCatalogSpecBadges(entry);
    assert.ok(badges.length > 0, `${entry.id} formats spec badges`);
  }

  // Every legacy hardware type maps to a real catalogue entry that allows that type.
  for (const type of ALL_HARDWARE_TYPES) {
    const id = LEGACY_DEFAULTS[type];
    const entry = getCatalogEntry(id);
    assert.ok(entry, `LEGACY_DEFAULTS.${type} (${id}) exists`);
    assert.ok(entry.renderTypes.includes(type), `LEGACY_DEFAULTS.${type} (${id}) allows ${type}`);
    assert.ok(catalogForRenderType(type).length >= 1, `catalogForRenderType(${type}) non-empty`);
  }
  assert.ok(getCatalogEntry(DEFAULT_LED_PANEL_ID)?.category === 'led_panel');
  assert.ok(catalogLedPanels().length >= 2);
});

test('repatchGroup keeps address when space fits, moves when needed, rejects when full, and never merges mismatched models', () => {
  const beams = { id: 'g1', type: 'beam', modelName: 'Sharpy X-Beam 350', count: 4, dmxUniverse: 1, dmxStartChannel: 1 }; // 1..64
  const blocker = { id: 'g2', type: 'strobe', modelName: 'Atomic Pro JDC-1', count: 1, dmxUniverse: 1, dmxStartChannel: 65 }; // 65..72
  const rig = rigWith([beams, blocker]);

  // 1. Keep address: Claypaky Sharpy 16-ch fits in 1..64 right in place.
  const keep = repatchGroup(rig, beams, {
    modelName: 'Claypaky Sharpy',
    catalogId: 'claypaky-sharpy',
    dmxMode: 'Standard',
    dmxChannels: 16,
  });
  assert.equal(keep.ok, true);
  assert.equal(keep.moved, false);
  assert.equal(keep.group.dmxUniverse, 1);
  assert.equal(keep.group.dmxStartChannel, 1);
  assert.equal(groupFootprint(keep.group), 16);

  // 2. Move: switching to Robe MegaPointe 39-ch × 4 = 156 ch collides with blocker at 65, so relocates to U1.73.
  const move = repatchGroup(rig, beams, {
    modelName: 'Robe MegaPointe',
    catalogId: 'robe-megapointe',
    dmxMode: 'Mode 1 (Standard 16-bit)',
    dmxChannels: 39,
  });
  assert.equal(move.ok, true);
  assert.equal(move.moved, true);
  assert.equal(move.group.dmxUniverse, 1);
  assert.equal(move.group.dmxStartChannel, 73);
  assert.equal(groupFootprint(move.group), 39);

  // 3. Reject when no free contiguous block exists across U1–U2.
  const fullU1 = { id: 'u1', type: 'beam', modelName: 'Fill U1', count: 24, dmxUniverse: 1, dmxStartChannel: 129 }; // 129..512
  const fullU2 = { id: 'u2', type: 'beam', modelName: 'Fill U2', count: 30, dmxUniverse: 2, dmxStartChannel: 1 }; // 1..480 (only 32 free)
  const packedRig = rigWith([beams, blocker, fullU1, fullU2]);
  const reject = repatchGroup(packedRig, beams, {
    modelName: 'Robe MegaPointe',
    catalogId: 'robe-megapointe',
    dmxMode: 'Mode 1 (Standard 16-bit)',
    dmxChannels: 39,
  });
  assert.equal(reject.ok, false);
  assert.match(reject.reason, /Not enough free channels/);

  // 4. Returning to Generic clears catalogId/dmxMode/dmxChannels cleanly.
  const movedRig = rigWith([move.group, blocker]);
  const backGeneric = repatchGroup(movedRig, move.group, {
    modelName: 'Sharpy X-Beam 350',
    catalogId: undefined,
    dmxMode: undefined,
    dmxChannels: undefined,
  });
  assert.equal(backGeneric.ok, true);
  assert.equal('catalogId' in backGeneric.group, false);
  assert.equal('dmxMode' in backGeneric.group, false);
  assert.equal('dmxChannels' in backGeneric.group, false);

  // 5. addPatchedUnits never merges a generic or different-mode addition into a catalogue group.
  const sharpy = keep.group;
  const genericAddition = { id: 'b-gen', type: 'beam', modelName: 'Sharpy X-Beam 350', count: 2, dmxUniverse: 1, dmxStartChannel: 1 };
  const afterGeneric = addPatchedUnits(rigWith([sharpy]), [sharpy], genericAddition, sharpy);
  assert.equal(afterGeneric.length, 2, 'generic addition must not merge into catalogue group');
  assert.equal(afterGeneric[0].count, 4);
  assert.equal(afterGeneric[1].count, 2);

  const vectorAddition = {
    id: 'b-vec',
    type: 'beam',
    modelName: 'Claypaky Sharpy',
    catalogId: 'claypaky-sharpy',
    dmxMode: 'Vector',
    dmxChannels: 20,
    count: 1,
    dmxUniverse: 1,
    dmxStartChannel: 1,
  };
  const afterDiffMode = addPatchedUnits(rigWith([sharpy]), [sharpy], vectorAddition, sharpy);
  assert.equal(afterDiffMode.length, 2, 'different DMX mode must not merge');

  const sameAddition = { ...sharpy, id: 'b-same', count: 1 };
  const afterSame = addPatchedUnits(rigWith([sharpy]), [sharpy], sameAddition, sharpy);
  assert.equal(afterSame.length, 1, 'identical catalogId/mode/channels extends in place');
  assert.equal(afterSame[0].count, 5);

  // 6. allocateDmx respects custom dmxChannels and buildDmxPatch detects real-footprint overlaps.
  const megaPatch = buildDmxPatch(movedRig);
  const megaRow = megaPatch.rows.find((r) => r.group === move.group);
  assert.equal(megaRow.width, 39);
  assert.equal(megaRow.end, 73 + 39 * 4 - 1);
  assert.deepEqual(megaRow.conflicts, []);
  const nextAlloc = allocateDmx(movedRig, { type: 'beam', dmxChannels: 48 }, 2, 1);
  assert.deepEqual(nextAlloc, { dmxUniverse: 1, dmxStartChannel: 73 + 39 * 4, extendsGroup: false });
});

test('resolveOptics preserves legacy groups verbatim, derives catalogue defaults, lets user overrides win, and guards Data L9 edge cases', () => {
  // REFERENCE_OPTICS stays synced to catalogue entries.
  assert.deepEqual(
    REFERENCE_OPTICS.map((r) => [r.fixture, r.lumens, r.beamAngle]),
    [
      ['Rogue R1 BeamWash', 1483, 4],
      ['MAC Aura XIP', 6000, 35.3],
    ],
  );

  // Legacy groups return group.optics verbatim (including undefined).
  const legacyGroup = { type: 'beam' };
  assert.equal(resolveOptics(legacyGroup), undefined);
  const legacyWithOverride = { type: 'wash', optics: { lumens: 7500 } };
  assert.equal(resolveOptics(legacyWithOverride), legacyWithOverride.optics);

  // Catalogue defaults: narrow end for beam/floor_beam, wide end for wash.
  const megaBeam = resolveOptics({ type: 'beam', catalogId: 'robe-megapointe' });
  assert.equal(megaBeam.profile.lumens, 20375);
  assert.equal(megaBeam.profile.beamAngle, 1.8);
  const auraXip = resolveOptics({ type: 'wash', catalogId: 'martin-mac-aura-xip' });
  assert.equal(auraXip.profile.lumens, 6000);
  assert.equal(auraXip.profile.beamAngle, 35.3);
  // Catalogue entry without lumens (Sharpy) does not invent a lumen figure and uses verified 3.8 deg (M3).
  const sharpyOptics = catalogOptics('claypaky-sharpy', 'beam');
  assert.equal(sharpyOptics.profile.lumens, undefined);
  assert.equal(sharpyOptics.profile.beamAngle, 3.8);
  assert.ok(fixtureOptics('beam', sharpyOptics).gain < 100, 'Sharpy gain stays realistic');

  // M3 regression: every catalogue moving-head entry resolves to a finite, realistic gain (< 1000).
  for (const entry of EQUIPMENT_CATALOG) {
    for (const rt of entry.renderTypes) {
      if (rt !== 'beam' && rt !== 'wash' && rt !== 'floor_beam') continue;
      const kind = rt === 'wash' ? 'wash' : 'beam';
      const resolved = resolveOptics({ type: rt, catalogId: entry.id });
      const opt = fixtureOptics(kind, resolved);
      assert.ok(Number.isFinite(opt.gain) && opt.gain > 0 && opt.gain < 1000, `${entry.id} (${rt}) gain=${opt.gain}`);
    }
  }

  // User override wins over catalogue defaults.
  const overridden = resolveOptics({ type: 'beam', catalogId: 'robe-megapointe', optics: { lumens: 9000 } });
  assert.equal(overridden.lumens, 9000);
  assert.equal(overridden.profile.beamAngle, 1.8);

  // Data L9 & L2: empty `{}` keeps legacy exposure (zoomSlope === 0), extreme valid values stay uncapped, NaN/0 stay finite.
  const emptyObj = fixtureOptics('beam', {});
  assert.equal(emptyObj.zoomSlope, 0);
  assert.equal(aerialGain(emptyObj, 0.5), 1);
  const validExtreme = fixtureOptics('beam', { lumens: 10_000_000, beamAngle: 0.1 });
  assert.ok(validExtreme.gain > 1_000_000 && Number.isFinite(validExtreme.gain), 'valid legacy extreme is not prematurely clipped');
  const extreme = fixtureOptics('beam', { lumens: 1e12, beamAngle: 0 });
  assert.ok(Number.isFinite(extreme.gain) && extreme.gain <= MAX_AERIAL_GAIN);
  assert.ok(Number.isFinite(aerialGain(extreme, 0.001)) && aerialGain(extreme, 0.001) <= MAX_AERIAL_GAIN);
  assert.ok(Number.isFinite(aerialGain(extreme, 0)));
});

test('productionEstimator keeps legacy rigs unchanged and computes per-model weight/power for catalogue fixtures and LED panels', () => {
  const legacyRig = structuredClone(RIG_TEMPLATES.club_stage);
  const legacyEst = calculateProductionEstimate(legacyRig);
  assert.equal(hasCatalogFixtures(legacyRig), false);

  // Switch first beam group on club_stage to Robe MegaPointe (22 kg, 670 W).
  const catalogRig = structuredClone(legacyRig);
  const beamGroup = catalogRig.trussPods.flatMap((p) => p.fixtures).find((f) => f.type === 'beam');
  assert.ok(beamGroup);
  beamGroup.catalogId = 'robe-megapointe';
  beamGroup.modelName = 'Robe MegaPointe';
  beamGroup.dmxMode = 'Mode 1 (Standard 16-bit)';
  beamGroup.dmxChannels = 39;
  assert.equal(hasCatalogFixtures(catalogRig), true);

  const catEst = calculateProductionEstimate(catalogRig);
  const megaRow = catEst.equipmentItems.find((item) => item.label === 'Robe MegaPointe');
  assert.ok(megaRow, 'catalogue group produces its own model line item');
  assert.equal(megaRow.qty, `${beamGroup.count} units`);
  assert.equal(megaRow.weightLbs, Math.round(beamGroup.count * 22 * 2.20462));
  assert.equal(megaRow.watts, beamGroup.count * 670);
  // Crew count remains identical because total fixture count didn't change.
  assert.equal(catEst.laborItems.find((l) => /Lighting Director/.test(l.role)).crewCount,
    legacyEst.laborItems.find((l) => /Lighting Director/.test(l.role)).crewCount);

  // LED panel catalogue entry uses per-cabinet weight & watts (ROE BP2 V2: 9.35 kg, 190 W).
  const panelRig = structuredClone(legacyRig);
  panelRig.ledWall = {
    enabled: true,
    width: 4,
    height: 3,
    curved: false,
    sideWings: false,
    cabinets: { cabinetId: 'roe-bp2-v2', columns: 8, rows: 6, widthMm: 500, heightMm: 500, pixelsWide: 176, pixelsHigh: 176 },
  };
  const panelEst = calculateProductionEstimate(panelRig);
  const ledRow = panelEst.equipmentItems.find((i) => i.category === 'LED Video');
  assert.match(ledRow.label, /ROE Visual Black Pearl BP2 V2/);
  assert.equal(ledRow.weightLbs, Math.round(48 * 9.35 * 2.20462));
  assert.equal(ledRow.watts, 48 * 190);
});

test('rigImport enforces catalogue cross-field rules, preserves unknown forward-compat IDs, and channel drift & MVR spec pruning work', () => {
  const base = createBlankDesign();
  base.trussPods = [
    {
      id: 'p1', name: 'T1', shape: 'box', width: 8, x: 0, baseY: 6, z: 0, rotationY: 0,
      motorized: false, motorMinY: 6, motorMaxY: 6,
      fixtures: [
        {
          id: 'f1', type: 'beam', modelName: 'Claypaky Sharpy',
          catalogId: 'claypaky-sharpy', dmxMode: 'Standard', dmxChannels: 16,
          count: 2, dmxUniverse: 1, dmxStartChannel: 1,
        },
      ],
    },
  ];
  assert.equal(parseRigJson(JSON.stringify(base)).trussPods[0].fixtures[0].catalogId, 'claypaky-sharpy');

  // Missing dmxMode / dmxChannels when catalogId is present -> readable Error.
  const noMode = structuredClone(base);
  delete noMode.trussPods[0].fixtures[0].dmxMode;
  assert.throws(() => parseRigJson(JSON.stringify(noMode)), /must also specify dmxMode and dmxChannels/);

  // Incompatible type for known catalogId -> readable Error.
  const wrongType = structuredClone(base);
  wrongType.trussPods[0].fixtures[0].type = 'strobe';
  assert.throws(() => parseRigJson(JSON.stringify(wrongType)), /not compatible with fixture type/);

  // Unknown mode name for known catalogId -> readable Error.
  const wrongMode = structuredClone(base);
  wrongMode.trussPods[0].fixtures[0].dmxMode = 'Nonexistent Mode';
  assert.throws(() => parseRigJson(JSON.stringify(wrongMode)), /not a valid DMX mode/);

  // Non-panel cabinetId -> readable Error.
  const badCabinet = structuredClone(base);
  badCabinet.ledWall.cabinets = { cabinetId: 'claypaky-sharpy', columns: 4, rows: 4, widthMm: 500, heightMm: 500, pixelsWide: 128, pixelsHigh: 128 };
  assert.throws(() => parseRigJson(JSON.stringify(badCabinet)), /not an LED panel/);

  // Forward-compat unknown catalogId is accepted and preserved.
  const future = structuredClone(base);
  future.trussPods[0].fixtures[0].catalogId = 'future-brand-x9000';
  future.trussPods[0].fixtures[0].dmxMode = 'Turbo';
  future.trussPods[0].fixtures[0].dmxChannels = 42;
  const parsedFuture = parseRigJson(JSON.stringify(future));
  assert.equal(parsedFuture.trussPods[0].fixtures[0].catalogId, 'future-brand-x9000');

  // Stored channel count drift is accepted (not rejected) and flagged by checkCatalogChannelDrift.
  const drifted = structuredClone(base);
  drifted.trussPods[0].fixtures[0].dmxChannels = 18;
  const parsedDrift = parseRigJson(JSON.stringify(drifted));
  assert.deepEqual(checkCatalogChannelDrift(parsedDrift.trussPods[0].fixtures[0]), {
    expectedChannels: 16,
    actualChannels: 18,
  });

  // pruneInterchangeFixtureSpecs drops stale MVR GDTF specs only for the edited group.
  const interchange = {
    mvr: {
      fixtureSpecs: {
        'fixture:["pod","p1","f1",0]': { spec: 'Old@Spot.gdtf', mode: 'Mode1' },
        'fixture:["pod","p1","f1",1]': { spec: 'Old@Spot.gdtf', mode: 'Mode1' },
        'fixture:["pod","p1","f2",0]': { spec: 'Keep@Wash.gdtf', mode: 'Mode1' },
        'fixture:["floor","fx1",0]': { spec: 'Floor@Beam.gdtf', mode: 'Mode1' },
      },
    },
  };
  const prunedPod = pruneInterchangeFixtureSpecs(interchange, 'p1', 'f1');
  assert.deepEqual(Object.keys(prunedPod.mvr.fixtureSpecs), [
    'fixture:["pod","p1","f2",0]',
    'fixture:["floor","fx1",0]',
  ]);
  const prunedFloor = pruneInterchangeFixtureSpecs(prunedPod, undefined, 'fx1');
  assert.deepEqual(Object.keys(prunedFloor.mvr.fixtureSpecs), ['fixture:["pod","p1","f2",0]']);
});

test('QA regressions: narrow DMX write clamp (H1), hazer-only legacy estimate (M1), unverified estimator gate (M2), optics reset on model change (M4), clone exclude (L1) and laser buckets (L6)', () => {
  // H1: narrow 3-ch ETC ColorSource PAR × 4 must never write past each unit's 3-channel footprint.
  const u1 = new Uint8Array(512);
  u1[12] = 77; // neighbor at channel 13 (index 12)
  for (let unit = 0; unit < 4; unit++) {
    writeDmxChannels(u1, 1 + unit * 3, 3, [10 + unit, 20 + unit, 30 + unit, 99, 99, 99, 99, 99]);
  }
  assert.deepEqual([...u1.slice(0, 13)], [10, 20, 30, 11, 21, 31, 12, 22, 32, 13, 23, 33, 77]);
  // 1-ch strobe/PAR at channel 512 does not overflow buffer.
  writeDmxChannels(u1, 512, 1, [255, 200]);
  assert.equal(u1[511], 255);

  // M1: a legacy rig with ONLY hazers (no CO2/smoke) does NOT add an SFX / Cryo tech labor row.
  const hazerOnly = createBlankDesign();
  hazerOnly.floorFx = [
    { id: 'hz1', type: 'hazer', modelName: 'MDG ATMe Touring Hazer', count: 2, x: 0, z: -2, spread: 4, dmxUniverse: 2, dmxStartChannel: 1 },
  ];
  const hazerEst = calculateProductionEstimate(hazerOnly);
  assert.equal(hazerEst.laborItems.some((l) => /SFX \/ Cryo/.test(l.role)), false);

  // M2: unverified weight/power on catalogue models fall back to estimated allowances and carry an explicit label.
  const unverifiedRig = createBlankDesign();
  unverifiedRig.trussPods = [{
    id: 'p1', name: 'T1', shape: 'box', width: 8, x: 0, baseY: 6, z: 0, rotationY: 0,
    motorized: false, motorMinY: 6, motorMaxY: 6,
    fixtures: [
      { id: 'f-sharpy', type: 'beam', modelName: 'Claypaky Sharpy', catalogId: 'claypaky-sharpy', dmxMode: 'Standard', dmxChannels: 16, count: 2, dmxUniverse: 1, dmxStartChannel: 1 },
      { id: 'f-laser', type: 'laser', modelName: 'KVANT Clubmax', catalogId: 'kvant-clubmax', dmxMode: 'Placeholder DMX (18-Ch)', dmxChannels: 18, count: 1, dmxUniverse: 2, dmxStartChannel: 1 },
    ],
  }];
  // L6: same catalogue laser on floor uses floor_laser allowance separately from overhead laser.
  unverifiedRig.floorFx = [
    { id: 'fx-laser', type: 'floor_laser', modelName: 'KVANT Clubmax', catalogId: 'kvant-clubmax', dmxMode: 'Placeholder DMX (18-Ch)', dmxChannels: 18, count: 1, x: 0, z: 2, spread: 0, dmxUniverse: 2, dmxStartChannel: 30 },
  ];
  const unvEst = calculateProductionEstimate(unverifiedRig);
  const sharpyRow = unvEst.equipmentItems.find((i) => i.label.startsWith('Claypaky Sharpy'));
  assert.equal(sharpyRow.label, 'Claypaky Sharpy (est. power)');
  assert.equal(sharpyRow.weightLbs, Math.round(2 * 19 * 2.20462)); // weightKg verified
  assert.equal(sharpyRow.watts, 2 * 520); // powerW unverified -> legacy beam allowance
  const laserRows = unvEst.equipmentItems.filter((i) => i.label.startsWith('KVANT Clubmax'));
  assert.equal(laserRows.length, 2, 'overhead laser and floor_laser keep distinct cost allowances (L6)');
  assert.ok(laserRows.every((r) => r.label === 'KVANT Clubmax (est. weight, est. power)'));
  assert.deepEqual(laserRows.map((r) => r.buyCost).sort((a, b) => a - b), [14500, 28000]);

  // M4: switching catalogId clears stale per-model optics overrides; switching mode on same catalogId keeps them.
  const withOptics = {
    id: 'g1', type: 'beam', modelName: 'Robe MegaPointe',
    catalogId: 'robe-megapointe', dmxMode: 'Mode 1 (Standard 16-bit)', dmxChannels: 39,
    optics: { lumens: 500 }, count: 2, dmxUniverse: 1, dmxStartChannel: 1,
  };
  const opticsRig = rigWith([withOptics]);
  const sameModelModeChange = repatchGroup(opticsRig, withOptics, {
    modelName: 'Robe MegaPointe', catalogId: 'robe-megapointe', dmxMode: 'Mode 2 (Reduced 8-bit)', dmxChannels: 34,
  });
  assert.equal(sameModelModeChange.ok, true);
  assert.deepEqual(sameModelModeChange.group.optics, { lumens: 500 });
  const diffModelChange = repatchGroup(opticsRig, withOptics, {
    modelName: 'Claypaky Sharpy', catalogId: 'claypaky-sharpy', dmxMode: 'Standard', dmxChannels: 16,
  });
  assert.equal(diffModelChange.ok, true);
  assert.equal(diffModelChange.group.optics, undefined);

  // L1: passing a cloned group object to repatchGroup still excludes itself so it keeps its address.
  const cloned = structuredClone(withOptics);
  const cloneKeep = repatchGroup(opticsRig, cloned, {
    modelName: 'Robe MegaPointe', catalogId: 'robe-megapointe', dmxMode: 'Mode 2 (Reduced 8-bit)', dmxChannels: 34,
  });
  assert.equal(cloneKeep.ok, true);
  assert.equal(cloneKeep.moved, false);
  assert.equal(cloneKeep.group.dmxStartChannel, 1);

  // Overflowing group relocated cleanly when its new narrower footprint fits.
  const overflowing = { id: 'ov1', type: 'beam', modelName: 'Over', count: 2, dmxUniverse: 1, dmxStartChannel: 505 };
  const recovered = repatchGroup(rigWith([overflowing]), overflowing, {
    modelName: 'Claypaky Sharpy', catalogId: 'claypaky-sharpy', dmxMode: 'Standard', dmxChannels: 16,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.moved, true);
  assert.equal(recovered.group.dmxStartChannel, 1);
});
