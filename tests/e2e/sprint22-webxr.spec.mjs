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

test('native Demo controller defers the opening clear to the dedicated XR framebuffer', async ({ page }, info) => {
  await boot(page, { directEyeCapture: true, dedicatedXrFramebuffer: true });
  // The saved fixture has no audio or take, so this is the actual first startDemo()/beginDemo() path.
  const fixture = await stereoLandmarkFixture(page, 'arena');
  await openStereoLandmarkShow(page, fixture);
  await enter(page, true);
  try {
    const initial = await xrState(page);
    expect(initial.audience.menuOpen).toBe(true);
    expect(initial.audience.status.demoPlaying).toBe(false);
    expect(await page.evaluate(() => window.stageforgeProbe.demoPosition())).toBe(null);

    const receipt = await page.evaluate(async () => {
      const fake = window.__fakeWebXr, probe = window.stageforgeProbe;
      const summary = pair => {
        const {left, right, ...frame} = pair;
        const eye = ({viewport, pixels, nonOpaqueBlackPixels, litPixels}) => ({viewport, pixels, nonOpaqueBlackPixels, litPixels});
        return {...frame, left:eye(left), right:eye(right)};
      };
      const before = await fake.captureNextEyePair({timeoutMs: 6000});
      const beforeFrame = probe.webXr().frames;
      const live = fake.layerIsLive(fake.state.activeSession);
      fake.aimControllerAtMenu(probe.webXr().audience.menuPose, 791, 420, 0);
      // Arm before firing the edge. The fake callback observes the real next frame's clear;
      // synchronous provider input returns before that callback can run.
      const next = fake.captureNextEyePair({expectedSubmission: 'blackout-clear', timeoutMs: 6000});
      const input = fake.observeControllerPress(0);
      const afterInputFrame = probe.webXr().frames;
      const demo = probe.demoPosition();
      const events = fake.snapshot().inputEvents.slice(-2);
      try {
        return {live, before:summary(before), beforeFrame, input, afterInputFrame, demo, events, next:summary(await next)};
      } catch (error) {
        return {live, before:summary(before), beforeFrame, input, afterInputFrame, demo, events, error:String(error)};
      }
    });
    await persistStereoLightingReceipt(info, 'native-demo-dedicated-fbo', 'application/json', JSON.stringify(receipt, null, 2));
    expect(receipt.live).toBe(true);
    expect(receipt.events).toEqual([{type:'selectstart', index:0}, {type:'selectend', index:0}]);
    expect(receipt.demo?.openingStep, 'Controller must start the fresh synth intro').toBe(0);
    expect(receipt.afterInputFrame).toBe(receipt.beforeFrame);
    expect(receipt.input, 'The input edge must leave the bound XR FBO alone and defer its clear').toEqual({
      before:true, after:true, clears:[],
    });
    expect(receipt.error).toBeUndefined();
    expect(receipt.before.framebufferKind).toBe('emulated-single-sample-fbo');
    expect(receipt.next.framebufferKind).toBe(receipt.before.framebufferKind);
    expect(receipt.next.session).toBe(receipt.before.session);
    expect(receipt.next.frame).toBe(receipt.beforeFrame + 1);
    expect(receipt.next.lastLayerTargetPreserved).toBe(true);
    expect(receipt.next.witnessedBlackClears).toBeGreaterThan(0);
    expect([receipt.next.counters.views, receipt.next.counters.calls, receipt.next.counters.triangles]).toEqual([2,0,0]);
    for (const eye of ['left', 'right']) {
      expect(receipt.before[eye].litPixels, eye + ' must start from a real visible scene').toBeGreaterThan(100);
      expect(receipt.next[eye].pixels).toBe(512*512);
      expect(receipt.next[eye].nonOpaqueBlackPixels).toBe(0);
    }
    await expect.poll(async () => (await xrState(page)).audience.status.demoPlaying).toBe(true);
  } finally {
    await exit(page);
  }
  expect(await page.evaluate(() => window.__fakeWebXr.layerIsLive(window.__fakeWebXr.state.sessions.at(-1)))).toBe(false);
});

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

