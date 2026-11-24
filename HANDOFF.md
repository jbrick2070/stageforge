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

### Fixed: schema hash pins (found by the morning review on 2026-11-24, fixed in `23b9917`)

*Done:* the pins now hash LF-normalised text, a CRLF copy is checked to give the same digest, and `.gitattributes` keeps schemas and fixtures LF. The original note is kept below for the record.

**CI would fail on GitHub.** The Pages workflow runs `npm test` on a Linux (LF) checkout before it builds and deploys. `tests/show-file.test.mjs` pins SHA-256 hashes of the schema files, but the show-v1 to v3 pins were computed on this Windows machine's CRLF bytes, while the v4 to v6 pins are LF hashes. Verified: on an LF copy of `5cca549`, 176 of 177 unit tests pass and only the `show-v1.schema.json hash pin` assertion fails. Pushing as is would stop the deploy.

Fix this before any other work, with a Sonnet 5.5 QA pass and the full gate:

- Normalise CRLF to LF before hashing in that test, and re-pin all six hashes to the LF (git blob) hashes.
- Add a `.gitattributes` with `src/schemas/*.json text eol=lf` and `tests/fixtures/*.json text eol=lf`, so a Windows checkout hashes the same as Linux.
- Look for any other byte-exact pins, fixtures or snapshots with the same line-ending dependence.
- Add a regression test that hashes a CRLF copy of a schema and expects the pinned value.
- Re-check by running `npm test` on an LF export: `git -c core.autocrlf=false archive HEAD`, extracted to a temp folder with `node_modules` linked in.

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

