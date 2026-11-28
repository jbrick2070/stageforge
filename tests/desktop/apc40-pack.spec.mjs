import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installApcMidiMock } from '../support/apc40-midi.mjs';
import { dragApcFaderTo } from '../support/apc40-surface.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const staged = path.join(root, 'desktop', 'build', 'app');
const installed = process.env.STAGEFORGE_APC_DESKTOP_EXE;
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

test('APC40 packaged rehearsal uses selected mocked MIDI, handles denial and disconnect, and never starts output', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'stageforge-apc40-'));
  const config = '--user-data-dir=' + path.join(temp, 'profile');
  let app;
  try {
    app = await electron.launch({
      executablePath: installed ? path.resolve(installed) : require('electron'),
      args: installed ? [config] : [staged, config], timeout: 20_000,
    });
    if (installed) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await app.firstWindow({ timeout: 12_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900));
    page.setDefaultTimeout(12_000);
    await page.addInitScript(installApcMidiMock);
    await page.goto('stageforge://app/?probe', { waitUntil: 'domcontentloaded' });
    await button(page, 'Show files').click();
    const files = page.getByRole('dialog', { name: 'Show files' });
    await button(files, 'Open Deep House rehearsal').click();
    await expect(files).toBeHidden();
    const desk = page.getByRole('complementary', { name: 'APC40 mkII Deep House performance' });
    await expect(desk.getByRole('heading', { name: 'Deep House', exact: true })).toBeVisible();
    const beam = desk.getByRole('slider', { name: 'Beam level', exact: true });
    await expect.poll(() => beam.evaluate(element => getComputedStyle(element).writingMode)).toBe('vertical-lr');
    await beam.press('Home');
    await expect(beam).toHaveValue('0');
    await beam.press('ArrowUp');
    await expect(beam).toHaveValue('0.01');
    await beam.press('ArrowDown');
    await expect(beam).toHaveValue('0');
    await beam.press('End');
    await expect(beam).toHaveValue('1');
    await dragApcFaderTo(page, beam, 'bottom');
    await expect(beam).toHaveValue('0');
    await dragApcFaderTo(page, beam, 'top');
    await expect(beam).toHaveValue('1');
    expect(await page.evaluate(() => window.apcTest.calls)).toEqual([]);
    const syncBefore = await page.evaluate(() => window.stageforgeProbe.showControlActive());
    await desk.getByText('APC40 mkII MIDI connection', { exact: true }).click();
    await page.evaluate(() => { window.apcTest.deny = true; });
    await button(desk, 'Enable MIDI access').click();
    await expect(desk.getByText(/MIDI SysEx access was denied/)).toBeVisible();
    await expect(button(desk, 'Lighting color Red')).toBeEnabled();
    await page.evaluate(() => { window.apcTest.deny = false; });
    await button(desk, 'Enable MIDI access').click();
    await desk.getByRole('combobox', { name: 'APC40 MIDI input' }).selectOption('in-a');
    await desk.getByRole('combobox', { name: 'APC40 MIDI output' }).selectOption('out-a');
    await button(desk, 'Connect APC40 mkII').click();
    await expect(desk.getByText('APC40 mkII ready', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.apcTest.calls.filter(([type]) => type === 'send').length)).toBe(47);
    const before = await page.evaluate(() => window.apcTest.calls);
    expect(before.filter(([type]) => type === 'open')).toEqual([['open', 'in-a'], ['open', 'out-a']]);
    expect(before.filter(([type]) => type === 'send').slice(0, 3)).toEqual([
      ['send', 'out-a', [0xf0, 0x7e, 0x7f, 6, 1, 0xf7]],
      ['send', 'out-a', [0xf0, 0x47, 0x7f, 0x29, 0x60, 0, 4, 0x42, 1, 0, 0, 0xf7]],
      ['send', 'out-a', [0x90, 32, 5]],
    ]);
    const layout = button(desk, 'Compact view');
    await layout.click();
    await expect(beam).toHaveValue('1');
    await layout.click();
    await expect(beam).toHaveValue('1');
    await expect(desk.getByText('APC40 mkII ready', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.apcTest.calls)).toEqual(before);
    await page.evaluate(() => window.apcTest.emit([0x90, 32, 127]));
    await expect(button(desk, 'Lighting color Red')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.apcTest.addDuplicate());
    await expect(desk.getByText(/APC40 mkII disconnected/)).toBeVisible();
    await button(desk, 'Connect APC40 mkII').click();
    await expect(desk.getByText(/matching, unambiguous APC40/)).toBeVisible();
    await page.evaluate(() => window.apcTest.emit([0x90, 0x51, 127]));
    expect(await page.evaluate(() => window.stageforgeProbe.showStateSummary().operatorBlackout)).toBe(false);
    expect(await page.evaluate(() => window.stageforgeProbe.showControlActive())).toBe(syncBefore);
    expect(await page.evaluate(() => window.stageforgeDesktop.dmxControl({ type: 'getStatus' }).then(status => status.enabled))).toBe(false);
    const output = await page.evaluate(() => window.stageforgeProbe.physicalDmxSnapshot());
    expect([...output.u1, ...output.u2].every(byte => byte === 0)).toBe(true);
  } finally {
    await app?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
