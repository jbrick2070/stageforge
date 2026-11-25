# Codex graphics plan, 2026-11-24

Read-only consult by Codex (`gpt-6-astra`) on commit `2551645`. It read the code and ran nothing, so every timing is a proposed acceptance limit, not a measurement. Links point at files in the repository at that commit. Graphics Sprints 15 to 21 in `HANDOFF.md` turn this into work items.

I would fund seven bounded sprints, in the order below. **All timings are proposed acceptance limits, not measured results.** I read the code only; I ran no tests, changed no files, and used no network.

Keep Three.js **0.187.0**, WebGL2, and zero new dependencies. Put visual changes behind independent, default-off renderer flags, outside show-file serialization. Generate assets in code and record additions in `docs/assets.md`. Allocate optional resources only when enabled.

**Ranked sprints**

1. **Make output quality controllable and measurable.**  
   Users should see cleaner thin geometry and highlights on devices that can afford them, with predictable phone quality. In `StageEngine`, expose independent bloom resolution, bloom bypass, and AA controls. Retain NeutralToneMapping and one final OutputPass; compare existing composer MSAA against an optional Three.js FXAA pass rather than stacking them. Low tier must have a cheaper bloom option and an off switch; preserve current defaults until A/B evidence supports promotion.  
   **Tests:** linear ramps, saturated emitters, image/video colour equivalence, zero-bloom parity, resize/disposal, and tier budget checks. **Risk:** changing brightness or softening lasers. **Do not:** retune every material to compensate for an unverified colour-pipeline problem. Both tiers currently receive the same composer chain and two-sample targets. [Source](src/engine/StageEngine.ts:465)

2. **Make aerial prism patterns agree with their floor projections.**  
   This offers a clear realism improvement without another render pass. `VOLUMETRIC_BEAM_FRAG` already has edge profiles, shared atmospheric noise, directional scatter, and eight prism shafts. Extend `BeamPools` with fixture transverse axes and prism phase; evaluate a shared, derivative-filtered pattern in receiver coordinates while retaining its incidence, attenuation, and platform blockers. Start with the existing prism state, not a new gobo catalogue.  
   Both tiers retain batching; disable the enhancement on low tier if overlapping pools exceed budget. **Tests:** lens-origin math, grazing footprints, moving heads, prism rotation, proxy/unbatched parity, and floor-region pixel comparisons. **Risk:** overbright overlaps and different apparent pattern orientation. **Do not:** add eight meshes or lights per fixture. Keep existing lens emission/bloom; defer elaborate lens flares. [Existing receiver shader](src/engine/beamPools.ts:23)

3. **Give LED walls restrained viewing-angle response.**  
   Walls should remain readable frontally and lose some intensity at extreme grazing angles. Add surface normal/view direction to `LED_WALL_VERT`; apply a bounded angular emissivity curve. Preserve the existing derivative-aware diode resolution, pixel snapping, and cabinet seams—they already address much of the moiré problem. Use the same inexpensive model on both tiers, independently switchable.  
   **Tests:** front/side views, curved walls, camera-distance sweeps, fractional DPR, paused video, and brightness zero. **Risk:** excessive angular dimming or temporal shimmer. **Do not:** model individual LEDs, add another glow pass, or synchronously read video pixels for spill lighting. Current LED spill uses primary/accent colours rather than displayed media; treat that as an approximation, not content-derived illumination. [Shader](src/engine/shaders.ts:287)

4. **Improve deck sheen using material response.**  
   Users see scuffs and seams interrupt highlights instead of appearing solely as painted colour. Extend the seeded deck generator in `hardwareMaterials.ts` with subtle roughness variation; add a weak normal map on high tier. Reuse `MeshStandardMaterial`, existing spill lights, and the existing PMREM environment. Low tier gets one 128² roughness map; high gets shared 256² roughness/normal maps.  
   **Tests:** deterministic generation, correct texture colour spaces, close/far shimmer, feature-off parity, resource disposal, and export expectations. **Risk:** a wet/plastic-looking deck or noisy highlights. **Do not:** add planar reflections or SSR in this sprint. Fixtures already have substantial PBR atlas work; trusses already have metallic materials. Preserve those systems rather than replacing them. [Current deck material](src/engine/geometryBuilders.ts:127)

5. **Make crowd silhouettes respond more clearly to the show.**  
   Add restrained directional colour/rim terms to the existing crowd material: one aggregate show-light direction on low tier, two on high, with a strict brightness clamp. Keep existing instanced bodies, poses, contact patches, and phone screens. This is an artistic lighting approximation, not per-person beam tracing.  
   **Tests:** blackout, seated/standing venues, coloured backlight, camera orbit, phones remaining attached, and close-up halo checks. **Risk:** uniform glowing outlines. **Do not:** add individual lights, skinned spectators, or combine this with a GPU-animation rewrite. The crowd already receives standard lighting; its CPU animation is an optimization candidate, not a demonstrated bottleneck. [Existing crowd construction](src/engine/geometryBuilders.ts:1420)

6. **Prototype locally beam-lit puffs—one bounded slice of backlog item 8.**  
   Smoke crossing a beam should pick up its colour locally. Extend `AtmosphericParticles` with seeded simulation and per-instance illumination. Select a stable, capped candidate set, then evaluate at most two beam contributions per puff on low tier/four on high; avoid per-fragment loops over the whole rig. Add stable depth ordering within batches. Keep existing `FogExp2` and analytic beam haze.  
   **Tests:** seeded spawn/expiry, crossing coloured beams, maximum emissions, near-camera overdraw, overlapping smoke/CO₂, and tier caps. **Risk:** candidate-selection popping and inter-batch transparency errors; keep the feature experimental if overlap QA fails. **Do not:** promise true volumetric occlusion. Defer fluid simulation and fan response; tune CO₂ turnover separately within the existing trajectory model. [Current particle implementation](src/engine/ParticleSystem.ts:137)

