# Crowd System 6B round 2 design agreement

Date: 2026-11-26 PST  
Exact base: `91eea2e0a2fe08d26b050b73bcad8babae08f39a`  
Writing rule: one writer on `main`; no development branch, clone, worktree, or auxiliary checkout

## Slice boundary

This independently releasable 6B slice owns a reusable fail-closed built-in crowd-model contract, generator-v2 model-mix placement, two representative original procedural models, deterministic multi-batch rendering, Stage Designer mix authoring, show-v11 persistence, resource admission, and applicable v10/AI-schema follow-ups. It does not close Crowd 6B, start Realism 7 or P1, add custom GLB import, build the *Steamboat Willie* cast, run the final VR graphics pass, or implement the concept intro.

## Frozen compatibility boundary

1. `show-v10.schema.json` and generator version 1 are frozen. A v1 crowd accepts only `stageforge-human-v1` in both zone weights and explicit placements, retains the released first-weight exclusion radius, random domains, candidate IDs, positions, phases, palette, phone selection, ordering, and renderer behavior, and continues to write v10.
2. Before resolver refactoring, tests pin a representative released v1 result including ordered IDs, positions, phases, phones, and edge behavior. Round-1 QA R2 is not repaired by reinterpreting v1.
3. Generator version 2 owns the zone-edge repair and all non-human authoring. It constrains the existing 0.018 m jitter inside the authored zone and uses one pose-wide envelope—standing radius `0.47 m`, seated radius `0.26 m`, standing height `2.15 m`, seated height `1.42 m`—for zone bounds, exclusions, explicit/generated and mixed-pose collisions, and model admission. Model weights are sorted by stable model ID before appearance selection. Changing weights therefore cannot change eligible locations, placement IDs, motion phases, or the occupancy subset.
4. A crowd requires v11 when `generatorVersion === 2` or any zone/explicit placement references a non-human model. A compatible human-only v1 crowd still writes v10. A v2 crowd is never silently downgraded to v1. Future version selection takes the highest required feature version, so P2 becomes conditionally v12 in both implementation-plan statements and a future show needing v11 crowd plus P2 data writes v12.

## Model and renderer contract

5. The registry validates before use: stable safe ID and family, non-empty label/provenance/license, both supported poses, finite pivot/height/clearance and handset translation/rotation, envelope fit, and exact high/low/XR triangle, material-slot, material-texture, morph-texture, and figure-batch contributions.
6. Renderer admission measures the actual indexed geometry, material slots/maps, and whether an instanced morph texture is allocated, then compares those values with the manifest. Aggregate admission reports scene and two-eye submitted draws/triangles plus material and morph textures. Equal-density Arena deltas must fit the published remaining headroom of 8 submitted draws, 14,288 submitted triangles, and 1 renderer texture.
7. The exact legacy human geometry, morph targets, colors, shared animated phone matrix, contact patch, and absent-crowd branch remain unchanged. Its one instanced morph texture is explicitly counted as an existing renderer allocation rather than incorrectly reported as zero.
8. This slice adds `stageforge-robot-v1` and `stageforge-alien-v1` as original, offline, texture-map-free procedural geometry. Each stays at or below the human's 264 triangles per instance, uses one material and no morph texture, fits the shared envelopes, and has no handset until a measured socket is authored. They replace human instances at equal density, so submitted triangles and renderer textures cannot grow; two extra non-empty figure batches cost four submitted stereo draws, within the 8-draw Arena headroom.
9. Authored rendering groups placements by stable model ID. Within each batch, phone owners form the shared-matrix prefix and both the prefix and suffix are ID-sorted. The renderer records `placementId`, `modelId`, `batchIndex`, `instanceIndex`, pose, pivot, and seeded phase. Phone geometry applies the registered translation and Euler rotation and shares only its owning figure batch's matrix. One footprint batch spans the authored crowd.
10. StageEngine animates every batch using each placement's pose and existing seeded phase, without per-person lights or allocations. Crowd lighting binds the same aggregate uniforms to each batch, restores/disposes every cloned material on rebuild/context restore/teardown, and retains compatibility diagnostics plus explicit batch/mapping/resource evidence.

QA clarification: each pose also declares measured submitted height and XZ radius, including shared accessories. Generator v2 clamps vertical motion against those submitted bounds and scales XZ per pose/motion so the rendered figure and accessories remain inside the same resolver clearance; generator v1 retains its released unit XZ scale and motion exactly. The human standing submitted height is `1.965 m` because its shared handset plane is taller than the `1.918 m` figure geometry. Seated v2 figures are horizontally fitted to the `0.26 m` envelope rather than leaving the standing mesh width outside authoritative seat/zone bounds.

## Integration and registry updates

11. Stage Designer offers human-only and original-trio mix authoring through its existing draft/Apply, Cancel, undo/redo path. Selecting a non-human mix upgrades the draft to generator v2. JSON, bundle, Pitch Viewer, AI whole-show proposal/apply/revert, and saved IDs continue through the existing shared state paths.
12. Additive show v11 is registered together in `showFile.ts`, Vite, desktop preparation, the desktop AI service/tool/resource descriptors, docs, unit tests, browser tests, and packaged Electron smoke. Strict full-show proposals continue to use `parseShowFile`. The stale v9 descriptor/v10 response mismatch from round-1 QA R3 is corrected to v11. V10 receives its frozen canonical digest pin.
13. No network asset is required. The procedural models are real exercised output, not dormant scaffolding. Asset-worker handoff is deferred; if later scheduled, it happens sequentially on this same `main` checkout after Codex records a committed checkpoint and releases the writing slot.

## Review adjudication

The targeted read-only Terra consult is preserved at `%LOCALAPPDATA%/stageforge-overnight/codex-crowd6b-round2-20261126-193121/crowd-6b-round2-targeted-codex.md`. It verified the v1 jitter defect, first-weight exclusion dependency, singular renderer/lighting/phone paths, missing resource admission, strict full-show parser reuse, stale AI labels, and divergent P2 version statements. Its corrections—literal v1 isolation and golden pin, v1 human-only rejection, v2 envelope use across every collision class, per-placement pose, precise phone-prefix order, handset rotation, actual morph/material accounting, and highest-required schema routing—are adopted above. Its sandbox could not start the test runner; this writer will run the normal gates.
