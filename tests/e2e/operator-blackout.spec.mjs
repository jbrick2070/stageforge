import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const template = JSON.parse(await readFile(new URL('../../public/examples/amber-walk-on.stageforge.show.json', import.meta.url), 'utf8'));
const noBump = { blinder: false, strobe: false, co2: false, smoke: false, laser: false, motorDrop: false };

function rehearsal(withTake = false) {
  const show = structuredClone(template);
  show.version = 9;
  show.$schema = 'https://jbrick2070.github.io/stageforge/schemas/show-v9.schema.json';
  show.rig.trussPods = show.rig.trussPods.slice(0, 1);
  show.rig.floorFx = [];
  show.rig.ledWall.enabled = false;
  show.rig.audioRig.crowdDensity = 0;
  Object.assign(show.look, {
    autoDirector: false, audioReactive: false, blackout: false, masterDimmer: 0.8,
    washIntensity: 0.65, beamIntensity: 0.55, strobeRate: 0, blinderLevel: 0,
    atmo: { ...show.look.atmo, smokeOutput: 0 },
  });
  show.cues = [
    { id: 'ready', name: 'Ready', state: structuredClone(show.look) },
    { id: 'explicit-off', name: 'Bright', state: { blackout: false, masterDimmer: 0.8 }, followSeconds: 1 },
    { id: 'omitted', name: 'Amber', state: { masterDimmer: 0.65 } },
    { id: 'dark', name: 'Dark', state: { masterDimmer: 0.7 } },
  ].map(cue => ({ tag: 'SHOW', accent: '#ffaa88', ...cue }));
  show.activeCueId = 'ready';
  delete show.media;
  delete show.timeline;
  if (withTake) {
    show.timeline = { durationMs: 2600, events: [
      { atMs: 0, look: structuredClone(show.look) },
      { atMs: 100, bump: { ...noBump, strobe: true, smoke: true } },
      { atMs: 250, screen: { target: 'main-led', kind: 'none', name: '', playing: false } },
      { atMs: 950, bump: noBump },
      { atMs: 1400, bump: { ...noBump, strobe: true } },
      { atMs: 1600, look: { ...show.look, masterDimmer: 0.7 } },
      { atMs: 2200, bump: { ...noBump, strobe: true } },
    ] };
  }
  return show;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const holdButton = page => button(page, 'Operator blackout hold');
const summary = page => page.evaluate(() => window.stageforgeProbe.showStateSummary());
const activeCue = page => page.evaluate(() => window.stageforgeProbe.activeCueId());
const takeState = page => page.evaluate(() => window.stageforgeProbe.takeState());

async function freeze(page) {
  const start = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto('/?probe');
}

async function openFiles(page) {
  await button(page, 'Show files').press('Enter');
  return page.getByRole('dialog', { name: 'Show files' });
}

async function openShow(page, show, asViewer = false) {
  const files = await openFiles(page);
  await files.getByLabel(asViewer ? 'Open show in viewer' : 'Open show file').setInputFiles({
    name: 'operator-hold.stageforge.show.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(show)),
  });
  await expect(files).toBeHidden();
}

test('focused GO consumes Space once and the operator hold survives Follow and authored cue recall', async ({ page }) => {
  await freeze(page);
  await openShow(page, rehearsal());
  await button(page, 'Show cues').press('Enter');
  const go = button(page, 'GO');
  const hold = holdButton(page);

  await button(page, 'Edit cue list').press('Enter');
  const editor = page.getByRole('dialog', { name: 'Edit cue list' });
  await editor.getByLabel('Cue order').selectOption('dark');
  const authoredCheckbox = editor.getByRole('checkbox', { name: 'Cue blackout' });
  await authoredCheckbox.press('Space');
  await expect(authoredCheckbox).toBeChecked();
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await button(editor, 'Apply cues').press('Enter');
  await expect(editor).toBeHidden();

  await go.focus();
  expect(await go.evaluate(target => ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'].map(modifier => {
    const key = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true, [modifier]: true });
    target.dispatchEvent(key);
    return key.defaultPrevented;
  }))).toEqual([false, false, false, false]);
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.down('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  expect(await activeCue(page)).toBe('ready');
  await expect(page.getByRole('alert')).toHaveText('STAGE BLACKOUT · OPERATOR HOLD');

  await go.press('Enter');
  expect(await activeCue(page)).toBe('explicit-off');
  await expect(page.getByRole('group', { name: 'Cue stack' })).toContainText('Follow in');
  await page.clock.fastForward(1100);
  await expect.poll(() => activeCue(page)).toBe('omitted');
  expect(await summary(page)).toMatchObject({ blackout: true, authoredBlackout: false, operatorBlackout: true });

  await button(page, 'Record take').press('Enter');
  await hold.press('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.press('Space');
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(60);
  await button(page, 'Stop recording').press('Enter');
  const files = await openFiles(page);
  const download = page.waitForEvent('download');
  await button(files, 'Save show JSON').press('Enter');
  const saved = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(saved.look.blackout).toBe(false);
  expect(saved.cues.find(cue => cue.id === 'dark').state.blackout).toBe(true);
  expect(saved.timeline.events.map(event => event.look?.blackout).filter(value => value !== undefined)).toEqual([false]);
  await button(files, 'Close Show files').press('Enter');

  await go.press('Enter');
  expect(await activeCue(page)).toBe('dark');
  await expect(page.getByRole('alert')).toHaveText('STAGE BLACKOUT · OPERATOR HOLD · CUE BLACKOUT');
  await hold.press('Enter');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('alert')).toHaveText('STAGE BLACKOUT · CUE BLACKOUT');
  expect(await summary(page)).toMatchObject({ blackout: true, authoredBlackout: true, operatorBlackout: false });
});

