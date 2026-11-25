import { expect, test } from '@playwright/test';

/**
 * Build a 120 BPM click + tone PCM WAV (16-bit mono, 22050 Hz to keep memory tiny).
 * 16 bars at 120 BPM = 32 seconds (4 sections x 4 bars = 8 s each).
 */
function buildDemoTrackWav(durationSec = 32, bpm = 120, sampleRate = 22050) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  const beatSec = 60 / bpm;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beatPhase = t % beatSec;
    const click = beatPhase < 0.03 ? Math.sin(2 * Math.PI * 880 * t) * (1 - beatPhase / 0.03) * 0.45 : 0;
    const pad = Math.sin(2 * Math.PI * 110 * t) * 0.2;
    const clamped = Math.max(-1, Math.min(1, click + pad));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

const TEST_TRACK_MAP = {
  format: 'stageforge-demo-track',
  version: 1,
  title: 'Test House Blues',
  file: 'test-demo.wav',
  bpm: 120,
  firstDownbeatMs: 0,
  sections: [
    { role: 'intro', label: 'Opening pad', bars: 4 },
    { role: 'groove', label: 'Deep pocket', bars: 4 },
    { role: 'build', label: 'Riser', bars: 4 },
    { role: 'drop', label: 'Blues drop', bars: 4 },
  ],
};

test('demo track is lazy-loaded, drives lighting through its section map on seek, pauses/resumes/replays cleanly, and fits 390px phones', async ({ page }) => {
  const wav = buildDemoTrackWav(32, 120);
  let mapRequests = 0;
  let audioRequests = 0;

  await page.route('**/demo/track.json', async (route) => {
    mapRequests++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(TEST_TRACK_MAP),
    });
  });

  await page.route('**/demo/test-demo.wav', async (route) => {
    audioRequests++;
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'content-length': String(wav.byteLength) },
      body: wav,
    });
  });

  await page.goto('/?probe');
  // Wait for idle discovery of demo/track.json -> "Play demo track" button appears.
  const playTrackBtn = page.getByRole('button', { name: 'Play demo track', exact: true });
  await expect(playTrackBtn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Play demo', exact: true })).toBeVisible();

  // First load must fetch track.json but MUST NOT fetch the audio file.
  expect(mapRequests).toBe(1);
  expect(audioRequests).toBe(0);

  // Check 390x844 phone viewport keeps zero horizontal overflow and Play demo track sits inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(phoneOverflow).toBeLessThanOrEqual(1);
  const phoneBtnBox = await playTrackBtn.boundingBox();
  expect(phoneBtnBox).not.toBeNull();
  expect(phoneBtnBox.x).toBeGreaterThanOrEqual(0);
  expect(phoneBtnBox.x + phoneBtnBox.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Clicking "Play demo track" fetches the audio once and starts playback.
  await playTrackBtn.click();
  await expect.poll(() => audioRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(0.05);

  // Authoritative beat grid is populated immediately (120.0 BPM, 0 ms) and tempo controls are locked.
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await expect(page.getByText('120.0 BPM · 0 ms')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Increase tempo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next section', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Seek half a bar past each section boundary (at 120 BPM: 1 bar = 2 s, 4 bars = 8 s -> 1, 9, 17, 25 s)
  // and verify both demoPosition AND actual lighting look colors/movement change at each boundary.
  const expectedSections = [
    { sec: 1.0, role: 'intro', label: 'Opening pad', primaryColor: '#ffae66', movementMode: 'fan' },
    { sec: 9.0, role: 'groove', label: 'Deep pocket', primaryColor: '#ffae66', movementMode: 'sweep' },
    { sec: 17.0, role: 'build', label: 'Riser', primaryColor: '#fdab55', movementMode: 'wave' },
    { sec: 25.0, role: 'drop', label: 'Blues drop', primaryColor: '#13c7fe', movementMode: 'flyout' },
  ];
  for (const target of expectedSections) {
    await page.evaluate((sec) => window.stageforgeProbe.seekTrack(sec), target.sec);
    await expect.poll(() => page.evaluate(() => {
      const p = window.stageforgeProbe.demoPosition();
      const s = window.stageforgeProbe.showStateSummary();
      return p ? { role: p.sectionId, label: p.label, totalBars: p.totalBars, primaryColor: s.primaryColor, movementMode: s.movementMode } : null;
    })).toEqual({
      role: target.role,
      label: target.label,
      totalBars: 16,
      primaryColor: target.primaryColor,
      movementMode: target.movementMode,
    });
  }
  await expect(page.locator('.demo-progress')).toContainText('Blues drop');
  await expect(page.locator('.demo-progress')).toContainText('/ 16');

  // On the last section (drop), Next section is disabled.
  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next section', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Prev section jump moves cleanly from drop (index 3) back to build (index 2).
  await page.evaluate(() => window.stageforgeProbe.jumpDemoSection(-1));
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoPosition()?.sectionId)).toBe('build');

  // Pause holds playback position; resume advances from that held position.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play track', exact: true })).toBeVisible();
  const pausedAt = await page.evaluate(() => window.stageforgeProbe.audioPlaybackTime());
  await page.waitForTimeout(350);
  const stillPausedAt = await page.evaluate(() => window.stageforgeProbe.audioPlaybackTime());
  expect(Math.abs(stillPausedAt - pausedAt)).toBeLessThan(0.05);

  await page.getByRole('button', { name: 'Play track', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(pausedAt + 0.15);

  // Seek right before the end so the track ends naturally -> "Replay track" appears and restarts from 0.
  await page.evaluate(() => window.stageforgeProbe.seekTrack(31.85));
  const replayBtn = page.getByRole('button', { name: 'Replay track', exact: true });
  await expect(replayBtn).toBeVisible({ timeout: 5_000 });
  await replayBtn.click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoPosition()?.sectionId)).toBe('intro');
});

