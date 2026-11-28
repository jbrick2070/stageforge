import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { p4Rehearsal } from './support/p4-rehearsal.mjs';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const { ArtNetPreviewLevels } = await compiler.ssrLoadModule('/src/dmx/artNetPreviewLevels.ts');
const { BlinderPreviewBank, resolveBlinderPreviewBinding } = await compiler.ssrLoadModule('/src/engine/blinderPreview.ts');
const { createPreviewFlashState } = await compiler.ssrLoadModule('/src/engine/previewFlash.ts');
const { buildDmxPatch } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');

const authority = { revision: 'document', generation: 1 };
const mappings = [
  { universe: 3, portAddress: 2, sender: '127.0.0.1' },
  { universe: 4, portAddress: 3, sender: '127.0.0.1' },
];
const zeros = { invalid: 0, unselected: 0, unmapped: 0, sequence: 0 };
const slots = (...bytes) => { const data = new Uint8Array(512); data.set(bytes); return data; };
const row = (universe, sequence, sampleAtMs, sentAt, data = slots(255), patch = {}) => ({
  ...mappings.find(mapping => mapping.universe === universe), state: 'active',
  sampleAtMs, sampleSeq: sequence, ageMs: Math.floor(sentAt - sampleAtMs), received: 0xffffffff, lost: 0, data, ...patch,
});
const batch = (sentAtMs, rows, token = authority) => ({ authority: token, batchId: 1, sentAtMs, rows, drops: zeros });

function incoming(token = authority, request = 0, anchor = 0, receipt = request) {
  const input = new ArtNetPreviewLevels();
  input.begin(token, mappings, request);
  input.acceptAnchor(token, anchor, receipt);
  return input;
}
const bind = (unitId, start, universe = 3) => ({ unitId, address: { universe, start } });
const feed = (input, at, sequence, data, universe = 3, clock = at, token = authority) =>
  input.acceptBatch(batch(clock, [row(universe, sequence, at, clock, data)], token), clock);

function bankHarness(bindings, input = incoming()) {
  const bank = new BlinderPreviewBank();
  const state = createPreviewFlashState();
  bank.reconcile(bindings, input, state, 0);
  const frame = (clock, rawDesk = 0, { master = 1, limited = true, blackout = false, now = clock } = {}) => {
    state.clockMs = state.budgetClock.clockMs = clock;
    const visible = bank.prepare(input, state);
    const spill = bank.deliver(input, state, now, visible && !blackout ? rawDesk : 0, rawDesk, master, blackout, limited);
    return { spill, visible };
  };
  return { bank, state, input, frame };
}

test('P4 timestamps are pinned to the accepted Start and expire on the half-open renderer deadline', () => {
  const input = incoming(authority, 100, 5000, 120);
  input.acceptBatch(batch(5015, [row(3, 1, 5010, 5015)]), 125);
  assert.equal(input.read(3, 3109.9)?.deadline, 3110);
  assert.equal(input.read(3, 3110), null);
  input.acceptBatch(batch(5900, [row(3, 1, 5010, 5900), row(4, 1, 5900, 5900)]), 1015);
  assert.equal(input.read(3, 3110), null);
  assert.ok(input.read(4, 3110));
  input.acceptBatch(batch(6010, [row(3, 2, 6010, 6010, slots(66), { sender: '127.0.0.2' })]), 1150);
  assert.equal(input.latestSequence(3), 1);
  input.acceptBatch(batch(6020, [row(3, 2, 6020, 6020, slots(192))]), 5130);
  assert.equal(input.read(3, 5130), null, 'four seconds of IPC delay cannot make a pinned sample fresh');
  input.acceptBatch(batch(9070, [row(3, 3, 9070, 9070, slots(181))]), 5200);
  assert.equal(input.read(3, 5200)?.data[0], 181);
});

