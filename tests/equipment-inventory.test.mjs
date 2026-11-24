import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true },
  appType: 'custom',
});

const { EQUIPMENT_CATALOG, LEGACY_DEFAULTS } = await server.ssrLoadModule('/src/data/equipmentCatalog.ts');
const { RIG_TEMPLATES } = await server.ssrLoadModule('/src/data/presets.ts');
const { calculateProductionEstimate, KG_TO_LBS } = await server.ssrLoadModule('/src/data/productionEstimator.ts');
const { parseShowFile } = await server.ssrLoadModule('/src/data/showFile.ts');
const { patchCsv } = await server.ssrLoadModule('/src/data/patchCsv.ts');
const { csvCell, csvQuotedCell, formatCsv } = await server.ssrLoadModule('/src/data/csv.ts');
const {
  computeFixtureDemand,
  computeLedCabinetDemand,
  createCustomStockFrom,
  DEFAULT_SHOP_STATE,
  formatStockBlockMessage,
  parseShopStockState,
  pickerStockAvailability,
  resolveShopStock,
  SHOP_PRESETS,
  stockViolations,
} = await server.ssrLoadModule('/src/data/shopStock.ts');
const {
  computeInventory,
  EQUIPMENT_CSV_HEADERS,
  equipmentInventoryCsv,
} = await server.ssrLoadModule('/src/data/equipmentInventory.ts');

test.after(() => server.close());

function makeEmptyRig() {
  return {
    ...structuredClone(RIG_TEMPLATES.club_stage),
    name: 'Empty Stage',
    trussPods: [],
    floorFx: [],
    props: [],
    ledWall: { ...RIG_TEMPLATES.club_stage.ledWall, enabled: false },
    audioRig: {
      ...RIG_TEMPLATES.club_stage.audioRig,
      lineArrays: false,
      subWall: false,
      monitorCount: 0,
    },
  };
}

test('all shop stock presets define non-negative integer counts for every catalogue ID', () => {
  for (const preset of SHOP_PRESETS) {
    if (preset.id === 'unlimited') {
      assert.equal(preset.stock, null);
      continue;
    }
    assert.ok(preset.illustrative, `${preset.id} must be flagged illustrative`);
    assert.ok(preset.stock, `${preset.id} must define a stock table`);
    for (const entry of EQUIPMENT_CATALOG) {
      assert.equal(
        typeof preset.stock[entry.id],
        'number',
        `${preset.id} missing stock count for ${entry.id}`,
      );
      assert.ok(
        Number.isInteger(preset.stock[entry.id]) && preset.stock[entry.id] >= 0,
        `${preset.id} invalid stock count for ${entry.id}`,
      );
    }
  }
});

test('computeInventory handles an empty rig cleanly', () => {
  const inv = computeInventory(makeEmptyRig(), undefined, DEFAULT_SHOP_STATE);
  assert.equal(inv.models.length, 0);
  assert.equal(inv.totals.units, 0);
  assert.equal(inv.totals.channelsUsed, 0);
  assert.equal(inv.totals.unpatchedUnits, 0);
  assert.equal(inv.shortages.length, 0);
  assert.equal(inv.universes.length, 2);
  assert.equal(inv.universes[0].usedSlots, 0);
  assert.equal(inv.universes[0].freeSlots, 512);
});

test('computeInventory counts demo arena rig by model and maps generic groups to LEGACY_DEFAULTS stock', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club' };
  const inv = computeInventory(rig, undefined, clubShop);

  const expectedUnits =
    rig.trussPods.flatMap((p) => p.fixtures).reduce((s, g) => s + g.count, 0) +
    rig.floorFx.reduce((s, g) => s + g.count, 0);
  assert.equal(inv.totals.units, expectedUnits);
  assert.ok(inv.models.length >= 5);

  const genericBeam = inv.models.find((m) => m.generic && m.stockKey === LEGACY_DEFAULTS.beam);
  assert.ok(genericBeam, 'generic beam row exists');
  assert.match(genericBeam.stockPoolNote ?? '', /Claypaky Sharpy/);
  assert.equal(genericBeam.weightSource, 'allowance');
  assert.equal(genericBeam.powerSource, 'allowance');

  // Arena rig exceeds Local Club Shop stock for several models.
  assert.ok(inv.shortages.length > 0);
  for (const s of inv.shortages) {
    assert.equal(s.subRent, s.need - s.inStock);
    assert.ok(s.subRent > 0);
  }
});

