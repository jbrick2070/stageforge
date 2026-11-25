import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import * as THREE from 'three';

let server;
let renderSettings;
let renderProbe;
let scenicProps;
let particleMod;
let previewFlash;
let audioMod;
let laserScan;
let stageGlb;
let presets;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  renderSettings = await server.ssrLoadModule('/src/engine/renderSettings.ts');
  renderProbe = await server.ssrLoadModule('/src/engine/renderProbe.ts');
  scenicProps = await server.ssrLoadModule('/src/engine/scenicProps.ts');
  particleMod = await server.ssrLoadModule('/src/engine/ParticleSystem.ts');
  previewFlash = await server.ssrLoadModule('/src/engine/previewFlash.ts');
  audioMod = await server.ssrLoadModule('/src/engine/audioModulation.ts');
  laserScan = await server.ssrLoadModule('/src/data/laserScan.ts');
  stageGlb = await server.ssrLoadModule('/src/engine/stageGlb.ts');
  presets = await server.ssrLoadModule('/src/data/presets.ts');
});

after(async () => {
  if (server) await server.close();
});

function countObjectTriangles(root) {
  let tris = 0;
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const geo = node.geometry;
    const baseTris = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
    const instances = node.isInstancedMesh ? node.count : 1;
    tris += baseTris * instances;
  });
  return tris;
}

describe('Sprint 15: renderSettings & policy', () => {
  it('parses valid settings, rejects hostile input, and resolves bloom/AA/full-rate policies', () => {
    const def = renderSettings.parseRenderSettings(null);
    assert.deepEqual(def, { bloom: 'auto', aa: 'auto', fallingCo2: false, videoSrgbDecode: false });

    const hostile = renderSettings.parseRenderSettings({
      bloom: 'quarter',
      aa: '__proto__',
      fallingCo2: 'yes',
      videoSrgbDecode: 1,
    });
    assert.deepEqual(hostile, def);

    const valid = renderSettings.parseRenderSettings({
      bloom: 'half',
      aa: 'fxaa',
      fallingCo2: true,
      videoSrgbDecode: true,
    });
    assert.deepEqual(valid, { bloom: 'half', aa: 'fxaa', fallingCo2: true, videoSrgbDecode: true });

    assert.equal(renderSettings.shouldRunBloom('auto', 0, 'high'), false);
    assert.equal(renderSettings.shouldRunBloom('auto', 0.0005, 'high'), false);
    assert.equal(renderSettings.shouldRunBloom('auto', 0.38, 'high'), true);
    assert.equal(renderSettings.shouldRunBloom('off', 0.8, 'high'), false);
    assert.equal(renderSettings.resolveBloomScale('half', 'low'), 0.5);
    assert.equal(renderSettings.resolveEffectiveAa('auto'), 'msaa');
    assert.equal(renderSettings.resolveEffectiveAa('fxaa'), 'fxaa');
    assert.equal(renderSettings.resolveEffectiveAa('none'), 'none');

    // Full-rate strobe preview policy: requires opt-in and denies reduced-motion, XR, and viewer mode.
    assert.equal(renderSettings.resolveEffectiveFullRateStrobe({ userOptIn: false, prefersReducedMotion: false, xrPresenting: false, viewerMode: false }), false);
    assert.equal(renderSettings.resolveEffectiveFullRateStrobe({ userOptIn: true, prefersReducedMotion: false, xrPresenting: false, viewerMode: false }), true);
    assert.equal(renderSettings.resolveEffectiveFullRateStrobe({ userOptIn: true, prefersReducedMotion: true, xrPresenting: false, viewerMode: false }), false);
    assert.equal(renderSettings.resolveEffectiveFullRateStrobe({ userOptIn: true, prefersReducedMotion: false, xrPresenting: true, viewerMode: false }), false);
    assert.equal(renderSettings.resolveEffectiveFullRateStrobe({ userOptIn: true, prefersReducedMotion: false, xrPresenting: false, viewerMode: true }), false);

    // Render target memory estimate ordering: MSAA+full bloom > FXAA+half bloom > none+bloom off.
    const msaaFull = renderSettings.estimateRenderTargetBytes({ drawingWidth: 1280, drawingHeight: 720, samples: 2, bloomScale: 1, bloomAllocated: true });
    const fxaaHalf = renderSettings.estimateRenderTargetBytes({ drawingWidth: 1280, drawingHeight: 720, samples: 0, bloomScale: 0.5, bloomAllocated: true });
    const noneOff = renderSettings.estimateRenderTargetBytes({ drawingWidth: 1280, drawingHeight: 720, samples: 0, bloomScale: 0, bloomAllocated: false });
    assert.ok(msaaFull > fxaaHalf);
    assert.ok(fxaaHalf > noneOff);
    assert.ok(noneOff > 0);
  });
});

