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

const { exportMvr, exportMvrDocument, fixtureKey, FIXTURE_XSD_ORDER } = await compiler.ssrLoadModule('/src/interchange/mvr/exportMvr.ts');
const { importMvr, readAddress, readAddresses } = await compiler.ssrLoadModule('/src/interchange/mvr/importMvr.ts');
const { readArchive, writeArchive, utf8 } = await compiler.ssrLoadModule('/src/interchange/mvr/archive.ts');
const { parseXml, list, child, attr, text } = await compiler.ssrLoadModule('/src/interchange/mvr/xml.ts');
const { compose, readPose, parseMatrix, readMatrix, matrixText, poseMatrix } = await compiler.ssrLoadModule('/src/interchange/mvr/coords.ts');
const { readGdtf, profileArchive, PROFILES, classifyGdtf, physicalAt } = await compiler.ssrLoadModule('/src/interchange/mvr/gdtf.ts');
const { placeFixtures, mountSlotIndex } = await compiler.ssrLoadModule('/src/data/fixturePlacement.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { makeShowFile, parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { createBlankDesign, podWorldPoint, withPlatforms } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');

const fixtureShow = parseShowFile(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));
const MATRIX_XSD = /^(\{-?[0-9]+\.?[0-9]*(e-?[0-9]*)?(,-?[0-9]+\.?[0-9]*(e-?[0-9]*)?){2}\}){4}$/;
const wrap = (d) => Math.abs(((d + 540) % 360) - 180);

function scene(bytes) {
  const files = readArchive(bytes);
  const doc = parseXml(utf8.decode(files.get('generalscenedescription.xml').data));
  const root = child(doc, 'GeneralSceneDescription');
  const layer = list(child(child(root, 'Scene'), 'Layers'), 'Layer')[0];
  return { files, root, childList: child(layer, 'ChildList') };
}

/** The acceptance reference rig: deck at the origin, a front truss at (0, 8, −4) yawed +30°, two hung heads and a floor head. */
function referenceRig() {
  const rig = withPlatforms({ ...createBlankDesign(), name: 'Reference rig' }, [
    { id: 'deck', name: 'Deck', x: 0, z: 0, width: 8, depth: 4, height: 1 },
  ]);
  rig.trussPods = [{
    id: 'front', name: 'Front truss', shape: 'box', width: 6, x: 0, z: -4, baseY: 8, rotationY: (30 * Math.PI) / 180,
    motorized: false, motorMinY: 8, motorMaxY: 8,
    fixtures: [{ id: 'spots', type: 'beam', modelName: 'Spot', count: 2, dmxUniverse: 2, dmxStartChannel: 1 }],
  }];
  rig.floorFx = [{ id: 'floor', type: 'floor_beam', modelName: 'Floor beam', count: 1, x: 2, z: 1, spread: 0, dmxUniverse: 1, dmxStartChannel: 101 }];
  rig.ledWall = { ...rig.ledWall, enabled: true };
  rig.audioRig = { ...rig.audioRig, lineArrays: true, boxesPerSide: 6 };
  return parseRigJson(JSON.stringify(rig));
}

test('the export is a conforming MVR 1.6 archive with GDTF profiles and GLB geometry', () => {
  const rig = RIG_TEMPLATES.arena_mainstage;
  const { files, root, childList } = scene(exportMvr(rig, undefined, '1.3.0'));
  assert.equal(attr(root, 'verMajor'), '1');
  assert.equal(attr(root, 'verMinor'), '6');
  assert.equal(attr(root, 'provider'), 'StageForge');
  for (const name of files.keys()) assert.ok(!name.includes('/') && !name.includes('\\'), `${name} is in the root`);
  for (const file of ['stageforge@moving_beam.gdtf', 'stageforge@moving_wash.gdtf', 'stageforge@strobe.gdtf', 'stageforge@blinder.gdtf', 'stageforge@laser.gdtf']) {
    assert.ok(files.has(file), `${file} is bundled`);
  }
  const fixtures = list(childList, 'Fixture');
  assert.equal(fixtures.length, placeFixtures(rig).length);
  const uuids = new Set();
  for (const kind of ['Fixture', 'Truss', 'VideoScreen', 'SceneObject', 'FocusPoint']) {
    for (const node of list(childList, kind)) {
      const uuid = attr(node, 'uuid');
      assert.match(uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
      assert.ok(!uuids.has(uuid), 'uuids are unique');
      uuids.add(uuid);
      assert.match(text(node, 'Matrix'), MATRIX_XSD);
    }
  }
  for (const truss of list(childList, 'Truss')) {
    for (const geo of list(child(truss, 'Geometries'), 'Geometry3D')) assert.ok(files.has(attr(geo, 'fileName').toLowerCase()));
  }
  // The same rig exports the same uuids every time.
  const again = scene(exportMvr(rig, undefined, '1.3.0'));
  assert.deepEqual(list(again.childList, 'Fixture').map((f) => attr(f, 'uuid')), fixtures.map((f) => attr(f, 'uuid')));
});

test('fixtures, trusses, screens and hangs land within 1 mm and 0.05° of their StageForge placement', () => {
  const rig = referenceRig();
  const stage = { format: 'stageforge-native-stage', version: 1, walls: [{ id: 'main-led' }, { id: 'side', label: 'Side', x: 6, y: 3, z: 1, width: 2, height: 1.5, yaw: -25 }], screenEvents: [],
    layout: { hangs: [{ x: -6, y: 7, z: 2, yaw: 17, tilt: -5, count: 6, splay: 4 }] } };
  const { childList } = scene(exportMvr(rig, stage));
  const units = placeFixtures(rig);
  const fixtures = list(childList, 'Fixture');
  units.forEach((unit, i) => {
    const pose = readPose(parseMatrix(text(fixtures[i], 'Matrix')));
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(pose.position[axis] - unit.position[axis]) <= 0.001);
    assert.ok(wrap(pose.yawDeg - (unit.yaw * 180) / Math.PI) <= 0.05);
    assert.equal(pose.standing, unit.floor, 'only the floor head stands');
    const address = Number(text(child(fixtures[i], 'Addresses'), 'Address') ?? child(fixtures[i], 'Addresses').Address[0]['#text']);
    assert.equal(address, (unit.universe - 1) * 512 + unit.address, 'absolute address = (universe − 1) × 512 + channel');
  });
  const truss = readPose(parseMatrix(text(list(childList, 'Truss')[0], 'Matrix')));
  assert.ok(Math.abs(truss.position.y - 8) < 0.001 && Math.abs(truss.position.z + 4) < 0.001);
  assert.ok(wrap(truss.yawDeg - 30) <= 0.05);
  const side = list(childList, 'VideoScreen').find((s) => attr(s, 'name') === 'Side');
  const sidePose = readPose(parseMatrix(text(side, 'Matrix')));
  assert.ok(wrap(sidePose.yawDeg + 25) <= 0.05);
  assert.ok(Math.abs(sidePose.position.x - 6) < 0.001 && Math.abs(sidePose.position.y - 3) < 0.001);
  const hang = list(childList, 'SceneObject').find((s) => attr(s, 'name').startsWith('PA hang'));
  assert.ok(wrap(readPose(parseMatrix(text(hang, 'Matrix'))).yawDeg - 17) <= 0.05);
});

test('a StageForge MVR re-imports losslessly, and a truss moved in another tool merges by uuid', () => {
  const rig = fixtureShow.rig, stage = fixtureShow.stage;
  const bytes = exportMvr(rig, stage);
  const back = importMvr(bytes);
  assert.equal(back.report.source, 'stageforge');
  assert.deepEqual(back.rig, parseRigJson(JSON.stringify(rig)));
  assert.deepEqual(back.stage, stage);
  assert.deepEqual(back.report.notes, []);

  // Move the first truss 1 m upstage (MVR +Y) in "another tool" and re-import.
  const { files } = scene(bytes);
  const xml = utf8.decode(files.get('generalscenedescription.xml').data);
  const pod = rig.trussPods[0];
  const before = matrixText(poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, (pod.rotationY * 180) / Math.PI));
  const moved = matrixText(poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z - 1 }, (pod.rotationY * 180) / Math.PI));
  assert.ok(xml.includes(before));
  const edited = writeArchive([...files.values()].map((f) => (f.name === 'GeneralSceneDescription.xml'
    ? { name: f.name, data: utf8.encode(xml.replace(before, moved)) } : f)));
  const merged = importMvr(edited);
  assert.ok(Math.abs(merged.rig.trussPods[0].z - (pod.z - 1)) < 0.001);
  assert.match(merged.report.notes.join(' '), /Moved/);
  assert.deepEqual(merged.stage, stage, 'cues, walls and wall cues are untouched');
});

function foreignMvr({ fixtures, extra = '', gdtf = {} }) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="OtherTool" providerVersion="2">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Venue rig"><ChildList>
  <Truss uuid="aaaaaaaa-0000-4000-8000-000000000001" name="LX1"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,2000,7000}</Matrix>
   <Geometries><Geometry3D fileName="truss.glb"/></Geometries><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>${fixtures}</ChildList></Truss>
  ${extra}
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>\u0000`;
  return writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(xml) },
    { name: 'truss.glb', data: gdtf.truss },
    ...Object.entries(gdtf).filter(([k]) => k !== 'truss').map(([name, data]) => ({ name, data })),
  ]);
}

test('a foreign MVR becomes trusses, typed fixtures, screens and props with its patch preserved', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const fixture = (n, x, address, spec = 'Vendor@Spot.gdtf') => `<Fixture uuid="bbbbbbbb-0000-4000-8000-00000000000${n}" name="Spot ${n}">
    <Matrix>{1,0,0}{0,1,0}{0,0,1}{${x},0,-300}</Matrix><GDTFSpec>${spec}</GDTFSpec><GDTFMode>StageForge</GDTFMode>
    <FixtureID>${n}</FixtureID><FixtureIDNumeric>${n}</FixtureIDNumeric><UnitNumber>1</UnitNumber>${address}</Fixture>`;
  const bytes = foreignMvr({
    fixtures: fixture(1, -1000, '<Addresses><Address break="0">513</Address></Addresses>') +
      fixture(2, 1000, '<Addresses><Address>2.17</Address></Addresses>', 'Vendor@Spot') +
      fixture(3, 0, '<Addresses><Address break="0">1537</Address></Addresses>'),
    extra: `<VideoScreen uuid="cccccccc-0000-4000-8000-000000000001" name="IMAG L"><Matrix>{0.906308,0.422618,0}{-0.422618,0.906308,0}{0,0,1}{-6000,0,4000}</Matrix>
      <Geometries><Geometry3D fileName="screen.glb"/></Geometries><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric></VideoScreen>
      <SceneObject uuid="dddddddd-0000-4000-8000-000000000001" name="Drum riser"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix>
      <Geometries><Geometry3D fileName="riser.glb"/></Geometries><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric></SceneObject>
      <FocusPoint uuid="eeeeeeee-0000-4000-8000-000000000001" name="DSC"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-2000,0}</Matrix><Geometries/></FocusPoint>`,
    gdtf: {
      truss: boxGlb(8, 0.3, 0.3),
      'Vendor@Spot.gdtf': profileArchive(PROFILES.beam),
      'screen.glb': boxGlb(3, 2, 0.1),
      'riser.glb': boxGlb(3, 0.6, 2, { base: true }),
    },
  });
  const { rig, stage, report } = importMvr(bytes);
  assert.equal(report.source, 'mvr');
  assert.equal(report.fixtures, 3);
  assert.equal(rig.trussPods.length, 1);
  const pod = rig.trussPods[0];
  assert.equal(pod.width, 8);
  assert.ok(Math.abs(pod.baseY - 7) < 0.001 && Math.abs(pod.z + 2) < 0.001, 'MVR (0, 2000, 7000) mm → StageForge (0, 7, −2) m');
  assert.deepEqual(pod.fixtures.map((g) => g.type), ['beam', 'beam', 'beam']);
  // Ordered along the truss: x = −1 m (513 → U2.1), 0 m (1537 → U4.1), +1 m ("2.17").
  assert.deepEqual(pod.fixtures.map((g) => [g.dmxUniverse, g.dmxStartChannel]), [[2, 1], [4, 1], [2, 17]]);
  assert.match(report.notes.join(' '), /focus point/);
  const wall = stage.walls.find((w) => w.label === 'IMAG L');
  assert.ok(wall && Math.abs(wall.yaw - 25) < 0.05 && Math.abs(wall.width - 3) < 0.001 && Math.abs(wall.height - 2) < 0.001);
  assert.ok(Math.abs(wall.y - 4) < 0.001 && Math.abs(wall.x + 6) < 0.001);
  assert.deepEqual(stage.layout.props, [{ x: 0, z: 0, type: 'scenic', height: 0.6 }]);
});

test('GDTF reading follows Offset, not document order, and classification uses attributes and beam type', () => {
  const xml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="Odd Wash" Manufacturer="Vendor" Description="" FixtureTypeID="6B1E2C3D-4F50-4A61-8B72-93A4B5C6D7E8">
    <Geometries><Geometry Name="Base"><Beam Name="Beam" BeamType="Wash" BeamAngle="30"/></Geometry></Geometries>
    <DMXModes><DMXMode Name="16bit" Geometry="Base"><DMXChannels>
      <DMXChannel Offset="5,6" Geometry="Base"><LogicalChannel Attribute="Tilt"/></DMXChannel>
      <DMXChannel Offset="1,2" Geometry="Base"><LogicalChannel Attribute="Pan"/></DMXChannel>
      <DMXChannel Offset="3" Geometry="Base"><LogicalChannel Attribute="Dimmer"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>\u0000`;
  const summary = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(xml) }]));
  assert.deepEqual(summary.modes, [{ name: '16bit', footprint: 6, breaks: [{ dmxBreak: 1, footprint: 6 }], totalSlots: 6, attributes: ['Tilt', 'Pan', 'Dimmer'] }]);
  assert.equal(classifyGdtf(summary, '16bit', false), 'wash');
  assert.equal(classifyGdtf(summary, '16bit', true), 'floor_beam');
  assert.equal(readGdtf(profileArchive(PROFILES.strobe)).modes[0].footprint, 2);
  assert.equal(classifyGdtf(readGdtf(profileArchive(PROFILES.strobe)), 'StageForge', false), 'strobe');
  assert.equal(classifyGdtf(readGdtf(profileArchive(PROFILES.laser)), 'StageForge', false), 'laser');
});

