import { readFile, writeFile } from 'node:fs/promises';
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

test('reference-space failure after Three attaches the session stays closed until authoritative end', async ({ page }) => {
  await boot(page);
  const baseline = await xrState(page);
  await page.evaluate(() => {
    window.__fakeWebXr.failReferenceSpaceNext();
    window.__fakeWebXr.rejectEndNext();
  });
  await page.getByTestId('webxr-enter').click();
  await expect(page.getByTestId('webxr-warning')).toBeVisible();
  await page.getByTestId('webxr-warning-confirm').click();

  await expect.poll(async () => (await xrState(page)).phase).toBe('exiting');
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(true);
  const failed = await xrState(page);
  const attached = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(attached.referenceSpaces).toEqual(['local-floor']);
  expect(failed.active).toBe(true);
  expect(failed.rendererXrEnabled).toBe(true);
  expect(failed.physicalOutputInterlocked).toBe(true);
  expect((await page.evaluate(() => window.stageforgeReactProbe.webXrPageLatch())).interlocked).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener())).physicalOutputListenerAttached).toBe(false);

  await page.evaluate(() => window.__fakeWebXr.systemExit());
  await expect.poll(async () => (await xrState(page)).phase).toBe('ready');
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.stageforgeReactProbe.webXrPageLatch().interlocked)).toBe(false);
  const restored = await xrState(page);
  const ended = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(restored.active).toBe(false);
  expect(restored.physicalOutputInterlocked).toBe(false);
  expect(restored.loopOwner).toBe('window-requestAnimationFrame');
  expect(restored.controlsEnabled).toBe(baseline.controlsEnabled);
  expect(restored.rendererPixelRatio).toBe(baseline.rendererPixelRatio);
  expect(restored.rendererSize).toEqual(baseline.rendererSize);
  expect(restored.rendererXrEnabled).toBe(baseline.rendererXrEnabled);
  expect(restored.camera).toEqual(baseline.camera);
  expect(restored.controlsTarget).toEqual(baseline.controlsTarget);
  expect(restored.composerPasses).toEqual(baseline.composerPasses);
  expect(ended.listenerBalances.every((count) => count === 0)).toBe(true);
  expect(ended.rafCounts.every((count) => count === 0)).toBe(true);
});

test('React unmount during a pending chooser retains page authority through rejected termination', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__fakeWebXr.deferNext());
  await page.getByTestId('webxr-enter').click();
  await expect(page.getByTestId('webxr-warning')).toBeVisible();
  await page.getByTestId('webxr-warning-confirm').click();
  await expect.poll(async () => (await xrState(page)).phase).toBe('requesting');

  await page.evaluate(() => window.stageforgeReactProbe.unmountApp());
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe)).toBe('undefined');
  await page.evaluate(() => {
    window.__fakeWebXr.rejectEndNext();
    window.__fakeWebXr.resolvePending();
  });
  await expect.poll(() => page.evaluate(() => window.__fakeWebXr.snapshot().active)).toBe(true);
  const unmounted = await page.evaluate(() => window.stageforgeReactProbe.webXrPageLatch());
  expect(unmounted.interlocked).toBe(true);
  expect(unmounted.sessionBound).toBe(true);
  expect(unmounted.owner.disposed).toBe(true);
  expect(unmounted.owner.physicalOutputInterlocked).toBe(true);
  expect(unmounted.owner.physicalOutputListenerAttached).toBe(false);

  await page.evaluate(() => window.stageforgeReactProbe.mountApp());
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.webXr)).toBe('function');
  await expect.poll(async () => (await xrState(page)).physicalOutputInterlocked).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener())).physicalOutputListenerAttached).toBe(false);

  await page.evaluate(() => window.__fakeWebXr.systemExit());
  await expect.poll(() => page.evaluate(() => window.stageforgeReactProbe.webXrPageLatch().interlocked)).toBe(false);
  await expect.poll(async () => (await xrState(page)).physicalOutputInterlocked).toBe(false);
  const restored = await xrState(page);
  expect(restored.active).toBe(false);
  expect(restored.loopOwner).toBe('window-requestAnimationFrame');
  expect(restored.controlsEnabled).toBe(true);
  const ended = await page.evaluate(() => window.__fakeWebXr.snapshot());
  expect(ended.listenerBalances.every((count) => count === 0)).toBe(true);
  expect(ended.rafCounts.every((count) => count === 0)).toBe(true);
});

