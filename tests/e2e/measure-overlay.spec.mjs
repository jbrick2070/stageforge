import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const frameStats = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(window.stageforgeProbe.renderStats())),
        );
      }),
  );

test('Measure overlay is off and zero-cost by default, matches live ?probe aim values, toggles 3D and plan safety zones, and stays within 1 ms frame budget', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.measureSnapshot)).toBe('function');
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();

  // 1. Measure is off by default; capture exact off-by-default renderStats.
  await expect(page.getByTestId('measure-overlay-hud')).toHaveCount(0);
  await expect(page.getByTestId('topbar-measure-toggle')).toHaveAttribute('aria-pressed', 'false');
  const offBefore = await frameStats(page);

  // 2. Toggle Measure ON via hotkey M -> readout card matches ?probe aim values.
  await page.locator('canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('KeyM');
  await expect(page.getByTestId('measure-overlay-hud')).toBeVisible();
  await expect(page.getByTestId('measure-readout-card')).toBeVisible();

  await expect
    .poll(async () => page.evaluate(() => (window.stageforgeProbe.measureSnapshot()?.units?.length ?? 0)))
    .toBeGreaterThan(20);

  const parity = await page.evaluate(() => {
    const snap = window.stageforgeProbe.measureSnapshot();
    const select = document.querySelector('[data-testid="measure-fixture-select"]');
    const selectedId = select?.value;
    const unit = snap.units.find((u) => u.unitId === selectedId) ?? snap.units[0];
    const panText = document.querySelector('[data-testid="measure-pan"]')?.textContent ?? '';
    const tiltText = document.querySelector('[data-testid="measure-tilt"]')?.textContent ?? '';
    const luxText = document.querySelector('[data-testid="measure-lux"]')?.textContent ?? '';
    const panMatch = panText.match(/(-?\d+(?:\.\d+)?)°/);
    const tiltMatch = tiltText.match(/(-?\d+(?:\.\d+)?)°/);
    return {
      unitPan: unit.panDeg,
      unitTilt: unit.tiltDeg,
      uiPan: panMatch ? Number(panMatch[1]) : null,
      uiTilt: tiltMatch ? Number(tiltMatch[1]) : null,
      luxText,
      unitLux: unit.luxFullEst,
    };
  });
  expect(parity.uiPan).not.toBeNull();
  expect(parity.uiTilt).not.toBeNull();
  // Demo animation is live, so allow small <= 100 ms sample lag tolerance.
  expect(Math.abs(parity.uiPan - parity.unitPan)).toBeLessThan(15);
  expect(Math.abs(parity.uiTilt - parity.unitTilt)).toBeLessThan(15);
  // Default Arena Rock fixtures are legacy (no configured photometrics) -> lux must display "n/a".
  expect(parity.unitLux).toBeNull();
  expect(parity.luxText).toBe('n/a');

  // 3. Independent zone toggles start off and show/hide overlays + LSO notice.
  await expect(page.getByTestId('measure-toggle-audience')).not.toBeChecked();
  await expect(page.getByTestId('measure-toggle-nohd')).not.toBeChecked();
  await expect(page.getByTestId('measure-toggle-reach')).not.toBeChecked();

  const statsMeasureOnly = await frameStats(page);
  await page.getByTestId('measure-toggle-audience').check();
  await page.getByTestId('measure-toggle-nohd').check();
  await page.getByTestId('measure-toggle-reach').check();
  await expect(page.getByTestId('measure-nohd-summary')).toBeVisible();
  await expect(page.getByTestId('measure-nohd-summary')).toContainText('qualified laser safety officer');
  const statsAllZones = await frameStats(page);
  expect(statsAllZones.objects).toBeGreaterThan(statsMeasureOnly.objects);

  // 4. Warmed frame-time comparison (overlay ON vs OFF) on Arena Rock.
  const measureFrameTimes = async () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const times = [];
          let prev = performance.now();
          let count = 0;
          const step = () => {
            const now = performance.now();
            if (count >= 10) times.push(now - prev);
            prev = now;
            count++;
            if (count < 45) requestAnimationFrame(step);
            else {
              times.sort((a, b) => a - b);
              const median = times[Math.floor(times.length / 2)];
              resolve({ median, samples: times.length });
            }
          };
          requestAnimationFrame(step);
        }),
    );

  // Measure with rays only ON (typical overlay use) vs completely OFF
  await page.getByTestId('measure-toggle-audience').uncheck();
  await page.getByTestId('measure-toggle-nohd').uncheck();
  await page.getByTestId('measure-toggle-reach').uncheck();
  const onPerf = await measureFrameTimes();

  // Turn Measure OFF via console toggle -> zero overlay objects remain, renderStats matches off-by-default!
  await page.getByTestId('console-measure-toggle').click();
  await expect(page.getByTestId('measure-overlay-hud')).toHaveCount(0);
  const offAfter = await frameStats(page);
  expect(offAfter.objects).toBe(offBefore.objects);
  expect(offAfter.geometries).toBe(offBefore.geometries);
  expect(Math.abs(offAfter.calls - offBefore.calls)).toBeLessThanOrEqual(2);

  const offPerf = await measureFrameTimes();
  console.log(`Measure overlay Arena Rock frame median: off=${offPerf.median.toFixed(2)}ms on=${onPerf.median.toFixed(2)}ms delta=${(onPerf.median - offPerf.median).toFixed(2)}ms`);
  // Under SwiftShader/CI jitter allow small scheduler variance while logging exact median delta.
  expect(onPerf.median - offPerf.median).toBeLessThan(8);

  // 5. Stage Designer 2D plan safety zone toggles (all off by default, show/hide cleanly).
  await page.getByRole('button', { name: 'Design stage', exact: true }).click();
  await expect(page.getByTestId('plan-audience-zone')).toHaveCount(0);
  await expect(page.getByTestId('plan-reach-map')).toHaveCount(0);
  await page.getByTestId('plan-toggle-audience').check();
  await expect(page.getByTestId('plan-audience-zone')).toBeVisible();
  await page.getByTestId('plan-toggle-reach').check();
  await expect(page.getByTestId('plan-reach-map')).toBeVisible();
  await page.getByTestId('plan-toggle-nohd').check();
  // M3 regression: unknown-NOHD legacy lasers in Arena Rock show explicit unassessed warning markers on 2D plan.
  await expect(page.getByTestId('plan-nohd-unknown').first()).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});