7. **Improve laser core and scan-energy appearance.**  
   Extend existing `BakedIldaClip` processing with bounded dwell/corner weights that respect blanking. Prototype capped camera-facing segment ribbons with a bright core and softer halo in one shader, replacing the corresponding line draw rather than overlaying many draws. Low tier uses a much smaller segment cap and falls back to current lines; high permits more detail. Reuse haze density for approximate scatter.  
   **Tests:** blanked jumps, sharp corners, monochrome projectors, dense clips, near/far widths, draw-range playback, and disposal. **Risk:** excessive corner brightness and geometry growth. **Do not:** claim a physical galvo simulation or rebuild ILDA ingestion. Playback, blanking, and kpps-derived flicker already exist. [Existing playback path](src/engine/StageEngine.ts:2645)

**Performance acceptance budgets**

These are incremental ceilings at identical scene, time, camera, and resolution. “Phone-like” means the supplied throttled headless setup; it does **not** establish actual phone GPU performance. Memory covers added textures, buffers, and render targets; driver overhead remains to be measured.

| Sprint | Added draws | Phone-like Δms/frame | RTX laptop Δms/frame | Added GPU memory, low/high |
|---|---:|---:|---:|---:|
| 1. Output controls | ≤1, optional FXAA | ≤0 net | ≤0.10 | ≤0 net |
| 2. Prism projection | 0 | ≤0.20 | ≤0.15 | <0.1 MiB |
| 3. LED response | 0 | ≤0.10 | ≤0.05 | <0.1 MiB |
| 4. Deck response | 0 | ≤0.15 | ≤0.10 | ≤0.1 / 0.7 MiB |
| 5. Crowd lighting | 0 | ≤0.15 | ≤0.10 | <0.1 MiB |
| 6. Lit puffs | 0 | ≤0.60 | ≤0.30 | <0.1 MiB |
| 7. Laser ribbons | 0, replacement draws | ≤0.30 | ≤0.20 | ≤0.5 / 2 MiB |
| **Combined optional ceiling** | **≤1** | **≤1.50** | **≤1.00** | **≤2 / 4 MiB** |

Cap added laser triangles at **4,000 low / 16,000 high** across the scene. Other sprints add no geometry. Measure the combined configuration separately: isolated costs need not add linearly. Defaults incur no optional cost; automatic promotion requires no p95 regression. Do not spend hypothetical optimization savings.

**Measure first**

Add these probe capabilities before visual changes, as the first part of sprint 1:

- Record actual drawing-buffer size, CSS size, DPR, tier, backend, AA settings, active passes, particle counts, and ILDA segment counts.
- Separate CPU simulation, crowd transforms, particle updates, batch synchronization, and render submission. Add asynchronous, feature-detected GPU timer queries; reject disjoint results and never block waiting for them.
- Report warmed p50/p95/p99 frame intervals and GPU durations over repeated runs. Keep SwiftShader correctness, throttled CPU tests, RTX hardware, and real-phone measurements separate.
- Track upload bytes, render-target memory estimates, program counts, and resource growth across resize, rebuild, media replacement, and disposal.
- Add deterministic particle seeds and fixed simulation stepping. Test FOH, side, close-up, overlapping beams, dense smoke, and maximum authored scenery.
- Retain existing parity tests, but add approved reference images and localized regions. Current frozen tests compare alternate paths within one run; both paths can regress together, and whole-image averages can hide small defects. [Harness](tests/e2e/render-budget.spec.mjs:75)

**Backlog critique and avoid list**

Item 8’s order should change: **measurement and tier controls first, bounded particle lighting next, expensive volume/occlusion research later.** Its description is stale about ILDA support. Existing smoke already has lift, drag, curl, growth, and fading.

Camera-depth fading can soften intersections; it cannot cast a truss shadow along a beam. True light-path occlusion needs a separate representation or light-space visibility solution. Defer both a shadow atlas and froxel/ray-marched atmosphere beyond these one-day sprints.

Avoid full-resolution volumetrics, per-fixture shadow maps, dynamic cubemap captures, SSR, and planar scene rerenders on phones. Avoid per-diode geometry and per-person lights. Defer depth of field, motion blur, TAA, and exposure adaptation: fast beams/strobes and cue reproducibility make their artifacts consequential. Defer handheld motion too; existing camera easing already provides movement without disturbing authoring precision.

**Fix or investigate before adding more**

- **Untiered scenery is a concrete budget gap.** `scenicProps.ts` builds the same subdivisions on every device: an arch tube has 16,320 triangles; a tentacle tube plus cups has 19,968. Add low-detail variants before increasing scene complexity. These counts follow directly from the constructors. [Source](src/engine/scenicProps.ts:15)
- **CO₂ currently dies ascending.** Its minimum initial velocity, maximum lifetime, and drag leave positive vertical speed throughout. That contradicts the backlog’s falling-plume goal; any correction should remain flag-gated.
- **Particle capacities ignore tier**, and simulation uses `Math.random()`, complicating repeatable visual tests.
- **Bloom stays enabled when strength becomes zero.** Measure bypass savings. Renderer antialiasing plus composer MSAA also deserves investigation; I cannot establish redundant GPU work without the Three.js internals and runtime measurements.
- **Crowd transforms and batch validation run every frame.** Profile before changing them. Moving animation to vertices can trade CPU savings for greater GPU work.
- **`renderStats().visibleMeshes` is misleading:** it checks local visibility, not ancestors, batching layers, or actual submission. Whole-frame draw counting itself is correctly configured.