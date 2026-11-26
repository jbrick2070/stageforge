import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom', optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const {
  evaluateCueFade,
  makeCueFadeDescriptor,
  resolveCuePreview,
} = await compiler.ssrLoadModule('/src/data/cueFade.ts');
const { resolveTakeFrame } = await compiler.ssrLoadModule('/src/data/showClock.ts');
const { INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');

const levels = (beamIntensity, washIntensity) => ({ beamIntensity, washIntensity });
const base = {
  look: structuredClone(INITIAL_SHOW_STATE), cueId: null, camera: 'wide', volume: 0.8,
  bump: { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false },
  music: { kind: 'none', name: '', playing: false },
  screen: { kind: 'none', target: 'main-led', name: '', playing: false },
};

test('cue fade evaluator cuts at zero and is linear at midpoint and endpoint', () => {
  const fade = makeCueFadeDescriptor(levels(0.1, 0.3), levels(0.9, 0.7), 2000);
  assert.deepEqual(evaluateCueFade(fade, 0), levels(0.1, 0.3));
  assert.deepEqual(evaluateCueFade(fade, 1000), levels(0.5, 0.5));
  assert.deepEqual(evaluateCueFade(fade, 2000), levels(0.9, 0.7));
  assert.deepEqual(evaluateCueFade(makeCueFadeDescriptor(fade.from, fade.to, 0), 0), fade.to);
  assert.equal(resolveCuePreview(fade, 2000, true), undefined);
});

test('recorded cue fades cold-open, midpoint-seek, and linear playback from one descriptor', () => {
  const fade = makeCueFadeDescriptor(levels(0, 0.2), levels(1, 0.8), 2000);
  const target = { ...base.look, beamIntensity: 1, washIntensity: 0.8 };
  const take = {
    durationMs: 3000,
    events: [{ atMs: 0, look: target, cueId: 'cue-a', cueFade: fade }],
  };
  const cold = resolveTakeFrame(take, 0, base, false);
  assert.deepEqual(cold.resolvedCuePreview.levels, fade.from);
  assert.equal(cold.resolvedCuePreview.running, false);
  assert.equal(cold.look.beamIntensity, 1, 'authored destination is separate from evaluated preview');

  const seek = resolveTakeFrame(take, 1000, base, false);
  assert.deepEqual(seek.resolvedCuePreview.levels, levels(0.5, 0.5));
  assert.equal(seek.resolvedCuePreview.remainingMs, 1000);
  assert.equal(seek.resolvedCuePreview.running, false);

  const play = resolveTakeFrame(take, 1000, base, true);
  assert.deepEqual(play.resolvedCuePreview.levels, seek.resolvedCuePreview.levels);
  assert.equal(play.resolvedCuePreview.running, true);
  assert.equal(resolveTakeFrame(take, 2000, base, true).resolvedCuePreview, undefined);
});

test('a follow/new GO replaces an in-flight fade from its displayed level without a jump', () => {
  const first = makeCueFadeDescriptor(levels(0, 0), levels(1, 1), 2000);
  const interruptAt = 500;
  const displayed = evaluateCueFade(first, interruptAt);
  const second = makeCueFadeDescriptor(displayed, levels(0.4, 0.2), 1000);
  const take = {
    durationMs: 2000,
    events: [
      { atMs: 0, look: { beamIntensity: 1, washIntensity: 1 }, cueId: 'cue-a', cueFade: first },
      { atMs: interruptAt, look: { beamIntensity: 0.4, washIntensity: 0.2 }, cueId: 'cue-b', cueFade: second },
    ],
  };
  assert.deepEqual(resolveTakeFrame(take, interruptAt, base, true).resolvedCuePreview.levels, displayed);
  assert.deepEqual(resolveTakeFrame(take, 1000, base, true).resolvedCuePreview.levels, levels(0.325, 0.225));
  assert.equal(resolveTakeFrame(take, 1500, base, true).resolvedCuePreview, undefined);
});

test('manual/blackout interruption and clock holds cancel or freeze preview deterministically', () => {
  const fade = makeCueFadeDescriptor(levels(0, 0), levels(1, 1), 2000);
  const take = {
    durationMs: 2500,
    events: [
      { atMs: 0, look: { beamIntensity: 1, washIntensity: 1 }, cueId: 'cue-a', cueFade: fade },
      { atMs: 600, cueFade: makeCueFadeDescriptor(levels(0.3, 0.3), levels(1, 1), 0) },
      { atMs: 700, look: { blackout: true } },
    ],
  };
  assert.equal(resolveTakeFrame(take, 600, base, true).resolvedCuePreview, undefined, 'manual snap cancels fade');
  assert.equal(resolveTakeFrame(take, 700, base, true).resolvedCuePreview, undefined, 'blackout remains immediate');

  const heldTake = { durationMs: 2500, events: take.events.slice(0, 1) };
  const held = resolveTakeFrame(heldTake, 600, base, false).resolvedCuePreview;
  assert.deepEqual(held.levels, levels(0.3, 0.3));
  assert.equal(held.running, false, 'clock-owner stop/seek holds the exact evaluated look');
});