test('malformed archives fail with a readable message', () => {
  assert.throws(() => importMvr(new Uint8Array([80, 75, 3, 4])), /Cannot read this MVR archive/);
  assert.throws(() => importMvr(writeArchive([{ name: 'other.xml', data: utf8.encode('<x/>') }])), /no GeneralSceneDescription/);
  assert.throws(() => importMvr(writeArchive([{ name: 'GeneralSceneDescription.xml', data: utf8.encode('<GeneralSceneDescription verMajor="2" verMinor="0"/>') }])), /not supported/);
});

/** Rewrite the scene XML of an archive, keeping every other entry. */
function editScene(bytes, edit) {
  const { files } = scene(bytes);
  return writeArchive([...files.values()].map((f) => (f.name === 'GeneralSceneDescription.xml'
    ? { name: f.name, data: utf8.encode(edit(utf8.decode(f.data))) } : f)));
}

test('a re-import refuses far truss moves, ignores whole turns of yaw and reports moves it does not merge', () => {
  const rig = referenceRig();
  rig.trussPods[0].rotationY += 2 * Math.PI; // 390°: the same bearing, so not a move
  const stage = { format: 'stageforge-native-stage', version: 1, walls: [{ id: 'main-led' }, { id: 'side', label: 'Side', x: 6, y: 3, z: 1, width: 2, height: 1.5, yaw: -25 }], screenEvents: [] };
  const bytes = exportMvr(rig, stage);
  const same = importMvr(bytes);
  assert.deepEqual(same.report.notes, []);
  assert.deepEqual(same.rig, parseRigJson(JSON.stringify(rig)));

  const pod = rig.trussPods[0];
  const trussMatrix = matrixText(poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, (pod.rotationY * 180) / Math.PI));
  const far = importMvr(editScene(bytes, (xml) => xml.replace(trussMatrix, matrixText(poseMatrix({ x: 20000, y: pod.baseY, z: pod.z }, 30)))));
  assert.equal(far.rig.trussPods[0].x, pod.x, 'a move beyond 10 km is refused');
  assert.match(far.report.notes.join(' '), /1 truss move beyond 10000 m was ignored/);

  const screenMatrix = matrixText(poseMatrix({ x: 6, y: 3, z: 1 }, -25));
  const screenMoved = importMvr(editScene(bytes, (xml) => {
    assert.ok(xml.includes(screenMatrix));
    return xml.replace(screenMatrix, matrixText(poseMatrix({ x: 4, y: 3, z: 1 }, -25)));
  }));
  assert.deepEqual(screenMoved.stage, same.stage, 'the payload stays the source of truth');
  assert.match(screenMoved.report.notes.join(' '), /1 other moved object .* was not merged/);
});

test('fixture UUID keys cannot collide when IDs contain separators', () => {
  const keys = [
    fixtureKey({ podId: 'a:b', group: { id: 'c' }, index: 0 }),
    fixtureKey({ podId: 'a', group: { id: 'b:c' }, index: 0 }),
    fixtureKey({ podId: 'floor', group: { id: 'x' }, index: 0 }),
    fixtureKey({ group: { id: 'x' }, index: 0 }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('hung units spread across mount slots exactly as the renderer places them', () => {
  assert.deepEqual([0, 1, 2].map((n) => mountSlotIndex(n, 3, 7)), [1, 3, 5]);
  for (let slots = 1; slots <= 24; slots++) {
    for (let units = 1; units <= slots; units++) {
      const picks = Array.from({ length: units }, (_, n) => mountSlotIndex(n, units, slots));
      assert.equal(new Set(picks).size, units, `${units} units on ${slots} slots use distinct slots`);
      assert.ok(picks.every((p, i) => p >= 0 && p < slots && (i === 0 || p > picks[i - 1])));
    }
  }
});

test('generic GDTF shutters are open at DMX 0, as the simulated desk writes no strobe', () => {
  for (const profile of [PROFILES.beam, PROFILES.strobe, PROFILES.laser]) {
    const files = readArchive(profileArchive(profile), 'GDTF');
    const doc = parseXml(utf8.decode(files.get('description.xml').data));
    const mode = list(child(child(child(doc, 'GDTF'), 'FixtureType'), 'DMXModes'), 'DMXMode')[0];
    const channel = list(child(mode, 'DMXChannels'), 'DMXChannel').find((c) => attr(c, 'InitialFunction').includes('.Shutter1.'));
    assert.ok(channel, `${profile.file} has a shutter channel`);
    assert.match(attr(channel, 'InitialFunction'), /\.Shutter1\.Open$/);
    const fns = list(list(channel, 'LogicalChannel')[0], 'ChannelFunction');
    assert.deepEqual(fns.map((f) => [attr(f, 'Attribute'), attr(f, 'DMXFrom')]), [['Shutter1', '0/1'], ['Shutter1Strobe', '1/1']]);
  }
});

test('hostile MVR files stay bounded: entry counts, absurd matrices, DTDs, far objects, names and truss counts', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const many = Array.from({ length: 4097 }, (_, i) => ({ name: `f${i}.bin`, data: new Uint8Array(1) }));
  assert.throws(() => readArchive(writeArchive(many)), /more than 4096 files/);

  const identity = matrixText(poseMatrix({ x: 0, y: 0, z: 0 }, 0));
  assert.equal(matrixText(parseMatrix('{1e12,0,0}{0,1,0}{0,0,1}{0,0,0}')), identity);
  assert.equal(matrixText(parseMatrix('{1,0,0}{0,1,0}{0,0,1}{Infinity,0,0}')), identity);

  assert.equal(readMatrix('{1,0,0}{0,1,0}{0,0,1}{1e12,0,0}'), undefined, 'absurd is unknown, not the origin');
  assert.equal(readMatrix('{1,0,0}{0,1,0}{0,0,1}{,0,0}'), undefined);
  assert.equal(matrixText(readMatrix(undefined)), identity, 'an absent matrix is the identity');

  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY b "c">]><a>&b;</a>'), /DTD/);
  // Overlapping CDATA and comment sections must not hide a DTD from the check.
  assert.throws(() => parseXml('<r><![CDATA[ <!-- ]]><!DOCTYPE r [<!ENTITY a "EXPANDED">]><k>&a;</k><x a="-->"/></r>'), /DTD/);
  assert.throws(() => parseXml('<!-- <!DOCTYPE x> --><a/>'), /DTD/);
  assert.equal(child(parseXml('<a b="&lt;&amp;"/>'), 'a')['@_b'], '<&', 'predefined entities still decode');

  const longName = 'L'.repeat(300);
  const trusses = Array.from({ length: 300 }, (_, i) => `<Truss uuid="aaaaaaaa-0000-4000-8000-${String(i + 2).padStart(12, '0')}" name="${i ? `T${i}` : longName}">
    <Matrix>{1,0,0}{0,1,0}{0,0,1}{${i * 1000},20000,6000}</Matrix><Geometries><Geometry3D fileName="truss.glb"/></Geometries>
    <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric></Truss>`).join('');
  const farObject = `<SceneObject uuid="dddddddd-0000-4000-8000-000000000009" name="Lost"><Matrix>{1,0,0}{0,1,0}{0,0,1}{20000000,0,0}</Matrix>
    <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric></SceneObject>`;
  const { rig, report } = importMvr(foreignMvr({ fixtures: '', extra: trusses + farObject, gdtf: { truss: boxGlb(3, 0.3, 0.3) } }));
  assert.equal(rig.trussPods.length, 256);
  assert.equal(report.trusses, 256);
  assert.match(report.notes.join(' '), /Only the first 256 of 301 trusses/);
  assert.match(report.notes.join(' '), /1 object more than 10000 m from the origin was skipped/);
  assert.equal(report.sceneObjects, 0);
  assert.ok(rig.trussPods.some((p) => p.name === 'L'.repeat(128)), 'long names are cut to 128 characters');
});

test('trusses that share a UUID keep their own fixtures', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const spot = (n) => `<Fixture uuid="bbbbbbbb-0000-4000-8000-00000000010${n}" name="Spot ${n}"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,-300}</Matrix>
    <GDTFSpec></GDTFSpec><GDTFMode></GDTFMode><FixtureID>${n}</FixtureID><FixtureIDNumeric>${n}</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`;
  const twin = `<Truss uuid="aaaaaaaa-0000-4000-8000-000000000001" name="LX2"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-6000,7000}</Matrix>
    <Geometries><Geometry3D fileName="truss.glb"/></Geometries><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
    <ChildList>${spot(2)}${spot(3)}</ChildList></Truss>`;
  const { rig, report } = importMvr(foreignMvr({ fixtures: spot(1), extra: twin, gdtf: { truss: boxGlb(6, 0.3, 0.3) } }));
  assert.equal(report.trusses, 2);
  assert.deepEqual(rig.trussPods.map((p) => [p.name, p.fixtures.length]), [['LX1', 1], ['LX2', 2]]);
});

test('absurd matrices are unknown placements, and a damaged stage overlay is left out, not fatal', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const rig = referenceRig();
  const stage = { format: 'stageforge-native-stage', version: 1, walls: [{ id: 'main-led' }], screenEvents: [] };
  const bytes = exportMvr(rig, stage);
  const pod = rig.trussPods[0];
  const trussMatrix = matrixText(poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, (pod.rotationY * 180) / Math.PI));
  const absurd = importMvr(editScene(bytes, (xml) => xml.replace(trussMatrix, '{1,0,0}{0,1,0}{0,0,1}{1e12,0,0}')));
  assert.deepEqual(absurd.rig.trussPods[0], parseRigJson(JSON.stringify(rig)).trussPods[0], 'the truss stays where the payload put it');
  assert.ok(!absurd.report.notes.some((n) => n.startsWith('Moved')));
  assert.match(absurd.report.notes.join(' '), /object.? with an unreadable or absurd matrix (was|were) ignored/);

  const damaged = (() => {
    const { files } = scene(bytes);
    return writeArchive([...files.values()].map((f) => (f.name === 'StageForge_show.json'
      ? { name: f.name, data: utf8.encode(JSON.stringify({ ...JSON.parse(utf8.decode(f.data)), stage: 5 })) } : f)));
  })();
  const back = importMvr(damaged);
  assert.equal(back.report.source, 'stageforge');
  assert.equal(back.stage, undefined);
  assert.deepEqual(back.rig, parseRigJson(JSON.stringify(rig)));
  assert.match(back.report.notes.join(' '), /screens, screen cues and layout in this file were unreadable/);

  // A foreign truss with an absurd matrix is skipped with its fixtures, not dropped at the origin.
  const spot = `<Fixture uuid="bbbbbbbb-0000-4000-8000-000000000201" name="Spot"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,-300}</Matrix>
    <GDTFSpec></GDTFSpec><GDTFMode></GDTFMode><FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`;
  const lost = `<Truss uuid="aaaaaaaa-0000-4000-8000-000000000301" name="Lost"><Matrix>{1,0,0}{0,1,0}{0,0,1}{NaN,0,0}</Matrix>
    <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric><ChildList>${spot}</ChildList></Truss>`;
  const foreign = importMvr(foreignMvr({ fixtures: '', extra: lost, gdtf: { truss: boxGlb(6, 0.3, 0.3) } }));
  assert.deepEqual(foreign.rig.trussPods.map((p) => p.name), ['LX1']);
  assert.equal(foreign.report.fixtures, 0);
  assert.match(foreign.report.notes.join(' '), /2 objects with an unreadable or absurd matrix were skipped/);
});