test('mixed DMX modes of the same catalogue model split into separate rows while sharing one stock pool', () => {
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'pod-1',
      name: 'Front Truss',
      shape: 'box',
      width: 12,
      x: 0,
      baseY: 8,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 6,
      motorMaxY: 10,
      fixtures: [
        {
          id: 'g1',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 1 (Standard 16-bit)',
          dmxChannels: 39,
          count: 3,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
        {
          id: 'g2',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 2 (Reduced)',
          dmxChannels: 34,
          count: 3,
          dmxUniverse: 1,
          dmxStartChannel: 150,
        },
      ],
    },
  ];
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club' }; // club has 4 MegaPointes
  const inv = computeInventory(rig, undefined, clubShop);

  assert.equal(inv.models.length, 2);
  assert.deepEqual(
    inv.models.map((m) => m.dmxMode),
    ['Mode 1 (Standard 16-bit)', 'Mode 2 (Reduced)'],
  );
  assert.equal(inv.models[0].weightSource, 'datasheet');
  assert.equal(inv.models[0].powerSource, 'datasheet');
  assert.equal(inv.models[0].unitWeightKg, 22);
  assert.equal(inv.models[0].unitPowerW, 670);

  // Stock pool aggregates both modes: 3 + 3 = 6 needed vs 4 in stock -> 2 sub-rent.
  const stockLine = inv.stock.find((s) => s.stockKey === 'robe-megapointe');
  assert.ok(stockLine);
  assert.equal(stockLine.need, 6);
  assert.equal(stockLine.inStock, 4);
  assert.equal(stockLine.subRent, 2);
});

test('unverified catalogue fields use allowance fallback and badge as unverified', () => {
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'pod-1',
      name: 'Front',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        {
          id: 'g-sharpy',
          type: 'beam',
          modelName: 'Claypaky Sharpy',
          catalogId: 'claypaky-sharpy', // weightKg verified (19), powerW unverified
          dmxMode: 'Standard (16-Ch)',
          dmxChannels: 16,
          count: 2,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
      ],
    },
  ];
  const inv = computeInventory(rig);
  assert.equal(inv.models.length, 1);
  assert.equal(inv.models[0].weightSource, 'datasheet');
  assert.equal(inv.models[0].powerSource, 'unverified');
  assert.equal(inv.models[0].totalWeightKg, 38);
  // Matches productionEstimator allowance for beam power (520 W * 2 = 1040 W)
  assert.equal(inv.models[0].totalPowerW, 1040);
});

test('inventory total weight and power maintain parity with productionEstimator across all venue presets and example shows', async () => {
  for (const [name, template] of Object.entries(RIG_TEMPLATES)) {
    const est = calculateProductionEstimate(template);
    const inv = computeInventory(template);
    assert.ok(
      Math.abs(inv.totals.weightLb - est.totalWeightLbs) <= 2,
      `preset ${name}: weightLb mismatch (${inv.totals.weightLb} vs ${est.totalWeightLbs})`,
    );
    assert.ok(
      Math.abs(inv.totals.weightKg - est.totalWeightLbs / KG_TO_LBS) <= 1.5,
      `preset ${name}: weightKg mismatch`,
    );
    assert.equal(inv.totals.powerW, est.totalWatts, `preset ${name}: powerW mismatch`);
  }

  for (const rel of [
    'public/examples/amber-walk-on.stageforge.show.json',
    'public/examples/split-rig.stageforge.show.json',
    'tests/fixtures/legacy-v1.stageforge.show.json',
    'tests/fixtures/legacy-v2.stageforge.show.json',
    'tests/fixtures/native-authoring-v3.stageforge.show.json',
  ]) {
    const raw = await readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
    const parsed = parseShowFile(raw);
    const est = calculateProductionEstimate(parsed.rig, parsed.stage);
    const inv = computeInventory(parsed.rig, parsed.stage);
    assert.ok(
      Math.abs(inv.totals.weightLb - est.totalWeightLbs) <= 2,
      `${rel}: weightLb mismatch (${inv.totals.weightLb} vs ${est.totalWeightLbs})`,
    );
    assert.equal(inv.totals.powerW, est.totalWatts, `${rel}: powerW mismatch`);
  }
});