### 2026-11-24 00:58 PST — Sprint 1: finish Milestone 3 (`b4d799b`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted on Show v4 `interchange` schema/bounds, XMLBuilder passthrough & XSD ordering, synthetic position bars, `restore()` UUID unification, GDTF `GeometryReference` + `<Break>` footprints, CIE xyY math, and `App.tsx` lifecycle.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Sprint 1 changes (2 High, 7 Medium, 5 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the step-4 fixes (0 Critical/High, 2 Medium, 2 Low), all four fixed with regression tests.
- **What shipped:**
  - **Show v4 `interchange` block (additive):**
    - Added canonical `src/schemas/show-v4.schema.json` (SHA-256 pinned in `tests/show-file.test.mjs`, registered in `vite.config.ts` `SHOW_SCHEMAS`, checked in `tests/desktop/electron-smoke.spec.mjs`). `stage` is optional and `interchange` is required in v4; `rig.trussPods.maxItems` raised to 256 in v4 to match `MAX_IMPORTED_TRUSSES`.
    - Updated `src/data/showFile.ts` with `ShowInterchange`/`MvrInterchange`/`MvrPassthrough`/`MvrFixtureSpec`, `normalizeInterchange` (strips empty containers so v1–v3 stay emitted whenever `interchange` has no data), `parseInterchange`, and cheap quote-aware `checkInterchange` (8 MiB UTF-8 total passthrough cap, DTD/PI/control-char/provider-spoof rejection, no `fast-xml-parser` pulled into the main bundle).
    - v1–v3 schemas and fixtures remain byte-for-byte untouched and pinned.
  - **MVR UUID persistence & XML passthrough:**
    - `src/interchange/mvr/xml.ts`: added `buildXmlFragment`, configurable `ParseXmlLimits`, widened `LISTS` for MVR/GDTF repeating elements.
    - `src/interchange/mvr/exportMvr.ts`: added `resolveUuid`, `exportMvrDocument` (keeping `exportMvr` backwards-compatible), deterministic UUID persistence, synthetic position-bar skipping (`mvr.synthetic`), strict MVR 1.6 `FIXTURE_XSD_ORDER` sequencing for preserved `objectExtras`, `UserData`/`AUXData`/`sceneNodes` passthrough re-embedding, deterministic remapping of colliding passthrough UUIDs (preserving nested `GroupObject` subtrees), content-aware resource collision renaming (including `Symdef/ChildList/Geometry3D` and reserved StageForge generic GDTF names), generic fallback GDTF bundling for dangling passthrough `Fixture` refs, and `interchange` embedded in `MvrPayload`.
    - `src/interchange/mvr/importMvr.ts`: added `readAddresses` (0-based MVR break → 1-based GDTF `DMXBreak`, sorted & deduped, capped at 64), canonical UUID capture (`uuids`), `synthetic` pod tracking + 256-pod cap with passthrough overflow, `fixtureSpecs`, `objectExtras` capture, intact unimported `GroupObject` & invalid-matrix subtree passthrough, 128 MiB asset-filtered in-session resource cache, and unified `resolveUuid` matching in `restore()`.
    - `src/App.tsx`: added `interchangeRef` and `mvrResourcesRef` lifecycle (populated on MVR import/export and v4 show open; cleared on v1–v3 show open, raw rig JSON, preset/blank rig replace), toast surfacing of export notes, and non-destructive merge of emitted UUIDs with existing passthrough.
  - **CIE xyY, DMX break 0 vs 1, multi-instance GDTF & reversed physical ranges:**
    - Added `src/interchange/mvr/color.ts` (`parseCieXyY`, `cieXyYToSrgb` with equal-luminance hue-preserving gamut desaturation, `srgbToCieXyY`, `formatCieXyY`).
    - Upgraded `src/interchange/mvr/gdtf.ts`: `GeometryReference` + `<Break>` resolution (flat, multi-break, and 2D nested arrays with cycle detection, cached per root geometry, backtracking `ancestors`, O(1)/O(log k) per-instance offset math, shared `opsRemaining` budget), per-break footprints (`breaks`, `totalSlots`, `DMXBreak` 1..64 & `Overwrite`), `ChannelFunction` parsing with `parseGdtfDmxValue`, reversed `PhysicalFrom > PhysicalTo` preservation + `physicalAt`, virtual `Offset="None"` support, and CIE xyY emitter parsing.
  - **Docs & tests (+6 unit tests, 112 → 118; +v4/MVR round-trip assertions in e2e & desktop):**
    - Updated `docs/show-format.md` for v4 and expanded `docs/mvr-exchange.md` with passthrough semantics and a step-by-step manual cross-tool verification checklist for BlenderDMX and grandMA3 onPC.
    - Added unit tests for v4 schema/security, CIE xyY, DMX break 0 vs 1, multi-instance LED walls, reversed physical ranges, passthrough + move-one-fixture (both in-session and after v4 JSON reload), and all QA regressions; extended `tests/e2e/mvr-exchange.spec.mjs` and `tests/desktop/electron-smoke.spec.mjs`.
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**118/118**)
  - `npm run build`: PASS (`dist/schemas/show-v{1,2,3,4}.schema.json` emitted; `fast-xml-parser` stays lazy-loaded; 0 warnings)
  - `npm run desktop:win`: PASS (portable exe built; SPDX notice check green)
  - `npm run test:desktop`: PASS (**6/6**, 2.3 s)
  - `npx playwright test --workers=1`: PASS (**39/39**, 5.4 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1:* Cached `GeometryReference` resolution per root geometry, switched `ancestors` to in-place backtracking, lowered `MAX_GEOMETRY_REFS` to 4096, and shared `opsRemaining` across modes & GDTF files (+16-deep DAG × 64-mode timing regression test).
  - *Pass 1 H2:* Remapped colliding passthrough UUIDs instead of dropping `GroupObject`s, surfaced `exported.notes` in `App.tsx` toast, and preserved prior passthrough when updating `interchangeRef` (+regression test).
  - *Pass 1 M3:* Preserved `item.invalid` nodes intact in `restore()` instead of rewriting their matrices (+regression test for invalid-matrix `Support` and moved-`Support` reporting).
  - *Pass 1 M4:* Reported missing-resource fallback note for `fixtureSpecs` and bundled fallback generic GDTF for dangling passthrough `Fixture` refs (+regression test).
  - *Pass 1 M5:* Capped in-session `resources` cache in `importMvr.ts` at 128 MiB and filtered to MVR/GDTF asset extensions with a note on overflow.
  - *Pass 1 M6 (sub-risk):* Raised `mvrKey.maxLength` to 2048 in `show-v4.schema.json` so 256-char quote/backslash IDs escape and save cleanly (+regression test).
  - *Pass 1 M7:* Added content-aware non-colliding rename in `bundleResource` (and reserved StageForge generic GDTF names) so foreign files never clobber or get clobbered by generated files (+regression test).
  - *Pass 1 M8:* Replaced negative-channel clipping with equal-luminance hue-preserving gamut desaturation in `color.ts` (+regression test).
  - *Pass 1 L2 & L3:* Added all-invalid `<Break>` test and quote-aware `openingTagSlice` in `showFile.ts` rejecting `<Data x=">" provider="StageForge"/>` and unbalanced fragments (+regression tests).
  - *Pass 2 M1, M2, L1, L2:* Handled `Geometry3D` anywhere in passthrough trees (`Symdef/ChildList/Geometry3D`), made per-instance GDTF offset resolution O(1)/O(log k) via deduped sorted offsets, made remapped passthrough UUIDs deterministic per original UUID (independent of `usedUuids.size`), and reserved generic GDTF filenames in `bundleResource` (+`Symdef` bundling regression test).
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 M6 main claim (don't write v4 after MVR export on native shows):* Rejected — `docs/open-standards-roadmap.md` Milestone 3 step 4 explicitly requires UUIDs created on first export to be persisted in the v4 `interchange` block while shows without interchange keep saving as v1–v3.
  - *Pass 1 M1 (`prop:${i}` / `hang:${i}` index keys):* Deferred — `NativeStage` v3 schema props/hangs have no `id` field and v3 schemas are hash-pinned; documented in `docs/mvr-exchange.md`.
  - *Pass 1 M2 (`FixtureID`/`UnitNumber`/`CustomId` regeneration):* Deferred and documented in `docs/mvr-exchange.md`.
  - *Pass 1 L1 (GDTF multi-break/emitter/physical curves driving live desk simulation):* Out of scope for Sprint 1; deferred to future realism/fixture-behaviour work.
  - *Pass 1 L4 (interleaved sibling tag grouping & single-layer export) & L5 (CI XSD validator):* Accepted trade-off documented in `docs/mvr-exchange.md` / deferred to CI tooling.
- **Design decisions:**
  - Chose XMLBuilder-rebuilt fragment strings in `interchange.mvr.passthrough` over recursive JSON ASTs or raw XML diffs so JSON Schema stays flat (no unbounded recursion in `showFile.ts`) and `fast-xml-parser` stays lazy-loaded out of the main bundle (per Opus 5.5 consult).
  - Kept `exportMvr()` returning `Uint8Array` alongside new `exportMvrDocument()` returning `{ bytes, interchange, notes }` for full backwards compatibility.
  - Remapped colliding passthrough UUIDs deterministically rather than dropping whole `GroupObject` trees so third-party data is never silently lost.
- **Leftovers / next up:**
  - Manual cross-tool check with BlenderDMX and grandMA3 onPC (checklist in `docs/mvr-exchange.md`).
  - Next up: Sprint 2 (Milestone 4, live DMX output: sACN E1.31 + Art-Net 4 in Electron main, validated IPC, safety/blackout/44 Hz cap/LIVE indicator, Web Serial Enttec Pro in browser, unit/loopback/desktop tests).

### 2026-11-24 01:55 PST — Sprint 2: Milestone 4, live DMX output (`0cb0e73`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted on zero-dep main-process sACN/Art-Net codec vs npm packages, UDP interface/port binding (avoiding `SO_REUSEADDR` on Windows), IPC validation & blackout lifecycle, 44 Hz pacing, Electron Web Serial (`select-serial-port` + in-memory session grants), and UI/LIVE badge placement.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Sprint 2 changes (0 Critical, 2 High, 7 Medium, 10 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the step-4 fixes (0 Critical/High, 1 Medium, 5 Low), all six fixed with regression tests.
- **What shipped:**
  - **Zero-dependency sACN (ANSI E1.31-2018) & Art-Net 4 codecs and main-process sender (`desktop/dmx-packets.cjs`, `desktop/dmx-sender.cjs`):**
    - Spec-accurate E1.31 Data Packet encoder/decoder (638 bytes: Root, Framing, DMP layers, persistent install CID in `userData/dmx-cid.txt`, UTF-8 code-point-safe Source Name, priority 0–200, per-universe sequence 0..255, multicast `239.255.hi.lo:5568` + TTL + `setMulticastInterface`, and unicast targets).
    - Spec-accurate Art-Net 4 `ArtDmx` (530 bytes, OpCode `0x5000` LE, ProtVer 14 BE, 15-bit Port-Address Net/SubUni, sequence 1..255 never 0), `ArtPoll` (22 bytes), and defensive untrusted `ArtPollReply` parser (`>= 207` bytes, no ProtVer, bounded ports/strings, authoritative `rinfo.address`).
    - Explicit IPv4 interface binding from fresh `os.networkInterfaces()` scan, ephemeral send socket (`bind(0, iface)`), temporary exclusive-bind UDP `6454` discovery socket during scans (never `reuseAddr`, friendly `EADDRINUSE` guidance), deadline-scheduled main-process frame loop with hard `hrtime` `<= 44 Hz` (`22,727,273 ns`) ceiling, transient-error `degraded` state with auto-recovery after 10 consecutive successful sends, and guaranteed blackout sequence (3 paced zero ticks **before** 3 sACN `Stream_Terminated` `0x40` ticks, isolated to closing socket, 750 ms timeout).
  - **Validated Electron IPC & Web Serial security (`desktop/dmx-ipc.cjs`, `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/protocol.cjs`, `desktop/prepare.mjs`):**
    - Single fire-and-forget frame channel `stageforge:dmx-frame` validating `senderFrame === mainFrame`, `isAppPage(url)`, window ownership, active running state, `universe ∈ {1, 2}`, and exact `Uint8Array(512)`.
    - Strict tagged-union `stageforge:dmx-control` (`listInterfaces`, `getStatus`, `enable`, `disable`, `discover`) enforcing no unknown keys, window ownership, and post-bind sender liveness; main disables background throttling (`setBackgroundThrottling(false)`) only while live and restores it on stop.
    - Guaranteed blackout wired to `disable`, `render-process-gone`, `did-start-navigation`, `destroyed`, `closed`, `session-end`, `powerMonitor.suspend`/`shutdown`, and `before-quit` (with re-entry guard).
    - Electron Web Serial support: `setPermissionCheckHandler` (`serial` for app pages only), `select-serial-port` (native `dialog.showMessageBox` chooser with FTDI devices prioritized, capped at 8, never auto-selected), and `setDevicePermissionHandler` backed by an in-memory per-session grant set.
    - `desktop/prepare.mjs` copies `dmx-packets.cjs`, `dmx-sender.cjs`, and `dmx-ipc.cjs` (verified by a transitive `require` guard test); zero new npm dependencies added.
  - **Web Serial Enttec DMX USB Pro & renderer integration (`src/dmx/enttecPro.ts`, `src/dmx/liveDmx.ts`, `src/dmx/useLiveDmxOutput.ts`, `src/engine/StageEngine.ts`):**
    - Enttec Pro Label 6 framing (`7E 06 lenLo lenHi 00 [512] E7`, 518 bytes) and `EnttecProTransport` (`<= 44 Hz` backpressure-safe loop, blackout + abort + close timeouts on disable, `disconnect` handling, `pagehide` best-effort blackout).
    - `StageEngine.setDmxFrameListener` pushes changed universe buffers at `<= 44 Hz` only while live without waking React state.
    - Settings persist in `localStorage` without ever persisting `enabled` (always boots offline).
  - **UI & safety indicators (`src/components/DmxOutputSection.tsx`, `src/components/LiveDmxBadge.tsx`, `src/components/DmxMonitorDrawer.tsx`, `src/App.tsx`):**
    - Collapsible Output panel in `DmxMonitorDrawer` with two-step `Arm output` → `Go live`, protocol/interface/universe/rate/discovery controls, and USB Pro reload/crash hold-last-look warning.
    - Fixed top-right `<LiveDmxBadge>` at App root with pulsing LIVE indicator, measured Hz, degraded warning, and one-click `Blackout & stop` button; remains visible in Cinema mode (`H`).
  - **Docs & tests (+10 unit tests, 118 → 128; +1 desktop smoke test, 6 → 7):**
    - Added `docs/live-dmx.md` (architecture, safety model, universe numbering, and manual hardware/cross-tool checklist for BlenderDMX, QLC+, grandMA3 onPC, multicast NIC, and Enttec Pro).
    - Added `tests/dmx-output.test.mjs` (spec byte layouts, Enttec Pro codec/transport, sACN & Art-Net loopback UDP, ArtPoll loopback discovery, 44 Hz ceiling, and QA regressions), expanded `tests/desktop-security.test.mjs` (preload DMX whitelist, serial helpers, main IPC ownership/liveness tests, transitive packaging guard), and extended `tests/desktop/electron-smoke.spec.mjs` (verifies output stays off on boot, streams real sACN loopback on enable, keeps LIVE badge visible in cinema mode, and sends zero-then-terminate blackout on disable and `forcefullyCrashRenderer()`).
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**128/128**)
  - `npm run build`: PASS
  - `npm run desktop:win`: PASS (portable exe built; zero new runtime deps; SPDX check green)
  - `npm run test:desktop`: PASS (**7/7**, 7.1 s)
  - `npx playwright test --workers=1`: PASS (**39/39**, 5.3 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1 & H2:* Added `'starting'` state, `sessionGen` counter, pre-bind `ownerId` reservation, concurrent `enable` rejection, and post-bind sender liveness check in `desktop/dmx-ipc.cjs` + `desktop/dmx-sender.cjs` (+delayed-bind shutdown, concurrent enable, and destroyed-sender regression tests).
  - *Pass 1 M1:* Detached mutable globals on shutdown and bound blackout sending strictly to `closingSocket`/`closingConfig` with a timeout `cancelled` flag (+timed-out blackout isolation regression test).
  - *Pass 1 M2:* Enforced window ownership on `disable` and `enable` in `desktop/dmx-ipc.cjs` and guarded hook unmount cleanup in `useLiveDmxOutput.ts` (+multi-window ownership regression tests).
  - *Pass 1 M4:* Documented USB Pro reload/close hold-last-look behaviour in both `DmxOutputSection.tsx` and `docs/live-dmx.md`.
  - *Pass 1 M5 & L2:* Added `writer.abort()` fallback, `port.close()` 1 s timeout, and `finally { emit(); }` in `EnttecProTransport.disable()`, and removed 0.5 ms rate slack (+stalled write/close regression test).
  - *Pass 1 M6 & L3:* Preferred `rinfo.address` over self-reported IP in `parseArtPollReply`, rejected reserved/broadcast/cross-scope targets (`0/8`, `224/4`, `240/4`, `255.255.255.255`, interface broadcast, loopback mismatch) in `validateTargets` (+spoofed reply & bad-target regression tests).
  - *Pass 1 M7:* Switched scheduler wait to `Math.ceil` and rescheduled early wakes rather than dropping ticks (+real-timer 44 Hz loopback test).
  - *Pass 1 L1, L6, L8, L9, L10:* Cleared `degraded`/`lastError` after 10 consecutive good sends (+regression test), added `session-end` & `powerMonitor.shutdown` blackout hooks, removed dead `dmxForcePush` field in `StageEngine.ts`, defaulted loopback sACN mode to `unicast`, and suppressed idle `disable()` toast.
  - *Pass 2 M1, L2–L6:* Validated config before `shutdown('reconfigure')` so bad reconfigure never blacks out a live show (+regression test), respected `MIN_FRAME_INTERVAL_NS` before the first closing blackout tick, coalesced concurrent `discover()` calls, scoped `getStatus` `enabled` to the owning window (+regression test), added `mountedRef` guard after async awaits in `useLiveDmxOutput.ts`, and blocked `0.0.0.0/8` in `isReservedOrBroadcastIpv4` (+regression test).
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 M3 (renderer liveness watchdog auto-blackout on `unresponsive`):* Rejected — per Opus 5.5 design and real console convention, holding the last look during a brief renderer stall is intentional (static cues send zero frame diffs by design; actual crashes trigger immediate blackout via `render-process-gone`). Documented in `docs/live-dmx.md`.
  - *Pass 1 L4 (Windows weak-host out-of-subnet routing):* OS networking behaviour; documented in `docs/live-dmx.md`.
  - *Pass 1 L7 (hot-plug during native serial chooser dialog):* Accepted trade-off of native `dialog.showMessageBox`.
- **Design decisions:**
  - Wrote owned zero-dependency CJS codecs (`desktop/dmx-packets.cjs`, `desktop/dmx-sender.cjs`) instead of adding `sacn`/`dmxnet` so `desktop/build/app` keeps zero runtime `node_modules` (`beforeBuild: false`), zero licence bloat, and full spec-byte control (per Opus 5.5 consult).
  - Used a dedicated ephemeral send socket (`bind(0, iface)`) plus a scan-only exclusive-bind UDP `6454` discovery socket (never `SO_REUSEADDR`) so sending never collides with local QLC+/BlenderDMX instances.
  - Gated test-only UDP destination port overrides (`STAGEFORGE_DMX_TEST_PORT`) strictly on `!app.isPackaged` so production builds never honour them.
- **Leftovers / next up:**
  - Manual hardware & cross-tool checks (BlenderDMX, QLC+, grandMA3 onPC, multicast Ethernet NIC, Enttec DMX USB Pro, minimized background rAF on Windows/macOS) documented in `docs/live-dmx.md`.
  - Next up: Sprint 3 (Milestone 5, show control and tempo: OSC in main + WebSocket OSC in browser, Web MIDI MTC/MSC, Art-Net timecode, single clock owner, offline beat grid + live tempo with tap/nudge/half-double).

### 2026-11-24 03:11 PST — Sprint 3: Milestone 5, show control and tempo (`5c1c60a`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted on zero-dep main/browser OSC 1.0 codec parity vs npm packages, Electron CSP preservation (`connect-src 'self' blob:` vs `realtime-bpm-analyzer/processor?url` under `script-src 'self'`), shared UDP 6454 Art-Net RX multiplexer, single Clock Owner truth table & ChaseEngine state machine, Show v5 additive `frameRate`/`timecodeOffsetMs` metadata, and offline beat-grid/live-tempo bounds.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Sprint 3 changes (0 Critical, 3 High, 13 Medium, 12 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the step-4 fixes (0 Critical, 1 High test-order bug, 5 Medium, 8 Low), verified and fixed with additional regression tests.
- **What shipped:**
  - **Show v5 additive SMPTE metadata (`src/schemas/show-v5.schema.json`, `src/data/showFile.ts`, `src/input/useShowTimeline.ts`, `vite.config.ts`, `docs/show-format.md`):**
    - Added canonical `src/schemas/show-v5.schema.json` (SHA-256 pinned in `tests/show-file.test.mjs`, registered in `SHOW_SCHEMAS`), keeping `stage` and `interchange` optional and adding optional `timeline.frameRate` (`24 | 25 | 29.97 | 30`, with `29.97` documented as drop-frame) and `timeline.timecodeOffsetMs` (`0..86399999`).
    - v1–v4 schemas remain byte-for-byte untouched and hash-pinned; shows without v5 timeline metadata continue saving as v1–v4 unchanged.
  - **Main-process OSC 1.0 + Art-Net 4 `OpTimeCode` (`0x9700`) & shared UDP 6454 mux (`desktop/osc-packets.cjs`, `desktop/artnet-rx.cjs`, `desktop/show-control-service.cjs`, `desktop/show-control-ipc.cjs`, `desktop/dmx-sender.cjs`, `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/prepare.mjs`):**
    - Owned zero-dep CJS OSC 1.0 codec (8 KiB packet cap, bundle depth ≤ 4, ≤ 64 elements, strict 4-byte NUL padding, unknown tag & wildcard rejection) + Art-Net `OpTimeCode` (`0x9700`, `StreamId === 0`, 24/25/29.97DF/30 validation) sharing golden test vectors (`tests/fixtures/osc-vectors.json`) with the TS codec.
    - Shared exclusive-bind UDP `6454` multiplexer (`desktop/artnet-rx.cjs`, never `SO_REUSEADDR`, epoch-guarded `release()` + awaited `closing` socket) so Art-Net Timecode RX (`0x9700`) and Art-Net DMX discovery (`0x2100`) coexist cleanly without `EADDRINUSE`.
    - Serialized `opQueue` configuration, per-sender IP token buckets (OSC 500/s, Art-Net TC 120/s), ≤ 60 Hz TC IPC coalescing, outbound TX rate limit (120/s) + 24 h wrap, default-OFF boot on `127.0.0.1:8000` (explicit `0.0.0.0` toggle), validated IPC (`stageforge:show-control` + push-only event/status channels), non-owner status sanitization, window lifecycle teardown, and app-origin main-frame `midi`/`midiSysex` permission scoping.
  - **Browser OSC-over-WebSocket, Web MIDI MTC/MSC, and Single Clock Owner (`src/showControl/timecode.ts`, `src/showControl/oscCodec.ts`, `src/showControl/midiShowControl.ts`, `src/showControl/clockOwner.ts`, `src/showControl/useShowControl.ts`):**
    - `OscWebSocketClient` for web builds (`ws://`/`wss://`, 500/s rate limit, guarded `new WebSocket()` error handling) without relaxing Electron's strict CSP (`desktop/protocol.cjs` untouched).
    - `MtcDecoder` (Quarter-Frame `0xF1` forward 0→7 with +2 frame display offset & ¼-frame interpolation, reverse 7→0 seek-only, out-of-sequence/rate-change reset, Full-Frame SysEx immediate locate), `decodeMscSysex` (`GO`, `STOP`, `RESUME`, `TIMED_GO`, `SET` ctrl 1 grand master, `ALL_OFF`, `RESTORE`, `RESET`, ≤ 128 B cap, strict device/format/Q-number rules), status-first MIDI filtering with separate MTC/MSC buckets, and floating-point deadline-scheduled MTC output gated on `isTakePlaying()`.
    - Single Clock Owner (`allows(mode, source, action)`) enforcing `master` | `chase` | `caller` mutual exclusion so cues, follows, Auto-LD, and takes never double-fire; `ChaseEngine` (`UNLOCKED → LOCKING → LOCKED → FREEWHEEL → STOPPED` with single active source pin, LOCKING dropout timeout, stationary/paused TC detection, silent jump seek, and monotonic `chaseAdvance` / `chaseNeedsSeek`); `CallerDedupe` (250 ms cue idempotence even before React commits `activeCueId`, 100 ms bare-GO coalesce, strict cue matching with no fuzzy lookup).
  - **Offline beat grid, live tempo, tap tempo, downbeat nudge & half/double time (`src/audio/tempoEngine.ts`, `src/audio/AudioEngine.ts`):**
    - Added exact-pinned permissive dependencies `web-audio-beat-detector@8.2.39` (MIT) and `realtime-bpm-analyzer@6.3.0` (Apache-2.0); `THIRD_PARTY_NOTICES.txt` verified via fail-closed SPDX gate.
    - Offline beat grid (`analyzeFileBeatGrid`) enforces 64 MiB and 15 min caps before AND after mono 22.05 kHz `decodeAudioData`, caches per session, drives phase-locked file beats only when active, and preserves manual BPM edits made during analysis.
    - Live tempo (`createLiveBpmHandle`) loads `realtime-bpm-analyzer/processor?url` from `'self'` (verified under Electron's strict `script-src 'self'` CSP with zero errors), stabilized by `LiveBpmStabilizer` (rolling median + 4 s hold within ±1.5 BPM + > 1 BPM delta).
    - `TapTempoTracker` (`Tap` buttons + global `T` shortcut), downbeat nudge (`−50/−10/+10/+50 ms` + `Downbeat` / `1!`), and non-folding `½×`/`2×` bounded strictly to `[70, 180]` BPM with `aria-disabled` tooltips.
  - **UI, docs & tests (+9 unit tests, 128 → 137; +1 desktop smoke test, 7 → 8; +2 browser tests, 39 → 41):**
    - Added `ShowControlDrawer` (`left-2.5`, mutually exclusive with `DmxMonitorDrawer`, draft inputs committed on blur/Enter), `ClockBadge` (rendered only when `clockMode !== 'master'`, visible in Cinema mode, one-click `Master` reset), Sync button in `TopBar`, and Tempo controls in both `TopBar` Audio popover and `BottomConsole` Show tab.
    - Added `docs/show-control.md` (protocol tables + manual hardware/cross-tool checklist for QLab, TouchOSC, Reaper, grandMA3 onPC, and live mic/MIDI) and updated `docs/show-format.md`.
    - Added `tests/fixtures/osc-vectors.json`, `tests/show-control.test.mjs`, `tests/e2e/show-control-tempo.spec.mjs`, and extended `tests/show-file.test.mjs`, `tests/desktop-security.test.mjs`, and `tests/desktop/electron-smoke.spec.mjs`.
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**137/137**)
  - `npm run build`: PASS (`dist/schemas/show-v1..v5.schema.json` + first-party `realtime-bpm-processor` asset)
  - `npm run desktop:win`: PASS (portable exe built; `THIRD_PARTY_NOTICES.txt` passed SPDX gate)
  - `npm run test:desktop`: PASS (**8/8**, 9.8 s)
  - `npx playwright test --workers=1`: PASS (**41/41**, 5.4 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1, M13 & L1:* Wrapped `artnet-rx.cjs` subscriptions in unique token entries with awaited `closing` promise + epoch guard; serialized `show-control-service.cjs` `configure()`/`shutdown()` on `opQueue`; moved side effects out of `setState` updaters in `useShowControl.ts` and `App.tsx` (+overlapping configure & immediate re-acquire regression tests).
  - *Pass 1 H2, M2 & M9:* Fixed `ChaseEngine` `predictedMs` double-counting (`lastTcMs + elapsed`), added stationary/paused TC detection (requiring ≥ 2 repeats), capped LOCKED inter-frame interpolation, gated `startMtcOutput` on `isTakePlaying()`, and switched MTC TX to `performance.now()` deadline scheduling (+interleaved 30 fps & paused-TC regression tests).
  - *Pass 1 H3 & M10:* Unconditionally cleared `replaying.current`, froze `wallClock`, and reset `chaseIndex`/`chaseNeedsSeek` in `onModeReset`, `replace()`, record-stop, and `syncWallDuration()`.
  - *Pass 1 M1, M3, M4, M5, M6, M11, M12 & L2–L5:* Added local draft inputs committed on blur/Enter in `ShowControlDrawer.tsx`, per-source IP token buckets & strict boolean/ms/TX-rate validation in `show-control-service.cjs`, status-first MIDI filtering with separate MTC/MSC buckets (+4000-msg flood regression test), single active TC source pin in `ChaseEngine` (+dual-source regression test), `isMainFrame`/`requestingUrl` MIDI permission checks in `main.cjs`, manual-BPM preservation on late beat-grid completion, TC metadata reset on v1–v4 show loads, `try/catch` on `new WebSocket()`, post-decode `buffer.duration` cap, and non-owner `getStatus` sanitization.
  - *Pass 2 H-A, M-A–M-E & Lows:* Validated `send()` `ms`/`fps` before TX token/enabled checks, added LOCKING dropout timeout clearing `activeSource` (+regression test), scoped desktop socket rebind in `updateSettings` strictly to desktop network keys, allowed invalid unused TX hosts to fall back cleanly instead of blocking RX (+regression test), added `midiStatus.connected`/`settings.midiOutputId` to MTC TX effect deps, wrapped Art-Net TC TX `ms % DAY_MS`, synced `flagsRef` synchronously in toggle setters, fixed `CallerDedupe` pre-commit back-to-back duplicate handling, and moved `ShowControlDrawer` to `left-2.5` so `ClockBadge` never overlaps its Close button.
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 M7 (`/stageforge/go i` cue index vs button press):* Kept per Opus 5.5 spec (`/stageforge/go i` = 1-based cue index; TouchOSC next-cue buttons send float `1.0`/`0.0` or no args) and documented prominently in `docs/show-control.md`.
  - *Pass 1 M8 (MSC integer Q_number positional mapping):* Kept per Opus 5.5 spec (StageForge `ShowCue` has no separate numeric cue-number field; integer = 1-based index, dotted = exact trimmed label, no fuzzy matching).
  - *Pass 1 Low (beat-grid manual toggle / rubato fallback, Art-Net TC TX background throttling opt-out):* Deferred as minor enhancements; offline beat grid is non-destructive and only runs on loaded audio files.
- **Design decisions:**
  - Wrote owned zero-dep OSC 1.0 codecs (`desktop/osc-packets.cjs` + `src/showControl/oscCodec.ts`) verified by a shared golden-vector suite (`tests/fixtures/osc-vectors.json`) instead of bundling `node-osc`/`osc-js` so `desktop/build/app` keeps zero runtime `node_modules` and zero Node `ws` transitive bloat (per Opus 5.5 consult).
  - Kept Electron's strict CSP (`connect-src 'self' blob:`, `script-src 'self'`) completely untouched: desktop OSC uses Electron main UDP while browser builds use `OscWebSocketClient`, and `realtime-bpm-analyzer/processor?url` serves the AudioWorklet from `'self'` (verified live in Electron smoke test).
  - Introduced additive Show v5 (`show-v5.schema.json`) with optional `timeline.frameRate` & `timecodeOffsetMs` so v1–v4 schemas remain hash-pinned and untouched.
- **Leftovers / next up:**
  - Manual hardware & cross-tool checks (QLab, TouchOSC, Reaper MTC, grandMA3 onPC MSC/Art-Net TC, live room mic BPM) documented in `docs/show-control.md`.
  - Next up: Self-directed rounds — starting with **Realism backlog item 1** (Real equipment catalogue: split across rounds — catalogue data first, then models and textures, then lasers, per `HANDOFF.md`).

### 2026-11-24 04:02 PST — Self-directed Round 1 (Realism backlog 1a): real equipment catalogue data (`03b0d13`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted (`round-1-design.md` → `round-1-design-reply.md`) to rank the top five next improvements across phone usability, correctness, performance, accessibility, stage-design realism, open-standards roadmap (Sprint 4), and test gaps, and to design Realism item 1a (real equipment catalogue data) per `HANDOFF.md`'s priority rule.
    - *Opus 5.5 top-5 ranking:* (1) Realism 1a real equipment catalogue data + DMX footprint & Data L9 optics fixes + accessible model picker + sourcing tests; (2) Realism 1b procedural 3D models & PBR textures + phone/WebP/KTX2 asset budget & load-time measurement; (3) Realism item 2 real laser modules + `.ild` reader + IEC 60825 guidance + Engine L7 photosensitivity/reduced-flash option; (4) Realism item 3 equipment inventory & rental list + lifting 2-universe limit & patch CSV mode column; (5) Realism item 4 rigging/power realism + Engine L1 per-frame Three.js allocation hoisting.
  - Manufacturer datasheets & Open Fixture Library verified via web search on `2026-11-24`, with every unverified field explicitly flagged in both code (`unverified`) and `docs/equipment.md`.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Round 1 changes (0 Critical, 1 High, 7 Medium, 8 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the Step-4 fixes (0 Critical, 0 High, 0 Medium, 2 Low); fixed Low #2 (`LiveDmxBadge` screen-reader text) and documented Low #1.
- **What shipped:**
  - **Curated real equipment catalogue (`src/data/equipmentCatalog.ts`, `docs/equipment.md`):**
    - Added 30 touring models spanning beam, spot, profile, wash, followspot, LED PAR, LED batten, strobe, blinder, LED video panel (`ROE Visual Black Pearl BP2 V2`, `Carbon CB5`), hazer (`MDG ATMe`, `MDG theONE`, `Look Solutions Unique 2.1`), fogger (`Martin JEM ZR45`, `Look Solutions Viper NT`), CO2 jet (`MagicFX CO2Jet II`), and placeholder lasers (`KVANT Clubmax`, `KVANT Spectrum` until Realism item 2).
    - Every entry carries verified manufacturer datasheet specs (weight kg, power W, IP rating, optics/panel specs, real DMX modes & channel counts, `body` family hint for Round 2 3D models), explicit `sources` IDs cited in `docs/equipment.md`, and explicit `unverified` field paths.
    - Mapped every legacy `FixtureType`/`FloorFxType` in `LEGACY_DEFAULTS` while leaving all existing `RIG_TEMPLATES` and v1–v5 fixtures byte-identical.
  - **Additive Show v6 format (`src/schemas/show-v6.schema.json`, `src/data/showFile.ts`, `src/data/rigImport.ts`, `vite.config.ts`, `docs/show-format.md`):**
    - Added canonical `src/schemas/show-v6.schema.json` (SHA-256 pinned in `tests/show-file.test.mjs`, registered in `SHOW_SCHEMAS`, checked in `tests/desktop/electron-smoke.spec.mjs`) with optional `catalogId`, `dmxMode`, `dmxChannels` (plus `dependentRequired`) on `fixture`/`floorFx`, and optional `cabinetId` on `ledWall.cabinets`.
    - v1–v5 schemas remain byte-for-byte untouched and hash-pinned; shows without v6 fields continue saving as v1–v5.
    - `rigImport.ts` enforces `catalogId` cross-field rules, validates known-catalogue `type`/`dmxMode`/`led_panel` compatibility, preserves unknown forward-compatible `catalogId` values, and tolerates stored `dmxChannels` drift so saved show patches never break on future datasheet corrections (surfaced in Rig Builder with one-click `Re-patch?`).
    - Added `pruneInterchangeFixtureSpecs` in `showFile.ts` (keeping `fast-xml-parser` lazy-loaded) so changing a group's model/mode clears stale imported MVR GDTF specs for that group.
  - **Footprint-aware DMX patching, safe narrow writes & live-output warning (`src/data/dmxPatch.ts`, `src/engine/StageEngine.ts`, `src/components/DmxMonitorDrawer.tsx`, `src/components/DmxOutputSection.tsx`, `src/components/LiveDmxBadge.tsx`):**
    - Added `groupFootprint()`, clone-safe `exclude` in `buildDmxPatch()`/`allocateDmx()`, non-merging `addPatchedUnits()` across different `catalogId`/`dmxMode`/`dmxChannels`, `repatchGroup()` (keeps address when fitting, relocates cleanly across U1–U2 without conflicts, rejects when full, clears stale `optics` on model switch), and `writeDmxChannels()` clamping moving-head, laser, and strobe DMX writes strictly to each unit's footprint so narrow modes (e.g., 1–6 ch LED PARs) never overwrite neighbours.
    - Surfaced visible `"Simulated control layout, not the fixture's real channel map"` warnings in `DmxMonitorDrawer`, `DmxOutputSection` (before arming live output), and `LiveDmxBadge` (`Sim map` + screen-reader text).
  - **Catalogue optics, Data L9 fixes & per-model production estimates (`src/data/fixtureOptics.ts`, `src/data/productionEstimator.ts`):**
    - Derived `REFERENCE_OPTICS` directly from `EQUIPMENT_CATALOG`, added `catalogOptics()` (verified fields only) and `resolveOptics()` (verbatim pass-through for legacy groups, catalogue defaults with user overrides winning), fixed Data L9 (`{}` empty-object handling and finite gain bounds), and wired `StageEngine.ts` to `resolveOptics()`.
    - Updated `calculateProductionEstimate()` to emit per-model rows using verified catalogue `weightKg` (→ lbs) and `powerW` (falling back to legacy allowances with `(est. weight/power)` labels when unverified/missing, and using verified LED panel cabinet specs when `cabinetId` is set) while keeping all legacy rigs and crew counts unchanged.
  - **Accessible UI pickers (`src/components/EquipmentPicker.tsx`, `src/components/RigBuilderDrawer.tsx`, `src/components/LedCabinetEditor.tsx`, `src/components/FixtureOpticsEditor.tsx`, `src/App.tsx`):**
    - Added keyboard-accessible, Escape/Tab-trapped `EquipmentPicker` (responsive bottom sheet on phones, modal popover on desktop) with category chips, search, DMX mode selector, and `?` unverified markers; added LED `Panel model` selector in `LedCabinetEditor` (reverting to `Custom` on manual physical/pixel edits); added `Reset to catalogue values` in `FixtureOpticsEditor`.
  - **Tests (+7 unit tests, 137 → 144; +1 browser test, 41 → 42; desktop smoke checks v1–v6 schemas):**
    - Added `tests/equipment-catalog.test.mjs` (catalogue schema/sourcing/`docs/equipment.md` integrity, `repatchGroup`, `resolveOptics`, estimator, `rigImport`, MVR spec pruning, and all QA regressions), extended `tests/show-file.test.mjs` (v6 hash pin, per-field v6 round-trips, template version invariance, v5/v7 rejections), extended `tests/desktop/electron-smoke.spec.mjs`, and added `tests/e2e/equipment-catalog.spec.mjs`.
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**144/144**)
  - `npm run build`: PASS (`dist/schemas/show-v1..v6.schema.json` emitted; `fast-xml-parser` stays lazy-loaded)
  - `npm run desktop:win`: PASS (portable exe built; zero new runtime deps; SPDX check green)
  - `npm run test:desktop`: PASS (**8/8**)
  - `npx playwright test --workers=1`: PASS (**42/42**, 5.7 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1:* Added `writeDmxChannels()` clamping moving-head, laser, and strobe writes in `StageEngine.ts` strictly to each unit's `dmxWidth` (`groupFootprint`) and sliced channel labels in `DmxMonitorDrawer.tsx` (+narrow-footprint regression test).
  - *Pass 1 M1:* Restored `totalCo2Count > 0 || totalSmokeCount > 0` in `productionEstimator.ts` so hazer-only legacy rigs keep identical labour estimates (+regression test).
  - *Pass 1 M2 & L6:* Gated catalogue fixture weight/power in `productionEstimator.ts` on `!isFieldUnverified` with explicit `(est. weight, est. power)` labels, and kept overhead vs floor laser cost buckets distinct (+regression test).
  - *Pass 1 M3 & L2:* Removed unverified `0.1°` lower bound from `claypaky-sharpy` (using verified `beamDeg: 3.8`), restricted `catalogOptics()` to verified optical fields, and raised `MAX_AERIAL_GAIN` to `1e9` (+all-catalogue sanity gain `< 1000` and legacy extreme regression tests).
  - *Pass 1 M4:* Cleared stale per-model `optics` overrides in `withModelUpdate()` when `catalogId` changes while keeping them on same-model DMX mode switches (+regression test).
  - *Pass 1 M5 & Pass 2 L2:* Added visible `Sim map` badge with `<span className="sr-only">` explanation in `LiveDmxBadge.tsx` and visible simulated-layout note in `DmxOutputSection.tsx`.
  - *Pass 1 M6:* Added Tab / Shift+Tab focus trap to `EquipmentPicker.tsx` modal dialog (+Escape/focus-restore e2e check).
  - *Pass 1 L1, L4, L8:* Made `exclude` matching in `buildDmxPatch()` clone-safe (+regression test), guarded `onModelChanged` against no-op re-applies, and added `dependentRequired` to `src/schemas/show-v6.schema.json`.
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 M7 (reject known `catalogId` + `dmxMode` when `dmxChannels` differs from catalogue):* Rejected per Opus 5.5 design — stored `dmxChannels` is authoritative so future datasheet corrections never silently break saved show patches; H1 eliminates narrow-footprint cross-talk, and Rig Builder surfaces drift with one-click `Re-patch?`.
  - *Pass 1 L3 (CSV simulated-layout column/note) & L5 (per-row `est. cost` suffix) & L7 (OFL attribution in `THIRD_PARTY_NOTICES.txt`):* Deferred/rejected — preserving existing CSV schema (Mode column planned for item 3), `CostEstimatorModal` subtitle already notes illustrative budgets, and OFL MIT notice is recorded in `docs/equipment.md`.
  - *Pass 2 L1 (`optics: {}` on legacy group has `zoomSlope = 0`):* Intentional Sprint 0 Data L9 fix (empty `{}` is unconfigured; `FixtureOpticsEditor` never emits `{}`).
- **Design decisions:**
  - Chose Option A for Show v6 (`catalogId`, `dmxMode`, stored `dmxChannels`, `cabinetId`) keeping `type` as the simulation/render class while keeping rich categories, `body` families, and verified/unverified metadata in `equipmentCatalog.ts` (per Opus 5.5 consult).
  - Left `RIG_TEMPLATES` untouched in Round 1 so existing preset addresses, DMX/GLB/DXF/MVR tests, and v1/v2 save versions remain invariant until templates are re-patched in item 3.
  - Zero new runtime dependencies added.
- **Leftovers / next up:**
  - Next up: **Realism backlog item 1b** (3D procedural models and PBR textures for every catalogue item, with phone/WebP/KTX2 asset size budget, instancing, lazy loading, and `docs/assets.md`).


### 2026-11-24 05:01 PST — Self-directed Round 2 (Realism backlog 1b): 3D hardware models, PBR trim-sheet textures, render tiers & shared equipment symbols (`c7f35a5`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted (`round-2-design.md` → `round-2-design-reply.md`) to rank the top five next improvements across phone usability, correctness, performance, accessibility, stage-design realism, open-standards roadmap (Sprint 4), and test gaps, and to design Realism 1b.
    - *Opus 5.5 top-5 ranking:* (1) Realism 1b procedural 3D hardware models, deterministic PBR trim-sheet atlas, `releaseGroup` cache fix, hung/floor 2D plan symbols, and picker/manifest thumbnails; (2) Phone render tier (`'high' | 'low'`) with DPR/texture/LOD budgets and `renderer.info` probe assertions (folded into 1b); (3) Photosensitivity guard (WCAG 2.3.1 ≤ 3 Hz preview flash cap under `prefers-reduced-motion` / toggle without touching live DMX); (4) Geometry, pivot, determinism, and GLB visual invariant tests (folded into 1b); (5) Additive MVR fixture manufacturer/model identity mapping ahead of Sprint 4 DXF import.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Round 2 changes (0 Critical, 2 High, 6 Medium, 7 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the Step-4 fixes (0 Critical, 0 High, 0 Medium, 4 Low); fixed/documented Low items in `docs/assets.md`.
- **What shipped:**
  - **Deterministic procedural PBR trim-sheet atlas & Node-safe materials (`src/engine/prng.ts`, `src/engine/hardwareMaterials.ts`, `src/engine/geometryBuilders.ts`):**
    - Added Mulberry32 deterministic PRNG (`mulberry32`) and pure typed-array pixel generators (`generateHardwareAtlasPixels`, `generateDeckPixels`) so both browser WebGL and Node unit tests execute identical byte-deterministic textures.
    - Built an 8-band trim-sheet PBR atlas (512² high / 256² low albedo + packed G=roughness/B=metalness + 256²/128² tangent-space normal map) covering black powder-coat, brushed dark anodised aluminium, cast alloy, matte rubber, extruded heat-sink fins, rear powerCON/5-pin XLR connector plate, symmetric OLED status strip, and IEC hazard stripe / multi-cell optic baffle — sharing **one** `hardwareBody` and **one** glossy `hardwareGlass` `MeshStandardMaterial` across all fixtures (keeping per-fixture emissive lens materials private).
    - Replaced `Math.random()` stage deck scuffs with seeded `STAGE_DECK_SEED`, added `typeof document === 'undefined'` Node fallback and `disposeSharedMaterials()`, and added `resolveRenderTier()` / `detectRenderTier()` (auto-low on phones & constrained coarse-pointer devices while keeping standard desktop laptops like 1366×768 on `'high'`), plus resize `renderer` + `composer` pixel-ratio updates (Engine L9).
  - **Procedural 3D models & GPU geometry cache for all 30 catalogue entries (`src/engine/fixtureModels.ts`, `src/engine/focusAim.ts`, `src/engine/beamPools.ts`, `src/engine/shaders.ts`, `src/engine/StageEngine.ts`):**
    - Added data-driven `MODEL_SPECS` and family builders for all 30 catalogue models across all 14 `CatalogBodyFamily` types (moving beams/spots/profiles/washes/followspots with distinct barrels/snouts/IP65 fins/multi-cell faces/handles, LED PARs, 16/20-cell linear battens, GLP JDC1 vs Atomic 3000 strobes, Molefay vs STRIKE 4 2×2 blinders, ROE BP2/CB5 rear LED cabinet tiles, MDG/Look hazers, Martin/Look foggers, MagicFX CO2Jet II, and KVANT laser heads), with separate hung clamps vs floor rubber feet and strict high/low triangle budgets.
    - Added `FixtureModelCache` with `sharedResources` protection in `StageEngine.releaseGroup()` (eliminating premature cached-geometry disposal) and `beginRebuild()` / `endRebuild()` pruning of stale custom-sized LED cabinet-back tiles.
    - Added instanced rear LED cabinet tile grids (`InstancedMesh`, 1 draw call per wall) behind flat main LED walls, IMAG side wings, and authored cabinet screens.
    - Extended `focusAim.ts` (`aimAngles(..., pivot = HEAD_PIVOT)` and `aimTiltOnly`) so catalogue models aim from their true tilt pivot, motorized battens tilt cleanly without panning, fixed PARs honour explicit focus points and manual aim while staying stationary during automated chases, and legacy fixtures (no `catalogId`) remain bit-identical (`HEAD_PIVOT`, pan-tilt).
    - Wired per-model `lensOffsetY` through `VOLUMETRIC_BEAM_VERT` (`uLensOffset`) and `BeamPools` (`beam.userData.lensOffsetY`) so aerial cones and floor pools originate accurately on every model's emission face.
    - Added `?probe` `renderStats()` and `rebuildRig()` diagnostics in `StageEngine.ts` / `App.tsx`.
  - **GLB export optimisation & safety cap (`src/engine/stageGlb.ts`):**
    - Preserved optional `catalogId` in `nameFixtureUnit()` `userData`, stripped `normalMap` on cloned export materials, passed `maxTextureSize: 512`, and capped expanded LED cabinet-back instances at `MAX_GLB_CABINET_BACK_INSTANCES = 2000` (recording `scene.userData.cabinetBacksOmitted = true` above cap).
  - **Unified SVG/DXF symbols & UI thumbnails (`src/data/equipmentSymbols.ts`, `src/components/EquipmentThumbnail.tsx`, `src/components/StageDesigner.tsx`, `src/components/StageDesigner.css`, `src/data/stageDxf.ts`, `src/components/EquipmentPicker.tsx`, `src/data/productionEstimator.ts`, `src/components/CostEstimatorModal.tsx`):**
    - Created pure `equipmentSymbols.ts` mapping all 14 body families (+ LED panel aspect ratios) to top-down plan and front-elevation vector silhouettes.
    - Added memoized non-interactive fixture plan symbols (`data-testid="plan-fixture-symbols"`, `pointer-events: none`, `aria-hidden="true"`) with a toolbar `Fixtures` visibility toggle in `StageDesigner.tsx`, positioned via `placeFixtures()`.
    - Upgraded `stageDxf.ts` to draw family plan symbols while keeping `SF_<TYPE>` block names and legacy 3-string XDATA untouched for legacy fixtures, adding distinct family block names + `catalogId` XDATA when catalogue models differ in body family.
    - Added `<EquipmentThumbnail>` silhouettes to `EquipmentPicker` (trigger, cards) and `CostEstimatorModal` (equipment manifest rows via optional `CostLineItem.body`/`catalogId`).
  - **Docs & tests (+8 unit tests, 144 → 152; expanded browser e2e assertions):**
    - Added `docs/assets.md` (full MIT provenance table, PRNG seeds, 8-band trim-sheet layout, high/low triangle/draw-call/VRAM/GLB budgets) and linked it from `docs/equipment.md`.
    - Added `tests/fixture-models.test.mjs` (all 30 models × 2 tiers × hung/floor triangle/pivot/clamp/feet contracts, Node SSR & byte-determinism, focus-aim & tilt-only convergence, cache reuse & cabinet-back pruning, GLB normalMap/cap, DXF family blocks, and all Pass 1 QA regressions) and extended `tests/e2e/equipment-catalog.spec.mjs` (picker/manifest thumbnails, 2D plan fixture symbols toggle, live GPU draw-call/triangle budgets, and 10-rebuild geometry/texture leak check).
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**152/152**)
  - `npm run build`: PASS (`index-*.js` 398.45 kB gzipped; zero new asset fetches)
  - `npm run desktop:win`: PASS (portable exe built; zero new dependencies; SPDX gate green)
  - `npm run test:desktop`: PASS (**8/8**, 10.0 s)
  - `npx playwright test --workers=1`: PASS (**42/42**, 6.4 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1 & L2:* Fixed `mapGeometryUvToBand` wrapping exact `1.0` UVs to `0.0` (which collapsed `BoxGeometry` faces to a single texel), preserving `[0, 1]` endpoints and increasing mip-safe band padding to 12% (+regression test).
  - *Pass 1 H2:* Guarded `MODEL_SPECS` and `FAMILY_SYMBOLS` lookups with `Object.hasOwn` so hostile prototype keys like `catalogId: "constructor"` fall back safely instead of throwing (+regression test).
  - *Pass 1 M1:* Passed `uLensOffset` uniform into `VOLUMETRIC_BEAM_VERT` and `beam.userData.lensOffsetY` into `BeamPools.add()` so non-legacy beam pools originate at each model's real lens face (+regression test).
  - *Pass 1 M2:* Replaced `min(innerWidth, innerHeight) <= 768` with `resolveRenderTier()` so standard 1366×768 fine-pointer laptops stay `'high'` while phones and constrained coarse-pointer devices get `'low'` (+regression test).
  - *Pass 1 M3:* Allowed `motion: 'fixed'` PARs to aim onto explicit focus marks and manual angles while holding static orientation during automated chases.
  - *Pass 1 M4 & L3:* Added `beginRebuild()` / `endRebuild()` cabinet-back tile pruning on `FixtureModelCache` (preventing unbounded growth during wall-size drags) and removed unused unsafe `setTier()` (+30-resize pruning regression test).
  - *Pass 1 M5:* Moved textured `HazardAndCells` optic strips/faces (`stub-cells` and low-tier `bar-cells`) into textured `headParts` (`hardwareBody`) rather than untextured `hardwareGlass` (+regression test).
  - *Pass 1 M6:* Added `yOffset` to `addClampParts()` so hung static fixture clamps seat cleanly on top of the yoke crossbar (`mountOffsetY`), and derived `StageEngine` hung offsets from `mountOffsetY` (+regression test).
  - *Pass 1 L1, L4, L5 & Pass 2 L1–L3:* Synced `composer.setPixelRatio(dpr)` on init/resize, memoized `placeFixtures(shownRig)` in `StageDesigner.tsx`, and updated `docs/assets.md` draw-call counts (`≤ 7` moving / `≤ 6` static), GLB cap metadata note, and construction-time render tier note.
- **QA findings rejected or deferred (with reasons):**
  - *Pass 2 L4 (unknown `catalogId` strings in DXF XDATA):* Verified already sanitized — `rigImport.ts` restricts `catalogId` to `CATALOG_ID_PATTERN` (`/^[a-z0-9][a-z0-9-]{1,63}$/`) and `stageDxf.ts` `addProperty()` runs every string through `labelText()` (control-char stripping, `\U+XXXX` escaping, 255-byte chunking).
  - *Pass 2 L2 (UI toast for >2,000-tile GLB `cabinetBacksOmitted`):* Deferred to keep `exportStageGlb()` signature (`Promise<Blob>`) unchanged; documented in `docs/assets.md`.
- **Design decisions:**
  - Chose 100% procedural Three.js models + 1 shared deterministic PBR trim-sheet atlas (`hardwareBody` + `hardwareGlass`) over external glTF/image files so transfer size stays tiny for phones on GitHub Pages, Electron CSP & offline mode need zero exceptions, licences stay pure repo MIT, and every geometry/texture invariant is unit-testable in Node (per Opus 5.5 consult).
  - Kept legacy fixtures without `catalogId` locked to `HEAD_PIVOT` (`0.46 m`) and `pan-tilt` motion while giving them realistic procedural hardware meshes so v1–v5 shows and focus-point tests remain bit-identical.
- **Leftovers / next up:**
  - Next up: **Realism backlog item 2** (Real laser modules: real power classes, colour/watts/kpps/DMX modes, safe size-capped `.ild` ILDA frame reader, and IEC 60825 audience-scanning safety guidance; plus optional WCAG 2.3.1 photosensitivity preview flash guard).

### 2026-11-24 06:01 PST — Self-directed Round 3 (Realism backlog 2): real laser modules, capped ILDA reader & IEC 60825 safety guidance (`4063c43`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted (`round-3-design.md` → `round-3-design-reply.md`) to rank the top five next improvements across phone usability, correctness, performance, accessibility, stage-design realism, open-standards roadmap (Sprint 4), and test gaps, and to design Realism item 2.
    - *Opus 5.5 top-5 ranking:* (1) Realism item 2 real laser modules, capped ILDA reader, and IEC 60825 audience-scanning safety guidance (+ phone usability for the Laser tab); (2) Dedicated phone Playwright project covering Studio, Laser tab, `EquipmentPicker`, file open, and Stage Designer touch; (3) Load-time budget & lazy-loading for Stage Designer, interchange, and beat workers; (4) Accessibility summary of 3D canvas + SVG keyboard nudge/rotate; (5) Sprint 4 DXF import + block-aware DXF export using shared symbols.
    - Opus 5.5 caught a blocking v6 backwards-compatibility hazard up front: removing `Placeholder DMX (18-Ch)` from `kvant-clubmax`/`kvant-spectrum` would break Round 1/2 saved v6 shows in `rigImport.ts`. Preserved both IDs and kept the 18-ch mode as `legacy: true` (hidden from `EquipmentPicker` for new selections, never `modes[0]`).
  - Manufacturer datasheets verified via web search on `2026-11-24` (Laserworld CS-500G, Unity Lasers Raw 1.7, Laserworld DS-3000RGB MK5, KVANT Clubmax 6000 FB4, Laserworld PL-10.000RGB MK3, KVANT Spectrum 30, Pangolin FB4 16/39-ch DMX, Laserworld ShowNET 19/34-ch DMX); unverified fields explicitly flagged in code and `docs/equipment.md`.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Round 3 changes (0 Critical, 3 High, 4 Medium, 6 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the Step-4 fixes (0 Critical, 0 High, 1 Medium, 5 Low); verified and fixed Medium M-A and Lows #1–#2 with regression tests.
- **What shipped:**
  - **Real laser catalogue across power classes (`src/data/equipmentCatalog.ts`, `src/engine/fixtureModels.ts`, `src/components/EquipmentPicker.tsx`, `docs/equipment.md`, `docs/assets.md`):**
    - Replaced the 2 placeholder lasers with 6 curated models spanning Class 3B single-colour green through 30 W IP65 arena RGB: `laserworld-cs-500g` (400 mW 532 nm single-colour, Class 3B, beam-only, 15/12 ch), `unity-raw-1-7` (1.7 W RGB, 30 kpps, 10/34 ch), `laserworld-ds-3000rgb` (3 W RGB, 40 kpps, IP4X, ShowNET 19/34 ch), `kvant-clubmax` (upgraded in place to KVANT Clubmax 6000 FB4, 6 W RGB, 40 kpps, 60°, FB4 16/39 ch + hidden `legacy: true` 18-ch mode), `laserworld-pl-10000rgb` (10 W RGB, 40 kpps, IP54, ShowNET 19/34 ch), and `kvant-spectrum` (upgraded in place to KVANT Spectrum 30, 30 W RGB, 30 kpps, IP65, FB4 16/39 ch + hidden `legacy: true` 18-ch mode).
    - Added typed `CatalogLaserSpec`, `LaserChannelRole`, `CatalogDmxMode.legacy`, `CatalogDmxMode.layout`, `CatalogEntry.aliases`, `getSelectableModes()`, laser spec badges (`W`/`mW`, `nm`/`RGB`, `kpps`, `Class 3B/4`), and distinct `laser-head` 3D chassis proportions (with heat-sink fins ≥ 10 W and dual touring handles ≥ 20 W).
    - `EquipmentPicker` matches aliases, hides `legacy` modes for new selections, prompts to upgrade when a group uses a legacy mode, and gives the DMX mode selector a 44 px mobile touch target.
  - **Safe, size-capped ILDA (`.ild`) reader & GPU renderer (`src/data/ilda.ts`, `src/data/laserScan.ts`, `src/engine/ildaRenderer.ts`, `src/engine/StageEngine.ts`, `src/components/IldaLoader.tsx`):**
    - Pure zero-dep IDTF Rev 011 binary parser/encoder supporting Formats 0 (3D indexed), 1 (2D indexed), 2 (palette ≤ 256 entries), 4 (3D true-colour BGR), and 5 (2D true-colour BGR), standard 64-colour default palette, blanking (`0x40`), last-point (`0x80`), EOF (`records === 0`), trailing-byte warnings, and strict hostile caps (8 MiB, 2,000 frames, 4,000 pts/frame, 200,000 high-tier / 60,000 low-tier total pts).
    - Added `generateDemoIlda()` emitting real binary Format 5 bytes for 4 built-in presets (`tour_show`, `circle_tunnel`, `graphic_star`, `static_spot`).
    - Added `BakedIldaClip` baking all clip frames once into shared `BufferAttribute`s (RGB + monochrome luminance for single-colour diodes), driving 1 `THREE.LineSegments` draw call per projector via zero-alloc `drawRangeFor()` across `Both` / `Beam` / `Graphic` modes, with kpps refresh-rate flicker simulation (`laserRefreshHz` / `evaluateLaserScan` < 30 Hz) and unified shared-attribute disposal across `setIldaClip(null)`, `rebuildRig()`, and `dispose()`.
    - Kept `.ild` clips in-session only (no Show v7 bump), clearly badged `Not saved with show`.
  - **Shared laser aim, role-mapped DMX & IEC 60825 / ANSI Z136 safety guidance (`src/data/laserAim.ts`, `src/data/laserSafety.ts`, `src/engine/shaders.ts`, `src/engine/laserGeometry.ts`, `src/components/LaserSafetyPanel.tsx`, `src/components/LaserProjectorControls.tsx`, `src/components/BottomConsole.tsx`, `src/components/DmxMonitorDrawer.tsx`, `src/App.tsx`):**
    - Extracted shared laser geometry/pitch/roll/scan-tangent constants into `laserAim.ts`, interpolated directly into `shaders.ts` and `laserGeometry.ts`, and set `root.rotation.order = 'YXZ'` in `StageEngine.ts` so visual projection and safety math agree across all mount yaws and rolls.
    - Enforced single-colour diode output in both `StageEngine` (allocation-free `applyLaserColors()`) and `LaserProjectorControls` (disabled colour dropdown with `Single-colour 532 nm projector` hint); enforced beam-only hardware capability on ILDA Graphic mode.
    - Role-mapped DMX encoding (`encodeLaserDmxChannels`) writes verified FB4 16/39-ch and ShowNET Pro 34-ch layouts using unscaled desk intensity (`Math.min(1, baseLaserInt)`), keeps byte-identical 8-ch simulator output for legacy/uncatalogued lasers, and outputs safe blackout zeros (`0`) for real catalogue modes without a verified channel map (labelled `Unmapped (safe 0)` in `DmxMonitorDrawer`).
    - Pure `evaluateLaserSafety()` checks worst-case audience-zone clearance (`< 3.0 m` over `z > stageDepth / 2`, noting `2.5 m` lateral separation), `CROWD SCAN ON`, stationary/collapsed/single-point ILDA dwell beams (including momentary bump), and Class 3B/4 power notice, surfaced in a phone-friendly `LaserSafetyPanel` (calm `role="status"` live region announcing discrete transitions only, icon + text, explicit design-guidance-only disclaimer) and header `LaserSafetyChip`.
  - **Tests (+7 unit tests, 152 → 159; +2 browser tests including 390 px phone viewport, 42 → 44):**
    - Added `tests/laser-modules.test.mjs` (ILDA formats 0/1/2/4/5, BGR, caps, 64 KB fuzzing, shader constant parity, YXZ Euler parity, sheet/ILDA roll envelopes, 3.0 m boundary, exact ILDA angular span, safe-zero unmapped DMX, Round 1/2 v6 legacy compatibility, headless `BakedIldaClip` draw ranges/disposal) and `tests/e2e/laser-modules.spec.mjs` (desktop model picker, single-colour lock, safety `role="status"` danger check, ILDA load/unload GPU leak check, corrupt `.ild` toast, and 390×844 phone usability with ≥ 44 px touch targets & zero horizontal overflow).
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**159/159**)
  - `npm run build`: PASS (`index-*.js` 411.02 kB gzipped; 0 warnings)
  - `npm run desktop:win`: PASS (portable exe built; zero new dependencies; SPDX check green)
  - `npm run test:desktop`: PASS (**8/8**, 10.2 s)
  - `npx playwright test --workers=1`: PASS (**44/44**, 6.5 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1:* Set `root.rotation.order = 'YXZ'` in `StageEngine.ts` and exported `laserRayWorldDirection()` verified against `THREE.Euler(pitch, yaw, 0, 'YXZ')` at yaw 0°/90°/180°/−60° (+regression test).
  - *Pass 1 H2:* Added sheet roll (`LASER_SHEET_ROLL_SCALE`, `matrix` 90°/full-spin) and ILDA roll (`LASER_ILDA_ROLL_SCALE` bounding-corner rotation with interior minimum) to `laserFanHalfAngles()` and `evaluateLaserSafety()` (+regression test).
  - *Pass 1 H3 & M1:* Passed unscaled `Math.min(1, baseLaserInt)` to `encodeLaserDmxChannels` (keeping `laserPowerPresence` visual-only), and output safe blackout zeros for real catalogue laser modes without verified DMX layouts while preserving legacy 8-ch bytes for uncatalogued/`legacy: true` modes (+regression test).
  - *Pass 1 M2 & M3:* Replaced approximate ILDA span with exact `atan` angular span (fixing 2× overstatement; +0.4° vs 0.6° regression test) and unified scan tangent mapping + `[5, 80]`° clamp in shared `ildaScanTangents()` (+parity regression test).
  - *Pass 1 M4:* Removed hot-loop laser allocations via `applyLaserColors()`, `laserRefreshHz()`, `ildaDrawRangeScratch`, and `laserDmxScratchValues` (+regression test).
  - *Pass 1 Lows:* Warn instead of throw on 1–31 trailing bytes after last ILDA frame without EOF header (+regression test), conservatively floor sub-threshold clearance (`2.96 m` → `2.9 m`), wired `bump.laser` into `evaluateLaserSafety()` (+regression test), and added `min-h-[44px]` to `EquipmentPicker` DMX mode `<select>`.
  - *Pass 2 M-A, Low #1 & #2:* Used global laser index (`placements.entries()`) for `matrix` parity matching `StageEngine.ts`'s `globalLaserIndex++`, shared `formatClearanceM()` between `laserSafety.ts` danger messages and `LaserSafetyPanel.tsx`, and checked `!modeLayout?.length` in `DmxMonitorDrawer.tsx` (+regression tests).
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 Low (double bake via `previewRig()` in `App.tsx`):* Rejected as false positive — `StageEngine.previewRig()` only sets `this.standby = false` and never triggers `rebuildRig()`.
  - *Pass 1 Low (auto-arming laser on ILDA load):* Kept intentionally to match clicking any procedural laser pattern button in `BottomConsole.tsx` (since `INITIAL_SHOW_STATE.laser.enabled` boots `false`).
  - *Pass 2 Low #3 (any single stationary frame in ILDA clip flags stationary hazard):* Kept intentionally conservative for laser safety (a stalled/looped single dwell frame still poses an MPE hazard).
  - *Pass 2 Low #4 & #5 (custom-hex string parse in custom color modes; ~2 cm model `mountOffsetY` delta in safety):* Deferred as negligible.
- **Design decisions:**
  - Upgraded `kvant-clubmax` and `kvant-spectrum` in place while keeping `Placeholder DMX (18-Ch)` as `legacy: true` at `modes[2]` so Round 1/2 saved v6 shows load byte-identically without schema bumps (per Opus 5.5 consult).
  - Used baked shared-attribute `THREE.LineSegments` (`BakedIldaClip`) for ILDA playback (1 draw call/projector, zero per-frame allocations) rather than filled fan triangles (deferred to Item 8 volumetric haze scatter).
  - Kept `.ild` clips in-session only (no Show v7 schema bump) to keep Round 3 focused and reviewable in the morning.
- **Leftovers / next up:**
  - Next up: **Realism backlog item 3** (Equipment inventory & rental list: counts by model, total weight, total power draw, universes & channels used, printable & CSV equipment list, and optional shop stock quantity limits).

### 2026-11-24 07:01 PST — Self-directed Round 4 (Realism backlog 3): equipment inventory, shop stock limits, CSV export & printable rental list (`7aefd78`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted (`round-4-design.md` → `round-4-design-reply.md`) to rank the five highest-value next improvements across phone usability, correctness, performance, accessibility, stage-design realism, open-standards roadmap (Sprint 4), and test gaps, and to design Realism item 3.
    - *Opus 5.5 top-5 ranking:* (1) Realism item 3 equipment inventory & rental list + focus-trap fix, first `@media print` sheet, shared `csv.ts`, 390 px phone test, lazy-loaded modal, reduced-motion spinner; (2) Realism item 4 rigging & power realism + coarse-pointer 44 px touch targets + three-phase report; (3) Realism item 5 show paperwork + universe expansion beyond U2 (needs user Show v7 decision); (4) Realism item 6 console feel + WCAG 2.3.1 photosensitivity flash-rate guard; (5) Realism item 7 fixture behaviour polish + chunk splitting & per-frame allocation audit.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Round 4 changes (0 Critical, 0 High, 6 Medium, 7 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the Step-4 fixes (0 Critical, 0 High, 0 Medium, 2 cosmetic Low items on `StockQtyInput`, both polished to commit on blur/Enter).
- **What shipped:**
  - **Shared CSV module & pure equipment inventory (`src/data/csv.ts`, `src/data/patchCsv.ts`, `src/data/equipmentInventory.ts`, `src/data/productionEstimator.ts`):**
    - Extracted RFC 4180 + formula-neutralizing (`=`, `+`, `-`, `@`, `\t`, `\r`) CSV serialization into `src/data/csv.ts`, preserving byte-identical `patchCsv()` output (verified by snapshot test) while adding Excel-friendly UTF-8 BOM + CRLF `equipmentInventoryCsv()` with numeric literals, empty cells for unknown/unlimited values, single-emission pool stock columns (so `Sub-rent` column sum equals `Total`), and a trailing `Total` row.
    - Added additive exports (`KG_TO_LBS`, `HARDWARE_ALLOWANCE`) and optional `CostLineItem.kind` in `productionEstimator.ts` (all existing estimate calculations numerically untouched).
    - Built pure `computeInventory(rig, stage, shopStock)` aggregating fixtures/lasers/FX by real catalogue model & DMX mode (with generic groups mapped to `LEGACY_DEFAULTS` stock pools and badged `estimate`), reusing estimator infrastructure rows (truss, motors, LED video, audio, stage/FOH, scenery), deriving totals directly from `estimate` so both tabs maintain exact kg/lb/W parity, and reporting per-universe DMX `usedSlots`, `freeSlots`, `conflictSlots`, `overflowChannels`, and `unpatchedUnits`.
  - **Optional rental shop stock limits (`src/data/shopStock.ts`, `src/components/RigBuilderDrawer.tsx`, `src/components/EquipmentPicker.tsx`, `src/components/LedCabinetEditor.tsx`):**
    - Added `Unlimited (free design)` default plus three illustrative fictional presets (`Local Club Shop`, `Regional Production House`, `Arena Touring Vendor`) covering all 34 catalogue IDs, plus editable `Custom shop` (0–9999 integers) persisted under `stageforge.shop.v1` with hostile-input parsing (`Object.create(null)`, prototype-key/unknown-ID/float/NaN/range/64 KB rejection).
    - Implemented single delta gate `stockViolations(prevRig, nextRig, shop)` across all Rig Builder add/switch paths (`addTrussPod`, `addFixtureToPod`, `addFloorFx`, `changePodFixtureModel`, `changeFloorFxModel`): hard-blocks increases over stock (with `role="alert"` message + `Allow over-stock (plan a sub-rental)` soft toggle + one-click `Unlimited`), always allows removals and switches into stocked models, never blocks whole-rig opens/imports/presets (surfacing `Need X · In stock Y · Sub-rent Z` badges instead), and gives LED panel cabinet edits soft stock warnings derived from `computeLedCabinetDemand(rig, stage)` inside a mounted `role="status" aria-live="polite"` region.
    - Updated `EquipmentPicker` to display `N in stock · M free` per model and mark disallowed models `aria-disabled="true"` with unique `aria-describedby` explanations while keeping them keyboard-focusable.
  - **Tabbed, lazy-loaded Gear & production modal, printable sheet & Electron support (`src/components/CostEstimatorModal.tsx`, `src/components/CostCrewPanel.tsx`, `src/components/InventoryPanel.tsx`, `src/components/InventoryPrintSheet.tsx`, `src/components/TopBar.tsx`, `src/components/ShowFiles.tsx`, `src/App.tsx`, `desktop/main.cjs`, `src/index.css`, `docs/equipment.md`):**
    - Refactored `CostEstimatorModal` into a lazy-loaded (`React.lazy` with retryable `ErrorBoundary` reset, `Suspense`) **Gear & production** dialog with ARIA tabs (`Inventory` default, `Cost & crew`, roving tabindex, Arrow/Home/End, persisted in `stageforge.gearTab.v1`) and a full focus trap covering buttons, selects, inputs, and links; added `motion-reduce:animate-none` to the load-in spinner.
    - Renamed TopBar trigger to `Gear & cost` (`aria-label="Gear, cost and crew"`, keeping WCAG 2.5.3 label-in-name and existing substring test match; tuned `@media (max-width: 429px)` button horizontal padding from 5 px → 4 px so portrait 393 px TopBar keeps full clearance).
    - Portalled `<InventoryPrintSheet>` outside `#root` (only on the `Inventory` tab) with `@media print` rules hiding `body > #root` and printing a crisp black-on-white rental sheet via `window.print()` (popup-free, CSP-safe in Electron & mobile/desktop browsers).
    - Added `Equipment list` `.csv` to `ShowFiles` Exchange formats and registered `.equipment.csv` in `desktop/main.cjs` `exportsBySuffix` (zero new IPC channels, zero new npm dependencies).
    - Added 390 px phone responsive layout (`100dvh` dialog, stacked `data-label` card tables, ≥44×44 px `.gear-touch-control` targets, zero horizontal overflow).
  - **Bundle size & tests (+18 unit tests, 159 → 177; +1 desktop smoke test, 8 → 9; +3 browser tests including 390×844 phone usability, 44 → 47):**
    - Main JS chunk shrank from **1,539.33 kB** → **1,538.37 kB** (lazy chunks: `CostEstimatorModal` 41.91 kB / 10.09 kB gz, `equipmentInventory` 7.74 kB / 3.00 kB gz).
    - Added `tests/equipment-inventory.test.mjs`, `tests/e2e/equipment-inventory.spec.mjs`, desktop smoke test #9 in `tests/desktop/electron-smoke.spec.mjs`; updated `tests/e2e/equipment-catalog.spec.mjs` and `tests/e2e/led-cabinets.spec.mjs` (+1 line each clicking `Cost & crew` tab after intentional default switch to `Inventory`); raised `studio-screens-hangs.spec.mjs:100` bundle-reopen hidden wait to 15 s under dual-tab SwiftShader load.
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**177/177**)
  - `npm run build`: PASS (`index-*.js` 1,538.37 kB / 411.47 kB gz; 0 warnings)
  - `npm run desktop:win`: PASS (portable exe built; zero new dependencies; SPDX check green)
  - `npm run test:desktop`: PASS (**9/9**, 10.7 s)
  - `npx playwright test --workers=1`: PASS (**47/47** — 46/47 on initial full pass + `studio-screens-hangs.spec.mjs` passed cleanly after raising dual-tab SwiftShader reopen wait from 5 s to 15 s)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 M1:* Derived inventory `totals.weightLb`/`weightKg`/`powerW` directly from `estimate` so mixed DMX modes with fractional unit weights maintain exact parity (+LEDBeam 150 mixed-mode regression test).
  - *Pass 1 M2:* Added `emittedStockKeys` tracking in `equipmentInventoryCsv()` so pool `In stock` and `Sub-rent` emit once per `stockKey` and column sum equals `Total` (+multi-mode & generic+catalogue shared-pool CSV regression test).
  - *Pass 1 M3:* Added inline `exportNotice` inside the modal's `role="status"` region so CSV confirmation is visible above the top-layer `<dialog>` (+e2e assertion).
  - *Pass 1 M4 & M5:* Wrapped multi-line `<td>` children in single inner elements for clean 390 px phone flex cards and applied `gear-touch-control` (≥44 px on phones) to custom-stock inputs and Rig Builder shop bar buttons.
  - *Pass 1 M6 & L11:* Passed `stage` into `LedCabinetEditor`, derived LED cabinet soft warning from `computeLedCabinetDemand(rig, stage)`, and kept its `role="status" aria-live="polite"` container permanently mounted (+authored `main-led` regression test).
  - *Pass 1 L8, L9, L10, L13 & Pass 2 L1–L2:* Added retryable lazy loader via `costModalRetry` counter, switched print date to local `YYYY-MM-DD`, extracted blur/Enter-committing `StockQtyInput`, scoped `stock-reason-${group.id}-${entry.id}` IDs per group, and mounted `<InventoryPrintSheet>` only on the `Inventory` tab.
- **QA findings deferred (with reasons):**
  - *Pass 1 L7 (CSV rounded per-row `Total weight (lb)` vs `Total` row on fractional deck areas):* Accepted — `Total` row matches `productionEstimator` exact rounded weight while per-row weights round individually; `Total weight (kg)` keeps 2-decimal precision.
  - *Pass 1 L12 (same unverified `catalogId` used under two hardware types with distinct allowance weights):* Rare edge case; deferred.
- **Design decisions:**
  - Hosted Inventory inside the existing `CostEstimatorModal` as a two-tab **Gear & production** dialog (`Inventory` default | `Cost & crew`) rather than adding a 7th TopBar button so 390 px / 393 px phones stay uncluttered and `aria-label="Gear, cost and crew"` preserves both WCAG 2.5.3 and existing test selectors (per Opus 5.5 consult).
  - Persisted shop stock profiles in `localStorage` (`stageforge.shop.v1`) instead of bumping to Show v7 because shop inventory is an environment constraint rather than show data.
  - Used portalled `@media print` + `window.print()` instead of popup windows or PDF libraries so Electron's `setWindowOpenHandler` deny policy, strict CSP, and zero-dependency budget remain intact.
- **Leftovers / next up:**
  - Next up: **Realism backlog item 4** (Rigging and power realism: real truss sections & sizes, chain-motor ratings, per-point load with over-limit static guidance warning, dimmer/circuit groups, three-phase load balance, and total power report; plus coarse-pointer ≥44 px touch targets in Rig Builder).

### 2026-11-24 08:05 PST — Self-directed Round 5 (Realism backlog 4): rigging load solver, real trusses & hoists, Show v7 & three-phase power report (`4e5121b`)

- **Consults & QA runs:**
  - Opus 5.5 (`claude-opus-5-5`) available and consulted (`round-5-design.md` → `round-5-design-reply.md`) to rank the five highest-value next improvements across phone usability, correctness, performance, accessibility, stage-design realism, open-standards roadmap (Sprint 4), and test gaps, and to design Realism item 4.
    - *Opus 5.5 top-5 ranking:* (1) Realism item 4 rigging & power realism (plus fixing duplicated hoist-point counting between 3D geometry and estimator, and handling box/chevron overhang uplift); (2) Phone load-time budget (lazy-loading `StageDesigner`, interchange & beat workers, plus a bundle-growth gate); (3) Realism item 5 show paperwork (reusing Round 5's rigging & power model unchanged); (4) Accessibility (3D canvas live-region summary + SVG plan keyboard nudge/rotate); (5) Sprint 4 DXF import & block-aware DXF export after Realism item 8, then MVR-xchange.
  - Manufacturer datasheets & rigging codes verified via web search on `2026-11-24` (Prolyte H30V & H40V Eurocode load tables & net-payload self-weight semantics, Eurotruss FD34 TÜV/Eurocode table, Tomcat 12"×12" & 20.5"×20.5" Plated Box engineering charts, CM Lodestar Model F/L/R specs, ChainMaster D8Plus 500/1000 kg datasheets, and IGVW SQP2 / DGUV V17 D8 vs D8+ guidance); unverified fields explicitly flagged in code and `docs/rigging-power.md`.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) QA pass 1 on all Round 5 changes (0 Critical, 1 High, 9 Medium, 10 Low), followed by verification, targeted fixes, and regression tests.
  - Read-only Sonnet 5.5 (`claude-sonnet-5-5`) follow-up QA pass 2 on the Step-4 fixes (0 Critical, 0 High, 1 Medium degenerate-pod guard in `evaluateRigLoads`, 0 Low); fixed with regression test.
- **What shipped:**
  - **Real truss & hoist catalogue + single-source hoist anchors (`src/data/rigCatalog.ts`, `src/data/hoistPoints.ts`, `docs/rigging-power.md`):**
    - Added 5 real touring truss profiles (`prolyte-h30v`, `prolyte-h40v`, `eurotruss-fd34`, `tomcat-12x12`, `tomcat-20-5x20-5`) with verified outer/center-to-center section dimensions, chord/brace tube ODs, `kgPerMeter`, `tableDeductsSelfWeight`, and interpolated UDL/CPL span tables, plus 6 real chain hoists / suspension hardware profiles (`cm-lodestar-05t`, `cm-lodestar-1t`, `cm-lodestar-2t`, `chainmaster-d8plus-500`, `chainmaster-d8plus-1000`, `dead-hang-1t`) and legacy defaults matching exact v1–v6 constants (`30 lb/m`, `124 lb / 1500 W`).
    - Extracted pure `hoistPoints(pod)` (`src/data/hoistPoints.ts`) as the single source of truth shared by `geometryBuilders.ts`, `productionEstimator.ts`, and `rigLoads.ts` (eliminating the `1e-8` vs exact-string path anchor discrepancy).
  - **Static rigging load & continuous-beam solver (`src/data/rigLoads.ts`):**
    - Implemented an exact continuous-beam flexibility solver (`solveContinuousBeam`, Gaussian elimination with partial pivoting) for 2–4 collinear box-truss supports (reducing to exact static moment equilibrium at 2 points and reproducing the exact **5/8 wL** center-point reaction at 3 points), preserving overhang negative reactions as **Uplift** errors without clamping, plus approximate solvers for `chevron`, `path`, and `circle` trusses.
    - Reports explicit `+1.0 kg/fixture` clamp/safety allowance (estimated), `+10%` cable loom allowance, both **hoist hook load** and **roof point load** (+ hoist body & chain drop), separate **Kinetic ×1.2** figure for motorized pods, toggleable 50% D8 over-people guidance derate (leaving D8+/deadhang at 100%), interpolated span bending-moment checks (`M_max / M_allow` with out-of-table overload detection), and a separate **Other Flown Loads** table for flown PA line arrays and LED walls — prominently labelled as simplified static guidance only (not structural engineering sign-off).
  - **Dimmer/circuit groups, three-phase load balance & unified CSV (`src/data/powerReport.ts`, `src/data/productionEstimator.ts`, `desktop/main.cjs`, `src/components/ShowFiles.tsx`):**
    - Added US 120/208 V 3φ Wye, EU 230/400 V 3φ Wye, US 120 V 1φ, and EU 230 V 1φ distribution models with 80% continuous branch-circuit auto-packing (`<label>-NN`), single-unit breaker overload detection, pinned-first + locale-independent LPT three-phase balancing, linear Wye neutral current (`I_N`) with triplen-harmonic 200%-neutral guidance, intermittent chain-hoist separation with feeder & generator (+25%) headroom checks, exact `totalW === calculateProductionEstimate().totalWatts` parity, and formula-safe `.rigging-power.csv` export (with explicit `unit` column and registered in `desktop/main.cjs` `exportsBySuffix`, zero new IPC channels).
  - **Additive Show v7 format & 3D truss sizing (`src/schemas/show-v7.schema.json`, `src/data/showFile.ts`, `src/data/rigImport.ts`, `src/data/trussMounts.ts`, `src/data/fixturePlacement.ts`, `src/engine/geometryBuilders.ts`, `src/engine/StageEngine.ts`, `vite.config.ts`, `docs/show-format.md`):**
    - Added canonical `src/schemas/show-v7.schema.json` (SHA-256 pinned in `tests/show-file.test.mjs`, registered in `SHOW_SCHEMAS` and `electron-smoke.spec.mjs`) with optional `trussProfileId`, `hoistId`, `hoistCount` (2–4 on `box` pods only), `circuitGroup` (1–32 safe ASCII), `phase` (`L1|L2|L3`), and `rig.power` (`system`, `feederA`, `pins[]` ≤ 8 unique targets). Unknown future profile/hoist IDs are preserved for forward compatibility; v1–v6 schemas remain byte-for-byte untouched and shows without v7 fields continue saving as v1–v6.
    - Scaled 3D truss cross-sections, chords, anchors, and fixture clamps for profiled pods while preserving exact legacy literal `-0.28` mount Y (avoiding IEEE-754 `-(0.24 + 0.04)` snapshot drift) and bit-identical legacy geometry/estimates.
  - **UI, print sheet & phone touch controls (`src/components/RiggingPowerPanel.tsx`, `src/components/RiggingPowerPrintSheet.tsx`, `src/components/CostEstimatorModal.tsx`, `src/components/RigBuilderDrawer.tsx`, `src/App.tsx`, `src/index.css`):**
    - Added lazy-loaded 3rd ARIA tab **Rigging & power** inside `CostEstimatorModal` (3-tab roving keyboard nav, custom non-standard feeder option, text+icon status pills on feeder/phases/points/spans/circuits, portalled `@media print` `RiggingPowerPrintSheet`, and `applyRig` autosave wiring).
    - Added per-pod live status pills (text + colour + disclaimer title, debounced `aria-live="polite"` region), truss/hoist `<select>`s, box hoist-count stepper, and per-group circuit/phase editors in `RigBuilderDrawer`, with `@media (pointer: coarse)` and `@media (max-width: 600px)` ≥44 px touch targets.
  - **Tests (+9 unit tests, 177 → 186; +2 browser tests including 390×844 phone usability, 47 → 49; extended desktop smoke test #9 for v7 schema & `.rigging-power.csv`):**
    - Added `tests/rigging-power.test.mjs`, `tests/e2e/rigging-power.spec.mjs`, and Show v7 coverage in `tests/show-file.test.mjs`; updated `tests/e2e/equipment-inventory.spec.mjs` for 3-tab ArrowRight order (`Inventory` → `Rigging & power` → `Cost & crew`).
- **Gate results (final code):**
  - `npx tsc --noEmit -p .`: PASS
  - `npm test`: PASS (**186/186**)
  - `npm run build`: PASS (`dist/schemas/show-v1..v7.schema.json` emitted; `powerReport` 11.09 kB / 4.41 kB gz and `CostEstimatorModal` 77.92 kB / 16.16 kB gz lazy-loaded; main chunk 1,588.40 kB / 422.70 kB gz; 0 warnings)
  - `npm run desktop:win`: PASS (portable exe built; zero new dependencies; SPDX gate green)
  - `npm run test:desktop`: PASS (**9/9**, 10.8 s)
  - `npx playwright test --workers=1`: PASS (**49/49**, 7.1 m)
  - `git status --short`: clean
- **QA findings verified and fixed:**
  - *Pass 1 H1:* Verified Prolyte/Tomcat/Eurotruss tables report net allowable payload (self-weight already deducted), renamed `tableIncludesSelfWeight` → `tableDeductsSelfWeight`, and added a net-vs-gross moment regression test.
  - *Pass 1 M1:* Routed `CostEstimatorModal` `onChangeRig` through `applyRig(next)` in `src/App.tsx` so electrical changes autosave across reloads (+Playwright reload regression test).
  - *Pass 1 M2:* Split verified `cantileverWarnings` from informational unverified ¼-span `cantileverNotes` so stock 3- and 4-point box templates do not false-alarm Caution (+all-templates regression test).
  - *Pass 1 M3:* Included intermittent hoist kVA in `recommendedGeneratorKva`, `recommendedFeederA`, and `feederStatus` (+overload & generator headroom regression test).
  - *Pass 1 M4 & M5:* Added custom `<option>` for non-standard `feederA` values and added text-based status labels (`feederStatus` + phase `StatusPill`) in `RiggingPowerPanel.tsx` (+unit & Playwright assertions).
  - *Pass 1 M6:* Reused `circuitStatusFor` on CSV `phase` rows (matching UI/summary `CAUTION` at 80–100%) and added an explicit `unit` column (+regression test).
  - *Pass 1 M8 & Pass 2 M1:* Added strict ascending/finite checks on `solveContinuousBeam` AND caught degenerate pod widths in `evaluateRigLoads` (returning `status: 'unknown'` + warning instead of crashing React) (+regression tests).
  - *Pass 1 M9 & Lows:* Computed `totalW = continuousW + motorWatts` directly, exposed numeric `CostLineItem.unitCount` on motor items, switched LPT sorting to locale-independent `cmpAscii`, clarified kinetic `%` in `summaryText`, added inline invalid-label feedback in `CircuitPhaseRow`, pruned `hoistCount` on shape change, and tightened mobile tab padding at 390 px.
- **QA findings rejected or deferred (with reasons):**
  - *Pass 1 M7 (estimator path anchor `1e-8` dedupe vs exact string):* Intentional bug fix per Opus 5.5 consult — `rigImport.ts` already bans segments `< 0.25 m`, so only coincident/nearly-closed loop vertices merge, bringing `productionEstimator` into exact agreement with 3D `buildTrussPath` (+closed-loop test added).
  - *Pass 1 Lows (`hoists` pin target unused on 3φ true-3-phase loads, D8 toggle local to modal, legacy 2600 W blinder overloading 120V/20A):* Deferred as expected/minor; 3-phase hoists are inherently balanced across L1/L2/L3, and legacy 2600 W Molefay blinders genuinely exceed a single US 20 A / 120 V circuit.
- **Design decisions:**
  - Chose additive Show v7 (`show-v7.schema.json`) so truss profiles, hoist ratings, box hoist counts, circuit labels, phase pins, and electrical systems travel cleanly in saved `.stageforge.show.json` files while v1–v6 files stay untouched (per Opus 5.5 consult).
  - Hosted **Rigging & power** as a 3rd lazy-loaded ARIA tab inside `CostEstimatorModal` rather than adding another TopBar button, keeping 390 px phones uncluttered and keeping `powerReport` + print sheet out of the main bundle.
  - Preserved literal `-0.28` in `trussMounts()` for unprofiled legacy pods to avoid IEEE-754 `-(0.24 + 0.04)` snapshot drift.
- **Leftovers / next up:**
  - Next up: **Realism backlog item 5** (Show paperwork: patch sheet, instrument schedule, channel hookup, power & load reports, and cue sheet as printable pages and CSV, consistent with MVR and DXF — reusing Round 5's `rigLoads` and `powerReport` unchanged).

### 2026-11-24 morning: optimization sprint (Claude Code, Opus 5.5)

The overnight runner was stopped after Round 5. Claude Code took over for one sprint.

- **Deploy fix (`23b9917`):** the schema hash pins failed on GitHub's Linux checkout, which would have blocked the Pages deploy. They now hash LF-normalised text, and `.gitattributes` keeps schemas and fixtures LF. Verified with an LF export: 186/186 unit tests pass.
- **Render stats measure whole frames:** `renderer.info` now accumulates per frame (scene plus bloom and output passes). The old probe reported only the last pass (always 1 call), so the existing 350-call budget in `equipment-catalog.spec.mjs` never checked anything. The arena rig actually drew 667 calls per frame on Arena Rock.
- **Proxy instancing (`src/engine/renderBatcher.ts`):** repeated opaque parts are drawn as one InstancedMesh per part type.
  - Covers yokes, housings, bezels, clamps, bases, hoists, subwoofers, wedges and line-array boxes, plus per-unit lamp lenses, strobe, blinder and laser apertures via `instanceColor`.
  - Originals stay in the scene graph on a hidden layer, so animation, GLB export and FOH framing are unchanged.
  - Geometry is matched by content, so separately built identical shapes still share a batch.
  - Result on Arena Rock: **667 → 173 draw calls (−74%)**, 560 parts in 60 batches, and 160 instead of 404 GPU geometries.
  - Phone-like run (4x CPU throttle, 390x844): **~89 → ~146 fps**, median frame 10.4 → 6.4 ms, p95 17.6 → 10.5 ms, worst 35 → 16 ms.
- **Smaller first download:** Show Files, Cue Editor, Stage Designer, Rig Builder, DMX Monitor and Show Control load right after first paint through `src/components/deferred.tsx`, inside their ErrorBoundaries. It is not `React.lazy`: Suspense reveals loaded content on a timer that never fires while time is frozen (Playwright's clock), which broke `cue-stack.spec.mjs`.
  - three.js core and React are long-lived vendor chunks that stay cached across deploys.
  - Initial JS: 1,588 → 1,437 kB minified, 423 → 384 kB gzip.
- **Tests:** `tests/render-batcher.test.mjs` (7 unit tests) and `tests/e2e/render-budget.spec.mjs` (batching cuts calls below 40% of unbatched and at most 250, triangles unchanged, no leaks across rebuilds).
- **Checked by eye:** the arena on Arena Rock looks the same with batching on and off.
- **Sonnet 5.5 review:** no Critical or High findings. Fixed:
  - per-batch culling spheres;
  - batching failures fall back to unbatched drawing;
  - complete lamp settings, snapshotted and checked for every unit;
  - runtime mirroring and draw-order changes release a part;
  - only shareable geometry is hashed;
  - Show Files and Cue Editor ErrorBoundaries and a load retry;
  - a stable e2e budget test with a GLB export parity check.
  Not done (latent; no current code uses them): mirroring `castShadow` and raycast `instanceId` onto batches.
- **Leftovers:** the 44 moving-head beam cones (custom `ShaderMaterial`, transparent) are still one draw call each because their uniforms differ per unit; instancing them needs per-instance shader attributes. Static gear still updates its matrices every frame (`matrixAutoUpdate`), which is a smaller CPU cost.