test('GDTF reader skips unused entries, bounds Offset lists, caps distinct GDTFs and classifies RGB pars cleanly', () => {
  // H3: A GDTF with a large unused texture entry must still read description.xml without inflating the texture.
  const validXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="LED Par" Manufacturer="Acme">
    <Geometries><Geometry Name="Base"><Beam Name="Beam" BeamType="Wash" BeamAngle="25"/></Geometry></Geometries>
    <DMXModes><DMXMode Name="RGBS" Geometry="Base"><DMXChannels>
      <DMXChannel Offset="1" Geometry="Beam"><LogicalChannel Attribute="Dimmer"/></DMXChannel>
      <DMXChannel Offset="2" Geometry="Beam"><LogicalChannel Attribute="ColorAdd_R"/></DMXChannel>
      <DMXChannel Offset="3" Geometry="Beam"><LogicalChannel Attribute="ColorAdd_G"/></DMXChannel>
      <DMXChannel Offset="4" Geometry="Beam"><LogicalChannel Attribute="ColorAdd_B"/></DMXChannel>
      <DMXChannel Offset="5" Geometry="Beam"><LogicalChannel Attribute="Shutter1Strobe"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes>
  </FixtureType></GDTF>`;
  const gdtfWithExtra = writeArchive([
    { name: 'description.xml', data: utf8.encode(validXml) },
    { name: 'huge.png', data: new Uint8Array(1024) },
  ]);
  // Patch central directory of huge.png so its declared originalSize is 200 MiB (must be skipped by only filter!).
  const patched = new Uint8Array(gdtfWithExtra);
  const needle = utf8.encode('huge.png');
  let cdOff = -1;
  for (let i = 0; i <= patched.length - 46; i++) {
    if (patched[i] === 0x50 && patched[i + 1] === 0x4b && patched[i + 2] === 0x01 && patched[i + 3] === 0x02) {
      const nameLen = new DataView(patched.buffer).getUint16(i + 28, true);
      if (nameLen === needle.length && needle.every((b, k) => patched[i + 46 + k] === b)) { cdOff = i; break; }
    }
  }
  assert.ok(cdOff > 0);
  new DataView(patched.buffer).setUint32(cdOff + 24, 200 * 1024 * 1024, true);
  const summary = readGdtf(patched);
  assert.equal(summary.name, 'LED Par');
  // M6: Static RGB par with auxiliary Shutter1Strobe must NOT be misclassified as strobe.
  assert.equal(classifyGdtf(summary, 'RGBS', false), 'blinder');

  // M2: Huge Offset list and 1e20 offset must stay bounded and never overflow the call stack.
  const hugeOffset = '1,'.repeat(200_000) + '1e20,12';
  const offsetXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="Hostile" Manufacturer="Bad">
    <Geometries/><DMXModes><DMXMode Name="M" Geometry="Base"><DMXChannels>
      <DMXChannel Offset="${hugeOffset}" Geometry="Base"><LogicalChannel Attribute="Dimmer"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes>
  </FixtureType></GDTF>`;
  const bounded = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(offsetXml) }]));
  assert.ok(bounded.modes[0].footprint <= 512);

  // H3: > 64 distinct GDTF files in one MVR are capped with a report note.
  const extraGdtfs = {};
  const fixtures = Array.from({ length: 70 }, (_, i) => {
    const specName = `spec-${i}.gdtf`;
    extraGdtfs[specName] = writeArchive([{ name: 'description.xml', data: utf8.encode(validXml) }]);
    return `<Fixture uuid="bbbbbbbb-0000-4000-8000-${String(i + 1).padStart(12, '0')}" name="Par ${i + 1}">
      <Matrix>{1,0,0}{0,1,0}{0,0,1}{${i * 200},0,-300}</Matrix>
      <GDTFSpec>${specName}</GDTFSpec><GDTFMode>RGBS</GDTFMode>
      <FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber>
      <Addresses><Address break="0">${1 + i}</Address></Addresses></Fixture>`;
  }).join('');
  const capped = importMvr(foreignMvr({ fixtures, gdtf: extraGdtfs }));
  assert.match(capped.report.notes.join(' '), /Only the first 64 distinct GDTF profiles/);
});

test('hostile GLB, missing verMajor, corrupt StageForge payload, GroupObject offsets, path spans and readAddress edge cases', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  // H4: Hostile GLB with scalar min/max must NOT throw TypeError during importMvr.
  const badPayload = utf8.encode(JSON.stringify({ meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min: 5, max: 5 }] }));
  const jsonLen = (badPayload.length + 3) & ~3;
  const badGlb = new Uint8Array(20 + jsonLen);
  const dv = new DataView(badGlb.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, badGlb.length, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  badGlb.set(badPayload, 20); badGlb.fill(0x20, 20 + badPayload.length);
  const hostileGlbImport = importMvr(foreignMvr({ fixtures: '', gdtf: { truss: badGlb } }));
  assert.equal(hostileGlbImport.rig.trussPods.length, 1);

  // L2: Missing verMajor gives a readable message without "undefined".
  const noVer = writeArchive([{ name: 'GeneralSceneDescription.xml', data: utf8.encode('<GeneralSceneDescription><Scene/></GeneralSceneDescription>') }]);
  assert.throws(() => importMvr(noVer), (e) => e instanceof Error && !/undefined/.test(e.message) && /MVR version/.test(e.message));

  // L4: StageForge-marked MVR with corrupt JSON payload falls back to foreign import with a note.
  const exported = exportMvr(referenceRig());
  const { files } = scene(exported);
  const corruptPayload = writeArchive([...files.values()].map((f) => (
    f.name === 'StageForge_show.json' ? { name: f.name, data: utf8.encode('{bad json') } : f
  )));
  const fallback = importMvr(corruptPayload);
  assert.equal(fallback.report.source, 'mvr');
  assert.match(fallback.report.notes.join(' '), /embedded StageForge payload was unreadable/);

  // H6: Yawed foreign truss with offset Geometry3D (1 m along local X) + GroupObject offset (+2 m X).
  const yawDeg = 30;
  const rad = yawDeg * Math.PI / 180;
  const yawedTruss = `<Truss uuid="aaaaaaaa-0000-4000-8000-000000000099" name="Yawed">
    <Matrix>${matrixText(poseMatrix({ x: 1, y: 6, z: 2 }, yawDeg))}</Matrix>
    <Geometries><Geometry3D fileName="truss.glb"><Matrix>{1,0,0}{0,1,0}{0,0,1}{1000,0,0}</Matrix></Geometry3D></Geometries>
    <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric></Truss>`;
  const grouped = `<GroupObject uuid="eeeeeeee-0000-4000-8000-000000000001" name="Grp">
    <Matrix>{1,0,0}{0,1,0}{0,0,1}{2000,10000,0}</Matrix>
    <ChildList><Fixture uuid="bbbbbbbb-0000-4000-8000-000000000999" name="Grouped Spot">
      <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,5000}</Matrix><GDTFSpec></GDTFSpec><GDTFMode></GDTFMode>
      <FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber>
      <Addresses><Address break="0">1</Address></Addresses></Fixture></ChildList></GroupObject>`;
  const geoImport = importMvr(foreignMvr({ fixtures: '', extra: yawedTruss + grouped, gdtf: { truss: boxGlb(4, 0.3, 0.3) } }));
  const pod = geoImport.rig.trussPods.find((p) => p.name === 'Yawed');
  assert.ok(Math.abs(pod.x - (1 + Math.cos(rad) * 1)) < 0.005);
  assert.ok(Math.abs(pod.z - (2 - Math.sin(rad) * 1)) < 0.005);
  const posPod = geoImport.rig.trussPods.find((p) => p.name.startsWith('Imported position'));
  assert.ok(Math.abs(posPod.x - 2) < 0.005, 'GroupObject +2 m X offset applied to child fixture');

  // H6: Path truss exported Geometry3D span matrix composes to match podWorldPoint ends.
  const pathRig = createBlankDesign();
  pathRig.trussPods = [{
    id: 'path-1', name: 'Bent', shape: 'path', width: 5, x: 2, baseY: 6, z: -1, rotationY: 0.4,
    motorized: false, motorMinY: 6, motorMaxY: 6,
    path: [{ x: 0, z: 0 }, { x: 0, z: 4 }],
    fixtures: [],
  }];
  const pathMvr = scene(exportMvr(pathRig));
  const exportedTruss = list(pathMvr.childList, 'Truss')[0];
  const trussMat = parseMatrix(text(exportedTruss, 'Matrix'));
  const spanGeo = list(child(exportedTruss, 'Geometries'), 'Geometry3D')[0];
  const spanMat = compose(trussMat, parseMatrix(text(spanGeo, 'Matrix')));
  const spanCenter = readPose(spanMat).position;
  const p0 = podWorldPoint(pathRig.trussPods[0], { x: 0, z: 0 });
  const p1 = podWorldPoint(pathRig.trussPods[0], { x: 0, z: 4 });
  assert.ok(Math.abs(spanCenter.x - (p0.x + p1.x) / 2) < 0.01);
  assert.ok(Math.abs(spanCenter.z - (p0.z + p1.z) / 2) < 0.01);

  // H6: readAddress edge cases and break ordering.
  const addr = (entries) => readAddress({ Addresses: { Address: entries } });
  assert.equal(addr('0'), undefined);
  assert.equal(addr('-5'), undefined);
  assert.equal(addr('1e3'), undefined);
  assert.equal(addr('1.513'), undefined);
  assert.equal(addr('32769.1'), undefined);
  assert.equal(addr('1.0'), undefined);
  assert.deepEqual(addr('2.10'), { universe: 2, channel: 10 });
  assert.deepEqual(addr([{ '@_break': '2', '#text': '100' }, { '@_break': '0', '#text': '513' }]), { universe: 2, channel: 1 });

  // H6: > 1024 fixtures triggers cap note and unpatched overflow drops excess cleanly.
  const manyFixtures = Array.from({ length: 1030 }, (_, i) => `<Fixture uuid="bbbbbbbb-0000-4000-8000-${String(i + 1).padStart(12, '0')}" name="Spot ${i + 1}">
    <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,5000}</Matrix><GDTFSpec></GDTFSpec><GDTFMode></GDTFMode>
    <FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`).join('');
  const overflow = importMvr(foreignMvr({ fixtures: manyFixtures }));
  assert.match(overflow.report.notes.join(' '), /Only the first 1024 of 1030 fixtures/);
  assert.match(overflow.report.notes.join(' '), /did not fit in two universes/);
});

