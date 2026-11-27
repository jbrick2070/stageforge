import { expect, test } from '@playwright/test';

const DEFERRED_PANEL_NAMES = [
  'RigBuilderDrawer',
  'DmxMonitorDrawer',
  'ShowControlDrawer',
  'ShowFiles',
  'PitchViewer',
  'StageDesigner',
  'CueListEditor',
  'MvrImportReport',
];

test('L1: startup loads zero deferred editor panel chunks until a panel is opened', async ({ page }) => {
  const loadedScripts = [];
  let initialJsBytes = 0;
  page.on('response', async (res) => {
    if (res.request().resourceType() === 'script' || res.url().endsWith('.js')) {
      const url = res.url();
      let len = Number(res.headers()['content-length'] || 0);
      if (!len) {
        try {
          len = (await res.body()).byteLength;
        } catch {
          len = 0;
        }
      }
      loadedScripts.push({ url, len });
      initialJsBytes += len;
    }
  });

  await page.goto('/?probe');
  await expect(page.getByRole('button', { name: /DMX/i })).toBeVisible();
  // Wait briefly past first paint so any eager startup preload would have fired.
  await page.waitForTimeout(800);

  const startupUrls = loadedScripts.map((s) => s.url);
  for (const name of DEFERRED_PANEL_NAMES) {
    const matched = startupUrls.filter((u) => u.includes(name));
    expect(matched, `Deferred panel chunk "${name}" must not be fetched at startup`).toEqual([]);
  }
  const startupCount = loadedScripts.length;
  const startupBytes = initialJsBytes;

  // Opening DMX Monitor loads its chunk on demand and shows Simulated / Wire preview toggle.
  await page.getByRole('button', { name: /DMX/i }).click();
  await expect(page.getByLabel('DMX monitor')).toBeVisible();
  await expect(page.getByTestId('dmx-monitor-mode-sim')).toBeVisible();
  await expect(page.getByTestId('dmx-monitor-mode-phys')).toBeVisible();
  await page.getByTestId('dmx-advanced-summary').click();
  await expect(page.getByTestId('dmx-physical-coverage')).toBeVisible();
  expect(loadedScripts.length).toBeGreaterThanOrEqual(startupCount);
  console.log(`L1 startup JS: ${startupCount} scripts, ${startupBytes} bytes`);
});

test('H1 + H4: physical DMX outputs neutral zeros for unimplemented catalogue fixtures, and Space blackout zeroes CO2, smoke, and haze', async ({ page }) => {
  await page.goto('/?probe');
  await expect(page.locator('canvas')).toBeVisible();

  // Switch to Motors & FX tab and activate CO2, smoke, and haze
  await page.getByRole('button', { name: /Motors & FX/i }).click();
  await page.getByRole('button', { name: /CO2 LATCH/i }).click();
  await page.getByLabel('ARENA HAZE').fill('0.8');
  await page.getByLabel('SMOKE JETS').fill('0.8');

  await expect.poll(async () => {
    const atmo = await page.evaluate(() => window.stageforgeProbe.fixtureParams().atmo);
    return atmo.co2 === true && atmo.smoke > 0.5 && atmo.haze > 0.5;
  }, { timeout: 5000 }).toBe(true);

  const beforeBlackout = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    return {
      rig: p.rig(),
      sim: p.dmxSnapshot(),
      phys: p.physicalDmxSnapshot(),
      params: p.fixtureParams(),
    };
  });
  expect(beforeBlackout.params.atmo.co2).toBe(true);
  expect(beforeBlackout.params.atmo.smoke).toBeGreaterThan(0.5);
  expect(beforeBlackout.params.atmo.haze).toBeGreaterThan(0.5);

  // Trigger emergency blackout with Space (blur range input first so Space triggers global blackout)
  await page.locator('canvas').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Space');
  await expect(page.getByRole('alert')).toContainText(/STAGE BLACKOUT/i);

  await expect.poll(async () => {
    const atmo = await page.evaluate(() => window.stageforgeProbe.fixtureParams().atmo);
    return atmo.co2 === false && atmo.smoke === 0 && atmo.haze === 0;
  }, { timeout: 5000 }).toBe(true);

  const duringBlackout = await page.evaluate(() => {
    const p = window.stageforgeProbe;
    return {
      sim: p.dmxSnapshot(),
      phys: p.physicalDmxSnapshot(),
      params: p.fixtureParams(),
    };
  });

  // H4: Under blackout, CO2, smoke, AND haze must all be zero in simulation params and DMX buffers!
  expect(duringBlackout.params.atmo.co2).toBe(false);
  expect(duringBlackout.params.atmo.smoke).toBe(0);
  expect(duringBlackout.params.atmo.haze).toBe(0);

  // Verify every atmosphere channel (CO2, smoke, haze) in the rig is 0 in both sim and physical DMX under blackout
  const atmoUnits = beforeBlackout.rig.floorFx.filter((f) => f.type === 'co2' || f.type === 'smoke' || f.type === 'hazer');
  expect(atmoUnits.length).toBeGreaterThan(0);
  for (const fx of atmoUnits) {
    const simBuf = fx.dmxUniverse === 1 ? duringBlackout.sim.u1 : duringBlackout.sim.u2;
    const physBuf = fx.dmxUniverse === 1 ? duringBlackout.phys.u1 : duringBlackout.phys.u2;
    expect(simBuf[fx.dmxStartChannel - 1], `sim DMX for ${fx.type} must be 0 under blackout`).toBe(0);
    expect(physBuf[fx.dmxStartChannel - 1], `physical DMX for ${fx.type} must be 0 under blackout`).toBe(0);
  }

  // Restore blackout and confirm haze/smoke/CO2 return cleanly (programmed levels preserved underneath blackout)
  await page.keyboard.press('Space');
  await expect.poll(async () => {
    const atmo = await page.evaluate(() => window.stageforgeProbe.fixtureParams().atmo);
    return atmo.co2 === true && atmo.smoke > 0.5 && atmo.haze > 0.5;
  }, { timeout: 5000 }).toBe(true);
});

test('Sprint 10 amendment: failed demo track audio load falls back to built-in synth demo with toast', async ({ page }) => {
  await page.route('**/demo/track.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        format: 'stageforge-demo-track',
        version: 1,
        title: 'Broken Demo Track',
        file: 'missing.mp3',
        bpm: 120,
        firstDownbeatMs: 0,
        sections: [{ role: 'drop', label: 'Single section', bars: 8 }],
      }),
    });
  });
  await page.route('**/demo/missing.mp3', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Server error' });
  });

  await page.goto('/?probe');
  const demoTrackBtn = page.getByRole('button', { name: 'Play demo', exact: true });
  await expect(demoTrackBtn).toBeVisible({ timeout: 10_000 });
  await demoTrackBtn.click();

  // Must fall back to built-in synth demo and show fallback toast
  await expect(page.getByRole('status').filter({ hasText: /Falling back to built-in synth demo/i })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    return page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars ?? null);
  }, { timeout: 5000 }).toBe(64);
});
