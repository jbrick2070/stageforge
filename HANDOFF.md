# StageForge handoff: next improvement passes

You are the implementing agent for StageForge. Work sprint by sprint from the backlog below. Every sprint runs this loop:

1. **Implement** one sprint, with tests.
2. **Pass the gate** (below).
3. **QA** with Claude CLI on Sonnet 5.5, in read-only mode (below).
4. **Verify and fix:** for each QA finding, check it against the code first. Fix the real ones, add a regression test for each, and write down why you rejected any false positive.
5. **Re-run the gate.** If you changed more than about 50 lines in step 4, run one more QA pass on just those fixes.
6. **Commit locally** with a descriptive message, then **report**. Include gate results, QA findings (fixed or rejected) and what's next. In an overnight run, append the report to the Overnight log at the bottom of this file, commit it, and let the runner start the next round.

**Never push.** A push to `main` deploys GitHub Pages; only the user approves that, every time.

## Overnight run (unattended, full Turbo)

The user is asleep. `scripts/overnight.ps1` runs you directly on `main`, with every tool allowed (all commands, builds, Playwright, Electron, Claude CLI, web), no sandbox and no approval pauses. Each round is one conversation: Sprint 0, 1, 2, 3, then self-directed rounds until morning. After your first turn the runner sends up to two short follow-up turns in the same conversation to check that the work is committed and the gate is green. Nobody can answer questions, so:

- **Keep busy, and pick your own work.** Do the full sprint without cutting features. When the backlog runs out, choose the next improvement yourself (see Self-directed rounds below) rather than stopping.
- **Decide and log.** Make reasonable calls yourself and record each decision, with its reason, in the Overnight log.
- **Use Opus 5.5 freely for design and code.** Ask Claude Opus 5.5 (design consult command below) before any sprint with real design choices (the v4 `interchange` block, the DMX sender and IPC architecture, clock ownership), when you're stuck, and when you want a second pair of eyes on tricky code or a tricky patch. Opus replies with advice and code; you decide, apply and test it. `%TEMP%\stageforge-overnight\opus-status.txt` says whether Opus 5.5 works on this machine; if not, use Sonnet 5.5 and log it.
- **Sonnet 5.5 QA on all code you change**, as the loop says.
- **Never commit failing code.** If the gate still fails after three fix rounds, stash the unfinished work, log what's failing, and move on. The runner also stashes anything left uncommitted at the end of a round.
- **Pushing is hard-blocked**, by a `pre-push` hook and a disabled `remote.origin.pushurl`. Antigravity's own `command(git push)` deny rule does not stop a push in this mode, so these git-level guards are what protect Pages. Never remove or bypass them (no `--no-verify`, no `git config` changes to `pushurl`, no pushing to a raw URL), and never rewrite history. The user reviews and pushes in the morning.
- **Tests stay on this machine.** DMX, OSC and MIDI tests send only to `127.0.0.1`.
- **Hardware steps:** anything needing hardware or a person (a cross-tool check, a real DMX node, a USB interface) becomes a checklist in the docs, not a blocker.
- **Leave the PC tidy:** after each gate, stop any Vite, preview or Electron processes you started.

## Self-directed rounds

After Sprint 3, each round works like this. **Work Realism backlog items 1 to 8 first, in order, one item per round (split item 1 across several rounds: catalogue data, then models and textures, then lasers), before anything else.** The user wants people to feel like they are running a real show, with a real inventory of real items. Do not start item 9 (VR) yet.

1. Write a design consult to `$qa\round-N-design.md`: what is already done (read the Overnight log and `git log` so nothing is repeated) and a request to rank the five highest-value next improvements.
2. Cover these areas:
   - usability on a phone via the GitHub Pages site (touch, small screens, load time);
   - correctness and edge cases;
   - performance;
   - accessibility;
   - realism of the stage design (real truss, fixture and rigging practice);
   - the open-standards roadmap, including the Sprint 4 items;
   - test gaps.
3. Send it to Opus 5.5, pick the top item worth doing, and implement it end to end with the loop.
4. Prefer improvements a user would notice. Keep changes small enough to review in the morning.

## Where things stand (2026-11-23)