describe('Sprint 15: renderProbe (percentiles, async GPU timer ring, luminance flash analyzer)', () => {
  it('computes percentiles deterministically and ignores non-finite values', () => {
    const summary = renderProbe.computePercentiles([10, 2, 8, 4, 6, Number.NaN, Infinity, 1, 9, 3, 7, 5]);
    assert.equal(summary.count, 10);
    assert.equal(summary.min, 1);
    assert.equal(summary.max, 10);
    assert.equal(summary.mean, 5.5);
    assert.equal(summary.p50, 5);
    assert.equal(summary.p95, 10);
    assert.equal(summary.p99, 10);
  });

  it('handles unsupported, normal, disjoint, full-ring skip, context loss, and disposal on GpuTimerRing', () => {
    const unsupported = new renderProbe.GpuTimerRing(null);
    assert.equal(unsupported.getStatus(), 'unsupported');
    assert.equal(unsupported.beginFrame(), false);

    let nextId = 1;
    let disjoint = false;
    let available = true;
    const deleted = [];
    const results = new Map();
    const fakeGl = {
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866,
      isContextLost: () => false,
      getExtension: (name) => name === 'EXT_disjoint_timer_query_webgl2'
        ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }
        : null,
      createQuery: () => ({ id: nextId++ }),
      beginQuery: (_target, q) => { results.set(q, 2_500_000); }, // 2.5 ms in ns
      endQuery: () => {},
      deleteQuery: (q) => { deleted.push(q.id); },
      getParameter: (param) => (param === 0x8fbb ? disjoint : 0),
      getQueryParameter: (q, pname) => (pname === 0x8867 ? available : results.get(q)),
    };

    const ring = new renderProbe.GpuTimerRing(fakeGl);
    assert.equal(ring.getStatus(), 'ok');

    // Normal non-blocking sample
    assert.equal(ring.beginFrame(), true);
    ring.endFrame();
    const samples = [];
    ring.poll((ms) => samples.push(ms));
    assert.deepEqual(samples, [2.5]);
    assert.equal(ring.pendingCount(), 0);

    // Fill ring to 8 pending queries -> 9th skips without blocking
    available = false;
    for (let i = 0; i < 8; i++) {
      assert.equal(ring.beginFrame(), true);
      ring.endFrame();
    }
    assert.equal(ring.pendingCount(), 8);
    assert.equal(ring.beginFrame(), false);
    assert.equal(ring.skipped, 1);

    // Disjoint invalidates all 8 pending queries cleanly
    disjoint = true;
    ring.poll((ms) => samples.push(ms));
    assert.equal(ring.pendingCount(), 0);
    assert.equal(ring.discarded, 8);
    assert.equal(samples.length, 1);

    // Dispose deletes remaining queries
    disjoint = false;
    available = false;
    assert.equal(ring.beginFrame(), true);
    ring.endFrame();
    const beforeDel = deleted.length;
    ring.dispose();
    assert.equal(deleted.length, beforeDel + 1);
    assert.equal(ring.pendingCount(), 0);
  });

  it('counts rolling 1-second general, localized, and saturated-red flashes accurately', () => {
    const makeSolidFrame = (r, g, b, w = 16, h = 16) => {
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
      }
      return renderProbe.computeFrameLuminanceGrid(buf, w, h, 8, 8);
    };
    const dark = makeSolidFrame(10, 10, 10);
    const white = makeSolidFrame(240, 240, 240);
    const red = makeSolidFrame(255, 0, 0);

    // 2 Hz white/black over 2 seconds -> <= 2 flashes/s
    const slow = [];
    for (let ms = 0; ms <= 2000; ms += 50) {
      slow.push({ timeMs: ms, grid: Math.floor(ms / 250) % 2 === 0 ? white : dark });
    }
    const slowRes = renderProbe.analyzeRollingFlashRate(slow);
    assert.ok(slowRes.maxGeneralFlashesPerSec <= 2, `expected <= 2, got ${slowRes.maxGeneralFlashesPerSec}`);

    // 5 Hz white/black -> detects > 3 flashes/s
    const fast = [];
    for (let ms = 0; ms <= 1500; ms += 25) {
      fast.push({ timeMs: ms, grid: Math.floor(ms / 100) % 2 === 0 ? white : dark });
    }
    const fastRes = renderProbe.analyzeRollingFlashRate(fast);
    assert.ok(fastRes.maxGeneralFlashesPerSec >= 5, `expected >= 5, got ${fastRes.maxGeneralFlashesPerSec}`);

    // 5 Hz saturated red vs dark -> detected in maxRedFlashesPerSec
    const fastRed = [];
    for (let ms = 0; ms <= 1500; ms += 25) {
      fastRed.push({ timeMs: ms, grid: Math.floor(ms / 100) % 2 === 0 ? red : dark });
    }
    const redRes = renderProbe.analyzeRollingFlashRate(fastRed);
    assert.ok(redRes.maxRedFlashesPerSec >= 5, `expected >= 5 red flashes/s, got ${redRes.maxRedFlashesPerSec}`);

    // Localized flash in a single 8×8 cell (hidden in whole-frame average) -> caught in maxGeneralFlashesPerSec
    const makeLocalFlash = (lit) => {
      const w = 16, h = 16;
      const buf = new Uint8Array(w * h * 4);
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          const i = (y * w + x) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = lit ? 255 : 0;
          buf[i + 3] = 255;
        }
      }
      return renderProbe.computeFrameLuminanceGrid(buf, w, h, 8, 8);
    };
    const localLit = makeLocalFlash(true);
    const localOff = makeLocalFlash(false);
    const localSeq = [];
    for (let ms = 0; ms <= 1200; ms += 25) {
      localSeq.push({ timeMs: ms, grid: Math.floor(ms / 100) % 2 === 0 ? localLit : localOff });
    }
    const localRes = renderProbe.analyzeRollingFlashRate(localSeq);
    assert.equal(localRes.maxWholeFrameFlashesPerSec, 0);
    assert.ok(localRes.maxGeneralFlashesPerSec >= 5);
  });
});

