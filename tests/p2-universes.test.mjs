import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { p2Rehearsal, schema } from './support/p2-rehearsal.mjs';

const compiler = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true } });
after(() => compiler.close());
const load = path => compiler.ssrLoadModule(`/src/${path}.ts`);
const { parseShowFile, makeShowFile } = await load('data/showFile');
const { parseRigJson, standaloneRigExportIssue } = await load('data/rigImport');
const { buildDmxPatch, fixtureScope, repatchGroupUniverse } = await load('data/dmxPatch');
const { createShowBundle, openShowBundle } = await load('data/showBundle');
const { computeInventory, equipmentInventoryCsv } = await load('data/equipmentInventory');
const { buildShowPaperwork, patchSheetCsv, channelHookupCsv } = await load('data/showPaperwork');
const { evaluatePreflight } = await load('data/preflight');
const { buildPhysicalUniverses, checkSerialTransportSafety } = await load('dmx/physicalDmx');
const { exportMvrDocument } = await load('interchange/mvr/exportMvr');
const { importMvr, readAddress } = await load('interchange/mvr/importMvr');
const { readGdtf, MODE_NAME } = await load('interchange/mvr/gdtf');
const { readArchive, writeArchive, utf8 } = await load('interchange/mvr/archive');
const { parseXml, child, list, text, attr } = await load('interchange/mvr/xml');
const { readSavedDesign, writeSavedDesign, makeDesignRecoveryShow, SAVED_DESIGN_KEY } = await load('data/savedDesign');
const { makeDefaultCrowd } = await load('data/crowdPlacement');
const parse = value => parseShowFile(JSON.stringify(value));
const write = show => makeShowFile(show.rig, show.cues, show.look, show.activeCueId, undefined, undefined, undefined, show.stage, undefined, show.crowd);
const legacy = show => {
  const file = structuredClone(show);
  file.rig.trussPods[0].fixtures = file.rig.trussPods[0].fixtures.slice(0, 2);
  file.rig.floorFx = [];
  return file;
};

test('v15 reserves logical universes while older shows and standalone rigs keep their bounds', async () => {
  const show = p2Rehearsal();
  const normal = write(legacy(show));
  assert.equal(normal.version, 6);
  const authored = write(show);
  assert.equal(authored.version, 15);
  assert.equal(authored.$schema, schema(15));
  assert.deepEqual(parse(authored).rig, authored.rig);
  assert.throws(() => parseRigJson(JSON.stringify(show.rig)), /dmxUniverse/);
  assert.match(standaloneRigExportIssue(show.rig), /Show JSON or a Show Bundle/);
  assert.equal(standaloneRigExportIssue(normal.rig), undefined);
  assert.throws(() => parse({ ...authored, version: 14, $schema: schema(14) }), /dmxUniverse/);
  for (const universe of [0, 17]) {
    const invalid = structuredClone(authored);
    invalid.rig.floorFx[0].dmxUniverse = universe;
    assert.throws(() => parse(invalid), /dmxUniverse/);
    const resolved = buildDmxPatch(invalid.rig);
    assert.ok(resolved.units.some(unit => unit.universe === universe && unit.unsupportedUniverse && !unit.effectiveStart));
  }
  const crowded = structuredClone(authored);
  crowded.rig.floorFx[0].count = 512;
  crowded.rig.floorFx[1].count = 512;
  crowded.rig.trussPods[0].fixtures = [crowded.rig.trussPods[0].fixtures[0]];
  assert.throws(() => parse(crowded), /1,024 fixture limit/);

  const film = JSON.parse(await readFile(new URL('../src/schemas/show-v14.schema.json', import.meta.url), 'utf8'));
  const prior = JSON.parse(await readFile(new URL('../src/schemas/show-v13.schema.json', import.meta.url), 'utf8'));
  const modelId = film.$defs.crowdModelWeight.properties.modelId.enum.find(id => !prior.$defs.crowdModelWeight.properties.modelId.enum.includes(id));
  const crowd = makeDefaultCrowd(show.rig);
  crowd.generatorVersion = 2;
  crowd.zones[0] = { ...crowd.zones[0], occupancy: 0, modelWeights: [{ modelId, weight: 1 }] };
  assert.equal(write({ ...show, crowd }).version, 15);
  assert.equal(write({ ...legacy(show), crowd }).version, 14);
  const bundled = await createShowBundle(authored, new Map());
  assert.deepEqual((await openShowBundle(new Uint8Array(await bundled.arrayBuffer()))).show.rig, authored.rig);
});

