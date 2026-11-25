import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const { EQUIPMENT_CATALOG, LEGACY_DEFAULTS } = await compiler.ssrLoadModule('/src/data/equipmentCatalog.ts');
const { ALL_BODY_FAMILIES, bodyFamilyFor, specToSvgPath, symbolFor, symbolForHardware, symbolForLedPanel } =
  await compiler.ssrLoadModule('/src/data/equipmentSymbols.ts');
const { exportStageDxf } = await compiler.ssrLoadModule('/src/data/stageDxf.ts');
const { createBlankDesign } = await compiler.ssrLoadModule('/src/data/stageDesign.ts');
const { aimAngles, aimTiltOnly, HEAD_PIVOT, TILT_LIMIT } = await compiler.ssrLoadModule('/src/engine/focusAim.ts');
const {
  atlasSizeForTier,
  generateDeckPixels,
  generateHardwareAtlasPixels,
  HARDWARE_ATLAS_BAND_COUNT,
  HARDWARE_ATLAS_SEED,
  mapGeometryUvToBand,
  resolveRenderTier,
  STAGE_DECK_SEED,
} = await compiler.ssrLoadModule('/src/engine/hardwareMaterials.ts');
const { BeamPools } = await compiler.ssrLoadModule('/src/engine/beamPools.ts');
const { fixtureOptics } = await compiler.ssrLoadModule('/src/data/fixtureOptics.ts');
const { createSharedMaterials, disposeSharedMaterials } = await compiler.ssrLoadModule('/src/engine/geometryBuilders.ts');
const {
  buildLedCabinetBackGeometry,
  buildMovingModelParts,
  buildStaticModelParts,
  countTriangles,
  FAMILY_DEFAULT_MODEL_ID,
  FixtureModelCache,
  hasModelSpecForCatalogId,
  MODEL_SPECS,
  resolveModelSpec,
} = await compiler.ssrLoadModule('/src/engine/fixtureModels.ts');
const { MAX_GLB_CABINET_BACK_INSTANCES, nameFixtureUnit, stageSnapshot } =
  await compiler.ssrLoadModule('/src/engine/stageGlb.ts');

test('every catalogue entry and legacy type has a 3D model spec, SVG/DXF symbol, and documented asset provenance', async () => {
  const familySet = new Set(ALL_BODY_FAMILIES);
  for (const entry of EQUIPMENT_CATALOG) {
    assert.ok(hasModelSpecForCatalogId(entry.id), `missing ModelSpec for ${entry.id}`);
    assert.ok(familySet.has(entry.body), `missing family ${entry.body} in ALL_BODY_FAMILIES`);
    const resolvedSpec = resolveModelSpec(entry.renderTypes[0] ?? 'beam', entry.id);
    assert.equal(resolvedSpec.family, entry.body, `${entry.id} resolved spec family matches entry.body`);
    if (Object.hasOwn(MODEL_SPECS, entry.id)) {
      assert.equal(resolvedSpec.id, entry.id, `${entry.id} keeps dedicated ModelSpec`);
    } else {
      assert.equal(resolvedSpec.id, FAMILY_DEFAULT_MODEL_ID[entry.body], `${entry.id} reuses body-family default model`);
    }
    const sym = symbolFor(entry.body, entry.id);
    assert.ok(sym.plan.length > 0, `${entry.id} has plan symbol`);
    assert.ok(sym.elevation.length > 0, `${entry.id} has elevation symbol`);
    assert.ok(sym.size.w > 0 && sym.size.h > 0 && sym.size.d > 0, `${entry.id} has positive symbol size`);
    for (const p of [...sym.plan, ...sym.elevation]) {
      assert.ok(specToSvgPath(p, false).startsWith('M'), `${entry.id} valid SVG path`);
    }
  }
  assert.equal(Object.keys(MODEL_SPECS).length, 34, 'all 34 original entries preserve dedicated ModelSpecs');
  // Static theatrical ellipsoidals & static LED batten resolve to fixed motion rather than pan-tilt or tilt.
  assert.equal(resolveModelSpec('wash', 'ellipsoidal-led-01').motion, 'fixed');
  assert.equal(resolveModelSpec('wash', 'ellipsoidal-led-02').motion, 'fixed');
  assert.equal(resolveModelSpec('wash', 'batten-static-01').motion, 'fixed', 'QA M1: static LED batten stays fixed');
  assert.equal(resolveModelSpec('wash', 'batten-tilt-01').motion, 'tilt', 'tilting LED batten keeps tilt motion');
  // Unknown forward-compatible catalogId still falls back cleanly to LEGACY_DEFAULTS[type].
  assert.equal(resolveModelSpec('beam', 'unknown-future-model-99').id, LEGACY_DEFAULTS.beam);
  assert.equal(resolveModelSpec('wash', 'unknown-future-model-99').id, LEGACY_DEFAULTS.wash);

  for (const type of Object.keys(LEGACY_DEFAULTS)) {
    const legacySpec = resolveModelSpec(type, undefined);
    assert.ok(legacySpec, `legacy spec exists for ${type}`);
    if (type === 'beam' || type === 'wash' || type === 'floor_beam') {
      assert.equal(legacySpec.pivotY, HEAD_PIVOT, `legacy ${type} preserves HEAD_PIVOT`);
      assert.equal(legacySpec.motion, 'pan-tilt', `legacy ${type} preserves pan-tilt`);
    }
    const unknownFallback = resolveModelSpec(type, 'future-unknown-fixture-9000');
    assert.ok(unknownFallback, `unknown catalogId falls back cleanly for ${type}`);
    assert.ok(symbolForHardware(type, 'future-unknown-fixture-9000').plan.length > 0);
  }

  assert.equal(symbolForLedPanel('roe-cb5').size.h, 1.2);
  assert.equal(symbolForLedPanel('roe-bp2-v2').size.h, 0.5);

  const docs = await readFile(new URL('../docs/assets.md', import.meta.url), 'utf8');
  assert.ok(docs.includes(HARDWARE_ATLAS_SEED.toString(16)), 'docs/assets.md lists hardware atlas seed');
  assert.ok(docs.includes(STAGE_DECK_SEED.toString(16)), 'docs/assets.md lists stage deck seed');
});

