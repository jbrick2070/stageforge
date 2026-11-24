import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { buildDmxPatch, allocateDmx, addPatchedUnits, DMX_CHANNELS } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');
const { patchCsv } = await compiler.ssrLoadModule('/src/data/patchCsv.ts');
const { FIXTURE_CATALOG, FLOOR_FX_CATALOG } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { PROFILES, profileArchive, readGdtf } = await compiler.ssrLoadModule('/src/interchange/mvr/gdtf.ts');

function rigWith(fixtures = [], floorFx = []) {
  const rig = createBlankDesign();
  rig.trussPods = [{
    id: 'p1', name: 'Front truss', shape: 'box', width: 10,
    x: 0, baseY: 6, z: 0, rotationY: 0, motorized: false, motorMinY: 6, motorMaxY: 6,
    fixtures,
  }];
  rig.floorFx = floorFx;
  return rig;
}

test('buildDmxPatch and unitStart detect exact 512/513 overflow and cross-group channel conflicts', () => {
  const beamFootprint = FIXTURE_CATALOG.beam.dmxFootprint; // 16
  assert.equal(beamFootprint, 16);
  const gOk = { id: 'g1', type: 'beam', modelName: 'Spot', count: 1, dmxUniverse: 1, dmxStartChannel: 497 }; // 497..512
  const gOver = { id: 'g2', type: 'beam', modelName: 'SpotOver', count: 1, dmxUniverse: 2, dmxStartChannel: 505 }; // 505..520
  const gA = { id: 'g3', type: 'wash', modelName: 'WashA', count: 2, dmxUniverse: 2, dmxStartChannel: 1 }; // 1..24
  const gB = { id: 'g4', type: 'strobe', modelName: 'StrobeB', count: 1, dmxUniverse: 2, dmxStartChannel: 13 }; // overlaps WashA #2 (13..24)

  const patch = buildDmxPatch(rigWith([gOk, gOver, gA, gB]));
  assert.equal(patch.unitStart(gOk, 0), 497, '497..512 fits exactly');
  assert.equal(patch.unitStart(gOver, 0), 0, '505..520 overflows 512');
  assert.equal(patch.unitStart(gA, 0), 1, 'non-overlapping unit #1 stays patched');
  assert.equal(patch.unitStart(gA, 1), 0, 'overlapping unit #2 is disabled');
  assert.equal(patch.unitStart(gB, 0), 0, 'overlapping strobe is disabled');
  const rowA = patch.rows.find((r) => r.group === gA);
  const rowB = patch.rows.find((r) => r.group === gB);
  assert.ok(rowA.conflicts.length > 0 && rowB.conflicts.length > 0);
});

test('allocateDmx and addPatchedUnits never extend across mismatched fixture types and handle full universes', () => {
  const beams = { id: 'b1', type: 'beam', modelName: 'Beam 16ch', count: 4, dmxUniverse: 1, dmxStartChannel: 1 }; // 1..64
  const rig = rigWith([beams]);

  // Extending a 16-ch beam group with a 12-ch wash must NOT use wash footprint or merge into beams.
  const mismatch = allocateDmx(rig, 'wash', 1, 1, beams);
  assert.deepEqual(mismatch, { dmxUniverse: 1, dmxStartChannel: 65, extendsGroup: false });
  const washAddition = { id: 'w1', type: 'wash', modelName: 'Wash 12ch', count: 1, dmxUniverse: 1, dmxStartChannel: 1 };
  const afterMismatch = addPatchedUnits(rig, [beams], washAddition, beams);
  assert.equal(afterMismatch.length, 2, 'must append a new wash group instead of mutating beams');
  assert.equal(afterMismatch[0].count, 4);
  assert.equal(afterMismatch[1].type, 'wash');
  assert.equal(afterMismatch[1].dmxStartChannel, 65);

  // Matching type extends cleanly right after channel 64.
  const match = allocateDmx(rig, 'beam', 2, 1, beams);
  assert.deepEqual(match, { dmxUniverse: 1, dmxStartChannel: 65, extendsGroup: true });

  // Invalid counts and oversized allocations return undefined.
  assert.equal(allocateDmx(rig, 'beam', 0, 1), undefined);
  assert.equal(allocateDmx(rig, 'beam', -1, 1), undefined);
  assert.equal(allocateDmx(rig, 'beam', 33, 1), undefined); // 528 > 512

  // Full preferred universe falls back to the other universe; completely full rig returns undefined.
  const fullU1 = { id: 'u1', type: 'beam', modelName: 'U1', count: 32, dmxUniverse: 1, dmxStartChannel: 1 }; // 1..512
  const fullU2 = { id: 'u2', type: 'beam', modelName: 'U2', count: 32, dmxUniverse: 2, dmxStartChannel: 1 }; // 1..512
  assert.deepEqual(allocateDmx(rigWith([fullU1]), 'beam', 1, 1), { dmxUniverse: 2, dmxStartChannel: 1, extendsGroup: false });
  assert.equal(allocateDmx(rigWith([fullU1, fullU2]), 'beam', 1, 1), undefined);
});

test('patchCsv neutralizes spreadsheet formulas, escapes quotes, uses CRLF and marks Reserved/Disabled channels', () => {
  const rig = rigWith([
    { id: 'f1', type: 'beam', modelName: '=HYPERLINK("http://evil")', count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
    { id: 'f2', type: 'blinder', modelName: '+SUM(A1)', count: 1, dmxUniverse: 1, dmxStartChannel: 510 },
    { id: 'f3', type: 'strobe', modelName: '@cmd', count: 1, dmxUniverse: 1, dmxStartChannel: 511 },
    { id: 'f4', type: 'beam', modelName: '\t-tab"quote', count: 1, dmxUniverse: 1, dmxStartChannel: 505 }, // overflows -> Disabled
  ]);
  const csv = patchCsv(rig);
  assert.ok(csv.includes('\r\n') && csv.endsWith('\r\n'));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"")"'), 'leading = is quoted with apostrophe and quotes doubled');
  assert.ok(csv.includes('"\'+SUM(A1)"'), 'leading + is neutralized');
  assert.ok(csv.includes('"\'@cmd"'), 'leading @ is neutralized');
  assert.ok(csv.includes('"\'\t-tab""quote"'), 'leading tab is neutralized and quote doubled');
  assert.ok(csv.includes('"Reserved"'), 'beam offsets 9..16 are labeled Reserved');
  assert.ok(csv.includes('"Disabled"'), 'overflowing beam unit is marked Disabled');
});

test('GDTF generic profiles stay within catalog DMX footprints and match DMX_CHANNELS count', () => {
  const equipment = { ...FIXTURE_CATALOG, ...FLOOR_FX_CATALOG };
  for (const [type, profile] of Object.entries(PROFILES)) {
    const parsed = readGdtf(profileArchive(profile));
    assert.equal(parsed.modes.length, 1, `${type} has one mode`);
    assert.ok(
      parsed.modes[0].footprint <= equipment[type].dmxFootprint,
      `${type} GDTF footprint ${parsed.modes[0].footprint} <= catalog ${equipment[type].dmxFootprint}`,
    );
    assert.equal(
      parsed.modes[0].footprint,
      DMX_CHANNELS[type].length,
      `${type} GDTF channel count matches DMX_CHANNELS`,
    );
  }
});
