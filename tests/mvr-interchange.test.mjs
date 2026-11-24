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

const { exportMvr, fixtureKey } = await compiler.ssrLoadModule('/src/interchange/mvr/exportMvr.ts');
const { importMvr, readAddress } = await compiler.ssrLoadModule('/src/interchange/mvr/importMvr.ts');
const { readArchive, writeArchive, utf8 } = await compiler.ssrLoadModule('/src/interchange/mvr/archive.ts');
const { parseXml, list, child, attr, text } = await compiler.ssrLoadModule('/src/interchange/mvr/xml.ts');
const { compose, readPose, parseMatrix, readMatrix, matrixText, poseMatrix } = await compiler.ssrLoadModule('/src/interchange/mvr/coords.ts');
const { readGdtf, profileArchive, PROFILES, classifyGdtf } = await compiler.ssrLoadModule('/src/interchange/mvr/gdtf.ts');
const { placeFixtures, mountSlotIndex } = await compiler.ssrLoadModule('/src/data/fixturePlacement.ts');
const { parseRigJson } = await compiler.ssrLoadModule('/src/data/rigImport.ts');
const { parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { createBlankDesign, podWorldPoint, withPlatforms } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');

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
  // Ordered along the truss: x = −1 m (513 → U2.1), 0 m (1537 is universe 4 → next free, U2.33), +1 m ("2.17").
  assert.deepEqual(pod.fixtures.map((g) => [g.dmxUniverse, g.dmxStartChannel]), [[2, 1], [2, 33], [2, 17]]);
  assert.match(report.notes.join(' '), /outside universes 1–2/);
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
  assert.deepEqual(summary.modes, [{ name: '16bit', footprint: 6, attributes: ['Tilt', 'Pan', 'Dimmer'] }]);
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