test('createSharedMaterials runs in Node without DOM and procedural PBR textures are byte-deterministic', () => {
  const mats = createSharedMaterials({ tier: 'high' });
  assert.ok(mats.hardwareBody instanceof THREE.MeshStandardMaterial);
  assert.ok(mats.hardwareGlass instanceof THREE.MeshStandardMaterial);
  assert.ok(mats.stageDeck instanceof THREE.MeshStandardMaterial);
  disposeSharedMaterials(mats);

  assert.equal(atlasSizeForTier('high'), 512);
  assert.equal(atlasSizeForTier('low'), 256);

  const a1 = generateHardwareAtlasPixels(128, HARDWARE_ATLAS_SEED);
  const a2 = generateHardwareAtlasPixels(128, HARDWARE_ATLAS_SEED);
  assert.deepEqual(a1.albedo, a2.albedo, 'hardware albedo is byte-deterministic');
  assert.deepEqual(a1.roughMetal, a2.roughMetal, 'hardware rough/metal is byte-deterministic');
  assert.deepEqual(a1.normal, a2.normal, 'hardware normal map is byte-deterministic');
  assert.equal(a1.normalSize, 64);

  // Verify normal vectors are roughly unit length and Z-positive.
  for (let i = 0; i < a1.normal.length; i += 4) {
    const nx = (a1.normal[i] / 255) * 2 - 1;
    const ny = (a1.normal[i + 1] / 255) * 2 - 1;
    const nz = (a1.normal[i + 2] / 255) * 2 - 1;
    const len = Math.hypot(nx, ny, nz);
    assert.ok(len > 0.9 && len < 1.1, `normal vector unit-length (${len})`);
    assert.ok(nz > 0, 'tangent-space normal points +Z');
  }

  const d1 = generateDeckPixels(128, STAGE_DECK_SEED);
  const d2 = generateDeckPixels(128, STAGE_DECK_SEED);
  assert.deepEqual(d1, d2, 'stage deck texture is byte-deterministic');
});

