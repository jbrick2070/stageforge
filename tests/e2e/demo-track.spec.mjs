import { expect, test } from '@playwright/test';
import { playSynthDemo } from '../support/play-synth-demo.mjs';

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

const playDemo = page => page.getByRole('button', { name: 'Play demo', exact: true });
const audioSettings = page => page.getByRole('button', { name: 'Audio settings', exact: true });
const primaryTransport = page => page.locator('.play-btn');

test('Stop and accepted GO cancel pending Play without losing the operator blackout', async ({ page }) => {
  let releaseMap, releaseAudio, releaseNextAudio;
  const mapGate = new Promise(resolve => { releaseMap = resolve; });
  const audioGate = new Promise(resolve => { releaseAudio = resolve; });
  const nextAudioGate = new Promise(resolve => { releaseNextAudio = resolve; });
  let mapRequests = 0;
  let audioRequests = 0;
  await page.route('**/demo/track.json', async route => {
    mapRequests++;
    await mapGate;
    await route.fulfill({ json: TEST_TRACK_MAP });
  });
  await page.route('**/demo/test-demo.wav', async route => {
    if (++audioRequests === 1) {
      await audioGate;
      await route.fulfill({ status: 503, body: 'A canceled load must not fall back' });
      return;
    }
    await nextAudioGate;
    await route.fulfill({ contentType: 'audio/wav', body: buildDemoTrackWav() });
  });

  await page.goto('/?probe');
  const hold = page.getByRole('button', { name: 'Operator blackout hold', exact: true });
  await hold.click();
  await page.getByRole('button', { name: 'Show cues', exact: true }).click();
  await page.getByRole('button', { name: 'Edit cue list', exact: true }).click();
  const cues = page.getByRole('dialog', { name: 'Edit cue list', exact: true });
  await cues.getByLabel('Cue order', { exact: true }).selectOption('cue-1');
  await cues.getByLabel('Follow after (seconds)', { exact: true }).fill('10');
  await cues.getByRole('button', { name: 'Apply cues', exact: true }).click();
  await page.getByRole('button', { name: 'Record take', exact: true }).click();
  await playDemo(page).click();
  await expect(primaryTransport(page)).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(playDemo(page)).toBeVisible();
  releaseMap();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoTrackAvailable()?.title)).toBe(TEST_TRACK_MAP.title);
  expect(audioRequests).toBe(0);

  await playDemo(page).click();
  await expect.poll(() => audioRequests).toBe(1);
  await page.getByRole('button', { name: 'GO', exact: true }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.activeCueId())).toBe('cue-1');
  const cueStack = page.getByRole('group', { name: 'Cue stack', exact: true });
  await expect(cueStack).toContainText('Follow in');
  await expect(playDemo(page)).toBeVisible();
  releaseAudio();
  await playDemo(page).click();
  await expect(primaryTransport(page)).toHaveAttribute('aria-busy', 'true');
  await expect(cueStack).not.toContainText('Follow in');
  releaseNextAudio();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars)).toBe(16);
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.stageforgeProbe.showStateSummary().operatorBlackout)).toBe(true);
  expect(await page.evaluate(() => window.stageforgeProbe.fixtureParams().master)).toBe(0);
  await expect(page.getByText(/Falling back to built-in synth demo/)).toHaveCount(0);
  expect(mapRequests).toBe(1);
  expect(audioRequests).toBe(2);
});

test('an autoplay-blocked recording stays paused and resumes from the primary control without another fetch', async ({ page }) => {
  let audioRequests = 0;
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let rejectOnce = true;
    HTMLMediaElement.prototype.play = function () {
      if (rejectOnce && this.src.startsWith('blob:') && !this.muted && !this.loop) {
        rejectOnce = false;
        return Promise.reject(new DOMException('Blocked for this test', 'NotAllowedError'));
      }
      return play.call(this);
    };
  });
  await page.route('**/demo/track.json', route => route.fulfill({ json: TEST_TRACK_MAP }));
  await page.route('**/demo/test-demo.wav', route => {
    audioRequests++;
    return route.fulfill({ contentType: 'audio/wav', body: buildDemoTrackWav() });
  });
  await page.goto('/?probe');
  await playDemo(page).press('Enter');
  const resume = page.getByRole('button', { name: 'Play track', exact: true });
  await expect(resume).toBeFocused();
  await expect(resume).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('Demo track ready — tap Play track to start.')).toBeVisible();
  expect(await page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBe(0);
  expect(audioRequests).toBe(1);
  await resume.press('Enter');
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(0.05);
  expect(audioRequests).toBe(1);
});

