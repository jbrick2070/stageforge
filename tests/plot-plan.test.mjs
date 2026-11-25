import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const compiler = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
after(() => compiler.close());

const { RIG_TEMPLATES, SHOW_CUES, INITIAL_SHOW_STATE } = await compiler.ssrLoadModule('/src/data/presets.ts');
const { computeInventory } = await compiler.ssrLoadModule('/src/data/equipmentInventory.ts');
const { makeShowFile, parseShowFile } = await compiler.ssrLoadModule('/src/data/showFile.ts');
const { buildShowPaperwork, PAPERWORK_SIMULATED_MAP_NOTICE } = await compiler.ssrLoadModule('/src/data/showPaperwork.ts');
const {
  buildPlotPlan,
  estimateTextWidthMm,
  normalizeRevision,
  parseTitleBlockState,
  PLOT_DENSE_NOTE,
  PLOT_DISCLAIMER,
  PLOT_MARGIN_M,
  STANDARD_PLOT_SCALES,
  truncateToWidth,
} = await compiler.ssrLoadModule('/src/data/plotPlan.ts');

function rectsOverlap(a, b, eps = 0.01) {
  return !(
    a.x + a.w + eps <= b.x ||
    b.x + b.w + eps <= a.x ||
    a.y + a.h + eps <= b.y ||
    b.y + b.h + eps <= a.y
  );
}

test('chosen scale fits the page for small (club), arena and festival rigs on A4 and Letter', () => {
  const rigs = [
    { label: 'Club', rig: RIG_TEMPLATES.club_stage },
    { label: 'Arena', rig: RIG_TEMPLATES.arena_mainstage },
    { label: 'Festival', rig: RIG_TEMPLATES.festival_mega },
  ];

  for (const paper of ['a4', 'letter']) {
    for (const { label, rig } of rigs) {
      const pw = buildShowPaperwork(rig, undefined, SHOW_CUES);
      const plan = buildPlotPlan(pw, rig, undefined, { paper, generatedDate: '2026-11-24' });

      assert.ok(
        STANDARD_PLOT_SCALES.includes(plan.scale),
        `${label} (${paper}): scale 1:${plan.scale} is a standard scale`,
      );
      assert.equal(plan.oversize, false, `${label} (${paper}): fits within standard scales`);

      // Rig bounds + 0.5 m margin fit strictly inside the viewBox.
      assert.ok(plan.viewBox.x <= plan.rigBounds.minX - PLOT_MARGIN_M + 1e-6, `${label} (${paper}): left margin fits`);
      assert.ok(
        plan.viewBox.x + plan.viewBox.width >= plan.rigBounds.maxX + PLOT_MARGIN_M - 1e-6,
        `${label} (${paper}): right margin fits`,
      );
      assert.ok(plan.viewBox.y <= plan.rigBounds.minZ - PLOT_MARGIN_M + 1e-6, `${label} (${paper}): upstage margin fits`);
      assert.ok(
        plan.viewBox.y + plan.viewBox.height >= plan.rigBounds.maxZ + PLOT_MARGIN_M - 1e-6,
        `${label} (${paper}): downstage margin fits`,
      );

      // ViewBox width in metres matches planW_mm * scale / 1000 exactly.
      assert.ok(
        Math.abs((plan.viewBox.width * 1000) / plan.scale - plan.geometry.planW) < 1e-6,
        `${label} (${paper}): true scale width identity`,
      );
      assert.ok(
        Math.abs((plan.viewBox.height * 1000) / plan.scale - plan.geometry.planH) < 1e-6,
        `${label} (${paper}): true scale height identity`,
      );

      // Every fixture symbol and label lies inside the plan area.
      const g = plan.geometry;
      for (const f of plan.fixtures) {
        assert.ok(f.pageX >= g.planX && f.pageX <= g.planX + g.planW, `${label}: #${f.fixtureNumber} X inside plan`);
        assert.ok(f.pageY >= g.planY && f.pageY <= g.planY + g.planH, `${label}: #${f.fixtureNumber} Y inside plan`);
        assert.ok(
          f.label.box.x >= g.planX && f.label.box.x + f.label.box.w <= g.planX + g.planW,
          `${label}: #${f.fixtureNumber} label X inside plan`,
        );
        assert.ok(
          f.label.box.y >= g.planY && f.label.box.y + f.label.box.h <= g.planY + g.planH,
          `${label}: #${f.fixtureNumber} label Y inside plan`,
        );
      }
    }
  }

  // Arena Rock has a 10 m scale-bar tick measuring exact 10000 / scale mm and zero dense fallbacks.
  const arenaPw = buildShowPaperwork(RIG_TEMPLATES.arena_mainstage, undefined, SHOW_CUES);
  const arenaPlan = buildPlotPlan(arenaPw, RIG_TEMPLATES.arena_mainstage, undefined, { paper: 'a4' });
  const tick10 = arenaPlan.scaleBar.ticks.find((t) => t.metres === 10);
  assert.ok(tick10, 'Arena Rock scale bar includes 10 m tick');
  assert.ok(Math.abs(tick10.widthMm - 10000 / arenaPlan.scale) < 1e-6, '10 m tick equals 10000 / scale mm');
  assert.equal(arenaPlan.numberOnlyCount, 0, 'Arena Rock triggers zero number-only fallbacks');
  assert.equal(arenaPlan.denseNote, null);

  // No two labels overlap on Arena Rock.
  for (let i = 0; i < arenaPlan.fixtures.length; i++) {
    for (let j = i + 1; j < arenaPlan.fixtures.length; j++) {
      assert.equal(
        rectsOverlap(arenaPlan.fixtures[i].label.box, arenaPlan.fixtures[j].label.box),
        false,
        `Arena Rock labels #${arenaPlan.fixtures[i].fixtureNumber} and #${arenaPlan.fixtures[j].fixtureNumber} must not overlap`,
      );
    }
  }
});