test('first held control tick and immediate re-arm deliver dark ETC intensity to a mock listener', async ({ page }) => {
  await page.route('**/operator-dmx-test', route => route.fulfill({
    contentType: 'text/html', body: '<div id="stage" style="width:320px;height:180px"></div>',
  }));
  await page.goto('/operator-dmx-test');
  const output = await page.evaluate(async () => {
    const { StageEngine } = await import('/src/engine/StageEngine.ts');
    const { INITIAL_SHOW_STATE, RIG_TEMPLATES } = await import('/src/data/presets.ts');
    const rig = structuredClone(RIG_TEMPLATES.club_stage);
    const etc = dmxUniverse => ({
      id: `etc-${dmxUniverse}`, modelName: 'ETC ColorSource PAR', type: 'wash', count: 1,
      catalogId: 'etc-colorsource-par', dmxMode: '1-Ch', dmxUniverse, dmxStartChannel: 101, dmxChannels: 1,
    });
    rig.trussPods = [{ ...rig.trussPods[0], fixtures: [
      etc(1), etc(2),
      { id: 'sim-wash', modelName: 'Generic wash', type: 'wash', count: 1,
        dmxUniverse: 1, dmxStartChannel: 201, dmxChannels: 8 },
    ] }];
    rig.floorFx = [];
    rig.ledWall.enabled = false;
    rig.audioRig.crowdDensity = 0;
    const look = { ...structuredClone(INITIAL_SHOW_STATE), autoDirector: false, audioReactive: false, blackout: false,
      masterDimmer: 1, washIntensity: 1, strobeRate: 0, movementMode: 'manual', manualPan: 0, manualTilt: 0 };
    const audio = { playing: false, source: 'none', trackName: '', energy: 0, bass: 0, mid: 0, high: 0,
      beat: false, beatPulse: 0, drop: false, spectrum: new Float32Array(32) };
    const create = operatorBlackout => new StageEngine(document.querySelector('#stage'), rig, look, () => audio,
      undefined, undefined, { operatorBlackout });
    const takeFrame = engine => {
      let received;
      engine.setDmxFrameListener((u1, u2, _u1Changed, _u2Changed, serial1, serial2) => {
        received = [u1[100], u2[100], serial1[100], serial2[100]];
      });
      engine.setDmxFrameListener(undefined);
      return received;
    };
    const preview = engine => ({
      wash: engine.getFixtureParams('wash').dimmer,
      simulatedDimmer: engine.dmxUniverse1[202],
      simulatedAxes: Array.from(engine.dmxUniverse1.slice(200, 202)),
    });
    const heldEngine = create(true);
    let cold;
    try {
      cold = { wire: takeFrame(heldEngine), ...preview(heldEngine) };
    } finally {
      heldEngine.dispose();
    }
    const engine = create(false);
    try {
      const bright = { wire: takeFrame(engine), ...preview(engine) };
      const seq = engine.getControlLoopHealth().seq;
      engine.setOperatorBlackout(true);
      engine.setShowState({ ...look, masterDimmer: 0.8 });
      const rearm = takeFrame(engine);
      const rearmSeq = engine.getControlLoopHealth().seq;
      engine.runControlTick(performance.now() + 500, false);
      const held = { wire: takeFrame(engine), ...preview(engine) };
      engine.setOperatorBlackout(false);
      engine.setShowState({ ...look, blackout: true });
      engine.runControlTick(performance.now() + 1000, false);
      const authored = { wire: takeFrame(engine), ...preview(engine) };
      engine.setShowState(look);
      engine.runControlTick(performance.now() + 1500, false);
      const restored = { wire: takeFrame(engine), ...preview(engine) };
      return { cold, bright, seq, rearmSeq, rearm, held, authored, restored };
    } finally {
      engine.dispose();
    }
  });
  expect(output.bright.wire).toHaveLength(4);
  expect(output.bright.wire.every(value => value > 0)).toBe(true);
  expect(output.bright.wash).toBeGreaterThan(0);
  expect(output.bright.simulatedDimmer).toBeGreaterThan(0);
  expect(output.bright.simulatedAxes.every(value => value > 0)).toBe(true);
  expect(output.seq).toBeGreaterThan(0);
  expect(output.rearmSeq).toBe(output.seq);
  expect(output.rearm).toEqual([0, 0, 0, 0]);
  for (const frame of [output.cold, output.held, output.authored]) {
    expect(frame).toEqual({ wire: [0, 0, 0, 0], wash: 0, simulatedDimmer: 0, simulatedAxes: output.bright.simulatedAxes });
  }
  expect(output.restored).toEqual(output.bright);
});

