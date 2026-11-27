import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const rig = page => page.evaluate(() => window.stageforgeProbe.rig());
const savedRig = page => page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.design.v1')));
const crowd = page => page.evaluate(() => window.stageforgeProbe.crowd());

async function openFiles(page) {
  await button(page, 'Show files').click();
  return page.getByRole('dialog', { name: 'Show files' });
}

async function openFilm(page) {
  const files = await openFiles(page);
  await button(files, 'Open Steamboat Willie example').click();
  await expect(files).toBeHidden();
  await expect.poll(async () => (await rig(page)).name).toBe('Steamboat Willie at the Arena');
  await expect.poll(async () => (await crowd(page)).authored).toBe(true);
}

async function openRigBuilder(page) {
  await button(page, 'Rig builder').click();
  const drawer = page.locator('aside[aria-label="Rig Builder"]');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function download(page, label) {
  const files = await openFiles(page);
  const transfer = page.waitForEvent('download');
  await button(files, label).click();
  const file = await transfer;
  await button(files, 'Close Show files').click();
  return file;
}

async function exportedShow(page) {
  const file = await download(page, 'Save show JSON');
  return JSON.parse(await readFile(await file.path(), 'utf8'));
}

const authoredScene = ({ rig, stage, crowd, cues, activeCueId, interchange }) => ({
  rig, stage, crowd, cues, activeCueId, interchange,
});

const dmxAudit = page => page.evaluate(() => window.venueDmxAudit);
const armedClaim = { type: 'claim', kind: 'armed' };
const armedRelease = { type: 'release', kind: 'armed' };

async function mockOutput(page) {
  await page.addInitScript(() => {
    const audit = { commands: [], claims: [], frames: 0 };
    window.venueDmxAudit = audit;
    window.stageforgeDesktop = {
      onRigCommand: () => () => {},
      onDmxStatus: () => () => {},
      dmxControl: async ({ type }) => {
        audit.commands.push(type);
        if (type === 'listInterfaces') {
          return [{ name: 'Loopback', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: null, internal: true }];
        }
        return {
          enabled: false, state: 'idle', protocol: 'sacn', iface: '127.0.0.1', rateHz: 40,
          measuredHz: 0, packetsSent: 0, degraded: false, lastError: null, universes: [1, 2], nodes: [],
        };
      },
      outputClaim: async (request) => {
        audit.claims.push(request);
        return { ok: true, reason: null };
      },
      sendDmxFrame: () => { audit.frames++; return true; },
      sendDmxHeartbeat: () => true,
    };
  });
}

async function armMockOutput(page) {
  await button(page, 'DMX monitor').click();
  await page.getByTestId('dmx-advanced-summary').click();
  await page.getByTestId('dmx-open-preflight').click();
  const panel = page.getByTestId('preflight-panel');
  await panel.getByTestId('preflight-run-check').click();
  for (const acknowledgement of await panel.locator('[data-testid^="preflight-ack-"]').all()) {
    await acknowledgement.check();
  }
  for (const inhibit of await panel.locator('[data-testid^="preflight-laser-inhibit-"]').all()) {
    await inhibit.check();
  }
  await expect(panel.getByTestId('preflight-eligibility')).toContainText('Eligible to arm');
  await button(panel, 'Done').click();
  await page.getByTestId('dmx-output-arm').click();
  await expect(page.getByTestId('dmx-output-go-live')).toBeEnabled();
  expect((await dmxAudit(page)).claims).toEqual([armedClaim]);
}

test('the Club venue rejection preserves the Steamboat Willie desk, saved rig and mocked output claim', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockOutput(page);
  await page.goto('/?probe');
  await openFilm(page);

  let drawer = await openRigBuilder(page);
  await button(drawer, 'Add secondary LED screen').click();
  await button(drawer, 'Close Rig Builder').click();
  await button(page, 'Show cues').click();
  await button(page, 'Edit cue list').click();
  const cueEditor = page.getByRole('dialog', { name: 'Edit cue list' });
  await button(cueEditor, 'Add current look').click();
  await cueEditor.getByLabel('Cue name').fill('Venue check');
  await button(cueEditor, 'Apply cues').click();
  const cueList = page.getByRole('list', { name: 'Numbered cue list', exact: true });
  await button(cueList, 'Cue 1, Venue check, fade 0 seconds, manual follow').click();

  // Give the rejection real native stage, cue and interchange data to preserve.
  await download(page, 'Rig for consoles and visualizers MVR');
  const before = authoredScene(await exportedShow(page));
  expect(before.stage.walls.some(wall => wall.id !== 'main-led')).toBe(true);
  expect(before.activeCueId).toBe(before.cues[0].id);
  expect(before.crowd.placements).toHaveLength(14);
  expect(before.interchange.mvr).toBeDefined();
  const beforeRig = await rig(page);
  const beforeSaved = await savedRig(page);
  expect(beforeSaved.venue).toBe('arena');

  await armMockOutput(page);
  drawer = await openRigBuilder(page);
  const arena = button(drawer, 'arena');
  const club = button(drawer, 'club');
  await expect(arena).toHaveClass(/border-cyan-400/);
  await club.click();
  await expect(page.getByRole('status').filter({ hasText: /authored crowd does not fit/i }))
    .toContainText('Edit crowd placements and zones in the stage plan');
  await expect(arena).toHaveClass(/border-cyan-400/);
  await expect(club).not.toHaveClass(/border-cyan-400/);
  expect(await rig(page)).toEqual(beforeRig);
  expect(await savedRig(page)).toEqual(beforeSaved);
  await button(drawer, 'Close Rig Builder').click();
  await expect(page.getByTestId('dmx-output-go-live')).toBeEnabled();
  expect(await dmxAudit(page)).toMatchObject({ claims: [armedClaim], frames: 0 });
  expect((await dmxAudit(page)).commands).not.toContain('enable');
  expect(authoredScene(await exportedShow(page))).toEqual(before);
  expect(await savedRig(page)).toEqual(beforeSaved);

  // The same authored crowd fits the wider Festival bounds. A successful edit still disarms.
  drawer = await openRigBuilder(page);
  await expect(page.getByTestId('dmx-output-go-live')).toBeEnabled();
  expect((await dmxAudit(page)).claims).toEqual([armedClaim]);
  await button(drawer, 'festival').click();
  await expect(button(drawer, 'festival')).toHaveClass(/border-cyan-400/);
  await expect.poll(async () => (await savedRig(page)).venue).toBe('festival');
  await expect.poll(async () => (await dmxAudit(page)).claims).toEqual([armedClaim, armedRelease]);
  await expect(page.getByTestId('dmx-output-go-live')).toHaveCount(0);
  const afterFestival = await dmxAudit(page);
  expect(afterFestival.frames).toBe(0);
  expect(afterFestival.commands).not.toContain('enable');
  await button(page, 'Close DMX monitor').click();
  await button(drawer, 'Close Rig Builder').click();
  expect(authoredScene(await exportedShow(page))).toEqual({ ...before, rig: { ...before.rig, venue: 'festival' } });

  drawer = await openRigBuilder(page);
  const confirmations = [];
  page.once('dialog', async dialog => {
    confirmations.push(dialog.message());
    await dialog.accept();
  });
  await drawer.getByRole('button', { name: /Club Stage \(300 Cap\)/ }).click();
  expect(confirmations[0]).toContain('the authored crowd');
  await expect.poll(async () => (await rig(page)).venue).toBe('club');
  await expect.poll(async () => (await crowd(page)).authored).toBe(false);
  await button(drawer, 'Close Rig Builder').click();
  const replaced = await exportedShow(page);
  expect(replaced.crowd).toBeUndefined();
  expect(replaced.stage).toBeUndefined();
  expect(replaced.interchange).toBeUndefined();
  expect(replaced.cues).toEqual(before.cues);
  expect(errors).toEqual([]);
});