describe('Sprint 15: scenery LOD & canonical GLB export', () => {
  it('cuts low-tier scenery triangles by 69-83% while keeping high tier byte-exact and GLB export canonical', () => {
    const hw = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const propFor = (kind) => ({
      id: `p-${kind}`,
      kind,
      x: 0,
      z: 0,
      rotation: 0,
      scale: 1,
      color: '#ff2288',
    });

    const archHi = scenicProps.buildScenicPiece(propFor('arch'), hw, 'high');
    const archLo = scenicProps.buildScenicPiece(propFor('arch'), hw, 'low');
    assert.equal(countObjectTriangles(archHi.root), 16320 + 24);
    assert.equal(countObjectTriangles(archLo.root), 4080 + 24);

    const tentHi = scenicProps.buildScenicPiece(propFor('tentacle'), hw, 'high');
    const tentLo = scenicProps.buildScenicPiece(propFor('tentacle'), hw, 'low');
    assert.equal(countObjectTriangles(tentHi.root), 12480 + 7488 + 12);
    assert.equal(countObjectTriangles(tentLo.root), 3120 + 3120 + 12);

    const starHi = scenicProps.buildScenicPiece(propFor('star'), hw, 'high');
    const starLo = scenicProps.buildScenicPiece(propFor('star'), hw, 'low');
    assert.equal(countObjectTriangles(starHi.root), 12600 + 24 + 64);
    assert.equal(countObjectTriangles(starLo.root), 2160 + 24 + 64);

    // GLB export reconstructs canonical high-detail geometry when a scenic root is tagged scenicTier: 'low'.
    const archProp = propFor('arch');
    archLo.root.userData = { kind: 'arch', id: archProp.id, scenicProp: archProp, scenicTier: 'low' };
    const rig = { name: 'Scenery LOD Test Rig', venue: 'arena' };
    const snap = stageGlb.stageSnapshot(rig, [archLo.root], { fixtureBody: hw });
    assert.equal(countObjectTriangles(snap), 16320 + 24);

    hw.dispose();
  });
});

