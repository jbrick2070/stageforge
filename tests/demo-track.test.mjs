import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const demoShowMod = await vite.ssrLoadModule('/src/data/demoShow.ts');
const demoLightingMod = await vite.ssrLoadModule('/src/data/demoLighting.ts');
const demoTrackMod = await vite.ssrLoadModule('/src/data/demoTrack.ts');
const presetsMod = await vite.ssrLoadModule('/src/data/presets.ts');

const {
  DEFAULT_DEMO_SECTIONS,
  DEFAULT_DEMO_TIMELINE,
  DEMO_TOTAL_BARS,
  DEMO_TOTAL_STEPS,
  OPENING_DONE_STEP,
  compileDemoTimeline,
  getDemoPosition,
} = demoShowMod;
const { applyDemoLighting, DEMO_BLACKOUT_STEPS, demoFade } = demoLightingMod;
const {
  DEMO_TRACK_FORMAT,
  demoTrackMsForStep,
  demoTrackStepAtMs,
  fetchDemoTrackAudio,
  getDemoTrackPosition,
  parseDemoTrackMap,
  probeDemoTrack,
  resolveDemoTrackAudioUrl,
  resolveDemoTrackMapUrl,
} = demoTrackMod;
const { INITIAL_SHOW_STATE } = presetsMod;

test.after(async () => {
  await vite.close();
});

// Exact HEAD baseline implementations of getDemoPosition and applyDemoLighting (pinned prior to Sprint 10).
const HEAD_SECTIONS = [
  { id: 'intro', label: 'Walk-on', bars: 8 },
  { id: 'groove', label: 'First groove', bars: 8 },
  { id: 'build', label: 'Build', bars: 8 },
  { id: 'drop', label: 'First drop', bars: 8 },
  { id: 'breakdown', label: 'Breakdown', bars: 8 },
  { id: 'rebuild', label: 'Rebuild', bars: 8 },
  { id: 'finale', label: 'Finale', bars: 12 },
  { id: 'outro', label: 'Curtain call', bars: 4 },
];
const HEAD_LOOKS = {
  intro:     { colors: ['#ffae66', '#ffae66'], level: [0, 0.38], movement: 'fan', motor: 'low', screen: 'cybergrid' },
  groove:    { colors: ['#ffae66', '#4288dd'], level: [0.38, 0.58], movement: 'sweep', motor: 'breathe', screen: 'cybergrid' },
  build:     { colors: ['#fdab55', '#7666f0'], level: [0.58, 0.88], movement: 'wave', motor: 'high', screen: 'tunnel', laser: 'horizon' },
  drop:      { colors: ['#13c7fe', '#ff652d'], level: [1.00, 0.80], movement: 'flyout', motor: 'v_tilt', screen: 'spectrum', laser: 'fan' },
  breakdown: { colors: ['#324a99', '#efa482'], level: [0.14, 0.30], movement: 'fan', motor: 'low', screen: 'plasma' },
  rebuild:   { colors: ['#805cff', '#5fe8de'], level: [0.28, 0.93], movement: 'figure8', motor: 'high', screen: 'mandala', laser: 'wave' },
  finale:    { colors: ['#ffae45', '#f155b9'], level: [0.84, 1.00], movement: 'wave', motor: 'wave', screen: 'tunnel', laser: 'dual_cones' },
  outro:     { colors: ['#ffb779', '#ae7d80'], level: [0.57, 0.045], movement: 'fan', motor: 'breathe', screen: 'tour_text' },
};

function headFadeColor(from, to, amount) {
  if (amount <= 0) return from;
  if (amount >= 1) return to;
  const rgb = [1, 3, 5].map((i) => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
  });
  return '#' + rgb.join('');
}

function headGetDemoPosition(absoluteStep) {
  const step = Math.max(0, Math.min(1024, absoluteStep));
  const bar = Math.min(63, Math.floor(step / 16));
  let startBar = 0;
  for (const section of HEAD_SECTIONS) {
    if (bar < startBar + section.bars) {
      return {
        sectionId: section.id,
        label: section.label,
        bar,
        barInSection: bar - startBar,
        sectionBars: section.bars,
        sectionProgress: (step / 16 - startBar) / section.bars,
        stepInBar: Math.min(15, Math.floor(step - bar * 16)),
        step,
        finished: step === 1024,
      };
    }
    startBar += section.bars;
  }
  throw new RangeError('Invalid demo position');
}