- **Repo:** this folder. GitHub `jbrick2070/stageforge`, branch `main`, last pushed commit `78ec7af`, live on Pages.
- **Stack:**
  - Vite + React 19 + TypeScript + three.js, with an SVG stage plan.
  - Electron desktop app: sandboxed renderer, `stageforge://` protocol, strict CSP, preload `contextBridge` with a command whitelist in `desktop/preload.cjs`.
- **Show format:** versioned JSON v1–v3. Canonical schemas live in `src/schemas/` (emitted to `schemas/` at build/dev time so published URLs stay unchanged); see `docs/show-format.md`.
- **Shipped:**
  - Studio, stage plan and cue timeline.
  - GLB and DXF export, and show bundles (.zip).
  - Milestone 2: walls, hangs and layout authoring on the plan, plus a desktop smoke suite.
  - Milestone 3: MVR 1.6 + GDTF 1.2 exchange in `src/interchange/mvr/`; see `docs/mvr-exchange.md`.
- **Godot is retired.** It is preserved at tag `native-v0.1.0`. three.js is the only 3D engine, so don't add another.
- **Plan of record:** `docs/open-standards-roadmap.md`. Read it before Sprint 1.

## Non-negotiables

- **Compatibility:** v1, v2 and v3 show files must keep loading unchanged. Format changes are additive (a v4 file is written only when its new block exists).
- **Licences:** MIT, ISC, BSD or Apache-2.0 only. No GPL, LGPL, AGPL or noncommercial code. The roadmap's "Do not bundle" list is binding.
- **Dependencies:**
  - Pin exact versions.
  - `npm run desktop:prepare` regenerates `THIRD_PARTY_NOTICES.txt`; check it lists any new package.
- **Coordinates:**
  - StageForge is Y up, metres, with +Z toward the audience. Yaw is about +Y, with front = (sin yaw, cos yaw).
  - MVR is Z up, millimetres: SF (x, y, z) → MVR (1000x, −1000z, 1000y).
- **Placement:**
  - Fixture placement has one source of truth: `src/data/fixturePlacement.ts` (`placeFixtures`, `mountSlotIndex`).
  - The renderer, DXF export and MVR export all use it, so don't fork the formula.
- **Untrusted input:**
  - Treat every opened file (show JSON, zip, MVR, GDTF, DXF, audio) as hostile.
  - Use size caps and no DTDs.
  - Every failure should be a readable `Error`, never a stray TypeError.
- **Desktop security:**
  - Keep the sandbox and CSP.
  - New IPC goes through the preload whitelist, and main validates every argument and the sender.
- **Clean tree:** no temp files, logs or build output in commits. `desktop/build/`, `dist/` and `test-results/` are ignored.
- **No unilateral changes:** don't change permission settings, CI workflows or the Pages deploy unless the user asks.

## The gate (all must pass)

Run each command on its own:

```powershell
npx tsc --noEmit -p .
```

```powershell
npm test
```

```powershell
npm run build
```

```powershell
npm run desktop:win
```

```powershell
npm run test:desktop
```

```powershell
npx playwright test --workers=1
```

```powershell
git status --short
```

What each one covers:

- `npx tsc --noEmit -p .`: the type check.
- `npm test`: node:test unit tests, run through Vite `ssrLoadModule`.
- `npm run build`: the production web build.
- `npm run desktop:win`: runs `desktop:prepare`, then builds the portable Windows exe.
- `npm run test:desktop`: the Electron smoke suite.
- `npx playwright test --workers=1`: the browser suite, about 5 minutes. If a test fails under load, rerun that test on its own before calling it a regression.
- `git status --short`: should show only the files you intend to commit.

Baseline at `78ec7af`: 88 unit, 6 desktop and 39 browser tests, all green.

## QA with Claude CLI (Sonnet 5.5, read-only)

Write the QA prompt to a temp file, then pipe it into Claude CLI. Only the listed Bash commands are allowed, so the reviewer can't edit, commit or push.

