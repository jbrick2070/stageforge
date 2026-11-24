# Open standards roadmap

StageForge keeps one engine and one source of truth: the React + three.js Studio, its SVG stage plan and the versioned JSON show format (v1–v3, extended additively). It adopts open standards at the edges, where shows meet other tools and real rigs. The Godot prototype is retired (preserved at the `native-v0.1.0` tag); GLB export is the 3D hand-off for other engines.

This plan started from an external research report and was fact-checked against primary sources on 2026-11-23. Corrections are folded in below.

## Decisions

| Area | Adopt | Why |
|---|---|---|
| Rig interchange | **MVR 1.6** (DIN SPEC 15801:2023-12) + **GDTF 1.2** (DIN SPEC 15800:2022-02), via an owned TypeScript codec | The common format of grandMA3, Vectorworks Spotlight, Capture, Depence, Unreal's DMX plugin and BlenderDMX |
| Live DMX | **sACN (E1.31)** and **Art-Net 4** from the Electron main process; Web Serial (Enttec) in the browser | Browsers and sandboxed renderers cannot open UDP sockets |
| Show control | **OSC**, **Web MIDI** (MTC/MSC), Art-Net timecode | Consoles, QLab and media servers chase or trigger cues |
| 3D / CAD | **glTF/GLB** (already exported) and **DXF** (already exported; import later) | Covers concert workflows without WASM or licence risk |
| Tempo | **web-audio-beat-detector** (MIT) + **realtime-bpm-analyzer** (Apache-2.0), with manual tap/nudge | Permissive, no WASM |
| Do not bundle | Essentia.js (AGPL-3.0), aubio (GPL-3.0+), OLA (GPL/LGPL), BlenderDMX (GPL-3.0), Perastage (GPL-3.0+), needle-tools/usd-viewer (PolyForm Noncommercial) | Licences incompatible with an MIT app; use only as external tools or test peers |

No open-source stage editor is worth embedding: the closest entertainment tools are GPL, simpleVIS (MIT) is an import-only app rather than a library, and architectural planners lack rigging semantics.

## Fact-check corrections

- **libMVRgdtf** is not a standard OSS licence: "MVR SDK License 1.0" (Apache-derived) requires keeping the licence, an acknowledgement in product docs, DIN SPEC 15800 conformance and no changes to the GDTF format. It now compiles with Emscripten (Sep 2026) but ships no WASM build. Xerces is optional; boost is only for MVR-xchange. An owned TypeScript codec remains the cleaner choice.
- **sacn** (npm) is Apache-2.0 and Node-only (`dgram`): it belongs in the Electron main or a utility process. **dmxnet** is MIT. **node-osc** is Apache-2.0 only from 11.2.0 (pin ≥ 11.2.0; earlier is LGPL). **webmidi** is Apache-2.0. **realtime-bpm-analyzer** is Apache-2.0 from 5.0.0.
- **@tarikjabiri/dxf** (already a dependency) is a DXF *writer*. **dxf-parser** is MIT but unmaintained since 2021; a small owned DXF reader for LINE / LWPOLYLINE / INSERT may be safer.
- **fast-xml-parser** (MIT, parse + build, pure JS, runs in Node tests) had 11 advisories in 2026 (entity-expansion DoS, builder injection). Require ≥ 5.12.1 / fast-xml-builder ≥ 1.3.2 and keep StageForge's own guards (no DTDs, size caps).
- **Open Fixture Library** fixture data is covered by the repository's MIT licence (no separate data licence). Keep its copyright notice if fixture JSON is redistributed.
- **Unreal** imports GDTF (since 4.26) and imports/exports MVR; export is evidenced from 5.1 preview fix lists, not a release note. Export requires unedited GDTFs.
- **d&b ArrayCalc** "MVR Exchange" is beta only (announced Nov 2026); no GDTF support found.
- **BaukeWestendorp/mvr-gdtf** is archived; its successor is `rigger` (MIT OR Apache-2.0, Rust).
- **Electron:** sandboxed renderers can use Web Serial (handle `select-serial-port`, grant `serial`) and Web MIDI (`midi` / `midiSysex` via the permission handlers).
- Every Apache-2.0 and MIT dependency needs its licence text and copyright line in a third-party notices file shipped with the desktop build.

## Milestone 3: MVR + GDTF interchange (first integration)

Goal: export a StageForge show's rig to `.mvr` and import `.mvr` rigs from other tools, round-tripping positions, orientation and DMX patch, in the web app and the sandboxed desktop renderer with no CSP or IPC changes.

### What StageForge already has

- ZIP: `fflate` (MIT) in `src/data/showBundle.ts` and `src/data/gdtfOptics.ts`. Reuse it for MVR/GDTF archives (STORE/DEFLATE, flat root).
- GDTF reading: `gdtfOptics.ts` parses beam optics with `DOMParser`, which Node tests lack. The codec needs a DOM-free XML layer (fast-xml-parser) so the same code runs in tests.
- Patch layout: `src/data/dmxPatch.ts` (`DMX_CHANNELS`: Pan, Tilt, Dimmer, Red, Green, Blue, Zoom, Strobe rate…), the source for generic GDTF profiles.
- Geometry: `src/data/stagePlan.ts` and `studioGeometry.ts` define the yaw convention (rotation about +Y; front = (sin yaw, cos yaw)), tested against three.js. `src/engine/stageGlb.ts` exports scene geometry for SceneObjects.

### Design

