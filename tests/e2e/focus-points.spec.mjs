// Focus points keep a designed look on its target while the stage is re-hung or re-blocked.
import { expect, test } from '@playwright/test';

const ON_TARGET = 0.15; // metres between a beam's axis and its focus point
const BEAM_COUNT = 8;

/** A small club stage: deck, drum riser and thrust under a bent upstage truss of 4 beams + 4 washes. */
async function seedClubStage(page) {
  await page.goto('/?probe');
  await page.evaluate(async () => {
    const { createBlankDesign, makeTrussPath, withPlatforms } = await import('/src/data/stageDesign.ts');
    const design = withPlatforms({ ...createBlankDesign(), name: 'Club test' }, [
      { id: 'deck', name: 'Main deck', x: 0, z: -1, width: 8, depth: 4, height: 1 },
      { id: 'riser', name: 'Drum riser', x: 0, z: -2, width: 3, depth: 2, height: 1.5 },
      { id: 'thrust', name: 'Thrust', x: 0, z: 3, width: 2, depth: 4, height: 1 },
    ]);
    const bend = [{ x: -5, z: -2 }, { x: -3, z: -4 }, { x: 3, z: -4 }, { x: 5, z: -2 }];
    const truss = {
      ...makeTrussPath(bend, 5),
      name: 'Bent truss',
      fixtures: [
        { id: 'beams', type: 'beam', modelName: 'Sharpy X-Beam 350', count: 4, dmxUniverse: 1, dmxStartChannel: 1 },
        { id: 'washes', type: 'wash', modelName: 'MAC Aura Pro RGBW', count: 4, dmxUniverse: 1, dmxStartChannel: 101 },
      ],
    };
    localStorage.setItem('stageforge.design.v1', JSON.stringify({ ...design, trussPods: [truss] }));
  });
  await page.reload();
  await page.waitForFunction((n) => window.stageforgeProbe?.beamAxes().length === n, BEAM_COUNT);
}

/** Largest perpendicular distance from any beam axis to the point (huge if a beam points away from it). */
function worstMiss(page, point) {
  return page.evaluate((p) => {
    const misses = window.stageforgeProbe.beamAxes().map(({ origin: o, dir: d }) => {
      const v = [p.x - o[0], p.y - o[1], p.z - o[2]];
      if (v[0] * d[0] + v[1] * d[1] + v[2] * d[2] <= 0) return 1e9;
      return Math.hypot(v[1] * d[2] - v[2] * d[1], v[2] * d[0] - v[0] * d[2], v[0] * d[1] - v[1] * d[0]);
    });
    return Math.max(...misses);
  }, point);
}

const mountPositions = (page) =>
  page.evaluate(() => window.stageforgeProbe.beamAxes().map((a) => a.origin.map((n) => n.toFixed(2)).join(',')));

async function editDesign(page, objectName, edits) {
  await page.getByRole('button', { name: 'Design stage' }).click();
  const designer = page.getByRole('dialog');
  await designer.getByLabel('Plan objects').selectOption({ label: objectName });
  for (const [label, value] of edits) {
    if (label === 'Selected vertex') await designer.getByLabel(label).selectOption({ label: value });
    else {
      await designer.getByLabel(label, { exact: true }).fill(value);
      await designer.getByLabel(label, { exact: true }).press('Enter');
    }
  }
  await designer.getByRole('button', { name: 'Apply design' }).click();
  await expect(designer).toBeHidden();
}

test('heads stay on their focus point when the truss is re-shaped and follow the riser when it moves', async ({ page }) => {
  await seedClubStage(page);
  const riser = { x: 0, y: 1.5, z: -2 };

  // Raw positions don't know where the riser is.
  expect(await worstMiss(page, riser)).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Lighting', exact: true }).click();
  await page.getByRole('button', { name: 'Position', exact: true }).click();
  const focus = page.getByRole('group', { name: 'Focus point' });
  await expect(focus.getByRole('button')).toHaveText(['Free', 'Main deck', 'Drum riser', 'Thrust', 'Audience']);
  await focus.getByRole('button', { name: 'Drum riser' }).click();
  await expect(focus.getByRole('button', { name: 'Drum riser' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('OFFSET X')).toBeVisible();
  await expect.poll(() => worstMiss(page, riser), { timeout: 5000 }).toBeLessThan(ON_TARGET);

  // Drag the stage-right end of the truss downstage and wider: every mount moves, the look doesn't.
  const before = await mountPositions(page);
  await editDesign(page, 'Bent truss', [['Selected vertex', 'Vertex 4'], ['Vertex X', '6.5'], ['Vertex Z', '0']]);
  await expect.poll(() => mountPositions(page)).not.toEqual(before);
  await expect.poll(() => worstMiss(page, riser), { timeout: 5000 }).toBeLessThan(ON_TARGET);

  // Re-block the riser 2 m stage right: the focus point travels with it.
  await editDesign(page, 'Drum riser', [['Center X', '2']]);
  await expect.poll(() => worstMiss(page, { ...riser, x: 2 }), { timeout: 5000 }).toBeLessThan(ON_TARGET);
  expect(await worstMiss(page, riser)).toBeGreaterThan(0.5);

  // Another point, then an offset in metres from it (fader at 75% = +2 m of the ±4 m range).
  await focus.getByRole('button', { name: 'Thrust' }).click();
  await expect.poll(() => worstMiss(page, { x: 0, y: 1, z: 3 }), { timeout: 5000 }).toBeLessThan(ON_TARGET);
  await page.getByRole('slider', { name: 'OFFSET X' }).fill('0.75');
  await expect(page.getByText('2.0 m')).toBeVisible();
  await expect.poll(() => worstMiss(page, { x: 2, y: 1, z: 3 }), { timeout: 5000 }).toBeLessThan(ON_TARGET);

  // Free hands the rig back to raw pan/tilt.
  await focus.getByRole('button', { name: 'Free' }).click();
  await expect(page.getByText('TILT', { exact: true })).toBeVisible();
  await expect.poll(() => worstMiss(page, { x: 0, y: 1, z: 3 }), { timeout: 5000 }).toBeGreaterThan(1);
});