test('dispose stays fail-closed when the headset session rejects termination', async ({ page }) => {
  await boot(page);
  await enter(page, true);
  await page.evaluate(() => {
    window.__fakeWebXr.rejectEndNext();
    window.stageforgeProbe.disposeWebXrEngineForTest();
  });
  expect((await page.evaluate(() => window.__fakeWebXr.snapshot())).active).toBe(true);
  const disposed = await page.evaluate(() => window.stageforgeProbe.attemptWebXrDmxListener());
  expect(disposed.active).toBe(false);
  expect(disposed.physicalOutputInterlocked).toBe(true);
  expect(disposed.physicalOutputListenerAttached).toBe(false);
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

  // Exercise the real WebXR controller event path. A repeated start without an end is one edge.
  await page.evaluate(() => {
    const menu = window.stageforgeProbe.webXr().audience.menuPose;
    window.__fakeWebXr.aimControllerAtMenu(menu, 750, 520, 0);
    window.__fakeWebXr.dispatchInput('selectstart', 0);
    window.__fakeWebXr.dispatchInput('selectstart', 0);
  });
  expect((await xrState(page)).audience.limiterConfirmArmed).toBe(true);
  expect((await xrState(page)).audience.status.limiterOverride).toBe(false);
  await page.evaluate(() => window.__fakeWebXr.dispatchInput('selectend', 0));
  await action('limiter');
  expect((await xrState(page)).audience.status.limiterOverride).toBe(true);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).fullRateStrobePreview).toBe(true);
  const inputEvents = await page.evaluate(() => window.__fakeWebXr.snapshot().inputEvents);
  expect(inputEvents.map((event) => event.type)).toEqual(['selectstart', 'selectstart', 'selectend']);

  await page.evaluate(() => window.__fakeWebXr.setReducedMotion(true));
  await expect.poll(async () => (await xrState(page)).audience?.status.limiterOverride).toBe(false);
  expect((await page.evaluate(() => window.stageforgeProbe.graphicsProbe())).fullRateStrobePreview).toBe(false);
  await page.evaluate(() => window.__fakeWebXr.setReducedMotion(false));
  await action('limiter');
  await action('limiter');
  expect((await xrState(page)).audience.status.limiterOverride).toBe(true);
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