test('every paperwork unit appears once with identical number, position, DMX label and status', () => {
  const rig = structuredClone(RIG_TEMPLATES.arena_mainstage);
  // Create one conflict group and one overflow unit so all 3 statuses appear.
  rig.trussPods[0].fixtures[1].dmxUniverse = 1;
  rig.trussPods[0].fixtures[1].dmxStartChannel = 1; // conflicts with group 0
  rig.floorFx.push({
    id: 'plot-overflow',
    type: 'strobe',
    modelName: 'Overflow Strobe',
    count: 2,
    x: 0,
    z: 3,
    spread: 2,
    dmxUniverse: 2,
    dmxStartChannel: 511,
  });

  const pw = buildShowPaperwork(rig, undefined, SHOW_CUES);
  const plan = buildPlotPlan(pw, rig, undefined, { paper: 'a4' });

  assert.equal(plan.fixtures.length, pw.units.length, 'fixture count matches paperwork.units');
  const seen = new Set();
  for (let i = 0; i < pw.units.length; i++) {
    const u = pw.units[i];
    const pf = plan.fixtures[i];
    assert.ok(!seen.has(pf.fixtureNumber), `fixture #${pf.fixtureNumber} appears once`);
    seen.add(pf.fixtureNumber);
    assert.equal(pf.fixtureNumber, u.fixtureNumber);
    assert.equal(pf.x, u.x);
    assert.equal(pf.y, u.y);
    assert.equal(pf.z, u.z);
    assert.equal(pf.yaw, u.yaw);
    assert.equal(pf.dmxLabel, u.dmxLabel);
    assert.equal(pf.status, u.status);
  }
  assert.ok(plan.fixtures.some((f) => f.status === 'conflict'), 'conflict status preserved');
  assert.ok(plan.fixtures.some((f) => f.status === 'overflow'), 'overflow status preserved');
  assert.equal(plan.legend.hasIssues, true);
});

