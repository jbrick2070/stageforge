import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.route('**/transport-check', route => route.fulfill({
    contentType: 'text/html', body: '<button>Enable audio</button><div id="stage" style="width:240px;height:160px"></div>',
  }));
  await page.goto('/transport-check');
  await page.getByRole('button').click();
});

test('timed music restores a linked track and fractional score position, and cancels stale loads', async ({ page }) => {
  const values = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const engine = new AudioEngine();
    const duration = 3, rate = 8000, bytes = duration * rate * 2;
    const wav = new ArrayBuffer(44 + bytes);
    const header = new DataView(wav);
    const label = (offset, s) => new Uint8Array(wav, offset, s.length).set(new TextEncoder().encode(s));
    label(0, 'RIFF'); header.setUint32(4, bytes + 36, true); label(8, 'WAVEfmt ');
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
    header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true);
    header.setUint16(32, 2, true); header.setUint16(34, 16, true);
    label(36, 'data'); header.setUint32(40, bytes, true);
    const file = new File([wav], 'Rehearsal.take.wav', { type: 'audio/wav' });
    const music = { kind: 'file', name: file.name, playing: false, offsetSeconds: 1.25 };
    await engine.restoreTimelineMusic(music, file, 120, 900);
    const paused = engine.timelineMusic();
    await engine.restoreTimelineMusic({ ...music, playing: true }, file, 120, 300);
    await new Promise(resolve => setTimeout(resolve, 80));
    const playing = engine.timelineMusic();
    const pending = engine.restoreTimelineMusic({ ...music, name: 'other.wav' },
      new File([wav], 'other.wav', { type: 'audio/wav' }), 120, 0).catch(error => error.name);
    await engine.restoreTimelineMusic({ kind: 'live', name: 'Line input', playing: true }, undefined, 120, 0);
    const cancelled = await pending, live = engine.timelineMusic();
    const missing = await engine.restoreTimelineMusic(music, undefined, 120, 0).catch(error => error.message);
    const demo = { kind: 'demo', name: 'Arena Anthem', playing: false, demoStep: 73.5 };
    await engine.restoreTimelineMusic(demo, undefined, 120, 2000);
    const held = engine.timelineMusic();
    await engine.restoreTimelineMusic({ ...demo, playing: true }, undefined, 120, 500);
    const started = engine.timelineMusic();
    engine.dispose();
    return { paused, playing, cancelled, live, missing, held, started };
  });
  expect(values.paused).toMatchObject({ kind: 'file', name: 'Rehearsal.take.wav', playing: false, offsetSeconds: 1.25 });
  expect(values.playing.playing).toBe(true);
  expect(values.playing.offsetSeconds).toBeGreaterThanOrEqual(1.55);
  expect(values.cancelled).toBe('AbortError');
  expect(values.live.kind).toBe('none');
  expect(values.missing).toContain('Relink');
  expect(values.held.demoStep).toBe(73.5);
  expect(values.started.demoStep).toBeGreaterThanOrEqual(77.5);
});

test('LED video seeks before metadata, freezes off screen, resumes on reveal and holds an explicit pause', async ({ page }) => {
  const video = await readFile(new URL('../fixtures/transport.webm', import.meta.url));
  await page.route('**/transport.webm', route => route.fulfill({ contentType: 'video/webm', body: video }));
  const values = await page.evaluate(async () => {
    const { StageEngine } = await import('/src/engine/StageEngine.ts');
    const { RIG_TEMPLATES, INITIAL_SHOW_STATE } = await import('/src/data/presets.ts');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const url = URL.createObjectURL(await (await fetch('/transport.webm')).blob());
    const state = structuredClone(INITIAL_SHOW_STATE);
    const template = Object.values(RIG_TEMPLATES).find(r => r.venue === 'club');
    const rig = { ...template, props: [], floorFx: [], trussPods: [], audioRig: { ...template.audioRig, crowdDensity: 0 } };
    rig.ledWall = { ...rig.ledWall, enabled: true };
    const idle = { playing: false, source: 'none', trackName: '', energy: 0, bass: 0, mid: 0,
      high: 0, beat: false, beatPulse: 0, drop: false, spectrum: new Float32Array(32) };
    const engine = new StageEngine(document.querySelector('#stage'), rig, state, () => idle);
    const withVideo = { ...state, led: { ...state.led, enabled: true, visualMode: 'custom', customMediaType: 'video', customMediaUrl: url } };
    engine.setShowState(withVideo);
    engine.restoreScreenTransport(false, 0.3);
    await wait(300);
    const held = engine.screenTransport();
    engine.restoreScreenTransport(true);
    await wait(170);
    const started = engine.screenTransport();
    engine.setShowState({ ...withVideo, led: { ...withVideo.led, visualMode: 'plasma' } });
    const hidden = engine.screenTransport();
    await wait(140);
    const still = engine.screenTransport();
    engine.setShowState(withVideo);
    await wait(90);
    const revealed = engine.screenTransport();
    engine.restoreScreenTransport(false, 0.15);
    engine.setShowState(withVideo);
    await wait(90);
    const paused = engine.screenTransport();
    engine.dispose();
    URL.revokeObjectURL(url);
    return { held, started, hidden, still, revealed, paused };
  });
  expect(values.held.playing).toBe(false);
  expect(values.held.offsetSeconds).toBeCloseTo(0.3, 2);
  expect(values.started.playing).toBe(true);
  expect(values.started.offsetSeconds).toBeGreaterThan(0.33);
  expect(values.hidden.playing).toBe(false);
  expect(values.still.offsetSeconds).toBeCloseTo(values.hidden.offsetSeconds, 2);
  expect(values.revealed.playing).toBe(true);
  expect(values.paused.playing).toBe(false);
  expect(values.paused.offsetSeconds).toBeCloseTo(0.15, 2);
});