```powershell
$qa = Join-Path $env:TEMP 'stageforge-qa'; New-Item -ItemType Directory -Force $qa | Out-Null
Get-Content "$qa\sprint-N-prompt.md" -Raw | claude -p --model claude-sonnet-5-5 --allowedTools "Bash(git diff:*)" "Bash(git status:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(npx tsc:*)" "Bash(node --test:*)" | Out-File -Encoding utf8 "$qa\sprint-N-qa.md"
```

Use the explicit model ID `claude-sonnet-5-5`, not `sonnet`: on Claude Code 2.1.261 the `sonnet` alias still resolves to Sonnet 5. That version also prints an "isn't described by this version's model catalog" warning for the explicit ID, but the review runs on Sonnet 5.5 anyway. Running `claude update` clears the warning.

QA prompt template (fill in the brackets):

```text
You are reviewing uncommitted changes in StageForge (this repo) for sprint [N]: [one-line goal].
READ ONLY: do not edit files, commit, push, or run Playwright/Electron.
You may run `npx tsc --noEmit -p .`, `node --test tests/<file>.test.mjs`, and git diff/status/log/show.
Read HANDOFF.md "Non-negotiables" first.
Changed files: see `git status` and `git diff`.
Focus: [the risky parts: maths, parsing, IPC, compatibility, performance].
Report: Critical / High / Medium / Low findings. Each needs file:line, a concrete failure scenario
(input → wrong result), and a suggested fix. Then list missing tests. Skip style nits.
Confirm explicitly: v1–v3 shows still load, no new non-permissive licences,
no new IPC without validation, no stray files.
```

### Design consult (Claude Opus 5.5, read-only)

Write the question to `$qa\sprint-N-design.md` (the same temp folder as QA). Include:

- the goal;
- the constraints from Non-negotiables;
- the files involved;
- the two or three options you see.

Then run:

```powershell
Get-Content "$qa\sprint-N-design.md" -Raw | claude -p --model claude-opus-5-5 --allowedTools "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" | Out-File -Encoding utf8 "$qa\sprint-N-design-reply.md"
```

Opus 5.5 needs Claude Code 2.1.280 or newer. If the call fails with a version error, rerun the same command with `--model claude-sonnet-5-5` and say so in the Overnight log.

## Backlog (in this order)

### Sprint 0: whole-codebase QA sweep

Run the QA prompt once per area so each run stays focused:

- `src/engine/`
- `src/data/`
- `src/components/` + `src/App.tsx`
- `src/interchange/`
- `desktop/`
- `tests/`, which gets a coverage-gaps review

Swap "uncommitted changes" for "all code in [area]".

Then triage everything into one ranked list:

- Fix all Critical and High findings, each with a test.
- Fix Medium findings that are cheap.
- File the rest as notes at the bottom of this file.

Known item: Vite warns "Assets in public directory cannot be imported from JavaScript" for `public/schemas/show-v*.schema.json` during dev and tests. Resolve it cleanly, without moving the published schema URLs.

### Sprint 1: finish Milestone 3

See the roadmap, Milestone 3, steps 4 and 6 and acceptance tests 3–4:

- **Show v4 `interchange` block (additive):**
  - persisted MVR UUIDs per StageForge object;
  - bounded passthrough of unrecognised MVR XML, so re-export keeps other tools' data.
  - v1–v3 files still save as v1–v3 when the block is absent.
  - Update `docs/show-format.md` and add `src/schemas/show-v4.schema.json` (and register it in `vite.config.ts` `SHOW_SCHEMAS`).
- **Edge-case tests:** CIE xyY colours, DMX break 0 vs 1, a multi-instance LED wall's footprint.
- **Passthrough test:** import an MVR with unknown nodes, move one fixture, re-export, and check the unknown nodes and every UUID survive.
- **Cross-tool check (needs the user):** write a step-by-step checklist in `docs/mvr-exchange.md` for BlenderDMX and grandMA3 onPC, for the user to run.

### Sprint 2: Milestone 4, live DMX output

- **Electron main:** sACN (E1.31) and Art-Net 4 senders over Node `dgram`.
  - Use `sacn` (Apache-2.0) and `dmxnet` (MIT), or a small owned sender if smaller.
  - The frame loop lives in main, and output binds to an explicit network interface.
