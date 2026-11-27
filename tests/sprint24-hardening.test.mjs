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
let preflight;
let presets;

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
  preflight = await server.ssrLoadModule('/src/data/preflight.ts');
  presets = await server.ssrLoadModule('/src/data/presets.ts');
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

function acknowledgeEverything(report) {
  const acknowledgedRows = {};
  const acknowledgedLasers = {};
  const inhibitedLasers = {};
  for (const row of report.rows) {
    if (row.isLaser && row.projectorKey) {
      if (row.requiresLaserInhibit || row.canInhibitLaser) {
        inhibitedLasers[row.projectorKey] = report.configRevision;
      } else {
        acknowledgedLasers[row.projectorKey] = row.rowFingerprint;
      }
    } else if (row.canAcknowledge || row.outcome === 'warn') {
      acknowledgedRows[row.id] = row.rowFingerprint;
    }
  }
  return {
    checked: true,
    checkedRevision: report.configRevision,
    acknowledgedRows,
    acknowledgedLasers,
    inhibitedLasers,
  };
}

test('Sprint 24 (Codex SF-H1 / N1): generic non-catalogue fixtures never copy simulated bytes onto physical DMX even after pre-flight ack', () => {
  const defaultRig = structuredClone(presets.RIG_TEMPLATES.arena_mainstage);
  const simU1 = new Uint8Array(512).fill(255);
  const simU2 = new Uint8Array(512).fill(255);

  // Every fixture in default arena_mainstage lacks a catalogId and MUST classify as simulation-only.
  const summary = physicalDmx.summarizePhysicalDrive(defaultRig);
  assert.equal(summary.implemented.length, 0);
  assert.equal('genericSimulated' in summary, false);
  assert.ok(summary.simulationOnly.length > 0);
  for (const item of summary.simulationOnly) {
    assert.equal(item.classification.status, 'simulation-only');
  }

  // Acknowledge all pre-flight warnings + inhibit unassessed lasers so the rig is eligible to arm on sACN.
  const dmxSettings = {
    mode: 'sacn',
    iface: '127.0.0.1',
    sacnMode: 'unicast',
    sacnUniverse1: 1,
    sacnUniverse2: 2,
    sacnTargets: '127.0.0.1',
    artnetBase: '0:0:0',
    artnetTargets: '127.0.0.1',
    artnetBroadcast: false,
    serialUniverse: 1,
    rateHz: 30,
  };
  const initialReport = preflight.evaluatePreflight({
    rig: defaultRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings,
  });
  const ackedReport = preflight.evaluatePreflight({
    rig: defaultRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings,
    acks: acknowledgeEverything(initialReport),
  });
  assert.equal(ackedReport.canArm, true);

  // Even when armed and driven at 100% intensity with simU1/simU2 filled with 255, physical DMX MUST stay all-zero!
  const out = physicalDmx.buildPhysicalUniverses(defaultRig, simU1, simU2, () => ({
    blackout: false,
    dimmer: 1,
    r: 1,
    g: 1,
    b: 1,
    blinder: 1,
    smoke: 1,
  }));
  assert.ok(out.u1.every((b) => b === 0), 'Physical Universe 1 must emit 0 for all generic non-catalogue fixtures');
  assert.ok(out.u2.every((b) => b === 0), 'Physical Universe 2 must emit 0 for all generic non-catalogue fixtures');
  assert.ok(simU1.every((b) => b === 255), 'Simulator Universe 1 remains untouched');
  assert.ok(simU2.every((b) => b === 255), 'Simulator Universe 2 remains untouched');
});

