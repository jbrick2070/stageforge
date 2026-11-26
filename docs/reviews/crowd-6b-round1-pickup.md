# Crowd System 6B round 1 pickup agreement

Date: 2026-11-26 PST  
Checkout owner: dispatcher PID 39368  
Exact pickup: `f690f5e64b7100d156385115da450f6c0bba7508` (`docs: record Realism 6 console feel`)

## Queue and authority

The owner superseded the old Realism 6 receipt's queue. The active order is:

1. Crowd System 6B
2. Realism 7
3. P1 through P4

This round is the first releasable 6B slice. It owns the declarative crowd contract, deterministic standing and seated placement, the small Stage Designer draft/Apply workflow, v10 persistence, and rendering through the existing human mesh and Pitch Viewer path. It does not start Realism 7 or P1, does not add local GLB imports, and must not claim the entire 6B complete. The remaining 6B closeout still includes the original avatar library, realistic variation, robots, aliens, humanoid animals, original monochrome figures, the full selectable 1928 *Steamboat Willie* cast and preset with provenance/on-demand loading, the reviewed VR graphics pass, both direct emulator eyes, existing performance ceilings, QA, and later real-headset evidence where the plan requires it.

The checkout was clean at the exact pickup. `%LOCALAPPDATA%/stageforge-overnight/codex-sprint-owner.json` names PID 39368 and the same start SHA. No STOP marker exists in the LocalAppData or TEMP control roots. The actual runner log ends with the successful Realism 6 receipt at `f690f5e`. Current inbound QA `qa-60-realism-6-round-1-cycle-2-11aa8fb.md` says `VERDICT: NO BLOCKERS`. Claude CLI and the overnight Antigravity runner remain out. The existing guardian remains the only publisher; this process will not push.

## Approved external agreement retained

The two owner-approved records in `C:/Users/jeffr/Downloads/StageForge-Sprint-Plan/` are the source of product scope:

- `StageForge Crowd System.md`
- `StageForge Crowd 6B Coding Plan.md`

They preserve the prior read-only Codex, Antigravity, and Gemma agreement: prove authored placements with the current figure first; keep generator/editor work separate from model construction; require one shared maximum footprint, explicit foot/seat pivots, per-pose handset transforms, independent deterministic location/appearance/motion selections, numeric model/tier budgets, legacy resource parity, physical-safety invariance, and the dual-eye XR ceilings. The VR follow-up also preserves contact/seated depth, matte readable materials, distinct low-detail silhouettes, stable detail choice across both eyes, paired direct-emulator captures, and no headset claim from emulator evidence.

## Pickup contracts found in the code

- `show-v9.schema.json` is the latest released and frozen schema. Realism 6 owns v9. Crowd therefore takes the lowest available additive schema, v10. The planned P2 schema becomes v11 if it still needs an additive format change; that number remains conditional until P2 pickup.
- `makeShowFile` chooses the oldest writer that represents every authored field. A show with no authored crowd must keep its legacy writer version and byte-compatible legacy load behavior.
- `NativeStage` is a version-1 wall/layout overlay. `pruneNativeStage` intentionally removes an empty wrapper. Crowd is independently meaningful, so the proposed v10 contract stores it as optional top-level `crowd`, not inside `stage`. A crowd-only show therefore survives stage pruning, while the explicit rig-only export still omits it.
- Stage Designer already owns private structured-clone draft history, Cancel, undo/redo, validation, and one Apply transaction. Crowd joins that draft rather than creating a second editor or live mutation path.
- `buildVenueArchitecture` owns the one-batch current crowd, theatre seat generation, contact patches, phone matrix sharing, and the exact legacy no-authored-crowd path. The authored resolver will feed this path; absent `crowd` keeps the legacy branch and allocation behavior.
- App show open, bundle open, Pitch Viewer entry/exit, AI whole-show apply/revert, and save paths each need crowd state explicitly. Pitch Viewer must rebuild from the parsed crowd without mutating the saved desk snapshot.
- Current XR emulator ceilings are 270 draws, 760,000 triangles, 26 renderer textures, and one menu-owned texture. The measured Arena reference used 262 draws, 745,712 triangles, and 25 renderer textures, leaving 8 draws, 14,288 triangles, and 1 renderer texture. First-slice authored rendering reuses the exact current crowd geometry/material/texture path and therefore admits zero additional model draws, triangles, or textures versus equal-density legacy rendering.

## Proposed v10 data and deterministic resolver

`crowd` is bounded authored data only:

- `generatorVersion: 1` and unsigned 32-bit `seed`;
- at most 32 rectangular standing/seated zones, each with a stable ID, bounds, `occupancy` and bounded model weights;
- at most 32 rectangular exclusions, with exclusions always winning;
- at most 64 deliberate placements, each with a stable ID, model, supported pose and yaw; a standing placement has a bounded world position, while a seated placement must reference a real stable theatre seat ID.

