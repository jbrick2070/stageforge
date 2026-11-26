# Crowd System 6B round 1 design agreement

Exact pickup: `f690f5e64b7100d156385115da450f6c0bba7508`  
Independent reviewer: Codex `gpt-5.6-terra`, read-only, 2026-11-26 PST  
Source plan: `docs/reviews/crowd-6b-round1-pickup.md`

The implementation agreement is settled before production code changes:

1. Authored crowd is an optional top-level show-v10 field. Shows without it keep the current oldest compatible writer. Frozen v1–v9 schemas are not edited. P2's next schema is conditionally v11.
2. One pure resolver owns standing grids, actual theatre anchors, exclusions, explicit reservations, stable identity and independent deterministic selection domains. Theatre construction consumes the same extracted anchor list.
3. Zones resolve in lexicographic ID order; first zone owns an overlapping candidate. Exclusions win. Explicit placements reserve first. Explicit/exclusion and explicit/explicit conflicts reject the document. Deliberate seated people reference real stable seat IDs.
4. Stage Designer's existing private draft, Cancel, undo/redo and Apply transaction expand to include crowd and validate the combined resulting rig/crowd atomically.
5. The sole first-slice model is `stageforge-human-v1`. The authored path reuses the current merged morph geometry, material, phone plane, contact patch and batching, enforcing an equal-density delta of 0 draws / 0 triangles / 0 textures. The contract records a 2.15 m raised-arm maximum, 0.47 m invariant clearance radius (rounded above the measured ±0.463 m visual extent; the 0.42 m contact patch is not the footprint), `[0,0,0]` foot/compatibility seat pivot, standing phone translation `[0.37,1.90,0.145]` m and rotation `[0,π,0]`, with no seated phone claim.
6. Crowd state is explicit in show save/open, bundle reopen, Pitch Viewer capture/apply/restore, AI whole-show apply/revert, engine rebuild and context restoration. It stays out of venue safety bounds, preflight, DMX/output arming, rig-only JSON, GLB, MVR, DXF and paperwork.
7. The first slice is independently releasable only after focused acceptance, full exact-candidate gate and Terra-first QA. It cannot close 6B; original/rich families, the complete 1928 cast, on-demand provenance assets and the reviewed paired-eye VR graphics pass remain.

No material implementation decision remains unresolved for this slice.
