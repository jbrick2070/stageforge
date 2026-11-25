import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { createDmxController } = require('../desktop/dmx-sender.cjs');
const packets = require('../desktop/dmx-packets.cjs');

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const mod = await compiler.ssrLoadModule('/src/engine/audioModulation.ts');
const { INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { writeDmxChannels } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');
const { STATIONARY_SPREAD_THRESHOLD } = await compiler.ssrLoadModule('/src/data/laserSafety.ts');

function makeMetrics(overrides = {}) {
  const spectrum = new Float32Array(32);
  if (overrides.spectrum) {
    for (let i = 0; i < Math.min(32, overrides.spectrum.length); i++) spectrum[i] = overrides.spectrum[i];
  }
  return {
    playing: true,
    source: 'file',
    trackName: 'test.wav',
    energy: 0,
    bass: 0,
    mid: 0,
    high: 0,
    beat: false,
    beatPulse: 0,
    drop: false,
    ...overrides,
    spectrum,
  };
}

function makeMapping(overrides = {}) {
  return {
    id: 'm1',
    name: 'Test mapping',
    enabled: true,
    source: 'bass',
    target: { group: 'wash', param: 'dimmer' },
    amount: 0.5,
    attackMs: 0,
    releaseMs: 0,
    threshold: 0,
    curve: 'linear',
    ...overrides,
  };
}

test('with no mappings or Beat sync off, modulateLook returns input look unchanged and never mutates inputs', () => {
  const base = structuredClone(INITIAL_SHOW_STATE);
  const snapshot = structuredClone(base);
  const metrics = makeMetrics({ bass: 0.9, energy: 0.8, beat: true, beatPulse: 1 });
  const followers = mod.createAudioModulationState();

  // Undefined audioMap
  const r1 = mod.modulateLook(base, metrics, followers, 1 / 60);
  assert.equal(r1.look, base);
  assert.equal(r1.frame.active, false);
  assert.deepEqual(base, snapshot);

  // Empty mappings array
  const empty = { ...base, audioMap: { mappings: [] } };
  const r2 = mod.modulateLook(empty, metrics, followers, 1 / 60);
  assert.equal(r2.look, empty);
  assert.equal(r2.frame.active, false);

  // All mappings disabled
  const disabled = { ...base, audioMap: { mappings: [makeMapping({ enabled: false })] } };
  const r3 = mod.modulateLook(disabled, metrics, followers, 1 / 60);
  assert.equal(r3.look, disabled);
  assert.equal(r3.frame.active, false);

  // Master Beat sync off
  const masterOff = { ...base, audioReactive: false, audioMap: { mappings: [makeMapping()] } };
  const r4 = mod.modulateLook(masterOff, metrics, followers, 1 / 60);
  assert.equal(r4.look, masterOff);
  assert.equal(r4.frame.active, false);
});

test('attack/release envelope timing, threshold gating, band averaging, and curves match math', () => {
  // Threshold gating & curves
  assert.equal(mod.shapeAudioSignal(0.2, 0.2, 'linear'), 0);
  assert.equal(mod.shapeAudioSignal(0.1, 0.2, 'linear'), 0);
  assert.ok(Math.abs(mod.shapeAudioSignal(0.6, 0.2, 'linear') - 0.5) < 1e-6);
  assert.ok(Math.abs(mod.shapeAudioSignal(0.6, 0.2, 'square') - 0.25) < 1e-6);
  assert.ok(Math.abs(mod.shapeAudioSignal(0.6, 0.2, 'sqrt') - Math.sqrt(0.5)) < 1e-6);

  // Attack/release exponential time constants: after 1*tau, envelope reaches 1 - 1/e (~0.6321)
  const oneTauAttack = mod.stepEnvelope(0, 1, 100, 200, 0.1);
  assert.ok(Math.abs(oneTauAttack - (1 - Math.exp(-1))) < 1e-6);
  const oneTauRelease = mod.stepEnvelope(1, 0, 100, 200, 0.2);
  assert.ok(Math.abs(oneTauRelease - Math.exp(-1)) < 1e-6);

  // Band averaging over [8, 14]
  const spec = new Float32Array(32);
  for (let b = 8; b <= 14; b++) spec[b] = 0.7;
  spec[0] = 1.0; // outside range, must be ignored
  const m = makeMetrics({ spectrum: spec });
  assert.ok(Math.abs(mod.readAudioSource(m, 'band', [8, 14]) - 0.7) < 1e-6);
  assert.equal(mod.readAudioSource(makeMetrics({ playing: false, spectrum: spec }), 'band', [8, 14]), 0);

  // End-to-end purity: modulateLook advances followers without mutating caller's followers
  const look = {
    ...structuredClone(INITIAL_SHOW_STATE),
    masterDimmer: 1,
    washIntensity: 0.2,
    audioMap: {
      mappings: [makeMapping({ source: 'band', bands: [8, 14], amount: 0.6, attackMs: 100, releaseMs: 200, threshold: 0.2, curve: 'square' })],
    },
  };
  const f0 = mod.createAudioModulationState();
  const r1 = mod.modulateLook(look, m, f0, 0.1);
  assert.equal(f0.slots[0].envelope, 0, 'caller followers must not be mutated');
  const expectedTarget = Math.pow((0.7 - 0.2) / 0.8, 2);
  const expectedEnv = expectedTarget * (1 - Math.exp(-1));
  assert.ok(Math.abs(r1.followers.slots[0].envelope - expectedEnv) < 1e-5);
  assert.ok(Math.abs(r1.look.washIntensity - (0.2 + 0.6 * expectedEnv)) < 1e-5);
});

test('negative amount ducks and results clamp strictly to parameter bounds', () => {
  const look = {
    ...structuredClone(INITIAL_SHOW_STATE),
    masterDimmer: 1,
    washIntensity: 0.8,
    beamIntensity: 0.9,
    beamZoom: 0.9,
    audioMap: {
      mappings: [
        makeMapping({ id: 'duck-wash', source: 'bass', target: { group: 'wash', param: 'dimmer' }, amount: -0.6 }),
        makeMapping({ id: 'over-beam', source: 'bass', target: { group: 'beam', param: 'dimmer' }, amount: 0.8 }),
        makeMapping({ id: 'over-zoom', source: 'energy', target: { group: 'beam', param: 'zoom' }, amount: 0.8 }),
      ],
    },
  };
  const metrics = makeMetrics({ bass: 1, energy: 1 });
  const res = mod.modulateLook(look, metrics, mod.createAudioModulationState(), 1 / 60);
  assert.ok(Math.abs(res.look.washIntensity - 0.2) < 1e-6, 'negative amount ducks 0.8 - 0.6 = 0.2');
  assert.equal(res.look.beamIntensity, 1.0, 'beam dimmer clamps at 1');
  assert.equal(res.look.beamZoom, 1.0, 'zoom clamps at 1');

  // Extreme ducking clamps at 0
  const duckZero = {
    ...look,
    washIntensity: 0.2,
    audioMap: { mappings: [makeMapping({ id: 'duck-hard', amount: -1 })] },
  };
  const resZero = mod.modulateLook(duckZero, metrics, mod.createAudioModulationState(), 1 / 60);
  assert.equal(resZero.look.washIntensity, 0);
});

test('blackout and master dimmer always win over audio modulation (and modulateLook never double-applies master or sets legacy strobeRate)', () => {
  const baseLook = {
    ...structuredClone(INITIAL_SHOW_STATE),
    masterDimmer: 0.5,
    blackout: false,
    washIntensity: 0.5,
    beamIntensity: 0.5,
    blinderLevel: 0.2,
    strobeRate: 0.6,
    led: { ...INITIAL_SHOW_STATE.led, enabled: true, brightness: 0.5 },
    laser: { ...INITIAL_SHOW_STATE.laser, enabled: true, intensity: 0.8, strobe: 0.5 },
    audioMap: {
      mappings: [
        makeMapping({ id: 'w', source: 'bass', target: { group: 'wash', param: 'dimmer' }, amount: 1 }),
        makeMapping({ id: 'b', source: 'bass', target: { group: 'beam', param: 'dimmer' }, amount: 1 }),
        makeMapping({ id: 'bl', source: 'bass', target: { group: 'blinder', param: 'dimmer' }, amount: 1 }),
        makeMapping({ id: 'st', source: 'high', target: { group: 'strobe', param: 'strobe' }, amount: 1 }),
        makeMapping({ id: 'ld', source: 'bass', target: { group: 'ledWall', param: 'brightness' }, amount: 1 }),
        makeMapping({ id: 'ls', source: 'bass', target: { group: 'laser', param: 'intensity' }, amount: 1 }),
        makeMapping({ id: 'lst', source: 'high', target: { group: 'laser', param: 'strobe' }, amount: 1 }),
      ],
    },
  };
  const loud = makeMetrics({ bass: 1, high: 1, energy: 1 });

  // Engine-side effective output helper matching StageEngine.updateScene formulas
  const effectiveFrom = (look, frame) => {
    const master = look.blackout ? 0 : look.masterDimmer;
    return {
      wash: frame.wash.dimmer * master,
      beam: frame.beam.dimmer * master,
      blinder: frame.blinder.dimmer * master,
      strobeOn: frame.strobeBar.strobe.gateOn && master > 0 ? 1 : 0,
      led: frame.ledWall.brightness * master,
      laser: (look.laser.enabled ? frame.laser.intensity : 0) * master * (frame.laser.strobe.gateOn ? 1 : 0),
    };
  };

  // Blackout forces all engine outputs and telemetry entries to 0
  const blackLook = { ...baseLook, blackout: true };
  const blacked = mod.modulateLook(blackLook, loud, mod.createAudioModulationState(), 1 / 60);
  const blackEff = effectiveFrom(blackLook, blacked.frame);
  assert.equal(blackEff.wash, 0);
  assert.equal(blackEff.beam, 0);
  assert.equal(blackEff.blinder, 0);
  assert.equal(blackEff.strobeOn, 0);
  assert.equal(blackEff.led, 0);
  assert.equal(blackEff.laser, 0);
  for (let i = 0; i < blacked.frame.entryCount; i++) {
    assert.equal(blacked.frame.entries[i].modulatedValue, 0);
  }

  // Master dimmer = 0 forces all engine outputs and telemetry entries to 0
  const zeroLook = { ...baseLook, masterDimmer: 0 };
  const zeroMaster = mod.modulateLook(zeroLook, loud, mod.createAudioModulationState(), 1 / 60);
  const zeroEff = effectiveFrom(zeroLook, zeroMaster.frame);
  assert.equal(zeroEff.wash, 0);
  assert.equal(zeroEff.blinder, 0);
  assert.equal(zeroEff.led, 0);
  assert.equal(zeroEff.laser, 0);
  for (let i = 0; i < zeroMaster.frame.entryCount; i++) {
    assert.equal(zeroMaster.frame.entries[i].modulatedValue, 0);
  }

  // M4: modulateLook keeps pre-master channel values (no double-master), keeps strobeRate = 0 & laser.strobe = 0 when mapped,
  // while engine output scales cleanly by master = 0.5.
  const halfMaster = mod.modulateLook(baseLook, loud, mod.createAudioModulationState(), 1 / 60);
  assert.equal(halfMaster.look.washIntensity, 1.0, 'pre-master channel value not prematurely scaled by masterDimmer');
  assert.equal(halfMaster.look.strobeRate, 0, 'mapped strobe must never emit legacy strobeRate = 1');
  assert.equal(halfMaster.look.laser.strobe, 0, 'mapped laser strobe must zero legacy laser shader strobe');
  const halfEff = effectiveFrom(baseLook, halfMaster.frame);
  assert.ok(Math.abs(halfEff.wash - 0.5) < 1e-6);
  assert.ok(Math.abs(halfEff.led - 0.5) < 1e-6);
  assert.ok(Math.abs(halfEff.laser - 0.4) < 1e-6);
});

test('photosensitivity flash limiter caps strobe triggers and blinder dimmers at <= 3 full flashes/s across dt steps', () => {
  // Part A: Triggered strobe (beam.strobe & strobe.strobe) under 10 Hz square wave across dt = 1/240, 1/60, 0.08
  for (const dt of [1 / 240, 1 / 60, 0.08]) {
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      audioMap: {
        mappings: [
          makeMapping({ id: 'st', source: 'high', target: { group: 'beam', param: 'strobe' }, amount: 1, attackMs: 0, releaseMs: 0 }),
        ],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    const flashTimesMs = [];
    let prevGate = false;
    let sawLimited = false;
    const totalSteps = Math.round(5 / dt);
    for (let s = 0; s < totalSteps; s++) {
      const t = s * dt;
      const on = (t % 0.1) < 0.05; // 10 Hz square wave
      mod.evaluateAudioModulation(look, makeMetrics({ high: on ? 1 : 0 }), state, dt, frame);
      if (frame.beam.strobe.gateOn && !prevGate) flashTimesMs.push(state.clockMs);
      prevGate = frame.beam.strobe.gateOn;
      if (frame.flashLimited) sawLimited = true;
    }
    assert.equal(sawLimited, true, `flash limiter must engage at 10 Hz (dt=${dt})`);
    assert.ok(flashTimesMs.length >= 6, `strobe must still flash regularly (got ${flashTimesMs.length} at dt=${dt})`);
    for (let i = 0; i < flashTimesMs.length; i++) {
      const inWindow = flashTimesMs.filter((ms) => ms >= flashTimesMs[i] && ms < flashTimesMs[i] + 1000);
      assert.ok(inWindow.length <= 3, `at most 3 flashes per 1 s window (got ${inWindow.length} at dt=${dt})`);
    }
  }

  // 2 Hz pulse train passes through untouched with zero limiting
  {
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      audioMap: {
        mappings: [
          makeMapping({ id: 'st2', source: 'high', target: { group: 'beam', param: 'strobe' }, amount: 1, attackMs: 0, releaseMs: 0 }),
        ],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    let flashes = 0;
    let prevGate = false;
    let sawLimited = false;
    const dt = 1 / 60;
    for (let s = 0; s < 300; s++) {
      const on = (s * dt) % 0.5 < 0.1; // 2 Hz
      mod.evaluateAudioModulation(look, makeMetrics({ high: on ? 1 : 0 }), state, dt, frame);
      if (frame.beam.strobe.gateOn && !prevGate) flashes++;
      prevGate = frame.beam.strobe.gateOn;
      if (frame.flashLimited) sawLimited = true;
    }
    assert.equal(sawLimited, false, '2 Hz pulse train must not engage flash limiter');
    assert.ok(flashes >= 9 && flashes <= 11, `expected ~10 flashes in 5 s at 2 Hz, got ${flashes}`);
  }

  // Part B: Continuous blinder dimmer under 10 Hz square wave: <= 3 full flashes (<=0.2 -> >=0.8 -> <=0.2) per second
  {
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      blinderLevel: 0,
      audioMap: {
        mappings: [
          makeMapping({ id: 'bl', source: 'bass', target: { group: 'blinder', param: 'dimmer' }, amount: 1, attackMs: 0, releaseMs: 0 }),
        ],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    const dt = 1 / 60;
    const fullFlashTimesMs = [];
    let phase = 'low';
    let sawLimited = false;
    for (let s = 0; s < 300; s++) {
      const on = (s * dt) % 0.1 < 0.05; // 10 Hz
      mod.evaluateAudioModulation(look, makeMetrics({ bass: on ? 1 : 0 }), state, dt, frame);
      if (frame.flashLimited) sawLimited = true;
      const v = frame.blinder.dimmer;
      if (phase === 'low' && v >= 0.8) phase = 'high';
      else if (phase === 'high' && v <= 0.2) {
        phase = 'low';
        fullFlashTimesMs.push(state.clockMs);
      }
    }
    assert.equal(sawLimited, true, 'blinder slew limiter must engage at 10 Hz');
    for (let i = 0; i < fullFlashTimesMs.length; i++) {
      const inWindow = fullFlashTimesMs.filter((ms) => ms >= fullFlashTimesMs[i] && ms < fullFlashTimesMs[i] + 1000);
      assert.ok(inWindow.length <= 3, `blinder full flashes <= 3/s (got ${inWindow.length})`);
    }
  }
});

test('laser safety invariants: cannot enable laser or audienceScan, intensity/spread/rotation <= base, speed >= base, haze slow limits enforced', () => {
  const loud = makeMetrics({ bass: 1, high: 1, energy: 1 });

  // Disabled laser stays disabled and at 0 intensity
  const laserOff = {
    ...structuredClone(INITIAL_SHOW_STATE),
    masterDimmer: 1,
    laser: { ...INITIAL_SHOW_STATE.laser, enabled: false, audienceScan: false, intensity: 0.7 },
    audioMap: {
      mappings: [
        makeMapping({ id: 'li', source: 'bass', target: { group: 'laser', param: 'intensity' }, amount: 1 }),
        makeMapping({ id: 'ls', source: 'high', target: { group: 'laser', param: 'strobe' }, amount: 1 }),
      ],
    },
  };
  const resOff = mod.modulateLook(laserOff, loud, mod.createAudioModulationState(), 1 / 60);
  assert.equal(resOff.look.laser.enabled, false);
  assert.equal(resOff.look.laser.audienceScan, false);
  assert.equal(resOff.look.laser.intensity, 0);

  // Enabled laser: intensity <= look.laser.intensity, spread in [0.1, base], rotation <= base, speed >= base, audienceScan unchanged
  const laserOn = {
    ...structuredClone(INITIAL_SHOW_STATE),
    masterDimmer: 1,
    laser: {
      ...INITIAL_SHOW_STATE.laser,
      enabled: true,
      audienceScan: false,
      intensity: 0.6,
      spreadX: 0.5,
      spreadY: 0.4,
      rotation: 0.3,
      speed: 0.4,
    },
    audioMap: {
      mappings: [
        makeMapping({ id: 'li', source: 'bass', target: { group: 'laser', param: 'intensity' }, amount: 0.8 }),
        makeMapping({ id: 'lsp', source: 'bass', target: { group: 'laser', param: 'spread' }, amount: 1 }),
        makeMapping({ id: 'lr', source: 'bass', target: { group: 'laser', param: 'rotation' }, amount: 0.9 }),
        makeMapping({ id: 'lvd', source: 'bass', target: { group: 'laser', param: 'speed' }, amount: -0.5 }), // forced negative at runtime
      ],
    },
  };
  const quiet = makeMetrics({ bass: 0 });
  const rQuiet = mod.modulateLook(laserOn, quiet, mod.createAudioModulationState(), 1 / 60);
  const rLoud = mod.modulateLook(laserOn, loud, mod.createAudioModulationState(), 1 / 60);
  assert.equal(rLoud.look.laser.audienceScan, false);
  assert.ok(rQuiet.look.laser.intensity < 0.6 && rQuiet.look.laser.intensity >= 0, 'positive laser intensity rests below base when quiet');
  assert.ok(Math.abs(rLoud.look.laser.intensity - 0.6) < 1e-6, 'laser intensity peaks at look.laser.intensity, never exceeds');
  assert.ok(rQuiet.look.laser.spreadX >= 0.1 && rQuiet.look.laser.spreadX > STATIONARY_SPREAD_THRESHOLD, 'laser spread stays above stationary threshold');
  assert.ok(rLoud.look.laser.spreadX <= 0.5 && rLoud.look.laser.spreadY <= 0.4, 'laser spread never widens past look');
  assert.ok(rQuiet.look.laser.rotation < 0.3 && rLoud.look.laser.rotation <= 0.3, 'laser rotation scales <= base');
  assert.ok(rLoud.look.laser.speed >= 0.4, 'laser speed never slows below base even with forced negative amount');

  // Per-projector laser mapping isolates that projector and obeys ceiling
  const projKey = '["pod-back","f-lasers",1]';
  const perProj = {
    ...laserOn,
    audioMap: {
      mappings: [
        makeMapping({ id: 'lp1', source: 'bass', target: { group: 'laser', param: 'intensity', projectorKey: projKey }, amount: 1 }),
      ],
    },
  };
  const rProjQuiet = mod.modulateLook(perProj, quiet, mod.createAudioModulationState(), 1 / 60);
  assert.equal(rProjQuiet.frame.laser.projectors[projKey].intensity, 0);
  assert.equal(rProjQuiet.frame.laser.intensity, 0.6, 'other projectors keep base intensity');

  // Haze enforces minimum 1000 ms attack and 2000 ms release even if shorter values are passed
  const hazeLook = {
    ...structuredClone(INITIAL_SHOW_STATE),
    atmo: { ...INITIAL_SHOW_STATE.atmo, hazeLevel: 0.2 },
    audioMap: {
      mappings: [
        makeMapping({ id: 'hz', source: 'energy', target: { group: 'haze', param: 'dimmer' }, amount: 0.8, attackMs: 5, releaseMs: 10 }),
      ],
    },
  };
  const rHaze = mod.modulateLook(hazeLook, loud, mod.createAudioModulationState(), 0.05);
  // 50 ms with 1000 ms tau -> 1 - exp(-0.05) ~= 0.0488 (nowhere near 1.0!)
  assert.ok(rHaze.followers.slots[0].envelope < 0.06, `haze attack must be slow (got ${rHaze.followers.slots[0].envelope})`);
});

test('DMX loopback on 127.0.0.1 receives modulated wash dimmer bytes matching the audio envelope', async () => {
  const sock = dgram.createSocket('udp4');
  const received = [];
  await new Promise((resolve, reject) => {
    sock.on('message', (msg) => received.push(Buffer.from(msg)));
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', resolve);
  });
  const port = sock.address().port;
  const controller = createDmxController({
    testPorts: { artnet: port },
    blackoutPaceMs: 24,
  });

  try {
    await controller.enable({
      protocol: 'artnet',
      iface: '127.0.0.1',
      rateHz: 40,
      artnet: { base: 0, targets: ['127.0.0.1'], broadcast: false },
    }, 1);

    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      washIntensity: 0.2,
      audioMap: {
        mappings: [
          makeMapping({ id: 'kick-wash', source: 'bass', target: { group: 'wash', param: 'dimmer' }, amount: 0.7, attackMs: 0, releaseMs: 0 }),
        ],
      },
    };
    const u1 = new Uint8Array(512);
    const sendState = (bass) => {
      const res = mod.modulateLook(look, makeMetrics({ bass }), mod.createAudioModulationState(), 1 / 60);
      const dimmerByte = Math.round(res.look.washIntensity * 255);
      writeDmxChannels(u1, 1, 8, [128, 128, dimmerByte, 255, 255, 255, 50, 0]);
      controller.update(1, u1);
      return dimmerByte;
    };

    const quietByte = sendState(0); // 0.2 * 255 = 51
    await new Promise((r) => setTimeout(r, 80));
    const loudByte = sendState(1); // 0.9 * 255 = 230
    await new Promise((r) => setTimeout(r, 80));

    const artDmxValues = received
      .map((buf) => packets.decodeArtDmxPacket(buf))
      .filter((p) => p && p.portAddress === 0)
      .map((p) => p.slots[2]);
    assert.ok(artDmxValues.includes(quietByte), `loopback DMX must include quiet byte ${quietByte}`);
    assert.ok(artDmxValues.includes(loudByte), `loopback DMX must include loud byte ${loudByte}`);
  } finally {
    await controller.shutdown('disable');
    await new Promise((done) => sock.close(done));
  }
});

test('QA regressions (H1, M1, M2, M5): zero-dt inertia, combined room flash budget, dimmer slew cap, refractory persistence, per-projector laser & slot reuse', () => {
  // M1: dt <= 0 or NaN never snaps envelope (especially haze with 1000 ms attack)
  assert.equal(mod.stepEnvelope(0.2, 1.0, 1000, 2000, 0), 0.2);
  assert.equal(mod.stepEnvelope(0.2, 1.0, 1000, 2000, -0.05), 0.2);
  assert.equal(mod.stepEnvelope(0.2, 1.0, 1000, 2000, Number.NaN), 0.2);
  assert.equal(mod.stepEnvelope(0.2, 1.0, 0, 0, 0), 0.2, 'zero dt holds prev even when tauMs === 0');

  // H1 Part A: Staggered beam, wash, strobe-bar, and laser strobes share one combined <= 3/s room flash budget
  {
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      laser: { ...INITIAL_SHOW_STATE.laser, enabled: true, intensity: 0.8 },
      audioMap: {
        mappings: [
          makeMapping({ id: 'sb', source: 'band', bands: [0, 0], target: { group: 'beam', param: 'strobe' }, amount: 1 }),
          makeMapping({ id: 'sw', source: 'band', bands: [1, 1], target: { group: 'wash', param: 'strobe' }, amount: 1 }),
          makeMapping({ id: 'sr', source: 'band', bands: [2, 2], target: { group: 'strobe', param: 'strobe' }, amount: 1 }),
          makeMapping({ id: 'sl', source: 'band', bands: [3, 3], target: { group: 'laser', param: 'strobe' }, amount: 1 }),
        ],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    const dt = 0.02; // 50 Hz
    const roomFlashTimesMs = [];
    let sawLimited = false;
    let prevB = false, prevW = false, prevR = false, prevL = false;
    for (let step = 0; step < 250; step++) {
      // Trigger bands 0, 1, 2, 3 staggered every 80 ms (12.5 Hz combined across 4 targets!)
      const spec = new Float32Array(32);
      const slot = Math.floor(step / 4) % 4;
      if (step % 4 === 0) spec[slot] = 1;
      mod.evaluateAudioModulation(look, makeMetrics({ spectrum: spec }), state, dt, frame);
      if (frame.flashLimited) sawLimited = true;
      const anyEdge =
        (frame.beam.strobe.gateOn && !prevB) ||
        (frame.wash.strobe.gateOn && !prevW) ||
        (frame.strobeBar.strobe.gateOn && !prevR) ||
        (frame.laser.strobe.gateOn && !prevL);
      if (anyEdge) roomFlashTimesMs.push(state.clockMs);
      prevB = frame.beam.strobe.gateOn;
      prevW = frame.wash.strobe.gateOn;
      prevR = frame.strobeBar.strobe.gateOn;
      prevL = frame.laser.strobe.gateOn;
    }
    assert.equal(sawLimited, true, 'staggered multi-target strobes must engage combined flash limiter');
    for (let i = 0; i < roomFlashTimesMs.length; i++) {
      const inWindow = roomFlashTimesMs.filter((ms) => ms >= roomFlashTimesMs[i] && ms < roomFlashTimesMs[i] + 1000);
      assert.ok(inWindow.length <= 3, `combined room flashes must be <= 3/s (got ${inWindow.length})`);
    }
  }

  // H1 Part B: Wash, beam, LED wall, and laser intensity targets driven at 8 Hz with attack/release 0 are slew-limited <= 3/s
  for (const [group, param, readVal] of [
    ['wash', 'dimmer', (f) => f.wash.dimmer],
    ['beam', 'dimmer', (f) => f.beam.dimmer],
    ['ledWall', 'brightness', (f) => f.ledWall.brightness],
    ['laser', 'intensity', (f) => f.laser.intensity],
  ]) {
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      washIntensity: 0,
      beamIntensity: 0,
      led: { ...INITIAL_SHOW_STATE.led, enabled: true, brightness: 0 },
      laser: { ...INITIAL_SHOW_STATE.laser, enabled: true, intensity: 1 },
      audioMap: {
        mappings: [makeMapping({ id: `fast-${group}`, source: 'high', target: { group, param }, amount: 1, attackMs: 0, releaseMs: 0 })],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    const dt = 1 / 60;
    const flashTimesMs = [];
    let phase = 'low';
    let sawLimited = false;
    for (let s = 0; s < 300; s++) {
      const on = (s * dt) % 0.125 < 0.0625; // 8 Hz square wave
      mod.evaluateAudioModulation(look, makeMetrics({ high: on ? 1 : 0 }), state, dt, frame);
      if (frame.flashLimited) sawLimited = true;
      const v = readVal(frame);
      if (phase === 'low' && v >= 0.8) phase = 'high';
      else if (phase === 'high' && v <= 0.2) {
        phase = 'low';
        flashTimesMs.push(state.clockMs);
      }
    }
    assert.equal(sawLimited, true, `${group}.${param} must engage flash limiter at 8 Hz`);
    for (let i = 0; i < flashTimesMs.length; i++) {
      const inWindow = flashTimesMs.filter((ms) => ms >= flashTimesMs[i] && ms < flashTimesMs[i] + 1000);
      assert.ok(inWindow.length <= 3, `${group}.${param} full flashes must be <= 3/s (got ${inWindow.length})`);
    }
  }

  // M2: Refractory timer persists across Beat sync toggle and cue A -> B -> A switch (< 334 ms blocked, >= 334 ms allowed)
  {
    const cueA = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      audioMap: { mappings: [makeMapping({ id: 'st', source: 'high', target: { group: 'beam', param: 'strobe' }, amount: 1 })] },
    };
    const cueB = { ...structuredClone(INITIAL_SHOW_STATE), masterDimmer: 1 };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();

    // Flash 1 at t = 20 ms
    mod.evaluateAudioModulation(cueA, makeMetrics({ high: 1 }), state, 0.02, frame);
    assert.equal(frame.beam.strobe.gateOn, true, 'first flash fires');
    // Toggle Beat sync OFF for 40 ms, then back ON at t = 80 ms (< 334 ms after flash 1)
    mod.evaluateAudioModulation({ ...cueA, audioReactive: false }, makeMetrics({ high: 0 }), state, 0.04, frame);
    assert.equal(frame.active, false);
    mod.evaluateAudioModulation(cueA, makeMetrics({ high: 1 }), state, 0.02, frame);
    assert.equal(frame.beam.strobe.gateOn, false, 'Beat sync toggle must not bypass 334 ms refractory');
    assert.equal(frame.flashLimited, true, 'bypass attempt must raise flashLimited');

    // Switch to unmapped cue B for 40 ms, then back to cue A at t = 140 ms (still < 334 ms)
    mod.evaluateAudioModulation(cueB, makeMetrics({ high: 0 }), state, 0.04, frame);
    mod.evaluateAudioModulation(cueA, makeMetrics({ high: 1 }), state, 0.02, frame);
    assert.equal(frame.beam.strobe.gateOn, false, 'cue switch A->B->A within 334 ms must not bypass refractory');

    // Wait 360 ms quiet so refractory expires & gate rearms, then fire Flash 2
    mod.evaluateAudioModulation(cueA, makeMetrics({ high: 0 }), state, 0.36, frame);
    mod.evaluateAudioModulation(cueA, makeMetrics({ high: 1 }), state, 0.02, frame);
    assert.equal(frame.beam.strobe.gateOn, true, 'after >= 334 ms, next flash fires normally');
  }

  // Per-projector laser behavior: disabled laser, composed global+projector factor, per-projector strobe & clean removal
  {
    const pKey = '["pod-back","f-us-lasers",1]';
    const look = {
      ...structuredClone(INITIAL_SHOW_STATE),
      masterDimmer: 1,
      laser: { ...INITIAL_SHOW_STATE.laser, enabled: true, intensity: 0.8, rotation: 0.5 },
      audioMap: {
        mappings: [
          makeMapping({ id: 'g-rot', source: 'bass', target: { group: 'laser', param: 'rotation' }, amount: 0.5 }),
          makeMapping({ id: 'p-rot', source: 'mid', target: { group: 'laser', param: 'rotation', projectorKey: pKey }, amount: 0.5 }),
          makeMapping({ id: 'p-st', source: 'high', target: { group: 'laser', param: 'strobe', projectorKey: pKey }, amount: 1 }),
        ],
      },
    };
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    // Both quiet -> global factor 0.5, proj factor 0.5 -> composed 0.25 * 0.5 = 0.125 (<= base 0.5)
    mod.evaluateAudioModulation(look, makeMetrics({ bass: 0, mid: 0, high: 1 }), state, 0.02, frame);
    assert.ok(Math.abs(frame.laser.rotation - 0.25) < 1e-6);
    assert.ok(Math.abs(frame.laser.projectors[pKey].rotation - 0.125) < 1e-6);
    assert.equal(frame.laser.projectors[pKey].strobe.gateOn, true);

    // Disabled laser forces projector intensity to 0
    mod.evaluateAudioModulation({ ...look, laser: { ...look.laser, enabled: false } }, makeMetrics({ bass: 1, mid: 1 }), state, 0.02, frame);
    assert.equal(frame.laser.projectors[pKey].intensity, 0);

    // Pass 2 M1 regression: Beat sync off -> on must restore per-projector overrides cleanly (no stale projFlags)
    mod.evaluateAudioModulation({ ...look, audioReactive: false }, makeMetrics({ bass: 0, mid: 0, high: 0 }), state, 0.02, frame);
    assert.equal(frame.active, false);
    assert.equal(frame.laser.projectors[pKey], undefined);
    mod.evaluateAudioModulation(look, makeMetrics({ bass: 0, mid: 0, high: 0 }), state, 0.02, frame);
    assert.ok(frame.laser.projectors[pKey], 'per-projector override must re-activate after Beat sync off -> on');
    assert.ok(Math.abs(frame.laser.projectors[pKey].rotation - 0.125) < 1e-6);

    // Removing projector mapping clears out.laser.projectors cleanly
    const noProjLook = { ...look, audioMap: { mappings: [look.audioMap.mappings[0]] } };
    mod.evaluateAudioModulation(noProjLook, makeMetrics({ bass: 1 }), state, 0.02, frame);
    assert.equal(frame.laser.projectors[pKey], undefined);
  }

  // Slot reuse: reorder, disable, and delete leave zero stale envelope
  {
    const mA = makeMapping({ id: 'map-a', source: 'bass', target: { group: 'wash', param: 'dimmer' }, amount: 0.5, attackMs: 0, releaseMs: 500 });
    const mB = makeMapping({ id: 'map-b', source: 'high', target: { group: 'beam', param: 'dimmer' }, amount: 0.5, attackMs: 0, releaseMs: 500 });
    const state = mod.createAudioModulationState();
    const frame = mod.createAudioModulationFrame();
    const base = structuredClone(INITIAL_SHOW_STATE);

    mod.evaluateAudioModulation({ ...base, audioMap: { mappings: [mA, mB] } }, makeMetrics({ bass: 1, high: 0 }), state, 0.02, frame);
    assert.equal(state.slots[0].envelope, 1);
    assert.equal(state.slots[1].envelope, 0);

    // Reorder [mB, mA]: neither slot inherits the other's envelope
    mod.evaluateAudioModulation({ ...base, audioMap: { mappings: [mB, mA] } }, makeMetrics({ bass: 0, high: 0 }), state, 0.02, frame);
    assert.equal(state.slots[0].id, 'map-b');
    assert.equal(state.slots[0].envelope, 0);
    assert.equal(state.slots[1].id, 'map-a');
    assert.equal(state.slots[1].envelope, 0);

    // Charge mA then disable it -> envelope immediately clears to 0
    mod.evaluateAudioModulation({ ...base, audioMap: { mappings: [mA, mB] } }, makeMetrics({ bass: 1, high: 0 }), state, 0.02, frame);
    assert.equal(state.slots[0].envelope, 1);
    mod.evaluateAudioModulation({ ...base, audioMap: { mappings: [{ ...mA, enabled: false }, mB] } }, makeMetrics({ bass: 1, high: 0 }), state, 0.02, frame);
    assert.equal(state.slots[0].envelope, 0);

    // Delete mA leaving only [mB] -> slot 1 is cleared
    mod.evaluateAudioModulation({ ...base, audioMap: { mappings: [mB] } }, makeMetrics({ bass: 1, high: 0 }), state, 0.02, frame);
    assert.equal(state.slots[0].id, 'map-b');
    assert.equal(state.slots[1].id, '');
    assert.equal(state.slots[1].envelope, 0);
  }
});
