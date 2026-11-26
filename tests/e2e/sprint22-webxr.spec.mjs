import { expect, test } from '@playwright/test';
import { installFakeWebXr } from '../support/fake-webxr.mjs';

async function boot(page, options = {}) {
  await installFakeWebXr(page, options);
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.webXr)).toBe('function');
}

async function xrState(page) {
  return page.evaluate(() => window.stageforgeProbe.webXr());
}

async function enter(page, warning = false) {
  await page.getByTestId('webxr-enter').click();
  if (warning) {
    await expect(page.getByTestId('webxr-warning')).toBeVisible();
    await page.getByTestId('webxr-warning-confirm').click();
  }
  await expect.poll(async () => (await xrState(page)).phase).toBe('active');
  await expect.poll(async () => (await xrState(page)).lastViews).toBe(2);
}

async function exit(page) {
  await page.getByTestId('webxr-exit').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
}

test('unsupported immersive-vr stays hidden even when the device-local renderer flag is on', async ({ page }) => {
  await boot(page, { supported: false });
  await expect(page.getByTestId('webxr-enter')).toHaveCount(0);
  await expect.poll(async () => (await xrState(page)).phase).toBe('disabled');
  const fake = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(fake.requests).toHaveLength(0);
});

test('warning-gated stereo entry restores one loop owner and every renderer lease across denial, cancel, error, system exit, and ten cycles', async ({ page }) => {
  const xrChunkRequests = [];
  page.on('request', (request) => {
    if (/webXrAudience/i.test(request.url())) xrChunkRequests.push(request.url());
  });
  await boot(page);
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  const baseline = await xrState(page);
  expect(baseline.phase).toBe('ready');
  expect(baseline.loopOwner).toBe('window-requestAnimationFrame');
  expect(baseline.controlsEnabled).toBe(true);
  expect(xrChunkRequests).toHaveLength(0);

  // The lazy chunk may load to display the warning, but user activation is not spent until confirmation.
  await page.evaluate(() => window.stageforgeProbe.setFullRateStrobePreview(true));
  await page.getByTestId('webxr-enter').click();
  await expect(page.getByTestId('webxr-warning')).toContainText('motion sickness');
  await expect(page.getByTestId('webxr-warning')).toContainText('simulated visualization only');
  await expect.poll(() => xrChunkRequests.length).toBe(1);
  expect((await page.evaluate(() => window.__fakeWebXr.snapshot())).requests).toHaveLength(0);
  await page.getByTestId('webxr-warning-confirm').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('active');
  await expect.poll(async () => (await xrState(page)).lastViews).toBe(2);

  let active = await xrState(page);
  expect(active.loopOwner).toBe('webxr-setAnimationLoop');
  expect(active.directRendering).toBe(true);
  expect(active.controlsEnabled).toBe(false);
  await expect.poll(async () => (await xrState(page)).lastCalls).toBeGreaterThan(0);
  await expect.poll(async () => (await xrState(page)).lastTriangles).toBeGreaterThan(0);
  active = await xrState(page);
  const firstSession = await page.evaluate(() => ({
    fake: window.__fakeWebXr.snapshot(),
    graphics: window.stageforgeProbe.graphicsProbe(),
  }));
  expect(firstSession.fake.requests[0]).toEqual({ mode: 'immersive-vr', requiredFeatures: ['local-floor'] });
  expect(firstSession.fake.referenceSpaces.at(-1)).toBe('local-floor');
  expect(firstSession.fake.scaleFactor).toBe(1);
  expect(firstSession.fake.foveation).toBe(0.25);
  expect(firstSession.graphics.fullRateStrobePreview).toBe(false);
  expect(firstSession.graphics.neonFrame.active).toBe(false);
  expect(firstSession.graphics.atmosphere.active).toBe(false);
  expect(firstSession.graphics.wetDeck.active).toBe(false);

  const visibleFrames = await page.evaluate(() => {
    const frames = window.stageforgeProbe.webXr().frames;
    window.__fakeWebXr.setVisibility('hidden');
    return frames;
  });
  await page.waitForTimeout(150);
  expect((await xrState(page)).frames).toBe(visibleFrames);
  await page.evaluate(() => window.__fakeWebXr.setVisibility('visible'));
  await expect.poll(async () => (await xrState(page)).frames).toBeGreaterThan(visibleFrames);

  // The same interlock authority disables physical arming while XR owns or awaits the loop.
  await page.getByRole('button', { name: 'DMX monitor' }).click();
  await page.locator('[data-testid="dmx-advanced-summary"]:visible').click();
  await expect(page.locator('[data-testid="dmx-webxr-blocked"]:visible')).toBeVisible();
  await expect(page.locator('[data-testid="dmx-output-arm"]:visible')).toBeDisabled();
  await page.getByRole('button', { name: 'Close DMX monitor' }).click();
  await exit(page);
  const warmedAfterFirst = await xrState(page);

  // A slow browser end keeps both UI and renderer interlocks fail-closed until the lease restores.
  await enter(page);
  const guarded = await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener());
  expect(guarded.physicalOutputListenerAttached).toBe(false);
  await page.evaluate(() => window.__fakeWebXr.deferEndNext());
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ webxrAudience: false }));
  await expect.poll(async () => (await xrState(page)).phase).toBe('exiting');
  await page.waitForTimeout(150);
  expect((await xrState(page)).active).toBe(true);
  expect((await page.evaluate(() => window.__fakeWebXr.snapshot())).pendingEnds).toBe(1);
  await page.getByRole('button', { name: 'DMX monitor' }).click();
  const advanced = page.locator('[data-testid="dmx-advanced-summary"]:visible');
  if (!(await advanced.evaluate((element) => element.parentElement?.hasAttribute('open')))) await advanced.click();
  await expect(page.locator('[data-testid="dmx-webxr-blocked"]:visible')).toBeVisible();
  await expect(page.locator('[data-testid="dmx-output-arm"]:visible')).toBeDisabled();
  await page.getByRole('button', { name: 'Close DMX monitor' }).click();
  await page.evaluate(() => window.__fakeWebXr.resolvePendingEnd());
  await expect.poll(async () => (await xrState(page)).phase).toBe('disabled');
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(false);
  await page.evaluate(() => window.stageforgeProbe.setRenderSettings({ webxrAudience: true }));
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');

  // A rejected end() is not proof of shutdown: retain both interlocks until a later system end event.
  await enter(page);
  await page.evaluate(() => window.__fakeWebXr.rejectEndNext());
  await page.getByTestId('webxr-exit').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('exiting');
  await page.waitForTimeout(100);
  const rejectedEnd = await xrState(page);
  expect(rejectedEnd.active).toBe(true);
  expect(rejectedEnd.physicalOutputInterlocked).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener())).physicalOutputListenerAttached).toBe(false);
  await page.evaluate(() => window.__fakeWebXr.systemExit());
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  await expect.poll(async () => (await xrState(page)).physicalOutputInterlocked).toBe(false);

  // Permission denial never transfers renderer ownership.
  const entriesAfterFirst = (await xrState(page)).entries;
  await page.evaluate(() => window.__fakeWebXr.denyNext());
  await page.getByTestId('webxr-enter').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  expect((await xrState(page)).entries).toBe(entriesAfterFirst);

  // A pending browser chooser can be canceled; a late session is immediately ended and never installed.
  await page.evaluate(() => window.__fakeWebXr.deferNext());
  await page.getByTestId('webxr-enter').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('requesting');
  await page.getByTestId('webxr-cancel-request').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('exiting');
  await page.evaluate(() => window.__fakeWebXr.resolvePending());
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(false);

  // Failure after requestSession (reference-space setup) restores the same normal lease.
  await page.evaluate(() => window.__fakeWebXr.failReferenceSpaceNext());
  await page.getByTestId('webxr-enter').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  expect((await xrState(page)).loopOwner).toBe('window-requestAnimationFrame');

  // System-driven end, followed by enough clean re-entries to total ten successful sessions.
  await enter(page);
  await page.evaluate(() => window.__fakeWebXr.systemExit());
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  for (let i = 0; i < 6; i++) {
    await enter(page);
    await exit(page);
  }

  const restored = await xrState(page);
  const fake = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(restored.entries).toBe(10);
  expect(restored.active).toBe(false);
  expect(restored.loopOwner).toBe('window-requestAnimationFrame');
  expect(restored.sessionListeners).toBe(0);
  expect(restored.controlsEnabled).toBe(baseline.controlsEnabled);
  expect(restored.rendererPixelRatio).toBe(baseline.rendererPixelRatio);
  expect(restored.rendererSize).toEqual(baseline.rendererSize);
  expect(restored.rendererXrEnabled).toBe(baseline.rendererXrEnabled);
  expect(restored.memory).toEqual(warmedAfterFirst.memory);
  expect(restored.memory.geometries).toBe(baseline.memory.geometries);
  expect(restored.memory.textures).toBe(baseline.memory.textures);
  expect(restored.camera).toEqual(baseline.camera);
  expect(restored.controlsTarget).toEqual(baseline.controlsTarget);
  expect(restored.composerPasses).toEqual(baseline.composerPasses);
  expect(fake.listenerBalances.every((count) => count === 0)).toBe(true);
  expect(fake.rafCounts.every((count) => count === 0)).toBe(true);
});