1. **Module:** `src/interchange/mvr/` — `archive.ts` (zip rules, case-insensitive unique names, NUL-byte strip, size caps), `xml.ts` (guarded parse/build), `matrix.ts`, `gdtf.ts` (generic profiles + mode reader), `exportRig.ts`, `importRig.ts`. Pure TypeScript; no native modules, no WASM.
2. **Coordinates:** StageForge is right-handed Y-up metres with +Z toward the audience. MVR is right-handed Z-up millimetres. Map `(x, y, z)_SF → (1000·x, −1000·z, 1000·y)_MVR` (−90° about X), so the audience is MVR −Y and upstage +Y. Yaw about SF +Y equals yaw about MVR +Z with the same sign. GDTF positions are metres with a row-major 4×4 matrix (transpose versus MVR's `{u}{v}{w}{o}`); GDTF models hang, so floor fixtures get a 180° flip. Layer matrices carry elevation only.
3. **Object mapping:** platforms and layout props → SceneObject (GLB from `stageGlb`); truss pods and layout trusses → Truss; beams, washes, strobes, blinders and lasers → Fixture with generic GDTF + mode; LED walls (main and secondary) → VideoScreen; speaker hangs → SceneObject (audio GDTF later); focus marks → FocusPoint; patch → `<Addresses>` (MVR break is 0-based, GDTF DMXBreak 1-based).
4. **Identity and passthrough (show v4, additive):** an optional top-level `interchange` block maps StageForge object IDs to persistent MVR UUIDs and stores unrecognised MVR XML fragments (bounded size) so re-export preserves other tools' data, as DIN SPEC 15801 asks. UUIDs are created on first export and kept. v1–v3 files stay byte-for-byte loadable; v4 is written only when that block exists (as v3 is written only when a stage overlay exists).
5. **Generic GDTF profiles:** StageForge-authored (MIT) moving beam, moving wash, strobe, blinder and laser profiles whose modes match `DMX_CHANNELS`, so the exported patch is 1:1 with the simulated desk. Manufacturer GDTFs found in an imported MVR are kept as files and referenced, not rewritten.
6. **Import scope v0.1:** fixtures (position, orientation, patch, GDTF mode footprint), trusses, video screens, focus points and GLB scene objects; `.3ds` meshes and pixel-mapped multi-instance devices render as placeholders with correct footprints (full support next).
7. **UI:** File menu and Show files gain "Export MVR…" and accept `.mvr` in "Open show or rig…"; Electron's `will-download` filter list gains `.mvr`.

### Acceptance tests

1. **Round trip (unit):** a reference rig — deck at origin, front truss at (0, 8, −4) m yawed +30°, two hung heads and one floor head, an aimed LED wall, an aimed line-array hang, an RGBW fixture — exports to `.mvr` and re-imports with positions within 1 mm, angles within 0.05°, handedness preserved and the DMX patch identical.
2. **Spec conformance (unit):** every exported archive has a flat root, STORE/DEFLATE only, no encryption, case-insensitive unique names, UTF-8 `GeneralSceneDescription.xml`, and validates against the mvrdevelopment/spec XSDs (vendored as test fixtures).
3. **Edge cases (unit):** trailing NUL bytes, reversed physical ranges, channels out of document order (slots from `Offset`), DMX break 0 vs 1, CIE xyY colours, a multi-instance LED wall's footprint.
4. **Passthrough (unit):** importing an MVR with unknown nodes, moving one fixture and re-exporting keeps the unknown nodes and every UUID.
5. **Compatibility (unit + e2e):** v1, v2 and v3 shows open unchanged; a show without interchange data still saves as v1–v3.
6. **Desktop (Electron smoke suite):** open and export `.mvr` through File menu IPC offline, with no CSP violations (extends `tests/desktop/electron-smoke.spec.mjs`).
7. **Cross-tool (manual, documented):** BlenderDMX (free peer) plus grandMA3 onPC (free) — positions, orientation, patch; move a truss and re-address a fixture there, re-import, and check the delta merges by UUID without touching cues, takes or media.

Estimate: 4–6 weeks.

## Later milestones

- **Milestone 4 — Live DMX output (2–3 weeks).** A main-process (or utility-process) sender for sACN (multicast, priority, CID) and Art-Net 4 (ArtPoll discovery, unicast ArtDmx) over Node `dgram`, fed by renderer universe buffers through a sender-validated IPC channel, with explicit network-interface binding and the frame loop in main (immune to renderer throttling). Web Serial Enttec Pro output in the browser. Test peers: BlenderDMX, QLC+, grandMA3 onPC.
- **Milestone 5 — Show control and tempo (3–4 weeks).** OSC in main (node-osc ≥ 11.2.0) with an OSC-over-WebSocket path for the browser (osc-js); Web MIDI MTC and MSC; Art-Net timecode; a single clock owner (master, chase external, or cue caller) to prevent double-firing; frame-rate metadata on takes; offline beat grid (web-audio-beat-detector) and live tempo (realtime-bpm-analyzer) with tap tempo, downbeat nudge and half/double time.
- **Milestone 6 — CAD and sync (on demand).** DXF import into the plan editor (owned reader or dxf-parser), block-aware DXF export, MVR-xchange (mDNS + TCP) for live rig sync with consoles, and optional lazy WASM importers (IFC venue shells, OpenUSD preview) behind `'wasm-unsafe-eval'` only when enabled.

## Risks

- Vendor MVR exports differ (placeholder GDTFs, missing textures, split scene vs fixtures in Unreal). Validate against BlenderDMX and Vectorworks first.
- A codec is a long-lived dependency; keep it a separate module with its own tests so it could become a package.
- Untrusted archives: cap sizes, reject DTDs and external entities, and fuzz the XML/ZIP layer.