- **Renderer to main:** universe buffers go through one validated IPC channel. Check the sender, buffer length and universe range.
- **Safety:**
  - Output is off by default.
  - Blackout when output is disabled, on quit and on renderer crash.
  - Rate cap of 44 Hz.
  - A visible "LIVE" indicator.
- **Browser:** Web Serial Enttec DMX USB Pro output. In Electron, handle `select-serial-port` and grant `serial`.
- **Tests:**
  - unit tests for packet encoding against spec byte layouts (E1.31 root, framing and DMP layers; ArtDmx);
  - a loopback UDP test in Node;
  - a desktop smoke test that output stays off until enabled.

### Sprint 3: Milestone 5, show control and tempo

- OSC in main (`node-osc` ≥ 11.2.0), and OSC over WebSocket in the browser (`osc-js`).
- Web MIDI MTC and MSC, and Art-Net timecode.
- One clock owner (master, chase external, or cue caller) so cues never double-fire.
- An offline beat grid (`web-audio-beat-detector`) and live tempo (`realtime-bpm-analyzer` ≥ 5.0.0), with tap tempo, downbeat nudge and half/double time.

### Sprint 4: Milestone 6, CAD and sync

Only if the user asks:

- DXF import into the plan editor, with a small owned reader for LINE, LWPOLYLINE and INSERT;
- block-aware DXF export;
- MVR-xchange (mDNS + TCP).

## Realism backlog (priority for self-directed rounds)

Goal: people should feel like they are running a real rig, with real equipment, real limits and real paperwork. Ask Opus 5.5 to design each item before you build it.

**How to source it, for every item below:**
- Use real manufacturers' published datasheets for numbers: weight, power draw, beam angle, lumens, DMX modes and channel counts, throw, IP rating.
- Open Fixture Library data is MIT; keep its copyright notice.
- Do not copy datasheet text, photos or logos.
- Use model names only to identify the product.
- Don't bundle manufacturer GDTF files unless their licence allows it.
- Cite each source in `docs/equipment.md` and mark any value you could not verify as `unverified`.

1. **Real equipment catalogue.** Replace generic fixtures with a catalogue of real, well-known models across categories: spot, beam, wash and profile moving heads, LED PARs and battens, strobes, blinders, followspots, LED screens and panels, hazers and foggers, CO2 jets. Each entry carries manufacturer, model, weight, power, optics and its real DMX modes. Keep the existing generic fixtures working so v1–v3 shows still load, and map old types to catalogue defaults.

   **Models and textures for every catalogue item.** Each entry gets a real-looking 3D model and materials, so a rig looks like real gear:
   - correct proportions and details (yoke and head, lens, fins, handles, clamps, rigging points, connectors, LED panel grids, speaker grilles);
   - finished materials (anodised and painted metal, black powder-coat, rubber, glass lenses) with PBR textures where they help.
   - Build models procedurally in three.js or use glTF assets that are CC0 or otherwise permissively licensed.
   - Textures must be CC0 (for example ambientCG or Poly Haven) or generated in code. Record every asset's source and licence in `docs/assets.md`, and check CC-BY attribution rules before using anything that isn't CC0.
   - Stay light for the web and phones: compressed textures (KTX2 or WebP), shared materials, instancing for repeated gear, lazy loading, and a size budget noted in the docs.
   - Show the same models in the 3D view, the plan symbols, GLB export and the inventory panel.
2. **Real laser modules.** Add real laser products across power classes, with:
   - colour (single, RGB), power in watts, scan speed in kpps, and beam and graphic modes;
   - the common DMX laser modes;
   - ILDA basics: a safe, size-capped reader for `.ild` frame files so people can load real laser shows;
   - IEC 60825 and audience-scanning safety: a clear indicator when a laser aims at the audience, a minimum height over heads, and a beam-scan-off warning, shown as design guidance.
