# Read-only design consult: Crowd System 6B round 1

You are an independent reviewer of StageForge at exact pickup `f690f5e64b7100d156385115da450f6c0bba7508`.

READ ONLY. Do not edit files, commit, push, run Playwright/Electron, install dependencies, or start servers. You may inspect tracked files with git/rg/Get-Content and reason from them. Read `docs/reviews/crowd-6b-round1-pickup.md`, both external approved plans if accessible, and the actual contracts in `src/data/showFile.ts`, `src/data/studioGeometry.ts`, `src/components/StageDesigner.tsx`, `src/engine/geometryBuilders.ts`, `src/engine/StageEngine.ts`, `src/App.tsx`, `src/data/venueBounds.ts`, `src/schemas/show-v9.schema.json`, and current tests.

Goal: settle the implementation contract for the first independently releasable 6B slice before code changes. It must add stable declarative standing/seated crowd zones, exclusions, explicit placements, deterministic generation, a small Stage Designer draft/Apply/Cancel/undo/redo workflow, v10 persistence, and the existing human mesh through the current Pitch Viewer load path. It must preserve the remaining full-6B acceptance rather than claim it done.

Non-negotiables:

- legacy shows and writer versions remain unchanged when `crowd` is absent;
- released v1–v9 schemas stay byte-for-byte frozen; crowd may use the lowest new additive version;
- P2's future schema number is conditional after this slice;
- hostile input is rejected before renderer allocation; all fields and counts are bounded;
- separate deterministic domains for location, occupancy, appearance/weights, phone/palette and motion;
- density reduction is a strict repeatable identity subset; model-weight changes preserve positions;
- exclusions and explicit placements have stable priority; shared maximum footprint makes model swaps clearance-invariant;
- actual theatre anchors, row elevation and aisle gaps are shared with venue construction;
- authored density does not affect venue safety bounds, preflight, output arming, DMX or rig-only/architectural export authority;
- default legacy shows retain their current crowd and resource path;
- no dependency, external upload, direct push, Claude CLI, or lighting hardware;
- current XR reference is 262 draws / 745,712 triangles / 25 renderer textures against 270 / 760,000 / 26, leaving 8 / 14,288 / 1; the first slice must be equal-density zero-delta by reusing the current mesh;
- full 6B later includes the entire original library, realistic variation, robots/aliens/humanoid animals/original monochrome figures, full 1928 *Steamboat Willie* cast and preset/provenance/on-demand loading, and the reviewed dual-eye VR graphics pass.

Proposed decisions to adjudicate:

1. Store optional authored `crowd` as a top-level v10 show field, independent of `NativeStage`, because an authored crowd is meaningful when `pruneNativeStage` removes an empty wall/layout wrapper. Rig-only export intentionally omits it. Alternative: put crowd inside the version-1 native-stage overlay and change its pruning semantics.
2. Introduce a pure `crowdPlacement.ts` contract/resolver and a shared pure theatre-seat-anchor function. `geometryBuilders.ts` consumes the same seats and branches: no authored crowd executes the exact legacy algorithm; authored crowd consumes resolved placements but reuses the existing geometry/material/phone/contact path.
3. World-anchor standing grid candidates; stable theatre row/column candidate IDs; sort zones and explicit placements by stable IDs; resolve explicit placements and exclusions before generated positions. Use independently salted 32-bit hashes for location jitter, occupancy rank, appearance/model choice, phone/palette and motion.
4. Put crowd in the existing Stage Designer `Draft` and App/Pitch Viewer desk snapshot rather than create a separate editor/state machine.
5. Registry-first model contract: stable ID/family/provenance, max height, invariant clearance radius, foot/seat pivots, supported poses, per-pose phone transform, per-tier resource caps. Register only the existing human in this slice. Its authored path must be equal-density zero-delta; later rich models fail closed against the aggregate XR headroom unless a proxy fits.

Please report:

- a clear ACCEPT / MODIFY / REJECT verdict for each decision;
- any material missing invariant or failure mode, with exact code locations and a concrete scenario;
- the smallest safe v10 shape and cross-field validations;
- whether top-level state can be threaded through every open/save/viewer/revert path without a hidden contract conflict;
- numeric contract advice for current-human height, footprint, pivots, phone transform, and aggregate/per-tier budgets grounded in the current geometry;
- a focused test matrix for generator independence, stage pruning/unrelated edits, hostile docs, default legacy parity, offline save/reopen and Pitch Viewer isolation;
- final recommended agreement. Skip style nits and future features outside the first slice.

