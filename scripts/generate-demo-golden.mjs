#!/usr/bin/env node
// Generates tests/fixtures/demo-synth-golden.json directly from commit 3361daa5d81e4f8bc7fbbea1bcabf7acca9f23df
// (the parent commit of Sprint 10), so synth demo parity is checked against a frozen historical oracle
// rather than a moving HEAD.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';

const ORACLE_COMMIT = '3361daa5d81e4f8bc7fbbea1bcabf7acca9f23df';
const REPO_ROOT = process.cwd();
const OUT_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'demo-synth-golden.json');

function gitShow(filePath) {
  return execFileSync('git', ['show', `${ORACLE_COMMIT}:${filePath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sf-demo-oracle-'));
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});

try {
  // Write the pre-Sprint-10 demoShow.ts, demoLighting.ts, and presets.ts into a temp directory.
  const showSrc = gitShow('src/data/demoShow.ts');
  const lightingSrc = gitShow('src/data/demoLighting.ts');
  const typesSrc = gitShow('src/types/show.ts');
  const presetsMod = await vite.ssrLoadModule('/src/data/presets.ts');

  const tmpShowPath = path.join(tmpDir, 'demoShow.ts');
  const tmpLightingPath = path.join(tmpDir, 'demoLighting.ts');
  const tmpTypesDir = path.join(tmpDir, 'types');
  // Adjust relative import path for demoLighting.ts -> types/show.ts
  writeFileSync(tmpShowPath, showSrc, 'utf8');
  writeFileSync(
    tmpLightingPath,
    lightingSrc.replace('../types/show', './showTypes'),
    'utf8',
  );
  writeFileSync(path.join(tmpDir, 'showTypes.ts'), typesSrc, 'utf8');

  const oracleShow = await vite.ssrLoadModule(tmpShowPath);
  const oracleLighting = await vite.ssrLoadModule(tmpLightingPath);

  const initialState = structuredClone(presetsMod.INITIAL_SHOW_STATE);
  const richState = {
    ...structuredClone(presetsMod.INITIAL_SHOW_STATE),
    movingGroups: { beam: { movementMode: 'circle' }, wash: { movementMode: 'fan' } },
    motors: { ...structuredClone(presetsMod.INITIAL_SHOW_STATE.motors), podTargets: { 'pod-front': { height: 0.7, tilt: 0.2 } } },
    atmo: { ...structuredClone(presetsMod.INITIAL_SHOW_STATE.atmo), hazeLevel: 0.9, smokeOutput: 0.5, co2Active: true },
    led: { ...structuredClone(presetsMod.INITIAL_SHOW_STATE.led), tourText: 'GOLDEN', customMediaUrl: 'blob:test', customMediaType: 'video' },
  };

  // Sample boundaries, every 16th step across all 64 bars, opening reveal steps, build transitions,
  // fractional steps, out-of-range clamps, and finale prism transition.
  const sampleSteps = [
    -10, 0, 0.25, 1, 15.5, 16, 31.75, 32, 32.5, 48, 56, 64, 96, 112.125,
    127.875, 128, 128.5, 160, 192, 224, 255.75, 256, 272, 288, 320, 368,
    379.5, 380, 383.75, 384, 385, 448, 511.5, 512, 576, 639.9, 640, 704,
    764, 768, 832, 832.5, 896, 959.5, 960, 992, 1023.75, 1024, 1100,
  ];

  const samples = sampleSteps.map((step) => {
    const pos = oracleShow.getDemoPosition(step);
    return {
      step,
      position: pos,
      lookInitial: oracleLighting.applyDemoLighting(initialState, pos),
      lookRich: oracleLighting.applyDemoLighting(richState, pos),
    };
  });

  const payload = {
    oracleCommit: ORACLE_COMMIT,
    totalBars: oracleShow.DEMO_TOTAL_BARS,
    totalSteps: oracleShow.DEMO_TOTAL_STEPS,
    blackoutSteps: oracleLighting.DEMO_BLACKOUT_STEPS,
    initialState,
    richState,
    samples,
  };

  // Always write LF line endings for cross-OS git consistency.
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2).replace(/\r\n/g, '\n') + '\n', 'utf8');
  console.log(`Wrote ${samples.length} golden synth samples from ${ORACLE_COMMIT} to ${OUT_PATH}`);
} finally {
  await vite.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