async function stereoLandmarkFixture(page, venue) {
  return page.evaluate(async venue => {
    const { makeShowFile, parseShowFile } = await import('/src/data/showFile.ts');
    const { RIG_TEMPLATES, INITIAL_SHOW_STATE } = await import('/src/data/presets.ts');
    const { deriveAudienceViewpoints } = await import('/src/xr/audienceExperience.ts');
    const { resolveCrowdLayout, theatreSeatAnchors } = await import('/src/data/crowdPlacement.ts');
    const { stageSurfaceHeight } = await import('/src/data/stageDesign.ts');
    const { setLayoutProps } = await import('/src/data/stagePlan.ts');
    const response = await fetch('/examples/steamboat-willie.stageforge.show.json');
    if (!response.ok) throw new Error('The committed Arena show fixture is unavailable.');
    const sample = parseShowFile(await response.text());
    const rig = structuredClone(venue === 'arena' ? sample.rig : RIG_TEMPLATES.small_theatre);
    // A stage 20.4 m wide puts a real 2.2 m-spaced barricade post exactly on the centre line.
    if (venue === 'arena') rig.stageWidth = 20.4;
    const box = { type: 'scenic', x: 0.4, z: -1.25, height: 2.4 };
    const stage = setLayoutProps(rig, undefined, [box]);
    const deck = stageSurfaceHeight(rig, box.x, box.z);
    // Right/left upper front corners of the native 0.95 × height × 0.70 scenic box.
    const far = [-1, 1].map(side => ({ name: 'stage-box-' + side,
      x: box.x + side * 0.475, y: deck + box.height, z: box.z + 0.35 }));
    const floor = deriveAudienceViewpoints(rig).find(view => view.id === 'floor');
    const seats = theatreSeatAnchors(rig);
    const castId = venue === 'arena' ? 'stageforge-steamboat-1928-mickey-capped' : 'stageforge-human-v2';
    const cast = [];
    let observedSeat;
    if (venue === 'arena') {
      // Aim independently at the real stage mark, then rotate 15 degrees toward the camera's right.
      const aimX = -floor.x, aimZ = -Math.max(0.5, rig.stageDepth * 0.15) - floor.z;
      const length = Math.hypot(aimX, aimZ), c = Math.cos(Math.PI / 12), t = Math.sin(Math.PI / 12);
      const forwardX = (aimX*c - aimZ*t)/length, forwardZ = (aimZ*c + aimX*t)/length;
      cast.push({ id: 'proof-standing', modelId: castId, pose: 'standing', yaw: 180,
        position: { x: floor.x + 3.2 * forwardX, y: 0, z: floor.z + 3.2 * forwardZ } });
    } else {
      const suitable = seats.filter(seat => seat.row >= 2 && seat.z >= floor.z - 5 && seat.z <= floor.z - 1.25);
      suitable.sort((a, b) => Math.abs(a.x - floor.x) - Math.abs(b.x - floor.x) || b.row - a.row || a.column - b.column);
      if (!suitable.length) throw new Error('No raked theatre seat in the intended sightline.');
      observedSeat = suitable[0];
      cast.push({ id: 'proof-seated', modelId: castId, pose: 'seated', seatId: observedSeat.id, yaw: 180 });
    }
    const layout = { generatorVersion: 2, seed: 249057, zones: [], exclusions: [], placements: cast };
    const look = { ...INITIAL_SHOW_STATE, autoDirector: false, audioReactive: false, blackout: false,
      primaryColor: '#ffffff', accentColor: '#ffffff', beamIntensity: 0, washIntensity: 0.85,
      movementSpeed: 0, strobeRate: 0, blinderLevel: 0, motors: { ...INITIAL_SHOW_STATE.motors, speed: 0, podTargets: {} },
      laser: { ...INITIAL_SHOW_STATE.laser, enabled: false },
      atmo: { ...INITIAL_SHOW_STATE.atmo, hazeLevel: 0, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
      led: { ...INITIAL_SHOW_STATE.led, enabled: false, speed: 0 } };
    const show = parseShowFile(JSON.stringify(makeShowFile(rig, [], look, null, undefined, undefined, undefined, stage, undefined, layout)));
    const rendered = resolveCrowdLayout(show.rig, show.crowd);
    if (rendered.placed !== 1) throw new Error('Landmark fixture must have exactly one explicit figure.');
    const person = rendered.placements[0];
    const barricadeZ = rig.stageDepth / 2 + 2.4;
    const railLength = rig.stageWidth + 6;
    const posts = [];
    for (let i = 0; i <= Math.min(96, Math.floor(railLength / 2.2)); i++) {
      posts.push({ name: 'barricade-post-' + i, x: -railLength / 2 + i * Math.max(2.2, railLength / 96) + 0.04,
        // The low post edge has a visible floor backdrop in both eye-height modes.
        y: 0.72, z: barricadeZ + 0.225 });
    }
    // Artist-space features are approximate for animated people. Rake, seat and scenic boxes use native geometry.
    const crowd = [{ name: person.id + '-upper-body', x: person.x, y: person.y + (observedSeat ? 0.85 : 1.06) * person.scaleY, z: person.z }];
    if (observedSeat) crowd[0].y = observedSeat.y + 1.15;
    // Native Theatre aisle marker on the same riser as the seated actor.
    const halfHouse = Math.max(18, Math.max(8, rig.stageWidth - 1.2) + 8) / 2;
    const markerX = Math.sign(floor.x) * (halfHouse - 1.3) * 0.38;
    const aisleMarker = observedSeat ? [{ name: observedSeat.id + '-aisle-marker', x: markerX + 0.03,
      y: observedSeat.y + 0.075, z: observedSeat.z - 0.05 - 0.42 + 0.03 }] : [];
    // White crown of the native capped Mickey model. The dark torso offers little neutral contrast.
    const capDepth = 0.02;
    const capCrown = { name: person.id + '-cap-crown', x: person.x + Math.sin(person.rotY) * capDepth,
      y: person.y + 1.34 * person.scaleY, z: person.z + Math.cos(person.rotY) * capDepth };
    const empty = makeShowFile(rig, [], look, null, undefined, undefined, undefined, stage, undefined, { ...layout, placements: [] });
    return { show, empty, far, posts, crowd, aisleMarker, capCrown, barricadeZ, observedSeat,
      rows: seats.filter((seat, i) => !i || seat.row !== seats[i - 1].row),
      placementId: person.id, modelId: person.modelId };
  }, venue);
}

async function openStereoLandmarkShow(page, fixture, empty = false) {
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  const files = page.getByRole('dialog', { name: 'Show files' });
  await files.getByLabel('Open show file').setInputFiles({ name: 'audience-landmarks.stageforge.show.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(empty ? fixture.empty : fixture.show)) });
  await expect(files).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.crowd().placementBindings.map(
    item => [item.placementId, item.modelId, item.pose]))).toEqual(empty ? [] : [
    [fixture.placementId, fixture.modelId, fixture.observedSeat ? 'seated' : 'standing'],
  ]);
}

async function selectStereoView(page, view, mode, snap) {
  const action = id => page.evaluate(id => window.stageforgeProbe.webXrMenuAction(id), id);
  const settled = () => expect.poll(async () => (await xrState(page)).audience.blink).toBe(null);
  await stereoProofReopen(page, snap ? 'squeeze' : 'select');
  await action('seat:' + view);
  await settled();
  await action('eye:' + mode);
  await settled();
  if (snap) { await action('snap:right'); await settled(); }
  await page.evaluate(() => {
    const menu = window.stageforgeProbe.webXr().audience.menuPose;
    window.__fakeWebXr.aimControllerAtMenu(menu, 512, 768, 0);
    window.__fakeWebXr.dispatchInput('selectstart', 0);
    window.__fakeWebXr.dispatchInput('selectstart', 0);
    window.__fakeWebXr.dispatchInput('selectend', 0);
  });
  await expect.poll(async () => {
    const a = (await xrState(page)).audience;
    return [a.currentViewpoint, a.eyeMode, a.yawOffsetDeg, a.blink, a.menuOpen];
  }).toEqual([view, mode, snap ? 30 : 0, null, false]);
  const frame = (await xrState(page)).frames;
  await expect.poll(async () => (await xrState(page)).frames).toBeGreaterThan(frame + 1);
}

// Independently match a small RGB patch in the actual two eye images. Projection selects the subject;
// it never supplies the winning shift. A flat/ambiguous or occluded ROI fails its own gate.
async function measureStereoLandmarks(page, pair, groups) {
  return page.evaluate(async ({ pair, groups }) => {
    async function decode(eye) {
      const image = new Image();
      image.src = eye.png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      if (canvas.width !== eye.viewport.width || canvas.height !== eye.viewport.height) throw new Error('Eye PNG size mismatch.');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return { w: canvas.width, h: canvas.height, rgba };
    }
    function project(point, eye) {
      const m = eye.viewToReferenceMatrix, p = eye.projectionMatrix;
      const dx = point.x - m[12], dy = point.y - m[13], dz = point.z - m[14];
      const v = [m[0]*dx + m[1]*dy + m[2]*dz, m[4]*dx + m[5]*dy + m[6]*dz, m[8]*dx + m[9]*dy + m[10]*dz, 1];
      const clip = row => p[row]*v[0] + p[4+row]*v[1] + p[8+row]*v[2] + p[12+row];
      const w = clip(3);
      return { x: (1 + clip(0)/w)*eye.viewport.width/2, y: (1 - clip(1)/w)*eye.viewport.height/2,
        depth: -v[2], inClip: w > 0 && Math.abs(clip(2)) <= w };
    }
    const [l, r] = await Promise.all([decode(pair.left), decode(pair.right)]);
    function rowValue(img, x, y) {
      const i = 4 * (y*img.w + x);
      return (img.rgba[i]*0.299 + img.rgba[i+1]*0.587 + img.rgba[i+2]*0.114);
    }
    const windowRadius = 5;
    function sample(p, q) {
      const cx = Math.round(p.x), cy = Math.round(p.y), ry = Math.round(q.y);
      const width = 2*windowRadius+1;
      const left = [];
      for (let y = -windowRadius; y <= windowRadius; y++) for (let x = -windowRadius; x <= windowRadius; x++) {
        left.push(rowValue(l, cx+x, cy+y));
      }
      const mean = left.reduce((sum, v) => sum+v, 0)/left.length;
      const energy = left.reduce((sum, v) => sum+(v-mean)**2, 0);
      let horiz = 0;
      for (let i = 0; i < left.length; i++) if (i%width) horiz += Math.abs(left[i]-left[i-1]);
      const candidates = [];
      // 64 mm fake IPD; the defined visibility margin admits at most 32 px disparity.
      for (let shift = -3; shift <= 32; shift += 0.25) {
        let sum = 0, sum2 = 0, cov = 0, index = 0;
        for (let y = -windowRadius; y <= windowRadius; y++) for (let x = -windowRadius; x <= windowRadius; x++,index++) {
          const sx = cx + x - shift, whole = Math.floor(sx), t = sx-whole;
          const a = rowValue(r, whole, ry+y), b = rowValue(r, whole+1, ry+y), v = a+(b-a)*t;
          sum += v; sum2 += v*v; cov += (left[index]-mean)*v;
        }
        const den = Math.sqrt(energy * Math.max(0, sum2 - sum*sum/left.length));
        candidates.push({ shift, correlation: den > 0.0001 ? cov/den : -1 });
      }
      candidates.sort((a,b) => b.correlation-a.correlation);
      const best = candidates[0], rival = candidates.find(c => Math.abs(c.shift-best.shift) >= 2);
      return { observed: best.shift, correlation: best.correlation,
        margin: best.correlation-rival.correlation, rms: Math.sqrt(energy/left.length), horizontalContrast: horiz/(width*(width-1)) };
    }
    const results = {};
    for (const [key, points] of Object.entries(groups)) {
      // Pick the geometrically central visible candidate before looking at the pixels.
      const candidates = points.map(world => ({ world, left:project(world,pair.left), right:project(world,pair.right) }))
        .filter(v => [v.left,v.right].every(p => p.inClip && p.x >= 40 && p.x < l.w-10 && p.y >= 10 && p.y < l.h-10))
        .sort((a,b) => Math.abs(a.left.x-l.w/2)-Math.abs(b.left.x-l.w/2) || a.world.name.localeCompare(b.world.name));
      if (!candidates.length) { results[key] = { error:'No named landmark in both eye viewports', candidates:points }; continue; }
      const v = candidates[0];
      results[key] = { ...v, expected:v.left.x-v.right.x, ...sample(v.left,v.right) };
    }
    return results;
  }, { pair, groups });
}

async function stereoProofReopen(page, kind = 'select') {
  const audience = (await xrState(page)).audience;
  expect(typeof audience.menuOpen, 'Runtime must expose real comfort-menu state').toBe('boolean');
  if (audience.menuOpen) return;
  await page.evaluate(kind => {
    window.__fakeWebXr.dispatchInput(kind + 'start', 0);
    window.__fakeWebXr.dispatchInput(kind + 'end', 0);
  }, kind);
  await expect.poll(async () => (await xrState(page)).audience.menuOpen).toBe(true);
}

function assertEyePose(actual, expected, tolerance = 0.002) {
  expect(Math.hypot(...['x','y','z'].map(k => actual.position[k]-expected.position[k]))).toBeLessThan(tolerance);
  const dot = ['x','y','z','w'].reduce((s,k) => s+actual.orientation[k]*expected.orientation[k],0);
  expect(Math.abs(dot)).toBeGreaterThan(0.9999);
}
function horizontalBasis(pose) {
  const m = pose.matrix, forwardLength = Math.hypot(m[8],m[10]), rightLength = Math.hypot(m[0],m[2]);
  return { forward:[-m[8]/forwardLength,-m[10]/forwardLength], right:[m[0]/rightLength,m[2]/rightLength] };
}
const dotXZ = (a,b) => a[0]*b[0] + a[1]*b[1];

async function captureStereoReceipt(page, info, fixture, quality, view, mode, snap, name, empty = false) {
  await selectStereoView(page, view, mode, snap);
  const pair = await page.evaluate(() => window.__fakeWebXr.captureNextEyePair({ timeoutMs: 5000 }));
  const { left, right, ...header } = pair;
  const { png: lp, ...lm } = left, { png: rp, ...rm } = right;
  await Promise.all([['left',lp],['right',rp]].map(async ([eye,png]) => {
    const path = info.outputPath(name + '-' + eye + '.png');
    await writeFile(path, Buffer.from(png.split(',')[1], 'base64'));
    await info.attach(name + '-' + eye, { contentType: 'image/png', path });
  }));
  const capEdge = { ...fixture.capCrown, x: fixture.capCrown.x + 0.09 };
  const near = fixture.observedSeat ? fixture.aisleMarker : view === 'stage-front' ? fixture.posts : [capEdge];
  const groups = { far:fixture.far };
  if (view !== 'foh') groups.near = near;
  if (view === 'floor' || fixture.observedSeat) groups.actor = fixture.crowd;
  const measured = await measureStereoLandmarks(page, pair, groups);
  const state = await xrState(page);
  const report = info.outputPath(name + '-measurements.json');
  await writeFile(report, JSON.stringify({
    ...header, left:lm, right:rm, measured, menuOpen:state.audience.menuOpen,
    blink:state.audience.blink, yawOffsetDeg:state.audience.yawOffsetDeg, fixtureModel:fixture.modelId,
    fixtureSeat:fixture.observedSeat?.id, asset:'native scenic box, native barricade and film actor or Theatre aisle marker and chair-supported human',
  },null,2));
  await info.attach(name + '-measurements', { contentType:'application/json', path: report });
  expect(state.audience.menuOpen).toBe(false);
  expect(state.audience.blink).toBe(null);
  expect([pair.profile,pair.viewpoint,pair.eyeMode]).toEqual([quality,view,mode]);
  const width = quality === 'pc-link-high' ? 512 : 384;
  expect(pair.left.viewport).toEqual({x:0,y:0,width,height:width});
  expect(pair.right.viewport).toEqual({x:width,y:0,width,height:width});
  expect(pair.counters.views).toBe(2);
  expect(pair.counters.calls).toBeGreaterThan(0);
  expect(pair.counters.triangles).toBeGreaterThan(0);
  assertEyePose(pair.head,pair.desiredHeadPose);
  const delta = ['x','y','z'].map(k => right.position[k]-left.position[k]);
  expect(Math.hypot(...delta)).toBeCloseTo(0.064,5);
  expect(delta.reduce((s,n,i) => s+n*pair.head.matrix[i],0)).toBeCloseTo(0.064,5);
  for (const k of ['x','y','z']) expect((left.position[k]+right.position[k])/2).toBeCloseTo(pair.head.position[k],5);
  if (!snap && (view === 'floor' || view === 'foh')) {
    const forward = horizontalBasis(pair.head).forward;
    const toStage = [-pair.head.position.x, -pair.head.position.z];
    const d = Math.hypot(...toStage);
    expect(dotXZ(forward,toStage)/d, 'Default floor/FOH heading must face the stage').toBeGreaterThan(Math.cos(5*Math.PI/180));
    // A negative sign is enough to expose mirrored aiming even at very shallow off-centre angles.
    if (Math.abs(toStage[0])/d > 0.015) expect(forward[0]*toStage[0]).toBeGreaterThan(0);
  }
  if (!fixture.observedSeat && view === 'stage-front') {
    expect(pair.head.position.y).toBeCloseTo(mode === 'standing' ? 1.60 : 1.20,2);
    expect(pair.head.position.z, 'Stage Front must be on the audience side of the real rail').toBeGreaterThan(fixture.barricadeZ+0.225);
  }
  if (fixture.observedSeat) {
    const row = [...fixture.rows].sort((a,b) => Math.abs(a.z-pair.head.position.z)-Math.abs(b.z-pair.head.position.z))[0];
    expect(row.row,'Theatre camera must land on a raised row').toBeGreaterThan(0);
    expect(Math.abs(row.z-pair.head.position.z)).toBeLessThanOrEqual(0.475);
    expect(pair.head.position.y).toBeCloseTo(row.y+1.20,2);
  }
  if (!empty) {
    for (const key of view === 'foh' ? ['far'] : ['near','far']) {
      const m = measured[key];
      expect(m.error, name+' '+key+' must be in both actual eyes').toBeUndefined();
      expect(m.expected).toBeGreaterThan(0);
      expect(m.expected).toBeLessThan(31);
      expect(Math.abs(m.left.y-m.right.y)).toBeLessThan(0.25);
      expect.soft(m.rms, name+' '+key+' must contain visible detail').toBeGreaterThan(3);
      expect.soft(m.horizontalContrast).toBeGreaterThan(0.8);
      expect.soft(m.correlation).toBeGreaterThan(0.75);
      expect.soft(m.margin, 'A second equally plausible match cannot establish disparity').toBeGreaterThan(0.005);
      expect.soft(Math.abs(m.observed-m.expected)).toBeLessThan(0.9);
    }
    const {near:n,far:f} = measured;
    if (view === 'foh') {
      expect(pair.head.position.z, 'FOH frames the stage from behind the floor fixture').toBeGreaterThan(fixture.crowd[0].z);
    } else {
      expect(n.left.depth).toBeLessThan(f.left.depth);
      expect.soft(n.observed-f.observed, 'Near landmark must show more measured disparity than the stage box').toBeGreaterThan(0.20);
    }
  }
  return {pair,measured};
}

async function verifyVisibleActor(page, info, label, present, absent) {
  assertEyePose(present.pair.head, absent.pair.head);
  const measurements = await page.evaluate(async ({present,absent}) => {
    async function pixels(eye) {
      const image = new Image(); image.src=eye.png; await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(image,0,0);
      return { w:canvas.width,h:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data };
    }
    const results={};
    for (const side of ['left','right']) {
      const [a,b]=await Promise.all([pixels(present.pair[side]),pixels(absent.pair[side])]);
      const changed=(point,radius) => {
        if (!point || point.x < radius || point.y < radius || point.x >= a.w-radius || point.y >= a.h-radius) return null;
        let count=0, samples=0;
        for (let y=Math.round(point.y)-radius; y<=Math.round(point.y)+radius; y++) {
          for (let x=Math.round(point.x)-radius; x<=Math.round(point.x)+radius; x++) {
            const i=(y*a.w+x)*4;
            const delta=Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]);
            count+=Number(delta>36); samples++;
          }
        }
        return count/samples;
      };
      results[side]={ actor:changed(present.measured.actor?.[side],9), scenery:changed(present.measured.far?.[side],9) };
    }
    return results;
  },{present,absent});
  await info.attach(label+'-actor-contrast',{contentType:'application/json',body:Buffer.from(JSON.stringify(measurements,null,2))});
  for (const eye of Object.values(measurements)) {
    expect(eye.actor).not.toBeNull(); expect(eye.scenery).not.toBeNull();
    expect(eye.actor).toBeGreaterThan(0.06);
    expect(eye.actor-eye.scenery,'Matched far scenery must be more stable than the actor crop').toBeGreaterThan(0.04);
  }
}