test('Sprint 24 (Codex SF-H2 / N2): renderer Web Serial hard-blocks and byte-zeroes hazardous fixtures (ZR45, STRIKE 4, lasers, strobes, atmospherics)', () => {
  const serialSettings = {
    mode: 'serial',
    iface: '127.0.0.1',
    sacnMode: 'unicast',
    sacnUniverse1: 1,
    sacnUniverse2: 2,
    sacnTargets: '127.0.0.1',
    artnetBase: '0:0:0',
    artnetTargets: '127.0.0.1',
    artnetBroadcast: false,
    serialUniverse: 1,
    rateHz: 30,
  };

  const makeSingleFixtureRig = (fixture, floorFx = []) => ({
    ...structuredClone(presets.RIG_TEMPLATES.club_stage),
    trussPods: [
      {
        id: 'pod-test',
        name: 'Test Truss',
        shape: 'box',
        width: 8,
        x: 0,
        baseY: 6,
        z: 0,
        rotationY: 0,
        motorized: false,
        motorMinY: 6,
        motorMaxY: 6,
        fixtures: fixture ? [fixture] : [],
      },
    ],
    floorFx,
  });

  // 1. Passive ETC ColorSource PAR rig is allowed on serial once pre-flight is checked/acknowledged.
  const parOnlyRig = makeSingleFixtureRig({
    id: 'f-par',
    type: 'wash',
    modelName: 'ETC ColorSource PAR',
    catalogId: 'etc-colorsource-par',
    dmxMode: '5-Ch (Default)',
    dmxChannels: 5,
    count: 4,
    dmxUniverse: 1,
    dmxStartChannel: 1,
  });
  assert.equal(physicalDmx.checkSerialTransportSafety(parOnlyRig).allowed, true);
  const parInitial = preflight.evaluatePreflight({
    rig: parOnlyRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings: serialSettings,
  });
  const parAcked = preflight.evaluatePreflight({
    rig: parOnlyRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings: serialSettings,
    acks: acknowledgeEverything(parInitial),
  });
  assert.equal(parAcked.canArm, true, `Expected pure PAR rig to arm on serial, got: ${parAcked.blockingReasons.join('; ')}`);

  // 2. Martin JEM ZR45, CHAUVET STRIKE 4, lasers, strobes, CO2, smoke, and hazer MUST hard-block serial (un-acknowledgeable).
  const hazardousConfigs = [
    ['Martin JEM ZR45', makeSingleFixtureRig(null, [{ id: 'fx-zr45', type: 'smoke', modelName: 'Martin JEM ZR45', catalogId: 'martin-jem-zr45', dmxMode: '1-Ch', dmxChannels: 1, count: 1, x: 0, z: 2, spread: 4, dmxUniverse: 1, dmxStartChannel: 1 }])],
    ['CHAUVET STRIKE 4', makeSingleFixtureRig({ id: 'f-strike', type: 'blinder', modelName: 'CHAUVET STRIKE 4', catalogId: 'chauvet-strike-4', dmxMode: '4-Ch', dmxChannels: 4, count: 2, dmxUniverse: 1, dmxStartChannel: 1 })],
    ['Generic wash (no catalogId)', makeSingleFixtureRig({ id: 'f-gen-wash', type: 'wash', modelName: 'Generic Wash', count: 2, dmxUniverse: 1, dmxStartChannel: 1 })],
    ['Generic strobe', makeSingleFixtureRig({ id: 'f-strobe', type: 'strobe', modelName: 'Generic Strobe', count: 2, dmxUniverse: 1, dmxStartChannel: 1 })],
    ['Generic CO2', makeSingleFixtureRig(null, [{ id: 'fx-co2', type: 'co2', modelName: 'Generic CO2', count: 2, x: 0, z: 2, spread: 4, dmxUniverse: 1, dmxStartChannel: 1 }])],
    ['Laser projector', makeSingleFixtureRig({ id: 'f-laser', type: 'laser', modelName: 'KVANT Clubmax 3000 FB4', catalogId: 'kvant-clubmax', dmxMode: '16-Ch Show', dmxChannels: 16, count: 1, dmxUniverse: 1, dmxStartChannel: 1 })],
  ];

  for (const [label, rig] of hazardousConfigs) {
    const safety = physicalDmx.checkSerialTransportSafety(rig);
    assert.equal(safety.allowed, false, `${label} must be blocked by checkSerialTransportSafety`);
    const rep0 = preflight.evaluatePreflight({
      rig,
      cues: presets.SHOW_CUES,
      showState: presets.INITIAL_SHOW_STATE,
      dmxSettings: serialSettings,
    });
    const repAcked = preflight.evaluatePreflight({
      rig,
      cues: presets.SHOW_CUES,
      showState: presets.INITIAL_SHOW_STATE,
      dmxSettings: serialSettings,
      acks: acknowledgeEverything(rep0),
    });
    assert.equal(repAcked.overallStatus, 'blocked', `${label} must remain hard-blocked on serial even after acknowledging everything`);
    assert.equal(repAcked.canArm, false, `${label} must never allow arming on serial`);
  }

  // 3. Defense-in-depth byte encoding: serialOnlySafe=true zeroes ZR45 and STRIKE 4 while keeping ColorSource PAR active.
  const simBuf = new Uint8Array(512).fill(255);
  const serialBuf = new Uint8Array(512).fill(99);
  const zr45Class = physicalDmx.classifyPhysicalGroup({ catalogId: 'martin-jem-zr45', dmxMode: '1-Ch', dmxChannels: 1, type: 'smoke' });
  const strikeClass = physicalDmx.classifyPhysicalGroup({ catalogId: 'chauvet-strike-4', dmxMode: '4-Ch', dmxChannels: 4, type: 'blinder' });
  const parClass = physicalDmx.classifyPhysicalGroup({ catalogId: 'etc-colorsource-par', dmxMode: '5-Ch (Default)', dmxChannels: 5, type: 'wash' });
  assert.equal(zr45Class.personality.allowOnRendererSerial, false);
  assert.equal(strikeClass.personality.allowOnRendererSerial, false);
  assert.equal(parClass.personality.allowOnRendererSerial, true);

  physicalDmx.writePhysicalUnitBytes(serialBuf, simBuf, 1, 1, zr45Class, { blackout: false, smoke: 1.0 }, [], true);
  physicalDmx.writePhysicalUnitBytes(serialBuf, simBuf, 2, 4, strikeClass, { blackout: false, blinder: 1.0 }, [], true);
  physicalDmx.writePhysicalUnitBytes(serialBuf, simBuf, 6, 5, parClass, { blackout: false, dimmer: 1.0, r: 1.0, g: 0.5, b: 0.25 }, [], true);

  assert.equal(serialBuf[0], 0, 'ZR45 must emit 0 on serialOnlySafe buffer');
  assert.deepEqual([...serialBuf.slice(1, 5)], [0, 0, 0, 0], 'STRIKE 4 must emit 0 on serialOnlySafe buffer');
  assert.deepEqual([...serialBuf.slice(5, 10)], [255, 255, 128, 64, 0], 'ColorSource PAR remains active on serialOnlySafe buffer');
});

