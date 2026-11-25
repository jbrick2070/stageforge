import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { smpteToMs, msToSmpte, formatSmpte, parseSmpteString, SMPTE_RATES } =
  await compiler.ssrLoadModule('/src/showControl/timecode.ts');
const { buildShowPaperwork } = await compiler.ssrLoadModule('/src/data/showPaperwork.ts');
const { RIG_TEMPLATES } = await compiler.ssrLoadModule('/src/data/presets.ts');

test('a timecode stored as whole milliseconds reads back as the same frame, for every rate and every frame in the first two hours', () => {
  for (const fps of SMPTE_RATES) {
    const frameMs = fps === 29.97 ? 1001 / 30 : 1000 / fps;
    const frames = Math.floor((2 * 3600 * 1000) / frameMs);
    for (let n = 0; n < frames; n++) {
      // What the UI stores: the exact frame position rounded to a millisecond.
      const stored = Math.round(n * frameMs);
      const tc = msToSmpte(stored, fps);
      const text = formatSmpte(tc);
      const back = parseSmpteString(text, fps);
      assert.equal(back, stored, `${fps} fps frame ${n}: ${stored} ms read back as ${text} (${back} ms)`);
    }
  }
});

test('the half-millisecond tolerance has an upper bound: a position 1 ms early still reads the previous frame, at every rate', () => {
  for (const fps of SMPTE_RATES) {
    const frameMs = fps === 29.97 ? 1001 / 30 : 1000 / fps;
    for (const n of [1, 2, 29, 30, 1798, 1799, 1800, 17_981, 17_982, 107_892, 107_893]) {
      const boundary = n * frameMs;
      const early = msToSmpte(Math.floor(boundary - 1), fps);          // >= 1 ms before the boundary
      const onTime = msToSmpte(Math.round(boundary), fps);             // stored whole-millisecond position
      const late = msToSmpte(Math.round(boundary + frameMs - 1.5), fps); // still inside frame n
      assert.notEqual(formatSmpte(early), formatSmpte(onTime), `${fps} fps frame ${n}: 1 ms early must read the previous frame`);
      assert.equal(formatSmpte(late), formatSmpte(onTime), `${fps} fps frame ${n}: end of the frame must not leak into the next one`);
    }
  }
  // 1.4 ms before 01:00:00;00 (3,599,996.4 ms) at 29.97 DF is still 00:59:59;29.
  assert.equal(formatSmpte(msToSmpte(3_599_995, 29.97)), '00:59:59;29');
});

test('the desktop Art-Net timecode converter (osc-packets.cjs) agrees with the renderer for whole-millisecond positions', async () => {
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('../desktop/osc-packets.cjs');
  for (const fps of SMPTE_RATES) {
    const frameMs = fps === 29.97 ? 1001 / 30 : 1000 / fps;
    const frames = Math.floor((2 * 3600 * 1000) / frameMs);
    for (let n = 0; n < frames; n++) {
      const stored = Math.round(n * frameMs);
      assert.deepEqual(cjs.msToSmpte(stored, fps), msToSmpte(stored, fps), `${fps} fps frame ${n} (${stored} ms)`);
    }
  }
  assert.equal(formatSmpte(cjs.msToSmpte(3_599_996, 29.97)), '01:00:00;00');
});

test('the cue sheet starts at the offset itself when the offset was entered as 01:00:00;00 at 29.97 DF', () => {
  const offset = parseSmpteString('01:00:00;00', 29.97);
  assert.equal(offset, 3_599_996, 'the UI rounds the drop-frame hour to a whole millisecond');
  const cues = [{ id: 'a', name: 'Opening', tag: 'GO', accent: '#fff', state: {} }];
  const timeline = { durationMs: 10_000, frameRate: 29.97, timecodeOffsetMs: offset, events: [{ atMs: 0, cueId: 'a' }] };
  const pw = buildShowPaperwork(structuredClone(Object.values(RIG_TEMPLATES)[0]), undefined, cues, timeline);
  assert.equal(pw.cues[0].takeTimecode, '01:00:00;00', 'not one frame early (00:59:59;29)');
});