test('resolved U1/U2/U3 addresses stay independent in placement, reports, both CSV tables and transport safety', () => {
  const { rig, look, cues } = p2Rehearsal();
  const patch = buildDmxPatch(rig);
  assert.deepEqual(patch.universes, [1, 2, 3, 16]);
  assert.deepEqual(patch.units.map(({ universe, effectiveStart }) => [universe, effectiveStart]), [[1, 1], [2, 1], [3, 1], [3, 21], [3, 101], [16, 512]]);
  assert.equal(patch.claimed[4], undefined);
  const end = { ...rig.floorFx[1], id: 'two-slot', dmxStartChannel: 511, dmxChannels: 2 };
  const resolveEnd = group => buildDmxPatch({ ...rig, floorFx: [group] }).units.at(-1);
  assert.equal(resolveEnd(end).effectiveStart, 511);
  assert.equal(resolveEnd({ ...end, dmxStartChannel: 512 }).overflow, true);
  assert.equal(buildDmxPatch({ ...rig, floorFx: [...rig.floorFx, end] }).units.at(-1).conflict, true);
  const first = rig.trussPods[0].fixtures[0];
  const moved = repatchGroupUniverse(rig, first, fixtureScope('LX'), 3);
  assert.ok(moved.ok && moved.moved);
  assert.equal(moved.group.dmxUniverse, 3);
  assert.equal(moved.group.dmxStartChannel, 41);
  assert.equal(repatchGroupUniverse(rig, first, fixtureScope('other'), 3).ok, false);

  const report = buildShowPaperwork(rig);
  assert.deepEqual(report.universes.map(summary => summary.universe), [1, 2, 3, 16]);
  assert.deepEqual(report.units.filter(unit => unit.address === 1).map(unit => unit.absoluteAddress).sort((a, b) => a - b), [1, 513, 1025]);
  assert.match(patchSheetCsv(report), /1025/);
  assert.match(channelHookupCsv(report), /1045/);
  assert.deepEqual(computeInventory(rig).universes.map(summary => summary.universe), [1, 2, 3, 16]);
  assert.match(equipmentInventoryCsv(rig), /U3\.001/);

  const settings = { mode: 'sacn', sacnUniverse1: 3 };
  const base = { rig: legacy({ rig }).rig, showState: look, cues, dmxSettings: settings };
  const hasUnsupported = report => report.rows.some(row => row.findings.some(finding => finding.code === 'dmx_universe_unsupported'));
  assert.equal(hasUnsupported(evaluatePreflight(base)), false, 'logical U1 can map to wire universe 3');
  for (const mode of ['sacn', 'serial']) {
    const result = evaluatePreflight({ ...base, rig, dmxSettings: { ...settings, mode },
      stage: { format: 'stageforge-native-stage', version: 1, walls: [], screenEvents: [], layout: { replace: true } } });
    assert.equal(result.canArm, false);
    assert.ok(result.rows.some(row => row.hardBlock && !row.canAcknowledge && row.findings.some(f => f.code === 'dmx_universe_unsupported')));
  }
  assert.equal(checkSerialTransportSafety(rig).allowed, false);
  assert.equal(checkSerialTransportSafety(base.rig).allowed, true);
  const makePhysical = current => buildPhysicalUniverses(current, new Uint8Array(512), new Uint8Array(512),
    group => ({ dimmer: 0.8, r: group.dmxUniverse === 2 ? 1 : 0.3, g: 0.5, b: 0.7, blackout: false }));
  const supportedOnU3 = { ...first, id: 'extended-par', dmxUniverse: 3 };
  const extended = { ...base.rig, trussPods: [{ ...base.rig.trussPods[0], fixtures: [...base.rig.trussPods[0].fixtures, supportedOnU3] }] };
  assert.ok(makePhysical(base.rig).u2[0] > 0);
  assert.deepEqual(makePhysical(extended), makePhysical(base.rig));
});