test('Sprint 24 (Codex SF-M1): live TOCTOU pre-flight staleness and runtime hazards trigger immediate live DMX shutdown', async () => {
  const dmxSettings = {
    mode: 'sacn',
    iface: '127.0.0.1',
    sacnMode: 'unicast',
    sacnUniverse1: 1,
    sacnUniverse2: 2,
    sacnTargets: '127.0.0.1',
    artnetBase: '0:0:0',
    artnetTargets: '127.0.0.1',
    artnetBroadcast: false,
    serialUniverse: 1,
    rateHz: 30,
  };
  const baseRig = structuredClone(presets.RIG_TEMPLATES.club_stage);
  const initial = preflight.evaluatePreflight({
    rig: baseRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings,
  });
  const acks = acknowledgeEverything(initial);
  const armedReport = preflight.evaluatePreflight({
    rig: baseRig,
    cues: presets.SHOW_CUES,
    showState: presets.INITIAL_SHOW_STATE,
    dmxSettings,
    acks,
  });
  assert.equal(armedReport.canArm, true);
  assert.equal(armedReport.stale, false);

  // Normal runtime cue Go (audienceScan: false) MUST NOT mark pre-flight stale or blocked.
  const cueGoState = { ...structuredClone(presets.SHOW_CUES[0].state), laser: { ...presets.SHOW_CUES[0].state.laser, audienceScan: false } };
  const afterCueGo = preflight.evaluatePreflight({
    rig: baseRig,
    cues: presets.SHOW_CUES,
    showState: cueGoState,
    dmxSettings,
    acks,
  });
  assert.equal(afterCueGo.stale, false);
  assert.equal(afterCueGo.overallStatus === 'blocked', false);
  assert.equal(afterCueGo.canArm, true);

  // Mutating the rig (e.g. creating a patch conflict) while live flips stale=true and records a hardBlock finding.
  const conflictRig = structuredClone(baseRig);
  conflictRig.trussPods[0].fixtures[1].dmxUniverse = conflictRig.trussPods[0].fixtures[0].dmxUniverse;
  conflictRig.trussPods[0].fixtures[1].dmxStartChannel = conflictRig.trussPods[0].fixtures[0].dmxStartChannel;
  const conflictReport = preflight.evaluatePreflight({
    rig: conflictRig,
    cues: presets.SHOW_CUES,
    showState: cueGoState,
    dmxSettings,
    acks,
  });
  assert.equal(conflictReport.stale, true);
  assert.equal(conflictReport.rows.some((r) => r.hardBlock), true);
  assert.equal(conflictReport.canArm, false);

  // Activating runtime audienceScan without mutating the rig flips overallStatus='blocked' immediately.
  const crowdScanReport = preflight.evaluatePreflight({
    rig: baseRig,
    cues: presets.SHOW_CUES,
    showState: { ...cueGoState, laser: { ...cueGoState.laser, enabled: true, audienceScan: true } },
    dmxSettings,
    acks,
  });
  assert.equal(crowdScanReport.overallStatus, 'blocked');
  assert.equal(crowdScanReport.canArm, false);

  // Codex qa-04 R2: Revoking a single warning acknowledgement while live keeps stale=false and overallStatus='warnings',
  // yet flips `canArm` to `false` immediately so `!preflightReport.canArm` shuts down live output!
  const firstAckedRowId = Object.keys(acks.acknowledgedRows)[0];
  assert.ok(firstAckedRowId, 'club_stage must have at least one acknowledged warning row');
  const revokedRows = { ...acks.acknowledgedRows };
  delete revokedRows[firstAckedRowId];
  const revokedReport = preflight.evaluatePreflight({
    rig: baseRig,
    cues: presets.SHOW_CUES,
    showState: cueGoState,
    dmxSettings,
    acks: { ...acks, acknowledgedRows: revokedRows },
  });
  assert.equal(revokedReport.stale, false);
  assert.equal(revokedReport.overallStatus, 'warnings');
  assert.equal(revokedReport.canArm, false, 'revoking a warning ack must flip canArm to false');

  // Behavioral ordering proof (Codex qa-07 R2): execute a real synchronous stop-barrier + frame-listener harness
  // where a control tick fires immediately upon `setShowState(importedLook)` (BEFORE any passive microtask/effect!).
  // Without calling `stopLiveOutputBeforeStructuralChange` prior to `setShowState`, the Strike 4 / ZR45 bytes escape.
  const runImportWithTickAtSetShowState = (useSyncBarrier) => {
    const sentFrames = [];
    let listener = (u1, u2) => {
      sentFrames.push({ u1: new Uint8Array(u1), u2: new Uint8Array(u2) });
    };
    let isLive = true;
    const strikeClass = physicalDmx.classifyPhysicalGroup({
      catalogId: 'chauvet-strike-4',
      dmxMode: '4-Ch',
      dmxChannels: 4,
      type: 'blinder',
    });
    const zr45Class = physicalDmx.classifyPhysicalGroup({
      catalogId: 'martin-jem-zr45',
      dmxMode: '1-Ch',
      dmxChannels: 1,
      type: 'smoke',
    });
    let currentLook = { blackout: false, blinderLevel: 0, smokeOutput: 0 };

    const engine = {
      setDmxFrameListener(fn) {
        listener = fn;
      },
      setShowState(nextLook) {
        currentLook = nextLook;
        // Deterministic control-loop tick BEFORE any passive React effect can run!
        const u1 = new Uint8Array(512);
        const u2 = new Uint8Array(512);
        const sim = new Uint8Array(512);
        physicalDmx.writePhysicalUnitBytes(u1, sim, 129, 4, strikeClass, {
          blackout: currentLook.blackout,
          blinder: currentLook.blinderLevel,
        });
        physicalDmx.writePhysicalUnitBytes(u2, sim, 312, 1, zr45Class, {
          blackout: currentLook.blackout,
          smoke: currentLook.smokeOutput,
        });
        listener?.(u1, u2);
      },
    };

    const stopLiveOutputBeforeStructuralChange = () => {
      if (isLive) {
        isLive = false;
        engine.setDmxFrameListener(undefined);
      }
    };

    // Initial tick at 0 output -> allowed
    engine.setShowState({ blackout: false, blinderLevel: 0, smokeOutput: 0 });
    assert.equal(sentFrames.length, 1);
    assert.ok(sentFrames[0].u1.every((b) => b === 0));
    assert.ok(sentFrames[0].u2.every((b) => b === 0));

    // Hot import with blinderLevel=1, smokeOutput=1
    if (useSyncBarrier) stopLiveOutputBeforeStructuralChange();
    engine.setShowState({ blackout: false, blinderLevel: 1, smokeOutput: 1 });
    return sentFrames;
  };

  // Control proof: WITHOUT synchronous barrier, nonzero Strike 4 (255) and ZR45 (255) bytes escape!
  const leaked = runImportWithTickAtSetShowState(false);
  assert.equal(leaked.length, 2);
  assert.deepEqual([...leaked[1].u1.slice(128, 132)], [255, 255, 255, 255]);
  assert.equal(leaked[1].u2[311], 255);

  // Guarded proof: WITH synchronous barrier, listener is detached BEFORE setShowState ticks -> zero frames escape!
  const guarded = runImportWithTickAtSetShowState(true);
  assert.equal(guarded.length, 1);

  // Also verify App.tsx's stopLiveOutputBeforeStructuralChange detaches the frame listener synchronously, both
  // `!preflightReport.canArm` and `!rep.canArm` paths invoke emergencyStopOnFault (qa-08 R3), `openViewerPayload`
  // invokes the barrier BEFORE `syncDesktopViewerMode(true)` (qa-08 R1), and normal `disable()` detaches the
  // engine listener synchronously before any await (qa-10 M-N1).
  const appSrc = await fs.readFile(path.join(repoRoot, 'src/App.tsx'), 'utf8');
  assert.match(
    appSrc,
    /const\s+stopLiveOutputBeforeStructuralChange\s*=\s*useCallback[\s\S]{0,320}?engineRef\.current\?\.setDmxFrameListener\(undefined\);[\s\S]{0,160}?dmx\.emergencyStopOnFault/,
  );
  assert.match(appSrc, /if\s*\(\s*!preflightReport\.canArm\s*\)\s*\{[\s\S]{0,400}?clearAllBumps\(\);[\s\S]{0,160}?emergencyStopOnFault/);
  assert.match(appSrc, /if\s*\(\s*rep\s*&&\s*!rep\.canArm\s*\)\s*\{[\s\S]{0,400}?emergencyStopOnFault/);

  const openViewerFnStart = appSrc.indexOf('const openViewerPayload = async');
  assert.ok(openViewerFnStart > 0);
  const viewerStopIdx = appSrc.indexOf("stopLiveOutputBeforeStructuralChange('Entered Pitch Viewer", openViewerFnStart);
  const viewerLockIdx = appSrc.indexOf('syncDesktopViewerMode(true)', openViewerFnStart);
  const viewerApplyIdx = appSrc.indexOf('applyViewerDocument(parsed)', openViewerFnStart);
  assert.ok(
    viewerStopIdx > openViewerFnStart && viewerLockIdx > viewerStopIdx && viewerApplyIdx > viewerLockIdx,
    'openViewerPayload must invoke synchronous stop barrier BEFORE syncDesktopViewerMode(true) and applyViewerDocument(parsed)',
  );

  const liveHookSrc = await fs.readFile(path.join(repoRoot, 'src/dmx/useLiveDmxOutput.ts'), 'utf8');
  const disableAction = liveHookSrc.split('const disable = useCallback(async')[1]?.split('const enable = useCallback')[0];
  assert.match(disableAction, /await\s+stopCurrentOutput\(\)/, 'the public Stop action calls the common drain');
  const stopBody = liveHookSrc.split('const stopCurrentOutput = useCallback(async () => {')[1]?.split('stopCurrentOutputRef.current =')[0];
  assert.ok(stopBody);
  const detach = stopBody.indexOf('setDmxFrameListener(undefined)');
  const firstAwait = stopBody.search(/\bawait\b/);
  assert.ok(detach >= 0 && firstAwait > detach, 'the common drain detaches StageEngine before any await');
});