test('a canceled chooser whose late session cannot end keeps physical output latched', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__fakeWebXr.deferNext());
  await page.getByTestId('webxr-enter').click();
  await expect(page.getByTestId('webxr-warning')).toBeVisible();
  await page.getByTestId('webxr-warning-confirm').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('requesting');
  await page.getByRole('button', { name: 'DMX monitor' }).click();
  let advanced = page.locator('[data-testid="dmx-advanced-summary"]:visible');
  if (!(await advanced.evaluate((element) => element.parentElement?.hasAttribute('open')))) await advanced.click();
  await expect(page.locator('[data-testid="dmx-webxr-blocked"]:visible')).toBeVisible();
  await expect(page.locator('[data-testid="dmx-output-arm"]:visible')).toBeDisabled();
  await page.getByRole('button', { name: 'Close DMX monitor' }).click();
  await page.getByTestId('webxr-cancel-request').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('exiting');
  await page.evaluate(() => {
    window.__fakeWebXr.rejectEndNext();
    window.__fakeWebXr.resolvePending();
  });
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(true);
  await page.waitForTimeout(100);
  const latched = await xrState(page);
  expect(latched.phase).toBe('exiting');
  expect(latched.active).toBe(false);
  expect(latched.physicalOutputInterlocked).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener())).physicalOutputListenerAttached).toBe(false);

  await page.getByRole('button', { name: 'DMX monitor' }).click();
  advanced = page.locator('[data-testid="dmx-advanced-summary"]:visible');
  if (!(await advanced.evaluate((element) => element.parentElement?.hasAttribute('open')))) await advanced.click();
  await expect(page.locator('[data-testid="dmx-webxr-blocked"]:visible')).toBeVisible();
  await expect(page.locator('[data-testid="dmx-output-arm"]:visible')).toBeDisabled();
});