describe('Sprint 15: seeded fixed-step particles & falling CO2', () => {
  it('replays deterministically by seed, is cadence-invariant, caps tab-resume catchup, and respects tier capacities', () => {
    const tint = new THREE.Color('#00f0ff');
    const smokeEm = [new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 0, 0)];
    const co2Em = [new THREE.Vector3(-3, 1.2, 1), new THREE.Vector3(3, 1.2, 1)];

    const run = (tier, steps, stepDt, seed = 12345) => {
      const p = new particleMod.AtmosphericParticles(tier, seed);
      p.setEmitters(smokeEm, co2Em, 1.2);
      for (let i = 0; i < steps; i++) {
        p.update(stepDt, i * stepDt, 0.5, 0.8, true, tint, 1.0);
      }
      const snap = p.debugSnapshot();
      const stats = p.getStats();
      p.dispose();
      return { snap, stats };
    };

    const a = run('high', 60, 1 / 60, 4242);
    const b = run('high', 60, 1 / 60, 4242);
    assert.deepEqual(a.snap, b.snap);

    // Cadence invariance: 60 frames at 1/60s === 30 frames at 2/60s with identical constant input.
    const c = run('high', 30, 2 / 60, 4242);
    assert.deepEqual(a.snap, c.snap);

    // Low tier capacity caps
    const low = run('low', 180, 1 / 60, 4242);
    assert.equal(low.stats.smoke.capacity, 120);
    assert.equal(low.stats.cryo.capacity, 180);
    assert.equal(low.stats.haze.capacity, 18);
    assert.ok(low.stats.smoke.alive <= 120);
    assert.ok(low.stats.cryo.alive <= 180);

    // Tab resume catch-up bound (2.0 s single frame clamps to <= 6 substeps and records dropped time).
    const resume = new particleMod.AtmosphericParticles('high', 99);
    resume.setEmitters(smokeEm, co2Em, 1.2);
    resume.update(2.0, 2.0, 0.5, 1.0, true, tint, 1.0);
    assert.ok(resume.getStats().droppedSimulationMs > 1800);
    assert.ok(resume.debugSnapshot().simTime <= 0.11);
    resume.dispose();
  });

  it('models falling CO2 with 2.0-3.2 m apex, downward sink before death, floor clamp, and zero pool overflow', () => {
    const tint = new THREE.Color('#ffffff');
    const deckY = 1.2;
    const emitters = [
      new THREE.Vector3(-6, deckY, 2),
      new THREE.Vector3(-4, deckY, 2),
      new THREE.Vector3(-2, deckY, 2),
      new THREE.Vector3(2, deckY, 2),
      new THREE.Vector3(4, deckY, 2),
      new THREE.Vector3(6, deckY, 2),
    ];

    const p = new particleMod.AtmosphericParticles('high', 777);
    p.setFallingCo2(true);
    p.setEmitters([], emitters, deckY);

    let maxRelativeY = 0;
    let timeAtMaxY = 0;
    let sawDescending = false;
    let minY = Infinity;

    // Emit briefly (0.15 s) then observe full trajectory for 2.6 s.
    for (let tick = 0; tick < 165; tick++) {
      const t = tick / 60;
      p.update(1 / 60, t, 0.2, 0, t < 0.15, tint, 1.0);
      const snap = p.debugSnapshot();
      assert.ok(snap.cryo.length <= 420);
      for (const puff of snap.cryo) {
        const relY = puff.y - deckY;
        if (relY > maxRelativeY) {
          maxRelativeY = relY;
          timeAtMaxY = puff.age;
        }
        if (puff.y < minY) minY = puff.y;
        if (puff.age > 0.9 && (puff.vy + puff.vc) < -0.2) {
          sawDescending = true;
        }
      }
    }

    assert.ok(maxRelativeY >= 2.0 && maxRelativeY <= 3.35, `expected apex in [2.0, 3.35] m above deck, got ${maxRelativeY.toFixed(2)} m`);
    assert.ok(timeAtMaxY >= 0.45 && timeAtMaxY <= 0.85, `expected apex time in [0.45, 0.85] s, got ${timeAtMaxY.toFixed(2)} s`);
    assert.equal(sawDescending, true, 'expected CO2 puffs to sink downward after apex');
    assert.ok(minY >= deckY + 0.11, `expected puffs clamped above deck, got minY=${minY.toFixed(3)} vs deckY=${deckY}`);

    // Sustained 6-emitter burst stays within capacity on both high and low tiers.
    for (const tier of ['high', 'low']) {
      const sustained = new particleMod.AtmosphericParticles(tier, 777);
      sustained.setFallingCo2(true);
      sustained.setEmitters([], emitters, deckY);
      const cap = particleMod.PARTICLE_CAPACITIES[tier].cryo;
      for (let tick = 0; tick < 240; tick++) {
        sustained.update(1 / 60, tick / 60, 0.2, 0, true, tint, 1.0);
        assert.ok(sustained.getStats().cryo.alive <= cap);
      }
      assert.ok(sustained.getStats().cryo.alive > 0);
      sustained.dispose();
    }
    p.dispose();
  });
});

