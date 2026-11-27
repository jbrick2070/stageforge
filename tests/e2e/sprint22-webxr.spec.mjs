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
  await designer.getByLabel('Crowd zone occupancy').fill('1');
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();

  const readCrowd = () => page.evaluate(() => window.stageforgeProbe.crowd());
  await expect.poll(async () => (await readCrowd()).batches.map(batch => batch.modelId)).toEqual([
    'stageforge-alien-v1', 'stageforge-fox-v1', 'stageforge-human-v1', 'stageforge-human-v2', 'stageforge-robot-v1',
  ]);
  expect((await readCrowd()).resourceAdmission).toMatchObject({
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