test('all catalogue 3D models build cleanly in Node within high/low triangle budgets and obey pivot & floor contracts', () => {
  for (const tier of ['high', 'low']) {
    for (const entry of EQUIPMENT_CATALOG) {
      const spec = resolveModelSpec(entry.renderTypes[0] ?? 'beam', entry.id);
      if (entry.category === 'led_panel') {
        const back = buildLedCabinetBackGeometry(entry.panel.widthMm / 1000, entry.panel.heightMm / 1000, tier);
        const tris = countTriangles(back);
        const cap = tier === 'high' ? 150 : 60;
        assert.ok(tris > 0 && tris <= cap, `${entry.id} LED back (${tier}) ${tris} <= ${cap} tris`);
        back.dispose();
        continue;
      }

      const isMovingKind = entry.renderTypes.some((rt) => rt === 'beam' || rt === 'wash' || rt === 'floor_beam');
      if (isMovingKind) {
        for (const isFloor of [false, true]) {
          const parts = buildMovingModelParts(spec, isFloor, tier);
          // Strict pivot contract: yokeY + headY === spec.pivotY
          assert.ok(Math.abs(parts.yokeY + parts.headY - spec.pivotY) < 1e-9, `${entry.id} pivot sum`);
          assert.ok(parts.lensOffsetY > 0, `${entry.id} positive lensOffsetY`);

          const totalTris =
            countTriangles(parts.baseGeo) +
            countTriangles(parts.mountGeo) +
            countTriangles(parts.yokeGeo) +
            countTriangles(parts.headGeo) +
            countTriangles(parts.glassGeo);

          const cap =
            spec.family === 'led-batten'
              ? tier === 'high'
                ? 1200
                : 400
              : spec.family === 'led-par'
                ? tier === 'high'
                  ? 600
                  : 250
                : tier === 'high'
                  ? 1500
                  : 600;
          assert.ok(totalTris > 0 && totalTris <= cap, `${entry.id} (${tier}, floor=${isFloor}) ${totalTris} <= ${cap} tris`);

          // Verify UV + normal attributes exist on all merged geometries and bounding box is finite.
          for (const geo of [parts.baseGeo, parts.mountGeo, parts.yokeGeo, parts.headGeo, parts.glassGeo]) {
            assert.ok(geo.getAttribute('position') && geo.getAttribute('normal') && geo.getAttribute('uv'));
            geo.computeBoundingBox();
            assert.ok(Number.isFinite(geo.boundingBox.min.x) && Number.isFinite(geo.boundingBox.max.y));
          }

          // Hung clamps sit above y=0 (dir=-1); floor feet sit in [0, 0.03] (dir=+1).
          parts.mountGeo.computeBoundingBox();
          if (!isFloor) {
            assert.ok(parts.mountGeo.boundingBox.max.y > 0.01, `${entry.id} hung clamp extends above mount plane`);
          } else {
            assert.ok(parts.mountGeo.boundingBox.min.y >= -1e-4 && parts.mountGeo.boundingBox.max.y < 0.05, `${entry.id} floor feet sit at deck plane`);
          }

          parts.baseGeo.dispose();
          parts.mountGeo.dispose();
          parts.yokeGeo.dispose();
          parts.headGeo.dispose();
          parts.glassGeo.dispose();
        }
      } else {
        const isFloor = entry.renderTypes.every((rt) => rt === 'hazer' || rt === 'smoke' || rt === 'co2' || rt === 'floor_laser');
        const parts = buildStaticModelParts(spec, isFloor, tier);
        const totalTris = countTriangles(parts.bodyGeo) + (parts.glassGeo ? countTriangles(parts.glassGeo) : 0);
        const cap = tier === 'high' ? 600 : 250;
        assert.ok(totalTris > 0 && totalTris <= cap, `${entry.id} static (${tier}) ${totalTris} <= ${cap} tris`);
        parts.bodyGeo.dispose();
        parts.glassGeo?.dispose();
      }
    }
  }
});

