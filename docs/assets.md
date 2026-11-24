# 3D Hardware Assets, Procedural PBR Textures & Budgets

StageForge renders every real catalogue model across the 3D WebGL view, 2D SVG stage plan, DXF CAD export, GLB export, and equipment picker/manifest using **100% original procedural Three.js geometry and deterministic procedural PBR textures**.

No third-party 3D meshes, photographs, logos, or image textures are bundled.

---

## Asset Provenance & Licence Table

Every visual asset ships as MIT-licensed source code in this repository, generated deterministically at runtime with zero network fetches (fully compatible with offline Electron and strict CSP):

| Asset | Source module | Resolution / Format | Seed / Determinism | Licence |
|---|---|---|---|---|
| Hardware PBR trim-sheet albedo | `src/engine/hardwareMaterials.ts` | 512×512 (high) / 256×256 (low) RGBA `CanvasTexture` | Mulberry32 `0x5f2a8c1d` | MIT (StageForge original) |
| Hardware PBR roughness / metalness map (packed G/B) | `src/engine/hardwareMaterials.ts` | 512×512 (high) / 256×256 (low) linear `CanvasTexture` | Mulberry32 `0x5f2a8c1d` | MIT (StageForge original) |
| Hardware PBR tangent-space normal map | `src/engine/hardwareMaterials.ts` | 256×256 (high) / 128×128 (low) linear `CanvasTexture` | Derived from atlas height field (`0x5f2a8c1d`) | MIT (StageForge original) |
| Stage marley deck albedo | `src/engine/hardwareMaterials.ts`, `src/engine/geometryBuilders.ts` | 512×512 (high) / 256×256 (low) sRGB `CanvasTexture` | Mulberry32 `0x71b3e905` | MIT (StageForge original) |
| Speaker grille perforations & acoustic cloth | `src/engine/geometryBuilders.ts` | 128×128 sRGB `CanvasTexture` | Deterministic geometry loop | MIT (StageForge original) |
| Procedural hardware 3D models (all 34 catalogue entries + 14 body families) | `src/engine/fixtureModels.ts` | Merged `BufferGeometry` per articulated sub-part + instanced LED cabinet backs | Deterministic procedural builders | MIT (StageForge original) |
| Built-in ILDA demo clips & GPU line buffers | `src/data/ilda.ts`, `src/engine/ildaRenderer.ts` | Big-endian IDTF Format 5 bytes + baked shared-attribute `LineSegments` | Deterministic math encoder | MIT (StageForge original) |
| 2D plan & elevation silhouettes (SVG & DXF) | `src/data/equipmentSymbols.ts`, `src/components/EquipmentThumbnail.tsx` | Pure vector primitives (`rect`, `circle`, `poly`) in metres | Deterministic data table | MIT (StageForge original) |

---

## Hardware Trim-Sheet Atlas Layout

All fixture housings share **one** `MeshStandardMaterial` (`hardwareBody`) sampling an 8-band horizontal trim-sheet atlas, plus **one** shared glossy lens-bezel `MeshStandardMaterial` (`hardwareGlass`). Each fixture unit keeps its own private emissive `MeshBasicMaterial` for its live DMX-driven lens/aperture.

| Band | V range | Finish | Roughness / Metalness | Used for |
|---|---|---|---|---|
| 0 | 0/8 – 1/8 | Black powder-coat (fine grain) | ~0.48 / 0.24 | Fixture bases, head bodies, enclosures |
| 1 | 1/8 – 2/8 | Brushed dark anodised aluminium | ~0.28 / 0.84 | Yokes, optical snouts, collars, cabinet frames |
| 2 | 2/8 – 3/8 | Cast / milled alloy | ~0.34 / 0.88 | Omega brackets, half-coupler clamps, latches, cryo barrels |
| 3 | 3/8 – 4/8 | Matte vulcanised rubber | ~0.88 / 0.04 | Floor feet, touring carry handles, grab bars |
| 4 | 4/8 – 5/8 | Extruded heat-sink fins | ~0.32–0.68 / 0.35–0.78 | Head cooling louvers, IP65 housings, strobe backs |
| 5 | 5/8 – 6/8 | Rear connector plate | ~0.42 / 0.65 | Blue/grey powerCON + 5-pin XLR I/O bays |
| 6 | 6/8 – 7/8 | Symmetric OLED status strip | ~0.14–0.46 / 0.10–0.72 | Base menu displays (orientation-safe for hung & floor) |
| 7 | 7/8 – 8/8 | Hazard stripe (left) / multi-cell optic baffle (right) | Mixed | IEC laser caution stripes & multi-cell wash/batten lenses |

---

## Render Tiers & Budgets (Web + Phone)

StageForge selects a `RenderTier` (`'high'` vs `'low'`) once at `StageEngine` initialization based on coarse-pointer touch screens (`<= 820 px` or low core/memory devices) and narrow phone widths (`<= 640 px`), keeping standard desktop windows (such as 1366×768 laptops) on `'high'` while staying responsive on phones via GitHub Pages.

| Budget metric | High tier (desktop) | Low tier (phone / mobile) |
|---|---|---|
| Moving head (base + yoke + head + clamp/feet) | ≤ 1,500 triangles | ≤ 600 triangles |
| Static fixture / PAR / strobe / blinder / laser / FX box | ≤ 600 triangles | ≤ 250 triangles |
| Linear LED batten (16–20 cells) | ≤ 1,200 triangles | ≤ 400 triangles (textured strip) |
| LED cabinet rear tile (1 `InstancedMesh` draw call per wall) | ≤ 150 triangles | ≤ 60 triangles |
| Draw calls per moving head / static fixture | ≤ 7 / ≤ 6 | ≤ 7 / ≤ 6 |
| Reference template rig (`arena_mainstage`) | ≤ 350 draw calls, ≤ 400k triangles | ≤ 200 draw calls, ≤ 150k triangles |
| Hardware textures (GPU VRAM, incl. mipmaps) | ≤ 4 MB (512² albedo + 512² RM + 256² normal) | ≤ 1 MB (256² albedo + 256² RM + 128² normal) |
| Max devicePixelRatio | 2.0 (4× anisotropy on atlas) | 1.5 (1× anisotropy) |
| GLB export safety cap | Normal maps stripped, `maxTextureSize: 512`, LED cabinet backs capped at 2,000 instances (omitted silently above cap with `scene.userData.cabinetBacksOmitted = true` in glTF extras) | Same |

---

## Memory Lifecycle & Invariants

- Reusable `BufferGeometry` parts are cached in `FixtureModelCache` per `(modelId, isFloor, tier)` and registered in `sharedResources`.
- `StageEngine.releaseGroup()` skips disposing cached geometries and shared materials across `rebuildRig()` calls, while `beginRebuild()` / `endRebuild()` prunes any unused custom-sized LED cabinet back tiles so wall-size slider drags never leak GPU memory.
- `StageEngine.dispose()` frees the entire `FixtureModelCache`, any active `BakedIldaClip` (disposing all per-projector shared-attribute wrapper geometries together), and every unique texture in `SharedMaterials`.
- Loaded ILDA clips cap total points at 200,000 (`high` tier) and 60,000 (`low` tier), bake once into shared `BufferAttribute`s (1 `LineSegments` draw call per projector), and update only `geometry.setDrawRange` during playback.
- Every moving fixture builder anchors its `head` group origin strictly at `dir * pivotY` (`HEAD_PIVOT = 0.46 m` for legacy fixtures, catalogue-realistic `pivotY` for catalogue fixtures), preserving `focusAim.ts` and `beamAxes()` convergence.
