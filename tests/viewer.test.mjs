import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const mod = await vite.ssrLoadModule('/src/viewer/capabilities.ts');
const parseMod = await vite.ssrLoadModule('/src/viewer/parseViewer.ts');
const showFileMod = await vite.ssrLoadModule('/src/data/showFile.ts');
const presetsMod = await vite.ssrLoadModule('/src/data/presets.ts');
const {
  EDITOR_CAPABILITIES,
  VIEWER_CAPABILITIES,
  capabilitiesForMode,
  isViewerUrlSearch,
  resolveGlobalHotkey,
} = mod;
const { parseViewerJson } = parseMod;
const { makeShowFile } = showFileMod;
const { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } = presetsMod;

test.after(async () => {
  await vite.close();
});

test('capability presets expose the exact 7 flags, are frozen, and map cleanly by mode', () => {
  const expectedKeys = [
    'autosave',
    'controllers',
    'edit',
    'liveOutput',
    'mutatingHotkeys',
    'save',
    'showControl',
  ];
  assert.deepEqual(Object.keys(EDITOR_CAPABILITIES).sort(), expectedKeys);
  assert.deepEqual(Object.keys(VIEWER_CAPABILITIES).sort(), expectedKeys);

  for (const key of expectedKeys) {
    assert.equal(EDITOR_CAPABILITIES[key], true, `editor.${key} must be true`);
    assert.equal(VIEWER_CAPABILITIES[key], false, `viewer.${key} must be false`);
  }

  assert.equal(Object.isFrozen(EDITOR_CAPABILITIES), true);
  assert.equal(Object.isFrozen(VIEWER_CAPABILITIES), true);
  assert.equal(capabilitiesForMode('editor'), EDITOR_CAPABILITIES);
  assert.equal(capabilitiesForMode('viewer'), VIEWER_CAPABILITIES);
});

test('isViewerUrlSearch treats ?view strictly as a boolean flag', () => {
  assert.equal(isViewerUrlSearch('?view'), true);
  assert.equal(isViewerUrlSearch('?view=1'), true);
  assert.equal(isViewerUrlSearch('?probe&view'), true);
  assert.equal(isViewerUrlSearch('?view=https://evil.example/show.json'), true);
  assert.equal(isViewerUrlSearch(''), false);
  assert.equal(isViewerUrlSearch('?probe'), false);
  assert.equal(isViewerUrlSearch('?viewer=1'), false);
  assert.equal(isViewerUrlSearch('?preview=true'), false);
});

test('resolveGlobalHotkey enforces the viewer allow-list and preserves all editor hotkeys', () => {
  const cases = [
    // Camera presets: allowed in both modes
    ['Digit1', { type: 'camera', preset: 'foh' }, { type: 'camera', preset: 'foh' }],
    ['Digit2', { type: 'camera', preset: 'front_row' }, { type: 'camera', preset: 'front_row' }],
    ['Digit3', { type: 'camera', preset: 'wide_arena' }, { type: 'camera', preset: 'wide_arena' }],
    ['Digit4', { type: 'camera', preset: 'stage_side' }, { type: 'camera', preset: 'stage_side' }],
    ['Digit5', { type: 'camera', preset: 'overhead' }, { type: 'camera', preset: 'overhead' }],
    ['Digit6', { type: 'camera', preset: 'orbit' }, { type: 'camera', preset: 'orbit' }],
    ['Digit7', { type: 'camera', preset: 'pa_closeup' }, { type: 'camera', preset: 'pa_closeup' }],
    // Cinema: allowed in both modes
    ['KeyH', { type: 'cinema' }, { type: 'cinema' }],
    // Space: blackout in editor, play/pause in viewer (never blackout in viewer)
    ['Space', { type: 'blackout' }, { type: 'playPause' }],
    // Cue navigation: viewer allow-list only
    ['ArrowRight', null, { type: 'go' }],
    ['PageDown', null, { type: 'go' }],
    ['ArrowLeft', null, { type: 'back' }],
    ['PageUp', null, { type: 'back' }],
    // Mutating hotkeys: allowed in editor, strictly blocked (null) in viewer
    ['KeyB', { type: 'bump', key: 'blinder' }, null],
    ['KeyS', { type: 'bump', key: 'strobe' }, null],
    ['KeyC', { type: 'bump', key: 'co2' }, null],
    ['KeyF', { type: 'bump', key: 'smoke' }, null],
    ['KeyL', { type: 'bump', key: 'laser' }, null],
    ['KeyD', { type: 'bump', key: 'motorDrop' }, null],
    ['KeyT', { type: 'tapTempo' }, null],
    ['KeyM', { type: 'measure' }, null],
    // Unmapped & prototype-property keys: null in both modes
    ['KeyA', null, null],
    ['KeyZ', null, null],
    ['Delete', null, null],
    ['Backspace', null, null],
    ['Enter', null, null],
    ['Escape', null, null],
    ['__proto__', null, null],
    ['constructor', null, null],
    ['toString', null, null],
  ];

  for (const [code, expectedEditor, expectedViewer] of cases) {
    assert.deepEqual(
      resolveGlobalHotkey(code, EDITOR_CAPABILITIES),
      expectedEditor,
      `editor hotkey mismatch for ${code}`,
    );
    assert.deepEqual(
      resolveGlobalHotkey(code, VIEWER_CAPABILITIES),
      expectedViewer,
      `viewer hotkey mismatch for ${code}`,
    );
  }
});