test('replay pause and idle seeks clear replay holds while preserving live owners', async ({ page }) => {
  await freeze(page);
  await openShow(page, rehearsal(true));
  await button(page, 'Show cues').press('Enter');
  const blinders = page.getByRole('button', { name: /BLINDERS/ });
  const strobe = page.getByRole('button', { name: /^STROBE/ });
  const position = page.getByRole('slider', { name: 'Take position' });
  const replay = button(page, 'Replay take');
  const resume = button(page, 'Resume take');
  await page.keyboard.down('b');
  await expect(blinders).toHaveAttribute('aria-pressed', 'true');
  await replay.press('Enter');
  await page.clock.fastForward(350);
  await expect(strobe).toHaveAttribute('aria-pressed', 'true'); // Held through a screen-only event.
  await expect(blinders).toHaveAttribute('aria-pressed', 'true');
  await holdButton(page).press('Enter');
  expect((await takeState(page)).mode).toBe('playing');
  await button(page, 'Pause replay').press('Enter');
  const paused = await takeState(page);
  expect(paused.mode).toBe('idle');
  await expect(strobe).toHaveAttribute('aria-pressed', 'false');
  await expect(blinders).toHaveAttribute('aria-pressed', 'true');
  await page.clock.fastForward(400);
  expect(await takeState(page)).toEqual(paused);

  await position.fill('550');
  await page.clock.runFor(32);
  expect(await takeState(page)).toMatchObject({ mode: 'idle', timeMs: 550 });
  await expect(strobe).toHaveAttribute('aria-pressed', 'false');
  await resume.press('Enter');
  await expect(strobe).toHaveAttribute('aria-pressed', 'true');
  await page.clock.fastForward(500);
  await expect(strobe).toHaveAttribute('aria-pressed', 'false'); // Recorded release.
  await page.clock.fastForward(450);
  await expect(strobe).toHaveAttribute('aria-pressed', 'true');
  await page.clock.fastForward(200);
  await expect(strobe).toHaveAttribute('aria-pressed', 'false'); // Full frame with no bump.
  await page.clock.fastForward(620);
  await expect(strobe).toHaveAttribute('aria-pressed', 'true');
  expect(await summary(page)).toMatchObject({ blackout: true, authoredBlackout: false, operatorBlackout: true });
  await page.clock.fastForward(350);
  expect((await takeState(page)).mode).toBe('idle');
  await expect(strobe).toHaveAttribute('aria-pressed', 'false');
  await expect(blinders).toHaveAttribute('aria-pressed', 'true');

  await replay.press('Enter');
  await button(page, 'Stop replay').press('Enter');
  await expect(blinders).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.up('b');
});

test('Pitch Viewer plays the authored look and the editor restores its hold without re-arming', async ({ page }) => {
  await freeze(page);
  await openShow(page, rehearsal());
  await holdButton(page).press('Enter');
  await openShow(page, rehearsal(true)); // A normal editor show change keeps the hold.
  await expect(holdButton(page)).toHaveAttribute('aria-pressed', 'true');
  await openShow(page, rehearsal(true), true);
  await expect(button(page, 'Exit viewer')).toBeVisible();
  await expect(holdButton(page)).toHaveCount(0);
  expect(await summary(page)).toMatchObject({ blackout: false, authoredBlackout: false, operatorBlackout: false });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Space');
  await page.clock.fastForward(350);
  expect((await takeState(page)).mode).toBe('playing');
  expect(await page.evaluate(() => window.stageforgeProbe.fixtureParams().atmo.smoke)).toBe(1);
  await page.keyboard.press('Space');
  expect((await takeState(page)).mode).toBe('idle');
  await page.clock.runFor(32);
  expect(await page.evaluate(() => window.stageforgeProbe.fixtureParams().atmo.smoke)).toBe(0);

  await button(page, 'Exit viewer').press('Enter');
  await expect(holdButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await summary(page)).toMatchObject({ blackout: true, authoredBlackout: false, operatorBlackout: true });
  await page.evaluate(() => {
    window.stageforgeProbe.simulateContextLoss(true);
    window.stageforgeProbe.simulateContextLoss(false);
  });
  await page.clock.runFor(32);
  expect(await summary(page)).toMatchObject({ blackout: true, authoredBlackout: false, operatorBlackout: true });
  expect(await page.evaluate(() => window.stageforgeProbe.fixtureParams().master)).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.dmxLive())).toBe(false);
});
