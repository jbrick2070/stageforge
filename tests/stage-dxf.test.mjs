import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { exportStageDxf } = await compiler.ssrLoadModule('/src/data/stageDxf.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');

function entities(plan) {
  const lines = plan.trimEnd().split('\r\n');
  const records = [];
  let section = '', record = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1];
    if (code === 0) {
      if (section === 'ENTITIES' && record.length) records.push(record);
      if (value === 'ENDSEC') section = '';
      if (value === 'SECTION') section = lines[i + 3];
      record = [];
    }
    record.push([code, value]);
  }
  return records;
}
const values = (entity, code) => entity.filter(([c]) => c === code).map(([,v]) => v);
const number = (entity, code) => Number(values(entity, code)[0]);
const select = (all, type, layer) => all.filter(e => values(e,0)[0] === type && values(e,8)[0] === layer);
const coordinate = (e) => [number(e,10), number(e,20), number(e,30)].map(x => +x.toFixed(5));

test('each preset produces an ASCII metre drawing with one block per installed unit', () => {
  for (const rig of Object.values(RIG_TEMPLATES)) {
    const dxf = exportStageDxf(rig), all = entities(dxf);
    assert.match(dxf,/\$ACADVER\r\n1\r\nAC1024\r\n/);
    assert.match(dxf,/\$INSUNITS\r\n70\r\n6\r\n/);
    assert.doesNotMatch(dxf,/[^\x00-\x7F]/);
    assert.equal(select(all,'INSERT','FIXTURES').length,
      [...rig.trussPods.flatMap(p => p.fixtures), ...rig.floorFx].reduce((sum,g) => sum+g.count,0));
    assert.equal(select(all,'INSERT','PROPS').length, rig.props?.length ?? 0);
    assert.equal(select(all,'LWPOLYLINE','DECKS').length,rig.platforms?.length ?? 1);
  }
  assert.equal(select(entities(exportStageDxf(createBlankDesign())),'LWPOLYLINE','DECKS').length,0);
});

test('deck corners, curved and transformed trusses, ground supports and patch tags use CAD coordinates', () => {
  const rig = createBlankDesign();
  rig.name = 'Café\n0\nEOF';
  rig.platforms = [{id:'d',name:'Stage left',x:0,z:0,width:3,depth:4,height:1.8}];
  const base = { name:'Rigging', x:10,z:2,baseY:5.25,rotationY:Math.PI/2,fixtures:[] };
  rig.trussPods = [
    {...base,id:'p',shape:'path',width:10,
      path:[{x:0,z:0},{x:3,z:0},{x:3,z:2},{x:0,z:0}],
      fixtures:[{id:'spot-group',type:'beam',modelName:'Test spot',count:1,dmxUniverse:1,dmxStartChannel:9}]},
    {...base,id:'r',shape:'circle',width:2},
  ];
  rig.floorFx = [{ id:'smokes',type:'smoke',modelName:'Test smoke',count:2,dmxUniverse:2,dmxStartChannel:14,
    x:2,z:1,spread:4 }];
  rig.props = [{id:'arch',kind:'arch',x:1,z:-1,rotation:30,scale:1.5,color:'#ffeeff'}];
  const dxf = exportStageDxf(rig), all = entities(dxf);
  const [deck] = select(all,'LWPOLYLINE','DECKS');
  assert.equal(number(deck,38),1.8);
  assert.equal(number(deck,70),1);
  assert.deepEqual(values(deck,10).map(Number),[-1.5,1.5,1.5,-1.5]);
  assert.deepEqual(values(deck,20).map(Number),[2,2,-2,-2]);
  const [path] = select(all,'LWPOLYLINE','TRUSSES');
  assert.equal(number(path,70),1);
  assert.equal(number(path,38),5.25);
  assert.deepEqual(values(path,10).map(Number),[10,10,12]);
  assert.deepEqual(values(path,20).map(Number).map(x=>+x.toFixed(5)),[-2,1,1]);
  const [ring] = select(all,'CIRCLE','TRUSSES');
  assert.deepEqual(coordinate(ring),[10,-2,5.25]);
  assert.equal(number(ring,40),1);
  const [hung,left,right] = select(all,'INSERT','FIXTURES');
  assert.equal(number(hung,30),4.97);
  assert.equal(number(hung,10).toFixed(5),'11.30278');
  assert.deepEqual(values(hung,1000),['Test spot','spot-group','U1.009']);
  assert.deepEqual(coordinate(left),[0,-1,1.8]);
  assert.deepEqual(coordinate(right),[4,-1,0]);
  assert.deepEqual(values(right,1000),['Test smoke','smokes','U2.016']);
  assert.equal(select(all,'TEXT','PATCH_TAGS').length,3);
  const [arch] = select(all,'INSERT','PROPS');
  assert.equal(values(arch,2)[0],'PROP_ARCH');
  assert.deepEqual(coordinate(arch),[1,1,1.8]);
  assert.deepEqual([41,42,43,50].map(code => number(arch,code)),[1.5,1.5,1.5,30]);
  assert.ok(select(all,'TEXT','LABELS').some(e => values(e,1)[0].includes('Caf\\U+00E9 0 EOF')));
});

test('DXF encodes fixture INSERT rotation, invalid-patch tags and 600-character XDATA chunking', async () => {
  const { placeFixtures } = await compiler.ssrLoadModule('/src/data/fixturePlacement.ts');
  const rig = createBlankDesign();
  rig.name = '\x00\x1f%%cControl';
  const longModel = 'M'.repeat(600);
  rig.trussPods = [{
    id: 'rot', name: 'Rotated', shape: 'box', width: 6, x: 0, baseY: 5, z: 0, rotationY: Math.PI / 2,
    motorized: false, motorMinY: 5, motorMaxY: 5,
    fixtures: [
      { id: 'g-ok', type: 'beam', modelName: longModel, count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
      { id: 'g-bad', type: 'beam', modelName: 'Overflow', count: 1, dmxUniverse: 1, dmxStartChannel: 510 },
    ],
  }];
  const dxf = exportStageDxf(rig);
  assert.doesNotMatch(dxf, /[^\x00-\x7F]/, 'output stays pure ASCII');
  const all = entities(dxf);
  const placements = placeFixtures(rig);
  const fixtures = select(all, 'INSERT', 'FIXTURES');
  const firstInsert = fixtures.find((e) => values(e, 1000).includes('g-ok'));
  assert.ok(firstInsert);
  assert.ok(Math.abs(number(firstInsert, 50) - placements[0].yaw * 180 / Math.PI) < 1e-4, 'group code 50 matches unit.yaw');
  // 600-char modelName chunked across 255-byte XDATA 1000 strings reconstructs cleanly (without dropping tail chars).
  const xdataStrings = values(firstInsert, 1000);
  const groupIdx = xdataStrings.indexOf('g-ok');
  assert.equal(xdataStrings.slice(0, groupIdx).join(''), longModel);
  const tags = select(all, 'TEXT', 'PATCH_TAGS').map((e) => values(e, 1)[0]);
  assert.ok(tags.some((t) => t.includes('U1.510 (invalid patch)')), 'overflowing unit carries (invalid patch) tag');
});