test('DMX break 0 vs 1 mapping, reversed physical ranges and CIE xyY emitters work across MVR and GDTF', () => {
  // MVR 0-based break="0" maps to GDTF 1-based DMXBreak=1; break="1" maps to DMXBreak=2.
  const multi = readAddresses({
    Addresses: {
      Address: [
        { '@_break': '1', '#text': '1025' },
        { '@_break': '0', '#text': '513' },
        { '@_break': '0', '#text': '999' }, // duplicate break ignored
        { '@_break': '-1', '#text': '1' }, // invalid negative break ignored
      ],
    },
  });
  assert.deepEqual(multi, [
    { mvrBreak: 0, dmxBreak: 1, universe: 2, channel: 1, absolute: 513 },
    { mvrBreak: 1, dmxBreak: 2, universe: 3, channel: 1, absolute: 1025 },
  ]);
  // Missing break defaults to 0; a fixture with only break="1" still resolves as primary address.
  assert.deepEqual(readAddresses({ Addresses: { Address: [{ '#text': '2.10' }] } })[0], {
    mvrBreak: 0, dmxBreak: 1, universe: 2, channel: 10, absolute: 522,
  });
  assert.deepEqual(readAddress({ Addresses: { Address: [{ '@_break': '1', '#text': '513' }] } }), { universe: 2, channel: 1 });

  // GDTF separates DMXBreak="1" vs DMXBreak="2", preserves reversed PhysicalFrom > PhysicalTo,
  // sorts ChannelFunctions by DMXFrom, and parses CIE xyY emitters.
  const gdtfXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="DualBreak" Manufacturer="Vendor">
    <PhysicalDescriptions><Emitters><Emitter Name="White" Color="0.3127,0.329,100"/></Emitters></PhysicalDescriptions>
    <Geometries><Geometry Name="Base"><Beam Name="Beam" BeamType="Spot" BeamAngle="12"/></Geometry></Geometries>
    <DMXModes><DMXMode Name="Dual" Geometry="Base"><DMXChannels>
      <DMXChannel DMXBreak="1" Offset="1,2" Geometry="Beam">
        <LogicalChannel Attribute="Zoom">
          <ChannelFunction Name="Narrow" Attribute="Zoom" DMXFrom="128/1" PhysicalFrom="20" PhysicalTo="3"/>
          <ChannelFunction Name="Wide" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="45" PhysicalTo="20"/>
        </LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="1" Offset="3" Geometry="Beam">
        <LogicalChannel Attribute="Dimmer">
          <ChannelFunction Name="InvDim" Attribute="Dimmer" DMXFrom="0/1" PhysicalFrom="1" PhysicalTo="0"/>
        </LogicalChannel>
      </DMXChannel>
      <DMXChannel DMXBreak="2" Offset="1,2,3,4" Geometry="Beam"><LogicalChannel Attribute="ColorAdd_R"/></DMXChannel>
      <DMXChannel DMXBreak="1" Offset="None" Geometry="Beam"><LogicalChannel Attribute="CTO"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const summary = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(gdtfXml) }]));
  const mode = summary.modes[0];
  assert.equal(mode.footprint, 3);
  assert.deepEqual(mode.breaks, [{ dmxBreak: 1, footprint: 3 }, { dmxBreak: 2, footprint: 4 }]);
  assert.equal(mode.totalSlots, 7);
  assert.ok(mode.attributes.includes('CTO'), 'virtual Offset="None" channel keeps its attribute');
  // Reversed physical range preserved without swapping and interpolated accurately.
  const wide = mode.functions.find((f) => f.name === 'Wide');
  const narrow = mode.functions.find((f) => f.name === 'Narrow');
  const invDim = mode.functions.find((f) => f.name === 'InvDim');
  assert.equal(wide.dmxFrom, 0);
  assert.equal(wide.dmxTo, 32767);
  assert.equal(narrow.dmxFrom, 32768);
  assert.equal(narrow.dmxTo, 65535);
  assert.equal(physicalAt(wide, 0), 45);
  assert.equal(physicalAt(wide, 32767), 20);
  assert.equal(physicalAt(narrow, 65535), 3);
  assert.equal(physicalAt(invDim, 0), 1);
  assert.equal(physicalAt(invDim, 255), 0);
  assert.equal(summary.emitters[0].srgb.hex, '#FFFFFF');
});

test('multi-instance LED wall GDTF resolves GeometryReference breaks (single, multi-break, 2D nested and cyclic)', () => {
  // Multi-break LED wall: 170 RGB pixels on DMXBreak 1 (510 slots) + 30 RGB pixels on DMXBreak 2 (90 slots) = 600 slots.
  const pixelRefs = [
    ...Array.from({ length: 170 }, (_, i) => `<GeometryReference Name="P1_${i + 1}" Geometry="Pixel"><Break DMXOffset="${i * 3 + 1}" DMXBreak="1"/></GeometryReference>`),
    ...Array.from({ length: 30 }, (_, i) => `<GeometryReference Name="P2_${i + 1}" Geometry="Pixel"><Break DMXOffset="${i * 3 + 1}" DMXBreak="2"/></GeometryReference>`),
  ].join('');
  const wallXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="LED Wall 200px" Manufacturer="Vendor">
    <Geometries>
      <Geometry Name="Pixel"><Beam Name="PixelBeam" BeamType="Wash" BeamAngle="120"/></Geometry>
      <Geometry Name="Wall">${pixelRefs}</Geometry>
    </Geometries>
    <DMXModes><DMXMode Name="RGB200" Geometry="Wall"><DMXChannels>
      <DMXChannel DMXBreak="Overwrite" Offset="1" Geometry="PixelBeam"><LogicalChannel Attribute="ColorAdd_R"/></DMXChannel>
      <DMXChannel DMXBreak="Overwrite" Offset="2" Geometry="PixelBeam"><LogicalChannel Attribute="ColorAdd_G"/></DMXChannel>
      <DMXChannel DMXBreak="Overwrite" Offset="3" Geometry="PixelBeam"><LogicalChannel Attribute="ColorAdd_B"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const wallSummary = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(wallXml) }]));
  assert.equal(wallSummary.modes[0].footprint, 510);
  assert.deepEqual(wallSummary.modes[0].breaks, [
    { dmxBreak: 1, footprint: 510 },
    { dmxBreak: 2, footprint: 90 },
  ]);
  assert.equal(wallSummary.modes[0].totalSlots, 600);

  // 2D nested LED panel: 4 Rows × 4 RGB Pixels = 48 channels on break 1.
  const nestedXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="Panel 4x4" Manufacturer="Vendor">
    <Geometries>
      <Geometry Name="Pixel"/>
      <Geometry Name="Row">
        <GeometryReference Name="C1" Geometry="Pixel"><Break DMXOffset="1" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="C2" Geometry="Pixel"><Break DMXOffset="4" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="C3" Geometry="Pixel"><Break DMXOffset="7" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="C4" Geometry="Pixel"><Break DMXOffset="10" DMXBreak="1"/></GeometryReference>
      </Geometry>
      <Geometry Name="Panel">
        <GeometryReference Name="R1" Geometry="Row"><Break DMXOffset="1" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="R2" Geometry="Row"><Break DMXOffset="13" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="R3" Geometry="Row"><Break DMXOffset="25" DMXBreak="1"/></GeometryReference>
        <GeometryReference Name="R4" Geometry="Row"><Break DMXOffset="37" DMXBreak="1"/></GeometryReference>
      </Geometry>
    </Geometries>
    <DMXModes><DMXMode Name="4x4" Geometry="Panel"><DMXChannels>
      <DMXChannel DMXBreak="1" Offset="1" Geometry="Pixel"><LogicalChannel Attribute="ColorAdd_R"/></DMXChannel>
      <DMXChannel DMXBreak="1" Offset="2" Geometry="Pixel"><LogicalChannel Attribute="ColorAdd_G"/></DMXChannel>
      <DMXChannel DMXBreak="1" Offset="3" Geometry="Pixel"><LogicalChannel Attribute="ColorAdd_B"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const nested = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(nestedXml) }]));
  assert.equal(nested.modes[0].footprint, 48);
  assert.equal(nested.modes[0].totalSlots, 48);

  // Cyclic GeometryReference terminates cleanly and flags cyclicReference.
  const cyclicXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="Loop" Manufacturer="Bad">
    <Geometries>
      <Geometry Name="A"><GeometryReference Name="ToB" Geometry="B"><Break DMXOffset="1" DMXBreak="1"/></GeometryReference></Geometry>
      <Geometry Name="B"><GeometryReference Name="ToA" Geometry="A"><Break DMXOffset="1" DMXBreak="1"/></GeometryReference></Geometry>
    </Geometries>
    <DMXModes><DMXMode Name="M" Geometry="A"><DMXChannels>
      <DMXChannel DMXBreak="1" Offset="1" Geometry="B"><LogicalChannel Attribute="Dimmer"/></DMXChannel>
    </DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const cyclic = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(cyclicXml) }]));
  assert.ok(cyclic.modes[0].flags.includes('cyclicReference'));
});

