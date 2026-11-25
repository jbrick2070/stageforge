import { expect, test } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

async function openPaperwork(page) {
  await page.getByRole('button', { name: 'Gear, cost and crew', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gear & production' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /Paperwork/ }).click();
  const panel = dialog.getByRole('tabpanel', { name: /Paperwork/ });
  await expect(panel).toBeVisible();
  return { dialog, panel };
}

function parsePdfSummary(buffer) {
  const text = buffer.toString('latin1');
  const headerOk = text.startsWith('%PDF-');
  const mediaMatch = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const mediaBox = mediaMatch ? mediaMatch.slice(1).map(Number) : null;
  const pageMatches = text.match(/\/Type\s*\/Page\b(?!s)/g) ?? [];
  return { headerOk, mediaBox, pageCount: pageMatches.length, bytes: buffer.length };
}

test('Plot plan prints first at true scale (A4 & Letter), matches Patch Sheet addresses, and exports valid PDF', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls++;
    };
  });

  await page.goto('/?probe=1');
  const { panel } = await openPaperwork(page);

  // Sample 5 fixture numbers and their DMX labels directly from the Patch Sheet DOM.
  const patchSamples = await panel.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const picks = [0, 1, 5, 15, rows.length - 1].filter((i) => i >= 0 && i < rows.length);
    return picks.map((idx) => {
      const cells = rows[idx].querySelectorAll('td');
      const dmxRange = cells[0].textContent.trim();
      const dmxStart = dmxRange.match(/U\d+\.\d{3}/)?.[0] ?? dmxRange;
      const fixNum = Number(cells[2].textContent.replace(/[^\d]/g, ''));
      return { fixNum, dmxStart };
    });
  });
  expect(patchSamples.length).toBe(5);

  // Edit title-block fields (persisted in localStorage under stageforge.titleBlock).
  await panel.getByTestId('plot-settings').locator('summary').click();
  await panel.getByRole('textbox', { name: 'Title block venue' }).fill('O2 Arena London');
  await panel.getByRole('textbox', { name: 'Title block designer' }).fill('A. Electrician');
  await panel.getByRole('textbox', { name: 'Title block revision' }).fill('B');
  const savedTb = await page.evaluate(() => JSON.parse(localStorage.getItem('stageforge.titleBlock') || 'null'));
  expect(savedTb).toMatchObject({
    paper: 'a4',
    venue: 'O2 Arena London',
    designer: 'A. Electrician',
    revision: 'B',
  });

  // Preview the Plot plan radio and verify Export CSV is disabled on Plot plan.
  await panel.getByRole('radio', { name: /Plot plan/ }).click({ force: true });
  await expect(panel.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  await expect(panel.locator('.plot-preview [data-testid="plot-title-venue"]')).toHaveText('O2 Arena London');
  await expect(panel.locator('.plot-preview [data-testid="plot-title-revision"]')).toHaveText('B');

  // Trigger Print full book and inspect under print media.
  await panel.getByRole('button', { name: 'Print full book' }).click();
  expect(await page.evaluate(() => window.__printCalls)).toBe(1);

  await page.emulateMedia({ media: 'print' });

  const a4Metrics = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.print-sheet .print-section'));
    const first = sections[0];
    const outerSvg = first.querySelector('[data-testid="plot-plan-svg"]');
    const metresSvg = first.querySelector('[data-testid="plot-plan-metres"]');
    const tick10 = first.querySelector('[data-scalebar-tick="10"]');
    const pageRect = first.getBoundingClientRect();
    const outerRect = outerSvg.getBoundingClientRect();
    const metresRect = metresSvg.getBoundingClientRect();
    const tick10Rect = tick10 ? tick10.getBoundingClientRect() : null;

    const pxToMm = 25.4 / 96;
    const scale = Number(metresSvg.getAttribute('data-scale'));
    // Read actual SVG viewBox width in metres directly from the DOM SVGAnimatedRect (not a data attribute).
    const vbWidthM = metresSvg.viewBox.baseVal.width;
    const sheetHeaders = sections.map((s, idx) =>
      idx === 0
        ? s.querySelector('[data-testid="plot-title-sheet"]')?.textContent?.trim() ?? ''
        : s.querySelector('.print-meta')?.textContent?.trim() ?? '',
    );

    const fixtures = Array.from(first.querySelectorAll('[data-plot-fixture]'));
    const fixtureMap = {};
    let outOfBounds = 0;
    for (const el of fixtures) {
      const num = Number(el.getAttribute('data-fixture-number'));
      fixtureMap[num] = el.getAttribute('data-dmx-label');
      const r = el.getBoundingClientRect();
      if (
        r.left < pageRect.left - 1 ||
        r.right > pageRect.right + 1 ||
        r.top < pageRect.top - 1 ||
        r.bottom > pageRect.bottom + 1
      ) {
        outOfBounds++;
      }
    }

    return {
      firstSectionId: first.getAttribute('data-paperwork-section'),
      paper: first.getAttribute('data-paper'),
      sheetText: first.querySelector('[data-testid="plot-title-sheet"]')?.textContent?.trim(),
      sheetHeaders,
      downstageText: first.querySelector('[data-testid="plot-downstage-label"]')?.textContent?.trim(),
      disclaimerText: first.querySelector('[data-testid="plot-title-disclaimer"]')?.textContent?.trim(),
      scale,
      vbWidthM,
      outerWidthMm: outerRect.width * pxToMm,
      metresWidthMm: metresRect.width * pxToMm,
      expectedMetresWidthMm: (vbWidthM * 1000) / scale,
      tick10WidthMm: tick10Rect ? tick10Rect.width * pxToMm : null,
      expectedTick10Mm: 10000 / scale,
      fixtureCount: fixtures.length,
      outOfBounds,
      fixtureMap,
    };
  });

  expect(a4Metrics.firstSectionId).toBe('plot');
  expect(a4Metrics.paper).toBe('a4');
  expect(a4Metrics.sheetText).toBe('Sheet 1 of 7');
  // L2 regression: every one of the 7 sheets in book mode carries its "Sheet k of 7" label.
  for (let i = 0; i < 7; i++) {
    expect(a4Metrics.sheetHeaders[i]).toContain(`Sheet ${i + 1} of 7`);
  }
  expect(a4Metrics.downstageText).toContain('DOWNSTAGE / AUDIENCE');
  expect(a4Metrics.disclaimerText).toContain('Design guidance: not for construction');
  expect(Math.abs(a4Metrics.outerWidthMm - 276)).toBeLessThan(1.0);
  // True scale assertion: SVG metres width in mm matches viewBox extent / scale.
  expect(Math.abs(a4Metrics.metresWidthMm - a4Metrics.expectedMetresWidthMm)).toBeLessThan(0.5);
  // Scale bar assertion: 10 m tick measures 10000 / scale mm on paper.
  expect(a4Metrics.tick10WidthMm).not.toBeNull();
  expect(Math.abs(a4Metrics.tick10WidthMm - a4Metrics.expectedTick10Mm)).toBeLessThan(0.5);
  // Every fixture bounding box lies inside the page.
  expect(a4Metrics.fixtureCount).toBeGreaterThan(20);
  expect(a4Metrics.outOfBounds).toBe(0);

  // All 5 sampled fixture numbers match the Patch Sheet DMX addresses.
  for (const sample of patchSamples) {
    expect(a4Metrics.fixtureMap[sample.fixNum]).toBe(sample.dmxStart);
  }

  // Generate a real A4 landscape PDF via Chromium print engine.
  const a4Pdf = await page.pdf({
    format: 'A4',
    landscape: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    preferCSSPageSize: true,
  });
  const a4Summary = parsePdfSummary(a4Pdf);
  expect(a4Summary.headerOk).toBe(true);
  expect(a4Summary.bytes).toBeGreaterThan(5000);
  expect(a4Summary.pageCount).toBeGreaterThanOrEqual(6);
  expect(a4Summary.mediaBox).not.toBeNull();
  // A4 landscape is ~841.9 x 595.3 pt.
  expect(Math.abs(a4Summary.mediaBox[2] - 841.9)).toBeLessThan(3);
  expect(Math.abs(a4Summary.mediaBox[3] - 595.3)).toBeLessThan(3);

  // Switch back to screen, change paper size to Letter, and verify page size changes.
  await page.emulateMedia({ media: 'screen' });
  await panel.getByRole('combobox', { name: 'Plot paper size' }).selectOption('letter');
  await panel.getByRole('button', { name: 'Print full book' }).click();
  await page.emulateMedia({ media: 'print' });

  const letterMetrics = await page.evaluate(() => {
    const first = document.querySelector('.print-sheet .print-section');
    const outerSvg = first.querySelector('[data-testid="plot-plan-svg"]');
    const metresSvg = first.querySelector('[data-testid="plot-plan-metres"]');
    const pxToMm = 25.4 / 96;
    const scale = Number(metresSvg.getAttribute('data-scale'));
    // Read actual SVG viewBox width in metres directly from the DOM SVGAnimatedRect (not a data attribute).
    const vbWidthM = metresSvg.viewBox.baseVal.width;
    return {
      paper: first.getAttribute('data-paper'),
      outerWidthMm: outerSvg.getBoundingClientRect().width * pxToMm,
      metresWidthMm: metresSvg.getBoundingClientRect().width * pxToMm,
      expectedMetresWidthMm: (vbWidthM * 1000) / scale,
    };
  });
  expect(letterMetrics.paper).toBe('letter');
  expect(Math.abs(letterMetrics.outerWidthMm - 258)).toBeLessThan(1.0);
  expect(letterMetrics.outerWidthMm).toBeLessThan(a4Metrics.outerWidthMm - 10);
  expect(Math.abs(letterMetrics.metresWidthMm - letterMetrics.expectedMetresWidthMm)).toBeLessThan(0.5);

  const letterPdf = await page.pdf({
    format: 'Letter',
    landscape: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    preferCSSPageSize: true,
  });
  const letterSummary = parsePdfSummary(letterPdf);
  expect(letterSummary.headerOk).toBe(true);
  expect(letterSummary.mediaBox).not.toBeNull();
  // Letter landscape is 792 x 612 pt.
  expect(Math.abs(letterSummary.mediaBox[2] - 792)).toBeLessThan(3);
  expect(Math.abs(letterSummary.mediaBox[3] - 612)).toBeLessThan(3);

  await page.emulateMedia({ media: 'screen' });
  expect(errors).toEqual([]);
});

test('phone 390x844 layout: Plot plan preview and title block controls have zero horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/?probe=1');
  const { panel } = await openPaperwork(page);

  await panel.getByRole('radio', { name: /Plot/ }).click({ force: true });
  await expect(panel.locator('.plot-preview [data-testid="plot-plan-svg"]')).toBeVisible();
  await panel.getByTestId('plot-settings').locator('summary').click();

  const overflow = await page.evaluate(() => {
    const dlg = document.querySelector('.gear-modal');
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      modalOverflow: dlg ? dlg.scrollWidth - dlg.clientWidth : 0,
    };
  });
  expect(overflow.docOverflow).toBeLessThanOrEqual(0);
  expect(overflow.modalOverflow).toBeLessThanOrEqual(0);
});