test('the expanded original crowd renders in both stereo profiles and preserves its stage draft history', async ({ page }) => {
  test.setTimeout(120_000);
  const shaderErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Shader Error|WebGLProgram.*invalid/i.test(message.text())) {
      shaderErrors.push(message.text());
    }
  });
  await boot(page);
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.getByRole('button', { name: 'Design stage', exact: true }).first().click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await designer.getByLabel('Authored crowd').check();
  const mix = designer.getByLabel('Crowd model mix');
  await mix.selectOption('original-library');
  await designer.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(mix).toHaveValue('human-only');
  await designer.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(mix).toHaveValue('original-library');
  // This Arena floor has 1,785 slots. 38% keeps the test near the 680-person authored cap.
  const occupancy = designer.getByLabel('Crowd zone occupancy');
  expect(await occupancy.evaluate(input => input.validity.valid)).toBe(true);
  await occupancy.fill('0.38');
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();

  const readCrowd = () => page.evaluate(() => window.stageforgeProbe.crowd());
  await expect.poll(async () => (await readCrowd()).batches.map(batch => batch.modelId)).toEqual([
    'stageforge-alien-v1', 'stageforge-fox-v1', 'stageforge-human-v1', 'stageforge-human-v2', 'stageforge-robot-v1',
  ]);
  const renderedCrowd = await readCrowd();
  expect(renderedCrowd.count).toBeGreaterThanOrEqual(675);
  expect(renderedCrowd.count).toBeLessThanOrEqual(680);
  expect(renderedCrowd.resourceAdmission).toMatchObject({
    admitted: true,
    eyeViews: 2,
    arenaDelta: { draws: 8, triangles: 0, textures: 0 },
  });

  const checkBudget = async (profile) => {
    await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
    const state = await xrState(page);
    expect(state.audience.currentQuality).toBe(profile);
    expect(state.lastViews).toBe(2);
    expect(state.lastCalls).toBeLessThanOrEqual(state.audience.emulatorBudget.calls);
    expect(state.lastTriangles).toBeLessThanOrEqual(state.audience.emulatorBudget.triangles);
    expect(state.memory.textures).toBeLessThanOrEqual(state.audience.emulatorBudget.rendererTextures);
    expect(state.audience.ownedTextures).toBe(state.audience.emulatorBudget.ownedTextures);
  };
  await enter(page, true);
  await checkBudget('pc-link-high');
  await page.evaluate(() => window.stageforgeProbe.webXrMenuAction('quality:standalone-low'));
  await exit(page);
  await enter(page);
  await checkBudget('standalone-low');
  await exit(page);
  expect(shaderErrors).toEqual([]);
});