test('MVR independently declares correct U3 offsets, reserves exact GDTF widths and restores native v2 only when required', () => {
  const { rig } = p2Rehearsal();
  const exported = exportMvrDocument(rig);
  const files = readArchive(exported.bytes);
  const payload = JSON.parse(utf8.decode(files.get('stageforge_show.json').data));
  assert.equal(payload.version, 2);
  const scene = child(parseXml(utf8.decode(files.get('generalscenedescription.xml').data)), 'GeneralSceneDescription');
  const emitted = list(child(child(child(child(scene, 'Scene'), 'Layers'), 'Layer'), 'ChildList'), 'Fixture');
  const byAbsolute = new Map(emitted.map(node => {
    const { universe, channel } = readAddress(node);
    return [(universe - 1) * 512 + channel, node];
  }));
  for (const [address, width] of [[1, 3], [513, 3], [1025, 20], [1045, 20], [1125, 1], [8192, 1]]) {
    const node = byAbsolute.get(address);
    assert.ok(node, `fixture at independent console address ${address}`);
    const gdtf = files.get(text(node, 'GDTFSpec').toLowerCase()).data;
    assert.equal(text(node, 'GDTFMode'), MODE_NAME);
    const mode = readGdtf(gdtf).modes[0];
    assert.equal(mode.footprint, width);
    const xml = parseXml(utf8.decode(readArchive(gdtf).get('description.xml').data));
    const modeNode = child(child(child(child(xml, 'GDTF'), 'FixtureType'), 'DMXModes'), 'DMXMode');
    const channels = list(child(modeNode, 'DMXChannels'), 'DMXChannel');
    assert.deepEqual(channels.map(channel => Number(attr(channel, 'Offset'))), Array.from({ length: width }, (_, i) => i + 1));
    if (width === 20) assert.deepEqual(mode.attributes.slice(8), Array.from({ length: 12 }, (_, i) => `Reserved_${i + 9}`));
    if (width === 3) assert.ok(mode.attributes.every(attribute => attribute.startsWith('Reserved_')));
  }
  assert.match(exported.notes.join(' '), /beam, 20 slots/);
  const restored = importMvr(exported.bytes);
  assert.deepEqual(restored.rig, parse(write(p2Rehearsal())).rig);
  assert.deepEqual(restored.interchange.mvr.uuids, exported.interchange.mvr.uuids);
  const nativeV1 = exportMvrDocument(legacy({ rig }).rig);
  assert.equal(JSON.parse(utf8.decode(readArchive(nativeV1.bytes).get('stageforge_show.json').data)).version, 1);

  const entries = [...files.values()];
  for (const [version, pattern] of [[1, /dmxUniverse/], [99, /unsupported embedded StageForge MVR/i]]) {
    const changed = entries.map(entry => entry.name === 'StageForge_show.json'
      ? { ...entry, data: utf8.encode(JSON.stringify({ ...payload, version })) } : entry);
    assert.throws(() => importMvr(writeArchive(changed)), pattern);
  }
  const foreign = entries.filter(entry => entry.name !== 'StageForge_show.json').map(entry => {
    if (entry.name !== 'GeneralSceneDescription.xml') return entry;
    const xml = utf8.decode(entry.data).replace('>1045</Address>', '>8193</Address>');
    return { ...entry, data: utf8.encode(xml) };
  });
  const unsupported = importMvr(writeArchive(foreign));
  assert.ok(unsupported.report.findings.some(finding => finding.code === 'universe-unsupported' && finding.severity === 'block'));
  assert.ok(buildDmxPatch(unsupported.rig).units.some(unit => unit.universe === 3 && unit.start === 1));
});

test('one local recovery record preserves stage and crowd and tolerates inaccessible or opaque data and a failed atomic write', async () => {
  const { rig } = p2Rehearsal();
  const { stage } = JSON.parse(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));
  const crowd = makeDefaultCrowd(rig);
  const content = { rig, stage, crowd };
  const previous = { rig: { ...legacy({ rig }).rig, name: 'Older legacy rig' } };
  let raw = null;
  let denyWrite = false;
  const storage = { getItem: () => raw, setItem(key, value) {
    assert.equal(key, SAVED_DESIGN_KEY);
    if (denyWrite) throw new Error('quota');
    raw = value;
  } };
  assert.equal(readSavedDesign(storage).status, 'missing');
  raw = JSON.stringify(previous.rig);
  assert.deepEqual(readSavedDesign(storage).record.current.rig, previous.rig);
  denyWrite = true;
  assert.throws(() => writeSavedDesign({ current: content, previous }, storage), /quota/);
  assert.deepEqual(JSON.parse(raw), previous.rig);
  denyWrite = false;
  writeSavedDesign({ current: content, previous }, storage);
  const reopened = readSavedDesign(storage);
  assert.equal(reopened.status, 'ready');
  assert.deepEqual(reopened.record.current.stage, stage);
  assert.deepEqual(reopened.record.current.crowd, crowd);
  assert.equal(reopened.record.previous.rig.name, previous.rig.name);
  const recovery = makeDesignRecoveryShow(reopened.record.current);
  assert.equal(recovery.version, 15);
  assert.equal(recovery.timeline.durationMs, 16000);
  assert.deepEqual(recovery.stage.screenEvents, stage.screenEvents);
  raw = 'opaque broken JSON';
  assert.equal(readSavedDesign(storage).status, 'corrupt');
  raw = JSON.stringify({ format: 'stageforge-local-design', version: 88 });
  assert.equal(readSavedDesign(storage).status, 'newer');
  assert.equal(readSavedDesign({ getItem: () => { throw new Error('denied'); } }).status, 'inaccessible');
});