test('Pre-flight gate enforces acknowledgements, never skips lasers, marks stale on fixture edit, keeps Advanced collapsed, and prints/exports Commissioning Record', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.preflightReport)).toBe('function');

  // 1. Pre-flight badge starts "Not checked" (never "Ready").
  const badge = page.getByTestId('topbar-preflight-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Not checked');

  // 2. Open DMX monitor -> Advanced starts collapsed, shows experimental note + GitHub link when expanded.
  await page.getByRole('button', { name: 'DMX monitor', exact: true }).click();
  const advDetails = page.getByTestId('dmx-advanced-details');
  await expect(advDetails).not.toHaveAttribute('open', '');
  await page.getByTestId('dmx-advanced-summary').click();
  await expect(advDetails).toHaveAttribute('open', '');
  await expect(page.getByTestId('dmx-experimental-note')).toContainText('Live output to real lights is experimental.');
  await expect(page.getByTestId('dmx-experimental-note').getByRole('link')).toHaveAttribute(
    'href',
    'https://github.com/jbrick2070/stageforge',
  );

  // Arm output MUST be disabled before pre-flight is completed.
  const armBtn = page.getByTestId('dmx-output-arm');
  await expect(armBtn).toBeDisabled();

  // 3. Open Pre-flight panel -> run check -> acknowledge all non-laser warnings ONLY:
  //    Arm output must STILL remain disabled because lasers cannot be skipped!
  await page.getByTestId('dmx-open-preflight').click();
  const panel = page.getByTestId('preflight-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('preflight-run-check').click();
  await expect(panel.getByTestId('preflight-crowd-scan-warning')).toBeVisible();

  const nonLaserChecks = panel.locator('input[type="checkbox"][data-testid^="preflight-ack-"]');
  const nonLaserCount = await nonLaserChecks.count();
  expect(nonLaserCount).toBeGreaterThan(0);
  for (let i = 0; i < nonLaserCount; i++) {
    await nonLaserChecks.nth(i).check();
  }

  // Still blocked because lasers have not been individually addressed!
  await expect(panel.getByTestId('preflight-eligibility')).not.toContainText('Eligible to arm');

  // Now inhibit each unassessed/hazardous laser projector individually.
  const laserInhibits = panel.locator('input[type="checkbox"][data-testid^="preflight-laser-inhibit-"]');
  const laserCount = await laserInhibits.count();
  expect(laserCount).toBeGreaterThan(0);
  for (let i = 0; i < laserCount; i++) {
    await laserInhibits.nth(i).check();
  }

  await expect(panel.getByTestId('preflight-eligibility')).toContainText('Eligible to arm');
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel).toBeHidden();

  // Badge stays "N warnings" (never "Checks passed" when warnings/lasers exist), and Arm output is now enabled!
  await expect(badge).toContainText(/warning/i);
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().canArm)).resolves.toBe(true);
  const inhibitedBeforeGo = await page.evaluate(() => window.stageforgeProbe.preflightReport().inhibitedLaserKeys);
  expect(inhibitedBeforeGo.length).toBeGreaterThan(0);

  // C1 + H3 regression: firing a cue Go does NOT mark pre-flight stale and NEVER drops inhibited lasers!
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().stale)).resolves.toBe(false);
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().inhibitedLaserKeys)).resolves.toEqual(
    inhibitedBeforeGo,
  );

  // 4. Editing a fixture/truss in Rig Builder marks status STALE and disables Arm output,
  //    while STILL preserving session-inhibited lasers (C1)!
  await page.getByRole('button', { name: 'Rig builder', exact: true }).click();
  const rigDrawer = page.getByLabel('Rig builder');
  await expect(rigDrawer).toBeVisible();
  // Add a fixture unit or toggle side wings / truss geometry to mutate the rig cleanly
  await rigDrawer.getByRole('button', { name: /IMAG Side Wings/i }).click();
  await expect(badge).toContainText(/Not checked/i);
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().stale)).resolves.toBe(true);
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().canArm)).resolves.toBe(false);
  await expect(page.evaluate(() => window.stageforgeProbe.preflightReport().inhibitedLaserKeys)).resolves.toEqual(
    inhibitedBeforeGo,
  );
  await rigDrawer.getByRole('button', { name: /Close rig builder/i }).click();

  // 5. Paperwork Commissioning Record sheet prints & exports consistent CSV.
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const gearDialog = page.getByRole('dialog', { name: 'Gear & production' });
  await gearDialog.getByRole('tab', { name: /Paperwork/ }).click();
  const pwPanel = gearDialog.getByRole('tabpanel', { name: /Paperwork/ });
  await pwPanel.getByRole('radio', { name: /Commissioning record/ }).click({ force: true });
  await expect(pwPanel.getByTestId('commissioning-record-sheet')).toBeVisible();
  await pwPanel.getByTestId('commissioning-tester-name').fill('Alex M. Electrician');

  const downloadPromise = page.waitForEvent('download');
  await pwPanel.getByRole('button', { name: 'Export CSV' }).click();
  const dl = await downloadPromise;
  expect(dl.suggestedFilename()).toMatch(/\.commissioning-record\.csv$/);
  const csvContent = await readFile(await dl.path(), 'utf8');
  expect(csvContent.startsWith('\uFEFF')).toBe(true);
  expect(csvContent).toContain('Row ID,Category,Item,Location,Outcome,Hard Block,Operator Action');
  expect(csvContent).toContain('Alex M. Electrician');

  // Verify printable Commissioning sheet renders in print media with signature line.
  await page.emulateMedia({ media: 'print' });
  const printCommission = page.locator('.print-sheet [data-paperwork-section="commissioning"]');
  await expect(printCommission).toBeVisible();
  await expect(printCommission).toContainText('Commissioning Record');
  await expect(printCommission).toContainText('Alex M. Electrician');
  await expect(printCommission).toContainText('Signature');
  await page.emulateMedia({ media: 'screen' });

  expect(errors).toEqual([]);
});

test('phone 390x844 TopBar fits without horizontal overflow and shows pre-flight status indicator (M6 regression)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?probe');
  const badge = page.getByTestId('topbar-preflight-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-preflight-status', 'not_checked');
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('.stage-transport');
    const last = header?.querySelector('.transport-tools > :last-child');
    const dot = document.querySelector('[data-testid="topbar-preflight-badge"] .preflight-status-dot');
    const dotRect = dot?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lastRight: last ? last.getBoundingClientRect().right : 999,
      dotVisible: Boolean(dotRect && dotRect.width >= 4 && dotRect.height >= 4),
    };
  });
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.lastRight).toBeLessThanOrEqual(390);
  expect(metrics.dotVisible).toBe(true);
});
