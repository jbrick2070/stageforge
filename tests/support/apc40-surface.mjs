export async function dragApcFaderTo(page, slider, edge) {
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error('The APC40 fader is offscreen.');
  const x = box.x + box.width / 2;
  const bottom = box.y + box.height - 3;
  const top = box.y + 3;
  await page.mouse.move(x, edge === 'top' ? bottom : top);
  await page.mouse.down();
  await page.mouse.move(x, edge === 'top' ? top : bottom, { steps: 8 });
  await page.mouse.up();
}
