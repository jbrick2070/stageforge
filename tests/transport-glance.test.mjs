import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());
const {
  timecode, cueMarkers, wallMarkers, layoutTicks, wallGlancesAt, mainScreenGlance, screenGlances, MAX_TICKS_PER_LANE, scrubPosition,
} = await compiler.ssrLoadModule('/src/data/transportGlance.ts');
const { secondaryScreensAt } = await compiler.ssrLoadModule('/src/data/showClock.ts');
const fixture = JSON.parse(await readFile(new URL('./fixtures/native-authoring-v3.stageforge.show.json', import.meta.url), 'utf8'));

const stage = (screenEvents, walls = [{ id: 'main-led', label: 'Upstage' }, { id: 'sr', label: 'Stage right' }, { id: 'sl' }]) =>
  ({ format: 'stageforge-native-stage', version: 1, walls, screenEvents });
const video = (atMs, name, playing, target = 'sr') => ({ atMs, target, kind: 'video', name, playing, offsetSeconds: 0 });

test('timecode keeps the desk m:ss.t format', () => {
  assert.equal(timecode(0), '0:00.0');
  assert.equal(timecode(45_099), '0:45.0');
  assert.equal(timecode(62_000), '1:02.0');
  assert.equal(timecode(6_550), '0:06.5');
});

test('marker labels name the cue or wall, clip, action and time', () => {
  assert.deepEqual(cueMarkers([{ atMs: 45_000, cueId: 'drop', name: 'Festival Drop' }]),
    [{ atMs: 45_000, kind: 'cue', label: 'Cue Festival Drop at 0:45.0' }]);
  const labels = wallMarkers(stage([
    video(62_000, 'intro.mp4', true),
    { atMs: 63_000, target: 'sl', kind: 'image', name: 'logo.png', playing: false },
    video(64_000, 'loop.mp4', false),
    { atMs: 65_000, target: 'sr', kind: 'none', name: '', playing: false },
  ])).map(m => m.label);
  assert.deepEqual(labels, [
    'Stage right: intro.mp4 (play) at 1:02.0',
    'sl: logo.png (image) at 1:03.0',
    'Stage right: loop.mp4 (hold) at 1:04.0',
    'Stage right: clear at 1:05.0',
  ]);
  assert.deepEqual(wallMarkers(undefined), []);
});

test('ticks sit at atMs / duration, clamp to the take and use the slider range when it rounds up', () => {
  const markers = [
    { atMs: 4_000, kind: 'wall', label: 'w' },
    { atMs: 2_500, kind: 'cue', label: 'c' },
    { atMs: -100, kind: 'cue', label: 'early' },
    { atMs: 20_000, kind: 'wall', label: 'late' },
    { atMs: 4_000, kind: 'cue', label: 'same time, other lane' },
  ];
  const ticks = layoutTicks(markers, 10_000);
  assert.deepEqual(ticks.map(t => [t.kind, t.position, t.label]), [
    ['cue', 0, 'early'], ['cue', 0.25, 'c'], ['cue', 0.4, 'same time, other lane'], ['wall', 0.4, 'w'], ['wall', 1, 'late'],
  ]);
  // The clamped marker still seeks to (and is named by) its own time.
  assert.equal(ticks.at(-1).atMs, 20_000);
  assert.equal(new Set(ticks.map(t => t.key)).size, ticks.length);
  const rounded = layoutTicks([{ atMs: 12_345, kind: 'cue', label: 'end' }], 12_345, { rangeMs: 12_350 });
  assert.ok(Math.abs(rounded[0].position - 12_345 / 12_350) < 1e-12);
});

test('a zero or invalid duration draws no ticks', () => {
  const markers = [{ atMs: 0, kind: 'cue', label: 'c' }];
  assert.deepEqual(layoutTicks(markers, 0), []);
  assert.deepEqual(layoutTicks(markers, -5), []);
  assert.deepEqual(layoutTicks(markers, Number.NaN), []);
  assert.deepEqual(layoutTicks([], 10_000), []);
});

test('dense lanes thin to at most maxPerLane ticks and account for every merged marker', () => {
  const many = Array.from({ length: 1_000 }, (_, i) => ({ atMs: i * 10, kind: i % 2 ? 'wall' : 'cue', label: 'm' + i }));
  const ticks = layoutTicks(many, 10_000);
  for (const kind of ['cue', 'wall']) {
    const lane = ticks.filter(t => t.kind === kind);
    assert.ok(lane.length <= MAX_TICKS_PER_LANE, kind + ' lane has ' + lane.length + ' ticks');
    assert.equal(lane.reduce((sum, t) => sum + t.count, 0), 500);
    for (let i = 1; i < lane.length; i++) assert.ok(lane[i].position - lane[i - 1].position >= 1 / (MAX_TICKS_PER_LANE - 1) - 1e-12);
  }
  const first = ticks.find(t => t.kind === 'cue');
  assert.equal(first.atMs, 0);
  assert.match(first.label, /^m0 \(\+\d+ more\)$/);
  // Same-time markers always merge; spaced-out markers never do.
  const same = layoutTicks([{ atMs: 500, kind: 'cue', label: 'A' }, { atMs: 500, kind: 'cue', label: 'B' }], 1_000);
  assert.deepEqual(same.map(t => [t.label, t.count]), [['A (+1 more)', 2]]);
  const custom = layoutTicks(Array.from({ length: 10 }, (_, i) => ({ atMs: i * 100, kind: 'cue', label: String(i) })), 900, { maxPerLane: 4 });
  assert.ok(custom.length <= 4);
  assert.equal(layoutTicks(many.slice(0, 5).map(m => ({ ...m, kind: 'cue' })), 10_000, { maxPerLane: 1 }).length, 1);
});