test('universe usage reports overlapping conflicts, overflow channels past 512, and unpatched unit count', () => {
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'p1',
      name: 'Conflict & Overflow Truss',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        // Overlaps channels 1..16 with second group (16 conflict slots)
        { id: 'a', type: 'beam', modelName: 'Beam A', count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
        { id: 'b', type: 'beam', modelName: 'Beam B', count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
        // Starts at 505, width 16 -> occupies 505..512 (8 slots) and overflows 8 channels (513..520)
        { id: 'c', type: 'beam', modelName: 'Beam C', count: 1, dmxUniverse: 1, dmxStartChannel: 505 },
      ],
    },
  ];
  const inv = computeInventory(rig);
  const u1 = inv.universes.find((u) => u.universe === 1);
  assert.ok(u1);
  assert.equal(u1.usedSlots, 24); // 1..16 + 505..512
  assert.equal(u1.freeSlots, 512 - 24);
  assert.equal(u1.conflictSlots, 16);
  assert.equal(u1.overflowChannels, 8);
  assert.equal(inv.totals.unpatchedUnits, 3); // all 3 units have conflict or overflow
});

test('shop stock delta gate blocks increases over stock, allows decreases when over stock, and allows switches to stocked models', () => {
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club', allowOverStock: false };
  // Club has 4 Robe MegaPointe, 8 Robe LEDBeam 150, 0 KVANT Clubmax.
  const baseRig = makeEmptyRig();
  baseRig.trussPods = [
    {
      id: 'p1',
      name: 'Front',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        {
          id: 'g1',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 1 (Standard 16-bit)',
          dmxChannels: 39,
          count: 4,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
      ],
    },
  ];

  // Increasing from 4 -> 5 MegaPointe is blocked.
  const incRig = structuredClone(baseRig);
  incRig.trussPods[0].fixtures[0].count = 5;
  const incViolations = stockViolations(baseRig, incRig, clubShop);
  assert.equal(incViolations.length, 1);
  assert.equal(incViolations[0].stockKey, 'robe-megapointe');
  assert.match(formatStockBlockMessage(incViolations), /Shop has 4 Robe MegaPointe and all 4 are in the rig/);

  // Unlimited never blocks.
  assert.deepEqual(stockViolations(baseRig, incRig, DEFAULT_SHOP_STATE), []);

  // allowOverStock never blocks.
  assert.deepEqual(stockViolations(baseRig, incRig, { ...clubShop, allowOverStock: true }), []);

  // Starting already over stock (6 MegaPointe), decreasing 6 -> 5 is ALLOWED.
  const overRig = structuredClone(baseRig);
  overRig.trussPods[0].fixtures[0].count = 6;
  const decRig = structuredClone(baseRig);
  decRig.trussPods[0].fixtures[0].count = 5;
  assert.deepEqual(stockViolations(overRig, decRig, clubShop), []);

  // Switching 6 MegaPointe -> 6 LEDBeam 150 (8 in stock) is ALLOWED.
  const switchOkRig = structuredClone(overRig);
  switchOkRig.trussPods[0].fixtures[0].catalogId = 'robe-ledbeam-150';
  switchOkRig.trussPods[0].fixtures[0].modelName = 'Robe LEDBeam 150';
  assert.deepEqual(stockViolations(overRig, switchOkRig, clubShop), []);

  // Switching 4 MegaPointe -> 4 BMFL Spot (0 in club stock) is BLOCKED.
  const switchZeroRig = structuredClone(baseRig);
  switchZeroRig.trussPods[0].fixtures[0].catalogId = 'robe-bmfl-spot';
  const zeroViolations = stockViolations(baseRig, switchZeroRig, clubShop);
  assert.equal(zeroViolations.length, 1);
  assert.match(formatStockBlockMessage(zeroViolations), /Shop has 0 Robe BMFL Spot/);
});

test('LED panel cabinets emit soft warnings in inventory/demand without blocking stockViolations', () => {
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club', allowOverStock: false }; // 48 ROE BP2 V2
  const prev = structuredClone(RIG_TEMPLATES.club_stage);
  const next = structuredClone(RIG_TEMPLATES.club_stage);
  next.ledWall = {
    ...next.ledWall,
    enabled: true,
    cabinets: {
      cabinetId: 'roe-bp2-v2',
      columns: 10,
      rows: 8,
      widthMm: 500,
      heightMm: 500,
      pixelsWide: 176,
      pixelsHigh: 176,
    },
  };
  // Hard fixture gate does not block LED cabinet slider edits.
  assert.deepEqual(stockViolations(prev, next, clubShop), []);

  const demand = computeLedCabinetDemand(next);
  assert.ok(demand && demand.cabinets > 48);
  const inv = computeInventory(next, undefined, clubShop);
  const ledShortage = inv.shortages.find((s) => s.stockKey === 'roe-bp2-v2');
  assert.ok(ledShortage);
  assert.equal(ledShortage.softOnly, true);
  assert.equal(ledShortage.inStock, 48);
  assert.equal(ledShortage.subRent, demand.cabinets - 48);
});