test('catalogue pan-tilt heads converge on focus points with per-model pivotY and battens aim tilt-only', () => {
  const target = new THREE.Vector3(2.5, 1.2, 4.0);
  for (const entry of EQUIPMENT_CATALOG) {
    const spec = resolveModelSpec(entry.renderTypes[0] ?? 'beam', entry.id);
    if (spec.motion === 'pan-tilt') {
      const parts = buildMovingModelParts(spec, false, 'high');
      const root = new THREE.Group();
      root.position.set(-1.5, 7.2, -2.0);
      const yoke = new THREE.Group();
      yoke.position.y = -parts.yokeY;
      const head = new THREE.Group();
      head.position.y = -parts.headY;
      root.add(yoke);
      yoke.add(head);
      root.updateWorldMatrix(true, true);

      const local = root.worldToLocal(target.clone());
      const { pan, tilt } = aimAngles(local, false, 0, 0, spec.pivotY);
      yoke.rotation.y = pan;
      head.rotation.x = tilt;
      head.updateWorldMatrix(true, false);

      const origin = head.getWorldPosition(new THREE.Vector3());
      const axis = new THREE.Vector3(0, -1, 0).applyMatrix4(head.matrixWorld).sub(origin).normalize();
      const toTarget = target.clone().sub(origin);
      const miss = toTarget.clone().cross(axis).length();
      assert.ok(miss < 1e-6, `${entry.id} beam converged within 1e-6 (got ${miss})`);

      parts.baseGeo.dispose();
      parts.mountGeo.dispose();
      parts.yokeGeo.dispose();
      parts.headGeo.dispose();
      parts.glassGeo.dispose();
    } else if (spec.motion === 'tilt') {
      const tilt = aimTiltOnly({ x: 3, y: -5, z: 2.5 }, false, spec.pivotY);
      assert.ok(Number.isFinite(tilt) && Math.abs(tilt) <= TILT_LIMIT);
      // Directly in YZ plane (x = 0): beam points straight at target
      const root = new THREE.Group();
      root.position.set(0, 6, 0);
      const head = new THREE.Group();
      head.position.y = -spec.pivotY;
      root.add(head);
      const inPlane = new THREE.Vector3(0, 1, 3);
      const local = root.worldToLocal(inPlane.clone());
      head.rotation.x = aimTiltOnly(local, false, spec.pivotY);
      head.updateWorldMatrix(true, false);
      const origin = head.getWorldPosition(new THREE.Vector3());
      const axis = new THREE.Vector3(0, -1, 0).applyMatrix4(head.matrixWorld).sub(origin).normalize();
      const miss = inPlane.clone().sub(origin).cross(axis).length();
      assert.ok(miss < 1e-6, `${entry.id} tilt-only converged in YZ plane (got ${miss})`);
    }
  }
});

test('FixtureModelCache reuses geometries across rebuilds, protects sharedResources, and disposes cleanly', () => {
  const cache = new FixtureModelCache('high');
  const first = cache.getMoving('beam', 'robe-megapointe', false);
  const second = cache.getMoving('beam', 'robe-megapointe', false);
  assert.equal(first.headGeo, second.headGeo, 'identical model reuses cached BufferGeometry');
  assert.ok(cache.sharedResources.has(first.headGeo), 'cached geometry is registered in sharedResources');

  let disposed = 0;
  first.headGeo.addEventListener('dispose', () => {
    disposed++;
  });
  assert.equal(disposed, 0);

  // Switching tier was removed as unsafe on live rigs; beginRebuild/endRebuild prunes stale cabinet-back geometries (M4).
  for (let i = 0; i < 30; i++) {
    cache.beginRebuild();
    cache.getLedCabinetBack(0.5 + i * 0.01, 0.5);
    cache.endRebuild();
  }
  assert.equal(cache.cabinetBackCount, 1, 'stale cabinet-back geometries are pruned on rebuild');

  cache.dispose();
  assert.equal(disposed, 1, 'cache.dispose frees cached moving head geometry');
  assert.equal(cache.cabinetBackCount, 0);
});