test('an ordinary venue change works without an authored crowd', async ({ page }) => {
  await page.goto('/?probe');
  const drawer = await openRigBuilder(page);
  const initial = await rig(page);
  expect((await crowd(page)).authored).toBe(false);
  await button(drawer, 'club').click();
  await expect(button(drawer, 'club')).toHaveClass(/border-cyan-400/);
  await expect.poll(async () => (await savedRig(page))?.venue).toBe('club');
  expect(await rig(page)).toMatchObject({ ...initial, venue: 'club' });
  expect((await crowd(page)).authored).toBe(false);
});

test('Stage Designer holds an incompatible crowd draft open and applies a compatible platform envelope', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?probe');
  await openFilm(page);
  const before = await savedRig(page);
  const beforeCrowd = await crowd(page);
  await button(page, 'Design stage').click();
  const designer = page.getByRole('dialog', { name: 'Stage designer' });
  await designer.getByLabel('Plan objects').selectOption('p:main-deck');
  const depth = designer.getByLabel('Depth', { exact: true });
  await depth.fill('20');
  await depth.press('Enter');
  await button(designer, 'Apply design').click();
  await expect(designer.getByRole('status').filter({ hasText: /crowd\./i })).toContainText(/outside the venue audience bounds/i);
  await expect(depth).toHaveValue('20');
  expect(await savedRig(page)).toEqual(before);
  expect((await rig(page)).stageDepth).toBe(11);
  expect((await crowd(page)).transforms).toEqual(beforeCrowd.transforms);

  await depth.fill('12');
  await depth.press('Enter');
  await button(designer, 'Apply design').click();
  await expect(designer).toBeHidden();
  const applied = await rig(page);
  expect(applied.stageDepth).toBe(12);
  expect(applied.platforms).toMatchObject([{ id: 'main-deck', depth: 12 }]);
  expect(await savedRig(page)).toEqual(applied);
  expect((await exportedShow(page)).crowd.placements).toHaveLength(14);
  expect(errors).toEqual([]);
});
