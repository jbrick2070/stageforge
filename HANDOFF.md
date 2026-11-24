# StageForge handoff: next improvement passes

You are the implementing agent for StageForge. Work sprint by sprint from the backlog below. Every sprint runs this loop:

1. **Implement** one sprint, with tests.
2. **Pass the gate** (below).
3. **QA** with Claude CLI on Sonnet 5.5, in read-only mode (below).
4. **Verify and fix:** for each QA finding, check it against the code first. Fix the real ones, add a regression test for each, and write down why you rejected any false positive.
5. **Re-run the gate.** If you changed more than about 50 lines in step 4, run one more QA pass on just those fixes.
6. **Commit locally** with a descriptive message, then **report**. Include gate results, QA findings (fixed or rejected) and what's next. In an overnight run, append the report to the Overnight log at the bottom of this file and carry on with the next sprint.

**Never push.** A push to `main` deploys GitHub Pages; only the user approves that, every time.

## Overnight run (unattended)

The user is asleep. `scripts/overnight.ps1` runs you once per sprint, each in a fresh session, on a local branch `overnight/<date>`. Nobody can answer questions, so:

- **Decide and log.** Make reasonable calls yourself and record each decision, with its reason, in the Overnight log.
- **Consult Opus on design.** Before implementing a sprint with real design choices (the v4 `interchange` block, the DMX sender and IPC architecture, clock ownership), and whenever you're stuck on architecture, ask Claude Opus 5.5 using the design consult command below. Opus advises; you decide.
- **Never commit failing code.** If the gate still fails after three fix rounds, leave the work uncommitted, log what's failing, and end the session. The runner stashes unfinished work as `overnight sprint N unfinished` and starts the next sprint clean.
- **Stay in scope.**
  - Work only inside this repo.
  - Don't install global tools, and don't connect to other machines.
  - Never push, force or rewrite history, and don't switch branches.
  - Network use is limited to `npm install` of permissive, pinned packages and the Claude CLI.
- **Loopback only.** DMX, OSC and MIDI tests send only to `127.0.0.1`. Never send to a real network interface: this PC has a direct Ethernet link to another machine.
- **Hardware steps:** anything needing hardware or a person (a cross-tool check, a real DMX node, a USB interface) becomes a checklist in the docs, not a blocker.
- **Leave the PC tidy:** after each gate, stop any Vite, preview or Electron processes you started.
- **Stop time:** don't start new work after 07:00. The runner also stops launching sprints then.

## Where things stand (2026-11-23)

- **Repo:** this folder. GitHub `jbrick2070/stageforge`, branch `main`, last pushed commit `78ec7af`, live on Pages.
- **Stack:**
  - Vite + React 19 + TypeScript + three.js, with an SVG stage plan.
  - Electron desktop app: sandboxed renderer, `stageforge://` protocol, strict CSP, preload `contextBridge` with a command whitelist in `desktop/preload.cjs`.
- **Show format:** versioned JSON v1–v3. Schemas are in `public/schemas/`; see `docs/show-format.md`.
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
  - Update `docs/show-format.md` and add `public/schemas/show-v4.schema.json`.
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

## Kickoff

**Overnight**, unattended (Sprints 0–3, stopping at 07:00), from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\overnight.ps1
```

**One sprint**, interactively:

```powershell
agy -i "Read HANDOFF.md and run Sprint 0, following its loop. Stop after the local commit and report." --mode accept-edits
```

## Overnight log

(Each sprint appends: date and time, sprint, what shipped, gate results, QA findings fixed or rejected, design decisions and their reasons, leftovers.)