test('pickerStockAvailability accounts for current group allocation when evaluating a switch', () => {
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club', allowOverStock: false }; // 4 MegaPointe, 8 Sharpy
  const rig = makeEmptyRig();
  const group = {
    id: 'g1',
    type: 'beam',
    modelName: 'Robe MegaPointe',
    catalogId: 'robe-megapointe',
    count: 4,
    dmxUniverse: 1,
    dmxStartChannel: 1,
  };
  rig.trussPods = [
    {
      id: 'p1',
      name: 'Front',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [group],
    },
  ];
  // Same model: free includes the group's own 4 units, so staying on it is allowed.
  const same = pickerStockAvailability(rig, group, 'robe-megapointe', clubShop);
  assert.equal(same.inStock, 4);
  assert.equal(same.free, 4);
  assert.equal(same.allowed, true);

  // Zero-stock model: blocked when allowOverStock is false, allowed with subRent when true.
  const zero = pickerStockAvailability(rig, group, 'robe-bmfl-spot', clubShop);
  assert.equal(zero.inStock, 0);
  assert.equal(zero.free, 0);
  assert.equal(zero.allowed, false);
  assert.equal(zero.subRent, 4);

  const zeroSoft = pickerStockAvailability(rig, group, 'robe-bmfl-spot', { ...clubShop, allowOverStock: true });
  assert.equal(zeroSoft.allowed, true);
  assert.equal(zeroSoft.overStock, true);
  assert.equal(zeroSoft.subRent, 4);
});

test('parseShopStockState safely handles hostile, corrupt, NaN, out-of-range, and __proto__ payloads', () => {
  assert.equal(parseShopStockState(null).profileId, 'unlimited');
  assert.equal(parseShopStockState('{not json').profileId, 'unlimited');
  assert.equal(parseShopStockState('[]').profileId, 'unlimited');
  assert.equal(parseShopStockState('{"profileId":"evil"}').profileId, 'unlimited');

  const hostile = JSON.stringify({
    profileId: 'custom',
    allowOverStock: 'yes', // non-boolean must become false
    customStock: {
      __proto__: 999,
      constructor: 50,
      'unknown-model': 12,
      'robe-megapointe': 10,
      'claypaky-sharpy': -5,
      'robe-ledbeam-150': 1e9,
      'glp-jdc1': 3.5,
      'kvant-clubmax': null,
    },
  });
  const parsed = parseShopStockState(hostile);
  assert.equal(parsed.profileId, 'custom');
  assert.equal(parsed.allowOverStock, false);
  assert.equal(parsed.customStock['robe-megapointe'], 10);
  // Out-of-range / float / negative values fall back to regional seed, never accepted verbatim.
  assert.equal(parsed.customStock['claypaky-sharpy'], createCustomStockFrom('regional')['claypaky-sharpy']);
  assert.equal(parsed.customStock['robe-ledbeam-150'], createCustomStockFrom('regional')['robe-ledbeam-150']);
  assert.equal(parsed.customStock['glp-jdc1'], createCustomStockFrom('regional')['glp-jdc1']);
  assert.equal(Object.hasOwn(parsed.customStock, 'unknown-model'), false);
  assert.equal(Object.hasOwn(parsed.customStock, 'constructor'), false);
  assert.equal(Object.getPrototypeOf(parsed.customStock), null);
  const stockMap = resolveShopStock(parsed);
  assert.ok(stockMap);
  assert.equal(stockMap.get('robe-megapointe'), 10);
});

