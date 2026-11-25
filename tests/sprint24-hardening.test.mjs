import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as THREE from 'three';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let server;
let flashGov;
let previewFlash;
let audioMod;
let renderProbe;
let physicalDmx;

before(async () => {
  server = await createServer({
    root: repoRoot,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  flashGov = await server.ssrLoadModule('/src/engine/flashGovernor.ts');
  previewFlash = await server.ssrLoadModule('/src/engine/previewFlash.ts');
  audioMod = await server.ssrLoadModule('/src/engine/audioModulation.ts');
  renderProbe = await server.ssrLoadModule('/src/engine/renderProbe.ts');
  physicalDmx = await server.ssrLoadModule('/src/dmx/physicalDmx.ts');
});

after(async () => {
  await server?.close();
});

function makeLinearRgbGrid(r, g, b) {
  const cr = Math.max(0, Math.min(1, r));
  const cg = Math.max(0, Math.min(1, g));
  const cb = Math.max(0, Math.min(1, b));
  const y = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
  const sum = cr + cg + cb;
  const redRatio = sum > 1e-6 ? cr / sum : 0;
  const redMetric = Math.max(0, (cr - cg - cb) * 320);
  const cell = { y, r: cr, g: cg, b: cb, redRatio, redMetric };
  return {
    cols: 1,
    rows: 1,
    whole: cell,
    cells: [cell],
  };
}

function makeScalarSample(timeMs, v) {
  const c = Math.max(0, Math.min(1, v));
  return { timeMs, grid: makeLinearRgbGrid(c, c, c) };
}

function makeRgbSample(timeMs, r, g, b) {
  return { timeMs, grid: makeLinearRgbGrid(r, g, b) };
}

test('Sprint 24 (Codex math): variable pulse width (300 ms long + short pulses) and sub-threshold saturated-red stay <= 3/s', () => {
  // 1. Variable-width pulse counterexample that defeats any fixed 334/350/380 ms rise-to-rise refractory:
  //    Starts dark at 0 ms, Pulse 1 stays high 20..320 ms (falls at 320 ms), then short pulses arrive
  //    every 380 ms (400, 780, 1160 ms -> 7 reversals inside [320, 1185] < 1000 ms -> 4 flashes/s!).
  for (const dtMs of [1000 / 60, 1000 / 120]) {
    const rawSamples = [];
    const govSamples = [];
    const clock = flashGov.createFlashBudgetClock(380, 650);
    const gov = flashGov.createScalarGovernorState();
    let tMs = 0;

    while (tMs <= 2000) {
      clock.clockMs = tMs;
      const desired =
        (tMs >= 20 && tMs < 320) ||
        (tMs >= 400 && tMs < 425) ||
        (tMs >= 780 && tMs < 805) ||
        (tMs >= 1160 && tMs < 1185) ||
        (tMs >= 1540 && tMs < 1565)
          ? 1.0
          : 0.0;
      const res = flashGov.stepGovernedScalar(gov, clock, tMs, desired, false, true);
      rawSamples.push(makeScalarSample(tMs, desired));
      govSamples.push(makeScalarSample(tMs, res.value));
      tMs += dtMs;
    }

    const rawRate = renderProbe.analyzeRollingFlashRate(rawSamples);
    const govRate = renderProbe.analyzeRollingFlashRate(govSamples);
    assert.ok(rawRate.maxGeneralFlashesPerSec >= 4, `raw variable-pulse sequence must exceed 3/s (got ${rawRate.maxGeneralFlashesPerSec})`);
    assert.ok(govRate.maxGeneralFlashesPerSec <= 3, `governed variable-pulse sequence at dt=${dtMs.toFixed(2)} ms must stay <= 3/s (got ${govRate.maxGeneralFlashesPerSec})`);
  }

  // 2. Sub-threshold saturated-red counterexample:
  //    A = (0.300, 0.030, 0.030) <-> B = (0.251, 0.079, 0.079) has max component delta 0.049 (< 0.05)
  //    and luminance delta 0.028 (< 0.08), yet swings WCAG redMetric by 47.04 (> 20).
  const rawRedSamples = [];
  const govRedSamples = [];
  const rgbGov = flashGov.createRgbGovernorState();
  const dtMs = 1000 / 120;
  for (let i = 0; i < 240; i++) {
    const tMs = i * dtMs;
    const highRed = Math.floor(tMs / 62.5) % 2 === 0;
    const dr = highRed ? 0.300 : 0.251;
    const dg = highRed ? 0.030 : 0.079;
    const db = highRed ? 0.030 : 0.079;
    const res = flashGov.stepGovernedRgb(rgbGov, null, tMs, dr, dg, db, false);
    rawRedSamples.push(makeRgbSample(tMs, dr, dg, db));
    govRedSamples.push(makeRgbSample(tMs, res.r, res.g, res.b));
  }
  const rawRedRate = renderProbe.analyzeRollingFlashRate(rawRedSamples);
  const govRedRate = renderProbe.analyzeRollingFlashRate(govRedSamples);
  assert.ok(rawRedRate.maxRedFlashesPerSec > 3, `raw saturated-red sequence must exceed 3/s (got ${rawRedRate.maxRedFlashesPerSec})`);
  assert.ok(govRedRate.maxRedFlashesPerSec <= 3, `governed saturated-red sequence must stay <= 3/s (got ${govRedRate.maxRedFlashesPerSec})`);
  assert.ok(govRedRate.maxGeneralFlashesPerSec <= 3);

  // 3. Iso-luminant green <-> red swap followed by blackout stays <= 3/s and zeroes immediately on blackout.
  const isoSamples = [];
  const isoGov = flashGov.createRgbGovernorState();
  for (let i = 0; i < 180; i++) {
    const tMs = i * (1000 / 60);
    const blackout = i === 95 || i === 96;
    const redTurn = Math.floor(tMs / 80) % 2 === 1;
    const dr = redTurn ? 1.0 : 0.0;
    const dg = redTurn ? 0.0 : 0.30;
    const res = flashGov.stepGovernedRgb(isoGov, null, tMs, dr, dg, 0, blackout);
    if (blackout) {
      assert.equal(res.r, 0);
      assert.equal(res.g, 0);
      assert.equal(res.b, 0);
    }
    isoSamples.push(makeRgbSample(tMs, res.r, res.g, res.b));
  }
  const isoRate = renderProbe.analyzeRollingFlashRate(isoSamples);
  assert.ok(isoRate.maxGeneralFlashesPerSec <= 3);
  assert.ok(isoRate.maxRedFlashesPerSec <= 3);
});

test('Sprint 24 (review-06 R2): multi-frame 60/120 Hz sawtooth ramps and plateau-step-jumps stay <= 3/s in preview and physical DMX', () => {
  const par1ChClass = physicalDmx.classifyPhysicalGroup({
    id: 'g-par-1',
    type: 'wash',
    modelName: 'ETC ColorSource PAR',
    catalogId: 'etc-colorsource-par',
    dmxMode: '1-Ch',
    dmxChannels: 1,
  });
  assert.equal(par1ChClass.status, 'implemented');

  for (const fps of [60, 120]) {
    const dtSec = 1 / fps;
    const dtMs = dtSec * 1000;
    const totalFrames = fps * 3; // 3 full seconds

    const modState = audioMod.createAudioModulationState();
    const prevState = previewFlash.createPreviewFlashState();
    const prevOut = previewFlash.createPreviewFlashOutput();
    const primary = new THREE.Color(0xffffff);
    const accent = new THREE.Color(0x00ffff);
    const simBuf = new Uint8Array(512);
    const physBuf = new Uint8Array(512);

    const rawRampSamples = [];
    const physParSamples = [];
    const prevMasterSamples = [];
    const prevBeatSamples = [];

    for (let f = 0; f < totalFrames; f++) {
      const tSec = f * dtSec;
      const tMs = f * dtMs;
      // 5 Hz sawtooth ramp whose per-frame step is <= 0.083 at 60 Hz and <= 0.042 at 120 Hz
      // (defeated previous single-frame 0.08/0.12 delta gates!).
      const phase = (tSec * 5) % 1;
      const saw = Math.min(1, phase * 1.05);

      modState.clockMs += dtMs;
      const governedWash = audioMod.stepDeliveredBrightness(modState, 'wash', saw, false);
      physicalDmx.writePhysicalUnitBytes(physBuf, simBuf, 1, 1, par1ChClass, {
        blackout: false,
        dimmer: governedWash,
      });

      previewFlash.evaluatePreviewFlash(
        prevState,
        {
          dtSec,
          tSec,
          limited: true,
          blackout: false,
          master: saw,
          blinder: saw,
          ledBright: saw,
          beatPulse: saw,
          bass: saw,
          mid: saw,
          high: saw,
          beamIntensity: saw,
          washIntensity: saw,
          laserStrobe: 0,
          primaryColor: primary,
          accentColor: accent,
        },
        prevOut,
      );

      rawRampSamples.push(makeScalarSample(tMs, saw));
      physParSamples.push(makeScalarSample(tMs, physBuf[0] / 255));
      prevMasterSamples.push(makeScalarSample(tMs, prevOut.master));
      prevBeatSamples.push(makeScalarSample(tMs, prevOut.beatPulse));
    }

    assert.ok(renderProbe.analyzeRollingFlashRate(rawRampSamples).maxGeneralFlashesPerSec >= 4);
    assert.ok(
      renderProbe.analyzeRollingFlashRate(physParSamples).maxGeneralFlashesPerSec <= 3,
      `ETC ColorSource PAR 1-Ch sawtooth at ${fps} Hz must stay <= 3/s`,
    );
    assert.ok(
      renderProbe.analyzeRollingFlashRate(prevMasterSamples).maxGeneralFlashesPerSec <= 3,
      `preview master sawtooth at ${fps} Hz must stay <= 3/s`,
    );
    assert.ok(
      renderProbe.analyzeRollingFlashRate(prevBeatSamples).maxGeneralFlashesPerSec <= 3,
      `preview beatPulse sawtooth at ${fps} Hz must stay <= 3/s`,
    );
  }

  // Plateau-then-small-step-then-jump sequence: 0 -> 0.07, pause 200 ms, 0.10, 0.13, 1.0 -> 0 -> 1.0 inside 260 ms.
  const modState = audioMod.createAudioModulationState();
  const seq = [
    [16, 0.0],
    [16, 0.07],
    [200, 0.07],
    [16, 0.10],
    [16, 0.13],
    [16, 1.0],
    [16, 0.0],
    [100, 1.0], // Must be held dark because 1.0 happened only 116 ms ago!
  ];
  let lastVal = 0;
  for (const [dtMs, target] of seq) {
    modState.clockMs += dtMs;
    lastVal = audioMod.stepDeliveredBrightness(modState, 'beam', target, false);
  }
  assert.equal(lastVal, 0, 'jump after slow sub-threshold climb + drop must still be held in refractory');
});

test('Sprint 24 (review-06 R3): CHAUVET STRIKE 4 (1-Ch & 4-Ch) physical DMX obeys <= 3/s under 50 ms blinder bumps and instant blackout', () => {
  const strike1Ch = physicalDmx.classifyPhysicalGroup({
    id: 'g-strike-1',
    type: 'blinder',
    modelName: 'CHAUVET STRIKE 4',
    catalogId: 'chauvet-strike-4',
    dmxMode: '1-Ch',
    dmxChannels: 1,
  });
  const strike4Ch = physicalDmx.classifyPhysicalGroup({
    id: 'g-strike-4',
    type: 'blinder',
    modelName: 'CHAUVET STRIKE 4',
    catalogId: 'chauvet-strike-4',
    dmxMode: '4-Ch',
    dmxChannels: 4,
  });
  assert.equal(strike1Ch.status, 'implemented');
  assert.equal(strike4Ch.status, 'implemented');

  const modState = audioMod.createAudioModulationState();
  const simBuf = new Uint8Array(512);
  const physBuf = new Uint8Array(512);
  const rawSamples = [];
  const pod1Samples = [];
  const pod4Samples = [];

  const dtMs = 1000 / 60;
  for (let i = 0; i < 180; i++) {
    const tMs = i * dtMs;
    modState.clockMs += dtMs;
    const blackout = i === 70 || i === 71;
    // Rapid 10 Hz (50 ms on / 50 ms off) blinder bump mashing
    const bumpOn = !blackout && Math.floor(tMs / 50) % 2 === 0;
    const rawEffBlinder = bumpOn ? 1.0 : 0.0;
    const effBlinder = audioMod.stepDeliveredBrightness(modState, 'blinder', rawEffBlinder, blackout);

    physicalDmx.writePhysicalUnitBytes(physBuf, simBuf, 1, 1, strike1Ch, { blackout, blinder: effBlinder });
    physicalDmx.writePhysicalUnitBytes(physBuf, simBuf, 2, 4, strike4Ch, { blackout, blinder: effBlinder });

    if (blackout) {
      assert.deepEqual([...physBuf.slice(0, 5)], [0, 0, 0, 0, 0], 'blackout must zero STRIKE 4 1-Ch and 4-Ch immediately');
    }
    rawSamples.push(makeScalarSample(tMs, rawEffBlinder));
    pod1Samples.push(makeScalarSample(tMs, physBuf[0] / 255));
    pod4Samples.push(makeScalarSample(tMs, physBuf[4] / 255));
  }

  assert.ok(renderProbe.analyzeRollingFlashRate(rawSamples).maxGeneralFlashesPerSec > 3);
  assert.ok(renderProbe.analyzeRollingFlashRate(pod1Samples).maxGeneralFlashesPerSec <= 3, 'STRIKE 4 1-Ch must stay <= 3/s');
  assert.ok(renderProbe.analyzeRollingFlashRate(pod4Samples).maxGeneralFlashesPerSec <= 3, 'STRIKE 4 4-Ch must stay <= 3/s');
});

test('Sprint 24 (review-06 R4): ETC ColorSource PAR RGB (3-Ch) & 5-Ch (Default) physical colour flips, factorization, and mid-refractory rig rebuild', () => {
  const par3Ch = physicalDmx.classifyPhysicalGroup({
    id: 'g-par-3',
    type: 'wash',
    modelName: 'ETC ColorSource PAR',
    catalogId: 'etc-colorsource-par',
    dmxMode: 'RGB (3-Ch)',
    dmxChannels: 3,
  });
  const par5Ch = physicalDmx.classifyPhysicalGroup({
    id: 'g-par-5',
    type: 'wash',
    modelName: 'ETC ColorSource PAR',
    catalogId: 'etc-colorsource-par',
    dmxMode: '5-Ch (Default)',
    dmxChannels: 5,
  });
  assert.equal(par3Ch.status, 'implemented');
  assert.equal(par5Ch.status, 'implemented');

  const simBuf = new Uint8Array(512);
  const physBuf = new Uint8Array(512);
  const outScratch = { rgbDimmer: 0, r: 0, g: 0, b: 0, limited: false };

  // Scenario A: 10 Hz Red (#ff0000) <-> Cyan (#00ffff) flips with washIntensity = 1.0
  // Scenario B: 10 Hz Black (#000000) <-> White (#ffffff) flips with washIntensity = 1.0
  for (const scenario of ['red-cyan', 'black-white']) {
    const modState = audioMod.createAudioModulationState();
    const rawSamples = [];
    const samples3Ch = [];
    const samples5Ch = [];

    const dtMs = 1000 / 60;
    for (let i = 0; i < 180; i++) {
      const tMs = i * dtMs;
      modState.clockMs += dtMs;
      const flip = Math.floor(tMs / 50) % 2 === 0;
      const [r, g, b] =
        scenario === 'red-cyan'
          ? (flip ? [1, 0, 0] : [0, 1, 1])
          : (flip ? [1, 1, 1] : [0, 0, 0]);

      const unitRgb = audioMod.stepDeliveredUnitRgb(modState, 'wash:0', 1.0, r, g, b, false, outScratch);
      physicalDmx.writePhysicalUnitBytes(physBuf, simBuf, 1, 3, par3Ch, {
        blackout: false,
        dimmer: unitRgb.rgbDimmer,
        r: unitRgb.r,
        g: unitRgb.g,
        b: unitRgb.b,
      });
      physicalDmx.writePhysicalUnitBytes(physBuf, simBuf, 4, 5, par5Ch, {
        blackout: false,
        dimmer: unitRgb.rgbDimmer,
        r: unitRgb.r,
        g: unitRgb.g,
        b: unitRgb.b,
      });

      // Verify 5-Ch hardware strobe slot is strictly 0 and D * C matches 3-Ch emitted RGB within quantization.
      assert.equal(physBuf[8], 0, '5-Ch strobe channel must always be 0');
      const d5 = physBuf[3] / 255;
      const r5 = (physBuf[4] / 255) * d5;
      const g5 = (physBuf[5] / 255) * d5;
      const b5 = (physBuf[6] / 255) * d5;
      assert.ok(Math.abs(r5 - physBuf[0] / 255) <= 2 / 255);
      assert.ok(Math.abs(g5 - physBuf[1] / 255) <= 2 / 255);
      assert.ok(Math.abs(b5 - physBuf[2] / 255) <= 2 / 255);

      rawSamples.push(makeRgbSample(tMs, r, g, b));
      samples3Ch.push(makeRgbSample(tMs, physBuf[0] / 255, physBuf[1] / 255, physBuf[2] / 255));
      samples5Ch.push(makeRgbSample(tMs, r5, g5, b5));
    }

    const rawRate = renderProbe.analyzeRollingFlashRate(rawSamples);
    const rate3Ch = renderProbe.analyzeRollingFlashRate(samples3Ch);
    const rate5Ch = renderProbe.analyzeRollingFlashRate(samples5Ch);
    assert.ok(rawRate.maxGeneralFlashesPerSec > 3 || rawRate.maxRedFlashesPerSec > 3);
    assert.ok(rate3Ch.maxGeneralFlashesPerSec <= 3 && rate3Ch.maxRedFlashesPerSec <= 3, `3-Ch ${scenario} failed: ${JSON.stringify(rate3Ch)}`);
    assert.ok(rate5Ch.maxGeneralFlashesPerSec <= 3 && rate5Ch.maxRedFlashesPerSec <= 3, `5-Ch ${scenario} failed: ${JSON.stringify(rate5Ch)}`);
  }

  // Mid-refractory rig rebuild: clearing unitRgbGovernors inside an active room refractory must not emit an ungoverned flash.
  const rebuildState = audioMod.createAudioModulationState();
  rebuildState.clockMs = 100;
  audioMod.stepDeliveredBrightness(rebuildState, 'wash', 0, false);
  rebuildState.clockMs = 150;
  audioMod.stepDeliveredBrightness(rebuildState, 'wash', 1, false); // Admitted rise at 150 ms
  rebuildState.clockMs = 180;
  audioMod.stepDeliveredBrightness(rebuildState, 'wash', 0, true); // Blackout at 180 ms
  // Simulate rig rebuild creating a brand-new fixture unitId at t = 220 ms (< 150 + 334 = 484 ms)
  rebuildState.unitRgbGovernors.clear();
  rebuildState.clockMs = 220;
  const rebuilt = audioMod.stepDeliveredUnitRgb(rebuildState, 'wash:rebuilt-unit', 1.0, 1, 1, 1, false, outScratch);
  assert.equal(rebuilt.rgbDimmer, 0, 'newly rebuilt unit inside active room refractory must hold dark');
  assert.equal(rebuilt.limited, true);
});

test('Sprint 24 (review-06 R5): preview laser governor caps enabled flips, laser bumps, intensity ramps, and custom colour swaps while keeping off instant', () => {
  const state = previewFlash.createPreviewFlashState();
  const rawColorA = new THREE.Color();
  const rawColorB = new THREE.Color();
  const outColorA = new THREE.Color();
  const outColorB = new THREE.Color();

  // 1. 10 Hz `b.laser` bump mashing while `s.laser.enabled = false` + custom Red/Cyan colour flips
  const rawSamples = [];
  const govSamples = [];
  const dtMs = 1000 / 60;
  for (let i = 0; i < 180; i++) {
    const tMs = i * dtMs;
    state.clockMs += dtMs;
    state.budgetClock.clockMs = state.clockMs;
    const blackout = i === 85;
    const bumpOn = !blackout && Math.floor(tMs / 50) % 2 === 0;
    const redTurn = Math.floor(tMs / 65) % 2 === 0;
    rawColorA.setRGB(redTurn ? 1 : 0, redTurn ? 0 : 1, redTurn ? 0 : 1);
    rawColorB.setRGB(redTurn ? 0 : 1, 0, 1);
    const rawInt = bumpOn ? 1.0 : 0.0;

    const res = previewFlash.stepPreviewLaserUnit(
      state,
      'pod-0:laser:0',
      true,
      blackout,
      rawInt,
      rawColorA,
      rawColorB,
      outColorA,
      outColorB,
    );

    if (blackout || rawInt === 0) {
      assert.equal(res.intensity, 0, 'laser off / blackout must extinguish preview laser immediately');
    }

    const clampedRaw = Math.min(1, rawInt);
    const clampedGov = Math.min(1, res.intensity);
    rawSamples.push(makeRgbSample(tMs, rawColorA.r * clampedRaw, rawColorA.g * clampedRaw, rawColorA.b * clampedRaw));
    govSamples.push(makeRgbSample(tMs, outColorA.r * clampedGov, outColorA.g * clampedGov, outColorA.b * clampedGov));
  }

  const rawRate = renderProbe.analyzeRollingFlashRate(rawSamples);
  const govRate = renderProbe.analyzeRollingFlashRate(govSamples);
  assert.ok(rawRate.maxGeneralFlashesPerSec > 3 || rawRate.maxRedFlashesPerSec > 3);
  assert.ok(govRate.maxGeneralFlashesPerSec <= 3, `governed preview laser general flashes=${govRate.maxGeneralFlashesPerSec}`);
  assert.ok(govRate.maxRedFlashesPerSec <= 3, `governed preview laser red flashes=${govRate.maxRedFlashesPerSec}`);
});

test('Sprint 24 (safety-claim audit): LaserSafetyPanel & PreflightPanel never label status as safe, certified, or compliant', async () => {
  const laserPanelSrc = await fs.readFile(path.join(repoRoot, 'src/components/LaserSafetyPanel.tsx'), 'utf8');
  const preflightPanelSrc = await fs.readFile(path.join(repoRoot, 'src/components/PreflightPanel.tsx'), 'utf8');

  assert.doesNotMatch(laserPanelSrc, /Safe overhead/i);
  assert.doesNotMatch(laserPanelSrc, /laser safety safe/i);
  assert.match(laserPanelSrc, /Overhead ≥ 3 m \(est\.\)/);
  assert.match(laserPanelSrc, /No audience-zone hit \(est\.\)/);
  assert.match(laserPanelSrc, /lateral guidance/);

  // Neither UI panel may claim regulatory certification or compliance as a positive status badge.
  for (const [name, src] of [
    ['LaserSafetyPanel.tsx', laserPanelSrc],
    ['PreflightPanel.tsx', preflightPanelSrc],
  ]) {
    assert.doesNotMatch(src, /label:\s*['"][^'"]*\b(safe|certified|compliant|approved)\b/i, `${name} must not have a safe/certified/compliant badge label`);
  }
});