test('passthrough: import MVR with unknown nodes, move one fixture, re-export (in-session & via v4 JSON) keeps every UUID and unknown node', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const LAYER_UUID = '11111111-2222-4333-8444-555555555555';
  const TRUSS_UUID = 'AAAAAAAA-0000-4000-8000-000000000001';
  const SPOT1_UUID = 'BBBBBBBB-0000-4000-8000-000000000001';
  const SPOT2_UUID = 'BBBBBBBB-0000-4000-8000-000000000002';
  const FREE_UUID = 'BBBBBBBB-0000-4000-8000-000000000005';
  const HAZER1_UUID = 'BBBBBBBB-0000-4000-8000-000000000003';
  const HAZER2_UUID = 'BBBBBBBB-0000-4000-8000-000000000004';
  const SCREEN_UUID = 'CCCCCCCC-0000-4000-8000-000000000001';
  const RISER_UUID = 'DDDDDDDD-0000-4000-8000-000000000001';
  const FOCUS_UUID = 'EEEEEEEE-0000-4000-8000-000000000001';
  const SUPPORT_UUID = 'EEEEEEEE-0000-4000-8000-000000000002';
  const PROJ_UUID = 'EEEEEEEE-0000-4000-8000-000000000003';
  const GROUP_UUID = 'EEEEEEEE-0000-4000-8000-000000000004';
  const GROUP_SUPPORT_UUID = 'EEEEEEEE-0000-4000-8000-000000000005';
  const POS_UUID = 'FFFFFFFF-0000-4000-8000-000000000001';
  const CLASS_UUID = 'FFFFFFFF-0000-4000-8000-000000000002';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="OtherTool" providerVersion="2026">
  <UserData><Data provider="Vectorworks" ver="2026"/></UserData>
  <Scene>
    <AUXData>
      <Position uuid="${POS_UUID}" name="FOH Bar"/>
      <Class uuid="${CLASS_UUID}" name="VendorClass"/>
    </AUXData>
    <Layers><Layer uuid="${LAYER_UUID}" name="Tour Rig"><ChildList>
      <Truss uuid="${TRUSS_UUID}" name="LX1">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,2000,7000}</Matrix>
        <Geometries><Geometry3D fileName="truss.glb"/></Geometries>
        <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
        <ChildList>
          <Fixture uuid="${SPOT1_UUID}" name="Spot 1">
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{-1000,0,-300}</Matrix>
            <GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
            <Function>Key Light</Function>
            <FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber>
            <Addresses><Address break="0">1</Address></Addresses>
            <Color>0.3127,0.329,100</Color>
            <CustomCommands><CustomCommand>Preset 1</CustomCommand></CustomCommands>
          </Fixture>
          <Fixture uuid="${SPOT2_UUID}" name="Spot 2">
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{1000,0,-300}</Matrix>
            <GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
            <FixtureID>2</FixtureID><FixtureIDNumeric>2</FixtureIDNumeric><UnitNumber>2</UnitNumber>
            <Addresses><Address break="0">17</Address></Addresses>
          </Fixture>
        </ChildList>
      </Truss>
      <Fixture uuid="${FREE_UUID}" name="Free Spot">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{4000,-3000,5000}</Matrix>
        <GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
        <FixtureID>5</FixtureID><FixtureIDNumeric>5</FixtureIDNumeric><UnitNumber>1</UnitNumber>
        <Addresses><Address break="0">33</Address></Addresses>
      </Fixture>
      <Fixture uuid="${HAZER1_UUID}" name="Hazer 1">
        <Matrix>{1,0,0}{0,-1,0}{0,0,-1}{2000,-1000,0}</Matrix>
        <GDTFSpec>Vendor@Hazer.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
        <FixtureID>3</FixtureID><FixtureIDNumeric>3</FixtureIDNumeric><UnitNumber>1</UnitNumber>
        <Addresses><Address break="0">101</Address></Addresses>
      </Fixture>
      <Fixture uuid="${HAZER2_UUID}" name="Hazer 2">
        <Matrix>{1,0,0}{0,-1,0}{0,0,-1}{-2000,-1000,0}</Matrix>
        <GDTFSpec>Vendor@Hazer.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
        <FixtureID>4</FixtureID><FixtureIDNumeric>4</FixtureIDNumeric><UnitNumber>2</UnitNumber>
        <Addresses><Address break="0">102</Address></Addresses>
      </Fixture>
      <VideoScreen uuid="${SCREEN_UUID}" name="IMAG L">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{-6000,0,4000}</Matrix>
        <Geometries><Geometry3D fileName="screen.glb"/></Geometries>
        <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
      </VideoScreen>
      <SceneObject uuid="${RISER_UUID}" name="Drum riser">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix>
        <Geometries><Geometry3D fileName="riser.glb"/></Geometries>
        <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
      </SceneObject>
      <FocusPoint uuid="${FOCUS_UUID}" name="DSC">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-2000,0}</Matrix><Geometries/>
      </FocusPoint>
      <Support uuid="${SUPPORT_UUID}" name="Hoist 1">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{-3000,2000,9000}</Matrix><Geometries/>
      </Support>
      <Projector uuid="${PROJ_UUID}" name="Proj 1">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,-8000,4000}</Matrix><Geometries/>
      </Projector>
      <GroupObject uuid="${GROUP_UUID}" name="Hoist Group">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{3000,2000,9000}</Matrix>
        <ChildList>
          <Support uuid="${GROUP_SUPPORT_UUID}" name="Hoist 2">
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix><Geometries/>
          </Support>
        </ChildList>
      </GroupObject>
    </ChildList></Layer></Layers>
  </Scene>