3. **Equipment inventory and rental list.** An inventory panel for the show: counts by model, total weight, total power draw, universes and channels used, and a printable and CSV equipment list. Optionally limit the rig to what a "shop" has in stock, so people hit real quantity limits.
4. **Rigging and power realism.** Real truss sections and sizes, chain-motor ratings, and per-point load with a clear over-limit warning (a simplified static check, labelled as guidance and not engineering sign-off). Dimmer and circuit groups, three-phase load balance, and a total power report.
5. **Show paperwork.** Patch sheet, instrument schedule, channel hookup, power and load reports, and a cue sheet, as printable pages and CSV. Keep exports consistent with MVR and DXF.
6. **Console feel.** A small, familiar cue-list and playback view with cue numbers, fade times and go and back controls, in the style of real consoles.
7. **Fixture behaviour polish.** Pan and tilt speed limits, zoom and focus feel, colour mixing and dimmer curves, and gobo and prism looks, tuned to each catalogue entry's real specs where known.

8. **Haze, smoke and laser rendering realism (GPU).** Audit finding on 2026-11-23: it all runs on the real GPU through three.js (WebGL) with an UnrealBloom pass, but it is approximated:
   - Beams are additive analytic cone shaders (`src/engine/shaders.ts`) driven by a shared haze noise. The haze is not a lit volume, so beams do not light smoke where they cross it, and nothing occludes a beam.
   - Smoke and CO2 are CPU-simulated billboard puffs with a baked noise sprite (`src/engine/ParticleSystem.ts`), not a fluid or a lit volume.
   - Lasers are procedural fragment-shader sheets and cones (`laserGeometry.ts`, `LASER_*` shaders), not point-scanned ILDA frames.

   Improve, in this order, measuring frame time as you go:
   - **Lit haze:** a cheap volumetric haze (for example a low-resolution froxel or ray-marched density field) that beams visibly light with a Henyey-Greenstein phase, brighter where beams cross and along their axis.
   - **Smoke:** buoyancy, dissipation, wind and fan response. CO2 jets are a cold white plume that falls fast.
   - **Beam occlusion:** soft depth clipping against trusses, screens and decks.
   - **Lasers:** a point-based scan model with kpps limits, corner brightening, blanking, beam divergence and scatter in haze, fed by `.ild` frames from item 2.
   - **GPU tiers:** an auto-quality setting (pixel ratio, ray steps, particle counts) so it stays smooth on a phone. Keep WebGL; a WebGPU path is optional and flagged off.
9. **LATER, do not start tonight: Quest VR audience mode (WebXR).** The user wants real equipment, inventory and textures first; VR comes after items 1–8. Let people stand in the audience with a Meta Quest.
   - **Approach:** use three.js's built-in WebXR support (MIT), feature-detected, so desktop and phones are unaffected. The GitHub Pages site is HTTPS, so it works in Quest Browser with no install.
   - **Entry:** an "Enter VR" button, shown only when `immersive-vr` is supported.
   - **Rendering:** the Quest is a mobile GPU, so the VR path skips the EffectComposer bloom (use cheap emissive and additive glow instead), enables fixed foveation, and caps haze, particle and laser quality through the item 8 tiers. Aim for a steady 72 fps.
   - **Viewpoints:** teleport to audience seats (floor, mezzanine, balcony, FOH) with correct eye height and scale, plus smooth-turn and comfort options (vignette, snap turn). Reuse the FOH framing in `src/engine/fohFraming.ts`.
   - **Interaction:** controller pointer to trigger cues, change haze, and open a small wrist menu. Hand tracking is optional.
   - **Testing:** use the Immersive Web Emulator or Meta XR Simulator in Playwright where possible, since no headset is available overnight. Write the on-headset checks as a checklist in `docs/vr.md` for the user.
   - **Safety:** show a laser-safety note, and never auto-start flashing strobes on entry (photosensitivity warning first).

Keep each item shippable on its own, with tests, docs and a short note in the Overnight log.

## Kickoff