test('stageSnapshot strips normalMap, preserves catalogId userData, and caps LED cabinet back instances', () => {
  const mats = createSharedMaterials({ tier: 'high' });
  const fakeNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  mats.hardwareBody.normalMap = fakeNormal;

  const rig = createBlankDesign();
  const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), mats.hardwareBody);
  nameFixtureUnit(
    fixture,
    { id: 'g1', type: 'beam', modelName: 'Robe MegaPointe', catalogId: 'robe-megapointe', count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
    0,
    1,
  );
  const smallBacks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.5, 0.08), mats.hardwareBody, 4);
  smallBacks.name = 'LED cabinet backs';
  smallBacks.userData.kind = 'ledCabinetBacks';
  for (let i = 0; i < 4; i++) smallBacks.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i, 0, 0));

  const snapSmall = stageSnapshot(rig, [fixture, smallBacks], mats);
  const clonedFixture = snapSmall.getObjectByName('Robe MegaPointe 1');
  assert.equal(clonedFixture.userData.catalogId, 'robe-megapointe');
  assert.equal(clonedFixture.material.normalMap, null, 'GLB snapshot strips normalMap');
  assert.equal(snapSmall.getObjectByName('LED cabinet backs').children.length, 4);
  assert.equal(snapSmall.userData.cabinetBacksOmitted, undefined);

  // Exceeding MAX_GLB_CABINET_BACK_INSTANCES omits backs and sets userData.cabinetBacksOmitted
  const hugeBacks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.08),
    mats.hardwareBody,
    MAX_GLB_CABINET_BACK_INSTANCES + 1,
  );
  hugeBacks.name = 'LED cabinet backs';
  hugeBacks.userData.kind = 'ledCabinetBacks';
  const snapHuge = stageSnapshot(rig, [hugeBacks], mats);
  assert.equal(snapHuge.getObjectByName('LED cabinet backs'), undefined);
  assert.equal(snapHuge.userData.cabinetBacksOmitted, true);

  fixture.geometry.dispose();
  smallBacks.geometry.dispose();
  smallBacks.dispose();
  hugeBacks.geometry.dispose();
  hugeBacks.dispose();
  fakeNormal.dispose();
  disposeSharedMaterials(mats);
});

test('DXF export emits distinct family block and catalogId XDATA for catalogue battens while preserving legacy blocks', () => {
  const rig = createBlankDesign();
  rig.trussPods = [
    {
      id: 'p1',
      name: 'Front',
      shape: 'box',
      width: 8,
      x: 0,
      baseY: 6,
      z: 0,
      rotationY: 0,
      motorized: false,
      motorMinY: 6,
      motorMaxY: 6,
      fixtures: [
        { id: 'w-legacy', type: 'wash', modelName: 'Legacy Wash', count: 1, dmxUniverse: 1, dmxStartChannel: 1 },
        {
          id: 'w-batten',
          type: 'wash',
          modelName: 'GLP impression X4 Bar 20',
          catalogId: 'glp-impression-x4-bar-20',
          dmxMode: 'Normal',
          dmxChannels: 34,
          count: 1,
          dmxUniverse: 1,
          dmxStartChannel: 13,
        },
      ],
    },
  ];
  const dxf = exportStageDxf(rig);
  assert.equal(bodyFamilyFor('wash', 'glp-impression-x4-bar-20'), 'led-batten');
  assert.ok(dxf.includes('SF_WASH\r\n'), 'legacy wash keeps SF_WASH block name');
  assert.ok(dxf.includes('SF_WASH_LED_BATTEN\r\n'), 'catalogue batten gets distinct SF_WASH_LED_BATTEN block');
  assert.ok(dxf.includes('glp-impression-x4-bar-20'), 'catalogue fixture writes catalogId XDATA');
});