function parseCsvRows(text) {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && input[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test('equipmentInventoryCsv emits UTF-8 BOM, CRLF, expected headers, numeric cells, and neutralizes spreadsheet formulas', () => {
  const rig = makeEmptyRig();
  rig.name = '=HYPERLINK("http://evil.example","Click")';
  rig.trussPods = [
    {
      id: 'p1',
      name: 'Pod',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        {
          id: 'g1',
          type: 'beam',
          modelName: '+CMD|" /C calc"!A0',
          catalogId: 'unknown-hostile-model',
          dmxMode: '-1+2,"quoted"',
          dmxChannels: 16,
          count: 2,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
        {
          id: 'g2',
          type: 'wash',
          modelName: '@SUM(A1:A9)',
          catalogId: 'unknown-at-model',
          dmxMode: '\tTAB\rCR',
          dmxChannels: 12,
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 40,
        },
      ],
    },
  ];
  const csv = equipmentInventoryCsv(rig, undefined, DEFAULT_SHOP_STATE);
  assert.ok(csv.startsWith('\uFEFF'), 'must start with UTF-8 BOM');
  assert.ok(csv.endsWith('\r\n'), 'must end with CRLF');
  assert.equal(csv.slice(1).includes('\r\n'), true);

  const parsedRows = parseCsvRows(csv);
  assert.deepEqual(parsedRows[0], [...EQUIPMENT_CSV_HEADERS]);
  const beamRow = parsedRows.find((r) => r[3] === 'unknown-hostile-model');
  const washRow = parsedRows.find((r) => r[3] === 'unknown-at-model');
  const totalRow = parsedRows.at(-1);
  assert.ok(beamRow && washRow && totalRow);
  // Formula-starting strings must be single-quote neutralized.
  assert.equal(beamRow[2], '\'+CMD|" /C calc"!A0');
  assert.equal(beamRow[4], '\'-1+2,"quoted"');
  assert.equal(washRow[2], '\'@SUM(A1:A9)');
  assert.equal(washRow[4], '\'\tTAB\rCR');
  assert.equal(totalRow[0], 'Total');
  assert.equal(totalRow[2], '\'=HYPERLINK("http://evil.example","Click")');
  // Unlimited leaves In stock (idx 7) and Sub-rent (idx 8) empty (not 0).
  assert.equal(beamRow[7], '');
  assert.equal(beamRow[8], '');
  assert.equal(totalRow[8], '');
});

test('csvCell preserves negative numbers while neutralizing formula strings', () => {
  assert.equal(csvCell(-42), '-42');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('+SUM(A1)'), '"\'+SUM(A1)"');
  assert.equal(csvCell('-foo'), '"\'-foo"');
  assert.equal(csvCell('@bar'), '"\'@bar"');
  assert.equal(csvCell('\tindented'), '"\'\tindented"');
  assert.equal(csvQuotedCell('=A1'), '"\'=A1"');
  assert.equal(formatCsv([['a', 1]], { quoteAll: true }), '"a","1"\r\n');
});

test('patchCsv output remains byte-identical after shared csv.ts extraction', () => {
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'pod-1',
      name: 'Main Truss',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 8,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        {
          id: 'b1',
          type: 'blinder',
          modelName: '=Blinder "Pro"',
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 5,
          dmxChannels: 2,
        },
      ],
    },
  ];
  const expected =
    '"Location","Group ID","Fixture","Unit","Universe","Address","Offset","Function","Output"\r\n' +
    '"Main Truss","b1","\'=Blinder ""Pro""","1","1","5","1","Dimmer","Enabled"\r\n' +
    '"Main Truss","b1","\'=Blinder ""Pro""","1","1","6","2","Reserved","Enabled"\r\n';
  assert.equal(patchCsv(rig), expected);
});

test('computeFixtureDemand combines overhead and floor fixtures cleanly', () => {
  const demand = computeFixtureDemand(RIG_TEMPLATES.club_stage);
  const total = [...demand.values()].reduce((a, b) => a + b, 0);
  const expected =
    RIG_TEMPLATES.club_stage.trussPods.flatMap((p) => p.fixtures).reduce((s, g) => s + g.count, 0) +
    RIG_TEMPLATES.club_stage.floorFx.reduce((s, g) => s + g.count, 0);
  assert.equal(total, expected);
});

test('QA regression (M1): mixed DMX modes with fractional unit weight maintain exact total parity with productionEstimator', () => {
  // Robe LEDBeam 150 weighs 5.7 kg = 12.566334 lb (rounds up per unit: 13 + 13 = 26, vs round(2 * 12.566) = 25).
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'pod-frac',
      name: 'Front',
      shape: 'box',
      width: 10,
      x: 0,
      baseY: 7,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 9,
      fixtures: [
        {
          id: 'm1',
          type: 'beam',
          modelName: 'Robe LEDBeam 150',
          catalogId: 'robe-ledbeam-150',
          dmxMode: 'Mode 1 (Standard)',
          dmxChannels: 22,
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
        {
          id: 'm2',
          type: 'beam',
          modelName: 'Robe LEDBeam 150',
          catalogId: 'robe-ledbeam-150',
          dmxMode: 'Mode 2 (Reduced)',
          dmxChannels: 16,
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 40,
        },
      ],
    },
  ];
  const est = calculateProductionEstimate(rig);
  const inv = computeInventory(rig);
  assert.equal(inv.models.length, 2);
  assert.equal(inv.totals.weightLb, Math.round(est.totalWeightLbs));
  assert.equal(inv.totals.powerW, Math.round(est.totalWatts));
});