test('P4 invalid and exhausted timing fails dark, including the delayed Start boundary', () => {
  const delayed = incoming(authority, 10, 1100, 3010);
  assert.equal(delayed.timing, 'unavailable');
  delayed.acceptBatch(batch(1101, [row(3, 1, 1101, 1101)]), 3020);
  assert.equal(delayed.read(3, 3020), null);
  const next = { ...authority, generation: 2 };
  delayed.begin(next, mappings, 3020);
  delayed.acceptAnchor(next, 4110, 3025);
  assert.equal(delayed.timing, 'ready');
  delayed.acceptBatch(batch(4120, [row(3, 1, 4120, 4120)]), 3050);
  assert.equal(delayed.read(3, 3050), null, 'late old authority stays unavailable');
  delayed.acceptBatch(batch(4120, [row(3, 1, 4120, 4120)], next), 3050);
  assert.ok(delayed.read(3, 3050));
  for (const [sequence, stamp, sent, patch] of [
    [2, 4119, 4121, {}], [3, 4122, 4122, { ageMs: 22 }], [4, 4121, 4123, { sampleAtMs: Infinity }],
    [5, 4109, 4124, {}], [6, 4126, 4125, { ageMs: 0 }],
  ]) {
    delayed.acceptBatch(batch(sent, [row(3, sequence, stamp, sent, slots(255), patch)], next), 3080);
    assert.equal(delayed.read(3, 3080), null);
  }
  delayed.acceptBatch(batch(4127, [row(3, Number.MAX_SAFE_INTEGER, 4127, 4127)], next), 3080);
  assert.ok(delayed.read(3, 3080));
  delayed.acceptBatch(batch(4128, [row(3, null, 4128, 4128)], next), 3081);
  assert.equal(delayed.read(3, 3081), null);
  delayed.acceptBatch(batch(4129, [row(3, 1, 4129, 4129)], next), 3082);
  assert.equal(delayed.read(3, 3082), null);
});

test('P4 uses scoped one-slot identity and leaves the real stock four-slot footprint on Desk', () => {
  for (const stock of [false, true]) {
    const { rig } = p4Rehearsal({ stock });
    const group = rig.trussPods[0].fixtures[0];
    const patch = buildDmxPatch(rig).units.filter(unit => unit.groupId === group.id);
    assert.deepEqual(patch.map(unit => [unit.universe, unit.effectiveStart, unit.width]), stock ? [[3, 1, 4], [3, 5, 4]] : [[3, 1, 1], [3, 2, 1]]);
    const bindings = patch.map(unit => resolveBlinderPreviewBinding(group, unit));
    assert.notEqual(bindings[0].unitId, bindings[1].unitId);
    assert.equal(bindings.every(unit => !!unit.address), !stock);
    const original = patch[0];
    for (const invalid of [{ effectiveStart: 0 }, { effectiveStart: 513 }, { conflict: true }, { overflow: true }, { universe: 17 }]) {
      assert.equal(resolveBlinderPreviewBinding(group, { ...original, ...invalid }).address, null);
    }
    assert.equal(resolveBlinderPreviewBinding({ ...group, catalogId: 'generic-test' }, original).address, null);
  }
});