test('the equal-density original and 1928 cast crowds render within both Arena stereo budgets', async ({ page }, info) => {
  test.setTimeout(300_000);
  const renderingErrors = [];
  page.on('pageerror', error => renderingErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Shader Error|WebGLProgram.*invalid/i.test(message.text())) {
      renderingErrors.push(message.text());
    }
  });
  await boot(page);
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.getByRole('button', { name: 'Design stage', exact: true }).first().click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await designer.getByLabel('Authored crowd').check();
  await designer.getByLabel('Crowd model mix').selectOption('original-with-cartoons');
  await designer.getByLabel('Crowd zone occupancy').fill('0.38');
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();

  const crowd = await page.evaluate(() => window.stageforgeProbe.crowd());
  expect(crowd.count).toBeGreaterThanOrEqual(675);
  expect(crowd.count).toBeLessThanOrEqual(680);
  expect(crowd.batches).toHaveLength(4);
  expect(crowd.batches.find(batch => batch.packed)?.modelIds).toEqual([
    'stageforge-fox-v1', 'stageforge-human-v2', 'stageforge-moth-v1', 'stageforge-ticket-taker-v1',
  ]);
  expect(crowd.resourceAdmission).toMatchObject({
    admitted: true, packedVertexTextures: 1, arenaDelta: { draws: 6, triangles: 0, textures: 1 },
  });

  const legacy = crowd.batches.find(batch => batch.modelId === 'stageforge-human-v1');
  expect(legacy.phoneCount).toBeGreaterThan(0);
  expect(crowd.resourceAdmission.morphTextures).toBe(1);
  const controlProfiles = await checkProfiles(true, false);

  // Use the Arena show that produced the measured control, including its exact rig, seed and zone.
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  const saving = page.waitForEvent('download');
  await files.getByRole('button', { name: 'Save show JSON' }).click();
  const saved = JSON.parse(await readFile(await (await saving).path(), 'utf8'));
  const fixture = await page.evaluate(async (source) => {
    const { resolveCrowdLayout } = await import('/src/data/crowdPlacement.ts');
    const { STEAMBOAT_MODEL_IDS, STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS } = await import('/src/data/crowdFilmCast.ts');
    const { parseShowFile, V14_SCHEMA_URL } = await import('/src/data/showFile.ts');
    const original = resolveCrowdLayout(source.rig, source.crowd);
    const roles = [...STEAMBOAT_DEFAULT_PLACEMENT_MODEL_IDS];
    roles.push(...STEAMBOAT_MODEL_IDS.filter(id => !roles.includes(id)));
    // Take real, non-phone robot/alien positions. The complete legacy-human morph/handset batch stays identical.
    const near = source.rig.stageDepth / 2 + 11;
    const preference = person => Math.abs(person.z - near) + Math.abs(person.x) * 0.7;
    const candidates = original.placements.filter(person => !person.phone && person.pose === 'standing'
      && ['stageforge-alien-v1', 'stageforge-robot-v1'].includes(person.modelId));
    candidates.sort((a, b) => preference(a) - preference(b) || a.id.localeCompare(b.id));
    const donors = [];
    for (const person of candidates) {
      if (donors.every(other => Math.hypot(person.x - other.x, person.z - other.z) >= 2.2)) donors.push(person);
      if (donors.length === roles.length) break;
    }
    if (donors.length !== roles.length) throw new Error('Arena control has too few separated donor positions for the full film roster.');
    const placements = roles.map((modelId, index) => {
      const person = donors[index];
      return { id: 'proof-film-' + index, modelId, pose: 'standing', yaw: person.rotY * 180 / Math.PI,
        position: { x: person.x, y: person.y, z: person.z } };
    });
    const show = parseShowFile(JSON.stringify({ ...source, version: 14, $schema: V14_SCHEMA_URL, crowd: { ...source.crowd, placements } }));
    const mixed = resolveCrowdLayout(show.rig, show.crowd);
    const donorIds = new Set(donors.map(person => person.id));
    const untouched = original.placements.filter(person => !donorIds.has(person.id));
    const generated = mixed.placements.filter(person => person.source === 'generated');
    const byId = new Map(mixed.placements.map(person => [person.id, person]));
    const sameSlots = placements.every((slot, i) => {
      const person = byId.get('explicit:' + slot.id);
      return person?.modelId === slot.modelId && person.x === donors[i].x && person.y === donors[i].y && person.z === donors[i].z;
    });
    return { show, filmIds: STEAMBOAT_MODEL_IDS, total: mixed.placed, slots: roles.length,
      sameSlots, othersIdentical: JSON.stringify(untouched) === JSON.stringify(generated) };
  }, saved);
  expect(fixture.show.version).toBe(14);
  expect(fixture.slots).toBe(17);
  expect(fixture.filmIds).toHaveLength(16);
  expect(fixture.sameSlots && fixture.othersIdentical).toBe(true);
  expect(fixture.total).toBe(crowd.count);
  await files.getByLabel('Open show file').setInputFiles({
    name: 'Arena-mixed-cast.stageforge.show.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture.show)),
  });
  await expect(files).toBeHidden();
  const readCrowd = () => page.evaluate(() => window.stageforgeProbe.crowd());
  const originals = crowd.batches.flatMap(batch => batch.modelIds).sort();
  expect(originals).toHaveLength(7);
  const expectedIds = [...originals, ...fixture.filmIds].sort();
  await expect.poll(async () => [...new Set((await readCrowd()).placementBindings.map(item => item.modelId))].sort()).toEqual(expectedIds);
  const mixed = await readCrowd();
  expect(mixed.count).toBe(crowd.count);
  expect(mixed.batches).toHaveLength(crowd.batches.length);
  const originalPacked = crowd.batches.find(batch => batch.packed);
  const mixedPacked = mixed.batches.find(batch => batch.packed);
  expect(mixedPacked.modelIds).toEqual([...originalPacked.modelIds, ...fixture.filmIds].sort());
  expect(mixedPacked.phoneCount).toBe(0);
  expect(mixed.batches.find(batch => batch.modelId === legacy.modelId)).toEqual(legacy);
  expect(mixed.resourceAdmission).toMatchObject({ admitted: true, eyeViews: 2, packedVertexTextures: 1, morphTextures: 1 });

  await page.evaluate(() => {
    const probe = window.stageforgeProbe;
    probe.setRenderSettings({ crowdLighting: true });
    probe.patchShowState({ autoDirector: false, blackout: false, masterDimmer: 1, washIntensity: 1, blinderLevel: 0.6, primaryColor: '#ffffff', accentColor: '#ffffff' });
  });
  const captureCrowd = (ids) => page.evaluate(async (ids) => {
    const { crowdModel } = await import('/src/data/crowdModels.ts');
    const probe = window.stageforgeProbe;
    const transforms = probe.crowd().transforms;
    const shots = [];
    const decode = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    for (const id of ids) {
      const people = transforms.filter(item => item.modelId === id).sort((a, b) => a.z - b.z || Math.abs(a.x) - Math.abs(b.x));
      // Frame a central floor row beyond the rail. The foremost side slot can be hidden by the stage structure.
      const historical = id.startsWith('stageforge-steamboat-1928-');
      const person = historical ? people[0] : people.find(item => item.z > people[0].z + 5 && Math.abs(item.x) < 7);
      if (!person) throw new Error(`No unobstructed capture position for ${id}`);
      const forwardX = Math.sin(person.rotY), forwardZ = Math.cos(person.rotY);
      const height = crowdModel(id).geometryHeightM * person.scaleY;
      const distance = historical ? Math.max(0.74, height * 1.12) : 2;
      const side = historical ? distance * 0.12 : 0.25;
      probe.setCameraPose(
        [person.x + forwardX * distance + forwardZ * side, person.y + (historical ? height * 0.72 : 1.26),
          person.z + forwardZ * distance - forwardX * side],
        [person.x, person.y + (historical ? height * 0.51 : 0.91), person.z],
      );
      const settings = { hideBeams: true, hidePools: true, hideParticles: true };
      const image = probe.redrawAndCapture(settings);
      const hidden = probe.redrawAndCapture({ ...settings, hidePackedCrowd: true });
      const [shown, absent] = await Promise.all([decode(image), decode(hidden)]);
      let changedPixels = 0;
      for (let y = Math.floor(shown.height * 0.32); y < shown.height * 0.68; y++) {
        for (let x = Math.floor(shown.width * 0.38); x < shown.width * 0.62; x++) {
          const i = (y * shown.width + x) * 4;
          const delta = Math.abs(shown.data[i] - absent.data[i])
            + Math.abs(shown.data[i + 1] - absent.data[i + 1])
            + Math.abs(shown.data[i + 2] - absent.data[i + 2]);
          if (delta > 24) changedPixels++;
        }
      }
      // Attach a small crop of the same measured desktop frame for each appearance.
      const crop = document.createElement('canvas');
      crop.width = Math.floor(shown.width * 0.40);
      crop.height = Math.floor(shown.height * 0.70);
      crop.getContext('2d').putImageData(shown, -Math.floor((shown.width - crop.width) / 2), -Math.floor((shown.height - crop.height) / 2));
      shots.push({ id, image: crop.toDataURL('image/png'), changedPixels });
    }
    return shots;
  }, ids);
  const originalsToFrame = ['stageforge-moth-v1', 'stageforge-ticket-taker-v1'];
  const captures = await captureCrowd([...originalsToFrame, ...fixture.filmIds]);
  for (const { id, image, changedPixels } of captures) {
    const path = info.outputPath(id + '.png');
    await writeFile(path, Buffer.from(image.split(',')[1], 'base64'));
    await info.attach(id, { path, contentType: 'image/png' });
    expect(changedPixels, id).toBeGreaterThan(100);
  }
  const texturesBefore = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().stats.textures);

  await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const context = gl.getExtension('WEBGL_lose_context');
    if (!context) throw new Error('The XR gate needs WebGL context loss support.');
    window.__crowdContext = context;
    context.loseContext();
  });
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().contextLost)).toBe(true);
  await page.evaluate(() => window.__crowdContext.restoreContext());
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.graphicsProbe().contextLost)).toBe(false);
  // First read the surviving geometry, then rebuild to exercise texture ownership separately.
  const restorationIds = [...originalsToFrame, 'stageforge-steamboat-1928-mickey-capped', 'stageforge-steamboat-1928-piglet-dark', 'stageforge-steamboat-1928-dock-bird-leaning'];
  for (const { id, changedPixels } of await captureCrowd(restorationIds)) expect(changedPixels, id).toBeGreaterThan(100);
  const restoredTextures = await page.evaluate(() => window.stageforgeProbe.graphicsProbe().stats.textures);
  expect(restoredTextures).toBeLessThanOrEqual(texturesBefore);
  await page.evaluate(() => {
    delete window.__crowdContext;
    window.stageforgeProbe.rebuildRig();
    window.stageforgeProbe.redrawAndCapture();
  });
  expect((await readCrowd()).placementBindings).toEqual(mixed.placementBindings);

  async function checkProfiles(firstWarning, checkVisibility) {
    const results = {};
    const profiles = ['pc-link-high', 'standalone-low'];
    for (const quality of profiles) {
      await enter(page, firstWarning && quality === profiles[0]);
      await expect.poll(async () => (await xrState(page)).audience?.blink).toBe(null);
      if (checkVisibility) {
        const frames = await page.evaluate(() => {
          const frames = window.stageforgeProbe.webXr().frames;
          window.__fakeWebXr.setVisibility('hidden');
          return frames;
        });
        await page.waitForTimeout(150);
        expect((await xrState(page)).frames).toBe(frames);
        await page.evaluate(() => window.__fakeWebXr.setVisibility('visible'));
        await expect.poll(async () => (await xrState(page)).frames).toBeGreaterThan(frames);
      }
      const peak = { calls: 0, triangles: 0, textures: 0 };
      let frames = (await xrState(page)).frames;
      for (let sample = 0; sample < 3; sample++) {
        await expect.poll(async () => (await xrState(page)).frames).toBeGreaterThan(frames);
        const state = await xrState(page);
        frames = state.frames;
        expect(state.audience.currentQuality).toBe(quality);
        expect(state.lastViews).toBe(2);
        expect(state.lastCalls).toBeGreaterThan(0);
        expect(state.lastTriangles).toBeGreaterThan(0);
        expect(state.lastCalls).toBeLessThanOrEqual(state.audience.emulatorBudget.calls);
        expect(state.lastTriangles).toBeLessThanOrEqual(state.audience.emulatorBudget.triangles);
        expect(state.memory.textures).toBeLessThanOrEqual(state.audience.emulatorBudget.rendererTextures);
        expect(state.audience.ownedTextures).toBe(state.audience.emulatorBudget.ownedTextures);
        peak.calls = Math.max(peak.calls, state.lastCalls);
        peak.triangles = Math.max(peak.triangles, state.lastTriangles);
        peak.textures = Math.max(peak.textures, state.memory.textures);
      }
      results[quality] = peak;
      const next = quality === profiles[0] ? profiles[1] : profiles[0];
      await page.evaluate(value => window.stageforgeProbe.webXrMenuAction('quality:' + value), next);
      await exit(page);
    }
    return results;
  }
  const mixedProfiles = await checkProfiles(false, true);
  const path = info.outputPath('equal-density-stereo-evidence.json');
  await writeFile(path, JSON.stringify({ people: crowd.count, originalModelIds: originals, filmModelIds: fixture.filmIds,
    original: controlProfiles, mixed: mixedProfiles,
    packedDesktopPixelDeltas: captures.map(({ id, changedPixels }) => ({ id, changedPixels })),
  }, null, 2));
  await info.attach('equal-density-stereo-evidence', { path, contentType: 'application/json' });
  expect(renderingErrors).toEqual([]);
});