</GeneralSceneDescription>`;

  const sourceBytes = writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(xml) },
    { name: 'truss.glb', data: boxGlb(8, 0.3, 0.3) },
    { name: 'screen.glb', data: boxGlb(3, 2, 0.1) },
    { name: 'riser.glb', data: boxGlb(3, 0.6, 2, { base: true }) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
    { name: 'Vendor@Hazer.gdtf', data: profileArchive(PROFILES.hazer) },
  ]);

  const imported = importMvr(sourceBytes);
  assert.equal(imported.report.source, 'mvr');
  assert.ok(imported.interchange?.mvr?.synthetic?.length === 1, 'free-floating fixture created one synthetic position bar');

  // Move Hazer 1 by (+1.5 m X, -0.5 m Z); leave Hazer 2 untouched.
  const movedRig = structuredClone(imported.rig);
  const hazer1 = movedRig.floorFx.find((f) => Math.abs(f.x - 2) < 0.01);
  assert.ok(hazer1);
  hazer1.x += 1.5;
  hazer1.z -= 0.5;

  // 1) Re-export directly in-session (with original archive resources).
  const inSession = exportMvrDocument(movedRig, imported.stage, '1.4.0', imported.interchange, imported.resources);
  const s1 = scene(inSession.bytes);
  assert.ok(s1.files.has('vendor@spot.gdtf'), 'original manufacturer GDTF kept in-session');
  assert.ok(s1.files.has('vendor@hazer.gdtf'), 'original manufacturer hazer GDTF kept in-session');

  // 2) Also verify full persistence through Show v4 JSON save/reload (without in-memory resources).
  const v4Show = makeShowFile(movedRig, [], INITIAL_SHOW_STATE, null, undefined, undefined, undefined, imported.stage, imported.interchange);
  assert.equal(v4Show.version, 4);
  const reloadedShow = parseShowFile(JSON.stringify(v4Show));
  const afterReload = exportMvrDocument(reloadedShow.rig, reloadedShow.stage, '1.4.0', reloadedShow.interchange);
  const s2 = scene(afterReload.bytes);

  for (const [label, out] of [['in-session', s1], ['after v4 JSON reload', s2]]) {
    const rawXml = utf8.decode(out.files.get('generalscenedescription.xml').data);
    for (const expectedUuid of [
      LAYER_UUID, TRUSS_UUID, SPOT1_UUID, SPOT2_UUID, FREE_UUID, HAZER1_UUID, HAZER2_UUID,
      SCREEN_UUID, RISER_UUID, FOCUS_UUID, SUPPORT_UUID, PROJ_UUID, GROUP_UUID, GROUP_SUPPORT_UUID,
      POS_UUID, CLASS_UUID,
    ]) {
      assert.ok(rawXml.includes(expectedUuid), `${label}: UUID ${expectedUuid} survived`);
    }
    // Synthetic position bar must NOT be exported as a fake <Truss>.
    assert.equal(list(out.childList, 'Truss').length, 1, `${label}: only the real truss is exported`);
    assert.equal(attr(list(out.childList, 'Truss')[0], 'uuid'), TRUSS_UUID);

    // Unknown/unmodeled nodes survive in UserData, AUXData, ChildList and Fixture extras.
    assert.ok(list(child(out.root, 'UserData'), 'Data').some((d) => attr(d, 'provider') === 'Vectorworks'), `${label}: UserData survives`);
    assert.ok(list(child(child(out.root, 'Scene'), 'AUXData'), 'Position').some((p) => attr(p, 'uuid') === POS_UUID), `${label}: AUXData Position survives`);
    assert.ok(list(child(child(out.root, 'Scene'), 'AUXData'), 'Class').some((c) => attr(c, 'uuid') === CLASS_UUID), `${label}: AUXData Class survives`);
    assert.ok(list(out.childList, 'Support').some((n) => attr(n, 'uuid') === SUPPORT_UUID), `${label}: Support survives`);
    assert.ok(list(out.childList, 'Projector').some((n) => attr(n, 'uuid') === PROJ_UUID), `${label}: Projector survives`);
    assert.ok(list(out.childList, 'FocusPoint').some((n) => attr(n, 'uuid') === FOCUS_UUID), `${label}: foreign FocusPoint survives`);
    const groupNode = list(out.childList, 'GroupObject').find((n) => attr(n, 'uuid') === GROUP_UUID);
    assert.ok(groupNode, `${label}: unimported GroupObject survives intact`);
    assert.ok(list(child(groupNode, 'ChildList'), 'Support').some((n) => attr(n, 'uuid') === GROUP_SUPPORT_UUID), `${label}: nested Support inside GroupObject survives`);

    // Moved floor fixture matrix reflects new (3.5, 0, 0.5) m; unmoved Hazer 2 stays at (-2, 0, 1) m.
    const f1 = list(out.childList, 'Fixture').find((f) => attr(f, 'uuid') === HAZER1_UUID);
    const f2 = list(out.childList, 'Fixture').find((f) => attr(f, 'uuid') === HAZER2_UUID);
    const p1 = readPose(parseMatrix(text(f1, 'Matrix'))).position;
    const p2 = readPose(parseMatrix(text(f2, 'Matrix'))).position;
    assert.ok(Math.abs(p1.x - 3.5) < 0.002 && Math.abs(p1.z - 0.5) < 0.002, `${label}: moved Hazer 1 landed at (3.5, 0, 0.5)`);
    assert.ok(Math.abs(p2.x + 2) < 0.002 && Math.abs(p2.z - 1) < 0.002, `${label}: unmoved Hazer 2 stayed at (-2, 0, 1)`);

    // Fixture extras survive in strict MVR 1.6 XSD sequence order.
    const spot1 = list(out.childList, 'Fixture').find((f) => attr(f, 'uuid') === SPOT1_UUID);
    assert.equal(text(spot1, 'Color'), '0.3127,0.329,100');
    assert.equal(text(spot1, 'Function'), 'Key Light');
    assert.ok(child(spot1, 'CustomCommands'));
    const childTags = Object.keys(spot1).filter((k) => !k.startsWith('@_'));
    const orderIndices = childTags.map((t) => FIXTURE_XSD_ORDER.indexOf(t));
    assert.ok(orderIndices.every((idx, i) => idx >= 0 && (i === 0 || idx > orderIndices[i - 1])), `${label}: Fixture tags in XSD order: ${childTags.join(',')}`);
  }

  // Re-importing the StageForge-exported MVR through restore() still merges a truss move by its preserved foreign UUID!
  const beforeTruss = matrixText(poseMatrix({ x: movedRig.trussPods[0].x, y: movedRig.trussPods[0].baseY, z: movedRig.trussPods[0].z }, 0));
  const afterTruss = matrixText(poseMatrix({ x: movedRig.trussPods[0].x, y: movedRig.trussPods[0].baseY, z: movedRig.trussPods[0].z - 1 }, 0));
  const movedAgain = importMvr(editScene(inSession.bytes, (raw) => raw.replace(beforeTruss, afterTruss)));
  assert.equal(movedAgain.report.source, 'stageforge');
  assert.ok(Math.abs(movedAgain.rig.trussPods[0].z - (movedRig.trussPods[0].z - 1)) < 0.002, 'truss move merged by preserved foreign UUID');
  assert.match(movedAgain.report.notes.join(' '), /Moved LX1/);
  assert.ok(!movedAgain.report.notes.some((n) => /added in another tool/.test(n)), 'preserved foreign fixtures are not misreported as added');
});

test('Sprint 1 QA regressions: GDTF DAG cap, UUID remap, invalid-matrix restore, resource collision, dangling GDTF and long escaped keys', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');

  // H1: 16-deep exponential GeometryReference DAG + 64 DMXModes finishes quickly via root cache + shared ops budget.
  const chainGeos = Array.from({ length: 16 }, (_, i) => {
    const next = `T${i + 1}`;
    return `<Geometry Name="T${i}">
      <GeometryReference Name="A${i}" Geometry="${next}"><Break DMXOffset="1" DMXBreak="1"/></GeometryReference>
      <GeometryReference Name="B${i}" Geometry="${next}"><Break DMXOffset="2" DMXBreak="1"/></GeometryReference>
    </Geometry>`;
  }).join('') + '<Geometry Name="T16"/>';
  const manyModes = Array.from({ length: 64 }, (_, i) => `<DMXMode Name="M${i}" Geometry="T0"><DMXChannels>
    <DMXChannel DMXBreak="1" Offset="1" Geometry="T16"><LogicalChannel Attribute="Dimmer"/></DMXChannel>
  </DMXChannels></DMXMode>`).join('');
  const dagXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="DAG" Manufacturer="Hostile">
    <Geometries>${chainGeos}</Geometries><DMXModes>${manyModes}</DMXModes></FixtureType></GDTF>`;
  const t0 = performance.now();
  const dagSummary = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(dagXml) }]));
  assert.ok(performance.now() - t0 < 500, 'exponential DAG × 64 modes finishes quickly');
  assert.ok(dagSummary.modes[0].flags.includes('refLimitExceeded'));

  // L2: All-invalid Break entries flag cleanly without crashing.
  const badBreakXml = `<?xml version="1.0"?><GDTF DataVersion="1.2"><FixtureType Name="BadBreak" Manufacturer="V">
    <Geometries><Geometry Name="P"/><Geometry Name="Root"><GeometryReference Name="R" Geometry="P"><Break DMXBreak="999" DMXOffset="999"/></GeometryReference></Geometry></Geometries>
    <DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels><DMXChannel DMXBreak="Overwrite" Offset="1" Geometry="P"><LogicalChannel Attribute="Dimmer"/></DMXChannel></DMXChannels></DMXMode></DMXModes>
  </FixtureType></GDTF>`;
  const badBreak = readGdtf(writeArchive([{ name: 'description.xml', data: utf8.encode(badBreakXml) }]));
  assert.ok(badBreak.modes[0].flags.includes('invalidBreak'));
  assert.equal(badBreak.modes[0].footprint, 0);

  // H2 + M7 + M4: Colliding UUID inside passthrough GroupObject is remapped (not dropped),
  // foreign truss-3000.glb colliding with generated truss-3000.glb is renamed without clobbering,
  // and dangling passthrough Fixture GDTFSpec falls back to a bundled generic GDTF when resources are absent.
  const DUP_UUID = 'AAAAAAAA-0000-4000-8000-000000000077';
  const GRP_UUID = 'EEEEEEEE-0000-4000-8000-000000000077';
  const PASS_FIX_UUID = 'BBBBBBBB-0000-4000-8000-000000000077';
  const foreignTrussGlb = boxGlb(9, 1, 1); // Distinct bytes from StageForge's 3 m truss-3000.glb.
  const rig3m = createBlankDesign();
  rig3m.trussPods = [{
    id: 'p1', name: 'Main', shape: 'box', width: 3, x: 0, baseY: 6, z: 0, rotationY: 0,
    motorized: false, motorMinY: 6, motorMaxY: 6, fixtures: [],
  }];
  const collisionInterchange = {
    mvr: {
      uuids: { 'truss:p1': DUP_UUID },
      passthrough: {
        auxData: [
          `<Symdef uuid="FFFFFFFF-0000-4000-8000-000000000077" name="CustomSym"><ChildList><Geometry3D fileName="sym.glb"/></ChildList></Symdef>`,
        ],
        sceneNodes: [
          `<GroupObject uuid="${GRP_UUID}" name="G"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,0}</Matrix><ChildList>` +
            `<Support uuid="${DUP_UUID}" name="Colliding Hoist"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,5000}</Matrix>` +
            `<Geometries><Geometry3D fileName="truss-3000.glb"/></Geometries></Support></ChildList></GroupObject>`,
          `<Fixture uuid="${PASS_FIX_UUID}" name="Overflow Spot"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,4000}</Matrix>` +
            `<GDTFSpec>Missing@Vendor.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode><FixtureID>99</FixtureID><FixtureIDNumeric>99</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`,
        ],
      },
    },
  };
  const symGlb = boxGlb(2, 2, 2);
  const withRes = exportMvrDocument(rig3m, undefined, '1', collisionInterchange, new Map([['truss-3000.glb', foreignTrussGlb], ['sym.glb', symGlb]]));
  assert.match(withRes.notes.join(' '), /Remapped 1 colliding passthrough UUID/);
  assert.match(withRes.notes.join(' '), /not available in this session/);
  const outRes = scene(withRes.bytes);
  assert.ok(outRes.files.has('sym.glb'), 'Symdef/ChildList/Geometry3D file bundled from resources');
  assert.deepEqual(outRes.files.get('sym.glb').data, symGlb);
  // GroupObject and nested Support both survived with a distinct remapped UUID.
  const keptGroup = list(outRes.childList, 'GroupObject').find((g) => attr(g, 'uuid') === GRP_UUID);
  assert.ok(keptGroup, 'GroupObject survived UUID collision');
  const nestedSupport = list(child(keptGroup, 'ChildList'), 'Support')[0];
  assert.ok(nestedSupport && attr(nestedSupport, 'uuid') !== DUP_UUID, 'colliding Support UUID remapped');
  // Foreign truss-3000.glb was renamed rather than clobbered by StageForge's 3 m truss box.
  const renamedFile = attr(list(child(nestedSupport, 'Geometries'), 'Geometry3D')[0], 'fileName');
  assert.notEqual(renamedFile.toLowerCase(), 'truss-3000.glb');
  assert.deepEqual(outRes.files.get(renamedFile.toLowerCase()).data, foreignTrussGlb);
  assert.ok(outRes.files.has('truss-3000.glb'));
  // Dangling passthrough Fixture GDTFSpec fell back to a bundled generic .gdtf present in the archive!
  const passFix = list(outRes.childList, 'Fixture').find((f) => attr(f, 'uuid') === PASS_FIX_UUID);
  assert.ok(passFix);
  const resolvedSpec = text(passFix, 'GDTFSpec');
  assert.ok(outRes.files.has(resolvedSpec.toLowerCase()), `passthrough Fixture GDTFSpec "${resolvedSpec}" is bundled in archive`);

  // M3: restore() keeps an invalid-matrix new foreign Support intact without rewriting its matrix to origin,
  // and reports when an existing passthrough Support was moved in another tool.
  const SUP_VALID = 'EEEEEEEE-0000-4000-8000-000000000088';
  const SUP_BAD = 'EEEEEEEE-0000-4000-8000-000000000089';
  const baseWithSup = exportMvrDocument(rig3m, undefined, '1', {
    mvr: {
      passthrough: {
        sceneNodes: [`<Support uuid="${SUP_VALID}" name="Hoist"><Matrix>{1,0,0}{0,1,0}{0,0,1}{1000,0,5000}</Matrix><Geometries/></Support>`],
      },
    },
  });
  const editedForRestore = editScene(baseWithSup.bytes, (raw) =>
    raw
      .replace('{1,0,0}{0,1,0}{0,0,1}{1000,0,5000}', '{1,0,0}{0,1,0}{0,0,1}{2000,0,5000}')
      .replace('</ChildList>', `<Support uuid="${SUP_BAD}" name="Broken"><Matrix>{1,0,0}{0,1,0}{0,0,1}{NaN,0,0}</Matrix><Geometries/></Support></ChildList>`),
  );
  const restored = importMvr(editedForRestore);
  assert.match(restored.report.notes.join(' '), /1 other moved object .* was not merged/);
  const savedBad = restored.interchange.mvr.passthrough.sceneNodes.find((s) => s.includes(SUP_BAD));
  assert.ok(savedBad && savedBad.includes('NaN'), 'invalid-matrix Support preserved intact, not rewritten to origin');

  // M6 sub-risk: 256-char IDs full of quotes/backslashes escape past 1024 chars yet save/parse cleanly in Show v4.
  const nastyId = '"\\'.repeat(128); // 256 chars -> 512 chars after JSON escaping
  const nastyRig = createBlankDesign();
  nastyRig.trussPods = [{
    id: nastyId, name: 'Long', shape: 'box', width: 4, x: 0, baseY: 6, z: 0, rotationY: 0,
    motorized: false, motorMinY: 6, motorMaxY: 6,
    fixtures: [{ id: nastyId, type: 'beam', modelName: 'Spot', count: 1, dmxUniverse: 1, dmxStartChannel: 1 }],
  }];
  const nastyExport = exportMvrDocument(nastyRig);
  const nastyShow = makeShowFile(nastyRig, [], INITIAL_SHOW_STATE, null, undefined, undefined, undefined, undefined, nastyExport.interchange);
  assert.equal(nastyShow.version, 4);
  assert.deepEqual(parseShowFile(JSON.stringify(nastyShow)).interchange, nastyExport.interchange);
});

test('Sprint 7: importMvr is pure (no input mutation, no localStorage touch, deterministic) and derives notes from findings', () => {
  const bytes = exportMvr(fixtureShow.rig, fixtureShow.stage);
  const copyBefore = new Uint8Array(bytes);
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('localStorage must not be accessed during importMvr');
    },
  });
  try {
    const first = importMvr(bytes);
    const second = importMvr(bytes);
    assert.deepEqual(bytes, copyBefore, 'input Uint8Array is untouched');
    assert.deepEqual(first.report, second.report);
    assert.deepEqual(first.rig, second.rig);
    assert.deepEqual(first.report.findings, []);
    assert.deepEqual(first.report.notes, []);
  } finally {
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else delete globalThis.localStorage;
  }
});

test('Sprint 7: StageForge -> MVR -> StageForge -> MVR and foreign -> SF -> MVR -> SF -> MVR preserve every UUID and fixture number', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');
  const rig = fixtureShow.rig, stage = fixtureShow.stage;

  // 1) StageForge -> MVR -> StageForge -> MVR
  const exp1 = exportMvrDocument(rig, stage, '1.5.0');
  const imp1 = importMvr(exp1.bytes);
  assert.equal(imp1.report.source, 'stageforge');
  assert.deepEqual(imp1.report.findings, []);
  const exp2 = exportMvrDocument(imp1.rig, imp1.stage, '1.5.0', imp1.interchange, imp1.resources);

  const mapFixtureIds = (bytes) => {
    const { childList } = scene(bytes);
    return list(childList, 'Fixture').map((f) => ({
      uuid: attr(f, 'uuid'),
      fixtureId: text(f, 'FixtureID'),
      fixtureIdNumeric: text(f, 'FixtureIDNumeric'),
      unitNumber: text(f, 'UnitNumber'),
      customId: text(f, 'CustomId'),
    }));
  };
  const firstMap = mapFixtureIds(exp1.bytes);
  const secondMap = mapFixtureIds(exp2.bytes);
  assert.ok(firstMap.length > 0);
  assert.deepEqual(secondMap, firstMap, 'StageForge round trip keeps every UUID and fixture number');

  // 2) Foreign -> StageForge -> MVR -> StageForge -> MVR keeps foreign fixture UUIDs and stable numbers
  const F1 = 'BBBBBBBB-1111-4000-8000-000000000001';
  const F2 = 'BBBBBBBB-1111-4000-8000-000000000002';
  const foreignBytes = foreignMvr({
    fixtures:
      `<Fixture uuid="${F1}" name="Spot A"><Matrix>{1,0,0}{0,1,0}{0,0,1}{-1000,0,-280}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>101</FixtureID><FixtureIDNumeric>101</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">1</Address></Addresses></Fixture>` +
      `<Fixture uuid="${F2}" name="Spot B"><Matrix>{1,0,0}{0,1,0}{0,0,1}{1000,0,-280}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>102</FixtureID><FixtureIDNumeric>102</FixtureIDNumeric><UnitNumber>2</UnitNumber><Addresses><Address break="0">17</Address></Addresses></Fixture>`,
    gdtf: { truss: boxGlb(4, 0.3, 0.3), 'Vendor@Spot.gdtf': profileArchive(PROFILES.beam) },
  });
  const fImp1 = importMvr(foreignBytes);
  assert.ok(fImp1.report.findings.some((f) => f.code === 'fixture-number-lost' && f.severity === 'warn'));
  const fExp1 = exportMvrDocument(fImp1.rig, fImp1.stage, '1.5.0', fImp1.interchange, fImp1.resources);
  const fImp2 = importMvr(fExp1.bytes);
  assert.equal(fImp2.report.source, 'stageforge');
  assert.deepEqual(fImp2.report.findings, [], 're-importing our own export of a foreign MVR has zero findings');
  const fExp2 = exportMvrDocument(fImp2.rig, fImp2.stage, '1.5.0', fImp2.interchange, fImp2.resources);
  const fm1 = mapFixtureIds(fExp1.bytes);
  const fm2 = mapFixtureIds(fExp2.bytes);
  assert.deepEqual(fm1.map((x) => x.uuid), [F1, F2]);
  assert.deepEqual(fm2, fm1);
});

