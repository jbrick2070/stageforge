import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const {
  DEMO_ILDA_PRESETS,
  ILDA_DEFAULT_PALETTE,
  ILDA_HEADER_BYTES,
  ILDA_MAX_BYTES,
  ILDA_MAX_FRAMES,
  ILDA_MAX_POINTS_PER_FRAME,
  ILDA_MAX_TOTAL_POINTS_HIGH,
  ILDA_MAX_TOTAL_POINTS_LOW,
  ILDA_STATUS_BLANKED,
  ILDA_STATUS_LAST_POINT,
  encodeIlda,
  generateDemoIlda,
  normalizeIldaCoord,
  parseIlda,
} = await compiler.ssrLoadModule('/src/data/ilda.ts');

const {
  LASER_CONE_SPREAD_BASE,
  LASER_CONE_SPREAD_SCALE,
  LASER_SHEET_FAR_HALF_WIDTH_M,
  LASER_SHEET_HEIGHT_BASE,
  LASER_SHEET_HEIGHT_SCALE,
  LASER_SHEET_WIDTH_BASE,
  LASER_SHEET_WIDTH_SCALE,
  LASER_STARBURST_Y_BASE,
  LASER_STARBURST_Y_SCALE,
  encodeLaserDmxChannels,
  ildaScanTangents,
  laserFanHalfAngles,
  laserPitch,
  laserPitchEnvelope,
  laserPowerPresence,
  resolveLaserColor,
} = await compiler.ssrLoadModule('/src/data/laserAim.ts');

const {
  LASER_FLICKER_THRESHOLD_HZ,
  evaluateLaserScan,
  flickerIntensityMultiplier,
  laserRefreshHz,
} = await compiler.ssrLoadModule('/src/data/laserScan.ts');

const {
  MIN_AUDIENCE_CLEARANCE_M,
  evaluateLaserSafety,
  formatClearanceM,
  laserClassFor,
  laserRayWorldDirection,
} = await compiler.ssrLoadModule('/src/data/laserSafety.ts');

const {
  EQUIPMENT_CATALOG,
  checkCatalogChannelDrift,
  formatCatalogSpecBadges,
  getCatalogEntry,
  getCatalogMode,
  getSelectableModes,
} = await compiler.ssrLoadModule('/src/data/equipmentCatalog.ts');