test('firstDownbeatMs > 0 holds count-in blackout, and switching to synth mid-fetch aborts the slow demo track load', async ({ page }) => {
  const wav = buildDemoTrackWav(26, 120);
  let releaseAudio;
  const audioGate = new Promise((resolve) => { releaseAudio = resolve; });
  let audioRequests = 0;

  await page.route('**/demo/track.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        ...TEST_TRACK_MAP,
        firstDownbeatMs: 2000,
        sections: [
          { role: 'groove', label: 'Groove after count-in', bars: 4 },
          { role: 'build', label: 'Build', bars: 4 },
          { role: 'drop', label: 'Drop', bars: 4 },
        ],
      }),
    });
  });

  await page.route('**/demo/test-demo.wav', async (route) => {
    audioRequests++;
    await audioGate;
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'content-length': String(wav.byteLength) },
      body: wav,
    });
  });

  await page.goto('/?probe');
  const playTrackBtn = page.getByRole('button', { name: 'Play demo track', exact: true });
  await expect(playTrackBtn).toBeVisible({ timeout: 10_000 });

  // Start slow track fetch, then immediately switch to synth ("Play demo") before fetch resolves (M2 regression).
  await playTrackBtn.click();
  await expect.poll(() => audioRequests).toBe(1);
  await page.getByRole('button', { name: 'Play demo', exact: true }).click();
  releaseAudio();
  await page.waitForTimeout(300);
  // Synth must remain active (64-bar default demo) — slow track fetch must NOT hijack it.
  expect(await page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars)).toBe(64);

  // Now click "Play demo track" cleanly (audioGate already resolved) -> count-in holds opening blackout before 2000 ms.
  await playTrackBtn.click();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars)).toBe(12);
  await page.evaluate(() => window.stageforgeProbe.seekTrack(0.5));
  await expect.poll(() => page.evaluate(() => {
    const p = window.stageforgeProbe.demoPosition();
    const s = window.stageforgeProbe.showStateSummary();
    return { beforeDownbeat: !!p?.beforeDownbeat, beamIntensity: s.beamIntensity };
  })).toEqual({ beforeDownbeat: true, beamIntensity: 0 });
  await expect(page.getByText('Opening blackout · Count-in')).toBeVisible();

  // Seek past firstDownbeatMs (2000 ms -> 3.0 s) -> groove lighting engages immediately.
  await page.evaluate(() => window.stageforgeProbe.seekTrack(3.0));
  await expect.poll(() => page.evaluate(() => {
    const p = window.stageforgeProbe.demoPosition();
    const s = window.stageforgeProbe.showStateSummary();
    return { beforeDownbeat: !!p?.beforeDownbeat, role: p?.sectionId, lit: s.beamIntensity > 0.2 };
  })).toEqual({ beforeDownbeat: false, role: 'groove', lit: true });
});