function headApplyDemoLighting(state, pos) {
  const id = pos.sectionId;
  const look = HEAD_LOOKS[id];
  const lift = id === 'build' || id === 'rebuild';
  const peak = id === 'drop' || id === 'finale';
  const rest = lift && pos.barInSection === pos.sectionBars - 1 && pos.stepInBar >= 12;
  const progress = pos.sectionProgress;
  const ease = progress * progress * (3 - 2 * progress);
  const intro = id === 'intro';
  const groove = id === 'groove';
  const step = pos.step;
  const wingFade = demoFade(step, 64, 128);
  const level = intro ? 0.26 * demoFade(step, DEMO_BLACKOUT_STEPS, 56) + 0.12 * wingFade :
    rest ? 0.025 : look.level[0] + (look.level[1] - look.level[0]) * ease;
  const wash = 0.035 + level * (peak ? 0.70 : 0.48);
  const washFade = demoFade(step, 96, 128);
  const ledFade = demoFade(step, 128, 224);
  const accentColor = intro ? headFadeColor(look.colors[1], HEAD_LOOKS.groove.colors[1], wingFade) :
    id === 'build' ? headFadeColor(HEAD_LOOKS.groove.colors[1], look.colors[1], demoFade(step, 256, 288)) : look.colors[1];
  const accent = peak && pos.barInSection % 4 === 0 && pos.stepInBar < 2;
  const laserLevel = look.laser && !rest ? (peak ? 0.48 + level * 0.35 : Math.max(0, progress - 0.35) * 0.55) : 0;
  return {
    ...state,
    ...(state.movingGroups && Object.keys(state.movingGroups).length ? { movingGroups: {} } : {}),
    primaryColor: look.colors[0], accentColor,
    colorSplitMode: peak ? 'alternate' : 'gradient',
    beamIntensity: level, washIntensity: intro ? wash * washFade : wash,
    beamZoom: intro ? 0.12 + wingFade * 0.35 : lift ? 0.47 - progress * 0.38 : peak ? 0.18 : 0.47,
    movementMode: look.movement, movementSpeed: 0.07 + level * (peak ? 0.69 : 0.53),
    movementSpread: 0.19 + level * 0.76, goboPrism: id === 'finale' && pos.barInSection >= 4,
    strobeRate: 0, blinderLevel: accent ? 0.63 : 0,
    laser: { enabled: laserLevel > 0, intensity: laserLevel,
      pattern: look.laser ?? 'fan', colorMode: 'dual', beamCount: peak ? 18 : 8,
      spreadX: peak ? 0.87 : 0.52, spreadY: 0.35 + level * 0.26, speed: 0.1 + level * 0.38,
      tilt: 0.16, rotation: 0.24, strobe: 0, audienceScan: false },
    motors: { ...state.motors, mode: look.motor, speed: 0.18 + level * 0.39 },
    atmo: { ...state.atmo, hazeLevel: (0.40 + 0.21 * level) * (intro ? demoFade(step, DEMO_BLACKOUT_STEPS, 48) : 1),
      smokeOutput: intro ? 0 : groove ? 0.045 * ledFade : peak ? 0.20 : 0.045,
      co2Active: false, co2AutoOnDrop: peak },
    led: { ...state.led, enabled: !intro && (!groove || ledFade > 0), visualMode: look.screen,
      brightness: level * 0.72 * (intro || groove ? ledFade : 1), speed: 0.07 + level * 0.48 },
  };
}

function validMap(overrides = {}) {
  return {
    format: DEMO_TRACK_FORMAT,
    version: 1,
    title: 'Deep House Blues',
    file: 'midnight-blues.mp3',
    bpm: 120,
    firstDownbeatMs: 0,
    sections: [
      { role: 'intro', label: 'Walk-on', bars: 8 },
      { role: 'groove', label: 'Verse groove', bars: 12 },
      { role: 'drop', label: '12-bar chorus', bars: 12 },
      { role: 'outro', label: 'Fade out', bars: 4 },
    ],
    ...overrides,
  };
}

test('parseDemoTrackMap accepts valid maps including 12-bar blues, repeated roles, fractional BPM and boundary limits', () => {
  const parsed = parseDemoTrackMap(validMap());
  assert.equal(parsed.format, DEMO_TRACK_FORMAT);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.title, 'Deep House Blues');
  assert.equal(parsed.file, 'midnight-blues.mp3');
  assert.equal(parsed.bpm, 120);
  assert.equal(parsed.firstDownbeatMs, 0);
  assert.equal(parsed.timeline.totalBars, 36);
  assert.equal(parsed.timeline.totalSteps, 36 * 16);
  assert.equal(Object.isFrozen(parsed), true);

  // Boundary: 3 sections, 70 BPM, wav extension, non-zero downbeat.
  const minMap = parseDemoTrackMap(validMap({
    file: 'a.wav',
    bpm: 70,
    firstDownbeatMs: 1250.5,
    sections: [
      { role: 'groove', label: 'A', bars: 1 },
      { role: 'drop', label: 'B', bars: 12 },
      { role: 'outro', label: 'C', bars: 1 },
    ],
  }));
  assert.equal(minMap.timeline.totalBars, 14);
  assert.equal(minMap.timeline.leadingIntroBars, 0);
  assert.equal(minMap.timeline.openingBlackoutBars, 0);

  // Boundary: 24 sections, 180 BPM, m4a/ogg, repeated roles, exactly 512 bars.
  const manySections = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 === 0 ? 'groove' : 'drop',
    label: `Part ${i + 1}`,
    bars: i < 8 ? 22 : 21, // 8*22 + 16*21 = 176 + 336 = 512
  }));
  const maxMap = parseDemoTrackMap(validMap({
    file: 'set_2026-01.ogg',
    bpm: 180,
    sections: manySections,
  }));
  assert.equal(maxMap.timeline.totalBars, 512);
  assert.equal(maxMap.sections.length, 24);
});

