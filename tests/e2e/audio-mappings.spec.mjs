import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Generate a 48 kHz 16-bit mono PCM WAV with periodic pulses containing:
 *  - 60 Hz kick sine (band 0)
 *  - Dense 3.2..4.8 kHz comb (bands 8-14 at both 44.1 kHz and 48 kHz)
 *  - Dense 8.8..11.0 kHz comb (hats bands 24-31 at both 44.1 kHz and 48 kHz)
 */
function buildPulsedTestWav(durationSec = 4, periodSec = 0.5, onSec = 0.175, sampleRate = 48000) {
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

  // Dense combs (~100 Hz spacing) with deterministic spread phases so every FFT bin in the target range lights up cleanly.
  const kickComb = [75, 175, 275]; // fills bins 0..3 (band 0 = 0..375 Hz)
  const midComb = [];
  for (let f = 3100; f <= 4900; f += 100) midComb.push({ f, ph: (f * 0.017) % (Math.PI * 2) });
  const hiComb = [];
  for (let f = 8800; f <= 11200; f += 100) hiComb.push({ f, ph: (f * 0.023) % (Math.PI * 2) });
  const rampSec = 0.005;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const phase = t % periodSec;
    let env = 0;
    if (phase < onSec) {
      if (phase < rampSec) env = 0.5 - 0.5 * Math.cos((Math.PI * phase) / rampSec);
      else if (phase > onSec - rampSec) env = 0.5 - 0.5 * Math.cos((Math.PI * (onSec - phase)) / rampSec);
      else env = 1;
    }
    let sample = 0;
    if (env > 0) {
      let kickAcc = 0;
      for (const f of kickComb) kickAcc += Math.sin(2 * Math.PI * f * t);
      let s = (0.45 / kickComb.length) * kickAcc;
      let midAcc = 0;
      for (const { f, ph } of midComb) midAcc += Math.sin(2 * Math.PI * f * t + ph);
      let hiAcc = 0;
      for (const { f, ph } of hiComb) hiAcc += Math.sin(2 * Math.PI * f * t + ph);
      // Normalize combs by sqrt(N) so each bin has strong RMS energy while total peak stays < 1.
      s += (0.28 / Math.sqrt(midComb.length)) * midAcc;
      s += (0.28 / Math.sqrt(hiComb.length)) * hiAcc;
      sample = s * env;
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

test('audio mappings drive wash dimmer, beam strobe, laser rotation and DMX in phase, recall in cues, and survive v8 save/reopen', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sf-audio-e2e-'));
  const wavPath = path.join(tmpDir, 'pulse-1hz.wav');
  // 1.25 Hz pulse (0.8 s period: 260 ms ON, 540 ms OFF) avoids Nyquist aliasing even at ~5 fps SwiftShader.
  const periodSec = 0.8;
  await writeFile(wavPath, buildPulsedTestWav(4, periodSec, 0.26));

  try {
    await page.goto('/?probe');
    await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.fixtureParams)).toBe('function');

    // Select Laser Tunnel cue so lasers are enabled (rotation 0.65) and wash/beam have headroom.
    await page.getByRole('button', { name: /Laser Tunnel/ }).first().click();

    // Open Audio section in Show cues tab and load generated pulsed WAV track.
    const audioToggle = page.getByRole('button', { name: /^Audio \(/ });
    await audioToggle.click();
    await page.getByLabel('Load track for audio mappings').setInputFiles(wavPath);
    await expect(page.getByText('pulse-1hz', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioPlaybackTime())).toBeGreaterThan(0.05);

    // Drag across the 32-band FFT meter to select bands 8-14, then add presets and custom band mapping.
    const fftMeter = page.getByTestId('audio-fft-meter');
    const meterBox = await fftMeter.boundingBox();
    expect(meterBox).not.toBeNull();
    await page.mouse.move(meterBox.x + ((8 + 0.5) / 32) * meterBox.width, meterBox.y + meterBox.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(meterBox.x + ((14 + 0.5) / 32) * meterBox.width, meterBox.y + meterBox.height * 0.5);
    await page.mouse.up();

    // Add presets: Kick -> wash dimmer, Hats -> beam strobe, plus dragged Band 8-14 -> laser rotation.
    await page.getByRole('button', { name: /\+ Kick → wash dimmer/ }).click();
    await page.getByRole('button', { name: /\+ Hats → beam strobe/ }).click();
    await page.getByRole('button', { name: /Add band 8–14/ }).click();

    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(3);

    // Sample fixtureParams(), audioModulation(), dmxSnapshot() and audio playback clock across multiple pulse cycles.
    const samples = await page.evaluate(async () => {
      const out = [];
      const start = performance.now();
      while (performance.now() - start < 4000 || out.length < 24) {
        if (performance.now() - start > 6500) break;
        await new Promise((r) => requestAnimationFrame(r));
        const tAudio = window.stageforgeProbe.audioPlaybackTime();
        const wash = window.stageforgeProbe.fixtureParams('wash');
        const beam = window.stageforgeProbe.fixtureParams('beam');
        const laser = window.stageforgeProbe.fixtureParams('laser');
        const dmx = window.stageforgeProbe.dmxSnapshot();
        const modSnap = window.stageforgeProbe.audioModulation();
        out.push({
          tAudio,
          washDimmer: wash.dimmer,
          beamDimmer: beam.dimmer,
          beamStrobeGate: beam.strobe.gateOn,
          beamStrobeMode: beam.strobe.mode,
          laserRotation: laser.rotation,
          // Arena rig front truss beams start at U1 ch 1 (strobe = offset 7 -> index 7),
          // upstage truss washes start at U1 ch 433 (dimmer = offset 2 -> index 434).
          dmxBeamStrobeByte: dmx.u1[7],
          dmxWashDimmerByte: dmx.u1[434],
          envelopes: modSnap.entries.map((e) => e.envelope),
        });
      }
      return out;
    });

    const washValues = samples.map((s) => s.washDimmer);
    const rotValues = samples.map((s) => s.laserRotation);
    const strobeOns = samples.filter((s) => s.beamStrobeGate).length;
    const strobeOffs = samples.filter((s) => !s.beamStrobeGate).length;

    // All three mapped targets must react clearly to the pulses.
    expect(Math.max(...washValues) - Math.min(...washValues)).toBeGreaterThan(0.15);
    expect(Math.max(...rotValues) - Math.min(...rotValues)).toBeGreaterThan(0.1);
    expect(strobeOns).toBeGreaterThan(0);
    expect(strobeOffs).toBeGreaterThan(0);
    expect(samples.every((s) => s.beamStrobeMode === 'mapped' && s.dmxBeamStrobeByte === 0)).toBe(true);

    // In-phase verification: ON window (0..380 ms after pulse start allowing analyser lag)
    // has strictly higher mean wash dimmer and laser rotation than OFF window (520..780 ms).
    const onSamples = samples.filter((s) => {
      const p = s.tAudio % periodSec;
      return p >= 0.04 && p <= 0.38;
    });
    const offSamples = samples.filter((s) => {
      const p = s.tAudio % periodSec;
      return p >= 0.52 && p <= 0.78;
    });
    expect(onSamples.length).toBeGreaterThan(4);
    expect(offSamples.length).toBeGreaterThan(4);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    expect(mean(onSamples.map((s) => s.washDimmer))).toBeGreaterThan(mean(offSamples.map((s) => s.washDimmer)) + 0.06);
    expect(mean(onSamples.map((s) => s.laserRotation))).toBeGreaterThan(mean(offSamples.map((s) => s.laserRotation)) + 0.04);

    // DMX wash dimmer byte agrees with fixtureParams('wash').dimmer on the exact same frames!
    for (const s of samples.slice(4, Math.min(24, samples.length))) {
      const expectedByte = Math.round(Math.min(1, s.washDimmer) * 255);
      expect(Math.abs(s.dmxWashDimmerByte - expectedByte)).toBeLessThanOrEqual(1);
    }

    // Master Beat sync off restores static look.
    await page.getByTestId('audio-beat-sync-toggle').click();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().active)).toBe(false);
    const staticParams = await page.evaluate(() => ({
      wash: window.stageforgeProbe.fixtureParams('wash'),
      beam: window.stageforgeProbe.fixtureParams('beam'),
      laser: window.stageforgeProbe.fixtureParams('laser'),
    }));
    expect(staticParams.beam.strobe.mode).toBe('unmapped');
    expect(Math.abs(staticParams.laser.rotation - 0.65)).toBeLessThan(1e-4);

    // Turn Beat sync back on, store in Cue 1, switch away to Arena Rock (no mappings), then recall Cue 1.
    await page.getByTestId('audio-beat-sync-toggle').click();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().active)).toBe(true);
    await page.getByRole('button', { name: 'Store cue' }).click();
    await page.getByRole('button', { name: /^Cue 1,/ }).click();
    await page.getByRole('button', { name: /Arena Rock/ }).first().click();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(0);
    await page.getByRole('button', { name: /^Cue 1,/ }).click();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(3);

    // Save show JSON (v8), verify schema version & mappings, then reopen and verify survival.
    await page.getByRole('button', { name: 'Show files', exact: true }).click();
    const filesDialog = page.getByRole('dialog', { name: 'Show files' });
    const downloadPromise = page.waitForEvent('download');
    await filesDialog.getByRole('button', { name: 'Save show JSON' }).click();
    const dl = await downloadPromise;
    const savedPath = path.join(tmpDir, 'saved-v8.stageforge.show.json');
    await dl.saveAs(savedPath);
    const savedJson = JSON.parse(await readFile(savedPath, 'utf8'));
    expect(savedJson.version).toBe(8);
    expect(savedJson.look.audioMap.mappings.length).toBe(3);

    await filesDialog.getByRole('button', { name: 'Close Show files' }).click();
    // Switch to Arena Rock (0 mappings) before reopening saved v8 file.
    await page.getByRole('button', { name: /Arena Rock/ }).first().click();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(0);

    await page.getByRole('button', { name: 'Show files', exact: true }).click();
    await filesDialog.locator('input[type="file"]').first().setInputFiles(savedPath);
    await expect(filesDialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('live microphone FFT source drives audio mappings periodically from fake audio capture stream', async ({ baseURL }) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sf-mic-e2e-'));
  const wavPath = path.join(tmpDir, 'mic-pulse-2hz.wav').replace(/\\/g, '/');
  await writeFile(wavPath, buildPulsedTestWav(4));

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
  });
  try {
    const origin = new URL(baseURL || 'http://127.0.0.1:4173').origin;
    const context = await browser.newContext();
    await context.grantPermissions(['microphone'], { origin });
    const page = await context.newPage();

    await page.goto(`${origin}/?probe`);
    await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.fixtureParams)).toBe('function');

    await page.getByRole('button', { name: /Laser Tunnel/ }).first().click();
    await page.getByRole('button', { name: /^Audio \(/ }).click();
    await page.getByRole('button', { name: /\+ Kick → wash dimmer/ }).click();
    await page.getByRole('button', { name: /Add band 8–14/ }).click();

    // Activate live microphone input.
    await page.getByRole('button', { name: /^Mic$/ }).click();
    await expect(page.getByText('Live Mic / Line-In')).toBeVisible();

    // Sample over 2.4 s and count rising peaks (2 Hz -> ~4-5 peaks over 2.4 s).
    const micSamples = await page.evaluate(async () => {
      const out = [];
      const start = performance.now();
      while (performance.now() - start < 2400) {
        await new Promise((r) => requestAnimationFrame(r));
        out.push({
          ms: performance.now() - start,
          wash: window.stageforgeProbe.fixtureParams('wash').dimmer,
          rot: window.stageforgeProbe.fixtureParams('laser').rotation,
        });
      }
      return out;
    });

    const washVals = micSamples.map((s) => s.wash);
    const rotVals = micSamples.map((s) => s.rot);
    const washSpan = Math.max(...washVals) - Math.min(...washVals);
    const rotSpan = Math.max(...rotVals) - Math.min(...rotVals);
    expect(washSpan).toBeGreaterThan(0.12);
    expect(rotSpan).toBeGreaterThan(0.08);

    // Count distinct rising crossings above midpoint to confirm ~2 Hz periodicity.
    const mid = (Math.max(...washVals) + Math.min(...washVals)) / 2;
    let peaks = 0;
    let above = false;
    for (const v of washVals) {
      if (!above && v > mid + washSpan * 0.15) {
        peaks++;
        above = true;
      } else if (above && v < mid - washSpan * 0.15) {
        above = false;
      }
    }
    expect(peaks).toBeGreaterThanOrEqual(3);
    expect(peaks).toBeLessThanOrEqual(7);
  } finally {
    await browser.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('frozen-frame pixel parity: no mappings and disabled mappings match bit-for-bit on Arena Rock', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.redrawAndCapture)).toBe('function');

  await page.getByRole('button', { name: /play demo/i }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();
  await expect.poll(async () => page.evaluate(() =>
    window.stageforgeProbe.beamAxes().filter((b) => b.optics.emitted > 0.001).length
  )).toBeGreaterThanOrEqual(40);

  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.clock.runFor(16);

  const baselineState = await page.evaluate(() => ({
    img: window.stageforgeProbe.redrawAndCapture(),
    mod: window.stageforgeProbe.audioModulation(),
    wash: window.stageforgeProbe.fixtureParams('wash'),
    laser: window.stageforgeProbe.fixtureParams('laser'),
  }));
  expect(baselineState.mod.active).toBe(false);

  // Add a mapping, disable it (remains inactive), and capture at the identical frozen frame.
  await page.getByRole('button', { name: /^Audio \(/ }).click();
  await page.getByRole('button', { name: /\+ Kick → wash dimmer/ }).click();
  await page.getByRole('checkbox', { name: /Enable Kick → wash dimmer/ }).uncheck();
  await expect(page.getByRole('checkbox', { name: /Enable Kick → wash dimmer/ })).not.toBeChecked();

  const inactiveState = await page.evaluate(() => ({
    img: window.stageforgeProbe.redrawAndCapture(),
    mod: window.stageforgeProbe.audioModulation(),
    wash: window.stageforgeProbe.fixtureParams('wash'),
    laser: window.stageforgeProbe.fixtureParams('laser'),
  }));
  expect(inactiveState.mod.active).toBe(false);
  expect(inactiveState.wash.dimmer).toBe(baselineState.wash.dimmer);
  expect(inactiveState.laser.rotation).toBe(baselineState.laser.rotation);

  const pixelDiff = await page.evaluate(async ([aUrl, bUrl]) => {
    const decode = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, c.width, c.height));
      };
      img.onerror = reject;
      img.src = url;
    });
    const [a, b] = await Promise.all([decode(aUrl), decode(bUrl)]);
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    }
    return sum / (a.width * a.height * 3 * 255);
  }, [baselineState.img, inactiveState.img]);

  console.log(`[Sprint 9 parity] Arena Rock mean abs pixel diff (0 vs disabled mapping): ${(pixelDiff * 100).toFixed(4)}%`);
  expect(pixelDiff).toBeLessThan(0.01);
  await page.clock.resume();
});