test('QA regressions: UV band endpoints (H1), prototype catalogId (H2), BeamPools lensOffsetY (M1), render tier (M2), textured head cells (M5), hung static clamps (M6), aimTiltOnly edge cases', () => {
  // H1: BoxGeometry faces retain full non-zero UV span inside the target band (exact 0 and 1 never collapse).
  const box = new THREE.BoxGeometry(1, 1, 1);
  mapGeometryUvToBand(box, 5, 0.02, 0.98); // ConnectorPlate band = 5
  const uv = box.getAttribute('uv');
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const bandSpan = 1 / HARDWARE_ATLAS_BAND_COUNT;
  assert.ok(maxU - minU > 0.9, `box UV U span preserved (got ${maxU - minU})`);
  assert.ok(maxV - minV > bandSpan * 0.7, `box UV V span preserved (got ${maxV - minV})`);
  assert.ok(minV >= 5 * bandSpan + bandSpan * 0.11 && maxV <= 6 * bandSpan - bandSpan * 0.11, 'stays within mip-safe band margin');
  box.dispose();

  // H2: Hostile Object.prototype keys in catalogId fall back cleanly without returning prototype functions.
  for (const hostile of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(hasModelSpecForCatalogId(hostile), false);
    const spec = resolveModelSpec('beam', hostile);
    assert.equal(typeof spec, 'object');
    assert.ok(spec.base && typeof spec.base.w === 'number');
    const parts = buildMovingModelParts(spec, false, 'high');
    parts.baseGeo.dispose();
    parts.mountGeo.dispose();
    parts.yokeGeo.dispose();
    parts.headGeo.dispose();
    parts.glassGeo.dispose();
  }

  // M1: BeamPools reads beam.userData.lensOffsetY so floor/deck pools originate at each model's real lens face.
  const pools = new BeamPools(2, 10, 8, 1);
  const fakeHead = new THREE.Group();
  fakeHead.position.set(0, 6, 0);
  const fakeBeam = new THREE.Mesh(new THREE.BufferGeometry());
  fakeBeam.userData.lensOffsetY = 0.27;
  fakeHead.add(fakeBeam);
  fakeHead.updateMatrixWorld(true);
  pools.begin();
  pools.add(fakeBeam, 'beam', false, new THREE.Color(0xffffff), 1.0, fixtureOptics('beam'));
  const deckLensAttr = pools.group.children[0].geometry.getAttribute('lens');
  assert.ok(Math.abs(deckLensAttr.getY(0) - (6 - 0.27)) < 1e-5, `pool lens Y matches 6 - 0.27 (got ${deckLensAttr.getY(0)})`);
  pools.dispose();
  fakeBeam.geometry.dispose();

  // M2: Render tier keeps 1366x768 & 1280x720 desktops on high while phones & constrained coarse devices get low.
  assert.equal(resolveRenderTier({ width: 1366, height: 768, coarsePointer: false, cores: 8 }), 'high');
  assert.equal(resolveRenderTier({ width: 1280, height: 720, coarsePointer: false, cores: 4 }), 'high');
  assert.equal(resolveRenderTier({ width: 390, height: 844, coarsePointer: true, cores: 6 }), 'low');
  assert.equal(resolveRenderTier({ width: 1024, height: 768, coarsePointer: true, cores: 4 }), 'low');
  assert.equal(resolveRenderTier({ width: 520, height: 900, coarsePointer: false, cores: 8 }), 'low');

  // M5: Textured HazardAndCells strip on low-tier batten and wash stub-cells lives in headGeo (textured hardwareBody).
  for (const [id, tier] of [['glp-impression-x4-bar-20', 'low'], ['robe-spiider', 'high']]) {
    const parts = buildMovingModelParts(MODEL_SPECS[id], false, tier);
    const headUv = parts.headGeo.getAttribute('uv');
    let hasBand7 = false;
    for (let i = 0; i < headUv.count; i++) {
      if (headUv.getY(i) >= 7 / HARDWARE_ATLAS_BAND_COUNT) {
        hasBand7 = true;
        break;
      }
    }
    assert.ok(hasBand7, `${id} (${tier}) maps HazardAndCells onto textured headGeo`);
    parts.baseGeo.dispose();
    parts.mountGeo.dispose();
    parts.yokeGeo.dispose();
    parts.headGeo.dispose();
    parts.glassGeo.dispose();
  }

  // M6: Hung static fixtures (strobe, blinder, laser) seat their clamp cleanly above the yoke crossbar (mountOffsetY).
  for (const id of ['glp-jdc1', 'martin-atomic-3000-led', 'mole-richardson-molefay-4lite', 'chauvet-strike-4', 'kvant-clubmax', 'kvant-spectrum']) {
    const spec = MODEL_SPECS[id];
    const parts = buildStaticModelParts(spec, false, 'high');
    const halfBodyH = spec.family === 'laser-head' ? spec.base.h / 2 : spec.head.len / 2;
    assert.ok(parts.mountOffsetY > halfBodyH, `${id} mountOffsetY clears housing`);
    parts.bodyGeo.computeBoundingBox();
    assert.ok(parts.bodyGeo.boundingBox.max.y > parts.mountOffsetY + 0.04, `${id} clamp extends above yoke top`);
    parts.bodyGeo.dispose();
    parts.glassGeo?.dispose();
  }

  // aimTiltOnly edge cases: target at pivot, target directly overhead, and -0 safety.
  assert.ok(Number.isFinite(aimTiltOnly({ x: 0, y: -0.2, z: 0 }, false, 0.2)));
  assert.ok(Math.abs(aimTiltOnly({ x: 0, y: 10, z: 0 }, false, 0.2)) <= TILT_LIMIT);
  assert.ok(Number.isFinite(aimTiltOnly({ x: 0, y: -5, z: -0 }, false, 0.2)));
});