test('when no demo track map exists (HTML fallback), Play demo track is absent and no audio is fetched', async ({ page }) => {
  let audioRequests = 0;
  await page.route('**/demo/track.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' });
  });
  await page.route('**/demo/*.{mp3,wav,m4a,ogg}', async (route) => {
    audioRequests++;
    await route.abort();
  });

  await page.goto('/?probe');
  await expect(page.getByRole('button', { name: 'Play demo', exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.getByRole('button', { name: 'Play demo track', exact: true })).toHaveCount(0);
  expect(audioRequests).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.demoTrackAvailable())).toBeNull();
});

test('shipped public/demo/track.mp3 is lazy-loaded (0 audio requests on boot), fits 390px and 393px phones, and plays through real sections', async ({ page }) => {
  const mp3Requests = [];
  page.on('request', (req) => {
    if (req.url().includes('/demo/track.mp3')) mp3Requests.push(req.url());
  });

  await page.goto('/?probe');
  const playTrackBtn = page.getByRole('button', { name: 'Play demo track', exact: true });
  await expect(playTrackBtn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Play demo', exact: true })).toBeVisible();

  // Verify the real map metadata loaded from public/demo/track.json and ZERO MP3 requests occurred while idle.
  const available = await page.evaluate(() => window.stageforgeProbe.demoTrackAvailable());
  expect(available).toMatchObject({
    title: 'StageForge demo track',
    file: 'track.mp3',
    bpm: 122,
    firstDownbeatMs: 96,
  });
  expect(available.sections).toHaveLength(11);
  expect(available.timeline.totalBars).toBe(158);
  await page.waitForTimeout(1500);
  expect(mp3Requests).toHaveLength(0);

  // Verify phone layouts (390x844 and 393x852) have zero horizontal overflow with Play demo track visible.
  for (const vp of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
    await page.setViewportSize(vp);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const box = await playTrackBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Clicking "Play demo track" fetches track.mp3 once, locks the beat grid to 122 BPM / 96 ms, and starts playback.
  await playTrackBtn.click();
  await expect.poll(() => mp3Requests.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime()), { timeout: 15_000 }).toBeGreaterThan(0.05);

  await page.getByRole('button', { name: 'Audio settings', exact: true }).click();
  await expect(page.getByText('122.0 BPM · 96 ms')).toBeVisible();
  await page.keyboard.press('Escape');

  // Verify measured bar boundaries on the real MP3: Kick enters (~31.6 s) and Breakdown (~212.6 s).
  await page.evaluate(() => window.stageforgeProbe.seekTrack(32.5));
  await expect.poll(() => page.evaluate(() => {
    const p = window.stageforgeProbe.demoPosition();
    return p ? { role: p.sectionId, label: p.label, totalBars: p.totalBars } : null;
  })).toEqual({ role: 'drop', label: 'Kick enters', totalBars: 158 });

  await page.evaluate(() => window.stageforgeProbe.seekTrack(213.5));
  await expect.poll(() => page.evaluate(() => {
    const p = window.stageforgeProbe.demoPosition();
    return p ? { role: p.sectionId, label: p.label } : null;
  })).toEqual({ role: 'breakdown', label: 'Breakdown' });

  // Seek near the end of the 309.6 s audio so the ended event finishes playback cleanly despite the 1.32 s map margin.
  await page.evaluate(() => window.stageforgeProbe.seekTrack(309.1));
  await expect(page.getByRole('button', { name: 'Replay track', exact: true })).toBeVisible({ timeout: 8_000 });
});