**Overnight**, unattended, from this folder (Sprints 0–3, then self-directed rounds for 10 hours; add `-Hours 0` for no deadline):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\overnight.ps1
```

Stop early by creating `%TEMP%\stageforge-overnight\STOP`; the current round finishes first. If its window is closed mid-run, run `scripts\unguard-push.ps1` to remove the push guards.

**One sprint**, interactively:

```powershell
agy -i "Read HANDOFF.md and run Sprint 0, following its loop. Stop after the local commit and report." --mode accept-edits
```

## Overnight log

(Each sprint appends: date and time, sprint, what shipped, gate results, QA findings fixed or rejected, design decisions and their reasons, leftovers.)

### 2026-11-24 00:09 PST — Sprint 0: whole-codebase QA sweep (`4b2ddce`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted on schema packaging, live telemetry store, desktop protocol extraction/single-instance lock, and exact dependency pinning.
  - 6 area-focused read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA sweeps: `src/engine/` + `src/audio/`, `src/data/` + `src/types/`, `src/components/` + `src/App.tsx` + `src/input/`, `src/interchange/`, `desktop/`, and `tests/` (coverage gaps).
  - Final read-only Sonnet 5.5 QA pass on all uncommitted Sprint 0 changes, followed by verification, targeted fixes, and regression tests.
- **What shipped:**
  - **Schemas & Vite warning resolved:** Moved canonical schemas from `public/schemas/` to `src/schemas/show-v{1,2,3}.schema.json`; added `showSchemas()` Vite plugin in `vite.config.ts` (anchored to `${server.config.base}schemas/` in dev and emitting `schemas/show-v*.schema.json` into `dist/` and `desktop/build/app/renderer/`). Zero Vite public-directory warnings; published URLs unchanged; updated GitHub links in `README.md` and `docs/show-format.md`.
  - **Exact dependency pins:** Pinned all `dependencies` and `devDependencies` in `package.json` to lockfile-resolved exact versions, synced `package-lock.json` (root specs only, zero upgrades), added `.npmrc` (`save-exact=true`), and added a unit test guard.
  - **MVR/GDTF/XML/ZIP/GLB/bundle hardening:**
    - `xml.ts`: O(N) BOM + trailing-NUL stripping before size check (fixes quadratic regex hang), XML depth cap (64) & element count cap (500,000), readable error wrapping, XML-1.0 illegal control-char stripping in `buildXml`.
    - `archive.ts` & `showBundle.ts`: STORE size-mismatch check (`compression === 0 && size !== originalSize`), cumulative compressed-size <= archive-length check (blocks overlapping STORE zip bombs), readable `Error` wrapping (never raw `RangeError`), optional `only`/`maxInflated` filter in `readArchive`.
    - `gdtf.ts` & `importMvr.ts`: `readGdtf` only inflates `description.xml`, bounded `Offset` loop (no stack-overflow spread, cap 512), depth-capped geometry walk, 64 distinct GDTF / 128 MiB nested inflate caps, improved `classifyGdtf` (static RGB pars with `Shutter1Strobe` no longer misclassified as `strobe`), readable missing-`verMajor` error, fallback note on corrupt embedded StageForge payload.
    - `glb.ts`: Strict header/chunk bounds and 3-element finite array checks for `accessor.min`/`max` (no stray `TypeError`).
    - `coords.ts`: `standing = w.z / |w| < -1e-6` (ignores `-6e-17` horizontal-boom noise while preserving tilted standing fixtures), vertical-`u` yaw fallback, corrected basis comment (`+90°` about X).
    - `gdtfOptics.ts`: BOM/NUL strip, case-insensitive `description.xml`, STORE checks, `<!(DOCTYPE|ENTITY)` check, 256-profile cap, preserved error messages.
  - **Data & DMX hardening:** 32 MiB JSON caps and UTF-8 BOM stripping in `showFile.ts`, `rigImport.ts`, `App.tsx`, `RigBuilderDrawer.tsx`; `rigImport.ts` schema-parity bounds (coordinates `±10000`, dimensions `<= 1000`, `trussPods <= 256`, `props <= 256`, pre-spread string length checks, `__proto__|prototype|constructor` ID ban, keeping legacy finite `rotationY`); `dmxPatch.ts` rejects mismatched-type extends and `count <= 0`; `showClock.ts` guards `NaN`/`Infinity` seeks; `studioGeometry.ts` caps wall-cue timestamps at 24 h (`MAX_WALL_CUE_MS`) and guards `NaN` geometry inputs; `fixturePlacement.ts` exports shared `hungUnits()` and `floorUnitX()`.
  - **3D engine & shaders:** `StageEngine.ts` uses `hungUnits`/`floorUnitX` (true single source of truth), wraps constructor in try/catch with safe partial-instance `dispose()` (`this.mats ?? {}`) and `renderer.forceContextLoss()`, guards motor/pan/tilt lerps against `NaN`; `fohFraming.ts` + `stageGlb.ts` + `StageEngine.ts` share `LED_DISPLAY_MATERIAL_NAME` so secondary LED screens are framed in authored FOH; `shaders.ts` guards `cross(dFdx, dFdy)` and view-vector normalizations against zero-length `NaN`.
  - **Desktop security & notices:** Extracted pure `desktop/protocol.cjs` (`isAppPage` rejects ports; `createRendererHandler` sets `Content-Security-Policy` + `X-Content-Type-Options: nosniff` on every response, closing the Windows case-insensitive `INDEX.HTML` CSP bypass); `desktop/main.cjs` uses `open()` + `stat().isFile()`, 32 MiB text / 512 MiB binary caps, zero-copy `Uint8Array` view, BOM strip, `requestSingleInstanceLock()`, `webviewTag: false`, audio-only `mediaType` check in permission check handler, cancels invalid downloads and alerts on `interrupted`; `desktop/preload.cjs` isolates throwing listeners; `desktop/prepare.mjs` copies `protocol.cjs`, resolves nested `node_modules`, skips `licenses/` dirs, sorts ASCII-deterministically, and enforces fail-closed SPDX permissive licence validation (`MIT`, `ISC`, `BSD-2/3-Clause`, `0BSD`, `Apache-2.0`).
  - **React architecture & UI fixes:** Added `ErrorBoundary` (`src/main.tsx` + drawers/designer in `App.tsx`), `createLiveStore`/`useLive` (`src/state/liveTelemetry.ts`) decoupling 20 Hz FPS/audio/DMX HUD telemetry from `App` re-renders, atomic `openDocument`, monotonic `openRequestRef` + `designerOpenRef` race guards (with toast), hotkey `<select>`/`[role=listbox]`/`[role=combobox]` guard, wall-only ghost-take clearing on rig/MVR open, extension fallback in `onUploadScreen`, `StageDesigner` `Field` float-noise dirty-check and rejection resync, `ShowFiles` mounted-ref StrictMode fix + relink try/catch, `SecondaryScreenCues` 24 h cap, `DmxMonitorDrawer` closed short-circuit and `address >= 1` guard, `TopBar` finite `trackDuration` guard and live music/duration getters, `aria-live`/`role="alert"` on toast & blackout banner.
  - **Tests (+24 unit tests, 88 → 112):** Added `tests/desktop-security.test.mjs`, `tests/dmx-patch.test.mjs`, `tests/sprint0-regressions.test.mjs`, frozen `tests/fixtures/legacy-v1.stageforge.show.json` & `legacy-v2.stageforge.show.json`, SHA-256 schema hash pins, strict `isReadableError` assertions in `show-file.test.mjs`, expanded `mvr-core`, `mvr-interchange`, `show-bundle`, `stage-dxf`, and `electron-smoke.spec.mjs`.
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**112/112**)
  - `npm run build`: PASS (`dist/schemas/show-v{1,2,3}.schema.json` emitted; 0 public-dir warnings)
  - `npm run desktop:win`: PASS (portable exe built; `THIRD_PARTY_NOTICES.txt` passed SPDX gate)
  - `npm run test:desktop`: PASS (**6/6**, 2.7 s)
  - `npx playwright test --workers=1`: PASS (**39/39**, 5.3 m)
  - `git status --short`: clean
- **QA findings verified and fixed (post-implementation pass):**
  - Fixed High #1: `StageEngine.releaseGroup` crashed with `TypeError` on `Object.values(this.mats)` when `dispose()` ran from constructor catch before `this.mats` was assigned; fixed with `this.mats ?? {}` + guarded catch + regression test.
  - Fixed Medium #2: `rigImport.ts` `[...value].length` allocated huge array before length check; added `value.length <= max * 2` fast-fail + 10 MB name regression test.
  - Fixed Medium #3: `coords.ts` `standing` threshold `-0.5` misclassified floor fixtures tilted > 60°; tightened to `-1e-6` + tilted-standing regression test.
  - Fixed Low #5, #6, #11, #12: restored `rotationY: number` for v1 schema compatibility, added toast on designer-blocked async open, updated `HANDOFF.md` schema paths, extracted `LED_DISPLAY_MATERIAL_NAME`.
- **QA findings rejected (with reasons):**
  - *Components sweep H1 (`window.confirm` on `openFile`/`openExample`)* & *M3 (`window.confirm` on `StageDesigner` Cancel)*: rejected after checking existing e2e and desktop smoke contracts (`electron-smoke.spec.mjs:159` fails on unexpected dialogs; `stage-plan-authoring.spec.mjs:41-58` explicitly asserts Cancel closes immediately).
  - *Data M2 `trussPods <= 64` in `rigImport.ts`*: set to `256` instead of `64` to stay consistent with `importMvr.ts`'s `MAX_IMPORTED_TRUSSES = 256` (asserted in `mvr-interchange.test.mjs:303`); still bounds fixture-less pod DoS.
  - *Post-change QA Medium #4 (XML depth 64 / 500k elements)*: kept as-is; well above real MVR/GDTF hierarchy depth (~3–8) and element counts.
- **Design decisions:**
  - Chose `src/schemas/` + `vite.config.ts` `showSchemas()` plugin over duplicated `public/schemas/` copies so there is a single source of truth that works with `configFile: false` unit tests and emits identical `/schemas/` assets on build and dev (per Opus 5.5 consult).
  - Chose `createLiveStore` + `useSyncExternalStore` over `React.memo` for 20 Hz HUD telemetry to avoid `useCallback` churn and stale-closure risk; passed live getters to `TopBar` for track seek position.
  - Extracted `desktop/protocol.cjs` without Electron imports so protocol/CSP security tests run fast in Node without fragile mocks.
- **Leftovers / deferred notes (low-priority or larger scope for future rounds):**
  - *MVR/GDTF:* `importMvr` GDTF footprint-aware simulated overlap check (M4), preserving foreign fixture positions/yaw as an explicit flag (M7), GLB node TRS scene-graph traversal in `glbBounds` (M8), XSD validation in CI.
  - *Data/Bundle:* streaming or lower in-memory peak for 512 MiB bundles (Data M3), `portableMedia` scheme allowlist for filenames containing colons (Data L5), DXF XDATA non-ASCII `\U+` handling (Data L6), floor-group spread clamping on repeated extend (Data L7), `fixtureOptics` gain cap & empty `{}` handling (Data L9), cross-pod duplicate group ID check (Data L10), `openDocument` passing pre-parsed object to avoid double `JSON.parse` on large files.
  - *Engine/Audio:* hoist per-frame `THREE.Color`/`Vector3` allocations in `StageEngine.updateScene` (Engine L1), `BeamPools` `max(r(start), r(end))` bounds (Engine L2), `dmx8()` clamp helper (Engine L3), `AudioEngine` context-creation ordering and error normalization (Engine L4), `WallPlayer` `crossOrigin` (Engine L5), GLB export `visible`/instance-color fidelity (Engine L6), reduced-flash/photosensitivity option (Engine L7), deterministic RNG for scuffs/particles (Engine L8), `devicePixelRatio` update on resize (Engine L9).
  - *Desktop:* Electron fuses in `builder.cjs` (`runAsNode: false`, etc., Desktop L1), `render-process-gone` / `unresponsive` recovery handler (Desktop L4), `will-frame-navigate`/`will-redirect` (Desktop L5), Range-request header forwarding on `stageforge://` for `<video>` seeking (Desktop L7).
  - *Components/Tests:* same-name media asset collision warning (Components M7), `StageDesigner` frame-stable pan & pointer-capture loss recovery (Components L2–L4), `useShowGamepad` checkbox/radio focus exclusion (Components L6), component/hook unit tests (`useShowTimeline`, `useWallClock`, `AudioEngine`, `ErrorBoundary` React render, `will-download`/`readBoundedFile` main tests), replacing fixed sleeps in e2e specs with `expect.poll`.
  - *Next up:* Sprint 1 (Milestone 3 completion: show v4 additive `interchange` block, edge-case tests, passthrough test, cross-tool checklist).