test('wall state at t: exact event time, between events, after a clear, video vs image', () => {
  const show = stage([
    { atMs: 0, target: 'sr', kind: 'none', name: '', playing: false },
    video(1_000, 'hold.mp4', false),
    video(2_000, 'run.mp4', true),
    { atMs: 2_000, target: 'sl', kind: 'image', name: 'logo.png', playing: true },
    { atMs: 3_000, target: 'sr', kind: 'none', name: '', playing: false },
  ]);
  const at = (t, running = true) => Object.fromEntries(wallGlancesAt(show, t, running, []).map(g => [g.id, [g.name, g.state]]));
  assert.deepEqual(wallGlancesAt(show, 0, true, []).map(g => [g.id, g.label]), [['sr', 'Stage right'], ['sl', 'sl']]);
  assert.deepEqual(at(0), { sr: ['', 'none'], sl: ['', 'none'] });
  assert.deepEqual(at(999), { sr: ['', 'none'], sl: ['', 'none'] });
  assert.deepEqual(at(1_000), { sr: ['hold.mp4', 'hold'], sl: ['', 'none'] });
  assert.deepEqual(at(1_999), { sr: ['hold.mp4', 'hold'], sl: ['', 'none'] });
  assert.deepEqual(at(2_000), { sr: ['run.mp4', 'play'], sl: ['logo.png', 'hold'] });
  assert.deepEqual(at(2_500, false), { sr: ['run.mp4', 'hold'], sl: ['logo.png', 'hold'] });
  assert.deepEqual(at(3_000), { sr: ['', 'none'], sl: ['logo.png', 'hold'] });
  assert.deepEqual(at(60_000), { sr: ['', 'none'], sl: ['logo.png', 'hold'] });
  assert.deepEqual(wallGlancesAt(undefined, 0, true, []), []);
});

test('unlinked wall media reads Missing whether it would play or hold', () => {
  const show = stage([video(0, 'intro.mp4', true), video(0, 'still.mp4', false, 'sl')]);
  assert.deepEqual(wallGlancesAt(show, 10, true, ['intro.mp4', 'still.mp4']).map(g => [g.name, g.state]),
    [['intro.mp4', 'missing'], ['still.mp4', 'missing']]);
  assert.deepEqual(wallGlancesAt(show, 10, true, new Set(['still.mp4'])).map(g => g.state), ['play', 'missing']);
});

test('badges agree with the renderer resolution for every wall across the fixture take', () => {
  const show = fixture.stage;
  for (let t = 0; t <= fixture.timeline.durationMs; t += 250) {
    for (const running of [true, false]) {
      const rendered = secondaryScreensAt(show, t, running, () => 'url');
      for (const g of wallGlancesAt(show, t, running, [])) {
        const wall = rendered[g.id];
        const name = wall && wall.kind !== 'none' ? wall.name : '';
        assert.equal(g.name, name, `${g.id} at ${t}`);
        if (name) assert.equal(g.state, wall.playing ? 'play' : 'hold', `${g.id} at ${t}`);
      }
    }
  }
  const at = t => wallGlancesAt(show, t, true, [])[0];
  assert.deepEqual([at(6_500).name, at(6_500).state], ['guest-surface.mp4', 'hold']);
  assert.deepEqual([at(13_499).name, at(13_499).state], ['blue-raster.mp4', 'hold']);
  assert.deepEqual([at(13_500).name, at(13_500).state], ['blue-raster.mp4', 'play']);
  assert.equal(at(16_000).state, 'none');
});

test('main LED badge follows the resolved main screen and the stage label', () => {
  assert.deepEqual(mainScreenGlance({ kind: 'none', name: '', playing: false }, []),
    { id: 'main-led', label: 'Main LED', kind: 'none', name: '', state: 'none' });
  assert.equal(mainScreenGlance(undefined, []).state, 'none');
  assert.equal(mainScreenGlance({ kind: 'video', name: 'a.mp4', playing: true }, []).state, 'play');
  assert.equal(mainScreenGlance({ kind: 'video', name: 'a.mp4', playing: false }, []).state, 'hold');
  assert.equal(mainScreenGlance({ kind: 'image', name: 'a.png', playing: true }, []).state, 'hold');
  assert.equal(mainScreenGlance({ kind: 'video', name: 'a.mp4', playing: true }, ['a.mp4']).state, 'missing');
  const all = screenGlances(fixture.stage, 7_000, true, { kind: 'video', name: 'amber-clouds.mp4', playing: true }, ['guest-surface.mp4']);
  assert.deepEqual(all.map(g => [g.id, g.label, g.name, g.state]), [
    ['main-led', 'Upstage wall', 'amber-clouds.mp4', 'play'],
    ['side-led', 'Stage right', 'guest-surface.mp4', 'missing'],
  ]);
  assert.deepEqual(screenGlances(undefined, 0, false, undefined, []).map(g => [g.label, g.state]), [['Main LED', 'none']]);
});

test('the scrubber value stays on the 50 ms step grid and the end stays reachable', () => {
  assert.deepEqual(scrubPosition(14_437, 16_000), { max: 16_000, value: 14_450 });
  assert.deepEqual(scrubPosition(16_010, 16_010), { max: 16_050, value: 16_000 });
  assert.deepEqual(scrubPosition(99_999, 16_010), { max: 16_050, value: 16_000 });
  assert.deepEqual(scrubPosition(-5, 0), { max: 0, value: 0 });
  for (const t of [1, 24, 25, 26, 7_777, 15_999]) assert.equal(scrubPosition(t, 16_000).value % 50, 0);
});