const { BakedIldaClip, ildaMeshScale } = await compiler.ssrLoadModule('/src/engine/ildaRenderer.ts');
const { LASER_CONE_VERT, LASER_SHEET_VERT } = await compiler.ssrLoadModule('/src/engine/shaders.ts');
const { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { makeShowFile, parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { writeDmxChannels } = await compiler.ssrLoadModule('/src/data/dmxPatch.ts');
const { mulberry32 } = await compiler.ssrLoadModule('/src/engine/prng.ts');

function singleLaserRig({
  floor = false,
  y = 6,
  z = 0,
  stageDepth = 10,
  catalogId = 'kvant-clubmax',
  dmxMode = 'FB4 16-Ch (FB3 Profile)',
  dmxChannels = 16,
} = {}) {
  const rig = createBlankDesign();
  rig.venue = 'arena';
  rig.stageWidth = 16;
  rig.stageDepth = stageDepth;
  rig.stageHeight = 1.5;
  if (floor) {
    rig.trussPods = [];
    rig.floorFx = [
      {
        id: 'fl1',
        type: 'floor_laser',
        modelName: 'Floor Laser',
        catalogId,
        dmxMode,
        dmxChannels,
        count: 1,
        x: 0,
        z,
        spread: 0,
        dmxUniverse: 2,
        dmxStartChannel: 1,
      },
    ];
  } else {
    rig.trussPods = [
      {
        id: 'p1',
        name: 'Front Truss',
        shape: 'box',
        width: 10,
        x: 0,
        baseY: y,
        z,
        rotationY: 0,
        motorized: false,
        motorMinY: y,
        motorMaxY: y,
        fixtures: [
          {
            id: 'l1',
            type: 'laser',
            modelName: 'Overhead Laser',
            catalogId,
            dmxMode,
            dmxChannels,
            count: 1,
            dmxUniverse: 2,
            dmxStartChannel: 1,
          },
        ],
      },
    ];
    rig.floorFx = [];
  }
  return rig;
}

test('ILDA parser round-trips formats 0, 1, 2 (palette), 4 and 5, honors BGR order, blanking, last-point, EOF and warnings', () => {
  assert.equal(ILDA_DEFAULT_PALETTE.length, 64 * 3);

  // Format 4 (3D true-color BGR) & Format 5 (2D true-color BGR)
  const bytesTrue = encodeIlda([
    {
      name: 'F4_3D',
      format: 4,
      points: [
        { x: -16384, y: 8192, z: 4096, r: 250, g: 120, b: 10, blanked: false },
        { x: 16384, y: -8192, z: -4096, r: 20, g: 200, b: 240, blanked: true },
      ],
    },
    {
      name: 'F5_2D',
      format: 5,
      points: [
        { x: 0, y: 16384, r: 10, g: 255, b: 30, blanked: false },
        { x: 32767, y: -32768, r: 255, g: 0, b: 128, blanked: false },
      ],
    },
  ]);
  const parsedTrue = parseIlda(bytesTrue, { name: 'TrueColorTest' });
  assert.equal(parsedTrue.frames.length, 2);
  assert.equal(parsedTrue.totalPoints, 4);
  assert.ok(parsedTrue.z instanceof Int16Array);
  assert.equal(parsedTrue.xy[0], -16384);
  assert.equal(parsedTrue.xy[1], 8192);
  assert.equal(parsedTrue.z[0], 4096);
  // Verify BGR decoding produced exact RGB order
  assert.deepEqual([...parsedTrue.rgb.slice(0, 3)], [250, 120, 10]);
  assert.equal(parsedTrue.blank[0], 0);
  // Blanked point has blank=1 and RGB zeroed
  assert.equal(parsedTrue.blank[1], 1);
  assert.deepEqual([...parsedTrue.rgb.slice(3, 6)], [0, 0, 0]);
  assert.deepEqual([...parsedTrue.rgb.slice(6, 9)], [10, 255, 30]);
  assert.deepEqual([...parsedTrue.rgb.slice(9, 12)], [255, 0, 128]);
  assert.equal(parsedTrue.warnings.length, 0);

  // Format 2 palette + Format 0 (3D indexed) + Format 1 (2D indexed) + out-of-range colorIndex clamp
  const customPalette = new Uint8Array([
    11, 22, 33, // idx 0
    44, 55, 66, // idx 1
  ]);
  const bytesIndexed = encodeIlda(
    [
      {
        name: 'F0_IDX',
        format: 0,
        points: [
          { x: 1000, y: -1000, z: 500, colorIndex: 0 },
          { x: 2000, y: 2000, z: -500, colorIndex: 99 }, // exceeds palette length 2 -> clamp + warning
        ],
      },
      {
        name: 'F1_IDX',
        format: 1,
        points: [{ x: 0, y: 0, colorIndex: 1 }],
      },
    ],
    { palette: { colors: customPalette } },
  );
  const parsedIdx = parseIlda(bytesIndexed);
  assert.equal(parsedIdx.frames.length, 2);
  assert.deepEqual([...parsedIdx.rgb.slice(0, 3)], [11, 22, 33]);
  assert.deepEqual([...parsedIdx.rgb.slice(3, 6)], [44, 55, 66]);
  assert.deepEqual([...parsedIdx.rgb.slice(6, 9)], [44, 55, 66]);
  assert.ok(parsedIdx.warnings.some((w) => /Palette color index/.test(w)));

  // Last-point bit terminates frame early even if header declares more records.
  const rawEarly = encodeIlda([
    {
      name: 'EARLY',
      format: 5,
      points: [
        { x: 100, y: 100, r: 255, g: 0, b: 0 },
        { x: 200, y: 200, r: 0, g: 255, b: 0 },
        { x: 300, y: 300, r: 0, g: 0, b: 255 },
      ],
    },
  ]);
  // Set ILDA_STATUS_LAST_POINT (0x80) on the first point (offset 32 + 4).
  rawEarly[ILDA_HEADER_BYTES + 4] |= ILDA_STATUS_LAST_POINT;
  const parsedEarly = parseIlda(rawEarly);
  assert.equal(parsedEarly.frames[0].count, 1);

  // Trailing bytes after EOF produce a warning instead of throwing.
  const withTrailing = new Uint8Array(bytesTrue.length + 7);
  withTrailing.set(bytesTrue);
  withTrailing.set([1, 2, 3, 4, 5, 6, 7], bytesTrue.length);
  const parsedTrail = parseIlda(withTrailing);
  assert.equal(parsedTrail.frames.length, 2);
  assert.ok(parsedTrail.warnings.some((w) => /Ignored 7 trailing byte/.test(w)));

  // All built-in demo clips encode and parse cleanly with finite normalized coords.
  for (const preset of DEMO_ILDA_PRESETS) {
    const demoBytes = generateDemoIlda(preset.id);
    const clip = parseIlda(demoBytes, { name: preset.label });
    assert.ok(clip.frames.length >= 1, `${preset.id} has frames`);
    assert.ok(clip.totalPoints >= 2, `${preset.id} has points`);
    for (let i = 0; i < clip.xy.length; i++) {
      const n = normalizeIldaCoord(clip.xy[i]);
      assert.ok(Number.isFinite(n) && n >= -1 && n <= 1);
    }
  }
});

test('ILDA parser enforces hostile-input caps, rejects unknown formats/truncation, and survives 64 KB random fuzzing', () => {
  // Empty & bad magic
  assert.throws(() => parseIlda(new Uint8Array(0)), /empty/i);
  assert.throws(() => parseIlda(new Uint8Array(32)), /Invalid ILDA magic/);

  // Unknown format codes (3 and 7)
  for (const badFmt of [3, 7, 99]) {
    const bad = encodeIlda([{ format: 5, points: [{ x: 0, y: 0, r: 255, g: 255, b: 255 }] }]);
    bad[7] = badFmt;
    assert.throws(() => parseIlda(bad), new RegExp(`Unsupported ILDA format code ${badFmt} at offset 0`));
  }

  // Truncated header & truncated record payload
  const good = encodeIlda([{ format: 5, points: [{ x: 0, y: 0, r: 255, g: 0, b: 0 }] }]);
  assert.throws(() => parseIlda(good.subarray(0, 20)), /Truncated ILDA section header/);
  assert.throws(() => parseIlda(good.subarray(0, 36)), /Truncated ILDA frame 0 records/);

  // Oversized file (> 8 MiB)
  const huge = new Uint8Array(ILDA_MAX_BYTES + 1);
  assert.throws(() => parseIlda(huge), /too large/i);

  // Palette > 256 entries
  const badPal = new Uint8Array(ILDA_HEADER_BYTES + 257 * 3);
  badPal.set([0x49, 0x4c, 0x44, 0x41, 0, 0, 0, 2]);
  new DataView(badPal.buffer).setUint16(24, 257, false);
  assert.throws(() => parseIlda(badPal), /maximum is 256/);

  // > ILDA_MAX_POINTS_PER_FRAME points in one frame
  const overPts = new Uint8Array(ILDA_HEADER_BYTES + (ILDA_MAX_POINTS_PER_FRAME + 1) * 8);
  overPts.set([0x49, 0x4c, 0x44, 0x41, 0, 0, 0, 5]);
  new DataView(overPts.buffer).setUint16(24, ILDA_MAX_POINTS_PER_FRAME + 1, false);
  assert.throws(() => parseIlda(overPts), /limit is 4000 per frame/);

  // > ILDA_MAX_FRAMES frames
  const manyFrames = Array.from({ length: ILDA_MAX_FRAMES + 1 }, () => ({
    format: 5,
    points: [{ x: 0, y: 0, r: 1, g: 1, b: 1 }],
  }));
  assert.throws(() => parseIlda(encodeIlda(manyFrames)), /2000-frame limit/);

  // Low-tier point cap (60,000) vs high-tier cap (200,000)
  const lowOverFrames = Array.from({ length: 61 }, () => ({
    format: 5,
    points: Array.from({ length: 1000 }, () => ({ x: 100, y: 100, r: 255, g: 0, b: 0 })),
  }));
  const lowOverBytes = encodeIlda(lowOverFrames);
  assert.equal(parseIlda(lowOverBytes, { tier: 'high' }).totalPoints, 61_000);
  assert.throws(() => parseIlda(lowOverBytes, { tier: 'low' }), /60,000-point limit/);

  // High-tier point cap (200,000)
  const highOverFrames = Array.from({ length: 51 }, () => ({
    format: 5,
    points: Array.from({ length: 4000 }, () => ({ x: 100, y: 100, r: 255, g: 0, b: 0 })),
  }));
  assert.throws(() => parseIlda(encodeIlda(highOverFrames), { tier: 'high' }), /200,000-point limit/);
  assert.equal(ILDA_MAX_TOTAL_POINTS_HIGH, 200_000);
  assert.equal(ILDA_MAX_TOTAL_POINTS_LOW, 60_000);

  // 64 KB deterministic fuzz corpus: must only ever return valid clip or throw plain Error (never TypeError/RangeError)
  const rng = mulberry32(0x1da0f022);
  const fuzzBuf = new Uint8Array(65536);
  for (let i = 0; i < fuzzBuf.length; i++) fuzzBuf[i] = Math.floor(rng() * 256);
  for (let trial = 0; trial < 256; trial++) {
    const start = (trial * 251) % (fuzzBuf.length - 256);
    const len = 1 + (trial * 97) % 256;
    const slice = new Uint8Array(fuzzBuf.subarray(start, start + len));
    // Half the trials plant valid "ILDA" magic so header/body paths are deeply exercised.
    if (trial % 2 === 0 && slice.length >= 4) slice.set([0x49, 0x4c, 0x44, 0x41], 0);
    try {
      parseIlda(slice);
    } catch (err) {
      assert.equal(Object.getPrototypeOf(err), Error.prototype, `fuzz trial ${trial} threw non-Error: ${err}`);
    }
  }
});

test('laserAim, shaders constant parity, single-color enforcement, and role-mapped vs legacy DMX encoding', () => {
  // Shader strings contain the exact shared numeric constants from laserAim.ts
  for (const val of [
    LASER_SHEET_WIDTH_BASE,
    LASER_SHEET_WIDTH_SCALE,
    LASER_SHEET_HEIGHT_BASE,
    LASER_SHEET_HEIGHT_SCALE,
    LASER_SHEET_FAR_HALF_WIDTH_M,
    LASER_STARBURST_Y_BASE,
    LASER_STARBURST_Y_SCALE,
  ]) {
    const token = Number.isInteger(val) ? `${val}.0` : String(val);
    assert.ok(LASER_SHEET_VERT.includes(token), `LASER_SHEET_VERT includes ${token}`);
  }
  for (const val of [LASER_CONE_SPREAD_BASE, LASER_CONE_SPREAD_SCALE]) {
    const token = Number.isInteger(val) ? `${val}.0` : String(val);
    assert.ok(LASER_CONE_VERT.includes(token), `LASER_CONE_VERT includes ${token}`);
  }

  // Pitch sign convention: positive rotation.x pitches +Z beam downward (-Y)
  const safePitch = laserPitch(false, { audienceScan: false, tilt: 0, pattern: 'fan', speed: 0.5 });
  const crowdPitch = laserPitch(false, { audienceScan: true, tilt: 0, pattern: 'fan', speed: 0.5 });
  assert.ok(crowdPitch > safePitch, 'audienceScan produces more positive rotation.x (downward pitch)');
  const env = laserPitchEnvelope(false, { audienceScan: false, tilt: 0, pattern: 'horizon' });
  assert.ok(env.maxPitchRad > env.nominalRad && env.minPitchRad < env.nominalRad);

  // Single-color laser forces monochrome diode color even when RGB rainbow or custom_dual is requested
  const cs500g = getCatalogEntry('laserworld-cs-500g');
  assert.ok(cs500g?.laser?.colorType === 'single');
  const mono = resolveLaserColor(cs500g.laser, 'rainbow', '#ff0000', '#0000ff', '#ff00aa', '#00f0ff');
  assert.equal(mono.forcedSingleColor, true);
  assert.equal(mono.shaderMode, 0);
  assert.equal(mono.colorA, cs500g.laser.singleColorHex);
  assert.equal(mono.colorB, cs500g.laser.singleColorHex);

  // Power presence stays cleanly bounded in [0.6, 1.25]
  assert.equal(laserPowerPresence(undefined), 1.0);
  assert.ok(laserPowerPresence({ opticalPowerW: 0.4 }) >= 0.6);
  assert.ok(laserPowerPresence({ opticalPowerW: 30 }) <= 1.25);

  // Legacy / layout-less mode writes byte-identical 8-channel simulator output
  const sample = {
    enabled: true,
    intensity: 0.8,
    patternIndex: 2,
    spreadX: 0.6,
    spreadY: 0.4,
    speed: 0.5,
    rotation: 0.25,
    tilt: 0,
    beamCount: 16,
    strobe: 0.1,
    colorR: 0,
    colorG: 1,
    colorB: 0.5,
    colorModeIndex: 1,
    scanRateNorm: 0.75,
  };
  const legacyBytes = encodeLaserDmxChannels(undefined, sample);
  assert.deepEqual(legacyBytes, [204, 64, 153, 102, 128, 64, 128, 26]);

  // Real FB4 16-Ch layout writes strictly within its 16-channel footprint with real roles
  const clubmax = getCatalogEntry('kvant-clubmax');
  const fb4Mode = getCatalogMode(clubmax, 'FB4 16-Ch (FB3 Profile)');
  const fb4Bytes = encodeLaserDmxChannels(fb4Mode, sample);
  assert.equal(fb4Bytes.length, 16);
  assert.equal(fb4Bytes[0], 255, 'Ch 1 FB4 16-ch access active');
  assert.equal(fb4Bytes[2], 64, 'Ch 3 Cue/Pattern');
  assert.equal(fb4Bytes[4], 204, 'Ch 5 Master Dimmer');
  assert.equal(fb4Bytes[9], 128, 'Ch 10 Pos X centered');
  // Writing to DMX buffer never bleeds past channel 16
  const u2 = new Uint8Array(512);
  u2[16] = 77;
  writeDmxChannels(u2, 1, 16, fb4Bytes);
  assert.equal(u2[16], 77, 'Channel 17 neighbor untouched');
  // Blackout zeroes FB4 access byte
  assert.equal(encodeLaserDmxChannels(fb4Mode, { ...sample, enabled: false, intensity: 0 })[0], 0);
});

test('IEC 60825 / ANSI Z136 laserSafety evaluates overhead clearance, audienceScan, 3.0 m boundary, floor pitch, stationary beams, horizon sway & power class', () => {
  const baseLaser = structuredClone(INITIAL_SHOW_STATE.laser);
  baseLaser.enabled = true;
  baseLaser.intensity = 0.85;
  baseLaser.pattern = 'fan';
  baseLaser.spreadX = 0.6;
  baseLaser.spreadY = 0.2;
  baseLaser.speed = 0.5;
  baseLaser.tilt = 0;
  baseLaser.audienceScan = false;

  // 1. Flat overhead beam at y = 6 m clears >= 3.0 m -> ok
  const okRig = singleLaserRig({ y: 6, z: 0 });
  const okReport = evaluateLaserSafety(okRig, baseLaser);
  assert.equal(okReport.level, 'ok');
  assert.ok(okReport.minClearanceM !== null && okReport.minClearanceM >= MIN_AUDIENCE_CLEARANCE_M);
  assert.equal(okReport.audienceHazardCount, 0);

  // 2. CROWD SCAN ON -> danger
  const crowdReport = evaluateLaserSafety(okRig, { ...baseLaser, audienceScan: true });
  assert.equal(crowdReport.level, 'danger');
  assert.ok(crowdReport.projectors[0].findings.some((f) => f.code === 'crowd_scan_enabled'));

  // 3. Floor laser on a 1.5 m stage deck pitched upward safely clears audience -> ok
  const floorRig = singleLaserRig({ floor: true, z: 0 });
  delete floorRig.platforms; // rectangular stage deck at y = stageHeight (1.5 m)
  const floorReport = evaluateLaserSafety(floorRig, { ...baseLaser, tilt: 0.5, spreadY: 0.05 });
  assert.equal(floorReport.level, 'ok');
  assert.ok(floorReport.minClearanceM !== null && floorReport.minClearanceM >= MIN_AUDIENCE_CLEARANCE_M);

  // 4. Exact 3.0 m clearance boundary: flat horizontal ray (pitch=0, halfY=0) at originY = 3.0 vs 2.99
  // Overhead laser originY = pod.baseY - 0.24, and pitch = -0.02 - tilt * 0.34 => pitch=0 when tilt = -0.02 / 0.34
  const zeroPitchTilt = -0.02 / 0.34;
  // Use ILDA clip with single horizontal span at y=0 so lowestElevationRad === 0 exactly!
  const flatIlda = parseIlda(encodeIlda([{
    format: 5,
    points: [
      { x: -10000, y: 0, r: 0, g: 255, b: 0 },
      { x: 10000, y: 0, r: 0, g: 255, b: 0 },
    ],
  }]));
  // Box truss bottom chord sits at mount.y = -0.28, plus hung laser drop -0.24 => total -0.52 from pod.baseY.
  const atBoundary = evaluateLaserSafety(singleLaserRig({ y: 3.52, z: 0 }), { ...baseLaser, tilt: zeroPitchTilt, rotation: 0 }, { ildaClip: flatIlda });
  assert.ok(Math.abs(atBoundary.minClearanceM - 3.0) < 1e-4, `expected 3.0 m, got ${atBoundary.minClearanceM}`);
  assert.equal(atBoundary.level, 'ok', 'exactly 3.0 m passes clearance threshold');

  const belowBoundary = evaluateLaserSafety(singleLaserRig({ y: 3.50, z: 0 }), { ...baseLaser, tilt: zeroPitchTilt, rotation: 0 }, { ildaClip: flatIlda });
  assert.ok(belowBoundary.minClearanceM < 3.0);
  assert.equal(belowBoundary.level, 'danger', 'below 3.0 m triggers danger');

  // 5. Spread collapse & single static beam trigger stationary_beam when enabled (and NOT when off)
  const collapsed = evaluateLaserSafety(okRig, { ...baseLaser, spreadX: 0.01, spreadY: 0.01 });
  assert.equal(collapsed.level, 'danger');
  assert.equal(collapsed.stationaryHazardCount, 1);
  assert.ok(collapsed.projectors[0].findings.some((f) => f.code === 'stationary_beam'));

  const staticSingle = evaluateLaserSafety(okRig, { ...baseLaser, beamCount: 1, speed: 0 });
  assert.equal(staticSingle.stationaryHazardCount, 1);

  const disabledCollapsed = evaluateLaserSafety(okRig, { ...baseLaser, enabled: false, spreadX: 0.01, spreadY: 0.01 });
  assert.equal(disabledCollapsed.stationaryHazardCount, 0);

  // 6. Static ILDA dwell frame triggers stationary_beam danger
  const staticIlda = parseIlda(generateDemoIlda('static_spot'));
  const ildaStaticReport = evaluateLaserSafety(okRig, baseLaser, { ildaClip: staticIlda });
  assert.equal(ildaStaticReport.level, 'danger');
  assert.equal(ildaStaticReport.stationaryHazardCount, 1);

  // 7. Horizon sway worst-case envelope catches dip on a mid-height truss
  const horizonRig = singleLaserRig({ y: 5.5, z: 0 });
  const fanMid = evaluateLaserSafety(horizonRig, { ...baseLaser, pattern: 'fan', spreadY: 0.1 });
  const horizonMid = evaluateLaserSafety(horizonRig, { ...baseLaser, pattern: 'horizon', spreadY: 0.1 });
  assert.equal(fanMid.level, 'ok');
  assert.equal(horizonMid.level, 'danger', 'horizon ±0.18 rad worst-case sway catches downward audience dip');

  // 8. Laser class derivation
  assert.equal(laserClassFor(0.4), '3B');
  assert.equal(laserClassFor(0.5), '3B');
  assert.equal(laserClassFor(1.0), '4');
  assert.equal(laserClassFor(30), '4');

  // Class 3B rig reports hasClass4 === false
  const class3bRig = singleLaserRig({ y: 6, z: 0, catalogId: 'laserworld-cs-500g', dmxMode: '15-Ch DMX', dmxChannels: 15 });
  const class3bReport = evaluateLaserSafety(class3bRig, baseLaser);
  assert.equal(class3bReport.hasClass4, false);
  assert.equal(class3bReport.projectors[0].laserClass, '3B');
});

test('laserScan refresh rate & flicker threshold + headless BakedIldaClip draw ranges and disposal', () => {
  const smooth = evaluateLaserScan(30, 500);
  assert.equal(smooth.refreshHz, 60);
  assert.equal(smooth.flickering, false);
  assert.equal(smooth.warning, null);
  assert.equal(flickerIntensityMultiplier(smooth.refreshHz, 1.23), 1.0);

  const flick = evaluateLaserScan(30, 1500);
  assert.equal(flick.refreshHz, 20);
  assert.equal(flick.flickering, true);
  assert.ok(flick.warning && flick.warning.includes('20 Hz'));
  assert.ok(LASER_FLICKER_THRESHOLD_HZ === 30);
  const mod = flickerIntensityMultiplier(flick.refreshHz, 0.0375);
  assert.ok(mod >= 0.45 && mod <= 1.0);

  // Headless BakedIldaClip drawRangeFor + shared attribute lifecycle
  const clip = parseIlda(generateDemoIlda('graphic_star'));
  const baked = new BakedIldaClip(clip);
  const rgbGeo = baked.createProjectorGeometry(false);
  const monoGeo = baked.createProjectorGeometry(true);
  assert.equal(baked.ownsGeometry(rgbGeo), true);
  assert.equal(baked.ownsGeometry(monoGeo), true);
  assert.equal(rgbGeo.getAttribute('position'), monoGeo.getAttribute('position'), 'shared position BufferAttribute');
  assert.notEqual(rgbGeo.getAttribute('color'), monoGeo.getAttribute('color'), 'separate RGB vs mono luminance colors');

  const drBeam = baked.drawRangeFor(0, 'beam');
  const drGraphic = baked.drawRangeFor(0, 'graphic');
  const drBoth = baked.drawRangeFor(0, 'both');
  assert.ok(drBeam.count > 0 && drGraphic.count > 0);
  assert.equal(drBoth.start, drBeam.start);
  assert.equal(drBoth.count, drBeam.count + drGraphic.count);

  const [sx, sy] = ildaMeshScale(60, 0.8, 0.5);
  assert.ok(sx > sy && sx > 0 && sy > 0);

  baked.dispose();
  assert.equal(baked.ownsGeometry(rgbGeo), false);
  assert.throws(() => baked.createProjectorGeometry(false), /disposed/i);
});

test('laser catalogue invariants and Round 1/2 v6 legacy Placeholder DMX (18-Ch) show compatibility', () => {
  const lasers = EQUIPMENT_CATALOG.filter((e) => e.category === 'laser');
  assert.ok(lasers.length >= 6, 'at least 6 real laser models across power classes');
  assert.ok(lasers.some((e) => e.laser.colorType === 'single'), 'includes single-color laser');
  assert.ok(lasers.some((e) => e.laser.laserClass === '3B'), 'includes Class 3B laser');
  assert.ok(lasers.some((e) => e.laser.laserClass === '4' && e.laser.opticalPowerW >= 25), 'includes arena Class 4 laser');

  for (const entry of lasers) {
    assert.ok(entry.laser, `${entry.id} defines laser spec`);
    assert.equal(entry.placeholder, undefined, `${entry.id} is no longer a placeholder`);
    assert.equal(entry.laser.laserClass, laserClassFor(entry.laser.opticalPowerW), `${entry.id} laserClass matches opticalPowerW`);
    assert.equal(entry.modes[0].legacy, undefined, `${entry.id} modes[0] must be a real non-legacy mode`);
    assert.ok(getSelectableModes(entry).length >= 1, `${entry.id} has selectable real DMX modes`);
    for (const m of entry.modes) {
      if (m.layout) {
        assert.ok(m.layout.length <= m.channels, `${entry.id} ${m.name} layout fits within channels`);
      }
    }
    const badges = formatCatalogSpecBadges(entry);
    assert.ok(badges.some((b) => /kpps/.test(b.text)), `${entry.id} badges show kpps`);
    assert.ok(badges.some((b) => /Class (3B|4)/.test(b.text)), `${entry.id} badges show laser class`);
  }

  // Round 1/2 saved v6 show referencing kvant-clubmax and kvant-spectrum with Placeholder DMX (18-Ch) must load & round-trip cleanly!
  const legacyV6Rig = structuredClone(RIG_TEMPLATES.club_stage);
  const overheadLaser = legacyV6Rig.trussPods.flatMap((p) => p.fixtures).find((f) => f.type === 'laser');
  assert.ok(overheadLaser);
  overheadLaser.catalogId = 'kvant-clubmax';
  overheadLaser.modelName = 'KVANT Clubmax';
  overheadLaser.dmxMode = 'Placeholder DMX (18-Ch)';
  overheadLaser.dmxChannels = 18;
  legacyV6Rig.floorFx.push({
    id: 'old-spec',
    type: 'floor_laser',
    modelName: 'KVANT Spectrum',
    catalogId: 'kvant-spectrum',
    dmxMode: 'Placeholder DMX (18-Ch)',
    dmxChannels: 18,
    count: 1,
    x: 0,
    z: 1,
    spread: 0,
    dmxUniverse: 2,
    dmxStartChannel: 200,
  });

  const savedJson = JSON.stringify(makeShowFile(legacyV6Rig, SHOW_CUES, INITIAL_SHOW_STATE, null));
  const reloaded = parseShowFile(savedJson);
  assert.equal(reloaded.version, 6);
  const reloadedClubmax = reloaded.rig.trussPods.flatMap((p) => p.fixtures).find((f) => f.catalogId === 'kvant-clubmax');
  const reloadedSpectrum = reloaded.rig.floorFx.find((f) => f.catalogId === 'kvant-spectrum');
  assert.equal(reloadedClubmax.dmxMode, 'Placeholder DMX (18-Ch)');
  assert.equal(reloadedSpectrum.dmxMode, 'Placeholder DMX (18-Ch)');
  assert.equal(checkCatalogChannelDrift(reloadedClubmax), undefined);
  assert.equal(checkCatalogChannelDrift(reloadedSpectrum), undefined);

  // Legacy mode is hidden from selectable picker modes
  assert.equal(getSelectableModes(getCatalogEntry('kvant-clubmax')).some((m) => m.legacy), false);
  assert.equal(getSelectableModes(getCatalogEntry('kvant-spectrum')).some((m) => m.legacy), false);

  // Re-serializing produces identical JSON
  const resavedJson = JSON.stringify(makeShowFile(reloaded.rig, reloaded.cues, reloaded.look, reloaded.activeCueId));
  assert.equal(resavedJson, savedJson);
});

test('QA regressions: YXZ Euler parity (H1), sheet/ILDA roll envelope (H2), unmapped DMX safe zeros (H3/M1), exact ILDA span (M2), shared scan tangents (M3), zero-alloc helpers (M4), trailing bytes & bumpLaser', () => {
  // H1: laserRayWorldDirection matches THREE.Euler(pitch, yaw, 0, 'YXZ') across yaw 0, 90, 180, -60 deg.
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
    for (const pitch of [-0.25, 0.14, 0.35]) {
      const az = 0.2;
      const el = -0.15;
      const lx = Math.sin(az) * Math.cos(el);
      const ly = Math.sin(el);
      const lz = Math.cos(az) * Math.cos(el);
      const v = new THREE.Vector3(lx, ly, lz).applyEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      const got = laserRayWorldDirection(yaw, pitch, az, el);
      assert.ok(Math.abs(got.dx - v.x) < 1e-12, `dx mismatch at yaw=${yaw}`);
      assert.ok(Math.abs(got.dy - v.y) < 1e-12, `dy mismatch at yaw=${yaw}`);
      assert.ok(Math.abs(got.dz - v.z) < 1e-12, `dz mismatch at yaw=${yaw}`);
    }
  }

  // H2: roll reduces clearance for procedural horizon/matrix and ILDA clips.
  const baseLaser = structuredClone(INITIAL_SHOW_STATE.laser);
  baseLaser.enabled = true;
  baseLaser.intensity = 0.85;
  baseLaser.audienceScan = false;
  baseLaser.tilt = 0;
  baseLaser.spreadX = 1.0;
  baseLaser.spreadY = 0.1;
  baseLaser.speed = 0.5;

  const midRig = singleLaserRig({ y: 8.5, z: 0 });
  const fanNoRoll = evaluateLaserSafety(midRig, { ...baseLaser, pattern: 'fan', rotation: 0 });
  const fanFullRoll = evaluateLaserSafety(midRig, { ...baseLaser, pattern: 'fan', rotation: 1 });
  assert.ok(fanFullRoll.minClearanceM < fanNoRoll.minClearanceM - 2.0, 'sheet roll drops worst-case clearance significantly');

  const matrixNoRoll = laserFanHalfAngles('matrix', 1.0, 0.1, 0, 0);
  const matrixOddUnit = laserFanHalfAngles('matrix', 1.0, 0.1, 0, 1);
  const matrixSpin = laserFanHalfAngles('matrix', 1.0, 0.1, 1, 0);
  assert.ok(matrixOddUnit.halfYRad > matrixNoRoll.halfYRad, 'odd matrix unit rotated 90 deg has larger vertical span');
  assert.ok(matrixSpin.halfYRad > matrixNoRoll.halfYRad, 'spinning matrix accounts for full 360 deg roll');

  // ILDA clip roll envelope: horizontal line at y=0 rolled by rotation=1 drops clearance below rotation=0.
  const wideLineIlda = parseIlda(encodeIlda([{
    format: 5,
    points: [
      { x: -30000, y: 0, r: 0, g: 255, b: 0 },
      { x: 30000, y: 0, r: 0, g: 255, b: 0 },
    ],
  }]));
  const ildaNoRoll = evaluateLaserSafety(midRig, { ...baseLaser, rotation: 0 }, { ildaClip: wideLineIlda });
  const ildaRolled = evaluateLaserSafety(midRig, { ...baseLaser, rotation: 1 }, { ildaClip: wideLineIlda });
  assert.ok(ildaRolled.minClearanceM < ildaNoRoll.minClearanceM - 1.5, 'rolled ILDA horizontal line drops clearance');

  // H3 & M1: unmapped real catalogue laser modes output safe blackout zeros, while legacy/verified modes work.
  const sampleDmx = {
    enabled: true, intensity: 0.8, patternIndex: 2, spreadX: 0.6, spreadY: 0.4,
    speed: 0.5, rotation: 0.25, tilt: 0, beamCount: 16, strobe: 0.1,
    colorR: 0, colorG: 1, colorB: 0, colorModeIndex: 0, scanRateNorm: 0.75,
  };
  const csMode = getCatalogMode(getCatalogEntry('laserworld-cs-500g'), '15-Ch DMX');
  const csBytes = encodeLaserDmxChannels(csMode, sampleDmx);
  assert.equal(csBytes.length, 15);
  assert.ok(csBytes.every((b) => b === 0), 'unmapped real catalogue laser mode outputs safe zeros');

  const legacyPlaceholderMode = getCatalogMode(getCatalogEntry('kvant-spectrum'), 'Placeholder DMX (18-Ch)');
  assert.equal(legacyPlaceholderMode.legacy, true);
  assert.deepEqual(encodeLaserDmxChannels(legacyPlaceholderMode, sampleDmx), [204, 64, 153, 102, 128, 64, 128, 26]);

  // M2: ILDA stationary threshold exact angular span (0.4 deg flags, 0.6 deg does not) on 60 deg Clubmax at spread=1.
  const halfTan30 = Math.tan((30 * Math.PI) / 180);
  const makeSpanIlda = (spanDeg) => {
    // Symmetric points [-n, +n] where 2 * atan(n * tan(30 deg)) = spanDeg
    const n = Math.tan(((spanDeg / 2) * Math.PI) / 180) / halfTan30;
    const xInt = Math.round(n * 32768);
    return parseIlda(encodeIlda([{
      format: 5,
      points: [
        { x: -xInt, y: 0, r: 0, g: 255, b: 0 },
        { x: xInt, y: 0, r: 0, g: 255, b: 0 },
      ],
    }]));
  };
  const narrow04 = evaluateLaserSafety(midRig, { ...baseLaser, spreadX: 1, spreadY: 1, rotation: 0 }, { ildaClip: makeSpanIlda(0.4) });
  const wide06 = evaluateLaserSafety(midRig, { ...baseLaser, spreadX: 1, spreadY: 1, rotation: 0 }, { ildaClip: makeSpanIlda(0.6) });
  assert.equal(narrow04.stationaryHazardCount, 1, '0.4 deg true span triggers stationary hazard');
  assert.equal(wide06.stationaryHazardCount, 0, '0.6 deg true span clears 0.5 deg stationary threshold');

  // M3: ildaMeshScale and ildaScanTangents share exact mapping and 5..80 deg clamp.
  const t60 = ildaScanTangents(60, 0.5, 0.25);
  const [msX, msY] = ildaMeshScale(60, 0.5, 0.25);
  assert.equal(msX, t60.scaleX);
  assert.equal(msY, t60.scaleY);
  assert.deepEqual(ildaScanTangents(1, 0.5, 0.5), ildaScanTangents(5, 0.5, 0.5));
  assert.deepEqual(ildaScanTangents(120, 0.5, 0.5), ildaScanTangents(80, 0.5, 0.5));

  // M4: zero-alloc laserRefreshHz and scratch drawRangeFor match allocating helpers.
  assert.equal(laserRefreshHz(30, 1500), evaluateLaserScan(30, 1500).refreshHz);
  const baked = new BakedIldaClip(wideLineIlda);
  const scratch = { start: -1, count: -1 };
  const ref = baked.drawRangeFor(0, 'beam', scratch);
  assert.equal(ref, scratch);
  assert.equal(scratch.count, 4);
  baked.dispose();

  // Low: 1-31 trailing bytes after last frame without EOF header parse with warning instead of throwing.
  const noEof = encodeIlda([{ format: 5, points: [{ x: 0, y: 0, r: 0, g: 255, b: 0 }] }], { omitEof: true });
  const withPad = new Uint8Array(noEof.length + 11);
  withPad.set(noEof);
  const paddedClip = parseIlda(withPad);
  assert.equal(paddedClip.frames.length, 1);
  assert.ok(paddedClip.warnings.some((w) => /Ignored 11 trailing byte/.test(w)));

  // Low: bumpLaser activates stationary hazard even when laser.enabled is false.
  const bumpReport = evaluateLaserSafety(
    midRig,
    { ...baseLaser, enabled: false, spreadX: 0.01, spreadY: 0.01 },
    { bumpLaser: true },
  );
  assert.equal(bumpReport.stationaryHazardCount, 1);

  // Mixed rig color resolution: single-color laser stays monochrome while RGB laser uses show colors.
  const rgbColor = resolveLaserColor(getCatalogEntry('kvant-clubmax').laser, 'dual', '#00f0ff', '#ff00aa');
  const monoColor = resolveLaserColor(getCatalogEntry('laserworld-cs-500g').laser, 'dual', '#00f0ff', '#ff00aa');
  assert.equal(rgbColor.forcedSingleColor, false);
  assert.equal(rgbColor.colorA, '#00f0ff');
  assert.equal(rgbColor.colorB, '#ff00aa');
  assert.equal(monoColor.forcedSingleColor, true);
  assert.equal(monoColor.colorA, '#00ff44');

  // Pass 2 M-A & Low #1: global laser index parity across multiple single-unit groups, and 2.96 m floors to "2.9".
  assert.equal(formatClearanceM(2.96), '2.9');
  assert.equal(formatClearanceM(3.0), '3.0');
  const twoGroupRig = singleLaserRig({ y: 8.0, z: 0 });
  twoGroupRig.trussPods[0].fixtures.push({
    id: 'l2',
    type: 'laser',
    modelName: 'Overhead Laser 2',
    catalogId: 'kvant-clubmax',
    dmxMode: 'FB4 16-Ch (FB3 Profile)',
    dmxChannels: 16,
    count: 1,
    dmxUniverse: 2,
    dmxStartChannel: 33,
  });
  const twoGroupMatrix = evaluateLaserSafety(twoGroupRig, { ...baseLaser, pattern: 'matrix', rotation: 0, spreadX: 1, spreadY: 0.1 });
  assert.equal(twoGroupMatrix.projectors.length, 2);
  assert.ok(
    twoGroupMatrix.projectors[1].minClearanceM < twoGroupMatrix.projectors[0].minClearanceM - 1.0,
    'second 1-unit group gets globalLaserIndex=1 (odd -> 90 deg matrix swap matching StageEngine)',
  );
});
