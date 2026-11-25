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

const { RIG_TEMPLATES, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const TEMPLATE_LIST = Object.values(RIG_TEMPLATES);
const {
  buildShowPaperwork,
  patchSheetCsv,
  instrumentScheduleCsv,
  channelHookupCsv,
  cueSheetCsv,
  PAPERWORK_SIMULATED_MAP_NOTICE,
} = await compiler.ssrLoadModule('/src/data/showPaperwork.ts');

// Minimal RFC 4180 reader so these tests check real rows and columns, not substrings.
function parseCsv(text) {
  const body = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && body[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function orphanBeamRig() {
  const rig = structuredClone(TEMPLATE_LIST[2]);
  rig.trussPods = [{
    id: 'empty-path', name: 'Broken Path Truss', shape: 'path', path: [], width: 6, x: 0, baseY: 7, z: 0, rotationY: 0,
    motorized: false, motorMinY: 7, motorMaxY: 7,
    fixtures: [{ id: 'orphan-beams', type: 'beam', modelName: 'Orphan Beam', count: 2, dmxUniverse: 1, dmxStartChannel: 1 }],
  }];
  rig.floorFx = [];
  return rig;
}

test('instrument and hookup CSVs flag estimated weight/power, carry the channel-map notice and keep every row the same width', () => {
  const pw = buildShowPaperwork(structuredClone(TEMPLATE_LIST[0]), undefined, SHOW_CUES);
  for (const [label, csv] of [['instrument', instrumentScheduleCsv(pw)], ['hookup', channelHookupCsv(pw)]]) {
    const rows = parseCsv(csv);
    const header = rows[0];
    for (const [i, r] of rows.slice(1).entries()) assert.equal(r.length, header.length, `${label} row ${i + 1} width`);
    const w = header.indexOf('Weight source');
    const p = header.indexOf('Power source');
    const n = header.indexOf('Notes');
    assert.ok(w >= 0 && p >= 0 && n >= 0, `${label} has Weight source, Power source and Notes columns`);
    const kinds = new Set(rows.slice(1).flatMap((r) => [r[w], r[p]]));
    assert.ok([...kinds].every((k) => k === 'Datasheet' || k === 'Estimate'), `${label} source values: ${[...kinds]}`);
    assert.ok(rows.slice(1).every((r) => r[n] === PAPERWORK_SIMULATED_MAP_NOTICE), `${label} notice on every row`);
  }
  // The source columns agree with the model flags, unit for unit.
  const rows = parseCsv(instrumentScheduleCsv(pw));
  const w = rows[0].indexOf('Weight source');
  const p = rows[0].indexOf('Power source');
  const fixtureCol = rows[0].indexOf('Fixture #');
  assert.ok(rows.length > 1);
  for (const r of rows.slice(1)) {
    const u = pw.units.find((x) => x.fixtureNumber === Number(r[fixtureCol]));
    assert.equal(r[w], u.weightEstimated ? 'Estimate' : 'Datasheet');
    assert.equal(r[p], u.powerEstimated ? 'Estimate' : 'Datasheet');
  }
});

test('units the rig counts but cannot place appear as UNPLACED rows in the patch, instrument and hookup CSVs', () => {
  const pw = buildShowPaperwork(orphanBeamRig());
  assert.equal(pw.unplaced.length, 2);
  for (const [label, csv] of [['patch', patchSheetCsv(pw)], ['instrument', instrumentScheduleCsv(pw)], ['hookup', channelHookupCsv(pw)]]) {
    const rows = parseCsv(csv);
    const header = rows[0];
    const unplaced = rows.slice(1).filter((r) => r[header.indexOf('Status')] === 'UNPLACED');
    assert.equal(unplaced.length, 2, `${label}: both orphan units listed`);
    for (const r of rows.slice(1)) assert.equal(r.length, header.length, `${label} row width`);
    assert.deepEqual(unplaced.map((r) => r[header.indexOf('Unit #')]), ['1', '2']);
    assert.ok(unplaced.every((r) => r[header.indexOf('Model')] === 'Orphan Beam'));
    assert.ok(unplaced.every((r) => /not placed/i.test(r[header.indexOf('Notes')])), `${label}: note explains why`);
  }
});

test('a truss pod literally named "floor" does not merge with the stage floor positions', () => {
  const template = TEMPLATE_LIST.find((t) => t.trussPods.length && t.floorFx?.length);
  assert.ok(template, 'a stock template with both truss pods and floor fixtures');
  const baseline = buildShowPaperwork(structuredClone(template));
  const floorUnits = baseline.units.filter((u) => u.floor);
  const podUnits = baseline.units.filter((u) => !u.floor);
  assert.ok(floorUnits.length > 0 && podUnits.length > 0);

  const renamed = structuredClone(template);
  renamed.trussPods[0].id = 'floor';
  const pw = buildShowPaperwork(renamed);
  const floorPositions = pw.positions.filter((p) => p.floor);
  assert.equal(floorPositions.length, 1);
  assert.equal(floorPositions[0].unitCount, floorUnits.length, 'stage floor keeps only floor units');
  const podCount = pw.positions.filter((p) => !p.floor).reduce((n, p) => n + p.unitCount, 0);
  assert.equal(podCount, podUnits.length, 'pods keep only pod units');
  const floorMounts = pw.units.filter((u) => u.floor).map((u) => u.mountOrder).sort((a, b) => a - b);
  assert.deepEqual(floorMounts, floorUnits.map((_, i) => i + 1), 'floor mount order restarts at 1');
});

test('patch rows sort by universe, start address, then fixture number; an unset cue dimmer exports as an empty cell', () => {
  const pw = buildShowPaperwork(structuredClone(TEMPLATE_LIST[0]), undefined,
    [{ id: 'bare', name: 'Bare', tag: 'X', accent: '#fff', state: {} }]);
  for (let i = 1; i < pw.patchRows.length; i++) {
    const a = pw.patchRows[i - 1];
    const b = pw.patchRows[i];
    const order = a.universe - b.universe || a.address - b.address || a.fixtureNumber - b.fixtureNumber;
    assert.ok(order <= 0, `patch row ${i} out of order`);
  }
  const cues = parseCsv(cueSheetCsv(pw));
  assert.equal(cues[1][cues[0].indexOf('Dimmer')], '', 'an unset dimmer is an empty cell, not a dash');
});

test('a catalogue fixture reports Datasheet and Estimate per field, in the right columns, alongside generic hardware', () => {
  const rig = structuredClone(TEMPLATE_LIST[0]);
  rig.trussPods[0].fixtures = [
    { id: 'sharpies', type: 'beam', modelName: 'Sharpy', catalogId: 'claypaky-sharpy', count: 2, dmxUniverse: 1, dmxStartChannel: 1 },
    { id: 'generic-wash', type: 'wash', modelName: 'Generic Wash', count: 2, dmxUniverse: 1, dmxStartChannel: 100 },
  ];
  const pw = buildShowPaperwork(rig);
  const sharpy = pw.units.filter((u) => u.catalogId === 'claypaky-sharpy');
  const generic = pw.units.filter((u) => u.catalogId === undefined && u.modelName === 'Generic Wash');
  assert.equal(sharpy.length, 2);
  assert.equal(generic.length, 2);
  // Mixed on purpose: a swap of the two source columns, or a flag stuck at one value, must fail here.
  assert.notEqual(sharpy[0].weightEstimated, sharpy[0].powerEstimated, 'catalogue weight is verified, its power is not');
  assert.equal(generic[0].weightEstimated, true);
  assert.equal(generic[0].powerEstimated, true);

  for (const csv of [instrumentScheduleCsv(pw), channelHookupCsv(pw)]) {
    const rows = parseCsv(csv);
    const col = (name) => rows[0].indexOf(name);
    for (const r of rows.slice(1)) {
      const u = pw.units.find((x) => x.fixtureNumber === Number(r[col('Fixture #')]));
      assert.equal(r[col('Weight source')], u.weightEstimated ? 'Estimate' : 'Datasheet');
      assert.equal(r[col('Power source')], u.powerEstimated ? 'Estimate' : 'Datasheet');
    }
    const sharpyRow = rows.slice(1).find((r) => r[col('Fixture #')] === String(sharpy[0].fixtureNumber));
    assert.notEqual(sharpyRow[col('Weight source')], sharpyRow[col('Power source')]);
  }
});

test('placed and unplaced rows share one CSV, and hostile names stay neutralised in the unplaced rows', () => {
  const rig = structuredClone(TEMPLATE_LIST[0]);
  rig.trussPods.push({
    id: 'broken', name: '=EVIL()', shape: 'path', path: [], width: 6, x: 0, baseY: 7, z: 0, rotationY: 0,
    motorized: false, motorMinY: 7, motorMaxY: 7,
    fixtures: [{ id: 'orphans', type: 'beam', modelName: '=HYPERLINK("x")', count: 1, dmxUniverse: 2, dmxStartChannel: 400 }],
  });
  const pw = buildShowPaperwork(rig);
  assert.ok(pw.units.length > 0 && pw.unplaced.length === 1);
  for (const csv of [patchSheetCsv(pw), instrumentScheduleCsv(pw), channelHookupCsv(pw)]) {
    const rows = parseCsv(csv);
    const header = rows[0];
    const status = header.indexOf('Status');
    assert.equal(rows.slice(1).filter((r) => r[status] === 'UNPLACED').length, 1);
    assert.equal(rows.length - 1, pw.units.length + pw.unplaced.length, 'one row per unit, placed or not');
    assert.equal(rows[rows.length - 1][status], 'UNPLACED', 'unplaced rows follow the placed ones');
    for (const r of rows.slice(1)) assert.equal(r.length, header.length);
    const unplaced = rows[rows.length - 1];
    assert.ok(unplaced.every((cell) => !/^[=+\-@]/.test(cell)), 'no cell starts with a formula character');
    assert.ok(unplaced.some((cell) => cell === "'=HYPERLINK(\"x\")"), 'hostile model name is neutralised, not dropped');
  }
});

test('a pod named "floor" keeps instrument rows in hanging order: pods first, then the stage floor, mounts contiguous', () => {
  const template = TEMPLATE_LIST.find((t) => t.trussPods.length && t.floorFx?.length);
  const rig = structuredClone(template);
  rig.trussPods[0].id = 'floor';
  const pw = buildShowPaperwork(rig);
  const rows = pw.instrumentRows;
  const firstFloor = rows.findIndex((u) => u.floor);
  assert.ok(firstFloor > 0, 'floor units come after pod units');
  assert.ok(rows.slice(firstFloor).every((u) => u.floor), 'no pod unit after the first floor unit');
  assert.ok(rows.slice(0, firstFloor).every((u) => !u.floor));
  const groups = new Map();
  for (const u of rows) groups.set(`${u.floor}:${u.positionName}`, [...(groups.get(`${u.floor}:${u.positionName}`) ?? []), u.mountOrder]);
  for (const [key, mounts] of groups) assert.deepEqual(mounts, mounts.map((_, i) => i + 1), `${key} mounts are 1..n in order`);
});