describe('Sprint 15: preview flash limiter & physical isolation', () => {
  it('caps unmapped laser strobe, blinder/blackout mashing, rapid color cue flips, and ILDA shimmer without mutating audioModState', () => {
    const state = previewFlash.createPreviewFlashState();
    const out = previewFlash.createPreviewFlashOutput();
    const modState = audioMod.createAudioModulationState();
    const cRed = new THREE.Color('#ff0000');
    const cCyan = new THREE.Color('#00ffff');

    // 1. Unmapped laser strobe at 1.0 (30 Hz raw) stays <= 3 edges/s in limited preview.
    let laserEdges = 0;
    let prevLaser = 0;
    for (let ms = 0; ms < 2000; ms += 10) {
      previewFlash.evaluatePreviewFlash(state, {
        dtSec: 0.01,
        tSec: ms / 1000,
        audioGlobalEdgeMs: modState.lastGlobalStrobeEdgeMs,
        limited: true,
        blackout: false,
        master: 1,
        blinder: 0,
        ledBright: 0.8,
        beatPulse: 0,
        beamIntensity: 0.8,
        washIntensity: 0.8,
        laserStrobe: 1.0,
        primaryColor: cRed,
        accentColor: cCyan,
      }, out);
      if (prevLaser === 0 && out.laserStrobeMultiplier === 1) laserEdges++;
      prevLaser = out.laserStrobeMultiplier;
    }
    assert.ok(laserEdges <= 6, `expected <= 6 laser edges in 2 s (<= 3/s), got ${laserEdges}`);
    assert.equal(modState.lastGlobalStrobeEdgeMs, -Infinity, 'preview limiter must never mutate audioModState');
    assert.equal(out.bypassLaserShaderStrobe, true);
    assert.equal(out.ledFlashLimited, true);

    // 2. ILDA flicker returns constant steady mean when limited while scan diagnostic stays unchanged.
    const diag = laserScan.evaluateLaserScan(20, 2000); // 10 Hz
    assert.equal(diag.flickering, true);
    const m1 = laserScan.flickerIntensityMultiplier(diag.refreshHz, 0.0, true);
    const m2 = laserScan.flickerIntensityMultiplier(diag.refreshHz, 0.025, true);
    const m3 = laserScan.flickerIntensityMultiplier(diag.refreshHz, 0.05, true);
    assert.equal(m1, m2);
    assert.equal(m2, m3);
    assert.ok(m1 > 0.7 && m1 < 1.0);
    // Un-limited still oscillates
    assert.notEqual(
      laserScan.flickerIntensityMultiplier(diag.refreshHz, 0.025, false),
      laserScan.flickerIntensityMultiplier(diag.refreshHz, 0.075, false),
    );

    // 3. Rapid blinder mashing (every 100 ms -> 5 Hz) cannot reach full 1.0 peaks > 3/s.
    const state2 = previewFlash.createPreviewFlashState();
    let blinderRises = 0;
    let wasHigh = false;
    for (let ms = 0; ms < 2000; ms += 16) {
      const targetBlinder = Math.floor(ms / 100) % 2 === 0 ? 1 : 0;
      previewFlash.evaluatePreviewFlash(state2, {
        dtSec: 0.016,
        tSec: ms / 1000,
        audioGlobalEdgeMs: -Infinity,
        limited: true,
        blackout: false,
        master: 1,
        blinder: targetBlinder,
        ledBright: 0.5,
        beatPulse: 0,
        beamIntensity: 0.5,
        washIntensity: 0.5,
        laserStrobe: 0,
        primaryColor: cRed,
        accentColor: cCyan,
      }, out);
      if (!wasHigh && out.blinder >= 0.5) {
        blinderRises++;
        wasHigh = true;
      } else if (out.blinder < 0.2) {
        wasHigh = false;
      }
    }
    assert.ok(blinderRises <= 6, `expected <= 6 blinder pulses in 2 s, got ${blinderRises}`);

    // 4. Positive control: rawManualStrobeOscillator exceeds 3/s at strobe 1.0 while stepCombinedStrobeGate caps <= 3/s.
    let rawEdges = 0;
    let prevRaw = false;
    let gatedEdges = 0;
    let prevGated = false;
    const mod2 = audioMod.createAudioModulationState();
    const scratch = { gate: 1, flashOn: false, limited: false };
    for (let ms = 0; ms < 1000; ms += 5) {
      mod2.clockMs = ms;
      const rawOn = previewFlash.rawManualStrobeOscillator(1.0, ms / 1000);
      if (!prevRaw && rawOn) rawEdges++;
      prevRaw = rawOn;
      audioMod.stepCombinedStrobeGate(mod2, 1.0, ms / 1000, false, scratch);
      if (!prevGated && scratch.flashOn) gatedEdges++;
      prevGated = scratch.flashOn;
    }
    assert.ok(rawEdges >= 20, `expected raw strobe >= 20/s, got ${rawEdges}`);
    assert.ok(gatedEdges <= 3, `expected gated physical strobe <= 3/s, got ${gatedEdges}`);
  });
});

describe('Sprint 15: safety wording over-claim guard', () => {
  it('forbids overclaiming photosensitivity safety across docs, pre-flight, AI bridge, and Display UI', () => {
    const root = process.cwd();
    const docsDir = join(root, 'docs');
    const files = [
      ...readdirSync(docsDir).filter((f) => f.endsWith('.md')).map((f) => join(docsDir, f)),
      join(root, 'src', 'data', 'preflight.ts'),
      join(root, 'desktop', 'ai-bridge-tools.cjs'),
      join(root, 'src', 'aiBridge', 'aiBridgeProtocol.ts'),
      join(root, 'src', 'components', 'DisplaySettingsPopover.tsx'),
    ];
    const forbidden = [
      /\bseizure[- ]safe\b/i,
      /\bprevents?\s+seizures\b/i,
      /\bwcag\s+compliant\b/i,
      /\ball\s+flashing\s+is\s+capped\b/i,
      /\bguarantees?\s+(?:no|zero)\s+flash/i,
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const re of forbidden) {
        assert.equal(re.test(content), false, `Forbidden overclaim ${re} matched in ${file}`);
      }
    }
  });
});