test('parseDemoTrackMap rejects every invalid or hostile input with a readable Error', () => {
  const cases = [
    ['null', null, /object/i],
    ['array', [], /object/i],
    ['wrong format', validMap({ format: 'other' }), /format/i],
    ['version 0', validMap({ version: 0 }), /version/i],
    ['newer version 2', validMap({ version: 2 }), /newer format version 2/i],
    ['float version', validMap({ version: 1.5 }), /version/i],
    ['empty title', validMap({ title: '   \u0000\u202E  ' }), /title/i],
    ['too-long title', validMap({ title: 'A'.repeat(81) }), /title/i],
    ['path traversal file', validMap({ file: '../secret.mp3' }), /file/i],
    ['subfolder file', validMap({ file: 'sub/track.mp3' }), /file/i],
    ['backslash file', validMap({ file: 'sub\\track.mp3' }), /file/i],
    ['url file', validMap({ file: 'https://evil.test/a.mp3' }), /file/i],
    ['dot-dot in name', validMap({ file: 'a..b.mp3' }), /file/i],
    ['bad extension', validMap({ file: 'track.exe' }), /file/i],
    ['bpm too low', validMap({ bpm: 69.9 }), /bpm/i],
    ['bpm too high', validMap({ bpm: 180.1 }), /bpm/i],
    ['bpm NaN', validMap({ bpm: Number.NaN }), /bpm/i],
    ['bpm Infinity', validMap({ bpm: Number.POSITIVE_INFINITY }), /bpm/i],
    ['negative firstDownbeatMs', validMap({ firstDownbeatMs: -1 }), /firstDownbeatMs/i],
    ['NaN firstDownbeatMs', validMap({ firstDownbeatMs: Number.NaN }), /firstDownbeatMs/i],
    ['too few sections', validMap({ sections: [] }), /between 1 and 24/i],
    ['too many sections', validMap({ sections: Array.from({ length: 25 }, (_, i) => ({ role: 'groove', label: `S${i}`, bars: 4 })) }), /between 1 and 24/i],
    ['unknown role', validMap({ sections: [{ role: 'intro', label: 'A', bars: 4 }, { role: 'chorus', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /unknown role/i],
    ['zero bars', validMap({ sections: [{ role: 'intro', label: 'A', bars: 0 }, { role: 'groove', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /bars/i],
    ['float bars', validMap({ sections: [{ role: 'intro', label: 'A', bars: 4.5 }, { role: 'groove', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /bars/i],
    ['bars > 64', validMap({ sections: [{ role: 'intro', label: 'A', bars: 65 }, { role: 'groove', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /bars/i],
    ['total bars > 512', validMap({ sections: Array.from({ length: 9 }, (_, i) => ({ role: 'groove', label: `S${i}`, bars: 60 })) }), /total bars/i],
    ['empty section label', validMap({ sections: [{ role: 'intro', label: '   ', bars: 4 }, { role: 'groove', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /label/i],
    ['too-long section label', validMap({ sections: [{ role: 'intro', label: 'X'.repeat(49), bars: 4 }, { role: 'groove', label: 'B', bars: 4 }, { role: 'outro', label: 'C', bars: 4 }] }), /label/i],
  ];

  for (const [name, input, pattern] of cases) {
    assert.throws(
      () => parseDemoTrackMap(input),
      (err) => err instanceof Error && !(err instanceof TypeError) && pattern.test(err.message),
      `Expected readable error for ${name}`,
    );
  }

  // Non-plain prototype objects must be rejected cleanly before reading inherited properties.
  const inherited = Object.create(validMap());
  assert.throws(() => parseDemoTrackMap(inherited), /JSON object/i);
});

test('synth demo parity: getDemoPosition and applyDemoLighting match HEAD bit-for-bit across all 1/8 steps and random floats', () => {
  assert.equal(DEMO_TOTAL_BARS, 64);
  assert.equal(DEMO_TOTAL_STEPS, 1024);

  const checkStep = (step) => {
    const expectedPos = headGetDemoPosition(step);
    const actualPos = getDemoPosition(step);
    const actualViaArray = getDemoPosition(step, DEFAULT_DEMO_SECTIONS);
    assert.deepStrictEqual(actualPos, actualViaArray);

    // Every original DemoPosition field matches HEAD strictly.
    for (const key of Object.keys(expectedPos)) {
      assert.strictEqual(actualPos[key], expectedPos[key], `position.${key} mismatch at step ${step}`);
    }
    assert.strictEqual(actualPos.openingStep, expectedPos.step, `openingStep parity at step ${step}`);

    const expectedLook = headApplyDemoLighting(INITIAL_SHOW_STATE, expectedPos);
    const actualLook = applyDemoLighting(INITIAL_SHOW_STATE, actualPos);
    assert.deepStrictEqual(actualLook, expectedLook, `look mismatch at step ${step}`);
  };

  // Every 1/8 step from 0 to 1024 inclusive (8,193 points) plus clamping bounds.
  for (let i = -4; i <= 1024 * 8 + 4; i++) {
    checkStep(i / 8);
  }

  // Deterministic pseudo-random float steps across the entire song, plus non-default ShowState with movingGroups.
  const richState = {
    ...INITIAL_SHOW_STATE,
    movingGroups: { 'upstage-beams': { intensity: 0.9, color: '#ff00aa' } },
    motors: { ...INITIAL_SHOW_STATE.motors, speed: 0.77, podTargets: { p1: { height: 0.5, tilt: 0.2 } } },
    atmo: { ...INITIAL_SHOW_STATE.atmo, hazeLevel: 0.88, smokeOutput: 0.44, co2Active: true },
    led: { ...INITIAL_SHOW_STATE.led, tourText: 'TOUR 2026', customMediaUrl: 'blob:demo', customMediaType: 'video' },
  };
  let seed = 0x13579bdf;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < 1000; i++) {
    const step = nextRand() * 1024;
    checkStep(step);
    const expectedPos = headGetDemoPosition(step);
    const actualPos = getDemoPosition(step);
    assert.deepStrictEqual(
      applyDemoLighting(richState, actualPos),
      headApplyDemoLighting(richState, expectedPos),
      `richState look mismatch at step ${step}`,
    );
  }
});

test('role-to-look parity: custom track sections produce the same look as the synth demo at equal role and progress', () => {
  const customSections = [
    { role: 'intro', label: 'Slow open', bars: 16 },
    { role: 'groove', label: 'House pocket', bars: 12 },
    { role: 'build', label: 'Riser 1', bars: 4 },
    { role: 'drop', label: 'Blues drop 1', bars: 8 },
    { role: 'breakdown', label: 'Piano break', bars: 8 },
    { role: 'rebuild', label: 'Climb', bars: 8 },
    { role: 'drop', label: 'Blues drop 2', bars: 12 },
    { role: 'finale', label: 'Peak', bars: 12 },
    { role: 'outro', label: 'Goodnight', bars: 4 },
  ];
  const timeline = compileDemoTimeline(customSections);

  // Compare first drop (index 3, 8 bars starting at bar 32) against synth drop (bar 24, 8 bars) at equal progress.
  for (const offsetSteps of [0, 1, 2, 16, 48, 64, 96, 127]) {
    const synthPos = getDemoPosition(24 * 16 + offsetSteps, DEFAULT_DEMO_TIMELINE);
    const customPos = getDemoPosition(32 * 16 + offsetSteps, timeline);
    assert.equal(synthPos.sectionId, 'drop');
    assert.equal(customPos.sectionId, 'drop');
    assert.equal(customPos.sectionProgress, synthPos.sectionProgress);
    assert.deepStrictEqual(
      applyDemoLighting(INITIAL_SHOW_STATE, customPos),
      applyDemoLighting(INITIAL_SHOW_STATE, synthPos),
    );
  }

  // Compare repeated 12-bar drop (index 6, starting at bar 56) at 50% progress (barInSection=6 -> 6%4=2, matching synth barInSection=4? Compare at barInSection=4 vs 4 -> check non-accent barInSection=2 at 0.25 vs 3 at 0.25).
  const synthDropMid = getDemoPosition(24 * 16 + 4 * 16 + 4, DEFAULT_DEMO_TIMELINE); // progress 0.53125, barInSection=4, stepInBar=4 (accent=false)
  const bluesDropMid = getDemoPosition(56 * 16 + 6 * 16 + 6, timeline); // progress 0.53125, barInSection=6, stepInBar=6 (accent=false)
  assert.equal(bluesDropMid.sectionId, 'drop');
  assert.equal(bluesDropMid.sectionBars, 12);
  assert.equal(bluesDropMid.sectionProgress, synthDropMid.sectionProgress);
  assert.deepStrictEqual(
    applyDemoLighting(INITIAL_SHOW_STATE, bluesDropMid),
    applyDemoLighting(INITIAL_SHOW_STATE, synthDropMid),
  );

  // Verify 16-bar leading intro plays the 8-bar reveal then holds at openingStep=128 without snapping back on groove.
  assert.equal(getDemoPosition(0, timeline).openingStep, 0);
  assert.equal(getDemoPosition(64, timeline).openingStep, 64);
  assert.equal(getDemoPosition(128, timeline).openingStep, 128);
  assert.equal(getDemoPosition(200, timeline).openingStep, 128);
  assert.equal(getDemoPosition(256, timeline).openingStep, 128); // groove bar 0 starts LED fade smoothly from 128
  assert.equal(getDemoPosition(352, timeline).openingStep, 224); // groove bar 6 completes LED fade

  // Verify compressed 4-bar leading intro scales openingStep by 2x and holds 1 blackout bar.
  const shortTimeline = compileDemoTimeline([
    { role: 'intro', label: 'Short intro', bars: 4 },
    { role: 'groove', label: 'Groove', bars: 8 },
    { role: 'outro', label: 'Outro', bars: 4 },
  ]);
  assert.equal(shortTimeline.openingBlackoutBars, 1);
  assert.equal(getDemoPosition(16, shortTimeline).openingStep, 32);
  assert.equal(getDemoPosition(64, shortTimeline).openingStep, 128);

  // Verify groove-first track skips opening blackout entirely.
  const grooveFirst = compileDemoTimeline([
    { role: 'groove', label: 'Instant groove', bars: 8 },
    { role: 'drop', label: 'Drop', bars: 8 },
    { role: 'outro', label: 'End', bars: 4 },
  ]);
  assert.equal(grooveFirst.openingBlackoutBars, 0);
  assert.equal(getDemoPosition(0, grooveFirst).openingStep, OPENING_DONE_STEP);
  assert.equal(applyDemoLighting(INITIAL_SHOW_STATE, getDemoPosition(0, grooveFirst)).led.enabled, true);
});

test('track clock step math at downbeat, before downbeat, one bar in, across boundaries, and on ended', () => {
  const map = parseDemoTrackMap(validMap({
    bpm: 120,
    firstDownbeatMs: 500,
    sections: [
      { role: 'groove', label: 'Groove', bars: 4 },
      { role: 'build', label: 'Build', bars: 4 },
      { role: 'drop', label: 'Drop', bars: 12 },
      { role: 'outro', label: 'Outro', bars: 4 },
    ],
  }));

  // Before downbeat: negative raw step, holds opening blackout even though first section is groove.
  assert.equal(demoTrackStepAtMs(map, 0), -4);
  const pre = getDemoTrackPosition(map, 250, false);
  assert.equal(pre.beforeDownbeat, true);
  assert.equal(pre.step, 0);
  assert.equal(pre.openingStep, 0);
  assert.equal(pre.finished, false);
  const preLook = applyDemoLighting(INITIAL_SHOW_STATE, pre);
  assert.equal(preLook.beamIntensity, 0);
  assert.equal(preLook.washIntensity, 0);
  assert.equal(preLook.led.enabled, false);

  // Exactly at firstDownbeatMs: step 0, bar 0, no longer beforeDownbeat.
  assert.equal(demoTrackStepAtMs(map, 500), 0);
  const atDownbeat = getDemoTrackPosition(map, 500, false);
  assert.equal(atDownbeat.beforeDownbeat, undefined);
  assert.equal(atDownbeat.sectionId, 'groove');
  assert.equal(atDownbeat.bar, 0);
  assert.equal(atDownbeat.step, 0);

  // One bar in at 120 BPM = 2000 ms after downbeat = 2500 ms -> step 16, bar 1.
  assert.equal(demoTrackStepAtMs(map, 2500), 16);
  assert.equal(demoTrackMsForStep(map, 16), 2500);
  const oneBar = getDemoTrackPosition(map, 2500, false);
  assert.equal(oneBar.sectionId, 'groove');
  assert.equal(oneBar.bar, 1);
  assert.equal(oneBar.barInSection, 1);

  // Across section boundaries: bar 4 (8500 ms) -> build; bar 8 (16500 ms) -> 12-bar drop; bar 20 (40500 ms) -> outro.
  assert.equal(getDemoTrackPosition(map, 8500, false).sectionId, 'build');
  assert.equal(getDemoTrackPosition(map, 16500, false).sectionId, 'drop');
  assert.equal(getDemoTrackPosition(map, 16500, false).sectionBars, 12);
  assert.equal(getDemoTrackPosition(map, 40500, false).sectionId, 'outro');

  // Audio ends early before totalSteps: finished becomes true.
  const endedEarly = getDemoTrackPosition(map, 10000, true);
  assert.equal(endedEarly.finished, true);
});

test('URL resolution stays same-origin across root, GitHub Pages subpath, and Electron stageforge://app/', () => {
  const rootMap = resolveDemoTrackMapUrl('/', 'http://127.0.0.1:4179/');
  assert.equal(rootMap.href, 'http://127.0.0.1:4179/demo/track.json');
  assert.equal(resolveDemoTrackAudioUrl(rootMap, 'track.mp3').href, 'http://127.0.0.1:4179/demo/track.mp3');

  const pagesMap = resolveDemoTrackMapUrl('/stageforge/', 'https://jbrick2070.github.io/stageforge/');
  assert.equal(pagesMap.href, 'https://jbrick2070.github.io/stageforge/demo/track.json');
  assert.equal(resolveDemoTrackAudioUrl(pagesMap, 'track.mp3').href, 'https://jbrick2070.github.io/stageforge/demo/track.mp3');

  const electronMap = resolveDemoTrackMapUrl('./', 'stageforge://app/');
  assert.equal(electronMap.href, 'stageforge://app/demo/track.json');
  assert.equal(resolveDemoTrackAudioUrl(electronMap, 'track.mp3').href, 'stageforge://app/demo/track.mp3');

  assert.throws(() => resolveDemoTrackAudioUrl(pagesMap, '../escape.mp3'), /plain basename/i);
});

test('timeline edge cases: 1-bar intro scale 8, non-leading intro, array vs compiled parity, and audio longer/shorter than map', () => {
  // 1-bar leading intro compresses 128-step reveal by 8x -> 1 blackout bar.
  const oneBarSections = [
    { role: 'intro', label: 'Quick intro', bars: 1 },
    { role: 'groove', label: 'Groove', bars: 4 },
    { role: 'outro', label: 'Outro', bars: 4 },
  ];
  const oneBarTimeline = compileDemoTimeline(oneBarSections);
  assert.equal(oneBarTimeline.openingBlackoutBars, 1);
  assert.equal(getDemoPosition(4, oneBarTimeline).openingStep, 32);
  assert.equal(getDemoPosition(16, oneBarTimeline).openingStep, 128);
  assert.deepStrictEqual(getDemoPosition(20, oneBarSections), getDemoPosition(20, oneBarTimeline));

  // Non-leading intro gets section-relative choreography (not stuck at static 0.38) and repeated roles match at equal progress!
  const midIntro = compileDemoTimeline([
    { role: 'groove', label: 'Open groove', bars: 4 },
    { role: 'intro', label: 'Interlude 1', bars: 4 },
    { role: 'drop', label: 'Chorus', bars: 4 },
    { role: 'intro', label: 'Interlude 2', bars: 4 },
    { role: 'groove', label: 'Later groove', bars: 4 },
  ]);
  const interlude1 = getDemoPosition(4 * 16 + 40, midIntro);
  const interlude2 = getDemoPosition(12 * 16 + 40, midIntro);
  assert.equal(interlude1.sectionId, 'intro');
  assert.equal(interlude1.isOpening, false);
  assert.equal(interlude1.sectionIndex, 1);
  assert.equal(interlude2.sectionIndex, 3);
  assert.deepStrictEqual(
    applyDemoLighting(INITIAL_SHOW_STATE, interlude1),
    applyDemoLighting(INITIAL_SHOW_STATE, interlude2),
    'repeated non-opening intro occurrences must produce identical looks at equal progress',
  );
  // Two non-opening grooves also produce identical looks at equal progress
  const groove1 = getDemoPosition(0 * 16 + 24, midIntro);
  const groove2 = getDemoPosition(16 * 16 + 24, midIntro);
  assert.equal(groove1.isOpeningTransition, false);
  assert.equal(groove2.isOpeningTransition, false);
  assert.deepStrictEqual(
    applyDemoLighting(INITIAL_SHOW_STATE, groove1),
    applyDemoLighting(INITIAL_SHOW_STATE, groove2),
    'repeated groove occurrences without leading intro must produce identical looks',
  );

  // Single-section map is valid (Codex Sprint 10 amendment)
  const singleSection = parseDemoTrackMap(validMap({
    sections: [{ role: 'drop', label: 'One-drop jam', bars: 12 }],
  }));
  assert.equal(singleSection.sections.length, 1);
  assert.equal(singleSection.timeline.totalBars, 12);
  assert.equal(getDemoPosition(0, singleSection.timeline).sectionIndex, 0);

  // Frozen golden parity against stored fixture generated from pre-Sprint-10 commit 3361daa
  const goldenPath = path.join(process.cwd(), 'tests', 'fixtures', 'demo-synth-golden.json');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  assert.equal(golden.oracleCommit, '3361daa5d81e4f8bc7fbbea1bcabf7acca9f23df');
  for (const sample of golden.samples) {
    const pos = getDemoPosition(sample.step);
    for (const key of Object.keys(sample.position)) {
      assert.deepStrictEqual(pos[key], sample.position[key], `golden pos.${key} mismatch at step ${sample.step}`);
    }
    assert.deepStrictEqual(
      applyDemoLighting(golden.initialState, pos),
      sample.lookInitial,
      `golden initial look mismatch at step ${sample.step}`,
    );
    assert.deepStrictEqual(
      applyDemoLighting(golden.richState, pos),
      sample.lookRich,
      `golden rich look mismatch at step ${sample.step}`,
    );
  }

  // Audio running longer than map clamps at totalSteps and sets finished=true; beforeDownbeat+ended also marks finished.
  const map = parseDemoTrackMap(validMap({
    bpm: 120,
    firstDownbeatMs: 500,
    sections: [
      { role: 'intro', label: 'I', bars: 4 },
      { role: 'groove', label: 'G', bars: 4 },
      { role: 'outro', label: 'O', bars: 4 },
    ],
  }));
  const pastEnd = getDemoTrackPosition(map, 120_000, false);
  assert.equal(pastEnd.finished, true);
  assert.equal(pastEnd.step, map.timeline.totalSteps);
  assert.equal(pastEnd.sectionId, 'outro');

  const endedBeforeDownbeat = getDemoTrackPosition(map, 100, true);
  assert.equal(endedBeforeDownbeat.finished, true);
});

test('probeDemoTrack and fetchDemoTrackAudio handle 404, 204, HTML fallback, UTF-8 BOM, oversize bodies, redirects, and empty audio', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. 404 -> null silently
    globalThis.fetch = async () => new Response('Not found', { status: 404 });
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 2. 204 -> null silently
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 3. Vite SPA HTML 200 -> null silently
    globalThis.fetch = async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 4. UTF-8 BOM JSON -> parsed cleanly on subpath
    const bomJson = '\uFEFF' + JSON.stringify(validMap({ file: 'song.wav' }));
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://example.test/stageforge/demo/track.json');
      return new Response(bomJson, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const found = await probeDemoTrack('/stageforge/', 'https://example.test/stageforge/');
    assert.ok(found);
    assert.equal(found.audioUrl, 'https://example.test/stageforge/demo/song.wav');

    // 5. Redirect error -> probe returns null silently
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch: redirect error'); };
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 6. Oversize Content-Length on map -> probe returns null silently
    globalThis.fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(128 * 1024) },
    });
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 7. Oversize streamed map without Content-Length -> probe returns null silently
    globalThis.fetch = async () => new Response(new Uint8Array(70 * 1024), { status: 200 });
    assert.equal(await probeDemoTrack('/', 'http://127.0.0.1:4179/'), null);

    // 8. fetchDemoTrackAudio rejects HTML 200 fallback, zero-byte audio, and oversize Content-Length
    globalThis.fetch = async () => new Response('<html>spa</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    await assert.rejects(() => fetchDemoTrackAudio(found), /HTML instead of an audio/i);

    globalThis.fetch = async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    });
    await assert.rejects(() => fetchDemoTrackAudio(found), /empty/i);

    globalThis.fetch = async () => new Response(new Uint8Array(16), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'content-length': String(20 * 1024 * 1024) },
    });
    await assert.rejects(() => fetchDemoTrackAudio(found), /size limit/i);

    // 9. Valid audio bytes return a File with matching name and mime type
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'content-length': '4' },
    });
    const audioFile = await fetchDemoTrackAudio(found);
    assert.equal(audioFile.name, 'song.wav');
    assert.equal(audioFile.type, 'audio/wav');
    assert.equal(audioFile.size, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shipped public/demo/track.json and track.mp3 parse cleanly, match pinned digests, cover full 309.6 s audio, and preserve measured boundaries', () => {
  const demoDir = path.join(process.cwd(), 'public', 'demo');
  const mapRaw = readFileSync(path.join(demoDir, 'track.json'), 'utf8');
  const mapLf = mapRaw.replace(/\r\n/g, '\n');
  const mapDigest = createHash('sha256').update(mapLf, 'utf8').digest('hex');
  const mapCrlfDigest = createHash('sha256').update(mapLf.replace(/\n/g, '\r\n').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  assert.equal(mapDigest, '90d70f524b9579fcdb18c94d8010d58594e8273f5ceb5f43fc82a18fcf15c920');
  assert.equal(mapCrlfDigest, mapDigest);

  const map = parseDemoTrackMap(JSON.parse(mapLf));
  assert.equal(map.title, 'StageForge demo track');
  assert.equal(map.file, 'track.mp3');
  assert.equal(map.bpm, 122);
  assert.equal(map.firstDownbeatMs, 96);
  assert.equal(map.sections.length, 11);
  assert.equal(map.timeline.totalBars, 158);
  assert.equal(map.timeline.totalSteps, 158 * 16);

  // Verify the audio asset exists, stays under the 4 MB mobile budget, matches its pinned SHA-256, and starts with an ID3/MP3 header.
  const mp3Bytes = readFileSync(path.join(demoDir, map.file));
  assert.equal(mp3Bytes.byteLength, 3_715_925);
  assert.ok(mp3Bytes.byteLength < 4 * 1024 * 1024, 'shipped demo track must stay under 4 MiB');
  const mp3Digest = createHash('sha256').update(mp3Bytes).digest('hex');
  assert.equal(mp3Digest, 'f56ef9cea0b9406d694f2555a241072ece91d479bf85bd819ef7faec5841bd8e');
  const isId3 = mp3Bytes[0] === 0x49 && mp3Bytes[1] === 0x44 && mp3Bytes[2] === 0x33;
  const isMp3Sync = mp3Bytes[0] === 0xff && (mp3Bytes[1] & 0xe0) === 0xe0;
  assert.ok(isId3 || isMp3Sync, 'track.mp3 must start with an ID3 tag or MP3 frame sync');

  // Verify measured bar boundaries: Kick enters at bar 17 (0:31.6) and Breakdown at bar 109 (3:32.6).
  const kickStartMs = demoTrackMsForStep(map, 16 * 16);
  assert.ok(Math.abs(kickStartMs - 31_571.4) < 1, `expected Kick enters near 31,571 ms, got ${kickStartMs}`);
  const kickPos = getDemoTrackPosition(map, kickStartMs + 50, false);
  assert.equal(kickPos.sectionId, 'drop');
  assert.equal(kickPos.label, 'Kick enters');
  assert.equal(kickPos.bar, 16);

  const breakdownStartMs = demoTrackMsForStep(map, 108 * 16);
  assert.ok(Math.abs(breakdownStartMs - 212_555.0) < 1, `expected Breakdown near 212,555 ms, got ${breakdownStartMs}`);
  const breakdownPos = getDemoTrackPosition(map, breakdownStartMs + 50, false);
  assert.equal(breakdownPos.sectionId, 'breakdown');
  assert.equal(breakdownPos.label, 'Breakdown');
  assert.equal(breakdownPos.bar, 108);

  // The 158-bar map runs ~1.32 s past the 309.6 s audio on purpose so bar lines stay exact;
  // AudioEngine closes playback cleanly through the audio element's ended flag.
  const mappedEndMs = demoTrackMsForStep(map, map.timeline.totalSteps);
  assert.ok(mappedEndMs > 309_600 && mappedEndMs < 312_000, `expected map duration ~310.92 s, got ${mappedEndMs} ms`);
  const nearEndPlaying = getDemoTrackPosition(map, 309_600, false);
  assert.equal(nearEndPlaying.sectionId, 'outro');
  assert.equal(nearEndPlaying.bar, 157);
  assert.equal(nearEndPlaying.finished, false);
  const nearEndEnded = getDemoTrackPosition(map, 309_600, true);
  assert.equal(nearEndEnded.sectionId, 'outro');
  assert.equal(nearEndEnded.finished, true);
});

test('Playwright test locators for "Play demo" use exact matching so they never collide with "Play demo track"', () => {
  const roots = [path.join(process.cwd(), 'tests', 'e2e'), path.join(process.cwd(), 'tests', 'desktop')];
  const violations = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!/\.(mjs|js|ts|tsx)$/.test(entry.name)) continue;
      const content = readFileSync(fullPath, 'utf8');
      const rel = path.relative(process.cwd(), fullPath);
      // Catch single-line or multi-line getByRole / getByText locators that match "Play demo" non-exactly.
      const regexCall = /getBy(?:Role|Text)\s*\([\s\S]{0,160}?\/play demo\/i/g;
      for (const m of content.matchAll(regexCall)) {
        const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
        violations.push(`${rel}:${lineNo}: non-exact regex locator for "Play demo"`);
      }
      const stringCall = /getByRole\s*\([^)]*?name\s*:\s*['"]Play demo['"]([^)]*)\)/g;
      for (const m of content.matchAll(stringCall)) {
        if (!/exact\s*:\s*true/.test(m[1])) {
          const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
          violations.push(`${rel}:${lineNo}: getByRole("Play demo") missing exact: true`);
        }
      }
      const textCall = /getByText\s*\(\s*['"]Play demo['"]\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
      for (const m of content.matchAll(textCall)) {
        if (!m[1] || !/exact\s*:\s*true/.test(m[1])) {
          const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
          violations.push(`${rel}:${lineNo}: getByText("Play demo") missing exact: true`);
        }
      }
    }
  };
  for (const dir of roots) walk(dir);
  assert.deepStrictEqual(violations, []);
});