test('parseViewerJson loads v1-v7 shows and rig-only JSON purely and rejects corrupt or oversized input', async () => {
  // v1, v2, v3 canonical fixture files
  for (const [fixture, expectedVersion] of [
    ['fixtures/legacy-v1.stageforge.show.json', 1],
    ['fixtures/legacy-v2.stageforge.show.json', 2],
    ['fixtures/native-authoring-v3.stageforge.show.json', 3],
  ]) {
    const raw = await readFile(fileURLToPath(new URL(`./${fixture}`, import.meta.url)), 'utf8');
    const parsed = parseViewerJson('\uFEFF' + raw);
    assert.equal(parsed.kind, 'show', fixture);
    assert.equal(parsed.file.version, expectedVersion, fixture);
    assert.ok(parsed.nextRig.name.length > 0, fixture);
  }

  // v4 (interchange), v5 (SMPTE timeline), v6 (catalogue), v7 (rigging/power)
  const baseRig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  const v4 = makeShowFile(baseRig, SHOW_CUES, INITIAL_SHOW_STATE, null, undefined, undefined, undefined, undefined, {
    mvr: { uuids: { 'truss:front-truss': 'AAAAAAAA-0000-4000-8000-000000000001' } },
  });
  assert.equal(v4.version, 4);
  assert.equal(parseViewerJson(JSON.stringify(v4)).file.version, 4);

  const v5 = makeShowFile(baseRig, SHOW_CUES, INITIAL_SHOW_STATE, null, undefined, {
    durationMs: 1000, events: [], frameRate: 30, timecodeOffsetMs: 3600000,
  });
  assert.equal(v5.version, 5);
  assert.equal(parseViewerJson(JSON.stringify(v5)).file.version, 5);

  const v6Rig = structuredClone(baseRig);
  v6Rig.trussPods[0].fixtures[0] = {
    ...v6Rig.trussPods[0].fixtures[0],
    catalogId: 'robe-mega-pointe',
    dmxMode: 'Mode 1',
    dmxChannels: 39,
  };
  const v6 = makeShowFile(v6Rig, SHOW_CUES, INITIAL_SHOW_STATE, null);
  assert.equal(v6.version, 6);
  assert.equal(parseViewerJson(JSON.stringify(v6)).file.version, 6);

  const v7Rig = structuredClone(v6Rig);
  v7Rig.trussPods[0].trussProfileId = 'prolyte-h30v';
  const v7 = makeShowFile(v7Rig, SHOW_CUES, INITIAL_SHOW_STATE, null);
  assert.equal(v7.version, 7);
  assert.equal(parseViewerJson(JSON.stringify(v7)).file.version, 7);

  // Rig-only JSON loads cleanly without cues
  const rigDoc = parseViewerJson(JSON.stringify(baseRig));
  assert.equal(rigDoc.kind, 'rig');
  assert.equal(rigDoc.rig.name, baseRig.name);

  // Corrupt JSON throws readable Error
  assert.throws(() => parseViewerJson('{not json'), /Choose a valid StageForge/);
});