test('P4 repatch and undo require a later sample and preserve unchanged siblings and new-authority recovery', () => {
  const first = bind('left', 1);
  const right = bind('right', 2, 4);
  const repatch = bind('left', 3);
  const { bank, input, state, frame } = bankHarness([first, right]);
  input.source = 'external';
  feed(input, 100, 1, slots(255));
  feed(input, 100, 1, slots(0, 255), 4);
  assert.equal(frame(100).spill, 1);
  bank.reconcile([repatch, right], input, state, 600);
  input.acceptBatch(batch(625, [row(3, 2, 599, 625, slots(255, 0, 255))]), 625);
  frame(625);
  assert.equal(state.budgetClock.lastDir, -1, 'the removed visible binding records its fall');
  assert.deepEqual([bank.level('left'), bank.level('right')], [0, 1]);
  feed(input, 650, 3, slots(255, 0, 255));
  frame(650);
  assert.equal(bank.level('left'), 1);
  bank.reconcile([first, right], input, state, 700);
  frame(701);
  assert.deepEqual([bank.level('left'), bank.level('right')], [0, 1]);
  feed(input, 1700, 4, slots(255));
  frame(1700);
  bank.reconcile([first, right], input, state, 1701); // a nonpatch edit preserves both bindings
  frame(1702);
  assert.deepEqual([bank.level('left'), bank.level('right')], [1, 1]);
  frame(3100, 0, { now: 3100 });
  assert.deepEqual([bank.level('left'), bank.level('right')], [1, 0]);
  input.end();
  frame(3110);
  assert.deepEqual([bank.level('left'), bank.level('right')], [0, 0]);
  const newer = { ...authority, generation: 2 };
  input.begin(newer, mappings, 3200);
  input.acceptAnchor(newer, 3200, 3200);
  feed(input, 3400, 1, slots(255), 3, 3400, newer);
  frame(3400);
  assert.equal(bank.level('left'), 1);
  assert.equal(bank.level('right'), 0);
});

test('P4 tracks local full-rate Desk history and guards asymmetric Stop without spending hidden Desk edges', () => {
  const h = bankHarness([bind('left', 1), bind('right', 2)]);
  h.frame(20);
  h.input.source = 'external';
  feed(h.input, 100, 1, slots(0, 255));
  assert.deepEqual(h.frame(100, 1), { spill: 1, visible: false });
  assert.equal(h.state.budgetClock.lastAdmittedRiseMs, 100);
  h.input.source = 'desk';
  h.input.end();
  assert.deepEqual(h.frame(110, 1, { limited: false }), { spill: 1, visible: false });
  assert.deepEqual([h.bank.level('left'), h.bank.level('right')], [0, 1]);
  h.frame(800, 1, { limited: false });
  h.frame(1490, 1, { limited: false });
  assert.deepEqual(h.frame(1590, 1, { limited: false }), { spill: 1, visible: true });
  assert.deepEqual([h.bank.level('left'), h.bank.level('right')], [1, 1]);

  const siblings = bankHarness([bind('external', 1), { unitId: 'stock', address: null }]);
  siblings.frame(20, 1, { limited: false });
  siblings.frame(40, 0, { limited: false });
  siblings.input.source = 'external';
  feed(siblings.input, 120, 1, slots(255));
  siblings.frame(120, 1, { limited: false });
  assert.equal(siblings.state.budgetClock.lastAdmittedRiseMs, 120, 'full-rate Desk sibling delivered its co-timed rise');
  assert.deepEqual([siblings.bank.level('external'), siblings.bank.level('stock')], [0, 1], 'local history prohibits a free same-frame rise');
  siblings.frame(520, 1, { limited: false });
  assert.equal(siblings.bank.level('external'), 1);
  siblings.bank.blackout(siblings.state);
  assert.equal(siblings.bank.level('external'), 0);
  siblings.frame(530, 0, { limited: false });
  assert.equal(siblings.bank.level('external'), 0, 'blackout does not reset local rise history');

  const empty = bankHarness([]);
  assert.deepEqual(empty.frame(600, 0.42), { spill: 0.42, visible: true });
});

test('P4 alternating external lamps share the existing room ceiling at each tick', () => {
  for (const limited of [true, false]) {
    const h = bankHarness([bind('left', 1), bind('right', 2)]);
    h.input.source = 'external';
    const rises = [];
    let previous = [0, 0];
    for (let i = 1; i < 150; i++) {
      const at = i * 17;
      feed(h.input, at, i, slots(i % 2 ? 255 : 0, i % 2 ? 0 : 255));
      h.frame(at, 1, { limited });
      const delivered = [h.bank.level('left'), h.bank.level('right')];
      if (delivered.some((value, unit) => value - previous[unit] > 0.02)) rises.push(at);
      previous = delivered;
    }
    assert.ok(rises.length >= 4);
    assert.ok(rises.every(at => rises.filter(other => other >= at && other < at + 1000).length <= 3));
  }
});