test('audience viewpoints, comfort menu, preview workflows and emulator budgets stay isolated', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await enter(page, true);
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);

  const initial = await xrState(page);
  expect(initial.audience.currentViewpoint).toBe('floor');
  expect(initial.audience.eyeMode).toBe('standing');
  expect(initial.audience.smoothLocomotion).toBe(false);
  expect(initial.audience.controllerCount).toBe(2);
  expect(initial.audience.ownedTextures).toBe(1);
  expect(initial.audience.status.laserLabel).toContain('simulated visualization only');
  expect(initial.audience.status.preflightLabel.length).toBeGreaterThan(0);
  expect(initial.audience.buttons).not.toEqual(expect.arrayContaining(['arm', 'file', 'ai']));

  const action = async (id) => {
    await page.evaluate((value) => window.stageforgeProbe.webXrMenuAction(value), id);
  };
  for (const seat of ['stage-front', 'mezzanine', 'balcony', 'foh', 'floor']) {
    await action(`seat:${seat}`);
    await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
    expect((await xrState(page)).audience.currentViewpoint).toBe(seat);
  }

  await action('eye:seated');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  const seated = (await xrState(page)).audience;
  expect(seated.eyeMode).toBe('seated');
  expect(seated.desiredHeadPose.position.y - seated.baseHeadPose.position.y).not.toBeNaN();
  await action('eye:standing');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  const standing = (await xrState(page)).audience;
  expect(standing.desiredHeadPose.position.y - seated.desiredHeadPose.position.y).toBeCloseTo(0.4, 5);

  await action('snap:right');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  expect((await xrState(page)).audience.yawOffsetDeg).toBe(30);
  await action('snap:left');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  expect((await xrState(page)).audience.yawOffsetDeg).toBe(0);
  await action('snap:left');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  await action('reset');
  await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
  expect((await xrState(page)).audience.yawOffsetDeg).toBe(0);
  await action('vignette');
  expect((await xrState(page)).audience.vignette).toBe(true);

  await action('cue:go');
  const cueBefore = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  await action('cue:go');
  const cueAfterGo = await page.evaluate(() => window.stageforgeProbe.activeCueId());
  expect(cueAfterGo).not.toBe(cueBefore);
  await action('cue:back');
  expect(await page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe(cueBefore);

  const hazeBefore = (await xrState(page)).audience.status.hazeLevel;
  await action('haze:up');
  await expect.poll(async () => (await xrState(page)).audience?.status.hazeLevel).toBeCloseTo(Math.min(1, hazeBefore + 0.1), 5);
  const demoWasPlaying = (await xrState(page)).audience.status.demoPlaying;
  await action('demo');
  await expect.poll(async () => (await xrState(page)).audience?.status.demoPlaying).toBe(!demoWasPlaying);
  await action('demo');
  await expect.poll(async () => (await xrState(page)).audience?.status.demoPlaying).toBe(demoWasPlaying);
  await action('mute');
  expect((await xrState(page)).audience.status.muted).toBe(true);
  await action('mute');
  expect((await xrState(page)).audience.status.muted).toBe(false);

  await action('limiter');
  expect((await xrState(page)).audience.limiterConfirmArmed).toBe(true);
  expect((await xrState(page)).audience.status.limiterOverride).toBe(false);
  await action('limiter');
  expect((await xrState(page)).audience.status.limiterOverride).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).fullRateStrobePreview).toBe(true);
  const optionalBeforeHidden = await page.evaluate(() => {
    const frames = window.stageforgeProbe.webXr().audience.optionalFrames;
    window.__fakeWebXr.setVisibility('hidden');
    return frames;
  });
  await page.waitForTimeout(150);
  const hidden = (await xrState(page)).audience;
  expect(hidden.optionalFrames).toBe(optionalBeforeHidden);
  expect(hidden.status.limiterOverride).toBe(false);
  await page.evaluate(() => window.__fakeWebXr.setVisibility('visible'));
  await expect.poll(async () => (await xrState(page)).audience?.optionalFrames).toBeGreaterThan(optionalBeforeHidden);

  const budgeted = await xrState(page);
  expect(budgeted.lastCalls).toBeLessThanOrEqual(budgeted.audience.emulatorBudget.calls);
  expect(budgeted.lastTriangles).toBeLessThanOrEqual(budgeted.audience.emulatorBudget.triangles);
  expect(budgeted.memory.textures).toBeLessThanOrEqual(budgeted.audience.emulatorBudget.rendererTextures);
  expect(budgeted.audience.ownedTextures).toBe(budgeted.audience.emulatorBudget.ownedTextures);

  await action('quality:standalone-low');
  expect((await xrState(page)).audience.currentQuality).toBe('pc-link-high');
  expect((await xrState(page)).audience.nextQuality).toBe('standalone-low');
  await action('exit');
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  await enter(page);
  const lowProfile = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(lowProfile.scaleFactor).toBe(0.75);
  expect(lowProfile.foveation).toBe(0.65);
  expect((await xrState(page)).audience.currentQuality).toBe('standalone-low');
  await exit(page);
});