test('Sprint 7: synthetic MVRs cover every finding code, transform-delta thresholds, unit-suspect, NULs and resource cap', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');

  // 1) Nested rotated groups: compute expected world position independently (90 deg CCW about MVR +Z + translation).
  // Group A at MVR (2000, 1000, 6000) rotated +90 deg about +Z: (lx, ly, lz) -> (2000 - ly, 1000 + lx, 6000 + lz).
  // Group B nested at local (0, 2000, 0) rotated 0 -> world (0, 1000, 6000) -> wait: local (0, 2000, 0) maps to (2000 - 2000, 1000 + 0, 6000) = (0, 1000, 6000) mm -> SF (0, 6, -1) m.
  // Truss aligned with Group A (yaw +90 deg) won't be needed: put a floor hazer at Group B's origin so StageForge places it at SF (0, 0, -1),
  // and put a tilted moving head (rotated 30 deg about local X) to trigger > 2 deg transform-simplified!
  const cos30 = Math.cos((30 * Math.PI) / 180);
  const sin30 = Math.sin((30 * Math.PI) / 180);
  const nestedXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="SyntheticCAD" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Nested"><ChildList>
  <GroupObject uuid="eeeeeeee-1111-4000-8000-000000000001" name="Outer90">
   <Matrix>{0,1,0}{-1,0,0}{0,0,1}{2000,1000,0}</Matrix>
   <ChildList>
    <GroupObject uuid="eeeeeeee-1111-4000-8000-000000000002" name="InnerShift">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,2000,0}</Matrix>
     <ChildList>
      <Fixture uuid="bbbbbbbb-2222-4000-8000-000000000001" name="Floor Hazer">
       <Matrix>{0,-1,0}{0,0,-1}{1,0,0}{0,0,0}</Matrix>
       <GDTFSpec>Vendor@Hazer.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
       <FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber>
       <Addresses><Address break="0">1</Address></Addresses>
      </Fixture>
      <Fixture uuid="bbbbbbbb-2222-4000-8000-000000000002" name="Tilted Spot">
       <Matrix>{1,0,0}{0,${cos30.toFixed(6)},${sin30.toFixed(6)}}{0,${(-sin30).toFixed(6)},${cos30.toFixed(6)}}{0,0,5000}</Matrix>
       <GDTFSpec>Vendor@Spot.gdtf\u0000</GDTFSpec><GDTFMode>StageForge</GDTFMode>
       <FixtureID>101</FixtureID><FixtureIDNumeric>101</FixtureIDNumeric><UnitNumber>1</UnitNumber>
       <Addresses><Address break="0">1025</Address><Address break="1">1537</Address></Addresses>
      </Fixture>
      <Fixture uuid="bbbbbbbb-2222-4000-8000-000000000003" name="Missing Profile Spot">
       <Matrix>{1,0,0}{0,1,0}{0,0,1}{2000,0,5000}</Matrix>
       <GDTFSpec>NoSuch@Profile.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode>
       <FixtureID>A7</FixtureID><FixtureIDNumeric>0</FixtureIDNumeric><UnitNumber>1</UnitNumber>
      </Fixture>
      <Fixture uuid="bbbbbbbb-2222-4000-8000-000000000004" name="Corrupt Profile Spot">
       <Matrix>{-1,0,0}{0,1,0}{0,0,1}{-2000,0,5000}</Matrix>
       <GDTFSpec>Corrupt@Bad.gdtf</GDTFSpec><GDTFMode>Std</GDTFMode>
       <FixtureID>4</FixtureID><FixtureIDNumeric>4</FixtureIDNumeric><UnitNumber>1</UnitNumber>
       <Addresses><Address break="0">40</Address></Addresses>
      </Fixture>
     </ChildList>
    </GroupObject>
   </ChildList>
  </GroupObject>
  <Truss uuid="aaaaaaaa-2222-4000-8000-000000000001" name="3DS Tower">
   <Matrix>{1,0,0}{0,${cos30.toFixed(6)},${sin30.toFixed(6)}}{0,${(-sin30).toFixed(6)},${cos30.toFixed(6)}}{5000,0,4000}</Matrix>
   <Geometries><Geometry3D fileName="tower.3ds"/></Geometries>
   <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
  </Truss>
  <Truss uuid="not-a-uuid" name="Bad UUID Truss">
   <Matrix>{1,0,0}{0,1,0}{0,0,1}{-5000,0,4000}</Matrix>
   <Geometries><Symbol symdef="ffffffff-0000-4000-8000-000000000001"/></Geometries>
   <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
  </Truss>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>\u0000`;

  const nestedArchive = writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(nestedXml) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
    { name: 'Vendor@Hazer.gdtf', data: profileArchive(PROFILES.hazer) },
    { name: 'Corrupt@Bad.gdtf', data: utf8.encode('not-a-zip') },
    { name: 'tower.3ds', data: new Uint8Array(64) },
    { name: 'large-tex.png', data: new Uint8Array(2048) },
  ]);

  // Test lower maxKeptResourceBytes cap to trigger resource-dropped without allocating 128 MiB.
  const nestedRes = importMvr(nestedArchive, { maxKeptResourceBytes: 512 });
  const codes = new Set(nestedRes.report.findings.map((f) => f.code));
  assert.deepEqual(nestedRes.report.notes, nestedRes.report.findings.map((f) => f.message), 'notes derived directly from findings');
  // Independent check of nested rotated group world placement: hazer at SF (0, 0, -1).
  assert.equal(nestedRes.rig.floorFx.length, 1);
  assert.ok(Math.abs(nestedRes.rig.floorFx[0].x - 0) < 0.002);
  assert.ok(Math.abs(nestedRes.rig.floorFx[0].z - (-1)) < 0.002);
  // NUL-suffixed GDTFSpec "Vendor@Spot.gdtf\0" resolved cleanly (NOT flagged as missing!).
  const gdtfMissing = nestedRes.report.findings.find((f) => f.code === 'gdtf-missing');
  assert.ok(gdtfMissing && gdtfMissing.count === 1 && gdtfMissing.fixtureIds[0].includes('Missing Profile Spot'));
  assert.ok(codes.has('gdtf-unparsed'), 'corrupt GDTF emits gdtf-unparsed');
  assert.ok(nestedRes.rig.trussPods.some(pod => pod.fixtures.some(fixture => fixture.dmxUniverse === 3)), 'supported U3 patch is retained');
  assert.ok(codes.has('address-assigned'), 'unpatched fixture emits address-assigned');
  assert.ok(codes.has('break-dropped'), 'multi-break fixture emits break-dropped');
  assert.ok(codes.has('fixture-number-lost'), 'custom FixtureID 101 / A7 emits fixture-number-lost');
  assert.ok(codes.has('geometry-unsupported'), '.3ds and Symbol emit geometry-unsupported');
  assert.ok(codes.has('uuid-changed'), 'non-canonical UUID emits uuid-changed');
  assert.ok(codes.has('hierarchy-flattened'), 'nested GroupObjects emit hierarchy-flattened');
  assert.ok(codes.has('resource-dropped'), 'oversize resource emits resource-dropped');
  const transformFindings = nestedRes.report.findings.filter((f) => f.code === 'transform-simplified');
  assert.ok(transformFindings.some((f) => /mirrored/.test(f.message)), 'mirrored fixture emits transform-simplified');
  assert.ok(transformFindings.some((f) => /tilted truss/.test(f.message)), 'tilted truss emits separate transform-simplified finding');

  // 2) Clean exact placement (<= 0.05 m and <= 2 deg) emits NO transform-simplified finding!
  // On a 4 m box truss (32 slots), mountSlotIndex(0, 1, 32) = 16 sits at x = 1.6 / 31 ≈ +0.0516 m, y = -0.28 m.
  const exactXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="ExactTool" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Exact"><ChildList>
  <Truss uuid="aaaaaaaa-3333-4000-8000-000000000001" name="LX1">
   <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,6000}</Matrix>
   <Geometries><Geometry3D fileName="truss.glb"/></Geometries>
   <FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>
    <Fixture uuid="bbbbbbbb-3333-4000-8000-000000000001" name="Center Beam">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{52,0,-280}</Matrix>
     <GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
     <FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber>
     <Addresses><Address break="0">1</Address></Addresses>
    </Fixture>
   </ChildList>
  </Truss>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const exactRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(exactXml) },
    { name: 'truss.glb', data: boxGlb(4, 0.3, 0.3) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  assert.equal(exactRes.report.findings.filter((f) => f.code === 'transform-simplified').length, 0);
  assert.equal(exactRes.report.findings.filter((f) => f.code === 'fixture-number-lost').length, 0);
  assert.equal(exactRes.report.findings.filter((f) => f.code === 'unit-suspect').length, 0);

  // 3) Transform-delta threshold: 0.12 m move -> warn; > 0.5 m on > 10% of fixtures -> block!
  const warnMoveXml = exactXml.replace('{52,0,-280}', '{172,0,-280}');
  const warnMoveRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(warnMoveXml) },
    { name: 'truss.glb', data: boxGlb(4, 0.3, 0.3) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const warnTransform = warnMoveRes.report.findings.find((f) => f.code === 'transform-simplified');
  assert.ok(warnTransform && warnTransform.severity === 'warn');
  assert.match(warnTransform.message, /0\.12 m/);

  const blockMoveXml = exactXml.replace('{52,0,-280}', '{1252,0,-280}');
  const blockMoveRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(blockMoveXml) },
    { name: 'truss.glb', data: boxGlb(4, 0.3, 0.3) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const blockTransform = blockMoveRes.report.findings.find((f) => f.code === 'transform-simplified');
  assert.ok(blockTransform && blockTransform.severity === 'block');
  assert.match(blockTransform.message, /1\.20 m/);

  // 4) Feet-scaled document (< 0.5 m across 4 distinct points) -> unit-suspect block!
  const feetXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="FeetExporter" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Feet Rig"><ChildList>
  <Truss uuid="aaaaaaaa-4444-4000-8000-000000000001" name="LX1">
   <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,6,20}</Matrix>
   <Geometries/><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric>
   <ChildList>
    ${[-15, -5, 5, 15].map((ft, i) => `<Fixture uuid="bbbbbbbb-4444-4000-8000-00000000000${i + 1}" name="Spot ${i + 1}">
     <Matrix>{1,0,0}{0,1,0}{0,0,1}{${ft},0,-1}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
     <FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber>
     <Addresses><Address break="0">${1 + i * 16}</Address></Addresses></Fixture>`).join('')}
   </ChildList>
  </Truss>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const feetRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(feetXml) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const feetFinding = feetRes.report.findings.find((f) => f.code === 'unit-suspect');
  assert.ok(feetFinding && feetFinding.severity === 'block');
  assert.match(feetFinding.message, /under 0\.5 m/);
  assert.match(feetFinding.message, /304\.8/);

  // 5) 1000x oversize unit document (> 500 m) -> unit-suspect block (measured before 10 km filter)!
  const hugeXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="MicronExporter" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Huge Rig"><ChildList>
  <Fixture uuid="bbbbbbbb-5555-4000-8000-000000000001" name="Far A"><Matrix>{1,0,0}{0,1,0}{0,0,1}{-400000,0,6000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">1</Address></Addresses></Fixture>
  <Fixture uuid="bbbbbbbb-5555-4000-8000-000000000002" name="Far B"><Matrix>{1,0,0}{0,1,0}{0,0,1}{400000,0,6000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>2</FixtureID><FixtureIDNumeric>2</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">17</Address></Addresses></Fixture>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const hugeRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(hugeXml) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const hugeFinding = hugeRes.report.findings.find((f) => f.code === 'unit-suspect');
  assert.ok(hugeFinding && hugeFinding.severity === 'block');
  assert.match(hugeFinding.message, /over 500 m/);

  // 6) Restore path detects moved fixture, readdressed fixture, extra break and renumbered fixture!
  const refRig = referenceRig();
  const refExport = exportMvr(refRig);
  const editedRef = editScene(refExport, (raw) =>
    raw
      .replace('<FixtureID>1</FixtureID>', '<FixtureID>99</FixtureID>')
      .replace('<Address break="0">513</Address>', '<Address break="0">520</Address><Address break="1">1025</Address>'),
  );
  const restoredEdits = importMvr(editedRef);
  assert.equal(restoredEdits.report.source, 'stageforge');
  const restoreCodes = new Set(restoredEdits.report.findings.map((f) => f.code));
  assert.ok(restoreCodes.has('address-edit-ignored'));
  assert.ok(restoreCodes.has('break-dropped'));
  assert.ok(restoreCodes.has('fixture-number-lost'));
});

test('Sprint 7 QA regressions: drop escalation, restore tilt/delete/unpatch, outlier unit-suspect, resource priority, missing payload, bidi sanitization and L3 split', async () => {
  const { boxGlb } = await compiler.ssrLoadModule('/src/interchange/mvr/glb.ts');

  // M2 + L4: All unreadable fixtures -> block; >10% out-of-range fixtures -> block; cumulative drops >10% -> block.
  const allBadXml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Broken" providerVersion="1">
 <Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="AllBad"><ChildList>
  <Fixture uuid="bbbbbbbb-6666-4000-8000-000000000001" name="Bad\u202E\u200BSpot">
   <Matrix>garbage</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode>
   <FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber>
  </Fixture>
 </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const allBad = importMvr(writeArchive([{ name: 'GeneralSceneDescription.xml', data: utf8.encode(allBadXml) }]));
  const unreadableFinding = allBad.report.findings.find((f) => f.code === 'matrix-unreadable');
  assert.ok(unreadableFinding && unreadableFinding.severity === 'block', 'M2: all-unreadable fixtures escalate to block');
  // L9: bidi override and zero-width space are stripped from labels.
  assert.ok(!/[\u202E\u200B]/.test(unreadableFinding.fixtureIds[0]), 'L9: bidi and zero-width chars stripped');

  // Cumulative drops (1 invalid + 1 out-of-range out of 10 fixtures = 20% > 10% -> second drop escalates to block).
  const cumFixtures = [
    `<Fixture uuid="bbbbbbbb-7777-4000-8000-000000000001" name="Invalid 1"><Matrix>bad</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`,
    `<Fixture uuid="bbbbbbbb-7777-4000-8000-000000000002" name="Far 1"><Matrix>{1,0,0}{0,1,0}{0,0,1}{50000000,0,5000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>2</FixtureID><FixtureIDNumeric>2</FixtureIDNumeric><UnitNumber>1</UnitNumber></Fixture>`,
    ...Array.from({ length: 8 }, (_, i) => `<Fixture uuid="bbbbbbbb-7777-4000-8000-0000000000${String(i + 3).padStart(2, '0')}" name="Ok ${i + 3}"><Matrix>{1,0,0}{0,1,0}{0,0,1}{${i * 500},0,5000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>${i + 3}</FixtureID><FixtureIDNumeric>${i + 3}</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">${1 + i * 16}</Address></Addresses></Fixture>`),
  ].join('');
  const cumRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(`<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6" provider="Cum"><Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Cum"><ChildList>${cumFixtures}</ChildList></Layer></Layers></Scene></GeneralSceneDescription>`) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const cumOor = cumRes.report.findings.find((f) => f.code === 'coordinate-out-of-range');
  assert.ok(cumOor && cumOor.severity === 'block', 'L4: cumulative 20% fixture drops escalate to block');

  // M6: 22 normal fixtures + 1 far outlier at 800 m emits a unit-suspect warn (never silent).
  const outlierFixtures = [
    ...Array.from({ length: 22 }, (_, i) => `<Fixture uuid="bbbbbbbb-8888-4000-8000-0000000000${String(i + 1).padStart(2, '0')}" name="Near ${i + 1}"><Matrix>{1,0,0}{0,1,0}{0,0,1}{${(i - 11) * 400},0,5000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">${1 + i * 16}</Address></Addresses></Fixture>`),
    `<Fixture uuid="bbbbbbbb-8888-4000-8000-000000000099" name="Stray 800m"><Matrix>{1,0,0}{0,1,0}{0,0,1}{800000,0,5000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>23</FixtureID><FixtureIDNumeric>23</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">400</Address></Addresses></Fixture>`,
  ].join('');
  const outlierRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(`<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6" provider="Outlier"><Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Outlier"><ChildList>${outlierFixtures}</ChildList></Layer></Layers></Scene></GeneralSceneDescription>`) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const outlierFinding = outlierRes.report.findings.find((f) => f.code === 'unit-suspect');
  assert.ok(outlierFinding && outlierFinding.severity === 'warn', 'M6: single far outlier emits unit-suspect warn');
  assert.ok(outlierFinding.fixtureIds.some((id) => id.includes('Stray 800m')));

  // M7 + L1: Unsupported extension (.obj) emits resource-dropped info, GDTF is kept ahead of large early PNG,
  // and StageForge marker without StageForge_show.json emits payload-damaged!
  const gdtfBytes = profileArchive(PROFILES.beam);
  const markerNoPayload = writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(`<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6" provider="StageForge"><UserData><Data provider="StageForge" ver="1"/></UserData><Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="NoPayload"><ChildList><Fixture uuid="bbbbbbbb-9999-4000-8000-000000000001" name="Spot"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,5000}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>1</FixtureID><FixtureIDNumeric>1</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">1</Address></Addresses></Fixture></ChildList></Layer></Layers></Scene></GeneralSceneDescription>`) },
    { name: 'aaa-huge.png', data: new Uint8Array(gdtfBytes.byteLength + 500) },
    { name: 'Vendor@Spot.gdtf', data: gdtfBytes },
    { name: 'extra.obj', data: utf8.encode('v 0 0 0\n') },
  ]);
  const resPriority = importMvr(markerNoPayload, { maxKeptResourceBytes: gdtfBytes.byteLength + 100 });
  assert.ok(resPriority.report.findings.some((f) => f.code === 'payload-damaged' && /missing/.test(f.message)), 'L1: missing StageForge payload flagged');
  assert.ok(resPriority.resources?.has('Vendor@Spot.gdtf'), 'M7: GDTF retained ahead of large PNG');
  assert.ok(resPriority.report.findings.some((f) => f.code === 'resource-dropped' && f.severity === 'info' && f.fixtureIds?.includes('extra.obj')), 'M7: unsupported .obj extension reported');

  // M4 + M5 + L7: restore() detects tilted rig truss, deleted fixture, and unpatched (removed Addresses) fixture.
  const refRig = referenceRig();
  const refBytes = exportMvr(refRig);
  const pod = refRig.trussPods[0];
  const origTrussMatrix = matrixText(poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, (pod.rotationY * 180) / Math.PI));
  // Tilt the truss 30 deg about X while keeping its origin and yaw unchanged.
  const c30 = Math.cos((30 * Math.PI) / 180), s30 = Math.sin((30 * Math.PI) / 180);
  const tiltedTrussMatrix = `{${Math.cos((30 * Math.PI) / 180).toFixed(6)},${Math.sin((30 * Math.PI) / 180).toFixed(6)},0}{${(-Math.sin((30 * Math.PI) / 180) * c30).toFixed(6)},${(Math.cos((30 * Math.PI) / 180) * c30).toFixed(6)},${s30.toFixed(6)}}{${(Math.sin((30 * Math.PI) / 180) * s30).toFixed(6)},${(-Math.cos((30 * Math.PI) / 180) * s30).toFixed(6)},${c30.toFixed(6)}}{0,4000,8000}`;
  const restoreEdited = editScene(refBytes, (raw) =>
    raw
      .replace(origTrussMatrix, tiltedTrussMatrix)
      // Delete the floor beam fixture node and strip Addresses from the first Spot fixture.
      .replace(/<Fixture[^>]*name="Floor beam 1"[\s\S]*?<\/Fixture>/, '')
      .replace(/<Addresses>\s*<Address break="0">513<\/Address>\s*<\/Addresses>/, ''),
  );
  const restoreCheck = importMvr(restoreEdited);
  assert.ok(restoreCheck.report.findings.some((f) => f.code === 'transform-simplified' && /tilt, roll or scale/.test(f.message)), 'M4: tilted rig truss in restore() flagged');
  assert.ok(restoreCheck.report.findings.some((f) => f.code === 'object-edit-ignored' && /deleted in the MVR/.test(f.message)), 'M5: deleted fixture in restore() flagged');
  assert.ok(restoreCheck.report.findings.some((f) => f.code === 'address-edit-ignored'), 'L7: unpatched fixture in restore() flagged');

  // L3: > 64 drifted fixtures do not truncate tilted truss IDs because tilted trusses have their own finding.
  const manyDrifted = Array.from({ length: 70 }, (_, i) => `<Fixture uuid="bbbbbbbb-aaaa-4000-8000-0000000000${String(i + 1).padStart(2, '0')}" name="Drifted ${i + 1}"><Matrix>{1,0,0}{0,1,0}{0,0,1}{${(i - 35) * 100},0,-280}</Matrix><GDTFSpec>Vendor@Spot.gdtf</GDTFSpec><GDTFMode>StageForge</GDTFMode><FixtureID>${i + 1}</FixtureID><FixtureIDNumeric>${i + 1}</FixtureIDNumeric><UnitNumber>1</UnitNumber><Addresses><Address break="0">${1 + i * 8}</Address></Addresses></Fixture>`).join('');
  const splitTrussXml = `<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6" provider="Split"><Scene><Layers><Layer uuid="11111111-2222-4333-8444-555555555555" name="Split"><ChildList>
    <Truss uuid="aaaaaaaa-aaaa-4000-8000-000000000001" name="Tilted Main"><Matrix>{1,0,0}{0,${c30.toFixed(6)},${s30.toFixed(6)}}{0,${(-s30).toFixed(6)},${c30.toFixed(6)}}{0,0,6000}</Matrix><Geometries><Geometry3D fileName="truss.glb"/></Geometries><FixtureID></FixtureID><FixtureIDNumeric>0</FixtureIDNumeric><ChildList>${manyDrifted}</ChildList></Truss>
  </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const splitRes = importMvr(writeArchive([
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(splitTrussXml) },
    { name: 'truss.glb', data: boxGlb(20, 0.3, 0.3) },
    { name: 'Vendor@Spot.gdtf', data: profileArchive(PROFILES.beam) },
  ]));
  const tiltedOnly = splitRes.report.findings.find((f) => f.code === 'transform-simplified' && /tilted truss/.test(f.message));
  assert.ok(tiltedOnly && tiltedOnly.count === 1 && tiltedOnly.fixtureIds[0].includes('Tilted Main'), 'L3: tilted truss finding is never truncated by >64 drifted fixtures');
});