test('QA regression (M2): CSV emits pool In stock / Sub-rent once per stockKey so column sum equals Total across multi-mode and generic+catalogue pools', () => {
  const rig = makeEmptyRig();
  rig.trussPods = [
    {
      id: 'pod-pool',
      name: 'Front',
      shape: 'box',
      width: 12,
      x: 0,
      baseY: 8,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 5,
      motorMaxY: 10,
      fixtures: [
        // Two MegaPointe modes sharing pool (need 2 + 3 = 5 vs club stock 4 -> sub-rent 1)
        {
          id: 'mp1',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 1 (Standard 16-bit)',
          dmxChannels: 39,
          count: 2,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
        {
          id: 'mp2',
          type: 'beam',
          modelName: 'Robe MegaPointe',
          catalogId: 'robe-megapointe',
          dmxMode: 'Mode 2 (Reduced)',
          dmxChannels: 34,
          count: 3,
          dmxUniverse: 1,
          dmxStartChannel: 100,
        },
        // Generic beam (5) + explicit Claypaky Sharpy (5) sharing claypaky-sharpy pool (need 10 vs club stock 8 -> sub-rent 2)
        {
          id: 'gen-beam',
          type: 'beam',
          modelName: 'Sharpy X-Beam 350',
          count: 5,
          dmxUniverse: 2,
          dmxStartChannel: 1,
        },
        {
          id: 'cat-sharpy',
          type: 'beam',
          modelName: 'Claypaky Sharpy',
          catalogId: 'claypaky-sharpy',
          dmxMode: 'Standard (16-Ch)',
          dmxChannels: 16,
          count: 5,
          dmxUniverse: 2,
          dmxStartChannel: 100,
        },
      ],
    },
  ];
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club' };
  const csv = equipmentInventoryCsv(rig, undefined, clubShop);
  const rows = parseCsvRows(csv);
  const dataRows = rows.slice(1, -1);
  const totalRow = rows.at(-1);
  const summedSubRent = dataRows.reduce((sum, r) => sum + (r[8] ? Number(r[8]) : 0), 0);
  assert.equal(summedSubRent, 3); // 1 MegaPointe + 2 Sharpy
  assert.equal(Number(totalRow[8]), summedSubRent);
  // Second row in each shared pool leaves In stock & Sub-rent blank and notes the shared pool.
  const sharedRows = dataRows.filter((r) => r[17].includes('shared stock pool'));
  assert.equal(sharedRows.length, 2);
  for (const r of sharedRows) {
    assert.equal(r[7], '');
    assert.equal(r[8], '');
  }
});

test('QA regression (M6): computeLedCabinetDemand uses authored main-led wall surface instead of stock wall + wings', () => {
  const rig = structuredClone(RIG_TEMPLATES.club_stage);
  rig.ledWall = {
    ...rig.ledWall,
    enabled: true,
    sideWings: true,
    cabinets: {
      cabinetId: 'roe-bp2-v2',
      columns: 16,
      rows: 10,
      widthMm: 500,
      heightMm: 500,
      pixelsWide: 176,
      pixelsHigh: 176,
    },
  };
  // Authored main-led of 4m x 3m -> 8 x 6 = 48 BP2 V2 cabinets (no wings).
  const stage = {
    walls: [
      {
        id: 'main-led',
        label: 'Authored Main Wall',
        width: 4,
        height: 3,
        x: 0,
        y: 2,
        z: -4,
        yaw: 0,
      },
    ],
    screenEvents: [],
  };
  const demand = computeLedCabinetDemand(rig, stage);
  assert.ok(demand);
  assert.equal(demand.catalogId, 'roe-bp2-v2');
  assert.equal(demand.cabinets, 48);
  const clubShop = { ...DEFAULT_SHOP_STATE, profileId: 'club' }; // club has exactly 48 BP2 V2
  const inv = computeInventory(rig, stage, clubShop);
  assert.equal(inv.shortages.filter((s) => s.stockKey === 'roe-bp2-v2').length, 0);
});
