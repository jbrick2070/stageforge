export async function playSynthDemo(page) {
  const audio = page.getByRole('button', { name: 'Audio settings', exact: true });
  if (await audio.getAttribute('aria-expanded') !== 'true') await audio.press('Enter');
  await page.getByRole('button', { name: /^(Play|Restart) synth demo$/ }).press('Enter');
}