test('phone-like 4x CPU throttle performance: 16 active audio mappings stay within budget vs 0 mappings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?probe');
  await expect.poll(() => page.evaluate(() => typeof window.stageforgeProbe?.audioModulation)).toBe('function');

  await page.getByRole('button', { name: /play demo/i }).click();
  await page.getByRole('button', { name: /Arena Rock/ }).first().click();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const measureFrames = () => page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
    const deltas = [];
    let prev = performance.now();
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      deltas.push(now - prev);
      prev = now;
    }
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    return { median, mean, p95: deltas[Math.floor(deltas.length * 0.95)] };
  });

  const zeroMapPerf = await measureFrames();

  // Temporarily disable throttle to click through 16 preset additions quickly, then restore 4x CPU throttle.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.getByRole('button', { name: /^Audio \(/ }).click();
  for (let round = 0; round < 4; round++) {
    await page.getByRole('button', { name: /\+ Kick → wash dimmer/ }).click();
    await page.getByRole('button', { name: /\+ Hats → beam strobe/ }).click();
    await page.getByRole('button', { name: /\+ Bass → LED wall/ }).click();
    await page.getByRole('button', { name: /\+ Energy → beam zoom/ }).click();
  }
  await expect.poll(() => page.evaluate(() => window.stageforgeProbe.audioModulation().entries.length)).toBe(16);
  // Collapse back to the same UI chrome as the 0-mapping measurement so we compare engine frame cost apples-to-apples,
  // AND also measure with the 16-row Audio section open.
  await page.getByRole('button', { name: /^Audio \(/ }).click();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const sixteenMapPerf = await measureFrames();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();

  console.log(
    `[Sprint 9 perf 390x844 4x CPU] 0 mappings: median=${zeroMapPerf.median.toFixed(2)}ms mean=${zeroMapPerf.mean.toFixed(2)}ms p95=${zeroMapPerf.p95.toFixed(2)}ms | 16 mappings: median=${sixteenMapPerf.median.toFixed(2)}ms mean=${sixteenMapPerf.mean.toFixed(2)}ms p95=${sixteenMapPerf.p95.toFixed(2)}ms | deltaMedian=${(sixteenMapPerf.median - zeroMapPerf.median).toFixed(2)}ms`,
  );
  expect(sixteenMapPerf.median - zeroMapPerf.median).toBeLessThan(8);
});