test('legend counts equal instrument-schedule and inventory counts', () => {
  for (const rig of [RIG_TEMPLATES.club_stage, RIG_TEMPLATES.arena_mainstage, RIG_TEMPLATES.festival_mega]) {
    const pw = buildShowPaperwork(rig, undefined, SHOW_CUES);
    const inv = computeInventory(rig);
    const plan = buildPlotPlan(pw, rig, undefined, { paper: 'a4' });

    const legendTotal = plan.legend.models.reduce((sum, r) => sum + r.count, 0);
    assert.equal(legendTotal, pw.instrumentRows.length, `${rig.name}: legend sum equals instrument schedule count`);
    assert.equal(legendTotal, inv.totals.units, `${rig.name}: legend sum equals inventory total units`);
    assert.equal(plan.legend.totalFixtures, pw.units.length);

    // Per-model counts match instrumentRows directly.
    const byModel = new Map();
    for (const u of pw.instrumentRows) {
      const k = `${u.type}::${u.catalogId ?? ''}::${u.manufacturer}::${u.modelName}::${u.powerW}::${u.powerEstimated ? 1 : 0}`;
      byModel.set(k, (byModel.get(k) ?? 0) + 1);
    }
    assert.equal(plan.legend.models.length, byModel.size);
    for (const row of plan.legend.models) {
      assert.equal(row.count, byModel.get(row.key), `${rig.name}: model ${row.displayName} count matches`);
    }
  }
});

test('orientation: an upstage unit sits higher on the page than a downstage unit', () => {
  const pw = buildShowPaperwork(RIG_TEMPLATES.arena_mainstage, undefined, SHOW_CUES);
  const plan = buildPlotPlan(pw, RIG_TEMPLATES.arena_mainstage, undefined, { paper: 'a4' });

  const upstage = plan.fixtures.find((f) => f.z < -3);
  const downstage = plan.fixtures.find((f) => f.z > 3);
  assert.ok(upstage && downstage, 'Arena rig has both upstage and downstage units');
  assert.ok(
    upstage.pageY < downstage.pageY,
    `upstage unit (z=${upstage.z}, pageY=${upstage.pageY.toFixed(1)}) sits higher on page than downstage (z=${downstage.z}, pageY=${downstage.pageY.toFixed(1)})`,
  );
});

test('walls and PA hangs are drawn for both stock rigs and authored v3 stages', async () => {
  // Stock Arena Rock has main LED wall + L/R stock PA hangs.
  const arenaPw = buildShowPaperwork(RIG_TEMPLATES.arena_mainstage, undefined, SHOW_CUES);
  const arenaPlan = buildPlotPlan(arenaPw, RIG_TEMPLATES.arena_mainstage, undefined, { paper: 'a4' });
  assert.equal(arenaPlan.walls.length, 1, 'stock main LED wall drawn');
  assert.equal(arenaPlan.walls[0].stock, true);
  assert.equal(arenaPlan.hangs.length, 2, 'stock L/R PA hangs drawn');
  assert.equal(arenaPlan.hangs[0].authored, false);

  // Authored v3 fixture has secondary walls and authored hangs.
  const raw = await readFile('tests/fixtures/native-authoring-v3.stageforge.show.json', 'utf8');
  const show = parseShowFile(raw);
  const v3Pw = buildShowPaperwork(show.rig, show.stage, show.cues, show.timeline);
  const v3Plan = buildPlotPlan(v3Pw, show.rig, show.stage, { paper: 'a4' });
  assert.ok(v3Plan.walls.length >= 2, 'v3 authored walls drawn');
  assert.ok(v3Plan.hangs.length >= 1, 'v3 authored hangs drawn');
  assert.ok(v3Plan.trusses.length >= 1, 'v3 trusses drawn');
});