for (const quality of ['pc-link-high','standalone-low']) {
  test('direct paired audience-eye landmarks and cast visibility · '+quality, async ({page},info) => {
    test.setTimeout(150_000);
    const webglMessages = [];
    page.on('console', message => {
      if (webglMessages.length < 120 && /webgl|shader|context|invalid_operation/i.test(message.text())) {
        webglMessages.push({ type: message.type(), text: message.text() });
      }
    });
    await boot(page,{directEyeCapture:true});
    await page.evaluate(() => window.stageforgeProbe.setCrowdPoseFrozen(true));
    const arena=await stereoLandmarkFixture(page,'arena'), theatre=await stereoLandmarkFixture(page,'theatre');
    await openStereoLandmarkShow(page,arena);
    try {
      await enter(page,true);
      if (quality === 'standalone-low') {
        await stereoProofReopen(page);
        await page.evaluate(() => window.stageforgeProbe.webXrMenuAction('quality:standalone-low'));
        await exit(page); await enter(page);
      }
      const shot=(scene,view,mode,snap,name,empty=false) =>
        captureStereoReceipt(page,info,scene,quality,view,mode,snap,quality+'-'+name,empty);
      // Close the menu through the real controller ray while its preview-only limit override is active.
      await page.evaluate(() => {
        window.stageforgeProbe.webXrMenuAction('limiter');
        window.stageforgeProbe.webXrMenuAction('limiter');
      });
      await expect.poll(async () => (await xrState(page)).audience.status.limiterOverride).toBe(true);
      const standing=await shot(arena,'stage-front','standing',false,'front-standing');
      const hidden = (await xrState(page)).audience;
      expect(hidden.status.limiterOverride).toBe(false);
      expect(hidden.limiterConfirmArmed).toBe(false);
      const seated=await shot(arena,'stage-front','seated',false,'front-seated');
      expect(standing.pair.head.position.y-seated.pair.head.position.y).toBeCloseTo(0.4,2);
      const floor=await shot(arena,'floor','standing',false,'floor');
      const turned=await shot(arena,'floor','standing',true,'floor-right');
      const beforeBasis=horizontalBasis(floor.pair.head), afterForward=horizontalBasis(turned.pair.head).forward;
      const forwardDot=dotXZ(beforeBasis.forward,afterForward), rightDot=dotXZ(beforeBasis.right,afterForward);
      const turn=Math.atan2(rightDot,forwardDot)*180/Math.PI;
      await info.attach('actual-right-snap',{contentType:'application/json',body:Buffer.from(JSON.stringify({turn,rightDot,forwardDot}))});
      expect(rightDot,'A real right turn must move toward the previous camera-right vector').toBeCloseTo(0.5,3);
      expect(turn).toBeCloseTo(30,2);
      expect(Math.hypot(...['x','y','z'].map(k=>turned.pair.head.position[k]-floor.pair.head.position[k]))).toBeLessThan(0.01);
      await shot(arena,'foh','standing',false,'foh');
      await exit(page);
      await openStereoLandmarkShow(page,arena,true); await enter(page);
      const floorEmpty=await shot(arena,'floor','standing',false,'floor-control',true);
      await verifyVisibleActor(page,info,'floor',floor,floorEmpty);
      await exit(page);

      await openStereoLandmarkShow(page,theatre); await enter(page);
      const rake=await shot(theatre,'floor','seated',false,'theatre-rake');
      await exit(page);
      // Use the established engine lifecycle without an XR lease. Re-enter on a fresh session and layer.
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const gl = canvas.getContext('webgl2');
        const ext = gl.getExtension('WEBGL_lose_context');
        if (!ext) throw new Error('Context loss is required for the restored-pair gate.');
        window.__eyeProofLoss = ext;
        window.__eyeProofRestoreErrors = [];
        canvas.addEventListener('webglcontextrestored', () => {
          window.__eyeProofRestoreErrors.push({ phase: 'restore callback', code: gl.getError() });
        }, { once: true });
        ext.loseContext();
      });
      await expect.poll(()=>page.evaluate(()=>window.stageforgeProbe.graphicsProbe().contextLost)).toBe(true);
      await page.evaluate(()=>window.__eyeProofLoss.restoreContext());
      await expect.poll(()=>page.evaluate(()=>window.stageforgeProbe.graphicsProbe().contextLost)).toBe(false);
      const restoreErrors = await page.evaluate(() => {
        const gl = document.querySelector('canvas').getContext('webgl2');
        delete window.__eyeProofLoss;
        window.__eyeProofRestoreErrors.push({ phase: 'before rebuild', code: gl.getError() });
        window.stageforgeProbe.rebuildRig();
        window.__eyeProofRestoreErrors.push({ phase: 'after rebuild', code: gl.getError() });
        return window.__eyeProofRestoreErrors;
      });
      expect(restoreErrors, 'GL restore and scene rebuild must still leave the renderer clean').toEqual([
        { phase: 'restore callback', code: 0 },
        { phase: 'before rebuild', code: 0 },
        { phase: 'after rebuild', code: 0 },
      ]);
      await enter(page);
      const restored=await shot(theatre,'floor','seated',false,'theatre-rake-restored');
      expect(restored.pair.session).toBeGreaterThan(rake.pair.session);
      assertEyePose(rake.pair.head,restored.pair.head);
      await exit(page);
      await openStereoLandmarkShow(page,theatre,true); await enter(page);
      const rakeEmpty=await shot(theatre,'floor','seated',false,'theatre-control',true);
      await verifyVisibleActor(page,info,'theatre',restored,rakeEmpty);
      await exit(page);
    } finally {
      const diagnostics=await xrState(page).catch(()=>null);
      const path = info.outputPath('last-audience-state.json');
      await writeFile(path, JSON.stringify({ diagnostics, webglMessages }, null, 2));
      await info.attach('last-audience-state', {contentType:'application/json', path});
    }
  });
}

