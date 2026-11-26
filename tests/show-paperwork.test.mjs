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

const { RIG_TEMPLATES, SHOW_CUES, INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');
const TEMPLATE_LIST = Object.values(RIG_TEMPLATES);
const { formatDmxLabel } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');
const { patchCsv } = await compiler.ssrLoadModule('/src/data/patchCsv.ts');
const { dxfBlockName } = await compiler.ssrLoadModule('/src/data/equipmentSymbols.ts');
const { exportStageDxf } = await compiler.ssrLoadModule('/src/data/stageDxf.ts');
const { exportMvrDocument } = await compiler.ssrLoadModule('/src/interchange/mvr/exportMvr.ts');
const { readArchive } = await compiler.ssrLoadModule('/src/interchange/mvr/archive.ts');
const { parseXml, child, list, text } = await compiler.ssrLoadModule('/src/interchange/mvr/xml.ts');
const { parseMatrix } = await compiler.ssrLoadModule('/src/interchange/mvr/coords.ts');
const { computePowerReport, riggingPowerCsv, unitCircuitIndex, unitCircuitPosKey } = await compiler.ssrLoadModule('/src/data/powerReport.ts');
const { CROWD_SCAN_WARNING } = await compiler.ssrLoadModule('/src/data/laserSafety.ts');
const { parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const {
  buildShowPaperwork,
  patchSheetCsv,
  instrumentScheduleCsv,
  channelHookupCsv,
  cueSheetCsv,
  PAPERWORK_SIMULATED_MAP_NOTICE,
} = await compiler.ssrLoadModule('/src/data/showPaperwork.ts');

function parseMvrFixtures(mvrBytes) {
  const entries = readArchive(mvrBytes);
  const xmlEntry = entries.get('generalscenedescription.xml');
  assert.ok(xmlEntry, 'MVR archive should contain GeneralSceneDescription.xml');
  const doc = parseXml(new TextDecoder().decode(xmlEntry.data));
  const root = child(doc, 'GeneralSceneDescription');
  const scene = child(root, 'Scene');
  const layers = list(child(scene, 'Layers'), 'Layer');
  const fixtures = [];
  for (const layer of layers) {
    for (const f of list(child(layer, 'ChildList'), 'Fixture')) {
      fixtures.push(f);
    }
  }
  return fixtures;
}

function parseDxfFixtureInserts(dxfText) {
  const lines = dxfText.split(/\r\n/);
  const inserts = [];
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (lines[i].trim() === '0' && lines[i + 1].trim() === 'INSERT') {
      let layer = '';
      let block = '';
      const xdataStrings = [];
      let inSf = false;
      for (let j = i + 2; j < lines.length - 1; j += 2) {
        const code = lines[j].trim();
        const val = lines[j + 1];
        if (code === '0') {
          i = j - 2;
          break;
        }
        if (code === '8') layer = val.trim();
        else if (code === '2') block = val.trim();
        else if (code === '1001') inSf = val.trim() === 'STAGEFORGE';
        else if (code === '1000' && inSf) xdataStrings.push(val.trimEnd());
      }
      if (layer === 'FIXTURES') {
        inserts.push({ block, xdata: xdataStrings });
      }
    }
  }
  return inserts;
}

test('MVR parity: fixture IDs, unit numbers, absolute addresses, omitted unpatched addresses, and world coordinates match across 3 rigs', () => {
  const arenaRig = TEMPLATE_LIST[0];
  const festivalRig = TEMPLATE_LIST[1];

  // Rig 3: authored layout-truss stage with a deliberately conflicting group and an overflowing group.
  const authoredRig = structuredClone(TEMPLATE_LIST[2]);
  authoredRig.trussPods[0].fixtures[0].dmxUniverse = 1;
  authoredRig.trussPods[0].fixtures[0].dmxStartChannel = 1;
  if (authoredRig.trussPods[0].fixtures.length > 1) {
    authoredRig.trussPods[0].fixtures[1].dmxUniverse = 1;
    authoredRig.trussPods[0].fixtures[1].dmxStartChannel = 1; // deliberate conflict with group 0
  } else {
    authoredRig.trussPods[0].fixtures.push({
      id: 'conflict-wash',
      type: 'wash',
      modelName: 'Conflict Wash',
      count: 2,
      dmxUniverse: 1,
      dmxStartChannel: 1,
    });
  }
  authoredRig.floorFx.push({
    id: 'overflow-strobe',
    type: 'strobe',
    modelName: 'Overflow Strobe',
    count: 2,
    x: 0,
    z: 2,
    spread: 2,
    dmxUniverse: 2,
    dmxStartChannel: 511, // unit 0 uses 511..512 (ok), unit 1 uses 513..514 (overflow)
  });

  const authoredStage = {
    walls: [],
    screenEvents: [],
    layout: {
      trusses: [{ x: -6, z: 1, endX: 0, endZ: 1, height: 8 }],
      props: [],
    },
  };

  const cases = [
    { name: 'Arena Rock', rig: arenaRig, stage: undefined },
    { name: 'Festival', rig: festivalRig, stage: undefined },
    { name: 'Authored layout + conflict/overflow', rig: authoredRig, stage: authoredStage },
  ];

  for (const { name, rig, stage } of cases) {
    const pw = buildShowPaperwork(rig, stage, SHOW_CUES);
    const mvr = exportMvrDocument(rig, stage);
    const mvrFixtures = parseMvrFixtures(mvr.bytes);

    assert.equal(pw.units.length, mvrFixtures.length, `${name}: fixture count matches MVR`);
    assert.equal(pw.units.length + pw.unplaced.length, pw.totalExpectedUnits, `${name}: unit count invariant`);

    for (let i = 0; i < pw.units.length; i++) {
      const u = pw.units[i];
      const f = mvrFixtures[i];
      assert.equal(String(u.fixtureNumber), text(f, 'FixtureID'), `${name} #${i}: FixtureID`);
      assert.equal(String(u.fixtureNumber), text(f, 'FixtureIDNumeric'), `${name} #${i}: FixtureIDNumeric`);
      assert.equal(String(u.fixtureNumber), text(f, 'CustomId'), `${name} #${i}: CustomId`);
      assert.equal(String(u.unitNumber), text(f, 'UnitNumber'), `${name} #${i}: UnitNumber`);

      const addrNode = list(child(f, 'Addresses'), 'Address')[0];
      if (u.absoluteAddress === null) {
        assert.equal(addrNode, undefined, `${name} #${i}: unpatched unit omits MVR <Addresses>`);
      } else {
        assert.equal(String(u.absoluteAddress), String(addrNode?.['#text'] ?? addrNode), `${name} #${i}: MVR absolute address`);
      }

      // MVR coordinates: SF (x, y, z) -> MVR (1000x, -1000z, 1000y)
      const mat = parseMatrix(text(f, 'Matrix'));
      assert.ok(mat, `${name} #${i}: valid MVR matrix`);
      assert.ok(Math.abs(mat.o.x - u.x * 1000) < 1e-2, `${name} #${i}: X parity`);
      assert.ok(Math.abs(mat.o.y - -u.z * 1000) < 1e-2, `${name} #${i}: Z->-Y parity`);
      assert.ok(Math.abs(mat.o.z - u.y * 1000) < 1e-2, `${name} #${i}: Y->Z parity`);
    }
  }

  // Confirm authored conflict and overflow statuses were classified distinctly and layout truss is included.
  const authoredPw = buildShowPaperwork(authoredRig, authoredStage);
  assert.ok(authoredPw.totals.conflictUnits > 0, 'conflict units detected');
  assert.ok(authoredPw.totals.overflowUnits > 0, 'overflow units detected');
  assert.ok(authoredPw.positions.some((p) => p.positionId === 'layout-truss-1'), 'authored layout truss included in positions');
  assert.ok(authoredPw.loads.pods.some((p) => p.podId === 'layout-truss-1'), 'authored layout truss included in loads');
});

test('DXF parity: shared dxfBlockName & formatDmxLabel match DXF inserts unit-for-unit', () => {
  const rig = structuredClone(TEMPLATE_LIST[0]);
  rig.trussPods[0].fixtures[0].catalogId = 'martin-mac-ultra-performance';
  rig.trussPods[0].fixtures[0].modelName = 'MAC Ultra Performance';

  const pw = buildShowPaperwork(rig);
  const dxf = exportStageDxf(rig);
  const inserts = parseDxfFixtureInserts(dxf);

  assert.equal(inserts.length, pw.units.length, 'DXF insert count matches paperwork units');
  for (let i = 0; i < pw.units.length; i++) {
    const u = pw.units[i];
    const ins = inserts[i];
    assert.equal(ins.block, u.dxfBlock, `unit #${i + 1}: DXF block matches`);
    assert.equal(ins.block, dxfBlockName(u.type, u.catalogId), `unit #${i + 1}: dxfBlockName helper`);
    assert.equal(ins.xdata[1], u.groupId, `unit #${i + 1}: groupId matches XDATA`);
    const expectedTag = `${formatDmxLabel(u.universe, u.address)}${u.status === 'ok' ? '' : ' (invalid patch)'}`;
    assert.equal(ins.xdata[2], expectedTag, `unit #${i + 1}: patch tag matches XDATA`);
  }
});

test('Circuit mapping: deduped shared labels (#1/#2), split circuits (-01/-02), pinned phases, single-phase L1, and wattage parity', () => {
  const rig = structuredClone(TEMPLATE_LIST[0]);
  // Give two distinct groups the same custom circuitGroup label so deduplicateCircuitIds emits SHARED#1 / SHARED#2.
  rig.trussPods[0].fixtures[0].circuitGroup = 'SHARED';
  rig.trussPods[0].fixtures[0].phase = 'L2';
  rig.trussPods[1].fixtures[0].circuitGroup = 'SHARED';
  rig.trussPods[1].fixtures[0].phase = 'L3';
  // Ensure a high-wattage group splits into -01 / -02 circuits (8 x 750W > 1920 VA on US 120V 20A).
  rig.trussPods[0].fixtures[0].count = 8;

  const power = computePowerReport(rig);
  const pw = buildShowPaperwork(rig, undefined, [], undefined, { power });
  const lookup = unitCircuitIndex(power);

  // Every fixture unit has a circuit & phase from powerReport, and summed wattage per circuit matches PowerCircuit.watts.
  const wattsByCircuit = new Map();
  for (const u of pw.units) {
    assert.ok(u.circuitId, `fixture #${u.fixtureNumber} should have a circuitId`);
    assert.ok(u.phase, `fixture #${u.fixtureNumber} should have a phase`);
    wattsByCircuit.set(u.circuitId, (wattsByCircuit.get(u.circuitId) ?? 0) + u.powerW);
  }
  for (const c of power.circuits) {
    if (!c.source) continue;
    assert.equal(wattsByCircuit.get(c.id), c.watts, `circuit ${c.id} wattage sum equals PowerCircuit.watts`);
  }

  // Verify split circuits and pinned phases.
  const pod0Group0Units = pw.units.filter((u) => u.positionId === rig.trussPods[0].id && u.groupId === rig.trussPods[0].fixtures[0].id);
  const pod0Circuits = new Set(pod0Group0Units.map((u) => u.circuitId));
  assert.ok(pod0Circuits.size >= 2, 'high-wattage group splits across multiple -01/-02 circuits');
  assert.ok(pod0Group0Units.every((u) => u.phase === 'L2'), 'pinned L2 phase carried to all units');

  // Verify deduped label case (when two single-circuit groups share the exact same label).
  const dedupeRig = structuredClone(TEMPLATE_LIST[2]);
  dedupeRig.trussPods[0].fixtures[0].count = 1;
  dedupeRig.trussPods[0].fixtures[0].circuitGroup = 'DIM-A';
  dedupeRig.trussPods[1].fixtures[0].count = 1;
  dedupeRig.trussPods[1].fixtures[0].circuitGroup = 'DIM-A';
  const dedupePower = computePowerReport(dedupeRig);
  const dedupeLookup = unitCircuitIndex(dedupePower);
  const cA = dedupeLookup(unitCircuitPosKey(0, 0), 0);
  const cB = dedupeLookup(unitCircuitPosKey(1, 0), 0);
  assert.equal(cA?.circuitId, 'DIM-A#1');
  assert.equal(cB?.circuitId, 'DIM-A#2');

  // Single-phase system assigns every unit to L1.
  const singlePhaseRig = structuredClone(dedupeRig);
  singlePhaseRig.power = { system: 'us_120_1p' };
  const spPw = buildShowPaperwork(singlePhaseRig);
  assert.ok(spPw.units.every((u) => u.phase === 'L1'), 'all units on 1-phase system use L1');

  // Verify riggingPowerCsv does NOT emit internal source metadata.
  const rpCsv = riggingPowerCsv(rig);
  assert.ok(!rpCsv.includes('podIndex') && !rpCsv.includes('firstUnit'), 'riggingPowerCsv omits source metadata');
});

test('Mixed-group interleaving on a pod separates mountOrder from unitNumber and preserves placement order', () => {
  const rig = structuredClone(TEMPLATE_LIST[2]);
  rig.trussPods = [
    {
      id: 'mix-pod',
      name: 'Mixed Front Truss',
      shape: 'box',
      width: 12,
      x: 0,
      baseY: 8,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 8,
      motorMaxY: 8,
      fixtures: [
        { id: 'grp-a', type: 'beam', modelName: 'Group A Beam', count: 4, dmxUniverse: 1, dmxStartChannel: 1 },
        { id: 'grp-b', type: 'wash', modelName: 'Group B Wash', count: 2, dmxUniverse: 1, dmxStartChannel: 100 },
      ],
    },
  ];
  rig.floorFx = [];

  const pw = buildShowPaperwork(rig);
  // Fractions: grp-a = 0.125, 0.375, 0.625, 0.875; grp-b = 0.25, 0.75.
  // Placement order: A1(0.125), B1(0.25), A2(0.375), A3(0.625), B2(0.75), A4(0.875).
  assert.deepEqual(
    pw.instrumentRows.map((u) => `${u.groupId}:${u.unitNumber}@mt${u.mountOrder}#${u.fixtureNumber}`),
    [
      'grp-a:1@mt1#1',
      'grp-b:1@mt2#2',
      'grp-a:2@mt3#3',
      'grp-a:3@mt4#4',
      'grp-b:2@mt5#5',
      'grp-a:4@mt6#6',
    ],
  );
  // Confirm mountOrder !== unitNumber on interleaved units.
  const b1 = pw.instrumentRows[1];
  assert.equal(b1.mountOrder, 2);
  assert.equal(b1.unitNumber, 1);
  assert.equal(b1.fixtureNumber, 2);
});

test('Unplaced fixture invariant holds even when a degenerate path truss produces zero mount slots', () => {
  const rig = structuredClone(TEMPLATE_LIST[2]);
  rig.trussPods = [
    {
      id: 'empty-path',
      name: 'Broken Path Truss',
      shape: 'path',
      path: [], // trussMounts returns [] -> placeFixtures skips all 3 units
      width: 6,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 7,
      motorMaxY: 7,
      fixtures: [
        { id: 'orphan-beams', type: 'beam', modelName: 'Orphan Beam', count: 3, dmxUniverse: 1, dmxStartChannel: 1 },
      ],
    },
  ];
  rig.floorFx = [];

  const pw = buildShowPaperwork(rig);
  assert.equal(pw.totalExpectedUnits, 3);
  assert.equal(pw.units.length, 0);
  assert.equal(pw.unplaced.length, 3);
  assert.equal(pw.units.length + pw.unplaced.length, pw.totalExpectedUnits);
  assert.deepEqual(
    pw.unplaced.map((u) => u.index),
    [0, 1, 2],
  );
});

test('Cue Sheet timecode handles SMPTE offsets, 29.97 drop-frame, missing events, first-event-wins duplicates, and crowd-scan warning', () => {
  const cues = [
    {
      id: 'c1',
      name: 'Walk-In',
      tag: 'HOUSE',
      accent: '#f59e0b',
      fadeSeconds: 2.5,
      followSeconds: 12,
      state: { ...structuredClone(INITIAL_SHOW_STATE), masterDimmer: 0.5 },
    },
    {
      id: 'c2',
      name: 'Crowd Laser Hit',
      tag: 'DROP',
      accent: '#22d3ee',
      state: {
        ...structuredClone(INITIAL_SHOW_STATE),
        masterDimmer: 1,
        laser: { ...structuredClone(INITIAL_SHOW_STATE.laser), enabled: true, audienceScan: true, pattern: 'tunnel', intensity: 0.9 },
      },
    },
    {
      id: 'c3',
      name: 'Blackout Finale',
      tag: 'END',
      accent: '#ffffff',
      state: { ...structuredClone(INITIAL_SHOW_STATE), blackout: true },
    },
  ];

  // 29.97 DF with 01:00:00;00 offset (3,600,000 ms). c1 appears twice (first event at 1000 ms must win); c3 has no event.
  const timeline = {
    durationMs: 120_000,
    frameRate: 29.97,
    timecodeOffsetMs: 3_600_000,
    events: [
      { atMs: 1_000, cueId: 'c1' },
      { atMs: 60_000, cueId: 'c2' }, // frame 109,690 = 01:00:59;28 in 29.97 DF (the first minute of a block keeps all 30 frames)
      { atMs: 90_000, cueId: 'c1' }, // duplicate — must NOT overwrite first event
    ],
  };

  const pw = buildShowPaperwork(TEMPLATE_LIST[0], undefined, cues, timeline);
  assert.equal(pw.timelineFrameRate, 29.97);
  assert.equal(pw.cues.length, 3);

  assert.equal(pw.cues[0].cueNumber, 1);
  assert.equal(pw.cues[0].fadeLabel, '2.5s');
  assert.equal(pw.cues[0].followLabel, '12s');
  assert.equal(pw.cues[0].takeAtMs, 1_000);
  assert.equal(pw.cues[0].takeTimecode, '01:00:01;00', 'offset 01:00:00;00 plus 1 s is frame 107,922');

  assert.equal(pw.cues[1].audienceScanWarning, CROWD_SCAN_WARNING);
  assert.equal(pw.cues[1].takeTimecode, '01:00:59;28', '29.97 DF semicolon timecode, 60 s after the offset');

  assert.equal(pw.cues[2].followLabel, 'Manual GO');
  assert.equal(pw.cues[2].fadeLabel, 'Cut');
  assert.equal(pw.cues[2].takeTimecode, null);
  assert.equal(pw.cues[2].dimmerLabel, 'BLACKOUT');
});

test('CSV exports for all four sheets are BOM RFC 4180, neutralize formula injection, and leave legacy patchCsv unchanged', () => {
  const rig = structuredClone(TEMPLATE_LIST[0]);
  const legacyBefore = patchCsv(rig);
  assert.ok(legacyBefore.startsWith('"Location","Group ID","Fixture","Unit","Universe","Address","Offset","Function","Output"\r\n'));

  // Inject hostile spreadsheet formulas into rig model name and cue name.
  rig.trussPods[0].fixtures[0].modelName = '=HYPERLINK("http://evil.example","Click")';
  const cues = [
    {
      id: 'formula-cue',
      name: '+SUM(A1:A9)',
      tag: '@CMD',
      accent: '#fff',
      state: { ...structuredClone(INITIAL_SHOW_STATE) },
    },
  ];

  const pw = buildShowPaperwork(rig, undefined, cues);
  const pCsv = patchSheetCsv(pw);
  const iCsv = instrumentScheduleCsv(pw);
  const hCsv = channelHookupCsv(pw);
  const cCsv = cueSheetCsv(pw);

  for (const [label, body] of [
    ['patchSheetCsv', pCsv],
    ['instrumentScheduleCsv', iCsv],
    ['channelHookupCsv', hCsv],
    ['cueSheetCsv', cCsv],
  ]) {
    assert.ok(body.startsWith('\uFEFF'), `${label} starts with UTF-8 BOM`);
    assert.ok(body.endsWith('\r\n'), `${label} uses CRLF line endings`);
    assert.ok(!body.includes(',=HYPERLINK('), `${label} must neutralize leading =HYPERLINK`);
    assert.ok(!body.includes(',+SUM('), `${label} must neutralize leading +SUM`);
    assert.ok(!body.includes(',@CMD'), `${label} must neutralize leading @CMD`);
  }

  assert.ok(pCsv.includes(PAPERWORK_SIMULATED_MAP_NOTICE), 'patchSheetCsv includes simulated-map notice');
  assert.ok(pCsv.includes(`"'=HYPERLINK(`), 'patchSheetCsv quotes and prefixes formula cell');
  assert.ok(iCsv.includes('DXF Block'), 'instrumentScheduleCsv includes DXF Block column');
  assert.ok(hCsv.includes('Fixture #,Position,Unit #,Manufacturer'), 'channelHookupCsv headers match');
  assert.ok(cCsv.includes('Cue #,Name,Tag,Fade,Follow'), 'cueSheetCsv exposes fade separately from follow');
  assert.ok(cCsv.includes(`"'+SUM(A1:A9)"`) && cCsv.includes(`"'@CMD"`), 'cueSheetCsv neutralizes cue name and tag');
});

test('Loading v1, v2, v3 fixtures and all stock templates produces paperwork cleanly without throwing', async () => {
  const fixtureFiles = [
    'tests/fixtures/legacy-v1.stageforge.show.json',
    'tests/fixtures/legacy-v2.stageforge.show.json',
    'tests/fixtures/native-authoring-v3.stageforge.show.json',
  ];

  for (const file of fixtureFiles) {
    const raw = await readFile(file, 'utf8');
    const show = parseShowFile(raw);
    const pw = buildShowPaperwork(show.rig, show.stage, show.cues, show.timeline);
    assert.equal(pw.units.length + pw.unplaced.length, pw.totalExpectedUnits, `${file}: unit invariant`);
    assert.ok(patchSheetCsv(pw).startsWith('\uFEFF'), `${file}: patchSheetCsv`);
    assert.ok(instrumentScheduleCsv(pw).startsWith('\uFEFF'), `${file}: instrumentScheduleCsv`);
    assert.ok(channelHookupCsv(pw).startsWith('\uFEFF'), `${file}: channelHookupCsv`);
    assert.ok(cueSheetCsv(pw).startsWith('\uFEFF'), `${file}: cueSheetCsv`);
  }

  for (const tpl of TEMPLATE_LIST) {
    const pw = buildShowPaperwork(tpl, undefined, SHOW_CUES);
    assert.equal(pw.unplaced.length, 0, `${tpl.name}: zero unplaced units`);
    assert.equal(pw.units.length, pw.totalExpectedUnits, `${tpl.name}: all units placed`);
  }
});