test('a dense rig triggers leader offsets and the number-only fallback with patch-sheet note', () => {
  const denseRig = structuredClone(RIG_TEMPLATES.club_stage);
  denseRig.trussPods = [
    {
      id: 'far-left',
      name: 'Far Left Outrigger',
      shape: 'box',
      width: 4,
      x: -20,
      baseY: 10,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 10,
      motorMaxY: 10,
      fixtures: [
        { id: 'fl-b', type: 'beam', modelName: 'Sharpy X-Beam 350', count: 2, dmxUniverse: 1, dmxStartChannel: 1 },
      ],
    },
    {
      id: 'far-right',
      name: 'Far Right Outrigger',
      shape: 'box',
      width: 4,
      x: 20,
      baseY: 10,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 10,
      motorMaxY: 10,
      fixtures: [
        { id: 'fr-b', type: 'beam', modelName: 'Sharpy X-Beam 350', count: 2, dmxUniverse: 1, dmxStartChannel: 33 },
      ],
    },
    {
      id: 'dense-bar',
      name: 'Ultra-Dense Center Bar',
      shape: 'box',
      width: 3,
      x: 0,
      baseY: 8,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 8,
      motorMaxY: 8,
      fixtures: [
        { id: 'dense-48', type: 'blinder', modelName: 'Dense Blinder', count: 48, dmxUniverse: 2, dmxStartChannel: 1 },
      ],
    },
  ];
  denseRig.floorFx = [];

  const pw = buildShowPaperwork(denseRig);
  const plan = buildPlotPlan(pw, denseRig, undefined, { paper: 'a4' });

  assert.ok(plan.scale >= 200, `wide outriggers force compact scale (got 1:${plan.scale})`);
  assert.ok(plan.fixtures.some((f) => f.dense), 'dense cluster detected (< 4 mm spacing)');
  assert.ok(plan.numberOnlyCount > 0, 'dense cluster triggers number-only fallback');
  assert.equal(plan.denseNote, PLOT_DENSE_NOTE);
  assert.ok(
    plan.fixtures.some((f) => f.label.mode === 'number-only' && f.label.secondaryText === null),
    'number-only labels omit secondary DMX text',
  );
  // Every label still stays inside the plan area.
  const g = plan.geometry;
  for (const f of plan.fixtures) {
    assert.ok(f.label.box.x >= g.planX && f.label.box.x + f.label.box.w <= g.planX + g.planW);
    assert.ok(f.label.box.y >= g.planY && f.label.box.y + f.label.box.h <= g.planY + g.planH);
  }
});

test('a long rig name is truncated with an ellipsis within the title block width', () => {
  const longRig = structuredClone(RIG_TEMPLATES.club_stage);
  longRig.name =
    'International World Stadium Mega Festival Production Rig — Summer Tour Mainstage Edition 2026 With Extra Long Subtitle';
  const pw = buildShowPaperwork(longRig);
  const plan = buildPlotPlan(pw, longRig, undefined, {
    paper: 'a4',
    titleBlock: {
      venue: 'A Very Long Venue Name That Should Also Truncate Cleanly Inside The Title Block',
      designer: 'Alexander Bartholomew Montgomery-Wellington III',
      revision: 'b',
      date: '2026-11-24',
    },
    sheetNumber: 1,
    totalSheets: 6,
  });

  assert.ok(plan.titleBlock.rigName.endsWith('…'), 'long rig name ends with ellipsis');
  assert.ok(plan.titleBlock.rigName.length < longRig.name.length, 'long rig name was shortened');
  assert.ok(
    estimateTextWidthMm(plan.titleBlock.rigName, 3.4) <= plan.geometry.sidebarW - 4 + 1e-6,
    'truncated rig name fits inside title block width',
  );
  assert.equal(plan.titleBlock.revision, 'B');
  assert.equal(plan.titleBlock.sheetLabel, 'Sheet 1 of 6');
  assert.equal(plan.titleBlock.disclaimer, PLOT_DISCLAIMER);
  assert.equal(truncateToWidth('Short', 60, 3.4), 'Short');
});