Generated positions and per-frame state never enter the show file. Standing candidates use a world-anchored clearance grid; seated candidates use stable theatre row/column IDs from the same seat definition used to build the theatre. Candidate IDs do not depend on density. Stable hash domains are separate for location jitter, occupancy rank, model appearance, phone ownership, palette, and motion phase. Density takes a prefix of occupancy-ranked candidates, so lowering it removes a repeatable subset. Appearance/model weights never alter positions. Zones resolve in lexicographic stable-ID order and the first zone owns an overlapping candidate. Exclusions always win. Explicit placements reserve space before generated occupants; an explicit placement inside an exclusion or an explicit/explicit clearance collision invalidates the document rather than silently dropping a person. All collisions use the registry's shared clearance cylinder.

The resolver returns requested and placed counts plus readable rejection counts. It rejects duplicate IDs, non-finite or out-of-venue coordinates, invalid rectangles/weights, unsupported pose/model pairs, missing or duplicate seat references, explicit placement collisions, exclusion conflicts, height overflow, and total-count overflow before renderer allocation. The authored cap remains 680 occupants in this slice, matching the largest legacy venue allocation.

## Shared model contract before isolated asset work

The code registry is authoritative for every built-in asset contribution:

- stable model ID and family;
- measured standing and seated height;
- maximum clearance cylinder radius independent of visual LOD;
- foot pivot and seat pivot in model-local metres;
- supported poses;
- handset translation and Euler rotation for each pose that supports a phone;
- per-tier triangle, material, texture and batch contribution limits;
- source/provenance fields for historical assets.

The first registered model is the existing StageForge human. Its authored path must use the current merged/morphed figure and the current phone plane unchanged, so the equal-density delta is 0 draws / 0 triangles / 0 textures on high, low and XR. Asset-lane acceptance is fail-closed against the aggregate XR headroom above: no integrated model mix may add more than 8 draws, 14,288 triangles or 1 renderer texture to the measured Arena reference, and both eyes must choose the same detail level. Rich assets that cannot fit need an accepted proxy; they do not relax the ceiling.

The existing figure's contract records the actual foot pivot at local `[0, 0, 0]`, maximum raised-arm height of 2.15 m at its maximum legacy standing scale, and a 0.47 m clearance radius. That radius rounds the measured full visual X extent of ±0.463 m upward; the 0.42 m contact patch is only a feathered floor shadow and is not the maximum footprint. The current standing-phone local transform is translation `[0.37, 1.90, 0.145]` metres with a Y rotation of 180 degrees. Seated placement records a compatibility seat pivot and permits no phone in this first mesh; later assets must supply a real seated pose and a seated handset transform before advertising that capability.

## Independent consult adjudication

The time-boxed read-only `gpt-5.6-terra` consult is preserved in the run record as `crowd-6b-design-terra-reply.md`. Its final decision accepted top-level v10 state and existing Stage Designer history; it modified the resolver agreement to require a single extracted theatre-anchor source, lexicographic first-zone ownership, explicit/exclusion fail-closed semantics, real seat IDs for deliberate seated placements, and an enforceable exact legacy-compatible renderer branch. Those changes are adopted above. It confirmed that no conceptual conflict prevents complete App/Pitch Viewer threading, but named crowd capture/restore, rig-only reset, normal/bundle open, AI whole-show apply/revert and engine/context rebuild as mandatory paths. Its suggested 0.42 m radius was adjusted to 0.47 m because direct geometry measurement showed that 0.42 m describes only the contact patch while the visible figure reaches ±0.463 m; this is the sole numeric correction to the advice.

## First-slice acceptance

- Valid standing zones with an aisle/pit exclusion and theatre zones using real seat anchors reproduce ordered IDs, positions, poses, model family and motion phase after JSON, bundle and cold reopen.
- Fixed seed plus model-weight edits preserves positions; lower occupancy is a strict identity subset.
- Explicit placement, overlap order, group weights, finite bounds, height/aisle/exclusion checks, capacity reporting and hostile documents are covered in pure tests.
- Stage Designer Cancel, undo, redo and Apply operate on the combined rig/stage/crowd draft. Stage pruning and unrelated edits preserve crowd. New blank/replacing operations ask before discarding it.
- Legacy shows allocate and render the old crowd path. A default-settings legacy show opens correctly. A v10 authored crowd opens in Pitch Viewer, then exiting restores the isolated editor crowd.
- Reduced motion remains on the existing crowd-motion policy. Authored density does not change audience safety bounds, preflight, output arming, DMX or GLB export authority.
- The first slice receives focused tests, full exact-candidate gate, Terra-first independent QA, fixes/re-gate, a clean receipt commit, and an explicit remaining-6B handoff. It makes no headset-validation or full-6B-complete claim.