test('a newer audio upload survives a superseded demo element play promise', async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!window.releaseDemoPlay && this.src.startsWith('blob:') && !this.muted && !this.loop) {
        return new Promise(resolve => { window.releaseDemoPlay = resolve; });
      }
      return play.call(this);
    };
  });
  await page.route('**/demo/track.json', route => route.fulfill({ json: TEST_TRACK_MAP }));
  await page.route('**/demo/test-demo.wav', route =>
    route.fulfill({ contentType: 'audio/wav', body: buildDemoTrackWav() }));
  await page.goto('/?probe');
  await playDemo(page).click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseDemoPlay)).toBe('function');
  await audioSettings(page).click();
  await page.getByLabel('Load audio file', { exact: true }).setInputFiles({
    name: 'replacement.wav', mimeType: 'audio/wav', buffer: buildDemoTrackWav(3),
  });
  const replacement = page.getByRole('region', { name: 'Audio settings', exact: true })
    .getByText('replacement', { exact: true });
  await expect(replacement).toBeVisible();
  await page.evaluate(() => window.releaseDemoPlay());
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(0.05);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(replacement).toBeVisible();
  await expect(page.getByText(/Falling back to built-in synth demo/)).toHaveCount(0);
});

test('demo track is lazy-loaded, drives lighting through its section map on seek, pauses/resumes/replays cleanly, and fits 390px phones', async ({ page }) => {
  const wav = buildDemoTrackWav(32, 120);
  let mapRequests = 0;
  let audioRequests = 0;
  let releaseMap;
  const mapGate = new Promise(resolve => { releaseMap = resolve; });
  // Exercise a real Play gesture before idle discovery has run.
  await page.addInitScript(() => { window.requestIdleCallback = () => 1; });

  await page.route('**/demo/track.json', async (route) => {
    mapRequests++;
    await mapGate;
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
  const playTrackBtn = playDemo(page);
  await expect(playTrackBtn).toBeVisible();
  expect(mapRequests).toBe(0);
  expect(audioRequests).toBe(0);

  // Check 390x844 fits the primary action.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(phoneOverflow).toBeLessThanOrEqual(1);
  const phoneBtnBox = await playTrackBtn.boundingBox();
  expect(phoneBtnBox).not.toBeNull();
  expect(phoneBtnBox.x).toBeGreaterThanOrEqual(0);
  expect(phoneBtnBox.x + phoneBtnBox.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Focused Play uses native Space. A second press while pending must not start another request or toggle blackout.
  const primary = primaryTransport(page);
  await playTrackBtn.focus();
  await page.keyboard.press('Space');
  await expect(primary).toHaveAttribute('aria-busy', 'true');
  await expect(primary).toHaveAttribute('aria-disabled', 'true');
  await expect(primary).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => mapRequests).toBe(1);
  expect(audioRequests).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.showStateSummary().operatorBlackout)).toBe(false);
  releaseMap();
  await expect.poll(() => audioRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(0.05);
  await expect(primary).toBeFocused();
  await expect(primary).not.toHaveAttribute('aria-busy', 'true');
  expect(mapRequests).toBe(1);

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

  // Start a slow track fetch, then explicitly switch to synth before the fetch resolves.
  await playDemo(page).click();
  await expect.poll(() => audioRequests).toBe(1);
  await playSynthDemo(page);
  releaseAudio();
  await page.waitForTimeout(300);
  // Synth must remain active (64-bar default demo) — slow track fetch must NOT hijack it.
  expect(await page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars)).toBe(64);

  // Explicitly start the recorded track from Audio settings. Its count-in holds the opening blackout.
  await audioSettings(page).click();
  await page.getByRole('button', { name: 'Play demo track', exact: true }).click();
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

test('when the demo map serves HTML, primary Play falls back to synth without fetching audio', async ({ page }) => {
  let mapRequests = 0;
  let audioRequests = 0;
  await page.route('**/demo/track.json', async (route) => {
    mapRequests++;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' });
  });
  await page.route('**/demo/*.{mp3,wav,m4a,ogg}', async (route) => {
    audioRequests++;
    await route.abort();
  });

  await page.goto('/?probe');
  await expect(playDemo(page)).toBeVisible();
  await expect.poll(() => mapRequests).toBe(1);
  await audioSettings(page).click();
  await expect(page.getByRole('button', { name: 'Play demo track', exact: true })).toHaveCount(0);
  await expect(page.getByText('No audio loaded', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play synth demo', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(audioRequests).toBe(0);
  expect(await page.evaluate(() => window.stageforgeProbe.demoTrackAvailable())).toBeNull();
  await playDemo(page).click();
  await expect(page.getByRole('status').filter({ hasText: /Falling back to built-in synth demo/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoPosition()?.totalBars)).toBe(64);
  expect(audioRequests).toBe(0);
  expect(mapRequests).toBe(1);
});

test('shipped public/demo/track.mp3 is lazy-loaded (0 audio requests on boot), fits 390px and 393px phones, and plays through real sections', async ({ page }) => {
  const mp3Requests = [];
  page.on('request', (req) => {
    if (req.url().includes('/demo/track.mp3')) mp3Requests.push(req.url());
  });

  await page.goto('/?probe');
  const playTrackBtn = playDemo(page);
  await expect(playTrackBtn).toBeVisible({ timeout: 10_000 });

  // Verify the real map metadata loaded from public/demo/track.json and ZERO MP3 requests occurred while idle.
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.demoTrackAvailable()?.bpm)).toBe(122);
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

  // Verify phone layouts (390x844 and 393x852) have zero horizontal overflow with primary Play visible.
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

  // Primary Play fetches track.mp3 once, locks the beat grid to 122 BPM / 96 ms, and starts playback.
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