test('oversize rigs, empty rigs, v1-v3 fixtures and hostile title-block storage inputs are handled cleanly', async () => {
  // Huge 80 m rig exceeds 1:250 and fits cleanly with an oversize note.
  const hugeRig = structuredClone(RIG_TEMPLATES.club_stage);
  hugeRig.stageWidth = 80;
  hugeRig.stageDepth = 40;
  const hugePw = buildShowPaperwork(hugeRig);
  const hugePlan = buildPlotPlan(hugePw, hugeRig, undefined, { paper: 'a4' });
  assert.equal(hugePlan.oversize, true);
  assert.ok(hugePlan.scale > 250);
  assert.ok(hugePlan.oversizeNote?.includes(`1:${hugePlan.scale}`));
  assert.ok(hugePlan.viewBox.width >= hugePlan.rigBounds.width + 2 * PLOT_MARGIN_M - 1e-6);

  // Empty rig with zero fixtures and zero pods falls back safely.
  const emptyRig = structuredClone(RIG_TEMPLATES.club_stage);
  emptyRig.trussPods = [];
  emptyRig.floorFx = [];
  emptyRig.platforms = [];
  emptyRig.ledWall.enabled = false;
  emptyRig.audioRig.lineArrays = false;
  const emptyPw = buildShowPaperwork(emptyRig);
  const emptyPlan = buildPlotPlan(emptyPw, emptyRig, undefined, { paper: 'a4' });
  assert.equal(emptyPlan.fixtures.length, 0);
  assert.equal(emptyPlan.legend.models.length, 0);
  assert.ok(emptyPlan.scale >= 25);

  // Hostile title-block inputs sanitize cleanly.
  const cleanTb = parseTitleBlockState({
    paper: 'invalid',
    venue: 'Hall\x00\nA' + 'X'.repeat(200),
    designer: 42,
    revision: '99!!',
    date: '2026-11-24',
  });
  assert.equal(cleanTb.paper, 'a4');
  assert.equal(cleanTb.venue.length, 120);
  assert.ok(!/[\x00-\x1f]/.test(cleanTb.venue));
  assert.equal(cleanTb.designer, '');
  assert.equal(cleanTb.revision, 'A');
  assert.equal(normalizeRevision('cd'), 'CD');

  // Legacy v1, v2 and v3 show fixtures all build valid plot plans.
  for (const file of [
    'tests/fixtures/legacy-v1.stageforge.show.json',
    'tests/fixtures/legacy-v2.stageforge.show.json',
    'tests/fixtures/native-authoring-v3.stageforge.show.json',
  ]) {
    const show = parseShowFile(await readFile(file, 'utf8'));
    const pw = buildShowPaperwork(show.rig, show.stage, show.cues, show.timeline);
    const plan = buildPlotPlan(pw, show.rig, show.stage, { paper: 'a4' });
    assert.equal(plan.fixtures.length, pw.units.length, `${file}: all units plotted`);
  }
});