async function persistStereoLightingReceipt(info, name, contentType, body) {
  const path = info.outputPath(name + (contentType === 'image/png' ? '.png' : '.json'));
  await writeFile(path, body);
  await info.attach(name, {path, contentType});
}

const STEREO_LIGHTING_LOOKS = ['neutral', 'wash', 'stage-led-backlight', 'blackout'];

function stereoProofLook(base, name) {
  const wash = name === 'wash';
  const backlight = name === 'stage-led-backlight' || name === 'blackout';
  const color = wash ? '#00f0ff' : backlight ? '#ff0066' : '#ffffff';
  // The neutral look leaves house/environment lighting intact. Blackout retains the programmed
  // backlight underneath, so this is a real suppression/recovery test.
  return {
    ...base, masterDimmer: 1, blackout: name === 'blackout', autoDirector: false, audioReactive: false,
    primaryColor: color, accentColor: color, colorSplitMode: 'solid', movingGroups: {},
    beamIntensity: 0, washIntensity: wash ? 1 : 0, blinderLevel: 0, strobeRate: 0,
    movementMode: 'manual', movementSpeed: 0, movementSpread: 0, manualPan: 0, manualTilt: 0.2,
    atmo: { ...base.atmo, hazeLevel: 0, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
    laser: { ...base.laser, enabled: false, intensity: 0, strobe: 0 },
    led: { ...base.led, enabled: backlight, brightness: backlight ? 0.95 : 0, speed: 0, visualMode: 'cybergrid' },
  };
}

function stereoLightResponse(stats, name) {
  if (!stats?.active || !stats.requested || !stats.lights.length) return false;
  const rgb = [0,1,2].map(channel => stats.lights.reduce((sum, light) => sum + light.color[channel], 0));
  if (name === 'neutral' || name === 'blackout') return rgb.every(value => value === 0);
  if (name === 'wash') return rgb[1] > 0.03 && rgb[2] > 0.03 && rgb[0] < Math.min(rgb[1],rgb[2])*0.25;
  return rgb[0] > 0.03 && rgb[2] > 0.015 && rgb[1] < Math.min(rgb[0],rgb[2])*0.25
    && stats.lights.filter(light => Math.max(...light.color) > 0.001).every(light => light.dir[2] < -0.25);
}

async function readStereoLook(page,info,fixture,profile,name,label,hasActor) {
  const look = stereoProofLook(fixture.show.look,name);
  const first = await page.evaluate(look => {
    const probe = window.stageforgeProbe;
    probe.patchShowState(look);
    return { frame:probe.webXr().frames, time:performance.now() };
  },look);
  // Let the actual preview limiter settle. For empty controls there is no figure material or
  // crowd-light controller, so use the same minimum elapsed interval and actual XR frames.
  await expect.poll(() => page.evaluate(first => {
    const state = window.stageforgeProbe.webXr();
    return state.frames >= first.frame+3 && performance.now()-first.time >= 1000;
  }, first)).toBe(true);
  const receipt=profile+'-'+label;
  let settlingError;
  if (hasActor) {
    try {
      await expect.poll(async () => stereoLightResponse(
        await page.evaluate(() => window.stageforgeProbe.graphicsProbe().crowd),name), {timeout:4000}).toBe(true);
    } catch (error) {
      // Preserve the real raster before reporting a light which never reached its target.
      settlingError=String(error);
    }
  }
  const preCapture=await page.evaluate(()=>({lights:window.stageforgeProbe.graphicsProbe().crowd,xr:window.stageforgeProbe.webXr()}));
  await persistStereoLightingReceipt(info,receipt+'-request','application/json',JSON.stringify({look,preCapture,settlingError},null,2));
  const result = await page.evaluate(async expectedSubmission => {
    const pair = await window.__fakeWebXr.captureNextEyePair({ timeoutMs: 6000, expectedSubmission });
    // Resolution runs in a microtask following that XR callback, before the next browser frame.
    const probe = window.stageforgeProbe;
    return { pair, lights:probe.graphicsProbe().crowd, state:probe.webXr() };
  }, name === 'blackout' ? 'blackout-clear' : 'scene');
  const { pair, lights, state }=result;
  const { left,right,...frame }=pair;
  const {png: lp,...lm}=left, {png: rp,...rm}=right;
  await Promise.all([['left',lp],['right',rp]].map(([side,png])=>
    persistStereoLightingReceipt(info,receipt+'-'+side,'image/png',Buffer.from(png.split(',')[1],'base64'))));
  await persistStereoLightingReceipt(info,receipt+'-state','application/json',JSON.stringify({
    frame,left:lm,right:rm,look,lights,quantity:'display RGB recorded from each direct emulated eye',
    activeFrame:state.frames,menuOpen:state.audience.menuOpen,settlingError,
  },null,2));
  expect(settlingError,'The programmed light must settle to its expected native response').toBeUndefined();
  expect(state.frames).toBe(pair.frame);
  expect([pair.profile,pair.viewpoint,pair.eyeMode,state.audience.menuOpen,state.audience.blink])
    .toEqual([profile,'floor','standing',false,null]);
  assertEyePose(pair.head,pair.desiredHeadPose);
  expect(pair.lastLayerTargetPreserved).toBe(true);
  expect(pair.counters.views).toBe(2);
  const size=profile==='pc-link-high'?512:384;
  expect([left.viewport.width,right.viewport.width,left.viewport.height,right.viewport.height]).toEqual([size,size,size,size]);
  if (hasActor) expect(stereoLightResponse(lights,name)).toBe(true);
  if (name === 'blackout') {
    expect(pair.submission).toBe('blackout-clear');
    expect(pair.witnessedBlackClears).toBeGreaterThan(0);
    expect([pair.counters.calls,pair.counters.triangles]).toEqual([0,0]);
    for (const eye of [left,right]) {
      expect(eye.pixels).toBe(size*size);
      expect(eye.nonOpaqueBlackPixels,'All returned pixels must be opaque black after a real full-atlas clear').toBe(0);
    }
  } else {
    expect(pair.submission).toBe('scene');
    expect(pair.counters.calls).toBeGreaterThan(0);
    expect(pair.counters.triangles).toBeGreaterThan(0);
  }
  return {pair,lights};
}

async function stereoActorLightingStats(page, present, empty, landmark) {
  const names = ['neutral', 'wash', 'stage-led-backlight', 'recovered-stage-backlight'];
  const pairs = Object.fromEntries(names.map(name => {
    const background = name === 'recovered-stage-backlight' ? 'stage-led-backlight' : name;
    return [name, Object.fromEntries(['left', 'right'].map(side => [side, {
      lit: present[name].pair[side].png, empty: empty[background].pair[side].png,
      focalPx: present[name].pair[side].projectionMatrix[5] * present[name].pair[side].viewport.height / 2,
    }]))];
  }));

  return page.evaluate(async ({ pairs, landmark }) => {
    async function readImage(png) {
      const image = new Image();
      image.src = png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function measureCap(lit, empty, projected, pxPerMetre) {
      const { width, height } = lit;
      const box = {
        x0: Math.floor(projected.x - 0.31 * pxPerMetre), x1: Math.ceil(projected.x + 0.31 * pxPerMetre),
        y0: Math.floor(projected.y - 0.27 * pxPerMetre), y1: Math.ceil(projected.y + 0.13 * pxPerMetre),
      };
      if (width !== empty.width || height !== empty.height || box.x0 < 1 || box.x1 >= width-1 ||
          box.y0 < 1 || box.y1 >= height-1) return { error: 'Crown window outside matched eyes', box };

      // The crown spans 0.22 m by 0.18 m. Search its immediate neighborhood for its bright
      // surface over the same-look empty. Allow the native standing bounce and sway in each frame.
      const remaining = new Set();
      for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
        const pixel = y * width + x, i = 4 * pixel;
        const brighter = lit.data[i] - empty.data[i] + lit.data[i+1] - empty.data[i+1]
          + lit.data[i+2] - empty.data[i+2];
        if (brighter > 30) remaining.add(pixel);
      }
      const neighbors = [-1, 1, -width, width];
      const components = [];
      while (remaining.size) {
        const start = remaining.values().next().value;
        const component = [start];
        remaining.delete(start);
        for (let i = 0; i < component.length; i++) {
          for (const offset of neighbors) {
            const neighbor = component[i] + offset;
            if (remaining.delete(neighbor)) component.push(neighbor);
          }
        }
        components.push(component);
      }
      components.sort((a, b) => b.length - a.length);
      if (!components.length) return { error: 'Crown missing in the paired raster', box, pxPerMetre };

      const pixels = components[0], membership = new Set(pixels);
      const rim = [], core = [];
      let sumX = 0, sumY = 0, clipped = false;
      for (const pixel of pixels) {
        const x = pixel % width, y = Math.floor(pixel / width);
        sumX += x; sumY += y;
        clipped ||= x === box.x0 || x === box.x1 || y === box.y0 || y === box.y1;
        const isRim = neighbors.some(offset => !membership.has(pixel + offset));
        (isRim ? rim : core).push(pixel);
      }
      function mean(image, indices) {
        if (!indices.length) return null;
        return [0, 1, 2].map(c => indices.reduce((sum, p) => sum + image.data[4*p+c], 0) / indices.length);
      }
      return {
        box, pxPerMetre, clipped, centre: [sumX/pixels.length, sumY/pixels.length], pixels: pixels.length,
        runnerUpPixels: components[1]?.length ?? 0, rimPixels: rim.length, corePixels: core.length,
        rim: mean(lit, rim), emptyRim: mean(empty, rim), core: mean(lit, core), emptyCore: mean(empty, core),
      };
    }

    const result = { landmark, eyes: {} };
    for (const side of ['left', 'right']) {
      const looks = {};
      const anchor = landmark[side];
      for (const [name, pair] of Object.entries(pairs)) {
        const {lit, empty, focalPx} = pair[side];
        const [actor, background] = await Promise.all([readImage(lit), readImage(empty)]);
        looks[name] = measureCap(actor, background, anchor, focalPx / anchor.depth);
      }
      const changes = {};
      const neutral = looks.neutral;
      for (const [name, look] of Object.entries(looks)) {
        if (name === 'neutral' || !look.rim || !look.core || !neutral.rim || !neutral.core) continue;
        const delta = key => look[key].map((value, i) => value - neutral[key][i]);
        const subtract = (a, b) => a.map((value, i) => value - b[i]);
        const rim = subtract(delta('rim'), delta('emptyRim'));
        const core = subtract(delta('core'), delta('emptyCore'));
        const chroma = ([r, g, b]) => name === 'wash' ? (g+b)/2-r : (r+b)/2-g;
        changes[name] = { rim, core, rimChroma: chroma(rim), coreChroma: chroma(core),
          emptyRimChroma: chroma(delta('emptyRim')) };
      }
      result.eyes[side] = { looks, changes };
    }
    return result;
  }, { pairs, landmark });
}

for (const profile of ['pc-link-high','standalone-low']) {
  test('direct-eye authored crowd lighting and XR blackout · '+profile,async ({page},info)=>{
    test.setTimeout(120_000);
    await boot(page,{directEyeCapture:true});
    await page.evaluate(() => window.stageforgeProbe.setCrowdPoseFrozen(true));
    const fixture=await stereoLandmarkFixture(page,'arena');
    await openStereoLandmarkShow(page,fixture);
    await page.evaluate(()=>window.stageforgeProbe.setRenderSettings({crowdLighting:true}));
    await enter(page,true);
    if (profile==='standalone-low') {
      await stereoProofReopen(page);
      await page.evaluate(()=>window.stageforgeProbe.webXrMenuAction('quality:standalone-low'));
      await exit(page); await enter(page);
    }
    const present={},empty={};
    try {
      await selectStereoView(page,'floor','standing',false);
      for(const name of STEREO_LIGHTING_LOOKS) {
        const shot=await readStereoLook(page,info,fixture,profile,name,name,true);
        if(present.neutral) assertEyePose(shot.pair.head,present.neutral.pair.head);
        if(name!=='blackout') present[name]=shot;
      }
      // Restore the programmed magenta stage backlight on the same session after clear-only frames.
      const recovery=await readStereoLook(page,info,fixture,profile,'stage-led-backlight','recovered-stage-backlight',true);
      assertEyePose(recovery.pair.head,present.neutral.pair.head);
      expect(recovery.pair.session).toBe(present.neutral.pair.session);
      present['recovered-stage-backlight'] = recovery;
      const { cap } = await measureStereoLandmarks(page, present.neutral.pair, { cap: [fixture.capCrown] });
      expect(cap.error, 'The authored cap crown must project into both native eye viewports').toBeUndefined();
      await exit(page);
      await openStereoLandmarkShow(page,fixture,true); await enter(page);
      await selectStereoView(page,'floor','standing',false);
      for(const name of ['neutral','wash','stage-led-backlight']) {
        empty[name]=await readStereoLook(page,info,fixture,profile,name,'empty-'+name,false);
        assertEyePose(empty[name].pair.head,present[name].pair.head);
      }
      const metrics = await stereoActorLightingStats(page, present, empty, cap);
      await persistStereoLightingReceipt(info,profile+'-actor-light-response','application/json',JSON.stringify(metrics,null,2));
      for (const [side, eye] of Object.entries(metrics.eyes)) {
        for (const [name, look] of Object.entries(eye.looks)) {
          const label = side + ' ' + name;
          expect(look.error, label).toBeUndefined();
          expect(look.clipped, label + ' cap must fit the authored window').toBe(false);
          const areaM2 = look.pixels / look.pxPerMetre**2;
          expect(areaM2, label + ' projected crown area').toBeGreaterThan(0.014);
          expect(areaM2, label + ' projected crown area').toBeLessThan(0.075);
          expect(look.pixels, label + ' cap must dominate isolated noise').toBeGreaterThan(4 * look.runnerUpPixels);
          expect(look.rimPixels, label + ' rim coverage').toBeGreaterThan(24);
          expect(look.corePixels, label + ' core coverage').toBeGreaterThan(30);
          const distance = Math.hypot(look.centre[0] - cap[side].x, look.centre[1] - cap[side].y);
          expect(distance / look.pxPerMetre, label + ' distance from projected crown').toBeLessThan(0.2);
        }
        for (const name of ['wash', 'stage-led-backlight', 'recovered-stage-backlight']) {
          const response = eye.changes[name], label = side + ' ' + name;
          const [r, g, b] = response.rim;
          const wash = name === 'wash';
          expect(wash ? (g+b)/2 : (r+b)/2, label + ' matched-background color gain').toBeGreaterThan(wash ? 6 : 3);
          expect(response.rimChroma, label + ' selective rim color').toBeGreaterThan(wash ? 8 : 3);
          expect(response.rimChroma - response.coreChroma, label + ' rim relative to cap interior').toBeGreaterThan(3);
          expect(response.rimChroma, label + ' rim relative to empty backdrop').toBeGreaterThan(Math.abs(response.emptyRimChroma) + 2);
        }
      }
      for (const name of Object.keys(metrics.eyes.left.looks)) {
        const l = metrics.eyes.left.looks[name].centre, r = metrics.eyes.right.looks[name].centre;
        expect(Math.abs(l[0]-r[0]-cap.expected), name + ' disparity of the same cap').toBeLessThan(2.5);
        expect(Math.abs(l[1]-r[1]), name + ' rectified cap height').toBeLessThan(2.5);
      }
      await exit(page);
    } finally {
      const state=await xrState(page).catch(()=>null);
      await persistStereoLightingReceipt(info,profile+'-last-lighting-state','application/json',JSON.stringify(state,null,2));
    }
  });
}