test('QA regressions: multi-line notices (H1), wide/CJK truncation (H2), caption bounds & collision (M1/M2), 1:25-1:50 bar (M3), perf (M5), legend modes (L1), bidi sanitizer (L3), issue ! width (L4), and >1:1000 scale (L6)', () => {
  // H1: Dense + oversize rig on Letter never truncates any mandatory notice with an ellipsis.
  const denseHugeRig = structuredClone(RIG_TEMPLATES.club_stage);
  denseHugeRig.stageWidth = 90;
  denseHugeRig.stageDepth = 45;
  denseHugeRig.trussPods = [
    {
      id: 'dense-core',
      name: 'Dense Core',
      shape: 'box',
      width: 2.5,
      x: 0,
      baseY: 9,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 9,
      motorMaxY: 9,
      fixtures: [
        { id: 'd48', type: 'blinder', modelName: 'Dense Blinder', count: 48, dmxUniverse: 1, dmxStartChannel: 1 },
      ],
    },
  ];
  denseHugeRig.floorFx = [];
  const dhPw = buildShowPaperwork(denseHugeRig);
  const dhPlan = buildPlotPlan(dhPw, denseHugeRig, undefined, { paper: 'letter' });
  assert.equal(dhPlan.oversize, true);
  assert.ok(dhPlan.numberOnlyCount > 0);
  const joinedNotices = dhPlan.bottomNoticeLines.join(' ');
  assert.ok(joinedNotices.includes(PAPERWORK_SIMULATED_MAP_NOTICE), 'H1: simulated map notice preserved verbatim');
  assert.ok(joinedNotices.includes(PLOT_DENSE_NOTE), 'H1: dense note preserved verbatim');
  assert.ok(joinedNotices.includes(dhPlan.oversizeNote), 'H1: oversize note preserved verbatim');
  assert.ok(!joinedNotices.includes('…'), 'H1: mandatory notices never truncated with ellipsis');

  // H2: CJK, emoji, all-W, and all-m strings truncate with ellipsis and stay within sidebar width.
  const wideNames = [
    '株式会社ステージフォージ照明デザインプロダクション国際ツアー',
    'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
    'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',
    '🎭🎬🎤🎧🎸🥁🎺🎻🎹🎷'.repeat(4),
  ];
  for (const name of wideNames) {
    const r = structuredClone(RIG_TEMPLATES.club_stage);
    r.name = name;
    const plan = buildPlotPlan(buildShowPaperwork(r), r, undefined, {
      paper: 'a4',
      titleBlock: { venue: name, designer: name },
    });
    const maxW = plan.geometry.sidebarW - 4.5 + 1e-6;
    assert.ok(plan.titleBlock.rigName.endsWith('…'), `H2 rigName truncated: ${name}`);
    assert.ok(estimateTextWidthMm(plan.titleBlock.rigName, 3.3, true) <= maxW, `H2 rigName fits: ${name}`);
    assert.ok(plan.titleBlock.designer.endsWith('…'), `H2 designer truncated: ${name}`);
    assert.ok(estimateTextWidthMm(plan.titleBlock.designer, 2.25, true) <= maxW, `H2 designer fits: ${name}`);
  }

  // M1 & M2: Captions stay strictly inside planRect and never collide with non-forced fixture labels.
  const arenaPw = buildShowPaperwork(RIG_TEMPLATES.arena_mainstage, undefined, SHOW_CUES);
  const arenaPlan = buildPlotPlan(arenaPw, RIG_TEMPLATES.arena_mainstage, undefined, { paper: 'a4' });
  const g = arenaPlan.geometry;
  assert.ok(arenaPlan.captions.length >= 6, 'M1/M2: truss, wall and hang captions generated');
  for (const cap of arenaPlan.captions) {
    assert.ok(cap.box.x >= g.planX && cap.box.x + cap.box.w <= g.planX + g.planW, `M2 caption ${cap.id} X inside plan`);
    assert.ok(cap.box.y >= g.planY && cap.box.y + cap.box.h <= g.planY + g.planH, `M2 caption ${cap.id} Y inside plan`);
    for (const f of arenaPlan.fixtures) {
      if (f.label.forcedInside) continue;
      assert.equal(
        rectsOverlap(cap.box, f.label.box, 0.01),
        false,
        `M1 caption ${cap.id} must not overlap fixture #${f.fixtureNumber} label`,
      );
    }
  }

  // M3: Small rigs at 1:25 and 1:50 produce accurate scale bars that fit strictly inside plan width.
  const tinyRig = structuredClone(RIG_TEMPLATES.club_stage);
  tinyRig.stageWidth = 3;
  tinyRig.stageDepth = 2.5;
  tinyRig.trussPods = [];
  tinyRig.floorFx = [];
  tinyRig.ledWall.enabled = false;
  tinyRig.audioRig.lineArrays = false;
  const plan25 = buildPlotPlan(buildShowPaperwork(tinyRig), tinyRig, undefined, { paper: 'a4' });
  assert.equal(plan25.scale, 25);
  assert.ok(plan25.scaleBar.totalWidthMm <= plan25.geometry.planW - 4);
  for (const t of plan25.scaleBar.ticks) {
    assert.ok(Math.abs(t.widthMm - (t.metres * 1000) / plan25.scale) < 1e-6);
  }
  const clubPlan = buildPlotPlan(buildShowPaperwork(RIG_TEMPLATES.club_stage), RIG_TEMPLATES.club_stage, undefined, {
    paper: 'a4',
  });
  assert.equal(clubPlan.scale, 50);
  assert.ok(clubPlan.scaleBar.totalWidthMm <= clubPlan.geometry.planW - 4);

  // M5: 600-fixture stress rig builds fast with spatial grid (< 500 ms).
  const stressRig = structuredClone(RIG_TEMPLATES.festival_mega);
  stressRig.trussPods = Array.from({ length: 12 }, (_, p) => ({
    id: `stress-${p}`,
    name: `Stress Truss ${p + 1}`,
    shape: 'box',
    width: 24,
    x: 0,
    baseY: 10,
    z: -11 + p * 2,
    rotationY: 0,
    motorized: false,
    motorMinY: 10,
    motorMaxY: 10,
    fixtures: [
      { id: `sf-${p}`, type: 'blinder', modelName: 'Stress Unit', count: 50, dmxUniverse: 1, dmxStartChannel: 1 },
    ],
  }));
  stressRig.floorFx = [];
  const stressPw = buildShowPaperwork(stressRig);
  assert.equal(stressPw.units.length, 600);
  const t0 = performance.now();
  const stressPlan = buildPlotPlan(stressPw, stressRig, undefined, { paper: 'a4' });
  const elapsedMs = performance.now() - t0;
  assert.equal(stressPlan.fixtures.length, 600);
  assert.ok(elapsedMs < 500, `M5: 600-fixture plot built in ${elapsedMs.toFixed(1)} ms (< 500 ms)`);

  // L1: One catalogue model patched in two DMX modes sums to the same total in legend and inventory.
  const multiModeRig = structuredClone(RIG_TEMPLATES.club_stage);
  multiModeRig.trussPods[0].fixtures = [
    {
      id: 'm1',
      type: 'beam',
      modelName: 'MegaPointe',
      catalogId: 'robe-megapointe',
      dmxMode: 'Mode 1 (39-Ch)',
      dmxChannels: 39,
      count: 2,
      dmxUniverse: 1,
      dmxStartChannel: 1,
    },
    {
      id: 'm2',
      type: 'beam',
      modelName: 'MegaPointe',
      catalogId: 'robe-megapointe',
      dmxMode: 'Mode 2 (34-Ch)',
      dmxChannels: 34,
      count: 3,
      dmxUniverse: 1,
      dmxStartChannel: 100,
    },
  ];
  multiModeRig.trussPods[1].fixtures = [];
  multiModeRig.floorFx = [];
  const mmPw = buildShowPaperwork(multiModeRig);
  const mmInv = computeInventory(multiModeRig);
  const mmPlan = buildPlotPlan(mmPw, multiModeRig, undefined, { paper: 'a4' });
  assert.equal(mmInv.models.length, 2, 'L1: inventory splits two DMX modes');
  assert.equal(mmPlan.legend.models.length, 1, 'L1: plot legend combines into one model row');
  assert.equal(mmPlan.legend.models[0].count, 5, 'L1: legend count equals summed inventory & instrument schedule');
  assert.equal(mmPlan.legend.models[0].count, mmInv.totals.units);

  // L3: Bidi overrides, C1 controls, zero-width chars, and __proto__ keys are stripped cleanly.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"paper":"letter","venue":"Stage\\u202E\\u0085\\u200B1","designer":"\\u2066LD\\uFEFF"}');
  const parsedTb = parseTitleBlockState(hostile);
  assert.equal(parsedTb.paper, 'letter');
  assert.equal(parsedTb.venue, 'Stage 1');
  assert.equal(parsedTb.designer, 'LD');
  assert.equal(({}).polluted, undefined);

  // L4: Conflict/overflow units include "!" inside primaryText and box width covers it.
  const issueRig = structuredClone(RIG_TEMPLATES.club_stage);
  issueRig.trussPods[0].fixtures[1].dmxStartChannel = 1; // conflicts with group 0
  const issuePlan = buildPlotPlan(buildShowPaperwork(issueRig), issueRig, undefined, { paper: 'a4' });
  const issueFix = issuePlan.fixtures.find((f) => f.status === 'conflict');
  assert.ok(issueFix, 'L4: conflict fixture present');
  assert.ok(issueFix.label.primaryText.endsWith('!'), 'L4: primaryText includes ! suffix');
  assert.ok(
    issueFix.label.box.w >= estimateTextWidthMm(issueFix.label.primaryText, 1.8, true),
    'L4: label box covers ! suffix width',
  );

  // L6: Outlier rig (> 1:1000) selects a rounded multiple-of-100 scale and keeps bounds inside viewBox.
  const outlierRig = structuredClone(RIG_TEMPLATES.club_stage);
  outlierRig.stageWidth = 500;
  outlierRig.stageDepth = 200;
  const outlierPlan = buildPlotPlan(buildShowPaperwork(outlierRig), outlierRig, undefined, { paper: 'a4' });
  assert.equal(outlierPlan.oversize, true);
  assert.ok(outlierPlan.scale > 1000 && outlierPlan.scale % 100 === 0, `L6 scale ${outlierPlan.scale}`);
  assert.ok(outlierPlan.viewBox.width >= outlierPlan.rigBounds.width + 2 * PLOT_MARGIN_M - 1e-6);

  // Show-file persistence isolation: title-block state is never written to show JSON.
  const showFile = makeShowFile(RIG_TEMPLATES.club_stage, SHOW_CUES, INITIAL_SHOW_STATE, null);
  const serialized = JSON.stringify(showFile);
  assert.ok(!serialized.includes('titleBlock') && !serialized.includes('stageforge.titleBlock'));
});
